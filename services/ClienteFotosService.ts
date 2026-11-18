import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import RNFS from "react-native-fs";
import { launchCamera, launchImageLibrary } from "react-native-image-picker";
import type { PhotoQuality } from "react-native-image-picker";
import { PermissionsAndroid, Platform } from "react-native";
import Realm from "realm";
import { fetchWithTimeout } from "./fetchWithTimeout";
import FotoUploadSettingsService from "./FotoUploadSettingsService";

const API_BASE_URL = "https://api.cbinformatica.net:9031";
const FULL_DOWNLOAD_STATE_KEY = "@xallapan/fotos/full_download_state";

export type ClienteFotosFullDownloadStatus = {
  estado: "idle" | "downloading" | "success" | "error";
  error?: string | null;
  fecha?: string | null;
  progreso?: number | null;
};
const MAX_FOTOS = 5;
const ESTADOS_PENDIENTES = ["pendiente", "error"];
const FOTO_REQUEST_TIMEOUT_MS = 20_000;
// La descarga full pesa ~150 MB: va directo a disco con RNFS (a velocidad
// de red real) y se parsea por chunks para no cargar todo en memoria.
const FOTO_FULL_DOWNLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const FOTO_FULL_UPSERT_BATCH = 25;
const FOTO_FULL_PROGRESS_INTERVAL_MS = 2000;
const FOTO_FULL_READ_TIMEOUT_MS = 120_000;
const FOTO_FULL_CONNECTION_TIMEOUT_MS = 30_000;
const FOTO_MAX_DIMENSION = 1280;

const isJsonWhitespace = (code: number): boolean =>
  code === 32 || code === 9 || code === 10 || code === 13;

/**
 * RNFS.read con encoding "ascii" devuelve una cadena binaria (un char por
 * byte). Los campos de texto libre con UTF-8 (p. ej. etiqueta) quedan como
 * mojibake latin1; esta función los reinterpreta como UTF-8.
 */
const repairLatin1Utf8 = (value: string): string => {
  if (!/[^\x00-\x7F]/.test(value)) return value;
  try {
    return decodeURIComponent(escape(value));
  } catch {
    return value;
  }
};
const FOTO_JPEG_QUALITY: PhotoQuality = 0.5;
const FOTO_MAX_SIZE_BYTES = 5 * 1024 * 1024;

export const parseActiva = (value: unknown): boolean => {
  if (value === undefined || value === null) return true;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return ["1", "true", "si", "sí"].includes(value.trim().toLowerCase());
  return false;
};

