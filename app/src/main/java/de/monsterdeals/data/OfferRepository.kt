package de.monsterdeals.data

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.get
import io.ktor.client.request.parameter
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json

/**
 * Holt Angebote vom eigenen Backend.
 *
 * Das Backend macht die eigentliche Arbeit: es haelt eine Tabelle
 * (Laden, Produkt, Preis, Gueltigkeit, Geo-Koordinaten) und liefert per
 * /offers?lat=..&lon=..&radiusKm=.. alles im Umkreis zurueck.
 * Datenquelle: Nutzer-Meldungen (Crowdsourcing) oder ein lizenzierter
 * Prospekt-Anbieter. Details im README.
 */
class OfferRepository(
    private val baseUrl: String = "https://monsterdeals-backend.onrender.com"
) {
    private val client = HttpClient {
        install(ContentNegotiation) {
            json(Json { ignoreUnknownKeys = true })
        }
        // Render (Gratis-Tier) schlaeft nach Inaktivitaet ein und braucht beim
        // Aufwachen 30-50s. Der REWE-Scraper startet zusaetzlich einen echten
        // Headless-Browser (langsam auf dem Gratis-Tier), deshalb grosszuegig.
        install(HttpTimeout) {
            requestTimeoutMillis = 120_000
            connectTimeoutMillis = 120_000
            socketTimeoutMillis = 120_000
        }
    }

    suspend fun nearbyOffers(
        lat: Double,
        lon: Double,
        radiusKm: Int = 15,
        query: String = "Monster Energy"
    ): List<Offer> {
        return client.get("$baseUrl/offers") {
            parameter("lat", lat)
            parameter("lon", lon)
            parameter("radiusKm", radiusKm)
            parameter("q", query)
        }.body()
    }

    /** Demo-Daten zum Testen ohne laufendes Backend. */
    fun demoOffers(lat: Double, lon: Double): List<Offer> = listOf(
        Offer("1", "REWE City", "Hauptstr. 12", "Monster Energy Ultra 500ml",
            price = 0.89, deposit = 0.25, regularPrice = 1.49, validUntil = "2026-09-13",
            lat = lat + 0.008, lon = lon + 0.004),
        Offer("2", "Kaufland", "Marktplatz 3", "Monster Energy Original 500ml",
            price = 0.99, deposit = 0.25, regularPrice = 1.59, validUntil = "2026-09-12",
            lat = lat - 0.015, lon = lon + 0.011),
        Offer("3", "Netto", "Bahnhofstr. 44", "Monster Energy Juiced 500ml",
            price = 1.09, deposit = 0.25, regularPrice = 1.49, validUntil = "2026-09-14",
            lat = lat + 0.021, lon = lon - 0.018)
    )
}
