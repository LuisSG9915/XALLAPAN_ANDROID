/**
 * BackgroundSyncService
 *
 * Servicio UNIFICADO para sincronización automática ROBUSTA.
 *
 * Arquitectura:
 * - Implementado con 'react-native-background-actions' (Servicio en Primer Plano)
 * - Ejecuta un bucle infinito mientras el servicio está activo
 * - Intervalo de 3 minutos de descanso entre sincronizaciones
 * - Persiste aun si la app se cierra (en la mayoría de los casos de Android)
 * - Intenta reabrir la app si se requiere (limitado por el SO)
 */

import FullSyncService from "./FullSyncService";
import { SyncProgress } from "./sync/SyncTask";
import AuthService from "./AuthService";
import BatteryOptimizations from "./BatteryOptimizations";
import BackgroundService from "react-native-background-actions";
import { Platform, PermissionsAndroid } from "react-native";
import { constGenerales } from "../constGenerales";

export type SyncStatus =
  | "idle" // No sincronizando (esperando siguiente ciclo)
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
  isServiceRunning: boolean;
}

type StateListener = (state: BackgroundSyncState) => void;

// Opciones para la notificación persistente del servicio
const options = {
  taskName: "Xallapan Sync",
  taskTitle: "Sincronización Activa",
  taskDesc: "Manteniendo datos actualizados...",
  taskIcon: {
    name: "ic_launcher",
    type: "mipmap",
  },
  color: "#ff00ff",
  linkingURI: "xallapan://open",
  parameters: {
    delay: constGenerales.SYNC_INTERVAL_MS,
  },
  // Prioridad máxima para evitar suspensión
  notificationImportance: 'high',
  notificationPriority: 'high',
  stopWithTask: false, // Vital para Samsung
};

const sleep = (time: number) => new Promise<void>((resolve) => setTimeout(() => resolve(), time));

class BackgroundSyncService {
  private static instance: BackgroundSyncService;

  // Configuración
  private get SYNC_INTERVAL_MS() {
    return constGenerales.SYNC_INTERVAL_MS;
  }

  // Estado interno
  private state: BackgroundSyncState = {
    status: "idle",
    lastSyncTime: null,
    nextSyncTime: null,
    currentProgress: null,
    errorMessage: null,
    syncCount: 0,
    isServiceRunning: false,
  };

  // Listeners para notificar cambios de estado
  private listeners: Set<StateListener> = new Set();
  
  // Referencia al intervalo para actualizar UI cuando el servicio corre en otro hilo JS (si aplica)
  // Nota: En RN Background Actions, el código corre en el mismo bundle JS pero mantenido vivo por el servicio nativo.
  
  private constructor() {}

  static getInstance(): BackgroundSyncService {
    if (!BackgroundSyncService.instance) {
      BackgroundSyncService.instance = new BackgroundSyncService();
    }
    return BackgroundSyncService.instance;
  }

  private isLoopRunning = false;

  /**
   * Solicita permisos de notificación (Requerido para Android 13+)
   * Sin este permiso, el Foreground Service no puede mostrar la notificación 
   * y el SO lo mata al entrar en background.
   */
  private async requestNotificationPermission(): Promise<boolean> {
    if (Platform.OS !== "android" || Platform.Version < 33) return true;

    try {
      const check = await PermissionsAndroid.check("android.permission.POST_NOTIFICATIONS" as any);
      if (check) return true;

      const response = await PermissionsAndroid.request("android.permission.POST_NOTIFICATIONS" as any, {
        title: "Sincronización en Segundo Plano",
        message: "Se requiere permiso de notificaciones para mantener la sincronización activa mientras la app está cerrada.",
        buttonPositive: "Permitir",
        buttonNegative: "Más tarde"
      });

      return response === PermissionsAndroid.RESULTS.GRANTED;
    } catch (error) {
      console.warn("[BackgroundSync] Error solicitando permiso notificación:", error);
      return false;
    }
  }

