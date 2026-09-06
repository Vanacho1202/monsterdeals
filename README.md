# MonsterDeals - Android-App fuer Angebote im Umkreis

Grundgeruest fuer eine Android-App (minSdk 33 = Android 13, Kotlin + Jetpack Compose),
die beim Start Standort- und Benachrichtigungsfreigabe abfragt und anschliessend
anzeigt, in welchen Laeden im Umkreis Monster Energy im Angebot ist.

## Ablauf in der App

1. Start -> `MainActivity` fragt `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` ab
2. Bei Erfolg -> `POST_NOTIFICATIONS` (ab Android 13 immer erforderlich)
3. `LocationProvider` holt die Position ueber den Fused Location Provider
4. `OfferRepository` fragt das Backend nach Angeboten im Umkreis
5. `OffersScreen` zeigt die Treffer, sortiert nach Preis, mit Entfernung und Rabatt

## Dateien

| Datei | Zweck |
|---|---|
| `MainActivity.kt` | Einstieg, Permission-Flow |
| `ui/OffersViewModel.kt` | Zustand, Laden der Daten |
| `ui/OffersScreen.kt` | Compose-Oberflaeche, Angebotskarten |
| `data/Offer.kt` | Datenmodell inkl. Entfernungsberechnung (Haversine) |
| `data/OfferRepository.kt` | Backend-Anbindung + Demo-Daten |
| `location/LocationProvider.kt` | Standortabfrage |
| `notify/Notifications.kt` | Kanal + Push bei neuem Angebot |

## Sofort testbar

In `OffersViewModel` steht `useDemoData = true`. Damit laeuft die App ohne
Backend und zeigt drei erfundene Angebote rund um deine echte Position.
Fuer den Echtbetrieb auf `false` setzen und in `OfferRepository` die `baseUrl`
eintragen.

## Was noch fehlt: das Backend

Das ist der eigentliche Knackpunkt, nicht die App. Erwartetes Format von
`GET /offers?lat=..&lon=..&radiusKm=..&q=Monster Energy`:

```json
[
  {
    "id": "1",
    "storeName": "REWE City",
    "storeAddress": "Hauptstr. 12",
    "product": "Monster Energy Ultra 500ml",
    "price": 0.89,
    "regularPrice": 1.49,
    "validUntil": "2026-09-13",
    "lat": 52.51,
    "lon": 13.40
  }
]
```

Moegliche Umsetzung: Supabase oder Firebase mit einer Tabelle `offers`, Umkreissuche
per PostGIS (`ST_DWithin`) oder einfacher Bounding-Box-Abfrage plus Haversine-Filter.

Datenquellen, nach Aufwand und Rechtslage sortiert:

1. **Crowdsourcing** - Nutzer melden Preise selbst. Rechtlich unproblematisch,
   braucht aber Nutzer. Realistischster Start: Meldeformular in der App ergaenzen.
2. **Lizenzierter Prospekt-Anbieter** - Marktguru, Kaufda o.ae. anschreiben und nach
   einem Business-/Partner-Zugang fragen.
3. **Scraping von Haendler-Seiten** - technisch aufwendig (jede Kette anders) und
   rechtlich heikel (AGB, Urheberrecht an Prospekten). Wuerde ich nicht als Basis nehmen.

## Naechste sinnvolle Schritte

- Meldefunktion ("Preis melden") inkl. Foto des Preisschilds
- Wunschpreis-Alarm: Geofencing (`GeofencingClient`) statt dauerhaftem GPS-Polling,
  damit der Akku nicht leidet
- Radius-Auswahl im UI (ViewModel hat `setRadius` schon vorbereitet)
- Karte statt Liste (Maps Compose)

## Hinweis zum Namen

"Monster Energy" ist eine eingetragene Marke. Fuer eine Veroeffentlichung im Play
Store solltest du den Markennamen nicht im App-Namen oder Icon verwenden, sondern
nur als Produktbezeichnung in den Daten.

---

# Nachtrag: Online-Preise und APK

## Preise werden jetzt online ermittelt

Unter `backend/` liegt ein Node-Server, der genau das macht:

1. Koordinaten der App -> Ort und PLZ per OpenStreetMap Nominatim
2. Ort + Produkt -> Claude mit aktivierter Websuche durchsucht aktuelle
   Prospekt- und Angebotsseiten und gibt die Treffer als JSON zurueck
3. Jeder gefundene Laden wird geokodiert, damit die App die Entfernung berechnen kann
4. Ergebnis wird 6 Stunden pro Ort gecacht

Starten:

```bash
cd backend
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

Danach in `OfferRepository.kt` die `baseUrl` auf deinen Server setzen.
Im Emulator erreichst du localhost ueber `http://10.0.2.2:8080`.
`useDemoData` steht jetzt auf `false`.

### Warum dieser Weg

Es gibt keine offizielle, frei nutzbare API fuer Angebotspreise deutscher
Supermaerkte. <cite index="3-1">Vollstaendige Preistransparenz liegt schlicht nicht im Interesse der Haendler</cite>, und Anbieter wie Marktguru oder Weekli haben nur
interne Schnittstellen fuer ihre eigenen Apps. Deren inoffizielle Endpunkte
anzuzapfen verstoesst gegen die Nutzungsbedingungen und bricht regelmaessig ab.
Der Weg ueber eine echte Websuche ist langsamer und ungenauer, aber sauber.

**Wichtig:** Die Preise sind ohne Gewaehr. Zeig in der App einen Hinweis und
den Quell-Link (`Offer.source`) an. Ergaenze zusaetzlich eine Meldefunktion,
damit Nutzer falsche Preise korrigieren koennen.

## Zur APK

Eine fertig gebaute APK kann ich dir hier nicht liefern: mir fehlen dafuer
das Android SDK und der Zugriff auf Googles Maven-Repository. Es gibt zwei
schnelle Wege:

**Weg 1 - Android Studio (5 Minuten)**
Projekt oeffnen, Gradle synchronisieren lassen, dann
`Build > Build Bundle(s) / APK(s) > Build APK(s)`.
Die Datei liegt danach unter `app/build/outputs/apk/debug/app-debug.apk`.

**Weg 2 - GitHub baut sie fuer dich**
`.github/workflows/android.yml` ist fertig konfiguriert. Projekt auf GitHub
pushen, dann unter *Actions > Build APK > Artifacts* die `app-debug.apk`
herunterladen. Damit das laeuft, brauchst du noch den Gradle-Wrapper
(`gradle wrapper` einmal lokal ausfuehren) sowie `settings.gradle.kts` und
das Root-`build.gradle.kts`, die Android Studio beim Anlegen erzeugt.

Zum Installieren auf dem Handy: "Installation aus unbekannten Quellen" fuer
den Dateimanager erlauben. Eine Debug-APK laeuft nur auf Geraeten, nicht im
Play Store.
