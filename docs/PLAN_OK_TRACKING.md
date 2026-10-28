# Plan de implementación — Aprobación por tracking (`ok_tracking`)

**Estado:** propuesta lista para implementar.
**Riesgo declarado:** bajo-medio. No toca esquema de Realm, no toca endpoints, no cambia umbrales de negocio.
**Rollback:** una constante (`HABILITAR_OK_TRACKING = false`).

---

## 0. Contexto para quien implementa

Repo: `XALLAPAN_ANDROID` — React Native + TypeScript + Realm + Jest.
Pantallas relevantes: `components/CumplimientoScreen.tsx` (agenda) y `components/SalesScreen.tsx` (punto de venta).
Lógica GPS: `services/LocationService.ts`, `services/BackgroundLocationService.ts`, `services/GpsBitacoraService.ts`.

Antes de empezar, leé `AGENTS.md` en la raíz. Regla vigente del proyecto: ante una solicitud ambigua, preguntar antes de modificar; y no cambiar la lógica de sincronización parcial.

### 0.1 Caso que motiva el cambio (evidencia real)

Registro `id 357053` de `BitacoraValidacionUbicacionMovil` (22-oct-2026 10:58:51, usuario 1052, sucursal 2083, cliente 27668, app 1.3.8):

| Campo | Valor |
|---|---|
| `motivo` | `precision_baja` |
| `distancia` | 199.78 m (permitido 100 m) |
| `accuracy` | ±2066.04 m |
| `numFixes` | 1 |
| `tiempoMs` | 6014 |

Lo que el tracking de ruta (`BitacoraTrackingGpsMovil`) demuestra del mismo vendedor:

| Hora | Distancia al cliente | `precisionM` |
|---|---|---|
| 10:55:51 | **17.5 m** | 18.6 |
| 10:56:51 | 13.3 m | 2334 (perdió GNSS) |
| 10:57:51 | 4384 m | 700 (fix de red, 4.3 km de error) |
| 10:58:45 | 197.7 m | 2066 ← el que usó la validación |
| 11:00:06 | 317 m | 5.2 (GNSS de vuelta, ya se había ido) |

**El vendedor estaba en el cliente.** El GNSS cayó justo en la puerta; GMS devolvió fixes de red absurdos; la validación creyó al fix malo y bloqueó una venta legítima, aunque el propio tracking del dispositivo probaba lo contrario. El vendedor se fue y la visita se perdió (no volvió a intentarla en todo el día).

Conclusión de diseño: **el tracking de ruta hoy solo sirve para bloquear, nunca para permitir.** Este plan corrige eso de forma acotada.

### 0.2 Objetivo

Que una validación que falla **por falta de GPS** pueda aprobarse cuando existe evidencia reciente de que el vendedor estuvo físicamente dentro del rango del cliente, registrando el hecho con el motivo `ok_tracking`.

### 0.3 Fuera de alcance

- No se toca el umbral de reubicación (±25 m y 3 fixes).
- No se cambia el TTL de caché de validación.
- No se agregan campos a Realm ni al payload de los endpoints.
- No se cambia la UI ni el flujo de navegación.

---

## 1. Invariantes de negocio (NO ROMPER)

Cada invariante tiene su verificación en la sección 5. Si una implementación rompe cualquiera de estas, está mal aunque los tests pasen.

| # | Invariante | Dónde vive hoy |
|---|---|---|
| I1 | Una venta **nunca** se aprueba sin evidencia de presencia: o el fix en vivo cae dentro del rango, o hay evidencia de tracking con calidad y antigüedad acotadas. | `validarUbicacionCliente` |
| I2 | `fuera_de_rango` **solo** se convierte en `ok_tracking` si hay un fix **persistido** (visible en el servidor) dentro del rango, con `accuracy ≤ 25 m`, antigüedad `≤ 5 min` y sin veto de 2 min. Sin evidencia sigue bloqueando. **Enmendada el 2026-10-27** (ver §13). | `services/LocationService.ts` bloque 2.9 |
| I3 | `sin_permiso` **nunca** se aprueba. | `services/LocationService.ts:800-803` |
| I4 | El candado de reubicación (±25 m **y** ≥3 fixes) queda **igual**. | `CumplimientoScreen.tsx:833`, `SalesScreen.tsx:1744` |
| I5 | `ok_tracking` exige ≥1 fix con `accuracy ≤ 25 m` y antigüedad `≤ 5 min`, y ese fix debe caer **dentro** del rango (sin buffer de accuracy). | nuevo |
| I6 | Si en los últimos **2 min** hubo un fix **bueno** (`accuracy ≤ 30 m`) que ubica al vendedor claramente fuera del rango, **no se aprueba** (veto). | nuevo |
| I7 | Sin evidencia (buffer vacío, servicio caído, error), el comportamiento es **idéntico al actual**. | nuevo |
| I8 | El bypass tras reubicación (`clienteReubicadoRecientemente`, `TTL_VALIDACION_CACHE_MS`) queda igual. | `services/ReubicacionService.ts:121-138` |
| I9 | `TTL_VALIDACION_CACHE_MS`, `PRECISION_ABSURDA`, `PRECISION_MAXIMA_ACEPTABLE`, `BUFFER_MAXIMO` y `estaDentroDeRango` quedan igual. | `services/LocationService.ts:42-75` |
| I10 | La evidencia de tracking sale **solo** de `getFixesPersistidos()` (fixes que ya están en la bitácora del servidor). Nunca de la ráfaga que dispara la validación: esa ráfaga comparte la suscripción nativa y contamina `ultimoFixTracking` con el mismo fix malo que se juzga (caso 373510). | `BackgroundLocationService.ts` |

