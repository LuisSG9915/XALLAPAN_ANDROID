-- =============================================================================
-- DIAGNÓSTICO DE UN `fuera_de_rango` CONTROVERTIDO
--
-- Caso típico: el vendedor asegura que estaba ENFRENTE del negocio, pero la
-- app midió cientos de metros y le bloqueó la venta.
--
-- Hay tres explicaciones posibles y este script las separa:
--   (1) el PIN DEL CLIENTE está movido — una lectura mala anterior lo reubicó
--       cientos de metros. El vendedor tiene razón y el bloqueo es falso.
--   (2) estaba en OTRO CLIENTE del catálogo (seleccionó la fila equivocada, o
--       hay dos registros del mismo negocio).
--   (3) la lectura de GPS era de una posición VIEJA (fix cacheado): pocos
--       fixes, resolución instantánea, pero accuracy "buena".
--
-- Uso:
--   1. Localizar la fila con la consulta del encabezado de abajo.
--   2. Poner su id en @idValidacion.
--   3. Ejecutar todo como UN SOLO lote (usa variables y #temporales).
--
-- Cómo localizarla (día, distancia y precisión que muestra el modal):
--   SELECT TOP 20 id, fecha, idUsuario, sucursal, idCliente, distancia, accuracy
--   FROM dbo.BitacoraValidacionUbicacionMovil
--   WHERE motivo = 'fuera_de_rango'
--     AND CAST(fecha AS DATE) = '2026-10-27'
--     AND distancia BETWEEN 410 AND 430
--     AND accuracy BETWEEN 10 AND 14;
--
-- Referencias:
--   docs/PLAN_GPS_INANICION_GNSS.md  §0.1 (caso 9949: falso fuera_de_rango →
--                                    reubicación → catálogo corrompido)
--   docs/CONSULTAS_AUDITORIA_GPS.md  (convenciones: latitud/longitud son texto)
-- =============================================================================

DECLARE @idValidacion INT = 0;

-- -----------------------------------------------------------------------------
-- 0) La fila auditada y sus variables de trabajo
-- -----------------------------------------------------------------------------
IF OBJECT_ID('tempdb..#v') IS NOT NULL DROP TABLE #v;

SELECT b.id, b.fecha, b.idUsuario, b.sucursal, b.idCliente, b.motivo,
       b.distancia, b.metrosPermitidos, b.accuracy, b.numFixes, b.tiempoMs,
       TRY_CAST(b.latitud         AS FLOAT) AS vlat,
       TRY_CAST(b.longitud        AS FLOAT) AS vlng,
       TRY_CAST(b.clienteLatitud  AS FLOAT) AS clat,
       TRY_CAST(b.clienteLongitud AS FLOAT) AS clng,
       b.versionApp
INTO #v
FROM dbo.BitacoraValidacionUbicacionMovil b
WHERE b.id = @idValidacion;

DECLARE @idUsuario INT, @sucursal INT, @idCliente INT, @fecha DATETIME,
        @vlat FLOAT, @vlng FLOAT, @clat FLOAT, @clng FLOAT,
        @fixes INT, @ms INT, @acc FLOAT;

SELECT @idUsuario = idUsuario, @sucursal = sucursal, @idCliente = idCliente,
       @fecha = fecha, @vlat = vlat, @vlng = vlng, @clat = clat, @clng = clng,
       @fixes = numFixes, @ms = tiempoMs, @acc = accuracy
FROM #v;

DECLARE @punto_ok BIT = CASE
        WHEN @vlat IS NULL OR @vlng IS NULL THEN 0
        WHEN @vlat NOT BETWEEN -90 AND 90 OR @vlng NOT BETWEEN -180 AND 180 THEN 0
        ELSE 1 END;
DECLARE @pin_ok BIT = CASE
        WHEN @clat IS NULL OR @clng IS NULL THEN 0
        WHEN @clat NOT BETWEEN -90 AND 90 OR @clng NOT BETWEEN -180 AND 180 THEN 0
        ELSE 1 END;

