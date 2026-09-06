package de.monsterdeals.location

import android.annotation.SuppressLint
import android.content.Context
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

data class LatLon(val lat: Double, val lon: Double)

class LocationProvider(context: Context) {

    private val client = LocationServices.getFusedLocationProviderClient(context)

    /** Ruft die aktuelle Position ab. Permission muss vorher erteilt sein. */
    @SuppressLint("MissingPermission")
    suspend fun current(): LatLon? = suspendCancellableCoroutine { cont ->
        val cts = CancellationTokenSource()
        client.getCurrentLocation(Priority.PRIORITY_BALANCED_POWER_ACCURACY, cts.token)
            .addOnSuccessListener { loc ->
                cont.resume(loc?.let { LatLon(it.latitude, it.longitude) })
            }
            .addOnFailureListener { cont.resume(null) }
        cont.invokeOnCancellation { cts.cancel() }
    }
}
