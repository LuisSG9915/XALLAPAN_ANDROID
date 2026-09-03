import {
  getInitialNotification,
  getMessaging,
  getToken,
  onMessage,
  onNotificationOpenedApp,
  onTokenRefresh,
  registerDeviceForRemoteMessages,
  type RemoteMessage,
  requestPermission,
  setBackgroundMessageHandler,
  subscribeToTopic,
} from "@react-native-firebase/messaging";
import { Platform } from "react-native";
import AuthService from "./AuthService";
import AppUpdateService from "./AppUpdateService";

const UPDATE_TOPIC = "xallapan-android-updates";

class FcmService {
  private inicializado = false;
  private unsubscribeMessage: (() => void) | null = null;
  private unsubscribeToken: (() => void) | null = null;
  private unsubscribeOpened: (() => void) | null = null;

  async inicializar(): Promise<void> {
    if (this.inicializado || Platform.OS !== "android") return;

    try {
      const messaging = getMessaging();
      await registerDeviceForRemoteMessages(messaging);
      await requestPermission(messaging);
      await subscribeToTopic(messaging, UPDATE_TOPIC);
      const token = await getToken(messaging);
      const user = await AuthService.restoreSession();
      await AppUpdateService.registrarDispositivo({
        idUsuario: user?.id ?? null,
        sucursal: user?.sucursal_origen ?? user?.sucursal ?? null,
        tokenFcm: token,
        notificacionesHabilitadas: true,
      });

      this.unsubscribeMessage = onMessage(messaging, (message) => this.procesarMensaje(message));
      this.unsubscribeOpened = onNotificationOpenedApp(messaging, (message) => this.procesarMensaje(message));
      this.unsubscribeToken = onTokenRefresh(messaging, (nextToken) =>
        AppUpdateService.registrarDispositivo({
          idUsuario: AuthService.currentUser?.id ?? null,
          sucursal: AuthService.currentUser?.sucursal_origen ?? AuthService.currentUser?.sucursal ?? null,
          tokenFcm: nextToken,
          notificacionesHabilitadas: true,
        }),
      );
      const initialMessage = await getInitialNotification(messaging);
      if (initialMessage) await this.procesarMensaje(initialMessage);
      this.inicializado = true;
    } catch (error) {
      console.warn("[FcmService] FCM no está disponible o falta configuración:", error);
    }
  }

  async procesarMensaje(message: RemoteMessage): Promise<void> {
    if (message.data?.type !== "app_update") return;
    await AppUpdateService.procesarPushActualizacion();
  }

  registrarHandlerBackground(): void {
    try {
      setBackgroundMessageHandler(getMessaging(), (message) => this.procesarMensaje(message));
    } catch (error) {
      console.warn("[FcmService] No se pudo registrar el handler en background:", error);
    }
  }

  liberar(): void {
    this.unsubscribeMessage?.();
    this.unsubscribeToken?.();
    this.unsubscribeOpened?.();
    this.unsubscribeMessage = null;
    this.unsubscribeToken = null;
    this.unsubscribeOpened = null;
    this.inicializado = false;
  }
}

export default new FcmService();
