import { Alert, Linking, NativeModules, Platform } from "react-native";
import BackgroundActions from "react-native-background-actions";
import Geolocation, { GeoPosition, GeoError } from "react-native-geolocation-service";
import NetInfo from "@react-native-community/netinfo";
import FullSyncService from "./FullSyncService";
import AuthService from "./AuthService";
import GpsBitacoraService, {
  TRACKING_UPLOAD_INTERVAL_MS,
} from "./GpsBitacoraService";
import LocationService from "./LocationService";
import StallAlertService, { StallEvaluationResult } from "./StallAlertService";
import { cancelStallNotification, showStallNotification } from "./StallNotificationNative";

const TAG = "[BackgroundLocationService]";
const DEFAULT_TOLERANCE_METERS = 30;
const DEFAULT_STALLED_SECONDS = 30 * 60;

// El watchdog no es el reloj principal: solo verifica que watchPosition siga
// vivo y re-suscribe si no llega ningún fix en este tiempo.
const WATCHDOG_INTERVAL_MS = 120000; // 2 minutos
const MAX_FIX_AGE_MS = 180000; // 3 minutos sin fix -> re-suscribir

// Historial acotado de fixes de buena calidad, para poder corroborar una
// validación cuando el GPS falla justo en el momento de vender.
// NO reemplaza la lectura en vivo: solo acredita que el vendedor estuvo
// físicamente en el punto hace unos minutos.
const FIXES_BUENOS_MAX = 12;
const FIXES_BUENOS_RETENCION_MS = 10 * 60 * 1000;
const FIX_BUENO_ACCURACY_MAX = 25; // metros

// Historial de fixes que quedaron persistidos localmente en la bitácora Realm
// (BitacoraTrackingGps); el envío al servidor es asíncrono y puede no estar
// confirmado aún. Es la única evidencia que puede acreditar una venta
// `ok_tracking`: un fix que ni siquiera quedó escrito en la bitácora local no
// debe servir para aprobar nada.
// La razón es el detector de incoherencias: cuando una validación fuerza su
// ráfaga, comparte la suscripción nativa y el mismo fix contaminado llega
// también al callback de fondo (caso 373510: la lectura de 419 m se copió a
// `ultimoFixTracking` y el candado terminó comparando el fix consigo mismo).
const FIXES_PERSISTIDOS_MAX = 12;

// Reglas de admisión de evidencia (ver docs/PLAN_OK_TRACKING.md §14):
//
//  R1 — Proveedor: un fix de red puede declarar ±12 m y estar 400 m fuera del
//       cliente (caso 373510: accuracy 11.9 m, distancia 419 m). Solo el GNSS
//       acredita presencia. En Android, FusedLocationProviderClient SIEMPRE
//       reporta provider="fused" (nunca "gps") y `speed` llega como número aun
//       estando detenido, así que `fused` se acepta con el umbral general de
//       precisión: la exigencia anterior (≤20 m + velocidad finita) descartaba
//       el 74% de la evidencia válida en producción (caso 400517: fix a 50.6 m
//       del cliente con ±24.2 m rechazado). `network` y `passive` se rechazan.
//
//  R2 — Salto: entre dos fixes consecutivos no se puede recorrer más de
//       150 km/h. Un salto así se descarta y NO mueve la base; si llegan dos
//       fixes seguidos que concuerdan entre sí (equipo que vuelve de un hueco
//       o de suspensión), la cadena se reancla en el punto nuevo.
const VELOCIDAD_MAX_PLAUSIBLE_MPS = 41.7; // 150 km/h
const VELOCIDAD_MIN_DT_SEG = 5;
const REANCLAJE_VENTANA_MS = 3 * 60 * 1000;

const RADIO_TIERRA_M = 6371000;
const distanciaMetros = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * RADIO_TIERRA_M * Math.asin(Math.min(1, Math.sqrt(a)));
};

