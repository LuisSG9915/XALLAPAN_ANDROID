import { Platform } from "react-native";
import Realm from "realm";
import NetInfo from "@react-native-community/netinfo";
import DeviceInfo from "react-native-device-info";
import AuthService from "./AuthService";
import { fetchWithTimeout } from "./fetchWithTimeout";

export type DatosValidacionUbicacion = {
  idCliente: number | null;
  motivo: string;
  valido: boolean;
  distancia: number | null;
  accuracy: number | null;
  metrosPermitidos: number | null;
  latitud: number | null;
  longitud: number | null;
  clienteLatitud: number | null;
  clienteLongitud: number | null;
  numFixes: number | null;
  peorAccuracy: number | null;
  tiempoMs: number | null;
  conCobertura?: boolean | null;
};

export type DatosTiemposVenta = {
  idCliente: number | null;
  idMovil: number | null;
  gpsFuente: string;
  gpsMs: number | null;
  impresionMs: number | null;
  guardadoVentaMs: number | null;
  postVentaMs: number | null;
  totalMs: number | null;
  items: number | null;
  dobleTicket: boolean | null;
  ticketImpreso: boolean | null;
};

function coerceNumber(value: any): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

function coerceBool(value: any): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true" || value === "True" || value === "TRUE") return true;
  if (value === 0 || value === "0" || value === "false" || value === "False" || value === "FALSE") return false;
  return null;
}

function coerceString(value: any): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

class GpsBitacoraService {
  private realm: Realm | null = null;
  private apiBaseUrl = "https://api.cbinformatica.net:9031";
  // Locks contra envíos concurrentes: este servicio se invoca desde varios
  // puntos (BackgroundSyncService cada 3 min y FullSyncService en syncIncremental
  // y syncAll). Sin lock, dos ejecuciones leían los mismos pendientes y el
  // servidor recibía cada registro duplicado.
  private enviandoGps = false;
  private enviandoValidaciones = false;
  private enviandoTiempos = false;

  /**
   * Inyecta la instancia de Realm compartida desde FullSyncService
   */
  setRealm(realm: Realm): void {
    this.realm = realm;
    console.log("[GpsBitacoraService] Realm inyectado correctamente");
  }

  private getRealm(): Realm {
    if (!this.realm || this.realm.isClosed) {
      throw new Error("[GpsBitacoraService] Realm no inicializado.");
    }
    return this.realm;
  }

  /**
   * Registra una ubicación GPS y su validación de recorrido en una sola transacción Realm.
   * Usado por BackgroundLocationService cada 30s para evitar dos write() separados.
   */
  async registrarCapturaTracking(
    latitud: number,
    longitud: number,
    precision: number | undefined,
    conCobertura: boolean | undefined,
    motivoRecorrido: string,
  ): Promise<void> {
    try {
      if (!this.realm || this.realm.isClosed) {
        console.warn("[GpsBitacoraService] Realm no inicializado. Se omitirá registro de tracking.");
        return;
      }

      const realm = this.getRealm();
      const user = await AuthService.restoreSession();
      if (!user) {
        console.warn("[GpsBitacoraService] Usuario no logueado, omitiendo registro de tracking");
        return;
      }

      const idUsuario = user.id || user.idUsuario || 0;
      const sucursal = user.sucursal || user.sucursal_origen || 0;

      let metros: number | null = null;
      try {
        const realmUser = realm.objectForPrimaryKey("Usuario", idUsuario) as any;
        metros = realmUser?.metros ?? null;
      } catch (e) {
        metros = null;
      }

      const gpsId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const valId = `${Date.now()}-${Math.random().toString(36).substring(2, 12)}`;
      const now = new Date();

      realm.write(() => {
        realm.create("BitacoraGps", {
          id: gpsId,
          idUsuario,
          sucursal,
          latitud,
          longitud,
          precision: precision ?? null,
          bateria: metros ?? null,
          conCobertura: conCobertura ?? null,
          id_movil: null,
          fecha: now,
          enviado: false,
        });

        realm.create("BitacoraValidacion", {
          id: valId,
          idUsuario,
          sucursal,
          idCliente: null,
          motivo: motivoRecorrido,
          valido: true,
          distancia: null,
          accuracy: precision ?? null,
          metrosPermitidos: null,
          latitud,
          longitud,
          clienteLatitud: null,
          clienteLongitud: null,
          numFixes: 1,
          peorAccuracy: precision ?? null,
          tiempoMs: null,
          conCobertura: conCobertura ?? null,
          id_movil: null,
          plataforma: Platform.OS,
          versionApp: DeviceInfo.getVersion(),
          fecha: now,
          enviado: false,
        });
      });

      console.log(
        `[GpsBitacoraService] Tracking registrado: lat=${latitud}, lng=${longitud}, ` +
          `precision=${precision}, cobertura=${conCobertura}, motivo=${motivoRecorrido}`,
      );
    } catch (error) {
      console.warn("[GpsBitacoraService] Error al registrar captura de tracking:", error);
    }
  }

