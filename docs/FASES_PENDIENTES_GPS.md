# Fases pendientes — GPS / inanición del GNSS

**Estado:** 2026-07-30. Complemento de `@c:/xallapan/docs/PLAN_GPS_INANICION_GNSS.md`.
Aquí sólo está **lo que falta**, con el detalle necesario para ejecutarlo sin volver a investigar.
Las consultas de medición viven aparte, en `@c:/xallapan/docs/CONSULTAS_AUDITORIA_GPS.md`.

---

## 1. Correcciones a auditorías previas

Antes de la lista de pendientes, cuatro cosas que circularon como "faltantes" y **no lo son**, más dos que se reportaron como "correctas" y **están mal**. Documentadas para no volver a gastar tiempo en ellas.

### 1.1 `setWaitForAccurateLocation` — ya está activo por defecto

Se reportó como faltante en el parche. **No hace falta.** La documentación de GMS es explícita:

> `setWaitForAccurateLocation(boolean)` — If set to true and this request is `Priority.PRIORITY_HIGH_ACCURACY`, this will delay delivery of initial low accuracy locations for a small amount of time in case a high accuracy location can be delivered instead. **The default value is true.**

El parche ya migró al `LocationRequest.Builder` (`@c:/xallapan/patches/react-native-geolocation-service+5.3.1.patch:24-28`), y la app pide `enableHighAccuracy: true` → `PRIORITY_HIGH_ACCURACY`. Es decir: **el comportamiento deseado ya está en vigor**. Añadir la llamada explícita documenta la intención pero no cambia nada en ejecución.

### 1.2 `setMaxUpdateAgeMillis` — el default ya es más estricto de lo que suponía el plan

> `setMaxUpdateAgeMillis(long)` — Sets the maximum age of an initial historical location delivered for this request. ... This may be set to the special value `IMPLICIT_MAX_UPDATE_AGE` in which case the maximum update age will always be the same as the interval. **The default value is `IMPLICIT_MAX_UPDATE_AGE`.**

Traducido a nuestros números:

| contexto | `interval` | edad máxima de fix histórico |
|---|---|---|
| validación de venta | 1 000 ms | **1 s** |
| tracking de ruta | 5 000 ms | **5 s** |

La guarda JS de la Fase 4.2 rechaza fixes de más de 3 s. **El nativo ya es más estricto que el JS en la ruta de validación.** El plan asumía una ventana de 30 s que nunca existió.

### 1.3 Consecuencia: la Fase 3 deja de ser una fase real

Y algo más importante: **esto invalida la hipótesis del "fix cacheado" como causa del caso base.** Si el nativo no entrega históricos de más de 1 s, el fix de 500 m con `accuracy` redonda no era viejo — era **fresco y de antena celular**. Un `setMaxUpdateAgeMillis(0)` no lo habría bloqueado, porque una ubicación derivada de celda tiene timestamp actual.

Lo que ataca ese caso es el filtro por calidad en JS: la Fase 4 y el motivo `red_no_gnss` de la 5.4 — **ambas ya implementadas**. La Fase 3 pasa de "requiere rebuild, prioridad 4" a **opcional y de bajo valor** (ver §3.2).

### 1.4 La notificación de estado GNSS sí existe

Se reportó como faltante la Fase 1.3. Está implementada:

```@c:/xallapan/services/BackgroundLocationService.ts:148-153
      const acc = Math.round(accuracy ?? 0);
      this.gpsEnganchado = acc <= 30;
      const estadoGps = this.gpsEnganchado
        ? `GPS: enganchado ±${acc}m`
        : `GPS: buscando satélites (±${acc}m)`;
      this.updateNotificationText(`${estadoGps} — ${hora}`);
```

Lo que falta de la Fase 1 es **sólo** el modo adaptativo de intervalo (§3.1). El flag `gpsEnganchado` ya se calcula ahí y hoy no se usa para nada más — es el punto de enganche exacto para el §3.1.

### 1.5 La Fase 2.2 quedó cerrada

Se reportó que `restaurarWatchDeFondo()` no forzaba el intervalo nativo. Era correcto, y **ya se corrigió**: `startWatch` ahora fuerza el `LocationRequest` tras re-suscribir (`@c:/xallapan/services/BackgroundLocationService.ts:90-93`). Sin eso, el intervalo de 1 s de la validación se quedaba pegado de forma permanente tras la primera venta del día.

