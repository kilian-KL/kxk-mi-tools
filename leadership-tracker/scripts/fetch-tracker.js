#!/usr/bin/env node
/**
 * KxK Leadership-Change-Tracker — Datenpipeline
 *
 * Täglicher Lauf:
 *   1. RSS-Feeds einlesen (FINANCE, Personalwirtschaft, Handelsblatt,
 *      Börsen-Zeitung — bei Paywall-Titeln nur Headline+Teaser+Link)
 *   2. Handelsregister-Bekanntmachungen der Watchlist-Unternehmen abrufen
 *      (handelsregister.ai, Header x-api-key)
 *   3. Relevanzfilter (Keywords) → Claude API extrahiert strukturiert:
 *      Person, Funktion, Unternehmen, Ort, Vertical, Eigenformulierung
 *   4. Deduplizieren (Person+Unternehmen) gegen pending + publiziert
 *   5. Neue Einträge landen in data/pending.json — NIE direkt öffentlich.
 *      Freigabe: node scripts/approve.js  (DSGVO-/Sorgfalts-Gate)
 *
 * Env: ANTHROPIC_API_KEY, HANDELSREGISTER_API_KEY (optional), MOCK=1 für Test.
 */

const fs = require("fs");
const path = require("path");
const { holeSignale } = require("./hr-signals");

const ROOT = path.join(__dirname, "..");
const SOURCES = JSON.parse(fs.readFileSync(path.join(ROOT, "config/sources.json"), "utf8"));
const WATCHLIST = JSON.parse(fs.readFileSync(path.join(ROOT, "config/watchlist.json"), "utf8"));
const PENDING = path.join(ROOT, "data/pending.json");
const PUBLISHED = path.join(ROOT, "public/tracker-data.json");

const MOCK = process.env.MOCK === "1";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const HR_KEY = process.env.HANDELSREGISTER_API_KEY;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- Hilfen ---------- */
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } };
const norm = s => (s || "").toLowerCase().replace(/[^a-zäöüß ]/g, "").trim();
const entryKey = e => norm(e.person) + "|" + norm(e.company);

/* ---------- 1. RSS ---------- */
function parseRss(xml, source) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/).slice(1);
  for (const b of blocks) {
    const pick = tag => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
      return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim() : "";
    };
    const linkM = b.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    items.push({
      title: pick("title"),
      teaser: source.paywalled ? "" : pick("description").slice(0, 400),
      url: linkM ? linkM[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "",
      date: pick("pubDate"),
      source: source.id
    });
  }
  return items.filter(i => i.title && i.url);
}

