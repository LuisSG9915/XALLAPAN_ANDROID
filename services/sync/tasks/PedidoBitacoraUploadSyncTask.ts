import Realm from "realm";
import AuthService from "../../AuthService";
import { SyncTask, SyncTaskResult } from "../SyncTask";

const ESTADOS_CIERRE = [2, 6, 7];

const formatDate = (date?: Date | null): string | null => {
  if (!date) return null;
  const value = new Date(date);
  const pad = (number: number): string => String(number).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
};

export class PedidoBitacoraUploadSyncTask extends SyncTask {
  constructor(realm: Realm, syncLogId: string) {
    super(realm, syncLogId);
  }

  getTableName(): string {
    return "PedidoBitacoraUpload";
  }

  getEndpoint(): string {
    return "https://api.cbinformatica.net:9031/api/MovilesVentas/sp_DetallePedidosBitacoraArrastreJSON";
  }

  getPriority(): number {
    return 1;
  }

  getDependencies(): string[] {
    return [];
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      const user = await AuthService.restoreSession();
      const idUsuario = Number(user?.id ?? user?.idUsuario ?? 0);
      // No se filtra por idVendedor: la bitácora guarda el vendedor asignado al pedido,
      // que puede ser distinto del usuario que lo cierra en este dispositivo.
      const bitacoras = Array.from(
        this.realm.objects("PedidoBitacora").filtered(
          "enviado = false AND (estatus == $0 OR estatus == $1 OR estatus == $2)",
          ...ESTADOS_CIERRE,
        ),
      ) as any[];
      if (bitacoras.length === 0) {
        return { success: true, registrosLeidos: 0, registrosGuardados: 0 };
      }

      const payload = bitacoras.map((bitacora: any) => ({
        id_pedido: Number(bitacora.idPedido ?? bitacora.folio),
        id_movil: bitacora.id_movil ?? null,
        folio: Number(bitacora.folio),
        fecha: formatDate(bitacora.fecha),
        ruta: bitacora.ruta,
        cliente: bitacora.cliente,
        fechaAtencion: formatDate(bitacora.fechaAtencion),
        idVendedor: bitacora.idVendedor,
        idProducto: bitacora.idProducto ?? null,
        precio: bitacora.precio ?? null,
        estatus: bitacora.estatus,
        estatus_anterior: bitacora.estatusAnterior ?? null,
        cantAtencion: bitacora.cantAtencion ?? null,
        precioAtencion: bitacora.precioAtencion ?? null,
        observaciones: bitacora.observaciones ?? null,
        causaDiferencia: bitacora.causaDiferencia ?? null,
        obserDiferencia: bitacora.obserDiferencia ?? null,
        causaNoAtencion: bitacora.causaNoAtencion ?? null,
        obserNoAtencion: bitacora.obserNoAtencion ?? null,
        no_venta: bitacora.no_venta ?? null,
        tipo_cambio: bitacora.tipoCambio ?? null,
        enviado: 1,
        fecha_envio: formatDate(new Date()),
      }));
      const response = await this.fetchWithTimeout(`${this.getEndpoint()}?idUsuario=${idUsuario}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        return {
          success: false,
          registrosLeidos: bitacoras.length,
          registrosGuardados: 0,
          error: `HTTP ${response.status}: ${errorText}`,
        };
      }

      this.realm.write(() => {
        bitacoras.forEach((bitacora: any) => {
          bitacora.enviado = true;
        });
      });
      return {
        success: true,
        registrosLeidos: payload.length,
        registrosGuardados: payload.length,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }
}

export class PedidoEstadoUploadSyncTask extends SyncTask {
  constructor(realm: Realm, syncLogId: string) {
    super(realm, syncLogId);
  }

  getTableName(): string {
    return "PedidoEstadoUpload";
  }

  getEndpoint(): string {
    return "https://api.cbinformatica.net:9031/api/MovilesVentas/sp_DetallePedidosEstadosArrastreJSON";
  }

  getPriority(): number {
    return 1;
  }

  getDependencies(): string[] {
    return [];
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      const user = await AuthService.restoreSession();
      const idUsuario = Number(user?.id ?? user?.idUsuario ?? 0);
      const estados = Array.from(
        this.realm.objects("PedidoEstado").filtered("enviado = false"),
      ) as any[];
      if (estados.length === 0) {
        return {
          success: true,
          registrosLeidos: 0,
          registrosGuardados: 0,
        };
      }
      const payload = Array.from(estados).map((estado: any) => ({
        ruta: Number(estado.ruta),
        pedido: Number(estado.pedido),
        fecha: estado.fecha ? new Date(estado.fecha).toISOString() : null,
        estado: Number(estado.estado),
        idVendedor: Number(estado.idVendedor),
      }));
      const url = `${this.getEndpoint()}?idUsuario=${idUsuario}`;

      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        return {
          success: false,
          registrosLeidos: estados.length,
          registrosGuardados: 0,
          error: `HTTP ${response.status}: ${errorText}`,
        };
      }

      this.realm.write(() => {
        Array.from(estados).forEach((estado: any) => {
          estado.enviado = true;
        });
      });

      return {
        success: true,
        registrosLeidos: payload.length,
        registrosGuardados: payload.length,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }
}
