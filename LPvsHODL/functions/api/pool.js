/**
 * GET /api/pool?chain=base&address=0x...&from=<unix>
 *
 * Returns hourly snapshots of a Uniswap-v3-style pool, including the fee
 * growth trackers needed to compute exactly what a position earned.
 *
 * Why this exists: GeckoTerminal gives price and volume, which is enough to
 * *estimate* fees but not to know them. Fees in a concentrated pool are split
 * by liquidity density at the active tick, not by dollars, so the only honest
 * source is the chain's own accounting. That lives in the subgraph.
 *
 * The Graph's gateway requires an API key, which cannot sit in client-side
 * JavaScript, so the request is proxied here.
 *
 * SETUP
 *   1. Get a key at https://thegraph.com/studio/apikeys/
 *   2. Cloudflare Pages -> Settings -> Variables and secrets:
 *        GRAPH_API_KEY = <your key>   (as a secret, not plain text)
 *   3. Fill in SUBGRAPHS below. Deployment IDs are on The Graph Explorer:
 *        https://thegraph.com/explorer  -> search "uniswap v3 <chain>"
 *      Copy the ID that looks like 5zvR82... from the subgraph's page.
 *      Any chain left as null simply falls back to the estimate.
 *
 * Every failure path returns JSON with an `error` code and HTTP 200-or-4xx
 * rather than throwing, so the site can quietly fall back to the old
 * estimate instead of breaking.
 */

/* Deployment IDs, per chain. These MUST be filled in by hand — they are not
   guessable and a wrong one fails silently with empty data. */
const SUBGRAPHS = {
  /* From Uniswap's own docs: https://docs.uniswap.org/api/subgraph/overview
     Note their caveat — these are public deployments, not necessarily
     maintained by Uniswap Labs. Confirm a deployment is actively indexing
     before relying on it. */
  ethereum: '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV',
  base:     'HMuAwufqZ1YCRmzL2SfHTVkzZovC9VL2UAKhjvRqKiR1',
  arbitrum: null,
  optimism: null,
  polygon:  null,
  bnb:      null,
  avalanche: null
};

const GATEWAY = 'https://gateway.thegraph.com/api';
const PAGE = 1000;          /* The Graph caps entities per request */
const MAX_PAGES = 8;        /* 8000 hours ~ 11 months, plenty for a 6mo window */
const CACHE_SECONDS = 900;  /* pool data changes hourly; 15 min is generous */

/* Only successful payloads are cacheable. An error told the browser to
   remember it for fifteen minutes once, which made a fixed deployment look
   broken — errors now carry no-store so a retry always hits fresh code. */
function json(body, status, extraHeaders) {
  var ok = !body || !body.error;
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': ok ? ('public, max-age=' + CACHE_SECONDS)
                          : 'no-store, max-age=0'
    }, extraHeaders || {})
  });
}

const POOL_QUERY = `
query Pool($id: ID!) {
  pool(id: $id) {
    id
    createdAtTimestamp
    feeTier
    liquidity
    tick
    sqrtPrice
    totalValueLockedUSD
    token0 { id symbol decimals }
    token1 { id symbol decimals }
  }
}`;

const HOURS_QUERY = `
query Hours($pool: String!, $after: Int!) {
  poolHourDatas(
    first: ${PAGE}
    orderBy: periodStartUnix
    orderDirection: asc
    where: { pool: $pool, periodStartUnix_gt: $after }
  ) {
    periodStartUnix
    tick
    liquidity
    sqrtPrice
    feeGrowthGlobal0X128
    feeGrowthGlobal1X128
    volumeUSD
    tvlUSD
    feesUSD
  }
}`;

const DAYS_QUERY = `
query Days($pool: String!, $after: Int!) {
  poolDayDatas(
    first: 1000
    orderBy: date
    orderDirection: asc
    where: { pool: $pool, date_gt: $after }
  ) {
    date
    tick
    liquidity
    sqrtPrice
    feeGrowthGlobal0X128
    feeGrowthGlobal1X128
    volumeUSD
    volumeToken0
    volumeToken1
    tvlUSD
    feesUSD
  }
}`;

/* Daily dollar prices for each token. The hourly pool data carries the price of
   one token against the other but not against the dollar, and a backtest that
   reaches back years needs both. */
const TOKEN_DAYS_QUERY = `
query TokenDays($token: String!, $after: Int!) {
  tokenDayDatas(
    first: 1000
    orderBy: date
    orderDirection: asc
    where: { token: $token, date_gt: $after }
  ) {
    date
    priceUSD
  }
}`;

