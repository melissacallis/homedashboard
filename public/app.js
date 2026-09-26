// Home Dashboard wall display
// Everything is built with textContent (never innerHTML), so a calendar event
// or headline can't inject markup into the page.

const state = { events: [], household: null, stocks: [], news: [], announced: new Set() };

// ---------- DOM helpers ----------
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}
const $ = id => document.getElementById(id);
function fill(target, nodes) { target.replaceChildren(...nodes); }
function message(text, extra) { return el('li', { class: 'notice' }, text, extra || null); }
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>';
function checkIcon() { const s = el('span', { class: 'check', 'aria-hidden': 'true' }); s.innerHTML = CHECK_SVG; return s; }

// ---------- Dates ----------
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function parseDay(s) { // "2026-09-30" -> local midnight, not UTC
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}
function daysFromToday(d) { return Math.round((startOfDay(d) - startOfDay(new Date())) / 86400000); }
function fmtTime(d) { return new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function fmtShortDate(d) { return d.toLocaleDateString([], { month: 'short', day: 'numeric' }); }
function money(n) { return n == null ? '' : '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function ago(dateStr) {
  const mins = Math.round((Date.now() - new Date(dateStr)) / 60000);
  if (!Number.isFinite(mins)) return '';
  if (mins < 60) return `${Math.max(mins, 1)} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} hr ago` : `${Math.round(h / 24)} d ago`;
}

async function getJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; throw e; }
  return data;
}

// ---------- Clock + night dimming ----------
function tick() {
  const now = new Date();
  const parts = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).split(' ');
  $('clock').textContent = parts[0];
  $('ampm').textContent = parts[1] || '';
  $('date').textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const h = now.getHours();
  document.body.classList.toggle('night', h >= 23 || h < 6);
}

// Show the pointer only while the mouse is moving
let pointerTimer;
document.addEventListener('mousemove', () => {
  document.body.classList.add('pointer');
  clearTimeout(pointerTimer);
  pointerTimer = setTimeout(() => document.body.classList.remove('pointer'), 3000);
});

// ---------- Weather ----------
async function loadWeather() {
  try {
    const { weather: w } = await getJson('/api/weather');
    $('weather').textContent = w ? `${w.temp}°${w.unit} ${w.summary} · High ${w.high}° / Low ${w.low}°` : '';
  } catch { $('weather').textContent = ''; }
}

// ---------- Today (Google Calendar) ----------
async function loadCalendar() {
  const list = $('today-list');
  try {
    const { events } = await getJson('/api/calendar?days=14');
    state.events = events;
    const general = events.filter(e => e.category === 'general' || e.category === 'holiday');
    const onDay = n => general.filter(e => daysFromToday(e.allDay ? parseDay(e.start) : new Date(e.start)) === n);
    const now = Date.now();
    const today = onDay(0).filter(e => e.allDay || !e.end || new Date(e.end) > now);
    const tomorrow = onDay(1);
    const row = e => el('li', {},
      el('span', { class: 'time' }, e.allDay ? 'All day' : fmtTime(e.start)),
      el('span', { class: 'name' }, e.title));
    const nodes = today.length ? today.slice(0, 5).map(row) : [el('li', { class: 'muted' }, 'Nothing else on the calendar today')];
    if (tomorrow.length) nodes.push(el('li', { class: 'sub' }, 'Tomorrow'), ...tomorrow.slice(0, 3).map(row));
    fill(list, nodes);
  } catch (err) {
    fill(list, [err.status === 401
      ? message('Google Calendar isn’t connected yet. On the Pi, open ', el('code', {}, 'localhost:3000/auth'))
      : message('Couldn’t reach Google Calendar. Retrying every minute.')]);
  }
}

// ---------- Bills + medications (Ugenda, or Google Calendar until Ugenda is linked) ----------
async function loadHousehold() {
  try {
    state.household = await getJson('/api/household');
    renderBills();
    renderMeds();
  } catch (err) {
    const text = err.status === 401
      ? 'Waiting for Google Calendar to be connected.'
      : `${err.message}. Retrying every minute.`;
    fill($('bills-list'), [message(text)]);
    fill($('meds-list'), [message(text)]);
  }
  updateAssistant();
}

