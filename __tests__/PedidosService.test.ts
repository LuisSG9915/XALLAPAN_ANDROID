jest.mock("realm", () => ({
  __esModule: true,
  default: {
    UpdateMode: { Modified: "modified" },
  },
}));

jest.mock("../services/AuthService", () => ({
  __esModule: true,
  default: {
    currentUser: null,
    restoreSession: jest.fn().mockResolvedValue({ id: 8 }),
  },
}));

jest.mock("../services/PedidoNotificacionService", () => ({
  __esModule: true,
  default: {
    setRealm: jest.fn(),
    procesarPedidosSincronizados: jest.fn(),
  },
}));

const mockPedidoBitacoraExecute = jest.fn();

jest.mock("../services/sync/SyncTask", () => ({
  SyncTask: class {
    realm: any;
    syncLogId: string;

    constructor(realm: any, syncLogId: string) {
      this.realm = realm;
      this.syncLogId = syncLogId;
    }
  },
}));

jest.mock("../services/sync/tasks/PedidoBitacoraUploadSyncTask", () => ({
  __esModule: true,
  PedidoBitacoraUploadSyncTask: class {
    execute = mockPedidoBitacoraExecute;
  },
  PedidoEstadoUploadSyncTask: class {
    execute = jest.fn().mockResolvedValue({ success: true });
  },
}));

import PedidosService, {
  ESTATUS_PEDIDO,
  getEstatusDescripcionPedido,
  esEstatusFinalPedido,
  esProductoAgregado,
  PRODUCTO_AGREGADO_OBSERVACION,
} from "../services/PedidosService";
import { normalizarObservaciones } from "../services/pedidoObservaciones";

const crearPedido = (overrides: Record<string, unknown> = {}) => ({
  id: "42-7",
  idPedido: 42,
  folio: 42,
  fecha: new Date(),
  ruta: 3,
  cliente: 10,
  clienteNombre: "Cliente prueba",
  clienteDomicilio: "Domicilio prueba",
  idVendedor: 8,
  numeroProductos: 1,
  cantPedido: 2,
  listaPrecio: 13,
  fechaEntrega: new Date(),
  estatus: ESTATUS_PEDIDO.EN_CAPTURA,
  estatusDescripcion: "EN CAPTURA",
  observaciones: "Entregar por la tarde",
  syncedAt: new Date(),
  idProducto: 7,
  productoNombre: "Producto original",
  cantAtencion: 2,
  precio: 10,
  precioAtencion: 10,
  ...overrides,
});

const crearRealmMock = (pedido: any | any[] = crearPedido()) => {
  const pedidos = (Array.isArray(pedido) ? pedido : [pedido]) as any[];
  const created: any[] = [];
  const realm = {
    isClosed: false,
    objects: jest.fn((schema: string) => ({
      filtered: jest.fn(() => (schema === "Pedido" ? pedidos : [])),
    })),
    objectForPrimaryKey: jest.fn((schema: string, id: string) => {
      if (schema === "Pedido") return pedidos.find((item) => item.id === id) || null;
      return null;
    }),
    write: jest.fn((callback: () => void) => callback()),
    create: jest.fn((_schema: string, value: any) => {
      created.push(value);
      pedidos.push(value);
      return value;
    }),
  };

  return { realm, pedidos, created };
};

