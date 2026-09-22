/**
 * Xentral Versand-KPI  –  mit Login
 *
 * Zwei Kennzahlen extern verfügbar:
 *   1) offeneLieferscheine     – freigegebene, nicht versendete Lieferscheine
 *                                ("Bringe Sendungen auf den Weg")
 *   2) versandbereiteAuftraege – Aufträge in der Versandübergabe
 *
 * Routen:
 *   GET  /            → Dashboard (Login nötig)
 *   GET  /login       → Loginformular
 *   POST /login       → Anmeldung
 *   POST /logout      → Abmeldung
 *   GET  /api/kpi     → JSON (Session-Cookie ODER Header x-api-key)
 *   GET  /api/debug   → Rohdaten + erkannte Statuswerte (zum Feldabgleich)
 *   GET  /healthz     → ok (immer offen, für Render Health Check)
 *
 * ENV:
 *   XENTRAL_URL      https://deinefirma.xentral.biz  (ohne Slash am Ende)
 *   XENTRAL_TOKEN    Bearer-Token
 *   LOGIN_USER       Benutzername fürs Dashboard
 *   LOGIN_PASSWORD   Passwort fürs Dashboard
 *   SESSION_SECRET   langer Zufallsstring (Cookie-Signatur)
 *   PROJEKT_ID       optional – auf ein Projekt einschränken
 *   API_KEY          optional – Maschinenzugriff auf /api/* ohne Login
 *   CACHE_TTL_MS     optional – Default 60000
 *   PORT             von Render gesetzt
 */

const crypto = require("crypto");
const express = require("express");

const app = express();
app.set("trust proxy", 1); // Render terminiert TLS vorgelagert
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;
const BASE = (process.env.XENTRAL_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.XENTRAL_TOKEN || "";
const PROJEKT_ID = process.env.PROJEKT_ID || "";
const API_KEY = process.env.API_KEY || "";
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 300000);

const LOGIN_USER = process.env.LOGIN_USER || "";
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const SESSION_DAUER_MS = 12 * 60 * 60 * 1000; // 12 Stunden
const COOKIE_NAME = "vkpi_session";

if (!LOGIN_USER || !LOGIN_PASSWORD || !SESSION_SECRET) {
  console.warn(
    "WARNUNG: LOGIN_USER, LOGIN_PASSWORD und SESSION_SECRET sind nicht vollständig gesetzt – der Login lässt niemanden durch."
  );
}

/* ------------------------------------------------------------------ *
 * Statuswerte – EINZIGE Stelle, die du ggf. anpassen musst.
 * Tatsächliche Werte über /api/debug prüfen.
 * ------------------------------------------------------------------ */
const STATUS = {
  lieferscheinFreigegeben: "released",  // per /api/debug bestaetigt
  auftragFreigegeben: "released",       // vermutet – ueber /api/debug pruefen
};

/* ------------------------------- Login ----------------------------- */

function zeitgleich(a, b) {
  const pa = Buffer.from(String(a));
  const pb = Buffer.from(String(b));
  if (pa.length !== pb.length) return false;
  return crypto.timingSafeEqual(pa, pb);
}

function tokenErstellen(benutzer) {
  const ablauf = Date.now() + SESSION_DAUER_MS;
  const nutzlast = Buffer.from(JSON.stringify({ benutzer, ablauf })).toString("base64url");
  const signatur = crypto.createHmac("sha256", SESSION_SECRET).update(nutzlast).digest("base64url");
  return `${nutzlast}.${signatur}`;
}

function tokenPruefen(token) {
  if (!token || !SESSION_SECRET) return null;
  const [nutzlast, signatur] = token.split(".");
  if (!nutzlast || !signatur) return null;
  const soll = crypto.createHmac("sha256", SESSION_SECRET).update(nutzlast).digest("base64url");
  if (!zeitgleich(signatur, soll)) return null;
  try {
    const daten = JSON.parse(Buffer.from(nutzlast, "base64url").toString());
    if (Date.now() > daten.ablauf) return null;
    return daten;
  } catch {
    return null;
  }
}

function cookieLesen(req, name) {
  const roh = req.headers.cookie;
  if (!roh) return null;
  for (const teil of roh.split(";")) {
    const i = teil.indexOf("=");
    if (i > -1 && teil.slice(0, i).trim() === name) {
      return decodeURIComponent(teil.slice(i + 1).trim());
    }
  }
  return null;
}

function angemeldet(req) {
  return Boolean(tokenPruefen(cookieLesen(req, COOKIE_NAME)));
}

// Seiten: Weiterleitung auf /login
function seiteSchuetzen(req, res, next) {
  if (angemeldet(req)) return next();
  res.redirect("/login");
}

// API: Session-Cookie oder x-api-key
function apiSchuetzen(req, res, next) {
  if (angemeldet(req)) return next();
  if (API_KEY && req.get("x-api-key") && zeitgleich(req.get("x-api-key"), API_KEY)) return next();
  res.status(401).json({ fehler: "Nicht angemeldet" });
}

