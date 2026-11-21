import Realm from "realm";
import AuthService from "./AuthService";
import DeviceInfo from "react-native-device-info";
import { fetchWithTimeout } from "./fetchWithTimeout";
import { obtenerIdentidadMovil } from "./IdentidadMovil";

// Definición de tipos para los resultados de sync
export interface SyncResult {
  exitoso: boolean;
  registrosLeidos?: number;
  error?: string;
  errorCode?: string;
  stackTrace?: string;
}

class BitacoraService {
  private realm: Realm | null = null;
  private apiBaseUrl = "https://api.cbinformatica.net:9031";

  /**
   * Inyecta la instancia de Realm desde FullSyncService
   * Evita abrir múltiples instancias del mismo Realm
   */
  setRealm(realm: Realm): void {
    this.realm = realm;
    console.log("[BitacoraService] Realm inyectado correctamente");
  }

  private getRealm(): Realm {
    if (!this.realm || this.realm.isClosed) {
      throw new Error("[BitacoraService] Realm no inicializado. Debe llamarse FullSyncService.initialize() primero");
    }
    return this.realm;
  }

  /**
   * Registra el INICIO de una sincronización de tabla.
   * Captura contexto del dispositivo y red.
   */
  async registrarInicioSync(
    tabla: string,
    tipoSync: "incremental" | "full",
    origenSync: "manual" | "background",
    idUsuario?: number,
    sucursal?: number,
    endpoint?: string
  ): Promise<string> {
    const realm = this.getRealm();

    // Generar un ID descriptivo: TimeStamp-Random-Tabla
    const randomStr = Math.random().toString(36).substring(2, 9);
    const suffix = tipoSync === "incremental" ? "Incremental" : "Full";
    const idBitacoraMovil = `${Date.now()}-${randomStr}-${tabla}${suffix}`;
    const fechaInicio = new Date();
    const appVersion = DeviceInfo.getVersion();
    const user = await AuthService.restoreSession();

    try {
      realm.write(() => {
        realm.create("BitacoraSync", {
          idBitacoraMovil,
          tabla: `${tabla}${suffix}`,
          fechaInicio,
          versionApp: appVersion,
          endpoint: endpoint || null,
          idUsuario: idUsuario || user?.id || user?.idUsuario || 0,

          // Valores por defecto
          enviado: false,
          exitoso: false
        });
      });
    } catch (error) {
      console.warn("[BitacoraService] No se pudo crear registro de inicio:", error);
    }

    return idBitacoraMovil;
  }

  /**
   * Registra el FINAL de una sincronización, actualizando el registro existente.
   */
  async registrarFinSync(idBitacoraMovil: string, result: SyncResult): Promise<void> {
    if (!idBitacoraMovil) return;
    const realm = this.getRealm();

    try {
      realm.write(() => {
        const registro: any = realm.objectForPrimaryKey("BitacoraSync", idBitacoraMovil);
        if (registro) {
          const ahora = new Date();
          registro.duracionMs = ahora.getTime() - registro.fechaInicio.getTime();
          registro.exitoso = result.exitoso;
          registro.registrosLeidos = result.registrosLeidos || 0;

          if (!result.exitoso) {
            registro.codigoError = result.errorCode || "500";
            registro.descripcionError = result.error || "Error desconocido";
            registro.stackTrace = result.stackTrace;
          }
        }
      });
    } catch (error) {
      console.warn("[BitacoraService] Error al actualizar fin sync:", error);
    }
  }

  async enviarBitacorasPendientes(sucursal: number, idUsuario: number): Promise<void> {
    const realm = this.getRealm();

    await this.limpiarBitacorasAntiguas();

    // Limpiar registros zombies de código anterior (tablas obsoletas)
    try {
      const zombies = realm.objects("BitacoraSync").filtered(
        'tabla == "LogsArrastreIncremental" OR tabla == "SyncIncrementalIncremental"'
      );
      if (zombies.length > 0) {
        console.log(`[BitacoraService] Eliminando ${zombies.length} registros zombies de código anterior`);
        realm.write(() => {
          realm.delete(zombies);
        });
      }
    } catch (e) {
      console.warn("[BitacoraService] Error limpiando zombies:", e);
    }

    const tresDiasAtras = new Date();
    tresDiasAtras.setDate(tresDiasAtras.getDate() - 3);

    // Obtener los pendientes ANTES de registrar el inicio de este arrastre
    // para que este registro de bitácora se envíe en la siguiente vuelta.
    const pendientes = realm.objects("BitacoraSync")
      .filtered("enviado == false AND fechaInicio > $0", tresDiasAtras);

    if (pendientes.length === 0) return;

    const url = `${this.apiBaseUrl}/api/MovilesVentas/sp_BitacoraSyncOptimizadoArrastreJSON?sucursal=${sucursal}&idUsuario=${idUsuario}`;
    console.log(`[BitacoraService] Enviando ${pendientes.length} registros de bitácora...`);
    console.log(`[BitacoraService] URL:`, url);

    // Metadatos del dispositivo que realiza el arrastre: una sola lectura por
    // envío. Nunca debe abortar el arrastre (obtenerIdentidadMovil no lanza).
    const identidadMovil = await obtenerIdentidadMovil();

    const payload = pendientes.map((p: any) => ({
      idBitacoraMovil: p.idBitacoraMovil,
      tabla: p.tabla,
      fechaInicio: this.formatDate(p.fechaInicio),
      duracionMs: p.duracionMs || 0,
      idUsuario: p.idUsuario,
      versionApp: p.versionApp || "1.0.0",
      endpoint: p.endpoint || null,
      registrosLeidos: p.registrosLeidos || 0,
      exitoso: p.exitoso || false,
      codigoError: p.codigoError || null,
      descripcionError: p.descripcionError || null,
      stackTrace: p.stackTrace || null,
      fechaArrastre: this.formatDate(new Date()),
      ...identidadMovil,
    }));

    // console.log(`[BitacoraService] 📤 Primer registro del payload:`, payload[0]);
    // console.log(`[BitacoraService] 📊 Total registros en payload:`, payload.length);
    // console.log(`[BitacoraService] 📤 Payload completo:`, JSON.stringify(payload));
    try {
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify(payload)
      });

      console.log(`[BitacoraService] 📡 Respuesta del servidor:`, {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok
      });

      if (response.ok) {
        const responseText = await response.text();
        console.log("[BitacoraService] ✅ Bitácoras enviadas correctamente. Respuesta:", responseText);

        realm.write(() => {
           realm.delete(pendientes);
        });
      } else {
        const errorText = await response.text().catch(() => "");
        console.error("[BitacoraService] Error al enviar bitácoras:", response.status, errorText);
      }
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : "Error desconocido";
      console.error("[BitacoraService] Error crítico enviando bitácoras:", errorMsg);
    }
  }

  async limpiarBitacorasAntiguas(): Promise<void> {
    try {
      const realm = this.getRealm();
      const sieteDiasAtras = new Date();
      sieteDiasAtras.setDate(sieteDiasAtras.getDate() - 7);

      const antiguos = realm.objects("BitacoraSync").filtered("fechaInicio < $0", sieteDiasAtras);
      if (antiguos.length > 0) {
        realm.write(() => {
          realm.delete(antiguos);
        });
      }
    } catch (e) {
      console.warn("Error en limpieza bitácoras:", e);
    }
  }

  private formatDate(date: Date): string {
    if (!date) return new Date().toISOString();

    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const min = String(date.getMinutes()).padStart(2, "0");
    const ss = String(date.getSeconds()).padStart(2, "0");

    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
  }
}

export default new BitacoraService();
