-- =============================================================================
-- SALUD GPS POR EQUIPO — ¿qué teléfonos realmente no tienen señal?
-- =============================================================================
-- Responde la pregunta: "el GPS está muerto" ¿es el equipo, la configuración
-- del teléfono o el software?
--
-- Lee:  dbo.BitacoraTrackingGpsMovil         (puntos de ruta)
--       dbo.BitacoraValidacionUbicacionMovil (intentos de validación)
--
-- Salidas:
--   1) Salud por vendedor/equipo con etiqueta (CIEGO / deficiente / sano)
--   2) Detalle por día del vendedor de @idUsuario (si se indica)
--   3) Intentos de validación de los equipos ciegos (para ver el patrón)
--
-- Reglas:
--   - Sin `geography`: Haversine solo cuando hace falta (aquí no hace falta).
--   - Todo materializado en temporales: evita error 8124 al agregar con más
--     de una referencia externa.
--   - Un solo lote (sin GO) para que las variables estén en alcance.
--   - Criterio de "fix bueno": precisionM <= 25 (el mismo de ok_tracking).
--
-- Uso: correr con @dias = 30. Para un vendedor concreto, poner @idUsuario.
-- =============================================================================
SET NOCOUNT ON;

DECLARE @dias INT = 30;
DECLARE @desde DATETIME = DATEADD(DAY, -@dias, GETDATE());
DECLARE @idUsuario INT = 0;   -- 0 = todos

-- -----------------------------------------------------------------------------
-- 0) Puntos de tracking materializados (una sola lectura de la tabla grande)
-- -----------------------------------------------------------------------------
IF OBJECT_ID('tempdb..#pts') IS NOT NULL DROP TABLE #pts;

SELECT t.idUsuario, t.sucursal, t.fecha, t.precisionM
INTO #pts
FROM dbo.BitacoraTrackingGpsMovil t
WHERE t.fecha >= @desde
  AND t.precisionM IS NOT NULL
  AND (@idUsuario = 0 OR t.idUsuario = @idUsuario);

CREATE CLUSTERED INDEX IX_pts ON #pts (idUsuario, sucursal, fecha);

-- -----------------------------------------------------------------------------
-- 1) Agregados por equipo
-- -----------------------------------------------------------------------------
IF OBJECT_ID('tempdb..#salud') IS NOT NULL DROP TABLE #salud;

SELECT p.idUsuario,
       p.sucursal,
       COUNT(*) AS puntos,
       COUNT(DISTINCT CAST(p.fecha AS DATE)) AS dias_con_ruta,
       SUM(CASE WHEN p.precisionM <= 25 THEN 1 ELSE 0 END) AS buenos_25,
       SUM(CASE WHEN p.precisionM <= 50 THEN 1 ELSE 0 END) AS aceptables_50,
       SUM(CASE WHEN p.precisionM > 150 THEN 1 ELSE 0 END) AS absurdos_150,
       CAST(AVG(p.precisionM) AS DECIMAL(10,1)) AS precision_promedio,
       CAST(100.0 * SUM(CASE WHEN p.precisionM <= 25 THEN 1 ELSE 0 END) / COUNT(*) AS DECIMAL(5,1)) AS pct_buenos,
       CAST(100.0 * SUM(CASE WHEN p.precisionM > 150 THEN 1 ELSE 0 END) / COUNT(*) AS DECIMAL(5,1)) AS pct_absurdos,
       MAX(p.fecha) AS ultimo_punto
INTO #salud
FROM #pts p
GROUP BY p.idUsuario, p.sucursal;

-- Huecos: diferencia entre puntos consecutivos del mismo equipo.
IF OBJECT_ID('tempdb..#huecos') IS NOT NULL DROP TABLE #huecos;

;WITH orden AS (
    SELECT idUsuario, sucursal, fecha,
           LAG(fecha) OVER (PARTITION BY idUsuario, sucursal ORDER BY fecha) AS anterior
    FROM #pts
)
SELECT idUsuario,
       sucursal,
       SUM(CASE WHEN DATEDIFF(MINUTE, anterior, fecha) > 5  THEN 1 ELSE 0 END) AS huecos_5min,
       SUM(CASE WHEN DATEDIFF(MINUTE, anterior, fecha) > 30 THEN 1 ELSE 0 END) AS huecos_30min,
       SUM(CASE WHEN DATEDIFF(MINUTE, anterior, fecha) > 60 THEN 1 ELSE 0 END) AS huecos_60min
INTO #huecos
FROM orden
WHERE anterior IS NOT NULL
GROUP BY idUsuario, sucursal;

-- Validaciones por motivo (para cruzar con la salud del receptor).
IF OBJECT_ID('tempdb..#val') IS NOT NULL DROP TABLE #val;