app.get("/login", (req, res) => {
  if (angemeldet(req)) return res.redirect("/");
  res.type("html").send(loginSeite(req.query.fehler === "1"));
});

app.post("/login", (req, res) => {
  const { benutzer = "", passwort = "" } = req.body || {};
  const ok =
    LOGIN_USER &&
    LOGIN_PASSWORD &&
    SESSION_SECRET &&
    zeitgleich(benutzer, LOGIN_USER) &&
    zeitgleich(passwort, LOGIN_PASSWORD);

  if (!ok) return res.redirect("/login?fehler=1");

  res.cookie(COOKIE_NAME, tokenErstellen(benutzer), {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development",
    sameSite: "lax",
    maxAge: SESSION_DAUER_MS,
  });
  res.redirect("/");
});

app.post("/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.redirect("/login");
});

/* ------------------------------ Xentral ---------------------------- */

// Xentral v1 erwartet Bracket-Notation:
//   filter[0][key]=status&filter[0][op]=equals&filter[0][value]=freigegeben
//   page[number]=1&page[size]=100
// Ein JSON-String in `filter` oder ein `limit` führt zu 400 request-validation.
function paramsFlach(obj, prefix, out = []) {
  if (obj === undefined || obj === null || obj === "") return out;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => paramsFlach(v, `${prefix}[${i}]`, out));
  } else if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      paramsFlach(v, prefix ? `${prefix}[${k}]` : k, out);
    }
  } else {
    out.push([prefix, String(obj)]);
  }
  return out;
}

/* --- Drosselung: alle Xentral-Requests laufen sequenziell durch ein Gate --- *
 * Xentral antwortet mit 429 "Too Many Attempts", wenn Requests zu schnell
 * aufeinander folgen. MIN_ABSTAND_MS haelt den Mindestabstand ein, bei 429
 * wird mit steigender Wartezeit erneut versucht.
 */
const MIN_ABSTAND_MS = Number(process.env.MIN_ABSTAND_MS || 400);
const MAX_VERSUCHE = 4;

let gate = Promise.resolve();
let letzterCall = 0;

