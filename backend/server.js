/**
 * MonsterDeals Backend
 *
 * Endpunkt: GET /offers?lat=..&lon=..&radiusKm=..&q=Monster Energy
 *
 * Ablauf:
 *  1. Koordinaten -> Ort/PLZ per Photon (OSM-basiert, https://photon.komoot.io)
 *  2. Direktes Scraping der öffentlichen Angebotsseiten einzelner Händler
 *     (kein LLM, keine Kosten, kein API-Key) nach dem gesuchten Produkt
 *  3. Bis zu 3 nächstgelegene Filialen je Treffer per Photon geokodieren
 *     (geocodeStores), damit die App auch mehrere Filialen derselben
 *     Kette in der Nähe anzeigen kann, nicht nur die nächste
 *  4. Ergebnis wird 6 Stunden gecacht
 *
 * Abdeckung / bekannte Einschränkungen:
 *  - Aldi Nord, Trinkgut, Kaufland: direkt von der jeweiligen Händler-
 *    Seite, funktionieren zuverlässig.
 *  - scrapeMeinprospekt(): zusätzlich meinprospekt.de (Prospekt-
 *    Aggregator), Ketten-übergreifend - zeigt automatisch, welche Kette
 *    diese Woche Monster Energy im Prospekt hat (z.B. Lidl, Penny, ggf.
 *    auch REWE, EDEKA etc., je nachdem wer aktuell ein Angebot hat). Als
 *    SEO-Seite ohne aggressiven Bot-Schutz, kein curl/Browser nötig.
 *  - REWE/EDEKA/Aldi Süd/Netto DIREKT (auf deren eigener Seite) sind NICHT
 *    eingebaut: liefern 403 (Bot-Schutz) bzw. bei REWE liefert selbst curl
 *    von jedem getesteten Render-Standort (Oregon UND Frankfurt) nur die
 *    generische Homepage statt der Angebotsseite - also eine IP-Bereich-
 *    Sperre gegen Cloud-Hosting generell, keine Geo-Sperre. Ein echter Fix
 *    (Proxy mit Residential-IP o.ä.) wäre ein aktiver Bot-Erkennungs-
 *    Bypass und wurde deshalb bewusst nicht gebaut. Diese Ketten können
 *    aber trotzdem über scrapeMeinprospekt() auftauchen, sobald sie dort
 *    ein Angebot haben.
 *    (Ein zuvor versuchter echter Headless-Chrome via puppeteer-core +
 *    @sparticuz/chromium hätte zusätzlich Render's 512-MB-Gratis-Tier
 *    mit Out-of-Memory abgeschossen.)
 *  - Alle Preise sind national/online-Prospekt-Daten, nicht filialscharf.
 *    Die Distanz bezieht sich auf die nächste per Photon gefundene
 *    Filiale der Kette, nicht auf den tatsächlichen Angebotsort.
 *  - Bricht potenziell, wenn eine Seite ihr Layout umbaut.
 *
 * Länder (COUNTRIES weiter unten):
 *  - Das Land kommt aus der Photon-Geokodierung der Nutzerposition. Je Land
 *    gibt es eigene Scraper, eigene Filial-Suche (nur Filialen im selben
 *    Land) und einen eigenen Cache-Schlüssel.
 *  - DE: wie bisher.
 *  - IT (Florenz usw.): zwei Prospekt-Aggregatoren, die dem Server echte
 *    Seiten liefern: volantinofacile.it (Kategorie "Energy drink", u.a.
 *    Conad/Interspar) und tutti-sconti.it (Produktseite "Monster Energy", u.a.
 *    Coop/Eurospar/Carrefour). Nur aktuell gültige Angebote mit Preis werden
 *    übernommen. offertevolantini.it sperrt Cloud-Server (leere HTTP-202-
 *    Antwort) und ist deshalb nicht dabei. Unter /debug/it sieht man je
 *    Scraper, was gefunden wurde.
 *  - Kein Einwegpfand in Italien -> deposit: 0.
 *  - FR, NL, PL, PT, BE, AT, CZ, DK, GR, HU, SK, SE: je 1 Quelle über
 *    tiendeo.<tld> (ShopFully-Netzwerk, dieselbe Plattform wie
 *    volantinofacile.it/IT, siehe scrapeTiendeo()). Live mit echten
 *    Energy-Drink-Treffern verifiziert, deckt pro Land mehrere Ketten ab.
 *    Nächster Ausbauschritt: zweite, unabhängige Quelle pro Land.
 *  - Preise sind NICHT automatisch Euro - jedes Angebot trägt ein eigenes
 *    "currency"-Feld (ISO-Code, z.B. PLN/CZK/HUF/DKK/SEK), die App zeigt das
 *    passende Symbol/Kürzel an statt blind "€" zu unterstellen.
 *  - Nicht unterstützte Länder liefern eine leere Liste.
 */
import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 8080;

// Bisher wurden nur Scraper-FEHLER geloggt - ein erfolgreicher Request war im
// Log unsichtbar, dadurch ließ sich "kommt überhaupt eine Anfrage an?" nicht
// beantworten. Jetzt jede Anfrage knapp mitschreiben.
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
});
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const cache = new Map();
const CACHE_MS = 6 * 60 * 60 * 1000;

async function fetchHtml(url, lang = "de-DE,de;q=0.9") {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": lang } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.text();
}

