import React, { useCallback, useMemo } from "react";
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Share,
  Dimensions,
} from "react-native";
import { WebView } from "react-native-webview";
import { Icon } from "react-native-elements";
import { COLORS, SPACING, BORDER_RADIUS, TYPOGRAPHY, SHADOWS } from "../theme/theme";

export type DiagnosticoGpsData = {
  motivo: string;
  valido: boolean;
  distancia: number | null;
  accuracy: number | null;
  metrosPermitidos: number;
  numFixes: number | null;
  peorAccuracy: number | null;
  tiempoMs: number | null;
  vendedorLat: number | null;
  vendedorLng: number | null;
  clienteLat: number;
  clienteLng: number;
  clienteNombre?: string;
};

type Props = {
  visible: boolean;
  data: DiagnosticoGpsData | null;
  onClose: () => void;
  onReintentar?: () => void;
};

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const MAP_HEIGHT = 280;

const motivoLabel: Record<string, string> = {
  fuera_de_rango: "Fuera de rango",
  precision_baja: "Precisión baja",
  sin_senal: "Sin señal GPS",
  red_no_gnss: "Red celular (sin GPS)",
};

export default function ModalDiagnosticoGps({ visible, data, onClose, onReintentar }: Props) {
  const html = useMemo(() => {
    if (!data || data.vendedorLat == null || data.vendedorLng == null) return "";

    const centerLat = (data.vendedorLat + data.clienteLat) / 2;
    const centerLng = (data.vendedorLng + data.clienteLng) / 2;
    const accuracy = data.accuracy ?? 50;
    const metrosPermitidos = data.metrosPermitidos ?? 80;

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    body, html { margin: 0; padding: 0; height: 100%; width: 100%; }
    #map { position: absolute; top: 0; left: 0; right: 0; bottom: 0; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    console.log("[Mapa] Iniciando carga...");
    try {
      var map = L.map('map', { zoomControl: false }).setView([${centerLat}, ${centerLng}], 16);
      console.log("[Mapa] Mapa creado");
      
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: ''
      }).addTo(map);
      console.log("[Mapa] Tiles agregados");

      L.circleMarker([${data.vendedorLat}, ${data.vendedorLng}], {
        color: '#fff', fillColor: '#2196F3', fillOpacity: 0.9, radius: 9, weight: 2
      }).addTo(map).bindPopup('Tu ubicación');

      L.circle([${data.vendedorLat}, ${data.vendedorLng}], {
        radius: ${accuracy}, color: '#2196F3', fillColor: '#2196F3', fillOpacity: 0.1, weight: 1, dashArray: '4,4'
      }).addTo(map);

      L.circleMarker([${data.clienteLat}, ${data.clienteLng}], {
        color: '#fff', fillColor: '#D32F2F', fillOpacity: 0.9, radius: 9, weight: 2
      }).addTo(map).bindPopup('Cliente');

      L.circle([${data.clienteLat}, ${data.clienteLng}], {
        radius: ${metrosPermitidos}, color: '#64AD45', fillColor: '#64AD45', fillOpacity: 0.12, weight: 2
      }).addTo(map);

      L.polyline([[${data.vendedorLat}, ${data.vendedorLng}], [${data.clienteLat}, ${data.clienteLng}]], {
        color: '#FF9800', weight: 2, opacity: 0.8, dashArray: '6,6'
      }).addTo(map);

      var group = L.featureGroup([
        L.marker([${data.vendedorLat}, ${data.vendedorLng}]),
        L.marker([${data.clienteLat}, ${data.clienteLng}])
      ]);
      map.fitBounds(group.getBounds().pad(0.3), { maxZoom: 17 });
      console.log("[Mapa] Mapa renderizado completamente");
      
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage("Mapa renderizado correctamente");
      }
    } catch(e) {
      console.error("[Mapa] Error:", e);
      document.getElementById('map').innerHTML = '<div style="padding:20px;text-align:center;color:#666;">No se pudo cargar el mapa: ' + e.message + '</div>';
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage("Error: " + e.message);
      }
    }
  </script>
