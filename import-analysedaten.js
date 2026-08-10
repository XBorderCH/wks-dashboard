// Import-Skript für Analysedaten (zweite Excel-Datei mit Geruch/Farbe/Messwerten pro Kontrolle).
// Ordnet die Daten anhand KdNr + Datum den bestehenden Kundendaten (data/kunden.json) zu
// und ergänzt dort ein neues Feld "analysedaten" (Liste pro Servicetermin).
//
// Aufruf: node import-analysedaten.js <pfad-zur-analysedaten-datei.xlsx>

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Bitte Pfad zur Analysedaten-Excel-Datei angeben: node import-analysedaten.js <datei.xlsx>');
  process.exit(1);
}

const kundenPfad = path.join(__dirname, 'data', 'kunden.json');
const kunden = JSON.parse(fs.readFileSync(kundenPfad, 'utf-8'));
const kundenByKdnr = {};
kunden.forEach((k) => { kundenByKdnr[k.kdnr] = k; });

const wb = XLSX.readFile(inputPath, { cellDates: true });
const sheetName = wb.SheetNames[0];
const sheet = wb.Sheets[sheetName];

// Header steht in Zeile 1, Daten ab Zeile 2 (0-basiert: Header-Row = 0)
const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
const header = rows[0];

// Hilfsfunktion: Spaltenbuchstabe -> 0-basierter Index
function col(letter) {
  let n = 0;
  for (const ch of letter) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'nan' || s.toLowerCase() === 'nat') return null;
  return s;
}

function istAngekreuzt(v) {
  return v !== null && v !== undefined && String(v).trim().toLowerCase() === 'x';
}