  /**
   * Registra una ubicación GPS en la bitácora local (Realm).
   * Se llama automáticamente desde LocationService.getCurrentLocation()
   */
  async registrarUbicacion(latitud: number, longitud: number, precision?: number, conCobertura?: boolean): Promise<void> {
    try {
      if (!this.realm || this.realm.isClosed) {
        console.warn("[GpsBitacoraService] Realm no inicializado. Se omitirá registro GPS.");
        return;
      }

      const realm = this.getRealm();
      const user = await AuthService.restoreSession();

      if (!user) {
        console.warn("[GpsBitacoraService] Usuario no logueado, omitiendo registro GPS");
        return;
      }

      const idUsuario = user.id || user.idUsuario || 0;
      const sucursal = user.sucursal || user.sucursal_origen || 0;

      // Obtener metros de validación del usuario desde Realm
      let metros: number | null = null;
      try {
        const realmUser = realm.objectForPrimaryKey("Usuario", idUsuario) as any;
        metros = realmUser?.metros ?? null;
      } catch (e) {
        metros = null;
      }

      const id = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      realm.write(() => {
        realm.create("BitacoraGps", {
          id,
          idUsuario,
          sucursal,
          latitud,
          longitud,
          precision: precision ?? null,
          bateria: metros ?? null, // Campo reutilizado: ahora almacena metros de validación
          conCobertura: conCobertura ?? null,
          id_movil: null,
          fecha: new Date(),
          enviado: false,
        });
      });

      console.log(
        `[GpsBitacoraService] 📍 GPS registrado: lat=${latitud}, lng=${longitud}, precision=${precision}, metros=${metros}, conCobertura=${conCobertura}`,
      );
    } catch (error) {
      console.warn("[GpsBitacoraService] Error al registrar ubicación GPS:", error);
    }
  }

  /**
   * Registra el diagnóstico de una validación de ubicación en la bitácora local (Realm).
   * Se llama desde LocationService.validarUbicacionConAlerta tras cada intento.
   */
  async registrarValidacion(datos: DatosValidacionUbicacion): Promise<void> {
    try {
      if (!this.realm || this.realm.isClosed) {
        console.warn("[GpsBitacoraService] Realm no inicializado. Se omitirá registro de validación.");
        return;
      }

      const realm = this.getRealm();
      const user = await AuthService.restoreSession();
      if (!user) {
        console.warn("[GpsBitacoraService] Usuario no logueado, omitiendo registro de validación");
        return;
      }

      const idUsuario = user.id || user.idUsuario || 0;
      const sucursal = user.sucursal || user.sucursal_origen || 0;
      const id = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      realm.write(() => {
        realm.create("BitacoraValidacion", {
          id,
          idUsuario,
          sucursal,
          idCliente: datos.idCliente ?? null,
          motivo: datos.motivo,
          valido: datos.valido,
          distancia: datos.distancia ?? null,
          accuracy: datos.accuracy ?? null,
          metrosPermitidos: datos.metrosPermitidos ?? null,
          latitud: datos.latitud ?? null,
          longitud: datos.longitud ?? null,
          clienteLatitud: datos.clienteLatitud ?? null,
          clienteLongitud: datos.clienteLongitud ?? null,
          numFixes: datos.numFixes ?? null,
          peorAccuracy: datos.peorAccuracy ?? null,
          tiempoMs: datos.tiempoMs ?? null,
          conCobertura: datos.conCobertura ?? null,
          id_movil: null,
          plataforma: Platform.OS,
          versionApp: DeviceInfo.getVersion(),
          fecha: new Date(),
          enviado: false,
        });
      });

      console.log(
        `[GpsBitacoraService] 📋 Validación registrada: motivo=${datos.motivo}, valido=${datos.valido}, ` +
          `distancia=${datos.distancia}, accuracy=${datos.accuracy}, fixes=${datos.numFixes}`,
      );
    } catch (error) {
      console.warn("[GpsBitacoraService] Error al registrar validación:", error);
    }
  }