-- A) La validación, tal como quedó registrada
SELECT id, fecha, idUsuario, sucursal, idCliente, motivo, versionApp,
       CAST(distancia AS DECIMAL(10,1))       AS dist_reportada_m,
       CAST(metrosPermitidos AS DECIMAL(10,1)) AS permitido_m,
       CAST(accuracy AS DECIMAL(10,1))        AS accuracy_m,
       numFixes, tiempoMs,
       CASE
         WHEN numFixes <= 1 AND tiempoMs < 2500 AND accuracy <= 15
              THEN '3-LECTURA INSTANTANEA (posible fix heredado)'
         WHEN numFixes <= 2 AND tiempoMs < 5000
              THEN '2-POCA EVIDENCIA (2 o menos fixes)'
         WHEN numFixes >= 4 AND tiempoMs >= 4000
              THEN '1-LECTURA GENUINA (el bloqueo es real)'
         ELSE '4-AMBIGUA (revisar la linea de tiempo)'
       END AS calidad_lectura
FROM #v;

-- -----------------------------------------------------------------------------
-- B) ¿El punto reportado coincide con la visita ANTERIOR del mismo vendedor?
--    Si la distancia es de metros, la app midió donde estuvo hace rato: el
--    bloqueo es falso y el vendedor está enfrente.
-- -----------------------------------------------------------------------------
IF OBJECT_ID('tempdb..#ant') IS NOT NULL DROP TABLE #ant;

SELECT TOP 1 b.id, b.fecha, b.idCliente, b.motivo,
       TRY_CAST(b.latitud  AS FLOAT) AS lat,
       TRY_CAST(b.longitud AS FLOAT) AS lng
INTO #ant
FROM dbo.BitacoraValidacionUbicacionMovil b
WHERE b.idUsuario = @idUsuario
  AND b.motivo IN ('ok', 'ok_cache', 'ok_tracking')
  AND b.fecha >= DATEADD(HOUR, -3, @fecha)
  AND b.fecha <  @fecha
  AND b.latitud  IS NOT NULL
  AND b.longitud IS NOT NULL
ORDER BY b.fecha DESC;

DELETE FROM #ant
WHERE lat IS NULL OR lng IS NULL
   OR lat NOT BETWEEN -90  AND  90
   OR lng NOT BETWEEN -180 AND 180;

IF @punto_ok = 1
BEGIN
    SELECT a.fecha AS ultima_visita_ok,
           a.idCliente AS cliente_anterior,
           CAST(geography::Point(@vlat, @vlng, 4326)
                .STDistance(geography::Point(a.lat, a.lng, 4326))
                AS DECIMAL(10,1)) AS dist_punto_reportado_a_visita_anterior_m,
           CASE WHEN geography::Point(@vlat, @vlng, 4326)
                     .STDistance(geography::Point(a.lat, a.lng, 4326)) <= 40
                THEN 'SOSPECHOSO: el punto reportado es el cliente anterior'
                ELSE 'No coincide con la visita anterior' END AS veredicto
    FROM #ant a;
END
ELSE
    SELECT 'La fila no guardo una posicion de vendedor utilizable.' AS aviso;

-- -----------------------------------------------------------------------------
-- C) Linea de tiempo del tracking +-15 min alrededor del intento
--    Muestra donde estuvo el telefono de verdad y a que distancia del pin.
-- -----------------------------------------------------------------------------
IF OBJECT_ID('tempdb..#trk') IS NOT NULL DROP TABLE #trk;

SELECT t.fecha,
       TRY_CAST(t.precisionM AS FLOAT) AS acc,
       TRY_CAST(t.latitud    AS FLOAT) AS lat,
       TRY_CAST(t.longitud   AS FLOAT) AS lng
INTO #trk
FROM dbo.BitacoraTrackingGpsMovil t
WHERE t.idUsuario = @idUsuario
  AND t.fecha >= DATEADD(MINUTE, -15, @fecha)
  AND t.fecha <= DATEADD(MINUTE,  15, @fecha);

