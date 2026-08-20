#!/usr/bin/env node
/**
 * KxK Wachstums-Radar — Datenpipeline
 *
 * Wöchentlicher (oder täglicher) Lauf:
 *   1. RSS-Feeds einlesen (Startbase, deutsche-startups.de, EU-Startups,
 *      PresseBox) — Finanzierungs-, Expansions- und M&A-Signale
 *   2. Insolvenz-/Restrukturierungssignale der Watchlist via
 *      handelsregister.ai (optional, gleicher Key wie Tracker)
 *   3. Relevanzfilter je Signaltyp → Claude API extrahiert strukturiert:
 *      Unternehmen, Ort, Signaltyp, Runde/Betrag, Beschreibung (eigene
 *      Formulierung) und HIRING-IMPLIKATIONEN (hard/soft) — deklariert
 *      als Einschätzung, nicht als Tatsachenbehauptung
 *   4. Dedup (Unternehmen+Signaltyp, 60-Tage-Fenster) → data/pending.json
 *   5. Freigabe: node scripts/approve.js  (Sorgfalts-Gate)
 *
 * Env: ANTHROPIC_API_KEY, HANDELSREGISTER_API_KEY (optional), MOCK=1.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SOURCES = JSON.parse(fs.readFileSync(path.join(ROOT, "config/sources.json"), "utf8"));
const WATCHLIST = JSON.parse(fs.readFileSync(path.join(ROOT, "config/watchlist.json"), "utf8"));
const PENDING = path.join(ROOT, "data/pending.json");
const PUBLISHED = path.join(ROOT, "public/radar-data.json");

const MOCK = process.env.MOCK === "1";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const HR_KEY = process.env.HANDELSREGISTER_API_KEY;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } };
const norm = s => (s || "").toLowerCase().replace(/[^a-zäöüß0-9 ]/g, "").trim();
const entryKey = e => norm(e.company) + "|" + e.signal_type;

/* ---------- RSS (identisches Muster wie Tracker) ---------- */
function parseRss(xml, source) {
  const items = [];
  for (const b of xml.split(/<item[\s>]/).slice(1)) {
    const pick = tag => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
      return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim() : "";
    };
    const linkM = b.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    items.push({ title: pick("title"), teaser: pick("description").slice(0, 500),
      url: linkM ? linkM[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "",
      date: pick("pubDate"), source: source.id });
  }
  return items.filter(i => i.title && i.url);
}

