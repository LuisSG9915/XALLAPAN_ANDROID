package com.awesomeproject

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class StallNotificationModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    private companion object {
        const val CHANNEL_ID = "alertas-varado-android-v1"
        const val NOTIFICATION_ID = 92902
    }

    override fun getName(): String = "StallNotificationModule"

    @ReactMethod
    fun show(nombre: String, minutos: Double, latitud: Double, longitud: Double, promise: Promise) {
        try {
            val notificationManager = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            ensureChannel(notificationManager)

            val launchIntent = reactContext.packageManager.getLaunchIntentForPackage(reactContext.packageName)
                ?: Intent().setPackage(reactContext.packageName)
            val contentIntent = PendingIntent.getActivity(
                reactContext,
                NOTIFICATION_ID,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

            val body = "$nombre lleva aproximadamente ${maxOf(1, minutos.toInt())} min sin movimiento."
            val notification = NotificationCompat.Builder(reactContext, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Alerta de recorrido")
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText("$body\nUbicación: $latitud, $longitud"))
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setDefaults(NotificationCompat.DEFAULT_ALL)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setShowWhen(true)
                .build()

            notificationManager.notify(NOTIFICATION_ID, notification)
            promise.resolve(true)
        } catch (error: Exception) {
            promise.reject("STALL_NOTIFICATION_SHOW_ERROR", error.message, error)
        }
    }

    @ReactMethod
    fun cancel(promise: Promise) {
        try {
            val notificationManager = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            notificationManager.cancel(NOTIFICATION_ID)
            promise.resolve(true)
        } catch (error: Exception) {
            promise.reject("STALL_NOTIFICATION_CANCEL_ERROR", error.message, error)
        }
    }

    private fun ensureChannel(notificationManager: NotificationManager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Alertas de recorrido",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Avisos de vendedor sin movimiento"
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 300, 200, 300)
            setSound(
                soundUri,
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .build(),
            )
        }
        notificationManager.createNotificationChannel(channel)
    }
}
