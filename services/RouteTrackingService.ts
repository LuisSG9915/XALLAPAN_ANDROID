import Realm from "realm";
import NetInfo from "@react-native-community/netinfo";
import LocationService, { calcularDistancia, LocationCoordinates } from "./LocationService";
import GpsBitacoraService from "./GpsBitacoraService";
import AuthService from "./AuthService";

const ROUTE_CONFIG_ID = "routeConfig";
const DEFAULT_INTERVAL_SECONDS = 30;
const MIN_INTERVAL_SECONDS = 15;
const MAX_INTERVAL_SECONDS = 300;
const DEFAULT_TOLERANCE_METERS = 100;

export type RouteStatus = "idle" | "active" | "finishing";

export type RoutePoint = {
  id: string;
  latitud: number;
  longitud: number;
  precision?: number;
  conCobertura?: boolean;
  fecha: Date;
};

export type RouteSummary = {
  distanciaMetros: number;
  distanciaKm: number;
  puntos: number;
  fechaInicio?: Date;
  fechaFin?: Date;
};

class RouteTrackingService {
  private static instance: RouteTrackingService;
  private realm: Realm | null = null;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private status: RouteStatus = "idle";
  private listeners: Set<(status: RouteStatus) => void> = new Set();

  private constructor() {}

  static getInstance(): RouteTrackingService {
    if (!RouteTrackingService.instance) {
      RouteTrackingService.instance = new RouteTrackingService();
    }
    return RouteTrackingService.instance;
  }

  setRealm(realm: Realm): void {
    this.realm = realm;
    console.log("[RouteTrackingService] Realm inyectado correctamente");
  }

  private getRealm(): Realm {
    if (!this.realm || this.realm.isClosed) {
      throw new Error("[RouteTrackingService] Realm no inicializado");
    }
    return this.realm;
  }

  private ensureConfig(): any {
    const realm = this.getRealm();
    let config = realm.objectForPrimaryKey("RouteConfig", ROUTE_CONFIG_ID) as any;
    if (!config) {
      realm.write(() => {
        config = realm.create("RouteConfig", {
          id: ROUTE_CONFIG_ID,
          intervaloGPS: DEFAULT_INTERVAL_SECONDS,
          radioTolerancia: DEFAULT_TOLERANCE_METERS,
          rutaActiva: false,
          updatedAt: new Date(),
        });
      });
    }
    return config;
  }

  async getConfig(): Promise<{ intervaloGPS: number; radioTolerancia: number; rutaActiva: boolean }> {
    const config = this.ensureConfig();
    return {
      intervaloGPS: Math.max(MIN_INTERVAL_SECONDS, Math.min(MAX_INTERVAL_SECONDS, config.intervaloGPS || DEFAULT_INTERVAL_SECONDS)),
      radioTolerancia: config.radioTolerancia || DEFAULT_TOLERANCE_METERS,
      rutaActiva: config.rutaActiva || false,
    };
  }

  async setIntervaloGPS(seconds: number): Promise<void> {
    const clamped = Math.max(MIN_INTERVAL_SECONDS, Math.min(MAX_INTERVAL_SECONDS, seconds));
    const realm = this.getRealm();
    const config = this.ensureConfig();
    realm.write(() => {
      config.intervaloGPS = clamped;
      config.updatedAt = new Date();
    });
    console.log(`[RouteTrackingService] Intervalo GPS actualizado: ${clamped}s`);
  }

  async setRadioTolerancia(meters: number): Promise<void> {
    const realm = this.getRealm();
    const config = this.ensureConfig();
    realm.write(() => {
      config.radioTolerancia = meters;
      config.updatedAt = new Date();
    });
  }

  async isRouteActive(): Promise<boolean> {
    const config = this.ensureConfig();
    return config.rutaActiva === true;
  }

  getStatus(): RouteStatus {
    return this.status;
  }

