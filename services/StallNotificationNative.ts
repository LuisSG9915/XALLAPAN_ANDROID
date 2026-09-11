import { NativeModules, Platform } from "react-native";

type StallNotificationNativeModule = {
  show: (
    nombre: string,
    minutos: number,
    latitud: number,
    longitud: number,
  ) => Promise<boolean>;
  cancel: () => Promise<boolean>;
};

const nativeModule = NativeModules.StallNotificationModule as StallNotificationNativeModule | undefined;

const getNativeModule = (): StallNotificationNativeModule | null => {
  if (Platform.OS !== "android" || !nativeModule) return null;
  return nativeModule;
};

export const showStallNotification = async (
  nombre: string,
  minutos: number,
  latitud: number,
  longitud: number,
): Promise<boolean> => {
  const module = getNativeModule();
  if (!module) return false;
  return module.show(nombre, minutos, latitud, longitud);
};

export const cancelStallNotification = async (): Promise<boolean> => {
  const module = getNativeModule();
  if (!module) return false;
  return module.cancel();
};
