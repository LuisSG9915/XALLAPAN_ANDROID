jest.mock("realm", () => ({
  __esModule: true,
  default: {
    UpdateMode: { Modified: "modified" },
  },
}));

import CierreRutaService from "../services/CierreRutaService";

type PedidoMock = {
  folio: number;
  ruta: number;
  idVendedor?: number;
  fechaEntrega: Date;
  estatus: number;
};

const fechaRelativa = (dias: number): Date => {
  const fecha = new Date();
  fecha.setHours(12, 0, 0, 0);
  fecha.setDate(fecha.getDate() + dias);
  return fecha;
};

const crearRealmMock = (pedidos: PedidoMock[]) => {
  const filtered = jest.fn((query: string, ruta: number, vendedor?: number) =>
    pedidos.filter(
      (pedido) =>
        pedido.ruta === ruta &&
        (!query.includes("idVendedor") || pedido.idVendedor === vendedor),
    )
  );

  return {
    realm: {
      isClosed: false,
      objects: jest.fn().mockReturnValue({ filtered }),
    },
    filtered,
  };
};

describe("CierreRutaService.validarPedidosPendientesSinCausa", () => {
  it("bloquea los estados no resueltos solo para pedidos de hoy", () => {
    const estadosPendientes = [3, 4, 5, 8, 10];
    const pedidos: PedidoMock[] = estadosPendientes.map((estatus, index) => ({
      folio: 100 + index,
      ruta: 7,
      fechaEntrega: fechaRelativa(0),
      estatus,
    }));
    pedidos.push(
      { folio: 199, ruta: 7, fechaEntrega: fechaRelativa(0), estatus: 1 },
      { folio: 200, ruta: 7, fechaEntrega: fechaRelativa(0), estatus: 2 },
      { folio: 201, ruta: 7, fechaEntrega: fechaRelativa(0), estatus: 6 },
      { folio: 202, ruta: 7, fechaEntrega: fechaRelativa(0), estatus: 7 },
      { folio: 203, ruta: 7, fechaEntrega: fechaRelativa(0), estatus: 9 },
      { folio: 300, ruta: 7, fechaEntrega: fechaRelativa(-1), estatus: 1 },
      { folio: 301, ruta: 7, fechaEntrega: fechaRelativa(1), estatus: 1 },
      { folio: 302, ruta: 8, fechaEntrega: fechaRelativa(0), estatus: 1 }
    );

    const { realm, filtered } = crearRealmMock(pedidos);
    CierreRutaService.setRealm(realm as any);

    const resultado = CierreRutaService.validarPedidosPendientesSinCausa(7);

    expect(resultado.permitido).toBe(false);
    expect(resultado.pedidosBloqueantes.map((pedido) => pedido.folio)).toEqual([
      100, 101, 102, 103, 104,
    ]);
    expect(filtered).toHaveBeenCalledWith("ruta == $0", 7);
  });

  it("valida todos los pedidos de la ruta sin importar el vendedor asignado", () => {
    const pedidos: PedidoMock[] = [
      { folio: 500, ruta: 7, idVendedor: 4, fechaEntrega: fechaRelativa(0), estatus: 3 },
      { folio: 501, ruta: 7, idVendedor: 2142, fechaEntrega: fechaRelativa(0), estatus: 3 },
    ];
    const { realm, filtered } = crearRealmMock(pedidos);
    CierreRutaService.setRealm(realm as any);

    const resultado = CierreRutaService.validarPedidosPendientesSinCausa(7);

    expect(resultado.pedidosBloqueantes.map((pedido) => pedido.folio)).toEqual([500, 501]);
    expect(filtered).toHaveBeenCalledWith("ruta == $0", 7);
  });

  it("permite cerrar cuando los pedidos de hoy solo están entregados o entregados parcialmente", () => {
    const { realm } = crearRealmMock([
      { folio: 400, ruta: 7, fechaEntrega: fechaRelativa(0), estatus: 2 },
      { folio: 401, ruta: 7, fechaEntrega: fechaRelativa(0), estatus: 6 },
      { folio: 402, ruta: 7, fechaEntrega: fechaRelativa(-1), estatus: 8 },
    ]);
    CierreRutaService.setRealm(realm as any);

    const resultado = CierreRutaService.validarPedidosPendientesSinCausa(7);

    expect(resultado).toEqual({ permitido: true, pedidosBloqueantes: [] });
  });

  it("bloquea el cierre si no puede consultar los pedidos", () => {
    const realm = {
      isClosed: false,
      objects: jest.fn(() => {
        throw new Error("Realm no disponible");
      }),
    };
    CierreRutaService.setRealm(realm as any);

    const resultado = CierreRutaService.validarPedidosPendientesSinCausa(7);

    expect(resultado).toEqual({
      permitido: false,
      pedidosBloqueantes: [],
      error: true,
    });
  });
});
