import Realm, { UpdateMode } from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";
import { ProductoSchema } from "../../RealmSchemas";

/**
 * Tarea de sincronización para la tabla Productos
 */
export class ProductosSyncTask extends SyncTask {
  getTableName(): string {
    return "Productos";
  }

  getEndpoint(): string {
    return "https://api.cbinformatica.net:9031/api/MovilesVentas/productos/full";
  }

  getPriority(): number {
    return 2; // Segunda prioridad - productos después de usuarios
  }

  getDependencies(): string[] {
    return []; // Sin dependencias
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      console.log("[ProductosSyncTask] Obteniendo productos desde API...");

      const response = await this.fetchWithTimeout(this.getEndpoint());
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const productos = await response.json();
      console.log({ productos });
      const registrosLeidos = productos.length;
      // DEBUG: verificar si intercambio viene del servidor
      if (Array.isArray(productos) && productos.length > 0) {
        console.log(
          `[ProductosSyncTask] DEBUG Campos del primer producto: ${JSON.stringify(Object.keys(productos[0]))}`,
        );
        const prodConIntercambio = productos.find((p: any) => p.intercambio);
        if (prodConIntercambio) {
          console.log(
            `[ProductosSyncTask] DEBUG Producto con intercambio: id=${prodConIntercambio.id}, claveProd=${
              prodConIntercambio.claveProd
            }, intercambio=${prodConIntercambio.intercambio} (type=${typeof prodConIntercambio.intercambio})`,
          );
        } else {
          console.log(
            `[ProductosSyncTask] DEBUG NINGÚN producto tiene intercambio truthy. Muestra keys: ${JSON.stringify(
              Object.keys(productos[0]),
            )}`,
          );
        }
      }
      const nowMexico = this.getMexicoNow();
      let registrosGuardados = 0;
      let registrosActualizados = 0;

      console.log(`[ProductosSyncTask] Leídos ${registrosLeidos} productos`);

      // Sincronizar con Realm
      this.realm.write(() => {
        for (const producto of productos) {
          const existing = this.realm.objectForPrimaryKey("Producto", producto.id);

          const productoData = {
            ...producto,
            syncedAt: new Date(),
            syncedAr: nowMexico,
          };

          if (existing) {
            this.realm.create("Producto", productoData, UpdateMode.Modified);
            registrosActualizados++;
          } else {
            this.realm.create("Producto", productoData);
            registrosGuardados++;
          }
        }
      });

      console.log(`[ProductosSyncTask] Guardados: ${registrosGuardados}, Actualizados: ${registrosActualizados}`);

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
      console.error("[ProductosSyncTask] Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }
}
