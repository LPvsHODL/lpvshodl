/**
 * Builds best-pools.json — the overnight ranking behind the Best pools tab.
 *
 * Why this runs overnight and not when someone visits: every pool costs a paid
 * data query, and a leaderboard needs hundreds. Per visitor that would burn a
 * month's allowance in an afternoon. So it runs once a night, writes a plain
 * JSON file into the repo, and the page just reads that.
 *
 * WHAT IT RANKS BY
 * Not APR. Whether providing liquidity actually beat holding the two tokens.
 * Ranking by APR would mean ranking by the estimate this whole site exists to
 * discredit — and worse, an estimate-based ranking is sorted by its own error,
 * because the pools that top it are the ones where the estimate breaks worst.
 * Only pools with a real fee record are eligible. Everything else is skipped.
 *
 * THE MATHS IS NOT REIMPLEMENTED HERE
 * It is read out of index.html at run time. Two copies of concentrated-liquidity
 * arithmetic would drift apart within a month and nobody would notice which one
 * was wrong. There is one copy, and the page and this job share it.
 *
 * RUNNING IT
 *   node scripts/build-best-pools.mjs
 * No API key needed: pool history comes from the deployed site's own endpoint,
 * which already holds the key and already resolves daily dollar prices.
 */

import fs from 'fs';
import path from 'path';

const SITE = process.env.SITE_ORIGIN || 'https://lpvshodl.com';
const ROOT = process.cwd();
const PAGE = path.join(ROOT, 'LPvsHODL', 'index.html');
const OUT = path.join(ROOT, 'LPvsHODL', 'best-pools.json');
const SITE_DIR = path.join(ROOT, 'LPvsHODL');

/* Pages that exist regardless of what the run finds. Listed here because the
   sitemap is rewritten wholesale each night and would otherwise drop them. */
const CORE_PAGES = ['/', '/best-pools/', '/minimum-size/', '/impermanent-loss/',
                    '/good-apr/', '/uniswap-v2-vs-v3/', '/choosing-a-price-range/'];

const DEPOSIT = 10000;          /* every pool tested at the same size */
const BANDS = [10, 25, 50];     /* percent either side of the entry price */
/* A full year, not a quarter. The first run ranked on 90 days and reported that
   13 of 17 pools beat holding — which says more about that particular quarter
   being calm than about pools. Ninety days can miss a real price move entirely,
   and impermanent loss only shows up when price actually moves. The year of
   history was already being fetched for the quarter-by-quarter record, so this
   costs nothing extra. */
const DAYS = 365;               /* headline window */
const YEAR = 365;               /* for the quarter-by-quarter record */
const QUARTERS = 4;
const MIN_TVL = 250000;         /* below this the numbers stop meaning anything */

/* The hard limit that makes any of this honest. The pool's fee record measures
   fees per unit of liquidity ALREADY in the pool, which only describes what you
   would have earned if your arrival did not change the pool. Drop a $10,000
   position into a thin pool and it can be a large share of the liquidity near
   the trading price — the maths then credits it fees it could only earn by
   being that big, while ignoring that being that big would have diluted the
   fee rate for everyone including itself.
   The symptom is spectacular and obviously false: a WBTC/WETH 0.01% pool came
   out at +420% against holding over 90 days at a tight band. Tight bands
   inflate worst, because the same dollars buy more liquidity.
   So: if the modelled position would be more than this share of the pool's
   in-range liquidity, the backtest is fiction and the pool is dropped. Five
   percent is already generous — a realistic retail position in a healthy pool
   sits far below one percent. */
const MAX_SHARE = 0.05;

/* A second, blunter guard, because the dilution check above only catches one
   cause. Fees alone cannot plausibly double a position against holding in 90
   days — that would be roughly 400% a year — so anything past this is a symptom
   of something we have not understood yet, not a finding. Such pools are
   dropped and the reason logged rather than published: this site's whole claim
   is that it does not print numbers it cannot stand behind, and that has to
   apply to numbers that flatter as well as ones that disappoint. */
const MAX_PLAUSIBLE = 100;
const MIN_DAYS = 300;           /* needs most of the year to be judged over one */

/* How deep to dig per chain. Seventeen pools across six chains was too few to
   say anything about the market, so this goes further down the size rankings.
   It is capped rather than open-ended because of the query budget: each pool
   costs about four paid queries, so 60 per chain is roughly 1,400 a run and
   43,000 a month against a 100,000 allowance — leaving room for actual visitors.
   Raising this materially means paying for a bigger plan. */
const PER_CHAIN = 60;

