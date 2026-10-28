/* =============================================================================
   VERIFICAR LAS UBICACIONES DE MI MÓVIL  (build 1.5.1 / cualquier build)
   =============================================================================
   Qué hace:
     Toma TODAS las validaciones de ubicación del build indicado y las audita
     contra la verdad que tiene el servidor: el tracking de ruta.

     Para cada validación responde tres preguntas:
       1) ¿La lectura era creíble?      → distancia entre la lectura y el punto
                                          donde el tracking tenía el teléfono.
       2) ¿El bloqueo estaba justificado? → ¿había evidencia de presencia?
       3) ¿El build 1.6 la habría aprobado? → simulación exacta de la regla
                                          (evidencia <= 5 min, <= 25 m, dentro
                                          del rango, y menos de 2 vetos).

   Cómo se usa:
     1) Pon tu @idUsuario (menú Datos → Usuarios, o corre la salida -1 y busca
        tu nombre). 0 = todos los usuarios del build.
     2) Pon @versionApp con el build de tu teléfono. '' = todos.
     3) Corre el lote completo y comparte las salidas 1 a 4.

   Notas técnicas:
     * Sin `geography`: Haversine en grados (error < 1 m a 400 m) para evitar el
       error 207 de metadatos y los NULL.
     * Sin DATEDIFF en predicados de fecha (no es sargable).
     * Todo se materializa en temporales antes de agregar (errores 130/8124).
   ============================================================================= */

SET NOCOUNT ON;

DECLARE @idUsuario  INT          = 0;          -- 0 = todos
DECLARE @versionApp VARCHAR(20)  = '1.5.1';    -- '' = todos los builds
DECLARE @dias       INT          = 7;

DECLARE @desde DATETIME = DATEADD(DAY, -@dias, GETDATE());
DECLARE @hasta DATETIME = GETDATE();

/* -----------------------------------------------------------------------------
   SALIDA -1 · ¿Qué builds hay? (para no equivocarse de filtro)
   -------------------------------------------------------------------------- */
SELECT TOP 20
       versionApp,
       COUNT(*)                AS validaciones,
       MIN(fecha)              AS primera,
       MAX(fecha)              AS ultima,
       COUNT(DISTINCT idUsuario) AS vendedores
FROM dbo.BitacoraValidacionUbicacionMovil
WHERE fecha >= @desde
GROUP BY versionApp
ORDER BY MAX(fecha) DESC;

/* -----------------------------------------------------------------------------
   PASO 1 · Validaciones del build, con coordenadas limpias
   -------------------------------------------------------------------------- */
IF OBJECT_ID('tempdb..#lec') IS NOT NULL DROP TABLE #lec;

CREATE TABLE #lec (
    id             INT          NOT NULL PRIMARY KEY,
    idUsuario      INT          NOT NULL,
    sucursal       INT          NULL,
    idCliente      INT          NULL,
    fecha          DATETIME     NOT NULL,
    motivo         VARCHAR(30)  NOT NULL,
    valido         BIT          NULL,
    distancia      FLOAT        NULL,
    permitido      FLOAT        NULL,
    accuracy       FLOAT        NULL,
    numFixes       INT          NULL,
    peorAccuracy   FLOAT        NULL,
    tiempoMs       INT          NULL,
    lecturaLat     FLOAT        NULL,
    lecturaLng     FLOAT        NULL,
    clienteLat     FLOAT        NULL,
    clienteLng     FLOAT        NULL
);

INSERT INTO #lec
SELECT v.id,
       v.idUsuario,
       v.sucursal,
       v.idCliente,
       v.fecha,
       CAST(v.motivo AS VARCHAR(30)),
       CAST(v.valido AS BIT),
       TRY_CAST(v.distancia        AS FLOAT),
       TRY_CAST(v.metrosPermitidos AS FLOAT),
       TRY_CAST(v.accuracy         AS FLOAT),
       TRY_CAST(v.numFixes         AS INT),
       TRY_CAST(v.peorAccuracy     AS FLOAT),
       TRY_CAST(v.tiempoMs         AS INT),
       TRY_CAST(v.latitud          AS FLOAT),
       TRY_CAST(v.longitud         AS FLOAT),
       TRY_CAST(v.clienteLatitud   AS FLOAT),
       TRY_CAST(v.clienteLongitud  AS FLOAT)
FROM dbo.BitacoraValidacionUbicacionMovil v
WHERE v.fecha >= @desde
  AND v.fecha <= @hasta
  AND (@idUsuario  = 0 OR v.idUsuario  = @idUsuario)
  AND (@versionApp = '' OR v.versionApp LIKE @versionApp + '%');

