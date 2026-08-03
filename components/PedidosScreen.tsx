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
import PedidosService, { Pedido, ESTATUS_PEDIDO } from "../services/PedidosService";

interface PedidoAgrupado extends Pedido {
  folioKey: number;
  total?: number;
}
import AuthService from "../services/AuthService";
import FullSyncService from "../services/FullSyncService";
import LocationService, { LocationCoordinates, calcularDistancia } from "../services/LocationService";
import { COLORS, SPACING, BORDER_RADIUS, SHADOWS, TYPOGRAPHY } from "../theme/theme";

export default function PedidosScreen({ navigation }: { navigation: any }) {
  const [pedidos, setPedidos] = useState<PedidoAgrupado[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filtroEstatus, setFiltroEstatus] = useState<number | null>(null);
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

      const folios = pedidosService.getFoliosByRuta(ruta);
      const pedidosAgrupados: PedidoAgrupado[] = [];
      folios.forEach((folio) => {
        const pedido = pedidosService.getPedidoByFolio(folio);
        if (pedido) {
          const clienteFull = buscarClienteEnRealm(pedido.cliente);
          const total = calcularTotalPedido(folio, pedido.cliente, pedido.listaPrecio);
          pedidosAgrupados.push({
            ...pedido,
            folioKey: folio,
            clienteNombre: clienteFull?.nombre || pedido.clienteNombre || `Cliente #${pedido.cliente}`,
            clienteDomicilio: clienteFull?.domicilio || pedido.clienteDomicilio || "",
            observaciones: pedido.observaciones || "",
            total,
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
    setRefreshing(true);
    cargarPedidos();
  };

  const handleSyncPedidos = async () => {
    setRefreshing(true);
    try {
      const pedidosService = PedidosService.getInstance();
      pedidosService.setRealm((FullSyncService as any).realm);

      // Catálogos primero para que las descripciones de estatus se resuelvan correctamente
      await pedidosService.syncCatalogos();
      const result = await pedidosService.syncPedidos(currentRuta);
      if (result.success) {
        const folios = pedidosService.getFoliosByRuta(currentRuta);
        const pedidosAgrupados: PedidoAgrupado[] = [];
        folios.forEach((folio) => {
          const pedido = pedidosService.getPedidoByFolio(folio);
          if (pedido) {
            const clienteFull = buscarClienteEnRealm(pedido.cliente);
            const total = calcularTotalPedido(folio, pedido.cliente, pedido.listaPrecio);
            pedidosAgrupados.push({
              ...pedido,
              folioKey: folio,
              clienteNombre: clienteFull?.nombre || pedido.clienteNombre || `Cliente #${pedido.cliente}`,
              clienteDomicilio: clienteFull?.domicilio || pedido.clienteDomicilio || "",
              observaciones: pedido.observaciones || "",
              total,
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
    if (
      pedido.estatus === ESTATUS_PEDIDO.ENTREGADO ||
      pedido.estatus === ESTATUS_PEDIDO.CANCELADO ||
      pedido.estatus === ESTATUS_PEDIDO.ENTREGADO_PARCIAL ||
      pedido.estatus === ESTATUS_PEDIDO.PENDIENTE_CON_CAUSA
    ) {
      navigation.navigate("PedidoDetalle", { folio: pedido.folioKey, soloLectura: true });
    } else {
      navigation.navigate("PedidoDetalle", { folio: pedido.folioKey, soloLectura: false });
    }
  };

  const pedidosFiltrados = pedidos.filter((p) => {
    const coincideBusqueda =
      !searchQuery.trim() ||
      (p.clienteNombre || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      String(p.folio).includes(searchQuery) ||
      String(p.cliente).includes(searchQuery);

    const coincideEstatus = filtroEstatus === null || p.estatus === filtroEstatus;

    return coincideBusqueda && coincideEstatus;
  });

  const totalPendientes = pedidos.filter(
    (p) =>
      p.estatus !== ESTATUS_PEDIDO.ENTREGADO &&
      p.estatus !== ESTATUS_PEDIDO.CANCELADO &&
      p.estatus !== ESTATUS_PEDIDO.ENTREGADO_PARCIAL,
  ).length;

  const renderPedido = ({ item }: { item: PedidoAgrupado }) => {
    const clienteFull = buscarClienteEnRealm(Number(item.cliente));
    const clienteNombre = item.clienteNombre || `Cliente #${item.cliente}`;
    const clienteDomicilio = item.clienteDomicilio || "";
    const estatusColor = getEstatusColor(item.estatus);

    let distanciaTexto = "--- M";
    if (ubicacion && clienteFull?.latitud != null && clienteFull?.longitud != null) {
      const dist = calcularDistancia(
        ubicacion.latitude,
        ubicacion.longitude,
        clienteFull.latitud,
        clienteFull.longitud,
      );
      distanciaTexto = `${Math.round(dist)} M`;
    }

    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.folioContainer}>
            <Icon name="receipt" type="material" size={18} color={COLORS.primary} />
            <Text style={styles.folioText}>Folio: {item.folio}</Text>
          </View>
          <View style={[styles.estatusBadge, { backgroundColor: estatusColor }]}>
            <Text style={styles.estatusText}>{item.estatusDescripcion || "N/A"}</Text>
          </View>
        </View>

        <View style={styles.cardBody}>
          <View style={styles.clienteRow}>
            <View style={styles.clienteAvatar}>
              <Text style={styles.clienteAvatarText}>{clienteNombre.charAt(0).toUpperCase()}</Text>
            </View>
            <View style={styles.clienteInfo}>
              <Text style={styles.clienteNombre} numberOfLines={1}>
                {clienteNombre}
              </Text>
              <View style={styles.direccionRow}>
                <Icon name="place" type="material" size={14} color={COLORS.muted} />
                <Text style={styles.direccionText} numberOfLines={1}>
                  {clienteDomicilio || "Sin dirección"}
                </Text>
              </View>
            </View>
          </View>

          <View style={styles.badgesRow}>
            <View style={styles.badge}>
              <Icon name="inventory-2" type="material" size={14} color={COLORS.primary} />
              <Text style={styles.badgeText}>{item.numeroProductos} productos</Text>
            </View>
            <View style={[styles.badge, styles.badgeDistancia]}>
              <Icon name="location-on" type="material" size={14} color={COLORS.success} />
              <Text style={[styles.badgeText, styles.badgeDistanciaText]}>{distanciaTexto}</Text>
            </View>
          </View>

          {item.observaciones ? (
            <View style={styles.observacionesContainer}>
              <Icon name="notes" type="material" size={14} color={COLORS.warning} />
              <Text style={styles.observacionesText} numberOfLines={1}>
                {item.observaciones}
              </Text>
            </View>
          ) : null}

          <TouchableOpacity
            style={styles.irABtn}
            onPress={() => handleAbrirPedido(item)}
            activeOpacity={0.8}
          >
            <Icon name="arrow-forward" type="material" size={18} color="#fff" style={{ marginRight: SPACING.xs }} />
            <Text style={styles.irABtnText}>IR A PEDIDO</Text>
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
          <Text style={styles.titulo}>Pedidos de Central</Text>
          <TouchableOpacity onPress={handleSyncPedidos} style={styles.syncBtn}>
            {refreshing ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Icon name="sync" type="material" size={22} color="#fff" />
            )}
          </TouchableOpacity>
        </View>

        <View style={styles.statsContainer}>
          <View style={styles.statItem}>
            <Text style={styles.statNumber}>{pedidos.length}</Text>
            <Text style={styles.statLabel}>Total</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={[styles.statNumber, { color: COLORS.warning }]}>{totalPendientes}</Text>
            <Text style={styles.statLabel}>Pendientes</Text>
          </View>
        </View>
      </View>

      <View style={styles.searchContainer}>
        <Icon name="search" type="material" size={20} color={COLORS.muted} />
        <TextInput
          style={styles.searchInput}
          placeholder="Buscar por cliente, folio..."
          placeholderTextColor={COLORS.muted}
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setSearchQuery("")}>
            <Icon name="close" type="material" size={20} color={COLORS.muted} />
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.filterContainer}>
        <TouchableOpacity
          style={[styles.filterBtn, filtroEstatus === null && styles.filterBtnActive]}
          onPress={() => setFiltroEstatus(null)}
        >
          <Text style={[styles.filterText, filtroEstatus === null && styles.filterTextActive]}>
            Todos
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.filterBtn, filtroEstatus === ESTATUS_PEDIDO.PENDIENTE_SIN_CAUSA && styles.filterBtnActive]}
          onPress={() =>
            setFiltroEstatus(
              filtroEstatus === ESTATUS_PEDIDO.PENDIENTE_SIN_CAUSA ? null : ESTATUS_PEDIDO.PENDIENTE_SIN_CAUSA,
            )
          }
        >
          <Text
            style={[
              styles.filterText,
              filtroEstatus === ESTATUS_PEDIDO.PENDIENTE_SIN_CAUSA && styles.filterTextActive,
            ]}
          >
            Sin Causa
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.filterBtn, filtroEstatus === ESTATUS_PEDIDO.EN_ATENCION && styles.filterBtnActive]}
          onPress={() =>
            setFiltroEstatus(filtroEstatus === ESTATUS_PEDIDO.EN_ATENCION ? null : ESTATUS_PEDIDO.EN_ATENCION)
          }
        >
          <Text
            style={[
              styles.filterText,
              filtroEstatus === ESTATUS_PEDIDO.EN_ATENCION && styles.filterTextActive,
            ]}
          >
            En Atención
          </Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={pedidosFiltrados}
        renderItem={renderPedido}
        keyExtractor={(item) => item.id.toString()}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Icon name="inventory" type="material" size={64} color={COLORS.muted} />
            <Text style={styles.emptyText}>
              {searchQuery || filtroEstatus !== null ? "Sin resultados" : "No hay pedidos"}
            </Text>
          </View>
        }
      />
    </View>
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
    backgroundColor: "#F2F2F7",
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
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: SPACING.m,
  },
  titulo: {
    ...TYPOGRAPHY.h2,
    color: "#fff",
    fontSize: 22,
  },
  syncBtn: {
    backgroundColor: "rgba(255,255,255,0.2)",
    padding: SPACING.s,
    borderRadius: BORDER_RADIUS.m,
  },
  statsContainer: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.1)",
    borderRadius: BORDER_RADIUS.m,
    padding: SPACING.m,
  },
  statItem: {
    alignItems: "center",
    paddingHorizontal: SPACING.l,
  },
  statNumber: {
    fontSize: 28,
    fontWeight: "bold",
    color: "#fff",
  },
  statLabel: {
    ...TYPOGRAPHY.caption,
    color: "rgba(255,255,255,0.8)",
    fontSize: 12,
  },
  statDivider: {
    width: 1,
    height: 30,
    backgroundColor: "rgba(255,255,255,0.3)",
  },
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    marginHorizontal: SPACING.m,
    marginTop: SPACING.m,
    paddingHorizontal: SPACING.m,
    borderRadius: BORDER_RADIUS.m,
    ...SHADOWS.small,
  },
  searchInput: {
    flex: 1,
    paddingVertical: SPACING.m,
    paddingHorizontal: SPACING.s,
    fontSize: 16,
    color: COLORS.textPrimary,
  },
  filterContainer: {
    flexDirection: "row",
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    gap: SPACING.s,
  },
  filterBtn: {
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    borderRadius: BORDER_RADIUS.round,
    backgroundColor: "#fff",
    ...SHADOWS.small,
  },
  filterBtnActive: {
    backgroundColor: COLORS.primary,
  },
  filterText: {
    ...TYPOGRAPHY.caption,
    fontWeight: "600",
    color: COLORS.textSecondary,
  },
  filterTextActive: {
    color: "#fff",
  },
  list: {
    padding: SPACING.m,
    paddingBottom: SPACING.xxl,
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: BORDER_RADIUS.l,
    marginBottom: SPACING.m,
    overflow: "hidden",
    ...SHADOWS.medium,
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
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.primary,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.m,
    borderRadius: BORDER_RADIUS.m,
  },
  irABtnText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "bold",
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: SPACING.m,
    borderBottomWidth: 1,
    borderBottomColor: "#F0F0F0",
  },
  folioContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.xs,
  },
  folioText: {
    ...TYPOGRAPHY.body,
    fontWeight: "600",
    color: COLORS.primary,
  },
  estatusBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: SPACING.s,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.round,
    gap: SPACING.xs,
  },
  estatusText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "600",
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
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: COLORS.primary,
    alignItems: "center",
    justifyContent: "center",
    marginRight: SPACING.m,
  },
  clienteAvatarText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "bold",
  },
  clienteInfo: {
    flex: 1,
  },
  clienteNombre: {
    ...TYPOGRAPHY.h3,
    fontSize: 16,
    color: COLORS.textPrimary,
    marginBottom: SPACING.xs,
  },
  direccionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.xs,
  },
  direccionText: {
    ...TYPOGRAPHY.caption,
    fontSize: 13,
    color: COLORS.textSecondary,
    flex: 1,
  },
  badgesRow: {
    flexDirection: "row",
    gap: SPACING.s,
    marginBottom: SPACING.m,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#F2F2F7",
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    borderRadius: BORDER_RADIUS.round,
    gap: SPACING.xs,
  },
  badgeText: {
    ...TYPOGRAPHY.caption,
    fontSize: 12,
    color: COLORS.textPrimary,
    fontWeight: "600",
  },
  badgeDistancia: {
    backgroundColor: "#E8F5E9",
  },
  badgeDistanciaText: {
    color: COLORS.success,
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
    marginTop: SPACING.s,
  },
  observacionesText: {
    ...TYPOGRAPHY.caption,
    flex: 1,
    fontSize: 12,
    color: COLORS.warning,
    fontStyle: "italic",
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
    paddingVertical: SPACING.xxl,
  },
  emptyText: {
    ...TYPOGRAPHY.body,
    color: COLORS.muted,
    marginTop: SPACING.m,
  },
});