/* Public RPC endpoints, used only to read the current gas price. No key, no
   account, and the only call made is eth_gasPrice. Every URL here was confirmed
   against a live page; a chain missing or failing simply produces no gas figure
   and the page asks the visitor for one instead. */
const RPCS = {
  ethereum: 'https://ethereum-rpc.publicnode.com',
  base: 'https://base-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
  optimism: 'https://optimism-rpc.publicnode.com',
  polygon: 'https://polygon-bor-rpc.publicnode.com',
  avalanche: 'https://avalanche-c-chain-rpc.publicnode.com'
};

/* Which token pays for gas on each chain, so the price can be turned into
   dollars using prices this job already has from the pools it read. */
const NATIVE = {
  ethereum: /^WETH$/i, base: /^WETH$/i, arbitrum: /^WETH$/i, optimism: /^WETH$/i,
  polygon: /^(WMATIC|WPOL|POL|MATIC)$/i, avalanche: /^(WAVAX|AVAX)$/i
};

/* Opening a concentrated position, closing it, or swapping to rebalance all sit
   somewhere around this. It is an approximation and labelled as one on the page
   — the point is that the difference BETWEEN chains is enormous and the
   difference between one transaction type and another is not. */
const GAS_UNITS = 250000;

/* How many recent blocks to sample, and which percentile to take.
   A single eth_gasPrice reading is the price at one instant, and this job runs
   at 4am when nothing is happening — on the first live run that produced 0.05
   gwei for Ethereum mainnet, which is a real reading and a useless planning
   figure. Somebody deciding whether a position is worth opening will not
   transact at the quietest minute of the week, so a busy-ish percentile over a
   window of blocks is the more honest input. */
const FEE_BLOCKS = 100;
const FEE_PCTL = 75;

/* Every chain here pays gas in ETH, so one price serves all of them. Without
   this, a chain whose pools all got filtered out has no price and no gas figure
   at all — which is exactly what happened to Arbitrum and Optimism. */
const ETH_GAS_CHAINS = ['ethereum', 'base', 'arbitrum', 'optimism'];

/* On an L2 the execution fee read here is only part of the bill: posting the
   data back to Ethereum costs more than running the transaction does. Treated
   as a floor and labelled as such rather than quietly understated. */
const L2S = new Set(['base', 'arbitrum', 'optimism']);

/* Filled in as pools are read, then used to convert gas prices into dollars. */
const NATIVE_PX = {};

/* GeckoTerminal's network slugs -> the names our own endpoint knows. Only
   chains where a real fee record exists belong here. */
const CHAINS = {
  eth: 'ethereum', base: 'base', arbitrum: 'arbitrum',
  optimism: 'optimism', polygon_pos: 'polygon', avax: 'avalanche'
};

const STABLES = /^(USDC|USDC\.E|USDBC|USDT|USDT0|DAI|TUSD|USDP|PYUSD|FDUSD|LUSD|GUSD|USDD|FRAX|SUSD|USDS|BUSD|CRVUSD|DOLA|MIM)$/i;

