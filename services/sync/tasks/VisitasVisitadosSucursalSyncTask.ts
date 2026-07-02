import Realm from "realm";
import { UpdateMode } from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";

/**
 * Tarea de sincronización para descargar las visitas ya visitadas de la sucursal
 * desde el endpoint full-incremental-sucursal-visitados.
 *
 * Reemplaza los registros del servidor locales (sincronizado == true) preservando
 * las visitas pendientes de enviar (sincronizado == false).
 */
export class VisitasVisitadosSucursalSyncTask extends SyncTask {
  constructor(realm: Realm, syncLogId: string, sucursal: number, idUsuario: number) {
    super(realm, syncLogId, sucursal, idUsuario);
  }

  getTableName(): string {
    return "VisitasVisitadosSucursal";
  }

  getEndpoint(): string {
    return `https://api.cbinformatica.net:9031/api/MovilesVentas/visitas/full-incremental-sucursal-visitados/${this.sucursal}`;
  }

  getPriority(): number {
    return 9;
  }

  getDependencies(): string[] {
    return [];
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      console.log(`[VisitasVisitadosSucursal] Descargando visitas de sucursal desde ${this.getEndpoint()}`);

      const response = await this.fetchWithTimeout(this.getEndpoint(), {
        headers: { accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} VisitasVisitados`);
      }

      const visitadosData = await response.json();
      const registros = Array.isArray(visitadosData) ? visitadosData : [];
      const registrosLeidos = registros.length;
      const nowMexico = this.getMexicoNow();

      this.realm.write(() => {
        // Eliminar información anterior proveniente del servidor (ya sincronizada),
        // preservando los registros locales pendientes de enviar (sincronizado == false)
        const sincronizados = this.realm.objects("DetalleVisitas").filtered("sincronizado == true");
        this.realm.delete(sincronizados);

        // Insertar la lista autoritativa del servidor
        for (const v of registros) {
          const fechaInicio = v.fechaInicio ? new Date(v.fechaInicio) : null;
          const fechaFin = v.fechaFin ? new Date(v.fechaFin) : null;

          this.realm.create(
            "DetalleVisitas",
            {
              id: String(v.id),
              fechaInicio,
              fechaFin,
              idCliente: v.idCliente != null ? Number(v.idCliente) : null,
              idUsuario: v.idUsuario != null ? Number(v.idUsuario) : null,
              idRuta: v.idRuta != null ? Number(v.idRuta) : null,
              tipoVisita: v.tipoVisita != null ? Number(v.tipoVisita) : null,
              agenda: v.agenda != null ? Number(v.agenda) : null,
              syncedAt: nowMexico,
              sincronizado: true,
            },
            UpdateMode.Modified,
          );
        }
      });

      console.log(`[VisitasVisitadosSucursal] ✅ ${registrosLeidos} registros insertados`);

      return {
        success: true,
        registrosLeidos,
        registrosGuardados: registrosLeidos,
        registrosActualizados: 0,
      };
    } catch (error) {
      console.error("[VisitasVisitadosSucursal] Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }
}
