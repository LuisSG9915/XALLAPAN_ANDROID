/* =====================================================================================
   DIAGNOSTICO PUNTUAL - "Sin senal GPS" (motivo = sin_senal, 0 fixes)
   Caso reportado: 2026-10-23, 11:10-11:15, usuario/sucursal 2083.
   Reporte de campo: "sucede cuando hay poca o nula cobertura".

   Contexto y resultado del caso: docs/CASO_2026-10-23_1052_SIN_SENAL.md

   SOLO LECTURA: no inserta, no actualiza, no borra nada.

   QUE HACE
     Cruza las dos bitacoras del movil para esa ventana:
       - BitacoraValidacionUbicacionMovil : el intento de validacion (motivo, numFixes,
         tiempoMs, accuracy, conCobertura, retraso de subida).
       - BitacoraTrackingGpsMovil         : los pings de fondo cada ~30 s (precision,
         conCobertura, huecos entre pings, retraso de subida).
     y aplica las MISMAS reglas que la app (services/LocationService.ts):
       - evidencia ok_tracking : fix con precisionM <= 25 m en los 5 min previos y dentro del rango;
       - veto                  : fix con precisionM <= 30 m en los 2 min previos y a mas de
                                 rango + 30 m (I6 del PLAN_OK_TRACKING);
       - sin_senal             : 0 fixes en la ventana de 6 s de getBestLocation.

   COMO SE EJECUTA
     Como UN SOLO lote (sin GO en medio): hay variables y tablas temporales.
     Ajustar @caso / @desde / @hasta si se quiere repetir para otro caso.

   QUE RESPONDE CADA RESULTADO
     R0  quien es 2083 (idUsuario vs sucursal) y si hay datos ese dia.
     R1  panorama por usuario en la ventana: intentos, motivos, red, pings y huecos.
     R2  detalle de cada intento de validacion, con una columna "lectura" en espanol.
     R3  linea de tiempo de ~21 min: validaciones + pings, con los huecos marcados.
     R4  veredicto por intento: habia evidencia para aprobar por tracking?, hubo veto?,
         el fallo es de cobertura o de inanicion del receptor?
     R5  (opcional, comentado) patron del dia por hora: % sin red y retraso de subida.

   NOTAS PARA LEER LOS NUMEROS
     - Horas locales del dispositivo (mismo huso que el servidor). fechaRegistroServidor =
       hora del servidor; si el reloj del telefono esta mal, el retraso se distorsiona.
     - Retraso de subida esperado: tracking <= 30 s (sube cada 30 s mientras el servicio vive);
       validaciones 0-3 min en primer plano y hasta ~15 min con BackgroundFetch.
       Mas de 15 min = cola offline real.
     - "sin_senal" significa 0 callbacks del GPS en la ventana de 6 s. NO significa por si
       mismo "sin cobertura": eso lo dice conCobertura (BIT) en cada fila.
     - conCobertura = 1 significa "el SO reporta red", no que la red tenga Internet. Si la
       subida llega muy retrasada con conCobertura = 1, la red reportada no servia.
     - 2083 puede ser idUsuario o sucursal: el filtro incluye ambos y R0 lo desambigua.
       Si trae varios vendedores y solo interesa uno, poner @soloUsuario = <idUsuario>.
     - Si no aparece la fila del caso, ampliar @desde/@hasta +/- 10 min: el reloj del equipo
       puede estar desfasado respecto al servidor.

   TRAMPAS YA CONOCIDAS EN ESTE REPO (respetadas aqui)
     - Nada de DATEDIFF en predicados de fecha sobre BitacoraTrackingGpsMovil (1.1 M filas):
       se usan rangos >= / <= sargables.
     - geography::Point revienta con NULL: solo se usa sobre #val_geo / #trk_geo, ya filtradas.
     - En los JOIN espaciales no se usan expresiones con referencias externas dentro de agregados.
   ===================================================================================== */

