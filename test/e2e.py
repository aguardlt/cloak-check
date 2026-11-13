#!/usr/bin/env python3
"""End-to-end test: loads the extension into a throwaway Chrome profile, runs a
check against a local server that cloaks by User-Agent, and verifies the report.
Also saves the screenshots used in the README.

    python3 test/e2e.py [--headed]
"""
import base64, json, os, shutil, subprocess, sys, tempfile, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'test'))
from cdp import WS  # minimal CDP websocket client

CHROME = os.environ.get('CHROME', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
PORT, CDP_PORT = 8765, 9475
SEEN = []  # request headers as received by the server

SHOP = """<!doctype html><html><head><title>Organic carrots | Farm shop</title></head><body style="font-family:sans-serif;max-width:640px;margin:40px auto">
<h1>Fresh organic carrots</h1><p>We grow vegetables on a small family farm and deliver every week. Order before Thursday for weekend delivery. Seasonal boxes include carrots, beetroot, onions and herbs.</p>
<p><a href="/about">About the farm</a> · <a href="https://facebook.com/farmshop">Facebook</a></p>
<ul style="display:none"><li><a href="https://instagram.com/farmshop">Instagram</a></li></ul>%s</body></html>"""
INJECT = """<div style="position:absolute;left:-9999px;top:0"><a href="https://best-casino-bonus.example.net/">online casino bonus</a>
<a href="https://cheap-pills.example.org/">buy viagra online</a><a href="https://some-partner.example.com/page">read more</a></div>
<iframe src="http://localhost:%d/frame" width="1" height="1" style="border:0"></iframe>
<script>var t = 1; /* padding so the script is long enough to be inspected by the scanner */ var d = eval(atob('MQ=='));</script>""" % PORT
SPAM = """<!doctype html><html><head><title>Best online casino bonus 2026</title></head><body><h1>Top 10 online casino sites</h1>
<p>Play slots, poker and roulette with a jackpot bonus. Sports betting odds updated daily.</p>
<a href="https://a-casino.example.net/">Casino A</a><a href="https://b-bets.example.org/">Bets B</a><a href="https://c-slots.example.com/">Slots C</a><a href="https://d-poker.example.io/">Poker D</a></body></html>"""

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body, headers=()):
        self.send_response(code)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        for k, v in headers: self.send_header(k, v)
        self.end_headers(); self.wfile.write(body.encode())
    def do_GET(self):
        ua, ref = self.headers.get('User-Agent', ''), self.headers.get('Referer', '')
        SEEN.append({'path': self.path, 'ua': ua, 'referer': ref, 'cookie': self.headers.get('Cookie'), 'ch': self.headers.get('Sec-CH-UA')})
        if self.path.startswith('/clean'): return self.send(200, SHOP % '')
        if self.path.startswith('/frame') or self.path.startswith('/pills'): return self.send(200, '<title>Pills</title>pills')
        if self.path.startswith('/hacked'):
            if 'Googlebot' in ua or 'bingbot' in ua: return self.send(200, SPAM)
            if 'GPTBot' in ua: return self.send(403, '<title>Access denied</title>Access denied')
            if 'google.' in ref: return self.send(302, '', [('Location', 'http://localhost:%d/pills' % PORT)])
            return self.send(200, SHOP % INJECT)
        self.send(404, '<title>Not found</title>')

