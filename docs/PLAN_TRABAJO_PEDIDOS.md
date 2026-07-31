# Plan de Trabajo: Módulo de Pedidos

**Fecha:** 31 de Julio de 2026  
**Proyecto:** Xallapan - App Móvil para Vendedores de Ruta  
**Módulo:** Gestión de Pedidos (Pedidos de Central)

---

## Resumen Ejecutivo

Este documento describe el desarrollo del módulo de **Pedidos** para la aplicación móvil Xallapan. El módulo permite a los vendedores de ruta atender pedidos previamente registrados desde central, gestionar cantidades entregadas, registrar causas de diferencia/no atención, y cumplir con las restricciones de cierre de ruta.

---

## 1. Contexto del Proyecto

### 1.1 Tecnología Existente
- **Frontend:** React Native 0.82.1 + TypeScript
- **Base de datos local:** Realm
- **Navegación:** React Navigation (native-stack)
- **API Backend:** `https://api.cbinformatica.net:9031`
- **Sincronización:** FullSyncService, BackgroundSyncService
- **UI Components:** react-native-elements

### 1.2 Módulos Relacionados Existentes
| Módulo | Archivo | Descripción |
|--------|---------|-------------|
| Cumplimiento | `components/CumplimientoScreen.tsx` | Gestión de visitas |
| Punto de Venta | `components/SalesScreen.tsx` | Registro de ventas |
| Cortes | `components/CortesScreen.tsx` | Corte de ruta |
| Cierre Ruta | `services/CierreRutaService.ts` | Control de cierre |

### 1.3 APIs Disponibles

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/api/MovilesVentas/sp_MovilesPedidosFull/{ruta}` | GET | Lista pedidos de la ruta |
| `/api/MovilesVentas/sp_MovilesPedidosDiferencias` | GET | Catálogo causas de diferencia |
| `/api/MovilesVentas/sp_MovilesPedidosNoAtencion` | GET | Catálogo causas de no atención |
| `/api/MovilesVentas/sp_MovilesPedidosEstatus` | GET | Catálogo estatus de pedidos |

---

## 2. Estructura de Datos

### 2.1 Tabla Principal: `detalle_pedidos`

| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | int | **PK** - Identificador único del pedido |
| folio | int | Folio del pedido |
| fecha | datetime | Fecha de creación |
| ruta | int | Ruta del vendedor |
| cliente | int | ID del cliente |
| idCanal | int | Canal de venta |
| fechaAtencion | datetime | Fecha de atención |
| idVendedor | int | ID del vendedor |
| idProducto | int | ID del producto |
| cantPedido | decimal(18,3) | Cantidad solicitada |
| precio | decimal | Precio del producto |
| observaciones | varchar | Observaciones del pedido |
| listaPrecio | int | Lista de precios |
| fechaEntrega | datetime | Fecha programada de entrega |
| estatus | int | Estatus del pedido (ver catálogo) |
| cantAtencion | decimal(18,3) | Cantidad entregada |
| precioAtencion | decimal | Precio al atender |
| causaDiferencia | int | ID causa de diferencia |
| obserDiferencia | varchar | Observación de diferencia |
| causaNoAtencion | int | ID causa de no atención |
| obserNoAtencion | varchar | Observación de no atención |
| usrAlta | int | Usuario que dio de alta |
| fueraAgenda | bit | Indicador fuera de agenda |
| no_venta | int | Número de venta (si aplica) |

### 2.2 Catálogo de Estatus

| ID | Descripción | Permite Modificación |
|----|-------------|---------------------|
| 1 | PROGRAMADO | Sí |
| 2 | ENTREGADO | No |
| 3 | CONFIRMADO | Sí |
| 4 | NOTIFICADO | Sí |
| 5 | EN ATENCION | Sí |
| 6 | ENTREGADO PARCIAL | No |
| 7 | PENDIENTE CON CAUSA | No |
| 8 | PENDIENTE SIN CAUSA | Sí |
| 9 | CANCELADO POR EL CLIENTE | No |
| 10 | EN CAPTURA | Sí |

### 2.3 Catálogo de Causas de Diferencia

| ID | Descripción |
|----|-------------|
| 1 | PRODUCTO NO DISPONIBLE |
| 2 | PRODUCTO DAÑADO |
| 3 | CLIENTE SOLICITA CANCELAR |
| 4 | ERROR EN CAPTURA ORIGINAL |
| 5 | OTRA |

### 2.4 Catálogo de Causas de No Atención

| ID | Descripción |
|----|-------------|
| 1 | CLIENTE NO SE ENCONTRABA |
| 2 | DOMICILIO CERRADO |
| 3 | CLIENTE RECHAZO EL PEDIDO |
| 4 | DIRECCION NO LOCALIZADA |
| 5 | OTRO |

### 2.5 Tabla Nueva: `detalle_pedidos_bitacora`

```sql
CREATE TABLE detalle_pedidos_bitacora (
    id INT IDENTITY(1,1) PRIMARY KEY,
    id_pedido INT NOT NULL,           -- ID del pedido (detalle_pedidos.id)
    folio INT NOT NULL,
    fecha DATETIME NOT NULL DEFAULT GETDATE(),
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
    estatus INT NOT NULL,             -- Estatus al momento del cambio
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
    id_movil INT NULL,                -- ID generado en el móvil
    fecha_movil DATETIME NULL,        -- Fecha/hora del cambio en el móvil
    estatus_anterior INT NULL,        -- Estatus previo al cambio
    tipo_cambio VARCHAR(50) NULL,     -- 'estatus', 'cantidad', 'causa', etc.
    enviado BIT DEFAULT 0             -- 0 = pendiente de enviar, 1 = enviado
);