### 1.6 ⚠️ La idempotencia se auditó sobre código muerto

Se reportó "Fase 6.6 ✅ marca como enviado tras éxito HTTP", citando `ReubicacionService.ts:332-338`.

**Ese método no lo llama nadie.** `sincronizarReubicaciones` es código muerto: cero referencias en todo el repo. Auditar ahí da una conclusión falsamente tranquilizadora. El detalle completo está en §3.3 — hay **tres** emisores, y los dos vivos no se comportan igual.

---

## 2. Pendientes por prioridad

| # | Pendiente | Tipo | Rebuild | Bloquea a |
|---|---|---|---|---|
| 1 | **§3.3** Unificar los 3 emisores de reubicación | Bug de datos | no | 6.4, 6.5, 6.7 |
| 2 | **§3.4** Decidir el bypass de validación tras reubicar | Decisión + código | no | — |
| 3 | **§3.1** Modo adaptativo de adquisición GNSS | Mejora raíz | no | — |
| 4 | **§3.5** Ventana adaptativa y pre-calentamiento (5.1 + 5.2) | UX | no | — |
| 5 | **§3.6** Contrato del API para campos de auditoría | Server-side | no | 6.5, 6.7 |
| 6 | **§3.7** Remediación de datos ya corrompidos (6.7) | Datos | no | — |
| 7 | **§3.8** Límite real de reubicación (6.4) | Negocio | no | — |
| 8 | **§3.9** Checklist de campo (Fase 8) | Operativo | no | destino de Fase 7 |
| 9 | **§3.2** Parche nativo (Fase 3) | Opcional | **sí** | — |
| — | **§3.10** Fase 7 — tracking nocturno | Aplazada | no | — |

---

## 3. Detalle de cada pendiente

### 3.1 Modo adaptativo de adquisición GNSS *(Fase 1.2)*

**Qué pasa hoy.** El intervalo nativo es fijo en 5 000 ms (`@c:/xallapan/services/BackgroundLocationService.ts:25`). Eso basta para **mantener** el GNSS caliente, pero no para **engancharlo** desde frío: en arranque en frío el receptor necesita una ráfaga sostenida para descargar efemérides y fijar satélites.

**Qué hacer.** Dos estados, conmutados por el `gpsEnganchado` que ya se calcula:

- **Adquisición** — `intervaloNativo = 1000`. Se entra aquí al arrancar el servicio y cada vez que se pierde el enganche.
- **Enganchado** — `intervaloNativo = 5000`. Se entra tras **2 fixes consecutivos** con `accuracy <= 30 m`.

**Dónde.** El punto de decisión es `onLocationFix`, justo donde ya vive `this.gpsEnganchado = acc <= 30` (`@c:/xallapan/services/BackgroundLocationService.ts:149`). Al cambiar de estado hay que llamar `startWatch(this.generation)` para que el nuevo `LocationRequest` se aplique — y eso ya funciona correctamente gracias a §1.5.

**Ojo con la histéresis.** Sin ella, un vendedor oscilando alrededor de ±30 m provoca re-suscripciones en cada fix. Exigir 2 fixes consecutivos para *subir* a enganchado y 3 fixes consecutivos malos para *bajar* a adquisición.

**Criterio de aceptación.** Con la consulta `N2`, la mediana de `accuracy` de la primera captura del día debe bajar de forma medible respecto a la línea base actual. Medir **antes** de desplegar.

**Riesgo.** Batería. El intervalo de 1 s mantiene el GNSS a ~25–50 mA. Como el estado de adquisición es transitorio, el coste real depende de cuánto tarde en engancharse — que es justamente lo que se quiere medir. **Medir una jornada completa en un equipo antes de la flota.**

---

### 3.2 Parche nativo *(Fase 3 — opcional, ver §1.1–1.3)*

**Reevaluada a la baja.** Los dos parámetros que la Fase 3 quería añadir resultaron ser: uno ya activo por defecto, el otro ya más estricto que la guarda JS. **No hay evidencia de que esta fase corrija ningún caso observado.**

**Si aun así se quiere hacer**, por dejar la intención explícita en el código:

