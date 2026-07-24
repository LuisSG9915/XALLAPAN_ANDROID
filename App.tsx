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
import CumplimientoScreen from "./components/CumplimientoScreen";
import EnvaseOperacionScreen from "./components/EnvaseOperacionScreen";
import CortesScreen from "./components/CortesScreen";
import MapaClientesScreen from "./components/MapaClientesScreen";
import AuthService from "./services/AuthService";
import FullSyncService, { SyncProgress } from "./services/FullSyncService";
import SyncProgressModal from "./components/SyncProgressModal";
import BluetoothPrinterService from "./services/BluetoothPrinterService";
import BackgroundSyncService from "./services/BackgroundSyncService";
import BackgroundActions from "react-native-background-actions";
import BackgroundLocationService from "./services/BackgroundLocationService";
import LocationService, { PermissionStatus } from "./services/LocationService";
import CierreRutaService from "./services/CierreRutaService";
import RouteTrackingService from "./services/RouteTrackingService";
import { APP_NAME, COLORS, SPACING, SHADOWS, BORDER_RADIUS, TYPOGRAPHY } from "./theme/theme";
import "react-native-devsettings";
// OR if you are using AsyncStorage
import "react-native-devsettings/withAsyncStorage";
import SyncStatusPanel from "./components/SyncStatusPanel";

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

