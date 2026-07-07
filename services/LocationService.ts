import { Platform, PermissionsAndroid, Alert, Linking } from "react-native";
import Geolocation, { GeoPosition, GeoError } from "react-native-geolocation-service";
import GpsBitacoraService from "./GpsBitacoraService";

export type PermissionStatus = "granted" | "denied" | "blocked";

export type LocationCoordinates = {
  latitude: number;
  longitude: number;
  accuracy?: number; // precisión en metros (cuanto menor, mejor)
};

export type MotivoValidacion = "ok" | "sin_permiso" | "sin_senal" | "precision_baja" | "fuera_de_rango";

export type ValidacionUbicacionResultado = {
  valido: boolean;
  motivo: MotivoValidacion;
  metrosPermitidos: number;
  distancia?: number;
  accuracy?: number;
  ubicacion?: LocationCoordinates;
};

// Precisión (accuracy) máxima aceptable para dar por válida una lectura GPS.
// Por encima de este valor la lectura es demasiado imprecisa para validar cercanía.
export const PRECISION_MAXIMA_ACEPTABLE = 50; // metros

// Tolerancia máxima que se suma al rango permitido para absorber el error del GPS.
// A propósito NO se descuenta el accuracy completo: hacerlo permitiría validar
// desde muy lejos cuando el GPS es impreciso.
export const BUFFER_MAXIMO = 20; // metros

/**
 * Calcula la distancia en metros entre dos coordenadas usando la fórmula de Haversine.
 */
