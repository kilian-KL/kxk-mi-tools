# KxK Leadership-Change-Tracker DACH — Live-Paket

Täglicher Tracker für Führungswechsel: Handelsregister-Watchlist plus vier
Personalien-RSS-Quellen, LLM-Extraktion via Claude API, verpflichtendes
Freigabe-Gate, statisches Frontend. Publiziert wird ausschließlich, was ein
Mensch freigegeben hat — das ist bei diesem Tool kein Nice-to-have, sondern
das Haftungs- und DSGVO-Fundament.

## Struktur

```
config/sources.json           RSS-Feeds + handelsregister.ai-Konfiguration
config/watchlist.json         Zielunternehmen fürs Register-Polling (ersetzen!)
scripts/fetch-tracker.js      Pipeline: Quellen → Relevanzfilter → Claude → pending
scripts/approve.js            Freigabe-Gate (interaktiv, --all, --remove "<Name>")
scripts/check-sources.js      Feed-URLs vor Livegang verifizieren
data/pending.json             Warteschlange (nie öffentlich)
public/index.html             Frontend (Kaskade: URL → relativ → eingebettet)
public/tracker-data.json      Publizierte Einträge
.github/workflows/fetch-tracker.yml   Werktags 05:00 UTC + manuell
```

## Setup (ca. 30 Minuten)

1. **Keys besorgen:** Claude API-Key (console.anthropic.com) und
   handelsregister.ai-Key (Free Tier zum Start). Nur RSS geht auch ohne
   HR-Key — die Pipeline überspringt das Register dann automatisch.
2. **Feeds verifizieren:** `node scripts/check-sources.js` — Verlage ändern
   Pfade gelegentlich; FAIL-Zeilen in config/sources.json korrigieren.
3. **Watchlist ersetzen:** config/watchlist.json mit der echten Zielliste
   befüllen (HubSpot-Export: Name + Sitz + Vertical). Empfohlen 500–2.000
   Unternehmen; Credit-Kosten skalieren linear mit.
4. **Repo + Secrets:** `ANTHROPIC_API_KEY`, `HANDELSREGISTER_API_KEY` als
   Actions-Secrets. Workflow einmal manuell starten.
5. **Frontend:** `KXK_DATA_URL` in public/index.html auf die GitHub-Raw-URL
   von tracker-data.json setzen, HTML in WordPress einbetten.

## Täglicher Betrieb (5–10 Minuten)

Die Action füllt werktags `data/pending.json`. Freigabe:

```
git pull
node scripts/approve.js        # j / n / e pro Eintrag, mit Quelle und Link
git add public/ data/ && git commit -m "Tracker-Freigabe" && git push
```

`--all` nur verwenden, wenn die Einträge anderweitig geprüft wurden.
Der erste echte Freigabe-Commit ersetzt die Demodaten (Badge verschwindet,
sobald keine demo-Einträge mehr publiziert sind — Demo-Einträge bei der
ersten echten Freigabe einfach mit n verwerfen bzw. aus
public/tracker-data.json entfernen).

## Rechtliches (Kurzfassung — Details in der Machbarkeitsstudie, Kap. 5.3)

- **DSGVO:** Veröffentlichung von Personennamen = eigene Verarbeitung, gestützt
  auf Art. 6 Abs. 1 lit. f (berufsbezogene, publizitätspflichtige Tatsachen).
  Erforderlich: Hinweis in der Datenschutzerklärung, dokumentierte
  Interessenabwägung, funktionierender Widerspruchsprozess. Letzterer ist
  implementiert: `node scripts/approve.js --remove "<Name>"` entfernt
  publizierte Einträge; der Hinweis mit Kontaktlink steht in der Methodik-Box
  des Frontends.
- **Presserecht:** Nur Fakten in Eigenformulierung + Link zur Quelle. Keine
  Artikeltexte übernehmen (§§ 87f ff. UrhG). Die Extraktion ist entsprechend
  geprompted; die Freigabe prüft es nochmal menschlich.
- **Sorgfalt:** Falschmeldungen über reale Personen sind abmahnfähig. Deshalb:
  kein Auto-Publish, jeder Eintrag braucht eine belastbare Quelle.

## Kosten

RSS: 0 €. Claude API: wenige Euro/Monat (kurze Extraktions-Prompts).
handelsregister.ai: Free Tier zum Start, bei voller Watchlist realistisch
50–200 €/Monat. GitHub Actions + Hosting: 0 €.

## Lokal testen

```
MOCK=1 node scripts/fetch-tracker.js && node scripts/approve.js
npx serve public
```
