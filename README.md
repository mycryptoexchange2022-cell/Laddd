# BTC Ladder Bot 🚀

A Polymarket BTC 15-minute window ladder trading bot with a live dashboard.

## How It Works

- Finds live BTC Up/Down 15-minute windows on Polymarket
- Runs **two independent ladders** (UP and DOWN) simultaneously
- Connects via WebSocket to Polymarket for real-time tick prices
- Automatically finds the next window when the current one ends
- Settles positions at window close and tracks P&L

## Trading Rules

| Rule | Detail |
|------|--------|
| Entry range | $0.55 – $0.90 |
| Buy more | +100 shares every $0.05 drop from entry |
| Sell all | When price rises $0.10 above avg entry |
| Re-entry | $0.05 below last sell price |
| Stop loss | Sell all if price drops below $0.46 |
| Window end | Auto-settle via Polymarket resolution |
| Demo capital | $2,000 starting balance |

---

## Deploy to Railway (Step-by-Step)

### Step 1: Create GitHub Repository

1. Go to [github.com](https://github.com) and sign in (or create free account)
2. Click the **+** button (top right) → **New repository**
3. Name it: `btc-ladder-bot`
4. Keep it **Public** or Private
5. Click **Create repository**

### Step 2: Upload Files

1. On your new repo page, click **uploading an existing file**
2. Drag and drop ALL files from this folder into the upload area:
   - `package.json`
   - `railway.toml`
   - `Procfile`
   - `.gitignore`
   - `src/` folder (with `server.js`, `bot.js`, `polymarket.js`)
   - `public/` folder (with `index.html`)
3. Click **Commit changes**

### Step 3: Deploy on Railway

1. Go to [railway.app](https://railway.app) and sign in with GitHub
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `btc-ladder-bot` repository
4. Railway will auto-detect Node.js and deploy
5. Wait ~2 minutes for deployment to complete
6. Click **Settings** → **Domains** → **Generate Domain**
7. Visit your live URL — the dashboard will open! 🎉

### That's it!

The bot will:
- Auto-start and search for the current BTC 15m window
- Connect to Polymarket live prices via WebSocket
- Run the ladder strategy automatically
- Show everything on the live dashboard

---

## Local Development

```bash
npm install
npm run dev
# Open http://localhost:3000
```

## Notes

- **Demo mode**: Bot uses $2,000 virtual capital — no real money
- **Simulation mode**: If Polymarket API is unreachable, bot simulates price data so you can see the strategy working
- **Auto-reconnect**: WebSocket reconnects automatically if disconnected
- The dashboard updates on every price tick (sub-second on WebSocket, ~2s on polling)
