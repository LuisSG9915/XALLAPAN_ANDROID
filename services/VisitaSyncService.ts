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
        schemaVersion: 11,
        onMigration: (oldRealm: Realm, newRealm: Realm) => {
          // Migración para Usuario - inicializar campo metros
          const newUsuarios = newRealm.objects("Usuario");
          for (let i = 0; i < newUsuarios.length; i++) {
            const obj: any = newUsuarios[i];
            if (typeof obj.metros === "undefined" || obj.metros === null) {
              obj.metros = 31; // Valor por defecto
            }
          }
        },
      });
    }
    return this.realm;
  }

  async syncFull(): Promise<SyncTaskResult> {
    try {
      console.log("[VisitaSync] Iniciando sincronización completa");

      const response = await fetch("https://cbinfo.no-ip.info:9031/api/MovilesVentas/visitas/full");
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const visitasData = await response.json();
      console.log(visitasData);
      if (!Array.isArray(visitasData)) {
        throw new Error("La respuesta no es un array de visitas");
      }

      const realm = await this.getRealm();
      let actualizados = 0;
      let nuevos = 0;

      realm.write(() => {
        // Limpiar todas las visitas existentes
        const existingVisitas = realm.objects("Visita");
        realm.delete(existingVisitas);

        // Insertar todas las visitas con syncedAr
        visitasData.forEach((visita: any) => {
          const visitaRealm = realm.create("Visita", {
            ...visita,
            syncedAr: new Date().toISOString(),
          });

          if (visita.id > 0) {
            nuevos++;
          }
        });
      });

      console.log(`[VisitaSync] ✅ Sincronización completa: ${nuevos} nuevas visitas`);
      return {
        success: true,
        registrosLeidos: visitasData.length,
        registrosGuardados: nuevos,
        registrosActualizados: actualizados,
      };
    } catch (error) {
      console.error("[VisitaSync] ❌ Error en sincronización completa:", error);
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
        const visita = realm.objectForPrimaryKey("Visita", idVisita);
        if (visita && !visita.visitado) {
          visita.visitado = true;
          visita.fecha = new Date().toISOString();
          if (tipoVisita !== undefined) {
            visita.tipoVisita = tipoVisita;
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

  async getVisitasDelDia(sucursal: number): Promise<any[]> {
    try {
      const realm = await this.getRealm();
      const today = new Date().getDay(); // 0 = Domingo, 1 = Lunes, etc.

      const dayMap: { [key: number]: string } = {
        0: "d", // Domingo
        1: "l", // Lunes
        2: "m", // Martes
        3: "mi", // Miércoles
        4: "j", // Jueves
        5: "v", // Viernes
        6: "s", // Sábado
      };

      const dayField = dayMap[today];

      let visitas = realm.objects("Visita");

      // Filtrar por día de la semana
      visitas = visitas.filtered(`${dayField} == true AND ruta == '${sucursal}'`);

      // Ordenar por el campo de orden correspondiente al día
      const ordenField = `orden${dayField.charAt(0).toUpperCase() + dayField.slice(1)}`;
      visitas = visitas.sorted(ordenField);

      // Convertir a objetos JavaScript planos para evitar problemas con Realm cerrado
      return visitas.map((v: any) => ({
        id: v.id,
        idCliente: v.idCliente,
        ruta: v.ruta,
        l: v.l,
        m: v.m,
        mi: v.mi,
        j: v.j,
        v: v.v,
        s: v.s,
        d: v.d,
        ordenL: v.ordenL,
        ordenM: v.ordenM,
        ordenMi: v.ordenMi,
        ordenJ: v.ordenJ,
        ordenV: v.ordenV,
        ordenS: v.ordenS,
        ordenD: v.ordenD,
        visitado: v.visitado,
        fecha: v.fecha,
      }));
    } catch (error) {
      console.error("[VisitaSync] ❌ Error al obtener visitas del día:", error);
      return [];
    }
  }

  async getEstadisticasCumplimiento(sucursal: number): Promise<{
    totalProgramadas: number;
    totalRealizadas: number;
    porcentaje: number;
  }> {
    try {
      const visitas = await this.getVisitasDelDia(sucursal);
      const totalProgramadas = visitas.length;
      const totalRealizadas = visitas.filter((v) => v.visitado).length;
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
