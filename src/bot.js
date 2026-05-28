// ============================================================
//  BTC LADDER BOT — Core Trading Engine
//  Polymarket 15-min BTC Up/Down Windows
// ============================================================

const DEMO_CAPITAL_START = 2000;

function createLadder(side) {
  return {
    side,                  // 'up' or 'down'
    positions: [],         // { price, shares }
    lastSoldPrice: null,
    active: true,
    totalShares: 0,
    totalCost: 0,
    log: [],
  };
}

function avgEntry(ladder) {
  if (ladder.totalShares === 0) return 0;
  return ladder.totalCost / ladder.totalShares;
}

function ladderBuyThreshold(ladder) {
  if (ladder.positions.length === 0) return null;
  const lowestBuy = Math.min(...ladder.positions.map(p => p.price));
  return parseFloat((lowestBuy - 0.05).toFixed(2));
}

function reEntryPrice(ladder) {
  if (ladder.lastSoldPrice === null) return 0.55;
  return parseFloat((ladder.lastSoldPrice - 0.05).toFixed(2));
}

// ---- BUY UP LADDER ----
function processUpLadder(ladder, price, capital) {
  const actions = [];
  price = parseFloat(price.toFixed(4));

  if (!ladder.active) return { actions, capital };

  const STOP_LOSS = 0.46;
  const ENTRY_MIN = 0.55;
  const ENTRY_MAX = 0.90;

  // Stop loss
  if (price < STOP_LOSS && ladder.totalShares > 0) {
    const proceeds = ladder.totalShares * price;
    const cost = ladder.totalCost;
    const pnl = proceeds - cost;
    capital += proceeds;
    actions.push({
      type: 'STOP_LOSS',
      side: 'UP',
      price,
      shares: ladder.totalShares,
      pnl: parseFloat(pnl.toFixed(2)),
      msg: `⛔ STOP LOSS: Sold ${ladder.totalShares} shares @ $${price} | PnL: $${pnl.toFixed(2)}`
    });
    ladder.positions = [];
    ladder.totalShares = 0;
    ladder.totalCost = 0;
    ladder.lastSoldPrice = null;
    ladder.active = true;
    ladder.log.push(actions[actions.length - 1]);
    return { actions, capital };
  }

  // Sell logic: price rose 0.10 above avg entry
  if (ladder.totalShares > 0) {
    const avg = avgEntry(ladder);
    const sellTarget = parseFloat((avg + 0.10).toFixed(2));
    if (price >= sellTarget) {
      const proceeds = ladder.totalShares * price;
      const cost = ladder.totalCost;
      const pnl = proceeds - cost;
      capital += proceeds;
      const soldAt = price;
      actions.push({
        type: 'SELL_ALL',
        side: 'UP',
        price,
        shares: ladder.totalShares,
        avgEntry: parseFloat(avg.toFixed(4)),
        pnl: parseFloat(pnl.toFixed(2)),
        msg: `✅ SELL ALL (UP): ${ladder.totalShares} shares @ $${price} | Avg: $${avg.toFixed(4)} | PnL: $${pnl.toFixed(2)}`
      });
      ladder.lastSoldPrice = soldAt;
      ladder.positions = [];
      ladder.totalShares = 0;
      ladder.totalCost = 0;
      ladder.log.push(actions[actions.length - 1]);
      return { actions, capital };
    }
  }

  // Buy logic
  const entryMin = ladder.positions.length === 0 ? ENTRY_MIN : reEntryPrice(ladder);
  const canEnter = (
    price >= (ladder.positions.length === 0 ? ENTRY_MIN : entryMin) &&
    price <= ENTRY_MAX
  );

  if (!canEnter && ladder.positions.length === 0) return { actions, capital };

  // Check if price dropped enough to buy more
  const nextBuyAt = ladder.positions.length === 0
    ? (price <= ENTRY_MAX && price >= ENTRY_MIN ? price : null)
    : ladderBuyThreshold(ladder);

  if (
    ladder.positions.length === 0 &&
    price >= ENTRY_MIN &&
    price <= ENTRY_MAX &&
    capital >= price * 100
  ) {
    // First buy
    const cost = price * 100;
    capital -= cost;
    ladder.positions.push({ price, shares: 100 });
    ladder.totalShares += 100;
    ladder.totalCost += cost;
    actions.push({
      type: 'BUY',
      side: 'UP',
      price,
      shares: 100,
      avgEntry: parseFloat(avgEntry(ladder).toFixed(4)),
      msg: `🟢 BUY UP: 100 shares @ $${price} | Avg: $${avgEntry(ladder).toFixed(4)}`
    });
    ladder.log.push(actions[actions.length - 1]);
  } else if (
    ladder.positions.length > 0 &&
    nextBuyAt !== null &&
    price <= nextBuyAt &&
    price >= ENTRY_MIN &&
    capital >= price * 100
  ) {
    const cost = price * 100;
    capital -= cost;
    ladder.positions.push({ price, shares: 100 });
    ladder.totalShares += 100;
    ladder.totalCost += cost;
    actions.push({
      type: 'BUY',
      side: 'UP',
      price,
      shares: 100,
      avgEntry: parseFloat(avgEntry(ladder).toFixed(4)),
      msg: `🟢 BUY MORE UP: 100 shares @ $${price} | Avg: $${avgEntry(ladder).toFixed(4)}`
    });
    ladder.log.push(actions[actions.length - 1]);
  }

  return { actions, capital };
}

