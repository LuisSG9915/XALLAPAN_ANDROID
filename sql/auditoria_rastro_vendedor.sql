-- =============================================================================
-- AUDITORÍA DEL RASTRO DE UN VENDEDOR EN UNA VENTANA
--
-- Sirve para responder: "¿el teléfono estaba donde dice la captura?"
--
-- Compara tres cosas en la misma línea de tiempo:
--   1. lo que reportó cada INTENTO de validación (con su lat/lng real),
--   2. lo que reportó el TRACKING de fondo (una fila por minuto),
--   3. los SALTOS del rastro del día (velocidades imposibles).
--
-- Con eso se distingue:
--   * captura FALSA      -> la fila del servidor no coincide con lo que muestra
--                           la pantalla (no es el caso: aquí coincide exacto).
--   * LECTURA FALSA      -> el intento reporta un punto donde el tracking nunca
--                           estuvo (salto de receptor).
--   * FIX RANCIO         -> el punto reportado coincide con una posición de
--                           minutos antes (el sistema reusó una lectura vieja).
--   * RASTRO INESTABLE   -> el propio tracking salta cientos de metros en
--                           segundos; entonces ninguna distancia es confiable.
--
-- Uso: poner el vendedor y la ventana. Ejecutar como UN SOLO lote.
--
-- NOTA TÉCNICA: las distancias se calculan con la fórmula de HAVERSINE en SQL
-- puro (111320 m por grado, con corrección por coseno de la latitud media) en
-- vez de geography::Point. Motivos: (a) geography es un tipo CLR y en un mismo
-- lote da problemas de metadatos con ALTER TABLE (error 207), (b) revienta si
-- una sola latitud viene NULL, (c) el error a 400 m es menor a 1 m, que es
-- irrelevante para estas distancias. Es la misma fórmula que usa el mapa del
-- admin ("Distancia Haversine").
-- =============================================================================

SET NOCOUNT ON;

DECLARE @idUsuario    INT      = 1037;
DECLARE @desde        DATETIME = '2026-10-27 16:10:00';
DECLARE @hasta        DATETIME = '2026-10-27 16:25:00';
DECLARE @idValidacion INT      = 373510;   -- el intento que se quiere auditar

-- -----------------------------------------------------------------------------
-- 0) La lectura auditada
-- -----------------------------------------------------------------------------
IF OBJECT_ID('tempdb..#lec') IS NOT NULL DROP TABLE #lec;

CREATE TABLE #lec (
    id        INT,
    fecha     DATETIME,
    motivo    VARCHAR(100),
    lat       FLOAT NULL,
    lng       FLOAT NULL,
    clat      FLOAT NULL,
    clng      FLOAT NULL,
    dist      FLOAT NULL,
    acc       FLOAT NULL,
    permitido FLOAT NULL,
    numFixes  INT NULL
);

INSERT INTO #lec (id, fecha, motivo, lat, lng, clat, clng, dist, acc, permitido, numFixes)
SELECT TOP 1
       b.id, b.fecha, b.motivo,
       TRY_CAST(b.latitud          AS FLOAT),
       TRY_CAST(b.longitud         AS FLOAT),
       TRY_CAST(b.clienteLatitud   AS FLOAT),
       TRY_CAST(b.clienteLongitud  AS FLOAT),
       TRY_CAST(b.distancia        AS FLOAT),
       TRY_CAST(b.accuracy         AS FLOAT),
       TRY_CAST(b.metrosPermitidos AS FLOAT),
       TRY_CAST(b.numFixes         AS INT)
FROM dbo.BitacoraValidacionUbicacionMovil b
WHERE b.id = @idValidacion;

IF NOT EXISTS (SELECT 1 FROM #lec)
    RAISERROR('No existe la fila %d en BitacoraValidacionUbicacionMovil.', 16, 1, @idValidacion);

DELETE FROM #lec
WHERE lat IS NULL OR lng IS NULL
   OR lat NOT BETWEEN -90 AND 90
   OR lng NOT BETWEEN -180 AND 180;

SELECT id, fecha, motivo,
       CAST(dist AS DECIMAL(10,1)) AS dist_medida_m,
       permitido                   AS permitido_m,
       CAST(acc AS DECIMAL(10,1))  AS acc_declarada,
       numFixes,
       CAST(lat AS DECIMAL(10,7))  AS lat_reportada,
       CAST(lng AS DECIMAL(10,7))  AS lng_reportada,
       CAST(clat AS DECIMAL(10,7)) AS lat_pin,
       CAST(clng AS DECIMAL(10,7)) AS lng_pin
FROM #lec;

-- -----------------------------------------------------------------------------
-- 1) Los intentos de la ventana, con coordenadas
-- -----------------------------------------------------------------------------
IF OBJECT_ID('tempdb..#val') IS NOT NULL DROP TABLE #val;

