# Plan de cierre — GPS y reubicaciones

**Creado:** 2026-07-30. **Alcance:** los 4 puntos que quedaron a medias tras la última tanda de cambios.
No cubre las fases de mejora pendientes; ésas viven en `@c:/xallapan/docs/FASES_PENDIENTES_GPS.md`.

**Línea base de verificación:** `npx tsc --noEmit -p tsconfig.json` devuelve **0 errores** hoy. Cualquier error tras estos cambios es regresión.

---

## Orden de ejecución

| # | Cambio | Tamaño | Rebuild | Independiente |
|---|---|---|---|---|
| 1 | Desfase de `minFixes` en reubicación | 1 línea | no | sí |
| 2 | Reacción del modo adaptativo | mover 1 línea | no | sí |
| 3 | Preservar reubicaciones pendientes al limpiar datos | ~6 líneas | no | sí |
| 4 | Unificar el emisor de reubicaciones + lock | ~40 líneas | no | hacer al final |

Los pasos 1–3 son independientes entre sí y se pueden aplicar en cualquier orden. El **4 va al final** porque toca la ruta de sincronización que corre cada 3 minutos y conviene aislarlo si algo sale mal.

---

## Paso 1 — Desfase de `minFixes` en reubicación

**Síntoma.** El vendedor con GPS en buenas condiciones recibe *"Precisión GPS insuficiente — se requieren al menos 3 lecturas"* y no puede reubicar.

**Causa.** Dos cifras que no coinciden. La guarda exige 3 lecturas:

```@c:/xallapan/components/SalesScreen.tsx:1672
              if (accuracy > 25 || numFixes < 3) {
```

Pero `getBestLocation` corta en cuanto tiene **2** lecturas coherentes bajo ±15 m (`@c:/xallapan/services/LocationService.ts:667`, con `fixesCoherentes()` que exige `>= minFixes` y `minFixes` por defecto en 2). Con GNSS caliente eso ocurre en ~1.5 s.

**Es contraintuitivo a propósito: cuanto mejor funciona el GPS, más probable el rechazo.** Un GPS mediocre tarda más, acumula más lecturas y pasa la guarda; un GPS excelente corta en 2 y la falla.

**Cambio.** En `@c:/xallapan/components/SalesScreen.tsx:1658`:

```ts
const ubicacion = await LocationService.getBestLocation(5, 10000, undefined, undefined, undefined, 3);
```

**Por qué subir la lectura y no bajar la guarda.** La reubicación escribe las coordenadas permanentes del cliente y se propaga al catálogo; conviene la barra alta. Bajar la guarda a 2 también cierra el desfase, pero relaja la única defensa que impide fijar un punto malo. Si se prefiere esa vía, hay que cambiar **también** el texto de la alerta en la línea 1677, que dice "se requieren al menos 3".

**Criterio de aceptación.** Reubicar a cielo abierto con GPS ya enganchado debe funcionar al primer intento. En el log, `numFixes` del diagnóstico debe ser ≥ 3.

**Riesgo.** Bajo. Alarga la lectura de reubicación en ~1 s en el mejor caso. El presupuesto de 10 s no cambia.

---

## Paso 2 — Reacción del modo adaptativo

**Síntoma.** El modo adquisición (1 s) se mantiene ~48 s de más aunque el GPS ya esté enganchado desde el primer segundo. Gasto de batería innecesario.

**Causa.** La máquina de estados quedó **detrás** del filtro de captura:

```@c:/xallapan/services/BackgroundLocationService.ts:133-138
    if (this.lastCaptureAt > 0 && ahora - this.lastCaptureAt < this.intervalMs * 0.8) {
      return;
    }
    this.lastCaptureAt = ahora;
    const { latitude, longitude, accuracy } = position.coords;
    this.evaluateGpsState(accuracy ?? 999);
```

Ese filtro existe para no escribir en la bitácora varias veces por segundo, y descarta todo lo que llegue antes de `30000 * 0.8` = **24 s**. En modo adquisición el GPS entrega ~24 lecturas por ventana pero **sólo 1 alimenta la máquina de estados**:

| transición | fixes requeridos | tiempo real hoy | tiempo esperado |
|---|---|---|---|
| adquisición → enganchado | 2 | ~48 s | ~2 s |
| enganchado → adquisición | 3 | ~72 s | ~3 s |

**Cambio.** Mover la llamada **antes** del `return`, justo después de tener las coordenadas. La evaluación del estado del GNSS y la frecuencia de escritura en bitácora son dos cosas distintas y no deben compartir el mismo filtro:

```ts
    const ahora = Date.now();
    this.lastFixAt = ahora;
    this.ultimoFixTracking = { ... };

    this.evaluateGpsState(position.coords.accuracy ?? 999);

    if (this.lastCaptureAt > 0 && ahora - this.lastCaptureAt < this.intervalMs * 0.8) {
      return;
    }
    this.lastCaptureAt = ahora;
    const { latitude, longitude, accuracy } = position.coords;
```

Y quitar la llamada duplicada de la línea 138. El `console.log` de la 139 puede seguir mostrando `enganchado=${this.gpsEnganchado}`.