```java
LocationRequest locationRequest = new LocationRequest.Builder(options.getInterval())
  .setPriority(priority)
  .setMinUpdateIntervalMillis(options.getFastestInterval())
  .setMinUpdateDistanceMeters(isSingleUpdate ? 0 : options.getDistanceFilter())
  .setWaitForAccurateLocation(true)
  .setMaxUpdateAgeMillis(0)
  .build();
```

`setMaxUpdateAgeMillis(0)` es el único que cambia comportamiento real: prohíbe **cualquier** ubicación histórica, no sólo las de más de `interval`. Marginal, pero defendible en la ruta de validación.

**Coste.** Editar el `.patch`, `pnpm patch-package` y **recompilar Android**. No es cambio caliente.
**Recomendación.** Agrupar con otro rebuild si aparece. No justifica un release propio.

---

### 3.3 Unificar los tres emisores de reubicación *(Fase 6.6 — la raíz de los 19 reenvíos)*

**Este es el pendiente más importante del documento.** Explica los duplicados que §0.4 del plan reportó y no lograba atribuir.

Hay **tres** rutas que postean al mismo endpoint `sp_MovilesReubicacionesJSON`:

| # | Ruta | ¿Viva? | Filtro | Al recibir 2xx | `latitudAnterior` |
|---|---|---|---|---|---|
| A | `syncIncremental` PASO 2 — `@c:/xallapan/services/FullSyncService.ts:590-674` | **sí** | `enviado == false` | marca `enviado = true` | real *(ya corregido)* |
| B | `ReubicacionSyncTask` — `@c:/xallapan/services/sync/tasks/ReubicacionSyncTask.ts:34-137` | **sí** | `enviado == false AND sucursal == $0` | **borra el registro** | real *(ya corregido)* |
| C | `ReubicacionService.sincronizarReubicaciones` — `@c:/xallapan/services/ReubicacionService.ts:281-357` | **no — código muerto** | `enviado == false` | marca `enviado = true` | real |

Tres divergencias, todas problemáticas:

1. **A ignora `sucursal`, B lo exige.** Un registro con `sucursal` nula o distinta es invisible para B y visible para A.
2. **A marca, B borra.** Un registro que pasó por B desaparece del histórico local.
3. **C recibió correcciones que nunca se ejecutan.** Es la trampa de §1.6.

**El mecanismo del reenvío.** Ni A ni B tienen confirmación idempotente. La secuencia es siempre:

```
POST → servidor inserta e commitea → [ventana de fallo] → cliente marca/borra
```

Si algo falla en esa ventana —timeout de red tras el commit, `await response.text()` que revienta, la app que se cierra— el registro **sigue pendiente** y se reenvía en el siguiente ciclo. El servidor inserta otra fila. `syncIncremental` corre con frecuencia, así que **19 reenvíos = 19 ciclos**.

`idMovil` sí viaja y sí es estable (`r.id`, un timestamp en ms). `fechaTransfer` cambia en cada reenvío. **El servidor tiene la clave para deduplicar y no la usa.**

**Qué hacer, en orden:**

1. **Borrar C.** Es código muerto que ya causó una auditoría equivocada.
2. **Que B marque en vez de borrar.** Ver §3.4 — tiene un acoplamiento que hay que decidir primero.
3. **Unificar el filtro.** Decidir si `sucursal` entra o no, y aplicarlo igual en A y B. Si entra, revisar qué pasa con registros de `sucursal` nula.
4. **Extraer la lógica a un solo método** y que A y B lo llamen. Mientras haya dos copias, la siguiente corrección volverá a aplicarse a una sola.
5. **Deduplicar server-side por `idMovil`.** Es la única defensa real contra la ventana de fallo. Requiere el DDL de producción (§3.6).

**Al mutar `Results` de Realm.** Ambas rutas filtran por `enviado == false` y luego escriben `enviado = true`. Eso saca el objeto de la colección **en vivo** durante la iteración. A lo hace bien porque materializa con `Array.from()` antes del `forEach`. Cualquier reescritura debe conservar esa precaución o capturar los `id` antes del `write`.

---

### 3.4 El bypass de validación tras reubicar *(decisión de negocio)*

