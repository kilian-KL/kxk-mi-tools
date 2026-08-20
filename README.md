# KxK Market-Intelligence-Tools

Zwei Datenpipelines für die Website von Kempkens × Kohler.

| Ordner | Tool | Lauf |
|---|---|---|
| `leadership-tracker/` | Führungswechsel im DACH-Raum | werktags 5:00 UTC |
| `wachstums-radar/` | Funding, Expansion, Restrukturierung | Mo + Do |

Beide arbeiten gleich: RSS-Quellen (plus optional Handelsregister) einlesen,
relevante Meldungen filtern, per Claude die Fakten extrahieren, in eine
Warteschlange legen. **Veröffentlicht wird nur, was ein Mensch freigegeben hat** —
das ist bei personenbezogenen Meldungen keine Bequemlichkeit, sondern die
rechtliche Grundlage.

## Secrets

| Name | Pflicht |
|---|---|
| `ANTHROPIC_API_KEY` | ja |
| `HANDELSREGISTER_API_KEY` | nein — ohne läuft es rein über die Presse-Feeds |

## Freigabe

```bash
git pull
cd leadership-tracker && node scripts/approve.js && cd ..
git add . && git commit -m "Freigabe" && git push
```

Widerspruch umsetzen: `node scripts/approve.js --remove "<Name>"`

## Credits im Blick behalten

Der Handelsregister-Teil kostet einen Credit pro Firma und Lauf. Die Watchlist
wird deshalb rotierend abgearbeitet, begrenzt über `max_calls_per_run` in
`config/sources.json` (Tracker 20, Radar 10). Stand der Rotation:
`data/hr-cursor.json`.

Details siehe `ANLEITUNG_KILIAN_Tools-scharfschalten.md`.
