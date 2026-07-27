package com.awesomeproject

import android.app.Application
import com.asterinet.react.bgactions.BackgroundActionsPackage
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          add(BackgroundActionsPackage())
          add(ScreenStatePackage())
          add(BatteryOptimizationPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    ScreenStateManager.initialize(applicationContext)
    loadReactNative(this)
  }
}