function warte(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function durchGate(fn) {
  const ergebnis = gate.then(async () => {
    const abstand = Date.now() - letzterCall;
    if (abstand < MIN_ABSTAND_MS) await warte(MIN_ABSTAND_MS - abstand);
    letzterCall = Date.now();
    return fn();
  });
  // Gate darf nicht durch einen Fehler blockiert werden
  gate = ergebnis.then(
    () => undefined,
    () => undefined
  );
  return ergebnis;
}

async function xentralRoh(path, params) {
  const url = new URL(BASE + path);
  for (const [k, v] of paramsFlach(params, "")) url.searchParams.append(k, v);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const err = new Error("429");
    err.rateLimit = true;
    err.warteMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Xentral ${res.status} auf ${path}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function xentral(path, params = {}) {
  for (let versuch = 1; versuch <= MAX_VERSUCHE; versuch++) {
    try {
      return await durchGate(() => xentralRoh(path, params));
    } catch (err) {
      if (!err.rateLimit || versuch === MAX_VERSUCHE) {
        if (err.rateLimit) {
          throw new Error(
            `Xentral 429 auf ${path}: Rate Limit auch nach ${MAX_VERSUCHE} Versuchen. ` +
              `MIN_ABSTAND_MS erhoehen oder weniger Seiten abfragen.`
          );
        }
        throw err;
      }
      const wartezeit = err.warteMs ?? 1000 * 2 ** versuch; // 2s, 4s, 8s
      console.warn(`429 auf ${path} – warte ${wartezeit} ms (Versuch ${versuch})`);
      await warte(wartezeit);
    }
  }
}

function filter(pairs) {
  return pairs.map(([key, value, op = "equals"]) => ({ key, op, value }));
}

function itemsOf(payload) {
  if (Array.isArray(payload)) return payload;
  return payload.data || payload.items || [];
}

const SEITENGROESSE = 50;   // Xentral-Maximum, hoehere Werte -> 400
const MAX_SEITEN = 40;

// Holt alle Datensaetze zu einem Filter (nicht nur die Anzahl), weil beide
// Kennzahlen auf Feldern beruhen, die die API nicht filtern kann.
async function sammelAlle(path, filterPairs) {
  const basis = filterPairs.length ? { filter: filter(filterPairs) } : {};
  const alle = [];
  let proSeite = null;

  for (let nr = 1; nr <= MAX_SEITEN; nr++) {
    const items = itemsOf(await xentral(path, { ...basis, page: { number: nr, size: SEITENGROESSE } }));
    if (proSeite === null) proSeite = items.length;
    alle.push(...items);
    if (items.length < SEITENGROESSE) break;
  }
  return alle;
}

/* ---------------------------- Kennzahl 2 ---------------------------- *
 * Zu versendende Auftraege: offen (released), Lagerampel gruen (stockOk)
 * und Autoversand aktiviert.
 */
function istVersandbereit(auftrag) {
  const lagerOk = auftrag.stockOk === true;
  const autoversand = auftrag.delivery?.autoShipping === true;
  return lagerOk && autoversand;
}

async function ladeVersandbereiteAuftraege() {
  const projekt = PROJEKT_ID ? [["project", PROJEKT_ID]] : [];
  const offene = await sammelAlle("/api/v1/salesOrders", [
    ["status", STATUS.auftragFreigegeben],
    ...projekt,
  ]);
  return {
    anzahl: offene.filter(istVersandbereit).length,
    offeneGesamt: offene.length,
    ids: new Set(offene.map((a) => String(a.id))),
  };
}

/* ---------------------------- Kennzahl 1 ---------------------------- *
 * Lieferscheine ohne Trackingnummer. Der Pfad zur Trackingnummer wird
 * ueber ENV gesetzt, weil er je nach Xentral-Version abweicht –
 * /api/probe zeigt, welcher Endpunkt und welches Feld greifen.
 *
 * TRACKING_QUELLE:
 *   "auftragsstatus" – Lieferscheine, deren Auftrag noch offen ist (Default,
 *                      keine Zusatz-Requests: versendet -> Auftrag completed)
 *   "detail"    – pro Lieferschein /api/v1/deliveryNotes/{id} nachladen
 *   "shipments" – Trackingnummern aus TRACKING_PFAD sammeln und abgleichen
 *   "aus"       – Kennzahl abgeschaltet, liefert null
 */
const TRACKING_QUELLE = process.env.TRACKING_QUELLE || "auftragsstatus";
const TRACKING_PFAD = process.env.TRACKING_PFAD || "/api/v1/shipments";
const TRACKING_FELD = process.env.TRACKING_FELD || "trackingNumber";
const LS_TAGE = Number(process.env.LS_TAGE || 21); // Betrachtungsfenster in Tagen

function hatTracking(obj) {
  const wert = TRACKING_FELD.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
  if (Array.isArray(wert)) return wert.length > 0;
  return Boolean(wert && String(wert).trim());
}

// Nur die letzten LS_TAGE betrachten – aeltere Lieferscheine sind versendet,
// und die Liste umfasst sonst die komplette Historie.
function istAktuell(ls) {
  const datum = new Date(ls.documentDate || ls.createdAt);
  return Date.now() - datum.getTime() <= LS_TAGE * 86400000;
}

async function ladeOffeneLieferscheine(offeneAuftragIds) {
  if (TRACKING_QUELLE === "aus") return { anzahl: null, hinweis: "TRACKING_QUELLE nicht gesetzt" };

  const projekt = PROJEKT_ID ? [["project", PROJEKT_ID]] : [];
  const alle = await sammelAlle("/api/v1/deliveryNotes", [
    ["status", STATUS.lieferscheinFreigegeben],
    ...projekt,
  ]);
  const aktuell = alle.filter(istAktuell);

  if (TRACKING_QUELLE === "auftragsstatus") {
    return {
      anzahl: aktuell.filter((ls) => offeneAuftragIds.has(String(ls.salesOrder?.id))).length,
      betrachtet: aktuell.length,
    };
  }

  if (TRACKING_QUELLE === "shipments") {
    const sendungen = await sammelAlle(TRACKING_PFAD, []);
    const mitTracking = new Set(
      sendungen
        .filter(hatTracking)
        .map((sd) => String(sd.deliveryNote?.id ?? sd.deliveryNoteId ?? sd.deliveryNote ?? ""))
    );
    return {
      anzahl: aktuell.filter((ls) => !mitTracking.has(String(ls.id))).length,
      betrachtet: aktuell.length,
    };
  }

  // "detail": pro Lieferschein einen Request – nur im Zeitfenster vertretbar
  let ohne = 0;
  for (const ls of aktuell) {
    const detail = await xentral(`/api/v1/deliveryNotes/${ls.id}`, {});
    const daten = detail.data || detail;
    if (!hatTracking(daten)) ohne += 1;
  }
  return { anzahl: ohne, betrachtet: aktuell.length };
}

/* ------------------- Primaerquelle: Xentral-UI-Endpunkt ------------------- *
 * /api/ui/recommendations liefert genau die Zahlen der Empfehlungs-Kacheln:
 *   openShipments.result  -> Sendungen auf den Weg bringen
 *   openOrders.result     -> offene Auftraege
 * Der /api/ui/-Namespace haengt womoeglich an der Web-Session statt am
 * Bearer-Token. Falls der Aufruf scheitert, wird auf die eigene Zaehlung
 * zurueckgefallen. XENTRAL_COOKIE kann als Notloesung einen Session-Cookie
 * mitschicken (laeuft aber ab und ist damit nicht dauerhaft tragfaehig).
 */
const UI_QUELLE_AKTIV = process.env.UI_QUELLE !== "aus";
const XENTRAL_COOKIE = process.env.XENTRAL_COOKIE || "";

async function ladeUiEmpfehlungen() {
  const res = await durchGate(() =>
    fetch(BASE + "/api/ui/recommendations", {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/json",
        ...(XENTRAL_COOKIE ? { Cookie: XENTRAL_COOKIE } : {}),
      },
    })
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`UI ${res.status}: ${body.slice(0, 200)}`);
  }
  const daten = await res.json();
  const wert = (k) => {
    const eintrag = daten[k] || daten.data?.[k];
    return typeof eintrag?.result === "number" ? eintrag.result : null;
  };
  return {
    openShipments: wert("openShipments"),
    openOrders: wert("openOrders"),
    roh: daten,
  };
}

