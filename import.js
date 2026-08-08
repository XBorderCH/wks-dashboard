// Import-Skript: liest die Excel-Datei ein und erzeugt data/kunden.json
// Aufruf: node import.js <pfad-zur-excel-datei>

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Bitte Pfad zur Excel-Datei angeben: node import.js <datei.xlsx>');
  process.exit(1);
}

const wb = XLSX.readFile(inputPath, { cellDates: true });
const sheetName = wb.SheetNames[0];
const sheet = wb.Sheets[sheetName];
const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });

function fmtDate(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    const dd = String(v.getDate()).padStart(2, '0');
    const mm = String(v.getMonth() + 1).padStart(2, '0');
    const yyyy = v.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
  }
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'nat' || s.toLowerCase() === 'nan') return null;
  return s;
}

function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'nan' || s.toLowerCase() === 'nat') return null;
  return s;
}

// Manche Zeit-Spalten sind in Excel als echte Zeitzelle formatiert (kommt als Date-Objekt
// mit Datum 1899-12-30 an), andere als reine Zahl (z.B. "1429"). Beide auf "HHMM" normalisieren,
// damit die Anzeige später gleich formatiert (HH:MM) werden kann.
function cleanZeit(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    const hh = String(v.getUTCHours()).padStart(2, '0');
    const mm = String(v.getUTCMinutes()).padStart(2, '0');
    return `${hh}${mm}`;
  }
  return clean(v);
}

