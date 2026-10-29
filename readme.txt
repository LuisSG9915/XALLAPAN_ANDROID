************************************************
cd android
./gradlew.bat assembleRelease
C:\Users\Administrador\.xallapan\android-build\outputs\apk\release\
************************************************


ABRIMOS EL EMULADOR

%LOCALAPPDATA%\Android\Sdk\emulator\emulator.exe -avd Pixel_9a -no-snapshot-load
AQUI ESTA LA RUTA DE LA APP
C:\Users\Administrador\.xallapan\android-build\outputs\apk\release\app-release.apk


Para probar:

Set-Location c:\xallapan
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
cd android
.\gradlew.bat app:installDebug

Set-Location c:\xallapan
pnpm exec react-native start

************************************************


Feedback submitted






--REINICIO / CLEAN--

cd android
./gradlew clean
cd ..


---RELEASE----
adb uninstall com.awesomeproject

cd android
./gradlew assembleRelease
cd ..

open "/Users/luis/Documents/desarrollo/XALLAPAN_ANDROID/android/app/build/outputs/apk/release"


adb shell pm enable com.awesomeproject

************************************************
PUBLICAR VERSION NUEVA (GitHub Releases)

Sin setup: usa la credencial de GitHub que ya tiene git guardada.

Cada release:
  1. Subir versionCode/versionName en android/app/build.gradle
  2. release-apk.bat "notas del release"   (notas opcionales)

El script compila, genera update.json (sha256/tamano/flags) y crea
o actualiza el release v{versionName}+{versionCode} con el APK.
La app lo detecta sola al abrirse o en su sondeo de 15 minutos.

Para que una version NO obligue actualizar al entrar, editar el
release en GitHub y cambiar en update.json: "obligatoria":false
************************************************