**Por qué está aquí.** Arreglar el `delete` de §3.3 punto 2 **reactiva un bypass de validación GPS** que hoy está inoperante por accidente. Es la única razón por la que ese arreglo no se aplicó ya.

La cadena es:

```@c:/xallapan/components/SalesScreen.tsx:1065-1070
      // Si el cliente fue reubicado, omitir validación de ubicación
      const omitirValidacionUbicacion = ReubicacionService.getInstance().clienteYaReubicado(cliente.id);

      // Verificar ubicación
      if (omitirValidacionUbicacion) {
        console.log("[Sales] Cliente reubicado, se omite validación de ubicación");
```

`clienteYaReubicado` consulta la tabla `Reubicacion` local filtrando por el día en curso (`@c:/xallapan/services/ReubicacionService.ts:84-104`). Como B **borra** los registros al sincronizar, la consulta no encuentra nada y el bypass nunca se activa. Al cambiar el borrado por `enviado = true`, el bypass revive: **un cliente reubicado hoy queda sin validación GPS el resto del día.**

Tres opciones:

| Opción | Efecto | Valoración |
|---|---|---|
| **A** — arreglar el borrado, dejar el bypass | Comportamiento según diseño original | Ventana de 24 h sin validar. Amplia. |
| **B** — arreglar el borrado, quitar el bypass | La reubicación deja de eximir de validar | Lo más estricto. Puede molestar en campo: el vendedor acaba de fijar el punto y aun así se le valida. |
| **C** — arreglar el borrado, acotar el bypass a minutos | Omitir sólo N minutos tras la reubicación | **Recomendada.** |

**Por qué la C.** El motivo legítimo del bypass es que el vendedor acaba de reubicar y está físicamente parado ahí. Eso caduca en minutos, no en horas. Ya existe el mismo razonamiento —y su constante— en `TTL_VALIDACION_CACHE_MS` (3 min, `@c:/xallapan/services/LocationService.ts:56`), documentado como *"anti-trampa: en 3 min el vendedor no puede alejarse mucho"*. Reutilizar ese criterio mantiene una sola política de caducidad en el código.

**Implementación de la C.** `clienteYaReubicado` deja de filtrar por día y filtra por ventana: `fecha >= (ahora - TTL)`. Ojo: ese mismo método también actúa como guarda anti-duplicado dentro de `registrarReubicacion` (`@c:/xallapan/services/ReubicacionService.ts:141-147`), donde la semántica correcta **sí** es "una por día". **Hay que separarlos en dos métodos**, o el cambio abrirá la puerta a reubicar el mismo cliente cada 3 minutos.

---

### 3.5 Ventana adaptativa y pre-calentamiento *(Fases 5.1 y 5.2)*

**5.1 — Ventana adaptativa.** El presupuesto está fijo en 6 s para las validaciones (`@c:/xallapan/services/LocationService.ts:520`, `Math.max(timeoutMs, 6000)` con `timeoutMs = 6000` desde `validarUbicacionCliente`). Si a los 6 s el mejor `accuracy` sigue por encima de `PRECISION_MAXIMA_ACEPTABLE`, cortar es tirar el trabajo de calentamiento: el GNSS estaba a mitad de engancharse.

Extender hasta ~25 s **sólo** cuando se cumplan las dos condiciones:

- el `accuracy` está **mejorando** entre fixes (hay progreso real, no es un equipo bajo techo), y
- aún no se alcanzó un veredicto definitivo.

Con la barra de progreso ya existente el vendedor ve que algo avanza. Sin la condición de mejora, esto sólo alarga la espera antes del mismo fracaso.

**5.2 — Pre-calentamiento.** No existe ninguna llamada de calentamiento en el código (verificado: cero coincidencias de `precalent|warmUp|calentar` fuera de la constante `WARMUP_MS` interna). Al abrir la pantalla de un cliente —antes de que el vendedor toque "iniciar visita"— arrancar una lectura GPS en segundo plano y desecharla. Cuando pulse el botón, el GNSS ya está enganchado y la validación resuelve en el primer o segundo fix.

**Prioridad real.** Ambas son de comodidad. Si §3.1 funciona, el GNSS estará caliente casi siempre y estas dos dejan de notarse. No adelantarlas a §3.1.

---

### 3.6 Contrato del API para los campos de auditoría *(bloquea 6.5 y 6.7)*

