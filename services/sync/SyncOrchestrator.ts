import Realm from "realm";
import { SyncTask, SyncTaskResult, SyncProgress } from "./SyncTask";
import { UsuariosSyncTask } from "./tasks/UsuariosSyncTask";
import { ProductosSyncTask } from "./tasks/ProductosSyncTask";
// ProductosIncrementalSyncTask deshabilitada: el endpoint /productos/incremental devuelve 404.
// Los productos se sincronizan por completo con ProductosSyncTask (/productos/full).
// import { ProductosIncrementalSyncTask } from "./tasks/ProductosIncrementalSyncTask";
import { PreciosSyncTask } from "./tasks/PreciosSyncTask";
import { PreciosPromoSyncTask } from "./tasks/PreciosPromoSyncTask";
import { ClientesSyncTask } from "./tasks/ClientesSyncTask";
import { InventarioSyncTask } from "./tasks/InventarioSyncTask";
import { CarteraSyncTask } from "./tasks/CarteraSyncTask";
import { VentasSyncTask } from "./tasks/VentasSyncTask";
import { KitsSyncTask } from "./tasks/KitsSyncTask";
import { KitIntercambioSyncTask } from "./tasks/KitIntercambioSyncTask";
import { VisitaSyncTask } from "./tasks/VisitaSyncTask";
import { DetalleVisitasSyncTask } from "./tasks/DetalleVisitasSyncTask";
import { VisitasIncrementalSucursalPiboteSyncTask } from "./tasks/VisitasIncrementalSucursalPiboteSyncTask";
import { VisitasVisitadosSucursalSyncTask } from "./tasks/VisitasVisitadosSucursalSyncTask";
import { TipoVisitaSyncTask } from "./tasks/TipoVisitaSyncTask";
import { VentasArrastreSyncTask } from "./tasks/VentasArrastreSyncTask";
import { InventarioEnvaseSyncTask } from "./tasks/InventarioEnvaseSyncTask";
import { ReubicacionSyncTask } from "./tasks/ReubicacionSyncTask";
import { InventarioEnvasesHistorialSyncTask } from "./tasks/InventarioEnvasesHistorialSyncTask";
import { FormaPagoSyncTask } from "./tasks/FormaPagoSyncTask";
import { CiasSyncTask } from "./tasks/CiasSyncTask";

/**
 * Orquestador de sincronización
 * Maneja la ejecución de tareas con dependencias y prioridades
 */
export class SyncOrchestrator {
  private realm: Realm;
  private syncLogId: string;
  private sucursal: number;
  private idUsuario: number;
  private onProgress?: (progress: SyncProgress) => void;

  constructor(
    realm: Realm,
    syncLogId: string,
    sucursal: number,
    idUsuario: number,
    onProgress?: (progress: SyncProgress) => void,
  ) {
    this.realm = realm;
    this.syncLogId = syncLogId;
    this.sucursal = sucursal;
    this.idUsuario = idUsuario;
    this.onProgress = onProgress;
  }

