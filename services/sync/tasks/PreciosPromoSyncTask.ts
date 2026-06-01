import Realm, { UpdateMode } from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";
import { PrecioPromoSchema } from "../../RealmSchemas";

/**
 * Tarea de sincronización para la tabla PreciosPromo
 * Procesa en lotes pequeños para evitar OOM con grandes volúmenes de datos
 */
export class PreciosPromoSyncTask extends SyncTask {
  private readonly BATCH_SIZE = 200;

  getTableName(): string {
    return "PreciosPromo";
  }

  getEndpoint(): string {
    return "https://api.cbinformatica.net:9031/api/MovilesVentas/precios-promo/full";
  }

  getPriority(): number {
    return 2;
  }

  getDependencies(): string[] {
    return ["Productos"];
  }

  private processBatch(precios: any[]): { guardados: number; actualizados: number } {
    let guardados = 0;
    let actualizados = 0;

    this.realm.write(() => {
      for (const precio of precios) {
        const existing = this.realm.objectForPrimaryKey("PrecioPromo", precio.id);

        const precioData = {
          ...precio,
          syncedAt: new Date(),
          syncedAr: precio.fechaLog ? new Date(precio.fechaLog) : null,
        };

        if (existing) {
          this.realm.create("PrecioPromo", precioData, UpdateMode.Modified);
          actualizados++;
        } else {
          this.realm.create("PrecioPromo", precioData);
          guardados++;
        }
      }
    });

    return { guardados, actualizados };
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      console.log("[PreciosPromoSyncTask] Obteniendo precios promocionales desde API...");

      const response = await fetch(this.getEndpoint());
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const text = await response.text();
      console.log(`[PreciosPromoSyncTask] Respuesta recibida: ${(text.length / 1024 / 1024).toFixed(2)} MB`);

      const precios = JSON.parse(text);
      const totalLeidos = precios.length;
      let totalGuardados = 0;
      let totalActualizados = 0;

      console.log(`[PreciosPromoSyncTask] Total registros: ${totalLeidos}`);

      const totalBatches = Math.ceil(precios.length / this.BATCH_SIZE);

      for (let i = 0; i < precios.length; i += this.BATCH_SIZE) {
        const batchNum = Math.floor(i / this.BATCH_SIZE) + 1;
        const batch = precios.slice(i, i + this.BATCH_SIZE);

        const result = this.processBatch(batch);
        totalGuardados += result.guardados;
        totalActualizados += result.actualizados;

        if (batchNum % 10 === 0 || batchNum === totalBatches) {
          console.log(`[PreciosPromoSyncTask] Lote ${batchNum}/${totalBatches} completado`);
        }
      }

      console.log(
        `[PreciosPromoSyncTask] Completado - Guardados: ${totalGuardados}, Actualizados: ${totalActualizados}`
      );

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
      console.error("[PreciosPromoSyncTask] Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }
}
