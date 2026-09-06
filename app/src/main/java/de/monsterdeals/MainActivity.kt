package de.monsterdeals

import android.Manifest
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import de.monsterdeals.notify.Notifications
import de.monsterdeals.ui.OffersScreen
import de.monsterdeals.ui.OffersViewModel

class MainActivity : ComponentActivity() {

    private val vm: OffersViewModel by viewModels()

    /** Schritt 1: Standort. Schritt 2: Benachrichtigungen. */
    private val locationLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        val granted = result[Manifest.permission.ACCESS_FINE_LOCATION] == true ||
            result[Manifest.permission.ACCESS_COARSE_LOCATION] == true
        if (granted) {
            askNotificationPermission()
            vm.load()
        } else {
            vm.permissionDenied()
        }
    }

    private val notificationLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* Ablehnung ist unkritisch, App funktioniert trotzdem */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        Notifications.createChannel(this)

        setContent {
            MaterialTheme {
                val state by vm.state.collectAsStateWithLifecycle()
                OffersScreen(state = state, onRetry = { requestLocation() })
            }
        }

        requestLocation()
    }

    private fun requestLocation() {
        locationLauncher.launch(
            arrayOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            )
        )
    }

    private fun askNotificationPermission() {
        notificationLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
}
