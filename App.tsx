/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import React, { useCallback, useEffect, useState, useRef } from "react";
import {
  StatusBar,
  StyleSheet,
  useColorScheme,
  View,
  TouchableOpacity,
  Text,
  ScrollView,
  Alert,
  Dimensions,
  ActivityIndicator,
  Switch,
  BackHandler,
  AppState,
  AppStateStatus,
} from "react-native";
import { Icon } from "react-native-elements";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import LoginScreen from "./components/LoginScreen";
import SalesScreen from "./components/SalesScreen";
import BillingScreen from "./components/BillingScreen";
import PrecorteScreen from "./components/PrecorteScreen";
import TraspasoRecepcionScreen from "./components/TraspasoRecepcionScreen";
import ReporteVentasScreen from "./components/ReporteVentasScreen";
import SyncService from "./services/SyncService";
import ClienteGruposScreen from "./components/ClienteGruposScreen";
// import SignalRService from './services/SignalRService';
import DataViewScreen from "./components/DataViewScreen";
import PrinterSettingsScreen from "./components/PrinterSettingsScreen";
import FotoUploadSettingsScreen from "./components/FotoUploadSettingsScreen";
import CumplimientoScreen from "./components/CumplimientoScreen";
import ClienteFotosScreen from "./components/ClienteFotosScreen";
import PedidosScreen from "./components/PedidosScreen";
import PedidoDetalleScreen from "./components/PedidoDetalleScreen";
import EnvaseOperacionScreen from "./components/EnvaseOperacionScreen";
import CortesScreen from "./components/CortesScreen";
import MapaClientesScreen from "./components/MapaClientesScreen";
import AuthService from "./services/AuthService";
import FullSyncService, { SyncProgress } from "./services/FullSyncService";
import SyncProgressModal from "./components/SyncProgressModal";
import BluetoothPrinterService from "./services/BluetoothPrinterService";
import BackgroundSyncService from "./services/BackgroundSyncService";
import LocationService, { PermissionStatus } from "./services/LocationService";
import CierreRutaService from "./services/CierreRutaService";
import RouteTrackingService from "./services/RouteTrackingService";
import PedidoNotificacionService from "./services/PedidoNotificacionService";
import AppUpdateService, { AppUpdateState } from "./services/AppUpdateService";
import FcmService from "./services/FcmService";
import AppUpdateModal from "./components/AppUpdateModal";
import { fetchWithTimeout } from "./services/fetchWithTimeout";
import { navigationRef } from "./services/navigationRef";
import { APP_NAME, COLORS, SPACING, SHADOWS, BORDER_RADIUS, TYPOGRAPHY } from "./theme/theme";
import "react-native-devsettings";
// OR if you are using AsyncStorage
import "react-native-devsettings/withAsyncStorage";
import SyncStatusPanel from "./components/SyncStatusPanel";
import NetworkUsagePanel from "./components/NetworkUsagePanel";
import NetworkUsageService from "./services/NetworkUsageService";
import SucursalBadge from "./components/SucursalBadge";
import ManualSyncScreen from "./components/ManualSyncScreen";

declare const global: any;

declare global {
  // eslint-disable-next-line no-var
  var consoleRealm: (label: string, value: any, limit?: number) => void;
}

if (__DEV__) {
  (global as any).consoleRealm = (label: string, value: any, limit: number = 500) => {
    try {
      if (!value) {
        console.log(`${label}: <empty>`, value);
        return;
      }

      const isArrayLike = Array.isArray(value) || typeof (value as any).length === "number";

      const arr = isArrayLike ? Array.from(value as any).slice(0, limit) : [value];
      const plain = JSON.parse(JSON.stringify(arr));
      console.log(`${label} (${plain.length})`, plain);
    } catch (error) {
      console.log(`${label} (raw, error al convertir)`, value, error);
    }
  };
}

const Stack = createNativeStackNavigator();

const normalizarRuta = (valor: any): number => {
  const ruta = Number.parseInt(String(valor ?? ""), 10);
  return Number.isFinite(ruta) && ruta > 0 ? ruta : 0;
};

const esFechaEntregaDeHoy = (valor: any): boolean => {
  if (!valor) return false;

  const fecha = new Date(valor);
  if (Number.isNaN(fecha.getTime())) return false;

  const hoy = new Date();
  return (
    fecha.getFullYear() === hoy.getFullYear() &&
    fecha.getMonth() === hoy.getMonth() &&
    fecha.getDate() === hoy.getDate()
  );
};

