import Realm, { UpdateMode } from "realm";
import { allSchemas, SyncLogSchema } from "./RealmSchemas";
import { SyncProgress } from "./sync/SyncTask";
import { SyncOrchestrator } from "./sync/SyncOrchestrator";
import { ConsoleLogger } from "@microsoft/signalr/dist/esm/Utils";
import BitacoraService from "./BitacoraService";
import GpsBitacoraService from "./GpsBitacoraService";

export type { SyncProgress };
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
        schema: allSchemas,
        schemaVersion: 28,
        onMigration: (oldRealm: Realm, newRealm: Realm) => {
          // Migración para Cartera
          const newCartera = newRealm.objects("Cartera");
          for (let i = 0; i < newCartera.length; i++) {
            const obj: any = newCartera[i];
            if (typeof obj.cobrado === "undefined") {
              obj.cobrado = false;
            }
          }

          // Migración para Usuario - inicializar campo metros
          const newUsuarios = newRealm.objects("Usuario");
          for (let i = 0; i < newUsuarios.length; i++) {
            const obj: any = newUsuarios[i];
            if (typeof obj.metros === "undefined" || obj.metros === null) {
              obj.metros = 31; // Valor por defecto
            }
          }

          // Migración v16: Cambiar Visita.id de int a string compuesto
          // Realm automáticamente recreará la tabla Visita porque cambió el tipo de primary key
          // Las visitas antiguas se perderán y deberán sincronizarse nuevamente
          if (oldRealm.schemaVersion < 16) {
            console.log(
              "[Migration v16] ⚠️ Cambio de primary key en Visita: las visitas antiguas se perderán y deben resincronizarse.",
            );
          }

          // Migración v22: Agregar campo reubicacion (bool?) a Usuario — default null (se llenará en el próximo sync)
          if (oldRealm.schemaVersion < 22) {
            console.log("[Migration v22] Agregando campo reubicacion a Usuario");
          }

          // Migración v23: Agregar campo sucursalNombre (string?) a Usuario — default null (se llenará en el próximo sync)
          if (oldRealm.schemaVersion < 23) {
            console.log("[Migration v23] Agregando campo sucursalNombre a Usuario");
          }

          // Migración v24: Nueva tabla InventarioEnvasesHistorial (se llenará en el próximo sync)
          if (oldRealm.schemaVersion < 24) {
            console.log("[Migration v24] Creando tabla InventarioEnvasesHistorial");
          }

          // Migración v25: Reubicacion cambió completamente su estructura
          // Realm automáticamente recreará la tabla porque cambió el tipo de primary key (string -> int)
          // Los datos antiguos de reubicaciones se perderán y deben resincronizarse
          if (oldRealm.schemaVersion < 25) {
            console.log(
              "[Migration v25] ⚠️ Reestructuración completa de Reubicacion: datos antiguos se eliminarán y deben resincronizarse.",
            );
          }

          // Migración v26: Agregar campo enviado a Reubicacion con default false
          if (oldRealm.schemaVersion < 26) {
            console.log("[Migration v26] Agregando campo enviado a Reubicacion");
            const reubicaciones = newRealm.objects("Reubicacion");
            for (let i = 0; i < reubicaciones.length; i++) {
              const obj: any = reubicaciones[i];
              if (typeof obj.enviado === "undefined") {
                obj.enviado = false;
              }
            }
          }

          // Migración v27: Agregar campo sucursal a Reubicacion
          if (oldRealm.schemaVersion < 27) {
            console.log("[Migration v27] Agregando campo sucursal a Reubicacion");
          }

          // Migración v28: Nueva tabla VentaCancelacion para cancelaciones de ventas
          if (oldRealm.schemaVersion < 28) {
            console.log("[Migration v28] Creando tabla VentaCancelacion");
          }
        },
      });

      this.isInitialized = true;
      console.log("✅ FullSyncService inicializado correctamente (v16 - Visita con ID compuesto)");

      // Inyectar Realm a otros servicios para evitar múltiples instancias
      await this.injectRealmToServices();
    } catch (error) {
      console.error("❌ Error al inicializar FullSyncService:", error);
      throw error;
    }
  }

  /**
   * Inyecta la instancia de Realm a todos los servicios que la necesitan
   * Esto evita el error "ALREADY OPENED" al garantizar una única instancia compartida
   */
  private async injectRealmToServices(): Promise<void> {
    if (!this.realm) {
      console.warn("[FullSyncService] No se puede inyectar Realm: instancia no inicializada");
      return;
    }

    try {
      // Inyectar a BitacoraService
      BitacoraService.setRealm(this.realm);

      // Inyectar a GpsBitacoraService
      GpsBitacoraService.setRealm(this.realm);

      // Inyectar a DetalleVisitasService
      const DetalleVisitasService = (await import("./DetalleVisitasService")).default;
      DetalleVisitasService.getInstance().setRealm(this.realm);

      // Inyectar a VisitaSyncService
      const VisitaSyncService = (await import("./VisitaSyncService")).default;
      VisitaSyncService.getInstance().setRealm(this.realm);

      // Inyectar a CierreRutaService
      const CierreRutaService = (await import("./CierreRutaService")).default;
      CierreRutaService.setRealm(this.realm);

      // Inyectar a ReubicacionService
      const ReubicacionService = (await import("./ReubicacionService")).default;
      ReubicacionService.getInstance().setRealm(this.realm);

      // Inyectar a VentaCancelacionService
      const VentaCancelacionService = (await import("./VentaCancelacionService")).default;
      VentaCancelacionService.getInstance().setRealm(this.realm);

      console.log("✅ Realm inyectado a todos los servicios");
    } catch (error) {
      console.error("❌ Error al inyectar Realm a servicios:", error);
    }
  }

  /**
   * Obtiene la última fecha syncedAr (horario México) de una tabla dada.
   * Si no hay registros o todas son null, regresa null.
   */
  private getLastSyncedAr(tableName: string): Date | null {
    if (!this.realm || this.realm.isClosed) return null;

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
   * Obtiene la fecha/hora actual de México usando zona horaria America/Mexico_City.
   * Retorna un Date object con la hora correcta de México.
   */
  getMexicoNow(): Date {
    // Obtener la hora actual en UTC
    const nowUTC = new Date();

    // Formatear la hora de México usando Intl
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Mexico_City",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    const parts = formatter.formatToParts(nowUTC);
    const get = (type: string) => parts.find((p) => p.type === type)?.value || "0";

    // Crear fecha usando Date.UTC para que se interprete como UTC
    // Luego ajustar para que represente la hora de México
    const mexicoDateUTC = Date.UTC(
      parseInt(get("year"), 10),
      parseInt(get("month"), 10) - 1,
      parseInt(get("day"), 10),
      parseInt(get("hour"), 10),
      parseInt(get("minute"), 10),
      parseInt(get("second"), 10),
    );

    return new Date(mexicoDateUTC);
  }

  /**
   * Formatea una fecha de México en formato ISO sin conversión a UTC.
   * Útil para enviar al servidor preservando la hora local de México.
   */
  formatMexicoDateForServer(date: Date): string {
    // El Date almacenado ya representa la hora de México como UTC
    // Por lo tanto, usamos getUTC* para leer los componentes sin conversión adicional
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const hours = String(date.getUTCHours()).padStart(2, "0");
    const minutes = String(date.getUTCMinutes()).padStart(2, "0");
    const seconds = String(date.getUTCSeconds()).padStart(2, "0");
    const ms = String(date.getUTCMilliseconds()).padStart(3, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
  }

  /**
   * Envía ventas locales pendientes al servidor (arrastre).
   * Se ejecuta automáticamente antes de sincronizaciones para subir ventas offline.
   * Wrapper del método público sendPendingVentasToServer.
   */
  private async sendPendingVentasArrastre(
    sucursal: number,
    idUsuario: number,
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
    timeoutMs: number = 3000,
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
    idUsuario?: number,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.realm) {
      throw new Error("Realm no inicializado");
    }

    // PASO 1: Enviar cancelaciones de ventas pendientes PRIMERO
    if (idUsuario) {
      console.log("[FullSync] PASO 1 - Enviando cancelaciones de ventas pendientes...");
      try {
        const cancelacionesPendientes = this.realm.objects("VentaCancelacion").filtered("enviado == false");
        
        if (cancelacionesPendientes.length > 0) {
          console.log(`[FullSync-Cancelacion] 📤 Enviando ${cancelacionesPendientes.length} cancelaciones pendientes...`);

          const formatDate = (date: Date): string => {
            const year = date.getUTCFullYear();
            const month = String(date.getUTCMonth() + 1).padStart(2, "0");
            const day = String(date.getUTCDate()).padStart(2, "0");
            const hours = String(date.getUTCHours()).padStart(2, "0");
            const minutes = String(date.getUTCMinutes()).padStart(2, "0");
            const seconds = String(date.getUTCSeconds()).padStart(2, "0");
            return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.000Z`;
          };

          const payload = Array.from(cancelacionesPendientes).map((cancelacion: any) => ({
            sucursal: cancelacion.sucursal ?? sucursal,
            no_venta: cancelacion.noVenta ?? 0,
            caja: cancelacion.caja ?? 1,
            id_movil: cancelacion.idMovil,
            usuario_cancela: cancelacion.usuarioCancela ?? idUsuario,
            fecha_cancela: formatDate(cancelacion.fechaCancela ?? new Date()),
            motivo_cancelacion: cancelacion.motivoCancelacion ?? "",
            latitud: cancelacion.latitud ?? 0,
            longitud: cancelacion.longitud ?? 0,
          }));

          const cancelacionUrl = `${this.apiBaseUrl}/api/MovilesVentas/sp_MovilesVentasCancelacionJSON?sucursal=${sucursal}&idUsuario=${idUsuario}`;
          console.log(`[FullSync-Cancelacion] 🌐 URL: ${cancelacionUrl}`);
          console.log(`[FullSync-Cancelacion] 📦 Payload:`, JSON.stringify(payload, null, 2));

          const cancelacionResp = await fetch(cancelacionUrl, {
            method: "POST",
            headers: { accept: "application/octet-stream", "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          console.log(
            `[FullSync-Cancelacion] 📡 Respuesta HTTP: ${cancelacionResp.status} ${cancelacionResp.statusText}`,
          );

          if (cancelacionResp.ok) {
            const responseText = await cancelacionResp.text();
            console.log(`[FullSync-Cancelacion] 📥 Respuesta del servidor:`, responseText);

            this.realm.write(() => {
              Array.from(cancelacionesPendientes).forEach((c: any) => {
                c.enviado = true;
              });
            });
            console.log(`[FullSync-Cancelacion] ✅ ${payload.length} cancelaciones enviadas y marcadas como enviado`);
          } else {
            const errorText = await cancelacionResp.text().catch(() => "No se pudo leer el error");
            console.warn(`[FullSync-Cancelacion] ⚠️ Error HTTP ${cancelacionResp.status} enviando cancelaciones`);
            console.warn(`[FullSync-Cancelacion] ⚠️ Detalle del error:`, errorText);
          }
        } else {
          console.log("[FullSync-Cancelacion] ℹ️ No hay cancelaciones pendientes de envío");
        }
      } catch (cancelacionError) {
        console.error("[FullSync-Cancelacion] ❌ Error enviando cancelaciones:", cancelacionError);
      }
    }

    // PASO 2: Enviar reubicaciones pendientes (VentasArrastre depende de esta tabla)
    if (idUsuario) {
      console.log("[FullSync-Reubicacion] 🔍 PASO 2 - Iniciando verificación de reubicaciones pendientes...");
      try {
        const todasReubicaciones = this.realm.objects("Reubicacion");
        console.log(`[FullSync-Reubicacion] Total reubicaciones en BD: ${todasReubicaciones.length}`);

        const reubicacionesPendientes = this.realm.objects("Reubicacion").filtered("enviado == false");
        console.log(`[FullSync-Reubicacion] Reubicaciones con enviado=false: ${reubicacionesPendientes.length}`);

        if (reubicacionesPendientes.length > 0) {
          console.log(
            `[FullSync-Reubicacion] 📤 Enviando ${reubicacionesPendientes.length} reubicaciones pendientes...`,
          );
          console.log(
            `[FullSync-Reubicacion] Detalles de reubicaciones:`,
            Array.from(reubicacionesPendientes).map((r: any) => ({
              id: r.id,
              idCliente: r.idCliente,
              latitud: r.latitud,
              longitud: r.longitud,
              enviado: r.enviado,
              fecha: r.fecha,
            })),
          );

          const reubicacionesPayload = {
            reubicaciones: Array.from(reubicacionesPendientes).map((r: any) => ({
              sucursal: sucursal,
              cveCliente: r.idCliente,
              latitudAnterior: 0,
              longitudAnterior: 0,
              latitudNueva: r.latitud ?? 0,
              longitudNueva: r.longitud ?? 0,
              fecha: (r.fecha ?? this.getMexicoNow()).toISOString(),
              usuario: r.idUsuario ?? idUsuario,
              idMovil: r.id,
              fechaTransfer: this.getMexicoNow().toISOString(),
            })),
          };

          const reubicacionUrl = `${this.apiBaseUrl}/api/SincronizacionMovil/sp_MovilesReubicacionesJSON?sucursal=${sucursal}&idUsuario=${idUsuario}`;
          console.log(`[FullSync-Reubicacion] 🌐 URL: ${reubicacionUrl}`);
          console.log(`[FullSync-Reubicacion] 📦 Payload:`, JSON.stringify(reubicacionesPayload, null, 2));

          const reubicacionResp = await fetch(reubicacionUrl, {
            method: "POST",
            headers: { accept: "application/octet-stream", "Content-Type": "application/json" },
            body: JSON.stringify(reubicacionesPayload),
          });

          console.log(
            `[FullSync-Reubicacion] 📡 Respuesta HTTP: ${reubicacionResp.status} ${reubicacionResp.statusText}`,
          );

          if (reubicacionResp.ok) {
            const responseText = await reubicacionResp.text();
            console.log(`[FullSync-Reubicacion] 📥 Respuesta del servidor:`, responseText);

            this.realm.write(() => {
              Array.from(reubicacionesPendientes).forEach((r: any) => {
                r.enviado = true;
              });
            });
            console.log(
              `[FullSync-Reubicacion] ✅ ${reubicacionesPayload.reubicaciones.length} reubicaciones enviadas y marcadas como enviado`,
            );
          } else {
            const errorText = await reubicacionResp.text().catch(() => "No se pudo leer el error");
            console.warn(`[FullSync-Reubicacion] ⚠️ Error HTTP ${reubicacionResp.status} enviando reubicaciones`);
            console.warn(`[FullSync-Reubicacion] ⚠️ Detalle del error:`, errorText);
          }
        } else {
          console.log("[FullSync-Reubicacion] ℹ️ No hay reubicaciones pendientes de envío");
        }
      } catch (reubicacionError) {
        console.error("[FullSync-Reubicacion] ❌ Error enviando reubicaciones:", reubicacionError);
        console.error(
          "[FullSync-Reubicacion] ❌ Stack:",
          reubicacionError instanceof Error ? reubicacionError.stack : "N/A",
        );
      }
    } else {
      console.log("[FullSync-Reubicacion] ⚠️ No hay idUsuario, saltando envío de reubicaciones");
    }

    // PASO 3: Enviar bitácoras pendientes
    if (idUsuario) {
      try {
        console.log("[FullSync] PASO 3 - Enviando bitácoras pendientes...");
        await BitacoraService.enviarBitacorasPendientes(sucursal, idUsuario);
        console.log("[FullSync] Enviando bitácoras GPS pendientes...");
        await GpsBitacoraService.enviarBitacorasPendientes(sucursal, idUsuario);
      } catch (error) {
        console.warn("[FullSync] Error enviando bitácoras, continuando:", error);
      }
    }

    // PASO 4: Enviar InventarioEnvase pendientes ANTES de ventas
    if (idUsuario) {
      try {
        const envasesPendientes = this.getInventarioEnvasesPendientes();
        console.log("ENVASES PENDIENTES.");
        if (envasesPendientes.length > 0) {
          console.log(`[FullSync] PASO 4 - Enviando ${envasesPendientes.length} InventarioEnvase pendientes...`);
          console.log;
          const envasePayload = envasesPendientes.map((r: any) => ({
            sucursal: r.sucursal ?? sucursal,
            clave_prod: r.claveProd ?? 0,
            folio_movto: r.folioMovto ?? 1,
            cantidad_entrada: r.cantidadEntrada ?? 0,
            cantidad_salida: r.cantidadSalida ?? 0,
            costo: r.costo ?? 0,
            tipo_movto: r.tipoMovto ?? 0,
            fecha_alta: (r.fechaAlta ?? new Date()).toISOString(),
            fecha_act: (r.fechaAct ?? new Date()).toISOString(),
            id_movil: r.idMovil ?? 0,
            observacion: r.observacion ?? "",
          }));
          console.log(envasePayload);
          const envaseUrl = `${this.apiBaseUrl}/api/MovilesVentas/sp_MovilesInventarioEnvasesArrastreJSON?sucursal=${sucursal}&idUsuario=${idUsuario}`;
          const envaseResp = await fetch(envaseUrl, {
            method: "POST",
            headers: { accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify(envasePayload),
          });
          if (envaseResp.ok) {
            console.log(`[FullSync] ✅ ${envasePayload.length} InventarioEnvase enviados`);
            const ids = envasesPendientes.map((r: any) => r.id as string);
            this.marcarInventarioEnvaseSincronizado(ids);
          } else {
            console.warn(`[FullSync] ⚠️ Error HTTP ${envaseResp.status} enviando InventarioEnvase`);
          }
        }
      } catch (envaseError) {
        console.warn("[FullSync] ⚠️ Error enviando InventarioEnvase, continuando:", envaseError);
      }
    }

    // PASO 5: Enviar ventas pendientes al servidor (DESPUÉS de reubicaciones y cancelaciones)
    if (idUsuario) {
      console.log("[FullSync] PASO 5 - Enviando ventas pendientes antes de sincronización incremental...");
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
      message: string,
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
          let last = this.getLastSyncedAr(tableName);

          if (!last) {
            last = new Date();
            last.setDate(last.getDate() - 2);
          }

          const fechaInicial = this.formatDateTimeForApi(last);
          const url = `${this.apiBaseUrl}/api/MovilesVentas/clientes/full?sucursal=${sucursal}`;
          const idBitacora = await BitacoraService.registrarInicioSync(
            tableName,
            "incremental",
            "background",
            idUsuario,
            sucursal,
            url,
          );

          try {
            console.log("[Incremental] Clientes desde", fechaInicial, "sucursal:", sucursal);
            console.log("[Incremental] URL completa:", url);

            const response = await fetch(url, {
              headers: { accept: "application/octet-stream" },
            });
            if (!response.ok) {
              console.error(`[Incremental] Error HTTP ${response.status} al llamar: ${url}`);
              throw new Error(`HTTP ${response.status} Clientes`);
            }

            const clientes = await response.json();
            console.log({ clientes });
            const registrosLeidos = Array.isArray(clientes) ? clientes.length : 0;
            let registrosGuardados = 0;
            let registrosActualizados = 0;
            let registrosEliminados = 0;

            this.realm!.write(() => {
              // Crear un Set con los IDs de clientes del servidor para búsqueda rápida
              const idsDelServidor = new Set(clientes.map((c: any) => c.id));

              // Actualizar/crear clientes del servidor
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

              // Eliminar clientes locales que no están en la respuesta del servidor
              const todosLosClientesLocales = this.realm!.objects("ClienteFull");
              const clientesAEliminar: any[] = [];

              for (const clienteLocal of todosLosClientesLocales) {
                const id = (clienteLocal as any).id;
                if (!idsDelServidor.has(id)) {
                  clientesAEliminar.push(clienteLocal);
                }
              }

              if (clientesAEliminar.length > 0) {
                console.log(
                  `[Incremental] Eliminando ${clientesAEliminar.length} clientes que no están en el servidor`,
                );
                this.realm!.delete(clientesAEliminar);
                registrosEliminados = clientesAEliminar.length;
              }
            });

            console.log(
              `[Incremental] Clientes: leídos=${registrosLeidos}, guardados=${registrosGuardados}, actualizados=${registrosActualizados}, eliminados=${registrosEliminados}`,
            );

            await BitacoraService.registrarFinSync(idBitacora, {
              exitoso: true,
              registrosLeidos,
              registrosGuardados,
              registrosActualizados,
            });

            return {
              tabla: tableName,
              endpoint: url,
              registrosLeidos,
              registrosGuardados,
              registrosActualizados,
            };
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : "Error desconocido";
            await BitacoraService.registrarFinSync(idBitacora, {
              exitoso: false,
              error: errorMsg,
              errorCode: "500",
            });
            throw error;
          }
        },
      },
      {
        name: "UsuariosIncremental",
        run: async () => {
          const tableName = "Usuario";
          const url = `${this.apiBaseUrl}/api/MovilesVentas/usuarios/full`;
          const idBitacora = await BitacoraService.registrarInicioSync(
            tableName,
            "incremental",
            "background",
            idUsuario,
            sucursal,
            url,
          );

          try {
            console.log("[Incremental] Usuarios full desde", url);
            const response = await fetch(url, {
              headers: { accept: "application/json" },
            });
            if (!response.ok) {
              console.error(`[Incremental] Error HTTP ${response.status} al llamar: ${url}`);
              throw new Error(`HTTP ${response.status} Usuarios`);
            }

            const usuarios = await response.json();
            console.log({ usuarios });
            const registrosLeidos = Array.isArray(usuarios) ? usuarios.length : 0;
            let registrosGuardados = 0;
            let registrosActualizados = 0;

            this.realm!.write(() => {
              for (const usuario of usuarios) {
                const existing = this.realm!.objectForPrimaryKey("Usuario", usuario.id) as any;

                const usuarioData: any = {
                  id: usuario.id,
                  nombre: usuario.nombre,
                  perfil: usuario.perfil,
                  descripcionPerfil: usuario.descripcionPerfil,
                  puesto: usuario.puesto,
                  descripcionPuesto: usuario.descripcionPuesto,
                  claveEmpleado: usuario.claveEmpleado,
                  password: usuario.password,
                  sucursalOrigen: usuario.sucursal_origen ?? usuario.sucursalOrigen ?? usuario.sucursal,
                  sucursalNombre: usuario.sucursal_nombre ?? usuario.sucursalNombre ?? null,
                  metros: usuario.metros,
                  reubicacion:
                    typeof usuario.reubicacion === "boolean"
                      ? usuario.reubicacion
                      : usuario.reubicacion === 1
                      ? true
                      : usuario.reubicacion === 0
                      ? false
                      : null,
                  syncedAt: nowMexico,
                };

                if (existing) {
                  this.realm!.create("Usuario", usuarioData, UpdateMode.Modified);
                  registrosActualizados++;
                } else {
                  this.realm!.create("Usuario", usuarioData);
                  registrosGuardados++;
                }
              }
            });

            await BitacoraService.registrarFinSync(idBitacora, {
              exitoso: true,
              registrosLeidos,
              registrosGuardados,
              registrosActualizados,
            });

            return {
              tabla: tableName,
              endpoint: url,
              registrosLeidos,
              registrosGuardados,
              registrosActualizados,
            };
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : "Error desconocido";
            await BitacoraService.registrarFinSync(idBitacora, {
              exitoso: false,
              error: errorMsg,
              errorCode: "500",
            });
            throw error;
          }
        },
      },
      {
        name: "PreciosIncremental",
        run: async () => {
          const tableName = "Precio";
          let last = this.getLastSyncedAr(tableName);

          if (!last) {
            last = new Date();
            last.setDate(last.getDate() - 1);
          }

          const fechaInicial = this.formatDateTimeForApi(last);
          const url = `${this.apiBaseUrl}/api/MovilesVentas/precios?fechaInicial=${encodeURIComponent(fechaInicial)}`;
          const idBitacora = await BitacoraService.registrarInicioSync(
            tableName,
            "incremental",
            "background",
            idUsuario,
            sucursal,
            url,
          );

          try {
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
              `[Incremental] Precios leídos=${registrosLeidos}, guardados=${registrosGuardados}, actualizados=${registrosActualizados}`,
            );

            await BitacoraService.registrarFinSync(idBitacora, {
              exitoso: true,
              registrosLeidos,
              registrosGuardados,
              registrosActualizados,
            });

            return {
              tabla: tableName,
              endpoint: url,
              registrosLeidos,
              registrosGuardados,
              registrosActualizados,
            };
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : "Error desconocido";
            await BitacoraService.registrarFinSync(idBitacora, {
              exitoso: false,
              error: errorMsg,
              errorCode: "500",
            });
            throw error;
          }
        },
      },
      {
        name: "PreciosPromoIncremental",
        run: async () => {
          const tableName = "PrecioPromo";
          let last = this.getLastSyncedAr(tableName);

          if (!last) {
            last = new Date();
            last.setDate(last.getDate() - 1);
          }

          const fechaInicial = this.formatDateTimeForApi(last);
          const url = `${this.apiBaseUrl}/api/MovilesVentas/precios-promo?fechaInicial=${encodeURIComponent(
            fechaInicial,
          )}`;
          const idBitacora = await BitacoraService.registrarInicioSync(
            tableName,
            "incremental",
            "background",
            idUsuario,
            sucursal,
            url,
          );

          try {
            console.log("[Incremental] PreciosPromo desde", fechaInicial, url);

            const response = await fetch(url, {
              headers: { accept: "application/octet-stream" },
            });
            if (!response.ok) {
              throw new Error(`HTTP ${response.status} PreciosPromo`);
            }

            const precios = await response.json();
            const registrosLeidos = Array.isArray(precios) ? precios.length : 0;
            let registrosGuardados = 0;
            let registrosActualizados = 0;

            this.realm!.write(() => {
              for (const precio of precios) {
                const existing = this.realm!.objectForPrimaryKey("PrecioPromo", precio.id) as any;

                const precioData: any = {
                  ...precio,
                  syncedAt: new Date(),
                  syncedAr: nowMexico,
                };

                if (existing) {
                  this.realm!.create("PrecioPromo", precioData, UpdateMode.Modified);
                  registrosActualizados++;
                } else {
                  this.realm!.create("PrecioPromo", precioData);
                  registrosGuardados++;
                }
              }
            });

            console.log(
              `[Incremental] PreciosPromo leídos=${registrosLeidos}, guardados=${registrosGuardados}, actualizados=${registrosActualizados}`,
            );

            await BitacoraService.registrarFinSync(idBitacora, {
              exitoso: true,
              registrosLeidos,
              registrosGuardados,
              registrosActualizados,
            });

            return {
              tabla: tableName,
              endpoint: url,
              registrosLeidos,
              registrosGuardados,
              registrosActualizados,
            };
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : "Error desconocido";
            await BitacoraService.registrarFinSync(idBitacora, {
              exitoso: false,
              error: errorMsg,
              errorCode: "500",
            });
            throw error;
          }
        },
      },
      // {
      //   name: "CarteraIncremental",
      //   run: async () => {
      //     const tableName = "Cartera";
      //     const url = `${this.apiBaseUrl}/api/MovilesVentas/cartera/full`;
      //     const idBitacora = await BitacoraService.registrarInicioSync(
      //       tableName,
      //       "incremental",
      //       "background",
      //       idUsuario,
      //       sucursal,
      //       url,
      //     );

      //     try {
      //       console.log("[Incremental] Cartera full desde", url);

      //       const response = await fetch(url, {
      //         headers: { accept: "application/octet-stream" },
      //       });
      //       if (!response.ok) {
      //         console.error(`[Incremental] Error HTTP ${response.status} al llamar: ${url}`);
      //         throw new Error(`HTTP ${response.status} Cartera`);
      //       }

      //       const cartera = await response.json();
      //       const registrosLeidos = Array.isArray(cartera) ? cartera.length : 0;
      //       let registrosGuardados = 0;
      //       let registrosActualizados = 0;

      //       this.realm!.write(() => {
      //         for (const item of cartera) {
      //           const existing = this.realm!.objectForPrimaryKey("Cartera", item.id) as any;

      //           const carteraData: any = {
      //             ...item,
      //             syncedAt: new Date(),
      //             syncedAr: item.fechaLog ? new Date(item.fechaLog) : null,
      //           };

      //           if (existing) {
      //             this.realm!.create("Cartera", carteraData, UpdateMode.Modified);
      //             registrosActualizados++;
      //           } else {
      //             this.realm!.create("Cartera", carteraData);
      //             registrosGuardados++;
      //           }
      //         }
      //       });

      //       console.log(
      //         `[Incremental] Cartera leídos=${registrosLeidos}, guardados=${registrosGuardados}, actualizados=${registrosActualizados}`,
      //       );

      //       await BitacoraService.registrarFinSync(idBitacora, {
      //         exitoso: true,
      //         registrosLeidos,
      //         registrosGuardados,
      //         registrosActualizados,
      //       });

      //       return {
      //         tabla: tableName,
      //         endpoint: url,
      //         registrosLeidos,
      //         registrosGuardados,
      //         registrosActualizados,
      //       };
      //     } catch (error) {
      //       const errorMsg = error instanceof Error ? error.message : "Error desconocido";
      //       await BitacoraService.registrarFinSync(idBitacora, {
      //         exitoso: false,
      //         error: errorMsg,
      //         errorCode: "500",
      //       });
      //       throw error;
      //     }
      //   },
      // },
      {
        name: "VentasIncremental",
        run: async () => {
          const tableName = "Venta";
          let last = this.getLastSyncedAr(tableName);

          if (!last) {
            last = new Date();
            last.setDate(last.getDate() - 1);
          }

          const fechaInicial = this.formatDateTimeForApi(last);
          const url = `${this.apiBaseUrl}/api/MovilesVentas/ventas/erp-movil?fechaInicial=${encodeURIComponent(
            fechaInicial,
          )}&sucursal=${encodeURIComponent(String(sucursal))}`;
          const idBitacora = await BitacoraService.registrarInicioSync(
            tableName,
            "incremental",
            "background",
            idUsuario,
            sucursal,
            url,
          );

          try {
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
                          venta.claveProd,
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
              `[Incremental] Ventas leídos=${registrosLeidos}, guardados=${registrosGuardados}, actualizados=${registrosActualizados}`,
            );

            await BitacoraService.registrarFinSync(idBitacora, {
              exitoso: true,
              registrosLeidos,
              registrosGuardados,
              registrosActualizados,
            });

            return {
              tabla: tableName,
              endpoint: url,
              registrosLeidos,
              registrosGuardados,
              registrosActualizados,
            };
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : "Error desconocido";
            await BitacoraService.registrarFinSync(idBitacora, {
              exitoso: false,
              error: errorMsg,
              errorCode: "500",
            });
            throw error;
          }
        },
      },
      {
        name: "DetalleVisitasArrastre",
        run: async () => {
          const tableName = "DetalleVisitas";
          const url = `${this.apiBaseUrl}/api/MovilesVentas/sp_MovilesVisitasArrastreJSON?idUsuario=${idUsuario}`;
          const idBitacora = await BitacoraService.registrarInicioSync(
            tableName,
            "incremental",
            "background",
            idUsuario,
            sucursal,
            url,
          );

          try {
            console.log("[Incremental] DetalleVisitas - Enviando visitas pendientes...");

            const fiveMinutesAgo = new Date(nowMexico.getTime() - 5 * 60 * 1000);
            const detallesVisitas = this.realm!.objects("DetalleVisitas").filtered("syncedAt < $0", fiveMinutesAgo);

            if (detallesVisitas.length === 0) {
              console.log("[Incremental] DetalleVisitas - No hay visitas pendientes");

              await BitacoraService.registrarFinSync(idBitacora, {
                exitoso: true,
                registrosLeidos: 0,
                registrosGuardados: 0,
                registrosActualizados: 0,
              });

              return {
                tabla: tableName,
                endpoint: url,
                registrosLeidos: 0,
                registrosGuardados: 0,
                registrosActualizados: 0,
              };
            }

            const isValidDate = (date: Date | null | undefined): boolean => {
              if (!date) return false;
              const year = date.getFullYear();
              // Validar que la fecha esté en un rango razonable para evitar DATEDIFF overflow
              return year >= 1900 && year <= 2100;
            };

            const formatDateForMexico = (date: Date): string => {
              const year = date.getFullYear();
              const month = String(date.getMonth() + 1).padStart(2, "0");
              const day = String(date.getDate()).padStart(2, "0");
              const hours = String(date.getHours()).padStart(2, "0");
              const minutes = String(date.getMinutes()).padStart(2, "0");
              const seconds = String(date.getSeconds()).padStart(2, "0");
              return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
            };

            const nowStr = formatDateForMexico(nowMexico);
            const visitasArray = Array.from(detallesVisitas).map((detalle: any) => ({
              fechaInicio: isValidDate(detalle.fechaInicio) ? formatDateForMexico(detalle.fechaInicio) : nowStr,
              fechaFin: isValidDate(detalle.fechaFin) ? formatDateForMexico(detalle.fechaFin) : nowStr,
              idCliente: detalle.idCliente,
              idUsuario: detalle.idUsuario,
              idRuta: detalle.idRuta,
              tipo: detalle.tipoVisita,
            }));

            console.log(`[Incremental] DetalleVisitas - Enviando ${visitasArray.length} visitas al servidor`);
            console.log("[Incremental] DetalleVisitas - Payload:", JSON.stringify(visitasArray));

            const response = await fetch(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                accept: "application/octet-stream",
              },
              body: JSON.stringify(visitasArray),
            });

            if (!response.ok) {
              const errorText = await response.text().catch(() => "");
              throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
            }

            const nowSync = this.getMexicoNow();
            this.realm!.write(() => {
              for (const detalle of detallesVisitas) {
                (detalle as any).syncedAt = nowSync;
              }
            });

            console.log(`[Incremental] DetalleVisitas - ✅ ${visitasArray.length} visitas sincronizadas`);

            await BitacoraService.registrarFinSync(idBitacora, {
              exitoso: true,
              registrosLeidos: visitasArray.length,
              registrosGuardados: 0,
              registrosActualizados: visitasArray.length,
            });

            return {
              tabla: tableName,
              endpoint: url,
              registrosLeidos: visitasArray.length,
              registrosGuardados: 0,
              registrosActualizados: visitasArray.length,
            };
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : "Error desconocido";
            console.error("[Incremental] DetalleVisitas - Error:", error);

            await BitacoraService.registrarFinSync(idBitacora, {
              exitoso: false,
              error: errorMsg,
              errorCode: "500",
            });

            throw error;
          }
        },
      },
      {
        name: "InventarioIncremental",
        run: async () => {
          const tableName = "Inventario";
          const nowMexico = this.getMexicoNow();
          const fechaMovto = new Date(nowMexico.getTime() - nowMexico.getTimezoneOffset() * 60000).toISOString();
          const url = `${this.apiBaseUrl}/api/MovilesVentas/inventario/erp-movil?sucursal=${encodeURIComponent(
            String(sucursal),
          )}&fechaMovto=${encodeURIComponent(fechaMovto)}`;
          const idBitacora = await BitacoraService.registrarInicioSync(
            tableName,
            "incremental",
            "background",
            idUsuario,
            sucursal,
            url,
          );

          try {
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
              `[Incremental] Inventario leídos=${registrosLeidos}, guardados=${registrosGuardados}, actualizados=${registrosActualizados}`,
            );

            await BitacoraService.registrarFinSync(idBitacora, {
              exitoso: true,
              registrosLeidos,
              registrosGuardados,
              registrosActualizados,
            });

            return {
              tabla: tableName,
              endpoint: url,
              registrosLeidos,
              registrosGuardados,
              registrosActualizados,
            };
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : "Error desconocido";
            await BitacoraService.registrarFinSync(idBitacora, {
              exitoso: false,
              error: errorMsg,
              errorCode: "500",
            });
            throw error;
          }
        },
      },
      {
        name: "InventarioEnvasesHistorialIncremental",
        run: async () => {
          const tableName = "InventarioEnvasesHistorial";
          const url = `${this.apiBaseUrl}/api/MovilesVentas/inventario-envases/full/${sucursal}`;

          try {
            console.log("[Incremental] InventarioEnvasesHistorial desde", url);

            const response = await fetch(url, { headers: { accept: "application/json" } });
            if (!response.ok) {
              throw new Error(`HTTP ${response.status} InventarioEnvasesHistorial`);
            }

            const data = await response.json();
            console.log({ data });
            console.log("INVENTARIO HISTORIAL DE ENVASES ");
            const registrosLeidos = Array.isArray(data) ? data.length : 0;
            const nowMexico = this.getMexicoNow();
            let registrosGuardados = 0;
            let registrosActualizados = 0;

            if (data.length > 0) {
              console.log("[InventarioEnvasesHistorial] Ejemplo item del servidor:", data[0]);
              console.log("[InventarioEnvasesHistorial] fechaMovto del item:", data[0].fechaMovto);
            }

            // Eliminar solo registros con fechaMovto null (datos corruptos de sincronización anterior)
            this.realm!.write(() => {
              const registrosCorruptos =
                this.realm!.objects("InventarioEnvasesHistorial").filtered("fechaMovto == null");
              if (registrosCorruptos.length > 0) {
                console.log(
                  `[InventarioEnvasesHistorial] Eliminando ${registrosCorruptos.length} registros con fechaMovto null...`,
                );
                this.realm!.delete(registrosCorruptos);
              }
            });

            this.realm!.write(() => {
              for (const item of data) {
                const existing = this.realm!.objectForPrimaryKey("InventarioEnvasesHistorial", item.id);
                const record = {
                  id: item.id,
                  sucursal: item.sucursal ?? null,
                  almacen: item.almacen ?? null,
                  claveProd: item.claveProd ?? null,
                  descripcionCorta: item.descripcionCorta ?? null,
                  fechaMovto: item.fechaMovto ? new Date(item.fechaMovto) : null,
                  folioMovto: item.folioMovto ?? null,
                  cantidadEntrada: item.cantidadEntrada ?? null,
                  cantidadSalida: item.cantidadSalida ?? null,
                  tipoMovto: item.tipoMovto ?? null,
                  idMovil: item.idMovil ?? null,
                  syncedAt: nowMexico,
                };
                if (existing) {
                  this.realm!.create("InventarioEnvasesHistorial", record, UpdateMode.Modified);
                  registrosActualizados++;
                } else {
                  this.realm!.create("InventarioEnvasesHistorial", record);
                  registrosGuardados++;
                }
              }
            });

            console.log(
              `[Incremental] InventarioEnvasesHistorial leídos=${registrosLeidos}, guardados=${registrosGuardados}, actualizados=${registrosActualizados}`,
            );

            return { tabla: tableName, endpoint: url, registrosLeidos, registrosGuardados, registrosActualizados };
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : "Error desconocido";
            console.error("[Incremental] InventarioEnvasesHistorial - Error:", errorMsg);
            throw error;
          }
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
    onProgress?: SyncProgressCallback,
    idUsuario: number = 1,
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
      // PASO 1: Enviar bitácoras pendientes al servidor
      try {
        console.log("[FullSync] Enviando bitácoras pendientes...");
        await BitacoraService.enviarBitacorasPendientes(sucursal, idUsuario);
        console.log("[FullSync] Enviando bitácoras GPS pendientes...");
        await GpsBitacoraService.enviarBitacorasPendientes(sucursal, idUsuario);
      } catch (error) {
        console.warn("[FullSync] Error enviando bitácoras, continuando:", error);
      }

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
      const orchestrator = new SyncOrchestrator(this.realm, syncLogId, sucursal, idUsuario, onProgress);

      const result = await orchestrator.executeAll();

      // Actualizar log final
      const fechaFinal = new Date();
      const totalRegistros = Array.from(result.results.values()).reduce(
        (sum, r) => sum + (r.registrosGuardados || 0) + (r.registrosActualizados || 0),
        0,
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
    onProgress?: SyncProgressCallback,
    idUsuario: number = 1,
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
      const orchestrator = new SyncOrchestrator(this.realm, syncLogId, sucursal, idUsuario, onProgress);

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
    if (!this.realm || this.realm.isClosed) return;

    this.realm.write(() => {
      this.realm!.create(
        "SyncStatus",
        {
          id: entity,
          lastSyncDate: new Date(),
          status: success ? "completed" : "failed",
        },
        UpdateMode.Modified,
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
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(this.realm.objects("Venta").sorted("fecha", true).slice(0, limit));
  }

  getVentasPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(
      this.realm
        .objects("Venta")
        .sorted("fecha", true)
        .slice(offset, offset + limit),
    );
  }

  getSyncTableLogsCount(): number {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return 0;
    return this.realm.objects("SyncTableLog").length;
  }

  getVentasBySucursal(sucursal: number, limit: number = 10000): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(
      this.realm.objects("Venta").filtered("sucursal == $0", sucursal).sorted("fecha", true).slice(0, limit),
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
      observacion?: string | null;
    }[],
  ): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    if (!this.realm || this.realm.isClosed) return;

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
          observacion: v.observacion ?? null,
          // Fecha centinela para indicar que aún no se sincroniza
          syncedAt: new Date(0),
        });
      });
    });
  }

  getVentasByMovilId(idMovil: number): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
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
    }[],
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

    if (!this.isInitialized || !this.realm || this.realm.isClosed) {
      console.log("[FullSync] updateInventarioAfterSale: Initializing realm...");
      await this.initialize();
    }
    if (!this.realm || this.realm.isClosed) {
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
            `[FullSync] Kit detectado (idProducto: ${item.idProducto}), descargando ${componentes.length} insumos`,
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
              idInsumo,
            )[0] as any;

            if (inventario) {
              const saldoAnterior = inventario.saldo || 0;
              inventario.saldo = saldoAnterior + cantidadTotal;
              inventario.fechaArrastre = new Date();
              console.log(
                `[FullSync] Insumo ${idInsumo} descargado: ${cantidadTotal} unidades (saldo: ${saldoAnterior} → ${inventario.saldo})`,
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
            idProductoBuscar,
          );
          console.log(
            `[FullSync] Búsqueda inventario sucursal=${item.sucursal}, idProducto=${idProductoBuscar}, encontrados: ${inventarioResults.length}`,
          );

          const inventario = inventarioResults[0] as any;

          if (inventario) {
            const saldoAnterior = inventario.saldo || 0;
            inventario.saldo = saldoAnterior + item.cantidad;
            inventario.fechaArrastre = new Date();
            console.log(
              `[FullSync] Producto id=${idProductoBuscar} descargado: ${item.cantidad} unidades (saldo: ${saldoAnterior} → ${inventario.saldo})`,
            );
          } else {
            console.warn(
              `[FullSync] No se encontró inventario para Producto id=${idProductoBuscar} en Sucursal ${item.sucursal}`,
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
    }[],
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

    if (!this.isInitialized || !this.realm || this.realm.isClosed) {
      console.log("[FullSync] updateInventarioAfterSaleScreen: Initializing realm...");
      await this.initialize();
    }
    if (!this.realm || this.realm.isClosed) {
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
          console.log(item.idProducto, "SAAAA");

          const componentes = this.realm!.objects("Kit").filtered("idProducto == $0", item.idProducto);

          console.log(
            `[FullSync] Kit detectado (idProducto: ${item.idProducto}), descargando ${componentes.length} insumos`,
          );

          componentes.forEach((comp: any) => {
            const idInsumo = comp.idInsumo;
            const cantidadInsumo = comp.cantidad || 0;
            const cantidadTotal = cantidadInsumo * item.cantidad;

            if (!idInsumo || cantidadInsumo <= 0) {
              console.warn(`[FullSync] Componente de kit inválido: idInsumo=${idInsumo}, cantidad=${cantidadInsumo}`);
              return;
            }

            // Buscar el inventario del insumo por idInsumo (que es claveProd) con ID < 10000
            const inventario = this.realm!.objects("Inventario").filtered(
              "sucursal == $0 AND claveProd == $1 AND id < 10000",
              item.sucursal,
              idInsumo,
            )[0] as any;

            if (inventario) {
              const saldoAnterior = inventario.saldo || 0;
              inventario.saldo = saldoAnterior - cantidadTotal;
              inventario.fechaArrastre = new Date();
              console.log(
                `[FullSync] Insumo ${idInsumo} descargado: ${cantidadTotal} unidades (saldo: ${saldoAnterior} → ${inventario.saldo})`,
              );
            } else {
              console.warn(
                `[FullSync] No se encontró inventario (ID<10000) para Insumo ${idInsumo} en Sucursal ${item.sucursal}`,
              );
            }
          });
        } else {
          // No es kit: descontar el producto directamente
          // Buscar por claveProd y SOLO registros con ID < 10000 (sincronizados del servidor)
          const idProductoBuscar = item.idProducto ?? item.claveProd;
          console.log(`[FullSync] Buscando inventario por claveProd: ${idProductoBuscar} (ID < 10000)`);

          const inventarioResults = this.realm!.objects("Inventario").filtered(
            "sucursal == $0 AND claveProd == $1 AND id < 10000",
            item.sucursal,
            idProductoBuscar,
          );

          console.log(
            `[FullSync] Búsqueda inventario sucursal=${item.sucursal}, claveProd=${idProductoBuscar}, ID<10000, encontrados: ${inventarioResults.length}`,
          );

          const inventario = inventarioResults[0] as any;

          if (inventario) {
            const saldoAnterior = inventario.saldo || 0;
            inventario.saldo = saldoAnterior - item.cantidad;
            inventario.fechaArrastre = new Date();
            console.log(
              `[FullSync] Inventario ID=${inventario.id} (claveProd=${inventario.claveProd}) RESTADO: ${item.cantidad} unidades (saldo: ${saldoAnterior} → ${inventario.saldo})`,
            );
          } else {
            console.warn(
              `[FullSync] No se encontró inventario con claveProd=${idProductoBuscar} en Sucursal ${item.sucursal}`,
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
    }[],
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
          item.claveProd,
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
            `[FullSync] No se encontró inventario para Producto ${item.claveProd} en Sucursal ${item.sucursal}`,
          );
        }
      });
    });
  }

  /**
   * Actualiza el inventario SUMANDO las cantidades recibidas en un traspaso.
   * Usa el ID del producto (no claveProd) como índice.
   * Si el producto es un kit, suma los insumos según la tabla Kit.
   * Si no es kit, suma el producto directamente.
   * CREA el renglón si no existe.
   */
  async updateInventarioAfterTraspaso(
    items: {
      sucursal: number;
      claveProd: number;
      cantidad: number;
      esKit?: boolean;
      idProducto?: number;
    }[],
  ): Promise<void> {
    console.log("[FullSync] updateInventarioAfterTraspaso called with", {
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
      console.log("[FullSync] updateInventarioAfterTraspaso: No items to process");
      return;
    }

    if (!this.isInitialized || !this.realm || this.realm.isClosed) {
      console.log("[FullSync] updateInventarioAfterTraspaso: Initializing realm...");
      await this.initialize();
    }
    if (!this.realm || this.realm.isClosed) {
      console.error("[FullSync] updateInventarioAfterTraspaso: Realm not available after init!");
      return;
    }

    console.log("[FullSync] updateInventarioAfterTraspaso: Starting realm.write()");
    this.realm.write(() => {
      items.forEach((item, index) => {
        console.log(`[FullSync] Processing traspaso item ${index + 1}/${items.length}:`, {
          sucursal: item.sucursal,
          claveProd: item.claveProd,
          cantidad: item.cantidad,
          esKit: item.esKit,
          idProducto: item.idProducto,
        });

        if (item.esKit && item.idProducto) {
          // Es un kit: SUMAR los insumos según la tabla Kit
          const componentes = this.realm!.objects("Kit").filtered("idProducto == $0", item.idProducto);

          console.log(
            `[FullSync] Kit detectado (idProducto: ${item.idProducto}), sumando ${componentes.length} insumos`,
          );

          componentes.forEach((comp: any) => {
            const idInsumo = comp.idInsumo;
            const cantidadInsumo = comp.cantidad || 0;
            const cantidadTotal = cantidadInsumo * item.cantidad;

            if (!idInsumo || cantidadInsumo <= 0) {
              console.warn(`[FullSync] Componente de kit inválido: idInsumo=${idInsumo}, cantidad=${cantidadInsumo}`);
              return;
            }

            // Buscar inventario del insumo con ID < 10000 (sincronizado del servidor)
            const inventario = this.realm!.objects("Inventario").filtered(
              "sucursal == $0 AND claveProd == $1 AND id < 10000",
              item.sucursal,
              idInsumo,
            )[0] as any;

            if (inventario) {
              const saldoAnterior = inventario.saldo || 0;
              inventario.saldo = saldoAnterior + cantidadTotal;
              inventario.fechaArrastre = new Date();
              console.log(
                `[FullSync] Insumo ${idInsumo} SUMADO: ${cantidadTotal} unidades (saldo: ${saldoAnterior} → ${inventario.saldo})`,
              );
            } else {
              // Crear renglón si no existe
              // IMPORTANTE: El ID del inventario debe ser igual al idInsumo (claveProd)
              this.realm!.create("Inventario", {
                id: idInsumo,
                sucursal: item.sucursal,
                claveProd: idInsumo,
                saldo: cantidadTotal,
                fechaArrastre: new Date(),
                descripcion: null,
                syncedAt: new Date(0),
              });
              console.log(
                `[FullSync] Insumo ${idInsumo} CREADO con saldo: ${cantidadTotal} (ID inventario: ${idInsumo})`,
              );
            }
          });
        } else {
          // No es kit: SUMAR el producto directamente
          // Buscar por ID del inventario (que debe ser igual al ID del producto)
          const idInventarioBuscar = item.idProducto;
          console.log(`[FullSync] Buscando inventario por ID: ${idInventarioBuscar} (idProducto: ${item.idProducto})`);

          const inventarioResults = this.realm!.objects("Inventario").filtered(
            "sucursal == $0 AND id == $1",
            item.sucursal,
            idInventarioBuscar,
          );
          console.log(
            `[FullSync] Búsqueda inventario sucursal=${item.sucursal}, id=${idInventarioBuscar}, encontrados: ${inventarioResults.length}`,
          );

          const inventario = inventarioResults[0] as any;

          if (inventario) {
            const saldoAnterior = inventario.saldo || 0;
            inventario.saldo = saldoAnterior + item.cantidad;
            inventario.fechaArrastre = new Date();

            // Actualizar descripción si no existe
            if (!inventario.descripcion) {
              const producto = this.realm!.objects("Producto").filtered("id == $0", idInventarioBuscar)[0] as any;
              if (producto) {
                inventario.descripcion = producto.descripcion || null;
              }
            }

            console.log(
              `[FullSync] Inventario ID=${inventario.id} (claveProd=${inventario.claveProd}) SUMADO: ${item.cantidad} unidades (saldo: ${saldoAnterior} → ${inventario.saldo})`,
            );
          } else {
            // Crear renglón si no existe
            // IMPORTANTE: El ID del inventario debe ser igual al ID del producto
            // Buscar descripción del producto
            const producto = this.realm!.objects("Producto").filtered("id == $0", idInventarioBuscar)[0] as any;
            const descripcion = producto?.descripcion || null;

            this.realm!.create("Inventario", {
              id: idInventarioBuscar,
              sucursal: item.sucursal,
              claveProd: idInventarioBuscar,
              saldo: item.cantidad,
              fechaArrastre: new Date(),
              descripcion: descripcion,
              syncedAt: new Date(0),
            });
            console.log(
              `[FullSync] Inventario ID=${idInventarioBuscar} CREADO con saldo: ${item.cantidad}, descripcion: ${descripcion}`,
            );
          }
        }
      });
    });
    console.log("[FullSync] updateInventarioAfterTraspaso: realm.write() completed successfully");
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
    }[],
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
    }[],
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
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(this.realm.objects("Usuario").sorted("nombre").slice(0, limit));
  }

  getUsuariosPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(
      this.realm
        .objects("Usuario")
        .sorted("nombre")
        .slice(offset, offset + limit),
    );
  }

  getProductos(limit: number = 100): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(this.realm.objects("Producto").sorted("descripcion").slice(0, limit));
  }

  getProductosPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(
      this.realm
        .objects("Producto")
        .sorted("descripcion")
        .slice(offset, offset + limit),
    );
  }

  /**
   * Obtiene todos los kits (relación producto-insumo)
   */
  getKits(limit: number = 100): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(this.realm.objects("Kit").slice(0, limit));
  }

  /**
   * Obtiene kits con paginación
   */
  getKitsPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(this.realm.objects("Kit").slice(offset, offset + limit));
  }

  /**
   * Obtiene los kits (insumos) de un producto específico
   */
  getKitsByProducto(idProducto: number): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(this.realm.objects("Kit").filtered("idProducto == $0", idProducto));
  }

  /**
   * Obtiene los productos que usan un insumo específico
   */
  getKitsByInsumo(idInsumo: number): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
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
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(this.realm.objects("Precio").sorted("descripcion").slice(0, limit));
  }

  getPreciosPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(
      this.realm
        .objects("Precio")
        .sorted("descripcion")
        .slice(offset, offset + limit),
    );
  }

  getInventario(limit: number = 10000000): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(this.realm.objects("Inventario").slice(0, limit));
  }

  getInventarioPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(this.realm.objects("Inventario").slice(offset, offset + limit));
  }

  getCartera(limit: number = 100): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(this.realm.objects("Cartera").sorted("nombreCliente").slice(0, limit));
  }

  getCarteraPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(
      this.realm
        .objects("Cartera")
        .sorted("nombreCliente")
        .slice(offset, offset + limit),
    );
  }

  getVentasTotalEfectivoForDate(date: Date, sucursal?: number): number {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return 0;

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
  getVentasForDate(startOfDay: Date, endOfDay: Date, sucursal?: number): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    let query = "fecha >= $0 AND fecha <= $1";
    const args: any[] = [startOfDay, endOfDay];
    if (sucursal !== undefined) {
      query += " AND sucursal == $2";
      args.push(sucursal);
    }
    return Array.from(this.realm.objects("Venta").filtered(query, ...args));
  }

  getInventarioABordoForDate(startOfDay: Date, endOfDay: Date, sucursal?: number): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    const todos = Array.from(this.realm.objects("Inventario")) as any[];
    return todos.filter((item: any) => {
      const fa = item.fechaArrastre;
      if (!fa) return false;
      const d = fa instanceof Date ? fa : new Date(fa);
      const inRange = d >= startOfDay && d <= endOfDay;
      const inSucursal = sucursal === undefined || item.sucursal === sucursal;
      return inRange && inSucursal && (item.saldo || 0) > 0;
    });
  }

  getTodosEnvasesHistorial(startOfDay: Date, endOfDay: Date): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) {
      return [];
    }

    console.log("[getTodosEnvasesHistorial] Buscando entre:", startOfDay, "y", endOfDay);

    const todosLosRegistros = Array.from(this.realm.objects("InventarioEnvasesHistorial")) as any[];
    console.log("[getTodosEnvasesHistorial] Total registros en Realm:", todosLosRegistros.length);
    if (todosLosRegistros.length > 0) {
      console.log("[getTodosEnvasesHistorial] Ejemplo de fechas almacenadas:", {
        primera: todosLosRegistros[0]?.fechaMovto,
        ultima: todosLosRegistros[todosLosRegistros.length - 1]?.fechaMovto,
      });
    }

    const registros = Array.from(
      this.realm
        .objects("InventarioEnvasesHistorial")
        .filtered("fechaMovto >= $0 AND fechaMovto <= $1", startOfDay, endOfDay),
    ) as any[];

    console.log("[getTodosEnvasesHistorial] Registros filtrados:", registros.length);

    return registros.map((r) => ({
      id: r.id,
      sucursal: r.sucursal,
      almacen: r.almacen,
      claveProd: r.claveProd,
      descripcionCorta: r.descripcionCorta,
      fechaMovto: r.fechaMovto,
      folioMovto: r.folioMovto,
      cantidadEntrada: r.cantidadEntrada,
      cantidadSalida: r.cantidadSalida,
      tipoMovto: r.tipoMovto,
      idMovil: r.idMovil,
    }));
  }

  getEnvasesHistorialForDate(
    startOfDay: Date,
    endOfDay: Date,
  ): {
    envVendido: number;
    envCambiado: number;
    envPrestado: number;
    cambiadosPorProducto: Array<{ descripcionCorta: string; claveProd: number; cantidadEntrada: number }>;
  } {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) {
      return { envVendido: 0, envCambiado: 0, envPrestado: 0, cambiadosPorProducto: [] };
    }

    console.log("[getEnvasesHistorialForDate] Buscando entre:", startOfDay, "y", endOfDay);

    const registros = Array.from(
      this.realm
        .objects("InventarioEnvasesHistorial")
        .filtered("fechaMovto >= $0 AND fechaMovto <= $1", startOfDay, endOfDay),
    ) as any[];

    console.log("[getEnvasesHistorialForDate] Registros encontrados:", registros.length);

    let envVendido = 0;
    let envCambiado = 0;
    let envPrestado = 0;
    const cambiadosPorProd: Record<number, { descripcionCorta: string; cantidadEntrada: number }> = {};

    for (const r of registros) {
      const tipo: number = r.tipoMovto ?? 0;
      const clave: number = r.claveProd ?? 0;
      const salida: number = r.cantidadSalida ?? 0;
      const entrada: number = r.cantidadEntrada ?? 0;

      if (tipo === 2 && clave === 18) {
        envVendido += salida;
      } else if (tipo === 1100 && clave === 18) {
        envCambiado += salida;
      } else if (tipo === 1200 && clave === 18) {
        envPrestado += salida;
      }

      if (tipo === 1000 && entrada > 0) {
        if (!cambiadosPorProd[clave]) {
          cambiadosPorProd[clave] = { descripcionCorta: r.descripcionCorta ?? String(clave), cantidadEntrada: 0 };
        }
        cambiadosPorProd[clave].cantidadEntrada += entrada;
      }
    }

    const cambiadosPorProducto = Object.entries(cambiadosPorProd).map(([clave, val]) => ({
      claveProd: parseInt(clave, 10),
      descripcionCorta: val.descripcionCorta,
      cantidadEntrada: val.cantidadEntrada,
    }));

    return { envVendido, envCambiado, envPrestado, cambiadosPorProducto };
  }

  getRutaForDate(startOfDay: Date, endOfDay: Date): string {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return "";
    try {
      const visitas = this.realm.objects("Visita").filtered("fecha >= $0 AND fecha <= $1", startOfDay, endOfDay);
      if (visitas.length > 0) {
        return (visitas[0] as any).ruta || "";
      }
    } catch (_e) {}
    return "";
  }

  getClientesFull(limit: number = 100): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(this.realm.objects("ClienteFull").sorted("nombre").slice(0, limit));
  }

  getClientesFullPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(
      this.realm
        .objects("ClienteFull")
        .sorted("nombre")
        .slice(offset, offset + limit),
    );
  }

  getClienteFullById(idCliente: number): any | null {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return null;
    const obj = this.realm.objectForPrimaryKey("ClienteFull", idCliente);
    return obj || null;
  }

  getPreciosByCliente(idCliente: number): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(this.realm.objects("Precio").filtered("idCliente == $0", idCliente));
  }

  getPreciosByListaPrecio(listaPrecio: number): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(this.realm.objects("Precio").filtered("listaPrecio == $0", listaPrecio));
  }

  getPreciosPromo(limit: number = 100): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(this.realm.objects("PrecioPromo").sorted("descripcion").slice(0, limit));
  }

  getPreciosPromoPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(
      this.realm
        .objects("PrecioPromo")
        .sorted("descripcion")
        .slice(offset, offset + limit),
    );
  }

  getPreciosPromoByCliente(idCliente: number): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    // Incluir precios promo específicos del cliente Y precios promo generales (idCliente == null o 0)
    return Array.from(
      this.realm.objects("PrecioPromo").filtered("idCliente == $0 OR idCliente == null OR idCliente == 0", idCliente),
    );
  }

  getPreciosPromoByProducto(claveProd: number): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(this.realm.objects("PrecioPromo").filtered("claveProd == $0", claveProd));
  }

  getSyncStatus(entity: string = "all"): any {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return null;
    return this.realm.objectForPrimaryKey("SyncStatus", entity);
  }
  getTipoVisita(): any {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return null;
    const tipoVisitas = this.realm.objects("TipoVisita");
    return tipoVisitas.length > 0 ? tipoVisitas[0] : null;
  }

  getTipoVisitas(): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    const tipoVisitas = this.realm.objects("TipoVisita");
    return Array.from(tipoVisitas);
  }

  getUsuarioById(id: number): any {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return null;
    return this.realm.objectForPrimaryKey("Usuario", id);
  }

  isServiceInitialized(): boolean {
    return this.isInitialized;
  }

  getSyncTableLogsPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(
      this.realm
        .objects("SyncTableLog")
        .sorted("fechaInicio", true) // Más recientes primero
        .slice(offset, offset + limit),
    );
  }

  getSyncStatusPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(
      this.realm
        .objects("SyncStatus")
        .sorted("lastSyncDate", true)
        .slice(offset, offset + limit),
    );
  }

  getSyncLogsPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(
      this.realm
        .objects("SyncLog")
        .sorted("fechaInicio", true)
        .slice(offset, offset + limit),
    );
  }

  getCierreRutaPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(
      this.realm
        .objects("CierreRuta")
        .sorted("updatedAt", true)
        .slice(offset, offset + limit),
    );
  }

  getDetalleVisitasPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(
      this.realm
        .objects("DetalleVisitas")
        .sorted("fechaInicio", true)
        .slice(offset, offset + limit),
    );
  }

  getTipoVisitasPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(this.realm.objects("TipoVisita").slice(offset, offset + limit));
  }

  getBitacoraSyncPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(
      this.realm
        .objects("BitacoraSync")
        .sorted("fechaInicio", true)
        .slice(offset, offset + limit),
    );
  }

  getBitacoraGpsPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(
      this.realm
        .objects("BitacoraGps")
        .sorted("fecha", true)
        .slice(offset, offset + limit),
    );
  }

  getInventarioEnvasePaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(this.realm.objects("InventarioEnvase").slice(offset, offset + limit));
  }

  getInventarioEnvasesHistorialPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(
      this.realm
        .objects("InventarioEnvasesHistorial")
        .sorted("fechaMovto", true)
        .slice(offset, offset + limit),
    );
  }

  getReubicacionesPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(
      this.realm
        .objects("Reubicacion")
        .sorted("fecha", true)
        .slice(offset, offset + limit),
    );
  }

  getVisitasRealizadasPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(
      this.realm
        .objects("VisitaRealizada")
        .sorted("fechaInicio", true)
        .slice(offset, offset + limit),
    );
  }

  /**
   * Envía las ventas locales pendientes al servidor.
   * Solo envía ventas con id >= LOCAL_SALE_ID_THRESHOLD y noVenta === 0.
   * Se puede usar desde SalesScreen o desde la sincronización periódica.
   */
  async sendPendingVentasToServer(
    sucursal: number,
    idUsuario: number,
  ): Promise<{ success: boolean; sent: number; error?: string }> {
    const LOCAL_SALE_ID_THRESHOLD = 1700000000;

    try {
      if (!this.isInitialized || !this.realm || this.realm.isClosed) {
        await this.initialize();
      }
      if (!this.realm || this.realm.isClosed) {
        return { success: false, sent: 0, error: "Realm no inicializado o cerrado" };
      }

      const ventasRealm = this.getVentas();

      // Solo enviar ventas locales (id >= threshold) y sin número de venta asignado
      const ventasLocales = ventasRealm.filter(
        (venta: any) => venta.noVenta === 0 && venta.id >= LOCAL_SALE_ID_THRESHOLD,
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
          fecha: this.formatMexicoDateForServer(venta.fecha ?? this.getMexicoNow()),
          tipo_pago: venta.tipoPago ?? 1,
          usuario: idUsuario,
          longitud: venta?.longitud ?? 0,
          latitud: venta?.latitud ?? 0,
          id_movil: venta.idMovil,
          fechaTransfer: this.formatMexicoDateForServer(this.getMexicoNow()),
          observacion: venta.observacion ?? "",
          folio_movto: 1,
        };
      });

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
      console.log({ payload });
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

  /**
   * Sincroniza el inventario incremental desde el servidor
   * Usado después de recibir traspasos para actualizar el inventario local
   */
  async syncInventarioIncremental(sucursal: number, idUsuario: number): Promise<void> {
    if (!this.isInitialized || !this.realm) {
      await this.initialize();
    }
    if (!this.realm) {
      throw new Error("Realm no disponible");
    }

    const tableName = "Inventario";
    const nowMexico = this.getMexicoNow();
    const fechaMovto = new Date(nowMexico.getTime() - nowMexico.getTimezoneOffset() * 60000).toISOString();
    const url = `${this.apiBaseUrl}/api/MovilesVentas/inventario/erp-movil?sucursal=${encodeURIComponent(
      String(sucursal),
    )}&fechaMovto=${encodeURIComponent(fechaMovto)}`;

    console.log(`[FullSync] Sincronizando inventario incremental desde: ${url}`);

    const response = await fetch(url, {
      headers: { accept: "application/octet-stream" },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} al sincronizar inventario`);
    }

    const inventario = await response.json();
    const registrosLeidos = Array.isArray(inventario) ? inventario.length : 0;
    let registrosGuardados = 0;
    let registrosActualizados = 0;

    this.realm.write(() => {
      for (const item of inventario) {
        const existing = this.realm!.objectForPrimaryKey("Inventario", item.id);

        const inventarioData = {
          ...item,
          sucursal: sucursal,
          syncedAt: item.fechaArrastre ? new Date(item.fechaArrastre) : new Date(),
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
      `[FullSync] Inventario sincronizado: leídos=${registrosLeidos}, guardados=${registrosGuardados}, actualizados=${registrosActualizados}`,
    );
  }

  /**
   * Crea registros locales de InventarioEnvase en Realm.
   * Se usa para registrar movimientos de envases (intercambio/préstamo).
   */
  async createLocalInventarioEnvase(
    items: {
      sucursal: number;
      claveProd: number;
      folioMovto: number;
      cantidadEntrada: number;
      cantidadSalida: number;
      costo: number;
      tipoMovto: number;
      idMovil: number;
      observacion: string;
    }[],
  ): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    if (!this.realm || this.realm.isClosed) return;

    const nowMexico = this.getMexicoNow();
    this.realm.write(() => {
      items.forEach((item) => {
        const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        this.realm!.create("InventarioEnvase", {
          id,
          sucursal: item.sucursal,
          claveProd: item.claveProd,
          folioMovto: item.folioMovto,
          cantidadEntrada: item.cantidadEntrada,
          cantidadSalida: item.cantidadSalida,
          costo: item.costo,
          tipoMovto: item.tipoMovto,
          fechaAlta: nowMexico,
          fechaAct: nowMexico,
          idMovil: item.idMovil,
          observacion: item.observacion || null,
          syncedAt: new Date(0),
        });
      });
    });

    console.log(`[FullSync] ✅ ${items.length} registros de InventarioEnvase creados`);
  }

  /**
   * Obtiene registros de InventarioEnvase pendientes de sincronizar.
   * (syncedAt = epoch 0 indica que no se ha sincronizado)
   */
  getInventarioEnvasesPendientes(): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    const epoch = new Date(0);
    return Array.from(this.realm.objects("InventarioEnvase").filtered("syncedAt == $0", epoch));
  }

  /**
   * Marca registros de InventarioEnvase como sincronizados.
   */
  marcarInventarioEnvaseSincronizado(ids: string[]): void {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return;
    const now = new Date();
    this.realm.write(() => {
      ids.forEach((id) => {
        const record = this.realm!.objectForPrimaryKey("InventarioEnvase", id) as any;
        if (record) {
          record.syncedAt = now;
        }
      });
    });
  }

  /**
   * Busca productos cuya descripción contenga un texto dado (case-insensitive).
   */
  getProductosByDescripcion(texto: string, limit: number = 100): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(this.realm.objects("Producto").filtered("descripcion CONTAINS[c] $0", texto).slice(0, limit));
  }

  /**
   * Obtiene productos que tienen envaseRecibe = true (productos que pueden recibirse en intercambio).
   */
  getProductosEnvaseRecibe(limit: number = 100): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(this.realm.objects("Producto").filtered("envaseRecibe == true").slice(0, limit));
  }

  /**
   * Busca un producto por su claveProd.
   */
  getProductoByClaveProd(claveProd: string): any | null {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return null;
    const productos = this.realm.objects("Producto").filtered("claveProd == $0", claveProd);
    return productos.length > 0 ? productos[0] : null;
  }

  getStats(): any {
    if (!this.isInitialized || !this.realm) {
      return {
        ventas: 0,
        usuarios: 0,
        productos: 0,
        kits: 0,
        precios: 0,
        preciosPromo: 0,
        inventario: 0,
        cartera: 0,
        clientes: 0,
        syncStatus: 0,
        syncLog: 0,
        bitacora: 0,
        cierreRuta: 0,
        detalleVisitas: 0,
        tipoVisita: 0,
        bitacoraSync: 0,
        inventarioEnvase: 0,
        bitacoraGps: 0,
        inventarioEnvasesHistorial: 0,
        reubicaciones: 0,
        visitasRealizadas: 0,
      };
    }

    return {
      ventas: this.realm.objects("Venta").length,
      usuarios: this.realm.objects("Usuario").length,
      productos: this.realm.objects("Producto").length,
      kits: this.realm.objects("Kit").length,
      precios: this.realm.objects("Precio").length,
      preciosPromo: this.realm.objects("PrecioPromo").length,
      inventario: this.realm.objects("Inventario").length,
      cartera: this.realm.objects("Cartera").length,
      clientes: this.realm.objects("ClienteFull").length,
      syncStatus: this.realm.objects("SyncStatus").length,
      syncLog: this.realm.objects("SyncLog").length,
      bitacora: this.realm.objects("SyncTableLog").length,
      cierreRuta: this.realm.objects("CierreRuta").length,
      detalleVisitas: this.realm.objects("DetalleVisitas").length,
      tipoVisita: this.realm.objects("TipoVisita").length,
      bitacoraSync: this.realm.objects("BitacoraSync").length,
      inventarioEnvase: this.realm.objects("InventarioEnvase").length,
      bitacoraGps: this.realm.objects("BitacoraGps").length,
      inventarioEnvasesHistorial: this.realm.objects("InventarioEnvasesHistorial").length,
      reubicaciones: this.realm.objects("Reubicacion").length,
      visitasRealizadas: this.realm.objects("VisitaRealizada").length,
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