-- Índices
CREATE INDEX IX_bitacora_id_pedido ON detalle_pedidos_bitacora(id_pedido);
CREATE INDEX IX_bitacora_ruta_fecha ON detalle_pedidos_bitacora(ruta, fecha);
CREATE INDEX IX_bitacora_enviado ON detalle_pedidos_bitacora(enviado);
```

---

## 3. Arquitectura del Módulo

### 3.1 Diagrama de Flujo

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FLUJO DE PEDIDOS                                │
└─────────────────────────────────────────────────────────────────────────────┘

┌──────────────┐      ┌──────────────────┐      ┌───────────────────────────┐
│  Sincronizar │─────▶│  Lista Pedidos   │─────▶│  Seleccionar Pedido       │
│  (API→Realm) │      │  (PedidosScreen) │      │  (PedidoDetalleScreen)    │
└──────────────┘      └──────────────────┘      └─────────────┬─────────────┘
                                                               │
                              ┌────────────────────────────────┼────────────────────────────────┐
                              │                                │                                │
                              ▼                                ▼                                ▼
               ┌─────────────────────────┐     ┌─────────────────────────┐    ┌─────────────────────────────┐
               │   Atender Pedido        │     │   No Atender Pedido     │    │     Ver Detalle             │
               │   (Marcar cantidades)   │     │   (Causa No Atención)   │    │     (Solo lectura)          │
               └────────────┬────────────┘     └────────────┬────────────┘    └─────────────────────────────┘
                            │                               │
                            ▼                               ▼
               ┌─────────────────────────┐     ┌─────────────────────────┐
               │  ¿Hay diferencia?       │     │  Estado: PENDIENTE      │
               │  cantPedido ≠ cantAten  │     │  CON CAUSA (7)          │
               └────────────┬────────────┘     └─────────────────────────┘
                            │
                ┌───────────┴───────────┐
                │                       │
                ▼                       ▼
    ┌─────────────────────┐  ┌─────────────────────┐
    │      SÍ             │  │       NO            │
    │  Seleccionar Causa  │  │  Estado: ENTREGADO  │
    │  de Diferencia      │  │  (2)                │
    └──────────┬──────────┘  └─────────────────────┘
               │
               ▼
    ┌─────────────────────┐
    │  Estado: ENTREGADO  │
    │  PARCIAL (6)        │
    └─────────────────────┘
```

