-- =============================================================================
-- CONSULTAS PARA ANALÍTICA DE RECORRIDO DE VENDEDORES
-- Tabla: BitacoraValidacionUbicacionMovil (filtro: motivo LIKE 'recorrido%')
-- Clientes: cat_clientes_suc
-- =============================================================================

-- =============================================================================
-- 1. MAPA DE RECORRIDO EN TIEMPO REAL / HISTÓRICO
-- Traza la ruta exacta de un vendedor con línea de tiempo.
-- =============================================================================

-- 1a. Recorrido de un vendedor en una fecha, ordenado cronológicamente
CREATE PROCEDURE [dbo].[sp_RecorridoVendedorDia]
    @idUsuario INT,
    @sucursal INT,
    @fecha DATE
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        id,
        idLocal,
        fecha,
        motivo,
        latitud,
        longitud,
        accuracy,
        peorAccuracy,
        conCobertura,
        numeroFila = ROW_NUMBER() OVER (ORDER BY fecha)
    FROM [dbo].[BitacoraValidacionUbicacionMovil]
    WHERE idUsuario    = @idUsuario
      AND sucursal     = @sucursal
      AND CAST(fecha AS DATE) = @fecha
      AND motivo LIKE 'recorrido%'
      AND latitud IS NOT NULL
      AND longitud IS NOT NULL
    ORDER BY fecha;
END
GO

-- 1b. Última posición conocida de cada vendedor activo hoy (tiempo real)
CREATE PROCEDURE [dbo].[sp_RecorridoPosicionesActuales]
    @sucursal INT
AS
BEGIN
    SET NOCOUNT ON;

    WITH ultima_posicion AS (
        SELECT
            idUsuario,
            latitud,
            longitud,
            accuracy,
            motivo,
            conCobertura,
            fecha,
            ROW_NUMBER() OVER (PARTITION BY idUsuario ORDER BY fecha DESC) AS rn
        FROM [dbo].[BitacoraValidacionUbicacionMovil]
        WHERE sucursal = @sucursal
          AND motivo LIKE 'recorrido%'
          AND CAST(fecha AS DATE) = CAST(GETDATE() AS DATE)
          AND latitud IS NOT NULL
    )
    SELECT
        idUsuario,
        latitud,
        longitud,
        accuracy,
        motivo,
        conCobertura,
        fecha AS ultimaActualizacion,
        DATEDIFF(MINUTE, fecha, GETDATE()) AS minutosDesdeUltimoReporte
    FROM ultima_posicion
    WHERE rn = 1
    ORDER BY minutosDesdeUltimoReporte;
END
GO

-- =============================================================================
-- 2. PANEL DE ACTIVIDAD DEL VENDEDOR
-- Tiempo total en ruta, distancia, actividad por hora, paradas detectadas.
-- =============================================================================

-- 2a. Resumen diario: tiempo en ruta y distancia estimada
CREATE PROCEDURE [dbo].[sp_RecorridoResumenDiario]
    @idUsuario INT,
    @sucursal INT,
    @fecha DATE