export type FixTrackingConfiable = {
  latitud: number;
  longitud: number;
  accuracy: number;
  // Reloj GNSS (position.timestamp): se usa para velocidades entre fixes.
  timestamp: number;
  // Reloj local de recepción (Date.now()): se usa para ventanas de antigüedad,
  // porque un reloj de sistema adelantado respecto al GNSS envejecía los fixes
  // y vaciaba la evidencia (desfase documentado en casos `sin_senal` con
  // tracking bueno simultáneo, p. ej. 392478).
  receivedAt?: number;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type State = { enabled: boolean };

class BackgroundLocationService {
  private static instance: BackgroundLocationService;
  private isReady = false;
  private intervalMs = 30000;
  private intervaloNativo = 15000;
  private readonly INTERVALO_ADQUISICION_MS = 5000;
  // El motor GNSS se mantiene despierto a ≤15 s aunque la escritura sea cada
  // 30/60 s: con el intervalo nativo de 60 s el chip dormía entre lecturas y
  // entregaba precisiones estacionarias de 21-55 m justo en los puntos que la
  // evidencia de tracking necesitaba (defecto del caso 400517).
  private readonly INTERVALO_ENGANCHADO_MS = 15000;
  private readonly UMBRAL_ENGANCHE_ACCURACY = 30;
  private readonly FIXES_PARA_ENGANCHE = 2;
  private readonly FIXES_PARA_PERDER_ENGANCHE = 3;
  private isTaskRunning = false;
  private gpsEnganchado = false;
  private captureInFlight = false;
  private backgroundTaskInFlight: Promise<void> | null = null;
  private consecutiveGoodFixes = 0;
  private consecutiveBadFixes = 0;
  private watchId: number | null = null;
  private lastFixAt = 0;
  // Último fix efectivamente persistido (distinto de lastFixAt, que solo marca
  // actividad del proveedor para el watchdog).
  private lastCaptureAt = 0;
  // Precisión de la última captura persistida: si quedó por encima del umbral
  // de evidencia, un fix posterior más preciso puede actualizar la ventana
  // (upgrade) en vez de quedar descartado por el throttle (caso 400517).
  private lastCaptureAccuracy = 999;
  private lastTrackingUploadAttemptAt = 0;
  private trackingUploadInFlight: Promise<void> | null = null;
  // Token de generación: invalida callbacks/watchdogs de loops anteriores.
  private generation = 0;
  // Evita carreras en start() (varios health-checks/disparadores simultáneos).
  private startPromise: Promise<State> | null = null;
  // Evita que el Alert de notificaciones salte en cada reintento del servicio.
  private notificationAlertShown = false;
  private batteryOptimizationAlertShown = false;
  private stallNotificationToggle = false;
  private stallContext: {
    routeKey: string;
    idUsuario: number;
    nombreUsuario?: string | null;
    sucursal: number;
    metrosTolerancia: number;
    segundosVarado: number;
  } | null = null;

  private ultimoFixTracking: {
    latitud: number;
    longitud: number;
    accuracy: number;
    timestamp: number;
    receivedAt?: number;
  } | null = null;
  private saltoDescartadoUltimoTracking: {
    latitud: number;
    longitud: number;
    accuracy: number;
    timestamp: number;
    receivedAt?: number;
  } | null = null;

  private fixesRecientes: FixTrackingConfiable[] = [];
  // Solo fixes que quedaron escritos en la bitácora (ver FIXES_PERSISTIDOS_MAX).
  private fixesPersistidos: FixTrackingConfiable[] = [];
  // Último fix descartado por salto imposible: si el siguiente concuerda con
  // él, el movimiento era real y se reancla la cadena (ver R2).
  private fixDescartadoPorSalto: FixTrackingConfiable | null = null;

  private constructor() {}

  static getInstance(): BackgroundLocationService {
    if (!BackgroundLocationService.instance) {
      BackgroundLocationService.instance = new BackgroundLocationService();
    }
    return BackgroundLocationService.instance;
  }

  getUltimoFixTracking(): { latitud: number; longitud: number; accuracy: number; timestamp: number; receivedAt?: number } | null {
    return this.ultimoFixTracking;
  }

  /**
   * Fixes recientes con calidad suficiente para acreditar presencia en un punto.
   * Devuelve [] si no hay evidencia (falla segura).
   */
  getFixesRecientes(maxEdadMs: number, maxAccuracy: number): FixTrackingConfiable[] {
    const ahora = Date.now();
    return this.fixesRecientes.filter(
      (f) => ahora - (f.receivedAt ?? f.timestamp) <= maxEdadMs && f.accuracy <= maxAccuracy,
    );
  }

  private registrarFixReciente(position: GeoPosition): void {
    const { latitude, longitude, accuracy } = position.coords;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

    const acc = accuracy ?? 999;
    if (acc > FIX_BUENO_ACCURACY_MAX) return;

    const ahora = Date.now();
    const ts = position.timestamp ?? ahora;
    this.fixesRecientes.push({ latitud: latitude, longitud: longitude, accuracy: acc, timestamp: ts, receivedAt: ahora });
    if (this.fixesRecientes.length > FIXES_BUENOS_MAX) this.fixesRecientes.shift();
    this.fixesRecientes = this.fixesRecientes.filter((f) => ahora - (f.receivedAt ?? f.timestamp) <= FIXES_BUENOS_RETENCION_MS);
  }

  /**
   * Fixes que quedaron persistidos localmente en la bitácora Realm (pendientes
   * o ya enviados). A diferencia de `getFixesRecientes`, esta lista NO incluye
   * la ráfaga que dispara una validación: solo lo que la bitácora local podrá
   * mostrar al auditar la venta.
   */
  getFixesPersistidos(maxEdadMs: number, maxAccuracy: number): FixTrackingConfiable[] {
    const ahora = Date.now();
    return this.fixesPersistidos.filter(
      (f) => ahora - (f.receivedAt ?? f.timestamp) <= maxEdadMs && f.accuracy <= maxAccuracy,
    );
  }

  private registrarFixPersistido(position: GeoPosition): void {
    const { latitude, longitude, accuracy } = position.coords;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

    const acc = accuracy ?? 999;
    if (acc > FIX_BUENO_ACCURACY_MAX) return;

    // R1: proveedor confiable (ver el bloque de reglas arriba).
    const proveedor = (position.provider ?? "").toLowerCase();
    const proveedorConfiable =
      proveedor === "" || // plataformas que no reportan proveedor
      proveedor === "gps" ||
      (proveedor === "fused" && acc <= FIX_BUENO_ACCURACY_MAX);
    if (!proveedorConfiable) {
      console.log(TAG, `Fix de tracking descartado por proveedor '${proveedor}' (acc=${Math.round(acc)} m)`);
      return;
    }

    const ahora = Date.now();
    const ts = position.timestamp ?? ahora;
    const candidato: FixTrackingConfiable = {
      latitud: latitude,
      longitud: longitude,
      accuracy: acc,
      timestamp: ts,
      receivedAt: ahora,
    };

    // R2: salto físicamente imposible contra la base vigente.
    const ultima = this.fixesPersistidos[this.fixesPersistidos.length - 1];
    const base = ultima && ahora - (ultima.receivedAt ?? ultima.timestamp) <= FIXES_BUENOS_RETENCION_MS ? ultima : null;
    if (base) {
      const dt = Math.max((ts - base.timestamp) / 1000, VELOCIDAD_MIN_DT_SEG);
      const velocidad = distanciaMetros(base.latitud, base.longitud, latitude, longitude) / dt;
      if (velocidad > VELOCIDAD_MAX_PLAUSIBLE_MPS) {
        const descartado = this.fixDescartadoPorSalto;
        const dtReancla = descartado
          ? Math.max((ts - descartado.timestamp) / 1000, VELOCIDAD_MIN_DT_SEG)
          : 0;
        const velocidadReancla = descartado
          ? distanciaMetros(descartado.latitud, descartado.longitud, latitude, longitude) / dtReancla
          : Infinity;

        // Dos fixes seguidos que concuerdan entre sí: el movimiento es real.
        if (descartado && ts - descartado.timestamp <= REANCLAJE_VENTANA_MS && velocidadReancla <= VELOCIDAD_MAX_PLAUSIBLE_MPS) {
          this.fixesPersistidos = [descartado, candidato];
          this.fixDescartadoPorSalto = null;
          console.log(
            TAG,
            `Cadena de tracking reanclada: ${Math.round(velocidadReancla * 3.6)} km/h entre dos fixes concordantes`,
          );
          return;
        }

        this.fixDescartadoPorSalto = candidato;
        console.log(
          TAG,
          `Fix de tracking descartado por salto: ${Math.round(velocidad * 3.6)} km/h ` +
            `(${Math.round(distanciaMetros(base.latitud, base.longitud, latitude, longitude))} m en ${Math.round(dt)} s)`,
        );
        return;
      }
    }

    this.fixDescartadoPorSalto = null;
    this.fixesPersistidos.push(candidato);
    if (this.fixesPersistidos.length > FIXES_PERSISTIDOS_MAX) this.fixesPersistidos.shift();
    this.fixesPersistidos = this.fixesPersistidos.filter((f) => ahora - (f.receivedAt ?? f.timestamp) <= FIXES_BUENOS_RETENCION_MS);
  }

  /**
   * Inicializa Realm (necesario para poder escribir la bitácora GPS
   * en el contexto headless del foreground service).
   */
  private async ensureReady(): Promise<void> {
    if (this.isReady && FullSyncService.getRealm()) return;
    this.isReady = false;
    await FullSyncService.initialize();
    if (!FullSyncService.getRealm()) {
      throw new Error("Realm no disponible para el tracking GPS");
    }
    this.isReady = true;
  }

  private async loadStallContext(): Promise<void> {
    const user = await AuthService.restoreSession();
    const realm = FullSyncService.getRealm();
    const idUsuario = Number(user?.id ?? user?.idUsuario ?? 0);
    const sucursal = Number(user?.sucursal_origen ?? user?.sucursal ?? 0);
    const canReadRealm = Boolean(realm && typeof (realm as any).objectForPrimaryKey === "function");
    const routeConfig = canReadRealm && idUsuario > 0
      ? realm!.objectForPrimaryKey("RouteConfig", "routeConfig") as any
      : null;
    const realmUser = canReadRealm && idUsuario > 0
      ? realm!.objectForPrimaryKey("Usuario", idUsuario) as any
      : null;
    const tolerance = Number(
      realmUser?.metrosTolerancia ?? realmUser?.metros ?? user?.metrosTolerancia ?? user?.metros,
    );
    const stalledSeconds = Number(realmUser?.segundosVarado ?? user?.segundosVarado);
    const routeStart = routeConfig?.fechaInicioRuta instanceof Date
      ? routeConfig.fechaInicioRuta.getTime()
      : Date.now();

    if (!idUsuario || !sucursal) {
      this.stallContext = null;
      return;
    }

    this.stallContext = {
      routeKey: `${idUsuario}-${sucursal}-${routeStart}`,
      idUsuario,
      nombreUsuario: realmUser?.nombre ?? user?.nombre,
      sucursal,
      metrosTolerancia: Number.isFinite(tolerance) && tolerance > 0
        ? tolerance
        : DEFAULT_TOLERANCE_METERS,
      segundosVarado: Number.isFinite(stalledSeconds) && stalledSeconds > 0
        ? stalledSeconds
        : DEFAULT_STALLED_SECONDS,
    };
    console.log(TAG, "Contexto de alerta de varado actualizado", {
      routeKey: this.stallContext.routeKey,
      metrosTolerancia: this.stallContext.metrosTolerancia,
      segundosVarado: this.stallContext.segundosVarado,
    });
  }

  async refreshStallContext(): Promise<void> {
    if (!this.isTaskRunning) return;
    await this.loadStallContext();
  }

  private async evaluateStallAlert(
    latitude: number,
    longitude: number,
    timestamp?: number,
  ): Promise<StallEvaluationResult | null> {
    const context = this.stallContext;
    if (!context) return null;

    return StallAlertService.evaluate({
      ...context,
      latitud: latitude,
      longitud: longitude,
      timestamp,
    });
  }

  private async publishStallNotification(
    result: StallEvaluationResult,
    latitude: number,
    longitude: number,
  ): Promise<void> {
    if (result.enteredStall) {
      const minutos = Math.max(1, Math.round(result.stalledMs / 60000));
      const nombre = this.stallContext?.nombreUsuario?.trim() || `Usuario ${this.stallContext?.idUsuario ?? ""}`;
      await showStallNotification(nombre, minutos, latitude, longitude).catch((error) =>
        console.warn(TAG, "No se pudo publicar la alerta nativa de varado:", error),
      );
    }

    if (result.recovered) {
      this.stallNotificationToggle = false;
      await cancelStallNotification().catch((error) =>
        console.warn(TAG, "No se pudo cancelar la alerta nativa de varado:", error),
      );
    }

    if (result.isStalled) {
      this.stallNotificationToggle = !this.stallNotificationToggle;
    }
  }

  private getNativeIntervalMs(): number {
    return this.gpsEnganchado
      ? Math.min(this.intervalMs, this.INTERVALO_ENGANCHADO_MS)
      : Math.min(this.intervalMs, this.INTERVALO_ADQUISICION_MS);
  }

  private async startWatch(generation: number): Promise<void> {
    if (generation !== this.generation) return;
    this.stopWatch();
    this.intervaloNativo = this.getNativeIntervalMs();

    const opcionesWatch = {
      enableHighAccuracy: true,
      interval: this.intervaloNativo,
      fastestInterval: this.intervaloNativo,
      distanceFilter: 0,
      forceRequestLocation: true,
      showLocationDialog: false,
    };

    try {
      this.watchId = Geolocation.watchPosition(
        (position: GeoPosition) => this.onLocationFix(position, generation),
        (error: GeoError) => this.onLocationError(error, generation),
        opcionesWatch as any,
      );
      // Si la validación de venta dejó su watch rápido activo, watchPosition NO
      // vuelve a llamar startObserving y el LocationRequest nativo se quedaría
      // en un intervalo rápido indefinidamente. Forzamos el intervalo de tracking.
      LocationService.forzarIntervaloNativo(opcionesWatch);
      console.log(TAG, `watchPosition suscrito (gen=${generation}, watchId=${this.watchId}, nativo=${this.intervaloNativo}ms, escritura=${this.intervalMs}ms)`);
    } catch (e) {
      console.error(TAG, "Error suscribiendo watchPosition:", e);
    }
  }

  private stopWatch(): void {
    if (this.watchId !== null) {
      try {
        Geolocation.clearWatch(this.watchId);
      } catch (e) {
        console.warn(TAG, "Error al hacer clearWatch:", e);
      }
      this.watchId = null;
    }
  }

  private async getNetworkConnected(): Promise<boolean> {
    const netInfo = await NetInfo.fetch().catch(() => null);
    return netInfo?.isConnected === true;
  }

  private async onLocationFix(position: GeoPosition, generation: number): Promise<void> {
    if (!this.isTaskRunning || generation !== this.generation) return;

    // La suscripción nativa es única y compartida: cuando una validación de
    // venta fuerza el intervalo rápido, este callback también recibe esa
    // ráfaga. Se ignoran los fixes anteriores a la ventana de tracking para no
    // escribir en Realm varias veces por segundo.
    if (position.mocked === true) {
      console.warn(TAG, "Se descartó un fix GPS simulado");
      return;
    }

    const ahora = Date.now();
    this.lastFixAt = ahora;

    const tsFix = position.timestamp ?? ahora;
    const candidatoTracking = {
      latitud: position.coords.latitude,
      longitud: position.coords.longitude,
      accuracy: position.coords.accuracy ?? 999,
      timestamp: tsFix,
      receivedAt: ahora,
    };

    // Proteger ultimoFixTracking contra saltos físicamente imposibles (> 150 km/h)
    // para evitar que un fix espurio durante una ráfaga anule el contraste de velocidad.
    let actualizarUltimoTracking = true;
    if (this.ultimoFixTracking && ahora - (this.ultimoFixTracking.receivedAt ?? this.ultimoFixTracking.timestamp) <= 60000) {
      const dt = Math.max((tsFix - this.ultimoFixTracking.timestamp) / 1000, 1);
      const dist = distanciaMetros(
        this.ultimoFixTracking.latitud,
        this.ultimoFixTracking.longitud,
        position.coords.latitude,
        position.coords.longitude,
      );
      const vel = dist / dt;
      if (vel > VELOCIDAD_MAX_PLAUSIBLE_MPS) {
        const descartado = this.saltoDescartadoUltimoTracking;
        const dtReancla = descartado ? Math.max((tsFix - descartado.timestamp) / 1000, 1) : 0;
        const velReancla = descartado
          ? distanciaMetros(descartado.latitud, descartado.longitud, position.coords.latitude, position.coords.longitude) / dtReancla
          : Infinity;

        if (descartado && tsFix - descartado.timestamp <= REANCLAJE_VENTANA_MS && velReancla <= VELOCIDAD_MAX_PLAUSIBLE_MPS) {
          this.saltoDescartadoUltimoTracking = null;
          actualizarUltimoTracking = true;
        } else {
          this.saltoDescartadoUltimoTracking = candidatoTracking;
          actualizarUltimoTracking = false;
        }
      } else {
        this.saltoDescartadoUltimoTracking = null;
      }
    } else {
      this.saltoDescartadoUltimoTracking = null;
    }

    if (actualizarUltimoTracking) {
      this.ultimoFixTracking = candidatoTracking;
    }

    this.registrarFixReciente(position);

    this.evaluateGpsState(position.coords.accuracy ?? 999);

    if (this.captureInFlight) return;

    // Upgrade de ventana: si la captura ya persistida en esta ventana tenía
    // accuracy por encima del umbral de evidencia (no sirve para ok_tracking)
    // y este fix sí califica, se escribe/actualiza el registro de la ventana
    // en lugar de quedar descartado por el throttle (caso 400517: fixes de
    // 6.9/17.6 m perdidos tras capturas de 36/52.8 m). No aplica cuando el
    // fix fue descartado como salto imposible (actualizarUltimoTracking ===
    // false): un espurio no puede mejorar la ventana.
    const accFix = position.coords.accuracy ?? 999;
    const esMejoraDeVentana =
      this.lastCaptureAccuracy > FIX_BUENO_ACCURACY_MAX &&
      accFix <= FIX_BUENO_ACCURACY_MAX &&
      actualizarUltimoTracking;
    if (
      this.lastCaptureAt > 0 &&
      ahora - this.lastCaptureAt < this.intervalMs * 0.8 &&
      !esMejoraDeVentana
    ) {
      return;
    }

    this.captureInFlight = true;
    const { latitude, longitude, accuracy } = position.coords;
    console.log(TAG, `Fix GPS recibido (gen=${generation}): lat=${latitude.toFixed(6)}, lng=${longitude.toFixed(6)}, accuracy=${accuracy}, enganchado=${this.gpsEnganchado}${esMejoraDeVentana ? " (mejora de ventana)" : ""}`);

    try {
      const conCobertura = await this.getNetworkConnected();
      if (!this.isTaskRunning || generation !== this.generation) return;

      const persisted = await GpsBitacoraService.registrarCapturaTracking(
        latitude,
        longitude,
        accuracy,
        conCobertura,
        this.intervalMs,
        position.timestamp,
      );
      if (!persisted) {
        console.warn(TAG, "El fix GPS no pudo persistirse");
        return;
      }

      this.registrarFixPersistido(position);
      this.lastCaptureAt = ahora;
      this.lastCaptureAccuracy = accuracy ?? 999;
      let stallResult: StallEvaluationResult | null = null;
      if (this.isTaskRunning && generation === this.generation) {
        void this.uploadTrackingPendientes(generation, "gps-fix");
        try {
          stallResult = await this.evaluateStallAlert(latitude, longitude, position.timestamp);
          if (stallResult) {
            await this.publishStallNotification(stallResult, latitude, longitude);
          }
        } catch (error) {
          console.warn(TAG, "No se pudo evaluar alerta de varado:", error);
        }
      }

      const hora = new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const acc = Math.round(accuracy ?? 0);
      const estadoGps = this.gpsEnganchado
        ? `GPS: enganchado ±${acc}m`
        : `GPS: buscando satélites (±${acc}m)`;
      if (stallResult?.isStalled) {
        const minutos = Math.max(1, Math.round(stallResult.stalledMs / 60000));
        const descripcion = `${this.stallNotificationToggle ? "Alerta" : "GPS"}: ${
          this.stallNotificationToggle
            ? `lleva aproximadamente ${minutos} min sin movimiento`
            : `${estadoGps} — ${hora}`
        }`;
        await this.updateNotificationText(
          descripcion,
          this.stallNotificationToggle ? "Alerta de recorrido" : "Xallapan",
          this.stallNotificationToggle ? "#C62828" : "#007AFF",
        );
      } else {
        await this.updateNotificationText(`${estadoGps} — ${hora}`);
      }
      console.log(TAG, `Tracking registrado: cobertura=${conCobertura}`);
    } catch (error) {
      console.error(TAG, "Error procesando fix GPS:", error);
    } finally {
      this.captureInFlight = false;
    }
  }

  private onLocationError(error: GeoError, generation: number): void {
    if (generation !== this.generation) return;
    console.warn(TAG, `Error en watchPosition (gen=${generation}):`, error.code, error.message);
  }

  /**
   * Conmuta entre modo adquisición y el intervalo configurado usando histéresis:
   * - Subir a intervalo configurado: 2 fixes consecutivos con accuracy <= 30 m.
   * - Bajar a adquisición: 3 fixes consecutivos con accuracy > 30 m.
   */
  private evaluateGpsState(accuracy: number): void {
    const acc = accuracy ?? 999;
    const good = acc <= this.UMBRAL_ENGANCHE_ACCURACY;

    if (good) {
      this.consecutiveBadFixes = 0;
      this.consecutiveGoodFixes++;
      if (!this.gpsEnganchado && this.consecutiveGoodFixes >= this.FIXES_PARA_ENGANCHE) {
        this.gpsEnganchado = true;
        const objetivo = this.getNativeIntervalMs();
        if (this.intervaloNativo !== objetivo) {
          this.intervaloNativo = objetivo;
          console.log(TAG, `GNSS enganchado (${acc}m), intervalo nativo ${this.intervaloNativo}ms (escritura cada ${this.intervalMs}ms)`);
          void this.startWatch(this.generation);
        }
      }
    } else {
      this.consecutiveGoodFixes = 0;
      this.consecutiveBadFixes++;
      if (this.gpsEnganchado && this.consecutiveBadFixes >= this.FIXES_PARA_PERDER_ENGANCHE) {
        this.gpsEnganchado = false;
        const objetivo = this.getNativeIntervalMs();
        if (this.intervaloNativo !== objetivo) {
          this.intervaloNativo = objetivo;
          console.log(TAG, `GNSS perdido (${acc}m), subiendo a intervalo ${this.intervaloNativo}ms`);
          void this.startWatch(this.generation);
        }
      }
    }
  }

  private async uploadTrackingPendientes(
    generation: number,
    source: "gps-fix" | "foreground-start" | "watchdog" | "manual" = "manual",
    force = false,
  ): Promise<void> {
    const now = Date.now();

    if (!this.isTaskRunning || generation !== this.generation) {
      console.warn(TAG, "[TrackingUpload] Ciclo omitido: ruta detenida o generación inválida", { source });
      return;
    }

    if (
      !force &&
      this.lastTrackingUploadAttemptAt > 0 &&
      now - this.lastTrackingUploadAttemptAt < TRACKING_UPLOAD_INTERVAL_MS
    ) {
      return;
    }

    if (this.trackingUploadInFlight) {
      console.log(TAG, "[TrackingUpload] Ya hay un envío en curso; se omite este disparo", { source });
      return;
    }

    this.lastTrackingUploadAttemptAt = now;
    const uploadPromise = this.performTrackingUpload(generation, source, force);
    this.trackingUploadInFlight = uploadPromise;

    try {
      await uploadPromise;
    } finally {
      if (this.trackingUploadInFlight === uploadPromise) {
        this.trackingUploadInFlight = null;
      }
    }
  }

  private async performTrackingUpload(
    generation: number,
    source: "gps-fix" | "foreground-start" | "watchdog" | "manual",
    force = false,
  ): Promise<void> {
    console.log(TAG, "[TrackingUpload] Ciclo iniciado", {
      source,
      generation,
      currentGeneration: this.generation,
      isTaskRunning: this.isTaskRunning,
    });

    if (!this.isTaskRunning || generation !== this.generation) {
      console.warn(TAG, "[TrackingUpload] Ciclo omitido: ruta detenida o generación inválida", { source });
      return;
    }

    try {
      const netInfo = await NetInfo.fetch().catch(() => null);
      const conRed =
        netInfo?.isConnected === true && netInfo.isInternetReachable !== false;
      console.log(TAG, "[TrackingUpload] Estado de red", {
        source,
        isConnected: netInfo?.isConnected ?? null,
        isInternetReachable: netInfo?.isInternetReachable ?? null,
        conRed,
      });
      if (!conRed) {
        console.warn(TAG, "[TrackingUpload] Sin red utilizable; los puntos permanecen pendientes", { source });
        return;
      }

      const user = await AuthService.restoreSession();
      if (!user) {
        console.warn(TAG, "[TrackingUpload] Sin sesión; se omite el envío", { source });
        return;
      }
      if (!this.isTaskRunning || generation !== this.generation) {
        console.warn(TAG, "[TrackingUpload] La ruta se detuvo antes de iniciar el envío", { source });
        return;
      }

      const sucursal = Number(user.sucursal_origen || user.sucursal || 1);
      const idUsuario = Number(user.id ?? user.idUsuario ?? 0);
      if (!idUsuario) {
        console.warn(TAG, "[TrackingUpload] Usuario inválido; se omite el envío", { source, idUsuario });
        return;
      }

      const startedAt = Date.now();
      console.log(TAG, "[TrackingUpload] Consultando y enviando pendientes", {
        source,
        sucursal,
        idUsuario,
      });
      if (force) {
        await GpsBitacoraService.enviarTrackingPendientes(sucursal, idUsuario, true);
      } else {
        await GpsBitacoraService.enviarTrackingPendientes(sucursal, idUsuario);
      }
      console.log(TAG, "[TrackingUpload] Ciclo terminado", {
        source,
        sucursal,
        idUsuario,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      console.warn(TAG, "[TrackingUpload] Error subiendo tracking GPS pendiente:", { source, error });
    }
  }

  private async logBackgroundHealth(source: "foreground-start" | "watchdog"): Promise<void> {
    let wakeLockHeld: boolean | null = null;
    try {
      const wakeLockModule = (NativeModules as any)?.WakeLockModule;
      if (wakeLockModule && typeof wakeLockModule.isHeld === "function") {
        wakeLockHeld = await wakeLockModule.isHeld();
      }
    } catch (error) {
      console.warn(TAG, "No se pudo consultar el estado del WakeLock:", error);
    }

    const sinceLastFixMs = this.lastFixAt > 0 ? Date.now() - this.lastFixAt : null;
    const foregroundRunning = BackgroundActions.isRunning();
    console.log(TAG, "[Health] Estado del tracking", {
      source,
      isTaskRunning: this.isTaskRunning,
      foregroundRunning,
      sinceLastFixMs,
      wakeLockHeld,
    });

    if (!foregroundRunning && this.isTaskRunning) {
      console.warn(TAG, "[Health] El servicio JS sigue activo, pero BackgroundActions no reporta FGS activo");
    }
  }

  /**
   * Bucle del foreground service. Ya NO usa setTimeout como reloj de captura;
   * el reloj real es FusedLocationProviderClient vía watchPosition.
   * Cada ~2 minutos verifica que haya llegado un fix reciente y, si no,
   * re-suscribe; también intenta subir el tracking GPS pendiente.
   */
  private async backgroundTask(): Promise<void> {
    if (this.backgroundTaskInFlight) return this.backgroundTaskInFlight;

    const task = this.runBackgroundTask();
    this.backgroundTaskInFlight = task;
    try {
      await task;
    } finally {
      if (this.backgroundTaskInFlight === task) this.backgroundTaskInFlight = null;
    }
  }

  private async runBackgroundTask(): Promise<void> {
    const gen = this.generation;
    try {
      await this.ensureReady();
      if (!this.isTaskRunning || this.generation !== gen) return;
      await this.loadStallContext();
      this.stallNotificationToggle = false;
      await cancelStallNotification().catch(() => undefined);

      console.log(TAG, `Tarea FGS iniciada (gen=${gen}), intervalo=${this.intervalMs}ms`);

      // Arrancar en modo adquisición para calentar el GNSS desde frío
      this.gpsEnganchado = false;
      this.intervaloNativo = this.getNativeIntervalMs();
      this.captureInFlight = false;
      this.lastCaptureAt = 0;
      this.lastCaptureAccuracy = 999;
      this.consecutiveGoodFixes = 0;
      this.consecutiveBadFixes = 0;

      await this.startWatch(gen);
      if (!this.isTaskRunning || this.generation !== gen) return;
      this.lastFixAt = Date.now();
      console.log(TAG, "[TrackingUpload] Disparo inicial del foreground service", { gen });
      await this.logBackgroundHealth("foreground-start");
      void this.uploadTrackingPendientes(gen, "foreground-start", true);

      while (this.isTaskRunning && this.generation === gen) {
        await sleep(WATCHDOG_INTERVAL_MS);
        if (!this.isTaskRunning || this.generation !== gen) break;

        const sinceLastFix = Date.now() - this.lastFixAt;
        await this.logBackgroundHealth("watchdog");
        const maxFixAgeMs = Math.max(MAX_FIX_AGE_MS, this.intervalMs * 3);
        if (sinceLastFix > maxFixAgeMs) {
          console.warn(TAG, `Sin fixes durante ${Math.round(sinceLastFix / 1000)}s, re-suscribiendo watchPosition...`);
          await this.startWatch(gen);
          this.updateNotificationText(`GPS sin lecturas ${Math.round(sinceLastFix / 1000)}s - reconectando...`);
        }

        console.log(TAG, "[TrackingUpload] Disparo periódico del watchdog", {
          gen,
          sinceLastFixMs: sinceLastFix,
        });
        void this.uploadTrackingPendientes(gen, "watchdog");
      }
    } catch (error) {
      if (this.generation === gen) {
        this.isTaskRunning = false;
        LocationService.setWatchRestoreHandler(null);
        this.stopWatch();
        await this.releaseWakeLock();
        console.error(TAG, "Error en la tarea foreground de ubicación:", error);
      }
    } finally {
      if (this.generation === gen) this.stopWatch();
      console.log(TAG, `Tarea FGS finalizada (gen=${gen})`);
    }
  }

  /**
   * Actualiza el texto de la notificación del foreground service.
   */
  private async updateNotificationText(
    desc: string,
    title = "Xallapan",
    color = "#007AFF",
  ): Promise<void> {
    try {
      if (BackgroundActions.isRunning()) {
        await BackgroundActions.updateNotification({
          taskTitle: title,
          taskDesc: desc,
          taskIcon: { name: "ic_launcher", type: "mipmap" },
          color,
        });
      }
    } catch (e) {
      // updateNotification puede fallar si el servicio se detuvo; es no crítico
    }
  }

  /**
   * Cambia el intervalo de captura GPS (ms).
   * Si el servicio está corriendo, reinicia el watch para aplicar el nuevo intervalo.
   */
  async setInterval(ms: number): Promise<State> {
    const value = Number(ms);
    const nextIntervalMs = Number.isFinite(value)
      ? Math.max(5000, Math.min(300000, value))
      : 30000;
    const changed = this.intervalMs !== nextIntervalMs;
    this.intervalMs = nextIntervalMs;
    this.intervaloNativo = this.getNativeIntervalMs();
    console.log(TAG, "Intervalo actualizado a", this.intervalMs, "ms");
    if (changed && this.isTaskRunning) {
      await this.startWatch(this.generation);
    }
    return this.getState();
  }

  /**
   * Inicia el seguimiento de la ruta con foreground service.
   */
  async start(): Promise<State> {
    if (this.startPromise) {
      console.log(TAG, "start() ya en progreso, esperando promesa existente...");
      return this.startPromise;
    }

    this.startPromise = this.doStart();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async doStart(): Promise<State> {
    // Guardas ANTES de cualquier await para evitar que un segundo start()
    // concurrente vea el servicio como detenido.
    if (BackgroundActions.isRunning()) {
      this.isTaskRunning = true;
      console.log(TAG, "El servicio ya está corriendo");
      return this.getState();
    }

    if (this.isTaskRunning) {
      this.isTaskRunning = false;
      this.generation++;
      this.stopWatch();
    }

    this.isTaskRunning = true;
    this.lastTrackingUploadAttemptAt = 0;
    const currentGen = ++this.generation;

    try {
      await this.ensureReady();

      const bgPermission = await LocationService.requestBackgroundLocationPermission();
      console.log(TAG, "Permiso background location:", bgPermission);
      if (bgPermission !== "granted") {
        console.warn(TAG, "Permiso de ubicación en segundo plano no concedido:", bgPermission);
        this.isTaskRunning = false;
        return { enabled: false };
      }

      const notificationPermission = await LocationService.requestNotificationPermission();
      console.log(TAG, "Permiso notificaciones:", notificationPermission);
      if (notificationPermission !== "granted") {
        const sdkVersion = typeof Platform.Version === "string" ? parseInt(Platform.Version, 10) : (Platform.Version || 0);
        if (sdkVersion >= 33 && !this.notificationAlertShown) {
          this.notificationAlertShown = true;
          console.warn(TAG, "Permiso de notificaciones no concedido en Android 13+. La notificación del servicio en segundo plano no se mostrará.");
          Alert.alert(
            "Permiso de notificaciones requerido",
            "Para mostrar el estado del rastreo GPS en la barra de notificaciones, debes conceder el permiso de notificaciones.\n\nSin este permiso, Android puede cerrar el rastreo en segundo plano.",
            [
              { text: "Entendido" },
              {
                text: "Abrir Configuración",
                onPress: () => LocationService.openSettings(),
              },
            ],
          );
        }
      }

      if (!BackgroundActions || typeof BackgroundActions.start !== "function") {
        throw new Error("El módulo de rastreo en segundo plano no está disponible. La app necesita ser reconstruida (pnpm run android).");
      }

      if (!this.isTaskRunning) {
        throw new Error("El servicio fue detenido durante el inicio; abortando arranque.");
      }

      // Permite a getBestLocation() (validaciones de venta) forzar el intervalo
      // rápido de la suscripción nativa compartida y devolvérnosla al terminar.
      LocationService.setWatchRestoreHandler(() => {
        if (!this.isTaskRunning) return;
        void this.startWatch(this.generation);
      });

      await BackgroundActions.start(this.backgroundTask.bind(this), {
        taskName: "XallapanRuta",
        taskTitle: "Xallapan",
        taskDesc: "Registrando tu recorrido en segundo plano",
        taskIcon: { name: "ic_launcher", type: "mipmap" },
        color: "#007AFF",
        foregroundServiceType: ["location"] as const,
      });
      console.log(TAG, `Servicio iniciado (gen=${currentGen})`);

      // Adquirir WakeLock parcial para evitar que Doze difiera las entregas de GPS
      await this.acquireWakeLock();

      await this.requestIgnoreBatteryOptimizations();
    } catch (error) {
      this.isTaskRunning = false;
      LocationService.setWatchRestoreHandler(null);
      this.stopWatch();
      await this.releaseWakeLock();
      console.error(TAG, "Error iniciando BackgroundActions:", error);
      Alert.alert(
        "Error del servicio GPS",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }

    return this.getState();
  }

  /**
   * Solicita al usuario que excluya la app de la optimización de batería.
   * En Android 6+ abre la lista de optimización de batería; en fabricantes
   * agresivos (Xiaomi, Huawei, Samsung) también puede requerir ajuste manual.
   */
  private async requestIgnoreBatteryOptimizations(): Promise<void> {
    if (Platform.OS !== "android") return;

    const sdkVersion = typeof Platform.Version === "string" ? parseInt(Platform.Version, 10) : (Platform.Version || 0);
    if (sdkVersion < 23) return;

    try {
      const { BatteryOptimizationModule } = NativeModules as any;
      const alreadyExempted = await BatteryOptimizationModule.isIgnoringBatteryOptimizations();
      if (alreadyExempted) {
        console.log(TAG, "App ya está exenta de optimización de batería");
        return;
      }
    } catch (e) {
      console.warn(TAG, "No se pudo verificar estado de optimización de batería:", e);
    }

    if (this.batteryOptimizationAlertShown) return;
    this.batteryOptimizationAlertShown = true;

    Alert.alert(
      "Optimización de batería",
      "Para mantener el GPS activo durante recorridos largos, puedes excluir Xallapan de la optimización de batería. El tracking ya está activo.",
      [
        { text: "Ahora no", style: "cancel" },
        {
          text: "Abrir configuración",
          onPress: async () => {
            try {
              await Linking.sendIntent("android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS", []);
              console.log(TAG, "Solicitada exclusión de optimización de batería (settings)");
            } catch (e) {
              console.warn(TAG, "No se pudo abrir IGNORE_BATTERY_OPTIMIZATION_SETTINGS, abriendo app settings:", e);
              void LocationService.openSettings();
            }
          },
        },
      ],
    );
  }

  /**
   * Adquiere un WakeLock parcial para evitar que el dispositivo entre en
   * Doze profundo mientras se está haciendo tracking GPS.
   *
   * El lock nativo se sostiene SIN timeout mientras la ruta esté abierta y se
   * libera en releaseWakeLock() (stop de la ruta) o cuando muere el proceso.
   *
   * A propósito NO se renueva desde JS: un setInterval no corre cuando el
   * sistema duerme el proceso, que es exactamente el escenario a cubrir. Antes
   * se hacía así (lock de 30 min + renovación a los 25) y en campo se veía como
   * ráfagas con retraso de subida de 15+ minutos.
   */
  private async acquireWakeLock(): Promise<void> {
    if (Platform.OS !== "android") return;
    try {
      const { WakeLockModule } = NativeModules as any;
      await WakeLockModule.acquire();
      console.log(TAG, "WakeLock parcial adquirido (indefinido hasta el stop de la ruta)");
    } catch (e) {
      console.warn(TAG, "No se pudo adquirir WakeLock:", e);
    }
  }

  /**
   * Libera el WakeLock cuando el tracking GPS se detiene.
   */
  private async releaseWakeLock(): Promise<void> {
    if (Platform.OS !== "android") return;
    try {
      const { WakeLockModule } = NativeModules as any;
      await WakeLockModule.release();
      console.log(TAG, "WakeLock liberado");
    } catch (e) {
      console.warn(TAG, "No se pudo liberar WakeLock:", e);
    }
  }

  async waitForTrackingUpload(): Promise<void> {
    const upload = this.trackingUploadInFlight;
    if (!upload) return;
    try {
      await upload;
    } catch (error) {
      console.warn(TAG, "El envío de tracking terminó con error:", error);
    }
  }

  /**
   * Detiene el seguimiento de la ruta.
   */
  async stop(): Promise<State> {
    this.isTaskRunning = false;
    this.stallContext = null;
    this.stallNotificationToggle = false;
    StallAlertService.reset();
    await cancelStallNotification().catch((error) =>
      console.warn(TAG, "No se pudo cancelar la alerta nativa al detener ruta:", error),
    );
    this.generation++; // invalida callbacks/watchdogs del loop actual
    LocationService.setWatchRestoreHandler(null);
    this.stopWatch();
    try {
      await BackgroundActions.stop();
      console.log(TAG, "Servicio detenido");
    } catch (error) {
      console.error(TAG, "Error deteniendo BackgroundActions:", error);
    }
    await this.waitForTrackingUpload();
    // Liberar WakeLock
    await this.releaseWakeLock();
    return this.getState();
  }

  /**
   * Estado actual del servicio.
   */
  async getState(): Promise<State> {
    return { enabled: BackgroundActions.isRunning() };
  }
}

export default BackgroundLocationService.getInstance();
