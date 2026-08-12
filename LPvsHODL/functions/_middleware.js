/**
 * Rewrites the link-preview tags when someone shares a result.
 *
 * X, Discord, Slack and the rest fetch the URL and read the meta tags out of
 * the HTML. They do not run the page's JavaScript, so a static file always
 * previews as the same generic card no matter which pool was backtested.
 * This runs at the edge before the page is sent and swaps the title and
 * description for ones built from the shared result.
 *
 * Everything else is passed straight through. A visitor with no share
 * parameters, or a request for anything that is not HTML, gets the file
 * untouched.
 *
 * The numbers come from the URL, so they are a claim, not a proof — anyone can
 * edit a link and make the preview say anything. The page itself ignores them
 * entirely and recomputes from real pool data on load, so an edited link
 * contradicts itself the moment it is opened.
 */

const MAX = 140;

/* Query values land straight in HTML attributes, so they get cleaned twice:
   control characters and angle brackets stripped, then entity-encoded. */
function clean(v) {
  if (!v) return '';
  return String(v).replace(/[\u0000-\u001F<>]/g, '').slice(0, MAX).trim();
}
function attr(v) {
  return clean(v)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

class Meta {
  constructor(map) { this.map = map; }
  element(el) {
    const key = el.getAttribute('property') || el.getAttribute('name');
    if (key && this.map[key]) el.setAttribute('content', this.map[key]);
  }
}
class Title {
  constructor(text) { this.text = text; }
  element(el) { el.setInnerContent(this.text); }
}

export async function onRequest(context) {
  const { request, next } = context;
  const res = await next();

  const type = res.headers.get('content-type') || '';
  if (!type.includes('text/html')) return res;

  const p = new URL(request.url).searchParams;
  const pair = clean(p.get('pr'));
  const net = clean(p.get('nt'));
  if (!pair || !net) return res;

  const chain = clean(p.get('ch'));
  const fees = clean(p.get('fe'));
  const days = String(parseInt(p.get('dy'), 10) || 0);
  const won = p.get('w') === '1';

  const where = chain ? `${pair} on ${chain}` : pair;
  const headline = `${where} ${won ? 'beat holding by' : 'lost to holding by'} ${net}`;

  const bits = [];
  if (fees) bits.push(`${fees} in fees`);
  if (days !== '0') bits.push(`over ${days} day${days === '1' ? '' : 's'}`);
  const desc = (bits.length ? bits.join(' ') + '. ' : '') +
    'Backtest any pool against real history — fees in each token, impermanent loss, and days out of range.';

  const t = attr(headline);
  const d = attr(desc);

  return new HTMLRewriter()
    .on('title', new Title(clean(headline) + ' — LPvsHODL'))
    .on('meta', new Meta({
      'og:title': t,
      'twitter:title': t,
      'og:description': d,
      'twitter:description': d,
      'description': d,
      'og:url': attr(request.url)
    }))
    .transform(res);
}
