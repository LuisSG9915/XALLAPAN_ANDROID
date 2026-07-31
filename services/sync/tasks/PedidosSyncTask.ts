import Realm from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";

export class PedidosSyncTask extends SyncTask {
  constructor(realm: Realm, syncLogId: string) {
    super(realm, syncLogId);
  }

  getTableName(): string {
    return "Pedido";
  }

  getEndpoint(): string {
    return "https://api.cbinformatica.net:9031/api/MovilesVentas/sp_MovilesPedidosFull";
  }

  getPriority(): number {
    return 50;
  }

  getDependencies(): string[] {
    return ["ClienteFull", "CatalogosPedidos"];
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      const user = this.realm.objects("Usuario").sorted("id", true)[0] as any;
      const ruta = user?.ruta ? parseInt(user.ruta) : 0;

      if (!ruta || ruta === 0) {
        console.log(`[PedidosSyncTask] Usuario sin ruta asignada, omitiendo sincronización`);
        return {
          success: true,
          registrosLeidos: 0,
          registrosGuardados: 0,
        };
      }

      const endpoint = `${this.getEndpoint()}/${ruta}`;
      console.log(`[PedidosSyncTask] Sincronizando pedidos para ruta ${ruta}...`);

      const response = await this.fetchWithTimeout(endpoint, {
        headers: { accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const pedidosData = await response.json();

      if (!Array.isArray(pedidosData)) {
        throw new Error("La respuesta no es un array de pedidos");
      }

      console.log(`[PedidosSyncTask] Recibidos ${pedidosData.length} pedidos`);

      let registrosGuardados = 0;
      let registrosActualizados = 0;

      this.realm.write(() => {
        pedidosData.forEach((pedido: any) => {
          const cliente = this.realm.objectForPrimaryKey("ClienteFull", pedido.cliente) as any;
          const clienteNombre = cliente?.nombre || `Cliente #${pedido.cliente}`;
          const clienteDomicilio = cliente?.domicilio || "";

          const pedidoExistente = this.realm.objectForPrimaryKey("Pedido", pedido.folio) as any;

          const preserveModificadoLocal = pedidoExistente?.modificadoLocal ?? false;
          const preserveCausaNoAtencion = pedidoExistente?.causaNoAtencion ?? null;
          const preserveObserNoAtencion = pedidoExistente?.obserNoAtencion ?? null;

          this.realm.create(
            "Pedido",
            {
              id: pedido.folio,
              folio: pedido.folio,
              fecha: pedido.fecha ? new Date(pedido.fecha) : null,
              ruta: pedido.ruta,
              cliente: pedido.cliente,
              clienteNombre,
              clienteDomicilio,
              idCanal: null,
              fechaAtencion: null,
              idVendedor: pedido.idVendedor,
              numeroProductos: pedido.numeroProductos,
              cantPedido: pedido.cantPedido,
              listaPrecio: pedido.listaPrecio,
              fechaEntrega: pedido.fechaEntrega ? new Date(pedido.fechaEntrega) : null,
              estatus: pedido.estatus,
              estatusDescripcion: this.getEstatusDescripcion(pedido.estatus),
              fueraAgenda: pedido.fueraAgenda,
              observaciones: pedido.observaciones,
              no_venta: pedido.noVenta,
              tieneDiferencia: false,
              causaNoAtencion: preserveCausaNoAtencion,
              obserNoAtencion: preserveObserNoAtencion,
              syncedAt: new Date(),
              syncedAr: null,
              modificadoLocal: preserveModificadoLocal,
            },
            Realm.UpdateMode.Modified,
          );

          if (pedidoExistente) {
            registrosActualizados++;
          } else {
            registrosGuardados++;
          }
        });
      });

      console.log(`[PedidosSyncTask] Sincronizados ${registrosGuardados} nuevos, ${registrosActualizados} actualizados`);

      return {
        success: true,
        registrosLeidos: pedidosData.length,
        registrosGuardados,
        registrosActualizados,
      };
    } catch (error) {
      console.error("[PedidosSyncTask] Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }

  private getEstatusDescripcion(estatus: number): string {
    const catalogo = this.realm.objectForPrimaryKey("CatalogoEstatusPedido", estatus) as any;
    return catalogo?.descripcion || "Desconocido";
  }
}
