/* =============================================================================
   MEDICIÓN DE ok_tracking POR VERSIÓN  (efecto del build en fuera_de_rango)
   =============================================================================
   Qué mide:
     Desde el 1.5, un `fuera_de_rango` puede convertirse en `ok_tracking`
     cuando existe evidencia persistida (fix grabado por el servicio de ruta,
     accuracy <= 25 m, dentro de los metros permitidos, antigüedad <= 5 min y
     sin veto de los 2 min previos). Ver docs/PLAN_OK_TRACKING.md §13.

   Cómo se usa:
     1) Instalar el APK nuevo (1.6 o posterior) en los equipos objetivo.
     2) Dejar pasar al menos 1 día de operación (ideal 3-7 días).
     3) Correr el lote. El corte entre "antes" y "después" lo hace
        `versionApp`, no una fecha: así cada equipo se compara consigo mismo.
     4) Leer las 5 salidas.

   Salidas:
     1) Panorama antes vs después (solo vendedores que ya están en el build nuevo).
     2) Comparación por vendedor: tasa de bloqueo antes vs después.
     3) Los `fuera_de_rango` que quedaron en el build nuevo con evidencia:
        si alguno sale CONTRADICHO, el código no lo rescató (revisar).
     4) Auditoría de cada `ok_tracking`: confirma que la evidencia es real.
     5) Adopción por día (cuántas validaciones por versión).

   Convenciones (lecciones de scripts anteriores):
     - Nada de `geography`: es tipo CLR y en un mismo lote congela la metadata
       de las temporales (error 207). Se usa Haversine en grados.
     - Todo se materializa en temporales antes de agregar.
     - Los agregados no referencian más de una tabla externa.
   ============================================================================= */

SET NOCOUNT ON;

DECLARE @versionNueva VARCHAR(20) = '1.6';      -- build con la corrección
DECLARE @versionPrevia VARCHAR(20) = '1.5';     -- build anterior del mismo equipo
DECLARE @desde       DATETIME     = '2026-10-15'; -- inicio del comparativo
DECLARE @ventanaSeg  INT          = 300;        -- 5 min de evidencia

/* -----------------------------------------------------------------------------
   0) Base: validaciones del periodo
   -------------------------------------------------------------------------- */
IF OBJECT_ID('tempdb..#val') IS NOT NULL DROP TABLE #val;

CREATE TABLE #val (
    id          INT          NOT NULL,
    idUsuario   INT          NOT NULL,
    sucursal    INT          NULL,
    idCliente   INT          NULL,
    fecha       DATETIME     NOT NULL,
    motivo      VARCHAR(30)  NULL,
    distancia   FLOAT        NULL,
    accuracy    FLOAT        NULL,
    permitido   FLOAT        NULL,
    numFixes    INT          NULL,
    versionApp  VARCHAR(20)  NULL,
    lat         FLOAT        NULL,
    lng         FLOAT        NULL,
    clat        FLOAT        NULL,
    clng        FLOAT        NULL
);

INSERT INTO #val (id, idUsuario, sucursal, idCliente, fecha, motivo, distancia,
                  accuracy, permitido, numFixes, versionApp, lat, lng, clat, clng)
SELECT b.id,
       b.idUsuario,
       b.sucursal,
       b.idCliente,
       b.fecha,
       b.motivo,
       TRY_CAST(b.distancia        AS FLOAT),
       TRY_CAST(b.accuracy         AS FLOAT),
       TRY_CAST(b.metrosPermitidos AS FLOAT),
       TRY_CAST(b.numFixes         AS INT),
       b.versionApp,
       TRY_CAST(b.latitud          AS FLOAT),
       TRY_CAST(b.longitud         AS FLOAT),
       TRY_CAST(b.clienteLatitud   AS FLOAT),
       TRY_CAST(b.clienteLongitud  AS FLOAT)
FROM dbo.BitacoraValidacionUbicacionMovil b
WHERE b.fecha >= @desde
  AND b.motivo IS NOT NULL
  AND b.motivo IN ('ok','ok_cache','ok_tracking','fuera_de_rango',
                   'precision_baja','sin_senal','sin_permiso','red_no_gnss');

/* Vendedores que ya reportaron al menos una validación con el build nuevo */
IF OBJECT_ID('tempdb..#en15') IS NOT NULL DROP TABLE #en15;
CREATE TABLE #en15 (idUsuario INT PRIMARY KEY);

INSERT INTO #en15 (idUsuario)
SELECT DISTINCT idUsuario FROM #val WHERE versionApp = @versionNueva;

/* -----------------------------------------------------------------------------
   1) Panorama antes vs después (misma población de vendedores)
   -------------------------------------------------------------------------- */
IF OBJECT_ID('tempdb..#res') IS NOT NULL DROP TABLE #res;

CREATE TABLE #res (
    periodo     VARCHAR(10),
    validaciones INT,
    ok          INT,
    ok_cache    INT,
    ok_tracking INT,
    fuera       INT,
    precision   INT,
    sin_senal   INT,
    pct_ok      DECIMAL(6,2),
    pct_tracking DECIMAL(6,2),
    pct_fuera   DECIMAL(6,2)
);

