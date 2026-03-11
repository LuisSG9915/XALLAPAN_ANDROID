import React, { useMemo, useState, useEffect } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform, ActivityIndicator, Alert } from "react-native";
import { Icon } from "react-native-elements";
import DateTimePicker from "@react-native-community/datetimepicker";
import FullSyncService from "../services/FullSyncService";
import AuthService from "../services/AuthService";
import BluetoothPrinterService from "../services/BluetoothPrinterService";
import TicketPrinter from "../services/TicketPrinter";
import { COLORS, SPACING, SHADOWS, BORDER_RADIUS, TYPOGRAPHY } from "../theme/theme";

type ProductoCantidad = {
  nombreProducto: string;
  cantTotal: number;
};

type ProductoImporte = {
  nombreProducto: string;
  importe: number;
};

type TipoPagoTotal = {
  descripcion: string;
  total: number;
};

type InvABordoItem = {
  descripcion: string;
  saldo: number;
};

type EnvasesData = {
  envVendido: number;
  envCambiado: number;
  envPrestado: number;
  cambiadosPorProducto: Array<{ descripcionCorta: string; claveProd: number; cantidadEntrada: number }>;
};

const TIPO_PAGO_MAP: Record<number, string> = {
  1: "CONTADO",
  2: "TRANSFERENCIA",
  3: "CRÉDITO",
  4: "CUPONES",
};

