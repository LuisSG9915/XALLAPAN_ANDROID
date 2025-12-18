import Realm, { UpdateMode } from "realm";
import { ALL_SCHEMAS, SyncLogSchema } from "./RealmSchemas";
import { SyncProgress } from "./sync/SyncTask";
import { SyncOrchestrator } from "./sync/SyncOrchestrator";

export type SyncProgressCallback = (progress: SyncProgress) => void;

class FullSyncService {
  private realm: Realm | null = null;
  private isInitialized = false;
  private apiBaseUrl = "https://cbinfo.no-ip.info:9031";

  async initialize(): Promise<void> {
    if (this.isInitialized && this.realm && !this.realm.isClosed) {
      return;
    }

    try {
      this.realm = await Realm.open({
        path: "FullSyncDB",
        schema: ALL_SCHEMAS,
        schemaVersion: 7, // v7: latitud y longitud en Venta
        onMigration: (oldRealm: Realm, newRealm: Realm) => {
          const newCartera = newRealm.objects("Cartera");
          for (let i = 0; i < newCartera.length; i++) {
            const obj: any = newCartera[i];
            if (typeof obj.cobrado === "undefined") {
              obj.cobrado = false;
            }
          }
        },
      });

      this.isInitialized = true;
      console.log("✅ FullSyncService inicializado correctamente (v5 con SyncTableLog)");
    } catch (error) {
      console.error("❌ Error al inicializar FullSyncService:", error);
      throw error;
    }
  }

  /**
   * Obtiene la última fecha syncedAr (horario México) de una tabla dada.
   * Si no hay registros o todas son null, regresa null.
   */
  private getLastSyncedAr(tableName: string): Date | null {
    if (!this.realm) return null;

    const collection: any = this.realm.objects(tableName);
    if (!collection || collection.length === 0) return null;

    const maxDate = collection.max("syncedAr") as Date | null;
    return maxDate || null;
  }

