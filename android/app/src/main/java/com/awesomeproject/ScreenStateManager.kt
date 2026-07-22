package com.awesomeproject

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat

/**
 * Singleton que mantiene el estado actual de la pantalla del dispositivo.
 * Escucha SCREEN_ON, SCREEN_OFF y USER_PRESENT a través de un BroadcastReceiver
 * registrado al arrancar la aplicación.
 */
object ScreenStateManager {

    @JvmStatic
    var currentState: String = "on"
        private set

    private var receiver: BroadcastReceiver? = null

    @JvmStatic
    fun initialize(context: Context) {
        if (receiver != null) return

        receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) {
                when (intent?.action) {
                    Intent.ACTION_SCREEN_OFF -> currentState = "off"
                    Intent.ACTION_SCREEN_ON -> currentState = "on"
                    Intent.ACTION_USER_PRESENT -> currentState = "on"
                }
            }
        }

        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
        }

        ContextCompat.registerReceiver(
            context,
            receiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
    }
}
