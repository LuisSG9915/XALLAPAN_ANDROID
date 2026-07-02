import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  TextInput,
  Alert,
  ActivityIndicator,
  ScrollView,
  SafeAreaView,
  Platform,
  StatusBar,
} from "react-native";
import { Icon } from "react-native-elements";
import FullSyncService from "../services/FullSyncService";
import AuthService, { Usuario } from "../services/AuthService";
import LocationService, { LocationCoordinates, calcularDistancia } from "../services/LocationService";
import TicketPrinter from "../services/TicketPrinter";
import BluetoothPrinterService from "../services/BluetoothPrinterService";
import { APP_NAME, COLORS, SPACING, SHADOWS, BORDER_RADIUS, TYPOGRAPHY } from "../theme/theme";
import IntercambioEnvaseModal from "./IntercambioEnvaseModal";
import PrestamoEnvaseModal from "./PrestamoEnvaseModal";

type Cliente = {
  id: number;
  nombre: string;
  credito?: boolean;
  idGrupo?: number;
  listaPrecio?: number;
  latitud?: number;
  longitud?: number;
  metros?: number;
};

type OperationType = "intercambio" | "prestamo" | null;

// Steps: 1) select operation, 2) select client, 3) select quantity, 4) modal, 5) confirm
type Step = "operation" | "client" | "quantity" | "modal" | "processing";

type ClienteTab = "todos" | "cercanos";

// Generación de id_movil corto e irrepetible para ventas locales.
// Estructura: MOVIL_ID_BASE + (segundos desde EPOCH * 1000) + sucursal
//  - Siempre > 1700000000 (umbral que distingue ventas locales de las del servidor)
//  - La sucursal queda en los últimos 3 dígitos (id_movil % 1000 === sucursal)
//  - Reserva un bloque de 1000 por segundo para los ids locales (id = idMovil + index)
//  - La guardia monotónica evita colisiones si se generan dos en el mismo segundo
const MOVIL_ID_BASE = 1700000000;
const MOVIL_ID_EPOCH_SECONDS = 1704067200; // 2024-01-01 00:00:00 UTC
let lastMovilSeconds = 0;

const buildMovilSaleId = (sucursal: number): number => {
  let seconds = Math.floor(Date.now() / 1000) - MOVIL_ID_EPOCH_SECONDS;
  if (seconds <= lastMovilSeconds) {
    seconds = lastMovilSeconds + 1;
  }
  lastMovilSeconds = seconds;
  return MOVIL_ID_BASE + seconds * 1000 + (sucursal % 1000);
};

