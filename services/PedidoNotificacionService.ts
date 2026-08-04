

import Realm from "realm";
import notifee, { AndroidImportance, EventType } from "@notifee/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { navigationRef } from "./navigationRef";
import PedidosService, { Pedido, ESTATUS_PEDIDO } from "./PedidosService";
import AuthService from "./AuthService";
import FullSyncService from "./FullSyncService";

const CHANNEL_ID = "pedidos-central";
const PENDING_NAVIGATION_KEY = "@xallapan/pedido_pendiente_navegacion";

class PedidoNotificacionService {
  private static instance: PedidoNotificacionService;
  private realm: any = null;
  private inicializado = false;
  private navegacionPendienteEnCurso: Promise<boolean> | null = null;

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
  async procesarPedidosSincronizados(folios: number[]): Promise<void> {
    if (!folios || folios.length === 0) return;

    try {
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
        const sucursal = Number(user?.sucursal_origen || user?.sucursal || 1);
        await pedidosService.syncPedidos(sucursal);
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
      const bitacoraResult = await FullSyncService.sendPendingPedidoBitacoraToServer(idUsuario);
      console.log(`[PedidoNotificacionService] Bitácora del pedido ${folio}:`, bitacoraResult);
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
      if (!this.realm) {
        console.warn("[PedidoNotificacionService] Realm no disponible para registrar visita");
        return;
      }

      const user = await AuthService.restoreSession();
      const sucursal = user?.sucursal_origen || user?.sucursal || 0;
      const ruta = user?.ruta ? String(user.ruta) : String(pedido.ruta);

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

      console.log(`[PedidoNotificacionService] Visita fuera de agenda registrada para folio ${pedido.folio}`);
    } catch (error) {
      console.error("[PedidoNotificacionService] Error al registrar visita fuera de agenda:", error);
    }
  }
}

export { PedidoNotificacionService };
export default PedidoNotificacionService.getInstance();
