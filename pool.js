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

    /* Page through hourly snapshots using the timestamp as a cursor. Using
       skip would drift if new hours land mid-fetch. */
    let after = from > 0 ? from - 1 : 0;
    let hours = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const d = await gql(endpoint, HOURS_QUERY, { pool: address, after: after });
      const batch = (d && d.poolHourDatas) || [];
      hours = hours.concat(batch);
      if (batch.length < PAGE) break;
      after = parseInt(batch[batch.length - 1].periodStartUnix, 10);
    }

    const payload = {
      source: 'subgraph',
      chain: chain,
      pool: {
        address: meta.pool.id,
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
      hours: hours.map(function (h) {
        return {
          t: Number(h.periodStartUnix),
          tick: h.tick === null ? null : Number(h.tick),
          liquidity: h.liquidity,
          feeGrowthGlobal0X128: h.feeGrowthGlobal0X128,
          feeGrowthGlobal1X128: h.feeGrowthGlobal1X128,
          volumeUSD: Number(h.volumeUSD),
          tvlUSD: Number(h.tvlUSD),
          feesUSD: Number(h.feesUSD)
        };
      }).filter(function (h) { return h.tick !== null; })
    };

    const out = json(payload);
    context.waitUntil(cache.put(cacheKey, out.clone()));
    return out;

  } catch (e) {
    /* Never take the page down for this. The client treats any error as
       "use the estimate instead". */
    return json({ error: 'fetch_failed', detail: String(e && e.message || e) }, 200);
  }
}
