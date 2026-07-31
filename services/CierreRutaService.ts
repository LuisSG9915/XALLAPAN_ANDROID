import Realm from "realm";
import { allSchemas } from "./RealmSchemas";

const ESTATUS_PEDIDO_SIN_CAUSA = 8;

class CierreRutaService {
  private realm: Realm | null = null;

  /**
   * Inyecta la instancia de Realm desde FullSyncService
   * Evita abrir múltiples instancias del mismo Realm
   */
  setRealm(realm: Realm): void {
    this.realm = realm;
    console.log("[CierreRutaService] Realm inyectado correctamente");
  }

  private getRealm(): Realm {
    if (!this.realm || this.realm.isClosed) {
      throw new Error("[CierreRutaService] Realm no inicializado. Debe llamarse FullSyncService.initialize() primero");
    }
    return this.realm;
  }

  async getRutaStatus(sucursal: number, vendedor: number): Promise<boolean> {
    const realm = this.getRealm();
    const id = `${sucursal}-${vendedor}`;
    const cierreRuta: any = realm.objectForPrimaryKey("CierreRuta", id);

    return cierreRuta?.rutaCerrada ?? false;
  }

  validarPedidosPendientesSinCausa(ruta: number): { permitido: boolean; pedidosBloqueantes: any[] } {
    try {
      const realm = this.getRealm();
      const pedidos = realm
        .objects("Pedido")
        .filtered("ruta = $0 AND estatus = $1", ruta, ESTATUS_PEDIDO_SIN_CAUSA);

      const pedidosArray = Array.from(pedidos).map((p: any) => ({
        id: p.id,
        folio: p.folio,
        cliente: p.cliente,
        clienteNombre: p.clienteNombre,
        estatus: p.estatus,
        estatusDescripcion: p.estatusDescripcion,
      }));

      return {
        permitido: pedidosArray.length === 0,
        pedidosBloqueantes: pedidosArray,
      };
    } catch (error) {
      console.warn("[CierreRutaService] No se pudo validar pedidos (tabla no existe aún):", error);
      return { permitido: true, pedidosBloqueantes: [] };
    }
  }

  async setRutaCerrada(sucursal: number, vendedor: number, cerrada: boolean): Promise<void> {
    const realm = this.getRealm();
    const id = `${sucursal}-${vendedor}`;
    const cierreRuta: any = realm.objectForPrimaryKey("CierreRuta", id);

    if (!cerrada && cierreRuta?.rutaCerrada !== true) {
      console.log(`Ruta ya abierta para sucursal ${sucursal}, vendedor ${vendedor}; no se registra otro cambio.`);
      return;
    }

    const updatedAt = new Date();
    const fechaCierre = cerrada ? updatedAt : cierreRuta?.fechaCierre ?? updatedAt;

    realm.write(() => {
      realm.create(
        "CierreRuta",
        {
          id,
          sucursal,
          vendedor,
          fechaCierre,
          rutaCerrada: cerrada,
          updatedAt,
          enviado: false, // Marcar como pendiente de sincronizar
        },
        Realm.UpdateMode.Modified
      );
    });

    console.log(`✅ Ruta ${cerrada ? "cerrada" : "abierta"} para sucursal ${sucursal}, vendedor ${vendedor}`);
  }
}

export default new CierreRutaService();