export default function CortesScreen() {
  const today = useMemo(() => {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Mexico_City",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = formatter.formatToParts(new Date());
    const year = parseInt(parts.find((p) => p.type === "year")?.value ?? "2024", 10);
    const month = parseInt(parts.find((p) => p.type === "month")?.value ?? "1", 10);
    const day = parseInt(parts.find((p) => p.type === "day")?.value ?? "1", 10);
    return new Date(year, month - 1, day);
  }, []);

  const [fechaSeleccionada, setFechaSeleccionada] = useState<Date>(today);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [loading, setLoading] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [printerConnected, setPrinterConnected] = useState(false);
  const [printerName, setPrinterName] = useState("");
  const [ruta, setRuta] = useState("");
  const [userName, setUserName] = useState("");
  const [nombreRuta, setNombreRuta] = useState("");
  const [fechaHoraActual, setFechaHoraActual] = useState("");
  const [inventarioVendido, setInventarioVendido] = useState<ProductoCantidad[]>([]);
  const [inventarioABordo, setInventarioABordo] = useState<InvABordoItem[]>([]);
  const [importesPorProducto, setImportesPorProducto] = useState<ProductoImporte[]>([]);
  const [tiposPago, setTiposPago] = useState<TipoPagoTotal[]>([]);
  const [envases, setEnvases] = useState<EnvasesData>({
    envVendido: 0,
    envCambiado: 0,
    envPrestado: 0,
    cambiadosPorProducto: [],
  });

  const formatFechaHoraMexico = (): string => {
    return new Intl.DateTimeFormat("es-MX", {
      timeZone: "America/Mexico_City",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date());
  };

  const formatFechaDisplay = (date: Date): string => {
    const dd = String(date.getDate()).padStart(2, "0");
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const yyyy = date.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  };

  useEffect(() => {
    const status = BluetoothPrinterService.getStatus();
    setPrinterConnected(status.connected);
    setPrinterName(status.printer?.name || "");

    const loadUser = async () => {
      const user = await AuthService.restoreSession();
      if (user) {
        const nombre = user.nombre || "";
        const clave = user.claveEmpleado || "";
        console.log(user);
        setUserName(clave ? `${clave} - ${nombre}` : nombre);
        setNombreRuta(user.sucursalNombre || "");
      }
    };
    loadUser();

    setFechaHoraActual(formatFechaHoraMexico());
    const timer = setInterval(() => {
      setFechaHoraActual(formatFechaHoraMexico());
    }, 60000);

    loadData(today);

    return () => clearInterval(timer);
  }, []);

  const loadData = async (fecha: Date) => {
    setLoading(true);
    try {
      await FullSyncService.initialize();

      const user = AuthService.currentUser;
      const sucursal: number | undefined =
        user?.sucursal_origen !== undefined && user?.sucursal_origen !== null
          ? (user.sucursal_origen as number)
          : user?.sucursal !== undefined && user?.sucursal !== null
          ? (user.sucursal as number)
          : undefined;

      const startOfDay = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate(), 0, 0, 0, 0);
      const endOfDay = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate(), 23, 59, 59, 999);

      // Obtener ID de ruta desde las visitas (para referencia, aunque ya tenemos el nombre)
      const rutaId = FullSyncService.getRutaForDate(startOfDay, endOfDay);
      setRuta(user?.dSucursal);
      console.log(user);

      const ventas = FullSyncService.getVentasForDate(startOfDay, endOfDay, sucursal);

      const ventasPorProducto: Record<string, number> = {};
      const importesPorProd: Record<string, number> = {};
      const pagosPorTipo: Record<number, number> = {};

      for (const v of ventas) {
        const nombre: string = v.nombreProducto || "Sin nombre";
        const cant: number = v.cantProducto || 0;
        const precio: number = v.precio || 0;
        const importe: number = v.importe || 0;
        const tipoPago: number = v.tipoPago || 0;

        ventasPorProducto[nombre] = (ventasPorProducto[nombre] || 0) + cant;
        importesPorProd[nombre] = (importesPorProd[nombre] || 0) + cant * precio;
        pagosPorTipo[tipoPago] = (pagosPorTipo[tipoPago] || 0) + importe;
      }

      setInventarioVendido(
        Object.entries(ventasPorProducto).map(([nombre, cant]) => ({
          nombreProducto: nombre,
          cantTotal: cant,
        })),
      );

      setImportesPorProducto(
        Object.entries(importesPorProd).map(([nombre, imp]) => ({
          nombreProducto: nombre,
          importe: imp,
        })),
      );

      setTiposPago(
        Object.entries(pagosPorTipo)
          .map(([tipo, total]) => ({
            descripcion: TIPO_PAGO_MAP[parseInt(tipo, 10)] || `Tipo ${tipo}`,
            total,
          }))
          .filter((t) => t.total > 0),
      );

      const invABordo = FullSyncService.getInventarioABordoForDate(startOfDay, endOfDay, sucursal);
      setInventarioABordo(
        invABordo.map((item: any) => ({
          descripcion: (item.descripcion as string) || String(item.claveProd ?? ""),
          saldo: item.saldo ?? 0,
        })),
      );

      const envasesData = FullSyncService.getEnvasesHistorialForDate(startOfDay, endOfDay);
      setEnvases(envasesData);
      console.log("=== ENVASES DATA ===");
      console.log(envasesData);

      // Ver todo el historial completo
      const todosLosRegistros = FullSyncService.getTodosEnvasesHistorial(startOfDay, endOfDay);
      console.log("=== TODOS LOS REGISTROS HISTORIAL ===");
      console.log(`Total registros: ${todosLosRegistros.length}`);
      console.log({ todosLosRegistros });
    } catch (error) {
      console.error("Error cargando datos de corte:", error);
      Alert.alert("Error", "No se pudieron cargar los datos del corte");
    } finally {
      setLoading(false);
    }
  };

  const handleImprimir = async () => {
    if (printing) return;
    const status = BluetoothPrinterService.getStatus();
    setPrinterConnected(status.connected);
    setPrinterName(status.printer?.name || "");

    if (!status.connected) {
      Alert.alert("Sin impresora", "No hay impresora Bluetooth conectada. Ve a Configuración de Impresora.");
      return;
    }

    setPrinting(true);
    try {
      await TicketPrinter.printCorteTicket({
        fecha: fechaHoraActual,
        ruta: nombreRuta || ruta,
        usuario: userName,
        inventarioVendido,
        inventarioABordo,
        importesPorProducto,
        tiposPago,
        envases,
      });
      Alert.alert("✅ Impreso", `Corte enviado a ${status.printer?.name || "impresora"}`);
    } catch (error) {
      Alert.alert("❌ Error", "No se pudo imprimir el corte");
    } finally {
      setPrinting(false);
    }
  };

  const handleDateChange = (_: any, selectedDate?: Date) => {
    if (Platform.OS === "android") {
      setShowDatePicker(false);
    }
    if (selectedDate) {
      setFechaSeleccionada(selectedDate);
      loadData(selectedDate);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header con badge de impresora */}
      <View style={styles.headerRow}>
        <Text style={styles.screenTitle}>Corte de Ruta</Text>
        {printerConnected && (
          <View style={styles.printerBadge}>
            <Icon name="print" type="material" size={13} color="#fff" style={{ marginRight: 4 }} />
            <Text style={styles.printerBadgeText}>{printerName || "Conectada"}</Text>
          </View>
        )}
      </View>

      {!printerConnected && (
        <View style={styles.warningCard}>
          <Icon name="warning" type="material" color={COLORS.warning} size={22} />
          <Text style={styles.warningText}>No hay impresora configurada. Ve a Configuración de Impresora.</Text>
        </View>
      )}

      {/* Selector de fecha */}
      <View style={styles.card}>
        <View style={styles.rowCenter}>
          <Icon name="event" type="material" color={COLORS.primary} size={20} style={{ marginRight: 6 }} />
          <Text style={styles.formLabel}>Fecha del Corte</Text>
        </View>
        <TouchableOpacity style={styles.dateButton} onPress={() => setShowDatePicker(true)} activeOpacity={0.8}>
          <Icon name="calendar-today" type="material" color={COLORS.primary} size={18} style={{ marginRight: 8 }} />
          <Text style={styles.dateButtonText}>{formatFechaDisplay(fechaSeleccionada)}</Text>
          <Icon name="arrow-drop-down" type="material" color={COLORS.primary} size={22} />
        </TouchableOpacity>
        {showDatePicker && (
          <DateTimePicker
            value={fechaSeleccionada}
            mode="date"
            display={Platform.OS === "ios" ? "spinner" : "default"}
            onChange={handleDateChange}
            maximumDate={new Date()}
          />
        )}
      </View>

      {loading && (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="large" color={COLORS.primary} />
          <Text style={styles.loadingText}>Cargando datos...</Text>
        </View>
      )}

      {/* Encabezado del Corte */}
      <View style={[styles.card, styles.corteCard]}>
        <View style={styles.corteHeaderRow}>
          <Text style={styles.corteLabelLeft}>CORTE</Text>
          <Text style={styles.corteLabelRight}>RUTA</Text>
        </View>
        <View style={styles.corteDivider} />
        <View style={styles.corteHeaderRow}>
          <Text style={styles.corteBold}>FECHA Y HORA</Text>
          <Text style={styles.corteValue}>{ruta || "—"}</Text>
        </View>
        <View style={styles.corteHeaderRow}>
          <Text style={styles.corteSmall}>{fechaHoraActual}</Text>
          <Text style={styles.corteSmall}> </Text>
        </View>
        <View style={styles.corteDivider} />
        <Text style={styles.corteBold}>NOMBRE USUARIO</Text>
        <Text style={styles.corteSmall}>{userName || "—"}</Text>
      </View>

      {/* Inventario Vendido */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>INVENTARIO VENDIDO</Text>
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.th, styles.thFlex]}>PRODUCTOS</Text>
            <Text style={[styles.th, styles.thRight]}>CANTIDAD</Text>
          </View>
          {inventarioVendido.length === 0 ? (
            <Text style={styles.emptyText}>Sin ventas para esta fecha</Text>
          ) : (
            inventarioVendido.map((item, idx) => (
              <View key={idx} style={styles.tr}>
                <Text style={[styles.td, styles.tdFlex]}>{item.nombreProducto}</Text>
                <Text style={[styles.td, styles.tdRight]}>{item.cantTotal}</Text>
              </View>
            ))
          )}
        </View>
      </View>

      {/* Envases */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>ENVASES</Text>
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.th, styles.thFlex]}>CONCEPTO</Text>
            <Text style={[styles.th, styles.thRight]}>CANT</Text>
          </View>
          <View style={styles.tr}>
            <Text style={[styles.td, styles.tdFlex]}>Env Vendido</Text>
            <Text style={[styles.td, styles.tdRight]}>{envases.envVendido || "—"}</Text>
          </View>
          <View style={styles.tr}>
            <Text style={[styles.td, styles.tdFlex]}>Env Cambiado</Text>
            <Text style={[styles.td, styles.tdRight]}>{envases.envCambiado || "—"}</Text>
          </View>
          {envases.cambiadosPorProducto.length > 0 && (
            <View style={[styles.table, { marginTop: 6 }]}>
              <View style={styles.tableHeader}>
                <Text style={[styles.th, styles.thFlex]}>ENVASES</Text>
                <Text style={[styles.th, styles.thRight]}>CANT</Text>
              </View>
              {envases.cambiadosPorProducto.map((item, idx) => (
                <View key={idx} style={styles.tr}>
                  <Text style={[styles.td, styles.tdFlex]}>{item.descripcionCorta}</Text>
                  <Text style={[styles.td, styles.tdRight]}>{item.cantidadEntrada}</Text>
                </View>
              ))}
            </View>
          )}
          <View style={styles.tr}>
            <Text style={[styles.td, styles.tdFlex]}>Env Prestado</Text>
            <Text style={[styles.td, styles.tdRight]}>{envases.envPrestado || "—"}</Text>
          </View>
        </View>
      </View>

      {/* Inventario A Bordo */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>INVENTARIO A BORDO</Text>
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.th, styles.thFlex]}>PRODUCTOS</Text>
            <Text style={[styles.th, styles.thRight]}>CANTIDAD</Text>
          </View>
          {inventarioABordo.length === 0 ? (
            <Text style={styles.emptyText}>Sin inventario para esta fecha</Text>
          ) : (
            inventarioABordo.map((item, idx) => (
              <View key={idx} style={styles.tr}>
                <Text style={[styles.td, styles.tdFlex]}>{item.descripcion}</Text>
                <Text style={[styles.td, styles.tdRight]}>{item.saldo}</Text>
              </View>
            ))
          )}
        </View>
      </View>

      {/* Importes */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>IMPORTES</Text>
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.th, styles.thFlex]}>PRODUCTOS</Text>
            <Text style={[styles.th, styles.thRight]}>IMPORTE</Text>
          </View>
          {importesPorProducto.length === 0 ? (
            <Text style={styles.emptyText}>Sin datos</Text>
          ) : (
            importesPorProducto.map((item, idx) => (
              <View key={idx} style={styles.tr}>
                <Text style={[styles.td, styles.tdFlex]}>{item.nombreProducto}</Text>
                <Text style={[styles.td, styles.tdRight]}>${item.importe.toFixed(2)}</Text>
              </View>
            ))
          )}
        </View>
      </View>

      {/* Tipos de Pago */}
      <View style={styles.card}>
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.th, styles.thFlex]}>TIPOS PAGO</Text>
            <Text style={[styles.th, styles.thRight]}>IMPORTE</Text>
          </View>
          {tiposPago.length === 0 ? (
            <Text style={styles.emptyText}>Sin datos</Text>
          ) : (
            tiposPago.map((item, idx) => (
              <View key={idx} style={styles.tr}>
                <Text style={[styles.td, styles.tdFlex]}>{item.descripcion}</Text>
                <Text style={[styles.td, styles.tdRight]}>${item.total.toFixed(2)}</Text>
              </View>
            ))
          )}
        </View>
      </View>

      {/* Botón Imprimir */}
      <TouchableOpacity
        style={[styles.printBtn, (!printerConnected || printing || loading) && styles.printBtnDisabled]}
        onPress={handleImprimir}
        disabled={!printerConnected || printing || loading}
        activeOpacity={0.85}
      >
        <Icon name="print" type="material" color="#fff" size={22} style={{ marginRight: 8 }} />
        <Text style={styles.printBtnText}>{printing ? "Imprimiendo..." : "Imprimir Corte"}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={() => {
          const startOfDay = new Date(
            fechaSeleccionada.getFullYear(),
            fechaSeleccionada.getMonth(),
            fechaSeleccionada.getDate(),
            0,
            0,
            0,
            0,
          );
          const endOfDay = new Date(
            fechaSeleccionada.getFullYear(),
            fechaSeleccionada.getMonth(),
            fechaSeleccionada.getDate(),
            23,
            59,
            59,
            999,
          );

          console.log("=== DEBUG CORTE ===");
          console.log("Fecha seleccionada:", fechaSeleccionada.toLocaleDateString("es-MX"));
          console.log("Rango:", startOfDay, "a", endOfDay);

          const user = AuthService.currentUser;
          const sucursal = user?.sucursal_origen ?? user?.sucursal ?? 38;
          console.log("Sucursal:", sucursal);

          const ventas = FullSyncService.getVentasForDate(startOfDay, endOfDay, sucursal);
          console.log("Total ventas encontradas:", ventas.length);
          console.log("Ventas:", ventas);

          const rutaId = FullSyncService.getRutaForDate(startOfDay, endOfDay);
          console.log("Ruta ID:", rutaId);
          console.log("Nombre ruta:", nombreRuta);

          console.log("===================");
        }}
        style={{ padding: 10, backgroundColor: "#888", marginTop: 10 }}
      >
        <Text style={{ color: "#fff" }}>🐛 Ver Info en Console</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  content: {
    padding: SPACING.m,
    paddingBottom: SPACING.xxl,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: SPACING.m,
  },
  screenTitle: {
    ...TYPOGRAPHY.h2,
  },
  printerBadge: {
    backgroundColor: COLORS.success,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    borderRadius: BORDER_RADIUS.l,
    flexDirection: "row",
    alignItems: "center",
  },
  printerBadgeText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "600",
  },
  warningCard: {
    backgroundColor: "#FFF3E0",
    borderRadius: BORDER_RADIUS.m,
    padding: SPACING.m,
    marginBottom: SPACING.m,
    borderLeftWidth: 4,
    borderLeftColor: COLORS.warning,
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.s,
    ...SHADOWS.small,
  },
  warningText: {
    flex: 1,
    color: COLORS.warning,
    fontSize: 13,
    fontWeight: "500",
  },
  printBtn: {
    backgroundColor: COLORS.primary,
    borderRadius: BORDER_RADIUS.l,
    paddingVertical: SPACING.m,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginTop: SPACING.s,
    ...SHADOWS.medium,
  },
  printBtnDisabled: {
    backgroundColor: COLORS.muted,
  },
  printBtnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 16,
  },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.l,
    padding: SPACING.m,
    marginBottom: SPACING.m,
    ...SHADOWS.small,
  },
  corteCard: {
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  rowCenter: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: SPACING.s,
  },
  formLabel: {
    ...TYPOGRAPHY.h3,
    fontSize: 16,
    marginBottom: 0,
  },
  dateButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.primary,
    borderRadius: BORDER_RADIUS.m,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s + 2,
  },
  dateButtonText: {
    flex: 1,
    fontSize: 17,
    fontWeight: "600",
    color: COLORS.primary,
  },
  loadingBox: {
    alignItems: "center",
    paddingVertical: SPACING.l,
    gap: SPACING.s,
  },
  loadingText: {
    color: COLORS.muted,
    fontSize: 14,
  },
  corteHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 4,
  },
  corteDivider: {
    height: 1,
    backgroundColor: COLORS.border,
    marginVertical: SPACING.xs,
  },
  corteLabelLeft: {
    fontSize: 14,
    fontWeight: "700",
    color: COLORS.textPrimary,
  },
  corteLabelRight: {
    fontSize: 14,
    fontWeight: "700",
    color: COLORS.textPrimary,
  },
  corteBold: {
    fontSize: 14,
    fontWeight: "700",
    color: COLORS.textPrimary,
  },
  corteValue: {
    fontSize: 15,
    fontWeight: "700",
    color: COLORS.primary,
  },
  corteSmall: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginTop: 2,
    marginBottom: 4,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: COLORS.textPrimary,
    marginBottom: SPACING.s,
  },
  table: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: BORDER_RADIUS.m,
    overflow: "hidden",
  },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: COLORS.primaryLight,
    paddingVertical: SPACING.s,
    paddingHorizontal: SPACING.m,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  th: {
    fontWeight: "700",
    fontSize: 13,
    color: COLORS.primaryDark,
  },
  thFlex: {
    flex: 2,
  },
  thRight: {
    flex: 1,
    textAlign: "right",
  },
  tr: {
    flexDirection: "row",
    paddingVertical: SPACING.s,
    paddingHorizontal: SPACING.m,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  td: {
    fontSize: 14,
    color: COLORS.textPrimary,
  },
  tdFlex: {
    flex: 2,
  },
  tdRight: {
    flex: 1,
    textAlign: "right",
    fontWeight: "600",
  },
  tdMuted: {
    fontSize: 13,
    color: COLORS.muted,
    fontStyle: "italic",
  },
  emptyText: {
    color: COLORS.muted,
    fontSize: 13,
    textAlign: "center",
    padding: SPACING.m,
  },
});
