/**
 * Handelsregister-Anbindung über die Signals-API.
 *
 * Ersetzt den alten Weg über fetch-organization. Der Unterschied:
 *
 *   fetch-organization  ein Aufruf pro Firma, liefert die rohe
 *                       Veröffentlichungshistorie. 5 Credits Grundpreis
 *                       + 1 fürs Feature = 6 Credits pro Firma und Lauf.
 *
 *   signals             ein Aufruf für bis zu fünf Firmen, liefert bereits
 *                       normalisierte Änderungen mit Rollen und Beteiligten.
 *                       20 Credits pro Seite = 4 Credits pro Firma und Lauf.
 *
 * Also rund ein Drittel günstiger bei deutlich besserer Datenqualität: Die API
 * sagt uns direkt, dass ein Rollenwechsel stattgefunden hat, statt dass wir das
 * aus Bekanntmachungstexten herauslesen müssen.
 *
 * Geprüft gegen handelsregister.ai/llms.txt am 21.08.2026.
 *
 * Wichtige Eigenheiten der API, die hier berücksichtigt sind:
 *   - organization_ids: höchstens 5 Werte pro Aufruf
 *   - from/to ohne Zeitzone — ein angehängtes "Z" wird mit 422 abgelehnt
 *   - Blättern ausschließlich über cursor; leere Seiten mit has_more=true
 *     sind normal, also weiterblättern bis next_cursor fehlt
 *   - Zustellung mindestens einmal, daher Entdopplung über event.id
 *   - 20 Credits je erfolgreicher Seite, auch wenn sie leer ist
 *   - Topic ROLE_HOLDER_CHANGES ist in jedem Tarif enthalten
 */
const fs = require("fs");
const path = require("path");

const BASIS = "https://handelsregister.ai/api/v1";
const TOPIC = "ROLE_HOLDER_CHANGES";
const PRO_SEITE = 20;      // Credits je Seite
const PRO_SUCHE = 1;       // Credits je Namensauflösung
const sleep = ms => new Promise(r => setTimeout(r, ms));

const lies = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; }
};

/** Zeitstempel ohne Zeitzone — die API weist alles mit Z oder Offset ab. */
function ohneZone(d) {
  return new Date(d).toISOString().replace(/\.\d+Z$/, "").replace(/Z$/, "");
}

async function hole(pfad, params, key) {
  const url = new URL(BASIS + pfad);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach(x => url.searchParams.append(k, x));
    else if (v != null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: { "x-api-key": key, "Accept": "application/json" }
  });
  if (res.status === 403) throw new Error("PLAN_REQUIRED — Topic im aktuellen Tarif nicht enthalten");
  if (res.status === 402) throw new Error("Guthaben aufgebraucht");
  if (res.status === 429) throw new Error("Zu viele Anfragen — nächster Lauf holt es nach");
  if (!res.ok) throw new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 200));
  return res.json();
}

/**
 * Firmennamen einmalig in entity_ids übersetzen und dauerhaft merken.
 * Kostet 1 Credit je Firma — aber nur beim allerersten Mal.
 */
async function entityIds(firmen, key, cacheDatei, budget) {
  const cache = lies(cacheDatei, {});
  let verbraucht = 0;

  for (const f of firmen) {
    if (cache[f.name] !== undefined) continue;
    if (verbraucht + PRO_SUCHE > budget) {
      console.log(`  Namensauflösung: Budget erreicht, ${f.name} folgt im nächsten Lauf.`);
      break;
    }
    try {
      const d = await hole("/search-organizations", { q: f.name, limit: 1 }, key);
      const treffer = (d.results || d.organizations || [])[0];
      cache[f.name] = treffer ? treffer.entity_id : null;   // null = nicht gefunden, nicht erneut suchen
      verbraucht += PRO_SUCHE;
      console.log(`  aufgelöst: ${f.name} -> ${cache[f.name] || "nicht gefunden"}`);
    } catch (e) {
      console.warn(`  Auflösung ${f.name}: ${e.message}`);
    }
    await sleep(1100);   // 60 Anfragen pro Minute
  }

  fs.mkdirSync(path.dirname(cacheDatei), { recursive: true });
  fs.writeFileSync(cacheDatei, JSON.stringify(cache, null, 2));
  return { cache, verbraucht };
}

