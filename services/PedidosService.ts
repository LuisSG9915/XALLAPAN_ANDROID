import Realm from "realm";
import { fetchWithTimeout } from "./fetchWithTimeout";
import AuthService from "./AuthService";
import PedidoNotificacionService from "./PedidoNotificacionService";

export interface Pedido {
  id: number;
  id_movil?: number;
  folio: number;
  fecha?: Date;
  ruta: number;
  cliente: number;
  clienteNombre?: string;
  clienteDomicilio?: string;
  idCanal?: number;
  fechaAtencion?: Date;
  idVendedor: number;
  numeroProductos: number;
  cantPedido: number;
  listaPrecio?: number;
  fechaEntrega?: Date;
  estatus: number;
  estatusDescripcion?: string;
  fueraAgenda?: boolean;
  observaciones?: string;
  no_venta?: number;
  tieneDiferencia?: boolean;
  causaNoAtencion?: number;
  obserNoAtencion?: string;
  syncedAt: Date;
  syncedAr?: Date;
  modificadoLocal?: boolean;
}

export interface PedidoDetalle {
  id: string;
  idPedido: number;
  idProducto: number;
  productoNombre?: string;
  cantPedido: number;
  cantAtencion?: number;
  precio?: number;
  precioAtencion?: number;
  causaDiferencia?: number;
  causaDiferenciaDesc?: string;
  obserDiferencia?: string;
  tieneDiferencia?: boolean;
  atendido?: boolean;
  modificadoLocal?: boolean;
}

export interface PedidoBitacora {
  id: string;
  idPedido: number;
  id_movil?: number;
  folio: number;
  fecha: Date;
  ruta: number;
  cliente: number;
  idCanal?: number;
  idVendedor: number;
  idProducto?: number;
  cantPedido?: number;
  precio?: number;
  observaciones?: string;
  listaPrecio?: number;
  fechaEntrega?: Date;
  estatus: number;
  estatusAnterior?: number;
  cantAtencion?: number;
  precioAtencion?: number;
  causaDiferencia?: number;
  obserDiferencia?: string;
  causaNoAtencion?: number;
  obserNoAtencion?: string;
  usrAlta?: number;
  fueraAgenda?: boolean;
  no_venta?: number;
  tipoCambio?: string;
  enviado: boolean;
}

export const ESTATUS_PEDIDO = {
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
};

// Estados en los que el pedido ya fue atendido/cerrado y no admite modificación
const ESTADOS_FINALES = [
  ESTATUS_PEDIDO.ENTREGADO,
  ESTATUS_PEDIDO.ENTREGADO_PARCIAL,
  ESTATUS_PEDIDO.PENDIENTE_CON_CAUSA,
  ESTATUS_PEDIDO.CANCELADO,
];

class PedidosService {
  private static instance: PedidosService;
  private realm: Realm | null = null;
  private apiBaseUrl = "https://api.cbinformatica.net:9031";
  private static idMovilCounter = 0;

  private constructor() {}

  static getInstance(): PedidosService {
    if (!PedidosService.instance) {
      PedidosService.instance = new PedidosService();
    }
    return PedidosService.instance;
  }

  setRealm(realm: Realm): void {
    this.realm = realm;
    console.log("[PedidosService] Realm inyectado correctamente");
  }

  private getRealm(): Realm {
    if (!this.realm || this.realm.isClosed) {
      throw new Error("[PedidosService] Realm no inicializado");
    }
    return this.realm;
  }

  private getNextIdMovil(): number {
    return ++PedidosService.idMovilCounter;
  }

  private puedeModificar(estatus: number): boolean {
    return !ESTADOS_FINALES.includes(estatus);
  }

