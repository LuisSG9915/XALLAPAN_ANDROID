import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Dimensions,
} from "react-native";
import { Icon } from "react-native-elements";
import FullSyncService from "../services/FullSyncService";
import AuthService from "../services/AuthService";
import { COLORS, SPACING, BORDER_RADIUS, SHADOWS, TYPOGRAPHY } from "../theme/theme";

interface SyncItem {
  tableName: string;
  label: string;
  description: string;
  icon: string;
  color: string;
  group: string;
}

const SYNC_ITEMS: SyncItem[] = [
  { tableName: "VentasArrastre", label: "Arrastre Ventas", description: "Arrastre de ventas pendientes", icon: "swap-horiz", color: "#E65100", group: "Ventas" },
  { tableName: "Ventas", label: "Ventas", description: "Histórico de ventas ERP", icon: "point-of-sale", color: "#2B306E", group: "Ventas" },
  { tableName: "Clientes", label: "Clientes", description: "Catálogo de clientes", icon: "people", color: "#1565C0", group: "Catálogos" },
  { tableName: "Productos", label: "Productos", description: "Catálogo de productos", icon: "inventory-2", color: "#2E7D32", group: "Catálogos" },
  { tableName: "Precios", label: "Precios", description: "Lista de precios vigente", icon: "attach-money", color: "#388E3C", group: "Catálogos" },
  { tableName: "PreciosPromo", label: "Precios Promo", description: "Precios en promoción", icon: "local-offer", color: "#F57C00", group: "Catálogos" },
  { tableName: "Kits", label: "Kits", description: "Kits de productos", icon: "inventory", color: "#5E35B1", group: "Catálogos" },
  { tableName: "KitIntercambio", label: "Kit Intercambio", description: "Kits de intercambio/envase", icon: "recycling", color: "#00796B", group: "Catálogos" },
  { tableName: "Inventario", label: "Inventario", description: "Stock actual por sucursal", icon: "warehouse", color: "#455A64", group: "Inventario" },
  { tableName: "InventarioEnvase", label: "Envases", description: "Inventario de envases", icon: "liquor", color: "#00838F", group: "Inventario" },
  { tableName: "InventarioEnvasesHistorial", label: "Historial Envases", description: "Movimientos de envases", icon: "history", color: "#00695C", group: "Inventario" },
  { tableName: "Reubicacion", label: "Reubicaciones", description: "Reubicaciones de clientes", icon: "place", color: "#AD1457", group: "Inventario" },
  { tableName: "VisitasIncrementalSucursalPibote", label: "Agenda", description: "Agenda de visitas", icon: "event-available", color: "#8E44AD", group: "Visitas" },
  { tableName: "DetalleVisitas", label: "Detalle Visitas", description: "Detalle de visitas programadas", icon: "event-note", color: "#6A1B9A", group: "Visitas" },
  { tableName: "VisitasVisitadosSucursal", label: "Visitas Realizadas", description: "Clientes ya visitados", icon: "fact-check", color: "#4527A0", group: "Visitas" },
  { tableName: "TipoVisita", label: "Tipos de Visita", description: "Catálogo tipos de visita", icon: "category", color: "#7B1FA2", group: "Visitas" },
  { tableName: "Usuarios", label: "Usuarios", description: "Usuarios del sistema", icon: "person", color: "#37474F", group: "Sistema" },
  { tableName: "Cias", label: "Compañías", description: "Compañías / empresas", icon: "business", color: "#546E7A", group: "Sistema" },
  { tableName: "FormaPago", label: "Formas de Pago", description: "Métodos de pago disponibles", icon: "credit-card", color: "#1976D2", group: "Sistema" },
];

type SyncStatus = "idle" | "syncing" | "success" | "error";

interface TableSyncState {
  status: SyncStatus;
  message?: string;
  records?: number;
}

