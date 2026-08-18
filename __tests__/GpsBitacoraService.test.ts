jest.mock("react-native", () => ({
  __esModule: true,
  Platform: { OS: "android" },
}));

jest.mock("realm", () => ({
  __esModule: true,
  default: {},
  UpdateMode: { Modified: "modified" },
}));

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: {
    fetch: jest.fn(),
  },
}));

jest.mock("react-native-device-info", () => ({
  __esModule: true,
  default: {
    getVersion: jest.fn(() => "test"),
  },
}));

jest.mock("../services/AuthService", () => ({
  __esModule: true,
  default: {
    restoreSession: jest.fn(),
  },
}));

type TrackingRecord = {
  id: string;
  idUsuario: number;
  sucursal: number;
  latitud: number;
  longitud: number;
  precision: number;
  conCobertura: boolean;
  fecha: Date;
  enviado: boolean;
};

type XhrMock = {
  status: number;
  responseText: string;
  timeout: number;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  ontimeout: (() => void) | null;
  open: jest.Mock;
  setRequestHeader: jest.Mock;
  send: jest.Mock;
};

import GpsBitacoraService, {
  TRACKING_UPLOAD_INTERVAL_MS,
} from "../services/GpsBitacoraService";

const service = GpsBitacoraService as any;
let records: TrackingRecord[];
let xhrInstances: XhrMock[];
let realm: any;

const createXhr = (): XhrMock => {
  const xhr: XhrMock = {
    status: 0,
    responseText: "",
    timeout: 0,
    onload: null,
    onerror: null,
    onabort: null,
    ontimeout: null,
    open: jest.fn(),
    setRequestHeader: jest.fn(),
    send: jest.fn(),
  };
  xhrInstances.push(xhr);
  return xhr;
};

const createRealm = () => ({
  isClosed: false,
  objects: jest.fn((name: string) => {
    if (name !== "BitacoraTrackingGps") {
      throw new Error(`Colección inesperada: ${name}`);
    }

    return {
      filtered: jest.fn(() => ({
        get length() {
          return records.filter((record) => !record.enviado).length;
        },
        slice: (start: number, end: number) =>
          records.filter((record) => !record.enviado).slice(start, end),
      })),
    };
  }),
  write: jest.fn((callback: () => void) => callback()),
});

const createRecords = (): TrackingRecord[] => [
  {
    id: "4-100",
    idUsuario: 4,
    sucursal: 38,
    latitud: 19.55,
    longitud: -96.95,
    precision: 7,
    conCobertura: true,
    fecha: new Date("2026-08-15T12:00:00"),
    enviado: false,
  },
];

describe("GpsBitacoraService tracking native transport", () => {
  beforeEach(() => {
    records = createRecords();
    xhrInstances = [];
    realm = createRealm();
    service.setRealm(realm);
    service.enviandoTracking = false;
    service.lastTrackingUploadAttemptAt = 0;
    service.lastTrackingUploadIdentity = null;
    (globalThis as any).XMLHttpRequest = jest.fn(createXhr);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("marca el lote cuando el XHR responde 2xx", async () => {
    const request = service.enviarTrackingPendientes(38, 4);
    const xhr = xhrInstances[0];

    expect(xhr.timeout).toBe(20000);
    expect(xhr.open).toHaveBeenCalledWith(
      "POST",
      expect.stringContaining("sp_MovilesBitacoraTrackingGpsArrastreJSON")
    );

    xhr.status = 200;
    xhr.onload?.();
    await request;

    expect(records[0].enviado).toBe(true);
    expect(service.enviandoTracking).toBe(false);
  });

  it("omite nuevos pendientes antes de cumplir siete minutos", async () => {
    const firstRequest = service.enviarTrackingPendientes(38, 4);
    xhrInstances[0].status = 200;
    xhrInstances[0].onload?.();
    await firstRequest;

    records.push({ ...createRecords()[0], id: "4-101" });
    await service.enviarTrackingPendientes(38, 4);

    expect(xhrInstances).toHaveLength(1);
    expect(records[1].enviado).toBe(false);
  });

  it("libera el lock y conserva pendientes cuando ocurre timeout nativo", async () => {
    const request = service.enviarTrackingPendientes(38, 4);
    const xhr = xhrInstances[0];

    xhr.ontimeout?.();
    await request;

    expect(records[0].enviado).toBe(false);
    expect(service.enviandoTracking).toBe(false);
  });

  it("permite reintentar después de siete minutos y marcar el lote", async () => {
    jest.useFakeTimers();
    const firstRequest = service.enviarTrackingPendientes(38, 4);
    xhrInstances[0].ontimeout?.();
    await firstRequest;
    await jest.advanceTimersByTimeAsync(TRACKING_UPLOAD_INTERVAL_MS);

    const secondRequest = service.enviarTrackingPendientes(38, 4);
    expect(xhrInstances).toHaveLength(2);
    xhrInstances[1].status = 200;
    xhrInstances[1].onload?.();
    await secondRequest;

    expect(records[0].enviado).toBe(true);
  });

  it("deja pendientes las filas cuando el servidor responde HTTP 500", async () => {
    const request = service.enviarTrackingPendientes(38, 4);
    const xhr = xhrInstances[0];

    xhr.status = 500;
    xhr.onload?.();
    await request;

    expect(records[0].enviado).toBe(false);
    expect(service.enviandoTracking).toBe(false);
  });
});