SET NOCOUNT ON;

DECLARE @caso        INT      = 2083;                   -- numero del encabezado de la app (usuario O sucursal)
DECLARE @soloUsuario INT      = NULL;                   -- ej. 1052 para acotar a un vendedor; NULL = todos
DECLARE @desde       DATETIME = '2026-10-23T11:10:00';  -- ventana reportada, hora local
DECLARE @hasta       DATETIME = '2026-10-23T11:15:00';

DECLARE @ctxDesde DATETIME = DATEADD(MINUTE, -60, @desde);  -- contexto para huecos entre pings
DECLARE @ctxHasta DATETIME = DATEADD(MINUTE,  60, @hasta);
DECLARE @tlDesde  DATETIME = DATEADD(MINUTE,  -8, @desde);  -- ventana de la linea de tiempo
DECLARE @tlHasta  DATETIME = DATEADD(MINUTE,   8, @hasta);
DECLARE @diaDesde DATETIME = CAST(CAST(@desde AS DATE) AS DATETIME);
DECLARE @diaHasta DATETIME = DATEADD(DAY, 1, @diaDesde);

/* ------------------------------------------------------------------------------------
   Materializacion
   ------------------------------------------------------------------------------------ */

IF OBJECT_ID('tempdb..#val') IS NOT NULL DROP TABLE #val;

SELECT b.id, b.idUsuario, b.sucursal, b.idCliente, b.fecha,
       b.motivo, b.valido, b.distancia, b.accuracy, b.metrosPermitidos,
       b.numFixes, b.peorAccuracy, b.tiempoMs, b.conCobertura,
       b.fechaRegistroServidor, b.plataforma, b.versionApp,
       TRY_CAST(b.latitud AS FLOAT) AS lat, TRY_CAST(b.longitud AS FLOAT) AS lng,
       TRY_CAST(b.clienteLatitud AS FLOAT) AS clat, TRY_CAST(b.clienteLongitud AS FLOAT) AS clng
INTO #val
FROM dbo.BitacoraValidacionUbicacionMovil b
WHERE b.fecha >= @desde
  AND b.fecha <= @hasta
  AND (b.idUsuario = @caso OR b.sucursal = @caso)
  AND (@soloUsuario IS NULL OR b.idUsuario = @soloUsuario);

IF OBJECT_ID('tempdb..#trk') IS NOT NULL DROP TABLE #trk;

SELECT t.id, t.idUsuario, t.sucursal, t.fecha,
       TRY_CAST(t.latitud AS FLOAT) AS lat, TRY_CAST(t.longitud AS FLOAT) AS lng,
       t.precisionM, t.conCobertura, t.fechaRegistroServidor
INTO #trk
FROM dbo.BitacoraTrackingGpsMovil t
WHERE t.fecha >= @ctxDesde
  AND t.fecha <= @ctxHasta
  AND (t.idUsuario = @caso OR t.sucursal = @caso)
  AND (@soloUsuario IS NULL OR t.idUsuario = @soloUsuario);

IF OBJECT_ID('tempdb..#trk_gap') IS NOT NULL DROP TABLE #trk_gap;

SELECT id, idUsuario, fecha, lat, lng, precisionM, conCobertura, fechaRegistroServidor,
       DATEDIFF(SECOND, fecha_prev, fecha) AS seg_desde_anterior
INTO #trk_gap
FROM (
    SELECT t.*,
           LAG(t.fecha) OVER (PARTITION BY t.idUsuario ORDER BY t.fecha) AS fecha_prev
    FROM #trk t
) x;

IF OBJECT_ID('tempdb..#val_geo') IS NOT NULL DROP TABLE #val_geo;

SELECT *
INTO #val_geo
FROM #val
WHERE clat BETWEEN -90 AND 90
  AND clng BETWEEN -180 AND 180;

