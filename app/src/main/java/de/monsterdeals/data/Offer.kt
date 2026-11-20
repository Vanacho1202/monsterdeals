package de.monsterdeals.data

import kotlinx.serialization.Serializable

@Serializable
data class Offer(
    val id: String,
    val storeName: String,      // z.B. "REWE City"
    val storeAddress: String,
    val product: String,        // z.B. "Monster Energy Ultra 500ml"
    val packInfo: String = "",  // z.B. "Einzeldose" oder "Mehrfachpackung (...)" -
                                 // eigenes Feld statt Teil von "product", damit es
                                 // bei langen Produktnamen nicht abgeschnitten wird
    val price: Double,           // Angebotspreis, OHNE Pfand
    val deposit: Double = 0.0,   // Pfand in derselben Währung, separat an der Kasse fällig
    val regularPrice: Double?,   // Normalpreis, falls bekannt
    val validUntil: String,      // ISO-Datum
    // null = Filiale nicht gefunden (Backend mit includeUnlocated=1),
    // dann steht der Grund in "note"
    val lat: Double? = null,
    val lon: Double? = null,
    val note: String? = null,
    val currency: String = "EUR", // ISO-Code, z.B. "EUR"/"PLN"/"CZK"/"HUF"/"DKK"/"SEK" -
                                   // nicht jedes Land in der App nutzt Euro, nie annehmen
    val source: String = ""   // Fundstelle im Web, Angabe ohne Gewähr
) {
    /** Entfernung in km zum übergebenen Punkt (Haversine), null ohne Filiale. */
    fun distanceKm(fromLat: Double, fromLon: Double): Double? {
        val lat = lat ?: return null
        val lon = lon ?: return null
        val r = 6371.0
        val dLat = Math.toRadians(lat - fromLat)
        val dLon = Math.toRadians(lon - fromLon)
        val a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(Math.toRadians(fromLat)) * Math.cos(Math.toRadians(lat)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2)
        return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    }

    val savingsPercent: Int?
        get() = regularPrice?.let { (((it - price) / it) * 100).toInt() }

    /** Kurzes Währungskürzel für die Anzeige - reine Darstellung, keine Umrechnung. */
    val currencyLabel: String
        get() = when (currency) {
            "EUR" -> "€"
            "CZK" -> "Kč"
            "DKK", "SEK", "NOK" -> "kr"
            "HUF" -> "Ft"
            "PLN" -> "zł"
            else -> currency
        }
}