describe("reglas de pedidos", () => {
  it("resuelve la descripción por código y no por una descripción desactualizada", () => {
    expect(getEstatusDescripcionPedido(ESTATUS_PEDIDO.PENDIENTE_CON_CAUSA)).toBe("PENDIENTE CON CAUSA");
    expect(getEstatusDescripcionPedido(ESTATUS_PEDIDO.PENDIENTE_SIN_CAUSA)).toBe("PENDIENTE SIN CAUSA");
  });

  it("considera cerrados solo los pedidos entregados o cancelados", () => {
    expect(esEstatusFinalPedido(ESTATUS_PEDIDO.ENTREGADO)).toBe(true);
    expect(esEstatusFinalPedido(ESTATUS_PEDIDO.ENTREGADO_PARCIAL)).toBe(true);
    expect(esEstatusFinalPedido(ESTATUS_PEDIDO.PENDIENTE_CON_CAUSA)).toBe(false);
    expect(esEstatusFinalPedido(ESTATUS_PEDIDO.CANCELADO)).toBe(true);
    expect(esEstatusFinalPedido(ESTATUS_PEDIDO.EN_ATENCION)).toBe(false);
  });

  it("permite retomar la atención de un pedido pendiente con causa", () => {
    const pedido = crearPedido({ estatus: ESTATUS_PEDIDO.PENDIENTE_CON_CAUSA });
    const { realm } = crearRealmMock(pedido);
    const service = PedidosService.getInstance();
    service.setRealm(realm as any);

    expect(service.iniciarAtencionPedido(pedido.folio)).toBe(true);
    expect(pedido.estatus).toBe(ESTATUS_PEDIDO.EN_ATENCION);
  });

  it("identifica la observación de un producto agregado", () => {
    expect(esProductoAgregado({ observaciones: `Nota ${PRODUCTO_AGREGADO_OBSERVACION}` })).toBe(true);
    expect(esProductoAgregado({ observaciones: "Nota normal" })).toBe(false);
  });

  it("trata el punto de central como observación vacía", () => {
    expect(normalizarObservaciones(".")).toBeNull();
    expect(normalizarObservaciones(" . ")).toBeNull();
    expect(normalizarObservaciones("")).toBeNull();
    expect(normalizarObservaciones("   ")).toBeNull();
    expect(normalizarObservaciones(null)).toBeNull();
    expect(normalizarObservaciones(undefined)).toBeNull();
    expect(normalizarObservaciones("Entregar por la tarde")).toBe("Entregar por la tarde");
    expect(normalizarObservaciones("  Nota con espacios  ")).toBe("Nota con espacios");
  });
});

describe("envío inmediato de bitácora al cerrar pedidos", () => {
  beforeEach(() => {
    mockPedidoBitacoraExecute.mockReset();
    mockPedidoBitacoraExecute.mockResolvedValue({ success: true, registrosGuardados: 1 });
  });

  it.each([
    ESTATUS_PEDIDO.ENTREGADO,
    ESTATUS_PEDIDO.ENTREGADO_PARCIAL,
    ESTATUS_PEDIDO.PENDIENTE_CON_CAUSA,
  ])("inicia el arrastre al cerrar con estatus %s", (estatus) => {
    const { realm } = crearRealmMock();
    const service = PedidosService.getInstance();
    service.setRealm(realm as any);

    expect(service.finalizarPedido(42, estatus).success).toBe(true);
    expect(mockPedidoBitacoraExecute).toHaveBeenCalledTimes(1);
  });

  it("no inicia el arrastre de bitácora para otros estados", () => {
    const { realm } = crearRealmMock();
    const service = PedidosService.getInstance();
    service.setRealm(realm as any);

    expect(service.cambiarEstatusPedido(42, ESTATUS_PEDIDO.PENDIENTE_SIN_CAUSA)).toBe(true);
    expect(mockPedidoBitacoraExecute).not.toHaveBeenCalled();
  });
});

describe("PedidoBitacoraUploadSyncTask", () => {
  const { PedidoBitacoraUploadSyncTask } = jest.requireActual(
    "../services/sync/tasks/PedidoBitacoraUploadSyncTask",
  );

  const crearTask = (response: { ok: boolean; status?: number }) => {
    const bitacora: any = crearPedido({ enviado: false, estatus: ESTATUS_PEDIDO.ENTREGADO });
    const realm = {
      objects: jest.fn(() => ({ filtered: jest.fn(() => [bitacora]) })),
      write: jest.fn((callback: () => void) => callback()),
    };
    const task = new PedidoBitacoraUploadSyncTask(realm as any, "test");
    (task as any).fetchWithTimeout = jest.fn().mockResolvedValue({
      ...response,
      status: response.status ?? 200,
      text: jest.fn().mockResolvedValue("error"),
    });
    return { bitacora, task };
  };

  it("marca la bitácora como enviada sólo cuando el servidor responde exitosamente", async () => {
    const { bitacora, task } = crearTask({ ok: true });

    await expect(task.execute()).resolves.toMatchObject({ success: true, registrosGuardados: 1 });
    expect(bitacora.enviado).toBe(true);
  });

  it("conserva la bitácora pendiente cuando falla el envío", async () => {
    const { bitacora, task } = crearTask({ ok: false, status: 500 });

    await expect(task.execute()).resolves.toMatchObject({ success: false, registrosGuardados: 0 });
    expect(bitacora.enviado).toBe(false);
  });
});