  subscribe(listener: (status: RouteStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  private setStatus(status: RouteStatus): void {
    this.status = status;
    this.listeners.forEach((l) => {
      try {
        l(status);
      } catch (e) {
        console.warn("[RouteTrackingService] Error en listener:", e);
      }
    });
  }

  /**
   * Inicia el registro de recorrido (Inicio de Ruta).
   * Activa captura GPS periódica y almacena puntos localmente.
   */
  async iniciarRuta(): Promise<boolean> {
    const existingConfig = this.ensureConfig();
    if (this.status === "active" || existingConfig.rutaActiva) {
      console.log("[RouteTrackingService] La ruta ya está activa");
      if (this.status !== "active") {
        this.setStatus("active");
        this.scheduleCaptures();
      }
      return true;
    }

    const realm = this.getRealm();
    const user = await AuthService.restoreSession();
    if (!user) {
      console.warn("[RouteTrackingService] No hay usuario logueado");
      return false;
    }

    const idUsuario = user.id || user.idUsuario || 0;
    const sucursal = user.sucursal || user.sucursal_origen || 0;

    const config = this.ensureConfig();
    realm.write(() => {
      config.rutaActiva = true;
      config.fechaInicioRuta = new Date();
      config.fechaFinRuta = null;
      config.idUsuario = idUsuario;
      config.sucursal = sucursal;
      config.updatedAt = new Date();
    });

    this.setStatus("active");
    const updatedConfig = this.ensureConfig();
    const intervalo = Math.max(MIN_INTERVAL_SECONDS, Math.min(MAX_INTERVAL_SECONDS, updatedConfig.intervaloGPS || DEFAULT_INTERVAL_SECONDS));
    console.log(`[RouteTrackingService] ✅ Ruta iniciada con intervalo GPS: ${intervalo}s`);

    // Capturar primer punto inmediatamente
    await this.captureRoutePoint();

    // Programar captura periódica
    this.scheduleCaptures();
    return true;
  }

  /**
   * Finaliza el registro de recorrido (Fin de Ruta).
   * Detiene captura, calcula distancia total y limpia timer.
   */
  async finalizarRuta(): Promise<RouteSummary | null> {
    if (this.status !== "active") {
      console.warn("[RouteTrackingService] No hay ruta activa para finalizar");
      return null;
    }

    this.setStatus("finishing");
    this.clearTimer();

    // Capturar último punto al finalizar
    await this.captureRoutePoint();

    const realm = this.getRealm();
    const config = this.ensureConfig();
    const now = new Date();

    realm.write(() => {
      config.rutaActiva = false;
      config.fechaFinRuta = now;
      config.updatedAt = now;
    });

    const summary = this.calcularResumenRuta(config.fechaInicioRuta, now);

    this.setStatus("idle");
    console.log("[RouteTrackingService] ✅ Ruta finalizada", summary);
    return summary;
  }

  private scheduleCaptures(): void {
    this.clearTimer();
    const config = this.ensureConfig();
    const intervalMs = (config.intervaloGPS || DEFAULT_INTERVAL_SECONDS) * 1000;

    const startTime = Date.now();
    this.timerId = setInterval(async () => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`[RouteTrackingService] ⏰ Tick de captura después de ${elapsed}s, status=${this.status}`);
      if (this.status !== "active") {
        this.clearTimer();
        return;
      }
      await this.captureRoutePoint();
    }, intervalMs);

    console.log(`[RouteTrackingService] Captura programada cada ${intervalMs}ms`);
  }