  async syncPedidos(ruta: number): Promise<{ success: boolean; count: number; detalles?: number }> {
    try {
      const endpoint = `${this.apiBaseUrl}/api/MovilesVentas/sp_MovilesPedidosFull/${ruta}`;
      const response = await fetchWithTimeout(endpoint);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const rows = await response.json();

      if (!Array.isArray(rows)) {
        throw new Error("La respuesta no es un array de pedidos");
      }

      const realm = this.getRealm();

      // Agrupar renglones por folio: cada renglón es un producto
      const pedidosMap = new Map<number, any[]>();
      rows.forEach((row: any) => {
        if (!pedidosMap.has(row.folio)) {
          pedidosMap.set(row.folio, []);
        }
        pedidosMap.get(row.folio)!.push(row);
      });

      let nuevosPedidos = 0;
      let nuevosDetalles = 0;
      const foliosNuevos: number[] = [];

      realm.write(() => {
        pedidosMap.forEach((renglones, folio) => {
          const primero = renglones[0];
          const pedidoExistente = realm.objectForPrimaryKey("Pedido", folio) as any;

          const conservarLocal = pedidoExistente?.modificadoLocal === true;
          const estatusFinal = conservarLocal ? pedidoExistente.estatus : primero.estatus;
          const fechaAtencionFinal = conservarLocal ? pedidoExistente.fechaAtencion : null;
          const causaNoAtencionFinal = conservarLocal ? pedidoExistente.causaNoAtencion : null;
          const obserNoAtencionFinal = conservarLocal ? pedidoExistente.obserNoAtencion : null;

          const numeroProductos = renglones.length;
          const cantPedidoTotal = renglones.reduce(
            (sum: number, r: any) => sum + (parseFloat(r.cantPedido) || 0),
            0
          );

          const cliente = this.getClienteById(primero.cliente);

          realm.create(
            "Pedido",
            {
              id: folio,
              folio,
              fecha: primero.fecha ? new Date(primero.fecha) : null,
              ruta: primero.ruta,
              cliente: primero.cliente,
              clienteNombre: cliente?.nombre || `Cliente #${primero.cliente}`,
              clienteDomicilio: cliente?.domicilio || "",
              idCanal: null,
              fechaAtencion: fechaAtencionFinal,
              idVendedor: primero.idVendedor,
              numeroProductos,
              cantPedido: cantPedidoTotal,
              listaPrecio: primero.listaPrecio,
              fechaEntrega: primero.fechaEntrega ? new Date(primero.fechaEntrega) : null,
              estatus: estatusFinal,
              estatusDescripcion: this.getEstatusDescripcion(estatusFinal),
              fueraAgenda: primero.fueraAgenda,
              observaciones: primero.observaciones,
              no_venta: primero.noVenta,
              tieneDiferencia: pedidoExistente?.tieneDiferencia ?? false,
              causaNoAtencion: causaNoAtencionFinal,
              obserNoAtencion: obserNoAtencionFinal,
              syncedAt: new Date(),
              modificadoLocal: pedidoExistente?.modificadoLocal ?? false,
            },
            Realm.UpdateMode.Modified
          );

          if (!pedidoExistente) {
            nuevosPedidos++;
            foliosNuevos.push(folio);
          }

          // Crear/actualizar productos del pedido
          renglones.forEach((renglon: any) => {
            const idProducto = renglon.idProducto;
            const idDetalle = `${folio}-${idProducto}`;
            const detalleExistente = realm.objectForPrimaryKey("PedidoDetalle", idDetalle) as any;

            const producto = this.getProductoById(idProducto);
            const productoNombre = producto?.descripcion || `Producto #${idProducto}`;

            const cantPedido = parseFloat(renglon.cantPedido) || 0;
            const cantAtencionFinal = detalleExistente?.cantAtencion ?? null;
            const tieneDiferencia =
              cantAtencionFinal !== null && cantAtencionFinal !== undefined && cantAtencionFinal < cantPedido;

            realm.create(
              "PedidoDetalle",
              {
                id: idDetalle,
                idPedido: folio,
                idProducto,
                productoNombre,
                cantPedido,
                cantAtencion: cantAtencionFinal,
                precio: renglon.precio ?? null,
                precioAtencion: detalleExistente?.precioAtencion ?? null,
                causaDiferencia: detalleExistente?.causaDiferencia ?? null,
                causaDiferenciaDesc: detalleExistente?.causaDiferencia
                  ? this.getCausaDiferenciaDescripcion(detalleExistente.causaDiferencia)
                  : null,
                obserDiferencia: detalleExistente?.obserDiferencia ?? null,
                tieneDiferencia,
                atendido: cantAtencionFinal !== null && cantAtencionFinal !== undefined && cantAtencionFinal > 0,
                modificadoLocal: detalleExistente?.modificadoLocal ?? false,
              },
              Realm.UpdateMode.Modified
            );

            if (!detalleExistente) {
              nuevosDetalles++;
            }
          });
        });
      });

      console.log(
        `[PedidosService] Sincronizados ${nuevosPedidos} pedidos nuevos y ${nuevosDetalles} detalles nuevos para ruta ${ruta}`
      );

      // Notificar pedidos nuevos y registrar en agenda
      try {
        PedidoNotificacionService.setRealm(realm);
        await PedidoNotificacionService.procesarPedidosSincronizados(foliosNuevos);
      } catch (notifError) {
        console.warn("[PedidosService] Error al notificar pedidos nuevos:", notifError);
      }

      return { success: true, count: nuevosPedidos, detalles: nuevosDetalles };
    } catch (error) {
      console.error("[PedidosService] Error al sincronizar pedidos:", error);
      return { success: false, count: 0 };
    }
  }

