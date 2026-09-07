package de.monsterdeals.prefs

import android.content.Context
import de.monsterdeals.location.LatLon

private const val PREFS_NAME = "monsterdeals_prefs"

/**
 * Letzter bekannter Standort, gespeichert beim erfolgreichen Laden in der
 * App. Der Hintergrund-Check (DealCheckWorker) nutzt diesen zwischen-
 * gespeicherten Wert statt selbst eine Standortabfrage zu starten - dafuer
 * waere sonst die deutlich weitreichendere Berechtigung
 * ACCESS_BACKGROUND_LOCATION noetig. Die Benachrichtigung bezieht sich also
 * auf "in der Naehe von dort, wo die App zuletzt geoeffnet wurde".
 */
object LastLocation {
    fun save(context: Context, lat: Double, lon: Double) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
            .putFloat("lat", lat.toFloat())
            .putFloat("lon", lon.toFloat())
            .apply()
    }

    fun get(context: Context): LatLon? {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        if (!prefs.contains("lat") || !prefs.contains("lon")) return null
        return LatLon(
            prefs.getFloat("lat", 0f).toDouble(),
            prefs.getFloat("lon", 0f).toDouble()
        )
    }
}

/** Verhindert, dass derselbe Angebots-Fund bei jedem Hintergrund-Check erneut meldet wird. */
object NotifiedOffers {
    private const val KEY = "notified_offer_ids"

    fun getAll(context: Context): Set<String> =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getStringSet(KEY, emptySet()) ?: emptySet()

    fun addAll(context: Context, ids: List<String>) {
        if (ids.isEmpty()) return
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putStringSet(KEY, getAll(context) + ids).apply()
    }
}
