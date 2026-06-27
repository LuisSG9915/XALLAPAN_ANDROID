import Realm, { UpdateMode } from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";
import { PrecioSchema } from "../../RealmSchemas";

/**
 * Tarea de sincronización para la tabla Precios
 * Procesa en lotes pequeños para evitar OOM con grandes volúmenes de datos
 */
export class PreciosSyncTask extends SyncTask {
  private readonly BATCH_SIZE = 200; // Registros por transacción de Realm (reducido para evitar OOM)

  getTableName(): string {
    return "Precios";
  }

  getEndpoint(): string {
    return "https://api.cbinformatica.net:9031/api/MovilesVentas/precios/full";
  }

  getPriority(): number {
    return 3; // Tercera prioridad - precios después de productos
  }

  getDependencies(): string[] {
    return ["Productos"]; // Depende de productos para validar claves
  }

  /**
   * Procesa un lote de precios en una transacción de Realm
   */
  private processBatch(precios: any[]): { guardados: number; actualizados: number } {
    let guardados = 0;
    let actualizados = 0;

    this.realm.write(() => {
      for (const precio of precios) {
        const existing = this.realm.objectForPrimaryKey("Precio", precio.id);

        const precioData = {
          ...precio,
          syncedAt: new Date(),
          syncedAr: precio.fechaLog ? new Date(precio.fechaLog) : null,
        };

        if (existing) {
          this.realm.create("Precio", precioData, UpdateMode.Modified);
          actualizados++;
        } else {
          this.realm.create("Precio", precioData);
          guardados++;
        }
      }
    });

    return { guardados, actualizados };
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      console.log("[PreciosSyncTask] Obteniendo precios desde API...");

      const response = await this.fetchWithTimeout(this.getEndpoint());
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Obtener el texto crudo primero para procesarlo en chunks
      const text = await response.text();
      console.log(`[PreciosSyncTask] Respuesta recibida: ${(text.length / 1024 / 1024).toFixed(2)} MB`);

      // Parsear JSON
      const precios = JSON.parse(text);
      const totalLeidos = precios.length;
      let totalGuardados = 0;
      let totalActualizados = 0;

      console.log(`[PreciosSyncTask] Total registros: ${totalLeidos}`);

      // Procesar en lotes pequeños para evitar OOM en Realm
      const totalBatches = Math.ceil(precios.length / this.BATCH_SIZE);

      for (let i = 0; i < precios.length; i += this.BATCH_SIZE) {
        const batchNum = Math.floor(i / this.BATCH_SIZE) + 1;
        const batch = precios.slice(i, i + this.BATCH_SIZE);

        const result = this.processBatch(batch);
        totalGuardados += result.guardados;
        totalActualizados += result.actualizados;

        // Log de progreso cada 10 lotes
        if (batchNum % 10 === 0 || batchNum === totalBatches) {
          console.log(`[PreciosSyncTask] Lote ${batchNum}/${totalBatches} completado`);
        }
      }

      console.log(`[PreciosSyncTask] Completado - Guardados: ${totalGuardados}, Actualizados: ${totalActualizados}`);

      return {
        success: true,
        registrosLeidos: totalLeidos,
        registrosGuardados: totalGuardados,
        registrosActualizados: totalActualizados,
        detalles: {
          totalProcesados: totalGuardados + totalActualizados,
          lotes: totalBatches,
        },
      };
    } catch (error) {
      console.error("[PreciosSyncTask] Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }
}
