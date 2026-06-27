import Realm from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";

/**
 * Tarea de arrastre de InventarioEnvase pendientes al servidor.
 * Se ejecuta ANTES de VentasArrastre para que el contexto de envases
 * esté disponible cuando se procesen las ventas.
 */
export class InventarioEnvaseSyncTask extends SyncTask {
  protected idUsuario: number;
  protected apiBaseUrl = "https://api.cbinformatica.net:9031";

  constructor(realm: Realm, syncLogId: string, sucursal: number, idUsuario: number) {
    super(realm, syncLogId);
    this.sucursal = sucursal;
    this.idUsuario = idUsuario;
  }

  getTableName(): string {
    return "InventarioEnvaseArrastre";
  }

  getPriority(): number {
    return 95; // Antes de VentasArrastre (100) pero después de las descargas
  }

  getDependencies(): string[] {
    return [];
  }

  getEndpoint(): string {
    return `${this.apiBaseUrl}/api/MovilesVentas/sp_MovilesInventarioEnvasesArrastreJSON?sucursal=${this.sucursal}&idUsuario=${this.idUsuario}`;
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      // Obtener registros pendientes (syncedAt = epoch 0)
      const epoch = new Date(0);
      const pendientes = Array.from(this.realm.objects("InventarioEnvase").filtered("syncedAt == $0", epoch));

      console.log(`[InventarioEnvaseArrastre] Registros pendientes: ${pendientes.length}`);

      if (pendientes.length === 0) {
        return {
          success: true,
          registrosLeidos: 0,
          registrosGuardados: 0,
        };
      }

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

      // Preparar payload según la estructura del endpoint
      const payload = pendientes.map((record: any) => ({
        sucursal: record.sucursal ?? this.sucursal,
        clave_prod: record.claveProd ?? 0,
        folio_movto: record.folioMovto ?? 1,
        cantidad_entrada: record.cantidadEntrada ?? 0,
        cantidad_salida: record.cantidadSalida ?? 0,
        costo: record.costo ?? 0,
        tipo_movto: record.tipoMovto ?? 0,
        fecha_alta: formatLocalDate(record.fechaAlta ?? new Date()),
        fecha_act: formatLocalDate(record.fechaAct ?? new Date()),
        id_movil: record.idMovil ?? 0,
        observacion: record.observacion ?? "",
      }));

      console.log(`[InventarioEnvaseArrastre] 📅 Ejemplo de fecha enviada:`, {
        fechaAltaRealm: pendientes[0]?.fechaAlta,
        fechaAltaFormateada: payload[0]?.fecha_alta,
      });

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

      console.log(`[InventarioEnvaseArrastre] ✅ ${payload.length} registros enviados correctamente`);

      // Marcar como sincronizados
      const now = new Date();
      this.realm.write(() => {
        pendientes.forEach((record: any) => {
          record.syncedAt = now;
        });
      });

      return {
        success: true,
        registrosLeidos: pendientes.length,
        registrosGuardados: payload.length,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Error desconocido";
      console.error("[InventarioEnvaseArrastre] Error:", error);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }
}
