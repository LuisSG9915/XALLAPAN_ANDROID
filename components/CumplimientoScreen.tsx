import React, { useState, useEffect, useCallback, useRef } from "react";
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
  TextInput,
} from "react-native";
import { Icon } from "react-native-elements";
import VisitaSyncService from "../services/VisitaSyncService";
import DetalleVisitasService from "../services/DetalleVisitasService";
import Realm from "realm";
import AuthService from "../services/AuthService";
import FullSyncService from "../services/FullSyncService"; // Agregada importación de FullSyncService
import LocationService, { LocationCoordinates, calcularDistancia } from "../services/LocationService";
import ReubicacionService from "../services/ReubicacionService";

interface Visita {
  id: string;
  idOriginal: number;
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
  domicilio?: string;
}

interface ClienteLite {
  id: number;
  nombre: string;
  latitud?: number;
  longitud?: number;
  metros?: number;
  domicilio?: string;
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
        const sucursal =
          (user.sucursal_origen as number | null | undefined) ?? (user.sucursal as number | null | undefined) ?? 1;

        // Intentar obtener metros desde Realm (tabla de usuarios)
        try {
          if (!FullSyncService.isServiceInitialized()) {
            await FullSyncService.initialize();
          }
          if (user.id) {
            const realmUser = FullSyncService.getUsuarioById(user.id);
            if (realmUser && realmUser.metros) {
              setUserMetros(realmUser.metros);
            } else if (user.metros) {
              setUserMetros(user.metros);
            }
            // Verificar permiso de reubicación
            const tienePermiso = ReubicacionService.getInstance().usuarioTienePermisoReubicacion(user.id);
            setUsuarioPermisoReubicacion(tienePermiso);
          }
        } catch (error) {
          if (user.metros) setUserMetros(user.metros);
        }

        setCurrentSucursal(sucursal);

        // Cargar lista completa de clientes (para tabs Cercanos / Todos)
        cargarClientes();

        // Cargar datos locales inmediatamente (sin sincronización)
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
  const [refreshingManual, setRefreshingManual] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [visitaSeleccionada, setVisitaSeleccionada] = useState<VisitaConCliente | null>(null);
  const [tipoVisitaSeleccionado, setTipoVisitaSeleccionado] = useState<number | null>(null);
  const [validandoUbicacion, setValidandoUbicacion] = useState(false);
  const [progresoValidacion, setProgresoValidacion] = useState<{ intento: number; total: number; accuracy: number } | null>(null);
  const [userMetros, setUserMetros] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [mostrarVisitadas, setMostrarVisitadas] = useState(false);

