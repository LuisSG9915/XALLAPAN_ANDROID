-- =============================================
-- Script: Ajustes del módulo Pedidos - Fase de implementación
-- Descripción:
--   1. Ajusta la tabla detalle_pedidos_bitacora para soportar bitácoras sin producto (cambios de estatus)
--      y amplía id_movil a BIGINT (el timestamp del móvil supera el rango de INT).
--   2. Altera sp_MovilesPedidosFull para devolver un renglón por folio+producto (incluye precio).
--   3. Recrea sp_MovilesPedidosBitacora_Insert para insertar en bitácora Y actualizar detalle_pedidos.
-- Fecha: 01/08/2026
-- =============================================

-- 1. Ajustar tipos de tabla detalle_pedidos_bitacora si ya existe
IF OBJECT_ID('detalle_pedidos_bitacora', 'U') IS NOT NULL
BEGIN
    -- Hacer idProducto nullable: los cambios de estatus del pedido no llevan producto
    IF EXISTS(SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('detalle_pedidos_bitacora') AND name = 'idProducto')
    BEGIN
        ALTER TABLE detalle_pedidos_bitacora ALTER COLUMN idProducto INT NULL;
    END

    -- Ampliar id_movil a BIGINT: Date.now() del móvil puede superar 2,147,483,647
    IF EXISTS(SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('detalle_pedidos_bitacora') AND name = 'id_movil')
    BEGIN
        ALTER TABLE detalle_pedidos_bitacora ALTER COLUMN id_movil BIGINT NULL;
    END
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
        cliente INT NOT NULL,
        idCanal INT NULL,
        fechaAtencion DATETIME NULL,
        idVendedor INT NOT NULL,
        idProducto INT NULL,
        cantPedido DECIMAL(18,3) NULL,
        precio DECIMAL(18,2) NULL,
        observaciones VARCHAR(500) NULL,
        listaPrecio INT NULL,
        fechaEntrega DATETIME NULL,
        estatus INT NOT NULL,
        cantAtencion DECIMAL(18,3) NULL,
        precioAtencion DECIMAL(18,2) NULL,
        causaDiferencia INT NULL,
        obserDiferencia VARCHAR(500) NULL,
        causaNoAtencion INT NULL,
        obserNoAtencion VARCHAR(500) NULL,
        usrAlta INT NULL,
        fueraAgenda BIT NULL,
        no_venta INT NULL,
        fecha_movil DATETIME NULL,
        estatus_anterior INT NULL,
        tipo_cambio VARCHAR(50) NULL,
        enviado BIT DEFAULT 0,
        fecha_envio DATETIME NULL
    );

    CREATE INDEX IX_bitacora_id_pedido ON detalle_pedidos_bitacora(id_pedido);
    CREATE INDEX IX_bitacora_ruta_fecha ON detalle_pedidos_bitacora(ruta, fecha);
    CREATE INDEX IX_bitacora_enviado ON detalle_pedidos_bitacora(enviado);
    CREATE INDEX IX_bitacora_folio ON detalle_pedidos_bitacora(folio);
    CREATE INDEX IX_bitacora_id_movil ON detalle_pedidos_bitacora(id_movil);
END
GO

-- 2. Alterar sp_MovilesPedidosFull para traer los productos del pedido
--    Ahora devuelve 1 renglón por folio + idProducto. La app agrupa por folio para la cabecera.
IF OBJECT_ID('sp_MovilesPedidosFull', 'P') IS NOT NULL
    DROP PROCEDURE sp_MovilesPedidosFull;
GO

CREATE PROCEDURE sp_MovilesPedidosFull
    @ruta INT
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        folio,
        listaPrecio,
        cliente,
        COUNT(DISTINCT idProducto) AS numeroProductos,
        CAST(SUM(ISNULL(cantPedido, 0)) AS DECIMAL(18,3)) AS cantPedido,
        MAX(fecha) AS fecha,
        fechaEntrega,
        ruta,
        idVendedor,
        estatus,
        fueraAgenda,
        MAX(observaciones) AS observaciones,
        MAX(no_venta) AS no_venta,
        idProducto,
        MAX(precio) AS precio
    FROM detalle_pedidos
    WHERE folio > 0
      AND fechaEntrega <= GETDATE()
      AND ruta = @ruta
    GROUP BY folio, listaPrecio, cliente, fechaEntrega, ruta,
             idVendedor, estatus, fueraAgenda, idProducto;
