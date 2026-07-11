# Plan: Registro de bitácora GPS con pantalla apagada (Android)

> Objetivo: seguir registrando la bitácora GPS cada 30 segundos aunque la pantalla esté
> apagada, la app en segundo plano o cerrada (swipe). **Solo Android.** Debe quedar
> funcionalmente operativo.

**Librería elegida:** `react-native-background-geolocation` (transistorsoft).
Maneja Foreground Service, modo Doze, optimización de batería y filtrado de
movimiento de forma nativa y confiable.

---

## Contexto técnico del proyecto

- `minSdkVersion = 24`, `targetSdkVersion = 36`, `compileSdkVersion = 36` (`android/build.gradle`).
- React Native `0.82.1`, `kotlinVersion = 2.1.20`.
- Captura actual: `RouteTrackingService.captureRoutePoint()` disparada por `setInterval`
  en `scheduleCaptures()` → **se congela cuando el JS se suspende** (pantalla apagada / background).
- Persistencia local: `GpsBitacoraService.registrarUbicacion(lat, lng, precision?, conCobertura?)`
  escribe en la tabla Realm `BitacoraGps`.
- Envío al servidor: `GpsBitacoraService.enviarBitacorasPendientes()` (marca `enviado=true`, ya NO borra).
- `react-native-background-fetch@4.2.8` ya instalado (es peer dependency de la librería).

### Por qué el enfoque actual no sirve para background
Android suspende el motor de JavaScript al apagar la pantalla o mandar la app a
segundo plano, por lo que `setInterval` deja de ejecutarse. Para capturar GPS cada
30s en background es **obligatorio** un Foreground Service con notificación persistente
(Android 8+) y el permiso `ACCESS_BACKGROUND_LOCATION` (Android 10+).

---

## Consideraciones / Riesgos

- **Notificación persistente obligatoria:** Android mostrará una notificación fija
  ("Rastreando ubicación...") mientras la ruta esté activa. No se puede ocultar.
- **Permiso "Permitir todo el tiempo":** en Android 11+ el usuario debe concederlo
  manualmente desde Ajustes. Hay que guiarlo con un mensaje claro.
- **targetSdk 36:** requiere declarar `foregroundServiceType="location"` en el manifest
  y el permiso `FOREGROUND_SERVICE_LOCATION`.
- **Licencia:** la versión Android de transistorsoft compila libre en debug/release;
  revisar términos si el uso comercial es intensivo.
- **Pruebas en dispositivo físico:** los emuladores no simulan bien Doze; las pruebas
  reales de "pantalla apagada" y "app cerrada" deben hacerse en hardware real.
- **Fabricantes agresivos (Xiaomi, Huawei, Samsung):** pueden matar el servicio;
  documentar que el usuario debe deshabilitar la optimización de batería para la app.

---

## FASE 1 — Instalación y configuración nativa

### 1.1 Instalar dependencia
```powershell
Set-Location c:\xallapan
pnpm add react-native-background-geolocation
# react-native-background-fetch ya está instalado (peer)
```

### 1.2 `android/build.gradle` (nivel proyecto)
Agregar en `allprojects { repositories { ... } }`:
```gradle
maven { url("${project(':react-native-background-geolocation').projectDir}/libs") }
maven { url 'https://developer.huawei.com/repo/' }
```
Y en `buildscript.ext` verificar/añadir:
```gradle
googlePlayServicesLocationVersion = "21.3.0"
appCompatVersion = "1.7.0"
```

### 1.3 `android/app/build.gradle`
Al inicio del archivo (después de los `apply plugin`):
```gradle
Project background_geolocation = project(':react-native-background-geolocation')
apply from: "${background_geolocation.projectDir}/app.gradle"
```

### 1.4 `android/app/src/main/AndroidManifest.xml`
Añadir permisos (junto a los existentes):
```xml
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
```
> `ACCESS_FINE_LOCATION` y `ACCESS_COARSE_LOCATION` ya están presentes.
> `INTERNET` y `POST_NOTIFICATIONS` ya están presentes.

Dentro de `<application>` añadir la licencia (vacía para versión libre) si la librería
lo solicita en el build:
```xml
<meta-data android:name="com.transistorsoft.locationmanager.license" android:value="" />
```

### 1.5 Build de verificación
```powershell
Set-Location c:\xallapan
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
android\gradlew.bat -p android app:assembleDebug
```
Confirmar que compila antes de continuar a la Fase 2.

---

## FASE 2 — Nuevo servicio `services/BackgroundLocationService.ts`

Crear un wrapper singleton de la API de la librería. Responsabilidades:

- `configure()`: llamar `BackgroundGeolocation.ready({...})` una sola vez.
  - `desiredAccuracy: DESIRED_ACCURACY_HIGH`
  - `distanceFilter: 0` (para forzar tiempo, no distancia)
  - `locationUpdateInterval: 30000` (30s)
  - `fastestLocationUpdateInterval: 30000`
  - `stopOnTerminate: false` (seguir tras cerrar la app)
  - `startOnBoot: true` (reanudar tras reinicio)
  - `enableHeadless: true`
  - `foregroundService: true`
  - `notification: { title: "Xallapan", text: "Registrando tu recorrido...", ... }`
  - `debug: false`, `logLevel: LOG_LEVEL_WARNING`
