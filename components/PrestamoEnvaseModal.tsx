import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TextInput,
  Platform,
  ScrollView,
  KeyboardAvoidingView,
} from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { COLORS, SPACING, SHADOWS, BORDER_RADIUS, TYPOGRAPHY } from "../theme/theme";
import FullSyncService from "../services/FullSyncService";

type PrestamoEnvaseModalProps = {
  visible: boolean;
  clienteNombre: string;
  cantidad: number;
  productoSeleccionado?: { id: number; claveProd: string; descripcion: string } | null;
  onAccept: (data: {
    idProdPrestado: number;
    claveProdPrestado: number;
    descProdPrestado: string;
    observacion: string;
    fechaDevolucion: string;
  }) => void;
  onCancel: () => void;
};

const CLAVE_DEFAULT_PRESTAMO = 1000;

export default function PrestamoEnvaseModal({
  visible,
  clienteNombre,
  cantidad,
  productoSeleccionado,
  onAccept,
  onCancel,
}: PrestamoEnvaseModalProps) {
  const [idProdPrestado, setIdProdPrestado] = useState<number>(0);
  const [claveProdPrestado, setClaveProdPrestado] = useState<number>(CLAVE_DEFAULT_PRESTAMO);
  const [descProdPrestado, setDescProdPrestado] = useState<string>("ENVASE XALLAPAN VENDIDO");
  const [observacion, setObservacion] = useState("");
  const [fechaDevolucion, setFechaDevolucion] = useState<Date>(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [sinFecha, setSinFecha] = useState(false);

  useEffect(() => {
    if (visible) {
      setObservacion("");
      setFechaDevolucion(new Date());
      setShowDatePicker(false);
      setSinFecha(false);

      // Usar el producto seleccionado por el usuario (pasado como prop)
      const productos = FullSyncService.getProductos();
      const prod: any = productoSeleccionado
        ? productos.find((p: any) => p.id === productoSeleccionado.id) || productoSeleccionado
        : productos.find((p: any) => p.prestamo);
      if (prod) {
        setIdProdPrestado(prod.id || 0);
        const clave = parseInt(prod.claveProd || "0", 10);
        setClaveProdPrestado(clave || 0);
        console.log("[Prestamo] Producto prestamo encontrado:", {
          id: prod.id,
          claveProd: prod.claveProd,
          descripcion: prod.descripcion,
        });

        // Buscar insumo del kit del producto prestamo con envasePrestado = true
        const kits = FullSyncService.getKitsByProducto(prod.id);
        console.log(
          "[Prestamo] Kits del producto:",
          kits.map((k: any) => ({
            id: k.id,
            idProducto: k.idProducto,
            idInsumo: k.idInsumo,
            envaseIntercambio: k.envaseIntercambio,
            envasePrestado: k.envasePrestado,
          })),
        );
        const kitPrestado = kits.find((k: any) => k.envasePrestado);
        console.log(
          "[Prestamo] Kit con envasePrestado:",
          kitPrestado ? { id: kitPrestado.id, idInsumo: kitPrestado.idInsumo } : "ninguno",
        );
        if (kitPrestado) {
          // Buscar la descripción del insumo (idInsumo es el id del producto insumo)
          const insumo = productos.find((p: any) => p.id === kitPrestado.idInsumo);
          console.log(
            "[Prestamo] Insumo encontrado por id:",
            insumo
              ? { id: insumo.id, claveProd: insumo.claveProd, descripcion: insumo.descripcion }
              : `NO encontrado (buscado id=${kitPrestado.idInsumo})`,
          );
          if (insumo) {
            setDescProdPrestado(insumo.descripcion || prod.descripcion || "ENVASE XALLAPAN VENDIDO");
          } else {
            setDescProdPrestado(prod.descripcion || "ENVASE XALLAPAN VENDIDO");
          }
        } else {
          setDescProdPrestado(prod.descripcion || "ENVASE XALLAPAN VENDIDO");
        }
      } else {
        setIdProdPrestado(0);
        setClaveProdPrestado(0);
        setDescProdPrestado("ENVASE XALLAPAN VENDIDO");
      }
    }
  }, [visible]);

  const handleAccept = () => {
    const formatDate = (date: Date): string => {
      const day = String(date.getDate()).padStart(2, "0");
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const year = date.getFullYear();
      return `${day}/${month}/${year}`;
    };

    onAccept({
      idProdPrestado,
      claveProdPrestado,
      descProdPrestado,
      observacion: observacion.trim(),
      fechaDevolucion: sinFecha ? "" : formatDate(fechaDevolucion),
    });
  };

  const onDateChange = (event: any, selectedDate?: Date) => {
    setShowDatePicker(Platform.OS === "ios");
    if (selectedDate) {
      setFechaDevolucion(selectedDate);
    }
  };

  const formatDisplayDate = (date: Date): string => {
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
  };

  return (
    <Modal visible={visible} animationType="fade" transparent>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.backdrop}>
        <View style={styles.card}>
          <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            <Text style={styles.title}>PRESTAMO DE ENVASES AUTORIZADOS</Text>

            {/* Cliente */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>CLIENTE SELECCIONADO</Text>
              <View style={styles.fixedValue}>
                <Text style={styles.fixedValueText}>{clienteNombre}</Text>
              </View>
            </View>

            {/* Producto prestado */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>CLAVE PRODUCTO PRESTADO</Text>
              <View style={styles.fixedValue}>
                <Text style={styles.fixedValueText}>{descProdPrestado}</Text>
                <Text style={styles.fixedValueSub}>Clave: {claveProdPrestado}</Text>
              </View>
              <Text style={styles.subtitleInfo}>Cantidad: {cantidad}</Text>
            </View>

            {/* Observación */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>OBSERVACION:</Text>
              <TextInput
                style={styles.textInput}
                placeholder="Observacion del prestamo"
                placeholderTextColor={COLORS.muted}
                value={observacion}
                onChangeText={setObservacion}
                multiline
              />
            </View>

            {/* Fecha devolución estimada */}
            <View style={styles.section}>
              <View style={styles.labelRow}>
                <Text style={styles.sectionLabel}>FECHA DEVOLUCION ESTIMADO</Text>
                <TouchableOpacity style={styles.sinFechaCheckbox} onPress={() => setSinFecha(!sinFecha)}>
                  <View style={[styles.checkbox, sinFecha && styles.checkboxChecked]}>
                    {sinFecha && <Text style={styles.checkmark}>✓</Text>}
                  </View>
                  <Text style={styles.sinFechaLabel}>Sin fecha</Text>
                </TouchableOpacity>
              </View>
              {!sinFecha && (
                <>
                  <TouchableOpacity style={styles.datePickerBtn} onPress={() => setShowDatePicker(true)}>
                    <Text style={styles.datePickerText}>{formatDisplayDate(fechaDevolucion)}</Text>
                  </TouchableOpacity>
                  {showDatePicker && (
                    <DateTimePicker
                      value={fechaDevolucion}
                      mode="date"
                      display={Platform.OS === "ios" ? "spinner" : "default"}
                      onChange={onDateChange}
                      minimumDate={new Date()}
                    />
                  )}
                </>
              )}
              {sinFecha && (
                <View style={styles.sinFechaInfo}>
                  <Text style={styles.sinFechaInfoText}>No se registrará fecha de devolución</Text>
                </View>
              )}
            </View>

            {/* Botones */}
            <View style={styles.buttonsRow}>
              <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
                <Text style={styles.cancelBtnText}>CANCELAR</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.acceptBtn} onPress={handleAccept}>
                <Text style={styles.acceptBtnText}>ACEPTAR</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
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
  scrollContent: {
    flexGrow: 1,
  },
  title: {
    ...TYPOGRAPHY.h3,
    textAlign: "center",
    marginBottom: SPACING.m,
    color: COLORS.primary,
    fontWeight: "bold",
  },
  subtitleInfo: {
    color: COLORS.textSecondary,
    fontSize: 13,
    marginTop: SPACING.xs,
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
  datePickerBtn: {
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.s,
    padding: SPACING.m,
    borderWidth: 1,
    borderColor: COLORS.border,
    minHeight: 50,
    justifyContent: "center",
  },
  datePickerText: {
    fontSize: 14,
    color: COLORS.textPrimary,
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
  acceptBtnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 14,
  },
  labelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: SPACING.xs,
  },
  sinFechaCheckbox: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.xs,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderWidth: 2,
    borderColor: COLORS.primary,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.surface,
  },
  checkboxChecked: {
    backgroundColor: COLORS.primary,
  },
  checkmark: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "bold",
  },
  sinFechaLabel: {
    fontSize: 12,
    color: COLORS.textSecondary,
    fontWeight: "600",
  },
  sinFechaInfo: {
    backgroundColor: "#FFF3E0",
    borderRadius: BORDER_RADIUS.s,
    padding: SPACING.m,
    borderLeftWidth: 3,
    borderLeftColor: "#FF9800",
  },
  sinFechaInfoText: {
    fontSize: 12,
    color: "#E65100",
    fontStyle: "italic",
  },
});
