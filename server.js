const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const app = express();
const PORT = process.env.PORT || 3001;
const PASSWORD = process.env.APP_PASSWORD || 'aendern123';
const USERNAME = process.env.APP_USERNAME || 'info@wksweber.ch';

// Shopify – für Lagerbestände
const SHOPIFY_STORE = 'dhb5cz-wf.myshopify.com';
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '';
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || '';

// Brevo – für Avisierungs-Mails
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const AVISIERUNG_ABSENDER = { name: 'WKS Weber GmbH', email: 'avisierung@wksweber.ch' };

let kunden = [];
function loadData() {
  const p = path.join(__dirname, 'data', 'kunden.json');
  kunden = JSON.parse(fs.readFileSync(p, 'utf-8'));
  console.log(`${kunden.length} Kunden geladen.`);
}
loadData();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'kundendb-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }, // 7 Tage
  })
);

// --- Login ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === USERNAME && password === PASSWORD) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: 'Falsches Passwort' });
});

app.get('/api/session', (req, res) => {
  res.json({ authed: !!req.session.authed });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  res.status(401).json({ error: 'Nicht angemeldet' });
}

// --- Suche ---
function norm(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // Umlaute/Akzente vereinheitlichen
}

app.get('/api/kunden', requireAuth, (req, res) => {
  const q = norm(req.query.q || '');
  if (!q) return res.json([]);

  const results = kunden
    .filter((k) => {
      if (norm(k.kdnr).includes(q)) return true;
      if (norm(k.kdnrName).includes(q)) return true;
      if (k.suchNamen.some((n) => norm(n).includes(q))) return true;
      return false;
    })
    .slice(0, 50)
    .map((k) => ({
      kdnr: k.kdnr,
      kdnrName: k.kdnrName,
      ort: k.anlage.ort,
      anlagentyp: k.anlage.anlagentyp,
    }));

  res.json(results);
});

app.get('/api/kunden/:kdnr', requireAuth, (req, res) => {
  const k = kunden.find((x) => x.kdnr === req.params.kdnr);
  if (!k) return res.status(404).json({ error: 'Nicht gefunden' });
  res.json(k);
});

// Alle Kunden, die am selben Tag (Format DD.MM.YYYY) einen Service-Termin haben – für die Tagestour
app.get('/api/tagestour/:datum', requireAuth, (req, res) => {
  const datum = req.params.datum;
  const treffer = [];
  kunden.forEach((k) => {
    const termin = (k.termine || []).find((t) => t.datum === datum);
    if (termin) {
      treffer.push({
        kdnr: k.kdnr,
        kdnrName: k.kdnrName,
        ort: k.anlage ? k.anlage.ort : null,
        zeit: termin.zeit || null,
        fahrer: k.planung ? k.planung.fahrer : null,
        notizen: termin.notizen || null,
        storniert: termin.storniert || false,
        koordinaten: k.anlage ? k.anlage.koordinaten : null,
      });
    }
  });
  // Chronologisch sortieren, Termine ohne Zeitangabe ans Ende
  treffer.sort((a, b) => {
    const za = a.zeit ? parseInt(String(a.zeit).replace(/\D/g, ''), 10) : Infinity;
    const zb = b.zeit ? parseInt(String(b.zeit).replace(/\D/g, ''), 10) : Infinity;
    return za - zb;
  });
  res.json({ datum, kunden: treffer });
});

// Alle Tage im aktuellen Jahr, an denen mindestens ein Service-Termin stattfindet (für "Einsatztage")
function parseDatumServer(v) {
  const m = String(v).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

app.get('/api/tage', requireAuth, (req, res) => {
  const jahr = new Date().getFullYear();
  const map = {};
  kunden.forEach((k) => {
    (k.termine || []).forEach((t) => {
      if (!t.datum) return;
      const d = parseDatumServer(t.datum);
      if (!d || d.getFullYear() !== jahr) return;
      if (!map[t.datum]) map[t.datum] = { ralph: 0, kathrin: 0, sonst: 0 };
      const f = k.planung ? k.planung.fahrer : null;
      if (f === 'Ralph') map[t.datum].ralph++;
      else if (f === 'Kathrin') map[t.datum].kathrin++;
      else map[t.datum].sonst++;
    });
  });
  const tage = Object.keys(map)
    .map((datum) => ({ datum, ...map[datum] }))
    .sort((a, b) => parseDatumServer(a.datum) - parseDatumServer(b.datum));
  res.json({ jahr, tage });
});

// ---- Routen-Berechnung via Google Directions API ----
function parseKoordinatenServer(v) {
  if (!v) return null;
  const m = String(v).match(/([NS])\s*([\d.]+)\D*([EW])\s*([\d.]+)/i);
  if (!m) return null;
  let lat = parseFloat(m[2]);
  let lon = parseFloat(m[4]);
  if (/S/i.test(m[1])) lat = -lat;
  if (/W/i.test(m[3])) lon = -lon;
  if (isNaN(lat) || isNaN(lon)) return null;
  return { lat, lon };
}

// Parst DMS-Koordinaten wie 47°23'56.2"N 9°17'28.2"E
function parseDMS(str) {
  const m = String(str).match(/(\d+)°(\d+)'([\d.]+)"?\s*([NS])\s+(\d+)°(\d+)'([\d.]+)"?\s*([EW])/i);
  if (!m) return null;
  let lat = Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600;
  let lon = Number(m[5]) + Number(m[6]) / 60 + Number(m[7]) / 3600;
  if (/S/i.test(m[4])) lat = -lat;
  if (/W/i.test(m[8])) lon = -lon;
  return { lat, lon };
}

// Betriebsstandort (Ausgangs-/Endpunkt der Touren)
const BASIS_KOORDINATE = parseDMS(`47°23'56.2"N 9°17'28.2"E`);

// Manuelle Koordinaten-Korrekturen für einzelne Kunden, bei denen die hinterlegte
// Koordinate (und auch der Adress-Fallback) von Google nicht gefunden wird.
const KOORDINATEN_OVERRIDE = {
  '100': parseDMS(`47°06'52.7"N 9°15'11.9"E`),
};

// Baut den Anfrage-Parameter für einen Punkt: normalerweise Koordinaten,
// im Fallback-Modus die Postadresse (falls vorhanden), damit Google selbst
// den nächstgelegenen befahrbaren Punkt sucht.
function punktParam(p, nutzeAdresse) {
  if (nutzeAdresse && p.adresse) return p.adresse;
  return `${p.lat},${p.lon}`;
}

async function rufeDirectionsAuf(chunk, apiKey, nutzeAdresse) {
  const origin = punktParam(chunk[0], nutzeAdresse);
  const destination = punktParam(chunk[chunk.length - 1], nutzeAdresse);
  const waypointsMitte = chunk.slice(1, -1).map((p) => punktParam(p, nutzeAdresse)).join('|');

  const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
  url.searchParams.set('origin', origin);
  url.searchParams.set('destination', destination);
  if (waypointsMitte) url.searchParams.set('waypoints', waypointsMitte);
  url.searchParams.set('region', 'ch');
  url.searchParams.set('key', apiKey);

  const r = await fetch(url.toString());
  return r.json();
}

// Ruft die Google Directions API auf; bricht die Punkteliste in Blöcke, falls
// mehr Stopps als in einer einzelnen Anfrage erlaubt sind (Google-Limit: 25 Punkte/Anfrage).
// Bei ZERO_RESULTS wird der betroffene Block automatisch nochmal mit den Postadressen
// statt den rohen Koordinaten versucht (Google findet dann selbst den nächsten befahrbaren Punkt).
// Gibt neben der Summe auch die einzelnen Etappen (in Reihenfolge der Punkteliste) zurück.
async function berechneRoute(punkte, apiKey) {
  const MAX_PUNKTE_PRO_ANFRAGE = 23; // inkl. Start/Ziel, konservativ gewählt
  let gesamtMeter = 0;
  let gesamtSekunden = 0;
  const etappen = []; // { meter, sekunden } pro Teilstrecke, in Reihenfolge der Punkteliste

  let start = 0;
  while (start < punkte.length - 1) {
    const ende = Math.min(start + MAX_PUNKTE_PRO_ANFRAGE - 1, punkte.length - 1);
    const chunk = punkte.slice(start, ende + 1);

    let data = await rufeDirectionsAuf(chunk, apiKey, false);

    if (data.status === 'ZERO_RESULTS' && chunk.some((p) => p.adresse)) {
      data = await rufeDirectionsAuf(chunk, apiKey, true);
    }

    if (data.status !== 'OK') {
      throw new Error(`Google Directions: ${data.status}${data.error_message ? ' – ' + data.error_message : ''}`);
    }

    const route = data.routes[0];
    route.legs.forEach((leg) => {
      gesamtMeter += leg.distance.value;
      gesamtSekunden += leg.duration.value;
      etappen.push({ meter: leg.distance.value, sekunden: leg.duration.value });
    });

    start = ende;
  }

  return { meter: gesamtMeter, sekunden: gesamtSekunden, etappen };
}

// Alle Tage (als Timestamp um Mitternacht), an denen ein bestimmter Fahrer mindestens einen Termin hat
function alleArbeitstage(fahrerName) {
  const dates = new Set();
  kunden.forEach((k) => {
    if (!k.planung || k.planung.fahrer !== fahrerName) return;
    (k.termine || []).forEach((t) => {
      if (!t.datum) return;
      const d = parseDatumServer(t.datum);
      if (d) dates.add(d.getTime());
    });
  });
  return dates;
}

// Ermittelt die zusammenhängende Kette aufeinanderfolgender Arbeitstage, zu der ein Datum gehört
function findeKette(datum, arbeitstageSet) {
  const start = parseDatumServer(datum);
  if (!start) return null;
  const TAG = 24 * 60 * 60 * 1000;
  let kettenStart = start.getTime();
  while (arbeitstageSet.has(kettenStart - TAG)) kettenStart -= TAG;
  let kettenEnde = start.getTime();
  while (arbeitstageSet.has(kettenEnde + TAG)) kettenEnde += TAG;
  const laenge = Math.round((kettenEnde - kettenStart) / TAG) + 1;
  return {
    istErsterTag: start.getTime() === kettenStart,
    istLetzterTag: start.getTime() === kettenEnde,
    laenge,
  };
}

// Baut die Punkteliste (inkl. Basis-Standort-Regel) für einen Fahrer/Tag und berechnet die Route.
// Ergebnisse werden im Speicher gecacht, damit wiederholte Anfragen (z.B. Jahressumme) nicht
// jedes Mal neu bei Google abgefragt werden müssen.
const routenCache = new Map(); // Key: "datum|fahrer" -> { km, dauerMinuten, ... } | { fehler: true }

function ermittleRoutenPunkte(datum, fahrer) {
  const stopps = [];
  kunden.forEach((k) => {
    const termin = (k.termine || []).find((t) => t.datum === datum);
    if (termin && k.planung && k.planung.fahrer === fahrer) {
      const koord = KOORDINATEN_OVERRIDE[k.kdnr]
        ? { ...KOORDINATEN_OVERRIDE[k.kdnr] }
        : parseKoordinatenServer(k.anlage && k.anlage.koordinaten);
      if (koord) {
        const a = k.anlage || {};
        const adresseText = [a.adresse, [a.plz, a.ort].filter(Boolean).join(' ')].filter(Boolean).join(', ');
        if (adresseText) koord.adresse = adresseText + ', Schweiz';
        koord.kdnr = k.kdnr;
        koord.name = k.kdnrName;
        koord.dauer = k.anlage ? parseInt(k.anlage.dauer, 10) || 0 : 0;
      }
      stopps.push({ zeit: termin.zeit || null, koord });
    }
  });
  stopps.sort((a, b) => {
    const za = a.zeit ? parseInt(String(a.zeit).replace(/\D/g, ''), 10) : Infinity;
    const zb = b.zeit ? parseInt(String(b.zeit).replace(/\D/g, ''), 10) : Infinity;
    return za - zb;
  });

  const kundenPunkte = stopps
    .filter((s) => s.koord)
    .map((s) => ({ ...s.koord, zeit: s.zeit }));
  const fehlendeKoordinaten = stopps.length - kundenPunkte.length;

  const HERISAU_PUNKT = BASIS_KOORDINATE ? { ...BASIS_KOORDINATE, kdnr: null, name: 'Herisau' } : null;

  let punkte = kundenPunkte;
  let basisHinweis = null;
  if (HERISAU_PUNKT && kundenPunkte.length) {
    if (fahrer === 'Kathrin') {
      punkte = [HERISAU_PUNKT, ...kundenPunkte, { ...HERISAU_PUNKT }];
      basisHinweis = 'Abfahrt/Ankunft Herisau';
    } else if (fahrer === 'Ralph') {
      const kette = findeKette(datum, alleArbeitstage('Ralph'));
      if (!kette || kette.laenge <= 1) {
        punkte = [HERISAU_PUNKT, ...kundenPunkte, { ...HERISAU_PUNKT }];
        basisHinweis = 'Abfahrt/Ankunft Herisau';
      } else if (kette.istErsterTag) {
        punkte = [HERISAU_PUNKT, ...kundenPunkte];
        basisHinweis = 'Abfahrt Herisau';
      } else if (kette.istLetzterTag) {
        punkte = [...kundenPunkte, { ...HERISAU_PUNKT }];
        basisHinweis = 'Ankunft Herisau';
      }
    }
  }

  return { punkte, anzahlStopps: stopps.length, fehlendeKoordinaten, basisHinweis };
}

function zeitStringZuMinuten(zeit) {
  if (!zeit) return null;
  const digits = String(zeit).replace(/\D/g, '').padStart(4, '0');
  return parseInt(digits.slice(0, 2), 10) * 60 + parseInt(digits.slice(2, 4), 10);
}

function minutenZuZeitString(min) {
  const gesamt = ((Math.round(min) % 1440) + 1440) % 1440; // auf 0-1439 normalisieren (Tagesgrenze)
  const hh = String(Math.floor(gesamt / 60)).padStart(2, '0');
  const mm = String(gesamt % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

async function holeRouteFuerTag(datum, fahrer, apiKey) {
  const cacheKey = `${datum}|${fahrer}`;
  if (routenCache.has(cacheKey)) return routenCache.get(cacheKey);

  const { punkte, anzahlStopps, fehlendeKoordinaten, basisHinweis } = ermittleRoutenPunkte(datum, fahrer);

  let ergebnis;
  if (punkte.length < 2) {
    ergebnis = { km: null, dauerMinuten: null, anzahlStopps, fehlendeKoordinaten, hinweis: 'Zu wenige Koordinaten für eine Route.' };
  } else {
    try {
      const { meter, sekunden, etappen } = await berechneRoute(punkte, apiKey);

      // Etappen mit Von/Nach-Bezeichnung anreichern (für Anzeige zwischen den Kunden)
      const etappenBeschriftet = etappen.map((e, i) => ({
        von: punkte[i].name,
        vonKdnr: punkte[i].kdnr,
        nach: punkte[i + 1].name,
        nachKdnr: punkte[i + 1].kdnr,
        minuten: Math.round(e.sekunden / 60),
      }));

      // Abfahrtszeit Herisau (falls erster Punkt Herisau ist): Ankunftszeit beim ersten
      // Kunden minus Fahrzeit dorthin.
      let abfahrtHerisau = null;
      if (punkte[0].name === 'Herisau' && punkte[1]) {
        const zielMin = zeitStringZuMinuten(punkte[1].zeit);
        if (zielMin !== null) abfahrtHerisau = minutenZuZeitString(zielMin - etappenBeschriftet[0].minuten);
      }

      // Ankunftszeit Herisau (falls letzter Punkt Herisau ist): Ankunftszeit beim letzten
      // Kunden plus dessen Aufenthaltsdauer plus Fahrzeit nach Herisau.
      let ankunftHerisau = null;
      const letzterIndex = punkte.length - 1;
      if (punkte[letzterIndex].name === 'Herisau' && punkte[letzterIndex - 1]) {
        const letzterKunde = punkte[letzterIndex - 1];
        const startMin = zeitStringZuMinuten(letzterKunde.zeit);
        if (startMin !== null) {
          const letzteEtappe = etappenBeschriftet[etappenBeschriftet.length - 1];
          ankunftHerisau = minutenZuZeitString(startMin + (letzterKunde.dauer || 0) + letzteEtappe.minuten);
        }
      }

      ergebnis = {
        km: Math.round((meter / 1000) * 10) / 10,
        dauerMinuten: Math.round(sekunden / 60),
        anzahlStopps,
        fehlendeKoordinaten,
        basisHinweis,
        etappen: etappenBeschriftet,
        abfahrtHerisau,
        ankunftHerisau,
      };
    } catch (err) {
      ergebnis = { fehler: err.message, anzahlStopps, fehlendeKoordinaten };
    }
  }
  routenCache.set(cacheKey, ergebnis);
  return ergebnis;
}

// Fahrstrecke + Fahrzeit für die Tagestour eines Fahrers an einem Datum
app.get('/api/route/:datum/:fahrer', requireAuth, async (req, res) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return res.status(400).json({ error: 'GOOGLE_MAPS_API_KEY ist nicht gesetzt.' });
  }
  const { datum, fahrer } = req.params;
  const ergebnis = await holeRouteFuerTag(datum, fahrer, apiKey);
  if (ergebnis.fehler) return res.status(502).json({ error: ergebnis.fehler });
  res.json(ergebnis);
});

// Summe aller Fahrstrecken/-zeiten im aktuellen Jahr (mit Cache; parallelisiert in kleinen Blöcken)
app.get('/api/tage/summe', requireAuth, async (req, res) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return res.status(400).json({ error: 'GOOGLE_MAPS_API_KEY ist nicht gesetzt.' });
  }

  const jahr = new Date().getFullYear();
  const aufgaben = []; // { datum, fahrer }
  const map = {};
  kunden.forEach((k) => {
    (k.termine || []).forEach((t) => {
      if (!t.datum) return;
      const d = parseDatumServer(t.datum);
      if (!d || d.getFullYear() !== jahr) return;
      const f = k.planung ? k.planung.fahrer : null;
      if (f !== 'Ralph' && f !== 'Kathrin') return;
      const key = `${t.datum}|${f}`;
      if (!map[key]) {
        map[key] = true;
        aufgaben.push({ datum: t.datum, fahrer: f });
      }
    });
  });

  let totalKm = 0;
  let totalMinuten = 0;
  let ausgewertet = 0;
  let fehlerAnzahl = 0;
  const fehlerDetails = [];

  const PARALLEL = 6;
  let index = 0;
  async function worker() {
    while (index < aufgaben.length) {
      const { datum, fahrer } = aufgaben[index++];
      const erg = await holeRouteFuerTag(datum, fahrer, apiKey);
      if (erg.fehler) {
        fehlerAnzahl++;
        fehlerDetails.push({ datum, fahrer, grund: erg.fehler });
      } else if (erg.km !== null) {
        totalKm += erg.km;
        totalMinuten += erg.dauerMinuten;
        ausgewertet++;
      }
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));

  res.json({
    jahr,
    totalKm: Math.round(totalKm * 10) / 10,
    totalMinuten,
    tageAusgewertet: ausgewertet,
    tageGesamt: aufgaben.length,
    fehlerAnzahl,
    fehlerDetails,
  });
});

app.get('/api/meta', requireAuth, (req, res) => {
  res.json({ anzahl: kunden.length, gmapKey: process.env.GOOGLE_MAPS_API_KEY ? true : false });
});

app.get('/api/config', requireAuth, (req, res) => {
  res.json({ gmapKey: process.env.GOOGLE_MAPS_API_KEY || '' });
});

// ---- Brevo Mail-Versand ----
function icsKalendereintrag(terminDatum, zeitVon, zeitBis, kundenName, ort) {
  // terminDatum = "DD.MM.YYYY", zeitVon/zeitBis = "HH:MM"
  const [dd, mm, yyyy] = terminDatum.split('.');
  const [hV, mV] = zeitVon.split(':');
  const [hB, mB] = zeitBis.split(':');
  const dtStart = `${yyyy}${mm}${dd}T${hV}${mV}00`;
  const dtEnd = `${yyyy}${mm}${dd}T${hB}${mB}00`;
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//WKS Weber GmbH//Avisierung//DE',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `DTSTART;TZID=Europe/Zurich:${dtStart}`,
    `DTEND;TZID=Europe/Zurich:${dtEnd}`,
    `DTSTAMP:${now}`,
    `UID:wks-${dd}${mm}${yyyy}-${Date.now()}@wksweber.ch`,
    'SUMMARY:Servicetermin WKS',
    'DESCRIPTION:Service-Termin Ihrer Kläranlage durch WKS Weber GmbH\\nBei kurzfristigen Änderungen: info@wksweber.ch / 071 352 38 22',
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}

async function sendBrevoMail({ an, betreff, htmlBody, icsContent }) {
  const empfaenger = an.split(';').map((m) => m.trim()).filter((m) => m.includes('@')).map((m) => ({ email: m }));
  if (!empfaenger.length) throw new Error('Keine gültige E-Mail-Adresse');

  const payload = {
    sender: AVISIERUNG_ABSENDER,
    to: empfaenger,
    subject: betreff,
    htmlContent: htmlBody,
  };

  if (icsContent) {
    payload.attachment = [{
      name: 'termin.ics',
      content: Buffer.from(icsContent).toString('base64'),
    }];
  }

  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Brevo ${r.status}: ${body.slice(0, 300)}`);
  }
  return r.json();
}

// Test-Mail senden (mit echten Kundendaten)
app.post('/api/avisierung/test', requireAuth, async (req, res) => {
  if (!BREVO_API_KEY) {
    return res.status(400).json({ error: 'BREVO_API_KEY ist nicht gesetzt.' });
  }

  const testMail = req.body.email || 'info@ralphweber.ch';
  const kdnr = req.body.kdnr;

  let kundenName, terminDatum, zeitfenster, ort, zeitVon, zeitBis;

  if (kdnr) {
    // Echten Kunden verwenden
    const kunde = kunden.find((k) => k.kdnr === kdnr);
    if (!kunde) return res.status(404).json({ error: 'Kunde nicht gefunden.' });

    kundenName = kunde.kdnrName || 'Kunde ' + kdnr;
    ort = kunde.anlage ? [kunde.anlage.adresse, [kunde.anlage.plz, kunde.anlage.ort].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '';

    // Nächsten zukünftigen Termin finden
    const heute = new Date(); heute.setHours(0, 0, 0, 0);
    const termin = (kunde.termine || []).find((t) => {
      if (!t.datum || t.storniert) return false;
      const m = t.datum.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
      if (!m) return false;
      const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
      return d >= heute;
    });

    if (!termin) return res.status(400).json({ error: 'Kein zukünftiger Termin für diesen Kunden.' });

    terminDatum = termin.datum;

    // Zeitfenster berechnen (gleiche Logik wie in /api/avisierung)
    if (termin.zeit) {
      const digits = String(termin.zeit).replace(/\D/g, '').padStart(4, '0');
      const hh = parseInt(digits.slice(0, 2), 10), mm = parseInt(digits.slice(2, 4), 10);
      const total = hh * 60 + mm;
      let vonMin, bisMin;
      if (total < 450) { vonMin = total; bisMin = 450; }
      else if (total === 450) { vonMin = 450; bisMin = 480; }
      else if (total <= 510) { vonMin = 465; bisMin = 600; }
      else if (total <= 600) { vonMin = Math.max(480, Math.floor((total - 60) / 30) * 30); bisMin = Math.ceil((total + 60) / 30) * 30; }
      else if (total <= 689) { vonMin = Math.floor((total - 60) / 30) * 30; bisMin = Math.ceil((total + 60) / 30) * 30; if (bisMin >= 720) bisMin = 780; }
      else if (total <= 780) { vonMin = 630; bisMin = 840; }
      else if (total <= 900) { vonMin = Math.floor((total - 60) / 30) * 30; bisMin = Math.ceil((total + 60) / 30) * 30; }
      else if (total <= 1020) { vonMin = Math.floor((total - 60) / 30) * 30; bisMin = Math.ceil((total + 60) / 30) * 30; }
      else if (total <= 1050) { vonMin = 900; bisMin = 1065; }
      else { vonMin = 960; bisMin = 1110; }
      if (vonMin >= 720 && vonMin < 765) vonMin = 780;
      if (bisMin >= 720 && bisMin < 765) bisMin = 780;
      function fmt(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
      zeitVon = fmt(vonMin); zeitBis = fmt(bisMin);
      zeitfenster = zeitVon + ' – ' + zeitBis + ' Uhr';
    } else {
      zeitfenster = 'wird noch bekanntgegeben';
      zeitVon = '08:00'; zeitBis = '12:00';
    }
  } else {
    // Fallback: Beispieldaten
    kundenName = 'Muster AG';
    terminDatum = '15.03.2027';
    zeitfenster = '09:30 – 11:30 Uhr';
    zeitVon = '09:30'; zeitBis = '11:30';
    ort = 'Musterstrasse 1, 9000 St. Gallen';
  }

  const logoUrl = 'https://wks-dashboard.onrender.com/tropfen-icon.png';
  const htmlBody = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333;background:#fff;">
      <div style="background:#1a1a1a;padding:24px 20px;border-radius:12px 12px 0 0;text-align:center;">
        <img src="${logoUrl}" alt="WKS" style="width:44px;height:44px;margin-bottom:8px;filter:brightness(2);" />
        <div style="color:#fff;font-size:20px;font-weight:700;">Service-Termin Ihrer Kläranlage</div>
      </div>
      <div style="padding:28px 24px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 12px 12px;">
        <p style="margin:0 0 16px;">Lieber WKS-Kunde</p>
        <p style="margin:0 0 20px;">Wir möchten Sie darüber informieren, dass der nächste Service Ihrer Kläranlage geplant ist:</p>
        <div style="background:#f5f5f5;border-radius:10px;padding:16px 18px;margin:0 0 20px;">
          <table style="border-collapse:collapse;width:100%;">
            <tr><td style="padding:10px 0;font-weight:600;color:#1a1a1a;width:120px;border-bottom:1px solid #ddd;">Datum</td><td style="padding:10px 0;border-bottom:1px solid #ddd;">${terminDatum}</td></tr>
            <tr><td style="padding:10px 0;font-weight:600;color:#1a1a1a;width:120px;border-bottom:1px solid #ddd;">Zeitfenster</td><td style="padding:10px 0;border-bottom:1px solid #ddd;">${zeitfenster}</td></tr>
            ${ort ? `<tr><td style="padding:10px 0;font-weight:600;color:#1a1a1a;width:120px;">Standort</td><td style="padding:10px 0;">${ort}</td></tr>` : ''}
          </table>
        </div>
        <p style="margin:0 0 14px;">Im Anhang finden Sie einen Kalendereintrag für Ihren Kalender, falls Sie diesen hinzufügen möchten.</p>
        <p style="margin:0 0 14px;">Bitte stellen Sie sicher, dass der Zugang zu den Anlagenbestandteilen am Servicetag gewährleistet ist. Sollte dies gewährleistet sein, müssen Sie nicht anwesend sein.</p>
        <p style="margin:0 0 24px;">Bei Fragen erreichen Sie uns unter <a href="tel:+41713523822" style="color:#1a1a1a;font-weight:600;">071 352 38 22</a> oder per Mail an <a href="mailto:info@wksweber.ch" style="color:#1a1a1a;font-weight:600;">info@wksweber.ch</a>.</p>
        <div style="border-top:1px solid #e0e0e0;padding-top:16px;color:#666;font-size:14px;">
          <p style="margin:0;">Freundliche Grüsse</p>
          <p style="margin:4px 0 0;font-weight:700;color:#1a1a1a;">WKS Weber GmbH</p>
          <p style="margin:2px 0 0;font-size:13px;">Kläranlagen – Wartung und Service</p>
        </div>
      </div>
    </div>
  `;

  const ics = icsKalendereintrag(terminDatum, zeitVon, zeitBis, kundenName, ort);

  try {
    const betreff = kdnr
      ? `[TEST] Service-Termin Ihrer Abwasseranlage – ${terminDatum}`
      : `[TEST] Service-Termin Ihrer Abwasseranlage – 15.03.2027`;
    const result = await sendBrevoMail({ an: testMail, betreff, htmlBody, icsContent: ics });
    res.json({ ok: true, an: testMail, kunde: kundenName, messageId: result.messageId || null });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- Avisierung ----
app.get('/api/avisierung', requireAuth, (req, res) => {
  const heute = new Date();
  heute.setHours(0, 0, 0, 0);
  const TAG = 24 * 60 * 60 * 1000;

  function parseDat(v) {
    const m = String(v).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (!m) return null;
    return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  }

  function zeitFenster(zeit) {
    if (!zeit) return null;
    const digits = String(zeit).replace(/\D/g, '').padStart(4, '0');
    const hh = parseInt(digits.slice(0, 2), 10);
    const mm = parseInt(digits.slice(2, 4), 10);
    const total = hh * 60 + mm;

    function fmt(min) {
      return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    }

    let vonMin, bisMin;
    if (total < 7 * 60 + 30) {
      vonMin = total; bisMin = 7 * 60 + 30;
    } else if (total === 7 * 60 + 30) {
      vonMin = 7 * 60 + 30; bisMin = 8 * 60;
    } else if (total <= 8 * 60 + 30) {
      vonMin = 7 * 60 + 45; bisMin = 10 * 60;
    } else if (total <= 10 * 60) {
      // ±1h, min 08:00
      vonMin = Math.max(8 * 60, Math.floor((total - 60) / 30) * 30);
      bisMin = Math.ceil((total + 60) / 30) * 30;
    } else if (total <= 11 * 60 + 29) {
      // 10:01–11:29 → ±1h, wenn Ende >= 12:00 dann bis 13:00
      vonMin = Math.floor((total - 60) / 30) * 30;
      bisMin = Math.ceil((total + 60) / 30) * 30;
      if (bisMin >= 12 * 60) bisMin = 13 * 60;
    } else if (total <= 13 * 60) {
      // 11:30–13:00 → fix
      vonMin = 10 * 60 + 30; bisMin = 14 * 60;
    } else if (total <= 15 * 60) {
      // 13:01–15:00 → ±1h gerundet auf 30min
      vonMin = Math.floor((total - 60) / 30) * 30;
      bisMin = Math.ceil((total + 60) / 30) * 30;
    } else if (total <= 17 * 60) {
      // 15:01–17:00 → ±1h gerundet auf 30min
      vonMin = Math.floor((total - 60) / 30) * 30;
      bisMin = Math.ceil((total + 60) / 30) * 30;
    } else if (total <= 17 * 60 + 30) {
      vonMin = 15 * 60; bisMin = 17 * 60 + 45;
    } else {
      vonMin = 16 * 60; bisMin = 18 * 60 + 30;
    }

    // Mittagsregel: Zeitfenster darf nie zwischen 12:00 und 12:45 anfangen oder aufhören
    if (vonMin >= 12 * 60 && vonMin < 12 * 60 + 45) vonMin = 13 * 60;
    if (bisMin >= 12 * 60 && bisMin < 12 * 60 + 45) bisMin = 13 * 60;

    return `${fmt(vonMin)} – ${fmt(bisMin)} Uhr`;
  }

  const eintraege = [];
  kunden.forEach((k) => {
    const mail = k.kontakte && k.kontakte.avisierung && k.kontakte.avisierung.mail;
    if (!mail || !mail.trim() || !mail.includes('@')) return;

    (k.termine || []).forEach((t) => {
      if (!t.datum || t.storniert) return;
      const terminDatum = parseDat(t.datum);
      if (!terminDatum) return;
      // Nur zukünftige Termine
      if (terminDatum.getTime() < heute.getTime()) return;

      const avisierungsDatum = new Date(terminDatum.getTime() - 14 * TAG);
      const tageVorTermin = Math.round((terminDatum.getTime() - heute.getTime()) / TAG);
      const tageBisAvisierung = Math.round((avisierungsDatum.getTime() - heute.getTime()) / TAG);

      eintraege.push({
        kdnr: k.kdnr,
        kdnrName: k.kdnrName,
        mail: mail.trim(),
        terminDatum: t.datum,
        terminZeit: t.zeit || null,
        zeitfenster: zeitFenster(t.zeit),
        halbjahr: t.halbjahr,
        avisierungsDatum: `${String(avisierungsDatum.getDate()).padStart(2, '0')}.${String(avisierungsDatum.getMonth() + 1).padStart(2, '0')}.${avisierungsDatum.getFullYear()}`,
        tageVorTermin,
        tageBisAvisierung,
        fahrer: k.planung ? k.planung.fahrer : null,
        ort: k.anlage ? k.anlage.ort : null,
      });
    });
  });

  // Sortiert nach Avisierungsdatum (nächste zuerst)
  eintraege.sort((a, b) => a.tageBisAvisierung - b.tageBisAvisierung);

  res.json({ eintraege, total: eintraege.length });
});

app.get('/api/schieber', requireAuth, (req, res) => {
  try {
    const p = path.join(__dirname, 'data', 'schieber.json');
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'schieber.json nicht gefunden.' });
  }
});

app.get('/api/grenzwerte', requireAuth, (req, res) => {
  try {
    const p = path.join(__dirname, 'data', 'grenzwerte.json');
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'grenzwerte.json nicht gefunden.' });
  }
});

