import Realm, { UpdateMode } from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";

/**
 * Tarea de descarga del historial completo de InventarioEnvases desde el servidor.
 * Se usa en sincronización inicial y parcial.
 * Endpoint: GET /api/MovilesVentas/inventario-envases/full/{sucursal}
 */
export class InventarioEnvasesHistorialSyncTask extends SyncTask {
  protected apiBaseUrl = "https://cbinfo.no-ip.info:9031";

  constructor(realm: Realm, syncLogId: string, sucursal: number) {
    super(realm, syncLogId);
    this.sucursal = sucursal;
  }

  getTableName(): string {
    return "InventarioEnvasesHistorial";
  }

  getPriority(): number {
    return 10; // Después de inventario base (prioridad 5)
  }

  getDependencies(): string[] {
    return [];
  }

  getEndpoint(): string {
    return `${this.apiBaseUrl}/api/MovilesVentas/inventario-envases/full/${this.sucursal}`;
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      console.log(`[InventarioEnvasesHistorial] Descargando desde ${this.getEndpoint()}`);

      const response = await fetch(this.getEndpoint(), {
        headers: { accept: "application/json" },
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      const registrosLeidos = Array.isArray(data) ? data.length : 0;
      const nowMexico = this.getMexicoNow();
      let registrosGuardados = 0;
      let registrosActualizados = 0;

      console.log(`[InventarioEnvasesHistorial] Leídos ${registrosLeidos} registros`);

      this.realm.write(() => {
        for (const item of data) {
          const existing = this.realm.objectForPrimaryKey("InventarioEnvasesHistorial", item.id);

          const record = {
            id: item.id,
            sucursal: item.sucursal ?? null,
            almacen: item.almacen ?? null,
            claveProd: item.claveProd ?? null,
            descripcionCorta: item.descripcionCorta ?? null,
            fechaMovto: item.fechaMovto ? new Date(item.fechaMovto) : null,
            folioMovto: item.folioMovto ?? null,
            cantidadEntrada: item.cantidadEntrada ?? null,
            cantidadSalida: item.cantidadSalida ?? null,
            tipoMovto: item.tipoMovto ?? null,
            idMovil: item.idMovil ?? null,
            syncedAt: nowMexico,
          };

          if (existing) {
            this.realm.create("InventarioEnvasesHistorial", record, UpdateMode.Modified);
            registrosActualizados++;
          } else {
            this.realm.create("InventarioEnvasesHistorial", record);
            registrosGuardados++;
          }
        }
      });

      console.log(
        `[InventarioEnvasesHistorial] Guardados: ${registrosGuardados}, Actualizados: ${registrosActualizados}`,
      );

      return {
        success: true,
        registrosLeidos,
        registrosGuardados,
        registrosActualizados,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Error desconocido";
      console.error("[InventarioEnvasesHistorial] Error:", error);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }
}
