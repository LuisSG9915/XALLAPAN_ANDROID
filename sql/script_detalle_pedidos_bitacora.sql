-- =============================================
-- Script: Creación de tabla detalle_pedidos_bitacora
-- Descripción: Almacena el historial de cambios de los pedidos
--              Cada vez que cambia un pedido, se guarda el renglón completo
-- Fecha: 31/07/2026
-- =============================================

-- Verificar si la tabla ya existe
IF OBJECT_ID('detalle_pedidos_bitacora', 'U') IS NOT NULL
BEGIN
    PRINT 'La tabla detalle_pedidos_bitacora ya existe';
    RETURN;
END

-- Crear la tabla
CREATE TABLE detalle_pedidos_bitacora (
    -- Identificadores
    id INT IDENTITY(1,1) PRIMARY KEY,
    id_pedido INT NOT NULL,
    id_movil INT NULL,
    folio INT NOT NULL,
    
    -- Datos del pedido (snapshot al momento del cambio)
    fecha DATETIME NOT NULL,
    ruta INT NOT NULL,
    cliente INT NOT NULL,
    idCanal INT NULL,
    fechaAtencion DATETIME NULL,
    idVendedor INT NOT NULL,
    idProducto INT NOT NULL,
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
    
    -- Campos de control
    fecha_movil DATETIME NULL,
    estatus_anterior INT NULL,
    tipo_cambio VARCHAR(50) NULL,
    enviado BIT DEFAULT 0,
    fecha_envio DATETIME NULL
);

-- Índices para mejorar rendimiento
CREATE INDEX IX_bitacora_id_pedido ON detalle_pedidos_bitacora(id_pedido);
CREATE INDEX IX_bitacora_ruta_fecha ON detalle_pedidos_bitacora(ruta, fecha);
CREATE INDEX IX_bitacora_enviado ON detalle_pedidos_bitacora(enviado) WHERE enviado = 0;
CREATE INDEX IX_bitacora_folio ON detalle_pedidos_bitacora(folio);
CREATE INDEX IX_bitacora_id_movil ON detalle_pedidos_bitacora(id_movil) WHERE id_movil IS NOT NULL;

PRINT 'Tabla detalle_pedidos_bitacora creada exitosamente';

-- =============================================
-- Procedimiento almacenado para insertar en bitacora
-- =============================================
IF OBJECT_ID('sp_MovilesPedidosBitacora_Insert', 'P') IS NOT NULL
    DROP PROCEDURE sp_MovilesPedidosBitacora_Insert;
GO

CREATE PROCEDURE sp_MovilesPedidosBitacora_Insert
    @id_pedido INT,
    @id_movil INT = NULL,
    @folio INT,
    @fecha DATETIME,
    @ruta INT,
    @cliente INT,
    @idCanal INT = NULL,
    @fechaAtencion DATETIME = NULL,
    @idVendedor INT,
    @idProducto INT,
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
    
    SELECT SCOPE_IDENTITY() AS id;
END
GO

-- =============================================
-- Procedimiento para obtener bitácora de un pedido
-- =============================================
IF OBJECT_ID('sp_MovilesPedidosBitacora_Select', 'P') IS NOT NULL
    DROP PROCEDURE sp_MovilesPedidosBitacora_Select;
GO

CREATE PROCEDURE sp_MovilesPedidosBitacora_Select
    @id_pedido INT
AS
BEGIN
    SET NOCOUNT ON;
    
    SELECT 
        id, id_pedido, id_movil, folio, fecha, ruta, cliente,
        idCanal, fechaAtencion, idVendedor, idProducto, cantPedido,
        precio, observaciones, listaPrecio, fechaEntrega, estatus,
        cantAtencion, precioAtencion, causaDiferencia, obserDiferencia,
        causaNoAtencion, obserNoAtencion, usrAlta, fueraAgenda, no_venta,
        fecha_movil, estatus_anterior, tipo_cambio, enviado, fecha_envio
    FROM detalle_pedidos_bitacora
    WHERE id_pedido = @id_pedido
    ORDER BY fecha_movil DESC, id DESC;
END
GO

PRINT 'Procedimientos almacenados creados exitosamente';
