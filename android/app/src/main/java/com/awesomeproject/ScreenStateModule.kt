package com.awesomeproject

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Módulo nativo que expone a JavaScript el estado actual de la pantalla
 * (encendida/apagada) mantenido por ScreenStateManager.
 */
class ScreenStateModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "ScreenStateModule"

    @ReactMethod
    fun getCurrentScreenState(promise: Promise) {
        promise.resolve(ScreenStateManager.currentState)
    }
}
