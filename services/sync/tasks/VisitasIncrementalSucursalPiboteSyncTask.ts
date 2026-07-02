import Realm from "realm";
import { UpdateMode } from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";

/**
 * Tarea de sincronización para descargar las visitas de la sucursal desde el
 * endpoint full-incremental-sucursal-pibote.
 *
 * Crea un id compuesto por id + fecha y preserva el estado local 'visitado' si ya
 * estaba marcado en el dispositivo.
 */
export class VisitasIncrementalSucursalPiboteSyncTask extends SyncTask {
  constructor(realm: Realm, syncLogId: string, sucursal: number, idUsuario: number) {
    super(realm, syncLogId, sucursal, idUsuario);
  }

  getTableName(): string {
    return "VisitasIncrementalSucursalPibote";
  }

  getEndpoint(): string {
    return `https://api.cbinformatica.net:9031/api/MovilesVentas/visitas/full-incremental-sucursal-pibote/${this.sucursal}`;
  }

  getPriority(): number {
    return 9;
  }

  getDependencies(): string[] {
    return [];
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      console.log(`[VisitasIncrementalSucursalPibote] Descargando visitas pivote desde ${this.getEndpoint()}`);

      const response = await this.fetchWithTimeout(this.getEndpoint(), {
        headers: { accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} VisitasPivote`);
      }

      const visitasData = await response.json();
      const registrosLeidos = Array.isArray(visitasData) ? visitasData.length : 0;
      let registrosGuardados = 0;
      let registrosActualizados = 0;
      const nowMexico = this.getMexicoNow();

      this.realm.write(() => {
        for (const visita of visitasData) {
          const fechaVisita = visita.fecha ? new Date(visita.fecha) : new Date();
          const fechaStr = fechaVisita.toISOString().split("T")[0];
          const idCompuesto = `${visita.id}-${fechaStr}`;
          const existing = this.realm.objectForPrimaryKey("Visita", idCompuesto) as any;

          // Preservar estado local 'visitado' si ya estaba marcado
          const visitadoFinal =
            existing?.visitado === 1
              ? 1
              : typeof visita.visitado === "boolean"
              ? visita.visitado
                ? 1
                : 0
              : Number(visita.visitado);

          const visitaData: any = {
            id: idCompuesto,
            idOriginal: visita.id,
            idCliente: visita.idCliente,
            ruta: visita.ruta ?? "",
            fecha: fechaVisita,
            orden: Number(visita.orden),
            tipo: Number(visita.tipo),
            visitado: visitadoFinal,
            syncedAr: nowMexico.toISOString(),
          };

          if (existing) {
            this.realm.create("Visita", visitaData, UpdateMode.Modified);
            registrosActualizados++;
          } else {
            this.realm.create("Visita", visitaData);
            registrosGuardados++;
          }
        }
      });

      console.log(
        `[VisitasIncrementalSucursalPibote] ✅ leídos=${registrosLeidos}, guardados=${registrosGuardados}, actualizados=${registrosActualizados}`,
      );

      return {
        success: true,
        registrosLeidos,
        registrosGuardados,
        registrosActualizados,
      };
    } catch (error) {
      console.error("[VisitasIncrementalSucursalPibote] Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }
}
