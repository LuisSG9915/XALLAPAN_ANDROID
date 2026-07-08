import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  StyleSheet,
  ActivityIndicator,
  Text,
  TouchableOpacity,
  Alert,
  Linking,
  Platform,
  Switch,
} from "react-native";
import { WebView, WebViewMessageEvent } from "react-native-webview";
import { useNavigation } from "@react-navigation/native";
import { Icon } from "react-native-elements";
import NetInfo from "@react-native-community/netinfo";
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from "../theme/theme";
import FullSyncService from "../services/FullSyncService";
import RouteTrackingService, { RoutePoint, RouteSummary } from "../services/RouteTrackingService";
import LocationService from "../services/LocationService";
import AuthService from "../services/AuthService";

type ClientMarker = {
  id: string;
  idCliente: number;
  nombre: string;
  direccion: string;
  lat: number;
  lng: number;
  estado: "agendado" | "visitado" | "no_localizado";
  orden?: number;
};

type MapMessage = {
  type: "markerTap" | "mapReady" | "mapError" | "mapDebug" | "navigate";
  id?: number;
  lat?: number;
  lng?: number;
  error?: string;
  message?: string;
};

export default function MapaClientesScreen() {
  const navigation = useNavigation();
  const webViewRef = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);
  const [clientes, setClientes] = useState<ClientMarker[]>([]);
  const [currentLocation, setCurrentLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [routeActive, setRouteActive] = useState(false);
  const [routeSummary, setRouteSummary] = useState<RouteSummary | null>(null);
  const [puntosRuta, setPuntosRuta] = useState<RoutePoint[]>([]);
  const [mostrarRuta, setMostrarRuta] = useState(true);
  const [sinCobertura, setSinCobertura] = useState(false);
  const [ultimaPosicion, setUltimaPosicion] = useState<{ lat: number; lng: number; fecha?: Date } | null>(null);
  const [intervaloGPS, setIntervaloGPS] = useState(30);

  useEffect(() => {
    navigation.setOptions({ title: "Mapa de Clientes" });
    cargarDatos();
    const unsubscribe = RouteTrackingService.subscribe((status) => {
      setRouteActive(status === "active");
    });
    return () => unsubscribe();
  }, [navigation]);

  const cargarDatos = useCallback(async () => {
    try {
      await FullSyncService.initialize();
      const user = await AuthService.restoreSession();
      if (!user) {
        setLoading(false);
        return;
      }

      const idUsuario = user.id || user.idUsuario || 0;
      const realm = FullSyncService.getRealm();
      if (!realm) {
        setLoading(false);
        return;
      }

      const usuarioRealm = realm.objectForPrimaryKey("Usuario", idUsuario) as any;
      const rutaUsuario = usuarioRealm?.ruta || user.ruta || null;
      console.log(`[MapaClientesScreen] Ruta del usuario: ${rutaUsuario}`);

      const config = await RouteTrackingService.getConfig();
      setIntervaloGPS(config.intervaloGPS);
      setRouteActive(config.rutaActiva);

      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, "0");
      const dd = String(today.getDate()).padStart(2, "0");
      const fechaHoy = `${yyyy}-${mm}-${dd}`;

      const startOfDay = new Date(today);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(today);
      endOfDay.setHours(23, 59, 59, 999);

      let visitas;
      if (rutaUsuario) {
        visitas = realm
          .objects("Visita")
          .filtered("fecha >= $0 AND fecha <= $1 AND ruta == $2", startOfDay, endOfDay, String(rutaUsuario))
          .sorted("orden");
      } else {
        console.warn("[MapaClientesScreen] Usuario sin ruta asignada, mostrando todas las visitas del día");
        visitas = realm.objects("Visita").filtered("fecha >= $0 AND fecha <= $1", startOfDay, endOfDay).sorted("orden");
      }

      const detallesHoy = realm.objects("DetalleVisitas").filtered("idUsuario == $0", idUsuario);
      const detallesPorCliente: Record<number, any> = {};
      Array.from(detallesHoy).forEach((d: any) => {
        if (d.fechaInicio) {
          const f = new Date(d.fechaInicio);
          if (f.toISOString().startsWith(fechaHoy)) {
            detallesPorCliente[d.idCliente] = d;
          }
        }
      });

      const markers: ClientMarker[] = [];
      Array.from(visitas).forEach((visita: any) => {
        const cliente = realm.objectForPrimaryKey("ClienteFull", visita.idCliente) as any;
        if (!cliente || !cliente.latitud || !cliente.longitud) {
          console.warn(`[MapaClientesScreen] Cliente ${visita.idCliente} sin coordenadas, omitiendo pin`);
          return;
        }

        let estado: ClientMarker["estado"] = "agendado";
        const detalle = detallesPorCliente[visita.idCliente];
        if (visita.visitado === 1 || detalle?.fechaFin) {
          estado = detalle?.tipoVisita === 1 ? "visitado" : "no_localizado";
        }

        markers.push({
          id: visita.id,
          idCliente: visita.idCliente,
          nombre: cliente.nombre || `Cliente ${visita.idCliente}`,
          direccion: cliente.domicilio || cliente.direccion || "Sin dirección",
          lat: cliente.latitud,
          lng: cliente.longitud,
          estado,
          orden: visita.orden,
        });
      });

      console.log(`[MapaClientesScreen] Agendados de hoy: ${visitas.length}, pines con coordenadas: ${markers.length}`);
      setClientes(markers);

      const location = await LocationService.getCurrentLocation();
      if (location) {
        setCurrentLocation({ lat: location.latitude, lng: location.longitude });
      } else {
        const ultima = await RouteTrackingService.getUltimaPosicion();
        if (ultima.ubicacion) {
          setUltimaPosicion({
            lat: ultima.ubicacion.latitude,
            lng: ultima.ubicacion.longitude,
            fecha: ultima.fecha,
          });
          setSinCobertura(!ultima.conCobertura);
        }
      }

      const netInfo = await NetInfo.fetch();
      setSinCobertura(netInfo.isConnected !== true);
    } catch (error) {
      console.error("[MapaClientesScreen] Error cargando datos:", error);
      Alert.alert("Error", "No se pudieron cargar los datos del mapa");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!mostrarRuta) {
      setPuntosRuta([]);
      return;
    }
    const cargarPuntosRuta = async () => {
      const puntos = await RouteTrackingService.getRoutePoints();
      console.log(`[MapaClientesScreen] Puntos de ruta cargados: ${puntos.length}`);
      setPuntosRuta(puntos);
    };
    cargarPuntosRuta();
    const interval = setInterval(cargarPuntosRuta, 30000);
    return () => clearInterval(interval);
  }, [mostrarRuta, routeActive]);

  const routePoints = useMemo(() => {
    return puntosRuta.map((p) => ({ lat: p.latitud, lng: p.longitud }));
  }, [puntosRuta]);

  const html = useMemo(() => {
    const center = currentLocation || ultimaPosicion || (clientes[0] ? { lat: clientes[0].lat, lng: clientes[0].lng } : { lat: 19.4326, lng: -99.1332 });
    const markersJson = JSON.stringify(clientes);
    const routeJson = JSON.stringify(routePoints);
    const currentJson = JSON.stringify(currentLocation || ultimaPosicion);
    const ultimaJson = JSON.stringify(ultimaPosicion);
    const sinCoberturaJson = JSON.stringify(sinCobertura);

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>Mapa</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    body, html { margin: 0; padding: 0; height: 100%; width: 100%; }
    #map { position: absolute; top: 0; left: 0; right: 0; bottom: 0; width: 100%; height: 100%; }
    .legend {
      position: absolute;
      bottom: 20px;
      left: 10px;
      z-index: 1000;
      background: white;
      padding: 8px 12px;
      border-radius: 8px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.2);
      font-family: sans-serif;
      font-size: 12px;
    }
    .legend-item { display: flex; align-items: center; margin: 2px 0; }
    .legend-color { width: 12px; height: 12px; border-radius: 50%; margin-right: 8px; }
  </style>
</head>
<body>
  <div id="map"></div>
  <div class="legend">
    <div class="legend-item"><div class="legend-color" style="background:#2B306E"></div>Visitado</div>
    <div class="legend-item"><div class="legend-color" style="background:#9C27B0"></div>Agendado</div>
    <div class="legend-item"><div class="legend-color" style="background:#FF9800"></div>No localizado</div>
    <div class="legend-item"><div class="legend-color" style="background:#00BCD4"></div>Tu posición</div>
  </div>
  <script>
    function rnLog(msg) {
      console.log(msg);
      try {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'mapDebug', message: msg }));
      } catch (e) {
        console.error('rnLog failed:', e);
      }
    }

    setTimeout(function() { rnLog('Map script started'); }, 0);

    try {
    const center = ${JSON.stringify(center)};
    rnLog('Map init - center: ' + JSON.stringify(center));
    const hasLocation = ${JSON.stringify(!!(currentLocation || ultimaPosicion))};
    const initialZoom = hasLocation ? 15 : 14;
    rnLog('Map init - hasLocation: ' + hasLocation + ', zoom: ' + initialZoom);
    const markers = ${markersJson};
    rnLog('Map init - markers count: ' + markers.length);
    const map = L.map('map').setView([center.lat, center.lng], initialZoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors'
    }).addTo(map);

    const colorByState = {
      visitado: '#2B306E',
      agendado: '#9C27B0',
      no_localizado: '#FF9800'
    };

    window.navigateToClient = function(lat, lng) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'navigate', lat: lat, lng: lng }));
    };

    markers.forEach(m => {
      const marker = L.circleMarker([m.lat, m.lng], {
        color: '#fff',
        fillColor: colorByState[m.estado] || '#999',
        fillOpacity: 0.9,
        radius: 10,
        weight: 2
      }).addTo(map);
      const ordenText = m.orden ? 'Orden: ' + m.orden + '<br/>' : '';
      const popupHtml = '<b>' + String(m.nombre || '').replace(/'/g, "&#39;") + '</b><br/>' +
        ordenText +
        String(m.direccion || '').replace(/'/g, "&#39;") + '<br/><small>' + m.estado + '</small><br/><br/>' +
        '<button onclick="navigateToClient(' + m.lat + ', ' + m.lng + ')" ' +
        'style="background:#2B306E;color:#fff;border:none;border-radius:4px;padding:6px 12px;font-size:13px;cursor:pointer;">Navegar</button>';
      marker.bindPopup(popupHtml);
    });

    const current = ${currentJson};
    if (current) {
      L.circleMarker([current.lat, current.lng], {
        color: '#fff',
        fillColor: '#00BCD4',
        fillOpacity: 0.9,
        radius: 8,
        weight: 2
      }).addTo(map).bindPopup('Tu posición actual').openPopup();
    }

    const ultima = ${ultimaJson};
    const sinCob = ${sinCoberturaJson};
    if (ultima && sinCob) {
      L.circleMarker([ultima.lat, ultima.lng], {
        color: '#FF9800',
        fillColor: '#FF9800',
        fillOpacity: 0.5,
        radius: 12,
        weight: 2,
        dashArray: '5, 5'
      }).addTo(map).bindPopup('Última posición conocida');
    }

    const route = ${routeJson};
    if (route.length > 1) {
      const latlngs = route.map(p => [p.lat, p.lng]);
      L.polyline(latlngs, { color: '#64AD45', weight: 4, opacity: 0.8 }).addTo(map);
      L.circleMarker([route[0].lat, route[0].lng], { color: '#fff', fillColor: '#00C853', fillOpacity: 0.9, radius: 6, weight: 2 }).addTo(map).bindPopup('Inicio de ruta');
      const last = route[route.length - 1];
      L.circleMarker([last.lat, last.lng], { color: '#fff', fillColor: '#D50000', fillOpacity: 0.9, radius: 6, weight: 2 }).addTo(map).bindPopup('Fin de ruta');
    }

    const boundsElements = [];
    if (markers.length > 0) boundsElements.push(...markers.map(m => L.marker([m.lat, m.lng])));
    if (route.length > 1) boundsElements.push(...route.map(p => L.marker([p.lat, p.lng])));
    if (current) boundsElements.push(L.marker([current.lat, current.lng]));
    if (ultima && sinCob) boundsElements.push(L.marker([ultima.lat, ultima.lng]));

    if (boundsElements.length > 0 && !hasLocation) {
      const group = new L.featureGroup(boundsElements);
      map.fitBounds(group.getBounds().pad(0.1), { maxZoom: 16 });
    }

    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'mapReady' }));
    } catch (err) {
      console.error('Map init error:', err);
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'mapError', error: err.message }));
    }
  </script>
