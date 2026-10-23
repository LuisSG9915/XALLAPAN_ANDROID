-- =============================================================================
-- VERIFICACIÓN DEL PILOTO `ok_tracking` — por sucursal
--
-- Uso: ajustar @sucursal (por defecto 38) y @dias, y ejecutar como UN SOLO lote.
--      No insertar GO en medio: usa variables y #temporales.
--
-- Qué responde, en orden:
--   R1 — Chequeos de integridad: ¿hay algo mal? (una fila por chequeo, OK/REVISAR)
--   R2 — Panorama diario de validaciones de la sucursal
--   R3 — Reintentos por cliente/día (detecta vendedores dando vueltas)
--   R4 — Auditoría detalle de cada `ok_tracking` (¿aprobó con evidencia real?)
--   R5 — Reubicaciones de la sucursal por día (efecto colateral)
--
-- Si R4 sale vacía: `ok_tracking` todavía no se ha ejercitado. No es un error;
-- significa que en la sucursal no hubo un fallo de GPS con evidencia de tracking.
-- Para verlo en vivo, en la app: menú Datos → "Validación Ubicación" → buscar
-- el JSON con "motivo": "ok_tracking".
--
-- Notas de implementación (trampas ya conocidas en este repo):
--   * Nada de DATEDIFF en predicados de fecha: no es sargable sobre
--     BitacoraTrackingGpsMovil (1.1 M de filas) y provoca barridos completos.
--   * Nada de agregados sobre expresiones con subconsultas o referencias
--     externas (errores 130 y 8124). Por eso se materializa y se agrega después.
--   * geography::Point no se llama nunca con coordenadas potencialmente NULL:
--     se filtra antes en una tabla aparte.
-- =============================================================================

DECLARE @sucursal INT = 38;
DECLARE @dias INT = 7;
DECLARE @desde DATETIME = DATEADD(DAY, -@dias, GETDATE());

-- -----------------------------------------------------------------------------
-- 0) Materialización de los `ok_tracking` de la sucursal
-- -----------------------------------------------------------------------------
IF OBJECT_ID('tempdb..#okt') IS NOT NULL DROP TABLE #okt;

SELECT b.id, b.fecha, b.idUsuario, b.idCliente, b.valido,
       b.distancia, b.accuracy, b.metrosPermitidos, b.numFixes, b.tiempoMs,
       TRY_CAST(b.clienteLatitud  AS FLOAT) AS clat,
       TRY_CAST(b.clienteLongitud AS FLOAT) AS clng
INTO #okt
FROM dbo.BitacoraValidacionUbicacionMovil b
WHERE b.sucursal = @sucursal
  AND b.motivo = 'ok_tracking'
  AND b.fecha >= @desde;

-- Filtrar coordenadas inválidas ANTES de usar geography::Point
IF OBJECT_ID('tempdb..#okt_valido') IS NOT NULL DROP TABLE #okt_valido;

SELECT *
INTO #okt_valido
FROM #okt
WHERE clat IS NOT NULL AND clng IS NOT NULL
  AND clat BETWEEN -90 AND 90
  AND clng BETWEEN -180 AND 180;

-- Evidencia de tracking que respalda cada aprobación
IF OBJECT_ID('tempdb..#okt_eval') IS NOT NULL DROP TABLE #okt_eval;

SELECT o.id, o.fecha, o.idUsuario, o.idCliente, o.metrosPermitidos,
       o.distancia AS dist_reportada,
       o.accuracy  AS acc_reportada,
       ev.dist          AS dist_evidencia,
       ev.edad_seg      AS edad_evidencia_seg,
       ev.precision     AS precision_evidencia
