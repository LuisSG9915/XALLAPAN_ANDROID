import Realm from "realm";
import { SyncTableLogSchema } from "../RealmSchemas";
import BitacoraService from "../BitacoraService";
import { fetchWithTimeout, isTimeoutError, DEFAULT_REQUEST_TIMEOUT_MS } from "../fetchWithTimeout";

/**
 * Interfaz para el resultado de una sincronización individual
 */
export interface SyncTaskResult {
  success: boolean;
  error?: string;
  registrosLeidos?: number;
  registrosGuardados?: number;
  registrosActualizados?: number;
  registrosEliminados?: number;
  timedOut?: boolean;
  detalles?: any;
}

/**
 * Interfaz para el progreso de sincronización
 */
export interface SyncProgress {
  current: number;
  total: number;
  entity: string;
  status: "syncing" | "success" | "error";
  message: string;
}

/**
 * Clase base abstracta para tareas de sincronización
 * Implementa el patrón Command para cada tabla
 */
export abstract class SyncTask {
  protected realm: Realm;
  protected syncLogId: string;
  protected sucursal?: number;
  protected idUsuario?: number;

  constructor(realm: Realm, syncLogId: string, sucursal?: number, idUsuario?: number) {
    this.realm = realm;
    this.syncLogId = syncLogId;
    this.sucursal = sucursal;
    this.idUsuario = idUsuario;
  }

  /**
   * Obtiene la fecha/hora actual.
   * El dispositivo ya está en hora de México, no se requiere conversión.
   */
  protected getMexicoNow(): Date {
    return new Date();
  }

  /**
   * Realiza una petición de red que se cancela automáticamente si tarda más de 1 minuto.
   * Reemplazo directo de fetch para todas las tareas de sincronización.
   */
  protected fetchWithTimeout(
    input: string,
    init: RequestInit = {},
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    return fetchWithTimeout(input, init, timeoutMs);
  }

  /**
   * Nombre de la tabla que sincroniza esta tarea
   */
  abstract getTableName(): string;

  /**
   * Endpoint de la API para esta tabla
   */
  abstract getEndpoint(): string;

  /**
   * Prioridad de ejecución (menor número = mayor prioridad)
   */
  abstract getPriority(): number;

  /**
   * Dependencias de esta tarea (nombres de tablas que deben sincronizarse primero)
   */
  abstract getDependencies(): string[];

  /**
   * Ejecuta la sincronización específica de esta tabla
   */
  abstract execute(): Promise<SyncTaskResult>;

  /**
   * Guarda un log detallado de la sincronización de esta tabla
   */
  protected async saveTableLog(result: SyncTaskResult, fechaInicio: Date, fechaFinal: Date): Promise<void> {
    try {
      const duracionMs = fechaFinal.getTime() - fechaInicio.getTime();

      this.realm.write(() => {
        this.realm.create("SyncTableLog", {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          syncLogId: this.syncLogId,
          tabla: this.getTableName(),
          fechaInicio,
          fechaFinal,
          exitoso: result.success,
          razon: result.error || null,
          registrosLeidos: result.registrosLeidos || 0,
          registrosGuardados: result.registrosGuardados || 0,
          registrosActualizados: result.registrosActualizados || 0,
          duracionMs,
          endpoint: this.getEndpoint(),
          detalles: result.detalles ? JSON.stringify(result.detalles) : null,
        });
      });

      console.log(`[${this.getTableName()}] Bitácora guardada:`, {
        exitoso: result.success,
        duracionMs,
        registrosLeidos: result.registrosLeidos,
        registrosGuardados: result.registrosGuardados,
      });
    } catch (error) {
      console.error(`[${this.getTableName()}] Error al guardar bitácora:`, error);
    }
  }

  /**
   * Ejecuta la tarea con retry logic y logging automático
   */
  async executeWithLogging(): Promise<SyncTaskResult> {
    const fechaInicio = new Date();
    console.log(`[${this.getTableName()}] Iniciando sincronización con retry logic...`);

    // Registrar inicio en BitacoraSync
    const idBitacora = await BitacoraService.registrarInicioSync(
      this.getTableName(),
      "full",
      "manual",
      this.idUsuario,
      this.sucursal,
      this.getEndpoint()
    );

    const maxRetries = 3;
    const baseDelay = 1000; // 1 segundo
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          const delay = baseDelay * Math.pow(2, attempt - 2); // Exponential backoff
          console.log(
            `[${this.getTableName()}] Reintentando sincronización (intento ${attempt}/${maxRetries}) después de ${delay}ms...`
          );
          await new Promise<void>((resolve) => setTimeout(() => resolve(), delay));
        }

        const result = await this.execute();
        const fechaFinal = new Date();

        await this.saveTableLog(result, fechaInicio, fechaFinal);

        // Registrar fin en BitacoraSync
        await BitacoraService.registrarFinSync(idBitacora, {
          exitoso: result.success,
          registrosLeidos: result.registrosLeidos,
          error: result.error,
        });

        console.log(`[${this.getTableName()}] Sincronización completada:`, {
          success: result.success,
          duracionMs: fechaFinal.getTime() - fechaInicio.getTime(),
          intentos: attempt,
        });

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("Error desconocido");
        const noReintentable = this.isNonRetryable(lastError);
        console.error(
          `[${this.getTableName()}] Intento ${attempt}/${maxRetries} fallido${noReintentable ? " (no reintentable)" : ""}:`,
          lastError.message,
        );

        // No reintentar timeouts (>1 min) ni errores 4xx: reintentarlos no ayuda y solo alarga la espera.
        if (attempt === maxRetries || noReintentable) {
          const fechaFinal = new Date();
          const esTimeout = isTimeoutError(lastError);
          const errorResult: SyncTaskResult = {
            success: false,
            error: lastError.message,
            timedOut: esTimeout,
            detalles: {
              intentos: attempt,
              ultimoError: lastError.message,
              esErrorDeRed: this.isNetworkError(lastError),
              esTimeout,
              noReintentable,
            },
          };

          await this.saveTableLog(errorResult, fechaInicio, fechaFinal);

          // Registrar error en BitacoraSync
          await BitacoraService.registrarFinSync(idBitacora, {
            exitoso: false,
            error: lastError.message,
            errorCode: esTimeout ? "TIMEOUT" : "500",
          });

          console.error(
            `[${this.getTableName()}] Sincronización fallida (${attempt} intento(s)):`,
            lastError.message,
          );
          return errorResult;
        }
      }
    }

    // Este código nunca debería ejecutarse, pero TypeScript lo requiere
    const errorResult: SyncTaskResult = {
      success: false,
      error: lastError?.message || "Error desconocido",
    };
    return errorResult;
  }

  /**
   * Determina si un error NO debe reintentarse: timeouts (ya esperó el máximo)
   * y errores de validación/cliente 4xx (reintentar daría el mismo resultado).
   */
  private isNonRetryable(error: Error): boolean {
    if (isTimeoutError(error)) {
      return true;
    }
    // HTTP 400-499
    return /HTTP 4\d\d/i.test(error.message);
  }

  /**
   * Determina si un error es de red para retry logic
   */
  private isNetworkError(error: Error): boolean {
    const networkErrorMessages = [
      "network",
      "timeout",
      "connection",
      "fetch",
      "ECONNRESET",
      "ENOTFOUND",
      "ETIMEDOUT",
      "HTTP 5",
    ];

    return networkErrorMessages.some((msg) => error.message.toLowerCase().includes(msg.toLowerCase()));
  }
}
