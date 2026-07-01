================================================================
 FLUJO DE DESARROLLO (Windows) - IMPORTANTE
================================================================
 NO usar "pnpm android" / "react-native run-android" en Windows.
 Arranca Metro + Gradle a la vez y se traban los archivos del
 build (Unable to delete / AccessDenied). Separar siempre:
   1) Gradle primero (sin Metro)
   2) Metro despues

--- CAMBIOS SOLO JS/TS (lo mas comun) ---
 No reconstruir. Con Metro corriendo, presiona "r" para recargar
 o reabre la app en el emulador.

--- CAMBIOS NATIVOS / versionCode (emulador ya abierto) ---
 pnpm run android:dev          (instala con Gradle y luego Metro)
   o por separado:
 pnpm run android:install      (solo compila e instala)
 pnpm run start                (solo Metro)

--- ABRIR LA APP EN EL EMULADOR ---
 adb shell monkey -p com.awesomeproject -c android.intent.category.LAUNCHER 1

--- SI FALLA POR LOCKS (Unable to delete / AccessDenied) ---
 pnpm run android:clean-locks  (para Gradle, mata node, borra incremental)
 pnpm run android:dev

================================================================

--REINICIO / CLEAN--

cd android
./gradlew clean
cd ..


---RELEASE----
adb uninstall com.awesomeproject

cd android
./gradlew assembleRelease
cd..



adb shell pm enable com.awesomeproject