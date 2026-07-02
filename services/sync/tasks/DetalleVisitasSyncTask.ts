import Realm from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";

/**
 * Tarea de sincronización para enviar DetalleVisitas al servidor
 * Este task envía los registros pendientes de sincronizar al endpoint
 */
export class DetalleVisitasSyncTask extends SyncTask {
  protected idUsuario: number;

  constructor(realm: Realm, syncLogId: string, idUsuario: number) {
    super(realm, syncLogId);
    this.idUsuario = idUsuario;
  }

  getTableName(): string {
    return "DetalleVisitas";
  }
  // 'https://api.cbinformatica.net:9031/api/MovilesVentas/sp_MovilesVisitasArrastreJSON?idUsuario=0' \

  getEndpoint(): string {
    return `https://api.cbinformatica.net:9031/api/MovilesVentas/sp_MovilesVisitasArrastreJSON?idUsuario=${this.idUsuario}`;
  }

  /**
   * Formatea una fecha a string en formato YYYY-MM-DD HH:mm:ss (horario México)
   * Mantiene la hora local del dispositivo (que ya está en horario México)
   */
  private formatDateForMexico(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
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

      const detallesVisitas = this.realm.objects("DetalleVisitas").filtered("sincronizado == false");

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
        fechaInicio: detalle.fechaInicio ? this.formatDateForMexico(detalle.fechaInicio) : null,
        fechaFin: detalle.fechaFin ? this.formatDateForMexico(detalle.fechaFin) : null,
        idCliente: detalle.idCliente,
        idUsuario: detalle.idUsuario,
        idRuta: detalle.idRuta,
        tipo: detalle.tipoVisita,
      }));

      console.log(`[DetalleVisitasSyncTask] Enviando ${visitasArray.length} visitas al servidor`);

      const response = await this.fetchWithTimeout(this.getEndpoint(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          accept: "application/octet-stream",
        },
        body: JSON.stringify(visitasArray),
      });
      console.log(`[DetalleVisitasSyncTask] Response status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        console.error("[DetalleVisitasSyncTask] Error response:", errorText);
        throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
      }

      const nowSync = this.getMexicoNow();
      this.realm.write(() => {
        for (const detalle of detallesVisitas) {
          (detalle as any).syncedAt = nowSync;
          (detalle as any).sincronizado = true;
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
