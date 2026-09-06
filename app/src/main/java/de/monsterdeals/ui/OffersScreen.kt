package de.monsterdeals.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import de.monsterdeals.data.Offer
import de.monsterdeals.location.LatLon

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OffersScreen(
    state: UiState,
    onRetry: () -> Unit
) {
    Scaffold(
        topBar = { TopAppBar(title = { Text("Angebote in deiner Naehe") }) }
    ) { padding ->
        Box(
            Modifier.padding(padding).fillMaxSize(),
            contentAlignment = Alignment.Center
        ) {
            when (state) {
                is UiState.AskingPermissions ->
                    Text("Berechtigungen werden abgefragt ...")

                is UiState.Loading -> CircularProgressIndicator()

                is UiState.Error -> Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier.padding(24.dp)
                ) {
                    Text(state.message)
                    Spacer(Modifier.height(16.dp))
                    Button(onClick = onRetry) { Text("Erneut versuchen") }
                }

                is UiState.Ready ->
                    if (state.offers.isEmpty()) {
                        Text("Aktuell keine Angebote im Umkreis gefunden.")
                    } else {
                        OfferList(state.offers, state.here)
                    }
            }
        }
    }
}

@Composable
private fun OfferList(offers: List<Offer>, here: LatLon) {
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        items(offers, key = { it.id }) { offer ->
            OfferCard(offer, here)
        }
    }
}

@Composable
private fun OfferCard(offer: Offer, here: LatLon) {
    val distance = offer.distanceKm(here.lat, here.lon)
    ElevatedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(offer.storeName, style = MaterialTheme.typography.titleMedium)
                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        String.format("%.2f EUR", offer.price),
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold
                    )
                    if (offer.deposit > 0) {
                        Text(
                            String.format("+ %.2f EUR Pfand", offer.deposit),
                            style = MaterialTheme.typography.labelSmall
                        )
                    }
                }
            }
            Spacer(Modifier.height(4.dp))
            Text(offer.product, style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AssistChip(
                    onClick = {},
                    label = { Text(String.format("%.1f km", distance)) }
                )
                offer.savingsPercent?.let {
                    AssistChip(onClick = {}, label = { Text("-$it %") })
                }
                AssistChip(
                    onClick = {},
                    label = { Text("bis ${offer.validUntil}") }
                )
            }
            Spacer(Modifier.height(4.dp))
            Text(
                offer.storeAddress,
                style = MaterialTheme.typography.bodySmall
            )
        }
    }
}
