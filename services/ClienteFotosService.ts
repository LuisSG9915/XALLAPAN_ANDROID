import NetInfo from "@react-native-community/netinfo";
import RNFS from "react-native-fs";
import { launchCamera, launchImageLibrary } from "react-native-image-picker";
import type { PhotoQuality } from "react-native-image-picker";
import { PermissionsAndroid, Platform } from "react-native";
import Realm from "realm";
import { fetchWithTimeout } from "./fetchWithTimeout";
import FotoUploadSettingsService from "./FotoUploadSettingsService";

const API_BASE_URL = "https://api.cbinformatica.net:9031";
const MAX_FOTOS = 5;
const ESTADOS_PENDIENTES = ["pendiente", "error"];
const FOTO_REQUEST_TIMEOUT_MS = 20_000;
const FOTO_MAX_DIMENSION = 1280;
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

  setRealm(realm: Realm): void {
    this.realm = realm;
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
    if (!this.realm || this.realm.isClosed)
      return new Date("1900-01-01T00:00:00Z");
    const rows = Array.from(
      this.realm.objects<ClienteFoto>("ClienteFoto").sorted("fechaLog", true)
    );
    return rows[0]?.fechaLog || new Date("1900-01-01T00:00:00Z");
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

  async downloadFull(idCliente = 0, ruta = 0): Promise<number> {
    const response = await fetchWithTimeout(
      `${API_BASE_URL}/api/MovilesVentas/sp_MovilesClientesFotosFull?idCliente=${idCliente}&ruta=${ruta}`,
      { headers: { accept: "application/json" } },
      FOTO_REQUEST_TIMEOUT_MS
    );
    if (!response.ok)
      throw new Error(`HTTP ${response.status} al descargar fotos`);
    const rows = await response.json();
    return this.upsertRemoteRows(Array.isArray(rows) ? rows : []);
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
    return this.upsertRemoteRows(Array.isArray(rows) ? rows : []);
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
          foto: existing?.foto || null,
          fotoMiniatura: existing?.fotoMiniatura || null,
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
          fechaLog: row.fechaLog ? new Date(row.fechaLog) : new Date(),
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
