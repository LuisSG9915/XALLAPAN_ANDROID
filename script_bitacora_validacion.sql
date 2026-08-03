-- =============================================================================
-- Diagnóstico de validaciones de ubicación (checa por qué falla una visita en campo)
-- Una fila por CADA intento de validación (LocationService.validarUbicacionCliente).
-- =============================================================================

CREATE TABLE [dbo].[BitacoraValidacionUbicacionMovil] (
    id                    INT IDENTITY(1,1) PRIMARY KEY,

    -- Idempotencia: identificador único generado en el dispositivo (timestamp-random).
    -- El índice único filtrado con IGNORE_DUP_KEY hace que los reenvíos del móvil
    -- (reintentos por red o syncs concurrentes) se ignoren sin duplicar filas.
    idLocal               NVARCHAR(64)  NULL,

    -- Identidad
    idUsuario             INT           NOT NULL,
    sucursal              INT           NOT NULL,
    idCliente             INT           NULL,        -- cliente contra el que se validó

    -- Resultado de la validación
    motivo                VARCHAR(20)   NOT NULL,     -- ok | ok_cache | sin_permiso | sin_senal | precision_baja | fuera_de_rango
    valido                BIT           NOT NULL,     -- 1 = visita permitida, 0 = rechazada
    distancia             FLOAT         NULL,         -- metros medidos entre vendedor y cliente
    accuracy              FLOAT         NULL,         -- precisión (±m) del MEJOR fix usado
    metrosPermitidos      FLOAT         NULL,         -- rango permitido en la validación

    -- Posición del vendedor (mejor fix)
    latitud               FLOAT         NULL,
    longitud              FLOAT         NULL,

    -- Posición registrada del cliente (para comparar contra Google Maps)
    clienteLatitud        FLOAT         NULL,
    clienteLongitud       FLOAT         NULL,

    -- Diagnóstico del GPS durante la lectura
    numFixes              INT           NULL,         -- cuántos fixes se recibieron
    peorAccuracy          FLOAT         NULL,         -- peor precisión vista (ver el fix "grueso" inicial)
    tiempoMs              INT           NULL,         -- ms que tardó en resolver la ubicación
    conCobertura          BIT           NULL,         -- había red al validar

    -- Contexto del dispositivo
    id_movil              BIGINT        NULL,
    plataforma            VARCHAR(10)   NULL,         -- android | ios
    versionApp            VARCHAR(20)   NULL,

    -- Tiempos
    fecha                 DATETIME      NOT NULL,     -- hora del intento en el dispositivo
    fechaRegistroServidor DATETIME      DEFAULT GETDATE()
);
GO

-- Índices útiles para analizar fallas por usuario / cliente / fecha
CREATE INDEX IX_BitacoraValidacion_Usuario_Fecha
    ON [dbo].[BitacoraValidacionUbicacionMovil] (idUsuario, fecha);
CREATE INDEX IX_BitacoraValidacion_Cliente
    ON [dbo].[BitacoraValidacionUbicacionMovil] (idCliente);
CREATE INDEX IX_BitacoraValidacion_Motivo
    ON [dbo].[BitacoraValidacionUbicacionMovil] (motivo);
GO

-- Clave de idempotencia: ignora silenciosamente los inserts con idLocal repetido.
CREATE UNIQUE NONCLUSTERED INDEX UX_BitacoraValidacion_IdLocal
    ON [dbo].[BitacoraValidacionUbicacionMovil] (idLocal)
    WHERE idLocal IS NOT NULL
    WITH (IGNORE_DUP_KEY = ON);
GO

-- =============================================================================
-- Inserción por lotes desde el móvil (mismo patrón que sp_MovilesBitacoraGpsArrastreJSON)
-- =============================================================================
CREATE PROCEDURE [dbo].[sp_MovilesBitacoraValidacionArrastreJSON]
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

        INSERT INTO [dbo].[BitacoraValidacionUbicacionMovil] (
            idLocal,
            idUsuario, sucursal, idCliente,
            motivo, valido, distancia, accuracy, metrosPermitidos,
            latitud, longitud, clienteLatitud, clienteLongitud,
            numFixes, peorAccuracy, tiempoMs, conCobertura,
            id_movil, plataforma, versionApp, fecha
        )
        SELECT
            j.idLocal,
            j.idUsuario, j.sucursal, j.idCliente,
            j.motivo, j.valido, j.distancia, j.accuracy, j.metrosPermitidos,
            j.latitud, j.longitud, j.clienteLatitud, j.clienteLongitud,
            j.numFixes, j.peorAccuracy, j.tiempoMs, j.conCobertura,
            j.id_movil, j.plataforma, j.versionApp, j.fecha
        FROM OPENJSON(@json)
        WITH (
            idLocal          NVARCHAR(64)  '$.id',
            idUsuario        INT,
            sucursal         INT,
            idCliente        INT,
            motivo           VARCHAR(20),
            valido           BIT,
            distancia        FLOAT,
            accuracy         FLOAT,
            metrosPermitidos FLOAT,
            latitud          FLOAT,
            longitud         FLOAT,
            clienteLatitud   FLOAT,
            clienteLongitud  FLOAT,
            numFixes         INT,
            peorAccuracy     FLOAT,
            tiempoMs         INT,
            conCobertura     BIT,
            id_movil         BIGINT,
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

-- =============================================================================
-- MIGRACIÓN para bases de datos donde la tabla YA EXISTE (ejecutar una sola vez):
--
--   1) Agregar la columna:
--      ALTER TABLE [dbo].[BitacoraValidacionUbicacionMovil] ADD idLocal NVARCHAR(64) NULL;
--
--   2) (Opcional) Eliminar duplicados históricos —mismo evento insertado más de
--      una vez por los reenvíos— conservando la fila de menor id:
--      ;WITH d AS (
--          SELECT id,
--                 ROW_NUMBER() OVER (
--                     PARTITION BY idUsuario, idCliente, fecha, distancia, tiempoMs
--                     ORDER BY id
--                 ) AS rn
--          FROM [dbo].[BitacoraValidacionUbicacionMovil]
--      )
--      DELETE FROM d WHERE rn > 1;
--
--   3) Crear el índice de idempotencia:
--      CREATE UNIQUE NONCLUSTERED INDEX UX_BitacoraValidacion_IdLocal
--          ON [dbo].[BitacoraValidacionUbicacionMovil] (idLocal)
--          WITH (IGNORE_DUP_KEY = ON)
--          WHERE idLocal IS NOT NULL;
--
--   4) Recrear el stored procedure con el CREATE PROCEDURE de arriba
--      (cambiar CREATE por ALTER). Asegúrate de declarar idLocal como:
--        idLocal NVARCHAR(64) '$.id'
--      en el WITH de OPENJSON para que el path JSON case-sensitive 'id' se
--      mapee correctamente a la columna idLocal.
--
--   5) Limpiar duplicados históricos de recorrido (mismo usuario/fecha/posición):
--      ;WITH d AS (
--          SELECT id,
--                 ROW_NUMBER() OVER (
--                     PARTITION BY idUsuario, motivo, fecha, latitud, longitud
--                     ORDER BY id
--                 ) AS rn
--          FROM [dbo].[BitacoraValidacionUbicacionMovil]
--          WHERE motivo LIKE 'recorrido%'
--      )
--      DELETE FROM d WHERE rn > 1;
-- =============================================================================
