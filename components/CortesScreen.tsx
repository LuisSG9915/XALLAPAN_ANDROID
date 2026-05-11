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
  envVendidoEco: number;
  envCambiado: number;
  envCambiadoEco: number;
  envPrestado: number;
  envPrestadoEco: number;
  cambiadosPorProducto: Array<{ descripcionCorta: string; claveProd: number; cantidadEntrada: number }>;
  intercambioPorProducto: Array<{ descripcion: string; claveProd: number; cantidad: number }>;
  prestamoPorProducto: Array<{ descripcion: string; claveProd: number; cantidad: number }>;
  vendidosPorProducto: Array<{ descripcion: string; claveProd: number; cantidad: number }>;
  recuperadosPorProducto: Array<{ descripcion: string; claveProd: number; cantidad: number }>;
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
    envVendidoEco: 0,
    envCambiado: 0,
    envCambiadoEco: 0,
    envPrestado: 0,
    envPrestadoEco: 0,
    cambiadosPorProducto: [],
    intercambioPorProducto: [],
    prestamoPorProducto: [],
    vendidosPorProducto: [],
    recuperadosPorProducto: [],
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

      const allVentas = FullSyncService.getVentasForDate(startOfDay, endOfDay, sucursal);

      // Filtrar para evitar duplicados: excluir versiones pre-sincronización cuando existe versión sincronizada
      const ventas = allVentas.filter((v: any) => {
        // Incluir ventas locales sin sincronizar (noVenta == 0)
        if (v.noVenta == 0) return true;

        // Para ventas del servidor (noVenta > 0)
        if (v.noVenta > 0) {
          // Si NO tiene idMovil, verificar si existe versión sincronizada
          if (!v.idMovil) {
            const noVenta = v.noVenta;
            const sucursal = v.sucursal;
            const tieneVersionSincronizada = allVentas.some(
              (venta: any) => venta.noVenta === noVenta && venta.sucursal === sucursal && venta.idMovil,
            );
            // Si existe versión sincronizada, excluir esta (pre-sync)
            if (tieneVersionSincronizada) {
              console.log("[CortesScreen] 🔄 EXCLUIR DUPLICADO (pre-sync):", {
                id: v.id,
                noVenta: v.noVenta,
                nombreProducto: v.nombreProducto,
              });
              return false;
            }
          }
          // Incluir: tiene idMovil O no existe versión sincronizada
          return true;
        }

        return false;
      });

      console.log(
        "[CortesScreen] Total ventas:",
        allVentas.length,
        "Ventas filtradas (sin duplicados):",
        ventas.length,
      );
      console.log({ ventas });
      // Cargar kits y productos para expandir ventas de kits
      const allKits = FullSyncService.getKits(10000);
      const kitsByProducto: Record<number, any[]> = {};
      for (const kit of allKits) {
        const idProd = kit.idProducto;
        if (idProd != null) {
          if (!kitsByProducto[idProd]) kitsByProducto[idProd] = [];
          kitsByProducto[idProd].push(kit);
        }
      }

      // Mapa de productos para obtener nombre del insumo y propiedades
      const allProductos = FullSyncService.getProductos(10000);
      const productoNombreMap: Record<number, string> = {};
      const productoPorClaveMap: Record<number, any> = {};
      for (const p of allProductos) {
        productoNombreMap[p.id] = p.descripcion || `Producto ${p.id}`;
        // Indexar por id para buscar por ID de producto
        if (p.id != null) {
          productoPorClaveMap[p.id] = p;
        }
        // También indexar por claveProd (convertida a número) para buscar por clave de venta
        const claveProdNum = p.claveProd ? parseInt(p.claveProd, 10) : null;
        if (claveProdNum != null && !isNaN(claveProdNum)) {
          productoPorClaveMap[claveProdNum] = p;
        }
      }
      console.log(allProductos);
      const ventasPorProducto: Record<string, number> = {};
      const importesPorProd: Record<string, number> = {};
      const pagosPorTipo: Record<number, number> = {};
      // Acumulador para envases vendidos de kits con recuperaEnvase
      const envasesVendidosPorInsumo: Record<number, { descripcion: string; cantidad: number }> = {};

      // Debug: contar ventas con claveProd 26 y 68 (AX)
      const ventasClave26 = ventas.filter((v: any) => v.claveProd === 26);
      // DEBUG: Verificar si el kit 68 tiene insumos asignados
      const kit68Insumos = kitsByProducto[68];
      console.log("[CortesScreen] 🔍 Kit 68 (AX) tiene insumos?:", kit68Insumos?.length || 0);
      if (kit68Insumos?.length > 0) {
        console.log("[CortesScreen] 📋 Insumos del kit 68:", kit68Insumos.map((k: any) => ({ idInsumo: k.idInsumo, cantidad: k.cantidad })));
      }

      console.log("[CortesScreen] 📊 TOTAL VENTAS CON CLAVE 26:", ventasClave26.length);
      if (ventasClave26.length > 0) {
        console.log(
          "[CortesScreen] 📋 Detalles de ventas clave 26:",
          ventasClave26.map((v: any) => ({
            id: v.id,
            nombreProducto: v.nombreProducto,
            cantProducto: v.cantProducto,
            precio: v.precio,
            importe: v.importe,
            fecha: v.fecha,
            noVenta: v.noVenta,
            idMovil: v.idMovil,
          })),
        );
      }

      // DEBUG: Ver todas las ventas del kit 68 (AX)
      const ventasAX = ventas.filter((v: any) => v.claveProd === 68);
      console.log("[CortesScreen] 📊 TOTAL VENTAS CON CLAVE 68 (AX):", ventasAX.length);
      console.log("[CortesScreen] 📋 Detalles de ventas AX:",
        ventasAX.map((v: any) => ({
          id: v.id,
          idMovil: v.idMovil,
          noVenta: v.noVenta,
          cantProducto: v.cantProducto,
          importe: v.importe,
          tipoMovto: v.tipoMovto,
          fecha: v.fecha,
        }))
      );

      // DEBUG: Ver si hay ventas locales duplicadas (noVenta=0) del kit 68
      const ventasAXLocal = allVentas.filter((v: any) => v.claveProd === 68 && v.noVenta === 0);
      console.log("[CortesScreen] 📊 VENTAS LOCALES noVenta=0 de AX:", ventasAXLocal.length);
      if (ventasAXLocal.length > 0) {
        console.log("[CortesScreen] 📋 Detalles ventas AX locales:",
          ventasAXLocal.map((v: any) => ({ id: v.id, idMovil: v.idMovil, noVenta: v.noVenta }))
        );
      }

      // DEBUG: Rastrear acumulación de AX
      let axAcumuladoAntes = 0;

      for (const v of ventas) {
        const claveProd: number = v.claveProd || 0;
        const cantVenta: number = v.cantProducto || 0;
        const tipoPago: number = v.tipoPago || 0;
        const importeVenta: number = v.importe || 0;
        const tipoMovto: number = v.tipoMovto || 0;

        // DEBUG: Ver acumulación de AX en cada iteración
        if (claveProd === 68) {
          console.log(`[CortesScreen] 🔄 Procesando venta AX: id=${v.id}, noVenta=${v.noVenta}, cant=${cantVenta}, axAntes=${ventasPorProducto["AX"] || 0}`);
        }
        // DEBUG: Alertar si cualquier venta modifica el acumulador de "AX"
        const axAntesLoop = ventasPorProducto["AX"] || 0;

        // // Excluir producto con claveProd === 26 porque lo excluia?
        // if (claveProd === 26) {
        //   console.log("[CortesScreen] ⚠️ Excluyendo producto claveProd=26:", {
        //     nombreProducto: v.nombreProducto,
        //     cantProducto: cantVenta,
        //     precio: v.precio,
        //     importe: importeVenta,
        //     fecha: v.fecha,
        //   });
        //   continue;
        // }

        // Excluir ventas con tipoMovto === 1200 (préstamo de envases)
        if (tipoMovto === 1200) {
          console.log("[CortesScreen] ⚠️ Excluyendo venta tipoMovto=1200 (préstamo):", {
            nombreProducto: v.nombreProducto,
            claveProd: claveProd,
            cantProducto: cantVenta,
            tipoMovto: tipoMovto,
          });
          continue;
        }

        const kitInsumos = kitsByProducto[claveProd];
        const productoInfo = productoPorClaveMap[claveProd];
        const esKitInventariable = productoInfo?.esKit && productoInfo?.inventariable;

        // DEBUG: Log de productos inventariables
        if (productoInfo?.esKit && productoInfo?.inventariable) {
          console.log(`[CortesScreen] 📦 Kit inventariable detectado: claveProd=${claveProd}, nombre="${v.nombreProducto}", cant=${cantVenta}, idMovil=${v.idMovil}, noVenta=${v.noVenta}`);
        }

        // DEBUG: Verificar kit 69
        if (claveProd === 69) {
          console.log(`[CortesScreen] 🔍 DEBUG Kit 69: productoInfo=`, productoInfo, `esKitInventariable=${esKitInventariable}, kitInsumos.length=${kitInsumos?.length || 0}`);
        }

        // Es un kit con insumos Y NO es inventariable: expandir en sus insumos
        // Si es kit pero inventariable, tratarlo como producto normal
        if (kitInsumos && kitInsumos.length > 0 && !esKitInventariable) {
          let importeKitTotal = 0;
          for (const insumo of kitInsumos) {
            const idInsumo: number = insumo.idInsumo || 0;

            // Si el kit es idProducto=56 (Préstamo de Envases), NO agregar el insumo 18
            if ((claveProd === 56 && idInsumo === 18) || (claveProd === 66 && idInsumo === 16)) {
              console.log(`[CortesScreen] ⚠️ Excluyendo insumo ${idInsumo} del kit ${claveProd} (Préstamo de Envases)`);
              continue;
            }

            // Si el kit tiene recuperaEnvaseOtro o controlPresamo, acumular en envases vendidos
            if (insumo.recuperaEnvaseOtro === true || insumo.controlPresamo === true) {
              const cantInsumo: number = (insumo.cantidad || 0) * cantVenta;
              const nombreInsumo: string = productoNombreMap[idInsumo] || `Insumo ${idInsumo}`;

              // Acumular envase vendido por idInsumo
              if (!envasesVendidosPorInsumo[idInsumo]) {
                envasesVendidosPorInsumo[idInsumo] = { descripcion: nombreInsumo, cantidad: 0 };
              }
              envasesVendidosPorInsumo[idInsumo].cantidad += cantInsumo;

              console.log(
                `[CortesScreen] ♻️ Envase vendido acumulado: ${nombreInsumo} (idInsumo=${idInsumo}) +${cantInsumo} del kit ${claveProd}`,
              );
              continue;
            }

            const cantInsumo: number = (insumo.cantidad || 0) * cantVenta;
            const precioInsumo: number = Math.round((insumo.precio || 0) * 100) / 100;
            const nombreInsumo: string = productoNombreMap[idInsumo] || `Insumo ${idInsumo}`;

            ventasPorProducto[nombreInsumo] = (ventasPorProducto[nombreInsumo] || 0) + cantInsumo;
            importesPorProd[nombreInsumo] = (importesPorProd[nombreInsumo] || 0) + cantInsumo * precioInsumo;
            importeKitTotal += cantInsumo * precioInsumo;
          }
          // Tipo de pago: usar el importe real de la venta
          pagosPorTipo[tipoPago] = (pagosPorTipo[tipoPago] || 0) + importeVenta;
        } else {
          // Producto normal (o kit inventariable tratado como producto)
          const nombre: string = v.nombreProducto || "Sin nombre";
          const precio: number = v.precio || 0;

          // DEBUG: Log de acumulación
          if (productoInfo?.esKit) {
            console.log(`[CortesScreen] ➕ Acumulando kit inventariable: "${nombre}" +${cantVenta} (total: ${(ventasPorProducto[nombre] || 0) + cantVenta})`);
          }

          ventasPorProducto[nombre] = (ventasPorProducto[nombre] || 0) + cantVenta;
          importesPorProd[nombre] = (importesPorProd[nombre] || 0) + cantVenta * precio;
          pagosPorTipo[tipoPago] = (pagosPorTipo[tipoPago] || 0) + importeVenta;
        }

        // DEBUG: Verificar si el acumulador de AX cambió después de esta venta
        const axDespuesLoop = ventasPorProducto["AX"] || 0;
        if (axDespuesLoop > axAntesLoop && claveProd !== 68) {
          console.log(`[CortesScreen] 🚨 ALERTA: Venta claveProd=${claveProd} nombre="${v.nombreProducto}" sumó a AX! axAntes=${axAntesLoop} axDespues=${axDespuesLoop}`);
        }
      }

      const inventarioResult = Object.entries(ventasPorProducto)
        .filter(([, cant]) => cant > 0)
        .map(([nombre, cant]) => ({
          nombreProducto: nombre,
          cantTotal: cant,
        }));
      console.log("[CortesScreen] 📊 INVENTARIO VENDIDO FINAL:", inventarioResult);
      setInventarioVendido(inventarioResult);

      setImportesPorProducto(
        Object.entries(importesPorProd)
          .filter(([, imp]) => imp > 0)
          .map(([nombre, imp]) => ({
            nombreProducto: nombre,
            importe: imp,
          })),
      );

      const formasPago = FullSyncService.getFormasPago();
      const formaPagoMap: Record<number, string> = {};
      for (const fp of formasPago) {
        if (fp.tipo != null) {
          formaPagoMap[fp.tipo] = fp.descripcion || `Tipo ${fp.tipo}`;
        }
      }

      setTiposPago(
        Object.entries(pagosPorTipo)
          .map(([tipo, total]) => ({
            descripcion: formaPagoMap[parseInt(tipo, 10)] || `Tipo ${tipo}`,
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

      // Convertir envases vendidos calculados a formato de vendidosPorProducto
      const envasesVendidosCalculados = Object.entries(envasesVendidosPorInsumo).map(([idInsumo, data]) => ({
        descripcion: `Env Vacio ${data.descripcion}`,
        claveProd: parseInt(idInsumo, 10),
        cantidad: data.cantidad,
      })).filter(item => item.cantidad > 0);

      console.log("[CortesScreen] ♻️ Envases vendidos calculados:", envasesVendidosCalculados);

      // Combinar con los vendidosPorProducto existentes
      const envasesCombinados = {
        ...envasesData,
        vendidosPorProducto: [
          ...(envasesData.vendidosPorProducto || []),
          ...envasesVendidosCalculados,
        ],
      };

      setEnvases(envasesCombinados);
      console.log("=== ENVASES DATA ===");
      console.log(envasesCombinados);

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
            <Text style={[styles.td, styles.tdFlex]}>Env Vendido Xal</Text>
            <Text style={[styles.td, styles.tdRight]}>{envases.envVendido || "—"}</Text>
          </View>
          <View style={styles.tr}>
            <Text style={[styles.td, styles.tdFlex]}>Env Vendido Eco</Text>
            <Text style={[styles.td, styles.tdRight]}>{envases.envVendidoEco || "—"}</Text>
          </View>

          {/* Vendidos por producto (insumos de kits con recuperaEnvase/controlPresamo) */}
          {/* {envases.vendidosPorProducto?.map((item, idx) => (
            <View key={`vendido-${idx}`} style={styles.tr}>
              <Text style={[styles.td, styles.tdFlex]}>Vendido {item.descripcion}</Text>
              <Text style={[styles.td, styles.tdRight]}>{item.cantidad}</Text>
            </View>
          ))} */}

          {/* Intercambios por producto (recuperaEnvaseOtro) */}
          {envases.intercambioPorProducto?.length > 0 && (
            <View style={[styles.table, { marginTop: 6 }]}>
              <View style={styles.tableHeader}>
                <Text style={[styles.th, styles.thFlex]}>CAMBIADO</Text>
                <Text style={[styles.th, styles.thRight]}>CANT</Text>
              </View>
              {envases.intercambioPorProducto.map((item, idx) => (
                <View key={idx} style={styles.tr}>
                  <Text style={[styles.td, styles.tdFlex]}>{item.descripcion}</Text>
                  <Text style={[styles.td, styles.tdRight]}>{item.cantidad}</Text>
                </View>
              ))}
            </View>
          )}

          {/* <View style={styles.tr}>
            <Text style={[styles.td, styles.tdFlex]}>Env Cambiado Xal</Text>
            <Text style={[styles.td, styles.tdRight]}>{envases.envCambiado || "—"}</Text>
          </View>
          <View style={styles.tr}>
            <Text style={[styles.td, styles.tdFlex]}>Env Cambiado Eco</Text>
            <Text style={[styles.td, styles.tdRight]}>{envases.envCambiadoEco || "—"}</Text>
          </View> */}
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

          {/* Prestamos por producto (controlPresamo) */}
          {envases.prestamoPorProducto?.length > 0 && (
            <View style={[styles.table, { marginTop: 6 }]}>
              <View style={styles.tableHeader}>
                <Text style={[styles.th, styles.thFlex]}>PRESTAMO</Text>
                <Text style={[styles.th, styles.thRight]}>CANT</Text>
              </View>
              {envases.prestamoPorProducto.map((item, idx) => (
                <View key={idx} style={styles.tr}>
                  <Text style={[styles.td, styles.tdFlex]}>{item.descripcion}</Text>
                  <Text style={[styles.td, styles.tdRight]}>{item.cantidad}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Recuperados por producto (recuperaEnvase) */}
          {envases.recuperadosPorProducto?.length > 0 && (
            <View style={[styles.table, { marginTop: 6 }]}>
              <View style={styles.tableHeader}>
                <Text style={[styles.th, styles.thFlex]}>ENV RECUPERADOS</Text>
                <Text style={[styles.th, styles.thRight]}>CANT</Text>
              </View>
              {envases.recuperadosPorProducto.map((item, idx) => (
                <View key={idx} style={styles.tr}>
                  <Text style={[styles.td, styles.tdFlex]}>{item.descripcion}</Text>
                  <Text style={[styles.td, styles.tdRight]}>{item.cantidad}</Text>
                </View>
              ))}
            </View>
          )}

          {/* <View style={styles.tr}>
            <Text style={[styles.td, styles.tdFlex]}>Env Prestado</Text>
            <Text style={[styles.td, styles.tdRight]}>{envases.envPrestado || "—"}</Text>
          </View>
          <View style={styles.tr}>
            <Text style={[styles.td, styles.tdFlex]}>Env Prestado Eco</Text>
            <Text style={[styles.td, styles.tdRight]}>{envases.envPrestadoEco || "—"}</Text>
          </View> */}
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
