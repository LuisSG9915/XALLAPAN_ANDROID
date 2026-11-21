const Realm = require("realm");
const PedidoSchema = {
  name: "Pedido",
  properties: {
    id: "string", idPedido: "int?", id_movil: "int?", folio: "int",
    fecha: "date?", ruta: "int", cliente: "int", clienteNombre: "string?",
    clienteDomicilio: "string?", idCanal: "int?", fechaAtencion: "date?",
    idVendedor: "int", numeroProductos: "int", cantPedido: "float",
    listaPrecio: "int?", fechaEntrega: "date?", estatus: "int",
    estatusDescripcion: "string?", fueraAgenda: "bool?", observaciones: "string?",
    no_venta: "int?", tieneDiferencia: "bool?", causaNoAtencion: "int?",
    obserNoAtencion: "string?", syncedAt: "date", syncedAr: "date?",
    modificadoLocal: "bool?", idProducto: "int", productoNombre: "string?",
    cantAtencion: "float?", precio: "float?", precioAtencion: "float?",
    causaDiferencia: "int?", causaDiferenciaDesc: "string?",
    obserDiferencia: "string?", atendido: "bool?",
  },
  primaryKey: "id",
};
const PedidoBitacoraSchema = {
  name: "PedidoBitacora",
  properties: {
    id: "string", idPedido: "int", id_movil: "int?", folio: "int",
    fecha: "date", ruta: "int", cliente: "int", idCanal: "int?",
    fechaAtencion: "date?", idVendedor: "int", idProducto: "int?",
    cantPedido: "float?", precio: "float?", observaciones: "string?",
    listaPrecio: "int?", fechaEntrega: "date?", estatus: "int",
    estatusAnterior: "int?", cantAtencion: "float?", precioAtencion: "float?",
    causaDiferencia: "int?", obserDiferencia: "string?",
    causaNoAtencion: "int?", obserNoAtencion: "string?", usrAlta: "int?",
    fueraAgenda: "bool?", no_venta: "int?", tipoCambio: "string?",
    enviado: "bool",
  },
  primaryKey: "id",
};
const PedidoEstadoSchema = {
  name: "PedidoEstado",
  properties: {
    id: "string", ruta: "int", pedido: "int", fecha: "date",
    estado: "int", idVendedor: "int", enviado: "bool",
  },
  primaryKey: "id",
};
(async () => {
  try {
    const realm = await Realm.open({
      path: "/tmp/FullSyncDB.realm",
      schema: [PedidoSchema, PedidoBitacoraSchema, PedidoEstadoSchema],
      readOnly: true,
    });
    const folio = Number(process.argv[2] || 12);
    const pedidos = realm.objects("Pedido").filtered(`folio = ${folio}`);
    console.log(`=== PEDIDOS folio ${folio} (${pedidos.length} renglones) ===`);
    pedidos.forEach((p) =>
      console.log(
        JSON.stringify({
          id: p.id, idProducto: p.idProducto, producto: p.productoNombre,
          cantPedido: p.cantPedido, cantAtencion: p.cantAtencion,
          estatus: p.estatus, tieneDiferencia: p.tieneDiferencia,
          causaDiferencia: p.causaDiferencia, causaDesc: p.causaDiferenciaDesc,
          obserDiferencia: p.obserDiferencia, atendido: p.atendido,
          modificadoLocal: p.modificadoLocal, id_movil: p.id_movil,
          observaciones: p.observaciones,
        }),
      ),
    );
    try {
      const bit = realm.objects("PedidoBitacora").filtered(`folio = ${folio}`);
      console.log(`=== BITACORA folio ${folio} (${bit.length}) ===`);
      bit.forEach((b) =>
        console.log(
          JSON.stringify({
            estatus: b.estatus, estatusAnterior: b.estatusAnterior,
            cantPedido: b.cantPedido, cantAtencion: b.cantAtencion,
            causaDiferencia: b.causaDiferencia, enviado: b.enviado,
            tipoCambio: b.tipoCambio, fecha: b.fecha,
          }),
        ),
      );
    } catch (e) { console.log("bitacora:", e.message); }
    try {
      const est = realm.objects("PedidoEstado").filtered(`pedido = ${folio}`);
      console.log(`=== ESTADOS folio ${folio} (${est.length}) ===`);
      est.forEach((s) =>
        console.log(JSON.stringify({ estado: s.estado, fecha: s.fecha, enviado: s.enviado })),
      );
    } catch (e) { console.log("estados:", e.message); }
    realm.close();
  } catch (e) {
    console.error("ERR:", e.message);
    process.exit(1);
  }
})();
