/**
 * Timeout por defecto para cualquier petición de red (20 segundos).
 * Si una petición tarda más que esto, se cancela (abort) y se explica el motivo.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Error lanzado cuando una petición se cancela por exceder el tiempo límite.
 * Incluye un mensaje claro y banderas para diferenciarlo de otros errores.
 */
export class TimeoutError extends Error {
  public readonly isTimeout = true;
  public readonly url: string;
  public readonly timeoutMs: number;
  public readonly elapsedMs: number;

  constructor(url: string, timeoutMs: number, elapsedMs: number) {
    const segundos = Math.round(timeoutMs / 1000);
    super(
      `Tiempo de espera agotado (${segundos}s): la petición se canceló porque tardó demasiado. ` +
        `Probablemente la conexión es muy lenta o el servidor no respondió a tiempo. ` +
        `(URL: ${url})`,
    );
    this.name = "TimeoutError";
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.elapsedMs = elapsedMs;
  }
}

/**
 * Indica si un error corresponde a un timeout/abort generado por fetchWithTimeout.
 */
export function isTimeoutError(error: unknown): error is TimeoutError {
  return (
    error instanceof TimeoutError ||
    (typeof error === "object" && error !== null && (error as any).isTimeout === true)
  );
}

/**
 * Envoltura de fetch que cancela la petición si excede `timeoutMs` usando AbortController.
 * Mantiene la misma firma que fetch (url, init), por lo que es un reemplazo directo.
 *
 * @param input URL del recurso.
 * @param init Opciones de fetch (method, headers, body, etc.).
 * @param timeoutMs Tiempo máximo en ms antes de cancelar. Por defecto 20000 (20 s).
 * @throws {TimeoutError} si la petición supera el tiempo límite.
 */
export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const start = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error: any) {
    // Si abortamos nosotros por timeout, traducir a un error claro.
    if (controller.signal.aborted || error?.name === "AbortError") {
      throw new TimeoutError(input, timeoutMs, Date.now() - start);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