AS
BEGIN
    SET NOCOUNT ON;

    -- Usamos la fórmula de Haversine para calcular distancia entre puntos consecutivos
    WITH recorrido_ordenado AS (
        SELECT
            idUsuario,
            fecha,
            motivo,
            latitud,
            longitud,
            accuracy,
            conCobertura,
            ROW_NUMBER() OVER (ORDER BY fecha) AS seq
        FROM [dbo].[BitacoraValidacionUbicacionMovil]
        WHERE idUsuario    = @idUsuario
          AND sucursal     = @sucursal
          AND CAST(fecha AS DATE) = @fecha
          AND motivo LIKE 'recorrido%'
          AND latitud IS NOT NULL
          AND longitud IS NOT NULL
    ),
    con_distancia AS (
        SELECT
            a.seq,
            a.fecha,
            a.motivo,
            a.latitud,
            a.longitud,
            a.accuracy,
            a.conCobertura,
            distancia_metros = CASE
                WHEN b.latitud IS NOT NULL THEN
                    -- Haversine simplificado en metros
                    6371000 * 2 * ATN2(
                        SQRT(
                            POWER(SIN((RADIANS(a.latitud) - RADIANS(b.latitud)) / 2), 2) +
                            COS(RADIANS(b.latitud)) * COS(RADIANS(a.latitud)) *
                            POWER(SIN((RADIANS(a.longitud) - RADIANS(b.longitud)) / 2), 2)
                        ),
                        SQRT(1 - (
                            POWER(SIN((RADIANS(a.latitud) - RADIANS(b.latitud)) / 2), 2) +
                            COS(RADIANS(b.latitud)) * COS(RADIANS(a.latitud)) *
                            POWER(SIN((RADIANS(a.longitud) - RADIANS(b.longitud)) / 2), 2)
                        ))
                    )
                ELSE 0
            END
        FROM recorrido_ordenado a
        LEFT JOIN recorrido_ordenado b ON a.seq = b.seq + 1
    ),
    paradas AS (
        SELECT
            idUsuario,
            fecha_parada = MIN(fecha),
            latitud,
            longitud,
            duracion_minutos = DATEDIFF(MINUTE, MIN(fecha), MAX(fecha))
        FROM (
            SELECT
                idUsuario,
                fecha,
                latitud,
                longitud,
                grupo = SUM(gap_flag) OVER (ORDER BY fecha)
            FROM (
                SELECT
                    idUsuario,
                    fecha,
                    latitud,
                    longitud,
                    gap_flag = CASE
                        WHEN DATEDIFF(MINUTE, LAG(fecha) OVER (ORDER BY fecha), fecha) > 5
                             OR (6371000 * 2 * ATN2(
                                 SQRT(POWER(SIN((RADIANS(latitud) - RADIANS(LAG(latitud) OVER (ORDER BY fecha))) / 2), 2) +
                                      COS(RADIANS(LAG(latitud) OVER (ORDER BY fecha))) * COS(RADIANS(latitud)) *
                                      POWER(SIN((RADIANS(longitud) - RADIANS(LAG(longitud) OVER (ORDER BY fecha))) / 2), 2)),
                                 SQRT(1 - (POWER(SIN((RADIANS(latitud) - RADIANS(LAG(latitud) OVER (ORDER BY fecha))) / 2), 2) +
                                      COS(RADIANS(LAG(latitud) OVER (ORDER BY fecha))) * COS(RADIANS(latitud)) *
                                      POWER(SIN((RADIANS(longitud) - RADIANS(LAG(longitud) OVER (ORDER BY fecha))) / 2), 2)))
                             )) < 10
                        THEN 0 ELSE 1
                    END
                FROM [dbo].[BitacoraValidacionUbicacionMovil]
                WHERE idUsuario = @idUsuario
                  AND sucursal  = @sucursal
                  AND CAST(fecha AS DATE) = @fecha
                  AND motivo LIKE 'recorrido%'
                  AND latitud IS NOT NULL
            ) sub
        ) grupos
        GROUP BY idUsuario, latitud, longitud, grupo
        HAVING DATEDIFF(MINUTE, MIN(fecha), MAX(fecha)) >= 5
    )
    SELECT
        idUsuario     = @idUsuario,
        sucursal      = @sucursal,
        fecha         = @fecha,
        horaInicio    = MIN(cd.fecha),
        horaFin       = MAX(cd.fecha),
        minutosEnRuta = DATEDIFF(MINUTE, MIN(cd.fecha), MAX(cd.fecha)),
        puntosGPS     = COUNT(*),
        distanciaTotalMetros   = CAST(SUM(cd.distancia_metros) AS DECIMAL(10,1)),
        distanciaAproxKm       = CAST(SUM(cd.distancia_metros) / 1000 AS DECIMAL(10,2)),
        tramosConCobertura     = SUM(CASE WHEN cd.conCobertura = 1 THEN 1 ELSE 0 END),
        tramosSinCobertura     = SUM(CASE WHEN cd.conCobertura = 0 THEN 1 ELSE 0 END),
        pctCobertura           = CAST(SUM(CASE WHEN cd.conCobertura = 1 THEN 1.0 ELSE 0 END) / NULLIF(COUNT(*), 0) * 100 AS DECIMAL(5,1)),
        accuracyPromedio       = CAST(AVG(cd.accuracy) AS DECIMAL(10,1)),
        paradasDetectadas      = (SELECT COUNT(*) FROM paradas),
        tiempoTotalParadasMin  = (SELECT ISNULL(SUM(duracion_minutos), 0) FROM paradas)
    FROM con_distancia cd;