/* ===================== Sendungen heute (Post-API) ======================== *
 * Direkte Anbindung an die Post-API, portiert aus post.js des
 * post-sendungs-dashboard. Kein Cache noetig: der heutige Tag wurde dort
 * ohnehin nie gecacht (nur Tage ab 2 Tagen Alter).
 *
 * Alternativ (ohne Post-Zugangsdaten): POST_DASHBOARD_URL setzen, dann wird
 * /api/day des bestehenden Dashboards per Basic Auth abgefragt.
 *
 * ENV direkt:    POST_BASE_URL, POST_CLIENT_ID, POST_CLIENT_SECRET, POST_SCOPE,
 *                POST_FRANKING_LICENSE, POST_PRODUCT, POST_CATEGORY,
 *                POST_TOKEN_URL, POST_ACCEPT_LANGUAGE
 * ENV via HTTP:  POST_DASHBOARD_URL, POST_DASHBOARD_USER, POST_DASHBOARD_PASS
 */
const POST_BASE_URL = process.env.POST_BASE_URL || "";
const POST_TOKEN_URL = process.env.POST_TOKEN_URL || "https://api.post.ch/OAuth/token";
const POST_CLIENT_ID = process.env.POST_CLIENT_ID || "";
const POST_CLIENT_SECRET = process.env.POST_CLIENT_SECRET || "";
const POST_SCOPE = process.env.POST_SCOPE || "";
const POST_FRANKING_LICENSE = process.env.POST_FRANKING_LICENSE || "";
const POST_PRODUCT = process.env.POST_PRODUCT || "";
const POST_CATEGORY = process.env.POST_CATEGORY || "PARCEL";
const POST_ACCEPT_LANGUAGE = process.env.POST_ACCEPT_LANGUAGE || "de";

const POST_DASHBOARD_URL = (process.env.POST_DASHBOARD_URL || "").replace(/\/+$/, "");
const POST_DASHBOARD_USER = process.env.POST_DASHBOARD_USER || "";
const POST_DASHBOARD_PASS = process.env.POST_DASHBOARD_PASS || "";

const POST_DIREKT = Boolean(POST_BASE_URL && POST_CLIENT_ID && POST_CLIENT_SECRET && POST_FRANKING_LICENSE);

/* --- Token --- */
let postToken = null;
let postTokenAblauf = 0;

async function holePostToken() {
  if (postToken && Date.now() < postTokenAblauf - 10000) return postToken;

  const res = await fetch(POST_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: POST_CLIENT_ID,
      client_secret: POST_CLIENT_SECRET,
      scope: POST_SCOPE,
    }),
  });
  if (!res.ok) throw new Error(`Post-Token-Fehler ${res.status}: ${(await res.text()).slice(0, 160)}`);

  const json = await res.json();
  postToken = json.access_token;
  postTokenAblauf = Date.now() + (json.expires_in ? json.expires_in * 1000 : 300000);
  return postToken;
}

/* --- Eigene Drosselung: Post erlaubt 50 Anfragen/Minute --- */
const POST_MIN_ABSTAND_MS = 1300;
let postNaechsterSlot = 0;

async function postThrottle() {
  const wait = postNaechsterSlot - Date.now();
  if (wait > 0) await warte(wait);
  postNaechsterSlot = Date.now() + POST_MIN_ABSTAND_MS;
}

async function queryMailpieces(startDate, endDate, limit, offset, versuche = 2) {
  const lizenz = { frankingLicense: POST_FRANKING_LICENSE, category: POST_CATEGORY };
  if (POST_PRODUCT) lizenz.product = POST_PRODUCT;

  let letzterFehler;
  for (let versuch = 0; versuch <= versuche; versuch++) {
    await postThrottle();
    try {
      const token = await holePostToken();
      const url = new URL(`${POST_BASE_URL}/mailpieces/query/by-franking-licenses`);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));

      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Accept-Language": POST_ACCEPT_LANGUAGE,
        },
        body: JSON.stringify({
          frankingLicenses: [lizenz],
          dateRange: { startDate, endDate },
        }),
      });

      // Post liefert 404 statt einer leeren Liste = 0 Sendungen
      if (res.status === 404) return { mailpieces: [], _metadata: { hasMore: false } };

      if (res.status === 429) {
        postNaechsterSlot = Date.now() + 61000; // Limit ist minuetlich
        letzterFehler = new Error("Post 429: Rate limit");
        continue;
      }
      if (!res.ok) throw new Error(`Post-Abfrage-Fehler ${res.status}: ${(await res.text()).slice(0, 160)}`);
      return await res.json();
    } catch (err) {
      letzterFehler = err;
      if (versuch < versuche) await warte(700 * (versuch + 1));
    }
  }
  throw letzterFehler;
}