function prettify(col) {
  return col.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function kontaktBlock(row, suffix) {
  return {
    titel: clean(row[`Titel_${suffix}`]),
    vorname: clean(row[`Vorname_${suffix}`]),
    name: clean(row[`Name_${suffix}`]),
    abteilung: clean(row[`Abteilung_${suffix}`]),
    strasse: clean(row[`Strasse_${suffix}`]),
    plz: clean(row[`PLZ_${suffix}`]),
    ort: clean(row[`Ort_${suffix}`]),
    natel: clean(row[`Natel_${suffix}`]),
    tel: clean(row[`Tel_${suffix}`]),
    mail: clean(row[`Mail_${suffix}`]),
  };
}

const SKIP_DAT_ZEIT = new Set(['Dat_S', 'Zeit_S', 'DatAvis']);
const REMARK_PREFIXES = ['Bem_Serv_', 'Bem_AWEL_', 'Vermerk_WKS_', 'Büro_Information_', 'Ersatzteile_', 'Ersatzteile '];
const SKIP_REMARK_EXACT = new Set(['Ersatzteile', 'Ersatzteile Alt', 'Ersatzteile_alt']);

const allColumns = rows.length ? Object.keys(rows[0]) : [];

const gebuehrJahre = new Set();
allColumns.forEach((c) => {
  const m = c.match(/^(?:R|Geb)_(\d{2})$/);
  if (m) gebuehrJahre.add(m[1]);
});
const gebuehrJahreSorted = [...gebuehrJahre].sort().reverse();

const kunden = rows.map((row) => {
  const kdnr = clean(row['KdNr']);

  const termineMap = {};
  allColumns.forEach((col) => {
    if (SKIP_DAT_ZEIT.has(col)) return;
    const dm = col.match(/^Dat_(1|2)_(\d{2})(?:\.\d+)?$/);
    const zm = col.match(/^Zeit_(1|2)_(\d{2})$/);
    if (dm) {
      const key = `${dm[1]}_${dm[2]}`;
      termineMap[key] = termineMap[key] || { halbjahr: dm[1], jahr: '20' + dm[2] };
      const val = fmtDate(row[col]);
      if (val) termineMap[key].datum = val;
    }
    if (zm) {
      const key = `${zm[1]}_${zm[2]}`;
      termineMap[key] = termineMap[key] || { halbjahr: zm[1], jahr: '20' + zm[2] };
      const val = cleanZeit(row[col]);
      if (val) termineMap[key].zeit = val;
    }
  });
  const termine = Object.values(termineMap)
    .filter((t) => t.datum || t.zeit)
    .sort((a, b) => (a.jahr + a.halbjahr).localeCompare(b.jahr + b.halbjahr));

  const gebuehren = gebuehrJahreSorted
    .map((yy) => ({
      jahr: '20' + yy,
      rechnungsNr: clean(row[`R_${yy}`]),
      betrag: clean(row[`Geb_${yy}`]),
    }))
    .filter((g) => g.rechnungsNr || g.betrag);

  const weitereBemerkungen = [];
  allColumns.forEach((col) => {
    if (SKIP_REMARK_EXACT.has(col)) return;
    if (!REMARK_PREFIXES.some((p) => col.startsWith(p))) return;
    const val = clean(row[col]);
    if (val) weitereBemerkungen.push({ label: prettify(col), value: val });
  });

  const kontakte = {
    eigentuemer: kontaktBlock(row, 'E'),
    betreiber: kontaktBlock(row, 'B'),
    rechnung: {
      ...kontaktBlock(row, 'R'),
      rechnungen: gebuehren,
      aktuelleGebuehr: clean(row['aktuelle_Gebühr']),
      wartOffen: clean(row['Wart.offen']),
      wartgeb: clean(row['Wartgeb.']),
    },
    avisierung: {
      ...kontaktBlock(row, 'Avis'),
      avisPapier: clean(row['Avis_Papier']),
      avisMail: clean(row['Avis_Mail']),
      zeitAvis: clean(row['ZeitAvis']),
      avisNaechsterService: clean(row['Avis_nächst.S']),
    },
  };

  const kunde = {
    kdnr,
    kdnrName: clean(row['KdNr und Name']),
    suchNamen: [
      clean(row['Name_E']),
      clean(row['Name_B']),
      clean(row['Name_R']),
      clean(row['Name_Avis']),
    ].filter(Boolean),

    anlage: {
      adresse: clean(row['Adresse_A']),
      plz: clean(row['PLZ_A']),
      ort: clean(row['Ort_A']),
      koordinaten: clean(row['Koordinaten']),
      region: clean(row['Region Ost/West']),
      anlagenlieferant: clean(row['Anlagenlieferant']),
      anlagentyp: clean(row['Anlagentyp']),
      groesse: clean(row['Gr.Anlage']),
      ews: clean(row['Ews']),
      ewp: clean(row['Ewp']),
      anzahlService: clean(row['Anzahl_Service']),
      komprTyp: clean(row['Kompr.typ']),
      gwaNr: clean(row['GWANr']),
      ibs: fmtDate(row['IBS']),
      naechsterService: fmtDate(row['Nächst.Serv.']),
      letzterService: fmtDate(row['letzter Serv.']),
      vertragAb: fmtDate(row['Vertrag_ab']),
      filtersack: clean(row['Filtersack']),
      umbauTyp: clean(row['Umbau_TYP_WKS']),
      jg: clean(row['JG']),
      ft: clean(row['FT']),
      st: clean(row['ST']),
      ht: clean(row['HT']),
      dauer: clean(row['Dauer']),
    },

    kontakte,

    planung: {
      kontrollePlanung: clean(row['Kontrolle Planung']),
      tag: clean(row['Tag']),
      datS: fmtDate(row['Dat_S']),
      zeitS: cleanZeit(row['Zeit_S']),
      dat226: fmtDate(row['Dat_2_26']),
      zeit226: cleanZeit(row['Zeit_2_26']),
      datAvis: fmtDate(row['DatAvis']),
      zustKt: clean(row['Zust.Kt.']),
    },

    termine,
    gebuehren,
    aktuelleGebuehr: clean(row['aktuelle_Gebühr']),
    wartOffen: clean(row['Wart.offen']),
    wartgeb: clean(row['Wartgeb.']),

    bemerkungen: {
      buero: clean(row['Bem_Buero']),
      intern: clean(row['Bem.intern']),
      planung: clean(row['Bem_Planung']),
      besonderes: clean(row['Besonderes']),
      ersatzteile: clean(row['Ersatzteile']),
      ersatzteileAlt: clean(row['Ersatzteile Alt']) || clean(row['Ersatzteile_alt']),
      weitere: weitereBemerkungen,
    },

    rohdaten: row,
  };

  return kunde;
});

const outDir = path.join(__dirname, 'data');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'kunden.json'), JSON.stringify(kunden, null, 2), 'utf-8');

console.log(`Import fertig: ${kunden.length} Kunden aus "${sheetName}" importiert -> data/kunden.json`);
