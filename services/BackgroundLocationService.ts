import BackgroundGeolocation, {
  Config,
  Event,
  Location,
  State,
  DesiredAccuracy,
  LogLevel,
  ActivityType,
} from "react-native-background-geolocation";
import NetInfo from "@react-native-community/netinfo";
import GpsBitacoraService from "./GpsBitacoraService";
import FullSyncService from "./FullSyncService";

const TAG = "[BackgroundLocationService]";

class BackgroundLocationService {
  private static instance: BackgroundLocationService;
  private isReady = false;
  private locationSubscription: any = null;
  private providerChangeSubscription: any = null;

  private constructor() {}

  static getInstance(): BackgroundLocationService {
    if (!BackgroundLocationService.instance) {
      BackgroundLocationService.instance = new BackgroundLocationService();
    }
    return BackgroundLocationService.instance;
  }

  /**
   * Configura el servicio de geolocalización en background.
   * Debe llamarse una sola vez al inicio de la app.
   */
  async configure(): Promise<State> {
    if (this.isReady) {
      console.log(TAG, "Ya configurado");
      const state = await BackgroundGeolocation.getState();
      return state;
    }

    const config: Config = {
      reset: true,
      geolocation: {
        desiredAccuracy: DesiredAccuracy.High,
        distanceFilter: 0,
        locationUpdateInterval: 30000,
        fastestLocationUpdateInterval: 30000,
        allowIdenticalLocations: true,
        disableElasticity: true,
        disableStopDetection: true,
        activityType: ActivityType.OtherNavigation,
        locationAuthorizationRequest: "Always",
      },
      app: {
        stopOnTerminate: false,
        startOnBoot: true,
        enableHeadless: true,
        notification: {
          title: "Xallapan",
          text: "Registrando tu recorrido en segundo plano",
          channelName: "Ruta GPS",
        },
      },
      logger: {
        logLevel: LogLevel.Warning,
      },
    };

    const state = await BackgroundGeolocation.ready(config);
    this.isReady = true;
    console.log(TAG, "Configuración lista:", JSON.stringify(state));
    return state;
  }

  /**
   * Inicia el seguimiento de la ruta.
   */
  async start(): Promise<State> {
    await this.configure();
    await this.addListeners();
    const state = await BackgroundGeolocation.start();
    console.log(TAG, "Servicio iniciado:", state.enabled);
    return state;
  }

  /**
   * Detiene el seguimiento de la ruta.
   */
  async stop(): Promise<State> {
    await this.removeListeners();
    const state = await BackgroundGeolocation.stop();
    console.log(TAG, "Servicio detenido:", state.enabled);
    return state;
  }

  /**
   * Cambia el intervalo de captura GPS (ms).
   */
  async setInterval(ms: number): Promise<State> {
    const clamped = Math.max(5000, Math.min(300000, ms));
    const state = await BackgroundGeolocation.setConfig({
      geolocation: {
        locationUpdateInterval: clamped,
        fastestLocationUpdateInterval: clamped,
      },
    });
    console.log(TAG, "Intervalo actualizado a", clamped, "ms", state);
    return state;
  }

  /**
   * Estado actual del servicio.
   */
  async getState(): Promise<State> {
    return BackgroundGeolocation.getState();
  }

  private async addListeners(): Promise<void> {
    if (this.locationSubscription) return;

    this.locationSubscription = BackgroundGeolocation.onLocation(
      async (location: Location) => {
        await this.handleLocation(location);
      },
      (error) => {
        console.warn(TAG, "Error de ubicación:", error);
      }
    );

    this.providerChangeSubscription = BackgroundGeolocation.onProviderChange(
      (event) => {
        console.log(TAG, "Cambio de proveedor GPS:", event);
      }
    );
  }

  private async removeListeners(): Promise<void> {
    if (this.locationSubscription) {
      this.locationSubscription.remove();
      this.locationSubscription = null;
    }
    if (this.providerChangeSubscription) {
      this.providerChangeSubscription.remove();
      this.providerChangeSubscription = null;
    }
  }

  private async handleLocation(location: Location): Promise<void> {
    try {
      const netInfo = await NetInfo.fetch();
      const conCobertura = netInfo.isConnected === true;

      await GpsBitacoraService.registrarUbicacion(
        location.coords.latitude,
        location.coords.longitude,
        location.coords.accuracy,
        conCobertura
      );

      console.log(
        TAG,
        `Punto GPS guardado: lat=${location.coords.latitude}, lng=${location.coords.longitude}, precisión=${location.coords.accuracy}, cobertura=${conCobertura}`
      );
    } catch (error) {
      console.error(TAG, "Error guardando punto GPS:", error);
    }
  }
}

/**
 * Tarea Headless para cuando la app es terminada (swipe) y el servicio nativo
 * sigue enviando eventos de ubicación.
 */
export async function HeadlessLocationTask(event: any): Promise<void> {
  console.log("[HeadlessLocationTask] Evento:", event.name);

  if (event.name === Event.Location || event.name === "location") {
    try {
      // Inicializar Realm si no está listo
      await FullSyncService.initialize();

      const netInfo = await NetInfo.fetch();
      const conCobertura = netInfo.isConnected === true;
      const location = (event.params && event.params.location) || event.params || event;

      if (!location || !location.coords) {
        console.warn("[HeadlessLocationTask] Evento sin coordenadas válidas", event);
        return;
      }

      await GpsBitacoraService.registrarUbicacion(
        location.coords.latitude,
        location.coords.longitude,
        location.coords.accuracy,
        conCobertura
      );
      console.log("[HeadlessLocationTask] Punto guardado:", location.coords.latitude, location.coords.longitude);
    } catch (error) {
      console.error("[HeadlessLocationTask] Error:", error);
    }
  }
}

export default BackgroundLocationService.getInstance();
