

import Realm from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";
import PedidoNotificacionService from "../../PedidoNotificacionService";
import AuthService from "../../AuthService";

const ESTATUS_PEDIDO_EN_ATENCION = 5;
const ESTATUS_PEDIDO_EN_CAPTURA = 10;
const ESTADOS_PEDIDO_FINALES = [2, 6, 7, 9];

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

  private buildPedidoId(folio: number, idProducto: number): string {
    return `${folio}-${idProducto}`;
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      console.log("[PedidosSyncTask] === INICIANDO EJECUCION ===");

      let ruta = 0;
      const idUsuario = (this as any).idUsuario as number | undefined;
      console.log(`[PedidosSyncTask] idUsuario recibido del orquestador: ${idUsuario ?? "no definido"}`);

      // 1. Buscar usuario por idUsuario del orquestador
      if (idUsuario) {
        const usuarioActual = this.realm.objectForPrimaryKey("Usuario", idUsuario) as any;
        if (usuarioActual?.ruta) {
          ruta = parseInt(String(usuarioActual.ruta));
          console.log(`[PedidosSyncTask] Ruta obtenida del usuario actual (id=${idUsuario}): ${ruta}`);
        }
      }

      // 2. Fallback: AuthService
      if (!ruta || ruta === 0) {
        try {
          const sessionUser = await AuthService.restoreSession();
          if (sessionUser?.ruta) {
            ruta = parseInt(String(sessionUser.ruta));
            console.log(`[PedidosSyncTask] Ruta obtenida de sesion: ${ruta}`);
          }
        } catch (authError) {
          console.warn("[PedidosSyncTask] Error obteniendo sesion:", authError);
        }
      }

      // 3. Fallback final: buscar algun usuario con ruta en Realm
      if (!ruta || ruta === 0) {
        const usuariosConRuta = this.realm.objects("Usuario").filtered("ruta != null && ruta != \"\"");
        if (usuariosConRuta.length > 0) {
          const user = usuariosConRuta[0] as any;
          ruta = parseInt(user.ruta);
          console.log(`[PedidosSyncTask] Ruta obtenida de Realm (fallback): ${ruta}`);
        }
      }

      if (!ruta || ruta === 0) {
        console.error(`[PedidosSyncTask] Usuario sin ruta asignada, omitiendo sincronizacion`);
        return {
          success: true,
          registrosLeidos: 0,
          registrosGuardados: 0,
          error: "Usuario sin ruta asignada",
        };
      }

      const endpoint = `${this.getEndpoint()}/${ruta}`;
      console.log(`[PedidosSyncTask] Endpoint: ${endpoint}`);

      const response = await this.fetchWithTimeout(endpoint, {
        headers: { accept: "application/json" },
      });

      console.log(`[PedidosSyncTask] Respuesta HTTP: ${response.status}`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const rows = await response.json();
      console.log(`[PedidosSyncTask] JSON recibido, tipo: ${typeof rows}, es array: ${Array.isArray(rows)}, length: ${Array.isArray(rows) ? rows.length : "N/A"}`);
      console.log("[PedidosSyncTask] Datos completos recibidos:", JSON.stringify(rows, null, 2));

      if (!Array.isArray(rows)) {
        throw new Error("La respuesta no es un array de pedidos");
      }

      console.log(`[PedidosSyncTask] Recibidos ${rows.length} renglones`);

      let registrosGuardados = 0;
      let registrosActualizados = 0;
      const foliosNuevos = new Set<number>();

      this.realm.write(() => {
        rows.forEach((row: any) => {
          const folio = row.folio;
          const idProducto = row.idProducto;
          const id = this.buildPedidoId(folio, idProducto);
          const pedidoExistente = this.realm.objectForPrimaryKey("Pedido", id) as any;

          const estatusServidor = Number(row.estatus);
          const conservarLocal =
            pedidoExistente?.modificadoLocal === true &&
            [ESTATUS_PEDIDO_EN_ATENCION, ESTATUS_PEDIDO_EN_CAPTURA].includes(Number(pedidoExistente.estatus)) &&
            !ESTADOS_PEDIDO_FINALES.includes(estatusServidor);
          const estatusFinal = conservarLocal ? pedidoExistente.estatus : estatusServidor;
          const fechaAtencionFinal = conservarLocal ? pedidoExistente.fechaAtencion : null;
          const causaNoAtencionFinal = conservarLocal ? pedidoExistente.causaNoAtencion : null;
          const obserNoAtencionFinal = conservarLocal ? pedidoExistente.obserNoAtencion : null;

          const clienteNombre =
            row.nombreCliente ?? row.clienteNombre ?? row.nombre_cliente ?? `Cliente #${row.cliente}`;
          const clienteDomicilio =
            row.clienteDomicilio ?? row.domicilioCliente ?? row.domicilio ?? "";
          const producto = this.realm.objectForPrimaryKey("Producto", idProducto) as any;
          const productoNombre = producto?.descripcion || `Producto #${idProducto}`;
          const cantPedido = parseFloat(row.cantPedido) || 0;
          const cantAtencionFinal = pedidoExistente?.cantAtencion ?? null;
          const tieneDiferencia =
            cantAtencionFinal !== null && cantAtencionFinal !== undefined && cantAtencionFinal < cantPedido;

          this.realm.create(
            "Pedido",
            {
              id,
              idPedido: folio,
              id_movil: pedidoExistente?.id_movil ?? null,
              folio,
              fecha: row.fecha ? new Date(row.fecha) : null,
              ruta: row.ruta,
              cliente: row.cliente,
              clienteNombre,
              clienteDomicilio,
              idCanal: null,
              fechaAtencion: fechaAtencionFinal,
              idVendedor: row.idVendedor,
              numeroProductos: row.numeroProductos ?? 1,
              cantPedido,
              listaPrecio: row.listaPrecio,
              fechaEntrega: row.fechaEntrega ? new Date(row.fechaEntrega) : null,
              estatus: estatusFinal,
              estatusDescripcion: this.getEstatusDescripcion(estatusFinal),
              fueraAgenda: row.fueraAgenda,
              observaciones: row.observaciones,
              no_venta: row.noVenta,
              tieneDiferencia,
              causaNoAtencion: causaNoAtencionFinal,
              obserNoAtencion: obserNoAtencionFinal,
              syncedAt: new Date(),
              syncedAr: null,
              modificadoLocal: pedidoExistente?.modificadoLocal ?? false,
              idProducto,
              productoNombre,
              cantAtencion: cantAtencionFinal,
              precio: row.precio ?? null,
              precioAtencion: pedidoExistente?.precioAtencion ?? null,
              causaDiferencia: pedidoExistente?.causaDiferencia ?? null,
              causaDiferenciaDesc: pedidoExistente?.causaDiferencia
                ? this.getCausaDiferenciaDescripcion(pedidoExistente.causaDiferencia)
                : null,
              obserDiferencia: pedidoExistente?.obserDiferencia ?? null,
              atendido: cantAtencionFinal !== null && cantAtencionFinal !== undefined && cantAtencionFinal > 0,
            },
            Realm.UpdateMode.Modified
          );

          if (pedidoExistente) {
            registrosActualizados++;
          } else {
            registrosGuardados++;
            foliosNuevos.add(folio);
          }
        });
      });

      console.log(
        `[PedidosSyncTask] Pedidos: ${registrosGuardados} nuevos, ${registrosActualizados} actualizados`
      );

      // Verificacion post-guardado
      const pedidosGuardados = this.realm.objects("Pedido").length;
      console.log(`[PedidosSyncTask] Post-guardado: ${pedidosGuardados} renglones en Realm`);

      // Notificar pedidos nuevos (evita duplicados con push de central)
      try {
        PedidoNotificacionService.setRealm(this.realm);
        await PedidoNotificacionService.procesarPedidosSincronizados(Array.from(foliosNuevos));
      } catch (notifError) {
        console.warn("[PedidosSyncTask] Error al notificar pedidos nuevos:", notifError);
      }

      console.log("[PedidosSyncTask] === EJECUCION COMPLETADA ===");

      return {
        success: true,
        registrosLeidos: rows.length,
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
