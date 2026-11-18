jest.mock("react-native-background-actions", () => ({
  __esModule: true,
  default: {
    isRunning: jest.fn(() => false),
    start: jest.fn(),
    stop: jest.fn(),
    updateNotification: jest.fn(),
  },
}));

jest.mock("react-native-geolocation-service", () => ({
  __esModule: true,
  default: {
    watchPosition: jest.fn(() => 1),
    clearWatch: jest.fn(),
  },
}));

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: {
    fetch: jest.fn(),
  },
}));

jest.mock("../services/FullSyncService", () => ({
  __esModule: true,
  default: {
    initialize: jest.fn(),
    getRealm: jest.fn(() => ({})),
  },
}));

jest.mock("../services/AuthService", () => ({
  __esModule: true,
  default: {
    restoreSession: jest.fn(),
  },
}));

jest.mock("../services/GpsBitacoraService", () => ({
  __esModule: true,
  TRACKING_UPLOAD_INTERVAL_MS: 30 * 1000,
  default: {
    registrarCapturaTracking: jest.fn(),
    enviarTrackingPendientes: jest.fn(),
  },
}));

jest.mock("../services/LocationService", () => ({
  __esModule: true,
  default: {
    forzarIntervaloNativo: jest.fn(),
    setWatchRestoreHandler: jest.fn(),
    requestBackgroundLocationPermission: jest.fn(() => Promise.resolve("granted")),
    requestNotificationPermission: jest.fn(() => Promise.resolve("granted")),
    openSettings: jest.fn(),
  },
  calcularDistancia: jest.fn(() => 0),
}));

jest.mock("../services/StallNotificationNative", () => ({
  showStallNotification: jest.fn(() => Promise.resolve(true)),
  cancelStallNotification: jest.fn(() => Promise.resolve(true)),
}));

import BackgroundActions from "react-native-background-actions";
import NetInfo from "@react-native-community/netinfo";
import { calcularDistancia } from "../services/LocationService";
import AuthService from "../services/AuthService";
import GpsBitacoraService from "../services/GpsBitacoraService";
import StallAlertService from "../services/StallAlertService";
import { cancelStallNotification, showStallNotification } from "../services/StallNotificationNative";
import BackgroundLocationService from "../services/BackgroundLocationService";

const service = BackgroundLocationService as any;
const TRACKING_UPLOAD_INTERVAL_MS = 30 * 1000;
const netInfoFetch = NetInfo.fetch as jest.Mock;
const restoreSession = AuthService.restoreSession as jest.Mock;
const registrarCapturaTracking =
  GpsBitacoraService.registrarCapturaTracking as jest.Mock;
const enviarTrackingPendientes =
  GpsBitacoraService.enviarTrackingPendientes as jest.Mock;
const showStallNotificationMock = showStallNotification as jest.Mock;
const cancelStallNotificationMock = cancelStallNotification as jest.Mock;

const flushPromises = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
};

