import Realm from "realm";
import NetInfo from "@react-native-community/netinfo";
import LocationService, { calcularDistancia, LocationCoordinates } from "./LocationService";
import GpsBitacoraService from "./GpsBitacoraService";
import AuthService from "./AuthService";
import BackgroundLocationService from "./BackgroundLocationService";

const ROUTE_CONFIG_ID = "routeConfig";
const DEFAULT_INTERVAL_SECONDS = 30;
const MIN_INTERVAL_SECONDS = 15;
const MAX_INTERVAL_SECONDS = 300;
const DEFAULT_TOLERANCE_METERS = 30;
const DEFAULT_STALLED_SECONDS = 30 * 60;

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
  private status: RouteStatus = "idle";
  private listeners: Set<(status: RouteStatus) => void> = new Set();
  private iniciarPromise: Promise<boolean> | null = null;
  private finalizarPromise: Promise<RouteSummary | null> | null = null;

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
          rutaActiva: false,
          updatedAt: new Date(),
        });
      });
    }
    return config;
  }

  private clampInterval(seconds: unknown): number {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_INTERVAL_SECONDS;
    return Math.max(MIN_INTERVAL_SECONDS, Math.min(MAX_INTERVAL_SECONDS, Math.round(value)));
  }

  private async getCompanySettings(): Promise<{
    intervaloGPS: number;
    metrosPermitidos: number;
    segundosVarado: number;
  }> {
    const realm = this.getRealm();
    const user = await AuthService.restoreSession();
    const idUsuario = Number(user?.id ?? user?.idUsuario ?? 0);
    const realmUser = idUsuario > 0 ? realm.objectForPrimaryKey("Usuario", idUsuario) as any : null;
    const metrosTolerancia = Number(
      realmUser?.metrosTolerancia ?? realmUser?.metros ?? user?.metrosTolerancia ?? user?.metros,
    );
    const segundosVarado = Number(realmUser?.segundosVarado ?? user?.segundosVarado);

    return {
      intervaloGPS: this.clampInterval(realmUser?.segundosRecorrido ?? user?.segundosRecorrido),
      metrosPermitidos:
        Number.isFinite(metrosTolerancia) && metrosTolerancia > 0
          ? metrosTolerancia
          : DEFAULT_TOLERANCE_METERS,
      segundosVarado:
        Number.isFinite(segundosVarado) && segundosVarado > 0
          ? segundosVarado
          : DEFAULT_STALLED_SECONDS,
    };
  }

  private async applyCompanyInterval(): Promise<number> {
    const { intervaloGPS } = await this.getCompanySettings();
    if (this.status === "active") {
      await BackgroundLocationService.setInterval(intervaloGPS * 1000);
    }
    return intervaloGPS;
  }

  async getConfig(): Promise<{
    intervaloGPS: number;
    metrosPermitidos: number;
    segundosVarado: number;
    rutaActiva: boolean;
  }> {
    const settings = await this.getCompanySettings();
    const config = this.ensureConfig();
    return {
      ...settings,
      rutaActiva: config.rutaActiva === true,
    };
  }

  async refreshCompanyConfig(): Promise<number> {
    return this.applyCompanyInterval();
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
    if (this.finalizarPromise) return false;
    if (this.iniciarPromise) return this.iniciarPromise;

    const operation = this.doIniciarRuta();
    this.iniciarPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.iniciarPromise === operation) this.iniciarPromise = null;
    }
  }

  private async doIniciarRuta(): Promise<boolean> {
    const existingConfig = this.ensureConfig();
    const { intervaloGPS } = await this.getCompanySettings();
    if (this.status === "active" || existingConfig.rutaActiva) {
      console.log("[RouteTrackingService] La ruta ya está activa");
      if (this.status === "active" && (await BackgroundLocationService.getState()).enabled) return true;

      try {
        await BackgroundLocationService.setInterval(intervaloGPS * 1000);
        const state = await BackgroundLocationService.start();
        if (!state.enabled) {
          console.warn("[RouteTrackingService] El servicio background no quedó activo");
          return false;
        }
        this.setStatus("active");
        return true;
      } catch (e) {
        console.error("[RouteTrackingService] Error iniciando background location:", e);
        return false;
      }
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

    console.log(`[RouteTrackingService] ✅ Ruta iniciada con intervalo GPS: ${intervaloGPS}s`);

    // Capturar primer punto inmediatamente y iniciar seguimiento continuo en background
    await this.captureRoutePoint();

    try {
      await BackgroundLocationService.setInterval(intervaloGPS * 1000);
      const state = await BackgroundLocationService.start();
      if (!state.enabled) {
        console.warn("[RouteTrackingService] El servicio background no quedó activo");
        this.setStatus("idle");
        return false;
      }
      this.setStatus("active");
      return true;
    } catch (e) {
      console.error("[RouteTrackingService] Error iniciando background location:", e);
      this.setStatus("idle");
      return false;
    }
  }

  /**
   * Finaliza el registro de recorrido (Fin de Ruta).
   * Detiene captura, calcula distancia total y limpia timer.
   */
  async finalizarRuta(): Promise<RouteSummary | null> {
    if (this.finalizarPromise) return this.finalizarPromise;
    if (this.iniciarPromise) {
      await this.iniciarPromise.catch(() => false);
    }

    const operation = this.doFinalizarRuta();
    this.finalizarPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.finalizarPromise === operation) this.finalizarPromise = null;
    }
  }

  private async doFinalizarRuta(): Promise<RouteSummary | null> {
    const realm = this.getRealm();
    const config = this.ensureConfig();
    if (this.status !== "active" && config.rutaActiva !== true) {
      console.warn("[RouteTrackingService] No hay ruta activa para finalizar");
      return null;
    }

    this.setStatus("finishing");

    try {
      await BackgroundLocationService.stop();
      await BackgroundLocationService.waitForTrackingUpload();
    } catch (e) {
      console.error("[RouteTrackingService] Error deteniendo background location:", e);
    }

    await this.captureRoutePoint();

    const now = new Date();
    const fechaInicio = config.fechaInicioRuta;
    const user = await AuthService.restoreSession();
    const sucursal = Number(user?.sucursal ?? user?.sucursal_origen ?? config.sucursal ?? 0);
    const idUsuario = Number(user?.id ?? user?.idUsuario ?? config.idUsuario ?? 0);

    try {
      realm.write(() => {
        config.rutaActiva = false;
        config.fechaFinRuta = now;
        config.updatedAt = now;
      });
    } catch (e) {
      this.setStatus("active");
      throw e;
    }

    if (sucursal > 0 && idUsuario > 0) {
      try {
        await GpsBitacoraService.enviarTrackingPendientes(sucursal, idUsuario, true);
      } catch (e) {
        console.warn("[RouteTrackingService] No se pudieron enviar todos los puntos al finalizar; quedarán pendientes:", e);
      }
    }

    const summary = this.calcularResumenRuta(fechaInicio, now);

    this.setStatus("idle");
    console.log("[RouteTrackingService] ✅ Ruta finalizada", summary);
    return summary;
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

      const { intervaloGPS } = await this.getCompanySettings();
      const persisted = await GpsBitacoraService.registrarCapturaTracking(
        location.latitude,
        location.longitude,
        location.accuracy,
        conCobertura,
        intervaloGPS * 1000,
        location.timestamp,
      );
      if (!persisted) {
        console.warn("[RouteTrackingService] El punto GPS no pudo persistirse");
        return;
      }
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

    const idUsuario = Number(user.id || user.idUsuario || 0);
    const config = this.ensureConfig();
    const sucursal = Number(config.sucursal ?? user.sucursal ?? user.sucursal_origen ?? 0);
    const inicio = fechaInicio || config.fechaInicioRuta;
    if (!inicio) return [];

    const fin = fechaFin || config.fechaFinRuta || new Date();
    const puntos = realm
      .objects("BitacoraTrackingGps")
      .filtered(
        sucursal > 0
          ? "idUsuario == $0 AND sucursal == $1 AND fecha >= $2 AND fecha <= $3"
          : "idUsuario == $0 AND fecha >= $1 AND fecha <= $2",
        ...(sucursal > 0 ? [idUsuario, sucursal, inicio, fin] : [idUsuario, inicio, fin]),
      )
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
    const idUsuario = Number(user?.id || user?.idUsuario || config.idUsuario || 0);
    const sucursal = Number(config.sucursal ?? user?.sucursal ?? user?.sucursal_origen ?? 0);
    if (!idUsuario) return [];

    const inicio = fechaInicio || config.fechaInicioRuta;
    if (!inicio) return [];
    const fin = fechaFin || config.fechaFinRuta || new Date();

    const puntos = realm
      .objects("BitacoraTrackingGps")
      .filtered(
        sucursal > 0
          ? "idUsuario == $0 AND sucursal == $1 AND fecha >= $2 AND fecha <= $3"
          : "idUsuario == $0 AND fecha >= $1 AND fecha <= $2",
        ...(sucursal > 0 ? [idUsuario, sucursal, inicio, fin] : [idUsuario, inicio, fin]),
      )
      .sorted("fecha");
    return Array.from(puntos);
  }

  async isTrackingHealthy(): Promise<boolean> {
    const config = this.ensureConfig();
    if (config.rutaActiva !== true) return false;

    const user = await AuthService.restoreSession();
    if (!user) return false;

    const idUsuario = Number(user.id ?? user.idUsuario ?? config.idUsuario ?? 0);
    const sucursal = Number(config.sucursal ?? user.sucursal ?? user.sucursal_origen ?? 0);
    if (idUsuario <= 0 || sucursal <= 0) return false;

    const puntos = this.getRealm()
      .objects("BitacoraTrackingGps")
      .filtered(
        config.fechaInicioRuta
          ? "idUsuario == $0 AND sucursal == $1 AND fecha >= $2"
          : "idUsuario == $0 AND sucursal == $1",
        ...(config.fechaInicioRuta ? [idUsuario, sucursal, config.fechaInicioRuta] : [idUsuario, sucursal]),
      )
      .sorted("fecha", true);
    if (puntos.length === 0) return false;

    const ultimo = puntos[0] as any;
    const fecha = ultimo?.fecha instanceof Date ? ultimo.fecha : new Date(ultimo?.fecha);
    if (Number.isNaN(fecha.getTime())) return false;

    const { intervaloGPS } = await this.getCompanySettings();
    const maxAgeMs = Math.max(180000, intervaloGPS * 3 * 1000);
    return Date.now() - fecha.getTime() <= maxAgeMs;
  }

  /**
   * Última posición conocida del vendedor, incluyendo si fue con cobertura.
   */
  async getUltimaPosicion(): Promise<{ ubicacion: LocationCoordinates | null; conCobertura: boolean; fecha?: Date }> {
    const user = await AuthService.restoreSession();
    if (!user) return { ubicacion: null, conCobertura: false };

    const idUsuario = Number(user.id || user.idUsuario || 0);
    const config = this.ensureConfig();
    const sucursal = Number(config.sucursal ?? user.sucursal ?? user.sucursal_origen ?? 0);
    const realm = this.getRealm();
    const puntos = realm
      .objects("BitacoraTrackingGps")
      .filtered(
        sucursal > 0 ? "idUsuario == $0 AND sucursal == $1" : "idUsuario == $0",
        ...(sucursal > 0 ? [idUsuario, sucursal] : [idUsuario]),
      )
      .sorted("fecha", true);

    if (puntos.length === 0) {
      return { ubicacion: null, conCobertura: false };
    }

    const ultimo = puntos[0] as any;
    return {
      ubicacion: {
        latitude: ultimo.latitud,
        longitude: ultimo.longitud,
        accuracy: ultimo.precision,
      },
      conCobertura: ultimo.conCobertura === true,
      fecha: ultimo.fecha,
    };
  }
}

export default RouteTrackingService.getInstance();
