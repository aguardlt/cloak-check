import { VARIANTS, summarize, compare, worst, registrable, hostOf } from './lib/analyze.js';
import { scanPage } from './lib/scan.js';

const RULE_ID = 1;
const MAX_HTML = 1_500_000;
const CLIENT_HINTS = ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'];

// One check at a time: the header rule below is global to this extension.
let queue = Promise.resolve();

async function setRequestHeaders(variant) {
  const requestHeaders = [];
  if (variant.ua) requestHeaders.push({ header: 'user-agent', operation: 'set', value: variant.ua });
  if (variant.bot) for (const h of CLIENT_HINTS) requestHeaders.push({ header: h, operation: 'remove' });
  if (variant.referer) requestHeaders.push({ header: 'referer', operation: 'set', value: variant.referer });
  const addRules = requestHeaders.length ? [{
    id: RULE_ID,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders },
    // Only requests made by this service worker, never the user's own browsing.
    condition: { urlFilter: '|http', resourceTypes: ['xmlhttprequest'], tabIds: [chrome.tabs.TAB_ID_NONE], initiatorDomains: [chrome.runtime.id] },
  }] : [];
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE_ID], addRules });
}

async function fetchAs(url, variant) {
  await setRequestHeaders(variant);
  const started = Date.now();
  const opts = { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(20000) };
  try {
    const res = await fetch(url, { ...opts, redirect: 'follow' });
    const html = (await res.text()).slice(0, MAX_HTML);
    return { id: variant.id, url, status: res.status, finalUrl: res.url, html, ms: Date.now() - started };
  } catch (e) {
    // A redirect to a site we have no permission for fails as a network error.
    // Ask again without following, to tell a redirect from a real failure.
    try {
      const probe = await fetch(url, { ...opts, signal: AbortSignal.timeout(10000), redirect: 'manual' });
      if (probe.type === 'opaqueredirect') return { id: variant.id, url, error: 'redirect', crossRedirect: true, ms: Date.now() - started };
    } catch { /* fall through */ }
    return { id: variant.id, url, error: e?.name === 'TimeoutError' ? 'timed out' : (e?.message || 'network error'), ms: Date.now() - started };
  }
}

async function runCheck(tabId, url) {
  const report = { url, startedAt: new Date().toISOString(), domain: registrable(hostOf(url)), variants: [], page: null };
  try {
    const base = summarize(await fetchAs(url, VARIANTS[0]));
    const fetched = [];
    for (const v of VARIANTS.slice(1)) fetched.push(summarize(await fetchAs(url, v)));
    const base2 = summarize(await fetchAs(url, VARIANTS[0]));

    // How much the page changes between two identical requests.
    const noise = base.error || base2.error ? 1 : jaccardSafe(base, base2);
    report.noise = noise;
    report.baseline = pick(base, VARIANTS[0], { level: base.error ? 'info' : 'ok', similarity: null, notes: base.error ? [base.crossRedirect ? 'Redirects to another site.' : 'Request failed: ' + base.error] : [], newHosts: [] });
    report.variants = fetched.map((s, i) => pick(s, VARIANTS[i + 1], base.error && !base.crossRedirect
      ? { level: 'info', similarity: null, notes: ['No baseline to compare with.'], newHosts: [] }
      : compare(base, s, noise)));
  } finally {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE_ID] });
  }

  if (tabId != null) {
    try {
      const [inj] = await chrome.scripting.executeScript({ target: { tabId }, func: scanPage });
      report.page = inj?.result ?? null;
    } catch (e) {
      report.pageError = e?.message || 'cannot inspect this page';
    }
  }

  report.level = worst([...report.variants.map((v) => v.level), report.page?.level || 'ok'].map((l) => (l === 'info' ? 'ok' : l)));
  report.finishedAt = new Date().toISOString();
  return report;
}

function jaccardSafe(a, b) {
  let inter = 0;
  for (const x of a.tokens) if (b.tokens.has(x)) inter++;
  const union = a.tokens.size + b.tokens.size - inter;
  return union ? inter / union : 1;
}

function pick(s, variant, cmp) {
  return {
    id: variant.id, label: variant.label, hint: variant.hint,
    status: s.status ?? null, finalUrl: s.finalUrl ?? null, title: s.title ?? '', textLen: s.textLen ?? 0, ms: s.ms,
    level: cmp.level, similarity: cmp.similarity, notes: cmp.notes, newHosts: cmp.newHosts,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'run') return;
  queue = queue.then(() => runCheck(msg.tabId, msg.url)).then(
    (report) => sendResponse({ ok: true, report }),
    (e) => sendResponse({ ok: false, error: e?.message || String(e) }),
  );
  return true; // async response
});

globalThis.runCheck = runCheck; // for end-to-end tests
