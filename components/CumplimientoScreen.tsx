import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
  RefreshControl,
  ActivityIndicator,
  Modal,
  ScrollView,
} from "react-native";
import { Icon } from "react-native-elements";
import VisitaSyncService from "../services/VisitaSyncService";
import DetalleVisitasService from "../services/DetalleVisitasService";
import Realm from "realm";
import { ALL_SCHEMAS } from "../services/RealmSchemas";
import AuthService from "../services/AuthService";
import FullSyncService from "../services/FullSyncService"; // Agregada importación de FullSyncService

interface Visita {
  id: number;
  idCliente: number;
  ruta: string;
  l: boolean;
  m: boolean;
  mi: boolean;
  j: boolean;
  v: boolean;
  s: boolean;
  d: boolean;
  ordenL: number;
  ordenM: number;
  ordenMi: number;
  ordenJ: number;
  ordenV: number;
  ordenS: number;
  ordenD: number;
  visitado: boolean;
  fecha?: string | null;
}

interface VisitaConCliente extends Visita {
  nombreCliente?: string;
}

interface Estadisticas {
  totalProgramadas: number;
  totalRealizadas: number;
  porcentaje: number;
}

export default function CumplimientoScreen() {
  const [currentSucursal, setCurrentSucursal] = useState<number>(1);

  useEffect(() => {
    const init = async () => {
      const user = await AuthService.restoreSession();
      if (user) {
        const vendedor = (user.claveEmpleado as string | undefined) || (user.nombre as string | undefined) || "";
        const sucursal =
          (user.sucursal_origen as number | null | undefined) ?? (user.sucursal as number | null | undefined) ?? 1;
        setCurrentSucursal(sucursal);

        // Cargar datos después de establecer la sucursal
        cargarDatos(sucursal);
      }
    };

    init();
  }, []);

  const [visitas, setVisitas] = useState<VisitaConCliente[]>([]);
  const [estadisticas, setEstadisticas] = useState<Estadisticas>({
    totalProgramadas: 0,
    totalRealizadas: 0,
    porcentaje: 0,
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [visitaSeleccionada, setVisitaSeleccionada] = useState<VisitaConCliente | null>(null);
  const [tipoVisitaSeleccionado, setTipoVisitaSeleccionado] = useState<number | null>(null);

  // Obtener tipos de visita desde la base de datos
  const getTipoVisitas = () => {
    if (!FullSyncService.isServiceInitialized()) return [];
    const tipos = FullSyncService.getTipoVisitas();
    console.log(tipos);
    return Array.isArray(tipos) ? tipos : [];
  };

  const tiposVisita = getTipoVisitas();

  const obtenerNombreCliente = async (idCliente: number) => {
    const cliente = FullSyncService.getClienteFullById(idCliente);
    if (cliente) {
      return cliente.nombre;
    } else {
      const clientes = FullSyncService.getClientesFull();
      const clienteEncontrado = clientes.find((c) => c.id === idCliente);
      return clienteEncontrado ? clienteEncontrado.nombre : "Cliente no encontrado";
    }
  };

  const cargarDatos = useCallback((sucursal: number) => {
    setLoading(true);
    Promise.all([
      VisitaSyncService.getInstance().getVisitasDelDia(sucursal),
      VisitaSyncService.getInstance().getEstadisticasCumplimiento(sucursal),
    ])
      .then(([visitasDelDia, stats]) => {
        // Obtener nombres de clientes
        Promise.all(
          visitasDelDia.map((visita) => {
            return obtenerNombreCliente(visita.idCliente).then((nombreCliente) => ({
              ...visita,
              nombreCliente,
            }));
          })
        ).then((visitasConNombres) => {
          setVisitas(visitasConNombres);
          setEstadisticas(stats);
        });
      })
      .catch((error) => {
        console.error("Error al cargar datos:", error);
        Alert.alert("Error", "No se pudieron cargar las visitas");
      })
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
  }, []);

  const handleMarcarVisitado = async (idVisita: number) => {
    const visita = visitas.find((v) => v.id === idVisita);
    if (!visita) {
      Alert.alert("Error", "Visita no encontrada");
      return;
    }

    if (visita.visitado) {
      Alert.alert("Información", "Esta visita ya fue marcada como realizada");
      return;
    }

    // Abrir modal para seleccionar tipo de visita
    setVisitaSeleccionada(visita);
    setTipoVisitaSeleccionado(null);
    setModalVisible(true);
  };

  const confirmarMarcarVisitado = async () => {
    if (!visitaSeleccionada || tipoVisitaSeleccionado === null) {
      Alert.alert("Error", "Debe seleccionar un tipo de visita");
      return;
    }

    setModalVisible(false);

    const exito = await VisitaSyncService.getInstance().marcarVisitado(visitaSeleccionada.id, tipoVisitaSeleccionado);

    if (exito) {
      // Registrar visita completa en DetalleVisitas (fechaInicio = fechaFin)
      try {
        const user = await AuthService.restoreSession();
        const sucursal = user?.sucursal_origen || user?.sucursal || 0;
        await DetalleVisitasService.getInstance().registrarVisitaCompleta(
          visitaSeleccionada.idCliente,
          user?.id || 0,
          sucursal,
          tipoVisitaSeleccionado
        );
        console.log(
          `[Cumplimiento] Visita registrada en DetalleVisitas para cliente ${visitaSeleccionada.idCliente} con tipo ${tipoVisitaSeleccionado}`
        );
      } catch (error) {
        console.error("[Cumplimiento] Error al registrar en DetalleVisitas:", error);
      }

      Alert.alert("Éxito", "Visita marcada como realizada");
      cargarDatos(currentSucursal);
    } else {
      Alert.alert("Error", "No se pudo marcar la visita");
    }
  };

  const obtenerNombreDia = () => {
    const dias = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
    return dias[new Date().getDay()];
  };

  const obtenerRangoHorario = (visita: Visita) => {
    // Simular rango horario basado en el orden
    const horaInicio =
      8 +
      (visita.ordenL ||
        visita.ordenM ||
        visita.ordenMi ||
        visita.ordenJ ||
        visita.ordenV ||
        visita.ordenS ||
        visita.ordenD) *
        0.5;
    const horaFin = horaInicio + 0.05; // 3 minutos

    const formatoHora = (hora: number) => {
      const h = Math.floor(hora);
      const m = Math.round((hora - h) * 60);
      return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
    };

    return `${formatoHora(horaInicio)} - ${formatoHora(horaFin)} `;
  };

  const renderVisita = ({ item, index }: { item: VisitaConCliente; index: number }) => (
    <View style={styles.visitaContainer}>
      <View style={styles.timelineLine} />
      <View style={[styles.timelineDot, item.visitado ? styles.timelineDotVisited : styles.timelineDotPending]} />
      <View style={styles.visitaContent}>
        <View style={styles.visitaHeader}>
          <View style={styles.visitaInfo}>
            <Text style={styles.visitaTitulo}>Visita programada</Text>
            <Text style={styles.clienteTexto}>
              {item.idCliente} - {item.nombreCliente || "Cargando..."}
            </Text>
            <Text style={styles.horaTexto}>{obtenerRangoHorario(item)}</Text>
          </View>
          <TouchableOpacity
            style={[styles.botonVisitado, item.visitado ? styles.botonVisitadoActivo : styles.botonVisitadoInactivo]}
            onPress={() => handleMarcarVisitado(item.id)}
            disabled={item.visitado}
          >
            <Text
              style={[
                styles.botonVisitadoTexto,
                item.visitado ? styles.botonVisitadoTextoActivo : styles.botonVisitadoTextoInactivo,
              ]}
            >
              {item.visitado ? "Visitado" : "Visitar"}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingTexto}>Cargando visitas...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.titulo}>Cumplimiento de agenda</Text>
        <Text style={styles.porcentaje}>{estadisticas.porcentaje.toFixed(1)}%</Text>
        <Text style={styles.subtitulo}>
          {estadisticas.totalRealizadas} visitas realizadas de {estadisticas.totalProgramadas} programadas
        </Text>
        <Text style={styles.diaTexto}>{obtenerNombreDia()}</Text>
      </View>

      <FlatList
        data={visitas}
        renderItem={renderVisita}
        keyExtractor={(item) => item.id.toString()}
        contentContainerStyle={styles.lista}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              cargarDatos(currentSucursal);
            }}
          />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Icon name="event" type="material" size={64} color="#C7C7CC" />
            <Text style={styles.emptyTexto}>No hay visitas programadas para hoy</Text>
          </View>
        }
      />

      {/* Modal de selección de tipo de visita */}
      <Modal visible={modalVisible} animationType="slide" transparent>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Seleccionar Tipo de Visita</Text>
            <Text style={styles.modalSubtitle}>
              Cliente: {visitaSeleccionada?.nombreCliente || visitaSeleccionada?.idCliente}
            </Text>

            <ScrollView style={styles.tiposContainer}>
              {tiposVisita
                .filter((tipo) => tipo.id !== 1)
                .map((tipo) => (
                  <TouchableOpacity
                    key={tipo.id}
                    style={[styles.tipoOption, tipoVisitaSeleccionado === tipo.id && styles.tipoOptionSelected]}
                    onPress={() => setTipoVisitaSeleccionado(tipo.id)}
                  >
                    <Text style={[styles.tipoText, tipoVisitaSeleccionado === tipo.id && styles.tipoTextSelected]}>
                      {tipo.descripcion}
                    </Text>
                    {tipoVisitaSeleccionado === tipo.id && (
                      <Icon name="check-circle" type="material" size={24} color="#007AFF" />
                    )}
                  </TouchableOpacity>
                ))}
            </ScrollView>

            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonCancel]}
                onPress={() => setModalVisible(false)}
              >
                <Text style={styles.modalButtonTextCancel}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonConfirm]}
                onPress={confirmarMarcarVisitado}
              >
                <Text style={styles.modalButtonText}>Confirmar</Text>
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
    backgroundColor: "#F2F2F7",
  },
  loadingTexto: {
    marginTop: 16,
    fontSize: 16,
    color: "#8E8E93",
  },
  header: {
    backgroundColor: "#007AFF",
    paddingTop: 60,
    paddingBottom: 24,
    paddingHorizontal: 20,
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 20,
  },
  titulo: {
    fontSize: 24,
    fontWeight: "bold",
    color: "white",
    marginBottom: 8,
  },
  porcentaje: {
    fontSize: 36,
    fontWeight: "bold",
    color: "white",
    marginBottom: 4,
  },
  subtitulo: {
    fontSize: 16,
    color: "white",
    opacity: 0.9,
    marginBottom: 4,
  },
  diaTexto: {
    fontSize: 14,
    color: "white",
    opacity: 0.8,
  },
  lista: {
    padding: 20,
  },
  visitaContainer: {
    flexDirection: "row",
    marginBottom: 20,
    position: "relative",
  },
  timelineLine: {
    position: "absolute",
    left: 15,
    top: 30,
    bottom: -20,
    width: 2,
    backgroundColor: "#E5E5EA",
  },
  timelineDot: {
    width: 30,
    height: 30,
    borderRadius: 15,
    marginRight: 16,
    marginTop: 5,
    zIndex: 1,
  },
  timelineDotPending: {
    backgroundColor: "#007AFF",
  },
  timelineDotVisited: {
    backgroundColor: "#34C759",
  },
  visitaContent: {
    flex: 1,
    backgroundColor: "white",
    borderRadius: 12,
    padding: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  visitaHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  visitaInfo: {
    flex: 1,
  },
  visitaTitulo: {
    fontSize: 14,
    fontWeight: "600",
    color: "#8E8E93",
    marginBottom: 4,
  },
  clienteTexto: {
    fontSize: 16,
    fontWeight: "bold",
    color: "#000",
    marginBottom: 4,
  },
  horaTexto: {
    fontSize: 14,
    color: "#8E8E93",
  },
  botonVisitado: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    minWidth: 80,
    alignItems: "center",
  },
  botonVisitadoInactivo: {
    backgroundColor: "#007AFF",
  },
  botonVisitadoActivo: {
    backgroundColor: "#34C759",
  },
  botonVisitadoTexto: {
    fontSize: 14,
    fontWeight: "600",
  },
  botonVisitadoTextoInactivo: {
    color: "white",
  },
  botonVisitadoTextoActivo: {
    color: "white",
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingTop: 100,
  },
  emptyTexto: {
    fontSize: 16,
    color: "#8E8E93",
    marginTop: 16,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "center",
    alignItems: "center",
  },
  modalCard: {
    backgroundColor: "white",
    borderRadius: 16,
    padding: 24,
    width: "85%",
    maxHeight: "70%",
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#000",
    marginBottom: 8,
  },
  modalSubtitle: {
    fontSize: 14,
    color: "#8E8E93",
    marginBottom: 20,
  },
  tiposContainer: {
    maxHeight: 300,
  },
  tipoOption: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    borderRadius: 12,
    backgroundColor: "#F2F2F7",
    marginBottom: 12,
  },
  tipoOptionSelected: {
    backgroundColor: "#E3F2FD",
    borderWidth: 2,
    borderColor: "#007AFF",
  },
  tipoText: {
    fontSize: 16,
    color: "#000",
    fontWeight: "500",
  },
  tipoTextSelected: {
    color: "#007AFF",
    fontWeight: "600",
  },
  modalButtons: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 20,
    gap: 12,
  },
  modalButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  modalButtonCancel: {
    backgroundColor: "#F2F2F7",
  },
  modalButtonConfirm: {
    backgroundColor: "#007AFF",
  },
  modalButtonText: {
    fontSize: 16,
    fontWeight: "600",
    color: "white",
  },
  modalButtonTextCancel: {
    fontSize: 16,
    fontWeight: "600",
    color: "#000",
  },
});
