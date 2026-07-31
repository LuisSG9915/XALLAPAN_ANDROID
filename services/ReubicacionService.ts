import Realm from "realm";
import { fetchWithTimeout } from "./fetchWithTimeout";
import { calcularDistancia, TTL_VALIDACION_CACHE_MS } from "./LocationService";

/**
 * Genera un ID único numérico basado en timestamp
 * Formato: timestamp en milisegundos (ej: 1700000000123)
 */
function generateUniqueId(): number {
  return Date.now();
}

/**
 * Servicio para gestionar reubicaciones de clientes
 * - Permite reubicar un cliente una sola vez
 * - Guarda reubicaciones en Realm local
 * - Sincroniza reubicaciones al servidor
 */
class ReubicacionService {
  private static instance: ReubicacionService;
  private realm: Realm | null = null;
  private apiBaseUrl = "https://api.cbinformatica.net:9031";
  // Lock contra envíos concurrentes: syncIncremental (cada 3 min) y syncAll pueden
  // solaparse. Sin este lock ambas ejecuciones leerían los mismos pendientes y
  // el servidor recibiría cada reubicación duplicada.
  private enviandoReubicaciones: Promise<{ success: boolean; sent: number; error?: string }> | null = null;

  getApiBaseUrl(): string {
    return this.apiBaseUrl;
  }

  private constructor() {}

  static getInstance(): ReubicacionService {
    if (!ReubicacionService.instance) {
      ReubicacionService.instance = new ReubicacionService();
    }
    return ReubicacionService.instance;
  }

  setRealm(realm: Realm) {
    this.realm = realm;
  }

  /**
   * Verifica si el usuario tiene permiso de reubicación (bit reubicacion === true)
   * @param idUsuario ID del usuario
   * @returns true si tiene permiso, false si no
   */
  usuarioTienePermisoReubicacion(idUsuario: number): boolean {
    if (!this.realm || this.realm.isClosed) {
      console.warn("[ReubicacionService] Realm no inicializado");
      return false;
    }
    try {
      console.log(idUsuario);
      const usuario = this.realm.objectForPrimaryKey("Usuario", idUsuario);
      if (!usuario) return false;
      console.log(usuario);
      console.log((usuario as any).reubicacion);
      return (usuario as any).reubicacion === true;
    } catch (error) {
      console.error("[ReubicacionService] Error verificando permiso de reubicación:", error);
      return false;
    }
  }

  /**
   * Marca el bit reubicacion del usuario en false (ya usó su permiso)
   * @param idUsuario ID del usuario
   */
  private marcarPermisoReubicacionUsado(idUsuario: number): void {
    if (!this.realm || this.realm.isClosed) return;
    try {
      const usuario = this.realm.objectForPrimaryKey("Usuario", idUsuario);
      if (usuario) {
        this.realm.write(() => {
          (usuario as any).reubicacion = false;
        });
        console.log(`[ReubicacionService] Bit reubicacion marcado false para usuario ${idUsuario}`);
      }
    } catch (error) {
      console.error("[ReubicacionService] Error marcando permiso reubicacion usado:", error);
    }
  }

  /**
   * Verifica si un cliente ya fue reubicado
   * @param idCliente ID del cliente
   * @returns true si ya fue reubicado, false si aún no
   */
  clienteYaReubicado(idCliente: number): boolean {
    if (!this.realm || this.realm.isClosed) {
      console.warn("[ReubicacionService] Realm no inicializado");
      return false;
    }

    try {
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

      const reubicaciones = this.realm
        .objects("Reubicacion")
        .filtered("idCliente == $0 AND fecha >= $1 AND fecha <= $2", idCliente, startOfDay, endOfDay);

      return reubicaciones.length > 0;
    } catch (error) {
      console.error("[ReubicacionService] Error verificando reubicación:", error);
      return false;
    }
  }

  /**
   * Verifica si un cliente fue reubicado recientemente dentro de la ventana
   * de validez de la validación GPS (3 min). Usado como bypass temporal tras
   * reubicar: el vendedor acaba de fijar el punto y está físicamente ahí.
   * @param idCliente ID del cliente
   * @returns true si fue reubicado dentro de la ventana TTL
   */
  clienteReubicadoRecientemente(idCliente: number): boolean {
    if (!this.realm || this.realm.isClosed) {
      console.warn("[ReubicacionService] Realm no inicializado");
      return false;
    }

    try {
      const desde = new Date(Date.now() - TTL_VALIDACION_CACHE_MS);
      const reubicaciones = this.realm
        .objects("Reubicacion")
        .filtered("idCliente == $0 AND fecha >= $1", idCliente, desde);

      return reubicaciones.length > 0;
    } catch (error) {
      console.error("[ReubicacionService] Error verificando reubicación reciente:", error);
      return false;
    }
  }

