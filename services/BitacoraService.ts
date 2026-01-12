
import Realm from "realm";
import NetInfo from "@react-native-community/netinfo";
import DeviceInfo from "react-native-device-info";
import { Platform, AppState } from "react-native";
import { ALL_SCHEMAS } from "./RealmSchemas";
import AuthService from "./AuthService";

// Definición de tipos para los resultados de sync
export interface SyncResult {
  exitoso: boolean;
  registrosLeidos?: number;
  registrosGuardados?: number;
  registrosActualizados?: number;
  registrosEliminados?: number;
  error?: string;
  errorCode?: string;
  stackTrace?: string;
}

class BitacoraService {
  private realm: Realm | null = null;
  private apiBaseUrl = "https://cbinfo.no-ip.info:9031";

  /**
   * Inicializa la conexión a Realm si no existe
   */
  async initialize(): Promise<void> {
    if (this.realm && !this.realm.isClosed) return;

    try {
        // Usamos la misma configuración que FullSyncService para compartir la instancia/cache
      this.realm = await Realm.open({
        path: "FullSyncDB",
        schema: ALL_SCHEMAS,
        schemaVersion: 15, // Incrementado para nuevos campos de bitácora
        // No manejamos migración aquí, asumimos que FullSyncService o App la maneja
      });
    } catch (error) {
      console.error("[BitacoraService] Error al inicializar Realm:", error);
    }
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
    await this.initialize();
    if (!this.realm) return ""; // Fallback seguro

    // Generar un ID descriptivo como el ejemplo solicitado: TimeStamp-Random-Tabla
    const randomStr = Math.random().toString(36).substring(2, 9);
    const suffix = tipoSync === "incremental" ? "Incremental" : "Full";
    const idBitacoraMovil = `${Date.now()}-${randomStr}-${tabla}${suffix}`;
    
    // Capturar contexto
    const netInfo = await NetInfo.fetch();
    const ipAddress = await DeviceInfo.getIpAddress().catch(() => "0.0.0.0");
    const appVersion = DeviceInfo.getVersion();
    const systemName = DeviceInfo.getSystemName();
    const systemVersion = DeviceInfo.getSystemVersion();
    const deviceName = await DeviceInfo.getDeviceName();
    
    // Usuario
    const user = await AuthService.restoreSession();
    const nombreUsuario = user ? (user.nombre || user.nombreCompleto || user.usuario || null) : null;

    const fechaInicio = new Date();

    const details = netInfo.details as any;
    const intensidadSenal = details?.strength ?? (details?.signalStrength ?? null);
    const velocidadDescarga = details?.linkSpeed ?? (details?.downlink ?? null);
    const esMetered = details?.isConnectionMetered ?? false;

    // Medición de latencia deshabilitada temporalmente para optimizar velocidad en background
    let latenciaMs = null;

    try {
      this.realm.write(() => {
        this.realm!.create("BitacoraSync", {
          idBitacoraMovil,
          tabla: `${tabla}${suffix}`,
          tipoSync,
          fechaInicio,
          
          // Contexto Dispositivo
          ipDispositivo: ipAddress,
          nombreDispositivo: deviceName,
          sistemaOperativo: `${systemName} ${Platform.Version || systemVersion}`.toLowerCase(),
          versionApp: appVersion,

          // Contexto Red
          tipoConexion: netInfo.type,
          tipoConexionDetallado: details?.cellularGeneration || netInfo.type,
          estadoConexion: netInfo.isConnected ? 1 : 0,
          intensidadSenal: intensidadSenal, 
          velocidadDescargaMbps: velocidadDescarga, 
          velocidadCargaMbps: null, 
          latenciaMs: latenciaMs,
          esConexionMetered: esMetered,
          endpoint: endpoint || null, 
          
          // Contexto App
          appState: AppState.currentState,
          origenSync,
          detallesJSON: JSON.stringify({
            endpoint: endpoint || null,
            platform: Platform.OS,
            isWifiEnabled: (netInfo as any).isWifiEnabled,
            details: details
          }),
          
          // Usuario
          idUsuario: idUsuario || user?.id || user?.idUsuario || 0,
          nombreUsuario: nombreUsuario,
          sucursal: sucursal || user?.sucursal || user?.sucursal_origen || 0,

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
    await this.initialize();
    if (!this.realm) return;

    try {
      this.realm.write(() => {
        const registro: any = this.realm!.objectForPrimaryKey("BitacoraSync", idBitacoraMovil);
        if (registro) {
          const ahora = new Date();
          registro.fechaFinal = ahora;
          registro.duracionMs = ahora.getTime() - registro.fechaInicio.getTime();
          registro.exitoso = result.exitoso;
          registro.registrosLeidos = result.registrosLeidos || 0;
          registro.registrosGuardados = result.registrosGuardados || 0;
          registro.registrosActualizados = result.registrosActualizados || 0;
          registro.registrosEliminados = result.registrosEliminados || 0;
          
          if (!result.exitoso) {
            registro.error = result.error || "Error desconocido";
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
    await this.initialize();
    if (!this.realm) return;

    await this.limpiarBitacorasAntiguas();

    const tresDiasAtras = new Date();
    tresDiasAtras.setDate(tresDiasAtras.getDate() - 3);

    // Obtener los pendientes ANTES de registrar el inicio de este arrastre
    // para que este registro de bitácora se envíe en la siguiente vuelta.
    const pendientes = this.realm.objects("BitacoraSync")
      .filtered("enviado == false AND fechaInicio > $0", tresDiasAtras);

    if (pendientes.length === 0) return;

    // --- Inicio Bitácora del Arrastre de Logs ---
    const url = `${this.apiBaseUrl}/api/MovilesVentas/sp_BitacoraSyncArrastreJSON?sucursal=${sucursal}&idUsuario=${idUsuario}`;
    const idBitacoraArrastre = await this.registrarInicioSync(
      "LogsArrastre", "incremental", "background", idUsuario, sucursal, url
    );

    console.log(`[BitacoraService] Enviando ${pendientes.length} registros de bitácora...`);

    const payload = pendientes.map((p: any) => ({
      idBitacoraMovil: p.idBitacoraMovil,
      tabla: p.tabla,
      tipoSync: p.tipoSync,
      fechaInicio: this.formatDate(p.fechaInicio),
      fechaFinal: p.fechaFinal ? this.formatDate(p.fechaFinal) : this.formatDate(new Date()),
      duracionMs: p.duracionMs || 0,
      
      idUsuario: p.idUsuario,
      nombreUsuario: p.nombreUsuario,
      ipDispositivo: p.ipDispositivo || "0.0.0.0",
      nombreDispositivo: p.nombreDispositivo || "unknown",
      sistemaOperativo: p.sistemaOperativo || "unknown",
      versionApp: p.versionApp || "1.0.0",
      sucursal: p.sucursal || sucursal,

      endpoint: p.endpoint || null,
      registrosLeidos: p.registrosLeidos || 0,
      registrosGuardados: p.registrosGuardados || 0,
      registrosActualizados: p.registrosActualizados || 0,
      registrosEliminados: p.registrosEliminados || 0,
      
      exitoso: p.exitoso || false,
      codigoError: p.codigoError || null,
      descripcionError: p.descripcionError || null,
      stackTrace: p.stackTrace || null,
      detallesJSON: p.detallesJSON || null,
      fechaArrastre: this.formatDate(new Date()),

      tipoConexion: p.tipoConexion || "unknown",
      tipoConexionDetallado: p.tipoConexionDetallado || null,
      estadoConexion: p.estadoConexion ?? 1,
      intensidadSenal: p.intensidadSenal || 0,
      velocidadDescargaMbps: p.velocidadDescargaMbps || 0,
      velocidadCargaMbps: p.velocidadCargaMbps || 0,
      latenciaMs: p.latenciaMs || 0,
      esConexionMetered: p.esConexionMetered ? 1 : 0
    }));

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        console.log("[BitacoraService] ✅ Bitácoras enviadas correctamente.");
        
        // Registrar fin exitoso
        await this.registrarFinSync(idBitacoraArrastre, {
          exitoso: true,
          registrosLeidos: payload.length,
          registrosActualizados: payload.length
        });

        this.realm.write(() => {
           this.realm!.delete(pendientes);
        });
      } else {
        const errorText = await response.text().catch(() => "N/A");
        console.warn(`[BitacoraService] ❌ Error servidor ${response.status} al enviar bitácoras`);
        
        await this.registrarFinSync(idBitacoraArrastre, {
          exitoso: false,
          error: `HTTP ${response.status}: ${errorText}`,
          errorCode: String(response.status)
        });
      }
    } catch (error: any) {
       console.error("[BitacoraService] Error de red al enviar bitácoras:", error);
       
       await this.registrarFinSync(idBitacoraArrastre, {
         exitoso: false,
         error: error instanceof Error ? error.message : "Error de red",
         stackTrace: JSON.stringify(error)
       });
    }
  }

  async limpiarBitacorasAntiguas(): Promise<void> {
    if (!this.realm) return;
    
    const sieteDiasAtras = new Date();
    sieteDiasAtras.setDate(sieteDiasAtras.getDate() - 7);

    try {
      const antiguos = this.realm.objects("BitacoraSync").filtered("fechaInicio < $0", sieteDiasAtras);
      if (antiguos.length > 0) {
        this.realm.write(() => {
          this.realm!.delete(antiguos);
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
