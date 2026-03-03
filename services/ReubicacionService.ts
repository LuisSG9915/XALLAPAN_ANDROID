import Realm from "realm";

/**
 * Genera un ID único simple sin dependencias externas
 * Formato: timestamp-random (ej: 1234567890123-abc123)
 */
function generateUniqueId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 15);
  return `${timestamp}-${random}`;
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
  private apiBaseUrl = "https://cbinfo.no-ip.info:9031";

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
   * Verifica si un cliente ya fue reubicado
   * @param cveCliente ID del cliente
   * @returns true si ya fue reubicado, false si aún no
   */
  clienteYaReubicado(cveCliente: number): boolean {
    if (!this.realm || this.realm.isClosed) {
      console.warn("[ReubicacionService] Realm no inicializado");
      return false;
    }

    try {
      const reubicaciones = this.realm.objects("Reubicacion").filtered("cveCliente == $0", cveCliente);

      return reubicaciones.length > 0;
    } catch (error) {
      console.error("[ReubicacionService] Error verificando reubicación:", error);
      return false;
    }
  }

  /**
   * Registra una reubicación de cliente en Realm local
   * @param sucursal Sucursal del usuario
   * @param cveCliente ID del cliente
   * @param latitudAnterior Latitud anterior del cliente (puede ser null)
   * @param longitudAnterior Longitud anterior del cliente (puede ser null)
   * @param latitudNueva Nueva latitud del cliente
   * @param longitudNueva Nueva longitud del cliente
   * @param usuario ID del usuario que reubica
   * @returns ID de la reubicación creada o null si falla
   */
  async registrarReubicacion(
    sucursal: number,
    cveCliente: number,
    latitudAnterior: number | null,
    longitudAnterior: number | null,
    latitudNueva: number,
    longitudNueva: number,
    usuario: number,
  ): Promise<string | null> {
    if (!this.realm || this.realm.isClosed) {
      console.error("[ReubicacionService] Realm no inicializado");
      return null;
    }

    // Verificar si ya existe una reubicación para este cliente
    if (this.clienteYaReubicado(cveCliente)) {
      console.warn(`[ReubicacionService] El cliente ${cveCliente} ya fue reubicado anteriormente`);
      return null;
    }

    const id = generateUniqueId();
    const fecha = new Date();
    const idMovil = Date.now();

    try {
      this.realm.write(() => {
        this.realm!.create("Reubicacion", {
          id,
          sucursal,
          cveCliente,
          latitudAnterior: latitudAnterior ?? undefined,
          longitudAnterior: longitudAnterior ?? undefined,
          latitudNueva,
          longitudNueva,
          fecha,
          usuario,
          realizado: false,
          idMovil,
          fechaTransfer: fecha,
          enviado: false,
        });
      });

      console.log(`[ReubicacionService] Reubicación registrada para cliente ${cveCliente}`);

      // Actualizar coordenadas del cliente en ClienteFull
      this.actualizarCoordenadasClienteLocal(cveCliente, latitudNueva, longitudNueva);

      return id;
    } catch (error) {
      console.error("[ReubicacionService] Error registrando reubicación:", error);
      return null;
    }
  }

  /**
   * Actualiza las coordenadas del cliente en la tabla ClienteFull local
   */
  private actualizarCoordenadasClienteLocal(cveCliente: number, latitud: number, longitud: number): void {
    if (!this.realm || this.realm.isClosed) return;

    try {
      const cliente = this.realm.objectForPrimaryKey("ClienteFull", cveCliente);

      if (cliente) {
        this.realm.write(() => {
          (cliente as any).latitud = latitud;
          (cliente as any).longitud = longitud;
        });

        console.log(`[ReubicacionService] Coordenadas actualizadas localmente para cliente ${cveCliente}`);
      }
    } catch (error) {
      console.error("[ReubicacionService] Error actualizando coordenadas locales:", error);
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
        sucursal: r.sucursal,
        cveCliente: r.cveCliente,
        latitudAnterior: r.latitudAnterior,
        longitudAnterior: r.longitudAnterior,
        latitudNueva: r.latitudNueva,
        longitudNueva: r.longitudNueva,
        fecha: r.fecha,
        usuario: r.usuario,
        idMovil: r.idMovil,
        fechaTransfer: r.fechaTransfer,
      }));
    } catch (error) {
      console.error("[ReubicacionService] Error obteniendo pendientes:", error);
      return [];
    }
  }

  /**
   * Envía reubicaciones pendientes al servidor
   * @param sucursal Sucursal del usuario
   * @param idUsuario ID del usuario
   * @returns Objeto con resultado de la sincronización
   */
  async sincronizarReubicaciones(
    sucursal: number,
    idUsuario: number,
  ): Promise<{ success: boolean; sent: number; error?: string }> {
    if (!this.realm || this.realm.isClosed) {
      return { success: false, sent: 0, error: "Realm no inicializado" };
    }

    const pendientes = this.getReubicacionesPendientes().filter((r) => r.sucursal === sucursal);

    if (pendientes.length === 0) {
      console.log("[ReubicacionService] No hay reubicaciones pendientes");
      return { success: true, sent: 0 };
    }

    console.log(`[ReubicacionService] Enviando ${pendientes.length} reubicaciones al servidor`);

    try {
      const response = await fetch(
        `${this.apiBaseUrl}/api/SincronizacionMovil/sp_MovilesReubicacionesJSON?sucursal=${sucursal}&idUsuario=${idUsuario}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            reubicaciones: pendientes,
          }),
        },
      );

      if (response.ok) {
        // Marcar como enviadas
        this.realm.write(() => {
          pendientes.forEach((r) => {
            const reubicacion = this.realm!.objectForPrimaryKey("Reubicacion", r.id);
            if (reubicacion) {
              (reubicacion as any).enviado = true;
            }
          });
        });

        console.log(`[ReubicacionService] ✅ ${pendientes.length} reubicaciones enviadas exitosamente`);

        return { success: true, sent: pendientes.length };
      } else {
        const errorText = await response.text().catch(() => "");
        return {
          success: false,
          sent: 0,
          error: `Error HTTP ${response.status}: ${errorText}`,
        };
      }
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