function renderBills() {
  const { bills, source } = state.household;
  $('bills-source').textContent = source === 'ugenda' ? 'From Ugenda · next 30 days' : 'From Google Calendar · next 30 days';
  const upcoming = bills
    .map(b => ({ ...b, dueDate: parseDay(b.due) }))
    .filter(b => daysFromToday(b.dueDate) <= 30 && (b.status !== 'paid' || daysFromToday(b.dueDate) >= -7))
    .sort((a, b) => (a.status === 'paid') - (b.status === 'paid') || a.dueDate - b.dueDate);

  // Totals only make sense when amounts are known (Ugenda sends them)
  const withAmounts = upcoming.filter(b => b.amount != null && b.status !== 'paid');
  const sum = maxDays => withAmounts.filter(b => daysFromToday(b.dueDate) <= maxDays).reduce((t, b) => t + Number(b.amount), 0);
  $('bill-totals').hidden = withAmounts.length === 0;
  $('total-week').textContent = money(sum(7));
  $('total-month').textContent = money(sum(30));

  if (!upcoming.length) {
    fill($('bills-list'), [el('li', { class: 'muted' }, source === 'ugenda'
      ? 'No bills due in the next 30 days'
      : 'No bills in the next 30 days. Calendar events with “bill”, “pay” or “due” in the title show up here.')]);
    return;
  }
  fill($('bills-list'), upcoming.slice(0, 8).map(b => {
    const d = daysFromToday(b.dueDate);
    let label = fmtShortDate(b.dueDate), tone = 'later';
    if (b.status === 'paid') { label = 'Paid'; }
    else if (d < 0) { label = 'Overdue'; tone = 'soon'; }
    else if (d === 0) { label = 'Today'; tone = 'soon'; }
    else if (d === 1) { label = 'Tomorrow'; tone = 'soon'; }
    else if (d <= 7) { tone = 'near'; }
    return el('li', { class: b.status === 'paid' ? 'paid' : '' },
      el('span', { class: `badge ${tone}` }, label),
      el('span', { class: 'name' }, b.name),
      el('span', { class: 'amount' }, money(b.amount)));
  }));
}

function renderMeds() {
  const meds = [...state.household.medications].sort((a, b) =>
    (a.time ? new Date(a.time) : 0) - (b.time ? new Date(b.time) : 0));
  const taken = meds.filter(m => m.taken).length;
  $('meds-count').textContent = meds.length ? `${taken} of ${meds.length} taken` : '';
  if (!meds.length) {
    fill($('meds-list'), [el('li', { class: 'muted' }, state.household.source === 'ugenda'
      ? 'No medications scheduled today'
      : 'No medications today. Calendar events with “med”, “pill” or “dose” in the title show up here.')]);
    return;
  }
  const next = meds.find(m => !m.taken);
  fill($('meds-list'), meds.map(m => {
    const isNext = m === next;
    const cls = ['med', m.taken && 'taken', isNext && 'next'].filter(Boolean).join(' ');
    return el('li', { class: cls }, m.taken ? checkIcon() : el('span', { class: 'check', 'aria-hidden': 'true' }),
      el('span', { class: 'name' }, m.name),
      el('span', { class: 'time' }, m.time ? fmtTime(m.time) : 'Today'),
      isNext ? el('button', { class: 'take', type: 'button', onclick: e => takeMed(m, e.currentTarget) }, 'Mark taken') : null);
  }));
  checkMedReminders(meds);
}

async function takeMed(med, button) {
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    await getJson(`/api/medications/${encodeURIComponent(med.id)}/taken`, { method: 'POST' });
    await loadHousehold();
  } catch (err) {
    button.disabled = false;
    button.textContent = 'Mark taken';
    say(err.message, false);
  }
}

// Speak a medication reminder once when it's due (and 30 min before)
function checkMedReminders(meds) {
  const now = Date.now();
  for (const m of meds) {
    if (m.taken || !m.time) continue;
    const mins = (new Date(m.time) - now) / 60000;
    const key = `${m.id}:${mins <= 0 ? 'due' : 'soon'}`;
    if (mins <= 30 && mins > -60 && !state.announced.has(key)) {
      state.announced.add(key);
      say(mins <= 0 ? `It’s time for ${m.name}.` : `Reminder: ${m.name} at ${fmtTime(m.time)}.`, true);
    }
  }
}

// ---------- Markets ----------
async function loadStocks() {
  try {
    const { stocks } = await getJson('/api/stocks');
    state.stocks = stocks;
    if (!stocks.length) { fill($('stocks'), [el('div', { class: 'muted' }, 'No prices available right now')]); return; }
    fill($('stocks'), stocks.map(s => {
      const up = (s.change ?? 0) >= 0;
      const chg = s.changePct == null ? '' : `${up ? '▲' : '▼'} ${Math.abs(s.changePct).toFixed(2)}%`;
      return el('div', { class: 'stock' },
        el('span', { class: 'muted small' }, s.label),
        el('span', { class: 'price' }, s.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })),
        el('span', { class: `chg ${up ? 'up' : 'down'}` }, chg));
    }));
    $('markets-updated').textContent = `Today · updated ${fmtTime(new Date())}`;
  } catch {
    $('markets-updated').textContent = 'Prices unavailable, retrying';
  }
}

// ---------- Headlines ----------
async function loadNews() {
  try {
    const { headlines } = await getJson('/api/news');
    state.news = headlines;
    fill($('news-list'), headlines.slice(0, 3).map(h => el('li', {},
      el('span', { class: 'src' }, [h.source, ago(h.pubDate)].filter(Boolean).join(' · ')),
      el('span', { class: 'title' }, h.title))));
  } catch {
    if (!state.news.length) fill($('news-list'), [el('li', { class: 'muted' }, 'Headlines unavailable right now')]);
  }
}

// ---------- Assistant ----------
let pinnedUntil = 0; // a spoken answer stays on screen for a while
function say(text, speakIt = true) {
  $('assistant-text').textContent = text;
  pinnedUntil = Date.now() + 20000;
  if (speakIt && window.speechSynthesis) {
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }
}

