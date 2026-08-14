// Update-Skript: Überschreibt zukünftige Servicetermine in data/kunden.json
// mit den Daten aus dem neuen Datenblatt (Dat_S, Zeit_S, Dat_2_26, Zeit_2_26,
// Kontrolle Planung, Tag).
//
// Aufruf: node update-serviceplanung.js <pfad-zum-datenblatt.xlsx>

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Bitte Pfad zum Datenblatt angeben: node update-serviceplanung.js <datei.xlsx>');
  process.exit(1);
}

const kundenPfad = path.join(__dirname, 'data', 'kunden.json');
const kunden = JSON.parse(fs.readFileSync(kundenPfad, 'utf-8'));
const kundenByKdnr = {};
kunden.forEach((k) => { kundenByKdnr[k.kdnr] = k; });

const wb = XLSX.readFile(inputPath, { cellDates: true });
const sheet = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });

function fmtDate(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime()) || v.getFullYear() < 1950) return null;
    const dd = String(v.getDate()).padStart(2, '0');
    const mm = String(v.getMonth() + 1).padStart(2, '0');
    return `${dd}.${mm}.${v.getFullYear()}`;
  }
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'nan' || s.toLowerCase() === 'nat') return null;
  return s;
}

function cleanZeit(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    const hh = String(v.getUTCHours()).padStart(2, '0');
    const mm = String(v.getUTCMinutes()).padStart(2, '0');
    return `${hh}${mm}`;
  }
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'nan' || s.toLowerCase() === 'nat') return null;
  return s;
}

function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'nan' || s.toLowerCase() === 'nat' || s === 'false') return null;
  return s;
}

function parseFahrer(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^Ralph\b/i.test(s)) return 'Ralph';
  if (/^K\b/i.test(s)) return 'Kathrin';
  return null;
}

function parseDatum(v) {
  const m = String(v).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

// Stichtag: heute um Mitternacht
const heute = new Date();
heute.setHours(0, 0, 0, 0);

let kundenAktualisiert = 0;
let termineEntfernt = 0;
let termineHinzugefuegt = 0;
let kundenNichtGefunden = 0;
const nichtGefunden = [];

rows.forEach((row) => {
  const kdnr = clean(row['KdNr']);
  if (!kdnr) return;

  const kunde = kundenByKdnr[kdnr];
  if (!kunde) {
    kundenNichtGefunden++;
    nichtGefunden.push(kdnr);
    return;
  }

  const kontrollePlanung = clean(row['Kontrolle Planung']);
  const fahrer = parseFahrer(kontrollePlanung);
  const tag = clean(row['Tag']);
  const datS = fmtDate(row['Dat_S']);
  const zeitS = cleanZeit(row['Zeit_S']);
  const dat2 = fmtDate(row['Dat_2_26']);
  const zeit2 = cleanZeit(row['Zeit_2_26']);

  // 1. Alle bestehenden zukünftigen Termine entfernen (ab heute)
  const vorher = (kunde.termine || []).length;
  kunde.termine = (kunde.termine || []).filter((t) => {
    const d = parseDatum(t.datum);
    if (!d) return true; // ungültiges Datum behalten
    return d.getTime() < heute.getTime(); // nur vergangene behalten
  });
  const entfernt = vorher - kunde.termine.length;
  termineEntfernt += entfernt;

  // 2. Neue Termine aus dem Datenblatt hinzufügen
  const neueTermine = [];
  if (datS) {
    const d = parseDatum(datS);
    neueTermine.push({
      halbjahr: '1',
      jahr: d ? String(d.getFullYear()) : null,
      datum: datS,
      zeit: zeitS,
    });
  }
  if (dat2 && dat2 !== datS) {
    const d = parseDatum(dat2);
    neueTermine.push({
      halbjahr: '2',
      jahr: d ? String(d.getFullYear()) : null,
      datum: dat2,
      zeit: zeit2,
    });
  } else if (dat2 && dat2 === datS && zeitS !== zeit2 && zeit2) {
    // Gleiches Datum, aber andere Uhrzeit -> 2. Service am selben Tag
    const d = parseDatum(dat2);
    neueTermine.push({
      halbjahr: '2',
      jahr: d ? String(d.getFullYear()) : null,
      datum: dat2,
      zeit: zeit2,
    });
  }

  neueTermine.forEach((t) => {
    // Nur einfügen, falls nicht schon vorhanden (Duplikat-Schutz)
    const existiert = kunde.termine.some(
      (ex) => ex.datum === t.datum && ex.halbjahr === t.halbjahr
    );
    if (!existiert) {
      kunde.termine.push(t);
      termineHinzugefuegt++;
    }
  });

  // Termine chronologisch sortieren
  kunde.termine.sort((a, b) =>
    (a.jahr + (a.halbjahr || '0')).localeCompare(b.jahr + (b.halbjahr || '0'))
  );

  // 3. Planung aktualisieren
  kunde.planung = kunde.planung || {};
  if (kontrollePlanung !== null) kunde.planung.kontrollePlanung = kontrollePlanung;
  if (fahrer !== null) kunde.planung.fahrer = fahrer;
  if (tag !== null) kunde.planung.tag = tag;
  if (datS !== null) kunde.planung.datS = datS;
  if (zeitS !== null) kunde.planung.zeitS = zeitS;
  if (dat2 !== null) kunde.planung.dat226 = dat2;
  if (zeit2 !== null) kunde.planung.zeit226 = zeit2;

  kundenAktualisiert++;
});

fs.writeFileSync(kundenPfad, JSON.stringify(kunden, null, 2), 'utf-8');

console.log(`Update abgeschlossen.`);
console.log(`Kunden aktualisiert: ${kundenAktualisiert}`);
console.log(`Zukünftige Termine entfernt (alt): ${termineEntfernt}`);
console.log(`Neue Termine hinzugefügt: ${termineHinzugefuegt}`);
console.log(`Kunden im Datenblatt, aber nicht in kunden.json: ${kundenNichtGefunden}`);
if (nichtGefunden.length) console.log('  ->', nichtGefunden.join(', '));
