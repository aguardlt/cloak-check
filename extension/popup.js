import { registrable, hostOf, pct } from './lib/analyze.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let tab = null;
let lastReport = null;

const show = (id) => { for (const s of ['start', 'busy', 'error', 'result']) $(s).hidden = s !== id; };

function originPattern(url) {
  const host = hostOf(url);
  const reg = registrable(host);
  // Covers example.com and www.example.com, so a www redirect can be followed.
  return reg === host && (/^[\d.]+$/.test(host) || !host.includes('.')) ? `*://${host}/*` : `*://*.${reg}/*`;
}

async function init() {
  if (params.get('url')) { // standalone page mode, used by tests and screenshots
    document.body.classList.add('page');
    tab = { id: params.get('tabId') ? Number(params.get('tabId')) : null, url: params.get('url') };
  } else {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (!tab?.url || !/^https?:/.test(tab.url)) {
    $('errorText').textContent = 'Open a website (http or https) and click the icon again.';
    return show('error');
  }
  $('site').textContent = hostOf(tab.url);
  if (await chrome.permissions.contains({ origins: [originPattern(tab.url)] })) return run();
  $('startText').textContent = `CloakCheck needs your permission to request pages on ${registrable(hostOf(tab.url))}. Chrome will ask once per site.`;
  show('start');
}

async function run() {
  show('busy');
  const res = await chrome.runtime.sendMessage({ type: 'run', tabId: tab.id, url: tab.url });
  if (!res?.ok) { $('errorText').textContent = 'Check failed: ' + (res?.error || 'unknown error'); return show('error'); }
  lastReport = res.report;
  render(res.report);
  show('result');
}

const MARK = { ok: 'Same', info: 'n/a', warn: 'Differs', bad: 'Alert' };

function render(r) {
  const v = $('verdict');
  v.className = 'verdict ' + r.level;
  const titles = { ok: 'No cloaking or hidden links found', warn: 'Differences worth a closer look', bad: 'Signs of cloaking or injected content' };
  const subs = {
    ok: 'Crawlers and visitors get the same page, and no concealed outbound links were found.',
    warn: 'Some visitors get a different answer, or the page hides something. See the rows below.',
    bad: 'This site may be compromised. Compare with a clean backup and check core files first.',
  };
  $('vtitle').textContent = titles[r.level];
  $('vsub').textContent = subs[r.level];

  const tb = $('variants').querySelector('tbody');
  tb.replaceChildren();
  for (const row of [r.baseline, ...r.variants]) {
    const tr = el('tr', row.level);
    const who = el('td', 'who'); who.append(row.label, el('small', '', row.hint));
    const st = el('td', 'st', row.status ? String(row.status) : '—');
    const what = el('td');
    const isBase = row === r.baseline;
    what.append(el('span', 'mark', isBase && row.level === 'ok' ? 'Baseline' : MARK[row.level]));
    const notes = row.notes.length ? row.notes : (isBase ? [row.title || '(no title)'] : []);
    for (const n of notes) what.append(el('div', 'note', n));
    const sim = el('td', 'sim', row.similarity == null ? '' : pct(row.similarity));
    sim.title = 'Text similarity with what a visitor gets';
    tr.append(who, st, what, sim);
    tb.append(tr);
  }

  const box = $('page');
  box.replaceChildren();
  if (!r.page) {
    box.append(el('p', 'fine', r.pageError ? 'This page could not be inspected: ' + r.pageError : 'Not inspected.'));
  } else {
    const p = r.page;
    const flagged = p.links.filter((l) => l.level !== 'info');
    if (!p.links.length && !p.iframes.length && !p.scripts.length) {
      box.append(el('p', '', `No hidden outbound links, frames or obfuscated scripts among ${p.totalLinks} links.`));
    } else if (!flagged.length && !p.iframes.length && !p.scripts.length) {
      box.append(el('p', '', `${p.hiddenExternal === 1 ? '1 outbound link is' : p.hiddenExternal + ' outbound links are'} not visible, but only inside ordinary collapsed blocks such as menus. Nothing looks concealed on purpose.`));
    }
    for (const l of p.links.filter((x) => x.level !== 'info')) {
      const it = el('div', 'item ' + l.level);
      it.append(el('span', 'dom', l.domain), ' ', l.text ? `“${l.text}”` : '', el('div', 'why', `Hidden link, ${l.reasons.join(', ')}. ${l.href}`));
      box.append(it);
    }
    for (const f of p.iframes) {
      const it = el('div', 'item warn');
      it.append(el('span', 'dom', f.domain), el('div', 'why', `Hidden frame, ${f.reasons.join(', ')}. ${f.src}`));
      box.append(it);
    }
    for (const s of p.scripts) {
      const it = el('div', 'item warn');
      it.append(el('span', 'dom', 'Inline script'), el('div', 'why', `${s.why}. ${s.sample}…`));
      box.append(it);
    }
  }
}

function el(tag, cls = '', text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function asText(r) {
  const lines = [`CloakCheck report for ${r.url}`, `Checked ${r.finishedAt}`, `Verdict: ${r.level}`, ''];
  for (const row of [r.baseline, ...r.variants]) {
    lines.push(`- ${row.label}: HTTP ${row.status ?? 'n/a'}, ${row.level}${row.similarity == null ? '' : ', ' + pct(row.similarity) + ' similar'}`);
    for (const n of row.notes) lines.push(`    ${n}`);
  }
  if (r.page) {
    lines.push('', `Hidden outbound links: ${r.page.hiddenExternal} of ${r.page.totalLinks} links`);
    for (const l of r.page.links.filter((x) => x.level !== 'info')) lines.push(`- [${l.level}] ${l.href} (${l.reasons.join(', ')})`);
    for (const f of r.page.iframes) lines.push(`- [frame] ${f.src}`);
    for (const s of r.page.scripts) lines.push(`- [script] ${s.why}`);
  }
  return lines.join('\n');
}

$('run').addEventListener('click', async () => {
  // Chrome closes the popup while the permission prompt is open. After the
  // user accepts and clicks the icon again, init() finds the permission and runs.
  const granted = await chrome.permissions.request({ origins: [originPattern(tab.url)] });
  if (granted) run();
});
$('again').addEventListener('click', run);
$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(asText(lastReport));
  $('copy').textContent = 'Copied';
  setTimeout(() => { $('copy').textContent = 'Copy report'; }, 1500);
});
$('allsites').addEventListener('click', async () => {
  if (await chrome.permissions.request({ origins: ['*://*/*'] })) $('allsites').hidden = true;
});
chrome.permissions.contains({ origins: ['*://*/*'] }).then((all) => { $('allsites').hidden = all; });

init();