IF OBJECT_ID('tempdb..#trk_geo') IS NOT NULL DROP TABLE #trk_geo;

SELECT *
INTO #trk_geo
FROM #trk
WHERE lat BETWEEN -90 AND 90
  AND lng BETWEEN -180 AND 180;

-- Para que los OUTER APPLY de R4 no barran la tabla completa en cada intento.
CREATE INDEX IX_trk_geo_usuario_fecha ON #trk_geo (idUsuario, fecha);

/* ------------------------------------------------------------------------------------
   R0 - Identidad: quien es 2083 y si hubo actividad ese dia
   ------------------------------------------------------------------------------------ */

PRINT '=== R0 - Identidad: quien es 2083 (dia completo, ambas bitacoras) ===';

SELECT origen, idUsuario, sucursal, filas, primera, ultima
FROM (
    SELECT 'validaciones' AS origen, idUsuario, sucursal,
           COUNT(*) AS filas, MIN(fecha) AS primera, MAX(fecha) AS ultima
    FROM dbo.BitacoraValidacionUbicacionMovil
    WHERE fecha >= @diaDesde
      AND fecha < @diaHasta
      AND (idUsuario = @caso OR sucursal = @caso)
    GROUP BY idUsuario, sucursal

    UNION ALL

    SELECT 'tracking', idUsuario, sucursal,
           COUNT(*), MIN(fecha), MAX(fecha)
    FROM dbo.BitacoraTrackingGpsMovil
    WHERE fecha >= @diaDesde
      AND fecha < @diaHasta
      AND (idUsuario = @caso OR sucursal = @caso)
    GROUP BY idUsuario, sucursal
) x
ORDER BY origen, filas DESC;

/* ------------------------------------------------------------------------------------
   R1 - Panorama por usuario en la ventana
   ------------------------------------------------------------------------------------ */

PRINT '=== R1 - Panorama por usuario en la ventana 11:10-11:15 ===';

SELECT v.idUsuario,
       COUNT(*) AS validaciones,
       SUM(CASE WHEN v.motivo = 'sin_senal'      THEN 1 ELSE 0 END) AS sin_senal,
       SUM(CASE WHEN v.motivo = 'precision_baja' THEN 1 ELSE 0 END) AS precision_baja,
       SUM(CASE WHEN v.motivo = 'red_no_gnss'    THEN 1 ELSE 0 END) AS red_no_gnss,
       SUM(CASE WHEN v.motivo = 'fuera_de_rango' THEN 1 ELSE 0 END) AS fuera_de_rango,
       SUM(CASE WHEN v.motivo IN ('ok', 'ok_cache', 'ok_tracking') THEN 1 ELSE 0 END) AS aprobadas,
       SUM(CASE WHEN v.conCobertura = 0 THEN 1 ELSE 0 END) AS intentos_sin_red,
       SUM(CASE WHEN v.clat IS NULL OR v.clng IS NULL THEN 1 ELSE 0 END) AS sin_coords_cliente,
       MAX(DATEDIFF(SECOND, v.fecha, v.fechaRegistroServidor)) AS max_retraso_subida_seg,
       (SELECT COUNT(*) FROM #trk_gap t
         WHERE t.idUsuario = v.idUsuario
           AND t.fecha >= @desde
           AND t.fecha <= @hasta) AS pings_en_ventana,
       (SELECT COUNT(*) FROM #trk_gap t
         WHERE t.idUsuario = v.idUsuario) AS pings_ctx_2h,
       (SELECT COUNT(*) FROM #trk_gap t
         WHERE t.idUsuario = v.idUsuario
           AND t.conCobertura = 0) AS pings_sin_red,
       (SELECT MAX(t.seg_desde_anterior) FROM #trk_gap t
         WHERE t.idUsuario = v.idUsuario) AS hueco_max_2h_seg,
       (SELECT MIN(t.fecha) FROM #trk_gap t
         WHERE t.idUsuario = v.idUsuario) AS primer_ping_ctx,
       (SELECT MAX(t.fecha) FROM #trk_gap t
         WHERE t.idUsuario = v.idUsuario) AS ultimo_ping_ctx