**Nota sobre el riesgo de fraude:** con I5 + I6, para aprobar por tracking el vendedor tuvo que estar a menos de `metrosPermitidos` del cliente en los últimos 5 minutos **y no haber sido visto lejos en los últimos 2**. No permite vender desde otro lado.

---

## 2. Fase 0 — Verificación previa (sin código)

Ejecutar antes de tocar nada. Todo debe pasar.

1. **El servidor acepta el motivo nuevo.**
   ✅ **Verificado en la base de producción el 2026-10-22:**
   - `motivo` es `varchar(20) NOT NULL` → `ok_tracking` (11 caracteres) cabe con holgura.
   - Sin `CHECK` constraints y sin triggers sobre `BitacoraValidacionUbicacionMovil` → no hay lista blanca de motivos ni efectos colaterales.
   - El SP inserta `j.motivo` tal cual vía `OPENJSON` (`script_bitacora_validacion.sql:73-128`).
   ⚠️ Lo único a cuidar a futuro: cualquier `motivo` nuevo debe caber en 20 caracteres.
2. **Línea base medida (30 días).**
   - **v2 (oficial, comparable): 122 visitas perdidas, 117 clientes distintos, 23 vendedores.**
   - v1 (por referencia): 1.352 intentos fallidos, 145 filas sin visita, 30 vendedores, 889 clientes afectados.
   La diferencia 145 → 122 son reintentos del mismo cliente-día. **Usar 122 como base.**
3. **Confirmar la línea base de compilación:** `npx tsc --noEmit -p tsconfig.json` → **0 errores** (verificado el 2026-10-22). Cualquier error nuevo es regresión.
4. **Confirmar la línea base de tests:** `npx jest` → 15/16 suites, 93 tests en verde. El único fallo es `__tests__/App.test.tsx` por ESM de `react-native-elements` (`App.tsx:25`): **preexistente y ajeno** a este cambio.

Nada de esta fase modifica archivos.

---

## 3. Fase 1 — Historial de fixes confiables (sin cambio de comportamiento)

**Archivo:** `services/BackgroundLocationService.ts`
**Riesgo:** nulo para negocio. Solo agrega memoria; ningún flujo la lee todavía.

### 3.1 Constantes (junto a `MAX_FIX_AGE_MS`, línea ~22)

```ts
// Historial acotado de fixes de buena calidad, para poder corroborar una
// validación cuando el GPS falla justo en el momento de vender.
// NO reemplaza la lectura en vivo: solo acredita que el vendedor estuvo
// físicamente en el punto hace unos minutos.
const FIXES_BUENOS_MAX = 12;
const FIXES_BUENOS_RETENCION_MS = 10 * 60 * 1000;
const FIX_BUENO_ACCURACY_MAX = 25; // metros

export type FixTrackingConfiable = {
  latitud: number;
  longitud: number;
  accuracy: number;
  timestamp: number;
};
```

### 3.2 Estado

```ts
private fixesRecientes: FixTrackingConfiable[] = [];
```

### 3.3 Lector público (junto a `getUltimoFixTracking`, línea ~83)

```ts
/**
 * Fixes recientes con calidad suficiente para acreditar presencia en un punto.
 * Devuelve [] si no hay evidencia (falla segura).
 */
getFixesRecientes(maxEdadMs: number, maxAccuracy: number): FixTrackingConfiable[] {
  const ahora = Date.now();
  return this.fixesRecientes.filter(
    (f) => ahora - f.timestamp <= maxEdadMs && f.accuracy <= maxAccuracy,
  );
}
```

### 3.4 Registro

Dentro de `onLocationFix`, **inmediatamente después** de asignar `this.ultimoFixTracking = {...}` (línea ~255-262) y **antes** de `if (this.captureInFlight) return;`:

```ts
this.registrarFixReciente(position);
```

> **Crítico:** debe ir antes del `return` de `captureInFlight`. Si se coloca después, solo entrarían los fixes que además se persisten (throttle de 30 s) y se perdería la resolución real, que es justo lo que hace falta.

Método privado:

```ts
private registrarFixReciente(position: GeoPosition): void {
  const { latitude, longitude, accuracy } = position.coords;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

  const acc = accuracy ?? 999;
  if (acc > FIX_BUENO_ACCURACY_MAX) return;

  const ahora = Date.now();
  const ts = position.timestamp ?? ahora;
  this.fixesRecientes.push({ latitud: latitude, longitud: longitude, accuracy: acc, timestamp: ts });
  if (this.fixesRecientes.length > FIXES_BUENOS_MAX) this.fixesRecientes.shift();
  this.fixesRecientes = this.fixesRecientes.filter((f) => ahora - f.timestamp <= FIXES_BUENOS_RETENCION_MS);
}
```

### 3.5 Prueba de la fase

En `__tests__/BackgroundLocationService.test.ts` (ya mockea `react-native-geolocation-service`):

- Tras simular un fix con `accuracy: 8`, `getFixesRecientes(5*60_000, 25)` devuelve 1 elemento.
- Tras un fix con `accuracy: 400`, **no** crece el arreglo.
- Con 20 fixes buenos consecutivos, el arreglo nunca supera `FIXES_BUENOS_MAX`.
- El servicio sin arrancar devuelve `[]`.

**Criterio de aceptación:** todos los tests previos siguen verdes; no cambia ningún log ni comportamiento observable.

---

## 4. Fase 2 — Motivo `ok_tracking` en `LocationService` (núcleo)

**Archivo:** `services/LocationService.ts`
**Riesgo:** el de negocio. Implementar exactamente como se describe.

### 4.1 Tipo (línea 17)