DELETE FROM #trk
WHERE lat IS NULL OR lng IS NULL
   OR lat NOT BETWEEN -90  AND  90
   OR lng NOT BETWEEN -180 AND 180;

IF @pin_ok = 1 AND @punto_ok = 1
BEGIN
    SELECT TOP 60
           fecha,
           CAST(acc AS DECIMAL(6,1)) AS accuracy_m,
           CAST(geography::Point(lat, lng, 4326)
                .STDistance(geography::Point(@clat, @clng, 4326))
                AS DECIMAL(10,1)) AS dist_al_pin_del_cliente_m,
           CAST(geography::Point(lat, lng, 4326)
                .STDistance(geography::Point(@vlat, @vlng, 4326))
                AS DECIMAL(10,1)) AS dist_al_punto_reportado_m
    FROM #trk
    ORDER BY ABS(DATEDIFF(SECOND, fecha, @fecha)) ASC;
END
ELSE
    SELECT 'Sin pin de cliente valido: no se puede medir la linea de tiempo.' AS aviso;

-- -----------------------------------------------------------------------------
-- D) ¿Estaba EN OTRO CLIENTE? Clientes del catalogo a menos de 60 m del punto
--    reportado. Si aparece uno, el vendedor si estaba enfrente... de otro.
-- -----------------------------------------------------------------------------
IF OBJECT_ID('tempdb..#cli') IS NOT NULL DROP TABLE #cli;

SELECT c.id,
       TRY_CAST(c.latitud  AS FLOAT) AS lat,
       TRY_CAST(c.longitud AS FLOAT) AS lng
INTO #cli
FROM cat_clientes_suc c;

DELETE FROM #cli
WHERE lat IS NULL OR lng IS NULL
   OR lat NOT BETWEEN -90  AND  90
   OR lng NOT BETWEEN -180 AND 180;

IF @punto_ok = 1
BEGIN
    SELECT TOP 10
           cl.id AS cliente_cercano,
           CAST(geography::Point(@vlat, @vlng, 4326)
                .STDistance(geography::Point(cl.lat, cl.lng, 4326))
                AS DECIMAL(10,1)) AS metros_desde_el_punto_reportado
    FROM #cli cl
    WHERE geography::Point(@vlat, @vlng, 4326)
          .STDistance(geography::Point(cl.lat, cl.lng, 4326)) <= 60
    ORDER BY metros_desde_el_punto_reportado;
END

-- -----------------------------------------------------------------------------
-- E) Historial de reubicaciones del cliente: ¿el pin fue movido?
--    Muchas filas con coordenadas distintas = el pin se ha reescrito varias
--    veces; la ultima reubicacion explica un desplazamiento de cientos de metros.
-- -----------------------------------------------------------------------------
IF OBJECT_ID('tempdb..#reub') IS NOT NULL DROP TABLE #reub;

SELECT r.id, r.cveCliente, r.usuario, r.sucursal, r.fechaRegistro,
       TRY_CAST(r.latitudNueva  AS FLOAT) AS lat,
       TRY_CAST(r.longitudNueva AS FLOAT) AS lng
INTO #reub
FROM tempreubicacionesmovil r
WHERE CAST(r.cveCliente AS VARCHAR(50)) = CAST(@idCliente AS VARCHAR(50));

DELETE FROM #reub
WHERE lat IS NULL OR lng IS NULL
   OR lat NOT BETWEEN -90  AND  90
   OR lng NOT BETWEEN -180 AND 180;

SELECT id, usuario, sucursal, fechaRegistro,
       CAST(lat AS DECIMAL(10,7)) AS lat_nueva,
       CAST(lng AS DECIMAL(10,7)) AS lng_nueva,
       CASE WHEN @pin_ok = 0 THEN NULL
            ELSE CAST(geography::Point(lat, lng, 4326)
                      .STDistance(geography::Point(@clat, @clng, 4326))
                      AS DECIMAL(10,1))
       END AS metros_del_pin_usado_en_la_validacion
FROM #reub
ORDER BY fechaRegistro DESC;

