/**
 * BackgroundSyncService
 *
 * Servicio UNIFICADO para sincronización automática.
 *
 * Arquitectura:
 * - Primer plano: setInterval cada 3 minutos (preciso)
 * - Segundo plano: BackgroundFetch + HeadlessTask en index.js
 *
 * IMPORTANTE: La sincronización real se delega a FullSyncService.syncAll()
 * que maneja la arquitectura escalable con:
 * - SyncOrchestrator para dependencias
 * - SyncLog principal y SyncTableLog por tabla
 * - Retry logic con exponential backoff
 */

import { ToastAndroid, Platform } from "react-native";
import FullSyncService from "./FullSyncService";
import { SyncProgress } from "./sync/SyncTask";
import AuthService from "./AuthService";
import BackgroundFetch from "react-native-background-fetch";
import BitacoraService from "./BitacoraService";
import GpsBitacoraService from "./GpsBitacoraService";
import BackgroundActions from "react-native-background-actions";

export type SyncStatus =
  | "idle" // No sincronizando
  | "syncing" // Sincronizando activamente
  | "success" // Última sincronización exitosa
  | "error"; // Error en última sincronización

export interface BackgroundSyncState {
  status: SyncStatus;
  lastSyncTime: Date | null;
  nextSyncTime: Date | null;
  currentProgress: SyncProgress | null;
  errorMessage: string | null;
  syncCount: number;
  sucursal?: number;
  idUsuario?: number;
}

type StateListener = (state: BackgroundSyncState) => void;

class BackgroundSyncService {
  private static instance: BackgroundSyncService;

  // Configuración
  private readonly SYNC_INTERVAL_MS = 3 * 60 * 1000; // 3 minutos
  private readonly SYNC_INTERVAL_MINUTES = 15; // Para BackgroundFetch
  private readonly BACKGROUND_FETCH_TASK_ID = "com.awesomeproject.sync";

  // Estado interno
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isBackgroundFetchConfigured = false;
  // Bandera para evitar carreras concurrentes en start()
  private isStarting = false;
  // Bandera para cancelar la sincronización en curso entre tareas
  private cancelRequested = false;
  // Último intento de sincronización (para evitar syncs más frecuentes que el intervalo)
  private lastSyncAttemptTime: number | null = null;
  private state: BackgroundSyncState = {
    status: "idle",
    lastSyncTime: null,
    nextSyncTime: null,
    currentProgress: null,
    errorMessage: null,
    syncCount: 0,
  };

  // Listeners para notificar cambios de estado
  private listeners: Set<StateListener> = new Set();

  private constructor() {}

  static getInstance(): BackgroundSyncService {
    if (!BackgroundSyncService.instance) {
      BackgroundSyncService.instance = new BackgroundSyncService();
    }
    return BackgroundSyncService.instance;
  }

  /**
   * Inicia la sincronización automática en segundo plano
   * Usa react-native-background-fetch para funcionar con pantalla apagada
   */
  async start(): Promise<void> {
    console.log("[BackgroundSync] 🔍 start() llamado", {
      intervalId: !!this.intervalId,
      isStarting: this.isStarting,
      status: this.state.status,
    });

    // Si ya está activo o iniciándose, no hacer nada
    if (this.intervalId || this.isStarting) {
      console.log("[BackgroundSync] ✅ Ya está activo o iniciándose, ignorando llamada duplicada");
      return;
    }

    this.isStarting = true;

    try {
      // Configurar BackgroundFetch para sincronización en segundo plano
      await this.configureBackgroundFetch();

      // Doble chequeo: otro start pudo haber creado el intervalo mientras se configuraba
      if (this.intervalId) {
        console.log("[BackgroundSync] ✅ Intervalo creado por otra llamada mientras se configuraba");
        return;
      }

      // Iniciar intervalo de sincronización en primer plano (cada 3 minutos)
      this.intervalId = setInterval(() => {
        this.performSync();
      }, this.SYNC_INTERVAL_MS);

      const nextSync = new Date(Date.now() + this.SYNC_INTERVAL_MS);
      this.updateState({
        status: "idle",
        nextSyncTime: nextSync,
        errorMessage: null,
      });

      console.log(
        "[BackgroundSync] ✅ Sincronización automática iniciada. Intervalo:",
        this.SYNC_INTERVAL_MS,
        "ms",
      );

      // Ejecutar sincronización inicial sin bloquear
      this.performSync().catch((error) => {
        console.error("[BackgroundSync] Error en sincronización inicial:", error);
      });
    } catch (error) {
      console.error("[BackgroundSync] ❌ Error al iniciar sincronización automática:", error);
      this.updateState({
        status: "error",
        errorMessage: "No se pudo iniciar la sincronización automática",
      });
    } finally {
      this.isStarting = false;
    }
  }

