import React, { useState, useEffect, useCallback } from "react";
import { useFocusEffect } from "@react-navigation/native";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
  RefreshControl,
  ActivityIndicator,
  TextInput,
} from "react-native";
import { Icon } from "react-native-elements";
import PedidosService, { Pedido, ESTATUS_PEDIDO, esEstatusFinalPedido } from "../services/PedidosService";
import { normalizarObservaciones } from "../services/pedidoObservaciones";

type ProductoResumen = {
  nombre: string;
  cantidad: number;
};

interface PedidoAgrupado extends Pedido {
  folioKey: number;
  total?: number;
  productosResumen?: ProductoResumen[];
}

import AuthService from "../services/AuthService";
import FullSyncService from "../services/FullSyncService";
import LocationService, { LocationCoordinates, calcularDistancia } from "../services/LocationService";
import { COLORS, SPACING, BORDER_RADIUS, SHADOWS, TYPOGRAPHY } from "../theme/theme";

const esFechaDeHoy = (fechaEntrega?: Date | string | null): boolean => {
  if (!fechaEntrega) return false;

  const fecha = fechaEntrega instanceof Date ? fechaEntrega : new Date(String(fechaEntrega));
  if (Number.isNaN(fecha.getTime())) return false;

  const hoy = new Date();
  return (
    fecha.getFullYear() === hoy.getFullYear() &&
    fecha.getMonth() === hoy.getMonth() &&
    fecha.getDate() === hoy.getDate()
  );
};

const debeMostrarEnRuta = (pedido: Pedido): boolean =>
  Number(pedido.estatus) === ESTATUS_PEDIDO.CONFIRMADO ||
  Number(pedido.estatus) === ESTATUS_PEDIDO.PENDIENTE_CON_CAUSA ||
  Number(pedido.estatus) === ESTATUS_PEDIDO.PENDIENTE_SIN_CAUSA ||
  esFechaDeHoy(pedido.fechaEntrega);

const formatearMoneda = (valor?: number): string =>
  `$${Number(valor ?? 0).toLocaleString("es-MX", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const formatearDistancia = (distancia?: number | null): string => {
  if (distancia == null) return "No disponible";
  if (distancia >= 1000) return `${(distancia / 1000).toFixed(1)} km`;
  return `${Math.round(distancia)} m`;
};

const obtenerProductosResumen = (productos: Pedido[]): ProductoResumen[] => {
  const resumenPorProducto = new Map<string, ProductoResumen>();

  productos.forEach((producto) => {
    const clave = String(producto.idProducto);
    const nombre = String(producto.productoNombre ?? "").trim() || `Producto #${producto.idProducto}`;
    const cantidadPedido = Number(producto.cantPedido ?? 0);
    const cantidad = Number.isFinite(cantidadPedido) ? cantidadPedido : 0;
    const existente = resumenPorProducto.get(clave);

    resumenPorProducto.set(clave, {
      nombre: existente?.nombre || nombre,
      cantidad: (existente?.cantidad ?? 0) + cantidad,
    });
  });

  return Array.from(resumenPorProducto.values());
};