FROM #val v
GROUP BY v.idUsuario;

/* ------------------------------------------------------------------------------------
   R2 - Detalle de las validaciones de la ventana
   ------------------------------------------------------------------------------------ */

PRINT '=== R2 - Detalle de las validaciones de la ventana ===';

SELECT b.id, b.fecha, b.idUsuario, b.idCliente, b.motivo,
       CASE WHEN b.valido = 1 THEN 'si' ELSE 'no' END AS valida,
       TRY_CAST(b.distancia AS DECIMAL(12,1)) AS distancia_m,
       TRY_CAST(b.accuracy AS DECIMAL(12,1)) AS accuracy_m,
       b.metrosPermitidos,
       ISNULL(b.numFixes, -1) AS numFixes,
       TRY_CAST(b.peorAccuracy AS DECIMAL(12,1)) AS peor_accuracy_m,
       b.tiempoMs AS tiempo_ms,
       CASE WHEN b.conCobertura = 1 THEN 'con red'
            WHEN b.conCobertura = 0 THEN 'SIN RED'
            ELSE '(no evaluado)' END AS red_al_validar,
       b.plataforma, b.versionApp,
       b.fechaRegistroServidor,
       DATEDIFF(SECOND, b.fecha, b.fechaRegistroServidor) AS retraso_subida_seg,
       CASE
         WHEN b.motivo = 'sin_senal' AND ISNULL(b.numFixes, 0) = 0 AND b.conCobertura = 0
           THEN '0 fixes en ' + ISNULL(CAST(b.tiempoMs AS VARCHAR(12)), '?') +
                ' ms y SIN red: GNSS en frio sin asistencia A-GPS'
         WHEN b.motivo = 'sin_senal' AND ISNULL(b.numFixes, 0) = 0
           THEN '0 fixes en ' + ISNULL(CAST(b.tiempoMs AS VARCHAR(12)), '?') +
                ' ms CON red: el receptor no entrego ni un callback (inanicion GNSS, NO cobertura)'
         WHEN b.motivo = 'red_no_gnss'
           THEN 'fix de red celular (accuracy ' +
                ISNULL(CAST(TRY_CAST(b.accuracy AS DECIMAL(12,0)) AS VARCHAR(20)), '?') + ' m)'
         WHEN b.motivo = 'precision_baja'
           THEN 'hubo fix pero inservible: accuracy ' +
                ISNULL(CAST(TRY_CAST(b.accuracy AS DECIMAL(12,0)) AS VARCHAR(20)), '?') + ' m con ' +
                ISNULL(CAST(b.numFixes AS VARCHAR(10)), '?') + ' fix(es)'
         WHEN b.motivo = 'fuera_de_rango'
           THEN 'fix confiable y lejos: ' +
                ISNULL(CAST(TRY_CAST(b.distancia AS DECIMAL(12,0)) AS VARCHAR(20)), '?') + ' m'
         ELSE b.motivo
       END AS lectura
FROM #val b
ORDER BY b.fecha;

/* ------------------------------------------------------------------------------------
   R3 - Linea de tiempo (validaciones + tracking, +/- 8 min de la ventana)
   ------------------------------------------------------------------------------------ */

PRINT '=== R3 - Linea de tiempo: validaciones + tracking (+/- 8 min) ===';

SELECT x.fecha, x.tipo, x.idUsuario,
       CASE WHEN x.fecha BETWEEN @desde AND @hasta THEN '<<< ventana' ELSE '' END AS en_ventana,
       x.detalle,
       x.retraso_subida_seg