CREATE TABLE #val (
    id        INT,
    fecha     DATETIME,
    motivo    VARCHAR(100),
    idCliente INT NULL,
    lat       FLOAT NULL,
    lng       FLOAT NULL,
    dist      FLOAT NULL,
    acc       FLOAT NULL,
    permitido FLOAT NULL,
    numFixes  INT NULL,
    tiempoMs  INT NULL
);

INSERT INTO #val (id, fecha, motivo, idCliente, lat, lng, dist, acc, permitido, numFixes, tiempoMs)
SELECT b.id, b.fecha, b.motivo, b.idCliente,
       TRY_CAST(b.latitud          AS FLOAT),
       TRY_CAST(b.longitud         AS FLOAT),
       TRY_CAST(b.distancia        AS FLOAT),
       TRY_CAST(b.accuracy         AS FLOAT),
       TRY_CAST(b.metrosPermitidos AS FLOAT),
       TRY_CAST(b.numFixes         AS INT),
       TRY_CAST(b.tiempoMs         AS INT)
FROM dbo.BitacoraValidacionUbicacionMovil b
WHERE b.idUsuario = @idUsuario
  AND b.fecha BETWEEN @desde AND @hasta;

SELECT v.id, v.fecha, v.motivo, v.idCliente,
       CAST(v.dist AS DECIMAL(10,1)) AS dist_medida_m,
       CAST(v.acc  AS DECIMAL(10,1)) AS acc_declarada,
       v.numFixes, v.tiempoMs,
       CAST(v.lat AS DECIMAL(10,7))  AS lat_reportada,
       CAST(v.lng AS DECIMAL(10,7))  AS lng_reportada,
       CAST(dd.metros AS DECIMAL(10,1)) AS dist_a_la_lectura_auditada
FROM #val v
CROSS JOIN #lec l
CROSS APPLY (
    SELECT 111320.0 * SQRT(
               POWER((v.lat - l.lat), 2) +
               POWER(COS(RADIANS((v.lat + l.lat) / 2.0)) * (v.lng - l.lng), 2)
           ) AS metros
) dd
WHERE v.lat IS NOT NULL AND v.lng IS NOT NULL
ORDER BY v.fecha;

-- -----------------------------------------------------------------------------
-- 2) El tracking de la ventana, con coordenadas y contra la lectura auditada
-- -----------------------------------------------------------------------------
IF OBJECT_ID('tempdb..#trk') IS NOT NULL DROP TABLE #trk;

CREATE TABLE #trk (
    fecha DATETIME,
    acc   FLOAT NULL,
    lat   FLOAT NULL,
    lng   FLOAT NULL
);

INSERT INTO #trk (fecha, acc, lat, lng)
SELECT t.fecha,
       TRY_CAST(t.precisionM AS FLOAT),
       TRY_CAST(t.latitud    AS FLOAT),
       TRY_CAST(t.longitud   AS FLOAT)
FROM dbo.BitacoraTrackingGpsMovil t
WHERE t.idUsuario = @idUsuario
  AND t.fecha BETWEEN @desde AND @hasta;

DELETE FROM #trk
WHERE lat IS NULL OR lng IS NULL
   OR lat NOT BETWEEN -90  AND  90
   OR lng NOT BETWEEN -180 AND 180;

SELECT t.fecha,
       CAST(t.acc AS DECIMAL(6,1))  AS acc,
       CAST(t.lat AS DECIMAL(10,7)) AS lat,
       CAST(t.lng AS DECIMAL(10,7)) AS lng,
       CAST(dd.metros AS DECIMAL(10,1)) AS dist_a_la_lectura_auditada
FROM #trk t
CROSS JOIN #lec l
CROSS APPLY (
    SELECT 111320.0 * SQRT(
               POWER((t.lat - l.lat), 2) +
               POWER(COS(RADIANS((t.lat + l.lat) / 2.0)) * (t.lng - l.lng), 2)
           ) AS metros
) dd
ORDER BY t.fecha;

-- -----------------------------------------------------------------------------
-- 3) ¿De qué momento salió el punto reportado?
--    El punto del día más cercano a la lectura. Si es de 10-20 min antes, la
--    app usó (o el sistema le entregó) un fix RANCIO con hora nueva.
-- -----------------------------------------------------------------------------
IF OBJECT_ID('tempdb..#dia') IS NOT NULL DROP TABLE #dia;

CREATE TABLE #dia (
    fecha DATETIME,
    acc   FLOAT NULL,
    lat   FLOAT NULL,
    lng   FLOAT NULL
);

