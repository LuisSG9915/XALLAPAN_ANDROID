

import Realm from "realm";
import notifee, { AndroidImportance, EventType } from "@notifee/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { navigationRef } from "./navigationRef";
import PedidosService, { Pedido, ESTATUS_PEDIDO } from "./PedidosService";
import AuthService from "./AuthService";
import FullSyncService from "./FullSyncService";
import { fetchWithTimeout } from "./fetchWithTimeout";

const CHANNEL_ID = "pedidos-central";
const PENDING_NAVIGATION_KEY = "@xallapan/pedido_pendiente_navegacion";
const PEDIDOS_POLL_STATE_PREFIX = "@xallapan/pedidos_poll_state:";
const PEDIDOS_POLL_LOOKBACK_MS = 2 * 60 * 1000;
const PEDIDOS_POLL_OVERLAP_MS = 1000;
const CLIENTE_DIAGNOSTICO = 6606;

class PedidoNotificacionService {
  private static instance: PedidoNotificacionService;
  private realm: any = null;
  private inicializado = false;
  private navegacionPendienteEnCurso: Promise<boolean> | null = null;
  private notificacionesEnCurso = new Set<string>();
  private ultimoPollingPorRuta = new Map<number, number>();

  private constructor() {}

  static getInstance(): PedidoNotificacionService {
    if (!PedidoNotificacionService.instance) {
      PedidoNotificacionService.instance = new PedidoNotificacionService();
    }
    return PedidoNotificacionService.instance;
  }

  setRealm(realm: any): void {
    this.realm = realm;
  }

  private async asegurarCanalNotificacion(): Promise<void> {
    await notifee.createChannel({
      id: CHANNEL_ID,
      name: "Pedidos de Central",
      sound: "default",
      importance: AndroidImportance.HIGH,
      vibration: true,
    });
  }

  async inicializar(): Promise<void> {
    if (this.inicializado) return;

    try {
      // Canal de notificaciones para Android
      await this.asegurarCanalNotificacion();

      // Solicitar permiso en iOS
      const settings = await notifee.requestPermission();
      console.log("[PedidoNotificacionService] Permiso notificaciones:", settings);

      // Escuchar eventos en primer plano
      notifee.onForegroundEvent(({ type, detail }) => {
        if (
          (type === EventType.PRESS || type === EventType.ACTION_PRESS) &&
          detail?.notification?.data
        ) {
          this.manejarToqueNotificacion(detail.notification.data as any);
        }
      });

      try {
        const initialNotification = await notifee.getInitialNotification();
        if (initialNotification?.notification?.data) {
          await AsyncStorage.setItem(
            PENDING_NAVIGATION_KEY,
            JSON.stringify(initialNotification.notification.data),
          );
        }
      } catch (error) {
        console.warn("[PedidoNotificacionService] No se pudo obtener la notificación inicial:", error);
      }

      this.inicializado = true;
      console.log("[PedidoNotificacionService] Servicio inicializado");
    } catch (error) {
      console.error("[PedidoNotificacionService] Error al inicializar:", error);
    }
  }