  private clearTimer(): void {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  private async captureRoutePoint(): Promise<void> {
    try {
      console.log("[RouteTrackingService] Intentando capturar punto GPS...");
      let location = await LocationService.getCurrentLocation();

      if (!location) {
        console.warn("[RouteTrackingService] getCurrentLocation falló, intentando getBestLocation...");
        location = await LocationService.getBestLocation(1, 10000);
      }

      if (!location) {
        console.warn("[RouteTrackingService] No se pudo obtener ubicación para ruta");
        return;
      }

      const netInfo = await NetInfo.fetch();
      const conCobertura = netInfo.isConnected === true;

      await GpsBitacoraService.registrarUbicacion(
        location.latitude,
        location.longitude,
        location.accuracy,
        conCobertura,
      );
      console.log(`[RouteTrackingService] ✅ Punto GPS capturado: lat=${location.latitude}, lng=${location.longitude}, cobertura=${conCobertura}`);
    } catch (error) {
      console.error("[RouteTrackingService] Error al capturar punto:", error);
    }
  }

  /**
   * Obtiene los puntos GPS capturados durante la ruta activa de hoy.
   */
  async getRoutePoints(fechaInicio?: Date, fechaFin?: Date): Promise<RoutePoint[]> {
    const realm = this.getRealm();
    const user = await AuthService.restoreSession();
    if (!user) return [];

    const idUsuario = user.id || user.idUsuario || 0;
    const inicio = fechaInicio || this.ensureConfig().fechaInicioRuta;
    if (!inicio) return [];

    const fin = fechaFin || new Date();
    const puntos = realm
      .objects("BitacoraGps")
      .filtered("idUsuario == $0 AND fecha >= $1 AND fecha <= $2", idUsuario, inicio, fin)
      .sorted("fecha");

    return Array.from(puntos).map((p: any) => ({
      id: p.id,
      latitud: p.latitud,
      longitud: p.longitud,
      precision: p.precision,
      conCobertura: p.conCobertura,
      fecha: p.fecha,
    }));
  }

  /**
   * Calcula distancia total recorrida usando Haversine sobre los puntos capturados.
   */
  calcularResumenRuta(fechaInicio?: Date, fechaFin?: Date): RouteSummary {
    const puntos = this.getRoutePointsSync(fechaInicio, fechaFin);
    let distanciaMetros = 0;
    for (let i = 1; i < puntos.length; i++) {
      const prev = puntos[i - 1];
      const curr = puntos[i];
      distanciaMetros += calcularDistancia(prev.latitud, prev.longitud, curr.latitud, curr.longitud);
    }
    return {
      distanciaMetros: Math.round(distanciaMetros),
      distanciaKm: Math.round((distanciaMetros / 1000) * 100) / 100,
      puntos: puntos.length,
      fechaInicio,
      fechaFin,
    };
  }

  private getRoutePointsSync(fechaInicio?: Date, fechaFin?: Date): any[] {
    const realm = this.getRealm();
    const config = this.ensureConfig();
    const user = AuthService.currentUser;
    const idUsuario = user?.id || user?.idUsuario || config.idUsuario || 0;
    if (!idUsuario) return [];

    const inicio = fechaInicio || config.fechaInicioRuta;
    if (!inicio) return [];
    const fin = fechaFin || new Date();

    const puntos = realm
      .objects("BitacoraGps")
      .filtered("idUsuario == $0 AND fecha >= $1 AND fecha <= $2", idUsuario, inicio, fin)
      .sorted("fecha");
    return Array.from(puntos);
  }

  /**
   * Última posición conocida del vendedor, incluyendo si fue con cobertura.
   */
  async getUltimaPosicion(): Promise<{ ubicacion: LocationCoordinates | null; conCobertura: boolean; fecha?: Date }> {
    const user = await AuthService.restoreSession();
    if (!user) return { ubicacion: null, conCobertura: false };

    const idUsuario = user.id || user.idUsuario || 0;
    const realm = this.getRealm();
    const puntos = realm
      .objects("BitacoraGps")
      .filtered("idUsuario == $0", idUsuario)
      .sorted("fecha", true);

    if (puntos.length === 0) {
      return { ubicacion: null, conCobertura: false };
    }

    const ultimo = puntos[0] as any;
    const netInfo = await NetInfo.fetch();
    return {
      ubicacion: {
        latitude: ultimo.latitud,
        longitude: ultimo.longitud,
        accuracy: ultimo.precision,
      },
      conCobertura: ultimo.conCobertura === true || netInfo.isConnected === true,
      fecha: ultimo.fecha,
    };
  }
}

export default RouteTrackingService.getInstance();