INTO #okt_eval
FROM #okt_valido o
OUTER APPLY (
    SELECT TOP 1 geography::Point(t.latitud, t.longitud, 4326)
                    .STDistance(geography::Point(o.clat, o.clng, 4326)) AS dist,
           DATEDIFF(SECOND, t.fecha, o.fecha) AS edad_seg,
           t.precisionM AS precision
    FROM dbo.BitacoraTrackingGpsMovil t
    WHERE t.idUsuario = o.idUsuario
      AND t.sucursal  = @sucursal
      AND t.fecha >= DATEADD(SECOND, -300, o.fecha)
      AND t.fecha <= o.fecha
      AND t.precisionM <= 25
    ORDER BY geography::Point(t.latitud, t.longitud, 4326)
                 .STDistance(geography::Point(o.clat, o.clng, 4326)) ASC
) ev;

-- -----------------------------------------------------------------------------
-- R1) CHEQUEOS DE INTEGRIDAD — todo debe salir "OK"
-- -----------------------------------------------------------------------------
SELECT chequeo, valor, esperado,
       CASE WHEN valor = esperado THEN 'OK' ELSE 'REVISAR' END AS estado
FROM (
    SELECT 'C0 · ok_tracking con coordenadas de cliente inválidas' AS chequeo,
           (SELECT COUNT(*) FROM #okt) - (SELECT COUNT(*) FROM #okt_valido) AS valor,
           0 AS esperado

    UNION ALL
    SELECT 'C1 · ok_tracking SIN evidencia de tracking',
           (SELECT COUNT(*) FROM #okt_eval WHERE dist_evidencia IS NULL), 0

    UNION ALL
    SELECT 'C2 · ok_tracking con evidencia FUERA del radio',
           (SELECT COUNT(*) FROM #okt_eval
             WHERE dist_evidencia IS NOT NULL AND dist_evidencia > metrosPermitidos), 0

    UNION ALL
    SELECT 'C3 · ok_tracking con evidencia de más de 5 min',
           (SELECT COUNT(*) FROM #okt_eval WHERE edad_evidencia_seg > 300), 0

    UNION ALL
    SELECT 'C4 · ok_tracking con valido = 0',
           (SELECT COUNT(*) FROM #okt WHERE valido = 0), 0

    UNION ALL
    SELECT 'C5 · ok_tracking con numFixes/tiempoMs distintos de 0 (build viejo)',
           (SELECT COUNT(*) FROM #okt WHERE ISNULL(numFixes, 0) <> 0 OR ISNULL(tiempoMs, 0) <> 0), 0

    UNION ALL
    SELECT 'C6 · distancia reportada incoherente con la evidencia (>2 m)',
           (SELECT COUNT(*) FROM #okt_eval
             WHERE dist_evidencia IS NOT NULL AND ABS(dist_reportada - dist_evidencia) > 2), 0

    UNION ALL
    SELECT 'C7 · motivos desconocidos o truncados',
           (SELECT COUNT(*) FROM dbo.BitacoraValidacionUbicacionMovil
             WHERE sucursal = @sucursal AND fecha >= @desde
               AND motivo NOT IN ('ok','ok_cache','ok_tracking','sin_permiso',
                                  'sin_senal','precision_baja','fuera_de_rango','red_no_gnss')), 0

    UNION ALL
    SELECT 'C8 · motivo de éxito con valido = 0, o de fallo con valido = 1',
           (SELECT COUNT(*) FROM dbo.BitacoraValidacionUbicacionMovil
             WHERE sucursal = @sucursal AND fecha >= @desde
               AND ( (motivo IN ('ok','ok_cache','ok_tracking') AND valido = 0)
                  OR (motivo IN ('sin_permiso','sin_senal','precision_baja',
                                 'fuera_de_rango','red_no_gnss') AND valido = 1) )), 0

    UNION ALL
    SELECT 'C9 · fallos de GPS sin accuracy registrada',
           (SELECT COUNT(*) FROM dbo.BitacoraValidacionUbicacionMovil
             WHERE sucursal = @sucursal AND fecha >= @desde
               AND motivo IN ('precision_baja','sin_senal','red_no_gnss')
               AND accuracy IS NULL), 0
) x
ORDER BY chequeo;

-- -----------------------------------------------------------------------------
-- R2) PANORAMA DIARIO
-- -----------------------------------------------------------------------------
SELECT CAST(fecha AS DATE) AS dia,
       COUNT(*) AS validaciones,
       SUM(CASE WHEN motivo = 'ok'               THEN 1 ELSE 0 END) AS ok,
       SUM(CASE WHEN motivo = 'ok_cache'         THEN 1 ELSE 0 END) AS ok_cache,
       SUM(CASE WHEN motivo = 'ok_tracking'      THEN 1 ELSE 0 END) AS ok_tracking,
       SUM(CASE WHEN motivo = 'fuera_de_rango'   THEN 1 ELSE 0 END) AS fuera_de_rango,
       SUM(CASE WHEN motivo IN ('precision_baja','sin_senal','red_no_gnss')
                THEN 1 ELSE 0 END) AS fallos_gps,
       CAST(100.0 * SUM(CASE WHEN motivo IN ('ok','ok_cache','ok_tracking')
                             THEN 1 ELSE 0 END) / COUNT(*) AS DECIMAL(5,1)) AS pct_aprobacion,
       CAST(AVG(CASE WHEN motivo = 'ok' THEN CAST(tiempoMs AS FLOAT) END) AS DECIMAL(10,0)) AS ms_promedio_ok
FROM dbo.BitacoraValidacionUbicacionMovil
WHERE sucursal = @sucursal
  AND fecha >= @desde
GROUP BY CAST(fecha AS DATE)
ORDER BY dia;

-- -----------------------------------------------------------------------------
-- R3) REINTENTOS POR CLIENTE/DÍA — el patrón "vendedor dando vueltas"
--     Debería reducirse conforme `ok_tracking` empiece a aprobar.
-- -----------------------------------------------------------------------------
SELECT TOP 10
       CAST(fecha AS DATE) AS dia,
       idUsuario,
       idCliente,
       COUNT(*) AS intentos,
       MIN(fecha) AS primer_intento,
       MAX(fecha) AS ultimo_intento
FROM dbo.BitacoraValidacionUbicacionMovil
WHERE sucursal = @sucursal
  AND fecha >= @desde
GROUP BY CAST(fecha AS DATE), idUsuario, idCliente
HAVING COUNT(*) >= 3
ORDER BY intentos DESC, dia DESC;

-- -----------------------------------------------------------------------------
-- R4) AUDITORÍA DETALLE de cada `ok_tracking`
--     Vacía = todavía no se ha ejercitado en la sucursal.
-- -----------------------------------------------------------------------------
SELECT id, fecha, idUsuario, idCliente,
       metrosPermitidos,
       CAST(dist_reportada  AS DECIMAL(10,1)) AS dist_reportada_m,
       CAST(dist_evidencia  AS DECIMAL(10,1)) AS dist_evidencia_m,
       edad_evidencia_seg,
       CAST(precision_evidencia AS DECIMAL(10,1)) AS precision_evidencia_m,
       CASE
         WHEN dist_evidencia IS NULL                                     THEN 'SIN EVIDENCIA'
         WHEN edad_evidencia_seg > 300                                   THEN 'EVIDENCIA VIEJA'
         WHEN dist_evidencia > metrosPermitidos                          THEN 'FUERA DE RADIO'
         WHEN ABS(dist_reportada - dist_evidencia) > 1                   THEN 'DISTANCIA INCOHERENTE'
         ELSE 'OK'
       END AS estado
FROM #okt_eval
ORDER BY fecha DESC;

-- -----------------------------------------------------------------------------
-- R5) EFECTO COLATERAL — reubicaciones de la sucursal
--     `ok_tracking` debería reducirlas: el vendedor ya no necesita "arreglar"
--     la georreferencia para poder vender.
-- -----------------------------------------------------------------------------
SELECT CAST(fechaRegistro AS DATE) AS dia,
       COUNT(*) AS reubicaciones,
       COUNT(DISTINCT cveCliente) AS clientes
FROM tempreubicacionesmovil
WHERE sucursal = @sucursal
  AND fechaRegistro >= @desde
GROUP BY CAST(fechaRegistro AS DATE)
ORDER BY dia;
