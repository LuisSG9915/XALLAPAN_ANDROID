import GpsBitacoraService from "./GpsBitacoraService";
import { calcularDistancia } from "./LocationService";

/**
 * Bitácora de intentos FALLIDOS de reubicación.
 *
 * Una reubicación exitosa se guarda en `tempreubicacionesmovil`. Los intentos
 * que no llegan a guardarse (sin permiso, sin lectura GPS, precisión
 * insuficiente, rechazo del servidor o excepción) antes solo quedaban en un
 * `Alert` para el vendedor: no había forma de saber cuántos ni por qué.
 *
 * Se reutiliza la tabla `BitacoraValidacion` (la misma que alimenta
 * `BitacoraValidacionUbicacionMovil`) en lugar de crear una nueva, para no
 * tocar el contrato del servidor. Los motivos llevan el prefijo `reubic_` para
 * poder separarlos de las validaciones normales en cualquier consulta:
 *
 *   motivo                 | cuándo
 *   -----------------------|--------------------------------------------------
 *   reubic_sin_permiso     | el vendedor ya usó su permiso del día
 *   reubic_sin_gps         | no se obtuvo ninguna lectura
 *   reubic_precision       | lectura con accuracy > 25 m o menos de 3 fixes
 *   reubic_rechazo         | el servicio no registró la reubicación
 *   reubic_error           | excepción durante el proceso
 *
 * Todos se escriben con `valido = false`. La columna `motivo` del servidor es
 * varchar(20): los cinco valores caben.
 */
export type MotivoReubicacionFallida =
  | "reubic_sin_permiso"
  | "reubic_sin_gps"
  | "reubic_precision"
  | "reubic_rechazo"
  | "reubic_error";

export type IntentoReubicacionFallido = {
  idCliente?: number | null;
  clienteLatitud?: number | null;
  clienteLongitud?: number | null;
  ubicacion?: { latitude: number; longitude: number; accuracy?: number | null } | null;
  diagnostico?: { numFixes?: number | null; peorAccuracy?: number | null; tiempoMs?: number | null } | null;
};

/**
 * Registra un intento fallido. Nunca lanza: el vendedor no debe ver un error
 * por un fallo de la bitácora.
 */
export async function registrarReubicacionFallida(
  motivo: MotivoReubicacionFallida,
  intento: IntentoReubicacionFallido = {},
): Promise<void> {
  try {
    const { ubicacion, diagnostico, clienteLatitud, clienteLongitud } = intento;

    const distancia =
      ubicacion && typeof clienteLatitud === "number" && typeof clienteLongitud === "number"
        ? calcularDistancia(ubicacion.latitude, ubicacion.longitude, clienteLatitud, clienteLongitud)
        : null;

    await GpsBitacoraService.registrarValidacion({
      idCliente: intento.idCliente ?? null,
      motivo,
      valido: false,
      distancia,
      accuracy: ubicacion?.accuracy ?? null,
      metrosPermitidos: null,
      latitud: ubicacion?.latitude ?? null,
      longitud: ubicacion?.longitude ?? null,
      clienteLatitud: clienteLatitud ?? null,
      clienteLongitud: clienteLongitud ?? null,
      numFixes: diagnostico?.numFixes ?? null,
      peorAccuracy: diagnostico?.peorAccuracy ?? null,
      tiempoMs: diagnostico?.tiempoMs ?? null,
      conCobertura: null,
    });
  } catch (error) {
    console.warn("[ReubicacionBitacora] No se pudo registrar el intento fallido:", error);
  }
}

export default { registrarReubicacionFallida };
