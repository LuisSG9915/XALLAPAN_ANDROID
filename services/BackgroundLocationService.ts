import { AppState, Alert, Linking, NativeModules, Platform } from "react-native";
import BackgroundActions from "react-native-background-actions";
import Geolocation, { GeoPosition, GeoError } from "react-native-geolocation-service";
import NetInfo from "@react-native-community/netinfo";
import FullSyncService from "./FullSyncService";
import GpsBitacoraService from "./GpsBitacoraService";
import LocationService from "./LocationService";
import { getCurrentScreenState } from "./ScreenState";

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
  private intervaloNativo = 5000;
  private readonly INTERVALO_ADQUISICION_MS = 1000;
  private readonly INTERVALO_ENGANCHADO_MS = 5000;
  private readonly UMBRAL_ENGANCHE_ACCURACY = 30;
  private readonly FIXES_PARA_ENGANCHE = 2;
  private readonly FIXES_PARA_PERDER_ENGANCHE = 3;
  private isTaskRunning = false;
  private gpsEnganchado = false;
  private consecutiveGoodFixes = 0;
  private consecutiveBadFixes = 0;
  private watchId: number | null = null;
  private lastFixAt = 0;
  // Último fix efectivamente persistido (distinto de lastFixAt, que solo marca
  // actividad del proveedor para el watchdog).
  private lastCaptureAt = 0;
  // Token de generación: invalida callbacks/watchdogs de loops anteriores.
  private generation = 0;
  // Evita carreras en start() (varios health-checks/disparadores simultáneos).
  private startPromise: Promise<State> | null = null;
  // Evita que el Alert de notificaciones salte en cada reintento del servicio.
  private notificationAlertShown = false;
  private batteryOptimizationAlertShown = false;

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
    if (this.isReady) return;
    await FullSyncService.initialize();
    this.isReady = true;
  }

  private async startWatch(generation: number): Promise<void> {
    if (generation !== this.generation) return;
    this.stopWatch();

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
      // en 1 s indefinidamente. Forzamos el intervalo de tracking.
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

  private async onLocationFix(position: GeoPosition, generation: number): Promise<void> {
    if (!this.isTaskRunning || generation !== this.generation) return;

    // La suscripción nativa es única y compartida: cuando una validación de
    // venta fuerza el intervalo rápido (1 s), este callback también recibe esa
    // ráfaga. Se ignoran los fixes anteriores a la ventana de tracking para no
    // escribir en Realm varias veces por segundo.
    const ahora = Date.now();
    this.lastFixAt = ahora;
    this.ultimoFixTracking = {
      latitud: position.coords.latitude,
      longitud: position.coords.longitude,
      accuracy: position.coords.accuracy ?? 999,
      timestamp: position.timestamp ?? ahora,
    };
    if (this.lastCaptureAt > 0 && ahora - this.lastCaptureAt < this.intervalMs * 0.8) {
      return;
    }
    this.lastCaptureAt = ahora;
    const { latitude, longitude, accuracy } = position.coords;
    this.evaluateGpsState(accuracy ?? 999);
    console.log(TAG, `Fix GPS recibido (gen=${generation}): lat=${latitude.toFixed(6)}, lng=${longitude.toFixed(6)}, accuracy=${accuracy}, enganchado=${this.gpsEnganchado}`);

    try {
      const netInfo = await NetInfo.fetch().catch(() => null);
      const conCobertura = netInfo ? netInfo.isConnected === true : false;
      const motivo = await this.getMotivoRecorrido();

      await GpsBitacoraService.registrarCapturaTracking(
        latitude,
        longitude,
        accuracy,
        conCobertura,
        motivo,
        this.intervalMs,
      );

      const hora = new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const acc = Math.round(accuracy ?? 0);
      const estadoGps = this.gpsEnganchado
        ? `GPS: enganchado ±${acc}m`
        : `GPS: buscando satélites (±${acc}m)`;
      this.updateNotificationText(`${estadoGps} — ${hora}`);
      console.log(TAG, `Tracking registrado: cobertura=${conCobertura}, motivo=${motivo}`);
    } catch (error) {
      console.error(TAG, "Error procesando fix GPS:", error);
    }
  }

  private onLocationError(error: GeoError, generation: number): void {
    if (generation !== this.generation) return;
    console.warn(TAG, `Error en watchPosition (gen=${generation}):`, error.code, error.message);
  }

  /**
   * Conmuta entre modo adquisición (1s) y modo enganchado (5s) usando histéresis:
   * - Subir a enganchado: 2 fixes consecutivos con accuracy <= 30 m.
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
        if (this.intervaloNativo !== this.INTERVALO_ENGANCHADO_MS) {
          this.intervaloNativo = this.INTERVALO_ENGANCHADO_MS;
          console.log(TAG, `GNSS enganchado (${acc}m), bajando a intervalo ${this.intervaloNativo}ms`);
          void this.startWatch(this.generation);
        }
      }
    } else {
      this.consecutiveGoodFixes = 0;
      this.consecutiveBadFixes++;
      if (this.gpsEnganchado && this.consecutiveBadFixes >= this.FIXES_PARA_PERDER_ENGANCHE) {
        this.gpsEnganchado = false;
        if (this.intervaloNativo !== this.INTERVALO_ADQUISICION_MS) {
          this.intervaloNativo = this.INTERVALO_ADQUISICION_MS;
          console.log(TAG, `GNSS perdido (${acc}m), subiendo a intervalo ${this.intervaloNativo}ms`);
          void this.startWatch(this.generation);
        }
      }
    }
  }

  /**
   * Bucle del foreground service. Ya NO usa setTimeout como reloj de captura;
   * el reloj real es FusedLocationProviderClient vía watchPosition.
   * Este bucle solo actúa como watchdog: cada ~2 minutos verifica que haya
   * llegado al menos un fix reciente y, si no, re-suscribe.
   */
  private async backgroundTask(): Promise<void> {
    await this.ensureReady();
    const gen = this.generation;
    console.log(TAG, `Tarea FGS iniciada (gen=${gen}), intervalo=${this.intervalMs}ms`);

    // Arrancar en modo adquisición para calentar el GNSS desde frío
    this.intervaloNativo = this.INTERVALO_ADQUISICION_MS;
    this.gpsEnganchado = false;
    this.consecutiveGoodFixes = 0;
    this.consecutiveBadFixes = 0;

    await this.startWatch(gen);
    this.lastFixAt = Date.now();

    while (this.isTaskRunning && this.generation === gen) {
      await sleep(WATCHDOG_INTERVAL_MS);
      if (!this.isTaskRunning || this.generation !== gen) break;

      const sinceLastFix = Date.now() - this.lastFixAt;
      if (sinceLastFix > MAX_FIX_AGE_MS) {
        console.warn(TAG, `Sin fixes durante ${Math.round(sinceLastFix / 1000)}s, re-suscribiendo watchPosition...`);
        await this.startWatch(gen);
        this.updateNotificationText(`Sin señal GPS ${Math.round(sinceLastFix / 1000)}s - reconectando...`);
      }
    }

    this.stopWatch();
    console.log(TAG, `Tarea FGS finalizada (gen=${gen})`);
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
   * Determina el contexto de la captura combinando:
   * - estado de la pantalla (nativo): encendida / apagada.
   * - AppState (React Native): active / background / inactive.
   */
  private async getMotivoRecorrido(): Promise<string> {
    const screenState = await getCurrentScreenState();

    if (screenState === "off") {
      return "recorrido_pantalla_apagada";
    }

    // screenState === "on" (pantalla encendida)
    if (AppState.currentState === "active") {
      return "recorrido_app";
    }

    return "recorrido_pantalla_encendida_2plano";
  }

  /**
   * Cambia el intervalo de captura GPS (ms).
   * Si el servicio está corriendo, reinicia el watch para aplicar el nuevo intervalo.
   */
  async setInterval(ms: number): Promise<State> {
    this.intervalMs = Math.max(5000, Math.min(300000, ms));
    console.log(TAG, "Intervalo actualizado a", this.intervalMs, "ms");
    if (this.isTaskRunning) {
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
    if (this.isTaskRunning || BackgroundActions.isRunning()) {
      console.log(TAG, "El servicio ya está corriendo");
      return this.getState();
    }

    this.isTaskRunning = true;
    const currentGen = ++this.generation;

    try {
      await this.ensureReady();

      const bgPermission = await LocationService.requestBackgroundLocationPermission();
      console.log(TAG, "Permiso background location:", bgPermission);
      if (bgPermission !== "granted") {
        console.warn(TAG, "Permiso de ubicación en segundo plano no concedido:", bgPermission);
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
      console.log(TAG, "WakeLock adquirido");
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
