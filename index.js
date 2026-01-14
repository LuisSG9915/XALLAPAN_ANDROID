/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import BackgroundFetch from "react-native-background-fetch";
import BackgroundWatchdog from './services/BackgroundWatchdog';

// Registrar tarea Headless para cuando la app está terminada (kill)
// Esto permite que BackgroundWatchdog despierte la app y reinicie el servicio
BackgroundFetch.registerHeadlessTask(BackgroundWatchdog.headlessTask);

AppRegistry.registerComponent(appName, () => App);
