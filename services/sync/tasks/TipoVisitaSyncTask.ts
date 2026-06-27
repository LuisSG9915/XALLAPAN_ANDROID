import Realm from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";

/**
 * Tarea de sincronización para TipoVisita
 * Sincroniza los tipos de visita desde el servidor
 */
export class TipoVisitaSyncTask extends SyncTask {
  constructor(realm: Realm, syncLogId: string) {
    super(realm, syncLogId);
  }

  getTableName(): string {
    return "TipoVisita";
  }

  getEndpoint(): string {
    return "https://api.cbinformatica.net:9031/api/MovilesVentas/visitas/tipo";
  }

  getPriority(): number {
    return 2; // Alta prioridad, se necesita antes de las visitas
  }

  getDependencies(): string[] {
    return [];
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      console.log(`[TipoVisitaSyncTask] Sincronizando tipos de visita...`);

      const response = await this.fetchWithTimeout(this.getEndpoint(), {
        headers: {
          accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const tiposVisita = await response.json();
      console.log(`[TipoVisitaSyncTask] Recibidos ${tiposVisita.length} tipos de visita`);

      if (!Array.isArray(tiposVisita)) {
        throw new Error("La respuesta no es un array");
      }

      let registrosGuardados = 0;
      let registrosActualizados = 0;

      this.realm.write(() => {
        // Limpiar tipos de visita existentes
        const existingTipos = this.realm.objects("TipoVisita");
        this.realm.delete(existingTipos);

        // Insertar todos los tipos de visita
        tiposVisita.forEach((tipo: any) => {
          this.realm.create("TipoVisita", {
            id: tipo.id,
            descripcion: tipo.descripcion,
          });
          registrosGuardados++;
        });
      });

      console.log(`[TipoVisitaSyncTask] ✅ Sincronización completa: ${registrosGuardados} tipos guardados`);

      return {
        success: true,
        registrosLeidos: tiposVisita.length,
        registrosGuardados,
        registrosActualizados,
      };
    } catch (error) {
      console.error("[TipoVisitaSyncTask] ❌ Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }
}
