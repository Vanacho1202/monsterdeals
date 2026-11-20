package de.monsterdeals.work

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import de.monsterdeals.data.OfferRepository
import de.monsterdeals.notify.Notifications
import de.monsterdeals.prefs.LastLocation
import de.monsterdeals.prefs.NotifiedOffers

/**
 * Periodischer Hintergrund-Check (siehe WorkScheduler): fragt das Backend
 * für den zuletzt bekannten Standort ab und benachrichtigt nur über
 * Angebote, die seit dem letzten Check neu dazugekommen sind.
 */
class DealCheckWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {

    private val repo = OfferRepository()

    override suspend fun doWork(): Result {
        val here = LastLocation.get(applicationContext) ?: return Result.success()
        return try {
            val offers = repo.nearbyOffers(here.lat, here.lon)
            val alreadyNotified = NotifiedOffers.getAll(applicationContext)
            val newOffers = offers.filter { it.id !in alreadyNotified }

            for (offer in newOffers) {
                val distance = offer.distanceKm(here.lat, here.lon)
                Notifications.showDeal(applicationContext, offer, distance)
            }
            NotifiedOffers.addAll(applicationContext, offers.map { it.id })

            Result.success()
        } catch (e: Exception) {
            Result.retry()
        }
    }
}
