type NetworkStateType =
  | "wifi"
  | "cellular"
  | "ethernet"
  | "bluetooth"
  | "vpn"
  | "wimax"
  | "other"
  | "none"
  | "unknown";

type AsyncStorageLike = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

type NetInfoLike = {
  fetch: () => Promise<{ type: NetworkStateType } | null>;
};

const getAsyncStorage = (): AsyncStorageLike | null => {
  try {
    const module = require("@react-native-async-storage/async-storage");
    return module.default || module;
  } catch {
    return null;
  }
};

const getNetInfo = (): NetInfoLike | null => {
  try {
    const module = require("@react-native-community/netinfo");
    return module.default || module;
  } catch {
    return null;
  }
};

const STORAGE_KEY = "@xallapan/network_usage_v1";
const DETAIL_RETENTION_DAYS = 7;
const DAILY_RETENTION_DAYS = 30;
const NETWORK_CACHE_MS = 60_000;
const MAX_ENDPOINTS_PER_DAY = 250;

export type NetworkConnectionType = "wifi" | "cellular" | "ethernet" | "other" | "unknown";

export type NetworkRequestEvent = {
  url: string;
  method?: string;
  status?: number;
  bytesReceived?: number;
  bytesSent?: number;
  durationMs?: number;
  success?: boolean;
  timedOut?: boolean;
};

export type NetworkUsageAggregate = {
  endpoint: string;
  method: string;
  networkType: NetworkConnectionType;
  requests: number;
  successful: number;
  failed: number;
  timeouts: number;
  bytesReceived: number;
  bodyBytesMeasured: number;
  bytesSent: number;
  durationMs: number;
  lastStatus: number;
  lastAt: string;
};

export type NetworkUsageSnapshot = {
  day: string;
  total: NetworkUsageAggregate;
  endpoints: NetworkUsageAggregate[];
  lastUpdatedAt: string | null;
};

type StoredUsage = {
  daily: Record<string, NetworkUsageAggregate>;
  endpoints: Record<string, Record<string, NetworkUsageAggregate>>;
  lastUpdatedAt: string | null;
};

type SnapshotListener = (snapshot: NetworkUsageSnapshot) => void;

type PendingRequest = {
  day: string;
  key: string;
  declaredBytes: number;
  bodyMeasured: boolean;
};

const EMPTY_TOTAL = (day: string): NetworkUsageAggregate => ({
  endpoint: "TOTAL",
  method: "*",
  networkType: "unknown",
  requests: 0,
  successful: 0,
  failed: 0,
  timeouts: 0,
  bytesReceived: 0,
  bodyBytesMeasured: 0,
  bytesSent: 0,
  durationMs: 0,
  lastStatus: 0,
  lastAt: day,
});

const isFinitePositive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const getDayKey = (date = new Date()): string => {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const getOldestDayKey = (daysToKeep: number): string => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - (daysToKeep - 1));
  return getDayKey(date);
};