END
GO

-- 2b. Actividad por hora (barras)
CREATE PROCEDURE [dbo].[sp_RecorridoActividadPorHora]
    @idUsuario INT,
    @sucursal INT,
    @fecha DATE
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        hora = DATEPART(HOUR, fecha),
        puntosGPS         = COUNT(*),
        tramosApp         = SUM(CASE WHEN motivo = 'recorrido_app'         THEN 1 ELSE 0 END),
        tramosPantallaOn  = SUM(CASE WHEN motivo = 'recorrido_pantalla_a' THEN 1 ELSE 0 END),
        tramosPantallaOff = SUM(CASE WHEN motivo = 'recorrido_pantalla_e' THEN 1 ELSE 0 END),
        conCobertura      = SUM(CASE WHEN conCobertura = 1 THEN 1 ELSE 0 END),
        sinCobertura      = SUM(CASE WHEN conCobertura = 0 THEN 1 ELSE 0 END),
        accuracyPromedio  = CAST(AVG(accuracy) AS DECIMAL(10,1))
    FROM [dbo].[BitacoraValidacionUbicacionMovil]
    WHERE idUsuario    = @idUsuario
      AND sucursal     = @sucursal
      AND CAST(fecha AS DATE) = @fecha
      AND motivo LIKE 'recorrido%'
    GROUP BY DATEPART(HOUR, fecha)
    ORDER BY hora;
END
GO

-- =============================================================================
-- 3. REPORTE DE PRECISIÓN GPS
-- Identifica puntos con accuracy alta (>30m) y zonas problemáticas.
-- =============================================================================

CREATE PROCEDURE [dbo].[sp_RecorridoPrecisionGPS]
    @idUsuario INT,
    @sucursal INT,
    @fecha DATE,
    @umbralAccuracy FLOAT = 30  -- metros de accuracy considerados "malos"
AS
BEGIN
    SET NOCOUNT ON;

    -- 3a. Todos los puntos con accuracy alta (mala precisión)
    SELECT
        id,
        fecha,
        motivo,
        latitud,
        longitud,
        accuracy,
        peorAccuracy,
        numFixes,
        conCobertura,
        clasificacion = CASE
            WHEN accuracy <= 15 THEN 'Excelente'
            WHEN accuracy <= 30 THEN 'Buena'
            WHEN accuracy <= 50 THEN 'Regular'
            ELSE 'Mala'
        END
    FROM [dbo].[BitacoraValidacionUbicacionMovil]
    WHERE idUsuario    = @idUsuario
      AND sucursal     = @sucursal
      AND CAST(fecha AS DATE) = @fecha
      AND motivo LIKE 'recorrido%'
      AND accuracy IS NOT NULL
    ORDER BY accuracy DESC;

    -- 3b. Resumen de calidad GPS por hora
    SELECT
        hora = DATEPART(HOUR, fecha),
        puntosGPS      = COUNT(*),
        accuracyMin    = CAST(MIN(accuracy) AS DECIMAL(10,1)),
        accuracyMax    = CAST(MAX(accuracy) AS DECIMAL(10,1)),
        accuracyAvg    = CAST(AVG(accuracy) AS DECIMAL(10,1)),
        peorAvg        = CAST(AVG(peorAccuracy) AS DECIMAL(10,1)),
        puntosMalos    = SUM(CASE WHEN accuracy > @umbralAccuracy THEN 1 ELSE 0 END),
        pctMalos       = CAST(SUM(CASE WHEN accuracy > @umbralAccuracy THEN 1.0 ELSE 0 END) / NULLIF(COUNT(*), 0) * 100 AS DECIMAL(5,1))
    FROM [dbo].[BitacoraValidacionUbicacionMovil]
    WHERE idUsuario    = @idUsuario
      AND sucursal     = @sucursal
      AND CAST(fecha AS DATE) = @fecha
      AND motivo LIKE 'recorrido%'
      AND accuracy IS NOT NULL
    GROUP BY DATEPART(HOUR, fecha)
    ORDER BY hora;
END
GO

-- =============================================================================
-- 4. COBERTURA DE RED EN RUTA
-- Mapa de calor de zonas sin cobertura.
-- =============================================================================

