import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { Icon } from "react-native-elements";
import FotoUploadSettingsService from "../services/FotoUploadSettingsService";
import {
  BORDER_RADIUS,
  COLORS,
  SHADOWS,
  SPACING,
  TYPOGRAPHY,
} from "../theme/theme";

export default function FotoUploadSettingsScreen() {
  const [requireWifi, setRequireWifi] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setRequireWifi(await FotoUploadSettingsService.getRequireWifi());
    } finally {
      setLoading(false);
    }
  };

  const updateRequireWifi = async (value: boolean) => {
    if (saving) return;
    setSaving(true);
    try {
      await FotoUploadSettingsService.setRequireWifi(value);
      setRequireWifi(value);
    } catch (error) {
      Alert.alert(
        "Fotos",
        error instanceof Error
          ? error.message
          : "No se pudo guardar la configuración.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Icon name="photo-camera" type="material" color={COLORS.primary} size={32} />
        <Text style={styles.title}>Configuración de fotos</Text>
        <Text style={styles.subtitle}>
          Controla en qué tipo de conexión se envían las fotografías pendientes.
        </Text>
      </View>

      {loading ? (
        <ActivityIndicator color={COLORS.primary} />
      ) : (
        <View style={styles.card}>
          <View style={styles.option}>
            <View style={styles.optionText}>
              <Text style={styles.optionTitle}>Subir solo con Wi-Fi</Text>
              <Text style={styles.optionDescription}>
                {requireWifi
                  ? "Las fotos pendientes esperarán una conexión Wi-Fi."
                  : "Las fotos se pueden subir con Wi-Fi o datos móviles."}
              </Text>
            </View>
            <Switch
              value={requireWifi}
              onValueChange={(value) => void updateRequireWifi(value)}
              disabled={saving}
              trackColor={{ false: "#C7C7CC", true: COLORS.primaryLight }}
              thumbColor={requireWifi ? COLORS.primary : "#F4F3F4"}
            />
          </View>
        </View>
      )}

      <View style={styles.infoCard}>
        <Icon name="info-outline" type="material" color={COLORS.primary} size={20} />
        <Text style={styles.infoText}>
          Las fotos se comprimen en el dispositivo antes de enviarse. Por defecto,
          la subida está permitida con cualquier conexión.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: SPACING.m, paddingBottom: SPACING.xxl },
  header: { alignItems: "center", paddingVertical: SPACING.l },
  title: { ...TYPOGRAPHY.h2, color: COLORS.textPrimary, marginTop: SPACING.s },
  subtitle: {
    ...TYPOGRAPHY.body,
    color: COLORS.textSecondary,
    marginTop: SPACING.xs,
    textAlign: "center",
  },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.l,
    padding: SPACING.m,
    ...SHADOWS.small,
  },
  option: { alignItems: "center", flexDirection: "row", gap: SPACING.m },
  optionText: { flex: 1 },
  optionTitle: { color: COLORS.textPrimary, fontSize: 16, fontWeight: "700" },
  optionDescription: {
    color: COLORS.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4,
  },
  infoCard: {
    alignItems: "flex-start",
    backgroundColor: COLORS.primaryLight,
    borderLeftColor: COLORS.primary,
    borderLeftWidth: 4,
    borderRadius: BORDER_RADIUS.l,
    flexDirection: "row",
    gap: SPACING.s,
    marginTop: SPACING.m,
    padding: SPACING.m,
  },
  infoText: { color: COLORS.primaryDark, flex: 1, fontSize: 13, lineHeight: 19 },
});
