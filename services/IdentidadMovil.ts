import { Platform } from "react-native";
import DeviceInfo from "react-native-device-info";

export interface IdentidadMovil {
  marcaMovil: string | null;
  modeloMovil: string | null;
  idDispositivoMovil: string | null;
}

const LIMITE_CARACTERES = 100;
// ANDROID_ID es un entero de 64 bits en hexadecimal; se aceptan de 1 a 16 dígitos hex.
const PATRON_ANDROID_ID = /^[0-9a-f]{1,16}$/;

const normalizarTexto = (valor: unknown): string | null => {
  if (typeof valor !== "string") return null;
  const limpio = valor.trim();
  if (!limpio || limpio.toLowerCase() === "unknown") return null;
  return limpio.slice(0, LIMITE_CARACTERES);
};

const leerMarca = (): string | null => {
  try {
    return normalizarTexto(DeviceInfo.getBrand());
  } catch {
    return null;
  }
};

const leerModelo = (): string | null => {
  try {
    return normalizarTexto(DeviceInfo.getModel());
  } catch {
    return null;
  }
};

const leerAndroidId = async (): Promise<string | null> => {
  if (Platform.OS !== "android") return null;
  try {
    const id = await DeviceInfo.getAndroidId();
    const limpio = typeof id === "string" ? id.trim().toLowerCase() : "";
    return PATRON_ANDROID_ID.test(limpio) ? limpio : null;
  } catch {
    return null;
  }
};

/**
 * Metadatos del dispositivo que suben la bitácora. Cada campo se lee de forma
 * independiente: un fallo nunca aborta la sincronización y nunca se registra
 * el ID ni se guarda en estado global.
 */
export async function obtenerIdentidadMovil(): Promise<IdentidadMovil> {
  try {
    const [marcaMovil, modeloMovil, idDispositivoMovil] = await Promise.all([
      Promise.resolve().then(leerMarca),
      Promise.resolve().then(leerModelo),
      leerAndroidId(),
    ]);
    return { marcaMovil, modeloMovil, idDispositivoMovil };
  } catch {
    return { marcaMovil: null, modeloMovil: null, idDispositivoMovil: null };
  }
}
