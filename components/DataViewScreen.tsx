import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  FlatList,
  RefreshControl,
  Alert,
  Modal,
} from "react-native";
// import Clipboard from "@react-native-clipboard/clipboard"; // TODO: Re-enable when TurboModule issue is fixed
import { Icon } from "react-native-elements";
import FullSyncService from "../services/FullSyncService";
import VisitaSyncService from "../services/VisitaSyncService";
import AuthService from "../services/AuthService";
import { COLORS, SPACING, SHADOWS, BORDER_RADIUS, TYPOGRAPHY } from "../theme/theme";

type EntityType =
  | "ventas"
  | "usuarios"
  | "productos"
  | "kits"
  | "precios"
  | "preciosPromo"
  | "inventario"
  | "cartera"
  | "clientes"
  | "syncStatus"
  | "syncLog"
  | "bitacora"
  | "cierreRuta"
  | "visitas"
  | "detalleVisitas"
  | "tipoVisita"
  | "bitacoraSync"
  | "cumplimiento"
  | "bitacoraGps"
  | "inventarioEnvase"
  | "inventarioEnvasesHistorial"
  | "reubicaciones"
  | "visitasRealizadas";

interface EntityTab {
  key: EntityType;
  title: string;
  icon: string;
}

const ENTITY_TABS: EntityTab[] = [
  { key: "ventas", title: "Ventas", icon: "attach-money" },
  { key: "clientes", title: "Clientes", icon: "people" },
  { key: "productos", title: "Productos", icon: "inventory" },
  { key: "kits", title: "Kits", icon: "category" },
  { key: "precios", title: "Precios", icon: "price-check" },
  { key: "preciosPromo", title: "Precios Promo", icon: "local-offer" },
  { key: "inventario", title: "Inventario", icon: "bar-chart" },
  { key: "cartera", title: "Cartera", icon: "account-balance-wallet" },
  { key: "usuarios", title: "Usuarios", icon: "person" },
  { key: "syncStatus", title: "Sync Status", icon: "sync" },
  { key: "syncLog", title: "Sync Log", icon: "list-alt" },
  { key: "bitacora", title: "Bitácora Tabla", icon: "history" },
  { key: "cierreRuta", title: "Cierre Ruta", icon: "lock" },
  { key: "visitas", title: "Visitas", icon: "calendar-check" },
  { key: "detalleVisitas", title: "Detalle Visitas", icon: "assignment" },
  { key: "tipoVisita", title: "Tipo Visita", icon: "label" },
  { key: "bitacoraSync", title: "Bitácora Sync", icon: "cloud-sync" },
  { key: "cumplimiento", title: "Cumplimiento", icon: "trending-up" },
  { key: "bitacoraGps", title: "Bitácora GPS", icon: "location-on" },
  { key: "inventarioEnvase", title: "Inventario Envase", icon: "inventory-2" },
  { key: "inventarioEnvasesHistorial", title: "Historial Envases", icon: "history-toggle-off" },
  { key: "reubicaciones", title: "Reubicaciones", icon: "place" },
  { key: "visitasRealizadas", title: "Visitas Realizadas", icon: "check-circle" },
];

