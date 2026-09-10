jest.mock("@notifee/react-native", () => ({
  __esModule: true,
  default: {
    createChannel: jest.fn(() => Promise.resolve("alertas-recorrido")),
    displayNotification: jest.fn(() => Promise.resolve()),
    cancelNotification: jest.fn(() => Promise.resolve()),
  },
  AndroidImportance: { HIGH: 4 },
}));

jest.mock("../services/LocationService", () => ({
  calcularDistancia: jest.fn((lat1: number, lng1: number, lat2: number, lng2: number) =>
    Math.sqrt((lat2 - lat1) ** 2 + (lng2 - lng1) ** 2) * 100000,
  ),
}));

import notifee from "@notifee/react-native";
import StallAlertService from "../services/StallAlertService";

const displayNotification = notifee.displayNotification as jest.Mock;

const point = (timestamp: number, latitud = 19.5, longitud = -96.9) => ({
  routeKey: "42-7-route",
  idUsuario: 42,
  nombreUsuario: "Vendedor de prueba",
  sucursal: 7,
  latitud,
  longitud,
  timestamp,
  metrosTolerancia: 30,
  segundosVarado: 1800,
});

describe("StallAlertService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    StallAlertService.reset();
  });

  it("notifica una sola vez al alcanzar el umbral de varado", async () => {
    await StallAlertService.evaluate(point(0));
    expect(await StallAlertService.evaluate(point(1_800_000))).toBe(true);
    expect(await StallAlertService.evaluate(point(3_600_000))).toBe(false);
    expect(displayNotification).toHaveBeenCalledTimes(1);
  });

  it("usa 30 minutos cuando el umbral no es válido", async () => {
    await StallAlertService.evaluate({ ...point(0), segundosVarado: null });
    expect(await StallAlertService.evaluate({ ...point(1_799_999), segundosVarado: null })).toBe(false);
    expect(await StallAlertService.evaluate({ ...point(1_800_000_000), segundosVarado: null })).toBe(true);
  });

  it("rearma la alerta cuando supera la tolerancia", async () => {
    await StallAlertService.evaluate(point(0));
    expect(await StallAlertService.evaluate(point(1_800_000))).toBe(true);
    expect(await StallAlertService.evaluate(point(1_800_100, 19.5004))).toBe(false);
    expect(await StallAlertService.evaluate(point(3_600_100, 19.5004))).toBe(true);
    expect(displayNotification).toHaveBeenCalledTimes(2);
  });
});