INSERT INTO #res
SELECT CASE WHEN v.versionApp = @versionNueva THEN 'después' ELSE 'antes' END,
       COUNT(*),
       SUM(CASE WHEN v.motivo = 'ok'            THEN 1 ELSE 0 END),
       SUM(CASE WHEN v.motivo = 'ok_cache'      THEN 1 ELSE 0 END),
       SUM(CASE WHEN v.motivo = 'ok_tracking'   THEN 1 ELSE 0 END),
       SUM(CASE WHEN v.motivo = 'fuera_de_rango' THEN 1 ELSE 0 END),
       SUM(CASE WHEN v.motivo = 'precision_baja' THEN 1 ELSE 0 END),
       SUM(CASE WHEN v.motivo = 'sin_senal'      THEN 1 ELSE 0 END),
       CAST(100.0 * SUM(CASE WHEN v.motivo IN ('ok','ok_cache','ok_tracking') THEN 1 ELSE 0 END)
            / NULLIF(COUNT(*), 0) AS DECIMAL(6,2)),
       CAST(100.0 * SUM(CASE WHEN v.motivo = 'ok_tracking' THEN 1 ELSE 0 END)
            / NULLIF(COUNT(*), 0) AS DECIMAL(6,2)),
       CAST(100.0 * SUM(CASE WHEN v.motivo = 'fuera_de_rango' THEN 1 ELSE 0 END)
            / NULLIF(COUNT(*), 0) AS DECIMAL(6,2))
FROM #val v
INNER JOIN #en15 e ON e.idUsuario = v.idUsuario
GROUP BY CASE WHEN v.versionApp = @versionNueva THEN 'después' ELSE 'antes' END;

SELECT '1) PANORAMA (mismos vendedores)' AS salida,
       periodo, validaciones, ok, ok_cache, ok_tracking, fuera, precision, sin_senal,
       pct_ok, pct_tracking, pct_fuera
FROM #res
ORDER BY CASE WHEN periodo = 'antes' THEN 0 ELSE 1 END;

/* -----------------------------------------------------------------------------
   2) Comparación por vendedor
   -------------------------------------------------------------------------- */
IF OBJECT_ID('tempdb..#ante') IS NOT NULL DROP TABLE #ante;
CREATE TABLE #ante (
    idUsuario INT PRIMARY KEY,
    validaciones INT, fuera INT, tracking INT
);
INSERT INTO #ante
SELECT v.idUsuario, COUNT(*),
       SUM(CASE WHEN v.motivo = 'fuera_de_rango' THEN 1 ELSE 0 END),
       SUM(CASE WHEN v.motivo = 'ok_tracking'    THEN 1 ELSE 0 END)
FROM #val v
WHERE v.versionApp <> @versionNueva
GROUP BY v.idUsuario;

IF OBJECT_ID('tempdb..#desp') IS NOT NULL DROP TABLE #desp;
CREATE TABLE #desp (
    idUsuario INT PRIMARY KEY,
    validaciones INT, fuera INT, tracking INT
);
INSERT INTO #desp
SELECT v.idUsuario, COUNT(*),
       SUM(CASE WHEN v.motivo = 'fuera_de_rango' THEN 1 ELSE 0 END),
       SUM(CASE WHEN v.motivo = 'ok_tracking'    THEN 1 ELSE 0 END)
FROM #val v
WHERE v.versionApp = @versionNueva
GROUP BY v.idUsuario;

SELECT '2) POR VENDEDOR' AS salida,
       d.idUsuario,
       ISNULL(a.validaciones, 0) AS val_antes,
       ISNULL(a.fuera, 0)        AS fuera_antes,
       CAST(100.0 * ISNULL(a.fuera, 0) / NULLIF(a.validaciones, 0) AS DECIMAL(6,2)) AS pct_fuera_antes,
       ISNULL(a.tracking, 0)     AS track_antes,
       d.validaciones            AS val_desp,
       d.fuera                   AS fuera_desp,
       CAST(100.0 * d.fuera / NULLIF(d.validaciones, 0) AS DECIMAL(6,2)) AS pct_fuera_desp,
       d.tracking                AS track_desp,
       CAST(100.0 * d.tracking / NULLIF(d.validaciones, 0) AS DECIMAL(6,2)) AS pct_track_desp
FROM #desp d
LEFT JOIN #ante a ON a.idUsuario = d.idUsuario
ORDER BY pct_track_desp DESC, val_desp DESC;

/* -----------------------------------------------------------------------------
   3) ¿Quedaron `fuera_de_rango` con evidencia? (deberían ser pocos)
   -------------------------------------------------------------------------- */
IF OBJECT_ID('tempdb..#fdr') IS NOT NULL DROP TABLE #fdr;

CREATE TABLE #fdr (
    id        INT,
    idUsuario INT,
    idCliente INT NULL,
    fecha     DATETIME,
    distancia FLOAT NULL,
    permitido FLOAT NULL,
    accuracy  FLOAT NULL,
    numFixes  INT NULL,
    seg       INT NULL,
    metros    FLOAT NULL,
    accTrk    FLOAT NULL,
    veredicto VARCHAR(15)
);

