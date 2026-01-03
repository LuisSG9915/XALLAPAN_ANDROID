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
      <View style={styles.visitaCard}>
        <View style={styles.visitaHeader}>
          <View style={styles.visitaInfo}>
            <View style={styles.clienteRow}>
              <View style={styles.clienteIcon}>
                <Icon
                  name={item.visitado ? "check-circle" : "radio-button-unchecked"}
                  type="material"
                  size={24}
                  color={item.visitado ? "#34C759" : "#007AFF"}
                />
              </View>
              <View style={styles.clienteDetails}>
                <Text style={styles.clienteId}>#{item.idCliente}</Text>
                <Text style={styles.clienteNombre}>{item.nombreCliente || "Cargando..."}</Text>
              </View>
            </View>
            <View style={styles.horaRow}>
              <Icon name="schedule" type="material" size={16} color="#8E8E93" />
              <Text style={styles.horaTexto}>{obtenerRangoHorario(item)}</Text>
            </View>
          </View>
          <TouchableOpacity
            style={[styles.botonVisitado, item.visitado ? styles.botonVisitadoActivo : styles.botonVisitadoInactivo]}
            onPress={() => handleMarcarVisitado(item.id)}
            disabled={item.visitado}
            activeOpacity={0.8}
          >
            <Icon name={item.visitado ? "check" : "directions-walk"} type="material" size={20} color="white" />
            <Text
              style={[
                styles.botonVisitadoTexto,
                item.visitado ? styles.botonVisitadoTextoActivo : styles.botonVisitadoTextoInactivo,
              ]}
            >
              {item.visitado ? "Completado" : "Visitar"}
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
      <Modal visible={modalVisible} animationType="fade" transparent>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Icon name="assignment" type="material" size={28} color="#007AFF" />
              <Text style={styles.modalTitle}>Tipo de Visita</Text>
            </View>
            <View style={styles.modalContent}>
              <View style={styles.clienteInfoModal}>
                <Icon name="person" type="material" size={20} color="#8E8E93" />
                <Text style={styles.modalSubtitle}>
                  {visitaSeleccionada?.nombreCliente || `Cliente #${visitaSeleccionada?.idCliente}`}
                </Text>
              </View>

              <ScrollView style={styles.tiposContainer} showsVerticalScrollIndicator={false}>
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
                        style={[styles.tipoOption, tipoVisitaSeleccionado === tipo.id && styles.tipoOptionSelected]}
                        onPress={() => setTipoVisitaSeleccionado(tipo.id)}
                        activeOpacity={0.7}
                      >
                        <View style={styles.tipoOptionContent}>
                          <Icon
                            name={icons[tipo.id] || "label"}
                            type="material"
                            size={24}
                            color={tipoVisitaSeleccionado === tipo.id ? "#007AFF" : "#8E8E93"}
                          />
                          <Text
                            style={[styles.tipoText, tipoVisitaSeleccionado === tipo.id && styles.tipoTextSelected]}
                          >
                            {tipo.descripcion}
                          </Text>
                        </View>
                        {tipoVisitaSeleccionado === tipo.id && (
                          <View style={styles.checkCircle}>
                            <Icon name="check" type="material" size={20} color="white" />
                          </View>
                        )}
                      </TouchableOpacity>
                    );
                  })}
              </ScrollView>

              <View style={styles.modalButtons}>
                <TouchableOpacity
                  style={[styles.modalButton, styles.modalButtonCancel]}
                  onPress={() => setModalVisible(false)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.modalButtonTextCancel}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.modalButton,
                    styles.modalButtonConfirm,
                    tipoVisitaSeleccionado === null && styles.modalButtonDisabled,
                  ]}
                  onPress={confirmarMarcarVisitado}
                  disabled={tipoVisitaSeleccionado === null}
                  activeOpacity={0.8}
                >
                  <Icon name="check" type="material" size={20} color="white" />
                  <Text style={styles.modalButtonText}>Confirmar</Text>
                </TouchableOpacity>
              </View>
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
  statsContainer: {
    flexDirection: "row",
    justifyContent: "space-around",
    backgroundColor: "white",
    marginHorizontal: 24,
    paddingVertical: 20,
    borderRadius: 16,
    marginTop: -30,
    elevation: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
  },
  statItem: {
    alignItems: "center",
  },
  statValor: {
    fontSize: 24,
    fontWeight: "bold",
    color: "#007AFF",
  },
  statLabel: {
    fontSize: 13,
    color: "#8E8E93",
    marginTop: 4,
    fontWeight: "500",
  },
  lista: {
    paddingHorizontal: 24,
    paddingTop: 24,
  },
  listaContainer: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 24,
  },
  visitaContainer: {
    marginBottom: 16,
  },
  visitaCard: {
    backgroundColor: "white",
    borderRadius: 16,
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    overflow: "hidden",
  },
  visitaHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 20,
  },
  visitaInfo: {
    flex: 1,
  },
  clienteRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
  },
  clienteIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#F0F0F0",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  clienteDetails: {
    flex: 1,
  },
  clienteId: {
    fontSize: 12,
    color: "#007AFF",
    fontWeight: "600",
    marginBottom: 2,
  },
  clienteNombre: {
    fontSize: 16,
    fontWeight: "600",
    color: "#1C1C1E",
  },
  horaRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 8,
  },
  horaTexto: {
    fontSize: 14,
    color: "#8E8E93",
    marginLeft: 6,
    fontWeight: "500",
  },
  botonVisitado: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 25,
    minWidth: 100,
    justifyContent: "center",
  },
  botonVisitadoActivo: {
    backgroundColor: "#34C759",
  },
  botonVisitadoInactivo: {
    backgroundColor: "#007AFF",
  },
  botonVisitadoTexto: {
    color: "white",
    fontWeight: "600",
    marginLeft: 6,
    fontSize: 14,
  },
  botonVisitadoTextoActivo: {
    color: "white",
  },
  botonVisitadoTextoInactivo: {
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
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    justifyContent: "center",
    alignItems: "center",
  },
  modalCard: {
    backgroundColor: "white",
    borderRadius: 24,
    width: "90%",
    maxWidth: 400,
    maxHeight: "80%",
    elevation: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    overflow: "hidden",
  },
  modalHeader: {
    paddingVertical: 20,
    paddingHorizontal: 24,
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: "#F0F0F0",
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#1C1C1E",
    marginTop: 8,
  },
  modalContent: {
    paddingHorizontal: 24,
    paddingBottom: 24,
  },
  clienteInfoModal: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#F8F9FA",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    marginBottom: 20,
  },
  modalSubtitle: {
    fontSize: 16,
    color: "#495057",
    marginLeft: 8,
    fontWeight: "500",
  },
  tiposContainer: {
    maxHeight: 300,
  },
  tipoOption: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: 12,
    marginBottom: 8,
    backgroundColor: "#F8F9FA",
    borderWidth: 2,
    borderColor: "transparent",
  },
  tipoOptionSelected: {
    backgroundColor: "#E3F2FD",
    borderColor: "#007AFF",
  },
  tipoOptionContent: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
  },
  tipoText: {
    fontSize: 16,
    color: "#212529",
    marginLeft: 12,
    fontWeight: "500",
  },
  tipoTextSelected: {
    color: "#007AFF",
    fontWeight: "600",
  },
  checkCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#007AFF",
    justifyContent: "center",
    alignItems: "center",
  },
  modalButtons: {
    flexDirection: "row",
    marginTop: 20,
    gap: 12,
  },
  modalButton: {
    flex: 1,
    height: 50,
    borderRadius: 25,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  modalButtonCancel: {
    backgroundColor: "#F8F9FA",
    borderWidth: 2,
    borderColor: "#DEE2E6",
  },
  modalButtonConfirm: {
    backgroundColor: "#007AFF",
  },
  modalButtonDisabled: {
    backgroundColor: "#E9ECEF",
  },
  modalButtonText: {
    color: "white",
    fontSize: 16,
    fontWeight: "600",
    marginLeft: 6,
  },
  modalButtonTextCancel: {
    color: "#6C757D",
    fontSize: 16,
    fontWeight: "600",
  },
});
