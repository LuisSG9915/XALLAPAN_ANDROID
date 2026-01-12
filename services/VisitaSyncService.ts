import { SyncTask, SyncTaskResult } from "./sync/SyncTask";
import { ALL_SCHEMAS } from "./RealmSchemas";
import Realm from "realm";

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

  private async getRealm(): Promise<Realm> {
    if (!this.realm || this.realm.isClosed) {
      this.realm = await Realm.open({
        path: "FullSyncDB",
        schema: ALL_SCHEMAS,
        schemaVersion: 15, // v15: Agregados campos detallados a BitacoraSync
        onMigration: (oldRealm: Realm, newRealm: Realm) => {
          // Migración para Usuario - inicializar campo metros
          const newUsuarios = newRealm.objects("Usuario");
          for (let i = 0; i < newUsuarios.length; i++) {
            const obj: any = newUsuarios[i];
            if (typeof obj.metros === "undefined" || obj.metros === null) {
              obj.metros = 31;
            }
          }
          // Migración de Visitas: eliminar esquema antiguo
          if (oldRealm.schemaVersion < 12) {
            const oldVisitas = oldRealm.objects("Visita");
            oldRealm.delete(oldVisitas);
          }
        },
      });
    }
    return this.realm;
  }

  async syncByDate(fecha: Date, sucursal: number): Promise<SyncTaskResult> {
    try {
      console.log(`[VisitaSync] Sincronizando visitas para fecha: ${fecha.toISOString().split('T')[0]}, Sucursal: ${sucursal}`);

      const fechaStr = fecha.toISOString().split('T')[0];
      const url = `https://cbinfo.no-ip.info:9031/api/MovilesVentas/visitas/full?fecha=${fechaStr}&sucursal=${sucursal}`;
      
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status} url: ${url}`);
      }
      const visitasData = await response.json();
      
      if (!Array.isArray(visitasData)) {
        throw new Error("La respuesta no es un array de visitas");
      }

      console.log(`[VisitaSync] Recibidos ${visitasData.length} registros`);

      const realm = await this.getRealm();
      let nuevos = 0;

      realm.write(() => {
        // Limpiar visitas de la fecha específica Y de la ruta/sucursal específica
        // Para evitar borrar visitas de otras rutas si se sincronizaran
        const startOfDay = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
        const endOfDay = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate() + 1);
        
        const existingVisitas = realm.objects("Visita").filtered(`fecha >= $0 AND fecha < $1 AND ruta == $2`, 
          startOfDay,
          endOfDay,
          String(sucursal)
        );
        console.log(`[VisitaSync] Eliminando ${existingVisitas.length} visitas existentes para la fecha y ruta`);
        realm.delete(existingVisitas);

        // Insertar visitas de la fecha (update: true para evitar duplicados)
        visitasData.forEach((visita: any) => {
          realm.create("Visita", {
            id: visita.id,
            idCliente: visita.idCliente,
            ruta: String(visita.ruta),
            fecha: new Date(visita.fecha),
            orden: Number(visita.orden),
            tipo: Number(visita.tipo),
            visitado: typeof visita.visitado === 'boolean' ? (visita.visitado ? 1 : 0) : Number(visita.visitado),
            syncedAr: null, // Reset sync status or set based on logic
          }, true); // true = update mode
          nuevos++;
        });
      });

      console.log(`[VisitaSync] ✅ Sincronización completa: ${nuevos} visitas para ${fechaStr}`);
      return {
        success: true,
        registrosLeidos: visitasData.length,
        registrosGuardados: nuevos,
        registrosActualizados: 0,
      };
    } catch (error) {
      console.error("[VisitaSync] ❌ Error en sincronización:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async marcarVisitado(idVisita: number, tipoVisita?: number): Promise<boolean> {
    try {
      const realm = await this.getRealm();

      realm.write(() => {
        const visita: any = realm.objectForPrimaryKey("Visita", idVisita);
        if (visita && visita.visitado === 0) {
          visita.visitado = 1;
          if (tipoVisita !== undefined) {
            visita.tipo = tipoVisita;
          }
          console.log(`[VisitaSync] ✅ Visita ${idVisita} marcada como visitada con tipo ${tipoVisita}`);
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
      const realm = await this.getRealm();
      
      const startOfDay = new Date(fecha);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(fecha);
      endOfDay.setHours(23, 59, 59, 999);

      let visitas = realm.objects("Visita")
        .filtered(`fecha >= $0 AND fecha <= $1 AND ruta == $2`, startOfDay, endOfDay, sucursal.toString())
        .sorted("orden");

      return visitas.map((v: any) => ({
        id: v.id,
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