  /**
   * Registra los tiempos de cada etapa del cierre de venta (GPS, impresión,
   * guardado, post-venta). Se llama desde SalesScreen.processSale tras cada
   * venta exitosa para detectar en el servidor cuellos de botella del cierre.
   */
  async registrarTiemposVenta(datos: DatosTiemposVenta): Promise<void> {
    try {
      if (!this.realm || this.realm.isClosed) {
        console.warn("[GpsBitacoraService] Realm no inicializado. Se omitirá registro de tiempos de venta.");
        return;
      }

      const realm = this.getRealm();
      const user = await AuthService.restoreSession();
      if (!user) {
        console.warn("[GpsBitacoraService] Usuario no logueado, omitiendo registro de tiempos de venta");
        return;
      }

      const idUsuario = user.id || user.idUsuario || 0;
      const sucursal = user.sucursal || user.sucursal_origen || 0;
      const id = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      let conCobertura: boolean | null = null;
      try {
        const net = await NetInfo.fetch();
        conCobertura = net.isConnected ?? null;
      } catch {
        conCobertura = null;
      }

      realm.write(() => {
        realm.create("BitacoraTiemposVenta", {
          id,
          idUsuario,
          sucursal,
          idCliente: datos.idCliente ?? null,
          idMovil: datos.idMovil ?? null,
          gpsFuente: datos.gpsFuente,
          gpsMs: datos.gpsMs ?? null,
          impresionMs: datos.impresionMs ?? null,
          guardadoVentaMs: datos.guardadoVentaMs ?? null,
          postVentaMs: datos.postVentaMs ?? null,
          totalMs: datos.totalMs ?? null,
          items: datos.items ?? null,
          dobleTicket: datos.dobleTicket ?? null,
          ticketImpreso: datos.ticketImpreso ?? null,
          conCobertura,
          plataforma: Platform.OS,
          versionApp: DeviceInfo.getVersion(),
          fecha: new Date(),
          enviado: false,
        });
      });

      console.log(
        `[GpsBitacoraService] ⏱️ Tiempos de venta registrados: total=${datos.totalMs}ms, ` +
          `gps=${datos.gpsMs}ms(${datos.gpsFuente}), impresion=${datos.impresionMs}ms, ` +
          `guardado=${datos.guardadoVentaMs}ms, post=${datos.postVentaMs}ms`,
      );
    } catch (error) {
      console.warn("[GpsBitacoraService] Error al registrar tiempos de venta:", error);
    }
  }

  /**
   * Envía los registros de tiempos de venta pendientes al servidor.
   * Llamado desde syncIncremental() y syncAll() en FullSyncService,
   * y al final de cada ciclo en BackgroundSyncService.
   */
  async enviarTiemposVentaPendientes(sucursal: number, idUsuario: number): Promise<void> {
    if (this.enviandoTiempos) {
      console.log("[GpsBitacoraService] Envío de tiempos de venta ya en curso; se omite esta llamada (evita duplicados).");
      return;
    }
    if (!this.realm || this.realm.isClosed) return;

    this.enviandoTiempos = true;
    try {
      const realm = this.getRealm();

      // Colección "viva": se toman siempre los PRIMEROS BATCH_SIZE hasta vaciarla
      // (los offsets crecientes sobre una colección que se encoge saltaban registros).
      const todosPendientes = realm.objects("BitacoraTiemposVenta").filtered("enviado == false");
      if (todosPendientes.length === 0) return;

      const BATCH_SIZE = 100;
      console.log(`[GpsBitacoraService] Enviando ${todosPendientes.length} registros de tiempos de venta al servidor en lotes de ${BATCH_SIZE}...`);

      const url = `${this.apiBaseUrl}/api/MovilesVentas/sp_MovilesBitacoraTiemposVentaArrastreJSON?sucursal=${sucursal}&idUsuario=${idUsuario}`;

      while (todosPendientes.length > 0) {
        const batch = todosPendientes.slice(0, BATCH_SIZE);
        const payload = batch.map((p: any) => ({
          id: coerceString(p.id),
          idUsuario: coerceNumber(p.idUsuario) ?? 0,
          sucursal: coerceNumber(p.sucursal) ?? 0,
          idCliente: coerceNumber(p.idCliente),
          idMovil: coerceNumber(p.idMovil),
          gpsFuente: coerceString(p.gpsFuente),
          gpsMs: coerceNumber(p.gpsMs),
          impresionMs: coerceNumber(p.impresionMs),
          guardadoVentaMs: coerceNumber(p.guardadoVentaMs),
          postVentaMs: coerceNumber(p.postVentaMs),
          totalMs: coerceNumber(p.totalMs),
          items: coerceNumber(p.items),
          dobleTicket: coerceBool(p.dobleTicket),
          ticketImpreso: coerceBool(p.ticketImpreso),
          conCobertura: coerceBool(p.conCobertura),
          plataforma: coerceString(p.plataforma),
          versionApp: coerceString(p.versionApp),
          fecha: this.formatDate(p.fecha),
        }));

        const enviado = await this.enviarLote(url, batch, payload);
        if (!enviado) break; // se reintenta en el próximo ciclo de sync
      }
    } finally {
      this.enviandoTiempos = false;
    }
  }