/* ---- the site's own maths, lifted verbatim ---- */
function loadMaths() {
  const html = fs.readFileSync(PAGE, 'utf8');
  const m = html.match(/var FEEQ = \(function\(\)\{[\s\S]*?\n\}\)\(\);/);
  if (!m) throw new Error('could not find FEEQ in index.html — did the page change shape?');
  const box = {};
  new Function('box', m[0].replace('var FEEQ = ', 'box.FEEQ = '))(box);
  if (!box.FEEQ || !box.FEEQ.ok) throw new Error('FEEQ loaded but is not usable here');
  return box.FEEQ;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json;version=20230302' } });
      if (r.status === 429) { await sleep(4000 * (i + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { await sleep(1500 * (i + 1)); }
  }
  return null;
}

/* Which exchanges to ask for by name, per chain. The plain top-pools list is
   ranked by size and is almost entirely v3, so v2 pairs never surfaced — the
   first run offered three of them out of 121 candidates. Asking the v2 exchange
   directly is the only way to see them. Anything that 404s or returns nothing
   simply contributes no candidates, so a wrong guess here costs coverage rather
   than correctness. */
const NAMED_DEXES = {
  /* Ethereum only, and Uniswap only. The v2 endpoint holds one confirmed data
     source and it is Uniswap's, so pairs from anywhere else would be fetched and
     then fail — wasted calls and a log full of noise.
     SushiSwap is deliberately absent for a second reason worth remembering: its
     pairs charge the same 0.3% but only 0.25% reaches the liquidity provider,
     the rest going to stakers. Measuring them as Uniswap pairs would overstate
     what an LP earned by a fifth. Adding Sushi means adding its own data source
     AND its own fee split, not just its name to this list. */
  eth: ['uniswap_v2'],
  base: [],
  arbitrum: [],
  optimism: [],
  polygon_pos: [],
  avax: []
};

/* Candidate pools, biggest first. GeckoTerminal is free and unkeyed, so this
   costs nothing; the paid queries only happen for pools that survive filtering. */
async function candidates(net) {
  const out = [];
  const seen = {};
  const take = (j) => {
    for (const d of (j && j.data) || []) {
      const a = d.attributes || {};
      const tvl = Number(a.reserve_in_usd) || 0;
      if (tvl < MIN_TVL) continue;
      const addr = String(a.address || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(addr) || seen[addr]) continue;
      seen[addr] = 1;
      out.push({ address: addr, name: a.name || '', tvl,
                 dex: ((d.relationships || {}).dex || {}).data?.id || '' });
    }
  };

  for (const dex of (NAMED_DEXES[net] || [])) {
    for (const page of [1, 2]) {
      const j = await getJSON(`https://api.geckoterminal.com/api/v2/networks/${net}` +
                              `/dexes/${dex}/pools?page=${page}`);
      if (!j || !j.data || !j.data.length) break;
      take(j);
      await sleep(2500);
    }
  }

  for (const page of [1, 2, 3]) {
    const j = await getJSON(`https://api.geckoterminal.com/api/v2/networks/${net}/pools?page=${page}`);
    take(j);
    await sleep(2500);
  }
  return out.sort((x, y) => y.tvl - x.tvl).slice(0, PER_CHAIN);
}

/* A v2 pair, which is a different animal and a simpler one.

   There is no band, because a v2 position covers every price there is. So there
   is no question of where other people's money sits relative to the trading
   price, no fee record needed, and no accuracy caveat: your share of the pair is
   your share of the fees, exactly. This is the one measurement on the site where
   the easy method is also the right one.

   Impermanent loss still applies, and for a full-range position it has a closed
   form — the position grows with the square root of the product of both price
   changes, while holding grows with their average. The gap between a square root
   and an average IS impermanent loss, which is why it can never be avoided by
   picking a better pool, only out-earned by fees. */
function runV2(days, feeRate) {
  if (days.length < 2) return null;
  const first = days[0], last = days[days.length - 1];
  if (!(first.p0 > 0 && first.p1 > 0 && last.p0 > 0 && last.p1 > 0)) return null;

  let fees = 0, shareSum = 0, shareN = 0;
  for (const d of days) {
    const tvl = d.tvlUSD;
    if (!(tvl > 0)) continue;
    const share = DEPOSIT / (tvl + DEPOSIT);
    fees += (d.volumeUSD || 0) * feeRate * share;
    shareSum += share; shareN++;
  }
  if (!isFinite(fees)) return null;

  const k0 = last.p0 / first.p0, k1 = last.p1 / first.p1;
  if (!(k0 > 0) || !(k1 > 0)) return null;

  const pos = DEPOSIT * Math.sqrt(k0 * k1);
  const hold = DEPOSIT / 2 * k0 + DEPOSIT / 2 * k1;
  if (!(hold > 0)) return null;

  return {
    vsHold: +((((pos + fees) / hold) - 1) * 100).toFixed(2),
    feesUSD: Math.round(fees),
    inRangePct: 100,                       /* always, by construction */
    share: shareN ? shareSum / shareN : 0
  };
}

/* One position, one band, one stretch of days. Returns how it finished against
   simply holding the two tokens it started as. */
function runBand(FEEQ, rows, d0, d1, widthPct) {
  if (rows.length < 2) return null;
  const first = rows[0], last = rows[rows.length - 1];
  if (!(first.p0 > 0 && first.p1 > 0 && last.p0 > 0 && last.p1 > 0)) return null;

  const P0 = FEEQ.priceAtTick(Number(first.tick));
  const P1 = FEEQ.priceAtTick(Number(last.tick));
  if (!(P0 > 0) || !(P1 > 0)) return null;

  const w = widthPct / 100;
  const Plo = P0 * (1 - w), Phi = P0 * (1 + w);
  if (!(Phi > Plo)) return null;

  const valT1 = (DEPOSIT / first.p1) * Math.pow(10, d1);
  const L = FEEQ.liquidityForValue(valT1, P0, Plo, Phi);
  if (!(L > 0) || !isFinite(L)) return null;

  const inAmt = FEEQ.amountsFor(L, P0, Plo, Phi);
  const outAmt = FEEQ.amountsFor(L, P1, Plo, Phi);
  const t0 = Math.pow(10, d0), t1 = Math.pow(10, d1);

  /* what those same starting tokens would be worth if you had just kept them */
  const hold = (inAmt.a0 / t0) * last.p0 + (inAmt.a1 / t1) * last.p1;
  if (!(hold > 0)) return null;

  const pos = (outAmt.a0 / t0) * last.p0 + (outAmt.a1 / t1) * last.p1;

  const walk = FEEQ.walk(rows, L, FEEQ.tickAtPrice(Plo), FEEQ.tickAtPrice(Phi));
  const fees = (walk.f0 / t0) * last.p0 + (walk.f1 / t1) * last.p1;
  if (!isFinite(fees)) return null;

  const total = pos + fees;
  const seen = walk.inN + walk.outN;
  return {
    vsHold: +(((total / hold) - 1) * 100).toFixed(2),
    feesUSD: Math.round(fees),
    inRangePct: seen ? Math.round((walk.inN / seen) * 100) : 0,
    share: walk.share            /* fraction of the pool this position would be */
  };
}

async function assessV2(chain, pool) {
  const from = Math.floor(Date.now() / 1000) - YEAR * 86400;
  const j = await getJSON(`${SITE}/api/pool-v2?chain=${chain}` +
                          `&address=${pool.address}&from=${from}`);
  if (!j) return { rejected: 'v2 endpoint did not answer' };
  if (j.error) return { rejected: 'v2 endpoint said: ' + j.error };
  if (j.source !== 'subgraph-v2') return { rejected: 'v2 endpoint returned an unexpected shape' };
  const days = (j.days || []).filter(d => d.p0 > 0 && d.p1 > 0);
  if (days.length < MIN_DAYS) {
    return { rejected: 'v2 pair had only ' + days.length + ' usable days of ' +
                       (j.rawRows || 0) + ' rows' };
  }

  const feeRate = j.pool.feeTier / 1000000;
  const recent = days.slice(-DAYS);
  const r = runV2(recent, feeRate);
  if (!r) return { rejected: 'v2 pair could not be priced' };
  if (r.share > MAX_SHARE) {
    return { rejected: 'position would be ' + (r.share * 100).toFixed(1) + '% of this pair' };
  }
  if (Math.abs(r.vsHold) > MAX_PLAUSIBLE) {
    return { rejected: 'implausible result, ' + r.vsHold + '% \u2014 not published' };
  }

  const quarters = [];
  const qLen = Math.floor(YEAR / QUARTERS);
  for (let q = QUARTERS - 1; q >= 0; q--) {
    const end = Math.floor(Date.now() / 1000) - q * qLen * 86400;
    const slice = days.filter(d => d.t >= end - qLen * 86400 && d.t <= end);
    if (slice.length < 30) { quarters.push(null); continue; }
    const qr = runV2(slice, feeRate);
    quarters.push(qr ? qr.vsHold > 0 : null);
  }

  const s0 = j.pool.token0.symbol || '?', s1 = j.pool.token1.symbol || '?';
  /* Every band carries the same figure because there are no bands. The page
     reads `version` and shows one number instead of three. */
  const bands = {};
  for (const b of BANDS) bands[b] = r;

  return {
    chain, address: pool.address, dex: pool.dex, version: 'v2',
    pair: `${s0}/${s1}`,
    feeTier: j.pool.feeTier / 10000,
    tvl: Math.round(pool.tvl),
    stable: STABLES.test(s0) && STABLES.test(s1),
    oneStable: STABLES.test(s0) !== STABLES.test(s1),
    tokens: [s0.toUpperCase(), s1.toUpperCase()],
    days: recent.length,
    bands, quarters,
    quartersWon: quarters.filter(x => x === true).length,
    quartersRated: quarters.filter(x => x !== null).length
  };
}

async function assess(chain, pool, FEEQ) {
  const from = Math.floor(Date.now() / 1000) - YEAR * 86400;
  const j = await getJSON(`${SITE}/api/pool?span=day&chain=${chain}` +
                          `&address=${pool.address}&from=${from}`);
  /* No record, wrong kind of pool, or too thin a history: it does not go in the
     list at all. A leaderboard padded with estimates is the thing we are against. */
  if (!j || j.error || j.source !== 'subgraph') {
    return { rejected: 'no fee record', quiet: true };
  }
  const rows = (j.hours || []).filter(r => r.p0 > 0 && r.p1 > 0);
  if (rows.length < MIN_DAYS) {
    return { rejected: 'only ' + rows.length + ' days of usable history', quiet: true };
  }

  const d0 = j.pool.token0.decimals, d1 = j.pool.token1.decimals;
  const s0 = j.pool.token0.symbol || '?', s1 = j.pool.token1.symbol || '?';

  /* Note what this chain's gas token is worth, taken from a pool that trades it.
     Cheaper and more consistent than asking a price API separately. */
  const last = rows[rows.length - 1], nat = NATIVE[chain];
  if (nat && last) {
    var np = nat.test(s0) ? last.p0 : (nat.test(s1) ? last.p1 : 0);
    /* A sanity band, because a bad price here silently poisons every gas figure
       on the chain. Nothing on these chains has a gas token worth under a cent
       or over a hundred thousand dollars. */
    if (np > 0.01 && np < 100000 && !NATIVE_PX[chain]) {
      NATIVE_PX[chain] = np;
      console.error(`  native price ${chain}: $${np.toFixed(2)} (from ${s0}/${s1})`);
    }
  }

  const recent = rows.slice(-DAYS);
  if (recent.length < MIN_DAYS) {
    return { rejected: 'not enough recent history', quiet: true };
  }

  const bands = {};
  let worstShare = 0;
  for (const b of BANDS) {
    const r = runBand(FEEQ, recent, d0, d1, b);
    if (!r) return { rejected: 'could not be priced at \u00b1' + b + '%', quiet: true };
    worstShare = Math.max(worstShare, r.share || 0);
    bands[b] = r;
  }
  /* Too big a fish for this pond — see MAX_SHARE. Reported rather than silently
     dropped, because a wave of these means the pool universe needs rethinking,
     not that the filter is working. */
  if (worstShare > MAX_SHARE) {
    return { rejected: 'position would be ' + (worstShare * 100).toFixed(1) +
                       '% of this pool\'s liquidity' };
  }
  const wild = BANDS.find(b => Math.abs(bands[b].vsHold) > MAX_PLAUSIBLE);
  if (wild) {
    return { rejected: 'implausible result, ' + bands[wild].vsHold + '% at \u00b1' + wild +
                       '% (share ' + (worstShare * 100).toFixed(3) +
                       '%, fees $' + bands[wild].feesUSD + ') — not published' };
  }

  /* Quarter by quarter, at the middle band. One good quarter is luck; four is
     a property of the pool. This is what the list actually sorts on. */
  const quarters = [];
  const qLen = Math.floor(YEAR / QUARTERS);
  for (let q = QUARTERS - 1; q >= 0; q--) {
    const end = Math.floor(Date.now() / 1000) - q * qLen * 86400;
    const start = end - qLen * 86400;
    const slice = rows.filter(r => r.t >= start && r.t <= end);
    if (slice.length < 30) { quarters.push(null); continue; }
    const r = runBand(FEEQ, slice, d0, d1, 25);
    quarters.push(r ? r.vsHold > 0 : null);
  }

  return {
    chain, address: pool.address, dex: pool.dex, version: 'v3',
    pair: `${s0}/${s1}`,
    feeTier: j.pool.feeTier / 10000,
    tvl: Math.round(pool.tvl),
    stable: STABLES.test(s0) && STABLES.test(s1),
    oneStable: STABLES.test(s0) !== STABLES.test(s1),
    tokens: [s0.toUpperCase(), s1.toUpperCase()],
    days: recent.length,
    bands,
    quarters,
    quartersWon: quarters.filter(x => x === true).length,
    quartersRated: quarters.filter(x => x !== null).length
  };
}

function esc(x) {
  return String(x).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* One page per pool.

   This is the part that makes the site findable. Nobody searches "liquidity
   pool calculator" — they search "is the ETH USDC pool worth it", which is a
   question with a specific pool in it, and a question this site can answer with
   a measured number rather than an opinion. A page per pool is the only shape
   that matches how people actually ask.

   Written as flat files rather than served dynamically: they change once a
   night, so making a visitor wait on a lookup would be work for nothing, and a
   static file cannot fail at the moment a crawler arrives. */
function poolPage(p, generated, windowInfo) {
  const v = p.bands['25'].vsHold;
  const won = v > 0;
  const title = `Is the ${p.pair} ${p.feeTier}% pool on ${p.chain} worth it?`;
  const verdict = won
    ? `Over the last ${windowInfo.days} days it beat simply holding the two tokens by ${v.toFixed(1)}%.`
    : `Over the last ${windowInfo.days} days it lost to simply holding the two tokens by ${Math.abs(v).toFixed(1)}%.`;
  const desc = `${verdict} Measured from the pool's own fee record, not an advertised rate.`;
  const url = `https://lpvshodl.com/pool/${p.chain}/${p.address}/`;
  const backtest = `/?a=${p.address}&c=${p.chain}&lo=25&up=25&q=${windowInfo.deposit}`;

  const bandRows = (p.version === 'v2')
    ? `<tr><td>Full range</td><td class="${won ? 'up' : 'down'}">${v > 0 ? '+' : ''}${v.toFixed(1)}%</td>
         <td>$${p.bands['25'].feesUSD.toLocaleString()}</td><td>100%</td></tr>`
    : [10, 25, 50].map(b => {
        const x = p.bands[String(b)];
        return `<tr><td>&plusmn;${b}%</td><td class="${x.vsHold > 0 ? 'up' : 'down'}">${x.vsHold > 0 ? '+' : ''}${x.vsHold.toFixed(1)}%</td>
          <td>$${x.feesUSD.toLocaleString()}</td><td>${x.inRangePct}%</td></tr>`;
      }).join('');

  const why = (p.version === 'v2')
    ? `<p>This is a v2 pair, so there is no range to set &mdash; your money covers every
       price and earns a fixed share of every trade. That makes the fee side exact rather
       than estimated. What it does not remove is impermanent loss: as the two prices move
       apart, the pool sells whichever token is rising, and you end up with less of the
       winner than if you had simply held both.</p>`
    : `<p>This is a concentrated pool, so you pick a price range and only earn while the
       price is inside it. At &plusmn;25% this position was in range
       ${p.bands['25'].inRangePct}% of the year. The rest of the time it earned nothing
       while still carrying the full effect of the price moving &mdash; which is usually
       the difference between a pool that beats holding and one that does not.</p>`;

  const faq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [{
      '@type': 'Question',
      name: title,
      acceptedAnswer: { '@type': 'Answer', text: desc }
    }]
  };

  return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<script>
(function(){try{
  var saved=localStorage.getItem('lvh-theme');
  var dark=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme',saved||(dark?'dark':'light'));
}catch(e){}})();
</script>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} &mdash; LPvsHODL</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,800&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#F1F3F5;--card:#FFFFFF;--ink:#10141C;--soft:#5F6B7A;--rule:#E1E5EA;
  --accent:#3B2BD0;--good:#12764C;--bad:#B3372A}
[data-theme="dark"]{--bg:#0B0D13;--card:#151A23;--ink:#ECEFF4;--soft:#8E99A8;--rule:#252C39;
  --accent:#7D6DFF;--good:#33B682;--bad:#E8705F}
*{box-sizing:border-box}html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font-family:"IBM Plex Sans",system-ui,sans-serif;
  font-size:15px;line-height:1.6}
.wrap{max-width:760px;margin:0 auto;padding:22px 20px 48px}
a{color:var(--accent)}
.brand{font-family:"Bricolage Grotesque",sans-serif;font-weight:800;font-size:17px;
  text-decoration:none;color:var(--ink);letter-spacing:-.02em}
.brand b{color:var(--accent)}
h1{font-family:"Bricolage Grotesque",sans-serif;font-weight:800;letter-spacing:-.03em;
  font-size:clamp(26px,4.6vw,40px);line-height:1.08;margin:22px 0 12px}
.verdict{background:var(--card);border:1px solid var(--rule);border-radius:14px;
  padding:18px 20px;margin:18px 0}
.big{font-family:"Bricolage Grotesque",sans-serif;font-weight:800;
  font-size:clamp(24px,4vw,34px);line-height:1.1;color:var(--${won ? 'good' : 'bad'})}
.sub{color:var(--soft);font-size:14px;margin-top:6px}
table{width:100%;border-collapse:collapse;margin:18px 0;font-family:"IBM Plex Mono",monospace;
  font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--rule)}
th{color:var(--soft);font-weight:500}
.up{color:var(--good)}.down{color:var(--bad)}
.cta{display:inline-block;margin:6px 8px 0 0;padding:9px 14px;border:1px solid var(--rule);
  border-radius:9px;text-decoration:none;font-size:14px}
.cta.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
.foot{color:var(--soft);font-size:13px;margin-top:26px}
</style>
<script type="application/ld+json">${JSON.stringify(faq)}</script>
</head>
<body><div class="wrap">
<a class="brand" href="/">LP<b>vs</b>HODL</a>
<h1>${esc(title)}</h1>

<div class="verdict">
  <div class="big">${won ? 'Beat holding' : 'Lost to holding'} by ${Math.abs(v).toFixed(1)}%</div>
  <div class="sub">$${windowInfo.deposit.toLocaleString()} over ${windowInfo.days} days, at &plusmn;25%.
    Fees from the pool's own record.</div>
</div>

<table>
<tr><th>Range</th><th>vs holding</th><th>Fees earned</th><th>In range</th></tr>
${bandRows}
</table>

<p>It beat holding in ${p.quartersWon} of ${p.quartersRated} quarters over the year.
Fee tier ${p.feeTier}%, on ${esc(p.chain)}.</p>

${why}

<p><a class="cta primary" href="${backtest}">Run this pool with your own numbers</a>
<a class="cta" href="/best-pools/">See how every pool compared</a></p>

<p class="foot">These are past results for one fixed strategy, not a recommendation &mdash;
a pool that beat holding last year can lose the next. Worked out ${esc(generated.slice(0, 10))}.
<a href="/">Back to the backtester</a>.</p>
</div></body></html>
`;
}

function writePages(payload) {
  const w = payload.window;
  let written = 0;
  for (const p of payload.pools) {
    const dir = path.join(SITE_DIR, 'pool', p.chain, p.address);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), poolPage(p, payload.generated, w));
    written++;
  }

  /* Rewritten whole each night, so the core pages are listed explicitly above
     rather than read back out of the old file. */
  const urls = CORE_PAGES.map(u => `https://lpvshodl.com${u}`)
    .concat(payload.pools.map(p => `https://lpvshodl.com/pool/${p.chain}/${p.address}/`));
  const today = payload.generated.slice(0, 10);
  fs.writeFileSync(path.join(SITE_DIR, 'sitemap.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(u => `  <url><loc>${u}</loc><lastmod>${today}</lastmod></url>`).join('\n') +
    '\n</urlset>\n');

  return written;
}

/* Current gas price per chain, in dollars per transaction. Anything that fails
   is left out rather than guessed at. */
async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] })
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j && j.error) throw new Error(j.error.message || 'rpc error');
  return j && j.result;
}

