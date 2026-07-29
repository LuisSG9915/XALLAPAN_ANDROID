-- =============================================================================
-- SISTEMA: ANALÍTICA DE RECORRIDO DE VENDEDORES
-- Tabla base: BitacoraValidacionUbicacionMovil (motivo LIKE 'recorrido%')
-- =============================================================================

endpoints:
nota importante, si requiere sucursal o algun parametro que viene de api, entonces ver de donde se toma los datos

paso base: curl -X 'GET' \
  'https://api.cbinformatica.net:9031/api/Recorrido/sp_RecorridoVendedorDia?idUsuario=0&sucursal=0&fecha=2026-07-27' \
  -H 'accept: application/octet-stream'
GET
/api/Recorrido/sp_RecorridoPosicionesActuales



GET
/api/Recorrido/sp_RecorridoResumenDiario



GET
/api/Recorrido/sp_RecorridoActividadPorHora



GET
/api/Recorrido/sp_RecorridoPrecisionGPS



GET
/api/Recorrido/sp_RecorridoSinCobertura



GET
/api/Recorrido/sp_RecorridoResumenCobertura



GET
/api/Recorrido/sp_RecorridoHeatmapSinCobertura



GET
/api/Recorrido/sp_RecorridoResumenSucursal



GET
/api/Recorrido/sp_RecorridoValidacionRuta



GET
/api/Recorrido/sp_RecorridoCoberturaClientes



GET
/api/Recorrido/sp_RecorridoPlayback



GET
/api/Recorrido/sp_RecorridoPlaybackPuntos

=============================================================================
PLAN DE TRABAJO — WEB DE RECORRIDO DE VENDEDORES
=============================================================================

El sistema se compone de 5 módulos frontend + 1 API backend que consume los
procedimientos almacenados. Cada módulo es una pantalla independiente.


-----------------------------------------------------------------------------
MÓDULO 1 — MAPA DE RECORRIDO (vista principal)
-----------------------------------------------------------------------------
Descripción:
  Mapa interactivo (Google Maps / Leaflet) con la ruta trazada del vendedor.
  Se diferencian los puntos por color según tipo de registro GPS.

Funcionalidades:
  - Selector de vendedor, sucursal y fecha (filtros de la pantalla).
  - Línea poligonal conectando los puntos GPS en orden cronológico.
  - Íconos de color por tipo:
      * app en foreground  -> azul
      * pantalla encendida -> verde
      * pantalla apagada   -> gris
  - Tooltip al hacer clic en un punto: hora, accuracy, cobertura.
  - Playback animado: botón "Reproducir" que recorre la ruta acelerada.

Llamadas al backend:
  GET /api/recorrido/ruta?idUsuario=&sucursal=&fecha=
    -> ejecuta sp_RecorridoVendedorDia
    -> devuelve array de puntos {fecha, latitud, longitud, motivo,
                                 accuracy, conCobertura, numeroFila}

  GET /api/recorrido/playback?idUsuario=&sucursal=&fecha=&intervaloSegundos=30
    -> ejecuta sp_RecorridoPlayback
    -> devuelve array de segmentos agrupados {segmento, fecha, latitud,
        longitud, accuracy, puntosEnSegmento, motivos, conCobertura}

Tecnologías sugeridas: Leaflet.js + leaflet-playback o Google Maps + setInterval


-----------------------------------------------------------------------------
MÓDULO 2 — PANEL DE ACTIVIDAD
-----------------------------------------------------------------------------
Descripción:
  Dashboard de métricas del día para un vendedor. Resumen de tiempos,
  distancias, cobertura y calidad GPS.

Funcionalidades:
  - Tarjetas superiores (KPI cards):
      * Hora inicio / Hora fin
      * Distancia total recorrida (km)
      * Tiempo en ruta (horas)
      * % de cobertura celular
      * Paradas detectadas (>5 min en mismo lugar)
      * Precisión GPS promedio

  - Gráfica de barras: actividad por hora del día (eje X: hora, eje Y: puntos GPS),
    con stacks de colores: app activa / pantalla on / pantalla off / sin cobertura.

  - Tabla de paradas detectadas: hora inicio, duración, coordenadas.

