#!/usr/bin/env python3
"""S5c check: the map v2 painted atlases (tools/build_city_textures.py v2) exist and open as JPEGs no bigger than
2048 px, have the documented cell layout (refs/city2/layout.json), cover 4 or more bay variants per facade style,
are not copies of today's deco facade, and add no more than 12 MB. It also rebuilds today's atlases into a scratch
folder and checks they still come out the same, so the v2 work did not change the grid's textures.

Writes refs/city2/contact_sheet.jpg (every style next to today's deco facade, the K-Town signs and the shop rows).
Usage: python3 tools/s5c_check_atlases.py [--no-rebuild]      exit 1 on any failure
"""
import hashlib, json, pathlib, sys, tempfile
import numpy as np
from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import build_city_textures as B  # noqa: E402

TEX, REFS2 = ROOT / 'assets' / 'tex', ROOT / 'refs' / 'city2'
STYLES = ['ktown', 'tower', 'resort', 'house', 'warehouse']
SIZES = {**{f'facade_{s}.jpg': (2048, 2048) for s in STYLES}, **{f'facade_{s}_lit.jpg': (1024, 1024) for s in STYLES},
         **{f'facade_{s}_rough.jpg': (1024, 1024) for s in STYLES},
         'signs_ktown.jpg': (2048, 1600), 'shops2.jpg': (1920, 1920), 'shops2_lit.jpg': (960, 960),
         'shops2_signs.jpg': (2048, 1728)}
TODAY = ['shops.jpg', 'shops_lit.jpg', 'signs.jpg', 'facade.jpg', 'facade_lit.jpg', 'facade_rough.jpg']
fails = []


