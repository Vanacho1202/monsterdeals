package de.monsterdeals.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import de.monsterdeals.data.Offer
import de.monsterdeals.location.LatLon

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OffersScreen(
    state: UiState,
    onRetry: () -> Unit
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("MonsterDeals", fontWeight = FontWeight.Bold)
                        val subtitle = (state as? UiState.Ready)?.offers?.size
                        if (subtitle != null) {
                            Text(
                                if (subtitle == 1) "1 Angebot in der Nähe" else "$subtitle Angebote in der Nähe",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                },
                actions = {
                    IconButton(onClick = onRetry) {
                        Icon(Icons.Default.Refresh, contentDescription = "Aktualisieren")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface
                )
            )
        },
        containerColor = MaterialTheme.colorScheme.background
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            AnimatedContent(
                targetState = state,
                label = "offers-state",
                transitionSpec = { fadeIn() togetherWith fadeOut() }
            ) { s ->
                when (s) {
                    is UiState.AskingPermissions -> CenteredMessage(
                        icon = Icons.Default.LocationOn,
                        title = "Standort wird abgefragt",
                        subtitle = "Erlaube den Zugriff, um Angebote in deiner Nähe zu finden."
                    )

                    is UiState.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = MaterialTheme.colorScheme.primary)
                    }

                    is UiState.Error -> CenteredMessage(
                        icon = Icons.Default.Warning,
                        title = "Das hat nicht geklappt",
                        subtitle = s.message,
                        action = { Button(onClick = onRetry) { Text("Erneut versuchen") } }
                    )

                    is UiState.Ready ->
                        if (s.offers.isEmpty()) {
                            CenteredMessage(
                                icon = Icons.Default.Search,
                                title = "Nichts gefunden",
                                subtitle = "Aktuell kein Monster-Energy-Angebot in deiner Nähe.",
                                action = { OutlinedButton(onClick = onRetry) { Text("Erneut versuchen") } }
                            )
                        } else {
                            OfferList(s.offers, s.here)
                        }
                }
            }
        }
    }
}

@Composable
private fun CenteredMessage(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    title: String,
    subtitle: String,
    action: (@Composable () -> Unit)? = null
) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Icon(
            icon,
            contentDescription = null,
            modifier = Modifier.size(48.dp),
            tint = MaterialTheme.colorScheme.primary
        )
        Spacer(Modifier.height(16.dp))
        Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        Spacer(Modifier.height(4.dp))
        Text(
            subtitle,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center
        )
        if (action != null) {
            Spacer(Modifier.height(20.dp))
            action()
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
    Card(
        Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        Row(Modifier.padding(16.dp)) {
            StoreBadge(offer.storeName)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.Top
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            offer.storeName,
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold
                        )
                        Text(
                            offer.product,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 2
                        )
                    }
                    Spacer(Modifier.width(8.dp))
                    Column(horizontalAlignment = Alignment.End) {
                        Text(
                            String.format("%.2f %s", offer.price, offer.currencyLabel),
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary
                        )
                        if (offer.deposit > 0) {
                            Text(
                                String.format("+ %.2f %s Pfand", offer.deposit, offer.currencyLabel),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                }
                if (offer.packInfo.isNotBlank()) {
                    Spacer(Modifier.height(6.dp))
                    val isSingleCan = offer.packInfo == "Einzeldose"
                    InfoChip(
                        offer.packInfo,
                        containerColor = if (isSingleCan) {
                            MaterialTheme.colorScheme.surfaceVariant
                        } else {
                            MaterialTheme.colorScheme.tertiaryContainer
                        },
                        contentColor = if (isSingleCan) {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        } else {
                            MaterialTheme.colorScheme.onTertiaryContainer
                        }
                    )
                }
                Spacer(Modifier.height(10.dp))
                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    InfoChip(String.format("%.1f km", distance))
                    offer.savingsPercent?.let {
                        InfoChip(
                            "-$it %",
                            containerColor = MaterialTheme.colorScheme.secondaryContainer,
                            contentColor = MaterialTheme.colorScheme.onSecondaryContainer
                        )
                    }
                    if (offer.validUntil.isNotBlank()) {
                        InfoChip("bis ${offer.validUntil}")
                    }
                }
                Spacer(Modifier.height(8.dp))
                Text(
                    offer.storeAddress,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

/** Farbiger Kreis mit dem Anfangsbuchstaben der Kette - Platzhalter für ein echtes Logo. */
@Composable
private fun StoreBadge(storeName: String) {
    Box(
        Modifier
            .size(44.dp)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.primaryContainer),
        contentAlignment = Alignment.Center
    ) {
        Text(
            storeName.trim().firstOrNull()?.uppercaseChar()?.toString() ?: "?",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onPrimaryContainer
        )
    }
}

@Composable
private fun InfoChip(
    text: String,
    containerColor: Color = MaterialTheme.colorScheme.surfaceVariant,
    contentColor: Color = MaterialTheme.colorScheme.onSurfaceVariant
) {
    Box(
        Modifier
            .clip(RoundedCornerShape(50))
            .background(containerColor)
            .padding(horizontal = 10.dp, vertical = 5.dp)
    ) {
        Text(text, style = MaterialTheme.typography.labelMedium, color = contentColor, fontSize = 12.sp)
    }
}
