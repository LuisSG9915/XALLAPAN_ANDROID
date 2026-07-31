import Realm from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";

export class PedidoBitacoraUploadSyncTask extends SyncTask {
  constructor(realm: Realm, syncLogId: string) {
    super(realm, syncLogId);
  }

  getTableName(): string {
    return "PedidoBitacoraUpload";
  }

  getEndpoint(): string {
    return "https://api.cbinformatica.net:9031/api/MovilesVentas/sp_MovilesPedidosBitacora_Insert";
  }

  getPriority(): number {
    return 1;
  }

  getDependencies(): string[] {
    return [];
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      console.log(`[PedidoBitacoraUpload] Enviando bitácora de pedidos pendiente...`);

      const bitacoras = this.realm.objects("PedidoBitacora").filtered("enviado = false");

      if (bitacoras.length === 0) {
        console.log(`[PedidoBitacoraUpload] No hay bitácoras pendientes`);
        return {
          success: true,
          registrosLeidos: 0,
          registrosGuardados: 0,
        };
      }

      console.log(`[PedidoBitacoraUpload] ${bitacoras.length} bitácoras pendientes de enviar`);

      let enviados = 0;
      let fallidos = 0;
      const idsEnviados: string[] = [];

      for (const bitacora of bitacoras) {
        const b = bitacora as any;
        try {
          const payload = {
            id_pedido: b.idPedido,
            id_movil: parseInt(b.id.split("-")[0]) || 0,
            folio: b.folio,
            fecha: b.fecha.toISOString(),
            ruta: b.ruta,
            cliente: b.cliente,
            idVendedor: b.idVendedor,
            idProducto: b.idProducto,
            cantPedido: b.cantPedido,
            precio: null,
            observaciones: null,
            listaPrecio: null,
            fechaEntrega: null,
            estatus: b.estatus,
            cantAtencion: b.cantAtencion,
            precioAtencion: null,
            causaDiferencia: b.causaDiferencia,
            obserDiferencia: b.obserDiferencia,
            causaNoAtencion: b.causaNoAtencion,
            obserNoAtencion: b.obserNoAtencion,
            usrAlta: b.idVendedor,
            fueraAgenda: null,
            no_venta: null,
            fecha_movil: b.fecha.toISOString(),
            estatus_anterior: b.estatusAnterior,
            tipo_cambio: b.tipoCambio,
          };

          const response = await this.fetchWithTimeout(this.getEndpoint(), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify(payload),
          });

          if (response.ok) {
            enviados++;
            idsEnviados.push(b.id);
          } else {
            fallidos++;
            console.warn(`[PedidoBitacoraUpload] Error enviando bitácora ${b.id}: HTTP ${response.status}`);
          }
        } catch (error) {
          fallidos++;
          console.warn(`[PedidoBitacoraUpload] Error enviando bitácora ${b.id}:`, error);
        }
      }

      if (idsEnviados.length > 0) {
        this.realm.write(() => {
          idsEnviados.forEach((id) => {
            const bitacora = this.realm.objectForPrimaryKey("PedidoBitacora", id) as any;
            if (bitacora) {
              bitacora.enviado = true;
            }
          });
        });
      }

      console.log(`[PedidoBitacoraUpload] Enviados: ${enviados}, Fallidos: ${fallidos}`);

      return {
        success: fallidos === 0,
        registrosLeidos: bitacoras.length,
        registrosGuardados: enviados,
        error: fallidos > 0 ? `${fallidos} bitácoras no se pudieron enviar` : undefined,
      };
    } catch (error) {
      console.error("[PedidoBitacoraUpload] Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }
}
