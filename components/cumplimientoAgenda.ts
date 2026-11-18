// Integración de pedidos de central (tarjetas sintéticas tipo 99) dentro de la
// agenda real: en lugar de mostrar una tarjeta extra para el mismo cliente, los
// folios se anexan a la primera visita real del cliente. Las tarjetas sin
// coincidencia se conservan al final.

export interface FilaAgenda {
  idCliente: number | string;
  tipo?: number | string;
  visitado?: number;
  pedidoFolios?: number[];
  fechaEntregaPedido?: Date;
  nombreCliente?: string;
  domicilio?: string;
  tienePedidoPendiente?: boolean;
}

export type FilaPedidoAgenda = FilaAgenda;

const esFilaReal = (fila: FilaAgenda | FilaPedidoAgenda): boolean => Number(fila.tipo) !== 99;

export function integrarPedidosEnAgenda<A extends FilaAgenda, P extends FilaPedidoAgenda>(
  visitas: A[],
  pedidos: P[],
): (A | P)[] {
  const resultado: (A | P)[] = [...visitas];

  pedidos.forEach((pedido) => {
    const idCliente = Number(pedido.idCliente);
    const folios = (pedido.pedidoFolios ?? [])
      .map((folio) => Number(folio))
      .filter((folio) => Number.isFinite(folio) && folio > 0);

    const indice = Number.isFinite(idCliente)
      ? resultado.findIndex((fila) => esFilaReal(fila) && Number(fila.idCliente) === idCliente)
      : -1;

    if (indice < 0) {
      resultado.push(pedido);
      return;
    }

    const fila = resultado[indice] as A;
    const pedidoFolios = [...(fila.pedidoFolios ?? [])];
    folios.forEach((folio) => {
      if (!pedidoFolios.includes(folio)) pedidoFolios.push(folio);
    });

    const pedidoPendiente = Number(pedido.visitado) !== 1 && folios.length > 0;

    resultado[indice] = {
      ...fila,
      pedidoFolios,
      fechaEntregaPedido: fila.fechaEntregaPedido ?? pedido.fechaEntregaPedido,
      nombreCliente: fila.nombreCliente ?? pedido.nombreCliente,
      domicilio: fila.domicilio ?? pedido.domicilio,
      tienePedidoPendiente: Boolean(fila.tienePedidoPendiente) || pedidoPendiente,
    };
  });

  return resultado;
}