  /**
   * Configura react-native-background-fetch para sincronización en segundo plano
   *
   * NOTA: El HeadlessTask está registrado en index.js (nivel superior)
   * Este método solo configura el intervalo y callbacks de la app activa
   */
  private async configureBackgroundFetch(): Promise<void> {
    if (this.isBackgroundFetchConfigured) {
      return;
    }

    try {
      // Configurar BackgroundFetch
      const status = await BackgroundFetch.configure(
        {
          minimumFetchInterval: this.SYNC_INTERVAL_MINUTES, // Intervalo mínimo en minutos
          stopOnTerminate: false, // Continuar después de cerrar la app
          startOnBoot: true, // Iniciar al reiniciar el dispositivo
          enableHeadless: true, // Permite ejecución sin UI (HeadlessTask en index.js)
          forceAlarmManager: true, // Usar AlarmManager para mayor precisión en Android
          requiredNetworkType: BackgroundFetch.NETWORK_TYPE_ANY, // Requiere conexión de red
        },
        async (taskId) => {
          // Este callback se ejecuta cuando la app está activa
          console.log("[BackgroundFetch] Tarea recibida (app activa):", taskId);

          // Si el intervalo de primer plano ya está corriendo, no duplicar la sync
          if (this.intervalId) {
            console.log("[BackgroundFetch] Intervalo de primer plano activo, omitiendo sync");
          } else {
            try {
              await this.performSync();
            } catch (error) {
              console.error("[BackgroundFetch] Error en sincronización:", error);
            }
          }

          // IMPORTANTE: Siempre llamar finish() cuando termine
          BackgroundFetch.finish(taskId);
        },
        async (taskId) => {
          // Callback de timeout - la tarea tomó demasiado tiempo
          console.warn("[BackgroundFetch] Timeout de tarea:", taskId);
          BackgroundFetch.finish(taskId);
        },
      );

      // Verificar estado de BackgroundFetch
      const statusText = this.getBackgroundFetchStatusText(status);
      console.log("[BackgroundFetch] Estado:", statusText);

      // NOTA: HeadlessTask está registrado en index.js, no aquí
      // Esto evita duplicación y asegura que funcione cuando la app está cerrada

      this.isBackgroundFetchConfigured = true;
      console.log("[BackgroundFetch] Configurado exitosamente");
    } catch (error) {
      console.error("[BackgroundFetch] Error al configurar:", error);
    }
  }

  /**
   * Obtiene texto descriptivo del estado de BackgroundFetch
   */
  private getBackgroundFetchStatusText(status: number): string {
    switch (status) {
      case BackgroundFetch.STATUS_RESTRICTED:
        return "Restringido (configuración del sistema)";
      case BackgroundFetch.STATUS_DENIED:
        return "Denegado (el usuario debe habilitarlo)";
      case BackgroundFetch.STATUS_AVAILABLE:
        return "Disponible";
      default:
        return "Desconocido";
    }
  }

