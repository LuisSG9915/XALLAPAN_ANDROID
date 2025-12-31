import Realm from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";

/**
 * Tarea de sincronización para enviar DetalleVisitas al servidor
 * Este task envía los registros pendientes de sincronizar al endpoint
 */
export class DetalleVisitasSyncTask extends SyncTask {
  private idUsuario: number;

  constructor(realm: Realm, syncLogId: string, idUsuario: number) {
    super(realm, syncLogId);
    this.idUsuario = idUsuario;
  }

  getTableName(): string {
    return "DetalleVisitas";
  }

  getEndpoint(): string {
    return `https://cbinfo.no-ip.info:9031/api/MovilesVentas/sp_MovilesVisitasArrastreJSON?idUsuario=${this.idUsuario}`;
  }

  getPriority(): number {
    return 8;
  }

  getDependencies(): string[] {
    return [];
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      console.log(`[DetalleVisitasSyncTask] Enviando visitas pendientes...`);

      const nowMexico = this.getMexicoNow();
      const fiveMinutesAgo = new Date(nowMexico.getTime() - 5 * 60 * 1000);

      const detallesVisitas = this.realm.objects("DetalleVisitas").filtered("syncedAt < $0", fiveMinutesAgo);

      if (detallesVisitas.length === 0) {
        console.log(`[DetalleVisitasSyncTask] No hay visitas pendientes de sincronizar`);
        return {
          success: true,
          registrosLeidos: 0,
          registrosGuardados: 0,
          registrosActualizados: 0,
        };
      }

      const visitasArray = Array.from(detallesVisitas).map((detalle: any) => ({
        fechaInicio: detalle.fechaInicio ? detalle.fechaInicio.toISOString() : null,
        fechaFin: detalle.fechaFin ? detalle.fechaFin.toISOString() : null,
        idCliente: detalle.idCliente,
        idUsuario: detalle.idUsuario,
        idRuta: detalle.idRuta,
      }));

      console.log(`[DetalleVisitasSyncTask] Enviando ${visitasArray.length} visitas al servidor`);

      const response = await fetch(this.getEndpoint(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          accept: "application/octet-stream",
        },
        body: JSON.stringify(visitasArray),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const nowSync = this.getMexicoNow();
      this.realm.write(() => {
        for (const detalle of detallesVisitas) {
          (detalle as any).syncedAt = nowSync;
        }
      });

      console.log(`[DetalleVisitasSyncTask] ✅ ${visitasArray.length} visitas sincronizadas exitosamente`);

      return {
        success: true,
        registrosLeidos: visitasArray.length,
        registrosGuardados: 0,
        registrosActualizados: visitasArray.length,
        detalles: {
          visitasEnviadas: visitasArray.length,
        },
      };
    } catch (error) {
      console.error("[DetalleVisitasSyncTask] Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }
}
