const mockStorage = new Map<string, string>();
const mockRealm = { isClosed: false };
const mockPedidosService = {
  setRealm: jest.fn(),
  getPedidoByFolio: jest.fn(),
  syncPedidos: jest.fn(),
  iniciarAtencionPedido: jest.fn(),
  actualizarPedidosDesdeRespuesta: jest.fn(),
  cambiarEstatusPedido: jest.fn(),
};

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

jest.mock("@notifee/react-native", () => ({
  __esModule: true,
  default: {
    createChannel: jest.fn().mockResolvedValue("pedidos-central"),
    displayNotification: jest.fn().mockResolvedValue(undefined),
  },
  AndroidImportance: { HIGH: 4 },
  EventType: { PRESS: 1, ACTION_PRESS: 2 },
}));

jest.mock("realm", () => ({
  __esModule: true,
  default: { UpdateMode: { Modified: "modified" } },
}));

jest.mock("../services/navigationRef", () => ({
  navigationRef: {
    isReady: jest.fn(),
    getCurrentRoute: jest.fn(),
    navigate: jest.fn(),
  },
}));

jest.mock("../services/PedidosService", () => ({
  __esModule: true,
  default: { getInstance: jest.fn(() => mockPedidosService) },
  ESTATUS_PEDIDO: {
    PROGRAMADO: 1,
    ENTREGADO: 2,
    CONFIRMADO: 3,
    NOTIFICADO: 4,
    EN_ATENCION: 5,
    ENTREGADO_PARCIAL: 6,
    PENDIENTE_CON_CAUSA: 7,
    PENDIENTE_SIN_CAUSA: 8,
    CANCELADO: 9,
    EN_CAPTURA: 10,
  },
}));

jest.mock("../services/AuthService", () => ({
  __esModule: true,
  default: {
    restoreSession: jest.fn(() => Promise.resolve({ id: 8, ruta: 3 })),
  },
}));

jest.mock("../services/FullSyncService", () => ({
  __esModule: true,
  default: { realm: mockRealm },
}));

jest.mock("../services/fetchWithTimeout", () => ({
  fetchWithTimeout: jest.fn(),
}));

import AsyncStorage from "@react-native-async-storage/async-storage";
import notifee from "@notifee/react-native";
import PedidoNotificacionService from "../services/PedidoNotificacionService";
import { fetchWithTimeout } from "../services/fetchWithTimeout";
import { navigationRef } from "../services/navigationRef";

const PENDING_NAVIGATION_KEY = "@xallapan/pedido_pendiente_navegacion";

const servicio = PedidoNotificacionService as any;
const navegacion = navigationRef as any;

describe("PedidoNotificacionService polling", () => {
  beforeEach(() => {
    mockStorage.clear();
    jest.clearAllMocks();
    const pedido = {
      folio: 110,
      cliente: 6606,
      ruta: 38,
      idVendedor: 8,
      idProducto: 26,
      numeroProductos: 1,
      cantPedido: 1,
      estatus: 3,
      syncedAt: new Date(),
    };
    const realm = {
      isClosed: false,
      objects: jest.fn(() => ({ filtered: jest.fn(() => [pedido]) })),
      objectForPrimaryKey: jest.fn(() => null),
      write: jest.fn((callback: () => void) => callback()),
      create: jest.fn(),
    };
    servicio.setRealm(realm);
    mockPedidosService.getPedidoByFolio.mockReturnValue(pedido);
    (fetchWithTimeout as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      text: jest.fn().mockResolvedValue(JSON.stringify([pedido])),
    });
  });

  it("notifica pedidos confirmados recibidos en el primer sondeo", async () => {
    await expect(servicio.verificarPedidosNuevos(38)).resolves.toBe(1);

    expect(notifee.displayNotification).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pedido-110", title: "Nuevo pedido de Central" }),
    );
    expect(mockPedidosService.cambiarEstatusPedido).toHaveBeenCalledWith(110, 4);
    expect(JSON.parse(mockStorage.get("@xallapan/pedidos_poll_state:38") || "{}")).toMatchObject({
      initialized: true,
      knownFolios: [110],
    });
  });

  it("notifica pedidos de la ruta asignados a otro vendedor", async () => {
    await expect(
      servicio.mostrarNotificacionPedido({
        folio: 124,
        cliente: 456,
        ruta: 38,
        idVendedor: 2142,
        numeroProductos: 1,
        estatus: 3,
      }),
    ).resolves.toBe(true);
  });
});

describe("PedidoNotificacionService navegación pendiente", () => {
  beforeEach(() => {
    mockStorage.clear();
    jest.clearAllMocks();
    servicio.setRealm(mockRealm);
    mockPedidosService.getPedidoByFolio.mockReturnValue({
      folio: 123,
      cliente: 456,
      ruta: 3,
      idVendedor: 8,
      estatus: 4,
    });
    navegacion.isReady.mockReturnValue(true);
    navegacion.getCurrentRoute.mockReturnValue({ name: "Pedidos" });
    mockStorage.set(PENDING_NAVIGATION_KEY, JSON.stringify({ folio: "123", ruta: "3" }));
  });

  it("abre el detalle sin iniciar la atención automáticamente", async () => {
    await expect(servicio.procesarNavegacionPendiente()).resolves.toBe(true);

    expect(mockPedidosService.iniciarAtencionPedido).not.toHaveBeenCalled();
    expect(navegacion.navigate).toHaveBeenCalledWith("PedidoDetalle", {
      folio: 123,
      soloLectura: false,
    });
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(PENDING_NAVIGATION_KEY);
  });
});