-- 4a. Puntos sin cobertura (para mapear)
CREATE PROCEDURE [dbo].[sp_RecorridoSinCobertura]
    @sucursal INT,
    @fechaDesde DATE,
    @fechaHasta DATE = NULL
AS
BEGIN
    SET NOCOUNT ON;

    IF @fechaHasta IS NULL SET @fechaHasta = @fechaDesde;

    SELECT
        idUsuario,
        fecha,
        motivo,
        latitud,
        longitud,
        accuracy,
        conCobertura
    FROM [dbo].[BitacoraValidacionUbicacionMovil]
    WHERE sucursal = @sucursal
      AND CAST(fecha AS DATE) BETWEEN @fechaDesde AND @fechaHasta
      AND motivo LIKE 'recorrido%'
      AND conCobertura = 0
      AND latitud IS NOT NULL
    ORDER BY fecha;
END
GO

-- 4b. Resumen de cobertura por vendedor y día
CREATE PROCEDURE [dbo].[sp_RecorridoResumenCobertura]
    @sucursal INT,
    @fechaDesde DATE,
    @fechaHasta DATE = NULL
AS
BEGIN
    SET NOCOUNT ON;

    IF @fechaHasta IS NULL SET @fechaHasta = @fechaDesde;

    SELECT
        idUsuario,
        dia = CAST(fecha AS DATE),
        totalPuntos        = COUNT(*),
        puntosConCobertura = SUM(CASE WHEN conCobertura = 1 THEN 1 ELSE 0 END),
        puntosSinCobertura = SUM(CASE WHEN conCobertura = 0 THEN 1 ELSE 0 END),
        pctCobertura       = CAST(SUM(CASE WHEN conCobertura = 1 THEN 1.0 ELSE 0 END) / NULLIF(COUNT(*), 0) * 100 AS DECIMAL(5,1)),
        -- Agrupar rachas sin cobertura
        rachasSinCobertura = (
            SELECT COUNT(*)
            FROM (
                SELECT
                    grupo = SUM(esSinCobertura_nuevo) OVER (PARTITION BY CAST(fecha AS DATE) ORDER BY fecha)
                FROM (
                    SELECT
                        fecha,
                        esSinCobertura_nuevo = CASE
                            WHEN conCobertura = 0
                             AND (LAG(conCobertura) OVER (PARTITION BY CAST(fecha AS DATE) ORDER BY fecha) IS NULL
                               OR LAG(conCobertura) OVER (PARTITION BY CAST(fecha AS DATE) ORDER BY fecha) = 1)
                            THEN 1 ELSE 0
                        END
                    FROM [dbo].[BitacoraValidacionUbicacionMovil] b
                    WHERE b.idUsuario = a.idUsuario
                      AND CAST(b.fecha AS DATE) = CAST(a.fecha AS DATE)
                      AND b.motivo LIKE 'recorrido%'
                ) gaps
            ) grupos WHERE grupo > 0
        ),
        rachaMaxSinCoberturaMin = (
            SELECT ISNULL(MAX(duracion), 0)
            FROM (
                SELECT
                    duracion = DATEDIFF(MINUTE, MIN(fecha), MAX(fecha))
                FROM (
                    SELECT fecha, grupo = SUM(gap) OVER (ORDER BY fecha)
                    FROM (
                        SELECT
                            fecha,
                            gap = CASE WHEN conCobertura = 0
                                        AND (LAG(conCobertura) OVER (ORDER BY fecha) IS NULL
                                          OR LAG(conCobertura) OVER (ORDER BY fecha) = 1)
                                       THEN 1 ELSE 0 END
                        FROM [dbo].[BitacoraValidacionUbicacionMovil] b
                        WHERE b.idUsuario = a.idUsuario
                          AND CAST(b.fecha AS DATE) = CAST(a.fecha AS DATE)
                          AND b.motivo LIKE 'recorrido%'
                          AND b.conCobertura = 0
                    ) gaps
                ) grupos
                GROUP BY grupo
            ) rachas
        )
    FROM [dbo].[BitacoraValidacionUbicacionMovil] a
    WHERE sucursal = @sucursal
      AND CAST(fecha AS DATE) BETWEEN @fechaDesde AND @fechaHasta
      AND motivo LIKE 'recorrido%'
      AND latitud IS NOT NULL
    GROUP BY idUsuario, CAST(fecha AS DATE)
    ORDER BY dia, pctCobertura;
