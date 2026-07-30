import Realm from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";
import ReubicacionService from "../../ReubicacionService";

/**
 * Tarea de sincronización de reubicaciones (subida al servidor)
 * Prioridad: 96 (después de envases, antes de ventas)
 *
 * Delega el envío en ReubicacionService.enviarReubicacionesPendientes para
 * mantener un único emisor, filtro y política post-éxito.
 */
export class ReubicacionSyncTask extends SyncTask {
  protected idUsuario: number;

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
    return `${ReubicacionService.getInstance().getApiBaseUrl()}/api/SincronizacionMovil/sp_MovilesReubicacionesJSON?sucursal=${this.sucursal}&idUsuario=${this.idUsuario}`;
  }

  async execute(): Promise<SyncTaskResult> {
    console.log(`[ReubicacionSync] Iniciando sincronización de reubicaciones para sucursal ${this.sucursal}`);
    console.log(`[ReubicacionSync] idUsuario: ${this.idUsuario}`);

    if (!this.sucursal || !this.idUsuario) {
      return {
        success: false,
        error: "Faltan sucursal o idUsuario para sincronizar reubicaciones",
      };
    }

    ReubicacionService.getInstance().setRealm(this.realm);
    const result = await ReubicacionService.getInstance().enviarReubicacionesPendientes(this.sucursal, this.idUsuario);

    return {
      success: result.success,
      registrosLeidos: result.sent,
      registrosGuardados: result.sent,
      error: result.error,
    };
  }
}
