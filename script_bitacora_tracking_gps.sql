-- =============================================================================
-- Tracking de ubicación del vendedor en segundo plano (cada ~30s)
-- Tabla EXCLUSIVA para el "ping" periódico de BackgroundLocationService
-- (GpsBitacoraService.registrarCapturaTracking). No mezclar aquí las
-- validaciones puntuales de visita a cliente: esas van en
-- BitacoraValidacionUbicacionMovil (script_bitacora_validacion.sql).
--
-- Motivo de existir por separado de BitacoraGpsMovil (script_bitacora_gps.sql):
-- BitacoraGpsMovil guarda además los fixes puntuales de
-- LocationService.getCurrentLocation()/RouteTrackingService (bajo demanda,
-- volumen bajo). Esta tabla en cambio recibe UN registro cada ventana de
-- ~30s por vendedor de forma continua durante toda la jornada, por lo que
-- se recortan columnas que no aportan valor en ese volumen:
--   - bateria (en realidad "metros permitidos" del usuario): es un dato
--     ESTÁTICO por usuario, se consulta por idUsuario, no debe viajar en
--     cada ping.
--   - id_movil: siempre NULL en el tracking periódico (no hay venta
--     asociada a un ping de recorrido).
--
-- Consultas útiles:
--   -- Última posición conocida de cada vendedor (monitoreo en vivo)
--   SELECT t.*
--   FROM [dbo].[BitacoraTrackingGpsMovil] t
--   INNER JOIN (
--       SELECT idUsuario, MAX(fecha) AS ultimaFecha
--       FROM [dbo].[BitacoraTrackingGpsMovil]
--       WHERE fecha >= DATEADD(HOUR, -2, GETDATE())
--       GROUP BY idUsuario
--   ) u ON u.idUsuario = t.idUsuario AND u.ultimaFecha = t.fecha;
--
--   -- Recorrido de un vendedor en un día
--   SELECT idUsuario, latitud, longitud, precisionM, conCobertura, fecha
--   FROM [dbo].[BitacoraTrackingGpsMovil]
--   WHERE idUsuario = @idUsuario
--     AND fecha >= @desde AND fecha < @hasta
--   ORDER BY fecha;
-- =============================================================================

CREATE TABLE [dbo].[BitacoraTrackingGpsMovil] (
    id                    INT IDENTITY(1,1) PRIMARY KEY,

    -- Idempotencia: idLocal determinista por ventana (`${idUsuario}-${ventana}`)
    -- generado en el dispositivo. El índice único filtrado con IGNORE_DUP_KEY
    -- hace que reenvíos por red o syncs concurrentes se ignoren sin duplicar.
    idLocal               NVARCHAR(64)  NULL,

    -- Identidad
    idUsuario             INT           NOT NULL,
    sucursal              INT           NOT NULL,

    -- Posición
    latitud               FLOAT         NOT NULL,
    longitud              FLOAT         NOT NULL,
    precisionM            FLOAT         NULL,         -- precisión GPS en metros (±)
    conCobertura          BIT           NULL,         -- había red al capturar el punto

    -- Tiempos
    fecha                 DATETIME      NOT NULL,     -- hora de captura en el dispositivo
    fechaRegistroServidor DATETIME      DEFAULT GETDATE()
);
GO

-- Índice para monitoreo/recorrido por vendedor y rango de fechas
CREATE INDEX IX_BitacoraTrackingGps_Usuario_Fecha
    ON [dbo].[BitacoraTrackingGpsMovil] (idUsuario, fecha);
GO

-- Índice para reportes por sucursal
CREATE INDEX IX_BitacoraTrackingGps_Sucursal_Fecha
    ON [dbo].[BitacoraTrackingGpsMovil] (sucursal, fecha);
GO

-- Clave de idempotencia: ignora silenciosamente los inserts con idLocal repetido.
CREATE UNIQUE NONCLUSTERED INDEX UX_BitacoraTrackingGps_IdLocal
    ON [dbo].[BitacoraTrackingGpsMovil] (idLocal)
    WHERE idLocal IS NOT NULL
    WITH (IGNORE_DUP_KEY = ON);
GO

-- =============================================================================
-- Inserción por lotes desde el móvil (mismo patrón que sp_MovilesBitacoraGpsArrastreJSON)
-- Endpoint móvil: POST /api/MovilesVentas/sp_MovilesBitacoraTrackingGpsArrastreJSON
-- =============================================================================
CREATE PROCEDURE [dbo].[sp_MovilesBitacoraTrackingGpsArrastreJSON]
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

        INSERT INTO [dbo].[BitacoraTrackingGpsMovil] (
            idLocal,
            idUsuario,
            sucursal,
            latitud,
            longitud,
            precisionM,
            conCobertura,
            fecha
        )
        SELECT
            j.idLocal,
            j.idUsuario,
            j.sucursal,
            j.latitud,
            j.longitud,
            j.precision,
            j.conCobertura,
            j.fecha
        FROM OPENJSON(@json)
        WITH (
            idLocal      NVARCHAR(64)  '$.id',
            idUsuario    INT,
            sucursal     INT,
            latitud      FLOAT,
            longitud     FLOAT,
            [precision]  FLOAT,
            conCobertura BIT,
            fecha        DATETIME
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

-- =============================================================================
-- Limpieza sugerida (ejecutar periódicamente, ej. job diario):
-- este tracking crece rápido (un registro cada ~30s por vendedor todo el día),
-- conviene purgar histórico más allá de lo que se necesite para auditoría.
--
--   DELETE FROM [dbo].[BitacoraTrackingGpsMovil]
--   WHERE fecha < DATEADD(DAY, -30, GETDATE());
-- =============================================================================
