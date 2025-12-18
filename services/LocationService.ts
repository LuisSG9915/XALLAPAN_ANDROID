import { Platform, PermissionsAndroid, Alert } from "react-native";
import Geolocation, { GeoPosition, GeoError } from "react-native-geolocation-service";

export type LocationCoordinates = {
  latitude: number;
  longitude: number;
};

class LocationService {
  private hasPermission: boolean = false;

  /**
   * Solicita permisos de ubicación al usuario.
   * Retorna true si los permisos fueron concedidos, false en caso contrario.
   */
  async requestPermission(): Promise<boolean> {
    if (Platform.OS === "ios") {
      const auth = await Geolocation.requestAuthorization("whenInUse");
      if (auth === "granted" || auth === "restricted") {
        this.hasPermission = true;
        return true;
      }
      this.hasPermission = false;
      return false;
    }

    if (Platform.OS === "android") {
      try {
        const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION, {
          title: "Permiso de Ubicación Requerido",
          message: "Esta aplicación necesita acceso a tu ubicación para registrar las ventas correctamente.",
          buttonNeutral: "Preguntar después",
          buttonNegative: "Cancelar",
          buttonPositive: "Aceptar",
        });

        if (granted === PermissionsAndroid.RESULTS.GRANTED) {
          this.hasPermission = true;
          return true;
        }

        this.hasPermission = false;
        return false;
      } catch (err) {
        console.error("[LocationService] Error al solicitar permisos:", err);
        this.hasPermission = false;
        return false;
      }
    }

    return false;
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
