-- =============================================
-- Script: Ajustes para bitácora de pedidos optimizada (arrastre)
-- Descripción: Deja en detalle_pedidos_bitacora solo los campos que cambian,
--              conservando ruta y agregando completado a la bitácora.
-- Fecha: 03/08/2026
-- =============================================

-- Quitar SPs que dependen de las columnas a eliminar (deben ir antes del ALTER TABLE)
IF OBJECT_ID('sp_MovilesPedidosBitacora_Insert', 'P') IS NOT NULL
    DROP PROCEDURE sp_MovilesPedidosBitacora_Insert;
IF OBJECT_ID('sp_MovilesPedidosBitacora_Select', 'P') IS NOT NULL
    DROP PROCEDURE sp_MovilesPedidosBitacora_Select;
IF OBJECT_ID('[dbo].[sp_DetallePedidosBitacoraArrastreJSON]', 'P') IS NOT NULL
    DROP PROCEDURE [dbo].[sp_DetallePedidosBitacoraArrastreJSON];
GO

-- La columna completado debe estar en detalle_pedidos_bitacora, no en detalle_pedidos
IF EXISTS(SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('detalle_pedidos') AND name = 'completado')
    ALTER TABLE detalle_pedidos DROP COLUMN completado;
GO

IF OBJECT_ID('detalle_pedidos_bitacora', 'U') IS NOT NULL
BEGIN
    -- Quitar índices dependientes de columnas que se van a eliminar
    IF EXISTS(SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('detalle_pedidos_bitacora') AND name = 'IX_bitacora_id_pedido')
        DROP INDEX IX_bitacora_id_pedido ON detalle_pedidos_bitacora;
    IF EXISTS(SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('detalle_pedidos_bitacora') AND name = 'IX_bitacora_enviado')
        DROP INDEX IX_bitacora_enviado ON detalle_pedidos_bitacora;
    IF EXISTS(SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('detalle_pedidos_bitacora') AND name = 'IX_bitacora_folio')
        DROP INDEX IX_bitacora_folio ON detalle_pedidos_bitacora;
    IF EXISTS(SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('detalle_pedidos_bitacora') AND name = 'IX_bitacora_id_movil')
        DROP INDEX IX_bitacora_id_movil ON detalle_pedidos_bitacora;

    -- Agregar completado a la bitácora si no existe
    IF NOT EXISTS(SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('detalle_pedidos_bitacora') AND name = 'completado')
        ALTER TABLE detalle_pedidos_bitacora ADD completado BIT NOT NULL DEFAULT 0;

    -- Eliminar columnas que no cambian entre snapshots (ruta se conserva)
    IF EXISTS(SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('detalle_pedidos_bitacora') AND name = 'cliente')
        ALTER TABLE detalle_pedidos_bitacora DROP COLUMN cliente;
    IF EXISTS(SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('detalle_pedidos_bitacora') AND name = 'idCanal')
        ALTER TABLE detalle_pedidos_bitacora DROP COLUMN idCanal;
    IF EXISTS(SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('detalle_pedidos_bitacora') AND name = 'cantPedido')
        ALTER TABLE detalle_pedidos_bitacora DROP COLUMN cantPedido;
    IF EXISTS(SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('detalle_pedidos_bitacora') AND name = 'observaciones')
        ALTER TABLE detalle_pedidos_bitacora DROP COLUMN observaciones;
    IF EXISTS(SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('detalle_pedidos_bitacora') AND name = 'listaPrecio')
        ALTER TABLE detalle_pedidos_bitacora DROP COLUMN listaPrecio;
    IF EXISTS(SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('detalle_pedidos_bitacora') AND name = 'fechaEntrega')
        ALTER TABLE detalle_pedidos_bitacora DROP COLUMN fechaEntrega;
    IF EXISTS(SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('detalle_pedidos_bitacora') AND name = 'usrAlta')
        ALTER TABLE detalle_pedidos_bitacora DROP COLUMN usrAlta;
    IF EXISTS(SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('detalle_pedidos_bitacora') AND name = 'fueraAgenda')
        ALTER TABLE detalle_pedidos_bitacora DROP COLUMN fueraAgenda;
    IF EXISTS(SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('detalle_pedidos_bitacora') AND name = 'fecha_movil')
        ALTER TABLE detalle_pedidos_bitacora DROP COLUMN fecha_movil;
