import React, { useMemo, useState, useEffect } from "react";
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
import { Icon } from "react-native-elements";
import DateTimePicker from "@react-native-community/datetimepicker";
import TicketPrinter, { SaleTicketData } from "../services/TicketPrinter";
import FullSyncService from "../services/FullSyncService";
import FacturaService, { FacturaItem } from "../services/FacturaService";
import { COLORS, SPACING, SHADOWS, BORDER_RADIUS, TYPOGRAPHY } from "../theme/theme";
import AuthService from "../services/AuthService";

type ReporteItem = {
  id: number;
  no_venta: number;
  fecha: string;
  nombre: string;
  importe: number;
  tipoPago: "Efectivo" | "Credito" | "Transferencia" | "Cupon" | "";
  facturacion?: boolean;
  timbrado?: "0" | "1";
  folioFactura?: boolean;
  facturacionMovil?: boolean;
  sucursal?: number;
  caja?: number;
  cve_cliente?: number;
  nombreProducto?: string;
  cantProducto?: number;
  precio?: number;
};

type GroupedSale = {
  idMovil: number;
  no_venta: number;
  fecha: string;
  nombre: string;
  totalImporte: number;
  tipoPago: "Efectivo" | "Credito" | "Transferencia" | "Cupon" | "";
  sucursal?: number;
  cve_cliente?: number;
  caja?: number;
  folioFactura?: boolean;
  facturacionMovil?: boolean;
  timbrado?: "0" | "1";
  productos: Array<{
    nombreProducto: string;
    cantProducto: number;
    precio: number;
    importe: number;
  }>;
};
type TicketLine = string;

