/**
 * MonsterDeals Backend
 *
 * Endpunkt: GET /offers?lat=..&lon=..&radiusKm=..&q=Monster Energy
 *
 * Ablauf:
 *  1. Koordinaten -> Ort/PLZ per Photon (OSM-basiert, https://photon.komoot.io)
 *  2. Direktes Scraping der oeffentlichen Angebotsseiten einzelner Haendler
 *     (kein LLM, keine Kosten, kein API-Key) nach dem gesuchten Produkt
 *  3. Bis zu 3 nächstgelegene Filialen je Treffer per Photon geokodieren
 *     (geocodeStores), damit die App auch mehrere Filialen derselben
 *     Kette in der Naehe anzeigen kann, nicht nur die naechste
 *  4. Ergebnis wird 6 Stunden gecacht
 *
 * Abdeckung / bekannte Einschraenkungen:
 *  - Aldi Nord, Trinkgut, Kaufland: direkt von der jeweiligen Haendler-
 *    Seite, funktionieren zuverlaessig.
 *  - scrapeMeinprospekt(): zusaetzlich meinprospekt.de (Prospekt-
 *    Aggregator), Ketten-uebergreifend - zeigt automatisch, welche Kette
 *    diese Woche Monster Energy im Prospekt hat (z.B. Lidl, Penny, ggf.
 *    auch REWE, EDEKA etc., je nachdem wer aktuell ein Angebot hat). Als
 *    SEO-Seite ohne aggressiven Bot-Schutz, kein curl/Browser noetig.
 *  - REWE/EDEKA/Aldi Sued/Netto DIREKT (auf deren eigener Seite) sind NICHT
 *    eingebaut: liefern 403 (Bot-Schutz) bzw. bei REWE liefert selbst curl
 *    von jedem getesteten Render-Standort (Oregon UND Frankfurt) nur die
 *    generische Homepage statt der Angebotsseite - also eine IP-Bereich-
 *    Sperre gegen Cloud-Hosting generell, keine Geo-Sperre. Ein echter Fix
 *    (Proxy mit Residential-IP o.ae.) waere ein aktiver Bot-Erkennungs-
 *    Bypass und wurde deshalb bewusst nicht gebaut. Diese Ketten koennen
 *    aber trotzdem über scrapeMeinprospekt() auftauchen, sobald sie dort
 *    ein Angebot haben.
 *    (Ein zuvor versuchter echter Headless-Chrome via puppeteer-core +
 *    @sparticuz/chromium haette zusaetzlich Render's 512-MB-Gratis-Tier
 *    mit Out-of-Memory abgeschossen.)
 *  - Alle Preise sind national/online-Prospekt-Daten, nicht filialscharf.
 *    Die Distanz bezieht sich auf die naechste per Photon gefundene
 *    Filiale der Kette, nicht auf den tatsaechlichen Angebotsort.
 *  - Bricht potenziell, wenn eine Seite ihr Layout umbaut.
 *
 * Laender (COUNTRIES weiter unten):
 *  - Das Land kommt aus der Photon-Geokodierung der Nutzerposition. Je Land
 *    gibt es eigene Scraper, eigene Filial-Suche (nur Filialen im selben
 *    Land) und einen eigenen Cache-Schluessel.
 *  - DE: wie bisher.
 *  - IT (Florenz usw.): scrapeOffertevolantiniIT() liest offertevolantini.it
 *    (italienischer Prospekt-Aggregator, "volantini"). Pro Kette gibt es dort
 *    eine Seite /offerte/monster/<kette> mit Angebotstabelle (Name, Negozio,
 *    Preis, Start-/Enddatum) - nur aktuell gueltige Zeilen werden uebernommen.
 *    Welche Ketten abgefragt werden, steht in IT_CHAIN_SLUGS. Unter
 *    /debug/it sieht man, welche Kettenseiten geklappt haben.
 *  - Kein Einwegpfand in Italien -> deposit: 0.
 *  - Nicht unterstuetzte Laender liefern eine leere Liste.
 */
import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 8080;
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

