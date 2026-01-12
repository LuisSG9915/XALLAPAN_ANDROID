import Realm from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";
import VisitaSyncService from "../../VisitaSyncService";

export class VisitaSyncTask extends SyncTask {
  private visitaService: VisitaSyncService;

  constructor(realm: Realm, syncLogId: string, sucursal: number) {
    super(realm, syncLogId, sucursal);
    this.visitaService = VisitaSyncService.getInstance();
  }

  getTableName(): string {
    return "visitas";
  }

  getEndpoint(): string {
    return "https://cbinfo.no-ip.info:9031/api/MovilesVentas/visitas/full";
  }

  getPriority(): number {
    return 10; // Baja prioridad - sincronizar al final
  }

  getDependencies(): string[] {
    return []; // Las visitas no tienen dependencias
  }

  async execute(): Promise<SyncTaskResult> {
    const sucursal = this.sucursal || 1;
    // Sincronizar visitas de hoy
    const result = await this.visitaService.syncByDate(new Date(), sucursal);

    if (!result.success) {
      throw new Error(result.error || "Error al sincronizar visitas");
    }

    return result;
  }
}