  /**
   * Registra una reubicación de cliente en Realm local
   * @param idCliente ID del cliente
   * @param latitud Nueva latitud del cliente
   * @param longitud Nueva longitud del cliente
   * @param idUsuario ID del usuario que reubica
   * @returns ID de la reubicación creada o null si falla
   */
  async registrarReubicacion(
    idCliente: number,
    latitud: number,
    longitud: number,
    idUsuario: number,
    sucursal?: number,
    gpsDiagnostico?: {
      latitudAnterior?: number;
      longitudAnterior?: number;
      accuracy?: number;
      numFixes?: number;
    },
  ): Promise<number | null> {
    console.log("[ReubicacionService] 📍 Iniciando registro de reubicación...");
    console.log(`[ReubicacionService] Parámetros:`, {
      idCliente,
      latitud,
      longitud,
      idUsuario,
    });

    if (!this.realm || this.realm.isClosed) {
      console.error("[ReubicacionService] ❌ Realm no inicializado");
      return null;
    }

    // Verificar si ya existe una reubicación para este cliente
    const yaReubicado = this.clienteYaReubicado(idCliente);
    console.log(`[ReubicacionService] Cliente ${idCliente} ya reubicado: ${yaReubicado}`);

    if (yaReubicado) {
      console.warn(`[ReubicacionService] ⚠️ El cliente ${idCliente} ya fue reubicado anteriormente`);
      return null;
    }

    const id = generateUniqueId();
    const fecha = new Date();
    const syncedAt = new Date();

    console.log(`[ReubicacionService] Datos generados:`, {
      id,
      idCliente,
      latitud,
      longitud,
      fecha: fecha.toISOString(),
      idUsuario,
      syncedAt: syncedAt.toISOString(),
      enviado: false,
    });

    let latAnterior = gpsDiagnostico?.latitudAnterior ?? null;
    let lngAnterior = gpsDiagnostico?.longitudAnterior ?? null;

    if (latAnterior == null || lngAnterior == null) {
      const clienteActual = this.realm.objectForPrimaryKey("ClienteFull", idCliente) as any;
      if (clienteActual?.latitud && clienteActual?.longitud) {
        latAnterior = clienteActual.latitud;
        lngAnterior = clienteActual.longitud;
        console.log(`[ReubicacionService] Coordenadas anteriores rescatadas desde Realm: ${latAnterior}, ${lngAnterior}`);
      }
    }

    const metrosMovidos = latAnterior != null && lngAnterior != null
      ? calcularDistancia(latAnterior, lngAnterior, latitud, longitud)
      : null;

    try {
      this.realm.write(() => {
        this.realm!.create("Reubicacion", {
          id,
          idCliente,
          sucursal: sucursal ?? null,
          latitud,
          longitud,
          latitudAnterior: latAnterior,
          longitudAnterior: lngAnterior,
          accuracy: gpsDiagnostico?.accuracy ?? null,
          numFixes: gpsDiagnostico?.numFixes ?? null,
          metrosMovidos,
          fecha,
          idUsuario,
          syncedAt,
          enviado: false,
        });
      });

      console.log(`[ReubicacionService] ✅ Reubicación registrada exitosamente`);
      console.log(`[ReubicacionService] ID: ${id}, Cliente: ${idCliente}, Enviado: false`);

      // Verificar que se guardó correctamente
      const verificacion = this.realm.objectForPrimaryKey("Reubicacion", id);
      if (verificacion) {
        console.log(`[ReubicacionService] ✓ Verificación: Reubicación existe en BD`, {
          id: (verificacion as any).id,
          enviado: (verificacion as any).enviado,
          idCliente: (verificacion as any).idCliente,
        });
      } else {
        console.error(`[ReubicacionService] ❌ Verificación: No se encontró la reubicación en BD`);
      }

      // Actualizar coordenadas del cliente en ClienteFull
      this.actualizarCoordenadasClienteLocal(idCliente, latitud, longitud);

      return id;
    } catch (error) {
      console.error("[ReubicacionService] ❌ Error registrando reubicación:", error);
      console.error("[ReubicacionService] ❌ Stack:", error instanceof Error ? error.stack : "N/A");
      return null;
    }
  }

  /**
   * Actualiza las coordenadas del cliente en la tabla ClienteFull local
   */
  private actualizarCoordenadasClienteLocal(idCliente: number, latitud: number, longitud: number): void {
    if (!this.realm || this.realm.isClosed) return;

    try {
      const cliente = this.realm.objectForPrimaryKey("ClienteFull", idCliente);
      console.log(`[ReubicacionService] 🔍 Buscando cliente ${idCliente} en ClienteFull...`);

      if (cliente) {
        const coordsAntes = { lat: (cliente as any).latitud, lng: (cliente as any).longitud };
        console.log(`[ReubicacionService] 📍 Coordenadas ANTES:`, coordsAntes);
        
        this.realm.write(() => {
          (cliente as any).latitud = latitud;
          (cliente as any).longitud = longitud;
        });

        // Verificar inmediatamente después del write
        const coordsDespues = { lat: (cliente as any).latitud, lng: (cliente as any).longitud };
        console.log(`[ReubicacionService] 📍 Coordenadas DESPUÉS:`, coordsDespues);
        console.log(`[ReubicacionService] ✅ Coordenadas actualizadas localmente para cliente ${idCliente}`);
      } else {
        console.warn(`[ReubicacionService] ⚠️ Cliente ${idCliente} no encontrado en ClienteFull`);
      }
    } catch (error) {
      console.error("[ReubicacionService] ❌ Error actualizando coordenadas locales:", error);
    }
  }

