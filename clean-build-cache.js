const fs = require('fs');
const path = require('path');

let hasErrors = false;

function win32LongPath(p) {
  const resolved = path.resolve(p);
  if (resolved.startsWith('\\\\?\\')) return resolved;
  return '\\\\?\\' + resolved;
}

function rm(p) {
  const long = win32LongPath(p);
  try {
    if (fs.existsSync(long)) {
      fs.rmSync(long, { recursive: true, force: true });
      console.log('Eliminado:', long);
    } else {
      console.log('No existe:', long);
    }
  } catch (e) {
    console.error('Error eliminando', long, ':', e.message);
    hasErrors = true;
  }
}

// Cachés globales de Gradle corruptas
rm(path.join(process.env.USERPROFILE, '.gradle', 'caches', '9.0.0', 'transforms'));
rm(path.join(process.env.USERPROFILE, '.gradle', 'caches', '9.0.0', 'files-2.1', 'com.google.android.gms'));
rm(path.join(process.env.USERPROFILE, '.gradle', 'caches', '9.0.0', 'files-2.1', 'com.transistorsoft'));

// Build dirs del proyecto
rm(path.join(__dirname, 'android', '.gradle'));
rm(path.join(__dirname, 'android', 'app', 'build'));
rm(path.join(__dirname, 'android', 'build'));

// Build dirs de librerías nativas que tienen CMakeLists viejos
const dirs = [
  'node_modules/@react-native-community/datetimepicker/android/build',
  'node_modules/react-native-background-geolocation/android/build',
  'node_modules/react-native-safe-area-context/android/build',
  'node_modules/react-native-screens/android/build',
  'node_modules/react-native-vector-icons/android/build',
  'node_modules/react-native-webview/android/build',
  'node_modules/realm/binding/android/build',
];

for (const d of dirs) {
  rm(path.join(__dirname, d));
}

if (hasErrors) {
  console.error('Limpieza terminada con errores.');
  process.exit(1);
}

console.log('Limpieza terminada. Ahora corre: cd android && .\\gradlew app:assembleDebug');