async function gql(endpoint, query, variables) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) throw new Error('gateway_' + res.status);
  const body = await res.json();
  if (body.errors && body.errors.length) {
    throw new Error('graphql: ' + (body.errors[0].message || 'unknown'));
  }
  return body.data;
}

/* Daily rows are stamped either as a unix timestamp or as a day number
   (timestamp / 86400), depending on which build of the subgraph is deployed.
   Filtering with the wrong one silently matches nothing, so try the timestamp
   first and fall back to the day number, then normalise whatever comes back to
   a plain timestamp. */
/* Dollar-pegged coins, used as an anchor when a subgraph publishes no prices. */
const STABLES = /^(USDC|USDC\.E|USDBC|USDT|USDT0|DAI|TUSD|USDP|PYUSD|FDUSD|LUSD|GUSD|USDD|FRAX|SUSD|USDS|BUSD|CRVUSD|DOLA|MIM)$/i;

/* price of token1 measured in token0, decimals accounted for */
function priceFromTick(tick, d0, d1) {
  return Math.pow(1.0001, Number(tick)) * Math.pow(10, d0 - d1);
}

/* Some subgraphs — especially community builds — never populate daily token
   prices. Rather than give up, fall back:
     1. published prices, when they exist
     2. a dollar stablecoin on one side anchors the other through the tick
     3. failing that, the day's own trading: a swap's dollar value divided by
        the tokens that moved is the price it traded at
   Anything still unpriced is dropped, and the caller is told how many. */
function priceRow(h, published0, published1, stamp, d0, d1, t0Stable, t1Stable) {
  var p0 = published0[stamp] || 0, p1 = published1[stamp] || 0;
  if (p0 > 0 && p1 > 0) return [p0, p1, 'published'];

  var ratio = priceFromTick(h.tick, d0, d1);   /* token1 per token0 */
  if (t1Stable && ratio > 0) return [ratio, 1, 'stable'];
  if (t0Stable && ratio > 0) return [1, 1 / ratio, 'stable'];

  var v = Number(h.volumeUSD) || 0;
  var v0 = Number(h.volumeToken0) || 0, v1 = Number(h.volumeToken1) || 0;
  if (v > 0 && v0 > 0 && v1 > 0) return [v / v0, v / v1, 'traded'];

  return [0, 0, 'none'];
}

async function tryDays(endpoint, query, key, idVars, afterTs, maxPages) {
  let rows = await pageAll(endpoint, query, key,
      Object.assign({}, idVars, { after: afterTs }), 'date', maxPages);
  if (rows.length) return { rows: rows, unit: 'ts' };

  rows = await pageAll(endpoint, query, key,
      Object.assign({}, idVars, { after: Math.floor(afterTs / 86400) }), 'date', maxPages);
  return { rows: rows, unit: 'day' };
}
function dayStart(v, unit) {
  const n = Number(v);
  const ts = (unit === 'day' || n < 1000000) ? n * 86400 : n;
  return Math.floor(ts / 86400) * 86400;
}

