/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import BackgroundFetch from "react-native-background-fetch";
import FcmService from "./services/FcmService";
import { PedidoNotificacionService } from "./services/PedidoNotificacionService";

AppRegistry.registerComponent(appName, () => App);

FcmService.registrarHandlerBackground();

// Registra el handler de notificaciones en background (requerido por Notifee)
PedidoNotificacionService.registrarBackgroundHandler();

/**
 * HeadlessTask para BackgroundFetch.
 * Se ejecuta cuando la app está en segundo plano o cerrada,
 * y el sistema operativo despierta la app para sincronizar.
 * 
 * NOTA: react-native-background-actions v4 maneja su propio
 * contexto headless a través del foreground service, por lo que
 * no necesita un HeadlessTask separado en index.js.
 */
const HeadlessSyncTask = async (event) => {
  const taskId = event.taskId;
  console.log("[HeadlessSyncTask] Recibida tarea de BackgroundFetch:", taskId);

  try {
    const BackgroundSyncService = require("./services/BackgroundSyncService").default;
    await BackgroundSyncService.performHeadlessSync(taskId);
  } catch (error) {
    console.error("[HeadlessSyncTask] Error:", error?.message || error);
    BackgroundFetch.finish(taskId);
  }
};

BackgroundFetch.registerHeadlessTask(HeadlessSyncTask);
