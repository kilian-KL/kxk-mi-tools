#!/usr/bin/env node
/**
 * Freigabe-Gate: verschiebt geprüfte Einträge aus data/pending.json
 * nach public/radar-data.json. Publikation NUR über diesen Schritt —
 * das ist das Sorgfalts- und DSGVO-Gate (falsche Wechselmeldungen über
 * reale Personen sind abmahnfähig).
 *
 *   node scripts/approve.js            # interaktiv: j/n/e pro Eintrag
 *   node scripts/approve.js --all      # alles freigeben (nur wenn extern geprüft)
 *   node scripts/approve.js --remove "<Name>"   # publizierten Eintrag löschen
 *                                                (Art.-21-Widerspruchsprozess)
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const ROOT = path.join(__dirname, "..");
const PENDING = path.join(ROOT, "data/pending.json");
const PUBLISHED = path.join(ROOT, "public/radar-data.json");
const read = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } };

const pending = read(PENDING, { entries: [] });
const pub = read(PUBLISHED, { entries: [], meta: {} });

function save(publishedChanged) {
  pub.entries.sort((a, b) => b.date.localeCompare(a.date));
  pub.meta = { ...pub.meta, updated: new Date().toISOString(),
    demo: pub.entries.some(e => e.demo) || undefined };
  fs.writeFileSync(PENDING, JSON.stringify(pending, null, 2));
  if (publishedChanged) fs.writeFileSync(PUBLISHED, JSON.stringify(pub, null, 2));
}

const argv = process.argv.slice(2);

if (argv[0] === "--remove") {
  const name = (argv[1] || "").toLowerCase();
  const before = pub.entries.length;
  pub.entries = pub.entries.filter(e => !e.company.toLowerCase().includes(name));
  save(true);
  console.log(`Entfernt: ${before - pub.entries.length} Signal(e) zu "${argv[1]}".`);
  process.exit(0);
}

if (!pending.entries.length) { console.log("Keine Einträge zur Freigabe."); process.exit(0); }

if (argv[0] === "--all") {
  pub.entries.push(...pending.entries);
  console.log(`Freigegeben: ${pending.entries.length} Einträge.`);
  pending.entries = [];
  save(true);
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const queue = [...pending.entries];
pending.entries = [];

(function next() {
  const e = queue.shift();
  if (!e) { rl.close(); save(true); console.log("Fertig."); return; }
  console.log(`\n${e.date} · [${e.signal_type}] ${e.company} — ${e.round_label}`);
  console.log(`  "${e.desc}"  [${e.source}] ${e.url}`);
  rl.question("  freigeben (j) / verwerfen (n) / später (e)? ", ans => {
    if (ans.trim() === "j") pub.entries.push(e);
    else if (ans.trim() === "e") pending.entries.push(e);
    next();
  });
})();
