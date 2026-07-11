import Realm, { UpdateMode } from "realm";
import { SyncTask, SyncTaskResult } from "../SyncTask";
import { UsuarioSchema } from "../../RealmSchemas";

function toStringOrNull(value: any): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

/**
 * Tarea de sincronización para la tabla Usuarios
 */
export class UsuariosSyncTask extends SyncTask {
  getTableName(): string {
    return "Usuarios";
  }

  getEndpoint(): string {
    return "https://api.cbinformatica.net:9031/api/MovilesVentas/usuarios/full";
  }

  getPriority(): number {
    return 1; // Alta prioridad - usuarios primero
  }

  getDependencies(): string[] {
    return []; // Sin dependencias
  }

  async execute(): Promise<SyncTaskResult> {
    try {
      console.log("[UsuariosSyncTask] Obteniendo usuarios desde API...");

      const response = await this.fetchWithTimeout(this.getEndpoint());
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const usuarios = await response.json();
      console.log({ usuarios });
      const registrosLeidos = usuarios.length;
      const nowMexico = this.getMexicoNow();
      let registrosGuardados = 0;
      let registrosActualizados = 0;

      console.log(`[UsuariosSyncTask] Leídos ${registrosLeidos} usuarios`);

      // Sincronizar con Realm
      this.realm.write(() => {
        for (const usuario of usuarios) {
          const existing = this.realm.objectForPrimaryKey("Usuario", usuario.id);

          const usuarioData: any = {
            id: usuario.id,
            nombre: toStringOrNull(usuario.nombre),
            perfil: usuario.perfil ?? null,
            descripcionPerfil: toStringOrNull(usuario.descripcionPerfil),
            puesto: usuario.puesto ?? null,
            descripcionPuesto: toStringOrNull(usuario.descripcionPuesto),
            claveEmpleado: toStringOrNull(usuario.claveEmpleado),
            password: toStringOrNull(usuario.password),
            ruta: toStringOrNull(usuario.sucursal_origen ?? usuario.sucursalOrigen),
            sucursalOrigen: usuario.sucursal_origen ?? usuario.sucursalOrigen ?? null,
            sucursalNombre: toStringOrNull(usuario.sucursal_nombre ?? usuario.sucursalNombre),
            metros: usuario.metros ?? null,
            reubicacion:
              typeof usuario.reubicacion === "boolean"
                ? usuario.reubicacion
                : usuario.reubicacion === 1
                ? true
                : usuario.reubicacion === 0
                ? false
                : null,
            rfc: toStringOrNull(usuario.rfc),
            domicilio: toStringOrNull(usuario.domicilio),
            regimenFiscal: toStringOrNull(usuario.regimenFiscal),
            nombreCia: toStringOrNull(usuario.nombreCia),
            telefono: toStringOrNull(usuario.telefono),
            ticketFinal: toStringOrNull(usuario.ticketFinal),
            permisoDomicilioTicket:
              typeof usuario.permisoDomicilioTicket === "boolean"
                ? usuario.permisoDomicilioTicket
                : usuario.permisoDomicilioTicket === 1
                ? true
                : usuario.permisoDomicilioTicket === 0
                ? false
                : null,
            dobleTicket:
              typeof usuario.dobleTicket === "boolean"
                ? usuario.dobleTicket
                : usuario.dobleTicket === 1
                ? true
                : usuario.dobleTicket === 0
                ? false
                : null,
            envaseRuta:
              typeof usuario.envaseRuta === "boolean"
                ? usuario.envaseRuta
                : usuario.envaseRuta === 1
                ? true
                : usuario.envaseRuta === 0
                ? false
                : null,
            syncedAt: new Date(),
          };

          if (existing) {
            this.realm.create("Usuario", usuarioData, UpdateMode.Modified);
            registrosActualizados++;
          } else {
            this.realm.create("Usuario", usuarioData);
            registrosGuardados++;
          }
        }
      });

      console.log(`[UsuariosSyncTask] Guardados: ${registrosGuardados}, Actualizados: ${registrosActualizados}`);

      return {
        success: true,
        registrosLeidos,
        registrosGuardados,
        registrosActualizados,
        detalles: {
          totalProcesados: registrosGuardados + registrosActualizados,
        },
      };
    } catch (error) {
      console.error("[UsuariosSyncTask] Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  }
}
