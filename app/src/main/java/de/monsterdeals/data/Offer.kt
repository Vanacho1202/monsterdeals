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
    val price: Double,          // Angebotspreis in Euro, OHNE Pfand
    val deposit: Double = 0.0,  // Pfand in Euro, separat an der Kasse faellig
    val regularPrice: Double?,  // Normalpreis, falls bekannt
    val validUntil: String,     // ISO-Datum
    val lat: Double,
    val lon: Double,
    val source: String = ""   // Fundstelle im Web, Angabe ohne Gewaehr
) {
    /** Entfernung in km zum uebergebenen Punkt (Haversine). */
    fun distanceKm(fromLat: Double, fromLon: Double): Double {
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
}
