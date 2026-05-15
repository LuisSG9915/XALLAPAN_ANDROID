import Realm, { UpdateMode } from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";

/**
 * Tarea de sincronización para la tabla KitIntercambio
 * Define qué envase alternativo se puede entregar para intercambios por producto
 */
export class KitIntercambioSyncTask extends SyncTask {
  getTableName(): string {
    return "KitIntercambio";
  }

  getEndpoint(): string {
    // Usa el endpoint específico para kits intercambio
    return "https://cbinfo.no-ip.info:9031/api/MovilesVentas/kits/intercambios";
  }

  getPriority(): number {
    return 3; // Después de productos (prioridad 2) ya que depende de ellos
  }

  getDependencies(): string[] {
    return ["Productos"]; // Depende de que los productos estén sincronizados primero
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      console.log("[KitIntercambioSyncTask] Obteniendo kits intercambio desde API...");

      const response = await fetch(this.getEndpoint(), {
        headers: { accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const kits = await response.json();
      const registrosLeidos = Array.isArray(kits) ? kits.length : 0;

      const nowMexico = this.getMexicoNow();
      let registrosGuardados = 0;
      let registrosActualizados = 0;

      console.log(`[KitIntercambioSyncTask] Leídos ${registrosLeidos} kits intercambio`);

      // Set de IDs que vienen del servidor
      const idsServidor = new Set<number>(kits.map((k: any) => k.id));

      // Sincronizar con Realm
      let registrosEliminados = 0;
      this.realm.write(() => {
        // Upsert de kits del servidor
        for (const kit of kits) {
          const existing = this.realm.objectForPrimaryKey("KitIntercambio", kit.id);

          const kitData = {
            id: kit.id,
            idProducto: kit.idProducto ?? null,
            idEnvaseOtro: kit.idEnvaseOtro ?? null,
            precioEnvase: kit.precioEnvase ?? null,
            syncedAt: new Date(),
          };

          if (existing) {
            this.realm.create("KitIntercambio", kitData, UpdateMode.Modified);
            registrosActualizados++;
          } else {
            this.realm.create("KitIntercambio", kitData);
            registrosGuardados++;
          }
        }

        // Eliminar kits locales que ya no existen en el servidor
        const todosLocales = this.realm.objects("KitIntercambio");
        const aEliminar = todosLocales.filter((k: any) => !idsServidor.has(k.id));
        registrosEliminados = aEliminar.length;
        if (registrosEliminados > 0) {
          console.log(
            `[KitIntercambioSyncTask] Eliminando ${registrosEliminados} kits intercambio que ya no existen en el servidor`,
          );
          aEliminar.forEach((k: any) => this.realm.delete(k));
        }
      });

      console.log(
        `[KitIntercambioSyncTask] Guardados: ${registrosGuardados}, Actualizados: ${registrosActualizados}, Eliminados: ${registrosEliminados}`,
      );

      return {
        success: true,
        registrosLeidos,
        registrosGuardados,
        registrosActualizados,
        detalles: {
          totalProcesados: registrosGuardados + registrosActualizados,
        },
      };
    } catch (error) {
      console.error("[KitIntercambioSyncTask] Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }
}