// Zaehlt die tatsaechlichen Items (nicht _metadata.totalCount – laut post.js
// unzuverlaessig). onlyProcessed filtert NOT_YET_SENT heraus.
async function postAnzahlFuerTag(dateStr, { onlyProcessed = false } = {}) {
  const limit = 200;
  let offset = 0;
  let hasMore = true;
  let total = 0;
  let guard = 0;

  while (hasMore && guard < 50) {
    guard += 1;
    const json = await queryMailpieces(dateStr, dateStr, limit, offset);
    const items = json.mailpieces || [];

    total += onlyProcessed
      ? items.filter((i) => i?.status?.status !== "NOT_YET_SENT").length
      : items.length;

    hasMore = Boolean(json._metadata?.hasMore) && items.length > 0;
    offset += limit;
  }
  return total;
}

/* --- Datumshilfen (lokale Zeit CH, nicht UTC) --- */
function heuteLokal() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(new Date());
}

function tagVerschieben(dateStr, delta) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function wochentag(dateStr) {
  return new Date(dateStr + "T00:00:00Z").getUTCDay(); // 0=So, 1=Mo, 6=Sa
}

function istMontag(dateStr) {
  return wochentag(dateStr) === 1;
}

// Am Wochenende erstellte Labels gehen nicht raus – sie zaehlen als offen.
// Sa: nur Samstag. So: Samstag + Sonntag.
function wochenendTage(dateStr) {
  const tag = wochentag(dateStr);
  if (tag === 6) return [dateStr];
  if (tag === 0) return [tagVerschieben(dateStr, -1), dateStr];
  return null;
}

/* --- Variante A: direkt gegen die Post-API --- */
async function sendungenHeuteDirekt() {
  const heute = heuteLokal();
  const we = wochenendTage(heute);

  // Wochenende: erstellte Labels sind noch nicht verschickt -> als offen zaehlen
  if (we) {
    let anzahl = 0;
    for (const tag of we) anzahl += await postAnzahlFuerTag(tag, { onlyProcessed: false });
    return { anzahl, datum: heute, alsOffen: true, tage: we, quelle: "post-api" };
  }

  // "heute" = alle erstellten Labels, deshalb onlyProcessed: false
  let anzahl = await postAnzahlFuerTag(heute, { onlyProcessed: false });

  // Montag: Sa+So-Labels gehen erst heute raus, also mitzaehlen
  if (istMontag(heute)) {
    const [sa, so] = [tagVerschieben(heute, -2), tagVerschieben(heute, -1)];
    anzahl += await postAnzahlFuerTag(sa, { onlyProcessed: false });
    anzahl += await postAnzahlFuerTag(so, { onlyProcessed: false });
  }

  return {
    anzahl,
    datum: heute,
    alsOffen: false,
    inklWochenende: istMontag(heute),
    quelle: "post-api",
  };
}

/* --- Variante B: ueber das bestehende Dashboard (Montagslogik dort drin) --- */
async function sendungenHeuteViaDashboard() {
  const heute = heuteLokal();
  const kopf = { Accept: "application/json" };
  if (POST_DASHBOARD_USER) {
    const b64 = Buffer.from(`${POST_DASHBOARD_USER}:${POST_DASHBOARD_PASS}`).toString("base64");
    kopf.Authorization = `Basic ${b64}`;
  }

  const tagAbfragen = async (datum) => {
    const res = await fetch(`${POST_DASHBOARD_URL}/api/day?date=${datum}`, { headers: kopf });
    if (res.status === 401) throw new Error("Post-Dashboard 401 – USER/PASS pruefen");
    if (!res.ok) throw new Error(`Post-Dashboard ${res.status}`);
    const daten = await res.json();
    if (daten.error) throw new Error(`Post-Dashboard: ${daten.error}`);
    return typeof daten.count === "number" ? daten.count : null;
  };

  const we = wochenendTage(heute);
  if (we) {
    let anzahl = 0;
    for (const tag of we) anzahl += (await tagAbfragen(tag)) || 0;
    return { anzahl, datum: heute, alsOffen: true, tage: we, quelle: "post-dashboard" };
  }

  return {
    anzahl: await tagAbfragen(heute),
    datum: heute,
    alsOffen: false,
    inklWochenende: istMontag(heute),
    quelle: "post-dashboard",
  };
}

async function ladeSendungenHeute() {
  if (POST_DIREKT) return sendungenHeuteDirekt();
  if (POST_DASHBOARD_URL) return sendungenHeuteViaDashboard();
  return { anzahl: null, hinweis: "Post-Zugang nicht konfiguriert" };
}