def ok(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond: fails.append(msg)


def arr(im): return np.asarray(im.convert('RGB')).astype(float)


def mae(a, b): return float(np.abs(arr(a) - arr(b)).mean())


def files():
    print('files')
    for name, size in SIZES.items():
        p = TEX / name
        if not p.exists(): ok(False, f'{name} missing'); continue
        try:
            Image.open(p).verify()
            im = Image.open(p); im.load()
        except Exception as e:  # noqa: BLE001
            ok(False, f'{name} does not open: {e}'); continue
        ok(im.format == 'JPEG' and im.size == size and max(im.size) <= 2048,
           f'{name} {im.format} {im.size[0]}x{im.size[1]} (want {size[0]}x{size[1]}, <= 2048)')
    total = sum((TEX / n).stat().st_size for n in SIZES if (TEX / n).exists())
    ok(total <= 12 * 1024 * 1024, f'added texture size {total / 1024 / 1024:.2f} MB <= 12 MB')


def deco_windows():
    """Today's deco facade: the window box of each of its 64 cells (decoFacade's 2.3 x 1.75 m, 0.55 m head)."""
    im, C = Image.open(TEX / 'facade.jpg').convert('RGB'), 256
    PX = C / 3.2
    ww, wh, hd = round(2.3 * PX), round(1.75 * PX), round(0.55 * PX)
    return [im.crop((i * C + (C - ww) // 2, j * C + hd, i * C + (C - ww) // 2 + ww, j * C + hd + wh)).resize((48, 32))
            for j in range(8) for i in range(8)], im


def facades(layout):
    print('facades')
    deco_cells, deco = deco_windows()
    for s in STYLES:
        L = layout['facades'].get(s)
        if not L: ok(False, f'{s}: not in layout.json'); continue
        cells = L['cells']
        ok(L['grid'] == [8, 8] and len(cells) == 64 and L['cell_m'] == [3, 3.2], f'{s}: 8 x 8 cells of 3 m x 3.2 m')
        used = {c['bay'] for c in cells} - {'blank'}
        ok(len(used) >= 4 and all(sum(c['bay'] == n for c in cells) >= 4 for n in used),
           f'{s}: {len(used)} bay variants, each used 4+ times')
        im = Image.open(TEX / L['file']).convert('RGB')
        rough = np.asarray(Image.open(TEX / L['rough']).convert('RGB'))[..., 1].astype(float)
        lit = np.asarray(Image.open(TEX / L['lit']).convert('L')).astype(float)
        bx, by, bw, bh = L['box_px']
        inbox = np.zeros((2048, 2048), bool)
        glossy_ok = blank_ok = True
        thumbs, nlit, nwin = [], 0, 0
        for k, c in enumerate(cells):
            X, Y = (k % 8) * 256 + bx, (k // 8) * 256 + by
            inbox[Y:Y + bh, X:X + bw] = True
            g = rough[Y // 2:(Y + bh) // 2, X // 2:(X + bw) // 2] < 60
            if c['bay'] == 'blank' or c['bay'] in B.NOT_GLASS: blank_ok &= g.mean() < 0.02
            else:   # every window has glass in its box (shutters, curtains and frames take the rest)
                glossy_ok &= g.mean() > 0.05
                nwin += 1
                nlit += (lit[Y // 2:(Y + bh) // 2, X // 2:(X + bw) // 2] > 40).mean() > 0.05
            if c['bay'] != 'blank': thumbs.append(im.crop((X, Y, X + bw, Y + bh)).resize((48, 32)))
        half = inbox[::2, ::2]
        out_gloss = (rough[~half] < 60).mean()
        out_lit = (lit[~half] > 40).mean()
        ok(glossy_ok and blank_ok, f'{s}: glass in the documented box of every window cell, none in blank cells and vents')
        ok(out_gloss < 0.01 and out_lit < 0.01,
           f'{s}: outside the boxes {out_gloss:.2%} glossy and {out_lit:.2%} lit (want < 1%)')
        ok(0.15 <= nlit / nwin <= 0.9, f'{s}: {nlit} of {nwin} windows lit at night (want 15-90%)')
        # distinct-looking cells: greedy clusters of the window thumbnails
        reps = []
        for t in thumbs:
            if all(mae(t, r) > 14 for r in reps): reps.append(t)
        ok(len(reps) >= 4, f'{s}: {len(reps)} visibly different window cells (want 4+)')
        nearest = min(min(mae(t, d) for d in deco_cells) for t in thumbs)
        ok(nearest > 20, f'{s}: no window copied from the deco facade (closest cell differs by {nearest:.1f}/255)')
        whole = mae(im.resize((256, 256)), deco.resize((256, 256)))
        ok(whole > 12, f'{s}: whole sheet differs from facade.jpg by {whole:.1f}/255')
    md5 = lambda p: hashlib.md5(p.read_bytes()).hexdigest()  # noqa: E731
    old = {md5(p) for p in (ROOT / 'refs' / 'city').glob('*.png')}
    ok(not any(md5(p) in old for p in REFS2.glob('*.png')), 'no refs/city picture reused in refs/city2')


def signs(layout):
    print('signs and shops')
    L = layout['signs_ktown']
    im = Image.open(TEX / L['file']).convert('L')
    a = np.asarray(im).astype(float)
    (bw, bh), y0 = L['blades']['cell_px'], L['neon']['origin'][1]
    bl = [a[0:bh, i * bw:(i + 1) * bw] for i in range(8)]
    ok([bw, bh] == [256, 832] and len(L['blades']['names']) == 8 and all((b > 45).mean() > 0.5 for b in bl),
       'signs_ktown: 8 blade boards filling 256 x 832 cells')
    ne = [a[y0 + (k // 2) * 256:y0 + (k // 2 + 1) * 256, (k % 2) * 1024:(k % 2 + 1) * 1024] for k in range(6)]
    ok(len(L['neon']['names']) == 6 and all((n > 80).mean() > 0.02 for n in ne), 'signs_ktown: 6 neon signs, 1024 x 256 each')
    S = layout['shops2']
    new, old = Image.open(TEX / 'shops2.jpg'), Image.open(TEX / 'shops.jpg')
    cell = lambda im, i, w, h, cols: im.crop(((i % cols) * w, (i // cols) * h, (i % cols + 1) * w, (i // cols + 1) * h))  # noqa: E731
    same = max(mae(cell(new, i, 640, 320, 3), cell(old, i, 640, 320, 3)) for i in range(12))
    ok(len(S['fronts']['names']) == 18 and same < 4, f'shops2: cells 0-11 are today\'s shops (max diff {same:.1f})')
    fresh = min(mae(cell(new, j, 640, 320, 3), cell(new, i, 640, 320, 3)) for j in range(12, 18) for i in range(12))
    ok(fresh > 20, f'shops2: cells 12-17 are new shop fronts (closest to an old one {fresh:.1f})')
    ns, os_ = Image.open(TEX / 'shops2_signs.jpg'), Image.open(TEX / 'signs.jpg')
    same = max(mae(cell(ns, i, 1024, 192, 2), cell(os_, i, 1024, 192, 2)) for i in range(12))
    ok(same < 4, f'shops2_signs: cells 0-11 are today\'s signs (max diff {same:.1f})')
    ok(all(np.asarray(cell(ns, i, 1024, 192, 2).convert('L')).mean() > 30 for i in range(12, 18)), 'shops2_signs: cells 12-17 painted')


def rebuild_today():
    print("today's atlases")
    with tempfile.TemporaryDirectory() as tmp:
        keep, B.OUT = B.OUT, pathlib.Path(tmp)
        try: B.shops(); B.signs(); B.facade()
        finally: B.OUT = keep
        for n in TODAY:
            a, b = pathlib.Path(tmp) / n, TEX / n
            if a.read_bytes() == b.read_bytes(): ok(True, f'{n} rebuilds byte-identical')
            else:
                d = mae(Image.open(a), Image.open(b))
                ok(d < 1, f'{n} rebuilds within {d:.2f}/255 (bytes differ only by encoder)')


def contact_sheet(layout):
    W = 2048
    rows = []
    def label(im, text):
        d = ImageDraw.Draw(im); d.rectangle((0, 0, 8 + 7 * len(text), 16), fill=(0, 0, 0)); d.text((4, 2), text, fill=(255, 255, 255))
        return im
    deco = Image.open(TEX / 'facade.jpg').convert('RGB').resize((512, 512))
    row = Image.new('RGB', (W, 520), (60, 60, 64)); row.paste(label(deco, "today's deco facade.jpg (for comparison)"), (0, 4))
    rows.append(row)
    for s in STYLES:
        L = layout['facades'][s]
        row = Image.new('RGB', (W, 520), (60, 60, 64))
        row.paste(label(Image.open(TEX / L['file']).convert('RGB').resize((512, 512)), L['file']), (0, 4))
        row.paste(label(Image.open(TEX / L['lit']).convert('RGB').resize((256, 256)), 'lit'), (520, 4))
        row.paste(label(Image.open(TEX / L['rough']).convert('RGB').resize((256, 256)), 'rough'), (520, 264))
        row.paste(label(Image.open(TEX / L['file']).convert('RGB').crop((0, 0, 512, 512)), 'full-res corner'), (784, 4))
        for k, n in enumerate(L['bays']):
            t = Image.open(REFS2 / f'{n}.png').convert('RGB'); t.thumbnail((360, 250))
            row.paste(label(t, n), (1304 + (k % 2) * 372, 4 + (k // 2) * 258))
        rows.append(row)
    sk = Image.open(TEX / 'signs_ktown.jpg').convert('RGB'); sk.thumbnail((1024, 900))
    sh = Image.open(TEX / 'shops2.jpg').convert('RGB'); sh.thumbnail((620, 620))
    ss = Image.open(TEX / 'shops2_signs.jpg').convert('RGB'); ss.thumbnail((400, 620))
    row = Image.new('RGB', (W, max(sk.height, sh.height) + 8), (60, 60, 64))
    row.paste(label(sk, 'signs_ktown.jpg'), (0, 4)); row.paste(label(sh, 'shops2.jpg'), (1032, 4)); row.paste(label(ss, 'shops2_signs.jpg'), (1032 + 628, 4))
    rows.append(row)
    sheet = Image.new('RGB', (W, sum(r.height for r in rows)))
    y = 0
    for r in rows: sheet.paste(r, (0, y)); y += r.height
    sheet.save(REFS2 / 'contact_sheet.jpg', quality=82)
    print(f'contact sheet: {(REFS2 / "contact_sheet.jpg").relative_to(ROOT)} ({sheet.width}x{sheet.height})')


if __name__ == '__main__':
    lp = REFS2 / 'layout.json'
    files()
    if not lp.exists(): ok(False, 'refs/city2/layout.json missing (run build_city_textures.py v2)')
    else:
        layout = json.loads(lp.read_text())
        facades(layout); signs(layout); contact_sheet(layout)
    if '--no-rebuild' not in sys.argv: rebuild_today()
    print('FAILED: ' + '; '.join(fails) if fails else 'all S5c checks passed')
    sys.exit(1 if fails else 0)