// ---- BUY DOWN LADDER (mirror of UP) ----
function processDownLadder(ladder, price, capital) {
  const actions = [];
  price = parseFloat(price.toFixed(4));

  if (!ladder.active) return { actions, capital };

  // For DOWN ladder: price is the DOWN token price
  // Mirror: entry 0.55–0.90, buy on drops, sell on rises
  // Down token price = 1 - up token price (approximately)
  // We trade DOWN token directly the same way

  const STOP_LOSS = 0.46;
  const ENTRY_MIN = 0.55;
  const ENTRY_MAX = 0.90;

  if (price < STOP_LOSS && ladder.totalShares > 0) {
    const proceeds = ladder.totalShares * price;
    const cost = ladder.totalCost;
    const pnl = proceeds - cost;
    capital += proceeds;
    actions.push({
      type: 'STOP_LOSS',
      side: 'DOWN',
      price,
      shares: ladder.totalShares,
      pnl: parseFloat(pnl.toFixed(2)),
      msg: `⛔ STOP LOSS: Sold ${ladder.totalShares} DOWN shares @ $${price} | PnL: $${pnl.toFixed(2)}`
    });
    ladder.positions = [];
    ladder.totalShares = 0;
    ladder.totalCost = 0;
    ladder.lastSoldPrice = null;
    ladder.active = true;
    ladder.log.push(actions[actions.length - 1]);
    return { actions, capital };
  }

  if (ladder.totalShares > 0) {
    const avg = avgEntry(ladder);
    const sellTarget = parseFloat((avg + 0.10).toFixed(2));
    if (price >= sellTarget) {
      const proceeds = ladder.totalShares * price;
      const cost = ladder.totalCost;
      const pnl = proceeds - cost;
      capital += proceeds;
      const soldAt = price;
      actions.push({
        type: 'SELL_ALL',
        side: 'DOWN',
        price,
        shares: ladder.totalShares,
        avgEntry: parseFloat(avg.toFixed(4)),
        pnl: parseFloat(pnl.toFixed(2)),
        msg: `✅ SELL ALL (DOWN): ${ladder.totalShares} shares @ $${price} | Avg: $${avg.toFixed(4)} | PnL: $${pnl.toFixed(2)}`
      });
      ladder.lastSoldPrice = soldAt;
      ladder.positions = [];
      ladder.totalShares = 0;
      ladder.totalCost = 0;
      ladder.log.push(actions[actions.length - 1]);
      return { actions, capital };
    }
  }

  const nextBuyAt = ladder.positions.length === 0
    ? null
    : ladderBuyThreshold(ladder);

  if (
    ladder.positions.length === 0 &&
    price >= ENTRY_MIN &&
    price <= ENTRY_MAX &&
    capital >= price * 100
  ) {
    const cost = price * 100;
    capital -= cost;
    ladder.positions.push({ price, shares: 100 });
    ladder.totalShares += 100;
    ladder.totalCost += cost;
    actions.push({
      type: 'BUY',
      side: 'DOWN',
      price,
      shares: 100,
      avgEntry: parseFloat(avgEntry(ladder).toFixed(4)),
      msg: `🔵 BUY DOWN: 100 shares @ $${price} | Avg: $${avgEntry(ladder).toFixed(4)}`
    });
    ladder.log.push(actions[actions.length - 1]);
  } else if (
    ladder.positions.length > 0 &&
    nextBuyAt !== null &&
    price <= nextBuyAt &&
    price >= ENTRY_MIN &&
    capital >= price * 100
  ) {
    const cost = price * 100;
    capital -= cost;
    ladder.positions.push({ price, shares: 100 });
    ladder.totalShares += 100;
    ladder.totalCost += cost;
    actions.push({
      type: 'BUY',
      side: 'DOWN',
      price,
      shares: 100,
      avgEntry: parseFloat(avgEntry(ladder).toFixed(4)),
      msg: `🔵 BUY MORE DOWN: 100 shares @ $${price} | Avg: $${avgEntry(ladder).toFixed(4)}`
    });
    ladder.log.push(actions[actions.length - 1]);
  }

  return { actions, capital };
}

function settleWindow(upLadder, downLadder, resolution, capital) {
  // resolution: 'up' or 'down' (winner)
  const results = [];

  for (const [ladder, side] of [[upLadder, 'up'], [downLadder, 'down']]) {
    if (ladder.totalShares > 0) {
      const won = resolution === side;
      const settlePrice = won ? 1.0 : 0.0;
      const proceeds = ladder.totalShares * settlePrice;
      const pnl = proceeds - ladder.totalCost;
      capital += proceeds;
      results.push({
        side: side.toUpperCase(),
        shares: ladder.totalShares,
        settlePrice,
        pnl: parseFloat(pnl.toFixed(2)),
        won,
        msg: `${won ? '🏆 WIN' : '💀 LOSS'} (${side.toUpperCase()}): ${ladder.totalShares} shares settled @ $${settlePrice} | PnL: $${pnl.toFixed(2)}`
      });
      ladder.positions = [];
      ladder.totalShares = 0;
      ladder.totalCost = 0;
      ladder.lastSoldPrice = null;
    }
  }

  return { results, capital };
}

module.exports = {
  createLadder,
  processUpLadder,
  processDownLadder,
  settleWindow,
  avgEntry,
  DEMO_CAPITAL_START,
};