END
GO

-- 4c. Vista agregada: cluster de puntos sin cobertura para heatmap
CREATE PROCEDURE [dbo].[sp_RecorridoHeatmapSinCobertura]
    @sucursal INT,
    @fechaDesde DATE,
    @fechaHasta DATE = NULL,
    @precisionDecimal INT = 4  -- agrupar coordenadas con N decimales (4 = ~11m)
AS
BEGIN
    SET NOCOUNT ON;

    IF @fechaHasta IS NULL SET @fechaHasta = @fechaDesde;

    SELECT
        lat  = ROUND(latitud, @precisionDecimal),
        lng  = ROUND(longitud, @precisionDecimal),
        cantidadPuntos = COUNT(*),
        vendedoresAfectados = COUNT(DISTINCT idUsuario),
        accuracyPromedio = CAST(AVG(accuracy) AS DECIMAL(10,1))
    FROM [dbo].[BitacoraValidacionUbicacionMovil]
    WHERE sucursal = @sucursal
      AND CAST(fecha AS DATE) BETWEEN @fechaDesde AND @fechaHasta
      AND motivo LIKE 'recorrido%'
      AND conCobertura = 0
      AND latitud IS NOT NULL
    GROUP BY ROUND(latitud, @precisionDecimal), ROUND(longitud, @precisionDecimal)
    HAVING COUNT(*) >= 3  -- mínimo 3 registros para considerar zona muerta
    ORDER BY cantidadPuntos DESC;
END
GO

-- =============================================================================
-- 5. RECORRIDO DEL DÍA — RESUMEN DIARIO CONSOLIDADO
-- Para dashboard de supervisor: todos los vendedores de una sucursal.
-- =============================================================================

CREATE PROCEDURE [dbo].[sp_RecorridoResumenSucursal]
    @sucursal INT,
    @fecha DATE
AS
BEGIN
    SET NOCOUNT ON;

    WITH recorridos AS (
        SELECT
            idUsuario,
            fecha,
            latitud,
            longitud,
            accuracy,
            conCobertura,
            ROW_NUMBER() OVER (PARTITION BY idUsuario ORDER BY fecha) AS seq
        FROM [dbo].[BitacoraValidacionUbicacionMovil]
        WHERE sucursal = @sucursal
          AND CAST(fecha AS DATE) = @fecha
          AND motivo LIKE 'recorrido%'
          AND latitud IS NOT NULL
    ),
    con_delta AS (
        SELECT
            a.idUsuario,
            a.fecha,
            a.latitud,
            a.longitud,
            a.accuracy,
            a.conCobertura,
            delta_m = CASE
                WHEN b.latitud IS NOT NULL THEN
                    6371000 * 2 * ATN2(
                        SQRT(
                            POWER(SIN((RADIANS(a.latitud) - RADIANS(b.latitud)) / 2), 2) +
                            COS(RADIANS(b.latitud)) * COS(RADIANS(a.latitud)) *
                            POWER(SIN((RADIANS(a.longitud) - RADIANS(b.longitud)) / 2), 2)
                        ),
                        SQRT(1 - (
                            POWER(SIN((RADIANS(a.latitud) - RADIANS(b.latitud)) / 2), 2) +
                            COS(RADIANS(b.latitud)) * COS(RADIANS(a.latitud)) *
                            POWER(SIN((RADIANS(a.longitud) - RADIANS(b.longitud)) / 2), 2)
                        ))
                    )
                ELSE 0
            END
        FROM recorridos a
        LEFT JOIN recorridos b ON a.idUsuario = b.idUsuario AND a.seq = b.seq + 1
    ),
    heatmap AS (
        SELECT
            idUsuario,
            lat  = ROUND(latitud, 4),
            lng  = ROUND(longitud, 4),
            visitas = COUNT(*)
        FROM recorridos
        GROUP BY idUsuario, ROUND(latitud, 4), ROUND(longitud, 4)
    )
    SELECT
        r.idUsuario,
        horaInicio       = MIN(r.fecha),
        horaFin          = MAX(r.fecha),
        horasEnRuta      = CAST(DATEDIFF(MINUTE, MIN(r.fecha), MAX(r.fecha)) / 60.0 AS DECIMAL(5,1)),
        puntosGPS        = COUNT(*),
        distanciaKm      = CAST(SUM(r.delta_m) / 1000 AS DECIMAL(10,2)),
        accuracyPromedio = CAST(AVG(r.accuracy) AS DECIMAL(10,1)),
        pctCobertura     = CAST(SUM(CASE WHEN r.conCobertura = 1 THEN 1.0 ELSE 0 END) / NULLIF(COUNT(*), 0) * 100 AS DECIMAL(5,1)),
        zonaMasVisitada  = STUFF((
            SELECT TOP 1 CONCAT(' (', lat, ',', lng, ') x', visitas)
            FROM heatmap h
            WHERE h.idUsuario = r.idUsuario
            ORDER BY visitas DESC
            FOR XML PATH(''), TYPE
        ).value('.', 'NVARCHAR(MAX)'), 1, 0, '')
    FROM con_delta r
    GROUP BY r.idUsuario
    ORDER BY r.idUsuario;
