/**
 * Backtests trend-following rules against real daily prices.
 *
 *   node scripts/backtest-strategy.mjs
 *
 * THE RULE
 * Hold the coin while its price is above an N-day average; sit in cash while it
 * is below. That is the whole strategy. It trades rarely, which is what lets it
 * survive fees, and it has two knobs instead of twenty, which is what stops it
 * being fitted to the past.
 *
 * WHAT THIS IS BUILT TO DO
 * Not to find a winner. To find out whether there is one. Three things are wired
 * in from the start because leaving them out is how backtests come to flatter:
 *
 *   1. Costs. Every switch pays a fee and slippage. A rule that trades often
 *      looks brilliant at zero cost and loses money at realistic cost.
 *   2. A spread of parameters, not the best one. If 50 days makes money and 40
 *      and 60 lose, that is not a strategy, it is a coincidence with a number
 *      attached. The report shows every setting so the pattern is visible.
 *   3. The worst stretch, not just the total. A rule that doubles your money
 *      after halving it first is one most people would abandon at the bottom.
 *
 * Data: Coinbase's public candle endpoint. Free, no key, no signup.
 */

const PRODUCTS = ['BTC-USD', 'ETH-USD'];
const STAKE = 1000;
const YEARS = 3;

/* Round-trip cost of one switch. Coinbase Advanced taker fees start around
   0.6% and fall with volume; slippage on a market order adds more. 0.7% each
   way is realistic for a small account and deliberately not optimistic. */
const FEE_PCT = 0.7;

/* Every setting gets reported, not just the flattering one. */
const WINDOWS = [20, 30, 50, 80, 100, 150, 200];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function candles(product) {
  /* Coinbase returns at most 300 candles per request, so walk backwards. */
  const out = new Map();
  let end = new Date();
  for (let page = 0; page < Math.ceil(YEARS * 365 / 300) + 1; page++) {
    const start = new Date(end.getTime() - 300 * 86400000);
    const url = `https://api.exchange.coinbase.com/products/${product}/candles` +
      `?granularity=86400&start=${start.toISOString()}&end=${end.toISOString()}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'lpvshodl-backtest' } });
    if (!r.ok) { console.error(`  ${product}: HTTP ${r.status}`); break; }
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) break;
    for (const c of rows) out.set(c[0], c[4]);   /* [time, low, high, open, close, vol] */
    end = start;
    await sleep(400);
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0])
    .map(([t, close]) => ({ t, close: Number(close) }))
    .filter(d => d.close > 0);
}

/* Walk the series once. Switch only when the rule changes side, and pay for it. */
function run(prices, window) {
  if (prices.length < window + 30) return null;
  let cash = STAKE, coin = 0, inMarket = false, trades = 0;
  let peak = STAKE, worst = 0;
  const curve = [];

  for (let i = window; i < prices.length; i++) {
    const px = prices[i].close;
    let sum = 0;
    for (let k = i - window; k < i; k++) sum += prices[k].close;
    const avg = sum / window;
    const want = px > avg;

    if (want !== inMarket) {
      if (want) { coin = (cash * (1 - FEE_PCT / 100)) / px; cash = 0; }
      else { cash = coin * px * (1 - FEE_PCT / 100); coin = 0; }
      inMarket = want; trades++;
    }

    const value = cash + coin * px;
    curve.push(value);
    if (value > peak) peak = value;
    const dd = (peak - value) / peak * 100;
    if (dd > worst) worst = dd;
  }

  const end = curve[curve.length - 1];
  const held = STAKE * (prices[prices.length - 1].close / prices[window].close);
  const years = (prices.length - window) / 365;
  return {
    window, trades,
    end: Math.round(end),
    heldEnd: Math.round(held),
    perYear: +(((Math.pow(end / STAKE, 1 / years) - 1) * 100).toFixed(1)),
    worstDrop: +worst.toFixed(1),
    beatHolding: end > held
  };
}

function table(rows) {
  const head = ['days', 'ended', 'vs holding', 'per year', 'worst drop', 'switches'];
  const body = rows.map(r => [
    String(r.window),
    '$' + r.end.toLocaleString(),
    r.beatHolding ? 'beat' : 'lost',
    r.perYear + '%',
    '-' + r.worstDrop + '%',
    String(r.trades)
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map(b => b[i].length)));
  const line = c => c.map((x, i) => x.padEnd(w[i])).join('  ');
  console.log('  ' + line(head));
  console.log('  ' + w.map(n => '-'.repeat(n)).join('  '));
  body.forEach(b => console.log('  ' + line(b)));
}

async function main() {
  console.log(`Trend-following backtest — $${STAKE}, ${YEARS} years, ` +
              `${FEE_PCT}% cost per switch\n`);

  for (const product of PRODUCTS) {
    console.log(`\n=== ${product} ===`);
    const prices = await candles(product);
    if (prices.length < 250) {
      console.log(`  not enough data (${prices.length} days) — skipped`);
      continue;
    }
    const first = new Date(prices[0].t * 1000).toISOString().slice(0, 10);
    const last = new Date(prices[prices.length - 1].t * 1000).toISOString().slice(0, 10);
    console.log(`  ${prices.length} days, ${first} to ${last}\n`);

    const rows = WINDOWS.map(w => run(prices, w)).filter(Boolean);
    if (!rows.length) { console.log('  nothing testable'); continue; }
    table(rows);

    const won = rows.filter(r => r.beatHolding).length;
    const buyHold = rows[0].heldEnd;
    console.log(`\n  Just holding: $${buyHold.toLocaleString()}`);
    console.log(`  Settings that beat holding: ${won} of ${rows.length}`);

    /* The honest headline. One winning setting among many losers is noise; most
       settings winning is the only thing that would count as evidence. */
    if (won === rows.length) {
      console.log('  -> every setting beat holding. That is a real pattern.');
    } else if (won === 0) {
      console.log('  -> no setting beat holding. The rule did not work here.');
    } else {
      console.log('  -> mixed. Picking the best setting here would be fitting to');
      console.log('     the past, not finding an edge. Treat as no evidence.');
    }

    /* What it means for the stated goal, in the same units it was asked in. */
    const best = rows.slice().sort((a, b) => b.end - a.end)[0];
    const monthly = Math.pow(best.end / STAKE, 1 / (YEARS * 12));
    console.log(`\n  Best setting made ${((monthly - 1) * 100).toFixed(1)}% a month on average.`);
    console.log(`  Doubling in a month needs 100%. Gap: ${(100 / ((monthly - 1) * 100)).toFixed(0)}x.`);
  }

  console.log('\nPast results. Costs included, luck not removed.');
}

main().catch(e => { console.error(e); process.exit(1); });
