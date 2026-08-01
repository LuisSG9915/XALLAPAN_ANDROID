

import Realm from "realm";
import notifee, { AndroidImportance, EventType } from "@notifee/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { navigate } from "./navigationRef";
import PedidosService, { Pedido, ESTATUS_PEDIDO } from "./PedidosService";
import AuthService from "./AuthService";

const CHANNEL_ID = "pedidos-central";

class PedidoNotificacionService {
  private static instance: PedidoNotificacionService;
  private realm: any = null;
  private inicializado = false;

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

  async inicializar(): Promise<void> {
    if (this.inicializado) return;

    try {
      // Canal de notificaciones para Android
      await notifee.createChannel({
        id: CHANNEL_ID,
        name: "Pedidos de Central",
        sound: "default",
        importance: AndroidImportance.HIGH,
        vibration: true,
      });

      // Solicitar permiso en iOS
      const settings = await notifee.requestPermission();
      console.log("[PedidoNotificacionService] Permiso notificaciones:", settings);

      // Escuchar eventos en primer plano
      notifee.onForegroundEvent(({ type, detail }) => {
        if (type === EventType.PRESS && detail?.notification?.data) {
          this.manejarToqueNotificacion(detail.notification.data as any);
        }
      });

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
      if (type === EventType.PRESS && notification?.data) {
        const data = notification.data as any;
        // Guardar intención de navegación para cuando la app se inicie
        try {
          await AsyncStorage.setItem("@xallapan/pedido_pendiente_navegacion", JSON.stringify(data));
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

        // Solo notificar pedidos que aun no han sido notificados ni atendidos
        if (pedido.estatus >= ESTATUS_PEDIDO.NOTIFICADO) {
          console.log(`[PedidoNotificacionService] Folio ${folio} ya notificado o atendido, omitiendo`);
          continue;
        }

        await this.mostrarNotificacionPedido(pedido);
        await this.registrarVisitaFueraAgenda(pedido);

        // Marcar como notificado para evitar duplicados en futuras sincronizaciones
        this.marcarPedidoNotificado(folio);
      }
    } catch (error) {
      console.error("[PedidoNotificacionService] Error al procesar pedidos sincronizados:", error);
    }
  }

  async mostrarNotificacionPedido(pedido: Pedido): Promise<void> {
    try {
      await notifee.displayNotification({
        id: `pedido-${pedido.folio}`,
        title: "Nuevo pedido de Central",
        body: `${pedido.clienteNombre || `Cliente #${pedido.cliente}`} - ${pedido.numeroProductos} producto(s)`,
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
    } catch (error) {
      console.error("[PedidoNotificacionService] Error al mostrar notificación:", error);
    }
  }

  private async manejarToqueNotificacion(data: any): Promise<void> {
    const folio = data?.folio ? parseInt(data.folio) : null;
    if (!folio) return;

    console.log(`[PedidoNotificacionService] Navegando a pedido ${folio}`);
    navigate("PedidoDetalle", { folio, soloLectura: true });
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

    if (pedido.estatus >= ESTATUS_PEDIDO.NOTIFICADO) {
      console.log(`[PedidoNotificacionService] Push duplicada para folio ${folio}, ignorando`);
      return;
    }

    await this.mostrarNotificacionPedido(pedido);
    await this.registrarVisitaFueraAgenda(pedido);
    this.marcarPedidoNotificado(folio);
  }

  private marcarPedidoNotificado(folio: number): void {
    try {
      if (!this.realm) return;
      const renglones = this.realm.objects("Pedido").filtered("folio = $0", folio);
      if (renglones.length === 0) return;

      this.realm.write(() => {
        Array.from(renglones).forEach((renglon: any) => {
          if (renglon.estatus < ESTATUS_PEDIDO.NOTIFICADO) {
            renglon.estatus = ESTATUS_PEDIDO.NOTIFICADO;
            renglon.estatusDescripcion = this.getEstatusDescripcion(ESTATUS_PEDIDO.NOTIFICADO);
            renglon.syncedAt = new Date();
          }
        });
      });
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