export default function ReporteVentasScreen() {
  const today = useMemo(() => new Date(), []);
  const LOCAL_SALE_ID_THRESHOLD = 1700000000;

  const formatDate = (date: Date): string => {
    const dd = String(date.getDate()).padStart(2, "0");
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const yyyy = date.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  };

  const [fecha1, setFecha1] = useState<Date>(today);
  const [fecha2, setFecha2] = useState<Date>(today);
  const [showPicker1, setShowPicker1] = useState(false);
  const [showPicker2, setShowPicker2] = useState(false);
  const [items, setItems] = useState<ReporteItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [allVentas, setAllVentas] = useState<any[]>([]);
  const [groupedItems, setGroupedItems] = useState<GroupedSale[]>([]);
  const [debugInfo, setDebugInfo] = useState<string>("");
  const [isLocalView, setIsLocalView] = useState(false);

  const [ticketVisible, setTicketVisible] = useState(false);
  const [ticketContent, setTicketContent] = useState<TicketLine[]>([]);

  const total = useMemo(() => items.reduce((s, i) => s + i.importe, 0), [items]);
  const totalEfectivo = useMemo(
    () => items.filter((i) => i.tipoPago === "Efectivo").reduce((s, i) => s + i.importe, 0),
    [items],
  );
  const totalCredito = useMemo(
    () => items.filter((i) => i.tipoPago === "Credito").reduce((s, i) => s + i.importe, 0),
    [items],
  );
  const totalTransferencia = useMemo(
    () => items.filter((i) => i.tipoPago === "Transferencia").reduce((s, i) => s + i.importe, 0),
    [items],
  );
  const totalCupones = useMemo(
    () => items.filter((i) => i.tipoPago === "Cupon").reduce((s, i) => s + i.importe, 0),
    [items],
  );

  useEffect(() => {
    loadVentas();
  }, []);

  const loadVentas = async () => {
    try {
      await FullSyncService.initialize();
      const ventas = FullSyncService.getVentas(500);
      setAllVentas(ventas);
    } catch (error) {
      console.error("Error al cargar ventas:", error);
      Alert.alert("Error", "No se pudieron cargar las ventas de la base local");
    }
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

  const mapTipoPago = (tipo: number | undefined): "Efectivo" | "Credito" | "Transferencia" | "Cupon" | "" => {
    if (tipo === 1) return "Efectivo";
    if (tipo === 2) return "Transferencia";
    if (tipo === 3) return "Credito";
    if (tipo === 4) return "Cupon";
    return "";
  };

  const filtrarVentas = (soloLocales: boolean) => {
    console.log("Filtrando ventas, soloLocales:", soloLocales);
    setLoading(true);
    setIsLocalView(soloLocales);
    try {
      if (!allVentas || allVentas.length === 0) {
        Alert.alert("Sin datos", "No hay ventas cargadas. Intenta sincronizar primero.");
        setLoading(false);
        return;
      }

      if (!fecha1 || !fecha2) {
        Alert.alert("Error", "Selecciona ambas fechas");
        setLoading(false);
        return;
      }

      // Obtener sucursal del usuario actual
      const currentUser = AuthService.currentUser;
      const sucursalUsuario = currentUser?.sucursal_origen;

      // Crear copias para no mutar los estados y normalizar rango a día completo
      const fecha1Parsed = new Date(fecha1);
      fecha1Parsed.setHours(0, 0, 0, 0);
      const fecha2Parsed = new Date(fecha2);
      fecha2Parsed.setHours(23, 59, 59, 999);

      const filtered = allVentas.filter((venta) => {
        if (!venta.fecha) return false;
        const ventaDate = new Date(venta.fecha);
        // Filtrar por fecha siempre
        const inDateRange = ventaDate >= fecha1Parsed && ventaDate <= fecha2Parsed;

        // Filtrar por sucursal del usuario (si está definida)
        const inSucursal = sucursalUsuario === undefined || venta.sucursal === sucursalUsuario;

        if (soloLocales) {
          // Consultar Local: solo ventas con id >= threshold (ventas locales)
          return (
            inDateRange && inSucursal && venta.noVenta == 0 && venta.claveProd !== 0 // ✅ FILTRO ADICIONAL
          );
        } else {
          // Consultar: solo ventas con id < threshold (ventas remotas/API)
          return (
            inDateRange && inSucursal && venta.noVenta > 0 && venta.claveProd !== 0 // ✅ FILTRO ADICIONAL
          );
        }
      });
      console.log("[Reporte] Filtered results", { count: filtered });
      // consoleRealm("pagos", filtered);
      const mapped: ReporteItem[] = filtered.map((venta) => ({
        id: venta.id,
        idMovil: venta.idMovil,
        no_venta: venta.noVenta || 0,
        fecha: venta.fecha ? new Date(venta.fecha).toISOString() : new Date().toISOString(),
        nombre: venta.nombreCliente || "Sin nombre",
        importe: venta.importe || 0,
        tipoPago: mapTipoPago(venta.tipoPago),
        facturacion: !!venta.facturacionMovil,
        timbrado: venta.folioFactura ? "1" : "0",
        folioFactura: !!venta.folioFactura,
        facturacionMovil: !!venta.facturacionMovil,
        sucursal: venta.sucursal,
        cve_cliente: venta.cveCliente,
        nombreProducto: venta.nombreProducto,
        cantProducto: venta.cantProducto,
        precio: venta.precio,
      }));
      console.log({ mapped });
      setItems(mapped);

      // Agrupar ventas por idMovil (locales) o por noVenta+sucursal (remotas)
      const groupedMap = new Map<string, GroupedSale>();

      filtered.forEach((venta) => {
        // Para ventas locales usar idMovil, para remotas usar noVenta+sucursal
        let groupKey: string;
        let displayId: number;

        if (soloLocales) {
          // Ventas locales: agrupar por idMovil
          displayId = venta.idMovil || venta.id;
          groupKey = `local_${displayId}`;
        } else {
          // Ventas remotas: agrupar por noVenta + sucursal
          const noVenta = venta.noVenta || venta.id;
          const sucursal = venta.sucursal || 0;
          displayId = noVenta;
          groupKey = `remote_${noVenta}_${sucursal}`;
        }

        if (!groupedMap.has(groupKey)) {
          groupedMap.set(groupKey, {
            idMovil: displayId,
            no_venta: venta.noVenta || displayId,
            fecha: venta.fecha ? new Date(venta.fecha).toISOString() : new Date().toISOString(),
            nombre: venta.nombreCliente || "Sin nombre",
            totalImporte: 0,
            tipoPago: mapTipoPago(venta.tipoPago),
            sucursal: venta.sucursal,
            cve_cliente: venta.cveCliente,
            caja: venta.caja,
            productos: [],
            folioFactura: venta.folioFactura,
            facturacionMovil: venta.facturacionMovil,
            timbrado: venta.timbrado,
          });
        }

        const group = groupedMap.get(groupKey)!;
        const productoImporte = venta.importe || 0;
        group.totalImporte += productoImporte;
        group.productos.push({
          nombreProducto: venta.nombreProducto || "Sin nombre",
          cantProducto: venta.cantProducto || 0,
          precio: venta.precio || 0,
          importe: productoImporte,
        });
      });

      const groupedArray = Array.from(groupedMap.values());
      console.log("[Reporte] Grouped results", {
        totalGroups: groupedArray.length,
        groups: groupedArray.map((g) => ({
          no_venta: g.no_venta,
          productos: g.productos.length,
          total: g.totalImporte,
        })),
      });

      setGroupedItems(groupedArray);
    } catch (error: any) {
      console.error("Error al filtrar ventas:", error);
      const errorMsg = error?.message || String(error) || "Error desconocido";
      const errorStack = error?.stack || "";
      setDebugInfo(`Error filtrado: ${errorMsg}\nStack: ${errorStack.substring(0, 200)}`);
      Alert.alert(
        "Error al consultar",
        `No se pudieron filtrar las ventas: ${errorMsg}\n\nVentas disponibles: ${
          allVentas?.length || 0
        }\nThreshold: ${LOCAL_SALE_ID_THRESHOLD}\n\nIntenta sincronizar de nuevo desde el menú principal.`,
      );
    } finally {
      setLoading(false);
    }
  };

  const consultar = () => filtrarVentas(false);

  const consultarLocal = () => filtrarVentas(true);

  const buildSaleTicketDataFromRow = (row: ReporteItem | GroupedSale): SaleTicketData => {
    // Si es GroupedSale, usar directamente los productos agrupados
    if ("productos" in row && "totalImporte" in row) {
      const groupedRow = row as GroupedSale;
      const date = new Date(groupedRow.fecha);
      const clientName = groupedRow.nombre;
      const paymentMethod = groupedRow.tipoPago;

      const items = groupedRow.productos.map((prod) => ({
        description: prod.nombreProducto,
        quantity: prod.cantProducto,
        price: prod.precio,
        total: prod.importe,
      }));

      const total = groupedRow.totalImporte;

      const saleTicketData: SaleTicketData = {
        clientName,
        date,
        paymentMethod,
        items,
        total,
      };

      return saleTicketData;
    }

    // Si es ReporteItem, buscar ventas relacionadas
    const reporteRow = row as ReporteItem;
    const relacionadas = allVentas.filter((venta: any) => {
      if (!venta) return false;
      if (venta.noVenta !== reporteRow.no_venta) return false;
      if (reporteRow.sucursal != null && reporteRow.sucursal !== undefined) {
        return venta.sucursal === reporteRow.sucursal;
      }
      return true;
    });

    const base = relacionadas[0] as any | undefined;

    const date = base?.fecha
      ? base.fecha instanceof Date
        ? base.fecha
        : new Date(base.fecha)
      : new Date(reporteRow.fecha);

    const clientName = base?.nombreCliente || reporteRow.nombre;
    const paymentMethod = reporteRow.tipoPago;

    const items =
      relacionadas.length > 0
        ? relacionadas.map((venta: any) => {
            const quantity = venta.cantProducto ?? 1;
            const price = venta.precio ?? 0;
            const total = venta.importe ?? quantity * price;
            return {
              description: String(venta.nombreProducto ?? "Producto"),
              quantity,
              price,
              total,
            };
          })
        : reporteRow.nombreProducto
        ? [
            {
              description: String(reporteRow.nombreProducto),
              quantity: reporteRow.cantProducto ?? 1,
              price: reporteRow.precio ?? reporteRow.importe,
              total: reporteRow.importe,
            },
          ]
        : [];

    const total = items.length > 0 ? items.reduce((sum, item) => sum + item.total, 0) : reporteRow.importe;

    const saleTicketData: SaleTicketData = {
      clientName,
      paymentMethod,
      items,
      total,
      date,
      ticketNumber: String(row.no_venta),
      businessName: undefined,
      businessAddress: undefined,
      taxId: undefined,
      sellerName: undefined,
      branch: row.sucursal,
    };

    return saleTicketData;
  };

  const visualizarTicket = (row: ReporteItem | GroupedSale) => {
    const ticketData = buildSaleTicketDataFromRow(row);
    const lines = TicketPrinter.generateSaleTicket(ticketData);
    setTicketContent(lines);
    setTicketVisible(true);
  };

  const imprimirTicket = async (row: ReporteItem | GroupedSale) => {
    const ticketData = buildSaleTicketDataFromRow(row);
    await TicketPrinter.printSaleTicket(ticketData);
  };

  const facturarVenta = async (row: ReporteItem | GroupedSale) => {
    try {
      // Determinar el importe correcto según el tipo
      const importe = "totalImporte" in row ? row.totalImporte : row.importe;

      // Si ya tiene folio/timbrado, reimprimir CFDI
      if (row.folioFactura || row.timbrado === "1") {
        if (!row.no_venta || !row.sucursal) {
          Alert.alert("Factura", "No hay información suficiente para reimprimir");
          return;
        }

        await FacturaService.getInstance().imprimirFacturaExistente(row.no_venta, row.sucursal, row.caja || 2, () =>
          loadVentas(),
        );
        return;
      }

      // Si está marcada para facturación móvil, generar factura
      if (row.facturacionMovil && row.cve_cliente && row.sucursal) {
        // Confirmación simple (modo de prueba no aplicado aquí de momento)
        const fechaVenta = new Date(row.fecha);
        const yyyy = fechaVenta.getFullYear();
        const mm = String(fechaVenta.getMonth() + 1).padStart(2, "0");
        const dd = String(fechaVenta.getDate()).padStart(2, "0");
        const fechaFactura = `${yyyy}-${mm}-${dd}`;

        const facturaItem: FacturaItem = {
          id: row.no_venta,
          idCliente: row.cve_cliente,
          idGrupo: 0,
          sucursal: row.sucursal,
          caja: row.caja || 1,
          noVenta: row.no_venta,
          formaPago: "03", // Transferencia electrónica
          metodoPago: "PUE", // Pago en una sola exhibición
          usoCFDI: "G03", // Gastos en general
        };

        await FacturaService.getInstance().generarFactura([facturaItem], fechaFactura, () => loadVentas());
        return;
      }

      Alert.alert("Factura", "Esta venta no permite factura");
    } catch (error: any) {
      Alert.alert("Error", error?.message || "Ocurrió un error al manejar la factura");
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>Consulta a Ventas</Text>
        <TouchableOpacity style={styles.refreshButton} onPress={loadVentas}>
          <Icon name="refresh" type="material" color="#fff" size={20} />
        </TouchableOpacity>
      </View>

      {allVentas.length > 0 && (
        <View style={styles.infoCard}>
          <Icon name="info" type="material" color={COLORS.primary} size={20} style={{ marginRight: 8 }} />
          <Text style={styles.infoText}>{allVentas.length} ventas sincronizadas en la base local</Text>
        </View>
      )}

      {allVentas.length === 0 && (
        <View style={styles.warningCard}>
          <Icon name="warning" type="material" color={COLORS.warning} size={24} />
          <Text style={styles.warningText}>
            No hay ventas sincronizadas. Inicia sesión nuevamente o sincroniza desde el menú principal.
          </Text>
        </View>
      )}

      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.col}>
            <Text style={styles.formLabel}>Fecha inicial</Text>
            <TouchableOpacity style={styles.dateInput} onPress={() => setShowPicker1(true)}>
              <Icon name="event" type="material" color={COLORS.primary} size={20} style={{ marginRight: 8 }} />
              <Text style={styles.dateText}>{formatDate(fecha1)}</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.col}>
            <Text style={styles.formLabel}>Fecha final</Text>
            <TouchableOpacity style={styles.dateInput} onPress={() => setShowPicker2(true)}>
              <Icon name="event" type="material" color={COLORS.primary} size={20} style={{ marginRight: 8 }} />
              <Text style={styles.dateText}>{formatDate(fecha2)}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {showPicker1 && (
          <>
            {Platform.OS === "ios" && (
              <View style={styles.iosPickerContainer}>
                <View style={styles.iosPickerHeader}>
                  <TouchableOpacity onPress={() => setShowPicker1(false)}>
                    <Text style={styles.iosPickerButton}>Listo</Text>
                  </TouchableOpacity>
                </View>
                <DateTimePicker
                  value={fecha1}
                  mode="date"
                  display="spinner"
                  onChange={onChangeFecha1}
                  maximumDate={new Date()}
                  style={styles.iosPicker}
                />
              </View>
            )}
            {Platform.OS === "android" && (
              <DateTimePicker
                value={fecha1}
                mode="date"
                display="default"
                onChange={onChangeFecha1}
                maximumDate={new Date()}
              />
            )}
          </>
        )}

        {showPicker2 && (
          <>
            {Platform.OS === "ios" && (
              <View style={styles.iosPickerContainer}>
                <View style={styles.iosPickerHeader}>
                  <TouchableOpacity onPress={() => setShowPicker2(false)}>
                    <Text style={styles.iosPickerButton}>Listo</Text>
                  </TouchableOpacity>
                </View>
                <DateTimePicker
                  value={fecha2}
                  mode="date"
                  display="spinner"
                  onChange={onChangeFecha2}
                  maximumDate={new Date()}
                  style={styles.iosPicker}
                />
              </View>
            )}
            {Platform.OS === "android" && (
              <DateTimePicker
                value={fecha2}
                mode="date"
                display="default"
                onChange={onChangeFecha2}
                maximumDate={new Date()}
              />
            )}
          </>
        )}
        <TouchableOpacity style={styles.secondaryBtn} onPress={consultar} disabled={loading}>
          <Text style={styles.secondaryBtnText}>{loading ? "Cargando..." : "Consultar"}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryBtn} onPress={consultarLocal} disabled={loading}>
          <Text style={styles.secondaryBtnText}>{loading ? "Cargando..." : "Consultar local"}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Resultados</Text>
        {groupedItems.length === 0 ? (
          <Text style={styles.muted}>Sin resultados</Text>
        ) : (
          <FlatList
            data={groupedItems}
            keyExtractor={(i) => String(i.no_venta) + "_" + String(i.idMovil)}
            scrollEnabled={false}
            renderItem={({ item }) => (
              <View style={styles.rowItem}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.invTitle}>
                    #{item.no_venta} • {item.nombre}
                  </Text>
                  <Text style={styles.muted}>
                    {new Date(item.fecha).toLocaleString("es-MX")} • {item.tipoPago}
                  </Text>
                  <Text style={styles.muted}>{item.productos.length} producto(s)</Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={styles.money}>${item.totalImporte.toFixed(2)}</Text>
                  <View style={styles.actionRow}>
                    <TouchableOpacity onPress={() => imprimirTicket(item)} style={styles.iconBtn}>
                      <Icon name="print" type="material" color={COLORS.primary} size={20} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => visualizarTicket(item)} style={styles.iconBtn}>
                      <Icon name="visibility" type="material" color={COLORS.info} size={20} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => console.log(item)}>
                      <Text>Caja {item?.caja}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => facturarVenta(item)}
                      disabled={!item.folioFactura && !item.facturacionMovil}
                      style={styles.iconBtn}
                    >
                      <Icon
                        name="receipt"
                        type="material"
                        color={!item.folioFactura && !item.facturacionMovil ? COLORS.muted : COLORS.success}
                        size={20}
                      />
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            )}
          />
        )}

        {items.length > 0 && (
          <View style={styles.totalsBox}>
            <View style={styles.rowBetween}>
              <Text style={styles.totalLabel}>Total</Text>
              <Text style={styles.moneySmall}>${total.toFixed(2)}</Text>
            </View>
            <View style={styles.rowBetween}>
              <Text style={styles.totalLabel}>Total Efectivo</Text>
              <Text style={styles.moneySmall}>${totalEfectivo.toFixed(2)}</Text>
            </View>
            <View style={styles.rowBetween}>
              <Text style={styles.totalLabel}>Total Créditos</Text>
              <Text style={styles.moneySmall}>${totalCredito.toFixed(2)}</Text>
            </View>
            <View style={styles.rowBetween}>
              <Text style={styles.totalLabel}>Total Transferencias</Text>
              <Text style={styles.moneySmall}>${totalTransferencia.toFixed(2)}</Text>
            </View>
            <View style={styles.rowBetween}>
              <Text style={styles.totalLabel}>Total Cupones</Text>
              <Text style={styles.moneySmall}>${totalCupones.toFixed(2)}</Text>
            </View>
          </View>
        )}
      </View>

      <Modal visible={ticketVisible} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.rowBetween}>
              <Text style={styles.modalTitle}>Visualización del Ticket</Text>
              <TouchableOpacity onPress={() => setTicketVisible(false)}>
                <Icon name="close" type="material" color={COLORS.primary} size={24} />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 400 }}>
              {ticketContent.map((line, idx) => (
                <Text key={idx} style={styles.mono}>
                  {line}
                </Text>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: SPACING.m, paddingBottom: SPACING.xxl },
  titleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: SPACING.m,
  },
  title: { ...TYPOGRAPHY.h2 },
  refreshButton: {
    backgroundColor: COLORS.primary,
    borderRadius: BORDER_RADIUS.m,
    padding: SPACING.s,
    ...SHADOWS.small,
  },
  infoCard: {
    backgroundColor: COLORS.primaryLight,
    borderRadius: BORDER_RADIUS.m,
    padding: SPACING.m,
    marginBottom: SPACING.m,
    borderLeftWidth: 4,
    borderLeftColor: COLORS.primary,
    flexDirection: "row",
    alignItems: "center",
  },
  infoText: {
    color: COLORS.primaryDark,
    fontSize: 14,
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
    fontSize: 14,
    fontWeight: "500",
  },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.l,
    padding: SPACING.m,
    marginBottom: SPACING.m,
    ...SHADOWS.small,
  },
  formLabel: { ...TYPOGRAPHY.h3, fontSize: 14, marginBottom: 4 },
  input: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: BORDER_RADIUS.m,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.m,
    marginTop: 4,
  },
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
    ...SHADOWS.small,
  },
  dateText: {
    fontSize: 14,
    fontWeight: "600",
    color: COLORS.primary,
  },
  iosPickerContainer: {
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.m,
    marginTop: SPACING.s,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  iosPickerHeader: {
    backgroundColor: COLORS.background,
    padding: SPACING.m,
    alignItems: "flex-end",
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  iosPickerButton: {
    color: COLORS.primary,
    fontSize: 16,
    fontWeight: "600",
  },
  iosPicker: {
    width: "100%",
    height: 200,
  },
  secondaryBtn: {
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.primary,
    paddingVertical: SPACING.m,
    borderRadius: BORDER_RADIUS.l,
    alignItems: "center",
    marginTop: SPACING.m,
  },
  secondaryBtnText: { color: COLORS.primary, fontWeight: "700", fontSize: 16 },
  cardTitle: {
    ...TYPOGRAPHY.h3,
    fontSize: 18,
    marginBottom: SPACING.m,
  },
  muted: { color: COLORS.muted, textAlign: "center", padding: SPACING.m },
  row: { flexDirection: "row", gap: SPACING.m },
  col: { flex: 1 },
  rowItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: SPACING.m,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  invTitle: { fontWeight: "600", color: COLORS.textPrimary, fontSize: 14 },
  money: {
    width: 100,
    textAlign: "right",
    fontWeight: "bold",
    color: COLORS.textPrimary,
    fontSize: 16,
  },
  actionRow: {
    flexDirection: "row",
    marginTop: 4,
    gap: 8,
  },
  iconBtn: {
    padding: 4,
  },
  totalsBox: {
    backgroundColor: COLORS.background,
    padding: SPACING.m,
    borderRadius: BORDER_RADIUS.m,
    marginTop: SPACING.m,
  },
  rowBetween: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  totalLabel: { color: COLORS.textSecondary, fontSize: 14 },
  moneySmall: { fontWeight: "600", color: COLORS.textPrimary, fontSize: 14 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    padding: SPACING.l,
  },
  modalCard: {
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.xl,
    padding: SPACING.l,
    ...SHADOWS.large,
  },
  modalTitle: { ...TYPOGRAPHY.h3, fontSize: 18 },
  mono: {
    fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
    fontSize: 12,
    lineHeight: 16,
    color: COLORS.textPrimary,
  },
});
