import Realm, { UpdateMode } from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";

/**
 * Tarea de sincronización incremental para la tabla Productos
 * Sincroniza solo los productos que han cambiado desde una fecha
 */
export class ProductosIncrementalSyncTask extends SyncTask {
  getTableName(): string {
    return "ProductosIncremental";
  }

  getEndpoint(): string {
    // Usar endpoint incremental con fecha inicial
    const fechaInicial = this.getFechaInicial();
    return `https://api.cbinformatica.net:9031/api/MovilesVentas/productos/incremental?sucursal=${this.sucursal || 0}&fechaInicial=${encodeURIComponent(fechaInicial)}`;
  }

  getPriority(): number {
    return 2;
  }

  getDependencies(): string[] {
    return [];
  }

  private getFechaInicial(): string {
    // Obtener la fecha de la última sincronización exitosa de productos
    // Se usa SyncTableLog (bitácora por tabla que escribe SyncTask.executeWithLogging)
    // Si no hay, usar una fecha de hace 24 horas
    const lastSync = this.realm
      .objects("SyncTableLog")
      .filtered(
        "(tabla == 'Productos' OR tabla == 'ProductosIncremental') AND exitoso == true AND fechaFinal != null",
      )
      .sorted("fechaFinal", true);
    if (lastSync.length > 0) {
      const lastSyncDate = (lastSync[0] as any).fechaFinal;
      if (lastSyncDate) {
        return this.formatMexicoDateForServer(lastSyncDate);
      }
    }
    // Si no hay sincronización previa, usar hace 24 horas
    const date = new Date();
    date.setHours(date.getHours() - 24);
    return this.formatMexicoDateForServer(date);
  }

  private formatMexicoDateForServer(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      console.log("[ProductosIncrementalSyncTask] Obteniendo productos incrementales desde API...");

      const response = await this.fetchWithTimeout(this.getEndpoint());
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const productos = await response.json();
      console.log(`[ProductosIncrementalSyncTask] Recibidos ${productos.length} productos incrementales`);

      if (!Array.isArray(productos)) {
        throw new Error("La respuesta no es un array");
      }

      const nowMexico = this.getMexicoNow();
      let registrosGuardados = 0;
      let registrosActualizados = 0;

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

      console.log(
        `[ProductosIncrementalSyncTask] Guardados: ${registrosGuardados}, Actualizados: ${registrosActualizados}`,
      );

      return {
        success: true,
        registrosLeidos: productos.length,
        registrosGuardados,
        registrosActualizados,
      };
    } catch (error) {
      console.error("[ProductosIncrementalSyncTask] Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }
}