// ---- Shopify Lagerbestände ----
// ---- Shopify OAuth (einmalig durchlaufen, um den permanenten Access Token zu erhalten) ----
app.get('/shopify/auth', requireAuth, (req, res) => {
  if (!SHOPIFY_CLIENT_ID) return res.send('SHOPIFY_CLIENT_ID nicht gesetzt.');
  const redirectUri = `https://${req.get('host')}/shopify/callback`;
  const url = `https://${SHOPIFY_STORE}/admin/oauth/authorize?client_id=${SHOPIFY_CLIENT_ID}&scope=read_products,read_inventory&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(url);
});

app.get('/shopify/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) return res.send(`Shopify-Fehler: ${error} – ${error_description || ''}`);
  if (!code) return res.send(`Fehler: kein Code erhalten. Query: ${JSON.stringify(req.query)}`);
  try {
    const r = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code,
      }),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch(e) { return res.send(`Shopify-Antwort (${r.status}): ${text.slice(0,500)}`); }
    if (data.access_token) {
      res.send(`<h2>Shopify Access Token erhalten!</h2>
        <p>Trage diesen bei Render als <b>SHOPIFY_ACCESS_TOKEN</b> ein:</p>
        <pre style="background:#f0f0f0;padding:16px;font-size:18px;word-break:break-all;">${data.access_token}</pre>
        <p>Danach Render neu deployen. Dieser Schritt muss nur einmal gemacht werden.</p>`);
    } else {
      res.send(`Shopify-Antwort (${r.status}): ${JSON.stringify(data)}`);
    }
  } catch (err) {
    res.send(`Fehler: ${err.message}`);
  }
});

// ---- Shopify GraphQL API ----
let shopifyAccessToken = null;

function getShopifyToken() {
  return SHOPIFY_ACCESS_TOKEN;
}

async function shopifyGraphQL(query) {
  const token = getShopifyToken();
  const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-07/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Shopify ${r.status}: ${body.slice(0, 300)}`);
  }
  return r.json();
}

