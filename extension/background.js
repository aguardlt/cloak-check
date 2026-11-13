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

// ---- Browse as: keep one tab on a crawler signature until the user switches back ----

const BROWSE_BASE_ID = 100;
const ALL_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other'];
const BADGE = { search: 'REF', googlebot: 'GB', bingbot: 'BB', gptbot: 'GPT', claudebot: 'CB' };

async function browseRule(tabId) {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  return rules.find((r) => r.id >= BROWSE_BASE_ID && r.condition.tabIds?.includes(tabId)) || null;
}

/** Which variant the tab is browsing as, or null. The rule itself is the state. */
async function browseState(tabId) {
  const rule = await browseRule(tabId);
  if (!rule) return null;
  const ua = rule.action.requestHeaders.find((h) => h.header === 'user-agent')?.value;
  return (VARIANTS.find((v) => (ua ? v.ua === ua : v.id === 'search')) || {}).id || null;
}

async function browseAs(tabId, variantId) {
  const variant = VARIANTS.find((v) => v.id === variantId && v.id !== 'human') || null;
  const old = await browseRule(tabId);
  const addRules = [];
  if (variant) {
    const all = await chrome.declarativeNetRequest.getSessionRules();
    const requestHeaders = [];
    if (variant.ua) requestHeaders.push({ header: 'user-agent', operation: 'set', value: variant.ua });
    if (variant.bot) for (const h of CLIENT_HINTS) requestHeaders.push({ header: h, operation: 'remove' });
    if (variant.referer) requestHeaders.push({ header: 'referer', operation: 'set', value: variant.referer });
    addRules.push({
      id: Math.max(BROWSE_BASE_ID - 1, ...all.map((r) => r.id)) + 1,
      priority: 2,
      action: { type: 'modifyHeaders', requestHeaders },
      // The search-visitor signature only makes sense for the page itself.
      condition: { urlFilter: '|http', tabIds: [tabId], resourceTypes: variant.bot ? ALL_TYPES : ['main_frame'] },
    });
  }
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: old ? [old.id] : [], addRules });
  await paintBadge(tabId, variant?.id || null);
  await chrome.tabs.reload(tabId, { bypassCache: true });
  return variant?.id || null;
}

async function paintBadge(tabId, id, findings = null) {
  try {
    const n = findings?.count || 0;
    const text = id ? BADGE[id] + (n ? '!' : '') : (n ? String(n) : '');
    await chrome.action.setBadgeBackgroundColor({ tabId, color: findings?.level === 'warn' && !id ? '#9a6a20' : '#8a2d2d' });
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setTitle({ tabId, title: n ? `CloakCheck: ${n} hidden ${n === 1 ? 'item' : 'items'} on this page` : 'CloakCheck' });
  } catch { /* tab is gone */ }
}

/**
 * Passive check: when a page finishes loading on a site the user has allowed,
 * look for hidden links and show the count on the icon. No network requests.
 */
async function passiveScan(tabId) {
  let page;
  try {
    const [inj] = await chrome.scripting.executeScript({ target: { tabId }, func: scanPage });
    page = inj?.result;
  } catch { return null; } // no permission for this site, or not a web page
  if (!page) return null;
  const count = page.links.filter((l) => l.level !== 'info').length + page.iframes.length + page.scripts.length;
  const findings = { count, level: page.level };
  await paintBadge(tabId, await browseState(tabId), findings);
  return findings;
}

// Chrome clears a per-tab badge on navigation, so put it back.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === 'loading') {
    const id = await browseState(tabId);
    if (id) paintBadge(tabId, id);
  } else if (info.status === 'complete') {
    passiveScan(tabId);
  }
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rule = await browseRule(tabId);
  if (rule) chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [rule.id] });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'browseState') { browseState(msg.tabId).then((id) => sendResponse({ ok: true, id }), () => sendResponse({ ok: true, id: null })); return true; }
  if (msg?.type === 'browseAs') {
    browseAs(msg.tabId, msg.id).then((id) => sendResponse({ ok: true, id }), (e) => sendResponse({ ok: false, error: e?.message || String(e) }));
    return true;
  }
  if (msg?.type !== 'run') return;
  queue = queue.then(() => runCheck(msg.tabId, msg.url)).then(
    (report) => sendResponse({ ok: true, report }),
    (e) => sendResponse({ ok: false, error: e?.message || String(e) }),
  );
  return true; // async response
});

globalThis.runCheck = runCheck; // for end-to-end tests
globalThis.browseAs = browseAs;
globalThis.browseState = browseState;
globalThis.passiveScan = passiveScan;