```ts
export type MotivoValidacion =
  | "ok"
  | "ok_cache"
  | "ok_tracking"
  | "sin_permiso"
  | "sin_senal"
  | "precision_baja"
  | "fuera_de_rango"
  | "red_no_gnss";
```

### 4.2 Constantes (después de `TTL_VALIDACION_CACHE_MS`, línea ~59)

```ts
// --- Corroboración con el tracking de ruta (`ok_tracking`) -------------------
// El GPS puede caer justo cuando el vendedor está en la puerta (local cerrado,
// techo metálico, mercado). En ese momento la lectura en vivo devuelve un fix
// de red y bloquea una venta legítima, aunque el tracking de ruta sí tenga
// evidencia de dónde estuvo el vendedor segundos antes.
// La evidencia sale de getFixesPersistidos(): fixes que ya están en la
// bitácora. La ráfaga de la propia validación no cuenta (ver I10).
export const HABILITAR_OK_TRACKING = true; // rollback: poner false
export const TRACKING_EVIDENCIA_VENTANA_MS = 5 * 60 * 1000;
export const TRACKING_EVIDENCIA_ACCURACY_MAX = 25; // metros
export const TRACKING_VETO_VENTANA_MS = 2 * 60 * 1000;
export const TRACKING_VETO_ACCURACY_MAX = 30; // metros
export const TRACKING_VETO_MARGEN_M = 30; // metros
// `fuera_de_rango` contradicho por evidencia persistida (enmienda I2).
export const HABILITAR_OK_TRACKING_FUERA_DE_RANGO = true; // rollback: poner false
```

### 4.3 Método privado de corroboración

Usar `require` dentro del método, igual que el contraste con tracking que ya existe (línea ~895), para no crear un import circular.

```ts
/**
 * Busca evidencia de que el vendedor estuvo dentro del rango del cliente en
 * los últimos minutos, según el tracking de ruta.
 *
 * Devuelve null (falla segura) si:
 *  - está deshabilitado,
 *  - no hay fixes recientes con la calidad suficiente,
 *  - ningún fix cae dentro del rango, o
 *  - hay evidencia reciente y buena de que el vendedor ya se alejó (veto).
 */
private corroborarPresenciaConTracking(
  clienteLat: number,
  clienteLng: number,
  metrosPermitidos: number,
): { distancia: number; accuracy: number; latitud: number; longitud: number; timestamp: number } | null {
  if (!HABILITAR_OK_TRACKING) return null;

  try {
    const BGService = require("./BackgroundLocationService").default;
    if (typeof BGService?.getFixesRecientes !== "function") return null;

    // Veto: evidencia reciente y buena de que el vendedor ya se fue.
    // Manda sobre la evidencia positiva de hace minutos.
    const recientesBuenos: Array<{ latitud: number; longitud: number; accuracy: number; timestamp: number }> =
      BGService.getFixesRecientes(TRACKING_VETO_VENTANA_MS, TRACKING_VETO_ACCURACY_MAX) ?? [];

    for (const f of recientesBuenos) {
      const dist = calcularDistancia(f.latitud, f.longitud, clienteLat, clienteLng);
      if (dist > metrosPermitidos + TRACKING_VETO_MARGEN_M) {
        console.log(
          `[LocationService] ok_tracking vetado: fix reciente a ${Math.round(dist)} m ` +
            `(permitido ${metrosPermitidos} m, accuracy ±${Math.round(f.accuracy)} m)`,
        );
        return null;
      }
    }

    const evidencia: Array<{ latitud: number; longitud: number; accuracy: number; timestamp: number }> =
      BGService.getFixesRecientes(TRACKING_EVIDENCIA_VENTANA_MS, TRACKING_EVIDENCIA_ACCURACY_MAX) ?? [];

    let mejor: { distancia: number; accuracy: number; latitud: number; longitud: number; timestamp: number } | null = null;

    for (const f of evidencia) {
      const dist = calcularDistancia(f.latitud, f.longitud, clienteLat, clienteLng);
      // Estricto a propósito: SIN buffer de accuracy sobre el rango.
      if (dist > metrosPermitidos) continue;
      if (!mejor || dist < mejor.distancia) {
        mejor = {
          distancia: dist,
          accuracy: f.accuracy,
          latitud: f.latitud,
          longitud: f.longitud,
          timestamp: f.timestamp,
        };
      }
    }

    if (!mejor) return null;

    console.log(
      `[LocationService] Evidencia de tracking: ${Math.round(mejor.distancia)} m del cliente, ` +
        `hace ${Math.round((Date.now() - mejor.timestamp) / 1000)} s (±${Math.round(mejor.accuracy)} m)`,
    );
    return mejor;
  } catch (e) {
    console.warn("[LocationService] No se pudo corroborar con tracking:", e);
    return null;
  }
}
```

### 4.4 Constructor del resultado + caché

`ultimaValidacionOk` necesita `clienteLat`/`clienteLng` reales para que el atajo de caché compare el mismo punto (ver uso en líneas ~811-818). Por eso van como parámetro:

```ts
private construirResultadoOkTracking(
  clienteLat: number,
  clienteLng: number,
  metrosPermitidos: number,
  corr: { distancia: number; accuracy: number; latitud: number; longitud: number; timestamp: number },
): ValidacionUbicacionResultado {
  // Se guarda en caché igual que un `ok`: si el vendedor revalida en <3 min,
  // la segunda llamada resuelve al instante como `ok_cache`.
  this.ultimaValidacionOk = {
    clienteLat,
    clienteLng,
    metrosPermitidos,
    distancia: corr.distancia,
    accuracy: corr.accuracy,
    timestamp: Date.now(),
  };

  console.log(
    `[LocationService] Validación VÁLIDA por tracking (ok_tracking): ` +
      `${Math.round(corr.distancia)} m del cliente, evidencia de hace ` +
      `${Math.round((Date.now() - corr.timestamp) / 1000)} s`,
  );

  return {
    valido: true,
    motivo: "ok_tracking",
    distancia: corr.distancia,
    accuracy: corr.accuracy,
    metrosPermitidos,
    ubicacion: {
      latitude: corr.latitud,
      longitude: corr.longitud,
      accuracy: corr.accuracy,
      timestamp: corr.timestamp,
    },
    // Igual que `ok_cache`: no hubo lectura en vivo válida que reportar.
    numFixes: 0,
    peorAccuracy: 0,
    tiempoMs: 0,
  };
}
```