  /**
   * Crea todas las tareas de sincronización
   */
  private createAllTasks(): SyncTask[] {
    const tasks = [
      new CiasSyncTask(this.realm, this.syncLogId), // Compañías - alta prioridad
      new FormaPagoSyncTask(this.realm, this.syncLogId, this.sucursal),
      new UsuariosSyncTask(this.realm, this.syncLogId),
      new ProductosSyncTask(this.realm, this.syncLogId),
      // Incremental deshabilitada (endpoint inexistente, 404). Productos vía ProductosSyncTask (/full).
      new KitsSyncTask(this.realm, this.syncLogId),
      new KitIntercambioSyncTask(this.realm, this.syncLogId),
      new PreciosPromoSyncTask(this.realm, this.syncLogId),
      new PreciosSyncTask(this.realm, this.syncLogId),
      new ClientesSyncTask(this.realm, this.syncLogId, this.sucursal),
      new InventarioSyncTask(this.realm, this.syncLogId, this.sucursal),
      // new CarteraSyncTask(this.realm, this.syncLogId),
      new VentasSyncTask(this.realm, this.syncLogId, this.sucursal),
      new TipoVisitaSyncTask(this.realm, this.syncLogId),
      new VisitaSyncTask(this.realm, this.syncLogId),
      // Descarga las visitas de la sucursal desde el endpoint pivote
      new VisitasIncrementalSucursalPiboteSyncTask(this.realm, this.syncLogId, this.sucursal, this.idUsuario),
      new DetalleVisitasSyncTask(this.realm, this.syncLogId, this.idUsuario),
      // Descarga las visitas ya visitadas de la sucursal desde el servidor
      new VisitasVisitadosSucursalSyncTask(this.realm, this.syncLogId, this.sucursal, this.idUsuario),
      // Arrastre de envases antes de ventas - prioridad 95
      new InventarioEnvaseSyncTask(this.realm, this.syncLogId, this.sucursal, this.idUsuario),
      // Historial de envases - descarga desde servidor
      new InventarioEnvasesHistorialSyncTask(this.realm, this.syncLogId, this.sucursal),
      // Reubicaciones - prioridad 96
      new ReubicacionSyncTask(this.realm, this.syncLogId, this.sucursal, this.idUsuario),
      // Arrastre al final - prioridad 100
      new VentasArrastreSyncTask(this.realm, this.syncLogId, this.sucursal, this.idUsuario),
    ];

    // Asignar idUsuario a todas las tareas
    tasks.forEach((task) => {
      (task as any).idUsuario = this.idUsuario;
    });

    return tasks as SyncTask[];
  }

  /**
   * Ordena las tareas por prioridad y dependencias
   */
  private sortTasksByDependencies(tasks: SyncTask[]): SyncTask[] {
    const taskMap = new Map<string, SyncTask>();
    const completed = new Set<string>();
    const sorted: SyncTask[] = [];

    // Crear mapa de tareas
    for (const task of tasks) {
      taskMap.set(task.getTableName(), task);
    }

    // Función recursiva para agregar tareas
    const addTask = (task: SyncTask): void => {
      const tableName = task.getTableName();

      if (completed.has(tableName)) {
        return;
      }

      // Primero agregar dependencias
      for (const dep of task.getDependencies()) {
        const depTask = taskMap.get(dep);
        if (depTask && !completed.has(dep)) {
          addTask(depTask);
        }
      }

      // Luego agregar la tarea actual
      sorted.push(task);
      completed.add(tableName);
    };

    // Ordenar por prioridad inicial
    const tasksByPriority = [...tasks].sort((a, b) => a.getPriority() - b.getPriority());

    // Construir orden final con dependencias
    for (const task of tasksByPriority) {
      addTask(task);
    }

    return sorted;
  }

