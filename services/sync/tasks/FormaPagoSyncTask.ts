import Realm from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";

/**
 * Tarea de sincronización para FormaPago
 * Sincroniza las formas de pago desde el servidor
 */
export class FormaPagoSyncTask extends SyncTask {
  constructor(realm: Realm, syncLogId: string, sucursal?: number) {
    super(realm, syncLogId, sucursal);
  }

  getTableName(): string {
    return "FormaPago";
  }

  getEndpoint(): string {
    return `https://api.cbinformatica.net:9031/api/MovilesVentas/formas-pagos?sucursal=${this.sucursal || 0}`;
  }

  getPriority(): number {
    return 2;
  }

  getDependencies(): string[] {
    return [];
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      console.log(`[FormaPagoSyncTask] Sincronizando formas de pago para sucursal ${this.sucursal}...`);

      const response = await fetch(this.getEndpoint(), {
        headers: {
          accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const formasPago = await response.json();
      console.log(`[FormaPagoSyncTask] Recibidas ${formasPago.length} formas de pago`);

      if (!Array.isArray(formasPago)) {
        throw new Error("La respuesta no es un array");
      }

      let registrosGuardados = 0;

      this.realm.write(() => {
        // Limpiar formas de pago existentes
        const existing = this.realm.objects("FormaPago");
        this.realm.delete(existing);

        // Insertar todas las formas de pago
        formasPago.forEach((fp: any) => {
          this.realm.create("FormaPago", {
            tipo: fp.tipo,
            sucursal: fp.sucursal ?? null,
            descripcion: fp.descripcion ?? null,
            grupoOperacion: fp.grupoOperacion ?? null,
            tarjeta: fp.tarjeta ?? null,
            cuentaBancaria: fp.cuentaBancaria ?? null,
            pago0: fp.pago0 ?? null,
            syncedAt: new Date(),
          });
          registrosGuardados++;
        });
      });

      console.log(`[FormaPagoSyncTask] ✅ Sincronización completa: ${registrosGuardados} formas de pago guardadas`);

      return {
        success: true,
        registrosLeidos: formasPago.length,
        registrosGuardados,
        registrosActualizados: 0,
      };
    } catch (error) {
      console.error("[FormaPagoSyncTask] ❌ Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }
}
