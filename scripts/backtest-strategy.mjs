/**
 * Backtests five families of simple trading rule against real daily prices.
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

/* Five families of rule, every setting reported. Testing one rule tells you
   whether that rule works; testing five tells you whether ANY simple rule
   works, which is the question actually being asked. The families are chosen to
   disagree with each other on purpose — trend rules buy strength, mean-reversion
   rules buy weakness — so they cannot all be right, and if none of them beat
   holding that is a finding rather than a bad guess. */
const RULES = {
  /* in while price is above its own N-day average */
  trend: [20, 30, 50, 80, 100, 150, 200].map(n => ({
    label: n + 'd average',
    signal: (p, i) => p[i].close > avg(p, i, n),
    lookback: n
  })),
  /* in while a fast average is above a slow one */
  crossover: [[20, 50], [20, 100], [50, 100], [50, 200], [30, 150]].map(([f, sl]) => ({
    label: f + '/' + sl + ' cross',
    signal: (p, i) => avg(p, i, f) > avg(p, i, sl),
    lookback: sl
  })),
  /* in while the last N days were up overall */
  momentum: [30, 60, 90, 180].map(n => ({
    label: n + 'd momentum',
    signal: (p, i) => p[i].close > p[i - n].close,
    lookback: n
  })),
  /* the opposite bet: buy weakness, sell back into strength */
  meanRevert: [5, 10, 15, 20].map(n => ({
    label: 'dip ' + n + '%',
    signal: (p, i) => p[i].close < avg(p, i, 50) * (1 - n / 100)
                        ? true
                        : (p[i].close > avg(p, i, 50) ? false : null),
    lookback: 50
  })),
  /* buy after a run of down days, sell after a run of up days */
  streak: [2, 3, 4, 5].map(n => ({
    label: n + ' down days',
    signal: (p, i) => {
      let down = 0, up = 0;
      for (let k = i - n + 1; k <= i; k++) {
        if (p[k].close < p[k - 1].close) down++; else up++;
      }
      return down === n ? true : (up === n ? false : null);
    },
    lookback: n + 1
  }))
};

function avg(p, i, n) {
  let sum = 0;
  for (let k = i - n; k < i; k++) sum += p[k].close;
  return sum / n;
}

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

/* Walk the series once. Switch only when the rule changes side, and pay for it.
   A signal of null means "no opinion" — hold whatever you already hold, rather
   than churning. Every family starts from the same bar so the comparison is
   like for like. */
function run(prices, rule, startAt) {
  const window = startAt;
  if (prices.length < window + 30) return null;
  let cash = STAKE, coin = 0, inMarket = false, trades = 0;
  let peak = STAKE, worst = 0;
  const curve = [];

  for (let i = window; i < prices.length; i++) {
    const px = prices[i].close;
    const sig = rule.signal(prices, i);
    const want = (sig === null || sig === undefined) ? inMarket : !!sig;

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
    label: rule.label, trades,
    end: Math.round(end),
    heldEnd: Math.round(held),
    perYear: +(((Math.pow(end / STAKE, 1 / years) - 1) * 100).toFixed(1)),
    worstDrop: +worst.toFixed(1),
    beatHolding: end > held
  };
}

function table(rows) {
  const head = ['setting', 'ended', 'vs holding', 'per year', 'worst drop', 'switches'];
  const body = rows.map(r => [
    r.label,
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
  console.log(`Every simple rule I can defend, on real prices.`);
  console.log(`$${STAKE}, ${YEARS} years, ${FEE_PCT}% cost per switch.\n`);

  const verdicts = [];

  for (const product of PRODUCTS) {
    console.log(`\n${'='.repeat(52)}\n${product}\n${'='.repeat(52)}`);
    const prices = await candles(product);
    if (prices.length < 250) {
      console.log(`  not enough data (${prices.length} days) — skipped`);
      continue;
    }
    const first = new Date(prices[0].t * 1000).toISOString().slice(0, 10);
    const last = new Date(prices[prices.length - 1].t * 1000).toISOString().slice(0, 10);
    console.log(`${prices.length} days, ${first} to ${last}`);

    /* Every family starts at the same bar, or a rule needing 200 days of warm-up
       would be judged over a shorter and possibly kinder stretch than one
       needing 20. */
    const startAt = 200;
    const held = Math.round(STAKE *
      (prices[prices.length - 1].close / prices[startAt].close));
    console.log(`Just holding: $${held.toLocaleString()}\n`);

    for (const [family, rules] of Object.entries(RULES)) {
      const rows = rules.map(r => run(prices, r, startAt)).filter(Boolean);
      if (!rows.length) continue;
      console.log(`-- ${family} --`);
      table(rows);
      const won = rows.filter(r => r.end > held).length;
      const ends = rows.map(r => r.end).sort((a, b) => a - b);
      const median = ends[Math.floor(ends.length / 2)];
      console.log(`   beat holding: ${won}/${rows.length}   median $${median.toLocaleString()}\n`);
      verdicts.push({ product, family, won, of: rows.length, median, held });
    }
  }

  /* The only line that matters. A family is worth more work only if most of its
     settings beat holding — one winner among many losers is the sound of a
     parameter being fitted to a past that will not repeat. */
  console.log(`\n${'='.repeat(52)}\nVERDICT\n${'='.repeat(52)}`);
  let anyStrong = false;
  for (const v of verdicts) {
    const frac = v.won / v.of;
    const beatsOnMedian = v.median > v.held;
    const verdict = (frac >= 0.7 && beatsOnMedian) ? 'WORTH MORE WORK'
                  : frac === 0 ? 'dead'
                  : 'noise (some settings won, the typical one did not)';
    if (frac >= 0.7 && beatsOnMedian) anyStrong = true;
    console.log(`  ${v.product} ${v.family}: ${v.won}/${v.of} beat holding, ` +
                `median $${v.median.toLocaleString()} vs $${v.held.toLocaleString()} — ${verdict}`);
  }

  console.log('');
  if (!anyStrong) {
    console.log('  No family beat holding on a majority of its settings.');
    console.log('  On this evidence, simple rules on daily closes do not work here.');
    console.log('  Anything that looks like it won is one setting out of many.');
  } else {
    console.log('  At least one family held up across most of its settings.');
    console.log('  Next step is paper trading it live, not funding it.');
  }
  console.log('\nPast results. Costs included, luck not removed.');
}

main().catch(e => { console.error(e); process.exit(1); });
