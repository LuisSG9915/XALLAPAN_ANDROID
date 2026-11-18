import Realm from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";
import ClienteFotosService from "../../ClienteFotosService";
import AuthService from "../../AuthService";

export class ClienteFotosSyncTask extends SyncTask {
  getTableName(): string {
    return "ClienteFoto";
  }
  getEndpoint(): string {
    return "https://api.cbinformatica.net:9031/api/MovilesVentas/sp_MovilesClientesFotosFull";
  }
  getPriority(): number {
    return 40;
  }
  getDependencies(): string[] {
    return ["Clientes"];
  }

  // El catálogo full de fotografías pesa ~150 MB: solo se descarga en el
  // login o mediante la descarga manual, nunca dentro de la sync completa.
  isLoginOnly(): boolean {
    return true;
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      ClienteFotosService.setRealm(this.realm);
      const user = await AuthService.restoreSession();
      const usuarioSync = this.idUsuario
        ? (this.realm.objectForPrimaryKey("Usuario", this.idUsuario) as any)
        : null;
      const ruta =
        Number(this.sucursal) ||
        Number(
          usuarioSync?.ruta ?? user?.sucursal_origen ?? user?.sucursal ?? 0,
        );
      if (!ruta) {
        console.warn(
          "[ClienteFoto] No se pudo resolver la ruta del usuario; se omite la descarga de fotos.",
        );
      }
      console.log("[ClienteFoto] Descarga full por ruta:", { ruta });
      const count = await ClienteFotosService.downloadFull(0, ruta);
      return {
        success: true,
        registrosLeidos: count,
        registrosGuardados: count,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }
}

export class ClienteFotosArrastreSyncTask extends SyncTask {
  protected readonly idUsuario: number;
  private readonly apiBaseUrl = "https://api.cbinformatica.net:9031";

  constructor(realm: Realm, syncLogId: string, idUsuario: number) {
    super(realm, syncLogId, undefined, idUsuario);
    this.idUsuario = idUsuario;
  }

  getTableName(): string {
    return "ClienteFotoArrastre";
  }
  getEndpoint(): string {
    return `${this.apiBaseUrl}/api/MovilesVentas/sp_MovilesClientesFotosArrastre`;
  }
  getPriority(): number {
    return 94;
  }
  getDependencies(): string[] {
    return [];
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      ClienteFotosService.setRealm(this.realm);
      console.log("[ClienteFotoArrastre] Iniciando arrastre", {
        idUsuario: this.idUsuario,
        endpoint: this.getEndpoint(),
      });
      const result = await ClienteFotosService.syncPending(this.idUsuario);
      console.log("[ClienteFotoArrastre] Resultado del arrastre:", result);
      return {
        success: result.failed === 0,
        registrosLeidos: result.sent + result.failed,
        registrosGuardados: result.sent,
        error:
          result.failed > 0
            ? `${result.failed} fotografía(s) no pudieron enviarse.`
            : undefined,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }
}
