# MI-Tools scharfschalten — was du noch machen musst

Stand 19.08.2026. Betrifft **Leadership-Change-Tracker** und **Wachstums-Radar**.
Die anderen beiden brauchen dich hier nicht: Der Hiring Index läuft bereits live
über Adzuna, der Gehaltsrechner hängt an den Mandatsdaten von KxK.

---

## Was ich schon erledigt habe

- Beide Pakete entpackt und konfiguriert in `tools/`
- Alle Feed-URLs geprüft — **9 von 9 laufen**
- Zwei tote Feeds ersetzt: Börsen-Zeitung (404) → manager magazin + WirtschaftsWoche,
  PresseBox (403) → Gründerszene
- **Credit-Bremse eingebaut** (siehe unten) — ohne die wären deine 500 Credits
  nach einem Lauf weg gewesen
- Beide Pipelines im Trockenlauf getestet: Einlesen → Filter → Extraktion →
  Warteschlange → Freigabe → Veröffentlichung. Auch die DSGVO-Löschung
  (`--remove`) funktioniert.
- Quellen-Labels im Frontend an die neue Feed-Auswahl angepasst

**Es fehlt nur der Betrieb.** Rechne mit 30–40 Minuten für beide Tools.

---

## Wichtig zuerst: deine 500 handelsregister.ai-Credits

Die Pipeline macht **einen API-Aufruf pro Firma und Lauf** — ein Aufruf kostet
einen Credit. Ohne Begrenzung hättest du bei einer Watchlist mit 500 Firmen dein
gesamtes Guthaben in einem einzigen Lauf verbraucht.

Deshalb habe ich eine Rotation eingebaut: Pro Lauf wird nur ein Ausschnitt der
Watchlist abgefragt, beim nächsten Lauf der nächste. Lange Listen werden so über
mehrere Tage vollständig abgedeckt, ohne das Guthaben zu sprengen.

Eingestellt ist:

| Tool | Aufrufe pro Lauf | Läufe/Monat | Credits/Monat |
|---|---|---|---|
| Tracker | 20 | 21 (werktags) | 420 |
| Radar | 10 | 8 (Mo + Do) | 80 |

Zusammen **500 Credits im Monat** — passt exakt auf dein kostenloses Kontingent,
lässt aber keine Luft. Zwei Möglichkeiten:

- **Sicherer Start:** Tracker auf `15` runterstellen → 315 + 80 = 395 Credits,
  ein Fünftel Puffer.
- **Register vorerst weglassen:** `"enabled": false` in beiden
  `config/sources.json` — dann laufen die Tools rein über die Presse-Feeds und
  kosten null Credits. Das Register lässt sich jederzeit dazuschalten.

Die Zahl steht in `config/sources.json` unter `handelsregister.max_calls_per_run`.

Prüf bitte im handelsregister.ai-Konto, ob sich die 500 monatlich erneuern oder
einmalig sind — davon hängt ab, ob das dauerhaft trägt. Im Screenshot stand bei
den gekauften Credits „31 Tage gültig", für das Freikontingent war es nicht
eindeutig.

---

## Schritt 1 — Repository hochladen (3 Min)

Der Ordner `tools/` ist bereits ein fertiges Git-Repository: Workflows liegen
korrekt in `.github/workflows/`, die Pfade darin sind angepasst, `.gitignore`
und README stehen, der erste Commit ist gemacht.

Du musst nur noch auf GitHub ein leeres Repo anlegen (**ohne** README, damit
nichts kollidiert) und dann:

```bash
cd "/Users/kili/Desktop/06 Kempkens x Kohler/tools"
git remote add origin https://github.com/<dein-konto>/kxk-mi-tools.git
git branch -M main
git push -u origin main
```

Wegen Schritt 5 (die Website muss die Daten lesen können): **öffentlich** anlegen
ist am einfachsten. Im Repo stehen keine Keys — die liegen als Secrets.

## Schritt 2 — Keys hinterlegen (2 Min)

Im Repo unter **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Wert |
|---|---|
| `ANTHROPIC_API_KEY` | dein Key von console.anthropic.com |
| `HANDELSREGISTER_API_KEY` | dein Key von handelsregister.ai |

