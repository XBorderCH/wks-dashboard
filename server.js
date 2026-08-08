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

app.get('/api/meta', requireAuth, (req, res) => {
  res.json({ anzahl: kunden.length });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
