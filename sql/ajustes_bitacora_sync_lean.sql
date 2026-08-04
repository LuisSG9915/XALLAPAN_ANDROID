-- =============================================
-- Script: Ajustes para BitacoraSync optimizada
-- Descripcion: Crea una nueva tabla BitacoraSyncOptimizado con las
--              columnas esenciales y un SP dedicado, sin afectar
--              la tabla/sp original BitacoraSync para versiones anteriores.
-- Fecha: 03/08/2026
-- =============================================

-- Tabla optimizada (no toca BitacoraSync original)
IF OBJECT_ID('[dbo].[BitacoraSyncOptimizado]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[BitacoraSyncOptimizado](
        [id] [bigint] IDENTITY(1,1) NOT NULL,
        [idBitacoraMovil] [nvarchar](100) NOT NULL,
        [fechaInicio] [datetime] NOT NULL,
        [duracionMs] [int] NULL,
        [idUsuario] [int] NULL,
        [versionApp] [nvarchar](50) NULL,
        [tabla] [nvarchar](100) NOT NULL,
        [endpoint] [nvarchar](500) NULL,
        [registrosLeidos] [int] NULL,
        [exitoso] [bit] NOT NULL,
        [codigoError] [nvarchar](50) NULL,
        [descripcionError] [nvarchar](max) NULL,
        [stackTrace] [nvarchar](max) NULL,
        [fechaArrastre] [datetime] NULL,
        CONSTRAINT [PK_BitacoraSyncOptimizado] PRIMARY KEY CLUSTERED
        (
            [id] ASC
        ) WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY]
    ) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY];

    CREATE UNIQUE NONCLUSTERED INDEX [IX_BitacoraSyncOptimizado_idBitacoraMovil] ON [dbo].[BitacoraSyncOptimizado]
    (
        [idBitacoraMovil] ASC
    ) WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, IGNORE_DUP_KEY = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY];
END
GO

-- =============================================================
-- PROCEDIMIENTO ALMACENADO: ARRASTRE DE BITACORAS OPTIMIZADO
-- =============================================================
CREATE OR ALTER PROCEDURE [dbo].[sp_BitacoraSyncOptimizadoArrastreJSON]
    @json NVARCHAR(MAX),
    @sucursal INT,
    @idUsuario INT
AS
BEGIN
    SET NOCOUNT ON;

    BEGIN TRY
        BEGIN TRANSACTION;

        -- Validar formato JSON
        IF ISJSON(@json) <> 1
        BEGIN
            THROW 50001, 'El formato del JSON de bitácora es inválido.', 1;
        END

        -- Insertar registros de bitácora desde el JSON
        INSERT INTO [dbo].[BitacoraSyncOptimizado]
        (
            idBitacoraMovil,
            fechaInicio,
            duracionMs,
            idUsuario,
            versionApp,
            tabla,
            endpoint,
            registrosLeidos,
            exitoso,
            codigoError,
            descripcionError,
            stackTrace,
            fechaArrastre
        )
        SELECT
            j.idBitacoraMovil,
            j.fechaInicio,
            j.duracionMs,
            COALESCE(j.idUsuario, @idUsuario),
            j.versionApp,
            j.tabla,
            j.endpoint,
            COALESCE(j.registrosLeidos, 0),
            COALESCE(j.exitoso, 1),
            j.codigoError,
            j.descripcionError,
            j.stackTrace,
            GETDATE()
        FROM OPENJSON(@json)
        WITH (
            idBitacoraMovil     NVARCHAR(100)   '$.idBitacoraMovil',
            fechaInicio         DATETIME        '$.fechaInicio',
            duracionMs          INT             '$.duracionMs',
            idUsuario           INT             '$.idUsuario',
            versionApp          NVARCHAR(50)    '$.versionApp',
            tabla               NVARCHAR(100)   '$.tabla',
            endpoint            NVARCHAR(500)   '$.endpoint',
            registrosLeidos     INT             '$.registrosLeidos',
            exitoso             BIT             '$.exitoso',
            codigoError         NVARCHAR(50)    '$.codigoError',
            descripcionError    NVARCHAR(MAX)   '$.descripcionError',
            stackTrace          NVARCHAR(MAX)   '$.stackTrace'
        ) j
        -- Solo insertar registros que no existan ya (evitar duplicados)
        WHERE NOT EXISTS (
            SELECT 1
            FROM [dbo].[BitacoraSyncOptimizado] b
            WHERE b.idBitacoraMovil = j.idBitacoraMovil
        );

        DECLARE @registrosInsertados INT = @@ROWCOUNT;

        COMMIT TRANSACTION;

        -- Retornar resultado
        SELECT
            'OK' AS resultado,
            @registrosInsertados AS registrosInsertados,
            GETDATE() AS fechaProceso;

    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;

        DECLARE @ErrorMessage NVARCHAR(4000) = ERROR_MESSAGE();
        DECLARE @ErrorSeverity INT = ERROR_SEVERITY();
        DECLARE @ErrorState INT = ERROR_STATE();
        DECLARE @ErrorLine INT = ERROR_LINE();

        -- Registrar el error en la misma tabla de bitácora
        INSERT INTO [dbo].[BitacoraSyncOptimizado]
        (
            idBitacoraMovil,
            fechaInicio,
            duracionMs,
            idUsuario,
            versionApp,
            tabla,
            endpoint,
            exitoso,
            codigoError,
            descripcionError,
            stackTrace,
            fechaArrastre
        )
        VALUES
        (
            CONCAT('ERROR-', CONVERT(NVARCHAR(20), GETDATE(), 112), '-', NEWID()),
            GETDATE(),
            0,
            @idUsuario,
            'app',
            'BitacoraSyncOptimizado',
            'sp_BitacoraSyncOptimizadoArrastreJSON',
            0,
            CONCAT('SQL-', ERROR_NUMBER()),
            @ErrorMessage,
            CONCAT('Línea: ', @ErrorLine, ' - Severidad: ', @ErrorSeverity, ' - Estado: ', @ErrorState),
            GETDATE()
        );

        RAISERROR (@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
END
GO
