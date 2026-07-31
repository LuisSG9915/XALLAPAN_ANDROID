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
import BackgroundSyncService from "../services/BackgroundSyncService";
import AuthService, { Usuario } from "../services/AuthService";
import LocationService, { LocationCoordinates, calcularDistancia, estaDentroDeRango } from "../services/LocationService";
import GpsBitacoraService from "../services/GpsBitacoraService";
import VisitaSyncService from "../services/VisitaSyncService";
import DetalleVisitasService from "../services/DetalleVisitasService";
import ReubicacionService from "../services/ReubicacionService";
import { APP_NAME, COLORS, SPACING, SHADOWS, BORDER_RADIUS, TYPOGRAPHY } from "../theme/theme";
import IntercambioEnvaseModal from "./IntercambioEnvaseModal";
import PrestamoEnvaseModal from "./PrestamoEnvaseModal";
import ModalDiagnosticoGps, { DiagnosticoGpsData } from "./ModalDiagnosticoGps";

type Cliente = {
  id: number;
  nombre: string;
  credito?: boolean;
  idGrupo?: number;
  listaPrecio?: number;
  latitud?: number;
  longitud?: number;
  metros?: number; // Distancia máxima permitida en metros
  domicilio?: string;
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
  inventariable?: boolean;
  usandoPrecioDefault?: boolean;
  esPromocion?: boolean;
  omitirMovil?: number;
  envaseRecibe?: boolean;
};

type CartItem = Producto & { cantidad: number };

// Generación de id_movil corto e irrepetible para ventas locales.
// Estructura: MOVIL_ID_BASE + (segundos desde EPOCH * 1000) + sucursal
//  - Siempre > 1700000000 (umbral que distingue ventas locales de las del servidor)
//  - La sucursal queda en los últimos 3 dígitos (id_movil % 1000 === sucursal)
//  - Reserva un bloque de 1000 por segundo para los ids locales (id = idMovil + index)
//  - La guardia monotónica evita colisiones si se generan dos en el mismo segundo
const MOVIL_ID_BASE = 1700000000;
const MOVIL_ID_EPOCH_SECONDS = 1704067200; // 2024-01-01 00:00:00 UTC
let lastMovilSeconds = 0;

const generateMovilSaleId = (sucursal: number): number => {
  let seconds = Math.floor(Date.now() / 1000) - MOVIL_ID_EPOCH_SECONDS;
  if (seconds <= lastMovilSeconds) {
    seconds = lastMovilSeconds + 1;
  }
  lastMovilSeconds = seconds;
  return MOVIL_ID_BASE + seconds * 1000 + (sucursal % 1000);
};

