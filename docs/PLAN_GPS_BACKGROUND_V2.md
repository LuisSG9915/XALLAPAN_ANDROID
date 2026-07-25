# Plan V2: Tracking GPS en background SIN licencia (Android)

> Objetivo: registrar la bitácora GPS cada ~30 s aunque la **pantalla esté apagada** o
> la app esté en **segundo plano / bloqueada**, **eliminando** la dependencia
> `react-native-background-geolocation` (transistorsoft) que emite
> `LICENSE VALIDATION FAILURE` desde su SDK nativo (`tslocationmanager`).
>
> **Sustituye** al plan original `docs/PLAN_GPS_BACKGROUND.md` (basado en transistorsoft).

---

## Diagnóstico del problema actual

- El warning `LICENSE VALIDATION FAILURE ... Failed to find license key in androidManifest`
  proviene del **`.aar` nativo** de transistorsoft, no del manifest. Quitar el
  `<meta-data android:name="com.transistorsoft.locationmanager.license" ...>` (ya hecho)
  **no** elimina el mensaje porque la validación vive en el binario nativo.
- El cliente **no adquirirá** la licencia, por lo que hay que **eliminar la librería**.

### Puntos de integración actuales de transistorsoft (a desmontar)

| Archivo | Referencia |
|---|---|
| `package.json` | dependencia `react-native-background-geolocation` |
| `android/settings.gradle:6-7` | `include ':react-native-background-geolocation'` + `project(...)` |
| `android/app/build.gradle:5-6` | `Project background_geolocation` + `apply from app.gradle` |
| `index.js:8-11` | `import BackgroundGeolocation` + `registerHeadlessTask(HeadlessLocationTask)` |
| `services/BackgroundLocationService.ts` | wrapper completo + `HeadlessLocationTask` |
| `android/app/src/main/AndroidManifest.xml` | `<meta-data ... license>` (YA eliminado) |

### Activos reutilizables (ya instalados, SIN licencia)

- `react-native-geolocation-service` (`^5.3.1`) → fixes GPS (`getCurrentPosition`, `watchPosition`).
- `react-native-background-fetch` (`4.2.8`) → sync (se mantiene, es independiente del GPS).
- Permisos ya declarados en el manifest: `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`,
  `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`,
  `WAKE_LOCK`, `RECEIVE_BOOT_COMPLETED`, `POST_NOTIFICATIONS`.
- Persistencia y envío ya listos: `GpsBitacoraService.registrarUbicacion()` y
  `GpsBitacoraService.enviarBitacorasPendientes()`.

---

## Solución elegida

**Foreground Service en JS con `react-native-background-actions` + `react-native-geolocation-service`.**

Un *foreground service* con notificación persistente mantiene vivo el proceso y el hilo
JS aunque la pantalla esté apagada o la app en segundo plano. Dentro del servicio, un
bucle captura la posición cada `intervaloGPS` segundos con `Geolocation` (el mismo módulo
que ya usas) y la persiste con `GpsBitacoraService.registrarUbicacion()`.

### Por qué funciona con pantalla apagada
- Android exime al proceso de la mayoría de restricciones de Doze **mientras haya un
  foreground service activo**, así que el bucle JS sigue ejecutándose.
- Los fixes se obtienen vía `FusedLocationProviderClient` (dentro de
  `react-native-geolocation-service`), que entrega ubicaciones con el proceso vivo y el
  permiso "Permitir todo el tiempo" concedido.

### Ventaja de diseño
El contrato público de `BackgroundLocationService` (`start()`, `stop()`, `setInterval()`,
`getState()`) se mantiene idéntico, por lo que `RouteTrackingService` **no cambia su lógica**.

### Límite conocido (honesto)
Con la app **cerrada por swipe**, un foreground service JS puede detenerse. Con
**pantalla apagada + app en segundo plano/bloqueada** funciona. Para paridad total con
"app cerrada" queda la **Fase 5 opcional** (servicio nativo Kotlin).

---

## FASE 0 — Quitar transistorsoft

### 0.1 `package.json`
```powershell
pnpm remove react-native-background-geolocation
```

### 0.2 `android/settings.gradle`
Eliminar:
```gradle
include ':react-native-background-geolocation'
project(':react-native-background-geolocation').projectDir = new File(rootProject.projectDir, '../node_modules/react-native-background-geolocation/android')
```

