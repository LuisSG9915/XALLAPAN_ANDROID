const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'node_modules', 'react-native-geolocation-service', 'android', 'src', 'main', 'java', 'com', 'agontuk', 'RNFusedLocation', 'FusedLocationProvider.java');

if (!fs.existsSync(file)) {
  console.error('FusedLocationProvider.java no encontrado:', file);
  process.exit(1);
}

let src = fs.readFileSync(file, 'utf8');

let replaced = 0;

if (src.includes('import com.google.android.gms.location.Priority;')) {
  console.log('El parche de geolocalización ya parece estar aplicado.');
} else {

// 1. Agregar import de Priority
const importOld = 'import com.google.android.gms.location.LocationCallback;\nimport com.google.android.gms.location.LocationRequest;';
const importNew = 'import com.google.android.gms.location.LocationCallback;\nimport com.google.android.gms.location.Priority;\nimport com.google.android.gms.location.LocationRequest;';
if (src.includes(importOld)) {
  src = src.replace(importOld, importNew);
  replaced++;
} else {
  console.error('No se encontró el bloque de imports esperado.');
  process.exit(1);
}

// 2. Reemplazar construcción de LocationRequest para play-services-location 21+
const buildOld = `  private LocationRequest buildLocationRequest(LocationOptions options) {
    LocationRequest locationRequest = new LocationRequest();
    int priority = getLocationPriority(options.getAccuracy());

    locationRequest.setPriority(priority)
      .setInterval(options.getInterval())
      .setFastestInterval(options.getFastestInterval())
      .setSmallestDisplacement(isSingleUpdate ? 0 : options.getDistanceFilter());

    return locationRequest;
  }`;

const buildNew = `  private LocationRequest buildLocationRequest(LocationOptions options) {
    int priority = getLocationPriority(options.getAccuracy());

    LocationRequest locationRequest = new LocationRequest.Builder(options.getInterval())
      .setPriority(priority)
      .setMinUpdateIntervalMillis(options.getFastestInterval())
      .setMinUpdateDistanceMeters(isSingleUpdate ? 0 : options.getDistanceFilter())
      .build();

    return locationRequest;
  }`;

if (src.includes(buildOld)) {
  src = src.replace(buildOld, buildNew);
  replaced++;
} else {
  console.error('No se encontró el método buildLocationRequest esperado.');
  process.exit(1);
}

// 3. Reemplazar constantes de prioridad
const priorityOld = `      case high:
        return LocationRequest.PRIORITY_HIGH_ACCURACY;
      case balanced:
        return LocationRequest.PRIORITY_BALANCED_POWER_ACCURACY;
      case low:
        return LocationRequest.PRIORITY_LOW_POWER;
      case passive:
        return LocationRequest.PRIORITY_NO_POWER;`;

const priorityNew = `      case high:
        return Priority.PRIORITY_HIGH_ACCURACY;
      case balanced:
        return Priority.PRIORITY_BALANCED_POWER_ACCURACY;
      case low:
        return Priority.PRIORITY_LOW_POWER;
      case passive:
        return Priority.PRIORITY_PASSIVE;`;

if (src.includes(priorityOld)) {
  src = src.replace(priorityOld, priorityNew);
  replaced++;
} else {
  console.error('No se encontró el método getLocationPriority esperado.');
  process.exit(1);
}

fs.writeFileSync(file, src, 'utf8');
console.log('Parche de geolocalización aplicado correctamente en', file);
}

// --- Parche para react-native-bluetooth-escpos-printer ---
const bluetoothBuildGradle = path.join(__dirname, 'node_modules', 'react-native-bluetooth-escpos-printer', 'android', 'build.gradle');
const bluetoothJavaFile = path.join(__dirname, 'node_modules', 'react-native-bluetooth-escpos-printer', 'android', 'src', 'main', 'java', 'cn', 'jystudio', 'bluetooth', 'RNBluetoothManagerModule.java');

