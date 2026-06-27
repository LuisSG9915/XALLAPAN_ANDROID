import Realm from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";

/**
 * Tarea de arrastre de cancelaciones de ventas al servidor
 * Se ejecuta al final de la sincronización para subir cancelaciones pendientes
 */
export class VentaCancelacionSyncTask extends SyncTask {
  protected idUsuario: number;
  protected apiBaseUrl = "https://api.cbinformatica.net:9031";

  constructor(realm: Realm, syncLogId: string, sucursal: number, idUsuario: number) {
    super(realm, syncLogId);
    this.sucursal = sucursal;
    this.idUsuario = idUsuario;
  }

  getTableName(): string {
    return "VentaCancelacionArrastre";
  }

  getPriority(): number {
    return 101;
  }

  getDependencies(): string[] {
    return [];
  }

  getEndpoint(): string {
    return `${this.apiBaseUrl}/api/MovilesVentas/sp_MovilesVentasCancelacionJSON?sucursal=${this.sucursal}&idUsuario=${this.idUsuario}`;
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      const cancelacionesRealm = this.realm.objects("VentaCancelacion");
      const cancelacionesPendientes = Array.from(cancelacionesRealm).filter(
        (cancelacion: any) => !cancelacion.enviado
      );

      console.log(`[VentaCancelacion] Cancelaciones pendientes: ${cancelacionesPendientes.length}`);

      if (cancelacionesPendientes.length === 0) {
        return {
          success: true,
          registrosLeidos: 0,
          registrosGuardados: 0,
        };
      }

      const formatDate = (date: Date): string => {
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, "0");
        const day = String(date.getUTCDate()).padStart(2, "0");
        const hours = String(date.getUTCHours()).padStart(2, "0");
        const minutes = String(date.getUTCMinutes()).padStart(2, "0");
        const seconds = String(date.getUTCSeconds()).padStart(2, "0");

        return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.000Z`;
      };

      const payload = cancelacionesPendientes.map((cancelacion: any) => ({
        sucursal: cancelacion.sucursal ?? this.sucursal,
        no_venta: cancelacion.noVenta ?? 0,
        caja: cancelacion.caja ?? 1,
        id_movil: cancelacion.idMovil,
        usuario_cancela: cancelacion.usuarioCancela ?? this.idUsuario,
        fecha_cancela: formatDate(cancelacion.fechaCancela ?? new Date()),
        motivo_cancelacion: cancelacion.motivoCancelacion ?? "",
        latitud: cancelacion.latitud ?? 0,
        longitud: cancelacion.longitud ?? 0,
      }));

      const response = await this.fetchWithTimeout(this.getEndpoint(), {
        method: "POST",
        headers: {
          accept: "application/octet-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      console.log("Payload:", JSON.stringify(payload));
      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      this.realm.write(() => {
        cancelacionesPendientes.forEach((cancelacion: any) => {
          cancelacion.enviado = true;
        });
      });

      console.log(`[VentaCancelacion] ✅ ${payload.length} cancelaciones enviadas correctamente`);

      return {
        success: true,
        registrosLeidos: cancelacionesPendientes.length,
        registrosGuardados: payload.length,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Error desconocido";
      console.error("[VentaCancelacion] Error:", error);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }
}
