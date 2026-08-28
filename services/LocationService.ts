import { Platform, PermissionsAndroid, Alert, Linking, AppState, NativeModules } from "react-native";
import Geolocation, { GeoPosition, GeoError } from "react-native-geolocation-service";
import NetInfo from "@react-native-community/netinfo";
import GpsBitacoraService from "./GpsBitacoraService";

export type PermissionStatus = "granted" | "denied" | "blocked";

export type LocationCoordinates = {
  latitude: number;
  longitude: number;
  accuracy?: number; // precisión en metros (cuanto menor, mejor)
  timestamp?: number;
  mocked?: boolean;
  provider?: string;
};

export type MotivoValidacion = "ok" | "ok_cache" | "sin_permiso" | "sin_senal" | "precision_baja" | "fuera_de_rango" | "red_no_gnss";

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

// Ventana de validez de una confirmación de ubicación exitosa. Dentro de ella,
// validaciones posteriores contra el MISMO punto se aprueban al instante, sin
// nueva lectura GPS: el flujo "entrar a ventas → confirmar iniciar visita"
// hacía esperar 3-6 s dos veces seguidas al vendedor, y la bitácora mostraba
// el mismo cliente validado hasta 7 veces en 2.5 min. La ventana es corta a
// propósito (anti-trampa: en 3 min el vendedor no puede alejarse mucho).
export const TTL_VALIDACION_CACHE_MS = 3 * 60 * 1000; // 3 minutos

/**
 * Regla ÚNICA de rango, compartida por la validación real y por las pantallas
 * que muestran al vendedor si está "Lejos" (p. ej. lista de Cercanos en
 * SalesScreen). Una distancia se considera DENTRO del rango si no supera el
 * límite más un buffer acotado por el accuracy del fix (máx. BUFFER_MAXIMO).
 * Usar siempre esta función para que la UI y la validación nunca se contradigan.
 */
