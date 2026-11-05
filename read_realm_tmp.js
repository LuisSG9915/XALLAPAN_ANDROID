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
const VisitaSchema = {
  name: "Visita",
  properties: {
    id: "string", idCompuesto: "string", idOriginal: "int", idCliente: "int",
    ruta: "string", fecha: "date", orden: "int", tipo: "int", visitado: "int",
  },
  primaryKey: "id",
};
(async () => {
  try {
    const realm = await Realm.open({
      path: "/tmp/FullSyncDB.realm",
      schema: [PedidoSchema, VisitaSchema],
      readOnly: true,
    });
    const pedidos = realm.objects("Pedido").filtered("folio = 140 OR folio = 139");
    console.log("=== PEDIDOS 139/140 ===");
    pedidos.forEach(p => console.log(JSON.stringify({
      id: p.id, folio: p.folio, ruta: p.ruta, cliente: p.cliente,
      idProducto: p.idProducto, estatus: p.estatus,
      fechaEntrega: p.fechaEntrega, fecha: p.fecha,
      modificadoLocal: p.modificadoLocal, syncedAr: p.syncedAr,
    })));
    const todos = realm.objects("Pedido").filtered("ruta = 38");
    console.log("=== RESUMEN RUTA 38 por estatus ===");
    const porEstatus = {};
    todos.forEach(p => { porEstatus[p.estatus] = (porEstatus[p.estatus]||0)+1; });
    console.log(JSON.stringify(porEstatus));
    try {
      const visitas = realm.objects("Visita").filtered("tipo = 99");
      console.log("=== VISITAS tipo 99 ===");
      visitas.forEach(v => console.log(JSON.stringify({
        id: v.id, idCompuesto: v.idCompuesto, idOriginal: v.idOriginal,
        idCliente: v.idCliente, fecha: v.fecha, visitado: v.visitado,
      })));
    } catch (e) { console.log("Visita schema distinto:", e.message); }
    realm.close();
  } catch (e) {
    console.error("ERR:", e.message);
    process.exit(1);
  }
})();
