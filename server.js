// Home Dashboard server
// Serves the wall display and the data behind it:
//   Google Calendar (OAuth2), bills + medications (Ugenda, or Google Calendar
//   until Ugenda is connected), weather (Open-Meteo), news (Google News RSS),
//   and stock quotes (Stooq).
// Run: node server.js   (setup steps are in README.md)

const express = require('express');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
// On the Pi, only the Pi itself can open the dashboard unless HOST=0.0.0.0.
// Hosting platforms set PORT and need to listen on every interface.
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Optional password (use it whenever the dashboard is on the internet) ----------
if (process.env.DASHBOARD_PASSWORD) {
  app.use((req, res, next) => {
    if (req.path === '/oauth2callback') return next();
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    const pass = scheme === 'Basic' && encoded
      ? Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':')
      : null;
    if (pass === process.env.DASHBOARD_PASSWORD) return next();
    res.set('WWW-Authenticate', 'Basic realm="Home Dashboard"').status(401).send('Password required');
  });
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---------- Small helpers ----------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch { return fallback; }
}
function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2), { mode: 0o600 });
}

// Cache each upstream call so a refresh storm never hammers the free APIs.
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function fetchWithTimeout(url, options = {}, ms = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...options, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

function localDateKey(d, timeZone) {
  // yyyy-mm-dd in the dashboard's time zone
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
const TZ = process.env.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

// ---------- Google Calendar OAuth2 ----------
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/oauth2callback`
);

function savedRefreshToken() {
  return process.env.GOOGLE_REFRESH_TOKEN || readJson('google-token.json', {}).refresh_token || null;
}
if (savedRefreshToken()) oauth2Client.setCredentials({ refresh_token: savedRefreshToken() });

// Step 1: open /auth once in a browser to grant read-only calendar access
app.get('/auth', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).send('Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env first (see README).');
  }
  res.redirect(oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar.readonly'],
  }));
});

// Step 2: Google sends you back here; the token is saved so it survives restarts
app.get('/oauth2callback', async (req, res) => {
  if (req.query.error) {
    return res.status(400).send(`Google returned an error: ${req.query.error}. If the app is in "Testing" mode, add your Google account as a test user on the OAuth consent screen.`);
  }
  if (!req.query.code) {
    return res.status(400).send('No authorization code received. Start again from /auth.');
  }
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    oauth2Client.setCredentials(tokens);
    if (tokens.refresh_token) writeJson('google-token.json', { refresh_token: tokens.refresh_token });
    cache.delete('calendar');
    res.send('Google Calendar is connected. You can close this tab; the dashboard will pick it up within a minute.');
  } catch (err) {
    console.error('OAuth token exchange failed:', err.message);
    res.status(500).send('Connecting Google failed. Check the server log.');
  }
});

const MED_WORDS = /\b(med|meds|medication|pill|pills|dose|rx|vitamin|insulin|inhaler)\b/i;
const BILL_WORDS = /\b(bill|pay|payment|due|invoice|rent|mortgage|utility|utilities|insurance)\b/i;

async function getCalendarEvents(days = 14) {
  if (!savedRefreshToken()) {
    const err = new Error('Google Calendar is not connected yet. Open /auth on the dashboard server.');
    err.status = 401;
    throw err;
  }
  return cached('calendar', 60 * 1000, async () => {
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const timeMin = new Date();
    timeMin.setHours(0, 0, 0, 0);
    const timeMax = new Date(timeMin.getTime() + days * 86400000);
    const list = (calendarId, maxResults) => calendar.events.list({
      calendarId, timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(),
      singleEvents: true, orderBy: 'startTime', maxResults,
    });

    const main = await list('primary', 250);
    const events = (main.data.items || []).map(e => {
      const title = e.summary || '(no title)';
      return {
        id: e.id,
        title,
        start: e.start.dateTime || e.start.date,
        end: e.end ? (e.end.dateTime || e.end.date) : null,
        allDay: !e.start.dateTime,
        category: MED_WORDS.test(title) ? 'medication' : BILL_WORDS.test(title) ? 'bill' : 'general',
      };
    });

    let holidays = [];
    try {
      const h = await list('en.usa#holiday@group.v.calendar.google.com', 20);
      holidays = (h.data.items || []).map(e => ({
        id: 'holiday-' + e.id, title: e.summary || 'Holiday',
        start: e.start.dateTime || e.start.date, end: null, allDay: !e.start.dateTime, category: 'holiday',
      }));
    } catch (e) {
      console.warn('Holiday calendar unavailable (non-fatal):', e.message);
    }
    return [...events, ...holidays].sort((a, b) => new Date(a.start) - new Date(b.start));
  });
}

app.get('/api/calendar', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || '14', 10) || 14, 60);
    res.json({ events: await getCalendarEvents(days) });
  } catch (err) {
    if (err.status !== 401) console.error('Calendar failed:', err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not load the calendar' });
  }
});

// ---------- Bills + medications: Ugenda when connected, else Google Calendar ----------
const UGENDA_URL = (process.env.UGENDA_URL || '').replace(/\/+$/, '');
const UGENDA_TOKEN = process.env.UGENDA_TOKEN || '';
const ugendaOn = () => Boolean(UGENDA_URL && UGENDA_TOKEN);

// Doses marked taken on this dashboard when the data comes from Google Calendar
function takenToday() {
  const state = readJson('taken.json', {});
  return new Set(state[localDateKey(new Date(), TZ)] || []);
}
function markTaken(id) {
  const today = localDateKey(new Date(), TZ);
  const state = readJson('taken.json', {});
  const keep = { [today]: Array.from(new Set([...(state[today] || []), id])) };
  writeJson('taken.json', keep); // older days are dropped
}

async function getUgenda() {
  return cached('ugenda', 60 * 1000, async () => {
    const r = await fetchWithTimeout(`${UGENDA_URL}/api/v1/dashboard`, {
      headers: { Authorization: `Bearer ${UGENDA_TOKEN}`, Accept: 'application/json' },
    });
    if (r.status === 401 || r.status === 403) {
      const err = new Error('Ugenda key was rejected. Create a new dashboard key in Ugenda settings.');
      err.status = 502;
      throw err;
    }
    if (!r.ok) throw new Error(`Ugenda answered ${r.status}`);
    const data = await r.json();
    return {
      source: 'ugenda',
      bills: (data.bills || []).map(b => ({
        id: String(b.id), name: b.name, amount: b.amount ?? null, due: b.due, status: b.status || 'due',
      })),
      medications: (data.reminders || [])
        .filter(r => (r.category || '').toLowerCase() === 'medication')
        .map(r => ({ id: String(r.id), name: r.title, time: r.time, taken: Boolean(r.done) })),
    };
  });
}

async function getFromCalendar() {
  const events = await getCalendarEvents(45);
  const today = localDateKey(new Date(), TZ);
  const taken = takenToday();
  return {
    source: 'calendar',
    bills: events.filter(e => e.category === 'bill').map(e => ({
      id: e.id, name: e.title, amount: null, due: e.start.slice(0, 10), status: 'due',
    })),
    medications: events
      .filter(e => e.category === 'medication' && localDateKey(new Date(e.start), TZ) === today)
      .map(e => ({ id: e.id, name: e.title, time: e.allDay ? null : e.start, taken: taken.has(e.id) })),
  };
}

app.get('/api/household', async (req, res) => {
  try {
    res.json(ugendaOn() ? await getUgenda() : await getFromCalendar());
  } catch (err) {
    console.error('Bills/medications failed:', err.message);
    res.status(err.status === 401 ? 401 : 502).json({ error: err.message });
  }
});

app.post('/api/medications/:id/taken', async (req, res) => {
  const id = String(req.params.id).slice(0, 200);
  try {
    if (ugendaOn()) {
      const r = await fetchWithTimeout(`${UGENDA_URL}/api/v1/reminders/${encodeURIComponent(id)}/done`, {
        method: 'POST', headers: { Authorization: `Bearer ${UGENDA_TOKEN}` },
      });
      if (!r.ok) throw new Error(`Ugenda answered ${r.status}`);
      cache.delete('ugenda');
    } else {
      markTaken(id);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Mark taken failed:', err.message);
    res.status(502).json({ error: 'Could not save that. Try again.' });
  }
});

// ---------- Weather (Open-Meteo, free, no key) ----------
const WEATHER_CODES = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Cloudy', 45: 'Fog', 48: 'Fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow',
  80: 'Showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorms', 96: 'Thunderstorms', 99: 'Thunderstorms',
};

app.get('/api/weather', async (req, res) => {
  const { WEATHER_LAT: lat, WEATHER_LON: lon } = process.env;
  if (!lat || !lon) return res.json({ weather: null });
  try {
    const weather = await cached('weather', 15 * 60 * 1000, async () => {
      const unit = (process.env.WEATHER_UNIT || 'fahrenheit').toLowerCase() === 'celsius' ? 'celsius' : 'fahrenheit';
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}`
        + `&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min`
        + `&temperature_unit=${unit}&timezone=auto&forecast_days=1`;
      const r = await fetchWithTimeout(url);
      if (!r.ok) throw new Error(`Open-Meteo answered ${r.status}`);
      const d = await r.json();
      return {
        temp: Math.round(d.current.temperature_2m),
        high: Math.round(d.daily.temperature_2m_max[0]),
        low: Math.round(d.daily.temperature_2m_min[0]),
        summary: WEATHER_CODES[d.current.weather_code] || '',
        unit: unit === 'celsius' ? 'C' : 'F',
      };
    });
    res.json({ weather });
  } catch (err) {
    console.error('Weather failed:', err.message);
    res.status(502).json({ error: 'Could not load the weather' });
  }
});