El esquema local v49 ya guarda `accuracy`, `numFixes` y `metrosMovidos` (`@c:/xallapan/services/RealmSchemas.ts:504-523`), y `registrarReubicacion` los llena. **Pero ninguna de las dos rutas vivas los envía.** Se quedan en el teléfono y se pierden.

No se añadieron al payload a propósito: `latitudAnterior`/`longitudAnterior` ya existían en el contrato (riesgo cero), pero estos tres son campos nuevos y **no sabemos si el endpoint los tolera o los rechaza**. El plan ya advierte que el script SQL del repo no es el desplegado.

**Qué hacer, en este orden:**

1. Extraer el DDL real de `sp_MovilesReubicacionesJSON` en producción.
2. Confirmar si el modelo del API ignora propiedades desconocidas o valida estrictamente.
3. Añadir las columnas a la tabla destino si hacen falta.
4. Recién entonces añadir los tres campos al payload de A y B.

**Sin esto, las Fases 6.5 y 6.7 no se pueden hacer bien**: la retención por umbral necesita `metrosMovidos` server-side, y el clasificador de remediación necesita `accuracy`/`numFixes` para distinguir corrupción de corrección legítima.

---

### 3.7 Remediación de datos corrompidos *(Fase 6.7)*

Sin cambios respecto al plan, pero repito la trampa porque es fácil de pisar:

**Trabajar sobre las clases `IMPOSIBLE` y `CACHEADO` del clasificador `D1`, no sobre el listado ordenado por metros.** El caso 8898 (7 km) es una corrección legítima de datos legacy. Ordenar por magnitud pone los casos válidos arriba.

**Deduplicar con `D2` antes de contar clientes afectados** — y ahora sabemos por qué hay duplicados (§3.3), así que el conteo bruto sobreestima el daño de forma importante.

Casos confirmados de partida: **9949** (142 m sobre un fix malo), **9903** (ping-pong de 1.8 km), y los siete de §2.4 con `distancia` > 1 km, incluido el de 15 425 m del usuario 1041.

**Riesgo de sesgo.** `D1` usa `numFixes` y `tiempoMs`, reportados por la app. Contrastar una muestra contra los fixes de tracking (consulta `0.5`) antes de revertir en masa.

---

### 3.8 Límite real de reubicación *(Fase 6.4)*

Sigue siendo "una vez por día" (`@c:/xallapan/services/ReubicacionService.ts:90-99`).

**No endurecerlo todavía.** Sigue bloqueado por §3.3 con el mismo argumento del plan: mientras el mismo lote se reenvíe N veces, cualquier límite basado en conteos castiga al vendedor por un bug de sincronización. Primero unificar los emisores, luego medir el uso real, luego decidir.

Cuando se decida: **implementarlo server-side.** El bit `reubicacion` del usuario se restaura en cada sincronización descendente (`@c:/xallapan/services/sync/tasks/UsuariosSyncTask.ts:66-73`) y un límite en Realm local se evade reinstalando la app.

Además, ver la advertencia de §3.4: `clienteYaReubicado` hace de guarda anti-duplicado **y** de disparador del bypass. Separar ambos usos es prerrequisito para tocar el límite.

---

### 3.9 Checklist de campo *(Fase 8)*

No depende de release y **decide el destino de la Fase 7**. En el Moto E32(s) del vendedor 1024:

- Ajustes > Ubicación > Servicios de ubicación > **Precisión de la ubicación de Google = ON**. Sin esto no hay asistencia A-GPS y el arranque en frío se va a decenas de minutos.
- Búsqueda de **redes Wi-Fi** y **Bluetooth** habilitada. Medir antes con la consulta `N2`: los 500 m redondos indican resolución sólo por celda; con Wi-Fi el fix de red ronda 20–40 m.
- Permiso de la app: **Permitir todo el tiempo** + **Usar ubicación precisa**. El código ya detecta el caso "aproximada" (`@c:/xallapan/services/LocationService.ts:221-238`).
- Batería: Xallapan en **Sin restricciones** y exenta de optimización. Ya se solicita en `requestIgnoreBatteryOptimizations` (`@c:/xallapan/services/BackgroundLocationService.ts:352-379`) — confirmar que el vendedor aceptó.
- **Ahorro de batería desactivado.** Moto lo reactiva solo al 15 %.
- Prueba de control con una app tipo *GPS Test* a cielo abierto, 5 min. Si no usa ningún satélite → firmware/hardware del equipo, no la app. Ninguna corrección de software arregla eso.
- **Prueba de cierre forzado — decide la Fase 7.** Con el vendedor atorado en `accuracy` alta **a cielo abierto**: forzar cierre de la app, reabrir, cronometrar cuánto tarda en dar un fix ≤ 30 m. Recuperación en segundos = la hipótesis del registro nativo rancio queda confirmada.

