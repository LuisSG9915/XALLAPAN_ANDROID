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
import LocationService, { LocationCoordinates } from "../services/LocationService";

interface Visita {
  id: number;
  idCliente: number;
  ruta: string;
  fecha: Date;
  orden: number;
  tipo: number;
  visitado: number;
}

interface VisitaConCliente extends Visita {
  nombreCliente?: string;
  latitud?: number;
  longitud?: number;
  metros?: number; // Distancia máxima permitida en metros
}

interface Estadisticas {
  totalProgramadas: number;
  totalRealizadas: number;
  porcentaje: number;
}

export default function CumplimientoScreen({ navigation }: { navigation: any }) {
  const [currentSucursal, setCurrentSucursal] = useState<number>(1);
  const [fechaSeleccionada, setFechaSeleccionada] = useState<Date>(new Date());

  useEffect(() => {
    const init = async () => {
      const user = await AuthService.restoreSession();
      if (user) {
        const vendedor =
          (user.claveEmpleado as string | undefined) ||
          (user.nombre as string | undefined) ||
          "";
        const sucursal =
          (user.sucursal_origen as number | null | undefined) ??
          (user.sucursal as number | null | undefined) ??
          1;

        // Intentar obtener metros desde Realm (tabla de usuarios)
        try {
          if (!FullSyncService.isServiceInitialized()) {
            await FullSyncService.initialize();
          }
          // Asumiendo que user.id existe en la sesión
          if (user.id) {
            const realmUser = FullSyncService.getUsuarioById(user.id);
            if (realmUser && realmUser.metros) {
              console.log(
                "[Cumplimiento] Metros usuario obtenidos de Realm:",
                realmUser.metros,
              );
              setUserMetros(realmUser.metros);
            } else if (user.metros) {
              console.log(
                "[Cumplimiento] Metros usuario obtenidos de Sesión:",
                user.metros,
              );
              setUserMetros(user.metros);
            }
          }
        } catch (error) {
          console.error("[Cumplimiento] Error al obtener usuario de Realm:", error);
          if (user.metros) {
            setUserMetros(user.metros);
          }
        }

        setCurrentSucursal(sucursal);

        // Sincronizar visitas desde el servidor antes de cargar (mismo método que pull-to-refresh)
        try {
          console.log("[Cumplimiento] 🔄 Sincronizando visitas al montar...");
          await VisitaSyncService.getInstance().syncByDate(new Date());
          console.log("[Cumplimiento] ✅ Visitas sincronizadas al montar");
        } catch (error) {
          console.error("[Cumplimiento] ⚠️ Error al sincronizar visitas:", error);
        }

        // Cargar datos después de sincronizar
        cargarDatos(new Date(), sucursal);
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
  const [visitaSeleccionada, setVisitaSeleccionada] = useState<VisitaConCliente | null>(
    null,
  );
  const [tipoVisitaSeleccionado, setTipoVisitaSeleccionado] = useState<number | null>(
    null,
  );
  const [validandoUbicacion, setValidandoUbicacion] = useState(false);
  const [userMetros, setUserMetros] = useState<number | null>(null);

  // Obtener tipos de visita desde la base de datos
  const getTipoVisitas = () => {
    if (!FullSyncService.isServiceInitialized()) return [];
    const tipos = FullSyncService.getTipoVisitas();
    console.log(tipos);
    return Array.isArray(tipos) ? tipos : [];
  };

  const tiposVisita = getTipoVisitas();

  const calcularDistancia = (
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number => {
    const R = 6371e3;
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  };

  const obtenerNombreCliente = async (idCliente: number) => {
    const cliente = FullSyncService.getClienteFullById(idCliente);
    if (cliente) {
      return {
        nombre: cliente.nombre,
        latitud: cliente.latitud,
        longitud: cliente.longitud,
        metros: cliente.metros,
      };
    } else {
      const clientes = FullSyncService.getClientesFull();
      const clienteEncontrado = clientes.find((c) => c.id === idCliente);
      return {
        nombre: clienteEncontrado ? clienteEncontrado.nombre : "Cliente no encontrado",
        latitud: clienteEncontrado?.latitud,
        longitud: clienteEncontrado?.longitud,
        metros: clienteEncontrado?.metros,
      };
    }
  };

  const cargarDatos = useCallback((fecha: Date, sucursal: number) => {
    setLoading(true);
    Promise.all([
      VisitaSyncService.getInstance().getVisitasByFecha(fecha, sucursal),
      VisitaSyncService.getInstance().getEstadisticasCumplimiento(fecha, sucursal),
    ])
      .then(([visitasDelDia, stats]) => {
        console.log("[Cumplimiento] 📋 Visitas del día:", visitasDelDia);
        console.log("[Cumplimiento] 📊 Estadísticas:", stats);
        // Obtener nombres de clientes
        Promise.all(
          visitasDelDia.map((visita: any) => {
            return obtenerNombreCliente(visita.idCliente).then((datosCliente) => ({
              ...visita,
              nombreCliente: datosCliente.nombre,
              latitud: datosCliente.latitud,
              longitud: datosCliente.longitud,
              metros: datosCliente.metros,
            }));
          }),
        ).then((visitasConNombres) => {
          console.log("[Cumplimiento] 📋 Visitas cargadas:", visitasConNombres);
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

  // Recargar visitas cuando la pantalla recibe foco (al regresar de SalesScreen)
  useFocusEffect(
    useCallback(() => {
      if (currentSucursal > 0) {
        console.log("[Cumplimiento] 🔄 Pantalla recibió foco, recargando visitas...");
        cargarDatos(fechaSeleccionada, currentSucursal);
      }
    }, [fechaSeleccionada, currentSucursal, cargarDatos]),
  );

  const handleMarcarVisitado = async (idVisita: number) => {
    const visita = visitas.find((v) => v.id === idVisita);

    console.log("[Cumplimiento] 🔍 Datos de la visita a marcar:", {
      idVisita,
      visitaEncontrada: visita,
      fechaSeleccionada: fechaSeleccionada.toISOString(),
      todasLasVisitas: visitas.map((v) => ({
        id: v.id,
        idCliente: v.idCliente,
        fecha: v.fecha,
        visitado: v.visitado,
      })),
    });

    if (!visita) {
      Alert.alert("Error", "Visita no encontrada");
      return;
    }

    if (visita.visitado === 1) {
      Alert.alert("Información", "Esta visita ya fue marcada como realizada");
      return;
    }

    console.log("[Cumplimiento] Iniciando validación de ubicación...");

    // Verificar ubicación del vendedor
    if (visita.latitud && visita.longitud) {
      try {
        console.log("[Cumplimiento] Seteando validandoUbicacion = true");
        setValidandoUbicacion(true);
        console.log("[Cumplimiento] 📍 Obteniendo ubicación del vendedor...");
        const ubicacionVendedor = await LocationService.getCurrentLocation();

        if (ubicacionVendedor) {
          console.log("[Cumplimiento] Ubicación obtenida:", ubicacionVendedor);
          const distancia = calcularDistancia(
            ubicacionVendedor.latitude,
            ubicacionVendedor.longitude,
            visita.latitud,
            visita.longitud,
          );
          console.log(
            "[Cumplimiento] Distancia calculada:",
            Math.round(distancia),
            "metros",
          );

          const metrosPermitidos = userMetros || visita.metros || 100; // Prioridad: Usuario > Cliente > Default (100)
          if (distancia > metrosPermitidos) {
            console.log("[Cumplimiento] Distancia excede el límite permitido");
            Alert.alert(
              "Ubicación inválida",
              `Estás a ${Math.round(
                distancia,
              )} metros del cliente. La distancia máxima permitida es de ${metrosPermitidos} metros.`,
            );
            setValidandoUbicacion(false);
            return;
          }

          console.log(
            "[Cumplimiento] Validación exitosa, seteando validandoUbicacion = false",
          );
          setValidandoUbicacion(false);
        } else {
          setValidandoUbicacion(false);
          Alert.alert(
            "Ubicación no disponible",
            "No se pudo obtener tu ubicación. Verifica que el GPS esté activado.",
          );
          return;
        }
      } catch (locationError) {
        setValidandoUbicacion(false);
        console.error("[Cumplimiento] ⚠️ Error al obtener ubicación:", locationError);
        Alert.alert(
          "Error de ubicación",
          "No se pudo verificar tu ubicación. Verifica que el GPS esté activado.",
        );
        return;
      }
    } else {
      Alert.alert(
        "Cliente sin ubicación",
        "El cliente no tiene registrada su ubicación geográfica.",
      );
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

    console.log("[Cumplimiento] 📤 Llamando a marcarVisitado con:", {
      id: visitaSeleccionada.id,
      tipoVisita: tipoVisitaSeleccionado,
      fechaSeleccionada: fechaSeleccionada.toISOString(),
    });

    const exito = await VisitaSyncService.getInstance().marcarVisitado(
      visitaSeleccionada.id,
      tipoVisitaSeleccionado,
      fechaSeleccionada,
    );

    if (exito) {
      // Registrar visita completa en DetalleVisitas (fechaInicio = fechaFin)
      try {
        const user = await AuthService.restoreSession();
        const sucursal = user?.sucursal_origen || user?.sucursal || 0;
        await DetalleVisitasService.getInstance().registrarVisitaCompleta(
          visitaSeleccionada.idCliente,
          user?.id || 0,
          sucursal,
          tipoVisitaSeleccionado,
        );
        console.log(
          `[Cumplimiento] Visita registrada en DetalleVisitas para cliente ${visitaSeleccionada.idCliente} con tipo ${tipoVisitaSeleccionado}`,
        );
      } catch (error) {
        console.error("[Cumplimiento] Error al registrar en DetalleVisitas:", error);
      }

      // Actualizar estado local inmediatamente - buscar por idCliente y fecha de hoy
      setVisitas((prevVisitas) =>
        prevVisitas.map((v) => {
          // Comparar por idCliente y verificar que la fecha sea la misma que la seleccionada
          const visitaFecha = new Date(v.fecha);
          const fechaHoy = new Date(fechaSeleccionada);
          visitaFecha.setHours(0, 0, 0, 0);
          fechaHoy.setHours(0, 0, 0, 0);

          if (
            v.idCliente === visitaSeleccionada.idCliente &&
            visitaFecha.getTime() === fechaHoy.getTime()
          ) {
            console.log(
              `[Cumplimiento] ✅ Actualizando visita local: Cliente ${
                v.idCliente
              }, Fecha ${visitaFecha.toISOString().split("T")[0]}`,
            );
            return { ...v, visitado: 1, tipo: tipoVisitaSeleccionado };
          }
          return v;
        }),
      );

      // Actualizar estadísticas localmente
      setEstadisticas((prevStats) => ({
        ...prevStats,
        totalRealizadas: prevStats.totalRealizadas + 1,
        porcentaje:
          prevStats.totalProgramadas > 0
            ? ((prevStats.totalRealizadas + 1) / prevStats.totalProgramadas) * 100
            : 0,
      }));

      Alert.alert("Éxito", "Visita marcada como realizada");
    } else {
      Alert.alert("Error", "No se pudo marcar la visita");
    }
  };

  const obtenerNombreDia = (fecha: Date) => {
    const dias = [
      "Domingo",
      "Lunes",
      "Martes",
      "Miércoles",
      "Jueves",
      "Viernes",
      "Sábado",
    ];
    return dias[fecha.getDay()];
  };

  const formatearFecha = (fecha: Date) => {
    const opciones: Intl.DateTimeFormatOptions = {
      day: "2-digit",
      month: "long",
      year: "numeric",
    };
    return fecha.toLocaleDateString("es-MX", opciones);
  };

  const cambiarDia = (dias: number) => {
    const nuevaFecha = new Date(fechaSeleccionada);
    nuevaFecha.setDate(nuevaFecha.getDate() + dias);
    setFechaSeleccionada(nuevaFecha);
    cargarDatos(nuevaFecha, currentSucursal);
  };

  const sincronizarFecha = async () => {
    setRefreshing(true);
    await VisitaSyncService.getInstance().syncByDate(fechaSeleccionada);
    cargarDatos(fechaSeleccionada, currentSucursal);
  };

  const obtenerRangoHorario = (visita: Visita) => {
    const horaInicio = 8 + visita.orden * 0.5;
    const horaFin = horaInicio + 0.05;

    const formatoHora = (hora: number) => {
      const h = Math.floor(hora);
      const m = Math.round((hora - h) * 60);
      return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
    };

    return `${formatoHora(horaInicio)} - ${formatoHora(horaFin)}`;
  };

  const handleIrAVentas = (visita: VisitaConCliente) => {
    navigation.navigate("Sales", {
      clienteId: visita.idCliente,
      nombreCliente: visita.nombreCliente,
      desdeVisita: true,
    });
  };

  const renderVisita = ({ item, index }: { item: VisitaConCliente; index: number }) => (
    <View style={styles.visitaContainer}>
      <View style={styles.visitaCard}>
        <View style={styles.visitaHeader}>
          <View style={styles.visitaInfo}>
            <View style={styles.clienteRow}>
              <View style={styles.clienteIcon}>
                <Icon
                  name={item.visitado === 1 ? "check-circle" : "radio-button-unchecked"}
                  type="material"
                  size={20}
                  color={item.visitado === 1 ? "#34C759" : "#007AFF"}
                />
              </View>
              <View style={styles.clienteDetails}>
                <Text style={styles.clienteId}>#{item.idCliente}</Text>
                <Text style={styles.clienteNombre}>
                  {item.nombreCliente || "Cargando..."}
                </Text>
              </View>
            </View>
            <View style={styles.horaRow}>
              <Icon name="schedule" type="material" size={14} color="#8E8E93" />
              <Text style={styles.horaTexto}>{obtenerRangoHorario(item)}</Text>
            </View>
          </View>
          <View style={styles.botonesContainer}>
            {item.visitado === 0 && (
              <TouchableOpacity
                style={styles.botonVentas}
                onPress={() => handleIrAVentas(item)}
                activeOpacity={0.8}
              >
                <Icon name="shopping-cart" type="material" size={16} color="white" />
                <Text style={styles.botonVentasTexto}>Ventas</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[
                styles.botonVisitado,
                item.visitado === 1
                  ? styles.botonVisitadoActivo
                  : styles.botonVisitadoInactivo,
                validandoUbicacion && styles.botonVisitadoDisabled,
              ]}
              onPress={() => handleMarcarVisitado(item.id)}
              disabled={item.visitado === 1 || validandoUbicacion}
              activeOpacity={0.8}
            >
              {validandoUbicacion ? (
                <>
                  <ActivityIndicator size="small" color="white" />
                  <Text style={styles.botonVisitadoTexto}>Validando...</Text>
                </>
              ) : (
                <>
                  <Icon
                    name={item.visitado === 1 ? "check" : "directions-walk"}
                    type="material"
                    size={16}
                    color="white"
                  />
                  <Text
                    style={[
                      styles.botonVisitadoTexto,
                      item.visitado === 1
                        ? styles.botonVisitadoTextoActivo
                        : styles.botonVisitadoTextoInactivo,
                    ]}
                  >
                    {item.visitado === 1 ? "Completado" : "Visitar"}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </View>
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

        <View style={styles.navegacionFechas}>
          <TouchableOpacity
            style={styles.botonFlecha}
            onPress={() => cambiarDia(-1)}
            activeOpacity={0.7}
          >
            <Icon name="chevron-left" type="material" size={24} color="white" />
          </TouchableOpacity>

          <View style={styles.fechaContainer}>
            <Text style={styles.fechaTexto}>{formatearFecha(fechaSeleccionada)}</Text>
            <Text style={styles.diaTexto}>{obtenerNombreDia(fechaSeleccionada)}</Text>
          </View>

          <TouchableOpacity
            style={styles.botonFlecha}
            onPress={() => cambiarDia(1)}
            activeOpacity={0.7}
          >
            <Icon name="chevron-right" type="material" size={24} color="white" />
          </TouchableOpacity>
        </View>

        <Text style={styles.porcentaje}>{estadisticas.porcentaje.toFixed(1)}%</Text>
        <Text style={styles.subtitulo}>
          {estadisticas.totalRealizadas} visitas realizadas de{" "}
          {estadisticas.totalProgramadas} programadas
        </Text>
      </View>

      <FlatList
        data={visitas}
        renderItem={renderVisita}
        keyExtractor={(item) => item.id.toString()}
        contentContainerStyle={styles.lista}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={sincronizarFecha} />
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
                  {visitaSeleccionada?.nombreCliente ||
                    `Cliente #${visitaSeleccionada?.idCliente}`}
                </Text>
              </View>

              <ScrollView
                style={styles.tiposContainer}
                showsVerticalScrollIndicator={false}
              >
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
                          styles.tipoOption,
                          tipoVisitaSeleccionado === tipo.id && styles.tipoOptionSelected,
                        ]}
                        onPress={() => setTipoVisitaSeleccionado(tipo.id)}
                        activeOpacity={0.7}
                      >
                        <View style={styles.tipoOptionContent}>
                          <Icon
                            name={icons[tipo.id] || "label"}
                            type="material"
                            size={24}
                            color={
                              tipoVisitaSeleccionado === tipo.id ? "#007AFF" : "#8E8E93"
                            }
                          />
                          <Text
                            style={[
                              styles.tipoText,
                              tipoVisitaSeleccionado === tipo.id &&
                                styles.tipoTextSelected,
                            ]}
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
    paddingTop: 50,
    paddingBottom: 16,
    paddingHorizontal: 16,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
  },
  titulo: {
    fontSize: 20,
    fontWeight: "bold",
    color: "white",
    marginBottom: 4,
  },
  porcentaje: {
    fontSize: 28,
    fontWeight: "bold",
    color: "white",
    marginBottom: 2,
  },
  subtitulo: {
    fontSize: 14,
    color: "white",
    opacity: 0.9,
    marginBottom: 2,
  },
  diaTexto: {
    fontSize: 14,
    color: "white",
    opacity: 0.9,
  },
  navegacionFechas: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginVertical: 12,
    paddingHorizontal: 4,
  },
  botonFlecha: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    justifyContent: "center",
    alignItems: "center",
  },
  fechaContainer: {
    flex: 1,
    alignItems: "center",
    marginHorizontal: 12,
  },
  fechaTexto: {
    fontSize: 16,
    fontWeight: "600",
    color: "white",
    marginBottom: 2,
  },
  statsContainer: {
    flexDirection: "row",
    justifyContent: "space-around",
    backgroundColor: "white",
    marginHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    marginTop: -20,
    elevation: 6,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  statItem: {
    alignItems: "center",
  },
  statValor: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#007AFF",
  },
  statLabel: {
    fontSize: 11,
    color: "#8E8E93",
    marginTop: 2,
    fontWeight: "500",
  },
  lista: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  listaContainer: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 24,
  },
  visitaContainer: {
    marginBottom: 12,
  },
  visitaCard: {
    backgroundColor: "white",
    borderRadius: 12,
    elevation: 3,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    overflow: "hidden",
  },
  visitaHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 14,
  },
  botonesContainer: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },
  botonVentas: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: "#FF9500",
    minWidth: 70,
    justifyContent: "center",
  },
  botonVentasTexto: {
    color: "white",
    fontWeight: "600",
    marginLeft: 4,
    fontSize: 12,
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
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#F0F0F0",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 10,
  },
  clienteDetails: {
    flex: 1,
  },
  clienteId: {
    fontSize: 10,
    color: "#007AFF",
    fontWeight: "600",
    marginBottom: 1,
  },
  clienteNombre: {
    fontSize: 14,
    fontWeight: "600",
    color: "#1C1C1E",
  },
  horaRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 4,
  },
  horaTexto: {
    fontSize: 12,
    color: "#8E8E93",
    marginLeft: 4,
    fontWeight: "500",
  },
  botonVisitado: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    minWidth: 80,
    justifyContent: "center",
  },
  botonVisitadoActivo: {
    backgroundColor: "#34C759",
  },
  botonVisitadoInactivo: {
    backgroundColor: "#007AFF",
  },
  botonVisitadoDisabled: {
    backgroundColor: "#8E8E93",
    opacity: 0.6,
  },
  botonVisitadoTexto: {
    color: "white",
    fontWeight: "600",
    marginLeft: 4,
    fontSize: 12,
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
