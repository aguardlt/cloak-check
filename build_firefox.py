#!/usr/bin/env python3
"""Build the Firefox variant of the extension into dist/firefox (and a zip for addons.mozilla.org).

Same code as the Chrome build; only the manifest differs:
Firefox runs the background as an event page, needs an add-on id and a data-collection statement.
"""
import json, os, shutil, zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC, OUT = os.path.join(ROOT, 'extension'), os.path.join(ROOT, 'dist', 'firefox')

def main():
    shutil.rmtree(OUT, ignore_errors=True)
    shutil.copytree(SRC, OUT, ignore=shutil.ignore_patterns('.DS_Store'))
    path = os.path.join(OUT, 'manifest.json')
    m = json.load(open(path))
    m.pop('minimum_chrome_version', None)
    m['name'] = 'CloakCheck: see a page as Googlebot & AI bots'  # addons.mozilla.org allows 45 characters
    assert len(m['name']) <= 45
    m['background'] = {'scripts': ['background.js'], 'type': 'module'}
    m['browser_specific_settings'] = {'gecko': {
        'id': 'cloakcheck@aguard.lt',
        'strict_min_version': '140.0',
        'data_collection_permissions': {'required': ['none']},
    }}
    json.dump(m, open(path, 'w'), indent=2, ensure_ascii=False)
    z = os.path.join(ROOT, 'dist', f"cloakcheck-firefox-{m['version']}.zip")
    with zipfile.ZipFile(z, 'w', zipfile.ZIP_DEFLATED) as f:
        for d, _, files in os.walk(OUT):
            for n in sorted(files):
                p = os.path.join(d, n); f.write(p, os.path.relpath(p, OUT))
    print('built', OUT, 'and', z)

if __name__ == '__main__':
    main()
