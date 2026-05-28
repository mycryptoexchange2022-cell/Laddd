// ============================================================
//  BTC LADDER BOT — Express Server + Dashboard WebSocket
// ============================================================

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');

const {
  createLadder,
  processUpLadder,
  processDownLadder,
  settleWindow,
  avgEntry,
  DEMO_CAPITAL_START,
} = require('./bot');

const {
  findBtcWindows,
  getTokenPrices,
  getBestPrice,
  connectMarketWebSocket,
  checkResolution,
} = require('./polymarket');

// ============================================================
//  STATE
// ============================================================
let state = {
  capital: DEMO_CAPITAL_START,
  startCapital: DEMO_CAPITAL_START,
  totalPnl: 0,
  windowsTraded: 0,
  wins: 0,
  losses: 0,

  // Current window
  currentWindow: null,         // { slug, marketId, endsAt, tokens }
  nextWindow: null,
  upLadder: null,
  downLadder: null,
  upPrice: null,
  downPrice: null,
  upTokenId: null,
  downTokenId: null,
  windowStatus: 'searching',  // searching | active | settling | waiting
  windowHistory: [],
  tradeLog: [],
  priceHistory: { up: [], down: [] },
  lastPriceUpdate: null,
  botStatus: 'starting',
  wsConnected: false,
  errors: [],
};

let polyWs = null;
let windowCheckTimer = null;
let pricePollingTimer = null;
let dashboardClients = new Set();