if (fs.existsSync(bluetoothBuildGradle)) {
  let gradle = fs.readFileSync(bluetoothBuildGradle, 'utf8');
  if (gradle.includes('jcenter')) {
    const newGradle = `buildscript {
    repositories {
        google()
        mavenCentral()
        maven {
            // All of React Native (JS, Obj-C sources, Android binaries) is installed from npm
            url "$rootDir/../node_modules/react-native/android"
        }
    }

    dependencies {
        classpath 'com.android.tools.build:gradle:7.2.1'
    }
}

apply plugin: 'com.android.library'

android {
    compileSdkVersion 33

    defaultConfig {
        minSdkVersion 21
        targetSdkVersion 33
        versionCode 1
        versionName "1.0"
    }
    lintOptions {
        abortOnError false
    }
    sourceSets {
        main {
            aidl.srcDirs = ['src/main/java']
        }
    }
}

repositories {
    google()
    mavenCentral()
    maven {
        // All of React Native (JS, Obj-C sources, Android binaries) is installed from npm
        url "$rootDir/../node_modules/react-native/android"
    }
}

dependencies {
    implementation fileTree(dir: 'libs', include: ['*.jar'])
    implementation 'com.facebook.react:react-native:+'  // From node_modules
    implementation "com.google.zxing:core:3.3.0"
    implementation 'androidx.core:core:1.9.0'
}
`;
    fs.writeFileSync(bluetoothBuildGradle, newGradle, 'utf8');
    console.log('Parche de bluetooth aplicado correctamente en', bluetoothBuildGradle);
  } else {
    console.log('El build.gradle de bluetooth ya parece estar parcheado.');
  }
}

if (fs.existsSync(bluetoothJavaFile)) {
  let javaSrc = fs.readFileSync(bluetoothJavaFile, 'utf8');
  if (javaSrc.includes('android.support.v4')) {
    javaSrc = javaSrc.replace('import android.support.v4.app.ActivityCompat;', 'import androidx.core.app.ActivityCompat;');
    javaSrc = javaSrc.replace('import android.support.v4.content.ContextCompat;', 'import androidx.core.content.ContextCompat;');
    fs.writeFileSync(bluetoothJavaFile, javaSrc, 'utf8');
    console.log('Parche de bluetooth aplicado correctamente en', bluetoothJavaFile);
  } else {
    console.log('El archivo Java de bluetooth ya parece estar parcheado.');
  }
}

const gradlePluginSettings = path.join(__dirname, 'node_modules', '@react-native', 'gradle-plugin', 'settings.gradle.kts');
if (fs.existsSync(gradlePluginSettings)) {
  let settingsSrc = fs.readFileSync(gradlePluginSettings, 'utf8');
  if (!settingsSrc.includes('/.xallapan/react-native-gradle-plugin/')) {
    settingsSrc = settingsSrc.replace(
      'plugins { id("org.gradle.toolchains.foojay-resolver-convention").version("0.5.0") }',
      'plugins { id("org.gradle.toolchains.foojay-resolver-convention").version("0.5.0") }\n\ngradle.beforeProject {\n  layout.buildDirectory.set(file("${System.getProperty("user.home")}/.xallapan/react-native-gradle-plugin/${project.name}"))\n}'
    );
    fs.writeFileSync(gradlePluginSettings, settingsSrc, 'utf8');
    console.log('Parche del plugin de Gradle aplicado correctamente.');
  } else {
    console.log('El parche del plugin de Gradle ya está aplicado.');
  }
}