/* A busy-ish price over a window of blocks, falling back to the instantaneous
   one if the chain will not answer for history. */
async function typicalGasWei(url) {
  try {
    const h = await rpc(url, 'eth_feeHistory',
      ['0x' + FEE_BLOCKS.toString(16), 'latest', [FEE_PCTL]]);
    const base = (h && h.baseFeePerGas || []).map(x => parseInt(x, 16)).filter(isFinite);
    const tips = (h && h.reward || []).map(r => parseInt(r && r[0], 16)).filter(isFinite);
    if (base.length) {
      const sorted = base.slice().sort((a, b) => a - b);
      const b = sorted[Math.floor(sorted.length * FEE_PCTL / 100)] || sorted[sorted.length - 1];
      const tipSorted = tips.slice().sort((a, b2) => a - b2);
      const tip = tipSorted.length ? (tipSorted[Math.floor(tipSorted.length / 2)] || 0) : 0;
      return { wei: b + tip, how: FEE_PCTL + 'th pct of ' + base.length + ' blocks' };
    }
  } catch (e) { /* fall through */ }
  const w = parseInt(await rpc(url, 'eth_gasPrice'), 16);
  return { wei: w, how: 'instant' };
}

async function gasPrices(nativeUSD) {
  const out = {};
  for (const [chain, url] of Object.entries(RPCS)) {
    const px = nativeUSD[chain];
    if (!(px > 0)) { console.error(`  gas ${chain}: no native token price, skipped`); continue; }
    try {
      const got = await typicalGasWei(url);
      const wei = got.wei;
      if (!isFinite(wei) || wei <= 0) { console.error(`  gas ${chain}: bad reply`); continue; }
      const usd = (wei * GAS_UNITS / 1e18) * px;
      out[chain] = +usd.toFixed(usd < 1 ? 4 : 2);
      /* Everything that went into the figure, because a wrong gas price and a
         wrong token price produce the same wrong dollar amount and there is no
         telling them apart afterwards. */
      console.error(`  gas ${chain}: ${(wei / 1e9).toFixed(4)} gwei (${got.how}) ` +
                    `x ${GAS_UNITS} units x $${px.toFixed(2)}/native -> $${out[chain]}` +
                    (L2S.has(chain) ? '  [execution only, excludes L1 data fee]' : ''));
      /* Ethereum mainnet has not been this cheap in its history. If this fires,
         either the RPC answered with something odd or the native price is wrong. */
      if (chain === 'ethereum' && usd < 0.20) {
        console.error(`  !! ethereum gas of $${out[chain]} is implausible — ` +
                      `check the gwei and native price above`);
      }
    } catch (e) {
      console.error(`  gas ${chain}: ${e.message}`);
    }
    await sleep(300);
  }
  return out;
}

