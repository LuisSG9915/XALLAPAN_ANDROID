// Esquemas de Realm para todas las entidades

export const VentaSchema = {
  name: "Venta",
  properties: {
    id: "int",
    sucursal: "int?",
    noVenta: "int?",
    idMovil: "int?",
    claveProd: "int?",
    nombreProducto: "string?",
    cantProducto: "int?",
    precio: "float?",
    importe: "float?",
    cveCliente: "int?",
    nombreCliente: "string?",
    fecha: "date?",
    tipoPago: "int?",
    descripcionMedioPago: "string?",
    vendedor: "string?",
    folioFactura: "bool?",
    facturacionMovil: "bool?",
    latitud: "double?",
    longitud: "double?",
    observacion: "string?",
    idPedido: "int?",
    idLista: "int?",
    syncedAt: "date",
    syncedAr: "date?",
  },
  primaryKey: "id",
};

export const UsuarioSchema = {
  name: "Usuario",
  properties: {
    id: "int",
    nombre: "string?",
    perfil: "int?",
    descripcionPerfil: "string?",
    puesto: "int?",
    descripcionPuesto: "string?",
    claveEmpleado: "string?",
    password: "string?",
    ruta: "string?",
    sucursalOrigen: "int?",
    sucursalNombre: "string?",
    metros: "float?",
    reubicacion: "bool?",
    rfc: "string?",
    domicilio: "string?",
    regimenFiscal: "string?",
    nombreCia: "string?",
    telefono: "string?",
    ticketFinal: "string?",
    permisoDomicilioTicket: "bool?",
    dobleTicket: "bool?",
    envaseRuta: "bool?",
    syncedAt: "date",
    syncedAr: "date?",
  },
  primaryKey: "id",
};

export const ProductoSchema = {
  name: "Producto",
  properties: {
    id: "int",
    claveProd: "string?",
    descripcion: "string?",
    descripcionArea: "string?",
    esKit: "bool?",
    envaseRecibe: "bool?",
    intercambio: "bool?",
    prestamo: "bool?",
    inventariable: "bool?",
    fechaAct: "date?",
    omitirMovil: "int?",
    precioCatalogo: "bool?",
    envaseRuta: "bool?",
    syncedAt: "date",
    syncedAr: "date?",
  },
  primaryKey: "id",
};

export const KitSchema = {
  name: "Kit",
  properties: {
    id: "int",
    idProducto: "int?",
    idInsumo: "int?",
    cantidad: "float?",
    precio: "float?",
    descuento: "float?",
    envaseIntercambio: "bool?",
    envasePrestado: "bool?",
    recuperaEnvase: "bool?",
    claveIntercambio: "int?",
    recuperaEnvaseOtro: "bool?",
    controlPresamo: "bool?",
    envaseVendido: "bool?",
    cantRecEnvOtro: "int?", // Número entero: cantidad de envases a recibir (0, 1, 2, 3...)
    noRecuperaEnvase: "bool?",
    noPrecioCatalogo: "bool?",
    syncedAt: "date",
  },
  primaryKey: "id",
};

export const KitIntercambioSchema = {
  name: "KitIntercambio",
  properties: {
    id: "int",
    idProducto: "int?",
    idEnvaseOtro: "int?",
    precioEnvase: "double?",
    syncedAt: "date",
  },
  primaryKey: "id",
};

export const PrecioSchema = {
  name: "Precio",
  properties: {
    id: "string",
    descripcion: "string?",
    idCliente: "int?",
    claveProd: "int?",
    precio: "float?",
    listaPrecio: "int?",
    fechaAct: "date?",
    syncedAt: "date",
    syncedAr: "date?",
  },
  primaryKey: "id",
};

export const PrecioPromoSchema = {
  name: "PrecioPromo",
  properties: {
    id: "string",
    descripcion: "string?",
    idCliente: "int?",
    claveProd: "int?",
    precio: "float?",
    listaPrecio: "int?",
    fechaAct: "date?",
    syncedAt: "date",
    syncedAr: "date?",
  },
  primaryKey: "id",
};