  /**
   * Envía los registros GPS pendientes al servidor.
   * Llamado desde syncIncremental() y syncAll() en FullSyncService,
   * y al final de cada ciclo en BackgroundSyncService.
   */
  async enviarBitacorasPendientes(sucursal: number, idUsuario: number): Promise<void> {
    if (this.enviandoGps) {
      console.log("[GpsBitacoraService] Envío GPS ya en curso; se omite esta llamada (evita duplicados).");
      return;
    }
    if (!this.realm || this.realm.isClosed) return;

    this.enviandoGps = true;
    try {
      const realm = this.getRealm();

      // OJO: la colección Realm es "viva": al marcar enviado=true se encoge sola.
      // Por eso se toman siempre los PRIMEROS BATCH_SIZE hasta vaciarla; usar
      // offsets crecientes sobre la colección viva saltaba registros.
      const todosPendientes = realm.objects("BitacoraGps").filtered("enviado == false");
      if (todosPendientes.length === 0) return;

      const BATCH_SIZE = 100;
      console.log(`[GpsBitacoraService] Enviando ${todosPendientes.length} registros GPS al servidor en lotes de ${BATCH_SIZE}...`);

      const url = `${this.apiBaseUrl}/api/MovilesVentas/sp_MovilesBitacoraGpsArrastreJSON?sucursal=${sucursal}&idUsuario=${idUsuario}`;

      while (todosPendientes.length > 0) {
        const batch = todosPendientes.slice(0, BATCH_SIZE);
        const payload = batch.map((p: any) => ({
          id: coerceString(p.id),
          idUsuario: coerceNumber(p.idUsuario) ?? 0,
          sucursal: coerceNumber(p.sucursal) ?? 0,
          latitud: coerceNumber(p.latitud) ?? 0,
          longitud: coerceNumber(p.longitud) ?? 0,
          precision: coerceNumber(p.precision),
          bateria: coerceNumber(p.bateria),
          conCobertura: coerceBool(p.conCobertura),
          id_movil: coerceNumber(p.id_movil),
          fecha: this.formatDate(p.fecha),
        }));

        const enviado = await this.enviarLote(url, batch, payload);
        if (!enviado) break; // se reintenta en el próximo ciclo de sync
      }
    } finally {
      this.enviandoGps = false;
    }
  }

