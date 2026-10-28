-- =============================================================================
-- ¿CUÁNTOS `fuera_de_rango` ESTÁN EQUIVOCADOS?
--
-- El bloque 2.5 de `services/LocationService.ts` (contraste con tracking)
-- compara la lectura de la validación contra el ÚLTIMO fix del tracking guardado
-- en memoria, y solo si tiene edad ≤ 30 s y accuracy ≤ 50 m. Cuando el receptor
-- "salta" de golpe, las dos lecturas saltan juntas y el bloque no ve nada.
--
-- Caso 373510 (27-oct 16:17:11, vendedor 1037): la app midió 419 m con ±11.9 m,
-- y 3 s antes el tracking del mismo teléfono marcaba 38.5 m con ±18.3 m. La
-- fila salió `fuera_de_rango` en vez de `precision_baja`.
--
-- Este script mide el tamaño del hueco: para cada `fuera_de_rango` busca los
-- puntos de tracking de los 60 s previos, toma el más cercano al pin y decide
-- si el vendedor estaba DENTRO del radio permitido justo cuando la app le dijo
-- que estaba fuera.
--
-- Salidas:
--   A) por día      -> volumen y proporción de contradicciones.
--   B) por vendedor -> dónde se concentra (¿equipo? ¿zona?).
--   C) las 50 peores-> filas para auditar con diagnostico_fuera_de_rango.sql.
--
-- COTA INFERIOR: solo cuenta si hay un punto de tracking de ≤25 m en los 60 s
-- previos. El tracking escribe cada ~30-60 s, así que muchos casos no tendrán
-- punto y quedan fuera. El número real es mayor.
--
-- Ejecutar como UN SOLO lote (usa variables y #temporales).
-- =============================================================================

SET NOCOUNT ON;

DECLARE @dias       INT = 7;    -- ventana de medición (días hacia atrás)
DECLARE @ventanaSeg INT = 60;   -- segundos de tracking previos a cada intento
DECLARE @desde DATETIME = DATEADD(DAY, -@dias, GETDATE());

-- -----------------------------------------------------------------------------
-- 0) Intentos bloqueados por estar "fuera de rango"
-- -----------------------------------------------------------------------------
IF OBJECT_ID('tempdb..#fr') IS NOT NULL DROP TABLE #fr;

SELECT b.id,
       b.fecha,
       b.idUsuario,
       b.sucursal,
       b.idCliente,
       TRY_CAST(b.distancia        AS FLOAT) AS dist,
       TRY_CAST(b.metrosPermitidos AS FLOAT) AS permitido,
       TRY_CAST(b.accuracy         AS FLOAT) AS acc,
       TRY_CAST(b.latitud          AS FLOAT) AS vlat,
       TRY_CAST(b.longitud         AS FLOAT) AS vlng,
       TRY_CAST(b.clienteLatitud   AS FLOAT) AS clat,
       TRY_CAST(b.clienteLongitud  AS FLOAT) AS clng
INTO #fr
FROM dbo.BitacoraValidacionUbicacionMovil b
WHERE b.motivo = 'fuera_de_rango'
  AND b.fecha >= @desde;

DELETE FROM #fr
WHERE clat IS NULL OR clng IS NULL
   OR clat NOT BETWEEN -90  AND  90
   OR clng NOT BETWEEN -180 AND 180
   OR (clat = 0 AND clng = 0)
   OR permitido IS NULL
   OR dist IS NULL;

-- -----------------------------------------------------------------------------
-- 1) Tracking de la ventana, materializado con geografía ya calculada
--    (filtrar nulos ANTES de geography::Point; si no, el optimizador revienta)
-- -----------------------------------------------------------------------------
IF OBJECT_ID('tempdb..#tr') IS NOT NULL DROP TABLE #tr;

CREATE TABLE #tr (
    idUsuario INT,
    sucursal  INT,
    fecha     DATETIME,
    acc       FLOAT NULL,
    lat       FLOAT NULL,
    lng       FLOAT NULL,
    geo       GEOGRAPHY NULL
);

INSERT INTO #tr (idUsuario, sucursal, fecha, acc, lat, lng)
SELECT t.idUsuario,
       t.sucursal,
       t.fecha,
       TRY_CAST(t.precisionM AS FLOAT),
       TRY_CAST(t.latitud    AS FLOAT),
       TRY_CAST(t.longitud   AS FLOAT)
FROM dbo.BitacoraTrackingGpsMovil t
WHERE t.fecha >= DATEADD(SECOND, -@ventanaSeg, @desde)
  AND t.fecha <= GETDATE()
  AND t.latitud  IS NOT NULL
  AND t.longitud IS NOT NULL
  AND TRY_CAST(t.latitud  AS FLOAT) BETWEEN -90  AND  90
  AND TRY_CAST(t.longitud AS FLOAT) BETWEEN -180 AND 180
  AND TRY_CAST(t.precisionM AS FLOAT) <= 25;

-- geography::Point nunca debe recibir NULL: se descarta aquí, no en el SELECT.
DELETE FROM #tr
WHERE lat IS NULL OR lng IS NULL
   OR lat NOT BETWEEN -90  AND  90
   OR lng NOT BETWEEN -180 AND 180;