export function calcularDistancia(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

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
        const alreadyGranted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);

        if (alreadyGranted) {
          this.hasPermission = true;
          console.log("[LocationService] Permiso ya otorgado");
          return "granted";
        }

        console.log("[LocationService] Solicitando permiso de ubicación...");

        // Usar Promise.race para agregar timeout de 10 segundos
        const requestPromise = PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION, {
          title: "Permiso de Ubicación Obligatorio",
          message:
            "Esta aplicación REQUIERE acceso a tu ubicación para funcionar. Sin este permiso no podrás usar la aplicación.",
          buttonNegative: "Denegar",
          buttonPositive: "Permitir",
        });

        const timeoutPromise = new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("Timeout al solicitar permisos")), 10000),
        );

        const granted = (await Promise.race([requestPromise, timeoutPromise])) as string;

        console.log("[LocationService] Resultado del permiso:", granted);

        if (granted === PermissionsAndroid.RESULTS.GRANTED) {
          this.hasPermission = true;
          return "granted";
        }

        if (granted === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
          this.hasPermission = false;
          console.log("[LocationService] Permiso bloqueado permanentemente");
          return "blocked";
        }

        this.hasPermission = false;
        console.log("[LocationService] Permiso denegado");
        return "denied";
      } catch (err) {
        console.error("[LocationService] Error al solicitar permisos:", err);
        console.error("[LocationService] Stack trace:", err instanceof Error ? err.stack : "No stack available");
        this.hasPermission = false;

        // Si es timeout o error, asumir que está bloqueado si no se puede verificar
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
   * IMPORTANTE: Este método solo VERIFICA, no solicita permisos.
   */
  async checkPermission(): Promise<boolean> {
    if (Platform.OS === "ios") {
      const auth = await Geolocation.requestAuthorization("whenInUse");
      this.hasPermission = auth === "granted" || auth === "restricted";
      return this.hasPermission;
    }

    if (Platform.OS === "android") {
      try {
        const granted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
        this.hasPermission = granted;
        console.log(`[LocationService] Check permission result: ${granted}`);
        return granted;
      } catch (error) {
        console.error("[LocationService] Error checking permission:", error);
        return false;
      }
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

          // Registrar en bitácora GPS para debugging y trazabilidad
          GpsBitacoraService.registrarUbicacion(
            position.coords.latitude,
            position.coords.longitude,
            position.coords.accuracy,
          );

          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
          });
        },
        (error: GeoError) => {
          console.error("[LocationService] Error al obtener ubicación:", error);
          resolve(null);
        },
        {
          enableHighAccuracy: true,
          timeout: 20000,
          maximumAge: 0,
        },
      );
    });
  }

  /**
   * Retorna si los permisos están concedidos.
   */
  getPermissionStatus(): boolean {
    return this.hasPermission;
  }

  /**
   * Obtiene la mejor ubicación disponible tomando hasta `intentos` lecturas
   * y devolviendo la que tenga menor valor de accuracy (más precisa).
   *
   * Ideal para validar si el vendedor está dentro del rango de un cliente,
   * ya que el GPS de bajo costo puede tener errores de 50-200 m en el primer intento.
   *
   * @param intentos  Número máximo de lecturas (default 3)
   * @param timeoutMs Timeout por lectura en ms (default 8000)
   * @param onProgreso Callback opcional para notificar cada intento
   */
  async getBestLocation(
    intentos: number = 5,
    timeoutMs: number = 10000,
    onProgreso?: (intento: number, total: number, accuracy: number) => void,
  ): Promise<LocationCoordinates | null> {
    if (!this.hasPermission) {
      const granted = await this.checkPermission();
      if (!granted) {
        console.warn("[LocationService] No hay permisos de ubicación");
        return null;
      }
    }

    const lecturas: LocationCoordinates[] = [];

    const obtenerLectura = (): Promise<LocationCoordinates | null> =>
      new Promise((resolve) => {
        Geolocation.getCurrentPosition(
          (position: GeoPosition) => {
            const coords: LocationCoordinates = {
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracy: position.coords.accuracy,
            };
            console.log(
              `[LocationService] Lectura GPS: lat=${coords.latitude.toFixed(6)},` +
                ` lng=${coords.longitude.toFixed(6)}, accuracy=${Math.round(coords.accuracy ?? 999)} m`,
            );
            GpsBitacoraService.registrarUbicacion(coords.latitude, coords.longitude, coords.accuracy);
            resolve(coords);
          },
          (error: GeoError) => {
            console.warn("[LocationService] Error en lectura GPS:", error.message);
            resolve(null);
          },
          { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0, forceRequestLocation: true } as any,
        );
      });

    for (let i = 1; i <= intentos; i++) {
      const lectura = await obtenerLectura();
      if (lectura) {
        lecturas.push(lectura);
        onProgreso?.(i, intentos, lectura.accuracy ?? 999);
        // Si ya tenemos buena precisión (<= 15 m) no necesitamos más lecturas
        if ((lectura.accuracy ?? 999) <= 15) {
          console.log(`[LocationService] Precisión óptima en intento ${i}: ${lectura.accuracy} m`);
          break;
        }
      }
    }

    if (lecturas.length === 0) return null;

    // Elegir la lectura con menor accuracy (más precisa)
    const mejor = lecturas.reduce((prev, curr) => ((curr.accuracy ?? 999) < (prev.accuracy ?? 999) ? curr : prev));

    console.log(
      `[LocationService] Mejor lectura de ${lecturas.length} intentos:` +
        ` accuracy=${Math.round(mejor.accuracy ?? 999)} m`,
    );

    return mejor;
  }

  /**
   * Valida si el vendedor está dentro del rango permitido de un cliente.
   *
   * A diferencia del enfoque anterior (distancia - accuracy), que permitía
   * validar desde muy lejos cuando el GPS era impreciso, aquí:
   *  - Se rechaza la lectura si su precisión es peor que PRECISION_MAXIMA_ACEPTABLE.
   *  - Se compara la distancia real contra el rango permitido + un buffer acotado.
   */
  async validarUbicacionCliente(
    clienteLat: number,
    clienteLng: number,
    metrosPermitidos: number,
    onProgreso?: (intento: number, total: number, accuracy: number) => void,
  ): Promise<ValidacionUbicacionResultado> {
    const permiso = this.hasPermission || (await this.checkPermission());
    if (!permiso) {
      return { valido: false, motivo: "sin_permiso", metrosPermitidos };
    }

    const ubicacion = await this.getBestLocation(5, 10000, onProgreso);
    if (!ubicacion) {
      return { valido: false, motivo: "sin_senal", metrosPermitidos };
    }

    const accuracy = ubicacion.accuracy ?? 999;
    if (accuracy > PRECISION_MAXIMA_ACEPTABLE) {
      console.warn(`[LocationService] Precisión insuficiente para validar: ±${Math.round(accuracy)} m`);
      return { valido: false, motivo: "precision_baja", accuracy, metrosPermitidos, ubicacion };
    }

    const distancia = calcularDistancia(ubicacion.latitude, ubicacion.longitude, clienteLat, clienteLng);
    const buffer = Math.min(accuracy, BUFFER_MAXIMO);
    const dentroDeRango = distancia <= metrosPermitidos + buffer;

    console.log(
      `[LocationService] Validación: distancia=${Math.round(distancia)} m, ` +
        `permitido=${metrosPermitidos} m, buffer=${Math.round(buffer)} m, accuracy=±${Math.round(accuracy)} m ` +
        `=> ${dentroDeRango ? "VÁLIDO" : "FUERA DE RANGO"}`,
    );

    return {
      valido: dentroDeRango,
      motivo: dentroDeRango ? "ok" : "fuera_de_rango",
      distancia,
      accuracy,
      metrosPermitidos,
      ubicacion,
    };
  }

  /**
   * Igual que validarUbicacionCliente, pero muestra automáticamente una alerta
   * al usuario según el motivo del fallo. Devuelve true solo si la ubicación es válida.
   */
  async validarUbicacionConAlerta(
    clienteLat: number,
    clienteLng: number,
    metrosPermitidos: number,
    onProgreso?: (intento: number, total: number, accuracy: number) => void,
    clienteInfo?: { nombre?: string; lat?: number; lng?: number },
  ): Promise<boolean> {
    const r = await this.validarUbicacionCliente(clienteLat, clienteLng, metrosPermitidos, onProgreso);

    switch (r.motivo) {
      case "ok":
        return true;
      case "sin_permiso":
        Alert.alert(
          "Permiso de ubicación",
          "Necesitas conceder el permiso de ubicación para poder registrar la visita.",
        );
        return false;
      case "sin_senal":
        Alert.alert(
          "Ubicación no disponible",
          "No se pudo obtener tu ubicación. Verifica que el GPS esté activado y que estés a cielo abierto.",
        );
        return false;
      case "precision_baja":
        Alert.alert(
          "Señal GPS débil",
          `La precisión del GPS es de ±${Math.round(
            r.accuracy ?? 0,
          )} m, demasiado baja para validar tu ubicación. Sal a un espacio abierto e inténtalo de nuevo.`,
        );
        return false;
      case "fuera_de_rango": {
        const nombreCliente = clienteInfo?.nombre ? `Cliente: ${clienteInfo.nombre}\n` : "";
        const tuUbicacion = r.ubicacion
          ? `Tu ubicación: ${r.ubicacion.latitude.toFixed(6)}, ${r.ubicacion.longitude.toFixed(6)}\n`
          : "";
        const ubicacionCliente = `Ubicación cliente: ${clienteLat.toFixed(6)}, ${clienteLng.toFixed(6)}`;

        Alert.alert(
          "Ubicación inválida",
          `${nombreCliente}` +
            `Estás a ${Math.round(r.distancia ?? 0)} metros del cliente. La distancia máxima permitida es de ` +
            `${metrosPermitidos} metros (precisión GPS: ±${Math.round(r.accuracy ?? 0)} m).\n\n` +
            `${tuUbicacion}${ubicacionCliente}`,
        );
        return false;
      }
      default:
        return false;
    }
  }
}

export default new LocationService();