  /**
   * Envía los registros de validación de ubicación pendientes al servidor.
   * Llamado desde syncIncremental() y syncAll() en FullSyncService,
   * y al final de cada ciclo en BackgroundSyncService.
   */
  async enviarValidacionesPendientes(sucursal: number, idUsuario: number): Promise<void> {
    if (this.enviandoValidaciones) {
      console.log("[GpsBitacoraService] Envío de validaciones ya en curso; se omite esta llamada (evita duplicados).");
      return;
    }
    if (!this.realm || this.realm.isClosed) return;

    this.enviandoValidaciones = true;
    try {
      const realm = this.getRealm();

      // Colección "viva": se toman siempre los PRIMEROS BATCH_SIZE hasta vaciarla
      // (los offsets crecientes sobre una colección que se encoge saltaban registros).
      const todosPendientes = realm.objects("BitacoraValidacion").filtered("enviado == false");
      if (todosPendientes.length === 0) return;

      const BATCH_SIZE = 100;
      console.log(`[GpsBitacoraService] Enviando ${todosPendientes.length} validaciones de ubicación al servidor en lotes de ${BATCH_SIZE}...`);

      const url = `${this.apiBaseUrl}/api/MovilesVentas/sp_MovilesBitacoraValidacionArrastreJSON?sucursal=${sucursal}&idUsuario=${idUsuario}`;

      while (todosPendientes.length > 0) {
        const batch = todosPendientes.slice(0, BATCH_SIZE);
        const payload = batch.map((p: any) => ({
          id: coerceString(p.id),
          idUsuario: coerceNumber(p.idUsuario) ?? 0,
          sucursal: coerceNumber(p.sucursal) ?? 0,
          idCliente: coerceNumber(p.idCliente),
          motivo: coerceString(p.motivo) ?? "ok",
          valido: coerceBool(p.valido) ?? false,
          distancia: coerceNumber(p.distancia),
          accuracy: coerceNumber(p.accuracy),
          metrosPermitidos: coerceNumber(p.metrosPermitidos),
          latitud: coerceNumber(p.latitud),
          longitud: coerceNumber(p.longitud),
          clienteLatitud: coerceNumber(p.clienteLatitud),
          clienteLongitud: coerceNumber(p.clienteLongitud),
          numFixes: coerceNumber(p.numFixes),
          peorAccuracy: coerceNumber(p.peorAccuracy),
          tiempoMs: coerceNumber(p.tiempoMs),
          conCobertura: coerceBool(p.conCobertura),
          id_movil: coerceNumber(p.id_movil),
          plataforma: coerceString(p.plataforma),
          versionApp: coerceString(p.versionApp),
          fecha: this.formatDate(p.fecha),
        }));

        const enviado = await this.enviarLote(url, batch, payload);
        if (!enviado) break; // se reintenta en el próximo ciclo de sync
      }
    } finally {
      this.enviandoValidaciones = false;
    }
  }

  private async enviarLote(url: string, batch: any, payload: any[]): Promise<boolean> {
    const realm = this.getRealm();
    console.log(`[GpsBitacoraService] Enviando lote de ${payload.length} registros...`);

    try {
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        console.log(`[GpsBitacoraService] ✅ Lote de ${payload.length} bitácoras enviado correctamente.`);
        realm.write(() => {
          for (const item of batch) {
            item.enviado = true;
          }
        });
        return true;
      }

      const txt = await response.text().catch(() => "");
      console.error("[GpsBitacoraService] ❌ Error al enviar lote:", response.status, txt);
      console.error("[GpsBitacoraService] ❌ Payload:", JSON.stringify(payload, null, 2));
      return false;
    } catch (error) {
      console.error("[GpsBitacoraService] ❌ Error crítico enviando lote:", error);
      return false;
    }
  }

  /**
   * Elimina registros ya enviados con más de `diasAntiguedad` días.
   * Se llama después de cada sync exitoso para evitar que Realm crezca sin control.
   */
  limpiarRegistrosEnviados(diasAntiguedad: number = 7): void {
    if (!this.realm || this.realm.isClosed) return;

    const realm = this.getRealm();
    const corte = new Date();
    corte.setDate(corte.getDate() - diasAntiguedad);

    try {
      const gpsEnviados = realm.objects("BitacoraGps").filtered("enviado == true AND fecha < $0", corte);
      const validacionesEnviadas = realm.objects("BitacoraValidacion").filtered("enviado == true AND fecha < $0", corte);
      const tiemposEnviados = realm.objects("BitacoraTiemposVenta").filtered("enviado == true AND fecha < $0", corte);
      const totalGps = gpsEnviados.length;
      const totalVal = validacionesEnviadas.length;
      const totalTiempos = tiemposEnviados.length;

      if (totalGps === 0 && totalVal === 0 && totalTiempos === 0) return;

      realm.write(() => {
        realm.delete(gpsEnviados);
        realm.delete(validacionesEnviadas);
        realm.delete(tiemposEnviados);
      });

      console.log(
        `[GpsBitacoraService] Limpieza: ${totalGps} BitacoraGps, ${totalVal} BitacoraValidacion y ${totalTiempos} BitacoraTiemposVenta eliminados (antigüedad > ${diasAntiguedad} días)`,
      );
    } catch (error) {
      console.warn("[GpsBitacoraService] Error al limpiar registros enviados:", error);
    }
  }

  private formatDate(date: Date): string {
    if (!date) return new Date().toISOString();
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const min = String(date.getMinutes()).padStart(2, "0");
    const ss = String(date.getSeconds()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}`;
  }
}

export default new GpsBitacoraService();
