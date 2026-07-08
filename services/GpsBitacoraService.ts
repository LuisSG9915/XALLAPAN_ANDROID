import Realm from "realm";
import AuthService from "./AuthService";
import { fetchWithTimeout } from "./fetchWithTimeout";

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
        idUsuario: p.idUsuario,
        sucursal: p.sucursal,
        latitud: p.latitud,
        longitud: p.longitud,
        precision: p.precision ?? null,
        bateria: p.bateria ?? null,
        conCobertura: p.conCobertura ?? null,
        id_movil: p.id_movil ?? null,
        fecha: this.formatDate(p.fecha),
      }));

      await this.enviarLote(url, batch, payload);
    }
  }

  private async enviarLote(url: string, batch: any, payload: any[]): Promise<void> {
    const realm = this.getRealm();
    console.log(`[GpsBitacoraService] Enviando lote de ${payload.length} registros GPS...`);

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
        console.log(`[GpsBitacoraService] ✅ Lote de ${payload.length} bitácoras GPS enviado correctamente.`);
        realm.write(() => {
          for (const item of batch) {
            item.enviado = true;
          }
        });
      } else {
        const txt = await response.text().catch(() => "");
        console.error("[GpsBitacoraService] ❌ Error al enviar lote GPS:", response.status, txt);
      }
    } catch (error) {
      console.error("[GpsBitacoraService] ❌ Error crítico enviando lote GPS:", error);
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

export default new GpsBitacoraService();
