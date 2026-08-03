CREATE TABLE [dbo].[BitacoraGpsMovil] (
    id INT IDENTITY(1,1) PRIMARY KEY,

    -- Idempotencia: identificador único generado en el dispositivo (timestamp-random).
    -- El índice único filtrado con IGNORE_DUP_KEY hace que los reenvíos del móvil
    -- (reintentos por red o syncs concurrentes) se ignoren sin duplicar filas.
    idLocal NVARCHAR(64) NULL,

    idUsuario INT NOT NULL,
    sucursal INT NOT NULL,
    latitud FLOAT NOT NULL,
    longitud FLOAT NOT NULL,
    precision FLOAT NULL,
    bateria FLOAT NULL,
    id_movil BIGINT NULL,
    fecha DATETIME NOT NULL,
    fechaRegistroServidor DATETIME DEFAULT GETDATE()
);
GO

-- Clave de idempotencia: ignora silenciosamente los inserts con idLocal repetido.
CREATE UNIQUE NONCLUSTERED INDEX UX_BitacoraGps_IdLocal
    ON [dbo].[BitacoraGpsMovil] (idLocal)
    WHERE idLocal IS NOT NULL
    WITH (IGNORE_DUP_KEY = ON);
GO

CREATE PROCEDURE [dbo].[sp_MovilesBitacoraGpsArrastreJSON]
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

        INSERT INTO [dbo].[BitacoraGpsMovil] (
            idLocal,
            idUsuario,
            sucursal,
            latitud,
            longitud,
            precision,
            bateria,
            id_movil,
            fecha
        )
        SELECT
            j.idLocal,
            j.idUsuario,
            j.sucursal,
            j.latitud,
            j.longitud,
            j.precision,
            j.bateria,
            j.id_movil,
            j.fecha
        FROM OPENJSON(@json)
        WITH (
            idLocal   NVARCHAR(64)  '$.id',
            idUsuario INT,
            sucursal  INT,
            latitud   FLOAT,
            longitud  FLOAT,
            precision FLOAT,
            bateria   FLOAT,
            id_movil  BIGINT,
            fecha     DATETIME
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
--      ALTER TABLE [dbo].[BitacoraGpsMovil] ADD idLocal NVARCHAR(64) NULL;
--
--   2) Crear el índice de idempotencia:
--      CREATE UNIQUE NONCLUSTERED INDEX UX_BitacoraGps_IdLocal
--          ON [dbo].[BitacoraGpsMovil] (idLocal)
--          WITH (IGNORE_DUP_KEY = ON)
--          WHERE idLocal IS NOT NULL;
--
--   3) Recrear el stored procedure con el CREATE PROCEDURE de arriba
--      (cambiar CREATE por ALTER). Asegúrate de declarar idLocal como:
--        idLocal NVARCHAR(64) '$.id'
--      en el WITH de OPENJSON para que el path JSON case-sensitive 'id' se
--      mapee correctamente a la columna idLocal.
--
--   4) Limpiar duplicados históricos de recorrido (mismo usuario/fecha/posición):
--      ;WITH d AS (
--          SELECT id,
--                 ROW_NUMBER() OVER (
--                     PARTITION BY idUsuario, fecha, latitud, longitud
--                     ORDER BY id
--                 ) AS rn
--          FROM [dbo].[BitacoraGpsMovil]
--      )
--      DELETE FROM d WHERE rn > 1;
-- =============================================================================
