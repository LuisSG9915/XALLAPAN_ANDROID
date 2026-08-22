import { Linking } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import notifee, { AndroidImportance, EventType } from "@notifee/react-native";
import DeviceInfo from "react-native-device-info";
import { fetchWithTimeout } from "./fetchWithTimeout";

const API_BASE_URL = "https://api.cbinformatica.net:9031";
const CHANNEL_ID = "actualizaciones-app";
const NOTIFIED_VERSION_KEY = "@xallapan/actualizacion_version_notificada";
const LAST_CHECK_KEY = "@xallapan/actualizacion_ultima_consulta";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type AppUpdate = {
  id: number;
  versionCode: number;
  versionApp: string;
  ligaDescarga: string;
  obligatoria: boolean;
  activa: boolean;
  notas?: string | null;
};

class AppUpdateService {
  private inicializado = false;
  private consultaEnCurso: Promise<AppUpdate | null> | null = null;

  async inicializar(): Promise<void> {
    if (this.inicializado) return;

    await notifee.createChannel({
      id: CHANNEL_ID,
      name: "Actualizaciones de la aplicación",
      importance: AndroidImportance.HIGH,
      sound: "default",
      vibration: true,
    });
    await notifee.requestPermission();

    notifee.onForegroundEvent(async ({ type, detail }) => {
      if (type !== EventType.PRESS && type !== EventType.ACTION_PRESS) return;
      const url = detail.notification?.data?.updateUrl;
      if (typeof url === "string" && url.length > 0) {
        await this.abrirDescarga(url);
      }
    });

    const initialNotification = await notifee.getInitialNotification();
    const initialUrl = initialNotification?.notification?.data?.updateUrl;
    if (typeof initialUrl === "string" && initialUrl.length > 0) {
      await this.abrirDescarga(initialUrl);
    }

    this.inicializado = true;
  }

  async verificarActualizacion(force = false): Promise<AppUpdate | null> {
    if (this.consultaEnCurso) return this.consultaEnCurso;

    this.consultaEnCurso = this.verificarActualizacionInterno(force);
    try {
      return await this.consultaEnCurso;
    } finally {
      this.consultaEnCurso = null;
    }
  }

  private async verificarActualizacionInterno(force: boolean): Promise<AppUpdate | null> {
    try {
      const ultimaConsulta = Number(await AsyncStorage.getItem(LAST_CHECK_KEY));
      if (!force && Number.isFinite(ultimaConsulta) && Date.now() - ultimaConsulta < CHECK_INTERVAL_MS) {
        return null;
      }

      await AsyncStorage.setItem(LAST_CHECK_KEY, String(Date.now()));

      const response = await fetchWithTimeout(
        `${API_BASE_URL}/api/MovilesVentas/actualizaciones`,
        { headers: { accept: "application/json" } },
        10000,
      );

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload = await response.json();
      const rows = Array.isArray(payload)
        ? payload
        : payload?.data || payload?.result || payload?.items || [];
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) return null;

      const actualizacion: AppUpdate = {
        id: Number(row.id ?? row.Id),
        versionCode: Number(row.versionCode ?? row.VersionCode),
        versionApp: String(row.versionApp ?? row.VersionApp ?? ""),
        ligaDescarga: String(row.ligaDescarga ?? row.LigaDescarga ?? ""),
        obligatoria: Boolean(row.obligatoria ?? row.Obligatoria),
        activa: Boolean(row.activa ?? row.Activa),
        notas: row.notas ?? row.Notas ?? null,
      };

      const versionInstalada = Number(DeviceInfo.getBuildNumber());
      if (!Number.isFinite(actualizacion.versionCode) || actualizacion.versionCode <= versionInstalada) {
        return null;
      }

      if (!actualizacion.ligaDescarga) return actualizacion;

      const versionNotificada = Number(await AsyncStorage.getItem(NOTIFIED_VERSION_KEY));
      if (actualizacion.obligatoria || versionNotificada !== actualizacion.versionCode) {
        await this.mostrarNotificacion(actualizacion);
        await AsyncStorage.setItem(NOTIFIED_VERSION_KEY, String(actualizacion.versionCode));
      }

      return actualizacion;
    } catch (error) {
      console.warn("[AppUpdateService] No se pudo verificar actualización:", error);
      return null;
    }
  }

  private async mostrarNotificacion(actualizacion: AppUpdate): Promise<void> {
    await notifee.createChannel({
      id: CHANNEL_ID,
      name: "Actualizaciones de la aplicación",
      importance: AndroidImportance.HIGH,
      sound: "default",
      vibration: true,
    });

    await notifee.displayNotification({
      id: `actualizacion-${actualizacion.versionCode}`,
      title: "Nueva versión disponible",
      body: `Xallapan ${actualizacion.versionApp} está disponible para descargar.`,
      data: {
        updateUrl: actualizacion.ligaDescarga,
        versionCode: String(actualizacion.versionCode),
      },
      android: {
        channelId: CHANNEL_ID,
        importance: AndroidImportance.HIGH,
        pressAction: { id: "default" },
        smallIcon: "ic_launcher",
      },
    });
  }

  private async abrirDescarga(url: string): Promise<void> {
    try {
      const supported = await Linking.canOpenURL(url);
      if (!supported) {
        console.warn("[AppUpdateService] La liga de actualización no puede abrirse:", url);
        return;
      }
      await Linking.openURL(url);
    } catch (error) {
      console.warn("[AppUpdateService] No se pudo abrir la descarga:", error);
    }
  }
}

export default new AppUpdateService();
