jest.mock("react-native-geolocation-service", () => ({
  __esModule: true,
  default: {
    watchPosition: jest.fn(() => 1),
    clearWatch: jest.fn(),
    getCurrentPosition: jest.fn(),
    requestAuthorization: jest.fn(() => Promise.resolve("granted")),
  },
}));

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: {
    fetch: jest.fn(),
  },
}));

jest.mock("../services/GpsBitacoraService", () => ({
  __esModule: true,
  default: {
    registrarValidacion: jest.fn(),
    registrarUbicacion: jest.fn(),
  },
}));

jest.mock("../services/BackgroundLocationService", () => ({
  __esModule: true,
  default: {
    getFixesRecientes: jest.fn(() => []),
    getFixesPersistidos: jest.fn(() => []),
    getUltimoFixTracking: jest.fn(() => null),
  },
}));

import NetInfo from "@react-native-community/netinfo";
import BackgroundLocationService from "../services/BackgroundLocationService";
import LocationService, {
  DiagnosticoGps,
  LocationCoordinates,
} from "../services/LocationService";

type FixTracking = {
  latitud: number;
  longitud: number;
  accuracy: number;
  timestamp: number;
  receivedAt?: number;
};

const service = LocationService as any;
const getFixesRecientesMock = BackgroundLocationService.getFixesRecientes as jest.Mock;
const getFixesPersistidosMock = BackgroundLocationService.getFixesPersistidos as jest.Mock;

const CLIENTE = { lat: 19.4397012, lng: -96.7532193 };
const PERMITIDO = 100;

// Dato real del caso 357053 (Anexo C): 17.5 m del cliente, ±18.556 m.
const EVIDENCIA_REAL = {
  latitud: 19.4398574829102,
  longitud: -96.7532424926758,
  accuracy: 18.556,
};

const desplazarLat = (metros: number): number => CLIENTE.lat + metros / 111320;

const diagImpreciso: DiagnosticoGps = { numFixes: 1, peorAccuracy: 2066.0390625, tiempoMs: 6014 };

let liveLocation: LocationCoordinates | null = null;
let liveDiag: DiagnosticoGps = diagImpreciso;
let fixes: FixTracking[] = [];

