/**
 * MonsterDeals Backend
 *
 * Endpunkt: GET /offers?lat=..&lon=..&radiusKm=..&q=Monster Energy
 *
 * Ablauf:
 *  1. Koordinaten -> Ort/PLZ per Photon (OSM-basiert, https://photon.komoot.io)
 *  2. Direktes Scraping der oeffentlichen Angebotsseiten einzelner Haendler
 *     (kein LLM, keine Kosten, kein API-Key) nach dem gesuchten Produkt
 *  3. Nächste Filiale je Treffer per Photon geokodieren, damit die App
 *     Entfernungen anzeigen kann
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
 */
import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 8080;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const cache = new Map();
const CACHE_MS = 6 * 60 * 60 * 1000;

async function fetchHtml(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "de-DE,de;q=0.9" } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.text();
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
    postcode: p.postcode || ""
  };
}

async function geocodeStore(name, nearLat, nearLon) {
  // NUR den Kettennamen suchen, ohne Stadt im Suchtext: Photons Textsuche
  // kombiniert "Kette, kleiner Ort" oft schlecht (fand z.B. fuer "Lidl,
  // Amoeneburg" NICHTS, obwohl "Lidl" allein + lat/lon-Gewichtung sofort
  // mehrere echte Filialen in 10-25km Entfernung lieferte). lat/lon-
  // Gewichtung reicht fuer die Naehe-Sortierung voellig aus.
  const q = encodeURIComponent(name);
  // Mehrere Kandidaten holen und auf Deutschland filtern, sonst kann eine
  // seltene/falsch geschriebene Kette auf einen voellig anderen (sogar
  // auslaendischen) Ort ausweichen.
  const url = `https://photon.komoot.io/api/?q=${q}&limit=8&lat=${nearLat}&lon=${nearLon}`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  const j = await r.json();
  const f = (j.features || []).find((feat) => feat.properties?.countrycode === "DE");
  if (!f) return null;
  const p = f.properties;
  const address = [p.name, p.street, p.housenumber, p.postcode, p.city].filter(Boolean).join(", ");
  return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], address };
}

/* ---------- Scraper: Trinkgut (Shopware, .product-box) ---------- */
async function scrapeTrinkgut(query) {
  const url = "https://www.trinkgut.de/angebote";
  const $ = cheerio.load(await fetchHtml(url));
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
      price,
      deposit: /dpg/i.test(imgSrc) ? 0.25 : 0,
      regularPrice: null,
      validUntil: "",
      source: url
    });
  });
  return out;
}

/* ---------- Scraper: Kaufland (.k-product-tile) ---------- */
async function scrapeKaufland(query) {
  const url = "https://filiale.kaufland.de/angebote.html";
  const $ = cheerio.load(await fetchHtml(url));
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
      price,
      deposit: 0,
      regularPrice: Number.isNaN(regularPrice) ? null : regularPrice,
      validUntil: "",
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
    const packNote = isMultipack ? ` (aus ${totalPrice.toFixed(2)} EUR Multipack umgerechnet)` : "";
    return {
      storeName: "Aldi Nord",
      product: `${p.brandName} ${p.shortDescription || p.name || ""}`.trim() + packNote,
      price: pricePerCan ?? totalPrice,
      deposit: isPerLiter ? CAN_DEPOSIT : (p.depositValue ?? 0),
      regularPrice: null,
      validUntil: p.currentPrice?.validUntilLocalDate || "",
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
  // Jede Angebotskarte: <p>Haendler</p><p>Marke</p><p>Produktart</p>, dann
  // Preis (.text-primary) und optional Streichpreis (.line-through).
  $("#OfferGrid [role=\"listitem\"]").each((_, el) => {
    const ps = $(el).find("p");
    const storeName = $(ps.get(0)).text().trim();
    const brand = $(ps.get(1)).text().trim();
    const productType = $(ps.get(2)).text().trim();
    const priceText = $(el).find(".text-primary").first().text().trim();
    const price = parseFloat(priceText.replace(",", "."));
    if (!storeName || Number.isNaN(price)) return;
    const oldPriceText = $(el).find(".line-through").first().text().trim();
    const regularPrice = oldPriceText ? parseFloat(oldPriceText.replace(",", ".")) : null;
    // Die Seite gibt keine Packungsgroesse an. Eine Einzeldose Monster
    // Energy kostet auch zum vollen Preis kaum je mehr als ~2 EUR - alles
    // darueber ist mit hoher Wahrscheinlichkeit ein Mehrfachpack-Gesamtpreis.
    // Lieber ehrlich kennzeichnen als einen falschen Einzelpreis vorgaukeln.
    const looksLikeMultipack = price > 2.5;
    out.push({
      storeName,
      product: [brand, productType].filter(Boolean).join(" ") + (looksLikeMultipack ? " (vermutlich Mehrfachpackung, nicht Einzelpreis)" : "") || "Monster Energy",
      price,
      deposit: 0.25, // Standard-Einwegpfand, Seite gibt es nicht separat an
      regularPrice: regularPrice != null && !Number.isNaN(regularPrice) ? regularPrice : null,
      validUntil: "",
      source: url
    });
  });
  return out;
}

const SCRAPERS = [scrapeTrinkgut, scrapeKaufland, scrapeAldiNord, scrapeMeinprospekt];

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
    const key = `${place.city}|${brandQuery}`;

    const hit = cache.get(key);
    if (hit && Date.now() - hit.time < CACHE_MS) {
      return res.json(hit.offers);
    }

    const settled = await Promise.allSettled(SCRAPERS.map((fn) => fn(brandQuery)));
    const raw = settled.flatMap((r, i) => {
      if (r.status === "fulfilled") return r.value;
      console.error(`Scraper ${SCRAPERS[i].name} failed:`, r.reason?.message || r.reason);
      return [];
    });

    const offers = [];
    for (const [i, o] of raw.entries()) {
      const geo = await geocodeStore(o.storeName, lat, lon);
      if (!geo) continue;
      // Photons Textsuche kann daneben liegen (z.B. eine Strasse, die nur
      // zufaellig wie der Ortsname heisst, in einer ganz anderen Stadt).
      // Ergebnisse weit weg vom gesuchten Standort verwerfen statt eine
      // falsche "Filiale in der Naehe" vorzugaukeln.
      if (haversineKm(lat, lon, geo.lat, geo.lon) > 100) continue;
      offers.push({ id: `${key}-${i}`, ...o, storeAddress: geo.address, lat: geo.lat, lon: geo.lon });
      await new Promise((r) => setTimeout(r, 300)); // hoeflicher Abstand zwischen Anfragen
    }

    cache.set(key, { time: Date.now(), offers });
    res.json(offers);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

app.get("/health", (_, res) => res.send("ok"));
app.listen(PORT, () => console.log(`laeuft auf :${PORT}`));
