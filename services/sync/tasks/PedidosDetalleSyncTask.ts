import Realm from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";

export class PedidosDetalleSyncTask extends SyncTask {
  constructor(realm: Realm, syncLogId: string) {
    super(realm, syncLogId);
  }

  getTableName(): string {
    return "PedidoDetalle";
  }

  getEndpoint(): string {
    return "https://api.cbinformatica.net:9031/api/MovilesVentas/sp_MovilesPedidosDetalle";
  }

  getPriority(): number {
    return 51;
  }

  getDependencies(): string[] {
    return ["Pedido", "Producto"];
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      const user = this.realm.objects("Usuario").sorted("id", true)[0] as any;
      const ruta = user?.ruta ? parseInt(user.ruta) : 0;

      if (!ruta || ruta === 0) {
        console.log(`[PedidosDetalleSyncTask] Usuario sin ruta, omitiendo`);
        return { success: true, registrosLeidos: 0, registrosGuardados: 0 };
      }

      const endpoint = `${this.getEndpoint()}/${ruta}`;
      console.log(`[PedidosDetalleSyncTask] Sincronizando detalle de pedidos...`);

      const response = await this.fetchWithTimeout(endpoint, {
        headers: { accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const detallesData = await response.json();

      if (!Array.isArray(detallesData)) {
        throw new Error("La respuesta no es un array de detalles");
      }

      console.log(`[PedidosDetalleSyncTask] Recibidos ${detallesData.length} productos de pedidos`);

      let registrosGuardados = 0;
      let registrosActualizados = 0;

      this.realm.write(() => {
        detallesData.forEach((detalle: any) => {
          const idDetalle = `${detalle.folio}-${detalle.idProducto}`;
          const detalleExistente = this.realm.objectForPrimaryKey("PedidoDetalle", idDetalle) as any;

          const preserveCantAtencion = detalleExistente?.cantAtencion ?? detalle.cantAtencion ?? null;
          const preserveCausaDiferencia = detalleExistente?.causaDiferencia ?? null;
          const preserveObserDiferencia = detalleExistente?.obserDiferencia ?? null;
          const preserveModificadoLocal = detalleExistente?.modificadoLocal ?? false;

          const producto = this.realm.objectForPrimaryKey("Producto", detalle.idProducto) as any;
          const productoNombre = producto?.descripcion || `Producto #${detalle.idProducto}`;

          const cantAtencionFinal = preserveCantAtencion;
          const tieneDiferencia = cantAtencionFinal !== null && cantAtencionFinal < detalle.cantPedido;

          this.realm.create(
            "PedidoDetalle",
            {
              id: idDetalle,
              idPedido: detalle.folio,
              idProducto: detalle.idProducto,
              productoNombre,
              cantPedido: detalle.cantPedido,
              cantAtencion: cantAtencionFinal,
              precio: detalle.precio,
              precioAtencion: detalle.precioAtencion ?? null,
              causaDiferencia: preserveCausaDiferencia,
              causaDiferenciaDesc: preserveCausaDiferencia
                ? this.getCausaDiferenciaDescripcion(preserveCausaDiferencia)
                : null,
              obserDiferencia: preserveObserDiferencia,
              tieneDiferencia,
              atendido: cantAtencionFinal !== null && cantAtencionFinal > 0,
              modificadoLocal: preserveModificadoLocal,
            },
            Realm.UpdateMode.Modified,
          );

          if (detalleExistente) {
            registrosActualizados++;
          } else {
            registrosGuardados++;
          }
        });
      });

      console.log(
        `[PedidosDetalleSyncTask] ${registrosGuardados} nuevos, ${registrosActualizados} actualizados`,
      );

      return {
        success: true,
        registrosLeidos: detallesData.length,
        registrosGuardados,
        registrosActualizados,
      };
    } catch (error) {
      console.error("[PedidosDetalleSyncTask] Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }

  private getCausaDiferenciaDescripcion(id: number): string {
    const catalogo = this.realm.objectForPrimaryKey("CatalogoCausaDiferencia", id) as any;
    return catalogo?.descripcion || "";
  }
}
