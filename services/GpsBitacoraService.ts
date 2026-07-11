import { Platform } from "react-native";
import Realm from "realm";
import AuthService from "./AuthService";
import { fetchWithTimeout } from "./fetchWithTimeout";

export type DatosValidacionUbicacion = {
  idCliente: number | null;
  motivo: string;
  valido: boolean;
  distancia: number | null;
  accuracy: number | null;
  metrosPermitidos: number | null;
  latitud: number | null;
  longitud: number | null;
  clienteLatitud: number | null;
  clienteLongitud: number | null;
  numFixes: number | null;
  peorAccuracy: number | null;
  tiempoMs: number | null;
  conCobertura?: boolean | null;
};

function coerceNumber(value: any): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

function coerceBool(value: any): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true" || value === "True" || value === "TRUE") return true;
  if (value === 0 || value === "0" || value === "false" || value === "False" || value === "FALSE") return false;
  return null;
}

function coerceString(value: any): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

class GpsBitacoraService {
  private realm: Realm | null = null;
  private apiBaseUrl = "https://api.cbinformatica.net:9031";

  /**
   * Inyecta la instancia de Realm compartida desde FullSyncService
   */
  setRealm(realm: Realm): void {
    this.realm = realm;
    console.log("[GpsBitacoraService] Realm inyectado correctamente");
  }

  private getRealm(): Realm {
    if (!this.realm || this.realm.isClosed) {
      throw new Error("[GpsBitacoraService] Realm no inicializado.");
    }
    return this.realm;
  }

  /**
   * Registra una ubicación GPS en la bitácora local (Realm).
   * Se llama automáticamente desde LocationService.getCurrentLocation()
   */
  async registrarUbicacion(latitud: number, longitud: number, precision?: number, conCobertura?: boolean): Promise<void> {
    try {
      if (!this.realm || this.realm.isClosed) {
        console.warn("[GpsBitacoraService] Realm no inicializado. Se omitirá registro GPS.");
        return;
      }

      const realm = this.getRealm();
      const user = await AuthService.restoreSession();

      if (!user) {
        console.warn("[GpsBitacoraService] Usuario no logueado, omitiendo registro GPS");
        return;
      }

      const idUsuario = user.id || user.idUsuario || 0;
      const sucursal = user.sucursal || user.sucursal_origen || 0;

      // Obtener metros de validación del usuario desde Realm
      let metros: number | null = null;
      try {
        const realmUser = realm.objectForPrimaryKey("Usuario", idUsuario) as any;
        metros = realmUser?.metros ?? null;
      } catch (e) {
        metros = null;
      }

      const id = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      realm.write(() => {
        realm.create("BitacoraGps", {
          id,
          idUsuario,
          sucursal,
          latitud,
          longitud,
          precision: precision ?? null,
          bateria: metros ?? null, // Campo reutilizado: ahora almacena metros de validación
          conCobertura: conCobertura ?? null,
          id_movil: null,
          fecha: new Date(),
          enviado: false,
        });
      });

      console.log(
        `[GpsBitacoraService] 📍 GPS registrado: lat=${latitud}, lng=${longitud}, precision=${precision}, metros=${metros}, conCobertura=${conCobertura}`,
      );
    } catch (error) {
      console.warn("[GpsBitacoraService] Error al registrar ubicación GPS:", error);
    }
  }

  /**
   * Registra el diagnóstico de una validación de ubicación en la bitácora local (Realm).
   * Se llama desde LocationService.validarUbicacionConAlerta tras cada intento.
   */
  async registrarValidacion(datos: DatosValidacionUbicacion): Promise<void> {
    try {
      if (!this.realm || this.realm.isClosed) {
        console.warn("[GpsBitacoraService] Realm no inicializado. Se omitirá registro de validación.");
        return;
      }

      const realm = this.getRealm();
      const user = await AuthService.restoreSession();
      if (!user) {
        console.warn("[GpsBitacoraService] Usuario no logueado, omitiendo registro de validación");
        return;
      }

      const idUsuario = user.id || user.idUsuario || 0;
      const sucursal = user.sucursal || user.sucursal_origen || 0;
      const id = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      realm.write(() => {
        realm.create("BitacoraValidacion", {
          id,
          idUsuario,
          sucursal,
          idCliente: datos.idCliente ?? null,
          motivo: datos.motivo,
          valido: datos.valido,
          distancia: datos.distancia ?? null,
          accuracy: datos.accuracy ?? null,
          metrosPermitidos: datos.metrosPermitidos ?? null,
          latitud: datos.latitud ?? null,
          longitud: datos.longitud ?? null,
          clienteLatitud: datos.clienteLatitud ?? null,
          clienteLongitud: datos.clienteLongitud ?? null,
          numFixes: datos.numFixes ?? null,
          peorAccuracy: datos.peorAccuracy ?? null,
          tiempoMs: datos.tiempoMs ?? null,
          conCobertura: datos.conCobertura ?? null,
          id_movil: null,
          plataforma: Platform.OS,
          versionApp: null,
          fecha: new Date(),
          enviado: false,
        });
      });

      console.log(
        `[GpsBitacoraService] 📋 Validación registrada: motivo=${datos.motivo}, valido=${datos.valido}, ` +
          `distancia=${datos.distancia}, accuracy=${datos.accuracy}, fixes=${datos.numFixes}`,
      );
    } catch (error) {
      console.warn("[GpsBitacoraService] Error al registrar validación:", error);
    }
  }

