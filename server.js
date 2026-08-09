const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const PASSWORD = process.env.APP_PASSWORD || 'aendern123';

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

app.get('/api/meta', requireAuth, (req, res) => {
  res.json({ anzahl: kunden.length });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
