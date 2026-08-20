# KxK Wachstums-Radar DACH — Live-Paket

Frühindikatoren für Führungskräftebedarf: Finanzierungsrunden, Expansionen,
M&A und Restrukturierungen aus kostenlosen RSS-Quellen plus optionalen
Insolvenzsignalen der Watchlist (handelsregister.ai). Jedes Signal wird per
Claude API strukturiert extrahiert und mit Hiring-Implikationen (hard/soft)
übersetzt — als gekennzeichnete Einschätzung. Publikation ausschließlich
über das Freigabe-Gate.

## Struktur

```
config/sources.json           RSS-Feeds + Insolvenz-Konfiguration + Keyword-Filter
config/watchlist.json         Zielunternehmen für Insolvenz-Polling (mit Tracker teilbar)
scripts/fetch-radar.js        Pipeline: Quellen → Typ-Filter → Claude → pending
scripts/approve.js            Freigabe-Gate (interaktiv, --all, --remove "<Firma>")
scripts/check-sources.js      Feed-URLs vor Livegang verifizieren
data/pending.json             Warteschlange (nie öffentlich)
public/index.html             Frontend (Kaskade: URL → relativ → eingebettet)
public/radar-data.json        Publizierte Signale
.github/workflows/fetch-radar.yml   Montag + Donnerstag 05:00 UTC + manuell
```

## Setup (ca. 20 Minuten — kürzer, wenn der Tracker schon läuft)

1. Keys: `ANTHROPIC_API_KEY` (Pflicht), `HANDELSREGISTER_API_KEY` (optional —
   ohne ihn läuft das Radar rein RSS-basiert, Restrukturierungssignale fehlen
   dann weitgehend). Dieselben Secrets wie beim Tracker.
2. `node scripts/check-sources.js` — Feed-URLs verifizieren/korrigieren.
3. Watchlist aus dem Tracker übernehmen oder eigene pflegen.
4. Repo + Secrets, Workflow manuell starten, Pending prüfen und freigeben:
   `node scripts/approve.js`, dann committen.
5. `KXK_DATA_URL` in public/index.html auf die GitHub-Raw-URL von
   radar-data.json setzen, HTML in WordPress einbetten.

## Betrieb

Zwei Läufe pro Woche (Mo/Do) reichen erfahrungsgemäß; Umstellen auf täglich =
eine Cron-Zeile. Freigabe wie beim Tracker: 5 Minuten pro Lauf, jedes Signal
mit Quelle und Link. PresseBox-Feed ist volumenstark — falls zu viel Rauschen,
in sources.json entfernen oder Keywords schärfen.

## Bewusste Grenzen & Recht

- **Kuratierte Auswahl, keine Vollerhebung** — steht so in der Methodik-Box.
  Lückenlose Funding-Abdeckung gibt es nur mit Dealroom-/Crunchbase-Lizenz
  (vier- bis fünfstellig p. a.); Upgrade erst bei nachgewiesener Traktion.
- **Hiring-Implikationen sind Einschätzungen**, keine Tatsachenbehauptungen
  über konkrete Vakanzen — so gekennzeichnet im Frontend, so gepromptet in
  der Extraktion, so zu prüfen in der Freigabe.
- **Keine Anlageinformation:** Das Radar bewertet Unternehmen ausschließlich
  hinsichtlich Führungsbedarf, nie als Investment. Disclaimer steht.
- **Restrukturierungssignale sensibel behandeln:** Insolvenzen sind öffentlich
  (§ 9 InsO), aber geschäftsschädigende Formulierungen vermeiden — nüchterne
  Registerfakten, nichts Wertendes. Die Freigabe ist hier besonders wichtig.
- `--remove "<Firma>"` entfernt publizierte Signale (z. B. auf Zuruf).

## Kosten

RSS 0 €, Claude API wenige Euro/Monat, handelsregister.ai optional (mit dem
Tracker geteilt), Actions + Hosting 0 €.

## Lokal testen

```
MOCK=1 node scripts/fetch-radar.js && node scripts/approve.js
npx serve public
```
