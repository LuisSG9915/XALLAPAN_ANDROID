import { Platform, PermissionsAndroid, Alert, Linking } from "react-native";
import Geolocation, { GeoPosition, GeoError } from "react-native-geolocation-service";

export type PermissionStatus = "granted" | "denied" | "blocked";

export type LocationCoordinates = {
  latitude: number;
  longitude: number;
};

class LocationService {
  private hasPermission: boolean = false;

  /**
   * Solicita permisos de ubicación al usuario.
   * Retorna el estado del permiso: 'granted', 'denied', o 'blocked'
   */
  async requestPermission(): Promise<PermissionStatus> {
    if (Platform.OS === "ios") {
      const auth = await Geolocation.requestAuthorization("whenInUse");
      if (auth === "granted" || auth === "restricted") {
        this.hasPermission = true;
        return "granted";
      }
      this.hasPermission = false;
      return auth === "denied" ? "blocked" : "denied";
    }

    if (Platform.OS === "android") {
      try {
        // Primero verificar si ya está denegado permanentemente
        const alreadyGranted = await PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
        );
        
        if (alreadyGranted) {
          this.hasPermission = true;
          return "granted";
        }

        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          {
            title: "Permiso de Ubicación Obligatorio",
            message:
              "Esta aplicación REQUIERE acceso a tu ubicación para funcionar. Sin este permiso no podrás usar la aplicación.",
            buttonNegative: "Denegar",
            buttonPositive: "Permitir",
          }
        );

        console.log("[LocationService] Resultado del permiso:", granted);

        if (granted === PermissionsAndroid.RESULTS.GRANTED) {
          this.hasPermission = true;
          return "granted";
        }

        if (granted === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
          this.hasPermission = false;
          return "blocked";
        }

        this.hasPermission = false;
        return "denied";
      } catch (err) {
        console.error("[LocationService] Error al solicitar permisos:", err);
        this.hasPermission = false;
        return "denied";
      }
    }

    return "denied";
  }

  /**
   * Abre la configuración de la aplicación para que el usuario pueda habilitar permisos manualmente
   */
  async openSettings(): Promise<void> {
    try {
      if (Platform.OS === "android") {
        await Linking.openSettings();
      } else if (Platform.OS === "ios") {
        await Linking.openURL("app-settings:");
      }
    } catch (error) {
      console.error("[LocationService] No se pudo abrir configuración:", error);
    }
  }

  /**
   * Verifica si ya se tienen los permisos de ubicación.
   */
  async checkPermission(): Promise<boolean> {
    if (Platform.OS === "ios") {
      const auth = await Geolocation.requestAuthorization("whenInUse");
      this.hasPermission = auth === "granted" || auth === "restricted";
      return this.hasPermission;
    }

    if (Platform.OS === "android") {
      const granted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
      this.hasPermission = granted;
      return granted;
    }

    return false;
  }

  /**
   * Obtiene la ubicación actual del usuario.
   * Retorna las coordenadas o null si no se pudo obtener.
   */
  async getCurrentLocation(): Promise<LocationCoordinates | null> {
    if (!this.hasPermission) {
      const granted = await this.checkPermission();
      if (!granted) {
        console.warn("[LocationService] No hay permisos de ubicación");
        return null;
      }
    }

    return new Promise((resolve) => {
      Geolocation.getCurrentPosition(
        (position: GeoPosition) => {
          console.log("[LocationService] Ubicación obtenida:", {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
          });
          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          });
        },
        (error: GeoError) => {
          console.error("[LocationService] Error al obtener ubicación:", error);
          resolve(null);
        },
        {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 10000,
        }
      );
    });
  }

  /**
   * Retorna si los permisos están concedidos.
   */
  getPermissionStatus(): boolean {
    return this.hasPermission;
  }
}

export default new LocationService();