// ---------- News (Google News RSS, free, no key) ----------
function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .trim();
}
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

app.get('/api/news', async (req, res) => {
  try {
    const headlines = await cached('news', 10 * 60 * 1000, async () => {
      const topic = process.env.NEWS_TOPIC;
      const url = topic
        ? `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-US&gl=US&ceid=US:en`
        : 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en';
      const r = await fetchWithTimeout(url, { headers: { 'User-Agent': 'HomeDashboard/2.0' } });
      if (!r.ok) throw new Error(`Google News answered ${r.status}`);
      const xml = await r.text();
      const items = xml.split(/<item>/i).slice(1).map(chunk => {
        const source = tag(chunk, 'source');
        let title = tag(chunk, 'title');
        if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
        return { title, source, pubDate: tag(chunk, 'pubDate'), link: tag(chunk, 'link') };
      });
      return items.filter(i => i.title).slice(0, 8);
    });
    res.json({ headlines });
  } catch (err) {
    console.error('News failed:', err.message);
    res.status(502).json({ error: 'Could not load headlines' });
  }
});

// ---------- Stocks (Stooq, free, no key; prices can be delayed ~15 min) ----------
// Plain tickers get Stooq's ".us" suffix; index codes like ^SPX are passed as-is.
const STOCK_LABELS = { '^SPX': 'S&P 500', '^NDQ': 'Nasdaq', '^DJI': 'Dow' };

