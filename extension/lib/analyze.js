// Pure analysis functions. No browser APIs here, so the same code runs in the
// service worker and in Node tests.

const BROWSER_UA = null; // baseline uses the browser's own User-Agent

export const VARIANTS = [
  { id: 'human', label: 'Visitor', hint: 'your browser, no cookies', ua: BROWSER_UA },
  { id: 'search', label: 'Visitor from Google', hint: 'arrives from a search result', ua: BROWSER_UA, referer: 'https://www.google.com/' },
  { id: 'googlebot', label: 'Googlebot', hint: 'Google Search crawler', bot: true,
    ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
  { id: 'bingbot', label: 'Bingbot', hint: 'Bing crawler', bot: true,
    ua: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)' },
  { id: 'gptbot', label: 'GPTBot', hint: 'OpenAI crawler', bot: true,
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)' },
  { id: 'claudebot', label: 'ClaudeBot', hint: 'Anthropic crawler', bot: true,
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)' },
];

const TWO_LEVEL_TLDS = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp',
  'com.br', 'com.tr', 'com.ua', 'co.za', 'com.mx', 'com.ar', 'co.in', 'com.cn', 'com.pl', 'co.il', 'com.sg', 'com.hk']);

/** Registrable domain, good enough to tell "same site" from "another site". */
export function registrable(host) {
  if (!host) return '';
  host = host.toLowerCase().replace(/\.$/, '');
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host; // IP address
  const p = host.split('.');
  if (p.length <= 2) return host;
  const last2 = p.slice(-2).join('.');
  return TWO_LEVEL_TLDS.has(last2) ? p.slice(-3).join('.') : last2;
}

const SPAM_RE = new RegExp('\\b(' + [
  'casino', 'kazino', 'kasino', 'slots?', 'poker', 'roulette', 'betting', 'bookmaker', 'sportsbook', 'jackpot',
  'viagra', 'cialis', 'levitra', 'tramadol', 'xanax', 'pharmacy online', 'online pharmacy',
  'payday loans?', 'porn', 'xxx', 'escorts?', 'replica watches', 'essay writing service',
].join('|') + ')\\b', 'gi');

export function findSpam(text) {
  const out = new Set();
  for (const m of String(text).matchAll(SPAM_RE)) out.add(m[1].toLowerCase());
  return out;
}

export function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decode(m[1]).replace(/\s+/g, ' ').trim() : '';
}

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => safeChar(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => safeChar(parseInt(n, 16)));
}
function safeChar(n) { try { return String.fromCodePoint(n); } catch { return ' '; } }

