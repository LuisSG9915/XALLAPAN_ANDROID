import Realm from "realm";
import { allSchemas } from "./RealmSchemas";

// Únicamente estos estados permiten cerrar la ruta.
// 2=ENTREGADO, 6=ENTREGADO PARCIAL
const ESTATUS_PEDIDO_PERMITE_CIERRE = [2, 6] as const;

type ResultadoValidacionPedidos = {
  permitido: boolean;
  pedidosBloqueantes: any[];
  error?: boolean;
};

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

  validarPedidosPendientesSinCausa(ruta: number): ResultadoValidacionPedidos {
    try {
      const realm = this.getRealm();
      const inicioDelDia = new Date();
      inicioDelDia.setHours(0, 0, 0, 0);
      const inicioDelDiaSiguiente = new Date(inicioDelDia);
      inicioDelDiaSiguiente.setDate(inicioDelDiaSiguiente.getDate() + 1);

      // Solo se validan los pedidos de hoy. Cualquier estado distinto de
      // ENTREGADO (2) o ENTREGADO PARCIAL (6) bloquea el cierre.
      const pedidosDeLaRuta = realm.objects("Pedido").filtered("ruta == $0", ruta);
      const pedidosPorFolio = new Map<number, any>();
      Array.from(pedidosDeLaRuta)
        .filter((p: any) => {
          if (!p.fechaEntrega) return false;

          const fechaEntrega = new Date(p.fechaEntrega);
          const estatus = Number(p.estatus);

          return (
            !Number.isNaN(fechaEntrega.getTime()) &&
            fechaEntrega >= inicioDelDia &&
            fechaEntrega < inicioDelDiaSiguiente &&
            !ESTATUS_PEDIDO_PERMITE_CIERRE.includes(estatus as (typeof ESTATUS_PEDIDO_PERMITE_CIERRE)[number])
          );
        })
        .forEach((p: any) => {
          if (!pedidosPorFolio.has(Number(p.folio))) {
            pedidosPorFolio.set(Number(p.folio), {
              id: p.id,
              folio: p.folio,
              cliente: p.cliente,
              clienteNombre: p.clienteNombre,
              clienteDomicilio: p.clienteDomicilio,
              estatus: Number(p.estatus),
              estatusDescripcion: p.estatusDescripcion,
            });
          }
        });
      const pedidosArray = Array.from(pedidosPorFolio.values());

      console.log(
        `[CierreRutaService] Validación ruta ${ruta}: ${pedidosArray.length} pedido(s) bloqueante(s) de hoy`,
      );

      return {
        permitido: pedidosArray.length === 0,
        pedidosBloqueantes: pedidosArray,
      };
    } catch (error) {
      console.error("[CierreRutaService] No se pudo validar pedidos; se bloqueará el cierre:", error);
      return { permitido: false, pedidosBloqueantes: [], error: true };
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
