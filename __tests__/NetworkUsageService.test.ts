const mockStorage = new Map<string, string>();

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn((key: string) => Promise.resolve(mockStorage.get(key) ?? null)),
    setItem: jest.fn((key: string, value: string) => {
      mockStorage.set(key, value);
      return Promise.resolve();
    }),
    removeItem: jest.fn((key: string) => {
      mockStorage.delete(key);
      return Promise.resolve();
    }),
  },
}));

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: {
    fetch: jest.fn(() => Promise.resolve({ type: "wifi" })),
  },
}));

import NetworkUsageService, { normalizeEndpoint } from "../services/NetworkUsageService";

const flushPromises = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
};

describe("NetworkUsageService", () => {
  beforeEach(async () => {
    NetworkUsageService.setEnabled(true);
    await NetworkUsageService.clear();
    jest.clearAllMocks();
  });

  it("agrupa solicitudes por endpoint sin conservar query parameters", async () => {
    expect(normalizeEndpoint("https://api.example.com/api/clientes/38?usuario=42")).toBe(
      "api.example.com/api/clientes/:id",
    );

    const firstRequestId = NetworkUsageService.recordRequest({
      url: "https://api.example.com/api/clientes/38?usuario=42",
      method: "get",
      status: 200,
      bytesReceived: 1024,
      bytesSent: 32,
      durationMs: 100,
      success: true,
    });
    NetworkUsageService.recordResponseBody(firstRequestId, 4096);

    const secondRequestId = NetworkUsageService.recordRequest({
      url: "https://api.example.com/api/clientes/39?usuario=42",
      method: "GET",
      status: 500,
      bytesReceived: 0,
      durationMs: 200,
      success: false,
    });
    NetworkUsageService.recordResponseBody(secondRequestId, 2048);

    await flushPromises();
    const snapshot = await NetworkUsageService.getTodaySnapshot();

    expect(snapshot.total.requests).toBe(2);
    expect(snapshot.total.successful).toBe(1);
    expect(snapshot.total.failed).toBe(1);
    expect(snapshot.total.bytesReceived).toBe(3072);
    expect(snapshot.total.bodyBytesMeasured).toBe(6144);
    expect(snapshot.total.bytesSent).toBe(32);
    expect(snapshot.endpoints).toHaveLength(1);
    expect(snapshot.endpoints[0]).toMatchObject({
      endpoint: "api.example.com/api/clientes/:id",
      method: "GET",
      networkType: "wifi",
      requests: 2,
      bytesReceived: 3072,
      bodyBytesMeasured: 6144,
    });

    await NetworkUsageService.clear();
  });
});