/* ---------- Geocoding ueber Photon (OSM-basiert) ---------- */
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
 * Findet die naechsten Filialen einer Kette (nicht nur eine). Gibt bis zu
 * maxResults Stueck zurueck, sortiert nach Entfernung, jede innerhalb von
 * maxKm - damit z.B. "Penny" nicht nur eine, sondern mehrere Filialen in
 * der Naehe zeigt, falls es dort mehrere gibt.
 */
async function geocodeStores(name, nearLat, nearLon, maxResults = 3, maxKm = 100, countryCode = "DE", osmTag = "") {
  // NUR den Kettennamen suchen, ohne Stadt im Suchtext: Photons Textsuche
  // kombiniert "Kette, kleiner Ort" oft schlecht (fand z.B. fuer "Lidl,
  // Amoeneburg" NICHTS, obwohl "Lidl" allein + lat/lon-Gewichtung sofort
  // mehrere echte Filialen in 10-25km Entfernung lieferte). lat/lon-
  // Gewichtung reicht fuer die Naehe-Sortierung voellig aus.
  const q = encodeURIComponent(name);
  // osmTag (z.B. "shop") schraenkt auf Laeden ein - noetig fuer kurze Kettennamen
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
        distanceKm: haversineKm(nearLat, nearLon, lat, lon)
      };
    })
    .filter((c) => c.distanceKm <= maxKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  // Duplikate vermeiden (Photon liefert manchmal dieselbe Filiale mehrfach
  // mit minimal unterschiedlichen Koordinaten, z.B. Eingang vs. Gebaeude).
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
  // Seitenweite Gueltigkeit, gilt fuer alle Angebote auf der Seite:
  // "Gueltig vom 07.09.2026 bis 12.09.2026"
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
    // stattdessen am Bild-Dateinamen erkennen (Trinkgut haengt "dpg" an,
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
  // "Gueltig vom 03.09. bis 09.09." - ohne Jahr, deshalb aktuelles Jahr
  // ergaenzen (die Seite zeigt immer nur die laufende Angebotswoche).
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
  const CAN_LITERS = 0.5; // Standard-Dosengroesse fuer Energy Drinks in DE
  const CAN_DEPOSIT = 0.25; // Einwegpfand pro Dose
  return matches.map((p) => {
    // Aldi Nord liefert keine Stueckzahl, nur einen Gesamtpreis (oft ein
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
 * Listet Monster-Energy-Angebote ketten-uebergreifend auf einer festen
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
  // Jede Angebotskarte: <p>Haendler</p><p>Marke</p><p>Produktart</p>, dann
  // Preis (.text-primary) und optional Streichpreis (.line-through).
  const CAN_LITERS = 0.5; // Standard-Dosengroesse fuer Energy Drinks in DE
  $("#OfferGrid [role=\"listitem\"]").each((_, el) => {
    const ps = $(el).find("p");
    const storeName = $(ps.get(0)).text().trim();
    const brand = $(ps.get(1)).text().trim();
    const productType = $(ps.get(2)).text().trim();
    const priceText = $(el).find(".text-primary").first().text().trim();
    const totalPrice = parseFloat(priceText.replace(",", "."));
    if (!storeName || Number.isNaN(totalPrice)) return;
    const oldPriceText = $(el).find(".line-through").first().text().trim();
    const regularPrice = oldPriceText ? parseFloat(oldPriceText.replace(",", ".")) : null;
    // Jede Karte hat eine Grundpreis-Notiz wie "(1 l = 1.78)". Das ist der
    // Gesamtpreis geteilt durch die tatsaechliche Packungsgroesse in Litern -
    // damit laesst sich ein echter Dosenpreis berechnen, auch fuer
    // Mehrfachpackungen, statt nur zu vermuten/zu warnen. Getestet: bei
    // bereits als Einzeldose ausgezeichneten Angeboten (Lidl) ergibt das
    // exakt den angezeigten Preis zurueck.
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
    // Ohne Grundpreis-Notiz ("1 l = ...") laesst sich Einzeldose vs.
    // Mehrfachpack nicht wirklich pruefen - dann NICHT stillschweigend
    // "Einzeldose" behaupten (waere geraten, nicht erkannt), sondern
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

/* ---------- Italien: offertevolantini.it (Prospekt-Aggregator) ---------- */
const IT_LANG = "it-IT,it;q=0.9";
const IT_BASE = "https://www.offertevolantini.it";

// Ketten, deren Seite /offerte/monster/<slug> abgefragt wird. Der Slug ist der
// Kettenname in der URL von offertevolantini.it. Nicht jede Kette hat dort
// eine Monster-Seite (dann kommt 404 und wird uebersprungen - siehe /debug/it).
// Die Liste ist auf Mittelitalien/Toskana (Florenz) und die grossen
// landesweiten Ketten ausgelegt; einfach ergaenzen, wenn eine Kette fehlt.
// Ketten ohne Filiale im Umkreis fallen spaeter durch die Filialsuche raus.
const IT_CHAIN_SLUGS = [
  "coop", "unicoop-firenze", "unicoop-etruria", "ipercoop",
  "conad", "conad-superstore", "spazio-conad",
  "esselunga", "carrefour", "carrefour-market",
  "lidl", "aldi", "eurospin", "md", "penny", "pam",
  "eurospar", "despar", "crai", "todis", "bennet"
];

const IT_MONTHS = {
  gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6,
  luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12
};

// Ergebnis des letzten echten IT-Scrapes (fuer /debug/it)
let lastItReport = [];

// "21 settembre 2026" -> "2026-09-21" (leer, wenn nicht lesbar)
function parseItDate(text) {
  const m = String(text || "").trim().toLowerCase().match(/^(\d{1,2})\s+([a-zà-ú]+)\s+(\d{4})$/);
  if (!m) return "";
  const month = IT_MONTHS[m[2]];
  if (!month) return "";
  return `${m[3]}-${String(month).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

// "€0,99" -> 0.99
function parseEuro(text) {
  const m = String(text || "").match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(",", "."));
  return Number.isNaN(v) ? null : v;
}

// Stueckzahl aus dem Produktnamen, z.B. "4 x 50 cl", "pacco da 4", "6 lattine".
// Ohne Hinweis: 1.
function detectPackCount(name) {
  const n = name.toLowerCase();
  let m = n.match(/(\d+)\s*[x×]\s*\d/);
  if (!m) m = n.match(/(?:pacco|confezione|conf\.?|pack)\s*(?:da\s*)?(\d+)/);
  if (!m) m = n.match(/(\d+)\s*(?:lattine|pezzi|pz)\b/);
  const c = m ? parseInt(m[1], 10) : 1;
  return c >= 2 && c <= 24 ? c : 1;
}

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Liest die Angebotstabellen einer offertevolantini.it-Seite. Spalten werden
 * ueber die Kopfzeile gefunden (Nome, Negozio, Prezzo normale, Prezzo in
 * offerta, Data d'inizio, Data di fine), nicht ueber feste Positionen.
 * Uebernommen werden nur Zeilen, die HEUTE gueltig sind und einen Preis haben
 * (die Seiten enthalten auch abgelaufene Angebote als Preisverlauf sowie
 * reine Prozent-Rabatte ohne Preis).
 * Gibt { offers, tableCount } zurueck - tableCount = gefundene Angebotstabellen,
 * damit ein Layout-Umbau auffaellt.
 */
function parseItOfferTables(html, query, todayIso, source) {
  const $ = cheerio.load(html);
  const offers = [];
  let tableCount = 0;
  $("table").each((_, table) => {
    const rows = $(table).find("tr").toArray();
    if (rows.length < 2) return;
    const headers = $(rows[0]).children("th,td").map((_, c) => $(c).text().trim().toLowerCase()).get();
    const col = (re) => headers.findIndex((h) => re.test(h));
    const iName = col(/^nome/);
    const iStore = col(/negozio/);
    const iRegular = col(/prezzo normale/);
    const iPrice = col(/prezzo in offerta/);
    const iStart = col(/inizio/);
    const iEnd = col(/fine/);
    if ([iName, iStore, iPrice, iStart, iEnd].some((i) => i < 0)) return; // keine Angebotstabelle
    tableCount++;
    for (const row of rows.slice(1)) {
      const cells = $(row).children("th,td").map((_, c) => $(c).text().trim().replace(/\s+/g, " ")).get();
      const name = cells[iName];
      const storeName = cells[iStore];
      if (!name || !storeName) continue;
      if (!name.toLowerCase().includes(query.toLowerCase())) continue;
      if (/munch/i.test(name)) continue; // Snack, kein Getraenk
      const start = parseItDate(cells[iStart]);
      const end = parseItDate(cells[iEnd]);
      if (!start || !end) continue;
      if (start > todayIso || end < todayIso) continue; // nur aktuell gueltig
      const total = parseEuro(cells[iPrice]);
      if (total == null) continue; // z.B. nur "-30%" ohne Preis
      const regularTotal = iRegular >= 0 ? parseEuro(cells[iRegular]) : null;

      // Preis pro Dose: nur umrechnen, wenn der Name eine Stueckzahl verraet.
      // Ohne Hinweis ist ein Preis bis 1,99 EUR mit hoher Sicherheit eine
      // Einzeldose (0,5-l-Dose kostet im Angebot ca. 0,70-1,60 EUR); darueber
      // ist es oft ein 4er-Pack ("MONSTER 3,99") - dann ehrlich als unklar
      // kennzeichnen statt Einzeldose zu behaupten.
      const count = detectPackCount(name);
      let price = total;
      let regularPrice = regularTotal != null && regularTotal > total ? regularTotal : null;
      let packInfo;
      if (count > 1) {
        price = round2(total / count);
        if (regularPrice != null) regularPrice = round2(regularPrice / count);
        packInfo = `Nur im Mehrfachpack (${total.toFixed(2)} EUR gesamt)`;
      } else if (total <= 1.99) {
        packInfo = "Einzeldose";
      } else {
        packInfo = "Nicht eindeutig erkennbar";
      }
      offers.push({
        storeName,
        product: name,
        packInfo,
        price,
        deposit: 0, // Italien hat kein Einwegpfand
        regularPrice,
        validUntil: formatDate(end),
        source
      });
    }
  });
  return { offers, tableCount };
}

async function scrapeOffertevolantiniIT(query) {
  if (!query.toLowerCase().includes("monster")) return [];
  const todayIso = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });
  // "" = Hauptseite /offerte/monster (landesweite Top 10) + eine Seite je Kette
  const targets = ["", ...IT_CHAIN_SLUGS];
  const report = [];
  const seen = new Set();
  const out = [];
  let tables = 0;
  // In kleinen Paketen abfragen (hoeflich zur Seite, Ergebnis ist 6 h gecacht)
  for (let i = 0; i < targets.length; i += 4) {
    const batch = targets.slice(i, i + 4);
    const settled = await Promise.allSettled(
      batch.map(async (slug) => {
        const url = `${IT_BASE}/offerte/monster${slug ? `/${slug}` : ""}`;
        return parseItOfferTables(await fetchHtml(url, IT_LANG), query, todayIso, url);
      })
    );
    settled.forEach((r, j) => {
      const slug = batch[j] || "(Hauptseite)";
      if (r.status === "fulfilled") {
        tables += r.value.tableCount;
        report.push({ slug, ok: true, tables: r.value.tableCount, offers: r.value.offers.length });
        for (const o of r.value.offers) {
          const k = `${o.storeName}|${o.product}|${o.price}|${o.validUntil}`;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push(o);
        }
      } else {
        report.push({ slug, ok: false, error: String(r.reason?.message || r.reason) });
      }
    });
    await new Promise((r) => setTimeout(r, 250));
  }
  lastItReport = report;
  console.log("IT-Scrape:", report.map((x) => (x.ok ? `${x.slug}=${x.offers}` : `${x.slug}=FEHLER`)).join(", "));
  // Nichts erreichbar bzw. nirgends eine Angebotstabelle: als Fehler melden,
  // damit das (leere) Ergebnis nicht 6 Stunden gecacht wird.
  if (!report.some((x) => x.ok)) throw new Error("offertevolantini.it: keine Seite erreichbar");
  if (tables === 0) throw new Error("offertevolantini.it: keine Angebotstabelle gefunden (Layout geaendert?)");
  return out;
}

const SCRAPERS_DE = [scrapeTrinkgut, scrapeKaufland, scrapeAldiNord, scrapeMeinprospekt];
const SCRAPERS_IT = [scrapeOffertevolantiniIT];

// Je Land: Scraper + Filialsuche. storeOsmTag "" = keine Einschraenkung (wie
// bisher in DE), "shop" = nur Laeden (IT: kurze Kettennamen wie "MD"/"Penny").
const COUNTRIES = {
  DE: { scrapers: SCRAPERS_DE, storeOsmTag: "" },
  IT: { scrapers: SCRAPERS_IT, storeOsmTag: "shop" }
};

// Scraper-Ergebnisse sind nicht ortsabhaengig (nationale Prospektdaten) und
// werden deshalb einmal pro Scraper 6 h gecacht statt pro Stadt neu geladen -
// wichtig fuer Italien mit vielen Einzelseiten. Fehler werden nicht gecacht.
const scrapeCache = new Map();
async function cachedScrape(fn, query) {
  const key = `${fn.name}|${query}`;
  const hit = scrapeCache.get(key);
  if (hit && Date.now() - hit.time < CACHE_MS) return hit.offers;
  const offers = await fn(query);
  scrapeCache.set(key, { time: Date.now(), offers });
  return offers;
}

// Obergrenze fuer Filial-Suchen pro Anfrage (Photon ist ein oeffentlicher Dienst)
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
    if (!cfg) return res.json([]); // Land (noch) nicht unterstuetzt
    const key = `${country}|${place.city}|${brandQuery}`;

    const hit = cache.get(key);
    if (hit && Date.now() - hit.time < CACHE_MS) {
      return res.json(hit.offers);
    }

    const settled = await Promise.allSettled(cfg.scrapers.map((fn) => cachedScrape(fn, brandQuery)));
    const raw = settled.flatMap((r, i) => {
      if (r.status === "fulfilled") return r.value;
      console.error(`Scraper ${cfg.scrapers[i].name} failed:`, r.reason?.message || r.reason);
      return [];
    });

    // Filialen je Kette nur einmal pro Anfrage suchen (mehrere Angebote
    // derselben Kette teilen sich das Ergebnis). Bis zu 3 Filialen je Kette,
    // Distanz-Filter (>100km) und Laenderfilter stecken in geocodeStores().
    // Faellt eine Suche aus, verliert nur diese Kette ihre Filialen.
    const branchMemo = new Map();
    const offers = [];
    for (const [i, o] of raw.entries()) {
      let branches = branchMemo.get(o.storeName);
      if (!branches) {
        if (branchMemo.size >= MAX_GEOCODED_STORES) continue;
        try {
          branches = await geocodeStores(o.storeName, lat, lon, 3, 100, country, cfg.storeOsmTag);
        } catch (e) {
          console.error(`geocodeStores(${o.storeName}) failed:`, e?.message || e);
          branches = [];
        }
        branchMemo.set(o.storeName, branches);
        await new Promise((r) => setTimeout(r, 300)); // hoeflicher Abstand zwischen Anfragen
      }
      branches.forEach((geo, j) => {
        offers.push({ id: `${key}-${i}-${j}`, ...o, storeAddress: geo.address, lat: geo.lat, lon: geo.lon });
      });
    }

    // Nur cachen, wenn mindestens ein Scraper geklappt hat - sonst wuerde ein
    // kurzer Ausfall 6 Stunden lang eine leere Liste festhalten.
    if (settled.some((r) => r.status === "fulfilled")) cache.set(key, { time: Date.now(), offers });
    res.json(offers);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

// Zeigt, welche italienischen Kettenseiten geklappt haben und welche Angebote
// gerade gueltig sind (nutzt den 6-h-Cache, loest also hoechstens alle 6 h
// einen echten Scrape aus).
app.get("/debug/it", async (_, res) => {
  try {
    const offers = await cachedScrape(scrapeOffertevolantiniIT, "Monster");
    res.json({ report: lastItReport, offers });
  } catch (e) {
    res.status(500).json({ error: String(e), report: lastItReport });
  }
});

app.get("/health", (_, res) => res.send("ok"));
app.listen(PORT, () => console.log(`laeuft auf :${PORT}`));
