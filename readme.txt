************************************************
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
cd..



adb shell pm enable com.awesomeproject