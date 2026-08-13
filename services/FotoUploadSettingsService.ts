import AsyncStorage from "@react-native-async-storage/async-storage";

const REQUIRE_WIFI_KEY = "@xallapan/fotos/requiere_wifi";

class FotoUploadSettingsService {
  async getRequireWifi(): Promise<boolean> {
    try {
      return (await AsyncStorage.getItem(REQUIRE_WIFI_KEY)) === "true";
    } catch (error) {
      console.warn("[FotoUploadSettings] No se pudo leer la configuración:", error);
      return false;
    }
  }

  async setRequireWifi(value: boolean): Promise<void> {
    try {
      await AsyncStorage.setItem(REQUIRE_WIFI_KEY, String(value));
    } catch (error) {
      console.warn("[FotoUploadSettings] No se pudo guardar la configuración:", error);
      throw new Error("No se pudo guardar la configuración de fotos.");
    }
  }
}

export default new FotoUploadSettingsService();
