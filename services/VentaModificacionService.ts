import Realm from "realm";
import FullSyncService from "./FullSyncService";
import AuthService from "./AuthService";

export interface ModificacionVentaParams {
  noVenta: number;
  sucursal: number;
  caja?: number;
  idMovil: number;
  claveProd: number;
  nombreProducto?: string;
  cantidadNueva?: number;
  motivoModificacion?: string;
  latitud?: number;
  longitud?: number;
}

class VentaModificacionService {
  private static instance: VentaModificacionService;
  private realm: Realm | null = null;

  private constructor() {}

  static getInstance(): VentaModificacionService {
    if (!VentaModificacionService.instance) {
      VentaModificacionService.instance = new VentaModificacionService();
    }
    return VentaModificacionService.instance;
  }

  setRealm(realm: Realm): void {
    this.realm = realm;
  }

  private getRealm(): Realm {
    if (!this.realm || this.realm.isClosed) {
      throw new Error(
        "[VentaModificacionService] Realm no inicializado. Debe llamarse FullSyncService.initialize() primero",
      );
    }
    return this.realm;
  }

  private generateUUID(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  async quitarProducto(params: ModificacionVentaParams): Promise<void> {
    try {
      await FullSyncService.initialize();
      const realm = this.getRealm();
      const currentUser = AuthService.currentUser;

      if (!currentUser) {
        throw new Error("Usuario no autenticado");
      }

      const {
        noVenta,
        sucursal,
        caja,
        idMovil,
        claveProd,
        nombreProducto,
        cantidadNueva,
        motivoModificacion,
        latitud,
        longitud,
      } = params;

      realm.write(() => {
        const ventas = realm
          .objects("Venta")
          .filtered(`noVenta == ${noVenta} AND sucursal == ${sucursal} AND claveProd == ${claveProd}`);

        console.log(
          `[VentaModificacion] Buscando renglón noVenta=${noVenta}, sucursal=${sucursal}, claveProd=${claveProd}`,
        );
        console.log(`[VentaModificacion] Encontrados ${ventas.length} registros`);

        if (ventas.length === 0) {
          console.warn(`[VentaModificacion] ⚠️ No se encontró el renglón especificado`);
        }

        let cantidadAnteriorGuardada = 0;

        // PASO 1: Ajustar inventario según la diferencia de cantidad
        ventas.forEach((venta: any) => {
          const cantidadAnterior = venta.cantProducto || 0;
          cantidadAnteriorGuardada = cantidadAnterior;
          const cantFinal = cantidadNueva ?? 0;
          const diferencia = cantidadAnterior - cantFinal; // cuánto se devuelve

          if (diferencia > 0) {
            const inventario = realm
              .objects("Inventario")
              .filtered(`claveProd == ${claveProd} AND sucursal == ${sucursal}`);

            if (inventario.length > 0) {
              const inv = inventario[0] as any;
              const saldoAnterior = inv.saldo || 0;
              inv.saldo = saldoAnterior + diferencia;
              console.log(
                `[VentaModificacion] ✅ Inventario ajustado - Producto: ${claveProd}, Devuelto: ${diferencia}, Saldo anterior: ${saldoAnterior}, Saldo nuevo: ${inv.saldo}`,
              );
            } else {
              console.warn(`[VentaModificacion] ⚠️ No se encontró inventario para producto ${claveProd}`);
            }
          }
        });

        // PASO 2: Actualizar cantidad, precio e importe en Realm
        ventas.forEach((venta: any) => {
          const cantFinal = cantidadNueva ?? 0;
          const precioUnitario = venta.precio || 0;
          venta.cantProducto = cantFinal;
          venta.importe = cantFinal * precioUnitario;
          if (cantFinal === 0) {
            venta.precio = 0;
          }
          console.log(
            `[VentaModificacion] Renglón actualizado - ID: ${venta.id}, cantProducto: ${cantFinal}, importe: ${venta.importe}`,
          );
        });

        // PASO 3: Registrar la modificación para envío al servidor
        const modificacionId = this.generateUUID();
        const fechaModifica = new Date();

        realm.create("VentaModificacion", {
          id: modificacionId,
          sucursal,
          noVenta,
          caja: caja ?? 1,
          idMovil,
          claveProd,
          nombreProducto: nombreProducto ?? "",
          cantidadAnterior: cantidadAnteriorGuardada,
          cantidadNueva: cantidadNueva ?? 0,
          usuarioModifica: currentUser.id,
          fechaModifica,
          motivoModificacion: motivoModificacion ?? "Modificación de renglón desde móvil",
          latitud: latitud ?? 0,
          longitud: longitud ?? 0,
          fechaAlta: new Date(),
          enviado: false,
        });

        console.log(
          `[VentaModificacion] ✅ Renglón modificado localmente: noVenta=${noVenta}, claveProd=${claveProd}, cantNueva=${
            cantidadNueva ?? 0
          }`,
        );
      });
    } catch (error) {
      console.error("[VentaModificacion] Error al modificar venta:", error);
      throw error;
    }
  }

  getModificacionesPendientes(): any[] {
    try {
      const realm = this.getRealm();
      const modificaciones = realm.objects("VentaModificacion").filtered("enviado == false");
      return Array.from(modificaciones);
    } catch (error) {
      console.error("[VentaModificacion] Error al obtener modificaciones:", error);
      return [];
    }
  }
}

export default VentaModificacionService;