FROM (
    SELECT b.fecha, 'VALIDACION' AS tipo, b.idUsuario,
           CONCAT(b.motivo,
                  ' | ', CASE WHEN b.valido = 1 THEN 'valida' ELSE 'rechazada' END,
                  ' | ', ISNULL(CAST(b.numFixes AS VARCHAR(10)), '?'), ' fix(es)',
                  ' | ', ISNULL(CAST(TRY_CAST(b.accuracy AS DECIMAL(12,1)) AS VARCHAR(20)), 'sin accuracy'), ' m',
                  CASE WHEN b.idCliente IS NOT NULL THEN CONCAT(' | cliente ', b.idCliente) ELSE '' END) AS detalle,
           DATEDIFF(SECOND, b.fecha, b.fechaRegistroServidor) AS retraso_subida_seg
    FROM #val b
    WHERE b.fecha BETWEEN @tlDesde AND @tlHasta

    UNION ALL

    SELECT t.fecha, 'tracking', t.idUsuario,
           CONCAT('ping | ', ISNULL(CAST(TRY_CAST(t.precisionM AS DECIMAL(12,1)) AS VARCHAR(20)), 'precision s/d'), ' m',
                  ' | ', CASE WHEN t.conCobertura = 1 THEN 'con red'
                              WHEN t.conCobertura = 0 THEN 'SIN RED'
                              ELSE 'red s/d' END,
                  CASE WHEN t.seg_desde_anterior IS NOT NULL AND t.seg_desde_anterior > 120
                       THEN CONCAT(' | HUECO ', t.seg_desde_anterior, ' s')
                       ELSE '' END) AS detalle,
           DATEDIFF(SECOND, t.fecha, t.fechaRegistroServidor) AS retraso_subida_seg
    FROM #trk_gap t
    WHERE t.fecha BETWEEN @tlDesde AND @tlHasta
) x
ORDER BY x.fecha, x.tipo;

/* ------------------------------------------------------------------------------------
   R4 - Veredicto por intento (reglas reales de LocationService)
   ------------------------------------------------------------------------------------ */

PRINT '=== R4 - Veredicto por intento: evidencia ok_tracking / veto / cobertura ===';

SELECT v.id, v.fecha, v.idUsuario, v.idCliente, v.motivo,
       ISNULL(v.numFixes, -1) AS numFixes,
       v.tiempoMs AS tiempo_ms,
       CASE WHEN v.conCobertura = 1 THEN 'con red'
            WHEN v.conCobertura = 0 THEN 'SIN RED'
            ELSE '?' END AS red_al_validar,
       DATEDIFF(SECOND, v.fecha, v.fechaRegistroServidor) AS retraso_subida_seg,
       ev.dist_m AS ev_dist_m,
       ev.precision_m AS ev_precision_m,
       ev.edad_seg AS ev_edad_seg,
       veto.dist_m AS veto_dist_m,
       veto.edad_seg AS veto_edad_seg,
       CASE
         WHEN v.motivo IN ('ok', 'ok_cache', 'ok_tracking')
           THEN CONCAT('APROBADA (', v.motivo, ') - sin accion')
         WHEN veto.dist_m IS NOT NULL AND v.motivo <> 'fuera_de_rango'
           THEN 'VETADO: en los 2 min previos habia fix <= 30 m a mas de rango + 30 m'
         WHEN ev.dist_m IS NOT NULL AND v.motivo <> 'fuera_de_rango'
              AND ev.dist_m <= ISNULL(v.metrosPermitidos, 100)
           THEN 'HABIA EVIDENCIA (<= 25 m, <= 5 min, dentro del rango): ok_tracking debio aprobar; revisar build instalado o buffer en memoria'
         WHEN v.motivo = 'fuera_de_rango'
           THEN 'FUERA_DE_RANGO: el fix en vivo fue confiable y lejos; ok_tracking no aplica'
         WHEN ev.dist_m IS NULL AND v.conCobertura = 0
           THEN 'SIN EVIDENCIA de tracking + SIN red al validar: el GPS no engancho; consistente con poca cobertura'
         WHEN ev.dist_m IS NULL AND v.conCobertura = 1
              AND DATEDIFF(SECOND, v.fecha, v.fechaRegistroServidor) > 900
           THEN 'SIN EVIDENCIA + red reportada pero subida > 15 min: la red pudo no estar operativa (revisar R5)'
         WHEN ev.dist_m IS NULL AND v.conCobertura = 1
           THEN 'SIN EVIDENCIA + CON red y subida normal: no parece cobertura; el receptor no entrego fixes buenos (inanicion / wake lock)'
         WHEN ev.dist_m IS NULL
           THEN 'SIN EVIDENCIA de tracking + red no evaluada: no se puede separar cobertura de inanicion'
         ELSE 'Evidencia solo FUERA del rango: no alcanzaba para ok_tracking'
       END AS veredicto