async function ladeKpi() {
  let ui = null;
  let hinweis = null;

  const post = await ladeSendungenHeute().catch((err) => ({
    anzahl: null,
    hinweis: err.message.slice(0, 120),
  }));

  if (UI_QUELLE_AKTIV) {
    try {
      ui = await ladeUiEmpfehlungen();
    } catch (err) {
      hinweis = `UI-Quelle nicht verfuegbar: ${err.message.slice(0, 120)}`;
    }
  }

  // Beide Zahlen direkt aus Xentral
  if (ui && ui.openShipments !== null && ui.openOrders !== null) {
    return {
      offeneLieferscheine: ui.openShipments,
      offeneAuftraege: ui.openOrders,
      sendungenHeute: post.anzahl,
      inklWochenende: post.inklWochenende ?? null,
      postAlsOffen: post.alsOffen ?? false,
      quelle: "ui/recommendations",
      hinweis: [hinweis, post.hinweis].filter(Boolean).join(" · ") || null,
      stand: new Date().toISOString(),
    };
  }

  // Fallback: eigene Zaehlung, falls der UI-Endpunkt nicht erreichbar ist
  const auftraege = await ladeVersandbereiteAuftraege();
  const ls = await ladeOffeneLieferscheine(auftraege.ids);

  return {
    offeneLieferscheine: ui?.openShipments ?? ls.anzahl,
    offeneAuftraege: ui?.openOrders ?? auftraege.offeneGesamt,
    sendungenHeute: post.anzahl,
    inklWochenende: post.inklWochenende ?? null,
    postAlsOffen: post.alsOffen ?? false,
    versandbereitEigen: auftraege.anzahl,
    quelle: "eigene Zaehlung",
    hinweis,
    stand: new Date().toISOString(),
  };
}

/* ------------------------------- Cache ----------------------------- */

let cache = { data: null, zeit: 0, laeuft: null };

async function kpiMitCache(force = false) {
  const frisch = Date.now() - cache.zeit < CACHE_TTL_MS;
  if (!force && cache.data && frisch) return { ...cache.data, cached: true };
  if (cache.laeuft) return cache.laeuft;

  cache.laeuft = ladeKpi()
    .then((data) => {
      cache = { data, zeit: Date.now(), laeuft: null };
      return { ...data, cached: false };
    })
    .catch((err) => {
      cache.laeuft = null;
      throw err;
    });
  return cache.laeuft;
}

/* ------------------------------- Routen ---------------------------- */

app.get("/healthz", (_req, res) => res.send("ok"));

// Zeigt, welcher Stand tatsaechlich live ist – hilft beim Deploy-Abgleich.
app.get("/api/version", (_req, res) =>
  res.json({
    version: "2026-08-13-n",
    routen: ["/api/kpi", "/api/ui-test", "/api/post-test", "/api/debug", "/api/probe", "/api/version"],
    seitengroesse: SEITENGROESSE,
    minAbstandMs: MIN_ABSTAND_MS,
    cacheTtlMs: CACHE_TTL_MS,
  })
);

app.get("/api/kpi", apiSchuetzen, async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(await kpiMitCache(req.query.force === "1"));
  } catch (err) {
    res.status(502).json({ fehler: err.message });
  }
});

// Statusverteilung ueber viele Seiten – zeigt, welche Statuswerte es gibt
// und wie viele Datensaetze jeweils darauf stehen. ?seiten=N steuert die Tiefe.
app.get("/api/debug", apiSchuetzen, async (req, res) => {
  const maxSeiten = Math.min(Number(req.query.seiten || 6), 40);
  try {
    const out = {};
    for (const [name, path] of [
      ["deliveryNotes", "/api/v1/deliveryNotes"],
      ["salesOrders", "/api/v1/salesOrders"],
    ]) {
      const verteilung = {};
      let gesamt = 0;
      let proSeite = null;
      let beispieleJeStatus = {};
      let letzte = [];

      for (let nr = 1; nr <= maxSeiten; nr++) {
        const payload = await xentral(path, { page: { number: nr, size: SEITENGROESSE } });
        const items = itemsOf(payload);
        if (proSeite === null) proSeite = items.length;
        for (const i of items) {
          const st = String(i.status);
          verteilung[st] = (verteilung[st] || 0) + 1;
          if (!beispieleJeStatus[st]) {
            beispieleJeStatus[st] = {
              nummer: i.number || i.documentNumber,
              datum: i.documentDate || i.date,
              aktualisiert: i.updatedAt,
            };
          }
        }
        gesamt += items.length;
        letzte = items.slice(-3).map((i) => ({
          nummer: i.number || i.documentNumber,
          status: i.status,
          datum: i.documentDate || i.date,
        }));
        if (items.length < (proSeite || 1)) break;
      }

      out[name] = {
        geprueft: gesamt,
        seitenGeprueft: Math.ceil(gesamt / (proSeite || 1)),
        vollstaendig: gesamt < maxSeiten * (proSeite || SEITENGROESSE),
        verteilung,
        aeltesterJeStatus: beispieleJeStatus,
        letzteDatensaetze: letzte,
      };
    }
    res.json(out);
  } catch (err) {
    res.status(502).json({ fehler: err.message });
  }
});

// Beantwortet zwei Fragen: wo liegt die Trackingnummer, und kann ich
// absteigend sortieren? Nur wenige Requests, unkritisch fuers Rate Limit.
app.get("/api/post-test", apiSchuetzen, async (_req, res) => {
  try {
    res.json({ direkt: POST_DIREKT, ...(await ladeSendungenHeute()) });
  } catch (err) {
    res.status(502).json({ fehler: err.message });
  }
});

