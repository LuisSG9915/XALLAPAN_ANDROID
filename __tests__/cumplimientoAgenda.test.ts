import { integrarPedidosEnAgenda, FilaAgenda, FilaPedidoAgenda } from "../components/cumplimientoAgenda";

type FilaVisitaPrueba = FilaAgenda & { id: string; orden: number; ruta?: string };
type FilaPedidoPrueba = FilaPedidoAgenda & { id: string };

const visitaReal = (overrides: Partial<FilaVisitaPrueba> = {}): FilaVisitaPrueba => ({
  id: "1-2024-01-01-123",
  idCliente: 123,
  tipo: 1,
  visitado: 0,
  orden: 3,
  ruta: "R1",
  nombreCliente: "Cliente Agenda",
  ...overrides,
});

const pedidoCentral = (overrides: Partial<FilaPedidoPrueba> = {}): FilaPedidoPrueba => ({
  id: "pedido-123-2024-01-01",
  idCliente: 123,
  tipo: 99,
  visitado: 0,
  pedidoFolios: [5001],
  ...overrides,
});

describe("integrarPedidosEnAgenda", () => {
  it("fusiona cuando idCliente coincide aunque difiera el tipo (string vs number)", () => {
    const resultado = integrarPedidosEnAgenda(
      [visitaReal({ idCliente: "123" })],
      [pedidoCentral({ idCliente: 123 })],
    );

    expect(resultado).toHaveLength(1);
    expect(resultado[0].pedidoFolios).toEqual([5001]);
    expect(Number(resultado[0].tipo)).not.toBe(99);
  });

  it("no duplica tarjeta, conserva campos/estado reales y todos los folios", () => {
    const visitas = [visitaReal({ id: "real-1", visitado: 0, orden: 7 })];
    const pedidos = [pedidoCentral({ pedidoFolios: [5001, 5002, 5003], visitado: 0 })];

    const resultado = integrarPedidosEnAgenda(visitas, pedidos);

    expect(resultado).toHaveLength(1);
    const fila = resultado[0] as FilaAgenda & { id: string; orden: number };
    expect(fila.id).toBe("real-1");
    expect(fila.orden).toBe(7);
    expect(fila.tipo).toBe(1);
    expect(fila.visitado).toBe(0);
    expect(fila.pedidoFolios).toEqual([5001, 5002, 5003]);
    expect(fila.tienePedidoPendiente).toBe(true);
    // No hereda el id sintético ni el estado del pedido
    expect(fila.id).not.toBe("pedido-123-2024-01-01");
  });

  it("conserva la tarjeta sintética cuando no hay visita real del cliente", () => {
    const resultado = integrarPedidosEnAgenda(
      [visitaReal({ idCliente: 999 })],
      [pedidoCentral({ idCliente: 123 })],
    );

    expect(resultado).toHaveLength(2);
    expect(resultado[0].idCliente).toBe(999);
    const sintetica = resultado[1] as FilaPedidoAgenda & { id: string };
    expect(sintetica.id).toBe("pedido-123-2024-01-01");
    expect(Number(sintetica.tipo)).toBe(99);
    expect(sintetica.pedidoFolios).toEqual([5001]);
  });

  it("con varias visitas reales del mismo cliente solo la primera recibe los folios", () => {
    const resultado = integrarPedidosEnAgenda(
      [visitaReal({ id: "real-a", orden: 1 }), visitaReal({ id: "real-b", orden: 2 })],
      [pedidoCentral()],
    );

    expect(resultado).toHaveLength(2);
    const [primera, segunda] = resultado as (FilaAgenda & { id: string })[];
    expect(primera.id).toBe("real-a");
    expect(primera.pedidoFolios).toEqual([5001]);
    expect(primera.tienePedidoPendiente).toBe(true);
    expect(segunda.id).toBe("real-b");
    expect(segunda.pedidoFolios).toBeUndefined();
    expect(segunda.tienePedidoPendiente).toBeUndefined();
  });

  it("una visita realizada puede seguir mostrando pedido pendiente", () => {
    const resultado = integrarPedidosEnAgenda(
      [visitaReal({ visitado: 1 })],
      [pedidoCentral({ visitado: 0 })],
    );

    expect(resultado).toHaveLength(1);
    const fila = resultado[0];
    expect(fila.visitado).toBe(1);
    expect(fila.tienePedidoPendiente).toBe(true);
    expect(fila.pedidoFolios).toEqual([5001]);
  });

  it("un pedido sintético completado no marca la fila como pendiente", () => {
    const resultado = integrarPedidosEnAgenda(
      [visitaReal({ visitado: 1 })],
      [pedidoCentral({ visitado: 1 })],
    );

    const fila = resultado[0];
    expect(fila.visitado).toBe(1);
    expect(fila.tienePedidoPendiente).toBe(false);
    expect(fila.pedidoFolios).toEqual([5001]);
  });

  it("usa nombre/domicilio del pedido solo como fallback cuando la agenda no los tiene", () => {
    const sinNombre = integrarPedidosEnAgenda(
      [visitaReal({ nombreCliente: undefined, domicilio: undefined })],
      [pedidoCentral({ nombreCliente: "Nombre Pedido", domicilio: "Calle Pedido 1" })],
    );
    expect(sinNombre[0].nombreCliente).toBe("Nombre Pedido");
    expect(sinNombre[0].domicilio).toBe("Calle Pedido 1");

    const conNombre = integrarPedidosEnAgenda(
      [visitaReal({ nombreCliente: "Nombre Agenda", domicilio: "Calle Agenda 9" })],
      [pedidoCentral({ nombreCliente: "Nombre Pedido", domicilio: "Calle Pedido 1" })],
    );
    expect(conNombre[0].nombreCliente).toBe("Nombre Agenda");
    expect(conNombre[0].domicilio).toBe("Calle Agenda 9");
  });

  it("no muta las filas de entrada", () => {
    const visita = visitaReal();
    const pedido = pedidoCentral({ pedidoFolios: [5001, 5002] });
    const snapshotVisita = { ...visita };
    const snapshotPedido = { ...pedido, pedidoFolios: [...(pedido.pedidoFolios ?? [])] };

    integrarPedidosEnAgenda([visita], [pedido]);

    expect(visita).toEqual(snapshotVisita);
    expect(visita.pedidoFolios).toBeUndefined();
    expect(pedido).toEqual(snapshotPedido);
  });
});