  /**
   * Normaliza un Date a un string "YYYY-MM-DD HH:mm" para fechaInicial.
   */
  private formatDateTimeForApi(date: Date): string {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const mi = String(date.getMinutes()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  }

  /**
   * Normaliza un Date a un string "YYYY-MM-DD" para fechaInicial sin hora.
   */
  private formatDateForApi(date: Date): string {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  /**
   * Obtiene la fecha/hora actual.
   * El dispositivo ya está en hora de México, no se requiere conversión.
   */
  private getMexicoNow(): Date {
    return new Date();
  }

  /**
   * Envía ventas locales pendientes al servidor (arrastre).
   * Se ejecuta automáticamente antes de sincronizaciones para subir ventas offline.
   * Wrapper del método público sendPendingVentasToServer.
   */
  private async sendPendingVentasArrastre(
    sucursal: number,
    idUsuario: number
  ): Promise<{ success: boolean; sent: number }> {
    console.log("[FullSync] Llamando a sendPendingVentasToServer desde sincronización periódica");
    const result = await this.sendPendingVentasToServer(sucursal, idUsuario);
    return { success: result.success, sent: result.sent };
  }

  /**
   * Envía ventas pendientes con timeout de 3 segundos.
   * Usado desde SalesScreen para no bloquear el proceso de venta.
   * Si tarda más de 3 segundos, se omite y se enviará en la próxima sincronización.
   */
  async sendPendingVentasWithTimeout(
    sucursal: number,
    idUsuario: number,
    timeoutMs: number = 3000
  ): Promise<{ success: boolean; sent: number; timedOut?: boolean; error?: string }> {
    console.log(`[FullSync] Enviando ventas con timeout de ${timeoutMs}ms`);

    const timeoutPromise = new Promise<{ success: boolean; sent: number; timedOut: boolean }>((resolve) => {
      setTimeout(() => {
        console.log("[FullSync] ⏱️ Timeout alcanzado, omitiendo arrastre");
        resolve({ success: true, sent: 0, timedOut: true });
      }, timeoutMs);
    });

    const sendPromise = this.sendPendingVentasToServer(sucursal, idUsuario).then((result) => ({
      ...result,
      timedOut: false,
    }));

    try {
      const result = await Promise.race([sendPromise, timeoutPromise]);

      if (result.timedOut) {
        console.log("[FullSync] Arrastre omitido por timeout, se enviará en próxima sincronización");
      }

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Error desconocido";
      console.error("[FullSync] Error en arrastre con timeout:", error);
      return { success: false, sent: 0, error: errorMsg };
    }
  }

  /**
   * Sincronización INCREMENTAL para background (cada 3 minutos).
   *
   * Usa los nuevos endpoints basados en fechaInicial, tomando como referencia
   * la fecha máxima de syncedAr (horario México) en cada tabla.
   *
   * Tablas cubiertas:
   * - Clientes  -> /api/MovilesVentas/clientes?fechaInicial=YYYY-MM-DD HH:mm
   * - Precios   -> /api/MovilesVentas/precios?fechaInicial=YYYY-MM-DD HH:mm
   * - Cartera   -> /api/MovilesVentas/cartera?fechaInicial=YYYY-MM-DD
   * - Ventas    -> /api/MovilesVentas/ventas-erp-movil?fechaInicial=YYYY-MM-DD HH:mm&sucursal=...
   */
  async syncIncremental(
    sucursal: number = 1,
    onProgress?: SyncProgressCallback,
    idUsuario?: number
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.realm) {
      throw new Error("Realm no inicializado");
    }

    // PASO 1: Enviar ventas pendientes al servidor antes de sincronizar
    if (idUsuario) {
      console.log("[FullSync] Enviando ventas pendientes antes de sincronización incremental...");
      const ventasResult = await this.sendPendingVentasArrastre(sucursal, idUsuario);
      if (ventasResult.success && ventasResult.sent > 0) {
        console.log(`[FullSync] ✅ ${ventasResult.sent} ventas enviadas antes de sincronizar`);
      } else if (!ventasResult.success) {
        console.warn("[FullSync] ⚠️ No se pudieron enviar ventas pendientes, continuando con sincronización");
      }
    }

    // Crear SyncLog principal específico para incremental
    const syncLogId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const fechaInicio = new Date();

    this.realm.write(() => {
      this.realm!.create("SyncLog", {
        id: syncLogId,
        fechaInicio,
        exitoso: true,
        tipo: "incremental",
      } as any);
    });

    // console.log(
    //   `[FullSyncService] Iniciando sincronización incremental (ID: ${syncLogId})`,
    // );

    const errors: string[] = [];
    const nowMexico = this.getMexicoNow();

    const notify = (
      entity: string,
      current: number,
      total: number,
      status: SyncProgress["status"],
      message: string
    ) => {
      if (onProgress) {
        onProgress({ current, total, entity, status, message });
      }
    };

    // Tipo para resultado de tarea incremental
    type IncrementalTaskResult = {
      tabla: string;
      endpoint: string;
      registrosLeidos: number;
      registrosGuardados: number;
      registrosActualizados: number;
    };

    // Orden fijo de tablas incrementales
    const tasks: { name: string; run: () => Promise<IncrementalTaskResult> }[] = [
      {
        name: "ClientesIncremental",
        run: async () => {
          const tableName = "ClienteFull";
          const last = this.getLastSyncedAr(tableName) || new Date(0);
          const fechaInicial = this.formatDateTimeForApi(last);
          const url = `${this.apiBaseUrl}/api/MovilesVentas/clientes?fechaInicial=${encodeURIComponent(fechaInicial)}`;

          // console.log('[Incremental] Clientes desde', fechaInicial, url);

          const response = await fetch(url, {
            headers: { accept: "application/octet-stream" },
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} Clientes`);
          }

          const clientes = await response.json();
          const registrosLeidos = Array.isArray(clientes) ? clientes.length : 0;
          let registrosGuardados = 0;
          let registrosActualizados = 0;

          this.realm!.write(() => {
            for (const cliente of clientes) {
              const existing = this.realm!.objectForPrimaryKey("ClienteFull", cliente.id) as any;

              const clienteData: any = {
                id: cliente.id,
                nombre: cliente.nombre,
                longitud: cliente.longitud,
                latitud: cliente.latitud,
                idGrupo: cliente.idGrupo,
                credito: cliente.credito,
                facturacionMovil: cliente.facturacionMovil,
                fechaAct: cliente.fecha_act ? new Date(cliente.fecha_act) : null,
                correoFactura: cliente.correo_factura || null,
                syncedAt: new Date(),
                syncedAr: nowMexico,
              };

              if (existing) {
                this.realm!.create("ClienteFull", clienteData, UpdateMode.Modified);
                registrosActualizados++;
              } else {
                this.realm!.create("ClienteFull", clienteData);
                registrosGuardados++;
              }
            }
          });

          // console.log(
          //   `[Incremental] Clientes leídos=${registrosLeidos}, guardados=${registrosGuardados}, actualizados=${registrosActualizados}`,
          // );

          return {
            tabla: tableName,
            endpoint: url,
            registrosLeidos,
            registrosGuardados,
            registrosActualizados,
          };
        },
      },
      {
        name: "PreciosIncremental",
        run: async () => {
          const tableName = "Precio";
          const last = this.getLastSyncedAr(tableName) || new Date(0);
          const fechaInicial = this.formatDateTimeForApi(last);
          const url = `${this.apiBaseUrl}/api/MovilesVentas/precios?fechaInicial=${encodeURIComponent(fechaInicial)}`;

          console.log("[Incremental] Precios desde", fechaInicial, url);

          const response = await fetch(url, {
            headers: { accept: "application/octet-stream" },
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} Precios`);
          }

          const precios = await response.json();
          const registrosLeidos = Array.isArray(precios) ? precios.length : 0;
          let registrosGuardados = 0;
          let registrosActualizados = 0;

          this.realm!.write(() => {
            for (const precio of precios) {
              const existing = this.realm!.objectForPrimaryKey("Precio", precio.id) as any;

              const precioData: any = {
                ...precio,
                syncedAt: new Date(),
                syncedAr: nowMexico,
              };

              if (existing) {
                this.realm!.create("Precio", precioData, UpdateMode.Modified);
                registrosActualizados++;
              } else {
                this.realm!.create("Precio", precioData);
                registrosGuardados++;
              }
            }
          });

          console.log(
            `[Incremental] Precios leídos=${registrosLeidos}, guardados=${registrosGuardados}, actualizados=${registrosActualizados}`
          );

          return {
            tabla: tableName,
            endpoint: url,
            registrosLeidos,
            registrosGuardados,
            registrosActualizados,
          };
        },
      },
      // {
      //   name: "CarteraIncremental",
      //   run: async () => {
      //     const tableName = "Cartera";
      //     const last = this.getLastSyncedAr(tableName) || new Date(0);
      //     const fechaInicial = this.formatDateForApi(last);
      //     const url = `${this.apiBaseUrl}/api/MovilesVentas/cartera?fechaInicial=${encodeURIComponent(fechaInicial)}`;

      //     console.log("[Incremental] Cartera desde", fechaInicial, url);

      //     const response = await fetch(url, {
      //       headers: { accept: "application/octet-stream" },
      //     });
      //     if (!response.ok) {
      //       throw new Error(`HTTP ${response.status} Cartera`);
      //     }

      //     const cartera = await response.json();
      //     const registrosLeidos = Array.isArray(cartera) ? cartera.length : 0;
      //     let registrosGuardados = 0;
      //     let registrosActualizados = 0;

      //     this.realm!.write(() => {
      //       for (const item of cartera) {
      //         const existing = this.realm!.objectForPrimaryKey("Cartera", item.id) as any;

      //         const carteraData: any = {
      //           ...item,
      //           syncedAt: new Date(),
      //           syncedAr: nowMexico,
      //         };

      //         if (existing) {
      //           this.realm!.create("Cartera", carteraData, UpdateMode.Modified);
      //           registrosActualizados++;
      //         } else {
      //           this.realm!.create("Cartera", carteraData);
      //           registrosGuardados++;
      //         }
      //       }
      //     });

      //     // console.log(
      //     //   `[Incremental] Cartera leídos=${registrosLeidos}, guardados=${registrosGuardados}, actualizados=${registrosActualizados}`,
      //     // );

      //     return {
      //       tabla: tableName,
      //       endpoint: url,
      //       registrosLeidos,
      //       registrosGuardados,
      //       registrosActualizados,
      //     };
      //   },
      // },
      {
        name: "VentasIncremental",
        run: async () => {
          const tableName = "Venta";
          const last = this.getLastSyncedAr(tableName) || new Date(0);
          const fechaInicial = this.formatDateTimeForApi(last);
          const url = `${this.apiBaseUrl}/api/MovilesVentas/ventas/erp-movil?fechaInicial=${encodeURIComponent(
            fechaInicial
          )}&sucursal=${encodeURIComponent(String(sucursal))}`;

          console.log("[Incremental] Ventas desde", fechaInicial, url);

          const response = await fetch(url, {
            headers: { accept: "application/octet-stream" },
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} Ventas`);
          }

          const ventas = await response.json();
          console.log(ventas, "Ventas sincronizadas");
          const registrosLeidos = Array.isArray(ventas) ? ventas.length : 0;
          let registrosGuardados = 0;
          let registrosActualizados = 0;

          // Encontrar el registro con el ás alto del servidor
          let maxIdVenta = null;
          let maxId = 0;
          for (const venta of ventas) {
            if (venta.id && venta.id > maxId) {
              maxId = venta.id;
              maxIdVenta = venta;
            }
          }

          // Obtener el fechaLog del registro con el ID más alto
          const syncedArValue = maxIdVenta?.fecha ?? nowMexico;
          console.log(ventas);
          console.log(`[Incremental] ID más alto del servidor: ${maxId}, fechaLog: ${syncedArValue}`);

          this.realm!.write(() => {
            for (const venta of ventas) {
              const idMovil = venta.idMovil ?? null;

              // Primero verificar si existe por ID (primary key)
              const existingById = this.realm!.objectForPrimaryKey("Venta", venta.id);

              if (existingById) {
                // Actualizar registro existente por ID
                (existingById as any).noVenta = venta.noVenta;
                (existingById as any).cantProducto = venta.cantProducto;
                (existingById as any).precio = venta.precio;
                (existingById as any).importe = venta.importe;
                (existingById as any).folioFactura = venta.folioFactura;
                (existingById as any).facturacionMovil = venta.facturacionMovil;
                (existingById as any).syncedAt = venta.fechaLog ?? nowMexico;
                registrosActualizados++;
              } else {
                // Buscar por idMovil Y claveProd exactos en registros locales (id > 1700000000)
                const localVentas =
                  idMovil === null
                    ? []
                    : this.realm!.objects("Venta").filtered(
                        "idMovil == $0 AND claveProd == $1 AND id > 1700000000",
                        idMovil,
                        venta.claveProd
                      );

                if (localVentas.length > 0) {
                  // Actualizar solo los campos específicos en cada registro encontrado
                  for (const localVenta of localVentas) {
                    (localVenta as any).noVenta = venta.noVenta;
                    (localVenta as any).cantProducto = venta.cantProducto;
                    (localVenta as any).precio = venta.precio;
                    (localVenta as any).importe = venta.importe;
                    (localVenta as any).folioFactura = venta.folioFactura;
                    (localVenta as any).facturacionMovil = venta.facturacionMovil;
                    (localVenta as any).syncedAt = venta.fechaLog ?? nowMexico;
                    registrosActualizados++;
                  }
                } else {
                  // Crear registro porque no existe ni por ID ni por idMovil
                  this.realm!.create("Venta", {
                    id: venta.id,
                    idMovil: venta.idMovil ?? null,
                    sucursal: venta.sucursal ?? null,
                    noVenta: venta.noVenta ?? null,
                    claveProd: venta.claveProd ?? null,
                    nombreProducto: venta.nombreProducto ?? null,
                    cantProducto: venta.cantProducto ?? null,
                    precio: venta.precio ?? null,
                    importe: venta.importe ?? null,
                    cveCliente: venta.cveCliente ?? null,
                    nombreCliente: venta.nombreCliente ?? null,
                    fecha: venta.fecha ? new Date(venta.fecha) : null,
                    tipoPago: venta.tipoPago ?? null,
                    descripcionMedioPago: venta.descripcionMedioPago ?? null,
                    vendedor: venta.vendedor ?? null,
                    folioFactura: venta.folioFactura ?? false,
                    facturacionMovil: venta.facturacionMovil ?? false,
                    syncedAt: venta.fechaLog ?? nowMexico,
                    syncedAr: syncedArValue,
                  });
                  registrosGuardados++;
                }
              }
            }

            // Actualizar syncedAr en TODOS los registros locales con el fechaLog del ID más alto del servidor
            const allLocalVentas = this.realm!.objects("Venta");
            for (const localVenta of allLocalVentas) {
              (localVenta as any).syncedAr = syncedArValue;
            }
          });

          console.log(
            `[Incremental] Ventas leídos=${registrosLeidos}, guardados=${registrosGuardados}, actualizados=${registrosActualizados}`
          );

          return {
            tabla: tableName,
            endpoint: url,
            registrosLeidos,
            registrosGuardados,
            registrosActualizados,
          };
        },
      },
      {
        name: "InventarioIncremental",
        run: async () => {
          const tableName = "Inventario";
          const nowMexico = this.getMexicoNow();
          const fechaMovto = new Date(nowMexico.getTime() - nowMexico.getTimezoneOffset() * 60000).toISOString();
          const url = `${this.apiBaseUrl}/api/MovilesVentas/inventario/erp-movil?sucursal=${encodeURIComponent(
            String(sucursal)
          )}&fechaMovto=${encodeURIComponent(fechaMovto)}`;

          console.log("[Incremental] Inventario desde", url);

          const response = await fetch(url, {
            headers: { accept: "application/octet-stream" },
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} Inventario`);
          }

          const inventario = await response.json();
          const registrosLeidos = Array.isArray(inventario) ? inventario.length : 0;
          let registrosGuardados = 0;
          let registrosActualizados = 0;

          this.realm!.write(() => {
            for (const item of inventario) {
              const existing = this.realm!.objectForPrimaryKey("Inventario", item.id);

              const inventarioData = {
                ...item,
                sucursal: sucursal,
                syncedAt: item.fechaArrastre ? new Date(item.fechaArrastre) : new Date(),
                syncedAr: nowMexico,
              };

              if (existing) {
                this.realm!.create("Inventario", inventarioData, UpdateMode.Modified);
                registrosActualizados++;
              } else {
                this.realm!.create("Inventario", inventarioData);
                registrosGuardados++;
              }
            }
          });

          console.log(
            `[Incremental] Inventario leídos=${registrosLeidos}, guardados=${registrosGuardados}, actualizados=${registrosActualizados}`
          );

          return {
            tabla: tableName,
            endpoint: url,
            registrosLeidos,
            registrosGuardados,
            registrosActualizados,
          };
        },
      },
    ];

