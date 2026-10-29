import AsyncStorage from "@react-native-async-storage/async-storage";
import { addEventListener, fetch as fetchNetwork, NetInfoState } from "@react-native-community/netinfo";
import notifee, { AndroidImportance, EventType } from "@notifee/react-native";
import DeviceInfo from "react-native-device-info";
import {
  DocumentDirectoryPath,
  downloadFile,
  exists,
  hash as hashFile,
  mkdir,
  stat as statFile,
  unlink,
} from "react-native-fs";
import { fetchWithTimeout } from "./fetchWithTimeout";
import { canRequestPackageInstalls, installApk, openInstallSettings } from "./AppUpdateNative";
import { APP_NAME } from "../theme/theme";

const API_BASE_URL = "https://api.cbinformatica.net:9031";
const GITHUB_LATEST_RELEASE_URL = "https://api.github.com/repos/LuisSG9915/XALLAPAN_ANDROID/releases/latest";
const GITHUB_MANIFEST_ASSET = "update.json";
const APPLICATION_ID = "com.awesomeproject";
const CHANNEL_ID = "actualizaciones-app";
const NOTIFIED_VERSION_KEY = "@xallapan/actualizacion_version_notificada";
const LAST_CHECK_KEY = "@xallapan/actualizacion_ultima_consulta";
const DEFERRED_VERSION_KEY = "@xallapan/actualizacion_version_pospuesta";
const DEFERRED_UNTIL_KEY = "@xallapan/actualizacion_pospuesta_hasta";
const LAST_TARGET_ID_KEY = "@xallapan/actualizacion_ultimo_objetivo_id";
const LAST_TARGET_VERSION_KEY = "@xallapan/actualizacion_ultimo_objetivo_version";
const INSTALLATION_ID_KEY = "@xallapan/actualizacion_id_instalacion";
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const DATA_DEFER_INTERVAL_MS = 30 * 60 * 1000;
const DOWNLOAD_DIRECTORY = "updates";

export type AppUpdate = {
  id: number;
  plataforma: string;
  versionCode: number;
  versionApp: string;
  downloadUrl: string;
  sha256?: string | null;
  tamanoBytes?: number | null;
  obligatoria: boolean;
  forzarInmediata: boolean;
  permitirPosponerDatos: boolean;
  fechaDespliegueUtc?: string | null;
  notas?: string | null;
};

export type UpdateCheckContext = "startup" | "foreground" | "login" | "restored" | "notification" | "poll";
export type AppUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "waiting_wifi"
  | "awaiting_data_consent"
  | "downloading"
  | "ready_to_install"
  | "awaiting_install_permission"
  | "installing"
  | "deferred"
  | "offline"
  | "error";

export type AppUpdateState = {
  phase: AppUpdatePhase;
  update: AppUpdate | null;
  progress: number;
  networkType: string | null;
  blocking: boolean;
  localPath: string | null;
  error: string | null;
};

type StateListener = (state: AppUpdateState) => void;

class AppUpdateService {
  private inicializado = false;
  private consultaEnCurso: Promise<AppUpdate | null> | null = null;
  private descargaEnCurso: Promise<string | null> | null = null;
  private notificationUnsubscribe: (() => void) | null = null;
  private networkUnsubscribe: (() => void) | null = null;
  private listeners = new Set<StateListener>();
  private state: AppUpdateState = {
    phase: "idle",
    update: null,
    progress: 0,
    networkType: null,
    blocking: false,
    localPath: null,
    error: null,
  };

