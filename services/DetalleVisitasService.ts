import Realm from "realm";
import { ALL_SCHEMAS } from "./RealmSchemas";

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

  private async getRealm(): Promise<Realm> {
    if (!this.realm || this.realm.isClosed) {
      this.realm = await Realm.open({
        path: "FullSyncDB",
        schema: ALL_SCHEMAS,
        schemaVersion: 9,
      });
    }
    return this.realm;
  }

  async iniciarVisita(idCliente: number, idUsuario: number, idRuta: number): Promise<string | null> {
    try {
      const realm = await this.getRealm();
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
          syncedAt: new Date(0),
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

  async finalizarVisita(detalleId: string): Promise<boolean> {
    try {
      const realm = await this.getRealm();
      const now = new Date();

      realm.write(() => {
        const detalle = realm.objectForPrimaryKey("DetalleVisitas", detalleId);
        if (detalle) {
          (detalle as any).fechaFin = now;
          console.log(`[DetalleVisitas] ✅ Visita finalizada: ${detalleId}`, {
            fechaFin: now,
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

  async registrarVisitaCompleta(idCliente: number, idUsuario: number, idRuta: number): Promise<string | null> {
    try {
      const realm = await this.getRealm();
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
          syncedAt: new Date(0),
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
      const realm = await this.getRealm();
      const visitas = realm.objects("DetalleVisitas").filtered("idCliente == $0 AND fechaFin == null", idCliente);

      return Array.from(visitas).map((v: any) => ({
        id: v.id,
        fechaInicio: v.fechaInicio,
        fechaFin: v.fechaFin,
        idCliente: v.idCliente,
        idUsuario: v.idUsuario,
        idRuta: v.idRuta,
      }));
    } catch (error) {
      console.error("[DetalleVisitas] ❌ Error al obtener visitas activas:", error);
      return [];
    }
  }
}

export default DetalleVisitasService;
