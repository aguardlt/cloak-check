// Runs inside the inspected page (injected with chrome.scripting). It must be
// self-contained: no imports, no references to outer scope.

export function scanPage() {
  const BENIGN = /(^|\.)(facebook|instagram|twitter|x|youtube|youtu|linkedin|tiktok|pinterest|google|goo|apple|whatsapp|wa|t|telegram|github|wordpress|w3|schema|gstatic|googleapis|cloudflare|jsdelivr|gravatar)\.(com|org|me|be|gl|net|io)$/i;
  const SPAM = /\b(casino|kazino|kasino|slots?|poker|roulette|betting|bookmaker|sportsbook|jackpot|viagra|cialis|levitra|tramadol|xanax|pharmacy|payday loans?|porn|xxx|escorts?|replica watches|essay writing)\b/i;
  const TWO = /\.(co\.uk|org\.uk|com\.au|co\.nz|co\.jp|com\.br|com\.tr|com\.ua|co\.za|co\.in|com\.pl)$/i;
  const reg = (h) => { h = (h || '').toLowerCase(); const p = h.split('.'); if (p.length <= 2 || /^[\d.]+$/.test(h)) return h; return p.slice(TWO.test(h) ? -3 : -2).join('.'); };
  const own = reg(location.hostname);
  const vw = window.innerWidth, docH = Math.max(document.documentElement.scrollHeight, 1);

  const rgb = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return null; const p = m[1].split(/[\s,\/]+/).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const bgOf = (el) => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c && c.a > 0.5) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };

  // Why is this element invisible? Returns [] when it is visible.
  function hiddenReasons(el) {
    const reasons = [];
    let deliberate = false;
    for (let e = el, depth = 0; e && e.nodeType === 1 && e !== document.documentElement && depth < 12; e = e.parentElement, depth++) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none') { reasons.push('display:none'); break; }
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') { reasons.push('visibility:hidden'); break; }
      if (parseFloat(cs.opacity) < 0.05) { reasons.push('opacity:0'); deliberate = true; break; }
      if (parseFloat(cs.fontSize) < 2) { reasons.push('font-size under 2px'); deliberate = true; break; }
      if (parseFloat(cs.textIndent) < -900) { reasons.push('text-indent off-screen'); deliberate = true; break; }
      const clipped = cs.overflow !== 'visible' && (e.clientHeight <= 1 || e.clientWidth <= 1) && e !== el;
      if (clipped) { reasons.push('inside a 0-pixel box'); deliberate = true; break; }
      if (cs.position === 'absolute' || cs.position === 'fixed') {
        const r = e.getBoundingClientRect();
        const top = r.top + window.scrollY, left = r.left + window.scrollX;
        if (r.right < -200 || left > vw + 2000 || top + r.height < -200 || top > docH + 2000) { reasons.push('positioned off-screen'); deliberate = true; break; }
      }
    }
    if (!reasons.length) {
      const r = el.getBoundingClientRect();
      const text = (el.textContent || '').trim();
      if (text && r.width > 0 && r.height > 0 && !el.querySelector('img,svg,picture')) {
        const fg = rgb(getComputedStyle(el).color), bg = bgOf(el);
        if (fg && Math.abs(fg.r - bg.r) + Math.abs(fg.g - bg.g) + Math.abs(fg.b - bg.b) < 24) { reasons.push('text colour matches background'); deliberate = true; }
      }
    }
    return { reasons, deliberate };
  }

  const links = [];
  let hiddenExternal = 0;
  for (const a of document.querySelectorAll('a[href]')) {
    let u; try { u = new URL(a.href, location.href); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const dom = reg(u.hostname);
    if (!dom || dom === own) continue;
    const { reasons, deliberate } = hiddenReasons(a);
    if (!reasons.length) continue;
    hiddenExternal++;
    const text = (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const spam = SPAM.test(text) || SPAM.test(u.href);
    const benign = BENIGN.test(u.hostname);
    let level = 'info';
    if (spam) level = 'bad';
    else if (deliberate && !benign) level = 'warn';
    if (level === 'info' && links.filter((l) => l.level === 'info').length >= 5) continue; // keep the list short
    links.push({ href: u.href.slice(0, 200), domain: dom, text, reasons, level });
  }

  const iframes = [];
  for (const f of document.querySelectorAll('iframe[src]')) {
    let u; try { u = new URL(f.src, location.href); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || reg(u.hostname) === own || BENIGN.test(u.hostname)) continue;
    const r = f.getBoundingClientRect(), cs = getComputedStyle(f);
    const tiny = r.width <= 2 || r.height <= 2;
    if (tiny || cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05)
      iframes.push({ src: u.href.slice(0, 200), domain: reg(u.hostname), reasons: [tiny ? 'size under 2px' : 'hidden'], level: 'warn' });
  }

  const scripts = [];
  const OBF = [
    [/eval\s*\(\s*(atob|unescape|decodeURIComponent)\s*\(/, 'eval of an encoded string'],
    [/document\.write\s*\(\s*(unescape|atob|decodeURIComponent)\s*\(/, 'document.write of an encoded string'],
    [/String\.fromCharCode\s*\((\s*\d+\s*,){25,}/, 'long String.fromCharCode sequence'],
    [/eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[dr]\s*\)/, 'packed script (p,a,c,k,e,d)'],
  ];
  for (const s of document.querySelectorAll('script:not([src])')) {
    const code = s.textContent || '';
    if (code.length < 80) continue;
    for (const [re, why] of OBF) if (re.test(code)) { scripts.push({ why, sample: code.replace(/\s+/g, ' ').slice(0, 120), level: 'warn' }); break; }
  }

  const order = { bad: 0, warn: 1, info: 2 };
  links.sort((a, b) => order[a.level] - order[b.level]);
  const deliberateCount = links.filter((l) => l.level === 'warn').length;
  let level = 'ok';
  if (links.some((l) => l.level === 'bad') || deliberateCount >= 3) level = 'bad';
  else if (deliberateCount || iframes.length || scripts.length) level = 'warn';
  else if (links.length) level = 'info';

  return {
    level,
    totalLinks: document.querySelectorAll('a[href]').length,
    hiddenExternal,
    links: links.slice(0, 40),
    iframes: iframes.slice(0, 10),
    scripts: scripts.slice(0, 10),
  };
}