// TTL del cache de GPS para la venta. El vendedor permanece en el domicilio del
// cliente durante toda la venta, así que 10 minutos es una antigüedad razonable
// y evita una segunda lectura GPS bloqueante al presionar "Procesar Venta".
const GPS_CACHE_TTL_MS = 600_000; // 10 minutos
// Presupuesto máximo de espera residual del GPS antes de guardar la venta.
// El GPS corre en paralelo con la impresión del ticket; si aún no resuelve al
// momento de guardar, solo se espera este tiempo acotado (la venta nunca se
// detiene 6-10 s por el GPS como antes).
const GPS_ESPERA_RESIDUAL_MAX_MS = 3_000;

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
  // Precisión del fix GPS en curso, para mostrar progreso vivo mientras valida
  // (p. ej. "±38 m") en vez de un spinner mudo que desespera al vendedor.
  const [progresoGps, setProgresoGps] = useState<string | null>(null);
  // Detalle del progreso GPS para mostrar en el modal de validación
  const [progresoValidacion, setProgresoValidacion] = useState<{ intento: number; total: number; accuracy: number } | null>(null);
  const [diagnosticoGps, setDiagnosticoGps] = useState<DiagnosticoGpsData | null>(null);
  const [reintentarValidacion, setReintentarValidacion] = useState<(() => void) | null>(null);
  const [userMetros, setUserMetros] = useState<number | null>(null);

  // Tabs del modal de clientes: 'agendados' | 'cercanos' | 'todos'
  const [clienteTabActivo, setClienteTabActivo] = useState<"agendados" | "cercanos" | "todos">("agendados");
  const [userCoords, setUserCoords] = useState<{ latitude: number; longitude: number; accuracy?: number } | null>(null);
  const [nearestClientes, setNearestClientes] = useState<(Cliente & { distanciaMetros: number })[]>([]);
  const [loadingCercanos, setLoadingCercanos] = useState(false);
  const [loadingAgendados, setLoadingAgendados] = useState(false);
  const [usuarioPermisoReubicacion, setUsuarioPermisoReubicacion] = useState(false);
  const [reubicandoCliente, setReubicandoCliente] = useState(false);

  // Cache de GPS obtenido durante validacion de visita/venta para reutilizar en processSale.
  // `source` indica quién lo llenó (visita | prefetch | venta) para la bitácora de tiempos.
  const gpsCacheRef = useRef<{ latitude: number; longitude: number; ts: number; source?: string } | null>(null);
  // Guardia para no lanzar lecturas GPS de pre-fetch duplicadas
  const gpsPrefetchingRef = useRef(false);
  // Promesa del pre-fetch en curso: processSale la reutiliza si el vendedor
  // cobra antes de que termine, en vez de iniciar una lectura GPS desde cero
  const gpsPrefetchPromiseRef = useRef<Promise<LocationCoordinates | null> | null>(null);

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
    envaseRecibidoId: number;
    kitIntercambioProductoId: number | null;
    precioEnvase: number | null;
    observacion: string;
    costo: number;
    cantRecEnvOtro: number;
  } | null>(null);
  const intercambioDataRef = useRef<{
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
  } | null>(null);
  const [pendingIntercambioProducto, setPendingIntercambioProducto] = useState<Producto | null>(null);
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

  // Helpers para detectar intercambio y préstamo por cat_kits (ya no por producto.intercambio/prestamo)
  const esProductoIntercambio = useCallback((productoId: number): boolean => {
    const kits = FullSyncService.getKitsByProducto(productoId);
    return kits.some((k: any) => k.recuperaEnvaseOtro);
  }, []);

  const esProductoPrestamo = useCallback((productoId: number): boolean => {
    const kits = FullSyncService.getKitsByProducto(productoId);
    return kits.some((k: any) => k.controlPresamo);
  }, []);

  // Helper para determinar si un kit debe usar precio del catálogo de kits o de lista de precios
  // Retorna: { usarPrecioKit: boolean, precioKit?: number }
  // Lógica:
  // - Si insumo tiene precioCatalogo=true y kit.noPrecioCatalogo=false: calcular precio sumando el precio del insumo desde la lista del cliente
  // - Si insumo tiene precioCatalogo=true y kit.noPrecioCatalogo=true: usar precio fijo del catálogo de kits
  const determinarPrecioKit = useCallback(
    (
      productoId: number,
      kitsData: any[],
      productosPorId: Map<number, any>,
      preciosMap?: Map<number, number>,
      preciosDefaultMap?: Map<number, number>,
      preciosPromoMap?: Map<number, number>,
    ): { usarPrecioKit: boolean; precioKit?: number } => {

      // Obtener los kits para este producto
      const kitsDelProducto = kitsData.filter((k: any) => k.idProducto === productoId);

      if (kitsDelProducto.length === 0) {
        return { usarPrecioKit: false };
      }

      // Calcular precio del kit sumando TODOS los insumos
      let precioDelKit = 0;

      // Mapa inverso por claveProd: el campo kit.idInsumo es inconsistente en el codebase
      // (en unas partes representa el id del producto y en otras la clave_prod del inventario),
      // por lo que resolvemos el insumo por ambas llaves.
      const productosPorClave = new Map<number, any>();
      productosPorId.forEach((prod: any) => {
        const clave = prod?.claveProd !== undefined && prod?.claveProd !== null ? parseInt(prod.claveProd, 10) : NaN;
        if (!Number.isNaN(clave)) productosPorClave.set(clave, prod);
      });

      for (const kit of kitsDelProducto) {
        const insumoProducto = productosPorId.get(kit.idInsumo) ?? productosPorClave.get(kit.idInsumo);

        // Llaves candidatas para buscar el precio del insumo (id y clave_prod), porque los
        // mapas de precios pueden estar indexados por cualquiera de las dos según los datos.
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

        // Si el insumo tiene precioCatalogo=true: buscar precio en listas del cliente (promo, cliente, default)
        // Si el insumo NO tiene precioCatalogo: usar precio fijo del catálogo de kits (kit.precio)
        if (insumoProducto?.precioCatalogo === true) {
          const claveInsumo = kit.idInsumo;
          let precioInsumoLista: number | undefined;
          const precioPromo = buscarPrecioInsumo(preciosPromoMap);
          const precioCliente = buscarPrecioInsumo(preciosMap);
          const precioDefault = buscarPrecioInsumo(preciosDefaultMap);
          if (precioPromo !== undefined) {
            precioInsumoLista = precioPromo;
          } else if (precioCliente !== undefined) {
            precioInsumoLista = precioCliente;
           
          } else if (precioDefault !== undefined) {
            precioInsumoLista = precioDefault;
         
          }
          if (precioInsumoLista === undefined) {
            precioInsumoLista = kit.precio || 0;
        
          }
          const precioInsumo = (precioInsumoLista || 0) * (kit.cantidad || 1);
          precioDelKit += precioInsumo;
         
        } else {
          // El insumo NO tiene precioCatalogo: usar precio fijo del catálogo de kits
          const precioInsumo = (kit.precio || 0) * (kit.cantidad || 1);
          precioDelKit += precioInsumo;
        
        }
      }


      // Siempre usar el precio calculado del kit cuando hay insumos y el precio > 0
      if (precioDelKit > 0) {
        return { usarPrecioKit: true, precioKit: precioDelKit };
      }

      return { usarPrecioKit: false };
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
      // DEBUG intercambio/prestamo (ahora detectado por cat_kits)
      const kitsConRecuperaOtro = kitsData.filter((k: any) => k.recuperaEnvaseOtro);
      const kitsConControlPresamo = kitsData.filter((k: any) => k.controlPresamo);
      // kitsConRecuperaOtro.forEach((k: any) =>
      //   console.log(
      //     `[Sales] DEBUG kit recuperaEnvaseOtro: id=${k.id}, idProducto=${k.idProducto}, idInsumo=${k.idInsumo}`,
      //   ),
      // );
      // kitsConControlPresamo.forEach((k: any) =>
      //   console.log(`[Sales] DEBUG kit controlPresamo: id=${k.id}, idProducto=${k.idProducto}, idInsumo=${k.idInsumo}`),
      // );
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
  
      const inventarioExcluido = inventarioData.filter((i: any) => i.sucursal == currentSucursal && i.id >= 10000);
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
        inventariable: boolean = false,
      ) => {
        // Si es kit pero es inventariable, tratarlo como producto normal (saldo directo)
        if (esKit && !inventariable && productoId !== undefined) {
          const componentes = kitsPorProducto.get(productoId) || [];
          if (!componentes.length) return 0;
          let minimo = Infinity;

          

          for (const comp of componentes) {
            if (comp.noRecuperaEnvase) {
              continue;
            }
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

        // Producto normal o kit inventariable: usar saldo directo del inventario
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

      // Forzar inclusión de productos especiales (PRESTAMO e INTERCAMBIO detectados por cat_kits)
      productosPorClave.forEach((prod: any, clave: number) => {
        const prodKits = kitsData.filter((k: any) => k.idProducto === prod.id);
        if (prodKits.some((k: any) => k.recuperaEnvaseOtro || k.controlPresamo)) {
          todasLasClaves.add(clave);
        }
      });

      // Mapear todos los productos disponibles usando un Map por ID para evitar duplicados
      const productosMap = new Map<number, Producto>();

      Array.from(todasLasClaves).forEach((claveNum) => {
        const productoBase = productosPorClave.get(claveNum) || productosPorId.get(claveNum);
        // Si el producto no existe en Realm (fue eliminado), no mostrarlo
        if (!productoBase) return;
        const esKit = Boolean(productoBase?.esKit);
        const inventariable = Boolean(productoBase?.inventariable);
        const productoId = productoBase?.id ?? claveNum;
        // Detectar intercambio y prestamo por cat_kits (no por producto.intercambio/prestamo)
        const prodKits = esKit ? kitsData.filter((k: any) => k.idProducto === productoId) : [];
        const intercambio = prodKits.some((k: any) => k.recuperaEnvaseOtro);
        const prestamo = prodKits.some((k: any) => k.controlPresamo);
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

        // Para kits: verificar si debe usar precio del catálogo de kits o de lista de precios
        // NOTA: Solo aplicar precioCatalogo si NO hay precio promocional (esPromocion=false)
        // El precio promocional tiene prioridad sobre la lógica de precioCatalogo
        // NOTA: Si el kit es inventariable, se trata como producto normal y se usa el precio
        // del propio idProducto (ya resuelto arriba), NO el precio calculado de los insumos.
        if (esKit && !inventariable && !esPromocion) {
          const { usarPrecioKit, precioKit } = determinarPrecioKit(
            productoId,
            kitsData,
            productosPorId,
            preciosMap,
            preciosDefaultMap,
            preciosPromoMap,
          );
          if (usarPrecioKit && precioKit !== undefined) {
          
            precio = precioKit;
          }
        }

        const existencia = calcularExistencia(productoId, claveNum, esKit, intercambio, prestamo, inventariable);

        const producto: Producto = {
          id: productoId,
          claveProd: (productoBase?.claveProd || claveNum).toString(),
          descripcion,
          precio,
          existencia,
          esKit,
          intercambio,
          prestamo,
          inventariable,
          usandoPrecioDefault,
          esPromocion,
          omitirMovil: productoBase?.omitirMovil ?? 0,
          envaseRecibe: productoBase?.envaseRecibe ?? false,
        };

        if (producto.omitirMovil === 1 || productoBase?.envaseRecibe) {
         
        }

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
      const tGlobal0 = Date.now();
      console.log(`[Sales][INIT] ===== useEffect init DISPARADO (t=0ms) =====`);

      // Conectar impresora en segundo plano (no bloquea la carga de la pantalla)
      const connectPrinterBg = async () => {
        const tPrinter = Date.now();
        try {
          console.log(`[Sales][INIT][BG] Intentando conectar impresora en segundo plano... (t=${Date.now() - tGlobal0}ms)`);
          let status = BluetoothPrinterService.getStatus();
          if (!status.connected) {
            await BluetoothPrinterService.connectToSavedPrinter();
          }
          status = BluetoothPrinterService.getStatus();
          setPrinterConnected(status.connected);
          setPrinterName(status.printer?.name || "");
          console.log(`[Sales][INIT][BG] Impresora lista en ${Date.now() - tPrinter}ms: connected=${status.connected} (t=${Date.now() - tGlobal0}ms)`);
        } catch (e) {
          console.warn(`[Sales][INIT][BG] Error conectando impresora (no crítico):`, e);
        }
      };
      // Disparar conexión de impresora en segundo plano (no esperamos a que termine)
      connectPrinterBg();

      try {
        console.log(`[Sales][INIT] Restaurando sesión usuario... (t=${Date.now() - tGlobal0}ms)`);
        const user = await AuthService.restoreSession();
        console.log(`[Sales][INIT] Sesión restaurada en ${Date.now() - tGlobal0}ms, user=${user?.nombre}`);
        if (user) {
          console.log(
            `[Sales][USER] envaseRuta=${String((user as any)?.envaseRuta)} ` +
              `(tipo=${typeof (user as any)?.envaseRuta}) usuario=${String(user.nombre)}`,
          );
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

          // Si la sincronización automática está corriendo, evitar duplicar tráfico de red
          // y bloquear la pantalla. Solo cargar datos locales.
          const skipNetworkSync =
            BackgroundSyncService.getState().status === "syncing";
          if (skipNetworkSync) {
            console.log("[Sales] Sync automática en curso, omitiendo sync de visitas al entrar");
          }

          // Cargar datos después de establecer la sucursal
          console.log(`[Sales][INIT] Llamando loadDataFromRealm... (t=${Date.now() - tGlobal0}ms)`);
          const tLoad = Date.now();
          await loadDataFromRealm(sucursal, skipNetworkSync);
          console.log(`[Sales][INIT] loadDataFromRealm terminó en ${Date.now() - tLoad}ms (t=${Date.now() - tGlobal0}ms)`);
        }
      } finally {
        setInitializingPrinter(false);
        console.log(`[Sales][INIT] initializingPrinter=false, init COMPLETO en ${Date.now() - tGlobal0}ms =====`);
      }
    };

    init();
  }, []);

  useEffect(() => {
    // Solo procesar el cliente de route.params UNA VEZ
    console.log(`[Sales][ROUTE] useEffect disparado: clienteId=${route?.params?.clienteId}, clientes.length=${clientes.length}, selectedClient=${selectedClient?.id}, yaProcesado=${clienteParamsProcessed.current}`);
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
        // (omitiendo si la sync automática está corriendo para no duplicar tráfico ni bloquear)
        if (showLoading && BackgroundSyncService.getState().status !== "syncing") {
          try {
            await VisitaSyncService.getInstance().syncVisitasRealizadas(sucursal);
            // Desactivado: usa endpoint /api/MovilesVentas/visitas/full sin sucursal
            // await VisitaSyncService.getInstance().syncByDate(new Date());
          } catch (syncErr) {
            console.warn("[Sales] Sync visitas fallido (no crítico):", syncErr);
          }
        } else if (showLoading) {
          console.log("[Sales] Omitiendo sync manual de visitas: sync automática en curso");
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
          domicilio: c.domicilio ? String(c.domicilio) : undefined,
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

  const loadDataFromRealm = async (sucursal: number, skipNetworkSync = false): Promise<Cliente[]> => {
    const t0 = Date.now();
    console.log(`[Sales][loadData] INICIO (t=0ms) sucursal=${sucursal}, skipNetworkSync=${skipNetworkSync}`);
    try {
      await FullSyncService.initialize();
      console.log(`[Sales][loadData] FullSyncService.initialize OK (t=${Date.now() - t0}ms)`);

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
        domicilio: c.domicilio ? String(c.domicilio) : undefined,
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
      if (clientesConCoords.length > 0) {
        console.log("[Sales] Ejemplo cliente con coords:", JSON.stringify(clientesConCoords[0]));
      }

      // Sincronizar visitas realizadas al inicio (solo si no hay sync automática en curso)
      if (!skipNetworkSync) {
        try {
          await VisitaSyncService.getInstance().syncVisitasRealizadas(sucursal);
        } catch (syncErr) {
          console.warn("[Sales] Sync visitas realizadas fallido (no crítico):", syncErr);
        }
      } else {
        console.log("[Sales] Omitiendo sync de visitas realizadas: sync automática en curso");
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
      const clientesConVisitaHoy = clientesFormateados.filter((c) => idsClientesVisitaHoy.has(c.id));
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
        const userEnvaseRuta = currentUser?.envaseRuta === true;
        // Lógica: si omitirMovil es 1
        // - Si envaseRuta es true: mostrar solo productos con envase_recibe
        // - Si envaseRuta es false: NO mostrar productos
        if (p.omitirMovil === 1) {
          const visible = userEnvaseRuta && p.envaseRecibe === true;
          console.log(
            `[Sales][FILTRO-1] omitirMovil=1 -> clave=${p.claveProd} id=${p.id} ` +
              `userEnvaseRuta=${userEnvaseRuta} (raw=${String(currentUser?.envaseRuta)}) ` +
              `envaseRecibe=${String(p.envaseRecibe)} existencia=${p.existencia} => visible=${visible}`,
          );
          return visible;
        }
        return p.existencia > 0;
      });

      setProductos(productosFormateados);
      // Por defecto mostrar solo productos normales (sin kits ni promociones)
      // PERO incluir kits que tengan recuperaEnvase=true
      // Ordenar: productos con recuperaEnvase primero
      const productosConRecuperaEnvase = FullSyncService.getProductosConRecuperaEnvase();
      const baseProducts = productosFormateados.filter(
        (p) => (!p.esKit && !p.esPromocion) || productosConRecuperaEnvase.has(p.id),
      );
      const sortedProducts = [...baseProducts].sort((a, b) => {
        const aHasRecupera = productosConRecuperaEnvase.has(a.id) ? 1 : 0;
        const bHasRecupera = productosConRecuperaEnvase.has(b.id) ? 1 : 0;
        return bHasRecupera - aHasRecupera;
      });
      setFilteredProductos(sortedProducts);

      console.log(`[Sales][loadData] FIN en ${Date.now() - t0}ms, clientes=${clientesFormateados.length}, productos=${baseProducts.length}`);
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
        setUserCoords({ latitude: ubicacion.latitude, longitude: ubicacion.longitude, accuracy: ubicacion.accuracy });
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

  // Guardia síncrona contra doble tap: el state `validandoUbicacion` tarda un
  // frame en deshabilitar el botón; dos taps rápidos lanzaban dos validaciones
  // concurrentes (y dos registros idénticos en la bitácora).
  const visitandoRef = useRef(false);

  // Iniciar flujo de "Visitar" (como CumplimientoScreen: validar ubicación → seleccionar tipo → marcar visitado)
  const handleVisitarCliente = async (cliente: Cliente) => {
    if (visitandoRef.current) return;
    visitandoRef.current = true;
    try {
      console.log("[Sales] handleVisitarCliente:", cliente.nombre);

      // Si el cliente fue reubicado, omitir validación de ubicación
      const omitirValidacionUbicacion = ReubicacionService.getInstance().clienteYaReubicado(cliente.id);

      // Verificar ubicación
      if (omitirValidacionUbicacion) {
        console.log("[Sales] Cliente reubicado, se omite validación de ubicación");
      } else if (cliente.latitud && cliente.longitud) {
        const metrosPermitidos = userMetros ?? cliente.metros ?? 100;
        const ejecutarValidacion = async () => {
          setValidandoUbicacion(true);
          setProgresoGps(null);
          setProgresoValidacion(null);
          const resultado = await LocationService.validarUbicacionConDiagnostico(
            cliente.latitud!,
            cliente.longitud!,
            metrosPermitidos,
            (intento, total, acc) => {
              setProgresoGps(`±${Math.round(acc)} m`);
              setProgresoValidacion({ intento, total, accuracy: acc });
            },
            {
              id: cliente.id,
              nombre: cliente.nombre,
              lat: cliente.latitud,
              lng: cliente.longitud,
            },
          );
          setValidandoUbicacion(false);
          setProgresoGps(null);
          setProgresoValidacion(null);
          return resultado;
        };

        const resultado = await ejecutarValidacion();
        if (!resultado.valido) {
          if (resultado.motivo === "sin_permiso") {
            Alert.alert(
              "Permiso de ubicación",
              "Necesitas conceder el permiso de ubicación para poder registrar la visita.",
            );
          } else {
            setDiagnosticoGps({
              motivo: resultado.motivo,
              valido: false,
              distancia: resultado.distancia ?? null,
              accuracy: resultado.accuracy ?? null,
              metrosPermitidos: metrosPermitidos,
              numFixes: resultado.numFixes ?? null,
              peorAccuracy: resultado.peorAccuracy ?? null,
              tiempoMs: resultado.tiempoMs ?? null,
              vendedorLat: resultado.ubicacion?.latitude ?? null,
              vendedorLng: resultado.ubicacion?.longitude ?? null,
              clienteLat: cliente.latitud!,
              clienteLng: cliente.longitud!,
              clienteNombre: cliente.nombre,
            });
            setReintentarValidacion(() => async () => {
              const r = await ejecutarValidacion();
              if (r.valido) {
                setDiagnosticoGps(null);
                setReintentarValidacion(null);
                setClienteParaVisitar(cliente);
                setTipoVisitaSeleccionado(null);
                setTipoVisitaModalOpen(true);
              } else {
                setDiagnosticoGps({
                  motivo: r.motivo,
                  valido: false,
                  distancia: r.distancia ?? null,
                  accuracy: r.accuracy ?? null,
                  metrosPermitidos: metrosPermitidos,
                  numFixes: r.numFixes ?? null,
                  peorAccuracy: r.peorAccuracy ?? null,
                  tiempoMs: r.tiempoMs ?? null,
                  vendedorLat: r.ubicacion?.latitude ?? null,
                  vendedorLng: r.ubicacion?.longitude ?? null,
                  clienteLat: cliente.latitud!,
                  clienteLng: cliente.longitud!,
                  clienteNombre: cliente.nombre,
                });
              }
            });
          }
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
    } finally {
      visitandoRef.current = false;
      setProgresoGps(null);
    }
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

  // Marca la visita agendada del día (visitado === 0) de un cliente como visitada.
  // Consulta la BD directamente para obtener el id real de la visita, ya que
  // visitasDelDiaMap solo contiene clientes ya visitados (sin el id de la visita).
  const marcarVisitaAgendadaComoVisitada = async (clienteId: number): Promise<void> => {
    try {
      const visitasDelDia = await VisitaSyncService.getInstance().getVisitasByFecha(new Date(), currentSucursal);
      const visitaCliente = visitasDelDia
        .filter((f: any) => f.visitado === 0)
        .find((v: any) => v.idCliente === clienteId);

      if (!visitaCliente) {
        console.log(`[Sales] No hay visita agendada pendiente para el cliente ${clienteId}`);
        return;
      }

      await VisitaSyncService.getInstance().marcarVisitado(visitaCliente.id, 1, visitaCliente.fecha);
      console.log(`[Sales] ✅ Visita ${visitaCliente.id} marcada como visitada (cliente ${clienteId})`);

      // Reflejar el cambio en el estado local de inmediato
      setVisitasDelDiaMap((prev) => {
        const newMap = new Map(prev);
        newMap.set(clienteId, { ...visitaCliente, visitado: 1 });
        return newMap;
      });
      setClientesEntregaDia((prev) => prev.filter((c) => c.id !== clienteId));
    } catch (error) {
      console.error("[Sales] ⚠️ Error al marcar visita agendada como visitada:", error);
    }
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
      // Si el cliente fue reubicado, omitir validación de ubicación
      const omitirValidacionUbicacion = ReubicacionService.getInstance().clienteYaReubicado(clientePendienteVisita.id);
      // Verificar ubicación del vendedor
      if (omitirValidacionUbicacion) {
        console.log("[Sales] Cliente reubicado, se omite validación de ubicación");
      } else if (clientePendienteVisita.latitud && clientePendienteVisita.longitud) {
        console.log("[Sales] 📍 Validando ubicación del vendedor...");
        const metrosPermitidos = userMetros ?? clientePendienteVisita.metros ?? 100;
        const ejecutarValidacion = async () => {
          setValidandoUbicacion(true);
          setProgresoValidacion(null);
          const r = await LocationService.validarUbicacionConDiagnostico(
            clientePendienteVisita.latitud!,
            clientePendienteVisita.longitud!,
            metrosPermitidos,
            (intento, total, acc) => {
              setProgresoValidacion({ intento, total, accuracy: acc });
            },
            {
              id: clientePendienteVisita.id,
              nombre: clientePendienteVisita.nombre,
              lat: clientePendienteVisita.latitud,
              lng: clientePendienteVisita.longitud,
            },
          );
          setValidandoUbicacion(false);
          setProgresoValidacion(null);
          return r;
        };

        const resultado = await ejecutarValidacion();
        if (!resultado.valido) {
          setVisitaConfirmModalOpen(false);
          if (resultado.motivo === "sin_permiso") {
            Alert.alert(
              "Permiso de ubicación",
              "Necesitas conceder el permiso de ubicación para poder registrar la visita.",
            );
          } else {
            setDiagnosticoGps({
              motivo: resultado.motivo,
              valido: false,
              distancia: resultado.distancia ?? null,
              accuracy: resultado.accuracy ?? null,
              metrosPermitidos: metrosPermitidos,
              numFixes: resultado.numFixes ?? null,
              peorAccuracy: resultado.peorAccuracy ?? null,
              tiempoMs: resultado.tiempoMs ?? null,
              vendedorLat: resultado.ubicacion?.latitude ?? null,
              vendedorLng: resultado.ubicacion?.longitude ?? null,
              clienteLat: clientePendienteVisita.latitud!,
              clienteLng: clientePendienteVisita.longitud!,
              clienteNombre: clientePendienteVisita.nombre,
            });
            setReintentarValidacion(() => async () => {
              const r = await ejecutarValidacion();
              if (r.valido) {
                setDiagnosticoGps(null);
                setReintentarValidacion(null);
                try {
                  const coords = await LocationService.getCurrentLocation();
                  if (coords) {
                    gpsCacheRef.current = { latitude: coords.latitude, longitude: coords.longitude, ts: Date.now(), source: "visita" };
                  }
                } catch (_) {}
                setVisitaConfirmModalOpen(true);
              } else {
                setDiagnosticoGps({
                  motivo: r.motivo,
                  valido: false,
                  distancia: r.distancia ?? null,
                  accuracy: r.accuracy ?? null,
                  metrosPermitidos: metrosPermitidos,
                  numFixes: r.numFixes ?? null,
                  peorAccuracy: r.peorAccuracy ?? null,
                  tiempoMs: r.tiempoMs ?? null,
                  vendedorLat: r.ubicacion?.latitude ?? null,
                  vendedorLng: r.ubicacion?.longitude ?? null,
                  clienteLat: clientePendienteVisita.latitud!,
                  clienteLng: clientePendienteVisita.longitud!,
                  clienteNombre: clientePendienteVisita.nombre,
                });
              }
            });
          }
          return;
        }
        // Cache GPS para reutilizar en processSale y evitar segunda ronda completa
        try {
          const coords = await LocationService.getCurrentLocation();
          if (coords) {
            gpsCacheRef.current = { latitude: coords.latitude, longitude: coords.longitude, ts: Date.now(), source: "visita" };
            console.log("[Sales] GPS cacheado para venta posterior");
          }
        } catch (cacheErr) {
          console.warn("[Sales] No se pudo cachear GPS post-validacion:", cacheErr);
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
            1,
          );
          console.log("[Sales] Visita registrada con ID:", detalleId);
          setCurrentDetalleVisitaId(detalleId);
          console.log(`[Sales] ✅ Visita iniciada con ID: ${detalleId}`);
        } catch (error) {
          console.error("[Sales] ⚠️ Error al registrar inicio de visita:", error);
        }

        // Marcar la visita agendada del día como visitada (consulta directa a BD)
        await marcarVisitaAgendadaComoVisitada(clientePendienteVisita.id);

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
          1,
        );
        console.log("[Sales] Visita registrada con ID:", detalleId);
        setCurrentDetalleVisitaId(detalleId);
        console.log(`[Sales] ✅ Visita iniciada con ID: ${detalleId}`);
      } catch (error) {
        console.error("[Sales] ⚠️ Error al registrar inicio de visita:", error);
      }

      // Marcar la visita agendada del día como visitada (consulta directa a BD)
      await marcarVisitaAgendadaComoVisitada(clientePendienteVisita.id);
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

      const productosConRecuperaEnvase = FullSyncService.getProductosConRecuperaEnvase();

      let baseProducts = productos;
      if (showOnlyPromotions) {
        baseProducts = productos.filter((p) => p.esKit || p.esPromocion);
      } else {
        // Incluir kits que tengan recuperaEnvase=true (incluso si son promocion)
        baseProducts = productos.filter((p) => (!p.esKit && !p.esPromocion) || productosConRecuperaEnvase.has(p.id));
      }

      if (!query.trim()) {
        // Ordenar: productos con recuperaEnvase primero
        const sorted = [...baseProducts].sort((a, b) => {
          const aHasRecupera = productosConRecuperaEnvase.has(a.id) ? 1 : 0;
          const bHasRecupera = productosConRecuperaEnvase.has(b.id) ? 1 : 0;
          return bHasRecupera - aHasRecupera; // Mayor primero (1 antes que 0)
        });
        setFilteredProductos(sorted);
        return;
      }

      const lowerQuery = query.toLowerCase();
      const filtered = baseProducts.filter((p) => {
        const matchDesc = p.descripcion.toLowerCase().includes(lowerQuery);
        const matchClave = p.claveProd?.toString().toLowerCase().includes(lowerQuery);
        const matchId = p.id.toString().includes(query);
        return matchDesc || matchClave || matchId;
      });

      // Ordenar: productos con recuperaEnvase primero
      const sorted = filtered.sort((a, b) => {
        const aHasRecupera = productosConRecuperaEnvase.has(a.id) ? 1 : 0;
        const bHasRecupera = productosConRecuperaEnvase.has(b.id) ? 1 : 0;
        return bHasRecupera - aHasRecupera; // Mayor primero (1 antes que 0)
      });

      setFilteredProductos(sorted);
    },
    [productos, showOnlyPromotions],
  );

  const togglePromotions = () => {
    const newValue = !showOnlyPromotions;
    setShowOnlyPromotions(newValue);

    const productosConRecuperaEnvase = FullSyncService.getProductosConRecuperaEnvase();

    let baseProducts = productos;
    if (newValue) {
      baseProducts = productos.filter((p) => p.esKit || p.esPromocion);
    } else {
      // Incluir kits que tengan recuperaEnvase=true (incluso si son promocion)
      baseProducts = productos.filter((p) => (!p.esKit && !p.esPromocion) || productosConRecuperaEnvase.has(p.id));
    }

    // Ordenar: productos con recuperaEnvase primero (solo cuando no es kit/promocion)
    let finalProducts = baseProducts;
    if (!newValue) {
      finalProducts = [...baseProducts].sort((a, b) => {
        const aHasRecupera = productosConRecuperaEnvase.has(a.id) ? 1 : 0;
        const bHasRecupera = productosConRecuperaEnvase.has(b.id) ? 1 : 0;
        return bHasRecupera - aHasRecupera;
      });
    }

    if (!searchProductoQuery.trim()) {
      setFilteredProductos(finalProducts);
    } else {
      const lowerQuery = searchProductoQuery.toLowerCase();
      const filtered = finalProducts.filter((p) => {
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
              const ubicacion = await LocationService.getBestLocation(5, 10000, undefined, undefined, undefined, 3);

              if (!ubicacion) {
                Alert.alert("Error GPS", "No se pudo obtener tu ubicación. Verifica que el GPS esté activado y estés a cielo abierto.");
                setReubicandoCliente(false);
                return;
              }

              const diagnostico = LocationService.getUltimoDiagnosticoGps();
              const accuracy = ubicacion.accuracy ?? 999;
              const numFixes = diagnostico.numFixes;

              console.log("[Sales] Ubicación obtenida:", ubicacion, "Diagnóstico:", diagnostico);

              if (accuracy > 25 || numFixes < 3) {
                Alert.alert(
                  "Precisión GPS insuficiente",
                  `No se puede reubicar el cliente con la precisión actual:\n\n` +
                  `• Precisión: ±${Math.round(accuracy)} m (se requiere ±25 m o mejor)\n` +
                  `• Lecturas GPS: ${numFixes} (se requieren al menos 3)\n\n` +
                  `Por favor:\n` +
                  `• Sal a cielo abierto\n` +
                  `• Espera 1-2 minutos sin moverte\n` +
                  `• Intenta de nuevo`,
                );
                setReubicandoCliente(false);
                return;
              }

              const reubicacionId = await ReubicacionService.getInstance().registrarReubicacion(
                clienteAUbicar.id,
                ubicacion.latitude,
                ubicacion.longitude,
                currentUser.id,
                currentSucursal,
                {
                  latitudAnterior: clienteAUbicar.latitud ?? undefined,
                  longitudAnterior: clienteAUbicar.longitud ?? undefined,
                  accuracy: accuracy,
                  numFixes: numFixes,
                },
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
                await new Promise<void>((resolve) => setTimeout(() => resolve(), 500));

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

  // Pre-fetch GPS en segundo plano: al agregar el primer producto al carrito se
  // dispara una lectura GPS sin await. Para cuando el vendedor presione
  // "Procesar Venta", el cache ya está fresco y el cierre no espera al GPS.
  const prefetchGpsParaVenta = () => {
    const cache = gpsCacheRef.current;
    if (cache && Date.now() - cache.ts < GPS_CACHE_TTL_MS) return; // cache vigente
    if (gpsPrefetchingRef.current) return; // ya hay una lectura en curso
    gpsPrefetchingRef.current = true;
    console.log("[Sales] 📍 Pre-fetch GPS en segundo plano (inicio de armado de pedido)...");
    const prefetchPromise = LocationService.getBestLocation()
      .then((coords) => {
        if (coords) {
          gpsCacheRef.current = { latitude: coords.latitude, longitude: coords.longitude, ts: Date.now(), source: "prefetch" };
          console.log("[Sales] ✅ Pre-fetch GPS listo, cache actualizado para la venta");
        }
        return coords;
      })
      .catch((err) => {
        console.warn("[Sales] Pre-fetch GPS falló (no crítico):", err);
        return null;
      })
      .finally(() => {
        gpsPrefetchingRef.current = false;
        gpsPrefetchPromiseRef.current = null;
      });
    gpsPrefetchPromiseRef.current = prefetchPromise;
  };

  const addToCart = (p: Producto) => {
    // Primer producto del pedido: arrancar el GPS en segundo plano
    if (cart.length === 0) {
      prefetchGpsParaVenta();
    }
    // Consultar kits del producto para detectar intercambio (recuperaEnvaseOtro) o prestamo (controlPresamo)
    const kitsDelProducto = FullSyncService.getKitsByProducto(p.id);
    const tieneRecuperaEnvaseOtro = kitsDelProducto.some((k: any) => k.recuperaEnvaseOtro);
    const tieneControlPresamo = kitsDelProducto.some((k: any) => k.controlPresamo);

    // Interceptar producto PRESTAMO (controlPresamo en kit) para mostrar modal
    if (tieneControlPresamo) {
      console.log("[Sales] Producto con PRESTAMO (controlPresamo) detectado, mostrando modal de prestamo");
      setPendingPrestamoProducto(p);
      setPendingPrestamoCantidad(1);
      setProductoModalOpen(false);
      setPrestamoModalOpen(true);
      return;
    }

    // Interceptar producto INTERCAMBIO (recuperaEnvaseOtro en kit) para mostrar modal
    if (tieneRecuperaEnvaseOtro) {
      console.log("[Sales] Producto con INTERCAMBIO (recuperaEnvaseOtro) detectado, mostrando modal de intercambio");
      // Buscar el kit con recuperaEnvaseOtro para obtener el idInsumo (envase entregado)
      const kitIntercambio = kitsDelProducto.find((k: any) => k.recuperaEnvaseOtro);
      if (kitIntercambio) {
        const idInsumo = kitIntercambio.idInsumo;
        const productoInsumo = productosBase.find((prod: any) => prod.id === idInsumo);
        if (productoInsumo) {
          envaseIntercambioClaveRef.current = parseInt(productoInsumo.claveProd || "0", 10);
          envaseIntercambioDescRef.current = productoInsumo.descripcion || "Envase intercambio";
        } else {
          envaseIntercambioClaveRef.current = idInsumo;
          envaseIntercambioDescRef.current = `Producto ${idInsumo}`;
        }
        setCostoIntercambioCalculado(p.precio);
        setPendingIntercambioProducto(p);
        setPendingIntercambioCantidad(1);
        setIntercambioModalOpen(true);
        setProductoModalOpen(false);
        return;
      }
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

  const buildMovilSaleId = (sucursal: number): number => generateMovilSaleId(sucursal);

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
        const userEnvaseRuta = currentUser?.envaseRuta === true;
        // Lógica: si omitirMovil es 1
        // - Si envaseRuta es true: mostrar solo productos con envase_recibe
        // - Si envaseRuta es false: NO mostrar productos
        if (p.omitirMovil === 1) {
          const visible = userEnvaseRuta && p.envaseRecibe === true;
          console.log(
            `[Sales][FILTRO-2] omitirMovil=1 -> clave=${p.claveProd} id=${p.id} ` +
              `userEnvaseRuta=${userEnvaseRuta} (raw=${String(currentUser?.envaseRuta)}) ` +
              `envaseRecibe=${String(p.envaseRecibe)} existencia=${p.existencia} => visible=${visible}`,
          );
          return visible;
        }
        return p.existencia > 0;
      });
      
      setProductos(productosFormateados);

      const productosConRecuperaEnvase = FullSyncService.getProductosConRecuperaEnvase();

      // Aplicar filtro de kits según el estado del botón
      const baseProducts = showOnlyPromotions
        ? productosFormateados.filter((p) => p.esKit || p.esPromocion)
        : productosFormateados.filter((p) => (!p.esKit && !p.esPromocion) || productosConRecuperaEnvase.has(p.id));

      // Ordenar: productos con recuperaEnvase primero (solo cuando no es kit/promocion)
      let finalProducts = baseProducts;
      if (!showOnlyPromotions) {
        finalProducts = [...baseProducts].sort((a, b) => {
          const aHasRecupera = productosConRecuperaEnvase.has(a.id) ? 1 : 0;
          const bHasRecupera = productosConRecuperaEnvase.has(b.id) ? 1 : 0;
          return bHasRecupera - aHasRecupera;
        });
      }
      setFilteredProductos(finalProducts);
    }
  }, [selectedClient, buildProductosFormateados, productosBase, kits, showOnlyPromotions]);

  const processSale = async () => {
    // Protección contra doble-clic
    if (processingVenta) {
      console.log("[Sales] ⚠️ Venta ya en proceso, ignorando clic duplicado");
      return;
    }

    // Verificar si el carrito tiene producto con kits que tengan recuperaEnvaseOtro=true
    // (Intercambio detectado por cat_kits, no por producto.intercambio)
    let itemIntercambio: CartItem | undefined;
    for (const item of cart) {
      const kitsDelItem = FullSyncService.getKitsByProducto(item.id);
      if (kitsDelItem.some((k: any) => k.recuperaEnvaseOtro)) {
        itemIntercambio = item;
        break;
      }
    }

    if (itemIntercambio && !intercambioData && !intercambioDataRef.current) {
      console.log("[Sales] Producto con INTERCAMBIO (recuperaEnvaseOtro) detectado en carrito, mostrando modal");
      console.log(`[Sales] Precio del producto INTERCAMBIO en carrito: $${itemIntercambio.precio}`);

      // Buscar el kit component con recuperaEnvaseOtro=true para obtener el idInsumo
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
            const kitsBuscados = totalKits.filter((k: any) => String(k.idProducto) === String(itemIntercambio!.id));
            console.log(
              `[Sales] DEBUG Kits con idProducto=${itemIntercambio.id} (string compare): ${kitsBuscados.length}`,
            );
          }
        }
        kitsParaEsteProducto.forEach((k: any, i: number) => {
          console.log(
            `[Sales] DEBUG Kit[${i}]: id=${k.id}, idProducto=${k.idProducto}(${typeof k.idProducto}), idInsumo=${
              k.idInsumo
            }, recuperaEnvaseOtro=${k.recuperaEnvaseOtro}(${typeof k.recuperaEnvaseOtro})`,
          );
        });
        const kitsDelProducto = kitsParaEsteProducto.filter((k: any) => k.recuperaEnvaseOtro);
        console.log(`[Sales] DEBUG Kits con recuperaEnvaseOtro=true: ${kitsDelProducto.length}`);
        if (kitsDelProducto.length > 0) {
          const compIntercambio = kitsDelProducto[0];
          const idInsumo = compIntercambio.idInsumo;
          console.log(`[Sales] Kit recuperaEnvaseOtro encontrado: idInsumo=${idInsumo}`);
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
          console.log("[Sales] No se encontró kit con recuperaEnvaseOtro=true, usando defaults");
          envaseIntercambioClaveRef.current = undefined;
          envaseIntercambioDescRef.current = undefined;
        }
      } catch (err) {
        console.warn("[Sales] Error buscando recuperaEnvaseOtro:", err);
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

    // Instrumentación de tiempos del cierre (bitácora BitacoraTiemposVenta)
    const ventaT0 = Date.now();
    let gpsFuente = "sin_gps";
    let gpsEsperaMs = 0;
    let impresionMs: number | null = null;
    let guardadoVentaMs: number | null = null;
    let dobleTicketUsado = false;

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

      // Obtener coordenadas GPS para la venta, reutilizando cache si es reciente.
      // El vendedor permanece en el domicilio del cliente durante toda la venta,
      // por lo que el cache (visita o pre-fetch) es válido hasta GPS_CACHE_TTL_MS.
      console.log("[Sales] 📍 Obteniendo ubicación GPS para venta...");
      let coordinates: LocationCoordinates | null = null;
      let gpsPromise: Promise<LocationCoordinates | null> | null = null;
      const cache = gpsCacheRef.current;
      if (cache && Date.now() - cache.ts < GPS_CACHE_TTL_MS) {
        coordinates = { latitude: cache.latitude, longitude: cache.longitude };
        gpsFuente = `cache_${cache.source || "visita"}`;
        console.log(
          "[Sales] ✅ Usando GPS cacheado (fuente:",
          cache.source || "visita",
          ", antiguedad:",
          Math.round((Date.now() - cache.ts) / 1000),
          "s)",
        );
      } else if (gpsPrefetchPromiseRef.current) {
        // El pre-fetch (disparado al agregar el primer producto) sigue en curso:
        // se reutiliza esa lectura ya caliente en vez de iniciar otra desde cero.
        // Solo se espera el presupuesto residual acotado antes de guardar.
        gpsFuente = "paralelo_prefetch";
        console.log("[Sales] ⏱️ Reutilizando lectura GPS del pre-fetch en curso...");
        gpsPromise = gpsPrefetchPromiseRef.current;
      } else {
        // Sin cache válido: el GPS corre EN PARALELO con la impresión del ticket
        // (que normalmente tarda varios segundos). No se hace await aquí; solo se
        // espera un presupuesto residual acotado justo antes de guardar la venta.
        gpsFuente = "paralelo";
        console.log("[Sales] ⏱️ Sin cache GPS vigente: lectura GPS en paralelo con la impresión...");
        gpsPromise = LocationService.getBestLocation()
          .then((coords) => {
            if (coords) {
              gpsCacheRef.current = { latitude: coords.latitude, longitude: coords.longitude, ts: Date.now(), source: "venta" };
              console.log("[Sales] ✅ Ubicación GPS fresca obtenida en paralelo:", {
                lat: coords.latitude,
                lng: coords.longitude,
                accuracy: Math.round(coords.accuracy ?? 999),
                metrosValidacion: userMetros,
              });
            }
            return coords;
          })
          .catch((locationError) => {
            console.error("[Sales] ⚠️ Error al obtener ubicación (no crítico):", locationError);
            return null;
          });
      }

      // Intentar imprimir ticket (no crítico si falla)
      const tImpresion0 = Date.now();
      let ticketImpreso = false;
      try {
        // Obtener datos del usuario desde Realm (tabla Usuario) para el ticket
        // ticketFinal, permisoDomicilioTicket y dobleTicket vienen de Usuario
        let usuarioTicketData: {
          ticketFinal?: string;
          permisoDomicilioTicket?: boolean;
          dobleTicket?: boolean;
        } = {};
        try {
          if (currentUser?.id) {
            const realmUser = FullSyncService.getUsuarioById(currentUser.id);
            if (realmUser) {
              usuarioTicketData = {
                ticketFinal: realmUser.ticketFinal,
                permisoDomicilioTicket: realmUser.permisoDomicilioTicket,
                dobleTicket: realmUser.dobleTicket,
              };
              console.log("[Sales] Datos de usuario para ticket:", usuarioTicketData);
            }
          }
        } catch (e) {
          console.error("[Sales] Error al obtener datos de usuario de Realm:", e);
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
          if (client.id) {
            const clienteRealm = FullSyncService.getClienteFullById(client.id);
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
                console.log("[Sales] Datos de empresa obtenidos de Cia:", empresaTicketData);
              }
            }
          }
        } catch (e) {
          console.error("[Sales] Error al obtener datos de empresa de Realm:", e);
        }

        // Obtener domicilio del cliente si el permiso está activo
        let clientDomicilio: string | undefined;
        const permisoValue = usuarioTicketData.permisoDomicilioTicket as any;
        const tienePermiso = permisoValue === true || permisoValue === 1 || permisoValue === "1";
        console.log(
          "[Sales] Permiso domicilio ticket raw:",
          usuarioTicketData.permisoDomicilioTicket,
          "evaluado:",
          tienePermiso,
        );
        if (tienePermiso && client.id) {
          const clienteRealm = FullSyncService.getClienteFullById(client.id);
          clientDomicilio = clienteRealm?.domicilio || undefined;
          console.log("[Sales] Domicilio del cliente para ticket:", clientDomicilio);
        }

        // Helper para obtener desglose de kits para el ticket
        const getComboBreakdown = (
          item: CartItem,
        ): {
          isCombo: boolean;
          esInventariable?: boolean;
          comboBreakdown?: Array<{ description: string; quantity: number; price: number; total: number }>;
        } => {
          if (!item.esKit) return { isCombo: false };

          // Si es kit inventariable, NO mostrar desglose
          if (item.inventariable) return { isCombo: false, esInventariable: true };

          const kitsDelProducto = FullSyncService.getKitsByProducto(item.id);
          if (kitsDelProducto.length === 0) return { isCombo: false };

          // Obtener precios desde FullSyncService
          const listaPrecios = client.listaPrecio ?? 0;
          const preciosPromo = FullSyncService.getPreciosPromoByCliente(client.id);
          const preciosCliente = FullSyncService.getPreciosByListaPrecio(listaPrecios);
          const preciosDefault = FullSyncService.getPreciosByListaPrecio(13);

          // Mapa de precios para calcular precios de insumos
          const preciosPromoMap = new Map<number, number>();
          const preciosMap = new Map<number, number>();
          const preciosDefaultMap = new Map<number, number>();

          preciosPromo.forEach((p: any) => {
            const clave = parseInt(p.claveProd || "0", 10);
            if (!Number.isNaN(clave)) preciosPromoMap.set(clave, p.precio || 0);
          });
          preciosCliente.forEach((p: any) => {
            const clave = parseInt(p.claveProd || "0", 10);
            if (!Number.isNaN(clave)) preciosMap.set(clave, p.precio || 0);
          });
          preciosDefault.forEach((p: any) => {
            const clave = parseInt(p.claveProd || "0", 10);
            if (!Number.isNaN(clave)) preciosDefaultMap.set(clave, p.precio || 0);
          });

          const productosPorId = new Map<number, any>();
          const productosPorClave = new Map<number, any>();
          productosBase.forEach((p: any) => {
            productosPorId.set(p.id, p);
            const clave = p?.claveProd !== undefined && p?.claveProd !== null ? parseInt(p.claveProd, 10) : NaN;
            if (!Number.isNaN(clave)) productosPorClave.set(clave, p);
          });

          const breakdown = kitsDelProducto.map((kit: any) => {
            // kit.idInsumo puede ser id de producto o clave_prod según los datos: resolver por ambas.
            const insumoProducto = productosPorId.get(kit.idInsumo) ?? productosPorClave.get(kit.idInsumo);
            const clavesInsumo: number[] = [];
            const addClaveInsumo = (valor: any) => {
              const n = typeof valor === "number" ? valor : parseInt(valor ?? "", 10);
              if (!Number.isNaN(n) && !clavesInsumo.includes(n)) clavesInsumo.push(n);
            };
            addClaveInsumo(kit.idInsumo);
            addClaveInsumo(insumoProducto?.id);
            addClaveInsumo(insumoProducto?.claveProd);
            const buscarPrecioInsumo = (map: Map<number, number>): number | undefined => {
              for (const key of clavesInsumo) {
                if (map.has(key)) return map.get(key);
              }
              return undefined;
            };

            let precioInsumo: number;
            // Si el insumo tiene precioCatalogo=true: buscar en listas (promo -> cliente -> default)
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

            return {
              description: insumoProducto?.descripcion || `Insumo ${kit.idInsumo}`,
              quantity: kit.cantidad || 1,
              price: precioInsumo,
              total: precioInsumo * (kit.cantidad || 1),
            };
          });

          return { isCombo: true, esInventariable: false, comboBreakdown: breakdown };
        };

        const ticketData = {
          clientName: client.nombre,
          clientDomicilio,
          paymentMethod: descripcionMedioPago,
          items: validCart.map((item) => {
            const comboInfo = getComboBreakdown(item);
            return {
              description: item.descripcion,
              quantity: item.cantidad,
              price: item.precio,
              total: item.precio * item.cantidad,
              esInventariable: item.inventariable,
              ...comboInfo,
            };
          }),
          total: esPago0 ? 0 : updatedTotal,
          businessName: empresaTicketData.nombreCia || APP_NAME,
          date: now,
          ticketNumber: String(saleIdMovil),
          sellerName: vendedor,
          branch: currentUser?.dSucursal || sucursal,
          taxId: empresaTicketData.rfc,
          domicilio: empresaTicketData.domicilio,
          regimenFiscal: empresaTicketData.regimenFiscal,
          phone: empresaTicketData.telefono,
          ticketFinal: usuarioTicketData.ticketFinal,
        };

        const dobleTicketValue = usuarioTicketData.dobleTicket as any;
        const esDobleTicket = dobleTicketValue === true || dobleTicketValue === 1 || dobleTicketValue === "1";
        dobleTicketUsado = esDobleTicket;
        console.log("[Sales] dobleTicket raw:", usuarioTicketData.dobleTicket, "evaluado:", esDobleTicket);

        if (esDobleTicket) {
          console.log("[Sales] Imprimiendo dos tickets (dobleTicket activo)");
          await TicketPrinter.printSaleTicket(ticketData);
          await TicketPrinter.printSaleTicket(ticketData);
        } else {
          await TicketPrinter.printSaleTicket(ticketData);
        }
        ticketImpreso = true;
        console.log("[Sales] ✅ Ticket(s) impreso(s) correctamente");
      } catch (printError) {
        console.error("[Sales] ⚠️ Error al imprimir ticket (no crítico):", printError);
        // Continuar con la venta aunque falle la impresión
      }
      impresionMs = Date.now() - tImpresion0;
      console.log(`[Sales] ⏱️ Bloque de impresión tomó ${impresionMs}ms`);

      // Si el GPS quedó corriendo en paralelo con la impresión, esperarlo solo un
      // presupuesto residual acotado: la venta nunca se detiene 6-10 s por el GPS.
      if (gpsPromise) {
        const tGpsWait0 = Date.now();
        coordinates = await Promise.race([
          gpsPromise,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), GPS_ESPERA_RESIDUAL_MAX_MS)),
        ]);
        gpsEsperaMs = Date.now() - tGpsWait0;
        if (coordinates) {
          console.log(`[Sales] ✅ GPS paralelo resolvió (espera residual: ${gpsEsperaMs}ms)`);
        } else {
          gpsFuente = "sin_gps";
          console.warn(
            `[Sales] ⚠️ GPS no resolvió en ${GPS_ESPERA_RESIDUAL_MAX_MS}ms de espera residual; la venta se guarda sin coordenadas`,
          );
        }
      }

      // Crear ventas locales (operación crítica)
      console.log("[Sales] 💾 Guardando ventas en base de datos local...");
      const tGuardado0 = Date.now();

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
          const esIntercambio = esProductoIntercambio(item.id);
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
      guardadoVentaMs = Date.now() - tGuardado0;
      console.log(`[Sales] ✅ Ventas locales creadas exitosamente (${guardadoVentaMs}ms)`);

      // Crear registros de InventarioEnvase si hay datos de intercambio o préstamo
      const tPostVenta0 = Date.now();
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
          const cantProductoIntercambio = validCart.find((ci) => esProductoIntercambio(ci.id))?.cantidad || 1;
          // Usar cantRecEnvOtro para calcular cuántos envases se reciben (cantidad * cantRecEnvOtro)
          const cantRecEnvOtro = currentIntercambioData.cantRecEnvOtro || 1;
          const cantIntercambio = cantProductoIntercambio * cantRecEnvOtro;
          console.log(
            `[Sales] Intercambio: cantProducto=${cantProductoIntercambio} * cantRecEnvOtro=${cantRecEnvOtro} = ${cantIntercambio} envases a registrar`,
          );

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
          return !esProductoIntercambio(item.id) && !esProductoPrestamo(item.id);
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

      // Bitácora de tiempos del cierre (no crítico): mide GPS, impresión,
      // guardado y post-venta para detectar cuellos de botella en el servidor.
      const postVentaMs = Date.now() - tPostVenta0;
      const totalMs = Date.now() - ventaT0;
      console.log(
        `[Sales] ⏱️ Cierre de venta en ${totalMs}ms ` +
          `(gps: ${gpsEsperaMs}ms[${gpsFuente}], impresión: ${impresionMs}ms, ` +
          `guardado: ${guardadoVentaMs}ms, post-venta: ${postVentaMs}ms)`,
      );
      GpsBitacoraService.registrarTiemposVenta({
        idCliente: client.id,
        idMovil: saleIdMovil,
        gpsFuente,
        gpsMs: gpsEsperaMs,
        impresionMs,
        guardadoVentaMs,
        postVentaMs,
        totalMs,
        items: validCart.length,
        dobleTicket: dobleTicketUsado,
        ticketImpreso,
      }).catch((err) => console.warn("[Sales] No se pudo registrar bitácora de tiempos:", err));

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

      // Disparar sincronización parcial (incremental) tras venta exitosa.
      // Si ya hay una sync corriendo, BackgroundSyncService la cancela y reinicia.
      // No usar await para no bloquear la UI.
      BackgroundSyncService.triggerPartialSync("venta-finalizada").catch((err) => {
        console.warn("[Sales] No se pudo iniciar sincronización post-venta:", err);
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
            <Text style={styles.loadingText}>Cargando punto de venta...</Text>
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
          {selectedClient?.domicilio ? (
            <Text style={styles.domicilioTexto} numberOfLines={2}>
              {selectedClient.domicilio}
            </Text>
          ) : null}
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
              // Si es tipo crédito, deshabilitar si no hay cliente o si el cliente no tiene crédito
              const disabled = fp.credito ? (!selectedClient || !selectedClient.credito) : false;
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

                    // Calcular si el usuario está fuera del rango del cliente.
                    // Se usa la MISMA regla que la validación real (estaDentroDeRango,
                    // con buffer de accuracy) para que el botón "Lejos" nunca
                    // contradiga el resultado de validarUbicacionCliente.
                    let fueraDeRango = false;
                    let distanciaActual: number | null = null;
                    if (userCoords && item.latitud && item.longitud) {
                      distanciaActual = calcularDistancia(
                        userCoords.latitude,
                        userCoords.longitude,
                        item.latitud,
                        item.longitud,
                      );
                      const metrosPermitidos = userMetros ?? item.metros ?? 100;
                      fueraDeRango = !estaDentroDeRango(distanciaActual, userCoords.accuracy, metrosPermitidos);
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
                                ⚠️ A {Math.round(distanciaActual)} m (máx. {userMetros ?? item.metros ?? 100} m)
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
                            {validandoUbicacion
                              ? (progresoGps ?? "GPS…")
                              : yaVisitado
                                ? "Listo"
                                : fueraDeRango
                                  ? "Lejos"
                                  : "Visitar"}
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
                <View style={styles.gpsValidacionContainer}>
                  {(() => {
                    const acc = progresoValidacion?.accuracy ?? 999;
                    const intento = progresoValidacion?.intento ?? 0;
                    const total = progresoValidacion?.total ?? 5;
                    const precisionBuena = acc <= 30;
                    const precisionMedia = acc > 30 && acc <= 50;
                    const colorPrecision = precisionBuena ? "#4CAF50" : precisionMedia ? "#FF9800" : "#F44336";
                    const textoPrecision = acc < 999 ? `±${Math.round(acc)} m` : "buscando...";
                    const mostrarTipCalibracion = acc > 50;
                    return (
                      <>
                        <View style={[styles.gpsPrecisionCircle, { borderColor: colorPrecision }]}>
                          <Icon name="gps-fixed" type="material" size={32} color={colorPrecision} />
                          <Text style={[styles.gpsPrecisionText, { color: colorPrecision }]}>{textoPrecision}</Text>
                        </View>

                        <View style={styles.gpsProgresoContainer}>
                          <View style={styles.gpsProgresoBarra}>
                            <View
                              style={[
                                styles.gpsProgresoFill,
                                {
                                  width: `${(intento / total) * 100}%`,
                                  backgroundColor: colorPrecision,
                                },
                              ]}
                            />
                          </View>
                          <Text style={styles.gpsProgresoTexto}>
                            Buscando señal {intento}/{total}
                          </Text>
                        </View>

                        {mostrarTipCalibracion && (
                          <View style={styles.gpsTipContainer}>
                            <Icon name="rotate-left" type="material" size={20} color="#FF9800" />
                            <Text style={styles.gpsTipTexto}>
                              Mueve el teléfono en forma de 8 para mejorar la precisión
                            </Text>
                          </View>
                        )}

                        <Text style={styles.gpsInstruccionesTexto}>
                          {precisionBuena
                            ? "Señal GPS excelente"
                            : precisionMedia
                              ? "Señal aceptable, espera un momento..."
                              : "Mejorando precisión..."}
                        </Text>
                      </>
                    );
                  })()}
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
                      const productosConRecuperaEnvase = FullSyncService.getProductosConRecuperaEnvase();
                      const baseProducts = showOnlyPromotions
                        ? productos.filter((p) => p.esKit || p.esPromocion)
                        : productos.filter((p) => (!p.esKit && !p.esPromocion) || productosConRecuperaEnvase.has(p.id));
                      // Ordenar: productos con recuperaEnvase primero (solo cuando no es kit/promocion)
                      let finalProducts = baseProducts;
                      if (!showOnlyPromotions) {
                        finalProducts = [...baseProducts].sort((a, b) => {
                          const aHasRecupera = productosConRecuperaEnvase.has(a.id) ? 1 : 0;
                          const bHasRecupera = productosConRecuperaEnvase.has(b.id) ? 1 : 0;
                          return bHasRecupera - aHasRecupera;
                        });
                      }
                      setFilteredProductos(finalProducts);
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.listTitle}>{item.descripcion}</Text>
                      <Text style={styles.listSubtitle}>Clave: {item.claveProd}</Text>
                      <Text style={styles.listSubtitle}>
                        Existencia: {item.existencia} {item.esKit ? " | Kit: Sí" : ""}
                      </Text>
                      {esProductoPrestamo(item.id) && <Text style={styles.precioDefaultBadge}>PRÉSTAMO</Text>}
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
          productoId={pendingIntercambioProducto?.id}
          onAccept={(data) => {
            console.log("[Sales] Intercambio aceptado:", data);
            const dataObj = {
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
            // Agregar el producto al carrito si no estaba, luego actualizar su precio
            setCart((prev) => {
              const alreadyIn = prev.some(
                (ci) => pendingIntercambioProducto && ci.id === pendingIntercambioProducto.id,
              );
              const base = alreadyIn
                ? prev
                : pendingIntercambioProducto
                ? [...prev, { ...pendingIntercambioProducto, cantidad: 1 }]
                : prev;
              let updatedCart = base.map((ci) => (esProductoIntercambio(ci.id) ? { ...ci, precio: data.costo } : ci));

              // Agregar producto 76 al carrito con precioEnvase si viene del modal
              // Usar cantRecEnvOtro para calcular la cantidad de envases (cantidad * cantRecEnvOtro)
              const precioEnvase = data.precioEnvase;
              const cantEnvases = data.cantRecEnvOtro > 0 ? data.cantRecEnvOtro : 1;
              console.log(
                `[Sales] precioEnvase recibido del modal: ${precioEnvase}, cantRecEnvOtro: ${data.cantRecEnvOtro}, cantidad: ${cantEnvases}`,
              );
              if (precioEnvase != null && precioEnvase > 0) {
                const prod76 = productosBase.find((p: any) => p.id === 76);
                const desc76 = prod76?.descripcion || "ENVASE";
                const clave76 = prod76?.claveProd || "76";
                const idxEnvase = updatedCart.findIndex((ci) => ci.id === 76);
                if (idxEnvase >= 0) {
                  updatedCart = updatedCart.map((ci) =>
                    ci.id === 76 ? { ...ci, cantidad: ci.cantidad + cantEnvases, precio: precioEnvase } : ci,
                  );
                } else {
                  updatedCart = [
                    ...updatedCart,
                    {
                      id: 76,
                      claveProd: String(clave76),
                      descripcion: desc76,
                      precio: precioEnvase,
                      existencia: 9999,
                      cantidad: cantEnvases,
                    },
                  ];
                }
                console.log(
                  `[Sales] Producto 76 (${desc76}) agregado al carrito con precio $${precioEnvase} x ${cantEnvases} envases`,
                );
              }

              return updatedCart;
            });
            setPendingIntercambioProducto(null);
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
          productoSeleccionado={pendingPrestamoProducto}
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

        <ModalDiagnosticoGps
          visible={diagnosticoGps !== null}
          data={diagnosticoGps}
          onClose={() => {
            setDiagnosticoGps(null);
            setReintentarValidacion(null);
          }}
          onReintentar={reintentarValidacion ?? undefined}
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
  domicilioTexto: {
    marginTop: SPACING.s,
    ...TYPOGRAPHY.body,
    fontSize: 13,
    color: COLORS.muted,
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
  gpsValidacionContainer: {
    paddingVertical: SPACING.l,
    alignItems: "center",
  },
  gpsPrecisionCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 4,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: SPACING.m,
    backgroundColor: "rgba(255, 255, 255, 0.05)",
  },
  gpsPrecisionText: {
    fontSize: 14,
    fontWeight: "700",
    marginTop: 4,
  },
  gpsProgresoContainer: {
    width: "100%",
    marginBottom: SPACING.m,
  },
  gpsProgresoBarra: {
    height: 6,
    backgroundColor: COLORS.border,
    borderRadius: 3,
    overflow: "hidden",
    marginBottom: SPACING.s,
  },
  gpsProgresoFill: {
    height: "100%",
    borderRadius: 3,
  },
  gpsProgresoTexto: {
    fontSize: 13,
    color: COLORS.textSecondary,
    textAlign: "center",
  },
  gpsTipContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 152, 0, 0.1)",
    padding: SPACING.s,
    borderRadius: BORDER_RADIUS.m,
    marginBottom: SPACING.m,
    gap: SPACING.s,
  },
  gpsTipTexto: {
    flex: 1,
    fontSize: 13,
    color: "#FF9800",
    lineHeight: 18,
  },
  gpsInstruccionesTexto: {
    fontSize: 14,
    color: COLORS.textSecondary,
    textAlign: "center",
    fontStyle: "italic",
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