### 0.3 `android/app/build.gradle`
Eliminar (líneas 5-6):
```gradle
Project background_geolocation = project(':react-native-background-geolocation')
apply from: "${background_geolocation.projectDir}/app.gradle"
```

### 0.4 `index.js`
Eliminar:
```js
import BackgroundGeolocation from 'react-native-background-geolocation';
import { HeadlessLocationTask } from './services/BackgroundLocationService';
BackgroundGeolocation.registerHeadlessTask(HeadlessLocationTask);
```
Dejar solo el registro del componente:
```js
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
```

### 0.5 `AndroidManifest.xml`
`<meta-data ... com.transistorsoft.locationmanager.license>` → **YA eliminado**.

---

## FASE 1 — Instalar alternativa

### 1.1 Instalar dependencia
```powershell
pnpm add react-native-background-actions
```

### 1.2 Verificar `foregroundServiceType` (Android 14/15, targetSdk 36)
Tras el primer build, revisar el manifest fusionado
(`android/app/build/intermediates/merged_manifests/.../AndroidManifest.xml`) y confirmar
que el servicio de `react-native-background-actions` declara
`android:foregroundServiceType="location"`. Si no lo hace, **override** en
`android/app/src/main/AndroidManifest.xml` dentro de `<application>`:
```xml
<service
    android:name="com.asterinet.react.bgactions.RNBackgroundActionsTask"
    android:foregroundServiceType="location"
    tools:node="merge" />
```
> Requiere `xmlns:tools="http://schemas.android.com/tools"` en el `<manifest>`.
> El permiso `FOREGROUND_SERVICE_LOCATION` ya está declarado.

---

## FASE 2 — Reescribir `services/BackgroundLocationService.ts`

Mantener el **mismo contrato público** para no tocar `RouteTrackingService`.

Responsabilidades del nuevo wrapper:
- `start()`: solicita permiso background (reusar `LocationService.requestBackgroundLocationPermission()`)
  y lanza `BackgroundActions.start(taskLoop, options)` con notificación persistente.
- `taskLoop`: mientras el servicio esté activo, cada `intervalMs`:
  1. `Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 20000, maximumAge: 0 })`.
  2. `const conCobertura = (await NetInfo.fetch()).isConnected === true`.
  3. `await GpsBitacoraService.registrarUbicacion(lat, lng, accuracy, conCobertura)`.
  4. `await sleep(intervalMs)` (helper de background-actions o `setTimeout` envuelto en Promise).
- `stop()`: `await BackgroundActions.stop()`.
- `setInterval(ms)`: guardar `intervalMs = clamp(5000, 300000, ms)`; si el servicio corre,
  actualizar mediante `BackgroundActions.updateNotification` no aplica al intervalo, así que
  el bucle debe leer `this.intervalMs` en cada iteración (variable de instancia).
- `getState()`: devolver `{ enabled: BackgroundActions.isRunning() }` (adaptar al tipo usado).
- **Eliminar** `HeadlessLocationTask` y toda importación de `react-native-background-geolocation`.

Notificación sugerida:
```ts
const options = {
  taskName: "XallapanRuta",
  taskTitle: "Xallapan",
  taskDesc: "Registrando tu recorrido en segundo plano",
  taskIcon: { name: "ic_launcher", type: "mipmap" },
  linkingURI: "xallapan://",
  parameters: {},
};
```

Pseudocódigo del bucle:
```ts
const veryIntensiveTask = async () => {
  while (BackgroundActions.isRunning()) {
    try {
      const loc = await LocationService.getCurrentLocation();
      if (loc) {
        const net = await NetInfo.fetch();
        await GpsBitacoraService.registrarUbicacion(
          loc.latitude, loc.longitude, loc.accuracy, net.isConnected === true,
        );
      }
    } catch (e) { console.warn(TAG, e); }
    await sleep(this.intervalMs);
  }
};
```
> Nota: `LocationService.getCurrentLocation()` ya registra en bitácora internamente vía
> `GpsBitacoraService.registrarUbicacion(lat,lng,acc)` (sin `conCobertura`). Para evitar
> **doble registro**, o bien: (a) usar `Geolocation.getCurrentPosition` directo en el bucle,
> o (b) añadir un parámetro a `getCurrentLocation()` para no auto-registrar. Recomendado (a)
> para tener control de `conCobertura`.