### 3.2 Restricción de Cierre de Ruta

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      VALIDACIÓN CIERRE DE RUTA                           │
└─────────────────────────────────────────────────────────────────────────┘

    ┌─────────────────────────┐
    │   Intentar Cerrar Ruta  │
    └────────────┬────────────┘
                 │
                 ▼
    ┌─────────────────────────┐
    │  ¿Existen pedidos con   │
    │  estatus = 8 (PENDIENTE │────── SÍ ──────▶  ❌ BLOQUEAR CIERRE
    │  SIN CAUSA)?            │                   Mostrar lista de pedidos
    └────────────┬────────────┘                   bloqueantes
                 │
                 NO
                 │
                 ▼
    ┌─────────────────────────┐
    │  ✅ PERMITIR CIERRE     │
    │  (ejecutar corte)       │
    └─────────────────────────┘
```

---

## 4. Plan de Desarrollo

### FASE 1: Base de Datos (SQL Server)

| # | Tarea | Prioridad | Estado |
|---|-------|-----------|--------|
| 1.1 | Crear script SQL para tabla `detalle_pedidos_bitacora` | Alta | ⬜ |
| 1.2 | Crear índices necesarios | Alta | ⬜ |
| 1.3 | Documentar SPs que se ejecutarán en central | Media | ⬜ |

### FASE 2: Realm Schemas (Offline)

| # | Tarea | Prioridad | Estado |
|---|-------|-----------|--------|
| 2.1 | Crear `PedidoSchema` (cabecera agrupada) | Alta | ⬜ |
| 2.2 | Crear `PedidoDetalleSchema` (productos del pedido) | Alta | ⬜ |
| 2.3 | Crear `PedidoBitacoraSchema` (historial local) | Alta | ⬜ |
| 2.4 | Crear `CatalogoEstatusPedidoSchema` | Media | ⬜ |
| 2.5 | Crear `CatalogoCausaDiferenciaSchema` | Media | ⬜ |
| 2.6 | Crear `CatalogoCausaNoAtencionSchema` | Media | ⬜ |
| 2.7 | Actualizar `allSchemas` en RealmSchemas.ts | Alta | ⬜ |

### FASE 3: Servicios

| # | Tarea | Prioridad | Estado |
|---|-------|-----------|--------|
| 3.1 | Crear `PedidosService.ts` - CRUD local de pedidos | Alta | ⬜ |
| 3.2 | Crear `PedidosSyncService.ts` - Sincronización con API | Alta | ⬜ |
| 3.3 | Integrar pedidos en `FullSyncService.syncAll()` | Alta | ⬜ |
| 3.4 | Implementar envío de bitácora al servidor | Alta | ⬜ |

### FASE 4: Interfaces de Usuario

| # | Tarea | Prioridad | Estado |
|---|-------|-----------|--------|
| 4.1 | `PedidosScreen.tsx` - Lista de pedidos de la ruta | Alta | ⬜ |
| 4.2 | `PedidoDetalleScreen.tsx` - Detalle con productos | Alta | ⬜ |
| 4.3 | Componente `ModalCausaDiferencia` | Alta | ⬜ |
| 4.4 | Componente `ModalCausaNoAtencion` | Alta | ⬜ |
| 4.5 | Implementar validación GPS al abrir pedido | Alta | ⬜ |
| 4.6 | Comparación en tiempo real solicitado vs entregado | Alta | ⬜ |
| 4.7 | Indicadores visuales de estatus | Media | ⬜ |

### FASE 5: Integración y Reglas de Negocio

| # | Tarea | Prioridad | Estado |
|---|-------|-----------|--------|
| 5.1 | Modificar `CierreRutaService` para validar pedidos pendientes | Alta | ⬜ |
| 5.2 | Registrar cambios en bitácora local (Realm) | Alta | ⬜ |
| 5.3 | Implementar bloqueo de pedidos ENTREGADO/CANCELADO | Alta | ⬜ |
| 5.4 | Validar causas antes de marcar ENTREGADO PARCIAL | Alta | ⬜ |

### FASE 6: Navegación y Acceso

| # | Tarea | Prioridad | Estado |
|---|-------|-----------|--------|
| 6.1 | Registrar pantallas en `App.tsx` (Stack.Navigator) | Alta | ⬜ |
| 6.2 | Agregar acceso desde CumplimientoScreen (tab "Pedidos") | Media | ⬜ |
| 6.3 | Agregar indicador de pedidos pendientes en Home | Baja | ⬜ |

---

## 5. Especificaciones de UI/UX

### 5.1 PedidosScreen (Lista de Pedidos)

**Header:**
- Título: "Pedidos de Central"
- Fecha de entrega seleccionada
- Badge con total de pedidos pendientes

**Card de Pedido:**
```
┌─────────────────────────────────────────────────────────┐
│  📋 Folio: 1234                    [Badge Estatus]       │
│  👤 Cliente: Juan Pérez                                  │
│  📍 Av. Principal #123, Col. Centro                     │
│  📦 5 productos | Total: 25 unidades                    │
│  📅 Entrega: 24/07/2026                                 │
├─────────────────────────────────────────────────────────┤
│  [Atender]        [No Atender]        [Ver Detalle]     │
└─────────────────────────────────────────────────────────┘
```

**Filtros:**
- Por estatus (Todos, Pendientes, Entregados, etc.)
- Por fecha de entrega
- Búsqueda por cliente

### 5.2 PedidoDetalleScreen (Detalle del Pedido)

**Header:**
- Folio del pedido
- Nombre del cliente
- Dirección
- Estatus actual

**Información del Cliente:**
```
┌─────────────────────────────────────────────────────────┐
│  👤 Juan Pérez                                          │
│  📍 Av. Principal #123, Col. Centro, CP 12345          │
│  📞 (555) 123-4567                                      │
│  📝 Observaciones: Entregar por la tarde en tienda      │
└─────────────────────────────────────────────────────────┘
```

**Lista de Productos:**
```
┌─────────────────────────────────────────────────────────┐
│  Producto                          Solic.    Entreg.    │
├─────────────────────────────────────────────────────────┤
│  🥤 Refresco 600ml                 3        [  2  ]     │
│     ⚠️ Diferencia: 1 - Causa: PRODUCTO NO DISPONIBLE   │
├─────────────────────────────────────────────────────────┤
│  🍞 Pan Blanco                     5        [  5  ]     │
│     ✅ Entregado completo                               │
├─────────────────────────────────────────────────────────┤
│  🥛 Leche 1L                       2        [  0  ]     │
│     ⚠️ Pendiente de atención                           │
└─────────────────────────────────────────────────────────┘
```

**Resumen:**
```
┌─────────────────────────────────────────────────────────┐
│  Resumen de Entrega                                      │
│  ─────────────────────────────────────────────────────  │
│  Productos: 3                                            │
│  Unidades solicitadas: 10                               │
│  Unidades entregadas: 7                                  │
│  Con diferencia: 1 producto                             │
└─────────────────────────────────────────────────────────┘
```

**Botones de Acción:**
- [Confirmar Entrega] - Si todo está atendido
- [Confirmar Entrega Parcial] - Si hay diferencias con causas
- [No Atender Pedido] - Si no se puede entregar

### 5.3 Modal de Causa de Diferencia

```
┌─────────────────────────────────────────────────────────┐
│                    Causa de Diferencia                    │
├─────────────────────────────────────────────────────────┤
│  Producto: Refresco 600ml                               │
│  Solicitado: 3 | Entregado: 2                           │
│                                                         │
│  Seleccione el motivo:                                  │
│                                                         │
│  ○ PRODUCTO NO DISPONIBLE                               │
│  ○ PRODUCTO DAÑADO                                      │
│  ○ CLIENTE SOLICITA CANCELAR                            │
│  ○ ERROR EN CAPTURA ORIGINAL                            │
│  ○ OTRA                                                 │
│                                                         │
│  Observaciones (opcional):                              │
│  ┌─────────────────────────────────────────────────┐   │
│  │                                                 │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│              [Cancelar]     [Confirmar]                 │
└─────────────────────────────────────────────────────────┘
```

### 5.4 Modal de Causa de No Atención

```
┌─────────────────────────────────────────────────────────┐
│                  No Atender Pedido                       │
├─────────────────────────────────────────────────────────┤
│  Cliente: Juan Pérez                                    │
│  Folio: 1234                                            │
│                                                         │
│  Seleccione el motivo:                                  │
│                                                         │
│  ○ CLIENTE NO SE ENCONTRABA                             │
│  ○ DOMICILIO CERRADO                                    │
│  ○ CLIENTE RECHAZO EL PEDIDO                            │
│  ○ DIRECCION NO LOCALIZADA                              │
│  ○ OTRO                                                 │
│                                                         │
│  Observaciones (opcional):                              │
│  ┌─────────────────────────────────────────────────┐   │
│  │                                                 │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│              [Cancelar]     [Confirmar]                 │
└─────────────────────────────────────────────────────────┘
```

---

## 6. Esquemas de Realm Propuestos

### 6.1 PedidoSchema (Cabecera Agrupada)

```typescript
export const PedidoSchema = {
  name: "Pedido",
  properties: {
    id: "int",                      // PK - ID del pedido
    id_movil: "int?",               // ID generado en móvil para bitácora
    folio: "int",
    fecha: "date?",
    ruta: "int",
    cliente: "int",
    clienteNombre: "string?",       // Denormalizado de ClienteFull
    clienteDomicilio: "string?",    // Denormalizado de ClienteFull
    idCanal: "int?",
    fechaAtencion: "date?",
    idVendedor: "int",
    numeroProductos: "int",         // COUNT(DISTINCT idProducto)
    cantPedido: "float",            // SUM(cantPedido)
    listaPrecio: "int?",
    fechaEntrega: "date?",
    estatus: "int",
    estatusDescripcion: "string?",  // Denormalizado
    fueraAgenda: "bool?",
    observaciones: "string?",
    no_venta: "int?",
    // Campos de control local
    tieneDiferencia: "bool?",       // Indica si hay productos con diferencia
    causaNoAtencion: "int?",
    obserNoAtencion: "string?",
    syncedAt: "date",
    syncedAr: "date?",
    modificadoLocal: "bool?",       // true = hay cambios pendientes de enviar
  },
  primaryKey: "id",
};
```

### 6.2 PedidoDetalleSchema (Productos)

```typescript
export const PedidoDetalleSchema = {
  name: "PedidoDetalle",
  properties: {
    id: "string",                   // PK - `${idPedido}-${idProducto}`
    idPedido: "int",                // FK a Pedido.id
    idProducto: "int",
    productoNombre: "string?",      // Denormalizado de Producto
    cantPedido: "float",            // Cantidad solicitada
    cantAtencion: "float?",         // Cantidad entregada
    precio: "float?",
    precioAtencion: "float?",
    causaDiferencia: "int?",
    causaDiferenciaDesc: "string?", // Denormalizado
    obserDiferencia: "string?",
    // Estado local
    tieneDiferencia: "bool?",       // cantPedido !== cantAtencion
    atendido: "bool?",              // true si cantAtencion > 0
    modificadoLocal: "bool?",       // true = hay cambios pendientes de enviar
  },
  primaryKey: "id",
};
```

### 6.3 PedidoBitacoraSchema (Historial Local)

```typescript
export const PedidoBitacoraSchema = {
  name: "PedidoBitacora",
  properties: {
    id: "string",                   // PK - UUID generado en móvil
    idPedido: "int",
    folio: "int",
    fecha: "date",
    ruta: "int",
    cliente: "int",
    idVendedor: "int",
    idProducto: "int?",
    estatus: "int",
    estatusAnterior: "int?",
    cantPedido: "float?",
    cantAtencion: "float?",
    causaDiferencia: "int?",
    obserDiferencia: "string?",
    causaNoAtencion: "int?",
    obserNoAtencion: "string?",
    tipoCambio: "string?",          // 'estatus', 'cantidad', 'causa', etc.
    enviado: "bool",                // false = pendiente de enviar
  },
  primaryKey: "id",
};
```

### 6.4 Catálogos

```typescript
export const CatalogoEstatusPedidoSchema = {
  name: "CatalogoEstatusPedido",
  properties: {
    id: "int",
    descripcion: "string?",
  },
  primaryKey: "id",
};

