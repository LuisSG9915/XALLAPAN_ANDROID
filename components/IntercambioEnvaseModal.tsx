import React, { useState, useEffect } from "react";
import { View, Text, StyleSheet, Modal, TouchableOpacity, TextInput, FlatList, ScrollView } from "react-native";
import { COLORS, SPACING, SHADOWS, BORDER_RADIUS, TYPOGRAPHY } from "../theme/theme";
import FullSyncService from "../services/FullSyncService";

type EnvaseProducto = {
  id: number;
  claveProd: string;
  descripcion: string;
};

type IntercambioEnvaseModalProps = {
  visible: boolean;
  cantidad: number;
  costoAutomatico: number;
  envaseEntregadoClave?: number;
  envaseEntregadoDesc?: string;
  productoId?: number; // ID del producto seleccionado (para buscar en KitIntercambio)
  onAccept: (data: {
    envaseEntregadoClave: number;
    envaseEntregadoDesc: string;
    envaseRecibidoClave: number;
    envaseRecibidoDesc: string;
    observacion: string;
    costo: number;
  }) => void;
  onCancel: () => void;
};

const CLAVE_ENVASE_XALLAPAN = 16001;
const DESC_ENVASE_XALLAPAN = "CAMBIO DE ENVASE XALLAPAN";

