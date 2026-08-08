# Kundendatenbank

Passwortgeschützte, durchsuchbare Web-Ansicht der Kunden-Excel (Suche über
Kundennummer oder Nachname, Detailansicht mit allen Daten).

## Lokal starten

```
npm install
node import.js pfad/zur/datei.xlsx   # erzeugt data/kunden.json
APP_PASSWORD=deinPasswort node server.js
```

Aufruf dann unter http://localhost:3001

## Daten aktualisieren

Wenn sich die Excel-Datei ändert: neue Datei einmal importieren
(`node import.js neue-datei.xlsx`), `data/kunden.json` committen/hochladen
und neu deployen (bzw. bei Render: Datei im Repo ersetzen und pushen).

## Deployment auf Render

1. Dieses Verzeichnis als Git-Repo anlegen und auf GitHub pushen (inkl.
   `data/kunden.json` mit den echten Daten – die Original-Excel-Datei muss
   NICHT ins Repo, nur das Ergebnis von `node import.js`).
2. Auf Render: "New Web Service" → Repo verbinden.
   - Build Command: `npm install`
   - Start Command: `node server.js`
3. Umgebungsvariablen bei Render setzen:
   - `APP_PASSWORD` – das gemeinsame Passwort für den Zugang
   - `SESSION_SECRET` – ein beliebiger langer Zufallsstring
4. Fertig – Render liefert eine URL, z.B. `https://kundendb.onrender.com`

## Hinweis zur Feldzuordnung

Die Anzeige gruppiert die wichtigsten Felder (Anlage, Kontakte, Service-
Termine, Gebühren, Bemerkungen). Ganz unten bei jedem Kunden gibt es
zusätzlich "Alle Original-Felder anzeigen" – dort stehen wirklich alle
Spalten aus der Excel-Datei, falls mal etwas in der gruppierten Ansicht
fehlt oder falsch zugeordnet ist.