function App() {
  const isDarkMode = useColorScheme() === "dark";
  const [permissionStatus, setPermissionStatus] = useState<PermissionStatus | null>(null);
  const [checkingPermissions, setCheckingPermissions] = useState(true);

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
          // Solicitar el estado del permiso
          const status = await LocationService.requestPermission();
          setPermissionStatus(status);
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
      <NavigationContainer>
        <Stack.Navigator
          initialRouteName="Login"
          screenOptions={{
            headerStyle: {
              backgroundColor: COLORS.primary,
            },
            headerTintColor: "#fff",
            headerTitleStyle: {
              fontWeight: "bold",
            },
          }}
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
            name="Cumplimiento"
            component={CumplimientoScreen}
            options={{ title: "📅 Cumplimiento de Agenda" }}
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
        </Stack.Navigator>
      </NavigationContainer>
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
  const [pressingCierre, setPressingCierre] = useState(false);
  const [pressProgress, setPressProgress] = useState(0);
  const pressTimerRef = useRef<any>(null);
  const pressStartTimeRef = useRef<number>(0);

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

        const response = await fetch(url, { timeout: 1000 } as any);
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
    }, 10000);

    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, [currentUser, checkPendingTraspasos]);

  const syncRouteTracking = useCallback(async (rutaStatus: boolean) => {
    try {
      if (!rutaStatus) {
        console.log("[App] Sincronizando tracking: ruta abierta, iniciando GPS...");
        const started = await RouteTrackingService.iniciarRuta();
        console.log(`[App] Tracking GPS iniciado: ${started}`);
      } else {
        console.log("[App] Sincronizando tracking: ruta cerrada, deteniendo GPS...");
        await RouteTrackingService.finalizarRuta();
      }
    } catch (trackingError) {
      console.error("[App] Error al sincronizar tracking GPS:", trackingError);
    }
  }, []);

  useEffect(() => {
    if (!servicesReady || !currentUser) return;

    const verificarRuta = async () => {
      const sucursal = currentUser.sucursal_origen || currentUser.sucursal || 1;
      const vendedor = currentUser.id || 0;
      const rutaStatus = await CierreRutaService.getRutaStatus(sucursal, vendedor);
      setRutaCerrada(rutaStatus);
      await syncRouteTracking(rutaStatus);

      // Health check: si la ruta esta abierta pero el foreground service no corre, reiniciarlo
      if (!rutaStatus) {
        const servicioCorriendo = BackgroundActions.isRunning();
        if (!servicioCorriendo) {
          console.warn("[App] Foreground service detenido inesperadamente. Reiniciando...");
          try {
            await BackgroundLocationService.start();
            console.log("[App] Foreground service reiniciado exitosamente");
          } catch (e) {
            console.error("[App] Error al reiniciar foreground service:", e);
          }
        }
      }
    };

    verificarRuta();
    const interval = setInterval(verificarRuta, 60000);
    return () => clearInterval(interval);
  }, [servicesReady, currentUser, syncRouteTracking]);

  const handleLogout = useCallback(() => {
    Alert.alert("Cerrar Sesión", "¿Estás seguro de que deseas cerrar sesión?", [
      { text: "Cancelar", style: "cancel" },
      {
        text: "Cerrar Sesión",
        style: "destructive",
        onPress: async () => {
          // Limpiar todos los datos excepto usuarios
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

  const handlePressInCierre = useCallback(() => {
    if (!currentUser || rutaCerrada) return;

    setPressingCierre(true);
    setPressProgress(0);
    pressStartTimeRef.current = Date.now();

    const updateProgress = () => {
      const elapsed = Date.now() - pressStartTimeRef.current;
      const progress = Math.min(elapsed / 5000, 1);
      setPressProgress(progress);

      if (progress >= 1) {
        handleCierreRutaComplete();
      } else {
        pressTimerRef.current = requestAnimationFrame(updateProgress);
      }
    };

    pressTimerRef.current = requestAnimationFrame(updateProgress);
  }, [currentUser, rutaCerrada]);

  const handlePressOutCierre = useCallback(() => {
    if (pressTimerRef.current) {
      cancelAnimationFrame(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    setPressingCierre(false);
    setPressProgress(0);
  }, []);

  const handleCierreRutaComplete = useCallback(async () => {
    if (pressTimerRef.current) {
      cancelAnimationFrame(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    setPressingCierre(false);
    setPressProgress(0);

    if (!currentUser) return;

    const sucursal = currentUser.sucursal_origen || currentUser.sucursal || 1;
    const vendedor = currentUser.id || 0;

    Alert.alert(
      "Cerrar Ruta",
      "¿Confirma que desea cerrar la ruta? El punto de venta será bloqueado hasta recibir una carga.",
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Sí, cerrar",
          style: "destructive",
          onPress: async () => {
            await CierreRutaService.setRutaCerrada(sucursal, vendedor, true);
            setRutaCerrada(true);
            await syncRouteTracking(true);
            Alert.alert(
              "Ruta Cerrada",
              "El punto de venta ha sido bloqueado. Solo se desbloqueará al recibir una carga.",
            );
          },
        },
      ],
    );
  }, [currentUser, syncRouteTracking]);

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

  // Orden de prioridad: Punto de Venta, Agenda, Mapa, Cargas, Inventario, Corte, Impresora
  const priorityOrder = ["cumplimiento", "sales", "mapa", "traspaso", "reporte", "precorte", "cortes", "printersettings"];

  // Menús que solo se muestran al usuario ID 4
  const adminOnlyMenus = ["dataview", "billing", "envaseoperacion", "mapa"];
  const isAdmin = currentUser?.id === 4;

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

  // Filtrar menús de admin si el usuario no es ID 4 y menús ocultos del panel
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
              <Text style={styles.businessName}>{APP_NAME}</Text>
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
            style={[
              styles.cierreRutaButton,
              rutaCerrada && styles.cierreRutaButtonClosed,
              pressingCierre && styles.cierreRutaButtonPressing,
            ]}
            onPressIn={rutaCerrada ? undefined : handlePressInCierre}
            onPressOut={rutaCerrada ? undefined : handlePressOutCierre}
            onPress={rutaCerrada ? handleTapRutaCerrada : undefined}
            activeOpacity={0.85}
            disabled={pressingCierre}
          >
            {pressingCierre ? (
              <View style={styles.pressProgressContainer}>
                <View style={[styles.pressProgressBar, { width: `${pressProgress * 100}%` }]} />
                <View style={styles.pressProgressContent}>
                  <Icon name="lock" type="material" size={20} color="#fff" style={{ marginRight: 8 }} />
                  <Text style={styles.syncButtonText}>Mantenga presionado ({Math.ceil((1 - pressProgress) * 5)}s)</Text>
                </View>
              </View>
            ) : (
              <>
                <Icon
                  name={rutaCerrada ? "lock" : "lock-open"}
                  type="material"
                  size={20}
                  color="#fff"
                  style={{ marginRight: 8 }}
                />
                <Text style={styles.syncButtonText}>{rutaCerrada ? "Ruta Cerrada" : "Mantener 5s para Cerrar"}</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
        <SyncStatusPanel />

        {/* Footer Info */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>{APP_NAME} v1.3</Text>
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