function upcomingBills(maxDays) {
  return (state.household?.bills || [])
    .filter(b => b.status !== 'paid')
    .map(b => ({ ...b, d: daysFromToday(parseDay(b.due)) }))
    .filter(b => b.d >= 0 && b.d <= maxDays)
    .sort((a, b) => a.d - b.d);
}
function whenWord(d) { return d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`; }

function summary() {
  const parts = [];
  const bill = upcomingBills(3)[0];
  if (bill) parts.push(`${bill.name}${bill.amount != null ? ` (${money(bill.amount)})` : ''} is due ${whenWord(bill.d)}`);
  const med = (state.household?.medications || []).filter(m => !m.taken)
    .sort((a, b) => (a.time ? new Date(a.time) : 0) - (b.time ? new Date(b.time) : 0))[0];
  if (med) parts.push(med.time ? `your next medication is ${med.name} at ${fmtTime(med.time)}` : `you still have ${med.name} today`);
  if (!parts.length) return 'All caught up. Nothing due soon.';
  const s = parts.join(', and ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}
function updateAssistant() { if (Date.now() > pinnedUntil) $('assistant-text').textContent = summary(); }

function answer(q) {
  const t = q.toLowerCase();
  if (/bill|pay|owe|due/.test(t)) {
    const bills = upcomingBills(14);
    return bills.length
      ? 'Coming up: ' + bills.slice(0, 4).map(b => `${b.name}${b.amount != null ? ` for ${money(b.amount)}` : ''} ${whenWord(b.d)}`).join('; ') + '.'
      : 'No bills due in the next two weeks.';
  }
  if (/med|pill|dose|take/.test(t)) {
    const meds = state.household?.medications || [];
    const left = meds.filter(m => !m.taken);
    if (!meds.length) return 'You have no medications scheduled today.';
    return left.length
      ? `You’ve taken ${meds.length - left.length} of ${meds.length}. Still to take: ${left.map(m => m.time ? `${m.name} at ${fmtTime(m.time)}` : m.name).join(', ')}.`
      : 'Yes, you’ve taken all of today’s medications.';
  }
  if (/news|headline/.test(t)) {
    return state.news.length ? 'Top headlines: ' + state.news.slice(0, 3).map(h => h.title).join('. ') + '.' : 'Headlines aren’t available right now.';
  }
  if (/stock|market|price/.test(t)) {
    return state.stocks.length
      ? state.stocks.map(s => `${s.label} ${s.changePct == null ? 'at ' + s.price.toFixed(2) : (s.change >= 0 ? 'up ' : 'down ') + Math.abs(s.changePct).toFixed(1) + ' percent'}`).join(', ') + '.'
      : 'Stock prices aren’t available right now.';
  }
  if (/calendar|schedule|today|tomorrow|plan/.test(t)) {
    const n = /tomorrow/.test(t) ? 1 : 0;
    const evs = state.events.filter(e => e.category === 'general' &&
      daysFromToday(e.allDay ? parseDay(e.start) : new Date(e.start)) === n);
    return evs.length
      ? `${n ? 'Tomorrow' : 'Today'}: ` + evs.map(e => e.allDay ? e.title : `${e.title} at ${fmtTime(e.start)}`).join(', ') + '.'
      : `Nothing on the calendar ${n ? 'tomorrow' : 'today'}.`;
  }
  if (/weather|temperature|outside/.test(t)) return $('weather').textContent || 'Weather isn’t set up yet.';
  if (/time/.test(t)) return `It’s ${fmtTime(new Date())}.`;
  return 'I can tell you about your bills, medications, calendar, weather, news, or the markets.';
}

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const mic = $('mic-btn');
if (Recognition) {
  const rec = new Recognition();
  rec.lang = 'en-US';
  rec.interimResults = false;
  rec.onresult = e => say(answer(e.results[0][0].transcript));
  rec.onend = () => { mic.classList.remove('listening'); $('mic-label').textContent = 'Ask me something'; };
  rec.onerror = () => { mic.classList.remove('listening'); $('mic-label').textContent = 'Ask me something'; };
  mic.addEventListener('click', () => {
    mic.classList.add('listening');
    $('mic-label').textContent = 'Listening…';
    try { rec.start(); } catch { /* already listening */ }
  });
} else {
  mic.disabled = true;
  $('mic-label').textContent = 'Voice needs Chromium';
}

// ---------- Start + refresh ----------
tick();
setInterval(tick, 1000);
loadWeather(); loadCalendar(); loadHousehold(); loadStocks(); loadNews();
setInterval(loadCalendar, 60 * 1000);
setInterval(loadHousehold, 60 * 1000);
setInterval(updateAssistant, 30 * 1000);
setInterval(loadStocks, 2 * 60 * 1000);
setInterval(loadNews, 10 * 60 * 1000);
setInterval(loadWeather, 15 * 60 * 1000);
// Reload the page once a night so a long-running kiosk never goes stale
const loadedAt = Date.now();
setInterval(() => {
  if (new Date().getHours() === 4 && Date.now() - loadedAt > 2 * 3600 * 1000) location.reload();
}, 60 * 1000);
