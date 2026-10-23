package com.awesomeproject

import android.content.Context
import android.os.PowerManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class WakeLockModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    private companion object {
        const val WAKE_LOCK_TAG = "Xallapan::GPSWakeLock"
    }

    private var wakeLock: PowerManager.WakeLock? = null

    override fun getName(): String = "WakeLockModule"

    /**
     * Adquiere un PARTIAL_WAKE_LOCK **sin timeout**: se sostiene mientras la ruta
     * esté abierta y se libera en release(). Si el proceso muere, Android lo
     * libera solo.
     *
     * Antes el lock vencía a los 30 min y se renovaba desde JS con un setInterval
     * de 25 min. Ese diseño fallaba justo en el escenario que debe cubrir: cuando
     * el sistema duerme el proceso (Doze / ahorro de energía) los timers de JS no
     * corren, la renovación no llegaba y el lock expiraba, permitiendo que el
     * dispositivo durmiera más profundo. En campo se ve como ráfagas con retraso
     * de subida de 15+ minutos.
     *
     * setReferenceCounted(false) deja release() idempotente: si el servicio se
     * reinicia y vuelve a llamar acquire(), un solo release() basta.
     */
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

            val nuevo = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                WAKE_LOCK_TAG
            )
            nuevo.setReferenceCounted(false)
            nuevo.acquire()
            wakeLock = nuevo

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