export const InventarioSchema = {
  name: "Inventario",
  properties: {
    id: "int",
    sucursal: "int?",
    claveProd: "int?",
    fechaArrastre: "date?",
    saldo: "float?",
    descripcion: "string?",
    syncedAt: "date",
  },
  primaryKey: "id",
};

export const CarteraSchema = {
  name: "Cartera",
  properties: {
    id: "int",
    idCliente: "int?",
    nombreCliente: "string?",
    sucursal: "int?",
    sucursalSegmento: "int?",
    saldo: "float?",
    fecha: "date?",
    idSegmento: "int?",
    noVenta: "int?",
    cobrado: "bool?",
    syncedAt: "date",
    syncedAr: "date",
  },
  primaryKey: "id",
};

export const ClienteFullSchema = {
  name: "ClienteFull",
  properties: {
    id: "int",
    nombre: "string?",
    longitud: "float?",
    latitud: "float?",
    idGrupo: "int?",
    credito: "bool?",
    facturacionMovil: "bool?",
    listaPrecio: "int?",
    domicilio: "string?",
    idEmpresa: "int?",
    fechaAct: "date?",
    syncedAt: "date",
    syncedAr: "date?",
  },
  primaryKey: "id",
};

// Esquema para controlar el estado de sincronización
export const SyncStatusSchema = {
  name: "SyncStatus",
  properties: {
    id: "string",
    lastSyncDate: "date?",
    totalRecords: "int?",
    status: "string?", // 'completed', 'in_progress', 'failed'
  },
  primaryKey: "id",
};

export const SyncLogSchema = {
  name: "SyncLog",
  properties: {
    id: "string", // UUID único
    fechaInicio: "date", // Fecha y hora de inicio
    fechaFinal: "date?", // Fecha y hora de finalización
    exitoso: "bool", // Si fue exitoso o no
    razon: "string?", // Razón específica si falló
    usuario: "string?", // Usuario que ejecutó la sincronización
    ruta: "string?", // Ruta/endpoint de la API
    sucursal: "int?", // Sucursal sincronizada
    totalRegistros: "int?", // Total de registros sincronizados
    duracionMs: "int?", // Duración en milisegundos
    tipo: "string?", // 'manual' o 'automatica'
    detalles: "string?", // JSON con detalles adicionales
  },
  primaryKey: "id",
};

/**
 * Schema para logs de sincronización por tabla
 * Registra cada sincronización individual con detalles específicos
 */
export const SyncTableLogSchema = {
  name: "SyncTableLog",
  properties: {
    id: "string", // UUID único
    syncLogId: "string", // Referencia al SyncLog principal
    tabla: "string", // Nombre de la tabla sincronizada
    fechaInicio: "date", // Fecha y hora de inicio de esta tabla
    fechaFinal: "date?", // Fecha y hora de finalización
    exitoso: "bool", // Si fue exitoso o no
    razon: "string?", // Razón específica si falló
    registrosLeidos: "int?", // Total de registros leídos de la API
    registrosGuardados: "int?", // Total de registros guardados en Realm
    registrosActualizados: "int?", // Total de registros actualizados
    duracionMs: "int?", // Duración en milisegundos
    endpoint: "string?", // Endpoint específico de esta tabla
    detalles: "string?", // JSON con detalles adicionales
    tipoConexion: "string?", // 'wifi', 'cellular', 'none', 'unknown'
    intensidadSenal: "int?", // Intensidad de señal (0-4 para cellular, 0-100 para wifi)
    velocidadDescarga: "double?", // Velocidad de descarga en Mbps
    velocidadSubida: "double?", // Velocidad de subida en Mbps
  },
  primaryKey: "id",
};

export const CierreRutaSchema = {
  name: "CierreRuta",
  properties: {
    id: "string",
    sucursal: "int?",
    vendedor: "int?",
    fechaCierre: "date?",
    rutaCerrada: "bool",
    updatedAt: "date",
    enviado: "bool?",
  },
  primaryKey: "id",
};

