import Realm, { UpdateMode } from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";

/**
 * Tarea de sincronización para la tabla Cias (Compañías)
 */
export class CiasSyncTask extends SyncTask {
  getTableName(): string {
    return "Cias";
  }

  getEndpoint(): string {
    return "https://api.cbinformatica.net:9031/api/MovilesVentas/cias/full";
  }

  getPriority(): number {
    return 1; // Alta prioridad, se sincroniza antes que otros datos
  }

  getDependencies(): string[] {
    return []; // No depende de otras tablas
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      console.log("[CiasSyncTask] Obteniendo compañías desde API...");

      const response = await this.fetchWithTimeout(this.getEndpoint(), {
        headers: { accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const cias = await response.json();
      const registrosLeidos = Array.isArray(cias) ? cias.length : 0;
      const nowMexico = this.getMexicoNow();
      let registrosGuardados = 0;
      let registrosActualizados = 0;

      console.log(`[CiasSyncTask] Leídos ${registrosLeidos} compañías`);

      // Sincronizar con Realm
      let registrosEliminados = 0;
      this.realm.write(() => {
        // Eliminar registros existentes (full sync)
        const todosLocales = this.realm.objects("Cia");
        registrosEliminados = todosLocales.length;
        if (registrosEliminados > 0) {
          this.realm.delete(todosLocales);
        }

        // Insertar nuevos registros usando el ID real del API (fallback a index+1 si no existe)
        if (Array.isArray(cias)) {
          cias.forEach((cia, index) => {
            const ciaId = cia.id ?? index + 1;
            if (cia.id === undefined) {
              console.warn(
                `[CiasSyncTask] cia.id es undefined para "${cia.nombreCia}", usando fallback index+1 = ${ciaId}`,
              );
            }
            const ciaData = {
              id: ciaId,
              telefono: cia.telefono ?? "",
              rfc: cia.rfc ?? "",
              domicilio: cia.domicilio ?? "",
              regimenFiscal: cia.regimenFiscal ?? "",
              nombreCia: cia.nombreCia ?? "",
              syncedAt: nowMexico,
            };

            this.realm.create("Cia", ciaData, UpdateMode.Modified);
            registrosGuardados++;
          });
        }
      });

      console.log(`[CiasSyncTask] Guardados: ${registrosGuardados}, Eliminados: ${registrosEliminados}`);

      return {
        success: true,
        registrosLeidos,
        registrosGuardados,
        registrosActualizados,
        detalles: {
          totalProcesados: registrosGuardados,
        },
      };
    } catch (error) {
      console.error("[CiasSyncTask] Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }
}
