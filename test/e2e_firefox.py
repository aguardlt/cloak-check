#!/usr/bin/env python3
"""End-to-end test in Firefox: loads the Firefox build into a headless Firefox with a throwaway profile,
runs a check against the local cloaking server from e2e.py and verifies the report."""
import json, os, shutil, subprocess, sys, tempfile, threading, time
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import e2e                      # reuse the cloaking server (H, SEEN, PORT)
from marionette import Marionette

FIREFOX = os.environ.get('FIREFOX', '/Applications/Firefox.app/Contents/MacOS/firefox')
MPORT = 2829
ADDON_ID = 'cloakcheck@aguard.lt'


def main():
    subprocess.run([sys.executable, os.path.join(ROOT, 'build_firefox.py')], check=True, stdout=subprocess.DEVNULL)
    srv = ThreadingHTTPServer(('127.0.0.1', e2e.PORT), e2e.H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    work = tempfile.mkdtemp(prefix='cloakcheck-ff-')
    os.makedirs(f'{work}/profile')
    open(f'{work}/profile/user.js', 'w').write(
        f'user_pref("marionette.port", {MPORT});\nuser_pref("browser.shell.checkDefaultBrowser", false);\n'
        'user_pref("datareporting.policy.dataSubmissionEnabled", false);\nuser_pref("app.update.enabled", false);\n'
        'user_pref("browser.aboutwelcome.enabled", false);\nuser_pref("network.captive-portal-service.enabled", false);\n')
    ff = subprocess.Popen([FIREFOX, '--headless', '--marionette', '--no-remote', '--profile', f'{work}/profile'],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                          env=dict(os.environ, MOZ_HEADLESS='1', MOZ_REMOTE_ALLOW_SYSTEM_ACCESS='1'))
    ok = True
    def check(cond, msg):
        nonlocal ok
        print(('PASS  ' if cond else 'FAIL  ') + msg); ok = ok and bool(cond)
    try:
        m = Marionette(MPORT)
        m.call('WebDriver:NewSession', {'capabilities': {'alwaysMatch': {'acceptInsecureCerts': True}}})
        m.call('WebDriver:SetTimeouts', {'script': 120000, 'pageLoad': 60000})
        m.call('Addon:Install', {'path': os.path.join(ROOT, 'dist', 'firefox'), 'temporary': True})
        host = m.chrome('''const [id, done] = arguments;
            const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
            const policy = WebExtensionPolicy.getByID(id);
            ExtensionPermissions.add(id, { origins: ["*://*/*"], permissions: [] }, policy.extension).then(() => done(policy.mozExtensionHostname), e => done("ERR " + e));''', [ADDON_ID])
        print('extension host', host)
        results = {}
        for name in ('hacked', 'clean'):
            url = f'http://127.0.0.1:{e2e.PORT}/{name}/'
            m.call('WebDriver:Navigate', {'url': url}); time.sleep(1.5)
            page_handle = m.call('WebDriver:GetWindowHandle')
            new = m.call('WebDriver:NewWindow', {'type': 'tab'})
            m.call('WebDriver:SwitchToWindow', {'handle': new['handle'] if isinstance(new, dict) else new})
            m.call('WebDriver:Navigate', {'url': f'moz-extension://{host}/popup.html?tabId=0&url=about:blank'})
            del e2e.SEEN[:]
            res = m.js('''const [url, done] = arguments; const c = window.wrappedJSObject.chrome;
                c.tabs.query({}).then(async (tabs) => {
                  const tab = tabs.find(t => t.url === url);
                  const badge = await c.action.getBadgeText({ tabId: tab.id });
                  const r = await c.runtime.sendMessage({ type: "run", tabId: tab.id, url });
                  done(JSON.stringify({ tabId: tab.id, badge, r }));
                }).catch(e => done(JSON.stringify({ error: String(e) })));''', [url])
            res = json.loads(res)
            if res.get('error') or not res['r'].get('ok'): print('run failed:', json.dumps(res)[:600]); ok = False; results[name] = None
            else: results[name] = (res['r']['report'], list(e2e.SEEN), res['tabId'], res['badge'])
            m.call('WebDriver:CloseWindow'); m.call('WebDriver:SwitchToWindow', {'handle': page_handle})
        if results.get('hacked') and results.get('clean'):
            rep, seen, tab_id, badge = results['hacked']
            by = {v['id']: v for v in rep['variants']}
            uas = [s['ua'] for s in seen if s['path'] == '/hacked/']
            check(badge == '5', f'passive scan put the number of hidden items on the icon (got {badge!r})')
            check(results['clean'][3] == '', 'passive scan leaves the icon empty on a clean page')
            check(any('Googlebot/2.1' in u for u in uas) and any('bingbot' in u for u in uas) and any('GPTBot' in u for u in uas) and any('ClaudeBot' in u for u in uas), 'server received each crawler User-Agent')
            check(all(s['cookie'] is None for s in seen), 'no cookies sent')
            check(any('google.com' in s['referer'] for s in seen), 'Google referer sent for the search-visitor request')
            check(by['googlebot']['level'] == 'bad' and by['bingbot']['level'] == 'bad', 'Googlebot and Bingbot rows flagged as a different page')
            check(by['gptbot']['level'] == 'info', 'blocked GPTBot row is inconclusive, not an alert')
            check(by['claudebot']['level'] == 'ok', 'ClaudeBot row matches the visitor page')
            check(by['search']['level'] == 'bad' and any('another site' in n for n in by['search']['notes']), 'redirect for visitors from Google flagged')
            pg = rep.get('page')
            check(pg and sum(1 for l in pg['links'] if l['level'] == 'bad') == 2, 'two hidden spam links found')
            check(pg and len(pg['iframes']) == 1 and len(pg['scripts']) == 1, 'hidden frame and obfuscated script found')
            check(rep['level'] == 'bad', 'overall verdict: bad')
            rep2 = results['clean'][0]
            check(rep2['level'] == 'ok' and all(v['level'] == 'ok' for v in rep2['variants']), 'clean site: every row ok')
            # Browse as: the tab itself must be served the crawler version, and go back on reset.
            url = f'http://127.0.0.1:{e2e.PORT}/hacked/'
            def ext(expr):
                page = m.call('WebDriver:GetWindowHandle')
                new = m.call('WebDriver:NewWindow', {'type': 'tab'})
                m.call('WebDriver:SwitchToWindow', {'handle': new['handle'] if isinstance(new, dict) else new})
                m.call('WebDriver:Navigate', {'url': f'moz-extension://{host}/popup.html?tabId=0&url=about:blank'})
                r = m.js('const [done] = [arguments[arguments.length - 1]]; const c = window.wrappedJSObject.chrome; Promise.resolve(' + expr + ').then(v => done(JSON.stringify(v === undefined ? null : v)), e => done(JSON.stringify("ERR " + e)));')
                m.call('WebDriver:CloseWindow'); m.call('WebDriver:SwitchToWindow', {'handle': page})
                return json.loads(r)
            m.call('WebDriver:Navigate', {'url': url}); time.sleep(1)
            tab = ext(f'c.tabs.query({{}}).then(ts => ts.find(t => t.url === "{url}").id)')
            del e2e.SEEN[:]
            r = ext(f'c.runtime.sendMessage({{type: "browseAs", tabId: {tab}, id: "googlebot"}})'); time.sleep(2.5)
            nav = [x for x in e2e.SEEN if x['path'] == '/hacked/']
            check(r and r.get('id') == 'googlebot', f'browse-as accepted Googlebot ({r})')
            check(nav and all('Googlebot/2.1' in x['ua'] for x in nav), 'tab navigation carries the Googlebot User-Agent')
            check('casino' in (m.call('WebDriver:GetTitle') or '').lower(), 'tab shows the page served to Googlebot')
            check(ext(f'c.action.getBadgeText({{tabId: {tab}}})') == 'GB', 'icon shows the active crawler signature')
            del e2e.SEEN[:]
            ext(f'c.runtime.sendMessage({{type: "browseAs", tabId: {tab}, id: "human"}})'); time.sleep(2.5)
            nav = [x for x in e2e.SEEN if x['path'] == '/hacked/']
            check(nav and not any('Googlebot' in x['ua'] for x in nav) and 'carrots' in (m.call('WebDriver:GetTitle') or ''), 'switching back restores normal browsing')
            check(ext('c.declarativeNetRequest.getSessionRules().then(r => r.length)') == 0, 'no header rules left behind')
            if not ok:
                print(json.dumps([(v['id'], v['status'], v['level'], v['notes']) for v in rep['variants']], indent=1)); print('UAs seen:', uas, 'pageError:', rep.get('pageError'))
    finally:
        ff.terminate()
        try: ff.wait(10)
        except Exception: ff.kill()
        subprocess.run(['pkill', '-f', work], check=False)  # child processes of the throwaway profile
        srv.shutdown(); shutil.rmtree(work, ignore_errors=True)
    print('RESULT:', 'ok' if ok else 'FAILED'); sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