  /**
   * La tarea intensiva que se ejecutará en segundo plano
   */
  private backgroundTask = async (taskDataArguments?: { delay: number }) => {
    if (this.isLoopRunning) return;
    this.isLoopRunning = true;

    try {
      console.log("[BackgroundSync] 🚀 Loop iniciado (Heartbeat activo)");

      while (BackgroundService.isRunning() && this.isLoopRunning) {
        try {
          const currentDelay = Math.floor(this.SYNC_INTERVAL_MS);
          
          // 1. Ejecutar sincronización
          console.log(`[BackgroundSync] 🔄 Iniciando Sync Periodica (${new Date().toLocaleTimeString()})`);
          await Promise.race([
            this.performSync(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout Sync")), 120000))
          ]).catch(err => console.error("[BackgroundSync] Sync falló:", err));

          // 2. Establecer próxima ejecución
          const nextSync = new Date(Date.now() + currentDelay);
          this.updateState({
            status: "idle",
            nextSyncTime: nextSync,
            isServiceRunning: true
          });

          // 3. Hearbeat Loop (Súper Agresivo para Samsung)
          let remaining = currentDelay;
          let dotCount = 0;
          let loopSec = 0;
          
          console.log(`[BackgroundSync] 💤 Entrando en espera de ${remaining}ms`);
          
          while (remaining > 0 && BackgroundService.isRunning() && this.isLoopRunning) {
            const timeStr = this.getTimeUntilNextSync();
            dotCount = (dotCount + 1) % 4;
            loopSec = (loopSec + 1) % 100;
            const dots = ".".repeat(dotCount);
            
            // Actualización visual CADA SEGUNDO para "engañar" al ahorro de energía
            await BackgroundService.updateNotification({
              taskTitle: `Xallapan: Sincronización Activa${dots}`,
              taskDesc: `Siguiente actualización en: ${timeStr} [${loopSec}] 🔄`,
              progressBar: {
                max: currentDelay,
                value: currentDelay - remaining,
                indeterminate: false
              }
            }).catch(() => {});
            
            const step = 1000; // Revisar cada 1 segundo
            await sleep(step);
            remaining -= step;
          }

        } catch (error) {
          console.error("[BackgroundSync] Error en ciclo:", error);
          await sleep(10000); 
        }
      }
    } finally {
      this.isLoopRunning = false;
      console.log("[BackgroundSync] 🛑 Loop finalizado.");
    }
  };

  /**
   * Inicia el servicio de sincronización robusta
   */
  async start(): Promise<void> {
    if (BackgroundService.isRunning() && this.isLoopRunning) {
      return;
    }

    console.log("[BackgroundSync] Iniciando proceso de arranque...");

    // 1. Requerido para Android 13+: Permiso de notificación
    await this.requestNotificationPermission();

    // 2. Reinicio limpio si es necesario
    if (BackgroundService.isRunning()) {
      await BackgroundService.stop();
      await sleep(500);
    }

    try {
      // 3. Optimización de batería
      BatteryOptimizations.requestDisableBatteryOptimizations().catch(() => {});

      // 4. Iniciar servicio nativo
      await BackgroundService.start(this.backgroundTask, options);
      this.updateState({ isServiceRunning: true });
      console.log("[BackgroundSync] ✅ Servicio iniciado y loop corriendo");
    } catch (e) {
      console.error("[BackgroundSync] ❌ Error en arranque:", e);
      this.updateState({ isServiceRunning: false, errorMessage: "Error al iniciar" });
    }
  }

  /**
   * Detiene el servicio
   */
  async stop(): Promise<void> {
    console.log("[BackgroundSync] Deteniendo servicio...");
    await BackgroundService.stop();
    this.updateState({ 
      isServiceRunning: false,
      status: "idle",
      nextSyncTime: null
    });
  }

  /**
   * Verifica si el servicio está corriendo
   */
  isActive(): boolean {
    return BackgroundService.isRunning();
  }

  /**
   * Obtiene el tiempo restante para la próxima sincronización
   */
  getTimeUntilNextSync(): string | null {
    if (!this.state.nextSyncTime) return null;
    
    const now = Date.now();
    const next = this.state.nextSyncTime.getTime();
    const diff = next - now;
    
    if (diff <= 0) return "Ahora";
    
    const minutes = Math.floor(diff / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }


  /**
   * Ejecuta la sincronización real
   */
  private async performSync(): Promise<void> {
    const syncStartTime = Date.now();
    console.log("[BackgroundSync] 🔄 performSync iniciando...");

    // Notificar en la barra que empezamos
    await BackgroundService.updateNotification({
      taskTitle: "Xallapan: Sincronizando...",
      taskDesc: "Procesando datos en segundo plano... ⏳",
    });

    // Verificar usuario - IMPORTANTE: restoreSession debe funcionar en background
    const user = await AuthService.restoreSession();
    if (!user) {
      console.log("[BackgroundSync] Sin sesión activa para sincronizar.");
      await BackgroundService.updateNotification({
        taskDesc: "Sesión expirada. Por favor abre la app.",
      });
      return;
    }

    this.updateState({
      status: "syncing",
      currentProgress: null,
      errorMessage: null,
    });

    try {
      const sucursal = user.sucursal_origen || user.sucursal || 1;
      const idUsuario: number = Number(user.id ?? user.idUsuario ?? 1);

      const result = await FullSyncService.syncIncremental(
        sucursal,
        (progress: SyncProgress) => {
          this.updateState({ currentProgress: progress });
          
          // Actualizar notificación con progreso real
          const percent = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
          BackgroundService.updateNotification({
            taskDesc: `Sincronizando ${progress.entity}: ${percent}% 📶`
          }).catch(() => {});
        },
        idUsuario
      );

      const now = new Date();
      
      if (result.success) {
        this.updateState({
          status: "success",
          lastSyncTime: now,
          syncCount: this.state.syncCount + 1,
          errorMessage: null,
          sucursal,
          idUsuario
        });
        
        console.log(`[BackgroundSync] ✅ Ciclo completado exitosamente a las ${now.toLocaleTimeString()}`);
      } else {
        throw new Error(result.error || "Error en sync");
      }

    } catch (error: any) {
      console.error("[BackgroundSync] ❌ Error en performSync:", error.message);
      this.updateState({
        status: "error",
        lastSyncTime: new Date(),
        errorMessage: error.message
      });
    }
  }

  // --- Métodos de Estado estándar ---

  getState(): BackgroundSyncState {
    return { ...this.state };
  }

  /**
   * Ejecuta una sincronización manual (no afecta el intervalo automático)
   */
  async syncNow(): Promise<void> {
    if (this.state.status === 'syncing') {
      console.log("[BackgroundSync] Ya se está sincronizando.");
      return;
    }
    console.log("[BackgroundSync] Forzando sincronización manual...");
    await this.performSync();
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private updateState(updates: Partial<BackgroundSyncState>): void {
    this.state = { ...this.state, ...updates };
    this.listeners.forEach((l) => l(this.getState()));
  }
}

export default BackgroundSyncService.getInstance();