async function fetchRss() {
  if (MOCK) return mockRssItems();
  const all = [];
  for (const src of SOURCES.rss) {
    try {
      const res = await fetch(src.url, { headers: { "User-Agent": "KxK-Tracker/1.0" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      all.push(...parseRss(await res.text(), src));
      console.log(`  RSS ${src.label}: OK`);
    } catch (e) {
      console.warn(`  RSS ${src.label}: FEHLER (${e.message}) — übersprungen`);
    }
    await sleep(500);
  }
  return all;
}

/* ---------- 2. Handelsregister (Watchlist) ---------- */
async function fetchRegister() {
  if (MOCK) return mockRegisterItems();
  if (!SOURCES.handelsregister.enabled) {
    console.log("  Handelsregister: abgeschaltet (config/sources.json).");
    return [];
  }
  /* Credit-Bremse: pro Lauf nur einen Ausschnitt der Watchlist, rotierend.
     Ueber die Signals-API kostet eine Seite 20 Credits und deckt bis zu
     fuenf Firmen ab — also rund 4 Credits pro Firma statt 6 ueber
     fetch-organization. */
  const alle = WATCHLIST.companies;
  const max = Number(SOURCES.handelsregister.max_calls_per_run) || alle.length;
  const cursorFile = path.join(__dirname, "../data/hr-cursor.json");
  let start = 0;
  try { start = JSON.parse(fs.readFileSync(cursorFile, "utf8")).next || 0; } catch (e) {}
  if (start >= alle.length) start = 0;
  const scheibe = alle.slice(start, start + max);
  const naechster = (start + max >= alle.length) ? 0 : start + max;
  fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
  fs.writeFileSync(cursorFile, JSON.stringify({ next: naechster, updated: new Date().toISOString() }, null, 2));
  console.log(`  Handelsregister: Firmen ${start + 1}\u2013${start + scheibe.length} von ${alle.length}`);

  return holeSignale({
    firmen: scheibe,
    key: HR_KEY,
    wurzel: ROOT,
    // Budget je Lauf: eine Seite (20 Credits) deckt fuenf Firmen ab,
    // plus Reserve fuer die einmalige Namensaufloesung.
    maxCredits: Math.ceil(scheibe.length / 5) * 20 + Math.ceil(scheibe.length / 4)
  });
}

/* ---------- 3. Relevanzfilter + Claude-Extraktion ---------- */
function isRelevant(item) {
  const t = (item.title + " " + item.teaser).toLowerCase();
  const roleHit = SOURCES.relevance_keywords.slice(0, 13).some(k => t.includes(k.toLowerCase()));
  const verbHit = SOURCES.relevance_keywords.slice(13).some(k => t.includes(k.toLowerCase()));
  return roleHit && (verbHit || item.source === "hr");
}

async function extract(item) {
  if (MOCK) return mockExtract(item);
  const prompt = `Du extrahierst Führungswechsel für einen öffentlichen Tracker einer Executive-Search-Boutique.

Quelle (${item.source}): "${item.title}"
Teaser: "${item.teaser}"

Antworte NUR mit JSON, ohne Markdown:
{"is_change": bool,            // echter personeller Führungswechsel (Bestellung/Abberufung 1./2. Ebene)?
 "person": string,             // voller Name
 "role": string,               // Zielfunktion normalisiert (CEO, CFO, COO, CTO, CHRO, CRO, CSO, Geschäftsführer, Vorstand, ...)
 "company": string,
 "city": string|null,
 "vertical": "masch"|"ls"|"tech"|"pe"|"fam"|null,   // fam nur bei erkennbarem Familienunternehmen
 "summary": string,            // EIN Satz auf DEUTSCH, EIGENE Formulierung (keine Übernahme des Quelltexts), Muster: "wird CFO der X GmbH, Ort — Kontext". Firmennamen IMMER ausschreiben, nie umschreiben ("des Familienunternehmens").
 "summary_en": string,         // derselbe Satz auf ENGLISCH, eigenständig formuliert statt wörtlich übersetzt. Firmen- und Personennamen unverändert lassen.
 "role_en": string             // Zielfunktion auf Englisch (CFO, CHRO, Managing Director, Labour Director, ...)
}
Regeln: Nur belegte Fakten aus Titel/Teaser, nichts erfinden. is_change=false bei Unsicherheit, Interviews, Gerüchten, zweiter Ebene unterhalb Bereichsleitung.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!res.ok) throw new Error("Claude API HTTP " + res.status);
  const data = await res.json();
  const text = data.content.filter(c => c.type === "text").map(c => c.text).join("");
  try { return JSON.parse(text.replace(/```json|```/g, "").trim()); }
  catch { return { is_change: false }; }
}

/* ---------- Mock-Daten (fiktiv, nur Pipeline-Test) ---------- */
function mockRssItems() {
  return [
    { title: "Mira Holzner wird neue CFO der Beispiel Antriebstechnik GmbH", teaser: "Die Augsburger Beispiel Antriebstechnik GmbH hat Mira Holzner zur CFO bestellt.", url: "https://example.com/1", date: new Date().toISOString(), source: "fin" },
    { title: "Führungswechsel: Jonas Reck übernimmt Vorstandsvorsitz der Beispiel Therapeutics AG", teaser: "Der Aufsichtsrat hat Jonas Reck zum CEO berufen.", url: "https://example.com/2", date: new Date().toISOString(), source: "pw" },
    { title: "Quartalszahlen der Musterbank leicht über Erwartung", teaser: "", url: "https://example.com/3", date: new Date().toISOString(), source: "hb" }
  ];
}
function mockRegisterItems() {
  return [{
    title: "Beispiel Software GmbH: Veränderung Geschäftsführung",
    teaser: "Bestellt als Geschäftsführer: Deniz Karahan. Abberufen: —",
    url: "https://www.handelsregister.de", date: new Date().toISOString(),
    source: "hr", watchlist_vertical: "tech", watchlist_city: "München"
  }];
}
function mockExtract(item) {
  const m = {
    "1": { is_change: true, person: "Mira Holzner", role: "CFO", company: "Beispiel Antriebstechnik GmbH", city: "Augsburg", vertical: "masch", summary: "wird CFO der Beispiel Antriebstechnik GmbH, Augsburg" },
    "2": { is_change: true, person: "Jonas Reck", role: "CEO", company: "Beispiel Therapeutics AG", city: "Martinsried", vertical: "ls", summary: "übernimmt den Vorstandsvorsitz der Beispiel Therapeutics AG, Martinsried" }
  };
  if (item.source === "hr") return { is_change: true, person: "Deniz Karahan", role: "Geschäftsführer", company: "Beispiel Software GmbH", city: "München", vertical: "tech", summary: "neu bestellt als Geschäftsführer der Beispiel Software GmbH, München" };
  return m[item.url.slice(-1)] || { is_change: false };
}

/* ---------- Main ---------- */
async function main() {
  if (!MOCK && !ANTHROPIC_KEY) {
    console.error("FEHLER: ANTHROPIC_API_KEY setzen — oder MOCK=1 für Testlauf.");
    process.exit(1);
  }
  console.log("1/4 Quellen einlesen …");
  const items = [...await fetchRss(), ...await fetchRegister()];
  console.log(`   ${items.length} Rohmeldungen`);

  const relevant = items.filter(isRelevant);
  console.log(`2/4 Relevanzfilter: ${relevant.length} Kandidaten`);

  const pending = readJson(PENDING, { entries: [] });
  const published = readJson(PUBLISHED, { entries: [] });
  const known = new Set([...pending.entries, ...published.entries].map(entryKey));

  console.log("3/4 Extraktion (Claude) …");
  let added = 0;
  for (const item of relevant) {
    const ex = await extract(item);
    if (!MOCK) await sleep(300);
    if (!ex.is_change || !ex.person || !ex.company) continue;
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      date: new Date(item.date || Date.now()).toISOString().slice(0, 10),
      person: ex.person, role: ex.role, company: ex.company,
      city: ex.city || item.watchlist_city || null,
      vertical: ex.vertical || item.watchlist_vertical || null,
      summary: ex.summary,
      source: item.source, url: item.url,
      demo: MOCK || undefined
    };
    if (known.has(entryKey(entry))) continue;
    known.add(entryKey(entry));
    pending.entries.push(entry);
    added++;
    console.log(`   + ${entry.person} → ${entry.role}, ${entry.company}`);
  }

  fs.mkdirSync(path.dirname(PENDING), { recursive: true });
  fs.writeFileSync(PENDING, JSON.stringify(pending, null, 2));
  console.log(`4/4 OK: ${added} neue Einträge in data/pending.json (${pending.entries.length} warten auf Freigabe).`);
  console.log(`   Freigeben mit: node scripts/approve.js`);
}

main().catch(e => { console.error("Pipeline fehlgeschlagen:", e.message); process.exit(1); });