    const totalTasks = tasks.length;
    let currentTask = 0;

    for (const task of tasks) {
      currentTask++;
      const fechaInicioTask = new Date();
      notify(task.name, currentTask, totalTasks, "syncing", `Sincronizando ${task.name}...`);

      try {
        const result = await task.run();
        const fechaFinalTask = new Date();

        // Guardar bitácora por tabla
        this.realm!.write(() => {
          this.realm!.create("SyncTableLog", {
            id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            syncLogId,
            tabla: result.tabla,
            fechaInicio: fechaInicioTask,
            fechaFinal: fechaFinalTask,
            exitoso: true,
            razon: null,
            registrosLeidos: result.registrosLeidos,
            registrosGuardados: result.registrosGuardados,
            registrosActualizados: result.registrosActualizados,
            duracionMs: fechaFinalTask.getTime() - fechaInicioTask.getTime(),
            endpoint: result.endpoint,
            detalles: null,
          });
        });

        notify(task.name, currentTask, totalTasks, "success", `${task.name} sincronizado`);
      } catch (error: any) {
        const msg = error?.message || "Error desconocido";
        console.error(`[FullSyncService] Error incremental en ${task.name}:`, msg);
        errors.push(`${task.name}: ${msg}`);
        notify(task.name, currentTask, totalTasks, "error", `Error en ${task.name}: ${msg}`);
      }
    }

