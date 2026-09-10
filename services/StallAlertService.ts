import notifee, { AndroidImportance } from "@notifee/react-native";
import { calcularDistancia } from "./LocationService";

const CHANNEL_ID = "alertas-recorrido";
const NOTIFICATION_ID = "alerta-varado";
const DEFAULT_TOLERANCE_METERS = 30;
const DEFAULT_STALLED_SECONDS = 30 * 60;

type StallPoint = {
  latitud: number;
  longitud: number;
  timestamp: number;
};

type StallEvaluation = {
  routeKey: string;
  idUsuario: number;
  nombreUsuario?: string | null;
  sucursal: number;
  latitud: number;
  longitud: number;
  timestamp?: number;
  metrosTolerancia?: number | null;
  segundosVarado?: number | null;
};

class StallAlertService {
  private routeKey: string | null = null;
  private anchor: StallPoint | null = null;
  private alerted = false;
  private channelReady: Promise<void> | null = null;

  private ensureChannel(): Promise<void> {
    if (!this.channelReady) {
      this.channelReady = notifee
        .createChannel({
          id: CHANNEL_ID,
          name: "Alertas de recorrido",
          importance: AndroidImportance.HIGH,
          sound: "default",
          vibration: true,
        })
        .then(() => undefined);
    }
    return this.channelReady;
  }

  private resetForRoute(routeKey: string): void {
    if (this.routeKey === routeKey) return;
    this.routeKey = routeKey;
    this.anchor = null;
    this.alerted = false;
  }

  async evaluate(input: StallEvaluation): Promise<boolean> {
    this.resetForRoute(input.routeKey);

    const tolerance = Number(input.metrosTolerancia);
    const threshold = Number(input.segundosVarado);
    const metrosTolerancia = Number.isFinite(tolerance) && tolerance > 0
      ? tolerance
      : DEFAULT_TOLERANCE_METERS;
    const segundosVarado = Number.isFinite(threshold) && threshold > 0
      ? threshold
      : DEFAULT_STALLED_SECONDS;
    const timestamp = Number(input.timestamp);
    const current: StallPoint = {
      latitud: input.latitud,
      longitud: input.longitud,
      timestamp: Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : Date.now(),
    };

    if (!this.anchor) {
      this.anchor = current;
      return false;
    }

    const distancia = calcularDistancia(
      this.anchor.latitud,
      this.anchor.longitud,
      current.latitud,
      current.longitud,
    );

    if (!Number.isFinite(distancia) || distancia > metrosTolerancia) {
      this.anchor = current;
      this.alerted = false;
      await notifee.cancelNotification(NOTIFICATION_ID).catch(() => undefined);
      return false;
    }

    const sinMovimientoMs = Math.max(0, current.timestamp - this.anchor.timestamp);
    if (this.alerted || sinMovimientoMs < segundosVarado * 1000) return false;

    this.alerted = true;
    await this.ensureChannel();
    const minutos = Math.max(1, Math.round(sinMovimientoMs / 60000));
    const nombre = input.nombreUsuario?.trim() || `Usuario ${input.idUsuario}`;
    await notifee.displayNotification({
      id: NOTIFICATION_ID,
      title: "Alerta de recorrido",
      body: `${nombre} lleva aproximadamente ${minutos} min sin movimiento.`,
      data: {
        type: "stall_alert",
        routeKey: input.routeKey,
        idUsuario: String(input.idUsuario),
        sucursal: String(input.sucursal),
        latitud: String(input.latitud),
        longitud: String(input.longitud),
      },
      android: {
        channelId: CHANNEL_ID,
        importance: AndroidImportance.HIGH,
        pressAction: { id: "default" },
        smallIcon: "ic_launcher",
      },
    });
    return true;
  }

  reset(): void {
    this.routeKey = null;
    this.anchor = null;
    this.alerted = false;
    void notifee.cancelNotification(NOTIFICATION_ID).catch(() => undefined);
  }
}

export default new StallAlertService();
