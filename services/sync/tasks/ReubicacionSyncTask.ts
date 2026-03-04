import Realm from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";

/**
 * Tarea de sincronización de reubicaciones (subida al servidor)
 * Prioridad: 96 (después de envases, antes de ventas)
 */
export class ReubicacionSyncTask extends SyncTask {
  protected idUsuario: number;
  protected apiBaseUrl = "https://cbinfo.no-ip.info:9031";

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
    try {
      console.log(`[ReubicacionSync] 📤 Iniciando sincronización de reubicaciones para sucursal ${this.sucursal}`);

      // Obtener reubicaciones pendientes de envío
      const reubicacionesPendientes = this.realm
        .objects("Reubicacion")
        .filtered("enviado == false AND sucursal == $0", this.sucursal);

      const registrosLeidos = reubicacionesPendientes.length;

      if (registrosLeidos === 0) {
        console.log("[ReubicacionSync] ✓ No hay reubicaciones pendientes");
        return {
          success: true,
          registrosLeidos: 0,
          registrosGuardados: 0,
        };
      }

      console.log(`[ReubicacionSync] Enviando ${registrosLeidos} reubicaciones pendientes`);

      // Convertir a array de objetos planos
      const payload = Array.from(reubicacionesPendientes).map((r: any) => ({
        sucursal: r.sucursal,
        cveCliente: r.cveCliente,
        latitudAnterior: r.latitudAnterior,
        longitudAnterior: r.longitudAnterior,
        latitudNueva: r.latitudNueva,
        longitudNueva: r.longitudNueva,
        fecha: (r.fecha ?? new Date()).toISOString(),
        usuario: r.usuario,
        idMovil: r.idMovil,
        fechaTransfer: (r.fechaTransfer ?? new Date()).toISOString(),
      }));
      console.log(payload)
      // Enviar al servidor
      const response = await fetch(this.getEndpoint(), {
        method: "POST",
        headers: {
          accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reubicaciones: payload,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      // Marcar como enviadas
      this.realm.write(() => {
        reubicacionesPendientes.forEach((r: any) => {
          r.enviado = true;
        });
      });

      console.log(`[ReubicacionSync] ✅ ${payload.length} reubicaciones enviadas exitosamente`);

      return {
        success: true,
        registrosLeidos,
        registrosGuardados: payload.length,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Error desconocido";
      console.error("[ReubicacionSync] ❌ Error:", errorMsg);

      return {
        success: false,
        error: errorMsg,
      };
    }
  }
}
