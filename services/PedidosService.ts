import Realm from "realm";
import { fetchWithTimeout } from "./fetchWithTimeout";
import AuthService from "./AuthService";

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
  folio: number;
  fecha: Date;
  ruta: number;
  cliente: number;
  idVendedor: number;
  idProducto?: number;
  estatus: number;
  estatusAnterior?: number;
  cantPedido?: number;
  cantAtencion?: number;
  causaDiferencia?: number;
  obserDiferencia?: string;
  causaNoAtencion?: number;
  obserNoAtencion?: string;
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

class PedidosService {
  private static instance: PedidosService;
  private realm: Realm | null = null;
  private apiBaseUrl = "https://api.cbinformatica.net:9031";

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

  async syncPedidos(ruta: number): Promise<{ success: boolean; count: number }> {
    try {
      const endpoint = `${this.apiBaseUrl}/api/MovilesVentas/sp_MovilesPedidosFull/${ruta}`;
      const response = await fetchWithTimeout(endpoint);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const pedidosData = await response.json();

      if (!Array.isArray(pedidosData)) {
        throw new Error("La respuesta no es un array de pedidos");
      }

      const realm = this.getRealm();
      let nuevos = 0;

      realm.write(() => {
        pedidosData.forEach((pedido: any) => {
          const cliente = this.getClienteById(pedido.cliente);

          realm.create(
            "Pedido",
            {
              id: pedido.folio,
              folio: pedido.folio,
              fecha: pedido.fecha ? new Date(pedido.fecha) : null,
              ruta: pedido.ruta,
              cliente: pedido.cliente,
              clienteNombre: cliente?.nombre || `Cliente #${pedido.cliente}`,
              clienteDomicilio: cliente?.domicilio || "",
              idCanal: null,
              fechaAtencion: null,
              idVendedor: pedido.idVendedor,
              numeroProductos: pedido.numeroProductos,
              cantPedido: pedido.cantPedido,
              listaPrecio: pedido.listaPrecio,
              fechaEntrega: pedido.fechaEntrega ? new Date(pedido.fechaEntrega) : null,
              estatus: pedido.estatus,
              estatusDescripcion: this.getEstatusDescripcion(pedido.estatus),
              fueraAgenda: pedido.fueraAgenda,
              observaciones: pedido.observaciones,
              no_venta: pedido.noVenta,
              tieneDiferencia: false,
              syncedAt: new Date(),
              modificadoLocal: false,
            },
            Realm.UpdateMode.Modified,
          );
          nuevos++;
        });
      });

      console.log(`[PedidosService] Sincronizados ${nuevos} pedidos para ruta ${ruta}`);
      return { success: true, count: nuevos };
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
            realm.create(
              "CatalogoEstatusPedido",
              { id: item.id, descripcion: item.descripcion },
              Realm.UpdateMode.Modified,
            );
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
              Realm.UpdateMode.Modified,
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
              Realm.UpdateMode.Modified,
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
        "ruta = $0 AND estatus != $1 AND estatus != $2 AND estatus != $3",
        ruta,
        ESTATUS_PEDIDO.ENTREGADO,
        ESTATUS_PEDIDO.CANCELADO,
        ESTATUS_PEDIDO.ENTREGADO_PARCIAL,
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
      .filtered("ruta = $0 AND estatus = $1", ruta, ESTATUS_PEDIDO.PENDIENTE_SIN_CAUSA);
    return Array.from(pedidos) as unknown as Pedido[];
  }

  puedeCerrarRuta(ruta: number): { permitido: boolean; pedidosBloqueantes: Pedido[] } {
    const bloqueantes = this.getPedidosConEstatusPendienteSinCausa(ruta);
    return {
      permitido: bloqueantes.length === 0,
      pedidosBloqueantes: bloqueantes,
    };
  }

  cambiarEstatusPedido(idPedido: number, nuevoEstatus: number, causaNoAtencion?: number, obserNoAtencion?: string): boolean {
    try {
      const realm = this.getRealm();
      const pedido = realm.objectForPrimaryKey("Pedido", idPedido) as any;

      if (!pedido) {
        console.error("[PedidosService] Pedido no encontrado:", idPedido);
        return false;
      }

      if (
        pedido.estatus === ESTATUS_PEDIDO.ENTREGADO ||
        pedido.estatus === ESTATUS_PEDIDO.CANCELADO ||
        pedido.estatus === ESTATUS_PEDIDO.ENTREGADO_PARCIAL ||
        pedido.estatus === ESTATUS_PEDIDO.PENDIENTE_CON_CAUSA
      ) {
        console.error("[PedidosService] No se puede modificar pedido con estatus:", pedido.estatus);
        return false;
      }

      const estatusAnterior = pedido.estatus;

      realm.write(() => {
        pedido.estatus = nuevoEstatus;
        pedido.estatusDescripcion = this.getEstatusDescripcion(nuevoEstatus);
        pedido.modificadoLocal = true;
        pedido.syncedAt = new Date();

        if (causaNoAtencion) {
          pedido.causaNoAtencion = causaNoAtencion;
          pedido.obserNoAtencion = obserNoAtencion || "";
        }
      });

      this.registrarBitacora({
        idPedido,
        folio: pedido.folio,
        ruta: pedido.ruta,
        cliente: pedido.cliente,
        idVendedor: pedido.idVendedor,
        estatus: nuevoEstatus,
        estatusAnterior,
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

      const cantPedidoAnterior = detalle.cantAtencion;
      const tieneDiferencia = cantAtencion < detalle.cantPedido;

      realm.write(() => {
        detalle.cantAtencion = cantAtencion;
        detalle.tieneDiferencia = tieneDiferencia;
        detalle.atendido = cantAtencion > 0;
        detalle.modificadoLocal = true;
      });

      this.registrarBitacora({
        idPedido,
        folio: this.getPedidoById(idPedido)?.folio || 0,
        ruta: this.getPedidoById(idPedido)?.ruta || 0,
        cliente: this.getPedidoById(idPedido)?.cliente || 0,
        idVendedor: this.getPedidoById(idPedido)?.idVendedor || 0,
        idProducto,
        estatus: this.getPedidoById(idPedido)?.estatus || 0,
        cantPedido: detalle.cantPedido,
        cantAtencion,
        tipoCambio: "cantidad",
      });

      console.log(`[PedidosService] Cantidad actualizada: ${cantPedidoAnterior} -> ${cantAtencion}`);
      return true;
    } catch (error) {
      console.error("[PedidosService] Error al actualizar cantidad:", error);
      return false;
    }
  }

  registrarCausaDiferencia(idPedido: number, idProducto: number, causaDiferencia: number, obserDiferencia?: string): boolean {
    try {
      const realm = this.getRealm();
      const idDetalle = `${idPedido}-${idProducto}`;
      const detalle = realm.objectForPrimaryKey("PedidoDetalle", idDetalle) as any;

      if (!detalle) {
        console.error("[PedidosService] Detalle no encontrado:", idDetalle);
        return false;
      }

      const causaDesc = this.getCausaDiferenciaDescripcion(causaDiferencia);

      realm.write(() => {
        detalle.causaDiferencia = causaDiferencia;
        detalle.causaDiferenciaDesc = causaDesc;
        detalle.obserDiferencia = obserDiferencia || "";
        detalle.modificadoLocal = true;
      });

      this.registrarBitacora({
        idPedido,
        folio: this.getPedidoById(idPedido)?.folio || 0,
        ruta: this.getPedidoById(idPedido)?.ruta || 0,
        cliente: this.getPedidoById(idPedido)?.cliente || 0,
        idVendedor: this.getPedidoById(idPedido)?.idVendedor || 0,
        idProducto,
        estatus: this.getPedidoById(idPedido)?.estatus || 0,
        causaDiferencia,
        obserDiferencia,
        tipoCambio: "causa",
      });

      console.log(`[PedidosService] Causa diferencia registrada: ${causaDiferencia}`);
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

  private registrarBitacora(data: Partial<PedidoBitacora>): void {
    const realm = this.getRealm();
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    realm.write(() => {
      realm.create(
        "PedidoBitacora",
        {
          id,
          idPedido: data.idPedido,
          folio: data.folio,
          fecha: new Date(),
          ruta: data.ruta,
          cliente: data.cliente,
          idVendedor: data.idVendedor,
          idProducto: data.idProducto,
          estatus: data.estatus,
          estatusAnterior: data.estatusAnterior,
          cantPedido: data.cantPedido,
          cantAtencion: data.cantAtencion,
          causaDiferencia: data.causaDiferencia,
          obserDiferencia: data.obserDiferencia,
          causaNoAtencion: data.causaNoAtencion,
          obserNoAtencion: data.obserNoAtencion,
          tipoCambio: data.tipoCambio,
          enviado: false,
        },
        Realm.UpdateMode.Modified,
      );
    });
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