// "2026-09-12" -> "12.09.2026" (deutsches Format, passend zu den anderen Quellen)
function formatDate(isoDate) {
  if (!isoDate) return "";
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : isoDate;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ---------- Geocoding über Photon (OSM-basiert) ---------- */
async function reverseGeocode(lat, lon) {
  const url = `https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  const j = await r.json();
  const p = j.features?.[0]?.properties || {};
  return {
    city: p.city || p.town || p.village || p.district || "",
    postcode: p.postcode || "",
    countryCode: (p.countrycode || "").toUpperCase()
  };
}

/**
 * Findet die nächsten Filialen einer Kette (nicht nur eine). Gibt bis zu
 * maxResults Stück zurück, sortiert nach Entfernung, jede innerhalb von
 * maxKm - damit z.B. "Penny" nicht nur eine, sondern mehrere Filialen in
 * der Nähe zeigt, falls es dort mehrere gibt.
 */
async function geocodeStores(name, nearLat, nearLon, maxResults = 3, maxKm = 100, countryCode = "DE", osmTag = "") {
  // NUR den Kettennamen suchen, ohne Stadt im Suchtext: Photons Textsuche
  // kombiniert "Kette, kleiner Ort" oft schlecht (fand z.B. für "Lidl,
  // Amöneburg" NICHTS, obwohl "Lidl" allein + lat/lon-Gewichtung sofort
  // mehrere echte Filialen in 10-25km Entfernung lieferte). lat/lon-
  // Gewichtung reicht für die Nähe-Sortierung völlig aus.
  const q = encodeURIComponent(name);
  // osmTag (z.B. "shop") schränkt auf Läden ein - nötig für kurze Kettennamen
  // wie "MD" oder "Penny", die sonst auch Orte/Personen treffen.
  const tagParam = osmTag ? `&osm_tag=${encodeURIComponent(osmTag)}` : "";
  const url = `https://photon.komoot.io/api/?q=${q}&limit=15&lat=${nearLat}&lon=${nearLon}${tagParam}`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  const j = await r.json();
  const candidates = (j.features || [])
    .filter((feat) => (feat.properties?.countrycode || "").toUpperCase() === countryCode)
    .map((f) => {
      const p = f.properties;
      const lat = f.geometry.coordinates[1];
      const lon = f.geometry.coordinates[0];
      return {
        lat,
        lon,
        address: [p.name, p.street, p.housenumber, p.postcode, p.city].filter(Boolean).join(", "),
        state: p.state || "",
        distanceKm: haversineKm(nearLat, nearLon, lat, lon)
      };
    })
    .filter((c) => c.distanceKm <= maxKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  // Duplikate vermeiden (Photon liefert manchmal dieselbe Filiale mehrfach
  // mit minimal unterschiedlichen Koordinaten, z.B. Eingang vs. Gebäude).
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    const key = c.address;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
    if (unique.length >= maxResults) break;
  }
  return unique;
}

/* ---------- Scraper: Trinkgut (Shopware, .product-box) ---------- */
async function scrapeTrinkgut(query) {
  const url = "https://www.trinkgut.de/angebote";
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  // Seitenweite Gültigkeit, gilt für alle Angebote auf der Seite:
  // "Gültig vom 07.09.2026 bis 12.09.2026"
  const validMatch = html.match(/[GgÜü]ltig vom \d{2}\.\d{2}\.\d{4} bis (\d{2}\.\d{2}\.\d{4})/);
  const validUntil = validMatch ? validMatch[1] : "";
  const out = [];
  $(".product-box").each((_, el) => {
    const name = $(el).find(".product-name").text().trim();
    if (!name.toLowerCase().includes(query.toLowerCase())) return;
    const priceText = $(el).find(".product-price span").first().text().trim();
    const price = parseFloat(priceText.replace(",", "."));
    if (Number.isNaN(price)) return;
    // Produktbeschreibung ist meist mit "..." abgeschnitten, deshalb Pfand
    // stattdessen am Bild-Dateinamen erkennen (Trinkgut hängt "dpg" an,
    // Deutsches Pfandsystem = Einwegpfand-Dose).
    const imgSrc = $(el).find("img").attr("src") || "";
    out.push({
      storeName: "Trinkgut",
      product: name,
      packInfo: "Einzeldose",
      price,
      deposit: /dpg/i.test(imgSrc) ? 0.25 : 0,
      regularPrice: null,
      validUntil,
      source: url
    });
  });
  return out;
}

/* ---------- Scraper: Kaufland (.k-product-tile) ---------- */
async function scrapeKaufland(query) {
  const url = "https://filiale.kaufland.de/angebote.html";
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  // "Gültig vom 03.09. bis 09.09." - ohne Jahr, deshalb aktuelles Jahr
  // ergänzen (die Seite zeigt immer nur die laufende Angebotswoche).
  const validMatch = html.match(/[GgÜü]ltig vom \d{2}\.\d{2}\. bis (\d{2}\.\d{2}\.)/);
  const validUntil = validMatch ? `${validMatch[1]}${new Date().getFullYear()}` : "";
  const out = [];
  $(".k-product-tile").each((_, el) => {
    const title = $(el).find(".k-product-tile__title").text().trim();
    const subtitle = $(el).find(".k-product-tile__subtitle").text().trim();
    const name = `${title} ${subtitle}`.trim();
    if (!name.toLowerCase().includes(query.toLowerCase())) return;
    // Kaufland zeigt Preise mit Punkt als Dezimaltrennzeichen (z.B. "1.19")
    const priceText = $(el).find(".k-price-tag__price").first().text().trim();
    const price = parseFloat(priceText);
    if (Number.isNaN(price)) return;
    const oldPriceText = $(el).find(".k-price-tag__old-price").first().text().trim();
    const regularPrice = oldPriceText ? parseFloat(oldPriceText) : null;
    out.push({
      storeName: "Kaufland",
      product: name,
      packInfo: "Einzeldose",
      price,
      deposit: 0,
      regularPrice: Number.isNaN(regularPrice) ? null : regularPrice,
      validUntil,
      source: url
    });
  });
  return out;
}

/* ---------- Scraper: Aldi Nord (Next.js __NEXT_DATA__ JSON) ---------- */
function findProductsWithBrand(node, query, out, seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (typeof node.brandName === "string" && node.brandName.toLowerCase().includes(query.toLowerCase())) {
    out.push(node);
    return; // nicht tiefer in dieses Produktobjekt absteigen
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === "object") findProductsWithBrand(v, query, out, seen);
  }
}

async function scrapeAldiNord(query) {
  const url = "https://www.aldi-nord.de/angebote.html";
  const $ = cheerio.load(await fetchHtml(url));
  const raw = $("#__NEXT_DATA__").html();
  if (!raw) return [];
  const data = JSON.parse(raw);
  // Der eigentliche Produktkatalog steckt als JSON-String (nicht als
  // verschachteltes Objekt) in props.pageProps.apiData - muss separat
  // geparst werden.
  const apiDataRaw = data?.props?.pageProps?.apiData;
  const catalog = typeof apiDataRaw === "string" ? JSON.parse(apiDataRaw) : apiDataRaw;
  const matches = [];
  findProductsWithBrand(catalog, query, matches);
  const CAN_LITERS = 0.5; // Standard-Dosengröße für Energy Drinks in DE
  const CAN_DEPOSIT = 0.25; // Einwegpfand pro Dose
  return matches.map((p) => {
    // Aldi Nord liefert keine Stückzahl, nur einen Gesamtpreis (oft ein
    // Multipack, z.B. 10x0,5l) + Liter-Grundpreis. Auf Dosenpreis umrechnen,
    // damit die Zahl mit den anderen Ketten (Preis pro Dose) vergleichbar
    // ist, statt als "7,77 EUR" wie ein Einzelpreis dazustehen.
    const basePrice = p.currentPrice?.basePrice?.[0];
    const isPerLiter = basePrice?.basePriceScale === "Liter";
    const pricePerCan = isPerLiter ? Math.round(basePrice.basePriceValue * CAN_LITERS * 100) / 100 : null;
    const totalPrice = p.currentPrice?.priceValue ?? null;
    const isMultipack = isPerLiter && totalPrice != null && totalPrice / basePrice.basePriceValue > CAN_LITERS + 0.05;
    const packInfo = isMultipack
      ? `Nur im Mehrfachpack (${totalPrice.toFixed(2)} EUR gesamt)`
      : "Einzeldose";
    return {
      storeName: "Aldi Nord",
      product: `${p.brandName} ${p.shortDescription || p.name || ""}`.trim(),
      packInfo,
      price: pricePerCan ?? totalPrice,
      deposit: isPerLiter ? CAN_DEPOSIT : (p.depositValue ?? 0),
      regularPrice: null,
      // validUntilLocalDate (YYYY-MM-DD) steckt in promotionPrices[0], nicht
      // direkt in currentPrice - currentPrice hat nur Unix-Timestamps.
      validUntil: formatDate(p.promotionPrices?.[0]?.validUntilLocalDate),
      source: url
    };
  }).filter((o) => typeof o.price === "number");
}

/**
 * Scraper: meinprospekt.de (Prospekt-Aggregator)
 *
 * Listet Monster-Energy-Angebote ketten-übergreifend auf einer festen
 * Seite - SEO-Seite, deshalb (anders als REWE/EDEKA/Netto direkt) kein
 * aggressiver Bot-Schutz, kommt problemlos durch node-fetch. Deckt damit
 * potenziell auch Ketten ab, die einzeln nicht erreichbar waren (REWE,
 * Lidl, Penny, ...) - je nachdem, wer diese Woche im Prospekt ist.
 */
