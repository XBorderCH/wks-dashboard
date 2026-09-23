// Drive-Sync: liest Stammdaten.xlsx und die drei Analyse-Dateien aus dem
// Google-Drive-Ordner und führt sie in den Datenbestand des Dashboards.
//
// Nötige Umgebungsvariablen:
//   GOOGLE_SERVICE_ACCOUNT   – kompletter Inhalt der JSON-Schlüsseldatei
//   GOOGLE_DRIVE_FOLDER_ID   – ID des Drive-Ordners (Teil nach /folders/)

const { google } = require('googleapis');
const XLSX = require('xlsx');

const ORDNER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '1nda-sPJo3_XJ1dvvqKy73XwP5Yhhmt5r';

const DATEIEN = {
  stammdaten: 'Stammdaten.xlsx',
  analyse: ['Analyse_Kathrin.xlsx', 'Analyse_Ralph.xlsx', 'Analyse_Daniel.xlsx'],
};

// ---------- Hilfsfunktionen ----------
function clean(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s || ['nan', 'nat', '#n/a', 'none', 'false'].includes(s.toLowerCase())) return null;
    return s;
  }
  return v;
}

function text(v) {
  const c = clean(v);
  return c === null ? null : String(c).trim();
}

function exceldatum(v) {
  const c = clean(v);
  if (c === null) return null;
  if (c instanceof Date) {
    if (c.getFullYear() < 1950) return null;
    return `${String(c.getDate()).padStart(2, '0')}.${String(c.getMonth() + 1).padStart(2, '0')}.${c.getFullYear()}`;
  }
  if (typeof c === 'number' && c > 1000) {
    const d = new Date(Date.UTC(1899, 11, 30) + c * 86400000);
    return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
  }
  const s = String(c).trim();
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return `${m[1].padStart(2, '0')}.${m[2].padStart(2, '0')}.${m[3]}`;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
  return null;
}

function excelzeit(v) {
  const c = clean(v);
  if (c === null) return null;
  if (typeof c === 'number' && c > 0 && c < 1) {
    const min = Math.round(c * 24 * 60);
    return `${String(Math.floor(min / 60)).padStart(2, '0')}${String(min % 60).padStart(2, '0')}`;
  }
  if (c instanceof Date) {
    return `${String(c.getHours()).padStart(2, '0')}${String(c.getMinutes()).padStart(2, '0')}`;
  }
  const s = String(c).trim();
  const m = s.match(/^(\d{1,2})[:.](\d{2})/);
  if (m) return `${m[1].padStart(2, '0')}${m[2]}`;
  if (/^\d{3,4}$/.test(s)) return s.padStart(4, '0');
  return s || null;
}

function sortDatum(d) {
  const m = String(d || '').match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  return m ? m[3] + m[2].padStart(2, '0') + m[1].padStart(2, '0') : '00000000';
}

