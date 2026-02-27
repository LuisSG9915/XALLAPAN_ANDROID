CREATE TABLE [dbo].[BitacoraGpsMovil] (
    id INT IDENTITY(1,1) PRIMARY KEY,
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
            idUsuario INT,
            sucursal INT,
            latitud FLOAT,
            longitud FLOAT,
            precision FLOAT,
            bateria FLOAT,
            id_movil BIGINT,
            fecha DATETIME
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
