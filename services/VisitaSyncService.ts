import { SyncTask, SyncTaskResult } from "./sync/SyncTask";
import { allSchemas } from "./RealmSchemas";
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

    const fechaStr = fecha.toISOString().split("T")[0];
    const endpoint = "https://cbinfo.no-ip.info:9031/api/MovilesVentas/visitas/full";

    // Registrar inicio de sincronización de visitas
    const idBitacoraVisitas = await BitacoraService.registrarInicioSync(
      "VisitasByDate",
      "full",
      "manual",
      idUsuario,
      sucursal,
      endpoint,
    );

    try {
      console.log(`[VisitaSync] Sincronizando visitas para fecha: ${fecha.toISOString()}`);

      const response = await fetch(endpoint);
      if (!response.ok) {
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

        const existingVisitas = realm.objects("Visita").filtered(`fecha >= $0 AND fecha < $1`, startOfDay, endOfDay);

        // CRÍTICO: Preservar el estado 'visitado' de las visitas locales antes de borrarlas
        const estadoVisitadoLocal: { [key: string]: number } = {};
        existingVisitas.forEach((v: any) => {
          if (v.visitado === 1) {
            // Guardar por idOriginal para preservar el estado
            estadoVisitadoLocal[v.idOriginal] = 1;
            console.log(`[VisitaSync] 💾 Preservando visitado=1 para visita ${v.idOriginal}`);
          }
        });

        console.log(`[VisitaSync] Eliminando ${existingVisitas.length} visitas existentes de la fecha`);
        realm.delete(existingVisitas);
        console.log({ visitasData });
        // Insertar visitas de la fecha con ID compuesto
        visitasData.forEach((visita: any) => {
          const fechaVisita = new Date(visita.fecha);
          const fechaStr = fechaVisita.toISOString().split("T")[0]; // YYYY-MM-DD
          const idCompuesto = `${visita.id}-${fechaStr}`; // ID único por fecha

          // Preservar el estado local de 'visitado' si existía
          const visitadoFinal =
            estadoVisitadoLocal[visita.id] === 1
              ? 1
              : typeof visita.visitado === "boolean"
              ? visita.visitado
                ? 1
                : 0
              : Number(visita.visitado);

          if (estadoVisitadoLocal[visita.id] === 1) {
            console.log(`[VisitaSync] ✅ Restaurando visitado=1 para visita ${visita.id}`);
          }

          // Usar UpdateMode.Modified para actualizar si ya existe
          realm.create(
            "Visita",
            {
              id: idCompuesto, // ID compuesto: "84100-2025-12-01"
              idOriginal: visita.id, // ID original del servidor
              idCliente: visita.idCliente,
              ruta: String(visita.ruta),
              fecha: fechaVisita,
              orden: Number(visita.orden),
              tipo: Number(visita.tipo),
              visitado: visitadoFinal,
              syncedAt: new Date(),
            },
            Realm.UpdateMode.Modified,
          );
          nuevos++;
        });
      });

      console.log(`[VisitaSync] ✅ Sincronización completa: ${nuevos} visitas para ${fechaStr}`);

      // Registrar fin exitoso
      await BitacoraService.registrarFinSync(idBitacoraVisitas, {
        exitoso: true,
        registrosLeidos: visitasData.length,
        registrosGuardados: nuevos,
        registrosActualizados: 0,
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
        stackTrace: error instanceof Error ? error.stack : undefined,
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
      console.log(
        `[VisitaSync] 🔍 Visitas encontradas con idOriginal ${idVisita}:`,
        Array.from(todasConEsteId).map((v: any) => ({
          id: v.id,
          idOriginal: v.idOriginal,
          idCliente: v.idCliente,
          fecha: v.fecha,
          visitado: v.visitado,
          ruta: v.ruta,
        })),
      );

      realm.write(() => {
        let visita: any;

        if (fecha) {
          // Generar ID compuesto para buscar la visita exacta
          const fechaStr = fecha.toISOString().split("T")[0]; // YYYY-MM-DD
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
            visitado: visita.visitado,
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
              visitado: visita.visitado,
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

      let visitas = realm
        .objects("Visita")
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
  async getVisitas(): Promise<any[]> {
    try {
      const realm = this.getRealm();
      let visitas = realm.objects("Visita").sorted("fecha", true).slice(0, 10);
      return visitas.map((v: any) => ({
        id: v.idOriginal, // Retornar idOriginal como "id" para compatibilidad con UI
        idCompuesto: v.id, // ID compuesto real de Realm
        idOriginal: v.idOriginal,
        idCliente: v.idCliente,
        ruta: v.ruta,
        fecha: v.fecha.toISOString(), // Convertir Date a string ISO
        orden: v.orden,
        tipo: v.tipo,
        visitado: v.visitado,
      }));
    } catch (error) {
      console.error("[VisitaSync] ❌ Error al obtener visitas:", error);
      return [];
    }
  }

  async getVisitasVisitadas(sucursal: number): Promise<any[]> {
    try {
      const realm = this.getRealm();
      // Obtener todas las visitas visitadas de la sucursal sin filtro de fecha
      let visitas = realm.objects("Visita").filtered("visitado == 1 AND ruta == $0", sucursal.toString());

      return visitas.map((v: any) => ({
        id: v.idOriginal,
        idCompuesto: v.id,
        idOriginal: v.idOriginal,
        idCliente: v.idCliente,
        ruta: v.ruta,
        fecha: v.fecha,
        orden: v.orden,
        tipo: v.tipo,
        visitado: v.visitado,
      }));
    } catch (error) {
      console.error("[VisitaSync] ❌ Error al obtener visitas visitadas:", error);
      return [];
    }
  }

  async getEstadisticasCumplimiento(
    fecha: Date,
    sucursal: number,
  ): Promise<{
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

  async syncVisitasRealizadas(sucursal: number): Promise<SyncTaskResult> {
    const user = await AuthService.restoreSession();
    const idUsuario = user?.id || user?.idUsuario || 0;

    const endpoint = `https://cbinfo.no-ip.info:9031/api/MovilesVentas/visitas/full/${sucursal}`;

    const idBitacora = await BitacoraService.registrarInicioSync(
      "VisitasRealizadas",
      "full",
      "manual",
      idUsuario,
      sucursal,
      endpoint,
    );

    try {
      console.log(`[VisitaSync] 🔄 Sincronizando visitas realizadas para ruta: ${sucursal}`);

      const response = await fetch(endpoint, {
        method: "GET",
        headers: {
          accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const visitasData = await response.json();
      console.log(`[VisitaSync] ✅ Recibidas ${visitasData.length} visitas realizadas del servidor`);

      const realm = this.getRealm();

      realm.write(() => {
        const existentes = realm.objects("VisitaRealizada").filtered("idRuta == $0", sucursal);
        realm.delete(existentes);
        console.log(`[VisitaSync] 🗑️ Eliminadas ${existentes.length} visitas realizadas anteriores`);

        visitasData.forEach((visita: any) => {
          realm.create(
            "VisitaRealizada",
            {
              id: visita.id,
              fechaInicio: new Date(visita.fechaInicio),
              fechaFin: new Date(visita.fechaFin),
              idCliente: visita.idCliente,
              idUsuario: visita.idUsuario,
              idRuta: visita.idRuta,
              syncedAt: new Date(),
            },
            Realm.UpdateMode.Modified,
          );
        });
      });

      await BitacoraService.registrarFinSync(idBitacora, {
        exitoso: true,
        registrosLeidos: visitasData.length,
        registrosGuardados: visitasData.length,
        registrosActualizados: 0,
      });

      return {
        success: true,
        registrosLeidos: visitasData.length,
        registrosGuardados: visitasData.length,
        registrosActualizados: 0,
      };
    } catch (error: any) {
      console.error("[VisitaSync] ❌ Error al sincronizar visitas realizadas:", error);
      await BitacoraService.registrarFinSync(idBitacora, {
        exitoso: false,
        error: error.message,
        errorCode: "500",
      });

      return {
        success: false,
        registrosLeidos: 0,
        registrosGuardados: 0,
        registrosActualizados: 0,
      };
    }
  }

  async getVisitasRealizadasHoy(sucursal: number): Promise<any[]> {
    try {
      const realm = this.getRealm();
      const hoy = new Date();
      const startOfDay = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
      const endOfDay = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + 1);

      const visitas = realm
        .objects("VisitaRealizada")
        .filtered("idRuta == $0 AND fechaInicio >= $1 AND fechaInicio < $2", sucursal, startOfDay, endOfDay);

      return visitas.map((v: any) => ({
        id: v.id,
        fechaInicio: v.fechaInicio,
        fechaFin: v.fechaFin,
        idCliente: v.idCliente,
        idUsuario: v.idUsuario,
        idRuta: v.idRuta,
      }));
    } catch (error) {
      console.error("[VisitaSync] ❌ Error al obtener visitas realizadas de hoy:", error);
      return [];
    }
  }

  async getClientesVisitadosHoy(sucursal: number): Promise<Set<number>> {
    try {
      const realm = this.getRealm();
      const clientesVisitados = new Set<number>();

      // Obtener rango del día actual
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

      // 1. Consultar tabla Visita (local, antes de sincronizar) con visitado == 1
      const visitasLocales = realm
        .objects("Visita")
        .filtered(
          "visitado == 1 AND ruta == $0 AND fecha >= $1 AND fecha <= $2",
          sucursal.toString(),
          startOfDay,
          endOfDay,
        );

      visitasLocales.forEach((v: any) => {
        clientesVisitados.add(v.idCliente);
      });

      console.log(`[VisitaSync] 📍 Visitas locales (Visita) hoy: ${visitasLocales.length}`);

      // 2. Consultar tabla VisitaRealizada (sincronizada al servidor)
      const visitasRealizadas = realm
        .objects("VisitaRealizada")
        .filtered("fechaInicio >= $0 AND fechaInicio <= $1", startOfDay, endOfDay);

      visitasRealizadas.forEach((v: any) => {
        clientesVisitados.add(v.idCliente);
      });

      console.log(`[VisitaSync] 📍 Visitas realizadas (VisitaRealizada) hoy: ${visitasRealizadas.length}`);

      // 3. Consultar tabla DetalleVisitas (ventas/visitas registradas hoy)
      const detalleVisitas = realm
        .objects("DetalleVisitas")
        .filtered("idRuta == $0 AND fechaInicio >= $1 AND fechaInicio <= $2", sucursal, startOfDay, endOfDay);

      detalleVisitas.forEach((v: any) => {
        clientesVisitados.add(v.idCliente);
      });

      console.log(`[VisitaSync] 📍 Detalle visitas (DetalleVisitas) hoy: ${detalleVisitas.length}`);
      console.log(`[VisitaSync] 📍 Total clientes visitados hoy (combinado): ${clientesVisitados.size}`);

      return clientesVisitados;
    } catch (error) {
      console.error("[VisitaSync] ❌ Error al obtener clientes visitados hoy:", error);
      return new Set();
    }
  }
}

export default VisitaSyncService;
