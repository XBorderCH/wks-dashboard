const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const PASSWORD = process.env.APP_PASSWORD || 'aendern123';

// Xentral CH (Schweizer Instanz) – für Lagerbestände
const XENTRAL_CH_URL = 'https://691465794f3a6.xentral.biz';
const XENTRAL_CH_TOKEN = process.env.XENTRAL_CH_TOKEN || '';
const XENTRAL_CH_PROJEKT = '24';

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
  const { password } = req.body;
  if (password === PASSWORD) {
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
  res.json({ anzahl: kunden.length });
});

// ---- Xentral Lagerbestände ----
async function xentralFetch(pfad, params = {}) {
  const url = new URL(XENTRAL_CH_URL + pfad);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${XENTRAL_CH_TOKEN}`, Accept: 'application/json' },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Xentral ${r.status}: ${body.slice(0, 300)}`);
  }
  return r.json();
}

app.get('/api/lager', requireAuth, async (req, res) => {
  if (!XENTRAL_CH_TOKEN) {
    return res.status(400).json({ error: 'XENTRAL_CH_TOKEN ist nicht gesetzt.' });
  }

  try {
    const alleArtikel = [];
    let page = 1;
    const pageSize = 150; // Xentral erlaubt 10-150
    let weiter = true;

    while (weiter && page <= 200) {
      const data = await xentralFetch('/api/v1/products', {
        'page[number]': String(page),
        'page[size]': String(pageSize),
      });
      const items = Array.isArray(data) ? data : (data.data || data.items || []);
      items.forEach((item) => {
        // Client-seitig nach Projekt filtern (project ist ein Objekt mit id/name)
        const projektId = item.project && item.project.id ? String(item.project.id) : null;
        if (XENTRAL_CH_PROJEKT && projektId !== XENTRAL_CH_PROJEKT) return;

        alleArtikel.push({
          name: item.name || '(ohne Name)',
          nummer: item.number || '',
          bestand: item.stockCount ?? 0,
        });
      });
      if (items.length < pageSize) {
        weiter = false;
      } else {
        page++;
      }
    }

    alleArtikel.sort((a, b) => a.name.localeCompare(b.name, 'de'));

    res.json({ artikel: alleArtikel, anzahl: alleArtikel.length });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Debug-Endpoint: zeigt die Rohfelder eines Xentral-Artikels
app.get('/api/lager/debug', requireAuth, async (req, res) => {
  if (!XENTRAL_CH_TOKEN) {
    return res.status(400).json({ error: 'XENTRAL_CH_TOKEN ist nicht gesetzt.' });
  }
  try {
    const data = await xentralFetch('/api/v1/products', {
      'page[number]': '1',
      'page[size]': '10',
    });
    const items = Array.isArray(data) ? data : (data.data || data.items || []);
    res.json({
      meta: data.meta || data.pagination || null,
      anzahlImSample: items.length,
      felder: items[0] ? Object.keys(items[0]) : [],
      erstesItem: items[0] || null,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
