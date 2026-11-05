-- =============================================
-- Script: Pedidos pendientes en agenda (cualquier fecha)
-- Descripción:
--   Ambos SP filtraban fechaEntrega = HOY, por lo que un pedido pendiente
--   de un día anterior desaparecía de la app (y al borrar datos del
--   dispositivo no volvía a descargarse).
--   Nuevo criterio en ambos:
--     * fechaEntrega = HOY            -> todos los estatus (comportamiento actual)
--     * fechaEntrega < HOY            -> solo estatus abiertos
--                                      (3 CONFIRMADO, 4 NOTIFICADO, 5 EN ATENCION,
--                                       7 PENDIENTE CON CAUSA, 8 PENDIENTE SIN CAUSA,
--                                       10 EN CAPTURA)
--   Se excluyen cerrados (2 ENTREGADO, 6 ENTREGADO PARCIAL, 9 CANCELADO) y
--   pedidos con fechaEntrega futura, igual que el SP desplegado.
-- Fecha: 2026-11-03
-- =============================================

-- 1. sp_MovilesPedidosFull: sync completa (login / restauración de la app)
IF OBJECT_ID('sp_MovilesPedidosFull', 'P') IS NOT NULL
    DROP PROCEDURE sp_MovilesPedidosFull;
GO

CREATE PROCEDURE [dbo].[sp_MovilesPedidosFull]
    @ruta int
AS
BEGIN
    SELECT
        folio,
        detalle_pedidos.listaPrecio,
        cliente,
        COUNT(idProducto) OVER(PARTITION BY folio) AS numeroProductos,
        CAST(SUM(ISNULL(cantPedido, 0)) AS DECIMAL(18,3)) AS cantPedido,
        MAX(fecha) AS fecha,
        fechaEntrega,
        detalle_pedidos.ruta,
        idVendedor,
        estatus,
        fueraAgenda,
        observaciones,
        no_venta,
        idProducto,
        cat_clientes_suc.nombre AS nombreCliente,
        cat_clientes_suc.domicilio AS domicilioCliente
    FROM detalle_pedidos
    inner join cat_clientes_suc on detalle_pedidos.cliente = cat_clientes_suc.id
    WHERE folio > 0
      AND detalle_pedidos.ruta = @ruta
      AND (
        CAST(fechaEntrega AS DATE) = CAST(GETDATE() AS DATE)
        OR (
          CAST(fechaEntrega AS DATE) < CAST(GETDATE() AS DATE)
          AND estatus IN (3, 4, 5, 7, 8, 10)
        )
      )
    GROUP BY
        folio,
        detalle_pedidos.listaPrecio,
        cliente,
        fechaEntrega,
        detalle_pedidos.ruta,
        idVendedor,
        estatus,
        fueraAgenda,
        observaciones,
        no_venta,
        idProducto,
        nombre,
        domicilio
END
GO

-- 2. sp_MovilesPedidos: incremental/poll. Mismo criterio de fecha, más un
--    rescate de pendientes abiertos cuando el cursor es la fecha centinela
--    (instalación limpia / datos borrados): un pedido pendiente viejo cuyo
--    último log quedó antes del cursor no entraría a FoliosCambiados.
IF OBJECT_ID('sp_MovilesPedidos', 'P') IS NOT NULL
    DROP PROCEDURE sp_MovilesPedidos;
GO

CREATE PROCEDURE [dbo].[sp_MovilesPedidos]
    @ruta INT,
    @fechaInicial DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;

    -- 1. Asignar fecha por defecto si viene nula
    IF @fechaInicial IS NULL
        SET @fechaInicial = '1900-01-01';

    -- 2. Folios únicos con movimientos después de la fecha, más los folios
    --    abiertos de días anteriores cuando la app restaura todo (cursor centinela)
    WITH FoliosCambiados AS (
        SELECT DISTINCT folio
        FROM detalle_pedidos_Log
        WHERE fechaLog > @fechaInicial

        UNION

        SELECT DISTINCT folio
        FROM detalle_pedidos
        WHERE @fechaInicial <= '1901-01-01'
          AND estatus IN (3, 4, 5, 7, 8, 10)
          AND CAST(fechaEntrega AS DATE) < CAST(GETDATE() AS DATE)
    )

    -- 3. Consulta principal (detalle real por renglón)
    SELECT
        dp.id,
        dp.folio,
        dp.listaPrecio,
        dp.cliente,
        COUNT(dp.id) OVER(PARTITION BY dp.folio) AS numeroProductos,
        CAST(ISNULL(dp.cantPedido, 0) AS DECIMAL(18,3)) AS cantPedido,
        dp.fecha,
        dp.fechaEntrega,
        dp.ruta,
        dp.idVendedor,
        dp.estatus,
        dp.fueraAgenda,
        dp.observaciones,
        dp.no_venta,
        dp.idProducto,
        cat_clientes_suc.nombre AS nombreCliente,
        cat_clientes_suc.domicilio AS domicilioCliente
    FROM detalle_pedidos dp
    INNER JOIN FoliosCambiados fc ON fc.folio = dp.folio
    INNER JOIN cat_clientes_suc ON dp.cliente = cat_clientes_suc.id
    WHERE dp.folio > 0
      AND dp.ruta = @ruta
      AND (
        CAST(dp.fechaEntrega AS DATE) = CAST(GETDATE() AS DATE)
        OR (
          CAST(dp.fechaEntrega AS DATE) < CAST(GETDATE() AS DATE)
          AND dp.estatus IN (3, 4, 5, 7, 8, 10)
        )
      )
END
GO
