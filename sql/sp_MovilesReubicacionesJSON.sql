-- =============================================
-- Procedimiento: sp_MovilesReubicacionesJSON
-- Descripción: Procesa reubicaciones de clientes desde el móvil
-- Parámetros:
--   @json: JSON con array de reubicaciones
--   @sucursal: ID de sucursal
--   @idUsuario: ID del usuario que realiza la operación
-- =============================================
CREATE PROCEDURE [dbo].[sp_MovilesReubicacionesJSON]
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
            THROW 50001, 'El formato del JSON es inválido.', 1;
            RETURN;
        END

        -- Insertar reubicaciones desde JSON a la tabla detalle_reubicaciones
        INSERT INTO detalle_reubicaciones (
            sucursal,
            cve_cliente,
            latitud_anterior,
            longitud_anterior,
            latitud_nueva,
            longitud_nueva,
            fecha,
            usuario,
            realizado,
            id_movil,
            fechaTransfer
        )
        SELECT
            j.sucursal,
            j.cveCliente,
            j.latitudAnterior,
            j.longitudAnterior,
            j.latitudNueva,
            j.longitudNueva,
            j.fecha,
            j.usuario,
            0, -- Marca como NO realizado aún
            j.idMovil,
            j.fechaTransfer
        FROM OPENJSON(@json)
        WITH (
            sucursal INT,
            cveCliente INT,
            latitudAnterior FLOAT,
            longitudAnterior FLOAT,
            latitudNueva FLOAT,
            longitudNueva FLOAT,
            fecha DATETIME,
            usuario INT,
            idMovil BIGINT,
            fechaTransfer DATETIME
        ) j
        WHERE j.sucursal = @sucursal;

        -- Aplicar las reubicaciones pendientes a la tabla de clientes
        UPDATE c
        SET 
            c.latitud = r.latitud_nueva,
            c.longitud = r.longitud_nueva
        FROM clientes c
        INNER JOIN detalle_reubicaciones r ON c.id = r.cve_cliente
        WHERE r.sucursal = @sucursal 
            AND r.realizado = 0;

        -- Marcar reubicaciones como realizadas
        UPDATE detalle_reubicaciones
        SET realizado = 1
        WHERE sucursal = @sucursal 
            AND realizado = 0;

        COMMIT TRANSACTION;

        -- Retornar resultado exitoso
        SELECT 
            'OK' AS status,
            @@ROWCOUNT AS registrosActualizados;

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