  getState(): AppUpdateState {
    return this.state;
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  async inicializar(): Promise<void> {
    if (this.inicializado) return;

    await this.asegurarCanal();
    await notifee.requestPermission();

    this.notificationUnsubscribe = notifee.onForegroundEvent(async ({ type, detail }) => {
      if (type !== EventType.PRESS && type !== EventType.ACTION_PRESS) return;
      const updateId = Number(detail.notification?.data?.updateId);
      if (Number.isFinite(updateId) && updateId > 0) {
        await this.manejarToqueNotificacion(updateId);
      }
    });

    const initialNotification = await notifee.getInitialNotification();
    const initialUpdateId = Number(initialNotification?.notification?.data?.updateId);
    if (Number.isFinite(initialUpdateId) && initialUpdateId > 0) {
      await this.manejarToqueNotificacion(initialUpdateId);
    }

    this.networkUnsubscribe = addEventListener((network) => {
      const update = this.state.update;
      const canStartDownload = update &&
        !this.descargaEnCurso &&
        this.esWifi(network) &&
        ["available", "awaiting_data_consent", "deferred", "error"].includes(this.state.phase);
      if (canStartDownload) {
        void this.iniciarDescarga(update, false, this.state.blocking);
      }
    });

    await this.obtenerIdInstalacion();
    this.inicializado = true;
  }

  async procesarPushActualizacion(): Promise<void> {
    await this.verificarActualizacion(true, "notification");
  }

  async verificarActualizacion(
    force = false,
    context: UpdateCheckContext = "foreground",
  ): Promise<AppUpdate | null> {
    if (this.consultaEnCurso) return this.consultaEnCurso;

    this.consultaEnCurso = this.verificarActualizacionInterno(force, context);
    try {
      return await this.consultaEnCurso;
    } finally {
      this.consultaEnCurso = null;
    }
  }

  async autorizarDatos(): Promise<void> {
    const update = this.state.update;
    if (!update) return;
    await this.iniciarDescarga(update, true, this.state.blocking);
  }

  async posponerDatos(): Promise<void> {
    const update = this.state.update;
    if (!update) return;

    await AsyncStorage.multiSet([
      [DEFERRED_VERSION_KEY, String(update.versionCode)],
      [DEFERRED_UNTIL_KEY, String(Date.now() + DATA_DEFER_INTERVAL_MS)],
    ]);
    this.setState({ phase: "deferred", blocking: false, error: null });
    void this.registrarEvento(update, "pospuesta_datos");
  }

  async instalarActualizacion(): Promise<void> {
    const update = this.state.update;
    const path = this.state.localPath;
    if (!update || !path) return;

    try {
      const allowed = await canRequestPackageInstalls();
      if (!allowed) {
        this.setState({ phase: "awaiting_install_permission", error: null });
        await openInstallSettings();
        return;
      }

      await installApk(path);
      this.setState({ phase: "installing", blocking: true, error: null });
      void this.registrarEvento(update, "instalador_abierto");
    } catch (error: any) {
      this.setState({ phase: "error", error: error?.message || "No fue posible abrir el instalador." });
      void this.registrarEvento(update, "error", error?.message);
    }
  }

  async registrarDispositivo(datos: {
    idUsuario?: number | null;
    sucursal?: number | null;
    tokenFcm?: string | null;
    notificacionesHabilitadas?: boolean | null;
  } = {}): Promise<void> {
    const idInstalacion = await this.obtenerIdInstalacion();
    try {
      await fetchWithTimeout(
        `${API_BASE_URL}/api/AppUpdates/device`,
        {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({
            idInstalacion,
            plataforma: "android",
            applicationId: APPLICATION_ID,
            idUsuario: datos.idUsuario ?? null,
            sucursal: datos.sucursal ?? null,
            versionCode: Number(DeviceInfo.getBuildNumber()),
            versionApp: DeviceInfo.getVersion(),
            tokenFcm: datos.tokenFcm ?? null,
            notificacionesHabilitadas: datos.notificacionesHabilitadas ?? null,
          }),
        },
        8000,
      );
    } catch (error) {
      console.warn("[AppUpdateService] No se pudo registrar el dispositivo:", error);
    }
  }

  private async verificarActualizacionInterno(
    force: boolean,
    context: UpdateCheckContext,
  ): Promise<AppUpdate | null> {
    const lastCheck = Number(await AsyncStorage.getItem(LAST_CHECK_KEY));
    const installFlowInProgress = this.state.phase === "installing" || this.state.phase === "awaiting_install_permission";
    if (!force && !installFlowInProgress && Number.isFinite(lastCheck) && Date.now() - lastCheck < CHECK_INTERVAL_MS) {
      return this.state.update;
    }

    const network = await fetchNetwork().catch(() => null);
    if (!this.tieneInternet(network)) {
      this.setState({ phase: "offline", networkType: network?.type ?? null, blocking: false, error: null });
      return null;
    }

    this.setState({ phase: "checking", networkType: network?.type ?? null, error: null });

    try {
      const actualizacion = await this.consultarUltimoRelease();
      await AsyncStorage.setItem(LAST_CHECK_KEY, String(Date.now()));

      if (!actualizacion || actualizacion.versionCode <= Number(DeviceInfo.getBuildNumber())) {
        await this.registrarVersionInstaladaSiCorresponde();
        await this.limpiarEstadoActualizado();
        return null;
      }

      await AsyncStorage.multiSet([
        [LAST_TARGET_ID_KEY, String(actualizacion.id)],
        [LAST_TARGET_VERSION_KEY, String(actualizacion.versionCode)],
      ]);

      this.setState({
        update: actualizacion,
        phase: "available",
        progress: 0,
        networkType: network?.type ?? null,
        blocking: this.debeBloquear(actualizacion, context),
        localPath: null,
        error: null,
      });
      void this.registrarEventoUnaVez(actualizacion, "detectada");

      try {
        if (await this.debeNotificar(actualizacion, context)) {
          await this.mostrarNotificacion(actualizacion);
          await AsyncStorage.setItem(NOTIFIED_VERSION_KEY, String(actualizacion.versionCode));
        }
      } catch (notificationError) {
        console.warn("[AppUpdateService] No se pudo mostrar la notificación de actualización:", notificationError);
      }

      void this.evaluarDescarga(actualizacion, context, network).catch((error) => {
        this.setState({ phase: "error", blocking: false, error: "No fue posible preparar la descarga." });
        console.warn("[AppUpdateService] No se pudo preparar la descarga:", error);
      });
      return actualizacion;
    } catch (error) {
      this.setState({ phase: "error", networkType: network?.type ?? null, blocking: false, error: "No fue posible verificar actualizaciones." });
      console.warn("[AppUpdateService] No se pudo verificar actualización:", error);
      return null;
    }
  }

  private async evaluarDescarga(
    update: AppUpdate,
    context: UpdateCheckContext,
    network: NetInfoState | null,
  ): Promise<void> {
    if (!update.downloadUrl) {
      this.setState({ phase: "error", error: "La actualización no tiene una descarga configurada." });
      return;
    }

    if (this.esWifi(network)) {
      await this.iniciarDescarga(update, false, this.debeBloquear(update, context));
      return;
    }

    if (await this.estaPospuesta(update)) {
      this.setState({ phase: "deferred", blocking: false, networkType: network?.type ?? null });
      return;
    }

    this.setState({
      phase: "awaiting_data_consent",
      networkType: network?.type ?? null,
      blocking: this.debeBloquear(update, context),
    });
  }

  private async iniciarDescarga(
    update: AppUpdate,
    autorizadaPorUsuario: boolean,
    blocking: boolean,
  ): Promise<string | null> {
    if (this.descargaEnCurso) return this.descargaEnCurso;

    this.descargaEnCurso = this.descargar(update, autorizadaPorUsuario, blocking);
    try {
      return await this.descargaEnCurso;
    } finally {
      this.descargaEnCurso = null;
    }
  }

  private async descargar(
    update: AppUpdate,
    autorizadaPorUsuario: boolean,
    blocking: boolean,
  ): Promise<string | null> {
    const network = await fetchNetwork().catch(() => null);
    if (!this.esWifi(network) && !autorizadaPorUsuario) {
      this.setState({ phase: "awaiting_data_consent", networkType: network?.type ?? null });
      return null;
    }

    const directory = `${DocumentDirectoryPath}/${DOWNLOAD_DIRECTORY}`;
    const path = `${directory}/xallapan-${update.versionCode}.apk`;
    try {
      await mkdir(directory);
      if (await exists(path)) {
        const existing = await statFile(path);
        if (await this.archivoValido(path, Number(existing.size), update)) {
          await AsyncStorage.setItem(DEFERRED_VERSION_KEY, "");
          await AsyncStorage.setItem(DEFERRED_UNTIL_KEY, "0");
          this.setState({ phase: "ready_to_install", progress: 1, localPath: path, blocking, error: null });
          return path;
        }
        await unlink(path);
      }

      this.setState({ phase: "downloading", progress: 0, localPath: path, blocking, error: null });
      void this.registrarEvento(update, "descarga_iniciada");
      let lastProgressAt = 0;
      const download = downloadFile({
        fromUrl: update.downloadUrl,
        toFile: path,
        background: true,
        discretionary: false,
        cacheable: false,
        progressDivider: 10,
        progress: ({ contentLength, bytesWritten }) => {
          const now = Date.now();
          if (now - lastProgressAt < 250 && bytesWritten < contentLength) return;
          lastProgressAt = now;
          const progress = contentLength > 0 ? bytesWritten / contentLength : 0;
          this.setState({ phase: "downloading", progress, localPath: path, blocking });
        },
      });
      const result = await download.promise;
      if (result.statusCode < 200 || result.statusCode >= 300) {
        throw new Error(`HTTP ${result.statusCode}`);
      }

      const stat = await statFile(path);
      if (!(await this.archivoValido(path, Number(stat.size), update))) {
        await unlink(path).catch(() => undefined);
        throw new Error("La descarga no coincide con el hash o tamaño esperado.");
      }

      await AsyncStorage.multiSet([
        [DEFERRED_VERSION_KEY, ""],
        [DEFERRED_UNTIL_KEY, "0"],
      ]);
      this.setState({ phase: "ready_to_install", progress: 1, localPath: path, blocking, error: null });
      void this.registrarEvento(update, "descargada");
      await this.mostrarNotificacionLista(update);
      return path;
    } catch (error: any) {
      this.setState({ phase: "error", localPath: path, blocking: false, error: error?.message || "No fue posible descargar la actualización." });
      void this.registrarEvento(update, "error", error?.message);
      return null;
    }
  }

  private async manejarToqueNotificacion(updateId: number): Promise<void> {
    if (this.state.update?.id === updateId && this.state.phase === "ready_to_install") {
      await this.instalarActualizacion();
      return;
    }
    await this.verificarActualizacion(true, "notification");
    if (this.state.update?.id === updateId && this.state.phase === "awaiting_data_consent") {
      this.setState({ blocking: true });
    }
  }

  private async asegurarCanal(): Promise<void> {
    await notifee.createChannel({
      id: CHANNEL_ID,
      name: "Actualizaciones de la aplicación",
      importance: AndroidImportance.HIGH,
      sound: "default",
      vibration: true,
    });
  }

  private async mostrarNotificacion(update: AppUpdate): Promise<void> {
    await this.asegurarCanal();
    await notifee.displayNotification({
      id: `actualizacion-${update.versionCode}`,
      title: "Nueva versión disponible",
      body: `${APP_NAME} ${update.versionApp} está disponible. Toca para revisar la descarga.`,
      data: {
        updateId: String(update.id),
        versionCode: String(update.versionCode),
      },
      android: {
        channelId: CHANNEL_ID,
        importance: AndroidImportance.HIGH,
        pressAction: { id: "default" },
        smallIcon: "ic_launcher",
      },
    });
  }

  private async mostrarNotificacionLista(update: AppUpdate): Promise<void> {
    await this.asegurarCanal();
    await notifee.displayNotification({
      id: `actualizacion-lista-${update.versionCode}`,
      title: "Actualización lista para instalar",
      body: `${APP_NAME} ${update.versionApp} terminó de descargarse. Toca para instalar.`,
      data: {
        updateId: String(update.id),
        versionCode: String(update.versionCode),
      },
      android: {
        channelId: CHANNEL_ID,
        importance: AndroidImportance.HIGH,
        pressAction: { id: "default" },
        smallIcon: "ic_launcher",
      },
    });
  }

  private async registrarEventoUnaVez(update: AppUpdate, event: string): Promise<void> {
    const key = `@xallapan/actualizacion_evento:${event}:${update.versionCode}`;
    if (await AsyncStorage.getItem(key)) return;
    if (await this.registrarEvento(update, event)) {
      await AsyncStorage.setItem(key, "1");
    }
  }

  private async registrarVersionInstaladaSiCorresponde(): Promise<void> {
    const targetVersion = Number(await AsyncStorage.getItem(LAST_TARGET_VERSION_KEY));
    const targetId = Number(await AsyncStorage.getItem(LAST_TARGET_ID_KEY));
    const installedVersion = Number(DeviceInfo.getBuildNumber());
    if (!Number.isFinite(targetVersion) || targetVersion <= 0 || installedVersion < targetVersion) return;

    const update: AppUpdate = {
      id: Number.isFinite(targetId) ? targetId : 0,
      plataforma: "android",
      versionCode: targetVersion,
      versionApp: "",
      downloadUrl: "",
      obligatoria: false,
      forzarInmediata: false,
      permitirPosponerDatos: true,
    };
    if (await this.registrarEvento(update, "actualizada")) {
      await AsyncStorage.multiSet([
        [LAST_TARGET_ID_KEY, ""],
        [LAST_TARGET_VERSION_KEY, "0"],
      ]);
    }
  }

  private async registrarEvento(update: AppUpdate, event: string, detail?: string): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(
        `${API_BASE_URL}/api/AppUpdates/events`,
        {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({
            idActualizacion: update.id > 0 ? update.id : null,
            idInstalacion: await this.obtenerIdInstalacion(),
            versionCodeInstalada: Number(DeviceInfo.getBuildNumber()),
            versionCodeObjetivo: update.versionCode,
            tipoEvento: event,
            detalle: detail ?? null,
          }),
        },
        8000,
      );
      return response.ok;
    } catch (error) {
      console.warn(`[AppUpdateService] No se pudo registrar evento ${event}:`, error);
      return false;
    }
  }

  private async obtenerIdInstalacion(): Promise<string> {
    const stored = await AsyncStorage.getItem(INSTALLATION_ID_KEY);
    if (stored) return stored;
    const id = `xallapan-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    await AsyncStorage.setItem(INSTALLATION_ID_KEY, id);
    return id;
  }

  private async estaPospuesta(update: AppUpdate): Promise<boolean> {
    const version = Number(await AsyncStorage.getItem(DEFERRED_VERSION_KEY));
    const until = Number(await AsyncStorage.getItem(DEFERRED_UNTIL_KEY));
    return version === update.versionCode && Number.isFinite(until) && until > Date.now();
  }

  private async archivoValido(path: string, size: number, update: AppUpdate): Promise<boolean> {
    if (update.tamanoBytes && size !== update.tamanoBytes) return false;
    if (!update.sha256) return size > 0;
    const hash = await hashFile(path, "sha256");
    return hash.toLowerCase() === update.sha256.toLowerCase();
  }

  private async limpiarEstadoActualizado(): Promise<void> {
    const currentPath = this.state.localPath;
    if (currentPath && await exists(currentPath)) {
      await unlink(currentPath).catch(() => undefined);
    }
    this.setState({ phase: "idle", update: null, progress: 0, blocking: false, localPath: null, error: null });
  }

  private async consultarUltimoRelease(): Promise<AppUpdate | null> {
    const response = await fetchWithTimeout(
      GITHUB_LATEST_RELEASE_URL,
      { headers: { accept: "application/vnd.github+json" } },
      10000,
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const release = await response.json();
    return this.actualizacionDesdeRelease(release);
  }

  private async actualizacionDesdeRelease(release: any): Promise<AppUpdate | null> {
    if (!release || typeof release !== "object") return null;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const apk = assets.find((asset: any) => String(asset?.name ?? "").toLowerCase().endsWith(".apk"));
    if (!apk?.browser_download_url) return null;

    let manifest: any = null;
    const manifestAsset = assets.find((asset: any) => asset?.name === GITHUB_MANIFEST_ASSET);
    if (manifestAsset?.browser_download_url) {
      manifest = await fetchWithTimeout(
        manifestAsset.browser_download_url,
        { headers: { accept: "application/json" } },
        8000,
      )
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null);
    }

    const tagInfo = this.parsearTagRelease(String(release.tag_name ?? ""));
    return this.normalizarActualizacion({
      plataforma: "android",
      ...(manifest ?? {}),
      id: release.id,
      versionCode: manifest?.versionCode ?? manifest?.VersionCode ?? tagInfo.versionCode,
      versionApp: manifest?.versionApp ?? manifest?.VersionApp ?? tagInfo.versionApp,
      downloadUrl: apk.browser_download_url,
      tamanoBytes: manifest?.tamanoBytes ?? manifest?.TamanoBytes ?? apk.size ?? null,
      notas: manifest?.notas ?? manifest?.Notas ?? release.body ?? null,
      fechaDespliegueUtc: manifest?.fechaDespliegueUtc ?? release.published_at ?? null,
    });
  }

  private parsearTagRelease(tag: string): { versionCode: number; versionApp: string } {
    const limpio = tag.trim().replace(/^v/i, "");
    const [versionApp, build] = limpio.split("+");
    let versionCode = Number.parseInt(build ?? "", 10);
    if (!Number.isFinite(versionCode) || versionCode <= 0) {
      versionCode = Number.parseInt(versionApp, 10);
    }
    return { versionCode, versionApp };
  }

  private normalizarActualizacion(row: any): AppUpdate | null {
    if (!row || typeof row !== "object") return null;
    const versionCode = Number(row.versionCode ?? row.VersionCode);
    const id = Number(row.id ?? row.Id);
    const downloadUrl = String(row.downloadUrl ?? row.DownloadUrl ?? row.ligaDescarga ?? row.LigaDescarga ?? "");
    if (!Number.isFinite(id) || !Number.isFinite(versionCode) || versionCode <= 0) return null;

    return {
      id,
      plataforma: String(row.plataforma ?? row.Plataforma ?? "android"),
      versionCode,
      versionApp: String(row.versionApp ?? row.VersionApp ?? ""),
      downloadUrl,
      sha256: row.sha256 ?? row.Sha256 ?? null,
      tamanoBytes: this.toNullableNumber(row.tamanoBytes ?? row.TamanoBytes),
      obligatoria: this.toBoolean(row.obligatoria ?? row.Obligatoria, true),
      forzarInmediata: this.toBoolean(row.forzarInmediata ?? row.ForzarInmediata, false),
      permitirPosponerDatos: this.toBoolean(row.permitirPosponerDatos ?? row.PermitirPosponerDatos, true),
      fechaDespliegueUtc: row.fechaDespliegueUtc ?? row.FechaDespliegueUtc ?? null,
      notas: row.notas ?? row.Notas ?? null,
    };
  }

  private debeBloquear(update: AppUpdate, context: UpdateCheckContext): boolean {
    return update.forzarInmediata ||
      (update.obligatoria && (context === "login" || context === "restored"));
  }

  private async debeNotificar(update: AppUpdate, context: UpdateCheckContext): Promise<boolean> {
    if (context === "poll") return false;
    if (update.forzarInmediata && context === "notification") return true;
    const notifiedVersion = Number(await AsyncStorage.getItem(NOTIFIED_VERSION_KEY));
    return notifiedVersion !== update.versionCode;
  }

  private tieneInternet(network: NetInfoState | null): boolean {
    return network?.isConnected === true && network.isInternetReachable !== false;
  }

  private esWifi(network: NetInfoState | null): boolean {
    return this.tieneInternet(network) && (network?.type === "wifi" || network?.type === "ethernet");
  }

  private toNullableNumber(value: any): number | null {
    const number = Number(value);
    return value === null || value === undefined || value === "" || !Number.isFinite(number) ? null : number;
  }

  private toBoolean(value: any, defaultValue: boolean): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value.toLowerCase() === "false") return false;
      if (value.toLowerCase() === "true") return true;
    }
    if (value === null || value === undefined) return defaultValue;
    return Boolean(value);
  }

  private setState(patch: Partial<AppUpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener(this.state));
  }
}

export default new AppUpdateService();
