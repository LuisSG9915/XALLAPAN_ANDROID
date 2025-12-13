import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  FlatList,
  Modal,
  ScrollView,
  Alert,
  Platform,
} from "react-native";
import { Icon, Input } from "react-native-elements";
import DateTimePicker from "@react-native-community/datetimepicker";
import FullSyncService from "../services/FullSyncService";
import AuthService, { Usuario } from "../services/AuthService";
import { COLORS, SPACING, SHADOWS, BORDER_RADIUS, TYPOGRAPHY } from "../theme/theme";

const API_BASE_URL = "https://cbinfo.no-ip.info:9031";

type Sucursal = { id_sucursal: number; nombre: string };

type Traspaso = {
  id: number;
  fecha: string;
  sucursalOrigen: string;
  sucursalDestino: number;
  traspaso_responsable_nombre_unique: string;
  folio: number;
  estatus: string;
  [key: string]: any;
};

type TraspasoDetalle = {
  descripcion: string;
  cantidad: number;
  idProducto?: number;
  claveProd?: string;
  esKit?: boolean;
};

export default function TraspasoRecepcionScreen() {
  const [formFiltro, setFormFiltro] = useState({
    sucursal: 0,
  });

  const [currentUser, setCurrentUser] = useState<Usuario | null>(null);
  const [currentSucursal, setCurrentSucursal] = useState<number>(1);

  const today = useMemo(() => new Date(), []);
  const [fecha1, setFecha1] = useState<Date>(today);
  const [fecha2, setFecha2] = useState<Date>(today);
  const [showPicker1, setShowPicker1] = useState(false);
  const [showPicker2, setShowPicker2] = useState(false);
  const [sucursales, setSucursales] = useState<Sucursal[]>([]);

  const [traspasos, setTraspasos] = useState<Traspaso[]>([]);
  const [loading, setLoading] = useState(false);
  const [detalles, setDetalles] = useState<TraspasoDetalle[]>([]);
  const [loadingDetalle, setLoadingDetalle] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [selected, setSelected] = useState<Traspaso | null>(null);

  useEffect(() => {
    const loadData = async () => {
      const user = await AuthService.restoreSession();
      if (user) {
        setCurrentUser(user);
        const sucursal =
          (user.sucursal_origen as number | null | undefined) ??
          (user.sucursal as number | null | undefined) ??
          1;
        setCurrentSucursal(sucursal);
        setFormFiltro({
          sucursal,
        });
      }

      try {
        const apiSucursales = await FullSyncService.getSucursales();
        setSucursales(
          apiSucursales.map((s) => ({
            id_sucursal: s.id,
            nombre: s.nombre,
          }))
        );
      } catch (error) {
        console.error("Error al cargar sucursales:", error);
        Alert.alert("Error", "No se pudieron cargar las sucursales");
      }
    };

    loadData();
  }, []);

  const formatDate = (date: Date): string => {
    const dd = String(date.getDate()).padStart(2, "0");
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const yyyy = date.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  };

  const formatDateForApi = (date: Date): string => {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  };

  const buildMovilInventarioId = (sucursal: number): number => {
    const suffix = sucursal.toString().padStart(3, "0");
    const base = Date.now().toString();
    return Number(`${base}${suffix}`);
  };

  const onChangeFecha1 = (event: any, selectedDate?: Date) => {
    if (Platform.OS === "android") {
      setShowPicker1(false);
    }
    if (selectedDate) {
      setFecha1(selectedDate);
    }
  };

  const onChangeFecha2 = (event: any, selectedDate?: Date) => {
    if (Platform.OS === "android") {
      setShowPicker2(false);
    }
    if (selectedDate) {
      setFecha2(selectedDate);
    }
  };

  const loadTraspasos = async () => {
    if (!currentUser) {
      Alert.alert("Sesión", "No se encontró usuario en sesión.");
      return;
    }

    try {
      setLoading(true);

      const sucursalParam = formFiltro.sucursal;
      const vendedorId = (currentUser as any).id ?? 0;
      const f1 = formatDateForApi(fecha1);
      const f2 = formatDateForApi(fecha2);

      let url = `${API_BASE_URL}/api/DetalleTraspasos/sp_traspasoBusquedaRecepcion?sucursal=${sucursalParam}&vendedor=${vendedorId}`;
      if (f1) url += `&fecha1=${encodeURIComponent(f1)}`;
      if (f2) url += `&fecha2=${encodeURIComponent(f2)}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      if (!Array.isArray(data)) {
        throw new Error("Respuesta inválida del servidor");
      }
      console.log(data);
      setTraspasos(
        data.map((t: any, index: number) => ({
          ...t,
          id: t.id ?? t.folio ?? index,
          fecha: t.fecha || new Date().toISOString(),
          sucursalOrigen: t.sucursalOrigen || "",
          sucursalDestino: t.sucDestino ?? t.sucursalDestino ?? 0,
          traspaso_responsable_nombre_unique: t.traspaso_responsable_nombre_unique || "",
          folio: t.folio ?? 0,
          estatus: t.estatus || "",
        }))
      );
    } catch (error: any) {
      console.error("Error al cargar traspasos:", error);
      Alert.alert("Error", error?.message || "No se pudieron cargar los traspasos");
    } finally {
      setLoading(false);
    }
  };

  const loadTraspasoDetalle = async (traspaso: Traspaso) => {
    if (!currentUser) {
      Alert.alert("Sesión", "No se encontró usuario en sesión.");
      return;
    }

    try {
      setLoadingDetalle(true);
      setDetalles([]);

      const sucursalOrigen =
        (currentUser.sucursal_origen as number | null | undefined) ?? 0;
      const vendedorId = (currentUser as any).id ?? 0;
      const almacenDestino = traspaso.almacenDestino ?? 0;
      const almacenOrigen = traspaso.almacenOrigen ?? 0;
      const sucOrigen = traspaso.sucOrigen ?? 0;
      const sucDestino = traspaso.sucDestino ?? 0;

      const url =
        `${API_BASE_URL}/api/DetalleTraspasos/sp_traspasoBusquedaFolioRecepecion` +
        `?folio=${traspaso.folio}` +
        `&sucursal=${sucursalOrigen}` +
        `&vendedor=${vendedorId}` +
        `&almacenDestino=${almacenDestino}` +
        `&almacenOrigen=${almacenOrigen}` +
        `&sucOrigen=${sucOrigen}` +
        `&sucDestino=${sucDestino}` +
        `&cambio=false&tipoCambio=0&usuario=${vendedorId}&usuarioEjecuta=${vendedorId}`;

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      if (!Array.isArray(data)) {
        throw new Error("Respuesta inválida del servidor");
      }

      console.log("[TraspasoRecepcion] DEBUG - Datos recibidos del servidor:", data);

      const productosLocales = FullSyncService.getProductos(10000);
      console.log(
        "[TraspasoRecepcion] DEBUG - Total productos en base local:",
        productosLocales.length
      );

      const detallesMapeados = data.map((d: any) => {
        // El servidor envía "claveProd" pero en realidad es el ID del producto
        const idProductoDelServidor = d.claveProd ? parseInt(d.claveProd, 10) : null;

        // Buscar información del producto en la base local usando el ID
        const producto = idProductoDelServidor
          ? productosLocales.find((p: any) => p.id === idProductoDelServidor)
          : null;

        const detalle = {
          descripcion: d.descripcion || "",
          cantidad: d.cantidad ?? 0,
          idProducto: idProductoDelServidor || 0,
          claveProd:
            producto?.claveProd?.toString() || idProductoDelServidor?.toString() || "0",
          esKit: producto?.esKit || false,
        };

        console.log(`[TraspasoRecepcion] DEBUG - Producto mapeado:`, {
          claveProdDelServidor: d.claveProd,
          idProductoDelServidor,
          descripcion: d.descripcion,
          cantidad: d.cantidad,
          productoEncontrado: !!producto,
          claveProdReal: detalle.claveProd,
          esKit: detalle.esKit,
          productoData: producto
            ? { id: producto.id, claveProd: producto.claveProd, esKit: producto.esKit }
            : null,
        });

        return detalle;
      });

      setDetalles(detallesMapeados);

      setSelected(traspaso);
      setModalOpen(true);
    } catch (error: any) {
      console.error("Error al cargar detalle de traspaso:", error);
      Alert.alert("Error", error?.message || "No se pudo cargar el detalle del traspaso");
    } finally {
      setLoadingDetalle(false);
    }
  };

  const receiveTraspaso = async () => {
    console.log("[TraspasoRecepcion] ========== INICIO receiveTraspaso ==========");
    console.log("[TraspasoRecepcion] Selected:", selected);
    console.log("[TraspasoRecepcion] CurrentUser:", currentUser);
    console.log("[TraspasoRecepcion] Detalles:", detalles);

    if (!selected || !currentUser) {
      console.log("[TraspasoRecepcion] ERROR - Falta selected o currentUser");
      return;
    }

    try {
      const sucursal =
        (currentUser.sucursal_origen as number | null | undefined) ??
        currentSucursal ??
        0;
      const vendedorId = (currentUser as any).id ?? 0;
      const almacenDestino = selected.almacenDestino ?? 0;
      const almacenOrigen = selected.almacenOrigen ?? 0;
      const sucOrigen = selected.sucOrigen ?? 0;
      const sucDestino = selected.sucDestino ?? 0;

      console.log("[TraspasoRecepcion] DEBUG - Parámetros de recepción:", {
        sucursal,
        vendedorId,
        almacenDestino,
        almacenOrigen,
        sucOrigen,
        sucDestino,
        folio: selected.folio,
      });

      const url =
        `${API_BASE_URL}/api/DetalleTraspasos/sp_traspasoBusquedaFolioRecepecion` +
        `?folio=${selected.folio}` +
        `&sucursal=${sucursal}` +
        `&vendedor=${vendedorId}` +
        `&almacenDestino=${almacenDestino}` +
        `&almacenOrigen=${almacenOrigen}` +
        `&sucOrigen=${sucOrigen}` +
        `&sucDestino=${sucDestino}` +
        `&cambio=true&tipoCambio=1&usuario=${vendedorId}&usuarioEjecuta=${vendedorId}&ip=12&dispositivo=12`;

      console.log("[TraspasoRecepcion] DEBUG - URL de recepción:", url);

      const response = await fetch(url);
      console.log("[TraspasoRecepcion] DEBUG - Response status:", response.status);

      let data: any = null;
      try {
        data = await response.json();
        console.log("[TraspasoRecepcion] DEBUG - Response data:", data);
      } catch (e) {
        console.log("[TraspasoRecepcion] ERROR - No se pudo parsear JSON:", e);
      }

      if (!response.ok) {
        const msg =
          (data && (data.mensaje || data.mensaje1)) || `HTTP ${response.status}`;
        console.log("[TraspasoRecepcion] ERROR - Response no OK:", msg);
        throw new Error(msg);
      }

      console.log("[TraspasoRecepcion] DEBUG - Recepción exitosa en servidor");

      // Actualizar inventario usando la misma lógica que SalesScreen (maneja kits correctamente)
      console.log("[TraspasoRecepcion] DEBUG - Preparando actualización de inventario");
      console.log(
        "[TraspasoRecepcion] DEBUG - Detalles actuales:",
        JSON.stringify(detalles, null, 2)
      );

      const inventarioUpdateItems = detalles.map((item, index) => {
        const updateItem = {
          sucursal,
          claveProd: parseInt(item.claveProd || "0", 10),
          cantidad: item.cantidad,
          esKit: item.esKit || false,
          idProducto: item.idProducto || 0,
        };
        console.log(
          `[TraspasoRecepcion] DEBUG - Item ${index + 1}/${detalles.length}:`,
          updateItem
        );
        return updateItem;
      });

      console.log("[TraspasoRecepcion] DEBUG - Items para actualizar inventario:", {
        totalItems: inventarioUpdateItems.length,
        sucursal,
        items: inventarioUpdateItems,
      });

      console.log("[TraspasoRecepcion] DEBUG - Llamando a updateInventarioAfterSale...");
      await FullSyncService.updateInventarioAfterSale(inventarioUpdateItems);
      console.log("[TraspasoRecepcion] ✅ Inventory updated successfully");

      // await FullSyncService.syncInventario(sucursal, selected.fecha);
      console.log("[TraspasoRecepcion] DEBUG - Recargando traspasos...");
      await loadTraspasos();

      console.log("[TraspasoRecepcion] DEBUG - Cerrando modal");
      setModalOpen(false);

      const msg =
        (data && (data.mensaje1 || data.mensaje)) ||
        "El traspaso ha sido recibido y sincronizado.";
      console.log(
        "[TraspasoRecepcion] ========== FIN receiveTraspaso (ÉXITO) =========="
      );
      Alert.alert("Recibido", msg);
    } catch (error: any) {
      console.error("[TraspasoRecepcion] ========== ERROR en receiveTraspaso ==========");
      console.error("[TraspasoRecepcion] Error completo:", error);
      console.error("[TraspasoRecepcion] Error stack:", error?.stack);
      Alert.alert("Error", error?.message || "No se pudo recibir el traspaso");
    }
  };

  const filteredTraspasos = useMemo(() => {
    return traspasos.filter((t) =>
      formFiltro.sucursal ? t.sucursalDestino === formFiltro.sucursal : true
    );
  }, [traspasos, formFiltro]);

  const onConsultar = () => {
    loadTraspasos();
  };

  const onRecibir = () => {
    if (!selected) return;
    Alert.alert("Confirmación", "¿Está seguro de recibir esta carga?", [
      { text: "Cancelar", style: "cancel" },
      {
        text: "Sí, recibir",
        onPress: () => {
          receiveTraspaso();
        },
      },
    ]);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Cargas</Text>

      <View style={styles.card}>
        <View style={styles.row}>
          <Icon name="person" type="material" color={COLORS.primary} size={24} />
          <Text style={styles.cardTitle}>Vendedor</Text>
        </View>
        <TextInput
          value={"Usuario Actual"}
          editable={false}
          style={[styles.input, styles.disabledInput]}
        />

        <View style={styles.row}>
          <Icon name="filter-list" type="material" color={COLORS.primary} size={24} />
          <Text style={styles.cardTitle}>Filtros</Text>
        </View>

        <View style={styles.dateRow}>
          <View style={styles.col}>
            <Text style={styles.smallLabel}>Desde</Text>
            <TouchableOpacity
              style={styles.dateInput}
              onPress={() => setShowPicker1(true)}
            >
              <Icon
                name="event"
                type="material"
                color={COLORS.primary}
                size={20}
                style={{ marginRight: 8 }}
              />
              <Text style={styles.dateText}>{formatDate(fecha1)}</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.col}>
            <Text style={styles.smallLabel}>Hasta</Text>
            <TouchableOpacity
              style={styles.dateInput}
              onPress={() => setShowPicker2(true)}
            >
              <Icon
                name="event"
                type="material"
                color={COLORS.primary}
                size={20}
                style={{ marginRight: 8 }}
              />
              <Text style={styles.dateText}>{formatDate(fecha2)}</Text>
            </TouchableOpacity>
          </View>
        </View>
        {showPicker1 && (
          <DateTimePicker
            value={fecha1}
            mode="date"
            display={Platform.OS === "ios" ? "spinner" : "default"}
            onChange={onChangeFecha1}
          />
        )}
        {showPicker2 && (
          <DateTimePicker
            value={fecha2}
            mode="date"
            display={Platform.OS === "ios" ? "spinner" : "default"}
            onChange={onChangeFecha2}
          />
        )}

        <Text style={styles.smallLabel}>Ruta destino</Text>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ marginBottom: SPACING.s }}
        >
          <View style={styles.rowWrap}>
            {/* <TouchableOpacity
              style={[styles.pill, formFiltro.sucursal === 0 && styles.pillOn]}
              onPress={() => setFormFiltro({ ...formFiltro, sucursal: 0 })}
            ></TouchableOpacity> */}
            {sucursales
              .filter((suc) => suc.id_sucursal == currentSucursal)
              .map((s) => (
                <TouchableOpacity
                  key={s.id_sucursal}
                  style={[
                    styles.pill,
                    formFiltro.sucursal === s.id_sucursal && styles.pillOn,
                  ]}
                  onPress={() =>
                    setFormFiltro({ ...formFiltro, sucursal: s.id_sucursal })
                  }
                >
                  <Text
                    style={[
                      styles.pillText,
                      formFiltro.sucursal === s.id_sucursal && styles.pillTextOn,
                    ]}
                  >
                    {s.nombre}
                  </Text>
                </TouchableOpacity>
              ))}
          </View>
        </ScrollView>
        <TouchableOpacity style={styles.secondaryBtn} onPress={onConsultar}>
          <Text style={styles.secondaryBtnText}>Consultar</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Resultados</Text>
        {loading ? (
          <Text style={styles.muted}>Cargando cargas...</Text>
        ) : filteredTraspasos.length === 0 ? (
          <Text style={styles.muted}>Sin resultados</Text>
        ) : (
          <FlatList
            data={filteredTraspasos}
            keyExtractor={(i) => String(i.id)}
            scrollEnabled={false}
            renderItem={({ item }) => (
              <View style={styles.rowItem}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.invTitle}>Folio {item.folio}</Text>
                  <Text style={styles.mutedRow}>
                    {item.fecha.split("T")[0]} • Origen: {item.sucursalOrigen}
                  </Text>
                </View>
                <View style={{ alignItems: "flex-end", gap: 4 }}>
                  <Text
                    style={[
                      styles.status,
                      item.estatus === "Pendiente"
                        ? styles.statusPending
                        : item.estatus === "No recibido"
                        ? styles.statusNoRecibido
                        : styles.statusDone,
                    ]}
                  >
                    {item.estatus}
                  </Text>
                  <TouchableOpacity
                    style={styles.smallBtn}
                    onPress={() => {
                      loadTraspasoDetalle(item);
                    }}
                  >
                    <Text style={styles.smallBtnText}>Ver Detalle</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          />
        )}
      </View>

      <Modal visible={modalOpen} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Visor de Cargas</Text>
              <TouchableOpacity
                onPress={() => setModalOpen(false)}
                style={styles.closeBtn}
              >
                <Icon
                  name="close"
                  type="material"
                  size={24}
                  color={COLORS.textSecondary}
                />
              </TouchableOpacity>
            </View>

            <View style={styles.infoBox}>
              <View style={styles.rowBetween}>
                <Text style={styles.folioLabel}>FOLIO</Text>
                <Text style={styles.folioValue}>#{selected?.folio}</Text>
              </View>
              <View style={styles.rowBetween}>
                <Text style={styles.folioLabel}>ESTATUS</Text>
                <Text
                  style={[
                    styles.statusValue,
                    selected?.estatus === "Pendiente"
                      ? { color: COLORS.warning }
                      : { color: COLORS.success },
                  ]}
                >
                  {selected?.estatus}
                </Text>
              </View>
              <View style={styles.divider} />
              <Text style={styles.infoText}>
                <Text style={{ fontWeight: "bold" }}>Origen:</Text>{" "}
                {selected?.sucursalOrigen}
              </Text>
              <Text style={styles.infoText}>
                <Text style={{ fontWeight: "bold" }}>Destino:</Text>{" "}
                {selected
                  ? sucursales.find((s) => s.id_sucursal === selected.sucursalDestino)
                      ?.nombre
                  : "-"}
              </Text>
            </View>

            <View style={[styles.card, { marginTop: SPACING.m, flex: 1 }]}>
              <Text style={styles.cardTitle}>Productos</Text>
              <View style={styles.tableHeader}>
                <Text style={[styles.th, { flex: 2 }]}>Producto</Text>
                <Text style={styles.thRight}>Cant.</Text>
              </View>
              <FlatList<TraspasoDetalle>
                data={detalles}
                keyExtractor={(_, idx) => String(idx)}
                renderItem={({ item }: { item: TraspasoDetalle }) => (
                  <View style={styles.tr}>
                    <Text style={[styles.td, { flex: 2 }]}>{item.descripcion}</Text>
                    <Text style={styles.tdRight}>{item.cantidad}</Text>
                  </View>
                )}
                ListEmptyComponent={<Text style={styles.muted}>Sin productos</Text>}
              />
            </View>

            <TouchableOpacity
              style={[
                styles.primaryBtn,
                (selected?.estatus === "Finalizado" ||
                  selected?.estatus === "Cancelado") &&
                  styles.primaryBtnDisabled,
              ]}
              onPress={onRecibir}
              disabled={
                selected?.estatus === "Finalizado" || selected?.estatus === "Cancelado"
              }
            >
              <Icon
                name="inventory"
                type="material"
                color="#fff"
                size={20}
                style={{ marginRight: 8 }}
              />
              <Text style={styles.primaryBtnText}>Confirmar Recepción</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: SPACING.m, paddingBottom: SPACING.xxl },
  title: {
    ...TYPOGRAPHY.h2,
    marginBottom: SPACING.m,
  },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.l,
    padding: SPACING.m,
    marginBottom: SPACING.m,
    ...SHADOWS.small,
  },
  cardTitle: {
    ...TYPOGRAPHY.h3,
    fontSize: 18,
    marginBottom: 0,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.s,
    marginBottom: SPACING.s,
    marginTop: SPACING.s,
  },
  smallLabel: {
    color: COLORS.textSecondary,
    marginBottom: 4,
    fontSize: 12,
    fontWeight: "600",
  },
  input: {
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: BORDER_RADIUS.m,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.m,
    color: COLORS.textPrimary,
    fontSize: 16,
  },
  disabledInput: {
    backgroundColor: COLORS.border,
    opacity: 0.7,
  },
  dateRow: { flexDirection: "row", gap: SPACING.m, marginBottom: SPACING.m },
  col: { flex: 1 },
  dateInput: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.primary,
    borderRadius: BORDER_RADIUS.m,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.m,
    marginTop: 4,
    flexDirection: "row",
    alignItems: "center",
  },
  dateText: {
    fontSize: 14,
    fontWeight: "600",
    color: COLORS.primary,
  },
  rowWrap: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 4,
    gap: SPACING.s,
  },
  pill: {
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    borderRadius: BORDER_RADIUS.l,
    backgroundColor: COLORS.background,
  },
  pillOn: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
    ...SHADOWS.small,
  },
  pillText: { color: COLORS.textSecondary, fontWeight: "500" },
  pillTextOn: { color: "#fff", fontWeight: "700" },
  secondaryBtn: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.primary,
    paddingVertical: SPACING.m,
    borderRadius: BORDER_RADIUS.l,
    alignItems: "center",
    marginTop: SPACING.m,
  },
  secondaryBtnText: { color: COLORS.primary, fontWeight: "700", fontSize: 16 },
  muted: { color: COLORS.muted, padding: SPACING.m, textAlign: "center" },
  mutedRow: { color: COLORS.textSecondary, fontSize: 12, marginTop: 4 },
  rowItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: SPACING.m,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  invTitle: { fontWeight: "600", color: COLORS.textPrimary, fontSize: 16 },
  status: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: BORDER_RADIUS.s,
    overflow: "hidden",
    fontSize: 10,
    fontWeight: "bold",
    marginBottom: 4,
    textAlign: "center",
  },
  statusPending: { backgroundColor: "#FFF3CD", color: "#F57C00" },
  statusDone: { backgroundColor: "#E8F5E9", color: "#2E7D32" },
  statusNoRecibido: { backgroundColor: "#F57C00", color: "#fff" },
  smallBtn: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: SPACING.s,
    paddingVertical: 4,
    borderRadius: BORDER_RADIUS.s,
  },
  smallBtnText: { color: "#fff", fontWeight: "600", fontSize: 10 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: BORDER_RADIUS.xl,
    borderTopRightRadius: BORDER_RADIUS.xl,
    height: "90%",
    padding: SPACING.l,
    ...SHADOWS.large,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: SPACING.m,
  },
  modalTitle: { ...TYPOGRAPHY.h2, fontSize: 20, marginBottom: 0 },
  closeBtn: { padding: 4 },
  infoBox: {
    backgroundColor: COLORS.background,
    padding: SPACING.m,
    borderRadius: BORDER_RADIUS.m,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  rowBetween: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  folioLabel: { color: COLORS.textSecondary, fontSize: 12, fontWeight: "600" },
  folioValue: { color: COLORS.textPrimary, fontSize: 14, fontWeight: "bold" },
  statusValue: { fontSize: 14, fontWeight: "bold" },
  divider: {
    height: 1,
    backgroundColor: COLORS.border,
    marginVertical: SPACING.s,
  },
  infoText: { color: COLORS.textPrimary, fontSize: 14, marginBottom: 2 },
  tableHeader: {
    flexDirection: "row",
    paddingVertical: SPACING.s,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    backgroundColor: COLORS.primaryLight,
    paddingHorizontal: SPACING.s,
    marginTop: SPACING.s,
    borderTopLeftRadius: BORDER_RADIUS.m,
    borderTopRightRadius: BORDER_RADIUS.m,
  },
  th: { flex: 1, fontWeight: "700", color: COLORS.primaryDark },
  thRight: {
    flex: 1,
    fontWeight: "700",
    color: COLORS.primaryDark,
    textAlign: "right",
  },
  tr: {
    flexDirection: "row",
    paddingVertical: SPACING.s,
    paddingHorizontal: SPACING.s,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  td: { flex: 1, color: COLORS.textPrimary },
  tdRight: {
    flex: 1,
    textAlign: "right",
    color: COLORS.textPrimary,
    fontWeight: "600",
  },
  primaryBtn: {
    backgroundColor: COLORS.primary,
    paddingVertical: SPACING.m,
    borderRadius: BORDER_RADIUS.l,
    alignItems: "center",
    justifyContent: "center",
    marginTop: SPACING.l,
    marginBottom: SPACING.l,
    flexDirection: "row",
    ...SHADOWS.medium,
  },
  primaryBtnDisabled: { opacity: 0.6, backgroundColor: COLORS.muted },
  primaryBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
