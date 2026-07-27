package com.awesomeproject

import android.content.Context
import android.os.PowerManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class WakeLockModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    private var wakeLock: PowerManager.WakeLock? = null

    override fun getName(): String = "WakeLockModule"

    @ReactMethod
    fun acquire(promise: Promise) {
        try {
            if (wakeLock?.isHeld == true) {
                promise.resolve(true)
                return
            }
            val powerManager = reactApplicationContext.getSystemService(
                Context.POWER_SERVICE
            ) as PowerManager
            wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "Xallapan::GPSWakeLock"
            )
            wakeLock?.acquire()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("WAKELOCK_ACQUIRE_ERROR", e.message)
        }
    }

    @ReactMethod
    fun release(promise: Promise) {
        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
            wakeLock = null
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("WAKELOCK_RELEASE_ERROR", e.message)
        }
    }

    @ReactMethod
    fun isHeld(promise: Promise) {
        try {
            promise.resolve(wakeLock?.isHeld == true)
        } catch (e: Exception) {
            promise.reject("WAKELOCK_CHECK_ERROR", e.message)
        }
    }
}
