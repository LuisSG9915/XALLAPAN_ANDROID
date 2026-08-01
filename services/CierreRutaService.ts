import Realm from "realm";
import { allSchemas } from "./RealmSchemas";

// Estados que ya consideran el pedido atendido/cerrado y NO bloquean el cierre
const ESTATUS_PEDIDO_PERMITE_CIERRE = [2, 6, 7, 9];

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
      // Bloquea cualquier pedido que NO esté en un estado final/visitado:
      // 2=ENTREGADO, 6=ENTREGADO PARCIAL, 7=PENDIENTE CON CAUSA, 9=CANCELADO
      const pedidos = realm
        .objects("Pedido")
        .filtered(
          "ruta = $0 AND estatus != $1 AND estatus != $2 AND estatus != $3 AND estatus != $4",
          ruta,
          ESTATUS_PEDIDO_PERMITE_CIERRE[0],
          ESTATUS_PEDIDO_PERMITE_CIERRE[1],
          ESTATUS_PEDIDO_PERMITE_CIERRE[2],
          ESTATUS_PEDIDO_PERMITE_CIERRE[3]
        );

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
