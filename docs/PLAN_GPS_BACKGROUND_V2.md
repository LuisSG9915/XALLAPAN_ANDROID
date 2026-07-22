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