export const formatClienteFotosFechaInicial = (date: Date): string => {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}.${ms}`;
};

export type ClienteFoto = {
  id: string;
  idServidor?: number | null;
  idMovil: string;
  idCliente: number;
  foto?: string | null;
  fotoMiniatura?: string | null;
  fotoServidor?: string | null;
  fotoMiniaturaServidor?: string | null;
  fotoBase64?: string | null;
  fotoMiniaturaBase64?: string | null;
  mimeType?: string | null;
  miniaturaMimeType?: string | null;
  nombreArchivo?: string | null;
  etiqueta?: string | null;
  fechaCaptura?: Date | null;
  fechaLog?: Date | null;
  activa: boolean;
  estado: string;
  errorMensaje?: string | null;
  syncedAt?: Date | null;
};

class ClienteFotosService {
  private realm: Realm | null = null;
  private fullDownloadListeners = new Set<
    (status: ClienteFotosFullDownloadStatus) => void
  >();
  private fullDownloadInFlight = false;

  setRealm(realm: Realm): void {
    this.realm = realm;
  }

  /**
   * Estado persistido de la última descarga full de fotografías.
   * Si la app se cerró a mitad de la descarga, el estado quedó en
   * "downloading": se reporta como error para ofrecer el reintento manual.
   */
  async getFullDownloadStatus(): Promise<ClienteFotosFullDownloadStatus> {
    try {
      const stored = await AsyncStorage.getItem(FULL_DOWNLOAD_STATE_KEY);
      if (!stored) return { estado: "idle" };
      const parsed = JSON.parse(stored) as ClienteFotosFullDownloadStatus;
      if (parsed.estado === "downloading" && !this.fullDownloadInFlight) {
        return {
          ...parsed,
          estado: "error",
          error: "La descarga de fotografías se interrumpió.",
        };
      }
      return parsed;
    } catch (error) {
      console.warn("[ClienteFotos] No se pudo leer el estado de descarga:", error);
      return { estado: "idle" };
    }
  }

  subscribeFullDownload(
    listener: (status: ClienteFotosFullDownloadStatus) => void
  ): () => void {
    this.fullDownloadListeners.add(listener);
    void this.getFullDownloadStatus().then(listener);
    return () => {
      this.fullDownloadListeners.delete(listener);
    };
  }

  private async setFullDownloadStatus(
    estado: ClienteFotosFullDownloadStatus["estado"],
    error?: string,
    progreso: number | null = null
  ): Promise<void> {
    const status: ClienteFotosFullDownloadStatus = {
      estado,
      error: error ?? null,
      fecha: new Date().toISOString(),
      progreso,
    };
    try {
      await AsyncStorage.setItem(FULL_DOWNLOAD_STATE_KEY, JSON.stringify(status));
    } catch (storageError) {
      console.warn("[ClienteFotos] No se pudo guardar el estado de descarga:", storageError);
    }
    this.fullDownloadListeners.forEach((listener) => {
      try {
        listener(status);
      } catch (listenerError) {
        console.warn("[ClienteFotos] Error en listener de estado:", listenerError);
      }
    });
  }

  getFotos(idCliente: number): ClienteFoto[] {
    if (!this.realm || this.realm.isClosed) return [];
    return Array.from(
      this.realm
        .objects<ClienteFoto>("ClienteFoto")
        .filtered("idCliente == $0 AND activa == true", idCliente)
    );
  }

  getAllFotos(idCliente?: number): ClienteFoto[] {
    if (!this.realm || this.realm.isClosed) return [];
    const fotos = this.realm.objects<ClienteFoto>("ClienteFoto");
    const filtradas = idCliente == null ? fotos : fotos.filtered("idCliente == $0", idCliente);
    return Array.from(filtradas.sorted("fechaCaptura", true));
  }

  getActiveCount(idCliente: number): number {
    return this.getFotos(idCliente).length;
  }

  getLastLogDate(): Date {
    const fallback = new Date("1900-01-01T00:00:00Z");
    if (!this.realm || this.realm.isClosed) return fallback;

    let latest: Date | null = null;
    const rows = Array.from(this.realm.objects<ClienteFoto>("ClienteFoto"));
    for (const row of rows) {
      const value = row.fechaLog instanceof Date ? row.fechaLog : row.fechaLog ? new Date(row.fechaLog) : null;
      if (!value || Number.isNaN(value.getTime())) continue;
      if (!latest || value.getTime() > latest.getTime()) latest = value;
    }
    return latest ? new Date(latest.getTime() + 10) : fallback;
  }

  canAdd(idCliente: number): boolean {
    return this.getActiveCount(idCliente) < MAX_FOTOS;
  }

  async selectAndQueue(
    idCliente: number,
    usrAlta: number,
    source: "camera" | "library",
    solicitarEtiqueta?: () => Promise<string | null>
  ): Promise<ClienteFoto> {
    if (!this.realm || this.realm.isClosed)
      throw new Error("Realm no inicializado");
    if (!this.canAdd(idCliente))
      throw new Error(
        `El cliente ya tiene el máximo de ${MAX_FOTOS} fotografías.`
      );

    if (source === "camera" && Platform.OS === "android") {
      const permission = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.CAMERA,
        {
          title: "Permiso para usar la cámara",
          message:
            "Xallapan necesita acceso a la cámara para registrar fotografías del cliente.",
          buttonPositive: "Permitir",
          buttonNegative: "No permitir",
        }
      );
      if (permission !== PermissionsAndroid.RESULTS.GRANTED) {
        throw new Error("Se necesita permiso para usar la cámara.");
      }
    }

    const result =
      source === "camera"
        ? await launchCamera({
            mediaType: "photo",
            cameraType: "back",
            maxWidth: FOTO_MAX_DIMENSION,
            maxHeight: FOTO_MAX_DIMENSION,
            quality: FOTO_JPEG_QUALITY,
            saveToPhotos: false,
          })
        : await launchImageLibrary({
            mediaType: "photo",
            selectionLimit: 1,
            maxWidth: FOTO_MAX_DIMENSION,
            maxHeight: FOTO_MAX_DIMENSION,
            quality: FOTO_JPEG_QUALITY,
          });
    if (result.didCancel) throw new Error("CAPTURE_CANCELLED");
    if (result.errorCode)
      throw new Error(
        result.errorMessage || "No se pudo obtener la fotografía."
      );
    const asset = result.assets?.[0];
    if (!asset?.uri)
      throw new Error("La selección no contiene una fotografía válida.");
    if (
      typeof asset.fileSize === "number" &&
      asset.fileSize > FOTO_MAX_SIZE_BYTES
    ) {
      throw new Error("La fotografía no puede superar los 5 MB.");
    }

    const etiqueta = solicitarEtiqueta
      ? await solicitarEtiqueta()
      : null;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const idMovil = `${idCliente}-${id}`;
    const isPng = asset.type === "image/png";
    const extension = isPng ? ".png" : ".jpg";
    const directory = `${RNFS.DocumentDirectoryPath}/cliente-fotos/${idCliente}`;
    const localPath = `${directory}/${id}${extension}`;
    await RNFS.mkdir(directory);
    await RNFS.copyFile(asset.uri, localPath);

    const foto: ClienteFoto = {
      id,
      idServidor: null,
      idMovil,
      idCliente,
      foto: localPath,
      fotoMiniatura: null,
      fotoServidor: null,
      fotoMiniaturaServidor: null,
      fotoBase64: null,
      fotoMiniaturaBase64: null,
      mimeType: isPng ? "image/png" : "image/jpeg",
      miniaturaMimeType: null,
      nombreArchivo: `${id}${extension}`,
      etiqueta: etiqueta?.trim() || null,
      fechaCaptura: new Date(),
      fechaLog: null,
      activa: true,
      estado: "pendiente",
      errorMensaje: null,
      syncedAt: null,
    };
    this.realm.write(() => this.realm!.create("ClienteFoto", foto));
    return foto;
  }

  private lastFullDownloadProgressAt = 0;

  private reportFullDownloadProgress(progreso: number): void {
    const now = Date.now();
    if (now - this.lastFullDownloadProgressAt < FOTO_FULL_PROGRESS_INTERVAL_MS) return;
    this.lastFullDownloadProgressAt = now;
    void this.setFullDownloadStatus("downloading", undefined, progreso);
  }

  async downloadFull(idCliente = 0, ruta = 0): Promise<number> {
    this.fullDownloadInFlight = true;
    this.lastFullDownloadProgressAt = 0;
    await this.setFullDownloadStatus("downloading", undefined, 0);
    let tempPath: string | null = null;
    try {
      const url = `${API_BASE_URL}/api/MovilesVentas/sp_MovilesClientesFotosFull?idCliente=${idCliente}&ruta=${ruta}`;
      // HEAD best-effort para conocer el tamaño total y mostrar % real; si
      // el API no lo reporta, el progreso queda indeterminado.
      let expectedBytes = 0;
      try {
        const head = await fetchWithTimeout(
          url,
          { method: "HEAD" },
          FOTO_REQUEST_TIMEOUT_MS
        );
        const len = Number(head.headers.get("content-length"));
        if (head.ok && Number.isFinite(len) && len > 0) expectedBytes = len;
      } catch {
        expectedBytes = 0;
      }
      await this.setFullDownloadStatus(
        "downloading",
        undefined,
        expectedBytes > 0 ? 0 : null
      );
      tempPath = `${RNFS.CachesDirectoryPath}/cliente-fotos-full-${Date.now()}.json`;
      const { promise } = RNFS.downloadFile({
        fromUrl: url,
        toFile: tempPath,
        headers: { accept: "application/json" },
        connectionTimeout: FOTO_FULL_CONNECTION_TIMEOUT_MS,
        readTimeout: FOTO_FULL_READ_TIMEOUT_MS,
        progressInterval: 1000,
        progress: (res) => {
          const total = expectedBytes > 0 ? expectedBytes : res.contentLength;
          if (total > 0) {
            const progreso = Math.min(
              89,
              Math.round((res.bytesWritten / total) * 90)
            );
            this.reportFullDownloadProgress(progreso);
          }
        },
      });
      const result = await promise;
      if (result.statusCode < 200 || result.statusCode >= 300)
        throw new Error(`HTTP ${result.statusCode} al descargar fotos`);
      const count = await this.parseRemoteRowsFile(tempPath);
      await this.setFullDownloadStatus("success", undefined, 100);
      return count;
    } catch (error) {
      await this.setFullDownloadStatus(
        "error",
        error instanceof Error ? error.message : "Error desconocido"
      );
      throw error;
    } finally {
      if (tempPath) RNFS.unlink(tempPath).catch(() => undefined);
      this.fullDownloadInFlight = false;
    }
  }

  /**
   * Parsea el JSON descargado a disco por chunks: extrae cada objeto del
   * arreglo superior y lo vuelca a Realm en lotes, sin cargar los ~150 MB
   * completos en memoria (evita OOM y el JSON.parse monolítico).
   */
  private async parseRemoteRowsFile(filePath: string): Promise<number> {
    const info = await RNFS.stat(filePath);
    const fileSize = Number(info?.size) || 0;
    if (fileSize <= 0) {
      throw new Error("La descarga de fotografías llegó vacía.");
    }

    type ScanState = "inicio" | "entre" | "objeto";
    let state: ScanState = "inicio";
    let pending = "";
    let scanOffset = 0;
    let depth = 0;
    let inString = false;
    let objectStart = -1;
    let sawArrayEnd = false;
    let batch: any[] = [];
    let count = 0;
    let position = 0;

    const upsertBatch = async () => {
      if (batch.length === 0) return;
      const rows = batch;
      batch = [];
      // Las fotos base64 se escriben como archivos en disco (decode nativo);
      // Realm solo guarda la ruta. Evita cargar ~150 MB de strings en la BD.
      await Promise.all(rows.map((row) => this.persistRemoteFotoFiles(row)));
      count += this.upsertRemoteRows(rows);
      await new Promise<void>((resolve) => setImmediate(() => resolve()));
    };

    while (position < fileSize) {
      const length = Math.min(FOTO_FULL_DOWNLOAD_CHUNK_BYTES, fileSize - position);
      // "ascii": cadena binaria byte-a-char; evita el utf8.decode (el decode
      // más costoso en JS puro). El JSON/base64 es ASCII puro, así que la
      // estructura nunca se afecta; solo campos de texto libre pueden venir
      // como latin1 y se reparan por fila más abajo.
      const chunk = await RNFS.read(filePath, length, position, "ascii");
      position += length;
      this.reportFullDownloadProgress(
        90 + Math.min(9, Math.round((position / fileSize) * 10))
      );
      pending += chunk;

      let index = scanOffset;
      while (index < pending.length) {
        const code = pending.charCodeAt(index);
        if (state === "inicio") {
          if (code === 91) state = "entre"; // [
          else if (!isJsonWhitespace(code) && code !== 0xfeff) {
            throw new Error("La respuesta de fotografías no es una lista JSON.");
          }
          index += 1;
        } else if (state === "entre") {
          if (code === 123) { // {
            state = "objeto";
            depth = 1;
            inString = false;
            objectStart = index;
          } else if (code === 93) { // ]
            sawArrayEnd = true;
          } else if (code !== 44 && !isJsonWhitespace(code) && code !== 0xfeff) { // ,
            throw new Error("La respuesta de fotografías tiene formato inesperado.");
          }
          index += 1;
        } else if (!inString) {
          if (code === 34) { // "
            inString = true;
          } else if (code === 123) { // {
            depth += 1;
          } else if (code === 125) { // }
            depth -= 1;
            if (depth === 0) {
              try {
                const row = JSON.parse(pending.slice(objectStart, index + 1));
                if (row && typeof row === "object" && !Array.isArray(row)) {
                  if (typeof row.etiqueta === "string") {
                    row.etiqueta = repairLatin1Utf8(row.etiqueta);
                  }
                  batch.push(row);
                }
              } catch (parseError) {
                console.warn(
                  "[ClienteFotos] Se omitió una fila con JSON inválido:",
                  parseError
                );
              }
              state = "entre";
              objectStart = -1;
              if (batch.length >= FOTO_FULL_UPSERT_BATCH) await upsertBatch();
            }
          }
          index += 1;
        } else {
          // Dentro de un string: saltar directo a la siguiente comilla no
          // escapada (los base64 no contienen " ni \). Una comilla está
          // escapada si va precedida de un número impar de backslashes.
          const nextQuote = pending.indexOf('"', index);
          if (nextQuote === -1) {
            index = pending.length;
          } else {
            let backslashes = 0;
            let k = nextQuote - 1;
            while (k >= 0 && pending.charCodeAt(k) === 92) {
              backslashes += 1;
              k -= 1;
            }
            index = nextQuote + 1;
            if (backslashes % 2 === 0) inString = false;
          }
        }
      }

      if (state === "objeto") {
        pending = pending.slice(objectStart);
        scanOffset = pending.length;
        objectStart = 0;
      } else {
        pending = "";
        scanOffset = 0;
      }
    }

    if (state === "objeto" || state === "inicio" || !sawArrayEnd) {
      throw new Error("La descarga de fotografías llegó incompleta.");
    }
    await upsertBatch();
    return count;
  }

  /**
   * Escribe las fotos base64 de una fila remota como archivos JPEG/PNG en
   * disco (RNFS decodifica base64 de forma nativa) y deja en la fila las
   * rutas locales (__localFoto/__localMini) para que upsertRemoteRows las
   * guarde en lugar de los strings base64.
   */
  private async persistRemoteFotoFiles(row: any): Promise<void> {
    const hasFoto = typeof row.fotoBase64 === "string" && row.fotoBase64.length > 0;
    const hasMini =
      typeof row.fotoMiniaturaBase64 === "string" && row.fotoMiniaturaBase64.length > 0;
    if (!hasFoto && !hasMini) return;

    const idServidor = row.id == null ? null : Number(row.id);
    const idCliente = Number(row.idCliente) || 0;
    const dir = `${RNFS.DocumentDirectoryPath}/cliente-fotos-remote/${idCliente}`;
    const base = `srv_${idServidor ?? "x"}`;
    const ext = (mime: unknown) =>
      mime && /png/i.test(String(mime)) ? ".png" : ".jpg";

    await RNFS.mkdir(dir).catch(() => undefined);

    const jobs: Promise<void>[] = [];
    if (hasFoto) {
      const filePath = `${dir}/${base}${ext(row.fotoMimeType)}`;
      jobs.push(
        RNFS.writeFile(filePath, row.fotoBase64, "base64")
          .then(() => {
            row.__localFoto = filePath;
          })
          .catch((error) =>
            console.warn("[ClienteFotos] No se pudo guardar foto remota:", error)
          )
      );
      row.fotoBase64 = null;
    }
    if (hasMini) {
      const filePath = `${dir}/${base}_mini${ext(row.fotoMiniaturaMimeType)}`;
      jobs.push(
        RNFS.writeFile(filePath, row.fotoMiniaturaBase64, "base64")
          .then(() => {
            row.__localMini = filePath;
          })
          .catch((error) =>
            console.warn("[ClienteFotos] No se pudo guardar miniatura remota:", error)
          )
      );
      row.fotoMiniaturaBase64 = null;
    }
    await Promise.all(jobs);
  }

  async downloadIncremental(
    since: Date,
    idCliente = 0,
    ruta = 0
  ): Promise<number> {
    const response = await fetchWithTimeout(
      `${API_BASE_URL}/api/MovilesVentas/sp_MovilesClientesFotos?fechaInicial=${encodeURIComponent(
        formatClienteFotosFechaInicial(since)
      )}&idCliente=${idCliente}&ruta=${ruta}`,
      { headers: { accept: "application/json" } },
      FOTO_REQUEST_TIMEOUT_MS
    );
    if (!response.ok)
      throw new Error(`HTTP ${response.status} al descargar cambios de fotos`);
    const rows = await response.json();
    const list = Array.isArray(rows) ? rows : [];
    await Promise.all(list.map((row) => this.persistRemoteFotoFiles(row)));
    return this.upsertRemoteRows(list);
  }

  async syncPending(
    usrAlta: number
  ): Promise<{ sent: number; failed: number }> {
    if (!this.realm || this.realm.isClosed) return { sent: 0, failed: 0 };
    if (await FotoUploadSettingsService.getRequireWifi()) {
      const network = await NetInfo.fetch().catch(() => null);
      if (network?.type !== "wifi") {
        console.log("[ClienteFotos] Arrastre omitido: se requiere conexión Wi-Fi.");
        return { sent: 0, failed: 0 };
      }
    }
    const pending = Array.from(
      this.realm
        .objects<ClienteFoto>("ClienteFoto")
        .filtered("activa == true AND estado IN $0", ESTADOS_PENDIENTES)
    );
    let sent = 0;
    let failed = 0;
    console.log("[ClienteFotos] Pendientes de arrastre:", {
      total: pending.length,
      ids: pending.map((foto) => foto.id),
    });
    for (const foto of pending) {
      try {
        console.log("[ClienteFotos] Subiendo fotografía:", {
          id: foto.id,
          idCliente: foto.idCliente,
          estado: foto.estado,
          tieneArchivo: Boolean(foto.foto),
        });
        await this.upload(foto, usrAlta);
        sent++;
      } catch (error) {
        failed++;
        const mensaje =
          error instanceof Error ? error.message : "Error desconocido";
        console.error("[ClienteFotos] Falló fotografía:", {
          id: foto.id,
          idCliente: foto.idCliente,
          mensaje,
        });
        try {
          this.realm.write(() => {
            const local = this.realm!.objectForPrimaryKey<ClienteFoto>(
              "ClienteFoto",
              foto.id
            );
            if (local) {
              local.estado = "error";
              local.errorMensaje = mensaje;
            }
          });
        } catch (persistError) {
          console.error("[ClienteFotos] No se pudo guardar el error local:", {
            id: foto.id,
            mensaje:
              persistError instanceof Error
                ? persistError.message
                : "Error desconocido",
          });
        }
      }
    }
    return { sent, failed };
  }

  private async upload(foto: ClienteFoto, usrAlta: number): Promise<void> {
    if (!foto.foto || !this.realm)
      throw new Error("La fotografía local no está disponible.");
    const fileUri = foto.foto.startsWith("file://")
      ? foto.foto
      : `file://${foto.foto}`;
    const fileExists = await RNFS.exists(foto.foto);
    console.log("[ClienteFotos] Archivo local:", {
      id: foto.id,
      uri: fileUri,
      existe: fileExists,
    });
    if (!fileExists)
      throw new Error("El archivo local de la fotografía no existe.");
    this.realm.write(() => {
      const local = this.realm!.objectForPrimaryKey<ClienteFoto>(
        "ClienteFoto",
        foto.id
      );
      if (local) {
        local.estado = "sincronizando";
        local.errorMensaje = null;
      }
    });

    const body = new FormData();
    body.append("IdCliente", String(foto.idCliente));
    body.append("UsrAlta", String(usrAlta));
    body.append("Etiqueta", foto.etiqueta?.trim() || "");
    body.append(
      "FechaCaptura",
      (foto.fechaCaptura || new Date()).toISOString()
    );
    body.append("Archivo", {
      uri: fileUri,
      type: foto.mimeType || "image/jpeg",
      name: foto.nombreArchivo || `${foto.id}.jpg`,
    } as any);
    const response = await fetchWithTimeout(
      `${API_BASE_URL}/api/MovilesVentas/sp_MovilesClientesFotosArrastre`,
      {
        method: "POST",
        headers: { accept: "application/json" },
        body,
      },
      FOTO_REQUEST_TIMEOUT_MS
    );
    const responseText = await response.text();
    console.log("[ClienteFotos] Respuesta de arrastre:", {
      id: foto.id,
      status: response.status,
      ok: response.ok,
      body: responseText.slice(0, 500),
    });
    if (!response.ok)
      throw new Error(`HTTP ${response.status}: ${responseText.slice(0, 250)}`);
    const result = responseText ? JSON.parse(responseText) : {};
    if (result.codigo !== 1 || !result.id) {
      throw new Error(
        result.mensaje1 || "El servidor no confirmó el registro de la fotografía."
      );
    }
    this.realm.write(() => {
      const local = this.realm!.objectForPrimaryKey<ClienteFoto>(
        "ClienteFoto",
        foto.id
      );
      if (local) {
        local.idServidor = result.id || null;
        local.fotoServidor = result.foto || null;
        local.fotoMiniaturaServidor = result.fotoMiniatura || null;
        local.estado = "sincronizada";
        local.syncedAt = new Date();
        local.errorMensaje = null;
      }
    });
  }

  private upsertRemoteRows(rows: any[]): number {
    if (!this.realm) return 0;
    let count = 0;
    this.realm.write(() => {
      for (const row of rows) {
        const idServidor = row.id == null ? null : Number(row.id);
        const idMovil =
          row.idMovil &&
          !/^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(String(row.idMovil))
            ? String(row.idMovil)
            : `server-${idServidor}`;
        const matches = Array.from(
          this.realm!
            .objects<ClienteFoto>("ClienteFoto")
            .filtered("idMovil == $0 OR idServidor == $1", idMovil, idServidor)
        );
        const existing = matches.find(
          (foto) => !ESTADOS_PENDIENTES.includes(foto.estado)
        ) || matches[0];
        if (existing && ESTADOS_PENDIENTES.includes(existing.estado)) continue;
        const activa = parseActiva(row.activa ?? row.Activa);
        const fechaLogRaw = row.fechaLog ?? row.fecha_log ?? row.FechaLog;
        const fechaLog = fechaLogRaw ? new Date(fechaLogRaw) : new Date();
        console.log("[ClienteFotos] Aplicando estado remoto:", {
          idServidor,
          idLocal: existing?.id,
          valorRecibido: row.activa ?? row.Activa,
          activa,
        });
        const data = {
          id: existing?.id || `remote-${idMovil}`,
          idServidor,
          idMovil,
          idCliente: Number(row.idCliente),
          foto: existing?.foto || row.__localFoto || null,
          fotoMiniatura: existing?.fotoMiniatura || row.__localMini || null,
          fotoServidor: row.foto || existing?.fotoServidor || null,
          fotoMiniaturaServidor:
            row.fotoMiniatura || existing?.fotoMiniaturaServidor || null,
          fotoBase64: row.fotoBase64 || null,
          fotoMiniaturaBase64: row.fotoMiniaturaBase64 || null,
          mimeType: row.fotoMimeType || "image/jpeg",
          miniaturaMimeType: row.fotoMiniaturaMimeType || "image/jpeg",
          nombreArchivo: null,
          etiqueta: row.etiqueta == null ? null : String(row.etiqueta),
          fechaCaptura: row.fechaCaptura ? new Date(row.fechaCaptura) : null,
          fechaLog: Number.isNaN(fechaLog.getTime()) ? new Date() : fechaLog,
          activa,
          estado: "sincronizada",
          errorMensaje: null,
          syncedAt: new Date(),
        };
        this.realm!.create("ClienteFoto", data, Realm.UpdateMode.Modified);
        for (const match of matches) {
          if (!ESTADOS_PENDIENTES.includes(match.estado)) {
            match.activa = activa;
            match.idServidor = idServidor;
          }
        }
        count++;
      }
    });
    return count;
  }

}

export default new ClienteFotosService();