describe("BackgroundLocationService tracking upload", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    service.isReady = true;
    service.isTaskRunning = true;
    service.generation = 1;
    service.watchId = null;
    service.lastCaptureAt = 0;
    service.lastTrackingUploadAttemptAt = 0;
    service.trackingUploadInFlight = null;
    service.backgroundTaskInFlight = null;
    service.captureInFlight = false;
    service.gpsEnganchado = false;
    service.fixesRecientes = [];
    service.stallNotificationToggle = false;
    service.stallContext = {
      routeKey: "42-7-route",
      idUsuario: 42,
      nombreUsuario: "Vendedor de prueba",
      sucursal: 7,
      metrosTolerancia: 30,
      segundosVarado: 200,
    };
    StallAlertService.reset();
    service.intervalMs = 30000;
    service.intervaloNativo = 5000;
    registrarCapturaTracking.mockResolvedValue(true);
    netInfoFetch.mockResolvedValue({
      isConnected: true,
      isInternetReachable: true,
    });
    restoreSession.mockResolvedValue({ id: 42, sucursal_origen: 7 });
    enviarTrackingPendientes.mockResolvedValue(undefined);
  });

  afterEach(() => {
    service.isTaskRunning = false;
    service.generation += 1;
    service.watchId = null;
    jest.useRealTimers();
  });

  it("inicia el foreground service antes del aviso de batería", async () => {
    const batteryPrompt = jest
      .spyOn(service, "requestIgnoreBatteryOptimizations")
      .mockResolvedValue(undefined);

    await service.start();

    expect(BackgroundActions.start).toHaveBeenCalledTimes(1);
    expect(BackgroundActions.start).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        taskTitle: "Xallapan",
        taskDesc: "Registrando tu recorrido en segundo plano",
        foregroundServiceType: ["location"],
      }),
    );
    expect(batteryPrompt).toHaveBeenCalledTimes(1);
    expect((BackgroundActions.start as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      batteryPrompt.mock.invocationCallOrder[0],
    );
  });

  it("registra salud del foreground service y del último fix", async () => {
    (BackgroundActions.isRunning as jest.Mock).mockReturnValue(true);
    service.lastFixAt = Date.now() - 1000;
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);

    await service.logBackgroundHealth("watchdog");

    expect(logSpy).toHaveBeenCalledWith(
      "[BackgroundLocationService]",
      "[Health] Estado del tracking",
      expect.objectContaining({ source: "watchdog", foregroundRunning: true }),
    );
    logSpy.mockRestore();
  });

  it("publica la alerta nativa una sola vez y alterna el indicador GPS", async () => {
    (BackgroundActions.isRunning as jest.Mock).mockReturnValue(true);
    (calcularDistancia as jest.Mock).mockImplementation((lat1: number, _lng1: number, lat2: number) =>
      Math.abs(lat2 - lat1) > 0.0005 ? 100 : 0,
    );

    const sendFix = async (timestamp: number, latitude = 19.55, longitude = -96.95) => {
      service.lastCaptureAt = 0;
      await service.onLocationFix(
        {
          coords: { latitude, longitude, accuracy: 8 },
          timestamp,
        } as any,
        1,
      );
      await flushPromises();
    };

    await sendFix(0);
    await sendFix(200_000);
    await sendFix(260_000);

    expect(showStallNotificationMock).toHaveBeenCalledTimes(1);
    expect(showStallNotificationMock).toHaveBeenCalledWith(
      "Vendedor de prueba",
      3,
      19.55,
      -96.95,
    );
    expect(BackgroundActions.updateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ taskTitle: "Alerta de recorrido", color: "#C62828" }),
    );
    expect(BackgroundActions.updateNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({ taskTitle: "Xallapan", color: "#007AFF" }),
    );

    await sendFix(320_000, 19.551);
    expect(cancelStallNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("continúa el tracking si falla la alerta nativa", async () => {
    (BackgroundActions.isRunning as jest.Mock).mockReturnValue(true);
    showStallNotificationMock.mockRejectedValueOnce(new Error("módulo no disponible"));
    service.lastCaptureAt = 0;
    await service.onLocationFix({
      coords: { latitude: 19.55, longitude: -96.95, accuracy: 8 },
      timestamp: 0,
    } as any, 1);
    service.lastCaptureAt = 0;
    await service.onLocationFix({
      coords: { latitude: 19.55, longitude: -96.95, accuracy: 8 },
      timestamp: 200_000,
    } as any, 1);

    expect(registrarCapturaTracking).toHaveBeenCalledTimes(2);
    expect(BackgroundActions.updateNotification).toHaveBeenCalled();
  });

  it("envía el tracking pendiente cuando la ruta está activa y hay red", async () => {
    await service.uploadTrackingPendientes(1);

    expect(enviarTrackingPendientes).toHaveBeenCalledWith(7, 42);
  });

  it("conserva la cola sin intentar enviar cuando no hay red", async () => {
    netInfoFetch.mockResolvedValue({
      isConnected: false,
      isInternetReachable: false,
    });

    await service.uploadTrackingPendientes(1);

    expect(enviarTrackingPendientes).not.toHaveBeenCalled();
  });

  it("omite un ciclo de una generación anterior después de detener la ruta", async () => {
    service.generation = 2;

    await service.uploadTrackingPendientes(1);

    expect(netInfoFetch).not.toHaveBeenCalled();
    expect(enviarTrackingPendientes).not.toHaveBeenCalled();
  });

  it("reintenta en el siguiente ciclo si el envío falla", async () => {
    jest.useFakeTimers();
    enviarTrackingPendientes
      .mockRejectedValueOnce(new Error("sin red"))
      .mockResolvedValueOnce(undefined);

    await service.uploadTrackingPendientes(1);
    await jest.advanceTimersByTimeAsync(TRACKING_UPLOAD_INTERVAL_MS);
    await service.uploadTrackingPendientes(1);

    expect(enviarTrackingPendientes).toHaveBeenCalledTimes(2);
  });

  it("dispara la subida desde un fix y respeta la ventana de 30 segundos", async () => {
    jest.useFakeTimers();
    const position = {
      coords: { latitude: 19.55, longitude: -96.95, accuracy: 8 },
      timestamp: Date.now(),
    } as any;

    await service.onLocationFix(position, 1);
    await flushPromises();
    expect(registrarCapturaTracking).toHaveBeenCalledTimes(1);
    expect(registrarCapturaTracking).toHaveBeenCalledWith(
      19.55,
      -96.95,
      8,
      true,
      30000,
      position.timestamp,
    );
    expect(enviarTrackingPendientes).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(15000);
    await service.onLocationFix(position, 1);
    await flushPromises();
    expect(enviarTrackingPendientes).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(15000);
    await service.onLocationFix(position, 1);
    await flushPromises();
    expect(enviarTrackingPendientes).toHaveBeenCalledTimes(2);
  });

  it("no persiste ubicaciones simuladas", async () => {
    await service.onLocationFix(
      {
        coords: { latitude: 19.55, longitude: -96.95, accuracy: 8 },
        timestamp: Date.now(),
        mocked: true,
      } as any,
      1,
    );

    expect(registrarCapturaTracking).not.toHaveBeenCalled();
  });

  it("mantiene el watchdog como respaldo y respeta la ventana de 30 segundos", async () => {
    jest.useFakeTimers();
    const taskPromise = service.backgroundTask();

    await flushPromises();
    expect(enviarTrackingPendientes).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(120000);
    await flushPromises();
    expect(enviarTrackingPendientes).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(TRACKING_UPLOAD_INTERVAL_MS + 60000);
    await flushPromises();
    expect(enviarTrackingPendientes).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(30000);
    await flushPromises();
    expect(enviarTrackingPendientes).toHaveBeenCalledTimes(3);

    service.isTaskRunning = false;
    service.generation = 2;
    await jest.advanceTimersByTimeAsync(120000);
    await taskPromise;
  });

  describe("historial de fixes confiables", () => {
    it("acredita un fix de buena calidad aunque no llegue a persistirse", async () => {
      // El registro debe ocurrir ANTES del return de captureInFlight: si no,
      // solo entrarían los fixes que además pasan el throttle de 30 s.
      service.captureInFlight = true;
      await service.onLocationFix(
        {
          coords: { latitude: 19.55, longitude: -96.95, accuracy: 8 },
          timestamp: Date.now(),
        } as any,
        1,
      );

      expect(service.getFixesRecientes(5 * 60_000, 25)).toHaveLength(1);
      service.captureInFlight = false;
    });

    it("no registra fixes con accuracy mayor a 25 m", async () => {
      await service.onLocationFix(
        {
          coords: { latitude: 19.55, longitude: -96.95, accuracy: 400 },
          timestamp: Date.now(),
        } as any,
        1,
      );

      expect(service.getFixesRecientes(5 * 60_000, 25)).toEqual([]);
    });

    it("nunca supera el máximo de 12 fixes", async () => {
      for (let i = 0; i < 20; i += 1) {
        await service.onLocationFix(
          {
            coords: { latitude: 19.55 + i * 1e-5, longitude: -96.95, accuracy: 8 },
            timestamp: Date.now(),
          } as any,
          1,
        );
      }

      expect(service.getFixesRecientes(5 * 60_000, 25)).toHaveLength(12);
    });

    it("devuelve [] si el servicio no está arrancado", async () => {
      service.isTaskRunning = false;

      await service.onLocationFix(
        {
          coords: { latitude: 19.55, longitude: -96.95, accuracy: 8 },
          timestamp: Date.now(),
        } as any,
        1,
      );

      expect(service.getFixesRecientes(5 * 60_000, 25)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Reglas de admisión de evidencia (R1 proveedor, R2 salto imposible).
// Solo los fixes que pasan estas reglas pueden acreditar una venta como
// `ok_tracking`; ver docs/PLAN_OK_TRACKING.md §14.
// ---------------------------------------------------------------------------
describe("BackgroundLocationService — evidencia persistida", () => {
  const LAT = 19.55;
  const LNG = -96.95;
  // 0.05° de latitud ≈ 5.5 km
  const LEJOS = LAT + 0.05;

  const pos = (
    latitude: number,
    longitud: number,
    opts: { accuracy?: number; timestamp?: number; provider?: string; speed?: number | null } = {},
  ) =>
    ({
      coords: {
        latitude,
        longitude: longitud,
        accuracy: opts.accuracy ?? 10,
        speed: opts.speed ?? null,
      },
      timestamp: opts.timestamp ?? Date.now(),
      provider: opts.provider,
    }) as any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    service.fixesPersistidos = [];
    service.fixDescartadoPorSalto = null;
    service.ultimoFixTracking = null;
    service.saltoDescartadoUltimoTracking = null;
    service.isTaskRunning = false;
    service.captureInFlight = false;
    service.lastCaptureAt = 0;
    service.lastCaptureAccuracy = 999;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("R1: descarta un fix de red aunque declare ±12 m (caso 373510)", () => {
    service.registrarFixPersistido(pos(LAT, LNG, { accuracy: 12, provider: "network" }));

    expect(service.getFixesPersistidos(5 * 60_000, 25)).toEqual([]);
  });

  it("R1: descarta un fix pasivo", () => {
    service.registrarFixPersistido(pos(LAT, LNG, { accuracy: 8, provider: "passive" }));

    expect(service.getFixesPersistidos(5 * 60_000, 25)).toEqual([]);
  });

  it("R1: acepta GNSS crudo", () => {
    service.registrarFixPersistido(pos(LAT, LNG, { accuracy: 12, provider: "gps" }));

    expect(service.getFixesPersistidos(5 * 60_000, 25)).toHaveLength(1);
  });

  it("R1: acepta `fused` con el umbral general de precisión (≤25 m)", () => {
    service.registrarFixPersistido(pos(LAT, LNG, { accuracy: 15, provider: "fused" }));
    expect(service.getFixesPersistidos(5 * 60_000, 25)).toHaveLength(1);

    // Caso 400517: el fix a 50.6 m del cliente con ±24.2 m era descartado por
    // la regla vieja (fused <= 20); ahora entra al umbral general.
    service.fixesPersistidos = [];
    service.registrarFixPersistido(pos(LAT, LNG, { accuracy: 24.2, provider: "fused" }));
    expect(service.getFixesPersistidos(5 * 60_000, 25)).toHaveLength(1);

    service.fixesPersistidos = [];
    service.registrarFixPersistido(pos(LAT, LNG, { accuracy: 26, provider: "fused" }));
    expect(service.getFixesPersistidos(5 * 60_000, 25)).toHaveLength(0);
  });

  it("R1: `fused` sin velocidad también se acepta (en Android speed siempre llega como número)", () => {
    service.registrarFixPersistido(pos(LAT, LNG, { accuracy: 15, provider: "fused", speed: null }));
    expect(service.getFixesPersistidos(5 * 60_000, 25)).toHaveLength(1);
  });

  it("R2: descarta un salto imposible (5.5 km en 30 s = 660 km/h)", () => {
    const t0 = Date.now();
    service.registrarFixPersistido(pos(LAT, LNG, { timestamp: t0 - 60_000, provider: "gps" }));
    service.registrarFixPersistido(pos(LEJOS, LNG, { timestamp: t0 - 30_000, provider: "gps" }));

    const buffer = service.getFixesPersistidos(5 * 60_000, 25);
    expect(buffer).toHaveLength(1);
    expect(buffer[0].latitud).toBeCloseTo(LAT, 5);
  });

  it("R2: el salto descartado no mueve la base (el fix siguiente se acepta)", () => {
    const t0 = Date.now();
    service.registrarFixPersistido(pos(LAT, LNG, { timestamp: t0 - 90_000, provider: "gps" }));
    service.registrarFixPersistido(pos(LEJOS, LNG, { timestamp: t0 - 60_000, provider: "gps" }));
    service.registrarFixPersistido(pos(LAT + 0.0001, LNG, { timestamp: t0 - 30_000, provider: "gps" }));

    const buffer = service.getFixesPersistidos(5 * 60_000, 25);
    expect(buffer).toHaveLength(2);
    for (const f of buffer) {
      expect(f.latitud).toBeLessThan(LAT + 0.001);
    }
  });

  it("R2: dos fixes concordantes entre sí reanclan la cadena tras un salto", () => {
    const t0 = Date.now();
    service.registrarFixPersistido(pos(LAT, LNG, { timestamp: t0 - 120_000, provider: "gps" }));
    // Salto: 660 km/h contra la base → descartado, queda como candidato de reanclaje.
    service.registrarFixPersistido(pos(LEJOS, LNG, { timestamp: t0 - 90_000, provider: "gps" }));
    expect(service.getFixesPersistidos(5 * 60_000, 25)).toHaveLength(1);

    // El siguiente concuerda con el descartado (11 m en 30 s) → movimiento real.
    service.registrarFixPersistido(pos(LEJOS + 0.0001, LNG, { timestamp: t0 - 60_000, provider: "gps" }));

    const buffer = service.getFixesPersistidos(5 * 60_000, 25);
    expect(buffer).toHaveLength(2);
    for (const f of buffer) {
      expect(f.latitud).toBeGreaterThan(LEJOS - 0.001);
    }
  });

  it("no persiste fixes simulados ni sin coordenadas válidas", () => {
    service.registrarFixPersistido({
      coords: { latitude: Number.NaN, longitude: LNG, accuracy: 8 },
      timestamp: Date.now(),
      provider: "gps",
    } as any);

    expect(service.getFixesPersistidos(5 * 60_000, 25)).toEqual([]);
  });

  it("protege ultimoFixTracking contra un salto imposible a >150 km/h", async () => {
    service.isTaskRunning = true;
    const t0 = Date.now();
    // Fix #1: posición normal
    await service.onLocationFix(
      pos(LAT, LNG, { accuracy: 12, timestamp: t0 - 5000 }),
      service.generation,
    );
    expect(service.getUltimoFixTracking()?.latitud).toBeCloseTo(LAT, 5);

    // Fix #2: salto imposible a 5.5 km de distancia en 3 segundos
    await service.onLocationFix(
      pos(LEJOS, LNG, { accuracy: 10, timestamp: t0 - 2000 }),
      service.generation,
    );
    // Debe mantener Fix #1 y no haberse contaminado con Fix #2
    expect(service.getUltimoFixTracking()?.latitud).toBeCloseTo(LAT, 5);
  });

  it("mejora la ventana cuando llega un fix con calidad de evidencia tras uno impreciso", async () => {
    // Caso 400517: las capturas de 36/52.8 m de cada minuto bloqueaban por
    // throttle los fixes mucho más precisos de las validaciones (6.9/17.6 m).
    // Ahora un fix ≤25 m actualiza la ventana escrita con un fix >25 m.
    registrarCapturaTracking.mockResolvedValue(true);
    service.isTaskRunning = true;

    const t0 = Date.now();
    await service.onLocationFix(
      pos(LAT, LNG, { accuracy: 52, timestamp: t0 }),
      service.generation,
    );
    await flushPromises();
    expect(registrarCapturaTracking).toHaveBeenCalledTimes(1);
    expect(service.getFixesPersistidos(5 * 60_000, 25)).toHaveLength(0);

    await service.onLocationFix(
      pos(LAT + 0.0001, LNG, { accuracy: 8, timestamp: t0 + 15_000 }),
      service.generation,
    );
    await flushPromises();

    expect(registrarCapturaTracking).toHaveBeenCalledTimes(2);
    expect(service.getFixesPersistidos(5 * 60_000, 25)).toHaveLength(1);
  });

  it("no reescribe la ventana si la captura previa ya calificaba como evidencia", async () => {
    registrarCapturaTracking.mockResolvedValue(true);
    service.isTaskRunning = true;

    const t0 = Date.now();
    await service.onLocationFix(
      pos(LAT, LNG, { accuracy: 20, timestamp: t0 }),
      service.generation,
    );
    await flushPromises();
    expect(registrarCapturaTracking).toHaveBeenCalledTimes(1);

    // El fix mejor queda fuera por el throttle normal: no duplicar escrituras.
    await service.onLocationFix(
      pos(LAT + 0.0001, LNG, { accuracy: 8, timestamp: t0 + 15_000 }),
      service.generation,
    );
    await flushPromises();

    expect(registrarCapturaTracking).toHaveBeenCalledTimes(1);
    expect(service.getFixesPersistidos(5 * 60_000, 25)).toHaveLength(1);
  });

  it("un fix espurio (salto imposible) no puede mejorar la ventana", async () => {
    registrarCapturaTracking.mockResolvedValue(true);
    service.isTaskRunning = true;

    const t0 = Date.now();
    await service.onLocationFix(
      pos(LAT, LNG, { accuracy: 52, timestamp: t0 }),
      service.generation,
    );
    await flushPromises();
    expect(registrarCapturaTracking).toHaveBeenCalledTimes(1);

    // 5.5 km en 15 s = >150 km/h: el espurio se descarta y no reescribe nada.
    await service.onLocationFix(
      pos(LEJOS, LNG, { accuracy: 8, timestamp: t0 + 15_000 }),
      service.generation,
    );
    await flushPromises();

    expect(registrarCapturaTracking).toHaveBeenCalledTimes(1);
  });
});