export default function DataViewScreen() {
  const [selectedTab, setSelectedTab] = useState<EntityType>("ventas");
  const [data, setData] = useState<any[]>([]);
  const [stats, setStats] = useState<any>({});
  const [refreshing, setRefreshing] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [currentSucursal, setCurrentSucursal] = useState<number>(1);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const ITEMS_PER_PAGE = 50;

  // Obtener sucursal del usuario logueado
  useEffect(() => {
    const init = async () => {
      try {
        const user = await AuthService.restoreSession();
        if (user) {
          const sucursal =
            (user.sucursal_origen as number | null | undefined) ?? (user.sucursal as number | null | undefined) ?? 1;
          setCurrentSucursal(sucursal);
          console.log(`[DataViewScreen] Sucursal actual: ${sucursal}`);
        }
      } catch (error) {
        console.error("[DataViewScreen] Error al obtener sucursal:", error);
      }
    };
    init();
  }, []);

  const loadData = useCallback(async () => {
    try {
      await FullSyncService.initialize();

      const newStats = FullSyncService.getStats();
      setStats(newStats);

      const offset = currentPage * ITEMS_PER_PAGE;

      switch (selectedTab) {
        case "ventas":
          setData(FullSyncService.getVentasPaginated(offset, ITEMS_PER_PAGE));
          break;
        case "usuarios":
          setData(FullSyncService.getUsuariosPaginated(offset, ITEMS_PER_PAGE));
          break;
        case "productos":
          setData(FullSyncService.getProductosPaginated(offset, ITEMS_PER_PAGE));
          break;
        case "kits":
          setData(FullSyncService.getKitsPaginated(offset, ITEMS_PER_PAGE));
          break;
        case "precios":
          setData(FullSyncService.getPreciosPaginated(offset, ITEMS_PER_PAGE));
          break;
        case "preciosPromo":
          setData(FullSyncService.getPreciosPromoPaginated(offset, ITEMS_PER_PAGE));
          break;
        case "inventario":
          setData(FullSyncService.getInventarioPaginated(offset, ITEMS_PER_PAGE));
          break;
        case "cartera":
          setData(FullSyncService.getCarteraPaginated(offset, ITEMS_PER_PAGE));
          break;
        case "clientes":
          setData(FullSyncService.getClientesFullPaginated(offset, ITEMS_PER_PAGE));
          break;
        case "syncStatus":
          setData(FullSyncService.getSyncStatusPaginated(offset, ITEMS_PER_PAGE));
          break;
        case "syncLog":
          setData(FullSyncService.getSyncLogsPaginated(offset, ITEMS_PER_PAGE));
          break;
        case "bitacora":
          setData(FullSyncService.getSyncTableLogsPaginated(offset, ITEMS_PER_PAGE));
          break;
        case "cierreRuta":
          setData(FullSyncService.getCierreRutaPaginated(offset, ITEMS_PER_PAGE));
          break;
        case "visitas":
          const visitas = await VisitaSyncService.getInstance().getVisitasByFecha(new Date(), currentSucursal);
          setData(visitas);
          break;
        case "detalleVisitas":
          setData(FullSyncService.getDetalleVisitasPaginated(offset, ITEMS_PER_PAGE));
          break;
        case "tipoVisita":
          setData(FullSyncService.getTipoVisitasPaginated(offset, ITEMS_PER_PAGE));
          break;
        case "bitacoraSync":
          setData(FullSyncService.getBitacoraSyncPaginated(offset, ITEMS_PER_PAGE));
          break;
        case "cumplimiento":
          const stats = await VisitaSyncService.getInstance().getEstadisticasCumplimiento(new Date(), currentSucursal);
          setData([stats]);
          break;
        case "bitacoraGps":
          setData(FullSyncService.getBitacoraGpsPaginated(offset, ITEMS_PER_PAGE));
          break;
        case "inventarioEnvase":
          setData(FullSyncService.getInventarioEnvasePaginated(offset, ITEMS_PER_PAGE));
          break;
        case "inventarioEnvasesHistorial":
          setData(FullSyncService.getInventarioEnvasesHistorialPaginated(offset, ITEMS_PER_PAGE));
          break;
        case "reubicaciones":
          setData(FullSyncService.getReubicacionesPaginated(offset, ITEMS_PER_PAGE));
          break;
        case "visitasRealizadas":
          setData(FullSyncService.getVisitasRealizadasPaginated(offset, ITEMS_PER_PAGE));
          break;
      }
    } catch (error) {
      console.error("Error al cargar datos:", error);
      Alert.alert("Error", "No se pudieron cargar los datos");
    }
  }, [selectedTab, currentPage]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  const handleTabChange = (tab: EntityType) => {
    setSelectedTab(tab);
    setCurrentPage(0);
    setExpandedIndex(null);
    setDropdownOpen(false);
  };

  const selectedTabInfo = ENTITY_TABS.find((t) => t.key === selectedTab);

  const serializeItem = (item: any): string => {
    try {
      const plain: Record<string, any> = {};
      for (const key of Object.keys(item)) {
        const val = (item as any)[key];
        if (val instanceof Date) {
          plain[key] = val.toISOString();
        } else {
          plain[key] = val;
        }
      }
      return JSON.stringify(plain, null, 2);
    } catch {
      return String(item);
    }
  };

  const handleNextPage = () => {
    const totalRecords = getCount();
    const maxPage = Math.ceil(totalRecords / ITEMS_PER_PAGE) - 1;
    if (currentPage < maxPage) {
      setCurrentPage(currentPage + 1);
    }
  };

  const handlePreviousPage = () => {
    if (currentPage > 0) {
      setCurrentPage(currentPage - 1);
    }
  };

  const renderVenta = ({ item }: { item: any }) => (
    <TouchableOpacity onPress={() => consoleRealm("s", item)}>
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Venta #{item.noVenta}</Text>
          <Text style={styles.cardSubtitle}>{item.fecha?.toLocaleDateString()}</Text>
        </View>
        <View style={styles.cardBody}>
          <Text style={styles.cardText}>Cliente: {item.nombreCliente}</Text>
          <Text style={styles.cardText}>Producto: {item.nombreProducto}</Text>
          <Text style={styles.cardText}>Cantidad: {item.cantProducto}</Text>
          <Text style={styles.cardPrice}>Importe: ${item.importe?.toFixed(2)}</Text>
          <Text style={styles.cardText}>Vendedor: {item.vendedor}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderBitacora = ({ item }: { item: any }) => (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{item.tabla}</Text>
        <View style={styles.headerRight}>
          <Text style={styles.cardSubtitle}>
            {item.fechaInicio ? new Date(item.fechaInicio).toLocaleString() : "Sin fecha"}
          </Text>
          <TouchableOpacity
            style={styles.copyButton}
            onPress={() => {
              if (!item.endpoint) {
                Alert.alert("Sin endpoint", "No hay endpoint para copiar");
                return;
              }
              // Clipboard.setString(String(item.endpoint)); // TODO: Re-enable when TurboModule issue is fixed
              Alert.alert("Endpoint", String(item.endpoint));
            }}
          >
            <Icon name="content-copy" type="material" size={16} color={COLORS.primary} />
            <Text style={styles.copyButtonText}>Copiar</Text>
          </TouchableOpacity>
        </View>
      </View>
      <View style={styles.cardBody}>
        <Text style={styles.cardText}>SyncLog ID: {item.syncLogId}</Text>
        <Text style={styles.cardText}>ID Bitácora: {item.id}</Text>
        <Text style={styles.cardText}>Endpoint: {item.endpoint || "N/A"}</Text>
        <Text style={styles.cardText}>Duración: {item.duracionMs ? `${item.duracionMs} ms` : "N/A"}</Text>
        <Text style={styles.cardText}>
          Leídos: {item.registrosLeidos ?? 0} | Guardados: {item.registrosGuardados ?? 0} | Actualizados:{" "}
          {item.registrosActualizados ?? 0}
        </Text>
        <Text style={styles.cardText}>
          Estado:{" "}
          <Text style={{ color: item.exitoso ? COLORS.success : COLORS.error }}>
            {item.exitoso ? "Éxito" : "Error"}
          </Text>
        </Text>
        {!item.exitoso && item.razon ? (
          <Text style={[styles.cardText, { color: COLORS.error }]}>Razón: {item.razon}</Text>
        ) : null}
        {item.detalles ? <Text style={styles.cardText}>Detalles: {item.detalles}</Text> : null}
      </View>
    </View>
  );

  const renderCliente = ({ item }: { item: any }) => (
    <TouchableOpacity onPress={() => consoleRealm("s", item)}>
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>{item.nombre}</Text>
          <Text style={styles.cardSubtitle}>ID: {item.id}</Text>
        </View>
        <View style={styles.cardBody}>
          <Text style={styles.cardText}>Grupo: {item.idGrupo || "N/A"}</Text>
          <Text style={styles.cardText}>Crédito: {item.credito ? "Sí" : "No"}</Text>
          <Text style={styles.cardText}>Facturación móvil: {item.facturacionMovil ? "Sí" : "No"}</Text>
          {item.latitud && item.longitud ? (
            <Text style={styles.cardText}>
              Ubicación: {item.latitud.toFixed(4)}, {item.longitud.toFixed(4)}
            </Text>
          ) : null}
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderProducto = ({ item }: { item: any }) => (
    <TouchableOpacity onPress={() => console.log(item)}>
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>{item.descripcion}</Text>
          <Text style={styles.cardSubtitle}>Clave: {item.claveProd}</Text>
        </View>
        <View style={styles.cardBody}>
          <Text style={styles.cardText}>ID: {item.id}</Text>
          <Text style={styles.cardText}>Es Kit: {item.esKit ? "Sí" : "No"}</Text>
          <Text style={styles.cardText}>Actualizado: {item.fechaAct?.toLocaleDateString() || "N/A"}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderKit = ({ item }: { item: any }) => (
    <TouchableOpacity onPress={() => console.log(item)}>
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Kit #{item.id}</Text>
          <Text style={styles.cardSubtitle}>Producto: {item.idProducto ?? "N/A"}</Text>
        </View>
        <View style={styles.cardBody}>
          <Text style={styles.cardText}>Insumo: {item.idInsumo ?? "N/A"}</Text>
          <Text style={styles.cardText}>Cantidad: {item.cantidad ?? 0}</Text>
          <Text style={styles.cardText}>Precio: {item.precio ?? 0}</Text>
          <Text style={styles.cardText}>Descuento: {item.descuento ?? 0}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderPrecio = ({ item }: { item: any }) => (
    <TouchableOpacity onPress={() => console.log(item)}>
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>{item.descripcion}</Text>
          <Text style={styles.cardPrice}>${item.precio?.toFixed(2)}</Text>
        </View>
        <View style={styles.cardBody}>
          <Text style={styles.cardText}>ID Cliente: {item.idCliente}</Text>
          <Text style={styles.cardText}>Clave Producto: {item.claveProd}</Text>
          <Text style={styles.cardText}>Actualizado: {item.fechaAct?.toLocaleDateString() || "N/A"}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderInventario = ({ item }: { item: any }) => (
    <TouchableOpacity onPress={() => console.log(item)}>
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Producto {item.claveProd}</Text>
          <Text style={styles.cardSubtitle}>Sucursal {item.sucursal}</Text>
        </View>
        <View style={styles.cardBody}>
          <Text style={styles.cardText}>ID: {item.id}</Text>
          <Text style={styles.cardPrice}>Saldo: {item.saldo}</Text>
          <Text style={styles.cardText}>Fecha Arrastre: {item.fechaArrastre?.toLocaleString() || "N/A"}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderCartera = ({ item }: { item: any }) => (
    <TouchableOpacity onPress={() => console.log(item)}>
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>{item.nombreCliente}</Text>
          <Text style={styles.cardPrice}>${item.saldo?.toFixed(2)}</Text>
        </View>
        <View style={styles.cardBody}>
          <Text style={styles.cardText}>ID Cliente: {item.idCliente}</Text>
          <Text style={styles.cardText}>Sucursal: {item.sucursal}</Text>
          <Text style={styles.cardText}>No. Venta: {item.noVenta}</Text>
          <Text style={styles.cardText}>Fecha: {item.fecha?.toLocaleDateString() || "N/A"}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderUsuario = ({ item }: { item: any }) => (
    <TouchableOpacity onPress={() => consoleRealm("s", item)}>
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>{item.nombre}</Text>
          <Text style={styles.cardSubtitle}>{item.claveEmpleado}</Text>
        </View>
        <View style={styles.cardBody}>
          <Text style={styles.cardText}>Perfil: {item.descripcionPerfil}</Text>
          <Text style={styles.cardText}>Puesto: {item.descripcionPuesto}</Text>
          <Text style={styles.cardText}>Sucursal Origen: {item.sucursalOrigen}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderVisita = ({ item }: { item: any }) => (
    <TouchableOpacity onPress={() => console.log(item)}>
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Visita #{item.id}</Text>
          <Text style={styles.cardSubtitle}>Cliente: {item.idCliente}</Text>
        </View>
        <View style={styles.cardBody}>
          <Text style={styles.cardText}>Ruta: {item.ruta}</Text>
          <Text style={styles.cardText}>Visitado: {item.visitado ? "✅ Sí" : "❌ No"}</Text>
          <Text style={styles.cardText}>Lunes: {item.l ? "✅" : "❌"}</Text>
          <Text style={styles.cardText}>Martes: {item.m ? "✅" : "❌"}</Text>
          <Text style={styles.cardText}>Miércoles: {item.mi ? "✅" : "❌"}</Text>
          <Text style={styles.cardText}>Jueves: {item.j ? "✅" : "❌"}</Text>
          <Text style={styles.cardText}>Viernes: {item.v ? "✅" : "❌"}</Text>
          <Text style={styles.cardText}>Sábado: {item.s ? "✅" : "❌"}</Text>
          <Text style={styles.cardText}>Domingo: {item.d ? "✅" : "❌"}</Text>
          {item.fecha && <Text style={styles.cardText}>Fecha: {new Date(item.fecha).toLocaleDateString()}</Text>}
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderPrecioPromo = ({ item }: { item: any }) => (
    <TouchableOpacity onPress={() => console.log(item)}>
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>{item.descripcion}</Text>
          <Text style={styles.cardPrice}>${item.precio?.toFixed(2)}</Text>
        </View>
        <View style={styles.cardBody}>
          <Text style={styles.cardText}>ID Cliente: {item.idCliente}</Text>
          <Text style={styles.cardText}>Clave Producto: {item.claveProd}</Text>
          <Text style={styles.cardText}>Descuento: {item.descuento || 0}%</Text>
          <Text style={styles.cardText}>
            Vigencia: {item.fechaInicio?.toLocaleDateString()} - {item.fechaFin?.toLocaleDateString()}
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderSyncStatus = ({ item }: { item: any }) => (
    <TouchableOpacity onPress={() => console.log(item)}>
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>{item.id}</Text>
          <Text style={[styles.cardSubtitle, { color: item.status === "completed" ? COLORS.success : COLORS.error }]}>
            {item.status}
          </Text>
        </View>
        <View style={styles.cardBody}>
          <Text style={styles.cardText}>Última Sync: {item.lastSyncDate?.toLocaleString() || "N/A"}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderSyncLog = ({ item }: { item: any }) => (
    <TouchableOpacity onPress={() => console.log(item)}>
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Sync #{item.id}</Text>
          <Text style={styles.cardSubtitle}>{item.tipo}</Text>
        </View>
        <View style={styles.cardBody}>
          <Text style={styles.cardText}>Inicio: {item.fechaInicio?.toLocaleString() || "N/A"}</Text>
          <Text style={styles.cardText}>Fin: {item.fechaFinal?.toLocaleString() || "N/A"}</Text>
          <Text style={styles.cardText}>Duración: {item.duracionMs ? `${item.duracionMs} ms` : "N/A"}</Text>
          <Text style={styles.cardText}>Total Registros: {item.totalRegistros || 0}</Text>
          <Text style={styles.cardText}>
            Estado:{" "}
            <Text style={{ color: item.exitoso ? COLORS.success : COLORS.error }}>
              {item.exitoso ? "Éxito" : "Error"}
            </Text>
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderCierreRuta = ({ item }: { item: any }) => (
    <TouchableOpacity onPress={() => console.log(item)}>
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Ruta {item.id}</Text>
          <Text style={[styles.cardSubtitle, { color: item.rutaCerrada ? COLORS.error : COLORS.success }]}>
            {item.rutaCerrada ? "🔒 Cerrada" : "🔓 Abierta"}
          </Text>
        </View>
        <View style={styles.cardBody}>
          <Text style={styles.cardText}>Sucursal: {item.sucursal}</Text>
          <Text style={styles.cardText}>Vendedor: {item.vendedor}</Text>
          <Text style={styles.cardText}>Fecha Cierre: {item.fechaCierre?.toLocaleString() || "N/A"}</Text>
          <Text style={styles.cardText}>Actualizado: {item.updatedAt?.toLocaleString() || "N/A"}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderDetalleVisitas = ({ item }: { item: any }) => (
    <TouchableOpacity onPress={() => console.log(item)}>
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Visita {item.id}</Text>
          <Text style={styles.cardSubtitle}>Cliente: {item.idCliente}</Text>
        </View>
        <View style={styles.cardBody}>
          <Text style={styles.cardText}>Usuario: {item.idUsuario}</Text>
          <Text style={styles.cardText}>Ruta: {item.idRuta}</Text>
          <Text style={styles.cardText}>Tipo: {item.tipoVisita}</Text>
          <Text style={styles.cardText}>Inicio: {item.fechaInicio?.toLocaleString() || "N/A"}</Text>
          <Text style={styles.cardText}>Fin: {item.fechaFin?.toLocaleString() || "N/A"}</Text>
          <Text style={styles.cardText}>Sincronizado: {item.syncedAt?.toLocaleString() || "Pendiente"}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderTipoVisita = ({ item }: { item: any }) => (
    <TouchableOpacity onPress={() => console.log(item)}>
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>{item.descripcion}</Text>
          <Text style={styles.cardSubtitle}>ID: {item.id}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderBitacoraSync = ({ item }: { item: any }) => (
    <TouchableOpacity onPress={() => console.log(item)}>
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>{item.tabla}</Text>
          <Text style={[styles.cardSubtitle, { color: item.exitoso ? COLORS.success : COLORS.error }]}>
            {item.exitoso ? "✅" : "❌"}
          </Text>
        </View>
        <View style={styles.cardBody}>
          <Text style={styles.cardText}>Tipo: {item.tipoSync}</Text>
          <Text style={styles.cardText}>Usuario: {item.nombreUsuario}</Text>
          <Text style={styles.cardText}>Sucursal: {item.sucursal}</Text>
          <Text style={styles.cardText}>Inicio: {item.fechaInicio?.toLocaleString() || "N/A"}</Text>
          <Text style={styles.cardText}>Duración: {item.duracionMs ? `${item.duracionMs} ms` : "N/A"}</Text>
          <Text style={styles.cardText}>
            Leídos: {item.registrosLeidos || 0} | Guardados: {item.registrosGuardados || 0}
          </Text>
          <Text style={styles.cardText}>Conexión: {item.tipoConexion}</Text>
          {item.error && <Text style={[styles.cardText, { color: COLORS.error }]}>Error: {item.error}</Text>}
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderCumplimiento = ({ item }: { item: any }) => (
    <TouchableOpacity onPress={() => console.log(item)}>
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>📊 Estadísticas de Cumplimiento</Text>
        </View>
        <View style={styles.cardBody}>
          <Text style={styles.cardText}>📅 Visitas Programadas: {item.totalProgramadas}</Text>
          <Text style={styles.cardText}>✅ Visitas Realizadas: {item.totalRealizadas}</Text>
          <Text style={styles.cardText}></Text>
          <View style={styles.progressBar}>
            <View style={[styles.progressFill, { width: `${item.porcentaje}%` }]} />
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderItem = ({ item }: { item: any }) => {
    switch (selectedTab) {
      case "ventas":
        return renderVenta({ item });
      case "clientes":
        return renderCliente({ item });
      case "productos":
        return renderProducto({ item });
      case "kits":
        return renderKit({ item });
      case "precios":
        return renderPrecio({ item });
      case "preciosPromo":
        return renderPrecioPromo({ item });
      case "inventario":
        return renderInventario({ item });
      case "cartera":
        return renderCartera({ item });
      case "usuarios":
        return renderUsuario({ item });
      case "syncStatus":
        return renderSyncStatus({ item });
      case "syncLog":
        return renderSyncLog({ item });
      case "bitacora":
        return renderBitacora({ item });
      case "cierreRuta":
        return renderCierreRuta({ item });
      case "visitas":
        return renderVisita({ item });
      case "detalleVisitas":
        return renderDetalleVisitas({ item });
      case "tipoVisita":
        return renderTipoVisita({ item });
      case "bitacoraSync":
        return renderBitacoraSync({ item });
      case "cumplimiento":
        return renderCumplimiento({ item });
      default:
        return null;
    }
  };

  const getCount = () => {
    switch (selectedTab) {
      case "ventas":
        return stats.ventas || 0;
      case "usuarios":
        return stats.usuarios || 0;
      case "productos":
        return stats.productos || 0;
      case "kits":
        return stats.kits || 0;
      case "precios":
        return stats.precios || 0;
      case "preciosPromo":
        return stats.preciosPromo || 0;
      case "inventario":
        return stats.inventario || 0;
      case "cartera":
        return stats.cartera || 0;
      case "clientes":
        return stats.clientes || 0;
      case "syncStatus":
        return stats.syncStatus || 0;
      case "syncLog":
        return stats.syncLog || 0;
      case "bitacora":
        return stats.bitacora || 0;
      case "cierreRuta":
        return stats.cierreRuta || 0;
      case "visitas":
        return data.length; // Las visitas vienen de VisitaSyncService
      case "detalleVisitas":
        return stats.detalleVisitas || 0;
      case "tipoVisita":
        return stats.tipoVisita || 0;
      case "bitacoraSync":
        return stats.bitacoraSync || 0;
      case "cumplimiento":
        return data.length; // El cumplimiento es un solo objeto
      case "bitacoraGps":
        return stats.bitacoraGps || 0;
      case "inventarioEnvase":
        return stats.inventarioEnvase || 0;
      case "inventarioEnvasesHistorial":
        return stats.inventarioEnvasesHistorial || 0;
      case "reubicaciones":
        return stats.reubicaciones || 0;
      case "visitasRealizadas":
        return stats.visitasRealizadas || 0;
      default:
        return 0;
    }
  };

  return (
    <View style={styles.container}>
      {/* Dropdown selector */}
      <TouchableOpacity style={styles.dropdownButton} onPress={() => setDropdownOpen(true)}>
        <View style={styles.dropdownButtonInner}>
          <Icon name={selectedTabInfo?.icon ?? "list"} type="material" size={20} color={COLORS.primary} />
          <Text style={styles.dropdownButtonText}>{selectedTabInfo?.title ?? "Seleccionar tabla"}</Text>
          <View style={styles.dropdownBadge}>
            <Text style={styles.dropdownBadgeText}>{getCount()}</Text>
          </View>
        </View>
        <Icon name="arrow-drop-down" type="material" size={24} color={COLORS.textSecondary} />
      </TouchableOpacity>

      {/* Modal dropdown */}
      <Modal visible={dropdownOpen} transparent animationType="fade" onRequestClose={() => setDropdownOpen(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setDropdownOpen(false)}>
          <View style={styles.modalList}>
            <Text style={styles.modalTitle}>Seleccionar tabla</Text>
            <ScrollView showsVerticalScrollIndicator>
              {ENTITY_TABS.map((tab) => (
                <TouchableOpacity
                  key={tab.key}
                  style={[styles.modalItem, selectedTab === tab.key && styles.modalItemActive]}
                  onPress={() => handleTabChange(tab.key)}
                >
                  <Icon
                    name={tab.icon}
                    type="material"
                    size={18}
                    color={selectedTab === tab.key ? "#fff" : COLORS.textSecondary}
                  />
                  <Text style={[styles.modalItemText, selectedTab === tab.key && styles.modalItemTextActive]}>
                    {tab.title}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Stats Summary */}
      <View style={styles.statsContainer}>
        <Text style={styles.statsText}>
          Mostrando {data.length} de {getCount()} registros
        </Text>
      </View>

      {/* Pagination Controls */}
      <View style={styles.paginationContainer}>
        <TouchableOpacity
          style={[styles.paginationButton, currentPage === 0 && styles.paginationButtonDisabled]}
          onPress={handlePreviousPage}
          disabled={currentPage === 0}
        >
          <Icon
            name="chevron-left"
            type="material"
            color={currentPage === 0 ? COLORS.textSecondary : "#fff"}
            size={20}
          />
          <Text style={[styles.paginationButtonText, currentPage === 0 && { color: COLORS.textSecondary }]}>
            Anterior
          </Text>
        </TouchableOpacity>
        <Text style={styles.paginationInfo}>
          Página {currentPage + 1} de {Math.ceil(getCount() / ITEMS_PER_PAGE) || 1}
        </Text>
        <TouchableOpacity
          style={[
            styles.paginationButton,
            currentPage >= Math.ceil(getCount() / ITEMS_PER_PAGE) - 1 && styles.paginationButtonDisabled,
          ]}
          onPress={handleNextPage}
          disabled={currentPage >= Math.ceil(getCount() / ITEMS_PER_PAGE) - 1}
        >
          <Text
            style={[
              styles.paginationButtonText,
              currentPage >= Math.ceil(getCount() / ITEMS_PER_PAGE) - 1 && {
                color: COLORS.textSecondary,
              },
            ]}
          >
            Siguiente
          </Text>
          <Icon
            name="chevron-right"
            type="material"
            color={currentPage >= Math.ceil(getCount() / ITEMS_PER_PAGE) - 1 ? COLORS.textSecondary : "#fff"}
            size={20}
          />
        </TouchableOpacity>
      </View>

      {/* JSON Data List */}
      <FlatList
        data={data}
        keyExtractor={(item, index) => `${selectedTab}-${item.id ?? item.idBitacoraMovil ?? index}`}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[COLORS.primary]}
            tintColor={COLORS.primary}
          />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Icon name="inbox" type="material" size={64} color={COLORS.muted} style={{ marginBottom: 16 }} />
            <Text style={styles.emptyText}>No hay datos sincronizados</Text>
            <Text style={styles.emptySubtext}>Inicia sesión nuevamente para sincronizar</Text>
          </View>
        }
        renderItem={({ item, index }) => {
          const isExpanded = expandedIndex === index;
          return (
            <TouchableOpacity onPress={() => setExpandedIndex(isExpanded ? null : index)} activeOpacity={0.8}>
              <View style={styles.jsonCard}>
                <View style={styles.jsonCardHeader}>
                  <Text style={styles.jsonCardIndex}>#{currentPage * ITEMS_PER_PAGE + index + 1}</Text>
                  <Text style={styles.jsonCardId} numberOfLines={1}>
                    {item.id ?? item.idBitacoraMovil ?? item.noVenta ?? "—"}
                  </Text>
                  <Icon
                    name={isExpanded ? "expand-less" : "expand-more"}
                    type="material"
                    size={20}
                    color={COLORS.textSecondary}
                  />
                </View>
                {isExpanded && (
                  <ScrollView horizontal showsHorizontalScrollIndicator>
                    <Text style={styles.jsonText}>{serializeItem(item)}</Text>
                  </ScrollView>
                )}
              </View>
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  dropdownButton: {
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  dropdownButtonInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
  },
  dropdownButtonText: {
    fontSize: 16,
    fontWeight: "700",
    color: COLORS.textPrimary,
    flex: 1,
  },
  dropdownBadge: {
    backgroundColor: COLORS.primary,
    borderRadius: BORDER_RADIUS.round,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  dropdownBadgeText: {
    fontSize: 12,
    fontWeight: "bold",
    color: "#fff",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    paddingHorizontal: SPACING.l,
  },
  modalList: {
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.l,
    paddingVertical: SPACING.s,
    maxHeight: "70%",
    ...SHADOWS.medium,
  },
  modalTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: COLORS.textSecondary,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    marginBottom: 4,
  },
  modalItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: SPACING.m,
    paddingVertical: 12,
    borderRadius: BORDER_RADIUS.s,
    marginHorizontal: 4,
  },
  modalItemActive: {
    backgroundColor: COLORS.primary,
  },
  modalItemText: {
    fontSize: 15,
    color: COLORS.textPrimary,
    flex: 1,
  },
  modalItemTextActive: {
    color: "#fff",
    fontWeight: "700",
  },
  jsonCard: {
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.m,
    marginBottom: SPACING.s,
    overflow: "hidden",
    ...SHADOWS.small,
  },
  jsonCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: SPACING.m,
    paddingVertical: 10,
    gap: 8,
  },
  jsonCardIndex: {
    fontSize: 11,
    color: COLORS.muted,
    minWidth: 32,
    fontFamily: "monospace",
  },
  jsonCardId: {
    fontSize: 13,
    fontWeight: "600",
    color: COLORS.textPrimary,
    flex: 1,
  },
  jsonText: {
    fontFamily: "monospace",
    fontSize: 12,
    color: COLORS.textSecondary,
    padding: SPACING.m,
    backgroundColor: COLORS.background,
    lineHeight: 18,
  },
  statsContainer: {
    backgroundColor: COLORS.surface,
    paddingVertical: SPACING.s,
    paddingHorizontal: SPACING.m,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  statsText: {
    fontSize: 14,
    color: COLORS.textSecondary,
    fontWeight: "500",
  },
  listContent: {
    padding: SPACING.m,
  },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.l,
    padding: SPACING.m,
    marginBottom: SPACING.m,
    ...SHADOWS.small,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: SPACING.s,
    paddingBottom: SPACING.s,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "bold",
    color: COLORS.textPrimary,
    flex: 1,
  },
  cardSubtitle: {
    fontSize: 12,
    color: COLORS.muted,
    marginLeft: 8,
  },
  headerRight: {
    alignItems: "flex-end",
    gap: 4,
  },
  cardBody: {
    gap: 4,
  },
  cardText: {
    fontSize: 14,
    color: COLORS.textSecondary,
    lineHeight: 20,
  },
  cardPrice: {
    fontSize: 16,
    fontWeight: "bold",
    color: COLORS.primary,
  },
  emptyContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: SPACING.xxl,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: "600",
    color: COLORS.textSecondary,
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 14,
    color: COLORS.muted,
  },
  paginationContainer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: COLORS.surface,
    paddingVertical: SPACING.m,
    paddingHorizontal: SPACING.m,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  paginationButton: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    borderRadius: BORDER_RADIUS.m,
    minWidth: 100,
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    gap: 4,
  },
  paginationButtonDisabled: {
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  paginationButtonText: {
    color: "#FFF",
    fontWeight: "600",
    fontSize: 14,
  },
  paginationInfo: {
    fontSize: 14,
    fontWeight: "600",
    color: COLORS.textSecondary,
  },
  copyButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderRadius: BORDER_RADIUS.s,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  copyButtonText: {
    color: COLORS.primary,
    fontSize: 12,
    fontWeight: "600",
  },
  progressBar: {
    height: 8,
    backgroundColor: COLORS.border,
    borderRadius: 4,
    marginTop: 8,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: COLORS.success,
    borderRadius: 4,
  },
});