async function main() {
  const FEEQ = loadMaths();
  const pools = [];
  const why = {};
  let looked = 0, skipped = 0;
  const note = (reason) => { const k = String(reason).replace(/[\d.]+/g, 'N');
                             why[k] = (why[k] || 0) + 1; };

  for (const [net, chain] of Object.entries(CHAINS)) {
    let list = [];
    try { list = await candidates(net); }
    catch (e) { console.error(`${chain}: could not list pools — ${e.message}`); continue; }
    console.error(`${chain}: ${list.length} candidates`);
    for (const p of list) {
      looked++;
      try {
        /* v2 and v3 are measured differently because they are different
           products; the dex tag says which. */
        const isV2 = /(^|[_-])v2$/.test(String(p.dex || ''));
        const r = isV2 ? await assessV2(chain, p) : await assess(chain, p, FEEQ);
        if (r && r.rejected) {
          skipped++; note(r.rejected);
          if (!r.quiet) console.error(`  dropped ${p.name || p.address}: ${r.rejected}`);
        }
        else if (r) {
          pools.push(r);
          const b = r.bands[25];
          console.error(`  kept ${r.pair} ${r.chain} ${r.feeTier}% ` +
            `| vsHold ${b.vsHold}% | fees $${b.feesUSD} ` +
            `| share ${(b.share * 100).toFixed(3)}% | in range ${b.inRangePct}%`);
        }
        else { skipped++; note('unknown'); }
      } catch (e) { skipped++; console.error(`  failed ${p.address}: ${e.message}`); }
      await sleep(400);
    }
  }

  /* Sort by the year's result at the middle band, consistency only as a
     tiebreak. This used to rank by consistency first, so that a single
     spectacular quarter could not top the list — a sound worry when the
     headline covered 90 days. It stopped making sense once the window became a
     full year, because a year already contains all four quarters: a pool that
     blew up in one of them shows a worse annual figure without any help. All
     the tier sort did was put a pool that gained nothing above one that gained
     twelve percent, which reads as broken and is impossible to defend. The
     quarter record stays visible next to each pool, where it belongs — as a
     sign of how reliable the number is, not as the ranking itself. */
  pools.sort((a, b) =>
    (b.bands[25].vsHold - a.bands[25].vsHold) || (b.quartersWon - a.quartersWon));

  console.error('\nreading current gas prices:');
  /* ETH is ETH wherever it is spent, so one price covers every chain that pays
     gas in it. Otherwise a chain whose pools were all filtered out silently
     loses its gas figure. */
  const ethPx = ETH_GAS_CHAINS.map(c => NATIVE_PX[c]).find(p => p > 0);
  if (ethPx > 0) {
    for (const c of ETH_GAS_CHAINS) if (!(NATIVE_PX[c] > 0)) {
      NATIVE_PX[c] = ethPx;
      console.error(`  native price ${c}: $${ethPx.toFixed(2)} (ETH, shared)`);
    }
  }
  const gas = await gasPrices(NATIVE_PX);

  const won = pools.filter(p => p.bands[25].vsHold > 0).length;
  const payload = {
    generated: new Date().toISOString(),
    window: { days: DAYS, deposit: DEPOSIT, bands: BANDS, sortBand: 25 },
    /* Dollars per transaction, read from each chain at the time of the run.
       A starting point for the minimum-size page, not a promise. */
    gas: { perTx: gas, gasUnits: GAS_UNITS, measuredAt: new Date().toISOString() },
    summary: { tested: pools.length, beatHolding: won, lostToHolding: pools.length - won,
               examined: looked, skipped, skipReasons: why },
    pools
  };

  if (!pools.length) {
    console.error('no pools survived — refusing to overwrite a good file with an empty one');
    process.exit(1);
  }
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));
  const pages = writePages(payload);
  console.error(`wrote ${pages} pool pages and a sitemap covering ` +
                `${pages + CORE_PAGES.length} URLs`);
  console.error(`\nwrote ${OUT}: ${pools.length} pools, ${won} beat holding, ${pools.length - won} lost`);
  console.error('why the rest were dropped:');
  Object.entries(why).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.error(`  ${String(v).padStart(4)}  ${k}`));
}

main().catch(e => { console.error(e); process.exit(1); });
