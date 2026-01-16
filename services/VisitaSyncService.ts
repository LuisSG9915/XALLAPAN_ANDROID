import { SyncTask, SyncTaskResult } from "./sync/SyncTask";
import { ALL_SCHEMAS } from "./RealmSchemas";
import Realm from "realm";
import BitacoraService from "./BitacoraService";
import AuthService from "./AuthService";

class VisitaSyncService {
  private static instance: VisitaSyncService;
  private realm: Realm | null = null;

  private constructor() {}

  static getInstance(): VisitaSyncService {
    if (!VisitaSyncService.instance) {
      VisitaSyncService.instance = new VisitaSyncService();
    }
    return VisitaSyncService.instance;
  }

  /**
   * Inyecta la instancia de Realm desde FullSyncService
   * Evita abrir múltiples instancias del mismo Realm
   */
  setRealm(realm: Realm): void {
    this.realm = realm;
    console.log("[VisitaSyncService] Realm inyectado correctamente");
  }

  private getRealm(): Realm {
    if (!this.realm || this.realm.isClosed) {
      throw new Error("[VisitaSyncService] Realm no inicializado. Debe llamarse FullSyncService.initialize() primero");
    }
    return this.realm;
  }

  async syncByDate(fecha: Date): Promise<SyncTaskResult> {
    // Obtener datos del usuario para bitácora
    const user = await AuthService.restoreSession();
    const idUsuario = user?.id || user?.idUsuario || 0;
    const sucursal = user?.sucursal || user?.sucursal_origen || 1;
    
    const fechaStr = fecha.toISOString().split('T')[0];
    const endpoint = "https://cbinfo.no-ip.info:9031/api/MovilesVentas/visitas/full";
    
    // Registrar inicio de sincronización de visitas
    const idBitacoraVisitas = await BitacoraService.registrarInicioSync(
      "VisitasByDate",
      "full",
      "manual",
      idUsuario,
      sucursal,
      endpoint
    );
    
    try {
      console.log(`[VisitaSync] Sincronizando visitas para fecha: ${fecha.toISOString()}`);

      const response = await fetch(endpoint);      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const visitasData = await response.json();
      console.log(visitasData);
      if (!Array.isArray(visitasData)) {
        throw new Error("La respuesta no es un array de visitas");
      }

      const realm = this.getRealm();
      let nuevos = 0;

      realm.write(() => {
        // Limpiar visitas de la fecha específica
        const startOfDay = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
        const endOfDay = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate() + 1);
        
        const existingVisitas = realm.objects("Visita").filtered(`fecha >= $0 AND fecha < $1`, 
          startOfDay,
          endOfDay
        );
        console.log(`[VisitaSync] Eliminando ${existingVisitas.length} visitas existentes de la fecha`);
        realm.delete(existingVisitas);
        console.log({visitasData})
        // Insertar visitas de la fecha con ID compuesto
        visitasData.forEach((visita: any) => {
          const fechaVisita = new Date(visita.fecha);
          const fechaStr = fechaVisita.toISOString().split('T')[0]; // YYYY-MM-DD
          const idCompuesto = `${visita.id}-${fechaStr}`; // ID único por fecha
          
          // Usar UpdateMode.Modified para actualizar si ya existe
          realm.create("Visita", {
            id: idCompuesto, // ID compuesto: "84100-2025-12-01"
            idOriginal: visita.id, // ID original del servidor
            idCliente: visita.idCliente,
            ruta: String(visita.ruta),
            fecha: fechaVisita,
            orden: Number(visita.orden),
            tipo: Number(visita.tipo),
            visitado: typeof visita.visitado === 'boolean' ? (visita.visitado ? 1 : 0) : Number(visita.visitado),
            syncedAt: new Date(),
          }, Realm.UpdateMode.Modified);
          nuevos++;
        });
      });

      console.log(`[VisitaSync] ✅ Sincronización completa: ${nuevos} visitas para ${fechaStr}`);
      
      // Registrar fin exitoso
      await BitacoraService.registrarFinSync(idBitacoraVisitas, {
        exitoso: true,
        registrosLeidos: visitasData.length,
        registrosGuardados: nuevos,
        registrosActualizados: 0
      });
      
      return {
        success: true,
        registrosLeidos: visitasData.length,
        registrosGuardados: nuevos,
        registrosActualizados: 0,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error("[VisitaSync] ❌ Error en sincronización:", error);
      
      // Registrar error en bitácora
      await BitacoraService.registrarFinSync(idBitacoraVisitas, {
        exitoso: false,
        error: errorMsg,
        errorCode: "500",
        stackTrace: error instanceof Error ? error.stack : undefined
      });
      
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  async marcarVisitado(idVisita: number, tipoVisita?: number, fecha?: Date): Promise<boolean> {
    try {
      const realm = this.getRealm();

      // LOG: Ver todas las visitas con este idOriginal antes de marcar
      const todasConEsteId = realm.objects("Visita").filtered("idOriginal == $0", idVisita);
      console.log(`[VisitaSync] 🔍 Visitas encontradas con idOriginal ${idVisita}:`, 
        Array.from(todasConEsteId).map((v: any) => ({
          id: v.id,
          idOriginal: v.idOriginal,
          idCliente: v.idCliente,
          fecha: v.fecha,
          visitado: v.visitado,
          ruta: v.ruta
        }))
      );

      realm.write(() => {
        let visita: any;
        
        if (fecha) {
          // Generar ID compuesto para buscar la visita exacta
          const fechaStr = fecha.toISOString().split('T')[0]; // YYYY-MM-DD
          const idCompuesto = `${idVisita}-${fechaStr}`;
          
          console.log(`[VisitaSync] 🔍 Buscando visita con ID compuesto: ${idCompuesto}`);
          
          visita = realm.objectForPrimaryKey("Visita", idCompuesto);
          
          if (!visita) {
            console.warn(`[VisitaSync] ⚠️ No se encontró visita con id compuesto ${idCompuesto}`);
            return;
          }
          
          console.log(`[VisitaSync] 🔍 Visita encontrada:`, {
            id: visita.id,
            idOriginal: visita.idOriginal,
            idCliente: visita.idCliente,
            fecha: visita.fecha,
            visitado: visita.visitado
          });
        } else {
          // Fallback: buscar por idOriginal (puede marcar cualquier fecha)
          console.log(`[VisitaSync] ⚠️ MARCANDO SIN FECHA - Buscando por idOriginal`);
          const visitasConId = realm.objects("Visita").filtered("idOriginal == $0", idVisita);
          visita = visitasConId.length > 0 ? visitasConId[0] : null;
          
          if (visita) {
            console.log(`[VisitaSync] 🔍 Visita encontrada sin filtro de fecha:`, {
              id: visita.id,
              idOriginal: visita.idOriginal,
              idCliente: visita.idCliente,
              fecha: visita.fecha,
              visitado: visita.visitado
            });
          }
        }
        
        if (visita && visita.visitado === 0) {
          visita.visitado = 1;
          if (tipoVisita !== undefined) {
            visita.tipo = tipoVisita;
          }
          console.log(`[VisitaSync] ✅ Visita ${visita.id} marcada como visitada con tipo ${tipoVisita}`);
        } else if (visita && visita.visitado === 1) {
          console.log(`[VisitaSync] ℹ️ Visita ${visita.id} ya estaba marcada como visitada`);
        }
      });

      return true;
    } catch (error) {
      console.error("[VisitaSync] ❌ Error al marcar visita:", error);
      return false;
    }
  }

  async getVisitasByFecha(fecha: Date, sucursal: number): Promise<any[]> {
    try {
      const realm = this.getRealm();
      
      const startOfDay = new Date(fecha);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(fecha);
      endOfDay.setHours(23, 59, 59, 999);

      let visitas = realm.objects("Visita")
        .filtered(`fecha >= $0 AND fecha <= $1 AND ruta == $2`, startOfDay, endOfDay, sucursal.toString())
        .sorted("orden");

      return visitas.map((v: any) => ({
        id: v.idOriginal, // Retornar idOriginal como "id" para compatibilidad con UI
        idCompuesto: v.id, // ID compuesto real de Realm
        idOriginal: v.idOriginal,
        idCliente: v.idCliente,
        ruta: v.ruta,
        fecha: v.fecha,
        orden: v.orden,
        tipo: v.tipo,
        visitado: v.visitado,
      }));
    } catch (error) {
      console.error("[VisitaSync] ❌ Error al obtener visitas:", error);
      return [];
    }
  }

  async getEstadisticasCumplimiento(fecha: Date, sucursal: number): Promise<{
    totalProgramadas: number;
    totalRealizadas: number;
    porcentaje: number;
  }> {
    try {
      const visitas = await this.getVisitasByFecha(fecha, sucursal);
      const totalProgramadas = visitas.length;
      const totalRealizadas = visitas.filter((v) => v.visitado === 1).length;
      const porcentaje = totalProgramadas > 0 ? (totalRealizadas / totalProgramadas) * 100 : 0;

      return {
        totalProgramadas,
        totalRealizadas,
        porcentaje,
      };
    } catch (error) {
      console.error("[VisitaSync] ❌ Error al obtener estadísticas:", error);
      return {
        totalProgramadas: 0,
        totalRealizadas: 0,
        porcentaje: 0,
      };
    }
  }
}

export default VisitaSyncService;