### 4.5 Puntos de inserción en `validarUbicacionCliente`

**Solo dos puntos.** Ninguno más.

**Punto A — no hubo ninguna lectura GPS** (hoy `sin_senal`, líneas 856-858):

```ts
if (!ubicacion) {
  const corr = this.corroborarPresenciaConTracking(clienteLat, clienteLng, metrosPermitidos);
  if (corr) return this.construirResultadoOkTracking(clienteLat, clienteLng, metrosPermitidos, corr);
  return { valido: false, motivo: "sin_senal", metrosPermitidos, ...diag };
}
```

**Punto B — la lectura existe pero es imprecisa** (hoy `precision_baja` / `red_no_gnss`, líneas 880-888):

```ts
if (accuracy > PRECISION_MAXIMA_ACEPTABLE) {
  const corr = this.corroborarPresenciaConTracking(clienteLat, clienteLng, metrosPermitidos);
  if (corr) return this.construirResultadoOkTracking(clienteLat, clienteLng, metrosPermitidos, corr);

  const esRedCelular = accuracy >= 100 && accuracy % 50 === 0;
  // ... resto igual, sin cambios ...
}
```

**Lo que NO se toca:**

- El `return` de `fuera_de_rango`. **Ya NO se deja intacto**: desde la enmienda I2 (§13) se corroboración antes de bloquear, con evidencia persistida.
- El contraste de incoherencia de la sección 2.5 (líneas ~894-926). Se deja tal cual en esta fase.
- El chequeo de permiso (línea ~800). **I3.**

### 4.6 Bitácora: sin cambios

`validarUbicacionConDiagnostico` (línea ~1054) ya registra `r.motivo`, `r.valido`, `r.distancia`, `r.accuracy`, `r.metrosPermitidos`, `r.ubicacion`, `numFixes`, `peorAccuracy`, `tiempoMs` y `conCobertura`. Con `ok_tracking` queda auditado sin tocar nada más.

`validarUbicacionConAlerta` (línea ~949) es **código muerto** (única referencia: un comentario en `GpsBitacoraService.ts:239`). No lo toques en esta fase; no lo borres tampoco sin pedir permiso.

### 4.7 UI: sin cambios

`CumplimientoScreen.tsx:502` y `SalesScreen.tsx` (líneas ~1149 y ~1377) ya hacen `if (resultado.valido) return true`. Con `ok_tracking` navegan igual que con `ok`. No se debe agregar ninguna pantalla ni mensaje.

---

## 5. Tests obligatorios (Fase 2)

Crear `__tests__/LocationService.test.ts`. Modelo de mocks: `__tests__/BackgroundLocationService.test.ts` (mockea `react-native-geolocation-service`, `netinfo`, `AuthService`, `FullSyncService`). Acá además hay que mockear `../services/GpsBitacoraService` y `../services/BackgroundLocationService`.

| # | Escenario | Resultado esperado |
|---|---|---|
| T1 | Fix en vivo `accuracy 2066`, tracking con fix a 17.5 m / ±18.6 m / hace 174 s, permitido 100 | `motivo === "ok_tracking"`, `valido === true` |
| T2 | Igual que T1 pero el mejor fix de tracking está a 120 m | `motivo === "precision_baja"`, `valido === false` |
| T3 | Igual que T1 pero además hay un fix bueno (±10 m) a 250 m hace 30 s | **`motivo === "precision_baja"`**, `valido === false` (veto, I6) |
| T4 | Fix en vivo bueno (±6 m) a 134 m con permitido 100 y tracking con evidencia persistida a 20 m | **`motivo === "ok_tracking"`** (I2 enmendada) |
| T4b | Igual que T4 pero sin evidencia | `fuera_de_rango` (I2 sigue vigente sin evidencia) |
| T4c | Igual que T4 con un fix de 300 m hace 20 s | `fuera_de_rango` (I6, veto manda) |
| T4d | Igual que T4 con evidencia de hace 6 min | `fuera_de_rango` (I5, antigüedad) |
| T4e | Igual que T4 con `HABILITAR_OK_TRACKING = false` | `fuera_de_rango` (rollback) |
| T5 | `HABILITAR_OK_TRACKING = false` con el escenario de T1 | `precision_baja` (rollback funciona) |
| T6 | `getFixesRecientes` devuelve `[]` | comportamiento idéntico al actual |
| T7 | `getFixesRecientes` lanza excepción | no propaga; cae al motivo actual (I7) |
| T8 | Tras un `ok_tracking`, segunda validación del mismo cliente <3 min | `motivo === "ok_cache"` |
| T9 | Sin permiso de ubicación | `sin_permiso` (I3), nunca `ok_tracking` |
| T10 | Lectura vacía (`getBestLocation` → null) con evidencia de tracking | `ok_tracking` (Punto A) |
| T11 | Fix en vivo bueno (±8 m) y dentro del rango **con** evidencia de tracking disponible | **`motivo === "ok"`**, nunca `ok_tracking`; no se consulta el tracking |