function fmtDatum(v) {
  if (!(v instanceof Date) || isNaN(v.getTime())) return null;
  const dd = String(v.getDate()).padStart(2, '0');
  const mm = String(v.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${v.getFullYear()}`;
}

// Checkbox-Gruppe auswerten: gibt die angekreuzten Wörter zusammengesetzt zurück
function checkboxGruppe(row, wortSpalten, beschriebSpalte, andereWort, trenner) {
  const woerter = [];
  wortSpalten.forEach(([spalte, wort]) => {
    if (istAngekreuzt(row[col(spalte)])) woerter.push(wort);
  });
  let text = woerter.join(trenner);
  const beschrieb = beschriebSpalte ? clean(row[col(beschriebSpalte)]) : null;
  if (beschrieb) {
    text = text ? `${text} (${beschrieb})` : beschrieb;
  }
  return text || null;
}

// Anzahl nicht-leerer Analysefelder (für Dedupe: Zeile mit mehr Inhalt gewinnt)
function inhaltsScore(row) {
  let n = 0;
  for (let c = col('U'); c <= col('BO'); c++) {
    if (clean(row[c]) !== null) n++;
  }
  return n;
}

const eintraegeProKdnrDatum = {}; // key: "kdnr|datum" -> { row, score }

for (let i = 1; i < rows.length; i++) {
  const row = rows[i];
  if (!row) continue;
  const kdnr = clean(row[col('D')]);
  if (!kdnr) continue;
  const datum = fmtDatum(row[col('S')]);
  if (!datum) continue;

  const key = `${kdnr}|${datum}`;
  const score = inhaltsScore(row);
  if (!eintraegeProKdnrDatum[key] || eintraegeProKdnrDatum[key].score < score) {
    eintraegeProKdnrDatum[key] = { row, score };
  }
}

let zugeordnet = 0;
let keinKundeGefunden = 0;
const nichtGefundeneKdnr = [];
const korrigierteTermine = [];
const neueTermine = [];

// Immer anzuzeigende Messwerte (auch wenn leer -> "k.A.")
const IMMER_FELDER = [
  ['AL', 'pH'],
  ['AM', 'O2 A'],
  ['AN', 'Temp A'],
  ['AO', 'DS'],
  ['AV', 'Amm.'],
  ['AX', 'CSB'],
];

// Optionale Messwerte (nur anzeigen, wenn befüllt)
const OPTIONALE_FELDER = [
  ['AP', 'Bewuchs'],
  ['AQ', 'Schlammfarbe'],
  ['AR', 'O2 BB'],
  ['AS', 'Temp'],
  ['AT', 'BB'],
  ['AU', 'NB'],
  ['AW', 'Ab.Vol.'],
  ['AY', 'Stunden'],
  ['AZ', 'Nitrit'],
  ['BA', 'Absaugen'],
  ['BB', 'Monteur'],
  ['BK', 'Betriebsjournal'],
  ['BL', 'Phosphat'],
  ['BM', 'GUS'],
  ['BN', 'Wetter'],
  ['BO', 'TOC'],
];

// Bemerkungsfelder, ausgeschrieben wenn vorhanden
const BEMERKUNGS_FELDER = [
  ['BE', 'Bemerkungen'],
  ['BF', 'Bem. AWEL'],
  ['BG', 'Vermerk WKS'],
  ['BH', 'Ersatzteile'],
  ['BI', 'Nächster Service'],
  ['BJ', 'Büro Information'],
];

function parseDatum(v) {
  const m = String(v).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

// Sucht im Terminverlauf des Kunden den zeitlich nächstgelegenen Termin zum Analysedaten-Datum
// (innerhalb von maximal 30 Tagen), damit verschobene Termine erkannt werden können.
function findeNaechstenTermin(termine, zielDatum, maxTageAbstand) {
  const ziel = parseDatum(zielDatum);
  if (!ziel) return null;
  let bester = null;
  let besterAbstand = Infinity;
  (termine || []).forEach((t) => {
    const d = parseDatum(t.datum);
    if (!d) return;
    const abstandTage = Math.abs(d - ziel) / (24 * 60 * 60 * 1000);
    if (abstandTage <= maxTageAbstand && abstandTage < besterAbstand) {
      besterAbstand = abstandTage;
      bester = t;
    }
  });
  return bester;
}

Object.keys(eintraegeProKdnrDatum).forEach((key) => {
  const [kdnr, datum] = key.split('|');
  const { row } = eintraegeProKdnrDatum[key];
  const kunde = kundenByKdnr[kdnr];

  if (!kunde) {
    keinKundeGefunden++;
    nichtGefundeneKdnr.push(kdnr);
    return;
  }

  // Abgleich: existiert für dieses Datum ein Termin in den bisherigen Kundendaten?
  // Falls nicht exakt, aber ein naher Termin existiert (verschobener Termin) -> dessen Datum korrigieren.
  // Falls gar kein Termin in der Nähe existiert -> vermutlich ein zusätzlicher, ungeplanter Einsatz;
  // dann wird ein neuer Termin ergänzt statt einen unpassenden zu überschreiben.
  let passenderTermin = (kunde.termine || []).find((t) => t.datum === datum);
  if (!passenderTermin) {
    const naechster = findeNaechstenTermin(kunde.termine, datum, 30);
    if (naechster) {
      korrigierteTermine.push({ kdnr, kdnrName: kunde.kdnrName, alt: naechster.datum, neu: datum });
      naechster.datum = datum;
      // Jahr neu ableiten, falls sich das Kalenderjahr durch die Korrektur verschiebt
      const neuesDatumObj = parseDatum(datum);
      if (neuesDatumObj) naechster.jahr = String(neuesDatumObj.getFullYear());
      passenderTermin = naechster;
    } else {
      const neuesDatumObj = parseDatum(datum);
      const neuerTermin = { halbjahr: null, jahr: neuesDatumObj ? String(neuesDatumObj.getFullYear()) : null, datum };
      if (!kunde.termine) kunde.termine = [];
      kunde.termine.push(neuerTermin);
      kunde.termine.sort((a, b) => (a.jahr + (a.halbjahr || '0')).localeCompare(b.jahr + (b.halbjahr || '0')));
      neueTermine.push({ kdnr, kdnrName: kunde.kdnrName, datum });
      passenderTermin = neuerTermin;
    }
  }

  const geruch = checkboxGruppe(
    row,
    [['U', 'kein'], ['V', 'leicht'], ['W', 'stark'], ['X', 'faulig'], ['Y', 'erdig'], ['Z', 'andere']],
    'AA',
    'andere',
    ' '
  );
  const farbe = checkboxGruppe(
    row,
    [['AB', 'klar'], ['AC', 'trüb'], ['AD', 'gelblich'], ['AE', 'bräunlich'], ['AF', 'gräulich'], ['AG', 'andere']],
    'AH',
    'andere',
    ' / '
  );
  const schlammAblauf = checkboxGruppe(
    row,
    [['AI', 'kein'], ['AJ', 'wenig'], ['AK', 'viel']],
    null,
    null,
    ' '
  );

  const handlungsbedarfJa = istAngekreuzt(row[col('BC')]);
  const handlungsbedarfNein = istAngekreuzt(row[col('BD')]);
  let handlungsbedarf = null;
  if (handlungsbedarfJa) handlungsbedarf = 'Ja';
  else if (handlungsbedarfNein) handlungsbedarf = 'Nein';

  const messwerteImmer = IMMER_FELDER.map(([spalte, label]) => ({
    label,
    wert: clean(row[col(spalte)]) ?? 'k.A.',
  }));

  const messwerteOptional = OPTIONALE_FELDER
    .map(([spalte, label]) => ({ label, wert: clean(row[col(spalte)]) }))
    .filter((f) => f.wert !== null);

  const bemerkungen = BEMERKUNGS_FELDER
    .map(([spalte, label]) => ({ label, wert: clean(row[col(spalte)]) }))
    .filter((f) => f.wert !== null);

  const analyseEintrag = {
    datum,
    geruch,
    farbe,
    schlammAblauf,
    handlungsbedarf,
    messwerteImmer,
    messwerteOptional,
    bemerkungen,
  };

  if (!kunde.analysedaten) kunde.analysedaten = [];
  // Falls bereits vorhanden (erneuter Import), vorherigen Eintrag für dieses Datum ersetzen
  kunde.analysedaten = kunde.analysedaten.filter((a) => a.datum !== datum);
  kunde.analysedaten.push(analyseEintrag);
  kunde.analysedaten.sort((a, b) => a.datum.localeCompare(b.datum));

  zugeordnet++;
});

fs.writeFileSync(kundenPfad, JSON.stringify(kunden, null, 2), 'utf-8');

console.log(`Analysedaten importiert: ${zugeordnet} Einträge zugeordnet.`);
console.log(`Kunden nicht gefunden (KdNr existiert nicht in kunden.json): ${keinKundeGefunden}`);
if (nichtGefundeneKdnr.length) console.log('  ->', nichtGefundeneKdnr.join(', '));
console.log(`Termine im Hauptdatensatz korrigiert (verschobenes Datum übernommen): ${korrigierteTermine.length}`);
if (korrigierteTermine.length) {
  korrigierteTermine.forEach((k) => console.log(`  - KdNr ${k.kdnr} (${k.kdnrName}): ${k.alt} -> ${k.neu}`));
}
console.log(`Neue Termine ergänzt (kein bestehender Termin in der Nähe, vermutlich zusätzlicher Einsatz): ${neueTermine.length}`);
if (neueTermine.length) {
  neueTermine.forEach((t) => console.log(`  - KdNr ${t.kdnr} (${t.kdnrName}): neuer Termin ${t.datum}`));
}