END
GO

-- =============================================================================
-- 6. VALIDACIÓN DE RUTA ASIGNADA VS REAL
-- Cruza si el vendedor pasó cerca del cliente usando la tolerancia.
-- Datos de validación: motivo IN ('ok','ok_cache','fuera_de_rango')
-- =============================================================================

-- 6a. Clientes visitados vs recorrido GPS: ¿el vendedor estuvo cerca?
CREATE PROCEDURE [dbo].[sp_RecorridoValidacionRuta]
    @idUsuario INT,
    @sucursal INT,
    @fecha DATE
AS
BEGIN
    SET NOCOUNT ON;

    WITH validaciones AS (
        SELECT
            v.id,
            v.fecha,
            v.idCliente,
            c.nombre AS nombreCliente,
            v.motivo,
            v.valido,
            v.distancia,
            v.accuracy,
            v.metrosPermitidos,
            v.latitud AS latVendedor,
            v.longitud AS lngVendedor,
            v.clienteLatitud,
            v.clienteLongitud,
            c.latitud AS clienteLatCanonica,
            c.longitud AS clienteLngCanonica,
            v.numFixes,
            v.peorAccuracy,
            v.tiempoMs,
            v.conCobertura
        FROM [dbo].[BitacoraValidacionUbicacionMovil] v
        LEFT JOIN cat_clientes_suc c ON v.idCliente = c.id
        WHERE v.idUsuario = @idUsuario
          AND v.sucursal  = @sucursal
          AND CAST(v.fecha AS DATE) = @fecha
          AND v.idCliente IS NOT NULL
          AND v.motivo NOT LIKE 'recorrido%'
    ),
    resumen_cliente AS (
        SELECT
            idCliente,
            nombreCliente = MAX(nombreCliente),
            primerIntento = MIN(fecha),
            ultimoIntento = MAX(fecha),
            totalIntentos  = COUNT(*),
            intentosValidos = SUM(CASE WHEN valido = 1 THEN 1 ELSE 0 END),
            intentosInvalidos = SUM(CASE WHEN valido = 0 THEN 1 ELSE 0 END),
            distanciaMin = CAST(MIN(distancia) AS DECIMAL(10,1)),
            distanciaMax = CAST(MAX(distancia) AS DECIMAL(10,1)),
            distanciaAvg = CAST(AVG(distancia) AS DECIMAL(10,1)),
            metrosPermitidos = MAX(metrosPermitidos),
            aprobado = CASE WHEN SUM(CASE WHEN valido = 1 THEN 1 ELSE 0 END) > 0 THEN 1 ELSE 0 END,
            latCliente = MAX(clienteLatitud),
            lngCliente = MAX(clienteLongitud),
            motivoUltimo = (SELECT TOP 1 motivo FROM validaciones v2 WHERE v2.idCliente = v.idCliente ORDER BY fecha DESC)
        FROM validaciones v
        GROUP BY idCliente
    )
    SELECT
        rc.idCliente,
        rc.nombreCliente,
        rc.primerIntento,
        rc.ultimoIntento,
        rc.totalIntentos,
        rc.intentosValidos,
        rc.intentosInvalidos,
        rc.distanciaMin,
        rc.distanciaMax,
        rc.distanciaAvg,
        rc.metrosPermitidos,
        rc.aprobado,
        rc.latCliente,
        rc.lngCliente,
        rc.motivoUltimo,
        -- ¿El vendedor tiene GPS de recorrido cerca del cliente? (en un radio de 100m)
        pasoCerca = CASE
            WHEN EXISTS (
                SELECT 1
                FROM [dbo].[BitacoraValidacionUbicacionMovil] r
                WHERE r.idUsuario = @idUsuario
                  AND r.sucursal  = @sucursal
                  AND CAST(r.fecha AS DATE) = @fecha
                  AND r.motivo LIKE 'recorrido%'
                  AND r.latitud IS NOT NULL
                  AND rc.latCliente IS NOT NULL
                  AND (6371000 * 2 * ATN2(
                       SQRT(
                           POWER(SIN((RADIANS(r.latitud) - RADIANS(rc.latCliente)) / 2), 2) +
                           COS(RADIANS(rc.latCliente)) * COS(RADIANS(r.latitud)) *
                           POWER(SIN((RADIANS(r.longitud) - RADIANS(rc.lngCliente)) / 2), 2)
                       ),
                       SQRT(1 - (
                           POWER(SIN((RADIANS(r.latitud) - RADIANS(rc.latCliente)) / 2), 2) +
                           COS(RADIANS(rc.latCliente)) * COS(RADIANS(r.latitud)) *
                           POWER(SIN((RADIANS(r.longitud) - RADIANS(rc.lngCliente)) / 2), 2)
                       ))
                  )) <= 100
            ) THEN 1 ELSE 0
        END
    FROM resumen_cliente rc
    ORDER BY rc.primerIntento;