T4, T9 y T11 son las pruebas que protegen la lógica de negocio. Si fallan, la implementación no se libera.

---

## 6. Verificación antes de cada commit

```bash
npx tsc --noEmit -p tsconfig.json     # debe seguir en 0 errores
npx jest                               # todo verde
npx jest __tests__/LocationService.test.ts __tests__/BackgroundLocationService.test.ts
```

Revisar además en el diff que **no** aparezcan cambios en:

- `components/CumplimientoScreen.tsx` (salvo lo de la fase 5, si se hace)
- `components/SalesScreen.tsx`
- `services/RealmSchemas.ts`
- `services/ReubicacionService.ts`
- la constante `TTL_VALIDACION_CACHE_MS` ni las de precisión

---

## 7. Fase 3 — Etiquetar el fix de red (opcional, release aparte)

**Objetivo:** que “no hay GPS” no se reporte como “precisión baja”.

`getBestLocation` ya devuelve `provider` (viene de `location.getProvider()` en el nativo) y hoy **se ignora**. En el bloque de la Fase 2, Punto B (línea ~881), sustituir la heurística:

```ts
// antes
const esRedCelular = accuracy >= 100 && accuracy % 50 === 0;
// después
const esRed = (ubicacion.provider ?? "").toLowerCase().includes("network") || accuracy >= 150;
```

**Advertencia:** esto solo cambia la **etiqueta** (`precision_baja` → `red_no_gnss`) y con ella el texto que ve el vendedor en `ModalDiagnosticoGps`. Distorsiona las series históricas por motivo: si se hace, dejar fecha de corte y no comparar agregados antes/después.

La regla `accuracy % 50 === 0` está **duplicada** en `services/LocationService.ts:881` y `:1002`. Si se corrige una y no la otra, quedan dos comportamientos distintos.

---

## 8. Fase 4 — Mantener el GNSS caliente (release independiente)

**Archivo:** `services/BackgroundLocationService.ts`
**Motivo:** el caso 357053 coincide con un apagado del GNSS. Con el intervalo nativo actual (30 s al estar “enganchado”) el receptor no sostiene el enganche.

Hoy:

```ts
private getNativeIntervalMs(): number {
  return this.gpsEnganchado ? this.intervalMs : Math.min(this.intervalMs, this.INTERVALO_ADQUISICION_MS);
}
```

Propuesto: desacoplar el intervalo **nativo** del de **escritura** (`intervalMs = 30000` es la cadencia de persistencia, no la del sensor).

```ts
private readonly INTERVALO_ENGANCHADO_MS = 5000;

private getNativeIntervalMs(): number {
  return this.gpsEnganchado
    ? this.INTERVALO_ENGANCHADO_MS
    : Math.min(this.intervalMs, this.INTERVALO_ADQUISICION_MS);
}
```

Hay que acompañar `evaluateGpsState` (línea ~342). Hoy compara y asigna contra `this.intervalMs`:

```ts
if (this.intervaloNativo !== this.intervalMs) {
  this.intervaloNativo = this.intervalMs;
  void this.startWatch(this.generation);
}
```

⚠️ **Si se deja así, provoca un bucle.** Con el cambio de arriba `this.intervaloNativo` valdría 5000, la comparación `5000 !== 30000` sería **siempre** verdadera y **cada fix bueno re-suscribiría el watch**: batería y re-suscripciones en cascada.

Reemplazo correcto, en las **dos** ramas (al enganchar y al perder el enganche):

```ts
const objetivo = this.getNativeIntervalMs();
if (this.intervaloNativo !== objetivo) {
  this.intervaloNativo = objetivo;
  void this.startWatch(this.generation);
}
```

**Gate obligatorio antes de liberar:** medir una jornada completa de batería en un equipo real. Pasar de 30 s a 5 s multiplica las activaciones del sensor. No liberar sin ese dato.

**Prioridad revaluada el 2026-10-22 (ver §12):** antes de tocar los intervalos, resolver el equipo del vendedor **1042** — 9 de los 14 casos "ciegos" de los últimos 10 días son suyos. Un terminal que no entrega ningún fix en 15 minutos no se arregla bajando el intervalo de muestreo.

---

## 9. Fase 5 — Instrumentar los intentos de reubicación (opcional)

Hoy **los intentos fallidos de reubicar y los fallos de “Cercanos” no dejan ningún rastro** en el servidor: solo un `Alert` y un `console.warn`. El callejón sin salida es lo único que no se puede medir.

Agregar llamadas a `GpsBitacoraService.registrarValidacion` con motivos propios (todos ≤20 caracteres):

| Punto | `motivo` | Longitud |
|---|---|---|
| `CumplimientoScreen.tsx:822` / `SalesScreen.tsx:1733` (sin lectura) | `reub_sin_fix` | 12 |
| `CumplimientoScreen.tsx:834` / `SalesScreen.tsx:1745` (precisión insuficiente) | `reub_precision_baja` | 18 |
| `CumplimientoScreen.tsx:1128` / `SalesScreen.tsx:1097` (Cercanos) | `cercanos_sin_fix` | 16 |

`valido: false`, `idCliente` del cliente en cuestión, y `accuracy`/`numFixes` desde `LocationService.getUltimoDiagnosticoGps()`.

**Impacto en análisis existentes:** el clasificador `D1` de `docs/CONSULTAS_AUDITORIA_GPS.md` filtra `motivo IN ('fuera_de_rango','precision_baja','sin_senal')` para atribuir reubicaciones. Los motivos nuevos **no colisionan** porque llevan prefijo distinto. No usar el prefijo `recorrido`.

---

## 10. Rollback

