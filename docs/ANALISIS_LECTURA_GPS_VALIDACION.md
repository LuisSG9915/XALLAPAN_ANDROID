# Análisis — lectura GPS de validación: filtro de 3 s y `forzarIntervaloNativo`

**Origen:** caso [2026-10-23 usuario 1052](CASO_2026-10-23_1052_SIN_SENAL.md).
**Pregunta:** por qué `getBestLocation(5, 6000)` devolvió `numFixes = 0` con el tracking de fondo
entregando fixes buenos 5 s antes, y qué conviene cambiar (y qué no).

**Conclusión corta:** el filtro de 3 s y el forzado del intervalo nativo son dos guardas
razonables, pero su combinación es frágil: el forzado es asíncrono y sin confirmación, y el filtro
descarta justo el fix que el forzado suele reentregar (el último conocido). No conviene relajar el
filtro a ciegas; conviene **instrumentar**, arreglar el orden/opciones del forzado y dejar que
`ok_tracking` cubra el caso de negocio.

---

## 1. Cadena real de la lectura

```
validarUbicacionCliente(clienteLat, clienteLng, metros)
  └─ getBestLocation(5, 6000)                       // 5 lecturas, 6 s
       ├─ Geolocation.watchPosition(opcionesWatch)  // listener JS
       ├─ forzarIntervaloNativo(opcionesWatch)      // startObserving nativo con 1 s
       ├─ watchdog de 500 ms + temporizador de 6 s
       └─ por cada position:
            edadFix = Date.now() - position.timestamp
            si edadFix > 3000 ms -> se descarta (no cuenta)
            si no -> lecturasRecibidas++ y se evalúa
```

Datos clave del entorno:

- `react-native-geolocation-service` comparte **una sola** suscripción nativa. Su `watchPosition`
  solo llama a `startObserving` si `updatesEnabled === false`; si el tracking de fondo ya tiene un
  watch, la validación **solo agrega un listener** y hereda el `LocationRequest` del tracking.
- Por eso existe `forzarIntervaloNativo`: vuelve a llamar `RNFusedLocation.startObserving(...)` con
  `interval: 1000`, `fastestInterval: 500`.
- El camino nativo es asíncrono:
  `startObserving` → `requestLocationUpdates` → `checkLocationSettings()` → (onSuccess)
  `fusedLocationProviderClient.requestLocationUpdates(...)`.
- El tracking de fondo (`BackgroundLocationService.startWatch`) también fuerza su intervalo después
  de suscribirse, y en cada cambio de estado GNSS (`evaluateGpsState`) vuelve a llamar `startWatch`.

---

## 2. Filtro de 3 s (`EDAD_MAXIMA_FIX_MS`)

### 2.1 Qué hace

En `getBestLocation`, **antes** de contar la lectura:

```ts
const edadFix = Date.now() - (position.timestamp ?? Date.now());
if (edadFix > EDAD_MAXIMA_FIX_MS) {           // 3000 ms
  console.log("[LocationService] Fix descartado por antigüedad: ...");
  return;                                      // no incrementa lecturasRecibidas
}
```

Consecuencia: un fix reentregado con timestamp viejo no solo no se usa, sino que **no cuenta** como
lectura. La fila queda con `numFixes = 0` y `peorAccuracy = 0`, igual que si no hubiera llegado nada.

### 2.2 Por qué existe

Es la guarda contra fixes cacheados/rancios. Los antecedentes del repo lo justifican: validaciones
con `numFixes = 1`, `tiempoMs` bajo, `accuracy` excelente y `distancia` absurda (fix cacheado), y
reubicaciones disparadas por esa lectura. Sin esta guarda, un fix de hace 20 s puede decidir un
`ok`/`fuera_de_rango`.

### 2.3 El problema en campo

El tracking entrega ~1 fix cada 30–60 s (`intervalMs` por defecto 30 s; `RouteTrackingService` puede
fijarlo según la ruta; en el caso se observó ~60 s). Cuando arranca la validación, el fix más
reciente suele tener entre 0 y 60 s. Al forzar el request rápido, lo primero que suele reentregar
GMS es **ese último fix conocido**, con su timestamp original. Si llega 4–5 s después, el filtro lo
descarta y el siguiente fix "nuevo" puede tardar otros 60 s, fuera de la ventana de 6 s.

En el caso: fix de 11:13:19 (14.9 m, 11 m del cliente), validación de 11:13:18 a 11:13:24. Si el
fix se reentregó a las 11:13:23, tenía 4 s → descartado; no hubo otra lectura en la ventana.

**No se puede afirmar sin `logcat`.** Los dos escenarios producen la misma fila:

