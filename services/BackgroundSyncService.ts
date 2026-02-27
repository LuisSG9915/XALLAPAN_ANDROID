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

import FullSyncService from "./FullSyncService";
import { SyncProgress } from "./sync/SyncTask";
import AuthService from "./AuthService";
import BackgroundFetch from "react-native-background-fetch";
import BitacoraService from "./BitacoraService";
import GpsBitacoraService from "./GpsBitacoraService";

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
  private readonly SYNC_INTERVAL_MINUTES = 3; // Para BackgroundFetch
  private readonly BACKGROUND_FETCH_TASK_ID = "com.awesomeproject.sync";

  // Estado interno
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isBackgroundFetchConfigured = false;
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
      status: this.state.status,
    });

    // Si ya está activo, no hacer nada
    if (this.intervalId) {
      console.log("[BackgroundSync] ✅ Ya está activo, ignorando llamada duplicada");
      return;
    }

    console.log("[BackgroundSync] 🚀 Iniciando sincronización automática cada 3 minutos");

    // Calcular próxima sincronización
    const nextSync = new Date(Date.now() + this.SYNC_INTERVAL_MS);
    this.updateState({
      status: "idle",
      nextSyncTime: nextSync,
    });

    // DESACTIVADO: BackgroundFetch causa sincronizaciones adicionales impredecibles
    // El sistema operativo decide cuándo ejecutarlo, no respeta el intervalo exacto
    // Usar solo setInterval para control preciso de 3 minutos
    /*
    if (!this.isBackgroundFetchConfigured) {
      await this.configureBackgroundFetch();
    }
    */

    // Crear intervalo para sincronización cada 3 minutos (preciso)
    this.intervalId = setInterval(() => {
      this.performSync();
    }, this.SYNC_INTERVAL_MS);
    console.log("[BackgroundSync] ✅ Intervalo de 3 minutos configurado");

    // Ejecutar primera sincronización inmediatamente solo si es la primera vez
    if (!this.state.lastSyncTime) {
      console.log("[BackgroundSync] Ejecutando primera sincronización inmediata");
      this.performSync();
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

          try {
            await this.performSync();
          } catch (error) {
            console.error("[BackgroundFetch] Error en sincronización:", error);
          }

          // IMPORTANTE: Siempre llamar finish() cuando termine
          BackgroundFetch.finish(taskId);
        },
        async (taskId) => {
          // Callback de timeout - la tarea tomó demasiado tiempo
          console.warn("[BackgroundFetch] Timeout de tarea:", taskId);
          BackgroundFetch.finish(taskId);
        }
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
    await this.performSync();
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
  private async performSync(): Promise<void> {
    const syncStartTime = Date.now();
    console.log("[BackgroundSync] 🔄 performSync llamado", {
      currentStatus: this.state.status,
      lastSync: this.state.lastSyncTime,
      nextSync: this.state.nextSyncTime,
    });

    // Si ya está sincronizando, no iniciar otra
    if (this.state.status === "syncing") {
      console.warn("[BackgroundSync] ⚠️ Ya hay una sincronización en curso, omitiendo");
      return;
    }

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

    this.updateState({
      status: "syncing",
      currentProgress: null,
      errorMessage: null,
    });

    // Timeout de seguridad: si la sincronización tarda más de 5 minutos, forzar finalización
    const timeoutId = setTimeout(() => {
      console.error("[BackgroundSync] ⏱️ TIMEOUT: Sincronización tardó más de 5 minutos, forzando finalización");
      const nextSync = new Date(Date.now() + this.SYNC_INTERVAL_MS);
      this.updateState({
        status: "error",
        nextSyncTime: nextSync,
        currentProgress: null,
        errorMessage: "Timeout: La sincronización tardó demasiado",
      });
    }, 5 * 60 * 1000); // 5 minutos

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
        idUsuario
      );

      // Actualizar estado según resultado
      const now = new Date();
      const nextSync = new Date(now.getTime() + this.SYNC_INTERVAL_MS);

      // Limpiar timeout
      clearTimeout(timeoutId);

      const syncDuration = Date.now() - syncStartTime;
      console.log(
        `[BackgroundSync] Sincronización finalizada en ${syncDuration}ms - Sucursal: ${sucursal}, Usuario: ${idUsuario}`
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
          `[BackgroundSync] ✅ Sincronización completada exitosamente (Sucursal: ${sucursal}, Usuario: ${idUsuario})`
        );
        
        // Enviar bitácoras pendientes al final de sincronización exitosa
        try {
          console.log("[BackgroundSync] Enviando bitácoras pendientes al finalizar...");
          await BitacoraService.enviarBitacorasPendientes(sucursal, idUsuario);
          console.log("[BackgroundSync] Enviando bitácoras GPS pendientes al finalizar...");
          await GpsBitacoraService.enviarBitacorasPendientes(sucursal, idUsuario);
        } catch (bitacoraError) {
          console.warn("[BackgroundSync] Error enviando bitácoras, no es crítico:", bitacoraError);
        }
      } else {
        this.updateState({
          status: "error",
          lastSyncTime: now,
          nextSyncTime: nextSync,
          currentProgress: null,
          errorMessage: result.error || "Error desconocido",
        });
        console.log(
          `[BackgroundSync] ❌ Sincronización completada con errores (Sucursal: ${sucursal}, Usuario: ${idUsuario}):`,
          result.error
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
