/**
 * GET /api/pool-v2?chain=ethereum&address=0x...&from=<unix>
 *
 * Daily history for a Uniswap-v2-style pair.
 *
 * Why this is separate from /api/pool: v2 and v3 are different products wearing
 * the same word. A v3 position holds a range, so what it earns depends on where
 * everyone else's money sits relative to the price — which is why v3 needs the
 * pool's own fee record and why an estimate can be wrong by twenty times.
 *
 * A v2 position has no range. Your money is spread across every price there is,
 * so your cut of the fees is simply your share of the pair, and
 *   volume x fee rate x share
 * is not an approximation of the answer, it IS the answer. That is the one place
 * on this site where the easy method is also the correct one, and it is worth
 * saying plainly rather than hiding v2 behind the same caveats as v3.
 *
 * Everything needed comes from the daily rows: reserves give both token prices
 * (a v2 pair holds equal value on each side, so a side's dollar value is half
 * the pair's), reserveUSD gives the size to measure a deposit against, and
 * dailyVolumeUSD gives the fees.
 *
 * SETUP
 *   Uses the same GRAPH_API_KEY secret as /api/pool. Nothing else to configure.
 */

/* Only Ethereum is filled in. Every other chain is deliberately null: v2-style
   pairs exist elsewhere, but no deployment ID for them could be confirmed
   against a live Graph Explorer page, and a wrong ID does not error — it
   returns nothing, which is indistinguishable from a pair with no history.
   An empty slot costs us a chain; a wrong one costs us the truth. */
const SUBGRAPHS = {
  ethereum: 'EYCKATKGBKLWvSfwvBjzfCBmGwYNdVkduYXVivCsLRFu',
  base:     null,
  arbitrum: null,
  optimism: null,
  polygon:  null,
  avalanche: null,
  bnb:      null
};

const GATEWAY = 'https://gateway.thegraph.com/api';
const PAGE = 1000;
const MAX_PAGES = 2;        /* 2000 days is more history than anyone asks for */
const CACHE_SECONDS = 900;

function json(body, status, extra) {
  var ok = !body || !body.error;
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': ok ? ('public, max-age=' + CACHE_SECONDS)
                          : 'no-store, max-age=0'
    }, extra || {})
  });
}

const PAIR_QUERY = `
query Pair($id: ID!) {
  pair(id: $id) {
    id
    createdAtTimestamp
    reserveUSD
    token0 { id symbol decimals }
    token1 { id symbol decimals }
  }
}`;

/* The filter field differs between the original subgraph and its forks, so the
   query is built around whichever one answers. Guessing wrong returns an empty
   list rather than an error — the same silent failure that hid a bug in the v3
   endpoint for weeks — so both are tried before giving up. */
function daysQuery(field) {
  return `
query Days($pair: String!, $after: Int!) {
  pairDayDatas(
    first: ${PAGE}
    orderBy: date
    orderDirection: asc
    where: { ${field}: $pair, date_gt: $after }
  ) {
    date
    reserve0
    reserve1
    reserveUSD
    dailyVolumeUSD
  }
}`;
}

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

async function pageAll(endpoint, query, vars) {
  let out = [], after = vars.after || 0;
  for (let i = 0; i < MAX_PAGES; i++) {
    const d = await gql(endpoint, query, Object.assign({}, vars, { after: after }));
    const batch = (d && d.pairDayDatas) || [];
    out = out.concat(batch);
    if (batch.length < PAGE) break;
    after = parseInt(batch[batch.length - 1].date, 10);
  }
  return out;
}

/* Same trap as the v3 endpoint: a day is stamped either as a real timestamp or
   as a day count, and filtering with the wrong one matches nothing at all. */
function dayStart(v) {
  const n = Number(v);
  const ts = n < 1000000 ? n * 86400 : n;
  return Math.floor(ts / 86400) * 86400;
}

async function fetchDays(endpoint, address, afterTs) {
  for (const field of ['pairAddress', 'pair']) {
    for (const after of [afterTs, Math.floor(afterTs / 86400)]) {
      let rows;
      try { rows = await pageAll(endpoint, daysQuery(field), { pair: address, after: after }); }
      catch (e) { continue; }        /* wrong field name is a schema error, try the next */
      if (rows.length) return rows;
    }
  }
  return [];
}

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const chain = (url.searchParams.get('chain') || '').toLowerCase().trim();
    const address = (url.searchParams.get('address') || '').toLowerCase().trim();
    const fromRaw = parseInt(url.searchParams.get('from'), 10) || 0;
    const from = fromRaw > 0 ? Math.floor(fromRaw / 86400) * 86400 : 0;

    if (!/^0x[0-9a-f]{40}$/.test(address)) return json({ error: 'bad_address' }, 400);

    const subgraphId = Object.prototype.hasOwnProperty.call(SUBGRAPHS, chain)
      ? SUBGRAPHS[chain] : undefined;
    if (!subgraphId) return json({ error: 'chain_unsupported', chain: chain }, 200);

    const key = context.env && context.env.GRAPH_API_KEY;
    if (!key) return json({ error: 'not_configured' }, 200);

    const canon = new URL(url.origin + url.pathname);
    canon.searchParams.set('chain', chain);
    canon.searchParams.set('address', address);
    canon.searchParams.set('from', String(from));
    const cacheKey = new Request(canon.toString(), { method: 'GET' });
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const endpoint = GATEWAY + '/' + key + '/subgraphs/id/' + subgraphId;

    const meta = await gql(endpoint, PAIR_QUERY, { id: address });
    if (!meta || !meta.pair) return json({ error: 'pair_not_found' }, 200);

    const rows = await fetchDays(endpoint, address, from > 0 ? from - 1 : 0);

    const payload = {
      source: 'subgraph-v2',
      chain: chain,
      version: 'v2',
      rawRows: rows.length,
      pool: {
        address: meta.pair.id,
        createdAt: Number(meta.pair.createdAtTimestamp) || 0,
        feeTier: 3000,                 /* v2 is a flat 0.3%, all of it to LPs */
        tvlUSD: Number(meta.pair.reserveUSD) || 0,
        token0: { address: meta.pair.token0.id, symbol: meta.pair.token0.symbol,
                  decimals: Number(meta.pair.token0.decimals) },
        token1: { address: meta.pair.token1.id, symbol: meta.pair.token1.symbol,
                  decimals: Number(meta.pair.token1.decimals) }
      },
      /* A v2 pair holds equal value on both sides, so half the pair's dollar
         value divided by a side's token count is that token's price. No oracle,
         no derived path through other pools — it falls out of the reserves. */
      days: rows.map(function (r) {
        const res0 = Number(r.reserve0), res1 = Number(r.reserve1);
        const usd = Number(r.reserveUSD) || 0;
        return {
          t: dayStart(r.date),
          tvlUSD: usd,
          volumeUSD: Number(r.dailyVolumeUSD) || 0,
          p0: (res0 > 0 && usd > 0) ? (usd / 2) / res0 : 0,
          p1: (res1 > 0 && usd > 0) ? (usd / 2) / res1 : 0
        };
      }).filter(function (d) { return d.p0 > 0 && d.p1 > 0; })
    };

    const out = json(payload);
    context.waitUntil(cache.put(cacheKey, out.clone()));
    return out;

  } catch (e) {
    return json({ error: 'fetch_failed', detail: String(e && e.message || e) }, 200);
  }
}