END
ELSE
BEGIN
    CREATE TABLE detalle_pedidos_bitacora (
        id INT IDENTITY(1,1) PRIMARY KEY,
        id_pedido INT NOT NULL,
        id_movil BIGINT NULL,
        folio INT NOT NULL,
        fecha DATETIME NOT NULL DEFAULT GETDATE(),
        ruta INT NOT NULL,
        fechaAtencion DATETIME NULL,
        idVendedor INT NOT NULL,
        idProducto INT NULL,
        precio DECIMAL(18,2) NULL,
        estatus INT NOT NULL,
        cantAtencion DECIMAL(18,3) NULL,
        precioAtencion DECIMAL(18,2) NULL,
        causaDiferencia INT NULL,
        obserDiferencia VARCHAR(500) NULL,
        causaNoAtencion INT NULL,
        obserNoAtencion VARCHAR(500) NULL,
        no_venta INT NULL,
        estatus_anterior INT NULL,
        tipo_cambio VARCHAR(50) NULL,
        enviado BIT DEFAULT 0,
        fecha_envio DATETIME NULL,
        completado BIT NOT NULL DEFAULT 0
    );
END
GO

-- Índices conservados
IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('detalle_pedidos_bitacora') AND name = 'IX_bitacora_id_pedido')
    CREATE INDEX IX_bitacora_id_pedido ON detalle_pedidos_bitacora(id_pedido);
IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('detalle_pedidos_bitacora') AND name = 'IX_bitacora_ruta_fecha')
    CREATE INDEX IX_bitacora_ruta_fecha ON detalle_pedidos_bitacora(ruta, fecha);
IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('detalle_pedidos_bitacora') AND name = 'IX_bitacora_enviado')
    CREATE INDEX IX_bitacora_enviado ON detalle_pedidos_bitacora(enviado);
IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('detalle_pedidos_bitacora') AND name = 'IX_bitacora_folio')
    CREATE INDEX IX_bitacora_folio ON detalle_pedidos_bitacora(folio);
IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('detalle_pedidos_bitacora') AND name = 'IX_bitacora_id_movil')
    CREATE INDEX IX_bitacora_id_movil ON detalle_pedidos_bitacora(id_movil);
GO

-- Procedimiento para insertar snapshot optimizado
CREATE PROCEDURE sp_MovilesPedidosBitacora_Insert
    @id_pedido INT,
    @id_movil BIGINT = NULL,
    @folio INT,
    @fecha DATETIME,
    @ruta INT,
    @fechaAtencion DATETIME = NULL,
    @idVendedor INT,
    @idProducto INT = NULL,
    @precio DECIMAL(18,2) = NULL,
    @estatus INT,
    @cantAtencion DECIMAL(18,3) = NULL,
    @precioAtencion DECIMAL(18,2) = NULL,
    @causaDiferencia INT = NULL,
    @obserDiferencia VARCHAR(500) = NULL,
    @causaNoAtencion INT = NULL,
    @obserNoAtencion VARCHAR(500) = NULL,
    @no_venta INT = NULL,
    @estatus_anterior INT = NULL,
    @tipo_cambio VARCHAR(50) = NULL,
    @enviado BIT = 0,
    @fecha_envio DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRY
        BEGIN TRANSACTION;

        INSERT INTO detalle_pedidos_bitacora (
            id_pedido, id_movil, folio, fecha, ruta, fechaAtencion,
            idVendedor, idProducto, precio, estatus, cantAtencion,
            precioAtencion, causaDiferencia, obserDiferencia,
            causaNoAtencion, obserNoAtencion, no_venta,
            estatus_anterior, tipo_cambio, enviado, fecha_envio, completado
        )
        VALUES (
            @id_pedido, @id_movil, @folio, @fecha, @ruta, @fechaAtencion,
            @idVendedor, @idProducto, @precio, @estatus, @cantAtencion,
            @precioAtencion, @causaDiferencia, @obserDiferencia,
            @causaNoAtencion, @obserNoAtencion, @no_venta,
            @estatus_anterior, @tipo_cambio, @enviado, @fecha_envio, 0
        );

        DECLARE @BitacoraId INT = SCOPE_IDENTITY();

        -- Actualizar la tabla principal según el tipo de cambio recibido
        IF @tipo_cambio = 'estatus'
        BEGIN
            UPDATE detalle_pedidos
            SET estatus = @estatus,
                precio = @precio,
                no_venta = @no_venta,
                fechaAtencion = ISNULL(@fechaAtencion, GETDATE()),
                causaNoAtencion = @causaNoAtencion,
                obserNoAtencion = @obserNoAtencion
            WHERE folio = @folio AND ruta = @ruta;
        END
        ELSE IF @tipo_cambio IN ('cantidad', 'causa') AND @idProducto IS NOT NULL
        BEGIN
            UPDATE detalle_pedidos
            SET cantAtencion = @cantAtencion,
                precioAtencion = @precioAtencion,
                precio = @precio,
                no_venta = @no_venta,
                causaDiferencia = @causaDiferencia,
                obserDiferencia = @obserDiferencia,
                estatus = ISNULL(@estatus, estatus)
            WHERE folio = @folio AND ruta = @ruta AND idProducto = @idProducto;
        END

        UPDATE detalle_pedidos_bitacora
        SET completado = 1
        WHERE id = @BitacoraId;

        COMMIT TRANSACTION;
        SELECT @BitacoraId AS id;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH
END
GO

-- Procedimiento de consulta con las mismas columnas reducidas
CREATE PROCEDURE sp_MovilesPedidosBitacora_Select
    @id_pedido INT
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        id, id_pedido, id_movil, folio, fecha, ruta, fechaAtencion,
        idVendedor, idProducto, precio, estatus, cantAtencion,
        precioAtencion, causaDiferencia, obserDiferencia,
        causaNoAtencion, obserNoAtencion, no_venta,
        estatus_anterior, tipo_cambio, enviado, fecha_envio, completado
    FROM detalle_pedidos_bitacora
    WHERE id_pedido = @id_pedido
    ORDER BY fecha DESC, id DESC;
END
GO

-- =============================================
-- Procedimiento de arrastre: inserta en bitácora y actualiza detalle_pedidos
-- Procesa las bitácoras de fecha menor a mayor para que el estado final
-- sea el de la última actualización. Marca cada renglón de bitácora como
-- completado para no volver a aplicarlo.
-- =============================================
create or alter  PROCEDURE [dbo].[sp_DetallePedidosBitacoraArrastreJSON]
    @json NVARCHAR(MAX),
    @idUsuario INT
AS
BEGIN
    SET NOCOUNT ON;

    BEGIN TRY
        BEGIN TRANSACTION;

        IF ISJSON(@json) <> 1
        BEGIN
            THROW 50001, 'El formato del JSON es inválido.', 1;
        END

        DECLARE @Ids TABLE (id INT);

        -- Insertar la bitácora completa, ignorando duplicados por id_movil
        INSERT INTO detalle_pedidos_bitacora (
            id_pedido, id_movil, folio, fecha, ruta, fechaAtencion,
            idVendedor, idProducto, precio, estatus, cantAtencion,
            precioAtencion, causaDiferencia, obserDiferencia,
            causaNoAtencion, obserNoAtencion, no_venta,
            estatus_anterior, tipo_cambio, enviado, fecha_envio, completado
        )
        OUTPUT inserted.id INTO @Ids
        SELECT
            j.id_pedido,
            j.id_movil,
            j.folio,
            j.fecha,
            j.ruta,
            j.fechaAtencion,
            j.idVendedor,
            j.idProducto,
            j.precio,
            j.estatus,
            j.cantAtencion,
            j.precioAtencion,
            j.causaDiferencia,
            j.obserDiferencia,
            j.causaNoAtencion,
            j.obserNoAtencion,
            j.no_venta,
            j.estatus_anterior,
            j.tipo_cambio,
            ISNULL(j.enviado, 1),
            j.fecha_envio,
            0 AS completado
        FROM OPENJSON(@json)
        WITH (
            id_pedido INT,
            id_movil BIGINT,
            folio INT,
            fecha DATETIME,
            ruta INT,
            fechaAtencion DATETIME,
            idVendedor INT,
            idProducto INT,
            precio DECIMAL(18,2),
            estatus INT,
            cantAtencion DECIMAL(18,3),
            precioAtencion DECIMAL(18,2),
            causaDiferencia INT,
            obserDiferencia VARCHAR(500),
            causaNoAtencion INT,
            obserNoAtencion VARCHAR(500),
            no_venta INT,
            estatus_anterior INT,
            tipo_cambio VARCHAR(50),
            enviado BIT,
            fecha_envio DATETIME
        ) j
        WHERE NOT EXISTS (
              SELECT 1 FROM detalle_pedidos_bitacora b
              WHERE b.folio = j.folio
                AND b.fecha = j.fecha
                AND (b.idProducto = j.idProducto OR (b.idProducto IS NULL AND j.idProducto IS NULL))
          );

        -- Aplicar actualizaciones de la más antigua a la más reciente
        DECLARE cur CURSOR FOR
            SELECT
                b.id,
                b.folio,
                b.ruta,
                b.fechaAtencion,
                b.idProducto,
                b.precio,
                b.estatus,
                b.cantAtencion,
                b.precioAtencion,
                b.causaDiferencia,
                b.obserDiferencia,
                b.causaNoAtencion,
                b.obserNoAtencion,
                b.no_venta,
                b.tipo_cambio
            FROM detalle_pedidos_bitacora b
            INNER JOIN @Ids i ON b.id = i.id
            WHERE b.completado = 0
            ORDER BY b.fecha ASC, b.folio ASC;

        DECLARE @id INT,
                @folio INT,
                @ruta INT,
                @fechaAtencion DATETIME,
                @idProducto INT,
                @precio DECIMAL(18,2),
                @estatus INT,
                @cantAtencion DECIMAL(18,3),
                @precioAtencion DECIMAL(18,2),
                @causaDiferencia INT,
                @obserDiferencia VARCHAR(500),
                @causaNoAtencion INT,
                @obserNoAtencion VARCHAR(500),
                @no_venta INT,
                @tipo_cambio VARCHAR(50);

        OPEN cur;
        FETCH NEXT FROM cur INTO
            @id, @folio, @ruta, @fechaAtencion, @idProducto, @precio, @estatus,
            @cantAtencion, @precioAtencion, @causaDiferencia, @obserDiferencia,
            @causaNoAtencion, @obserNoAtencion, @no_venta, @tipo_cambio;

        WHILE @@FETCH_STATUS = 0
        BEGIN
            IF @tipo_cambio = 'estatus'
            BEGIN
                IF @idProducto IS NOT NULL
                    UPDATE detalle_pedidos
                    SET estatus = @estatus,
                        fechaAtencion = ISNULL(@fechaAtencion, GETDATE()),
                        cantAtencion = ISNULL(@cantAtencion, cantAtencion),
                        precioAtencion = ISNULL(@precioAtencion, precioAtencion),
                        precio = ISNULL(@precio, precio),
                        no_venta = ISNULL(@no_venta, no_venta),
                        causaDiferencia = ISNULL(@causaDiferencia, causaDiferencia),
                        obserDiferencia = ISNULL(@obserDiferencia, obserDiferencia),
                        causaNoAtencion = ISNULL(@causaNoAtencion, causaNoAtencion),
                        obserNoAtencion = ISNULL(@obserNoAtencion, obserNoAtencion)
                    WHERE folio = @folio AND ruta = @ruta AND idProducto = @idProducto;
                ELSE
                    UPDATE detalle_pedidos
                    SET estatus = @estatus,
                        fechaAtencion = ISNULL(@fechaAtencion, GETDATE()),
                        cantAtencion = ISNULL(@cantAtencion, cantAtencion),
                        precioAtencion = ISNULL(@precioAtencion, precioAtencion),
                        precio = ISNULL(@precio, precio),
                        no_venta = ISNULL(@no_venta, no_venta),
                        causaDiferencia = ISNULL(@causaDiferencia, causaDiferencia),
                        obserDiferencia = ISNULL(@obserDiferencia, obserDiferencia),
                        causaNoAtencion = ISNULL(@causaNoAtencion, causaNoAtencion),
                        obserNoAtencion = ISNULL(@obserNoAtencion, obserNoAtencion)
                    WHERE folio = @folio AND ruta = @ruta;
            END
            ELSE IF @tipo_cambio IN ('cantidad', 'causa') AND @idProducto IS NOT NULL
            BEGIN
                UPDATE detalle_pedidos
                SET cantAtencion = @cantAtencion,
                    precioAtencion = @precioAtencion,
                    precio = @precio,
                    no_venta = @no_venta,
                    causaDiferencia = @causaDiferencia,
                    obserDiferencia = @obserDiferencia,
                    estatus = ISNULL(@estatus, estatus)
                WHERE folio = @folio AND ruta = @ruta AND idProducto = @idProducto;
            END

            UPDATE detalle_pedidos_bitacora
            SET completado = 1
            WHERE id = @id;

            FETCH NEXT FROM cur INTO
                @id, @folio, @ruta, @fechaAtencion, @idProducto, @precio, @estatus,
                @cantAtencion, @precioAtencion, @causaDiferencia, @obserDiferencia,
                @causaNoAtencion, @obserNoAtencion, @no_venta, @tipo_cambio;
        END

        CLOSE cur;
        DEALLOCATE cur;

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