- `start()`: `BackgroundGeolocation.start()` — arranca el Foreground Service.
- `stop()`: `BackgroundGeolocation.stop()` — detiene el servicio.
- Listener `onLocation(location)` → reusar la persistencia existente:
  ```ts
  await GpsBitacoraService.registrarUbicacion(
    location.coords.latitude,
    location.coords.longitude,
    location.coords.accuracy,
    // conCobertura: se puede resolver con NetInfo dentro del listener
  );
  ```
- Listener `onMotionChange`, `onProviderChange` para logging/diagnóstico.
- Registrar la tarea Headless (`BackgroundGeolocation.registerHeadlessTask`) en
  `index.js` para que los eventos se procesen con la app terminada.

> IMPORTANTE: dentro del Headless task el Realm debe estar inicializado. Verificar que
> `FullSyncService` (que hace `setRealm` a `GpsBitacoraService`) se ejecute también en el
> contexto headless, o abrir una instancia Realm dedicada de solo escritura en el task.

### 2.1 Registro Headless en `index.js`
```js
import BackgroundGeolocation from "react-native-background-geolocation";
import { HeadlessLocationTask } from "./services/BackgroundLocationService";
BackgroundGeolocation.registerHeadlessTask(HeadlessLocationTask);
```

---

## FASE 3 — Integrar con `RouteTrackingService`

Archivo: `services/RouteTrackingService.ts`

- En `iniciarRuta()`:
  - Sustituir `this.scheduleCaptures()` por `await BackgroundLocationService.start()`.
  - Conservar la captura inmediata del primer punto (`captureRoutePoint()`).
- En `finalizarRuta()`:
  - Sustituir/añadir `await BackgroundLocationService.stop()` antes de `clearTimer()`.
- Eliminar (o dejar como fallback en foreground) `scheduleCaptures()` y `timerId`.
- Mantener intacto el envío por lotes (`enviarBitacorasPendientes`) y la política de
  NO borrado de la bitácora (ya implementada).

> El flujo de persistencia queda unificado: tanto foreground como background escriben
> vía `GpsBitacoraService.registrarUbicacion()`.

---

## FASE 4 — Permisos y arranque en boot

- Solicitud escalonada de permisos (usar el flujo nativo de la librería
  `BackgroundGeolocation.requestPermission()`):
  1. `ACCESS_FINE_LOCATION` (cuando se usa la app).
  2. Explicar al usuario y pedir `ACCESS_BACKGROUND_LOCATION` ("Permitir todo el tiempo").
  3. En Android 13+ pedir `POST_NOTIFICATIONS` (ya declarado).
- Mensaje/diálogo previo explicando por qué se necesita ubicación en segundo plano.
- `startOnBoot: true` + permiso `RECEIVE_BOOT_COMPLETED` reanudan el tracking tras
  reinicio si la ruta estaba activa. Verificar leyendo `RouteConfig.rutaActiva` al boot.
- Añadir guía para desactivar optimización de batería en fabricantes agresivos.

---

## FASE 5 — Pruebas funcionales (dispositivo físico)

Checklist:
- [ ] Iniciar ruta y verificar notificación persistente visible.
- [ ] App en segundo plano (Home) → se capturan puntos cada ~30s.
- [ ] Pantalla apagada 5–10 min → se siguen capturando puntos.
- [ ] App cerrada con swipe → sigue capturando (stopOnTerminate=false).
- [ ] Reinicio del teléfono con ruta activa → tracking se reanuda (startOnBoot).
- [ ] Los puntos se guardan en Realm (`BitacoraGps`) con `enviado=false`.
- [ ] `enviarBitacorasPendientes` marca `enviado=true` sin borrar registros.
- [ ] El recorrido se dibuja en `MapaClientesScreen` (polilínea + inicio/fin).
- [ ] Finalizar ruta detiene el servicio y desaparece la notificación.

Comandos de build/prueba:
```powershell
Set-Location c:\xallapan
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
android\gradlew.bat -p android app:installDebug
Set-Location c:\xallapan
pnpm exec react-native start
```

---

## Archivos a crear / modificar

| Archivo | Acción |
|---|---|
| `package.json` | + `react-native-background-geolocation` |
| `android/build.gradle` | + repos maven y versiones de Play Services |
| `android/app/build.gradle` | + apply `app.gradle` de la librería |
| `android/app/src/main/AndroidManifest.xml` | + permisos background/foreground service |
| `services/BackgroundLocationService.ts` | **NUEVO** wrapper + headless task |
| `index.js` | + registro de headless task |
| `services/RouteTrackingService.ts` | start/stop del servicio, quitar setInterval |
| `services/GpsBitacoraService.ts` | sin cambios (persistencia ya lista) |
| `docs/PLAN_GPS_BACKGROUND.md` | este documento |

---

## Orden de ejecución recomendado
1. Fase 1 completa + build de verificación.
2. Fase 2 (servicio + headless) + build.
3. Fase 3 (integración RouteTrackingService).
4. Fase 4 (permisos/boot).
5. Fase 5 (pruebas en físico).