async function scrapeMeinprospekt(query) {
  if (!query.toLowerCase().includes("monster")) return [];
  const url = "https://www.meinprospekt.de/angebote/monster-energy";
  const $ = cheerio.load(await fetchHtml(url));
  const out = [];
  // Die Angebotskarten selbst haben kein Datum, aber die Prospekt-Liste
  // weiter oben auf der Seite ("REWE | Mo. 7.9. - Sa. 12.9.2026") schon -
  // Ketten -> Enddatum vorab einsammeln (erster Treffer je Kette, falls
  // eine Kette mehrere Prospekte hat).
  const validUntilByChain = new Map();
  $(".font-bold.truncate").each((_, el) => {
    const chain = $(el).text().trim().toLowerCase();
    const dateText = $(el).parent().find(".text-sm.text-dark1").first().text().trim();
    const m = dateText.match(/(\d{1,2}\.\d{1,2}\.\d{4})\s*$/);
    if (m && !validUntilByChain.has(chain)) validUntilByChain.set(chain, m[1]);
  });
  // Jede Angebotskarte: <p>Händler</p><p>Marke</p><p>Produktart</p>, dann
  // Preis (.text-primary) und optional Streichpreis (.line-through).
  const CAN_LITERS = 0.5; // Standard-Dosengröße für Energy Drinks in DE
  $("#OfferGrid [role=\"listitem\"]").each((_, el) => {
    const ps = $(el).find("p");
    const storeName = $(ps.get(0)).text().trim();
    const brand = $(ps.get(1)).text().trim();
    const productType = $(ps.get(2)).text().trim();
    const priceText = $(el).find(".text-primary").first().text().trim();
    // Preis kann "ab 0,89 €" heißen (z.B. Trinkgut) - Zahl per Regex holen,
    // parseFloat("ab 0.89") wäre NaN und das Angebot fiel komplett weg.
    const priceNum = priceText.match(/\d+(?:[.,]\d{1,2})?/);
    const totalPrice = priceNum ? parseFloat(priceNum[0].replace(",", ".")) : NaN;
    if (!storeName || Number.isNaN(totalPrice)) return;
    const oldPriceText = $(el).find(".line-through").first().text().trim();
    const regularPrice = oldPriceText ? parseFloat(oldPriceText.replace(",", ".")) : null;
    // Jede Karte hat eine Grundpreis-Notiz wie "(1 l = 1.78)". Das ist der
    // Gesamtpreis geteilt durch die tatsächliche Packungsgröße in Litern -
    // damit lässt sich ein echter Dosenpreis berechnen, auch für
    // Mehrfachpackungen, statt nur zu vermuten/zu warnen. Getestet: bei
    // bereits als Einzeldose ausgezeichneten Angeboten (Lidl) ergibt das
    // exakt den angezeigten Preis zurück.
    let unitPriceText = "";
    $(el).find("p").each((_, p) => {
      const t = $(p).text().trim();
      if (/1\s*l\s*=\s*[\d.,]+/i.test(t)) unitPriceText = t;
    });
    const unitMatch = unitPriceText.match(/=\s*([\d.,]+)/);
    const unitPricePerLiter = unitMatch ? parseFloat(unitMatch[1].replace(",", ".")) : null;
    const pricePerCan = unitPricePerLiter != null && !Number.isNaN(unitPricePerLiter)
      ? Math.round(unitPricePerLiter * CAN_LITERS * 100) / 100
      : null;
    // Ohne Grundpreis-Notiz ("1 l = ...") lässt sich Einzeldose vs.
    // Mehrfachpack nicht wirklich prüfen - dann NICHT stillschweigend
    // "Einzeldose" behaupten (wäre geraten, nicht erkannt), sondern
    // ehrlich als unklar kennzeichnen.
    const isMultipack = pricePerCan != null && Math.abs(totalPrice - pricePerCan) > 0.05;
    const packInfo =
      pricePerCan == null
        ? "Nicht eindeutig erkennbar"
        : isMultipack
        ? `Nur im Mehrfachpack (${totalPrice.toFixed(2)} EUR gesamt)`
        : "Einzeldose";
    out.push({
      storeName,
      product: [brand, productType].filter(Boolean).join(" ") || "Monster Energy",
      packInfo,
      price: pricePerCan ?? totalPrice,
      deposit: 0.25, // Standard-Einwegpfand, Seite gibt es nicht separat an
      regularPrice: regularPrice != null && !Number.isNaN(regularPrice) ? regularPrice : null,
      validUntil: validUntilByChain.get(storeName.toLowerCase()) || "",
      source: url
    });
  });
  return out;
}

/* ---------- Italien: volantinofacile.it + tutti-sconti.it ---------- */
// Hinweis: offertevolantini.it war zuerst die Hauptquelle, liefert an Render-
// Server aber nur eine leere HTTP-202-Antwort (Bot-Prüfung für Cloud-IPs).
// Das wird bewusst NICHT umgangen. Die beiden Quellen unten liefern dem Server
// echte Seiten.
const IT_LANG = "it-IT,it;q=0.9";

const IT_MONTHS = {
  gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6,
  luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12
};

const round2 = (x) => Math.round(x * 100) / 100;
const pad2 = (n) => String(n).padStart(2, "0");

// Heutiges Datum in Italien als "YYYY-MM-DD"
function itTodayIso() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });
}

