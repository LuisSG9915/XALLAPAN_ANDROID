import Realm from "realm";

class DetalleVisitasService {
  private static instance: DetalleVisitasService;
  private realm: Realm | null = null;

  private constructor() {}

  static getInstance(): DetalleVisitasService {
    if (!DetalleVisitasService.instance) {
      DetalleVisitasService.instance = new DetalleVisitasService();
    }
    return DetalleVisitasService.instance;
  }

  /**
   * Inyecta la instancia de Realm desde FullSyncService
   * Evita abrir múltiples instancias del mismo Realm
   */
  setRealm(realm: Realm): void {
    this.realm = realm;
    console.log("[DetalleVisitasService] Realm inyectado correctamente");
  }

  private getRealm(): Realm {
    if (!this.realm || this.realm.isClosed) {
      throw new Error(
        "[DetalleVisitasService] Realm no inicializado. Debe llamarse FullSyncService.initialize() primero",
      );
    }
    return this.realm;
  }

  async iniciarVisita(
    idCliente: number,
    idUsuario: number,
    idRuta: number,
    tipoVisita?: number,
  ): Promise<string | null> {
    try {
      const realm = this.getRealm();
      const detalleId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const now = new Date();

      realm.write(() => {
        realm.create("DetalleVisitas", {
          id: detalleId,
          fechaInicio: now,
          fechaFin: null,
          idCliente,
          idUsuario,
          idRuta,
          tipoVisita: tipoVisita ?? null,
          syncedAt: new Date(0),
          sincronizado: false,
        });
      });

      console.log(`[DetalleVisitas] ✅ Visita iniciada: ${detalleId}`, {
        idCliente,
        idUsuario,
        idRuta,
        fechaInicio: now,
      });

      return detalleId;
    } catch (error) {
      console.error("[DetalleVisitas] ❌ Error al iniciar visita:", error);
      return null;
    }
  }

  async finalizarVisita(detalleId: string, tipoVisita?: number): Promise<boolean> {
    try {
      const realm = this.getRealm();
      const now = new Date();

      realm.write(() => {
        const detalle = realm.objectForPrimaryKey("DetalleVisitas", detalleId);
        if (detalle) {
          (detalle as any).fechaFin = now;
          if (tipoVisita !== undefined) {
            (detalle as any).tipoVisita = tipoVisita;
          }
          console.log(`[DetalleVisitas] ✅ Visita finalizada: ${detalleId}`, {
            fechaFin: now,
            tipoVisita,
          });
        } else {
          console.warn(`[DetalleVisitas] ⚠️ No se encontró detalle con ID: ${detalleId}`);
        }
      });

      return true;
    } catch (error) {
      console.error("[DetalleVisitas] ❌ Error al finalizar visita:", error);
      return false;
    }
  }

  async registrarVisitaCompleta(
    idCliente: number,
    idUsuario: number,
    idRuta: number,
    tipoVisita?: number,
  ): Promise<string | null> {
    try {
      const realm = this.getRealm();
      const detalleId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const now = new Date();

      realm.write(() => {
        realm.create("DetalleVisitas", {
          id: detalleId,
          fechaInicio: now,
          fechaFin: now,
          idCliente,
          idUsuario,
          idRuta,
          tipoVisita: tipoVisita ?? null,
          syncedAt: new Date(0),
          sincronizado: false,
        });
      });

      console.log(`[DetalleVisitas] ✅ Visita completa registrada: ${detalleId}`, {
        idCliente,
        idUsuario,
        idRuta,
        fechaInicio: now,
        fechaFin: now,
      });

      return detalleId;
    } catch (error) {
      console.error("[DetalleVisitas] ❌ Error al registrar visita completa:", error);
      return null;
    }
  }

  async getVisitasActivas(idCliente: number): Promise<any[]> {
    try {
      const realm = this.getRealm();
      const visitas = realm.objects("DetalleVisitas").filtered("idCliente == $0 AND fechaFin == null", idCliente);

      return Array.from(visitas).map((v: any) => ({
        id: v.id,
        fechaInicio: v.fechaInicio,
        fechaFin: v.fechaFin,
        idCliente: v.idCliente,
        idUsuario: v.idUsuario,
        idRuta: v.idRuta,
        tipoVisita: v.tipoVisita,
      }));
    } catch (error) {
      console.error("[DetalleVisitas] ❌ Error al obtener visitas activas:", error);
      return [];
    }
  }
}

export default DetalleVisitasService;
