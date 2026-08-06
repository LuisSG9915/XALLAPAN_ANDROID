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
import { createEan13Barcode } from "../services/BluetoothPrinterService";
import FullSyncService from "../services/FullSyncService";
import FacturaService, { FacturaItem } from "../services/FacturaService";
import { COLORS, SPACING, SHADOWS, BORDER_RADIUS, TYPOGRAPHY } from "../theme/theme";
import AuthService from "../services/AuthService";
import VentaCancelacionService from "../services/VentaCancelacionService";
import VentaModificacionService from "../services/VentaModificacionService";

type ReporteItem = {
  id: number;
  idMovil?: number;
  no_venta: number;
  fecha: string;
  nombre: string;
  importe: number;
  tipoPago: string;
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
  tipoPago: string;
  sucursal?: number;
  cve_cliente?: number;
  caja?: number;
  folioFactura?: boolean;
  facturacionMovil?: boolean;
  timbrado?: "0" | "1";
  vendedor?: string;
  productos: Array<{
    nombreProducto: string;
    cantProducto: number;
    precio: number;
    importe: number;
    claveProd?: number;
  }>;
};
type TicketLine = string;

type Ean13PreviewProps = {
  value?: string;
};

const Ean13Preview = ({ value }: Ean13PreviewProps) => {
  const barcode = createEan13Barcode(value);
  if (!barcode) return null;

  return (
    <View style={styles.barcodePreview}>
      <View style={styles.barcodeBars}>
        {barcode.pattern.split("").map((module, index) => (
          <View
            key={`${index}-${module}`}
            style={[
              styles.barcodeModule,
              index < 3 || (index >= 45 && index < 50) || index >= 92 ? styles.barcodeGuard : undefined,
              module === "1" ? styles.barcodeBlack : styles.barcodeWhite,
            ]}
          />
        ))}
      </View>
      <Text style={styles.barcodeValue}>{barcode.encodedValue}</Text>
    </View>
  );
};

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
  const [formasPagoMap, setFormasPagoMap] = useState<Record<number, string>>({});

  const [ticketVisible, setTicketVisible] = useState(false);
  const [ticketContent, setTicketContent] = useState<TicketLine[]>([]);
  const [ticketBarcode, setTicketBarcode] = useState<string>();

  const [modModalVisible, setModModalVisible] = useState(false);
  const [modVentaSeleccionada, setModVentaSeleccionada] = useState<GroupedSale | null>(null);
  const [cantidadesEditadas, setCantidadesEditadas] = useState<Record<number, string>>({});
  const [existencias, setExistencias] = useState<Record<number, number>>({});
  const [cargandoExistencias, setCargandoExistencias] = useState(false);

  const esVentaDeHoy = (row: GroupedSale): boolean => {
    const hoy = new Date();
    const fechaVenta = new Date(row.fecha);
    return (
      fechaVenta.getFullYear() === hoy.getFullYear() &&
      fechaVenta.getMonth() === hoy.getMonth() &&
      fechaVenta.getDate() === hoy.getDate()
    );
  };

  const total = useMemo(() => items.reduce((s, i) => s + i.importe, 0), [items]);
  const totalesPorTipoPago = useMemo(() => {
    const map: Record<string, number> = {};
    items.forEach((i) => {
      const k = i.tipoPago || "Sin tipo";
      map[k] = (map[k] || 0) + i.importe;
    });
    const keys = Object.keys(map);
    const result: Array<[string, number]> = keys.map((k) => [k, map[k]]);
    result.sort((a, b) => b[1] - a[1]);
    return result;
  }, [items]);

  useEffect(() => {
    loadVentas();
  }, []);

  const loadVentas = async () => {
    try {
      await FullSyncService.initialize();
      const ventas = FullSyncService.getVentas(500);
      setAllVentas(ventas);

      // Cargar formas de pago de la tabla local
      const formasPago = FullSyncService.getFormasPago();
      const fpMap: Record<number, string> = {};
      formasPago.forEach((fp: any) => {
        fpMap[fp.tipo] = fp.descripcion || `Tipo ${fp.tipo}`;
      });
      setFormasPagoMap(fpMap);
      console.log("[ReporteVentas] Formas de pago cargadas:", fpMap);
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

  const getDescripcionPago = (venta: any): string => {
    // Usar descripcionMedioPago que ya viene en cada venta
    if (venta.descripcionMedioPago) return venta.descripcionMedioPago;
    // Fallback: lookup en FormaPago local
    if (venta.tipoPago !== undefined && venta.tipoPago !== null) {
      return formasPagoMap[venta.tipoPago] || `Tipo ${venta.tipoPago}`;
    }
    return "";
  };

  const filtrarVentas = (soloLocales: boolean) => {
    console.log("Filtrando ventas, soloLocales:", soloLocales);
    setLoading(true);
    setIsLocalView(soloLocales);
    try {
      // Cargar formas de pago directamente para evitar problemas de timing con React state
      const formasPago = FullSyncService.getFormasPago();
      const fpMapLocal: Record<number, string> = {};
      formasPago.forEach((fp: any) => {
        fpMapLocal[fp.tipo] = fp.descripcion || `Tipo ${fp.tipo}`;
      });
      setFormasPagoMap(fpMapLocal);
      console.log("[ReporteVentas] Formas de pago en filtrarVentas:", fpMapLocal);

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

      console.log("[Reporte] DEBUG - allVentas disponibles:", allVentas.length);
      console.log("[Reporte] DEBUG - Rango de fechas:", { fecha1Parsed, fecha2Parsed });
      console.log("[Reporte] DEBUG - sucursalUsuario:", sucursalUsuario);
      console.log("[Reporte] DEBUG - soloLocales:", soloLocales);

      // Categorizar ventas
      const ventasLocales = allVentas.filter((v: any) => v.noVenta == 0);
      const ventasServer = allVentas.filter((v: any) => v.noVenta > 0);
      const ventasServerConIdMovil = ventasServer.filter((v: any) => v.idMovil);
      const ventasServerSinIdMovil = ventasServer.filter((v: any) => !v.idMovil);

      console.log("[Reporte] 📊 CATEGORIZACIÓN DE VENTAS:", {
        totalVentas: allVentas.length,
        ventasLocales: ventasLocales.length,
        ventasServer: ventasServer.length,
        ventasServerConIdMovil: ventasServerConIdMovil.length,
        ventasServerSinIdMovil: ventasServerSinIdMovil.length,
      });

      // Desglose detallado por categoría
      console.log(
        "[Reporte] 📋 DESGLOSE VENTAS LOCALES:",
        ventasLocales.slice(0, 10).map((v: any) => ({
          id: v.id,
          noVenta: v.noVenta,
          nombreProducto: v.nombreProducto,
          cantProducto: v.cantProducto,
          importe: v.importe,
          fecha: v.fecha,
        })),
      );

      console.log(
        "[Reporte] 📋 DESGLOSE VENTAS SERVER CON idMovil:",
        ventasServerConIdMovil.slice(0, 10).map((v: any) => ({
          id: v.id,
          noVenta: v.noVenta,
          idMovil: v.idMovil,
          nombreProducto: v.nombreProducto,
          cantProducto: v.cantProducto,
          importe: v.importe,
          fecha: v.fecha,
        })),
      );

      console.log(
        "[Reporte] 📋 DESGLOSE VENTAS SERVER SIN idMovil:",
        ventasServerSinIdMovil.slice(0, 10).map((v: any) => ({
          id: v.id,
          noVenta: v.noVenta,
          nombreProducto: v.nombreProducto,
          cantProducto: v.cantProducto,
          importe: v.importe,
          fecha: v.fecha,
        })),
      );

      // Mostrar primeras 5 ventas para debug
      if (allVentas.length > 0) {
        console.log(
          "[Reporte] DEBUG - Primeras ventas:",
          allVentas.slice(0, 5).map((v: any) => ({
            id: v.id,
            noVenta: v.noVenta,
            idMovil: v.idMovil,
            claveProd: v.claveProd,
            fecha: v.fecha,
            sucursal: v.sucursal,
          })),
        );
      }

      const filtered = allVentas.filter((venta) => {
        if (!venta.fecha) {
          console.log("[Reporte] DEBUG - Venta sin fecha:", venta.id);
          return false;
        }
        const ventaDate = new Date(venta.fecha);
        // Filtrar por fecha siempre
        const inDateRange = ventaDate >= fecha1Parsed && ventaDate <= fecha2Parsed;

        // Filtrar por sucursal del usuario (si está definida)
        const inSucursal = sucursalUsuario === undefined || venta.sucursal === sucursalUsuario;

        if (soloLocales) {
          // Consultar Local: solo ventas con id >= threshold (ventas locales)
          const result = inDateRange && inSucursal && venta.noVenta == 0 && venta.claveProd !== 0;
          if (!result) {
            console.log("[Reporte] DEBUG - Venta local rechazada:", {
              id: venta.id,
              inDateRange,
              inSucursal,
              noVenta: venta.noVenta,
              claveProd: venta.claveProd,
            });
          }
          return result;
        } else {
          // Consultar: todas las ventas del servidor (noVenta > 0)
          // Pero excluir duplicados: si existe una venta con mismo noVenta+sucursal que tiene idMovil, excluir la que no tiene
          const result = inDateRange && inSucursal && venta.noVenta > 0 && venta.claveProd !== 0;

          // Verificar si hay duplicado: mismo noVenta pero una tiene idMovil y otra no
          if (result && !venta.idMovil) {
            const noVenta = venta.noVenta;
            const sucursal = venta.sucursal;
            const tieneVersionSincronizada = allVentas.some(
              (v: any) => v.noVenta === noVenta && v.sucursal === sucursal && v.idMovil && v.claveProd !== 0,
            );
            if (tieneVersionSincronizada) {
              console.log("[Reporte] 🔄 EXCLUIR DUPLICADO (pre-sync):", {
                id: venta.id,
                noVenta: venta.noVenta,
                idMovil: venta.idMovil,
              });
              return false;
            }
          }

          return result;
        }
      });
      console.log("[Reporte] Filtered results", { count: filtered });
      console.log(
        "[Reporte] 📋 VENTAS FILTRADAS DETALLE:",
        filtered.slice(0, 15).map((v: any) => ({
          id: v.id,
          noVenta: v.noVenta,
          idMovil: v.idMovil,
          nombreProducto: v.nombreProducto,
          cantProducto: v.cantProducto,
          importe: v.importe,
          fecha: v.fecha,
        })),
      );
      // consoleRealm("pagos", filtered);
      const mapped: ReporteItem[] = filtered.map((venta) => ({
        id: venta.id,
        idMovil: venta.idMovil,
        no_venta: venta.noVenta || 0,
        fecha: venta.fecha ? new Date(venta.fecha).toISOString() : new Date().toISOString(),
        nombre: venta.nombreCliente || "Sin nombre",
        importe: venta.importe || 0,
        tipoPago: getDescripcionPago(venta),
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

      // CONSOLE LOG DETALLADO DE VENTAS DE HOY
      const hoy = new Date();
      hoy.setHours(0, 0, 0, 0);
      const ventasHoy = filtered.filter((v: any) => {
        const fechaV = new Date(v.fecha);
        return fechaV >= hoy;
      });
      console.log("🔍 [REPORTE] VENTAS DE HOY - DETALLE COMPLETO:", {
        total: ventasHoy.length,
        ventas: ventasHoy.map((v: any) => ({
          id: v.id,
          noVenta: v.noVenta,
          idMovil: v.idMovil,
          nombreProducto: v.nombreProducto,
          cantProducto: v.cantProducto,
          importe: v.importe,
          nombreCliente: v.nombreCliente,
          fecha: v.fecha,
          sucursal: v.sucursal,
        })),
      });

      // Agrupar ventas por idMovil SIEMPRE (tanto locales como remotas)
      const groupedMap = new Map<string, GroupedSale>();

      console.log("[Reporte] 🔍 INICIANDO AGRUPAMIENTO - soloLocales:", soloLocales);

      filtered.forEach((venta, idx) => {
        // USAR SIEMPRE idMovil para agrupar y mostrar
        const idMovil = venta.idMovil || venta.id;
        const groupKey = `venta_${idMovil}_${venta.sucursal || 0}`;
        const displayId = idMovil;

        console.log(`[Reporte] 📌 Venta ${idx}:`, {
          id: venta.id,
          noVenta: venta.noVenta,
          idMovil: venta.idMovil,
          displayId,
          nombreProducto: venta.nombreProducto,
          groupKey,
          esNuevoGrupo: !groupedMap.has(groupKey),
        });

        if (!groupedMap.has(groupKey)) {
          console.log(`[Reporte] ✅ CREANDO NUEVO GRUPO: ${groupKey} con idMovil=${displayId}`);
          groupedMap.set(groupKey, {
            idMovil: displayId,
            no_venta: venta.noVenta || 0,
            fecha: venta.fecha ? new Date(venta.fecha).toISOString() : new Date().toISOString(),
            nombre: venta.nombreCliente || "Sin nombre",
            totalImporte: 0,
            tipoPago: getDescripcionPago(venta),
            sucursal: venta.sucursal,
            cve_cliente: venta.cveCliente,
            caja: venta.caja,
            productos: [],
            folioFactura: venta.folioFactura,
            facturacionMovil: venta.facturacionMovil,
            timbrado: venta.timbrado,
            vendedor: venta.vendedor || undefined,
          });
        } else {
          console.log(`[Reporte] 🔄 AGREGANDO A GRUPO EXISTENTE: ${groupKey}`);
        }

        const group = groupedMap.get(groupKey)!;
        const productoImporte = venta.importe || 0;
        group.totalImporte += productoImporte;
        if ((venta.cantProducto ?? 0) > 0) {
          group.productos.push({
            nombreProducto: venta.nombreProducto || "Sin nombre",
            cantProducto: venta.cantProducto || 0,
            precio: venta.precio || 0,
            importe: productoImporte,
            claveProd: venta.claveProd,
          });
        }
      });

      const groupedArray = Array.from(groupedMap.values());

      // Ordenar por fecha descendente (más reciente primero)
      groupedArray.sort((a, b) => {
        const dateA = new Date(a.fecha).getTime();
        const dateB = new Date(b.fecha).getTime();
        return dateB - dateA; // Descendente
      });

      console.log("[Reporte] ✅ AGRUPAMIENTO COMPLETADO", {
        totalGroups: groupedArray.length,
        groups: groupedArray.map((g) => ({
          idMovil: g.idMovil,
          no_venta: g.no_venta,
          nombre: g.nombre,
          productos: g.productos.length,
          total: g.totalImporte,
          productosDetalle: g.productos.map((p) => ({
            nombre: p.nombreProducto,
            cant: p.cantProducto,
            importe: p.importe,
          })),
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

  // Helper para obtener desglose de kits/combos para el ticket
  const getComboBreakdownForTicket = (
    claveProd: number,
    cantidad: number,
    importeTotal: number,
    cveCliente?: number,
  ): {
    isCombo: boolean;
    esInventariable?: boolean;
    comboBreakdown?: Array<{ description: string; quantity: number; price: number; total: number }>;
  } => {
    console.log("[getComboBreakdownForTicket] Input:", { claveProd, cantidad, importeTotal, cveCliente });

    // Buscar producto por id (claveProd es el id del producto, no clave_prod)
    const allProductos = FullSyncService.getProductos(10000);
    const producto = allProductos.find((p: any) => p.id === claveProd);

    console.log(
      "[getComboBreakdownForTicket] Producto encontrado:",
      producto?.id,
      producto?.descripcion,
      "esKit:",
      producto?.esKit,
      "inventariable:",
      producto?.inventariable,
    );

    if (!producto?.esKit) {
      console.log("[getComboBreakdownForTicket] No es kit, retornando isCombo=false");
      return { isCombo: false };
    }

    // Si es kit inventariable, NO mostrar desglose
    if (producto?.inventariable) {
      console.log("[getComboBreakdownForTicket] Es kit inventariable, retornando esInventariable=true");
      return { isCombo: false, esInventariable: true };
    }

    const kitsDelProducto = FullSyncService.getKitsByProducto(producto.id);
    console.log("[getComboBreakdownForTicket] Kits del producto:", kitsDelProducto.length);
    if (kitsDelProducto.length === 0) {
      console.log("[getComboBreakdownForTicket] No hay kits, retornando isCombo=false");
      return { isCombo: false };
    }

    // Obtener precios
    const cliente = cveCliente ? FullSyncService.getClienteFullById(cveCliente) : null;
    const listaPrecios = cliente?.listaPrecio ?? 0;
    const preciosPromo = FullSyncService.getPreciosPromoByCliente(cveCliente || 0);
    const preciosCliente = FullSyncService.getPreciosByListaPrecio(listaPrecios);
    const preciosDefault = FullSyncService.getPreciosByListaPrecio(13);

    // Mapa de precios indexado por claveProd (igual que SalesScreen).
    // Los registros de precio traen un campo id (del producto), pero las listas
    // se deben resolver por claveProd para que coincida con kit.idInsumo.
    const preciosPromoMap = new Map<number, number>();
    const preciosMap = new Map<number, number>();
    const preciosDefaultMap = new Map<number, number>();

    preciosPromo.forEach((p: any) => {
      const clave = p.claveProd !== undefined && p.claveProd !== null ? parseInt(p.claveProd, 10) : NaN;
      if (!Number.isNaN(clave)) preciosPromoMap.set(clave, p.precio || 0);
    });
    preciosCliente.forEach((p: any) => {
      const clave = p.claveProd !== undefined && p.claveProd !== null ? parseInt(p.claveProd, 10) : NaN;
      if (!Number.isNaN(clave)) preciosMap.set(clave, p.precio || 0);
    });
    preciosDefault.forEach((p: any) => {
      const clave = p.claveProd !== undefined && p.claveProd !== null ? parseInt(p.claveProd, 10) : NaN;
      if (!Number.isNaN(clave)) preciosDefaultMap.set(clave, p.precio || 0);
    });

    const productosPorId = new Map<number, any>();
    const productosPorClave = new Map<number, any>();
    allProductos.forEach((p: any) => {
      productosPorId.set(p.id, p);
      const clave = p?.claveProd !== undefined && p?.claveProd !== null ? parseInt(p.claveProd, 10) : NaN;
      if (!Number.isNaN(clave)) productosPorClave.set(clave, p);
    });

    const breakdown = kitsDelProducto.map((kit: any) => {
      // El campo kit.idInsumo es inconsistente (a veces id del producto, a veces clave_prod),
      // por lo que resolvemos el insumo y su precio por ambas llaves, igual que en SalesScreen.
      const insumoProducto = productosPorId.get(kit.idInsumo) ?? productosPorClave.get(kit.idInsumo);

      const clavesInsumo: number[] = [];
      const addClaveInsumo = (valor: any) => {
        const n = typeof valor === "number" ? valor : parseInt(valor ?? "", 10);
        if (!Number.isNaN(n) && !clavesInsumo.includes(n)) clavesInsumo.push(n);
      };
      addClaveInsumo(kit.idInsumo);
      addClaveInsumo(insumoProducto?.id);
      addClaveInsumo(insumoProducto?.claveProd);

      const buscarPrecioInsumo = (map?: Map<number, number>): number | undefined => {
        if (!map) return undefined;
        for (const key of clavesInsumo) {
          if (map.has(key)) return map.get(key);
        }
        return undefined;
      };

      let precioInsumo: number;
      // Si el insumo tiene precioCatalogo=true: buscar en listas
      // Si NO tiene precioCatalogo: usar precio fijo del catálogo de kits
      if (insumoProducto?.precioCatalogo === true) {
        const precioPromo = buscarPrecioInsumo(preciosPromoMap);
        const precioCliente = buscarPrecioInsumo(preciosMap);
        const precioDefault = buscarPrecioInsumo(preciosDefaultMap);
        if (precioPromo !== undefined) {
          precioInsumo = precioPromo;
        } else if (precioCliente !== undefined) {
          precioInsumo = precioCliente;
        } else if (precioDefault !== undefined) {
          precioInsumo = precioDefault;
        } else {
          precioInsumo = kit.precio || 0;
        }
      } else {
        // Usar precio fijo del catálogo de kits
        precioInsumo = kit.precio || 0;
      }

      const kitQty = (kit.cantidad || 1) * cantidad;

      return {
        description: insumoProducto?.descripcion || `Insumo ${kit.idInsumo}`,
        quantity: kitQty,
        price: precioInsumo,
        total: precioInsumo * kitQty,
      };
    });

    return { isCombo: true, esInventariable: false, comboBreakdown: breakdown };
  };

  const buildSaleTicketDataFromRow = (row: ReporteItem | GroupedSale): SaleTicketData => {
    // Si es GroupedSale, usar directamente los productos agrupados
    if ("productos" in row && "totalImporte" in row) {
      const groupedRow = row as GroupedSale;
      const date = new Date(groupedRow.fecha);
      const clientName = groupedRow.nombre;
      const paymentMethod = groupedRow.tipoPago;

      const items = groupedRow.productos.map((prod) => {
        const comboInfo = getComboBreakdownForTicket(
          prod.claveProd || 0,
          prod.cantProducto,
          prod.importe,
          groupedRow.cve_cliente,
        );
        const item = {
          description: prod.nombreProducto,
          quantity: prod.cantProducto,
          price: prod.precio,
          total: prod.importe,
          isCombo: comboInfo.isCombo,
          esInventariable: comboInfo.esInventariable,
          comboBreakdown: comboInfo.comboBreakdown,
        };
        console.log("[buildSaleTicketDataFromRow] Item procesado:", item);
        return item;
      });

      const total = groupedRow.totalImporte;

      // Determinar si la forma de pago tiene pago0 activo
      const formasPagoAll = FullSyncService.getFormasPago();
      const ventaBase = allVentas.find((v: any) => (v.idMovil || v.id) === groupedRow.idMovil);
      const tipoPagoCode = ventaBase?.tipoPago;
      const formaPagoSel = formasPagoAll.find((fp: any) => fp.tipo === tipoPagoCode);
      const esPago0 = Boolean(formaPagoSel?.pago0);

      const currentUser = AuthService.currentUser;

      // Obtener datos del usuario desde Realm (tabla Usuario) para el ticket
      // ticketFinal y permisoDomicilioTicket vienen de Usuario
      let usuarioTicketData: {
        ticketFinal?: string;
        permisoDomicilioTicket?: boolean;
      } = {};
      try {
        if (currentUser?.id) {
          const realmUser = FullSyncService.getUsuarioById(currentUser.id);
          if (realmUser) {
            usuarioTicketData = {
              ticketFinal: realmUser.ticketFinal,
              permisoDomicilioTicket: realmUser.permisoDomicilioTicket,
            };
            console.log("[ReporteVentas] Datos de usuario para ticket:", usuarioTicketData);
          }
        }
      } catch (e) {
        console.error("[ReporteVentas] Error al obtener datos de usuario de Realm:", e);
      }

      // Obtener datos de la empresa desde la tabla Cia usando idEmpresa del cliente
      let empresaTicketData: {
        nombreCia?: string;
        rfc?: string;
        domicilio?: string;
        regimenFiscal?: string;
        telefono?: string;
      } = {};
      try {
        if (groupedRow.cve_cliente) {
          const clienteRealm = FullSyncService.getClienteFullById(groupedRow.cve_cliente);
          if (clienteRealm?.idEmpresa) {
            const ciaRealm = FullSyncService.getCiaById(clienteRealm.idEmpresa);
            if (ciaRealm) {
              empresaTicketData = {
                nombreCia: ciaRealm.nombreCia,
                rfc: ciaRealm.rfc,
                domicilio: ciaRealm.domicilio,
                regimenFiscal: ciaRealm.regimenFiscal,
                telefono: ciaRealm.telefono,
              };
              console.log("[ReporteVentas] Datos de empresa obtenidos de Cia:", empresaTicketData);
            }
          }
        }
      } catch (e) {
        console.error("[ReporteVentas] Error al obtener datos de empresa de Realm:", e);
      }

      // Obtener domicilio del cliente si el permiso está activo
      let clientDomicilio: string | undefined;
      const permisoValue = usuarioTicketData.permisoDomicilioTicket as any;
      const tienePermiso = permisoValue === true || permisoValue === 1 || permisoValue === "1";
      console.log(
        "[ReporteVentas] Permiso domicilio ticket raw:",
        usuarioTicketData.permisoDomicilioTicket,
        "evaluado:",
        tienePermiso,
      );
      if (tienePermiso && groupedRow.cve_cliente) {
        const clienteRealm = FullSyncService.getClienteFullById(groupedRow.cve_cliente);
        clientDomicilio = clienteRealm?.domicilio || undefined;
        console.log("[ReporteVentas] Domicilio del cliente para ticket:", clientDomicilio);
      }

      const saleTicketData: SaleTicketData = {
        clientName,
        clientDomicilio,
        date,
        paymentMethod,
        items,
        total,
        ticketNumber: String(groupedRow.idMovil || groupedRow.no_venta),
        sellerName: groupedRow.vendedor || currentUser?.claveEmpleado || undefined,
        branch: currentUser?.dSucursal || groupedRow.sucursal,
        businessName: empresaTicketData.nombreCia,
        taxId: empresaTicketData.rfc,
        domicilio: empresaTicketData.domicilio,
        regimenFiscal: empresaTicketData.regimenFiscal,
        phone: empresaTicketData.telefono,
        ticketFinal: usuarioTicketData.ticketFinal,
        pago0: esPago0,
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

    // Determinar si la forma de pago tiene pago0 activo
    const formasPagoAll2 = FullSyncService.getFormasPago();
    const tipoPagoCode2 = base?.tipoPago;
    const formaPagoSel2 = formasPagoAll2.find((fp: any) => fp.tipo === tipoPagoCode2);
    const esPago02 = Boolean(formaPagoSel2?.pago0);

    const items =
      relacionadas.length > 0
        ? relacionadas.map((venta: any) => {
            const quantity = venta.cantProducto ?? 1;
            const price = venta.precio ?? 0;
            const total = venta.importe ?? quantity * price;
            const comboInfo = getComboBreakdownForTicket(venta.claveProd || 0, quantity, total, venta.cveCliente);
            return {
              description: String(venta.nombreProducto ?? "Producto"),
              quantity,
              price,
              total,
              isCombo: comboInfo.isCombo,
              esInventariable: comboInfo.esInventariable,
              comboBreakdown: comboInfo.comboBreakdown,
            };
          })
        : reporteRow.nombreProducto
        ? [
            (() => {
              const comboInfo = getComboBreakdownForTicket(
                reporteRow.id,
                reporteRow.cantProducto ?? 1,
                reporteRow.importe,
                reporteRow.cve_cliente,
              );
              return {
                description: String(reporteRow.nombreProducto),
                quantity: reporteRow.cantProducto ?? 1,
                price: reporteRow.precio ?? reporteRow.importe,
                total: reporteRow.importe,
                isCombo: comboInfo.isCombo,
                esInventariable: comboInfo.esInventariable,
                comboBreakdown: comboInfo.comboBreakdown,
              };
            })(),
          ]
        : [];

    const total = items.length > 0 ? items.reduce((sum, item) => sum + item.total, 0) : reporteRow.importe;

    const currentUser = AuthService.currentUser;
    const vendedorFromVenta = base?.vendedor || undefined;

    // Obtener datos del usuario desde Realm (tabla Usuario) para el ticket
    let usuarioTicketData: {
      nombreCia?: string;
      rfc?: string;
      domicilio?: string;
      regimenFiscal?: string;
      telefono?: string;
      ticketFinal?: string;
      permisoDomicilioTicket?: boolean;
    } = {};
    try {
      if (currentUser?.id) {
        const realmUser = FullSyncService.getUsuarioById(currentUser.id);
        if (realmUser) {
          usuarioTicketData = {
            nombreCia: realmUser.nombreCia,
            rfc: realmUser.rfc,
            domicilio: realmUser.domicilio,
            regimenFiscal: realmUser.regimenFiscal,
            telefono: realmUser.telefono,
            ticketFinal: realmUser.ticketFinal,
            permisoDomicilioTicket: realmUser.permisoDomicilioTicket,
          };
          console.log("[ReporteVentas] Datos de ticket obtenidos de Realm (ReporteItem):", usuarioTicketData);
        }
      }
    } catch (e) {
      console.error("[ReporteVentas] Error al obtener datos de usuario de Realm:", e);
    }

    // Obtener domicilio del cliente si el permiso está activo
    let clientDomicilio: string | undefined;
    const permisoValue = usuarioTicketData.permisoDomicilioTicket as any;
    const tienePermiso = permisoValue === true || permisoValue === 1 || permisoValue === "1";
    console.log(
      "[ReporteVentas] Permiso domicilio ticket raw (ReporteItem):",
      usuarioTicketData.permisoDomicilioTicket,
      "evaluado:",
      tienePermiso,
    );
    if (tienePermiso && row.cve_cliente) {
      const clienteRealm = FullSyncService.getClienteFullById(row.cve_cliente);
      clientDomicilio = clienteRealm?.domicilio || undefined;
      console.log("[ReporteVentas] Domicilio del cliente para ticket (ReporteItem):", clientDomicilio);
    }

    const saleTicketData: SaleTicketData = {
      clientName,
      clientDomicilio,
      paymentMethod,
      items,
      total,
      date,
      ticketNumber: String(row.idMovil || row.no_venta),
      sellerName: vendedorFromVenta || currentUser?.claveEmpleado || undefined,
      branch: currentUser?.dSucursal || row.sucursal,
      businessName: usuarioTicketData.nombreCia,
      taxId: usuarioTicketData.rfc,
      domicilio: usuarioTicketData.domicilio,
      regimenFiscal: usuarioTicketData.regimenFiscal,
      phone: usuarioTicketData.telefono,
      ticketFinal: usuarioTicketData.ticketFinal,
      pago0: esPago02,
    };

    return saleTicketData;
  };

  const visualizarTicket = (row: ReporteItem | GroupedSale) => {
    const ticketData = buildSaleTicketDataFromRow(row);
    console.log("[visualizarTicket] Ticket data completo:", ticketData);
    console.log(
      "[visualizarTicket] Items con comboBreakdown:",
      ticketData.items.filter((i: any) => i.isCombo && i.comboBreakdown),
    );
    const lines = TicketPrinter.generateSaleTicket(ticketData);
    setTicketContent(lines);
    setTicketBarcode(ticketData.ticketNumber);
    setTicketVisible(true);
  };

  const imprimirTicket = async (row: ReporteItem | GroupedSale) => {
    const ticketData = buildSaleTicketDataFromRow(row);
    console.log("[imprimirTicket] Ticket data completo:", ticketData);
    console.log(
      "[imprimirTicket] Items con comboBreakdown:",
      ticketData.items.filter((i: any) => i.isCombo && i.comboBreakdown),
    );
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

  const abrirModificarVenta = async (row: GroupedSale) => {
    if (!row.no_venta || row.no_venta === 0) {
      Alert.alert("Error", "Solo se pueden modificar ventas sincronizadas con el servidor");
      return;
    }
    const initialCants: Record<number, string> = {};
    row.productos.forEach((p) => {
      if (p.claveProd != null) {
        initialCants[p.claveProd] = String(p.cantProducto);
      }
    });
    setCantidadesEditadas(initialCants);
    setModVentaSeleccionada(row);
    setModModalVisible(true);

    // Cargar existencias de los productos
    setCargandoExistencias(true);
    try {
      const currentUser = AuthService.currentUser;
      const sucursal = currentUser?.sucursal_origen || row.sucursal || 1;
      const existenciasMap: Record<number, number> = {};

      for (const prod of row.productos) {
        if (prod.claveProd != null) {
          try {
            const inventario = FullSyncService.getInventarioByClaveProdSucursal(prod.claveProd, sucursal);
            existenciasMap[prod.claveProd] = inventario?.saldo ?? 0;
          } catch (e) {
            console.error(`[ReporteVentas] Error al obtener inventario para claveProd ${prod.claveProd}:`, e);
            existenciasMap[prod.claveProd] = 0;
          }
        }
      }

      setExistencias(existenciasMap);
      console.log("[ReporteVentas] Existencias cargadas:", existenciasMap);
    } catch (error) {
      console.error("[ReporteVentas] Error al cargar existencias:", error);
    } finally {
      setCargandoExistencias(false);
    }
  };

  const guardarTodosLosCambios = async () => {
    if (!modVentaSeleccionada) return;

    // Validar que no haya cantidades inválidas
    const cambios: Array<{ clave: number; cantNueva: number; nombre: string }> = [];
    const errores: string[] = [];

    for (const prod of modVentaSeleccionada.productos) {
      const clave = prod.claveProd ?? 0;
      const cantEdit = cantidadesEditadas[clave] ?? "";
      const cantNum = parseInt(cantEdit, 10);
      const existencia = existencias[clave] ?? 0;

      if (cantEdit.trim() === "") continue;
      if (isNaN(cantNum)) continue;
      if (cantNum === prod.cantProducto) continue;
      if (cantNum < 0) {
        errores.push(`${prod.nombreProducto}: Cantidad no válida`);
        continue;
      }
      if (cantNum > existencia) {
        errores.push(`${prod.nombreProducto}: No hay suficiente existencia (max: ${existencia})`);
        continue;
      }

      cambios.push({ clave, cantNueva: cantNum, nombre: prod.nombreProducto });
    }

    if (errores.length > 0) {
      Alert.alert("Errores encontrados", errores.join("\n"));
      return;
    }

    if (cambios.length === 0) {
      Alert.alert("Sin cambios", "No hay modificaciones para guardar");
      return;
    }

    // Mostrar resumen de cambios
    const resumen = cambios.map((c) => `• ${c.nombre}: ${c.cantNueva} ud`).join("\n");

    Alert.alert(
      "Confirmar todos los cambios",
      `¿Guardar las siguientes modificaciones en la venta #${modVentaSeleccionada.no_venta}?\n\n${resumen}`,
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Sí, Guardar Todo",
          style: "destructive",
          onPress: async () => {
            try {
              for (const cambio of cambios) {
                await VentaModificacionService.getInstance().quitarProducto({
                  noVenta: modVentaSeleccionada.no_venta,
                  sucursal: modVentaSeleccionada.sucursal || 1,
                  caja: modVentaSeleccionada.caja,
                  idMovil: modVentaSeleccionada.idMovil,
                  claveProd: cambio.clave,
                  nombreProducto: cambio.nombre,
                  cantidadNueva: cambio.cantNueva,
                  motivoModificacion: `Cambio de cantidad a ${cambio.cantNueva} desde consulta de ventas (guardado múltiple)`,
                });
              }

              setModModalVisible(false);
              Alert.alert(
                "Éxito",
                `${cambios.length} renglones actualizados. Se actualizará el servidor en la próxima sincronización.`,
                [
                  {
                    text: "OK",
                    onPress: () => {
                      loadVentas();
                      if (isLocalView) {
                        consultarLocal();
                      } else {
                        consultar();
                      }
                    },
                  },
                ],
              );
            } catch (error: any) {
              Alert.alert("Error", error?.message || "No se pudieron guardar los cambios");
            }
          },
        },
      ],
    );
  };

  const modificarRenglon = async (
    row: GroupedSale,
    claveProd: number,
    nombreProducto: string,
    cantidadNueva: number,
  ) => {
    try {
      // Ya NO cerramos el modal - el usuario quiere seguir editando
      const esEliminar = cantidadNueva === 0;
      Alert.alert(
        esEliminar ? "Confirmar eliminación de renglón" : "Confirmar cambio de cantidad",
        esEliminar
          ? `¿Quitar "${nombreProducto}" de la venta #${row.no_venta}?\n\nEl renglón quedará en cantidad 0 y se ajustará el inventario.`
          : `¿Cambiar cantidad de "${nombreProducto}" a ${cantidadNueva} en la venta #${row.no_venta}?\n\nSe ajustará el inventario por la diferencia.`,
        [
          { text: "No", style: "cancel" },
          {
            text: "Sí, Guardar",
            style: "destructive",
            onPress: async () => {
              try {
                await VentaModificacionService.getInstance().quitarProducto({
                  noVenta: row.no_venta,
                  sucursal: row.sucursal || 1,
                  caja: row.caja,
                  idMovil: row.idMovil,
                  claveProd,
                  nombreProducto,
                  cantidadNueva,
                  motivoModificacion: esEliminar
                    ? "Eliminación de renglón desde consulta de ventas"
                    : `Cambio de cantidad a ${cantidadNueva} desde consulta de ventas`,
                });

                // Limpiar el input del producto modificado (o marcar como 0 si es eliminación)
                setCantidadesEditadas((prev) => ({ ...prev, [claveProd]: esEliminar ? "0" : "" }));

                // Refrescar las ventas pero mantener el modal abierto
                loadVentas();
              } catch (error: any) {
                Alert.alert("Error", error?.message || "No se pudo modificar el renglón");
              }
            },
          },
        ],
      );
    } catch (error: any) {
      Alert.alert("Error", error?.message || "Ocurrió un error al modificar la venta");
    }
  };

  const cancelarVenta = async (row: GroupedSale) => {
    try {
      if (!row.no_venta || row.no_venta === 0) {
        Alert.alert("Error", "Solo se pueden cancelar ventas sincronizadas con el servidor");
        return;
      }

      Alert.alert(
        "Confirmar Cancelación",
        `¿Estás seguro de cancelar la venta #${row.no_venta}?\n\nCliente: ${
          row.nombre
        }\nImporte: $${row.totalImporte.toFixed(2)}\n\nEsta acción actualizará el inventario.`,
        [
          {
            text: "No",
            style: "cancel",
          },
          {
            text: "Sí, Cancelar",
            style: "destructive",
            onPress: async () => {
              try {
                await VentaCancelacionService.getInstance().cancelarVenta({
                  noVenta: row.no_venta,
                  sucursal: row.sucursal || 1,
                  caja: row.caja,
                  idMovil: row.idMovil,
                  motivoCancelacion: "Cancelación solicitada desde consulta de ventas",
                });

                Alert.alert(
                  "Éxito",
                  "Venta cancelada localmente. Se enviará al servidor en la próxima sincronización.",
                  [
                    {
                      text: "OK",
                      onPress: () => {
                        loadVentas();
                        if (isLocalView) {
                          consultarLocal();
                        } else {
                          consultar();
                        }
                      },
                    },
                  ],
                );
              } catch (error: any) {
                Alert.alert("Error", error?.message || "No se pudo cancelar la venta");
              }
            },
          },
        ],
      );
    } catch (error: any) {
      Alert.alert("Error", error?.message || "Ocurrió un error al intentar cancelar");
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
            keyExtractor={(i) => String(i.idMovil || i.no_venta)}
            scrollEnabled={false}
            renderItem={({ item }) => {
              // Obtener usuario actual y verificar permiso de domicilio
              const currentUser = AuthService.currentUser;
              const userRealm = currentUser?.id ? FullSyncService.getUsuarioById(currentUser.id) : null;
              const permisoRaw = userRealm?.permisoDomicilioTicket as any;
              const tienePermisoDomicilio = permisoRaw === true || permisoRaw === 1 || permisoRaw === "1";

              // Obtener cliente y su domicilio si tiene permiso
              let domicilioCliente = null;
              if (tienePermisoDomicilio && item.cve_cliente) {
                const clienteRealm = FullSyncService.getClienteFullById(item.cve_cliente);
                domicilioCliente = clienteRealm?.domicilio;
              }

              return (
                <View style={styles.rowItem}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.invTitle}>
                      #{item.idMovil || item.no_venta} • {item.nombre}
                    </Text>
                    {domicilioCliente && (
                      <Text style={[styles.muted, { fontSize: 11, fontStyle: "italic" }]}>{domicilioCliente}</Text>
                    )}
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
                      {!isLocalView && (
                        <>
                          <TouchableOpacity
                            onPress={() => abrirModificarVenta(item)}
                            disabled={
                              !item.no_venta ||
                              item.no_venta === 0 ||
                              item.totalImporte === 0 ||
                              item.productos.length === 0 ||
                              !esVentaDeHoy(item)
                            }
                            style={styles.iconBtn}
                          >
                            <Icon
                              name="edit"
                              type="material"
                              color={
                                !item.no_venta ||
                                item.no_venta === 0 ||
                                item.totalImporte === 0 ||
                                item.productos.length === 0 ||
                                !esVentaDeHoy(item)
                                  ? COLORS.muted
                                  : COLORS.warning
                              }
                              size={20}
                            />
                          </TouchableOpacity>
                          <TouchableOpacity
                            onPress={() => cancelarVenta(item)}
                            disabled={!item.no_venta || item.no_venta === 0 || item.totalImporte === 0}
                            style={styles.iconBtn}
                          >
                            <Icon
                              name="cancel"
                              type="material"
                              color={
                                !item.no_venta || item.no_venta === 0 || item.totalImporte === 0
                                  ? COLORS.muted
                                  : COLORS.error
                              }
                              size={20}
                            />
                          </TouchableOpacity>
                        </>
                      )}
                    </View>
                  </View>
                </View>
              );
            }}
          />
        )}

        {items.length > 0 && (
          <View style={styles.totalsBox}>
            <View style={styles.rowBetween}>
              <Text style={styles.totalLabel}>Total</Text>
              <Text style={styles.moneySmall}>${total.toFixed(2)}</Text>
            </View>
            {totalesPorTipoPago.map(([tipoPago, totalTipo]) => (
              <React.Fragment key={tipoPago}>
                <View style={styles.rowBetween}>
                  <Text style={styles.totalLabel}>Total {tipoPago}</Text>
                  <Text style={styles.moneySmall}>${totalTipo.toFixed(2)}</Text>
                </View>
              </React.Fragment>
            ))}
          </View>
        )}
      </View>

      <Modal visible={modModalVisible} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.rowBetween}>
              <Text style={styles.modalTitle}>Modificar Venta #{modVentaSeleccionada?.no_venta}</Text>
              <TouchableOpacity onPress={() => setModModalVisible(false)}>
                <Icon name="close" type="material" color={COLORS.primary} size={24} />
              </TouchableOpacity>
            </View>
            <Text style={styles.modSubtitle}>Edita la cantidad o elimina el renglón:</Text>
            {cargandoExistencias && (
              <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
                <Icon name="sync" type="material" color={COLORS.primary} size={16} style={{ marginRight: 8 }} />
                <Text style={{ color: COLORS.textSecondary, fontSize: 12 }}>Cargando existencias...</Text>
              </View>
            )}
            <ScrollView style={{ maxHeight: 400 }}>
              {modVentaSeleccionada?.productos.length === 0 ? (
                <Text style={[styles.muted, { textAlign: "center", marginTop: 12 }]}>
                  No hay productos activos en esta venta.
                </Text>
              ) : (
                modVentaSeleccionada?.productos
                  .filter((prod) => {
                    const clave = prod.claveProd ?? 0;
                    const cantEdit = cantidadesEditadas[clave] ?? "";
                    const cantNum = parseInt(cantEdit, 10);
                    // No mostrar productos que ya fueron marcados para eliminar (cantidad 0)
                    return !(cantEdit.trim() !== "" && !isNaN(cantNum) && cantNum === 0);
                  })
                  .map((prod, idx) => {
                    const clave = prod.claveProd ?? 0;
                    const cantEdit = cantidadesEditadas[clave] ?? "";
                    const cantNum = parseInt(cantEdit, 10);
                    const existencia = existencias[clave] ?? 0;
                    const cantValidaBase =
                      cantEdit.trim() !== "" && !isNaN(cantNum) && cantNum >= 0 && cantNum !== prod.cantProducto;
                    const excedeExistencia = cantNum > existencia;
                    const cantValida = cantValidaBase && !excedeExistencia;
                    const inputConError =
                      cantEdit.trim() !== "" &&
                      (!isNaN(cantNum) ? cantNum === prod.cantProducto || excedeExistencia : true);
                    return (
                      <View key={idx} style={styles.modProductoRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.modProductoNombre}>{prod.nombreProducto}</Text>
                          <Text style={styles.modProductoDetalle}>
                            Actual: {prod.cantProducto} ud • ${prod.precio.toFixed(2)} c/u
                          </Text>
                          <Text
                            style={[
                              styles.modProductoDetalle,
                              { color: existencia > 0 ? COLORS.success : COLORS.error },
                            ]}
                          >
                            Existencia: {existencia} ud
                          </Text>
                          <View style={styles.modCantRow}>
                            <TextInput
                              style={[styles.modCantInput, inputConError && styles.modCantInputError]}
                              keyboardType="numeric"
                              placeholder={String(prod.cantProducto)}
                              placeholderTextColor={COLORS.muted}
                              value={cantEdit}
                              onChangeText={(txt) => {
                                // Validar que solo sean números
                                if (!/^\d*$/.test(txt)) return;
                                setCantidadesEditadas((prev) => ({ ...prev, [clave]: txt }));
                              }}
                              maxLength={4}
                            />
                            {/* <TouchableOpacity
                            style={[
                              styles.modGuardarBtn,
                              cantValida ? styles.modGuardarBtnActive : styles.modBtnDisabled,
                            ]}
                            disabled={!cantValida}
                            onPress={() => modificarRenglon(modVentaSeleccionada!, clave, prod.nombreProducto, cantNum)}
                          >
                            <Icon
                              name="check-circle"
                              type="material"
                              color={cantValida ? "#fff" : COLORS.muted}
                              size={26}
                            />
                          </TouchableOpacity> */}
                            <TouchableOpacity
                              style={styles.modEliminarBtn}
                              onPress={() => {
                                // NO ocultar inmediatamente - esperar confirmación en modificarRenglon
                                modificarRenglon(modVentaSeleccionada!, clave, prod.nombreProducto, 0);
                              }}
                            >
                              <Icon name="remove-circle" type="material" color={COLORS.error} size={26} />
                            </TouchableOpacity>
                          </View>
                          {inputConError && cantEdit.trim() !== "" && (
                            <Text style={styles.modCantHint}>
                              {isNaN(cantNum)
                                ? "Ingresa un número válido"
                                : excedeExistencia
                                ? `No puedes vender más de ${existencia} unidades`
                                : "La cantidad debe ser diferente a la actual"}
                            </Text>
                          )}
                        </View>
                      </View>
                    );
                  })
              )}
            </ScrollView>

            {/* Botón OK para guardar todos los cambios */}
            <View
              style={{ marginTop: SPACING.m, borderTopWidth: 1, borderTopColor: COLORS.border, paddingTop: SPACING.m }}
            >
              <TouchableOpacity
                style={styles.guardarTodoBtn}
                onPress={guardarTodosLosCambios}
                disabled={cargandoExistencias || modVentaSeleccionada?.productos.length === 0}
              >
                <Icon name="check-circle" type="material" color="#fff" size={20} style={{ marginRight: 8 }} />
                <Text style={styles.guardarTodoBtnText}>OK - Guardar Todos los Cambios</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

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
            <Ean13Preview value={ticketBarcode} />
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
  barcodePreview: {
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    marginTop: SPACING.m,
    paddingTop: SPACING.m,
  },
  barcodeBars: {
    flexDirection: "row",
    alignItems: "flex-start",
    height: 72,
    paddingHorizontal: 18,
    backgroundColor: "#fff",
  },
  barcodeModule: {
    width: 2,
    height: 64,
  },
  barcodeGuard: {
    height: 72,
  },
  barcodeBlack: {
    backgroundColor: "#000",
  },
  barcodeWhite: {
    backgroundColor: "#fff",
  },
  barcodeValue: {
    color: COLORS.textPrimary,
    fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
    fontSize: 12,
    letterSpacing: 1,
    marginTop: 4,
  },
  modSubtitle: {
    color: COLORS.textSecondary,
    fontSize: 13,
    marginTop: 6,
    marginBottom: 12,
  },
  modProductoRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: SPACING.m,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  modProductoNombre: {
    fontWeight: "600",
    color: COLORS.textPrimary,
    fontSize: 14,
  },
  modProductoDetalle: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  modProductoAccion: {
    paddingLeft: SPACING.s,
  },
  modCantRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: SPACING.s,
    gap: 8,
  },
  modCantLabel: {
    color: COLORS.textSecondary,
    fontSize: 13,
    minWidth: 80,
  },
  modCantInput: {
    borderWidth: 1,
    borderColor: COLORS.primary,
    borderRadius: BORDER_RADIUS.m,
    paddingHorizontal: SPACING.s,
    paddingVertical: 4,
    fontSize: 15,
    fontWeight: "600",
    color: COLORS.textPrimary,
    width: 64,
    textAlign: "center",
  },
  modGuardarBtn: {
    padding: 4,
    borderRadius: BORDER_RADIUS.m,
    borderWidth: 1,
    borderColor: COLORS.muted,
  },
  modGuardarBtnActive: {
    borderColor: COLORS.success,
    backgroundColor: COLORS.success,
  },
  modBtnDisabled: {
    borderColor: COLORS.muted,
    backgroundColor: "transparent",
  },
  modCantInputError: {
    borderColor: COLORS.error,
  },
  modCantHint: {
    color: COLORS.error,
    fontSize: 11,
    marginTop: 2,
  },
  modEliminarBtn: {
    padding: 4,
  },
  guardarTodoBtn: {
    flexDirection: "row",
    backgroundColor: COLORS.success,
    paddingVertical: SPACING.m,
    paddingHorizontal: SPACING.l,
    borderRadius: BORDER_RADIUS.l,
    alignItems: "center",
    justifyContent: "center",
  },
  guardarTodoBtnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 16,
  },
});