app.get("/api/ui-test", apiSchuetzen, async (_req, res) => {
  try {
    res.json(await ladeUiEmpfehlungen());
  } catch (err) {
    res.status(502).json({ fehler: err.message });
  }
});

app.get("/api/probe", apiSchuetzen, async (_req, res) => {
  const out = { trackingKandidaten: {}, sortierung: {}, lieferscheinDetail: null };

  for (const path of [
    "/api/v1/shipments",
    "/api/v1/shippings",
    "/api/v1/parcels",
    "/api/v1/trackings",
    "/api/v2/shipments",
    "/api/v2/deliveryNotes",
  ]) {
    try {
      const payload = await xentral(path, { page: { number: 1, size: 5 } });
      const items = itemsOf(payload);
      out.trackingKandidaten[path] = {
        ok: true,
        anzahl: items.length,
        felder: items[0] ? Object.keys(items[0]) : null,
        beispiel: items[0] || null,
      };
    } catch (err) {
      out.trackingKandidaten[path] = { ok: false, fehler: err.message.slice(0, 140) };
    }
  }

  // Detailansicht eines Lieferscheins – enthaelt sie ein Tracking-Feld?
  try {
    const liste = itemsOf(await xentral("/api/v1/deliveryNotes", { page: { number: 1, size: 1 } }));
    if (liste[0]) {
      const detail = await xentral(`/api/v1/deliveryNotes/${liste[0].id}`, {});
      const daten = detail.data || detail;
      out.lieferscheinDetail = { felder: Object.keys(daten), beispiel: daten };
    }
  } catch (err) {
    out.lieferscheinDetail = { fehler: err.message.slice(0, 200) };
  }

  // Welche Sortier-Syntax akzeptiert die API?
  const varianten = {
    "sort[0][field]/direction": { sort: [{ field: "id", direction: "desc" }] },
    "sort[0][key]/order": { sort: [{ key: "id", order: "desc" }] },
    "sort=-id": { sort: "-id" },
    "order=id&direction=desc": { order: "id", direction: "desc" },
  };
  for (const [name, params] of Object.entries(varianten)) {
    try {
      const items = itemsOf(
        await xentral("/api/v1/deliveryNotes", { ...params, page: { number: 1, size: 3 } })
      );
      out.sortierung[name] = { ok: true, erste: items.map((i) => i.number) };
    } catch (err) {
      out.sortierung[name] = { ok: false, fehler: err.message.slice(0, 120) };
    }
  }

  res.json(out);
});

app.get("/", seiteSchuetzen, (_req, res) => res.type("html").send(DASHBOARD));

/* ------------------------------- Seiten ---------------------------- */

const STIL = `
  :root{
    --grund:#101314; --karte:#171b1c; --linie:#252b2c;
    --text:#e8ece9; --leise:#7d8a86; --signal:#c9f24d; --warn:#ff8b52;
  }
  *{box-sizing:border-box}
  body{
    margin:0; min-height:100dvh; background:var(--grund); color:var(--text);
    font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
    letter-spacing:.02em; padding:20px;
  }
  input{
    width:100%; padding:11px 12px; background:#0b0e0f; color:var(--text);
    border:1px solid var(--linie); border-radius:2px; font:inherit; font-size:15px;
  }
  input:focus-visible{outline:none; border-color:var(--signal)}
  button{
    background:none; border:1px solid var(--linie); color:var(--leise);
    font:inherit; font-size:11px; text-transform:uppercase; letter-spacing:.08em;
    padding:8px 14px; border-radius:2px; cursor:pointer;
  }
  button:hover,button:focus-visible{color:var(--text); border-color:var(--leise)}
  .label{font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--leise)}
  .fehler{color:var(--warn); font-size:12px}
`;

