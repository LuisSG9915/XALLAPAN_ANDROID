import Realm from "realm";
import { fetchWithTimeout } from "./fetchWithTimeout";
import AuthService from "./AuthService";
import PedidoNotificacionService from "./PedidoNotificacionService";
import { PedidoBitacoraUploadSyncTask } from "./sync/tasks/PedidoBitacoraUploadSyncTask";

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

          const conservarLocal = pedidoExistente?.modificadoLocal === true;
          const estatusFinal = conservarLocal ? pedidoExistente.estatus : row.estatus;
          const fechaAtencionFinal = conservarLocal ? pedidoExistente.fechaAtencion : null;
          const causaNoAtencionFinal = conservarLocal ? pedidoExistente.causaNoAtencion : null;
          const obserNoAtencionFinal = conservarLocal ? pedidoExistente.obserNoAtencion : null;

          const cliente = this.getClienteById(row.cliente);
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
              clienteNombre: cliente?.nombre || `Cliente #${row.cliente}`,
              clienteDomicilio: cliente?.domicilio || "",
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
              precioAtencion: pedidoExistente?.precioAtencion ?? null,
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
    const folios = new Set<number>();
    Array.from(pedidos).forEach((p: any) => folios.add(p.folio));
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

      // Registrar bitacora con snapshot completo de todos los renglones
      this.registrarBitacoraEstado({
        folio,
        estatusAnterior,
        estatus: nuevoEstatus,
        tipoCambio: "estatus",
        causaNoAtencion,
        obserNoAtencion,
      });

      // Enviar bitácora al servidor en tiempo real
      this.enviarBitacoraInmediata();

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

      const idMovil = this.getNextIdMovil();

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
      const hoy = new Date();
      hoy.setHours(0, 0, 0, 0);
      const idCompuesto = `pedido-${folio}-${hoy.toISOString().split("T")[0]}`;
      const visita = realm.objectForPrimaryKey("Visita", idCompuesto) as any;
      if (visita) {
        visita.visitado = 1;
        console.log(`[PedidosService] Visita fuera de agenda ${idCompuesto} marcada como visitada`);
      }
    } catch (error) {
      console.warn("[PedidosService] Error al marcar visita fuera de agenda:", error);
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
      const ahora = new Date();

      realm.write(() => {
        Array.from(renglones).forEach((renglon: any, index: number) => {
          const idMovil = renglon.id_movil ?? this.getNextIdMovil();
          const idLocal = `${Date.now()}-${index}-${Math.random().toString(36).substr(2, 5)}`;

          realm.create(
            "PedidoBitacora",
            {
              id: idLocal,
              idPedido: data.folio,
              id_movil: idMovil,
              folio: data.folio,
              fecha: ahora,
              ruta: renglon.ruta,
              cliente: renglon.cliente,
              idCanal: null,
              idVendedor: renglon.idVendedor,
              idProducto: renglon.idProducto ?? null,
              cantPedido: null,
              precio: null,
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

  private enviarBitacoraInmediata(): void {
    try {
      const realm = this.getRealm();
      const syncLogId = `realtime-${Date.now()}`;
      const task = new PedidoBitacoraUploadSyncTask(realm, syncLogId);
      task.execute().catch((error) => {
        console.warn("[PedidosService] Error enviando bitácora en tiempo real:", error);
      });
    } catch (error) {
      console.warn("[PedidosService] No se pudo iniciar envío de bitácora:", error);
    }
  }

  private registrarBitacoraDetalle(data: {
    folio: number;
    idProducto: number;
    campo: string;
    valorAnterior: any;
    valorNuevo: any;
    observacion?: string;
  }): void {
    try {
      const realm = this.getRealm();
      const id = this.buildPedidoId(data.folio, data.idProducto);
      const renglon = realm.objectForPrimaryKey("Pedido", id) as any;
      if (!renglon) return;

      const ahora = new Date();
      const idLocal = `${Date.now()}-det-${Math.random().toString(36).substr(2, 5)}`;

      realm.write(() => {
        realm.create(
          "PedidoBitacora",
          {
            id: idLocal,
            idPedido: data.folio,
            id_movil: renglon.id_movil ?? this.getNextIdMovil(),
            folio: data.folio,
            fecha: ahora,
            ruta: renglon.ruta,
            cliente: renglon.cliente,
            idCanal: renglon.idCanal ?? null,
            idVendedor: renglon.idVendedor,
            idProducto: data.idProducto,
            cantPedido: renglon.cantPedido ?? null,
            precio: renglon.precio ?? null,
            observaciones: data.observacion ?? `${data.campo}: ${data.valorAnterior} -> ${data.valorNuevo}`,
            listaPrecio: renglon.listaPrecio ?? null,
            fechaEntrega: renglon.fechaEntrega ?? null,
            estatus: renglon.estatus,
            estatusAnterior: renglon.estatus,
            cantAtencion: renglon.cantAtencion ?? null,
            precioAtencion: renglon.precioAtencion ?? null,
            causaDiferencia: renglon.causaDiferencia ?? null,
            obserDiferencia: renglon.obserDiferencia ?? null,
            causaNoAtencion: renglon.causaNoAtencion ?? null,
            obserNoAtencion: renglon.obserNoAtencion ?? null,
            usrAlta: renglon.idVendedor ?? null,
            fueraAgenda: renglon.fueraAgenda ?? null,
            no_venta: renglon.no_venta ?? null,
            tipoCambio: `detalle:${data.campo}`,
            enviado: false,
          },
          Realm.UpdateMode.Modified
        );
      });
    } catch (error) {
      console.error("[PedidosService] Error al registrar bitácora de detalle:", error);
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
