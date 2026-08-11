import Realm from "realm";
import AuthService from "../../AuthService";
import { SyncTask, SyncTaskResult } from "../SyncTask";

export class PedidoEstadoUploadSyncTask extends SyncTask {
  constructor(realm: Realm, syncLogId: string) {
    super(realm, syncLogId);
  }

  getTableName(): string {
    return "PedidoEstadoUpload";
  }

  getEndpoint(): string {
    return "https://api.cbinformatica.net:9031/api/MovilesVentas/sp_DetallePedidosEstadosArrastreJSON";
  }

  getPriority(): number {
    return 1;
  }

  getDependencies(): string[] {
    return [];
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      const user = await AuthService.restoreSession();
      const idUsuario = Number(user?.id ?? user?.idUsuario ?? 0);
      const estados = Array.from(
        this.realm.objects("PedidoEstado").filtered("enviado = false AND idVendedor == $0", idUsuario),
      ) as any[];
      if (estados.length === 0) {
        return {
          success: true,
          registrosLeidos: 0,
          registrosGuardados: 0,
        };
      }
      const payload = Array.from(estados).map((estado: any) => ({
        ruta: Number(estado.ruta),
        pedido: Number(estado.pedido),
        fecha: estado.fecha ? new Date(estado.fecha).toISOString() : null,
        estado: Number(estado.estado),
        idVendedor: Number(estado.idVendedor),
      }));
      const url = `${this.getEndpoint()}?idUsuario=${idUsuario}`;

      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        return {
          success: false,
          registrosLeidos: estados.length,
          registrosGuardados: 0,
          error: `HTTP ${response.status}: ${errorText}`,
        };
      }

      this.realm.write(() => {
        Array.from(estados).forEach((estado: any) => {
          estado.enviado = true;
        });
      });

      return {
        success: true,
        registrosLeidos: payload.length,
        registrosGuardados: payload.length,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }
}