---

## FASE 3 — Integración con `RouteTrackingService`

`services/RouteTrackingService.ts` **no cambia su lógica**: ya llama a
`BackgroundLocationService.setInterval(intervalo*1000)`, `.start()` y `.stop()`.

Solo verificar:
- `iniciarRuta()` (líneas ~179-184): sigue funcionando con la nueva implementación.
- `finalizarRuta()` (líneas ~200-204): `stop()` detiene el foreground service.
- Antes de `start()`, asegurar permiso background con
  `LocationService.requestBackgroundLocationPermission()` (mostrar diálogo "Permitir todo el tiempo").

---

## FASE 4 — Pruebas funcionales (dispositivo físico)

Checklist:
- [ ] Iniciar ruta → aparece notificación persistente.
- [ ] App en segundo plano (Home) → puntos cada ~30 s.
- [ ] **Pantalla apagada 5-10 min → se siguen capturando puntos** (requisito principal).
- [ ] Puntos guardados en Realm (`BitacoraGps`) con `enviado=false`.
- [ ] `enviarBitacorasPendientes` marca `enviado=true` sin borrar.
- [ ] Finalizar ruta → desaparece la notificación y se detiene el servicio.
- [ ] **Ya NO aparece** `LICENSE VALIDATION FAILURE` en logcat.

Build de prueba:
```powershell
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
android\gradlew.bat -p android app:installDebug
pnpm exec react-native start
```

---

## FASE 5 (OPCIONAL) — Servicio nativo Kotlin

Solo si se requiere sobrevivir a **app cerrada por swipe**:
- `ForegroundService` propio en Kotlin con `FusedLocationProviderClient`
  (`play-services-location`, ya disponible por `react-native-geolocation-service`).
- `startOnBoot` con `RECEIVE_BOOT_COMPLETED` para reanudar tras reinicio.
- Persistir a un almacén accesible desde JS (p. ej. escribir a SQLite/archivo y que JS lo
  vuelque a Realm al abrir), ya que escribir a Realm desde nativo es complejo.
- Mayor esfuerzo; evaluar si el caso de uso real lo exige.

---

## Consideraciones / Riesgos

- **Notificación persistente obligatoria** mientras la ruta esté activa (igual que antes).
- **Permiso "Permitir todo el tiempo"** debe concederse manualmente en Android 11+.
- **Doble registro GPS**: evitar que `getCurrentLocation()` y el bucle registren el mismo
  fix (ver nota en Fase 2).
- **Fabricantes agresivos (Xiaomi, Huawei, Samsung)**: pueden matar el servicio; documentar
  desactivar optimización de batería para la app.
- **Precisión del bucle temporal**: con foreground service el timer es fiable; sin él,
  Android lo suspende (por eso es imprescindible el foreground service).
- **Rebuild nativo obligatorio** tras Fase 0-1 (cambia gradle y dependencias nativas).

---

## Resumen de archivos a modificar

| Archivo | Acción |
|---|---|
| `package.json` | − `react-native-background-geolocation`, + `react-native-background-actions` |
| `android/settings.gradle` | − include/project de transistorsoft |
| `android/app/build.gradle` | − apply `app.gradle` de transistorsoft |
| `android/app/src/main/AndroidManifest.xml` | (opcional) override `foregroundServiceType=location` |
| `index.js` | − import + `registerHeadlessTask` |
| `services/BackgroundLocationService.ts` | **reescribir** con background-actions + geolocation-service |
| `services/RouteTrackingService.ts` | sin cambios de lógica (solo verificar) |
| `services/GpsBitacoraService.ts` | sin cambios |
| `docs/PLAN_GPS_BACKGROUND.md` | obsoleto (reemplazado por este V2) |

---

## Orden de ejecución recomendado
1. Fase 0 (quitar transistorsoft) + Fase 1 (instalar) + build de verificación.
2. Fase 2 (reescribir `BackgroundLocationService`) + build.
3. Fase 3 (verificar integración `RouteTrackingService`).
4. Fase 4 (pruebas en físico, foco en pantalla apagada).
5. Fase 5 solo si se necesita paridad con "app cerrada por swipe".

