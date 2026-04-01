import Realm, { UpdateMode } from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";

/**
 * Tarea de sincronización para la tabla Kits
 * Los kits representan la relación entre productos e insumos con cantidades, precios y descuentos
 */
export class KitsSyncTask extends SyncTask {
  getTableName(): string {
    return "Kits";
  }

  getEndpoint(): string {
    // Nota: Usa puerto 9031 específico para kits según el endpoint proporcionado
    return "https://cbinfo.no-ip.info:9031/api/MovilesVentas/kits/full";
  }

  getPriority(): number {
    return 3; // Después de productos (prioridad 2) ya que depende de ellos
  }

  getDependencies(): string[] {
    return ["Productos"]; // Depende de que los productos estén sincronizados primero
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      console.log("[KitsSyncTask] Obteniendo kits desde API...");

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

      console.log(`[KitsSyncTask] Leídos ${registrosLeidos} kits`);

      // Set de IDs que vienen del servidor
      const idsServidor = new Set<number>(kits.map((k: any) => k.id));

      // Sincronizar con Realm
      let registrosEliminados = 0;
      this.realm.write(() => {
        // Upsert de kits del servidor
        for (const kit of kits) {
          const existing = this.realm.objectForPrimaryKey("Kit", kit.id);

          const kitData = {
            id: kit.id,
            idProducto: kit.idProducto ?? null,
            idInsumo: kit.idInsumo ?? null,
            cantidad: kit.cantidad ?? 0,
            precio: kit.precio ?? 0,
            descuento: kit.descuento ?? 0,
            envaseIntercambio: kit.envaseIntercambio ?? false,
            syncedAt: new Date(),
          };

          if (existing) {
            this.realm.create("Kit", kitData, UpdateMode.Modified);
            registrosActualizados++;
          } else {
            this.realm.create("Kit", kitData);
            registrosGuardados++;
          }
        }

        // Eliminar kits locales que ya no existen en el servidor
        const todosLocales = this.realm.objects("Kit");
        const aEliminar = todosLocales.filter((k: any) => !idsServidor.has(k.id));
        registrosEliminados = aEliminar.length;
        if (registrosEliminados > 0) {
          console.log(`[KitsSyncTask] Eliminando ${registrosEliminados} kits que ya no existen en el servidor`);
          aEliminar.forEach((k: any) => this.realm.delete(k));
        }
      });

      console.log(
        `[KitsSyncTask] Guardados: ${registrosGuardados}, Actualizados: ${registrosActualizados}, Eliminados: ${registrosEliminados}`,
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
      console.error("[KitsSyncTask] Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }
}
