@echo off
setlocal

:: Variables
set PACKAGE_NAME=com.awesomeproject
set SERVICE_NAME=com.asterinet.react.bgactions.RNBackgroundActionsTask
set LOG_TAG=BackgroundSync

echo ========================================================
echo   XALLAPAN ANDROID - BACKGROUND SYNC TEST UTILITY
echo ========================================================
echo.
echo This script helps verify that the Background Sync Service
echo continues to run even when the app is in the background
echo or the screen is off.
echo.

:: 1. Check for ADB
where adb >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] ADB is not found in your PATH. Please install Android SDK Platform Tools.
    goto :End
)

:: 2. Check Device Connection
echo [1/4] Checking connected devices...
adb devices
echo.

:: 3. Check Service Status
echo [2/4] Checking Service Status...
echo Looking for active service: %SERVICE_NAME%
adb shell dumpsys activity services %PACKAGE_NAME% | findstr "%SERVICE_NAME%" >nul
if %ERRORLEVEL% equ 0 (
    echo [OK] Service is currently RUNNING.
) else (
    echo [WARNING] Service is NOT DETECTED.
    echo Please open the app and ensure "Sincronizacion Automatica" is ENABLED.
)

:: 4. Instructions
echo.
echo [3/4] Test Instructions:
echo  a) Ensure the app is open and Sync is enabled.
echo  b) Press the "Home" button to put the app in background.
echo  c) (Optional) Lock the screen.
echo  d) Watch the logs below for "[BackgroundSync]" activity.
echo.
echo     You should see: "Iniciando Sync Periodica", "Sync exitosa", or "Entrando en espera".
echo.
echo  e) To test Watchdog (Background Fetch) manually:
echo     adb shell cmd jobscheduler run -f com.awesomeproject 999
echo.

:: 5. Monitor Logs
echo [4/4] Monitoring Logs (Press Ctrl+C to stop)...
echo.

:: Clear previous logs to avoid confusion
adb logcat -c

:: Filter for our specific tags (ReactNativeJS contains the console.logs)
:: We use *:S to silence everything else, and then enable specific tags
adb logcat -v time "*:S" "ReactNativeJS:V" "BackgroundWatchdog:V" "BootUpReceiver:V" "BatteryOptimization:V"

:End
endlocal