---

# FASE 6 — Correcciones post-implementación (2026-07-22)

Tras el primer build funcional (ya **no aparece** `LICENSE VALIDATION FAILURE`), en dispositivo
se detectaron dos problemas:

1. **No aparece la notificación persistente.**
2. **Con pantalla encendida NO se registra la bitácora GPS (`BitacoraGps`).**
   (La tabla de validación `BitacoraValidacion` / `bitacorabalidacionubicacionmovil` sí registra,
   porque proviene del flujo de venta, no del recorrido.)

## Diagnóstico

### Problema 1 — Notificación ausente
- El servicio `com.asterinet.react.bgactions.RNBackgroundActionsTask` **sí** quedó bien
  fusionado con `android:foregroundServiceType="location"` (verificado en
  `android/app/build/intermediates/merged_manifest/debug/.../AndroidManifest.xml`).
- Causa real: **la app nunca solicita `POST_NOTIFICATIONS` en runtime**. En Android 13+ (API 33)
  el foreground service arranca igual, pero la notificación queda **oculta/silenciada** si ese
  permiso no fue concedido. Por eso el servicio corre pero no se ve la notificación.

### Problema 2 — Bitácora GPS no se registra
- El loop de `BackgroundLocationService.backgroundTask()` usa
  `while (BackgroundActions.isRunning())`. `_isRunning` se pone en `true` **después** del
  `await RNBackgroundActions.start()`; si la tarea headless arranca antes, el `while` sale de
  inmediato y **no captura ni un punto**.
- No hay logs intermedios: no se sabe si `Geolocation.getCurrentPosition` responde o expira
  (timeout 20 s), ni si `registrarUbicacion` escribe en Realm.
- La primera captura espera el intervalo completo (~30 s) antes del primer fix.
- Los errores de `BackgroundActions.start()` se silencian con `console.error` (se pierde la causa real).

## Fixes

### Fix 1 — Solicitar `POST_NOTIFICATIONS` (Android 13+)
- Agregar en `services/LocationService.ts` un método `requestNotificationPermission()`:
  - Si `Platform.OS !== 'android'` → `return 'granted'`.
  - Si `Platform.Version < 33` → `return 'granted'` (no requerido).
  - Si no → `PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS, {...})`.
- Llamarlo en `BackgroundLocationService.start()` **antes** de `BackgroundActions.start()`.

### Fix 2 — Loop GPS robusto + diagnóstico
En `services/BackgroundLocationService.ts`:
- Reemplazar la condición del loop por un flag interno propio, p. ej. `this.isTaskRunning`,
  puesto en `true` al inicio de `start()` y en `false` en `stop()`, para **garantizar la primera
  iteración** independientemente de `BackgroundActions.isRunning()`.
- Capturar el **primer fix inmediatamente** (antes del primer `sleep`).
- Añadir logs por paso: `tarea iniciada`, `permiso=…`, `fix lat/lng/accuracy | null (timeout)`,
  `punto guardado en Realm`.
- Propagar/loguear el error real de `BackgroundActions.start()` (no silenciarlo).

### Fix 3 — Verificación en dispositivo
```bash
android/gradlew -p android app:installDebug
pnpm exec react-native start
```
- Iniciar ruta → debe aparecer la notificación (con el permiso ya concedido).
- Observar logcat filtrando `BackgroundLocationService` y `GpsBitacoraService`:
  - confirmar tarea iniciada,
  - confirmar fix cada ~30 s,
  - confirmar escritura en `BitacoraGps` (`enviado=false`).
- Verificar que el sync sube los puntos y marca `enviado=true` sin borrar.
- Repetir con **pantalla apagada 5-10 min** (requisito principal).

## Archivos a modificar (Fase 6)
| Archivo | Acción |
|---|---|
| `services/LocationService.ts` | + `requestNotificationPermission()` (POST_NOTIFICATIONS, Android 13+) |
| `services/BackgroundLocationService.ts` | flag interno de loop, primer fix inmediato, logs, manejo de error real, llamada al permiso de notificación |

---

# FASE 7 — Duplicados en la bitácora de recorrido y cadencia real con pantalla apagada (2026-07-25)