Llamadas al backend:
  GET /api/recorrido/resumen?idUsuario=&sucursal=&fecha=
    -> ejecuta sp_RecorridoResumenDiario
    -> devuelve {horaInicio, horaFin, minutosEnRuta, distanciaTotalMetros,
                 pctCobertura, accuracyPromedio, paradasDetectadas,
                 tiempoTotalParadasMin}

  GET /api/recorrido/actividad-hora?idUsuario=&sucursal=&fecha=
    -> ejecuta sp_RecorridoActividadPorHora
    -> devuelve array [{hora, puntosGPS, tramosApp, tramosPantallaOn,
                        tramosPantallaOff, conCobertura, sinCobertura,
                        accuracyPromedio}]

Tecnologías sugeridas: Chart.js o ApexCharts para la gráfica de barras apiladas.


-----------------------------------------------------------------------------
MÓDULO 3 — CALIDAD DE GPS
-----------------------------------------------------------------------------
Descripción:
  Reporte que identifica zonas y horas con mala precisión de GPS, para saber
  dónde el posicionamiento es poco confiable.

Funcionalidades:
  - Tabla principal con todos los puntos GPS del día, coloreados por
    clasificación: Excelente (verde), Buena (amarillo), Regular (naranja),
    Mala (rojo).

  - Filtro deslizante de umbral de accuracy (default 30m).

  - Gráfica de resumen por hora: accuracy mínima, máxima, promedio,
    % de puntos malos.

  - Mapa pequeño con puntos rojos donde accuracy > umbral.

Llamadas al backend:
  GET /api/recorrido/precision?idUsuario=&sucursal=&fecha=&umbralAccuracy=30
    -> ejecuta sp_RecorridoPrecisionGPS
    -> devuelve 2 conjuntos:
         [0] listado de puntos con clasificación
         [1] resumen por hora

Tecnologías sugeridas: misma tabla + mapa del Módulo 1, reutilizar componentes.


-----------------------------------------------------------------------------
MÓDULO 4 — COBERTURA DE RED
-----------------------------------------------------------------------------
Descripción:
  Diagnóstico de conectividad celular durante el recorrido. Identifica zonas
  muertas donde el vendedor queda sin señal.

Funcionalidades:
  - Mapa de calor: zonas agrupadas sin cobertura, tamaño del círculo
    proporcional a la cantidad de puntos en esa zona.

  - Resumen diario por vendedor: % cobertura, número de rachas sin cobertura,
    duración máxima de racha sin cobertura.

  - Tabla detalle de rachas: hora inicio, hora fin, duración, coordenadas
    de inicio/fin.

Llamadas al backend:
  GET /api/recorrido/sin-cobertura?sucursal=&fechaDesde=&fechaHasta=
    -> ejecuta sp_RecorridoSinCobertura
    -> devuelve array [{idUsuario, fecha, latitud, longitud, accuracy}]

  GET /api/recorrido/resumen-cobertura?sucursal=&fechaDesde=&fechaHasta=
    -> ejecuta sp_RecorridoResumenCobertura
    -> devuelve array [{idUsuario, dia, pctCobertura, rachasSinCobertura,
                        rachaMaxSinCoberturaMin}]

  GET /api/recorrido/heatmap-cobertura?sucursal=&fechaDesde=&fechaHasta=&precision=4
    -> ejecuta sp_RecorridoHeatmapSinCobertura
    -> devuelve array [{lat, lng, cantidadPuntos, vendedoresAfectados}]

Tecnologías sugeridas: Leaflet.heat o heatmap.js para el mapa de calor.


-----------------------------------------------------------------------------
MÓDULO 5 — VISIÓN SUPERVISOR (resumen de sucursal)
-----------------------------------------------------------------------------
Descripción:
  Vista consolidada para el supervisor: todos los vendedores de la sucursal
  en un solo vistazo el día de hoy.

Funcionalidades:
  - Tabla resumen: una fila por vendedor con:
      * Hora inicio / fin
      * Horas en ruta
      * Km recorridos
      * % cobertura
      * Accuracy promedio
      * Zona más visitada (coordenadas)

  - Al hacer clic en una fila, redirige al Módulo 1 (mapa) de ese vendedor.

  - Indicadores visuales de alerta:
      * Ícono rojo si % cobertura < 50%
      * Ícono naranja si accuracy promedio > 30m

Llamadas al backend:
  GET /api/recorrido/resumen-sucursal?sucursal=&fecha=
    -> ejecuta sp_RecorridoResumenSucursal
    -> devuelve array [{idUsuario, horaInicio, horaFin, horasEnRuta,
                        puntosGPS, distanciaKm, accuracyPromedio,
                        pctCobertura, zonaMasVisitada}]