app.get('/api/stocks', async (req, res) => {
  const symbols = (process.env.STOCK_SYMBOLS || '^SPX,^NDQ,AAPL,MSFT')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 8);
  try {
    const stocks = await cached('stocks', 2 * 60 * 1000, async () => {
      const rows = await Promise.all(symbols.map(async sym => {
        const stooq = sym.startsWith('^') || sym.includes('.') ? sym.toLowerCase() : `${sym.toLowerCase()}.us`;
        try {
          const r = await fetchWithTimeout(`https://stooq.com/q/l/?s=${encodeURIComponent(stooq)}&f=sd2t2ohlcv&h&e=csv`);
          const [head, row] = (await r.text()).trim().split('\n');
          if (!row) return null;
          const cols = head.split(',');
          const vals = row.split(',');
          const o = Object.fromEntries(cols.map((c, i) => [c.trim(), (vals[i] || '').trim()]));
          const close = parseFloat(o.Close);
          const open = parseFloat(o.Open);
          if (!Number.isFinite(close)) return null;
          const change = Number.isFinite(open) ? close - open : null;
          return {
            symbol: sym, label: STOCK_LABELS[sym] || sym, price: close,
            change, changePct: change !== null && open ? (change / open) * 100 : null, date: o.Date,
          };
        } catch (e) {
          console.warn(`Stock ${sym} failed:`, e.message);
          return null;
        }
      }));
      return rows.filter(Boolean);
    });
    res.json({ stocks });
  } catch (err) {
    console.error('Stocks failed:', err.message);
    res.status(502).json({ error: 'Could not load stock prices' });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    calendar: Boolean(savedRefreshToken()),
    ugenda: ugendaOn(),
    weather: Boolean(process.env.WEATHER_LAT && process.env.WEATHER_LON),
    timezone: TZ,
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Home dashboard running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!savedRefreshToken()) console.log(`Google Calendar not connected yet: open http://localhost:${PORT}/auth`);
  console.log(ugendaOn() ? `Bills and medications: Ugenda (${UGENDA_URL})` : 'Bills and medications: Google Calendar (Ugenda not connected)');
});
