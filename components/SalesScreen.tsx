import React, { useMemo, useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Modal,
  TextInput,
  Alert,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { Icon } from "react-native-elements";
import TicketPrinter from "../services/TicketPrinter";
import BluetoothPrinterService from "../services/BluetoothPrinterService";
import FullSyncService from "../services/FullSyncService";
import AuthService, { Usuario } from "../services/AuthService";
import LocationService, { LocationCoordinates } from "../services/LocationService";
import { APP_NAME, COLORS, SPACING, SHADOWS, BORDER_RADIUS, TYPOGRAPHY } from "../theme/theme";

type Cliente = {
  id: number;
  nombre: string;
  credito?: boolean;
  idGrupo?: number;
  listaPrecio?: number;
};

type Producto = {
  id: number;
  claveProd: string;
  descripcion: string;
  precio: number;
  existencia: number;
  esKit?: boolean;
  usandoPrecioDefault?: boolean;
  esPromocion?: boolean;
};

type CartItem = Producto & { cantidad: number };

export default function SalesScreen() {
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [productos, setProductos] = useState<Producto[]>([]);
  const [filteredClientes, setFilteredClientes] = useState<Cliente[]>([]);
  const [filteredProductos, setFilteredProductos] = useState<Producto[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchProductoQuery, setSearchProductoQuery] = useState("");
  const [showOnlyPromotions, setShowOnlyPromotions] = useState(false);

  const [clienteModalOpen, setClienteModalOpen] = useState(false);
  const [productoModalOpen, setProductoModalOpen] = useState(false);

  const [selectedClient, setSelectedClient] = useState<Cliente | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [quantityInputs, setQuantityInputs] = useState<{ [id: number]: string }>({});

  const [metodoPago, setMetodoPago] = useState<"efectivo" | "transferencia" | "credito" | "cupon" | null>(null);
  const [printerConnected, setPrinterConnected] = useState(false);
  const [printerName, setPrinterName] = useState<string>("");
  const [currentUser, setCurrentUser] = useState<Usuario | null>(null);
  const [currentSucursal, setCurrentSucursal] = useState<number>(1);
  const [initializingPrinter, setInitializingPrinter] = useState(true);
  const [kits, setKits] = useState<any[]>([]);
  const [productosBase, setProductosBase] = useState<any[]>([]);
  const [processingVenta, setProcessingVenta] = useState(false);

  const buildProductosFormateados = useCallback(
    (
      preciosSource: any[],
      productosData: any[],
      inventarioData: any[],
      kitsData: any[],
      preciosDefault?: any[],
      preciosPromo?: any[]
    ): Producto[] => {
      // Mapa de precios promocionales (PRIMERA JERARQUÍA)
      const preciosPromoMap = new Map<number, number>();
      if (preciosPromo) {
        preciosPromo.forEach((p: any) => {
          const clave = p.claveProd !== undefined && p.claveProd !== null ? parseInt(p.claveProd, 10) : NaN;
          if (Number.isNaN(clave)) return;
          preciosPromoMap.set(clave, p.precio || 0);
        });
      }

      // Mapa de precios por claveProd de la lista del cliente (SEGUNDA JERARQUÍA)
      const preciosMap = new Map<number, number>();
      preciosSource.forEach((p: any) => {
        const clave = p.claveProd !== undefined && p.claveProd !== null ? parseInt(p.claveProd, 10) : NaN;
        if (Number.isNaN(clave)) return;
        preciosMap.set(clave, p.precio || 0);
      });

      // Mapa de precios por defecto (lista 13 - DOMIC.) (TERCERA JERARQUÍA)
      const preciosDefaultMap = new Map<number, number>();
      if (preciosDefault) {
        preciosDefault.forEach((p: any) => {
          const clave = p.claveProd !== undefined && p.claveProd !== null ? parseInt(p.claveProd, 10) : NaN;
          if (Number.isNaN(clave)) return;
          preciosDefaultMap.set(clave, p.precio || 0);
        });
      }

      // Productos por id y por claveProd para lookup de esKit / descripcion / clave
      const productosPorId = new Map<number, any>();
      const productosPorClave = new Map<number, any>();
      productosData.forEach((p: any) => {
        productosPorId.set(p.id, p);
        const clave = p.claveProd !== undefined && p.claveProd !== null ? parseInt(p.claveProd, 10) : NaN;
        if (!Number.isNaN(clave)) {
          productosPorClave.set(clave, p);
        }
      });

      // Inventario por claveProd de la sucursal actual
      const inventarioPorClave = new Map<number, number>();
      inventarioData
        .filter((i: any) => i.sucursal == currentSucursal && i.id < 10000)
        .forEach((i: any) => {
          const clave = i.claveProd;
          if (clave === null || clave === undefined) return;
          const saldoActual = inventarioPorClave.get(clave) || 0;
          inventarioPorClave.set(clave, saldoActual + (i.saldo || 0));
        });

      // Kits por idProducto
      const kitsPorProducto = new Map<number, any[]>();
      kitsData.forEach((k: any) => {
        if (k.idProducto === null || k.idProducto === undefined) return;
        const arr = kitsPorProducto.get(k.idProducto) || [];
        arr.push(k);
        kitsPorProducto.set(k.idProducto, arr);
      });

      const calcularExistencia = (productoId: number | undefined, claveProd: number | undefined, esKit: boolean) => {
        if (esKit && productoId !== undefined) {
          const componentes = kitsPorProducto.get(productoId) || [];
          if (!componentes.length) return 0;
          let minimo = Infinity;

          for (const comp of componentes) {
            const cantidadInsumo = comp.cantidad ? Number(comp.cantidad) : 0;
            if (cantidadInsumo <= 0) {
              minimo = 0;
              break;
            }

            // idInsumo ES directamente el clave_prod del inventario
            const claveInsumo = comp.idInsumo;
            if (claveInsumo === null || claveInsumo === undefined) {
              minimo = 0;
              break;
            }

            const saldo = inventarioPorClave.get(claveInsumo) || 0;
            const posible = Math.floor(saldo / cantidadInsumo);
            minimo = Math.min(minimo, posible);
          }

          return minimo === Infinity ? 0 : minimo;
        }

        if (claveProd === undefined || Number.isNaN(claveProd)) return 0;
        return inventarioPorClave.get(claveProd) || 0;
      };

      // Crear un Set de todas las claves de productos disponibles
      const todasLasClaves = new Set<number>();
      preciosSource.forEach((p: any) => {
        const clave = p.claveProd !== undefined && p.claveProd !== null ? parseInt(p.claveProd, 10) : NaN;
        if (!Number.isNaN(clave)) todasLasClaves.add(clave);
      });
      if (preciosDefault) {
        preciosDefault.forEach((p: any) => {
          const clave = p.claveProd !== undefined && p.claveProd !== null ? parseInt(p.claveProd, 10) : NaN;
          if (!Number.isNaN(clave)) todasLasClaves.add(clave);
        });
      }

      // Agregar claves de precios promocionales
      if (preciosPromo) {
        preciosPromo.forEach((p: any) => {
          const clave = p.claveProd !== undefined && p.claveProd !== null ? parseInt(p.claveProd, 10) : NaN;
          if (!Number.isNaN(clave)) todasLasClaves.add(clave);
        });
      }

      // Mapear todos los productos disponibles
      return Array.from(todasLasClaves).map((claveNum) => {
        const productoBase = productosPorClave.get(claveNum) || productosPorId.get(claveNum);
        const esKit = Boolean(productoBase?.esKit);
        const productoId = productoBase?.id ?? claveNum;
        const descripcion = productoBase?.descripcion || "Sin descripción";

        // JERARQUÍA DE PRECIOS:
        // 1. Precio promocional (PrecioPromo)
        // 2. Precio de lista del cliente (Precio)
        // 3. Precio por defecto (lista 13 - DOMIC.)
        let precio: number | undefined;
        let usandoPrecioDefault = false;
        let esPromocion = false;

        // Primera jerarquía: Precio promocional
        if (preciosPromoMap.has(claveNum)) {
          precio = preciosPromoMap.get(claveNum);
          esPromocion = true;
        }
        // Segunda jerarquía: Precio de lista del cliente
        else if (preciosMap.has(claveNum)) {
          precio = preciosMap.get(claveNum);
        }
        // Tercera jerarquía: Precio por defecto
        else if (preciosDefaultMap.has(claveNum)) {
          precio = preciosDefaultMap.get(claveNum);
          usandoPrecioDefault = true;
        }

        if (precio === undefined) precio = 0;

        const existencia = calcularExistencia(productoId, claveNum, esKit);

        return {
          id: productoId,
          claveProd: (productoBase?.claveProd || claveNum).toString(),
          descripcion,
          precio,
          existencia,
          esKit,
          usandoPrecioDefault,
          esPromocion,
        };
      });
    },
    [currentSucursal]
  );

  useEffect(() => {
    const init = async () => {
      setInitializingPrinter(true);

      try {
        let status = BluetoothPrinterService.getStatus();
        if (!status.connected) {
          await BluetoothPrinterService.connectToSavedPrinter();
        }

        status = BluetoothPrinterService.getStatus();
        setPrinterConnected(status.connected);
        setPrinterName(status.printer?.name || "");

        const user = await AuthService.restoreSession();
        if (user) {
          setCurrentUser(user);
          const vendedor = (user.claveEmpleado as string | undefined) || (user.nombre as string | undefined) || "";
          const sucursal =
            (user.sucursal_origen as number | null | undefined) ?? (user.sucursal as number | null | undefined) ?? 1;
          setCurrentSucursal(sucursal);
        }

        await loadDataFromRealm();
      } finally {
        setInitializingPrinter(false);
      }
    };

    init();
  }, []);

  const loadDataFromRealm = async () => {
    try {
      await FullSyncService.initialize();

      // Cargar clientes
      const clientesData = FullSyncService.getClientesFull(10000);
      const clientesFormateados = clientesData.map((c: any) => ({
        id: c.id,
        nombre: c.nombre || "Sin nombre",
        credito: c.credito || false,
        idGrupo: c.idGrupo,
        listaPrecio: c.listaPrecio,
      }));
      setClientes(clientesFormateados);
      setFilteredClientes(clientesFormateados);

      // Cargar clientes con precios
      const productosData = FullSyncService.getProductos(1000);
      const preciosData = FullSyncService.getPrecios(5000);
      const preciosPromoData = FullSyncService.getPreciosPromo(5000);
      const inventarioData = FullSyncService.getInventario();
      const kitsData = FullSyncService.getKits(5000);

      setProductosBase(productosData);
      setKits(kitsData);

      const productosFormateados = buildProductosFormateados(
        preciosData,
        productosData,
        inventarioData,
        kitsData,
        undefined,
        preciosPromoData
      ).filter((p) => p.existencia > 0);

      setProductos(productosFormateados);
      // Por defecto mostrar solo productos normales (sin kits ni promociones)
      setFilteredProductos(productosFormateados.filter((p) => !p.esKit && !p.esPromocion));
    } catch (error) {
      console.error("Error al cargar datos de Realm:", error);
      Alert.alert("Error", "No se pudieron cargar los datos. Sincroniza primero.");
    }
  };

  const handleSearchCliente = useCallback(
    (query: string) => {
      setSearchQuery(query);

      if (!query.trim()) {
        setFilteredClientes(clientes);
        return;
      }

      const lowerQuery = query.toLowerCase();
      const filtered = clientes.filter(
        (c) => c.nombre.toLowerCase().includes(lowerQuery) || c.id.toString().includes(query)
      );

      setFilteredClientes(filtered);
    },
    [clientes]
  );

  const handleSearchProducto = useCallback(
    (query: string) => {
      setSearchProductoQuery(query);

      let baseProducts = productos;
      if (showOnlyPromotions) {
        baseProducts = productos.filter((p) => p.esKit || p.esPromocion);
      } else {
        baseProducts = productos.filter((p) => !p.esKit && !p.esPromocion);
      }

      if (!query.trim()) {
        setFilteredProductos(baseProducts);
        return;
      }

      const lowerQuery = query.toLowerCase();
      const filtered = baseProducts.filter((p) => {
        const matchDesc = p.descripcion.toLowerCase().includes(lowerQuery);
        const matchClave = p.claveProd?.toString().toLowerCase().includes(lowerQuery);
        const matchId = p.id.toString().includes(query);
        return matchDesc || matchClave || matchId;
      });

      setFilteredProductos(filtered);
    },
    [productos, showOnlyPromotions]
  );

  const togglePromotions = () => {
    const newValue = !showOnlyPromotions;
    setShowOnlyPromotions(newValue);

    let baseProducts = productos;
    if (newValue) {
      baseProducts = productos.filter((p) => p.esKit || p.esPromocion);
    } else {
      baseProducts = productos.filter((p) => !p.esKit && !p.esPromocion);
    }

    if (!searchProductoQuery.trim()) {
      setFilteredProductos(baseProducts);
    } else {
      const lowerQuery = searchProductoQuery.toLowerCase();
      const filtered = baseProducts.filter((p) => {
        const matchDesc = p.descripcion.toLowerCase().includes(lowerQuery);
        const matchClave = p.claveProd?.toString().toLowerCase().includes(lowerQuery);
        const matchId = p.id.toString().includes(searchProductoQuery);
        return matchDesc || matchClave || matchId;
      });
      setFilteredProductos(filtered);
    }
  };

  const total = useMemo(() => cart.reduce((acc, it) => acc + it.precio * it.cantidad, 0), [cart]);

  const addToCart = (p: Producto) => {
    setCart((prev) => {
      const idx = prev.findIndex((ci) => ci.id === p.id);
      if (idx >= 0) {
        const cp = [...prev];
        cp[idx] = { ...cp[idx], cantidad: cp[idx].cantidad + 1 };
        return cp;
      }
      return [...prev, { ...p, cantidad: 1 }];
    });
    setProductoModalOpen(false);
  };

  const updateQuantity = (id: number, cantidad: number) => {
    if (cantidad <= 0) {
      console.warn(`[Sales] ⚠️ Intento de actualizar cantidad a ${cantidad} para producto ${id}, bloqueado`);
      return;
    }
    console.log(`[Sales] Actualizando cantidad de producto ${id} a ${cantidad}`);
    setCart((prev) => prev.map((ci) => (ci.id === id ? { ...ci, cantidad } : ci)));
  };

  const removeFromCart = (id: number) => {
    console.log(`[Sales] 🗑️ Eliminando producto ${id} del carrito`);
    setCart((prev) => prev.filter((ci) => ci.id !== id));
  };

  const buildMovilSaleId = (sucursal: number): number => {
    const suffix = sucursal.toString().padStart(3, "0");
    const base = Date.now().toString();
    return Number(`${base}${suffix}`);
  };

  useEffect(() => {
    if (selectedClient) {
      // Usar listaPrecio del cliente para buscar precios, si no tiene usar 0 (precio general)
      const listaPrecios = selectedClient.listaPrecio ?? 0;
      console.log("[DEBUG] Cliente seleccionado:", {
        id: selectedClient.id,
        nombre: selectedClient.nombre,
        listaPrecio: selectedClient.listaPrecio,
        listaPreciosUsado: listaPrecios,
      });

      // Buscar precios promocionales para el cliente
      const preciosPromo = FullSyncService.getPreciosPromoByCliente(selectedClient.id);

      // Buscar precios por listaPrecio en lugar de idCliente
      const preciosCliente = FullSyncService.getPreciosByListaPrecio(listaPrecios);
      const preciosDefault = FullSyncService.getPreciosByListaPrecio(13); // Lista DOMIC.

      console.log("[DEBUG] Precios promocionales para cliente:", preciosPromo.length);
      console.log("[DEBUG] Precios encontrados para listaPrecio=" + listaPrecios + ":", preciosCliente.length);
      console.log("[DEBUG] Precios por defecto (lista 13 - DOMIC.):", preciosDefault.length);
      if (preciosCliente.length > 0) {
        console.log("[DEBUG] Ejemplo precio:", preciosCliente[0]);
      }

      // También mostrar todos los precios disponibles para debug
      const todosPrecios = FullSyncService.getPrecios(100);
      console.log("[DEBUG] Total precios en Realm (primeros 100):", todosPrecios.length);
      if (todosPrecios.length > 0) {
        console.log("[DEBUG] Ejemplo de listaPrecio disponibles:", [
          ...new Set(todosPrecios.map((p: any) => p.listaPrecio)),
        ]);
      }

      const inventario = FullSyncService.getInventario();
      const productosData = productosBase.length ? productosBase : FullSyncService.getProductos(1000);
      const kitsData = kits.length ? kits : FullSyncService.getKits(5000);

      console.log("[DEBUG] Datos cargados:", {
        preciosPromo: preciosPromo.length,
        preciosCliente: preciosCliente.length,
        preciosDefault: preciosDefault.length,
        inventario: inventario.length,
        productosData: productosData.length,
        kitsData: kitsData.length,
      });

      const productosFormateados = buildProductosFormateados(
        preciosCliente,
        productosData,
        inventario,
        kitsData,
        preciosDefault,
        preciosPromo
      ).filter((p) => p.existencia > 0);
      console.log("[DEBUG] Productos formateados (con existencia > 0):", productosFormateados.length);
      setProductos(productosFormateados);

      // Aplicar filtro de kits según el estado del botón
      const productosFiltrados = showOnlyPromotions
        ? productosFormateados.filter((p) => p.esKit || p.esPromocion)
        : productosFormateados.filter((p) => !p.esKit && !p.esPromocion);
      setFilteredProductos(productosFiltrados);
    }
  }, [selectedClient, buildProductosFormateados, productosBase, kits, showOnlyPromotions]);

  const processSale = async () => {
    // Protección contra doble-clic
    if (processingVenta) {
      console.log("[Sales] ⚠️ Venta ya en proceso, ignorando clic duplicado");
      return;
    }

    // BLOQUEAR INMEDIATAMENTE para prevenir múltiples clics
    setProcessingVenta(true);

    const client = selectedClient;
    if (!client) {
      Alert.alert("Error", "Selecciona un cliente");
      setProcessingVenta(false);
      return;
    }
    if (!cart.length) {
      Alert.alert("Error", "Agrega productos al carrito");
      setProcessingVenta(false);
      return;
    }
    if (!metodoPago) {
      Alert.alert("Error", "Selecciona un método de pago");
      setProcessingVenta(false);
      return;
    }

    // Verificar que la ubicación GPS esté activa antes de procesar la venta
    console.log("[Sales] 📍 Verificando disponibilidad de ubicación GPS...");
    try {
      const locationAvailable = await LocationService.getCurrentLocation();
      if (!locationAvailable) {
        console.error("[Sales] ❌ Ubicación GPS no disponible");
        Alert.alert(
          "Ubicación Requerida",
          "No se puede procesar la venta sin acceso a la ubicación GPS. Por favor activa la ubicación en tu dispositivo e intenta de nuevo."
        );
        setProcessingVenta(false);
        return;
      }
      console.log("[Sales] ✅ Ubicación GPS disponible:", locationAvailable);
    } catch (locationError) {
      console.error("[Sales] ❌ Error al verificar ubicación GPS:", locationError);
      Alert.alert(
        "Ubicación Requerida",
        "No se puede procesar la venta sin acceso a la ubicación GPS. Por favor activa la ubicación en tu dispositivo e intenta de nuevo."
      );
      setProcessingVenta(false);
      return;
    }

    // Procesar inputs pendientes antes de validar
    // (en caso de que el usuario no haya salido del campo de cantidad)
    console.log("[Sales] 🔄 Procesando inputs de cantidad pendientes...");
    const updatedCart = cart.filter((item) => {
      const pendingInput = quantityInputs[item.id];

      // Si hay input pendiente, procesarlo
      if (pendingInput !== undefined) {
        console.log(`[Sales] Input pendiente para producto ${item.id}: "${pendingInput}"`);
        if (!pendingInput || pendingInput === "0") {
          console.log(`[Sales] Eliminando producto ${item.id} por cantidad 0 en input pendiente`);
          return false; // Eliminar del carrito
        }
        const n = parseInt(pendingInput, 10);
        if (!Number.isNaN(n) && n > 0) {
          item.cantidad = n; // Actualizar cantidad
          console.log(`[Sales] Actualizando cantidad de producto ${item.id} a ${n} desde input pendiente`);
        } else {
          // Input inválido, eliminar
          console.warn(`[Sales] Input inválido "${pendingInput}" para producto ${item.id}, eliminando`);
          return false;
        }
      }

      // Verificar cantidad actual del item (con o sin input pendiente)
      if (item.cantidad <= 0) {
        console.warn(`[Sales] Eliminando producto ${item.id} con cantidad ${item.cantidad}`);
        return false;
      }

      return true; // Mantener en carrito
    });

    if (updatedCart.length === 0) {
      Alert.alert("Error", "No hay productos en el carrito");
      return;
    }

    // Validar datos del carrito
    console.log(
      "[Sales] 🔍 Validando carrito antes de procesar:",
      updatedCart.map((i) => ({
        id: i.id,
        descripcion: i.descripcion,
        cantidad: i.cantidad,
        precio: i.precio,
      }))
    );

    const invalidItems = updatedCart.filter(
      (item) => !item.id || item.cantidad <= 0 || item.precio < 0 || !item.descripcion
    );
    if (invalidItems.length > 0) {
      console.error(
        "[Sales] ❌ Items inválidos en carrito:",
        invalidItems.map((i) => ({
          id: i.id,
          descripcion: i.descripcion,
          cantidad: i.cantidad,
          precio: i.precio,
          razon: !i.id
            ? "sin id"
            : i.cantidad <= 0
            ? "cantidad <= 0"
            : i.precio < 0
            ? "precio negativo"
            : "sin descripción",
        }))
      );
      Alert.alert(
        "Error",
        `Hay productos con datos inválidos en el carrito:\n${invalidItems
          .map((i) => `- ${i.descripcion || "Sin nombre"}: cantidad=${i.cantidad}, precio=${i.precio}`)
          .join("\n")}`
      );
      return;
    }

    // Validar inventario suficiente
    const insufficientStock = updatedCart.filter((item) => item.existencia < item.cantidad);
    if (insufficientStock.length > 0) {
      console.warn("[Sales] ⚠️ Inventario insuficiente:", insufficientStock);
      Alert.alert(
        "Inventario Insuficiente",
        `Los siguientes productos no tienen suficiente inventario:\n${insufficientStock
          .map((i) => `- ${i.descripcion} (disponible: ${i.existencia}, solicitado: ${i.cantidad})`)
          .join("\n")}`
      );
      setProcessingVenta(false);
      return;
    }

    // Actualizar el carrito con los cambios procesados
    if (updatedCart.length !== cart.length) {
      console.log(
        `[Sales] ⚠️ Se eliminaron ${cart.length - updatedCart.length} productos con cantidad 0 desde inputs pendientes`
      );
      setCart(updatedCart);
    }

    // Limpiar inputs pendientes
    setQuantityInputs({});

    // Recalcular total con el carrito actualizado
    const updatedTotal = updatedCart.reduce((acc, item) => acc + item.precio * item.cantidad, 0);

    console.log("[Sales] 🚀 Iniciando proceso de venta", {
      cliente: client.nombre,
      items: updatedCart.length,
      totalOriginal: total,
      totalActualizado: updatedTotal,
      metodoPago,
    });

    let ventasCreadas = false;
    let inventarioActualizado = false;

    try {
      const sucursal = currentSucursal || 1;
      const saleIdMovil = buildMovilSaleId(sucursal);
      const inventarioBaseId = buildMovilSaleId(sucursal);
      const tipoPagoCode = metodoPago === "efectivo" ? 1 : metodoPago == "cupon" ? 4 : metodoPago === "credito" ? 3 : 2; // transferencia
      const descripcionMedioPago =
        metodoPago === "efectivo"
          ? "Efectivo"
          : metodoPago === "cupon"
          ? "Cupon"
          : metodoPago === "credito"
          ? "Credito"
          : "Transferencia";
      const vendedor =
        (currentUser?.claveEmpleado as string | undefined) || (currentUser?.nombre as string | undefined) || "";
      const now = new Date();

      // Filtrar productos con cantidad válida (última línea de defensa)
      const validCart = updatedCart.filter((item) => item.cantidad > 0);
      if (validCart.length !== updatedCart.length) {
        console.error(
          "[Sales] ⚠️ Se detectaron productos con cantidad 0 que pasaron la validación inicial:",
          updatedCart.filter((item) => item.cantidad <= 0)
        );
      }

      if (validCart.length === 0) {
        console.error("[Sales] ❌ No hay productos válidos para procesar");
        Alert.alert("Error", "No hay productos válidos en el carrito");
        return;
      }

      // Obtener coordenadas GPS para la venta
      console.log("[Sales] 📍 Obteniendo ubicación GPS...");
      let coordinates: LocationCoordinates | null = null;
      try {
        coordinates = await LocationService.getCurrentLocation();
        if (coordinates) {
          console.log("[Sales] ✅ Ubicación obtenida:", coordinates);
        } else {
          console.warn("[Sales] ⚠️ No se pudo obtener la ubicación GPS");
        }
      } catch (locationError) {
        console.error("[Sales] ⚠️ Error al obtener ubicación (no crítico):", locationError);
      }

      // Intentar imprimir ticket (no crítico si falla)
      let ticketImpreso = false;
      try {
        await TicketPrinter.printSaleTicket({
          clientName: client.nombre,
          paymentMethod: metodoPago,
          items: validCart.map((item) => ({
            description: item.descripcion,
            quantity: item.cantidad,
            price: item.precio,
            total: item.precio * item.cantidad,
          })),
          total: updatedTotal,
          businessName: APP_NAME,
          date: now,
          ticketNumber: String(saleIdMovil),
          sellerName: vendedor,
          branch: sucursal,
        });
        ticketImpreso = true;
        console.log("[Sales] ✅ Ticket impreso correctamente");
      } catch (printError) {
        console.error("[Sales] ⚠️ Error al imprimir ticket (no crítico):", printError);
        // Continuar con la venta aunque falle la impresión
      }

      // Crear ventas locales (operación crítica)
      console.log("[Sales] 💾 Guardando ventas en base de datos local...");
      await FullSyncService.createLocalVentas(
        validCart.map((item, index) => ({
          id: saleIdMovil + index,
          sucursal,
          noVenta: 0,
          idMovil: saleIdMovil,
          claveProd: item.id, // Usar el id del producto, no claveProd
          nombreProducto: item.descripcion,
          cantProducto: item.cantidad,
          precio: parseFloat(item.precio.toString()) || 0,
          importe: parseFloat((item.precio * item.cantidad).toString()) || 0,
          cveCliente: client.id,
          nombreCliente: client.nombre,
          fecha: now,
          tipoPago: tipoPagoCode,
          descripcionMedioPago,
          vendedor,
          folioFactura: false,
          facturacionMovil: false,
          latitud: coordinates?.latitude ?? null,
          longitud: coordinates?.longitude ?? null,
        }))
      );
      ventasCreadas = true;
      console.log("[Sales] ✅ Ventas locales creadas exitosamente");

      // Actualizar inventario restando las cantidades vendidas (operación crítica)
      const inventarioUpdateItems = validCart.map((item) => ({
        sucursal,
        claveProd: parseInt(item.claveProd || "0", 10), // Código del producto para buscar en inventario
        cantidad: item.cantidad,
        esKit: item.esKit || false,
        idProducto: item.id, // ID del producto para buscar componentes de kits
      }));
      console.log("[Sales] DEBUG - Updating inventory after sale", {
        rows: validCart.length,
        sucursal,
        items: inventarioUpdateItems.map((i) => ({
          claveProd: i.claveProd,
          cantidad: i.cantidad,
          esKit: i.esKit,
          idProducto: i.idProducto,
        })),
        cartRaw: validCart.map((c) => ({
          id: c.id,
          claveProd: c.claveProd,
          claveProdType: typeof c.claveProd,
          esKit: c.esKit,
          cantidad: c.cantidad,
        })),
      });
      console.log("[Sales] 📦 Actualizando inventario...");
      await FullSyncService.updateInventarioAfterSaleScreen(inventarioUpdateItems);
      inventarioActualizado = true;
      console.log("[Sales] ✅ Inventario actualizado exitosamente");

      // Intentar enviar ventas con timeout de 3 segundos
      try {
        const idUsuarioRaw = (currentUser as any)?.idUsuario ?? (currentUser as any)?.id ?? 1;
        const idUsuario = Number.isFinite(Number(idUsuarioRaw)) ? Number(idUsuarioRaw) : 1;

        console.log("[Sales] Iniciando arrastre de ventas con timeout de 3s...");
        const result = await FullSyncService.sendPendingVentasWithTimeout(
          sucursal,
          idUsuario,
          3000 // 3 segundos de timeout
        );

        if (result.timedOut) {
          console.log("[Sales] ⏱️ Arrastre omitido por timeout, se enviará en sincronización automática");
        } else if (result.success) {
          console.log("[Sales] ✅ Ventas arrastre enviadas:", result.sent);
        } else {
          console.error("[Sales] ❌ Error en arrastre:", result.error);
        }
      } catch (arrastreError) {
        console.error("[Sales] Error en arrastre (no crítico):", arrastreError);
      }

      // Actualizar estado de impresora
      const status = BluetoothPrinterService.getStatus();
      setPrinterConnected(status.connected);

      if (status.connected) {
        Alert.alert(
          "🖨️ Venta Procesada",
          `Cliente: ${client.nombre}\nTotal: $${updatedTotal.toFixed(2)}\nPago: ${metodoPago}\n\nTicket enviado a: ${
            status.printer?.name
          }`
        );
      } else {
        Alert.alert(
          "✅ Venta Procesada",
          `Cliente: ${client.nombre}\nTotal: $${updatedTotal.toFixed(2)}\nPago: ${metodoPago}`
        );
      }

      // Limpiar formulario
      setCart([]);
      setMetodoPago(null);
      setSelectedClient(null);

      console.log("[Sales] ✅ Venta procesada completamente", {
        ventasCreadas,
        inventarioActualizado,
        ticketImpreso,
      });
    } catch (error) {
      console.error("[Sales] ❌ Error crítico en processSale:", error);

      // Determinar tipo de error
      const errorMsg = error instanceof Error ? error.message : "Error desconocido";
      const isNetworkError = errorMsg.includes("network") || errorMsg.includes("fetch");
      const isDatabaseError = errorMsg.includes("realm") || errorMsg.includes("database");

      console.error("[Sales] Estado de la operación:", {
        ventasCreadas,
        inventarioActualizado,
        errorType: isNetworkError ? "red" : isDatabaseError ? "base de datos" : "desconocido",
      });

      // Mensaje de error específico
      let userMessage = "No se pudo procesar la venta.";
      if (ventasCreadas && !inventarioActualizado) {
        userMessage += "\n\n⚠️ La venta se registró pero el inventario no se actualizó. Contacta al administrador.";
      } else if (isNetworkError) {
        userMessage += "\n\nProblema de conexión. La venta se guardó localmente y se sincronizará automáticamente.";
      } else if (isDatabaseError) {
        userMessage += "\n\nError en la base de datos local. Por favor intenta de nuevo.";
      }

      Alert.alert("Error al Procesar Venta", userMessage);
    } finally {
      // Desbloquear botón siempre, incluso si hay error
      setProcessingVenta(false);
    }
  };

  if (initializingPrinter) {
    return (
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color={COLORS.primary} />
            <Text style={styles.loadingText}>Preparando conexión con la impresora...</Text>
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        {/* Header con estado de impresora */}
        <View style={styles.headerRow}>
          <Text style={styles.headerTitle}>Punto de Venta</Text>
          {printerConnected && (
            <View style={styles.printerBadge}>
              <Text style={styles.printerBadgeText}>🖨️ {printerName || "OK"}</Text>
            </View>
          )}
        </View>

        {!printerConnected && (
          <View style={styles.warningCard}>
            <Text style={styles.warningIcon}>⚠️</Text>
            <Text style={styles.warningText}>Sin impresora. Los tickets se compartirán o deberás configurar una.</Text>
          </View>
        )}

        {/* Cliente */}
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.cardTitle}>Cliente</Text>
            <TouchableOpacity style={styles.smallBtn} onPress={() => setClienteModalOpen(true)}>
              <Text style={styles.smallBtnText}>Seleccionar</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.valueText}>{selectedClient ? selectedClient.nombre : "Sin seleccionar"}</Text>
        </View>

        {/* Productos */}
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.cardTitle}>Productos</Text>
            <TouchableOpacity
              style={[styles.smallBtn, !selectedClient && styles.smallBtnDisabled]}
              onPress={() => {
                selectedClient && setProductoModalOpen(true);
                setShowOnlyPromotions(false);
              }}
              disabled={!selectedClient}
            >
              <Text style={styles.smallBtnText}>Agregar</Text>
            </TouchableOpacity>
          </View>

          {cart.length === 0 ? (
            <Text style={styles.muted}>No hay productos</Text>
          ) : (
            <View style={styles.cartList}>
              {cart.map((item) => (
                <View key={item.id} style={[styles.cartRow, item.usandoPrecioDefault && styles.cartRowPrecioDefault]}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cartTitle}>{item.descripcion}</Text>
                    <Text style={[styles.muted, item.usandoPrecioDefault && styles.cartPriceDefault]}>
                      ${item.precio.toFixed(2)}
                      {item.usandoPrecioDefault && " ⚠️"}
                    </Text>
                  </View>
                  <View style={styles.qtyBox}>
                    <TextInput
                      style={styles.qtyInput}
                      keyboardType="number-pad"
                      value={quantityInputs[item.id] ?? String(item.cantidad)}
                      onChangeText={(t) => {
                        // Permitir cualquier valor mientras escribe
                        if (!/^\d*$/.test(t)) {
                          return;
                        }
                        setQuantityInputs((prev) => ({ ...prev, [item.id]: t }));
                        if (t === "") {
                          // Campo vacío, no actualizar aún
                          return;
                        }
                        const n = parseInt(t, 10);
                        if (!Number.isNaN(n) && n > 0) {
                          updateQuantity(item.id, n);
                        }
                      }}
                      onBlur={() => {
                        console.log(`[Sales] 📝 onBlur ejecutado para producto ${item.id}`);
                        // Al salir del campo, validar cantidad
                        const currentText = quantityInputs[item.id];
                        console.log(
                          `[Sales] Texto actual en input: "${currentText}", cantidad en carrito: ${item.cantidad}`
                        );
                        if (!currentText || currentText === "0") {
                          // Si está vacío o es 0, eliminar del carrito
                          console.log(`[Sales] Eliminando producto ${item.id} del carrito (cantidad 0)`);
                          removeFromCart(item.id);
                        } else {
                          const n = parseInt(currentText, 10);
                          if (!Number.isNaN(n) && n > 0) {
                            updateQuantity(item.id, n);
                          } else {
                            // Número inválido, restaurar cantidad anterior
                            console.warn(`[Sales] Cantidad inválida: ${currentText}, restaurando a ${item.cantidad}`);
                          }
                        }
                        setQuantityInputs((prev) => {
                          const next = { ...prev };
                          delete next[item.id];
                          return next;
                        });
                      }}
                    />
                  </View>
                  <Text style={styles.lineTotal}>${(item.precio * item.cantidad).toFixed(2)}</Text>
                  <TouchableOpacity style={styles.removeBtn} onPress={() => removeFromCart(item.id)}>
                    <Text style={styles.removeBtnText}>✕</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* Pago */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Pago</Text>
          <View style={styles.payRow}>
            <PayChip label="Efectivo" selected={metodoPago === "efectivo"} onPress={() => setMetodoPago("efectivo")} />
            <PayChip
              label="Transferencia"
              selected={metodoPago === "transferencia"}
              onPress={() => setMetodoPago("transferencia")}
            />
            <PayChip
              label="Crédito"
              selected={metodoPago === "credito"}
              onPress={() => setMetodoPago("credito")}
              disabled={selectedClient ? !selectedClient.credito : true}
            />
            <PayChip label="Cupon" selected={metodoPago === "cupon"} onPress={() => setMetodoPago("cupon")} />
          </View>

          <View style={styles.totalRow}>
            <Text style={styles.totalText}>Total</Text>
            <Text style={styles.totalValue}>${total.toFixed(2)}</Text>
          </View>

          <TouchableOpacity
            style={[
              styles.primaryBtn,
              (!selectedClient || !cart.length || !metodoPago || processingVenta) && styles.primaryBtnDisabled,
            ]}
            onPress={processSale}
            disabled={!selectedClient || !cart.length || !metodoPago || processingVenta}
          >
            {processingVenta ? (
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <ActivityIndicator color="#fff" size="small" style={{ marginRight: 8 }} />
                <Text style={styles.primaryBtnText}>Procesando...</Text>
              </View>
            ) : (
              <Text style={styles.primaryBtnText}>Procesar Venta</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Modal Clientes */}
        <Modal visible={clienteModalOpen} animationType="slide" transparent>
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Seleccionar Cliente</Text>

              {/* Buscador */}
              <Text style={styles.searchLabel}>Buscar cliente</Text>
              <View style={styles.searchContainer}>
                <Text style={styles.searchIcon}>🔍</Text>
                <TextInput
                  style={styles.searchInput}
                  placeholder="Buscar por nombre o ID..."
                  placeholderTextColor={COLORS.muted}
                  value={searchQuery}
                  onChangeText={handleSearchCliente}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {searchQuery.length > 0 && (
                  <TouchableOpacity onPress={() => handleSearchCliente("")} style={styles.clearButton}>
                    <Text style={styles.clearButtonText}>✕</Text>
                  </TouchableOpacity>
                )}
              </View>

              {/* Contador de resultados */}
              <Text style={styles.resultCount}>
                {filteredClientes.length} cliente
                {filteredClientes.length !== 1 ? "s" : ""}{" "}
                {filteredClientes.length === 1 ? "encontrado" : "encontrados"}
              </Text>

              <FlatList
                data={filteredClientes}
                keyExtractor={(i) => String(i.id)}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.listItem}
                    onPress={() => {
                      setSelectedClient(item);
                      setCart([]);
                      setMetodoPago(null);
                      setClienteModalOpen(false);
                      setSearchQuery("");
                      setFilteredClientes(clientes);
                      setTimeout(() => setProductoModalOpen(true), 300);
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.listTitle}>{item.nombre}</Text>
                      <Text style={styles.listSubtitle}>ID: {item.id}</Text>
                    </View>
                    {item.credito ? <Text style={styles.badge}>Crédito</Text> : null}
                  </TouchableOpacity>
                )}
                ListEmptyComponent={
                  <View style={styles.emptySearch}>
                    <Text style={styles.emptySearchText}>No se encontraron clientes</Text>
                  </View>
                }
              />
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={() => {
                  setClienteModalOpen(false);
                  setSearchQuery("");
                  setFilteredClientes(clientes);
                }}
              >
                <Text style={styles.secondaryBtnText}>Cerrar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* Modal Productos */}
        <Modal visible={productoModalOpen} animationType="slide" transparent>
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Seleccionar Producto</Text>

              {/* Buscador */}
              <Text style={styles.searchLabel}>Buscar producto</Text>
              <View style={styles.searchContainer}>
                <Text style={styles.searchIcon}>🔍</Text>
                <TextInput
                  style={styles.searchInput}
                  placeholder="Buscar por descripción o clave..."
                  placeholderTextColor={COLORS.muted}
                  value={searchProductoQuery}
                  onChangeText={handleSearchProducto}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {searchProductoQuery.length > 0 && (
                  <TouchableOpacity onPress={() => handleSearchProducto("")} style={styles.clearButton}>
                    <Text style={styles.clearButtonText}>✕</Text>
                  </TouchableOpacity>
                )}
              </View>

              {/* Contador de resultados con botón de promociones */}
              <View style={styles.resultCountRow}>
                <Text style={styles.resultCount}>
                  {filteredProductos.length} producto
                  {filteredProductos.length !== 1 ? "s" : ""}{" "}
                  {filteredProductos.length === 1 ? "encontrado" : "encontrados"}
                </Text>
                <TouchableOpacity
                  style={[styles.promotionsBtnSmall, showOnlyPromotions && styles.promotionsBtnSmallActive]}
                  onPress={togglePromotions}
                >
                  <Icon
                    name="local-offer"
                    type="material"
                    color={showOnlyPromotions ? "#fff" : COLORS.primary}
                    size={14}
                    style={{ marginRight: 4 }}
                  />
                  <Text
                    style={[styles.promotionsBtnSmallText, showOnlyPromotions && styles.promotionsBtnSmallTextActive]}
                  >
                    {showOnlyPromotions ? "Todo" : "Promociones o combos"}
                  </Text>
                </TouchableOpacity>
              </View>

              <FlatList
                data={filteredProductos}
                keyExtractor={(i) => String(i.id)}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={[styles.listItem]}
                    onPress={() => {
                      console.log("producto seleccionado:", item);
                      addToCart(item);
                      setSearchProductoQuery("");
                      setFilteredProductos(productos);
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.listTitle}>{item.descripcion}</Text>
                      <Text style={styles.listSubtitle}>Clave: {item.claveProd}</Text>
                      <Text style={styles.listSubtitle}>
                        Existencia: {item.existencia} + Kit: {item.esKit ? "Sí" : "No"}
                      </Text>
                      {item.esPromocion && <Text style={styles.precioPromoBadge}>🎉 PRECIO ESPECIAL</Text>}
                      {item.usandoPrecioDefault && !item.esPromocion && (
                        <Text style={styles.precioDefaultBadge}>(DOMIC.)</Text>
                      )}
                    </View>
                    <Text
                      style={[
                        styles.productPrice,
                        item.esPromocion && styles.productPricePromo,
                        item.usandoPrecioDefault && !item.esPromocion && styles.productPriceDefault,
                      ]}
                    >
                      ${item.precio.toFixed(2)}
                    </Text>
                  </TouchableOpacity>
                )}
                ListEmptyComponent={
                  <View style={styles.emptySearch}>
                    <Text style={styles.emptySearchText}>No se encontraron productos</Text>
                  </View>
                }
              />
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={() => {
                  setProductoModalOpen(false);
                  setSearchProductoQuery("");
                  setShowOnlyPromotions(false);
                  setFilteredProductos(productos);
                }}
              >
                <Text style={styles.secondaryBtnText}>Cerrar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      </ScrollView>
    </View>
  );
}

