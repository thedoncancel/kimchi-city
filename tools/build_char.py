#!/usr/bin/env python3
"""Prepare a T-pose character for the 3D game.

Reads a front T-pose picture on a green screen (plus optional back and side views) and writes:
  assets/chars/<name>.webp  texture atlas: front (top-left), back (top-right), side (bottom-left)
  assets/chars/<name>.json  body measurements the game uses to sculpt the 3D model

Model units: y = 0 at the soles and 1 at the top of the head; z points to the character's right,
x points forward. One unit is the character's full height.

Usage:
  python3 tools/build_char.py kimchi refs/kimchi-tpose.webp --back refs/kimchi-back.png --side refs/kimchi-side.png
Needs: numpy, Pillow.
"""
import argparse, json, pathlib
import numpy as np
from PIL import Image, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
TILE = 1024
PAD = 16
ROWS = 240  # height samples in the JSON


# ---------- cut-out ----------

def green_mask(rgb):
    a = np.asarray(rgb).astype(np.int16)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    fg = ~((g > 80) & (g - np.maximum(r, b) > 40))
    m = Image.fromarray((fg * 255).astype(np.uint8))
    m = m.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))   # drop specks
    m = m.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))   # fill pinholes
    return np.asarray(m) > 127


def despill(rgb, fg):
    """Remove the green fringe along the outline (only near the edge, so green clothes survive)."""
    a = np.asarray(rgb).astype(np.int16).copy()
    inner = np.asarray(Image.fromarray((fg * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(9))) > 127
    band = fg & ~inner
    mx = np.maximum(a[..., 0], a[..., 2])
    a[..., 1] = np.where(band & (a[..., 1] > mx), mx, a[..., 1])
    return Image.fromarray(a.clip(0, 255).astype(np.uint8))


def runs(row):
    d = np.diff(np.concatenate([[0], row.astype(np.int8), [0]]))
    return list(zip(np.flatnonzero(d == 1).tolist(), np.flatnonzero(d == -1).tolist()))


def body_center(fg, frac=0.5):
    """x of the body's middle at a given height (fraction from the top), ignoring arms."""
    ys = np.flatnonzero(fg.any(axis=1))
    y = int(ys[0] + (ys[-1] - ys[0]) * frac)
    xs = np.flatnonzero(fg[y])
    mid = np.median(xs)
    for s, e in runs(fg[y]):
        if s <= mid < e:
            return (s + e) / 2
    return float(mid)


def normalise(rgb, fg, center_frac=0.5):
    """Scale the character to fill a TILE x TILE square, feet on the bottom margin, body centred."""
    ys, xs = np.nonzero(fg)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    h, w = y1 - y0, x1 - x0
    s = min((TILE - 2 * PAD) / h, (TILE - 2 * PAD) / w)
    cx_src = body_center(fg, center_frac)
    nw, nh = max(1, round(w * s)), max(1, round(h * s))
    col = rgb.crop((x0, y0, x1, y1)).resize((nw, nh), Image.LANCZOS)
    msk = Image.fromarray((fg[y0:y1, x0:x1] * 255).astype(np.uint8)).resize((nw, nh), Image.BILINEAR)
    ox = int(round(TILE / 2 - (cx_src - x0) * s))
    ox = max(PAD, min(TILE - PAD - nw, ox))
    oy = TILE - PAD - nh
    tile = Image.new('RGB', (TILE, TILE), (0, 0, 0))
    tile.paste(col, (ox, oy))
    m = np.zeros((TILE, TILE), bool)
    m[oy:oy + nh, ox:ox + nw] = np.asarray(msk) > 127
    view = {'ppu': nh, 'cx': ox + (cx_src - x0) * s, 'top': oy}
    return tile, m, view


def bleed(tile, fg, iters=28):
    """Spread edge colours outward so texture filtering never pulls in the background.
    The outermost pixels are anti-aliased with the green screen, so they are replaced too."""
    a = np.asarray(tile).astype(np.float32)
    core = np.asarray(Image.fromarray((fg * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(5))) > 127
    m = core.astype(np.float32)
    for _ in range(iters):
        acc = np.zeros_like(a)
        cnt = np.zeros_like(m)
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            acc += np.roll(a * m[..., None], (dy, dx), (0, 1))
            cnt += np.roll(m, (dy, dx), (0, 1))
        new = (m == 0) & (cnt > 0)
        a[new] = acc[new] / cnt[new][:, None]
        m[new] = 1
    a[m == 0] = np.asarray(tile)[core].mean(axis=0)
    return Image.fromarray(a.clip(0, 255).astype(np.uint8))


def opening(values, window):
    """1-D morphological opening: removes bumps shorter than `window` (ears, hair tips)
    while keeping the overall shape. NaN entries are left alone."""
    v = np.array(values, dtype=float)
    ok = ~np.isnan(v)
    out = v.copy()
    idx = np.flatnonzero(ok)
    if len(idx) == 0:
        return out
    seg = v[idx]
    h = window // 2
    ero = np.array([seg[max(0, i - h):i + h + 1].min() for i in range(len(seg))])
    dil = np.array([ero[max(0, i - h):i + h + 1].max() for i in range(len(seg))])
    out[idx] = dil
    return out


# ---------- measuring ----------

def analyse_front(fg, v):
    ppu, cx, top = v['ppu'], v['cx'], v['top']
    to_y = lambda py: 1 - (py - top) / ppu
    to_z = lambda px: (cx - px) / ppu          # image left = character's right = +z
    rows = [runs(fg[py]) for py in range(TILE)]
    span = np.array([(r[-1][1] - r[0][0]) if r else 0 for r in rows])
    arm_rows = np.flatnonzero(span > 0.5 * span.max())
    arm_top, arm_bot = int(arm_rows.min()), int(arm_rows.max())
    head_top = int(np.flatnonzero(span > 0)[0])
    bottom = int(np.flatnonzero(span > 0)[-1])

    def central(py, reach=0.3):
        r = [(s, e) for s, e in rows[py] if e > cx - reach * ppu and s < cx + reach * ppu]
        return (min(s for s, _ in r), max(e for _, e in r)) if r else None

    # torso edges measured on the chest, below where the sleeves hang
    below = [central(py, 0.2) for py in range(arm_bot + int(0.07 * ppu), arm_bot + int(0.11 * ppu))]
    below = [c for c in below if c]
    torso_l = float(np.median([c[0] for c in below]))
    torso_r = float(np.median([c[1] for c in below]))
    torso_w = torso_r - torso_l
    delta = 0.012 * ppu

    widths = {py: (c[1] - c[0]) for py in range(arm_top - 1, int(head_top + 0.45 * (arm_top - head_top)), -1)
              if (c := central(py))}
    neck = min(widths, key=widths.get)
    # long hair hanging past the neck hides it; then the narrowest row is up at the chin, so fall back
    # to the usual proportion (the neck sits about a quarter of the way from the shoulders to the top)
    if (arm_top - neck) > 0.33 * (arm_top - head_top):
        neck = int(round(arm_top - 0.25 * (arm_top - head_top)))

    # head outline without the ears and stray hair tips, so the sculpted head stays smooth
    head_l, head_r = {}, {}
    hl = np.full(TILE, np.nan)
    hr = np.full(TILE, np.nan)
    for py in range(head_top, neck + 1):
        c = central(py, 0.32)
        if c:
            hl[py], hr[py] = cx - c[0], c[1] - cx
    win = max(5, int(0.06 * ppu))
    hl, hr = opening(hl, win), opening(hr, win)
    for py in range(head_top, neck + 1):
        if not np.isnan(hl[py]):
            head_l[py], head_r[py] = cx - hl[py], cx + hr[py]

    # the legs split where the body's centre line becomes background, with a leg close on each side
    crotch, streak = None, 0
    c0 = int(round(cx))
    for py in range(arm_bot + int(0.12 * ppu), bottom):
        near = [r for r in rows[py] if r[1] > cx - 0.2 * ppu and r[0] < cx + 0.2 * ppu]
        gap = not fg[py, c0 - 1:c0 + 2].any()
        if gap and any(e <= cx for _, e in near) and any(s >= cx for s, _ in near):
            streak += 1
            if streak >= 6:
                crotch = py - 5
                break
        else:
            streak = 0
    if crotch is None:
        raise SystemExit('could not find where the legs split; is the picture a full-body T-pose?')

    def sample_row(py):
        out = {}
        if py < crotch:
            if py in head_l:
                c = (head_l[py], head_r[py])
            elif arm_top - 2 <= py <= arm_bot + 2:
                c = (torso_l - delta, torso_r + delta)
            else:
                c = central(py, 0.32 if py < arm_top else 0.25)
                if c and py > arm_bot and (c[1] - c[0]) > 1.15 * torso_w:   # hanging sleeves
                    c = (max(c[0], torso_l - delta), min(c[1], torso_r + delta))
            if c:
                out['c'] = [round(to_z(c[1]), 4), round(to_z(c[0]), 4)]
        else:
            near = [r for r in rows[py] if r[1] > cx - 0.25 * ppu and r[0] < cx + 0.25 * ppu]
            left = [r for r in near if (r[0] + r[1]) / 2 < cx]
            right = [r for r in near if (r[0] + r[1]) / 2 >= cx]
            if left:   # image left = character's right leg (+z)
                out['r'] = [round(to_z(max(e for _, e in left)), 4), round(to_z(min(s for s, _ in left)), 4)]
            if right:
                out['l'] = [round(to_z(max(e for _, e in right)), 4), round(to_z(min(s for s, _ in right)), 4)]
        return out

    def arm(side):
        lo, hi = arm_top - 3, arm_bot + 4
        pts = []
        if side == 'R':
            xs = range(int(torso_l - delta), int(np.flatnonzero(fg[lo:hi].any(axis=0))[0]) - 1, -2)
        else:
            xs = range(int(torso_r + delta), int(np.flatnonzero(fg[lo:hi].any(axis=0))[-1]) + 1, 2)
        for px in xs:
            col = np.flatnonzero(fg[lo:hi, px])
            if len(col) < 2:
                continue
            pts.append([round(to_z(px), 4), round(to_y(lo + col[0]), 4), round(to_y(lo + col[-1]), 4)])
        return pts

    keys = {
        'top': round(to_y(head_top), 4), 'neck': round(to_y(neck), 4),
        'armTop': round(to_y(arm_top), 4), 'armBot': round(to_y(arm_bot), 4),
        'crotch': round(to_y(crotch), 4), 'shoulderR': round(to_z(torso_l), 4), 'shoulderL': round(to_z(torso_r), 4),
    }
    return keys, sample_row, (lambda y: int(round(top + (1 - y) * ppu))), arm


def analyse_side(fg, v, neck_y):
    ppu, cx, top = v['ppu'], v['cx'], v['top']
    front = np.full(TILE, np.nan)
    back = np.full(TILE, np.nan)
    for py in range(TILE):
        r = runs(fg[py])
        if r:
            front[py], back[py] = cx - r[0][0], r[-1][1] - cx
    # smooth the back of the head (hair tips); the face side keeps its profile (nose, chin)
    neck_py = int(round(top + (1 - neck_y) * ppu))
    head = back.copy()
    head[neck_py + 1:] = np.nan
    head = opening(head, max(5, int(0.05 * ppu)))
    back[:neck_py + 1] = head[:neck_py + 1]

    def depth(y):
        py = int(round(top + (1 - y) * ppu))
        if not (0 <= py < TILE) or np.isnan(front[py]):
            return None
        return [round(front[py] / ppu, 4), round(-back[py] / ppu, 4)]   # [front x, back x]
    return depth


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('name')
    ap.add_argument('front')
    ap.add_argument('--back')
    ap.add_argument('--side')
    a = ap.parse_args()
    out_dir = ROOT / 'assets' / 'chars'
    out_dir.mkdir(parents=True, exist_ok=True)

    atlas = Image.new('RGB', (TILE * 2, TILE * 2), (20, 18, 22))
    views, tiles = {}, {}
    for key, path, origin in (('front', a.front, (0, 0)), ('back', a.back, (TILE, 0)), ('side', a.side, (0, TILE))):
        if not path:
            continue
        img = Image.open(ROOT / path if not pathlib.Path(path).is_absolute() else path).convert('RGB')
        fg = green_mask(img)
        img = despill(img, fg)
        tile, m, view = normalise(img, fg, 0.62 if key == 'side' else 0.5)
        atlas.paste(bleed(tile, m), origin)
        view['ox'], view['oy'] = origin
        views[key] = {k: round(float(val), 2) for k, val in view.items()}
        tiles[key] = m

    keys, sample_row, _, arm = analyse_front(tiles['front'], views['front'])
    depth = analyse_side(tiles['side'], views['side'], keys['neck']) if 'side' in tiles else None
    rows = []
    for i in range(ROWS + 1):
        y = i / ROWS
        f = views['front']
        py = int(round(f['top'] + (1 - y) * f['ppu']))
        row = {'y': round(y, 4)}
        if 0 <= py < TILE:
            row.update(sample_row(py))
        if depth:
            d = depth(y)
            if d:
                row['d'] = d
        rows.append(row)

    data = {'name': a.name, 'atlas': {'w': TILE * 2, 'h': TILE * 2, 'file': f'{a.name}.webp'},
            'views': views, 'keys': keys, 'rows': rows, 'arms': {'R': arm('R'), 'L': arm('L')}}
    (out_dir / f'{a.name}.json').write_text(json.dumps(data, separators=(',', ':')))
    atlas.save(out_dir / f'{a.name}.webp', quality=88, method=6)
    print(json.dumps({'keys': keys, 'views': views, 'armPoints': {k: len(v) for k, v in data['arms'].items()}}, indent=1))
    print('wrote', out_dir / f'{a.name}.json', 'and', out_dir / f'{a.name}.webp')


if __name__ == '__main__':
    main()