export default function EnvaseOperacionScreen({ navigation }: { navigation: any }) {
  const [step, setStep] = useState<Step>("operation");
  const [operationType, setOperationType] = useState<OperationType>(null);
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [filteredClientes, setFilteredClientes] = useState<Cliente[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedClient, setSelectedClient] = useState<Cliente | null>(null);
  const [clienteTabActivo, setClienteTabActivo] = useState<ClienteTab>("todos");
  const [nearestClientes, setNearestClientes] = useState<(Cliente & { distanciaMetros: number })[]>([]);
  const [loadingCercanos, setLoadingCercanos] = useState(false);
  const [userCoords, setUserCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [cantidad, setCantidad] = useState("1");
  const [currentUser, setCurrentUser] = useState<Usuario | null>(null);
  const [currentSucursal, setCurrentSucursal] = useState<number>(0);
  const [productosBase, setProductosBase] = useState<any[]>([]);
  const [processing, setProcessing] = useState(false);
  const [metodoPago, setMetodoPago] = useState<number | null>(null);
  const [formasPago, setFormasPago] = useState<any[]>([]);

  // Modal states
  const [intercambioModalOpen, setIntercambioModalOpen] = useState(false);
  const [prestamoModalOpen, setPrestamoModalOpen] = useState(false);

  // Data from modals
  const [intercambioData, setIntercambioData] = useState<{
    envaseEntregadoClave: number;
    envaseEntregadoDesc: string;
    envaseRecibidoClave: number;
    envaseRecibidoDesc: string;
    observacion: string;
    costo: number;
  } | null>(null);
  const [costoIntercambioCalculado, setCostoIntercambioCalculado] = useState(0);
  const envaseIntercambioClaveRef = useRef<number | undefined>(undefined);
  const envaseIntercambioDescRef = useRef<string | undefined>(undefined);
  const [prestamoData, setPrestamoData] = useState<{
    idProdPrestado: number;
    claveProdPrestado: number;
    descProdPrestado: string;
    observacion: string;
    fechaDevolucion: string;
  } | null>(null);

  // Debug: monitorear cambios en intercambioModalOpen
  useEffect(() => {
    console.log("[EnvaseOp] 🔔 Estado intercambioModalOpen cambió a:", intercambioModalOpen);
    console.log("[EnvaseOp] 🔔 costoIntercambioCalculado:", costoIntercambioCalculado);
  }, [intercambioModalOpen, costoIntercambioCalculado]);

  useEffect(() => {
    const init = async () => {
      try {
        const user = await AuthService.restoreSession();
        if (user) {
          setCurrentUser(user);
          const sucursal =
            (user.sucursal_origen as number | null | undefined) ?? (user.sucursal as number | null | undefined) ?? 1;
          setCurrentSucursal(sucursal);
        }

        await FullSyncService.initialize();
        const clientesData = FullSyncService.getClientesFull(10000);
        const clientesFormateados = clientesData.map((c: any) => ({
          id: c.id,
          nombre: c.nombre || "Sin nombre",
          credito: c.credito || false,
          idGrupo: c.idGrupo,
          listaPrecio: c.listaPrecio,
          latitud: c.latitud,
          longitud: c.longitud,
          metros: c.metros,
        }));
        setClientes(clientesFormateados);
        setFilteredClientes(clientesFormateados);

        const productosData = FullSyncService.getProductos(100000);
        setProductosBase(productosData);

        // Cargar formas de pago dinámicas
        const formasPagoData = FullSyncService.getFormasPago();
        console.log(`[EnvaseOp] Formas de pago cargadas: ${formasPagoData.length}`);
        setFormasPago(formasPagoData);
      } catch (error) {
        console.error("[EnvaseOp] Error al inicializar:", error);
        Alert.alert("Error", "No se pudieron cargar los datos. Sincroniza primero.");
      }
    };
    init();
  }, []);

  const actualizarCoordenadas = async () => {
    setLoadingCercanos(true);
    try {
      const ubicacion = await LocationService.getBestLocation();
      if (ubicacion) {
        setUserCoords({ latitude: ubicacion.latitude, longitude: ubicacion.longitude });
        const clientesConCoords = clientes.filter(
          (c) => c.latitud != null && c.longitud != null && (c.latitud !== 0 || c.longitud !== 0),
        );
        console.log(
          `[EnvaseOp] Cercanos: ${clientes.length} clientes total, ${clientesConCoords.length} con coordenadas válidas`,
        );
        const clientesConDistancia = clientesConCoords
          .map((c) => ({
            ...c,
            distanciaMetros: calcularDistancia(ubicacion.latitude, ubicacion.longitude, c.latitud!, c.longitud!),
          }))
          .sort((a, b) => a.distanciaMetros - b.distanciaMetros)
          .slice(0, 5);
        console.log(
          `[EnvaseOp] Top 5 cercanos:`,
          clientesConDistancia.map((c) => ({ id: c.id, nombre: c.nombre, dist: Math.round(c.distanciaMetros) })),
        );
        setNearestClientes(clientesConDistancia);
      } else {
        Alert.alert("Ubicación no disponible", "No se pudo obtener tu ubicación. Verifica que el GPS esté activado.");
      }
    } catch (error) {
      console.error("[EnvaseOp] Error al obtener ubicación:", error);
      Alert.alert("Error de ubicación", "No se pudo obtener tu ubicación.");
    } finally {
      setLoadingCercanos(false);
    }
  };

  const handleSearch = useCallback(
    (query: string) => {
      setSearchQuery(query);
      if (!query.trim()) {
        setFilteredClientes(clientes);
        return;
      }
      const lowerQuery = query.toLowerCase();
      const filtered = clientes.filter(
        (c) => c.nombre.toLowerCase().includes(lowerQuery) || c.id.toString().includes(query),
      );
      setFilteredClientes(filtered);
    },
    [clientes],
  );

  const handleSelectOperation = (type: OperationType) => {
    setOperationType(type);
    setStep("client");
  };

  const handleSelectClient = (cliente: Cliente) => {
    setSelectedClient(cliente);
    setStep("quantity");
    setCantidad("1");
  };

  const handleContinueToModal = () => {
    console.log("[EnvaseOp] 🔵 handleContinueToModal iniciado");
    console.log("[EnvaseOp] cantidad:", cantidad, "operationType:", operationType);

    const cantNum = parseInt(cantidad, 10);
    if (!cantNum || cantNum <= 0) {
      console.log("[EnvaseOp] ❌ Cantidad inválida");
      Alert.alert("Error", "La cantidad debe ser mayor a 0");
      return;
    }

    if (!metodoPago) {
      Alert.alert("Error", "Selecciona un método de pago");
      return;
    }

    console.log("[EnvaseOp] ✅ Cantidad válida:", cantNum);

    const handleConfirmQuantity = () => {
      console.log("[EnvaseOp] 🔵 handleConfirmQuantity iniciado");
      console.log("[EnvaseOp] operationType:", operationType);

      if (operationType === "intercambio") {
        console.log("[EnvaseOp] 📦 Procesando intercambio");
        // Buscar producto con intercambio=true dinámicamente
        const productos = FullSyncService.getProductos(1000000);
        const productoIntercambio = productos.find((p: any) => p.intercambio);

        if (!productoIntercambio) {
          console.warn("[EnvaseOp] No se encontró producto con intercambio=true");
          setCostoIntercambioCalculado(0);
          envaseIntercambioClaveRef.current = undefined;
          envaseIntercambioDescRef.current = undefined;
          setIntercambioModalOpen(true);
        } else {
          const idProductoIntercambio = productoIntercambio.id;

          // Buscar kit con envaseIntercambio=true para el modal
          try {
            const kitsAll = FullSyncService.getKits(5000);
            const kitEnvase = kitsAll.find((k: any) => k.idProducto === idProductoIntercambio && k.envaseIntercambio);
            if (kitEnvase) {
              const idInsumo = kitEnvase.idInsumo;
              const prodInsumo = productos.find((p: any) => p.id === idInsumo);
              envaseIntercambioClaveRef.current = prodInsumo ? parseInt(prodInsumo.claveProd || "0", 10) : idInsumo;
              envaseIntercambioDescRef.current = prodInsumo?.descripcion || `Producto ${idInsumo}`;
              console.log(`[EnvaseOp] envaseIntercambio: idInsumo=${idInsumo}, desc=${prodInsumo?.descripcion}`);
            } else {
              envaseIntercambioClaveRef.current = undefined;
              envaseIntercambioDescRef.current = undefined;
            }
          } catch (err) {
            console.warn("[EnvaseOp] Error buscando envaseIntercambio:", err);
            envaseIntercambioClaveRef.current = undefined;
            envaseIntercambioDescRef.current = undefined;
          }

          const listaPrecios = selectedClient?.listaPrecio ?? 0;
          const preciosPromo = FullSyncService.getPreciosPromoByCliente(selectedClient?.id || 0);
          const preciosCliente = FullSyncService.getPreciosByListaPrecio(listaPrecios);
          const preciosDefault = FullSyncService.getPreciosByListaPrecio(13);

          // Jerarquía de precios: promo -> cliente -> default (igual que SalesScreen)
          let costoCalculado = 0;

          // 1. Precio promocional
          const precioPromo = preciosPromo?.find(
            (p: any) => parseInt(p.claveProd || "0", 10) === idProductoIntercambio,
          );
          if (precioPromo) {
            costoCalculado = precioPromo.precio || 0;
          }
          // 2. Precio del cliente
          else {
            const precioCliente = preciosCliente?.find(
              (p: any) => parseInt(p.claveProd || "0", 10) === idProductoIntercambio,
            );
            if (precioCliente) {
              costoCalculado = precioCliente.precio || 0;
            }
            // 3. Precio por defecto
            else {
              const precioDefault = preciosDefault?.find(
                (p: any) => parseInt(p.claveProd || "0", 10) === idProductoIntercambio,
              );
              if (precioDefault) {
                costoCalculado = precioDefault.precio || 0;
              }
            }
          }

          console.log(
            `[EnvaseOp] Producto INTERCAMBIO - id: ${idProductoIntercambio}, costo: $${costoCalculado.toFixed(2)}`,
          );
          console.log("[EnvaseOp] 🔵 Estableciendo costo:", costoCalculado);
          setCostoIntercambioCalculado(costoCalculado);
          console.log("[EnvaseOp] 🚀 Abriendo modal de intercambio (setTimeout)");
          setTimeout(() => {
            console.log("[EnvaseOp] ⏱️ setTimeout ejecutado, setIntercambioModalOpen(true)");
            setIntercambioModalOpen(true);
          }, 100);
          console.log("[EnvaseOp] ✅ setTimeout registrado");
        }
      } else if (operationType === "prestamo") {
        console.log("[EnvaseOp] 📦 Procesando préstamo");
        console.log("[EnvaseOp] 🚀 Abriendo modal de préstamo");
        setPrestamoModalOpen(true);
      }
    };
    console.log("[EnvaseOp] 🔵 Llamando handleConfirmQuantity");
    handleConfirmQuantity();
    console.log("[EnvaseOp] ✅ handleContinueToModal completado");
  };

  const handleIntercambioAccept = async (data: {
    envaseEntregadoClave: number;
    envaseEntregadoDesc: string;
    envaseRecibidoClave: number;
    envaseRecibidoDesc: string;
    observacion: string;
    costo: number;
  }) => {
    setIntercambioModalOpen(false);
    setIntercambioData(data);
    await processEnvaseOperation("intercambio", data, null);
  };

  const handlePrestamoAccept = async (data: {
    idProdPrestado: number;
    claveProdPrestado: number;
    descProdPrestado: string;
    observacion: string;
    fechaDevolucion: string;
  }) => {
    setPrestamoModalOpen(false);
    setPrestamoData(data);
    await processEnvaseOperation("prestamo", null, data);
  };

  const processEnvaseOperation = async (
    type: "intercambio" | "prestamo",
    intercambio: {
      envaseEntregadoClave: number;
      envaseEntregadoDesc: string;
      envaseRecibidoClave: number;
      envaseRecibidoDesc: string;
      observacion: string;
      costo: number;
    } | null,
    prestamo: {
      idProdPrestado: number;
      claveProdPrestado: number;
      descProdPrestado: string;
      observacion: string;
      fechaDevolucion: string;
    } | null,
  ) => {
    if (!selectedClient || !currentUser) return;

    setProcessing(true);
    setStep("processing");

    try {
      const sucursal = currentSucursal || 1;
      const saleIdMovil = buildMovilSaleId(sucursal);
      const cantNum = parseInt(cantidad, 10) || 1;
      const vendedor =
        (currentUser.claveEmpleado as string | undefined) || (currentUser.nombre as string | undefined) || "";
      const now = FullSyncService.getMexicoNow();

      // Tipo de pago
      const tipoPagoCode = metodoPago ?? 1;
      const formaPagoSel = formasPago.find((fp: any) => fp.tipo === metodoPago);
      const descripcionMedioPago = formaPagoSel?.descripcion ?? "Efectivo";

      // Determine claveProd for the sale line (dinámico para intercambio y préstamo)
      let productoVenta: any;
      if (type === "intercambio") {
        productoVenta = productosBase.find((p: any) => p.intercambio);
      } else {
        productoVenta = productosBase.find((p: any) => p.prestamo);
      }
      const idProductoVenta = productoVenta?.id ?? (type === "intercambio" ? 0 : 0);
      const descripcionVenta =
        productoVenta?.descripcion || (type === "intercambio" ? "INTERCAMBIO ENVASE" : "PRESTAMO ENVASE");

      // Build observacion
      let observacionVenta = "";
      if (intercambio && intercambio.observacion) {
        observacionVenta = intercambio.observacion;
      }
      if (prestamo && prestamo.observacion) {
        observacionVenta = observacionVenta ? `${observacionVenta} | ${prestamo.observacion}` : prestamo.observacion;
      }

      // GPS coordinates
      let coordinates: LocationCoordinates | null = null;
      try {
        coordinates = await LocationService.getBestLocation();
      } catch (locationError) {
        console.error("[EnvaseOp] Error al obtener ubicación:", locationError);
      }

      // Precio de la venta: para intercambio usar el costo calculado del modal
      const precioVenta = type === "intercambio" && intercambio ? intercambio.costo : 0;

      // Print ticket
      try {
        // Obtener datos del usuario desde Realm (tabla Usuario) para el ticket
        let usuarioTicketData: {
          nombreCia?: string;
          rfc?: string;
          domicilio?: string;
          regimenFiscal?: string;
          telefono?: string;
          ticketFinal?: string;
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
              };
              console.log("[EnvaseOp] Datos de ticket obtenidos de Realm:", usuarioTicketData);
            }
          }
        } catch (e) {
          console.error("[EnvaseOp] Error al obtener datos de usuario de Realm:", e);
        }

        await TicketPrinter.printSaleTicket({
          clientName: selectedClient.nombre,
          paymentMethod: descripcionMedioPago,
          items: [
            {
              description: descripcionVenta,
              quantity: cantNum,
              price: precioVenta,
              total: precioVenta * cantNum,
            },
          ],
          total: precioVenta * cantNum,
          businessName: usuarioTicketData.nombreCia || APP_NAME,
          date: now,
          ticketNumber: String(saleIdMovil),
          sellerName: vendedor,
          branch: sucursal,
          taxId: usuarioTicketData.rfc,
          domicilio: usuarioTicketData.domicilio,
          regimenFiscal: usuarioTicketData.regimenFiscal,
          phone: usuarioTicketData.telefono,
          ticketFinal: usuarioTicketData.ticketFinal,
        });
        console.log("[EnvaseOp] Ticket impreso");
      } catch (printError) {
        console.error("[EnvaseOp] Error al imprimir ticket:", printError);
      }

      // Create Venta record
      console.log("[EnvaseOp] Guardando venta local...");
      await FullSyncService.createLocalVentas([
        {
          id: saleIdMovil,
          sucursal,
          noVenta: 0,
          idMovil: saleIdMovil,
          claveProd: idProductoVenta,
          nombreProducto: descripcionVenta,
          cantProducto: cantNum,
          precio: precioVenta,
          importe: precioVenta * cantNum,
          cveCliente: selectedClient.id,
          nombreCliente: selectedClient.nombre,
          fecha: now,
          tipoPago: tipoPagoCode,
          descripcionMedioPago: descripcionMedioPago,
          vendedor,
          folioFactura: false,
          facturacionMovil: false,
          latitud: coordinates?.latitude ?? null,
          longitud: coordinates?.longitude ?? null,
          observacion: observacionVenta,
        },
      ]);
      console.log("[EnvaseOp] Venta creada exitosamente");

      // Create InventarioEnvase records
      const getProductIdByClave = (claveProd: number): number => {
        const producto = productosBase.find((p: any) => parseInt(p.claveProd || "0", 10) === claveProd);
        return producto?.id || claveProd;
      };

      const envaseItems: {
        sucursal: number;
        claveProd: number;
        folioMovto: number;
        cantidadEntrada: number;
        cantidadSalida: number;
        costo: number;
        tipoMovto: number;
        idMovil: number;
        observacion: string;
      }[] = [];

      if (type === "intercambio" && intercambio) {
        // SALIDA: envase XALLAPAN entregado
        envaseItems.push({
          sucursal,
          claveProd: getProductIdByClave(intercambio.envaseEntregadoClave),
          folioMovto: 1,
          cantidadEntrada: 0,
          cantidadSalida: cantNum,
          costo: intercambio.costo,
          tipoMovto: 1100,
          idMovil: saleIdMovil,
          observacion: intercambio.observacion || "",
        });
        // ENTRADA: envase recibido
        envaseItems.push({
          sucursal,
          claveProd: getProductIdByClave(intercambio.envaseRecibidoClave),
          folioMovto: 1,
          cantidadEntrada: cantNum,
          cantidadSalida: 0,
          costo: intercambio.costo,
          tipoMovto: 1000,
          idMovil: saleIdMovil,
          observacion: intercambio.observacion || "",
        });
      }

      if (type === "prestamo" && prestamo) {
        const obsCompleta = [
          prestamo.observacion,
          prestamo.fechaDevolucion ? `Fecha devolucion: ${prestamo.fechaDevolucion}` : "",
        ]
          .filter(Boolean)
          .join(" | ");
        envaseItems.push({
          sucursal,
          claveProd: prestamo.idProdPrestado,
          folioMovto: 1,
          cantidadEntrada: 0,
          cantidadSalida: cantNum,
          costo: 0,
          tipoMovto: 1200,
          idMovil: saleIdMovil,
          observacion: obsCompleta,
        });
      }

      if (envaseItems.length > 0) {
        console.log("[EnvaseOp] Guardando InventarioEnvase:", envaseItems.length, "registros");
        await FullSyncService.createLocalInventarioEnvase(envaseItems);
        console.log("[EnvaseOp] InventarioEnvase guardado");
      }

      const tipoOp = type === "intercambio" ? "Intercambio" : "Préstamo";
      Alert.alert(
        "Operación Exitosa",
        `${tipoOp} de envase registrado correctamente.\n\nCliente: ${selectedClient.nombre}\nCantidad: ${cantNum}`,
        [
          {
            text: "Aceptar",
            onPress: () => resetScreen(),
          },
        ],
      );
    } catch (error: any) {
      console.error("[EnvaseOp] Error al procesar operación:", error);
      Alert.alert("Error", `No se pudo procesar la operación: ${error?.message || "Error desconocido"}`);
    } finally {
      setProcessing(false);
    }
  };

  const resetScreen = () => {
    setStep("operation");
    setOperationType(null);
    setSelectedClient(null);
    setCantidad("1");
    setMetodoPago(null);
    setSearchQuery("");
    setFilteredClientes(clientes);
    setIntercambioData(null);
    setPrestamoData(null);
  };

  const handleBack = () => {
    if (step === "client") {
      setStep("operation");
      setOperationType(null);
      setSearchQuery("");
      setFilteredClientes(clientes);
    } else if (step === "quantity") {
      setStep("client");
      setSelectedClient(null);
    } else if (step === "operation") {
      navigation.goBack();
    }
  };

  // ===================== RENDER =====================

  const renderOperationSelection = () => (
    <View style={styles.contentContainer}>
      <Text style={styles.stepTitle}>Seleccione el tipo de operación</Text>
      <Text style={styles.stepSubtitle}>¿Qué operación desea realizar?</Text>

      <TouchableOpacity
        style={styles.operationCard}
        onPress={() => handleSelectOperation("intercambio")}
        activeOpacity={0.85}
      >
        <View style={[styles.operationIconContainer, { backgroundColor: "#E8F5E9" }]}>
          <Icon name="swap-horiz" type="material" size={36} color="#2E7D32" />
        </View>
        <View style={styles.operationTextContainer}>
          <Text style={styles.operationTitle}>Intercambio de Envase </Text>
          <Text style={styles.operationDesc}>Cambiar un envase XALLAPAN por otro envase </Text>
        </View>
        <Icon name="chevron-right" type="material" size={24} color={COLORS.muted} />
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.operationCard}
        onPress={() => handleSelectOperation("prestamo")}
        activeOpacity={0.85}
      >
        <View style={[styles.operationIconContainer, { backgroundColor: "#E3F2FD" }]}>
          <Icon name="assignment-return" type="material" size={36} color="#1565C0" />
        </View>
        <View style={styles.operationTextContainer}>
          <Text style={styles.operationTitle}>Préstamo de Envase</Text>
          <Text style={styles.operationDesc}>Prestar envases al cliente con fecha de devolución</Text>
        </View>
        <Icon name="chevron-right" type="material" size={24} color={COLORS.muted} />
      </TouchableOpacity>
    </View>
  );

  const renderClientSelection = () => (
    <View style={styles.clientContainer}>
      <Text style={styles.stepTitle}>
        {operationType === "intercambio" ? "Intercambio de Envase " : "Préstamo de Envase"}
      </Text>
      <Text style={styles.stepSubtitle}>Seleccione el cliente</Text>

      {/* Tabs: Todos | Cercanos */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tabItem, clienteTabActivo === "todos" && styles.tabItemActive]}
          onPress={() => {
            setClienteTabActivo("todos");
            setSearchQuery("");
          }}
        >
          <Text style={[styles.tabItemText, clienteTabActivo === "todos" && styles.tabItemTextActive]}>Todos</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabItem, clienteTabActivo === "cercanos" && styles.tabItemActive]}
          onPress={() => {
            setClienteTabActivo("cercanos");
            setSearchQuery("");
            if (nearestClientes.length === 0) {
              actualizarCoordenadas();
            }
          }}
        >
          <Text style={[styles.tabItemText, clienteTabActivo === "cercanos" && styles.tabItemTextActive]}>
            Cercanos
          </Text>
        </TouchableOpacity>
      </View>

      {/* Tab: Cercanos */}
      {clienteTabActivo === "cercanos" && (
        <View>
          <TouchableOpacity style={styles.refreshCoordsBtn} onPress={actualizarCoordenadas} disabled={loadingCercanos}>
            {loadingCercanos ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Icon name="my-location" type="material" size={16} color="#fff" />
            )}
            <Text style={styles.refreshCoordsBtnText}>
              {loadingCercanos ? "Obteniendo ubicación..." : "Actualizar mis coordenadas"}
            </Text>
          </TouchableOpacity>
          {userCoords && (
            <Text style={styles.coordsInfo}>
              📍 Lat: {userCoords.latitude.toFixed(6)}, Lng: {userCoords.longitude.toFixed(6)}
            </Text>
          )}
        </View>
      )}

      {/* Search - solo para tab "Todos" */}
      {clienteTabActivo === "todos" && (
        <View style={styles.searchContainer}>
          <Icon name="search" type="material" size={20} color={COLORS.muted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Buscar por nombre o ID..."
            placeholderTextColor={COLORS.muted}
            value={searchQuery}
            onChangeText={handleSearch}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => handleSearch("")} style={styles.clearButton}>
              <Text style={styles.clearButtonText}>✕</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Contador de resultados */}
      {clienteTabActivo === "cercanos" ? (
        nearestClientes.length > 0 && (
          <Text style={styles.resultCount}>
            {nearestClientes.length} cliente{nearestClientes.length !== 1 ? "s" : ""} cercano
            {nearestClientes.length !== 1 ? "s" : ""}
          </Text>
        )
      ) : (
        <Text style={styles.resultCount}>
          {filteredClientes.length} cliente{filteredClientes.length !== 1 ? "s" : ""}
        </Text>
      )}

      {/* Lista de clientes según tab activo */}
      {clienteTabActivo === "cercanos" ? (
        <FlatList
          data={nearestClientes}
          keyExtractor={(i) => String(i.id)}
          style={styles.clientList}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.clientRow} onPress={() => handleSelectClient(item)} activeOpacity={0.7}>
              <View style={styles.clientAvatar}>
                <Text style={styles.clientAvatarText}>{(item.nombre || "?")[0].toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.clientName}>{item.nombre}</Text>
                <Text style={styles.clientId}>ID: {item.id}</Text>
                <Text style={styles.distanceText}>📍 {Math.round(item.distanciaMetros)} m</Text>
              </View>
              {item.credito && <Text style={styles.creditBadge}>Crédito</Text>}
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>
                {loadingCercanos
                  ? "Buscando clientes cercanos..."
                  : userCoords
                  ? "Ningún cliente tiene coordenadas registradas."
                  : "Presiona 'Actualizar mis coordenadas' para ver los 5 más cercanos"}
              </Text>
            </View>
          }
        />
      ) : (
        <FlatList
          data={filteredClientes}
          keyExtractor={(i) => String(i.id)}
          style={styles.clientList}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.clientRow} onPress={() => handleSelectClient(item)} activeOpacity={0.7}>
              <View style={styles.clientAvatar}>
                <Text style={styles.clientAvatarText}>{(item.nombre || "?")[0].toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.clientName}>{item.nombre}</Text>
                <Text style={styles.clientId}>ID: {item.id}</Text>
              </View>
              {item.credito && <Text style={styles.creditBadge}>Crédito</Text>}
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>No se encontraron clientes</Text>
            </View>
          }
        />
      )}
    </View>
  );

  const renderQuantitySelection = () => (
    <View style={styles.contentContainer}>
      <Text style={styles.stepTitle}>
        {operationType === "intercambio" ? "Intercambio de Envase " : "Préstamo de Envase"}
      </Text>

      {/* Selected client card */}
      <View style={styles.selectedClientCard}>
        <View style={styles.selectedClientIcon}>
          <Icon name="person" type="material" size={24} color={COLORS.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.selectedClientLabel}>CLIENTE SELECCIONADO</Text>
          <Text style={styles.selectedClientName}>{selectedClient?.nombre}</Text>
          <Text style={styles.selectedClientId}>ID: {selectedClient?.id}</Text>
        </View>
        <TouchableOpacity
          onPress={() => {
            setStep("client");
            setSelectedClient(null);
          }}
        >
          <Icon name="edit" type="material" size={20} color={COLORS.muted} />
        </TouchableOpacity>
      </View>

      {/* Quantity input */}
      <View style={styles.quantitySection}>
        <Text style={styles.quantityLabel}>CANTIDAD DE ENVASES</Text>
        <View style={styles.quantityRow}>
          <TouchableOpacity
            style={styles.qtyBtn}
            onPress={() => {
              const n = Math.max(1, (parseInt(cantidad, 10) || 1) - 1);
              setCantidad(String(n));
            }}
          >
            <Text style={styles.qtyBtnText}>−</Text>
          </TouchableOpacity>
          <TextInput
            style={styles.qtyInput}
            keyboardType="number-pad"
            value={cantidad}
            onChangeText={(t) => {
              if (/^\d*$/.test(t)) setCantidad(t);
            }}
            onBlur={() => {
              const n = parseInt(cantidad, 10);
              if (!n || n <= 0) setCantidad("1");
            }}
          />
          <TouchableOpacity
            style={styles.qtyBtn}
            onPress={() => {
              const n = (parseInt(cantidad, 10) || 1) + 1;
              setCantidad(String(n));
            }}
          >
            <Text style={styles.qtyBtnText}>+</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Payment method selection */}
      <View style={styles.paymentSection}>
        <Text style={styles.quantityLabel}>MÉTODO DE PAGO</Text>
        <View style={styles.payRow}>
          {formasPago.map((fp: any) => {
            const esCred = fp.tipo === 3;
            const disabled = esCred ? (selectedClient ? !selectedClient.credito : true) : false;
            return (
              <PayChipEnvase
                key={fp.tipo}
                label={fp.descripcion || `Tipo ${fp.tipo}`}
                selected={metodoPago === fp.tipo}
                onPress={() => setMetodoPago(fp.tipo)}
                disabled={disabled}
              />
            );
          })}
        </View>
      </View>

      {/* Continue button */}
      <TouchableOpacity
        style={[styles.continueBtn, !metodoPago && styles.continueBtnDisabled]}
        onPress={handleContinueToModal}
        activeOpacity={0.85}
        disabled={!metodoPago}
      >
        <Text style={styles.continueBtnText}>Continuar</Text>
        <Icon name="arrow-forward" type="material" size={20} color="#fff" />
      </TouchableOpacity>
    </View>
  );

  const renderProcessing = () => (
    <View style={styles.processingContainer}>
      <ActivityIndicator size="large" color={COLORS.primary} />
      <Text style={styles.processingText}>Procesando operación...</Text>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      {/* Header with back button */}
      {step !== "processing" && (
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={handleBack}>
            <Icon name="arrow-back" type="material" size={24} color={COLORS.primary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Operaciones de Envase</Text>
          {step !== "operation" ? (
            <TouchableOpacity style={styles.resetBtn} onPress={resetScreen}>
              <Icon name="refresh" type="material" size={20} color={COLORS.muted} />
            </TouchableOpacity>
          ) : (
            <View style={styles.resetBtn} />
          )}
        </View>
      )}

      {/* Step indicator */}
      {step !== "processing" && (
        <View style={styles.stepIndicator}>
          <View style={[styles.stepDot, step === "operation" && styles.stepDotActive]} />
          <View style={[styles.stepLine, (step === "client" || step === "quantity") && styles.stepLineActive]} />
          <View style={[styles.stepDot, step === "client" && styles.stepDotActive]} />
          <View style={[styles.stepLine, step === "quantity" && styles.stepLineActive]} />
          <View style={[styles.stepDot, step === "quantity" && styles.stepDotActive]} />
        </View>
      )}

      {step === "operation" && renderOperationSelection()}
      {step === "client" && renderClientSelection()}
      {step === "quantity" && renderQuantitySelection()}
      {step === "processing" && renderProcessing()}

      {/* Modals */}
      {intercambioModalOpen && (
        <IntercambioEnvaseModal
          visible={intercambioModalOpen}
          cantidad={parseInt(cantidad, 10) || 1}
          costoAutomatico={costoIntercambioCalculado}
          envaseEntregadoClave={envaseIntercambioClaveRef.current}
          envaseEntregadoDesc={envaseIntercambioDescRef.current}
          onAccept={handleIntercambioAccept}
          onCancel={() => {
            console.log("[EnvaseOp] ❌ Modal cancelado por usuario");
            setIntercambioModalOpen(false);
          }}
        />
      )}

      <PrestamoEnvaseModal
        visible={prestamoModalOpen}
        clienteNombre={selectedClient?.nombre || ""}
        cantidad={parseInt(cantidad, 10) || 1}
        onAccept={handlePrestamoAccept}
        onCancel={() => setPrestamoModalOpen(false)}
      />
    </SafeAreaView>
  );
}

