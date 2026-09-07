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
 *  - Aldi Nord, Trinkgut, Kaufland: funktionieren
 *  - REWE: node-fetch/Node's https-Modul bekommen 403 (TLS-Fingerprinting),
 *    curl kommt durch - deshalb ruft scrapeRewe() curl als Subprozess auf
 *    (fetchHtmlViaCurl) statt node-fetch zu nutzen. ABER: von Render's
 *    Server-Standort aus liefert REWE nur die generische Homepage statt
 *    der Angebotsseite (vermutlich Geo-IP-Weiche, REWE-Preise sind
 *    regional) - render.yaml setzt deshalb "region: frankfurt", damit
 *    der Server eine deutsche IP bekommt. Falls REWE trotzdem leer bleibt:
 *    pruefen, ob der Render-Service tatsaechlich in Frankfurt laeuft
 *    (Region laesst sich bei bestehenden Services oft nicht nachtraeglich
 *    aendern, dann hilft nur ein neu angelegter Service).
 *    (Ein zuvor versuchter echter Headless-Chrome via puppeteer-core +
 *    @sparticuz/chromium hat auf Render's 512-MB-Gratis-Tier den ganzen
 *    Server mit Out-of-Memory abgeschossen - deshalb der curl-Ansatz.)
 *  - EDEKA, Aldi Sued, Netto (beide Varianten): liefern 403 auch mit curl.
 *  - Penny: Struktur vorhanden, aber kein bestaetigtes Beispiel gefunden,
 *    deshalb nicht eingebaut.
 *  - Alle Preise sind national/online-Prospekt-Daten, nicht filialscharf.
 *    Die Distanz bezieht sich auf die naechste per Photon gefundene
 *    Filiale der Kette, nicht auf den tatsaechlichen Angebotsort.
 *  - Bricht potenziell, wenn ein Haendler seine Website umbaut.
 */
import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

/**
 * Manche Seiten (REWE) blocken node-fetch/Node's https-Modul per TLS-
 * Fingerprinting, lassen curl aber durch (anderer TLS-Stack). Ruft das
 * echte curl-Binary als Subprozess auf - kein Fake, kein Bot-Bypass,
 * sondern dasselbe Tool, das schon nachweislich funktioniert. Braucht
 * kaum RAM im Gegensatz zu einem echten Browser.
 */
async function fetchHtmlViaCurl(url) {
  const { stdout } = await execFileAsync(
    "curl",
    ["-sL", "-m", "20", "-A", UA, "-H", "Accept-Language: de-DE,de;q=0.9", url],
    { maxBuffer: 20 * 1024 * 1024, timeout: 25000 }
  );
  return stdout;
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

async function geocodeStore(name, city) {
  const q = encodeURIComponent(`${name}, ${city}`);
  const url = `https://photon.komoot.io/api/?q=${q}&limit=1`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  const j = await r.json();
  const f = j.features?.[0];
  if (!f) return null;
  const p = f.properties;
  const address = [p.name, p.street, p.housenumber, p.postcode, p.city].filter(Boolean).join(", ");
  return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], address };
}

/* ---------- Scraper: REWE (blockt node-fetch, curl kommt durch) ---------- */
async function scrapeRewe(query) {
  const url = "https://www.rewe.de/angebote/nationale-angebote/alkoholfreie-getraenke/";
  const html = await fetchHtmlViaCurl(url);
  const $ = cheerio.load(html);
  const out = [];
  $("a.cor-offer-information__title-link").each((_, el) => {
    const label = $(el).attr("aria-label") || "";
    if (!label.toLowerCase().includes(query.toLowerCase())) return;
    const m = label.match(/^(.*?),\s*Aktionspreis\s*([\d,]+)\s*€/);
    if (!m) return;
    out.push({
      storeName: "REWE",
      product: m[1].trim(),
      price: parseFloat(m[2].replace(",", ".")),
      deposit: 0,
      regularPrice: null,
      validUntil: "",
      source: url
    });
  });
  return out;
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
  return matches.map((p) => {
    // Aldi Nord liefert keine explizite Stueckzahl. Preise sind oft
    // Multipacks (z.B. 10x0,5l) - anhand des Liter-Grundpreises schaetzen,
    // damit "7,77 EUR" nicht wie ein Einzeldosen-Preis wirkt.
    const liters = p.currentPrice?.basePrice?.[0]?.basePriceScale === "Liter"
      ? p.currentPrice.priceValue / p.currentPrice.basePrice[0].basePriceValue
      : null;
    const packNote = liters && liters > 0.6 ? ` (Multipack, ca. ${liters.toFixed(1)} L gesamt)` : "";
    return {
      storeName: "Aldi Nord",
      product: `${p.brandName} ${p.shortDescription || p.name || ""}`.trim() + packNote,
      price: p.currentPrice?.priceValue ?? null,
      deposit: p.depositValue ?? 0,
      regularPrice: null,
      validUntil: p.currentPrice?.validUntilLocalDate || "",
      source: url
    };
  }).filter((o) => typeof o.price === "number");
}

const SCRAPERS = [scrapeRewe, scrapeTrinkgut, scrapeKaufland, scrapeAldiNord];

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
      const geo = await geocodeStore(o.storeName, place.city);
      if (!geo) continue;
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
