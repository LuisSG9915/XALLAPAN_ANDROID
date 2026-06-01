import Realm from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";

/**
 * Tarea de sincronización de reubicaciones (subida al servidor)
 * Prioridad: 96 (después de envases, antes de ventas)
 */
export class ReubicacionSyncTask extends SyncTask {
  protected idUsuario: number;
  protected apiBaseUrl = "https://api.cbinformatica.net:9031";

  constructor(realm: Realm, syncLogId: string, sucursal: number, idUsuario: number) {
    super(realm, syncLogId);
    this.sucursal = sucursal;
    this.idUsuario = idUsuario;
  }

  getTableName(): string {
    return "Reubicacion";
  }

  getPriority(): number {
    return 96; // Después de envases (95), antes de ventas (100)
  }

  getDependencies(): string[] {
    return []; // No tiene dependencias
  }

  getEndpoint(): string {
    return `${this.apiBaseUrl}/api/SincronizacionMovil/sp_MovilesReubicacionesJSON?sucursal=${this.sucursal}&idUsuario=${this.idUsuario}`;
  }

  async execute(): Promise<SyncTaskResult> {
    console.log(`[ReubicacionSync] � Iniciando sincronización de reubicaciones para sucursal ${this.sucursal}`);
    console.log(`[ReubicacionSync] idUsuario: ${this.idUsuario}`);

    try {
      // Verificar todas las reubicaciones en BD
      const todasReubicaciones = this.realm.objects("Reubicacion");
      console.log(`[ReubicacionSync] Total reubicaciones en BD: ${todasReubicaciones.length}`);

      // Obtener reubicaciones pendientes de envío
      const reubicacionesPendientes = this.realm
        .objects("Reubicacion")
        .filtered("enviado == false AND sucursal == $0", this.sucursal);

      const registrosLeidos = reubicacionesPendientes.length;
      console.log(
        `[ReubicacionSync] Reubicaciones pendientes (enviado=false, sucursal=${this.sucursal}): ${registrosLeidos}`,
      );

      if (registrosLeidos === 0) {
        console.log("[ReubicacionSync] ℹ️ No hay reubicaciones pendientes");
        return {
          success: true,
          registrosLeidos: 0,
          registrosGuardados: 0,
        };
      }

      console.log(`[ReubicacionSync] 📤 Enviando ${registrosLeidos} reubicaciones pendientes`);
      console.log(
        `[ReubicacionSync] Detalles:`,
        Array.from(reubicacionesPendientes).map((r: any) => ({
          id: r.id,
          idCliente: r.idCliente,
          sucursal: r.sucursal,
          enviado: r.enviado,
          fecha: r.fecha,
        })),
      );

      // Convertir a array de objetos planos
      const payload = Array.from(reubicacionesPendientes).map((r: any) => ({
        sucursal: r.sucursal ?? this.sucursal,
        cveCliente: r.idCliente,
        latitudAnterior: 0,
        longitudAnterior: 0,
        latitudNueva: r.latitud ?? 0,
        longitudNueva: r.longitud ?? 0,
        fecha: (r.fecha ?? new Date()).toISOString(),
        usuario: r.idUsuario ?? this.idUsuario,
        idMovil: r.id,
        fechaTransfer: new Date().toISOString(),
      }));

      const endpoint = this.getEndpoint();
      console.log(`[ReubicacionSync] 🌐 Endpoint: ${endpoint}`);
      console.log(`[ReubicacionSync] 📦 Payload:`, JSON.stringify({ request: payload }, null, 2));

      // Enviar al servidor
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          request: payload,
        }),
      });

      console.log(`[ReubicacionSync] 📡 Respuesta HTTP: ${response.status} ${response.statusText}`);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "No se pudo leer el error");
        console.error(`[ReubicacionSync] ❌ Error HTTP ${response.status}:`, errorText);
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const responseText = await response.text();
      console.log(`[ReubicacionSync] 📥 Respuesta del servidor:`, responseText);

      // Eliminar reubicaciones enviadas exitosamente
      this.realm.write(() => {
        this.realm.delete(reubicacionesPendientes);
      });

      console.log(`[ReubicacionSync] ✅ ${payload.length} reubicaciones enviadas y eliminadas exitosamente`);

      return {
        success: true,
        registrosLeidos,
        registrosGuardados: payload.length,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Error desconocido";
      console.error("[ReubicacionSync] ❌ Error:", errorMsg);
      console.error("[ReubicacionSync] ❌ Stack:", error instanceof Error ? error.stack : "N/A");

      return {
        success: false,
        error: errorMsg,
      };
    }
  }
}
