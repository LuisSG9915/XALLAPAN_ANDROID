-- =============================================================================
-- CIERRE DEL RELEASE `ok_tracking` — medición a 30 días
--
-- Ejecutar como UN SOLO lote: NO insertar GO en medio (usa variables y #temporales).
-- Cambiar @dias si se quiere otra ventana.
--
-- Salidas:
--   3A — distribución de motivos del periodo
--   3B — los números del release: visitas_perdidas vs ok_tracking
--   3C — reparto de los fallos perdidos en rescatables / ciegos / lejos / límite
--   3D — casos ciegos por vendedor (detecta equipos con GPS muerto)
--
-- Referencias:
--   docs/PLAN_OK_TRACKING.md  §11 (métricas), §12 (evidencia), Anexo A v2
--
-- Base de comparación (medida el 2026-10-22, 30 días):
--   visitas_perdidas = 122 | clientes_distintos = 117 | vendedores = 23
--
-- Notas de implementación (para no repetir los errores ya cometidos):
--   * No se usa DATEDIFF en los predicados de fecha: no es sargable y provocaba
--     barridos completos de BitacoraTrackingGpsMovil (1.1 M de filas).
--   * No se agrega sobre expresiones con subconsultas ni referencias externas:
--     SQL Server lo rechaza (errores 130 y 8124). Por eso se materializa en
--     #eval_cierre con TOP 1 y se agrega después.
-- =============================================================================

DECLARE @dias INT = 30;
DECLARE @desde DATETIME = DATEADD(DAY, -@dias, GETDATE());

-- -----------------------------------------------------------------------------
-- 1) Fallos perdidos: intentos fallidos por GPS sin visita el mismo dia.
--    Se incluye 'ok_tracking' en salvados para que la cifra sea comparable
--    antes y despues del deploy.
-- -----------------------------------------------------------------------------
IF OBJECT_ID('tempdb..#perdidas_cierre') IS NOT NULL DROP TABLE #perdidas_cierre;

SELECT f.id, f.idUsuario, f.sucursal, f.idCliente, f.fecha,
       TRY_CAST(f.clienteLatitud AS FLOAT) AS clat,
       TRY_CAST(f.clienteLongitud AS FLOAT) AS clng,
       f.metrosPermitidos
INTO #perdidas_cierre
FROM dbo.BitacoraValidacionUbicacionMovil f
WHERE f.motivo IN ('precision_baja', 'sin_senal', 'red_no_gnss')
  AND f.fecha >= @desde
  AND f.idCliente IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM dbo.BitacoraValidacionUbicacionMovil s
    WHERE s.idUsuario = f.idUsuario
      AND s.sucursal  = f.sucursal
      AND s.idCliente = f.idCliente
      AND s.fecha >= DATEADD(DAY, DATEDIFF(DAY, 0, f.fecha), 0)
      AND s.fecha <  DATEADD(DAY, DATEDIFF(DAY, 0, f.fecha) + 1, 0)
      AND s.motivo IN ('ok', 'ok_cache', 'ok_tracking')
  );

DELETE FROM #perdidas_cierre
WHERE clat IS NULL OR clng IS NULL
   OR clat NOT BETWEEN -90 AND 90
   OR clng NOT BETWEEN -180 AND 180;

-- -----------------------------------------------------------------------------
-- 2) Evidencia de tracking por fallo.
--    d5      = distancia al cliente del MEJOR fix bueno (<=25 m) en los ultimos 5 min
--    d15     = lo mismo en 15 min (para clasificar "ciegos" vs "lejos")
--    dmax120 = peor distancia de un fix bueno (<=30 m) en los ultimos 2 min (veto)
--    rescatable = replica exacta de la regla del codigo (LocationService)
-- -----------------------------------------------------------------------------
IF OBJECT_ID('tempdb..#eval_cierre') IS NOT NULL DROP TABLE #eval_cierre;

SELECT p.id,
       p.metrosPermitidos,
       ev.dist   AS d5,
       ev15.dist AS d15,
       vt.dist   AS dmax120,
       CASE
         WHEN ev.dist IS NOT NULL
          AND p.metrosPermitidos IS NOT NULL
          AND ev.dist <= p.metrosPermitidos
          AND NOT (vt.dist IS NOT NULL AND vt.dist > p.metrosPermitidos + 30)
         THEN 1 ELSE 0
       END AS rescatable