-- Coordenadas fuera de rango o nulas: no se pueden auditar.
DELETE FROM #lec
WHERE lecturaLat IS NULL OR lecturaLng IS NULL
   OR lecturaLat NOT BETWEEN -90  AND 90
   OR lecturaLng NOT BETWEEN -180 AND 180;

/* -----------------------------------------------------------------------------
   PASO 2 · Tracking del mismo rango (una sola lectura de la tabla grande)
   -------------------------------------------------------------------------- */
IF OBJECT_ID('tempdb..#trk') IS NOT NULL DROP TABLE #trk;

CREATE TABLE #trk (
    idUsuario INT      NOT NULL,
    fecha     DATETIME NOT NULL,
    lat       FLOAT    NOT NULL,
    lng       FLOAT    NOT NULL,
    prec      FLOAT    NULL
);

INSERT INTO #trk (idUsuario, fecha, lat, lng, prec)
SELECT t.idUsuario,
       t.fecha,
       TRY_CAST(t.latitud    AS FLOAT),
       TRY_CAST(t.longitud   AS FLOAT),
       TRY_CAST(t.precisionM AS FLOAT)
FROM dbo.BitacoraTrackingGpsMovil t
WHERE t.fecha >= DATEADD(MINUTE, -10, @desde)
  AND t.fecha <= DATEADD(MINUTE,  5, @hasta)
  AND (@idUsuario = 0 OR t.idUsuario = @idUsuario)
  AND TRY_CAST(t.latitud  AS FLOAT) IS NOT NULL
  AND TRY_CAST(t.longitud AS FLOAT) IS NOT NULL;

CREATE CLUSTERED INDEX ix_trk ON #trk (idUsuario, fecha);

/* -----------------------------------------------------------------------------
   PASO 3 · Auditoría fila por fila
     d5      = distancia al cliente del mejor fix bueno (<= 25 m) en 5 min antes
     d5acc   = precisión de ese fix
     vetos   = fixes (<= 30 m) en los 2 min antes que están a > permitido + 30 m
     desvio  = distancia entre la LECTURA y el fix más cercano en tiempo (+-90 s)
               -> si el desvío es grande, la lectura es un punto falso
   -------------------------------------------------------------------------- */
IF OBJECT_ID('tempdb..#audit') IS NOT NULL DROP TABLE #audit;

SELECT l.id,
       l.fecha,
       l.idUsuario,
       l.idCliente,
       l.motivo,
       l.distancia,
       l.permitido,
       l.accuracy,
       l.numFixes,
       l.tiempoMs,
       ev.dist                       AS d5,
       ev.prec                       AS d5acc,
       ISNULL(vt.vetos, 0)           AS vetos,
       dc.dist                       AS desvio
INTO #audit
FROM #lec l
OUTER APPLY (
    -- Mejor evidencia persistida de los 5 min previos (regla 1.6)
    SELECT TOP 1 x.dist, x.prec
    FROM (
        SELECT 111320.0 * SQRT(
                   POWER(t.lat - l.clienteLat, 2) +
                   POWER(COS(RADIANS((t.lat + l.clienteLat) / 2.0)) * (t.lng - l.clienteLng), 2)
               ) AS dist,
               t.prec
        FROM #trk t
        WHERE t.idUsuario = l.idUsuario
          AND t.fecha >= DATEADD(SECOND, -300, l.fecha)
          AND t.fecha <= l.fecha
          AND t.prec IS NOT NULL
          AND t.prec <= 25
          AND l.clienteLat IS NOT NULL
          AND l.clienteLng IS NOT NULL
    ) x
    ORDER BY x.dist ASC
) ev
OUTER APPLY (
    -- Fixes de veto de los 2 min previos (regla R3: hacen falta 2)
    SELECT COUNT(*) AS vetos
    FROM #trk t
    WHERE t.idUsuario = l.idUsuario
      AND t.fecha >= DATEADD(SECOND, -120, l.fecha)
      AND t.fecha <= l.fecha
      AND t.prec IS NOT NULL
      AND t.prec <= 30
      AND l.permitido IS NOT NULL
      AND l.clienteLat IS NOT NULL
      AND l.clienteLng IS NOT NULL
      AND 111320.0 * SQRT(
              POWER(t.lat - l.clienteLat, 2) +
              POWER(COS(RADIANS((t.lat + l.clienteLat) / 2.0)) * (t.lng - l.clienteLng), 2)
          ) > l.permitido + 30
) vt
OUTER APPLY (
    -- Fix más cercano EN TIEMPO (no en distancia): ¿dónde estaba el teléfono?
    SELECT TOP 1 x.dist
    FROM (
        SELECT 111320.0 * SQRT(
                   POWER(t.lat - l.lecturaLat, 2) +
                   POWER(COS(RADIANS((t.lat + l.lecturaLat) / 2.0)) * (t.lng - l.lecturaLng), 2)
               ) AS dist,
               ABS(DATEDIFF(SECOND, t.fecha, l.fecha)) AS dt
        FROM #trk t
        WHERE t.idUsuario = l.idUsuario
          AND t.fecha >= DATEADD(SECOND, -90, l.fecha)
          AND t.fecha <= DATEADD(SECOND,  90, l.fecha)
    ) x
    ORDER BY x.dt ASC
) dc;