const validar = () => LocationService.validarUbicacionCliente(CLIENTE.lat, CLIENTE.lng, PERMITIDO);

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);

  service.hasPermission = true;
  service.ultimaValidacionOk = null;
  service.okTrackingHabilitadoOverride = null;
  service.ultimoDiagnosticoGps = { numFixes: 0, peorAccuracy: 0, tiempoMs: 0 };

  liveDiag = diagImpreciso;
  liveLocation = {
    latitude: desplazarLat(200),
    longitude: CLIENTE.lng,
    accuracy: 2066.0390625,
    timestamp: Date.now(),
  };
  fixes = [];

  getFixesPersistidosMock.mockImplementation((maxEdadMs: number, maxAccuracy: number) =>
    fixes.filter((f) => Date.now() - (f.receivedAt ?? f.timestamp) <= maxEdadMs && f.accuracy <= maxAccuracy),
  );

  jest.spyOn(LocationService, "getBestLocation").mockImplementation(async () => {
    service.ultimoDiagnosticoGps = liveDiag;
    return liveLocation;
  });

  (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: true });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("ok_tracking — corroboración con el tracking de ruta", () => {
  it("T1: aprueba por tracking cuando el fix en vivo es impreciso pero hay evidencia reciente", async () => {
    fixes = [{ ...EVIDENCIA_REAL, timestamp: Date.now() - 174_000 }];

    const r = await validar();

    expect(r.valido).toBe(true);
    expect(r.motivo).toBe("ok_tracking");
    expect(r.distancia).toBeCloseTo(17.55, 1);
    expect(r.accuracy).toBe(18.556);
    expect(r.ubicacion).toEqual(
      expect.objectContaining({ latitude: EVIDENCIA_REAL.latitud, longitude: EVIDENCIA_REAL.longitud }),
    );
    expect(r.numFixes).toBe(0);
    expect(r.tiempoMs).toBe(0);
  });

  it("T2: no aprueba si el mejor fix de tracking está fuera del rango", async () => {
    fixes = [
      {
        latitud: desplazarLat(120),
        longitud: CLIENTE.lng,
        accuracy: 18.556,
        timestamp: Date.now() - 60_000,
      },
    ];

    const r = await validar();

    expect(r.valido).toBe(false);
    expect(r.motivo).toBe("precision_baja");
  });

  it("T3: veta la aprobación si UN fix bueno y reciente ubica al vendedor lejos (R3 — Veto = 1)", async () => {
    fixes = [
      { ...EVIDENCIA_REAL, timestamp: Date.now() - 174_000 },
      {
        latitud: desplazarLat(250),
        longitud: CLIENTE.lng,
        accuracy: 10,
        timestamp: Date.now() - 30_000,
      },
    ];

    const r = await validar();

    expect(r.valido).toBe(false);
    expect(r.motivo).toBe("precision_baja");
  });

  it("T4: fuera_de_rango contradicho por evidencia persistida se aprueba como ok_tracking (I2 enmendada)", async () => {
    // Caso 373510: la lectura declara 419 m con ±11.9 m mientras el tracking
    // del mismo minuto marca 38 m del cliente. Antes esto bloqueaba la venta
    // sin salida; ahora se aprueba con la evidencia que ya está en el servidor.
    liveLocation = {
      latitude: desplazarLat(134),
      longitude: CLIENTE.lng,
      accuracy: 6,
      timestamp: Date.now(),
    };
    fixes = [
      {
        latitud: desplazarLat(20),
        longitud: CLIENTE.lng,
        accuracy: 10,
        timestamp: Date.now() - 60_000,
      },
    ];

    const r = await validar();

    expect(r.valido).toBe(true);
    expect(r.motivo).toBe("ok_tracking");
    expect(r.distancia).toBeCloseTo(20, 0);
    expect(r.ubicacion).toEqual(
      expect.objectContaining({ latitude: desplazarLat(20), longitude: CLIENTE.lng }),
    );
    expect(r.numFixes).toBe(0);
    expect(getFixesPersistidosMock).toHaveBeenCalled();
  });

  it("T4b: fuera_de_rango SIN evidencia persistida sigue bloqueando (I2)", async () => {
    liveLocation = {
      latitude: desplazarLat(134),
      longitude: CLIENTE.lng,
      accuracy: 6,
      timestamp: Date.now(),
    };
    fixes = [];

    const r = await validar();

    expect(r.valido).toBe(false);
    expect(r.motivo).toBe("fuera_de_rango");
  });

  it("T4c: el veto manda sobre la evidencia positiva (R3)", async () => {
    liveLocation = {
      latitude: desplazarLat(134),
      longitude: CLIENTE.lng,
      accuracy: 6,
      timestamp: Date.now(),
    };
    fixes = [
      { latitud: desplazarLat(15), longitud: CLIENTE.lng, accuracy: 10, timestamp: Date.now() - 150_000 },
      { latitud: desplazarLat(300), longitud: CLIENTE.lng, accuracy: 12, timestamp: Date.now() - 40_000 },
      { latitud: desplazarLat(320), longitud: CLIENTE.lng, accuracy: 12, timestamp: Date.now() - 20_000 },
    ];

    const r = await validar();

    expect(r.valido).toBe(false);
    expect(r.motivo).toBe("fuera_de_rango");
  });

  it("T4f: un solo fix de alejamiento SÍ veta (R3 — Veto = 1, caso 400517)", async () => {
    // Caso 400517 (2026-11-05): el vendedor estuvo a ~50 m del cliente 27677 a
    // las 11:28:08 (fix persistido ±24.2 m), se movió 550 m al este y el fix de
    // las 11:29:14 (477 m, ±8 m) ya lo ubica fuera. A las 11:29:22 intenta
    // validar: la evidencia positiva existe pero el veto manda — una visita
    // cerrada después de irse no se aprueba.
    liveLocation = {
      latitude: desplazarLat(551),
      longitude: CLIENTE.lng,
      accuracy: 4.7,
      timestamp: Date.now(),
    };
    fixes = [
      { latitud: desplazarLat(51), longitud: CLIENTE.lng, accuracy: 24.2, timestamp: Date.now() - 74_000 },
      { latitud: desplazarLat(477), longitud: CLIENTE.lng, accuracy: 8, timestamp: Date.now() - 8_000 },
    ];

    const r = await validar();

    expect(r.valido).toBe(false);
    expect(r.motivo).toBe("fuera_de_rango");
    expect(r.distancia).toBeCloseTo(550.4, 0);
  });

  it("T12: evidencia fused de 24.7 m dentro del rango aprueba (caso 399679)", async () => {
    // Caso 399679 (2026-11-05): falso negativo real — el vendedor seguía a
    // 13.2 m del cliente con evidencia persistida de ±24.7 m; la regla vieja
    // (fused <= 20 m) la había descartado. Sin fixes lejanos, aprueba.
    liveLocation = {
      latitude: desplazarLat(200),
      longitude: CLIENTE.lng,
      accuracy: 2066.0390625,
      timestamp: Date.now(),
    };
    fixes = [
      { latitud: desplazarLat(13), longitud: CLIENTE.lng, accuracy: 24.7, timestamp: Date.now() - 60_000 },
    ];

    const r = await validar();

    expect(r.valido).toBe(true);
    expect(r.motivo).toBe("ok_tracking");
    expect(r.distancia).toBeCloseTo(13, 0);
  });

  it("T4d: evidencia de más de 5 min no aprueba un fuera_de_rango", async () => {
    liveLocation = {
      latitude: desplazarLat(134),
      longitude: CLIENTE.lng,
      accuracy: 6,
      timestamp: Date.now(),
    };
    fixes = [{ ...EVIDENCIA_REAL, timestamp: Date.now() - 6 * 60 * 1000 }];

    const r = await validar();

    expect(r.valido).toBe(false);
    expect(r.motivo).toBe("fuera_de_rango");
  });

  it("T4e: con el rollback global deshabilitado, fuera_de_rango no se aprueba", async () => {
    service.okTrackingHabilitadoOverride = false;
    liveLocation = {
      latitude: desplazarLat(134),
      longitude: CLIENTE.lng,
      accuracy: 6,
      timestamp: Date.now(),
    };
    fixes = [
      { latitud: desplazarLat(20), longitud: CLIENTE.lng, accuracy: 10, timestamp: Date.now() - 60_000 },
    ];

    const r = await validar();

    expect(r.valido).toBe(false);
    expect(r.motivo).toBe("fuera_de_rango");
  });

  it("T5: con el rollback deshabilitado se conserva el comportamiento anterior", async () => {
    // `HABILITAR_OK_TRACKING` se compila como binding local y no se puede
    // mockear; el override ejerce exactamente la misma rama de rollback.
    service.okTrackingHabilitadoOverride = false;
    fixes = [{ ...EVIDENCIA_REAL, timestamp: Date.now() - 174_000 }];

    const r = await validar();

    expect(r.valido).toBe(false);
    expect(r.motivo).toBe("precision_baja");
  });

  it("T6: sin fixes recientes el comportamiento es el actual", async () => {
    fixes = [];

    const r = await validar();

    expect(r.valido).toBe(false);
    expect(r.motivo).toBe("precision_baja");
    expect(r.distancia).toBeDefined();
  });

  it("T7: si el tracking falla no propaga la excepción (I7)", async () => {
    getFixesPersistidosMock.mockImplementation(() => {
      throw new Error("tracking caído");
    });

    const r = await validar();

    expect(r.valido).toBe(false);
    expect(r.motivo).toBe("precision_baja");
  });

  it("T8: una segunda validación del mismo cliente usa la caché", async () => {
    fixes = [{ ...EVIDENCIA_REAL, timestamp: Date.now() - 174_000 }];

    const primera = await validar();
    const segunda = await validar();

    expect(primera.motivo).toBe("ok_tracking");
    expect(segunda.motivo).toBe("ok_cache");
    expect(segunda.valido).toBe(true);
    expect(LocationService.getBestLocation).toHaveBeenCalledTimes(1);
  });

  it("T9: sin permiso de ubicación jamás se aprueba por tracking (I3)", async () => {
    service.hasPermission = false;
    jest.spyOn(LocationService, "checkPermission").mockResolvedValue(false);
    fixes = [{ ...EVIDENCIA_REAL, timestamp: Date.now() - 60_000 }];

    const r = await validar();

    expect(r.valido).toBe(false);
    expect(r.motivo).toBe("sin_permiso");
    expect(getFixesPersistidosMock).not.toHaveBeenCalled();
  });

  it("T10: sin lectura en vivo pero con evidencia de tracking aprueba por Punto A", async () => {
    liveLocation = null;
    liveDiag = { numFixes: 0, peorAccuracy: 0, tiempoMs: 6000 };
    fixes = [{ ...EVIDENCIA_REAL, timestamp: Date.now() - 60_000 }];

    const r = await validar();

    expect(r.valido).toBe(true);
    expect(r.motivo).toBe("ok_tracking");
    expect(r.distancia).toBeCloseTo(17.55, 1);
  });

  it("T11: un fix en vivo bueno y dentro de rango siempre gana al tracking (motivo ok)", async () => {
    // Simétrico a T4: la lectura en vivo ya es confiable, así que el tracking
    // ni se consulta y la aprobación queda contabilizada como `ok`, no como
    // `ok_tracking`. Protege las métricas y el orden de precedencia.
    liveLocation = {
      latitude: desplazarLat(40),
      longitude: CLIENTE.lng,
      accuracy: 8,
      timestamp: Date.now(),
    };
    liveDiag = { numFixes: 2, peorAccuracy: 8, tiempoMs: 1800 };
    fixes = [{ ...EVIDENCIA_REAL, timestamp: Date.now() - 60_000 }];

    const r = await validar();

    expect(r.valido).toBe(true);
    expect(r.motivo).toBe("ok");
    expect(r.distancia).toBeCloseTo(40, 0);
    expect(getFixesPersistidosMock).not.toHaveBeenCalled();
  });
});

