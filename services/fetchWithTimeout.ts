/**
 * Timeout por defecto para cualquier petición de red (20 segundos).
 * Si una petición tarda más que esto, se cancela (abort) y se explica el motivo.
 */
import NetworkUsageService, { normalizeEndpoint } from "./NetworkUsageService";

export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

const estimateUtf8Bytes = (text: string): number => {
  try {
    return unescape(encodeURIComponent(text)).length;
  } catch {
    return text.length;
  }
};

const estimateRequestBytes = (body: RequestInit["body"]): number =>
  typeof body === "string" ? estimateUtf8Bytes(body) : 0;

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
  const method = String(init.method || "GET").toUpperCase();
  const bytesSent = estimateRequestBytes(init.body);
  const externalSignal = init.signal;
  const abortFromCaller = () => controller.abort();

  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = new Headers(init.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");

    const response = await fetch(input, {
      ...init,
      headers,
      signal: controller.signal,
    });
    const contentLength = Number(response.headers.get("content-length"));
    const requestId = NetworkUsageService.recordRequest({
      url: input,
      method,
      status: response.status,
      bytesReceived: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0,
      bytesSent,
      durationMs: Date.now() - start,
      success: response.ok,
    });

    const originalText = response.text.bind(response);
    let bodyTextPromise: Promise<string> | null = null;
    let bodyMeasured = false;
    const readBodyText = async (): Promise<string> => {
      if (!bodyTextPromise) bodyTextPromise = originalText();
      const text = await bodyTextPromise;
      if (!bodyMeasured) {
        bodyMeasured = true;
        NetworkUsageService.recordResponseBody(requestId, estimateUtf8Bytes(text));
      }
      return text;
    };

    const trackedResponse = response as Response & {
      text: () => Promise<string>;
      json: () => Promise<unknown>;
    };
    trackedResponse.text = readBodyText;
    trackedResponse.json = async () => {
      const text = await readBodyText();
      const jsonText = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
      try {
        return JSON.parse(jsonText);
      } catch (parseError) {
        const contentType = response.headers.get("content-type") || "desconocido";
        const firstCharacter = jsonText.trimStart().slice(0, 1) || "<vacío>";
        throw new Error(
          `Respuesta JSON inválida en ${normalizeEndpoint(input)} (HTTP ${response.status}, Content-Type: ${contentType}, primer carácter: ${JSON.stringify(firstCharacter)}): ${
            parseError instanceof Error ? parseError.message : "error de parseo"
          }`,
        );
      }
    };
    return trackedResponse;
  } catch (error: any) {
    // Si abortamos nosotros por timeout, traducir a un error claro.
    const timedOut = controller.signal.aborted || error?.name === "AbortError";
    const finalError = timedOut
      ? new TimeoutError(input, timeoutMs, Date.now() - start)
      : error;
    NetworkUsageService.recordRequest({
      url: input,
      method,
      bytesSent,
      durationMs: Date.now() - start,
      success: false,
      timedOut,
    });
    throw finalError;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
}
