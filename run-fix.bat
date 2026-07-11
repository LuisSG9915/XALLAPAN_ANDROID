@echo off
setlocal
cd /d "%~dp0"

REM Reinstalar dependencias (postinstall aplicara el parche)
echo Reinstalando dependencias...
pnpm install
if errorlevel 1 goto :err

REM Aplicar parche manualmente por si postinstall no se ejecuto
echo Aplicando parche...
node apply-patch.js
if errorlevel 1 goto :err

REM Limpiar cachés Gradle/CMake corruptos
echo Limpiando cachés...
node clean-build-cache.js
if errorlevel 1 goto :err

REM Compilar APK
cd /d "%~dp0\android"
echo Deteniendo daemon...
gradlew.bat --stop

echo Compilando APK...
gradlew.bat app:assembleDebug
if errorlevel 1 goto :err

echo.
echo Build OK. Si quieres instalar en el dispositivo/emulador corre:
echo   cd android ^&^& gradlew.bat app:installDebug
pause
goto :eof

:err
echo.
echo Error en el paso anterior. Revisa los mensajes arriba.
pause