function PayChipEnvase({
  label,
  selected,
  onPress,
  disabled,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[styles.chip, selected && styles.chipSelected, disabled && styles.chipDisabled]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
    paddingTop: Platform.OS === "android" ? StatusBar.currentHeight || 0 : 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    backgroundColor: COLORS.background,
  },
  backBtn: {
    padding: SPACING.xs,
    marginRight: SPACING.s,
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: "700",
    color: COLORS.textPrimary,
  },
  resetBtn: {
    padding: SPACING.xs,
  },

  // Step indicator
  stepIndicator: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: SPACING.m,
    paddingHorizontal: SPACING.xl,
  },
  stepDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: COLORS.border,
  },
  stepDotActive: {
    backgroundColor: COLORS.primary,
    width: 14,
    height: 14,
    borderRadius: 7,
  },
  stepLine: {
    flex: 1,
    height: 2,
    backgroundColor: COLORS.border,
    marginHorizontal: SPACING.xs,
  },
  stepLineActive: {
    backgroundColor: COLORS.primary,
  },

  // Content
  contentContainer: {
    flex: 1,
    paddingHorizontal: SPACING.l,
    paddingTop: SPACING.m,
  },
  stepTitle: {
    ...TYPOGRAPHY.h2,
    color: COLORS.primary,
    marginBottom: SPACING.xs,
  },
  stepSubtitle: {
    ...TYPOGRAPHY.body,
    color: COLORS.textSecondary,
    marginBottom: SPACING.l,
  },

  // Operation cards
  operationCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.background,
    borderRadius: BORDER_RADIUS.m,
    padding: SPACING.l,
    marginBottom: SPACING.m,
    borderWidth: 1,
    borderColor: COLORS.border,
    ...SHADOWS.medium,
  },
  operationIconContainer: {
    width: 60,
    height: 60,
    borderRadius: BORDER_RADIUS.m,
    justifyContent: "center",
    alignItems: "center",
    marginRight: SPACING.m,
  },
  operationTextContainer: {
    flex: 1,
  },
  operationTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: COLORS.textPrimary,
    marginBottom: 4,
  },
  operationDesc: {
    fontSize: 13,
    color: COLORS.textSecondary,
    lineHeight: 18,
  },

  // Client selection
  clientContainer: {
    flex: 1,
    paddingHorizontal: SPACING.m,
    paddingTop: SPACING.m,
  },
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.s,
    paddingHorizontal: SPACING.m,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: SPACING.s,
  },
  searchInput: {
    flex: 1,
    paddingVertical: SPACING.s + 2,
    paddingHorizontal: SPACING.s,
    fontSize: 15,
    color: COLORS.textPrimary,
  },
  clearButton: {
    padding: SPACING.xs,
  },
  clearButtonText: {
    fontSize: 16,
    color: COLORS.muted,
    fontWeight: "bold",
  },
  resultCount: {
    fontSize: 12,
    color: COLORS.muted,
    marginBottom: SPACING.s,
    paddingHorizontal: SPACING.xs,
  },
  clientList: {
    flex: 1,
  },
  clientRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.background,
    borderRadius: BORDER_RADIUS.s,
    padding: SPACING.m,
    marginBottom: SPACING.xs,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  clientAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.primary,
    justifyContent: "center",
    alignItems: "center",
    marginRight: SPACING.m,
  },
  clientAvatarText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "bold",
  },
  clientName: {
    fontSize: 15,
    fontWeight: "600",
    color: COLORS.textPrimary,
  },
  clientId: {
    fontSize: 12,
    color: COLORS.muted,
    marginTop: 2,
  },
  creditBadge: {
    fontSize: 11,
    color: COLORS.success,
    fontWeight: "700",
    backgroundColor: "#E8F5E9",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    overflow: "hidden",
  },
  emptyContainer: {
    paddingVertical: SPACING.xl,
    alignItems: "center",
  },
  emptyText: {
    color: COLORS.muted,
    fontSize: 14,
  },

  // Tabs
  tabBar: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    marginBottom: SPACING.m,
  },
  tabItem: {
    flex: 1,
    paddingVertical: SPACING.s + 2,
    alignItems: "center",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabItemActive: {
    borderBottomColor: COLORS.primary,
  },
  tabItemText: {
    fontSize: 14,
    fontWeight: "600",
    color: COLORS.textSecondary,
  },
  tabItemTextActive: {
    color: COLORS.primary,
    fontWeight: "700",
  },

  // Refresh coords button
  refreshCoordsBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.primary,
    borderRadius: BORDER_RADIUS.s,
    paddingVertical: SPACING.s,
    paddingHorizontal: SPACING.m,
    marginBottom: SPACING.s,
    gap: SPACING.xs,
  },
  refreshCoordsBtnText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
  },
  coordsInfo: {
    fontSize: 11,
    color: COLORS.muted,
    textAlign: "center",
    marginBottom: SPACING.s,
  },
  distanceText: {
    fontSize: 11,
    color: COLORS.primary,
    marginTop: 2,
    fontWeight: "600",
  },

  // Selected client card
  selectedClientCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.m,
    padding: SPACING.l,
    marginBottom: SPACING.l,
    borderLeftWidth: 4,
    borderLeftColor: COLORS.primary,
  },
  selectedClientIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: COLORS.primaryLight,
    justifyContent: "center",
    alignItems: "center",
    marginRight: SPACING.m,
  },
  selectedClientLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: COLORS.muted,
    letterSpacing: 0.5,
  },
  selectedClientName: {
    fontSize: 17,
    fontWeight: "700",
    color: COLORS.textPrimary,
    marginTop: 2,
  },
  selectedClientId: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 1,
  },

  // Quantity
  quantitySection: {
    marginBottom: SPACING.l,
  },
  quantityLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: COLORS.textPrimary,
    marginBottom: SPACING.s,
    letterSpacing: 0.5,
  },
  quantityRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: SPACING.m,
  },
  qtyBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: COLORS.primary,
    justifyContent: "center",
    alignItems: "center",
    ...SHADOWS.small,
  },
  qtyBtnText: {
    color: "#fff",
    fontSize: 26,
    fontWeight: "bold",
    lineHeight: 28,
  },
  qtyInput: {
    width: 80,
    height: 52,
    textAlign: "center",
    fontSize: 24,
    fontWeight: "700",
    color: COLORS.textPrimary,
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.s,
    borderWidth: 1,
    borderColor: COLORS.border,
  },

  // Continue button
  continueBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.primary,
    borderRadius: BORDER_RADIUS.m,
    paddingVertical: SPACING.m + 2,
    gap: SPACING.s,
    ...SHADOWS.medium,
  },
  continueBtnText: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "700",
  },

  // Payment
  paymentSection: {
    marginBottom: SPACING.l,
  },
  payRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: SPACING.s,
    marginTop: SPACING.s,
  },
  chip: {
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    borderRadius: BORDER_RADIUS.m,
    marginRight: SPACING.s,
    backgroundColor: COLORS.background,
  },
  chipSelected: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
    ...SHADOWS.small,
  },
  chipDisabled: { opacity: 0.4 },
  chipText: { color: COLORS.textSecondary, fontWeight: "500" },
  chipTextSelected: { color: "#fff", fontWeight: "700" },
  continueBtnDisabled: {
    backgroundColor: COLORS.border,
    opacity: 0.6,
  },

  // Processing
  processingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: SPACING.m,
  },
  processingText: {
    fontSize: 16,
    color: COLORS.textSecondary,
  },
});
