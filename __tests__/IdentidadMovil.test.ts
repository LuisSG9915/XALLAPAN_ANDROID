const mockGetBrand = jest.fn();
const mockGetModel = jest.fn();
const mockGetAndroidId = jest.fn();

jest.mock("react-native", () => ({
  __esModule: true,
  Platform: { OS: "android" },
}));

jest.mock("react-native-device-info", () => ({
  __esModule: true,
  default: {
    getBrand: () => mockGetBrand(),
    getModel: () => mockGetModel(),
    getAndroidId: () => mockGetAndroidId(),
  },
}));

import { Platform } from "react-native";
import { obtenerIdentidadMovil } from "../services/IdentidadMovil";

describe("obtenerIdentidadMovil", () => {
  beforeEach(() => {
    (Platform as any).OS = "android";
    mockGetBrand.mockReset().mockReturnValue("samsung");
    mockGetModel.mockReset().mockReturnValue("SM-A525F");
    mockGetAndroidId.mockReset().mockResolvedValue("A1B2C3D4E5F67890");
  });

  it("devuelve marca, modelo e id normalizados", async () => {
    const identidad = await obtenerIdentidadMovil();
    expect(identidad).toEqual({
      marcaMovil: "samsung",
      modeloMovil: "SM-A525F",
      idDispositivoMovil: "a1b2c3d4e5f67890", // minúsculas
    });
  });

  it("normaliza a null valores vacíos o 'unknown'", async () => {
    mockGetBrand.mockReturnValue("   ");
    mockGetModel.mockReturnValue("unknown");
    mockGetAndroidId.mockResolvedValue("  ");

    const identidad = await obtenerIdentidadMovil();
    expect(identidad).toEqual({
      marcaMovil: null,
      modeloMovil: null,
      idDispositivoMovil: null,
    });
  });

  it("trunca marca y modelo a 100 caracteres", async () => {
    mockGetBrand.mockReturnValue(` ${"b".repeat(150)} `);
    mockGetModel.mockReturnValue("m".repeat(120));

    const identidad = await obtenerIdentidadMovil();
    expect(identidad.marcaMovil).toHaveLength(100);
    expect(identidad.modeloMovil).toHaveLength(100);
    expect(identidad.idDispositivoMovil).toBe("a1b2c3d4e5f67890");
  });

  it.each([
    ["id demasiado largo", "a1b2c3d4e5f678901234"],
    ["id no hexadecimal", "zzzz1234"],
    ["MAC address", "AA:BB:CC:DD:EE:FF"],
    ["IMEI con separadores", "35-209900-176148-1"],
    ["serial alfanumérico", "RF8M31ZXY9K"],
    ["placeholder unknown", "unknown"],
  ])("rechaza %s como idDispositivoMovil", async (_descripcion, idInvalido) => {
    mockGetAndroidId.mockResolvedValue(idInvalido);

    const identidad = await obtenerIdentidadMovil();
    expect(identidad.idDispositivoMovil).toBeNull();
    expect(identidad.marcaMovil).toBe("samsung");
    expect(identidad.modeloMovil).toBe("SM-A525F");
  });

  it("acepta un id hexadecimal de longitud mínima", async () => {
    mockGetAndroidId.mockResolvedValue("f");

    const identidad = await obtenerIdentidadMovil();
    expect(identidad.idDispositivoMovil).toBe("f");
  });

  it("en plataforma no Android omite la lectura del id", async () => {
    (Platform as any).OS = "ios";

    const identidad = await obtenerIdentidadMovil();
    expect(mockGetAndroidId).not.toHaveBeenCalled();
    expect(identidad.idDispositivoMovil).toBeNull();
    expect(identidad.marcaMovil).toBe("samsung");
    expect(identidad.modeloMovil).toBe("SM-A525F");
  });

  it("un fallo en la marca no impide leer modelo e id", async () => {
    mockGetBrand.mockImplementation(() => {
      throw new Error("lector roto");
    });

    const identidad = await obtenerIdentidadMovil();
    expect(identidad).toEqual({
      marcaMovil: null,
      modeloMovil: "SM-A525F",
      idDispositivoMovil: "a1b2c3d4e5f67890",
    });
  });

  it("un fallo en getAndroidId no impide leer marca y modelo", async () => {
    mockGetAndroidId.mockRejectedValue(new Error("sin permiso"));

    const identidad = await obtenerIdentidadMovil();
    expect(identidad).toEqual({
      marcaMovil: "samsung",
      modeloMovil: "SM-A525F",
      idDispositivoMovil: null,
    });
  });

  it("nunca lanza aunque todos los lectores fallen", async () => {
    mockGetBrand.mockImplementation(() => {
      throw new Error("boom");
    });
    mockGetModel.mockImplementation(() => {
      throw new Error("boom");
    });
    mockGetAndroidId.mockRejectedValue(new Error("boom"));

    await expect(obtenerIdentidadMovil()).resolves.toEqual({
      marcaMovil: null,
      modeloMovil: null,
      idDispositivoMovil: null,
    });
  });
});