INSERT INTO #dia (fecha, acc, lat, lng)
SELECT t.fecha,
       TRY_CAST(t.precisionM AS FLOAT),
       TRY_CAST(t.latitud    AS FLOAT),
       TRY_CAST(t.longitud   AS FLOAT)
FROM dbo.BitacoraTrackingGpsMovil t
WHERE t.idUsuario = @idUsuario
  AND t.fecha >= DATEADD(HOUR, -8, @desde)
  AND t.fecha <= DATEADD(HOUR,  8, @hasta);

DELETE FROM #dia
WHERE lat IS NULL OR lng IS NULL
   OR lat NOT BETWEEN -90  AND  90
   OR lng NOT BETWEEN -180 AND 180;

SELECT TOP 5
       d.fecha,
       DATEDIFF(SECOND, d.fecha, l.fecha) AS seg_antes_de_la_lectura,
       CAST(d.acc AS DECIMAL(6,1))        AS acc_tracking,
       CAST(dd.metros AS DECIMAL(10,1))   AS dist_a_la_lectura_m,
       CASE WHEN dd.metros <= 30
                 AND d.fecha < DATEADD(MINUTE, -3, l.fecha)
            THEN 'FIX RANCIO: la lectura es una posicion vieja'
            WHEN dd.metros <= 30
            THEN 'La lectura coincide con el tracking del momento'
            ELSE 'Sin coincidencia: salto de receptor'
       END AS veredicto
FROM #dia d
CROSS JOIN #lec l
CROSS APPLY (
    SELECT 111320.0 * SQRT(
               POWER((d.lat - l.lat), 2) +
               POWER(COS(RADIANS((d.lat + l.lat) / 2.0)) * (d.lng - l.lng), 2)
           ) AS metros
) dd
ORDER BY dd.metros ASC;

-- -----------------------------------------------------------------------------
-- 4) ¿El rastro del día es confiable? Saltos a más de 120 km/h entre puntos
--    consecutivos. Si hay muchos, el propio tracking está contaminado y el
--    "21.53 km" del admin está inflado.
-- -----------------------------------------------------------------------------
IF OBJECT_ID('tempdb..#mov') IS NOT NULL DROP TABLE #mov;

CREATE TABLE #mov (
    fecha      DATETIME,
    fecha_prev DATETIME,
    seg        FLOAT,
    metros     FLOAT
);

;WITH paso AS (
    SELECT fecha, lat, lng,
           LAG(fecha) OVER (ORDER BY fecha) AS fecha_prev,
           LAG(lat)   OVER (ORDER BY fecha) AS lat_prev,
           LAG(lng)   OVER (ORDER BY fecha) AS lng_prev
    FROM #dia
)
INSERT INTO #mov (fecha, fecha_prev, seg, metros)
SELECT p.fecha, p.fecha_prev,
       CAST(DATEDIFF(SECOND, p.fecha_prev, p.fecha) AS FLOAT),
       dd.metros
FROM paso p
CROSS APPLY (
    SELECT 111320.0 * SQRT(
               POWER((p.lat - p.lat_prev), 2) +
               POWER(COS(RADIANS((p.lat + p.lat_prev) / 2.0)) * (p.lng - p.lng_prev), 2)
           ) AS metros
) dd
WHERE p.fecha_prev IS NOT NULL
  AND p.lat_prev IS NOT NULL
  AND p.lng_prev IS NOT NULL;

DELETE FROM #mov WHERE seg <= 0;

SELECT COUNT(*) + 1                                              AS puntos,
       CAST(SUM(metros) AS DECIMAL(12,1))                        AS metros_totales,
       SUM(CASE WHEN metros / seg * 3.6 > 120 THEN 1 ELSE 0 END) AS saltos_sobre_120_kmh,
       CAST(SUM(CASE WHEN metros / seg * 3.6 > 120 THEN metros ELSE 0 END)
            AS DECIMAL(12,1))                                    AS metros_en_saltos,
       CAST(MAX(metros / seg * 3.6) AS DECIMAL(10,0))            AS kmh_max
FROM #mov;

-- Detalle de los saltos, para verlos en el mapa
SELECT m.fecha, m.fecha_prev,
       CAST(m.seg AS INT)                                AS segundos,
       CAST(m.metros AS DECIMAL(10,1))                   AS metros,
       CAST(m.metros / m.seg * 3.6 AS DECIMAL(10,0))     AS kmh,
       CAST(d.lat AS DECIMAL(10,7))                      AS lat,
       CAST(d.lng AS DECIMAL(10,7))                      AS lng
FROM #mov m
JOIN #dia d ON d.fecha = m.fecha
WHERE m.metros / m.seg * 3.6 > 120
ORDER BY m.fecha;