def main():
    headed = '--headed' in sys.argv
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    work = tempfile.mkdtemp(prefix='cloakcheck-e2e-')
    ext = os.path.join(work, 'ext'); shutil.copytree(os.path.join(ROOT, 'extension'), ext)
    mf = json.load(open(os.path.join(ext, 'manifest.json')))
    mf['host_permissions'] = ['*://*/*']  # tests cannot click a permission prompt
    json.dump(mf, open(os.path.join(ext, 'manifest.json'), 'w'))
    # Branded Chrome ignores --load-extension, so the extension is loaded over the
    # DevTools pipe (Extensions.loadUnpacked); everything else uses the debugging port.
    args = [CHROME, f'--user-data-dir={work}/profile', f'--remote-debugging-port={CDP_PORT}', '--remote-debugging-pipe',
            '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check',
            '--window-size=700,900', '--window-position=3200,3200', 'about:blank']
    if not headed: args.insert(1, '--headless=new')
    to_r, to_w = os.pipe(); from_r, from_w = os.pipe()
    def wire():  # the browser reads commands on fd 3 and writes replies on fd 4
        a, b = os.dup(to_r), os.dup(from_w)
        os.dup2(a, 3); os.dup2(b, 4)
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=wire, close_fds=False)
    os.close(to_r); os.close(from_w)
    def pipe_call(method, params):
        os.write(to_w, json.dumps({'id': 1, 'method': method, 'params': params}).encode() + b'\0')
        buf = b''
        while True:
            chunk = os.read(from_r, 65536)
            if not chunk: raise IOError('browser closed the DevTools pipe')
            buf += chunk
            while b'\0' in buf:
                raw, buf = buf.split(b'\0', 1)
                msg = json.loads(raw)
                if msg.get('id') == 1:
                    if 'error' in msg: raise RuntimeError(f"{method}: {msg['error']}")
                    return msg['result']
    ok = True
    try:
        targets = lambda: json.load(urllib.request.urlopen(f'http://127.0.0.1:{CDP_PORT}/json/list'))
        ext_id = pipe_call('Extensions.loadUnpacked', {'path': ext})['id']
        sw = None
        for _ in range(40):
            time.sleep(0.5)
            try: sw = next((t for t in targets() if t['type'] == 'service_worker' and ext_id in t['url']), None)
            except Exception: sw = None
            if sw: break
        if not sw:  # an idle worker is stopped by the browser; opening an extension page wakes it
            urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{CDP_PORT}/json/new?chrome-extension://{ext_id}/popup.html', method='PUT'))
            time.sleep(2)
            sw = next((t for t in targets() if t['type'] == 'service_worker' and ext_id in t['url']), None)
        assert sw, 'extension service worker did not start'
        browser = WS(json.load(urllib.request.urlopen(f'http://127.0.0.1:{CDP_PORT}/json/version'))['webSocketDebuggerUrl'])
        if headed:
            page0 = next(t for t in targets() if t['type'] == 'page')
            wid = browser.call('Browser.getWindowForTarget', {'targetId': page0['id']})['windowId']
            browser.call('Browser.setWindowBounds', {'windowId': wid, 'bounds': {'windowState': 'minimized'}})

        def open_tab(url):
            tid = browser.call('Target.createTarget', {'url': url, 'background': True})['targetId']
            time.sleep(1.5)
            return next(t for t in targets() if t['id'] == tid)

        def sw_eval(expr):
            t = next(t for t in targets() if t['type'] == 'service_worker' and ext_id in t['url'])
            w = WS(t['webSocketDebuggerUrl'])
            r = w.call('Runtime.evaluate', {'expression': expr, 'awaitPromise': True, 'returnByValue': True})
            if 'exceptionDetails' in r: raise RuntimeError(json.dumps(r['exceptionDetails'])[:600])
            return r['result'].get('value')

        results = {}; badges = {}
        for name in ('hacked', 'clean'):
            url = f'http://127.0.0.1:{PORT}/{name}/'
            open_tab(url)
            tab_id = None
            for _ in range(20):
                tabs = sw_eval("chrome.tabs.query({}).then(ts=>ts.map(t=>({id:t.id,url:t.url||t.pendingUrl||''})))")
                tab_id = next((t['id'] for t in tabs if t['url'] == url), None)
                if tab_id is not None: break
                time.sleep(0.5)
            assert tab_id is not None, f'tab not visible to the extension: {tabs}'
            time.sleep(1)
            badges[name] = sw_eval(f"chrome.action.getBadgeText({{tabId:{tab_id}}})")
            del SEEN[:]
            rep = sw_eval(f"runCheck({tab_id}, '{url}')")
            results[name] = (rep, list(SEEN), tab_id, url)

        for live in [a.split('=', 1)[1] for a in sys.argv if a.startswith('--url=')]:  # manual spot check, no assertions
            open_tab(live); time.sleep(3)
            tabs = sw_eval("chrome.tabs.query({}).then(ts=>ts.map(t=>({id:t.id,url:t.url||''})))")
            tid = next(t['id'] for t in tabs if t['url'].rstrip('/') == live.rstrip('/'))
            r = sw_eval(f"runCheck({tid}, '{live}')")
            print(live, '->', r['level'])
            for v in r['variants']: print('   ', v['id'], v.get('status'), v['level'], v.get('similarity'), v.get('notes'))
            pg = r.get('page') or {}
            print('    page', pg.get('level'), [(l['level'], l['host'], l['why']) for l in pg.get('links', []) if l['level'] != 'info'], pg.get('iframes'), pg.get('scripts'))

        def check(cond, msg):
            nonlocal ok
            print(('PASS  ' if cond else 'FAIL  ') + msg)
            ok = ok and bool(cond)

        check(badges['hacked'] == '5', f"passive scan put the number of hidden items on the icon (got {badges['hacked']!r})")
        check(badges['clean'] == '', 'passive scan leaves the icon empty on a clean page')
        rep, seen, _, _ = results['hacked']
        by = {v['id']: v for v in rep['variants']}
        uas = [s['ua'] for s in seen if s['path'] == '/hacked/']
        check(any('Googlebot/2.1' in u for u in uas) and any('bingbot' in u for u in uas) and any('GPTBot' in u for u in uas) and any('ClaudeBot' in u for u in uas), 'server received each crawler User-Agent')
        check(all(s['cookie'] is None for s in seen), 'no cookies sent')
        check(all(s['ch'] is None for s in seen if 'Googlebot' in s['ua']), 'client hints removed for crawler requests')
        check(any('google.com' in s['referer'] for s in seen), 'Google referer sent for the search-visitor request')
        check(by['googlebot']['level'] == 'bad' and by['bingbot']['level'] == 'bad', 'Googlebot and Bingbot rows flagged as a different page')
        check(by['gptbot']['level'] == 'info', 'blocked GPTBot row is inconclusive, not an alert')
        check(by['claudebot']['level'] == 'ok', 'ClaudeBot row matches the visitor page')
        check(by['search']['level'] == 'bad' and any('another site' in n for n in by['search']['notes']), 'redirect for visitors from Google flagged')
        pg = rep['page']
        check(pg and sum(1 for l in pg['links'] if l['level'] == 'bad') == 2, 'two hidden spam links found')
        check(pg and any(l['level'] == 'warn' for l in pg['links']), 'off-screen partner link found')
        check(pg and len(pg['iframes']) == 1 and len(pg['scripts']) == 1, 'hidden frame and obfuscated script found')
        check(rep['level'] == 'bad', 'overall verdict: bad')
        rep2 = results['clean'][0]
        check(rep2['level'] == 'ok' and all(v['level'] == 'ok' for v in rep2['variants']), 'clean site: every row ok')
        check(rep2['page']['level'] in ('ok', 'info') and not [l for l in rep2['page']['links'] if l['level'] != 'info'], 'clean site: collapsed menu link is not an alert')

        # Browse as: the tab itself must be served the crawler version, and go back on reset.
        _, _, tab_id, url = results['hacked']
        def tab_title():
            t = next(t for t in targets() if t['type'] == 'page' and t['url'] == url)
            return WS(t['webSocketDebuggerUrl']).call('Runtime.evaluate', {'expression': 'document.title', 'returnByValue': True})['result'].get('value')
        del SEEN[:]
        check(sw_eval(f"browseAs({tab_id}, 'googlebot')") == 'googlebot', 'browse-as accepted Googlebot')
        time.sleep(2)
        nav = [x for x in SEEN if x['path'] == '/hacked/']
        check(nav and all('Googlebot/2.1' in x['ua'] for x in nav), 'tab navigation carries the Googlebot User-Agent')
        check('casino' in (tab_title() or '').lower(), 'tab shows the page served to Googlebot')
        check(sw_eval(f"chrome.action.getBadgeText({{tabId:{tab_id}}})") == 'GB', 'icon shows the active crawler signature')
        check(sw_eval(f"browseState({tab_id})") == 'googlebot', 'browse-as state survives in the rule')
        clean_tab = results['clean'][2]
        check(sw_eval(f"browseState({clean_tab})") is None, 'other tabs are not affected')
        del SEEN[:]
        sw_eval(f"browseAs({tab_id}, 'human')"); time.sleep(2)
        nav = [x for x in SEEN if x['path'] == '/hacked/']
        check(nav and not any('Googlebot' in x['ua'] for x in nav) and 'carrots' in (tab_title() or ''), 'switching back restores normal browsing')
        check(sw_eval("chrome.declarativeNetRequest.getSessionRules().then(r=>r.length)") == 0, 'no header rules left behind')
        if not ok: print(json.dumps(rep, indent=1)[:3000])

        os.makedirs(os.path.join(ROOT, 'docs'), exist_ok=True)
        for name in ('hacked', 'clean'):
            _, _, tab_id, url = results[name]
            t = open_tab(f'chrome-extension://{ext_id}/popup.html?tabId={tab_id}&url={url}')
            w = WS(t['webSocketDebuggerUrl']); w.call('Page.enable'); w.call('Runtime.enable')
            w.call('Emulation.setDeviceMetricsOverride', {'width': 620, 'height': 900, 'deviceScaleFactor': 2, 'mobile': False})
            for _ in range(60):
                time.sleep(0.5)
                if w.call('Runtime.evaluate', {'expression': "!document.getElementById('result').hidden", 'returnByValue': True})['result'].get('value'): break
            h = w.call('Runtime.evaluate', {'expression': 'Math.ceil(document.body.getBoundingClientRect().bottom)+24', 'returnByValue': True})['result']['value']
            png = w.call('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': True, 'clip': {'x': 0, 'y': 0, 'width': 620, 'height': h, 'scale': 1}})
            open(os.path.join(ROOT, 'docs', f'screenshot-{name}.png'), 'wb').write(base64.b64decode(png['data']))
        print('screenshots saved to docs/')
    finally:
        proc.terminate(); time.sleep(1); proc.kill(); srv.shutdown()
        shutil.rmtree(work, ignore_errors=True)
    sys.exit(0 if ok else 1)

if __name__ == '__main__':
    main()
