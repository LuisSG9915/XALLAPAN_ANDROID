import { AppState } from "react-native";
import BackgroundActions from "react-native-background-actions";
import Geolocation from "react-native-geolocation-service";
import { GeoPosition } from "react-native-geolocation-service";
import NetInfo from "@react-native-community/netinfo";
import FullSyncService from "./FullSyncService";
import GpsBitacoraService from "./GpsBitacoraService";
import LocationService from "./LocationService";
import { getCurrentScreenState } from "./ScreenState";

const TAG = "[BackgroundLocationService]";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type State = { enabled: boolean };

class BackgroundLocationService {
  private static instance: BackgroundLocationService;
  private isReady = false;
  private intervalMs = 30000;
  private isTaskRunning = false;

  private constructor() {}

  static getInstance(): BackgroundLocationService {
    if (!BackgroundLocationService.instance) {
      BackgroundLocationService.instance = new BackgroundLocationService();
    }
    return BackgroundLocationService.instance;
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

  private async getLocationOnce(): Promise<{ latitude: number; longitude: number; accuracy?: number } | null> {
    return new Promise((resolve) => {
      Geolocation.getCurrentPosition(
        (position: GeoPosition) => {
          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
          });
        },
        (error) => {
          console.warn(TAG, "Error obteniendo ubicación:", error?.message || error);
          resolve(null);
        },
        {
          enableHighAccuracy: true,
          timeout: 20000,
          maximumAge: 0,
          showLocationDialog: false,
        } as any
      );
    });
  }

  /**
   * Bucle del foreground service. Corre en un contexto HeadlessJS,
   * captura la ubicación y la guarda en Realm cada intervalMs.
   */
  private async backgroundTask(): Promise<void> {
    await this.ensureReady();
    console.log(TAG, "Tarea headless GPS iniciada. isTaskRunning:", this.isTaskRunning);
    do {
      await this.captureOnce();
      if (this.isTaskRunning) {
        await sleep(this.intervalMs);
      }
    } while (this.isTaskRunning);
    console.log(TAG, "Tarea headless GPS finalizada");
  }

  private async captureOnce(): Promise<void> {
    console.log(TAG, "Iniciando captura de ubicación...");
    try {
      const location = await this.getLocationOnce();
      if (!location) {
        console.warn(TAG, "No se obtuvo ubicación en esta iteración");
        return;
      }
      console.log(TAG, `Fix obtenido: lat=${location.latitude}, lng=${location.longitude}, accuracy=${location.accuracy}`);
      const netInfo = await NetInfo.fetch();
      const conCobertura = netInfo.isConnected === true;
      await GpsBitacoraService.registrarUbicacion(
        location.latitude,
        location.longitude,
        location.accuracy,
        conCobertura
      );
      console.log(TAG, `Punto GPS guardado en Realm: lat=${location.latitude}, lng=${location.longitude}, cobertura=${conCobertura}`);

      const motivo = await this.getMotivoRecorrido();
      await GpsBitacoraService.registrarValidacion({
        idCliente: null,
        motivo,
        valido: true,
        distancia: null,
        accuracy: location.accuracy ?? null,
        metrosPermitidos: null,
        latitud: location.latitude,
        longitud: location.longitude,
        clienteLatitud: null,
        clienteLongitud: null,
        numFixes: 1,
        peorAccuracy: location.accuracy ?? null,
        tiempoMs: null,
        conCobertura,
      });
      console.log(TAG, `Recorrido registrado en BitacoraValidacion (motivo=${motivo})`);
    } catch (error) {
      console.error(TAG, "Error en iteración de captura:", error);
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
   */
  async setInterval(ms: number): Promise<State> {
    this.intervalMs = Math.max(5000, Math.min(300000, ms));
    console.log(TAG, "Intervalo actualizado a", this.intervalMs, "ms");
    return this.getState();
  }

  /**
   * Inicia el seguimiento de la ruta con foreground service.
   */
  async start(): Promise<State> {
    if (this.isTaskRunning || BackgroundActions.isRunning()) {
      console.log(TAG, "El servicio ya está corriendo");
      return this.getState();
    }

    await this.ensureReady();

    const bgPermission = await LocationService.requestBackgroundLocationPermission();
    console.log(TAG, "Permiso background location:", bgPermission);
    if (bgPermission !== "granted") {
      console.warn(TAG, "Permiso de ubicación en segundo plano no concedido:", bgPermission);
    }

    const notificationPermission = await LocationService.requestNotificationPermission();
    console.log(TAG, "Permiso notificaciones:", notificationPermission);
    if (notificationPermission !== "granted") {
      console.warn(TAG, "Permiso de notificaciones no concedido. En Android 13+ la notificación puede no mostrarse:", notificationPermission);
    }

    this.isTaskRunning = true;
    try {
      await BackgroundActions.start(this.backgroundTask.bind(this), {
        taskName: "XallapanRuta",
        taskTitle: "Xallapan",
        taskDesc: "Registrando tu recorrido en segundo plano",
        taskIcon: { name: "ic_launcher", type: "mipmap" },
        color: "#007AFF",
        linkingURI: "xallapan://",
        foregroundServiceType: ["location"] as const,
      });
      console.log(TAG, "Servicio iniciado");
    } catch (error) {
      this.isTaskRunning = false;
      console.error(TAG, "Error iniciando BackgroundActions:", error);
      throw error;
    }

    return this.getState();
  }

  /**
   * Detiene el seguimiento de la ruta.
   */
  async stop(): Promise<State> {
    this.isTaskRunning = false;
    try {
      await BackgroundActions.stop();
      console.log(TAG, "Servicio detenido");
    } catch (error) {
      console.error(TAG, "Error deteniendo BackgroundActions:", error);
    }
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