END
GO

-- 6b. Reporte consolidado: todos los vendedores vs clientes asignados
CREATE PROCEDURE [dbo].[sp_RecorridoCoberturaClientes]
    @sucursal INT,
    @fecha DATE
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        v.idUsuario,
        v.idCliente,
        c.nombre AS nombreCliente,
        totalIntentos = COUNT(*),
        intentosOk     = SUM(CASE WHEN v.motivo IN ('ok', 'ok_cache') THEN 1 ELSE 0 END),
        intentosFueraRango = SUM(CASE WHEN v.motivo = 'fuera_de_rango' THEN 1 ELSE 0 END),
        intentosOtros = SUM(CASE WHEN v.motivo NOT IN ('ok', 'ok_cache', 'fuera_de_rango') THEN 1 ELSE 0 END),
        seConcretoVisita = CASE WHEN SUM(CASE WHEN v.motivo IN ('ok', 'ok_cache') THEN 1 ELSE 0 END) > 0 THEN 1 ELSE 0 END,
        distanciaMinMetros = CAST(MIN(v.distancia) AS DECIMAL(10,1)),
        distanciaMaxMetros = CAST(MAX(v.distancia) AS DECIMAL(10,1)),
        metrosPermitidos   = MAX(v.metrosPermitidos),
        accuracyPromedio   = CAST(AVG(v.accuracy) AS DECIMAL(10,1))
    FROM [dbo].[BitacoraValidacionUbicacionMovil] v
    LEFT JOIN cat_clientes_suc c ON v.idCliente = c.id
    WHERE v.sucursal = @sucursal
      AND CAST(v.fecha AS DATE) = @fecha
      AND v.idCliente IS NOT NULL
      AND v.motivo NOT LIKE 'recorrido%'
    GROUP BY v.idUsuario, v.idCliente, c.nombre
    ORDER BY v.idUsuario, v.idCliente;
END
GO

-- =============================================================================
-- 7. PLAYBACK ANIMADO DEL RECORRIDO
-- Consulta paginada / por segmentos para animar en frontend.
-- =============================================================================