// ---------- Drive-Zugriff ----------
function authClient() {
  const roh = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!roh) throw new Error('GOOGLE_SERVICE_ACCOUNT ist nicht gesetzt.');
  let konto;
  try {
    konto = JSON.parse(roh);
  } catch (e) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT enthält kein gültiges JSON.');
  }
  return new google.auth.JWT({
    email: konto.client_email,
    key: (konto.private_key || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
}

async function ladeDateien(gesuchteNamen) {
  const drive = google.drive({ version: 'v3', auth: authClient() });
  const liste = await drive.files.list({
    q: `'${ORDNER_ID}' in parents and trashed = false`,
    fields: 'files(id, name, modifiedTime, mimeType)',
    pageSize: 100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const gefunden = {};
  for (const datei of liste.data.files || []) {
    if (!gesuchteNamen.includes(datei.name)) continue;
    const antwort = await drive.files.get(
      { fileId: datei.id, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );
    gefunden[datei.name] = {
      geaendert: datei.modifiedTime,
      workbook: XLSX.read(Buffer.from(antwort.data), { type: 'buffer', cellDates: true }),
    };
  }
  return gefunden;
}

function zeilen(workbook, blattName) {
  const blatt = workbook.Sheets[blattName] || workbook.Sheets[workbook.SheetNames[0]];
  if (!blatt) return [];
  return XLSX.utils.sheet_to_json(blatt, { defval: null, raw: true });
}

// ---------- Stammdaten übernehmen ----------
function kontakt(z, suffix) {
  return {
    titel: text(z[`Titel ${suffix}`]),
    vorname: text(z[`Vorname ${suffix}`]),
    name: text(z[`Name ${suffix}`]),
    abteilung: text(z[`Abteilung ${suffix}`]),
    strasse: text(z[`Strasse ${suffix}`]),
    plz: text(z[`PLZ ${suffix}`]),
    ort: text(z[`Ort ${suffix}`]),
    natel: text(z[`Natel ${suffix}`]),
    tel: text(z[`Telefon ${suffix}`]),
    mail: text(z[`E-Mail ${suffix}`]),
  };
}

// Nur Felder überschreiben, die in der Datei vorkommen – alles andere
// (Gebührenhistorie, Analysedaten) bleibt unangetastet.
function uebernehmeStammdaten(kunden, rows) {
  let aktualisiert = 0, neu = 0;
  const nachKdnr = new Map();
  kunden.forEach(k => { if (k.kdnr) nachKdnr.set(String(k.kdnr).trim(), k); });

  rows.forEach(z => {
    const kdnr = text(z['KdNr']);
    if (!kdnr) return;
    let k = nachKdnr.get(String(kdnr));
    if (!k) {
      k = { kdnr: String(kdnr), suchNamen: [], termine: [], gebuehren: [], analysedaten: [] };
      kunden.push(k);
      nachKdnr.set(String(kdnr), k);
      neu++;
    } else {
      aktualisiert++;
    }

    k.kdnrName = text(z['KdNr und Name']) || k.kdnrName || String(kdnr);
    k.anlage = Object.assign({}, k.anlage, {
      adresse: text(z['Adresse Anlage']),
      plz: text(z['PLZ Anlage']),
      ort: text(z['Ort Anlage']),
      koordinaten: text(z['Koordinaten']),
      region: text(z['Region']),
      anlagenlieferant: text(z['Anlagenlieferant']),
      anlagentyp: text(z['Anlagentyp']),
      groesse: text(z['Grösse Anlage']),
      ews: text(z['EWS']),
      ewp: text(z['EWP']),
      anzahlService: text(z['Anzahl Service/Jahr']),
      komprTyp: text(z['Kompressortyp']),
      gwaNr: text(z['GWA-Nr.']),
      ibs: exceldatum(z['Inbetriebnahme']) || text(z['Inbetriebnahme']),
      vertragAb: exceldatum(z['Vertrag ab']) || text(z['Vertrag ab']),
      filtersack: text(z['Filtersack']),
      umbauTyp: text(z['Umbau Typ WKS']),
      dauer: text(z['Dauer (Min)']),
      objektNr: text(z['Objekt-Nr.']),
      subjektNr: text(z['Subjekt-Nr.']),
    });

    const avis = kontakt(z, 'Avisierung');
    avis.avisPapier = text(z['Avisierung Papier']);
    avis.zeitAvis = text(z['Zeitfenster Avisierung']);
    k.kontakte = Object.assign({}, k.kontakte, {
      eigentuemer: kontakt(z, 'Eigentümer'),
      betreiber: kontakt(z, 'Betreiber'),
      rechnung: Object.assign({}, (k.kontakte || {}).rechnung, kontakt(z, 'Rechnung')),
      avisierung: Object.assign({}, (k.kontakte || {}).avisierung, avis),
    });

    const gebuehr = text(z['Aktuelle Gebühr']);
    if (gebuehr !== null) {
      k.aktuelleGebuehr = gebuehr;
      if (k.kontakte.rechnung) k.kontakte.rechnung.aktuelleGebuehr = gebuehr;
    }
    const offen = text(z['Wartung offen']);
    if (offen !== null) {
      k.wartOffen = offen;
      if (k.kontakte.rechnung) k.kontakte.rechnung.wartOffen = offen;
    }

    k.bemerkungen = Object.assign({}, k.bemerkungen, {
      buero: text(z['Bemerkung Büro']),
      planung: text(z['Bemerkung Planung']),
      besonderes: text(z['Besonderes']),
      intern: text(z['Bemerkung intern']),
    });

    k.planung = Object.assign({}, k.planung, {
      fahrer: text(z['Fahrer']),
      zustKt: text(z['Zuständiger Kanton']),
    });

    const namen = new Set(k.suchNamen || []);
    ['Name Eigentümer', 'Name Betreiber', 'Name Rechnung', 'Name Avisierung'].forEach(sp => {
      const n = text(z[sp]);
      if (n) namen.add(n);
    });
    k.suchNamen = Array.from(namen);
  });

  return { aktualisiert, neu };
}

// ---------- Serviceplanung übernehmen ----------
function uebernehmePlanung(kunden, rows) {
  let kundenBetroffen = 0, termineNeu = 0, termineGeaendert = 0;
  const nachKdnr = new Map();
  kunden.forEach(k => { if (k.kdnr) nachKdnr.set(String(k.kdnr).trim(), k); });

  rows.forEach(z => {
    const kdnr = text(z['KdNr']);
    if (!kdnr) return;
    const k = nachKdnr.get(String(kdnr));
    if (!k) return;

    const dat1 = exceldatum(z['Datum 1. Service']);
    const zeit1 = excelzeit(z['Uhrzeit 1. Service']);
    const dat2 = exceldatum(z['Datum 2. Service']);
    const zeit2 = excelzeit(z['Uhrzeit 2. Service']);

    k.planung = Object.assign({}, k.planung, {
      fahrer: text(z['Fahrer']) || (k.planung || {}).fahrer || null,
      tag: text(z['Tag']),
      datS: dat1,
      zeitS: zeit1,
      dat226: dat2,
      zeit226: zeit2,
      zustKt: text(z['Kanton']) || (k.planung || {}).zustKt || null,
    });
    if (k.anlage) {
      k.anlage.naechsterService = text(z['Hinweis nächster Service']);
      k.anlage.letzterService = text(z['Hinweis letzter Service']);
    }

    let veraendert = false;
    [[dat1, zeit1], [dat2, zeit2]].forEach(([datum, zeit]) => {
      if (!datum) return;
      k.termine = k.termine || [];
      const vorhanden = k.termine.find(t => t.datum === datum);
      if (vorhanden) {
        if (zeit && vorhanden.zeit !== zeit) { vorhanden.zeit = zeit; termineGeaendert++; veraendert = true; }
      } else {
        const m = datum.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
        k.termine.push({ halbjahr: m && Number(m[2]) <= 6 ? '1' : '2', jahr: m ? m[3] : null, datum, zeit: zeit || null });
        termineNeu++;
        veraendert = true;
      }
    });

    // Termine des laufenden Jahres, die nicht mehr in der Planung stehen, entfernen
    const jahr = String(new Date().getFullYear());
    const geplant = [dat1, dat2].filter(Boolean);
    const vorher = (k.termine || []).length;
    k.termine = (k.termine || []).filter(t => {
      if (!t.datum || !t.datum.endsWith(jahr)) return true;
      return geplant.includes(t.datum);
    });
    if (k.termine.length !== vorher) veraendert = true;

    // Pro Datum nur ein Termin
    const best = new Map();
    (k.termine || []).forEach(t => {
      if (!t.datum) return;
      const v = best.get(t.datum);
      if (!v || (!v.zeit && t.zeit)) best.set(t.datum, t);
    });
    k.termine = Array.from(best.values())
      .sort((a, b) => sortDatum(a.datum).localeCompare(sortDatum(b.datum)));

    if (veraendert) kundenBetroffen++;
  });

  return { kundenBetroffen, termineNeu, termineGeaendert };
}

// ---------- Analysedaten übernehmen ----------
const MESS_IMMER = ['pH', 'O2 A', 'Temp A', 'DS', 'Amm.', 'CSB'];
const MESS_OPTIONAL = ['Bewuchs', 'Schlammfarbe', 'O2 BB', 'Temp', 'BB', 'NB', 'Ab.Vol.',
  'Stunden', 'Nitrit', 'Absaugen', 'Monteur', 'Betriebsjournal', 'Phosphat', 'GUS', 'Wetter', 'DOC'];
const BEMERKUNGEN = ['Bemerkungen', 'Bemerkung AWEL', 'Vermerk WKS', 'Ersatzteile',
  'Nächster Service', 'Büro Information'];

function ankreuz(z, praefix, optionen) {
  const treffer = [];
  optionen.forEach(o => {
    const v = text(z[`${praefix}: ${o}`]);
    if (v && String(v).toLowerCase() !== 'nein') treffer.push(o);
  });
  return treffer.join(', ') || null;
}

function baueAnalyse(z) {
  const datum = exceldatum(z['Datum Service']);
  if (!datum) return null;

  const messwerteImmer = [];
  MESS_IMMER.forEach(l => {
    const v = text(z[l]);
    if (v !== null) messwerteImmer.push({ label: l, wert: String(v) });
  });
  const messwerteOptional = [];
  MESS_OPTIONAL.forEach(l => {
    const v = text(z[l]);
    if (v !== null) messwerteOptional.push({ label: l, wert: String(v) });
  });
  const bemerkungen = [];
  BEMERKUNGEN.forEach(l => {
    const v = text(z[l]);
    if (v !== null) bemerkungen.push({ label: l, wert: String(v) });
  });

  let handlungsbedarf = null;
  if (text(z['Handlungsbedarf Ja'])) handlungsbedarf = 'Ja';
  else if (text(z['Handlungsbedarf Nein'])) handlungsbedarf = 'Nein';

  return {
    datum,
    geruch: ankreuz(z, 'Geruch', ['kein', 'leicht', 'stark', 'faulig', 'erdig', 'andere']),
    geruchBeschrieb: text(z['Geruch: Beschrieb']),
    farbe: ankreuz(z, 'Farbe', ['klar', 'trüb', 'gelblich', 'bräunlich', 'gräulich', 'andere']),
    farbeBeschrieb: text(z['Farbe: Beschrieb']),
    schlammAblauf: ankreuz(z, 'Schlamm', ['kein', 'wenig', 'viel']),
    handlungsbedarf,
    messwerteImmer,
    messwerteOptional,
    bemerkungen,
  };
}

// Prüft, ob die Datei die nötigen Spalten mitbringt. Fehlt KdNr oder
// Datum Service, kann keine Zeile zugeordnet werden – dann lieber abbrechen
// als stillschweigend nichts tun.
function pruefeAnalyseAufbau(rows, dateiname) {
  if (!rows.length) {
    throw new Error(`${dateiname} enthält keine Datenzeilen.`);
  }
  const spalten = Object.keys(rows[0]);
  const fehlend = ['KdNr', 'Datum Service'].filter(s => !spalten.includes(s));
  if (fehlend.length) {
    throw new Error(`${dateiname}: die Spalte ${fehlend.join(' und ')} fehlt. `
      + 'Die Kopfzeile darf nicht verändert werden – Spalten dürfen ausgeblendet, aber nicht gelöscht werden. '
      + 'Bitte die Originaldatei wiederherstellen.');
  }
  const mitKdnr = rows.filter(z => text(z['KdNr'])).length;
  if (mitKdnr === 0) {
    throw new Error(`${dateiname}: in keiner Zeile steht eine Kundennummer.`);
  }
  const leer = rows.length - mitKdnr;
  return { zeilen: rows.length, ohneKdnr: leer };
}

function uebernehmeAnalysen(kunden, rows) {
  let neu = 0, aktualisiert = 0, nichtGefunden = 0;
  const nachKdnr = new Map();
  kunden.forEach(k => { if (k.kdnr) nachKdnr.set(String(k.kdnr).trim(), k); });

  rows.forEach(z => {
    const kdnr = text(z['KdNr']);
    if (!kdnr) return;
    const k = nachKdnr.get(String(kdnr));
    if (!k) { nichtGefunden++; return; }

    const eintrag = baueAnalyse(z);
    if (!eintrag) return;

    k.analysedaten = k.analysedaten || [];
    const i = k.analysedaten.findIndex(a => a.datum === eintrag.datum);
    if (i >= 0) { k.analysedaten[i] = eintrag; aktualisiert++; }
    else { k.analysedaten.push(eintrag); neu++; }

    k.analysedaten.sort((a, b) => sortDatum(a.datum).localeCompare(sortDatum(b.datum)));
  });

  return { neu, aktualisiert, nichtGefunden };
}

// ---------- Hauptfunktion ----------
// Analysedaten archivieren: quelle = 'alle' | 'kathrin' | 'ralph' | 'daniel'
async function archiviereAnalysen(kunden, quelle = 'alle') {
  const q = String(quelle || 'alle').toLowerCase();
  const analyseDateien = {
    kathrin: 'Analyse_Kathrin.xlsx',
    ralph: 'Analyse_Ralph.xlsx',
    daniel: 'Analyse_Daniel.xlsx',
  };
  const gesucht = analyseDateien[q] ? [analyseDateien[q]] : [...DATEIEN.analyse];

  const dateien = await ladeDateien(gesucht);
  const bericht = { quelle: q, dateien: [], analysen: { neu: 0, aktualisiert: 0, nichtGefunden: 0 }, fehlend: [] };
  gesucht.forEach(n => { if (!dateien[n]) bericht.fehlend.push(n); });

  gesucht.forEach(name => {
    const datei = dateien[name];
    if (!datei) return;
    const rows = zeilen(datei.workbook, 'Analyse');
    const pruefung = pruefeAnalyseAufbau(rows, name);   // wirft bei fehlenden Spalten
    bericht.dateien.push({ name, geaendert: datei.geaendert, zeilen: pruefung.zeilen, ohneKdnr: pruefung.ohneKdnr });
    const r = uebernehmeAnalysen(kunden, rows);
    bericht.analysen.neu += r.neu;
    bericht.analysen.aktualisiert += r.aktualisiert;
    bericht.analysen.nichtGefunden += r.nichtGefunden;
  });

  return bericht;
}

// Stammdaten und Serviceplanung frisch aus dem Drive übernehmen.
// Läuft im Hintergrund, weil sich diese Daten laufend ändern.
async function holeStammdaten(kunden) {
  const dateien = await ladeDateien([DATEIEN.stammdaten]);
  const datei = dateien[DATEIEN.stammdaten];
  if (!datei) throw new Error(`${DATEIEN.stammdaten} wurde im Drive-Ordner nicht gefunden.`);
  const stammRows = zeilen(datei.workbook, 'Stammdaten');
  if (!stammRows.length || !Object.keys(stammRows[0]).includes('KdNr')) {
    throw new Error(`${DATEIEN.stammdaten}: im Blatt "Stammdaten" fehlt die Spalte KdNr oder es gibt keine Daten.`);
  }
  const planRows = zeilen(datei.workbook, 'Serviceplanung');
  if (planRows.length && !Object.keys(planRows[0]).includes('KdNr')) {
    throw new Error(`${DATEIEN.stammdaten}: im Blatt "Serviceplanung" fehlt die Spalte KdNr.`);
  }
  return {
    geaendert: datei.geaendert,
    stammdaten: uebernehmeStammdaten(kunden, stammRows),
    planung: uebernehmePlanung(kunden, planRows),
  };
}

module.exports = { archiviereAnalysen, holeStammdaten, ORDNER_ID, zeilen, uebernehmeStammdaten, uebernehmePlanung, uebernehmeAnalysen, pruefeAnalyseAufbau };