UPDATE #tr SET geo = geography::Point(lat, lng, 4326);

CREATE INDEX ix_tr ON #tr (idUsuario, sucursal, fecha);

-- -----------------------------------------------------------------------------
-- 2) El punto de tracking más cercano al pin dentro de los N segundos previos
--    OUTER APPLY + TOP 1: evita los agregados con referencias externas
--    (error 8124) y el DATEDIFF no sargable en el WHERE.
-- -----------------------------------------------------------------------------
IF OBJECT_ID('tempdb..#mt') IS NOT NULL DROP TABLE #mt;

SELECT p.id,
       m.dist_track,
       m.acc_track,
       m.fecha_track,
       DATEDIFF(SECOND, m.fecha_track, p.fecha) AS seg_antes
INTO #mt
FROM #fr p
OUTER APPLY (
    SELECT TOP 1
           t.geo.STDistance(geography::Point(p.clat, p.clng, 4326)) AS dist_track,
           t.acc,
           t.fecha AS fecha_track
    FROM #tr t
    WHERE t.idUsuario = p.idUsuario
      AND t.sucursal  = p.sucursal
      AND t.fecha BETWEEN DATEADD(SECOND, -@ventanaSeg, p.fecha) AND p.fecha
    ORDER BY t.geo.STDistance(geography::Point(p.clat, p.clng, 4326)) ASC
) m;

CREATE INDEX ix_mt ON #mt (id);

-- -----------------------------------------------------------------------------
-- 3) Resultado por intento: ¿estaba dentro?
-- -----------------------------------------------------------------------------
IF OBJECT_ID('tempdb..#caso') IS NOT NULL DROP TABLE #caso;

SELECT p.id,
       p.fecha,
       p.idUsuario,
       p.sucursal,
       p.idCliente,
       p.dist,
       p.permitido,
       p.acc,
       m.dist_track,
       m.acc_track,
       m.seg_antes,
       CASE WHEN m.dist_track IS NULL                            THEN 'sin_tracking'
            WHEN m.dist_track > p.permitido                      THEN 'tracking_tambien_fuera'
            WHEN p.dist - m.dist_track
                 > ISNULL(p.acc, 0) + ISNULL(m.acc_track, 0) + 50 THEN 'contradicho'
            ELSE 'dudoso'
       END AS clasificacion
INTO #caso
FROM #fr p
LEFT JOIN #mt m ON m.id = p.id;

-- -----------------------------------------------------------------------------
-- A) Panorama por día
-- -----------------------------------------------------------------------------
SELECT CAST(fecha AS DATE) AS dia,
       COUNT(*)                                                             AS fuera_de_rango,
       SUM(CASE WHEN clasificacion = 'sin_tracking'         THEN 1 ELSE 0 END) AS sin_tracking,
       SUM(CASE WHEN clasificacion = 'tracking_tambien_fuera' THEN 1 ELSE 0 END) AS bloqueo_correcto,
       SUM(CASE WHEN clasificacion = 'contradicho'          THEN 1 ELSE 0 END) AS contradichos,
       SUM(CASE WHEN clasificacion = 'dudoso'               THEN 1 ELSE 0 END) AS dudosos,
       CAST(100.0 * SUM(CASE WHEN clasificacion = 'contradicho' THEN 1 ELSE 0 END)
            / NULLIF(COUNT(*), 0) AS DECIMAL(5,1))                          AS pct_contradichos
FROM #caso
GROUP BY CAST(fecha AS DATE)
ORDER BY dia;

-- -----------------------------------------------------------------------------
-- B) Panorama por vendedor (los contradichos, ordenados por volumen)
-- -----------------------------------------------------------------------------
SELECT idUsuario,
       sucursal,
       COUNT(*)                                                    AS intentos,
       SUM(CASE WHEN clasificacion = 'contradicho' THEN 1 ELSE 0 END) AS contradichos,
       CAST(AVG(CASE WHEN clasificacion = 'contradicho'
                     THEN dist - dist_track END) AS DECIMAL(10,0))     AS metros_de_error_promedio
FROM #caso
GROUP BY idUsuario, sucursal
HAVING SUM(CASE WHEN clasificacion = 'contradicho' THEN 1 ELSE 0 END) > 0
ORDER BY contradichos DESC;

-- -----------------------------------------------------------------------------
-- C) Las 50 peores: candidatas a auditar con diagnostico_fuera_de_rango.sql
-- -----------------------------------------------------------------------------
SELECT TOP 50
       id,
       fecha,
       idUsuario,
       sucursal,
       idCliente,
       CAST(dist      AS DECIMAL(10,1)) AS dist_medida_m,
       CAST(permitido AS DECIMAL(10,0)) AS permitido_m,
       CAST(acc       AS DECIMAL(10,1)) AS acc_medida,
       CAST(dist_track AS DECIMAL(10,1)) AS dist_tracking_m,
       CAST(acc_track  AS DECIMAL(10,1)) AS acc_tracking,
       seg_antes                        AS segundos_de_diferencia,
       CAST(dist - dist_track AS DECIMAL(10,1)) AS salto_m
FROM #caso
WHERE clasificacion = 'contradicho'
ORDER BY (dist - dist_track) DESC;
