/**
 * MonsterDeals Backend
 *
 * Endpunkt: GET /offers?lat=..&lon=..&radiusKm=..&q=Monster Energy
 *
 * Ablauf:
 *  1. Koordinaten -> Ort/PLZ per OpenStreetMap Nominatim (kostenlos, Attribution noetig)
 *  2. Ort + Produkt -> Claude mit aktivierter Websuche sucht aktuelle Angebote
 *     und liefert sie als JSON zurueck
 *  3. Ergebnis wird 6 Stunden pro Ort gecacht (Websuche kostet Geld und Zeit)
 *  4. Geokodierung der gefundenen Laeden, damit die App Entfernungen rechnen kann
 *
 * Wichtig: Die Preise stammen aus oeffentlichen Webquellen und koennen falsch
 * oder veraltet sein. In der App als "ohne Gewaehr" kennzeichnen.
 */
import express from "express";
import fetch from "node-fetch";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
const PORT = process.env.PORT || 8080;
const anthropic = new Anthropic(); // liest ANTHROPIC_API_KEY aus der Umgebung
const UA = "MonsterDeals/1.0 (kontakt@example.com)"; // Nominatim verlangt eine Kennung

const cache = new Map();
const CACHE_MS = 6 * 60 * 60 * 1000;

/* ---------- 1. Wo ist der Nutzer? ---------- */
async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=12`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  const j = await r.json();
  const a = j.address || {};
  return {
    city: a.city || a.town || a.village || a.county || "",
    postcode: a.postcode || ""
  };
}

/* ---------- 2. Laden -> Koordinaten ---------- */
async function geocodeStore(name, city) {
  const q = encodeURIComponent(`${name}, ${city}`);
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${q}`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  const j = await r.json();
  if (!j.length) return null;
  return { lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon), address: j[0].display_name };
}

/* ---------- 3. Angebote per Websuche finden ---------- */
async function findOffers(product, city, postcode) {
  const prompt = `Suche im Web nach aktuellen Wochenangeboten fuer "${product}" bei
Supermaerkten und Discountern in ${city} (PLZ ${postcode}), Deutschland.
Beruecksichtige die aktuellen Prospekte von REWE, EDEKA, Lidl, Aldi, Netto,
Penny, Kaufland und Trinkgut.

Gib den Angebotspreis OHNE Pfand an (bei Dosen/Flaschen wird das Pfand separat
an der Kasse berechnet, meist 0,25 EUR pro Dose). Trag das Pfand zusaetzlich
im Feld "deposit" ein (0.25 fuer Dosen, 0 falls Mehrweg/nicht bekannt).

Antworte AUSSCHLIESSLICH mit einem JSON-Array, ohne Markdown und ohne Vorwort.
Jedes Element:
{"storeName":"REWE","product":"Monster Energy Ultra 500ml","price":0.89,
 "deposit":0.25,"regularPrice":1.49,"validUntil":"2026-09-13","source":"https://..."}

Nur Angebote, die du wirklich belegen kannst. Keine Erfindungen.
Wenn du nichts findest, antworte mit [].`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
    tools: [{ type: "web_search_20260209", name: "web_search" }]
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .replace(/```json|```/g, "")
    .trim();

  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) return [];
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
}

/* ---------- Endpunkt ---------- */
app.get("/offers", async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    const product = req.query.q || "Monster Energy";
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      return res.status(400).json({ error: "lat und lon erforderlich" });
    }

    const place = await reverseGeocode(lat, lon);
    const key = `${place.city}|${product}`;

    const hit = cache.get(key);
    if (hit && Date.now() - hit.time < CACHE_MS) {
      return res.json(hit.offers);
    }

    const raw = await findOffers(product, place.city, place.postcode);

    const offers = [];
    for (const [i, o] of raw.entries()) {
      const geo = await geocodeStore(o.storeName, place.city);
      if (!geo) continue;
      offers.push({
        id: `${key}-${i}`,
        storeName: o.storeName,
        storeAddress: geo.address,
        product: o.product,
        price: o.price,
        deposit: o.deposit ?? 0,
        regularPrice: o.regularPrice ?? null,
        validUntil: o.validUntil ?? "",
        lat: geo.lat,
        lon: geo.lon,
        source: o.source ?? ""
      });
      await new Promise((r) => setTimeout(r, 1100)); // Nominatim: max 1 Anfrage/Sekunde
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