export function stripToText(html) {
  return decode(String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function tokens(text, cap = 6000) {
  const set = new Set();
  for (const m of String(text).toLowerCase().matchAll(/[\p{L}\p{N}]{3,}/gu)) {
    set.add(m[0]);
    if (set.size >= cap) break;
  }
  return set;
}

export function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** External link targets found in raw HTML, as registrable domains. */
export function externalHosts(html, pageUrl) {
  const own = registrable(hostOf(pageUrl));
  const out = new Set();
  for (const m of String(html).matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const href = decode(m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!/^(https?:)?\/\//i.test(href)) continue;
    const h = registrable(hostOf(href.startsWith('//') ? 'https:' + href : href));
    if (h && h !== own) out.add(h);
  }
  return out;
}

export function hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }

function metaContent(html, name) {
  const re = new RegExp('<meta\\b[^>]*\\bname\\s*=\\s*["\']?' + name + '["\']?[^>]*>', 'i');
  const tag = re.exec(html);
  if (!tag) return '';
  const c = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag[0]);
  return c ? (c[1] ?? c[2] ?? '').toLowerCase().trim() : '';
}

/** Everything we need to know about one fetched response. */
export function summarize(res) {
  const html = res.html || '';
  const text = stripToText(html);
  return {
    ...res,
    title: extractTitle(html),
    textLen: text.length,
    tokens: tokens(text),
    hosts: externalHosts(html, res.finalUrl || res.url),
    spam: findSpam(text),
    robots: metaContent(html, 'robots'),
  };
}

const CHALLENGE_RE = /just a moment|attention required|access denied|are you (a )?human|verify you are human|captcha|request blocked|forbidden/i;

export function looksBlocked(s) {
  if ([401, 403, 406, 429, 503].includes(s.status)) return true;
  return s.textLen < 1500 && CHALLENGE_RE.test(s.title || '');
}

/**
 * Compare one variant against the baseline.
 * `noise` is the similarity of two baseline fetches (how much the page changes by itself).
 * Returns { level: 'ok' | 'info' | 'warn' | 'bad', similarity, notes[], newHosts[] }.
 */
export function compare(base, v, noise = 1) {
  const notes = [];
  let level = 'ok';
  const raise = (l) => { const order = ['ok', 'info', 'warn', 'bad']; if (order.indexOf(l) > order.indexOf(level)) level = l; };

  if (v.error) {
    if (v.crossRedirect) {
      const baseAlso = base.crossRedirect;
      notes.push('Redirects to another site for this visitor' + (baseAlso ? ' (the same happens for a normal visitor).' : ' only.'));
      raise(baseAlso ? 'info' : 'bad');
    } else {
      notes.push('Request failed: ' + v.error);
      raise('info');
    }
    return { level, similarity: null, notes, newHosts: [] };
  }

  if (looksBlocked(v) && !looksBlocked(base)) {
    notes.push(`Blocked (HTTP ${v.status}). A firewall rejects this crawler signature, so this row is inconclusive.`);
    return { level: 'info', similarity: null, notes, newHosts: [] };
  }

  const baseDomain = registrable(hostOf(base.finalUrl || base.url));
  const vDomain = registrable(hostOf(v.finalUrl || v.url));
  if (vDomain && baseDomain && vDomain !== baseDomain) {
    notes.push(`Redirects to another site: ${vDomain}`);
    raise('bad');
  }

  if (v.status !== base.status) {
    notes.push(`HTTP ${v.status} instead of ${base.status}.`);
    raise('warn');
  }

  const similarity = jaccard(base.tokens, v.tokens);
  const threshold = Math.min(0.6, noise - 0.2);
  const titleDiffers = norm(v.title) !== norm(base.title);
  if (similarity < threshold) {
    if (titleDiffers) {
      notes.push(`A different page is served. Title: "${cut(v.title, 90) || '(none)'}"`);
      raise('bad');
    } else {
      notes.push(`Content differs from what visitors get (${pct(similarity)} similar).`);
      raise('warn');
    }
  } else if (titleDiffers) {
    notes.push(`Title differs: "${cut(v.title, 90) || '(none)'}"`);
    raise('warn');
  }

  const newSpam = [...v.spam].filter((w) => !base.spam.has(w));
  if (newSpam.length) {
    notes.push('Spam keywords only in this version: ' + newSpam.slice(0, 6).join(', '));
    raise('bad');
  }

  const newHosts = [...v.hosts].filter((h) => !base.hosts.has(h));
  if (newHosts.length >= 3) {
    notes.push(`${newHosts.length} outbound link domains that visitors do not get: ${newHosts.slice(0, 5).join(', ')}${newHosts.length > 5 ? '…' : ''}`);
    raise(newSpam.length ? 'bad' : 'warn');
  }

  if (v.robots !== base.robots && /noindex/.test(v.robots) !== /noindex/.test(base.robots)) {
    notes.push(`Meta robots differs: "${v.robots || 'none'}" vs "${base.robots || 'none'}".`);
    raise('warn');
  }

  return { level, similarity, notes, newHosts };
}

export function worst(levels) {
  const order = ['ok', 'info', 'warn', 'bad'];
  return levels.reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a), 'ok');
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const cut = (s, n) => (String(s || '').length > n ? String(s).slice(0, n - 1) + '…' : String(s || ''));
export const pct = (x) => Math.round(x * 100) + '%';
