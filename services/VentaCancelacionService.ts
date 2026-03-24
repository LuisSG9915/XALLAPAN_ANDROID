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
        // Filtrar solo por noVenta y sucursal, ya que idMovil puede ser null para ventas sincronizadas
        const ventas = realm
          .objects("Venta")
          .filtered(`noVenta == ${noVenta} AND sucursal == ${sucursal}`);

        console.log(`[VentaCancelacion] Buscando ventas con noVenta=${noVenta}, sucursal=${sucursal}`);
        console.log(`[VentaCancelacion] Encontrados ${ventas.length} registros de venta`);

        if (ventas.length === 0) {
          console.warn(`[VentaCancelacion] ⚠️ No se encontraron ventas con los criterios especificados`);
        }

        // PASO 1: Restaurar inventario ANTES de poner cantidades en 0
        console.log(`[VentaCancelacion] 📦 Restaurando inventario para ${ventas.length} productos...`);
        ventas.forEach((venta: any) => {
          const claveProd = venta.claveProd;
          const cantidadVendida = venta.cantProducto || 0;

          if (cantidadVendida > 0 && claveProd) {
            // Buscar registro de inventario para este producto y sucursal
            const inventario = realm
              .objects("Inventario")
              .filtered(`claveProd == ${claveProd} AND sucursal == ${sucursal}`);

            if (inventario.length > 0) {
              const inv = inventario[0] as any;
              const saldoAnterior = inv.saldo || 0;
              inv.saldo = saldoAnterior + cantidadVendida;
              console.log(
                `[VentaCancelacion] ✅ Inventario restaurado - Producto: ${claveProd}, Cantidad devuelta: ${cantidadVendida}, Saldo anterior: ${saldoAnterior}, Saldo nuevo: ${inv.saldo}`,
              );
            } else {
              console.warn(
                `[VentaCancelacion] ⚠️ No se encontró inventario para producto ${claveProd} en sucursal ${sucursal}`,
              );
            }
          }
        });

        // PASO 2: Poner cantidades y precios en 0
        ventas.forEach((venta: any) => {
          console.log(`[VentaCancelacion] Antes - ID: ${venta.id}, cantProducto: ${venta.cantProducto}, precio: ${venta.precio}, importe: ${venta.importe}`);
          venta.cantProducto = 0;
          venta.precio = 0;
          venta.importe = 0;
          console.log(`[VentaCancelacion] Después - ID: ${venta.id}, cantProducto: ${venta.cantProducto}, precio: ${venta.precio}, importe: ${venta.importe}`);
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
