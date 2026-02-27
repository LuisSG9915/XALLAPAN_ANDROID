import Realm from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";
import BitacoraService from "../../BitacoraService";

/**
 * Tarea de arrastre de ventas pendientes al servidor
 * Se ejecuta al final de la sincronización para subir ventas offline
 */
export class VentasArrastreSyncTask extends SyncTask {
  protected idUsuario: number;
  protected apiBaseUrl = "https://cbinfo.no-ip.info:9031";

  constructor(realm: Realm, syncLogId: string, sucursal: number, idUsuario: number) {
    super(realm, syncLogId);
    this.sucursal = sucursal;
    this.idUsuario = idUsuario;
  }

  getTableName(): string {
    return "VentasArrastre";
  }

  getPriority(): number {
    return 100; // Baja prioridad - se ejecuta al final
  }

  getDependencies(): string[] {
    return []; // No depende de otras tareas
  }

  getEndpoint(): string {
    return `${this.apiBaseUrl}/api/SincronizacionMovil/sp_MovilesVentasArrastreJSON?sucursal=${this.sucursal}&idUsuario=${this.idUsuario}`;
  }

  async execute(): Promise<SyncTaskResult> {
    const LOCAL_SALE_ID_THRESHOLD = 1700000000;

    try {
      // Obtener ventas locales pendientes
      const ventasRealm = this.realm.objects("Venta");
      const ventasLocales = Array.from(ventasRealm).filter(
        (venta: any) => venta.noVenta === 0 && venta.id >= LOCAL_SALE_ID_THRESHOLD,
      );

      console.log(`[VentasArrastre] Ventas pendientes encontradas: ${ventasLocales.length}`);

      if (ventasLocales.length === 0) {
        return {
          success: true,
          registrosLeidos: 0,
          registrosGuardados: 0,
        };
      }

      // Preparar payload
      const payload = ventasLocales.map((venta: any) => ({
        sucursal: venta.sucursal ?? this.sucursal,
        clave_prod: venta.claveProd ?? 0,
        Cant_producto: venta.cantProducto ?? 0,
        precio: venta.precio ?? 0,
        Cve_cliente: venta.cveCliente ?? 0,
        fecha: (venta.fecha ?? new Date()).toISOString(),
        tipo_pago: venta.tipoPago ?? 1,
        usuario: this.idUsuario,
        longitud: venta?.longitud ?? 0,
        latitud: venta?.latitud ?? 0,
        id_movil: venta.idMovil,
        fechaTransfer: new Date().toISOString(),
        observacion: venta.observacion ?? "",
      }));

      // Enviar al servidor
      const response = await fetch(this.getEndpoint(), {
        method: "POST",
        headers: {
          accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      console.log(`[VentasArrastre] ✅ ${payload.length} ventas enviadas correctamente`);

      return {
        success: true,
        registrosLeidos: ventasLocales.length,
        registrosGuardados: payload.length,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Error desconocido";
      console.error("[VentasArrastre] Error:", error);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }
}
