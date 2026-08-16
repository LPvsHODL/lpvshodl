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

const DEPOSIT = 10000;          /* every pool tested at the same size */
const BANDS = [10, 25, 50];     /* percent either side of the entry price */
const DAYS = 90;                /* headline window */
const YEAR = 365;               /* for the quarter-by-quarter record */
const QUARTERS = 4;
const MIN_TVL = 250000;         /* below this the numbers stop meaning anything */
const MIN_DAYS = 60;            /* too little history to judge */
const PER_CHAIN = 40;

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

/* Candidate pools, biggest first. GeckoTerminal is free and unkeyed, so this
   costs nothing; the paid queries only happen for pools that survive filtering. */
async function candidates(net) {
  const out = [];
  for (const page of [1, 2]) {
    const j = await getJSON(`https://api.geckoterminal.com/api/v2/networks/${net}/pools?page=${page}`);
    for (const d of (j && j.data) || []) {
      const a = d.attributes || {};
      const tvl = Number(a.reserve_in_usd) || 0;
      if (tvl < MIN_TVL) continue;
      const addr = String(a.address || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(addr)) continue;
      out.push({
        address: addr,
        name: a.name || '',
        tvl,
        dex: ((d.relationships || {}).dex || {}).data?.id || ''
      });
    }
    await sleep(2500);
  }
  return out.sort((x, y) => y.tvl - x.tvl).slice(0, PER_CHAIN);
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
    inRangePct: seen ? Math.round((walk.inN / seen) * 100) : 0
  };
}

async function assess(chain, pool, FEEQ) {
  const from = Math.floor(Date.now() / 1000) - YEAR * 86400;
  const j = await getJSON(`${SITE}/api/pool?span=day&chain=${chain}` +
                          `&address=${pool.address}&from=${from}`);
  /* No record, wrong kind of pool, or too thin a history: it does not go in the
     list at all. A leaderboard padded with estimates is the thing we are against. */
  if (!j || j.error || j.source !== 'subgraph') return null;
  const rows = (j.hours || []).filter(r => r.p0 > 0 && r.p1 > 0);
  if (rows.length < MIN_DAYS) return null;

  const d0 = j.pool.token0.decimals, d1 = j.pool.token1.decimals;
  const s0 = j.pool.token0.symbol || '?', s1 = j.pool.token1.symbol || '?';

  const recent = rows.slice(-DAYS);
  if (recent.length < MIN_DAYS) return null;

  const bands = {};
  for (const b of BANDS) {
    const r = runBand(FEEQ, recent, d0, d1, b);
    if (!r) return null;
    bands[b] = r;
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
    chain, address: pool.address, dex: pool.dex,
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

async function main() {
  const FEEQ = loadMaths();
  const pools = [];
  let looked = 0, skipped = 0;

  for (const [net, chain] of Object.entries(CHAINS)) {
    let list = [];
    try { list = await candidates(net); }
    catch (e) { console.error(`${chain}: could not list pools — ${e.message}`); continue; }
    console.error(`${chain}: ${list.length} candidates`);
    for (const p of list) {
      looked++;
      try {
        const r = await assess(chain, p, FEEQ);
        if (r) { pools.push(r); console.error(`  kept ${r.pair} ${r.chain}`); }
        else { skipped++; }
      } catch (e) { skipped++; console.error(`  failed ${p.address}: ${e.message}`); }
      await sleep(400);
    }
  }

  /* Sort by consistency first, then by the middle band. A pool that beat holding
     in every quarter outranks one that had a single spectacular run. */
  pools.sort((a, b) =>
    (b.quartersWon - a.quartersWon) || (b.bands[25].vsHold - a.bands[25].vsHold));

  const won = pools.filter(p => p.bands[25].vsHold > 0).length;
  const payload = {
    generated: new Date().toISOString(),
    window: { days: DAYS, deposit: DEPOSIT, bands: BANDS, sortBand: 25 },
    summary: { tested: pools.length, beatHolding: won, lostToHolding: pools.length - won,
               examined: looked, skipped },
    pools
  };

  if (!pools.length) {
    console.error('no pools survived — refusing to overwrite a good file with an empty one');
    process.exit(1);
  }
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));
  console.error(`wrote ${OUT}: ${pools.length} pools, ${won} beat holding`);
}

main().catch(e => { console.error(e); process.exit(1); });
