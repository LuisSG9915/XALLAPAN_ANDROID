import Realm from "realm";
import FullSyncService from "./FullSyncService";
import AuthService from "./AuthService";

export interface CancelacionVentaParams {
  noVenta: number;
  sucursal: number;
  caja?: number;
  idMovil: number;
  motivoCancelacion?: string;
  latitud?: number;
  longitud?: number;
}

class VentaCancelacionService {
  private static instance: VentaCancelacionService;
  private realm: Realm | null = null;

  private constructor() {}

  static getInstance(): VentaCancelacionService {
    if (!VentaCancelacionService.instance) {
      VentaCancelacionService.instance = new VentaCancelacionService();
    }
    return VentaCancelacionService.instance;
  }

  setRealm(realm: Realm): void {
    this.realm = realm;
  }

  private getRealm(): Realm {
    if (!this.realm || this.realm.isClosed) {
      throw new Error(
        "[VentaCancelacionService] Realm no inicializado. Debe llamarse FullSyncService.initialize() primero",
      );
    }
    return this.realm;
  }

  private generateUUID(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  async cancelarVenta(params: CancelacionVentaParams): Promise<void> {
    try {
      await FullSyncService.initialize();
      const realm = this.getRealm();
      const currentUser = AuthService.currentUser;

      if (!currentUser) {
        throw new Error("Usuario no autenticado");
      }

      const { noVenta, sucursal, caja, idMovil, motivoCancelacion, latitud, longitud } = params;

      realm.write(() => {
        const ventas = realm
          .objects("Venta")
          .filtered(`noVenta == ${noVenta} AND sucursal == ${sucursal} AND idMovil == ${idMovil}`);

        console.log(`[VentaCancelacion] Actualizando ${ventas.length} registros de venta`);

        ventas.forEach((venta: any) => {
          venta.cantProducto = 0;
          venta.precio = 0;
          venta.importe = 0;
        });

        const cancelacionId = this.generateUUID();
        const fechaCancela = new Date();

        realm.create("VentaCancelacion", {
          id: cancelacionId,
          sucursal,
          noVenta,
          caja: caja ?? 1,
          idMovil,
          usuarioCancela: currentUser.id,
          fechaCancela,
          motivoCancelacion: motivoCancelacion ?? "Cancelación desde móvil",
          latitud: latitud ?? 0,
          longitud: longitud ?? 0,
          fechaAlta: new Date(),
          enviado: false,
        });

        console.log(`[VentaCancelacion] ✅ Venta cancelada localmente: ${noVenta}`);
      });
    } catch (error) {
      console.error("[VentaCancelacion] Error al cancelar venta:", error);
      throw error;
    }
  }

  getCancelacionesPendientes(): any[] {
    try {
      const realm = this.getRealm();
      const cancelaciones = realm.objects("VentaCancelacion").filtered("enviado == false");
      return Array.from(cancelaciones);
    } catch (error) {
      console.error("[VentaCancelacion] Error al obtener cancelaciones:", error);
      return [];
    }
  }
}

export default VentaCancelacionService;