export const VisitaSchema = {
  name: "Visita",
  properties: {
    id: "string", // Ahora es compuesto: "idOriginal-fecha"
    idOriginal: "int", // ID original del servidor
    idCliente: "int",
    ruta: "string",
    fecha: "date",
    orden: "int",
    tipo: "int",
    visitado: "int",
    syncedAr: "string?",
  },
  primaryKey: "id",
};

export const DetalleVisitasSchema = {
  name: "DetalleVisitas",
  properties: {
    id: "string",
    fechaInicio: "date?",
    fechaFin: "date?",
    idCliente: "int?",
    idUsuario: "int?",
    idRuta: "int?",
    tipoVisita: "int?",
    agenda: "int?",
    conCobertura: "bool?", // true = había datos al registrar, false = sin cobertura, null = no aplica
    syncedAt: "date",
    sincronizado: { type: "bool", default: false },
  },
  primaryKey: "id",
};

export const TipoVisitaSchema = {
  name: "TipoVisita",
  properties: {
    id: "int",
    descripcion: "string?",
  },
  primaryKey: "id",
};

export const BitacoraSyncSchema = {
  name: "BitacoraSync",
  properties: {
    idBitacoraMovil: "string", // Primary key
    tabla: "string",
    fechaInicio: "date",
    duracionMs: "int?",

    // Contexto Usuario
    idUsuario: "int?",

    // Contexto App
    versionApp: "string?",
    endpoint: "string?",

    // Resultados
    exitoso: "bool",
    registrosLeidos: "int?",

    // Errores
    codigoError: "string?",
    descripcionError: "string?",
    stackTrace: "string?",

    // Estado de envío
    enviado: "bool",
  },
  primaryKey: "idBitacoraMovil",
};

/**
 * Schema para bitácora de posiciones GPS del usuario.
 * Guarda cada lectura de ubicación para debugging y trazabilidad.
 */
export const BitacoraGpsSchema = {
  name: "BitacoraGps",
  properties: {
    id: "string", // idLocal determinista por ventana: `${idUsuario}-${Math.floor(ts / intervalMs)}`
    idUsuario: "int",
    sucursal: "int",
    latitud: "float",
    longitud: "float",
    precision: "float?", // Precisión GPS en metros
    bateria: "float?", // Metros permitidos para validación del usuario
    conCobertura: "bool?", // true = había red al capturar, false = offline, null = no evaluado
    id_movil: "int?",
    fecha: "date", // Hora en que se toma el GPS
    enviado: "bool", // true = ya sincronizado al servidor
  },
  primaryKey: "id",
};

/**
 * Schema para diagnóstico de validaciones de ubicación.
 * Guarda UNA fila por cada intento de validación (LocationService.validarUbicacionCliente)
 * para poder analizar en el servidor por qué falla una visita en campo.
 */
export const BitacoraValidacionSchema = {
  name: "BitacoraValidacion",
  properties: {
    id: "string", // idLocal determinista por ventana para recorrido; timestamp-random para validaciones de cliente
    idUsuario: "int",
    sucursal: "int",
    idCliente: "int?",
    motivo: "string", // ok | ok_cache | sin_permiso | sin_senal | precision_baja | fuera_de_rango | red_no_gnss
    valido: "bool",
    distancia: "float?", // metros medidos al cliente
    accuracy: "float?", // precisión (±m) del mejor fix
    metrosPermitidos: "float?",
    latitud: "float?", // posición del vendedor (mejor fix)
    longitud: "float?",
    clienteLatitud: "float?",
    clienteLongitud: "float?",
    numFixes: "int?", // cuántos fixes recibió watchPosition
    peorAccuracy: "float?", // peor precisión vista en la sesión
    tiempoMs: "int?", // ms que tardó en resolver la ubicación
    conCobertura: "bool?",
    id_movil: "int?",
    plataforma: "string?", // android | ios
    versionApp: "string?",
    fecha: "date",
    enviado: "bool", // true = ya sincronizado al servidor
  },
  primaryKey: "id",
};

