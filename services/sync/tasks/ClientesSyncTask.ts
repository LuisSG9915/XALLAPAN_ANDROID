import Realm, { UpdateMode } from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";
import { ClienteFullSchema } from "../../RealmSchemas";

/**
 * Tarea de sincronización para la tabla Clientes
 */
export class ClientesSyncTask extends SyncTask {
  getTableName(): string {
    return "Clientes";
  }

  getEndpoint(sucursal: number = 0): string {
    return `https://cbinfo.no-ip.info:9031/api/MovilesVentas/clientes/full?sucursal=${sucursal}`;
  }

  getPriority(): number {
    return 4; // Cuarta prioridad
  }

  getDependencies(): string[] {
    return []; // Sin dependencias
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      const sucursal = this.sucursal || 1;
      console.log("[ClientesSyncTask] Obteniendo clientes desde API (sucursal: " + sucursal + ")...");

      const response = await fetch(this.getEndpoint(sucursal));
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const clientes = await response.json();
      const registrosLeidos = clientes.length;
      const nowMexico = this.getMexicoNow();
      let registrosGuardados = 0;
      let registrosActualizados = 0;

      console.log(`[ClientesSyncTask] Leídos ${registrosLeidos} clientes`);

      // Sincronizar con Realm
      this.realm.write(() => {
        for (const cliente of clientes) {
          const existing = this.realm.objectForPrimaryKey("ClienteFull", cliente.id);

          const clienteData = {
            id: cliente.id,
            nombre: cliente.nombre,
            longitud: cliente.longitud,
            latitud: cliente.latitud,
            idGrupo: cliente.idGrupo,
            credito: cliente.credito,
            facturacionMovil: cliente.facturacionMovil,
            fechaAct: cliente.fecha_act ? new Date(cliente.fecha_act) : null,
            correoFactura: cliente.correo_factura || null,
            domicilio: cliente.domicilio || null,
            idEmpresa: cliente.idEmpresa ?? null,
            syncedAt: new Date(),
            syncedAr: cliente.fechaLog ? new Date(cliente.fechaLog) : null,
            listaPrecio: cliente.listaPrecio,
          };

          if (existing) {
            this.realm.create("ClienteFull", clienteData, UpdateMode.Modified);
            registrosActualizados++;
          } else {
            this.realm.create("ClienteFull", clienteData);
            registrosGuardados++;
          }
        }
      });

      console.log(`[ClientesSyncTask] Guardados: ${registrosGuardados}, Actualizados: ${registrosActualizados}`);

      return {
        success: true,
        registrosLeidos,
        registrosGuardados,
        registrosActualizados,
        detalles: {
          totalProcesados: registrosGuardados + registrosActualizados,
        },
      };
    } catch (error) {
      console.error("[ClientesSyncTask] Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }
}