export const CatalogoCausaDiferenciaSchema = {
  name: "CatalogoCausaDiferencia",
  properties: {
    id: "int",
    descripcion: "string?",
  },
  primaryKey: "id",
};

export const CatalogoCausaNoAtencionSchema = {
  name: "CatalogoCausaNoAtencion",
  properties: {
    id: "int",
    descripcion: "string?",
  },
  primaryKey: "id",
};
```

---

## 7. Reglas de Negocio

### 7.1 Transiciones de Estatus Válidas

| Desde | Hacia | Condición |
|-------|-------|-----------|
| PROGRAMADO (1) | EN ATENCION (5) | Vendedor abre el pedido |
| EN ATENCION (5) | ENTREGADO (2) | Todos los productos entregados completos |
| EN ATENCION (5) | ENTREGADO PARCIAL (6) | Hay diferencias con causas registradas |
| EN ATENCION (5) | PENDIENTE CON CAUSA (7) | Vendedor selecciona causa de no atención |
| EN ATENCION (5) | PENDIENTE SIN CAUSA (8) | Vendedor abandona sin registrar causa |

### 7.2 Reglas de Modificación

| Regla | Descripción |
|-------|-------------|
| R1 | Un pedido ENTREGADO (2) no puede modificarse |
| R2 | Un pedido CANCELADO (9) no puede modificarse |
| R3 | Un pedido ENTREGADO PARCIAL (6) no puede reabrirse |
| R4 | Un pedido PENDIENTE CON CAUSA (7) no puede reabrirse |
| R5 | Para marcar ENTREGADO PARCIAL, TODOS los productos con diferencia DEBEN tener causa registrada |

### 7.3 Restricción de Cierre de Ruta

| Condición | ¿Permite Cierre? |
|-----------|-----------------|
| Todos los pedidos ENTREGADOS | ✅ Sí |
| Pedidos ENTREGADOS PARCIAL (con causas) | ✅ Sí |
| Pedidos PENDIENTE CON CAUSA (visitados) | ✅ Sí |
| Pedidos PENDIENTE SIN CAUSA | ❌ **NO** - Bloquea el cierre |

---

## 8. Flujo de Sincronización

### 8.1 Sincronización Inicial (Descarga)

```
┌─────────────────┐      ┌─────────────────────┐      ┌──────────────────┐
│  App Inicio /   │─────▶│  GET                │─────▶│  Guardar en      │
│  Sync Manual    │      │  sp_MovilesPedidos  │      │  Realm           │
│                 │      │  Full/{ruta}        │      │  (Pedido + Det)  │
└─────────────────┘      └─────────────────────┘      └──────────────────┘
```

### 8.2 Sincronización de Catálogos

```
┌─────────────────┐      ┌─────────────────────┐      ┌──────────────────┐
│  App Inicio /   │─────▶│  GET catálogos      │─────▶│  Guardar en      │
│  Sync Manual    │      │  (estatus, causas)  │      │  Realm           │
└─────────────────┘      └─────────────────────┘      └──────────────────┘
```

### 8.3 Envío de Cambios (Upload)

```
┌─────────────────┐      ┌─────────────────────┐      ┌──────────────────┐
│  Cambios Locales│─────▶│  POST/PUSH a        │─────▶│  Marcar como     │
│  (modificado    │      │  servidor central   │      │  enviado         │
│   Local = true) │      │                     │      │  (Realm)         │
└─────────────────┘      └─────────────────────┘      └──────────────────┘
```

---

## 9. Casos de Uso

### CU-01: Vendedor atiende pedido completo

1. Vendedor abre PedidosScreen
2. Selecciona pedido pendiente
3. Valida ubicación GPS del cliente
4. Ve detalle de productos
5. Registra cantidad entregada = cantidad solicitada para cada producto
6. Confirma entrega
7. Estado cambia a ENTREGADO (2)
8. Se registra en bitácora

### CU-02: Vendedor atiende pedido con discrepancia

1. Vendedor abre PedidosScreen
2. Selecciona pedido pendiente
3. Valida ubicación GPS del cliente
4. Ve detalle de productos
5. Registra cantidad entregada < cantidad solicitada en Producto A
6. **Sistema detecta diferencia y solicita causa**
7. Vendedor selecciona causa (ej: PRODUCTO NO DISPONIBLE)
8. Continúa con demás productos
9. Confirma entrega parcial
10. Estado cambia a ENTREGADO PARCIAL (6)
11. Se registra en bitácora

### CU-03: Vendedor no puede atender pedido

1. Vendedor abre PedidosScreen
2. Selecciona pedido pendiente
3. Intenta validar GPS pero no encuentra al cliente
4. Selecciona "No Atender"
5. Selecciona causa (ej: CLIENTE NO SE ENCONTRABA)
6. Agrega observaciones (opcional)
7. Confirma
8. Estado cambia a PENDIENTE CON CAUSA (7)
9. Se registra en bitácora

### CU-04: Intento de cierre de ruta con pedidos pendientes

1. Vendedor intenta cerrar ruta
2. Sistema verifica pedidos de la ruta
3. **Detecta pedido con estatus PENDIENTE SIN CAUSA (8)**
4. Muestra alerta: "No puede cerrar la ruta. Tiene 1 pedido sin atender"
5. Muestra lista de pedidos bloqueantes
6. Vendedor debe atender o registrar causa antes de cerrar

---

## 10. Archivos a Crear/Modificar

### Archivos Nuevos

| Archivo | Tipo | Descripción |
|---------|------|-------------|
| `sql/script_detalle_pedidos_bitacora.sql` | SQL | Script de creación de tabla |
| `components/PedidosScreen.tsx` | TSX | Lista de pedidos |
| `components/PedidoDetalleScreen.tsx` | TSX | Detalle de pedido |
| `components/ModalCausaDiferencia.tsx` | TSX | Modal selección causa diferencia |
| `components/ModalCausaNoAtencion.tsx` | TSX | Modal selección causa no atención |
| `services/PedidosService.ts` | TS | Servicio CRUD local |
| `services/PedidosSyncService.ts` | TS | Servicio sincronización |

### Archivos a Modificar

| Archivo | Cambio |
|---------|--------|
| `services/RealmSchemas.ts` | Agregar nuevos schemas |
| `services/FullSyncService.ts` | Integrar sincronización de pedidos |
| `services/CierreRutaService.ts` | Agregar validación de pedidos pendientes |
| `App.tsx` | Registrar nuevas pantallas en Stack.Navigator |
| `components/CumplimientoScreen.tsx` | Agregar tab/acceso a Pedidos |

---

## 11. Estimación de Esfuerzo

| Fase | Tareas | Horas Estimadas |
|------|--------|-----------------|
| Fase 1: Base de Datos | 3 | 2h |
| Fase 2: Realm Schemas | 7 | 3h |
| Fase 3: Servicios | 4 | 6h |
| Fase 4: UI | 7 | 12h |
| Fase 5: Integración | 4 | 4h |
| Fase 6: Navegación | 3 | 2h |
| **TOTAL** | **28** | **~29h** |

---

## 12. Criterios de Aceptación

- [ ] Pedidos se sincronizan desde API a Realm correctamente
- [ ] Lista de pedidos muestra información completa (cliente, productos, estatus)
- [ ] Detalle de pedido muestra todos los productos con cantidades
- [ ] Validación GPS funciona al abrir pedido
- [ ] Comparación en tiempo real solicitado vs entregado
- [ ] Modal de causa de diferencia aparece cuando hay discrepancia
- [ ] Modal de causa de no atención funciona correctamente
- [ ] Bitácora registra todos los cambios localmente
- [ ] Cambios locales se envían al servidor cuando hay conexión
- [ ] Cierre de ruta se bloquea si hay pedidos "Pendiente sin causa"
- [ ] Pedidos ENTREGADO/CANCELADO no pueden modificarse
- [ ] UX consistente con el resto de la aplicación

---

## 13. Notas y Consideraciones

1. **Offline First:** Todo el módulo debe funcionar sin conexión. Los cambios se almacenan en Realm y se sincronizan cuando hay conexión disponible.

2. **Rendimiento:** Los pedidos deben cargarse rápido. Usar índices de Realm y cargar datos de forma paginada si es necesario.

3. **UX:** Seguir el estilo visual de CumplimientoScreen y SalesScreen. Usar los mismos componentes de react-native-elements.

4. **GPS:** La validación GPS usa el mismo LocationService que las visitas. Respetar la configuración de metros del usuario.

5. **WhatsApp:** No se implementa en esta fase. Se deja preparado para futura integración.

6. **SPs en Central:** Los stored procedures de actualización se ejecutarán en la base de datos central. El móvil envía los datos y central actualiza.

---

**Documento creado por:** opencode  
**Última actualización:** 31 de Julio de 2026