const resolverRutaParaCierre = (
  user: any,
  realm: any,
): { ruta: number; origen: string } => {
  const rutaDeSesion = normalizarRuta(user?.ruta ?? user?.idRuta ?? user?.idSucursal);
  if (rutaDeSesion > 0) {
    return { ruta: rutaDeSesion, origen: "sesión" };
  }

  if (!realm || typeof realm.objects !== "function") {
    return { ruta: 0, origen: "sin Realm" };
  }

  try {
    const idVendedor = Number(user?.id);
    if (Number.isFinite(idVendedor) && idVendedor > 0) {
      const pedidos = Array.from(realm.objects("Pedido")) as any[];
      const rutasDePedidos = new Map<number, number>();

      pedidos.forEach((pedido) => {
        const ruta = normalizarRuta(pedido.ruta);
        if (Number(pedido.idVendedor) === idVendedor && ruta > 0 && esFechaEntregaDeHoy(pedido.fechaEntrega)) {
          rutasDePedidos.set(ruta, (rutasDePedidos.get(ruta) || 0) + 1);
        }
      });

      const rutaDePedidos = Array.from(rutasDePedidos.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || 0;
      if (rutaDePedidos > 0) {
        return { ruta: rutaDePedidos, origen: "pedidos de hoy" };
      }
    }

    const usuarios = Array.from(realm.objects("Usuario")) as any[];
    const usuarioActual = usuarios.find(
      (usuario) =>
        (user?.id != null && Number(usuario.id) === Number(user.id)) ||
        (user?.claveEmpleado && usuario.claveEmpleado === user.claveEmpleado),
    );
    const rutaDelUsuario = normalizarRuta(usuarioActual?.ruta);
    if (rutaDelUsuario > 0) {
      return { ruta: rutaDelUsuario, origen: "Usuario en Realm" };
    }

    const rutaDeCualquierUsuario = normalizarRuta(
      usuarios.find((usuario) => normalizarRuta(usuario.ruta) > 0)?.ruta,
    );
    if (rutaDeCualquierUsuario > 0) {
      return { ruta: rutaDeCualquierUsuario, origen: "usuario de Realm" };
    }
  } catch (error) {
    console.warn("[App] No se pudo resolver la ruta desde Realm:", error);
  }

  return { ruta: 0, origen: "no encontrada" };
};

function App() {
  const isDarkMode = useColorScheme() === "dark";
  const [permissionStatus, setPermissionStatus] = useState<PermissionStatus | null>(null);
  const [checkingPermissions, setCheckingPermissions] = useState(true);
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState>(AppUpdateService.getState());

  useEffect(() => {
    return AppUpdateService.subscribe(setAppUpdateState);
  }, []);

  useEffect(() => {
    // Solicitar permisos de ubicación al inicio
    const requestLocationPermission = async () => {
      setCheckingPermissions(true);
      try {
        // Esperar a que la Activity esté completamente lista
        // Esto previene el error "not attached to an Activity"
        await new Promise<void>((resolve) => setTimeout(() => resolve(), 500));

        // Primero verificar si ya tiene el permiso
        const hasPermission = await LocationService.checkPermission();
        if (hasPermission) {
          setPermissionStatus("granted");
          return;
        }

        // Si no tiene permiso, solicitarlo
        const status = await LocationService.requestPermission();
        setPermissionStatus(status);
      } catch (error) {
        console.error("[App] Error al solicitar permisos de ubicación:", error);
        setPermissionStatus("denied");
      } finally {
        setCheckingPermissions(false);
      }
    };

    requestLocationPermission();
  }, []);

  // Re-verificar permisos cuando la app vuelve del background (ej: después de ir a configuración)
  const appState = useRef(AppState.currentState);
  const isCheckingRef = useRef(false);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", async (nextAppState: AppStateStatus) => {
      // Solo re-verificar si la app estaba en background y ahora está activa
      if (appState.current.match(/inactive|background/) && nextAppState === "active") {
        // Evitar múltiples verificaciones simultáneas
        if (isCheckingRef.current) {
          return;
        }

        isCheckingRef.current = true;
        try {
          // Solo VERIFICAR, sin re-solicitar: al volver del diálogo del sistema
          // o de Configuración, un request() automático reabre el diálogo en
          // bucle aunque el usuario ya hubiera respondido.
          const hasPermission = await LocationService.checkPermission();
          setPermissionStatus((prev) => {
            if (hasPermission) return "granted";
            return prev === "blocked" ? "blocked" : "denied";
          });
          if (nextAppState === "active") {
            AppUpdateService.verificarActualizacion().catch((error) =>
              console.warn("[App] Error verificando actualización al volver:", error),
            );
          }
          PedidoNotificacionService.procesarNavegacionPendiente().catch((error) =>
            console.warn("[App] Error procesando pedido pendiente al volver a la app:", error),
          );
        } catch (error) {
        } finally {
          isCheckingRef.current = false;
        }
      }
      appState.current = nextAppState;
    });

    return () => {
      subscription.remove();
    };
  }, [permissionStatus]);

  const [servicesReady, setServicesReady] = useState(false);

  useEffect(() => {
    if (permissionStatus === null) return;

    AppUpdateService.inicializar()
      .then(() => FcmService.inicializar())
      .then(() => AppUpdateService.verificarActualizacion(false, "startup"))
      .catch((error) => console.warn("[App] Error inicializando actualizador:", error));
  }, [permissionStatus]);

  useEffect(() => {
    if (permissionStatus === null) return;

    const intervalId = setInterval(() => {
      AppUpdateService.verificarActualizacion(false, "poll").catch((error) =>
        console.warn("[App] Error en sondeo de actualización:", error),
      );
    }, 15 * 60 * 1000);

    return () => clearInterval(intervalId);
  }, [permissionStatus]);

  useEffect(() => {
    // App initialization - solo si hay permisos de ubicación
    if (permissionStatus !== "granted") return;

    console.log("App initialized");

    // CRÍTICO: Inicializar FullSyncService PRIMERO para inyectar Realm a todos los servicios
    const initializeServices = async () => {
      try {
        console.log("[App] Inicializando FullSyncService...");
        await FullSyncService.initialize();
        console.log("[App] ✅ FullSyncService inicializado - Realm inyectado a servicios");
        setServicesReady(true);

        // Inicializar servicio de notificaciones de pedidos
        try {
          const realm = (FullSyncService as any).realm;
          PedidoNotificacionService.setRealm(realm);
          await PedidoNotificacionService.inicializar();

          await PedidoNotificacionService.procesarNavegacionPendiente();
        } catch (notifError) {
          console.error("[App] Error al inicializar notificaciones de pedidos:", notifError);
        }
      } catch (error) {
        console.error("[App] ❌ Error al inicializar FullSyncService:", error);
      }
    };

    // Conectar automáticamente a la última impresora usada
    BluetoothPrinterService.connectToSavedPrinter().catch((err) => {
      console.log("No hay impresora guardada o no se pudo conectar:", err);
    });

    // Iniciar sincronización automática si hay sesión guardada
    const initBackgroundSync = async () => {
      try {
        const user = await AuthService.restoreSession();
        if (user) {
          console.log("[App] Usuario detectado, iniciando sincronización automática");
          await BackgroundSyncService.start();
        } else {
          console.log("[App] No hay usuario logueado, sincronización se iniciará después del login");
        }
      } catch (error) {
        console.error("[App] Error al verificar sesión para sincronización:", error);
      }
    };

    // Ejecutar inicializaciones en orden
    initializeServices().then(() => {
      initBackgroundSync();
    });
  }, [permissionStatus]);

  const handleRetryPermission = async () => {
    setCheckingPermissions(true);
    try {
      // Pequeño delay para asegurar que la Activity esté lista
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 300));

      const status = await LocationService.requestPermission();
      setPermissionStatus(status);
    } catch (error) {
      setPermissionStatus("denied");
    } finally {
      setCheckingPermissions(false);
    }
  };

  const handleOpenSettings = async () => {
    await LocationService.openSettings();
  };

  const handleExitApp = () => {
    BackHandler.exitApp();
  };

  // Pantalla de carga mientras se verifican permisos
  if (checkingPermissions) {
    return (
      <SafeAreaProvider>
        <View style={styles.permissionContainer}>
          <ActivityIndicator size="large" color={COLORS.primary} />
          <Text style={styles.permissionTitle}>Verificando permisos...</Text>
        </View>
      </SafeAreaProvider>
    );
  }

  // Pantalla de bloqueo si el permiso está bloqueado permanentemente
  if (permissionStatus === "blocked") {
    return (
      <SafeAreaProvider>
        <View style={styles.permissionContainer}>
          <Icon name="location-off" type="material" size={80} color={COLORS.error} />
          <Text style={styles.permissionTitle}>Permiso Bloqueado</Text>
          <Text style={styles.permissionDescription}>
            Has denegado el permiso de ubicación varias veces. Android ha bloqueado este permiso permanentemente.
          </Text>
          <Text style={[styles.permissionDescription, { fontWeight: "bold", marginTop: 10 }]}>
            Para continuar, debes:
          </Text>
          <Text style={[styles.permissionDescription, { textAlign: "left", marginTop: 5 }]}>
            1. Presionar "Abrir Configuración"{"\n"}
            2. Buscar "Permisos" o "Permissions"{"\n"}
            3. Seleccionar "Ubicación" o "Location"{"\n"}
            4. Cambiar a "Permitir" o "Allow"{"\n"}
            5. Volver a esta aplicación
          </Text>
          <TouchableOpacity style={styles.permissionButton} onPress={handleOpenSettings}>
            <Icon name="settings" type="material" size={20} color="#fff" style={{ marginRight: 8 }} />
            <Text style={styles.permissionButtonText}>Abrir Configuración</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.exitButton} onPress={handleExitApp}>
            <Text style={styles.exitButtonText}>Salir de la Aplicación</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaProvider>
    );
  }

  // Pantalla de bloqueo si no hay permisos de ubicación (denegado)
  if (permissionStatus !== "granted") {
    return (
      <SafeAreaProvider>
        <View style={styles.permissionContainer}>
          <Icon name="location-off" type="material" size={80} color={COLORS.error} />
          <Text style={styles.permissionTitle}>Permiso de Ubicación Obligatorio</Text>
          <Text style={styles.permissionDescription}>
            Esta aplicación REQUIERE acceso a la ubicación para funcionar correctamente. Sin este permiso, NO podrás
            usar la aplicación.
          </Text>
          <TouchableOpacity style={styles.permissionButton} onPress={handleRetryPermission}>
            <Text style={styles.permissionButtonText}>Otorgar Permiso</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.exitButton} onPress={handleExitApp}>
            <Text style={styles.exitButtonText}>Salir de la Aplicación</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDarkMode ? "light-content" : "dark-content"} />
      <NavigationContainer ref={navigationRef}>
        <Stack.Navigator
          initialRouteName="Login"
          screenOptions={({ route }) => ({
            headerStyle: {
              backgroundColor: COLORS.primary,
            },
            headerTintColor: "#fff",
            headerTitleStyle: {
              fontWeight: "bold",
            },
            headerRight:
              route.name !== "Login" && route.name !== "Home"
                ? () => <SucursalBadge />
                : undefined,
          })}
        >
          <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
          <Stack.Screen
            name="Home"
            options={{
              title: "Panel Principal",
              headerLeft: () => null,
            }}
          >
            {(props) => <AppContent {...props} servicesReady={servicesReady} />}
          </Stack.Screen>
          <Stack.Screen name="Sales" component={SalesScreen} options={{ title: " Punto de Venta" }} />
          {/* <Stack.Screen name="Billing" component={BillingScreen} options={{ title: " Cobranza" }} /> */}
          <Stack.Screen name="Precorte" component={PrecorteScreen} options={{ title: " Inventario" }} />
          <Stack.Screen name="Traspaso" component={TraspasoRecepcionScreen} options={{ title: " Cargas" }} />
          <Stack.Screen
            name="ReporteVentas"
            component={ReporteVentasScreen}
            options={{ title: " Consulta a Ventas" }}
          />
          {/* <Stack.Screen
            name="ClienteGrupos"
            component={ClienteGruposScreen}
            options={{ title: ' Grupos de Clientes' }}
          /> */}
          <Stack.Screen name="DataView" component={DataViewScreen} options={{ title: "📊 Datos Sincronizados" }} />
          <Stack.Screen
            name="PrinterSettings"
            component={PrinterSettingsScreen}
            options={{ title: "🖨️ Configuración de Impresora" }}
          />
          <Stack.Screen
            name="FotoUploadSettings"
            component={FotoUploadSettingsScreen}
            options={{ title: "Configuración de fotos" }}
          />
          <Stack.Screen
            name="Cumplimiento"
            component={CumplimientoScreen}
            options={{ title: "📅 Cumplimiento de Agenda" }}
          />
          <Stack.Screen
            name="ClienteFotos"
            component={ClienteFotosScreen}
            options={{ title: "Fotos del cliente" }}
          />
          <Stack.Screen
            name="Pedidos"
            component={PedidosScreen}
            options={{ title: "📦 Pedidos de Central" }}
          />
          <Stack.Screen
            name="PedidoDetalle"
            component={PedidoDetalleScreen}
            options={{ title: "Detalle de Pedido" }}
          />
          <Stack.Screen
            name="EnvaseOperacion"
            component={EnvaseOperacionScreen}
            options={{ title: "Operaciones de Envase", headerShown: false }}
          />
          <Stack.Screen name="Cortes" component={CortesScreen} options={{ title: " Corte" }} />
          <Stack.Screen
            name="MapaClientes"
            component={MapaClientesScreen}
            options={{ title: "🗺️ Mapa de Clientes" }}
          />
          <Stack.Screen
            name="ManualSync"
            component={ManualSyncScreen}
            options={{ title: "Sincronización Manual" }}
          />
        </Stack.Navigator>
      </NavigationContainer>
      <AppUpdateModal
        state={appUpdateState}
        onUseData={() => AppUpdateService.autorizarDatos()}
        onPostpone={() => AppUpdateService.posponerDatos()}
        onInstall={() => AppUpdateService.instalarActualizacion()}
      />
    </SafeAreaProvider>
  );
}

