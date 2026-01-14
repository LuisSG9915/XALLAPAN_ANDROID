package com.awesomeproject

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class BootUpReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        Log.d("BootUpReceiver", "Received action: $action")

        if (Intent.ACTION_BOOT_COMPLETED == action || 
            "android.intent.action.QUICKBOOT_POWERON" == action ||
            "com.htc.intent.action.QUICKBOOT_POWERON" == action) {
            
            Log.d("BootUpReceiver", "Boot completed detected. Starting MainActivity...")

            try {
                // Start MainActivity directly to initialize React Native and the Background Sync
                val i = Intent(context, MainActivity::class.java)
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(i)
                Log.d("BootUpReceiver", "MainActivity start requested.")
            } catch (e: Exception) {
                Log.e("BootUpReceiver", "Error starting MainActivity: ${e.message}", e)
            }
        }
    }
}