> **Estado: IMPLEMENTADA (Fase 7.1). Ver `services/BackgroundLocationService.ts`,
> `services/GpsBitacoraService.ts`, `App.tsx`, `AndroidManifest.xml` y scripts SQL.**

## Síntoma reportado

`dbo.BitacoraValidacionUbicacionMovil` (SP `sp_MovilesBitacoraValidacionArrastreJSON`) recibe
filas repetidas de `motivo = recorrido_app`: mismo `idUsuario`, misma `fecha`, misma
`latitud/longitud`, misma `accuracy`.

## Evidencia recolectada (usuario 1013, 2026-07-24)

| fecha | filas | lotes (`COUNT(DISTINCT fechaRegistroServidor)`) |
|---|---|---|
| 18:42:04 | 7 | 1 |
| 18:53:49 / 18:53:52 | 2 / 4 | 1 |
| 19:04:10 | 2 | 1 |
| 19:22:12 / :13 / :14 | 3 / **19** / 11 | 1 |
| 19:30:07 / :08 / :09 | 6 / **18** / 5 | 1 |
| 19:37:20 / :21 / :22 | 4 / **21** / 3 | 1 |
| 19:50:05 / :06 | 12 / 14 | 1 |

Lecturas clave:

- **`lotes = 1` siempre** → cada grupo entró en **un solo POST / un solo `INSERT`**
  (`fechaRegistroServidor` con `GETDATE()` es constante dentro de una sentencia set-based).
  **No son reenvíos**: el JSON ya venía con N elementos repetidos.
- **Ráfagas de 2-3 segundos separadas por huecos de 7-18 minutos**, y
  `filas ≈ minutos_de_hueco ÷ 30 s`:
  - `19:04:10 → 19:22:12` = 18 min ≈ 36 slots → ráfaga de **33 filas**
  - `19:30:09 → 19:37:22` = 7.2 min ≈ 14 slots → ráfaga de **28 filas** (≈ 2 loops × 14)
  - `19:37:22 → 19:50:06` = 12.7 min ≈ 25 slots → ráfaga de **26 filas**
- `6767 de 6767` filas con `idLocal IS NULL` (antes de la corrección del SP).

## Causa raíz A (servidor) — mapeo de `idLocal` [CORREGIDO]

El SP desplegado declaraba en `OPENJSON ... WITH` la columna `idlocal`, pero el móvil envía la
propiedad **`id`** (`GpsBitacoraService.enviarValidacionesPendientes`). En `OPENJSON` con esquema
explícito el nombre de la columna se usa como **path JSON, y los paths JSON son case-sensitive**,
por lo que nunca hacía match → `idLocal` siempre `NULL`.

Forma robusta (independiente del nombre de columna):

```sql
-- dentro del WITH:
    fecha    DATETIME,
    idLocal  NVARCHAR(64) '$.id'
) j;
-- y en el SELECT: ..., j.fecha, j.idLocal
```

### Pendiente A.1 — el índice de idempotencia NO existe

`sys.indexes` sobre `BitacoraValidacionUbicacionMovil` sólo devuelve `PK__Bitacora__…`,
`IX_BitacoraValidacion_Usuario_Fecha`, `IX_BitacoraValidacion_Cliente` y
`IX_BitacoraValidacion_Motivo`. **Falta** el índice único filtrado, así que hoy `idLocal` se
guarda pero **no deduplica nada**:

```sql
CREATE UNIQUE NONCLUSTERED INDEX UX_BitacoraValidacion_IdLocal
    ON [dbo].[BitacoraValidacionUbicacionMovil] (idLocal)
    WITH (IGNORE_DUP_KEY = ON)
    WHERE idLocal IS NOT NULL;
```

### Pendiente A.2 — misma revisión en la tabla GPS

`registrarCapturaTracking` escribe `BitacoraGps` y `BitacoraValidacion` en la **misma
transacción**, así que la duplicación aparece en ambas. Revisar el mapeo `'$.id'` y el índice
único en `sp_MovilesBitacoraGpsArrastreJSON` / `BitacoraGpsMovil`.

### Límite importante de `idLocal`

`idLocal` **sólo protege contra reenvíos** (mismo registro enviado dos veces). **No arregla las
ráfagas**: cada fila de la ráfaga es un registro distinto de Realm con `id` distinto
(`Date.now()-random`), y el índice único las aceptaría todas.