/* -----------------------------------------------------------------------------
   SALIDA 0 · Resumen por motivo (¿el build hizo lo que crees que hace?)
   -------------------------------------------------------------------------- */
SELECT motivo,
       COUNT(*)                                                   AS filas,
       CAST(100.0 * COUNT(*) / SUM(COUNT(*)) OVER () AS DECIMAL(6,2)) AS pct,
       CAST(AVG(accuracy)      AS DECIMAL(8,1))                   AS acc_media,
       CAST(AVG(numFixes * 1.0) AS DECIMAL(6,2))                  AS fixes_medios,
       CAST(AVG(tiempoMs)      AS DECIMAL(8,0))                   AS ms_medios,
       COUNT(CASE WHEN d5 IS NOT NULL AND d5 <= permitido THEN 1 END) AS con_evidencia
FROM #audit
GROUP BY motivo
ORDER BY COUNT(*) DESC;

/* -----------------------------------------------------------------------------
   SALIDA 1 · Auditoría de cada validación (una línea por intento)
     veredicto:
       OK                    -> aprobada y sin contradicción del tracking
       BLOQUEO_INJUSTO       -> bloqueada pero había evidencia dentro del rango
                                (esto es lo que arregla el 1.6)
       BLOQUEO_CORRECTO      -> bloqueada y no había evidencia cerca
       BLOQUEO_SIN_CONTRASTE -> bloqueada y no hay tracking en +-5 min
       REUBIC_FALLIDA        -> intento de reubicación fallido (motivos reubic_)
       SIN_PERMISO           -> permiso de ubicación denegado
     desvio_m:
       distancia entre la lectura y el tracking del mismo momento.
       > 200 m con accuracy declarada < 30 m  =>  punto falso del receptor.
   -------------------------------------------------------------------------- */
SELECT
    CONVERT(VARCHAR(19), a.fecha, 120)                     AS fecha,
    a.idUsuario,
    a.idCliente,
    a.motivo,
    CAST(ROUND(a.distancia, 0) AS INT)                     AS dist_m,
    CAST(ROUND(a.permitido, 0) AS INT)                     AS permitido_m,
    CAST(ROUND(a.accuracy,  0) AS INT)                     AS acc_m,
    a.numFixes                                             AS fixes,
    a.tiempoMs                                             AS ms,
    CAST(ROUND(a.d5,    0) AS INT)                         AS mejor_fix_al_cliente_m,
    CAST(ROUND(a.d5acc, 0) AS INT)                         AS mejor_fix_acc_m,
    a.vetos,
    CAST(ROUND(a.desvio, 0) AS INT)                        AS desvio_m,
    CASE
        WHEN a.motivo LIKE 'reubic[_]%'                              THEN 'REUBIC_FALLIDA'
        WHEN a.motivo = 'sin_permiso'                                THEN 'SIN_PERMISO'
        WHEN a.motivo IN ('ok', 'ok_cache', 'ok_tracking')           THEN 'OK'
        WHEN a.d5 IS NULL                                            THEN 'BLOQUEO_SIN_CONTRASTE'
        WHEN a.d5 <= a.permitido AND a.vetos < 2                     THEN 'BLOQUEO_INJUSTO'
        ELSE 'BLOQUEO_CORRECTO'
    END                                                    AS veredicto
FROM #audit a
ORDER BY a.fecha;

/* -----------------------------------------------------------------------------
   SALIDA 2 · Contradicciones: la lectura dice una cosa, el tracking otra
     Caso típico: lectura a 419 m con +-12 m mientras el teléfono estaba a 38 m.
   -------------------------------------------------------------------------- */