export function estaDentroDeRango(
  distancia: number,
  accuracy: number | null | undefined,
  metrosPermitidos: number,
): boolean {
  const buffer = Math.min(accuracy ?? 0, BUFFER_MAXIMO);
  return distancia <= metrosPermitidos + buffer;
}

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
  // Guardas por sesión: el servicio de ruta se reinicia periódicamente
  // (health check cada 60 s, AppState, etc.) y sin ellas los diálogos de
  // permisos saltaban una y otra vez aunque el usuario ya hubiera respondido.
  private backgroundPromptShown: boolean = false;
  private notificationPromptShown: boolean = false;
  // Diagnóstico de la última ejecución de getBestLocation. Se lee justo después
  // de llamar a getBestLocation (JS es de un solo hilo, así que no hay carrera).
  private ultimoDiagnosticoGps: DiagnosticoGps = { numFixes: 0, peorAccuracy: 0, tiempoMs: 0 };
  // Callback registrado por BackgroundLocationService para re-suscribir su
  // watch de ruta cuando getBestLocation termina (ver forzarIntervaloNativo).
  private watchRestoreHandler: (() => void) | null = null;
  // Última validación exitosa, para aprobar al instante revalidaciones del mismo
  // punto dentro de TTL_VALIDACION_CACHE_MS (ver validarUbicacionCliente).
  private ultimaValidacionOk: {
    clienteLat: number;
    clienteLng: number;
    metrosPermitidos: number;
    distancia: number;
    accuracy: number;
    timestamp: number;
  } | null = null;

  /** Versión del SDK de Android (0 si no es Android). */
  private getAndroidSdk(): number {
    if (Platform.OS !== "android") return 0;
    return typeof Platform.Version === "string" ? parseInt(Platform.Version, 10) : (Platform.Version || 0);
  }

  /** Devuelve el diagnóstico de la última lectura de getBestLocation. */
  getUltimoDiagnosticoGps(): DiagnosticoGps {
    return this.ultimoDiagnosticoGps;
  }

  /**
   * Registra cómo restaurar la suscripción GPS de fondo (tracking de ruta)
   * después de que getBestLocation fuerce el intervalo rápido.
   * Lo llama BackgroundLocationService al arrancar/detener el servicio.
   */
  setWatchRestoreHandler(handler: (() => void) | null): void {
    this.watchRestoreHandler = handler;
  }

  /**
   * `react-native-geolocation-service` comparte UNA sola suscripción nativa
   * (`continuousLocationProvider`) entre todos los `watchPosition`: si ya hay
   * un watch activo, `updatesEnabled` es true y el módulo JS NO vuelve a
   * llamar a `startObserving`, así que el nuevo watch hereda el intervalo del
   * anterior. Con el tracking de ruta activo (interval=30 s) eso dejaba a la
   * validación de venta sin fixes dentro de su presupuesto de 10 s
   * (`numFixes=0` → `sin_senal`). Forzamos aquí el `startObserving` con el
   * intervalo rápido; el `LocationRequest` nativo se reemplaza al reusar el
   * mismo `LocationCallback`.
   */
  forzarIntervaloNativo(opciones: Record<string, unknown>): void {
    if (Platform.OS !== "android") return;
    const nativo = (NativeModules as any)?.RNFusedLocation;
    if (!nativo || typeof nativo.startObserving !== "function") return;
    try {
      nativo.startObserving(opciones);
    } catch (e) {
      console.warn("[LocationService] No se pudo forzar el intervalo GPS nativo:", e);
    }
  }

  /** Devuelve el watch de fondo a su intervalo normal tras una lectura rápida. */
  private restaurarWatchDeFondo(): void {
    const handler = this.watchRestoreHandler;
    if (!handler) return;
    try {
      handler();
    } catch (e) {
      console.warn("[LocationService] Error restaurando el watch de fondo:", e);
    }
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

        // Android 12+: el diálogo de ubicación ofrece "Precisa" / "Aproximada".
        // Si el usuario eligió "Aproximada", COARSE queda concedido pero FINE
        // no — y volver a pedir solo repite el ciclo ("le doy y me la vuelve a
        // pedir"). Se explica el problema y se abre Configuración.
        const coarseGranted = await PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
        );
        if (coarseGranted) {
          this.hasPermission = false;
          Alert.alert(
            "Ubicación precisa requerida",
            "Concediste la ubicación APROXIMADA, pero la app necesita la ubicación " +
              "PRECISA para validar visitas.\n\n" +
              "En Configuración > Ubicación activa 'Usar ubicación precisa' " +
              "(o vuelve a intentarlo y elige 'Precisa' en el diálogo).",
            [
              { text: "Cancelar", style: "cancel" },
              { text: "Abrir configuración", onPress: () => this.openSettings() },
            ],
          );
          return "blocked";
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

    // Android 11+ (API 30+): el sistema YA NO muestra diálogo para
    // ACCESS_BACKGROUND_LOCATION en runtime; la petición se resuelve como
    // denegada al instante. Hay que dirigir al usuario a Configuración
    // ("Permitir todo el tiempo"). Se avisa solo una vez por sesión para no
    // interrumpir continuamente (health check cada 60 s, AppState, etc.).
    const sdkVersion = this.getAndroidSdk();
    if (sdkVersion >= 30) {
      if (!this.backgroundPromptShown) {
        this.backgroundPromptShown = true;
        Alert.alert(
          "Permiso de ubicación en segundo plano",
          "Para registrar el recorrido con la pantalla apagada o la app cerrada, " +
            "debes permitir el acceso a la ubicación 'Todo el tiempo'.\n\n" +
            "Ve a Configuración > Aplicaciones > Xallapan > Permisos > Ubicación " +
            "y selecciona 'Permitir todo el tiempo'.",
          [
            { text: "Ahora no", style: "cancel" },
            { text: "Abrir configuración", onPress: () => this.openSettings() },
          ],
        );
      }
      return "denied";
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
   * Solicita el permiso de notificaciones (POST_NOTIFICATIONS).
   * Requerido en Android 13+ para mostrar la notificación del foreground service.
   */
  async requestNotificationPermission(): Promise<PermissionStatus> {
    if (Platform.OS !== "android") return "granted";

    const sdkVersion = this.getAndroidSdk();
    if (sdkVersion < 33) return "granted";

    try {
      const alreadyGranted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      if (alreadyGranted) return "granted";

      // Solo se muestra el diálogo una vez por sesión: el servicio de ruta se
      // reinicia periódicamente y sin esta guarda el diálogo saltaba "en
      // cualquier momento" una y otra vez.
      if (this.notificationPromptShown) {
        return "denied";
      }
      this.notificationPromptShown = true;

      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
        {
          title: "Permiso de notificaciones",
          message: "Para mostrar el aviso de ruta en segundo plano, permite las notificaciones.",
          buttonNegative: "Cancelar",
          buttonPositive: "Aceptar",
        },
      );

      if (result === PermissionsAndroid.RESULTS.GRANTED) return "granted";
      if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return "blocked";
      return "denied";
    } catch (error) {
      console.error("[LocationService] Error al solicitar notificaciones:", error);
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
          if (position.mocked === true) {
            console.warn("[LocationService] Se descartó una ubicación simulada");
            resolve(null);
            return;
          }

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
            timestamp: position.timestamp,
            mocked: position.mocked,
            provider: position.provider,
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

  async getLocationForNearby(): Promise<LocationCoordinates | null> {
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
          if (position.mocked === true) {
            console.warn("[LocationService] Se descartó una ubicación simulada");
            resolve(null);
            return;
          }
          const { latitude, longitude, accuracy } = position.coords;
          GpsBitacoraService.registrarUbicacion(latitude, longitude, accuracy);
          resolve({
            latitude,
            longitude,
            accuracy,
            timestamp: position.timestamp,
            mocked: position.mocked,
            provider: position.provider,
          });
        },
        (error: GeoError) => {
          console.warn("[LocationService] No se pudo obtener ubicación rápida:", error.message);
          resolve(null);
        },
        {
          enableHighAccuracy: true,
          timeout: 4500,
          maximumAge: 0,
          forceRequestLocation: true,
          showLocationDialog: true,
        } as any,
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
   * @param intentos        Solo se usa para el callback de progreso (total esperado)
   * @param timeoutMs       Presupuesto de escucha en ms; se respeta un mínimo de 6 s
   * @param onProgreso      Callback opcional para notificar cada fix recibido
   * @param condicionExito  Si una lectura satisface esta condición, se devuelve
   *                        inmediatamente sin esperar a mejorar la precisión.
   * @param condicionFracaso Si una lectura satisface esta condición, se devuelve
   *                        inmediatamente: el resultado ya es definitivo aunque
   *                        el GPS refinara (p. ej. fuera de rango imposible de
   *                        revertir). Evita hacer esperar al usuario los 10 s
   *                        completos para dar un veredicto ya conocido.
   */
  async getBestLocation(
    intentos: number = 5,
    timeoutMs: number = 10000,
    onProgreso?: (intento: number, total: number, accuracy: number) => void,
    condicionExito?: (coords: LocationCoordinates) => boolean,
    condicionFracaso?: (coords: LocationCoordinates) => boolean,
    minFixes: number = 2,
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
      let segundoMejor: LocationCoordinates | null = null;
      let lecturasRecibidas = 0;
      let peorAccuracy = 0;
      let settled = false;
      let watchId: number | null = null;
      let watchdog: ReturnType<typeof setInterval> | null = null;
      let appStateSub: { remove: () => void } | null = null;
      const inicio = Date.now();
      const EDAD_MAXIMA_FIX_MS = 3000;

      const aceptar = (coords: LocationCoordinates | null, motivo: string) => {
        if (settled) return;
        settled = true;
        // Restaurar el watch de fondo ANTES de liberar el rápido: así el contador
        // de suscriptores nativos nunca llega a 0 y GMS no apaga el motor GNSS.
        this.restaurarWatchDeFondo();
        if (watchId !== null) {
          Geolocation.clearWatch(watchId);
          watchId = null;
        }
        if (watchdog !== null) {
          clearInterval(watchdog);
          watchdog = null;
        }
        appStateSub?.remove();
        appStateSub = null;
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

      // Watchdog de reloj real: los timers de JS se aplazan si la app va a fondo
      // (pantalla apagada) o el hilo JS está saturado, y la guardia contra timers
      // aplazados solo corre CUANDO LLEGA un fix. Si no llegan fixes, la promesa
      // quedaba colgada (caso real: vendedor esperando 82 s). Este intervalo
      // corta en cuanto el SO reanuda el hilo, aunque nunca haya llegado un fix.
      watchdog = setInterval(() => {
        if (Date.now() - inicio >= tiempoMaximoMs) {
          finalizar("timeout (watchdog)");
        }
      }, 500);

      // Si la app se va a fondo, cortamos de inmediato con lo que haya: el SO no
      // entrega fixes en background y los timers quedan congelados.
      appStateSub = AppState.addEventListener("change", (state) => {
        if (state !== "active") {
          finalizar("app_en_fondo");
        }
      });

      const opcionesWatch = {
        enableHighAccuracy: true,
        distanceFilter: 0,
        interval: 1000,
        fastestInterval: 500,
        forceRequestLocation: true,
        showLocationDialog: true,
      };

      watchId = Geolocation.watchPosition(
        (position: GeoPosition) => {
          if (position.mocked === true) {
            console.warn("[LocationService] Se descartó una ubicación simulada");
            return;
          }

          const coords: LocationCoordinates = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            timestamp: position.timestamp,
            mocked: position.mocked,
            provider: position.provider,
          };

          const edadFix = Date.now() - (position.timestamp ?? Date.now());
          if (edadFix > EDAD_MAXIMA_FIX_MS) {
            console.log(
              `[LocationService] Fix descartado por antigüedad: ${edadFix} ms (máx ${EDAD_MAXIMA_FIX_MS} ms)`,
            );
            return;
          }

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
            segundoMejor = mejor;
            mejor = coords;
          } else if (!segundoMejor || accuracy < (segundoMejor.accuracy ?? 999)) {
            segundoMejor = coords;
          }
          onProgreso?.(lecturasRecibidas, intentos, accuracy);

          const fixesCoherentes = (): boolean => {
            if (lecturasRecibidas < minFixes || !mejor || !segundoMejor) return false;
            const dist = calcularDistancia(
              mejor.latitude, mejor.longitude,
              segundoMejor.latitude, segundoMejor.longitude,
            );
            const tolerancia = 3 * (mejor.accuracy ?? 999);
            if (dist > tolerancia) {
              console.log(
                `[LocationService] Fixes incoherentes: ${Math.round(dist)} m > tolerancia ${Math.round(tolerancia)} m`,
              );
              return false;
            }
            return true;
          };

          if ((mejor.accuracy ?? 999) <= PRECISION_OBJETIVO && fixesCoherentes()) {
            finalizar("precisión objetivo");
            return;
          }

          // O si el llamador acepta este fix (p. ej. ya cae dentro del rango del cliente).
          // Protección contra falsos positivos con fix cacheado: exigir ≥2 fixes.
          // Con GNSS enganchado el segundo fix llega en ~1 s; coste mínimo, seguridad máxima.
          if (lecturasRecibidas >= minFixes && condicionExito?.(coords)) {
            console.log(
              `[LocationService] Corte: condición de éxito, numFixes=${lecturasRecibidas}, ` +
                `accuracy=${Math.round(accuracy)}m`,
            );
            aceptar(coords, "condición de éxito");
            return;
          }

          // O si el llamador determina que con este fix el resultado ya es
          // definitivamente negativo (fuera de rango imposible de revertir
          // aunque el GPS refinara): no tiene caso seguir esperando.
          // Protección contra falsos negativos: SIEMPRE exigir ≥2 fixes.
          // Un solo fix cacheado a 2.6 km no debe producir un fuera_de_rango firme.
          if (lecturasRecibidas >= minFixes && condicionFracaso?.(coords)) {
            console.log(
              `[LocationService] Corte: condición de fracaso, numFixes=${lecturasRecibidas}, ` +
                `accuracy=${Math.round(accuracy)}m`,
            );
            aceptar(coords, "condición de fracaso");
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
        opcionesWatch as any,
      );

      // Imprescindible si el tracking de ruta ya tiene un watch a 30 s.
      this.forzarIntervaloNativo(opcionesWatch);
    });
  }

  /**
   * Valida si el vendedor está dentro del rango permitido de un cliente.
   *
   * Estrategia de "umbral relativo al rango" con cortes tempranos:
   *  1. Si la distancia medida cae dentro del rango permitido (+ buffer acotado),
   *     se acepta aunque el accuracy sea alto, salvo precisión absurda.
   *  2. Si parece estar fuera de rango pero el accuracy es peor que
   *     PRECISION_MAXIMA_ACEPTABLE, no se puede afirmar que esté fuera: se pide
   *     reintentar (precision_baja).
   *  3. Si el accuracy es confiable y aun así está fuera, se marca fuera_de_rango.
   *
   *  Velocidad: se corta la escucha en cuanto el veredicto es definitivo —
   *  tanto al acertar (dentro de rango) como al fallar sin remedio (aun
   *  descontando 2 sigmas de error GPS no entraría al rango). Caso real de la
   *  bitácora: vendedor a 4.3 km del cliente esperaba los 10 s completos solo
   *  para escuchar "fuera de rango"; ahora se resuelve en ~2 s.
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

    // Atajo de flujo: si ESTE MISMO punto validó "ok" hace instantes (p. ej.
    // "entrar a ventas" y luego confirmar "iniciar visita" segundos después),
    // se aprueba sin nueva lectura GPS: el vendedor sigue físicamente ahí y
    // re-leer solo le haría esperar otros 3-6 s. Se reporta como "ok_cache"
    // (tiempoMs=0, numFixes=0) para que la bitácora distinga estos atajos de
    // lecturas GPS reales.
    const cache = this.ultimaValidacionOk;
    if (
      cache &&
      Date.now() - cache.timestamp <= TTL_VALIDACION_CACHE_MS &&
      Math.abs(cache.clienteLat - clienteLat) < 1e-7 &&
      Math.abs(cache.clienteLng - clienteLng) < 1e-7 &&
      metrosPermitidos >= cache.metrosPermitidos
    ) {
      console.log(
        `[LocationService] Validación OK por caché (hace ${Math.round((Date.now() - cache.timestamp) / 1000)} s, sin nueva lectura GPS)`,
      );
      return {
        valido: true,
        motivo: "ok_cache",
        distancia: cache.distancia,
        accuracy: cache.accuracy,
        metrosPermitidos,
        numFixes: 0,
        peorAccuracy: 0,
        tiempoMs: 0,
      };
    }

    const ubicacion = await this.getBestLocation(
      5,
      6000,
      onProgreso,
      (coords) => {
        const accuracy = coords.accuracy ?? 999;
        if (accuracy > PRECISION_ABSURDA) return false;
        const distancia = calcularDistancia(coords.latitude, coords.longitude, clienteLat, clienteLng);
        return estaDentroDeRango(distancia, accuracy, metrosPermitidos);
      },
      (coords) => {
        const accuracy = coords.accuracy ?? 999;
        // Solo se puede fallar temprano con un GPS ya confiable; con precisión
        // mala todavía cabe que el fix refine y cambie el veredicto.
        if (accuracy > PRECISION_MAXIMA_ACEPTABLE) return false;
        const distancia = calcularDistancia(coords.latitude, coords.longitude, clienteLat, clienteLng);
        // Fuera de rango imposible de revertir: ni descontando 2 sigmas de
        // error entraría al rango. Refinar más daría el mismo veredicto.
        return distancia - 2 * accuracy > metrosPermitidos + BUFFER_MAXIMO;
      },
    );
    const diag = this.getUltimoDiagnosticoGps();
    if (!ubicacion) {
      return { valido: false, motivo: "sin_senal", metrosPermitidos, ...diag };
    }

    const accuracy = ubicacion.accuracy ?? 999;
    const distancia = calcularDistancia(ubicacion.latitude, ubicacion.longitude, clienteLat, clienteLng);
    const buffer = Math.min(accuracy, BUFFER_MAXIMO);
    const dentroDeRango = estaDentroDeRango(distancia, accuracy, metrosPermitidos);

    // 1) Si la posición medida cae dentro del rango permitido, es válida aunque
    //    el accuracy sea alto, salvo que la lectura sea absurdamente imprecisa.
    if (dentroDeRango && accuracy <= PRECISION_ABSURDA) {
      console.log(
        `[LocationService] Validación VÁLIDO: distancia=${Math.round(distancia)} m, ` +
          `permitido=${metrosPermitidos} m, buffer=${Math.round(buffer)} m, accuracy=±${Math.round(accuracy)} m`,
      );
      // Guardamos la validación exitosa: revalidaciones de este mismo punto
      // dentro de TTL_VALIDACION_CACHE_MS se aprueban al instante (ok_cache).
      this.ultimaValidacionOk = { clienteLat, clienteLng, metrosPermitidos, distancia, accuracy, timestamp: Date.now() };
      return { valido: true, motivo: "ok", distancia, accuracy, metrosPermitidos, ubicacion, ...diag };
    }

    // 2) La posición parece estar fuera de rango (o el accuracy es absurdo). Si la
    //    precisión es baja no podemos afirmar que esté fuera: pedimos reintentar.
    if (accuracy > PRECISION_MAXIMA_ACEPTABLE) {
      const esRedCelular = accuracy >= 100 && accuracy % 50 === 0;
      const motivo: MotivoValidacion = esRedCelular ? "red_no_gnss" : "precision_baja";
      console.warn(
        `[LocationService] ${esRedCelular ? "Fix de red celular" : "Precisión insuficiente"}: distancia=${Math.round(distancia)} m, ` +
          `accuracy=±${Math.round(accuracy)} m`,
      );
      return { valido: false, motivo, distancia, accuracy, metrosPermitidos, ubicacion, ...diag };
    }

    // 2.5) Contraste con tracking de fondo: si la velocidad implícita entre el
    //      último fix del tracking y el de la validación es físicamente imposible,
    //      el fix de validación es probablemente rancio/cacheado.
    //      NUNCA convertir un fix incoherente en fuera_de_rango (Fase 4.4).
    try {
      const BGService = require("./BackgroundLocationService").default;
      const ultimoTracking = BGService.getUltimoFixTracking();
      if (ultimoTracking) {
        const edadTracking = (Date.now() - ultimoTracking.timestamp) / 1000;
        if (edadTracking > 0 && edadTracking <= 30 && ultimoTracking.accuracy <= 50) {
          const distTracking = calcularDistancia(
            ubicacion.latitude, ubicacion.longitude,
            ultimoTracking.latitud, ultimoTracking.longitud,
          );
          const velocidad = distTracking / edadTracking;
          if (velocidad > 40) {
            console.warn(
              `[LocationService] Fix de validación incoherente con tracking: ` +
                `${Math.round(distTracking)} m en ${edadTracking.toFixed(1)} s = ${Math.round(velocidad)} m/s ` +
                `(máx 40 m/s). Fix probablemente cacheado.`,
            );
            return {
              valido: false,
              motivo: "precision_baja",
              distancia,
              accuracy,
              metrosPermitidos,
              ubicacion,
              ...diag,
            };
          }
        }
      }
    } catch (e) {
      // BackgroundLocationService no disponible (no crítico)
      console.warn("[LocationService] No se pudo contrastar con el tracking de fondo:", e);
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
    const net = await NetInfo.fetch().catch(() => null);
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
      conCobertura: net ? net.isConnected === true : null,
    });

    switch (r.motivo) {
      case "ok":
      case "ok_cache":
        return true;
      case "sin_permiso":
        Alert.alert(
          "Permiso de ubicación",
          "Necesitas conceder el permiso de ubicación para poder registrar la visita.",
        );
        return false;
      case "sin_senal": {
        const segundos = Math.round((r.tiempoMs ?? 0) / 1000);
        Alert.alert(
          "GPS buscando satélites",
          `El GPS lleva ${segundos}s sin encontrar satélites.\n\n` +
            `• Sal a cielo abierto\n` +
            `• Verifica que el GPS esté activado\n` +
            `• Espera 1-2 minutos sin moverte\n` +
            `• Asegúrate de tener "Precisión de ubicación de Google" activada en Ajustes > Ubicación`,
        );
        return false;
      }
      case "precision_baja": {
        const acc = r.accuracy ?? 0;
        const esRedCelular = acc >= 100 && acc % 50 === 0;
        if (esRedCelular) {
          Alert.alert(
            "Ubicación por antena celular",
            `El teléfono está usando antenas de celular en lugar de satélites GPS (precisión: ±${Math.round(acc)} m).\n\n` +
              `• Verifica en Ajustes > Ubicación que "Precisión alta" esté activada\n` +
              `• Activa la búsqueda de redes Wi-Fi en Ajustes > Ubicación\n` +
              `• Sal a cielo abierto y espera 1-2 minutos`,
          );
        } else {
          Alert.alert(
            "Señal GPS débil",
            `La precisión del GPS es de ±${Math.round(acc)} m. Se requiere ±50 m o mejor.\n\n` +
              `• Sal a cielo abierto\n` +
              `• Espera 1-2 minutos sin moverte para que el GPS mejore\n` +
              `• Evita estar bajo techos metálicos o entre edificios altos`,
          );
        }
        return false;
      }
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
      case "red_no_gnss": {
        Alert.alert(
          "GPS no disponible — usando antena celular",
          `El teléfono está determinando tu ubicación por antenas de celular (precisión: ±${Math.round(r.accuracy ?? 0)} m), no por satélites GPS.\n\n` +
            `• Verifica en Ajustes > Ubicación que "Precisión alta" esté activada\n` +
            `• Activa la búsqueda de redes Wi-Fi en Ajustes > Ubicación > Servicios\n` +
            `• Sal a cielo abierto y espera 1-2 minutos\n` +
            `• Si el problema persiste, reinicia la app`,
        );
        return false;
      }
      default:
        return false;
    }
  }

  async validarUbicacionConDiagnostico(
    clienteLat: number,
    clienteLng: number,
    metrosPermitidos: number,
    onProgreso?: (intento: number, total: number, accuracy: number) => void,
    clienteInfo?: { id?: number; nombre?: string; lat?: number; lng?: number },
  ): Promise<ValidacionUbicacionResultado> {
    const r = await this.validarUbicacionCliente(clienteLat, clienteLng, metrosPermitidos, onProgreso);

    const net = await NetInfo.fetch().catch(() => null);
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
      conCobertura: net ? net.isConnected === true : null,
    });

    return r;
  }
}

export default new LocationService();
