-- =============================================================================
-- Clientes que tuvieron validaciones "fuera_de_rango" y "ok" en el mismo día.
-- Sirve para detectar casos donde:
--   a) El GPS necesitó varios intentos para estabilizarse (warm-up).
--   b) Distintos flujos de la app pasaron coordenadas diferentes del mismo cliente.
-- =============================================================================

-- Opción 1: Resumen por cliente/día (compacto, para barrido rápido)
SELECT
    sucursal,
    idCliente,
    c.nombre,
    CAST(fecha AS DATE) AS dia,
    SUM(CASE WHEN motivo = 'ok'         THEN 1 ELSE 0 END) AS intentos_ok,
    SUM(CASE WHEN motivo = 'ok_cache'   THEN 1 ELSE 0 END) AS intentos_cache,
    SUM(CASE WHEN motivo = 'fuera_de_rango' THEN 1 ELSE 0 END) AS intentos_fuera,
    COUNT(*) AS intentos_total,
    MIN(CASE WHEN motivo = 'fuera_de_rango' THEN distancia END) AS min_dist_fuera,
    MAX(CASE WHEN motivo = 'ok'         THEN distancia END) AS max_dist_ok,
    MIN(CASE WHEN motivo = 'fuera_de_rango' THEN accuracy  END) AS min_acc_fuera,
    MAX(CASE WHEN motivo = 'ok'         THEN accuracy  END) AS max_acc_ok,
    MIN(CASE WHEN motivo = 'fuera_de_rango' THEN clienteLatitud  END) AS lat_cliente_fuera,
    MIN(CASE WHEN motivo = 'ok'         THEN clienteLatitud  END) AS lat_cliente_ok,
    MIN(CASE WHEN motivo = 'fuera_de_rango' THEN clienteLongitud END) AS lng_cliente_fuera,
    MIN(CASE WHEN motivo = 'ok'         THEN clienteLongitud END) AS lng_cliente_ok
FROM BitacoraValidacionUbicacionMovil b
INNER JOIN cat_clientes_suc c ON b.idCliente = c.id
WHERE fecha >= '2026-07-25'
  AND sucursal = 16
  AND idCliente IS NOT NULL
GROUP BY sucursal, idCliente, c.nombre, CAST(fecha AS DATE)
HAVING SUM(CASE WHEN motivo = 'ok' OR motivo = 'ok_cache' THEN 1 ELSE 0 END) > 0
   AND SUM(CASE WHEN motivo = 'fuera_de_rango'       THEN 1 ELSE 0 END) > 0
ORDER BY dia, idCliente;


-- Opción 2: Detalle línea por línea (para investigar un caso específico)
SELECT
    b.fecha,
    c.nombre,
    b.id,
    b.idUsuario,
    b.sucursal,
    b.idCliente,
    b.motivo,
    b.valido,
    b.distancia,
    b.accuracy,
    b.metrosPermitidos,
    b.latitud,
    b.longitud,
    b.clienteLatitud,
    b.clienteLongitud,
    CASE
        WHEN TRY_CAST(c.latitud  AS FLOAT) IS NOT NULL
         AND TRY_CAST(c.longitud AS FLOAT) IS NOT NULL
         AND (ABS(ISNULL(b.clienteLatitud,   0) - ISNULL(TRY_CAST(c.latitud  AS FLOAT), 0)) > 0.0001
           OR ABS(ISNULL(b.clienteLongitud,  0) - ISNULL(TRY_CAST(c.longitud AS FLOAT), 0)) > 0.0001)
        THEN '*** COORDENADAS CLIENTE DIFIEREN DEL MAESTRO ***'
        ELSE NULL
    END AS alerta_coordenadas,
    c.latitud  AS cliente_lat_canonica,
    c.longitud AS cliente_lng_canonica,
    b.numFixes,
    b.peorAccuracy,
    b.tiempoMs,
    b.conCobertura,
    b.idLocal
FROM BitacoraValidacionUbicacionMovil b
INNER JOIN cat_clientes_suc c ON b.idCliente = c.id
WHERE b.fecha >= '2026-07-25'
  AND b.sucursal = 16
  AND b.idCliente IS NOT NULL
  AND EXISTS (
      SELECT 1
      FROM BitacoraValidacionUbicacionMovil b2
      WHERE b2.idCliente = b.idCliente
        AND CAST(b2.fecha AS DATE) = CAST(b.fecha AS DATE)
        AND b2.motivo IN ('ok', 'ok_cache')
  )
  AND EXISTS (
      SELECT 1
      FROM BitacoraValidacionUbicacionMovil b3
      WHERE b3.idCliente = b.idCliente
        AND CAST(b3.fecha AS DATE) = CAST(b.fecha AS DATE)
        AND b3.motivo = 'fuera_de_rango'
  )
ORDER BY b.idCliente, b.fecha;
