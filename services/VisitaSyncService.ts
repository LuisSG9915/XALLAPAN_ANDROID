import { SyncTask, SyncTaskResult } from "./sync/SyncTask";
import { allSchemas } from "./RealmSchemas";
import Realm from "realm";
import BitacoraService from "./BitacoraService";
import AuthService from "./AuthService";
import { fetchWithTimeout } from "./fetchWithTimeout";

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
    // Endpoint: GET /api/MovilesVentas/visitas/full
    const endpoint = "https://api.cbinformatica.net:9031/api/MovilesVentas/visitas/full";

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

      const response = await fetchWithTimeout(endpoint);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const visitasData = await response.json();
      console.log(visitasData);
      //console de un dato del arreglo
      console.log(visitasData[0]);
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

      // Calcular rango: ayer, hoy y mañana
      const hoy = new Date();
      const ayer = new Date(hoy);
      ayer.setDate(hoy.getDate() - 1);
      ayer.setHours(0, 0, 0, 0);

      const mañana = new Date(hoy);
      mañana.setDate(hoy.getDate() + 1);
      mañana.setHours(23, 59, 59, 999);

      let visitas = realm.objects("Visita").filtered(`fecha >= $0 AND fecha <= $1`, ayer, mañana).sorted("fecha");

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
      const visitasSinPedidos = visitas.filter((v) => v.tipo !== 99);
      const totalProgramadas = visitasSinPedidos.length;
      const totalRealizadas = visitasSinPedidos.filter((v) => v.visitado === 1).length;
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

    // Endpoint: GET /api/MovilesVentas/visitas/full/{sucursal}
    const endpoint = `https://api.cbinformatica.net:9031/api/MovilesVentas/visitas/full/${sucursal}`;

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

      const response = await fetchWithTimeout(endpoint, {
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
    const clientesVisitados = await this.getClientesVisitadosPorFecha(new Date(), sucursal);
    console.log(
      `[VisitaSync] 📍 Total clientes visitados hoy (combinado): ${clientesVisitados.size}`,
      Array.from(clientesVisitados),
    );
    return clientesVisitados;
  }

  /**
   * Obtiene el conjunto de clientes visitados en una fecha específica
   * (combina Visita visitado==1, VisitaRealizada y DetalleVisitas).
   * Incluye tanto visitas agendadas realizadas como visitas no agendadas.
   */
  async getClientesVisitadosPorFecha(fecha: Date, sucursal: number): Promise<Set<number>> {
    try {
      const realm = this.getRealm();
      const clientesVisitados = new Set<number>();

      const startOfDay = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate(), 0, 0, 0, 0);
      const endOfDay = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate(), 23, 59, 59, 999);

      // Rango ampliado para cubrir desfases de zona horaria (±1 día)
      const rangoInicio = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate() - 1, 0, 0, 0, 0);
      const rangoFin = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate() + 1, 23, 59, 59, 999);

      const esMismoDiaLocal = (fechaInicio: Date) => {
        const inicioDia = new Date(
          fechaInicio.getFullYear(),
          fechaInicio.getMonth(),
          fechaInicio.getDate(),
        );
        return inicioDia.getTime() >= startOfDay.getTime() && inicioDia.getTime() <= endOfDay.getTime();
      };

      // 1. Tabla Visita (local) con visitado == 1 (excluir pedidos de central tipo 99)
      const visitasLocales = realm
        .objects("Visita")
        .filtered(
          "visitado == 1 AND ruta == $0 AND fecha >= $1 AND fecha <= $2",
          sucursal.toString(),
          startOfDay,
          endOfDay,
        );
      visitasLocales.forEach((v: any) => {
        if (v.tipo !== 99) {
          clientesVisitados.add(v.idCliente);
        }
      });
      console.log("[Visitas] Fuente 1 - Visita local (visitado=1):", visitasLocales.length, "registros. Clientes:", Array.from(visitasLocales).map((v: any) => v.idCliente));

      // 2. Tabla VisitaRealizada (sincronizada) - filtrar por sucursal/ruta y día local
      const visitasRealizadas = realm
        .objects("VisitaRealizada")
        .filtered("idRuta == $0 AND fechaInicio >= $1 AND fechaInicio <= $2", sucursal, rangoInicio, rangoFin);
      visitasRealizadas.forEach((v: any) => {
        if (v.fechaInicio && esMismoDiaLocal(new Date(v.fechaInicio))) {
          clientesVisitados.add(v.idCliente);
        }
      });
      console.log("[Visitas] Fuente 2 - VisitaRealizada:", visitasRealizadas.length, "registros. Clientes:", Array.from(visitasRealizadas).map((v: any) => v.idCliente));

      // 3. Tabla DetalleVisitas (ventas/visitas no agendadas) - filtrar por día local
      const detalleVisitas = realm
        .objects("DetalleVisitas")
        .filtered(
          "idRuta == $0 AND fechaInicio >= $1 AND fechaInicio <= $2",
          sucursal,
          rangoInicio,
          rangoFin,
        );
      detalleVisitas.forEach((v: any) => {
        if (v.fechaInicio && esMismoDiaLocal(new Date(v.fechaInicio))) {
          clientesVisitados.add(v.idCliente);
        }
      });
      console.log("[Visitas] Fuente 3 - DetalleVisitas:", detalleVisitas.length, "registros. Clientes:", Array.from(detalleVisitas).map((v: any) => ({ id: (v as any).id, idCliente: (v as any).idCliente, idRuta: (v as any).idRuta, fechaInicio: (v as any).fechaInicio, fechaFin: (v as any).fechaFin })));
      console.log("[Visitas] Set final de clientes visitados:", clientesVisitados.size, Array.from(clientesVisitados));

      return clientesVisitados;
    } catch (error) {
      console.error("[VisitaSync] ❌ Error al obtener clientes visitados por fecha:", error);
      return new Set();
    }
  }

  /**
   * Resumen de cumplimiento para el corte:
   * - Agenda: programadas, realizadas y porcentaje.
   * - Total de visitas realizadas (agendadas realizadas + no agendadas).
   */
  async getResumenVisitas(
    fecha: Date,
    sucursal: number,
  ): Promise<{
    totalProgramadas: number;
    totalRealizadasAgenda: number;
    porcentajeAgenda: number;
    totalVisitasRealizadas: number;
    visitasNoAgendadas: number;
  }> {
    console.log("[Visitas] getResumenVisitas llamado con fecha:", fecha, "sucursal:", sucursal);
    const agenda = await this.getEstadisticasCumplimiento(fecha, sucursal);
    const clientesVisitados = await this.getClientesVisitadosPorFecha(fecha, sucursal);
    const totalVisitasRealizadas = clientesVisitados.size;
    console.log("[Visitas] getResumenVisitas resultado - totalVisitasRealizadas:", totalVisitasRealizadas, "agenda.totalRealizadas:", agenda.totalRealizadas);
    const visitasNoAgendadas = Math.max(0, totalVisitasRealizadas - agenda.totalRealizadas);

    return {
      totalProgramadas: agenda.totalProgramadas,
      totalRealizadasAgenda: agenda.totalRealizadas,
      porcentajeAgenda: agenda.porcentaje,
      totalVisitasRealizadas,
      visitasNoAgendadas,
    };
  }
}

export default VisitaSyncService;
