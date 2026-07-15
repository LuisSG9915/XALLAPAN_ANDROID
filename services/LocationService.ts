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
  numFixes?: number;
  peorAccuracy?: number;
  tiempoMs?: number;
};

// Diagnóstico de la última lectura de getBestLocation, para trazabilidad en campo.
export type DiagnosticoGps = {
  numFixes: number;
  peorAccuracy: number;
  tiempoMs: number;
};

// Precisión (accuracy) a partir de la cual una lectura se considera "confiable".
// Solo se usa cuando la posición parece estar FUERA de rango, para distinguir
// entre "estás realmente fuera" (GPS confiable) y "reintenta" (GPS impreciso).
// NO se usa para rechazar lecturas que ya caen dentro del rango.
export const PRECISION_MAXIMA_ACEPTABLE = 50; // metros

// Precisión tan mala que la lectura no sirve ni siquiera cuando parece caer
// dentro del rango. Por encima de este valor se pide reintentar siempre.
export const PRECISION_ABSURDA = 150; // metros

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
  // Diagnóstico de la última ejecución de getBestLocation. Se lee justo después
  // de llamar a getBestLocation (JS es de un solo hilo, así que no hay carrera).
  private ultimoDiagnosticoGps: DiagnosticoGps = { numFixes: 0, peorAccuracy: 0, tiempoMs: 0 };

  /** Devuelve el diagnóstico de la última lectura de getBestLocation. */
  getUltimoDiagnosticoGps(): DiagnosticoGps {
    return this.ultimoDiagnosticoGps;
  }

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
   * Solicita el permiso de ubicación en background (ACCESS_BACKGROUND_LOCATION).
   * En Android 11+ es obligatorio abrir la configuración manual.
   */
  async requestBackgroundLocationPermission(): Promise<PermissionStatus> {
    if (Platform.OS !== "android") return "granted";

    const fineGranted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
    if (!fineGranted) {
      console.warn("[LocationService] No hay permiso FINE_LOCATION; no se puede pedir background.");
      return "denied";
    }

    const backgroundGranted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION);
    if (backgroundGranted) {
      console.log("[LocationService] Permiso background ya otorgado");
      return "granted";
    }

    try {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION,
        {
          title: "Permiso de ubicación en segundo plano",
          message: "Para registrar el recorrido con la pantalla apagada o la app cerrada, debes permitir el acceso a la ubicación 'Todo el tiempo'.",
          buttonNegative: "Cancelar",
          buttonPositive: "Configuración",
        },
      );

      if (granted === PermissionsAndroid.RESULTS.GRANTED) {
        return "granted";
      }

      if (granted === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
        Alert.alert(
          "Permiso requerido",
          "Ve a Configuración > Aplicaciones > Xallapan > Permisos > Ubicación y selecciona 'Permitir todo el tiempo'.",
          [
            { text: "Cancelar", style: "cancel" },
            { text: "Abrir configuración", onPress: () => this.openSettings() },
          ],
        );
        return "blocked";
      }

      return "denied";
    } catch (error) {
      console.error("[LocationService] Error al solicitar background location:", error);
      return "denied";
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
   * Obtiene la mejor ubicación disponible manteniendo el GPS activo con
   * `watchPosition` durante unos segundos y devolviendo el fix con menor
   * accuracy (más preciso). A diferencia de un único `getCurrentPosition`,
   * esto permite descartar el primer fix "grueso" de red celular/WiFi y
   * esperar a que el chip GPS refine la precisión (clave en ciudad, donde el
   * cañón urbano puede dar errores de 100-400 m al principio).
   *
   * Corta antes de tiempo si alcanza la precisión objetivo (<= 15 m).
   *
   * @param intentos      Solo se usa para el callback de progreso (total esperado)
   * @param timeoutMs       Presupuesto de escucha en ms; se respeta un mínimo de 6 s
   * @param onProgreso      Callback opcional para notificar cada fix recibido
   * @param condicionExito  Si una lectura satisface esta condición, se devuelve
   *                        inmediatamente sin esperar a mejorar la precisión.
   */
  async getBestLocation(
    intentos: number = 5,
    timeoutMs: number = 10000,
    onProgreso?: (intento: number, total: number, accuracy: number) => void,
    condicionExito?: (coords: LocationCoordinates) => boolean,
  ): Promise<LocationCoordinates | null> {
    if (!this.hasPermission) {
      const granted = await this.checkPermission();
      if (!granted) {
        console.warn("[LocationService] No hay permisos de ubicación");
        return null;
      }
    }

    // Precisión con la que consideramos el fix "suficientemente bueno" y cortamos.
    const PRECISION_OBJETIVO = 15; // metros
    // Tiempo mínimo de calentamiento: ignoramos fixes muy imprecisos (típicos de
    // red celular/WiFi) durante los primeros segundos para dar tiempo al GPS.
    const WARMUP_MS = 4000;
    // Presupuesto total de escucha. Se limita a 6 s para no hacer esperar al usuario;
    // si no hay fix aceptable en ese tiempo, se reporta como señal débil/fuera de rango.
    const tiempoMaximoMs = Math.max(timeoutMs, 6000);

    return new Promise((resolve) => {
      let mejor: LocationCoordinates | null = null;
      let lecturasRecibidas = 0;
      let peorAccuracy = 0;
      let settled = false;
      let watchId: number | null = null;
      const inicio = Date.now();

      const aceptar = (coords: LocationCoordinates | null, motivo: string) => {
        if (settled) return;
        settled = true;
        if (watchId !== null) {
          Geolocation.clearWatch(watchId);
          watchId = null;
        }
        clearTimeout(temporizadorTotal);
        this.ultimoDiagnosticoGps = {
          numFixes: lecturasRecibidas,
          peorAccuracy,
          tiempoMs: Date.now() - inicio,
        };
        if (coords) {
          console.log(
            `[LocationService] Mejor lectura (${motivo}) de ${lecturasRecibidas} fixes:` +
              ` accuracy=±${Math.round(coords.accuracy ?? 999)} m`,
          );
          // Registramos SOLO el fix aceptado (evita inflar la bitácora con cada lectura de watchPosition).
          GpsBitacoraService.registrarUbicacion(coords.latitude, coords.longitude, coords.accuracy);
        } else {
          console.warn(`[LocationService] Sin lecturas GPS válidas (${motivo})`);
        }
        resolve(coords);
      };

      const finalizar = (motivo: string) => aceptar(mejor, motivo);

      const temporizadorTotal = setTimeout(() => finalizar("timeout"), tiempoMaximoMs);

      watchId = Geolocation.watchPosition(
        (position: GeoPosition) => {
          const coords: LocationCoordinates = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
          };
          const accuracy = coords.accuracy ?? 999;
          const transcurrido = Date.now() - inicio;

          // Guarda contra timers JS aplazados cuando la app se suspende (fondo/pantalla apagada).
          // Si ya se pasó el presupuesto total, cortamos inmediatamente con lo que tengamos.
          if (transcurrido >= tiempoMaximoMs) {
            finalizar("timeout");
            return;
          }

          console.log(
            `[LocationService] Fix GPS (+${transcurrido} ms): lat=${coords.latitude.toFixed(6)},` +
              ` lng=${coords.longitude.toFixed(6)}, accuracy=±${Math.round(accuracy)} m`,
          );

          // Durante el warm-up descartamos fixes gruesos (probable ubicación de red)
          // salvo que aún no tengamos ninguna lectura de respaldo.
          const esFixGrueso = accuracy > PRECISION_ABSURDA;
          if (transcurrido < WARMUP_MS && esFixGrueso && mejor) {
            return;
          }

          lecturasRecibidas++;
          if (accuracy > peorAccuracy) {
            peorAccuracy = accuracy;
          }
          if (!mejor || accuracy < (mejor.accuracy ?? 999)) {
            mejor = coords;
          }
          onProgreso?.(lecturasRecibidas, intentos, accuracy);

          // Cortamos en cuanto el mejor fix alcanza la precisión objetivo.
          if ((mejor.accuracy ?? 999) <= PRECISION_OBJETIVO) {
            finalizar("precisión objetivo");
            return;
          }

          // O si el llamador acepta este fix (p. ej. ya cae dentro del rango del cliente).
          if (condicionExito?.(coords)) {
            aceptar(coords, "condición de éxito");
            return;
          }
        },
        (error: GeoError) => {
          console.warn("[LocationService] Error en watchPosition:", error.message);
          // No finalizamos: dejamos que el temporizador total decida, por si llega
          // un fix válido más adelante. Solo fallamos si nunca hubo lectura.
          if (!mejor && (error.code === 1 || error.code === 2)) {
            finalizar(`error ${error.code}`);
          }
        },
        {
          enableHighAccuracy: true,
          distanceFilter: 0,
          interval: 1000,
          fastestInterval: 500,
          forceRequestLocation: true,
          showLocationDialog: true,
        } as any,
      );
    });
  }

  /**
   * Valida si el vendedor está dentro del rango permitido de un cliente.
   *
   * Estrategia de "umbral relativo al rango":
   *  1. Si la distancia medida cae dentro del rango permitido (+ buffer acotado),
   *     se acepta aunque el accuracy sea alto, salvo precisión absurda.
   *  2. Si parece estar fuera de rango pero el accuracy es peor que
   *     PRECISION_MAXIMA_ACEPTABLE, no se puede afirmar que esté fuera: se pide
   *     reintentar (precision_baja).
   *  3. Si el accuracy es confiable y aun así está fuera, se marca fuera_de_rango.
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

    const ubicacion = await this.getBestLocation(5, 10000, onProgreso, (coords) => {
      const accuracy = coords.accuracy ?? 999;
      if (accuracy > PRECISION_ABSURDA) return false;
      const distancia = calcularDistancia(coords.latitude, coords.longitude, clienteLat, clienteLng);
      const buffer = Math.min(accuracy, BUFFER_MAXIMO);
      return distancia <= metrosPermitidos + buffer;
    });
    const diag = this.getUltimoDiagnosticoGps();
    if (!ubicacion) {
      return { valido: false, motivo: "sin_senal", metrosPermitidos, ...diag };
    }

    const accuracy = ubicacion.accuracy ?? 999;
    const distancia = calcularDistancia(ubicacion.latitude, ubicacion.longitude, clienteLat, clienteLng);
    const buffer = Math.min(accuracy, BUFFER_MAXIMO);
    const dentroDeRango = distancia <= metrosPermitidos + buffer;

    // 1) Si la posición medida cae dentro del rango permitido, es válida aunque
    //    el accuracy sea alto, salvo que la lectura sea absurdamente imprecisa.
    if (dentroDeRango && accuracy <= PRECISION_ABSURDA) {
      console.log(
        `[LocationService] Validación VÁLIDO: distancia=${Math.round(distancia)} m, ` +
          `permitido=${metrosPermitidos} m, buffer=${Math.round(buffer)} m, accuracy=±${Math.round(accuracy)} m`,
      );
      return { valido: true, motivo: "ok", distancia, accuracy, metrosPermitidos, ubicacion, ...diag };
    }

    // 2) La posición parece estar fuera de rango (o el accuracy es absurdo). Si la
    //    precisión es baja no podemos afirmar que esté fuera: pedimos reintentar.
    if (accuracy > PRECISION_MAXIMA_ACEPTABLE) {
      console.warn(
        `[LocationService] Precisión insuficiente para validar: distancia=${Math.round(distancia)} m, ` +
          `accuracy=±${Math.round(accuracy)} m`,
      );
      return { valido: false, motivo: "precision_baja", distancia, accuracy, metrosPermitidos, ubicacion, ...diag };
    }

    // 3) Accuracy confiable y aun así fuera de rango: está realmente lejos.
    console.log(
      `[LocationService] Validación FUERA DE RANGO: distancia=${Math.round(distancia)} m, ` +
        `permitido=${metrosPermitidos} m, buffer=${Math.round(buffer)} m, accuracy=±${Math.round(accuracy)} m`,
    );

    return {
      valido: false,
      motivo: "fuera_de_rango",
      distancia,
      accuracy,
      metrosPermitidos,
      ubicacion,
      ...diag,
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
    clienteInfo?: { id?: number; nombre?: string; lat?: number; lng?: number },
  ): Promise<boolean> {
    const r = await this.validarUbicacionCliente(clienteLat, clienteLng, metrosPermitidos, onProgreso);

    // Registrar el diagnóstico de la validación para trazabilidad en campo.
    // No bloquea el flujo si falla.
    GpsBitacoraService.registrarValidacion({
      idCliente: clienteInfo?.id ?? null,
      motivo: r.motivo,
      valido: r.valido,
      distancia: r.distancia ?? null,
      accuracy: r.accuracy ?? null,
      metrosPermitidos: r.metrosPermitidos ?? metrosPermitidos,
      latitud: r.ubicacion?.latitude ?? null,
      longitud: r.ubicacion?.longitude ?? null,
      clienteLatitud: clienteLat,
      clienteLongitud: clienteLng,
      numFixes: r.numFixes ?? null,
      peorAccuracy: r.peorAccuracy ?? null,
      tiempoMs: r.tiempoMs ?? null,
    });

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
          )} m, demasiado baja para validar tu ubicación. Inténtalo de nuevo.`,
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
