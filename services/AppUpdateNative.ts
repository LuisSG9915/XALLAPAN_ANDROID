import { Linking, NativeModules, Platform } from "react-native";

export type AppUpdateNativeModule = {
  canRequestPackageInstalls: () => Promise<boolean>;
  openInstallSettings: () => Promise<void>;
  installApk: (path: string) => Promise<boolean>;
};

const nativeModule = NativeModules.AppUpdateModule as AppUpdateNativeModule | undefined;

const requireAndroidModule = (): AppUpdateNativeModule => {
  if (Platform.OS !== "android" || !nativeModule) {
    throw new Error("El actualizador nativo solo está disponible en Android.");
  }
  return nativeModule;
};

export const canRequestPackageInstalls = async (): Promise<boolean> => {
  if (Platform.OS !== "android") return true;
  return requireAndroidModule().canRequestPackageInstalls();
};

export const openInstallSettings = async (): Promise<void> => {
  if (Platform.OS !== "android") return;
  try {
    await requireAndroidModule().openInstallSettings();
  } catch {
    await Linking.openSettings();
  }
};

export const installApk = async (path: string): Promise<boolean> => {
  if (Platform.OS !== "android") return false;
  return requireAndroidModule().installApk(path);
};
