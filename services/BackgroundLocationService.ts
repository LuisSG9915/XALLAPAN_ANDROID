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

const TAG = "[BackgroundLocationService]";

// El watchdog no es el reloj principal: solo verifica que watchPosition siga
// vivo y re-suscribe si no llega ningún fix en este tiempo.
const WATCHDOG_INTERVAL_MS = 120000; // 2 minutos
const MAX_FIX_AGE_MS = 180000; // 3 minutos sin fix -> re-suscribir

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type State = { enabled: boolean };

class BackgroundLocationService {
  private static instance: BackgroundLocationService;
  private isReady = false;
  private intervalMs = 30000;
  private intervaloNativo = 15000;
  private readonly INTERVALO_ADQUISICION_MS = 5000;
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
  private lastTrackingUploadAttemptAt = 0;
  private trackingUploadInFlight: Promise<void> | null = null;
  // Token de generación: invalida callbacks/watchdogs de loops anteriores.
  private generation = 0;
  // Evita carreras en start() (varios health-checks/disparadores simultáneos).
  private startPromise: Promise<State> | null = null;
  // Evita que el Alert de notificaciones salte en cada reintento del servicio.
  private notificationAlertShown = false;
  private batteryOptimizationAlertShown = false;
  private wakeLockRefreshTimer: ReturnType<typeof setInterval> | null = null;

  private ultimoFixTracking: {
    latitud: number;
    longitud: number;
    accuracy: number;
    timestamp: number;
  } | null = null;

  private constructor() {}

  static getInstance(): BackgroundLocationService {
    if (!BackgroundLocationService.instance) {
      BackgroundLocationService.instance = new BackgroundLocationService();
    }
    return BackgroundLocationService.instance;
  }