  async syncCatalogos(): Promise<void> {
    try {
      const [estatusRes, causasDifRes, causasNoAtRes] = await Promise.all([
        fetchWithTimeout(`${this.apiBaseUrl}/api/MovilesVentas/sp_MovilesPedidosEstatus`),
        fetchWithTimeout(`${this.apiBaseUrl}/api/MovilesVentas/sp_MovilesPedidosDiferencias`),
        fetchWithTimeout(`${this.apiBaseUrl}/api/MovilesVentas/sp_MovilesPedidosNoAtencion`),
      ]);

      const realm = this.getRealm();

      if (estatusRes.ok) {
        const estatusData = await estatusRes.json();
        realm.write(() => {
          estatusData.forEach((item: any) => {
            realm.create("CatalogoEstatusPedido", { id: item.id, descripcion: item.descripcion }, Realm.UpdateMode.Modified);
          });
        });
      }

      if (causasDifRes.ok) {
        const causasDifData = await causasDifRes.json();
        realm.write(() => {
          causasDifData.forEach((item: any) => {
            realm.create(
              "CatalogoCausaDiferencia",
              { id: item.id, descripcion: item.descripcion },
              Realm.UpdateMode.Modified
            );
          });
        });
      }

      if (causasNoAtRes.ok) {
        const causasNoAtData = await causasNoAtRes.json();
        realm.write(() => {
          causasNoAtData.forEach((item: any) => {
            realm.create(
              "CatalogoCausaNoAtencion",
              { id: item.id, descripcion: item.descripcion },
              Realm.UpdateMode.Modified
            );
          });
        });
      }

      console.log("[PedidosService] Catálogos sincronizados");
    } catch (error) {
      console.error("[PedidosService] Error al sincronizar catálogos:", error);
    }
  }

  getPedidosByRuta(ruta: number): Pedido[] {
    const realm = this.getRealm();
    const pedidos = realm.objects("Pedido").filtered("ruta = $0", ruta);
    return Array.from(pedidos) as unknown as Pedido[];
  }

  getPedidosPendientes(ruta: number): Pedido[] {
    const realm = this.getRealm();
    const pedidos = realm
      .objects("Pedido")
      .filtered(
        "ruta = $0 AND estatus != $1 AND estatus != $2 AND estatus != $3 AND estatus != $4",
        ruta,
        ESTATUS_PEDIDO.ENTREGADO,
        ESTATUS_PEDIDO.CANCELADO,
        ESTATUS_PEDIDO.ENTREGADO_PARCIAL,
        ESTATUS_PEDIDO.PENDIENTE_CON_CAUSA
      );
    return Array.from(pedidos) as unknown as Pedido[];
  }

  getPedidoById(id: number): Pedido | null {
    const realm = this.getRealm();
    const pedido = realm.objectForPrimaryKey("Pedido", id);
    return pedido ? (pedido as unknown as Pedido) : null;
  }

