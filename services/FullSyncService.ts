import Realm, { UpdateMode } from "realm";
import { allSchemas, SyncLogSchema } from "./RealmSchemas";
import { SyncProgress } from "./sync/SyncTask";
import { SyncOrchestrator } from "./sync/SyncOrchestrator";
import { ConsoleLogger } from "@microsoft/signalr/dist/esm/Utils";
import BitacoraService from "./BitacoraService";
import GpsBitacoraService from "./GpsBitacoraService";
import ReubicacionService from "./ReubicacionService";
import { fetchWithTimeout } from "./fetchWithTimeout";

export type { SyncProgress };
export type SyncProgressCallback = (progress: SyncProgress) => void;

class FullSyncService {
  private realm: Realm | null = null;
  private isInitialized = false;
  private apiBaseUrl = "https://api.cbinformatica.net:9031";
  private cierreRutaSendInFlight: Promise<{ success: boolean; sent: number; error?: string }> | null = null;

  async initialize(): Promise<void> {
    if (this.isInitialized && this.realm && !this.realm.isClosed) {
      return;
    }

    try {
      this.realm = await Realm.open({
        path: "FullSyncDB",
        schema: allSchemas,
        schemaVersion: 51,
        onMigration: (oldRealm: Realm, newRealm: Realm) => {
          // Migración v51: Campos completos de snapshot en PedidoBitacora (id_movil, precio, observaciones, etc.)
          if (oldRealm.schemaVersion < 51) {
            console.log("[Migration v51] Ampliando esquema de PedidoBitacora para snapshot completo");
          }

          // Migración v50: Nuevas tablas para módulo de Pedidos (Pedido, PedidoDetalle, PedidoBitacora, catálogos)
          if (oldRealm.schemaVersion < 50) {
            console.log("[Migration v50] Creando tablas de Pedidos y catálogos");
          }

          // Migración v49: Agregar campos de auditoría a Reubicacion (latitudAnterior, longitudAnterior, accuracy, numFixes, metrosMovidos)
          if (oldRealm.schemaVersion < 49) {
            console.log("[Migration v49] Agregando campos de auditoría a Reubicacion");
          }

          // Migración v48: Nueva tabla BitacoraTiemposVenta (medición de tiempos del cierre de venta)
          if (oldRealm.schemaVersion < 48) {
            console.log("[Migration v48] Creando tabla BitacoraTiemposVenta");
          }

          // Migración v47: Nueva tabla BitacoraValidacion (diagnóstico de validaciones GPS)
          if (oldRealm.schemaVersion < 47) {
            console.log("[Migration v47] Creando tabla BitacoraValidacion");
          }

          // Migración v46: Agregar campo ruta a Usuario
          if (oldRealm.schemaVersion < 46) {
            console.log("[Migration v46] Agregando campo ruta a Usuario");
          }

          // Migración v45: Agregar campo conCobertura a DetalleVisitas y BitacoraGps, y tabla RouteConfig
          if (oldRealm.schemaVersion < 45) {
            console.log("[Migration v45] Agregando conCobertura y RouteConfig");
          }

          // Migración v44: Agregar campos sincronizado y agenda a DetalleVisitas
          if (oldRealm.schemaVersion < 44) {
            console.log("[Migration v44] Agregando campos sincronizado y agenda a DetalleVisitas");
          }

          // Migración v43: Agregar campo dobleTicket a Usuario
          if (oldRealm.schemaVersion < 43) {
            console.log("[Migration v43] Agregando campo dobleTicket a Usuario");
          }

          // Migración v42: Agregar campo precioCatalogo a Producto y noPrecioCatalogo a Kit
          if (oldRealm.schemaVersion < 42) {
            console.log("[Migration v42] Agregando campo precioCatalogo a Producto y noPrecioCatalogo a Kit");
          }

          // Migración v41: Agregar campo idEmpresa a ClienteFull
          if (oldRealm.schemaVersion < 41) {
            console.log("[Migration v41] Agregando campo idEmpresa a ClienteFull");
          }

          // Migración v40: Nueva tabla Cia para compañías
          if (oldRealm.schemaVersion < 40) {
            console.log("[Migration v40] Creando tabla Cia");
          }

          // Migración v39: Cambiar cantRecEnvOtro de bool a int en Kit
          if (oldRealm.schemaVersion < 39) {
            console.log("[Migration v39] Cambiando tipo de cantRecEnvOtro de bool a int en Kit");
          }

          // Migración v38: Agregar campo cantRecEnvOtro a Kit (obsoleto, reemplazado por v39)
          if (oldRealm.schemaVersion < 38) {
            console.log("[Migration v38] Agregando campo cantRecEnvOtro a Kit");
          }

          // Migración v37: Agregar campo domicilio a ClienteFull y permisoDomicilioTicket a Usuario
          if (oldRealm.schemaVersion < 37) {
            console.log("[Migration v37] Agregando domicilio a ClienteFull y permisoDomicilioTicket a Usuario");
          }

          // Migración v36: Agregar campo precioEnvase a KitIntercambio y omitirMovil a Producto
          if (oldRealm.schemaVersion < 36) {
            console.log("[Migration v36] Agregando precioEnvase a KitIntercambio y omitirMovil a Producto");
          }

          // Migración v35: Agregar campo envaseVendido a Kit
          if (oldRealm.schemaVersion < 35) {
            console.log("[Migration v35] Agregando campo envaseVendido a Kit");
          }

          // Migración v34: Agregar campo inventariable a Producto
          if (oldRealm.schemaVersion < 34) {
            console.log("[Migration v34] Agregando campo inventariable a Producto");
          }

          // Migración v33: Nueva tabla KitIntercambio para intercambios de envases
          if (oldRealm.schemaVersion < 33) {
            console.log("[Migration v33] Creando tabla KitIntercambio");
          }

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

          // Migración v29: Nueva tabla FormaPago para formas de pago dinámicas
          if (oldRealm.schemaVersion < 29) {
            console.log("[Migration v29] Creando tabla FormaPago");
          }

          // Migración v30: Agregar intercambio a Producto y envaseIntercambio a Kit
          if (oldRealm.schemaVersion < 30) {
            console.log("[Migration v30] Agregando campo intercambio a Producto y envaseIntercambio a Kit");
          }

          // Migración v31: Agregar envasePrestado a Kit
          if (oldRealm.schemaVersion < 31) {
            console.log("[Migration v31] Agregando campo envasePrestado a Kit");
          }

          // Migración v32: Agregar recuperaEnvase, claveIntercambio, recuperaEnvaseOtro, controlPresamo a Kit
          if (oldRealm.schemaVersion < 32) {
            console.log(
              "[Migration v32] Agregando campos recuperaEnvase, claveIntercambio, recuperaEnvaseOtro, controlPresamo a Kit",
            );
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

      // Inyectar a VentaModificacionService
      const VentaModificacionService = (await import("./VentaModificacionService")).default;
      VentaModificacionService.getInstance().setRealm(this.realm);

      // Inyectar a RouteTrackingService
      const RouteTrackingService = (await import("./RouteTrackingService")).default;
      RouteTrackingService.setRealm(this.realm);

      // Inyectar a PedidosService
      const PedidosService = (await import("./PedidosService")).default;
      PedidosService.getInstance().setRealm(this.realm);

      // Inyectar a PedidoNotificacionService
      const PedidoNotificacionService = (await import("./PedidoNotificacionService")).default;
      PedidoNotificacionService.setRealm(this.realm);

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
    // Obtener la hora actual en la zona horaria de México usando toLocaleString
    const now = new Date();

    // Crear un string ISO con la hora de México
    const mexicoTimeString = now.toLocaleString("en-US", {
      timeZone: "America/Mexico_City",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    // El string viene en formato: "MM/DD/YYYY, HH:mm:ss"
    // Necesitamos parsearlo y crear un Date
    const [datePart, timePart] = mexicoTimeString.split(", ");
    const [month, day, year] = datePart.split("/");
    const [hour, minute, second] = timePart.split(":");

    // Crear fecha con los valores de México como si fueran locales
    // Esto representa la hora de México en el dispositivo
    const mexicoDate = new Date(
      parseInt(year, 10),
      parseInt(month, 10) - 1, // mes es 0-indexed
      parseInt(day, 10),
      parseInt(hour, 10),
      parseInt(minute, 10),
      parseInt(second, 10),
    );

    return mexicoDate;
  }

  /**
   * Formatea una fecha de México en formato ISO sin conversión a UTC.
   * Útil para enviar al servidor preservando la hora local de México.
   */
  formatMexicoDateForServer(date: Date): string {
    // El Date ahora almacena la hora de México como hora local
    // Por lo tanto, usamos get* (sin UTC) para leer los componentes sin conversión
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    const ms = String(date.getMilliseconds()).padStart(3, "0");
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
    isCancelled?: () => boolean,
  ): Promise<{ success: boolean; error?: string; cancelled?: boolean }> {
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
          console.log(
            `[FullSync-Cancelacion] 📤 Enviando ${cancelacionesPendientes.length} cancelaciones pendientes...`,
          );

          const formatDate = (date: Date): string => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, "0");
            const day = String(date.getDate()).padStart(2, "0");
            const hours = String(date.getHours()).padStart(2, "0");
            const minutes = String(date.getMinutes()).padStart(2, "0");
            const seconds = String(date.getSeconds()).padStart(2, "0");
            return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
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

          const cancelacionResp = await fetchWithTimeout(cancelacionUrl, {
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

    // PASO 1.5: Enviar modificaciones de ventas pendientes (quitar renglón)
    if (idUsuario) {
      console.log("[FullSync] PASO 1.5 - Enviando modificaciones de ventas pendientes...");
      try {
        const modificacionesPendientes = this.realm.objects("VentaModificacion").filtered("enviado == false");

        if (modificacionesPendientes.length > 0) {
          console.log(
            `[FullSync-Modificacion] 📤 Enviando ${modificacionesPendientes.length} modificaciones pendientes...`,
          );

          const formatDate = (date: Date): string => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, "0");
            const day = String(date.getDate()).padStart(2, "0");
            const hours = String(date.getHours()).padStart(2, "0");
            const minutes = String(date.getMinutes()).padStart(2, "0");
            const seconds = String(date.getSeconds()).padStart(2, "0");
            return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
          };

          const payload = Array.from(modificacionesPendientes).map((mod: any) => ({
            sucursal: mod.sucursal ?? sucursal,
            no_venta: mod.noVenta ?? 0,
            caja: mod.caja ?? 1,
            id_movil: mod.idMovil,
            clave_prod: mod.claveProd,
            nombre_producto: mod.nombreProducto ?? "",
            cantidad_anterior: mod.cantidadAnterior ?? 0,
            cantidad_nueva: mod.cantidadNueva ?? 0,
            usuario_modifica: mod.usuarioModifica ?? idUsuario,
            fecha_modifica: formatDate(mod.fechaModifica ?? new Date()),
            motivo_modificacion: mod.motivoModificacion ?? "",
            latitud: mod.latitud ?? 0,
            longitud: mod.longitud ?? 0,
          }));

          const modificacionUrl = `${this.apiBaseUrl}/api/MovilesVentas/sp_MovilesVentasModificacionJSON?sucursal=${sucursal}&idUsuario=${idUsuario}`;
          console.log(`[FullSync-Modificacion] 🌐 URL: ${modificacionUrl}`);
          console.log(`[FullSync-Modificacion] 📦 Payload:`, JSON.stringify(payload, null, 2));

          const modificacionResp = await fetchWithTimeout(modificacionUrl, {
            method: "POST",
            headers: { accept: "application/octet-stream", "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          console.log(
            `[FullSync-Modificacion] 📡 Respuesta HTTP: ${modificacionResp.status} ${modificacionResp.statusText}`,
          );

          if (modificacionResp.ok) {
            const responseText = await modificacionResp.text();
            console.log(`[FullSync-Modificacion] 📥 Respuesta del servidor:`, responseText);

            this.realm.write(() => {
              Array.from(modificacionesPendientes).forEach((m: any) => {
                m.enviado = true;
              });
            });
            console.log(`[FullSync-Modificacion] ✅ ${payload.length} modificaciones enviadas y marcadas como enviado`);
          } else {
            const errorText = await modificacionResp.text().catch(() => "No se pudo leer el error");
            console.warn(`[FullSync-Modificacion] ⚠️ Error HTTP ${modificacionResp.status} enviando modificaciones`);
            console.warn(`[FullSync-Modificacion] ⚠️ Detalle del error:`, errorText);
          }
        } else {
          console.log("[FullSync-Modificacion] ℹ️ No hay modificaciones pendientes de envío");
        }
      } catch (modificacionError) {
        console.error("[FullSync-Modificacion] ❌ Error enviando modificaciones:", modificacionError);
      }
    }

    // PASO 2: Enviar reubicaciones pendientes (delega en ReubicacionService)
    if (idUsuario) {
      console.log("[FullSync-Reubicacion] 🔍 PASO 2 - Delegando envío de reubicaciones...");
      try {
        const resultado = await ReubicacionService.getInstance().enviarReubicacionesPendientes(sucursal, idUsuario);
        if (resultado.success && resultado.sent > 0) {
          console.log(`[FullSync-Reubicacion] ✅ ${resultado.sent} reubicaciones enviadas`);
        } else if (resultado.error) {
          console.warn(`[FullSync-Reubicacion] ⚠️ ${resultado.error}`);
        }
      } catch (reubicacionError) {
        console.error("[FullSync-Reubicacion] ❌ Error enviando reubicaciones:", reubicacionError);
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
        console.log("[FullSync] Enviando bitácoras de validación de ubicación pendientes...");
        await GpsBitacoraService.enviarValidacionesPendientes(sucursal, idUsuario);
        console.log("[FullSync] Enviando bitácoras de tiempos de venta pendientes...");
        await GpsBitacoraService.enviarTiemposVentaPendientes(sucursal, idUsuario);
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
          const envaseResp = await fetchWithTimeout(envaseUrl, {
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

    // PASO 5.5: Enviar cierres de ruta pendientes al servidor
    if (idUsuario) {
      console.log("[FullSync] PASO 5.5 - Enviando cierres de ruta pendientes...");
      const cierreResult = await this.sendPendingCierreRutaToServer(sucursal, idUsuario);
      if (cierreResult.success && cierreResult.sent > 0) {
        console.log(`[FullSync] ✅ ${cierreResult.sent} cierres de ruta enviados`);
      } else if (!cierreResult.success && cierreResult.error) {
        console.warn("[FullSync] ⚠️ Error enviando cierres de ruta:", cierreResult.error);
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

            const response = await fetchWithTimeout(url, {
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
                  listaPrecio: cliente.listaPrecio,
                  domicilio: cliente.domicilio || null,
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
            const response = await fetchWithTimeout(url, {
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
                  rfc: usuario.rfc ?? null,
                  domicilio: usuario.domicilio ?? null,
                  regimenFiscal: usuario.regimenFiscal ?? null,
                  nombreCia: usuario.nombreCia ?? null,
                  telefono: usuario.telefono ?? null,
                  ticketFinal: usuario.ticketFinal ?? null,
                  permisoDomicilioTicket:
                    typeof usuario.permisoDomicilioTicket === "boolean"
                      ? usuario.permisoDomicilioTicket
                      : usuario.permisoDomicilioTicket === 1
                      ? true
                      : usuario.permisoDomicilioTicket === 0
                      ? false
                      : null,
                  dobleTicket:
                    typeof usuario.dobleTicket === "boolean"
                      ? usuario.dobleTicket
                      : usuario.dobleTicket === 1
                      ? true
                      : usuario.dobleTicket === 0
                      ? false
                      : null,
                  envaseRuta:
                    typeof usuario.envaseRuta === "boolean"
                      ? usuario.envaseRuta
                      : usuario.envaseRuta === 1
                      ? true
                      : usuario.envaseRuta === 0
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
        name: "ProductosIncremental",
        run: async () => {
          const tableName = "Productos";
          const url = `${this.apiBaseUrl}/api/MovilesVentas/productos/full`;
          const idBitacora = await BitacoraService.registrarInicioSync(
            tableName,
            "incremental",
            "background",
            idUsuario,
            sucursal,
            url,
          );

          try {
            console.log("[Incremental] Productos desde", url);

            const response = await fetchWithTimeout(url, {
              headers: { accept: "application/json" },
            });
            if (!response.ok) {
              throw new Error(`HTTP ${response.status} Productos`);
            }

            const productos = await response.json();
            const registrosLeidos = Array.isArray(productos) ? productos.length : 0;
            let registrosGuardados = 0;
            let registrosActualizados = 0;
            let registrosEliminados = 0;

            this.realm!.write(() => {
              // Crear un Set con los IDs de productos del servidor para búsqueda rápida
              const idsDelServidor = new Set(productos.map((p: any) => p.id));

              // Actualizar/crear productos del servidor
              for (const producto of productos) {
                const existing = this.realm!.objectForPrimaryKey("Producto", producto.id) as any;

                const productoData: any = {
                  ...producto,
                  syncedAt: new Date(),
                  syncedAr: nowMexico,
                };

                if (existing) {
                  this.realm!.create("Producto", productoData, UpdateMode.Modified);
                  registrosActualizados++;
                } else {
                  this.realm!.create("Producto", productoData);
                  registrosGuardados++;
                }
              }

              // Eliminar productos locales que no están en la respuesta del servidor
              const todosLosProductosLocales = this.realm!.objects("Producto");
              const productosAEliminar: any[] = [];

              for (const productoLocal of todosLosProductosLocales) {
                const id = (productoLocal as any).id;
                if (!idsDelServidor.has(id)) {
                  productosAEliminar.push(productoLocal);
                }
              }

              if (productosAEliminar.length > 0) {
                console.log(
                  `[Incremental] Eliminando ${productosAEliminar.length} productos que no están en el servidor`,
                );
                this.realm!.delete(productosAEliminar);
                registrosEliminados = productosAEliminar.length;
              }
            });

            await BitacoraService.registrarFinSync(idBitacora, {
              exitoso: true,
              registrosLeidos,
              registrosGuardados,
              registrosActualizados,
              registrosEliminados,
            });

            return {
              tabla: tableName,
              endpoint: url,
              registrosLeidos,
              registrosGuardados,
              registrosActualizados,
            };
          } catch (error) {
            await BitacoraService.registrarFinSync(idBitacora, {
              exitoso: false,
              error: error instanceof Error ? error.message : "Error desconocido",
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

            const response = await fetchWithTimeout(url, {
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

            const response = await fetchWithTimeout(url, {
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

      //       const response = await fetchWithTimeout(url, {
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

            const response = await fetchWithTimeout(url, {
              headers: { accept: "application/octet-stream" },
            });
            if (!response.ok) {
              throw new Error(`HTTP ${response.status} Ventas`);
            }

            const ventas = await response.json();
            console.log("[Incremental] 🔍 VENTAS RECIBIDAS DEL SERVIDOR:", {
              total: Array.isArray(ventas) ? ventas.length : 0,
              primerasVentas: Array.isArray(ventas)
                ? ventas.slice(0, 3).map((v: any) => ({
                    id: v.id,
                    noVenta: v.noVenta,
                    idMovil: v.idMovil,
                    tieneIdMovil: v.idMovil !== undefined && v.idMovil !== null,
                    nombreProducto: v.nombreProducto,
                    fecha: v.fecha,
                  }))
                : [],
            });
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
                  (existingById as any).idMovil = venta.idMovil ?? null;
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
                      (localVenta as any).idMovil = venta.idMovil ?? null;
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
        name: "VisitasIncrementalSucursalPibote",
        run: async () => {
          const tableName = "Visita";
          const url = `${this.apiBaseUrl}/api/MovilesVentas/visitas/full-incremental-sucursal-pibote/${sucursal}`;
          const idBitacora = await BitacoraService.registrarInicioSync(
            tableName,
            "incremental",
            "background",
            idUsuario,
            sucursal,
            url,
          );

          try {
            console.log("[Incremental] Visitas Pivote desde", url);

            const response = await fetchWithTimeout(url, {
              headers: { accept: "application/json" },
            });
            if (!response.ok) {
              throw new Error(`HTTP ${response.status} VisitasPivote`);
            }

            const visitasData = await response.json();
            const registrosLeidos = Array.isArray(visitasData) ? visitasData.length : 0;
            let registrosGuardados = 0;
            let registrosActualizados = 0;

            this.realm!.write(() => {
              for (const visita of visitasData) {
                const fechaVisita = visita.fecha ? new Date(visita.fecha) : new Date();
                const fechaStr = fechaVisita.toISOString().split("T")[0];
                const idCompuesto = `${visita.id}-${fechaStr}`;
                const existing = this.realm!.objectForPrimaryKey("Visita", idCompuesto) as any;

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
                  this.realm!.create("Visita", visitaData, UpdateMode.Modified);
                  registrosActualizados++;
                } else {
                  this.realm!.create("Visita", visitaData);
                  registrosGuardados++;
                }
              }
            });

            console.log(
              `[Incremental] Visitas Pivote leídos=${registrosLeidos}, guardados=${registrosGuardados}, actualizados=${registrosActualizados}`,
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

            const detallesVisitas = this.realm!.objects("DetalleVisitas").filtered("sincronizado == false");

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
            const visitasArray = Array.from(detallesVisitas)
              .map((detalle: any) => ({
                fechaInicio: isValidDate(detalle.fechaInicio) ? formatDateForMexico(detalle.fechaInicio) : nowStr,
                fechaFin: isValidDate(detalle.fechaFin) ? formatDateForMexico(detalle.fechaFin) : nowStr,
                idCliente: detalle.idCliente,
                idUsuario: detalle.idUsuario,
                idRuta: detalle.idRuta,
                tipo: detalle.tipoVisita,
              }))
              .filter((visita: any) => visita.tipo !== null && visita.tipo !== undefined);

            console.log(
              `[Incremental] DetalleVisitas - Enviando ${visitasArray.length} visitas al servidor (filtradas sin tipo null)`,
            );
            console.log("[Incremental] DetalleVisitas arrastre - Payload:", JSON.stringify(visitasArray));

            const response = await fetchWithTimeout(url, {
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
                (detalle as any).sincronizado = true;
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
        name: "VisitasVisitadosSucursal",
        run: async () => {
          const tableName = "DetalleVisitas";
          const url = `${this.apiBaseUrl}/api/MovilesVentas/visitas/full-incremental-sucursal-visitados/${sucursal}`;
          const idBitacora = await BitacoraService.registrarInicioSync(
            tableName,
            "incremental",
            "background",
            idUsuario,
            sucursal,
            url,
          );

          try {
            console.log("[Incremental] Visitas Visitados desde", url);

            const response = await fetchWithTimeout(url, {
              headers: { accept: "application/json" },
            });
            if (!response.ok) {
              throw new Error(`HTTP ${response.status} VisitasVisitados`);
            }

            const visitadosData = await response.json();
            const registros = Array.isArray(visitadosData) ? visitadosData : [];
            const registrosLeidos = registros.length;

            this.realm!.write(() => {
              // Eliminar información anterior proveniente del servidor (ya sincronizada),
              // preservando los registros locales pendientes de enviar (sincronizado == false)
              const sincronizados = this.realm!.objects("DetalleVisitas").filtered("sincronizado == true");
              this.realm!.delete(sincronizados);

              // Insertar la lista autoritativa del servidor
              for (const v of registros) {
                const fechaInicio = v.fechaInicio ? new Date(v.fechaInicio) : null;
                const fechaFin = v.fechaFin ? new Date(v.fechaFin) : null;

                this.realm!.create(
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

            console.log(`[Incremental] Visitas Visitados - ✅ ${registrosLeidos} registros insertados`);

            await BitacoraService.registrarFinSync(idBitacora, {
              exitoso: true,
              registrosLeidos,
              registrosGuardados: registrosLeidos,
              registrosActualizados: 0,
            });

            return {
              tabla: tableName,
              endpoint: url,
              registrosLeidos,
              registrosGuardados: registrosLeidos,
              registrosActualizados: 0,
            };
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : "Error desconocido";
            console.error("[Incremental] Visitas Visitados - Error:", error);

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
          // Agregar 2 minutos de buffer para incluir registros guardados recientemente
          const fechaConBuffer = new Date(nowMexico.getTime() + 2 * 60 * 1000);
          const fechaMovto = this.formatMexicoDateForServer(fechaConBuffer);
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

            const response = await fetchWithTimeout(url, {
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

            const response = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
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
      {
        name: "CierreRutaFetch",
        run: async () => {
          const tableName = "CierreRuta";
          const url = `${this.apiBaseUrl}/api/MovilesVentas/cierre-ruta/full/${sucursal}`;
          const idBitacora = await BitacoraService.registrarInicioSync(
            tableName,
            "incremental",
            "background",
            idUsuario,
            sucursal,
            url,
          );

          try {
            console.log(
              `[Incremental] CierreRuta - Obteniendo estado del servidor para sucursal=${sucursal}, vendedor=${idUsuario}...`,
            );

            const result = await this.fetchCierreRutaFromServer(sucursal, idUsuario ?? 0);

            await BitacoraService.registrarFinSync(idBitacora, {
              exitoso: result.success,
              registrosLeidos: result.registros,
              registrosGuardados: result.registros,
              registrosActualizados: 0,
              error: result.error,
            });

            return {
              tabla: tableName,
              endpoint: "sp_MovilesCierreRutaGet",
              registrosLeidos: result.registros,
              registrosGuardados: result.registros,
              registrosActualizados: 0,
            };
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : "Error desconocido";
            console.error("[Incremental] CierreRuta - Error:", error);

            await BitacoraService.registrarFinSync(idBitacora, {
              exitoso: false,
              error: errorMsg,
              errorCode: "500",
            });

            return {
              tabla: tableName,
              endpoint: "sp_MovilesCierreRutaGet",
              registrosLeidos: 0,
              registrosGuardados: 0,
              registrosActualizados: 0,
            };
          }
        },
      },
    ];

    const totalTasks = tasks.length;
    let currentTask = 0;

    let wasCancelled = false;

    for (const task of tasks) {
      // Verificar cancelación antes de iniciar la siguiente tarea
      if (isCancelled?.()) {
        console.log(`[FullSyncService] ⛔ Sincronización incremental cancelada antes de ${task.name}`);
        wasCancelled = true;
        break;
      }

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

    const success = errors.length === 0 && !wasCancelled;
    // console.log(
    //   `[FullSyncService] Sincronización incremental completada. Éxito: ${success}, Errores: ${errors.length}`,
    // );

    return {
      success,
      cancelled: wasCancelled || undefined,
      error: success
        ? undefined
        : wasCancelled
        ? "Sincronización cancelada: superó el tiempo límite o se interrumpió por otra solicitud"
        : errors.join("; "),
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
        console.log("[FullSync] Enviando bitácoras de validación de ubicación pendientes...");
        await GpsBitacoraService.enviarValidacionesPendientes(sucursal, idUsuario);
        console.log("[FullSync] Enviando bitácoras de tiempos de venta pendientes...");
        await GpsBitacoraService.enviarTiemposVentaPendientes(sucursal, idUsuario);
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

      // PASO POST-SYNC: Obtener estado de cierre de ruta del servidor
      // Esto asegura que al iniciar sesión se sepa si la ruta está cerrada o abierta
      if (idUsuario) {
        try {
          console.log("[FullSync] Post-sync - Obteniendo estado de cierre de ruta...");
          const cierreResult = await this.fetchCierreRutaFromServer(sucursal, idUsuario);
          if (cierreResult.success && cierreResult.registros > 0) {
            console.log(`[FullSync] ✅ Cierre de ruta sincronizado: ${cierreResult.registros} registro(s)`);
          } else if (cierreResult.success) {
            console.log("[FullSync] ℹ️ No hay cierres de ruta en el servidor");
          } else {
            console.warn("[FullSync] ⚠️ Error al obtener cierre de ruta:", cierreResult.error);
          }
        } catch (cierreError) {
          console.warn("[FullSync] ⚠️ Error post-sync cierre de ruta:", cierreError);
        }
      }

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
      const response = await fetchWithTimeout(`${this.apiBaseUrl}/api/MovilesVentas/sucursales`);

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
   * Obtiene los IDs de productos que tienen recuperaEnvase=true en algún kit
   */
  getProductosConRecuperaEnvase(): Set<number> {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return new Set();
    const kitsConRecuperaEnvase = Array.from(this.realm.objects("Kit").filtered("recuperaEnvase == true")) as any[];
    return new Set<number>(kitsConRecuperaEnvase.map((k) => k.idProducto).filter((id: number | null) => id != null));
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

  /**
   * Elimina todos los datos de Realm excepto la tabla Usuario
   */
  clearAllDataExceptUsers(): void {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) {
      console.warn("[FullSyncService] Realm no inicializado o cerrado, no se pueden limpiar datos");
      return;
    }

    try {
      this.realm.write(() => {
        // Tablas a eliminar (todas excepto Usuario)
        const tablesToDelete = [
          "Venta",
          "Producto",
          "Cia",
          "Kit",
          "KitIntercambio",
          "Precio",
          "PrecioPromo",
          "Inventario",
          "Cartera",
          "ClienteFull",
          "SyncStatus",
          "SyncLog",
          "SyncTableLog",
          "CierreRuta",
          "Visita",
          "DetalleVisitas",
          "TipoVisita",
          "BitacoraSync",
          "BitacoraGps",
          "InventarioEnvase",
          "InventarioEnvasesHistorial",
          "VisitaRealizada",
          "VentaCancelacion",
          "VentaModificacion",
          "FormaPago",
        ];

        tablesToDelete.forEach((tableName) => {
          const objects = this.realm!.objects(tableName);
          this.realm!.delete(objects);
          console.log(`[FullSyncService] Tabla ${tableName} limpiada: ${objects.length} registros eliminados`);
        });

        const reubicacionesEnviadas = this.realm!.objects("Reubicacion").filtered("enviado == true");
        const enviadasCount = reubicacionesEnviadas.length;
        this.realm!.delete(reubicacionesEnviadas);
        const pendientesCount = this.realm!.objects("Reubicacion").filtered("enviado == false").length;
        console.log(
          `[FullSyncService] Reubicaciones: ${enviadasCount} enviadas eliminadas, ${pendientesCount} pendientes conservadas`,
        );

        console.log("[FullSyncService] ✅ Todos los datos eliminados excepto Usuario y reubicaciones pendientes");
      });
    } catch (error) {
      console.error("[FullSyncService] Error al limpiar datos:", error);
    }
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

  /**
   * Obtiene el inventario por clave de producto y sucursal
   */
  getInventarioByClaveProdSucursal(claveProd: number, sucursal: number): any | null {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return null;
    const inventarios = this.realm
      .objects("Inventario")
      .filtered("claveProd == $0 AND sucursal == $1", claveProd, sucursal);
    return inventarios.length > 0 ? inventarios[0] : null;
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

    let query = "fecha >= $0 AND fecha <= $1 AND tipoPago == 1 and noVenta>0 AND idMovil == NULL";
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
    envVendidoEco: number;
    envCambiado: number;
    envCambiadoEco: number;
    envPrestado: number;
    envPrestadoEco: number;
    cambiadosPorProducto: Array<{ descripcionCorta: string; claveProd: number; cantidadEntrada: number }>;
    intercambioPorProducto: Array<{ descripcion: string; claveProd: number; cantidad: number }>;
    prestamoPorProducto: Array<{ descripcion: string; claveProd: number; cantidad: number }>;
    vendidosPorProducto: Array<{ descripcion: string; claveProd: number; cantidad: number }>;
    recuperadosPorProducto: Array<{ descripcion: string; claveProd: number; cantidad: number }>;
    envasesVendidosPorProducto: Array<{ descripcion: string; claveProd: number; cantidad: number }>;
  } {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) {
      return {
        envVendido: 0,
        envVendidoEco: 0,
        envCambiado: 0,
        envCambiadoEco: 0,
        envPrestado: 0,
        envPrestadoEco: 0,
        cambiadosPorProducto: [],
        intercambioPorProducto: [],
        prestamoPorProducto: [],
        vendidosPorProducto: [],
        recuperadosPorProducto: [],
        envasesVendidosPorProducto: [],
      };
    }

    console.log("[getEnvasesHistorialForDate] Buscando entre:", startOfDay, "y", endOfDay);

    const registros = Array.from(
      this.realm
        .objects("InventarioEnvasesHistorial")
        .filtered("fechaMovto >= $0 AND fechaMovto <= $1", startOfDay, endOfDay),
    ) as any[];
    console.log("registros", registros);
    console.log("[getEnvasesHistorialForDate] Registros encontrados:", registros.length);
    if (registros.length > 0) {
      console.log(
        "[getEnvasesHistorialForDate] Primeros 3 registros:",
        registros.slice(0, 3).map((r: any) => ({
          tipoMovto: r.tipoMovto,
          claveProd: r.claveProd,
          cantidadSalida: r.cantidadSalida,
          cantidadEntrada: r.cantidadEntrada,
          fechaMovto: r.fechaMovto instanceof Date ? r.fechaMovto.toISOString() : String(r.fechaMovto),
        })),
      );

      // Obtener detalles del inventario para claveProd 18 (envases)
      try {
        const inventarioEnvases = this.realm?.objectForPrimaryKey("Inventario", 18);
        if (inventarioEnvases) {
          console.log("[getEnvasesHistorialForDate] 📦 Inventario claveProd=18:", {
            id: (inventarioEnvases as any).id,
            descripcion: (inventarioEnvases as any).descripcion,
            saldo: (inventarioEnvases as any).saldo,
            entrada: (inventarioEnvases as any).entrada,
            salida: (inventarioEnvases as any).salida,
          });
        } else {
          console.log("[getEnvasesHistorialForDate] ⚠️ No se encontró inventario para claveProd=18");
        }
      } catch (err) {
        console.log("[getEnvasesHistorialForDate] ❌ Error obteniendo inventario:", err);
      }
      try {
        const inventarioEnvases = this.realm?.objectForPrimaryKey("Inventario", 16);
        if (inventarioEnvases) {
          console.log("[getEnvasesHistorialForDate] 📦 Inventario claveProd=16:", {
            id: (inventarioEnvases as any).id,
            descripcion: (inventarioEnvases as any).descripcion,
            saldo: (inventarioEnvases as any).saldo,
            entrada: (inventarioEnvases as any).entrada,
            salida: (inventarioEnvases as any).salida,
          });
        } else {
          console.log("[getEnvasesHistorialForDate] ⚠️ No se encontró inventario para claveProd=16");
        }
      } catch (err) {
        console.log("[getEnvasesHistorialForDate] ❌ Error obteniendo inventario:", err);
      }
    }

    let envVendido = 0;
    let envVendidoEco = 0;
    let envCambiado = 0;
    let envCambiadoEco = 0;
    let envPrestado = 0;
    let envPrestadoEco = 0;
    const cambiadosPorProd: Record<number, { descripcionCorta: string; cantidadEntrada: number }> = {};

    // Obtener productos con intercambio (recuperaEnvaseOtro), préstamo (controlPresamo), recuperaEnvase y envases vendidos (noRecuperaEnvase) desde Kits
    const kitsConIntercambio = Array.from(this.realm.objects("Kit").filtered("recuperaEnvaseOtro == true")) as any[];
    const kitsConPrestamo = Array.from(this.realm.objects("Kit").filtered("controlPresamo == true")) as any[];
    const kitsConRecuperaEnvase = Array.from(this.realm.objects("Kit").filtered("recuperaEnvase == true")) as any[];
    const kitsConEnvaseVendido = Array.from(this.realm.objects("Kit").filtered("noRecuperaEnvase == true")) as any[];

    // Extraer los idProducto (claves de producto) únicos
    const clavesIntercambio = new Set<number>(
      kitsConIntercambio.map((k) => k.idProducto).filter((id: number | null) => id != null),
    );
    const clavesPrestamo = new Set<number>(
      kitsConPrestamo.map((k) => k.idProducto).filter((id: number | null) => id != null),
    );
    const clavesRecuperaEnvase = new Set<number>(
      kitsConRecuperaEnvase.map((k) => k.idProducto).filter((id: number | null) => id != null),
    );
    const clavesEnvaseVendido = new Set<number>(
      kitsConEnvaseVendido.map((k) => k.idProducto).filter((id: number | null) => id != null),
    );

    // Mapas de producto -> cantidad de insumo para cada tipo de kit
    const cantidadInsumoPorProducto: Record<number, number> = {};
    for (const kit of kitsConEnvaseVendido) {
      if (kit.idProducto != null) {
        cantidadInsumoPorProducto[kit.idProducto] = kit.cantidad || 1;
      }
    }

    const cantidadInsumoIntercambio: Record<number, number> = {};
    for (const kit of kitsConIntercambio) {
      if (kit.idProducto != null) {
        // Usar cantRecEnvOtro (cantidad de envases a recibir), si es 0 o null usar 1
        const cantRecEnvOtro = kit.cantRecEnvOtro;
        cantidadInsumoIntercambio[kit.idProducto] = cantRecEnvOtro != null && cantRecEnvOtro > 0 ? cantRecEnvOtro : 1;
      }
    }

    const cantidadInsumoPrestamo: Record<number, number> = {};
    for (const kit of kitsConPrestamo) {
      if (kit.idProducto != null) {
        cantidadInsumoPrestamo[kit.idProducto] = kit.cantidad || 1;
      }
    }

    const cantidadInsumoRecuperaEnvase: Record<number, number> = {};
    for (const kit of kitsConRecuperaEnvase) {
      if (kit.idProducto != null) {
        cantidadInsumoRecuperaEnvase[kit.idProducto] = kit.cantidad || 1;
      }
    }

    // Extraer los idInsumo (envases) de kits con recuperaEnvaseOtro, controlPresamo, o envaseVendido
    // Estos NO deben sumarse al total genérico de envases vendidos
    const insumosExcluirVenta = new Set<number>([
      ...kitsConIntercambio.map((k) => k.idInsumo).filter((id: number | null) => id != null),
      ...kitsConPrestamo.map((k) => k.idInsumo).filter((id: number | null) => id != null),
      ...kitsConRecuperaEnvase.map((k) => k.idInsumo).filter((id: number | null) => id != null),
      ...kitsConEnvaseVendido.map((k) => k.idInsumo).filter((id: number | null) => id != null),
    ]);

    console.log("[getEnvasesHistorialForDate] Productos con intercambio:", Array.from(clavesIntercambio));
    console.log("[getEnvasesHistorialForDate] Productos con préstamo:", Array.from(clavesPrestamo));
    console.log("[getEnvasesHistorialForDate] Productos con envaseVendido:", Array.from(clavesEnvaseVendido));
    console.log("[getEnvasesHistorialForDate] Insumos a excluir de totales de venta:", Array.from(insumosExcluirVenta));

    // Obtener descripciones de áreas de productos (acumulables por área)
    const getAreaDescripcion = (prod: any): string => {
      return prod?.descripcionArea || prod?.descripcion || "Sin área";
    };

    // Mapeo de clave de producto a descripcionArea
    const areaPorProducto: Record<number, string> = {};

    for (const clave of clavesIntercambio) {
      const prod = this.realm.objectForPrimaryKey("Producto", clave) as any;
      areaPorProducto[clave] = getAreaDescripcion(prod);
    }

    for (const clave of clavesPrestamo) {
      const prod = this.realm.objectForPrimaryKey("Producto", clave) as any;
      areaPorProducto[clave] = getAreaDescripcion(prod);
    }

    for (const clave of clavesRecuperaEnvase) {
      const prod = this.realm.objectForPrimaryKey("Producto", clave) as any;
      areaPorProducto[clave] = getAreaDescripcion(prod);
    }

    for (const clave of clavesEnvaseVendido) {
      const prod = this.realm.objectForPrimaryKey("Producto", clave) as any;
      areaPorProducto[clave] = getAreaDescripcion(prod);
    }

    // Obtener descripciones de insumos (envases) para la tabla de vendidos por producto
    const areaPorInsumo: Record<number, string> = {};
    for (const insumoId of insumosExcluirVenta) {
      const prod = this.realm.objectForPrimaryKey("Producto", insumoId) as any;
      areaPorInsumo[insumoId] = getAreaDescripcion(prod);
    }

    // Buscar ventas de estos productos en el rango de fechas - acumulados por AREA
    const intercambioPorArea: Record<string, { descripcion: string; cantidad: number }> = {};
    const prestamoPorArea: Record<string, { descripcion: string; cantidad: number }> = {};
    const recuperadosPorArea: Record<string, { descripcion: string; cantidad: number }> = {};
    const envasesVendidosPorArea: Record<string, { descripcion: string; cantidad: number }> = {};

    try {
      const ventas = Array.from(
        this.realm.objects("Venta").filtered("fecha >= $0 AND fecha <= $1", startOfDay, endOfDay),
      ) as any[];
      console.log("[getEnvasesHistorialForDate] Total ventas en período:", ventas.length);

      for (const v of ventas) {
        const claveProd = v.claveProd;
        const cantidad = v.cantProducto ?? 0;
        const area = areaPorProducto[claveProd];

        if (claveProd && clavesIntercambio.has(claveProd) && cantidad > 0 && area) {
          if (!intercambioPorArea[area]) {
            intercambioPorArea[area] = { descripcion: area, cantidad: 0 };
          }
          const cantidadInsumo = cantidadInsumoIntercambio[claveProd] || 1;
          const cantidadTotal = cantidad * cantidadInsumo;
          intercambioPorArea[area].cantidad += cantidadTotal;
          console.log(
            `[getEnvasesHistorialForDate] Intercambio area ${area} += ${cantidadTotal} (ventas: ${cantidad} * insumo: ${cantidadInsumo})`,
          );
        }

        if (claveProd && clavesPrestamo.has(claveProd) && cantidad > 0 && area) {
          if (!prestamoPorArea[area]) {
            prestamoPorArea[area] = { descripcion: area, cantidad: 0 };
          }
          const cantidadInsumo = cantidadInsumoPrestamo[claveProd] || 1;
          const cantidadTotal = cantidad * cantidadInsumo;
          prestamoPorArea[area].cantidad += cantidadTotal;
          console.log(
            `[getEnvasesHistorialForDate] Préstamo area ${area} += ${cantidadTotal} (ventas: ${cantidad} * insumo: ${cantidadInsumo})`,
          );
        }

        if (claveProd && clavesRecuperaEnvase.has(claveProd) && cantidad > 0 && area) {
          if (!recuperadosPorArea[area]) {
            recuperadosPorArea[area] = { descripcion: area, cantidad: 0 };
          }
          const cantidadInsumo = cantidadInsumoRecuperaEnvase[claveProd] || 1;
          const cantidadTotal = cantidad * cantidadInsumo;
          recuperadosPorArea[area].cantidad += cantidadTotal;
          console.log(
            `[getEnvasesHistorialForDate] Recuperado envase area ${area} += ${cantidadTotal} (ventas: ${cantidad} * insumo: ${cantidadInsumo})`,
          );
        }

        // Procesar ventas de productos con envaseVendido
        if (claveProd && clavesEnvaseVendido.has(claveProd) && cantidad > 0 && area) {
          if (!envasesVendidosPorArea[area]) {
            envasesVendidosPorArea[area] = { descripcion: area, cantidad: 0 };
          }
          const cantidadInsumo = cantidadInsumoPorProducto[claveProd] || 1;
          const cantidadEnvases = cantidad * cantidadInsumo;
          envasesVendidosPorArea[area].cantidad += cantidadEnvases;
          console.log(
            `[getEnvasesHistorialForDate] Envase vendido area ${area} += ${cantidadEnvases} (ventas: ${cantidad} * insumo: ${cantidadInsumo})`,
          );
        }
      }
    } catch (err) {
      console.log("[getEnvasesHistorialForDate] Error obteniendo ventas:", err);
    }

    // Track vendidos por insumo para mostrar individualmente - acumulados por AREA
    const vendidosPorArea: Record<string, { descripcion: string; cantidad: number }> = {};

    for (const r of registros) {
      const tipo: number = r.tipoMovto ?? 0;
      const clave: number = r.claveProd ?? 0;
      const salida: number = r.cantidadSalida ?? 0;
      const entrada: number = r.cantidadEntrada ?? 0;

      // VENTAS (tipo=2): Si es envase 18 o 16
      if (tipo === 2 && (clave === 18 || clave === 16)) {
        const area = areaPorInsumo[clave];
        // Si este insumo está en kits con recuperaEnvase/controlPresamo, NO sumar al total genérico
        // pero SÍ agregar a la lista individual por AREA
        if (insumosExcluirVenta.has(clave) && area) {
          console.log(`[getEnvasesHistorialForDate] ⏩ Envase ${clave} excluido de totales, acumulado en area ${area}`);
          if (!vendidosPorArea[area]) {
            vendidosPorArea[area] = { descripcion: area, cantidad: 0 };
          }
          vendidosPorArea[area].cantidad += salida;
        } else {
          // Sumar al total genérico
          if (clave === 18) {
            console.log("[getEnvasesHistorialForDate] ✅ envVendido += ", salida, " (tipo=2, clave=18)");
            envVendido += salida;
          } else if (clave === 16) {
            console.log("[getEnvasesHistorialForDate] ✅ envVendidoEco += ", salida, " (tipo=2, clave=16)");
            envVendidoEco += salida;
          }
        }
      } else if (tipo === 1100 && clave === 18) {
        console.log("[getEnvasesHistorialForDate] ✅ envCambiado += ", salida, " (tipo=1100, clave=18)");
        envCambiado += salida;
      } else if (tipo === 1100 && clave === 16) {
        console.log("[getEnvasesHistorialForDate] ✅ envCambiadoEco += ", salida, " (tipo=1100, clave=16)");
        envCambiadoEco += salida;
      } else if (tipo === 1200 && clave === 18) {
        console.log("[getEnvasesHistorialForDate] ✅ envPrestado += ", salida, " (tipo=1200, clave=18)");
        envPrestado += salida;
      } else if (tipo === 1200 && clave === 16) {
        console.log("[getEnvasesHistorialForDate] ✅ envPrestadoEco += ", salida, " (tipo=1200, clave=16)");
        envPrestadoEco += salida;
      }

      if (tipo === 1000 && entrada > 0) {
        console.log("[getEnvasesHistorialForDate] ✅ cambiadosPorProd[", clave, "] += ", entrada, " (tipo=1000)");
        if (!cambiadosPorProd[clave]) {
          cambiadosPorProd[clave] = { descripcionCorta: r.descripcionCorta ?? String(clave), cantidadEntrada: 0 };
        }
        cambiadosPorProd[clave].cantidadEntrada += entrada;
      }
    }

    console.log("[getEnvasesHistorialForDate] TOTALES:", {
      envVendido,
      envVendidoEco,
      envCambiado,
      envCambiadoEco,
      envPrestado,
      envPrestadoEco,
      cambiadosPorProductoCount: Object.keys(cambiadosPorProd).length,
      intercambioPorAreaCount: Object.keys(intercambioPorArea).length,
      prestamoPorAreaCount: Object.keys(prestamoPorArea).length,
      vendidosPorAreaCount: Object.keys(vendidosPorArea).length,
    });

    const cambiadosPorProducto = Object.entries(cambiadosPorProd).map(([clave, val]: [string, any]) => ({
      claveProd: parseInt(clave, 10),
      descripcionCorta: val.descripcionCorta,
      cantidadEntrada: val.cantidadEntrada,
    }));

    // Mapear resultados por área - usando descripcionArea como identificador
    const intercambioPorProducto = Object.entries(intercambioPorArea).map(([area, val]: [string, any]) => ({
      claveProd: 0, // No aplica clave de producto cuando es por área
      descripcion: val.descripcion,
      cantidad: val.cantidad,
    }));

    const prestamoPorProducto = Object.entries(prestamoPorArea).map(([area, val]: [string, any]) => ({
      claveProd: 0,
      descripcion: val.descripcion,
      cantidad: val.cantidad,
    }));

    const recuperadosPorProducto = Object.entries(recuperadosPorArea).map(([area, val]: [string, any]) => ({
      claveProd: 0,
      descripcion: val.descripcion,
      cantidad: val.cantidad,
    }));

    const vendidosPorProducto = Object.entries(vendidosPorArea).map(([area, val]: [string, any]) => ({
      claveProd: 0,
      descripcion: val.descripcion,
      cantidad: val.cantidad,
    }));

    const envasesVendidosPorProducto = Object.entries(envasesVendidosPorArea).map(([area, val]: [string, any]) => ({
      claveProd: 0,
      descripcion: val.descripcion,
      cantidad: val.cantidad,
    }));

    return {
      envVendido,
      envVendidoEco,
      envCambiado,
      envCambiadoEco,
      envPrestado,
      envPrestadoEco,
      cambiadosPorProducto,
      intercambioPorProducto,
      prestamoPorProducto,
      vendidosPorProducto,
      recuperadosPorProducto,
      envasesVendidosPorProducto,
    };
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

  getRealm(): Realm | null {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) {
      return null;
    }
    return this.realm;
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

  getBitacoraValidacionPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(
      this.realm
        .objects("BitacoraValidacion")
        .sorted("fecha", true)
        .slice(offset, offset + limit),
    );
  }

  getBitacoraTiemposVentaPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(
      this.realm
        .objects("BitacoraTiemposVenta")
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

  getVisitasRealizadasPaginated(offset: number = 0, limit: number = 5000): any[] {
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

        const fechaVenta = venta.fecha ?? this.getMexicoNow();
        const fechaFormateada = this.formatMexicoDateForServer(fechaVenta);
        const fechaTransferFormateada = this.formatMexicoDateForServer(this.getMexicoNow());

        console.log("📤 [FullSync] FECHA ENVIADA AL SERVIDOR:", {
          ventaId: venta.id,
          idMovil: venta.idMovil,
          fechaOriginal: fechaVenta,
          fechaFormateada: fechaFormateada,
          fechaTransfer: fechaTransferFormateada,
        });

        return {
          sucursal: venta.sucursal ?? sucursal,
          clave_prod: venta.claveProd ?? 0,
          Cant_producto: venta.cantProducto ?? 0,
          precio: venta.precio ?? 0,
          Cve_cliente: venta.cveCliente ?? 0,
          fecha: fechaFormateada,
          tipo_pago: venta.tipoPago ?? 1,
          usuario: idUsuario,
          longitud: venta?.longitud ?? 0,
          latitud: venta?.latitud ?? 0,
          id_movil: venta.idMovil,
          fechaTransfer: fechaTransferFormateada,
          observacion: venta.observacion ?? "",
          folio_movto: 1,
        };
      });

      // Usar el mismo endpoint que el sincronizador periódico (que funciona correctamente)
      const url = `${this.apiBaseUrl}/api/SincronizacionMovil/sp_MovilesVentasArrastreJSON?sucursal=${sucursal}&idUsuario=${idUsuario}`;

      const response = await fetchWithTimeout(url, {
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
   * Envía cierres de ruta pendientes al servidor (arrastre).
   * Similar a sendPendingVentasToServer pero para CierreRuta.
   */
  async sendPendingCierreRutaToServer(
    sucursal: number,
    idUsuario: number,
  ): Promise<{ success: boolean; sent: number; error?: string }> {
    if (this.cierreRutaSendInFlight) {
      return this.cierreRutaSendInFlight;
    }

    const sendPromise = this.sendPendingCierreRutaToServerInternal(sucursal, idUsuario);
    this.cierreRutaSendInFlight = sendPromise;

    try {
      return await sendPromise;
    } finally {
      this.cierreRutaSendInFlight = null;
    }
  }

  private async sendPendingCierreRutaToServerInternal(
    sucursal: number,
    idUsuario: number,
  ): Promise<{ success: boolean; sent: number; error?: string }> {
    if (!this.realm || this.realm.isClosed) {
      return { success: false, sent: 0, error: "Realm no inicializado" };
    }

    try {
      // Obtener cierres no sincronizados (enviado == false o null)
      const cierresPendientes = this.realm
        .objects("CierreRuta")
        .filtered("(enviado == false || enviado == null) AND sucursal == $0 AND vendedor == $1", sucursal, idUsuario);
      console.log("CIERRE EJECUTANDO");
      if (cierresPendientes.length === 0) {
        console.log("SIN CIERRE");
        return { success: true, sent: 0 };
      }

      const formatDate = (date: Date | null): string => {
        if (!date) return "";
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        const hours = String(date.getHours()).padStart(2, "0");
        const minutes = String(date.getMinutes()).padStart(2, "0");
        const seconds = String(date.getSeconds()).padStart(2, "0");
        return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
      };

      const payload = Array.from(cierresPendientes).map((c: any) => ({
        sucursal: c.sucursal ?? sucursal,
        vendedor: c.vendedor ?? idUsuario,
        fechaCierre: formatDate(c.fechaCierre ?? c.updatedAt),
        rutaCerrada: c.rutaCerrada ?? false,
        updatedAt: formatDate(c.updatedAt) || formatDate(new Date()),
      }));

      const url = `${this.apiBaseUrl}/api/MovilesVentas/sp_MovilesCierreRutaJSON?sucursal=${sucursal}&idUsuario=${idUsuario}`;

      console.log(`[FullSync-CierreRuta] 📤 Enviando ${payload.length} cierre(s)...`);
      console.log(`[FullSync-CierreRuta] 📦 Payload:`, JSON.stringify(payload, null, 2));
      console.log(`[FullSync-CierreRuta] 🌐 URL: ${url}`);

      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        // Marcar como enviados
        this.realm.write(() => {
          Array.from(cierresPendientes).forEach((c: any) => {
            c.enviado = true;
          });
        });
        console.log(`[FullSync-CierreRuta] ✅ ${payload.length} cierres enviados y marcados`);
        return { success: true, sent: payload.length };
      } else {
        const errorText = await response.text().catch(() => "Error desconocido");
        console.warn(`[FullSync-CierreRuta] ⚠️ Error HTTP ${response.status}: ${errorText}`);
        return { success: false, sent: 0, error: `HTTP ${response.status}: ${errorText}` };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Error desconocido";
      console.error("[FullSync-CierreRuta] ❌ Error:", error);
      return { success: false, sent: 0, error: errorMsg };
    }
  }

  /**
   * Obtiene cierres de ruta del servidor y actualiza el estado local.
   * Permite que el cierre se sincronice entre dispositivos.
   */
  async fetchCierreRutaFromServer(
    sucursal: number,
    vendedor: number,
  ): Promise<{ success: boolean; registros: number; error?: string }> {
    if (!this.realm || this.realm.isClosed) {
      return { success: false, registros: 0, error: "Realm no inicializado" };
    }

    try {
      const url = `${this.apiBaseUrl}/api/MovilesVentas/cierre-ruta/full/${sucursal}`;

      console.log(`[FullSync-CierreRuta] 📥 Obteniendo cierres del servidor...`);
      console.log(`[FullSync-CierreRuta] 🌐 URL: ${url}`);

      const response = await fetchWithTimeout(url, {
        headers: { accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const cierres = await response.json();

      if (!Array.isArray(cierres) || cierres.length === 0) {
        return { success: true, registros: 0 };
      }

      this.realm.write(() => {
        for (const cierre of cierres) {
          const cierreSucursal = cierre.sucursal ?? sucursal;
          const cierreVendedor = cierre.vendedor ?? vendedor;
          const rutaCerrada = cierre.rutaCerrada === true || cierre.rutaCerrada === 1 || cierre.rutaCerrada === "1";
          const data = {
            id: `${cierreSucursal}-${cierreVendedor}`,
            sucursal: cierreSucursal,
            vendedor: cierreVendedor,
            fechaCierre: cierre.fechaCierre ? new Date(cierre.fechaCierre) : null,
            rutaCerrada,
            updatedAt: cierre.updatedAt ? new Date(cierre.updatedAt) : new Date(),
            enviado: true,
          };

          this.realm!.create("CierreRuta", data, UpdateMode.Modified);
        }
      });

      console.log(`[FullSync-CierreRuta] ✅ ${cierres.length} cierres descargados del servidor`);
      return { success: true, registros: cierres.length };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Error desconocido";
      console.error("[FullSync-CierreRuta] ❌ Error fetch:", error);
      return { success: false, registros: 0, error: errorMsg };
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
    // Agregar 2 minutos de buffer para incluir registros guardados recientemente
    const fechaConBuffer = new Date(nowMexico.getTime() + 2 * 60 * 1000);
    const fechaMovto = this.formatMexicoDateForServer(fechaConBuffer);
    const url = `${this.apiBaseUrl}/api/MovilesVentas/inventario/erp-movil?sucursal=${encodeURIComponent(
      String(sucursal),
    )}&fechaMovto=${encodeURIComponent(fechaMovto)}`;

    console.log(`[FullSync] Sincronizando inventario incremental desde: ${url}`);

    const response = await fetchWithTimeout(url, {
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

    // Sincronizar productos (full)
    if (this.realm && !this.realm.isClosed) {
      console.log(`[FullSync] Sincronizando productos para sucursal ${sucursal}...`);
      const productosUrl = `${this.apiBaseUrl}/api/MovilesVentas/productos/full`;
      
      // Registrar inicio en BitacoraSync
      const idBitacora = await BitacoraService.registrarInicioSync(
        "Productos",
        "incremental",
        "manual",
        idUsuario,
        sucursal,
        productosUrl
      );

      const productosResponse = await fetchWithTimeout(productosUrl, {
        headers: { accept: "application/json" },
      });

      if (productosResponse.ok) {
        const productos = await productosResponse.json();
        console.log(`[FullSync] Recibidos ${productos.length} productos`);

        if (Array.isArray(productos)) {
          let productosGuardados = 0;
          let productosActualizados = 0;

          this.realm.write(() => {
            for (const producto of productos) {
              const existing = this.realm!.objectForPrimaryKey("Producto", producto.id);

              const productoData = {
                ...producto,
                syncedAt: new Date(),
                syncedAr: nowMexico,
              };

              if (existing) {
                this.realm!.create("Producto", productoData, UpdateMode.Modified);
                productosActualizados++;
              } else {
                this.realm!.create("Producto", productoData);
                productosGuardados++;
              }
            }
          });

          console.log(
            `[FullSync] ✅ Productos sincronizados: guardados=${productosGuardados}, actualizados=${productosActualizados}`,
          );

          // Registrar fin en BitacoraSync
          await BitacoraService.registrarFinSync(idBitacora, {
            exitoso: true,
            registrosLeidos: productos.length,
            registrosGuardados: productosGuardados,
            registrosActualizados: productosActualizados,
          });
        }
      } else {
        console.warn(`[FullSync] ⚠️ Error sincronizando productos: HTTP ${productosResponse.status}`);
        
        // Registrar error en BitacoraSync
        await BitacoraService.registrarFinSync(idBitacora, {
          exitoso: false,
          error: `HTTP ${productosResponse.status}`,
          errorCode: String(productosResponse.status),
        });
      }
    }

    // Sincronizar formas de pago
    if (this.realm && !this.realm.isClosed) {
      console.log(`[FullSync] Sincronizando formas de pago para sucursal ${sucursal}...`);
      const formasPagoUrl = `${this.apiBaseUrl}/api/MovilesVentas/formas-pagos?sucursal=${sucursal}`;
      const formasPagoResponse = await fetchWithTimeout(formasPagoUrl, {
        headers: { accept: "application/json" },
      });

      if (formasPagoResponse.ok) {
        const formasPago = await formasPagoResponse.json();
        console.log(`[FullSync] Recibidas ${formasPago.length} formas de pago`);

        if (Array.isArray(formasPago)) {
          this.realm.write(() => {
            // Limpiar formas de pago existentes
            const existingFormasPago = this.realm!.objects("FormaPago");
            this.realm!.delete(existingFormasPago);

            // Insertar todas las formas de pago
            formasPago.forEach((fp: any) => {
              this.realm!.create("FormaPago", {
                tipo: fp.tipo,
                sucursal: fp.sucursal ?? null,
                descripcion: fp.descripcion ?? null,
                grupoOperacion: fp.grupoOperacion ?? null,
                tarjeta: fp.tarjeta ?? null,
                cuentaBancaria: fp.cuentaBancaria ?? null,
                pago0: fp.pago0 ?? null,
                credito: fp.credito ?? null,
                syncedAt: new Date(),
              });
            });
          });
          console.log(`[FullSync] ✅ Formas de pago sincronizadas: ${formasPago.length} registros`);
        }
      } else {
        console.warn(`[FullSync] ⚠️ Error sincronizando formas de pago: HTTP ${formasPagoResponse.status}`);
      }
    }
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
   * Obtiene los IDs de envases alternativos (idEnvaseOtro) desde KitIntercambio
   * para un producto específico (idProducto).
   */
  getEnvasesIntercambioPorProducto(productoId: number): number[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    const intercambios = this.realm.objects("KitIntercambio").filtered(`idProducto == ${productoId}`);
    const todosIntercambios = this.realm.objects("KitIntercambio");
    const intercambiosArray = Array.from(todosIntercambios).map((k: any) => ({
      id: k.id,
      idProducto: k.idProducto,
      idEnvaseOtro: k.idEnvaseOtro,
    }));
    console.log("=== TABLA KitIntercambio ===");
    console.table(intercambiosArray);
    console.log(`Total registros: ${intercambiosArray.length}`);
    const idsEnvases = Array.from(intercambios)
      .map((k: any) => k.idEnvaseOtro)
      .filter((id): id is number => id != null);
    console.log(
      `[FullSync] KitIntercambio para producto ${productoId}: encontrados ${idsEnvases.length} envases alternativos:`,
      idsEnvases,
    );
    return idsEnvases;
  }

  /**
   * Obtiene el precioEnvase de KitIntercambio para una combinación de idProducto e idEnvaseOtro.
   * Retorna null si no se encuentra.
   */
  getPrecioEnvaseIntercambio(idProducto: number, idEnvaseOtro: number): number | null {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return null;
    const kits = this.realm
      .objects("KitIntercambio")
      .filtered(`idProducto == ${idProducto} AND idEnvaseOtro == ${idEnvaseOtro}`);
    if (kits.length === 0) return null;
    const kit: any = kits[0];
    return kit.precioEnvase != null ? kit.precioEnvase : null;
  }

  /**
   * Busca un producto por su claveProd.
   */
  getProductoByClaveProd(claveProd: string): any | null {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return null;
    const productos = this.realm.objects("Producto").filtered("claveProd == $0", claveProd);
    return productos.length > 0 ? productos[0] : null;
  }

  /**
   * Obtiene productos por sus IDs (para buscar envases alternativos desde KitIntercambio).
   */
  getProductosPorIds(ids: number[]): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed || ids.length === 0) return [];
    // Construir query IN con los IDs
    const idsQuery = ids.join(",");
    const productos = this.realm.objects("Producto").filtered(`id IN {${idsQuery}}`);
    return Array.from(productos);
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
        bitacoraValidacion: 0,
        bitacoraTiemposVenta: 0,
        inventarioEnvasesHistorial: 0,
        reubicaciones: 0,
        visitasRealizadas: 0,
        kitIntercambio: 0,
        cias: 0,
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
      bitacoraValidacion: this.realm.objects("BitacoraValidacion").length,
      bitacoraTiemposVenta: this.realm.objects("BitacoraTiemposVenta").length,
      inventarioEnvasesHistorial: this.realm.objects("InventarioEnvasesHistorial").length,
      reubicaciones: this.realm.objects("Reubicacion").length,
      visitasRealizadas: this.realm.objects("VisitaRealizada").length,
      formasPago: this.realm.objects("FormaPago").length,
      kitIntercambio: this.realm.objects("KitIntercambio").length,
      cias: this.realm.objects("Cia").length,
    };
  }

  /**
   * Obtiene kits intercambio con paginación
   */
  getKitIntercambioPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(this.realm.objects("KitIntercambio").slice(offset, offset + limit));
  }

  getFormasPagoPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(
      this.realm
        .objects("FormaPago")
        .sorted("tipo")
        .slice(offset, offset + limit),
    );
  }

  getFormasPago(): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(this.realm.objects("FormaPago").sorted("tipo"));
  }

  getCias(): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(this.realm.objects("Cia"));
  }

  getCiasPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return [];
    return Array.from(this.realm.objects("Cia").slice(offset, offset + limit));
  }

  getCiaById(id: number): any | null {
    if (!this.isInitialized || !this.realm || this.realm.isClosed) return null;
    return this.realm.objectForPrimaryKey("Cia", id);
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