  getUltimoFixTracking(): { latitud: number; longitud: number; accuracy: number; timestamp: number } | null {
    return this.ultimoFixTracking;
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

  private getNativeIntervalMs(): number {
    return this.gpsEnganchado ? this.intervalMs : Math.min(this.intervalMs, this.INTERVALO_ADQUISICION_MS);
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
    this.ultimoFixTracking = {
      latitud: position.coords.latitude,
      longitud: position.coords.longitude,
      accuracy: position.coords.accuracy ?? 999,
      timestamp: position.timestamp ?? ahora,
    };

    this.evaluateGpsState(position.coords.accuracy ?? 999);

    if (this.captureInFlight) return;
    if (this.lastCaptureAt > 0 && ahora - this.lastCaptureAt < this.intervalMs * 0.8) {
      return;
    }

    this.captureInFlight = true;
    const { latitude, longitude, accuracy } = position.coords;
    console.log(TAG, `Fix GPS recibido (gen=${generation}): lat=${latitude.toFixed(6)}, lng=${longitude.toFixed(6)}, accuracy=${accuracy}, enganchado=${this.gpsEnganchado}`);

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

      this.lastCaptureAt = ahora;
      if (this.isTaskRunning && generation === this.generation) {
        void this.uploadTrackingPendientes(generation, "gps-fix");
      }

      const hora = new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const acc = Math.round(accuracy ?? 0);
      const estadoGps = this.gpsEnganchado
        ? `GPS: enganchado ±${acc}m`
        : `GPS: buscando satélites (±${acc}m)`;
      this.updateNotificationText(`${estadoGps} — ${hora}`);
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
        if (this.intervaloNativo !== this.intervalMs) {
          this.intervaloNativo = this.intervalMs;
          console.log(TAG, `GNSS enganchado (${acc}m), usando intervalo configurado ${this.intervaloNativo}ms`);
          void this.startWatch(this.generation);
        }
      }
    } else {
      this.consecutiveGoodFixes = 0;
      this.consecutiveBadFixes++;
      if (this.gpsEnganchado && this.consecutiveBadFixes >= this.FIXES_PARA_PERDER_ENGANCHE) {
        this.gpsEnganchado = false;
        const intervaloAdquisicion = Math.min(this.intervalMs, this.INTERVALO_ADQUISICION_MS);
        if (this.intervaloNativo !== intervaloAdquisicion) {
          this.intervaloNativo = intervaloAdquisicion;
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

      console.log(TAG, `Tarea FGS iniciada (gen=${gen}), intervalo=${this.intervalMs}ms`);

      // Arrancar en modo adquisición para calentar el GNSS desde frío
      this.intervaloNativo = Math.min(this.intervalMs, this.INTERVALO_ADQUISICION_MS);
      this.gpsEnganchado = false;
      this.captureInFlight = false;
      this.lastCaptureAt = 0;
      this.consecutiveGoodFixes = 0;
      this.consecutiveBadFixes = 0;

      await this.startWatch(gen);
      if (!this.isTaskRunning || this.generation !== gen) return;
      this.lastFixAt = Date.now();
      console.log(TAG, "[TrackingUpload] Disparo inicial del foreground service", { gen });
      void this.uploadTrackingPendientes(gen, "foreground-start", true);

      while (this.isTaskRunning && this.generation === gen) {
        await sleep(WATCHDOG_INTERVAL_MS);
        if (!this.isTaskRunning || this.generation !== gen) break;

        const sinceLastFix = Date.now() - this.lastFixAt;
        const maxFixAgeMs = Math.max(MAX_FIX_AGE_MS, this.intervalMs * 3);
        if (sinceLastFix > maxFixAgeMs) {
          console.warn(TAG, `Sin fixes durante ${Math.round(sinceLastFix / 1000)}s, re-suscribiendo watchPosition...`);
          await this.startWatch(gen);
          this.updateNotificationText(`Sin señal GPS ${Math.round(sinceLastFix / 1000)}s - reconectando...`);
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
  private async updateNotificationText(desc: string): Promise<void> {
    try {
      if (BackgroundActions.isRunning()) {
        await BackgroundActions.updateNotification({
          taskTitle: "Xallapan",
          taskDesc: desc,
          taskIcon: { name: "ic_launcher", type: "mipmap" },
          color: "#007AFF",
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

      await this.requestIgnoreBatteryOptimizations();

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
        linkingURI: "xallapan://",
        foregroundServiceType: ["location"] as const,
      });
      console.log(TAG, `Servicio iniciado (gen=${currentGen})`);

      // Adquirir WakeLock parcial para evitar que Doze difiera las entregas de GPS
      await this.acquireWakeLock();
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

    try {
      await Linking.sendIntent("android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS", []);
      console.log(TAG, "Solicitada exclusión de optimización de batería (settings)");
    } catch (e) {
      console.warn(TAG, "No se pudo abrir IGNORE_BATTERY_OPTIMIZATION_SETTINGS, abriendo app settings:", e);
      LocationService.openSettings();
    }
  }

  /**
   * Adquiere un WakeLock parcial para evitar que el dispositivo entre en
   * Doze profundo mientras se está haciendo tracking GPS.
   */
  private async acquireWakeLock(): Promise<void> {
    if (Platform.OS !== "android") return;
    try {
      const { WakeLockModule } = NativeModules as any;
      await WakeLockModule.acquire();
      if (!this.wakeLockRefreshTimer) {
        this.wakeLockRefreshTimer = setInterval(() => {
          if (!this.isTaskRunning) return;
          WakeLockModule.acquire().catch((error: unknown) =>
            console.warn(TAG, "No se pudo renovar WakeLock:", error),
          );
        }, 25 * 60 * 1000);
      }
      console.log(TAG, "WakeLock adquirido con renovación periódica");
    } catch (e) {
      console.warn(TAG, "No se pudo adquirir WakeLock:", e);
    }
  }

  /**
   * Libera el WakeLock cuando el tracking GPS se detiene.
   */
  private async releaseWakeLock(): Promise<void> {
    if (Platform.OS !== "android") return;
    if (this.wakeLockRefreshTimer) {
      clearInterval(this.wakeLockRefreshTimer);
      this.wakeLockRefreshTimer = null;
    }
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