async function fetchRss() {
  if (MOCK) return mockRss();
  const all = [];
  for (const src of SOURCES.rss) {
    try {
      const res = await fetch(src.url, { headers: { "User-Agent": "KxK-Radar/1.0" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      all.push(...parseRss(await res.text(), src));
      console.log(`  RSS ${src.label}: OK`);
    } catch (e) { console.warn(`  RSS ${src.label}: FEHLER (${e.message}) — übersprungen`); }
    await sleep(500);
  }
  return all;
}

async function fetchInsolvencies() {
  if (MOCK) return mockHr();
  if (!SOURCES.handelsregister.enabled || !HR_KEY) {
    console.log("  Insolvenzsignale: übersprungen (kein HANDELSREGISTER_API_KEY)");
    return [];
  }
  const out = [];

  /* Credit-Bremse wie beim Tracker: pro Lauf hoechstens max_calls_per_run Firmen,
     rotierend ueber die Watchlist. */
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
  console.log(`  Insolvenzsignale: Firmen ${start + 1}\u2013${start + scheibe.length} von ${alle.length} (max ${max} Credits diesen Lauf)`);

  for (const c of scheibe) {
    try {
      const url = `${SOURCES.handelsregister.base_url}/fetch-organization?` +
        new URLSearchParams({ q: c.name, features: SOURCES.handelsregister.feature });
      const res = await fetch(url, { headers: { "x-api-key": HR_KEY } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      for (const ins of (data.insolvencies || [])) {
        out.push({ title: `${c.name}: Insolvenzbekanntmachung`, teaser: (ins.text || ins.event || "").slice(0, 500),
          url: ins.url || "https://www.insolvenzbekanntmachungen.de",
          date: ins.date || new Date().toISOString(), source: "hr", hint_type: "restr", hint_city: c.city });
      }
    } catch (e) { console.warn(`  HR ${c.name}: ${e.message}`); }
    await sleep(400);
  }
  return out;
}

/* ---------- Relevanz + Extraktion ---------- */
function detectType(item) {
  if (item.hint_type) return item.hint_type;
  const t = (item.title + " " + item.teaser).toLowerCase();
  for (const [type, kws] of Object.entries(SOURCES.relevance_keywords))
    if (kws.some(k => t.includes(k.toLowerCase()))) return type;
  return null;
}

async function extract(item, type) {
  if (MOCK) return mockExtract(item, type);
  const prompt = `Du extrahierst Wachstums-/Restrukturierungssignale für das öffentliche "Wachstums-Radar" einer Executive-Search-Boutique (DACH).

Quelle (${item.source}): "${item.title}"
Teaser: "${item.teaser}"
Vermuteter Signaltyp: ${type}

Antworte NUR mit JSON, ohne Markdown:
{"is_signal": bool,           // relevantes DACH-Unternehmenssignal (Funding/Expansion/M&A/Restrukturierung)?
 "company": string,
 "location": string|null,     // "Stadt · Branche kurz", z.B. "München · Industrial SaaS"
 "signal_type": "funding"|"expansion"|"ma"|"restr",
 "round_label": string,       // kurz, z.B. "Series B · 48 Mio. €", "Werksausbau", "Add-on-Akquisition", "Restrukturierung"
 "amount_meur": number|null,  // Betrag in Mio. EUR, falls genannt
 "desc": string,              // EIN Satz, EIGENE Formulierung, nur belegte Fakten
 "implications": [            // wahrscheinliche Führungs-Besetzungen in 6-12 Monaten (max 3)
   {"label": string,          // z.B. "CRO-Bedarf", "CFO Capital Markets", "Werkleiter"
    "strength": "hard"|"soft"}]}
Regeln: implications sind EINSCHÄTZUNGEN aus Signaltyp und Unternehmensphase — konservativ ableiten. is_signal=false bei Nicht-DACH, Gerüchten, Produktnews, Personalien (dafür gibt es den Tracker).`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 600,
      messages: [{ role: "user", content: prompt }] })
  });
  if (!res.ok) throw new Error("Claude API HTTP " + res.status);
  const data = await res.json();
  const text = data.content.filter(c => c.type === "text").map(c => c.text).join("");
  try { return JSON.parse(text.replace(/```json|```/g, "").trim()); }
  catch { return { is_signal: false }; }
}

/* ---------- Mocks (fiktiv) ---------- */
function mockRss() {
  return [
    { title: "Beispiel Robotics GmbH sammelt 22 Millionen Euro in Series A ein", teaser: "Das Karlsruher DeepTech will von 40 auf 160 Mitarbeitende wachsen.", url: "https://example.com/r1", date: new Date().toISOString(), source: "ds" },
    { title: "Beispiel Präzisionstechnik baut neues Werk in der Slowakei", teaser: "Produktionskapazität soll bis 2028 um 60 Prozent steigen.", url: "https://example.com/r2", date: new Date().toISOString(), source: "pm" },
    { title: "Neue Kaffeesorte im Sortiment der Musterrösterei", teaser: "", url: "https://example.com/r3", date: new Date().toISOString(), source: "pm" }
  ];
}
function mockHr() {
  return [{ title: "Beispiel Maschinenfabrik GmbH: Insolvenzbekanntmachung", teaser: "Anordnung der vorläufigen Eigenverwaltung.", url: "https://www.insolvenzbekanntmachungen.de", date: new Date().toISOString(), source: "hr", hint_type: "restr", hint_city: "Leipzig" }];
}
function mockExtract(item, type) {
  if (item.url.endsWith("r1")) return { is_signal: true, company: "Beispiel Robotics GmbH", location: "Karlsruhe · DeepTech", signal_type: "funding", round_label: "Series A · 22 Mio. €", amount_meur: 22, desc: "Skalierung von 40 auf 160 Mitarbeitende geplant.", implications: [{ label: "VP Engineering", strength: "hard" }, { label: "CHRO", strength: "hard" }, { label: "Head of Production", strength: "soft" }] };
  if (item.url.endsWith("r2")) return { is_signal: true, company: "Beispiel Präzisionstechnik GmbH", location: "Nürnberg · Maschinenbau", signal_type: "expansion", round_label: "Werksausbau", amount_meur: null, desc: "Neues Werk in der Slowakei, Kapazität +60 % bis 2028.", implications: [{ label: "Werkleiter", strength: "hard" }, { label: "Head of SCM", strength: "soft" }] };
  if (item.source === "hr") return { is_signal: true, company: "Beispiel Maschinenfabrik GmbH", location: "Leipzig · Anlagenbau", signal_type: "restr", round_label: "Eigenverwaltung", amount_meur: null, desc: "Vorläufige Eigenverwaltung angeordnet; Neuaufstellung der Führung wahrscheinlich.", implications: [{ label: "CRO / Sanierungs-GF", strength: "hard" }, { label: "CFO", strength: "hard" }] };
  return { is_signal: false };
}

/* ---------- Main ---------- */
async function main() {
  if (!MOCK && !ANTHROPIC_KEY) {
    console.error("FEHLER: ANTHROPIC_API_KEY setzen — oder MOCK=1 für Testlauf.");
    process.exit(1);
  }
  console.log("1/4 Quellen einlesen …");
  const items = [...await fetchRss(), ...await fetchInsolvencies()];
  console.log(`   ${items.length} Rohmeldungen`);

  const typed = items.map(i => ({ item: i, type: detectType(i) })).filter(x => x.type);
  console.log(`2/4 Relevanzfilter: ${typed.length} Kandidaten`);

  const pending = readJson(PENDING, { entries: [] });
  const published = readJson(PUBLISHED, { entries: [] });
  const cutoff = Date.now() - 60 * 86400000;
  const known = new Set([...pending.entries, ...published.entries]
    .filter(e => new Date(e.date) > cutoff).map(entryKey));

  console.log("3/4 Extraktion (Claude) …");
  let added = 0;
  for (const { item, type } of typed) {
    const ex = await extract(item, type);
    if (!MOCK) await sleep(300);
    if (!ex.is_signal || !ex.company) continue;
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      date: new Date(item.date || Date.now()).toISOString().slice(0, 10),
      company: ex.company, location: ex.location,
      signal_type: ex.signal_type || type,
      round_label: ex.round_label, amount_meur: ex.amount_meur ?? null,
      desc: ex.desc, implications: (ex.implications || []).slice(0, 3),
      source: item.source, url: item.url, demo: MOCK || undefined
    };
    if (known.has(entryKey(entry))) continue;
    known.add(entryKey(entry));
    pending.entries.push(entry);
    added++;
    console.log(`   + [${entry.signal_type}] ${entry.company} — ${entry.round_label}`);
  }

  fs.mkdirSync(path.dirname(PENDING), { recursive: true });
  fs.writeFileSync(PENDING, JSON.stringify(pending, null, 2));
  console.log(`4/4 OK: ${added} neue Signale in data/pending.json (${pending.entries.length} warten auf Freigabe).`);
  console.log(`   Freigeben mit: node scripts/approve.js`);
}

main().catch(e => { console.error("Pipeline fehlgeschlagen:", e.message); process.exit(1); });
