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
      let endpointNoDisponible = false;
      const idsEnviados: string[] = [];

      for (const bitacora of bitacoras) {
        const b = bitacora as any;
        try {
          const payload = {
            id_pedido: b.idPedido,
            id_movil: b.id_movil ?? null,
            folio: b.folio,
            fecha: b.fecha ? new Date(b.fecha).toISOString() : null,
            ruta: b.ruta,
            fechaAtencion: b.fechaAtencion ? new Date(b.fechaAtencion).toISOString() : null,
            idVendedor: b.idVendedor,
            idProducto: b.idProducto ?? null,
            precio: b.precio ?? null,
            estatus: b.estatus,
            estatus_anterior: b.estatusAnterior ?? null,
            cantAtencion: b.cantAtencion ?? null,
            precioAtencion: b.precioAtencion ?? null,
            causaDiferencia: b.causaDiferencia ?? null,
            obserDiferencia: b.obserDiferencia ?? null,
            causaNoAtencion: b.causaNoAtencion ?? null,
            obserNoAtencion: b.obserNoAtencion ?? null,
            no_venta: b.no_venta ?? null,
            tipo_cambio: b.tipoCambio ?? null,
          };

          console.log(`[PedidoBitacoraUpload] Enviando bitácora ${b.id}:`, JSON.stringify(payload));

          const response = await this.fetchWithTimeout(this.getEndpoint(), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify(payload),
          });

          if (response.status === 404) {
            endpointNoDisponible = true;
            console.warn(`[PedidoBitacoraUpload] Endpoint no disponible (404), se omitirá el envío de bitácoras`);
            break;
          }

          if (response.ok) {
            const responseText = await response.text();
            console.log(`[PedidoBitacoraUpload] Bitácora ${b.id} enviada. Respuesta:`, responseText);
            enviados++;
            idsEnviados.push(b.id);
          } else {
            fallidos++;
            const errorText = await response.text().catch(() => "");
            console.warn(`[PedidoBitacoraUpload] Error enviando bitácora ${b.id}: HTTP ${response.status} - ${errorText}`);
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

      if (endpointNoDisponible) {
        return {
          success: true,
          registrosLeidos: bitacoras.length,
          registrosGuardados: 0,
          error: "Endpoint de bitácora no disponible (404), se intentará en la próxima sincronización",
        };
      }

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