export default function PedidosScreen({ navigation }: { navigation: any }) {
  const [pedidos, setPedidos] = useState<PedidoAgrupado[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filtroEstatus, setFiltroEstatus] = useState<"pendientes" | "completados" | "todos">("pendientes");
  const [currentRuta, setCurrentRuta] = useState<number>(0);
  const [ubicacion, setUbicacion] = useState<LocationCoordinates | null>(null);

  const buscarClienteEnRealm = (idCliente: number): any => {
    const realm = (FullSyncService as any).realm;
    if (!realm) return null;
    let cliente = realm.objectForPrimaryKey("ClienteFull", Number(idCliente));
    if (!cliente) {
      const clientes = realm.objects("ClienteFull").filtered("id = $0", Number(idCliente));
      if (clientes.length > 0) cliente = clientes[0];
    }
    return cliente;
  };

  useFocusEffect(
    useCallback(() => {
      cargarPedidos();
    }, []),
  );

  const cargarPedidos = async () => {
    setLoading(true);
    try {
      const user = await AuthService.restoreSession();
      console.log("[PedidosScreen] Usuario de sesion:", JSON.stringify(user));
      if (!user) {
        Alert.alert("Error", "No hay sesión activa");
        return;
      }

      let ruta = user.ruta ? parseInt(String(user.ruta)) : 0;
      console.log(`[PedidosScreen] Ruta inicial de sesion: ${ruta}`);

      if (!ruta || ruta === 0) {
        // Fallback: buscar ruta en Realm por el usuario logueado
        if (!FullSyncService.isServiceInitialized()) {
          await FullSyncService.initialize();
        }
        const realm = (FullSyncService as any).realm;
        const usuarios = realm.objects("Usuario").filtered("claveEmpleado == $0", user.claveEmpleado);
        console.log(`[PedidosScreen] Usuarios en Realm con claveEmpleado ${user.claveEmpleado}: ${usuarios.length}`);
        if (usuarios.length > 0) {
          const u = usuarios[0] as any;
          if (u.ruta) {
            ruta = parseInt(String(u.ruta));
            console.log(`[PedidosScreen] Ruta obtenida de Realm: ${ruta}`);
          }
        }
      }

      if (!ruta || ruta === 0) {
        // Fallback final: cualquier usuario con ruta
        const realm = (FullSyncService as any).realm;
        const usuariosConRuta = realm.objects("Usuario").filtered("ruta != null && ruta != \"\"");
        if (usuariosConRuta.length > 0) {
          const u = usuariosConRuta[0] as any;
          ruta = parseInt(String(u.ruta));
          console.log(`[PedidosScreen] Ruta fallback de Realm: ${ruta}`);
        }
      }

      setCurrentRuta(ruta);

      if (!FullSyncService.isServiceInitialized()) {
        await FullSyncService.initialize();
      }

      const ubicacionActual = await LocationService.getCurrentLocation();
      setUbicacion(ubicacionActual);

      const pedidosService = PedidosService.getInstance();
      pedidosService.setRealm((FullSyncService as any).realm);

      const folios = pedidosService.getFoliosByRuta(ruta, true).filter((folio) => {
        const pedido = pedidosService.getPedidoByFolio(folio);
        return pedido ? debeMostrarEnRuta(pedido) : false;
      });
      const pedidosAgrupados: PedidoAgrupado[] = [];
      folios.forEach((folio) => {
        const pedido = pedidosService.getPedidoByFolio(folio);
        if (
          pedido &&
          pedido.estatus !== ESTATUS_PEDIDO.PROGRAMADO
        ) {
          const total = calcularTotalPedido(folio, pedido.cliente, pedido.listaPrecio);
          pedidosAgrupados.push({
            ...pedido,
            folioKey: folio,
            clienteNombre: pedido.clienteNombre || `Cliente #${pedido.cliente}`,
            clienteDomicilio: pedido.clienteDomicilio || "",
            observaciones: normalizarObservaciones(pedido.observaciones) ?? "",
            total,
            productosResumen: obtenerProductosResumen(pedidosService.getProductosByFolio(folio)),
          });
        }
      });
      console.log(`[PedidosScreen] Folios encontrados para ruta ${ruta}: ${folios.length}`);
      setPedidos(pedidosAgrupados);
    } catch (error) {
      console.error("[PedidosScreen] Error al cargar pedidos:", error);
      Alert.alert("Error", "No se pudieron cargar los pedidos");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    cargarPedidos();
  };

  const handleSyncPedidos = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const pedidosService = PedidosService.getInstance();
      pedidosService.setRealm((FullSyncService as any).realm);

      // Catálogos primero para que las descripciones de estatus se resuelvan correctamente
      await pedidosService.syncCatalogos();
      const result = await pedidosService.syncPedidos(currentRuta);
      if (result.success) {
        const folios = pedidosService.getFoliosByRuta(currentRuta, true).filter((folio) => {
          const pedido = pedidosService.getPedidoByFolio(folio);
          return pedido ? debeMostrarEnRuta(pedido) : false;
        });
        const pedidosAgrupados: PedidoAgrupado[] = [];
        folios.forEach((folio) => {
          const pedido = pedidosService.getPedidoByFolio(folio);
          if (
          pedido &&
          pedido.estatus !== ESTATUS_PEDIDO.PROGRAMADO
        ) {
            const total = calcularTotalPedido(folio, pedido.cliente, pedido.listaPrecio);
            pedidosAgrupados.push({
              ...pedido,
              folioKey: folio,
              clienteNombre: pedido.clienteNombre || `Cliente #${pedido.cliente}`,
              clienteDomicilio: pedido.clienteDomicilio || "",
              observaciones: normalizarObservaciones(pedido.observaciones) ?? "",
              total,
              productosResumen: obtenerProductosResumen(pedidosService.getProductosByFolio(folio)),
            });
          }
        });
        setPedidos(pedidosAgrupados);
        Alert.alert("Éxito", `Se sincronizaron ${result.count} renglones`);
      } else {
        Alert.alert("Error", "No se pudieron sincronizar los pedidos");
      }
    } catch (error) {
      console.error("[PedidosScreen] Error al sincronizar:", error);
      Alert.alert("Error", "Error al sincronizar pedidos");
    } finally {
      setRefreshing(false);
    }
  };

  const getEstatusColor = (estatus: number): string => {
    switch (estatus) {
      case ESTATUS_PEDIDO.PROGRAMADO:
        return "#2196F3";
      case ESTATUS_PEDIDO.EN_ATENCION:
        return "#FF9800";
      case ESTATUS_PEDIDO.ENTREGADO:
        return "#4CAF50";
      case ESTATUS_PEDIDO.ENTREGADO_PARCIAL:
        return "#FFC107";
      case ESTATUS_PEDIDO.PENDIENTE_CON_CAUSA:
        return "#9C27B0";
      case ESTATUS_PEDIDO.PENDIENTE_SIN_CAUSA:
        return "#F44336";
      case ESTATUS_PEDIDO.CANCELADO:
        return "#9E9E9E";
      default:
        return "#607D8B";
    }
  };

  const getEstatusIcon = (estatus: number): string => {
    switch (estatus) {
      case ESTATUS_PEDIDO.PROGRAMADO:
        return "schedule";
      case ESTATUS_PEDIDO.EN_ATENCION:
        return "edit";
      case ESTATUS_PEDIDO.ENTREGADO:
        return "check-circle";
      case ESTATUS_PEDIDO.ENTREGADO_PARCIAL:
        return "warning";
      case ESTATUS_PEDIDO.PENDIENTE_CON_CAUSA:
        return "info";
      case ESTATUS_PEDIDO.PENDIENTE_SIN_CAUSA:
        return "error";
      case ESTATUS_PEDIDO.CANCELADO:
        return "cancel";
      default:
        return "help";
    }
  };

  const obtenerPrecioProducto = (
    idProducto: number,
    preciosPromo: any[],
    preciosCliente: any[],
    preciosDefault: any[],
  ): number => {
    const pp = preciosPromo.find((p: any) => parseInt(p.claveProd || "0", 10) === idProducto);
    if (pp) return pp.precio || 0;
    const pc = preciosCliente.find((p: any) => parseInt(p.claveProd || "0", 10) === idProducto);
    if (pc) return pc.precio || 0;
    const pd = preciosDefault.find((p: any) => parseInt(p.claveProd || "0", 10) === idProducto);
    if (pd) return pd.precio || 0;
    return 0;
  };

  const calcularTotalPedido = (folio: number, cliente: number, listaPrecio?: number): number => {
    try {
      const ps = PedidosService.getInstance();
      const renglones = ps.getProductosByFolio(folio);
      if (renglones.length === 0) return 0;
      const preciosPromo = FullSyncService.getPreciosPromoByCliente(cliente);
      const preciosCliente = FullSyncService.getPreciosByListaPrecio(listaPrecio ?? 0);
      const preciosDefault = FullSyncService.getPreciosByListaPrecio(13);
      return renglones.reduce((sum, r) => {
        const precio = obtenerPrecioProducto(r.idProducto, preciosPromo, preciosCliente, preciosDefault) || (r.precio ?? 0);
        return sum + precio * (r.cantPedido || 0);
      }, 0);
    } catch (error) {
      console.error("[PedidosScreen] Error al calcular total:", error);
      return 0;
    }
  };

  const handleAbrirPedido = (pedido: PedidoAgrupado) => {
    navigation.navigate("PedidoDetalle", {
      folio: pedido.folioKey,
      soloLectura: esEstatusFinalPedido(pedido.estatus),
    });
  };

  const query = searchQuery.trim().toLowerCase();
  const pedidosFiltrados = pedidos.filter((p) => {
    const coincideEstatus =
      filtroEstatus === "todos" ||
      (filtroEstatus === "completados" && esEstatusFinalPedido(p.estatus)) ||
      (filtroEstatus === "pendientes" && !esEstatusFinalPedido(p.estatus));
    const coincideBusqueda =
      !query ||
      (p.clienteNombre || "").toLowerCase().includes(query) ||
      (p.clienteDomicilio || "").toLowerCase().includes(query) ||
      String(p.folio).includes(query) ||
      String(p.cliente).includes(query);

    return coincideEstatus && coincideBusqueda;
  });

  const totalPendientes = pedidos.filter((p) => !esEstatusFinalPedido(p.estatus)).length;
  const filtrosActivos = Boolean(query) || filtroEstatus !== "pendientes";

  const limpiarFiltros = () => {
    setSearchQuery("");
    setFiltroEstatus("pendientes");
  };

  const renderPedido = ({ item }: { item: PedidoAgrupado }) => {
    const clienteNombre = item.clienteNombre || `Cliente #${item.cliente}`;
    const clienteDomicilio = item.clienteDomicilio || "";
    const estatusColor = getEstatusColor(item.estatus);
    const estatusDescripcion = item.estatusDescripcion || "Estatus desconocido";
    const soloLectura = esEstatusFinalPedido(item.estatus);
    const accionPedido = soloLectura ? "Ver detalles" : "Atender pedido";
    const inicialCliente = clienteNombre.trim().charAt(0).toUpperCase() || "C";

    let distanciaTexto = "No disponible";
    let distanciaDisponible = false;
    const clienteFull = buscarClienteEnRealm(Number(item.cliente));
    if (ubicacion && clienteFull?.latitud != null && clienteFull?.longitud != null) {
      const dist = calcularDistancia(
        ubicacion.latitude,
        ubicacion.longitude,
        clienteFull.latitud,
        clienteFull.longitud,
      );
      distanciaTexto = formatearDistancia(dist);
      distanciaDisponible = true;
    }

    return (
      <View style={styles.card}>
        <View style={[styles.statusStrip, { backgroundColor: estatusColor }]} />
        <View style={styles.cardHeader}>
          <View style={styles.orderIdentity}>
            <Text style={styles.cardEyebrow}>PEDIDO</Text>
            <View style={styles.folioContainer}>
              <Icon name="receipt" type="material" size={18} color={COLORS.primary} />
              <Text style={styles.folioText}>#{item.folio}</Text>
            </View>
          </View>
          <View style={[styles.estatusBadge, { borderColor: estatusColor }]}>
            <Icon name={getEstatusIcon(item.estatus)} type="material" size={15} color={estatusColor} />
            <Text style={[styles.estatusText, { color: estatusColor }]} numberOfLines={1}>
              {estatusDescripcion}
            </Text>
          </View>
        </View>

        {item.fueraAgenda ? (
          <View style={styles.fueraAgendaBadge}>
            <Icon name="event-busy" type="material" size={15} color="#fff" />
            <Text style={styles.fueraAgendaText}>CLIENTE FUERA DE AGENDA</Text>
          </View>
        ) : null}

        <View style={styles.cardBody}>
          <View style={styles.clienteRow}>
            <View style={styles.clienteAvatar}>
              <Text style={styles.clienteAvatarText}>{inicialCliente}</Text>
            </View>
            <View style={styles.clienteInfo}>
              <Text style={styles.clienteNombre} numberOfLines={1}>
                {clienteNombre}
              </Text>
              <View style={styles.direccionRow}>
                <Icon name="place" type="material" size={15} color={COLORS.muted} />
                <Text style={styles.direccionText} numberOfLines={2}>
                  {clienteDomicilio || "Sin dirección registrada"}
                </Text>
              </View>
            </View>
          </View>

          <View style={styles.metricsRow}>
            <View style={styles.metricItem}>
              <View style={styles.metricIcon}>
                <Icon name="inventory-2" type="material" size={16} color={COLORS.primary} />
              </View>
              <View style={styles.metricCopy}>
                <Text style={styles.metricLabel}>Productos</Text>
                <Text style={styles.metricValue}>{item.numeroProductos}</Text>
              </View>
            </View>
            <View style={styles.metricDivider} />
            {/* <View style={styles.metricItem}>
              <View style={[styles.metricIcon, distanciaDisponible ? styles.metricIconSuccess : styles.metricIconMuted]}>
                <Icon
                  name="location-on"
                  type="material"
                  size={16}
                  color={distanciaDisponible ? COLORS.success : COLORS.muted}
                />
              </View>
              <View style={styles.metricCopy}>
                <Text style={styles.metricLabel}>Distancia</Text>
                <Text style={styles.metricValue} numberOfLines={1}>
                  {distanciaTexto}
                </Text>
              </View>
            </View> */}
            <View style={styles.metricDivider} />
            <View style={styles.metricItem}>
              <View style={[styles.metricIcon, styles.metricIconSuccess]}>
                <Icon name="attach-money" type="material" size={16} color={COLORS.success} />
              </View>
              <View style={styles.metricCopy}>
                <Text style={styles.metricLabel}>Importe</Text>
                <Text style={styles.metricValue} numberOfLines={1}>
                  {formatearMoneda(item.total)}
                </Text>
              </View>
            </View>
          </View>

          {item.productosResumen && item.productosResumen.length > 0 ? (
            <View style={styles.productNamesContainer}>
              <Icon name="list" type="material" size={16} color={COLORS.primary} />
              <View style={styles.productNamesCopy}>
                <Text style={styles.productNamesLabel}>Productos del pedido</Text>
                {item.productosResumen.map((producto, index) => (
                  <View key={`${producto.nombre}-${index}`} style={styles.productNameRow}>
                    <Text style={styles.productNameBullet}>•</Text>
                    <Text style={styles.productNamesText}>{producto.nombre}</Text>
                    <Text style={styles.productQuantityText}>x{producto.cantidad}</Text>
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          {item.observaciones ? (
            <View style={styles.observacionesContainer}>
              <Icon name="notes" type="material" size={15} color={COLORS.warning} />
              <Text style={styles.observacionesText} numberOfLines={2}>
                {item.observaciones}
              </Text>
            </View>
          ) : null}

          <TouchableOpacity
            style={[styles.irABtn, soloLectura && styles.irABtnSecondary]}
            onPress={() => handleAbrirPedido(item)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={`${accionPedido}, folio ${item.folio}`}
          >
            <Icon
              name={soloLectura ? "visibility" : "arrow-forward"}
              type="material"
              size={18}
              color={soloLectura ? COLORS.primary : "#fff"}
              style={{ marginRight: SPACING.xs }}
            />
            <Text style={[styles.irABtnText, soloLectura && styles.irABtnTextSecondary]}>{accionPedido}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.loadingText}>Cargando pedidos...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <View style={styles.titleBlock}>
            <Text style={styles.titulo}>Pedidos de Central</Text>
            <View style={styles.subtituloRow}>
              <Icon name="route" type="material" size={15} color="rgba(255,255,255,0.72)" />
              <Text style={styles.subtitulo}>
                {currentRuta > 0 ? `Ruta ${currentRuta}` : "Ruta no asignada"} · Entregas de hoy
              </Text>
            </View>
          </View>
          <TouchableOpacity
            onPress={handleSyncPedidos}
            style={styles.syncBtn}
            disabled={refreshing}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel="Sincronizar pedidos"
          >
            {refreshing ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Icon name="sync" type="material" size={22} color="#fff" />
            )}
          </TouchableOpacity>
        </View>

        <View style={styles.statsContainer}>
          <View style={styles.statItem}>
            <View style={styles.statIcon}>
              <Icon name="receipt" type="material" size={18} color="#fff" />
            </View>
            <View>
              <Text style={styles.statNumber}>{pedidos.length}</Text>
              <Text style={styles.statLabel}>Pedidos de hoy</Text>
            </View>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <View style={[styles.statIcon, styles.statIconWarning]}>
              <Icon name="schedule" type="material" size={18} color={COLORS.warning} />
            </View>
            <View>
              <Text style={[styles.statNumber, { color: "#FFD08A" }]}>{totalPendientes}</Text>
              <Text style={styles.statLabel}>Por atender</Text>
            </View>
          </View>
        </View>
      </View>

      <View style={styles.searchContainer}>
        <Icon name="search" type="material" size={21} color={COLORS.primary} />
        <TextInput
          style={styles.searchInput}
          placeholder="Buscar cliente o folio"
          placeholderTextColor={COLORS.muted}
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Buscar pedidos"
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity
            onPress={() => setSearchQuery("")}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Limpiar búsqueda"
          >
            <Icon name="close" type="material" size={20} color={COLORS.muted} />
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.statusFilterRow}>
        {([
          ["pendientes", "No completados"],
          ["completados", "Completados"],
          ["todos", "Todos"],
        ] as const).map(([value, label]) => (
          <TouchableOpacity
            key={value}
            style={[styles.statusFilterBtn, filtroEstatus === value && styles.statusFilterBtnActive]}
            onPress={() => setFiltroEstatus(value)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={`Filtrar ${label.toLowerCase()}`}
          >
            <Text style={[styles.statusFilterText, filtroEstatus === value && styles.statusFilterTextActive]}>
              {label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.resultsRow}>
        <View>
          <Text style={styles.sectionTitle}>Pedidos de hoy</Text>
          <Text style={styles.resultsText}>
            {pedidosFiltrados.length} de {pedidos.length} visibles en tu ruta
          </Text>
        </View>
        {filtrosActivos && (
          <TouchableOpacity
            style={styles.clearResultsBtn}
            onPress={limpiarFiltros}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Limpiar filtros"
          >
            <Icon name="clear" type="material" size={16} color={COLORS.primary} />
            <Text style={styles.clearResultsText}>Limpiar</Text>
          </TouchableOpacity>
        )}
      </View>

      <FlatList
        data={pedidosFiltrados}
        renderItem={renderPedido}
        keyExtractor={(item) => String(item.folioKey)}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            colors={[COLORS.primary]}
            tintColor={COLORS.primary}
          />
        }
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <View style={styles.emptyIcon}>
              <Icon name={filtrosActivos ? "search" : "inventory-2"} type="material" size={34} color={COLORS.primary} />
            </View>
            <Text style={styles.emptyTitle}>{filtrosActivos ? "No encontramos pedidos" : "Tu ruta está al día"}</Text>
            <Text style={styles.emptyText}>
              {filtrosActivos
                ? "Prueba con otro cliente, folio o estatus."
                : "No hay pedidos programados para entregar hoy."}
            </Text>
            {filtrosActivos && (
              <TouchableOpacity style={styles.emptyAction} onPress={limpiarFiltros} activeOpacity={0.8}>
                <Text style={styles.emptyActionText}>Limpiar filtros</Text>
              </TouchableOpacity>
            )}
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F6F7FB",
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#F6F7FB",
  },
  loadingText: {
    ...TYPOGRAPHY.body,
    marginTop: SPACING.m,
    color: COLORS.muted,
  },
  header: {
    backgroundColor: COLORS.primary,
    paddingTop: SPACING.l,
    paddingBottom: SPACING.l,
    paddingHorizontal: SPACING.m,
    borderBottomLeftRadius: BORDER_RADIUS.xl,
    borderBottomRightRadius: BORDER_RADIUS.xl,
    ...SHADOWS.medium,
  },
  headerTop: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: SPACING.l,
  },
  titleBlock: {
    flex: 1,
    marginRight: SPACING.m,
  },
  titulo: {
    ...TYPOGRAPHY.h2,
    color: "#fff",
    fontSize: 23,
  },
  subtituloRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: SPACING.xs,
    gap: SPACING.xs,
  },
  subtitulo: {
    ...TYPOGRAPHY.caption,
    flexShrink: 1,
    color: "rgba(255,255,255,0.72)",
    fontSize: 13,
  },
  syncBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.18)",
    borderRadius: BORDER_RADIUS.m,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
  },
  statsContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.1)",
    borderRadius: BORDER_RADIUS.m,
    paddingVertical: SPACING.s,
  },
  statItem: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: SPACING.s,
    gap: SPACING.s,
  },
  statIcon: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: BORDER_RADIUS.s,
    backgroundColor: "rgba(255,255,255,0.16)",
  },
  statIconWarning: {
    backgroundColor: "#FFF1DC",
  },
  statNumber: {
    fontSize: 23,
    lineHeight: 26,
    fontWeight: "bold",
    color: "#fff",
  },
  statLabel: {
    ...TYPOGRAPHY.caption,
    color: "rgba(255,255,255,0.72)",
    fontSize: 11,
  },
  statDivider: {
    width: 1,
    height: 34,
    backgroundColor: "rgba(255,255,255,0.25)",
  },
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 54,
    backgroundColor: "#fff",
    marginHorizontal: SPACING.m,
    marginTop: -SPACING.s,
    paddingHorizontal: SPACING.m,
    borderRadius: BORDER_RADIUS.l,
    borderWidth: 1,
    borderColor: "#E7E8F0",
    zIndex: 2,
    ...SHADOWS.small,
  },
  searchInput: {
    flex: 1,
    paddingVertical: SPACING.s,
    paddingHorizontal: SPACING.s,
    fontSize: 16,
    color: COLORS.textPrimary,
  },
  statusFilterRow: {
    flexDirection: "row",
    marginHorizontal: SPACING.m,
    marginTop: SPACING.s,
    gap: SPACING.s,
  },
  statusFilterBtn: {
    flex: 1,
    alignItems: "center",
    paddingVertical: SPACING.s,
    borderRadius: BORDER_RADIUS.m,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: "#fff",
  },
  statusFilterBtnActive: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.primary,
  },
  statusFilterText: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  statusFilterTextActive: {
    color: "#fff",
  },
  resultsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.m,
  },
  sectionTitle: {
    ...TYPOGRAPHY.h3,
    fontSize: 17,
    color: COLORS.textPrimary,
  },
  resultsText: {
    ...TYPOGRAPHY.small,
    marginTop: 2,
    color: COLORS.muted,
  },
  clearResultsBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: SPACING.s,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.s,
    backgroundColor: COLORS.primaryLight,
    gap: SPACING.xs,
  },
  clearResultsText: {
    fontSize: 12,
    fontWeight: "700",
    color: COLORS.primary,
  },
  list: {
    flexGrow: 1,
    paddingHorizontal: SPACING.m,
    paddingBottom: SPACING.xxl,
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: BORDER_RADIUS.l,
    marginBottom: SPACING.m,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#ECEEF4",
    ...SHADOWS.small,
  },
  statusStrip: {
    height: 4,
    width: "100%",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    padding: SPACING.m,
    gap: SPACING.s,
  },
  col: {
    justifyContent: "center",
  },
  colNombre: {
    flex: 2.5,
  },
  colDireccion: {
    flex: 2,
  },
  colNumero: {
    flex: 0.8,
    alignItems: "center",
  },
  colDistancia: {
    flex: 1.2,
    alignItems: "center",
  },
  colText: {
    ...TYPOGRAPHY.body,
    fontSize: 13,
    color: COLORS.textPrimary,
  },
  colTextSmall: {
    ...TYPOGRAPHY.caption,
    fontSize: 12,
    color: COLORS.textSecondary,
  },
  irABtn: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.primary,
    paddingHorizontal: SPACING.m,
    borderRadius: BORDER_RADIUS.m,
  },
  irABtnSecondary: {
    backgroundColor: COLORS.primaryLight,
  },
  irABtnText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "bold",
  },
  irABtnTextSecondary: {
    color: COLORS.primary,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: SPACING.m,
    paddingTop: SPACING.m,
    paddingBottom: SPACING.s,
    borderBottomWidth: 1,
    borderBottomColor: "#F0F1F5",
  },
  orderIdentity: {
    flex: 1,
    marginRight: SPACING.s,
  },
  cardEyebrow: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1,
    color: COLORS.muted,
    marginBottom: SPACING.xs,
  },
  folioContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.xs,
  },
  folioText: {
    fontSize: 17,
    fontWeight: "700",
    color: COLORS.primary,
  },
  estatusBadge: {
    maxWidth: "58%",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: SPACING.s,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.round,
    borderWidth: 1,
    backgroundColor: "#F8F9FC",
    gap: SPACING.xs,
  },
  estatusText: {
    flexShrink: 1,
    fontSize: 11,
    fontWeight: "700",
  },
  cardBody: {
    padding: SPACING.m,
  },
  clienteRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: SPACING.m,
  },
  clienteAvatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: COLORS.primaryLight,
    alignItems: "center",
    justifyContent: "center",
    marginRight: SPACING.m,
  },
  clienteAvatarText: {
    color: COLORS.primary,
    fontSize: 18,
    fontWeight: "bold",
  },
  clienteInfo: {
    flex: 1,
  },
  clienteNombre: {
    ...TYPOGRAPHY.h3,
    fontSize: 17,
    color: COLORS.textPrimary,
    marginBottom: SPACING.xs,
  },
  direccionRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: SPACING.xs,
  },
  direccionText: {
    ...TYPOGRAPHY.caption,
    fontSize: 13,
    lineHeight: 18,
    color: COLORS.textSecondary,
    flex: 1,
  },
  metricsRow: {
    flexDirection: "row",
    alignItems: "stretch",
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: "#EFF0F4",
    paddingVertical: SPACING.s,
    marginBottom: SPACING.m,
  },
  metricItem: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: SPACING.xs,
    gap: SPACING.xs,
  },
  metricIcon: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: BORDER_RADIUS.s,
    backgroundColor: COLORS.primaryLight,
  },
  metricIconSuccess: {
    backgroundColor: "#EAF6E6",
  },
  metricIconMuted: {
    backgroundColor: "#F0F1F5",
  },
  metricCopy: {
    flex: 1,
    minWidth: 0,
  },
  metricLabel: {
    fontSize: 10,
    color: COLORS.muted,
    marginBottom: 2,
  },
  metricValue: {
    fontSize: 13,
    fontWeight: "700",
    color: COLORS.textPrimary,
  },
  metricDivider: {
    width: 1,
    marginVertical: SPACING.xs,
    backgroundColor: "#EFF0F4",
  },
  productNamesContainer: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: SPACING.s,
    backgroundColor: "#F7F8FC",
    padding: SPACING.s,
    borderRadius: BORDER_RADIUS.s,
    marginBottom: SPACING.m,
  },
  productNamesCopy: {
    flex: 1,
  },
  productNamesLabel: {
    fontSize: 10,
    color: COLORS.muted,
    marginBottom: 2,
  },
  productNameRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: SPACING.xs,
    marginTop: 2,
  },
  productNameBullet: {
    ...TYPOGRAPHY.caption,
    color: COLORS.primary,
    lineHeight: 17,
  },
  productNamesText: {
    ...TYPOGRAPHY.caption,
    flex: 1,
    color: COLORS.textPrimary,
    lineHeight: 17,
  },
  productQuantityText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.textPrimary,
    fontWeight: "700",
    lineHeight: 17,
  },
  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.s,
    marginBottom: SPACING.s,
  },
  infoText: {
    ...TYPOGRAPHY.body,
    flex: 1,
    fontSize: 14,
  },
  infoTextSmall: {
    ...TYPOGRAPHY.caption,
    flex: 1,
    fontSize: 12,
  },
  observacionesContainer: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: SPACING.xs,
    backgroundColor: "#FFF8E1",
    padding: SPACING.s,
    borderRadius: BORDER_RADIUS.s,
    marginBottom: SPACING.m,
  },
  observacionesText: {
    ...TYPOGRAPHY.caption,
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    color: "#A56600",
  },
  fueraAgendaBadge: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.warning,
    padding: SPACING.s,
    gap: SPACING.xs,
  },
  fueraAgendaText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "600",
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.xxl,
  },
  emptyIcon: {
    width: 72,
    height: 72,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 36,
    backgroundColor: COLORS.primaryLight,
    marginBottom: SPACING.m,
  },
  emptyTitle: {
    ...TYPOGRAPHY.h3,
    fontSize: 18,
    textAlign: "center",
    color: COLORS.textPrimary,
  },
  emptyText: {
    ...TYPOGRAPHY.body,
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
    color: COLORS.muted,
    marginTop: SPACING.s,
  },
  emptyAction: {
    marginTop: SPACING.m,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    borderRadius: BORDER_RADIUS.m,
    backgroundColor: COLORS.primary,
  },
  emptyActionText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
  },
});
