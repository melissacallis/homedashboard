// ---------- Clock ----------
function tickClock() {
  const now = new Date();
  document.getElementById('clock').textContent =
    now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  document.getElementById('date').textContent =
    now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}
setInterval(tickClock, 1000);
tickClock();

// ---------- Helpers ----------
function fmtTime(iso, allDay) {
  if (allDay) return 'All day';
  return new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function renderList(el, items, emptyText) {
  if (!items.length) {
    el.innerHTML = `<li class="muted">${emptyText}</li>`;
    return;
  }
  el.innerHTML = items.map(html => `<li>${html}</li>`).join('');
}

// ---------- Calendar / Bills / Meds ----------
let lastAnnouncedIds = new Set();

async function loadCalendar() {
  try {
    const res = await fetch('/api/calendar?days=60');
    const data = await res.json();
    if (data.error) {
      const msg = res.status === 401
        ? 'Not connected — visit /auth on the server to link Google Calendar.'
        : `Error loading calendar: ${data.error}`;
      renderList(document.getElementById('bills-list'), [], msg);
      renderList(document.getElementById('meds-list'), [], msg);
      renderList(document.getElementById('calendar-list'), [], msg);
      return;
    }
    const events = data.events;
    console.log(`Loaded ${events.length} calendar events`, events);
    const bills = events.filter(e => e.category === 'bill');
    const meds = events.filter(e => e.category === 'medication');
    const general = events.filter(e => e.category === 'general');

    renderList(document.getElementById('bills-list'), bills.map(e =>
      `<div class="tag-bill"><div class="event-title">${e.title}</div><div class="event-time">📅 ${fmtTime(e.start, e.allDay)}</div></div>`
    ), 'No upcoming bills 🎉');

    renderList(document.getElementById('meds-list'), meds.map(e =>
      `<div class="tag-medication"><div class="event-title">${e.title}</div><div class="event-time">📅 ${fmtTime(e.start, e.allDay)}</div></div>`
    ), 'No medication reminders');

    renderMonthGrid(events);

    checkProactiveReminders(events);
  } catch (err) {
    console.error('Calendar load failed', err);
  }
}

// ---------- Month grid rendering ----------
let calViewDate = new Date(); // month currently displayed
let lastEventsForGrid = [];

function renderMonthGrid(events) {
  lastEventsForGrid = events;
  const grid = document.getElementById('calendar-grid');
  const label = document.getElementById('cal-month-label');
  const year = calViewDate.getFullYear();
  const month = calViewDate.getMonth();

  label.textContent = calViewDate.toLocaleDateString([], { month: 'long', year: 'numeric' });

  // Map events by yyyy-mm-dd (local date) for fast lookup
  const eventsByDay = {};
  events.forEach(e => {
    const d = new Date(e.start);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    (eventsByDay[key] = eventsByDay[key] || []).push(e);
  });

  const firstOfMonth = new Date(year, month, 1);
  const startDow = firstOfMonth.getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();
  const today = new Date();

  let html = '';
  ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d => html += `<div class="cal-dow">${d}</div>`);

  const totalCells = Math.ceil((startDow + daysInMonth) / 7) * 7;
  for (let i = 0; i < totalCells; i++) {
    const dayNum = i - startDow + 1;
    let cellDate, otherMonth = false;
    if (dayNum < 1) {
      cellDate = new Date(year, month - 1, daysInPrevMonth + dayNum);
      otherMonth = true;
    } else if (dayNum > daysInMonth) {
      cellDate = new Date(year, month + 1, dayNum - daysInMonth);
      otherMonth = true;
    } else {
      cellDate = new Date(year, month, dayNum);
    }
    const key = `${cellDate.getFullYear()}-${cellDate.getMonth()}-${cellDate.getDate()}`;
    const isToday = cellDate.toDateString() === today.toDateString();
    const dayEvents = (eventsByDay[key] || []).sort((a, b) => new Date(a.start) - new Date(b.start));
    const shown = dayEvents.slice(0, 3);
    const extra = dayEvents.length - shown.length;

    html += `<div class="cal-day${otherMonth ? ' other-month' : ''}${isToday ? ' today' : ''}">
      <div class="cal-daynum">${cellDate.getDate()}</div>
      ${shown.map(e => `<div class="cal-event ${e.category}" title="${e.title}">${e.title}</div>`).join('')}
      ${extra > 0 ? `<div class="cal-more">+${extra} more</div>` : ''}
    </div>`;
  }
  grid.innerHTML = html;
}

document.getElementById('cal-prev').addEventListener('click', () => {
  calViewDate = new Date(calViewDate.getFullYear(), calViewDate.getMonth() - 1, 1);
  renderMonthGrid(lastEventsForGrid);
});
document.getElementById('cal-next').addEventListener('click', () => {
  calViewDate = new Date(calViewDate.getFullYear(), calViewDate.getMonth() + 1, 1);
  renderMonthGrid(lastEventsForGrid);
});