-----------------------------------------------------------------------------
MÓDULO 6 — VALIDACIÓN DE RUTA (visita vs GPS)
-----------------------------------------------------------------------------
Descripción:
  Cruza los intentos de validación de visita a cliente con el GPS del
  recorrido para verificar que el vendedor realmente estuvo cerca.

Funcionalidades:
  - Tabla de clientes visitados en el día con:
      * Nombre del cliente
      * Intentos totales / válidos / inválidos
      * Distancia medida (mín, máx, promedio)
      * Tolerancia configurada (metrosPermitidos)
      * Check verde/rojo si la visita se concretó
      * Indicador: ¿el GPS del recorrido pasó a ≤100m del cliente?

  - Detalle por cliente: al expandir una fila se ven todos los intentos
    individuales con su resultado (ok / fuera_de_rango / sin_señal / etc.)

  - Reporte consolidado: todos los vendedores vs clientes del día.

Llamadas al backend:
  GET /api/recorrido/validacion-ruta?idUsuario=&sucursal=&fecha=
    -> ejecuta sp_RecorridoValidacionRuta
    -> devuelve array [{idCliente, nombreCliente, totalIntentos,
                        intentosValidos, distanciaMin, metrosPermitidos,
                        aprobado, pasoCerca, motivoUltimo}]

  GET /api/recorrido/cobertura-clientes?sucursal=&fecha=
    -> ejecuta sp_RecorridoCoberturaClientes
    -> devuelve array [{idUsuario, idCliente, nombreCliente, totalIntentos,
                        intentosOk, intentosFueraRango, seConcretoVisita}]


-----------------------------------------------------------------------------
API BACKEND — ENDPOINTS Y ESTRUCTURA
-----------------------------------------------------------------------------
Tecnología: .NET Web API / Node.js + Express / PHP — según stack actual.

Todos los endpoints usan GET con query params. El backend se limita a:
  1. Recibir parámetros del query string.
  2. Ejecutar el stored procedure correspondiente.
  3. Devolver el resultset como JSON.
  4. Manejar errores (500 con mensaje descriptivo).

No se necesita lógica de negocio en backend. Todo el cálculo está en SQL.

CORS: habilitar para que el frontend consuma desde cualquier origen en desarrollo.

Autenticación: usar el mecanismo existente del sistema (token JWT / sesión).


-----------------------------------------------------------------------------
CRONOGRAMA SUGERIDO (5 días)
-----------------------------------------------------------------------------

  Día 1 — Backend
    - Crear controlador/rutas con los 10 endpoints del plan.
    - Probar con Postman que cada SP devuelva JSON correcto.

  Día 2 — Módulos 1 y 2 (Mapa + Panel de Actividad)
    - Componente de mapa base con Leaflet.
    - Selectores de filtro (vendedor, sucursal, fecha).
    - Playback animado de ruta.
    - Tarjetas KPI + gráfica de barras por hora.

  Día 3 — Módulos 3 y 4 (Precisión GPS + Cobertura)
    - Tabla de calidad GPS con colores por clasificación.
    - Mapa de calor de zonas sin cobertura.
    - Gráfica de accuracy por hora.

  Día 4 — Módulos 5 y 6 (Supervisor + Validación)
    - Tabla resumen de sucursal con navegación a detalle.
    - Tabla de validación de visitas con expand/collapse.
    - Indicadores de alerta visuales.

  Día 5 — Integración, pruebas y despliegue
    - Navegación entre módulos.
    - Responsive design (tablet para supervisores en campo).
    - Pruebas con datos reales de un día completo.


-----------------------------------------------------------------------------
NAVEGACIÓN ENTRE MÓDULOS
-----------------------------------------------------------------------------

  [Selector Global: Sucursal | Fecha | Vendedor]
      |
      +-- MÓDULO 5: Resumen Sucursal (vista supervisor, tabla de vendedores)
      |       |
      |       +-- click en vendedor -> MÓDULO 1 (mapa de ese vendedor)
      |
      +-- MÓDULO 1: Mapa del Recorrido (vista principal)
      |       |
      |       +-- pestaña "Actividad"  -> MÓDULO 2
      |       +-- pestaña "GPS"        -> MÓDULO 3
      |       +-- pestaña "Cobertura"  -> MÓDULO 4
      |
      +-- MÓDULO 6: Validación de Ruta

  Sugerencia: implementar como SPA (Single Page Application) con pestañas
  o sidebar de navegación. Los filtros (sucursal, fecha, vendedor) se
  mantienen en un header persistente.
