import Realm, { UpdateMode } from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";
import { InventarioSchema } from "../../RealmSchemas";

/**
 * Tarea de sincronización para la tabla Inventario
 */
export class InventarioSyncTask extends SyncTask {
  constructor(realm: Realm, syncLogId: string, sucursal: number) {
    super(realm, syncLogId, sucursal);
  }

  getTableName(): string {
    return "Inventario";
  }

  getEndpoint(): string {
    const nowMexico = this.getMexicoNow();
    const fechaMovto = new Date(nowMexico.getTime() - nowMexico.getTimezoneOffset() * 60000).toISOString();

    return `https://cbinfo.no-ip.info:9031/api/MovilesVentas/inventario/erp-movil?sucursal=${encodeURIComponent(
      String(this.sucursal)
    )}&fechaMovto=${encodeURIComponent(fechaMovto)}`;
  }
  // fechaMovto
  getPriority(): number {
    return 5; // Quinta prioridad
  }

  getDependencies(): string[] {
    return ["Productos"]; // Depende de productos para validar claves
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      console.log(`[InventarioSyncTask] Obteniendo inventario para sucursal ${this.sucursal}...`);

      const response = await fetch(this.getEndpoint());
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const inventario = await response.json();
      console.log({ inventario });
      console.log({ inventarioLength: inventario.length });
      const registrosLeidos = inventario.length;
      const nowMexico = this.getMexicoNow();
      let registrosGuardados = 0;
      let registrosActualizados = 0;

      console.log(`[InventarioSyncTask] Leídos ${registrosLeidos} registros de inventario`);

      // Sincronizar con Realm
      let registrosEliminados = 0;
      this.realm.write(() => {
        // 1. Crear/actualizar registros del servidor
        for (const item of inventario) {
          const existing = this.realm.objectForPrimaryKey("Inventario", item.id);

          const inventarioData = {
            ...item,
            sucursal: this.sucursal,
            syncedAt: item.fechaArrastre ? new Date(item.fechaArrastre) : nowMexico,
            syncedAr: nowMexico,
          };
          if (existing) {
            this.realm.create("Inventario", inventarioData, UpdateMode.Modified);
            registrosActualizados++;
          } else {
            this.realm.create("Inventario", inventarioData);
            registrosGuardados++;
          }
        }

        // 2. Eliminar registros que ya no existen en el servidor
        // Obtener todos los registros locales de esta sucursal
        const inventarioLocal = this.realm.objects("Inventario").filtered("sucursal == $0", this.sucursal);

        // Crear Set con los IDs del servidor para búsqueda rápida
        const idsServidor = new Set(inventario.map((item: any) => item.id));

        // Encontrar y eliminar registros que no están en el servidor
        const registrosAEliminar: any[] = [];
        inventarioLocal.forEach((item: any) => {
          if (!idsServidor.has(item.id)) {
            registrosAEliminar.push(item);
          }
        });

        registrosAEliminar.forEach((item) => {
          console.log(
            `[InventarioSyncTask] Eliminando registro obsoleto: id=${item.id}, claveProd=${item.claveProd}, descripcion=${item.descripcion}`
          );
          this.realm.delete(item);
          registrosEliminados++;
        });
      });

      console.log(
        `[InventarioSyncTask] Guardados: ${registrosGuardados}, Actualizados: ${registrosActualizados}, Eliminados: ${registrosEliminados}`
      );

      return {
        success: true,
        registrosLeidos,
        registrosGuardados,
        registrosActualizados,
        detalles: {
          totalProcesados: registrosGuardados + registrosActualizados,
          sucursal: this.sucursal,
        },
      };
    } catch (error) {
      console.error("[InventarioSyncTask] Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }
}
