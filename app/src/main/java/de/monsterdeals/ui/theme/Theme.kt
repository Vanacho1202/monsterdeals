package de.monsterdeals.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Kräftiges Violett als Markenfarbe, warmes Amber für Preise/Rabatte -
// bewusst weit weg von Monster Energys eigenem Schwarz/Neongrün.
private val Violet80 = Color(0xFFD6C8FF)
private val Violet60 = Color(0xFF9A7BFF)
private val Violet40 = Color(0xFF6B3FE0)
private val Violet20 = Color(0xFF2E1065)

private val Amber80 = Color(0xFFFFD9A8)
private val Amber60 = Color(0xFFFFB454)
private val Amber40 = Color(0xFFE0891C)

private val Ink10 = Color(0xFF14121B)
private val Ink95 = Color(0xFFFBFAFF)

private val LightColors = lightColorScheme(
    primary = Violet40,
    onPrimary = Color.White,
    primaryContainer = Violet80,
    onPrimaryContainer = Violet20,
    secondary = Amber40,
    onSecondary = Color.White,
    secondaryContainer = Amber80,
    onSecondaryContainer = Color(0xFF4A2E00),
    background = Ink95,
    onBackground = Ink10,
    surface = Color.White,
    onSurface = Ink10,
    surfaceVariant = Color(0xFFEDE7F9),
    onSurfaceVariant = Color(0xFF4A4458)
)

private val DarkColors = darkColorScheme(
    primary = Violet60,
    onPrimary = Violet20,
    primaryContainer = Violet40,
    onPrimaryContainer = Violet80,
    secondary = Amber60,
    onSecondary = Color(0xFF4A2E00),
    secondaryContainer = Amber40,
    onSecondaryContainer = Amber80,
    background = Ink10,
    onBackground = Ink95,
    surface = Color(0xFF1E1B27),
    onSurface = Ink95,
    surfaceVariant = Color(0xFF2C2739),
    onSurfaceVariant = Color(0xFFCBC3DC)
)

@Composable
fun MonsterDealsTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        content = content
    )
}