// Speak reminders for anything starting within the next 30 minutes, once each
function checkProactiveReminders(events) {
  const now = Date.now();
  events.forEach(e => {
    if (e.allDay || lastAnnouncedIds.has(e.id)) return;
    const start = new Date(e.start).getTime();
    const diffMin = (start - now) / 60000;
    if (diffMin >= 0 && diffMin <= 30 && (e.category === 'medication' || e.category === 'bill')) {
      const phrase = e.category === 'medication'
        ? `Reminder: ${e.title} is coming up.`
        : `Heads up: ${e.title} is due soon.`;
      speak(phrase);
      lastAnnouncedIds.add(e.id);
    }
  });
}

// ---------- News ----------
async function loadNews() {
  try {
    const res = await fetch('/api/news');
    const data = await res.json();
    const headlines = data.headlines || [];
    if (!headlines.length) {
      document.getElementById('news-track').innerHTML = '<span class="muted">No headlines available</span>';
      return;
    }
    const cardHtml = h => `
      <div class="news-item">
        <img src="${h.image}" alt="" loading="lazy" onerror="this.style.display='none'">
        <div class="news-caption">${h.title}</div>
      </div>`;
    // Duplicate the list once so the CSS marquee (-50%) loops seamlessly
    const html = headlines.map(cardHtml).join('') + headlines.map(cardHtml).join('');
    document.getElementById('news-track').innerHTML = html;
  } catch (err) {
    console.error('News load failed', err);
  }
}

// ---------- Stocks ----------
async function loadStocks() {
  try {
    const res = await fetch('/api/stocks?symbols=AAPL,MSFT,GOOGL,SPY');
    const data = await res.json();
    renderList(document.getElementById('stocks-list'), (data.stocks || []).map(s => {
      const up = parseFloat(s.close) >= parseFloat(s.open);
      return `<span class="stock-row"><span>${s.symbol}</span><span class="${up ? 'stock-up' : 'stock-down'}">$${s.close}</span></span>`;
    }), 'No stock data');
  } catch (err) {
    console.error('Stocks load failed', err);
  }
}

// ---------- Voice Assistant (Web Speech API - Chrome/Chromium only) ----------
const bubble = document.getElementById('assistant-bubble');
const micBtn = document.getElementById('mic-btn');
let recognition;
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function speak(text) {
  showBubble(text);
  if (!window.speechSynthesis) return;
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.0;
  window.speechSynthesis.speak(utter);
}

function showBubble(text) {
  bubble.textContent = text;
  bubble.classList.remove('hidden');
  clearTimeout(showBubble._t);
  showBubble._t = setTimeout(() => bubble.classList.add('hidden'), 6000);
}

function handleCommand(transcript) {
  const t = transcript.toLowerCase();
  if (t.includes('bill')) {
    const items = [...document.querySelectorAll('#bills-list .event-title')].map(e => e.textContent);
    speak(items.length ? `Your upcoming bills: ${items.join(', ')}` : 'You have no upcoming bills.');
  } else if (t.includes('medic') || t.includes('pill') || t.includes('med')) {
    const items = [...document.querySelectorAll('#meds-list .event-title')].map(e => e.textContent);
    speak(items.length ? `Your medication reminders: ${items.join(', ')}` : 'No medication reminders right now.');
  } else if (t.includes('news') || t.includes('headline')) {
    const items = [...document.querySelectorAll('#news-track .news-caption')].map(e => e.textContent).slice(0, 3);
    speak(items.length ? `Top headlines: ${items.join('. ')}` : 'No news available.');
  } else if (t.includes('stock') || t.includes('market')) {
    const items = [...document.querySelectorAll('#stocks-list')].map(e => e.textContent);
    speak(items.length ? items[0] : 'No stock data available.');
  } else if (t.includes('calendar') || t.includes('schedule') || t.includes('today')) {
    const upcoming = [...lastEventsForGrid]
      .filter(e => new Date(e.start) >= new Date())
      .sort((a, b) => new Date(a.start) - new Date(b.start))
      .slice(0, 5)
      .map(e => e.title);
    speak(upcoming.length ? `Coming up: ${upcoming.join(', ')}` : 'Nothing on your calendar.');
  } else if (t.includes('time')) {
    speak(`It's ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  } else {
    speak("I can tell you about your bills, medications, calendar, news, or stocks. Just ask.");
  }
}

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.lang = 'en-US';
  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    handleCommand(transcript);
  };
  recognition.onend = () => micBtn.classList.remove('listening');
  recognition.onerror = () => micBtn.classList.remove('listening');

  micBtn.addEventListener('click', () => {
    micBtn.classList.add('listening');
    recognition.start();
  });
} else {
  micBtn.title = 'Voice not supported in this browser (use Chrome/Chromium)';
  micBtn.style.opacity = 0.4;
}

// ---------- Init & polling ----------
loadCalendar();
loadNews();
loadStocks();
setInterval(loadCalendar, 60 * 1000);     // every minute (also drives reminders)
setInterval(loadNews, 10 * 60 * 1000);    // every 10 min
setInterval(loadStocks, 5 * 60 * 1000);   // every 5 min