function loginSeite(fehler) {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Anmelden · Versandübergabe</title>
<style>${STIL}
  body{display:flex; align-items:center; justify-content:center}
  form{width:100%; max-width:330px; display:flex; flex-direction:column; gap:14px}
  h1{font-size:13px; text-transform:uppercase; letter-spacing:.1em; color:var(--leise); margin:0 0 6px}
  .feld{display:flex; flex-direction:column; gap:6px}
  form button{align-self:flex-start; margin-top:4px}
</style>
</head>
<body>
  <form method="post" action="/login">
    <h1>Versandübergabe</h1>
    ${fehler ? '<p class="fehler">Benutzername oder Passwort stimmt nicht.</p>' : ""}
    <div class="feld">
      <label class="label" for="benutzer">Benutzername</label>
      <input id="benutzer" name="benutzer" autocomplete="username" autocapitalize="none" required>
    </div>
    <div class="feld">
      <label class="label" for="passwort">Passwort</label>
      <input id="passwort" name="passwort" type="password" autocomplete="current-password" required>
    </div>
    <button type="submit">Anmelden</button>
  </form>
</body>
</html>`;
}

const DASHBOARD = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Versandübergabe</title>
<style>${STIL}
  body{display:flex; flex-direction:column; justify-content:center; gap:14px}
  header{display:flex; justify-content:space-between; align-items:baseline;
    text-transform:uppercase; font-size:11px; letter-spacing:.08em; color:var(--leise)}
  .karte{background:var(--karte); border:1px solid var(--linie); border-radius:2px;
    padding:16px 20px 14px; position:relative; overflow:hidden}
  .karte::before{content:""; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--signal)}
  .karte.zwei::before{background:var(--leise)}
  .karte.drei::before{background:var(--signal)}
  .karte.drei .zahl{color:var(--signal)}
  .karte.total{padding:24px 20px 20px}
  .karte.total::before{background:var(--warn)}
  .karte.total .zahl{color:var(--warn)}
  .karte.total .zahl{font-size:clamp(64px,22vw,120px); line-height:.86; margin-top:4px}
  .karte .label{margin-bottom:10px}
  .zahl{font-size:clamp(30px,9vw,46px); line-height:.9; font-weight:600; font-variant-numeric:tabular-nums}
  .zusatz{margin-top:10px; font-size:12px; color:var(--leise)}
  footer{display:flex; justify-content:space-between; align-items:center; gap:10px; font-size:11px; color:var(--leise)}
  footer form{margin:0}
  [aria-busy="true"] .zahl{opacity:.35}
</style>
</head>
<body>
  <header><span>Versandübergabe</span><span id="stand">–</span></header>

  <div class="karte" aria-busy="true">
    <div class="label">Sendungen versandbereit</div>
    <div class="zahl" id="w1">–</div>
    <div class="zusatz">Im Versandzentrum</div>
  </div>

  <div class="karte zwei" aria-busy="true">
    <div class="label">Sendungen vorbereitet</div>
    <div class="zahl" id="w2">–</div>
    <div class="zusatz">Noch nicht im Versandzentrum</div>
  </div>

  <div class="karte total" aria-busy="true">
    <div class="label">Zu versendende Aufträge</div>
    <div class="zahl" id="wt">–</div>
  </div>

  <div class="karte drei" aria-busy="true">
    <div class="label">Heute verschickt</div>
    <div class="zahl" id="w3">–</div>
    <div class="zusatz" id="w3zusatz">Schweizerische Post</div>
  </div>

  <footer>
    <span id="meldung"></span>
    <span>
      <button id="neu">Neu laden</button>
      <form method="post" action="/logout" style="display:inline">
        <button type="submit">Abmelden</button>
      </form>
    </span>
  </footer>

<script>
const zahl = new Intl.NumberFormat("de-CH");
const uhr = new Intl.DateTimeFormat("de-CH",{hour:"2-digit",minute:"2-digit"});

async function laden(force){
  document.querySelectorAll(".karte").forEach(k => k.setAttribute("aria-busy","true"));
  try{
    const r = await fetch("/api/kpi" + (force ? "?force=1" : ""));
    if(r.status === 401){ location.href = "/login"; return; }
    const d = await r.json();
    if(!r.ok) throw new Error(d.fehler || "Abruf fehlgeschlagen");
    w1.textContent = d.offeneLieferscheine === null ? "n/v" : zahl.format(d.offeneLieferscheine);
    w2.textContent = d.offeneAuftraege === null ? "n/v" : zahl.format(d.offeneAuftraege);
    const post = typeof d.sendungenHeute === "number" ? d.sendungenHeute : null;

    // Wochenende: erstellte Labels sind noch nicht raus -> sie zaehlen zu den
    // offenen Auftraegen, die Kachel "Heute verschickt" bleibt leer.
    if (d.postAlsOffen) {
      w3.textContent = "–";
      w3zusatz.textContent = "Wochenende – in Summe oben enthalten";
    } else {
      w3.textContent = post === null ? "n/v" : zahl.format(post);
      w3zusatz.textContent = d.inklWochenende
        ? "Inkl. Sa/So \u00b7 Erstellte Versandlabels"
        : "Erstellte Versandlabels";
    }

    const basis = [d.offeneLieferscheine, d.offeneAuftraege];
    const total = basis.every(v => typeof v === "number")
      ? basis[0] + basis[1] + (d.postAlsOffen ? (post || 0) : 0)
      : null;
    wt.textContent = total === null ? "n/v" : zahl.format(total);
    stand.textContent = "Stand " + uhr.format(new Date(d.stand));
    meldung.textContent = [d.quelle, d.hinweis, d.cached ? "aus Cache" : ""].filter(Boolean).join(" \u00b7 ");
    meldung.className = "";
  }catch(e){
    meldung.textContent = e.message;
    meldung.className = "fehler";
  }finally{
    document.querySelectorAll(".karte").forEach(k => k.setAttribute("aria-busy","false"));
  }
}

neu.addEventListener("click", () => laden(true));
laden(false);
setInterval(() => laden(false), 300000);
</script>
</body>
</html>`;

app.listen(PORT, () => console.log(`Versand-KPI läuft auf Port ${PORT}`));
