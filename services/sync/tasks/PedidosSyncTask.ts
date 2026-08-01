

import Realm from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";
import PedidoNotificacionService from "../../PedidoNotificacionService";

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
    return ["ClienteFull", "CatalogosPedidos", "Producto"];
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

      const rows = await response.json();

      if (!Array.isArray(rows)) {
        throw new Error("La respuesta no es un array de pedidos");
      }

      console.log(`[PedidosSyncTask] Recibidos ${rows.length} renglones (cabecera + productos)`);

      // Agrupar renglones por folio: cada renglón es un producto del pedido
      const pedidosMap = new Map<number, any[]>();
      rows.forEach((row: any) => {
        const folio = row.folio;
        if (!pedidosMap.has(folio)) {
          pedidosMap.set(folio, []);
        }
        pedidosMap.get(folio)!.push(row);
      });

      let registrosGuardados = 0;
      let registrosActualizados = 0;
      let detallesGuardados = 0;
      let detallesActualizados = 0;
      const foliosNuevos: number[] = [];

      this.realm.write(() => {
        pedidosMap.forEach((renglones, folio) => {
          const primero = renglones[0];
          const pedidoExistente = this.realm.objectForPrimaryKey("Pedido", folio) as any;

          // Si el pedido fue modificado localmente, conservar estado de atención
          const conservarLocal = pedidoExistente?.modificadoLocal === true;
          const estatusFinal = conservarLocal ? pedidoExistente.estatus : primero.estatus;
          const fechaAtencionFinal = conservarLocal ? pedidoExistente.fechaAtencion : null;
          const causaNoAtencionFinal = conservarLocal ? pedidoExistente.causaNoAtencion : null;
          const obserNoAtencionFinal = conservarLocal ? pedidoExistente.obserNoAtencion : null;

          // Cabecera agrupada
          const numeroProductos = renglones.length;
          const cantPedidoTotal = renglones.reduce(
            (sum: number, r: any) => sum + (parseFloat(r.cantPedido) || 0),
            0
          );

          this.realm.create(
            "Pedido",
            {
              id: folio,
              folio,
              fecha: primero.fecha ? new Date(primero.fecha) : null,
              ruta: primero.ruta,
              cliente: primero.cliente,
              clienteNombre: this.getClienteNombre(primero.cliente),
              clienteDomicilio: this.getClienteDomicilio(primero.cliente),
              idCanal: null,
              fechaAtencion: fechaAtencionFinal,
              idVendedor: primero.idVendedor,
              numeroProductos,
              cantPedido: cantPedidoTotal,
              listaPrecio: primero.listaPrecio,
              fechaEntrega: primero.fechaEntrega ? new Date(primero.fechaEntrega) : null,
              estatus: estatusFinal,
              estatusDescripcion: this.getEstatusDescripcion(estatusFinal),
              fueraAgenda: primero.fueraAgenda,
              observaciones: primero.observaciones,
              no_venta: primero.noVenta,
              tieneDiferencia: pedidoExistente?.tieneDiferencia ?? false,
              causaNoAtencion: causaNoAtencionFinal,
              obserNoAtencion: obserNoAtencionFinal,
              syncedAt: new Date(),
              syncedAr: null,
              modificadoLocal: pedidoExistente?.modificadoLocal ?? false,
            },
            Realm.UpdateMode.Modified
          );

          if (pedidoExistente) {
            registrosActualizados++;
          } else {
            registrosGuardados++;
            foliosNuevos.push(folio);
          }

          // Crear/actualizar detalles (productos) del pedido
          renglones.forEach((renglon: any) => {
            const idProducto = renglon.idProducto;
            const idDetalle = `${folio}-${idProducto}`;
            const detalleExistente = this.realm.objectForPrimaryKey("PedidoDetalle", idDetalle) as any;

            const producto = this.realm.objectForPrimaryKey("Producto", idProducto) as any;
            const productoNombre = producto?.descripcion || `Producto #${idProducto}`;

            const cantPedido = parseFloat(renglon.cantPedido) || 0;
            const cantAtencionFinal = detalleExistente?.cantAtencion ?? null;
            const tieneDiferencia =
              cantAtencionFinal !== null && cantAtencionFinal !== undefined && cantAtencionFinal < cantPedido;

            this.realm.create(
              "PedidoDetalle",
              {
                id: idDetalle,
                idPedido: folio,
                idProducto,
                productoNombre,
                cantPedido,
                cantAtencion: cantAtencionFinal,
                precio: renglon.precio ?? null,
                precioAtencion: detalleExistente?.precioAtencion ?? null,
                causaDiferencia: detalleExistente?.causaDiferencia ?? null,
                causaDiferenciaDesc: detalleExistente?.causaDiferencia
                  ? this.getCausaDiferenciaDescripcion(detalleExistente.causaDiferencia)
                  : null,
                obserDiferencia: detalleExistente?.obserDiferencia ?? null,
                tieneDiferencia,
                atendido: cantAtencionFinal !== null && cantAtencionFinal !== undefined && cantAtencionFinal > 0,
                modificadoLocal: detalleExistente?.modificadoLocal ?? false,
              },
              Realm.UpdateMode.Modified
            );

            if (detalleExistente) {
              detallesActualizados++;
            } else {
              detallesGuardados++;
            }
          });
        });
      });

      console.log(
        `[PedidosSyncTask] Pedidos: ${registrosGuardados} nuevos, ${registrosActualizados} actualizados | Detalles: ${detallesGuardados} nuevos, ${detallesActualizados} actualizados`
      );

      // Notificar pedidos nuevos (evita duplicados con push de central)
      try {
        PedidoNotificacionService.setRealm(this.realm);
        await PedidoNotificacionService.procesarPedidosSincronizados(foliosNuevos);
      } catch (notifError) {
        console.warn("[PedidosSyncTask] Error al notificar pedidos nuevos:", notifError);
      }

      return {
        success: true,
        registrosLeidos: rows.length,
        registrosGuardados,
        registrosActualizados,
        detalles: {
          detallesGuardados,
          detallesActualizados,
          pedidosUnicos: pedidosMap.size,
        },
      };
    } catch (error) {
      console.error("[PedidosSyncTask] Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }

  private getClienteNombre(idCliente: number): string {
    try {
      const cliente = this.realm.objectForPrimaryKey("ClienteFull", idCliente) as any;
      return cliente?.nombre || `Cliente #${idCliente}`;
    } catch {
      return `Cliente #${idCliente}`;
    }
  }

  private getClienteDomicilio(idCliente: number): string {
    try {
      const cliente = this.realm.objectForPrimaryKey("ClienteFull", idCliente) as any;
      return cliente?.domicilio || "";
    } catch {
      return "";
    }
  }

  private getEstatusDescripcion(estatus: number): string {
    try {
      const catalogo = this.realm.objectForPrimaryKey("CatalogoEstatusPedido", estatus) as any;
      return catalogo?.descripcion || "Desconocido";
    } catch {
      return "Desconocido";
    }
  }

  private getCausaDiferenciaDescripcion(id: number): string {
    try {
      const catalogo = this.realm.objectForPrimaryKey("CatalogoCausaDiferencia", id) as any;
      return catalogo?.descripcion || "";
    } catch {
      return "";
    }
  }
}
