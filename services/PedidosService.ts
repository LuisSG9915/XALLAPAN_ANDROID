import Realm from "realm";
import { fetchWithTimeout } from "./fetchWithTimeout";
import AuthService from "./AuthService";
import PedidoNotificacionService from "./PedidoNotificacionService";
import { PedidoEstadoUploadSyncTask } from "./sync/tasks/PedidoBitacoraUploadSyncTask";

// Generación de id_movil corto e irrepetible para pedidos/ventas locales.
// Estructura: MOVIL_ID_BASE + (segundos desde EPOCH * 1000) + sucursal
//  - Siempre > 1700000000 (umbral que distingue registros locales de los del servidor)
//  - La sucursal queda en los últimos 3 dígitos (id_movil % 1000 === sucursal)
//  - La guardia monotónica evita colisiones si se generan dos en el mismo segundo
const MOVIL_ID_BASE = 1700000000;
const MOVIL_ID_EPOCH_SECONDS = 1704067200; // 2024-01-01 00:00:00 UTC
let lastMovilSeconds = 0;

export interface Pedido {
  id: string;
  idPedido?: number;
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
  // Campos del producto (tabla unica)
  idProducto: number;
  productoNombre?: string;
  cantAtencion?: number;
  precio?: number;
  precioAtencion?: number;
  causaDiferencia?: number;
  causaDiferenciaDesc?: string;
  obserDiferencia?: string;
  atendido?: boolean;
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

export interface PedidoEstado {
  id: string;
  ruta: number;
  pedido: number;
  fecha: Date;
  estado: number;
  idVendedor: number;
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

// Estados en los que el pedido ya fue atendido/cerrado y no admite modificacion
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
    const user = AuthService.currentUser;
    const sucursal = user?.sucursal_origen || user?.sucursal || 1;
    let seconds = Math.floor(Date.now() / 1000) - MOVIL_ID_EPOCH_SECONDS;
    if (seconds <= lastMovilSeconds) {
      seconds = lastMovilSeconds + 1;
    }
    lastMovilSeconds = seconds;
    return MOVIL_ID_BASE + seconds * 1000 + (sucursal % 1000);
  }

  private puedeModificar(estatus: number): boolean {
    return !ESTADOS_FINALES.includes(estatus);
  }

  private buildPedidoId(folio: number, idProducto: number): string {
    return `${folio}-${idProducto}`;
  }