## Causa raíz B (cliente) — la ráfaga: compensación de deriva sin tope

```ts
// services/BackgroundLocationService.ts (bucle actual)
let nextFire = Date.now();
do {
  await this.captureOnce();
  if (!this.isTaskRunning) break;
  nextFire += this.intervalMs;                          // <-- recupera TODOS los slots perdidos
  const remaining = Math.max(0, nextFire - Date.now()); // <-- queda en 0 tras una suspensión
  if (remaining > 0) await sleep(remaining);
} while (this.isTaskRunning);
```

Si el proceso estuvo suspendido 10 minutos, `nextFire` quedó 10 minutos **en el pasado**:
`remaining = 0` en cada iteración y el bucle **dispara de golpe todos los slots perdidos**, sin
dormir, hasta alcanzar el reloj. Cada iteración escribe una fila con el **mismo fix cacheado**
(mismas coordenadas y `accuracy`, `fecha` = instante del despertar). Eso produce exactamente las
ráfagas de 19-21 filas por segundo observadas.

### Por qué se suspende el bucle

- `react-native-background-actions` **no adquiere WakeLock** (verificado: no hay `PowerManager`
  ni `WakeLock` en `node_modules/react-native-background-actions/android/src/main/java/...`).
- `setTimeout` en React Native es `Handler.postDelayed`, que **no despierta la CPU**. Con
  pantalla apagada el timer no corre; se libera cuando el dispositivo despierta.
- El foreground service mantiene el **proceso vivo** (y el acceso legal a FGS `location`),
  pero **no garantiza que los timers JS corran**.

### Causa secundaria — múltiples loops concurrentes

El factor ×2 en algunas ráfagas se explica por loops simultáneos:

- `BackgroundActions.start()` **no tiene guardia**: incrementa `_runnedTasks`, registra un
  headless task con **nombre nuevo** (`XallapanRuta1`, `XallapanRuta2`, …) y arranca el servicio
  (`src/index.js:78-91`) → pueden convivir N tareas.
- El servicio nativo usa `HeadlessJsTaskConfig(taskName, …, 0, true)` y `HeadlessJsTaskService`
  devuelve `START_REDELIVER_INTENT`: si Android mata y recrea el servicio, **re-ejecuta la tarea
  JS**; si el contexto JS sobrevivió, el loop viejo sigue vivo.
- `backgroundTask()` **no tiene guardia de reentrada**.
- `start()` tiene ventana de carrera: la guardia está en la línea 173 pero
  `isTaskRunning = true` se asigna en la 216, después de 3 `await` (Realm + 2 permisos).
- `stop()` pone `isTaskRunning = false`, pero un loop dormido en `sleep(30s)` **resucita** si
  `start()` ocurre antes de que despierte. El `stop()` de la librería sólo resuelve `_stopTask`,
  no aborta la tarea del usuario.
- Disparadores: `verificarRuta` cada 60 s en `App.tsx:468-496` (health check basado en
  `BackgroundActions.isRunning()`, que es **sólo un flag JS**), `handleIniciarRuta` en
  `MapaClientesScreen`, `TraspasoRecepcionScreen` y `RouteTrackingService.iniciarRuta`.

## Respuesta a "¿sirve la bitácora GPS en segundo plano / pantalla apagada?"

- **El proceso sí sobrevive** (foreground service) y **se registran puntos**, pero la **cadencia
  de 30 s no se cumple con pantalla apagada**: hay huecos reales de 7-18 minutos sin cobertura y
  luego una ráfaga de 20-30 puntos falsos (el mismo fix repetido, con la hora del despertar).
- Es decir: hoy la funcionalidad **no es confiable para auditar recorrido**, pero **el problema
  es de implementación, no una limitación de Android**. Se corrige con la Fase 7.1.

## FASE 7.1 — Reloj nativo en vez de timer JS (recomendada, sin código nativo nuevo)

Dejar de usar `setTimeout` como reloj y suscribirse a las actualizaciones del
`FusedLocationProviderClient`, que **es quien despierta la CPU** para entregar cada fix:

- `services/BackgroundLocationService.ts`:
  - Usar `Geolocation.watchPosition(onFix, onError, { enableHighAccuracy: true, interval: 30000, fastestInterval: 30000, distanceFilter: 0, forceRequestLocation: true, showLocationDialog: false })`.
    La API expone `interval` / `fastestInterval` (`react-native-geolocation-service/index.d.ts:39-40`)
    y el patch local ya construye el `LocationRequest` con
    `setMinUpdateIntervalMillis` (`patches/react-native-geolocation-service+5.3.1.patch`).
  - `onFix` hace lo que hoy hace `captureOnce()` (NetInfo + motivo + `registrarCapturaTracking`).
  - El bucle del foreground service queda **sólo como watchdog** (cada 2-5 min: si no llegó
    ningún fix desde el último chequeo, `clearWatch` + re-suscribir y actualizar la notificación).
  - `stop()` debe hacer `clearWatch` además de `BackgroundActions.stop()`.
- **Tope de deriva** (aplica también si se conserva el bucle): nunca recuperar slots perdidos →
  `nextFire = Math.max(nextFire + this.intervalMs, Date.now() + this.intervalMs)`.
- **Guardia de loop único**: token de generación (`this.generation`) capturado al entrar a
  `backgroundTask()`, verificado en cada iteración, incrementado en `stop()`; y marcar
  `isTaskRunning` **antes** del primer `await` de `start()` reusando una `startPromise` en vuelo.
- **Idempotencia extremo a extremo**: en `GpsBitacoraService.registrarCapturaTracking`, usar id
  determinista por ventana de tiempo, p. ej.
  `id = ${idUsuario}-${Math.floor(ts / intervalMs)}` con `Realm.UpdateMode.Modified`.
  Así, aunque haya 2 loops o 2 callbacks en la misma ventana, se colapsa a **una fila**; y con
  `UX_..._IdLocal` el servidor también deduplica.
- **Exclusión de optimización de batería**: en Doze profundo el fused provider puede **diferir**
  los updates. Solicitar `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` y documentar el ajuste manual en
  Xiaomi / Huawei / Samsung.
- **Un solo emisor de envíos**: `enviandoGps` / `enviandoValidaciones` / `enviandoTiempos` son
  locks **por instancia de módulo**; el headless de `react-native-background-fetch`
  (`index.js:21-34`) corre en **otro contexto JS** con sus propios locks. Mover el lock a Realm
  (`SyncLock` con dueño + expiración) o no enviar bitácoras desde el headless si el foreground
  service de ruta está activo.

## FASE 7.2 (opcional) — Servicio nativo Kotlin

Si se requiere sobrevivir a **app cerrada por swipe** o garantía dura de 30 s: retomar la
**Fase 5** de este documento (ForegroundService propio + `FusedLocationProviderClient`, con
`AlarmManager.setExactAndAllowWhileIdle` como respaldo). Alternativa "bruta" sin Kotlin:
WakeLock parcial mientras la ruta está activa (mayor consumo de batería).

## Limpieza del histórico

```sql
;WITH d AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY idUsuario, motivo, fecha, latitud, longitud
               ORDER BY id
           ) AS rn
    FROM [dbo].[BitacoraValidacionUbicacionMovil]
    WHERE motivo LIKE 'recorrido%'
)
DELETE FROM d WHERE rn > 1;
```

> Particionar por datos, **no** por `idLocal` (el histórico lo tiene `NULL`).
> Aplicar el equivalente en la tabla GPS.

## Verificación

Consulta de control (debe quedar sin resultados):

```sql
SELECT idUsuario, fecha, COUNT(*) filas, COUNT(DISTINCT fechaRegistroServidor) lotes
FROM dbo.BitacoraValidacionUbicacionMovil
WHERE fecha >= CAST(GETDATE() AS DATE) AND motivo LIKE 'recorrido%'
GROUP BY idUsuario, fecha HAVING COUNT(*) > 1;
```

Checklist en dispositivo físico:

- [ ] Logcat 10 min con **pantalla apagada**: 1 captura cada ~30 s, un solo `loopId`.
- [ ] Sin huecos > 2 min ni ráfagas en `fecha` (comparar `fecha` consecutivas).
- [ ] Realm: `BitacoraValidacion` con `motivo LIKE 'recorrido%'` ≈ 2 filas/minuto.
- [ ] Matar el foreground service desde ajustes → al reiniciarse **no** quedan 2 loops.
- [ ] Cortar la red a mitad del POST → el servidor **no** duplica (índice `UX_..._IdLocal`).
- [ ] `idLocal` poblado en todas las filas nuevas.