async function pageAll(endpoint, query, key, vars, cursorField, maxPages) {
  let out = [], after = vars.after || 0;
  for (let i = 0; i < maxPages; i++) {
    const d = await gql(endpoint, query, Object.assign({}, vars, { after: after }));
    const batch = (d && d[key]) || [];
    out = out.concat(batch);
    if (batch.length < PAGE) break;
    after = parseInt(batch[batch.length - 1][cursorField], 10);
  }
  return out;
}

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const chain = (url.searchParams.get('chain') || '').toLowerCase().trim();
    const address = (url.searchParams.get('address') || '').toLowerCase().trim();
    const from = parseInt(url.searchParams.get('from'), 10) || 0;

    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      return json({ error: 'bad_address' }, 400);
    }
    const subgraphId = Object.prototype.hasOwnProperty.call(SUBGRAPHS, chain)
      ? SUBGRAPHS[chain] : undefined;
    if (!subgraphId) {
      /* Not an error the user needs to see — the site falls back quietly. */
      return json({ error: 'chain_unsupported', chain: chain }, 200);
    }
    const key = context.env && context.env.GRAPH_API_KEY;
    if (!key) return json({ error: 'not_configured' }, 200);

    /* Serve from the edge cache when we can — the same popular pools get
       requested over and over, and every miss costs a paid query. */
    const cacheKey = new Request(url.toString(), { method: 'GET' });
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const endpoint = GATEWAY + '/' + key + '/subgraphs/id/' + subgraphId;

    const meta = await gql(endpoint, POOL_QUERY, { id: address });
    if (!meta || !meta.pool) return json({ error: 'pool_not_found' }, 200);

    /* Hourly is precise but heavy; daily is the only sane way to carry years of
       history to a phone. The caller picks. Either way the cursor is the
       timestamp, since skipping would drift if new rows land mid-fetch. */
    const daily = (url.searchParams.get('span') || 'hour') === 'day';
    const after0 = from > 0 ? from - 1 : 0;

    let rows, prices0 = null, prices1 = null, dayUnit = 'ts';
    if (daily) {
      const [dd, t0d, t1d] = await Promise.all([
        tryDays(endpoint, DAYS_QUERY, 'poolDayDatas', { pool: address }, after0, 4),
        tryDays(endpoint, TOKEN_DAYS_QUERY, 'tokenDayDatas', { token: meta.pool.token0.id }, after0, 4),
        tryDays(endpoint, TOKEN_DAYS_QUERY, 'tokenDayDatas', { token: meta.pool.token1.id }, after0, 4)
      ]);
      rows = dd.rows;
      dayUnit = dd.unit;
      prices0 = {}; t0d.rows.forEach(function (r) { prices0[dayStart(r.date, t0d.unit)] = Number(r.priceUSD); });
      prices1 = {}; t1d.rows.forEach(function (r) { prices1[dayStart(r.date, t1d.unit)] = Number(r.priceUSD); });
    } else {
      rows = await pageAll(endpoint, HOURS_QUERY, 'poolHourDatas',
                           { pool: address, after: after0 }, 'periodStartUnix', MAX_PAGES);
    }
    const hours = rows;

    const payload = {
      source: 'subgraph',
      chain: chain,
      span: daily ? 'day' : 'hour',
      pool: {
        address: meta.pool.id,
        createdAt: Number(meta.pool.createdAtTimestamp) || 0,
        feeTier: Number(meta.pool.feeTier),
        tick: meta.pool.tick === null ? null : Number(meta.pool.tick),
        liquidity: meta.pool.liquidity,
        tvlUSD: Number(meta.pool.totalValueLockedUSD),
        token0: {
          address: meta.pool.token0.id,
          symbol: meta.pool.token0.symbol,
          decimals: Number(meta.pool.token0.decimals)
        },
        token1: {
          address: meta.pool.token1.id,
          symbol: meta.pool.token1.symbol,
          decimals: Number(meta.pool.token1.decimals)
        }
      },
      /* Ascending. Each entry is the state at the END of that hour, which is
         what makes consecutive differences meaningful. */
      rawDayRows: daily ? rows.length : undefined,
      priceSources: undefined,   /* filled in below when daily */
      hours: hours.map(function (h) {
        const stamp = daily ? dayStart(h.date, dayUnit) : Number(h.periodStartUnix);
        const row = {
          t: stamp,
          tick: h.tick === null ? null : Number(h.tick),
          liquidity: h.liquidity,
          feeGrowthGlobal0X128: h.feeGrowthGlobal0X128,
          feeGrowthGlobal1X128: h.feeGrowthGlobal1X128,
          volumeUSD: Number(h.volumeUSD),
          tvlUSD: Number(h.tvlUSD),
          feesUSD: Number(h.feesUSD)
        };
        if (daily) {
          const pr = priceRow(h, prices0, prices1, stamp,
                              Number(meta.pool.token0.decimals),
                              Number(meta.pool.token1.decimals),
                              STABLES.test(meta.pool.token0.symbol || ''),
                              STABLES.test(meta.pool.token1.symbol || ''));
          row.p0 = pr[0]; row.p1 = pr[1]; row.pxFrom = pr[2];
        }
        return row;
      }).filter(function (h) {
        if (h.tick === null) return false;
        if (daily && !(h.p0 > 0 && h.p1 > 0)) return false;  /* unusable without prices */
        return true;
      })
    };

    if (daily) {
      const tally = {};
      payload.hours.forEach(function (h) { tally[h.pxFrom] = (tally[h.pxFrom] || 0) + 1; });
      payload.priceSources = tally;
    }

    const out = json(payload);
    context.waitUntil(cache.put(cacheKey, out.clone()));
    return out;

  } catch (e) {
    /* Never take the page down for this. The client treats any error as
       "use the estimate instead". */
    return json({ error: 'fetch_failed', detail: String(e && e.message || e) }, 200);
  }
}