  /**
   * Envía los registros GPS pendientes al servidor.
   * Llamado desde syncIncremental() y syncAll() en FullSyncService,
   * y al final de cada ciclo en BackgroundSyncService.
   */
  async enviarBitacorasPendientes(sucursal: number, idUsuario: number): Promise<void> {
    if (!this.realm || this.realm.isClosed) return;

    const realm = this.getRealm();

    const todosPendientes = realm.objects("BitacoraGps").filtered("enviado == false");
    if (todosPendientes.length === 0) return;

    const BATCH_SIZE = 100;
    const total = todosPendientes.length;
    console.log(`[GpsBitacoraService] Enviando ${total} registros GPS al servidor en lotes de ${BATCH_SIZE}...`);

    const url = `${this.apiBaseUrl}/api/MovilesVentas/sp_MovilesBitacoraGpsArrastreJSON?sucursal=${sucursal}&idUsuario=${idUsuario}`;

    for (let offset = 0; offset < total; offset += BATCH_SIZE) {
      const batch = todosPendientes.slice(offset, offset + BATCH_SIZE);
      const payload = batch.map((p: any) => ({
        idUsuario: coerceNumber(p.idUsuario) ?? 0,
        sucursal: coerceNumber(p.sucursal) ?? 0,
        latitud: coerceNumber(p.latitud) ?? 0,
        longitud: coerceNumber(p.longitud) ?? 0,
        precision: coerceNumber(p.precision),
        bateria: coerceNumber(p.bateria),
        conCobertura: coerceBool(p.conCobertura),
        id_movil: coerceNumber(p.id_movil),
        fecha: this.formatDate(p.fecha),
      }));

      await this.enviarLote(url, batch, payload);
    }
  }

  /**
   * Envía los registros de validación de ubicación pendientes al servidor.
   * Llamado desde syncIncremental() y syncAll() en FullSyncService,
   * y al final de cada ciclo en BackgroundSyncService.
   */
  async enviarValidacionesPendientes(sucursal: number, idUsuario: number): Promise<void> {
    if (!this.realm || this.realm.isClosed) return;

    const realm = this.getRealm();

    const todosPendientes = realm.objects("BitacoraValidacion").filtered("enviado == false");
    if (todosPendientes.length === 0) return;

    const BATCH_SIZE = 100;
    const total = todosPendientes.length;
    console.log(`[GpsBitacoraService] Enviando ${total} validaciones de ubicación al servidor en lotes de ${BATCH_SIZE}...`);

    const url = `${this.apiBaseUrl}/api/MovilesVentas/sp_MovilesBitacoraValidacionArrastreJSON?sucursal=${sucursal}&idUsuario=${idUsuario}`;

    for (let offset = 0; offset < total; offset += BATCH_SIZE) {
      const batch = todosPendientes.slice(offset, offset + BATCH_SIZE);
      const payload = batch.map((p: any) => ({
        idUsuario: coerceNumber(p.idUsuario) ?? 0,
        sucursal: coerceNumber(p.sucursal) ?? 0,
        idCliente: coerceNumber(p.idCliente),
        motivo: coerceString(p.motivo) ?? "ok",
        valido: coerceBool(p.valido) ?? false,
        distancia: coerceNumber(p.distancia),
        accuracy: coerceNumber(p.accuracy),
        metrosPermitidos: coerceNumber(p.metrosPermitidos),
        latitud: coerceNumber(p.latitud),
        longitud: coerceNumber(p.longitud),
        clienteLatitud: coerceNumber(p.clienteLatitud),
        clienteLongitud: coerceNumber(p.clienteLongitud),
        numFixes: coerceNumber(p.numFixes),
        peorAccuracy: coerceNumber(p.peorAccuracy),
        tiempoMs: coerceNumber(p.tiempoMs),
        conCobertura: coerceBool(p.conCobertura),
        id_movil: coerceNumber(p.id_movil),
        plataforma: coerceString(p.plataforma),
        versionApp: coerceString(p.versionApp),
        fecha: this.formatDate(p.fecha),
      }));

      await this.enviarLote(url, batch, payload);
    }
  }

  private async enviarLote(url: string, batch: any, payload: any[]): Promise<void> {
    const realm = this.getRealm();
    console.log(`[GpsBitacoraService] Enviando lote de ${payload.length} registros...`);

    try {
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        console.log(`[GpsBitacoraService] ✅ Lote de ${payload.length} bitácoras enviado correctamente.`);
        realm.write(() => {
          for (const item of batch) {
            item.enviado = true;
          }
        });
      } else {
        const txt = await response.text().catch(() => "");
        console.error("[GpsBitacoraService] ❌ Error al enviar lote:", response.status, txt);
        console.error("[GpsBitacoraService] ❌ Payload:", JSON.stringify(payload, null, 2));
      }
    } catch (error) {
      console.error("[GpsBitacoraService] ❌ Error crítico enviando lote:", error);
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
    return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}`;
  }
}

export default new GpsBitacoraService();