  /**
   * Detiene la sincronización automática
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("[BackgroundSync] Sincronización automática detenida");

      this.updateState({
        status: "idle",
        nextSyncTime: null,
      });
    }
  }

  /**
   * Verifica si la sincronización automática está activa
   */
  isActive(): boolean {
    return this.intervalId !== null;
  }

  /**
   * Obtiene el estado actual
   */
  getState(): BackgroundSyncState {
    return { ...this.state };
  }

  /**
   * Suscribe un listener para recibir actualizaciones de estado
   */
  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    // Notificar estado actual inmediatamente
    listener(this.getState());

    // Retornar función para desuscribirse
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Ejecuta una sincronización manual (no afecta el intervalo automático)
   */
  async syncNow(): Promise<void> {
    await this.performSync(true);
  }

  /**
   * Dispara una sincronización parcial bajo demanda (ej. al finalizar una venta).
   *
   * Reglas:
   * - Si ya hay una sincronización corriendo, se solicita su cancelación y se
   *   espera a que termine (corta entre tareas), antes de iniciar una nueva.
   * - Reinicia el temporizador de 3 minutos para evitar que la siguiente
   *   sincronización automática se ejecute encima.
   * - Muestra avisos Toast al inicio y al final (Android).
   *
   * NOTA: No se permite ejecutar dos sincronizaciones parciales en paralelo;
   * el método actúa como un "mutex" lógico vía el estado `status === "syncing"`.
   */
  async triggerPartialSync(reason: string = "manual"): Promise<void> {
    console.log(`[BackgroundSync] 🔔 triggerPartialSync (motivo: ${reason})`);

    // Si ya hay una sincronización en curso, pedir cancelación y esperar
    if (this.state.status === "syncing") {
      console.log("[BackgroundSync] ⏸️ Sync en curso, solicitando cancelación para reiniciar...");
      if (Platform.OS === "android") {
        ToastAndroid.show("Reiniciando sincronización...", ToastAndroid.SHORT);
      }
      this.cancelRequested = true;

      // Esperar a que la sincronización en curso libere el estado (máx 30s)
      const maxWaitMs = 30000;
      const pollMs = 200;
      const start = Date.now();
      while (this.state.status === "syncing" && Date.now() - start < maxWaitMs) {
        await new Promise<void>((resolve) => setTimeout(() => resolve(), pollMs));
      }

      if (this.state.status === "syncing") {
        console.warn("[BackgroundSync] ⚠️ La sync anterior no liberó el estado en 30s, abortando trigger");
        return;
      }
      console.log("[BackgroundSync] ✅ Sync anterior cancelada, iniciando nueva");
    } else {
      if (Platform.OS === "android") {
        ToastAndroid.show("Sincronizando...", ToastAndroid.SHORT);
      }
    }

    // Reiniciar el intervalo automático para evitar solapes con la sync de 3 minutos
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = setInterval(() => {
        this.performSync();
      }, this.SYNC_INTERVAL_MS);
      const nextSync = new Date(Date.now() + this.SYNC_INTERVAL_MS);
      this.updateState({ nextSyncTime: nextSync });
    }

