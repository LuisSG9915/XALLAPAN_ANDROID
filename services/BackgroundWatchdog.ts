import BackgroundFetch from "react-native-background-fetch";
import AuthService from "./AuthService";

// Evitar importación cíclica en top-level si es posible, o usar require dentro.
// Pero para tipos, importamos.
// import BackgroundSyncService from "./BackgroundSyncService";

/**
 * BackgroundWatchdog
 *
 * Servicio de respaldo que utiliza el JobScheduler de Android (BackgroundFetch)
 * para despertar la aplicación periódicamente (mínimo cada 15 min) y verificar
 * que el servicio principal (BackgroundSyncService) esté corriendo.
 */
class BackgroundWatchdog {
  /**
   * Configura el comportamiento de BackgroundFetch.
   * Debe llamarse al inicio de la app (App.tsx).
   */
  static async configure() {
    console.log("[BackgroundWatchdog] Configurando...");
    try {
      const status = await BackgroundFetch.configure(
        {
          minimumFetchInterval: 15, // Minutos (mínimo permitido por Android)
          stopOnTerminate: false,
          startOnBoot: true,
          enableHeadless: true,
          forceAlarmManager: false,
          requiredNetworkType: BackgroundFetch.NETWORK_TYPE_ANY,
        },
        async (taskId) => {
          console.log(`[BackgroundWatchdog] 🐶 Despertado (TaskId: ${taskId})`);
          await BackgroundWatchdog.checkAndReviveService();
          BackgroundFetch.finish(taskId);
        },
        (error) => {
          console.error("[BackgroundWatchdog] ❌ Error configuración:", error);
        }
      );

      console.log("[BackgroundWatchdog] Configurado. Status:", status);
    } catch (err) {
      console.error("[BackgroundWatchdog] Excepción en configuración:", err);
    }
  }

  /**
   * Lógica Headless (se ejecuta cuando la app está terminada pero despierta por evento)
   */
  static async headlessTask(event: any) {
    // En v4, event puede ser un objeto con taskId o directamente el taskId dependiendo de la config
    // Pero registerHeadlessTask pasa el evento.
    const taskId = event.taskId || event;
    console.log(`[BackgroundWatchdog] 💀 Headless Task iniciado: ${taskId}`);

    await BackgroundWatchdog.checkAndReviveService();

    BackgroundFetch.finish(taskId);
  }

  /**
   * Verifica si el servicio principal está corriendo y lo reinicia si es necesario
   */
  static async checkAndReviveService() {
    try {
      // Lazy load para evitar ciclos
      const BackgroundSyncService = require("./BackgroundSyncService").default;

      const isRunning = BackgroundSyncService.isActive();
      console.log(`[BackgroundWatchdog] Estado del servicio principal: ${isRunning ? "ACTIVO ✅" : "INACTIVO ❌"}`);

      if (!isRunning) {
        console.log("[BackgroundWatchdog] 🚑 Intentando revivir servicio principal...");

        // Verificar si hay usuario logueado antes de iniciar
        const user = await AuthService.restoreSession();
        if (user) {
          await BackgroundSyncService.start();
          console.log("[BackgroundWatchdog] ✅ Servicio revivido exitosamente");
        } else {
          console.log("[BackgroundWatchdog] ⚠️ No hay sesión, no se puede iniciar servicio.");
        }
      }
    } catch (error) {
      console.error("[BackgroundWatchdog] Error al revivir servicio:", error);
    }
  }
}

export default BackgroundWatchdog;
