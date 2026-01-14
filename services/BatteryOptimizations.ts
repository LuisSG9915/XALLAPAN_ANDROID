import { Alert, Linking, Platform, AppState, NativeModules, Settings } from "react-native";

const { BatteryOptimization } = NativeModules;

/**
 * Servicio para manejar optimizaciones de batería y permisos especiales
 * necesarios para que la sincronización en segundo plano sea robusta.
 */
class BatteryOptimizations {
  /**
   * Ejecuta directamente la solicitud del sistema para ignorar optimizaciones de batería.
   * Esto evitará el cierre automático por el sistema operativo.
   */
  async requestDisableBatteryOptimizations(): Promise<void> {
    if (Platform.OS !== "android") return;

    try {
      // Usar módulo nativo para lanzar ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
      const result = await BatteryOptimization.requestIgnoreBatteryOptimizations();
      console.log("[BatteryOptimizations] Resultado nativo:", result);

      if (result === "ALREADY_IGNORED") {
        console.log("Ya está optimizado, no se requiere acción.");
        // 2. Request Overlay Permission (Display over other apps) - Required for Android 10+ background start
        if (Platform.Version >= 23) {
          try {
            const hasOverlayPermission = await BatteryOptimization.checkOverlayPermission();
            if (!hasOverlayPermission) {
              Alert.alert(
                "Permiso Requerido",
                "Para que la aplicación pueda abrirse automáticamente si se detiene, necesita el permiso de 'Mostrar sobre otras apps'.",
                [
                  {
                    text: "Ir a Configuración",
                    onPress: async () => {
                      await BatteryOptimization.requestOverlayPermission();
                    },
                  },
                  { text: "Cancelar", style: "cancel" },
                ]
              );
            }
          } catch (err) {
            console.warn("[BatteryOptimizations] Error checking overlay permission:", err);
          }
        }
      }
    } catch (error) {
      console.warn("[BatteryOptimizations] Falló módulo nativo, usando fallback.", error);
      // Fallback silencioso o log
      // No mostramos alert para no bloquear flujo, a menos que sea crítico
    }
  }

  /**
   * Intenta abrir la aplicación si está en segundo plano.
   * Requiere configuración de esquema URL en AndroidManifest (xallapan://)
   */
  async openApp(): Promise<void> {
    if (AppState.currentState === "active") return;

    try {
      console.log("[BatteryOptimizations] Intentando traer la app al frente...");

      const canOpen = await Linking.canOpenURL("xallapan://open");
      if (canOpen) {
        await Linking.openURL("xallapan://open");
      }
    } catch (error) {
      console.error("[BatteryOptimizations] Error al abrir la app:", error);
    }
  }
}

export default new BatteryOptimizations();