-- 7a. Recorrido completo en segmentos de N segundos para playback
CREATE PROCEDURE [dbo].[sp_RecorridoPlayback]
    @idUsuario INT,
    @sucursal INT,
    @fecha DATE,
    @intervaloSegundos INT = 30  -- agrupar cada N segundos
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @horaBase DATETIME;

    SELECT @horaBase = MIN(fecha)
    FROM [dbo].[BitacoraValidacionUbicacionMovil]
    WHERE idUsuario    = @idUsuario
      AND sucursal     = @sucursal
      AND CAST(fecha AS DATE) = @fecha
      AND motivo LIKE 'recorrido%'
      AND latitud IS NOT NULL;

    WITH puntos AS (
        SELECT
            fecha,
            latitud,
            longitud,
            accuracy,
            motivo,
            conCobertura,
            segmento = DATEDIFF(SECOND, @horaBase, fecha) / @intervaloSegundos
        FROM [dbo].[BitacoraValidacionUbicacionMovil]
        WHERE idUsuario    = @idUsuario
          AND sucursal     = @sucursal
          AND CAST(fecha AS DATE) = @fecha
          AND motivo LIKE 'recorrido%'
          AND latitud IS NOT NULL
    )
    SELECT
        p.segmento,
        fecha = MIN(p.fecha),
        latitud  = CAST(AVG(p.latitud) AS FLOAT),
        longitud = CAST(AVG(p.longitud) AS FLOAT),
        accuracy = CAST(AVG(p.accuracy) AS DECIMAL(10,1)),
        puntosEnSegmento = COUNT(*),
        motivos = STUFF((
            SELECT ',' + m.nombre
            FROM (
                SELECT DISTINCT
                    nombre = CASE motivo
                        WHEN 'recorrido_app'         THEN 'A'
                        WHEN 'recorrido_pantalla_a'  THEN 'ON'
                        WHEN 'recorrido_pantalla_e'  THEN 'OFF'
                        ELSE motivo
                    END
                FROM puntos p2
                WHERE p2.segmento = p.segmento
            ) m
            FOR XML PATH(''), TYPE
        ).value('.', 'NVARCHAR(MAX)'), 1, 1, ''),
        conCobertura = MAX(p.conCobertura)
    FROM puntos p
    GROUP BY p.segmento
    ORDER BY p.segmento;
END
GO

-- 7b. Consulta simple: todos los puntos del recorrido (sin agrupar, para animación fina)
CREATE PROCEDURE [dbo].[sp_RecorridoPlaybackPuntos]
    @idUsuario INT,
    @sucursal INT,
    @fecha DATE
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        fecha,
        latitud,
        longitud,
        accuracy,
        motivo,
        conCobertura,
        -- Segundos desde el inicio del recorrido (para timeline del playback)
        segundo = DATEDIFF(SECOND,
                    MIN(fecha) OVER (PARTITION BY @idUsuario, CAST(fecha AS DATE)),
                    fecha)
    FROM [dbo].[BitacoraValidacionUbicacionMovil]
    WHERE idUsuario    = @idUsuario
      AND sucursal     = @sucursal
      AND CAST(fecha AS DATE) = @fecha
      AND motivo LIKE 'recorrido%'
      AND latitud IS NOT NULL
    ORDER BY fecha;
END
GO

-- =============================================================================
-- CONSULTA ADICIONAL: Vista materializada para dashboard
-- =============================================================================

-- Vista para alimentar dashboards sin recalcular
CREATE VIEW [dbo].[vw_RecorridoDiario] AS
SELECT
    idUsuario,
    sucursal,
    dia = CAST(fecha AS DATE),
    horaInicio = MIN(fecha),
    horaFin = MAX(fecha),
    minutosEnRuta = DATEDIFF(MINUTE, MIN(fecha), MAX(fecha)),
    puntosGPS = COUNT(*),
    conCoberturaPct = CAST(SUM(CASE WHEN conCobertura = 1 THEN 1.0 ELSE 0 END) / NULLIF(COUNT(*), 0) * 100 AS DECIMAL(5,1)),
    accuracyPromedio = CAST(AVG(accuracy) AS DECIMAL(10,1)),
    accuracyMax = CAST(MAX(accuracy) AS DECIMAL(10,1)),
    tramosApp = SUM(CASE WHEN motivo = 'recorrido_app' THEN 1 ELSE 0 END),
    tramosPantallaOn = SUM(CASE WHEN motivo = 'recorrido_pantalla_a' THEN 1 ELSE 0 END),
    tramosPantallaOff = SUM(CASE WHEN motivo = 'recorrido_pantalla_e' THEN 1 ELSE 0 END)
FROM [dbo].[BitacoraValidacionUbicacionMovil]
WHERE motivo LIKE 'recorrido%'
  AND latitud IS NOT NULL
GROUP BY idUsuario, sucursal, CAST(fecha AS DATE);
GO
