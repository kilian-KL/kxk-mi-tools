#!/usr/bin/env node
/** Prüft alle RSS-Feeds aus config/sources.json: erreichbar? Items enthalten?
 *  Vor Livegang ausführen — Verlage ändern Feed-Pfade gelegentlich. */
const fs = require("fs"); const path = require("path");
const SOURCES = JSON.parse(fs.readFileSync(path.join(__dirname, "../config/sources.json"), "utf8"));
(async () => {
  let fail = 0;
  for (const src of SOURCES.rss) {
    try {
      const res = await fetch(src.url, { headers: { "User-Agent": "KxK-Tracker/1.0" } });
      const xml = res.ok ? await res.text() : "";
      const n = (xml.match(/<item[\s>]/g) || []).length;
      if (!res.ok || !n) throw new Error(res.ok ? "keine Items" : "HTTP " + res.status);
      console.log(`OK    ${src.label}: ${n} Items`);
    } catch (e) { fail++; console.log(`FAIL  ${src.label}: ${e.message} — URL in config/sources.json korrigieren`); }
  }
  process.exit(fail ? 1 : 0);
})();
