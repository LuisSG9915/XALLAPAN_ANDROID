import Realm from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";

/**
 * Tarea de arrastre de modificaciones (quitar renglón) de ventas al servidor
 * Se ejecuta al inicio de la sincronización junto con las cancelaciones
 */
export class VentaModificacionSyncTask extends SyncTask {
  protected idUsuario: number;
  protected apiBaseUrl = "https://api.cbinformatica.net:9031";

  constructor(realm: Realm, syncLogId: string, sucursal: number, idUsuario: number) {
    super(realm, syncLogId);
    this.sucursal = sucursal;
    this.idUsuario = idUsuario;
  }

  getTableName(): string {
    return "VentaModificacionArrastre";
  }

  getPriority(): number {
    return 102;
  }

  getDependencies(): string[] {
    return [];
  }

  getEndpoint(): string {
    return `${this.apiBaseUrl}/api/MovilesVentas/sp_MovilesVentasModificacionJSON?sucursal=${this.sucursal}&idUsuario=${this.idUsuario}`;
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      const modificacionesRealm = this.realm.objects("VentaModificacion");
      const modificacionesPendientes = Array.from(modificacionesRealm).filter((mod: any) => !mod.enviado);

      console.log(`[VentaModificacion] Modificaciones pendientes: ${modificacionesPendientes.length}`);

      if (modificacionesPendientes.length === 0) {
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

      const payload = modificacionesPendientes.map((mod: any) => ({
        sucursal: mod.sucursal ?? this.sucursal,
        no_venta: mod.noVenta ?? 0,
        caja: mod.caja ?? 1,
        id_movil: mod.idMovil,
        clave_prod: mod.claveProd,
        nombre_producto: mod.nombreProducto ?? "",
        cantidad_anterior: mod.cantidadAnterior ?? 0,
        cantidad_nueva: mod.cantidadNueva ?? 0,
        usuario_modifica: mod.usuarioModifica ?? this.idUsuario,
        fecha_modifica: formatDate(mod.fechaModifica ?? new Date()),
        motivo_modificacion: mod.motivoModificacion ?? "",
        latitud: mod.latitud ?? 0,
        longitud: mod.longitud ?? 0,
      }));

      const response = await fetch(this.getEndpoint(), {
        method: "POST",
        headers: {
          accept: "application/octet-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      console.log("Payload modificaciones:", JSON.stringify(payload));

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      this.realm.write(() => {
        modificacionesPendientes.forEach((mod: any) => {
          mod.enviado = true;
        });
      });

      console.log(`[VentaModificacion] ✅ ${payload.length} modificaciones enviadas correctamente`);

      return {
        success: true,
        registrosLeidos: modificacionesPendientes.length,
        registrosGuardados: payload.length,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Error desconocido";
      console.error("[VentaModificacion] Error:", error);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }
}
