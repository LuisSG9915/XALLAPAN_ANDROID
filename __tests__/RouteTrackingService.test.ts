jest.mock("realm", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: {
    fetch: jest.fn(),
  },
}));

jest.mock("../services/AuthService", () => ({
  __esModule: true,
  default: {
    currentUser: { id: 42, sucursal_origen: 7 },
    restoreSession: jest.fn(),
  },
}));

jest.mock("../services/LocationService", () => ({
  __esModule: true,
  default: {
    getCurrentLocation: jest.fn(),
    getBestLocation: jest.fn(),
  },
  calcularDistancia: jest.fn((lat1: number, lng1: number, lat2: number, lng2: number) =>
    Math.sqrt((lat2 - lat1) ** 2 + (lng2 - lng1) ** 2) * 100000,
  ),
}));

jest.mock("../services/GpsBitacoraService", () => ({
  __esModule: true,
  default: {
    registrarCapturaTracking: jest.fn(),
    enviarTrackingPendientes: jest.fn(),
  },
}));

jest.mock("../services/BackgroundLocationService", () => ({
  __esModule: true,
  default: {
    start: jest.fn(() => ({ enabled: true })),
    getState: jest.fn(() => ({ enabled: true })),
    stop: jest.fn(),
    waitForTrackingUpload: jest.fn(),
    setInterval: jest.fn(),
  },
}));

import NetInfo from "@react-native-community/netinfo";
import AuthService from "../services/AuthService";
import GpsBitacoraService from "../services/GpsBitacoraService";
import LocationService from "../services/LocationService";
import BackgroundLocationService from "../services/BackgroundLocationService";
import RouteTrackingService from "../services/RouteTrackingService";

const service = RouteTrackingService as any;
const restoreSession = AuthService.restoreSession as jest.Mock;
const netInfoFetch = NetInfo.fetch as jest.Mock;
const getCurrentLocation = LocationService.getCurrentLocation as jest.Mock;
const registrarCapturaTracking = GpsBitacoraService.registrarCapturaTracking as jest.Mock;
const enviarTrackingPendientes = GpsBitacoraService.enviarTrackingPendientes as jest.Mock;

const createRealm = (config: any, user: any, records: any[]) => {
  const sortedRecords = {
    length: records.length,
    map: (callback: (record: any) => any) => records.map(callback),
    [Symbol.iterator]: function* () {
      yield* records;
    },
  };

  return {
    isClosed: false,
    objectForPrimaryKey: jest.fn((name: string) => {
      if (name === "RouteConfig") return config;
      if (name === "Usuario") return user;
      return null;
    }),
    objects: jest.fn((name: string) => {
      if (name !== "BitacoraTrackingGps") throw new Error(`Colección inesperada: ${name}`);
      return {
        filtered: jest.fn(() => ({
          sorted: jest.fn(() => sortedRecords),
        })),
      };
    }),
    write: jest.fn((callback: () => void) => callback()),
  };
};

describe("RouteTrackingService", () => {
  let config: any;
  let user: any;
  let records: any[];
  let realm: any;

  beforeEach(() => {
    jest.clearAllMocks();
    service.status = "idle";
    service.iniciarPromise = null;
    service.finalizarPromise = null;
    config = {
      id: "routeConfig",
      rutaActiva: false,
      fechaInicioRuta: new Date("2026-08-27T08:00:00"),
      fechaFinRuta: null,
      idUsuario: 42,
      sucursal: 7,
    };
    user = { id: 42, sucursal_origen: 7 };
    records = [
      { id: "42-1", latitud: 19.5, longitud: -96.9, precision: 8, conCobertura: true, fecha: new Date("2026-08-27T08:00:00") },
      { id: "42-2", latitud: 19.51, longitud: -96.9, precision: 8, conCobertura: true, fecha: new Date("2026-08-27T08:00:30") },
    ];
    realm = createRealm(config, user, records);
    service.setRealm(realm);
    restoreSession.mockResolvedValue(user);
    netInfoFetch.mockResolvedValue({ isConnected: true });
    getCurrentLocation.mockResolvedValue({ latitude: 19.5, longitude: -96.9, accuracy: 8 });
    registrarCapturaTracking.mockResolvedValue(true);
    enviarTrackingPendientes.mockResolvedValue(undefined);
  });

  it("aplica el intervalo empresarial sincronizado en Realm", async () => {
    user.segundosRecorrido = 45;

    const result = await service.refreshCompanyConfig();

    expect(result).toBe(45);
    expect(config.intervaloGPS).toBeUndefined();
  });

  it("lee la polyline y calcula la distancia desde BitacoraTrackingGps", async () => {
    const points = await service.getRoutePoints();
    const summary = service.calcularResumenRuta(config.fechaInicioRuta, new Date("2026-08-27T09:00:00"));

    expect(realm.objects).toHaveBeenCalledWith("BitacoraTrackingGps");
    expect(points).toHaveLength(2);
    expect(summary.puntos).toBe(2);
    expect(summary.distanciaMetros).toBe(1000);
  });

  it("persiste el punto inicial con el intervalo de la empresa", async () => {
    user.segundosRecorrido = 60;

    const started = await service.iniciarRuta();

    expect(started).toBe(true);
    expect(config.rutaActiva).toBe(true);
    expect(registrarCapturaTracking).toHaveBeenCalledWith(19.5, -96.9, 8, true, 60000, undefined);
    expect(BackgroundLocationService.start).toHaveBeenCalled();
  });

  it("no reporta ruta activa si el servicio background no inicia", async () => {
    (BackgroundLocationService.start as jest.Mock).mockRejectedValueOnce(new Error("FGS no disponible"));

    const started = await service.iniciarRuta();

    expect(started).toBe(false);
    expect(service.getStatus()).toBe("idle");
  });

  it("finaliza una sesión restaurada y fuerza el envío de pendientes", async () => {
    config.rutaActiva = true;
    config.fechaInicioRuta = new Date("2026-08-27T08:00:00");

    const summary = await service.finalizarRuta();

    expect(summary).not.toBeNull();
    expect(config.rutaActiva).toBe(false);
    expect(BackgroundLocationService.stop).toHaveBeenCalled();
    expect(BackgroundLocationService.waitForTrackingUpload).toHaveBeenCalled();
    expect(enviarTrackingPendientes).toHaveBeenCalledWith(7, 42, true);
    expect(service.getStatus()).toBe("idle");
  });
});
