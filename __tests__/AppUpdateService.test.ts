const mockStorage = new Map<string, string>();
jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn((key: string) => Promise.resolve(mockStorage.get(key) ?? null)),
    setItem: jest.fn((key: string, value: string) => {
      mockStorage.set(key, value);
      return Promise.resolve();
    }),
    multiSet: jest.fn((entries: Array<[string, string]>) => {
      entries.forEach(([key, value]) => mockStorage.set(key, value));
      return Promise.resolve();
    }),
  },
}));

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  fetch: jest.fn(() => Promise.resolve({ type: "wifi", isConnected: true, isInternetReachable: true })),
}));

jest.mock("@notifee/react-native", () => ({
  __esModule: true,
  default: {
    createChannel: jest.fn(() => Promise.resolve()),
    requestPermission: jest.fn(() => Promise.resolve()),
    onForegroundEvent: jest.fn(() => jest.fn()),
    getInitialNotification: jest.fn(() => Promise.resolve(null)),
    displayNotification: jest.fn(() => Promise.resolve()),
  },
  AndroidImportance: { HIGH: 4 },
  EventType: { PRESS: 1, ACTION_PRESS: 2 },
}));

jest.mock("react-native-device-info", () => ({
  __esModule: true,
  default: {
    getBuildNumber: jest.fn(() => "3"),
    getVersion: jest.fn(() => "1.3.8"),
  },
}));

jest.mock("react-native-fs", () => ({
  __esModule: true,
  DocumentDirectoryPath: "/data/user/0/com.awesomeproject/files",
  mkdir: jest.fn(() => Promise.resolve()),
  exists: jest.fn(() => Promise.resolve(false)),
  stat: jest.fn(() => Promise.resolve({ size: 100 })),
  unlink: jest.fn(() => Promise.resolve()),
  hash: jest.fn(() => Promise.resolve("abc123")),
  downloadFile: jest.fn(),
}));

jest.mock("../services/AppUpdateNative", () => ({
  canRequestPackageInstalls: jest.fn(() => Promise.resolve(true)),
  installApk: jest.fn(() => Promise.resolve(true)),
  openInstallSettings: jest.fn(() => Promise.resolve()),
}));

jest.mock("../services/fetchWithTimeout", () => ({
  fetchWithTimeout: jest.fn(),
}));

import AppUpdateService from "../services/AppUpdateService";

const mockNetInfoFetch = jest.requireMock("@react-native-community/netinfo").fetch as jest.Mock;
const mockFetchWithTimeout = jest.requireMock("../services/fetchWithTimeout").fetchWithTimeout as jest.Mock;
const mockDownloadFile = jest.requireMock("react-native-fs").downloadFile as jest.Mock;

const createResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: jest.fn(() => Promise.resolve(body)),
});

const updatePayload = {
  id: 10,
  plataforma: "android",
  versionCode: 4,
  versionApp: "1.4.0",
  downloadUrl: "https://api.example.com/api/AppUpdates/10/download",
  sha256: "abc123",
  tamanoBytes: 100,
  obligatoria: true,
  forzarInmediata: false,
  permitirPosponerDatos: true,
  notas: "Correcciones",
};

const flushPromises = async (): Promise<void> => {
  for (let index = 0; index < 100; index += 1) await Promise.resolve();
};

describe("AppUpdateService", () => {
  beforeEach(() => {
    mockStorage.clear();
    jest.clearAllMocks();
    mockNetInfoFetch.mockResolvedValue({
      type: "wifi",
      isConnected: true,
      isInternetReachable: true,
    });
    mockFetchWithTimeout.mockResolvedValue(createResponse(updatePayload));
    mockDownloadFile.mockReturnValue({
      promise: Promise.resolve({ statusCode: 200 }),
    });
  });

  it("detecta una versión nueva y la descarga automáticamente por Wi-Fi", async () => {
    const result = await AppUpdateService.verificarActualizacion(true, "login");
    await flushPromises();

    expect(result).toMatchObject({ versionCode: 4, versionApp: "1.4.0" });
    expect(mockDownloadFile).toHaveBeenCalledWith(expect.objectContaining({
      fromUrl: updatePayload.downloadUrl,
      toFile: expect.stringContaining("xallapan-4.apk"),
      background: true,
    }));
    expect(AppUpdateService.getState()).toMatchObject({
      phase: "ready_to_install",
      blocking: true,
      progress: 1,
    });
  });

  it("solicita autorización en datos y permite posponer temporalmente", async () => {
    mockNetInfoFetch.mockResolvedValue({
      type: "cellular",
      isConnected: true,
      isInternetReachable: true,
    });

    await AppUpdateService.verificarActualizacion(true, "login");
    await flushPromises();

    expect(mockDownloadFile).not.toHaveBeenCalled();
    expect(AppUpdateService.getState()).toMatchObject({
      phase: "awaiting_data_consent",
      blocking: true,
      networkType: "cellular",
    });

    await AppUpdateService.posponerDatos();
    expect(AppUpdateService.getState()).toMatchObject({
      phase: "deferred",
      blocking: false,
    });
  });

  it("no bloquea la aplicación cuando no hay conectividad validada", async () => {
    mockNetInfoFetch.mockResolvedValue({
      type: "cellular",
      isConnected: false,
      isInternetReachable: false,
    });

    const result = await AppUpdateService.verificarActualizacion(true, "login");

    expect(result).toBeNull();
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    expect(AppUpdateService.getState()).toMatchObject({
      phase: "offline",
      blocking: false,
    });
  });
});
