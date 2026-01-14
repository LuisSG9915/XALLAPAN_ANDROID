package com.awesomeproject

import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise

class BatteryOptimizationModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String {
        return "BatteryOptimization"
    }

    @ReactMethod
    fun requestIgnoreBatteryOptimizations(promise: Promise) {
        try {
            val packageName = reactApplicationContext.packageName
            val pm = reactApplicationContext.getSystemService(android.content.Context.POWER_SERVICE) as PowerManager
            
            if (pm.isIgnoringBatteryOptimizations(packageName)) {
                promise.resolve("ALREADY_IGNORED")
                return
            }

            val intent = Intent()
            intent.action = Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
            intent.data = Uri.parse("package:$packageName")
            intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK
            reactApplicationContext.startActivity(intent)
            promise.resolve("REQUESTED")
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun checkOverlayPermission(promise: Promise) {
        try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                promise.resolve(Settings.canDrawOverlays(reactApplicationContext))
            } else {
                promise.resolve(true)
            }
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun requestOverlayPermission(promise: Promise) {
        try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                if (!Settings.canDrawOverlays(reactApplicationContext)) {
                    val intent = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + reactApplicationContext.packageName))
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    reactApplicationContext.startActivity(intent)
                    promise.resolve("REQUESTED")
                } else {
                    promise.resolve("GRANTED")
                }
            } else {
                promise.resolve("GRANTED")
            }
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }
}