// ============================================================
//  BROADCAST to dashboard
// ============================================================
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  for (const client of dashboardClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

function broadcastState() {
  broadcast('state', getPublicState());
}

function getPublicState() {
  return {
    capital: state.capital,
    startCapital: state.startCapital,
    floatingCapital: getFloatingCapital(),
    totalPnl: state.totalPnl,
    windowsTraded: state.windowsTraded,
    wins: state.wins,
    losses: state.losses,
    winRate: state.windowsTraded > 0 ? ((state.wins / state.windowsTraded) * 100).toFixed(1) : '0.0',
    currentWindow: state.currentWindow ? {
      slug: state.currentWindow.slug,
      marketId: state.currentWindow.marketId,
      endsAt: state.currentWindow.endsAt,
      timeLeft: Math.max(0, state.currentWindow.endsAt - Math.floor(Date.now() / 1000)),
    } : null,
    nextWindow: state.nextWindow ? {
      slug: state.nextWindow.slug,
      startsIn: Math.max(0, (state.currentWindow?.endsAt || 0) - Math.floor(Date.now() / 1000))
    } : null,
    upLadder: formatLadder(state.upLadder),
    downLadder: formatLadder(state.downLadder),
    upPrice: state.upPrice,
    downPrice: state.downPrice,
    windowStatus: state.windowStatus,
    windowHistory: state.windowHistory.slice(-20),
    tradeLog: state.tradeLog.slice(-50),
    priceHistory: {
      up: state.priceHistory.up.slice(-120),
      down: state.priceHistory.down.slice(-120),
    },
    lastPriceUpdate: state.lastPriceUpdate,
    botStatus: state.botStatus,
    wsConnected: state.wsConnected,
    errors: state.errors.slice(-5),
  };
}

function getFloatingCapital() {
  let floating = state.capital;
  if (state.upLadder && state.upPrice) {
    floating += state.upLadder.totalShares * state.upPrice;
  }
  if (state.downLadder && state.downPrice) {
    floating += state.downLadder.totalShares * state.downPrice;
  }
  return parseFloat(floating.toFixed(2));
}

function formatLadder(ladder) {
  if (!ladder) return null;
  return {
    side: ladder.side,
    positions: ladder.positions,
    totalShares: ladder.totalShares,
    totalCost: parseFloat(ladder.totalCost.toFixed(2)),
    avgEntry: parseFloat(avgEntry(ladder).toFixed(4)),
    lastSoldPrice: ladder.lastSoldPrice,
    active: ladder.active,
    unrealizedPnl: ladder.totalShares > 0 && state[ladder.side + 'Price']
      ? parseFloat((ladder.totalShares * state[ladder.side + 'Price'] - ladder.totalCost).toFixed(2))
      : 0,
  };
}

function addLog(msg, type = 'info') {
  const entry = { msg, type, ts: Date.now() };
  state.tradeLog.unshift(entry);
  if (state.tradeLog.length > 200) state.tradeLog.pop();
  broadcast('log', entry);
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

// ============================================================
//  WINDOW MANAGEMENT
// ============================================================
async function findAndStartWindow() {
  state.windowStatus = 'searching';
  state.botStatus = 'searching for window...';
  broadcastState();
  addLog('🔍 Searching for BTC 15m windows...', 'info');

  try {
    const windows = await findBtcWindows();
    const now = Math.floor(Date.now() / 1000);

    if (windows.length === 0) {
      addLog('⚠️ No windows found via API. Using simulated mode.', 'warn');
      startSimulatedWindow();
      return;
    }

    // Find active window (started but not ended)
    const active = windows.find(w => w.ts <= now && w.endsAt > now && !w.closed);
    const upcoming = windows.find(w => w.ts > now);

    if (active) {
      addLog(`✅ Found active window: ${active.slug}`, 'success');
      await startWindow(active, windows.find(w => w.ts === active.endsAt));
    } else if (upcoming) {
      const wait = upcoming.ts - now;
      addLog(`⏰ Next window starts in ${wait}s: ${upcoming.slug}`, 'info');
      state.windowStatus = 'waiting';
      state.nextWindow = upcoming;
      broadcastState();
      setTimeout(() => startWindow(upcoming), wait * 1000);
    } else {
      addLog('⚠️ No active window found. Retrying in 30s...', 'warn');
      setTimeout(findAndStartWindow, 30000);
    }
  } catch (err) {
    addLog(`❌ Window search error: ${err.message}`, 'error');
    state.errors.push({ msg: err.message, ts: Date.now() });
    setTimeout(findAndStartWindow, 15000);
  }
}

async function startWindow(window, nextWindowData) {
  addLog(`🚀 Starting window: ${window.slug}`, 'success');

  // Get token IDs (up = index 0, down = index 1 typically)
  const tokens = window.tokens || window.raw?.tokens || [];
  let upTokenId = null, downTokenId = null;

  for (const t of tokens) {
    const outcome = (t.outcome || '').toLowerCase();
    if (outcome.includes('up')) upTokenId = t.token_id || t.id;
    if (outcome.includes('down')) downTokenId = t.token_id || t.id;
  }

  // Fallback: use first two tokens
  if (!upTokenId && tokens[0]) upTokenId = tokens[0].token_id || tokens[0].id;
  if (!downTokenId && tokens[1]) downTokenId = tokens[1].token_id || tokens[1].id;

  state.currentWindow = window;
  state.nextWindow = nextWindowData || null;
  state.upTokenId = upTokenId;
  state.downTokenId = downTokenId;
  state.upLadder = createLadder('up');
  state.downLadder = createLadder('down');
  state.priceHistory = { up: [], down: [] };
  state.windowStatus = 'active';
  state.botStatus = 'trading';

  // Get initial prices
  if (upTokenId || downTokenId) {
    await refreshPrices();
    subscribeToWebSocket([upTokenId, downTokenId].filter(Boolean));
  } else {
    addLog('⚠️ No token IDs found — using simulated prices', 'warn');
    startPriceSimulation();
  }

  // Schedule window end
  const now = Math.floor(Date.now() / 1000);
  const timeLeft = Math.max(0, window.endsAt - now) * 1000;
  addLog(`⏱ Window ends in ${Math.floor(timeLeft / 1000)}s`, 'info');

  setTimeout(() => endWindow(window), timeLeft);
  broadcastState();
}

async function endWindow(window) {
  addLog(`🏁 Window ending: ${window.slug}`, 'info');
  state.windowStatus = 'settling';
  broadcastState();

  // Stop price feeds
  if (polyWs) {
    polyWs.close();
    polyWs = null;
  }
  if (pricePollingTimer) {
    clearInterval(pricePollingTimer);
    pricePollingTimer = null;
  }

  // Check resolution
  let resolution = null;
  if (window.marketId) {
    addLog('📊 Checking resolution...', 'info');
    let attempts = 0;
    while (attempts < 10 && !resolution) {
      const res = await checkResolution(window.marketId);
      if (res.resolved) {
        resolution = res.winner;
        addLog(`🎯 Resolution: ${resolution.toUpperCase()} wins!`, 'success');
      } else {
        await new Promise(r => setTimeout(r, 3000));
        attempts++;
      }
    }
  }

  if (!resolution) {
    // Simulate resolution based on price movement
    resolution = (state.upPrice || 0.5) >= 0.5 ? 'up' : 'down';
    addLog(`⚡ Using price-based resolution: ${resolution.toUpperCase()}`, 'warn');
  }

  // Settle positions
  const { results, capital: newCapital } = settleWindow(
    state.upLadder,
    state.downLadder,
    resolution,
    state.capital
  );

  const windowPnl = newCapital - state.capital;
  state.capital = newCapital;
  state.totalPnl += windowPnl;
  state.windowsTraded++;

  if (windowPnl >= 0) state.wins++;
  else state.losses++;

  for (const r of results) {
    addLog(r.msg, r.won ? 'success' : 'error');
  }

  // Record window history
  state.windowHistory.unshift({
    slug: window.slug,
    resolution,
    pnl: parseFloat(windowPnl.toFixed(2)),
    capital: parseFloat(state.capital.toFixed(2)),
    ts: Date.now(),
  });

  addLog(`💰 Window PnL: $${windowPnl.toFixed(2)} | Capital: $${state.capital.toFixed(2)}`, 'info');
  state.windowStatus = 'waiting';
  broadcastState();

  // Find next window
  setTimeout(findAndStartWindow, 2000);
}

// ============================================================
//  PRICE FEEDS
// ============================================================
async function refreshPrices() {
  try {
    const ids = [state.upTokenId, state.downTokenId].filter(Boolean);
    if (ids.length === 0) return;

    for (const id of ids) {
      const { mid } = await getBestPrice(id);
      if (id === state.upTokenId) {
        state.upPrice = mid;
        pushPriceHistory('up', mid);
      } else {
        state.downPrice = mid;
        pushPriceHistory('down', mid);
      }
    }
    state.lastPriceUpdate = Date.now();
    processPriceTick();
    broadcastState();
  } catch (e) {}
}

function subscribeToWebSocket(assetIds) {
  if (assetIds.length === 0) {
    startPriceSimulation();
    return;
  }

  polyWs = connectMarketWebSocket(
    assetIds,
    (assetId, price, raw) => {
      if (assetId === state.upTokenId) {
        state.upPrice = price;
        pushPriceHistory('up', price);
      } else if (assetId === state.downTokenId) {
        state.downPrice = price;
        pushPriceHistory('down', price);
      }
      state.lastPriceUpdate = Date.now();
      state.wsConnected = true;
      processPriceTick();
      broadcastState();
    },
    (err) => {
      state.wsConnected = false;
      // Fall back to polling
      if (!pricePollingTimer) {
        pricePollingTimer = setInterval(refreshPrices, 2000);
      }
    }
  );

  // Also poll as backup
  pricePollingTimer = setInterval(refreshPrices, 5000);
}

function pushPriceHistory(side, price) {
  const arr = state.priceHistory[side];
  arr.push({ price, ts: Date.now() });
  if (arr.length > 300) arr.shift();
}

// ============================================================
//  SIMULATION MODE (when API unavailable)
// ============================================================
let simPrice = { up: 0.60, down: 0.40 };
let simTimer = null;

function startSimulatedWindow() {
  const now = Math.floor(Date.now() / 1000);
  const fakeWindow = {
    slug: `btc-updown-15m-${now + 900}`,
    marketId: null,
    endsAt: now + 900,
    tokens: [],
    ts: now,
    simulated: true,
  };

  state.currentWindow = fakeWindow;
  state.upLadder = createLadder('up');
  state.downLadder = createLadder('down');
  state.priceHistory = { up: [], down: [] };
  state.windowStatus = 'active';
  state.botStatus = 'trading (simulated)';
  state.upPrice = 0.62;
  state.downPrice = 0.38;

  addLog('🎮 SIMULATION MODE: Using generated price data', 'warn');
  startPriceSimulation();

  const timeLeft = 900000;
  setTimeout(() => endSimulatedWindow(fakeWindow), timeLeft);
  broadcastState();
}

function startPriceSimulation() {
  if (simTimer) clearInterval(simTimer);

  simPrice.up = 0.58 + Math.random() * 0.12;
  simPrice.down = 1 - simPrice.up + (Math.random() * 0.04 - 0.02);

  simTimer = setInterval(() => {
    if (state.windowStatus !== 'active') {
      clearInterval(simTimer);
      return;
    }
    // Random walk
    const drift = (Math.random() - 0.5) * 0.012;
    simPrice.up = Math.max(0.30, Math.min(0.95, simPrice.up + drift));
    simPrice.down = Math.max(0.30, Math.min(0.95, simPrice.down - drift * 0.8));

    state.upPrice = parseFloat(simPrice.up.toFixed(4));
    state.downPrice = parseFloat(simPrice.down.toFixed(4));
    pushPriceHistory('up', state.upPrice);
    pushPriceHistory('down', state.downPrice);
    state.lastPriceUpdate = Date.now();

    processPriceTick();
    broadcastState();
  }, 800);
}

async function endSimulatedWindow(window) {
  clearInterval(simTimer);
  const resolution = simPrice.up >= 0.5 ? 'up' : 'down';
  addLog(`🏁 Sim window ending. Resolution: ${resolution.toUpperCase()}`, 'info');

  const { results, capital: newCapital } = settleWindow(
    state.upLadder,
    state.downLadder,
    resolution,
    state.capital
  );

  const windowPnl = newCapital - state.capital;
  state.capital = newCapital;
  state.totalPnl += windowPnl;
  state.windowsTraded++;
  if (windowPnl >= 0) state.wins++; else state.losses++;

  for (const r of results) addLog(r.msg, r.won ? 'success' : 'error');

  state.windowHistory.unshift({
    slug: window.slug,
    resolution,
    pnl: parseFloat(windowPnl.toFixed(2)),
    capital: parseFloat(state.capital.toFixed(2)),
    ts: Date.now(),
    simulated: true,
  });

  addLog(`💰 Window PnL: $${windowPnl.toFixed(2)} | Capital: $${state.capital.toFixed(2)}`, 'info');
  state.windowStatus = 'waiting';
  broadcastState();

  setTimeout(startSimulatedWindow, 3000);
}

// ============================================================
//  PROCESS PRICE TICK → TRADING LOGIC
// ============================================================
function processPriceTick() {
  if (state.windowStatus !== 'active') return;

  // UP LADDER
  if (state.upLadder && state.upPrice !== null) {
    const { actions, capital: newCap } = processUpLadder(
      state.upLadder,
      state.upPrice,
      state.capital
    );
    state.capital = newCap;
    for (const a of actions) addLog(a.msg, a.type === 'BUY' ? 'buy' : a.type === 'SELL_ALL' ? 'sell' : 'warn');
  }

  // DOWN LADDER
  if (state.downLadder && state.downPrice !== null) {
    const { actions, capital: newCap } = processDownLadder(
      state.downLadder,
      state.downPrice,
      state.capital
    );
    state.capital = newCap;
    for (const a of actions) addLog(a.msg, a.type === 'BUY' ? 'buy' : a.type === 'SELL_ALL' ? 'sell' : 'warn');
  }
}

// ============================================================
//  EXPRESS APP
// ============================================================
const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, '../public')));

app.get('/api/state', (req, res) => {
  res.json(getPublicState());
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

const server = http.createServer(app);

// Dashboard WebSocket
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws) => {
  dashboardClients.add(ws);
  ws.send(JSON.stringify({ type: 'state', payload: getPublicState(), ts: Date.now() }));

  ws.on('close', () => dashboardClients.delete(ws));
  ws.on('error', () => dashboardClients.delete(ws));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 BTC Ladder Bot running on http://localhost:${PORT}\n`);
  addLog(`Bot started. Capital: $${state.capital}`, 'success');
  setTimeout(findAndStartWindow, 1000);
});