  getPedidosConEstatusPendienteSinCausa(ruta: number): Pedido[] {
    const realm = this.getRealm();
    const pedidos = realm
      .objects("Pedido")
      .filtered(
        "ruta = $0 AND estatus != $1 AND estatus != $2 AND estatus != $3 AND estatus != $4",
        ruta,
        ESTATUS_PEDIDO.ENTREGADO,
        ESTATUS_PEDIDO.ENTREGADO_PARCIAL,
        ESTATUS_PEDIDO.PENDIENTE_CON_CAUSA,
        ESTATUS_PEDIDO.CANCELADO
      );
    return Array.from(pedidos) as unknown as Pedido[];
  }

  puedeCerrarRuta(ruta: number): { permitido: boolean; pedidosBloqueantes: Pedido[] } {
    const bloqueantes = this.getPedidosConEstatusPendienteSinCausa(ruta);
    return {
      permitido: bloqueantes.length === 0,
      pedidosBloqueantes: bloqueantes,
    };
  }

  iniciarAtencionPedido(idPedido: number): boolean {
    return this.cambiarEstatusPedido(idPedido, ESTATUS_PEDIDO.EN_ATENCION);
  }

  cambiarEstatusPedido(
    idPedido: number,
    nuevoEstatus: number,
    causaNoAtencion?: number,
    obserNoAtencion?: string
  ): boolean {
    try {
      const realm = this.getRealm();
      const pedido = realm.objectForPrimaryKey("Pedido", idPedido) as any;

      if (!pedido) {
        console.error("[PedidosService] Pedido no encontrado:", idPedido);
        return false;
      }

      if (!this.puedeModificar(pedido.estatus)) {
        console.error("[PedidosService] No se puede modificar pedido con estatus:", pedido.estatus);
        return false;
      }

      const estatusAnterior = pedido.estatus;
      const ahora = new Date();

      realm.write(() => {
        pedido.estatus = nuevoEstatus;
        pedido.estatusDescripcion = this.getEstatusDescripcion(nuevoEstatus);
        pedido.modificadoLocal = true;
        pedido.syncedAt = ahora;

        // Registrar fecha de atención cuando el pedido pasa a un estado de atención/cierre
        if (
          nuevoEstatus === ESTATUS_PEDIDO.EN_ATENCION ||
          nuevoEstatus === ESTATUS_PEDIDO.ENTREGADO ||
          nuevoEstatus === ESTATUS_PEDIDO.ENTREGADO_PARCIAL ||
          nuevoEstatus === ESTATUS_PEDIDO.PENDIENTE_CON_CAUSA
        ) {
          pedido.fechaAtencion = pedido.fechaAtencion || ahora;
        }

        if (causaNoAtencion) {
          pedido.causaNoAtencion = causaNoAtencion;
          pedido.obserNoAtencion = obserNoAtencion || "";
        }

        // Recalcular bandera de diferencia a nivel pedido
        this.recalcularTieneDiferencia(pedido);
      });

      // Registrar bitácora con snapshot completo del renglón (uno por producto)
      this.registrarBitacoraEstado({
        idPedido,
        estatusAnterior,
        estatus: nuevoEstatus,
        tipoCambio: "estatus",
        causaNoAtencion,
        obserNoAtencion,
      });

      console.log(`[PedidosService] Estatus cambiado: ${estatusAnterior} -> ${nuevoEstatus}`);
      return true;
    } catch (error) {
      console.error("[PedidosService] Error al cambiar estatus:", error);
      return false;
    }
  }

