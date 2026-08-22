import Realm from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";
import BitacoraService from "../../BitacoraService";

/**
 * Tarea de arrastre de ventas pendientes al servidor
 * Se ejecuta al final de la sincronización para subir ventas offline
 */
export class VentasArrastreSyncTask extends SyncTask {
  protected idUsuario: number;
  protected apiBaseUrl = "https://api.cbinformatica.net:9031";

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
        (venta: any) =>
          venta.noVenta === 0 &&
          venta.id >= LOCAL_SALE_ID_THRESHOLD &&
          venta.arrastreEnviado !== true,
      );

      console.log(`[VentasArrastre] Ventas pendientes encontradas: ${ventasLocales.length}`);

      if (ventasLocales.length === 0) {
        return {
          success: true,
          registrosLeidos: 0,
          registrosGuardados: 0,
        };
      }

      // Helper para obtener la hora actual de México
      const getMexicoNow = (): Date => {
        const nowUTC = new Date();
        const formatter = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Mexico_City",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        });

        const parts = formatter.formatToParts(nowUTC);
        const get = (type: string) => parts.find((p) => p.type === type)?.value || "0";

        const mexicoDateUTC = Date.UTC(
          parseInt(get("year"), 10),
          parseInt(get("month"), 10) - 1,
          parseInt(get("day"), 10),
          parseInt(get("hour"), 10),
          parseInt(get("minute"), 10),
          parseInt(get("second"), 10),
        );

        return new Date(mexicoDateUTC);
      };

      // Helper para formatear fecha que ya está en hora de México
      // El Date object almacenado en Realm ya representa la hora de México como UTC
      // Por lo tanto, usamos getUTC* para leer los componentes sin conversión adicional
      const formatLocalDate = (date: Date): string => {
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, "0");
        const day = String(date.getUTCDate()).padStart(2, "0");
        const hours = String(date.getUTCHours()).padStart(2, "0");
        const minutes = String(date.getUTCMinutes()).padStart(2, "0");
        const seconds = String(date.getUTCSeconds()).padStart(2, "0");
        const ms = String(date.getUTCMilliseconds()).padStart(3, "0");

        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
      };

      const formatDateOnly = (date: Date): string =>
        `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
          date.getUTCDate(),
        ).padStart(2, "0")}`;

      const nowMexico = getMexicoNow();

      // Preparar payload
      const payload = ventasLocales.map((venta: any) => ({
        sucursal: venta.sucursal ?? this.sucursal,
        clave_prod: venta.claveProd ?? 0,
        Cant_producto: venta.cantProducto ?? 0,
        precio: venta.precio ?? 0,
        Cve_cliente: venta.cveCliente ?? 0,
        fecha: formatLocalDate(venta.fecha ?? nowMexico),
        tipo_pago: venta.tipoPago ?? 1,
        usuario: this.idUsuario,
        longitud: venta?.longitud ?? 0,
        latitud: venta?.latitud ?? 0,
        id_movil: venta.idMovil,
        fechaTransfer: formatLocalDate(nowMexico),
        observacion: venta.observacion ?? "",
        fecha_devolucion: venta.fechaDevolucion ? formatDateOnly(new Date(venta.fechaDevolucion)) : null,
      }));

      // Enviar al servidor
      const response = await this.fetchWithTimeout(this.getEndpoint(), {
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

      const fechaSincronizacion = getMexicoNow();
      const idsSincronizados = ventasLocales.map((venta: any) => venta.id);
      this.realm.write(() => {
        for (const id of idsSincronizados) {
          const venta = this.realm.objectForPrimaryKey("Venta", id);
          if (venta) {
            (venta as any).arrastreEnviado = true;
            (venta as any).syncedAt = fechaSincronizacion;
          }
        }
      });

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
