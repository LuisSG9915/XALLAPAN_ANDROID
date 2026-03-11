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
      console.log(usuario);
      console.log(usuario.reubicacion);
      if (!usuario) return false;
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
   * @param cveCliente ID del cliente
   * @returns true si ya fue reubicado, false si aún no
   */
  clienteYaReubicado(cveCliente: number): boolean {
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
        .filtered("cveCliente == $0 AND fecha >= $1 AND fecha <= $2", cveCliente, startOfDay, endOfDay);

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
    console.log("[ReubicacionService] 📍 Iniciando registro de reubicación...");
    console.log(`[ReubicacionService] Parámetros:`, {
      sucursal,
      cveCliente,
      latitudAnterior,
      longitudAnterior,
      latitudNueva,
      longitudNueva,
      usuario,
    });

    if (!this.realm || this.realm.isClosed) {
      console.error("[ReubicacionService] ❌ Realm no inicializado");
      return null;
    }

    // Verificar si ya existe una reubicación para este cliente
    const yaReubicado = this.clienteYaReubicado(cveCliente);
    console.log(`[ReubicacionService] Cliente ${cveCliente} ya reubicado: ${yaReubicado}`);

    if (yaReubicado) {
      console.warn(`[ReubicacionService] ⚠️ El cliente ${cveCliente} ya fue reubicado anteriormente`);
      return null;
    }

    const id = generateUniqueId();
    const fecha = (() => {
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Mexico_City",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      const parts = fmt.formatToParts(new Date());
      const g = (t: string) => parts.find((p) => p.type === t)?.value || "0";
      return new Date(
        parseInt(g("year"), 10),
        parseInt(g("month"), 10) - 1,
        parseInt(g("day"), 10),
        parseInt(g("hour"), 10),
        parseInt(g("minute"), 10),
        parseInt(g("second"), 10),
      );
    })();
    const idMovil = Date.now();

    console.log(`[ReubicacionService] Datos generados:`, {
      id,
      fecha: fecha.toISOString(),
      idMovil,
      enviado: false,
    });

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

      console.log(`[ReubicacionService] ✅ Reubicación registrada exitosamente`);
      console.log(`[ReubicacionService] ID: ${id}, Cliente: ${cveCliente}, Enviado: false`);

      // Verificar que se guardó correctamente
      const verificacion = this.realm.objectForPrimaryKey("Reubicacion", id);
      if (verificacion) {
        console.log(`[ReubicacionService] ✓ Verificación: Reubicación existe en BD`, {
          id: (verificacion as any).id,
          enviado: (verificacion as any).enviado,
          cveCliente: (verificacion as any).cveCliente,
        });
      } else {
        console.error(`[ReubicacionService] ❌ Verificación: No se encontró la reubicación en BD`);
      }

      // Actualizar coordenadas del cliente en ClienteFull
      this.actualizarCoordenadasClienteLocal(cveCliente, latitudNueva, longitudNueva);

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
      const payload = pendientes.map((r) => ({
        sucursal: r.sucursal,
        cveCliente: r.cveCliente,
        latitudAnterior: r.latitudAnterior ?? 0,
        longitudAnterior: r.longitudAnterior ?? 0,
        latitudNueva: r.latitudNueva,
        longitudNueva: r.longitudNueva,
        fecha: (r.fecha ?? new Date()).toISOString(),
        usuario: r.usuario,
        idMovil: r.idMovil,
        fechaTransfer: (r.fechaTransfer ?? new Date()).toISOString(),
      }));

      const response = await fetch(
        `${this.apiBaseUrl}/api/SincronizacionMovil/sp_MovilesReubicacionesJSON?sucursal=${sucursal}&idUsuario=${idUsuario}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            request: payload,
          }),
        },
      );

      if (response.ok) {
        // Marcar como enviadas (no eliminar para conservar historial)
        this.realm.write(() => {
          pendientes.forEach((r) => {
            const reubicacion = this.realm!.objectForPrimaryKey("Reubicacion", r.id);
            if (reubicacion) {
              (reubicacion as any).enviado = true;
            }
          });
        });

        console.log(`[ReubicacionService] ✅ ${pendientes.length} reubicaciones enviadas y marcadas como enviado`);

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
