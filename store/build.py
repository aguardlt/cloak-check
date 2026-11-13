#!/usr/bin/env python3
"""Builds the Chrome Web Store images from docs/ screenshots: python3 store/build.py"""
import os, pymupdf
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NAVY = (13/255, 27/255, 42/255); TEAL = (10/255, 142/255, 137/255); W = (1, 1, 1); G = (0.72, 0.77, 0.82)

def canvas(w, h):
    d = pymupdf.open(); p = d.new_page(width=w, height=h); p.draw_rect(p.rect, fill=NAVY, color=None); return p

def shot(name, src, top, crop_h, title, lines):
    p = canvas(1280, 800)
    pm = pymupdf.Pixmap(src); cw = pm.width; ch = min(crop_h, pm.height - top)
    c = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, cw, ch)); c.set_origin(0, top); c.copy(pm, pymupdf.IRect(0, top, cw, top + ch))
    sc = min(740 / ch, 600 / cw); w, h = cw * sc, ch * sc
    x = 1280 - w - 50; y = (800 - h) / 2
    p.insert_image(pymupdf.Rect(x, y, x + w, y + h), pixmap=c)
    p.insert_text((60, 150), 'CloakCheck', fontsize=20, fontname='hebo', color=TEAL)
    p.insert_textbox(pymupdf.Rect(60, 200, x - 40, 420), title, fontsize=40, fontname='hebo', color=W, lineheight=1.15)
    yy = 440
    for l in lines:
        p.insert_textbox(pymupdf.Rect(60, yy, x - 40, yy + 70), l, fontsize=19, fontname='helv', color=G, lineheight=1.3); yy += 74
    p.get_pixmap(alpha=False).save(f'store/{name}.png')

shot('screenshot-1-1280x800', 'docs/screenshot-hacked.png', 0, 1500, 'Does Google see\nthe same page\nyou do?',
     ['Compare what visitors, Googlebot, Bingbot and AI crawlers receive.', 'Spot injected spam pages and redirects that owners never see.'])
shot('screenshot-2-1280x800', 'docs/screenshot-hacked.png', 1360, 1300, 'Hidden links,\nfound as you\nbrowse.',
     ['Concealed outbound links, frames and scripts are counted on the icon.', 'Switch the tab to Googlebot or an AI crawler and click around.'])
shot('screenshot-3-1280x800', 'docs/screenshot-clean.png', 0, 1500, 'One click.\nA clear answer.',
     ['Six requests, compared side by side.', 'Nothing leaves your browser.'])
p = canvas(440, 280)
p.insert_image(pymupdf.Rect(36, 92, 132, 188), filename='extension/icons/128.png')
p.insert_text((152, 134), 'CloakCheck', fontsize=34, fontname='hebo', color=W)
p.insert_textbox(pymupdf.Rect(152, 146, 420, 200), 'See a page as Googlebot\nand AI crawlers see it', fontsize=15, fontname='helv', color=G, lineheight=1.3)
p.get_pixmap(alpha=False).save('store/promo-small-440x280.png')
