import React, { useState, useEffect, useCallback } from "react";
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
import PedidosService, { Pedido, PedidoDetalle, ESTATUS_PEDIDO } from "../services/PedidosService";
import FullSyncService from "../services/FullSyncService";
import LocationService from "../services/LocationService";
import AuthService from "../services/AuthService";
import { COLORS, SPACING, BORDER_RADIUS, SHADOWS, TYPOGRAPHY } from "../theme/theme";

interface Props {
  navigation: any;
  route: any;
}

export default function PedidoDetalleScreen({ navigation, route }: Props) {
  const { pedidoId, soloLectura } = route.params;

  const [pedido, setPedido] = useState<Pedido | null>(null);
  const [detalles, setDetalles] = useState<PedidoDetalle[]>([]);
  const [loading, setLoading] = useState(true);
  const [validandoGPS, setValidandoGPS] = useState(false);
  const [gpsValidado, setGpsValidado] = useState(false);

  const [modalCausaVisible, setModalCausaVisible] = useState(false);
  const [productoSeleccionado, setProductoSeleccionado] = useState<PedidoDetalle | null>(null);
  const [causasDiferencia, setCausasDiferencia] = useState<{ id: number; descripcion: string }[]>([]);
  const [causaSeleccionada, setCausaSeleccionada] = useState<number | null>(null);
  const [observacionCausa, setObservacionCausa] = useState("");

  const [modalNoAtencionVisible, setModalNoAtencionVisible] = useState(false);
  const [causasNoAtencion, setCausasNoAtencion] = useState<{ id: number; descripcion: string }[]>([]);
  const [causaNoAtencionSel, setCausaNoAtencionSel] = useState<number | null>(null);
  const [observacionNoAtencion, setObservacionNoAtencion] = useState("");

  useEffect(() => {
    cargarDatos();
  }, []);

  const cargarDatos = async () => {
    setLoading(true);
    try {
      if (!FullSyncService.isServiceInitialized()) {
        await FullSyncService.initialize();
      }

      const pedidosService = PedidosService.getInstance();
      pedidosService.setRealm((FullSyncService as any).realm);

      const pedidoData = pedidosService.getPedidoById(pedidoId);
      const detallesData = pedidosService.getDetallePedido(pedidoId);
      const causasDif = pedidosService.getCausasDiferencia();
      const causasNoAt = pedidosService.getCausasNoAtencion();

      setPedido(pedidoData);
      setDetalles(detallesData);
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

  const validarGPS = async () => {
    if (!pedido) return;

    setValidandoGPS(true);
    try {
      const ubicacion = await LocationService.getBestLocation();
      if (ubicacion) {
        setGpsValidado(true);
        // Al validar GPS el vendedor comienza la atención del pedido
        const pedidosService = PedidosService.getInstance();
        pedidosService.setRealm((FullSyncService as any).realm);
        pedidosService.iniciarAtencionPedido(pedidoId);
        // Refrescar pedido para mostrar nuevo estatus
        const pedidoActualizado = pedidosService.getPedidoById(pedidoId);
        if (pedidoActualizado) setPedido(pedidoActualizado);
      } else {
        Alert.alert("GPS", "No se pudo obtener tu ubicación. Verifica el GPS.");
      }
    } catch (error) {
      console.error("[PedidoDetalle] Error GPS:", error);
      Alert.alert("Error", "Error al validar ubicación");
    } finally {
      setValidandoGPS(false);
    }
  };

  const abrirModalCausa = (detalle: PedidoDetalle) => {
    setProductoSeleccionado(detalle);
    setCausaSeleccionada(detalle.causaDiferencia || null);
    setObservacionCausa(detalle.obserDiferencia || "");
    setModalCausaVisible(true);
  };

  const confirmarCausaDiferencia = () => {
    if (!productoSeleccionado || causaSeleccionada === null) {
      Alert.alert("Error", "Seleccione una causa");
      return;
    }

    const pedidosService = PedidosService.getInstance();
    pedidosService.setRealm((FullSyncService as any).realm);

    const success = pedidosService.registrarCausaDiferencia(
      pedidoId,
      productoSeleccionado.idProducto,
      causaSeleccionada,
      observacionCausa,
    );

    if (success) {
      const detallesActualizados = pedidosService.getDetallePedido(pedidoId);
      setDetalles(detallesActualizados);
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

    const pedidosService = PedidosService.getInstance();
    pedidosService.setRealm((FullSyncService as any).realm);

    const success = pedidosService.cambiarEstatusPedido(
      pedidoId,
      ESTATUS_PEDIDO.PENDIENTE_CON_CAUSA,
      causaNoAtencionSel,
      observacionNoAtencion,
    );

    if (success) {
      setModalNoAtencionVisible(false);
      Alert.alert("Éxito", "Pedido marcado como pendiente con causa", [
        { text: "OK", onPress: () => navigation.goBack() },
      ]);
    } else {
      Alert.alert("Error", "No se pudo actualizar el pedido");
    }
  };

  const confirmarEntrega = () => {
    const productosConDiferencia = detalles.filter((d) => d.tieneDiferencia && !d.causaDiferencia);

    if (productosConDiferencia.length > 0) {
      Alert.alert(
        "Productos sin causa",
        `Hay ${productosConDiferencia.length} producto(s) con diferencia sin causa registrada. Debe registrar la causa antes de confirmar.`,
      );
      return;
    }

    const todosEntregados = detalles.every((d) => d.cantAtencion === d.cantPedido);
    const hayEntregados = detalles.some((d) => d.cantAtencion && d.cantAtencion > 0);

    let nuevoEstatus: number;
    let mensaje: string;

    if (todosEntregados) {
      nuevoEstatus = ESTATUS_PEDIDO.ENTREGADO;
      mensaje = "¿Confirmar entrega completa del pedido?";
    } else if (hayEntregados) {
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
        onPress: () => {
          const pedidosService = PedidosService.getInstance();
          pedidosService.setRealm((FullSyncService as any).realm);

          const success = pedidosService.cambiarEstatusPedido(pedidoId, nuevoEstatus);

          if (success) {
            Alert.alert("Éxito", nuevoEstatus === ESTATUS_PEDIDO.ENTREGADO ? "Entrega confirmada" : "Entrega parcial confirmada", [
              { text: "OK", onPress: () => navigation.goBack() },
            ]);
          } else {
            Alert.alert("Error", "No se pudo confirmar la entrega");
          }
        },
      },
    ]);
  };

  const calcularResumen = () => {
    const totalSolicitado = detalles.reduce((sum, d) => sum + d.cantPedido, 0);
    const totalEntregado = detalles.reduce((sum, d) => sum + (d.cantAtencion || 0), 0);
    const conDiferencia = detalles.filter((d) => d.tieneDiferencia).length;

    return { totalSolicitado, totalEntregado, conDiferencia };
  };

  const actualizarCantidadLocal = (idProducto: number, cantidad: number) => {
    const pedidosService = PedidosService.getInstance();
    pedidosService.setRealm((FullSyncService as any).realm);
    const success = pedidosService.actualizarCantAtencion(pedidoId, idProducto, cantidad);
    if (success) {
      const detallesActualizados = pedidosService.getDetallePedido(pedidoId);
      setDetalles(detallesActualizados);
    }
  };

  const ajustarCantidad = (idProducto: number, delta: number) => {
    const detalle = detalles.find((d) => d.idProducto === idProducto);
    if (!detalle || soloLectura) return;
    const actual = detalle.cantAtencion ?? 0;
    const nueva = Math.max(0, Math.min(detalle.cantPedido, actual + delta));
    actualizarCantidadLocal(idProducto, nueva);
  };

  const entregarTodoProducto = (idProducto: number) => {
    const detalle = detalles.find((d) => d.idProducto === idProducto);
    if (!detalle || soloLectura) return;
    actualizarCantidadLocal(idProducto, detalle.cantPedido);
  };

  const entregarTodoPedido = () => {
    if (soloLectura) return;
    detalles.forEach((d) => {
      actualizarCantidadLocal(d.idProducto, d.cantPedido);
    });
  };

  const renderProducto = ({ item }: { item: PedidoDetalle }) => {
    const cantAtencion = item.cantAtencion ?? 0;
    const tieneDiferencia = cantAtencion < item.cantPedido;
    const atendidoCompleto = cantAtencion === item.cantPedido;

    return (
      <View style={[styles.productoCard, tieneDiferencia && styles.productoCardDiferencia]}>
        <View style={styles.productoHeader}>
          <Icon
            name={atendidoCompleto ? "check-circle" : tieneDiferencia ? "warning" : "radio-button-unchecked"}
            type="material"
            size={22}
            color={atendidoCompleto ? COLORS.success : tieneDiferencia ? COLORS.warning : COLORS.muted}
          />
          <Text style={styles.productoNombre} numberOfLines={2}>
            {item.productoNombre || `Producto #${item.idProducto}`}
          </Text>
        </View>

        <View style={styles.cantidadesRow}>
          <View style={styles.cantidadItem}>
            <Text style={styles.cantidadLabel}>Solicitado</Text>
            <Text style={styles.cantidadValor}>{item.cantPedido}</Text>
          </View>

          <View style={styles.cantidadItem}>
            <Text style={styles.cantidadLabel}>Entregado</Text>
            {soloLectura ? (
              <Text style={styles.cantidadValor}>{cantAtencion}</Text>
            ) : (
              <View style={styles.cantidadStepper}>
                <TouchableOpacity
                  style={styles.stepperBtn}
                  onPress={() => ajustarCantidad(item.idProducto, -1)}
                  disabled={cantAtencion <= 0}
                >
                  <Icon name="remove" type="material" size={18} color={cantAtencion <= 0 ? COLORS.muted : "#fff"} />
                </TouchableOpacity>
                <TextInput
                  style={styles.cantidadInput}
                  value={cantAtencion.toString()}
                  onEndEditing={(e) => {
                    const num = parseFloat(e.nativeEvent.text) || 0;
                    const clamped = Math.max(0, Math.min(item.cantPedido, num));
                    actualizarCantidadLocal(item.idProducto, clamped);
                  }}
                  keyboardType="decimal-pad"
                />
                <TouchableOpacity
                  style={styles.stepperBtn}
                  onPress={() => ajustarCantidad(item.idProducto, 1)}
                  disabled={cantAtencion >= item.cantPedido}
                >
                  <Icon name="add" type="material" size={18} color={cantAtencion >= item.cantPedido ? COLORS.muted : "#fff"} />
                </TouchableOpacity>
              </View>
            )}
          </View>

          <View style={styles.cantidadItem}>
            <Text style={styles.cantidadLabel}>Diferencia</Text>
            <Text style={[styles.cantidadValor, tieneDiferencia && styles.diferenciaText]}>
              {item.cantPedido - cantAtencion}
            </Text>
          </View>
        </View>

        {!soloLectura && (
          <View style={styles.productoAcciones}>
            {!atendidoCompleto && (
              <TouchableOpacity style={styles.entregarTodoBtn} onPress={() => entregarTodoProducto(item.idProducto)}>
                <Icon name="check" type="material" size={14} color={COLORS.success} />
                <Text style={styles.entregarTodoBtnText}>Entregar todo</Text>
              </TouchableOpacity>
            )}
            {tieneDiferencia && (
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

        {item.causaDiferencia && item.obserDiferencia && (
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
              <Text style={styles.clienteNombre}>{pedido.clienteNombre}</Text>
              <Text style={styles.clienteId}>Cliente #{pedido.cliente}</Text>
            </View>
          </View>

          {pedido.clienteDomicilio && (
            <View style={styles.domicilioRow}>
              <Icon name="place" type="material" size={18} color={COLORS.muted} />
              <Text style={styles.domicilioText}>{pedido.clienteDomicilio}</Text>
            </View>
          )}

          {pedido.observaciones && (
            <View style={styles.observacionesCard}>
              <Icon name="notes" type="material" size={18} color={COLORS.warning} />
              <Text style={styles.observacionesText}>{pedido.observaciones}</Text>
            </View>
          )}
        </View>

        {!gpsValidado && !soloLectura && (
          <TouchableOpacity style={styles.gpsBtn} onPress={validarGPS} disabled={validandoGPS}>
            {validandoGPS ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Icon name="my-location" type="material" size={20} color="#fff" />
            )}
            <Text style={styles.gpsBtnText}>
              {validandoGPS ? "Validando ubicación..." : "Validar ubicación GPS"}
            </Text>
          </TouchableOpacity>
        )}

        {gpsValidado && (
          <View style={styles.gpsValidadoBadge}>
            <Icon name="check-circle" type="material" size={18} color={COLORS.success} />
            <Text style={styles.gpsValidadoText}>Ubicación validada</Text>
          </View>
        )}

        <View style={styles.resumenCard}>
          <Text style={styles.resumenTitle}>Resumen de Entrega</Text>
          <View style={styles.resumenRow}>
            <Text style={styles.resumenLabel}>Unidades solicitadas:</Text>
            <Text style={styles.resumenValor}>{resumen.totalSolicitado}</Text>
          </View>
          <View style={styles.resumenRow}>
            <Text style={styles.resumenLabel}>Unidades entregadas:</Text>
            <Text style={[styles.resumenValor, { color: COLORS.success }]}>{resumen.totalEntregado}</Text>
          </View>
          <View style={styles.resumenRow}>
            <Text style={styles.resumenLabel}>Productos con diferencia:</Text>
            <Text style={[styles.resumenValor, { color: resumen.conDiferencia > 0 ? COLORS.warning : COLORS.success }]}>
              {resumen.conDiferencia}
            </Text>
          </View>
          <View style={styles.resumenRow}>
            <Text style={styles.resumenLabel}>Total productos:</Text>
            <Text style={styles.resumenValor}>{detalles.length}</Text>
          </View>
          {!soloLectura && gpsValidado && resumen.totalEntregado < resumen.totalSolicitado && (
            <TouchableOpacity style={styles.entregarTodoPedidoBtn} onPress={entregarTodoPedido}>
              <Icon name="done-all" type="material" size={18} color="#fff" />
              <Text style={styles.entregarTodoPedidoBtnText}>Entregar todo el pedido</Text>
            </TouchableOpacity>
          )}
        </View>

        <Text style={styles.productosTitle}>Productos del Pedido</Text>

        <FlatList
          data={detalles}
          renderItem={renderProducto}
          keyExtractor={(item) => item.id}
          scrollEnabled={false}
          contentContainerStyle={styles.productosList}
        />
      </ScrollView>

      {!soloLectura && gpsValidado && (
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
                <Text style={styles.productoInfoCantidad}>
                  Solicitado: {productoSeleccionado.cantPedido} | Entregado: {productoSeleccionado.cantAtencion || 0}
                </Text>
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

            <Text style={styles.modalLabel}>Observaciones (opcional):</Text>
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

            <Text style={styles.modalLabel}>Observaciones (opcional):</Text>
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
  productosTitle: {
    ...TYPOGRAPHY.h3,
    fontSize: 16,
    marginHorizontal: SPACING.m,
    marginTop: SPACING.m,
    marginBottom: SPACING.s,
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
