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
    sucursalOrigen: "int?",
    metros: "float?",
    syncedAt: "date",
  },
  primaryKey: "id",
};

export const ProductoSchema = {
  name: "Producto",
  properties: {
    id: "int",
    claveProd: "string?",
    descripcion: "string?",
    esKit: "bool?",
    envaseRecibe: "bool?",
    fechaAct: "date?",
    syncedAt: "date",
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
    syncedAt: "date",
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
    tipoSync: "string", // "incremental" | "full"
    fechaInicio: "date",
    fechaFinal: "date?",
    duracionMs: "int?",

    // Contexto Usuario
    idUsuario: "int?",
    nombreUsuario: "string?",
    sucursal: "int?",

    // Contexto Dispositivo
    ipDispositivo: "string?",
    nombreDispositivo: "string?",
    sistemaOperativo: "string?",
    versionApp: "string?",

    // Contexto Red
    tipoConexion: "string?", // "wifi", "cellular", "none", "unknown"
    tipoConexionDetallado: "string?", // "2g", "3g", "4g", "5g", etc.
    estadoConexion: "int?", // 1 = conectado, 0 = desconectado
    intensidadSenal: "int?",
    velocidadDescargaMbps: "double?",
    velocidadCargaMbps: "double?",
    latenciaMs: "int?",
    esConexionMetered: "bool?",

    // Contexto App
    appState: "string?", // "active", "background", "inactive"
    origenSync: "string?", // "manual" | "background"
    endpoint: "string?",
    detallesJSON: "string?",

    // Resultados
    exitoso: "bool",
    registrosLeidos: "int?",
    registrosGuardados: "int?",
    registrosActualizados: "int?",
    registrosEliminados: "int?",

    // Errores
    error: "string?",
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
    id: "string", // UUID único: timestamp-random
    idUsuario: "int",
    sucursal: "int",
    latitud: "float",
    longitud: "float",
    precision: "float?", // Precisión GPS en metros
    bateria: "float?", // Metros permitidos para validación del usuario
    id_movil: "int?",
    fecha: "date", // Hora en que se toma el GPS
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

export const ALL_SCHEMAS = [
  VentaSchema,
  UsuarioSchema,
  ProductoSchema,
  KitSchema,
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
  InventarioEnvaseSchema,
];