| Situación | Acción |
|---|---|
| Aprobaciones indebidas en campo | `HABILITAR_OK_TRACKING = false` → comportamiento idéntico al actual, sin tocar nada más |
| Batería degradada tras Fase 4 | revertir `getNativeIntervalMs` y `evaluateGpsState` al valor anterior |
| Motivo rechazado por el servidor | el lote entero se retiene; deshabilitar la constante y revisar el `VARCHAR` desplegado |

No hay migración de Realm ni cambio de contrato, así que el rollback es solo código.

---

## 11. Métricas de aceptación (post-deploy)

Correr a los 7 y a los 30 días:

```sql
-- 1) ¿Cuántas aprobaciones usan la nueva vía? Se espera 1-5 % de las validaciones.
SELECT motivo, COUNT(*) AS casos
FROM dbo.BitacoraValidacionUbicacionMovil
WHERE fecha >= '2026-10-22'
GROUP BY motivo
ORDER BY casos DESC;

-- 2) Control de abuso: quién usa ok_tracking y cuánto.
SELECT idUsuario, sucursal, CAST(fecha AS DATE) AS dia, COUNT(*) AS ok_tracking
FROM dbo.BitacoraValidacionUbicacionMovil
WHERE motivo = 'ok_tracking'
GROUP BY idUsuario, sucursal, CAST(fecha AS DATE)
HAVING COUNT(*) >= 5
ORDER BY ok_tracking DESC;

-- 3) Efecto buscado: visitas perdidas por GPS (anexo A), antes vs después.
```

**Criterios:** `ok_tracking` entre 1 % y 5 %; ningún vendedor con ≥5 en un día sin justificación; la consulta 3 debe bajar.

---

## 12. Evidencia de campo que respalda el diseño (2026-10-22)

Medición sobre **50 fallos perdidos** de los últimos 10 días (Anexo A v2 acotado a 10 días, cruzado contra `BitacoraTrackingGpsMovil`):

| Cubo | Casos | % | Lectura |
|---|---|---|---|
| Rescatables: fix bueno dentro del radio | **11** | 22 % | El vendedor estaba; el GPS falló al validar |
| Lejos: fix bueno pero fuera del radio | **24** | 48 % | El bloqueo fue correcto |
| Ciegos: sin ningún fix bueno en 15 min | **14** | 28 % | Equipo sin GPS |
| Límite: solo califica a 10 min | 1 | 2 % | Caso a rechazar |

### 12.1 La ventana de 5 minutos está validada — NO ampliarla

Rescatables acumulados: **11 a 5 min, 12 a 10 min, 12 a 15 min**. Ampliar la ventana gana **un solo caso** en 10 días.

Y ese caso (fallo `344167`) es el argumento en contra: tenía un fix a 26 m **entre 5 y 10 minutos** antes de la validación, y a 119 m en los 5 minutos previos. El vendedor estuvo, se fue y validó después. Aprobarlo con una ventana de 10 minutos sería aprobar una venta desde 119 m.

**Decisión:** `TRACKING_EVIDENCIA_VENTANA_MS` se queda en 5 minutos. Cualquier propuesta de ampliarla exige evidencia nueva con volumen relevante de rescates perdidos, no presión de campo.

### 12.2 Un solo equipo explica el 64 % de los casos ciegos

| Vendedor | Sucursal | Casos ciegos |
|---|---|---|
| **1042** | **11** | **9** |
| 1039 | 8 | 2 |
| 1051, 1040, 1033 | 2082, 9, 25 | 1 cada uno |

Un terminal que no entrega **ningún** fix con accuracy ≤ 25 m en 15 minutos no tiene un problema de intervalo de muestreo: está mal configurado o averiado. Antes de tocar código, aplicar sobre ese equipo el checklist de `docs/FASES_PENDIENTES_GPS.md` §3.9.

### 12.3 Clientes con coordenada sospechosa

| Cliente | Vendedor | Intentos | Mejor distancia | Permitido |
|---|---|---|---|---|
| **27641** | 1052 | 4 (12-oct 14:02–14:14) | 169.9 m | 100 |
| 14799 | 1042 | 2 (mismo segundo) | — | 79 |
| 15063 | 1042 | 2 | — | 79 |
| 10457 | 1027 | 2 | 327 m | 79 |

Cuatro intentos en doce minutos sin bajar de 169.9 m con 100 permitidos describen a un vendedor en la puerta con el punto corrido, no a un GPS malo. Revisar esas georreferencias en el mapa antes de atribuir el fallo al software (clasificador `D1` en `docs/CONSULTAS_AUDITORIA_GPS.md`).

### 12.4 Efecto esperado y medición de cierre

- `ok_tracking` debe capturar ~11 de cada 50 fallos perdidos en una ventana reciente (22 %), y ~13 % sobre el promedio de 30 días.
- A los 30 días, `visitas_perdidas` (Anexo A v2) debe bajar de **122**. Si no baja, el cuello estaba en el cubo "lejos" (48 %) y la siguiente inversión es UX de distancia y remediación de coordenadas, no más tolerancia de GPS.

---

## Anexo A — Consulta de “visitas perdidas por GPS”

### A.1 Versión publicada (v1) — la que produjo el baseline