  /**
   * Obtiene todas las reubicaciones pendientes de envío
   */
  getReubicacionesPendientes(): any[] {
    if (!this.realm || this.realm.isClosed) {
      return [];
    }

    try {
      const pendientes = this.realm.objects("Reubicacion").filtered("enviado == false");

      return Array.from(pendientes).map((r: any) => ({
        id: r.id,
        idCliente: r.idCliente,
        latitud: r.latitud,
        longitud: r.longitud,
        latitudAnterior: r.latitudAnterior ?? null,
        longitudAnterior: r.longitudAnterior ?? null,
        accuracy: r.accuracy ?? null,
        numFixes: r.numFixes ?? null,
        metrosMovidos: r.metrosMovidos ?? null,
        fecha: r.fecha,
        idUsuario: r.idUsuario,
      }));
    } catch (error) {
      console.error("[ReubicacionService] Error obteniendo pendientes:", error);
      return [];
    }
  }

  /**
   * Envía las reubicaciones pendientes al endpoint sp_MovilesReubicacionesJSON.
   * Este método es el único emisor vivo; lo usan FullSyncService y
   * ReubicacionSyncTask para evitar duplicados por lógica divergente.
   * @param sucursal Sucursal del usuario
   * @param idUsuario ID del usuario
   * @returns Objeto con resultado de la sincronización
   */
  async enviarReubicacionesPendientes(
    sucursal: number,
    idUsuario: number,
  ): Promise<{ success: boolean; sent: number; error?: string }> {
    // Lock de promesa compartida: si hay un envío en curso, esperamos su resultado.
    if (this.enviandoReubicaciones) {
      console.log("[ReubicacionService] ⏳ Envío de reubicaciones ya en curso, esperando resultado...");
      return this.enviandoReubicaciones;
    }

    this.enviandoReubicaciones = this.ejecutarEnvioReubicaciones(sucursal, idUsuario);

    try {
      return await this.enviandoReubicaciones;
    } finally {
      this.enviandoReubicaciones = null;
    }
  }

  private async ejecutarEnvioReubicaciones(
    sucursal: number,
    idUsuario: number,
  ): Promise<{ success: boolean; sent: number; error?: string }> {
    if (!this.realm || this.realm.isClosed) {
      return { success: false, sent: 0, error: "Realm no inicializado" };
    }

    const reubicacionesPendientes = this.realm.objects("Reubicacion").filtered("enviado == false");
    const registrosLeidos = reubicacionesPendientes.length;

    if (registrosLeidos === 0) {
      return { success: true, sent: 0 };
    }

    console.log(`[ReubicacionService] Enviando ${registrosLeidos} reubicaciones al servidor`);

    const payloadList = Array.from(reubicacionesPendientes).map((r: any) => ({
      sucursal: r.sucursal ?? sucursal,
      cveCliente: r.idCliente,
      latitudAnterior: r.latitudAnterior ?? 0,
      longitudAnterior: r.longitudAnterior ?? 0,
      latitudNueva: r.latitud ?? 0,
      longitudNueva: r.longitud ?? 0,
      fecha: (r.fecha ?? new Date()).toISOString(),
      usuario: r.idUsuario ?? idUsuario,
      idMovil: r.id,
      fechaTransfer: new Date().toISOString(),
    }));

    try {
      const response = await fetchWithTimeout(
        `${this.apiBaseUrl}/api/SincronizacionMovil/sp_MovilesReubicacionesJSON?sucursal=${sucursal}&idUsuario=${idUsuario}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/octet-stream",
          },
          body: JSON.stringify({ reubicaciones: payloadList }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        return { success: false, sent: 0, error: `Error HTTP ${response.status}: ${errorText}` };
      }

      // Marcar como enviadas (no eliminar para conservar historial local)
      this.realm.write(() => {
        Array.from(reubicacionesPendientes).forEach((r: any) => {
          r.enviado = true;
        });
      });

      console.log(`[ReubicacionService] ✅ ${registrosLeidos} reubicaciones enviadas y marcadas como enviado`);

      return { success: true, sent: registrosLeidos };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Error desconocido";
      console.error("[ReubicacionService] Error enviando reubicaciones:", error);
      return { success: false, sent: 0, error: errorMsg };
    }
  }

  /**
   * Obtiene el total de reubicaciones registradas (para estadísticas)
   */
  getTotalReubicaciones(): number {
    if (!this.realm || this.realm.isClosed) {
      return 0;
    }

    try {
      return this.realm.objects("Reubicacion").length;
    } catch (error) {
      console.error("[ReubicacionService] Error obteniendo total:", error);
      return 0;
    }
  }
}

export default ReubicacionService;
