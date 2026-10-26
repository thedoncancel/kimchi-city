#!/usr/bin/env python3
"""Turn the Orbio-painted pictures in refs/city (tools/gen_city_textures.py) into the game's texture atlases:

  assets/tex/shops.jpg / shops_lit.jpg  the 12 shop fronts, 3 x 4 cells, in SHOP_SIGNS order (src/3d/textures.js)
  assets/tex/signs.jpg                  the 12 sign boards, 2 x 6 cells, same order
  assets/tex/facade.jpg / _lit / _rough the Art Deco wall: 8 x 8 cells (3 m x one 3.2 m floor each), painted windows on
                                         stucco, in exactly the layout decoFacade() uses so the eyebrow ledges line up

Map v2 (Kimchi Key) atlases, from refs/city2 (tools/gen_city_textures.py --v2), built with `v2`:

  assets/tex/facade_<style>.jpg 2048 x 2048, _lit / _rough 1024 x 1024, for style ktown, tower, resort, house,
      warehouse. Same layout and mapping as facade.jpg: 8 x 8 cells, cell (col i, row j) = one 3 m bay of one 3.2 m
      floor, row 0 at the top of the image, the cell's top edge is the floor line above. The sheet tiles in both
      directions, so walls map it with world UVs exactly like today's deco walls (us 24 m, vs 25.6 m, uOff and vOff in
      1/8 steps, vBase = the building's base). The wall is near-white so the per-building vertex tint reads. _lit is
      the night window glow (emissive map), _rough has roughness in green (glass 18, frames 120, wall 235 or less).
      Each style puts its window box (FACADES[style]['box']: width x height, and the gap from the floor line above)
      centred in the cell; refs/city2/layout.json lists the bay painted in every cell.
  assets/tex/signs_ktown.jpg  2048 x 1600 on black. Top: 8 vertical blade signs, 256 x 832 px each (a 1:3.25 board
      filling its cell), cell i at (i * 256, 0), in BLADES order. Below: 6 neon signs, 1024 x 256 px each (4:1, the sign
      letterboxed on black), 2 columns x 3 rows, cell k at ((k % 2) * 1024, 832 + (k // 2) * 256), in NEONS order.
  assets/tex/shops2.jpg / shops2_lit.jpg  today's 12 shop fronts plus 2 new rows: 3 x 6 cells of 640 x 320 (lit at
      half size), cells 0..11 in SHOP_SIGNS order (identical pictures to shops.jpg), cells 12..17 in SHOPS2 order.
  assets/tex/shops2_signs.jpg  their sign boards: 2 x 9 cells of 1024 x 192, same 18-shop order.

  assets/tex/facade_mansion.jpg / _lit / _rough (wave P3) the Mediterranean Revival facade of the Gables and Star
      Island, in the same layout, from the house stucco and the 4 house_med_* windows.

Usage: python3 tools/build_city_textures.py [today|v2|all|<style>]   (no argument = today's atlases only, as before;
       a style name, e.g. mansion, builds just that facade)
"""
import json, pathlib, random, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC, OUT = ROOT / 'refs' / 'city', ROOT / 'assets' / 'tex'
SRC2 = ROOT / 'refs' / 'city2'
SHOPS = ['chicken', 'noraebang', 'pcbang', 'cafe', 'boba', 'bbq', 'pharmacy', 'bakery', 'mart', 'salon', 'arcade', 'tteokbokki']


def crop_to_content(im, dark=40):
    """Trim the plain dark margin the model sometimes leaves around the subject (rows/columns that are mostly black)."""
    a = np.asarray(im.convert('RGB')).astype(int)
    lit = a.mean(axis=2) > dark
    rows, cols = np.where(lit.mean(axis=1) > 0.6)[0], np.where(lit.mean(axis=0) > 0.6)[0]
    if not len(rows) or not len(cols): return im
    return im.crop((cols[0], rows[0], cols[-1] + 1, rows[-1] + 1))