-- Pin vigente del catalogo vs pin que uso la validacion
IF OBJECT_ID('tempdb..#pin_cat') IS NOT NULL DROP TABLE #pin_cat;

SELECT c.id,
       TRY_CAST(c.latitud  AS FLOAT) AS lat,
       TRY_CAST(c.longitud AS FLOAT) AS lng
INTO #pin_cat
FROM cat_clientes_suc c
WHERE CAST(c.id AS VARCHAR(50)) = CAST(@idCliente AS VARCHAR(50));

DELETE FROM #pin_cat
WHERE lat IS NULL OR lng IS NULL
   OR lat NOT BETWEEN -90  AND  90
   OR lng NOT BETWEEN -180 AND 180;

SELECT p.id,
       CAST(p.lat AS DECIMAL(10,7)) AS lat_catalogo,
       CAST(p.lng AS DECIMAL(10,7)) AS lng_catalogo,
       CASE WHEN @pin_ok = 0 THEN NULL
            ELSE CAST(geography::Point(p.lat, p.lng, 4326)
                      .STDistance(geography::Point(@clat, @clng, 4326))
                      AS DECIMAL(10,1))
       END AS metros_pin_usado_vs_catalogo
FROM #pin_cat p;

-- -----------------------------------------------------------------------------
-- F) ¿De dónde salió el punto reportado?
--    Compara la posicion que reporto la validacion contra TODO el tracking del
--    dia del vendedor y muestra los 5 puntos mas cercanos a ella.
--      * Si el mas cercano es de hace 10-20 min  -> fix RANCIO reutilizado.
--      * Si NINGUN punto del dia se le acerca    -> el receptor SALTO (multipath
--        o posicion de red/WiFi) y el accuracy declarado es ficcion.
-- -----------------------------------------------------------------------------
IF OBJECT_ID('tempdb..#dia') IS NOT NULL DROP TABLE #dia;

SELECT t.fecha,
       TRY_CAST(t.precisionM AS FLOAT) AS acc,
       TRY_CAST(t.latitud    AS FLOAT) AS lat,
       TRY_CAST(t.longitud   AS FLOAT) AS lng
INTO #dia
FROM dbo.BitacoraTrackingGpsMovil t
WHERE t.idUsuario = @idUsuario
  AND t.fecha >= DATEADD(HOUR, -6, @fecha)
  AND t.fecha <= DATEADD(HOUR,  6, @fecha);

DELETE FROM #dia
WHERE lat IS NULL OR lng IS NULL
   OR lat NOT BETWEEN -90  AND  90
   OR lng NOT BETWEEN -180 AND 180;

IF @punto_ok = 1
BEGIN
    SELECT TOP 5
           d.fecha,
           DATEDIFF(SECOND, d.fecha, @fecha)   AS seg_respecto_al_intento,
           CAST(d.acc AS DECIMAL(6,1))         AS acc_tracking,
           CAST(geography::Point(@vlat, @vlng, 4326)
                .STDistance(geography::Point(d.lat, d.lng, 4326))
                AS DECIMAL(10,1))              AS dist_punto_reportado_m,
           CASE WHEN d.fecha < DATEADD(MINUTE, -3, @fecha)
                    AND geography::Point(@vlat, @vlng, 4326)
                        .STDistance(geography::Point(d.lat, d.lng, 4326)) <= 30
                THEN 'FIX RANCIO: coincide con una posicion de antes'
                WHEN geography::Point(@vlat, @vlng, 4326)
                     .STDistance(geography::Point(d.lat, d.lng, 4326)) <= 30
                THEN 'Coincide con tracking del momento'
                ELSE 'Sin coincidencia (posible salto de receptor)'
           END                                 AS veredicto
    FROM #dia d
    ORDER BY geography::Point(@vlat, @vlng, 4326)
             .STDistance(geography::Point(d.lat, d.lng, 4326)) ASC;
END
ELSE
    SELECT 'La fila no guardo una posicion de vendedor utilizable.' AS aviso;
