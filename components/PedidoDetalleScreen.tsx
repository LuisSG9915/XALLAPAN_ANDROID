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
import PedidosService, { Pedido, ESTATUS_PEDIDO } from "../services/PedidosService";
import FullSyncService from "../services/FullSyncService";
import LocationService from "../services/LocationService";
import { COLORS, SPACING, BORDER_RADIUS, SHADOWS, TYPOGRAPHY } from "../theme/theme";

interface Props {
  navigation: any;
  route: any;
}

export default function PedidoDetalleScreen({ navigation, route }: Props) {
  const { folio, soloLectura } = route.params;

  const [pedido, setPedido] = useState<Pedido | null>(null);
  const [productos, setProductos] = useState<Pedido[]>([]);
  const [preciosPromo, setPreciosPromo] = useState<any[]>([]);
  const [preciosLista, setPreciosLista] = useState<any[]>([]);
  const [preciosDefault, setPreciosDefault] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [validandoGPS, setValidandoGPS] = useState(false);
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

      const pedidoData = pedidosService.getPedidoByFolio(folio);
      const productosData = pedidosService.getProductosByFolio(folio);
      const causasDif = pedidosService.getCausasDiferencia();
      const causasNoAt = pedidosService.getCausasNoAtencion();

      setPedido(pedidoData);
      setProductos(productosData);
      if (pedidoData) {
        const realm = (FullSyncService as any).realm;
        let clienteObj: any = realm
          ? realm.objectForPrimaryKey("ClienteFull", Number(pedidoData.cliente))
          : null;
        if (!clienteObj && realm) {
          const clientes = realm.objects("ClienteFull").filtered("id = $0", Number(pedidoData.cliente));
          if (clientes.length > 0) clienteObj = clientes[0];
        }

        const nombreCliente =
          clienteObj?.nombre ||
          pedidoData.clienteNombre ||
          `Cliente #${pedidoData.cliente}`;
        const domicilioCliente =
          clienteObj?.domicilio || pedidoData.clienteDomicilio || "Sin dirección";

        setClienteNombre(nombreCliente);
        setClienteDireccion(domicilioCliente);
        setObservaciones(
          pedidoData.observaciones ||
            (productosData as any[]).find((p: any) => p.observaciones)?.observaciones ||
            "",
        );
        setPreciosPromo(FullSyncService.getPreciosPromoByCliente(pedidoData.cliente));
        setPreciosLista(FullSyncService.getPreciosByListaPrecio(pedidoData.listaPrecio ?? 0));
      } else {
        setClienteNombre("");
        setClienteDireccion("");
        setObservaciones("");
        setPreciosPromo([]);
        setPreciosLista([]);
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

  const iniciarAtencion = () => {
    const pedidosService = PedidosService.getInstance();
    pedidosService.setRealm((FullSyncService as any).realm);
    const success = pedidosService.iniciarAtencionPedido(folio);
    if (success) {
      const pedidoActualizado = pedidosService.getPedidoByFolio(folio);
      if (pedidoActualizado) setPedido(pedidoActualizado);
    }
  };

  const validarGPS = async () => {
    if (!pedido) return;

    setValidandoGPS(true);
    try {
      const ubicacion = await LocationService.getBestLocation();
      if (ubicacion) {
        setGpsValidado(true);
        iniciarAtencion();
      } else {
        Alert.alert(
          "GPS no disponible",
          "No se pudo obtener tu ubicación. Puedes continuar la atención sin validar GPS.",
          [
            { text: "Cancelar", style: "cancel" },
            { text: "Continuar", onPress: () => iniciarAtencion() },
          ]
        );
      }
    } catch (error) {
      console.error("[PedidoDetalle] Error GPS:", error);
      Alert.alert(
        "GPS no disponible",
        "Ocurrió un error al validar la ubicación. Puedes continuar la atención sin validar GPS.",
        [
          { text: "Cancelar", style: "cancel" },
          { text: "Continuar", onPress: () => iniciarAtencion() },
        ]
      );
    } finally {
      setValidandoGPS(false);
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
        { text: "OK", onPress: () => navigation.goBack() },
      ]);
    } else {
      Alert.alert("Error", "No se pudo actualizar el pedido");
    }
  };

  const confirmarEntrega = () => {
    const productosConDiferencia = productos.filter((p) => {
      const cantAtencion = p.cantAtencion ?? 0;
      return cantAtencion !== p.cantPedido && !p.causaDiferencia;
    });

    if (productosConDiferencia.length > 0) {
      Alert.alert(
        "Productos sin causa",
        `Hay ${productosConDiferencia.length} producto(s) con diferencia sin causa registrada. Debe registrar la causa antes de confirmar.`,
      );
      return;
    }

    const todosEntregados = productos.every((p) => (p.cantAtencion ?? 0) === p.cantPedido);
    const hayEntregados = productos.some((p) => (p.cantAtencion ?? 0) > 0);
    const hayDiferenciasConCausa = productos.some((p) => {
      const cantAtencion = p.cantAtencion ?? 0;
      return cantAtencion !== p.cantPedido && p.causaDiferencia;
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
        onPress: () => {
          const pedidosService = PedidosService.getInstance();
          pedidosService.setRealm((FullSyncService as any).realm);

          const result = pedidosService.finalizarPedido(folio, nuevoEstatus);

          if (result.success) {
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
    const importeSolicitado = productos.reduce((sum, p) => sum + obtenerPrecioProducto(p.idProducto) * p.cantPedido, 0);
    const importeEntregado = productos.reduce((sum, p) => sum + obtenerPrecioProducto(p.idProducto) * (p.cantAtencion || 0), 0);

    return { totalSolicitado, totalEntregado, conDiferencia, importeSolicitado, importeEntregado };
  };

  const actualizarCantidadLocal = (idProducto: number, cantidad: number) => {
    const pedidosService = PedidosService.getInstance();
    pedidosService.setRealm((FullSyncService as any).realm);
    const success = pedidosService.actualizarCantAtencion(folio, idProducto, cantidad);
    if (success) {
      const productosActualizados = pedidosService.getProductosByFolio(folio);
      setProductos(productosActualizados);
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
    const cantAtencion = item.cantAtencion ?? 0;
    const tieneDiferencia = cantAtencion !== item.cantPedido;
    const atendidoCompleto = cantAtencion === item.cantPedido;
    const precioUnitario = obtenerPrecioProducto(item.idProducto);
    const subtotal = precioUnitario * cantAtencion;

    return (
      <View style={[styles.productoCard, tieneDiferencia && styles.productoCardDiferencia]}>
        <View style={styles.productoHeader}>
        
          <Text style={styles.productoNombre} numberOfLines={2}>
            {item.productoNombre || `Producto #${item.idProducto}`}
          </Text>
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
  const pedidoEnAtencion = pedido.estatus === ESTATUS_PEDIDO.EN_ATENCION;
  const puedeEditar = !soloLectura && (gpsValidado || pedidoEnAtencion);
  const puedeConfirmar = !soloLectura && (gpsValidado || pedidoEnAtencion);

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

        {!soloLectura && !gpsValidado && pedido.estatus !== ESTATUS_PEDIDO.EN_ATENCION && (
          <View style={styles.botonesRow}>
            <TouchableOpacity style={[styles.gpsBtn, styles.btnMitad]} onPress={validarGPS} disabled={validandoGPS}>
              {validandoGPS ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Icon name="my-location" type="material" size={20} color="#fff" />
              )}
              <Text style={styles.gpsBtnText}>
                {validandoGPS ? "Validando..." : "Validar GPS"}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.gpsBtn, styles.btnMitad, styles.iniciarBtn]}
              onPress={iniciarAtencion}
            >
              <Icon name="play-arrow" type="material" size={20} color="#fff" />
              <Text style={styles.gpsBtnText}>Iniciar atención</Text>
            </TouchableOpacity>
          </View>
        )}

        {gpsValidado && (
          <View style={styles.gpsValidadoBadge}>
            <Icon name="check-circle" type="material" size={18} color={COLORS.success} />
            <Text style={styles.gpsValidadoText}>Ubicación validada</Text>
          </View>
        )}


        <Text style={styles.productosTitle}>Productos del Pedido</Text>

        <FlatList
          data={productos}
          renderItem={renderProducto}
          keyExtractor={(item) => item.id}
          scrollEnabled={false}
          contentContainerStyle={styles.productosList}
        />
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
