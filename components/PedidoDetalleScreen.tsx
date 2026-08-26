import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
  TextInput,
  ScrollView,
  Modal,
  ActivityIndicator,
} from "react-native";
import { Icon } from "react-native-elements";
import TicketPrinter from "../services/TicketPrinter";
import PedidosService, {
  Pedido,
  ESTATUS_PEDIDO,
  PRODUCTO_AGREGADO_OBSERVACION,
  esProductoAgregado,
} from "../services/PedidosService";
import FullSyncService from "../services/FullSyncService";
import AuthService from "../services/AuthService";
import LocationService from "../services/LocationService";
import VisitaSyncService from "../services/VisitaSyncService";
import DetalleVisitasService from "../services/DetalleVisitasService";
import ModalDiagnosticoGps, { DiagnosticoGpsData } from "./ModalDiagnosticoGps";
import IntercambioEnvaseModal from "./IntercambioEnvaseModal";
import PrestamoEnvaseModal from "./PrestamoEnvaseModal";
import { APP_NAME, COLORS, SPACING, BORDER_RADIUS, SHADOWS, TYPOGRAPHY } from "../theme/theme";

interface Props {
  navigation: any;
  route: any;
}

type ProductoDisponiblePedido = {
  id: number;
  claveProd: string;
  descripcion: string;
  precio: number;
  existencia: number;
  esKit?: boolean;
  inventariable?: boolean;
  esPromocion?: boolean;
  usandoPrecioDefault?: boolean;
  omitirMovil?: number;
  envaseRecibe?: boolean;
};

type IntercambioData = {
  envaseEntregadoClave: number;
  envaseEntregadoDesc: string;
  envaseRecibidoClave: number;
  envaseRecibidoDesc: string;
  envaseRecibidoId: number;
  kitIntercambioProductoId: number | null;
  precioEnvase: number | null;
  observacion: string;
  costo: number;
  cantRecEnvOtro: number;
};

type PrestamoData = {
  idProdPrestado: number;
  claveProdPrestado: number;
  descProdPrestado: string;
  observacion: string;
  fechaDevolucion: Date | null;
};