/**
 * Schema para tracking periódico de ubicación del vendedor (BackgroundLocationService).
 * Guarda una fila por cada ventana de tiempo (~30s) con la posición del vendedor.
 * Es una tabla aparte de BitacoraGps (fixes puntuales) y BitacoraValidacion
 * (diagnóstico de validaciones de visita a cliente) para no mezclar volumes.
 */
export const BitacoraTrackingGpsSchema = {
  name: "BitacoraTrackingGps",
  properties: {
    id: "string", // idLocal determinista por ventana: `${idUsuario}-${Math.floor(ts / intervalMs)}`
    idUsuario: "int",
    sucursal: "int",
    latitud: "float",
    longitud: "float",
    precision: "float?", // precisión GPS en metros
    conCobertura: "bool?", // true = había red al capturar, false = offline, null = no evaluado
    fecha: "date",
    enviado: "bool", // true = ya sincronizado al servidor
  },
  primaryKey: "id",
};

/**
 * Schema para bitácora de tiempos del cierre de venta.
 * Guarda UNA fila por cada venta procesada (SalesScreen.processSale)
 * para medir en el servidor cuánto tarda cada etapa del cierre
 * (GPS, impresión, guardado local, post-venta) y detectar cuellos de botella.
 */

export const BitacoraTiemposVentaSchema = {
  name: "BitacoraTiemposVenta",
  properties: {
    id: "string", // UUID único: timestamp-random
    idUsuario: "int",
    sucursal: "int",
    idCliente: "int?",
    idMovil: "int?", // id_movil de la venta generada
    gpsFuente: "string?", // cache_visita | cache_prefetch | cache_venta | paralelo | sin_gps
    gpsMs: "int?", // ms que el cierre se detuvo esperando el GPS (0 si vino de cache)
    impresionMs: "int?", // ms del bloque de impresión de ticket (incluye reconexión BT)
    guardadoVentaMs: "int?", // ms de createLocalVentas (escritura Realm)
    postVentaMs: "int?", // ms de envases + inventario + marcar visita
    totalMs: "int?", // ms totales del cierre (processSale completo)
    items: "int?", // productos en el carrito
    dobleTicket: "bool?",
    ticketImpreso: "bool?",
    conCobertura: "bool?",
    plataforma: "string?", // android | ios
    versionApp: "string?",
    fecha: "date",
    enviado: "bool", // true = ya sincronizado al servidor
  },
  primaryKey: "id",
};

export const InventarioEnvaseSchema = {
  name: "InventarioEnvase",
  properties: {
    id: "string",
    sucursal: "int?",
    claveProd: "int?",
    folioMovto: "int?",
    cantidadEntrada: "float?",
    cantidadSalida: "float?",
    costo: "float?",
    tipoMovto: "int?",
    fechaAlta: "date?",
    fechaAct: "date?",
    idMovil: "int?",
    observacion: "string?",
    syncedAt: "date",
  },
  primaryKey: "id",
};

export const InventarioEnvasesHistorialSchema = {
  name: "InventarioEnvasesHistorial",
  properties: {
    id: "int",
    sucursal: "int?",
    almacen: "int?",
    claveProd: "int?",
    descripcionCorta: "string?",
    fechaMovto: "date?",
    folioMovto: "int?",
    cantidadEntrada: "float?",
    cantidadSalida: "float?",
    tipoMovto: "int?",
    idMovil: "int?",
    syncedAt: "date",
  },
  primaryKey: "id",
};

export const ReubicacionSchema = {
  name: "Reubicacion",
  properties: {
    id: "int",
    idCliente: "int",
    sucursal: "int?",
    latitud: "double?",
    longitud: "double?",
    latitudAnterior: "double?",
    longitudAnterior: "double?",
    accuracy: "double?",
    numFixes: "int?",
    metrosMovidos: "double?",
    fecha: "date?",
    idUsuario: "int?",
    syncedAt: "date",
    enviado: "bool",
  },
  primaryKey: "id",
};

