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
});