</body>
</html>
    `;
  }, [clientes, currentLocation, routePoints, ultimaPosicion, sinCobertura, mostrarRuta]);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const data: MapMessage = JSON.parse(event.nativeEvent.data);
      if (data.type === "navigate" && data.lat && data.lng) {
        abrirNavegacion(data.lat, data.lng);
      } else if (data.type === "mapReady") {
        console.log("[MapaClientesScreen] Mapa listo");
      } else if (data.type === "mapError") {
        console.error("[MapaClientesScreen] Error en mapa:", (data as any).error);
        Alert.alert("Error del mapa", (data as any).error || "No se pudo cargar el mapa");
      } else if (data.type === "mapDebug") {
        console.log("[MapaClientesScreen] Map debug:", (data as any).message);
      }
    } catch (e) {
      console.warn("[MapaClientesScreen] Mensaje inválido del mapa:", e);
    }
  }, []);

  const abrirNavegacion = useCallback((lat: number, lng: number) => {
    const url = Platform.select({
      ios: `http://maps.apple.com/?daddr=${lat},${lng}&dirflg=d`,
      android: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`,
    });
    if (url) Linking.openURL(url);
  }, []);

  const handleIniciarRuta = useCallback(async () => {
    const ok = await RouteTrackingService.iniciarRuta();
    if (ok) {
      setRouteActive(true);
      Alert.alert("Ruta iniciada", "El GPS comenzó a registrar tu recorrido.");
    } else {
      Alert.alert("Error", "No se pudo iniciar la ruta. Verifica permisos y usuario.");
    }
  }, []);

  const handleFinalizarRuta = useCallback(async () => {
    const summary = await RouteTrackingService.finalizarRuta();
    if (summary) {
      setRouteActive(false);
      setRouteSummary(summary);
      Alert.alert("Ruta finalizada", `Distancia: ${summary.distanciaKm} km\nPuntos GPS: ${summary.puntos}`);
    } else {
      Alert.alert("Error", "No se pudo finalizar la ruta.");
    }
  }, []);

  const handleIntervalChange = useCallback(async (seconds: number) => {
    await RouteTrackingService.setIntervaloGPS(seconds);
    setIntervaloGPS(seconds);
  }, []);

  const handleMiUbicacion = useCallback(async () => {
    try {
      const location = await LocationService.getCurrentLocation();
      if (location && webViewRef.current) {
        const js = `map.setView([${location.latitude}, ${location.longitude}], 16);` +
          `L.circleMarker([${location.latitude}, ${location.longitude}], {` +
          `color: '#fff', fillColor: '#00BCD4', fillOpacity: 0.9, radius: 8, weight: 2` +
          `}).addTo(map).bindPopup('Tu posición actual').openPopup();`;
        webViewRef.current.injectJavaScript(js);
      } else {
        Alert.alert("Ubicación", "No se pudo obtener la ubicación actual.");
      }
    } catch (error) {
      console.error("[MapaClientesScreen] Error obteniendo ubicación:", error);
      Alert.alert("Error", "No se pudo obtener la ubicación.");
    }
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Clientes de hoy: {clientes.length}</Text>
        {sinCobertura && ultimaPosicion && (
          <View style={styles.coverageBadge}>
            <Icon name="signal-cellular-off" size={16} color="#fff" />
            <Text style={styles.coverageText}>
              Sin cobertura. Última posición: {ultimaPosicion.fecha?.toLocaleTimeString() || "--"}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.mapContainer}>
        {loading ? (
          <View style={styles.loader}>
            <ActivityIndicator size="large" color={COLORS.primary} />
            <Text style={styles.loaderText}>Cargando mapa...</Text>
          </View>
        ) : (
          <WebView
            ref={webViewRef}
            originWhitelist={["*"]}
            source={{ html }}
            style={styles.webview}
            onMessage={handleMessage}
            javaScriptEnabled
            domStorageEnabled
            geolocationEnabled
            mixedContentMode="always"
            allowFileAccess
            allowUniversalAccessFromFileURLs
            startInLoadingState
            onLoadStart={() => console.log("[MapaClientesScreen] WebView load start")}
            onLoadEnd={() => console.log("[MapaClientesScreen] WebView load end")}
            onError={(e) => console.error("[MapaClientesScreen] WebView error:", e.nativeEvent)}
            renderLoading={() => (
              <View style={styles.loader}>
                <ActivityIndicator size="large" color={COLORS.primary} />
              </View>
            )}
          />
        )}
      </View>

      <View style={styles.controls}>
        <View style={styles.row}>
          <Text style={styles.label}>Intervalo GPS: {intervaloGPS}s</Text>
          <View style={styles.intervalButtons}>
            <TouchableOpacity style={styles.smallButton} onPress={() => handleIntervalChange(Math.max(15, intervaloGPS - 15))}>
              <Text style={styles.smallButtonText}>-15s</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.smallButton} onPress={() => handleIntervalChange(Math.min(300, intervaloGPS + 15))}>
              <Text style={styles.smallButtonText}>+15s</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.row}>
          <Text style={styles.label}>Mostrar ruta</Text>
          <Switch value={mostrarRuta} onValueChange={setMostrarRuta} />
        </View>

        <TouchableOpacity style={styles.locationButton} onPress={handleMiUbicacion}>
          <Icon name="my-location" size={20} color="#fff" />
          <Text style={styles.locationButtonText}>Mi ubicación</Text>
        </TouchableOpacity>

        {routeActive ? (
          <TouchableOpacity style={[styles.routeButton, styles.routeButtonActive]} onPress={handleFinalizarRuta}>
            <Icon name="stop" size={20} color="#fff" />
            <Text style={styles.routeButtonText}>Finalizar Ruta</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.routeButton} onPress={handleIniciarRuta}>
            <Icon name="play-arrow" size={20} color="#fff" />
            <Text style={styles.routeButtonText}>Iniciar Ruta</Text>
          </TouchableOpacity>
        )}

        {routeSummary && !routeActive && (
          <View style={styles.summary}>
            <Text style={styles.summaryText}>Distancia: {routeSummary.distanciaKm} km</Text>
            <Text style={styles.summaryText}>Puntos GPS: {routeSummary.puntos}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: SPACING.m,
    paddingTop: SPACING.m,
    paddingBottom: SPACING.s,
  },
  title: { ...TYPOGRAPHY.h3, color: "#fff" },
  coverageBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.warning,
    padding: SPACING.s,
    borderRadius: BORDER_RADIUS.m,
    marginTop: SPACING.s,
    alignSelf: "flex-start",
    gap: SPACING.s,
  },
  coverageText: { color: "#fff", fontSize: 12, fontWeight: "bold" },
  mapContainer: { flex: 1, overflow: "hidden" },
  webview: { flex: 1 },
  loader: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: COLORS.surface,
  },
  loaderText: { marginTop: SPACING.s, color: COLORS.textSecondary },
  controls: {
    backgroundColor: "#fff",
    padding: SPACING.m,
    borderTopLeftRadius: BORDER_RADIUS.l,
    borderTopRightRadius: BORDER_RADIUS.l,
    ...SHADOWS.large,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: SPACING.m,
  },
  label: { ...TYPOGRAPHY.body, fontSize: 14 },
  intervalButtons: { flexDirection: "row", gap: SPACING.s },
  smallButton: {
    backgroundColor: COLORS.surface,
    paddingHorizontal: SPACING.s,
    paddingVertical: 4,
    borderRadius: BORDER_RADIUS.s,
  },
  smallButtonText: { color: COLORS.primary, fontWeight: "bold" },
  routeButton: {
    backgroundColor: COLORS.success,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    padding: SPACING.m,
    borderRadius: BORDER_RADIUS.l,
    gap: SPACING.s,
  },
  routeButtonActive: { backgroundColor: COLORS.error },
  routeButtonText: { color: "#fff", fontWeight: "bold", fontSize: 16 },
  locationButton: {
    backgroundColor: COLORS.primary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    padding: SPACING.m,
    borderRadius: BORDER_RADIUS.l,
    gap: SPACING.s,
    marginBottom: SPACING.m,
  },
  locationButtonText: { color: "#fff", fontWeight: "bold", fontSize: 16 },
  summary: {
    marginTop: SPACING.m,
    backgroundColor: COLORS.surface,
    padding: SPACING.m,
    borderRadius: BORDER_RADIUS.m,
  },
  summaryText: { ...TYPOGRAPHY.body, fontSize: 14 },
});