    try {
      await this.performSync(true);
      if (Platform.OS === "android" && this.state.status === "success") {
        ToastAndroid.show("Sincronización completa", ToastAndroid.SHORT);
      }
    } catch (error) {
      console.error("[BackgroundSync] Error en triggerPartialSync:", error);
    }
  }

  /**
   * Actualiza el estado y notifica a los listeners
   */
  private updateState(updates: Partial<BackgroundSyncState>): void {
    this.state = {
      ...this.state,
      ...updates,
    };

    // Notificar a todos los listeners
    this.listeners.forEach((listener) => {
      try {
        listener(this.getState());
      } catch (error) {
        console.error("[BackgroundSync] Error en listener:", error);
      }
    });
  }

  /**
   * Ejecuta el proceso de sincronización
   *
   * NOTA: Delega toda la lógica a FullSyncService.syncAll() que maneja:
   * - SyncLog principal
   * - SyncTableLog por tabla
   * - Retry logic con exponential backoff
   * - Dependencias entre tablas
   */
  private async performSync(force = false): Promise<void> {
    const syncStartTime = Date.now();
    console.log("[BackgroundSync] 🔄 performSync llamado", {
      currentStatus: this.state.status,
      lastSync: this.state.lastSyncTime,
      nextSync: this.state.nextSyncTime,
      force,
    });

    // Si ya está sincronizando, no iniciar otra
    if (this.state.status === "syncing") {
      console.warn("[BackgroundSync] ⚠️ Ya hay una sincronización en curso, omitiendo");
      return;
    }

    // Guarda de frecuencia mínima: evita que dos disparadores (setInterval, BackgroundFetch,
    // llamadas concurrentes a start) ejecuten una sync antes de que pase el tiempo configurado.
    if (
      !force &&
      this.lastSyncAttemptTime &&
      syncStartTime - this.lastSyncAttemptTime < this.SYNC_INTERVAL_MS - 5000
    ) {
      const secondsSinceLast = Math.round((syncStartTime - this.lastSyncAttemptTime) / 1000);
      console.warn(
        `[BackgroundSync] ⚠️ Sincronización intentada a los ${secondsSinceLast}s, omitiendo (mínimo ${this.SYNC_INTERVAL_MS / 1000}s)`,
      );
      return;
    }

    // Registrar el intento ANTES de cualquier await para bloquear reentradas concurrentes
    this.lastSyncAttemptTime = syncStartTime;

    // Verificar si hay usuario logueado ANTES de cambiar estado
    const user = await AuthService.restoreSession();
    if (!user) {
      console.log("[BackgroundSync] No hay usuario logueado, omitiendo sincronización");
      // Actualizar nextSyncTime para que no se quede en "Ahora"
      const nextSync = new Date(Date.now() + this.SYNC_INTERVAL_MS);
      this.updateState({ nextSyncTime: nextSync });
      return;
    }

    console.log("[BackgroundSync] Iniciando sincronización...");

    // Resetear bandera de cancelación al inicio de cada sync
    this.cancelRequested = false;

    this.updateState({
      status: "syncing",
      currentProgress: null,
      errorMessage: null,
    });

    // Timeout de seguridad: si la sincronización tarda más de 1 minuto, forzar cancelación
    const timeoutId = setTimeout(() => {
      console.error(
        "[BackgroundSync] ⏱️ TIMEOUT: Sincronización automática superó 1 minuto, cancelando...",
      );
      this.cancelRequested = true;
      const nextSync = new Date(Date.now() + this.SYNC_INTERVAL_MS);
      this.updateState({
        status: "error",
        nextSyncTime: nextSync,
        currentProgress: null,
        errorMessage:
          "Sincronización cancelada: superó 1 minuto por inestabilidad de red o conexión muy lenta",
      });
    }, 60 * 1000); // 1 minuto

    try {
      const sucursal = user.sucursal_origen || user.sucursal || 1;
      const idUsuario: number = Number(user.id ?? user.idUsuario ?? 1);
      console.log("[BackgroundSync] Sincronizando sucursal:", sucursal, "usuario:", idUsuario);

      // Ejecutar sincronización INCREMENTAL usando arquitectura escalable
      // syncIncremental() ahora envía automáticamente ventas pendientes al inicio
      // y luego usa fechaInicial basada en syncedAr por tabla con los nuevos endpoints
      const result = await FullSyncService.syncIncremental(
        sucursal,
        (progress: SyncProgress) => {
          this.updateState({
            currentProgress: progress,
          });
        },
        idUsuario,
        () => this.cancelRequested,
      );

      // Actualizar estado según resultado
      const now = new Date();
      const nextSync = new Date(now.getTime() + this.SYNC_INTERVAL_MS);

      // Limpiar timeout
      clearTimeout(timeoutId);

      const syncDuration = Date.now() - syncStartTime;
      console.log(
        `[BackgroundSync] Sincronización finalizada en ${syncDuration}ms - Sucursal: ${sucursal}, Usuario: ${idUsuario}`,
      );

      if (result.success) {
        this.updateState({
          status: "success",
          lastSyncTime: now,
          nextSyncTime: nextSync,
          currentProgress: null,
          errorMessage: null,
          syncCount: this.state.syncCount + 1,
          sucursal,
          idUsuario,
        });
        console.log(
          `[BackgroundSync] ✅ Sincronización completada exitosamente (Sucursal: ${sucursal}, Usuario: ${idUsuario})`,
        );

        // Enviar bitácoras pendientes al final de sincronización exitosa
        try {
          console.log("[BackgroundSync] Enviando bitácoras pendientes al finalizar...");
          await BitacoraService.enviarBitacorasPendientes(sucursal, idUsuario);
          console.log("[BackgroundSync] Enviando bitácoras GPS pendientes al finalizar...");
          await GpsBitacoraService.enviarBitacorasPendientes(sucursal, idUsuario);
          console.log("[BackgroundSync] Enviando bitácoras de tracking GPS pendientes al finalizar...");
          await GpsBitacoraService.enviarTrackingPendientes(sucursal, idUsuario);
          console.log("[BackgroundSync] Enviando bitácoras de validación de ubicación pendientes al finalizar...");
          await GpsBitacoraService.enviarValidacionesPendientes(sucursal, idUsuario);
          console.log("[BackgroundSync] Enviando bitácoras de tiempos de venta pendientes al finalizar...");
          await GpsBitacoraService.enviarTiemposVentaPendientes(sucursal, idUsuario);
          console.log("[BackgroundSync] Limpiando registros GPS enviados antiguos...");
          GpsBitacoraService.limpiarRegistrosEnviados(7);
        } catch (bitacoraError) {
          console.warn("[BackgroundSync] Error enviando bitácoras, no es crítico:", bitacoraError);
        }

        // Verificar si el GPS en segundo plano sigue vivo y reiniciarlo si es necesario
        this.checkAndRestartGpsTracking(sucursal, idUsuario);
      } else {
        const errorMessage = this.cancelRequested
          ? "Sincronización cancelada: superó 1 minuto por inestabilidad de red o conexión muy lenta"
          : result.error || "Error desconocido";
        this.updateState({
          status: "error",
          lastSyncTime: now,
          nextSyncTime: nextSync,
          currentProgress: null,
          errorMessage,
        });
        console.log(
          `[BackgroundSync] ❌ Sincronización completada con errores (Sucursal: ${sucursal}, Usuario: ${idUsuario}):`,
          result.error,
        );
      }
    } catch (error: any) {
      // Limpiar timeout
      clearTimeout(timeoutId);

      const errorMsg = error?.message || "Error desconocido";
      const syncDuration = Date.now() - syncStartTime;
      console.error(`[BackgroundSync] ❌ Error crítico en sincronización (${syncDuration}ms):`, errorMsg);
      console.error("[BackgroundSync] Stack trace:", error?.stack);

      const nextSync = new Date(Date.now() + this.SYNC_INTERVAL_MS);

      this.updateState({
        status: "error",
        nextSyncTime: nextSync,
        currentProgress: null,
        errorMessage: errorMsg,
      });
    } finally {
      // Garantizar que siempre se actualice nextSyncTime
      if (!this.state.nextSyncTime || this.state.nextSyncTime.getTime() <= Date.now()) {
        console.warn("[BackgroundSync] ⚠️ nextSyncTime no válido en finally, actualizando");
        const nextSync = new Date(Date.now() + this.SYNC_INTERVAL_MS);
        this.updateState({ nextSyncTime: nextSync });
      }
    }
  }

  /**
   * Ejecuta una sincronización desde un contexto headless (BackgroundFetch).
   * Inicializa servicios y ejecuta sync completa.
   * Debe llamarse desde el HeadlessTask registrado en index.js.
   */
  async performHeadlessSync(taskId: string): Promise<void> {
    const TAG = "[BackgroundSync:Headless]";
    console.log(TAG, "Iniciando sincronización headless, taskId:", taskId);

    try {
      await FullSyncService.initialize();

      const user = await AuthService.restoreSession();
      if (!user) {
        console.log(TAG, "No hay usuario logueado, omitiendo");
        BackgroundFetch.finish(taskId);
        return;
      }

      const sucursal = user.sucursal_origen || user.sucursal || 1;
      const idUsuario: number = Number(user.id ?? user.idUsuario ?? 1);

      try {
        await GpsBitacoraService.enviarTrackingPendientes(sucursal, idUsuario);
      } catch (trackingError) {
        console.warn(TAG, "Error enviando tracking GPS headless:", trackingError);
      }

      const result = await FullSyncService.syncIncremental(
        sucursal,
        () => {},
        idUsuario,
        () => false,
      );

      if (result.success) {
        await BitacoraService.enviarBitacorasPendientes(sucursal, idUsuario);
        await GpsBitacoraService.enviarBitacorasPendientes(sucursal, idUsuario);
        await GpsBitacoraService.enviarTrackingPendientes(sucursal, idUsuario);
        await GpsBitacoraService.enviarValidacionesPendientes(sucursal, idUsuario);
        await GpsBitacoraService.enviarTiemposVentaPendientes(sucursal, idUsuario);
        GpsBitacoraService.limpiarRegistrosEnviados(7);
        console.log(TAG, "Sincronización headless completada exitosamente");
      } else {
        console.warn(TAG, "Sincronización headless con errores:", result.error);
      }
    } catch (error: any) {
      console.error(TAG, "Error en sincronización headless:", error?.message || error);
    } finally {
      BackgroundFetch.finish(taskId);
    }
  }

  /**
   * Si el servicio de tracking GPS en segundo plano se detuvo (por Doze
   * o por ser matado por el sistema), intenta reiniciarlo. Se invoca
   * desde el heartbeat de background-fetch (cada ~3 min) como red de
   * seguridad adicional al WakeLock.
   */
  private async checkAndRestartGpsTracking(sucursal: number, idUsuario: number): Promise<void> {
    try {
      const CierreRutaService = require("./CierreRutaService").default;
      const vendedor = idUsuario || 0;
      const rutaStatus = await CierreRutaService.getRutaStatus(sucursal, vendedor);

      if (rutaStatus) {
        return;
      }

      if (BackgroundActions.isRunning()) {
        return;
      }

      console.log("[BackgroundSync] GPS tracking detenido con ruta abierta, reintentando...");
      const BackgroundLocationService = require("./BackgroundLocationService").default;
      await BackgroundLocationService.start();
      console.log("[BackgroundSync] GPS tracking reiniciado por heartbeat");
    } catch (e) {
      console.warn("[BackgroundSync] No se pudo reiniciar GPS tracking:", e);
    }
  }

  /**
   * Formatea el tiempo restante hasta la próxima sincronización
   */
  getTimeUntilNextSync(): string | null {
    if (!this.state.nextSyncTime) return null;

    const now = Date.now();
    const next = this.state.nextSyncTime.getTime();
    const diff = next - now;

    // Si el tiempo ya pasó y el estado no es "syncing", hay un problema
    if (diff <= 0) {
      if (this.state.status !== "syncing") {
        console.warn("[BackgroundSync] ⚠️ Tiempo de sync pasado pero no está sincronizando. Forzando actualización.");
        // Forzar actualización del nextSyncTime
        const nextSync = new Date(Date.now() + this.SYNC_INTERVAL_MS);
        this.updateState({ nextSyncTime: nextSync });
      }
      return "Ahora";
    }

    const minutes = Math.floor(diff / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);

    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }
}

export default BackgroundSyncService.getInstance();
