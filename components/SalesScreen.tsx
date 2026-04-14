import React, { useMemo, useState, useEffect, useCallback, useRef } from "react";
import { useFocusEffect } from "@react-navigation/native";
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
import VisitaSyncService from "../services/VisitaSyncService";
import DetalleVisitasService from "../services/DetalleVisitasService";
import ReubicacionService from "../services/ReubicacionService";
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
  metros?: number; // Distancia máxima permitida en metros
};

type Producto = {
  id: number;
  claveProd: string;
  descripcion: string;
  nombre?: string; // Nombre del producto para logs
  precio: number;
  existencia: number;
  esKit?: boolean;
  intercambio?: boolean;
  prestamo?: boolean;
  usandoPrecioDefault?: boolean;
  esPromocion?: boolean;
};

type CartItem = Producto & { cantidad: number };

export default function SalesScreen({ route }: { route?: any }) {
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [productos, setProductos] = useState<Producto[]>([]);
  const [filteredClientes, setFilteredClientes] = useState<Cliente[]>([]);
  const [filteredProductos, setFilteredProductos] = useState<Producto[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchProductoQuery, setSearchProductoQuery] = useState("");
  const [showOnlyPromotions, setShowOnlyPromotions] = useState(false);

  const [clienteModalOpen, setClienteModalOpen] = useState(false);
  const [productoModalOpen, setProductoModalOpen] = useState(false);
  const [visitaConfirmModalOpen, setVisitaConfirmModalOpen] = useState(false);
  const [clientePendienteVisita, setClientePendienteVisita] = useState<Cliente | null>(null);

  const [selectedClient, setSelectedClient] = useState<Cliente | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [quantityInputs, setQuantityInputs] = useState<{ [id: number]: string }>({});

  const [metodoPago, setMetodoPago] = useState<number | null>(null);
  const [formasPago, setFormasPago] = useState<any[]>([]);
  const [printerConnected, setPrinterConnected] = useState(false);
  const [printerName, setPrinterName] = useState<string>("");
  const [currentUser, setCurrentUser] = useState<Usuario | null>(null);
  const [currentSucursal, setCurrentSucursal] = useState<number>(0);
  const [initializingPrinter, setInitializingPrinter] = useState(true);
  const [kits, setKits] = useState<any[]>([]);
  const [productosBase, setProductosBase] = useState<any[]>([]);
  const [processingVenta, setProcessingVenta] = useState(false);
  const [clientesEntregaDia, setClientesEntregaDia] = useState<Cliente[]>([]);
  const [currentDetalleVisitaId, setCurrentDetalleVisitaId] = useState<string | null>(null);
  const [validandoUbicacion, setValidandoUbicacion] = useState(false);
  const [userMetros, setUserMetros] = useState<number | null>(null);

  // Tabs del modal de clientes: 'agendados' | 'cercanos' | 'todos'
  const [clienteTabActivo, setClienteTabActivo] = useState<"agendados" | "cercanos" | "todos">("agendados");
  const [userCoords, setUserCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [nearestClientes, setNearestClientes] = useState<(Cliente & { distanciaMetros: number })[]>([]);
  const [loadingCercanos, setLoadingCercanos] = useState(false);
  const [loadingAgendados, setLoadingAgendados] = useState(false);
  const [usuarioPermisoReubicacion, setUsuarioPermisoReubicacion] = useState(false);
  const [reubicandoCliente, setReubicandoCliente] = useState(false);

  // Visitar flow (tipo visita modal, como CumplimientoScreen)
  const [tipoVisitaModalOpen, setTipoVisitaModalOpen] = useState(false);
  const [clienteParaVisitar, setClienteParaVisitar] = useState<Cliente | null>(null);
  const [tipoVisitaSeleccionado, setTipoVisitaSeleccionado] = useState<number | null>(null);
  const [visitasDelDiaIds, setVisitasDelDiaIds] = useState<Set<number>>(new Set());
  const [visitasDelDiaMap, setVisitasDelDiaMap] = useState<Map<number, any>>(new Map());

  // Intercambio de envases (dinámico por bit intercambio)
  const [intercambioModalOpen, setIntercambioModalOpen] = useState(false);
  const envaseIntercambioClaveRef = useRef<number | undefined>(undefined);
  const envaseIntercambioDescRef = useRef<string | undefined>(undefined);
  const [intercambioData, setIntercambioData] = useState<{
    envaseEntregadoClave: number;
    envaseEntregadoDesc: string;
    envaseRecibidoClave: number;
    envaseRecibidoDesc: string;
    observacion: string;
    costo: number;
  } | null>(null);
  const intercambioDataRef = useRef<{
    envaseEntregadoClave: number;
    envaseEntregadoDesc: string;
    envaseRecibidoClave: number;
    envaseRecibidoDesc: string;
    observacion: string;
    costo: number;
  } | null>(null);
  const [pendingIntercambioCantidad, setPendingIntercambioCantidad] = useState(0);
  const [costoIntercambioCalculado, setCostoIntercambioCalculado] = useState(0);

  // Prestamo de envases
  const [prestamoModalOpen, setPrestamoModalOpen] = useState(false);
  const [prestamoData, setPrestamoData] = useState<{
    idProdPrestado: number;
    claveProdPrestado: number;
    descProdPrestado: string;
    observacion: string;
    fechaDevolucion: string;
  } | null>(null);
  const [pendingPrestamoCantidad, setPendingPrestamoCantidad] = useState(0);
  const [pendingPrestamoProducto, setPendingPrestamoProducto] = useState<Producto | null>(null);

  // Ref para evitar que el useEffect de route.params se ejecute dos veces
  const clienteParamsProcessed = useRef(false);

  const obtenerPrecioProducto = useCallback(
    (idProducto: number, preciosPromo?: any[], preciosCliente?: any[], preciosDefault?: any[]): number => {
      // JERARQUÍA DE PRECIOS (igual que en buildProductosFormateados):
      // 1. Precio promocional (PrecioPromo)
      // 2. Precio de lista del cliente (Precio)
      // 3. Precio por defecto (lista 13 - DOMIC.)
      // NOTA: En la tabla Precio, el campo claveProd contiene el ID del producto, no la clave_prod

      console.log(`[obtenerPrecioProducto] 🔍 Buscando precio para producto ID: ${idProducto}`);
      console.log(`[obtenerPrecioProducto] Precios promo disponibles: ${preciosPromo?.length || 0}`);
      console.log(`[obtenerPrecioProducto] Precios cliente disponibles: ${preciosCliente?.length || 0}`);
      console.log(`[obtenerPrecioProducto] Precios default disponibles: ${preciosDefault?.length || 0}`);

      // Mapa de precios promocionales
      if (preciosPromo) {
        const precioPromo = preciosPromo.find((p: any) => parseInt(p.claveProd || "0", 10) === idProducto);
        if (precioPromo) {
          console.log(`[obtenerPrecioProducto] ✅ Encontrado precio PROMO: $${precioPromo.precio}`);
          return precioPromo.precio || 0;
        }
      }

      // Mapa de precios del cliente
      if (preciosCliente) {
        const precioCliente = preciosCliente.find((p: any) => parseInt(p.claveProd || "0", 10) === idProducto);
        if (precioCliente) {
          console.log(`[obtenerPrecioProducto] ✅ Encontrado precio CLIENTE: $${precioCliente.precio}`);
          return precioCliente.precio || 0;
        }
      }

      // Precio por defecto
      if (preciosDefault) {
        const precioDefault = preciosDefault.find((p: any) => parseInt(p.claveProd || "0", 10) === idProducto);
        if (precioDefault) {
          console.log(`[obtenerPrecioProducto] ✅ Encontrado precio DEFAULT: $${precioDefault.precio}`);
          return precioDefault.precio || 0;
        }
      }

      console.warn(`[obtenerPrecioProducto] ⚠️ NO se encontró precio para producto ID ${idProducto}`);
      return 0;
    },
    [],
  );

  const buildProductosFormateados = useCallback(
    (
      preciosSource: any[],
      productosData: any[],
      inventarioData: any[],
      kitsData: any[],
      preciosDefault?: any[],
      preciosPromo?: any[],
    ): Producto[] => {
      console.log({ productosData });
      // DEBUG intercambio
      const prodsIntercambio = productosData.filter((p: any) => p.intercambio);
      console.log(`[Sales] DEBUG productos con intercambio=true: ${prodsIntercambio.length}`);
      prodsIntercambio.forEach((p: any) =>
        console.log(
          `[Sales] DEBUG intercambio: id=${p.id}, clave=${p.claveProd}, desc=${p.descripcion}, intercambio=${p.intercambio}`,
        ),
      );
      console.log(`[Sales] DEBUG total kits en kitsData: ${kitsData.length}`);
      const kitsConEnvase = kitsData.filter((k: any) => k.envaseIntercambio);
      console.log(`[Sales] DEBUG kits con envaseIntercambio=true: ${kitsConEnvase.length}`);
      kitsConEnvase.forEach((k: any) =>
        console.log(
          `[Sales] DEBUG kit envaseIntercambio: id=${k.id}, idProducto=${k.idProducto}, idInsumo=${k.idInsumo}, envaseIntercambio=${k.envaseIntercambio}`,
        ),
      );
      // Buscar kits para productos de intercambio
      prodsIntercambio.forEach((p: any) => {
        const kitsDeEste = kitsData.filter((k: any) => k.idProducto === p.id);
        console.log(`[Sales] DEBUG kits para producto id=${p.id} (${p.descripcion}): ${kitsDeEste.length}`);
        kitsDeEste.forEach((k: any) =>
          console.log(
            `[Sales] DEBUG   kit id=${k.id}, idInsumo=${k.idInsumo}, envaseIntercambio=${
              k.envaseIntercambio
            } (${typeof k.envaseIntercambio})`,
          ),
        );
      });
      // Buscar kit 1042 directamente
      const kit1042 = kitsData.find((k: any) => k.id === 1042);
      console.log(
        `[Sales] DEBUG kit id=1042 existe? ${
          kit1042
            ? JSON.stringify({
                id: kit1042.id,
                idProducto: kit1042.idProducto,
                idInsumo: kit1042.idInsumo,
                envaseIntercambio: kit1042.envaseIntercambio,
              })
            : "NO"
        }`,
      );
      // Buscar kits con idProducto=65
      const kitsConIdProducto65 = kitsData.filter((k: any) => k.idProducto === 65);
      console.log(`[Sales] DEBUG kits con idProducto=65: ${kitsConIdProducto65.length}`);
      kitsConIdProducto65.forEach((k: any) =>
        console.log(
          `[Sales] DEBUG kit id=${k.id}, idProducto=${k.idProducto}, idInsumo=${k.idInsumo}, envaseIntercambio=${k.envaseIntercambio}`,
        ),
      );
      console.log(inventarioData.filter((i: any) => i.sucursal == currentSucursal && i.id < 10000));
      // Mapa de precios promocionales (PRIMERA JERARQUÍA)
      const preciosPromoMap = new Map<number, number>();
      // ... rest of the code remains the same ...
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

      const calcularExistencia = (
        productoId: number | undefined,
        claveProd: number | undefined,
        esKit: boolean,
        intercambio: boolean = false,
        prestamo: boolean = false,
      ) => {
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

      // Forzar inclusión de productos especiales (PRESTAMO e INTERCAMBIO)
      productosPorClave.forEach((prod: any, clave: number) => {
        if (prod.prestamo || prod.intercambio) todasLasClaves.add(clave);
      });

      // Mapear todos los productos disponibles usando un Map por ID para evitar duplicados
      const productosMap = new Map<number, Producto>();

      Array.from(todasLasClaves).forEach((claveNum) => {
        const productoBase = productosPorClave.get(claveNum) || productosPorId.get(claveNum);
        const esKit = Boolean(productoBase?.esKit);
        const intercambio = Boolean(productoBase?.intercambio);
        const prestamo = Boolean(productoBase?.prestamo);
        const productoId = productoBase?.id ?? claveNum;
        let descripcion = productoBase?.descripcion || "Sin descripción";

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

        const existencia = calcularExistencia(productoId, claveNum, esKit, intercambio, prestamo);

        const producto: Producto = {
          id: productoId,
          claveProd: (productoBase?.claveProd || claveNum).toString(),
          descripcion,
          precio,
          existencia,
          esKit,
          intercambio,
          prestamo,
          usandoPrecioDefault,
          esPromocion,
        };

        // Solo agregar si no existe ya un producto con este ID, o si el nuevo tiene mejor precio
        const existing = productosMap.get(productoId);
        if (!existing || precio > existing.precio) {
          productosMap.set(productoId, producto);
        }
      });

      return Array.from(productosMap.values());
    },
    [currentSucursal],
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

          // Intentar obtener metros desde Realm (tabla de usuarios)
          try {
            if (!FullSyncService.isServiceInitialized()) {
              await FullSyncService.initialize();
            }
            // Asumiendo que user.id existe en la sesión
            if (user.id) {
              const realmUser = FullSyncService.getUsuarioById(user.id);
              if (realmUser && realmUser.metros) {
                console.log("[Sales] Metros usuario obtenidos de Realm:", realmUser.metros);
                setUserMetros(realmUser.metros);
              } else if (user.metros) {
                console.log("[Sales] Metros usuario obtenidos de Sesión:", user.metros);
                setUserMetros(user.metros);
              }
            }
          } catch (error) {
            console.error("[Sales] Error al obtener usuario de Realm:", error);
            if (user.metros) {
              setUserMetros(user.metros);
            }
          }

          // Cargar datos después de establecer la sucursal
          await loadDataFromRealm(sucursal);
        }
      } finally {
        setInitializingPrinter(false);
      }
    };

    init();
  }, []);

  useEffect(() => {
    // Solo procesar el cliente de route.params UNA VEZ
    if (route?.params?.clienteId && clientes.length > 0 && !selectedClient && !clienteParamsProcessed.current) {
      const cliente = clientes.find((c) => c.id === route.params.clienteId);
      if (cliente) {
        // Marcar como procesado para evitar que se ejecute de nuevo
        clienteParamsProcessed.current = true;

        if (route.params.desdeVisita) {
          setSelectedClient(cliente);
          Alert.alert(
            "Visita Programada",
            `Has iniciado una visita para el cliente:\n\n${
              route.params.nombreCliente || cliente.nombre
            }\n\nAhora puedes proceder con la venta.`,
            [
              {
                text: "Continuar",
                onPress: () => {
                  setClientePendienteVisita(cliente);
                  setVisitaConfirmModalOpen(true);
                },
              },
            ],
          );
        } else {
          setClientePendienteVisita(cliente);
          setVisitaConfirmModalOpen(true);
        }
      }
    }
  }, [route?.params, clientes, selectedClient]);

  const reloadVisitasDelDia = useCallback(
    async (sucursal: number, showLoading = false) => {
      if (!sucursal) return;
      try {
        if (showLoading) setLoadingAgendados(true);
        // Si es refresh manual, sincronizar visitas realizadas con el servidor
        if (showLoading) {
          try {
            await VisitaSyncService.getInstance().syncVisitasRealizadas(sucursal);
            await VisitaSyncService.getInstance().syncByDate(new Date());
          } catch (syncErr) {
            console.warn("[Sales] Sync visitas fallido (no crítico):", syncErr);
          }
        }

        console.log(`[Sales] 📅 Recargando visitas para sucursal: ${sucursal}`);

        // Cargar visitas agendadas del día (para tab Agendados)
        const visitasDelDia = await VisitaSyncService.getInstance().getVisitasByFecha(new Date(), sucursal);
        console.log(`[Sales] Visitas agendadas del día: ${visitasDelDia.length}`);

        // Cargar clientes visitados HOY desde el nuevo endpoint
        const clientesVisitadosHoy = await VisitaSyncService.getInstance().getClientesVisitadosHoy(sucursal);
        console.log(`[Sales] Clientes visitados HOY: ${clientesVisitadosHoy.size}`);
        console.log(`[Sales] IDs visitados:`, Array.from(clientesVisitadosHoy));

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

        // Actualizar agendados (solo visitado === 0 del día actual)
        const idsClientesVisitaHoy = new Set(
          visitasDelDia.filter((v: any) => v.visitado === 0).map((v: any) => v.idCliente),
        );
        const clientesConVisitaHoy = clientesFormateados.filter((c) => idsClientesVisitaHoy.has(c.id));
        setClientesEntregaDia(clientesConVisitaHoy);

        // Actualizar filteredClientes según tab activo
        if (clienteTabActivo === "agendados") {
          setFilteredClientes(clientesConVisitaHoy);
        } else if (clienteTabActivo === "todos") {
          setFilteredClientes(clientesFormateados);
        }

        // Guardar IDs de agendados y visitados
        const allAgendadosIds = new Set(visitasDelDia.map((v: any) => v.idCliente as number));
        setVisitasDelDiaIds(allAgendadosIds);

        // Crear mapa simple: cliente visitado HOY = true
        const visitaMap = new Map<number, any>();
        clientesVisitadosHoy.forEach((idCliente) => {
          visitaMap.set(idCliente, { visitado: 1, idCliente });
        });

        console.log(`[Sales] Mapa de visitados construido con ${visitaMap.size} clientes`);

        setVisitasDelDiaMap(visitaMap);
      } catch (error) {
        console.error("[Sales] Error al recargar visitas:", error);
        Alert.alert("Error", "No se pudieron actualizar los clientes agendados");
      } finally {
        if (showLoading) setLoadingAgendados(false);
      }
    },
    [clienteTabActivo],
  );

  // Actualizar clientes y visitas cada vez que la pantalla recibe foco
  useFocusEffect(
    useCallback(() => {
      if (currentSucursal > 0) {
        console.log("[Sales] 🔄 Pantalla recibió foco, recargando visitas y clientes...");
        reloadVisitasDelDia(currentSucursal);
      }
    }, [currentSucursal, reloadVisitasDelDia]),
  );

  const loadDataFromRealm = async (sucursal: number): Promise<Cliente[]> => {
    try {
      await FullSyncService.initialize();

      // Cargar clientes
      const clientesData = FullSyncService.getClientesFull(10000);
      // Debug: inspeccionar primer cliente crudo de Realm
      if (clientesData.length > 0) {
        const sample = clientesData[0];
        console.log("[Sales] Cliente crudo Realm keys:", Object.keys(sample));
        console.log(
          "[Sales] Cliente crudo Realm sample:",
          JSON.stringify({
            id: sample.id,
            nombre: sample.nombre,
            latitud: sample.latitud,
            longitud: sample.longitud,
            lat: sample.lat,
            lng: sample.lng,
            lon: sample.lon,
            latitude: sample.latitude,
            longitude: sample.longitude,
          }),
        );
      }
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

      // Debug: cuántos clientes tienen coordenadas
      const clientesConCoords = clientesFormateados.filter(
        (c) => c.latitud != null && c.longitud != null && (c.latitud !== 0 || c.longitud !== 0),
      );
      console.log(
        `[Sales] Total clientes: ${clientesFormateados.length}, con coordenadas válidas: ${clientesConCoords.length}`,
      );
      console.log("clientesFormateados", clientesFormateados);
      if (clientesConCoords.length > 0) {
        console.log("[Sales] Ejemplo cliente con coords:", JSON.stringify(clientesConCoords[0]));
      }

      // Sincronizar visitas realizadas al inicio
      try {
        await VisitaSyncService.getInstance().syncVisitasRealizadas(sucursal);
      } catch (syncErr) {
        console.warn("[Sales] Sync visitas realizadas fallido (no crítico):", syncErr);
      }

      // Cargar visitas agendadas del día (para tab Agendados)
      const visitasDelDia = await VisitaSyncService.getInstance().getVisitasByFecha(new Date(), sucursal);
      console.log(`[Sales] Visitas agendadas del día: ${visitasDelDia.length}`);

      // Cargar clientes visitados HOY desde el nuevo endpoint
      const clientesVisitadosHoy = await VisitaSyncService.getInstance().getClientesVisitadosHoy(sucursal);
      console.log(`[Sales] Clientes visitados HOY: ${clientesVisitadosHoy.size}`);

      // Solo clientes con visita PENDIENTE (visitado === 0) para la pestaña Agendados
      const idsClientesVisitaHoy = new Set(
        visitasDelDia.filter((v: any) => v.visitado === 0).map((v: any) => v.idCliente),
      );
      console.log(`[Sales] Clientes agendados pendientes (visitado===0): ${idsClientesVisitaHoy.size}`);
      const clientesConVisitaHoy = clientesFormateados.filter((c) => idsClientesVisitaHoy.has(c.id));
      console.log(`[Sales] clientesEntregaDia (match con clientes): ${clientesConVisitaHoy.length}`);
      setClientesEntregaDia(clientesConVisitaHoy);

      // Guardar IDs de todos los clientes agendados hoy
      const allAgendadosIds = new Set(visitasDelDia.map((v: any) => v.idCliente as number));
      setVisitasDelDiaIds(allAgendadosIds);

      // Crear mapa simple: cliente visitado HOY = true
      const visitaMap = new Map<number, any>();
      clientesVisitadosHoy.forEach((idCliente) => {
        visitaMap.set(idCliente, { visitado: 1, idCliente });
      });
      setVisitasDelDiaMap(visitaMap);

      // Cargar clientes con precios
      const productosData = FullSyncService.getProductos(100000);
      const preciosData = FullSyncService.getPrecios(50000);
      const preciosPromoData = FullSyncService.getPreciosPromo(50000);
      const inventarioData = FullSyncService.getInventario();
      const kitsData = FullSyncService.getKits(50000);

      setProductosBase(productosData);
      setKits(kitsData);

      // Cargar formas de pago dinámicas
      const formasPagoData = FullSyncService.getFormasPago();
      console.log(`[Sales] Formas de pago cargadas: ${formasPagoData.length}`);
      setFormasPago(formasPagoData);

      const productosFormateados = buildProductosFormateados(
        preciosData,
        productosData,
        inventarioData,
        kitsData,
        undefined,
        preciosPromoData,
      ).filter((p) => {
        return p.existencia > 0;
      });
      console.log("1PRODUCTOSFORMATEADOS", productosFormateados);
      console.log(preciosData);
      setProductos(productosFormateados);
      // Por defecto mostrar solo productos normales (sin kits ni promociones)
      setFilteredProductos(productosFormateados.filter((p) => !p.esKit && !p.esPromocion));

      return clientesFormateados;
    } catch (error) {
      console.error("Error al cargar datos de Realm:", error);
      Alert.alert("Error", "No se pudieron cargar los datos. Sincroniza primero.");
      return [];
    }
  };

  const handleSearchCliente = useCallback(
    (query: string) => {
      setSearchQuery(query);

      const baseList = clienteTabActivo === "agendados" ? clientesEntregaDia : clientes;

      if (!query.trim()) {
        setFilteredClientes(baseList);
        return;
      }

      const lowerQuery = query.toLowerCase();
      const filtered = baseList.filter(
        (c) => c.nombre.toLowerCase().includes(lowerQuery) || c.id.toString().includes(query),
      );

      setFilteredClientes(filtered);
    },
    [clientes, clientesEntregaDia, clienteTabActivo],
  );

  const handleClienteSeleccionado = (cliente: Cliente) => {
    // Buscar el cliente actualizado desde el array clientes (recargado de Realm)
    const clienteActualizado = clientes.find((c) => c.id === cliente.id) || cliente;
    console.log("[Sales] Cliente seleccionado:", clienteActualizado.nombre);
    console.log("[Sales] Coordenadas del cliente seleccionado:", {
      latitud: clienteActualizado.latitud,
      longitud: clienteActualizado.longitud,
      origen: clientes.find((c) => c.id === cliente.id) ? "Realm actualizado" : "objeto viejo",
    });
    console.log("[Sales] Estado actual validandoUbicacion:", validandoUbicacion);
    setClientePendienteVisita(clienteActualizado);
    setVisitaConfirmModalOpen(true);
  };

  const calcularDistancia = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 6371e3;
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  };

  // Obtener tipos de visita desde Realm (como CumplimientoScreen)
  const getTipoVisitas = () => {
    if (!FullSyncService.isServiceInitialized()) return [];
    const tipos = FullSyncService.getTipoVisitas();
    return Array.isArray(tipos) ? tipos : [];
  };

  const tiposVisita = getTipoVisitas();

  // Actualizar coordenadas del usuario y recalcular cercanos
  const actualizarCoordenadas = async () => {
    setLoadingCercanos(true);
    try {
      const ubicacion = await LocationService.getBestLocation();
      if (ubicacion) {
        setUserCoords({ latitude: ubicacion.latitude, longitude: ubicacion.longitude });
        // Calcular top 5 más cercanos
        const clientesConCoords = clientes.filter(
          (c) => c.latitud != null && c.longitud != null && (c.latitud !== 0 || c.longitud !== 0),
        );
        console.log(
          `[Sales] Cercanos: ${clientes.length} clientes total, ${clientesConCoords.length} con coordenadas válidas`,
        );
        const clientesConDistancia = clientesConCoords
          .map((c) => ({
            ...c,
            distanciaMetros: calcularDistancia(ubicacion.latitude, ubicacion.longitude, c.latitud!, c.longitud!),
          }))
          .sort((a, b) => a.distanciaMetros - b.distanciaMetros)
          .slice(0, 5);
        console.log(
          `[Sales] Top 5 cercanos:`,
          clientesConDistancia.map((c) => ({ id: c.id, nombre: c.nombre, dist: Math.round(c.distanciaMetros) })),
        );
        setNearestClientes(clientesConDistancia);
      } else {
        Alert.alert("Ubicación no disponible", "No se pudo obtener tu ubicación. Verifica que el GPS esté activado.");
      }
    } catch (error) {
      console.error("[Sales] Error al obtener ubicación:", error);
      Alert.alert("Error de ubicación", "No se pudo obtener tu ubicación.");
    } finally {
      setLoadingCercanos(false);
    }
  };

  // Iniciar flujo de "Visitar" (como CumplimientoScreen: validar ubicación → seleccionar tipo → marcar visitado)
  const handleVisitarCliente = async (cliente: Cliente) => {
    console.log("[Sales] handleVisitarCliente:", cliente.nombre);

    // Verificar ubicación
    if (cliente.latitud && cliente.longitud) {
      try {
        setValidandoUbicacion(true);
        const ubicacionVendedor = await LocationService.getBestLocation();

        if (ubicacionVendedor) {
          const distancia = calcularDistancia(
            ubicacionVendedor.latitude,
            ubicacionVendedor.longitude,
            cliente.latitud,
            cliente.longitud,
          );
          const accuracyInfo = ubicacionVendedor.accuracy
            ? ` (precisión GPS: ±${Math.round(ubicacionVendedor.accuracy)} m)`
            : "";
          console.log(`[Sales] Distancia al cliente: ${Math.round(distancia)} m${accuracyInfo}`);

          const metrosPermitidos = userMetros || cliente.metros || 100;
          // Considerar la imprecisión del GPS en el cálculo
          const distanciaEfectiva = distancia - (ubicacionVendedor.accuracy ?? 0);
          if (distanciaEfectiva > metrosPermitidos) {
            Alert.alert(
              "Ubicación inválida",
              `Estás a ${Math.round(
                distancia,
              )} metros del cliente. La distancia máxima permitida es de ${metrosPermitidos} metros.${accuracyInfo}`,
            );
            setValidandoUbicacion(false);
            return;
          }
          setValidandoUbicacion(false);
        } else {
          setValidandoUbicacion(false);
          Alert.alert("Ubicación no disponible", "No se pudo obtener tu ubicación. Verifica que el GPS esté activado.");
          return;
        }
      } catch (locationError) {
        setValidandoUbicacion(false);
        console.error("[Sales] Error al obtener ubicación:", locationError);
        Alert.alert("Error de ubicación", "No se pudo verificar tu ubicación.");
        return;
      }
    } else {
      Alert.alert("Cliente sin ubicación", "El cliente no tiene registrada su ubicación geográfica.");
      return;
    }

    // Abrir modal de tipo de visita
    setClienteParaVisitar(cliente);
    setTipoVisitaSeleccionado(null);
    setTipoVisitaModalOpen(true);
  };

  // Confirmar visita con tipo seleccionado (como CumplimientoScreen.confirmarMarcarVisitado)
  const confirmarVisitarCliente = async () => {
    if (!clienteParaVisitar || tipoVisitaSeleccionado === null) {
      Alert.alert("Error", "Debe seleccionar un tipo de visita");
      return;
    }

    setTipoVisitaModalOpen(false);

    // Buscar la visita del día para este cliente
    const visitaDelCliente = visitasDelDiaMap.get(clienteParaVisitar.id);

    if (visitaDelCliente) {
      // Marcar visitado en el servicio de visitas
      const exito = await VisitaSyncService.getInstance().marcarVisitado(
        visitaDelCliente.id,
        tipoVisitaSeleccionado,
        new Date(),
      );

      if (exito) {
        // Registrar visita completa en DetalleVisitas
        try {
          await DetalleVisitasService.getInstance().registrarVisitaCompleta(
            clienteParaVisitar.id,
            currentUser?.id || 0,
            currentSucursal,
            tipoVisitaSeleccionado,
          );
          console.log(
            `[Sales] Visita registrada para cliente ${clienteParaVisitar.id} con tipo ${tipoVisitaSeleccionado}`,
          );
        } catch (error) {
          console.error("[Sales] Error al registrar en DetalleVisitas:", error);
        }

        // Actualizar estado local
        setVisitasDelDiaMap((prev) => {
          const newMap = new Map(prev);
          const v = newMap.get(clienteParaVisitar!.id);
          if (v) newMap.set(clienteParaVisitar!.id, { ...v, visitado: 1, tipo: tipoVisitaSeleccionado });
          return newMap;
        });

        // Recargar agendados para que el cliente visitado desaparezca de la lista
        reloadVisitasDelDia(currentSucursal);

        Alert.alert("Éxito", "Visita marcada como realizada");
      } else {
        Alert.alert("Error", "No se pudo marcar la visita");
      }
    } else {
      // Cliente no agendado: registrar en DetalleVisitas y actualizar estado local
      try {
        await DetalleVisitasService.getInstance().registrarVisitaCompleta(
          clienteParaVisitar.id,
          currentUser?.id || 0,
          currentSucursal,
          tipoVisitaSeleccionado,
        );
        console.log(`[Sales] Visita registrada (no agendado) para cliente ${clienteParaVisitar.id}`);

        // Agregar al mapa y set para que la UI lo muestre como visitado
        const visitaLocal = { idCliente: clienteParaVisitar.id, visitado: 1, tipo: tipoVisitaSeleccionado };
        setVisitasDelDiaMap((prev) => {
          const newMap = new Map(prev);
          newMap.set(clienteParaVisitar!.id, visitaLocal);
          return newMap;
        });
        setVisitasDelDiaIds((prev) => {
          const newSet = new Set(prev);
          newSet.add(clienteParaVisitar!.id);
          return newSet;
        });

        Alert.alert("Éxito", "Visita registrada correctamente");
      } catch (error) {
        console.error("[Sales] Error al registrar visita:", error);
        Alert.alert("Error", "No se pudo registrar la visita");
      }
    }

    setClienteParaVisitar(null);
  };

  const handleConfirmarVisita = async (desdeaIniciarVisita: boolean) => {
    console.log("[Sales] handleConfirmarVisita iniciado. desdeaIniciarVisita:", desdeaIniciarVisita);
    console.log("[Sales] Estado validandoUbicacion al inicio:", validandoUbicacion);

    if (!desdeaIniciarVisita) {
      console.log("[Sales] Usuario no desea iniciar visita, cerrando modal");
      setVisitaConfirmModalOpen(false);
      return;
    }
    console.log({ clientePendienteVisita });
    if (!clientePendienteVisita) return;

    if (desdeaIniciarVisita) {
      console.log("[Sales] Iniciando validación de ubicación...");
      // Verificar ubicación del vendedor
      if (clientePendienteVisita.latitud && clientePendienteVisita.longitud) {
        try {
          console.log("[Sales] Seteando validandoUbicacion = true");
          setValidandoUbicacion(true);
          console.log("[Sales] 📍 Obteniendo mejor lectura GPS...");
          const ubicacionVendedor = await LocationService.getBestLocation();

          if (ubicacionVendedor) {
            console.log("[Sales] Ubicación obtenida:", ubicacionVendedor);
            const distancia = calcularDistancia(
              ubicacionVendedor.latitude,
              ubicacionVendedor.longitude,
              clientePendienteVisita.latitud,
              clientePendienteVisita.longitud,
            );
            const accuracyInfo = ubicacionVendedor.accuracy
              ? ` (precisión GPS: ±${Math.round(ubicacionVendedor.accuracy)} m)`
              : "";
            console.log(`[Sales] Distancia calculada: ${Math.round(distancia)} m${accuracyInfo}`);

            const metrosPermitidos = userMetros || clientePendienteVisita.metros || 100;
            // Descontar la imprecisión del GPS antes de comparar
            const distanciaEfectiva = distancia - (ubicacionVendedor.accuracy ?? 0);
            if (distanciaEfectiva > metrosPermitidos) {
              console.log("[Sales] Distancia excede el límite permitido");
              Alert.alert(
                "Ubicación inválida",
                `Estás a ${Math.round(
                  distancia,
                )} metros del cliente. La distancia máxima permitida es de ${metrosPermitidos} metros.${accuracyInfo}`,
              );
              setValidandoUbicacion(false);
              return;
            }

            console.log("[Sales] Validación exitosa");
            setValidandoUbicacion(false);
          } else {
            setValidandoUbicacion(false);
            Alert.alert(
              "Ubicación no disponible",
              "No se pudo obtener tu ubicación. Verifica que el GPS esté activado.",
            );
            setVisitaConfirmModalOpen(false);
            return;
          }
        } catch (locationError) {
          setValidandoUbicacion(false);
          console.error("[Sales] ⚠️ Error al obtener ubicación:", locationError);
          Alert.alert("Error de ubicación", "No se pudo verificar tu ubicación. Verifica que el GPS esté activado.");
          setVisitaConfirmModalOpen(false);
          return;
        }
      } else {
        console.log("[Sales] Cliente sin ubicación, permitiendo venta sin validación GPS");
        // Si el cliente no tiene ubicación, permitir la venta sin validación
        // Registrar inicio de visita en DetalleVisitas
        console.log("[Sales] Registrando inicio de visita en DetalleVisitas...");
        try {
          const detalleId = await DetalleVisitasService.getInstance().iniciarVisita(
            clientePendienteVisita.id,
            currentUser?.id || 0,
            currentSucursal,
          );
          console.log("[Sales] Visita registrada con ID:", detalleId);
          setCurrentDetalleVisitaId(detalleId);
          console.log(`[Sales] ✅ Visita iniciada con ID: ${detalleId}`);
        } catch (error) {
          console.error("[Sales] ⚠️ Error al registrar inicio de visita:", error);
        }

        // Continuar con el proceso de venta
        setSelectedClient(clientePendienteVisita);
        setCart([]);
        setMetodoPago(null);
        setClienteModalOpen(false);
        setVisitaConfirmModalOpen(false);
        setSearchQuery("");
        setFilteredClientes(clientes);
        setClientePendienteVisita(null);
        setTimeout(() => setProductoModalOpen(true), 300);
        return;
      }

      // Registrar inicio de visita en DetalleVisitas
      console.log("[Sales] Registrando inicio de visita en DetalleVisitas...");
      try {
        const detalleId = await DetalleVisitasService.getInstance().iniciarVisita(
          clientePendienteVisita.id,
          currentUser?.id || 0,
          currentSucursal,
        );
        console.log("[Sales] Visita registrada con ID:", detalleId);
        setCurrentDetalleVisitaId(detalleId);
        console.log(`[Sales] ✅ Visita iniciada con ID: ${detalleId}`);
      } catch (error) {
        console.error("[Sales] ⚠️ Error al registrar inicio de visita:", error);
      }
    }

    setSelectedClient(clientePendienteVisita);
    setCart([]);
    setMetodoPago(null);
    setClienteModalOpen(false);
    setVisitaConfirmModalOpen(false);
    setSearchQuery("");
    setFilteredClientes(clientes);
    setClientePendienteVisita(null);
    setTimeout(() => setProductoModalOpen(true), 300);
  };

  const handleDebugInventory = () => {
    console.log("=== DEBUG INVENTARIO ID < 10000 ===");
    try {
      if (!FullSyncService.isServiceInitialized()) {
        console.log("FullSyncService no inicializado");
        return;
      }

      const inventario = FullSyncService.getInventario();
      // consoleRealm("Inventario", inventario);
      const inventarioFiltrado = inventario.filter((i: any) => i.id < 10000);
      // consoleRealm("Inventario filtrado", inventarioFiltrado);

      console.log(`Total items en inventario: ${inventario.length}`);
      console.log(`Items con ID < 10000: ${inventarioFiltrado.length}`);

      // También mostrar por sucursal actual
      const inventarioSucursal = inventarioFiltrado.filter((i: any) => i.sucursal == currentSucursal);
      console.log(`Items sucursal ${currentSucursal} con ID < 10000: ${inventarioSucursal.length}`);
      console.log("Inventario por sucursal:", inventarioSucursal);

      // Mostrar algunos datos clave de los primeros 10 items
      console.log("Primeros 10 items:");
      inventarioFiltrado.slice(0, 10).forEach((item: any, index: number) => {
        console.log(
          `${index + 1}. ID: ${item.id}, Clave: ${item.claveProd}, Sucursal: ${item.sucursal}, Saldo: ${item.saldo}`,
        );
      });
    } catch (error) {
      console.error("Error al depurar inventario:", error);
    }
    console.log("=== FIN DEBUG INVENTARIO ===");
  };

  const handleDebugDetalleVisitas = () => {
    console.log("=== DEBUG DETALLE VISITAS ===");
    try {
      if (!FullSyncService.isServiceInitialized()) {
        console.log("FullSyncService no inicializado");
        return;
      }

      // Obtener detalle de visitas (usar paginación para obtener todos)
      const detalleVisitas = FullSyncService.getDetalleVisitasPaginated(0, 1000);
      // consoleRealm("Detalle Visitas", detalleVisitas);

      console.log(`Total items en detalle_visitas: ${detalleVisitas.length}`);

      // Filtrar por sucursal actual si existe
      const visitasSucursalActual = detalleVisitas.filter((dv: any) => dv.sucursal == currentSucursal);
      console.log(`Visitas para sucursal ${currentSucursal}: ${visitasSucursalActual.length}`);

      // Mostrar últimas 10 visitas
      console.log("Últimas 10 visitas:");
      detalleVisitas.slice(0, 10).forEach((visita: any, index: number) => {
        console.log(
          `${index + 1}. ID: ${visita.id}, Ruta: ${visita.idRuta}, Cliente: ${visita.idCliente}, Sucursal: ${
            visita.sucursal
          }, Fecha: ${visita.fechaInicio}, Estado: ${visita.estado}`,
        );
      });

      // Agrupar por estado
      const porEstado = detalleVisitas.reduce((acc: any, visita: any) => {
        acc[visita.estado] = (acc[visita.estado] || 0) + 1;
        return acc;
      }, {});
      console.log("Visitas por estado:", porEstado);

      // Agrupar por ruta
      const porRuta = detalleVisitas.reduce((acc: any, visita: any) => {
        acc[visita.idRuta] = (acc[visita.idRuta] || 0) + 1;
        return acc;
      }, {});
      console.log("Visitas por ruta:", porRuta);
    } catch (error) {
      console.error("Error al depurar detalle visitas:", error);
    }
    console.log("=== FIN DEBUG DETALLE VISITAS ===");
  };

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
    [productos, showOnlyPromotions],
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

  useEffect(() => {
    if (currentUser) {
      const tienePermiso = ReubicacionService.getInstance().usuarioTienePermisoReubicacion(currentUser.id);
      setUsuarioPermisoReubicacion(tienePermiso);
      console.log(`[Sales] Usuario ${currentUser.id} permiso reubicacion: ${tienePermiso}`);
    } else {
      setUsuarioPermisoReubicacion(false);
    }
  }, [currentUser]);

  const handleReubicarCliente = async (clienteParam?: Cliente) => {
    const clienteAUbicar = clienteParam || selectedClient;

    if (!clienteAUbicar || !currentUser) {
      Alert.alert("Error", "No hay un cliente seleccionado");
      return;
    }

    if (!usuarioPermisoReubicacion) {
      Alert.alert(
        "Sin permiso de reubicación",
        "No tienes permiso para realizar una reubicación, o ya utilizaste tu permiso.",
      );
      return;
    }

    Alert.alert(
      "Reubicar Cliente",
      `¿Deseas actualizar la ubicación del cliente ${clienteAUbicar.nombre}?\n\nSe guardará tu ubicación GPS actual como la nueva ubicación del cliente.`,
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Reubicar",
          onPress: async () => {
            setReubicandoCliente(true);
            try {
              console.log("[Sales] Obteniendo ubicación GPS para reubicación...");
              const ubicacion = await LocationService.getBestLocation();

              if (!ubicacion) {
                Alert.alert("Error GPS", "No se pudo obtener tu ubicación. Verifica que el GPS esté activado.");
                setReubicandoCliente(false);
                return;
              }

              console.log("[Sales] Ubicación obtenida:", ubicacion);

              const reubicacionId = await ReubicacionService.getInstance().registrarReubicacion(
                clienteAUbicar.id,
                ubicacion.latitude,
                ubicacion.longitude,
                currentUser.id,
                currentSucursal,
              );

              if (reubicacionId) {
                // Actualizar el cliente seleccionado con las nuevas coordenadas
                const updatedCliente = {
                  ...clienteAUbicar,
                  latitud: ubicacion.latitude,
                  longitud: ubicacion.longitude,
                };
                setSelectedClient(updatedCliente);

                // Pequeño delay para asegurar que la actualización en Realm se complete totalmente
                await new Promise((resolve) => setTimeout(resolve, 500));

                // Verificar DIRECTAMENTE en Realm si el cliente tiene las nuevas coordenadas
                try {
                  await FullSyncService.initialize();
                  const realm = (FullSyncService as any).realm;
                  if (realm && !realm.isClosed) {
                    const clienteEnRealm = realm.objectForPrimaryKey("ClienteFull", clienteAUbicar.id);
                    if (clienteEnRealm) {
                      console.log(`[Sales] 📋 Cliente ${clienteAUbicar.id} DIRECTAMENTE desde Realm:`, {
                        latitud: (clienteEnRealm as any).latitud,
                        longitud: (clienteEnRealm as any).longitud,
                      });
                    }
                  }
                } catch (realmError) {
                  console.error("[Sales] Error verificando Realm directo:", realmError);
                }

                // Recargar la lista de clientes desde Realm para reflejar las nuevas coordenadas
                try {
                  const clientesActualizados = await loadDataFromRealm(currentSucursal);
                  console.log("[Sales] Lista de clientes recargada desde Realm");

                  // Verificar que el cliente específico tiene las nuevas coordenadas (usando el valor retornado, no el estado)
                  const clienteActualizado = clientesActualizados.find((c) => c.id === clienteAUbicar.id);
                  if (clienteActualizado) {
                    console.log(`[Sales] 🔍 Cliente ${clienteActualizado.id} después de recarga:`, {
                      nombre: clienteActualizado.nombre,
                      latitud: clienteActualizado.latitud,
                      longitud: clienteActualizado.longitud,
                    });

                    // IMPORTANTE: Actualizar selectedClient inmediatamente con las coordenadas nuevas
                    if (selectedClient && selectedClient.id === clienteAUbicar.id) {
                      console.log("[Sales] 🔄 Actualizando selectedClient con coordenadas nuevas");
                      setSelectedClient(clienteActualizado);
                    }

                    // Forzar actualización del estado clientes inmediatamente
                    setClientes([...clientesActualizados]);

                    // Recargar visitas para recalcular clientesEntregaDia con coordenadas nuevas
                    console.log("[Sales] 🔄 Recargando visitas para recalcular arrays derivados...");
                    await reloadVisitasDelDia(currentSucursal, true);
                  } else {
                    console.warn(`[Sales] ⚠️ Cliente ${clienteAUbicar.id} no encontrado en la lista recargada`);
                  }
                } catch (reloadError) {
                  console.error("[Sales] Error recargando clientes:", reloadError);
                }

                Alert.alert(
                  "¡Reubicación exitosa!",
                  `Cliente reubicado correctamente.\n\nNuevas coordenadas:\nLatitud: ${ubicacion.latitude.toFixed(
                    6,
                  )}\nLongitud: ${ubicacion.longitude.toFixed(
                    6,
                  )}\n\nLa reubicación se sincronizará automáticamente con el servidor.`,
                );

                console.log("[Sales] ✅ Cliente reubicado exitosamente");
              } else {
                Alert.alert(
                  "Error",
                  "No se pudo registrar la reubicación. Es posible que el cliente ya haya sido reubicado.",
                );
              }
            } catch (error) {
              console.error("[Sales] Error al reubicar cliente:", error);
              Alert.alert("Error", "Ocurrió un error al intentar reubicar el cliente.");
            } finally {
              setReubicandoCliente(false);
            }
          },
        },
      ],
    );
  };

  const total = useMemo(() => cart.reduce((acc, it) => acc + it.precio * it.cantidad, 0), [cart]);

  const addProduct = (p: Producto) => {
    console.log("[Sales] Agregando producto:", p.descripcion);
    console.log("[Sales] Estado validandoUbicacion al agregar producto:", validandoUbicacion);
    setCart((prev) => {
      const idx = prev.findIndex((item) => item.id === p.id);
      if (idx > -1) {
        const cp = [...prev];
        cp[idx] = { ...cp[idx], cantidad: cp[idx].cantidad + 1 };
        return cp;
      }
      return [...prev, { ...p, cantidad: 1 }];
    });
    setProductoModalOpen(false);
  };

  const addToCart = (p: Producto) => {
    // Interceptar producto PRESTAMO para mostrar modal
    if (p.prestamo) {
      console.log("[Sales] Producto PRESTAMO detectado, mostrando modal de prestamo");
      setPendingPrestamoProducto(p);
      setPendingPrestamoCantidad(1);
      setProductoModalOpen(false);
      setPrestamoModalOpen(true);
      return;
    }

    // Validar existencia antes de agregar
    const enCarrito = cart.find((ci) => ci.id === p.id);
    const cantidadActual = enCarrito ? enCarrito.cantidad : 0;
    if (cantidadActual + 1 > p.existencia) {
      Alert.alert(
        "Inventario insuficiente",
        `No hay suficiente existencia de "${p.descripcion}" (disponible: ${p.existencia}, en carrito: ${cantidadActual})`,
      );
      return;
    }

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
    // Validar existencia
    const producto = cart.find((ci) => ci.id === id);
    if (producto && cantidad > producto.existencia) {
      Alert.alert(
        "Inventario insuficiente",
        `No hay suficiente existencia de "${producto.descripcion}" (disponible: ${producto.existencia})`,
      );
      return;
    }
    setCart((prev) => prev.map((ci) => (ci.id === id ? { ...ci, cantidad } : ci)));
  };

  const removeFromCart = (id: number) => {
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

      // Buscar precios promocionales para el cliente
      const preciosPromo = FullSyncService.getPreciosPromoByCliente(selectedClient.id);

      // Buscar precios por listaPrecio en lugar de idCliente
      const preciosCliente = FullSyncService.getPreciosByListaPrecio(listaPrecios);
      const preciosDefault = FullSyncService.getPreciosByListaPrecio(13); // Lista DOMIC.

      // También mostrar todos los precios disponibles para debug
      const todosPrecios = FullSyncService.getPrecios(10000000);
      if (todosPrecios.length > 0) {
      }

      const inventario = FullSyncService.getInventario();
      const productosData = productosBase.length ? productosBase : FullSyncService.getProductos(1000000);
      const kitsData = kits.length ? kits : FullSyncService.getKits(5000);

      const productosFormateados = buildProductosFormateados(
        preciosCliente,
        productosData,
        inventario,
        kitsData,
        preciosDefault,
        preciosPromo,
      ).filter((p) => {
        return p.existencia > 0;
      });
      console.log(productosData);
      console.log("2PRODUCTOSFORMATEADOS", productosFormateados);
      console.log("preciosCliente", preciosCliente);
      console.log("preciosDefault", preciosDefault);
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

    // Verificar si el carrito tiene producto con intercambio=true y aún no se ha llenado el modal
    const itemIntercambio = cart.find((ci) => ci.intercambio);
    if (itemIntercambio && !intercambioData && !intercambioDataRef.current) {
      console.log("[Sales] Producto INTERCAMBIO detectado, mostrando modal");
      console.log(`[Sales] Precio del producto INTERCAMBIO en carrito: $${itemIntercambio.precio}`);

      // Buscar el kit component con envaseIntercambio=true para obtener el idInsumo
      try {
        console.log(`[Sales] DEBUG itemIntercambio.id=${itemIntercambio.id} (type=${typeof itemIntercambio.id})`);
        console.log(`[Sales] DEBUG itemIntercambio.claveProd=${itemIntercambio.claveProd}`);
        // Usar getKitsByProducto para query directa a Realm en vez de filtrar array
        const kitsParaEsteProducto = FullSyncService.getKitsByProducto(itemIntercambio.id);
        console.log(`[Sales] DEBUG Kits (getKitsByProducto ${itemIntercambio.id}): ${kitsParaEsteProducto.length}`);
        // Si no encuentra, intentar con todos los kits como fallback
        if (kitsParaEsteProducto.length === 0) {
          const totalKits = FullSyncService.getKits(99999);
          console.log(`[Sales] DEBUG Total kits en Realm: ${totalKits.length}`);
          if (totalKits.length > 0) {
            console.log(
              `[Sales] DEBUG Primer kit: ${JSON.stringify({
                id: totalKits[0].id,
                idProducto: totalKits[0].idProducto,
                idInsumo: totalKits[0].idInsumo,
              })}`,
            );
            console.log(
              `[Sales] DEBUG Último kit: ${JSON.stringify({
                id: totalKits[totalKits.length - 1].id,
                idProducto: totalKits[totalKits.length - 1].idProducto,
                idInsumo: totalKits[totalKits.length - 1].idInsumo,
              })}`,
            );
            // Buscar cualquier kit con idProducto=65 con comparación relajada
            const kitsBuscados = totalKits.filter((k: any) => String(k.idProducto) === String(itemIntercambio.id));
            console.log(
              `[Sales] DEBUG Kits con idProducto=${itemIntercambio.id} (string compare): ${kitsBuscados.length}`,
            );
          }
        }
        kitsParaEsteProducto.forEach((k: any, i: number) => {
          console.log(
            `[Sales] DEBUG Kit[${i}]: id=${k.id}, idProducto=${k.idProducto}(${typeof k.idProducto}), idInsumo=${
              k.idInsumo
            }, envaseIntercambio=${k.envaseIntercambio}(${typeof k.envaseIntercambio})`,
          );
        });
        const kitsDelProducto = kitsParaEsteProducto.filter((k: any) => k.envaseIntercambio);
        console.log(`[Sales] DEBUG Kits con envaseIntercambio=true: ${kitsDelProducto.length}`);
        if (kitsDelProducto.length > 0) {
          const compIntercambio = kitsDelProducto[0];
          const idInsumo = compIntercambio.idInsumo;
          console.log(`[Sales] Kit envaseIntercambio encontrado: idInsumo=${idInsumo}`);
          // Buscar el producto del idInsumo para obtener clave y descripción
          const productoInsumo = productosBase.find((p: any) => p.id === idInsumo);
          if (productoInsumo) {
            envaseIntercambioClaveRef.current = parseInt(productoInsumo.claveProd || "0", 10);
            envaseIntercambioDescRef.current = productoInsumo.descripcion || "Envase intercambio";
            console.log(
              `[Sales] Envase entregado dinámico: ${productoInsumo.descripcion} (clave ${productoInsumo.claveProd})`,
            );
          } else {
            envaseIntercambioClaveRef.current = idInsumo;
            envaseIntercambioDescRef.current = `Producto ${idInsumo}`;
            console.warn(`[Sales] No se encontró producto para idInsumo=${idInsumo}`);
          }
        } else {
          console.log("[Sales] No se encontró kit con envaseIntercambio=true, usando defaults");
          envaseIntercambioClaveRef.current = undefined;
          envaseIntercambioDescRef.current = undefined;
        }
      } catch (err) {
        console.warn("[Sales] Error buscando envaseIntercambio:", err);
        envaseIntercambioClaveRef.current = undefined;
        envaseIntercambioDescRef.current = undefined;
      }

      setCostoIntercambioCalculado(itemIntercambio.precio);
      setPendingIntercambioCantidad(itemIntercambio.cantidad);
      setIntercambioModalOpen(true);
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
    try {
      const locationAvailable = await LocationService.getBestLocation();
      if (!locationAvailable) {
        Alert.alert(
          "Ubicación Requerida",
          "No se puede procesar la venta sin acceso a la ubicación GPS. Por favor activa la ubicación en tu dispositivo e intenta de nuevo.",
        );
        setProcessingVenta(false);
        return;
      }
    } catch (locationError) {
      Alert.alert(
        "Ubicación Requerida",
        "No se puede procesar la venta sin acceso a la ubicación GPS. Por favor activa la ubicación en tu dispositivo e intenta de nuevo.",
      );
      setProcessingVenta(false);
      return;
    }

    // Procesar inputs pendientes antes de validar
    // (en caso de que el usuario no haya salido del campo de cantidad)
    const updatedCart = cart.filter((item) => {
      const pendingInput = quantityInputs[item.id];

      // Si hay input pendiente, procesarlo
      if (pendingInput !== undefined) {
        if (!pendingInput || pendingInput === "0") {
          return false; // Eliminar del carrito
        }
        const n = parseInt(pendingInput, 10);
        if (!Number.isNaN(n) && n > 0) {
          item.cantidad = n; // Actualizar cantidad
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
      })),
    );

    const invalidItems = updatedCart.filter(
      (item) => !item.id || item.cantidad <= 0 || item.precio < 0 || !item.descripcion,
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
        })),
      );
      Alert.alert(
        "Error",
        `Hay productos con datos inválidos en el carrito:\n${invalidItems
          .map((i) => `- ${i.descripcion || "Sin nombre"}: cantidad=${i.cantidad}, precio=${i.precio}`)
          .join("\n")}`,
      );
      return;
    }

    // Validar inventario suficiente
    const insufficientStock = updatedCart.filter((item) => {
      return item.existencia < item.cantidad;
    });
    if (insufficientStock.length > 0) {
      console.warn("[Sales] ⚠️ Inventario insuficiente:", insufficientStock);
      Alert.alert(
        "Inventario Insuficiente",
        `Los siguientes productos no tienen suficiente inventario:\n${insufficientStock
          .map((i) => `- ${i.descripcion} (disponible: ${i.existencia}, solicitado: ${i.cantidad})`)
          .join("\n")}`,
      );
      setProcessingVenta(false);
      return;
    }

    // Actualizar el carrito con los cambios procesados
    if (updatedCart.length !== cart.length) {
      console.log(
        `[Sales] ⚠️ Se eliminaron ${cart.length - updatedCart.length} productos con cantidad 0 desde inputs pendientes`,
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
      const tipoPagoCode = metodoPago ?? 1;
      const formaPagoSel = formasPago.find((fp: any) => fp.tipo === metodoPago);
      const descripcionMedioPago = formaPagoSel?.descripcion ?? "Efectivo";
      const esPago0 = Boolean(formaPagoSel?.pago0);
      const vendedor =
        (currentUser?.claveEmpleado as string | undefined) || (currentUser?.nombre as string | undefined) || "";
      const now = FullSyncService.getMexicoNow();
      console.log("🕒 [Sales] FECHA GENERADA PARA VENTA:", {
        fecha: now,
        fechaISO: now.toISOString(),
        fechaLocal: now.toLocaleString("es-MX", { timeZone: "America/Mexico_City" }),
        fechaString: now.toString(),
      });

      // Filtrar productos con cantidad válida (última línea de defensa)
      const validCart = updatedCart.filter((item) => item.cantidad > 0);
      if (validCart.length !== updatedCart.length) {
        console.error(
          "[Sales] ⚠️ Se detectaron productos con cantidad 0 que pasaron la validación inicial:",
          updatedCart.filter((item) => item.cantidad <= 0),
        );
      }

      if (validCart.length === 0) {
        console.error("[Sales] ❌ No hay productos válidos para procesar");
        Alert.alert("Error", "No hay productos válidos en el carrito");
        return;
      }

      // Obtener coordenadas GPS para la venta (mejor lectura de hasta 3 intentos)
      console.log("[Sales] 📍 Obteniendo mejor ubicación GPS para venta...");
      let coordinates: LocationCoordinates | null = null;
      try {
        coordinates = await LocationService.getBestLocation();
        if (coordinates) {
          console.log("[Sales] ✅ Ubicación obtenida para venta:", {
            lat: coordinates.latitude,
            lng: coordinates.longitude,
            accuracy: Math.round(coordinates.accuracy ?? 999),
            metrosValidacion: userMetros,
          });
        } else {
          console.warn("[Sales] ⚠️ No se pudo obtener la ubicación GPS");
        }
      } catch (locationError) {
        console.error("[Sales] ⚠️ Error al obtener ubicación (no crítico):", locationError);
      }

      // Intentar imprimir ticket (no crítico si falla)
      let ticketImpreso = false;
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
              console.log("[Sales] Datos de ticket obtenidos de Realm:", usuarioTicketData);
            }
          }
        } catch (e) {
          console.error("[Sales] Error al obtener datos de usuario de Realm:", e);
        }

        await TicketPrinter.printSaleTicket({
          clientName: client.nombre,
          paymentMethod: descripcionMedioPago,
          items: validCart.map((item) => ({
            description: item.descripcion,
            quantity: item.cantidad,
            price: item.precio,
            total: item.precio * item.cantidad,
          })),
          total: esPago0 ? 0 : updatedTotal,
          businessName: usuarioTicketData.nombreCia || APP_NAME,
          date: now,
          ticketNumber: String(saleIdMovil),
          sellerName: vendedor,
          branch: currentUser?.dSucursal || sucursal,
          taxId: usuarioTicketData.rfc,
          domicilio: usuarioTicketData.domicilio,
          regimenFiscal: usuarioTicketData.regimenFiscal,
          phone: usuarioTicketData.telefono,
          ticketFinal: usuarioTicketData.ticketFinal,
        });
        ticketImpreso = true;
        console.log("[Sales] ✅ Ticket impreso correctamente");
      } catch (printError) {
        console.error("[Sales] ⚠️ Error al imprimir ticket (no crítico):", printError);
        // Continuar con la venta aunque falle la impresión
      }

      // Crear ventas locales (operación crítica)
      console.log("[Sales] 💾 Guardando ventas en base de datos local...");

      // Construir observación desde los modales (solo el texto de observación)
      const currentIntercambioData = intercambioData || intercambioDataRef.current;
      let observacionVenta = "";

      if (currentIntercambioData && currentIntercambioData.observacion) {
        observacionVenta = currentIntercambioData.observacion;
      }

      if (prestamoData && prestamoData.observacion) {
        observacionVenta = observacionVenta
          ? `${observacionVenta} | ${prestamoData.observacion}`
          : prestamoData.observacion;
      }

      await FullSyncService.createLocalVentas(
        validCart.map((item, index) => {
          const esIntercambio = item.intercambio || false;
          const precioItem = esIntercambio
            ? intercambioDataRef.current?.costo ?? costoIntercambioCalculado
            : parseFloat(item.precio.toString()) || 0;
          return {
            id: saleIdMovil + index,
            sucursal,
            noVenta: 0,
            idMovil: saleIdMovil,
            claveProd: item.id, // Usar el id del producto, no claveProd
            nombreProducto: item.descripcion,
            cantProducto: item.cantidad,
            precio: precioItem,
            importe: precioItem * item.cantidad,
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
            observacion: observacionVenta,
          };
        }),
      );
      ventasCreadas = true;
      console.log("[Sales] ✅ Ventas locales creadas exitosamente");

      // Crear registros de InventarioEnvase si hay datos de intercambio o préstamo
      try {
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

        // Helper: buscar ID de producto por claveProd
        const getProductIdByClave = (claveProd: number): number => {
          const producto = productosBase.find((p: any) => parseInt(p.claveProd || "0", 10) === claveProd);
          return producto?.id || claveProd;
        };

        // INTERCAMBIO (clave 1000): solo entrada de envase recibido
        // Ya no se registra la salida del ENVASE XALLAPAN
        const currentIntercambioData = intercambioData || intercambioDataRef.current;
        if (currentIntercambioData) {
          const cantIntercambio = validCart.find((ci) => ci.intercambio)?.cantidad || 1;

          // COMENTADO: Ya no se registra la salida del envase XALLAPAN entregado
          // envaseItems.push({
          //   sucursal,
          //   claveProd: getProductIdByClave(currentIntercambioData.envaseEntregadoClave),
          //   folioMovto: 1,
          //   cantidadEntrada: 0,
          //   cantidadSalida: cantIntercambio,
          //   costo: currentIntercambioData.costo || 0,
          //   tipoMovto: 1100,
          //   idMovil: saleIdMovil,
          //   observacion: currentIntercambioData.observacion || "",
          // });

          // ENTRADA: envase recibido (solo se registra la entrada)
          envaseItems.push({
            sucursal,
            claveProd: getProductIdByClave(currentIntercambioData.envaseRecibidoClave),
            folioMovto: 1,
            cantidadEntrada: cantIntercambio,
            cantidadSalida: 0,
            costo: currentIntercambioData.costo || 0,
            tipoMovto: 1000,
            idMovil: saleIdMovil,
            observacion: currentIntercambioData.observacion || "",
          });
        }

        // // PRESTAMO: salida del producto prestado
        // const cantPrestamo = validCart.find((ci) => ci.prestamo)?.cantidad || 1;
        // const obsCompleta = [
        //   prestamoData.observacion,
        //   prestamoData.fechaDevolucion ? `Fecha devolucion: ${prestamoData.fechaDevolucion}` : "",
        // ]
        //   .filter(Boolean)
        //   .join(" | ");
        // envaseItems.push({
        //   sucursal,
        //   claveProd: prestamoData.idProdPrestado,
        //   folioMovto: 1,
        //   cantidadEntrada: 0,
        //   cantidadSalida: cantPrestamo,
        //   costo: 0,
        //   tipoMovto: 1200,
        //   idMovil: saleIdMovil,
        //   observacion: obsCompleta,
        // });
        //     .join(" | ");
        //   envaseItems.push({
        //     sucursal,
        //     claveProd: prestamoData.idProdPrestado,
        //     folioMovto: 1,
        //     cantidadEntrada: 0,
        //     cantidadSalida: cantPrestamo,
        //     costo: 0,
        //     tipoMovto: 1200,
        //     idMovil: saleIdMovil,
        //     observacion: obsCompleta,
        //   });
        // }

        if (envaseItems.length > 0) {
          console.log("[Sales] 📦 Guardando InventarioEnvase:", envaseItems.length, "registros");
          await FullSyncService.createLocalInventarioEnvase(envaseItems);
          console.log("[Sales] ✅ InventarioEnvase guardado exitosamente");
        }
      } catch (envaseError) {
        console.error("[Sales] ⚠️ Error al guardar InventarioEnvase (no crítico):", envaseError);
      }

      // Actualizar inventario restando las cantidades vendidas (operación crítica)
      const inventarioUpdateItems = validCart
        .filter((item) => {
          const claveProdNum = parseInt(item.claveProd || "0", 10);
          return !item.intercambio && !item.prestamo;
        })
        .map((item) => ({
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

      // Marcar visita como visitada si existe
      console.log(`[Sales] 📍 Buscando visita para cliente ${client.id}...`);
      try {
        const visitasDelDia = await VisitaSyncService.getInstance().getVisitasByFecha(new Date(), currentSucursal);
        console.log({ visitasDelDia });
        const visitaCliente = visitasDelDia.filter((f) => f.visitado === 0).find((v: any) => v.idCliente === client.id);

        if (visitaCliente) {
          console.log(`[Sales] ✅ Visita encontrada para cliente ${client.id}, marcando como visitada...`);
          console.log(`[Sales] DEBUG - Visita a marcar como visitada:`, visitaCliente);
          await VisitaSyncService.getInstance().marcarVisitado(visitaCliente.id);
          console.log(`[Sales] ✅ Visita ${visitaCliente.id} marcada como visitada`);

          // Recargar clientes de entregas del día para excluir el recién visitado
          const visitasActualizadas = await VisitaSyncService.getInstance().getVisitasByFecha(
            new Date(),
            currentSucursal,
          );
          const idsClientesPendientes = new Set(
            visitasActualizadas.filter((f) => f.visitado === 0).map((v: any) => v.idCliente),
          );
          const clientesPendientes = clientes.filter((c) => idsClientesPendientes.has(c.id));
          setClientesEntregaDia(clientesPendientes);
          console.log(
            `[Sales] ✅ Lista de entregas del día actualizada: ${clientesPendientes.length} clientes pendientes`,
          );
        } else {
          console.log(`[Sales] ℹ️ No hay visita programada para cliente ${client.id}`);
        }
      } catch (visitaError) {
        console.error("[Sales] ⚠️ Error al marcar visita como visitada (no crítico):", visitaError);
        // No interrumpir el flujo de venta si hay error al marcar visita
      }

      // Actualizar estado de impresora
      const status = BluetoothPrinterService.getStatus();
      setPrinterConnected(status.connected);

      if (status.connected) {
        Alert.alert(
          "🖨️ Venta Procesada",
          `Cliente: ${client.nombre}\nTotal: $${updatedTotal.toFixed(
            2,
          )}\nPago: ${descripcionMedioPago}\n\nTicket enviado a: ${status.printer?.name}`,
        );
      } else {
        Alert.alert(
          "✅ Venta Procesada",
          `Cliente: ${client.nombre}\nTotal: $${updatedTotal.toFixed(2)}\nPago: ${descripcionMedioPago}`,
        );
      }

      // Finalizar visita si existe con tipoVisita=1 (Venta)
      if (currentDetalleVisitaId) {
        try {
          await DetalleVisitasService.getInstance().finalizarVisita(currentDetalleVisitaId, 1);
          console.log(`[Sales] ✅ Visita finalizada con tipo Venta: ${currentDetalleVisitaId}`);
          setCurrentDetalleVisitaId(null);
        } catch (error) {
          console.error("[Sales] ⚠️ Error al finalizar visita:", error);
        }
      }

      // Limpiar formulario
      setCart([]);
      setMetodoPago(null);
      setSelectedClient(null);
      setIntercambioData(null);
      intercambioDataRef.current = null;
      setPrestamoData(null);
      setPendingPrestamoProducto(null);

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
        {/* Header con estado de impresora y botón debug */}
        {/* <View style={styles.headerRow}>
          <Text style={styles.headerTitle}>Punto de Venta</Text>
          <View style={styles.headerButtons}>
            <TouchableOpacity style={styles.debugBtn} onPress={handleDebugInventory}>
              <Text style={styles.debugBtnText}>🔍 Debug Inv</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.debugBtn} onPress={handleDebugDetalleVisitas}>
              <Text style={styles.debugBtnText}>📍 Debug Vis</Text>
            </TouchableOpacity>
            {printerConnected && (
              <View style={styles.printerBadge}>
                <Text style={styles.printerBadgeText}>🖨️ {printerName || "OK"}</Text>
              </View>
            )}
          </View>
        </View> */}

        {!printerConnected && (
          <View style={styles.warningCard}>
            <Text style={styles.warningIcon}>⚠️</Text>
            <Text style={styles.warningText}>Sin impresora. Debes configurar una.</Text>
          </View>
        )}

        {/* Entregas del Día - VISTA PRINCIPAL */}
        {/* <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.cardTitle}>📋 Entregas del Día</Text>
            <Text style={styles.badgeText}>{clientesEntregaDia.length}</Text>
          </View>
          {clientesEntregaDia.length === 0 ? (
            <Text style={styles.muted}>No hay entregas programadas para hoy</Text>
          ) : (
            <View style={styles.clientesList}>
              {clientesEntregaDia.map((cliente) => (
                <TouchableOpacity
                  key={cliente.id}
                  style={[styles.clienteItem, selectedClient?.id === cliente.id && styles.clienteItemSelected]}
                  onPress={() => {
                    // Buscar cliente actualizado desde array clientes (recargado de Realm)
                    const clienteActualizado = clientes.find(c => c.id === cliente.id) || cliente;
                    console.log("[Sales] Cliente seleccionado desde modal:", {
                      nombre: clienteActualizado.nombre,
                      latitud: clienteActualizado.latitud,
                      longitud: clienteActualizado.longitud
                    });
                    setSelectedClient(clienteActualizado);
                    setClienteModalOpen(false);
                  }}
                >
                  <View style={styles.clienteItemContent}>
                    <Text style={styles.clienteItemName}>{cliente.nombre}</Text>
                    <Text style={styles.clienteItemId}>#{cliente.id}</Text>
                  </View>
                  {selectedClient?.id === cliente.id && <Text style={styles.checkmark}>✓</Text>}
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View> */}

        {/* Cliente Seleccionado */}
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.cardTitle}>Cliente</Text>
            <View style={styles.headerButtons}>
              <TouchableOpacity
                style={styles.smallBtn}
                onPress={() => {
                  setClienteModalOpen(true);
                  setClienteTabActivo("agendados");
                  setFilteredClientes(clientesEntregaDia);
                }}
              >
                <Text style={styles.smallBtnText}>Cambiar</Text>
              </TouchableOpacity>
            </View>
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
                          `[Sales] Texto actual en input: "${currentText}", cantidad en carrito: ${item.cantidad}`,
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
            {formasPago.map((fp: any) => {
              const esCred = fp.tipo === 3;
              const disabled = esCred ? (selectedClient ? !selectedClient.credito : true) : false;
              return (
                <PayChip
                  key={fp.tipo}
                  label={fp.descripcion || `Tipo ${fp.tipo}`}
                  selected={metodoPago === fp.tipo}
                  onPress={() => setMetodoPago(fp.tipo)}
                  disabled={disabled}
                />
              );
            })}
          </View>

          <View style={styles.totalRow}>
            <Text style={styles.totalText}>Total</Text>
            <Text style={styles.totalValue}>
              {formasPago.find((fp: any) => fp.tipo === metodoPago)?.pago0 ? "$0.00" : `$${total.toFixed(2)}`}
            </Text>
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

              {/* Tabs: Agendados | Cercanos | Todos */}
              <View style={styles.tabBar}>
                <TouchableOpacity
                  style={[styles.tabItem, clienteTabActivo === "agendados" && styles.tabItemActive]}
                  onPress={() => {
                    setClienteTabActivo("agendados");
                    setSearchQuery("");
                    setFilteredClientes(clientesEntregaDia);
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Text style={[styles.tabItemText, clienteTabActivo === "agendados" && styles.tabItemTextActive]}>
                      Agendados ({clientesEntregaDia.length})
                    </Text>
                    {clienteTabActivo === "agendados" && (
                      <TouchableOpacity
                        onPress={() => reloadVisitasDelDia(currentSucursal, true)}
                        style={styles.refreshIconBtn}
                        disabled={loadingAgendados}
                      >
                        {loadingAgendados ? (
                          <ActivityIndicator size="small" color={COLORS.primary} />
                        ) : (
                          <Icon name="refresh" type="material" size={16} color={COLORS.primary} />
                        )}
                      </TouchableOpacity>
                    )}
                  </View>
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
                <TouchableOpacity
                  style={[styles.tabItem, clienteTabActivo === "todos" && styles.tabItemActive]}
                  onPress={() => {
                    setClienteTabActivo("todos");
                    setSearchQuery("");
                    setFilteredClientes(clientes);
                  }}
                >
                  <Text style={[styles.tabItemText, clienteTabActivo === "todos" && styles.tabItemTextActive]}>
                    Todos
                  </Text>
                </TouchableOpacity>
              </View>

              {/* Tab: Cercanos */}
              {clienteTabActivo === "cercanos" && (
                <View>
                  <TouchableOpacity
                    style={styles.refreshCoordsBtn}
                    onPress={actualizarCoordenadas}
                    disabled={loadingCercanos}
                  >
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
                      Lat: {userCoords.latitude.toFixed(5)}, Lon: {userCoords.longitude.toFixed(5)}
                    </Text>
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
                  {filteredClientes.length} cliente{filteredClientes.length !== 1 ? "s" : ""}{" "}
                  {filteredClientes.length === 1 ? "encontrado" : "encontrados"}
                </Text>
              )}

              {/* Lista de clientes según tab activo */}
              {clienteTabActivo === "cercanos" ? (
                <FlatList
                  data={nearestClientes}
                  keyExtractor={(i) => String(i.id)}
                  renderItem={({ item }) => {
                    const esAgendado = visitasDelDiaIds.has(item.id);
                    const visitaInfo = visitasDelDiaMap.get(item.id);
                    const yaVisitado = visitaInfo?.visitado === 1;

                    // Debug: log para clientes con badge de visitado
                    if (yaVisitado || esAgendado) {
                      console.log(`[Sales Cercanos] Cliente ${item.id} (${item.nombre}):`, {
                        esAgendado,
                        yaVisitado,
                        tieneVisitaInfo: !!visitaInfo,
                        visitaInfo: visitaInfo
                          ? {
                              idCliente: visitaInfo.idCliente,
                              visitado: visitaInfo.visitado,
                              fecha: visitaInfo.fecha,
                            }
                          : null,
                      });
                    }

                    // Calcular si el usuario está fuera del rango del cliente
                    let fueraDeRango = false;
                    let distanciaActual: number | null = null;
                    if (userCoords && item.latitud && item.longitud) {
                      distanciaActual = calcularDistancia(
                        userCoords.latitude,
                        userCoords.longitude,
                        item.latitud,
                        item.longitud,
                      );
                      const metrosPermitidos = userMetros || item.metros || 100;
                      fueraDeRango = distanciaActual > metrosPermitidos;
                    }

                    const btnDisabled = yaVisitado || validandoUbicacion || fueraDeRango;

                    return (
                      <View style={styles.clienteListRow}>
                        <TouchableOpacity
                          style={styles.clienteListInfo}
                          onPress={() => handleClienteSeleccionado(item)}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={styles.listTitle}>{item.nombre}</Text>
                            <Text style={styles.listSubtitle}>ID: {item.id}</Text>
                            <Text style={[styles.distanciaText, fueraDeRango && { color: "red" }]}>
                              {item.distanciaMetros < 1000
                                ? `${Math.round(item.distanciaMetros)} m`
                                : `${(item.distanciaMetros / 1000).toFixed(1)} km`}
                            </Text>
                            {fueraDeRango && distanciaActual !== null && (
                              <Text style={styles.fueraDeRangoText}>
                                ⚠️ A {Math.round(distanciaActual)} m (máx. {userMetros || item.metros || 100} m)
                              </Text>
                            )}
                          </View>
                          <View style={styles.badgesColumn}>
                            {visitaInfo && (esAgendado || yaVisitado) && (
                              <Text style={[styles.agendadoBadge, yaVisitado && styles.agendadoBadgeVisitado]}>
                                {yaVisitado ? "Visitado" : "Agendado"}
                              </Text>
                            )}
                            {item.credito && <Text style={styles.badge}>Crédito</Text>}
                          </View>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[
                            styles.visitarBtn,
                            btnDisabled && styles.visitarBtnDisabled,
                            fueraDeRango && !yaVisitado && styles.visitarBtnFueraRango,
                          ]}
                          onPress={() => handleVisitarCliente(item)}
                          disabled={btnDisabled}
                        >
                          {validandoUbicacion ? (
                            <ActivityIndicator size="small" color="#fff" />
                          ) : (
                            <Icon
                              name={yaVisitado ? "check" : fueraDeRango ? "location-off" : "directions-walk"}
                              type="material"
                              size={14}
                              color="#fff"
                            />
                          )}
                          <Text style={styles.visitarBtnText}>
                            {yaVisitado ? "Listo" : fueraDeRango ? "Lejos" : "Visitar"}
                          </Text>
                        </TouchableOpacity>
                        {usuarioPermisoReubicacion && (
                          <TouchableOpacity
                            style={[styles.reubicarBtnModal, reubicandoCliente && styles.reubicarBtnModalDisabled]}
                            onPress={() => {
                              setClienteModalOpen(false);
                              handleReubicarCliente(item);
                            }}
                            disabled={reubicandoCliente}
                          >
                            {reubicandoCliente ? (
                              <ActivityIndicator size="small" color="#fff" />
                            ) : (
                              <Icon name="my-location" type="material" size={14} color="#fff" />
                            )}
                            <Text style={styles.reubicarBtnModalText}></Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    );
                  }}
                  ListEmptyComponent={
                    <View style={styles.emptySearch}>
                      <Text style={styles.emptySearchText}>
                        {loadingCercanos
                          ? "Buscando clientes cercanos..."
                          : userCoords
                          ? "Ningún cliente tiene coordenadas registradas. Verifique que la API envíe latitud/longitud."
                          : "Presiona 'Actualizar mis coordenadas' para ver los 5 más cercanos"}
                      </Text>
                    </View>
                  }
                />
              ) : (
                <FlatList
                  data={filteredClientes}
                  keyExtractor={(i) => String(i.id)}
                  renderItem={({ item }) => {
                    const esAgendado = visitasDelDiaIds.has(item.id);
                    const visitaInfo = visitasDelDiaMap.get(item.id);
                    const yaVisitado = visitaInfo?.visitado === 1;

                    const btnDisabled = yaVisitado || validandoUbicacion;

                    return (
                      <View style={styles.clienteListRow}>
                        <TouchableOpacity
                          style={styles.clienteListInfo}
                          onPress={() => handleClienteSeleccionado(item)}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={styles.listTitle}>{item.nombre}</Text>
                            <Text style={styles.listSubtitle}>ID: {item.id}</Text>
                          </View>
                          <View style={styles.badgesColumn}>
                            {esAgendado && (
                              <Text style={[styles.agendadoBadge, yaVisitado && styles.agendadoBadgeVisitado]}>
                                {yaVisitado ? "Visitado" : "Agendado"}
                              </Text>
                            )}
                            {item.credito && <Text style={styles.badge}>Crédito</Text>}
                          </View>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.visitarBtn, btnDisabled && styles.visitarBtnDisabled]}
                          onPress={() => handleVisitarCliente(item)}
                          disabled={btnDisabled}
                        >
                          {validandoUbicacion ? (
                            <ActivityIndicator size="small" color="#fff" />
                          ) : (
                            <Icon
                              name={yaVisitado ? "check" : "directions-walk"}
                              type="material"
                              size={14}
                              color="#fff"
                            />
                          )}
                          <Text style={styles.visitarBtnText}>{yaVisitado ? "Listo" : "Visitar"}</Text>
                        </TouchableOpacity>
                        {usuarioPermisoReubicacion && (
                          <TouchableOpacity
                            style={[styles.reubicarBtnModal, reubicandoCliente && styles.reubicarBtnModalDisabled]}
                            onPress={() => {
                              setClienteModalOpen(false);
                              handleReubicarCliente(item);
                            }}
                            disabled={reubicandoCliente}
                          >
                            {reubicandoCliente ? (
                              <ActivityIndicator size="small" color="#fff" />
                            ) : (
                              <Icon name="my-location" type="material" size={14} color="#fff" />
                            )}
                            <Text style={styles.reubicarBtnModalText}></Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    );
                  }}
                  ListEmptyComponent={
                    <View style={styles.emptySearch}>
                      <Text style={styles.emptySearchText}>No se encontraron clientes</Text>
                    </View>
                  }
                />
              )}

              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={() => {
                  setClienteModalOpen(false);
                  setSearchQuery("");
                  setFilteredClientes(clientes);
                  setClienteTabActivo("agendados");
                }}
              >
                <Text style={styles.secondaryBtnText}>Cerrar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* Modal Confirmación de Visita */}
        <Modal
          visible={visitaConfirmModalOpen}
          animationType="fade"
          transparent
          onDismiss={() => {
            setValidandoUbicacion(false);
            setVisitaConfirmModalOpen(false);
          }}
        >
          <View style={styles.modalBackdrop}>
            <View style={styles.confirmModalCard}>
              <Text style={styles.confirmModalTitle}>¿Desea iniciar visita?</Text>
              <Text style={styles.confirmModalSubtitle}>Cliente: {clientePendienteVisita?.nombre}</Text>

              {validandoUbicacion ? (
                <View style={{ paddingVertical: 20, alignItems: "center" }}>
                  <ActivityIndicator size="large" color={COLORS.primary} />
                  <Text style={{ marginTop: 12, color: COLORS.textSecondary }}>Validando ubicación...</Text>
                </View>
              ) : (
                <View style={styles.confirmModalButtonsRow}>
                  <TouchableOpacity
                    style={[styles.confirmModalBtn, styles.confirmModalBtnNo]}
                    onPress={() => {
                      setValidandoUbicacion(false);
                      handleConfirmarVisita(false);
                    }}
                  >
                    <Text style={styles.confirmModalBtnText}>No</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.confirmModalBtn, styles.confirmModalBtnYes]}
                    onPress={() => handleConfirmarVisita(true)}
                  >
                    <Text style={styles.confirmModalBtnText}>Sí</Text>
                  </TouchableOpacity>
                </View>
              )}
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
                      // Aplicar el filtro correcto según showOnlyPromotions
                      const productosFiltrados = showOnlyPromotions
                        ? productos.filter((p) => p.esKit || p.esPromocion)
                        : productos.filter((p) => !p.esKit && !p.esPromocion);
                      setFilteredProductos(productosFiltrados);
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.listTitle}>{item.descripcion}</Text>
                      <Text style={styles.listSubtitle}>Clave: {item.claveProd}</Text>
                      <Text style={styles.listSubtitle}>
                        Existencia: {item.existencia} {item.esKit ? " | Kit: Sí" : ""}
                      </Text>
                      {item.prestamo && <Text style={styles.precioDefaultBadge}>PRÉSTAMO</Text>}
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
                  console.log("[Sales] Cerrando modal de productos");
                  console.log("[Sales] Estado validandoUbicacion al cerrar productos:", validandoUbicacion);
                  setProductoModalOpen(false);
                  setSearchProductoQuery("");
                  setShowOnlyPromotions(false);
                }}
              >
                <Text style={styles.secondaryBtnText}>Cerrar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* Modal Tipo de Visita (como CumplimientoScreen) */}
        <Modal visible={tipoVisitaModalOpen} animationType="fade" transparent>
          <View style={styles.tipoVisitaBackdrop}>
            <View style={styles.tipoVisitaCard}>
              <View style={styles.tipoVisitaHeader}>
                <Icon name="assignment" type="material" size={28} color={COLORS.primary} />
                <Text style={styles.tipoVisitaTitle}>Tipo de Visita</Text>
              </View>
              <View style={styles.tipoVisitaContent}>
                <View style={styles.tipoVisitaClienteInfo}>
                  <Icon name="person" type="material" size={20} color={COLORS.textSecondary} />
                  <Text style={styles.tipoVisitaSubtitle}>{clienteParaVisitar?.nombre || "Cliente"}</Text>
                </View>

                <ScrollView style={styles.tipoVisitaListContainer} showsVerticalScrollIndicator={false}>
                  {tiposVisita
                    .filter((tipo) => tipo.id !== 1)
                    .map((tipo) => {
                      const icons: { [key: number]: string } = {
                        2: "account-balance-wallet",
                        3: "local-offer",
                        4: "visibility",
                        5: "local-shipping",
                      };
                      return (
                        <TouchableOpacity
                          key={tipo.id}
                          style={[
                            styles.tipoVisitaOption,
                            tipoVisitaSeleccionado === tipo.id && styles.tipoVisitaOptionSelected,
                          ]}
                          onPress={() => setTipoVisitaSeleccionado(tipo.id)}
                          activeOpacity={0.7}
                        >
                          <View style={styles.tipoVisitaOptionContent}>
                            <Icon
                              name={icons[tipo.id] || "label"}
                              type="material"
                              size={24}
                              color={tipoVisitaSeleccionado === tipo.id ? COLORS.primary : COLORS.textSecondary}
                            />
                            <Text
                              style={[
                                styles.tipoVisitaOptionText,
                                tipoVisitaSeleccionado === tipo.id && styles.tipoVisitaOptionTextSelected,
                              ]}
                            >
                              {tipo.descripcion}
                            </Text>
                          </View>
                          {tipoVisitaSeleccionado === tipo.id && (
                            <View style={styles.tipoVisitaCheck}>
                              <Icon name="check" type="material" size={20} color="white" />
                            </View>
                          )}
                        </TouchableOpacity>
                      );
                    })}
                </ScrollView>

                <View style={styles.tipoVisitaButtons}>
                  <TouchableOpacity
                    style={[styles.tipoVisitaBtn, styles.tipoVisitaBtnCancel]}
                    onPress={() => {
                      setTipoVisitaModalOpen(false);
                      setClienteParaVisitar(null);
                    }}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.tipoVisitaBtnCancelText}>Cancelar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.tipoVisitaBtn,
                      styles.tipoVisitaBtnConfirm,
                      tipoVisitaSeleccionado === null && styles.tipoVisitaBtnDisabled,
                    ]}
                    onPress={confirmarVisitarCliente}
                    disabled={tipoVisitaSeleccionado === null}
                    activeOpacity={0.8}
                  >
                    <Icon name="check" type="material" size={20} color="white" />
                    <Text style={styles.tipoVisitaBtnConfirmText}>Confirmar</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </View>
        </Modal>

        {/* Modal Intercambio de Envases (dinámico) */}
        <IntercambioEnvaseModal
          visible={intercambioModalOpen}
          cantidad={pendingIntercambioCantidad}
          costoAutomatico={costoIntercambioCalculado}
          envaseEntregadoClave={envaseIntercambioClaveRef.current}
          envaseEntregadoDesc={envaseIntercambioDescRef.current}
          onAccept={(data) => {
            console.log("[Sales] Intercambio aceptado:", data);
            const dataObj = {
              envaseEntregadoClave: data.envaseEntregadoClave,
              envaseEntregadoDesc: data.envaseEntregadoDesc,
              envaseRecibidoClave: data.envaseRecibidoClave,
              envaseRecibidoDesc: data.envaseRecibidoDesc,
              observacion: data.observacion,
              costo: data.costo,
            };
            intercambioDataRef.current = dataObj;
            setIntercambioData(dataObj);
            // Actualizar el precio del item de intercambio en el carrito
            setCart((prev) => prev.map((ci) => (ci.intercambio ? { ...ci, precio: data.costo } : ci)));
            setIntercambioModalOpen(false);
            // El usuario debe presionar "Procesar venta" manualmente
          }}
          onCancel={() => {
            console.log("[Sales] Intercambio cancelado");
            setIntercambioModalOpen(false);
          }}
        />

        {/* Modal de Carga - Reubicación en Proceso */}
        <Modal visible={reubicandoCliente} transparent animationType="fade">
          <View style={styles.loadingModalOverlay}>
            <View style={styles.loadingModalContent}>
              <ActivityIndicator size="large" color={COLORS.primary} />
              <Text style={styles.loadingModalTitle}>Reubicando Cliente</Text>
              <Text style={styles.loadingModalText}>Obteniendo ubicación GPS y guardando la reubicación...</Text>
            </View>
          </View>
        </Modal>

        {/* Modal Préstamo de Envases */}
        <PrestamoEnvaseModal
          visible={prestamoModalOpen}
          clienteNombre={selectedClient?.nombre || "Sin cliente"}
          cantidad={pendingPrestamoCantidad}
          onAccept={(data) => {
            console.log("[Sales] Préstamo aceptado:", data);
            setPrestamoData({
              idProdPrestado: data.idProdPrestado,
              claveProdPrestado: data.claveProdPrestado,
              descProdPrestado: data.descProdPrestado,
              observacion: data.observacion,
              fechaDevolucion: data.fechaDevolucion,
            });
            setPrestamoModalOpen(false);
            // Agregar el producto al carrito después de aceptar
            if (pendingPrestamoProducto) {
              setCart((prev) => {
                const idx = prev.findIndex((ci) => ci.id === pendingPrestamoProducto!.id);
                if (idx >= 0) {
                  const cp = [...prev];
                  cp[idx] = { ...cp[idx], cantidad: cp[idx].cantidad + 1 };
                  return cp;
                }
                return [...prev, { ...pendingPrestamoProducto!, cantidad: 1 }];
              });
            }
          }}
          onCancel={() => {
            console.log("[Sales] Préstamo cancelado");
            setPrestamoModalOpen(false);
            setPendingPrestamoProducto(null);
          }}
        />
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
  badgeText: {
    backgroundColor: COLORS.primary,
    color: "#fff",
    paddingHorizontal: SPACING.s,
    paddingVertical: 2,
    borderRadius: BORDER_RADIUS.m,
    fontSize: 12,
    fontWeight: "600",
  },
  clientesList: {
    marginTop: SPACING.s,
  },
  clienteItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: SPACING.m,
    paddingHorizontal: SPACING.s,
    borderRadius: BORDER_RADIUS.m,
    marginBottom: SPACING.s,
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  clienteItemSelected: {
    backgroundColor: "#E3F2FD",
    borderColor: COLORS.primary,
    borderWidth: 2,
  },
  clienteItemContent: {
    flex: 1,
  },
  clienteItemName: {
    fontWeight: "600",
    color: COLORS.textPrimary,
    fontSize: 14,
  },
  clienteItemId: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  checkmark: {
    color: COLORS.primary,
    fontSize: 18,
    fontWeight: "bold",
    marginLeft: SPACING.s,
  },
  valueText: {
    marginTop: SPACING.s,
    ...TYPOGRAPHY.body,
    fontSize: 16,
  },
  smallBtn: {
    backgroundColor: COLORS.secondary,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    borderRadius: BORDER_RADIUS.m,
    alignItems: "center",
  },
  smallBtnDisabled: {
    opacity: 0.5,
  },
  smallBtnText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 13,
  },
  reubicarBtn: {
    backgroundColor: "#2196F3",
    minWidth: 90,
  },
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
  filterButtonsRow: {
    flexDirection: "row",
    gap: SPACING.s,
    marginVertical: SPACING.m,
  },
  filterBtn: {
    flex: 1,
    paddingVertical: SPACING.s,
    paddingHorizontal: SPACING.m,
    borderRadius: BORDER_RADIUS.m,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.background,
    alignItems: "center",
  },
  filterBtnActive: {
    backgroundColor: COLORS.secondary,
    borderColor: COLORS.primary,
  },
  filterBtnDisabled: {
    opacity: 0.5,
  },
  filterBtnText: {
    fontWeight: "600",
    fontSize: 12,
    color: COLORS.textPrimary,
  },
  confirmModalCard: {
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.l,
    padding: SPACING.l,
    marginHorizontal: SPACING.l,
    ...SHADOWS.large,
  },
  confirmModalTitle: {
    ...TYPOGRAPHY.h2,
    marginBottom: SPACING.m,
    textAlign: "center",
  },
  confirmModalSubtitle: {
    ...TYPOGRAPHY.body,
    color: COLORS.textSecondary,
    marginBottom: SPACING.l,
    textAlign: "center",
  },
  confirmModalButtonsRow: {
    flexDirection: "row",
    gap: SPACING.m,
  },
  confirmModalBtn: {
    flex: 1,
    paddingVertical: SPACING.m,
    borderRadius: BORDER_RADIUS.m,
    alignItems: "center",
  },
  confirmModalBtnNo: {
    backgroundColor: COLORS.border,
  },
  confirmModalBtnYes: {
    backgroundColor: COLORS.success,
  },
  confirmModalBtnText: {
    fontWeight: "700",
    fontSize: 16,
    color: COLORS.textPrimary,
  },
  headerButtons: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.s,
  },
  debugBtn: {
    backgroundColor: COLORS.secondary,
    paddingHorizontal: SPACING.s,
    paddingVertical: 4,
    borderRadius: BORDER_RADIUS.m,
    alignItems: "center",
  },
  debugBtnText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "600",
  },
  // --- Tabs del modal de clientes ---
  tabBar: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    marginBottom: SPACING.s,
  },
  tabItem: {
    flex: 1,
    paddingVertical: SPACING.s,
    alignItems: "center",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabItemActive: {
    borderBottomColor: COLORS.primary,
  },
  tabItemText: {
    fontSize: 13,
    fontWeight: "600",
    color: COLORS.textSecondary,
  },
  tabItemTextActive: {
    color: COLORS.primary,
  },
  // --- Botón actualizar coordenadas ---
  refreshCoordsBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.primary,
    paddingVertical: SPACING.s,
    paddingHorizontal: SPACING.m,
    borderRadius: BORDER_RADIUS.m,
    marginVertical: SPACING.s,
    gap: SPACING.s,
  },
  refreshCoordsBtnText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 13,
  },
  coordsInfo: {
    fontSize: 11,
    color: COLORS.textSecondary,
    textAlign: "center",
    marginBottom: SPACING.s,
  },
  // --- Fila de cliente con botón visitar ---
  clienteListRow: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    paddingVertical: SPACING.s,
  },
  clienteListInfo: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
  },
  badgesColumn: {
    alignItems: "flex-end",
    gap: 4,
    marginLeft: SPACING.s,
  },
  agendadoBadge: {
    backgroundColor: "#E3F2FD",
    color: COLORS.primary,
    paddingHorizontal: SPACING.s,
    paddingVertical: 2,
    borderRadius: BORDER_RADIUS.s,
    fontSize: 10,
    fontWeight: "bold",
    overflow: "hidden",
  },
  agendadoBadgeVisitado: {
    backgroundColor: "#E8F5E9",
    color: "#2E7D32",
  },
  distanciaText: {
    fontSize: 12,
    color: COLORS.primary,
    fontWeight: "600",
    marginTop: 2,
  },
  visitarBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.primary,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    borderRadius: BORDER_RADIUS.l,
    marginLeft: SPACING.s,
    gap: 4,
  },
  visitarBtnDisabled: {
    backgroundColor: "#34C759",
    opacity: 0.8,
  },
  visitarBtnText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 12,
  },
  reubicarBtnModal: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FF9800",
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    borderRadius: BORDER_RADIUS.l,
    marginLeft: SPACING.s,
    gap: 4,
  },
  reubicarBtnModalDisabled: {
    backgroundColor: "#BDBDBD",
    opacity: 0.6,
  },
  reubicarBtnModalText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 12,
  },
  // --- Modal Tipo de Visita ---
  tipoVisitaBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    justifyContent: "center",
    alignItems: "center",
  },
  tipoVisitaCard: {
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.xl,
    width: "90%",
    maxWidth: 400,
    maxHeight: "80%",
    ...SHADOWS.large,
    overflow: "hidden",
  },
  tipoVisitaHeader: {
    paddingVertical: 20,
    paddingHorizontal: 24,
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  tipoVisitaTitle: {
    fontSize: 20,
    fontWeight: "bold",
    color: COLORS.textPrimary,
    marginTop: 8,
  },
  tipoVisitaContent: {
    paddingHorizontal: 24,
    paddingBottom: 24,
  },
  tipoVisitaClienteInfo: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.background,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: BORDER_RADIUS.m,
    marginBottom: 20,
    marginTop: 16,
  },
  tipoVisitaSubtitle: {
    fontSize: 16,
    color: COLORS.textSecondary,
    marginLeft: 8,
    fontWeight: "500",
  },
  tipoVisitaListContainer: {
    maxHeight: 300,
  },
  tipoVisitaOption: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: BORDER_RADIUS.m,
    marginBottom: 8,
    backgroundColor: COLORS.background,
    borderWidth: 2,
    borderColor: "transparent",
  },
  tipoVisitaOptionSelected: {
    backgroundColor: "#E3F2FD",
    borderColor: COLORS.primary,
  },
  tipoVisitaOptionContent: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
  },
  tipoVisitaOptionText: {
    fontSize: 16,
    color: COLORS.textPrimary,
    marginLeft: 12,
    fontWeight: "500",
  },
  tipoVisitaOptionTextSelected: {
    color: COLORS.primary,
    fontWeight: "600",
  },
  tipoVisitaCheck: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.primary,
    justifyContent: "center",
    alignItems: "center",
  },
  tipoVisitaButtons: {
    flexDirection: "row",
    marginTop: 20,
    gap: 12,
  },
  tipoVisitaBtn: {
    flex: 1,
    height: 50,
    borderRadius: 25,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  tipoVisitaBtnCancel: {
    backgroundColor: COLORS.background,
    borderWidth: 2,
    borderColor: COLORS.border,
  },
  tipoVisitaBtnConfirm: {
    backgroundColor: COLORS.primary,
  },
  tipoVisitaBtnDisabled: {
    backgroundColor: COLORS.border,
  },
  tipoVisitaBtnCancelText: {
    color: COLORS.textSecondary,
    fontSize: 16,
    fontWeight: "600",
  },
  tipoVisitaBtnConfirmText: {
    color: "white",
    fontSize: 16,
    fontWeight: "600",
    marginLeft: 6,
  },
  // --- Fuera de rango ---
  visitarBtnFueraRango: {
    backgroundColor: "#E65100", // naranja oscuro
    opacity: 0.85,
  },
  fueraDeRangoText: {
    fontSize: 11,
    color: "#E65100",
    fontWeight: "600",
    marginTop: 2,
  },
  refreshIconBtn: {
    padding: 4,
    borderRadius: BORDER_RADIUS.s,
    backgroundColor: "transparent",
  },
  // --- Modal de Carga ---
  loadingModalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    justifyContent: "center",
    alignItems: "center",
  },
  loadingModalContent: {
    backgroundColor: "white",
    borderRadius: BORDER_RADIUS.l,
    padding: 32,
    alignItems: "center",
    minWidth: 280,
    ...SHADOWS.large,
  },
  loadingModalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: COLORS.textPrimary,
    marginTop: 16,
    marginBottom: 8,
  },
  loadingModalText: {
    fontSize: 14,
    color: COLORS.textSecondary,
    textAlign: "center",
    lineHeight: 20,
  },
});