  async syncPedidos(ruta: number): Promise<{ success: boolean; count: number }> {
    try {
      console.log(`[PedidosService.syncPedidos] === INICIANDO sincronizacion para ruta ${ruta} ===`);

      if (!ruta || ruta === 0) {
        console.error(`[PedidosService.syncPedidos] Ruta invalida: ${ruta}`);
        return { success: false, count: 0 };
      }

      const endpoint = `${this.apiBaseUrl}/api/MovilesVentas/sp_MovilesPedidosFull/${ruta}`;
      console.log(`[PedidosService.syncPedidos] Endpoint: ${endpoint}`);

      const response = await fetchWithTimeout(endpoint);
      console.log(`[PedidosService.syncPedidos] Respuesta HTTP: ${response.status}`);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const rows = await response.json();
      console.log(`[PedidosService.syncPedidos] JSON recibido, es array: ${Array.isArray(rows)}, length: ${Array.isArray(rows) ? rows.length : "N/A"}`);

      if (!Array.isArray(rows)) {
        throw new Error("La respuesta no es un array de pedidos");
      }

      const realm = this.getRealm();
      let nuevosPedidos = 0;
      const foliosNuevos = new Set<number>();

      realm.write(() => {
        rows.forEach((row: any) => {
          const folio = row.folio;
          const idProducto = row.idProducto;
          const id = this.buildPedidoId(folio, idProducto);
          const pedidoExistente = realm.objectForPrimaryKey("Pedido", id) as any;

          const estatusServidor = Number(row.estatus);
          const conservarLocal =
            pedidoExistente?.modificadoLocal === true &&
            [ESTATUS_PEDIDO.EN_ATENCION, ESTATUS_PEDIDO.EN_CAPTURA].includes(Number(pedidoExistente.estatus)) &&
            !ESTADOS_FINALES.includes(estatusServidor);
          const estatusFinal = conservarLocal ? pedidoExistente.estatus : estatusServidor;
          const fechaAtencionFinal = conservarLocal ? pedidoExistente.fechaAtencion : null;
          const causaNoAtencionFinal = conservarLocal ? pedidoExistente.causaNoAtencion : null;
          const obserNoAtencionFinal = conservarLocal ? pedidoExistente.obserNoAtencion : null;

          const producto = this.getProductoById(idProducto);
          const cantPedido = parseFloat(row.cantPedido) || 0;
          const cantAtencionFinal = pedidoExistente?.cantAtencion ?? null;
          const tieneDiferencia =
            cantAtencionFinal !== null && cantAtencionFinal !== undefined && cantAtencionFinal < cantPedido;

          realm.create(
            "Pedido",
            {
              id,
              idPedido: folio,
              id_movil: pedidoExistente?.id_movil ?? null,
              folio,
              fecha: row.fecha ? new Date(row.fecha) : null,
              ruta: row.ruta,
              cliente: row.cliente,
              clienteNombre: row.nombreCliente ?? row.clienteNombre ?? row.nombre_cliente ?? `Cliente #${row.cliente}`,
              clienteDomicilio: row.clienteDomicilio ?? row.domicilioCliente ?? row.domicilio ?? "",
              idCanal: null,
              fechaAtencion: fechaAtencionFinal,
              idVendedor: row.idVendedor,
              numeroProductos: row.numeroProductos ?? 1,
              cantPedido,
              listaPrecio: row.listaPrecio,
              fechaEntrega: row.fechaEntrega ? new Date(row.fechaEntrega) : null,
              estatus: estatusFinal,
              estatusDescripcion: this.getEstatusDescripcion(estatusFinal),
              fueraAgenda: row.fueraAgenda,
              observaciones: row.observaciones,
              no_venta: row.noVenta,
              tieneDiferencia,
              causaNoAtencion: causaNoAtencionFinal,
              obserNoAtencion: obserNoAtencionFinal,
              syncedAt: new Date(),
              modificadoLocal: pedidoExistente?.modificadoLocal ?? false,
              idProducto,
              productoNombre: producto?.descripcion || `Producto #${idProducto}`,
              cantAtencion: cantAtencionFinal,
              precio: row.precio ?? null,
              precioAtencion: pedidoExistente?.precioAtencion ?? row.precioAtencion ?? null,
              causaDiferencia: pedidoExistente?.causaDiferencia ?? null,
              causaDiferenciaDesc: pedidoExistente?.causaDiferencia
                ? this.getCausaDiferenciaDescripcion(pedidoExistente.causaDiferencia)
                : null,
              obserDiferencia: pedidoExistente?.obserDiferencia ?? null,
              atendido: cantAtencionFinal !== null && cantAtencionFinal !== undefined && cantAtencionFinal > 0,
            },
            Realm.UpdateMode.Modified
          );

          if (!pedidoExistente) {
            nuevosPedidos++;
            foliosNuevos.add(folio);
          }
        });
      });

      console.log(`[PedidosService] Sincronizados ${nuevosPedidos} renglones nuevos para ruta ${ruta}`);

      // Verificacion post-guardado
      const pedidosGuardados = realm.objects("Pedido").length;
      console.log(`[PedidosService.syncPedidos] Post-guardado: ${pedidosGuardados} renglones en Realm`);

      // Notificar pedidos nuevos y registrar en agenda
      try {
        PedidoNotificacionService.setRealm(realm);
        await PedidoNotificacionService.procesarPedidosSincronizados(Array.from(foliosNuevos));
      } catch (notifError) {
        console.warn("[PedidosService] Error al notificar pedidos nuevos:", notifError);
      }

      console.log(`[PedidosService.syncPedidos] === COMPLETADO ===`);
      return { success: true, count: nuevosPedidos };
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

  /**
   * Devuelve todos los renglones de pedidos de una ruta.
   */
  getPedidosByRuta(ruta: number): Pedido[] {
    const realm = this.getRealm();
    const pedidos = realm.objects("Pedido").filtered("ruta = $0", ruta);
    console.log(`[PedidosService.getPedidosByRuta] Ruta ${ruta}: ${pedidos.length} renglones`);
    return Array.from(pedidos) as unknown as Pedido[];
  }

  /**
   * Devuelve los folios unicos de una ruta (para listado de pedidos).
   */
  getFoliosByRuta(ruta: number): number[] {
    const realm = this.getRealm();
    const pedidos = realm.objects("Pedido").filtered("ruta = $0", ruta);
    const foliosCancelados = new Set<number>();
    const folios = new Set<number>();

    Array.from(pedidos).forEach((p: any) => {
      if (Number(p.estatus) === ESTATUS_PEDIDO.CANCELADO) {
        foliosCancelados.add(Number(p.folio));
      } else {
        folios.add(Number(p.folio));
      }
    });

    foliosCancelados.forEach((folio) => folios.delete(folio));
    return Array.from(folios);
  }

  /**
   * Devuelve un pedido representativo por folio (cabecera).
   */
  getPedidoByFolio(folio: number): Pedido | null {
    const realm = this.getRealm();
    const pedidos = realm.objects("Pedido").filtered("folio = $0", folio);
    if (pedidos.length === 0) return null;
    return pedidos[0] as unknown as Pedido;
  }

  /**
   * Devuelve todos los productos de un folio.
   */
  getProductosByFolio(folio: number): Pedido[] {
    const realm = this.getRealm();
    const pedidos = realm.objects("Pedido").filtered("folio = $0", folio);
    const productos = Array.from(pedidos) as unknown as Pedido[];
    console.log(
      `[PedidosService] Productos en Realm para folio ${folio}: ${productos.length}`,
      productos.map((producto: any) => ({
        id: producto.id,
        folio: producto.folio,
        idProducto: producto.idProducto,
        productoNombre: producto.productoNombre,
        cantPedido: producto.cantPedido,
      })),
    );
    return productos;
  }

  actualizarPedidosDesdeRespuesta(rows: any[]): number {
    if (!Array.isArray(rows) || rows.length === 0) return 0;

    const realm = this.getRealm();
    let actualizados = 0;

    realm.write(() => {
      rows.forEach((row: any) => {
        const folio = Number(row?.folio ?? row?.folioPedido ?? row?.idPedido);
        const idProducto = Number(row?.idProducto);
        if (!Number.isFinite(folio) || !Number.isFinite(idProducto)) return;

        const pedido = realm.objectForPrimaryKey("Pedido", this.buildPedidoId(folio, idProducto)) as any;
        if (!pedido) return;

        const estatusServidor = Number(row.estatus);
        const conservarLocal =
          pedido.modificadoLocal === true &&
          [ESTATUS_PEDIDO.EN_ATENCION, ESTATUS_PEDIDO.EN_CAPTURA].includes(Number(pedido.estatus)) &&
          !ESTADOS_FINALES.includes(estatusServidor);

        if (!conservarLocal && Number.isFinite(estatusServidor) && pedido.estatus !== estatusServidor) {
          pedido.estatus = estatusServidor;
          pedido.estatusDescripcion = this.getEstatusDescripcion(estatusServidor);
        }
        if (row.fecha !== undefined) pedido.fecha = row.fecha ? new Date(row.fecha) : null;
        if (row.fechaEntrega !== undefined) pedido.fechaEntrega = row.fechaEntrega ? new Date(row.fechaEntrega) : null;
        if (row.ruta !== undefined) pedido.ruta = Number(row.ruta);
        if (row.cliente !== undefined) pedido.cliente = Number(row.cliente);
        if (row.idVendedor !== undefined) pedido.idVendedor = Number(row.idVendedor);
        if (row.numeroProductos !== undefined) pedido.numeroProductos = Number(row.numeroProductos);
        if (row.cantPedido !== undefined) pedido.cantPedido = Number(row.cantPedido) || 0;
        if (row.listaPrecio !== undefined) pedido.listaPrecio = row.listaPrecio;
        if (row.observaciones !== undefined) pedido.observaciones = row.observaciones;
        if (row.noVenta !== undefined) pedido.no_venta = row.noVenta;
        if (row.fueraAgenda !== undefined) pedido.fueraAgenda = row.fueraAgenda;
        if (row.nombreCliente !== undefined) pedido.clienteNombre = row.nombreCliente;
        if (row.domicilioCliente !== undefined) pedido.clienteDomicilio = row.domicilioCliente;
        pedido.syncedAt = new Date();
        actualizados++;
      });
    });

    if (actualizados > 0) {
      console.log(`[PedidosService] Actualizados ${actualizados} renglones desde sp_MovilesPedidos`);
    }
    return actualizados;
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

  iniciarAtencionPedido(folio: number): boolean {
    return this.cambiarEstatusPedido(folio, ESTATUS_PEDIDO.EN_ATENCION);
  }

  cambiarEstatusPedido(
    folio: number,
    nuevoEstatus: number,
    causaNoAtencion?: number,
    obserNoAtencion?: string
  ): boolean {
    try {
      const realm = this.getRealm();
      const renglones = realm.objects("Pedido").filtered("folio = $0", folio);

      if (renglones.length === 0) {
        console.error("[PedidosService] Pedido no encontrado:", folio);
        return false;
      }

      const primerRenglon = renglones[0] as any;
      if (!this.puedeModificar(primerRenglon.estatus)) {
        console.error("[PedidosService] No se puede modificar pedido con estatus:", primerRenglon.estatus);
        return false;
      }

      const estatusAnterior = primerRenglon.estatus;
      const ahora = new Date();

      realm.write(() => {
        Array.from(renglones).forEach((renglon: any) => {
          renglon.estatus = nuevoEstatus;
          renglon.estatusDescripcion = this.getEstatusDescripcion(nuevoEstatus);
          renglon.modificadoLocal = true;
          renglon.syncedAt = ahora;

          if (
            nuevoEstatus === ESTATUS_PEDIDO.EN_ATENCION ||
            nuevoEstatus === ESTATUS_PEDIDO.ENTREGADO ||
            nuevoEstatus === ESTATUS_PEDIDO.ENTREGADO_PARCIAL ||
            nuevoEstatus === ESTATUS_PEDIDO.PENDIENTE_CON_CAUSA
          ) {
            renglon.fechaAtencion = renglon.fechaAtencion || ahora;
          }

          if (causaNoAtencion) {
            renglon.causaNoAtencion = causaNoAtencion;
            renglon.obserNoAtencion = obserNoAtencion || "";
          }
        });

        // Si el pedido de central (fuera de agenda) se atiende/cierre, marcar visita como realizada
        if (
          nuevoEstatus === ESTATUS_PEDIDO.ENTREGADO ||
          nuevoEstatus === ESTATUS_PEDIDO.ENTREGADO_PARCIAL ||
          nuevoEstatus === ESTATUS_PEDIDO.PENDIENTE_CON_CAUSA ||
          nuevoEstatus === ESTATUS_PEDIDO.CANCELADO
        ) {
          this.marcarVisitaFueraAgendaComoVisitada(folio);
        }
      });

      if ([
        ESTATUS_PEDIDO.ENTREGADO,
        ESTATUS_PEDIDO.ENTREGADO_PARCIAL,
        ESTATUS_PEDIDO.PENDIENTE_CON_CAUSA,
      ].includes(nuevoEstatus)) {
        this.registrarBitacoraEstado({
          folio,
          estatusAnterior,
          estatus: nuevoEstatus,
          tipoCambio: "estatus",
          causaNoAtencion,
          obserNoAtencion,
        });
      } else {
        this.registrarEstadoPedido({
          folio,
          estatus: nuevoEstatus,
        });
      }
      if ([
        ESTATUS_PEDIDO.ENTREGADO,
        ESTATUS_PEDIDO.ENTREGADO_PARCIAL,
        ESTATUS_PEDIDO.PENDIENTE_CON_CAUSA,
      ].includes(nuevoEstatus)) {
        const bitacorasPendientes = realm
          .objects("PedidoBitacora")
          .filtered("folio = $0 AND estatus = $1 AND enviado = false", folio, nuevoEstatus);
        console.log(
          `[PedidosService] Bitácoras de cierre pendientes folio=${folio}, estatus=${nuevoEstatus}: ${bitacorasPendientes.length}`,
        );
      }

      if (
        nuevoEstatus !== ESTATUS_PEDIDO.EN_ATENCION &&
        ![
          ESTATUS_PEDIDO.ENTREGADO,
          ESTATUS_PEDIDO.ENTREGADO_PARCIAL,
          ESTATUS_PEDIDO.PENDIENTE_CON_CAUSA,
        ].includes(nuevoEstatus)
      ) {
        this.enviarEstadoInmediato();
      }

      console.log(`[PedidosService] Estatus cambiado: ${estatusAnterior} -> ${nuevoEstatus}`);
      return true;
    } catch (error) {
      console.error("[PedidosService] Error al cambiar estatus:", error);
      return false;
    }
  }

  actualizarCantAtencion(folio: number, idProducto: number, cantAtencion: number): boolean {
    try {
      const realm = this.getRealm();
      const id = this.buildPedidoId(folio, idProducto);
      const renglon = realm.objectForPrimaryKey("Pedido", id) as any;

      if (!renglon) {
        console.error("[PedidosService] Renglon no encontrado:", id);
        return false;
      }

      if (!this.puedeModificar(renglon.estatus)) {
        console.error("[PedidosService] No se puede modificar cantidad del pedido:", renglon.estatus);
        return false;
      }

      const cantAtencionAnterior = renglon.cantAtencion;
      const tieneDiferencia = cantAtencion !== renglon.cantPedido;

      realm.write(() => {
        renglon.cantAtencion = cantAtencion;
        renglon.tieneDiferencia = tieneDiferencia;
        renglon.atendido = cantAtencion > 0;
        renglon.modificadoLocal = true;
      });

      // No se registra bitácora de detalle; solo en cambio de estado

      console.log(`[PedidosService] Cantidad actualizada: ${idProducto} -> ${cantAtencion}`);
      return true;
    } catch (error) {
      console.error("[PedidosService] Error al actualizar cantidad:", error);
      return false;
    }
  }

  actualizarPrecioAtencion(folio: number, idProducto: number, precioAtencion: number): boolean {
    try {
      const realm = this.getRealm();
      const id = this.buildPedidoId(folio, idProducto);
      const renglon = realm.objectForPrimaryKey("Pedido", id) as any;

      if (!renglon || !this.puedeModificar(renglon.estatus)) {
        console.error("[PedidosService] No se puede modificar precio del pedido");
        return false;
      }

      const precioAtencionAnterior = renglon.precioAtencion;

      realm.write(() => {
        renglon.precioAtencion = precioAtencion;
        renglon.modificadoLocal = true;
      });

      // No se registra bitácora de detalle; solo en cambio de estado

      console.log(`[PedidosService] Precio atencion actualizado: ${idProducto} -> ${precioAtencion}`);
      return true;
    } catch (error) {
      console.error("[PedidosService] Error al actualizar precio:", error);
      return false;
    }
  }

  registrarCausaDiferencia(
    folio: number,
    idProducto: number,
    causaDiferencia: number,
    obserDiferencia?: string
  ): boolean {
    try {
      const realm = this.getRealm();
      const id = this.buildPedidoId(folio, idProducto);
      const renglon = realm.objectForPrimaryKey("Pedido", id) as any;

      if (!renglon || !this.puedeModificar(renglon.estatus)) {
        console.error("[PedidosService] No se puede registrar causa del pedido:", renglon?.estatus);
        return false;
      }

      const causaDesc = this.getCausaDiferenciaDescripcion(causaDiferencia);
      const causaAnterior = renglon.causaDiferencia;
      const obserAnterior = renglon.obserDiferencia;

      realm.write(() => {
        renglon.causaDiferencia = causaDiferencia;
        renglon.causaDiferenciaDesc = causaDesc;
        renglon.obserDiferencia = obserDiferencia || "";
        renglon.modificadoLocal = true;
      });

      // No se registra bitácora de detalle; solo en cambio de estado

      if (obserDiferencia && obserDiferencia !== obserAnterior) {
        // No se registra bitácora de detalle; solo en cambio de estado
      }

      console.log(`[PedidosService] Causa diferencia registrada: ${idProducto} -> ${causaDiferencia}`);
      return true;
    } catch (error) {
      console.error("[PedidosService] Error al registrar causa:", error);
      return false;
    }
  }

  /**
   * Finaliza un pedido asignando id_movil a todos sus renglones.
   */
  finalizarPedido(
    folio: number,
    nuevoEstatus: number,
    causaNoAtencion?: number,
    obserNoAtencion?: string
  ): { success: boolean; idMovil?: number } {
    try {
      const realm = this.getRealm();
      const renglones = realm.objects("Pedido").filtered("folio = $0", folio);

      if (renglones.length === 0) {
        console.error("[PedidosService] Pedido no encontrado para finalizar:", folio);
        return { success: false };
      }

      const idMovilExistente = Number((renglones[0] as any).id_movil);
      const idMovil = Number.isFinite(idMovilExistente) && idMovilExistente >= MOVIL_ID_BASE
        ? idMovilExistente
        : this.getNextIdMovil();

      // Asignar id_movil ANTES de cambiar estatus para que la bitacora lo registre
      realm.write(() => {
        Array.from(renglones).forEach((renglon: any) => {
          renglon.id_movil = idMovil;
          renglon.modificadoLocal = true;
        });
      });

      const success = this.cambiarEstatusPedido(folio, nuevoEstatus, causaNoAtencion, obserNoAtencion);

      if (!success) {
        return { success: false };
      }

      console.log(`[PedidosService] Pedido ${folio} finalizado con id_movil ${idMovil}`);
      return { success: true, idMovil };
    } catch (error) {
      console.error("[PedidosService] Error al finalizar pedido:", error);
      return { success: false };
    }
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
    console.log(`[PedidosService.getAllPedidos] Renglones en Realm: ${pedidos.length}`);
    return Array.from(pedidos) as unknown as Pedido[];
  }

  getAllBitacoras(): PedidoBitacora[] {
    const realm = this.getRealm();
    const bitacoras = realm.objects("PedidoBitacora");
    return Array.from(bitacoras) as unknown as PedidoBitacora[];
  }

  private marcarVisitaFueraAgendaComoVisitada(folio: number): void {
    try {
      const realm = this.getRealm();
      const renglones = realm.objects("Pedido").filtered("folio = $0", folio);
      const clienteId = renglones.length > 0 ? (renglones[0] as any).cliente : null;
      const inicioDia = new Date();
      inicioDia.setHours(0, 0, 0, 0);
      const finDia = new Date(inicioDia);
      finDia.setHours(23, 59, 59, 999);

      if (clienteId !== null && clienteId !== undefined) {
        const visitasDelCliente = realm
          .objects("Visita")
          .filtered("idCliente == $0 AND fecha >= $1 AND fecha <= $2", clienteId, inicioDia, finDia);
        visitasDelCliente.forEach((visita: any) => {
          if (visita.visitado === 0) {
            visita.visitado = 1;
          }
        });
      }

      const idCompuesto = `pedido-${folio}-${inicioDia.toISOString().split("T")[0]}`;
      const visitaFueraAgenda = realm.objectForPrimaryKey("Visita", idCompuesto) as any;
      if (visitaFueraAgenda && visitaFueraAgenda.visitado === 0) {
        visitaFueraAgenda.visitado = 1;
      }

      console.log(`[PedidosService] Visitas del pedido ${folio} marcadas como visitadas`);
    } catch (error) {
      console.warn("[PedidosService] Error al marcar visita fuera de agenda:", error);
    }
  }

  private registrarEstadoPedido(data: {
    folio: number;
    estatus: number;
  }): void {
    try {
      const realm = this.getRealm();
      const renglon = realm.objects("Pedido").filtered("folio = $0", data.folio)[0] as any;
      if (!renglon) return;

      realm.write(() => {
        realm.create(
          "PedidoEstado",
          {
            id: `estado-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
            ruta: renglon.ruta,
            pedido: Number(renglon.folio),
            fecha: new Date(),
            estado: data.estatus,
            idVendedor: renglon.idVendedor,
            enviado: false,
          },
          Realm.UpdateMode.Modified,
        );
      });
    } catch (error) {
      console.error("[PedidosService] Error al registrar estado del pedido:", error);
    }
  }

  private registrarBitacoraEstado(data: {
    folio: number;
    estatusAnterior: number;
    estatus: number;
    tipoCambio: string;
    causaNoAtencion?: number;
    obserNoAtencion?: string;
  }): void {
    try {
      const realm = this.getRealm();
      const renglones = realm.objects("Pedido").filtered("folio = $0", data.folio);
      if (renglones.length === 0) return;

      const primerRenglon = renglones[0] as any;
      const idPedido = Number(primerRenglon.folio ?? data.folio);
      const idMovilPedido = primerRenglon.id_movil ?? this.getNextIdMovil();
      const ahora = new Date();
      console.log(
        `[PedidosService] Creando bitácora folio=${data.folio}, estatusAnterior=${data.estatusAnterior}, estatus=${data.estatus}, renglones=${renglones.length}`,
      );

      realm.write(() => {
        Array.from(renglones).forEach((renglon: any, index: number) => {
          if (renglon.id_movil !== idMovilPedido) {
            renglon.id_movil = idMovilPedido;
          }
          const idLocal = `${Date.now()}-${index}-${Math.random().toString(36).substr(2, 5)}`;

          realm.create(
            "PedidoBitacora",
            {
              id: idLocal,
              idPedido,
              id_movil: idMovilPedido,
              folio: idPedido,
              fecha: ahora,
              ruta: renglon.ruta,
              cliente: renglon.cliente,
              idCanal: null,
              idVendedor: renglon.idVendedor,
              idProducto: renglon.idProducto ?? null,
              cantPedido: null,
              precio: renglon.precio ?? null,
              observaciones: renglon.observaciones ?? null,
              listaPrecio: null,
              fechaEntrega: null,
              estatus: data.estatus,
              estatusAnterior: data.estatusAnterior,
              cantAtencion: renglon.cantAtencion ?? null,
              precioAtencion: renglon.precioAtencion ?? null,
              causaDiferencia: renglon.causaDiferencia ?? null,
              obserDiferencia: renglon.obserDiferencia ?? null,
              causaNoAtencion: data.causaNoAtencion ?? null,
              obserNoAtencion: data.obserNoAtencion ?? null,
              usrAlta: renglon.idVendedor ?? null,
              fueraAgenda: null,
              no_venta: renglon.no_venta ?? null,
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

  private enviarEstadoInmediato(): void {
    try {
      const realm = this.getRealm();
      const syncLogId = `realtime-${Date.now()}`;
      const task = new PedidoEstadoUploadSyncTask(realm, syncLogId);
      task.execute().catch((error) => {
        console.warn("[PedidosService] Error enviando estado en tiempo real:", error);
      });
    } catch (error) {
      console.warn("[PedidosService] No se pudo iniciar envío de estado:", error);
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