app.get('/api/lager', requireAuth, async (req, res) => {
  if (!SHOPIFY_ACCESS_TOKEN) {
    return res.status(400).json({ error: 'SHOPIFY_ACCESS_TOKEN ist nicht gesetzt. Bitte zuerst /shopify/auth aufrufen.' });
  }

  try {
    const alleArtikel = [];
    let cursor = null;
    let weiter = true;

    while (weiter) {
      const afterClause = cursor ? `, after: "${cursor}"` : '';
      const query = `{
        products(first: 250${afterClause}) {
          pageInfo { hasNextPage }
          edges {
            cursor
            node {
              title
              variants(first: 50) {
                edges {
                  node {
                    sku
                    inventoryQuantity
                    displayName
                  }
                }
              }
            }
          }
        }
      }`;

      const data = await shopifyGraphQL(query);

      if (data.errors) {
        throw new Error(data.errors.map((e) => e.message).join('; '));
      }

      const edges = data.data.products.edges || [];
      edges.forEach((edge) => {
        const prod = edge.node;
        const variants = (prod.variants.edges || []).map((ve) => ve.node);

        if (variants.length === 1) {
          const v = variants[0];
          const sku = v.sku || '';
          if (sku.toLowerCase().includes('container')) return;
          alleArtikel.push({
            name: prod.title,
            nummer: sku,
            bestand: v.inventoryQuantity ?? 0,
          });
        } else {
          // Mehrere Varianten: jede einzeln auflisten
          variants.forEach((v) => {
            const sku = v.sku || '';
            if (sku.toLowerCase().includes('container')) return;
            alleArtikel.push({
              name: v.displayName || prod.title,
              nummer: sku,
              bestand: v.inventoryQuantity ?? 0,
            });
          });
        }
      });

      if (data.data.products.pageInfo.hasNextPage && edges.length) {
        cursor = edges[edges.length - 1].cursor;
      } else {
        weiter = false;
      }
    }

    alleArtikel.sort((a, b) => a.name.localeCompare(b.name, 'de'));

    res.json({ artikel: alleArtikel, anzahl: alleArtikel.length });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Debug-Endpoint: zeigt die Rohdaten eines Shopify-Produkts
app.get('/api/lager/debug', requireAuth, async (req, res) => {
  if (!SHOPIFY_ACCESS_TOKEN) {
    return res.status(400).json({ error: 'SHOPIFY_ACCESS_TOKEN ist nicht gesetzt.' });
  }
  try {
    const query = `{
      products(first: 3) {
        edges {
          node {
            title
            productType
            vendor
            tags
            variants(first: 5) {
              edges {
                node {
                  sku
                  inventoryQuantity
                  displayName
                  title
                }
              }
            }
          }
        }
      }
    }`;
    const data = await shopifyGraphQL(query);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- Analysedaten-Upload (Jahresarchivierung) ----
function parseAnalyseUpload(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });

  // Header-Zeile finden (sucht nach 'KdNr')
  function norm(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }
  let headerRow = -1, kdnrIdx = -1, datSIdx = -1, startIdx = 0;
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const zeile = rows[r] || [];
    const ki = zeile.findIndex(v => norm(v) === 'kdnr');
    if (ki !== -1) { headerRow = r; kdnrIdx = ki; break; }
  }
  if (headerRow === -1) {
    // Ohne Header: KdNr in Spalte A, Dat_S in Spalte L
    kdnrIdx = 0; datSIdx = 11; startIdx = 0;
  } else {
    startIdx = headerRow + 1;
    const hz = rows[headerRow];
    const di = hz.findIndex(v => norm(v) === 'dat_s' || norm(v) === 'datum service');
    datSIdx = di !== -1 ? di : kdnrIdx + 14;
  }

  // Geruch-Block-Offset bestimmen
  let geruchOffset = 0;
  if (headerRow >= 0) {
    const hz = rows[headerRow];
    const gi = hz.findIndex((v, i) => i > datSIdx && norm(v) === 'kein');
    geruchOffset = (gi !== -1 ? gi : 20) - 20;
  } else {
    geruchOffset = 13 - 20;
  }

  function col(letter) {
    let n = 0;
    for (const ch of letter) n = n * 26 + (ch.charCodeAt(0) - 64);
    const ref = n - 1;
    if (letter === 'D') return kdnrIdx;
    if (letter === 'S') return datSIdx;
    return ref + geruchOffset;
  }

  function clean(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (!s || s.toLowerCase() === 'nan' || s.toLowerCase() === 'nat') return null;
    return s;
  }
  function istX(v) { return v !== null && v !== undefined && String(v).trim().toLowerCase() === 'x'; }
  function fmtDate(v) {
    if (!(v instanceof Date) || isNaN(v.getTime())) return null;
    if (v.getFullYear() < 1950) return null;
    return `${String(v.getDate()).padStart(2,'0')}.${String(v.getMonth()+1).padStart(2,'0')}.${v.getFullYear()}`;
  }
  function cbGroup(row, wortSpalten, beschriebSpalte, trenner) {
    const w = [];
    wortSpalten.forEach(([sp, wort]) => { if (istX(row[col(sp)])) w.push(wort); });
    let text = w.join(trenner);
    const b = beschriebSpalte ? clean(row[col(beschriebSpalte)]) : null;
    if (b) text = text ? `${text} (${b})` : b;
    return text || null;
  }

  const eintraege = [];
  for (let i = startIdx; i < rows.length; i++) {
    const row = rows[i]; if (!row) continue;
    const kdnr = clean(row[kdnrIdx]); if (!kdnr) continue;
    const datum = fmtDate(row[datSIdx]); if (!datum) continue;

    const geruch = cbGroup(row, [['U','kein'],['V','leicht'],['W','stark'],['X','faulig'],['Y','erdig'],['Z','andere']], 'AA', ' ');
    const farbe = cbGroup(row, [['AB','klar'],['AC','trüb'],['AD','gelblich'],['AE','bräunlich'],['AF','gräulich'],['AG','andere']], 'AH', ' / ');
    const schlammAblauf = cbGroup(row, [['AI','kein'],['AJ','wenig'],['AK','viel']], null, ' ');
    const hbJa = istX(row[col('BC')]); const hbNein = istX(row[col('BD')]);
    let handlungsbedarf = null;
    if (hbJa) handlungsbedarf = 'Ja'; else if (hbNein) handlungsbedarf = 'Nein';

    const IMMER = [['AL','pH'],['AM','O2 A'],['AN','Temp A'],['AO','DS'],['AV','Amm.'],['AX','CSB']];
    const OPT = [['AP','Bewuchs'],['AQ','Schlammfarbe'],['AR','O2 BB'],['AS','Temp'],['AT','BB'],['AU','NB'],
      ['AW','Ab.Vol.'],['AY','Stunden'],['AZ','Nitrit'],['BA','Absaugen'],['BB','Monteur'],
      ['BK','Betriebsjournal'],['BL','Phosphat'],['BM','GUS'],['BN','Wetter'],['BO','DOC']];
    const BEM = [['BE','Bemerkungen'],['BF','Bem. AWEL'],['BG','Vermerk WKS'],['BH','Ersatzteile'],['BI','Nächster Service'],['BJ','Büro Information']];

    eintraege.push({
      kdnr: String(kdnr).replace(/\.0$/, ''),
      datum,
      geruch, farbe, schlammAblauf, handlungsbedarf,
      messwerteImmer: IMMER.map(([sp,l]) => ({ label: l, wert: clean(row[col(sp)]) ?? 'k.A.' })),
      messwerteOptional: OPT.map(([sp,l]) => ({ label: l, wert: clean(row[col(sp)]) })).filter(f => f.wert !== null),
      bemerkungen: BEM.map(([sp,l]) => ({ label: l, wert: clean(row[col(sp)]) })).filter(f => f.wert !== null),
    });
  }
  return eintraege;
}

app.post('/api/upload/analysedaten', requireAuth, upload.single('datei'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei hochgeladen.' });

  try {
    const eintraege = parseAnalyseUpload(req.file.path);

    let zugeordnet = 0, nichtGefunden = 0, aktualisiert = 0;
    const kundenByKdnr = {};
    kunden.forEach(k => { if (k.kdnr) kundenByKdnr[k.kdnr] = k; });

    eintraege.forEach(e => {
      const kunde = kundenByKdnr[e.kdnr];
      if (!kunde) { nichtGefunden++; return; }

      if (!kunde.analysedaten) kunde.analysedaten = [];
      const bestehend = kunde.analysedaten.findIndex(a => a.datum === e.datum);
      const eintrag = { datum: e.datum, geruch: e.geruch, farbe: e.farbe, schlammAblauf: e.schlammAblauf,
        handlungsbedarf: e.handlungsbedarf, messwerteImmer: e.messwerteImmer,
        messwerteOptional: e.messwerteOptional, bemerkungen: e.bemerkungen };

      if (bestehend >= 0) { kunde.analysedaten[bestehend] = eintrag; aktualisiert++; }
      else { kunde.analysedaten.push(eintrag); }
      kunde.analysedaten.sort((a,b) => a.datum.split('.').reverse().join('').localeCompare(b.datum.split('.').reverse().join('')));
      zugeordnet++;
    });

    // Speichern
    const p = path.join(__dirname, 'data', 'kunden.json');
    fs.writeFileSync(p, JSON.stringify(kunden, null, 2), 'utf-8');

    // Cleanup
    try { fs.unlinkSync(req.file.path); } catch(e) {}

    res.json({ ok: true, gesamt: eintraege.length, zugeordnet, aktualisiert, nichtGefunden });
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch(e) {}
    res.status(500).json({ error: err.message });
  }
});

// ---- Verrechnung (Download mit Datumsfilter) ----
app.get('/api/verrechnung', requireAuth, (req, res) => {
  const von = req.query.von || '01.01.2000';
  const bis = req.query.bis || '31.12.2099';

  function parseDat(v) {
    const m = String(v).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (!m) return null;
    return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  }
  const vonD = parseDat(von); const bisD = parseDat(bis);

  const zeilen = [];
  kunden.forEach(k => {
    if (!k.kdnr) return;
    const p = k.planung || {};
    (k.analysedaten || []).forEach(ad => {
      // Ersatzteile aus Bemerkungen
      let ersatzteile = '';
      (ad.bemerkungen || []).forEach(b => { if (b.label === 'Ersatzteile') ersatzteile = b.wert || ''; });
      if (!ersatzteile) return;

      const d = parseDat(ad.datum);
      if (!d) return;
      if (vonD && d < vonD) return;
      if (bisD && d > bisD) return;

      zeilen.push({
        kdnr: k.kdnr, name: k.kdnrName || '', datum: ad.datum,
        fahrer: p.fahrer || '', ersatzteile, kanton: p.zustKt || '',
      });
    });
  });

  zeilen.sort((a,b) => a.datum.split('.').reverse().join('').localeCompare(b.datum.split('.').reverse().join('')));

  if (req.query.format === 'xlsx') {
    // Excel-Download
    const wb = XLSX.utils.book_new();
    const data = [['KdNr','Kunde','Datum','Fahrer','Kanton','Ersatzteile']];
    zeilen.forEach(z => data.push([z.kdnr, z.name, z.datum, z.fahrer, z.kanton, z.ersatzteile]));
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{wch:8},{wch:32},{wch:12},{wch:10},{wch:6},{wch:45}];
    XLSX.utils.book_append_sheet(wb, ws, 'Ersatzteile');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename=WKS_Ersatzteile_${von.replace(/\./g,'')}_${bis.replace(/\./g,'')}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(buf);
  }

  res.json({ zeilen, total: zeilen.length });
});

// ---- Daten-Import (Analysedaten-Upload + Archivierung) ----
app.post('/api/import/analysedaten', requireAuth, upload.single('datei'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei hochgeladen.' });

  try {
    const wb = XLSX.read(req.file.buffer, { cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });

    // Layout erkennen (Header-Zeile per Namenssuche)
    function norm(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }
    let headerRowIndex = -1, kdnrIdx = -1, datSIdx = -1, geruchOffset = 0;

    for (let r = 0; r < Math.min(rows.length, 10); r++) {
      const zeile = rows[r] || [];
      const ki = zeile.findIndex(v => norm(v) === 'kdnr');
      if (ki !== -1) { headerRowIndex = r; kdnrIdx = ki; break; }
    }

    if (headerRowIndex >= 0) {
      const hz = rows[headerRowIndex];
      const di = hz.findIndex(v => norm(v) === 'dat_s');
      datSIdx = di >= 0 ? di : kdnrIdx + 15;
      const gi = hz.findIndex((v, i) => i > datSIdx && norm(v) === 'kein');
      geruchOffset = (gi >= 0 ? gi : 20) - 20;
    } else {
      // Ohne Header
      headerRowIndex = -1; kdnrIdx = 0; datSIdx = 11; geruchOffset = 13 - 20;
    }
    const startIdx = headerRowIndex + 1;

    function col(letter) {
      if (letter === 'D') return kdnrIdx;
      if (letter === 'S') return datSIdx;
      let n = 0;
      for (const ch of letter) n = n * 26 + (ch.charCodeAt(0) - 64);
      return n - 1 + geruchOffset;
    }

    function clean(v) {
      if (v === null || v === undefined) return null;
      const s = String(v).trim();
      if (!s || s.toLowerCase() === 'nan' || s.toLowerCase() === 'nat') return null;
      return s;
    }

    function istX(v) { return v !== null && v !== undefined && String(v).trim().toLowerCase() === 'x'; }

    function fmtDatum(v) {
      if (!(v instanceof Date) || isNaN(v.getTime())) return null;
      if (v.getFullYear() < 1950) return null;
      return `${String(v.getDate()).padStart(2,'0')}.${String(v.getMonth()+1).padStart(2,'0')}.${v.getFullYear()}`;
    }

    function checkboxGruppe(row, wortSpalten, beschriebSpalte, trenner) {
      const w = [];
      wortSpalten.forEach(([sp, wort]) => { if (istX(row[col(sp)])) w.push(wort); });
      let text = w.join(trenner);
      const b = beschriebSpalte ? clean(row[col(beschriebSpalte)]) : null;
      if (b) text = text ? `${text} (${b})` : b;
      return text || null;
    }

    // Deduplizierung: beste Zeile pro KdNr+Datum
    const beste = {};
    for (let i = startIdx; i < rows.length; i++) {
      const row = rows[i]; if (!row) continue;
      const kdnr = clean(row[col('D')]); if (!kdnr) continue;
      const datum = fmtDatum(row[col('S')]); if (!datum) continue;
      const key = `${kdnr}|${datum}`;
      let score = 0;
      for (let c = col('U'); c < row.length; c++) { if (clean(row[c])) score++; }
      if (!beste[key] || beste[key].score < score) beste[key] = { row, score };
    }

    const kundenByKdnr = {};
    kunden.forEach(k => { kundenByKdnr[k.kdnr] = k; });

    let zugeordnet = 0, nichtGefunden = 0, korrigiert = 0, neuTermine = 0;
    const details = [];

    Object.keys(beste).forEach(key => {
      const [kdnr, datum] = key.split('|');
      const { row } = beste[key];
      const kunde = kundenByKdnr[kdnr];
      if (!kunde) { nichtGefunden++; return; }

      const geruch = checkboxGruppe(row, [['U','kein'],['V','leicht'],['W','stark'],['X','faulig'],['Y','erdig'],['Z','andere']], 'AA', ' ');
      const farbe = checkboxGruppe(row, [['AB','klar'],['AC','trüb'],['AD','gelblich'],['AE','bräunlich'],['AF','gräulich'],['AG','andere']], 'AH', ' / ');
      const schlammAblauf = checkboxGruppe(row, [['AI','kein'],['AJ','wenig'],['AK','viel']], null, ' ');
      const hJa = istX(row[col('BC')]); const hNein = istX(row[col('BD')]);
      let handlungsbedarf = null;
      if (hJa) handlungsbedarf = 'Ja'; else if (hNein) handlungsbedarf = 'Nein';

      const IMMER = [['AL','pH'],['AM','O2 A'],['AN','Temp A'],['AO','DS'],['AV','Amm.'],['AX','CSB']];
      const OPT = [['AP','Bewuchs'],['AQ','Schlammfarbe'],['AR','O2 BB'],['AS','Temp'],['AT','BB'],['AU','NB'],
        ['AW','Ab.Vol.'],['AY','Stunden'],['AZ','Nitrit'],['BA','Absaugen'],['BB','Monteur'],
        ['BK','Betriebsjournal'],['BL','Phosphat'],['BM','GUS'],['BN','Wetter'],['BO','DOC']];
      const BEM = [['BE','Bemerkungen'],['BF','Bem. AWEL'],['BG','Vermerk WKS'],['BH','Ersatzteile'],['BI','Nächster Service'],['BJ','Büro Information']];

      const messwerteImmer = IMMER.map(([sp,l]) => ({ label: l, wert: clean(row[col(sp)]) ?? 'k.A.' }));
      const messwerteOptional = OPT.map(([sp,l]) => ({ label: l, wert: clean(row[col(sp)]) })).filter(f => f.wert);
      const bemerkungen = BEM.map(([sp,l]) => ({ label: l, wert: clean(row[col(sp)]) })).filter(f => f.wert);

      // Termin-Abgleich
      let termin = (kunde.termine || []).find(t => t.datum === datum);
      if (!termin) {
        // Nahen Termin suchen (±30 Tage)
        const ziel = new Date(datum.split('.')[2], datum.split('.')[1]-1, datum.split('.')[0]);
        let bester = null, besterAbs = Infinity;
        (kunde.termine || []).forEach(t => {
          const m = (t.datum||'').match(/^(\d+)\.(\d+)\.(\d+)$/);
          if (!m) return;
          const d = new Date(m[3], m[2]-1, m[1]);
          const abs = Math.abs(d - ziel) / 86400000;
          if (abs <= 30 && abs < besterAbs) { bester = t; besterAbs = abs; }
        });
        if (bester) { bester.datum = datum; korrigiert++; termin = bester; }
        else {
          const d = new Date(datum.split('.')[2], datum.split('.')[1]-1, datum.split('.')[0]);
          const nt = { halbjahr: null, jahr: d ? String(d.getFullYear()) : null, datum };
          if (!kunde.termine) kunde.termine = [];
          kunde.termine.push(nt); neuTermine++; termin = nt;
        }
      }

      if (!kunde.analysedaten) kunde.analysedaten = [];
      kunde.analysedaten = kunde.analysedaten.filter(a => a.datum !== datum);
      kunde.analysedaten.push({ datum, geruch, farbe, schlammAblauf, handlungsbedarf, messwerteImmer, messwerteOptional, bemerkungen });
      kunde.analysedaten.sort((a, b) => (a.datum||'').split('.').reverse().join('').localeCompare((b.datum||'').split('.').reverse().join('')));
      zugeordnet++;
    });

    // Halbjahr-Fix
    kunden.forEach(k => {
      const jahre = {};
      (k.termine || []).forEach(t => { if (t.jahr && t.datum) { if (!jahre[t.jahr]) jahre[t.jahr] = []; jahre[t.jahr].push(t); } });
      Object.values(jahre).forEach(tl => {
        if (tl.length < 2) return;
        tl.sort((a,b) => (a.datum||'').split('.').reverse().join('').localeCompare((b.datum||'').split('.').reverse().join('')));
        tl[0].halbjahr = '1';
        for (let i = 1; i < tl.length; i++) tl[i].halbjahr = '2';
      });
    });

    // Speichern
    const kundenPfad = path.join(__dirname, 'data', 'kunden.json');
    fs.writeFileSync(kundenPfad, JSON.stringify(kunden, null, 2));
    loadData(); // Neu laden

    const total = kunden.reduce((s, k) => s + (k.analysedaten ? k.analysedaten.length : 0), 0);

    res.json({
      ok: true,
      zugeordnet,
      nichtGefunden,
      korrigiert,
      neuTermine,
      totalAnalysedaten: total,
      dateiname: req.file.originalname,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Archiv-Info: wie viele Analysedaten pro Jahr
app.get('/api/import/archiv', requireAuth, (req, res) => {
  const proJahr = {};
  kunden.forEach(k => {
    (k.analysedaten || []).forEach(a => {
      const jahr = a.datum ? a.datum.split('.')[2] : '?';
      proJahr[jahr] = (proJahr[jahr] || 0) + 1;
    });
  });
  const total = kunden.reduce((s, k) => s + (k.analysedaten ? k.analysedaten.length : 0), 0);
  res.json({ proJahr, total });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
