/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import BackgroundGeolocation from 'react-native-background-geolocation';
import { HeadlessLocationTask } from './services/BackgroundLocationService';

BackgroundGeolocation.registerHeadlessTask(HeadlessLocationTask);
AppRegistry.registerComponent(appName, () => App);
