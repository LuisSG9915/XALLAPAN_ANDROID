import Realm from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";

export class CatalogosPedidosSyncTask extends SyncTask {
  constructor(realm: Realm, syncLogId: string) {
    super(realm, syncLogId);
  }

  getTableName(): string {
    return "CatalogosPedidos";
  }

  getEndpoint(): string {
    return "https://api.cbinformatica.net:9031/api/MovilesVentas/sp_MovilesPedidosEstatus";
  }

  getPriority(): number {
    return 5;
  }

  getDependencies(): string[] {
    return [];
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      console.log(`[CatalogosPedidosSyncTask] Sincronizando catálogos de pedidos...`);

      let totalLeidos = 0;
      let totalGuardados = 0;

      const [estatusRes, causasDifRes, causasNoAtRes] = await Promise.all([
        this.fetchWithTimeout(
          "https://api.cbinformatica.net:9031/api/MovilesVentas/sp_MovilesPedidosEstatus",
          { headers: { accept: "application/json" } },
        ),
        this.fetchWithTimeout(
          "https://api.cbinformatica.net:9031/api/MovilesVentas/sp_MovilesPedidosDiferencias",
          { headers: { accept: "application/json" } },
        ),
        this.fetchWithTimeout(
          "https://api.cbinformatica.net:9031/api/MovilesVentas/sp_MovilesPedidosNoAtencion",
          { headers: { accept: "application/json" } },
        ),
      ]);

      if (estatusRes.ok) {
        const estatusData = await estatusRes.json();
        if (Array.isArray(estatusData)) {
          totalLeidos += estatusData.length;
          this.realm.write(() => {
            estatusData.forEach((item: any) => {
              this.realm.create(
                "CatalogoEstatusPedido",
                { id: item.id, descripcion: item.descripcion },
                Realm.UpdateMode.Modified,
              );
              totalGuardados++;
            });
          });
          console.log(`[CatalogosPedidosSyncTask] Estatus: ${estatusData.length} registros`);
        }
      }

      if (causasDifRes.ok) {
        const causasDifData = await causasDifRes.json();
        if (Array.isArray(causasDifData)) {
          totalLeidos += causasDifData.length;
          this.realm.write(() => {
            causasDifData.forEach((item: any) => {
              this.realm.create(
                "CatalogoCausaDiferencia",
                { id: item.id, descripcion: item.descripcion },
                Realm.UpdateMode.Modified,
              );
              totalGuardados++;
            });
          });
          console.log(`[CatalogosPedidosSyncTask] Causas diferencia: ${causasDifData.length} registros`);
        }
      }

      if (causasNoAtRes.ok) {
        const causasNoAtData = await causasNoAtRes.json();
        if (Array.isArray(causasNoAtData)) {
          totalLeidos += causasNoAtData.length;
          this.realm.write(() => {
            causasNoAtData.forEach((item: any) => {
              this.realm.create(
                "CatalogoCausaNoAtencion",
                { id: item.id, descripcion: item.descripcion },
                Realm.UpdateMode.Modified,
              );
              totalGuardados++;
            });
          });
          console.log(`[CatalogosPedidosSyncTask] Causas no atención: ${causasNoAtData.length} registros`);
        }
      }

      console.log(`[CatalogosPedidosSyncTask] Total: ${totalGuardados} registros guardados`);

      return {
        success: true,
        registrosLeidos: totalLeidos,
        registrosGuardados: totalGuardados,
      };
    } catch (error) {
      console.error("[CatalogosPedidosSyncTask] Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }
}