const codegenFile = path.join(__dirname, 'node_modules', '@react-native', 'codegen', 'lib', 'cli', 'combine', 'combine-js-to-schema.js');
if (fs.existsSync(codegenFile)) {
  let codegenSrc = fs.readFileSync(codegenFile, 'utf8');
  if (codegenSrc.includes('mkdirpSync(outDir)')) {
    codegenSrc = codegenSrc.replace(
      /const outDir = path\.dirname\(outfile\);\n  const mkdirpSync = \(dir\) => \{[\s\S]*?\n  \};\n  mkdirpSync\(outDir\);/,
      'const outDir = path.dirname(outfile);\n  fs.mkdirSync(outDir, { recursive: true });'
    );
    fs.writeFileSync(codegenFile, codegenSrc, 'utf8');
    console.log('Parche de codegen actualizado para usar mkdir recursivo seguro.');
  } else if (codegenSrc.includes('fs.mkdirSync(outDir, { recursive: true })')) {
    console.log('El parche de codegen ya está aplicado.');
  } else {
    codegenSrc = codegenSrc.replace(
      "const formattedSchema = JSON.stringify(combined);\n  fs.writeFileSync(outfile, formattedSchema);",
      "const formattedSchema = JSON.stringify(combined);\n  const outDir = path.dirname(outfile);\n  fs.mkdirSync(outDir, { recursive: true });\n  fs.writeFileSync(outfile, formattedSchema);"
    );
    fs.writeFileSync(codegenFile, codegenSrc, 'utf8');
    console.log('Parche de codegen aplicado correctamente en', codegenFile);
  }
}

// --- Parche para react-native-background-actions ---
const backgroundActionsTask = path.join(
  __dirname,
  'node_modules',
  'react-native-background-actions',
  'android',
  'src',
  'main',
  'java',
  'com',
  'asterinet',
  'react',
  'bgactions',
  'RNBackgroundActionsTask.java',
);

if (fs.existsSync(backgroundActionsTask)) {
  let backgroundActionsSrc = fs.readFileSync(backgroundActionsTask, 'utf8');
  let backgroundActionsChanged = false;

  if (backgroundActionsSrc.includes('RN_BACKGROUND_ACTIONS_CHANNEL"')) {
    backgroundActionsSrc = backgroundActionsSrc.replace(
      'RN_BACKGROUND_ACTIONS_CHANNEL"',
      'RN_BACKGROUND_ACTIONS_CHANNEL_V2"',
    );
    backgroundActionsChanged = true;
  }

  if (backgroundActionsSrc.includes('NotificationCompat.PRIORITY_MIN')) {
    backgroundActionsSrc = backgroundActionsSrc.replace(
      'NotificationCompat.PRIORITY_MIN',
      'NotificationCompat.PRIORITY_DEFAULT',
    );
    backgroundActionsChanged = true;
  }

  const lowImportanceChannel = `            final int importance = NotificationManager.IMPORTANCE_LOW;
            final NotificationChannel channel = new NotificationChannel(CHANNEL_ID, taskTitle, importance);
            channel.setDescription(taskDesc);`;
  const silentNormalChannel = `            final int importance = NotificationManager.IMPORTANCE_DEFAULT;
            final NotificationChannel channel = new NotificationChannel(CHANNEL_ID, taskTitle, importance);
            channel.setDescription(taskDesc);
            channel.setSound(null, null);
            channel.enableVibration(false);`;

  if (backgroundActionsSrc.includes(lowImportanceChannel)) {
    backgroundActionsSrc = backgroundActionsSrc.replace(lowImportanceChannel, silentNormalChannel);
    backgroundActionsChanged = true;
  }

  if (backgroundActionsChanged) {
    fs.writeFileSync(backgroundActionsTask, backgroundActionsSrc, 'utf8');
    console.log('Parche de visibilidad GPS aplicado correctamente en', backgroundActionsTask);
  } else if (
    backgroundActionsSrc.includes('RN_BACKGROUND_ACTIONS_CHANNEL_V2') &&
    backgroundActionsSrc.includes('NotificationCompat.PRIORITY_DEFAULT') &&
    backgroundActionsSrc.includes('channel.setSound(null, null)')
  ) {
    console.log('El parche de visibilidad GPS ya parece estar aplicado.');
  } else {
    console.error('No se encontró el código esperado de react-native-background-actions.');
    process.exit(1);
  }
}

console.log('postinstall completado.');