  actualizarCantAtencion(idPedido: number, idProducto: number, cantAtencion: number): boolean {
    try {
      const realm = this.getRealm();
      const idDetalle = `${idPedido}-${idProducto}`;
      const detalle = realm.objectForPrimaryKey("PedidoDetalle", idDetalle) as any;

      if (!detalle) {
        console.error("[PedidosService] Detalle no encontrado:", idDetalle);
        return false;
      }

      const pedido = realm.objectForPrimaryKey("Pedido", idPedido) as any;
      if (!pedido || !this.puedeModificar(pedido.estatus)) {
        console.error("[PedidosService] No se puede modificar cantidad del pedido:", pedido?.estatus);
        return false;
      }

      const cantAtencionFinal = cantAtencion;
      const tieneDiferencia = cantAtencionFinal < detalle.cantPedido;

      realm.write(() => {
        detalle.cantAtencion = cantAtencionFinal;
        detalle.tieneDiferencia = tieneDiferencia;
        detalle.atendido = cantAtencionFinal > 0;
        detalle.modificadoLocal = true;

        // Recalcular bandera a nivel pedido
        this.recalcularTieneDiferencia(pedido);
      });

      console.log(`[PedidosService] Cantidad actualizada: ${idProducto} -> ${cantAtencionFinal}`);
      return true;
    } catch (error) {
      console.error("[PedidosService] Error al actualizar cantidad:", error);
      return false;
    }
  }

  registrarCausaDiferencia(
    idPedido: number,
    idProducto: number,
    causaDiferencia: number,
    obserDiferencia?: string
  ): boolean {
    try {
      const realm = this.getRealm();
      const idDetalle = `${idPedido}-${idProducto}`;
      const detalle = realm.objectForPrimaryKey("PedidoDetalle", idDetalle) as any;

      if (!detalle) {
        console.error("[PedidosService] Detalle no encontrado:", idDetalle);
        return false;
      }

      const pedido = realm.objectForPrimaryKey("Pedido", idPedido) as any;
      if (!pedido || !this.puedeModificar(pedido.estatus)) {
        console.error("[PedidosService] No se puede registrar causa del pedido:", pedido?.estatus);
        return false;
      }

      const causaDesc = this.getCausaDiferenciaDescripcion(causaDiferencia);

      realm.write(() => {
        detalle.causaDiferencia = causaDiferencia;
        detalle.causaDiferenciaDesc = causaDesc;
        detalle.obserDiferencia = obserDiferencia || "";
        detalle.modificadoLocal = true;
      });

      console.log(`[PedidosService] Causa diferencia registrada: ${idProducto} -> ${causaDiferencia}`);
      return true;
    } catch (error) {
      console.error("[PedidosService] Error al registrar causa:", error);
      return false;
    }
  }

  getDetallePedido(idPedido: number): PedidoDetalle[] {
    const realm = this.getRealm();
    const detalles = realm.objects("PedidoDetalle").filtered("idPedido = $0", idPedido);
    return Array.from(detalles) as unknown as PedidoDetalle[];
  }

  getEstatusPedidos(): { id: number; descripcion: string }[] {
    const realm = this.getRealm();
    const catalogos = realm.objects("CatalogoEstatusPedido");
    return Array.from(catalogos) as unknown as { id: number; descripcion: string }[];
  }

  getCausasDiferencia(): { id: number; descripcion: string }[] {
    const realm = this.getRealm();
    const catalogos = realm.objects("CatalogoCausaDiferencia");
    return Array.from(catalogos) as unknown as { id: number; descripcion: string }[];
  }

  getCausasNoAtencion(): { id: number; descripcion: string }[] {
    const realm = this.getRealm();
    const catalogos = realm.objects("CatalogoCausaNoAtencion");
    return Array.from(catalogos) as unknown as { id: number; descripcion: string }[];
  }

  getBitacoraNoEnviada(): PedidoBitacora[] {
    const realm = this.getRealm();
    const bitacoras = realm.objects("PedidoBitacora").filtered("enviado = false");
    return Array.from(bitacoras) as unknown as PedidoBitacora[];
  }

  getAllPedidos(): Pedido[] {
    const realm = this.getRealm();
    const pedidos = realm.objects("Pedido");
    return Array.from(pedidos) as unknown as Pedido[];
  }

  getAllDetalles(): PedidoDetalle[] {
    const realm = this.getRealm();
    const detalles = realm.objects("PedidoDetalle");
    return Array.from(detalles) as unknown as PedidoDetalle[];
  }