```sql
WITH fallos AS (
  SELECT idUsuario, sucursal, idCliente, CAST(fecha AS DATE) AS dia
  FROM dbo.BitacoraValidacionUbicacionMovil
  WHERE motivo IN ('precision_baja','sin_senal','red_no_gnss')
    AND fecha >= DATEADD(DAY, -30, GETDATE())
),
salvados AS (
  SELECT DISTINCT idUsuario, sucursal, idCliente, CAST(fecha AS DATE) AS dia
  FROM dbo.BitacoraValidacionUbicacionMovil
  WHERE motivo IN ('ok','ok_cache')
)
SELECT COUNT(*) AS intentos_fallidos,
       SUM(CASE WHEN s.idCliente IS NULL THEN 1 ELSE 0 END) AS clientes_sin_visita_ese_dia,
       COUNT(DISTINCT f.idUsuario) AS vendedores,
       COUNT(DISTINCT f.idCliente) AS clientes_afectados
FROM fallos f
LEFT JOIN salvados s
       ON s.idUsuario = f.idUsuario AND s.sucursal = f.sucursal
      AND s.idCliente = f.idCliente AND s.dia = f.dia;
```

**Resultado medido el 2026-10-22 (30 días):** `intentos_fallidos` 1352, `clientes_sin_visita_ese_dia` 145, `vendedores` 30, `clientes_afectados` 889.

⚠️ **La columna `clientes_sin_visita_ese_dia` cuenta filas, no clientes distintos.** Si un vendedor intentó el mismo cliente 5 veces sin lograrlo, suma 5. Sobreestima el daño real.

### A.2 Versión corregida (v2) — usar de aquí en adelante

Un renglón por `(vendedor, sucursal, cliente, día)` que quedó sin visita. Es la cifra que se puede defender ante gerencia y la única comparable antes/después.

```sql
WITH fallos AS (
  SELECT DISTINCT idUsuario, sucursal, idCliente, CAST(fecha AS DATE) AS dia
  FROM dbo.BitacoraValidacionUbicacionMovil
  WHERE motivo IN ('precision_baja','sin_senal','red_no_gnss')
    AND fecha >= DATEADD(DAY, -30, GETDATE())
    AND idCliente IS NOT NULL
),
salvados AS (
  SELECT DISTINCT idUsuario, sucursal, idCliente, CAST(fecha AS DATE) AS dia
  FROM dbo.BitacoraValidacionUbicacionMovil
  WHERE motivo IN ('ok','ok_cache','ok_tracking')
)
SELECT COUNT(*) AS visitas_perdidas,
       COUNT(DISTINCT f.idCliente) AS clientes_distintos,
       COUNT(DISTINCT f.idUsuario) AS vendedores
FROM fallos f
WHERE NOT EXISTS (
  SELECT 1 FROM salvados s
  WHERE s.idUsuario = f.idUsuario AND s.sucursal = f.sucursal
    AND s.idCliente = f.idCliente AND s.dia = f.dia
);
```

**Resultado medido el 2026-10-22 (últimos 30 días):** `visitas_perdidas` **122**, `clientes_distintos` **117**, `vendedores` **23**.

Casi todas son visitas de clientes distintos (117 de 122): no es el mismo cliente reintentado, son ~4 visitas perdidas por día repartidas entre 23 de los 30 vendedores.

Desde el deploy, `ok_tracking` entra en `salvados`: la consulta mide lo mismo antes y después, así que la comparación a 30 días es válida sin ajustes.

---

## Anexo B — Archivos y anclas

| Archivo | Ancla | Fase |
|---|---|---|
| `services/BackgroundLocationService.ts` | `MAX_FIX_AGE_MS` (~22), `getUltimoFixTracking` (83), `onLocationFix` (255-262), `getNativeIntervalMs` (190), `evaluateGpsState` (342) | 1, 4 |
| `services/LocationService.ts` | `MotivoValidacion` (17), constantes (42-59), `corroborarPresenciaConTracking` (nuevo), `validarUbicacionCliente` (794-943: puntos A=856, B=880) | 2, 3 |
| `services/GpsBitacoraService.ts` | `registrarValidacion` (241-293) — sin cambios | 2 |
| `components/CumplimientoScreen.tsx` | `handleReubicarCliente` (793-921), `actualizarCoordenadas` (1081-1137) | **no tocar** (5) |
| `components/SalesScreen.tsx` | `handleReubicarCliente` (1703-1770) | **no tocar** (5) |
| `__tests__/LocationService.test.ts` | nuevo | 2 |

---

## Anexo C — Caso de regresión reproducible

Con los datos reales del caso 357053, el test T1 debe construirse así:

- Cliente: `19.4397012, -96.7532193`
- `metrosPermitidos`: `100`
- Fix en vivo: `accuracy 2066.0390625`, `numFixes 1`
- Evidencia de tracking: `19.4398574829102, -96.7532424926758`, `accuracy 18.556`, hace `174000 ms`
- Resultado esperado: `ok_tracking` con `distancia ≈ 17.5 m`

Ese test es la prueba de que el cambio resuelve el problema real y no una hipótesis.

---

## 13. Enmienda I2 — `fuera_de_rango` corroborado por tracking (2026-10-27)

### El caso que la motivó (bitácora real, validación 373510)

| hora | fuente | distancia al cliente | accuracy declarada |
|---|---|---|---|
| 16:17:08 | tracking (persistido) | **38.7 m** | ±18.3 m |
| 16:17:11 | lectura de la validación | **419.4 m** | ±11.9 m |
| 16:20:12 | validación siguiente (ok) | 23.6 m | ±18.5 m |

El vendedor estaba en la puerta. La lectura de la validación salió 442 m fuera de donde el propio tracking tenía el teléfono **3 segundos antes**, con un accuracy declarado de ±11.9 m (error real: 37× lo declarado). Antes de esta enmienda, I2 bloqueaba la venta sin salida: el modal "Fuera de rango" solo tiene la X y el candado de reubicación (±25 m y 3 fixes) tampoco se puede cumplir con ese receptor.

### Por qué el contraste existente (bloque 2.5) no lo atrapó