  async verificarPedidosNuevos(ruta: number) {
    if (!Number.isFinite(ruta) || ruta <= 0) return 0;

    const stateKey = `${PEDIDOS_POLL_STATE_PREFIX}${ruta}`;
    let state: { initialized: boolean; knownFolios: number[]; lastPollAt?: number } = {
      initialized: false,
      knownFolios: [],
    };
    try {
      const stored = await AsyncStorage.getItem(stateKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        state = {
          initialized: parsed?.initialized === true,
          knownFolios: Array.isArray(parsed?.knownFolios)
            ? parsed.knownFolios.map(Number).filter((folio: number) => Number.isFinite(folio))
            : [],
          lastPollAt: Number.isFinite(Number(parsed?.lastPollAt)) ? Number(parsed.lastPollAt) : undefined,
        };
      }
    } catch (error) {
      console.warn("[PedidoNotificacionService] Estado de polling inválido:", error);
    }

    const ahora = Date.now();
    const ultimoPolling = this.ultimoPollingPorRuta.get(ruta) ?? state.lastPollAt;
    const fechaInicial = new Date(
      ultimoPolling ? ultimoPolling - PEDIDOS_POLL_OVERLAP_MS : ahora - PEDIDOS_POLL_LOOKBACK_MS,
    );
    const fecha = [
      fechaInicial.getFullYear(),
      String(fechaInicial.getMonth() + 1).padStart(2, "0"),
      String(fechaInicial.getDate()).padStart(2, "0"),
    ].join("-");
    const hora = `${String(fechaInicial.getHours()).padStart(2, "0")}:${String(
      fechaInicial.getMinutes(),
    ).padStart(2, "0")}:${String(fechaInicial.getSeconds()).padStart(2, "0")}.${String(
      fechaInicial.getMilliseconds(),
    ).padStart(3, "0")}`;
    const url = `https://api.cbinformatica.net:9031/api/MovilesVentas/sp_MovilesPedidos/${ruta}?fechaInicial=${encodeURIComponent(
      `${fecha} ${hora}`,
    )}`;
    // console.log("[PedidoNotificacionService] Consultando pedidos", {
    //   ruta,
    //   fechaInicial: `${fecha} ${hora}`,
    //   url,
    // });

    try {
      const response = await fetchWithTimeout(
        url,
        { headers: { accept: "application/json" } },
        8000,
      );
      const responseText = await response.text();
      console.log(
        `[PedidoNotificacionService] Respuesta de pedidos: ruta=${ruta}, status=${response.status}, ok=${response.ok}, bytes=${responseText.length}`,
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (response.status === 204 || !responseText.trim()) {
        const lastPollAt = Date.now();
        this.ultimoPollingPorRuta.set(ruta, lastPollAt);
        await AsyncStorage.setItem(
          stateKey,
          JSON.stringify({
            initialized: state.initialized,
            knownFolios: state.knownFolios,
            lastPollAt,
          }),
        );
        console.log(`[PedidoNotificacionService] Sin pedidos en la respuesta para ruta ${ruta}`);
        return 0;
      }
      let payload: any;
      try {
        payload = JSON.parse(responseText);
      } catch (error) {
        console.warn(
          `[PedidoNotificacionService] Respuesta no JSON del endpoint de pedidos (HTTP ${response.status})`,
        );
        return 0;
      }

      const rows = Array.isArray(payload)
        ? payload
        : payload?.data || payload?.result || payload?.items || [];
      if (!Array.isArray(rows)) return 0;
      console.log(`[PedidoNotificacionService] Registros recibidos: ${rows.length}`);
      console.log(
        "[PedidoNotificacionService] Renglones recibidos:",
        rows.map((row: any) => ({
          folio: row?.folio,
          idProducto: row?.idProducto,
          cantPedido: row?.cantPedido,
          numeroProductos: row?.numeroProductos,
          estatus: row?.estatus,
        })),
      );

      const pedidosClienteDiagnostico = rows.filter(
        (row: any) => Number(row?.cliente ?? row?.idCliente ?? row?.clienteId) === CLIENTE_DIAGNOSTICO,
      );
      console.log("[PedidoNotificacionService][DEBUG 6606] Filas API recibidas", {
        ruta,
        fechaInicial: `${fecha} ${hora}`,
        estadoPolling: {
          initialized: state.initialized,
          foliosConocidos: state.knownFolios.filter((folio) =>
            pedidosClienteDiagnostico.some(
              (row: any) => Number(row?.folio ?? row?.folioPedido ?? row?.idPedido) === folio,
            ),
          ),
        },
        cantidad: pedidosClienteDiagnostico.length,
        filas: pedidosClienteDiagnostico,
      });

      const pedidosService = PedidosService.getInstance();
      if (this.realm) {
        pedidosService.setRealm(this.realm);
        pedidosService.actualizarPedidosDesdeRespuesta(rows);
      }

      const pedidos = new Map<number, any>();
      rows.forEach((row: any) => {
        const folio = Number(row?.folio ?? row?.folioPedido ?? row?.idPedido);
        if (Number.isFinite(folio) && folio > 0 && !pedidos.has(folio)) {
          pedidos.set(folio, row);
        }
      });

      const pedidosClienteAgrupados = Array.from(pedidos.entries()).filter(
        ([_folio, row]: [number, any]) =>
          Number(row?.cliente ?? row?.idCliente ?? row?.clienteId) === CLIENTE_DIAGNOSTICO,
      );
      console.log("[PedidoNotificacionService][DEBUG 6606] Pedidos agrupados por folio", {
        cantidad: pedidosClienteAgrupados.length,
        pedidos: pedidosClienteAgrupados.map(([folio, row]) => ({
          folio,
          cliente: row?.cliente,
          idCliente: row?.idCliente,
          ruta: row?.ruta,
          fecha: row?.fecha,
          fechaEntrega: row?.fechaEntrega,
          estatus: row?.estatus,
          fueraAgenda: row?.fueraAgenda,
        })),
      });

      const knownFolios = new Set(state.knownFolios);
      if (!state.initialized) {
        if (pedidosClienteAgrupados.length > 0) {
          console.log("[PedidoNotificacionService][DEBUG 6606] El polling está creando línea base", {
            folios: pedidosClienteAgrupados.map(([folio]) => folio),
            noSeProcesanVisitasEnEstaRonda: true,
          });
        }
        pedidos.forEach((_row, folio) => knownFolios.add(folio));
        const lastPollAt = Date.now();
        await AsyncStorage.setItem(
          stateKey,
          JSON.stringify({
            initialized: true,
            knownFolios: Array.from(knownFolios).slice(-1000),
            lastPollAt,
          }),
        );
        this.ultimoPollingPorRuta.set(ruta, lastPollAt);
        console.log(
          `[PedidoNotificacionService] Línea base creada para ruta ${ruta}: ${pedidos.size} folio(s)`,
        );
        return 0;
      }

      const foliosNuevos = Array.from(pedidos.keys()).filter((folio) => !knownFolios.has(folio));
      console.log(
        `[PedidoNotificacionService] Folios nuevos detectados para ruta ${ruta}: ${foliosNuevos.length}`,
      );

      let notificados = 0;
      const estadosFinales = [
        ESTATUS_PEDIDO.ENTREGADO,
        ESTATUS_PEDIDO.ENTREGADO_PARCIAL,
        ESTATUS_PEDIDO.PENDIENTE_CON_CAUSA,
        ESTATUS_PEDIDO.CANCELADO,
      ];
      for (const [folio, row] of pedidos) {
        const pedidoLocal = this.realm && !this.realm.isClosed
          ? (pedidosService.getPedidoByFolio(folio) as Pedido | null)
          : null;
        const pedido = pedidoLocal || this.crearPedidoDesdeApi(row, folio);
        const entregaHoy = this.esPedidoConEntregaHoy(pedido);
        const esClienteDiagnostico = Number(pedido.cliente) === CLIENTE_DIAGNOSTICO;

        if (esClienteDiagnostico) {
          console.log("[PedidoNotificacionService][DEBUG 6606] Evaluando pedido", {
            folio,
            cliente: pedido.cliente,
            rutaPedido: pedido.ruta,
            fecha: pedido.fecha,
            fechaEntrega: pedido.fechaEntrega,
            entregaHoy,
            estatus: pedido.estatus,
            pedidoLocalEncontrado: Boolean(pedidoLocal),
            folioConocido: knownFolios.has(folio),
            esEstadoFinal: estadosFinales.includes(pedido.estatus),
          });
        }

        if (entregaHoy && !estadosFinales.includes(pedido.estatus)) {
          await this.registrarVisitaFueraAgenda(pedido);
        }

        if (knownFolios.has(folio)) continue;
        if (pedidoLocal && estadosFinales.includes(pedidoLocal.estatus)) {
          knownFolios.add(folio);
          continue;
        }

        if (await this.mostrarNotificacionPedido(pedido)) {
          knownFolios.add(folio);
          notificados++;
        }
      }

      const lastPollAt = Date.now();
      await AsyncStorage.setItem(
        stateKey,
        JSON.stringify({
          initialized: true,
          knownFolios: Array.from(knownFolios).slice(-1000),
          lastPollAt,
        }),
      );
      this.ultimoPollingPorRuta.set(ruta, lastPollAt);

      if (notificados > 0) {
        console.log(`[PedidoNotificacionService] ${notificados} pedido(s) nuevo(s) notificado(s)`);
      }
      return notificados;
    } catch (error) {
      console.warn("[PedidoNotificacionService] Error consultando pedidos nuevos:", error);
      return 0;
    }
  }

  private esPedidoConEntregaHoy(pedido: Pedido): boolean {
    if (!pedido.fechaEntrega) return false;

    const fechaEntrega = pedido.fechaEntrega instanceof Date
      ? pedido.fechaEntrega
      : new Date(pedido.fechaEntrega);
    const hoy = new Date();

    return (
      !Number.isNaN(fechaEntrega.getTime()) &&
      fechaEntrega.getFullYear() === hoy.getFullYear() &&
      fechaEntrega.getMonth() === hoy.getMonth() &&
      fechaEntrega.getDate() === hoy.getDate()
    );
  }

  private crearPedidoDesdeApi(row: any, folio: number): Pedido {
    const cliente = Number(row?.cliente ?? row?.idCliente ?? 0);
    const idProducto = Number(row?.idProducto ?? 0);

    return {
      id: `${folio}-${idProducto}`,
      idPedido: folio,
      folio,
      fecha: row?.fecha ? new Date(row.fecha) : undefined,
      fechaEntrega: row?.fechaEntrega ? new Date(row.fechaEntrega) : undefined,
      ruta: Number(row?.ruta ?? row?.idRuta ?? 0),
      cliente,
      clienteNombre: row?.nombreCliente ?? row?.clienteNombre,
      clienteDomicilio: row?.clienteDomicilio ?? row?.domicilio,
      idVendedor: Number(row?.idVendedor ?? 0),
      numeroProductos: Number(row?.numeroProductos ?? row?.totalProductos ?? 1),
      cantPedido: Number(row?.cantPedido ?? row?.cantidad ?? 0),
      estatus: Number(row?.estatus ?? ESTATUS_PEDIDO.CONFIRMADO),
      syncedAt: new Date(),
      idProducto,
    };
  }

  /**
   * Debe llamarse desde index.js / top-level para que funcione cuando la app está en background/killed.
   */
  static registrarBackgroundHandler(): void {
    notifee.onBackgroundEvent(async ({ type, detail }) => {
      const { notification } = detail || {};
      if (
        (type === EventType.PRESS || type === EventType.ACTION_PRESS) &&
        notification?.data
      ) {
        const data = notification.data as any;
        // Guardar intención de navegación para cuando la app se inicie
        try {
          await AsyncStorage.setItem(PENDING_NAVIGATION_KEY, JSON.stringify(data));
        } catch (e) {
          console.warn("[PedidoNotificacionService] No se pudo guardar intención de navegación:", e);
        }
      }
    });
  }

  /**
   * Recibe el listado de folios sincronizados y notifica solo los que aun no han sido notificados.
   * Usa el estatus NOTIFICADO (4) como control principal para no depender de AsyncStorage.
   */
  async notificarConfirmadosPendientes(): Promise<number> {
    if (!this.realm || this.realm.isClosed) return 0;
    const pedidosConfirmados = this.realm.objects("Pedido").filtered(
      "estatus == $0",
      ESTATUS_PEDIDO.CONFIRMADO,
    ) as any[];
    const folios = Array.from(pedidosConfirmados).reduce<number[]>((result, pedido: any) => {
      const folio = Number(pedido.folio);
      if (Number.isFinite(folio) && !result.includes(folio)) result.push(folio);
      return result;
    }, []);
    await this.procesarPedidosSincronizados(folios);
    return folios.length;
  }

  async procesarPedidosSincronizados(folios: number[]): Promise<void> {
    if (!folios || folios.length === 0) return;

    try {
      await this.inicializar();
      const pedidosService = PedidosService.getInstance();
      if (this.realm) {
        pedidosService.setRealm(this.realm);
      }

      for (const folio of folios) {
        const pedido = pedidosService.getPedidoByFolio(folio);
        if (!pedido) continue;

        // Solo notificar pedidos confirmados, aun no notificados ni cerrados
        const ESTATUS_FINALES_NOTIF = [
          ESTATUS_PEDIDO.ENTREGADO,
          ESTATUS_PEDIDO.ENTREGADO_PARCIAL,
          ESTATUS_PEDIDO.PENDIENTE_CON_CAUSA,
          ESTATUS_PEDIDO.CANCELADO,
        ];
        if (pedido.estatus !== ESTATUS_PEDIDO.CONFIRMADO) {
          console.log(
            `[PedidoNotificacionService] Folio ${folio} tiene estatus ${pedido.estatus}, no es un pedido confirmado`,
          );
          continue;
        }
        if (pedido.estatus >= ESTATUS_PEDIDO.NOTIFICADO || ESTATUS_FINALES_NOTIF.includes(pedido.estatus)) {
          console.log(`[PedidoNotificacionService] Folio ${folio} ya notificado o atendido, omitiendo`);
          continue;
        }

        const notificacionMostrada = await this.mostrarNotificacionPedido(pedido);
        if (!notificacionMostrada) {
          console.warn(
            `[PedidoNotificacionService] No se marcara como NOTIFICADO el folio ${folio} porque la notificación no pudo mostrarse`,
          );
          continue;
        }

        await this.registrarVisitaFueraAgenda(pedido);

        // Marcar como notificado para evitar duplicados en futuras sincronizaciones
        this.marcarPedidoNotificado(folio);
      }
    } catch (error) {
      console.error("[PedidoNotificacionService] Error al procesar pedidos sincronizados:", error);
    }
  }

  async mostrarNotificacionPedido(pedido: Pedido): Promise<boolean> {
    const notificationId = `pedido-${pedido.folio}`;
    if (this.notificacionesEnCurso.has(notificationId)) return false;

    this.notificacionesEnCurso.add(notificationId);
    try {
      await this.asegurarCanalNotificacion();
      const cliente = this.realm?.objectForPrimaryKey("ClienteFull", pedido.cliente) as any;
      const clienteNombre = cliente?.nombre || pedido.clienteNombre || `Cliente #${pedido.cliente}`;
      const clienteDireccion = cliente?.domicilio || pedido.clienteDomicilio || "Sin dirección";
      const body = `${clienteNombre} - ${clienteDireccion} - ${pedido.numeroProductos} producto(s)`;

      await notifee.displayNotification({
        id: `pedido-${pedido.folio}`,
        title: "Nuevo pedido de Central",
        body,
        data: {
          folio: String(pedido.folio),
          cliente: String(pedido.cliente),
          ruta: String(pedido.ruta ?? ""),
        },
        android: {
          channelId: CHANNEL_ID,
          importance: AndroidImportance.HIGH,
          pressAction: {
            id: "default",
          },
        },
        ios: {
          sound: "default",
        },
      });
      console.log(`[PedidoNotificacionService] Notificación mostrada para folio ${pedido.folio}`);
      return true;
    } catch (error) {
      console.error("[PedidoNotificacionService] Error al mostrar notificación:", error);
      return false;
    } finally {
      this.notificacionesEnCurso.delete(notificationId);
    }
  }

  private async manejarToqueNotificacion(data: any): Promise<void> {
    const folio = data?.folio ? parseInt(String(data.folio), 10) : null;
    if (!folio) return;

    try {
      await AsyncStorage.setItem(PENDING_NAVIGATION_KEY, JSON.stringify(data));
      await this.procesarNavegacionPendiente();
    } catch (error) {
      console.error("[PedidoNotificacionService] Error al procesar toque de notificación:", error);
    }
  }

  async procesarNavegacionPendiente(): Promise<boolean> {
    if (this.navegacionPendienteEnCurso) {
      return this.navegacionPendienteEnCurso;
    }

    const proceso = this.procesarNavegacionPendienteInterno();
    this.navegacionPendienteEnCurso = proceso;

    try {
      return await proceso;
    } finally {
      if (this.navegacionPendienteEnCurso === proceso) {
        this.navegacionPendienteEnCurso = null;
      }
    }
  }

  private async procesarNavegacionPendienteInterno(): Promise<boolean> {
    try {
      const pending = await AsyncStorage.getItem(PENDING_NAVIGATION_KEY);
      if (!pending) return false;

      let data: any;
      try {
        data = JSON.parse(pending);
      } catch (error) {
        console.warn("[PedidoNotificacionService] Intención de navegación inválida:", error);
        await AsyncStorage.removeItem(PENDING_NAVIGATION_KEY);
        return false;
      }

      const folio = data?.folio ? parseInt(String(data.folio), 10) : null;
      if (!folio) {
        await AsyncStorage.removeItem(PENDING_NAVIGATION_KEY);
        return false;
      }

      const user = await AuthService.restoreSession();
      if (!user) {
        console.log("[PedidoNotificacionService] Se conserva la intención: no hay sesión activa");
        return false;
      }

      const navegacionLista = await this.esperarNavegacionLista();
      if (!navegacionLista) {
        console.warn("[PedidoNotificacionService] El navegador no quedó listo para abrir el pedido");
        return false;
      }

      const realm = this.realm || (FullSyncService as any).realm;
      if (!realm) {
        console.warn("[PedidoNotificacionService] Realm no disponible para abrir el pedido");
        return false;
      }

      const pedidosService = PedidosService.getInstance();
      pedidosService.setRealm(realm);
      let pedido = pedidosService.getPedidoByFolio(folio);

      if (!pedido) {
        const usuarioRealm = realm.objects("Usuario").filtered("claveEmpleado == $0", user.claveEmpleado)[0] as any;
        const ruta = Number(data?.ruta ?? user?.ruta ?? user?.idRuta ?? usuarioRealm?.ruta ?? 0);
        if (!Number.isFinite(ruta) || ruta <= 0) {
          console.warn(`[PedidoNotificacionService] Usuario sin ruta para sincronizar pedido ${folio}`);
          return false;
        }
        await pedidosService.syncPedidos(ruta);
        pedido = pedidosService.getPedidoByFolio(folio);
      }

      if (!pedido) {
        console.warn(`[PedidoNotificacionService] Pedido ${folio} no disponible en Realm`);
        return false;
      }

      if (
        pedido.estatus !== ESTATUS_PEDIDO.EN_ATENCION &&
        pedido.estatus !== ESTATUS_PEDIDO.EN_CAPTURA
      ) {
        const iniciado = pedidosService.iniciarAtencionPedido(folio);
        if (!iniciado) {
          console.warn(`[PedidoNotificacionService] No se pudo iniciar atención del pedido ${folio}`);
          return false;
        }
      }

      navigationRef.navigate("PedidoDetalle", { folio, soloLectura: false });
      await AsyncStorage.removeItem(PENDING_NAVIGATION_KEY);

      const idUsuario = Number(user?.id ?? user?.idUsuario ?? 1);
      const estadoResult = await FullSyncService.sendPendingPedidoEstadosToServer(idUsuario);
      console.log(`[PedidoNotificacionService] Estado del pedido ${folio}:`, estadoResult);
      return true;
    } catch (error) {
      console.error("[PedidoNotificacionService] Error al procesar navegación pendiente:", error);
      return false;
    }
  }

  private async esperarNavegacionLista(timeoutMs: number = 10000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (navigationRef.isReady()) {
        const routeName = navigationRef.getCurrentRoute()?.name;
        if (routeName && routeName !== "Login") {
          return true;
        }
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }

    return false;
  }

  /**
   * Procesa una notificación push remota (cuando central implemente FCM).
   * Evita duplicar la notificación si el folio ya fue notificado por sync.
   */
  async manejarNotificacionPush(data: any): Promise<void> {
    const folio = data?.folio ? parseInt(data.folio) : null;
    if (!folio) return;

    const pedidosService = PedidosService.getInstance();
    if (this.realm) {
      pedidosService.setRealm(this.realm);
    }

    const pedido = pedidosService.getPedidoByFolio(folio);
    if (!pedido) {
      console.log(`[PedidoNotificacionService] Pedido ${folio} aun no sincronizado, ignorando push`);
      return;
    }

    if (pedido.estatus !== ESTATUS_PEDIDO.CONFIRMADO) {
      console.log(`[PedidoNotificacionService] Push para folio ${folio} con estatus ${pedido.estatus}, ignorando`);
      return;
    }

    if (pedido.estatus >= ESTATUS_PEDIDO.NOTIFICADO) {
      console.log(`[PedidoNotificacionService] Push duplicada para folio ${folio}, ignorando`);
      return;
    }

    const notificacionMostrada = await this.mostrarNotificacionPedido(pedido);
    if (!notificacionMostrada) {
      console.warn(
        `[PedidoNotificacionService] No se marcara como NOTIFICADO el folio ${folio} porque la notificación no pudo mostrarse`,
      );
      return;
    }

    await this.registrarVisitaFueraAgenda(pedido);
    this.marcarPedidoNotificado(folio);
  }

  private marcarPedidoNotificado(folio: number): void {
    try {
      const pedidosService = PedidosService.getInstance();
      if (this.realm) {
        pedidosService.setRealm(this.realm);
      }
      pedidosService.cambiarEstatusPedido(folio, ESTATUS_PEDIDO.NOTIFICADO);
      console.log(`[PedidoNotificacionService] Pedido ${folio} marcado como NOTIFICADO`);
    } catch (error) {
      console.warn("[PedidoNotificacionService] Error al marcar pedido como notificado:", error);
    }
  }

  private getEstatusDescripcion(estatus: number): string {
    try {
      if (!this.realm) return "Desconocido";
      const catalogo = this.realm.objectForPrimaryKey("CatalogoEstatusPedido", estatus) as any;
      return catalogo?.descripcion || "Desconocido";
    } catch {
      return "Desconocido";
    }
  }

  /**
   * Registra el pedido en la agenda del vendedor como "Visita Fuera de Agenda".
   */
  private async registrarVisitaFueraAgenda(pedido: Pedido): Promise<void> {
    try {
      const esClienteDiagnostico = Number(pedido.cliente) === CLIENTE_DIAGNOSTICO;
      if (esClienteDiagnostico) {
        console.log("[PedidoNotificacionService][DEBUG 6606] Iniciando registro de visita fuera de agenda", {
          folio: pedido.folio,
          idCliente: pedido.cliente,
          rutaPedido: pedido.ruta,
          fecha: pedido.fecha,
          fechaEntrega: pedido.fechaEntrega,
          estatus: pedido.estatus,
          realmDisponible: Boolean(this.realm),
        });
      }

      if (!this.realm) {
        console.warn("[PedidoNotificacionService] Realm no disponible para registrar visita");
        return;
      }

      const user = await AuthService.restoreSession();
      const sucursal = user?.sucursal_origen || user?.sucursal || 0;
      const ruta = user?.ruta ? String(user.ruta) : String(pedido.ruta);

      if (esClienteDiagnostico) {
        console.log("[PedidoNotificacionService][DEBUG 6606] Datos de sesión para visita", {
          sucursalSesion: sucursal,
          rutaSesion: user?.ruta,
          rutaCalculada: ruta,
        });
      }

      if (!sucursal) {
        console.warn("[PedidoNotificacionService] No se pudo determinar sucursal para visita");
        return;
      }

      // Tipo de visita: usamos 99 para "Pedido de Central" (Fuera de Agenda)
      // Si en el catálogo TipoVisita existe un tipo específico, se puede ajustar.
      const TIPO_PEDIDO_CENTRAL = 99;
      const hoy = new Date();
      hoy.setHours(0, 0, 0, 0);

      const idCompuesto = `pedido-${pedido.folio}-${hoy.toISOString().split("T")[0]}`;
      const visitaExistente = this.realm.objectForPrimaryKey("Visita", idCompuesto) as any;
      if (visitaExistente) {
        // console.log(`[PedidoNotificacionService] Visita fuera de agenda ya existe para folio ${pedido.folio}`);
        if (esClienteDiagnostico) {
          console.log("[PedidoNotificacionService][DEBUG 6606] Visita existente encontrada", {
            id: visitaExistente.id,
            idOriginal: visitaExistente.idOriginal,
            idCliente: visitaExistente.idCliente,
            ruta: visitaExistente.ruta,
            fecha: visitaExistente.fecha,
            tipo: visitaExistente.tipo,
            visitado: visitaExistente.visitado,
          });
        }
        return;
      }

      console.log("[PedidoNotificacionService] Creando visita fuera de agenda", {
        folio: pedido.folio,
        idCliente: pedido.cliente,
        ruta,
        fechaEntrega: pedido.fechaEntrega,
        idCompuesto,
      });

      this.realm.write(() => {
        this.realm.create(
          "Visita",
          {
            id: idCompuesto,
            idOriginal: pedido.folio,
            idCliente: pedido.cliente,
            ruta: String(sucursal),
            fecha: hoy,
            orden: 9999,
            tipo: TIPO_PEDIDO_CENTRAL,
            visitado: 0,
          },
          Realm.UpdateMode.Modified
        );
      });

      // console.log(`[PedidoNotificacionService] Visita fuera de agenda registrada para folio ${pedido.folio}`);
      if (esClienteDiagnostico) {
        const visitaRegistrada = this.realm.objectForPrimaryKey("Visita", idCompuesto) as any;
        console.log("[PedidoNotificacionService][DEBUG 6606] Visita registrada en Realm", {
          id: visitaRegistrada?.id,
          idOriginal: visitaRegistrada?.idOriginal,
          idCliente: visitaRegistrada?.idCliente,
          ruta: visitaRegistrada?.ruta,
          fecha: visitaRegistrada?.fecha,
          tipo: visitaRegistrada?.tipo,
          visitado: visitaRegistrada?.visitado,
        });
      }
    } catch (error) {
      console.error("[PedidoNotificacionService] Error al registrar visita fuera de agenda:", error);
    }
  }
}

export { PedidoNotificacionService };
export default PedidoNotificacionService.getInstance();