INSERT INTO #fdr (id, idUsuario, idCliente, fecha, distancia, permitido, accuracy,
                  numFixes, seg, metros, accTrk, veredicto)
SELECT v.id, v.idUsuario, v.idCliente, v.fecha,
       v.distancia, v.permitido, v.accuracy, v.numFixes,
       trk.seg, trk.metros, trk.accTrk,
       CASE WHEN trk.seg IS NOT NULL AND trk.metros <= ISNULL(v.permitido, 100)
            THEN 'CONTRADICHO' ELSE 'sin_evidencia' END
FROM #val v
OUTER APPLY (
    SELECT TOP 1
           DATEDIFF(SECOND, t.fecha, v.fecha) AS seg,
           CAST(111320.0 * SQRT(
                  POWER(v.clat - t.latitud, 2)
                + POWER(COS(RADIANS((v.clat + t.latitud) / 2.0)) * (v.clng - t.longitud), 2)
           ) AS DECIMAL(10,1)) AS metros,
           CAST(t.precisionM AS DECIMAL(6,1)) AS accTrk
    FROM dbo.BitacoraTrackingGpsMovil t
    WHERE t.idUsuario = v.idUsuario
      AND t.fecha BETWEEN DATEADD(SECOND, -@ventanaSeg, v.fecha) AND v.fecha
      AND t.precisionM IS NOT NULL
      AND t.precisionM <= 25
      AND t.latitud  BETWEEN -90  AND 90
      AND t.longitud BETWEEN -180 AND 180
    ORDER BY 111320.0 * SQRT(
                  POWER(v.clat - t.latitud, 2)
                + POWER(COS(RADIANS((v.clat + t.latitud) / 2.0)) * (v.clng - t.longitud), 2)
             ) ASC, t.fecha DESC
) trk
WHERE v.versionApp = @versionNueva
  AND v.motivo = 'fuera_de_rango'
  AND v.clat IS NOT NULL AND v.clng IS NOT NULL;

SELECT '3) FUERA_DE_RANGO EN EL BUILD NUEVO' AS salida,
       id, idUsuario, idCliente, fecha,
       CAST(distancia AS DECIMAL(10,1)) AS distancia,
       CAST(permitido AS DECIMAL(10,1)) AS permitido,
       CAST(accuracy  AS DECIMAL(6,1))  AS accuracy,
       numFixes, seg, metros, accTrk, veredicto
FROM #fdr
ORDER BY veredicto, fecha DESC;

SELECT '3b) RESUMEN' AS salida,
       COUNT(*) AS fuera_en_build,
       SUM(CASE WHEN veredicto = 'CONTRADICHO' THEN 1 ELSE 0 END) AS contradichos,
       SUM(CASE WHEN seg IS NULL THEN 1 ELSE 0 END)              AS sin_evidencia
FROM #fdr;

/* -----------------------------------------------------------------------------
   4) Auditoría de cada ok_tracking (¿la evidencia es real?)
   -------------------------------------------------------------------------- */
SELECT '4) OK_TRACKING EN EL BUILD NUEVO' AS salida,
       v.id, v.idUsuario, v.idCliente, v.fecha,
       CAST(v.distancia AS DECIMAL(10,1)) AS distancia_evidencia,
       CAST(v.permitido AS DECIMAL(10,1)) AS permitido,
       CAST(v.accuracy  AS DECIMAL(6,1))  AS accuracy_evidencia,
       v.numFixes,
       CAST(111320.0 * SQRT(
              POWER(v.clat - v.lat, 2)
            + POWER(COS(RADIANS((v.clat + v.lat) / 2.0)) * (v.clng - v.lng), 2)
       ) AS DECIMAL(10,1)) AS dist_recalculada,
       CASE WHEN v.distancia IS NOT NULL
             AND v.permitido IS NOT NULL
             AND v.distancia <= v.permitido + 1.0
             AND v.accuracy IS NOT NULL
             AND v.accuracy <= 25
            THEN 'OK' ELSE 'REVISAR' END AS veredicto
FROM #val v
WHERE v.versionApp = @versionNueva
  AND v.motivo = 'ok_tracking'
ORDER BY v.fecha DESC;

/* -----------------------------------------------------------------------------
   5) Adopción por día
   -------------------------------------------------------------------------- */
SELECT '5) ADOPCIÓN' AS salida,
       CAST(v.fecha AS DATE) AS dia,
       SUM(CASE WHEN v.versionApp = @versionNueva  THEN 1 ELSE 0 END) AS val_nuevo,
       SUM(CASE WHEN v.versionApp = @versionPrevia THEN 1 ELSE 0 END) AS val_previo,
       SUM(CASE WHEN v.versionApp NOT IN (@versionNueva, @versionPrevia) THEN 1 ELSE 0 END) AS val_otras,
       COUNT(DISTINCT v.idUsuario) AS vendedores
FROM #val v
GROUP BY CAST(v.fecha AS DATE)
ORDER BY dia;