**Ojo con la histéresis.** Al evaluar cada lectura en vez de 1 de cada 24, los contadores se mueven ~24× más rápido. Los umbrales actuales (2 buenos para subir, 3 malos para bajar) fueron pensados para el flujo lento. Con el flujo real puede convenir subirlos —p. ej. 5 y 8— para que un bache momentáneo no dispare una re-suscripción. **Ajustar sólo si en el log se ven conmutaciones frecuentes**; los mensajes `GNSS enganchado (...)` y `GNSS perdido (...)` lo delatan de inmediato.

**Criterio de aceptación.** En el log del arranque debe aparecer `GNSS enganchado (...), bajando a intervalo 5000ms` en los primeros segundos, no al minuto. Y no debe haber conmutaciones repetidas en marcha estable.

**Riesgo.** Medio-bajo. `evaluateGpsState` llama `startWatch` desde dentro del callback de `watchPosition`, lo que libera y recrea la suscripción durante su propio callback. Ya ocurre hoy, sólo que 24× menos seguido. **Verificar en el log que tras cada conmutación siguen llegando fixes**; si se cortaran, hay que diferir la re-suscripción con un `setTimeout(..., 0)`.

---

## Paso 3 — Preservar reubicaciones pendientes al limpiar datos

**Síntoma.** Una reubicación registrada y aún no sincronizada se pierde sin dejar rastro.

**Causa.** `"Reubicacion"` está en la lista de tablas a borrar:

```@c:/xallapan/services/FullSyncService.ts:3207
          "Reubicacion",
```

El método se invoca desde `@c:/xallapan/App.tsx:524`. El vendedor no recibe ningún aviso: su reubicación simplemente nunca llega al servidor.

**Trampa importante.** El intento anterior agregó la lógica de preservación **después** del `tablesToDelete.forEach` de la línea 3214. Para entonces la tabla ya está vacía, así que la consulta encontraba 0 registros y el bloque era un no-op. **No basta con agregar el rescate; hay que sacar la tabla de la lista.**

**Cambio.** Quitar `"Reubicacion"` de `tablesToDelete` y borrar selectivamente después del `forEach`:

```ts
        tablesToDelete.forEach((tableName) => {
          const objects = this.realm!.objects(tableName);
          this.realm!.delete(objects);
          console.log(`[FullSyncService] Tabla ${tableName} limpiada: ${objects.length} registros eliminados`);
        });

        // Las reubicaciones sin sincronizar son el único registro de un cambio de
        // coordenadas hecho en campo: si se borran aquí, se pierde el dato.
        const reubicacionesEnviadas = this.realm!.objects("Reubicacion").filtered("enviado == true");
        const enviadasCount = reubicacionesEnviadas.length;
        this.realm!.delete(reubicacionesEnviadas);
        const pendientesCount = this.realm!.objects("Reubicacion").filtered("enviado == false").length;
        console.log(
          `[FullSyncService] Reubicaciones: ${enviadasCount} enviadas eliminadas, ${pendientesCount} pendientes conservadas`,
        );
```

Contar **antes** de borrar: tras el `delete` la colección queda vacía y el conteo saldría en 0.

**Criterio de aceptación.** Registrar una reubicación sin conexión, disparar la limpieza, y confirmar en el log `pendientes conservadas: 1`. Al recuperar conexión debe sincronizarse.

**Riesgo.** Bajo. Cambia la semántica de "limpiar todo excepto Usuario", así que conviene que el mensaje de la línea 3220 lo refleje.

**Dependencia con el paso 4.** Este paso sólo tiene sentido si los registros sobreviven a la sincronización. `ReubicacionSyncTask` ya marca en vez de borrar; falta cerrar PASO 2.

---

## Paso 4 — Unificar el emisor de reubicaciones

**Síntoma.** Un mismo movimiento aparece hasta 19 veces en `tempreubicacionesmovil`, con el mismo cliente, las mismas coordenadas y un solo usuario.

### 4.1 Por qué 19

Ya está medido. `syncIncremental` corre **cada 3 minutos** desde `BackgroundSyncService` (`@c:/xallapan/services/BackgroundSyncService.ts:403`). **19 reenvíos ≈ 57 minutos reintentando.**

La secuencia de fallo es siempre la misma:

```
POST → el servidor inserta y commitea → [ventana de fallo] → el cliente marca enviado
```

Si algo se cae en esa ventana —timeout de red posterior al commit, `await response.text()` que revienta, la app cerrada— el registro **sigue pendiente** y se reenvía al ciclo siguiente. El servidor inserta otra fila. No hay deduplicación.

`idMovil` viaja y es estable (`r.id`, timestamp en ms). `fechaTransfer` cambia en cada reenvío. **El servidor tiene la clave para deduplicar y no la usa.**

### 4.2 Decisión: PASO 2 delega, no se borra

Estado actual de las tres rutas:

| Ruta | Frecuencia | Estado |
|---|---|---|
| `syncIncremental` PASO 2 — `@c:/xallapan/services/FullSyncService.ts:590-674` | **cada 3 min** | copia inline, envía `latitudAnterior: 0` |
| `ReubicacionSyncTask` → `enviarReubicacionesPendientes` | login / manual | ✅ ya delega, marca en vez de borrar |
| `ReubicacionService.sincronizarReubicaciones` — `@c:/xallapan/services/ReubicacionService.ts:281-357` | **nunca** | código muerto |

**No borrar PASO 2.** `ReubicacionSyncTask` sólo corre dentro de `syncAll`, que se invoca en login (`@c:/xallapan/components/LoginScreen.tsx:60`), arranque (`@c:/xallapan/App.tsx:551`) y sincronización manual (`@c:/xallapan/components/ManualSyncScreen.tsx:138`). Eliminar PASO 2 dejaría las reubicaciones esperando **hasta el siguiente login**, potencialmente horas.

**Hacer que PASO 2 delegue** en `ReubicacionService.enviarReubicacionesPendientes`, igual que ya hace la task. Eso da un solo emisor, un solo filtro y una sola política post-éxito, conservando la cadencia de 3 minutos.

### 4.3 Cambios

**a) PASO 2 delega.** Sustituir el bloque completo de `@c:/xallapan/services/FullSyncService.ts:590-674` por una llamada al servicio, siguiendo el patrón que ya usa PASO 3 con las bitácoras (`@c:/xallapan/services/FullSyncService.ts:676-690`). Con esto, los campos de auditoría dejan de perderse en la ruta frecuente.

**b) Añadir lock de concurrencia** a `enviarReubicacionesPendientes`. Ahora que dos rutas llaman al mismo método, dos ejecuciones solapadas leerían los mismos pendientes.

**Hay precedente en el repo para este problema exacto**, con el diagnóstico ya escrito:

```@c:/xallapan/services/GpsBitacoraService.ts:61-65
  // Locks contra envíos concurrentes: este servicio se invoca desde varios
  // puntos (BackgroundSyncService cada 3 min y FullSyncService en syncIncremental
  // y syncAll). Sin lock, dos ejecuciones leían los mismos pendientes y el
  // servidor recibía cada registro duplicado.
  private enviandoGps = false;
```

Replicar ese patrón. La alternativa, más robusta, es la promesa compartida de `cierreRutaSendInFlight` (`@c:/xallapan/services/FullSyncService.ts:17`), que además deja que el segundo llamador espere el resultado del primero en vez de salir en falso.

**c) Borrar `sincronizarReubicaciones`.** Es código muerto y ya provocó una auditoría equivocada: se revisó ahí, se concluyó que la idempotencia estaba resuelta, y el método no lo llamaba nadie.

**d) Al mutar `Results` de Realm.** El método filtra por `enviado == false` y luego escribe `enviado = true`, lo que saca cada objeto de la colección **en vivo** durante la iteración. Conservar el `Array.from()` antes del `forEach`, o capturar los `id` antes del `write`.

### 4.4 Lo que esto NO arregla

**La ventana de fallo sigue existiendo.** Unificar reduce los emisores de dos a uno y el lock evita el solape, pero si el POST se cae después del commit del servidor, el reenvío vuelve a ocurrir. **La única defensa real es deduplicar server-side por `idMovil`**, y eso requiere el DDL de producción (§3.6 de `FASES_PENDIENTES_GPS.md`).

Igual conviene hacer 4.3 primero: reduce la frecuencia del problema y deja un solo punto donde después colgar la clave de idempotencia.

**Criterio de aceptación.** Consulta `T2`: filas en `tempreubicacionesmovil` por cliente contra cambios de catálogo. Debe converger a 1:1. Medir la línea base antes de desplegar.

**Riesgo.** El más alto de los cuatro: toca la ruta que corre cada 3 minutos. Verificar en el log de una jornada que aparece `enviarReubicacionesPendientes` y **no** aparecen dos ejecuciones solapadas.

---

## Verificación final

| Paso | Cómo se comprueba |
|---|---|
| 1 | Reubicar a cielo abierto con GPS enganchado: debe pasar al primer intento, `numFixes` ≥ 3 |
| 2 | Log de arranque: `GNSS enganchado` en segundos, no al minuto. Sin conmutaciones repetidas en marcha estable |
| 3 | Reubicar sin conexión → limpiar datos → `pendientes conservadas: 1` → sincroniza al recuperar red |
| 4 | Consulta `T2`, relación 1:1 entre filas y cambios de catálogo |
| Todos | `npx tsc --noEmit -p tsconfig.json` debe seguir en **0 errores** |

Ninguno de los cuatro requiere recompilar Android: son todos cambios de JS/TS.

---

## Fuera de alcance

- **Deduplicación server-side por `idMovil`** — bloqueada por el DDL de producción. Es lo único que cierra la ventana de fallo de §4.4.
- **Envío de `accuracy`, `numFixes` y `metrosMovidos`** — bloqueado por el contrato del API. Hoy se guardan en el teléfono y no viajan.
- **Fases de mejora** (modo adaptativo fino, ventana adaptativa, pre-calentamiento, límite de reubicación, remediación de datos) — en `@c:/xallapan/docs/FASES_PENDIENTES_GPS.md`.