  // Tabs: 'agendados' (visitas del día) | 'cercanos' (GPS) | 'todos' (todos los clientes)
  const [clienteTab, setClienteTab] = useState<"agendados" | "cercanos" | "todos">("agendados");
  const [clientes, setClientes] = useState<ClienteLite[]>([]);
  const [nearestClientes, setNearestClientes] = useState<(ClienteLite & { distanciaMetros: number })[]>([]);
  const [clientesVisitadosHoy, setClientesVisitadosHoy] = useState<Set<number>>(new Set());
  const [userCoords, setUserCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [loadingCercanos, setLoadingCercanos] = useState(false);
  const [reubicandoCliente, setReubicandoCliente] = useState(false);
  const [usuarioPermisoReubicacion, setUsuarioPermisoReubicacion] = useState(false);

  // Obtener tipos de visita desde la base de datos
  const getTipoVisitas = () => {
    if (!FullSyncService.isServiceInitialized()) return [];
    const tipos = FullSyncService.getTipoVisitas();
    console.log(tipos);
    return Array.isArray(tipos) ? tipos : [];
  };

  const tiposVisita = getTipoVisitas();

  const cargarDatos = useCallback((fecha: Date, sucursal: number, showLoading = true) => {
    if (showLoading) setLoading(true);
    Promise.all([
      VisitaSyncService.getInstance().getVisitasByFecha(fecha, sucursal),
      VisitaSyncService.getInstance().getEstadisticasCumplimiento(fecha, sucursal),
      VisitaSyncService.getInstance().getClientesVisitadosHoy(sucursal),
    ])
      .then(([visitasDelDia, stats, visitadosHoy]) => {
        console.log("[Cumplimiento] cargarDatos -> visitadosHoy:", Array.from(visitadosHoy), "sucursal:", sucursal, "fecha:", fecha.toISOString());
        setClientesVisitadosHoy(visitadosHoy);

        // Lookup síncrono de clientes desde Realm (sin promesas por cliente)
        const visitasConNombres = visitasDelDia.map((visita: any) => {
          const idClienteNum = Number(visita.idCliente);
          const cliente = FullSyncService.getClienteFullById(idClienteNum);
          return {
            ...visita,
            idCliente: idClienteNum,
            nombreCliente: cliente?.nombre ? String(cliente.nombre) : `Cliente #${idClienteNum}`,
            latitud: cliente?.latitud != null ? Number(cliente.latitud) : undefined,
            longitud: cliente?.longitud != null ? Number(cliente.longitud) : undefined,
            metros: cliente?.metros != null ? Number(cliente.metros) : undefined,
            domicilio: cliente?.domicilio ? String(cliente.domicilio) : undefined,
          };
        });
        setVisitas(visitasConNombres);
        setEstadisticas(stats);
      })
      .catch((error) => {
        console.error("[Cumplimiento] Error al cargar datos:", error);
        Alert.alert("Error", "No se pudieron cargar las visitas");
      })
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
        setRefreshingManual(false);
      });
  }, []);

  // Recargar visitas cuando la pantalla recibe foco
  useFocusEffect(
    useCallback(() => {
      if (currentSucursal > 0) {
        // Cargar datos locales (sin sincronización)
        cargarDatos(fechaSeleccionada, currentSucursal);
      }
    }, [fechaSeleccionada, currentSucursal, cargarDatos]),
  );

  const handleMarcarVisitado = async (idVisita: string) => {
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
      setValidandoUbicacion(true);
      setProgresoValidacion(null);
      const ubicacionValida = await LocationService.validarUbicacionConAlerta(
        visita.latitud,
        visita.longitud,
        userMetros ?? visita.metros ?? 100,
        (intento, total, acc) => {
          setProgresoValidacion({ intento, total, accuracy: acc });
        },
        {
          id: visita.idCliente,
          nombre: visita.nombreCliente,
          lat: visita.latitud,
          lng: visita.longitud,
        },
      );
      setValidandoUbicacion(false);
      setProgresoValidacion(null);
      if (!ubicacionValida) return;
    } else {
      Alert.alert("Cliente sin ubicación", "El cliente no tiene registrada su ubicación geográfica.");
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
      visitaSeleccionada.idOriginal,
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

          if (v.idCliente === visitaSeleccionada.idCliente && visitaFecha.getTime() === fechaHoy.getTime()) {
            console.log(
              `[Cumplimiento] ✅ Actualizando visita local: Cliente ${v.idCliente}, Fecha ${
                visitaFecha.toISOString().split("T")[0]
              }`,
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
          prevStats.totalProgramadas > 0 ? ((prevStats.totalRealizadas + 1) / prevStats.totalProgramadas) * 100 : 0,
      }));

      Alert.alert("Éxito", "Visita marcada como realizada");
    } else {
      Alert.alert("Error", "No se pudo marcar la visita");
    }
  };

  const obtenerNombreDia = (fecha: Date) => {
    const dias = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
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
    // Desactivado: usa endpoint /api/MovilesVentas/visitas/full sin sucursal
    // try {
    //   await VisitaSyncService.getInstance().syncByDate(fechaSeleccionada);
    // } catch (err) {
    //   console.warn("[Cumplimiento] Error al sincronizar:", err);
    // }
    cargarDatos(fechaSeleccionada, currentSucursal);
  };

  const handleRefreshManual = async () => {
    setRefreshingManual(true);
    // try {
    //   await VisitaSyncService.getInstance().syncByDate(fechaSeleccionada);
    // } catch (err) {
    //   console.warn("[Cumplimiento] Error al sincronizar manual:", err);
    // }
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

  const handleIrAVentas = async (visita: VisitaConCliente) => {
    const t0 = Date.now();
    console.log(`[Cumplimiento] handleIrAVentas INICIO (t=0ms) -> cliente: ${visita.idCliente} ${visita.nombreCliente}`);

    if (visita.latitud && visita.longitud) {
      setValidandoUbicacion(true);
      setProgresoValidacion(null);
      console.log(`[Cumplimiento] handleIrAVentas validando ubicación... (t=${Date.now() - t0}ms)`);
      const ubicacionValida = await LocationService.validarUbicacionConAlerta(
        visita.latitud,
        visita.longitud,
        userMetros ?? visita.metros ?? 100,
        (intento, total, acc) => {
          setProgresoValidacion({ intento, total, accuracy: acc });
        },
        {
          id: visita.idCliente,
          nombre: visita.nombreCliente,
          lat: visita.latitud,
          lng: visita.longitud,
        },
      );
      setValidandoUbicacion(false);
      setProgresoValidacion(null);
      console.log(`[Cumplimiento] handleIrAVentas ubicación validada: ${ubicacionValida} (t=${Date.now() - t0}ms)`);
      if (!ubicacionValida) return;
    }

    console.log(`[Cumplimiento] handleIrAVentas navegando a Sales... (t=${Date.now() - t0}ms)`);
    navigation.navigate("Sales", {
      clienteId: visita.idCliente,
      nombreCliente: visita.nombreCliente,
      desdeVisita: true,
    });
    console.log(`[Cumplimiento] handleIrAVentas FIN navigate llamado (t=${Date.now() - t0}ms)`);
  };

  // Navegar a Punto de Venta para un cliente seleccionado (Cercanos / Todos)
  const handleIrAVentasCliente = async (cliente: ClienteLite) => {
    const t0 = Date.now();
    console.log(`[Cumplimiento] handleIrAVentasCliente INICIO (t=0ms) -> cliente: ${cliente.id} ${cliente.nombre}`);

    if (cliente.latitud && cliente.longitud) {
      setValidandoUbicacion(true);
      setProgresoValidacion(null);
      console.log(`[Cumplimiento] handleIrAVentasCliente validando ubicación... (t=${Date.now() - t0}ms)`);
      const ubicacionValida = await LocationService.validarUbicacionConAlerta(
        cliente.latitud,
        cliente.longitud,
        userMetros ?? cliente.metros ?? 100,
        (intento, total, acc) => {
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
      setProgresoValidacion(null);
      console.log(`[Cumplimiento] handleIrAVentasCliente ubicación validada: ${ubicacionValida} (t=${Date.now() - t0}ms)`);
      if (!ubicacionValida) return;
    }

    console.log(`[Cumplimiento] handleIrAVentasCliente navegando a Sales... (t=${Date.now() - t0}ms)`);
    navigation.navigate("Sales", {
      clienteId: cliente.id,
      nombreCliente: cliente.nombre,
      desdeVisita: true,
    });
    console.log(`[Cumplimiento] handleIrAVentasCliente FIN navigate llamado (t=${Date.now() - t0}ms)`);
  };

  // Reubicar cliente
  const handleReubicarCliente = async (cliente: ClienteLite) => {
    const currentUser = await AuthService.restoreSession();
    if (!currentUser) {
      Alert.alert("Error", "No hay usuario autenticado");
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
      `¿Deseas actualizar la ubicación del cliente ${cliente.nombre}?\n\nSe guardará tu ubicación GPS actual como la nueva ubicación del cliente.`,
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Reubicar",
          onPress: async () => {
            setReubicandoCliente(true);
            try {
              console.log("[Cumplimiento] Obteniendo ubicación GPS para reubicación...");
              const ubicacion = await LocationService.getBestLocation();

              if (!ubicacion) {
                Alert.alert("Error GPS", "No se pudo obtener tu ubicación. Verifica que el GPS esté activado.");
                setReubicandoCliente(false);
                return;
              }

              console.log("[Cumplimiento] Ubicación obtenida:", ubicacion);

              const reubicacionId = await ReubicacionService.getInstance().registrarReubicacion(
                cliente.id,
                ubicacion.latitude,
                ubicacion.longitude,
                currentUser.id,
                currentSucursal,
              );

              if (reubicacionId) {
                // Actualizar estado local inmediatamente para que Ventas/Visitar usen las nuevas coordenadas
                setVisitas((prev) =>
                  prev.map((v) =>
                    v.idCliente === cliente.id
                      ? { ...v, latitud: ubicacion.latitude, longitud: ubicacion.longitude }
                      : v,
                  ),
                );
                setClientes((prev) =>
                  prev.map((c) =>
                    c.id === cliente.id
                      ? { ...c, latitud: ubicacion.latitude, longitud: ubicacion.longitude }
                      : c,
                  ),
                );
                setNearestClientes((prev) => {
                  const idx = prev.findIndex((c) => c.id === cliente.id);
                  if (idx === -1) return prev;
                  const actualizado = {
                    ...prev[idx],
                    latitud: ubicacion.latitude,
                    longitud: ubicacion.longitude,
                    distanciaMetros: 0,
                  };
                  const nuevos = [...prev];
                  nuevos[idx] = actualizado;
                  return nuevos.sort((a, b) => a.distanciaMetros - b.distanciaMetros);
                });

                // Recargar clientes y visitas en segundo plano (sin pantalla de carga)
                cargarClientes();
                cargarDatos(fechaSeleccionada, currentSucursal, false);
                Alert.alert("Éxito", "La ubicación del cliente ha sido actualizada. Ya puedes vender o visitar.");
              } else {
                Alert.alert("Error", "No se pudo registrar la reubicación.");
              }
            } catch (error) {
              console.error("[Cumplimiento] Error al reubicar cliente:", error);
              Alert.alert("Error", "Ocurrió un error al reubicar el cliente.");
            } finally {
              setReubicandoCliente(false);
            }
          },
        },
      ],
    );
  };

  // Guardia síncrona contra doble tap: el state `validandoUbicacion` tarda un
  // frame en deshabilitar el botón; dos taps rápidos lanzaban dos validaciones
  // concurrentes (y dos registros idénticos en la bitácora).
  const visitandoRef = useRef(false);

  // Visitar cliente desde tabs Cercanos/Todos
  const handleVisitarCliente = async (cliente: ClienteLite) => {
    if (visitandoRef.current) return;
    visitandoRef.current = true;
    try {
      await handleVisitarClienteImpl(cliente);
    } finally {
      visitandoRef.current = false;
    }
  };

  const handleVisitarClienteImpl = async (cliente: ClienteLite) => {
    // Función auxiliar para comparar fechas (mismo día)
    const isSameDay = (date1: Date, date2: Date): boolean => {
      return (
        date1.getFullYear() === date2.getFullYear() &&
        date1.getMonth() === date2.getMonth() &&
        date1.getDate() === date2.getDate()
      );
    };

    // Buscar visita del cliente para el día actual
    const visitaHoy = visitas.find((v) => v.idCliente === cliente.id && isSameDay(v.fecha, fechaSeleccionada));

    if (!visitaHoy) {
      // Si no hay visita programada, validar ubicación antes de permitir crear visita manual
      const omitirValidacionUbicacion = ReubicacionService.getInstance().clienteYaReubicado(cliente.id);

      if (!omitirValidacionUbicacion) {
        if (cliente.latitud && cliente.longitud) {
          setValidandoUbicacion(true);
          setProgresoValidacion(null);
          const ubicacionValida = await LocationService.validarUbicacionConAlerta(
            cliente.latitud,
            cliente.longitud,
            userMetros ?? cliente.metros ?? 100,
            (intento, total, acc) => {
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
          setProgresoValidacion(null);
          if (!ubicacionValida) return;
        } else {
          Alert.alert(
            "Cliente sin ubicación",
            "El cliente no tiene ubicación registrada. No se puede registrar la visita.",
          );
          return;
        }
      }

      // Si no hay visita programada, crear una nueva visita para hoy
      Alert.alert(
        "Crear visita",
        `El cliente ${cliente.nombre} no tiene visita programada para hoy. ¿Deseas registrar la visita?`,
        [
          { text: "Cancelar", style: "cancel" },
          {
            text: "Registrar",
            onPress: async () => {
              try {
                // Crear nueva visita en Realm
                const user = await AuthService.restoreSession();
                const sucursal = user?.sucursal_origen || user?.sucursal || 0;
                const fechaStr = fechaSeleccionada.toISOString().split("T")[0];
                const idCompuesto = `0-${fechaStr}-${cliente.id}`; // ID único para visita manual

                if (!FullSyncService.isServiceInitialized()) {
                  await FullSyncService.initialize();
                }
                const realm = (FullSyncService as any).realm;

                realm.write(() => {
                  realm.create("Visita", {
                    id: idCompuesto,
                    idOriginal: 0,
                    idCliente: cliente.id,
                    ruta: "manual",
                    fecha: fechaSeleccionada,
                    orden: 999,
                    tipo: 1,
                    visitado: 0,
                    syncedAr: null,
                  }, Realm.UpdateMode.Modified);
                });

                console.log("[Cumplimiento] Visita creada manualmente para cliente", cliente.id);

                // Abrir modal para seleccionar tipo de visita
                const nuevaVisita: VisitaConCliente = {
                  id: idCompuesto,
                  idOriginal: 0,
                  idCliente: cliente.id,
                  ruta: "manual",
                  fecha: fechaSeleccionada,
                  orden: 999,
                  tipo: 1,
                  visitado: 0,
                  nombreCliente: cliente.nombre,
                  latitud: cliente.latitud,
                  longitud: cliente.longitud,
                  metros: cliente.metros,
                  domicilio: cliente.domicilio,
                };

                // Agregar la visita manual al estado local
                setVisitas((prevVisitas) => [...prevVisitas, nuevaVisita]);

                setVisitaSeleccionada(nuevaVisita);
                setTipoVisitaSeleccionado(null);
                setModalVisible(true);
              } catch (error: any) {
                console.error("[Cumplimiento] Error al crear visita:", error);
                Alert.alert("Error", `No se pudo crear la visita. ${error?.message || error}`);
              }
            },
          },
        ],
      );
      return;
    }

    if (visitaHoy.visitado === 1) {
      Alert.alert("Información", "Esta visita ya fue marcada como realizada");
      return;
    }

    // Usar la función existente handleMarcarVisitado
    await handleMarcarVisitado(visitaHoy.id);
  };

  // Cargar todos los clientes locales desde Realm
  const cargarClientes = useCallback(() => {
    try {
      if (!FullSyncService.isServiceInitialized()) return;
      const data = FullSyncService.getClientesFull(10000);
      const formateados: ClienteLite[] = data.map((c: any) => ({
        id: c.id,
        nombre: c.nombre || "Sin nombre",
        latitud: c.latitud != null ? Number(c.latitud) : undefined,
        longitud: c.longitud != null ? Number(c.longitud) : undefined,
        metros: c.metros != null ? Number(c.metros) : undefined,
        domicilio: c.domicilio ? String(c.domicilio) : undefined,
      }));
      setClientes(formateados);
    } catch (error) {
      console.warn("[Cumplimiento] Error al cargar clientes:", error);
    }
  }, []);

  // Obtener ubicación del vendedor y recalcular los 5 clientes más cercanos
  const actualizarCoordenadas = async () => {
    setLoadingCercanos(true);
    try {
      const ubicacion = await LocationService.getBestLocation();
      if (ubicacion) {
        setUserCoords({ latitude: ubicacion.latitude, longitude: ubicacion.longitude });
        const clientesConCoords = clientes.filter(
          (c) => c.latitud != null && c.longitud != null && (c.latitud !== 0 || c.longitud !== 0),
        );
        console.log("[Cumplimiento] actualizarCoordenadas -> clientesConCoords:", clientesConCoords.length, "de", clientes.length, "clientes totales");
        console.log("[Cumplimiento] actualizarCoordenadas -> clientes SIN coords:", clientes.filter((c) => !c.latitud || !c.longitud || (c.latitud === 0 && c.longitud === 0)).map((c) => ({ id: c.id, nombre: c.nombre })));

        const clientesConDistancia = clientesConCoords
          .map((c) => ({
            ...c,
            distanciaMetros: calcularDistancia(ubicacion.latitude, ubicacion.longitude, c.latitud!, c.longitud!),
          }))
          .sort((a, b) => a.distanciaMetros - b.distanciaMetros)
          .slice(0, 5);
        console.log("[Cumplimiento] actualizarCoordenadas -> nearestClientes (top 5):", clientesConDistancia.map((c) => ({ id: c.id, nombre: c.nombre, distanciaMetros: c.distanciaMetros })));
        setNearestClientes(clientesConDistancia);
      } else {
        Alert.alert("Ubicación no disponible", "No se pudo obtener tu ubicación. Verifica que el GPS esté activado.");
      }
    } catch (error) {
      console.error("[Cumplimiento] Error al obtener ubicación:", error);
      Alert.alert("Error de ubicación", "No se pudo obtener tu ubicación.");
    } finally {
      setLoadingCercanos(false);
    }
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
                <Text style={styles.clienteNombre}>{item.nombreCliente || "Cargando..."}</Text>
                {item.domicilio ? (
                  <Text style={styles.domicilioTexto} numberOfLines={1}>
                    {item.domicilio}
                  </Text>
                ) : null}
              </View>
            </View>
            <View style={styles.horaRow}>
              <Icon name="schedule" type="material" size={14} color="#8E8E93" />
              <Text style={styles.horaTexto}>{obtenerRangoHorario(item)}</Text>
            </View>
          </View>
          <View style={styles.botonesContainer}>
            {usuarioPermisoReubicacion && (
              <TouchableOpacity
                style={[styles.reubicarBtnModal, reubicandoCliente && styles.reubicarBtnModalDisabled]}
                onPress={() => handleReubicarCliente({ id: item.idCliente, nombre: item.nombreCliente || "Cliente" })}
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
            {item.visitado === 0 && (
              <TouchableOpacity style={styles.botonVentas} onPress={() => handleIrAVentas(item)} activeOpacity={0.8}>
                <Icon name="shopping-cart" type="material" size={16} color="white" />
                <Text style={styles.botonVentasTexto}>Ventas</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[
                styles.botonVisitado,
                item.visitado === 1 ? styles.botonVisitadoActivo : styles.botonVisitadoInactivo,
                validandoUbicacion && styles.botonVisitadoDisabled,
              ]}
              onPress={() => handleMarcarVisitado(item.id)}
              disabled={item.visitado === 1 || validandoUbicacion}
              activeOpacity={0.8}
            >
              {validandoUbicacion ? (
                <>
                  <ActivityIndicator size="small" color="white" />
                  <Text style={styles.botonVisitadoTexto}>
                    {progresoValidacion ? `±${Math.round(progresoValidacion.accuracy)}m` : "GPS..."}
                  </Text>
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
                      item.visitado === 1 ? styles.botonVisitadoTextoActivo : styles.botonVisitadoTextoInactivo,
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

  // Filtrar visitas según búsqueda y toggle de visitadas
  const visitasFiltradas = visitas.filter((v) => {
    const coincideBusqueda =
      !searchQuery.trim() ||
      (v.nombreCliente || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      String(v.idCliente).includes(searchQuery);
    const coincideEstado = mostrarVisitadas ? true : v.visitado !== 1;
    return coincideBusqueda && coincideEstado;
  });

  // Filtrar todos los clientes por búsqueda (tab Todos)
  const clientesFiltrados = clientes.filter((c) => {
    if (!searchQuery.trim()) return true;
    return (c.nombre || "").toLowerCase().includes(searchQuery.toLowerCase()) || String(c.id).includes(searchQuery);
  });

  // Render de un cliente para los tabs Cercanos / Todos (botón -> Ventas)
  const renderClienteVenta = (cliente: ClienteLite & { distanciaMetros?: number }) => {
    // Verificar si el cliente tiene visita visitada hoy
    const isSameDay = (date1: Date, date2: Date): boolean => {
      return (
        date1.getFullYear() === date2.getFullYear() &&
        date1.getMonth() === date2.getMonth() &&
        date1.getDate() === date2.getDate()
      );
    };
    const visitaHoy = visitas.find((v) => v.idCliente === cliente.id && isSameDay(v.fecha, fechaSeleccionada));
    const fueVisitadoHoy = visitaHoy?.visitado === 1 || clientesVisitadosHoy.has(cliente.id);
    console.log("[Cumplimiento] renderClienteVenta -> cliente:", cliente.id, cliente.nombre, "distancia:", cliente.distanciaMetros, "visitaHoy:", visitaHoy ? { id: visitaHoy.id, visitado: visitaHoy.visitado } : null, "fueVisitadoHoy:", fueVisitadoHoy, "visitadosHoy size:", clientesVisitadosHoy.size);

    return (
      <View style={styles.visitaContainer}>
        <View style={styles.visitaCard}>
          <View style={styles.visitaHeader}>
            <View style={styles.visitaInfo}>
              <View style={styles.clienteRow}>
                <View style={styles.clienteIcon}>
                  <Icon
                    name={fueVisitadoHoy ? "check-circle" : "store"}
                    type="material"
                    size={20}
                    color={fueVisitadoHoy ? "#34C759" : "#007AFF"}
                  />
                </View>
                <View style={styles.clienteDetails}>
                  <Text style={styles.clienteId}>#{cliente.id}</Text>
                  <Text style={styles.clienteNombre}>{cliente.nombre}</Text>
                  {cliente.domicilio ? (
                    <Text style={styles.domicilioTexto} numberOfLines={1}>
                      {cliente.domicilio}
                    </Text>
                  ) : null}
                  {cliente.distanciaMetros != null && (
                    <View style={styles.horaRow}>
                      <Icon name="place" type="material" size={14} color="#8E8E93" />
                      <Text style={styles.horaTexto}>
                        {cliente.distanciaMetros < 1000
                          ? `${Math.round(cliente.distanciaMetros)} m`
                          : `${(cliente.distanciaMetros / 1000).toFixed(1)} km`}
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            </View>
            <View style={styles.botonesContainer}>
              {usuarioPermisoReubicacion && (
                <TouchableOpacity
                  style={[styles.reubicarBtnModal, reubicandoCliente && styles.reubicarBtnModalDisabled]}
                  onPress={() => handleReubicarCliente(cliente)}
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
              <TouchableOpacity
                style={styles.botonVentas}
                onPress={() => handleIrAVentasCliente(cliente)}
                activeOpacity={0.8}
              >
                <Icon name="shopping-cart" type="material" size={16} color="white" />
                <Text style={styles.botonVentasTexto}>Ventas</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.botonVisitado,
                  fueVisitadoHoy ? styles.botonVisitadoActivo : styles.botonVisitadoInactivo,
                  validandoUbicacion && styles.botonVisitadoDisabled,
                ]}
                onPress={() => handleVisitarCliente(cliente)}
                disabled={fueVisitadoHoy || validandoUbicacion}
                activeOpacity={0.8}
              >
                {validandoUbicacion ? (
                  <>
                    <ActivityIndicator size="small" color="white" />
                    <Text style={styles.botonVisitadoTexto}>
                      {progresoValidacion ? `±${Math.round(progresoValidacion.accuracy)}m` : "GPS..."}
                    </Text>
                  </>
                ) : (
                  <>
                    <Icon name={fueVisitadoHoy ? "check" : "directions-walk"} type="material" size={16} color="white" />
                    <Text
                      style={[
                        styles.botonVisitadoTexto,
                        fueVisitadoHoy ? styles.botonVisitadoTextoActivo : styles.botonVisitadoTextoInactivo,
                      ]}
                    >
                      {fueVisitadoHoy ? "Completado" : "Visitar"}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.tituloRow}>
          <Text style={styles.titulo}>Cumplimiento de agenda</Text>
          <TouchableOpacity onPress={handleRefreshManual} disabled={refreshingManual} style={styles.refreshHeaderBtn}>
            {refreshingManual ? (
              <ActivityIndicator size="small" color="white" />
            ) : (
              <Icon name="refresh" type="material" size={20} color="white" />
            )}
          </TouchableOpacity>
        </View>

        <View style={styles.navegacionFechas}>
          <TouchableOpacity style={styles.botonFlecha} onPress={() => cambiarDia(-1)} activeOpacity={0.7}>
            <Icon name="chevron-left" type="material" size={24} color="white" />
          </TouchableOpacity>

          <View style={styles.fechaContainer}>
            <Text style={styles.fechaTexto}>{formatearFecha(fechaSeleccionada)}</Text>
            <Text style={styles.diaTexto}>{obtenerNombreDia(fechaSeleccionada)}</Text>
          </View>

          <TouchableOpacity style={styles.botonFlecha} onPress={() => cambiarDia(1)} activeOpacity={0.7}>
            <Icon name="chevron-right" type="material" size={24} color="white" />
          </TouchableOpacity>
        </View>

        <Text style={styles.porcentaje}>{estadisticas.porcentaje.toFixed(1)}%</Text>
        <Text style={styles.subtitulo}>
          {estadisticas.totalRealizadas} visitas realizadas de {estadisticas.totalProgramadas} programadas
        </Text>
      </View>

      <View style={styles.searchRow}>
        <View style={styles.searchInputWrap}>
          <Icon name="search" type="material" size={18} color="#8E8E93" />
          <TextInput
            style={styles.searchInput}
            placeholder="Buscar cliente..."
            placeholderTextColor="#C7C7CC"
            value={searchQuery}
            onChangeText={setSearchQuery}
            clearButtonMode="while-editing"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery("")}>
              <Icon name="close" type="material" size={16} color="#8E8E93" />
            </TouchableOpacity>
          )}
        </View>
        {clienteTab === "agendados" && (
          <TouchableOpacity
            style={[styles.toggleVisitadasBtn, mostrarVisitadas && styles.toggleVisitadasBtnActive]}
            onPress={() => setMostrarVisitadas((v) => !v)}
          >
            <Icon
              name={mostrarVisitadas ? "visibility" : "visibility-off"}
              type="material"
              size={16}
              color={mostrarVisitadas ? "#007AFF" : "#8E8E93"}
            />
            <Text style={[styles.toggleVisitadasText, mostrarVisitadas && styles.toggleVisitadasTextActive]}>
              {mostrarVisitadas ? "Todas" : "Pendientes"}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Tabs: Agendados | Cercanos | Todos */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tabItem, clienteTab === "agendados" && styles.tabItemActive]}
          onPress={() => setClienteTab("agendados")}
        >
          <Text style={[styles.tabItemText, clienteTab === "agendados" && styles.tabItemTextActive]}>Agendados</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabItem, clienteTab === "cercanos" && styles.tabItemActive]}
          onPress={() => {
            setClienteTab("cercanos");
            if (nearestClientes.length === 0) actualizarCoordenadas();
          }}
        >
          <Text style={[styles.tabItemText, clienteTab === "cercanos" && styles.tabItemTextActive]}>Cercanos</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabItem, clienteTab === "todos" && styles.tabItemActive]}
          onPress={() => setClienteTab("todos")}
        >
          <Text style={[styles.tabItemText, clienteTab === "todos" && styles.tabItemTextActive]}>Todos</Text>
        </TouchableOpacity>
      </View>

      {validandoUbicacion && progresoValidacion && progresoValidacion.accuracy > 50 && (
        <View style={styles.gpsTipBanner}>
          <Icon name="rotate-left" type="material" size={22} color="#FF9800" />
          <View style={styles.gpsTipBannerContent}>
            <Text style={styles.gpsTipBannerTitulo}>Mejorando precisión GPS</Text>
            <Text style={styles.gpsTipBannerTexto}>
              Mueve el teléfono en forma de 8 para calibrar ({Math.round(progresoValidacion.accuracy)}m, intento {progresoValidacion.intento}/{progresoValidacion.total})
            </Text>
          </View>
        </View>
      )}

      {validandoUbicacion && progresoValidacion && progresoValidacion.accuracy <= 50 && (
        <View style={[styles.gpsTipBanner, styles.gpsTipBannerOk]}>
          <Icon name="gps-fixed" type="material" size={22} color="#4CAF50" />
          <View style={styles.gpsTipBannerContent}>
            <Text style={[styles.gpsTipBannerTitulo, { color: "#4CAF50" }]}>Señal GPS aceptable</Text>
            <Text style={styles.gpsTipBannerTexto}>
              Precisión: ±{Math.round(progresoValidacion.accuracy)}m — Validando ubicación...
            </Text>
          </View>
        </View>
      )}

      {/* Botón actualizar coordenadas (solo Cercanos) */}
      {clienteTab === "cercanos" && (
        <View style={styles.refreshCoordsWrap}>
          <TouchableOpacity style={styles.refreshCoordsBtn} onPress={actualizarCoordenadas} disabled={loadingCercanos}>
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

      {clienteTab === "agendados" ? (
        <FlatList
          data={visitasFiltradas}
          renderItem={renderVisita}
          keyExtractor={(item) => item.id.toString()}
          contentContainerStyle={styles.lista}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={sincronizarFecha} />}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Icon name="event" type="material" size={64} color="#C7C7CC" />
              <Text style={styles.emptyTexto}>
                {searchQuery
                  ? 'Sin resultados para "' + searchQuery + '"'
                  : mostrarVisitadas
                  ? "No hay visitas programadas"
                  : "No hay visitas pendientes"}
              </Text>
            </View>
          }
        />
      ) : clienteTab === "cercanos" ? (
        <FlatList
          data={nearestClientes}
          renderItem={({ item }) => renderClienteVenta(item)}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.lista}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Icon name="near-me" type="material" size={64} color="#C7C7CC" />
              <Text style={styles.emptyTexto}>
                {loadingCercanos ? "Buscando clientes cercanos..." : "Pulsa actualizar para ver clientes cercanos"}
              </Text>
            </View>
          }
        />
      ) : (
        <FlatList
          data={clientesFiltrados}
          renderItem={({ item }) => renderClienteVenta(item)}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.lista}
          initialNumToRender={15}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Icon name="people" type="material" size={64} color="#C7C7CC" />
              <Text style={styles.emptyTexto}>
                {searchQuery ? 'Sin resultados para "' + searchQuery + '"' : "No hay clientes"}
              </Text>
            </View>
          }
        />
      )}

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
    paddingTop: 50,
    paddingBottom: 16,
    paddingHorizontal: 16,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
  },
  tituloRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  titulo: {
    fontSize: 20,
    fontWeight: "bold",
    color: "white",
  },
  refreshHeaderBtn: {
    padding: 6,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.2)",
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
    gap: 4,
    alignItems: "center",
  },
  botonVentas: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: "#FF9500",
    minWidth: 60,
    justifyContent: "center",
  },
  botonVentasTexto: {
    color: "white",
    fontWeight: "600",
    marginLeft: 2,
    fontSize: 11,
  },
  reubicarBtnModal: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FF9800",
    paddingHorizontal: 6,
    paddingVertical: 6,
    borderRadius: 16,
    gap: 2,
  },
  reubicarBtnModalDisabled: {
    backgroundColor: "#BDBDBD",
    opacity: 0.6,
  },
  reubicarBtnModalText: {
    display: "none",
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
  domicilioTexto: {
    fontSize: 12,
    color: "#8E8E93",
    marginTop: 2,
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
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    minWidth: 65,
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
    marginLeft: 2,
    fontSize: 11,
  },
  botonVisitadoTextoActivo: {
    color: "white",
  },
  botonVisitadoTextoInactivo: {
    color: "white",
  },
  gpsTipBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 152, 0, 0.1)",
    marginHorizontal: 16,
    marginTop: 8,
    padding: 12,
    borderRadius: 12,
    gap: 10,
    borderLeftWidth: 4,
    borderLeftColor: "#FF9800",
  },
  gpsTipBannerOk: {
    backgroundColor: "rgba(76, 175, 80, 0.1)",
    borderLeftColor: "#4CAF50",
  },
  gpsTipBannerContent: {
    flex: 1,
  },
  gpsTipBannerTitulo: {
    fontSize: 13,
    fontWeight: "700",
    color: "#FF9800",
    marginBottom: 2,
  },
  gpsTipBannerTexto: {
    fontSize: 12,
    color: "#666",
    lineHeight: 16,
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
  toggleVisitadasBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: "#E5E5EA",
    backgroundColor: "#FFFFFF",
    alignSelf: "flex-start",
  },
  toggleVisitadasBtnActive: {
    borderColor: "#007AFF",
    backgroundColor: "#EAF3FF",
  },
  toggleVisitadasText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#8E8E93",
  },
  toggleVisitadasTextActive: {
    color: "#007AFF",
  },
  searchRow: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  searchInputWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: "#E5E5EA",
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: "#1C1C1E",
    paddingVertical: 0,
  },
  tabBar: {
    flexDirection: "row",
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: "#FFFFFF",
    borderRadius: 10,
    padding: 4,
    borderWidth: 1,
    borderColor: "#E5E5EA",
  },
  tabItem: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  tabItemActive: {
    backgroundColor: "#007AFF",
  },
  tabItemText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#8E8E93",
  },
  tabItemTextActive: {
    color: "#FFFFFF",
  },
  refreshCoordsWrap: {
    marginHorizontal: 16,
    marginBottom: 8,
  },
  refreshCoordsBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#007AFF",
    paddingVertical: 10,
    borderRadius: 10,
  },
  refreshCoordsBtnText: {
    color: "#FFFFFF",
    fontWeight: "600",
    fontSize: 13,
  },
  coordsInfo: {
    fontSize: 12,
    color: "#8E8E93",
    textAlign: "center",
    marginTop: 4,
  },
});
