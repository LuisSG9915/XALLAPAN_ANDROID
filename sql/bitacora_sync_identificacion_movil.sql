-- Ejecutar primero en la base de pruebas. No requiere publicar otra API.
-- Los registros anteriores y las apps viejas pueden dejar estos campos en NULL.
IF COL_LENGTH('dbo.BitacoraSyncOptimizado', 'marcaMovil') IS NULL
    ALTER TABLE dbo.BitacoraSyncOptimizado ADD marcaMovil NVARCHAR(100) NULL;
IF COL_LENGTH('dbo.BitacoraSyncOptimizado', 'modeloMovil') IS NULL
    ALTER TABLE dbo.BitacoraSyncOptimizado ADD modeloMovil NVARCHAR(100) NULL;
IF COL_LENGTH('dbo.BitacoraSyncOptimizado', 'idDispositivoMovil') IS NULL
    ALTER TABLE dbo.BitacoraSyncOptimizado ADD idDispositivoMovil NVARCHAR(16) NULL;
GO

ALTER PROCEDURE dbo.sp_BitacoraSyncOptimizadoArrastreJSON
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
            RAISERROR ('El formato del JSON de bitacora es invalido.', 16, 1);
        END

        INSERT INTO dbo.BitacoraSyncOptimizado
        (
            idBitacoraMovil, fechaInicio, duracionMs, idUsuario, versionApp,
            tabla, endpoint, registrosLeidos, exitoso, codigoError,
            descripcionError, stackTrace, fechaArrastre,
            marcaMovil, modeloMovil, idDispositivoMovil
        )
        SELECT
            j.idBitacoraMovil, j.fechaInicio, j.duracionMs,
            COALESCE(j.idUsuario, @idUsuario), j.versionApp,
            j.tabla, j.endpoint, COALESCE(j.registrosLeidos, 0),
            COALESCE(j.exitoso, 1), j.codigoError, j.descripcionError,
            j.stackTrace, GETDATE(),
            NULLIF(LTRIM(RTRIM(j.marcaMovil)), ''),
            NULLIF(LTRIM(RTRIM(j.modeloMovil)), ''),
            NULLIF(LTRIM(RTRIM(j.idDispositivoMovil)), '')
        FROM OPENJSON(@json)
        WITH (
            idBitacoraMovil    NVARCHAR(100) '$.idBitacoraMovil',
            fechaInicio        DATETIME      '$.fechaInicio',
            duracionMs         INT           '$.duracionMs',
            idUsuario          INT           '$.idUsuario',
            versionApp         NVARCHAR(50)  '$.versionApp',
            tabla              NVARCHAR(100) '$.tabla',
            endpoint           NVARCHAR(500) '$.endpoint',
            registrosLeidos    INT           '$.registrosLeidos',
            exitoso            BIT           '$.exitoso',
            codigoError        NVARCHAR(50)  '$.codigoError',
            descripcionError   NVARCHAR(MAX) '$.descripcionError',
            stackTrace         NVARCHAR(MAX) '$.stackTrace',
            marcaMovil         NVARCHAR(100) 'lax $.marcaMovil',
            modeloMovil        NVARCHAR(100) 'lax $.modeloMovil',
            idDispositivoMovil NVARCHAR(16)  'lax $.idDispositivoMovil'
        ) AS j
        WHERE NOT EXISTS (
            SELECT 1
            FROM dbo.BitacoraSyncOptimizado AS b
            WHERE b.idBitacoraMovil = j.idBitacoraMovil
        );

        DECLARE @registrosInsertados INT = @@ROWCOUNT;

        COMMIT TRANSACTION;

        SELECT 'OK' AS resultado,
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

        INSERT INTO dbo.BitacoraSyncOptimizado
        (
            idBitacoraMovil, fechaInicio, duracionMs, idUsuario, versionApp,
            tabla, endpoint, exitoso, codigoError, descripcionError,
            stackTrace, fechaArrastre
        )
        VALUES
        (
            CONCAT('ERROR-', CONVERT(NVARCHAR(20), GETDATE(), 112), '-', NEWID()),
            GETDATE(), 0, @idUsuario, 'app', 'BitacoraSyncOptimizado',
            'sp_BitacoraSyncOptimizadoArrastreJSON', 0,
            CONCAT('SQL-', ERROR_NUMBER()), @ErrorMessage,
            CONCAT('Linea: ', @ErrorLine, ' - Severidad: ', @ErrorSeverity, ' - Estado: ', @ErrorState),
            GETDATE()
        );

        RAISERROR (@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
END;
GO
