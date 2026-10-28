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
    fixes.filter((f) => Date.now() - f.timestamp <= maxEdadMs && f.accuracy <= maxAccuracy),
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

  it("T3: veta la aprobación si DOS fixes buenos y recientes ubican al vendedor lejos (R3)", async () => {
    fixes = [
      { ...EVIDENCIA_REAL, timestamp: Date.now() - 174_000 },
      {
        latitud: desplazarLat(250),
        longitud: CLIENTE.lng,
        accuracy: 10,
        timestamp: Date.now() - 60_000,
      },
      {
        latitud: desplazarLat(270),
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

  it("T4c: dos fixes de alejamiento vetan la evidencia positiva (R3)", async () => {
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

  it("T4f: un solo fix de alejamiento NO veta (R3 — asimetría aprobar/vetar)", async () => {
    // Un fix de red a 300 m no debe tumbar una visita que sí tiene evidencia
    // dentro del rango: vetar exige dos fixes de acuerdo.
    liveLocation = {
      latitude: desplazarLat(134),
      longitude: CLIENTE.lng,
      accuracy: 6,
      timestamp: Date.now(),
    };
    fixes = [
      { latitud: desplazarLat(15), longitud: CLIENTE.lng, accuracy: 10, timestamp: Date.now() - 150_000 },
      { latitud: desplazarLat(300), longitud: CLIENTE.lng, accuracy: 12, timestamp: Date.now() - 20_000 },
    ];

    const r = await validar();

    expect(r.valido).toBe(true);
    expect(r.motivo).toBe("ok_tracking");
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
