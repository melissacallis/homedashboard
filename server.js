// Home Dashboard Server
// Handles: Google Calendar (OAuth2), News RSS, Stock quotes
// Run: node server.js   (see README.md for setup)

const express = require('express');
const path = require('path');
const { google } = require('googleapis');
const Parser = require('rss-parser');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const rssParser = new Parser();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---------- Google Calendar OAuth2 ----------
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth2callback'
);

// Step 1: visit this to grant access the first time
app.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
  res.redirect(url);
});

// Step 2: Google redirects here with a code; we exchange it for tokens
app.get('/oauth2callback', async (req, res) => {
  if (req.query.error) {
    console.error('Google returned an OAuth error:', req.query.error);
    return res.status(400).send(`Google returned an error: ${req.query.error}. This usually means the consent screen was cancelled, or your Google account needs to be added as a test user in the OAuth consent screen settings (if the app is still in "Testing" mode).`);
  }
  if (!req.query.code) {
    console.error('No code param on /oauth2callback. Full query:', req.query);
    return res.status(400).send('No authorization code received from Google. Try visiting /auth again from scratch (not a reloaded/bookmarked link).');
  }
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    oauth2Client.setCredentials(tokens);
    console.log('\n=== SAVE THIS REFRESH TOKEN IN YOUR .env FILE ===');
    console.log('GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token);
    console.log('==================================================\n');
    res.send('Authorized! Copy the refresh token printed in your server terminal into .env, then restart the server. You can close this tab.');
  } catch (err) {
    console.error(err);
    res.status(500).send('Auth failed, check server logs.');
  }
});

if (process.env.GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
}

// Returns upcoming events for the next N days (default 14)
app.get('/api/calendar', async (req, res) => {
  try {
    if (!process.env.GOOGLE_REFRESH_TOKEN) {
      return res.status(401).json({ error: 'Not authorized yet. Visit /auth first.' });
    }
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const days = parseInt(req.query.days || '60', 10);
    const timeMin = new Date();
    const timeMax = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const result = await calendar.events.list({
      calendarId: 'primary',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100,
    });

    const events = (result.data.items || []).map(e => ({
      id: e.id,
      title: e.summary || '(no title)',
      start: e.start.dateTime || e.start.date,
      allDay: !e.start.dateTime,
      description: e.description || '',
      // Simple tagging: label as medication/bill if keywords appear in title
      category: /med|pill|dose|rx/i.test(e.summary || '') ? 'medication'
              : /bill|pay|due|invoice|rent|mortgage|utilit/i.test(e.summary || '') ? 'bill'
              : 'general',
    }));

    // Merge in US holidays from Google's public holiday calendar
    let holidays = [];
    try {
      const holidayResult = await calendar.events.list({
        calendarId: 'en.usa#holiday@group.v.calendar.google.com',
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 50,
      });
      holidays = (holidayResult.data.items || []).map(e => ({
        id: 'holiday-' + e.id,
        title: e.summary || 'Holiday',
        start: e.start.dateTime || e.start.date,
        allDay: !e.start.dateTime,
        description: e.description || '',
        category: 'holiday',
      }));
    } catch (holidayErr) {
      console.error('Failed to fetch holidays (non-fatal):', holidayErr.message);
    }

    res.json({ events: [...events, ...holidays] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch calendar events' });
  }
});

// ---------- News headlines (Google News RSS, no API key needed) ----------
// Google News RSS doesn't include real article images, so we fetch each
// article page and pull its og:image meta tag. Falls back to null (frontend
// hides broken/missing images) if a page can't be scraped or has none.
async function getOgImage(url) {
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HomeDashboard/1.0)' },
    });
    if (!r.ok) return null;
    const html = await r.text();
    const $ = cheerio.load(html);
    return (
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      null
    );
  } catch (err) {
    return null;
  }
}

app.get('/api/news', async (req, res) => {
  try {
    const feedUrl = `https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en`;
    const feed = await rssParser.parseURL(feedUrl);
    const items = feed.items.slice(0, 12);

    const headlines = await Promise.all(items.map(async i => ({
      title: i.title,
      link: i.link,
      pubDate: i.pubDate,
      source: i.creator || (i.title.split(' - ').pop()),
      image: await getOgImage(i.link),
    })));

    res.json({ headlines });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

// ---------- Stocks (Stooq, free, no key needed) ----------
// Stooq requires a market suffix on tickers (e.g. "aapl.us"), otherwise it
// returns "N/D" for every field. We add the suffix and skip any symbol that
// still comes back with no data instead of showing garbage rows.
app.get('/api/stocks', async (req, res) => {
  try {
    const symbols = (req.query.symbols || 'AAPL,MSFT,GOOGL,SPY')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    const results = [];
    for (const sym of symbols) {
      const stooqSym = `${sym.toLowerCase()}.us`;
      const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSym)}&f=sd2t2ohlcv&h&e=csv`;
      const r = await fetch(url);
      const csv = await r.text();
      const lines = csv.trim().split('\n');
      if (lines.length < 2) continue;

      const cols = lines[0].split(',');
      const vals = lines[1].split(',');
      const obj = {};
      cols.forEach((c, idx) => obj[c] = vals[idx]);

      if (!obj.Close || obj.Close === 'N/D') {
        console.warn(`No data for symbol ${sym} (tried ${stooqSym})`);
        continue;
      }

      results.push({
        symbol: sym.toUpperCase(),
        close: obj.Close,
        open: obj.Open,
        high: obj.High,
        low: obj.Low,
        date: obj.Date,
      });
    }
    res.json({ stocks: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch stocks' });
  }
});

app.listen(PORT, () => {
  console.log(`Home dashboard running at http://localhost:${PORT}`);
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    console.log(`No Google refresh token found. Visit http://localhost:${PORT}/auth to authorize.`);
  }
});