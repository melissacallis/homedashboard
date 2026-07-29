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
      `<span class="tag-bill"><span class="event-title">${e.title}</span><span class="event-time">${fmtTime(e.start, e.allDay)}</span></span>`
    ), 'No upcoming bills 🎉');

    renderList(document.getElementById('meds-list'), meds.map(e =>
      `<span class="tag-medication"><span class="event-title">${e.title}</span><span class="event-time">${fmtTime(e.start, e.allDay)}</span></span>`
    ), 'No medication reminders');

    renderList(document.getElementById('calendar-list'), general.slice(0, 30).map(e =>
      `<span class="tag-general"><span class="event-title">${e.title}</span><span class="event-time">${fmtTime(e.start, e.allDay)}</span></span>`
    ), events.length === 0 ? 'No events found in the next 60 days on your primary calendar.' : 'Nothing else upcoming');

    checkProactiveReminders(events);
  } catch (err) {
    console.error('Calendar load failed', err);
  }
}

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
    renderList(document.getElementById('news-list'), (data.headlines || []).map(h =>
      `<span class="event-title">${h.title}</span>`
    ), 'No headlines available');
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
    const items = [...document.querySelectorAll('#news-list .event-title')].map(e => e.textContent).slice(0, 3);
    speak(items.length ? `Top headlines: ${items.join('. ')}` : 'No news available.');
  } else if (t.includes('stock') || t.includes('market')) {
    const items = [...document.querySelectorAll('#stocks-list')].map(e => e.textContent);
    speak(items.length ? items[0] : 'No stock data available.');
  } else if (t.includes('calendar') || t.includes('schedule') || t.includes('today')) {
    const items = [...document.querySelectorAll('#calendar-list .event-title')].map(e => e.textContent).slice(0, 5);
    speak(items.length ? `Coming up: ${items.join(', ')}` : 'Nothing on your calendar.');
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