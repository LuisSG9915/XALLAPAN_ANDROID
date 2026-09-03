package com.awesomeproject

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

class AppUpdateModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "AppUpdateModule"

    @ReactMethod
    fun canRequestPackageInstalls(promise: Promise) {
        try {
            val allowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
                reactContext.packageManager.canRequestPackageInstalls()
            promise.resolve(allowed)
        } catch (error: Exception) {
            promise.reject("UPDATE_PERMISSION_CHECK_FAILED", error.message, error)
        }
    }

    @ReactMethod
    fun openInstallSettings(promise: Promise) {
        try {
            val intent = Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${reactContext.packageName}"),
            ).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactContext.startActivity(intent)
            promise.resolve(null)
        } catch (error: Exception) {
            promise.reject("UPDATE_SETTINGS_FAILED", error.message, error)
        }
    }

    @ReactMethod
    fun installApk(path: String, promise: Promise) {
        try {
            val file = File(path).canonicalFile
            val updatesDirectory = File(reactContext.filesDir, "updates").canonicalFile
            val cacheUpdatesDirectory = File(reactContext.cacheDir, "updates").canonicalFile
            val inPrivateDirectory = file.path.startsWith("${updatesDirectory.path}${File.separator}") ||
                file.path.startsWith("${cacheUpdatesDirectory.path}${File.separator}")

            if (!inPrivateDirectory || !file.isFile) {
                promise.reject("UPDATE_FILE_INVALID", "El APK no está en un directorio privado válido.")
                return
            }

            val uri = FileProvider.getUriForFile(
                reactContext,
                "${reactContext.packageName}.fileprovider",
                file,
            )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            }
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (error: Exception) {
            promise.reject("UPDATE_INSTALL_FAILED", error.message, error)
        }
    }
}