export default function PedidoDetalleScreen({ navigation, route }: Props) {
  const { folio, soloLectura } = route.params;

  const [pedido, setPedido] = useState<Pedido | null>(null);
  const [productos, setProductos] = useState<Pedido[]>([]);
  const [preciosPromo, setPreciosPromo] = useState<any[]>([]);
  const [preciosLista, setPreciosLista] = useState<any[]>([]);
  const [preciosDefault, setPreciosDefault] = useState<any[]>([]);
  const [formasPago, setFormasPago] = useState<any[]>([]);
  const [metodoPago, setMetodoPago] = useState<number | null>(null);
  const [productosDisponibles, setProductosDisponibles] = useState<ProductoDisponiblePedido[]>([]);
  const [filteredProductosDisponibles, setFilteredProductosDisponibles] = useState<ProductoDisponiblePedido[]>([]);
  const [productoModalVisible, setProductoModalVisible] = useState(false);
  const [searchProductoQuery, setSearchProductoQuery] = useState("");
  const [showOnlyPromotions, setShowOnlyPromotions] = useState(false);
  const [intercambioModalOpen, setIntercambioModalOpen] = useState(false);
  const [intercambioData, setIntercambioData] = useState<IntercambioData | null>(null);
  const intercambioDataRef = useRef<IntercambioData | null>(null);
  const [pendingIntercambioProducto, setPendingIntercambioProducto] = useState<ProductoDisponiblePedido | null>(null);
  const [pendingIntercambioCantidad, setPendingIntercambioCantidad] = useState(0);
  const [costoIntercambioCalculado, setCostoIntercambioCalculado] = useState(0);
  const [prestamoModalOpen, setPrestamoModalOpen] = useState(false);
  const [prestamoData, setPrestamoData] = useState<PrestamoData | null>(null);
  const [pendingPrestamoCantidad, setPendingPrestamoCantidad] = useState(0);
  const [pendingPrestamoProducto, setPendingPrestamoProducto] = useState<ProductoDisponiblePedido | null>(null);
  const envaseIntercambioClaveRef = useRef<number | undefined>(undefined);
  const envaseIntercambioDescRef = useRef<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [validandoGPS, setValidandoGPS] = useState(false);
  const [progresoValidacion, setProgresoValidacion] = useState<{
    intento: number;
    total: number;
    accuracy: number;
  } | null>(null);
  const [diagnosticoGps, setDiagnosticoGps] = useState<DiagnosticoGpsData | null>(null);
  const [gpsValidado, setGpsValidado] = useState(false);
  const [clienteNombre, setClienteNombre] = useState<string>("");
  const [clienteDireccion, setClienteDireccion] = useState<string>("");
  const [observaciones, setObservaciones] = useState<string>("");
  const [modalCausaVisible, setModalCausaVisible] = useState(false);
  const [productoSeleccionado, setProductoSeleccionado] = useState<Pedido | null>(null);
  const [causasDiferencia, setCausasDiferencia] = useState<{ id: number; descripcion: string }[]>([]);
  const [causaSeleccionada, setCausaSeleccionada] = useState<number | null>(null);
  const [observacionCausa, setObservacionCausa] = useState("");

  const [modalNoAtencionVisible, setModalNoAtencionVisible] = useState(false);
  const [causasNoAtencion, setCausasNoAtencion] = useState<{ id: number; descripcion: string }[]>([]);
  const [causaNoAtencionSel, setCausaNoAtencionSel] = useState<number | null>(null);
  const [observacionNoAtencion, setObservacionNoAtencion] = useState("");

  const salidaControlada = useRef(false);
  const cierreEnCursoRef = useRef(false);

  const construirProductosDisponibles = (
    pedidoData: Pedido,
    sucursal: number,
    userEnvaseRuta: boolean,
  ): ProductoDisponiblePedido[] => {
    const productosData = FullSyncService.getProductos(100000);
    const inventarioData = FullSyncService.getInventario();
    const kitsData = FullSyncService.getKits(50000);
    const cliente = FullSyncService.getClienteFullById(Number(pedidoData.cliente)) as any;
    const listaPrecio = Number(cliente?.listaPrecio ?? pedidoData.listaPrecio ?? 0);
    const promociones = FullSyncService.getPreciosPromoByCliente(pedidoData.cliente);
    const preciosCliente = FullSyncService.getPreciosByListaPrecio(listaPrecio);
    const preciosDomicilio = FullSyncService.getPreciosByListaPrecio(13);

    const crearMapaPrecios = (precios: any[]): Map<number, number> => {
      const mapa = new Map<number, number>();
      precios.forEach((precio) => {
        const clave = Number(precio?.claveProd);
        if (Number.isFinite(clave)) mapa.set(clave, Number(precio.precio) || 0);
      });
      return mapa;
    };

    const promocionesMap = crearMapaPrecios(promociones);
    const preciosClienteMap = crearMapaPrecios(preciosCliente);
    const preciosDomicilioMap = crearMapaPrecios(preciosDomicilio);
    const todasLasClaves = new Set<number>([
      ...promocionesMap.keys(),
      ...preciosClienteMap.keys(),
      ...preciosDomicilioMap.keys(),
    ]);
    const productosPorId = new Map<number, any>();
    const productosPorClave = new Map<number, any>();
    productosData.forEach((producto: any) => {
      const id = Number(producto.id);
      const clave = Number(producto.claveProd);
      if (Number.isFinite(id)) productosPorId.set(id, producto);
      if (Number.isFinite(clave)) productosPorClave.set(clave, producto);
    });

    const inventarioPorClave = new Map<number, number>();
    inventarioData
      .filter((item: any) => Number(item.sucursal) === sucursal && Number(item.id) < 10000)
      .forEach((item: any) => {
        const clave = Number(item.claveProd);
        if (!Number.isFinite(clave)) return;
        inventarioPorClave.set(clave, (inventarioPorClave.get(clave) || 0) + (Number(item.saldo) || 0));
      });

    const kitsPorProducto = new Map<number, any[]>();
    kitsData.forEach((kit: any) => {
      const idProducto = Number(kit.idProducto);
      if (!Number.isFinite(idProducto)) return;
      kitsPorProducto.set(idProducto, [...(kitsPorProducto.get(idProducto) || []), kit]);
    });

    const calcularExistencia = (producto: any, claveProd: number): number => {
      const idProducto = Number(producto.id);
      const claveProducto = Number(producto.claveProd);
      const componentes = kitsPorProducto.get(idProducto) || [];
      if (producto.esKit && !producto.inventariable) {
        if (componentes.length === 0) return 0;
        let minimo = Infinity;
        componentes.forEach((componente) => {
          if (componente.noRecuperaEnvase) return;
          const cantidadInsumo = Number(componente.cantidad);
          const claveInsumo = Number(componente.idInsumo);
          if (cantidadInsumo <= 0 || !Number.isFinite(claveInsumo)) {
            minimo = 0;
            return;
          }
          minimo = Math.min(minimo, Math.floor((inventarioPorClave.get(claveInsumo) || 0) / cantidadInsumo));
        });
        return minimo === Infinity ? 0 : minimo;
      }
      return (
        inventarioPorClave.get(claveProd) ??
        (Number.isFinite(claveProducto) ? inventarioPorClave.get(claveProducto) : undefined) ??
        inventarioPorClave.get(idProducto) ??
        0
      );
    };

    const calcularPrecioKit = (producto: any): number | undefined => {
      const componentes = kitsPorProducto.get(Number(producto.id)) || [];
      if (!componentes.length) return undefined;
      let precioKit = 0;
      componentes.forEach((componente) => {
        const insumo = productosPorId.get(Number(componente.idInsumo)) || productosPorClave.get(Number(componente.idInsumo));
        const precioFijo = Number(componente.precio) || 0;
        const clavesInsumo = [
          Number(componente.idInsumo),
          Number(insumo?.id),
          Number(insumo?.claveProd),
        ].filter(Number.isFinite);
        const buscarPrecioInsumo = (mapa: Map<number, number>): number | undefined => {
          const claveEncontrada = clavesInsumo.find((clave) => mapa.has(clave));
          return claveEncontrada === undefined ? undefined : mapa.get(claveEncontrada);
        };
        const precioInsumo = insumo?.precioCatalogo === true
          ? (buscarPrecioInsumo(promocionesMap) ??
            buscarPrecioInsumo(preciosClienteMap) ??
            buscarPrecioInsumo(preciosDomicilioMap) ??
            precioFijo)
          : precioFijo;
        precioKit += precioInsumo * (Number(componente.cantidad) || 1);
      });
      return precioKit > 0 ? precioKit : undefined;
    };

    const productosMap = new Map<number, ProductoDisponiblePedido>();
    todasLasClaves.forEach((clave) => {
      const producto = productosPorClave.get(clave) || productosPorId.get(clave);
      const id = Number(producto?.id);
      if (!producto || !Number.isFinite(id)) return;

      const esKit = Boolean(producto.esKit);
      const esPromocion = promocionesMap.has(clave);
      const precioPromo = promocionesMap.get(clave);
      const precioCliente = preciosClienteMap.get(clave);
      const precioDefault = preciosDomicilioMap.get(clave);
      let precio = precioPromo ?? precioCliente ?? precioDefault ?? 0;
      if (esKit && !producto.inventariable && !esPromocion) {
        precio = calcularPrecioKit(producto) ?? precio;
      }

      const productoDisponible: ProductoDisponiblePedido = {
        id,
        claveProd: String(producto.claveProd ?? clave),
        descripcion: producto.descripcion || `Producto #${id}`,
        precio,
        existencia: calcularExistencia(producto, clave),
        esKit,
        inventariable: Boolean(producto.inventariable),
        esPromocion,
        usandoPrecioDefault: precioPromo === undefined && precioCliente === undefined && precioDefault !== undefined,
        omitirMovil: Number(producto.omitirMovil) || 0,
        envaseRecibe: producto.envaseRecibe === true,
      };
      const omitirProductoEnMovil = Number(productoDisponible.omitirMovil) === 1;
      const productoVisible = omitirProductoEnMovil
        ? userEnvaseRuta && productoDisponible.envaseRecibe === true
        : productoDisponible.existencia > 0;
      if (!productoVisible) return;

      const existente = productosMap.get(id);
      if (
        !existente ||
        (esPromocion && !existente.esPromocion) ||
        precio > existente.precio
      ) {
        productosMap.set(id, productoDisponible);
      }
    });

    return Array.from(productosMap.values());
  };

  useEffect(() => {
    cargarDatos();
  }, []);

  useEffect(() => {
    const unsubscribe = navigation.addListener("beforeRemove", () => {
      if (salidaControlada.current) return;
      const pedidosService = PedidosService.getInstance();
      pedidosService.setRealm((FullSyncService as any).realm);
      const pedidoActual = pedidosService.getPedidoByFolio(folio);
      if (
        pedidoActual &&
        (pedidoActual.estatus === ESTATUS_PEDIDO.EN_ATENCION ||
          pedidoActual.estatus === ESTATUS_PEDIDO.EN_CAPTURA)
      ) {
        pedidosService.cambiarEstatusPedido(folio, ESTATUS_PEDIDO.PENDIENTE_SIN_CAUSA);
      }
    });
    return unsubscribe;
  }, [navigation, folio]);

  const cargarDatos = async () => {
    setLoading(true);
    try {
      if (!FullSyncService.isServiceInitialized()) {
        await FullSyncService.initialize();
      }
      const user = await AuthService.restoreSession();
      setFormasPago(FullSyncService.getFormasPago());

      const pedidosService = PedidosService.getInstance();
      pedidosService.setRealm((FullSyncService as any).realm);

      const pedidoData = pedidosService.getPedidoByFolio(folio);
      const productosData = pedidosService.getProductosByFolio(folio);
      const productosCatalogo = FullSyncService.getProductos(100000);
      console.log(
        `[PedidoDetalle] Diagnóstico folio=${folio}`,
        productosData.map((producto: any) => ({
          id: producto.id,
          idProducto: producto.idProducto,
          productoNombre: producto.productoNombre,
          cantPedido: producto.cantPedido,
          catalogoEncontrado: productosCatalogo.some(
            (catalogo: any) => Number(catalogo.id) === Number(producto.idProducto),
          ),
          catalogoNombre: productosCatalogo.find(
            (catalogo: any) => Number(catalogo.id) === Number(producto.idProducto),
          )?.descripcion,
        })),
      );
      const causasDif = pedidosService.getCausasDiferencia();
      const causasNoAt = pedidosService.getCausasNoAtencion();

      const productosConNombre = productosData.map((producto: Pedido) => {
        if (producto.productoNombre) return producto;
        const productoCatalogo = productosCatalogo.find(
          (catalogo: any) => Number(catalogo.id) === Number(producto.idProducto),
        );
        return productoCatalogo?.descripcion
          ? { ...producto, productoNombre: productoCatalogo.descripcion }
          : producto;
      });
      const inicializarCantidades =
        pedidoData &&
        !soloLectura &&
        [ESTATUS_PEDIDO.CONFIRMADO, ESTATUS_PEDIDO.NOTIFICADO].includes(Number(pedidoData.estatus));
      const productosInicializados = productosConNombre.map((producto) => {
        const cantPedido = Number(producto.cantPedido ?? 0);
        const cantAtencion = Number(producto.cantAtencion ?? 0);
        if (!inicializarCantidades || !Number.isFinite(cantPedido) || cantPedido <= 0 || cantAtencion > 0) {
          return producto;
        }

        const actualizado = pedidosService.actualizarCantAtencion(folio, producto.idProducto, cantPedido);
        return actualizado
          ? { ...producto, cantAtencion: cantPedido, tieneDiferencia: false, atendido: true }
          : producto;
      });

      setPedido(pedidoData);
      setProductos(productosInicializados);
      if (pedidoData) {
        const realm = (FullSyncService as any).realm;
        let clienteObj: any = realm
          ? realm.objectForPrimaryKey("ClienteFull", Number(pedidoData.cliente))
          : null;
        if (!clienteObj && realm) {
          const clientes = realm.objects("ClienteFull").filtered("id = $0", Number(pedidoData.cliente));
          if (clientes.length > 0) clienteObj = clientes[0];
        }

        const nombresPedido = [
          pedidoData.clienteNombre,
          ...productosData.map((producto) => producto.clienteNombre),
        ]
          .map((nombre) => String(nombre ?? "").trim())
          .filter(Boolean);
        const nombreClientePedido =
          nombresPedido.find((nombre) => !/^Cliente #\d+$/i.test(nombre)) || nombresPedido[0];
        const domiciliosPedido = [
          pedidoData.clienteDomicilio,
          ...productosData.map((producto) => producto.clienteDomicilio),
        ]
          .map((domicilio) => String(domicilio ?? "").trim())
          .filter(Boolean);
        const domicilioPedido = domiciliosPedido[0];
        const nombreCliente =
          nombreClientePedido || clienteObj?.nombre || clienteObj?.nombreCliente || `Cliente #${pedidoData.cliente}`;
        const domicilioCliente = domicilioPedido || clienteObj?.domicilio || "Sin dirección";
        const pedidoConDatosCliente = {
          ...pedidoData,
          clienteNombre: nombreCliente,
          clienteDomicilio: domicilioCliente,
        } as Pedido;

        setPedido(pedidoConDatosCliente);
        setClienteNombre(nombreCliente);
        setClienteDireccion(domicilioCliente);
        setObservaciones(
          pedidoData.observaciones ||
            (productosData as any[]).find((p: any) => p.observaciones)?.observaciones ||
            "",
        );
        setPreciosPromo(FullSyncService.getPreciosPromoByCliente(pedidoData.cliente));
        const listaPrecioCliente = Number(clienteObj?.listaPrecio ?? pedidoData.listaPrecio ?? 0);
        setPreciosLista(FullSyncService.getPreciosByListaPrecio(listaPrecioCliente));
        const sucursal = Number(user?.sucursal_origen || user?.sucursal || pedidoData.ruta || 1);
        const productosDisponiblesData = construirProductosDisponibles(
          pedidoData,
          sucursal,
          user?.envaseRuta === true,
        );
        setProductosDisponibles(productosDisponiblesData);
        setFilteredProductosDisponibles(productosDisponiblesData);
      } else {
        setClienteNombre("");
        setClienteDireccion("");
        setObservaciones("");
        setPreciosPromo([]);
        setPreciosLista([]);
        setProductosDisponibles([]);
        setFilteredProductosDisponibles([]);
      }
      setPreciosDefault(FullSyncService.getPreciosByListaPrecio(13));
      setCausasDiferencia(causasDif);
      setCausasNoAtencion(causasNoAt);

      if (soloLectura) {
        setGpsValidado(true);
      }
    } catch (error) {
      console.error("[PedidoDetalle] Error al cargar datos:", error);
      Alert.alert("Error", "No se pudo cargar el pedido");
    } finally {
      setLoading(false);
    }
  };

  const filtrarProductosDisponibles = (query: string, soloPromociones = showOnlyPromotions) => {
    const productosConRecuperaEnvase = FullSyncService.getProductosConRecuperaEnvase();
    const base = soloPromociones
      ? productosDisponibles.filter((producto) => producto.esKit || producto.esPromocion)
      : productosDisponibles.filter(
          (producto) =>
            (!producto.esKit && !producto.esPromocion) || productosConRecuperaEnvase.has(producto.id),
        );
    const normalizedQuery = query.trim().toLowerCase();
    const filtrados = normalizedQuery
      ? base.filter(
          (producto) =>
            producto.descripcion.toLowerCase().includes(normalizedQuery) ||
            producto.claveProd.toLowerCase().includes(normalizedQuery) ||
            String(producto.id).includes(normalizedQuery),
        )
      : base;
    setFilteredProductosDisponibles(filtrados);
  };

  const abrirModalProductos = () => {
    if (soloLectura) return;
    setSearchProductoQuery("");
    setShowOnlyPromotions(false);
    filtrarProductosDisponibles("", false);
    setProductoModalVisible(true);
  };

  const esProductoIntercambio = (productoId: number): boolean =>
    FullSyncService.getKitsByProducto(productoId).some((kit: any) => kit.recuperaEnvaseOtro);

  const esProductoPrestamo = (productoId: number): boolean =>
    FullSyncService.getKitsByProducto(productoId).some((kit: any) => kit.controlPresamo);

  const guardarProductoEnPedido = (
    producto: ProductoDisponiblePedido,
    precio = producto.precio,
    cantidad = 1,
    validarExistencia = true,
  ): boolean => {
    const pedidosService = PedidosService.getInstance();
    pedidosService.setRealm((FullSyncService as any).realm);
    const productosActuales = pedidosService.getProductosByFolio(folio);
    const existente = productosActuales.find((item) => item.idProducto === producto.id);
    const cantidadActual = Number(existente?.cantAtencion ?? 0);
    if (validarExistencia && cantidadActual + cantidad > producto.existencia) {
      Alert.alert(
        "Inventario insuficiente",
        `No hay suficiente existencia de "${producto.descripcion}" (disponible: ${producto.existencia})`,
      );
      return false;
    }

    const success = pedidosService.agregarProductoPedido(folio, {
      idProducto: producto.id,
      productoNombre: producto.descripcion,
      precio,
      cantidad,
    });
    if (!success) {
      Alert.alert("Error", "No se pudo agregar el producto al pedido");
      return false;
    }

    setProductos(pedidosService.getProductosByFolio(folio));
    const pedidoActualizado = pedidosService.getPedidoByFolio(folio);
    if (pedidoActualizado) setPedido(pedidoActualizado);
    setProductoModalVisible(false);
    setSearchProductoQuery("");
    return true;
  };

  const agregarProductoAlPedido = (producto: ProductoDisponiblePedido) => {
    const kitsDelProducto = FullSyncService.getKitsByProducto(producto.id);
    const tienePrestamo = kitsDelProducto.some((kit: any) => kit.controlPresamo);
    const tieneIntercambio = kitsDelProducto.some((kit: any) => kit.recuperaEnvaseOtro);

    if (tienePrestamo) {
      setPendingPrestamoProducto(producto);
      setPendingPrestamoCantidad(1);
      setProductoModalVisible(false);
      setPrestamoModalOpen(true);
      return;
    }

    if (tieneIntercambio) {
      const kitIntercambio = kitsDelProducto.find((kit: any) => kit.recuperaEnvaseOtro);
      const idInsumo = Number(kitIntercambio?.idInsumo);
      const productoInsumo = FullSyncService.getProductos(100000).find(
        (item: any) => Number(item.id) === idInsumo,
      );
      envaseIntercambioClaveRef.current = productoInsumo
        ? Number.parseInt(String(productoInsumo.claveProd || "0"), 10)
        : idInsumo;
      envaseIntercambioDescRef.current = productoInsumo?.descripcion || `Producto ${idInsumo}`;
      setCostoIntercambioCalculado(producto.precio);
      setPendingIntercambioProducto(producto);
      setPendingIntercambioCantidad(1);
      setProductoModalVisible(false);
      setIntercambioModalOpen(true);
      return;
    }

    guardarProductoEnPedido(producto);
  };

  const iniciarAtencion = async (): Promise<boolean> => {
    const pedidosService = PedidosService.getInstance();
    pedidosService.setRealm((FullSyncService as any).realm);
    const success = pedidosService.iniciarAtencionPedido(folio);
    console.log(`[PedidoDetalle] Iniciar atención folio=${folio}, resultado=${success}`);
    if (!success) return false;

    const pedidoActualizado = pedidosService.getPedidoByFolio(folio);
    if (pedidoActualizado) setPedido(pedidoActualizado);

    try {
      const user = await AuthService.restoreSession();
      const idUsuario = Number(user?.id ?? user?.idUsuario ?? pedidoActualizado?.idVendedor ?? 1);
      const resultadoArrastre = await FullSyncService.sendPendingPedidoEstadosToServer(idUsuario);
      console.log(`[PedidoDetalle] Arrastre estado EN_ATENCION folio=${folio}:`, resultadoArrastre);
    } catch (error) {
      console.warn(`[PedidoDetalle] No se pudo enviar arrastre EN_ATENCION folio=${folio}:`, error);
    }

    return true;
  };

  const validarGPS = async () => {
    if (!pedido || validandoGPS) return;

    const cliente = FullSyncService.getClienteFullById(Number(pedido.cliente)) as any;
    const clienteLat = Number(cliente?.latitud);
    const clienteLng = Number(cliente?.longitud);
    if (
      !Number.isFinite(clienteLat) ||
      !Number.isFinite(clienteLng) ||
      (clienteLat === 0 && clienteLng === 0)
    ) {
      Alert.alert("Cliente sin ubicación", "El cliente no tiene registrada su ubicación geográfica.");
      return;
    }

    setValidandoGPS(true);
    setProgresoValidacion(null);
    try {
      const user = await AuthService.restoreSession();
      const idUsuario = Number(user?.id ?? user?.idUsuario ?? pedido.idVendedor ?? 0);
      const usuario = idUsuario > 0 ? (FullSyncService.getUsuarioById(idUsuario) as any) : null;
      const metrosConfigurados = Number(usuario?.metros ?? user?.metros);
      const metrosPermitidos = Number.isFinite(metrosConfigurados) && metrosConfigurados > 0 ? metrosConfigurados : 100;
      const clienteInfo = {
        id: Number(pedido.cliente),
        nombre: cliente?.nombre || clienteNombre || pedido.clienteNombre,
        lat: clienteLat,
        lng: clienteLng,
      };

      const resultado = await LocationService.validarUbicacionConDiagnostico(
        clienteLat,
        clienteLng,
        metrosPermitidos,
        (intento, total, accuracy) => {
          setProgresoValidacion({ intento, total, accuracy });
        },
        clienteInfo,
      );

      if (resultado.valido) {
        const iniciado = await iniciarAtencion();
        if (iniciado) setGpsValidado(true);
        return;
      }

      if (resultado.motivo === "sin_permiso") {
        Alert.alert(
          "Permiso de ubicación",
          "Necesitas conceder el permiso de ubicación para poder iniciar la atención.",
        );
        return;
      }

      setDiagnosticoGps({
        motivo: resultado.motivo,
        valido: false,
        distancia: resultado.distancia ?? null,
        accuracy: resultado.accuracy ?? null,
        metrosPermitidos,
        numFixes: resultado.numFixes ?? null,
        peorAccuracy: resultado.peorAccuracy ?? null,
        tiempoMs: resultado.tiempoMs ?? null,
        vendedorLat: resultado.ubicacion?.latitude ?? null,
        vendedorLng: resultado.ubicacion?.longitude ?? null,
        clienteLat,
        clienteLng,
        clienteNombre: clienteInfo.nombre,
      });
    } catch (error) {
      console.error("[PedidoDetalle] Error al validar ubicación:", error);
      Alert.alert("Error de ubicación", "No se pudo validar tu ubicación. Intenta nuevamente.");
    } finally {
      setValidandoGPS(false);
      setProgresoValidacion(null);
    }
  };

  const abrirModalCausa = (producto: Pedido) => {
    setProductoSeleccionado(producto);
    setCausaSeleccionada(producto.causaDiferencia || null);
    setObservacionCausa(producto.obserDiferencia || "");
    setModalCausaVisible(true);
  };

  const confirmarCausaDiferencia = () => {
    if (!productoSeleccionado || causaSeleccionada === null) {
      Alert.alert("Error", "Seleccione una causa");
      return;
    }

    const causa = causasDiferencia.find((c) => c.id === causaSeleccionada);
    const esOtro = causa && ["otro", "otra"].includes(causa.descripcion.trim().toLowerCase());
    if (esOtro && !observacionCausa.trim()) {
      Alert.alert("Observación requerida", "La observación es obligatoria para la causa 'Otro/Otra'");
      return;
    }

    const pedidosService = PedidosService.getInstance();
    pedidosService.setRealm((FullSyncService as any).realm);

    const success = pedidosService.registrarCausaDiferencia(
      folio,
      productoSeleccionado.idProducto,
      causaSeleccionada,
      observacionCausa,
    );

    if (success) {
      const productosActualizados = pedidosService.getProductosByFolio(folio);
      setProductos(productosActualizados);
      setModalCausaVisible(false);
      setProductoSeleccionado(null);
      setCausaSeleccionada(null);
      setObservacionCausa("");
    } else {
      Alert.alert("Error", "No se pudo registrar la causa");
    }
  };

  const abrirModalNoAtencion = () => {
    setCausaNoAtencionSel(null);
    setObservacionNoAtencion("");
    setModalNoAtencionVisible(true);
  };

  const confirmarNoAtencion = () => {
    if (causaNoAtencionSel === null) {
      Alert.alert("Error", "Seleccione una causa de no atención");
      return;
    }

    const causa = causasNoAtencion.find((c) => c.id === causaNoAtencionSel);
    const esOtro = causa && ["otro", "otra"].includes(causa.descripcion.trim().toLowerCase());
    if (esOtro && !observacionNoAtencion.trim()) {
      Alert.alert("Observación requerida", "La observación es obligatoria para la causa 'Otro/Otra'");
      return;
    }

    const pedidosService = PedidosService.getInstance();
    pedidosService.setRealm((FullSyncService as any).realm);

    const result = pedidosService.finalizarPedido(
      folio,
      ESTATUS_PEDIDO.PENDIENTE_CON_CAUSA,
      causaNoAtencionSel,
      observacionNoAtencion,
    );

    if (result.success) {
      setModalNoAtencionVisible(false);
      Alert.alert("Éxito", "Pedido marcado como pendiente con causa", [
        { text: "OK", onPress: () => { salidaControlada.current = true; navigation.goBack(); } },
      ]);
    } else {
      Alert.alert("Error", "No se pudo actualizar el pedido");
    }
  };

  const registrarVisitaPorEntrega = async (pedidoCerrado: Pedido, sucursal: number, idUsuario: number): Promise<void> => {
    try {
      const visitasDelDia = await VisitaSyncService.getInstance().getVisitasByFecha(new Date(), sucursal);
      const visitaPendiente = visitasDelDia
        .filter((v: any) => v.visitado === 0)
        .find((v: any) => v.idCliente === pedidoCerrado.cliente);

      if (visitaPendiente) {
        await VisitaSyncService.getInstance().marcarVisitado(
          visitaPendiente.id,
          1,
          new Date(visitaPendiente.fecha),
        );
      }
    } catch (error) {
      console.warn(`[PedidoDetalle] No se pudo marcar la visita del pedido ${pedidoCerrado.folio}:`, error);
    }

    try {
      await DetalleVisitasService.getInstance().registrarVisitaCompleta(
        pedidoCerrado.cliente,
        idUsuario,
        sucursal,
        1,
      );
    } catch (error) {
      console.warn(`[PedidoDetalle] No se pudo registrar DetalleVisitas del pedido ${pedidoCerrado.folio}:`, error);
    }
  };

  const registrarVentaEInventarioPedido = async (
    pedidoCerrado: Pedido,
    productosEntregados: Pedido[],
    idMovil: number,
    sucursal: number,
    user: any,
    idUsuario: number,
  ): Promise<void> => {
    const productosCatalogo = FullSyncService.getProductos(100000);
    const listaCliente = pedidoCerrado.listaPrecio ?? null;
    const currentIntercambioData = intercambioDataRef.current || intercambioData;
    const obtenerListaProducto = (idProducto: number): number | null => {
      const productoCatalogo = productosCatalogo.find((producto: any) => Number(producto.id) === idProducto);
      const clavesProducto = [idProducto, Number(productoCatalogo?.claveProd)].filter(Number.isFinite);
      const tienePrecioListaCliente = preciosLista.some((precio: any) =>
        clavesProducto.includes(Number(precio.claveProd)),
      );
      return tienePrecioListaCliente ? listaCliente : 13;
    };
    const entregas = productosEntregados
      .map((producto) => {
        const cantidad = Number(producto.cantAtencion ?? 0);
        const precioNormal = Number(producto.precioAtencion ?? producto.precio ?? obtenerPrecioProducto(producto.idProducto));
        const precio = esProductoIntercambio(Number(producto.idProducto))
          ? Number(currentIntercambioData?.costo ?? precioNormal)
          : precioNormal;
        const productoCatalogo = productosCatalogo.find((p: any) => Number(p.id) === Number(producto.idProducto));
        return {
          idProducto: producto.idProducto,
          nombreProducto: producto.productoNombre || productoCatalogo?.descripcion || `Producto #${producto.idProducto}`,
          cantidad,
          precio: Number.isFinite(precio) ? precio : 0,
          idLista: obtenerListaProducto(producto.idProducto),
          esKit: productoCatalogo?.esKit === true,
        };
      })
      .filter((producto) => Number.isFinite(producto.cantidad) && producto.cantidad > 0);

    if (entregas.length === 0) {
      console.info(
        `[PedidoDetalle] El pedido ${pedidoCerrado.folio} no tiene productos entregados; se omite venta e inventario`,
      );
      return;
    }

    const ventasExistentes = FullSyncService.getVentasByMovilId(idMovil);
    if (ventasExistentes.length > 0) {
      console.log(`[PedidoDetalle] Venta ya registrada para id_movil ${idMovil}; se omite duplicar venta e inventario`);
      return;
    }

    const nombreCliente = pedidoCerrado.clienteNombre || clienteNombre || `Cliente #${pedidoCerrado.cliente}`;
    const vendedor = user?.claveEmpleado || user?.nombre || String(idUsuario);
    const observacionesEnvase = [intercambioData?.observacion, prestamoData?.observacion];
    const observacionVenta = Array.from(
      new Set(
        [
          pedidoCerrado.observaciones,
          ...productosEntregados.map((producto) => producto.observaciones),
          ...observacionesEnvase,
        ]
          .map((observacion) => String(observacion ?? "").trim())
          .filter(Boolean),
      ),
    ).join(" | ");
    const fechaVenta = FullSyncService.getMexicoNow();

    await FullSyncService.createLocalVentas(
      entregas.map((entrega, index) => ({
        id: idMovil + index,
        idMovil,
        sucursal,
        noVenta: 0,
        claveProd: entrega.idProducto,
        nombreProducto: entrega.nombreProducto,
        cantProducto: entrega.cantidad,
        precio: entrega.precio,
        importe: entrega.precio * entrega.cantidad,
        cveCliente: pedidoCerrado.cliente,
        nombreCliente,
        fecha: fechaVenta,
        tipoPago: metodoPago ?? 1,
        descripcionMedioPago: formasPago.find((forma: any) => forma.tipo === metodoPago)?.descripcion ?? "Efectivo",
        vendedor,
        folioFactura: false,
        facturacionMovil: false,
        latitud: null,
        longitud: null,
        observacion: observacionVenta,
        idPedido: pedidoCerrado.idPedido ?? pedidoCerrado.folio,
        idLista: entrega.idLista,
        fechaDevolucion: esProductoPrestamo(entrega.idProducto) ? prestamoData?.fechaDevolucion ?? null : null,
      })),
    );

    try {
      const productoIntercambio = productosEntregados.find((producto) =>
        esProductoIntercambio(Number(producto.idProducto)),
      );
      const cantidadProductoIntercambio = Number(productoIntercambio?.cantAtencion ?? 0);
      if (currentIntercambioData && cantidadProductoIntercambio > 0) {
        const cantRecEnvOtro = Number(currentIntercambioData.cantRecEnvOtro) > 0
          ? Number(currentIntercambioData.cantRecEnvOtro)
          : 1;
        const productoRecibido = productosCatalogo.find(
          (producto: any) => Number(producto.claveProd) === Number(currentIntercambioData.envaseRecibidoClave),
        );
        const cantidadEntrada = cantidadProductoIntercambio * cantRecEnvOtro;
        await FullSyncService.createLocalInventarioEnvase([
          {
            sucursal,
            claveProd: Number(
              productoRecibido?.id || currentIntercambioData.envaseRecibidoId || currentIntercambioData.envaseRecibidoClave,
            ),
            folioMovto: 1,
            cantidadEntrada,
            cantidadSalida: 0,
            costo: Number(currentIntercambioData.costo) || 0,
            tipoMovto: 1000,
            idMovil,
            observacion: currentIntercambioData.observacion || "",
          },
        ]);
      }
    } catch (error) {
      console.warn(`[PedidoDetalle] No se pudo registrar el movimiento de intercambio del folio ${pedidoCerrado.folio}:`, error);
    }

    const entregasInventario = entregas.filter(
      (entrega) => !esProductoIntercambio(entrega.idProducto) && !esProductoPrestamo(entrega.idProducto),
    );
    await FullSyncService.updateInventarioAfterSaleScreen(
      entregasInventario.map((entrega) => ({
        sucursal,
        claveProd: entrega.idProducto,
        cantidad: entrega.cantidad,
        esKit: entrega.esKit,
        idProducto: entrega.idProducto,
      })),
    );
  };

  const imprimirTicketPedido = async (
    pedidoCerrado: Pedido,
    productosEntregados: Pedido[],
    idMovil: number,
    sucursal: number,
    user: any,
  ): Promise<void> => {
    const formaPago = formasPago.find((forma: any) => forma.tipo === metodoPago);
    const pago0 = Boolean(formaPago?.pago0);
    const idUsuario = Number(user?.id ?? user?.idUsuario ?? pedidoCerrado.idVendedor ?? 1);
    const usuarioTicket = FullSyncService.getUsuarioById(idUsuario) as any;
    const clienteTicket = FullSyncService.getClienteFullById(Number(pedidoCerrado.cliente)) as any;
    const ciaTicket = clienteTicket?.idEmpresa ? (FullSyncService.getCiaById(Number(clienteTicket.idEmpresa)) as any) : null;
    const permisoDomicilio = [true, 1, "1"].includes(usuarioTicket?.permisoDomicilioTicket);
    const items = productosEntregados
      .filter((producto) => Number(producto.cantAtencion ?? 0) > 0)
      .map((producto) => {
        const quantity = Number(producto.cantAtencion ?? 0);
        const price = Number(producto.precioAtencion ?? producto.precio ?? obtenerPrecioProducto(producto.idProducto));
        return {
          description: producto.productoNombre || `Producto #${producto.idProducto}`,
          quantity,
          price: Number.isFinite(price) ? price : 0,
          total: (Number.isFinite(price) ? price : 0) * quantity,
        };
      });
    const total = items.reduce((sum, item) => sum + item.total, 0);
    const ticketData = {
      clientName: pedidoCerrado.clienteNombre || clienteNombre || `Cliente #${pedidoCerrado.cliente}`,
      clientDomicilio: permisoDomicilio ? clienteTicket?.domicilio || pedidoCerrado.clienteDomicilio : undefined,
      paymentMethod: formaPago?.descripcion || "Efectivo",
      items,
      total: pago0 ? 0 : total,
      businessName: ciaTicket?.nombreCia || APP_NAME,
      businessAddress: ciaTicket?.domicilio,
      taxId: ciaTicket?.rfc,
      domicilio: ciaTicket?.domicilio,
      regimenFiscal: ciaTicket?.regimenFiscal,
      phone: ciaTicket?.telefono,
      ticketFinal: usuarioTicket?.ticketFinal,
      sellerName: user?.claveEmpleado || user?.nombre || String(idUsuario),
      branch: user?.dSucursal || sucursal,
      ticketNumber: String(idMovil),
      pago0,
    };
    const dobleTicket = [true, 1, "1"].includes(usuarioTicket?.dobleTicket);
    if (dobleTicket) {
      await TicketPrinter.printSaleTicket(ticketData);
      await TicketPrinter.printSaleTicket(ticketData);
    } else {
      await TicketPrinter.printSaleTicket(ticketData);
    }
  };

  const procesarCierreComoVenta = async (
    pedidoCerrado: Pedido,
    productosEntregados: Pedido[],
    idMovil: number,
  ): Promise<void> => {
    const tieneEntregas = productosEntregados.some((producto) => Number(producto.cantAtencion ?? 0) > 0);
    if (!tieneEntregas) {
      console.info(
        `[PedidoDetalle] El pedido ${pedidoCerrado.folio} se cerró sin entrega; no se procesa venta ni inventario`,
      );
      return;
    }

    const user = await AuthService.restoreSession();
    const idUsuario = Number(user?.id ?? user?.idUsuario ?? pedidoCerrado.idVendedor ?? 1);
    const sucursal = Number(user?.sucursal_origen || user?.sucursal || pedidoCerrado.ruta || 1);

    await registrarVisitaPorEntrega(pedidoCerrado, sucursal, idUsuario);
    await registrarVentaEInventarioPedido(pedidoCerrado, productosEntregados, idMovil, sucursal, user, idUsuario);
    try {
      await imprimirTicketPedido(pedidoCerrado, productosEntregados, idMovil, sucursal, user);
    } catch (error) {
      console.warn(`[PedidoDetalle] No se pudo imprimir ticket del pedido ${pedidoCerrado.folio}:`, error);
    }

    const ventaArrastre = await FullSyncService.syncPostVenta(sucursal, idUsuario);
    if (!ventaArrastre.success) {
      console.warn(`[PedidoDetalle] Arrastre de venta pendiente para folio ${pedidoCerrado.folio}:`, ventaArrastre.error);
    }
  };

  const validarInventarioPedido = (
    productosEntregados: Pedido[],
    sucursal: number,
  ): {
    permitido: boolean;
    faltantes: { nombre: string; disponible: number; solicitado: number }[];
  } => {
    const inventarioPorClave = new Map<number, number>();
    FullSyncService.getInventario()
      .filter((item: any) => Number(item.sucursal) === sucursal && Number(item.id) < 10000)
      .forEach((item: any) => {
        const clave = Number(item.claveProd);
        const saldo = Number(item.saldo || 0);
        if (!Number.isFinite(clave) || !Number.isFinite(saldo)) return;
        inventarioPorClave.set(clave, (inventarioPorClave.get(clave) || 0) + saldo);
      });

    const productosPorId = new Map<number, any>();
    FullSyncService.getProductos(100000).forEach((producto: any) => {
      productosPorId.set(Number(producto.id), producto);
    });

    const kitsPorProducto = new Map<number, any[]>();
    FullSyncService.getKits(50000).forEach((kit: any) => {
      const idProducto = Number(kit.idProducto);
      if (!Number.isFinite(idProducto)) return;
      const componentes = kitsPorProducto.get(idProducto) || [];
      componentes.push(kit);
      kitsPorProducto.set(idProducto, componentes);
    });

    const calcularExistencia = (idProducto: number): number => {
      const productoCatalogo = productosPorId.get(idProducto);
      const esKit = Boolean(productoCatalogo?.esKit);
      const inventariable = Boolean(productoCatalogo?.inventariable);

      if (esKit && !inventariable) {
        const componentes = kitsPorProducto.get(idProducto) || [];
        if (!componentes.length) return 0;

        let minimo = Infinity;
        for (const componente of componentes) {
          if (componente.noRecuperaEnvase) continue;

          const cantidadInsumo = Number(componente.cantidad || 0);
          const claveInsumo = Number(componente.idInsumo);
          if (cantidadInsumo <= 0 || !Number.isFinite(claveInsumo)) return 0;

          const saldo = inventarioPorClave.get(claveInsumo) || 0;
          minimo = Math.min(minimo, Math.floor(saldo / cantidadInsumo));
        }

        return minimo === Infinity ? 0 : minimo;
      }

      const claveProducto = Number(productoCatalogo?.claveProd);
      return inventarioPorClave.get(idProducto) || (Number.isFinite(claveProducto) ? inventarioPorClave.get(claveProducto) : 0) || 0;
    };

    const faltantes = productosEntregados.reduce<
      { nombre: string; disponible: number; solicitado: number }[]
    >((resultado, producto) => {
      const solicitado = Number(producto.cantAtencion ?? 0);
      if (!Number.isFinite(solicitado) || solicitado <= 0) return resultado;
      if (esProductoIntercambio(Number(producto.idProducto)) || esProductoPrestamo(Number(producto.idProducto))) {
        return resultado;
      }

      const disponible = calcularExistencia(Number(producto.idProducto));
      if (disponible < solicitado) {
        resultado.push({
          nombre: producto.productoNombre || `Producto #${producto.idProducto}`,
          disponible,
          solicitado,
        });
      }
      return resultado;
    }, []);

    return { permitido: faltantes.length === 0, faltantes };
  };

  const confirmarEntrega = () => {
    const hayEntregados = productos.some((p) => Number(p.cantAtencion ?? 0) > 0);
    if (!hayEntregados) {
      Alert.alert(
        "Sin productos entregados",
        "No se registró ninguna cantidad entregada. Para cerrar el pedido sin venta, registre una causa de no atención.",
      );
      return;
    }

    const formaPago = formasPago.find((forma: any) => forma.tipo === metodoPago);
    if (metodoPago === null || !formaPago) {
      Alert.alert("Medio de pago requerido", "Selecciona un método de pago antes de confirmar la entrega.");
      return;
    }
    const clientePedido = FullSyncService.getClienteFullById(Number(pedido?.cliente)) as any;
    if (formaPago.credito && !clientePedido?.credito) {
      Alert.alert("Crédito no disponible", "El cliente seleccionado no tiene crédito habilitado.");
      return;
    }

    const productosConDiferencia = productos.filter((p) => {
      const cantAtencion = Number(p.cantAtencion ?? 0);
      const cantPedido = Number(p.cantPedido ?? 0);
      return cantAtencion < cantPedido && !p.causaDiferencia && !esProductoAgregado(p);
    });

    if (productosConDiferencia.length > 0) {
      Alert.alert(
        "Productos sin causa",
        `Hay ${productosConDiferencia.length} producto(s) con diferencia sin causa registrada. Debe registrar la causa antes de confirmar.`,
      );
      return;
    }

    const todosEntregados = productos.every(
      (p) => Number(p.cantAtencion ?? 0) >= Number(p.cantPedido ?? 0),
    );
    const hayDiferenciasConCausa = productos.some((p) => {
      const cantAtencion = Number(p.cantAtencion ?? 0);
      const cantPedido = Number(p.cantPedido ?? 0);
      return cantAtencion < cantPedido && p.causaDiferencia;
    });

    let nuevoEstatus: number;
    let mensaje: string;

    if (todosEntregados) {
      nuevoEstatus = ESTATUS_PEDIDO.ENTREGADO;
      mensaje = "¿Confirmar entrega completa del pedido?";
    } else if (hayEntregados || hayDiferenciasConCausa) {
      nuevoEstatus = ESTATUS_PEDIDO.ENTREGADO_PARCIAL;
      mensaje = "¿Confirmar entrega parcial del pedido?";
    } else {
      Alert.alert("Atención", "No ha registrado ninguna cantidad entregada");
      return;
    }

    Alert.alert("Confirmar Entrega", mensaje, [
      { text: "Cancelar", style: "cancel" },
      {
        text: "Confirmar",
        onPress: async () => {
          if (cierreEnCursoRef.current) return;
          cierreEnCursoRef.current = true;
          const pedidosService = PedidosService.getInstance();
          pedidosService.setRealm((FullSyncService as any).realm);

          const pedidoCerrado = pedido;
          const productosEntregados = [...productos];
          if (!pedidoCerrado) {
            Alert.alert("Error", "No se encontró el pedido para confirmar la entrega");
            cierreEnCursoRef.current = false;
            return;
          }

          const user = await AuthService.restoreSession();
          const sucursal = Number(user?.sucursal_origen || user?.sucursal || pedidoCerrado.ruta || 1);
          const validacionInventario = validarInventarioPedido(productosEntregados, sucursal);
          if (!validacionInventario.permitido) {
            Alert.alert(
              "Inventario insuficiente",
              `Los siguientes productos no tienen suficiente inventario:\n${validacionInventario.faltantes
                .map((item) => `- ${item.nombre} (disponible: ${item.disponible}, solicitado: ${item.solicitado})`)
                .join("\n")}`,
            );
            cierreEnCursoRef.current = false;
            return;
          }

          for (const producto of productosEntregados) {
            const precioAtencion = Number(
              producto.precioAtencion ?? producto.precio ?? obtenerPrecioProducto(producto.idProducto),
            );
            if (!Number.isFinite(precioAtencion)) {
              Alert.alert("Error", `Precio inválido para el producto ${producto.idProducto}`);
              cierreEnCursoRef.current = false;
              return;
            }

            const precioGuardado = pedidosService.actualizarPrecioAtencion(
              folio,
              producto.idProducto,
              precioAtencion,
            );
            if (!precioGuardado) {
              Alert.alert("Error", `No se pudo guardar el precio del producto ${producto.idProducto}`);
              cierreEnCursoRef.current = false;
              return;
            }
          }

          const productosParaVenta = pedidosService.getProductosByFolio(folio);
          const result = pedidosService.finalizarPedido(folio, nuevoEstatus);

          if (result.success && result.idMovil) {
            try {
              await procesarCierreComoVenta(pedidoCerrado, productosParaVenta, result.idMovil);
              Alert.alert(
                "Éxito",
                nuevoEstatus === ESTATUS_PEDIDO.ENTREGADO ? "Entrega confirmada" : "Entrega parcial confirmada",
                [{ text: "OK", onPress: () => { salidaControlada.current = true; navigation.goBack(); } }],
              );
            } catch (error) {
              console.error(`[PedidoDetalle] Error al completar cierre como venta para folio ${folio}:`, error);
              Alert.alert(
                "Entrega confirmada",
                "El pedido se cerró, pero no se pudo completar la venta o el descuento de inventario. Verifica el registro antes de reintentar.",
                [{ text: "OK", onPress: () => { salidaControlada.current = true; navigation.goBack(); } }],
              );
            }
          } else if (result.success) {
            cierreEnCursoRef.current = false;
            Alert.alert("Error", "El pedido se cerró sin un id_movil válido; no se pudo registrar la venta");
          } else {
            cierreEnCursoRef.current = false;
            Alert.alert("Error", "No se pudo confirmar la entrega");
          }
        },
      },
    ]);
  };

  const obtenerPrecioProducto = (idProducto: number): number => {
    const pp = preciosPromo.find((p: any) => parseInt(p.claveProd || "0", 10) === idProducto);
    if (pp) return pp.precio || 0;
    const pl = preciosLista.find((p: any) => parseInt(p.claveProd || "0", 10) === idProducto);
    if (pl) return pl.precio || 0;
    const pd = preciosDefault.find((p: any) => parseInt(p.claveProd || "0", 10) === idProducto);
    if (pd) return pd.precio || 0;
    return 0;
  };

  const calcularResumen = () => {
    const totalSolicitado = productos.reduce((sum, p) => sum + p.cantPedido, 0);
    const totalEntregado = productos.reduce((sum, p) => sum + (p.cantAtencion || 0), 0);
    const conDiferencia = productos.filter((p) => (p.cantAtencion ?? 0) !== p.cantPedido).length;
    const importeSolicitado = productos.reduce(
      (sum, p) => sum + Number(p.precioAtencion ?? p.precio ?? obtenerPrecioProducto(p.idProducto)) * Number(p.cantPedido ?? 0),
      0,
    );
    const importeEntregado = productos.reduce(
      (sum, p) => sum + Number(p.precioAtencion ?? p.precio ?? obtenerPrecioProducto(p.idProducto)) * Number(p.cantAtencion ?? 0),
      0,
    );

    return { totalSolicitado, totalEntregado, conDiferencia, importeSolicitado, importeEntregado };
  };

  const asegurarEnCaptura = () => {
    const pedidosService = PedidosService.getInstance();
    pedidosService.setRealm((FullSyncService as any).realm);
    const pedidoActual = pedidosService.getPedidoByFolio(folio);
    if (pedidoActual && pedidoActual.estatus === ESTATUS_PEDIDO.EN_ATENCION) {
      const success = pedidosService.cambiarEstatusPedido(folio, ESTATUS_PEDIDO.EN_CAPTURA);
      if (success) {
        const pedidoActualizado = pedidosService.getPedidoByFolio(folio);
        if (pedidoActualizado) setPedido(pedidoActualizado);

        AuthService.restoreSession().then((user) => {
          if (!user) return;
          const idUsuario = Number(user?.id ?? user?.idUsuario ?? 1);
          FullSyncService.sendPendingPedidoEstadosToServer(idUsuario)
            .then((r) => console.log(`[PedidoDetalle] Arrastre estado pedidos EN_CAPTURA folio ${folio}:`, r))
            .catch((e) => console.warn("[PedidoDetalle] Error arrastre estado pedidos EN_CAPTURA:", e));
        }).catch((e) => console.warn("[PedidoDetalle] Error obteniendo sesion EN_CAPTURA:", e));
      }
    }
  };

  const actualizarCantidadLocal = (idProducto: number, cantidad: number) => {
    const pedidosService = PedidosService.getInstance();
    pedidosService.setRealm((FullSyncService as any).realm);
    const success = pedidosService.actualizarCantAtencion(folio, idProducto, cantidad);
    if (success) {
      const productosActualizados = pedidosService.getProductosByFolio(folio);
      setProductos(productosActualizados);
      asegurarEnCaptura();
    }
  };

  const ajustarCantidad = (idProducto: number, delta: number) => {
    const producto = productos.find((p) => p.idProducto === idProducto);
    if (!producto || soloLectura) return;
    const actual = producto.cantAtencion ?? 0;
    const nueva = Math.max(0, actual + delta);
    actualizarCantidadLocal(idProducto, nueva);
  };

  const entregarTodoProducto = (idProducto: number) => {
    const producto = productos.find((p) => p.idProducto === idProducto);
    if (!producto || soloLectura) return;
    actualizarCantidadLocal(idProducto, producto.cantPedido);
  };

  const entregarTodoPedido = () => {
    if (soloLectura) return;
    productos.forEach((p) => {
      actualizarCantidadLocal(p.idProducto, p.cantPedido);
    });
  };

  const renderProducto = ({ item }: { item: Pedido }) => {
    const cantAtencion = Number(item.cantAtencion ?? 0);
    const cantPedido = Number(item.cantPedido ?? 0);
    const tieneDiferencia = cantAtencion < cantPedido;
    const puedeRegistrarCausa = cantAtencion < cantPedido;
    const precioUnitario = Number(item.precioAtencion ?? item.precio ?? obtenerPrecioProducto(item.idProducto));
    const subtotal = precioUnitario * cantAtencion;

    return (
      <View style={[styles.productoCard, tieneDiferencia && styles.productoCardDiferencia]}>
        <View style={styles.productoHeader}>
        
          <View style={styles.productoHeaderInfo}>
            <Text style={styles.productoNombre} numberOfLines={2}>
              {item.productoNombre || `Producto #${item.idProducto}`}
            </Text>
            {esProductoAgregado(item) && (
              <Text style={styles.productoAgregadoText}>{PRODUCTO_AGREGADO_OBSERVACION}</Text>
            )}
          </View>
        </View>

        <View style={styles.cantidadesRow}>
          <View style={styles.cantidadItem}>
            <Text style={styles.cantidadLabel}>Atención</Text>
            {!puedeEditar ? (
              <Text style={styles.cantidadValor}>{cantAtencion}</Text>
            ) : (
              <View style={styles.cantidadStepper}>
                <TouchableOpacity
                  style={styles.stepperBtn}
                  onPress={() => ajustarCantidad(item.idProducto, -1)}
                >
                  <Icon name="remove" type="material" size={18} color="#fff" />
                </TouchableOpacity>
                <TextInput
                  key={`${item.idProducto}-${cantAtencion}`}
                  style={styles.cantidadInput}
                  defaultValue={cantAtencion.toString()}
                  onEndEditing={(e) => {
                    const num = parseFloat(e.nativeEvent.text) || 0;
                    const clamped = Math.max(0, num);
                    actualizarCantidadLocal(item.idProducto, clamped);
                  }}
                  keyboardType="decimal-pad"
                />
                <TouchableOpacity
                  style={styles.stepperBtn}
                  onPress={() => ajustarCantidad(item.idProducto, 1)}
                >
                  <Icon name="add" type="material" size={18} color="#fff" />
                </TouchableOpacity>
              </View>
            )}
          </View>

          {/* <View style={styles.cantidadItem}>
            <Text style={styles.cantidadLabel}>Diferencia</Text>
            <Text style={[styles.cantidadValor, tieneDiferencia && styles.diferenciaText]}>
              {item.cantPedido - cantAtencion}
            </Text>
          </View> */}
        </View>

        <View style={[styles.cantidadesRow, { marginTop: SPACING.s, paddingTop: SPACING.s, borderTopWidth: 1, borderTopColor: "#F0F0F0" }]}>
          <View style={styles.cantidadItem}>
            <Text style={styles.cantidadLabel}>Precio unitario</Text>
            <Text style={styles.cantidadValor}>${precioUnitario.toFixed(2)}</Text>
          </View>
          <View style={styles.cantidadItem}>
            <Text style={styles.cantidadLabel}>Subtotal</Text>
            <Text style={styles.cantidadValor}>${subtotal.toFixed(2)}</Text>
          </View>
        </View>

        {puedeEditar && (
          <View style={styles.productoAcciones}>
            {/* {!atendidoCompleto && (
              <TouchableOpacity style={styles.entregarTodoBtn} onPress={() => entregarTodoProducto(item.idProducto)}>
                <Icon name="check" type="material" size={14} color={COLORS.success} />
                <Text style={styles.entregarTodoBtnText}>Entregar todo</Text>
              </TouchableOpacity>
            )} */}
            {puedeRegistrarCausa && (
              <TouchableOpacity
                style={[styles.causaBtn, item.causaDiferencia ? styles.causaBtnRegistrada : undefined]}
                onPress={() => abrirModalCausa(item)}
              >
                <Icon name="label" type="material" size={16} color={item.causaDiferencia ? COLORS.success : COLORS.warning} />
                <Text style={[styles.causaBtnText, item.causaDiferencia ? styles.causaBtnTextRegistrada : undefined]}>
                  {item.causaDiferencia ? item.causaDiferenciaDesc : "Registrar causa"}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {tieneDiferencia && item.causaDiferencia && item.obserDiferencia && (
          <View style={styles.observacionCausa}>
            <Text style={styles.observacionCausaText}>{item.obserDiferencia}</Text>
          </View>
        )}
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.loadingText}>Cargando pedido...</Text>
      </View>
    );
  }

  if (!pedido) {
    return (
      <View style={styles.errorContainer}>
        <Icon name="error" type="material" size={64} color={COLORS.error} />
        <Text style={styles.errorText}>Pedido no encontrado</Text>
      </View>
    );
  }

  const resumen = calcularResumen();
  const pedidoEnProceso = pedido.estatus === ESTATUS_PEDIDO.EN_ATENCION || pedido.estatus === ESTATUS_PEDIDO.EN_CAPTURA;
  const puedeEditar = !soloLectura && (gpsValidado || pedidoEnProceso);
  const puedeConfirmar = !soloLectura && (gpsValidado || pedidoEnProceso);
  const clientePedido = FullSyncService.getClienteFullById(Number(pedido.cliente)) as any;
  const clienteTieneCredito = Boolean(clientePedido?.credito);

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scrollView}>
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <View>
              <Text style={styles.folioText}>Folio: {pedido.folio}</Text>
              <Text style={styles.estatusText}>{pedido.estatusDescripcion}</Text>
            </View>
            <View style={styles.estatusBadge}>
              <Icon
                name={
                  pedido.estatus === ESTATUS_PEDIDO.ENTREGADO
                    ? "check-circle"
                    : pedido.estatus === ESTATUS_PEDIDO.PENDIENTE_SIN_CAUSA
                    ? "error"
                    : "info"
                }
                type="material"
                size={24}
                color="#fff"
              />
            </View>
          </View>
        </View>

        <View style={styles.clienteCard}>
          <View style={styles.clienteRow}>
            <Icon name="person" type="material" size={28} color={COLORS.primary} />
            <View style={styles.clienteInfo}>
              <Text style={styles.clienteNombre}>{clienteNombre || `Cliente #${pedido.cliente}`}</Text>
              <Text style={styles.clienteId}>Cliente #{pedido.cliente}</Text>
            </View>
          </View>

          {clienteDireccion ? (
            <View style={styles.domicilioRow}>
              <Icon name="place" type="material" size={18} color={COLORS.muted} />
              <Text style={styles.domicilioText}>{clienteDireccion}</Text>
            </View>
          ) : null}

          {observaciones && (
            <View style={styles.observacionesCard}>
              <Icon name="notes" type="material" size={18} color={COLORS.warning} />
              <Text style={styles.observacionesText}>Observacion: {observaciones}</Text>
            </View>
          )}
        </View>

        {!soloLectura && !gpsValidado && !pedidoEnProceso && (
          <View style={styles.botonesRow}>
            {/* <TouchableOpacity style={[styles.gpsBtn, styles.btnMitad]} onPress={validarGPS} disabled={validandoGPS}>
              {validandoGPS ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Icon name="my-location" type="material" size={20} color="#fff" />
              )}
              <Text style={styles.gpsBtnText}>
                {validandoGPS ? "Validando..." : "Validar GPS"}
              </Text>
            </TouchableOpacity> */}

            <TouchableOpacity
              style={[styles.gpsBtn, styles.btnMitad, styles.iniciarBtn]}
              onPress={validarGPS}
              disabled={validandoGPS}
            >
              {validandoGPS ? (
                <>
                  <ActivityIndicator color="#fff" />
                  <Text style={styles.gpsBtnText}>
                    {progresoValidacion ? `GPS ±${Math.round(progresoValidacion.accuracy)}m` : "Validando..."}
                  </Text>
                </>
              ) : (
                <>
                  <Icon name="play-arrow" type="material" size={20} color="#fff" />
                  <Text style={styles.gpsBtnText}>Iniciar atención</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        )}

        {gpsValidado && (
          <View style={styles.gpsValidadoBadge}>
            <Icon name="check-circle" type="material" size={18} color={COLORS.success} />
            <Text style={styles.gpsValidadoText}>Ubicación validada</Text>
          </View>
        )}


        <View style={styles.productosTitleRow}>
          <Text style={styles.productosTitle}>Productos del Pedido</Text>
          {puedeEditar && (
            <TouchableOpacity style={styles.agregarProductoBtn} onPress={abrirModalProductos}>
              <Icon name="add" type="material" size={18} color="#fff" />
              <Text style={styles.agregarProductoBtnText}>Agregar</Text>
            </TouchableOpacity>
          )}
        </View>

        <FlatList
          data={productos}
          renderItem={renderProducto}
          keyExtractor={(item) => item.id}
          scrollEnabled={false}
          contentContainerStyle={styles.productosList}
        />

        {puedeConfirmar && (
          <View style={styles.paymentCard}>
            <Text style={styles.paymentTitle}>Medio de pago</Text>
            <View style={styles.paymentOptionsRow}>
              {formasPago.map((forma: any) => {
                const disabled = Boolean(forma.credito) && !clienteTieneCredito;
                return (
                  <PayChipPedido
                    key={forma.tipo}
                    label={forma.descripcion || `Tipo ${forma.tipo}`}
                    selected={metodoPago === forma.tipo}
                    disabled={disabled}
                    onPress={() => setMetodoPago(forma.tipo)}
                  />
                );
              })}
            </View>
            <View style={styles.paymentTotalRow}>
              <Text style={styles.paymentTotalLabel}>Total</Text>
              <Text style={styles.paymentTotalValue}>
                {formasPago.find((forma: any) => forma.tipo === metodoPago)?.pago0
                  ? "$0.00"
                  : `$${resumen.importeEntregado.toFixed(2)}`}
              </Text>
            </View>
          </View>
        )}
      </ScrollView>

      {puedeConfirmar && (
        <View style={styles.footer}>
          <TouchableOpacity style={styles.noAtencionBtn} onPress={abrirModalNoAtencion}>
            <Icon name="cancel" type="material" size={20} color="#fff" />
            <Text style={styles.noAtencionBtnText}>No Atender</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.confirmarBtn} onPress={confirmarEntrega}>
            <Icon name="check" type="material" size={20} color="#fff" />
            <Text style={styles.confirmarBtnText}>Confirmar Entrega</Text>
          </TouchableOpacity>
        </View>
      )}

      <Modal visible={modalCausaVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Icon name="label" type="material" size={24} color={COLORS.warning} />
              <Text style={styles.modalTitle}>Causa de Diferencia</Text>
            </View>

            {productoSeleccionado && (
              <View style={styles.productoInfoModal}>
                <Text style={styles.productoInfoNombre}>{productoSeleccionado.productoNombre}</Text>
                { /*<Text style={styles.productoInfoCantidad}>
                  Solicitado: {productoSeleccionado.cantPedido} | Entregado: {productoSeleccionado.cantAtencion || 0}
                </Text>*/ }
              </View>
            )}

            <Text style={styles.modalLabel}>Seleccione el motivo:</Text>

            <ScrollView style={styles.causasList}>
              {causasDiferencia.map((causa) => (
                <TouchableOpacity
                  key={causa.id}
                  style={[styles.causaOption, causaSeleccionada === causa.id && styles.causaOptionSelected]}
                  onPress={() => setCausaSeleccionada(causa.id)}
                >
                  <Icon
                    name={causaSeleccionada === causa.id ? "radio-button-checked" : "radio-button-unchecked"}
                    type="material"
                    size={22}
                    color={causaSeleccionada === causa.id ? COLORS.primary : COLORS.muted}
                  />
                  <Text style={[styles.causaOptionText, causaSeleccionada === causa.id && styles.causaOptionTextSelected]}>
                    {causa.descripcion}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <Text style={styles.modalLabel}>Observaciones:</Text>
            <TextInput
              style={styles.observacionInput}
              value={observacionCausa}
              onChangeText={setObservacionCausa}
              placeholder="Agregar observación..."
              multiline
              numberOfLines={3}
            />

            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalBtnCancel} onPress={() => setModalCausaVisible(false)}>
                <Text style={styles.modalBtnCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalBtnConfirm} onPress={confirmarCausaDiferencia}>
                <Text style={styles.modalBtnConfirmText}>Confirmar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={modalNoAtencionVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Icon name="cancel" type="material" size={24} color={COLORS.error} />
              <Text style={styles.modalTitle}>No Atender Pedido</Text>
            </View>

            <View style={styles.productoInfoModal}>
              <Text style={styles.productoInfoNombre}>{pedido.clienteNombre}</Text>
              <Text style={styles.productoInfoCantidad}>Folio: {pedido.folio}</Text>
            </View>

            <Text style={styles.modalLabel}>Seleccione el motivo:</Text>

            <ScrollView style={styles.causasList}>
              {causasNoAtencion.map((causa) => (
                <TouchableOpacity
                  key={causa.id}
                  style={[styles.causaOption, causaNoAtencionSel === causa.id && styles.causaOptionSelected]}
                  onPress={() => setCausaNoAtencionSel(causa.id)}
                >
                  <Icon
                    name={causaNoAtencionSel === causa.id ? "radio-button-checked" : "radio-button-unchecked"}
                    type="material"
                    size={22}
                    color={causaNoAtencionSel === causa.id ? COLORS.error : COLORS.muted}
                  />
                  <Text
                    style={[
                      styles.causaOptionText,
                      causaNoAtencionSel === causa.id && { color: COLORS.error },
                    ]}
                  >
                    {causa.descripcion}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <Text style={styles.modalLabel}>Observaciones:</Text>
            <TextInput
              style={styles.observacionInput}
              value={observacionNoAtencion}
              onChangeText={setObservacionNoAtencion}
              placeholder="Agregar observación..."
              multiline
              numberOfLines={3}
            />

            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalBtnCancel} onPress={() => setModalNoAtencionVisible(false)}>
                <Text style={styles.modalBtnCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtnConfirm, { backgroundColor: COLORS.error }]} onPress={confirmarNoAtencion}>
                <Text style={styles.modalBtnConfirmText}>Confirmar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={productoModalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Icon name="add-shopping-cart" type="material" size={24} color={COLORS.primary} />
              <Text style={styles.modalTitle}>Agregar producto</Text>
            </View>

            <View style={styles.productSearchContainer}>
              <Icon name="search" type="material" size={20} color={COLORS.muted} />
              <TextInput
                style={styles.productSearchInput}
                placeholder="Buscar por descripción o clave..."
                placeholderTextColor={COLORS.muted}
                value={searchProductoQuery}
                onChangeText={(query) => {
                  setSearchProductoQuery(query);
                  filtrarProductosDisponibles(query);
                }}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {searchProductoQuery.length > 0 && (
                <TouchableOpacity
                  onPress={() => {
                    setSearchProductoQuery("");
                    filtrarProductosDisponibles("");
                  }}
                >
                  <Icon name="close" type="material" size={20} color={COLORS.muted} />
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.productResultsHeader}>
              <Text style={styles.productResultsText}>
                {filteredProductosDisponibles.length} producto{filteredProductosDisponibles.length === 1 ? "" : "s"}
              </Text>
              <TouchableOpacity
                style={[styles.promotionsFilterBtn, showOnlyPromotions && styles.promotionsFilterBtnActive]}
                onPress={() => {
                  const nextValue = !showOnlyPromotions;
                  setShowOnlyPromotions(nextValue);
                  filtrarProductosDisponibles(searchProductoQuery, nextValue);
                }}
              >
                <Text style={[styles.promotionsFilterText, showOnlyPromotions && styles.promotionsFilterTextActive]}>
                  {showOnlyPromotions ? "Todos" : "Promociones o combos"}
                </Text>
              </TouchableOpacity>
            </View>

            <FlatList
              data={filteredProductosDisponibles}
              keyExtractor={(item) => String(item.id)}
              style={styles.productResultsList}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.productResultItem} onPress={() => agregarProductoAlPedido(item)}>
                  <View style={styles.productResultInfo}>
                    <Text style={styles.productResultName} numberOfLines={2}>{item.descripcion}</Text>
                    <Text style={styles.productResultSubtitle}>Clave: {item.claveProd} · Existencia: {item.existencia}</Text>
                    {item.esPromocion && <Text style={styles.productResultPromo}>Precio especial</Text>}
                    {item.usandoPrecioDefault && !item.esPromocion && (
                      <Text style={styles.productResultDefault}>(DOMIC.)</Text>
                    )}
                  </View>
                  <Text
                    style={[
                      styles.productResultPrice,
                      item.esPromocion && styles.productResultPricePromo,
                      item.usandoPrecioDefault && !item.esPromocion && styles.productResultPriceDefault,
                    ]}
                  >
                    ${item.precio.toFixed(2)}
                  </Text>
                </TouchableOpacity>
              )}
              ListEmptyComponent={<Text style={styles.emptyProductResults}>No se encontraron productos</Text>}
            />

            <TouchableOpacity
              style={styles.secondaryModalBtn}
              onPress={() => {
                setProductoModalVisible(false);
                setSearchProductoQuery("");
                setShowOnlyPromotions(false);
              }}
            >
              <Text style={styles.secondaryModalBtnText}>Cerrar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <IntercambioEnvaseModal
        visible={intercambioModalOpen}
        cantidad={pendingIntercambioCantidad}
        costoAutomatico={costoIntercambioCalculado}
        envaseEntregadoClave={envaseIntercambioClaveRef.current}
        envaseEntregadoDesc={envaseIntercambioDescRef.current}
        productoId={pendingIntercambioProducto?.id}
        onAccept={(data) => {
          const dataObj: IntercambioData = {
            envaseEntregadoClave: data.envaseEntregadoClave,
            envaseEntregadoDesc: data.envaseEntregadoDesc,
            envaseRecibidoClave: data.envaseRecibidoClave,
            envaseRecibidoDesc: data.envaseRecibidoDesc,
            envaseRecibidoId: data.envaseRecibidoId,
            kitIntercambioProductoId: data.kitIntercambioProductoId,
            precioEnvase: data.precioEnvase,
            observacion: data.observacion,
            costo: data.costo,
            cantRecEnvOtro: data.cantRecEnvOtro,
          };
          intercambioDataRef.current = dataObj;
          setIntercambioData(dataObj);

          const productoIntercambio = pendingIntercambioProducto;
          if (productoIntercambio) {
            const intercambioGuardado = guardarProductoEnPedido(productoIntercambio, data.costo, 1, false);

            const precioEnvase = Number(data.precioEnvase);
            const cantidadEnvases = Number(data.cantRecEnvOtro) > 0 ? Number(data.cantRecEnvOtro) : 1;
            if (intercambioGuardado && Number.isFinite(precioEnvase) && precioEnvase > 0) {
              const productoEnvase = FullSyncService.getProductos(100000).find((producto: any) => Number(producto.id) === 76);
              guardarProductoEnPedido(
                {
                  id: 76,
                  claveProd: String(productoEnvase?.claveProd || "76"),
                  descripcion: productoEnvase?.descripcion || "ENVASE",
                  precio: precioEnvase,
                  existencia: 9999,
                },
                precioEnvase,
                cantidadEnvases,
                false,
              );
            }
          }

          setPendingIntercambioProducto(null);
          setPendingIntercambioCantidad(0);
          setIntercambioModalOpen(false);
        }}
        onCancel={() => {
          setPendingIntercambioProducto(null);
          setPendingIntercambioCantidad(0);
          setIntercambioModalOpen(false);
        }}
      />

      <PrestamoEnvaseModal
        visible={prestamoModalOpen}
        clienteNombre={clienteNombre || `Cliente #${pedido.cliente}`}
        cantidad={pendingPrestamoCantidad}
        productoSeleccionado={pendingPrestamoProducto}
        onAccept={(data) => {
          setPrestamoData(data);
          if (pendingPrestamoProducto) {
            guardarProductoEnPedido(pendingPrestamoProducto, pendingPrestamoProducto.precio, 1, false);
          }
          setPendingPrestamoProducto(null);
          setPendingPrestamoCantidad(0);
          setPrestamoModalOpen(false);
        }}
        onCancel={() => {
          setPendingPrestamoProducto(null);
          setPendingPrestamoCantidad(0);
          setPrestamoModalOpen(false);
        }}
      />

      <ModalDiagnosticoGps
        visible={diagnosticoGps !== null}
        data={diagnosticoGps}
        onClose={() => setDiagnosticoGps(null)}
      />
    </View>
  );
}

function PayChipPedido({
  label,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.paymentChip, selected && styles.paymentChipSelected, disabled && styles.paymentChipDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[styles.paymentChipText, selected && styles.paymentChipTextSelected]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F2F2F7",
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  loadingText: {
    ...TYPOGRAPHY.body,
    marginTop: SPACING.m,
    color: COLORS.muted,
  },
  errorContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  errorText: {
    ...TYPOGRAPHY.body,
    marginTop: SPACING.m,
    color: COLORS.error,
  },
  scrollView: {
    flex: 1,
  },
  header: {
    backgroundColor: COLORS.primary,
    padding: SPACING.m,
    borderBottomLeftRadius: BORDER_RADIUS.xl,
    borderBottomRightRadius: BORDER_RADIUS.xl,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  folioText: {
    ...TYPOGRAPHY.h3,
    color: "#fff",
    fontSize: 20,
  },
  estatusText: {
    ...TYPOGRAPHY.caption,
    color: "rgba(255,255,255,0.8)",
    marginTop: SPACING.xs,
  },
  estatusBadge: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(255,255,255,0.2)",
    justifyContent: "center",
    alignItems: "center",
  },
  clienteCard: {
    backgroundColor: "#fff",
    margin: SPACING.m,
    padding: SPACING.m,
    borderRadius: BORDER_RADIUS.l,
    ...SHADOWS.medium,
  },
  clienteRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.m,
  },
  clienteInfo: {
    flex: 1,
  },
  clienteNombre: {
    ...TYPOGRAPHY.h3,
    fontSize: 18,
  },
  clienteId: {
    ...TYPOGRAPHY.caption,
    color: COLORS.muted,
  },
  domicilioRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: SPACING.s,
    marginTop: SPACING.m,
    paddingTop: SPACING.m,
    borderTopWidth: 1,
    borderTopColor: "#F0F0F0",
  },
  domicilioText: {
    ...TYPOGRAPHY.body,
    flex: 1,
    fontSize: 14,
    color: COLORS.textSecondary,
  },
  observacionesCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: SPACING.s,
    marginTop: SPACING.m,
    padding: SPACING.m,
    backgroundColor: "#FFF8E1",
    borderRadius: BORDER_RADIUS.m,
  },
  observacionesText: {
    ...TYPOGRAPHY.caption,
    flex: 1,
    fontStyle: "italic",
    color: COLORS.warning,
  },
  gpsBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.info,
    marginHorizontal: SPACING.m,
    padding: SPACING.m,
    borderRadius: BORDER_RADIUS.m,
    gap: SPACING.s,
    ...SHADOWS.small,
  },
  botonesRow: {
    flexDirection: "row",
    gap: SPACING.s,
    marginHorizontal: SPACING.m,
    marginVertical: SPACING.s,
  },
  btnMitad: {
    flex: 1,
    marginHorizontal: 0,
    padding: SPACING.m,
  },
  iniciarBtn: {
    backgroundColor: COLORS.success,
  },
  gpsBtnText: {
    color: "#fff",
    fontWeight: "600",
  },
  gpsValidadoBadge: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#E8F5E9",
    marginHorizontal: SPACING.m,
    padding: SPACING.s,
    borderRadius: BORDER_RADIUS.m,
    gap: SPACING.s,
  },
  gpsValidadoText: {
    color: COLORS.success,
    fontWeight: "600",
    fontSize: 14,
  },
  resumenCard: {
    backgroundColor: "#fff",
    margin: SPACING.m,
    padding: SPACING.m,
    borderRadius: BORDER_RADIUS.l,
    ...SHADOWS.small,
  },
  resumenTitle: {
    ...TYPOGRAPHY.h3,
    fontSize: 16,
    marginBottom: SPACING.m,
  },
  resumenRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: SPACING.xs,
  },
  resumenLabel: {
    ...TYPOGRAPHY.body,
    fontSize: 14,
    color: COLORS.textSecondary,
  },
  resumenValor: {
    ...TYPOGRAPHY.body,
    fontSize: 14,
    fontWeight: "600",
  },
  alertaDiferencia: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.s,
    backgroundColor: "#FFF8E1",
    padding: SPACING.m,
    borderRadius: BORDER_RADIUS.m,
    marginTop: SPACING.m,
  },
  alertaDiferenciaText: {
    ...TYPOGRAPHY.body,
    flex: 1,
    fontSize: 13,
    color: COLORS.warning,
    fontWeight: "600",
  },
  productosTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: SPACING.m,
    marginRight: SPACING.m,
  },
  productosTitle: {
    ...TYPOGRAPHY.h3,
    fontSize: 16,
    marginLeft: SPACING.m,
    marginBottom: SPACING.s,
  },
  agregarProductoBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.xs,
    backgroundColor: COLORS.primary,
    paddingHorizontal: SPACING.s,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.m,
  },
  agregarProductoBtnText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 13,
  },
  productoHeaderInfo: {
    flex: 1,
  },
  productoAgregadoText: {
    color: COLORS.info,
    fontSize: 11,
    fontWeight: "600",
    marginTop: SPACING.xs,
  },
  productosList: {
    paddingHorizontal: SPACING.m,
    paddingBottom: SPACING.xxl,
  },
  productoCard: {
    backgroundColor: "#fff",
    padding: SPACING.m,
    borderRadius: BORDER_RADIUS.l,
    marginBottom: SPACING.m,
    ...SHADOWS.small,
  },
  productoCardDiferencia: {
    borderLeftWidth: 4,
    borderLeftColor: COLORS.warning,
  },
  productoHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: SPACING.s,
    marginBottom: SPACING.m,
  },
  productoNombre: {
    ...TYPOGRAPHY.body,
    flex: 1,
    fontWeight: "600",
    fontSize: 15,
  },
  cantidadesRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: SPACING.s,
  },
  cantidadItem: {
    alignItems: "center",
    flex: 1,
  },
  cantidadLabel: {
    ...TYPOGRAPHY.caption,
    fontSize: 11,
    color: COLORS.muted,
    marginBottom: SPACING.xs,
  },
  cantidadValor: {
    ...TYPOGRAPHY.h3,
    fontSize: 18,
    color: COLORS.primary,
  },
  cantidadInput: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: BORDER_RADIUS.s,
    padding: SPACING.s,
    minWidth: 50,
    textAlign: "center",
    fontSize: 16,
    fontWeight: "600",
    color: COLORS.primary,
    marginHorizontal: SPACING.xs,
  },
  cantidadStepper: {
    flexDirection: "row",
    alignItems: "center",
  },
  stepperBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.primary,
    justifyContent: "center",
    alignItems: "center",
  },
  productoAcciones: {
    flexDirection: "row",
    gap: SPACING.s,
    marginTop: SPACING.s,
  },
  entregarTodoBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#E8F5E9",
    paddingHorizontal: SPACING.s,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.m,
    gap: SPACING.xs,
    flex: 1,
  },
  entregarTodoBtnText: {
    color: COLORS.success,
    fontWeight: "600",
    fontSize: 12,
  },
  entregarTodoPedidoBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.success,
    padding: SPACING.m,
    borderRadius: BORDER_RADIUS.m,
    gap: SPACING.s,
    marginTop: SPACING.m,
  },
  entregarTodoPedidoBtnText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 14,
  },
  diferenciaText: {
    color: COLORS.warning,
  },
  causaBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFF8E1",
    padding: SPACING.s,
    borderRadius: BORDER_RADIUS.m,
    gap: SPACING.s,
    marginTop: SPACING.s,
    flex: 1,
  },
  causaBtnRegistrada: {
    backgroundColor: "#E8F5E9",
  },
  causaBtnText: {
    color: COLORS.warning,
    fontWeight: "600",
    fontSize: 13,
  },
  causaBtnTextRegistrada: {
    color: COLORS.success,
  },
  observacionCausa: {
    backgroundColor: "#F5F5F5",
    padding: SPACING.s,
    borderRadius: BORDER_RADIUS.s,
    marginTop: SPACING.s,
  },
  observacionCausaText: {
    ...TYPOGRAPHY.caption,
    fontSize: 12,
    fontStyle: "italic",
  },
  paymentCard: {
    backgroundColor: "#fff",
    marginHorizontal: SPACING.m,
    marginBottom: SPACING.m,
    padding: SPACING.m,
    borderRadius: BORDER_RADIUS.l,
    ...SHADOWS.small,
  },
  paymentTitle: {
    ...TYPOGRAPHY.h3,
    fontSize: 16,
    marginBottom: SPACING.s,
  },
  paymentOptionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: SPACING.s,
  },
  paymentChip: {
    borderWidth: 1,
    borderColor: COLORS.primary,
    borderRadius: BORDER_RADIUS.l,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
  },
  paymentChipSelected: {
    backgroundColor: COLORS.primary,
  },
  paymentChipDisabled: {
    opacity: 0.4,
  },
  paymentChipText: {
    color: COLORS.primary,
    fontSize: 13,
    fontWeight: "600",
  },
  paymentChipTextSelected: {
    color: "#fff",
  },
  paymentTotalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: SPACING.m,
    paddingTop: SPACING.s,
    borderTopWidth: 1,
    borderTopColor: "#F0F0F0",
  },
  paymentTotalLabel: {
    ...TYPOGRAPHY.body,
    fontWeight: "600",
  },
  paymentTotalValue: {
    ...TYPOGRAPHY.h3,
    color: COLORS.primary,
  },
  footer: {
    flexDirection: "row",
    padding: SPACING.m,
    gap: SPACING.m,
    backgroundColor: "#fff",
    borderTopWidth: 1,
    borderTopColor: "#E0E0E0",
  },
  noAtencionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.error,
    padding: SPACING.m,
    borderRadius: BORDER_RADIUS.m,
    gap: SPACING.s,
  },
  noAtencionBtnText: {
    color: "#fff",
    fontWeight: "600",
  },
  confirmarBtn: {
    flex: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.success,
    padding: SPACING.m,
    borderRadius: BORDER_RADIUS.m,
    gap: SPACING.s,
  },
  confirmarBtnText: {
    color: "#fff",
    fontWeight: "600",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modalContent: {
    backgroundColor: "#fff",
    borderTopLeftRadius: BORDER_RADIUS.xl,
    borderTopRightRadius: BORDER_RADIUS.xl,
    padding: SPACING.l,
    maxHeight: "80%",
  },
  productSearchContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.s,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: BORDER_RADIUS.m,
    paddingHorizontal: SPACING.s,
    marginBottom: SPACING.s,
  },
  productSearchInput: {
    flex: 1,
    minHeight: 42,
    color: COLORS.textPrimary,
  },
  productResultsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: SPACING.s,
  },
  productResultsText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.muted,
  },
  promotionsFilterBtn: {
    borderWidth: 1,
    borderColor: COLORS.primary,
    borderRadius: BORDER_RADIUS.m,
    paddingHorizontal: SPACING.s,
    paddingVertical: SPACING.xs,
  },
  promotionsFilterBtnActive: {
    backgroundColor: COLORS.primary,
  },
  promotionsFilterText: {
    color: COLORS.primary,
    fontSize: 12,
    fontWeight: "600",
  },
  promotionsFilterTextActive: {
    color: "#fff",
  },
  productResultsList: {
    minHeight: 180,
  },
  productResultItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: SPACING.s,
    borderBottomWidth: 1,
    borderBottomColor: "#F0F0F0",
    gap: SPACING.s,
  },
  productResultInfo: {
    flex: 1,
  },
  productResultName: {
    ...TYPOGRAPHY.body,
    fontWeight: "600",
  },
  productResultSubtitle: {
    ...TYPOGRAPHY.caption,
    color: COLORS.muted,
    marginTop: SPACING.xs,
  },
  productResultPromo: {
    color: COLORS.success,
    fontSize: 11,
    fontWeight: "600",
    marginTop: SPACING.xs,
  },
  productResultDefault: {
    color: "#FF6F00",
    fontSize: 11,
    fontWeight: "600",
    marginTop: SPACING.xs,
    fontStyle: "italic",
  },
  productResultPrice: {
    ...TYPOGRAPHY.body,
    color: COLORS.primary,
    fontWeight: "700",
  },
  productResultPricePromo: {
    color: "#E91E63",
    fontWeight: "900",
  },
  productResultPriceDefault: {
    color: "#FF6F00",
  },
  emptyProductResults: {
    ...TYPOGRAPHY.body,
    color: COLORS.muted,
    textAlign: "center",
    paddingVertical: SPACING.xl,
  },
  secondaryModalBtn: {
    alignItems: "center",
    backgroundColor: "#F1F3F5",
    padding: SPACING.m,
    borderRadius: BORDER_RADIUS.m,
    marginTop: SPACING.s,
  },
  secondaryModalBtnText: {
    color: COLORS.textPrimary,
    fontWeight: "600",
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.s,
    marginBottom: SPACING.m,
  },
  modalTitle: {
    ...TYPOGRAPHY.h3,
    fontSize: 18,
  },
  productoInfoModal: {
    backgroundColor: "#F5F5F5",
    padding: SPACING.m,
    borderRadius: BORDER_RADIUS.m,
    marginBottom: SPACING.m,
  },
  productoInfoNombre: {
    ...TYPOGRAPHY.body,
    fontWeight: "600",
    fontSize: 15,
  },
  productoInfoCantidad: {
    ...TYPOGRAPHY.caption,
    color: COLORS.textSecondary,
    marginTop: SPACING.xs,
  },
  modalLabel: {
    ...TYPOGRAPHY.body,
    fontWeight: "600",
    fontSize: 14,
    marginBottom: SPACING.s,
    marginTop: SPACING.m,
  },
  causasList: {
    maxHeight: 200,
  },
  causaOption: {
    flexDirection: "row",
    alignItems: "center",
    padding: SPACING.m,
    borderRadius: BORDER_RADIUS.m,
    gap: SPACING.m,
    marginBottom: SPACING.s,
    backgroundColor: "#F5F5F5",
  },
  causaOptionSelected: {
    backgroundColor: "#E3F2FD",
  },
  causaOptionText: {
    ...TYPOGRAPHY.body,
    fontSize: 14,
    flex: 1,
  },
  causaOptionTextSelected: {
    color: COLORS.primary,
    fontWeight: "600",
  },
  observacionInput: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: BORDER_RADIUS.m,
    padding: SPACING.m,
    minHeight: 80,
    textAlignVertical: "top",
  },
  modalButtons: {
    flexDirection: "row",
    gap: SPACING.m,
    marginTop: SPACING.l,
  },
  modalBtnCancel: {
    flex: 1,
    padding: SPACING.m,
    borderRadius: BORDER_RADIUS.m,
    backgroundColor: "#F5F5F5",
    alignItems: "center",
  },
  modalBtnCancelText: {
    color: COLORS.textSecondary,
    fontWeight: "600",
  },
  modalBtnConfirm: {
    flex: 1,
    padding: SPACING.m,
    borderRadius: BORDER_RADIUS.m,
    backgroundColor: COLORS.primary,
    alignItems: "center",
  },
  modalBtnConfirmText: {
    color: "#fff",
    fontWeight: "600",
  },
});
