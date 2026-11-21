const mockGetBrand = jest.fn();
const mockGetModel = jest.fn();
const mockGetAndroidId = jest.fn();
const mockFetchWithTimeout = jest.fn();

jest.mock("react-native", () => ({
  __esModule: true,
  Platform: { OS: "android" },
}));

jest.mock("realm", () => ({
  __esModule: true,
  default: {},
  UpdateMode: { Modified: "modified" },
}));

jest.mock("react-native-device-info", () => ({
  __esModule: true,
  default: {
    getVersion: jest.fn(() => "test"),
    getBrand: () => mockGetBrand(),
    getModel: () => mockGetModel(),
    getAndroidId: () => mockGetAndroidId(),
  },
}));

jest.mock("../services/AuthService", () => ({
  __esModule: true,
  default: {
    restoreSession: jest.fn(),
  },
}));

jest.mock("../services/fetchWithTimeout", () => ({
  __esModule: true,
  fetchWithTimeout: (input: unknown, init: unknown) => mockFetchWithTimeout(input, init),
}));

import BitacoraService from "../services/BitacoraService";

const service = BitacoraService as any;

type BitacoraRow = Record<string, unknown>;

const createRealm = (pendientes: BitacoraRow[]) => ({
  isClosed: false,
  objects: jest.fn(() => ({
    filtered: jest.fn((predicate: string) => {
      if (predicate.includes("enviado == false")) return pendientes;
      return { length: 0 };
    }),
  })),
  write: jest.fn((callback: () => void) => callback()),
  delete: jest.fn(),
});

const createPendiente = (overrides: BitacoraRow = {}): BitacoraRow => ({
  idBitacoraMovil: "1700000000-abc-ClientesFull",
  tabla: "ClientesFull",
  fechaInicio: new Date("2026-08-15T12:00:00"),
  duracionMs: 250,
  idUsuario: 8,
  versionApp: "9.9.9", // versión guardada en el log, distinta a la de DeviceInfo ("test")
  endpoint: "/api/x",
  registrosLeidos: 10,
  exitoso: true,
  codigoError: null,
  descripcionError: null,
  stackTrace: null,
  enviado: false,
  ...overrides,
});

describe("BitacoraService enviarBitacorasPendientes", () => {
  beforeEach(() => {
    mockGetBrand.mockReset().mockReturnValue("motorola");
    mockGetModel.mockReset().mockReturnValue("moto g84");
    mockGetAndroidId.mockReset().mockResolvedValue("A1B2C3D4E5F67890");
    mockFetchWithTimeout.mockReset().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "OK",
    });
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    (console.log as jest.Mock).mockRestore();
    (console.warn as jest.Mock).mockRestore();
    (console.error as jest.Mock).mockRestore();
  });

  it("adjunta los metadatos del móvil en cada fila y conserva versionApp del log", async () => {
    const pendientes = [createPendiente(), createPendiente({ idBitacoraMovil: "otra-fila" })];
    const realm = createRealm(pendientes);
    service.setRealm(realm);

    await service.enviarBitacorasPendientes(38, 4);

    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetchWithTimeout.mock.calls[0];
    expect(String(url)).toContain("sp_BitacoraSyncOptimizadoArrastreJSON");
    expect(String(url)).toContain("sucursal=38");
    expect(String(url)).toContain("idUsuario=4");

    const payload = JSON.parse(String((init as RequestInit).body));
    expect(payload).toHaveLength(2);
    payload.forEach((fila: any) => {
      expect(fila.marcaMovil).toBe("motorola");
      expect(fila.modeloMovil).toBe("moto g84");
      expect(fila.idDispositivoMovil).toBe("a1b2c3d4e5f67890");
      expect(fila.versionApp).toBe("9.9.9"); // se conserva la versión guardada, no la actual
    });

    // La identidad se lee una sola vez por envío aunque haya varias filas
    expect(mockGetAndroidId).toHaveBeenCalledTimes(1);
  });

  it("no envía nada ni lee la identidad cuando no hay pendientes", async () => {
    const realm = createRealm([]);
    service.setRealm(realm);

    await service.enviarBitacorasPendientes(38, 4);

    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    expect(mockGetAndroidId).not.toHaveBeenCalled();
  });

  it("sigue enviando con metadatos en null cuando la lectura del dispositivo falla", async () => {
    mockGetBrand.mockImplementation(() => {
      throw new Error("sin lector");
    });
    mockGetModel.mockImplementation(() => {
      throw new Error("sin lector");
    });
    mockGetAndroidId.mockRejectedValue(new Error("sin id"));

    const pendientes = [createPendiente()];
    const realm = createRealm(pendientes);
    service.setRealm(realm);

    await service.enviarBitacorasPendientes(38, 4);

    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    const [, init] = mockFetchWithTimeout.mock.calls[0];
    const [fila] = JSON.parse(String((init as RequestInit).body));
    expect(fila.marcaMovil).toBeNull();
    expect(fila.modeloMovil).toBeNull();
    expect(fila.idDispositivoMovil).toBeNull();
    expect(fila.versionApp).toBe("9.9.9");
  });
});
