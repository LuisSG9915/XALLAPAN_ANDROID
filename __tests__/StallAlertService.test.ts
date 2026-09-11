jest.mock("../services/LocationService", () => ({
  calcularDistancia: jest.fn((lat1: number, lng1: number, lat2: number, lng2: number) =>
    Math.sqrt((lat2 - lat1) ** 2 + (lng2 - lng1) ** 2) * 100000,
  ),
}));

import StallAlertService from "../services/StallAlertService";

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
    StallAlertService.reset();
  });

  it("entra una sola vez al estado varado al alcanzar el umbral", async () => {
    expect((await StallAlertService.evaluate(point(0))).isStalled).toBe(false);
    expect((await StallAlertService.evaluate(point(1_800_000))).enteredStall).toBe(true);
    expect((await StallAlertService.evaluate(point(3_600_000))).enteredStall).toBe(false);
    expect((await StallAlertService.evaluate(point(3_600_000))).isStalled).toBe(true);
  });

  it("detecta varado con 200 segundos usando puntos GPS prácticamente iguales", async () => {
    const timestamps = [
      Date.parse("2026-09-10T10:37:43.000Z"),
      Date.parse("2026-09-10T10:38:56.000Z"),
      Date.parse("2026-09-10T10:39:58.000Z"),
      Date.parse("2026-09-10T10:41:00.000Z"),
      Date.parse("2026-09-10T10:42:02.000Z"),
      Date.parse("2026-09-10T10:43:03.000Z"),
    ];

    const results = [];
    for (const timestamp of timestamps) {
      results.push(await StallAlertService.evaluate({ ...point(timestamp), segundosVarado: 200 }));
    }

    expect(results[3].isStalled).toBe(false);
    expect(results[4].enteredStall).toBe(true);
    expect(results[5].isStalled).toBe(true);
  });

  it("usa 30 minutos cuando el umbral no es válido", async () => {
    await StallAlertService.evaluate({ ...point(0), segundosVarado: null });
    expect((await StallAlertService.evaluate({ ...point(1_799_999), segundosVarado: null })).isStalled).toBe(false);
    expect((await StallAlertService.evaluate({ ...point(1_800_000_000), segundosVarado: null })).enteredStall).toBe(true);
  });

  it("reporta recuperación y rearma la alerta cuando supera la tolerancia", async () => {
    await StallAlertService.evaluate(point(0));
    expect((await StallAlertService.evaluate(point(1_800_000))).enteredStall).toBe(true);
    expect((await StallAlertService.evaluate(point(1_800_100, 19.5004))).recovered).toBe(true);
    expect((await StallAlertService.evaluate(point(3_600_100, 19.5004))).enteredStall).toBe(true);
  });
});
