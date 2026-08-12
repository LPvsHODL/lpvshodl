/**
 * Rewrites the link-preview tags when someone shares a result.
 *
 * X, Discord and Slack fetch the URL and read meta tags out of the HTML. They
 * do not run the page's JavaScript, so a static file always previews as the
 * same generic card. This runs at the edge and swaps the title and description
 * for ones built from the shared result.
 *
 * Every step is wrapped so that a failure here can never take the site down:
 * on any error the original response is returned untouched. A broken preview
 * is a nuisance; a broken site is not.
 *
 * The numbers come from the URL, so they are a claim, not a proof. The page
 * itself ignores them and recomputes from real pool data on load.
 */

const MAX = 140;

function clean(v) {
  if (typeof v !== 'string') return '';
  var out = '';
  for (var i = 0; i < v.length && out.length < MAX; i++) {
    var c = v.charCodeAt(i);
    if (c < 32 || c === 60 || c === 62) continue; /* control chars, < and > */
    out += v[i];
  }
  return out.trim();
}

function attr(v) {
  return clean(v)
    .split('&').join('&amp;')
    .split('"').join('&quot;')
    .split("'").join('&#39;');
}

export async function onRequest(context) {
  const res = await context.next();

  try {
    const type = res.headers.get('content-type') || '';
    if (type.indexOf('text/html') === -1) return res;

    const p = new URL(context.request.url).searchParams;
    const pair = clean(p.get('pr'));
    const net = clean(p.get('nt'));
    if (!pair || !net) return res;

    const chain = clean(p.get('ch'));
    const fees = clean(p.get('fe'));
    const days = parseInt(p.get('dy'), 10) || 0;
    const won = p.get('w') === '1';

    const where = chain ? pair + ' on ' + chain : pair;
    const headline = where + (won ? ' beat holding by ' : ' lost to holding by ') + net;

    const bits = [];
    if (fees) bits.push(fees + ' in fees');
    if (days > 0) bits.push('over ' + days + ' day' + (days === 1 ? '' : 's'));
    const desc = (bits.length ? bits.join(' ') + '. ' : '') +
      'Backtest any pool against real history \u2014 fees in each token, ' +
      'impermanent loss, and days out of range.';

    const title = attr(headline);
    const description = attr(desc);

    /* Only these exact keys are ever rewritten. Anything else on the page is
       left alone, and nothing inherited from Object.prototype can match. */
    function lookup(key) {
      if (key === 'og:title' || key === 'twitter:title') return title;
      if (key === 'og:description' || key === 'twitter:description' ||
          key === 'description') return description;
      return null;
    }

    return new HTMLRewriter()
      .on('title', {
        element: function (el) {
          try { el.setInnerContent(clean(headline) + ' \u2014 LPvsHODL'); } catch (e) {}
        }
      })
      .on('meta', {
        element: function (el) {
          try {
            var key = el.getAttribute('property') || el.getAttribute('name');
            if (typeof key !== 'string') return;
            var val = lookup(key);
            if (val) el.setAttribute('content', val);
          } catch (e) {}
        }
      })
      .transform(res);

  } catch (e) {
    return res;
  }
}