function PayChip({
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
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: SPACING.m, paddingBottom: SPACING.xxl },
  loadingBox: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: SPACING.xl,
  },
  loadingText: {
    marginTop: SPACING.m,
    ...TYPOGRAPHY.body,
    color: COLORS.textSecondary,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: SPACING.m,
    paddingHorizontal: SPACING.xs,
  },
  headerTitle: {
    ...TYPOGRAPHY.h2,
  },
  printerBadge: {
    backgroundColor: COLORS.success,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    borderRadius: BORDER_RADIUS.l,
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
  warningIcon: { fontSize: 20 },
  warningText: {
    flex: 1,
    color: COLORS.warning,
    fontSize: 13,
    fontWeight: "500",
  },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.l,
    padding: SPACING.m,
    marginBottom: SPACING.m,
    ...SHADOWS.small,
  },
  cardHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: SPACING.s,
  },
  cardTitle: { ...TYPOGRAPHY.h3, fontSize: 18 },
  valueText: {
    marginTop: SPACING.s,
    ...TYPOGRAPHY.body,
    fontSize: 16,
  },
  smallBtn: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    borderRadius: BORDER_RADIUS.m,
  },
  smallBtnDisabled: { opacity: 0.5 },
  smallBtnText: { color: "#fff", fontWeight: "600", fontSize: 12 },
  muted: { color: COLORS.muted, fontStyle: "italic" },
  cartList: { marginTop: SPACING.s },
  cartRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: SPACING.s,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  cartTitle: { fontWeight: "600", color: COLORS.textPrimary, fontSize: 14 },
  qtyBox: { width: 60, marginHorizontal: SPACING.s },
  qtyInput: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: BORDER_RADIUS.s,
    paddingVertical: 4,
    textAlign: "center",
    color: COLORS.textPrimary,
  },
  lineTotal: {
    width: 80,
    textAlign: "right",
    fontWeight: "600",
    color: COLORS.textPrimary,
  },
  removeBtn: { padding: SPACING.s, marginLeft: SPACING.s },
  removeBtnText: { color: COLORS.error, fontSize: 18, fontWeight: "bold" },
  payRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: SPACING.s,
    marginVertical: SPACING.m,
  },
  chip: {
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    borderRadius: BORDER_RADIUS.l,
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
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: SPACING.s,
    paddingTop: SPACING.s,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  totalText: { fontSize: 18, fontWeight: "600", color: COLORS.textSecondary },
  totalValue: { fontSize: 24, fontWeight: "bold", color: COLORS.primary },
  primaryBtn: {
    backgroundColor: COLORS.success,
    paddingVertical: SPACING.m,
    borderRadius: BORDER_RADIUS.l,
    alignItems: "center",
    marginTop: SPACING.m,
    ...SHADOWS.medium,
  },
  primaryBtnDisabled: { opacity: 0.6, backgroundColor: COLORS.muted },
  primaryBtnText: { color: "#fff", fontWeight: "700", fontSize: 18 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: BORDER_RADIUS.xl,
    borderTopRightRadius: BORDER_RADIUS.xl,
    maxHeight: "80%",
    padding: SPACING.l,
    ...SHADOWS.large,
  },
  modalTitle: {
    ...TYPOGRAPHY.h2,
    marginBottom: SPACING.m,
    textAlign: "center",
  },
  listItem: {
    paddingVertical: SPACING.m,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  listTitle: { fontWeight: "bold", color: COLORS.textPrimary, fontSize: 16 },
  listSubtitle: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },
  badge: {
    backgroundColor: COLORS.primaryLight,
    color: COLORS.primaryDark,
    paddingHorizontal: SPACING.s,
    paddingVertical: 2,
    borderRadius: BORDER_RADIUS.s,
    fontSize: 10,
    fontWeight: "bold",
    overflow: "hidden",
  },
  secondaryBtn: {
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: SPACING.m,
    borderRadius: BORDER_RADIUS.l,
    alignItems: "center",
    marginTop: SPACING.m,
  },
  secondaryBtnText: {
    color: COLORS.textPrimary,
    fontWeight: "700",
    fontSize: 16,
  },
  note: {
    marginTop: SPACING.m,
    color: COLORS.muted,
    textAlign: "center",
    fontSize: 12,
  },
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.background,
    borderRadius: BORDER_RADIUS.m,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    marginVertical: SPACING.s,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  searchIcon: {
    fontSize: 20,
    marginRight: SPACING.s,
    color: COLORS.muted,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    color: COLORS.textPrimary,
    paddingVertical: 4,
  },
  clearButton: {
    padding: 4,
  },
  clearButtonText: {
    fontSize: 18,
    color: COLORS.muted,
  },
  searchLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: COLORS.textSecondary,
    marginTop: SPACING.s,
  },
  resultCount: {
    fontSize: 13,
    color: COLORS.textSecondary,
    fontStyle: "italic",
    flex: 1,
  },
  resultCountRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: SPACING.s,
  },
  promotionsBtnSmall: {
    backgroundColor: COLORS.surface,
    borderWidth: 1.5,
    borderColor: COLORS.primary,
    paddingVertical: 4,
    paddingHorizontal: SPACING.s,
    borderRadius: BORDER_RADIUS.m,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
  },
  promotionsBtnSmallActive: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  promotionsBtnSmallText: {
    color: COLORS.primary,
    fontWeight: "600",
    fontSize: 11,
  },
  promotionsBtnSmallTextActive: {
    color: "#fff",
  },
  emptySearch: {
    paddingVertical: SPACING.xxl,
    alignItems: "center",
  },
  emptySearchText: {
    fontSize: 16,
    color: COLORS.muted,
    fontStyle: "italic",
  },
  productPrice: {
    fontSize: 16,
    fontWeight: "bold",
    color: COLORS.primary,
  },
  listItemPrecioDefault: {
    backgroundColor: "#FFF9E6",
    borderLeftWidth: 3,
    borderLeftColor: "#FF9800",
  },
  precioPromoBadge: {
    color: "#E91E63",
    fontSize: 11,
    fontWeight: "700",
    marginTop: 4,
    fontStyle: "italic",
  },
  productPricePromo: {
    color: "#E91E63",
    fontWeight: "900",
  },
  precioDefaultBadge: {
    color: "#FF6F00",
    fontSize: 11,
    fontWeight: "600",
    marginTop: 4,
    fontStyle: "italic",
  },
  productPriceDefault: {
    color: "#FF6F00",
  },
  cartRowPrecioDefault: {
    backgroundColor: "#FFF9E6",
    borderLeftWidth: 3,
    borderLeftColor: "#FF9800",
  },
  cartPriceDefault: {
    color: "#FF6F00",
    fontWeight: "600",
  },
});
