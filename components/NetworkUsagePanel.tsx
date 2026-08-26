import React, { useCallback, useEffect, useState } from "react";
import { Alert, FlatList, Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Icon } from "react-native-elements";
import NetworkUsageService, {
  NetworkUsageAggregate,
  NetworkUsageSnapshot,
} from "../services/NetworkUsageService";
import { BORDER_RADIUS, COLORS, SHADOWS, SPACING } from "../theme/theme";

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const formatNetworkType = (type: NetworkUsageAggregate["networkType"]): string => {
  switch (type) {
    case "wifi":
      return "Wi-Fi";
    case "cellular":
      return "Datos móviles";
    case "ethernet":
      return "Ethernet";
    case "other":
      return "Otra red";
    default:
      return "Red desconocida";
  }
};

const getAverageDuration = (entry: NetworkUsageAggregate): string => {
  if (!entry.requests) return "N/D";
  return `${Math.round(entry.durationMs / entry.requests)} ms prom.`;
};

const formatLastAt = (value: string | null | undefined): string => {
  if (!value) return "N/D";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "N/D"
    : date.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

export default function NetworkUsagePanel() {
  const [snapshot, setSnapshot] = useState<NetworkUsageSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [detailsVisible, setDetailsVisible] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setSnapshot(await NetworkUsageService.getTodaySnapshot());
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    const unsubscribe = NetworkUsageService.subscribe((nextSnapshot) => {
      if (mounted) setSnapshot(nextSnapshot);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const total = snapshot?.total;
  const endpoints = snapshot?.endpoints || [];
  const topEndpoints = endpoints.slice(0, 10);
  const hasMetrics = Boolean(total && total.requests > 0);

  const renderEndpoint = (entry: NetworkUsageAggregate) => (
    <View style={styles.endpointRow}>
      <View style={styles.endpointInfo}>
        <Text style={styles.endpointMethod}>{entry.method}</Text>
        <Text style={styles.endpointName} numberOfLines={3}>
          {entry.endpoint}
        </Text>
        <Text style={styles.endpointMeta}>
          {formatNetworkType(entry.networkType)} · {entry.requests} petición(es) · {getAverageDuration(entry)}
        </Text>
        <Text style={styles.endpointMeta}>
          HTTP {entry.lastStatus || "N/D"} · última: {formatLastAt(entry.lastAt)} · errores: {entry.failed} · timeouts: {entry.timeouts}
        </Text>
        {entry.bodyBytesMeasured > 0 && (
          <Text style={styles.endpointMeta}>
            Cuerpo procesado: {formatBytes(entry.bodyBytesMeasured)}
          </Text>
        )}
      </View>
      <Text style={styles.endpointBytes}>{formatBytes(entry.bytesReceived)}</Text>
    </View>
  );

  const handleClear = () => {
    Alert.alert(
      "Limpiar métricas",
      "Se eliminará el historial local de consumo de datos.",
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Limpiar",
          style: "destructive",
          onPress: () => void NetworkUsageService.clear(),
        },
      ],
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.titleContainer}>
          <Icon name="data-usage" type="material" size={20} color={COLORS.primary} />
          <View>
            <Text style={styles.title}>Consumo de datos</Text>
            <Text style={styles.subtitle}>Métricas locales del día {snapshot?.day || ""}</Text>
          </View>
        </View>
        <TouchableOpacity
          onPress={() => void refresh()}
          disabled={refreshing}
          style={styles.refreshButton}
          accessibilityLabel="Actualizar consumo de datos"
        >
          <Icon
            name="refresh"
            type="material"
            size={19}
            color={refreshing ? COLORS.muted : COLORS.primary}
          />
        </TouchableOpacity>
      </View>

      {!hasMetrics ? (
        <Text style={styles.emptyText}>Aún no hay solicitudes registradas.</Text>
      ) : (
        <>
          <View style={styles.summaryRow}>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>Recibidos</Text>
              <Text style={styles.summaryValue}>{formatBytes(total?.bytesReceived || 0)}</Text>
            </View>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>Procesados</Text>
              <Text style={styles.summaryValue}>{formatBytes(total?.bodyBytesMeasured || 0)}</Text>
            </View>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>Enviados</Text>
              <Text style={styles.summaryValue}>{formatBytes(total?.bytesSent || 0)}</Text>
            </View>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>Peticiones</Text>
              <Text style={styles.summaryValue}>{total?.requests || 0}</Text>
            </View>
          </View>

          <View style={styles.detailsRow}>
            <Text style={styles.detailText}>Exitosas: {total?.successful || 0}</Text>
            <Text style={styles.detailText}>Errores: {total?.failed || 0}</Text>
            <Text style={styles.detailText}>Timeouts: {total?.timeouts || 0}</Text>
          </View>
          <Text style={styles.lastUpdated}>Actualizado: {formatLastAt(snapshot?.lastUpdatedAt)}</Text>

          <Text style={styles.sectionTitle}>Top 10 endpoints por bytes recibidos</Text>
          {topEndpoints.map((entry) => (
            <View key={`${entry.method}-${entry.endpoint}-${entry.networkType}`}>
              {renderEndpoint(entry)}
            </View>
          ))}

          {endpoints.length > topEndpoints.length && (
            <TouchableOpacity
              style={styles.detailsButton}
              onPress={() => setDetailsVisible(true)}
            >
              <Text style={styles.detailsButtonText}>Ver los {endpoints.length} endpoints</Text>
              <Icon name="open-in-new" type="material" size={16} color={COLORS.primary} />
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.clearButton} onPress={handleClear}>
            <Text style={styles.clearButtonText}>Limpiar métricas locales</Text>
          </TouchableOpacity>
        </>
      )}

      <Modal
        visible={detailsVisible}
        animationType="slide"
        onRequestClose={() => setDetailsVisible(false)}
      >
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Detalle de consumo</Text>
            <TouchableOpacity onPress={() => setDetailsVisible(false)} style={styles.closeButton}>
              <Icon name="close" type="material" size={22} color={COLORS.textPrimary} />
            </TouchableOpacity>
          </View>
          <FlatList
            data={endpoints}
            keyExtractor={(entry) => `${entry.method}-${entry.endpoint}-${entry.networkType}`}
            renderItem={({ item }) => renderEndpoint(item)}
            ListEmptyComponent={<Text style={styles.emptyText}>No hay endpoints registrados.</Text>}
          />
          <TouchableOpacity style={styles.clearButton} onPress={handleClear}>
            <Text style={styles.clearButtonText}>Limpiar métricas locales</Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.m,
    padding: SPACING.m,
    marginBottom: SPACING.m,
    ...SHADOWS.small,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: SPACING.s,
  },
  titleContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.s,
  },
  title: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: "600",
  },
  subtitle: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  refreshButton: {
    padding: SPACING.s,
    borderRadius: BORDER_RADIUS.s,
    backgroundColor: COLORS.background,
  },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: COLORS.background,
    borderRadius: BORDER_RADIUS.s,
    padding: SPACING.s,
    marginBottom: SPACING.m,
  },
  summaryItem: {
    flex: 1,
    alignItems: "center",
  },
  summaryLabel: {
    color: COLORS.textSecondary,
    fontSize: 12,
  },
  summaryValue: {
    color: COLORS.textPrimary,
    fontSize: 14,
    fontWeight: "600",
    marginTop: 3,
  },
  sectionTitle: {
    color: COLORS.textPrimary,
    fontSize: 13,
    fontWeight: "600",
    marginBottom: SPACING.xs,
  },
  endpointRow: {
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    paddingVertical: SPACING.s,
  },
  endpointInfo: {
    flex: 1,
    paddingRight: SPACING.s,
  },
  endpointMethod: {
    color: COLORS.primary,
    fontSize: 10,
    fontWeight: "700",
  },
  endpointName: {
    color: COLORS.textPrimary,
    fontSize: 12,
    marginTop: 2,
  },
  endpointMeta: {
    color: COLORS.textSecondary,
    fontSize: 10,
    marginTop: 3,
  },
  endpointBytes: {
    color: COLORS.textPrimary,
    fontSize: 13,
    fontWeight: "600",
  },
  detailsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: SPACING.xs,
  },
  detailText: {
    color: COLORS.textSecondary,
    fontSize: 11,
  },
  lastUpdated: {
    color: COLORS.muted,
    fontSize: 10,
    marginBottom: SPACING.s,
  },
  detailsButton: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: SPACING.xs,
    paddingVertical: SPACING.s,
  },
  detailsButtonText: {
    color: COLORS.primary,
    fontSize: 12,
    fontWeight: "600",
  },
  clearButton: {
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    marginTop: SPACING.s,
    paddingTop: SPACING.s,
  },
  clearButtonText: {
    color: COLORS.error,
    fontSize: 11,
  },
  modalContainer: {
    flex: 1,
    backgroundColor: COLORS.surface,
    padding: SPACING.m,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: SPACING.s,
  },
  modalTitle: {
    color: COLORS.textPrimary,
    fontSize: 18,
    fontWeight: "600",
  },
  closeButton: {
    padding: SPACING.s,
  },
  emptyText: {
    color: COLORS.textSecondary,
    fontSize: 13,
  },
});
