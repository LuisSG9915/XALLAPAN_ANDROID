import { NativeModules } from "react-native";

const { ScreenStateModule } = NativeModules as any;

export type ScreenState = "on" | "off";

/**
 * Obtiene el estado actual de la pantalla del dispositivo.
 * Requiere el módulo nativo ScreenStateModule.
 * Si falla, asume "on" como valor por defecto.
 */
export async function getCurrentScreenState(): Promise<ScreenState> {
  try {
    const state = await ScreenStateModule.getCurrentScreenState();
    return state === "off" ? "off" : "on";
  } catch (error) {
    console.warn("[ScreenState] No se pudo obtener estado de pantalla:", error);
    return "on";
  }
}
