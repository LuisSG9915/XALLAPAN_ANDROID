--REINICIO--

cd android
./gradlew clean
cd ..


---RUN----
adb uninstall com.awesomeproject
pnpm android


cd android
./gradlew assembleRelease
cd..



adb shell pm enable com.awesomeproject