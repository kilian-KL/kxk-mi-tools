#!/usr/bin/env node
/**
 * Schiebt die Warteschlange eines Tools nach Supabase.
 *
 * Ab hier ist Supabase die Warteschlange: Oliver und Sebastian geben unter
 * /mi-freigabe frei, die Website liest ausschliesslich Freigegebenes. Die
 * lokale pending.json ist damit nur noch Zwischenstation und wird nach einem
 * erfolgreichen Push geleert, damit dieselben Eintraege nicht doppelt auflaufen.
 *
 * Aufruf:
 *   node scripts/push-to-supabase.js --tool tracker --file leadership-tracker/data/pending.json
 *
 * Erwartet in der Umgebung:
 *   SUPABASE_URL          z.B. https://<ref>.supabase.co
 *   SUPABASE_SERVICE_KEY  service_role-Key (nur als GitHub-Secret, nie im Repo)
 *
 * Fehlt eines von beiden, bricht das Skript NICHT ab: die Eintraege bleiben
 * dann in pending.json liegen und der alte Weg funktioniert weiter.
 */
const fs = require("fs");
const path = require("path");

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const TOOL = arg("tool");
const FILE = arg("file");
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;

if (!TOOL || !FILE) {
  console.error("Aufruf: node push-to-supabase.js --tool <tracker|radar> --file <pending.json>");
  process.exit(1);
}
if (!["tracker", "radar"].includes(TOOL)) {
  console.error(`Unbekanntes Tool "${TOOL}" — erlaubt sind tracker und radar.`);
  process.exit(1);
}
if (!URL_ || !KEY) {
  console.log("Supabase nicht konfiguriert (SUPABASE_URL / SUPABASE_SERVICE_KEY fehlen).");
  console.log("Die Eintraege bleiben in " + FILE + " liegen — nichts geht verloren.");
  process.exit(0);
}

const abs = path.resolve(process.cwd(), FILE);
if (!fs.existsSync(abs)) {
  console.log("Keine Warteschlange unter " + FILE + " — nichts zu tun.");
  process.exit(0);
}

let queue;
try {
  queue = JSON.parse(fs.readFileSync(abs, "utf8"));
} catch (e) {
  console.error("Warteschlange ist kein gueltiges JSON: " + e.message);
  process.exit(1);
}

const entries = Array.isArray(queue.entries) ? queue.entries : [];
if (!entries.length) {
  console.log("Warteschlange ist leer — nichts zu uebertragen.");
  process.exit(0);
}

const rows = entries.map((e) => ({
  tool: TOOL,
  ext_id: e.id || null,
  entry_date: (e.date || "").slice(0, 10) || null,
  status: "pending",
  payload: e,
}));

(async () => {
  const res = await fetch(URL_.replace(/\/+$/, "") + "/rest/v1/kxk_mi_entries", {
    method: "POST",
    headers: {
      apikey: KEY,
      Authorization: "Bearer " + KEY,
      "Content-Type": "application/json",
      // Bereits bekannte Eintraege still uebergehen, statt den Lauf abzubrechen
      Prefer: "return=minimal,resolution=ignore-duplicates",
    },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`Supabase hat abgelehnt (HTTP ${res.status}): ${text.slice(0, 400)}`);
    console.error("Die Eintraege bleiben in " + FILE + " liegen.");
    process.exit(1);
  }

  fs.writeFileSync(abs, JSON.stringify({ entries: [] }, null, 2) + "\n");
  console.log(
    `${rows.length} Eintraege nach Supabase uebertragen (Tool: ${TOOL}). ` +
      `Warteschlange geleert — Freigabe laeuft jetzt ueber /mi-freigabe.`
  );
})().catch((e) => {
  console.error("Push fehlgeschlagen: " + e.message);
  console.error("Die Eintraege bleiben in " + FILE + " liegen.");
  process.exit(1);
});
