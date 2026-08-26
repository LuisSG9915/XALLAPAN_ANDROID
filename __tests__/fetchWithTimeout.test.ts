jest.mock("../services/NetworkUsageService", () => ({
  __esModule: true,
  default: {
    recordRequest: jest.fn(() => "request-1"),
    recordResponseBody: jest.fn(),
  },
  normalizeEndpoint: jest.fn((url: string) =>
    url.split("?", 1)[0].replace(/\/\d+(?=\/|$)/g, "/:id"),
  ),
}));

import { fetchWithTimeout } from "../services/fetchWithTimeout";

const networkUsageMock = jest.requireMock("../services/NetworkUsageService").default;

const createResponse = (body: string, headers: Record<string, string> = {}) => ({
  ok: true,
  status: 200,
  headers: new Headers({ "content-type": "application/json", ...headers }),
  text: jest.fn(() => Promise.resolve(body)),
});

describe("fetchWithTimeout response tracking", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("mide el cuerpo cuando Content-Length no está disponible y quita BOM JSON", async () => {
    const response = createResponse('\ufeff{"ok":true}');
    globalThis.fetch = jest.fn(() => Promise.resolve(response as unknown as Response));

    const result = await fetchWithTimeout("https://api.example.com/api/test/38");
    await expect(result.json()).resolves.toEqual({ ok: true });

    expect(networkUsageMock.recordRequest).toHaveBeenCalledWith(
      expect.objectContaining({ bytesReceived: 0, success: true }),
    );
    expect(networkUsageMock.recordResponseBody).toHaveBeenCalledWith("request-1", 14);
  });

  it("devuelve diagnóstico seguro cuando la respuesta no es JSON", async () => {
    const response = createResponse("<!doctype html>", { "content-type": "text/html" });
    globalThis.fetch = jest.fn(() => Promise.resolve(response as unknown as Response));

    const result = await fetchWithTimeout("https://api.example.com/api/test/38?usuario=42");
    await expect(result.json()).rejects.toThrow(
      "Respuesta JSON inválida en https://api.example.com/api/test/:id",
    );
  });
});