describe("PedidosService.getPedidoByFolio", () => {
  it("corrige la descripción cuando no coincide con el estatus almacenado", () => {
    const pedido = crearPedido({
      estatus: ESTATUS_PEDIDO.PENDIENTE_CON_CAUSA,
      estatusDescripcion: "EN ATENCION",
    });
    const { realm } = crearRealmMock(pedido);
    const service = PedidosService.getInstance();
    service.setRealm(realm as any);

    expect(service.getPedidoByFolio(pedido.folio)?.estatusDescripcion).toBe("PENDIENTE CON CAUSA");
  });

  it("recupera el nombre específico de otro renglón del pedido fuera de agenda", () => {
    const primerRenglon = crearPedido({ clienteNombre: "Cliente #10", clienteDomicilio: "" });
    const segundoRenglon = crearPedido({
      id: "42-9",
      idProducto: 9,
      clienteNombre: "Comercializadora Fuera de Agenda",
      clienteDomicilio: "Calle del Pedido 123",
    });
    const { realm } = crearRealmMock([primerRenglon, segundoRenglon]);
    const service = PedidosService.getInstance();
    service.setRealm(realm as any);

    const pedido = service.getPedidoByFolio(42);

    expect(pedido?.clienteNombre).toBe("Comercializadora Fuera de Agenda");
    expect(pedido?.clienteDomicilio).toBe("Calle del Pedido 123");
  });
});

describe("PedidosService.agregarProductoPedido", () => {
  it("crea un renglón adicional con solicitado cero, entregado uno y marcador de observación", () => {
    const { realm, pedidos, created } = crearRealmMock();
    const service = PedidosService.getInstance();
    service.setRealm(realm as any);

    expect(
      service.agregarProductoPedido(42, {
        idProducto: 9,
        productoNombre: "Producto adicional",
        precio: 25,
      }),
    ).toBe(true);

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      id: "42-9",
      folio: 42,
      idProducto: 9,
      cantPedido: 0,
      cantAtencion: 1,
      precio: 25,
      precioAtencion: 25,
      numeroProductos: 2,
      observaciones: `Entregar por la tarde ${PRODUCTO_AGREGADO_OBSERVACION}`,
      modificadoLocal: true,
    });
    expect(pedidos[0].numeroProductos).toBe(2);
  });

  it("incrementa la entrega cuando se selecciona nuevamente un producto existente", () => {
    const { realm, pedidos, created } = crearRealmMock();
    const service = PedidosService.getInstance();
    service.setRealm(realm as any);

    expect(service.agregarProductoPedido(42, { idProducto: 7, precio: 12 })).toBe(true);

    expect(created).toHaveLength(0);
    expect(pedidos[0].cantAtencion).toBe(3);
    expect(pedidos[0].precioAtencion).toBe(12);
    expect(pedidos[0].observaciones).toContain(PRODUCTO_AGREGADO_OBSERVACION);
  });

  it("rechaza agregar productos a un pedido finalizado", () => {
    const { realm, created } = crearRealmMock(crearPedido({ estatus: ESTATUS_PEDIDO.ENTREGADO }));
    const service = PedidosService.getInstance();
    service.setRealm(realm as any);

    expect(service.agregarProductoPedido(42, { idProducto: 9, precio: 25 })).toBe(false);
    expect(created).toHaveLength(0);
  });
});
