# Home Dashboard

A full-screen wall display for a Raspberry Pi: clock and weather, today's
Google Calendar, medications with a **Mark taken** button, upcoming bills,
market prices, top headlines, and a voice assistant that answers questions and
speaks medication reminders.

Bills and medications come from **Ugenda** once it's connected. Until then
they're read from Google Calendar: any event with *med, pill, dose, vitamin*
in the title counts as a medication, and any with *bill, pay, due, rent,
mortgage, insurance* counts as a bill.

Everything runs on the Pi itself. Weather (Open-Meteo), news (Google News) and
stock prices (Stooq, delayed about 15 minutes) need no accounts or API keys.

---

## What you need

- A Raspberry Pi 4 or 5 with Raspberry Pi OS (64-bit, with desktop)
- A monitor with HDMI
- Optional: a USB microphone and speaker for the voice assistant

## 1. Install on the Pi

Open **Terminal** on the Pi and run:

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# The dashboard
cd ~
git clone https://github.com/melissacallis/homedashboard.git
cd homedashboard
npm install
cp .env.example .env
```

## 2. Connect Google Calendar (one time)

1. Go to <https://console.cloud.google.com/>, create a project, and enable the
   **Google Calendar API** (APIs & Services → Library).
2. Set up the **OAuth consent screen** (External is fine) and add your own
   Google account under **Test users**.
3. APIs & Services → Credentials → **Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URI: `http://localhost:3000/oauth2callback`
4. Put the Client ID and Client Secret into `.env`:
   ```bash
   nano .env
   ```
5. Start the dashboard with `npm start`, then open
   **http://localhost:3000/auth** in the Pi's browser and sign in.

The connection is saved in `data/google-token.json`, so you only do this once.
The dashboard only asks for **read-only** calendar access.

## 3. Optional settings in `.env`

| Setting | What it does |
| --- | --- |
| `WEATHER_LAT`, `WEATHER_LON` | Shows weather for your location |
| `STOCK_SYMBOLS` | Which prices to show, e.g. `^SPX,^NDQ,AAPL,MSFT` |
| `NEWS_TOPIC` | Headlines about one topic instead of top stories |
| `UGENDA_URL`, `UGENDA_TOKEN` | Reads bills and medications from Ugenda (step 5) |

Restart after changing `.env` (`sudo systemctl restart home-dashboard` once step 4 is done).

## 4. Start automatically, full screen

**Run the server on boot:**

```bash
sudo tee /etc/systemd/system/home-dashboard.service > /dev/null << EOF
[Unit]
Description=Home Dashboard
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$HOME/homedashboard
ExecStart=/usr/bin/node server.js
Restart=always
User=$USER

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now home-dashboard
```

**Open it full screen when the desktop starts.** Current Raspberry Pi OS uses
the *labwc* desktop:

```bash
mkdir -p ~/.config/labwc
echo 'chromium --kiosk --noerrdialogs --disable-infobars --autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream http://localhost:3000 &' >> ~/.config/labwc/autostart
```

On an older Pi OS with the X11 desktop, put this line in
`~/.config/lxsession/LXDE-pi/autostart` instead:

```
@chromium-browser --kiosk --noerrdialogs --disable-infobars --autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream http://localhost:3000
```

Also turn off screen blanking: `sudo raspi-config` → **Display Options → Screen Blanking → No**.
Reboot, and the Pi starts straight into the dashboard.

- `--use-fake-ui-for-media-stream` lets the microphone work without a permission pop-up.
- The screen dims itself from 11 PM to 6 AM, and the page reloads once a night.
- To exit kiosk mode, plug in a keyboard and press **Alt+F4**.

## 5. Connect Ugenda

In Ugenda, create a dashboard key, then add to `.env`:

```
UGENDA_URL=https://ugenda.me
UGENDA_TOKEN=the-key-from-ugenda
```

The dashboard calls two Ugenda endpoints:

```
GET  /api/v1/dashboard                  (Authorization: Bearer <token>)
→ { "bills":     [{ "id", "name", "amount", "due": "YYYY-MM-DD", "status": "due"|"paid" }],
    "reminders": [{ "id", "title", "time": ISO-8601, "category": "medication", "done": bool }] }

POST /api/v1/reminders/{id}/done        (Authorization: Bearer <token>)
```

## Voice assistant

Tap **Ask me something** and ask things like *"What bills are due?"*,
*"Did I take my meds?"*, *"What's on tomorrow?"*, *"How's the market?"* or
*"What's the weather?"*. It also speaks medication reminders 30 minutes before
and at the time each one is due. Voice needs Chromium and a microphone.

## Running it somewhere other than the Pi

The Pi is the recommended home for this, because it only listens to the Pi
itself (`127.0.0.1`) and your medication data never leaves your house. If you
host it online instead (Railway, Heroku and so on), **set `DASHBOARD_PASSWORD`**
so strangers can't see your calendar and medications, set `HOST=0.0.0.0`, and
set `GOOGLE_REDIRECT_URI` to `https://your-address/oauth2callback`.

## Troubleshooting

- **See what the server is doing:** `journalctl -u home-dashboard -f`
- **Check what's connected:** open `http://localhost:3000/api/status`
- **Calendar stopped working after a week:** Google expires sign-ins for apps
  left in "Testing" mode after 7 days. Publish the app on the OAuth consent
  screen (it can stay unverified for personal use), then visit `/auth` again.