INTO #eval_cierre
FROM #perdidas_cierre p
OUTER APPLY (
    SELECT TOP 1 geography::Point(t.latitud, t.longitud, 4326)
                    .STDistance(geography::Point(p.clat, p.clng, 4326)) AS dist
    FROM dbo.BitacoraTrackingGpsMovil t
    WHERE t.idUsuario = p.idUsuario
      AND t.sucursal  = p.sucursal
      AND t.fecha >= DATEADD(SECOND, -300, p.fecha)
      AND t.fecha <= p.fecha
      AND t.precisionM <= 25
    ORDER BY geography::Point(t.latitud, t.longitud, 4326)
                 .STDistance(geography::Point(p.clat, p.clng, 4326)) ASC
) ev
OUTER APPLY (
    SELECT TOP 1 geography::Point(t.latitud, t.longitud, 4326)
                    .STDistance(geography::Point(p.clat, p.clng, 4326)) AS dist
    FROM dbo.BitacoraTrackingGpsMovil t
    WHERE t.idUsuario = p.idUsuario
      AND t.sucursal  = p.sucursal
      AND t.fecha >= DATEADD(SECOND, -900, p.fecha)
      AND t.fecha <= p.fecha
      AND t.precisionM <= 25
    ORDER BY geography::Point(t.latitud, t.longitud, 4326)
                 .STDistance(geography::Point(p.clat, p.clng, 4326)) ASC
) ev15
OUTER APPLY (
    SELECT TOP 1 geography::Point(t.latitud, t.longitud, 4326)
                    .STDistance(geography::Point(p.clat, p.clng, 4326)) AS dist
    FROM dbo.BitacoraTrackingGpsMovil t
    WHERE t.idUsuario = p.idUsuario
      AND t.sucursal  = p.sucursal
      AND t.fecha >= DATEADD(SECOND, -120, p.fecha)
      AND t.fecha <= p.fecha
      AND t.precisionM <= 30
    ORDER BY geography::Point(t.latitud, t.longitud, 4326)
                 .STDistance(geography::Point(p.clat, p.clng, 4326)) DESC
) vt;

-- -----------------------------------------------------------------------------
-- 3A) Distribución de motivos en la ventana
-- -----------------------------------------------------------------------------
SELECT motivo,
       COUNT(*) AS casos,
       CAST(100.0 * COUNT(*) / SUM(COUNT(*)) OVER () AS DECIMAL(5, 1)) AS pct
FROM dbo.BitacoraValidacionUbicacionMovil
WHERE fecha >= @desde
GROUP BY motivo
ORDER BY casos DESC;

-- -----------------------------------------------------------------------------
-- 3B) Los números del release
--     Base 2026-10-22: visitas_perdidas = 122, ok_tracking = 0
-- -----------------------------------------------------------------------------
SELECT
    (SELECT COUNT(*) FROM #perdidas_cierre) AS visitas_perdidas,
    (SELECT COUNT(*) FROM dbo.BitacoraValidacionUbicacionMovil
      WHERE motivo = 'ok_tracking' AND fecha >= @desde) AS ok_tracking,
    (SELECT COUNT(*) FROM dbo.BitacoraValidacionUbicacionMovil
      WHERE motivo IN ('ok', 'ok_cache') AND fecha >= @desde) AS ok_y_cache,
    (SELECT COUNT(*) FROM dbo.BitacoraValidacionUbicacionMovil
      WHERE motivo IN ('precision_baja', 'sin_senal', 'red_no_gnss', 'fuera_de_rango')
        AND fecha >= @desde) AS fallos_gps,
    (SELECT COUNT(*) FROM dbo.BitacoraValidacionUbicacionMovil
      WHERE fecha >= @desde) AS validaciones_totales;

-- -----------------------------------------------------------------------------
-- 3C) Reparto de los fallos perdidos
--     Objetivo tras el release: rescatables debe acercarse a 0 (ya se aprueban)
--     y visitas_perdidas debe bajar de 122.
-- -----------------------------------------------------------------------------
SELECT COUNT(*) AS fallos_perdidos,
       SUM(rescatable) AS rescatables,
       SUM(CASE WHEN rescatable = 0 AND d15 IS NULL THEN 1 ELSE 0 END) AS ciegos,
       SUM(CASE WHEN rescatable = 0 AND d15 IS NOT NULL AND d15 >  metrosPermitidos THEN 1 ELSE 0 END) AS lejos,
       SUM(CASE WHEN rescatable = 0 AND d15 IS NOT NULL AND d15 <= metrosPermitidos THEN 1 ELSE 0 END) AS limite
FROM #eval_cierre;

-- -----------------------------------------------------------------------------
-- 3D) Casos ciegos por vendedor — detecta equipos con GPS muerto.
--     El 2026-10-22 el vendedor 1042 (sucursal 11) concentraba 9 de 14.
-- -----------------------------------------------------------------------------
SELECT p.idUsuario,
       p.sucursal,
       COUNT(*) AS casos_ciegos,
       MIN(p.fecha) AS primer_caso,
       MAX(p.fecha) AS ultimo_caso
FROM #eval_cierre e
INNER JOIN #perdidas_cierre p ON p.id = e.id
WHERE e.rescatable = 0 AND e.d15 IS NULL
GROUP BY p.idUsuario, p.sucursal
ORDER BY casos_ciegos DESC;