| Escenario | Qué se vería en logcat |
|---|---|
| (a) ningún callback en 6 s | `Sin lecturas GPS válidas` (y ningún "Fix GPS (+...ms)") |
| (b) llegó el fix de 11:13:19 y se descartó | `Fix descartado por antigüedad: ~4000 ms` |

### 2.4 Opciones

| Opción | Efecto | Riesgo | Veredicto |
|---|---|---|---|
| **A. Dejar 3 s y confiar en `ok_tracking`** | El fix de 11:13:19 entra por el buffer (10 min de retención, ≤25 m, dentro del rango, sin veto) | Ninguno nuevo: la aprobación sigue exigiendo evidencia y el veto sigue | **Recomendada** |
| B. Subir a 4–5 s | Podría aceptar el fix reentregado si llega a los 3–5 s | Acepta fixes más viejos en la lectura en vivo; a 40 km/h, 5 s son ~55 m. Puede mover el veredicto cerca del umbral | Solo con evidencia y, idealmente, con chequeo de estacionario |
| C. Sembrar la lectura con el último fix de fondo (sin filtro) | Evitaría el `sin_senal` | Duplica `ok_tracking` sin sus guardas (5 min/25 m/veto) y puede aprobar con un fix de otra ubicación | **No** |
| D. Instrumentar y medir | Saber qué escenario domina (a vs b) y en qué % de casos | Ninguno | **Hacer** |

Recomendación: **A + D**. Si tras medir se ve que (b) domina y afecta la operación, evaluar B con
una condición de estacionario (velocidad entre fixes consecutivos < ~1 m/s) y un tope de 5 s. No
tocar C.

---

## 3. `forzarIntervaloNativo`

### 3.1 Qué hace hoy

`getBestLocation` arma:

```ts
const opcionesWatch = {
  enableHighAccuracy: true,
  distanceFilter: 0,
  interval: 1000,
  fastestInterval: 500,
  forceRequestLocation: true,
  showLocationDialog: true,
};
```

y llama `forzarIntervaloNativo(opcionesWatch)` inmediatamente después de `watchPosition`.

`forzarIntervaloNativo`:

```ts
const nativo = (NativeModules as any)?.RNFusedLocation;
if (!nativo || typeof nativo.startObserving !== "function") return;
nativo.startObserving(opciones);   // fire-and-forget
```

La librería nativa parsea bien las opciones (`LocationOptions.fromReadableMap`):

| Clave | Valor | Efecto |
|---|---|---|
| `interval` | 1000 | `LocationRequest` a 1 s |
| `fastestInterval` | 500 | mínimo entre entregas 0.5 s |
| `distanceFilter` | 0 | sin supresión por distancia |
| `enableHighAccuracy` | true | `PRIORITY_HIGH_ACCURACY` |
| `forceRequestLocation` | true | solo se usa si `showLocationDialog = false` y los settings piden resolución |
| `showLocationDialog` | true | si los settings piden resolución, intenta mostrar diálogo del sistema |

### 3.2 Puntos frágiles (encontrados en código)

1. **No hay confirmación.** `startObserving` es `@ReactMethod` que retorna `void`; si el
   `checkLocationSettings` se demora o falla, la app no lo sabe y sigue esperando fixes con el
   request viejo (30–60 s).
2. **El settings check es asíncrono.** El request de 1 s se aplica recién en el `onSuccess` de
   `checkLocationSettings`; en el peor caso puede caer fuera de la ventana de 6 s.
3. **`showLocationDialog: true` con `RESOLUTION_REQUIRED`.** Si los settings no están satisfechos y
   no hay `currentActivity` (o el usuario no interactúa), el flujo nativo **no llama**
   `startLocationUpdates`; la lectura queda sin request rápido. Con `showLocationDialog: false` y
   `forceRequestLocation: true` sí lo fuerza cuando la ubicación está encendida. El tracking usa
   `false`; la validación usa `true`.
4. **Primera entrega = último fix conocido.** Aun aplicando el request rápido, la primera entrega
   suele ser el fix cacheado; si tiene >3 s, el filtro de 2.3 lo descarta. Es el cruce exacto entre
   los dos problemas.
5. **Competencia con el restore del tracking.** `BackgroundLocationService.startWatch` también
   llama `forzarIntervaloNativo(tracking)`; se ejecuta en cada cambio de `evaluateGpsState`
   (enganchado/perdido) y en el watchdog. Si ocurre durante la validación, revierte el request a
   30–60 s y la lectura se queda sin fixes.
6. **Se agrega el listener antes de forzar.** `watchPosition` (listener) → `forzarIntervaloNativo`
   (request). El listener no se pierde, pero el request arranca después; invertir el orden ahorra
   unos milisegundos, no el settings check.
7. **Sin módulo nativo, no-op silencioso.** Si `NativeModules.RNFusedLocation` no está (build mal
   enlazado), no hay aviso; el watch queda con el intervalo del tracking.