export default function ManualSyncScreen() {
  const [tableStates, setTableStates] = useState<Record<string, TableSyncState>>({});
  const [syncingAll, setSyncingAll] = useState(false);

  const getUserParams = useCallback(async () => {
    const user = await AuthService.restoreSession();
    const sucursal = user?.sucursal_origen || user?.sucursal || 1;
    const idUsuario = user?.id || 0;
    return { sucursal, idUsuario };
  }, []);

  const handleSyncTable = useCallback(
    async (item: SyncItem) => {
      if (tableStates[item.tableName]?.status === "syncing") return;

      setTableStates((prev) => ({
        ...prev,
        [item.tableName]: { status: "syncing" },
      }));

      try {
        const { sucursal, idUsuario } = await getUserParams();

        const result = await FullSyncService.syncTable(
          item.tableName,
          sucursal,
          undefined,
          idUsuario,
        );

        if (result.success) {
          setTableStates((prev) => ({
            ...prev,
            [item.tableName]: {
              status: "success",
              message: "Sincronizado correctamente",
            },
          }));
        } else {
          setTableStates((prev) => ({
            ...prev,
            [item.tableName]: {
              status: "error",
              message: result.error || "Error desconocido",
            },
          }));
        }
      } catch (error: any) {
        setTableStates((prev) => ({
          ...prev,
          [item.tableName]: {
            status: "error",
            message: error?.message || "Error inesperado",
          },
        }));
      }
    },
    [tableStates, getUserParams],
  );

  const handleSyncAll = useCallback(async () => {
    if (syncingAll) return;

    Alert.alert(
      "Sincronizar Todo",
      "¿Desea sincronizar todas las tablas? Esto puede tomar varios minutos.",
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Sincronizar",
          onPress: async () => {
            setSyncingAll(true);

            const initialStates: Record<string, TableSyncState> = {};
            SYNC_ITEMS.forEach((item) => {
              initialStates[item.tableName] = { status: "syncing" };
            });
            setTableStates(initialStates);

            try {
              const { sucursal, idUsuario } = await getUserParams();

              const result = await FullSyncService.syncAll(
                sucursal,
                undefined,
                idUsuario,
              );

              const finalStates: Record<string, TableSyncState> = {};
              SYNC_ITEMS.forEach((item) => {
                finalStates[item.tableName] = result.success
                  ? { status: "success", message: "Sincronizado" }
                  : { status: "error", message: result.error || "Error" };
              });
              setTableStates(finalStates);

              Alert.alert(
                result.success ? "Sincronización Exitosa" : "Sincronización con Errores",
                result.success
                  ? "Todas las tablas se sincronizaron correctamente."
                  : `Hubo errores:\n${result.error}`,
              );
            } catch (error: any) {
              Alert.alert("Error", error?.message || "No se pudo completar");
            } finally {
              setSyncingAll(false);
            }
          },
        },
      ],
    );
  }, [syncingAll, getUserParams]);

  const getStatusIcon = (state?: TableSyncState) => {
    if (!state || state.status === "idle") {
      return <Icon name="sync" type="material" size={20} color={COLORS.muted} />;
    }
    switch (state.status) {
      case "syncing":
        return <ActivityIndicator size="small" color={COLORS.primary} />;
      case "success":
        return <Icon name="check-circle" type="material" size={20} color={COLORS.success} />;
      case "error":
        return <Icon name="error" type="material" size={20} color={COLORS.error} />;
    }
  };

  const getStatusColor = (state?: TableSyncState): string => {
    if (!state || state.status === "idle") return COLORS.muted;
    switch (state.status) {
      case "syncing": return COLORS.primary;
      case "success": return COLORS.success;
      case "error": return COLORS.error;
    }
  };

  const groups = [...new Set(SYNC_ITEMS.map((item) => item.group))];

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headerSection}>
          <Icon name="sync-problem" type="material" size={32} color={COLORS.primary} />
          <Text style={styles.title}>Sincronización Manual</Text>
          <Text style={styles.subtitle}>
            Selecciona las tablas que deseas sincronizar individualmente o sincroniza todas a la vez.
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.syncAllButton, syncingAll && styles.syncAllButtonDisabled]}
          onPress={handleSyncAll}
          disabled={syncingAll}
          activeOpacity={0.85}
        >
          {syncingAll ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Icon name="sync" type="material" size={22} color="#fff" />
          )}
          <Text style={styles.syncAllText}>
            {syncingAll ? "Sincronizando todo..." : "Sincronizar Todo"}
          </Text>
        </TouchableOpacity>

        {groups.map((group) => (
          <View key={group} style={styles.groupContainer}>
            <Text style={styles.groupTitle}>{group}</Text>
            {SYNC_ITEMS.filter((item) => item.group === group).map((item) => {
              const state = tableStates[item.tableName];
              const isSyncing = state?.status === "syncing";

              return (
                <View key={item.tableName} style={styles.card}>
                  <View style={styles.cardLeft}>
                    <View style={[styles.iconBadge, { backgroundColor: item.color }]}>
                      <Icon name={item.icon} type="material" size={18} color="#fff" />
                    </View>
                    <View style={styles.cardInfo}>
                      <Text style={styles.cardLabel}>{item.label}</Text>
                      {state?.status === "error" && state.message ? (
                        <Text style={styles.cardError} numberOfLines={2}>
                          {state.message}
                        </Text>
                      ) : state?.status === "success" ? (
                        <Text style={styles.cardSuccess}>Sincronizado</Text>
                      ) : (
                        <Text style={styles.cardDescription}>{item.description}</Text>
                      )}
                    </View>
                  </View>
                  <View style={styles.cardRight}>
                    {getStatusIcon(state)}
                    <TouchableOpacity
                      style={[styles.syncButton, isSyncing && styles.syncButtonDisabled]}
                      onPress={() => handleSyncTable(item)}
                      disabled={isSyncing}
                      activeOpacity={0.7}
                    >
                      {isSyncing ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <Text style={styles.syncButtonText}>Sincronizar</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  scrollContent: {
    padding: SPACING.m,
    paddingBottom: SPACING.xxl,
  },
  headerSection: {
    alignItems: "center",
    paddingVertical: SPACING.l,
  },
  title: {
    ...TYPOGRAPHY.h2,
    color: COLORS.textPrimary,
    marginTop: SPACING.s,
  },
  subtitle: {
    ...TYPOGRAPHY.body,
    color: COLORS.textSecondary,
    textAlign: "center",
    marginTop: SPACING.xs,
    paddingHorizontal: SPACING.l,
  },
  syncAllButton: {
    backgroundColor: COLORS.primary,
    borderRadius: BORDER_RADIUS.l,
    paddingVertical: SPACING.m,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: SPACING.s,
    marginBottom: SPACING.l,
    ...SHADOWS.medium,
  },
  syncAllButtonDisabled: {
    opacity: 0.7,
  },
  syncAllText: {
    color: "#fff",
    fontWeight: "bold",
    fontSize: 16,
  },
  groupContainer: {
    marginBottom: SPACING.m,
  },
  groupTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: COLORS.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: SPACING.s,
    marginLeft: SPACING.xs,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.m,
    padding: SPACING.m,
    marginBottom: SPACING.s,
    ...SHADOWS.small,
  },
  cardLeft: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    gap: SPACING.s,
  },
  iconBadge: {
    width: 36,
    height: 36,
    borderRadius: BORDER_RADIUS.s,
    alignItems: "center",
    justifyContent: "center",
  },
  cardInfo: {
    flex: 1,
  },
  cardLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: COLORS.textPrimary,
  },
  cardDescription: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  cardSuccess: {
    fontSize: 12,
    color: COLORS.success,
    fontWeight: "600",
    marginTop: 2,
  },
  cardError: {
    fontSize: 11,
    color: COLORS.error,
    marginTop: 2,
  },
  cardRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.s,
  },
  syncButton: {
    backgroundColor: COLORS.primary,
    borderRadius: BORDER_RADIUS.s,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    minWidth: 100,
    alignItems: "center",
    justifyContent: "center",
  },
  syncButtonDisabled: {
    opacity: 0.6,
  },
  syncButtonText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "bold",
  },
});