SELECT TOP 50
    CONVERT(VARCHAR(19), a.fecha, 120) AS fecha,
    a.idCliente,
    a.motivo,
    CAST(ROUND(a.distancia, 0) AS INT) AS dist_lectura_m,
    CAST(ROUND(a.accuracy,  0) AS INT) AS acc_declarada_m,
    CAST(ROUND(a.desvio,    0) AS INT) AS donde_estaba_el_telefono_m,
    a.numFixes                          AS fixes,
    a.tiempoMs                          AS ms,
    CASE
        WHEN a.desvio > 200 AND a.accuracy < 30 THEN 'PUNTO FALSO'
        WHEN a.desvio > 100                     THEN 'SOSPECHOSA'
        ELSE 'COHERENTE'
    END                                 AS diagnostico
FROM #audit a
WHERE a.desvio IS NOT NULL
ORDER BY a.desvio DESC;

/* -----------------------------------------------------------------------------
   SALIDA 3 · Receptor: saltos imposibles en el tracking (puntos basura)
     > 150 km/h entre dos puntos consecutivos. Si salen muchos, el GPS del
     aparato está brincando y ninguna lectura de ese momento es confiable.
   -------------------------------------------------------------------------- */
IF OBJECT_ID('tempdb..#saltos') IS NOT NULL DROP TABLE #saltos;

SELECT idUsuario,
       fecha,
       lat,
       lng,
       prec,
       LAG(lat)   OVER (PARTITION BY idUsuario ORDER BY fecha) AS latPrev,
       LAG(lng)   OVER (PARTITION BY idUsuario ORDER BY fecha) AS lngPrev,
       LAG(fecha) OVER (PARTITION BY idUsuario ORDER BY fecha) AS fechaPrev
INTO #saltos
FROM #trk;

SELECT TOP 30
    idUsuario,
    CONVERT(VARCHAR(19), fechaPrev, 120) AS desde,
    CONVERT(VARCHAR(19), fecha,     120) AS hasta,
    CAST(ROUND(111320.0 * SQRT(
            POWER(lat - latPrev, 2) +
            POWER(COS(RADIANS((lat + latPrev) / 2.0)) * (lng - lngPrev), 2)
        ), 0) AS INT) AS metros,
    DATEDIFF(SECOND, fechaPrev, fecha) AS segundos,
    CAST(ROUND(
            111320.0 * SQRT(
                POWER(lat - latPrev, 2) +
                POWER(COS(RADIANS((lat + latPrev) / 2.0)) * (lng - lngPrev), 2)
            ) / NULLIF(DATEDIFF(SECOND, fechaPrev, fecha), 0) * 3.6
        , 0) AS INT) AS kmh
FROM #saltos
WHERE latPrev IS NOT NULL
  AND DATEDIFF(SECOND, fechaPrev, fecha) BETWEEN 1 AND 600
  AND 111320.0 * SQRT(
          POWER(lat - latPrev, 2) +
          POWER(COS(RADIANS((lat + latPrev) / 2.0)) * (lng - lngPrev), 2)
      ) / NULLIF(DATEDIFF(SECOND, fechaPrev, fecha), 0) > 41.7
ORDER BY fecha DESC;

/* -----------------------------------------------------------------------------
   SALIDA 4 · Veredicto final: ¿cuántas ubicaciones salieron bien?
     rescatables_16 = las que el build 1.6 aprobaría con la misma evidencia.
   -------------------------------------------------------------------------- */
SELECT
    COUNT(*)                                                        AS validaciones,
    COUNT(CASE WHEN motivo IN ('ok', 'ok_cache', 'ok_tracking') THEN 1 END) AS aprobadas,
    COUNT(CASE WHEN motivo LIKE 'reubic[_]%' THEN 1 END)            AS reubic_fallidas,
    COUNT(CASE WHEN motivo NOT IN ('ok', 'ok_cache', 'ok_tracking')
                 AND motivo NOT LIKE 'reubic[_]%'
                 AND motivo <> 'sin_permiso' THEN 1 END)            AS bloqueos,
    COUNT(CASE WHEN d5 IS NOT NULL AND d5 <= permitido AND vetos < 2
                 AND motivo NOT IN ('ok', 'ok_cache', 'ok_tracking')
                 AND motivo NOT LIKE 'reubic[_]%' THEN 1 END)       AS rescatar_16,
    COUNT(CASE WHEN desvio > 200 AND accuracy < 30 THEN 1 END)      AS lecturas_falsas,
    CAST(AVG(desvio) AS DECIMAL(8,0))                               AS desvio_promedio_m
FROM #audit;