---

### 3.10 Tracking nocturno *(Fase 7 — aplazada)*

**Aplazada por decisión de negocio.** Se mantiene el análisis por si se retoma.

**Lo que esta fase NO arregla.** El tracking nocturno **no causó** la imprecisión de 500 m de la noche. Eso lo causó el teléfono estar bajo techo, sin vista al cielo. Ningún ajuste de software obtiene GNSS desde el interior de una casa; el servicio sólo *registró* esa imposibilidad 1 640 veces. Las efemérides también habrían caducado con el servicio apagado.

**Lo que sí puede estar aportando.** `startObserving` no se reinvoca mientras `updatesEnabled` siga en `true`, así que un servicio que corrió toda la noche mantiene la misma `LocationRequest` del día anterior: GMS nunca recibe una petición nueva y nunca dispara la ráfaga de adquisición ni el refresco de A-GPS. **Confianza: media** — es n = 2 y está confundido.

| día | estado del servicio | 1ª captura | accuracy |
|---|---|---|---|
| 07-28 | arranque fresco a las 10:38 | 10:38:04 | **4.50 m** — inmediato |
| 07-29 | corriendo desde el día anterior | 00:00:15 | 500 m — 33 min para recuperar |

**Nota:** si se implementa §3.1, esa hipótesis queda parcialmente cubierta de gratis — el modo adaptativo reconstruye el `LocationRequest` cada vez que se pierde el enganche, que es exactamente lo que falta por la mañana.

**Beneficio comprobado:** ~1 640 filas de basura menos por equipo y por noche, más ahorro de batería.
**Beneficio hipotético:** arranque limpio del GNSS. Pendiente de la prueba de §3.9.

---

## 4. Deuda técnica detectada de paso

Fuera del alcance del plan GPS, pero encontrada durante la auditoría:

- **`clearAllDataExceptUsers` borra reubicaciones pendientes.** `"Reubicacion"` está en `tablesToDelete` (`@c:/xallapan/services/FullSyncService.ts:3185-3212`) y el método se invoca desde `@c:/xallapan/App.tsx:524`. Una reubicación registrada y no sincronizada **se pierde en silencio**. Revisar si esa tabla debe excluirse mientras tenga registros con `enviado == false`.
- **`SyncProgressModal.tsx` no compila limpio.** Dos errores `TS2367` en las líneas 59 y 75: comparaciones contra `"completed"`, valor que no existe en el tipo `"error" | "syncing" | "success"`. Son preexistentes y ajenos al GPS, pero significan que **esas dos ramas de UI están muertas**.

---

## 5. Cómo verificar cada cambio

| Pendiente | Verificación |
|---|---|
| §3.1 adaptativo | Consulta `N2`: mediana de `accuracy` de la 1ª captura del día, antes vs después. Medir batería una jornada completa. |
| §3.3 emisores | Consulta `T2`: filas en `tempreubicacionesmovil` por cliente vs cambios de catálogo. Debe converger a 1:1. |
| §3.4 bypass | Bitácora de validación: que dejen de aparecer visitas sin registro de validación GPS tras una reubicación. |
| §3.5 ventana | `tiempoMs` y `numFixes` en `BitacoraValidacionUbicacionMovil`: menos `sin_senal`, sin subida del tiempo medio en el caso bueno. |
| §3.7 remediación | Clasificador `D1` + dedup `D2`. Contrastar muestra contra fixes de tracking con `0.5`. |
| Todos | `npx tsc --noEmit -p tsconfig.json` — la línea base son los 2 errores de `SyncProgressModal.tsx`. Cualquier error adicional es regresión. |

Consultas en `@c:/xallapan/docs/CONSULTAS_AUDITORIA_GPS.md`.