// Text eines Elements MIT Leerzeichen zwischen den Teilen ("MONSTER" + "Eurospar"
// -> "MONSTER Eurospar"), ohne Script/Style. cheerio's .text() klebt Teile sonst
// zusammen.
function textWithSpaces(node) {
  const parts = [];
  const walk = (n) => {
    if (!n) return;
    if (n.type === "script" || n.type === "style") return;
    if (n.type === "text") {
      const t = (n.data || "").trim();
      if (t) parts.push(t);
    } else if (n.children) {
      n.children.forEach(walk);
    }
  };
  walk(node);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// "30 settembre" -> "2026-09-30". Ohne Jahr: laufendes Jahr, außer der Monat
// liegt weit vor dem heutigen (z.B. "5 gennaio" im Dezember -> nächstes Jahr).
function itDayMonthToIso(day, monthName, todayIso) {
  const month = IT_MONTHS[String(monthName).toLowerCase()];
  if (!month) return "";
  const [ty, tm] = todayIso.split("-").map(Number);
  const year = tm - month > 6 ? ty + 1 : ty;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

// Stückzahl aus dem Produktnamen, z.B. "4 x 50 cl", "pacco da 4", "6 lattine".
// Ohne Hinweis: 1.
function detectPackCount(name) {
  const n = name.toLowerCase();
  let m = n.match(/(\d+)\s*[x×]\s*\d/);
  if (!m) m = n.match(/(?:pacco|confezione|conf\.?|pack)\s*(?:da\s*)?(\d+)/);
  if (!m) m = n.match(/(\d+)\s*(?:lattine|pezzi|pz)\b/);
  const c = m ? parseInt(m[1], 10) : 1;
  return c >= 2 && c <= 24 ? c : 1;
}

/**
 * Baut ein Angebot im Format der App. Preis pro Dose: nur umrechnen, wenn der
 * Name eine Stückzahl verrät. Ohne Hinweis ist ein Preis bis 1,99 EUR mit
 * hoher Sicherheit eine Einzeldose (0,5-l-Dose kostet im Angebot ca.
 * 0,70-1,60 EUR); darüber ist es oft ein 4er-Pack - dann ehrlich als unklar
 * kennzeichnen statt Einzeldose zu behaupten. Kein Einwegpfand in Italien.
 */
function buildItOffer({ storeName, name, total, endIso, source }) {
  const count = detectPackCount(name);
  let price = total;
  let packInfo;
  if (count > 1) {
    price = round2(total / count);
    packInfo = `Nur im Mehrfachpack (${total.toFixed(2)} EUR gesamt)`;
  } else if (total <= 1.99) {
    packInfo = "Einzeldose";
  } else {
    packInfo = "Nicht eindeutig erkennbar";
  }
  return {
    storeName,
    product: name,
    packInfo,
    price,
    deposit: 0,
    regularPrice: null,
    validUntil: formatDate(endIso),
    source
  };
}

/**
 * Scraper: volantinofacile.it, Kategorie "Energy drink" (ShopFully).
 * Die Seite ist eine Liste von Angebotskarten (Produktname, Kette als
 * Logo-Bild, Preis, "Sfoglia Volantino", "fino al 30 settembre"), gemischt aus
 * Red Bull, Powerade, Monster usw. Weil die genauen CSS-Klassen nicht bekannt
 * sind, wird jede Karte über ihren "Sfoglia Volantino"-Link gefunden: vom Link
 * aus geht es nach oben, bis ein Element Preis und "fino al" enthält, aber
 * noch nur EINEN dieser Links (sonst wären zwei Karten vermischt).
 * Grenze: nur die erste Seite ("Carica altri risultati" wird nicht geladen).
 */
function parseVolantinofacile(html, query, todayIso) {
  const $ = cheerio.load(html);
  const isCta = (_, x) => /sfoglia volantino/i.test($(x).text());
  const ctas = $("a").filter(isCta).toArray();
  const offers = [];
  const seen = new Set();
  let cards = 0;
  for (const a of ctas) {
    let node = $(a).parent();
    let card = null;
    for (let depth = 0; depth < 8 && node.length; depth++) {
      if (node.find("a").filter(isCta).length !== 1) break; // zu weit: mehrere Karten
      const t = textWithSpaces(node.get(0));
      if (/fino al/i.test(t) && /\d\s*€/.test(t)) { card = node; break; }
      node = node.parent();
    }
    if (!card) continue;
    cards++;
    const t = textWithSpaces(card.get(0));
    const cut = t.search(/dove lo compro/i);
    const name = (cut > 0 ? t.slice(0, cut) : card.find("img").first().attr("alt") || "").trim();
    if (!name.toLowerCase().includes(query.toLowerCase())) continue;
    if (/munch/i.test(name)) continue;
    const storeName = (card.find('img[src*="/retailers/"]').first().attr("alt") || "").trim();
    const pm = t.slice(cut > 0 ? cut : 0).match(/(\d+(?:,\d{1,2})?)\s*€/);
    const dm = t.match(/fino al\s+(\d{1,2})\s+([a-zà-ú]+)/i);
    if (!storeName || !pm || !dm) continue;
    const endIso = itDayMonthToIso(dm[1], dm[2], todayIso);
    if (!endIso || endIso < todayIso) continue; // abgelaufen
    const total = parseFloat(pm[1].replace(",", "."));
    if (Number.isNaN(total)) continue;
    let source = $(a).attr("href") || "";
    if (source.startsWith("/")) source = `https://www.volantinofacile.it${source}`;
    const o = buildItOffer({ storeName, name, total, endIso, source });
    const k = `${o.storeName}|${o.product}|${o.price}|${o.validUntil}`;
    if (seen.has(k)) continue;
    seen.add(k);
    offers.push(o);
  }
  return { offers, ctaCount: ctas.length, cards };
}

async function scrapeVolantinofacileIT(query) {
  if (!query.toLowerCase().includes("monster")) return [];
  const url = "https://www.volantinofacile.it/confronta-prezzi/spesa/acqua-alcolici-bibite/energy-drink";
  const { offers, ctaCount, cards } = parseVolantinofacile(await fetchHtml(url, IT_LANG), query, itTodayIso());
  console.log(`IT volantinofacile: ${ctaCount} Links, ${cards} Karten, ${offers.length} Monster-Angebote`);
  // Keine einzige Karte erkannt = Layout geändert oder Sperrseite -> Fehler
  // (wird dadurch nicht gecacht und taucht im Log auf).
  if (cards === 0) throw new Error("volantinofacile.it: keine Angebotskarten erkannt (Layout geändert?)");
  return offers;
}

/**
 * Scraper: tutti-sconti.it, Produktseite "Monster Energy".
 * Jedes Angebot ist ein Link auf /<kette>-offerte/volantino-..., dessen Text
 * Produkt, Kette, "dal 21/9 al 1/10/2026" und Preis ("0,99 EUR") enthält.
 * Die Seite zeigt nur Ketten, die diese Woche Monster Energy im Prospekt haben
 * - oft nur wenige.
 */
function parseTuttiSconti(html, query, todayIso) {
  const $ = cheerio.load(html);
  const offers = [];
  const seen = new Set();
  let links = 0;
  $("a").each((_, a) => {
    const href = $(a).attr("href") || "";
    const hm = href.match(/^(?:https?:\/\/(?:www\.)?tutti-sconti\.it)?\/([a-z0-9-]+)-offerte\/volantino-/i);
    if (!hm) return;
    links++;
    const text = textWithSpaces(a);
    const dm = text.match(/dal\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s+al\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
    const pm = text.match(/(\d+(?:,\d{1,2})?)\s*€/);
    if (!dm || !pm) return;
    if (!text.toLowerCase().includes(query.toLowerCase())) return;
    const endYear = parseInt(dm[6], 10);
    const endIso = `${endYear}-${pad2(dm[5])}-${pad2(dm[4])}`;
    const startYear = dm[3] ? parseInt(dm[3], 10) : (parseInt(dm[2], 10) > parseInt(dm[5], 10) ? endYear - 1 : endYear);
    const startIso = `${startYear}-${pad2(dm[2])}-${pad2(dm[1])}`;
    if (startIso > todayIso || endIso < todayIso) return; // nur aktuell gültig
    const alt = ($(a).find("img").first().attr("alt") || "").replace(/^logo\s*-\s*/i, "").trim();
    const storeName = alt || hm[1].replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    // Text vor "dal ..." ist "<Produkt> <Kette>" - Kette hinten abschneiden
    let name = text.split(/\s+dal\s+\d/i)[0].trim();
    if (name.toLowerCase().endsWith(storeName.toLowerCase())) name = name.slice(0, name.length - storeName.length).trim();
    if (/munch/i.test(name)) return;
    const total = parseFloat(pm[1].replace(",", "."));
    if (Number.isNaN(total)) return;
    const o = buildItOffer({
      storeName,
      name: name || "Monster Energy",
      total,
      endIso,
      source: href.startsWith("/") ? `https://tutti-sconti.it${href}` : href
    });
    const k = `${o.storeName}|${o.product}|${o.price}|${o.validUntil}`;
    if (seen.has(k)) return;
    seen.add(k);
    offers.push(o);
  });
  return { offers, links, title: $("title").first().text() };
}

async function scrapeTuttiScontiIT(query) {
  if (!query.toLowerCase().includes("monster")) return [];
  const url = "https://tutti-sconti.it/prodotti/monster-energy";
  const { offers, links, title } = parseTuttiSconti(await fetchHtml(url, IT_LANG), query, itTodayIso());
  console.log(`IT tutti-sconti: ${links} Angebotslinks, ${offers.length} gültige Angebote`);
  // Ohne Monster im Seitentitel ist es nicht die erwartete Seite (Sperre/Umbau)
  if (!/monster/i.test(title)) throw new Error("tutti-sconti.it: unerwartete Seite (kein Monster im Titel)");
  return offers;
}

/**
 * Scraper: tiendeo.<tld> (ShopFully-Netzwerk - dieselbe Plattform wie
 * volantinofacile.it für Italien, nur mit eigener Landesdomain pro Markt:
 * tiendeo.de, tiendeo.fr, tiendeo.pl, ...). Die Suchergebnisse stecken
 * strukturiert im Next.js __NEXT_DATA__-JSON unter
 * props.pageProps.apiResources.flyerGibsData.flyerGibs - keine
 * HTML-Textextraktion nötig, exakt dieselbe Feldstruktur in jedem Land
 * (live geprüft). Ein Scraper deckt damit auf einen Schlag viele Ketten
 * pro Land ab statt pro Kette einzeln gebaut werden zu müssen - bestätigt
 * u.a.: Conad/IT, E.Leclerc+Lidl+Metro/FR, Lidl+Dirck III/NL, Biedronka/PL,
 * Auchan+Pingo Doce/PT, Action+SPAR/BE, Lidl/AT, Coop/CZ, Føtex/DK,
 * Masoutis/GR, Interspar/HU, Kaufland/SK, ICA/SE.
 */
// round2() ist bereits oben (IT-Abschnitt) definiert.

// Stückzahl aus der Packungsbeschreibung, sprachunabhängig über Zahlen-
// Muster statt Wörter (die Seite liefert Beschreibungen in der jeweiligen
// Landessprache): "12 x 50 cl", "8x50 cl", "4x0.50l" -> Mehrfachpack-Anzahl.
// Nur eine einzelne Volumenangabe ("500 ml", "0,5 l", "50 cl") -> Einzeldose.
// Weder noch (z.B. "3+1 gratis", leer) -> unklar, nicht geraten.
function detectTiendeoPack(description) {
  const d = (description || "").toLowerCase();
  if (!d) return null;
  const multi = d.match(/(\d+)\s*[x×]\s*[\d.,]+\s*(ml|cl|l)\b/);
  if (multi) {
    const c = parseInt(multi[1], 10);
    return c >= 2 && c <= 30 ? c : null;
  }
  if (/\b\d{2,4}\s*ml\b/.test(d) || /\b\d+(?:[.,]\d+)?\s*(cl|l)\b/.test(d)) return 1;
  return null;
}

// Akzente entfernen (NFD-Zerlegung + Diakritika strippen), damit z.B.
// "énergisante" (FR) trotzdem auf "energ" matched.
function stripDiacritics(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Fremdprodukte, die ebenfalls "Monster" heißen (Puppen, Chips, Spielzeug ...).
// Wird nur angewendet, wenn kein "energ" im Text steht.
const MONSTER_FALSE_POSITIVES =
  /\b(high|poupee|poupees|doll|dolls|munch|jouet|jouets|peluche|puppe|puppen|spielzeug|figur|figurine|truck|jam|inc|university)\b/;

// Rabatt-Aktionen ohne Eurobetrag ("-50 % sur le 2ème", "-34 %"): der Text
// steckt je nach Land in unterschiedlichen Feldern, deshalb im ganzen Eintrag suchen.
function extractPromoText(g) {
  const hay = JSON.stringify(g || {});
  const m = hay.match(/-\s?\d{1,2}\s?%[^"\\]{0,25}/) || hay.match(/\d{1,2}\s?%[^"\\]{0,25}/);
  return m ? m[0].trim() : "";
}

async function scrapeTiendeo(tld, query) {
  const url = `https://www.tiendeo.${tld}/search?q=${encodeURIComponent(query)}`;
  const $ = cheerio.load(await fetchHtml(url, "en;q=0.9"));
  const raw = $("#__NEXT_DATA__").html();
  if (!raw) throw new Error(`tiendeo.${tld}: kein __NEXT_DATA__ gefunden (Layout geändert?)`);
  const gibs = JSON.parse(raw)?.props?.pageProps?.apiResources?.flyerGibsData?.flyerGibs || [];
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  for (const g of gibs) {
    const name = (g.title || "").trim();
    const storeName = (g.retailerName || "").trim();
    if (!name || !storeName) continue;
    const nameNorm = stripDiacritics(name.toLowerCase());
    // "Monster" trifft europaweit auch auf andere Produktlinien der Marke
    // (Monster High Puppen, Monster Munch Chips, u.ä.) - zusätzlich zum
    // Markennamen muss "energ" vorkommen (Energy/énergie/energético/
    // energetický/energiaital/... - in den meisten EU-Sprachen ein
    // gemeinsamer Wortstamm), sonst wären das falsche Treffer.
    if (!nameNorm.includes(query.toLowerCase())) continue;
    const fullText = stripDiacritics(`${name} ${g.description || ""}`.toLowerCase());
    // tiendeo liefert bei "Monster" auch Fremdprodukte (z.B. "Monster -
    // Toilettenpapier Family Edition", "Monster - Smashers Horror House").
    // Deshalb hier nicht nur offensichtliche Fremdprodukte ausschließen,
    // sondern einen positiven Getränke-Hinweis verlangen (energ, Dose, ml,
    // bekannte Sorte ...).
    if (MONSTER_FALSE_POSITIVES.test(fullText) || NON_DRINK.test(fullText)) continue;
    if (!DRINK_HINT.test(fullText)) continue;
    const digits = g.settings?.price_extended?.digits;
    const total = digits != null ? parseFloat(String(digits).replace(",", ".")) : NaN;
    const hasPrice = !Number.isNaN(total);
    const endIso = g.flyer?.end_date || "";
    if (endIso && endIso < today) continue; // abgelaufen
    const currency = g.settings?.price_extended?.currency_code || "EUR";
    const count = detectTiendeoPack(g.description);
    let price = hasPrice ? total : null;
    let packInfo;
    let promoText = "";
    if (!hasPrice) {
      // Prozent-Aktion ohne Eurobetrag
      promoText = extractPromoText(g);
      packInfo = promoText ? `Rabatt-Aktion: ${promoText}` : "Rabatt-Aktion (Preis im Prospekt)";
    } else if (count && count > 1) {
      price = round2(total / count);
      packInfo = `Nur im Mehrfachpack (${total.toFixed(2)} ${currency} gesamt)`;
    } else if (count === 1) {
      packInfo = "Einzeldose";
    } else {
      packInfo = "Nicht eindeutig erkennbar";
    }
    out.push({
      storeName,
      product: name,
      packInfo,
      price,
      // Pfandsysteme unterscheiden sich stark zwischen Ländern und stehen
      // nicht zuverlässig in den Daten - ehrlich 0 statt geraten, außer der
      // Text nennt es explizit (DE: fast immer "zzgl. ... Pfand").
      deposit: /pfand/i.test(g.description || "") ? 0.25 : 0,
      regularPrice: null,
      validUntil: formatDate(endIso),
      currency,
      promoText,
      source: url
    });
  }
  return out;
}

function makeTiendeoScraper(tld) {
  const fn = (query) => scrapeTiendeo(tld, query);
  Object.defineProperty(fn, "name", { value: `scrapeTiendeo_${tld}` });
  return fn;
}

/**
 * Scraper: energy-angebote.de (Preisvergleich nur für Energy Drinks).
 * Sammelt Monster-Energy-0,5-l-Angebote aus sehr vielen Prospekten,
 * auch von Getränkemärkten (HIT, HOL'AB, K+K, Alldrink, GetränkeLAND ...),
 * die sonst keine Quelle abdeckt. Die Seite liefert strukturierte Daten
 * (JSON-LD: Product -> AggregateOffer -> Offer mit seller, price,
 * priceValidUntil). Fallback: Textliste "<Händler> bis TT.MM.JJJJ Preis: 0,99 €".
 * Die Seite bezieht sich auf die 0,5-l-Dose, deshalb Preis = Dosenpreis.
 */
function collectLdOffers(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach((n) => collectLdOffers(n, out));
  const type = [].concat(node["@type"] || []);
  if (type.includes("Offer") && node.price != null) out.push(node);
  for (const v of Object.values(node)) if (v && typeof v === "object") collectLdOffers(v, out);
}

function isoToDe(iso) {
  return formatDate(String(iso || "").slice(0, 10));
}

async function scrapeEnergyAngebote(query) {
  if (!query.toLowerCase().includes("monster")) return [];
  const url = "https://energy-angebote.de/monster-energy-0-5l";
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
  const out = [];
  const add = (storeName, price, validUntilIso, validFromIso = "") => {
    storeName = String(storeName || "").trim();
    if (!storeName || Number.isNaN(price) || price <= 0 || price > 5) return;
    if (validUntilIso && validUntilIso < today) return; // abgelaufen
    if (validFromIso && validFromIso > today) return; // startet erst später
    out.push({
      storeName,
      product: "Monster Energy 0,5 l",
      packInfo: "Einzeldose",
      price,
      deposit: 0.25,
      regularPrice: null,
      validUntil: isoToDe(validUntilIso),
      source: url
    });
  };

  const ldOffers = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try { collectLdOffers(JSON.parse($(el).html() || ""), ldOffers); } catch { /* kaputter Block */ }
  });
  for (const o of ldOffers) {
    const seller = typeof o.seller === "string" ? o.seller : o.seller?.name;
    add(seller, parseFloat(String(o.price).replace(",", ".")), String(o.priceValidUntil || "").slice(0, 10), String(o.validFrom || "").slice(0, 10));
  }

  // Fallback ohne JSON-LD: "Penny bis 24.10.2026 Preis: 0,99 €"
  if (out.length === 0) {
    $("script,style,noscript").remove();
    const text = $("body").text().replace(/\s+/g, " ");
    const re = /([A-Za-zÄÖÜäöüß'+.\- ]{2,30}?) bis (\d{2})\.(\d{2})\.(\d{4}) Preis: (\d+,\d{2}) €/g;
    let m;
    while ((m = re.exec(text))) add(m[1], parseFloat(m[5].replace(",", ".")), `${m[4]}-${m[3]}-${m[2]}`);
  }
  console.log(`energy-angebote.de: ${ldOffers.length} JSON-LD-Offers, ${out.length} gültige Angebote`);
  if (!/monster/i.test($("title").text())) throw new Error("energy-angebote.de: unerwartete Seite");
  return out;
}

const SCRAPERS_DE = [scrapeTrinkgut, scrapeKaufland, scrapeAldiNord, scrapeMeinprospekt, scrapeEnergyAngebote, makeTiendeoScraper("de")];
const SCRAPERS_IT = [scrapeVolantinofacileIT, scrapeTuttiScontiIT, makeTiendeoScraper("it")];

// Je Land: Scraper + Filialsuche. storeOsmTag "" = keine Einschränkung (wie
// bisher in DE), "shop" = nur Läden (kurze Kettennamen wie "MD"/"SPAR"
// treffen sonst auch Orte/Personen).
const COUNTRIES = {
  DE: { scrapers: SCRAPERS_DE, storeOsmTag: "" },
  IT: { scrapers: SCRAPERS_IT, storeOsmTag: "shop" }
};

// Weitere EU-Länder, bisher nur über tiendeo abgedeckt (1 Quelle statt wie
// DE/IT mehrere) - live mit echten Monster-Energy-Treffern verifiziert.
// Nächster Ausbauschritt: pro Land eine zweite, unabhängige Quelle finden.
for (const cc of ["FR", "NL", "PL", "PT", "BE", "AT", "CZ", "DK", "GR", "HU", "SK", "SE"]) {
  COUNTRIES[cc] = { scrapers: [makeTiendeoScraper(cc.toLowerCase())], storeOsmTag: "shop" };
}

// Scraper-Ergebnisse sind nicht ortsabhängig (nationale Prospektdaten) und
// werden deshalb einmal pro Scraper 6 h gecacht statt pro Stadt neu geladen -
// wichtig für Italien mit vielen Einzelseiten. Fehler werden nicht gecacht.
const scrapeCache = new Map();
async function cachedScrape(fn, query) {
  const key = `${fn.name}|${query}`;
  const hit = scrapeCache.get(key);
  if (hit && Date.now() - hit.time < CACHE_MS) return hit.offers;
  const offers = await fn(query);
  scrapeCache.set(key, { time: Date.now(), offers });
  return offers;
}

/* ---------- Plausibilitäts-Filter (für alle Quellen) ---------- */

// Text für Vergleiche: klein, ohne Akzente/Umlaute ("Plüsch" -> "plusch").
function normText(s) {
  return stripDiacritics(String(s || "").toLowerCase());
}

// Produkte, die zwar "Monster" heißen, aber kein Getränk sind.
const NON_DRINK =
  /\b(toilettenpapier|klopapier|papier|kuchenrolle|taschentuch\w*|tissue|smashers|horror|spielzeug|spielset|spielfigur\w*|figur|figuren|puppe|puppen|plusch\w*|plush|chips|snack|socken|shirt|kopfhorer|headphones?|lego|playmobil|kostum|maske|zahnburste|brotdose|trinkflasche|rucksack)\b/;

// Positiver Hinweis, dass es wirklich ein (Energy-)Getränk ist.
const DRINK_HINT =
  /(energ|\bdrinks?\b|\bdosen?\b|\bcans?\b|lattin|\d\s*(ml|cl|l)\b|\bultra\b|juiced?\b|rehab|mango loco|pipeline|khaotic|nitro|reserve|\bzero\b|\bjava\b)/;

function isPlausibleProduct(o) {
  return !NON_DRINK.test(normText(o.product));
}

// "14.04.2027" -> Date (oder null)
function parseDeDate(s) {
  const m = String(s || "").match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])) : null;
}

// Prospekt-Angebote laufen ca. 1-2 Wochen. Ein Enddatum mehr als 31 Tage in
// der Zukunft ist kein echtes Angebot (z.B. Dauerprospekt / falsches Feld).
const MAX_VALID_DAYS = 31;
function hasPlausibleValidity(o) {
  const d = parseDeDate(o.validUntil);
  if (!d) return true; // unbekanntes Datum: nicht deshalb verwerfen
  return d.getTime() - Date.now() <= MAX_VALID_DAYS * 24 * 60 * 60 * 1000;
}

// Gleiches Angebot aus mehreren Prospekten/Quellen nur einmal behalten.
function dedupe(offers, keyFn) {
  const seen = new Set();
  return offers.filter((o) => {
    const k = keyFn(o);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
// Kette + Preis: dasselbe Angebot heißt je nach Quelle anders ("Monster
// Energy-Drink" vs. "Monster Energy 0,5 l"). Die zuerst gelistete Quelle
// gewinnt (meinprospekt vor energy-angebote, weil mit Streichpreis).
const offerKey = (o) => `${normText(o.storeName).replace(/[^a-z0-9]+/g, "")}|${o.price}`;

const DEFAULT_RADIUS_KM = 25;
const MAX_RADIUS_KM = 100;

function radiusFrom(req) {
  const r = parseFloat(req.query.radiusKm);
  if (Number.isNaN(r) || r <= 0) return DEFAULT_RADIUS_KM;
  return Math.min(r, MAX_RADIUS_KM);
}

/**
 * Letzter Filter vor der Antwort (läuft auch auf Cache-Treffern):
 *  - nur Filialen im Umkreis radiusKm (Standard 25 km, max. 100 km)
 *  - Angebote ohne Eurobetrag (nur Prozent-Rabatt) nur mit ?includePromo=1
 *  - Angebote mit unklarer Packungsgröße nur mit ?includeUnclear=1
 */
function forClient(offers, req, lat, lon) {
  const radiusKm = radiusFrom(req);
  return offers.filter((o) => {
    if (haversineKm(lat, lon, o.lat, o.lon) > radiusKm) return false;
    if (o.price == null && req.query.includePromo !== "1") return false;
    if (o.packInfo === "Nicht eindeutig erkennbar" && req.query.includeUnclear !== "1") return false;
    return true;
  });
}

// Ketten, die es nur in bestimmten Bundesländern gibt (Photon-"state").
// Schlüssel: Kettenname klein, ohne Sonder-/Leerzeichen, als Präfix.
const REGIONAL_CHAINS = {
  getrankeland: ["Mecklenburg-Vorpommern", "Brandenburg", "Berlin"],
  holab: ["Niedersachsen", "Bremen", "Hamburg", "Schleswig-Holstein", "Nordrhein-Westfalen", "Sachsen-Anhalt"],
  kk: ["Nordrhein-Westfalen", "Niedersachsen"],
  nettomitdemscottie: ["Mecklenburg-Vorpommern", "Brandenburg", "Berlin", "Sachsen", "Sachsen-Anhalt", "Schleswig-Holstein", "Hamburg", "Niedersachsen"]
};

// Obergrenze für Filial-Suchen pro Anfrage (Photon ist ein öffentlicher Dienst)
const MAX_GEOCODED_STORES = 30;

/* ---------- Endpunkt ---------- */
app.get("/offers", async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    const product = req.query.q || "Monster Energy";
    // Die Scraper suchen nach der Marke, nicht dem vollen Produktnamen
    const brandQuery = product.split(" ")[0];
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      return res.status(400).json({ error: "lat und lon erforderlich" });
    }

    const place = await reverseGeocode(lat, lon);
    // Ohne erkanntes Land (Photon liefert nichts) wie bisher Deutschland annehmen
    const country = place.countryCode || "DE";
    const cfg = COUNTRIES[country];
    if (!cfg) return res.json([]); // Land (noch) nicht unterstützt
    const key = `v5|${country}|${place.city}|${brandQuery}`;

    const hit = cache.get(key);
    if (hit && Date.now() - hit.time < CACHE_MS) {
      return res.json(forClient(hit.offers, req, lat, lon));
    }

    const settled = await Promise.allSettled(cfg.scrapers.map((fn) => cachedScrape(fn, brandQuery)));
    const rawAll = settled.flatMap((r, i) => {
      if (r.status === "fulfilled") return r.value;
      console.error(`Scraper ${cfg.scrapers[i].name} failed:`, r.reason?.message || r.reason);
      return [];
    });
    // Fremdprodukte und unplausible Laufzeiten raus, Duplikate zusammenfassen
    const raw = dedupe(
      rawAll.filter(isPlausibleProduct).filter(hasPlausibleValidity),
      offerKey
    );

    // Filialen je Kette nur einmal pro Anfrage suchen (mehrere Angebote
    // derselben Kette teilen sich das Ergebnis). Bis zu 3 Filialen je Kette,
    // Distanz-Filter (>100km) und Länderfilter stecken in geocodeStores().
    // Fällt eine Suche aus, verliert nur diese Kette ihre Filialen.
    const branchMemo = new Map();
    const offers = [];
    for (const [i, o] of raw.entries()) {
      let branches = branchMemo.get(o.storeName);
      if (!branches) {
        if (branchMemo.size >= MAX_GEOCODED_STORES) continue;
        try {
          // Kurze Namen wie "HIT" oder "K+K" nur unter Läden suchen, sonst
          // treffen sie Orte/Straßen.
          const osmTag = cfg.storeOsmTag || (o.storeName.replace(/[^A-Za-z]/g, "").length <= 4 ? "shop" : "");
          branches = await geocodeStores(o.storeName, lat, lon, 3, 100, country, osmTag);
        } catch (e) {
          console.error(`geocodeStores(${o.storeName}) failed:`, e?.message || e);
          branches = [];
        }
        branchMemo.set(o.storeName, branches);
        await new Promise((r) => setTimeout(r, 300)); // höflicher Abstand zwischen Anfragen
      }
      // "Netto" allein (ohne "Marken-Discount") ist bei den Quellen die
      // rot-gelbe Netto-Kette mit dem Scottie-Hund (nur Nord/Ost). Ihre
      // Angebote dürfen nicht auf Filialen von Netto Marken-Discount gelegt
      // werden - das sind zwei verschiedene Firmen mit eigenen Prospekten.
      const isScottieNetto = /^netto\b/i.test(o.storeName) && !/marken/i.test(o.storeName);
      let usable = isScottieNetto ? branches.filter((b) => !/marken/i.test(b.address)) : branches;
      // Regionale Ketten: Photon findet sonst gleichnamige, aber fremde Läden
      // (z.B. "Getränkeland Kaufmann" in Gladenbach statt der GetränkeLAND-
      // Kette aus dem Nordosten). Nur Filialen im Verbreitungsgebiet zulassen.
      const regionKey = Object.keys(REGIONAL_CHAINS).find((k) => normText(o.storeName).replace(/[^a-z0-9]/g, "").startsWith(k));
      if (regionKey) usable = usable.filter((b) => REGIONAL_CHAINS[regionKey].includes(b.state));
      usable.forEach((geo, j) => {
        // currency-Fallback für die älteren DE/IT-Scraper, die das Feld noch
        // nicht selbst setzen (die waren immer EUR, nie etwas anderes).
        offers.push({
          id: `${key}-${i}-${j}`,
          ...o,
          currency: o.currency || "EUR",
          storeAddress: geo.address,
          lat: geo.lat,
          lon: geo.lon
        });
      });
    }

    // Sicherheitsnetz: dieselbe Filiale mit demselben Angebot nur einmal
    const uniqueOffers = dedupe(offers, (o) => `${offerKey(o)}|${normText(o.storeAddress)}`);
    offers.length = 0;
    offers.push(...uniqueOffers);

    // Nur cachen, wenn mindestens ein Scraper geklappt hat - sonst würde ein
    // kurzer Ausfall 6 Stunden lang eine leere Liste festhalten.
    if (settled.some((r) => r.status === "fulfilled")) cache.set(key, { time: Date.now(), offers });
    res.json(forClient(offers, req, lat, lon));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

// Zeigt je italienischem Scraper, was er gefunden hat (nutzt den 6-h-Cache,
// löst also höchstens alle 6 h einen echten Scrape aus).
app.get("/debug/it", async (_, res) => {
  const result = {};
  for (const fn of SCRAPERS_IT) {
    try {
      const offers = await cachedScrape(fn, "Monster");
      result[fn.name] = { ok: true, count: offers.length, offers };
    } catch (e) {
      result[fn.name] = { ok: false, error: String(e?.message || e) };
    }
  }
  res.json(result);
});

// Diagnose: Was liefern die italienischen Quellen an DIESEN Server? Manche
// Seiten geben Cloud-IPs (Render) anderen Inhalt als einem normalen Browser.
// Feste Liste, keine frei wählbare URL. Ausgabe als Text (handy-tauglich),
// Ergebnis 10 Minuten gemerkt, damit ein Aufruf nicht jedes Mal alle Seiten lädt.
// euroLinks = Links, in deren Text ein Preis (EUR-Zeichen) steht; sample = Text
// des ersten - zeigt, wie eine Angebotskarte aufgebaut ist.
const IT_DEBUG_SOURCES = [
  "https://www.volantinofacile.it/confronta-prezzi/spesa/acqua-alcolici-bibite/energy-drink",
  "https://tutti-sconti.it/prodotti/monster-energy",
  "https://www.promoqui.it/offerte/monster-energy"
];
let debugSourcesCache = { time: 0, text: "" };

app.get("/debug/sources", async (_, res) => {
  if (Date.now() - debugSourcesCache.time < 10 * 60 * 1000) {
    return res.type("text/plain").send(debugSourcesCache.text);
  }
  const lines = [];
  for (const url of IT_DEBUG_SOURCES) {
    const short = url.replace(/^https:\/\/(www\.)?/, "");
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": UA, "Accept-Language": IT_LANG },
        signal: AbortSignal.timeout(20000)
      });
      const body = await r.text();
      const $ = cheerio.load(body);
      $("script,style,noscript").remove();
      const euroLinks = $("a").toArray().filter((a) => /€/.test(textWithSpaces(a)));
      lines.push(
        [
          short,
          `HTTP ${r.status}`,
          `${Math.round(body.length / 1024)} KB`,
          `title="${($("title").first().text() || "").trim().slice(0, 60)}"`,
          `tables=${(body.match(/<table/gi) || []).length}`,
          `monster=${(body.match(/monster/gi) || []).length}`,
          `euroLinks=${euroLinks.length}`,
          `sample="${euroLinks[0] ? textWithSpaces(euroLinks[0]).slice(0, 140) : ""}"`
        ].join(" | ")
      );
    } catch (e) {
      lines.push(`${short} | FEHLER ${e?.message || e}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  const text = lines.join("\n\n");
  debugSourcesCache = { time: Date.now(), text };
  res.type("text/plain").send(text);
});

// Rohdaten der Tiendeo-Treffer für ein Land, z.B. /debug/tiendeo?tld=fr
app.get("/debug/tiendeo", async (req, res) => {
  const tld = String(req.query.tld || "fr").toLowerCase();
  if (!COUNTRIES[tld.toUpperCase()]) return res.status(400).json({ error: "unbekanntes Land" });
  try {
    const q = String(req.query.q || "Monster");
    const $ = cheerio.load(await fetchHtml(`https://www.tiendeo.${tld}/search?q=${encodeURIComponent(q)}`, "en;q=0.9"));
    const raw = $("#__NEXT_DATA__").html();
    const gibs = JSON.parse(raw)?.props?.pageProps?.apiResources?.flyerGibsData?.flyerGibs || [];
    res.json({ total: gibs.length, gibs: gibs.slice(0, 12) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Diagnose für neue/kaputte Quellen: feste Liste (keine frei wählbare URL),
// Textausgabe. Zeigt, wie die Seite AUF DEM SERVER aussieht: Status, Größe,
// __NEXT_DATA__/JSON-LD und Textstellen rund um "Monster".
const PROBE_SOURCES = {
  kaufda: "https://www.kaufda.de/Angebote/Monster-Energy",
  energy: "https://energy-angebote.de/monster-energy-0-5l",
  trinkgut: "https://www.trinkgut.de/angebote",
  meinprospekt: "https://www.meinprospekt.de/angebote/monster-energy"
};

function findJsonPaths(node, path, out, depth = 0) {
  if (out.length >= 6 || depth > 14 || !node || typeof node !== "object") return;
  const s = JSON.stringify(node);
  if (!/monster/i.test(s)) return;
  // kleinstes Objekt, das Monster enthält und nicht zu groß ist
  if (s.length < 1500 && !Array.isArray(node)) {
    out.push(`${path}: ${s.slice(0, 1200)}`);
    return;
  }
  for (const [k, v] of Object.entries(node)) findJsonPaths(v, `${path}.${k}`, out, depth + 1);
}

app.get("/debug/probe/:src", async (req, res) => {
  const src = String(req.params.src || "");
  const url = PROBE_SOURCES[src];
  if (!url) return res.status(400).type("text/plain").send(`src = ${Object.keys(PROBE_SOURCES).join(" | ")}`);
  const lines = [];
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "de-DE,de;q=0.9" }, signal: AbortSignal.timeout(25000) });
    const html = await r.text();
    const $ = cheerio.load(html);
    lines.push(`URL ${url}`, `HTTP ${r.status} | ${Math.round(html.length / 1024)} KB | title="${$("title").first().text().trim().slice(0, 80)}"`);
    const nd = $("#__NEXT_DATA__").html();
    lines.push(`__NEXT_DATA__: ${nd ? Math.round(nd.length / 1024) + " KB" : "nein"}`);
    if (nd) {
      const out = [];
      try { findJsonPaths(JSON.parse(nd), "root", out); } catch (e) { out.push(`parse-fehler ${e.message}`); }
      lines.push("JSON-Treffer:", ...out);
    }
    const ld = $('script[type="application/ld+json"]').toArray().map((x) => $(x).html() || "");
    lines.push(`JSON-LD: ${ld.length} Blöcke, mit Monster: ${ld.filter((x) => /monster/i.test(x)).length}`);
    ld.filter((x) => /monster/i.test(x)).slice(0, 2).forEach((x) => lines.push(`LD: ${x.slice(0, 1500)}`));
    lines.push(`.product-box: ${$(".product-box").length}`);
    // Klassen der Elemente, die einen Preis + Monster enthalten (Karten finden)
    const cards = $("*").toArray().filter((el) => {
      const t = $(el).text();
      return t.length < 400 && /monster/i.test(t) && /\d,\d{2}/.test(t) && $(el).children().length > 1;
    }).slice(0, 5);
    cards.forEach((el) => lines.push(`KARTE <${el.tagName} class="${$(el).attr("class") || ""}">: ${textWithSpaces(el).slice(0, 300)}`));
    $("script,style,noscript").remove();
    const text = $("body").text().replace(/\s+/g, " ");
    let idx = 0;
    for (let n = 0; n < 6; n++) {
      const i = text.toLowerCase().indexOf("monster", idx);
      if (i < 0) break;
      lines.push(`TEXT: …${text.slice(Math.max(0, i - 120), i + 220)}…`);
      idx = i + 400;
    }
  } catch (e) {
    lines.push(`FEHLER ${e?.message || e}`);
  }
  res.type("text/plain").send(lines.join("\n\n"));
});

app.get("/health", (_, res) => res.send("ok"));
app.listen(PORT, () => console.log(`läuft auf :${PORT}`));