def board_bbox(im, thresh=45):
    """The sign board inside its black background: rows/columns where most pixels are not black."""
    a = np.asarray(im.convert('L')).astype(int)
    on = a > thresh
    rows = np.where(on.mean(axis=1) > 0.35)[0]
    cols = np.where(on.mean(axis=0) > 0.35)[0]
    return im.crop((cols[0], rows[0], cols[-1] + 1, rows[-1] + 1))


def night_glow(im):
    """The warm, bright inside of a shop glows at night; frames and walls stay dark."""
    a = np.asarray(im.convert('RGB')).astype(float) / 255
    lum = a.mean(axis=2)
    warm = np.clip((a[..., 0] - a[..., 2]) * 3 + 0.3, 0, 1)
    k = np.clip((lum - 0.45) / 0.35, 0, 1) * warm
    out = a * k[..., None] * 1.15
    return Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8))


def shops():
    CW, CH, cols = 640, 320, 3
    atlas = Image.new('RGB', (CW * cols, CH * 4)); lit = Image.new('RGB', atlas.size)
    for i, n in enumerate(SHOPS):
        im = Image.open(SRC / f'shop_{n}.png').convert('RGB')
        w, h = im.size
        th = int(w / 2)                       # 2:1, the shape of a 6 m x 3.2 m bay (a little taller at the top)
        im = im.crop((0, max(0, h - th), w, h)).resize((CW, CH), Image.LANCZOS)
        x, y = (i % cols) * CW, (i // cols) * CH
        atlas.paste(im, (x, y)); lit.paste(night_glow(im), (x, y))
    atlas.save(OUT / 'shops.jpg', quality=86, optimize=True)
    lit.resize((atlas.width // 2, atlas.height // 2), Image.LANCZOS).save(OUT / 'shops_lit.jpg', quality=80, optimize=True)  # glow: half size is plenty


def signs():
    CW, CH = 1024, 192
    atlas = Image.new('RGBA', (CW * 2, CH * 6), (0, 0, 0, 0))
    for i, n in enumerate(SHOPS):
        im = board_bbox(Image.open(SRC / f'sign_{n}.png').convert('RGB')).resize((CW, CH), Image.LANCZOS)
        atlas.paste(im, ((i % 2) * CW, (i // 2) * CH))
    atlas.convert('RGB').save(OUT / 'signs.jpg', quality=88, optimize=True)


def facade():
    S, C = 2048, 256
    PX = C / 3.2
    rnd = random.Random(19)
    st = crop_to_content(Image.open(SRC / 'stucco.png').convert('RGB'))
    w, h = st.size
    st = st.crop((int(w * 0.08), int(h * 0.08), int(w * 0.92), int(h * 0.92))).resize((512, 512), Image.LANCZOS)
    # mirror it 2 x 2 so it tiles without seams, then fill the sheet
    tile = Image.new('RGB', (1024, 1024))
    tile.paste(st, (0, 0)); tile.paste(st.transpose(Image.FLIP_LEFT_RIGHT), (512, 0))
    tile.paste(st.transpose(Image.FLIP_TOP_BOTTOM), (0, 512)); tile.paste(st.transpose(Image.ROTATE_180), (512, 512))
    wall = Image.new('RGB', (S, S))
    for yy in range(0, S, 1024):
        for xx in range(0, S, 1024): wall.paste(tile, (xx, yy))
    # lighten toward white so the per-building pastel tint reads cleanly
    wall = Image.blend(wall, Image.new('RGB', (S, S), (250, 247, 240)), 0.45)
    lit = Image.new('RGB', (S, S)); rough = Image.new('RGB', (S, S), (0, 235, 0))
    wins = [crop_to_content(Image.open(SRC / f'win_{n}.png').convert('RGB')) for n in ('blinds', 'plant', 'curtain', 'dark')]
    shadow = Image.new('RGBA', (C, 10), (0, 0, 0, 30))
    ww, wh = round(2.3 * PX), round(1.75 * PX)
    for j in range(8):
        for i in range(8):
            X, Y = i * C, j * C
            wx, wy = X + round((C - ww) / 2), Y + round(0.55 * PX)
            wall.paste(shadow, (X, wy - 14), shadow)           # the eyebrow's shadow line
            win = wins[rnd.randrange(len(wins))]
            pad = 6
            im = win.resize((ww + pad * 2, wh + pad * 2 + 6), Image.LANCZOS)
            wall.paste(im, (wx - pad, wy - pad))
            a = np.asarray(im).astype(int)
            # the panes: inside the frame, and not the white frame, mullions or sill
            hh, wwid = a.shape[:2]
            inside = np.zeros((hh, wwid), bool)
            inside[int(hh * 0.07):int(hh * 0.86), int(wwid * 0.05):int(wwid * 0.95)] = True
            glass = inside & ~(a.min(axis=2) > 205)
            g = Image.fromarray((glass * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3))
            rough.paste(Image.new('RGB', im.size, (0, 18, 0)), (wx - pad, wy - pad), g)
            if rnd.random() < 0.5:   # about half the rooms have the lights on at night
                tone = rnd.random()
                col = (255, 214, 140) if tone < 0.55 else (255, 236, 196) if tone < 0.85 else (176, 206, 255)
                glow = Image.new('RGB', im.size, col)
                lit.paste(glow, (wx - pad, wy - pad), g)
    wall.save(OUT / 'facade.jpg', quality=86, optimize=True)
    # the night glow and the shininess don't need the detail: half size saves ~30 MB of graphics memory
    lit.resize((S // 2, S // 2), Image.LANCZOS).save(OUT / 'facade_lit.jpg', quality=80, optimize=True)
    rough.resize((S // 2, S // 2), Image.LANCZOS).save(OUT / 'facade_rough.jpg', quality=85, optimize=True)


# ---------- map v2: a facade per region style, the K-Town signs, shops with 2 more rows ----------

WARM = [(255, 214, 140), (255, 236, 196), (255, 200, 120)]
NEONISH = [(255, 150, 210), (190, 160, 255)]          # K-Town upper floors: karaoke and PC-bang light
OFFICE = [(235, 242, 255), (255, 228, 176), (196, 218, 255)]
FLUO = [(222, 240, 255), (255, 240, 205)]
# per style: the wall picture and how far to lighten it toward white, the window box in metres (width, height, gap
# from the floor line above down to the window head), the bays (and how often each is used, `weights`, default even),
# the share of blank cells, the night-light odds and colours, the roughness of the bare wall and the drawn trim (band)
# that hides the wall tile's mirror seams
FACADES = {
    'ktown': dict(wall='ktown_wall', lighten=0.35, box=(2.4, 1.6, 0.6), blank=0, lit=0.6, tones=WARM * 2 + NEONISH,
                  bays=['ktown_win_lace', 'ktown_win_lanterns', 'ktown_win_blinds', 'ktown_win_sign'], rough=235,
                  weights=(3, 3, 3, 1), band='ktown'),          # the lettered billiard-hall window stays a rare one
    'tower': dict(wall='tower_wall', lighten=0.2, box=(2.84, 2.4, 0.7), blank=0, lit=0.65, tones=OFFICE, rough=150,
                  bays=['tower_glass_sky', 'tower_glass_office', 'tower_glass_blinds', 'tower_glass_home'],
                  band='tower', white_glass=True),
    'resort': dict(wall='resort_wall', lighten=0.45, box=(2.4, 2.5, 0.45), blank=0, lit=0.55, tones=WARM, rough=235,
                   bays=['resort_bay_towel', 'resort_bay_table', 'resort_bay_curtain', 'resort_bay_view'], band='slab'),
    'house': dict(wall='house_wall', lighten=0.55, box=(2.4, 1.55, 0.75), blank=0, lit=0.45, tones=WARM, rough=235,
                  bays=['house_win_shutters', 'house_win_arch', 'house_win_flowers', 'house_win_lace'], band=None),
    # wave P3: the Mediterranean Revival facade the Gables and Star Island draw since then (buildings3d's 'house'
    # layer): tall Spanish and Italian windows, keyed off their chroma green, 1.75 m x 2.45 m on the house stucco
    'mansion': dict(wall='house_wall', lighten=0.55, box=(1.75, 2.45, 0.35), blank=0, lit=0.5, tones=WARM, rough=235,
                    bays=['house_med_arch', 'house_med_twin', 'house_med_reja', 'house_med_awning'], band=None),
    'warehouse': dict(wall='ware_wall', lighten=0.5, box=(2.6, 1.46, 0.35), blank=0.34, lit=0.25, tones=FLUO, rough=225,
                      bays=['ware_win_steel', 'ware_win_louvre', 'ware_win_wired', 'ware_win_blocks'], band='tiltup'),
}
# where the glass is inside a bay picture (fractions x0, y0, x1, y1); the rest of the picture is frame, shutters, sills
GLASS = {'house_med_arch': (0.2, 0.12, 0.8, 0.7), 'house_med_twin': (0.18, 0.14, 0.82, 0.78),
         'house_med_reja': (0.2, 0.3, 0.8, 0.93), 'house_med_awning': (0.22, 0.24, 0.78, 0.7),
         'house_win_shutters': (0.25, 0.1, 0.75, 0.9), 'house_win_flowers': (0.25, 0.08, 0.75, 0.7),
         'house_win_arch': (0.18, 0.1, 0.82, 0.9), 'house_win_lace': (0.16, 0.14, 0.84, 0.82),
         'resort_bay_towel': (0.05, 0.04, 0.95, 0.62), 'resort_bay_table': (0.05, 0.04, 0.95, 0.62),
         'resort_bay_curtain': (0.05, 0.04, 0.95, 0.62), 'resort_bay_view': (0.05, 0.04, 0.95, 0.62)}
NO_FLIP = {'ktown_win_sign'}          # lettering must not be mirrored
NOT_GLASS = {'ware_win_louvre'}       # a vent: neither glossy nor lit at night
BLADES = ['chikin', 'norae', 'hof', 'pcbang', 'gogi', 'bunsik', 'danggu', 'hansik']   # gen_city_textures.py order
NEONS = ['seoul', 'soju', 'kbbq', 'open', 'pocha', 'kpop']
SHOPS2 = ['surf', 'gelato', 'swimwear', 'cafecito', 'sushi', 'florist']


def trim_margin(im, tol=11):
    """Cut the plain white or dark grey margin the model sometimes leaves around a bay, and make what is left of it in
    the corners (rounded frames) transparent, so only the painted bay lands on the wall. Painted frames are never that
    flat, so they stay."""
    a = np.asarray(im.convert('RGB')).astype(int)
    blank = (a.min(axis=2) > 255 - tol) | ((a.max(axis=2) < 70) & (np.ptp(a, axis=2) < tol))
    rows, cols = np.where(blank.mean(axis=1) < 0.9)[0], np.where(blank.mean(axis=0) < 0.9)[0]
    if len(rows) and len(cols): im = im.crop((cols[0], rows[0], cols[-1] + 1, rows[-1] + 1))
    out = im.convert('RGBA')
    w, h = out.size
    for xy in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        r, g, b, alpha = out.getpixel(xy)
        dark = max(r, g, b) < 70 and max(r, g, b) - min(r, g, b) < tol
        if alpha == 0 or not (dark or min(r, g, b) > 255 - tol): continue
        probe = out.copy()
        ImageDraw.floodfill(probe, xy, (255, 0, 255, 0), thresh=4 * tol)
        hole = (np.asarray(probe)[..., 3] == 0) & (np.asarray(out)[..., 3] > 0)
        # a dark backdrop goes wherever it reaches (around railings too); a white one only in the corners, because a
        # bigger white fill would be a white frame itself
        if dark or hole.mean() < 0.02:
            al = np.asarray(out)[..., 3].copy(); al[hole] = 0
            out.putalpha(Image.fromarray(al))
    return out


def key_green(im, feather=12):
    """A bay painted on chroma-key green (the Gables' arched windows): the green made transparent and its fringe
    neutralised, cut to what is left, and the plain cream panel some are painted on faded out toward its edges, so
    the window sits in the house's own stucco rather than on a pasted rectangle."""
    a = np.asarray(im.convert('RGB')).astype(int)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    green = (g > 120) & (g - np.maximum(r, b) > 50)
    a[..., 1] = np.minimum(g, np.maximum(r, b) + 12)            # despill the edges
    keep = ~green
    rows, cols = np.where(keep.mean(axis=1) > 0.02)[0], np.where(keep.mean(axis=0) > 0.02)[0]
    a, keep = a[rows[0]:rows[-1] + 1, cols[0]:cols[-1] + 1], keep[rows[0]:rows[-1] + 1, cols[0]:cols[-1] + 1]
    # how far each kept pixel is from the green, in px up to `feather` (repeated erosion of the mask)
    m, dist = Image.fromarray((keep * 255).astype(np.uint8)), np.zeros(keep.shape)
    for _ in range(feather):
        m = m.filter(ImageFilter.MinFilter(3))
        dist += np.asarray(m) > 0
    # the panel colour: the median of what lies just inside the green; pixels near it fade out near the edge
    rim = keep & (dist < 3)
    panel = np.median(a[rim], axis=0) if rim.any() else np.array([240, 228, 200])
    near = np.abs(a - panel).sum(axis=2) < 36
    alpha = np.where(keep, np.where(near, np.clip(dist / feather, 0, 1) ** 1.5, 1.0), 0.0)
    out = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).convert('RGBA')
    out.putalpha(Image.fromarray((alpha * 255).astype(np.uint8)))
    return out


def mirror_sheet(im, S, lighten, crop=0.08, tint=(250, 247, 240)):
    """A painted wall picture, its edges cut, mirrored 2 x 2 into a seamless 1024 tile and repeated over an S x S
    sheet, then lightened toward white so the per-building pastel tint reads cleanly (as facade() does)."""
    w, h = im.size
    st = im.crop((int(w * crop), int(h * crop), int(w * (1 - crop)), int(h * (1 - crop)))).resize((512, 512), Image.LANCZOS)
    tile = Image.new('RGB', (1024, 1024))
    tile.paste(st, (0, 0)); tile.paste(st.transpose(Image.FLIP_LEFT_RIGHT), (512, 0))
    tile.paste(st.transpose(Image.FLIP_TOP_BOTTOM), (0, 512)); tile.paste(st.transpose(Image.ROTATE_180), (512, 512))
    sheet = Image.new('RGB', (S, S))
    for yy in range(0, S, 1024):
        for xx in range(0, S, 1024): sheet.paste(tile, (xx, yy))
    return Image.blend(sheet, Image.new('RGB', (S, S), tint), lighten)


def glass_mask(im, name, white_glass=False):
    """The panes of a bay picture: inside its glass box, and neither the frame colour (the picture's outer ring) nor,
    unless the style's glass is glossy all over, the white mullions, sills and railings."""
    a = np.asarray(im.convert('RGB')).astype(int)
    h, w = a.shape[:2]
    ring = np.concatenate([a[:max(2, h // 40)].reshape(-1, 3), a[-max(2, h // 40):].reshape(-1, 3),
                           a[:, :max(2, w // 40)].reshape(-1, 3), a[:, -max(2, w // 40):].reshape(-1, 3)])
    frame = np.median(ring, axis=0)
    x0, y0, x1, y1 = GLASS.get(name, (0.05, 0.07, 0.95, 0.93))
    inside = np.zeros((h, w), bool)
    inside[int(h * y0):int(h * y1), int(w * x0):int(w * x1)] = True
    glass = inside & (np.abs(a - frame).sum(axis=2) > 60)
    if not white_glass: glass &= ~(a.min(axis=2) > 205)
    alpha = np.asarray(im.convert('RGBA'))[..., 3] > 0
    return Image.fromarray(((glass & alpha) * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3))


def draw_band(wall, rough, band, S, C, PX):
    """Trim drawn along the cell edges: it is where the mirrored wall tile has its seams, and it gives each style its
    rhythm (K-Town tile pilasters and floor bands, tower mullion caps, resort slab edges, tilt-up panel joints)."""
    d = ImageDraw.Draw(wall, 'RGBA'); dr = ImageDraw.Draw(rough)
    for k in range(0, S + 1, C):     # S too: the strips that straddle a cell edge wrap to the other side
        if band == 'ktown':
            t, p = round(0.16 * PX), round(0.07 * PX)
            d.rectangle((0, k, S, k + t - 1), fill=(120, 100, 80, 34))          # floor band
            d.rectangle((0, k + t, S, k + t + 2), fill=(0, 0, 0, 22))
            d.rectangle((k - p, 0, k + p - 1, S), fill=(120, 100, 80, 28))      # pilaster at each bay edge
        elif band == 'tower':
            m = round(0.05 * PX)
            d.rectangle((k - m, 0, k + m - 1, S), fill=(70, 80, 92, 70))        # mullion cap
            dr.rectangle((k - m, 0, k + m - 1, S), fill=(0, 90, 0))
            d.rectangle((0, k - 1, S, k + 1), fill=(40, 48, 60, 60))            # slab line
        elif band == 'slab':
            t = round(0.22 * PX)
            d.rectangle((0, k, S, k + t - 1), fill=(253, 252, 249, 255))        # white balcony slab edge
            for y in range(round(0.12 * PX)):                                    # its soft shadow
                d.line((0, k + t + y, S, k + t + y), fill=(0, 0, 0, int(46 * (1 - y / (0.12 * PX)))))
            dr.rectangle((0, k, S, k + t - 1), fill=(0, 200, 0))
        elif band == 'tiltup':
            d.rectangle((0, k, S, k + 2), fill=(0, 0, 0, 40)); d.line((0, k + 3, S, k + 3), fill=(255, 255, 255, 60))  # reveal
            if k % (2 * C) == 0:                                                 # a 6 m concrete panel joint
                d.rectangle((k - 2, 0, k + 1, S), fill=(0, 0, 0, 52)); d.line((k + 2, 0, k + 2, S), fill=(255, 255, 255, 60))


def facade_style(style):
    """One region style's facade atlas: its wall, its 4 bays dropped into the exact window box of every cell (a weighted
    shuffle, mirrored at random), the night glow and the roughness, in facade.jpg's 8 x 8 layout."""
    cfg = FACADES[style]
    S, C = 2048, 256
    PX = C / 3.2
    rnd = random.Random(f'kimchi-{style}')
    wall = mirror_sheet(crop_to_content(Image.open(SRC2 / f"{cfg['wall']}.png").convert('RGB')), S, cfg['lighten'])
    lit = Image.new('RGB', (S, S)); rough = Image.new('RGB', (S, S), (0, cfg['rough'], 0))
    draw_band(wall, rough, cfg['band'], S, C, PX)
    bays = {n: (key_green if n.startswith('house_med') else trim_margin)(Image.open(SRC2 / f'{n}.png').convert('RGB'))
            for n in cfg['bays']}
    bw, bh, head = cfg['box']
    ww, wh = round(bw * C / 3), round(bh * PX)
    nblank = round(64 * cfg['blank'])
    wts = cfg.get('weights', (1,) * len(cfg['bays']))
    counts = [round((64 - nblank) * w / sum(wts)) for w in wts]
    counts[0] += 64 - nblank - sum(counts)
    picks = ['blank'] * nblank + [n for n, c in zip(cfg['bays'], counts) for _ in range(c)]
    rnd.shuffle(picks)
    cells = []
    for j in range(8):
        for i in range(8):
            n = picks[j * 8 + i]
            X, Y = i * C, j * C
            wx, wy = X + (C - ww) // 2, Y + round(head * PX)
            if n == 'blank':
                cells.append({'bay': 'blank', 'flip': False}); continue
            flip = n not in NO_FLIP and rnd.random() < 0.5
            im = bays[n].transpose(Image.FLIP_LEFT_RIGHT) if flip else bays[n]
            im = im.resize((ww, wh), Image.LANCZOS)
            cells.append({'bay': n, 'flip': flip})
            al = im.getchannel('A')
            shadow = Image.new('L', (ww + 16, wh + 16)); shadow.paste(al.point(lambda v: 70 if v > 128 else 0), (8, 8))
            wall.paste((0, 0, 0), (wx - 5, wy - 3), shadow.filter(ImageFilter.GaussianBlur(4)))   # it sits on the wall
            wall.paste(im, (wx, wy), al)
            rough.paste((0, 120, 0), (wx, wy), al)
            if n in NOT_GLASS: continue
            rough.paste((0, 18, 0), (wx, wy), glass_mask(im, n, cfg.get('white_glass', False)))
            if rnd.random() < cfg['lit']:     # some rooms have the lights on at night, tinted by what is behind the glass
                tone = np.array(cfg['tones'][rnd.randrange(len(cfg['tones']))], float)
                rgb = np.asarray(im.convert('RGB')).astype(float) / 255
                glow = np.clip(tone * (0.55 + 0.45 * rgb), 0, 255).astype(np.uint8)
                lit.paste(Image.fromarray(glow), (wx, wy), glass_mask(im, n, True))   # white curtains glow too
    wall.save(OUT / f'facade_{style}.jpg', quality=86, optimize=True)
    lit.resize((S // 2, S // 2), Image.LANCZOS).save(OUT / f'facade_{style}_lit.jpg', quality=80, optimize=True)
    rough.resize((S // 2, S // 2), Image.LANCZOS).save(OUT / f'facade_{style}_rough.jpg', quality=85, optimize=True)
    return {'file': f'facade_{style}.jpg', 'lit': f'facade_{style}_lit.jpg', 'rough': f'facade_{style}_rough.jpg',
            'size': [S, S], 'grid': [8, 8], 'cell_m': [3, 3.2], 'box_m': list(cfg['box']),
            'box_px': [(C - ww) // 2, round(head * PX), ww, wh], 'bays': cfg['bays'], 'cells': cells}


def longest_run(idx):
    """The longest stretch of consecutive indices (a sign board, not the bracket or glow beside it)."""
    runs = np.split(idx, np.where(np.diff(idx) > 1)[0] + 1)
    return max(runs, key=len)


def sign_bbox(im, frac=0.5):
    """A sign board on its plain background (black, or the dark grey the model sometimes paints): the longest run of
    rows and of columns that differ from the background for at least `frac` of the best row or column, so a narrow
    blade sign is found too (unlike board_bbox) and a mounting bracket beside it is left out."""
    a = np.asarray(im.convert('RGB')).astype(int)
    rim = np.concatenate([a[:8].reshape(-1, 3), a[-8:].reshape(-1, 3), a[:, :8].reshape(-1, 3), a[:, -8:].reshape(-1, 3)])
    on = np.abs(a - np.median(rim, axis=0)).sum(axis=2) > 60
    r, c = on.mean(axis=1), on.mean(axis=0)
    rows, cols = longest_run(np.where(r > frac * r.max())[0]), longest_run(np.where(c > frac * c.max())[0])
    return im.crop((cols[0], rows[0], cols[-1] + 1, rows[-1] + 1))


def fit_cell(im, CW, CH, stretch=0.2):
    """Resize a sign into its cell: stretched to fill when its shape is within `stretch` of the cell's, otherwise
    scaled to fit and centred on black."""
    w, h = im.size
    if abs((w / h) / (CW / CH) - 1) <= stretch: return im.resize((CW, CH), Image.LANCZOS)
    k = min(CW / w, CH / h)
    cell = Image.new('RGB', (CW, CH))
    cell.paste(im.resize((round(w * k), round(h * k)), Image.LANCZOS), ((CW - round(w * k)) // 2, (CH - round(h * k)) // 2))
    return cell


def signs_ktown():
    """K-Town blade signs (8 cells of 256 x 832, the painted boards' 1:3.25 shape) over 6 neon signs (2 x 3 cells of
    1024 x 256), all on black."""
    BW, BH = 256, 832
    atlas = Image.new('RGB', (2048, BH + 3 * 256))
    for i, n in enumerate(BLADES):
        atlas.paste(fit_cell(sign_bbox(Image.open(SRC2 / f'blade_{n}.png').convert('RGB')), BW, BH), (i * BW, 0))
    for k, n in enumerate(NEONS):
        im = Image.open(SRC2 / f'neon_{n}.png').convert('RGB')
        on = np.asarray(im.convert('L').filter(ImageFilter.MedianFilter(5))) > 40
        ys, xs = np.where(on)
        pad = 12
        im = im.crop((max(0, xs.min() - pad), max(0, ys.min() - pad), min(im.width, xs.max() + pad + 1), min(im.height, ys.max() + pad + 1)))
        atlas.paste(fit_cell(im, 1024, 256, stretch=0), ((k % 2) * 1024, BH + (k // 2) * 256))
    atlas.save(OUT / 'signs_ktown.jpg', quality=88, optimize=True)
    return {'file': 'signs_ktown.jpg', 'size': list(atlas.size),
            'blades': {'cell_px': [BW, BH], 'origin': [0, 0], 'cols': 8, 'names': BLADES},
            'neon': {'cell_px': [1024, 256], 'origin': [0, BH], 'cols': 2, 'rows': 3, 'names': NEONS}}


def shops_v2():
    """Today's 12 shop fronts and signs (same crops as shops() and signs()) plus the 6 new ones, in one atlas each."""
    CW, CH, cols, rows = 640, 320, 3, 6
    fronts = [SRC / f'shop_{n}.png' for n in SHOPS] + [SRC2 / f'shop2_{n}.png' for n in SHOPS2]
    atlas = Image.new('RGB', (CW * cols, CH * rows)); lit = Image.new('RGB', atlas.size)
    for i, p in enumerate(fronts):
        im = Image.open(p).convert('RGB')
        if p.parent == SRC2: im = trim_margin(im).convert('RGB')   # a new front painted inside a flat dark margin
        w, h = im.size
        th = int(w / 2)
        im = im.crop((0, max(0, h - th), w, h)).resize((CW, CH), Image.LANCZOS)
        x, y = (i % cols) * CW, (i // cols) * CH
        atlas.paste(im, (x, y)); lit.paste(night_glow(im), (x, y))
    atlas.save(OUT / 'shops2.jpg', quality=86, optimize=True)
    lit.resize((atlas.width // 2, atlas.height // 2), Image.LANCZOS).save(OUT / 'shops2_lit.jpg', quality=80, optimize=True)
    SW, SH = 1024, 192
    boards = [SRC / f'sign_{n}.png' for n in SHOPS] + [SRC2 / f'sign2_{n}.png' for n in SHOPS2]
    sheet = Image.new('RGB', (SW * 2, SH * 9))
    for i, p in enumerate(boards):
        sheet.paste(board_bbox(Image.open(p).convert('RGB')).resize((SW, SH), Image.LANCZOS), ((i % 2) * SW, (i // 2) * SH))
    sheet.save(OUT / 'shops2_signs.jpg', quality=88, optimize=True)
    names = SHOPS + SHOPS2
    return {'fronts': {'file': 'shops2.jpg', 'lit': 'shops2_lit.jpg', 'cell_px': [CW, CH], 'cols': cols, 'rows': rows,
                       'names': names},
            'signs': {'file': 'shops2_signs.jpg', 'cell_px': [SW, SH], 'cols': 2, 'rows': 9, 'names': names}}


def build_v2():
    layout = {'facades': {s: facade_style(s) for s in FACADES}, 'signs_ktown': signs_ktown(), 'shops2': shops_v2()}
    (SRC2 / 'layout.json').write_text(json.dumps(layout, indent=1))


def build_style(style):
    """Just one region style's facade (wave P3's 'mansion'), leaving every other atlas as it is; its entry in
    refs/city2/layout.json is updated."""
    path = SRC2 / 'layout.json'
    layout = json.loads(path.read_text()) if path.exists() else {'facades': {}}
    layout['facades'][style] = facade_style(style)
    path.write_text(json.dumps(layout, indent=1))


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    which = sys.argv[1] if len(sys.argv) > 1 else 'today'
    if which not in ('today', 'v2', 'all', *FACADES): sys.exit(f'usage: build_city_textures.py [today|v2|all|{"|".join(FACADES)}]')
    if which in ('today', 'all'): shops(); signs(); facade()
    if which in ('v2', 'all'): build_v2()
    if which in FACADES: build_style(which)
    for f in sorted(OUT.glob('*')): print(f.name, f.stat().st_size // 1024, 'KB')
