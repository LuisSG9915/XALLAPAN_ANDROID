import React from "react";
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { COLORS, SPACING, BORDER_RADIUS, TYPOGRAPHY, SHADOWS } from "../theme/theme";
import { AppUpdatePhase, AppUpdateState } from "../services/AppUpdateService";

type Props = {
  state: AppUpdateState;
  onUseData: () => void;
  onPostpone: () => void;
  onInstall: () => void;
};

const formatBytes = (bytes?: number | null): string => {
  if (!bytes || bytes <= 0) return "tamaño no disponible";
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const titleForPhase = (phase: AppUpdatePhase): string => {
  if (phase === "downloading") return "Descargando actualización";
  if (phase === "ready_to_install") return "Actualización lista";
  if (phase === "awaiting_install_permission") return "Permiso requerido";
  if (phase === "installing") return "Instalando actualización";
  if (phase === "error") return "No se pudo actualizar";
  return "Nueva versión disponible";
};

export default function AppUpdateModal({ state, onUseData, onPostpone, onInstall }: Props) {
  const update = state.update;
  const visible = Boolean(update && state.blocking && state.phase !== "idle");
  if (!update) return null;

  const isWaitingForData = state.phase === "awaiting_data_consent";
  const isDownloading = state.phase === "downloading";
  const isReady = state.phase === "ready_to_install";
  const isPermission = state.phase === "awaiting_install_permission";
  const isInstalling = state.phase === "installing";
  const isError = state.phase === "error";

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (isWaitingForData || isError) onPostpone();
      }}
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>{titleForPhase(state.phase)}</Text>
          <Text style={styles.version}>Versión {update.versionApp} ({update.versionCode})</Text>

          {update.notas ? <Text style={styles.notes}>{update.notas}</Text> : null}

          {isWaitingForData ? (
            <Text style={styles.description}>
              La actualización está disponible. Se recomienda Wi‑Fi para no consumir datos móviles. Esta descarga ocupa {formatBytes(update.tamanoBytes)}.
            </Text>
          ) : null}

          {isDownloading ? (
            <View style={styles.progressSection}>
              <Text style={styles.description}>Descargando en segundo plano. No cierres la aplicación.</Text>
              <View style={styles.progressTrack}>
                <View style={[styles.progressValue, { width: `${Math.max(0, Math.min(1, state.progress)) * 100}%` }]} />
              </View>
              <Text style={styles.progressText}>{Math.round(state.progress * 100)}%</Text>
            </View>
          ) : null}

          {isReady ? (
            <Text style={styles.description}>
              La descarga terminó y el archivo fue validado. Android abrirá la pantalla de instalación.
            </Text>
          ) : null}

          {isPermission ? (
            <Text style={styles.description}>
              Android necesita permitir que Xallapan instale esta actualización. Activa el permiso y vuelve a la aplicación.
            </Text>
          ) : null}

          {isInstalling ? (
            <Text style={styles.description}>Se abrió el instalador de Android. Confirma la instalación para terminar.</Text>
          ) : null}

          {isError ? <Text style={styles.error}>{state.error || "Puedes continuar y reintentar más tarde."}</Text> : null}

          {isWaitingForData ? (
            <View style={styles.actions}>
              <TouchableOpacity style={styles.primaryButton} onPress={onUseData}>
                <Text style={styles.primaryButtonText}>Usar datos</Text>
              </TouchableOpacity>
              {update.permitirPosponerDatos ? (
                <TouchableOpacity style={styles.secondaryButton} onPress={onPostpone}>
                  <Text style={styles.secondaryButtonText}>Ahora no</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}

          {isReady || isPermission ? (
            <TouchableOpacity style={styles.primaryButton} onPress={onInstall}>
              <Text style={styles.primaryButtonText}>{isPermission ? "Abrir configuración" : "Instalar actualización"}</Text>
            </TouchableOpacity>
          ) : null}

          {isDownloading || isInstalling ? <ActivityIndicator color={COLORS.primary} size="large" /> : null}

          {isError ? (
            <TouchableOpacity style={styles.secondaryButton} onPress={onPostpone}>
              <Text style={styles.secondaryButtonText}>Continuar temporalmente</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    justifyContent: "center",
    padding: SPACING.l,
  },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.l,
    padding: SPACING.l,
    ...SHADOWS.large,
  },
  title: {
    ...TYPOGRAPHY.h2,
    color: COLORS.textPrimary,
    marginBottom: SPACING.xs,
  },
  version: {
    ...TYPOGRAPHY.body,
    color: COLORS.primary,
    fontWeight: "700",
    marginBottom: SPACING.m,
  },
  notes: {
    ...TYPOGRAPHY.body,
    color: COLORS.textSecondary,
    marginBottom: SPACING.m,
  },
  description: {
    ...TYPOGRAPHY.body,
    color: COLORS.textSecondary,
    lineHeight: 21,
    marginBottom: SPACING.m,
  },
  progressSection: {
    marginBottom: SPACING.m,
  },
  progressTrack: {
    height: 10,
    borderRadius: 5,
    overflow: "hidden",
    backgroundColor: COLORS.muted,
  },
  progressValue: {
    height: "100%",
    backgroundColor: COLORS.primary,
  },
  progressText: {
    color: COLORS.textSecondary,
    textAlign: "right",
    marginTop: SPACING.xs,
  },
  error: {
    ...TYPOGRAPHY.body,
    color: COLORS.error,
    marginBottom: SPACING.m,
  },
  actions: {
    gap: SPACING.s,
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: COLORS.primary,
    borderRadius: BORDER_RADIUS.m,
    paddingVertical: SPACING.m,
    paddingHorizontal: SPACING.l,
    marginTop: SPACING.s,
  },
  primaryButtonText: {
    color: "#fff",
    fontWeight: "700",
  },
  secondaryButton: {
    alignItems: "center",
    borderRadius: BORDER_RADIUS.m,
    paddingVertical: SPACING.m,
    paddingHorizontal: SPACING.l,
    marginTop: SPACING.s,
  },
  secondaryButtonText: {
    color: COLORS.primary,
    fontWeight: "700",
  },
});