</body>
</html>`;
  }, [data]);

  const handleReportar = useCallback(async () => {
    if (!data) return;
    const distancia = data.distancia != null ? `${Math.round(data.distancia)} m` : "N/D";
    const accuracy = data.accuracy != null ? `±${Math.round(data.accuracy)} m` : "N/D";
    const fixes = data.numFixes != null ? `${data.numFixes}` : "N/D";
    const tiempo = data.tiempoMs != null ? `${(data.tiempoMs / 1000).toFixed(1)} s` : "N/D";
    const motivo = motivoLabel[data.motivo] || data.motivo;
    const hora = new Date().toLocaleString("es-MX");

    const texto =
      `Reporte GPS - Xallapan\n` +
      `Hora: ${hora}\n` +
      `Motivo: ${motivo}\n` +
      `Cliente: ${data.clienteNombre || "N/D"}\n` +
      `Distancia: ${distancia} (permitido: ${data.metrosPermitidos} m)\n` +
      `Accuracy: ${accuracy}\n` +
      `Fixes: ${fixes} | Tiempo: ${tiempo}\n` +
      `Mi ubicación: ${data.vendedorLat?.toFixed(6) || "N/D"}, ${data.vendedorLng?.toFixed(6) || "N/D"}\n` +
      `Cliente: ${data.clienteLat.toFixed(6)}, ${data.clienteLng.toFixed(6)}`;

    try {
      await Share.share({ message: texto, title: "Reporte GPS Xallapan" });
    } catch (_) {}
  }, [data]);

  const motivo = data ? motivoLabel[data.motivo] || data.motivo : "";
  const tieneMapa = data && data.vendedorLat != null && data.vendedorLng != null;

  console.log("[ModalDiagnosticoGps] tieneMapa:", tieneMapa, "vendedorLat:", data?.vendedorLat, "vendedorLng:", data?.vendedorLng);
  console.log("[ModalDiagnosticoGps] HTML length:", html?.length ?? 0);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.container}>
          <View style={styles.header}>
            <Icon name="gps-off" size={22} color="#fff" />
            <Text style={styles.headerTitle}>{motivo}</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <Icon name="close" size={22} color="#fff" />
            </TouchableOpacity>
          </View>

          {tieneMapa && (
            <View style={{ height: MAP_HEIGHT, width: SCREEN_WIDTH, backgroundColor: '#f0f0f0' }}>
              <WebView
                key={`map-${data.vendedorLat}-${data.vendedorLng}`}
                originWhitelist={["*"]}
                source={{ html }}
                style={{ flex: 1 }}
                javaScriptEnabled
                domStorageEnabled
                scrollEnabled={false}
                mixedContentMode="always"
                onLoadEnd={() => console.log("[ModalDiagnosticoGps] WebView cargado")}
                onError={(e) => console.error("[ModalDiagnosticoGps] WebView error:", e.nativeEvent)}
                onMessage={(e) => console.log("[ModalDiagnosticoGps] WebView message:", e.nativeEvent.data)}
              />
            </View>
          )}

          {!tieneMapa && (
            <View style={{ height: MAP_HEIGHT, width: SCREEN_WIDTH, justifyContent: "center", alignItems: "center", backgroundColor: COLORS.surface }}>
              <Icon name="location-off" size={48} color={COLORS.muted} />
              <Text style={styles.noMapText}>Sin coordenadas GPS para mostrar</Text>
            </View>
          )}

          <View style={styles.diagPanel}>
            {data?.distancia != null && (
              <DiagRow label="Distancia" value={`${Math.round(data.distancia)} m`} highlight={data.distancia > data.metrosPermitidos} />
            )}
            <DiagRow label="Permitido" value={`${data?.metrosPermitidos ?? 0} m`} />
            {data?.accuracy != null && (
              <DiagRow label="Precisión GPS" value={`±${Math.round(data.accuracy)} m`} highlight={data.accuracy > 50} />
            )}
            <DiagRow label="Fixes recibidos" value={`${data?.numFixes ?? 0}`} highlight={(data?.numFixes ?? 0) < 2} />
            {data?.tiempoMs != null && (
              <DiagRow label="Tiempo" value={`${(data.tiempoMs / 1000).toFixed(1)} s`} />
            )}
          </View>

          {/* <View style={styles.buttons}>
            {onReintentar && (
              <TouchableOpacity style={styles.retryBtn} onPress={() => { onClose(); onReintentar(); }}>
                <Icon name="refresh" size={18} color="#fff" />
                <Text style={styles.retryText}>Reintentar</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.reportBtn} onPress={handleReportar}>
              <Icon name="share" size={18} color={COLORS.primary} />
              <Text style={styles.reportText}>Reportar</Text>
            </TouchableOpacity>
          </View> */}
        </View>
      </View>
    </Modal>
  );
}

function DiagRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <View style={styles.diagRow}>
      <Text style={styles.diagLabel}>{label}</Text>
      <Text style={[styles.diagValue, highlight && styles.diagHighlight]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  container: {
    backgroundColor: COLORS.background,
    borderTopLeftRadius: BORDER_RADIUS.xl,
    borderTopRightRadius: BORDER_RADIUS.xl,
    ...SHADOWS.large,
  },
  header: {
    backgroundColor: COLORS.error,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.m,
    gap: SPACING.s,
  },
  headerTitle: { flex: 1, color: "#fff", fontSize: 18, fontWeight: "bold" },
  closeBtn: { padding: SPACING.xs },
  webview: { height: MAP_HEIGHT, width: SCREEN_WIDTH },
  noMap: { justifyContent: "center", alignItems: "center", backgroundColor: COLORS.surface },
  noMapText: { ...TYPOGRAPHY.caption, marginTop: SPACING.s },
  diagPanel: { paddingHorizontal: SPACING.m, paddingTop: SPACING.m, paddingBottom: SPACING.s },
  diagRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: SPACING.xs,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.surface,
  },
  diagLabel: { ...TYPOGRAPHY.caption },
  diagValue: { ...TYPOGRAPHY.body, fontWeight: "600" },
  diagHighlight: { color: COLORS.error },
  buttons: {
    flexDirection: "row",
    paddingHorizontal: SPACING.m,
    paddingBottom: SPACING.l,
    paddingTop: SPACING.s,
    gap: SPACING.s,
  },
  retryBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.primary,
    paddingVertical: SPACING.m,
    borderRadius: BORDER_RADIUS.m,
    gap: SPACING.xs,
  },
  retryText: { color: "#fff", fontWeight: "bold", fontSize: 16 },
  reportBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.surface,
    paddingVertical: SPACING.m,
    borderRadius: BORDER_RADIUS.m,
    gap: SPACING.xs,
  },
  reportText: { color: COLORS.primary, fontWeight: "bold", fontSize: 16 },
});
