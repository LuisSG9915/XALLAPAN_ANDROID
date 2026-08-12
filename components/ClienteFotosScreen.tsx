import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import AuthService from "../services/AuthService";
import FullSyncService from "../services/FullSyncService";
import ClienteFotosService, {
  ClienteFoto,
} from "../services/ClienteFotosService";

const MAX_FOTOS = 5;

const getImageUri = (foto: ClienteFoto, miniature = true): string | null => {
  const base64 = miniature
    ? foto.fotoMiniaturaBase64 || foto.fotoBase64
    : foto.fotoBase64 || foto.fotoMiniaturaBase64;
  if (base64) {
    const mimeType = miniature
      ? foto.miniaturaMimeType || "image/jpeg"
      : foto.mimeType || "image/jpeg";
    return `data:${mimeType};base64,${base64}`;
  }
  if (foto.fotoMiniatura)
    return foto.fotoMiniatura.startsWith("file:")
      ? foto.fotoMiniatura
      : `file://${foto.fotoMiniatura}`;
  if (foto.foto)
    return foto.foto.startsWith("file:") ? foto.foto : `file://${foto.foto}`;
  return null;
};

export default function ClienteFotosScreen({ route }: { route: any }) {
  const idCliente = Number(route?.params?.idCliente || 0);
  const nombreCliente = route?.params?.nombreCliente || `Cliente #${idCliente}`;
  const [fotos, setFotos] = useState<ClienteFoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<ClienteFoto | null>(null);

  const load = useCallback(async () => {
    if (!idCliente) return;
    setLoading(true);
    try {
      await FullSyncService.initialize();
      ClienteFotosService.setRealm((FullSyncService as any).realm);
      setFotos(ClienteFotosService.getFotos(idCliente));
    } catch (error) {
      console.error(
        "[ClienteFotosScreen] Error cargando fotos locales:",
        error
      );
      Alert.alert("Fotos", "No se pudieron cargar las fotografías locales.");
    } finally {
      setLoading(false);
    }
  }, [idCliente]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  const addPhoto = async (source: "camera" | "library") => {
    try {
      const user = await AuthService.restoreSession();
      if (!user?.id) throw new Error("No se encontró el usuario de sesión.");
      await FullSyncService.initialize();
      ClienteFotosService.setRealm((FullSyncService as any).realm);
      await ClienteFotosService.selectAndQueue(
        idCliente,
        Number(user.id),
        source
      );
      setFotos(ClienteFotosService.getFotos(idCliente));
      Alert.alert("Fotografía guardada");
    } catch (error) {
      if (error instanceof Error && error.message === "CAPTURE_CANCELLED")
        return;
      Alert.alert(
        "Fotos",
        error instanceof Error
          ? error.message
          : "No se pudo guardar la fotografía."
      );
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const disponibles = Math.max(0, MAX_FOTOS - fotos.length);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>Fotos del cliente</Text>
          <Text style={styles.client}>{nombreCliente}</Text>
        </View>
        <Text style={[styles.counter, disponibles === 0 && styles.counterFull]}>
          {fotos.length}/{MAX_FOTOS}
        </Text>
      </View>

      <View style={styles.actions}>
        <Pressable
          style={[styles.action, disponibles === 0 && styles.disabled]}
          disabled={disponibles === 0}
          onPress={() => void addPhoto("camera")}
        >
          <Text style={styles.actionText}>Tomar foto</Text>
        </Pressable>
        <Pressable
          style={[
            styles.action,
            styles.gallery,
            disponibles === 0 && styles.disabled,
          ]}
          disabled={disponibles === 0}
          onPress={() => void addPhoto("library")}
        >
          <Text style={styles.actionText}>Galería</Text>
        </Pressable>
      </View>

      {disponibles === 0 && (
        <Text style={styles.limit}>
          Se alcanzó el límite de 5 fotografías para este cliente.
        </Text>
      )}
      {loading ? (
        <ActivityIndicator style={styles.loader} size="large" color="#007AFF" />
      ) : (
        <FlatList
          data={fotos}
          keyExtractor={(item) => item.id}
          numColumns={2}
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          contentContainerStyle={
            fotos.length === 0 ? styles.emptyContent : styles.grid
          }
          renderItem={({ item }) => {
            const uri = getImageUri(item);
            return (
              <Pressable style={styles.card} onPress={() => setSelected(item)}>
                {uri ? (
                  <Image source={{ uri }} style={styles.image} />
                ) : (
                  <View style={styles.noImage}>
                    <Text>Sin imagen</Text>
                  </View>
                )}
                <Text style={styles.status}>
                  {item.estado === "sincronizada"
                    ? "Sincronizada"
                    : "Pendiente de envío"}
                </Text>
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <Text style={styles.empty}>
              Aún no hay fotografías para este cliente.
            </Text>
          }
        />
      )}

      <Modal
        visible={Boolean(selected)}
        transparent
        animationType="fade"
        onRequestClose={() => setSelected(null)}
      >
        <Pressable style={styles.modal} onPress={() => setSelected(null)}>
          {selected && getImageUri(selected, false) && (
            <Image
              source={{ uri: getImageUri(selected, false)! }}
              style={styles.fullImage}
              resizeMode="contain"
            />
          )}
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F7F7F9" },
  header: {
    padding: 18,
    backgroundColor: "white",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  headerText: { flex: 1 },
  title: { color: "#1C1C1E", fontSize: 20, fontWeight: "700" },
  client: { color: "#636366", marginTop: 4 },
  counter: { color: "#007AFF", fontSize: 20, fontWeight: "700" },
  counterFull: { color: "#FF3B30" },
  actions: { flexDirection: "row", gap: 10, padding: 14 },
  action: {
    flex: 1,
    padding: 12,
    borderRadius: 10,
    alignItems: "center",
    backgroundColor: "#007AFF",
  },
  gallery: { backgroundColor: "#34C759" },
  disabled: { backgroundColor: "#BDBDBD" },
  actionText: { color: "white", fontWeight: "700" },
  limit: { color: "#8E1B10", paddingHorizontal: 16, paddingBottom: 10 },
  loader: { marginTop: 40 },
  grid: { padding: 8 },
  emptyContent: { flexGrow: 1, justifyContent: "center" },
  card: {
    flex: 1,
    margin: 6,
    backgroundColor: "white",
    borderRadius: 10,
    overflow: "hidden",
  },
  image: { width: "100%", aspectRatio: 1, backgroundColor: "#E5E5EA" },
  noImage: {
    width: "100%",
    aspectRatio: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#E5E5EA",
  },
  status: { color: "#636366", fontSize: 11, padding: 7 },
  empty: { color: "#636366", textAlign: "center", padding: 24 },
  modal: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.92)",
    justifyContent: "center",
    alignItems: "center",
  },
  fullImage: { width: "100%", height: "80%" },
});