SELECT v.idUsuario,
       v.sucursal,
       COUNT(*) AS validaciones,
       SUM(CASE WHEN v.motivo IN ('ok', 'ok_cache') THEN 1 ELSE 0 END) AS ok_y_cache,
       SUM(CASE WHEN v.motivo = 'ok_tracking' THEN 1 ELSE 0 END) AS ok_tracking,
       SUM(CASE WHEN v.motivo = 'fuera_de_rango' THEN 1 ELSE 0 END) AS fuera_de_rango,
       SUM(CASE WHEN v.motivo = 'precision_baja' THEN 1 ELSE 0 END) AS precision_baja,
       SUM(CASE WHEN v.motivo = 'sin_senal' THEN 1 ELSE 0 END) AS sin_senal
INTO #val
FROM dbo.BitacoraValidacionUbicacionMovil v
WHERE v.fecha >= @desde
GROUP BY v.idUsuario, v.sucursal;

-- -----------------------------------------------------------------------------
-- SALIDA 1 — Salud por equipo, de peor a mejor
-- -----------------------------------------------------------------------------
SELECT s.idUsuario,
       s.sucursal,
       s.puntos,
       s.dias_con_ruta,
       (@dias - s.dias_con_ruta) AS dias_sin_ruta,
       s.pct_buenos,
       s.pct_absurdos,
       s.precision_promedio,
       ISNULL(h.huecos_5min, 0)     AS huecos_5min,
       ISNULL(h.huecos_30min, 0)    AS huecos_30min,
       ISNULL(h.huecos_60min, 0)    AS huecos_60min,
       ISNULL(v.validaciones, 0)    AS validaciones,
       ISNULL(v.ok_y_cache, 0)      AS ok_y_cache,
       ISNULL(v.ok_tracking, 0)     AS ok_tracking,
       ISNULL(v.fuera_de_rango, 0)  AS fuera_de_rango,
       ISNULL(v.precision_baja, 0)  AS precision_baja,
       ISNULL(v.sin_senal, 0)       AS sin_senal,
       s.ultimo_punto,
       CASE
           WHEN s.puntos < 50                 THEN 'sin datos suficientes'
           WHEN s.pct_buenos < 20             THEN 'CIEGO: revisar equipo/config'
           WHEN s.pct_buenos < 50             THEN 'deficiente'
           WHEN ISNULL(h.huecos_60min, 0) >= 2 * s.dias_con_ruta THEN 'intermitente (se corta)'
           ELSE 'sano'
       END AS diagnostico
FROM #salud s
LEFT JOIN #huecos h ON h.idUsuario = s.idUsuario AND h.sucursal = s.sucursal
LEFT JOIN #val    v ON v.idUsuario = s.idUsuario AND v.sucursal = s.sucursal
ORDER BY s.pct_buenos ASC, s.puntos DESC;

-- -----------------------------------------------------------------------------
-- SALIDA 2 — Día a día del vendedor indicado (solo si @idUsuario > 0)
-- -----------------------------------------------------------------------------
IF @idUsuario > 0
BEGIN
    SELECT CAST(p.fecha AS DATE) AS dia,
           COUNT(*) AS puntos,
           SUM(CASE WHEN p.precisionM <= 25 THEN 1 ELSE 0 END) AS buenos_25,
           SUM(CASE WHEN p.precisionM > 150 THEN 1 ELSE 0 END) AS absurdos_150,
           CAST(AVG(p.precisionM) AS DECIMAL(10,1)) AS precision_promedio,
           MIN(p.fecha) AS primer_punto,
           MAX(p.fecha) AS ultimo_punto,
           CAST(100.0 * SUM(CASE WHEN p.precisionM <= 25 THEN 1 ELSE 0 END) / COUNT(*) AS DECIMAL(5,1)) AS pct_buenos
    FROM #pts p
    GROUP BY CAST(p.fecha AS DATE)
    ORDER BY dia DESC;
END

-- -----------------------------------------------------------------------------
-- SALIDA 3 — Qué ve el vendedor ciego al intentar validar
-- -----------------------------------------------------------------------------
SELECT v.idUsuario,
       v.sucursal,
       v.motivo,
       COUNT(*) AS intentos,
       CAST(AVG(v.accuracy) AS DECIMAL(10,0))  AS accuracy_promedio,
       CAST(AVG(v.numFixes) AS DECIMAL(10,1))  AS fixes_promedio,
       CAST(AVG(v.tiempoMs) AS DECIMAL(10,0))  AS ms_promedio
FROM dbo.BitacoraValidacionUbicacionMovil v
WHERE v.fecha >= @desde
  AND (@idUsuario = 0 OR v.idUsuario = @idUsuario)
  AND EXISTS (
      SELECT 1
      FROM #salud s
      WHERE s.idUsuario = v.idUsuario
        AND s.sucursal  = v.sucursal
        AND s.pct_buenos < 20
        AND s.puntos >= 50
  )
GROUP BY v.idUsuario, v.sucursal, v.motivo
ORDER BY v.idUsuario, intentos DESC;