export const VisitaRealizadaSchema = {
  name: "VisitaRealizada",
  properties: {
    id: "int",
    fechaInicio: "date",
    fechaFin: "date",
    idCliente: "int",
    idUsuario: "int",
    idRuta: "int",
    syncedAt: "date",
  },
  primaryKey: "id",
};

/**
 * Configuración local de ruta y GPS.
 * Inicialmente se maneja en el móvil; en el futuro puede venir del servidor.
 */
export const RouteConfigSchema = {
  name: "RouteConfig",
  properties: {
    id: "string", // clave fija: "routeConfig"
    idUsuario: "int?",
    sucursal: "int?",
    intervaloGPS: "int", // segundos entre capturas (default 30, min 15, max 300)
    radioTolerancia: "int", // metros para validación geoposición (default 100)
    rutaActiva: { type: "bool" as const, default: false }, // true = inicio de ruta activo
    fechaInicioRuta: "date?",
    fechaFinRuta: "date?",
    updatedAt: "date",
  },
  primaryKey: "id",
};

export const FormaPagoSchema = {
  name: "FormaPago",
  properties: {
    tipo: "int",
    sucursal: "int?",
    descripcion: "string?",
    grupoOperacion: "int?",
    tarjeta: "bool?",
    cuentaBancaria: "string?",
    pago0: "bool?",
    credito: "bool?",
    syncedAt: "date",
  },
  primaryKey: "tipo",
};

export const CiaSchema = {
  name: "Cia",
  properties: {
    id: "int",
    telefono: "string?",
    rfc: "string?",
    domicilio: "string?",
    regimenFiscal: "string?",
    nombreCia: "string?",
    syncedAt: "date",
  },
  primaryKey: "id",
};

export const VentaCancelacionSchema = {
  name: "VentaCancelacion",
  properties: {
    id: "string",
    sucursal: "int?",
    noVenta: "int?",
    caja: "int?",
    idMovil: "int?",
    usuarioCancela: "int?",
    fechaCancela: "date?",
    motivoCancelacion: "string?",
    latitud: "double?",
    longitud: "double?",
    fechaAlta: "date",
    enviado: "bool",
  },
  primaryKey: "id",
};

export const VentaModificacionSchema = {
  name: "VentaModificacion",
  properties: {
    id: "string",
    sucursal: "int?",
    noVenta: "int?",
    caja: "int?",
    idMovil: "int?",
    claveProd: "int?",
    nombreProducto: "string?",
    cantidadAnterior: "float?",
    cantidadNueva: "float?",
    usuarioModifica: "int?",
    fechaModifica: "date?",
    motivoModificacion: "string?",
    latitud: "double?",
    longitud: "double?",
    fechaAlta: "date",
    enviado: "bool",
  },
  primaryKey: "id",
};

export const PedidoSchema = {
  name: "Pedido",
  properties: {
    id: "string", // PK compuesta: `${folio}-${idProducto}`
    idPedido: "int?", // folio del pedido
    id_movil: "int?",
    folio: "int",
    fecha: "date?",
    ruta: "int",
    cliente: "int",
    clienteNombre: "string?",
    clienteDomicilio: "string?",
    idCanal: "int?",
    fechaAtencion: "date?",
    idVendedor: "int",
    numeroProductos: "int",
    cantPedido: "float",
    listaPrecio: "int?",
    fechaEntrega: "date?",
    estatus: "int",
    estatusDescripcion: "string?",
    fueraAgenda: "bool?",
    observaciones: "string?",
    no_venta: "int?",
    tieneDiferencia: "bool?",
    causaNoAtencion: "int?",
    obserNoAtencion: "string?",
    syncedAt: "date",
    syncedAr: "date?",
    modificadoLocal: "bool?",
    // Campos del producto (detalle del pedido en la misma tabla)
    idProducto: "int",
    productoNombre: "string?",
    cantAtencion: "float?",
    precio: "float?",
    precioAtencion: "float?",
    causaDiferencia: "int?",
    causaDiferenciaDesc: "string?",
    obserDiferencia: "string?",
    atendido: "bool?",
  },
  primaryKey: "id",
};