export const normalizeEndpoint = (url: string): string => {
  const withoutQuery = url.split(/[?#]/, 1)[0];
  const match = withoutQuery.match(/^(?:[a-z][a-z\d+.-]*:\/\/)?([^/]+)(\/.*)?$/i);
  if (!match) return withoutQuery.replace(/\/\d+(?=\/|$)/g, "/:id");

  const host = match[1];
  const path = (match[2] || "/")
    .replace(/\/\d+(?=\/|$)/g, "/:id")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id");
  return `${host}${path}`;
};

const getNetworkType = (type: NetworkStateType): NetworkConnectionType => {
  switch (type) {
    case "wifi":
      return "wifi";
    case "cellular":
      return "cellular";
    case "ethernet":
      return "ethernet";
    case "bluetooth":
    case "vpn":
    case "wimax":
    case "none":
    case "unknown":
    default:
      return type === "unknown" ? "unknown" : "other";
  }
};

class NetworkUsageService {
  private data: StoredUsage = { daily: {}, endpoints: {}, lastUpdatedAt: null };
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<SnapshotListener>();
  private networkType: NetworkConnectionType = "unknown";
  private networkCheckedAt = 0;
  private networkTypePromise: Promise<NetworkConnectionType> | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private pendingBodyBytes = new Map<string, number>();
  private requestSequence = 0;
  private enabled = false;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const storage = getAsyncStorage();
    if (!storage) {
      this.loaded = true;
      return;
    }
    if (!this.loadPromise) {
      this.loadPromise = storage.getItem(STORAGE_KEY)
        .then((stored) => {
          if (stored) {
            try {
              const parsed = JSON.parse(stored);
              this.data = {
                daily: parsed?.daily && typeof parsed.daily === "object" ? parsed.daily : {},
                endpoints:
                  parsed?.endpoints && typeof parsed.endpoints === "object"
                    ? parsed.endpoints
                    : {},
                lastUpdatedAt: typeof parsed?.lastUpdatedAt === "string" ? parsed.lastUpdatedAt : null,
              };
            } catch {
              this.data = { daily: {}, endpoints: {}, lastUpdatedAt: null };
            }
          }
          this.prune();
          this.loaded = true;
        })
        .catch(() => {
          this.loaded = true;
        })
        .finally(() => {
          this.loadPromise = null;
        });
    }
    await this.loadPromise;
  }

  private prune(): void {
    const detailCutoff = getOldestDayKey(DETAIL_RETENTION_DAYS);
    const dailyCutoff = getOldestDayKey(DAILY_RETENTION_DAYS);

    Object.keys(this.data.endpoints).forEach((day) => {
      if (day < detailCutoff) delete this.data.endpoints[day];
    });
    Object.keys(this.data.daily).forEach((day) => {
      if (day < dailyCutoff) delete this.data.daily[day];
    });
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    const storage = getAsyncStorage();
    if (!storage) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void storage.setItem(STORAGE_KEY, JSON.stringify(this.data)).catch(() => undefined);
    }, 1500);
  }

  private async getCurrentNetworkType(): Promise<NetworkConnectionType> {
    const now = Date.now();
    if (this.networkTypePromise) return this.networkTypePromise;
    if (now - this.networkCheckedAt < NETWORK_CACHE_MS) return this.networkType;

    this.networkCheckedAt = now;
    const netInfo = getNetInfo();
    if (!netInfo) {
      this.networkType = "unknown";
      return this.networkType;
    }
    this.networkTypePromise = Promise.resolve()
      .then(() => netInfo.fetch())
      .catch(() => null)
      .then((state) => {
        this.networkType = state ? getNetworkType(state.type) : "unknown";
        return this.networkType;
      })
      .finally(() => {
        this.networkTypePromise = null;
      });
    return this.networkTypePromise;
  }

  private notify(): void {
    void this.getTodaySnapshot().then((snapshot) => {
      this.listeners.forEach((listener) => {
        try {
          listener(snapshot);
        } catch {
          // Un listener no debe interrumpir el registro de métricas.
        }
      });
    });
  }

  recordRequest(event: NetworkRequestEvent): string {
    if (!this.enabled) return "";
    const requestId = `${Date.now()}-${++this.requestSequence}`;
    void this.recordRequestAsync(event, requestId).catch(() => undefined);
    return requestId;
  }

  recordResponseBody(requestId: string, bytesReceived: number): void {
    if (!this.enabled || !requestId || !isFinitePositive(bytesReceived)) return;
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      this.pendingBodyBytes.set(requestId, bytesReceived);
      return;
    }
    this.applyBodyMeasurement(pending, bytesReceived);
  }

  private async recordRequestAsync(event: NetworkRequestEvent, requestId: string): Promise<void> {
    await this.ensureLoaded();

    const day = getDayKey();
    const endpoint = normalizeEndpoint(event.url);
    const method = String(event.method || "GET").toUpperCase();
    const networkType = await this.getCurrentNetworkType();
    const key = `${method}\u0000${endpoint}\u0000${networkType}`;
    const now = new Date().toISOString();
    const status = Number.isFinite(event.status) ? Number(event.status) : 0;
    const success = event.success === true;
    const bytesReceived = isFinitePositive(event.bytesReceived) ? event.bytesReceived : 0;
    const bytesSent = isFinitePositive(event.bytesSent) ? event.bytesSent : 0;
    const durationMs = isFinitePositive(event.durationMs) ? event.durationMs : 0;

    const current = this.data.endpoints[day]?.[key] || {
      endpoint,
      method,
      networkType,
      requests: 0,
      successful: 0,
      failed: 0,
      timeouts: 0,
      bytesReceived: 0,
      bodyBytesMeasured: 0,
      bytesSent: 0,
      durationMs: 0,
      lastStatus: 0,
      lastAt: now,
    };
    const updated = {
      ...current,
      requests: current.requests + 1,
      successful: current.successful + (success ? 1 : 0),
      failed: current.failed + (success ? 0 : 1),
      timeouts: current.timeouts + (event.timedOut ? 1 : 0),
      bytesReceived: current.bytesReceived + bytesReceived,
      bodyBytesMeasured: (current.bodyBytesMeasured || 0),
      bytesSent: current.bytesSent + bytesSent,
      durationMs: current.durationMs + durationMs,
      lastStatus: status,
      lastAt: now,
    };

    if (!this.data.endpoints[day]) this.data.endpoints[day] = {};
    this.data.endpoints[day][key] = updated;

    const total = this.data.daily[day] || EMPTY_TOTAL(day);
    this.data.daily[day] = {
      ...total,
      requests: total.requests + 1,
      successful: total.successful + (success ? 1 : 0),
      failed: total.failed + (success ? 0 : 1),
      timeouts: total.timeouts + (event.timedOut ? 1 : 0),
      bytesReceived: total.bytesReceived + bytesReceived,
      bodyBytesMeasured: total.bodyBytesMeasured || 0,
      bytesSent: total.bytesSent + bytesSent,
      durationMs: total.durationMs + durationMs,
      lastStatus: status,
      lastAt: now,
    };

    const pending: PendingRequest = {
      day,
      key,
      declaredBytes: bytesReceived,
      bodyMeasured: false,
    };
    this.pendingRequests.set(requestId, pending);
    if (this.pendingRequests.size > 1000) {
      const oldestRequestId = this.pendingRequests.keys().next().value;
      if (oldestRequestId) this.pendingRequests.delete(oldestRequestId);
    }
    const bodyBytes = this.pendingBodyBytes.get(requestId);
    if (bodyBytes !== undefined) {
      this.pendingBodyBytes.delete(requestId);
      this.applyBodyMeasurement(pending, bodyBytes);
    }

    this.pruneEndpointLimit(day);
    this.data.lastUpdatedAt = now;
    this.schedulePersist();
    this.notify();
  }

  private applyBodyMeasurement(pending: PendingRequest, bytesReceived: number): void {
    if (pending.bodyMeasured) return;
    pending.bodyMeasured = true;

    const endpoint = this.data.endpoints[pending.day]?.[pending.key];
    const total = this.data.daily[pending.day];
    if (!endpoint || !total) return;

    endpoint.bodyBytesMeasured = (endpoint.bodyBytesMeasured || 0) + bytesReceived;
    if (pending.declaredBytes === 0) endpoint.bytesReceived += bytesReceived;
    total.bodyBytesMeasured = (total.bodyBytesMeasured || 0) + bytesReceived;
    if (pending.declaredBytes === 0) total.bytesReceived += bytesReceived;

    this.data.lastUpdatedAt = new Date().toISOString();
    this.schedulePersist();
    this.notify();
  }

  private pruneEndpointLimit(day: string): void {
    const entries = Object.entries(this.data.endpoints[day] || {});
    if (entries.length <= MAX_ENDPOINTS_PER_DAY) return;
    entries
      .sort(([, a], [, b]) => b.bytesReceived - a.bytesReceived)
      .slice(MAX_ENDPOINTS_PER_DAY)
      .forEach(([key]) => delete this.data.endpoints[day][key]);
  }

  async getTodaySnapshot(): Promise<NetworkUsageSnapshot> {
    await this.ensureLoaded();
    const day = getDayKey();
    const endpoints = Object.values(this.data.endpoints[day] || {}).sort(
      (a, b) => b.bytesReceived - a.bytesReceived,
    );
    return {
      day,
      total: this.data.daily[day] || EMPTY_TOTAL(day),
      endpoints,
      lastUpdatedAt: this.data.lastUpdatedAt,
    };
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    void this.getTodaySnapshot().then(listener);
    return () => this.listeners.delete(listener);
  }

  async clear(): Promise<void> {
    await this.ensureLoaded();
    this.data = { daily: {}, endpoints: {}, lastUpdatedAt: null };
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const storage = getAsyncStorage();
    if (storage) await storage.removeItem(STORAGE_KEY);
    this.notify();
  }
}

export default new NetworkUsageService();