Anthropic ist Pflicht, Handelsregister optional. Kosten bei Anthropic: wenige
Euro im Monat — genau die Token-Kosten, die du im Retainer eingepreist hast.

---

## Schritt 3 — Watchlist füllen (das ist der Blocker)

`leadership-tracker/config/watchlist.json` enthält Platzhalter. Ohne echte
Firmenliste hat der Register-Teil nichts zu beobachten.

Gebraucht wird pro Unternehmen: **Name, Sitz, Vertical**
(`masch`, `ls`, `tech`, `pe`, `fam`).

Das musst **du nicht liefern** — das kommt von Oliver und Sebastian, ein
HubSpot-Export reicht. Sobald die Liste da ist, bringe ich sie ins Format.

**Ohne Watchlist läuft es trotzdem:** Die Presse-Feeds arbeiten unabhängig davon.
Du bekommst Führungswechsel aus der Wirtschaftspresse, nur nicht gezielt zu deren
Zielunternehmen. Für den Start reicht das völlig.

Bedenke bei der Größe: Bei 20 Abfragen pro Lauf braucht eine Liste mit 500 Firmen
25 Werktage für einen vollen Durchlauf. Für Führungswechsel ist das vertretbar —
aber lieber 200 gut ausgewählte Firmen als 2.000 wahllose.

---

## Schritt 4 — Erster Lauf und Freigabe (10 Min)

Action von Hand starten (**Actions → Fetch Leadership Changes → Run workflow**).
Danach lokal:

```bash
git pull
cd leadership-tracker
node scripts/approve.js        # j / n / e pro Eintrag, mit Quelle und Link
cd ..
git add . && git commit -m "Tracker-Freigabe" && git push
```

Die Demo-Einträge dabei mit `n` verwerfen — dann verschwindet auch der Hinweis
„Demodaten" im Frontend.

---

## Schritt 5 — Website anbinden (5 Min)

In diesen zwei Dateien jeweils **eine Zeile** ersetzen:

`website/market-intelligence/tools/leadership-tracker.html` (~Zeile 114):

```js
const KXK_DATA_URL = "https://raw.githubusercontent.com/<konto>/kxk-mi-tools/main/leadership-tracker/public/tracker-data.json";
```

`website/market-intelligence/tools/wachstums-radar.html`:

```js
const KXK_DATA_URL = "https://raw.githubusercontent.com/<konto>/kxk-mi-tools/main/wachstums-radar/public/radar-data.json";
```

An beiden Stellen steht ein Kommentar mit dem erwarteten Format. Danach neu
deployen. Ab dann zieht die Website die freigegebenen Daten direkt — **jede
Freigabe ist sofort live, ohne Redeploy.**

Zum Schluss den Demo-Hinweis unter den beiden Tools entfernen, so wie beim
Hiring Index bereits geschehen.

**Achtung bei privatem Repo:** `raw.githubusercontent.com` liefert dann nichts
aus. Entweder das Repo öffentlich machen (die Daten sind ohnehin für die
Website bestimmt), oder nur den `public/`-Ordner über GitHub Pages
veröffentlichen.

---

## Laufender Betrieb

**Tracker:** werktags 5:00 UTC · Freigabe 5–10 Minuten
**Radar:** montags und donnerstags · Freigabe 5 Minuten

Geht auch gesammelt — zweimal die Woche 15 Minuten reichen in der Praxis.

---

## Warum die Freigabe von Hand nicht wegoptimiert werden darf

Automatisch veröffentlichte Personennamen sind das Haftungsrisiko an diesem
Tool. Eine Falschmeldung über eine reale Führungskraft ist abmahnbar. Die
Freigabe ist kein Komfort-Schritt, sondern die rechtliche Grundlage — genauso
wie der Widerspruchsprozess:

```bash
node scripts/approve.js --remove "<Name>"
```

`--all` also nur, wenn du die Einträge vorher wirklich gelesen hast.

---

## Kurz zum Selbsttesten

```bash
cd leadership-tracker
node scripts/check-sources.js                  # Feeds prüfen
MOCK=1 node scripts/fetch-tracker.js           # Pipeline ohne API-Kosten
node scripts/approve.js                        # Freigabe durchspielen
```

---

*KL Design · 19.08.2026*