function AppContent({ navigation, servicesReady }: { navigation: any; servicesReady: boolean }) {
  const isDarkMode = useColorScheme() === "dark";
  const [syncing, setSyncing] = useState(false);
  const [sucursalName, setSucursalName] = useState("");
  const [dsucursalName, dsetSucursalName] = useState("");
  const [syncProgress, setSyncProgress] = useState<SyncProgress[]>([]);
  const [userName, setUserName] = useState<string>("");
  const [hasPendingTraspasos, setHasPendingTraspasos] = useState(false);
  const [rutaCerrada, setRutaCerrada] = useState(false);
  const [currentUser, setCurrentUser] = useState<any>(null);
  const pollingIntervalRef = useRef<any>(null);
  const pedidosPollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pedidosPollingInFlightRef = useRef(false);
  const lastPedidosPollingStartedAtRef = useRef<number | null>(null);
  const [cerrandoRuta, setCerrandoRuta] = useState(false);
  const [presionandoCierre, setPresionandoCierre] = useState(false);
  const cierreRutaTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [networkUsageEnabled, setNetworkUsageEnabled] = useState(false);
  const lastTapRef = useRef<number>(0);

  useEffect(() => {
    return () => {
      if (cierreRutaTimerRef.current) {
        clearTimeout(cierreRutaTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    // Solo cargar info del usuario cuando los servicios estén listos
    if (!servicesReady) return;

    const loadUserInfo = async () => {
      const user = await AuthService.restoreSession();
      if (user) {
        setCurrentUser(user);
        setUserName(user.claveEmpleado + " - " + user.nombre || "Usuario");
        setSucursalName(String(user.sucursal_origen || user.sucursal || "Sucursal"));
        dsetSucursalName(user.dSucursal || "Sucursal");

        const sucursal = user.sucursal_origen || user.sucursal || 1;
        const vendedor = user.id || 0;
        console.log(`[App] Cargando estado de ruta para sucursal=${sucursal}, vendedor=${vendedor}...`);
        const rutaStatus = await CierreRutaService.getRutaStatus(sucursal, vendedor);
        console.log(`[App] Estado de ruta obtenido: ${rutaStatus ? "CERRADA" : "ABIERTA"}`);
        setRutaCerrada(rutaStatus);

        await syncRouteTracking(rutaStatus);

        checkPendingTraspasos(user);
      }
    };
    loadUserInfo();
  }, [servicesReady]);

  const checkPendingTraspasos = useCallback(
    async (user?: any) => {
      try {
        const currentUserData = user || currentUser;
        if (!currentUserData) return;

        const sucursal = currentUserData.sucursal_origen || currentUserData.sucursal || 1;
        const vendedorId = currentUserData.id || 0;
        const today = new Date();
        const yyyy = today.getFullYear();
        const mm = String(today.getMonth() + 1).padStart(2, "0");
        const dd = String(today.getDate()).padStart(2, "0");
        const fechaHoy = `${yyyy}-${mm}-${dd}`;

        const url = `https://api.cbinformatica.net:9031/api/DetalleTraspasos/sp_traspasoBusquedaRecepcion?sucursal=${sucursal}&vendedor=${vendedorId}&fecha1=${encodeURIComponent(
          fechaHoy,
        )}&fecha2=${encodeURIComponent(fechaHoy)}`;

        const response = await fetchWithTimeout(url, { headers: { accept: "application/json" } }, 8000);
        if (response.ok) {
          const data = await response.json();

          // Filtramos para obtener solo los que NO (!==) sean "Finalizado"
          const pending = Array.isArray(data) ? data.filter((item) => item.estatus !== "Finalizado") : [];
          setHasPendingTraspasos(pending.length > 0);
        }
      } catch (error) {
        console.error("Error al verificar traspasos pendientes:", error);
      }
    },
    [currentUser],
  );

  useEffect(() => {
    if (!currentUser) return;

    checkPendingTraspasos();

    pollingIntervalRef.current = setInterval(() => {
      checkPendingTraspasos();
    }, 15000);

    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, [currentUser, checkPendingTraspasos]);

  const checkNewPedidos = useCallback(async () => {
    if (!currentUser || pedidosPollingInFlightRef.current || AppState.currentState !== "active") return;

    const now = Date.now();
    const lastPollingStartedAt = lastPedidosPollingStartedAtRef.current;
    if (lastPollingStartedAt !== null && now - lastPollingStartedAt < 5000) return;

    const ruta = Number(currentUser.ruta ?? currentUser.idRuta ?? currentUser.idSucursal ?? 0);
    if (!Number.isFinite(ruta) || ruta <= 0) {
      console.warn("[App] Polling de pedidos omitido: usuario sin ruta válida", currentUser);
      return;
    }

    pedidosPollingInFlightRef.current = true;
    lastPedidosPollingStartedAtRef.current = now;
    try {
      // console.log("[App] Ejecutando polling de pedidos para ruta", ruta);
      await PedidoNotificacionService.verificarPedidosNuevos(ruta);
    } catch (error) {
      console.error("[App] Error al verificar pedidos nuevos:", error);
    } finally {
      pedidosPollingInFlightRef.current = false;
    }
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) return;

    checkNewPedidos();
    pedidosPollingIntervalRef.current = setInterval(checkNewPedidos, 15000);

    const subscription = AppState.addEventListener("change", (nextAppState) => {
      if (nextAppState === "active") checkNewPedidos();
    });

    return () => {
      if (pedidosPollingIntervalRef.current) {
        clearInterval(pedidosPollingIntervalRef.current);
        pedidosPollingIntervalRef.current = null;
      }
      subscription.remove();
    };
  }, [currentUser, checkNewPedidos]);

  const syncRouteTracking = useCallback(async (rutaStatus: boolean) => {
    try {
      const config = await RouteTrackingService.getConfig();
      if (rutaStatus) {
        if (config.rutaActiva) {
          console.log("[App] Ruta cerrada; finalizando tracking GPS activo...");
          return await RouteTrackingService.finalizarRuta();
        }
        return null;
      }

      const action = config.rutaActiva ? "restaurando" : "iniciando automáticamente";
      console.log(`[App] Ruta comercial abierta; ${action} tracking GPS...`);
      const started = await RouteTrackingService.iniciarRuta();
      console.log(`[App] Tracking GPS ${action}: ${started}`);
      return null;
    } catch (trackingError) {
      console.error("[App] Error al sincronizar tracking GPS:", trackingError);
      return null;
    }
  }, []);

  useEffect(() => {
    if (!servicesReady || !currentUser) return;

    const verificarRuta = async () => {
      const sucursal = currentUser.sucursal_origen || currentUser.sucursal || 1;
      const vendedor = currentUser.id || 0;
      const rutaStatus = await CierreRutaService.getRutaStatus(sucursal, vendedor);
      setRutaCerrada(rutaStatus);
      if (!rutaStatus) {
        setCerrandoRuta(false);
      }
      await syncRouteTracking(rutaStatus);
    };

    void verificarRuta();
    const unsubscribeFocus = navigation.addListener("focus", verificarRuta);
    const interval = setInterval(verificarRuta, 60000);
    return () => {
      unsubscribeFocus();
      clearInterval(interval);
    };
  }, [servicesReady, currentUser, syncRouteTracking, navigation]);

  const handleLogout = useCallback(() => {
    Alert.alert("Cerrar Sesión", "¿Estás seguro de que deseas cerrar sesión?", [
      { text: "Cancelar", style: "cancel" },
      {
        text: "Cerrar Sesión",
        style: "destructive",
        onPress: async () => {
          try {
            if (FullSyncService.isServiceInitialized() && await RouteTrackingService.isRouteActive()) {
              await RouteTrackingService.finalizarRuta();
            }
          } catch (error) {
            console.error("[App] Error al finalizar tracking antes de cerrar sesión:", error);
          }

          try {
            if (FullSyncService.isServiceInitialized()) {
              FullSyncService.clearAllDataExceptUsers();
            }
          } catch (error) {
            console.error("[App] Error al limpiar datos:", error);
          }
          await AuthService.logout();
          navigation.reset({ index: 0, routes: [{ name: "Login" }] });
        },
      },
    ]);
  }, [navigation]);

  const SYNC_TOTAL_TIMEOUT_MS = 60000;

  const handleFullSync = useCallback(async () => {
    if (syncing) return;

    setSyncing(true);
    setSyncProgress([]);

    let timeoutId: number | null = null;

    try {
      const user = await AuthService.restoreSession();
      const sucursal = user?.sucursal_origen || user?.sucursal || 1;
      const vendedor = user?.id || 0;

      const syncPromise = FullSyncService.syncAll(
        sucursal,
        (progress: SyncProgress) => {
          setSyncProgress((prev) => [...prev, progress]);
        },
        vendedor,
      );

      // Timeout global de 1 minuto: si el proceso completo tarda más, se suspende.
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new Error(
              "Sincronización suspendida: superó el tiempo máximo de 1 minuto. " +
                "Reintenta con una mejor conexión.",
            ),
          );
        }, SYNC_TOTAL_TIMEOUT_MS);
      });

      const result = await Promise.race([syncPromise, timeoutPromise]);

      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 2000));

      if (result.success) {
        Alert.alert(
          "✅ Sincronización Completa",
          `Todos los datos han sido actualizados correctamente.\n\nSucursal: ${sucursal}\nVendedor: ${vendedor}`,
        );
      } else {
        Alert.alert(
          "⚠️ Sincronización con Errores",
          `La sincronización completó con errores:\n\n${result.error}\n\nSucursal: ${sucursal}\nVendedor: ${vendedor}`,
          [{ text: "OK" }],
        );
      }
    } catch (error: any) {
      Alert.alert("❌ Error de Sincronización", error?.message || "No se pudo completar la sincronización");
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      setSyncing(false);
    }
  }, [syncing]);

  const handleCierreRutaComplete = useCallback(async () => {
    if (!currentUser || rutaCerrada || cerrandoRuta) return;

    if (!FullSyncService.isServiceInitialized()) {
      await FullSyncService.initialize();
    }
    CierreRutaService.setRealm((FullSyncService as any).realm);

    const sucursal = currentUser.sucursal_origen || currentUser.sucursal || 1;
    const vendedor = currentUser.id || 0;
    const { ruta, origen: origenRuta } = resolverRutaParaCierre(
      currentUser,
      (FullSyncService as any).realm,
    );
    console.log(`[App] Ruta para validar cierre: ${ruta || "no encontrada"} (origen: ${origenRuta})`);

    if (!Number.isFinite(ruta) || ruta <= 0) {
      Alert.alert(
        "No se puede cerrar la ruta",
        "No se encontró una ruta válida para validar los pedidos.",
      );
      setCerrandoRuta(false);
      return;
    }

    const validacionPedidos = CierreRutaService.validarPedidosPendientesSinCausa(ruta, vendedor);

    if (validacionPedidos.error) {
      Alert.alert(
        "No se puede cerrar la ruta",
        "No fue posible validar los pedidos de hoy. La ruta permanecerá abierta; intente nuevamente.",
      );
      setCerrandoRuta(false);
      return;
    }

    if (!validacionPedidos.permitido) {
      const listaPedidos = validacionPedidos.pedidosBloqueantes
        .map(
          (p: any) =>
            `• Folio ${p.folio} - Cte ${p.clienteNombre || `#${p.cliente}`} - Domicilio: ${
              p.clienteDomicilio || "Sin domicilio registrado"
            }`,
        )
        .join("\n");

      Alert.alert(
        "⚠️ No se puede cerrar la ruta",
        `Tiene ${validacionPedidos.pedidosBloqueantes.length} pedido(s) sin resolver de hoy:\n\n${listaPedidos}\n\nDebe atenderlos o registrar una causa válida antes de cerrar la ruta.`,
        [
          { text: "Entendido" },
          {
            text: "Ver Pedidos",
            onPress: () => navigation.navigate("Pedidos"),
          },
        ],
      );
      setCerrandoRuta(false);
      return;
    }

    setCerrandoRuta(true);
    Alert.alert(
      "Cerrar Ruta",
      "¿Confirma que desea cerrar la ruta? El punto de venta será bloqueado hasta recibir una carga.",
      [
        { text: "Cancelar", style: "cancel", onPress: () => setCerrandoRuta(false) },
        {
          text: "Sí, cerrar",
          style: "destructive",
          onPress: async () => {
            const validacionFinal = CierreRutaService.validarPedidosPendientesSinCausa(ruta, vendedor);

            if (validacionFinal.error) {
              Alert.alert(
                "No se puede cerrar la ruta",
                "No fue posible validar los pedidos de hoy. La ruta permanecerá abierta; intente nuevamente.",
              );
              setCerrandoRuta(false);
              return;
            }

            if (!validacionFinal.permitido) {
              Alert.alert(
                "No se puede cerrar la ruta",
                "La ruta tiene pedidos sin resolver de hoy. Atiéndalos o registre una causa válida y vuelva a intentarlo.",
              );
              setCerrandoRuta(false);
              return;
            }

            await CierreRutaService.setRutaCerrada(sucursal, vendedor, true);
            setRutaCerrada(true);
            setCerrandoRuta(false);

            void FullSyncService.sendPendingCierreRutaToServer(sucursal, vendedor)
              .then((cierreResult) => {
                if (!cierreResult.success) {
                  console.warn("[App] El cierre quedó pendiente de arrastre:", cierreResult.error);
                }
              })
              .catch((error) => {
                console.warn("[App] El cierre quedó pendiente de arrastre:", error);
              });

            const resumenRuta = await syncRouteTracking(true);
            Alert.alert(
              "Ruta Cerrada",
              `El punto de venta ha sido bloqueado. Distancia total: ${typeof resumenRuta === "object" && resumenRuta?.distanciaKm !== undefined ? resumenRuta.distanciaKm.toFixed(2) : "0.00"} km.`,
            );
          },
        },
      ],
    );
  }, [currentUser, rutaCerrada, cerrandoRuta, syncRouteTracking, navigation]);

  const handleCierreRutaPressIn = useCallback(() => {
    if (rutaCerrada || cerrandoRuta) return;

    setPresionandoCierre(true);
    cierreRutaTimerRef.current = setTimeout(() => {
      cierreRutaTimerRef.current = null;
      setPresionandoCierre(false);
      void handleCierreRutaComplete();
    }, 5000);
  }, [rutaCerrada, cerrandoRuta, handleCierreRutaComplete]);

  const handleCierreRutaPressOut = useCallback(() => {
    if (cierreRutaTimerRef.current) {
      clearTimeout(cierreRutaTimerRef.current);
      cierreRutaTimerRef.current = null;
    }
    setPresionandoCierre(false);
  }, []);

  const handleTapRutaCerrada = useCallback(() => {
    Alert.alert(
      "Ruta Cerrada",
      "La ruta está cerrada. Solo se puede abrir automáticamente al recibir una carga exitosamente. No es posible abrirla manualmente.",
      [{ text: "Entendido" }],
    );
  }, []);

  const handleNavigateToSales = useCallback(async () => {
    if (!currentUser) return;

    const sucursal = currentUser.sucursal_origen || currentUser.sucursal || 1;
    const vendedor = currentUser.id || 0;
    const rutaStatus = await CierreRutaService.getRutaStatus(sucursal, vendedor);

    if (rutaStatus) {
      Alert.alert(
        "Ruta Cerrada",
        "No puede acceder al punto de venta porque la ruta está cerrada. Debe recibir una carga primero.",
      );
      return;
    }

    navigation.navigate("Sales");
  }, [currentUser, navigation]);

  const handleDoubleTapBusinessName = useCallback(() => {
    const now = Date.now();
    const DOUBLE_TAP_DELAY = 300;
    if (now - lastTapRef.current < DOUBLE_TAP_DELAY) {
      navigation.navigate("ManualSync");
    }
    lastTapRef.current = now;
  }, [navigation]);

  // Orden de prioridad: Punto de Venta, Agenda, Pedidos, Mapa, Cargas, Inventario, Corte, Impresora
  const priorityOrder = ["cumplimiento", "pedidos", "sales", "mapa", "traspaso", "reporte", "precorte", "cortes", "printersettings"];

  // Menús que solo se muestran al usuario ID 4
  const adminOnlyMenus = ["dataview", "billing", "envaseoperacion"];
  const isAdmin = Number(currentUser?.id ?? currentUser?.idUsuario) === 4;

  useEffect(() => {
    const canViewNetworkUsage = isAdmin && networkUsageEnabled;
    NetworkUsageService.setEnabled(canViewNetworkUsage);
    if (!isAdmin && networkUsageEnabled) setNetworkUsageEnabled(false);
  }, [isAdmin, networkUsageEnabled]);

  const allMenuItems = [
    {
      id: "sales",
      title: "Punto de Venta",
      icon: "shopping-cart",
      type: "material",
      color: COLORS.cards.sales,
      screen: "Sales",
      description: "Registra ventas",
      customHandler: handleNavigateToSales,
    },
    {
      id: "cumplimiento",
      title: "Agenda",
      icon: "event",
      type: "material",
      color: "#8E44AD",
      screen: "Cumplimiento",
      description: "Cumplimiento de visitas",
    },
    {
      id: "pedidos",
      title: "Pedidos",
      icon: "inventory-2",
      type: "material",
      color: "#D84315",
      screen: "Pedidos",
      description: "Pedidos de Central",
    },
    {
      id: "mapa",
      title: "Mapa",
      icon: "map",
      type: "material",
      color: "#00897B",
      screen: "MapaClientes",
      description: "Clientes y ruta",
    },
    {
      id: "traspaso",
      title: "Cargas",
      icon: "local-shipping",
      type: "material",
      color: COLORS.cards.traspaso,
      screen: "Traspaso",
      description: "Recibe mercancía",
    },
    {
      id: "precorte",
      title: "Inventario",
      icon: "assignment",
      type: "material",
      color: COLORS.cards.precorte,
      screen: "Precorte",
      description: "Revisa el inventario",
    },
    {
      id: "cortes",
      title: "Cortes",
      icon: "receipt-long",
      type: "material",
      color: "#E65100",
      screen: "Cortes",
      description: "Corte de ruta",
    },
    {
      id: "printersettings",
      title: "Impresora",
      icon: "print",
      type: "material",
      color: COLORS.cards.settings,
      screen: "PrinterSettings",
      description: "Configurar",
    },
    {
      id: "fotosettings",
      title: "Fotos",
      icon: "photo-camera",
      type: "material",
      color: "#5E35B1",
      screen: "FotoUploadSettings",
      description: "Subida de fotos",
    },
    {
      id: "reporte",
      title: "Ventas",
      icon: "trending-up",
      type: "material",
      color: COLORS.cards.report,
      screen: "ReporteVentas",
      description: "Histórico ventas",
    },
    // Menús de administrador (solo ID 4)
    {
      id: "dataview",
      title: "Datos",
      icon: "bar-chart",
      type: "material",
      color: COLORS.cards.data,
      screen: "DataView",
      description: "Datos locales",
    },
    {
      id: "billing",
      title: "Cobranza",
      icon: "attach-money",
      type: "material",
      color: COLORS.cards.billing,
      screen: "Billing",
      description: "Gestiona pagos",
    },
    {
      id: "envaseoperacion",
      title: "Envases",
      icon: "swap-vert",
      type: "material",
      color: "#00796B",
      screen: "EnvaseOperacion",
      description: "Intercambio / Préstamo",
    },
  ];

  // Menús ocultos del panel principal (siguen registrados/navegables desde otras pantallas)
  const hiddenMenus = ["sales"];

  // Filtrar menús de admin y menús ocultos del panel principal
  const filteredItems = allMenuItems.filter(
    (item) => (!adminOnlyMenus.includes(item.id) || isAdmin) && !hiddenMenus.includes(item.id),
  );

  // Ordenar: primero los de prioridad, luego el resto
  const menuItems = filteredItems.sort((a, b) => {
    const indexA = priorityOrder.indexOf(a.id);
    const indexB = priorityOrder.indexOf(b.id);

    // Si ambos están en prioridad, ordenar por índice
    if (indexA !== -1 && indexB !== -1) {
      return indexA - indexB;
    }
    // Si solo A está en prioridad, va primero
    if (indexA !== -1) return -1;
    // Si solo B está en prioridad, va primero
    if (indexB !== -1) return 1;
    // Si ninguno está en prioridad, mantener orden original
    return 0;
  });

  return (
    <View style={[styles.container, isDarkMode && styles.containerDark]}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerTop}>
            <View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={styles.welcomeText}>Bienvenido {sucursalName}</Text>
                {hasPendingTraspasos && <View style={styles.redIndicator} />}
              </View>
              <TouchableOpacity activeOpacity={1} onPress={handleDoubleTapBusinessName}>
                <Text style={styles.businessName}>{APP_NAME}</Text>
              </TouchableOpacity>
              <View style={styles.userBadge}>
                <Icon name="person" type="material" size={14} color={COLORS.primary} />
                <Text style={styles.userName}>{userName}</Text>
              </View>
            </View>
            <TouchableOpacity style={styles.logoutButton} onPress={handleLogout} activeOpacity={0.7}>
              <Icon name="logout" type="material" size={20} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>

        {/* Menu Grid */}
        <View style={styles.menuGrid}>
          {menuItems.map((item) => {
            const isSalesDisabled = item.id === "sales" && rutaCerrada;
            return (
              <TouchableOpacity
                key={item.id}
                style={[styles.menuCard, { backgroundColor: item.color }, isSalesDisabled && styles.menuCardDisabled]}
                onPress={() => {
                  if (item.customHandler) {
                    item.customHandler();
                  } else {
                    navigation.navigate(item.screen);
                  }
                }}
                activeOpacity={0.9}
                disabled={isSalesDisabled}
              >
                <View style={styles.iconContainer}>
                  <Icon name={item.icon} type={item.type} color={item.color} size={28} />
                </View>
                <Text style={styles.menuTitle}>{item.title}</Text>
                <Text style={styles.menuDescription}>{item.description}</Text>
                {isSalesDisabled && (
                  <View style={styles.disabledOverlay}>
                    <Icon name="lock" type="material" size={40} color="rgba(255,255,255,0.9)" />
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Sync Button */}
        <View style={styles.syncContainer}>
          <TouchableOpacity
            style={[styles.syncButton, syncing && styles.syncButtonDisabled]}
            onPress={handleFullSync}
            disabled={syncing}
            activeOpacity={0.85}
          >
            <Icon name="sync" type="material" size={24} color="#fff" style={syncing ? styles.spinning : {}} />
            <Text style={styles.syncButtonText}>{syncing ? "Sincronizando..." : "Sincronizar Datos"}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.cierreRutaButton, rutaCerrada && styles.cierreRutaButtonClosed]}
            onPress={rutaCerrada ? handleTapRutaCerrada : undefined}
            onPressIn={rutaCerrada ? undefined : handleCierreRutaPressIn}
            onPressOut={rutaCerrada ? undefined : handleCierreRutaPressOut}
            activeOpacity={0.85}
            disabled={cerrandoRuta}
            accessibilityRole="button"
            accessibilityHint={rutaCerrada ? "Muestra el estado de la ruta" : "Mantén presionado durante 5 segundos para cerrar la ruta"}
          >
            <Icon
              name={rutaCerrada ? "lock" : "lock-open"}
              type="material"
              size={20}
              color="#fff"
              style={{ marginRight: 8 }}
            />
            <Text style={styles.syncButtonText}>
              {rutaCerrada
                ? "Ruta Cerrada"
                : cerrandoRuta
                ? "Cerrando ruta..."
                : presionandoCierre
                ? "Sigue presionando..."
                : "Mantén 5 s para cerrar"}
            </Text>
          </TouchableOpacity>
        </View>
        <SyncStatusPanel />
        {isAdmin && (
          <View style={styles.networkUsageToggleContainer}>
            <View style={styles.networkUsageToggleTextContainer}>
              <Icon name="data-usage" type="material" size={20} color={COLORS.primary} />
              <View>
                <Text style={styles.networkUsageToggleTitle}>Monitorear consumo de datos</Text>
                <Text style={styles.networkUsageToggleSubtitle}>
                  Solo para diagnóstico del usuario 4
                </Text>
              </View>
            </View>
            <Switch
              value={networkUsageEnabled}
              onValueChange={setNetworkUsageEnabled}
              trackColor={{ false: COLORS.muted, true: COLORS.primaryLight }}
              thumbColor={networkUsageEnabled ? COLORS.primary : "#f4f3f4"}
              accessibilityLabel="Activar monitor de consumo de datos"
            />
          </View>
        )}
        {isAdmin && networkUsageEnabled && <NetworkUsagePanel />}

        {/* Footer Info */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>{APP_NAME} v1.3.8</Text>
        </View>
      </ScrollView>

      <SyncProgressModal visible={syncing} progress={syncProgress} />
    </View>
  );
}

const { width } = Dimensions.get("window");
const cardWidth = (width - SPACING.m * 3) / 2;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  containerDark: {
    backgroundColor: "#121212",
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: SPACING.xl,
  },
  header: {
    backgroundColor: COLORS.primary,
    paddingTop: SPACING.xl,
    paddingBottom: SPACING.l + 20, // Extra padding for overlap
    paddingHorizontal: SPACING.l,
    borderBottomLeftRadius: 30,
    borderBottomRightRadius: 30,
    ...SHADOWS.large,
  },
  headerTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  welcomeText: {
    ...TYPOGRAPHY.body,
    color: COLORS.primaryLight,
    marginBottom: SPACING.xs,
  },
  businessName: {
    ...TYPOGRAPHY.h1,
    color: "#fff",
    fontSize: 26,
    marginBottom: SPACING.s,
  },
  userBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.round,
    alignSelf: "flex-start",
    gap: SPACING.xs,
  },
  userName: {
    ...TYPOGRAPHY.body,
    fontSize: 14,
    color: COLORS.primary,
    fontWeight: "bold",
  },
  logoutButton: {
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    padding: SPACING.s,
    borderRadius: BORDER_RADIUS.m,
  },
  menuGrid: {
    paddingHorizontal: SPACING.m,
    marginTop: -20, // Overlap header
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: SPACING.m,
  },
  menuCard: {
    width: cardWidth,
    borderRadius: BORDER_RADIUS.l,
    padding: SPACING.m,
    height: 150,
    justifyContent: "space-between",
    ...SHADOWS.medium,
  },
  iconContainer: {
    width: 50,
    height: 50,
    borderRadius: BORDER_RADIUS.m,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  menuTitle: {
    ...TYPOGRAPHY.h3,
    color: "#fff",
    fontSize: 18,
    marginTop: SPACING.s,
  },
  menuDescription: {
    ...TYPOGRAPHY.caption,
    color: "rgba(255, 255, 255, 0.9)",
    fontSize: 12,
  },
  syncContainer: {
    padding: SPACING.m,
    marginTop: SPACING.m,
  },
  networkUsageToggleContainer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.m,
    marginHorizontal: SPACING.m,
    marginBottom: SPACING.m,
    padding: SPACING.m,
    ...SHADOWS.small,
  },
  networkUsageToggleTextContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.s,
    flex: 1,
  },
  networkUsageToggleTitle: {
    color: COLORS.textPrimary,
    fontSize: 14,
    fontWeight: "600",
  },
  networkUsageToggleSubtitle: {
    color: COLORS.textSecondary,
    fontSize: 11,
    marginTop: 2,
  },
  syncButton: {
    backgroundColor: COLORS.primary,
    borderRadius: BORDER_RADIUS.l,
    paddingVertical: SPACING.m,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: SPACING.s,
    ...SHADOWS.medium,
  },
  syncButtonDisabled: {
    opacity: 0.7,
    backgroundColor: COLORS.muted,
  },
  syncButtonText: {
    color: "#fff",
    fontWeight: "bold",
    fontSize: 16,
  },
  spinning: {
    // Note: Animation would need Animated API, but for now we keep it static
  },
  footer: {
    alignItems: "center",
    paddingVertical: SPACING.l,
  },
  footerText: {
    color: COLORS.muted,
    fontSize: 12,
  },
  permissionContainer: {
    flex: 1,
    backgroundColor: COLORS.background,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: SPACING.xl,
  },
  permissionTitle: {
    ...TYPOGRAPHY.h2,
    color: COLORS.textPrimary,
    marginTop: SPACING.l,
    marginBottom: SPACING.m,
    textAlign: "center",
  },
  permissionDescription: {
    ...TYPOGRAPHY.body,
    color: COLORS.muted,
    textAlign: "center",
    marginBottom: SPACING.xl,
    lineHeight: 22,
  },
  permissionButton: {
    backgroundColor: COLORS.primary,
    paddingVertical: SPACING.m,
    paddingHorizontal: SPACING.xl,
    borderRadius: BORDER_RADIUS.l,
    marginBottom: SPACING.m,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    ...SHADOWS.medium,
  },
  permissionButtonText: {
    color: "#fff",
    fontWeight: "bold",
    fontSize: 16,
  },
  exitButton: {
    paddingVertical: SPACING.m,
    paddingHorizontal: SPACING.xl,
  },
  exitButtonText: {
    color: COLORS.error,
    fontWeight: "bold",
    fontSize: 14,
  },
  redIndicator: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: COLORS.error,
    marginTop: 2,
  },
  cierreRutaButton: {
    backgroundColor: COLORS.warning,
    borderRadius: BORDER_RADIUS.l,
    paddingVertical: SPACING.m,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: SPACING.s,
    marginTop: SPACING.m,
    ...SHADOWS.medium,
  },
  cierreRutaButtonClosed: {
    backgroundColor: COLORS.error,
  },
  cierreRutaButtonPressing: {
    backgroundColor: COLORS.primary,
  },
  pressProgressContainer: {
    position: "relative",
    width: "100%",
    overflow: "hidden",
    borderRadius: BORDER_RADIUS.l,
  },
  pressProgressBar: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: "rgba(255, 255, 255, 0.3)",
    borderRadius: BORDER_RADIUS.l,
  },
  pressProgressContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: SPACING.m,
    gap: SPACING.s,
    zIndex: 1,
  },
  menuCardDisabled: {
    opacity: 0.5,
  },
  disabledOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    borderRadius: BORDER_RADIUS.l,
    justifyContent: "center",
    alignItems: "center",
  },
});

export default App;