FROM #val_geo v
OUTER APPLY (
    SELECT TOP 1
           CAST(geography::Point(t.lat, t.lng, 4326)
                .STDistance(geography::Point(v.clat, v.clng, 4326)) AS DECIMAL(12,1)) AS dist_m,
           CAST(t.precisionM AS DECIMAL(12,1)) AS precision_m,
           DATEDIFF(SECOND, t.fecha, v.fecha) AS edad_seg
    FROM #trk_geo t
    WHERE t.idUsuario = v.idUsuario
      AND t.fecha >= DATEADD(SECOND, -300, v.fecha)
      AND t.fecha <= v.fecha
      AND t.precisionM <= 25
    ORDER BY geography::Point(t.lat, t.lng, 4326)
                 .STDistance(geography::Point(v.clat, v.clng, 4326)) ASC
) ev
OUTER APPLY (
    SELECT TOP 1
           CAST(geography::Point(t.lat, t.lng, 4326)
                .STDistance(geography::Point(v.clat, v.clng, 4326)) AS DECIMAL(12,1)) AS dist_m,
           DATEDIFF(SECOND, t.fecha, v.fecha) AS edad_seg
    FROM #trk_geo t
    WHERE t.idUsuario = v.idUsuario
      AND t.fecha >= DATEADD(SECOND, -120, v.fecha)
      AND t.fecha <= v.fecha
      AND t.precisionM <= 30
      AND geography::Point(t.lat, t.lng, 4326)
            .STDistance(geography::Point(v.clat, v.clng, 4326)) > ISNULL(v.metrosPermitidos, 100) + 30
    ORDER BY t.fecha DESC
) veto
ORDER BY v.fecha;

/* ------------------------------------------------------------------------------------
   R5 (opcional) - Patron del dia por hora: cobertura y sincronizacion.
   Responde "el equipo estuvo sin red todo el dia o solo en la ventana?".
   Descomentar para ejecutar.
   ------------------------------------------------------------------------------------ */

/*
SELECT DATEPART(HOUR, t.fecha) AS hora,
       t.idUsuario,
       COUNT(*) AS pings,
       SUM(CASE WHEN t.conCobertura = 0 THEN 1 ELSE 0 END) AS pings_sin_red,
       CAST(100.0 * SUM(CASE WHEN t.conCobertura = 0 THEN 1 ELSE 0 END) / COUNT(*) AS DECIMAL(5,1)) AS pct_sin_red,
       MAX(DATEDIFF(SECOND, t.fecha, t.fechaRegistroServidor)) AS max_retraso_subida_seg,
       CAST(MIN(t.precisionM) AS DECIMAL(12,1)) AS mejor_precision_m
FROM dbo.BitacoraTrackingGpsMovil t
WHERE t.fecha >= @diaDesde
  AND t.fecha < @diaHasta
  AND (t.idUsuario = @caso OR t.sucursal = @caso)
GROUP BY DATEPART(HOUR, t.fecha), t.idUsuario
ORDER BY t.idUsuario, hora;
*/