export default function IntercambioEnvaseModal({
  visible,
  cantidad,
  costoAutomatico,
  envaseEntregadoClave: propEntregadoClave,
  envaseEntregadoDesc: propEntregadoDesc,
  productoId,
  onAccept,
  onCancel,
}: IntercambioEnvaseModalProps) {
  const claveEntregado = propEntregadoClave ?? CLAVE_ENVASE_XALLAPAN;
  const descEntregado = propEntregadoDesc ?? DESC_ENVASE_XALLAPAN;
  const [envasesDisponibles, setEnvasesDisponibles] = useState<EnvaseProducto[]>([]);
  const [envaseRecibido, setEnvaseRecibido] = useState<EnvaseProducto | null>(null);
  const [observacion, setObservacion] = useState("");
  const [mostrarLista, setMostrarLista] = useState(false);

  useEffect(() => {
    console.log("[IntercambioModal] 🔔 useEffect - visible:", visible, "costoIntercambio:", costoAutomatico, "productoId:", productoId);
    console.log(
      `[IntercambioModal] DEBUG propEntregadoClave=${propEntregadoClave}, propEntregadoDesc=${propEntregadoDesc}`,
    );
    console.log(`[IntercambioModal] DEBUG claveEntregado=${claveEntregado}, descEntregado=${descEntregado}`);
    if (visible) {
      console.log("[IntercambioModal] ✅ Modal visible, cargando envases desde KitIntercambio...");

      let envasesProductos: any[] = [];

      // Obtener IDs de envases desde KitIntercambio si hay productoId
      if (productoId) {
        const idsEnvasesOtro = FullSyncService.getEnvasesIntercambioPorProducto(productoId);
        console.log(`[IntercambioModal] IDs de envases (idEnvaseOtro) desde KitIntercambio:`, idsEnvasesOtro);

        if (idsEnvasesOtro.length > 0) {
          // Obtener productos directamente por sus IDs (idEnvaseOtro son IDs de productos)
          envasesProductos = FullSyncService.getProductosPorIds(idsEnvasesOtro);
          console.log(`[IntercambioModal] Productos obtenidos por IDs: ${envasesProductos.length}`);
        }
      }

      // Si no hay envases configurados en KitIntercambio o no hay productoId,
      // usar todos los productos envaseRecibe como fallback
      if (envasesProductos.length === 0) {
        console.log("[IntercambioModal] No hay envases en KitIntercambio, usando fallback de envaseRecibe");
        envasesProductos = FullSyncService.getProductosEnvaseRecibe(50);
      }

      // Formatear y filtrar el envase entregado
      let formateados: EnvaseProducto[] = envasesProductos
        .filter((p: any) => {
          const clave = parseInt(p.claveProd || "0", 10);
          return clave !== claveEntregado;
        })
        .map((p: any) => ({
          id: p.id,
          claveProd: p.claveProd || String(p.id),
          descripcion: p.descripcion || "Sin descripción",
        }));

      // Eliminar duplicados por descripción (quedarse con el primero)
      const descripcionesMap = new Map<string, EnvaseProducto>();
      formateados.forEach((p) => {
        if (!descripcionesMap.has(p.descripcion)) {
          descripcionesMap.set(p.descripcion, p);
        }
      });

      const sinDuplicados = Array.from(descripcionesMap.values());
      console.log(`[IntercambioModal] Envases disponibles: ${sinDuplicados.length}`);

      setEnvasesDisponibles(sinDuplicados);
      setEnvaseRecibido(null);
      setObservacion("");
      setMostrarLista(false);
      console.log("[IntercambioModal] ✅ Estado reseteado");
    }
  }, [visible, costoAutomatico, claveEntregado, descEntregado, productoId]);

  const handleAccept = () => {
    if (!envaseRecibido) return;
    console.log(`[IntercambioModal] ✅ Aceptando con costo de INTERCAMBIO: $${costoAutomatico}`);
    onAccept({
      envaseEntregadoClave: claveEntregado,
      envaseEntregadoDesc: descEntregado,
      envaseRecibidoClave: parseInt(envaseRecibido.claveProd || "0", 10),
      envaseRecibidoDesc: envaseRecibido.descripcion,
      observacion: observacion.trim(),
      costo: costoAutomatico,
    });
  };

  return (
    <Modal visible={visible} animationType="fade" transparent>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>INTERCAMBIO DE ENVASES</Text>
          <Text style={styles.subtitleInfo}>Cantidad: {cantidad}</Text>

          {/* Envase a entregar - fijo */}
          <View style={styles.section}>
            <TouchableOpacity onPress={() => console.log(descEntregado + claveEntregado)}>
              <Text style={styles.sectionLabel}>SELECCIONE EL ENVASE A ENTREGAR</Text>
              <View style={styles.fixedValue}>
                <Text style={styles.fixedValueText}>{descEntregado}</Text>
                <Text style={styles.fixedValueSub}>Clave: {claveEntregado}</Text>
              </View>
            </TouchableOpacity>
          </View>

          {/* Envase recibido - seleccionable */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>SELECCIONE EL ENVASE RECIBIDO</Text>
            <TouchableOpacity style={styles.selectBtn} onPress={() => setMostrarLista(!mostrarLista)}>
              <Text style={styles.selectBtnText}>
                {envaseRecibido ? envaseRecibido.descripcion : "Seleccionar envase..."}
              </Text>
            </TouchableOpacity>

            {mostrarLista && (
              <View style={styles.listContainer}>
                <FlatList
                  data={envasesDisponibles}
                  keyExtractor={(item) => String(item.id)}
                  style={styles.flatList}
                  renderItem={({ item }) => (
                    <TouchableOpacity
                      style={[styles.listItem, envaseRecibido?.id === item.id && styles.listItemSelected]}
                      onPress={() => {
                        setEnvaseRecibido(item);
                        setMostrarLista(false);
                        console.log(
                          `[IntercambioModal] ✅ Seleccionado envase: ${item.descripcion} (ID: ${item.id}, Clave: ${item.claveProd})`,
                        );
                      }}
                    >
                      <Text style={styles.listItemText}>{item.descripcion}</Text>
                      <Text style={styles.listItemSub}>Clave: {item.claveProd}</Text>
                    </TouchableOpacity>
                  )}
                  ListEmptyComponent={<Text style={styles.emptyText}>No se encontraron envases</Text>}
                />
              </View>
            )}
          </View>

          {/* Costo automático */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>COSTO DEL PRODUCTO INTERCAMBIO:</Text>
            <View style={styles.fixedValue}>
              <Text style={styles.fixedValueText}>${costoAutomatico.toFixed(2)}</Text>
              <Text style={styles.fixedValueSub}>Precio del producto de intercambio según lista del cliente</Text>
            </View>
          </View>

          {/* Observación */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>OBSERVACION:</Text>
            <TextInput
              style={styles.textInput}
              placeholder="Puede ser nulo"
              placeholderTextColor={COLORS.muted}
              value={observacion}
              onChangeText={setObservacion}
              multiline
            />
          </View>

          {/* Botones */}
          <View style={styles.buttonsRow}>
            <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
              <Text style={styles.cancelBtnText}>CANCELAR</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.acceptBtn, !envaseRecibido && styles.acceptBtnDisabled]}
              onPress={handleAccept}
              disabled={!envaseRecibido}
            >
              <Text style={styles.acceptBtnText}>ACEPTAR</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: SPACING.m,
  },
  card: {
    backgroundColor: COLORS.background,
    borderRadius: BORDER_RADIUS.l,
    padding: SPACING.l,
    width: "100%",
    maxHeight: "85%",
    ...SHADOWS.large,
  },
  title: {
    ...TYPOGRAPHY.h3,
    textAlign: "center",
    marginBottom: SPACING.xs,
    color: COLORS.primary,
    fontWeight: "bold",
  },
  subtitleInfo: {
    textAlign: "center",
    color: COLORS.textSecondary,
    fontSize: 14,
    marginBottom: SPACING.m,
  },
  section: {
    marginBottom: SPACING.m,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: COLORS.textPrimary,
    marginBottom: SPACING.xs,
  },
  fixedValue: {
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.s,
    padding: SPACING.m,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.primary,
  },
  fixedValueText: {
    fontSize: 16,
    fontWeight: "600",
    color: COLORS.primary,
  },
  fixedValueSub: {
    fontSize: 12,
    color: COLORS.muted,
    marginTop: 2,
  },
  selectBtn: {
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.s,
    padding: SPACING.m,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  selectBtnText: {
    fontSize: 14,
    color: COLORS.textPrimary,
  },
  listContainer: {
    maxHeight: 180,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: BORDER_RADIUS.s,
    marginTop: SPACING.xs,
    backgroundColor: COLORS.background,
  },
  flatList: {
    maxHeight: 180,
  },
  listItem: {
    padding: SPACING.s,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  listItemSelected: {
    backgroundColor: COLORS.primaryLight,
  },
  listItemText: {
    fontSize: 14,
    color: COLORS.textPrimary,
  },
  listItemSub: {
    fontSize: 11,
    color: COLORS.muted,
  },
  emptyText: {
    textAlign: "center",
    padding: SPACING.m,
    color: COLORS.muted,
    fontSize: 13,
  },
  textInput: {
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.s,
    padding: SPACING.m,
    borderWidth: 1,
    borderColor: COLORS.border,
    fontSize: 14,
    color: COLORS.textPrimary,
    minHeight: 50,
  },
  buttonsRow: {
    flexDirection: "row",
    gap: SPACING.s,
    marginTop: SPACING.s,
  },
  cancelBtn: {
    flex: 1,
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.s,
    padding: SPACING.m,
    alignItems: "center",
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cancelBtnText: {
    color: COLORS.textSecondary,
    fontWeight: "600",
    fontSize: 14,
  },
  acceptBtn: {
    flex: 1,
    backgroundColor: COLORS.primary,
    borderRadius: BORDER_RADIUS.s,
    padding: SPACING.m,
    alignItems: "center",
  },
  acceptBtnDisabled: {
    opacity: 0.5,
  },
  acceptBtnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 14,
  },
});
