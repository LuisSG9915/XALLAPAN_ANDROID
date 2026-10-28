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
  default: { fetch: jest.fn() },
}));

jest.mock("../services/GpsBitacoraService", () => ({
  __esModule: true,
  default: {
    registrarValidacion: jest.fn(),
  },
}));

import GpsBitacoraService from "../services/GpsBitacoraService";
import { registrarReubicacionFallida } from "../services/ReubicacionBitacora";

const registrarValidacion = GpsBitacoraService.registrarValidacion as jest.Mock;

const CLIENTE = { lat: 19.5409733, lng: -96.9287283 };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("bitácora de reubicaciones fallidas", () => {
  it("registra sin permiso sin lectura de GPS", async () => {
    await registrarReubicacionFallida("reubic_sin_permiso", {
      idCliente: 11558,
      clienteLatitud: CLIENTE.lat,
      clienteLongitud: CLIENTE.lng,
    });

    expect(registrarValidacion).toHaveBeenCalledTimes(1);
    expect(registrarValidacion).toHaveBeenCalledWith(
      expect.objectContaining({
        idCliente: 11558,
        motivo: "reubic_sin_permiso",
        valido: false,
        distancia: null,
        accuracy: null,
        latitud: null,
        longitud: null,
        clienteLatitud: CLIENTE.lat,
        clienteLongitud: CLIENTE.lng,
      }),
    );
  });

  it("registra precisión insuficiente con la distancia al cliente", async () => {
    await registrarReubicacionFallida("reubic_precision", {
      idCliente: 11558,
      clienteLatitud: CLIENTE.lat,
      clienteLongitud: CLIENTE.lng,
      // ~111 m al norte del cliente
      ubicacion: { latitude: CLIENTE.lat + 0.001, longitude: CLIENTE.lng, accuracy: 42 },
      diagnostico: { numFixes: 1, peorAccuracy: 68, tiempoMs: 6014 },
    });

    const payload = registrarValidacion.mock.calls[0][0];
    expect(payload.motivo).toBe("reubic_precision");
    expect(payload.accuracy).toBe(42);
    expect(payload.numFixes).toBe(1);
    expect(payload.peorAccuracy).toBe(68);
    expect(payload.tiempoMs).toBe(6014);
    expect(payload.distancia).toBeGreaterThan(110);
    expect(payload.distancia).toBeLessThan(112);
  });

  it("registra sin lectura con el diagnóstico del intento", async () => {
    await registrarReubicacionFallida("reubic_sin_gps", {
      idCliente: 11558,
      diagnostico: { numFixes: 0, peorAccuracy: 0, tiempoMs: 10000 },
    });

    expect(registrarValidacion).toHaveBeenCalledWith(
      expect.objectContaining({
        motivo: "reubic_sin_gps",
        numFixes: 0,
        tiempoMs: 10000,
        distancia: null,
        latitud: null,
        longitud: null,
      }),
    );
  });

  it("nunca lanza si la bitácora falla", async () => {
    registrarValidacion.mockRejectedValueOnce(new Error("realm cerrado"));

    await expect(
      registrarReubicacionFallida("reubic_error", { idCliente: 11558 }),
    ).resolves.toBeUndefined();
  });

  it("los cinco motivos caben en varchar(20) del servidor", () => {
    const motivos = [
      "reubic_sin_permiso",
      "reubic_sin_gps",
      "reubic_precision",
      "reubic_rechazo",
      "reubic_error",
    ];

    motivos.forEach((m) => expect(m.length).toBeLessThanOrEqual(20));
  });
});