describe("getBestLocation — protección contra saltos espurios (Caso real 373510)", () => {
  beforeEach(() => {
    (LocationService.getBestLocation as any).mockRestore?.();
  });

  it("no reemplaza un fix válido por un salto espurio a 419 m ni corta en falso fuera_de_rango", async () => {
    const Geolocation = require("react-native-geolocation-service").default;
    const now = Date.now();

    // Fix #1: a ~38 m del cliente con ±18.28 m
    const fix1 = {
      coords: {
        latitude: desplazarLat(38),
        longitude: CLIENTE.lng,
        accuracy: 18.28,
      },
      timestamp: now,
    };

    // Fix #2: salto espurio a 419 m en 3 segundos (salto a > 500 km/h)
    const fix2 = {
      coords: {
        latitude: desplazarLat(419),
        longitude: CLIENTE.lng,
        accuracy: 11.9,
      },
      timestamp: now + 3000,
    };

    // Fix #3: confirmación en la posición real a los 4 segundos (concordante con fix1)
    const fix3 = {
      coords: {
        latitude: desplazarLat(38.5),
        longitude: CLIENTE.lng,
        accuracy: 15.0,
      },
      timestamp: now + 4000,
    };

    (Geolocation.watchPosition as jest.Mock).mockImplementation((success: Function) => {
      // Simular entrega de los tres fixes secuenciales
      success(fix1);
      success(fix2);
      success(fix3);
      return 1;
    });

    const res = await LocationService.getBestLocation(
      5,
      6000,
      undefined,
      (c) => c.accuracy! <= 50 && Math.abs(c.latitude - fix1.coords.latitude) < 0.0005,
      (c) => c.accuracy! <= 50 && Math.abs(c.latitude - fix2.coords.latitude) < 0.0005,
    );

    // Debe conservar la posición real de ~38 m y no el salto espurio de 419 m
    expect(res).toBeDefined();
    expect(res?.latitude).toBeCloseTo(fix1.coords.latitude, 4);
    expect(res?.latitude).not.toBeCloseTo(fix2.coords.latitude, 3);
  });
});