  /**
   * Ejecuta todas las tareas de sincronización
   */
  async executeAll(): Promise<{
    success: boolean;
    results: Map<string, SyncTaskResult>;
    errors: string[];
  }> {
    const tasks = this.createAllTasks();
    const sortedTasks = this.sortTasksByDependencies(tasks);
    const results = new Map<string, SyncTaskResult>();
    const errors: string[] = [];

    console.log(`[SyncOrchestrator] Iniciando sincronización de ${sortedTasks.length} tareas`);
    console.log(
      `[SyncOrchestrator] Orden de ejecución:`,
      sortedTasks.map((t) => t.getTableName()),
    );

    let current = 0;
    const total = sortedTasks.length;

    for (const task of sortedTasks) {
      current++;

      // Notificar progreso
      if (this.onProgress) {
        this.onProgress({
          current,
          total,
          entity: task.getTableName(),
          status: "syncing",
          message: `Sincronizando ${task.getTableName()}...`,
        });
      }

      try {
        console.log(`[SyncOrchestrator] Ejecutando tarea: ${task.getTableName()}`);

        // Red de seguridad por tarea. El corte real de cada petición lo hace
        // fetchWithTimeout (1 min) dentro de la task; esto solo cubre cuelgues
        // que no sean de red (p. ej. un procesamiento local muy largo).
        const TIMEOUT_MS = 90000;
        let timeoutId: number | null = null;

        const timeoutPromise = new Promise<SyncTaskResult>((resolve) => {
          timeoutId = setTimeout(() => {
            const segundos = Math.round(TIMEOUT_MS / 1000);
            console.warn(
              `[SyncOrchestrator] ⏱️ ${task.getTableName()} excedió ${segundos}s, se omite y se continúa con la siguiente tarea`,
            );
            resolve({
              success: false,
              error: `Tiempo de espera agotado (${segundos}s): la tarea tardó demasiado y se omitió. Revisa tu conexión.`,
              timedOut: true,
            });
          }, TIMEOUT_MS);
        });

        const taskPromise = task.executeWithLogging();
        const result = await Promise.race([taskPromise, timeoutPromise]);

        // Cancelar el timeout si la tarea terminó antes
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        results.set(task.getTableName(), result);

        if (!result.success) {
          const errorMsg = result.error || "Error desconocido";
          errors.push(`${task.getTableName()}: ${errorMsg}`);
          console.error(`[SyncOrchestrator] Error en ${task.getTableName()}:`, errorMsg);
        } else {
          console.log(`[SyncOrchestrator] Tarea ${task.getTableName()} completada exitosamente`);
        }

        // Notificar estado final de esta tarea
        if (this.onProgress) {
          this.onProgress({
            current,
            total,
            entity: task.getTableName(),
            status: result.success ? "success" : "error",
            message: result.success
              ? `${task.getTableName()} sincronizado`
              : `Error en ${task.getTableName()}: ${result.error || "Error desconocido"}`,
          });
        }
      } catch (error) {
        const errorResult: SyncTaskResult = {
          success: false,
          error: error instanceof Error ? error.message : "Error desconocido",
        };

        results.set(task.getTableName(), errorResult);
        errors.push(`${task.getTableName()}: ${errorResult.error}`);

        console.error(`[SyncOrchestrator] Error crítico en ${task.getTableName()}:`, error);

        // Notificar error
        if (this.onProgress) {
          this.onProgress({
            current,
            total,
            entity: task.getTableName(),
            status: "error",
            message: `Error crítico en ${task.getTableName()}: ${errorResult.error}`,
          });
        }
      }

      // Pequeña pausa entre tareas para no sobrecargar la API
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 100));
    }

    const success = errors.length === 0;

    console.log(`[SyncOrchestrator] Sincronización completada. Éxito: ${success}, Errores: ${errors.length}`);

    if (errors.length > 0) {
      console.log(`[SyncOrchestrator] Resumen de errores:`, errors);
    }

    return {
      success,
      results,
      errors,
    };
  }

  /**
   * Ejecuta una tarea específica
   */
  async executeTask(tableName: string): Promise<SyncTaskResult | null> {
    const tasks = this.createAllTasks();
    const task = tasks.find((t) => t.getTableName() === tableName);

    if (!task) {
      console.error(`[SyncOrchestrator] Tarea no encontrada: ${tableName}`);
      return null;
    }

    console.log(`[SyncOrchestrator] Ejecutando tarea individual: ${tableName}`);

    // Notificar progreso
    if (this.onProgress) {
      this.onProgress({
        current: 1,
        total: 1,
        entity: tableName,
        status: "syncing",
        message: `Sincronizando ${tableName}...`,
      });
    }

    const result = await task.executeWithLogging();

    // Notificar estado final
    if (this.onProgress) {
      this.onProgress({
        current: 1,
        total: 1,
        entity: tableName,
        status: result.success ? "success" : "error",
        message: result.success
          ? `${tableName} sincronizado`
          : `Error en ${tableName}: ${result.error || "Error desconocido"}`,
      });
    }

    return result;
  }
}
