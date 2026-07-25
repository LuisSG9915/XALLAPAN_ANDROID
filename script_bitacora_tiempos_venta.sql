-- =============================================================================
-- Diagnóstico de tiempos del CIERRE DE VENTA (SalesScreen.processSale)
-- Una fila por CADA venta procesada en el móvil. Mide cuánto tarda cada etapa
-- del cierre (GPS, impresión de ticket, guardado local, post-venta) para
-- detectar en qué se va el tiempo cuando "la venta tarda en cerrar".
--
-- Consultas útiles:
--   -- Promedio por etapa por vendedor (últimos 7 días)
--   SELECT idUsuario,
--          COUNT(*)                            AS ventas,
--          AVG(CAST(totalMs AS FLOAT))         AS promedio_total_ms,
--          AVG(CAST(gpsMs AS FLOAT))           AS promedio_gps_ms,
--          AVG(CAST(impresionMs AS FLOAT))     AS promedio_impresion_ms,
--          AVG(CAST(guardadoVentaMs AS FLOAT)) AS promedio_guardado_ms,
--          AVG(CAST(postVentaMs AS FLOAT))     AS promedio_postventa_ms
--   FROM [dbo].[BitacoraTiemposVentaMovil]
--   WHERE fecha >= DATEADD(DAY, -7, GETDATE())
--   GROUP BY idUsuario
--   ORDER BY promedio_total_ms DESC;
--
--   -- Ventas más lentas (top 50)
--   SELECT TOP 50 idUsuario, idCliente, fecha, totalMs, gpsFuente, gpsMs,
--          impresionMs, guardadoVentaMs, postVentaMs, dobleTicket, ticketImpreso
--   FROM [dbo].[BitacoraTiemposVentaMovil]
--   ORDER BY totalMs DESC;
-- =============================================================================

CREATE TABLE [dbo].[BitacoraTiemposVentaMovil] (
    id                    INT IDENTITY(1,1) PRIMARY KEY,

    -- Idempotencia: identificador único generado en el dispositivo (timestamp-random).
    -- El índice único filtrado con IGNORE_DUP_KEY hace que los reenvíos del móvil
    -- (reintentos por red o syncs concurrentes) se ignoren sin duplicar filas.
    idLocal               NVARCHAR(64)  NULL,

    -- Identidad
    idUsuario             INT           NOT NULL,
    sucursal              INT           NOT NULL,
    idCliente             INT           NULL,        -- cliente de la venta
    idMovil               BIGINT        NULL,        -- id_movil de la venta generada

    -- GPS
    gpsFuente             VARCHAR(20)   NULL,        -- cache_visita | cache_prefetch | cache_venta | paralelo | sin_gps
    gpsMs                 INT           NULL,        -- ms que el cierre se detuvo esperando el GPS (0 si vino de cache)

    -- Tiempos por etapa (milisegundos)
    impresionMs           INT           NULL,        -- impresión de ticket (incluye reconexión Bluetooth)
    guardadoVentaMs       INT           NULL,        -- escritura de la venta en la BD local
    postVentaMs           INT           NULL,        -- envases + inventario + marcar visita
    totalMs               INT           NULL,        -- cierre completo (processSale)

    -- Contexto de la venta
    items                 INT           NULL,        -- productos en el carrito
    dobleTicket           BIT           NULL,        -- se imprimieron 2 tickets
    ticketImpreso         BIT           NULL,        -- la impresión tuvo éxito

    -- Contexto del dispositivo
    conCobertura          BIT           NULL,        -- había red al cerrar
    plataforma            VARCHAR(10)   NULL,        -- android | ios
    versionApp            VARCHAR(20)   NULL,

    -- Tiempos
    fecha                 DATETIME      NOT NULL,    -- hora del cierre en el dispositivo
    fechaRegistroServidor DATETIME      DEFAULT GETDATE()
);
GO

-- Índices útiles para analizar tiempos por usuario / cliente / fecha
CREATE INDEX IX_BitacoraTiemposVenta_Usuario_Fecha
    ON [dbo].[BitacoraTiemposVentaMovil] (idUsuario, fecha);
CREATE INDEX IX_BitacoraTiemposVenta_Cliente
    ON [dbo].[BitacoraTiemposVentaMovil] (idCliente);
GO

-- Clave de idempotencia: ignora silenciosamente los inserts con idLocal repetido.
CREATE UNIQUE NONCLUSTERED INDEX UX_BitacoraTiemposVenta_IdLocal
    ON [dbo].[BitacoraTiemposVentaMovil] (idLocal)
    WITH (IGNORE_DUP_KEY = ON)
    WHERE idLocal IS NOT NULL;
GO

-- =============================================================================
-- Inserción por lotes desde el móvil (mismo patrón que sp_MovilesBitacoraGpsArrastreJSON)
-- Endpoint móvil: POST /api/MovilesVentas/sp_MovilesBitacoraTiemposVentaArrastreJSON
-- =============================================================================
CREATE PROCEDURE [dbo].[sp_MovilesBitacoraTiemposVentaArrastreJSON]
    @json NVARCHAR(MAX),
    @sucursal INT,
    @idUsuario INT
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRY
        BEGIN TRANSACTION;

        IF ISJSON(@json) <> 1
        BEGIN
            THROW 50001, 'El formato del JSON es invalido.', 1;
            RETURN;
        END

        INSERT INTO [dbo].[BitacoraTiemposVentaMovil] (
            idLocal,
            idUsuario, sucursal, idCliente, idMovil,
            gpsFuente, gpsMs,
            impresionMs, guardadoVentaMs, postVentaMs, totalMs,
            items, dobleTicket, ticketImpreso,
            conCobertura, plataforma, versionApp, fecha
        )
        SELECT
            j.id,
            j.idUsuario, j.sucursal, j.idCliente, j.idMovil,
            j.gpsFuente, j.gpsMs,
            j.impresionMs, j.guardadoVentaMs, j.postVentaMs, j.totalMs,
            j.items, j.dobleTicket, j.ticketImpreso,
            j.conCobertura, j.plataforma, j.versionApp, j.fecha
        FROM OPENJSON(@json)
        WITH (
            id               NVARCHAR(64),
            idUsuario        INT,
            sucursal         INT,
            idCliente        INT,
            idMovil          BIGINT,
            gpsFuente        VARCHAR(20),
            gpsMs            INT,
            impresionMs      INT,
            guardadoVentaMs  INT,
            postVentaMs      INT,
            totalMs          INT,
            items            INT,
            dobleTicket      BIT,
            ticketImpreso    BIT,
            conCobertura     BIT,
            plataforma       VARCHAR(10),
            versionApp       VARCHAR(20),
            fecha            DATETIME
        ) j;

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        DECLARE @ErrorMessage NVARCHAR(4000) = ERROR_MESSAGE();
        DECLARE @ErrorSeverity INT = ERROR_SEVERITY();
        DECLARE @ErrorState INT = ERROR_STATE();
        RAISERROR (@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
END
GO
