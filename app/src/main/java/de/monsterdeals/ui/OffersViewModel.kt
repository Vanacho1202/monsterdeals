package de.monsterdeals.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import de.monsterdeals.data.Offer
import de.monsterdeals.data.OfferRepository
import de.monsterdeals.location.LatLon
import de.monsterdeals.location.LocationProvider
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed interface UiState {
    data object AskingPermissions : UiState
    data object Loading : UiState
    data class Ready(val offers: List<Offer>, val here: LatLon) : UiState
    data class Error(val message: String) : UiState
}

class OffersViewModel(app: Application) : AndroidViewModel(app) {

    private val locationProvider = LocationProvider(app)
    private val repo = OfferRepository()

    // Echtes Backend (Render + direktes Scraping, kein API-Key, kein Geld)
    private val useDemoData = false

    private val _state = MutableStateFlow<UiState>(UiState.AskingPermissions)
    val state: StateFlow<UiState> = _state.asStateFlow()

    var radiusKm = 15
        private set

    fun setRadius(km: Int) {
        radiusKm = km
        load()
    }

    /** Wird aufgerufen, sobald die Standort-Permission erteilt wurde. */
    fun load() {
        _state.value = UiState.Loading
        viewModelScope.launch {
            val here = locationProvider.current()
            if (here == null) {
                _state.value = UiState.Error("Standort konnte nicht ermittelt werden.")
                return@launch
            }
            try {
                val offers = if (useDemoData) {
                    repo.demoOffers(here.lat, here.lon)
                } else {
                    repo.nearbyOffers(here.lat, here.lon, radiusKm)
                }
                // Reine Preissortierung reisst Ketten mit mehreren Filialen
                // auseinander: eine 1 Cent guenstigere, aber 70km entfernte
                // Filiale landete vor einer nahen, minimal teureren. Deshalb
                // Preis und Entfernung kombiniert gewichten (2 Cent "Strafe"
                // pro Kilometer) statt rein nach Preis zu sortieren.
                val sorted = offers.sortedBy { offer ->
                    offer.price + offer.distanceKm(here.lat, here.lon) * 0.02
                }
                _state.value = UiState.Ready(sorted, here)
            } catch (e: Exception) {
                _state.value = UiState.Error("Angebote konnten nicht geladen werden: ${e.message}")
            }
        }
    }

    fun permissionDenied() {
        _state.value = UiState.Error(
            "Ohne Standortfreigabe koennen keine Angebote in deiner Naehe gesucht werden."
        )
    }
}