/**
 * Liefert Rohmeldungen im selben Format wie die RSS-Quellen, damit
 * Relevanzfilter und Extraktion unverändert weiterlaufen.
 */
async function holeSignale({ firmen, key, wurzel, maxCredits }) {
  if (!key) {
    console.log("  Handelsregister: übersprungen (kein HANDELSREGISTER_API_KEY).");
    return [];
  }

  const cacheDatei = path.join(wurzel, "data/entity-ids.json");
  const standDatei = path.join(wurzel, "data/signals-stand.json");
  const stand = lies(standDatei, {});
  const gesehen = new Set(stand.event_ids || []);

  // Ein Fünftel des Budgets darf in die einmalige Namensauflösung gehen
  const { cache, verbraucht: fuerSuche } =
    await entityIds(firmen, key, cacheDatei, Math.floor(maxCredits / 5));

  const ids = firmen.map(f => cache[f.name]).filter(Boolean);
  const nachId = {};
  firmen.forEach(f => { if (cache[f.name]) nachId[cache[f.name]] = f; });

  if (!ids.length) {
    console.log("  Handelsregister: keine aufgelösten Firmen — nichts abzufragen.");
    return [];
  }

  // Seit dem letzten Lauf, beim ersten Mal 14 Tage zurück
  const seit = stand.zuletzt || ohneZone(Date.now() - 14 * 864e5);
  let budget = maxCredits - fuerSuche;
  const raus = [];
  const neueIds = [];

  for (let i = 0; i < ids.length; i += 5) {
    const gruppe = ids.slice(i, i + 5);
    let cursor = null;

    do {
      if (budget < PRO_SEITE) {
        console.log("  Handelsregister: Credit-Budget erreicht, Rest folgt im nächsten Lauf.");
        cursor = null;
        break;
      }
      let d;
      try {
        d = await hole("/signals", {
          topics: TOPIC, organization_ids: gruppe, from: seit, cursor
        }, key);
      } catch (e) {
        console.warn(`  Signals (${gruppe.length} Firmen): ${e.message}`);
        break;
      }
      budget -= PRO_SEITE;

      for (const s of (d.signals || [])) {
        const id = s.event && s.event.id;
        if (!id || gesehen.has(id)) continue;      // Zustellung ist mindestens einmal
        neueIds.push(id);

        const org = s.organization || {};
        const firma = nachId[org.entity_id] || {};
        const rollen = (s.parties || [])
          .map(p => [p.name, p.role].filter(Boolean).join(", "))
          .filter(Boolean).join(" · ");
        const art = (s.event.type_name && (s.event.type_name.de || s.event.type_name.en))
          || s.event.type || "Änderung im Führungsgremium";

        raus.push({
          title: `${org.name || firma.name}: ${art}`,
          teaser: [rollen, (s.register_entry && s.register_entry.text) || "",
                   (s.details && JSON.stringify(s.details).slice(0, 300)) || ""]
                  .filter(Boolean).join(" — ").slice(0, 600),
          url: (s.source && s.source.url) || "https://www.handelsregister.de",
          date: s.event.announced_at || s.event.date || new Date().toISOString(),
          source: "hr",
          watchlist_vertical: firma.vertical,
          watchlist_city: firma.city
        });
      }

      cursor = (d.pagination && d.pagination.has_more) ? d.pagination.next_cursor : null;
      await sleep(1100);
    } while (cursor);
  }

  // Stand fortschreiben; nur die letzten 2000 Ereignis-IDs behalten
  fs.mkdirSync(path.dirname(standDatei), { recursive: true });
  fs.writeFileSync(standDatei, JSON.stringify({
    zuletzt: ohneZone(Date.now()),
    event_ids: [...gesehen, ...neueIds].slice(-2000)
  }, null, 2));

  console.log(`  Handelsregister: ${raus.length} neue Führungswechsel aus ${ids.length} Firmen ` +
              `(rund ${maxCredits - budget} Credits verbraucht).`);
  return raus;
}

module.exports = { holeSignale };