El bloque 2.5 compara la lectura contra `getUltimoFixTracking()`. Pero la suscripción nativa es **una sola y compartida**: la ráfaga que dispara la validación llega también al callback de fondo y sobreescribe `ultimoFixTracking` con el mismo fix malo. El candado termina comparando el fix consigo mismo (`distancia ≈ 0` → velocidad ≈ 0 → no dispara). Evidencia: el fix de 419 m **no** aparece en `BitacoraTrackingGpsMovil` (el throttle de 24 s lo descartó) mientras que el de 16:17:08 sí.

### Qué cambió

1. `BackgroundLocationService` mantiene `fixesPersistidos`: solo los fixes que **realmente se escribieron en la bitácora** (después del throttle, junto a `lastCaptureAt`). Nuevo `getFixesPersistidos(maxEdadMs, maxAccuracy)`.
2. `corroborarPresenciaConTracking` consume `getFixesPersistidos()` en vez de `getFixesRecientes()` (evidencia y veto). **I10.**
3. Nuevo bloque 2.9 en `validarUbicacionCliente`, **antes** del contraste 2.5: si la lectura está fuera de rango, hay corroboración persistida y no hay veto, la venta se acredita como `ok_tracking`. Bandera `HABILITAR_OK_TRACKING_FUERA_DE_RANGO` (rollback: `false`).
4. Versión de la app: **1.5** (`versionCode 4`), luego 1.6 con R1-R3, para poder separar este build en la bitácora (`versionApp`).

### Lo que NO cambia

- Sin evidencia persistida, `fuera_de_rango` sigue bloqueando (T4b).
- El veto de 2 min sigue mandando sobre la evidencia positiva (T4c).
- La evidencia caduca a los 5 min (T4d).
- El candado de reubicación (±25 m y ≥3 fixes) queda intacto. **I4.**
- `sin_permiso` nunca se aprueba. **I3.**

### Cómo se mide

`sql/cierre_ok_tracking.sql` con `@versionApp = '1.5'`: la columna `ok_tracking` de 3B debe subir respecto a 1.4 y `fuera_de_rango` bajar en la misma proporción. `sql/verificacion_piloto_ok_tracking.sql` R4 audita cada fila `ok_tracking` contra el tracking del servidor: toda aprobación tiene que tener un fix persistido a ≤ rango del cliente.

## 14. Admisión de evidencia — R1, R2, R3 (2026-10-27, build 1.6)

El 2.9 enmienda *cuándo* se usa la evidencia; esta sección regula *qué cuenta como evidencia*. Antes de estos cambios, `registrarFixPersistido` solo filtraba por `accuracy <= 25 m`, así que una sola fila podía aprobar una venta y una sola fila podía impedirla.

### R1 — Proveedor confiable

Un fix de `network` puede declarar ±11.9 m y estar 419 m fuera: es exactamente la firma del caso 373510. Solo el GNSS crudo acredita presencia.

| proveedor | se acepta |
|---|---|
| `gps` | sí |
| `fused` | solo si `accuracy <= 20` **y** trae `speed` (el fused sin velocidad suele ser una media ponderada con red) |
| `network`, `passive` | no |
| desconocido (`""`) | sí (plataformas que no reportan proveedor; no romper iOS) |

### R2 — Salto físicamente imposible

Entre dos fixes consecutivos no se puede recorrer más de **150 km/h** (41.7 m/s, con piso de 5 s de `dt`). Un salto así se descarta y **no mueve la base**: si el fix malo pasara a ser "el último confiable", el siguiente se compararía contra él y la cadena quedaría contaminada.

Recuperación: si llegan **dos fixes seguidos que concuerdan entre sí** (velocidad entre ellos ≤ 150 km/h, dentro de 3 min), el movimiento era real —equipo que vuelve de un hueco o de suspensión— y la cadena se reancla en el punto nuevo.

Qué atrapa y qué no:

| caso | salto | velocidad | resultado |
|---|---|---|---|
| 357053 10:57:51 | 4,384 m en 60 s | 263 km/h | descartado |
| salto de red típico | 2,000 m en 30 s | 240 km/h | descartado |
| 373510 | 380 m en 60 s | 22.8 km/h | pasa (es caminar) |

**Límite conocido:** un fix de red con ±12 m a 400 m es geométricamente indistinguible de un movimiento real. R2 no lo atrapa; lo atrapa R1.

### R3 — Asimetría aprobar/vetar

Aprobar basta con un fix bueno (no perder ventas); **vetar exige dos** (`TRACKING_VETO_FIXES_MIN = 2`). Un solo punto malo ya no puede tumbar una visita que sí tiene evidencia dentro del rango.

### Invariantes nuevas

- **I11.** Solo un fix con proveedor confiable (R1) puede entrar a `fixesPersistidos`.
- **I12.** Un fix que implica un salto > 150 km/h no entra ni se convierte en base de comparación.
- **I13.** El veto requiere al menos dos fixes de acuerdo; la aprobación sigue requiriendo uno.

### Tests

| test | qué fija |
|---|---|
| `R1` ×4 | red, pasiva, gps y fused (con y sin velocidad) |
| `R2` ×3 | salto descartado, base intacta tras el descarte, reanclaje con dos fixes concordantes |
| `T3` | dos fixes lejanos vetan la evidencia vieja |
| `T4c` | veto con dos fixes manda sobre la evidencia positiva |
| `T4f` | un solo fix lejano **no** veta (R3) |

### Cómo se mide

`sql/medicion_ok_tracking_por_version.sql` (ya apunta a `@versionNueva = '1.6'` y `@versionPrevia = '1.5'`): la salida 3b no debería mostrar `CONTRADICHO` en el build nuevo, y la salida 4 audita que cada `ok_tracking` tenga evidencia con `accuracy <= 25` e `distancia <= permitido`.
