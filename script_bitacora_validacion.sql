-- =============================================================================
-- Diagnóstico de validaciones de ubicación (checa por qué falla una visita en campo)
-- Una fila por CADA intento de validación (LocationService.validarUbicacionCliente).
-- =============================================================================

CREATE TABLE [dbo].[BitacoraValidacionUbicacionMovil] (
    id                    INT IDENTITY(1,1) PRIMARY KEY,

    -- Identidad
    idUsuario             INT           NOT NULL,
    sucursal              INT           NOT NULL,
    idCliente             INT           NULL,        -- cliente contra el que se validó

    -- Resultado de la validación
    motivo                VARCHAR(20)   NOT NULL,     -- ok | sin_permiso | sin_senal | precision_baja | fuera_de_rango
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
            idUsuario, sucursal, idCliente,
            motivo, valido, distancia, accuracy, metrosPermitidos,
            latitud, longitud, clienteLatitud, clienteLongitud,
            numFixes, peorAccuracy, tiempoMs, conCobertura,
            id_movil, plataforma, versionApp, fecha
        )
        SELECT
            j.idUsuario, j.sucursal, j.idCliente,
            j.motivo, j.valido, j.distancia, j.accuracy, j.metrosPermitidos,
            j.latitud, j.longitud, j.clienteLatitud, j.clienteLongitud,
            j.numFixes, j.peorAccuracy, j.tiempoMs, j.conCobertura,
            j.id_movil, j.plataforma, j.versionApp, j.fecha
        FROM OPENJSON(@json)
        WITH (
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
