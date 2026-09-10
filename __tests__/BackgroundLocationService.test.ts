jest.mock("@notifee/react-native", () => ({
  __esModule: true,
  default: {
    createChannel: jest.fn(() => Promise.resolve("alertas-recorrido")),
    displayNotification: jest.fn(() => Promise.resolve()),
    cancelNotification: jest.fn(() => Promise.resolve()),
  },
  AndroidImportance: { HIGH: 4 },
}));

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
    requestBackgroundLocationPermission: jest.fn(() => Promise.resolve(true)),
    requestNotificationPermission: jest.fn(() => Promise.resolve(true)),
    openSettings: jest.fn(),
  },
  calcularDistancia: jest.fn(() => 0),
}));

import NetInfo from "@react-native-community/netinfo";
import AuthService from "../services/AuthService";
import GpsBitacoraService from "../services/GpsBitacoraService";
import BackgroundLocationService from "../services/BackgroundLocationService";

const service = BackgroundLocationService as any;
const TRACKING_UPLOAD_INTERVAL_MS = 30 * 1000;
const netInfoFetch = NetInfo.fetch as jest.Mock;
const restoreSession = AuthService.restoreSession as jest.Mock;
const registrarCapturaTracking =
  GpsBitacoraService.registrarCapturaTracking as jest.Mock;
const enviarTrackingPendientes =
  GpsBitacoraService.enviarTrackingPendientes as jest.Mock;

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