export const PedidoBitacoraSchema = {
  name: "PedidoBitacora",
  properties: {
    id: "string",
    idPedido: "int",
    id_movil: "int?",
    folio: "int",
    fecha: "date",
    ruta: "int",
    cliente: "int",
    idCanal: "int?",
    fechaAtencion: "date?",
    idVendedor: "int",
    idProducto: "int?",
    cantPedido: "float?",
    precio: "float?",
    observaciones: "string?",
    listaPrecio: "int?",
    fechaEntrega: "date?",
    estatus: "int",
    estatusAnterior: "int?",
    cantAtencion: "float?",
    precioAtencion: "float?",
    causaDiferencia: "int?",
    obserDiferencia: "string?",
    causaNoAtencion: "int?",
    obserNoAtencion: "string?",
    usrAlta: "int?",
    fueraAgenda: "bool?",
    no_venta: "int?",
    tipoCambio: "string?",
    enviado: "bool",
  },
  primaryKey: "id",
};

export const PedidoEstadoSchema = {
  name: "PedidoEstado",
  properties: {
    id: "string",
    ruta: "int",
    pedido: "int",
    fecha: "date",
    estado: "int",
    idVendedor: "int",
    enviado: "bool",
  },
  primaryKey: "id",
};

export const CatalogoEstatusPedidoSchema = {
  name: "CatalogoEstatusPedido",
  properties: {
    id: "int",
    descripcion: "string?",
  },
  primaryKey: "id",
};

export const CatalogoCausaDiferenciaSchema = {
  name: "CatalogoCausaDiferencia",
  properties: {
    id: "int",
    descripcion: "string?",
  },
  primaryKey: "id",
};

export const CatalogoCausaNoAtencionSchema = {
  name: "CatalogoCausaNoAtencion",
  properties: {
    id: "int",
    descripcion: "string?",
  },
  primaryKey: "id",
};

export const ClienteFotoSchema = {
  name: "ClienteFoto",
  properties: {
    id: "string",
    idServidor: "int?",
    idMovil: "string",
    idCliente: "int",
    foto: "string?", // URI local del dispositivo
    fotoMiniatura: "string?", // URI local de miniatura, si existe
    fotoServidor: "string?", // Ruta física devuelta por el servidor
    fotoMiniaturaServidor: "string?", // Ruta física de miniatura en servidor
    fotoBase64: "string?",
    fotoMiniaturaBase64: "string?",
    mimeType: "string?",
    miniaturaMimeType: "string?",
    nombreArchivo: "string?",
    etiqueta: "string?",
    fechaCaptura: "date?",
    fechaLog: "date?",
    activa: { type: "bool" as const, default: true },
    estado: "string", // pendiente | sincronizando | sincronizada | error
    errorMensaje: "string?",
    syncedAt: "date?",
  },
  primaryKey: "id",
};

export const allSchemas = [
  VentaSchema,
  UsuarioSchema,
  ProductoSchema,
  CiaSchema,
  KitSchema,
  KitIntercambioSchema,
  PrecioSchema,
  PrecioPromoSchema,
  InventarioSchema,
  CarteraSchema,
  ClienteFullSchema,
  SyncStatusSchema,
  SyncLogSchema,
  SyncTableLogSchema,
  CierreRutaSchema,
  VisitaSchema,
  DetalleVisitasSchema,
  TipoVisitaSchema,
  BitacoraSyncSchema,
  BitacoraGpsSchema,
  BitacoraValidacionSchema,
  BitacoraTrackingGpsSchema,
  BitacoraTiemposVentaSchema,
  InventarioEnvaseSchema,
  InventarioEnvasesHistorialSchema,
  ReubicacionSchema,
  VisitaRealizadaSchema,
  VentaCancelacionSchema,
  VentaModificacionSchema,
  RouteConfigSchema,
  FormaPagoSchema,
  PedidoSchema,
  PedidoBitacoraSchema,
  PedidoEstadoSchema,
  CatalogoEstatusPedidoSchema,
  CatalogoCausaDiferenciaSchema,
  CatalogoCausaNoAtencionSchema,
  ClienteFotoSchema,
];
