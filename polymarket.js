// ============================================================
//  POLYMARKET API + WEBSOCKET INTEGRATION
// ============================================================

const fetch = require('node-fetch');
const WebSocket = require('ws');

const POLYMARKET_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const POLYMARKET_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// ---- Find the current + next BTC 15m window ----
async function findBtcWindows() {
  try {
    const now = Math.floor(Date.now() / 1000);
    // Round down to nearest 15-min block
    const base = Math.floor(now / 900) * 900;

    const windows = [];
    // Check current and next 3 windows
    for (let i = 0; i <= 3; i++) {
      const ts = base + i * 900;
      const slug = `btc-updown-15m-${ts + 900}`;
      windows.push({ ts, slug, endsAt: ts + 900 });
    }

    // Try to find active/upcoming markets
    const results = [];
    for (const w of windows) {
      try {
        const url = `${POLYMARKET_API}/markets?slug=${w.slug}`;
        const res = await fetch(url, { timeout: 5000 });
        if (res.ok) {
          const data = await res.json();
          if (data && data.length > 0) {
            const market = data[0];
            results.push({
              ...w,
              marketId: market.id,
              conditionId: market.conditionId,
              tokens: market.tokens || [],
              active: market.active,
              closed: market.closed,
              raw: market
            });
          }
        }
      } catch (e) {
        // Skip failed windows
      }
    }

    // Also try searching broadly
    if (results.length === 0) {
      try {
        const searchUrl = `${POLYMARKET_API}/markets?tag=BTC&limit=20&active=true`;
        const res = await fetch(searchUrl, { timeout: 8000 });
        if (res.ok) {
          const data = await res.json();
          const btc15m = data.filter(m =>
            m.slug && m.slug.includes('btc-updown-15m')
          );
          for (const m of btc15m) {
            const tsMatch = m.slug.match(/btc-updown-15m-(\d+)/);
            const ts = tsMatch ? parseInt(tsMatch[1]) : 0;
            results.push({
              ts: ts - 900,
              slug: m.slug,
              endsAt: ts,
              marketId: m.id,
              conditionId: m.conditionId,
              tokens: m.tokens || [],
              active: m.active,
              closed: m.closed,
              raw: m
            });
          }
        }
      } catch (e) {}
    }

    return results;
  } catch (err) {
    console.error('findBtcWindows error:', err.message);
    return [];
  }
}

// ---- Get token prices from CLOB ----
async function getTokenPrices(tokenIds) {
  try {
    const prices = {};
    for (const id of tokenIds) {
      try {
        const url = `${CLOB_API}/mid-point?token_id=${id}`;
        const res = await fetch(url, { timeout: 4000 });
        if (res.ok) {
          const data = await res.json();
          prices[id] = parseFloat(data.mid || data.price || 0.5);
        }
      } catch (e) {
        prices[id] = 0.5;
      }
    }
    return prices;
  } catch (err) {
    return {};
  }
}

// ---- Get orderbook / best price ----
async function getBestPrice(tokenId) {
  try {
    const url = `${CLOB_API}/book?token_id=${tokenId}`;
    const res = await fetch(url, { timeout: 4000 });
    if (res.ok) {
      const data = await res.json();
      const bids = data.bids || [];
      const asks = data.asks || [];
      const bestBid = bids.length ? parseFloat(bids[0].price) : 0;
      const bestAsk = asks.length ? parseFloat(asks[0].price) : 0;
      const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk || 0.5;
      return { bestBid, bestAsk, mid };
    }
  } catch (e) {}
  return { bestBid: 0.5, bestAsk: 0.5, mid: 0.5 };
}

// ---- Connect to Polymarket WebSocket for live prices ----
function connectMarketWebSocket(assetIds, onPrice, onError) {
  let ws = null;
  let reconnectTimer = null;
  let alive = true;

  function connect() {
    try {
      ws = new WebSocket(POLYMARKET_WS);

      ws.on('open', () => {
        console.log('[WS] Connected to Polymarket');
        const sub = {
          auth: {},
          markets: assetIds,
          type: 'Market'
        };
        ws.send(JSON.stringify(sub));
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (Array.isArray(msg)) {
            for (const event of msg) {
              if (event.asset_id && event.price) {
                onPrice(event.asset_id, parseFloat(event.price), event);
              } else if (event.asset_id && event.best_ask) {
                const mid = (parseFloat(event.best_ask) + parseFloat(event.best_bid || event.best_ask)) / 2;
                onPrice(event.asset_id, mid, event);
              }
            }
          } else if (msg.asset_id) {
            if (msg.price) onPrice(msg.asset_id, parseFloat(msg.price), msg);
          }
        } catch (e) {}
      });

      ws.on('error', (err) => {
        console.error('[WS] Error:', err.message);
        if (onError) onError(err);
      });

      ws.on('close', () => {
        console.log('[WS] Disconnected, reconnecting in 3s...');
        if (alive) {
          reconnectTimer = setTimeout(connect, 3000);
        }
      });

      // Heartbeat
      const ping = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.ping();
        } else {
          clearInterval(ping);
        }
      }, 20000);

    } catch (err) {
      console.error('[WS] Connect failed:', err.message);
      if (alive) reconnectTimer = setTimeout(connect, 5000);
    }
  }

  connect();

  return {
    close: () => {
      alive = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    },
    resubscribe: (newAssetIds) => {
      assetIds = newAssetIds;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const sub = { auth: {}, markets: newAssetIds, type: 'Market' };
        ws.send(JSON.stringify(sub));
      }
    }
  };
}

// ---- Check market resolution ----
async function checkResolution(marketId) {
  try {
    const url = `${POLYMARKET_API}/markets/${marketId}`;
    const res = await fetch(url, { timeout: 6000 });
    if (res.ok) {
      const data = await res.json();
      if (data.closed || data.resolved) {
        // Find winning token
        const tokens = data.tokens || [];
        const winner = tokens.find(t => t.winner === true);
        if (winner) {
          return {
            resolved: true,
            winner: winner.outcome?.toLowerCase().includes('up') ? 'up' : 'down',
            raw: data
          };
        }
        // Try outcomes
        if (data.outcomePrices) {
          const prices = JSON.parse(data.outcomePrices);
          const outcomes = JSON.parse(data.outcomes || '[]');
          const maxIdx = prices.indexOf(Math.max(...prices.map(Number)));
          const outcome = outcomes[maxIdx] || '';
          return {
            resolved: true,
            winner: outcome.toLowerCase().includes('up') ? 'up' : 'down',
            raw: data
          };
        }
      }
    }
  } catch (e) {}
  return { resolved: false };
}

module.exports = {
  findBtcWindows,
  getTokenPrices,
  getBestPrice,
  connectMarketWebSocket,
  checkResolution,
};