### 3.3 Evidencia del caso

El request rápido **debía** entregar fixes cada ~1 s; en cambio, la fila tiene `numFixes = 0` y
`tiempoMs = 6006`. Eso es consistente con (en orden de probabilidad):

1. el request rápido se aplicó tarde (settings check) o no se aplicó (diálogo/actividad);
2. el único fix entregado fue el de 11:13:19, descartado por el filtro de 3 s;
3. una llamada de `startWatch` (cambio de estado GNSS o watchdog) revirtió el request durante la
   validación.

Sin `logcat` no se puede elegir entre las tres; las tres dejan la misma fila.

### 3.4 Mejoras propuestas

| # | Cambio | Costo | Beneficio | Riesgo |
|---|---|---|---|---|
| 1 | **Instrumentar** `forzarIntervaloNativo` y `getBestLocation` (hora del forzado, latencia al primer fix, edad/accuracy del fix descartado) | Bajo | Distingue (a) de (b) y mide si el request se aplica | Nulo |
| 2 | **Precalentar** el request: llamar `forzarIntervaloNativo` al inicio de `validarUbicacionCliente` (antes de permisos) y de nuevo tras `watchPosition` | Bajo | Le da ventaja al settings check; el request ya está listo cuando llega el listener | Consume 1–2 s de fixes rápidos antes de la lectura (batería mínima) |
| 3 | **`showLocationDialog: false`** en la validación, como el tracking | Bajo | Evita el camino de diálogo y habilita `forceRequestLocation` cuando la ubicación está encendida | Si la ubicación está apagada, se reporta error en vez de dialogar (mejor) |
| 4 | **Guardia de concurrencia**: no permitir que `startWatch` revierta el intervalo mientras hay una validación en curso (flag en `LocationService`/`BackgroundLocationService`) | Medio | Elimina la carrera de 3.2.5 | Hay que liberar el flag en todos los caminos (timeout, error, fondo) |
| 5 | `startObserving` con callback/Promise nativo que confirme la aplicación del request | Medio-alto (nativo) | Elimina la incertidumbre | Cambio de módulo nativo y rebuild |
| 6 | Ampliar el presupuesto de 6 s a 8–10 s | Bajo | Más margen para el primer fix | UX: el vendedor espera más; no ataca la causa |

Recomendación: **1 + 2 + 3** en el corto plazo (bajo riesgo, medible), y 4 solo si el logcat
muestra reversiones por `startWatch`. La 5 es la solución de fondo, pero no es necesaria para el
caso: `ok_tracking` ya cubre la aprobación.

---

## 4. Plan de medición (para las pruebas pendientes)

Con el build de HEAD y el fix de wake_lock:

1. Agregar logs (si se aprueba):
   - en `forzarIntervaloNativo`: `console.log` con `Date.now()` y si el módulo existe;
   - en `getBestLocation`: `t_forzado`, latencia al primer `position`, `edadFix` de cada descarte,
     `numFixes` y `tiempoMs` finales.
2. Reproducir 5–10 validaciones en el mismo cliente/condiciones y capturar `adb logcat` filtrando
   `LocationService|RNFusedLocation|BackgroundLocationService`.
3. Clasificar cada `sin_senal`: (a) sin callback, (b) fix descartado por edad, (c) settings/diálogo,
   (d) reversión por `startWatch`.
4. Métricas: `sin_senal` por 100 validaciones, latencia al primer fix (p50/p90), % de descartes por
   edad, y tasa de `ok_tracking`.

**Criterio para tocar el filtro:** si ≥30 % de los `sin_senal` son (b) y el vendedor estaba
estacionado, evaluar el tope de 5 s con chequeo de estacionario. Si domina (a)/(c)/(d), el filtro no
es el problema y no se toca.

---

## 5. Decisiones

- **Filtro de 3 s:** se queda. Es la guarda contra fixes cacheados; `ok_tracking` cubre el caso de
  negocio con evidencia y veto.
- **`forzarIntervaloNativo`:** se queda, pero deja de ser fire-and-forget: instrumentar,
  precalentar y usar `showLocationDialog: false` en la validación. No se elimina porque sin él la
  validación hereda siempre el intervalo del tracking.
- **Mensaje:** cambiado a "GPS sin lectura" + detalle explicativo (ver caso).
- **No hacer:** sembrar la lectura en vivo con el último fix de fondo sin guardas; subir el filtro
  sin medición; ampliar el timeout como sustituto del arreglo.

---

*Análisis basado en el código de HEAD (`7f6ed15` + `b5739f6`) y en la evidencia del caso 2026-10-23.
Actualizar la sección 4 cuando haya `logcat` de campo.*