END
GO

-- 3. Recrear SP de bitácora: inserta snapshot y actualiza detalle_pedidos ("la principal")
IF OBJECT_ID('sp_MovilesPedidosBitacora_Insert', 'P') IS NOT NULL
    DROP PROCEDURE sp_MovilesPedidosBitacora_Insert;
GO

CREATE PROCEDURE sp_MovilesPedidosBitacora_Insert
    @id_pedido INT,
    @id_movil BIGINT = NULL,
    @folio INT,
    @fecha DATETIME,
    @ruta INT,
    @cliente INT,
    @idCanal INT = NULL,
    @fechaAtencion DATETIME = NULL,
    @idVendedor INT,
    @idProducto INT = NULL,
    @cantPedido DECIMAL(18,3) = NULL,
    @precio DECIMAL(18,2) = NULL,
    @observaciones VARCHAR(500) = NULL,
    @listaPrecio INT = NULL,
    @fechaEntrega DATETIME = NULL,
    @estatus INT,
    @cantAtencion DECIMAL(18,3) = NULL,
    @precioAtencion DECIMAL(18,2) = NULL,
    @causaDiferencia INT = NULL,
    @obserDiferencia VARCHAR(500) = NULL,
    @causaNoAtencion INT = NULL,
    @obserNoAtencion VARCHAR(500) = NULL,
    @usrAlta INT = NULL,
    @fueraAgenda BIT = NULL,
    @no_venta INT = NULL,
    @fecha_movil DATETIME = NULL,
    @estatus_anterior INT = NULL,
    @tipo_cambio VARCHAR(50) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRY
        BEGIN TRANSACTION;

        INSERT INTO detalle_pedidos_bitacora (
            id_pedido, id_movil, folio, fecha, ruta, cliente, idCanal,
            fechaAtencion, idVendedor, idProducto, cantPedido, precio,
            observaciones, listaPrecio, fechaEntrega, estatus, cantAtencion,
            precioAtencion, causaDiferencia, obserDiferencia, causaNoAtencion,
            obserNoAtencion, usrAlta, fueraAgenda, no_venta,
            fecha_movil, estatus_anterior, tipo_cambio, enviado
        )
        VALUES (
            @id_pedido, @id_movil, @folio, @fecha, @ruta, @cliente, @idCanal,
            @fechaAtencion, @idVendedor, @idProducto, @cantPedido, @precio,
            @observaciones, @listaPrecio, @fechaEntrega, @estatus, @cantAtencion,
            @precioAtencion, @causaDiferencia, @obserDiferencia, @causaNoAtencion,
            @obserNoAtencion, @usrAlta, @fueraAgenda, @no_venta,
            @fecha_movil, @estatus_anterior, @tipo_cambio, 0
        );

        -- Actualizar la tabla principal según el tipo de cambio recibido
        IF @tipo_cambio = 'estatus'
        BEGIN
            UPDATE detalle_pedidos
            SET estatus = @estatus,
                fechaAtencion = ISNULL(@fechaAtencion, GETDATE()),
                causaNoAtencion = @causaNoAtencion,
                obserNoAtencion = @obserNoAtencion
            WHERE folio = @folio;
        END
        ELSE IF @tipo_cambio IN ('cantidad', 'causa') AND @idProducto IS NOT NULL
        BEGIN
            UPDATE detalle_pedidos
            SET cantAtencion = @cantAtencion,
                precioAtencion = @precioAtencion,
                causaDiferencia = @causaDiferencia,
                obserDiferencia = @obserDiferencia,
                estatus = ISNULL(@estatus, estatus)
            WHERE folio = @folio AND idProducto = @idProducto;
        END

        COMMIT TRANSACTION;
        SELECT SCOPE_IDENTITY() AS id;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH
END
GO

PRINT 'Ajustes del módulo Pedidos aplicados correctamente';
