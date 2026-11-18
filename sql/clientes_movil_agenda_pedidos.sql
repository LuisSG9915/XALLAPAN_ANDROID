-- Propuesta para pruebas. Conserva los parametros y columnas de ambos SP.
-- Supuesto: @sucursal es el codigo de ruta que usan agenda y pedidos.

ALTER PROCEDURE [dbo].[sp_MovilClientesFull]
    @sucursal INT
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @hoy DATE = CONVERT(DATE, GETDATE());
    -- El limite exclusivo incluye todo el tercer dia despues de hoy.
    DECLARE @finVentana DATE = DATEADD(DAY, 4, @hoy);

    -- UNION devuelve cada cliente una sola vez, aunque aparezca en varias fuentes.
    ;WITH ClientesDeLaRuta AS (
        -- Catalogo de la ruta.
        SELECT c.id
        FROM dbo.cat_clientes_suc AS c
        WHERE c.ruta = @sucursal

        UNION

        -- Visitas de hoy y de los proximos tres dias.
        SELECT a.idCliente
        FROM dbo.c_cat_clientesAgendaAll AS a
        WHERE a.ruta = @sucursal
          AND a.fecha >= @hoy
          AND a.fecha < @finVentana

        UNION

        -- Pedidos de la ventana y pendientes de dias anteriores.
        SELECT p.cliente
        FROM dbo.detalle_pedidos AS p
        WHERE p.ruta = @sucursal
          AND p.folio > 0
          AND p.fechaEntrega < @finVentana
          AND (p.fechaEntrega >= @hoy OR p.estatus IN (3, 4, 5, 7, 8, 10))
    )
    SELECT
        c.id, c.nombre,
        CAST(c.longitud AS FLOAT) AS longitud,
        CAST(c.latitud AS FLOAT) AS latitud,
        c.idGrupo, c.credito,
        CAST(0 AS BIT) AS facturacionMovil,
        c.fecha_act, c.listaPrecio, c.domicilio, c.idEmpresa, c.referencia
    FROM dbo.cat_clientes_suc AS c
    INNER JOIN ClientesDeLaRuta AS r ON r.id = c.id
    WHERE c.suspendido = 0;
END;
GO

ALTER PROCEDURE [dbo].[sp_MovilClientes]
    @sucursal INT,
    @fechaInicial DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @hoy DATE = CONVERT(DATE, GETDATE());
    DECLARE @finVentana DATE = DATEADD(DAY, 4, @hoy);
    SET @fechaInicial = ISNULL(@fechaInicial, CONVERT(DATETIME, '19000101', 112));

    -- Primer dia que quedaba fuera de la ventana en la ultima sincronizacion.
    DECLARE @finVentanaAnterior DATE = DATEADD(DAY, 4, CONVERT(DATE, @fechaInicial));

    ;WITH CambiosDeCatalogo AS (
        SELECT l.id
        FROM dbo.Cat_clientes_suc_Log AS l
        WHERE l.fechaLog > @fechaInicial
    ),
    ClientesDeLaRutaConCambios AS (
        -- Catalogo de la ruta: cambio en la ficha del cliente.
        SELECT c.id
        FROM dbo.cat_clientes_suc AS c
        WHERE c.ruta = @sucursal
          AND EXISTS (SELECT 1 FROM CambiosDeCatalogo AS l WHERE l.id = c.id)

        UNION

        -- Agenda: hubo un cambio o la visita acaba de entrar en la ventana.
        SELECT a.idCliente
        FROM dbo.c_cat_clientesAgendaAll AS a
        WHERE a.ruta = @sucursal
          AND a.fecha >= @hoy
          AND a.fecha < @finVentana
          AND (
              a.fecha >= @finVentanaAnterior
              OR EXISTS (SELECT 1 FROM CambiosDeCatalogo AS l WHERE l.id = a.idCliente)
              OR EXISTS (
                  SELECT 1
                  FROM dbo.cat_clientes_agenda_Log AS l
                  WHERE l.id = a.id AND l.fechaLog > @fechaInicial
              )
          )

        UNION

        -- Pedidos: hubo un cambio o la entrega quedaba fuera de la ventana anterior.
        SELECT p.cliente
        FROM dbo.detalle_pedidos AS p
        WHERE p.ruta = @sucursal
          AND p.folio > 0
          AND p.fechaEntrega < @finVentana
          AND (p.fechaEntrega >= @hoy OR p.estatus IN (3, 4, 5, 7, 8, 10))
          AND (
              p.fechaEntrega >= @finVentanaAnterior
              OR EXISTS (SELECT 1 FROM CambiosDeCatalogo AS l WHERE l.id = p.cliente)
              OR EXISTS (
                  SELECT 1
                  FROM dbo.detalle_pedidos_Log AS l
                  WHERE l.id = p.id AND l.fechaLog > @fechaInicial
              )
          )
    )
    SELECT
        c.id, c.nombre,
        CAST(c.longitud AS FLOAT) AS longitud,
        CAST(c.latitud AS FLOAT) AS latitud,
        c.idGrupo, c.credito,
        CAST(0 AS BIT) AS facturacionMovil,
        c.fecha_act, c.listaPrecio, c.domicilio, c.idEmpresa, c.referencia
    FROM dbo.cat_clientes_suc AS c
    INNER JOIN ClientesDeLaRutaConCambios AS r ON r.id = c.id
    WHERE c.suspendido = 0;
END;
GO