  getAllBitacoras(): PedidoBitacora[] {
    const realm = this.getRealm();
    const bitacoras = realm.objects("PedidoBitacora");
    return Array.from(bitacoras) as unknown as PedidoBitacora[];
  }

  private recalcularTieneDiferencia(pedido: any): void {
    const detalles = this.getRealm().objects("PedidoDetalle").filtered("idPedido = $0", pedido.id);
    const tieneDiferencia = Array.from(detalles).some((d: any) => d.tieneDiferencia === true);
    pedido.tieneDiferencia = tieneDiferencia;
  }

  private registrarBitacoraEstado(data: {
    idPedido: number;
    estatusAnterior: number;
    estatus: number;
    tipoCambio: string;
    causaNoAtencion?: number;
    obserNoAtencion?: string;
  }): void {
    try {
      const realm = this.getRealm();
      const pedido = realm.objectForPrimaryKey("Pedido", data.idPedido) as any;
      if (!pedido) return;

      const detalles = this.getDetallePedido(data.idPedido);
      const ahora = new Date();

      realm.write(() => {
        // Si no hay detalles, registrar una bitácora de cabecera
        const registros = detalles.length > 0 ? detalles : [null];

        registros.forEach((detalle, index) => {
          const idMovil = this.getNextIdMovil();
          // Usar timestamp + índice para evitar colisiones locales
          const idLocal = `${Date.now()}-${index}-${Math.random().toString(36).substr(2, 5)}`;

          realm.create(
            "PedidoBitacora",
            {
              id: idLocal,
              idPedido: data.idPedido,
              id_movil: idMovil,
              folio: pedido.folio,
              fecha: ahora,
              ruta: pedido.ruta,
              cliente: pedido.cliente,
              idCanal: pedido.idCanal ?? null,
              idVendedor: pedido.idVendedor,
              idProducto: detalle?.idProducto ?? null,
              cantPedido: detalle?.cantPedido ?? null,
              precio: detalle?.precio ?? null,
              observaciones: pedido.observaciones ?? null,
              listaPrecio: pedido.listaPrecio ?? null,
              fechaEntrega: pedido.fechaEntrega ?? null,
              estatus: data.estatus,
              estatusAnterior: data.estatusAnterior,
              cantAtencion: detalle?.cantAtencion ?? null,
              precioAtencion: detalle?.precioAtencion ?? null,
              causaDiferencia: detalle?.causaDiferencia ?? null,
              obserDiferencia: detalle?.obserDiferencia ?? null,
              causaNoAtencion: data.causaNoAtencion ?? null,
              obserNoAtencion: data.obserNoAtencion ?? null,
              usrAlta: pedido.idVendedor ?? null,
              fueraAgenda: pedido.fueraAgenda ?? null,
              no_venta: pedido.no_venta ?? null,
              tipoCambio: data.tipoCambio,
              enviado: false,
            },
            Realm.UpdateMode.Modified
          );
        });
      });
    } catch (error) {
      console.error("[PedidosService] Error al registrar bitácora de estado:", error);
    }
  }

  private getClienteById(idCliente: number): any {
    try {
      const realm = this.getRealm();
      const cliente = realm.objectForPrimaryKey("ClienteFull", idCliente);
      return cliente;
    } catch {
      return null;
    }
  }

  private getProductoById(idProducto: number): any {
    try {
      const realm = this.getRealm();
      const producto = realm.objectForPrimaryKey("Producto", idProducto);
      return producto;
    } catch {
      return null;
    }
  }

  private getEstatusDescripcion(estatus: number): string {
    try {
      const realm = this.getRealm();
      const catalogo = realm.objectForPrimaryKey("CatalogoEstatusPedido", estatus) as any;
      return catalogo?.descripcion || "Desconocido";
    } catch {
      return "Desconocido";
    }
  }

  private getCausaDiferenciaDescripcion(id: number): string {
    try {
      const realm = this.getRealm();
      const catalogo = realm.objectForPrimaryKey("CatalogoCausaDiferencia", id) as any;
      return catalogo?.descripcion || "";
    } catch {
      return "";
    }
  }
}

export default PedidosService;