## Archivos a modificar (Fase 7, cuando se implemente)

| Archivo | Acción |
|---|---|
| `services/BackgroundLocationService.ts` | `watchPosition` con `interval`, bucle como watchdog, tope de deriva, token de generación, `startPromise`, `clearWatch` en `stop()` |
| `services/GpsBitacoraService.ts` | id determinista por ventana + `UpdateMode.Modified`; lock de envío compartido |
| `App.tsx` | health check por **transición** de estado de ruta, no cada 60 s |
| `script_bitacora_validacion.sql` | reflejar `idLocal NVARCHAR(64) '$.id'` y el índice único |
| `script_bitacora_gps.sql` | misma revisión de mapeo `'$.id'` + índice único |
| SQL producción | crear `UX_BitacoraValidacion_IdLocal`, limpiar histórico |

---

# FASE 8 — Regresión: la validación de venta se quedó sin fixes (`sin_senal`) (2026-07-25)

## Síntoma

Tras la Fase 7.1, al validar ubicación para vender aparece *"Ubicación no disponible…"*.
En `BitacoraValidacionUbicacionMovil`: `motivo = sin_senal`, `numFixes = 0`,
`tiempoMs ≈ 10003` (presupuesto completo agotado sin una sola lectura), mientras el
recorrido (`recorrido_app`) sí registra puntos con buena precisión.

## Causa raíz

`react-native-geolocation-service` mantiene **una sola suscripción nativa** compartida:

- `js/Geolocation.native.js:42-45` → `watchPosition` solo llama a `RNFusedLocation.startObserving`
  **si `updatesEnabled` es false**; ese flag es global al módulo.
- `RNFusedLocationModule.startObserving` reutiliza el mismo `continuousLocationProvider`
  y `FusedLocationProvider.requestLocationUpdates` reemplaza el `LocationRequest` con el
  del **último** `startObserving`.

Con el tracking de ruta activo, `BackgroundLocationService.startWatch()` ya dejó el
`LocationRequest` en `interval = 30 s`. Cuando `LocationService.getBestLocation()` abre su
watch a 1 s, `updatesEnabled` ya es `true` → **no se re-emite `startObserving`** → la
validación hereda el intervalo de 30 s y sus 10 s de presupuesto terminan sin fixes.

Prueba en la bitácora: la fila `24384` (`fuera_de_rango`, `numFixes=1`) tiene **exactamente el
mismo `accuracy = 8.198`** que la fila `24385` de `recorrido_app` del mismo segundo: el único
fix que recibió la validación fue el tick del stream de 30 s del recorrido.

## Fix implementado

- `services/LocationService.ts`:
  - `forzarIntervaloNativo(opciones)`: tras `watchPosition`, llama directo a
    `NativeModules.RNFusedLocation.startObserving(opciones)` para imponer `interval=1000 /
    fastestInterval=500` sobre la suscripción compartida.
  - `setWatchRestoreHandler(handler)` + `restaurarWatchDeFondo()`: al cerrar la lectura
    (`aceptar()`), devuelve el GPS al intervalo del recorrido.
- `services/BackgroundLocationService.ts`:
  - Registra el handler de restauración en `start()` (re-suscribe su watch a `intervalMs`) y
    lo limpia en `stop()`.
  - `onLocationFix` ignora los fixes de la ráfaga de 1 s (`lastCaptureAt`, umbral
    `intervalMs * 0.8`) para no escribir en Realm varias veces por segundo; `lastFixAt` sigue
    marcando actividad para el watchdog.

## Verificación en dispositivo

- Con la ruta activa, validar un cliente: la bitácora debe mostrar `numFixes ≥ 3` y
  `tiempoMs < 10000`, con `motivo = ok` / `fuera_de_rango` (ya no `sin_senal`).
- Tras la validación, logcat debe mostrar `watchPosition suscrito (… intervalo=30000ms)`.
- El recorrido debe mantener ~2 filas/minuto (sin ráfagas durante la validación).