    const fechaFinal = new Date();

    // Actualizar SyncLog
    this.realm.write(() => {
      const log: any = this.realm!.objectForPrimaryKey("SyncLog", syncLogId);
      if (log) {
        log.fechaFinal = fechaFinal;
        log.exitoso = errors.length === 0;
        log.totalRegistros = undefined;
        log.duracionMs = fechaFinal.getTime() - fechaInicio.getTime();
        if (errors.length > 0) {
          log.razon = errors.join("; ");
        }
      }
    });

    const success = errors.length === 0;
    // console.log(
    //   `[FullSyncService] Sincronización incremental completada. Éxito: ${success}, Errores: ${errors.length}`,
    // );

    return {
      success,
      error: success ? undefined : errors.join("; "),
    };
  }

  /**
   * Sincroniza todas las tablas usando la nueva arquitectura escalable
   * Maneja dependencias, prioridades y bitácora detallada por tabla
   */
  async syncAll(
    sucursal: number = 1,
    onProgress?: SyncProgressCallback
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.realm) {
      throw new Error("Realm no inicializado");
    }

    // Crear SyncLog principal
    const syncLogId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const fechaInicio = new Date();

    try {
      // Guardar log inicial
      this.realm.write(() => {
        this.realm!.create("SyncLog", {
          id: syncLogId,
          fechaInicio,
          exitoso: true, // Se actualizará si hay errores
          tipo: "automatica",
        });
      });

      // console.log(
      //   `[FullSyncService] Iniciando sincronización completa (ID: ${syncLogId})`,
      // );

      // Crear orquestador y ejecutar todas las tareas
      const orchestrator = new SyncOrchestrator(this.realm, syncLogId, sucursal, onProgress);

      const result = await orchestrator.executeAll();

      // Actualizar log final
      const fechaFinal = new Date();
      const totalRegistros = Array.from(result.results.values()).reduce(
        (sum, r) => sum + (r.registrosGuardados || 0) + (r.registrosActualizados || 0),
        0
      );

      this.realm.write(() => {
        const log = this.realm!.objectForPrimaryKey("SyncLog", syncLogId);
        if (log) {
          log.fechaFinal = fechaFinal;
          log.exitoso = result.success;
          log.totalRegistros = totalRegistros;
          log.duracionMs = fechaFinal.getTime() - fechaInicio.getTime();
          if (!result.success) {
            log.razon = result.errors.join("; ");
          }
        }
      });

      // console.log(
      //   `[FullSyncService] Sincronización completada. Éxito: ${result.success}, Total registros: ${totalRegistros}`,
      // );

      return {
        success: result.success,
        error: result.success ? undefined : result.errors.join("; "),
      };
    } catch (error: any) {
      console.error("❌ Error durante la sincronización completa:", error);

      // Actualizar log con error crítico
      const fechaFinal = new Date();
      try {
        this.realm.write(() => {
          const log = this.realm!.objectForPrimaryKey("SyncLog", syncLogId);
          if (log) {
            log.fechaFinal = fechaFinal;
            log.exitoso = false;
            log.razon = error?.message || "Error desconocido";
            log.duracionMs = fechaFinal.getTime() - fechaInicio.getTime();
          }
        });
      } catch (logError) {
        console.error("[FullSyncService] Error al actualizar log:", logError);
      }

      if (onProgress) {
        onProgress({
          current: 0,
          total: 0,
          entity: "Error",
          status: "error",
          message: error?.message || "Error durante la sincronización",
        });
      }

      return { success: false, error: error?.message };
    }
  }

  /**
   * Sincroniza una tabla específica
   * Útil para sincronizaciones manuales o selectivas
   */
  async syncTable(
    tableName: string,
    sucursal: number = 1,
    onProgress?: SyncProgressCallback
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.realm) {
      throw new Error("Realm no inicializado");
    }

    // Crear SyncLog principal
    const syncLogId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const fechaInicio = new Date();

    try {
      // Guardar log inicial
      this.realm.write(() => {
        this.realm!.create("SyncLog", {
          id: syncLogId,
          fechaInicio,
          exitoso: true,
          tipo: "manual",
        });
      });

      // console.log(
      //   `[FullSyncService] Iniciando sincronización de tabla: ${tableName} (ID: ${syncLogId})`,
      // );

      // Crear orquestador y ejecutar tarea específica
      const orchestrator = new SyncOrchestrator(this.realm, syncLogId, sucursal, onProgress);

      const result = await orchestrator.executeTask(tableName);

      if (!result) {
        throw new Error(`Tabla no encontrada: ${tableName}`);
      }

      // Actualizar log final
      const fechaFinal = new Date();
      const totalRegistros = (result.registrosGuardados || 0) + (result.registrosActualizados || 0);

      this.realm.write(() => {
        const log = this.realm!.objectForPrimaryKey("SyncLog", syncLogId);
        if (log) {
          log.fechaFinal = fechaFinal;
          log.exitoso = result.success;
          log.totalRegistros = totalRegistros;
          log.duracionMs = fechaFinal.getTime() - fechaInicio.getTime();
          if (!result.success) {
            log.razon = result.error || "Error desconocido";
          }
        }
      });

      // console.log(
      //   `[FullSyncService] Sincronización de ${tableName} completada. Éxito: ${result.success}`,
      // );

      return {
        success: result.success,
        error: result.success ? undefined : result.error,
      };
    } catch (error: any) {
      // Actualizar log con error
      const fechaFinal = new Date();
      try {
        this.realm.write(() => {
          const log = this.realm!.objectForPrimaryKey("SyncLog", syncLogId);
          if (log) {
            log.fechaFinal = fechaFinal;
            log.exitoso = false;
            log.razon = error?.message || "Error desconocido";
            log.duracionMs = fechaFinal.getTime() - fechaInicio.getTime();
          }
        });
      } catch (logError) {
        console.error("[FullSyncService] Error al actualizar log:", logError);
      }

      console.error(`[FullSyncService] Error en sincronización de ${tableName}:`, error);
      return {
        success: false,
        error: error?.message || "Error desconocido",
      };
    }
  }

  private updateSyncStatus(entity: string, success: boolean): void {
    if (!this.realm) return;

    this.realm.write(() => {
      this.realm!.create(
        "SyncStatus",
        {
          id: entity,
          lastSyncDate: new Date(),
          status: success ? "completed" : "failed",
        },
        UpdateMode.Modified
      );
    });
  }

  async getSucursales(): Promise<{ id: number; nombre: string }[]> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/api/MovilesVentas/sucursales`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (!Array.isArray(data)) {
        throw new Error("Respuesta inválida del servidor");
      }

      return data.map((item: any) => ({
        id: Number(item.id),
        nombre: String(item.nombre),
      }));
    } catch (error: any) {
      console.error("❌ Error al obtener sucursales:", error);
      throw error;
    }
  }

  // Métodos para consultar datos
  getVentas(limit: number = 100): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(this.realm.objects("Venta").sorted("fecha", true).slice(0, limit));
  }

  getVentasPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(
      this.realm
        .objects("Venta")
        .sorted("fecha", true)
        .slice(offset, offset + limit)
    );
  }

  getSyncTableLogsCount(): number {
    if (!this.isInitialized || !this.realm) return 0;
    return this.realm.objects("SyncTableLog").length;
  }

  getVentasBySucursal(sucursal: number, limit: number = 10000): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(
      this.realm.objects("Venta").filtered("sucursal == $0", sucursal).sorted("fecha", true).slice(0, limit)
    );
  }

  /**
   * Crea ventas locales en Realm (una fila por producto de la venta).
   * Se usa para registrar ventas hechas en el punto de venta antes de sincronizar.
   */
  async createLocalVentas(
    ventas: {
      id: number;
      idMovil?: number | null;
      sucursal?: number | null;
      noVenta?: number | null;
      claveProd?: number | null;
      nombreProducto?: string | null;
      cantProducto?: number | null;
      precio?: number | null;
      importe?: number | null;
      cveCliente?: number | null;
      nombreCliente?: string | null;
      fecha?: Date | null;
      tipoPago?: number | null;
      descripcionMedioPago?: string | null;
      vendedor?: string | null;
      folioFactura?: boolean | null;
      facturacionMovil?: boolean | null;
      latitud?: number | null;
      longitud?: number | null;
    }[]
  ): Promise<void> {
    if (!ventas.length) return;

    if (!this.isInitialized || !this.realm) {
      await this.initialize();
    }
    if (!this.realm) return;

    this.realm.write(() => {
      ventas.forEach((v) => {
        this.realm!.create("Venta", {
          id: v.id,
          idMovil: v.idMovil ?? null,
          sucursal: v.sucursal ?? null,
          noVenta: v.noVenta ?? null,
          claveProd: v.claveProd ?? null,
          nombreProducto: v.nombreProducto ?? null,
          cantProducto: v.cantProducto ?? null,
          precio: v.precio ?? null,
          importe: v.importe ?? null,
          cveCliente: v.cveCliente ?? null,
          nombreCliente: v.nombreCliente ?? null,
          fecha: v.fecha ?? new Date(),
          tipoPago: v.tipoPago ?? null,
          descripcionMedioPago: v.descripcionMedioPago ?? null,
          vendedor: v.vendedor ?? null,
          folioFactura: v.folioFactura ?? false,
          facturacionMovil: v.facturacionMovil ?? false,
          latitud: v.latitud ?? null,
          longitud: v.longitud ?? null,
          // Fecha centinela para indicar que aún no se sincroniza
          syncedAt: new Date(0),
        });
      });
    });
  }

  getVentasByMovilId(idMovil: number): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(this.realm.objects("Venta").filtered("idMovil == $0", idMovil));
  }

  /**
   * Actualiza el inventario restando las cantidades vendidas.
   * Si el producto es un kit, descuenta los insumos según la tabla Kit.
   * Si no es kit, descuenta el producto directamente.
   */
  async updateInventarioAfterSale(
    items: {
      sucursal: number;
      claveProd: number;
      cantidad: number;
      esKit?: boolean;
      idProducto?: number;
    }[]
  ): Promise<void> {
    console.log("[FullSync] updateInventarioAfterSale called with", {
      itemsCount: items.length,
      items: items.map((i) => ({
        sucursal: i.sucursal,
        claveProd: i.claveProd,
        cantidad: i.cantidad,
        esKit: i.esKit,
        idProducto: i.idProducto,
      })),
    });

    if (!items.length) {
      console.log("[FullSync] updateInventarioAfterSale: No items to process");
      return;
    }

    if (!this.isInitialized || !this.realm) {
      console.log("[FullSync] updateInventarioAfterSale: Initializing realm...");
      await this.initialize();
    }
    if (!this.realm) {
      console.error("[FullSync] updateInventarioAfterSale: Realm not available after init!");
      return;
    }

    console.log("[FullSync] updateInventarioAfterSale: Starting realm.write()");
    this.realm.write(() => {
      items.forEach((item, index) => {
        console.log(`[FullSync] Processing item ${index + 1}/${items.length}:`, {
          sucursal: item.sucursal,
          claveProd: item.claveProd,
          cantidad: item.cantidad,
          esKit: item.esKit,
          idProducto: item.idProducto,
        });

        if (item.esKit && item.idProducto) {
          // Es un kit: descontar los insumos según la tabla Kit
          const componentes = this.realm!.objects("Kit").filtered("idProducto == $0", item.idProducto);

          console.log(
            `[FullSync] Kit detectado (idProducto: ${item.idProducto}), descargando ${componentes.length} insumos`
          );

          componentes.forEach((comp: any) => {
            const idInsumo = comp.idInsumo;
            const cantidadInsumo = comp.cantidad || 0;
            const cantidadTotal = cantidadInsumo * item.cantidad;

            if (!idInsumo || cantidadInsumo <= 0) {
              console.warn(`[FullSync] Componente de kit inválido: idInsumo=${idInsumo}, cantidad=${cantidadInsumo}`);
              return;
            }

            // Buscar el inventario del insumo por idInsumo (que es claveProd)
            const inventario = this.realm!.objects("Inventario").filtered(
              "sucursal == $0 AND claveProd == $1",
              item.sucursal,
              idInsumo
            )[0] as any;

            if (inventario) {
              const saldoAnterior = inventario.saldo || 0;
              inventario.saldo = saldoAnterior + cantidadTotal;
              inventario.fechaArrastre = new Date();
              console.log(
                `[FullSync] Insumo ${idInsumo} descargado: ${cantidadTotal} unidades (saldo: ${saldoAnterior} → ${inventario.saldo})`
              );
            } else {
              console.warn(`[FullSync] No se encontró inventario para Insumo ${idInsumo} en Sucursal ${item.sucursal}`);
            }
          });
        } else {
          // No es kit: descontar el producto directamente usando idProducto (id del producto)
          const idProductoBuscar = item.idProducto ?? item.claveProd;

          const inventarioResults = this.realm!.objects("Inventario").filtered(
            "sucursal == $0 AND claveProd == $1",
            item.sucursal,
            idProductoBuscar
          );
          console.log(
            `[FullSync] Búsqueda inventario sucursal=${item.sucursal}, idProducto=${idProductoBuscar}, encontrados: ${inventarioResults.length}`
          );

          const inventario = inventarioResults[0] as any;

          if (inventario) {
            const saldoAnterior = inventario.saldo || 0;
            inventario.saldo = saldoAnterior + item.cantidad;
            inventario.fechaArrastre = new Date();
            console.log(
              `[FullSync] Producto id=${idProductoBuscar} descargado: ${item.cantidad} unidades (saldo: ${saldoAnterior} → ${inventario.saldo})`
            );
          } else {
            console.warn(
              `[FullSync] No se encontró inventario para Producto id=${idProductoBuscar} en Sucursal ${item.sucursal}`
            );
          }
        }
      });
    });
    console.log("[FullSync] updateInventarioAfterSale: realm.write() completed successfully");
  }

  async updateInventarioAfterSaleScreen(
    items: {
      sucursal: number;
      claveProd: number;
      cantidad: number;
      esKit?: boolean;
      idProducto?: number;
    }[]
  ): Promise<void> {
    console.log("[FullSync] updateInventarioAfterSaleScreen called with", {
      itemsCount: items.length,
      items: items.map((i) => ({
        sucursal: i.sucursal,
        claveProd: i.claveProd,
        cantidad: i.cantidad,
        esKit: i.esKit,
        idProducto: i.idProducto,
      })),
    });

    if (!items.length) {
      console.log("[FullSync] updateInventarioAfterSaleScreen: No items to process");
      return;
    }

    if (!this.isInitialized || !this.realm) {
      console.log("[FullSync] updateInventarioAfterSaleScreen: Initializing realm...");
      await this.initialize();
    }
    if (!this.realm) {
      console.error("[FullSync] updateInventarioAfterSaleScreen: Realm not available after init!");
      return;
    }

    console.log("[FullSync] updateInventarioAfterSaleScreen: Starting realm.write()");
    this.realm.write(() => {
      items.forEach((item, index) => {
        console.log(`[FullSync] Processing item ${index + 1}/${items.length}:`, {
          sucursal: item.sucursal,
          claveProd: item.claveProd,
          cantidad: item.cantidad,
          esKit: item.esKit,
          idProducto: item.idProducto,
        });

        if (item.esKit && item.idProducto) {
          // Es un kit: descontar los insumos según la tabla Kit
          const componentes = this.realm!.objects("Kit").filtered("idProducto == $0", item.idProducto);

          console.log(
            `[FullSync] Kit detectado (idProducto: ${item.idProducto}), descargando ${componentes.length} insumos`
          );

          componentes.forEach((comp: any) => {
            const idInsumo = comp.idInsumo;
            const cantidadInsumo = comp.cantidad || 0;
            const cantidadTotal = cantidadInsumo * item.cantidad;

            if (!idInsumo || cantidadInsumo <= 0) {
              console.warn(`[FullSync] Componente de kit inválido: idInsumo=${idInsumo}, cantidad=${cantidadInsumo}`);
              return;
            }

            // Buscar el inventario del insumo por idInsumo (que es claveProd)
            const inventario = this.realm!.objects("Inventario").filtered(
              "sucursal == $0 AND claveProd == $1",
              item.sucursal,
              idInsumo
            )[0] as any;

            if (inventario) {
              const saldoAnterior = inventario.saldo || 0;
              inventario.saldo = saldoAnterior - cantidadTotal;
              inventario.fechaArrastre = new Date();
              console.log(
                `[FullSync] Insumo ${idInsumo} descargado: ${cantidadTotal} unidades (saldo: ${saldoAnterior} → ${inventario.saldo})`
              );
            } else {
              console.warn(`[FullSync] No se encontró inventario para Insumo ${idInsumo} en Sucursal ${item.sucursal}`);
            }
          });
        } else {
          // No es kit: descontar el producto directamente usando idProducto (id del producto)
          const idProductoBuscar = item.idProducto ?? item.claveProd;

          const inventarioResults = this.realm!.objects("Inventario").filtered(
            "sucursal == $0 AND claveProd == $1",
            item.sucursal,
            idProductoBuscar
          );
          console.log(
            `[FullSync] Búsqueda inventario sucursal=${item.sucursal}, idProducto=${idProductoBuscar}, encontrados: ${inventarioResults.length}`
          );

          const inventario = inventarioResults[0] as any;

          if (inventario) {
            const saldoAnterior = inventario.saldo || 0;
            inventario.saldo = saldoAnterior - item.cantidad;
            inventario.fechaArrastre = new Date();
            console.log(
              `[FullSync] Producto id=${idProductoBuscar} descargado: ${item.cantidad} unidades (saldo: ${saldoAnterior} → ${inventario.saldo})`
            );
          } else {
            console.warn(
              `[FullSync] No se encontró inventario para Producto id=${idProductoBuscar} en Sucursal ${item.sucursal}`
            );
          }
        }
      });
    });
    console.log("[FullSync] updateInventarioAfterSaleScreen: realm.write() completed successfully");
  }

  /**
   * Actualiza el inventario sumando las cantidades recibidas en un traspaso.
   * Busca el registro existente por sucursal y claveProd y actualiza el saldo.
   */
  async updateInventarioAfterReception(
    items: {
      sucursal: number;
      claveProd: number;
      cantidad: number;
    }[]
  ): Promise<void> {
    if (!items.length) return;

    if (!this.isInitialized || !this.realm) {
      await this.initialize();
    }
    if (!this.realm) return;

    this.realm.write(() => {
      items.forEach((item) => {
        // Buscar el registro de inventario existente
        const inventario = this.realm!.objects("Inventario").filtered(
          "sucursal == $0 AND claveProd == $1",
          item.sucursal,
          item.claveProd
        )[0] as any;

        if (inventario) {
          // Actualizar el saldo sumando la cantidad recibida
          inventario.saldo = (inventario.saldo || 0) + item.cantidad;
          inventario.fechaArrastre = new Date();
          // console.log(
          //   `[FullSync] Inventario actualizado (recepción): Producto ${
          //     item.claveProd
          //   }, Saldo anterior: ${
          //     (inventario.saldo || 0) - item.cantidad
          //   }, Nuevo saldo: ${inventario.saldo}`,
          // );
        } else {
          console.warn(
            `[FullSync] No se encontró inventario para Producto ${item.claveProd} en Sucursal ${item.sucursal}`
          );
        }
      });
    });
  }

  /**
   * Crea movimientos locales en Inventario (por ejemplo, recepción de traspasos).
   * @deprecated Usar updateInventarioAfterSale para ventas
   */
  async createLocalInventarioMovements(
    movimientos: {
      id: number;
      sucursal?: number | null;
      claveProd?: number | null;
      saldo: number;
      fechaArrastre?: Date | null;
      descripcion?: string | null;
    }[]
  ): Promise<void> {
    if (!movimientos.length) return;

    if (!this.isInitialized || !this.realm) {
      await this.initialize();
    }
    if (!this.realm) return;

    this.realm.write(() => {
      movimientos.forEach((m) => {
        const idValue = Number(m.id);
        const sucursalValue = m.sucursal === null || m.sucursal === undefined ? null : Number(m.sucursal);
        const claveProdValue = m.claveProd === null || m.claveProd === undefined ? null : Number(m.claveProd);

        this.realm!.create("Inventario", {
          id: idValue,
          sucursal: sucursalValue,
          claveProd: claveProdValue,
          fechaArrastre: m.fechaArrastre ?? new Date(),
          saldo: m.saldo,
          descripcion: m.descripcion ?? null,
          // Fecha centinela para indicar que aún no se sincroniza
          syncedAt: new Date(0),
        });
      });
    });
  }

  /**
   * Crea movimientos locales en Cartera (por ejemplo, pagos registrados en Cobranza).
   */
  async createLocalCarteraMovements(
    movimientos: {
      id: number;
      idCliente?: number | null;
      nombreCliente?: string | null;
      sucursal?: number | null;
      sucursalSegmento?: number | null;
      saldo: number;
      fecha?: Date | null;
      idSegmento?: number | null;
      noVenta?: number | null;
      tipoPago?: number | null;
    }[]
  ): Promise<void> {
    if (!movimientos.length) return;

    if (!this.isInitialized || !this.realm) {
      await this.initialize();
    }
    if (!this.realm) return;

    this.realm.write(() => {
      movimientos.forEach((m) => {
        this.realm!.create("Cartera", {
          id: m.id,
          idCliente: m.idCliente ?? null,
          nombreCliente: m.nombreCliente ?? null,
          sucursal: m.sucursal ?? null,
          sucursalSegmento: m.sucursalSegmento ?? null,
          saldo: m.saldo,
          fecha: m.fecha ?? new Date(),
          idSegmento: m.idSegmento ?? null,
          noVenta: m.noVenta ?? null,
          tipoPago: m.tipoPago ?? null,
          // Fecha centinela para indicar que aún no se sincroniza
          syncedAt: new Date(0),
        });
      });
    });
  }

  async markCarteraAsPaid(ids: number[]): Promise<void> {
    if (!ids.length) return;

    if (!this.isInitialized || !this.realm) {
      await this.initialize();
    }
    if (!this.realm) return;

    this.realm.write(() => {
      ids.forEach((id) => {
        const row: any = this.realm!.objectForPrimaryKey("Cartera", id);
        if (row) {
          row.cobrado = true;
        }
      });
    });
  }

  getUsuarios(limit: number = 100): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(this.realm.objects("Usuario").sorted("nombre").slice(0, limit));
  }

  getUsuariosPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(
      this.realm
        .objects("Usuario")
        .sorted("nombre")
        .slice(offset, offset + limit)
    );
  }

  getProductos(limit: number = 100): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(this.realm.objects("Producto").sorted("descripcion").slice(0, limit));
  }

  getProductosPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(
      this.realm
        .objects("Producto")
        .sorted("descripcion")
        .slice(offset, offset + limit)
    );
  }

  /**
   * Obtiene todos los kits (relación producto-insumo)
   */
  getKits(limit: number = 100): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(this.realm.objects("Kit").slice(0, limit));
  }

  /**
   * Obtiene kits con paginación
   */
  getKitsPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(this.realm.objects("Kit").slice(offset, offset + limit));
  }

  /**
   * Obtiene los kits (insumos) de un producto específico
   */
  getKitsByProducto(idProducto: number): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(this.realm.objects("Kit").filtered("idProducto == $0", idProducto));
  }

  /**
   * Obtiene los productos que usan un insumo específico
   */
  getKitsByInsumo(idInsumo: number): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(this.realm.objects("Kit").filtered("idInsumo == $0", idInsumo));
  }

  /**
   * Obtiene un kit específico por ID
   */
  getKitById(id: number): any | null {
    if (!this.isInitialized || !this.realm) return null;
    return this.realm.objectForPrimaryKey("Kit", id) || null;
  }

  getPrecios(limit: number = 100): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(this.realm.objects("Precio").sorted("descripcion").slice(0, limit));
  }

  getPreciosPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(
      this.realm
        .objects("Precio")
        .sorted("descripcion")
        .slice(offset, offset + limit)
    );
  }

  getInventario(limit: number = 100): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(this.realm.objects("Inventario").slice(0, limit));
  }

  getInventarioPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(this.realm.objects("Inventario").slice(offset, offset + limit));
  }

  getCartera(limit: number = 100): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(this.realm.objects("Cartera").sorted("nombreCliente").slice(0, limit));
  }

  getCarteraPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(
      this.realm
        .objects("Cartera")
        .sorted("nombreCliente")
        .slice(offset, offset + limit)
    );
  }

  getVentasTotalEfectivoForDate(date: Date, sucursal?: number): number {
    if (!this.isInitialized || !this.realm) return 0;

    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);

    let query = "fecha >= $0 AND fecha <= $1 AND tipoPago == 1 and noVenta>0";
    const args: any[] = [start, end];

    if (sucursal !== undefined) {
      query += " AND sucursal == $2";
      args.push(sucursal);
    }
    // console.log(sucursal);
    const ventas = this.realm.objects("Venta").filtered(query, ...args);
    // console.log(ventas);
    // console.log('Venta:', ventas);
    let total = 0;
    for (let i = 0; i < ventas.length; i++) {
      const v: any = ventas[i];
      total += v.importe || 0;
    }
    return total;
  }
  // {
  //     "id": 1763078957601044,
  //     "sucursal": 44,
  //     "noVenta": 1763078957601044,
  //     "claveProd": 2,
  //     "nombreProducto": "Bolsa 5Kg",
  //     "cantProducto": 1,
  //     "precio": 25,
  //     "importe": 25,
  //     "cveCliente": 942,
  //     "nombreCliente": "001 ABARROTES FASTI SAN JOSE",
  //     "fecha": "2025-11-14T00:09:17.601Z",
  //     "tipoPago": 1,
  //     "descripcionMedioPago": "Efectivo",
  //     "vendedor": "CBERP14",
  //     "folioFactura": false,
  //     "facturacionMovil": false,
  //     "syncedAt": "1970-01-01T00:00:00.000Z"
  // }
  getClientesFull(limit: number = 100): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(this.realm.objects("ClienteFull").sorted("nombre").slice(0, limit));
  }

  getClientesFullPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(
      this.realm
        .objects("ClienteFull")
        .sorted("nombre")
        .slice(offset, offset + limit)
    );
  }

  getClienteFullById(idCliente: number): any | null {
    if (!this.isInitialized || !this.realm) return null;
    const obj = this.realm.objectForPrimaryKey("ClienteFull", idCliente);
    return obj || null;
  }

  getPreciosByCliente(idCliente: number): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(this.realm.objects("Precio").filtered("idCliente == $0", idCliente));
  }

  getPreciosByListaPrecio(listaPrecio: number): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(this.realm.objects("Precio").filtered("listaPrecio == $0", listaPrecio));
  }

  getSyncStatus(entity: string = "all"): any {
    if (!this.isInitialized || !this.realm) return null;
    return this.realm.objectForPrimaryKey("SyncStatus", entity);
  }

  getSyncTableLogsPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(
      this.realm
        .objects("SyncTableLog")
        .sorted("fechaInicio", true) // Más recientes primero
        .slice(offset, offset + limit)
    );
  }

  /**
   * Envía las ventas locales pendientes al servidor.
   * Solo envía ventas con id >= LOCAL_SALE_ID_THRESHOLD y noVenta === 0.
   * Se puede usar desde SalesScreen o desde la sincronización periódica.
   */
  async sendPendingVentasToServer(
    sucursal: number,
    idUsuario: number
  ): Promise<{ success: boolean; sent: number; error?: string }> {
    const LOCAL_SALE_ID_THRESHOLD = 1700000000;

    try {
      if (!this.isInitialized || !this.realm) {
        await this.initialize();
      }
      if (!this.realm) {
        return { success: false, sent: 0, error: "Realm no inicializado" };
      }

      const ventasRealm = this.getVentas();

      // Solo enviar ventas locales (id >= threshold) y sin número de venta asignado
      const ventasLocales = ventasRealm.filter(
        (venta: any) => venta.noVenta === 0 && venta.id >= LOCAL_SALE_ID_THRESHOLD
      );

      console.log("[FullSyncService] Filtering local sales", {
        totalVentas: ventasRealm.length,
        localVentas: ventasLocales.length,
        threshold: LOCAL_SALE_ID_THRESHOLD,
      });

      if (ventasLocales.length === 0) {
        console.log("[FullSyncService] No pending ventas to send");
        return { success: true, sent: 0 };
      }

      const payload = ventasLocales.map((venta: any) => {
        const cliente = venta.cveCliente ? this.getClienteFullById(venta.cveCliente) : null;

        return {
          sucursal: venta.sucursal ?? sucursal,
          clave_prod: venta.claveProd ?? 0,
          Cant_producto: venta.cantProducto ?? 0,
          precio: venta.precio ?? 0,
          Cve_cliente: venta.cveCliente ?? 0,
          fecha: (venta.fecha ?? new Date()).toISOString(),
          tipo_pago: venta.tipoPago ?? 1,
          usuario: idUsuario,
          longitud: cliente?.longitud ?? 0,
          latitud: cliente?.latitud ?? 0,
          id_movil: venta.idMovil,
          fechaTransfer: new Date().toISOString(),
        };
      });

      console.log("[FullSyncService] 📦 Payload ventas:", payload.length, "registros");

      // Usar el mismo endpoint que el sincronizador periódico (que funciona correctamente)
      const url = `${this.apiBaseUrl}/api/SincronizacionMovil/sp_MovilesVentasArrastreJSON?sucursal=${sucursal}&idUsuario=${idUsuario}`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        console.error("[FullSyncService] ❌ Error arrastre ventas", response.status, errorText);
        return {
          success: false,
          sent: 0,
          error: `HTTP ${response.status}: ${errorText}`,
        };
      }

      console.log(`[FullSyncService] ✅ Arrastre ventas exitoso: ${payload.length} registros`);

      return { success: true, sent: payload.length };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Error desconocido";
      console.error("[FullSyncService] Error sending ventas arrastre", error);
      return { success: false, sent: 0, error: errorMsg };
    }
  }

  getStats(): any {
    if (!this.isInitialized || !this.realm) {
      return {
        ventas: 0,
        usuarios: 0,
        productos: 0,
        kits: 0,
        precios: 0,
        inventario: 0,
        cartera: 0,
        clientes: 0,
        bitacora: 0,
      };
    }

    return {
      ventas: this.realm.objects("Venta").length,
      usuarios: this.realm.objects("Usuario").length,
      productos: this.realm.objects("Producto").length,
      kits: this.realm.objects("Kit").length,
      precios: this.realm.objects("Precio").length,
      inventario: this.realm.objects("Inventario").length,
      cartera: this.realm.objects("Cartera").length,
      clientes: this.realm.objects("ClienteFull").length,
      bitacora: this.realm.objects("SyncTableLog").length,
    };
  }

  close(): void {
    if (this.realm && !this.realm.isClosed) {
      this.realm.close();
      this.isInitialized = false;
      console.log("🔒 FullSyncService cerrado");
    }
  }
}

export default new FullSyncService();
