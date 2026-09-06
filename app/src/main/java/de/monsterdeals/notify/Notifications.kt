package de.monsterdeals.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import de.monsterdeals.data.Offer

object Notifications {

    private const val CHANNEL_ID = "deals"

    fun createChannel(context: Context) {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Angebote in der Naehe",
            NotificationManager.IMPORTANCE_DEFAULT
        ).apply { description = "Meldung, wenn ein guenstiges Angebot in der Naehe ist" }
        context.getSystemService(NotificationManager::class.java)
            .createNotificationChannel(channel)
    }

    /** Aufrufen, wenn ein neues Angebot unter dem Wunschpreis gefunden wurde. */
    fun showDeal(context: Context, offer: Offer, distanceKm: Double) {
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(String.format("%.2f EUR bei %s", offer.price, offer.storeName))
            .setContentText(String.format("%s - %.1f km entfernt", offer.product, distanceKm))
            .setAutoCancel(true)
            .build()

        try {
            NotificationManagerCompat.from(context).notify(offer.id.hashCode(), notification)
        } catch (e: SecurityException) {
            // Permission fehlt - stillschweigend ignorieren
        }
    }
}
