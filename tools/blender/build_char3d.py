"""Real 3D characters for Kimchi City (Fortnite-style), modelled in Blender: assets/chars3d/<name>.glb + .json

Run headless:
  ~/Applications/Blender.app/Contents/MacOS/Blender -b -P tools/blender/build_char3d.py -- [names...] [--preview]

Each character is built from smooth lofted parts: a head with modelled eyes, brows, lashes, nose, mouth and
ears; hair as a soft lumpy mass with locks, curtains, ponytails or buns; a top (tee, polo, hoodie, sweater,
shirt and tie, open jacket or blazer, uniform), bottoms (wide trousers, jeans, skirt and tights, shorts and
socks), shoes and hats; arms with real hands. Everything is skinned to the 17-bone skeleton the game animates
(src/3d/photochar.js) in a T-pose, height 1 (the game scales it). Parts are grouped by material: Skin, Cloth,
Hair, Gloss. 'hero' characters are detailed; 'npc' ones are lighter for crowds.

Blender axes here: the character faces +X, up is +Z, its right arm points to -Y. glTF export turns that into
the game's axes (faces +X, up +Y, right arm +Z). The .json holds the bone positions in game axes.
"""
import bpy, bmesh, math, os, sys, json, random
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glb_pack import pack  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'assets', 'chars3d')
BONES = ['hips', 'spine', 'chest', 'neck', 'head', 'armR', 'foreR', 'handR', 'armL', 'foreL', 'handL',
         'legR', 'shinR', 'footR', 'legL', 'shinL', 'footL']
GI = {n: i for i, n in enumerate(BONES)}
X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
S_HEAD = 1.14          # Fortnite/Pixar proportions: the head is scaled up around the jaw
PIV = Vector((0, 0, 0.84))


def srgb(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def ramp(v, a, b):
    return min(1.0, max(0.0, (v - a) / (b - a))) if b != a else (1.0 if v >= a else 0.0)


# ---------------- characters ----------------
# Sizes are fractions of the character's height, colours sRGB hex.
BASE = dict(body='m', bulk=1.0, skin='#f2c29a', blush='#ee9a80', lips='#c9776a', iris='#5a3418', brow='#1c1612',
            hair='#17130f', hair_tip='#3a2f28', style='tousled_fringe', top='tee', top_c='#4a4448', trim='#3e393c',
            inner='#f4f2ee', sleeve='short', stripe=None, tie=None, badge=False, bottom='wide', bottom_c='#141316',
            legs=None, socks='#f2f2f2', belt='#0e0e10', buckle='#cfd3d8', shoes='loafer', shoes_c='#121214',
            sole='#2c2b2e', hat=None, hat_c='#d6402b', lod='npc')


def spec(**kw):
    s = dict(BASE); s.update(kw); return s


SPECS = {
    'kimchi': spec(lod='hero'),
    'kimchi_denim': spec(lod='hero', top='jacket', top_c='#7fa7cf', trim='#5f86ad', inner='#f6f5f1', sleeve='long', bottom='jeans',
                         bottom_c='#3c5a85', shoes='sneaker', shoes_c='#f4f4f2', sole='#dcdcd8'),
    'kimchi_hoodie': spec(lod='hero', top='hoodie', top_c='#2b2b2f', trim='#202024', sleeve='long', bottom='wide', bottom_c='#5d5f66',
                          shoes='sneaker', shoes_c='#f2f2f0', sole='#d8d8d4'),
    'kimchi_black': spec(lod='hero', top='tee', top_c='#111113', trim='#0b0b0c', bottom='wide', bottom_c='#0d0d0f', shoes='loafer'),
    'mochi': spec(body='f', skin='#f5cba8', hair='#3a2418', hair_tip='#5a3a28', style='long_straight', top='hoodie', top_c='#f6b9cf',
                  trim='#e8a2bb', sleeve='long', bottom='jeans', bottom_c='#9dbbe0', shoes='sneaker', shoes_c='#ffffff', sole='#e4e4e0',
                  lips='#e07a86', lod='hero'),
    'bao': spec(skin='#e9b98f', style='spiky', top='jacket', top_c='#4f6b3a', trim='#3e5530', inner='#f4f2ee', sleeve='long',
                bottom='trousers', bottom_c='#1d2436', shoes='sneaker', shoes_c='#141416', sole='#f0f0ee', lod='hero'),
    'yuna': spec(body='f', skin='#f6cdb0', hair='#6a3e22', hair_tip='#8a5a36', style='long_wavy', top='sweater', top_c='#b8a1dd',
                 trim='#a38ccb', sleeve='long', bottom='skirt', bottom_c='#18181b', legs='#1b1b1f', shoes='sneaker', shoes_c='#ffffff',
                 sole='#e4e4e0', lips='#e07a86', lod='hero'),
    'dex': spec(skin='#f0c09a', hair='#d9b25a', hair_tip='#f0d58a', brow='#9a7a3a', style='messy', top='jacket', top_c='#f08a2c',
                trim='#ffffff', inner='#f08a2c', stripe='#ffffff', sleeve='long', bottom='jeans', bottom_c='#2c3f66', shoes='sneaker',
                shoes_c='#ffffff', sole='#e4e4e0', bulk=1.06, lod='hero'),
    'ped_office': spec(skin='#e8b48a', style='neat', top='shirt', top_c='#bcd3ea', trim='#a8c2dc', sleeve='long', tie='#3a3d44',
                       bottom='trousers', bottom_c='#5b5e66', shoes='dress', shoes_c='#5a3a22', sole='#3a2616', belt='#2a1c12'),
    'ped_grandma': spec(body='f', skin='#efc6a6', hair='#c9c7c4', hair_tip='#e6e4e0', brow='#9a958f', style='curly_short', top='jacket',
                        top_c='#5e8a5a', trim='#4e7a4a', inner='#f1e8d4', sleeve='long', bottom='trousers', bottom_c='#cdbb98',
                        shoes='flat', shoes_c='#6a4a2e', sole='#4a321e', belt=None, bulk=1.04),
    'ped_redjacket': spec(body='f', skin='#f3c9a8', style='bob', top='jacket', top_c='#d6352b', trim='#b82a22', inner='#141416',
                          sleeve='long', bottom='jeans', bottom_c='#151518', shoes='sneaker', shoes_c='#ffffff', sole='#e4e4e0', lips='#d0606a'),
    'ped_student': spec(skin='#f0c4a0', hair='#5a3a22', hair_tip='#7a5232', style='short', top='blazer', top_c='#1f2a4a', trim='#16203a',
                        inner='#f6f6f4', sleeve='long', tie='#8a1f2a', bottom='trousers', bottom_c='#6a6c72', shoes='dress',
                        shoes_c='#141416', sole='#0e0e10'),
    'ped_courier': spec(skin='#d9a47a', style='short', top='polo', top_c='#d6352b', trim='#b82a22', bottom='shorts', bottom_c='#1a1a1c',
                        shoes='sneaker', shoes_c='#8a8c90', sole='#e0e0dc', hat='cap', hat_c='#d6352b', belt='#111112'),
    'ped_casual': spec(body='f', skin='#e9b68e', style='ponytail', top='tee', top_c='#f7f7f5', trim='#e6e6e2', bottom='jeans',
                       bottom_c='#3d5d8c', shoes='sneaker', shoes_c='#ffffff', sole='#e4e4e0', belt=None, lips='#d0606a'),
    'ped_cop': spec(skin='#e8b48a', style='buzz', top='uniform', top_c='#1d2a44', trim='#16213a', sleeve='short', badge=True,
                    bottom='trousers', bottom_c='#1a2540', shoes='boot', shoes_c='#0e0e10', sole='#1a1a1c', belt='#0b0b0c', hat='police',
                    hat_c='#1a2540', bulk=1.08),
    'ped_cop2': spec(body='f', skin='#f0c4a0', hair='#241812', style='bun', top='uniform', top_c='#1d2a44', trim='#16213a', sleeve='short',
                     badge=True, bottom='trousers', bottom_c='#1a2540', shoes='boot', shoes_c='#0e0e10', sole='#1a1a1c', belt='#0b0b0c',
                     hat='police', hat_c='#1a2540'),
    'ped_rival': spec(skin='#dba77c', style='short', top='jacket', top_c='#151517', trim='#0c0c0e', inner='#c0262b', sleeve='long',
                      bottom='jeans', bottom_c='#6a6c70', shoes='boot', shoes_c='#101012', sole='#1a1a1c', hat='bandana', hat_c='#c0262b',
                      bulk=1.08, brow='#120d0a'),
}


# ---------------- mesh helpers ----------------

class Part:
    """One piece of the character: a bmesh plus how it's weighted to the skeleton and which material it uses."""
    def __init__(self, group, kind, smooth=1):
        self.bm = bmesh.new()
        self.col = self.bm.loops.layers.float_color.new('Col')
        self.dl = self.bm.verts.layers.deform.verify()
        self.group, self.kind, self.smooth, self.solid = group, kind, smooth, 0

    def face(self, vs, colors):
        f = self.bm.faces.new(vs)
        for lp, c in zip(f.loops, colors if isinstance(colors, list) else [colors] * len(vs)):
            lp[self.col] = (*c, 1.0)
        return f

    def recolor(self, fn):
        for f in self.bm.faces:
            for lp in f.loops:
                c = fn(lp.vert.co, tuple(lp[self.col][:3]))
                if c is not None: lp[self.col] = (*c, 1.0)


def ring(center, u, v, ru, rv, n, p=2.0, phase=0.0, wob=None):
    pts = []
    for j in range(n):
        t = 2 * math.pi * j / n + phase
        c, s = math.cos(t), math.sin(t)
        k = 1 + (wob(t) if wob else 0)
        a = math.copysign(abs(c) ** (2 / p), c) * ru * k
        b = math.copysign(abs(s) ** (2 / p), s) * rv * k
        pts.append(center + u * a + v * b)
    return pts


def loft(part, rings, color, cap0=True, cap1=True, closed=True):
    bm = part.bm
    vr = [[bm.verts.new(p) for p in r] for r in rings]
    n = len(rings[0])
    cf = color if callable(color) else (lambda i, j: color)
    for i in range(len(vr) - 1):
        for j in range(n if closed else n - 1):
            k = (j + 1) % n
            part.face([vr[i][j], vr[i][k], vr[i + 1][k], vr[i + 1][j]], [cf(i, j), cf(i, k), cf(i + 1, k), cf(i + 1, j)])
    if closed and cap0:
        c = bm.verts.new(sum(rings[0], Vector()) / n)
        for j in range(n): part.face([c, vr[0][(j + 1) % n], vr[0][j]], cf(0, j))
    if closed and cap1:
        c = bm.verts.new(sum(rings[-1], Vector()) / n)
        for j in range(n): part.face([c, vr[-1][j], vr[-1][(j + 1) % n]], cf(len(vr) - 1, j))
    return vr


def ellipsoid(part, center, radii, color, n=16, m=10, rot=None):
    bm = part.bm
    res = bmesh.ops.create_uvsphere(bm, u_segments=n, v_segments=m, radius=1.0)
    M = Matrix.Translation(center) @ (rot.to_4x4() if rot else Matrix.Identity(4)) @ Matrix.Diagonal((*radii, 1))
    bmesh.ops.transform(bm, matrix=M, verts=res['verts'])
    for f in {f for v in res['verts'] for f in v.link_faces}:
        for lp in f.loops:
            lp[part.col] = (*(color(lp.vert.co) if callable(color) else color), 1.0)
    return res['verts']


def box(part, center, half, color, rot=None):
    res = bmesh.ops.create_cube(part.bm, size=2.0)
    M = Matrix.Translation(center) @ (rot.to_4x4() if rot else Matrix.Identity(4)) @ Matrix.Diagonal((*half, 1))
    bmesh.ops.transform(part.bm, matrix=M, verts=res['verts'])
    for f in {f for v in res['verts'] for f in v.link_faces}:
        for lp in f.loops: lp[part.col] = (*color, 1.0)


def tube_path(part, pts, radii, color, n=10, flat=1.0, up=Z, cap=True):
    rings = []
    for i, p in enumerate(pts):
        d = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        u = d.cross(up)
        if u.length < 1e-5: u = d.cross(X)
        u.normalize()
        v = u.cross(d).normalized()
        rings.append(ring(p, u, v, radii[i], radii[i] * flat, n))
    return loft(part, rings, color, cap, cap)


# ---------------- hair ----------------

HAIR = {
    # shell: lump amount, hairline heights (front / side / back), sawtooth fringe; extras below
    'tousled_fringe': dict(lump=0.55, front=0.926, side=0.912, back=0.878, saw=1.0, top=16, fringe=9, sides=10),
    'spiky': dict(lump=0.35, front=0.948, side=0.915, back=0.88, saw=0.6, spikes=24),
    'messy': dict(lump=0.65, front=0.935, side=0.91, back=0.875, saw=1.0, top=24, fringe=6, sides=12),
    'neat': dict(lump=0.12, front=0.955, side=0.912, back=0.876, saw=0.0, part=True),
    'short': dict(lump=0.25, front=0.952, side=0.914, back=0.878, saw=0.3, top=8),
    'buzz': dict(lump=0.05, front=0.957, side=0.918, back=0.88, saw=0.0, tight=True),
    'curly_short': dict(lump=0.2, front=0.95, side=0.905, back=0.87, saw=0.0, curls=70),
    'bob': dict(lump=0.2, front=0.93, side=0.91, back=0.875, saw=0.15, curtain=(0.858, 0.0, 110)),
    'long_straight': dict(lump=0.15, front=0.94, side=0.91, back=0.875, saw=0.2, curtain=(0.70, 0.0, 128), swept=True),
    'long_wavy': dict(lump=0.25, front=0.94, side=0.91, back=0.875, saw=0.2, curtain=(0.69, 1.0, 128), swept=True),
    'ponytail': dict(lump=0.1, front=0.955, side=0.91, back=0.88, saw=0.0, tight=True, ponytail=True),
    'bun': dict(lump=0.08, front=0.955, side=0.91, back=0.88, saw=0.0, tight=True, bun=True),
}


def build_hair(P, C, sp, head_bm, rnd, npc):
    hs = HAIR[sp['style']]
    hc = lambda t: mix(C['hair'], C['hair_tip'], max(0.0, min(1.0, t)))
    hcen = Vector((-0.011, 0, 0.935))
    shell = P('Hair', 'head', 0 if npc else 1)
    shell.solid = 0.006 if hs.get('tight') else 0.009
    bumps = [(Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-0.2, 1))).normalized(), rnd.uniform(0.18, 0.34),
              rnd.uniform(0.05, 0.11)) for _ in range(70)]
    us, vs = (32, 18) if npc else (48, 28)
    res = bmesh.ops.create_uvsphere(shell.bm, u_segments=us, v_segments=vs, radius=1.0)
    tight = 0.965 if hs.get('tight') else 1.0
    for v in res['verts']:
        d = v.co.normalized()
        lump = sum(h * math.exp(-((d - c).length / w) ** 2) for c, w, h in bumps)
        v.co = hcen + Vector((d.x * 0.068, d.y * 0.0655, d.z * 0.062)) * tight * (1 + lump * hs['lump'])

    def hairline(co):
        az = math.atan2(co.y, co.x)
        front = max(0.0, math.cos(az))
        tooth = abs(((co.y + 0.004) / 0.017) % 1.0 - 0.5) * 2
        fz = hs['front'] + 0.016 * tooth * hs['saw']
        if hs.get('swept'): fz += (co.y + 0.04) * 0.25       # bangs swept to one side
        if hs.get('part'): fz += 0.004 * max(0.0, 1 - abs(co.y - 0.02) / 0.01)
        sz = hs['side'] + 0.008 * tooth * hs['saw']
        back = max(0.0, -math.cos(az))
        z = fz * front ** 3 + sz * (1 - front ** 3)
        return z * (1 - back) + (hs['back'] + 0.006 * tooth * hs['saw']) * back
    bmesh.ops.delete(shell.bm, geom=[v for v in shell.bm.verts if v.co.z < hairline(v.co - hcen)], context='VERTS')
    shell.recolor(lambda co, c: hc(0.15 + 0.25 * ramp(co.z, 0.92, 1.0) + 0.1 * math.sin(co.x * 180) * math.sin(co.y * 150)))

    hair = P('Hair', 'head', 0)
    skull = BVHTree.FromBMesh(head_bm)

    def tuft(root, out, length, r0, droop, lift=0.012, segs=5):
        pts, rad = [], []
        d = out.normalized(); p = root.copy(); nrm = Z
        for k in range(segs + 1):
            t = k / segs
            loc, nor, _, _ = skull.find_nearest(p)
            if loc is not None:
                nrm = nor
                if (p - loc).dot(nor) < lift: p = loc + nor * lift
            pts.append(p.copy())
            rad.append(r0 * (1 - t) ** 0.8 + 0.0008)
            d = (d + Vector((0, 0, -droop / segs))).normalized()
            p = p + d * (length / segs)
        tube_path(hair, pts, rad, lambda i, j: hc(0.2 + i / (segs + 3)), 6 if npc else 10, 0.32, up=nrm)

    k_ = 0.5 if npc else 1.0
    for k in range(int(hs.get('top', 0) * k_)):
        a = rnd.uniform(0, math.tau); rr = rnd.uniform(0.0, 0.035)
        tuft(hcen + Vector((math.cos(a) * rr, math.sin(a) * rr, 0.062)), Vector((math.cos(a) * 0.9 + 0.35, math.sin(a) * 0.9, 0.35)),
             rnd.uniform(0.03, 0.045), rnd.uniform(0.016, 0.022), rnd.uniform(0.4, 0.8), lift=0.016)
    nf = max(2, int(hs.get('fringe', 0) * k_)) if hs.get('fringe') else 0
    for k in range(nf):
        t = (k / (nf - 1)) * 2 - 1
        tuft(hcen + Vector((0.042 - 0.01 * abs(t), t * 0.042, 0.045)), Vector((0.65, t * 0.35 + 0.12, -0.75)),
             0.052 + rnd.uniform(-0.006, 0.006), 0.018, 0.9, lift=0.02)
    ns = max(2, int(hs.get('sides', 0) * k_)) if hs.get('sides') else 0
    for k in range(ns):
        a = math.pi * 0.45 + (k / (ns - 1)) * math.pi * 1.1
        tuft(hcen + Vector((math.cos(a) * 0.05, math.sin(a) * 0.055, 0.03)), Vector((math.cos(a), math.sin(a), -0.9)), 0.045, 0.018, 0.8)
    for k in range(int(hs.get('spikes', 0) * k_)):
        a = rnd.uniform(0, math.tau); rr = rnd.uniform(0.0, 0.05)
        root = hcen + Vector((math.cos(a) * rr, math.sin(a) * rr * 1.05, 0.06 - rr * 0.4))
        out = Vector((math.cos(a) * rr * 14 + 0.3, math.sin(a) * rr * 14, 1.0))
        tuft(root, out, rnd.uniform(0.03, 0.045), rnd.uniform(0.013, 0.017), -0.2, lift=0.014, segs=4)
    for k in range(int(hs.get('curls', 0) * k_)):
        d = Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(0.0, 1.0))).normalized()
        p = hcen + Vector((d.x * 0.07, d.y * 0.067, d.z * 0.064))
        if p.z < hairline(p - hcen) + 0.006: continue
        ellipsoid(hair, p, (0.016, 0.016, 0.014), hc(rnd.uniform(0.1, 0.6)), 8, 6)
    if 'curtain' in hs:
        z_end, wave, deg = hs['curtain']
        cur = P('Hair', 'head', 0 if npc else 1)
        cur.solid = 0.01
        a0 = math.radians(180 - deg)
        n = 18 if npc else 28
        rings = []
        zs = [0.955 - (0.955 - z_end) * (k / 9) for k in range(10)]
        for zi, z in enumerate(zs):
            t = zi / 9
            # wider below the jaw so long hair falls over the shoulders and back
            rr = 1.0 + 0.1 * t + (0.45 * ramp(0.83 - z, 0.0, 0.08) if z_end < 0.8 else 0.0)
            pts = []
            for j in range(n):
                a = a0 + (2 * math.pi - 2 * a0) * j / (n - 1)
                w = 1 + (0.06 * math.sin(z * 140 + j * 0.7) if wave else 0)
                cx = -0.012 - 0.012 * t
                pts.append(Vector((cx + math.cos(a) * 0.071 * rr * w, math.sin(a) * 0.069 * rr * w, z)))
            if zi == 9:   # the ends taper into points
                pts = [p + Vector((0, 0, 0.012 * abs(math.sin(j * 1.7)))) for j, p in enumerate(pts)]
            rings.append(pts)
        loft(cur, rings, lambda i, j: hc(0.1 + i / 12), closed=False)
    if hs.get('ponytail'):
        pts = [hcen + Vector((-0.062, 0, 0.03)), hcen + Vector((-0.085, 0, 0.0)), hcen + Vector((-0.095, 0, -0.04)),
               hcen + Vector((-0.093, 0, -0.08)), hcen + Vector((-0.085, 0, -0.12)), hcen + Vector((-0.078, 0, -0.15))]
        tube_path(hair, pts, [0.02, 0.022, 0.021, 0.018, 0.013, 0.003], lambda i, j: hc(0.15 + i / 8), 10, 0.85, up=Y)
        ellipsoid(hair, hcen + Vector((-0.066, 0, 0.028)), (0.012, 0.016, 0.016), srgb('#d6402b'), 10, 6)
    if hs.get('bun'):
        ellipsoid(hair, hcen + Vector((-0.07, 0, 0.035)), (0.026, 0.03, 0.026), lambda co: hc(0.3), 14, 10)


# ---------------- the body ----------------

def build(name, sp):
    C = {k: srgb(v) for k, v in sp.items() if isinstance(v, str) and v.startswith('#')}
    parts = []
    npc = sp['lod'] == 'npc'
    P = lambda g, k, s=1: (parts.append(Part(g, k, 0 if (npc and k != 'head') else s)) or parts[-1])
    rnd = random.Random(sum(map(ord, name)))
    fem, bulk = sp['body'] == 'f', sp['bulk']
    R = lambda hi, lo: lo if npc else hi                       # ring counts by detail level

    # ----- head -----
    head = P('Skin', 'head', 1)
    jaw = 0.94 if fem else 1.0
    hs = [(0.835, 0.006, 0.006, 0.026), (0.840, 0.022 * jaw, 0.018, 0.020), (0.848, 0.036 * jaw, 0.034, 0.012), (0.860, 0.047 * jaw, 0.047, 0.005),
          (0.876, 0.054, 0.056, 0.0), (0.895, 0.058, 0.060, -0.003), (0.918, 0.060, 0.062, -0.005), (0.942, 0.058, 0.061, -0.006),
          (0.962, 0.050, 0.055, -0.008), (0.977, 0.036, 0.042, -0.009), (0.986, 0.016, 0.020, -0.009)]
    loft(head, [ring(Vector((dx, 0, z)), X, Y, d, w, R(36, 20), 2.25) for z, w, d, dx in hs], C['skin'])
    for s in (-1, 1):
        ellipsoid(head, Vector((-0.006, s * 0.058, 0.897)), (0.012, 0.0055, 0.019), C['skin'], 12, 8)
        ellipsoid(head, Vector((-0.004, s * 0.0605, 0.897)), (0.0075, 0.003, 0.013), mix(C['skin'], C['blush'], 0.4), 10, 6)
    ellipsoid(head, Vector((0.0555, 0, 0.888)), (0.0062 * jaw, 0.0058 * jaw, 0.0095 * jaw), mix(C['skin'], C['blush'], 0.12), 12, 8,
              rot=Matrix.Rotation(0.45, 3, 'Y'))
    def blush(co, c):
        k = max(0.0, 1 - ((co.x - 0.045) / 0.02) ** 2 - ((abs(co.y) - 0.034) / 0.018) ** 2 - ((co.z - 0.874) / 0.013) ** 2)
        return mix(c, C['blush'], (0.45 if fem else 0.3) * k) if k > 0 else None
    head.recolor(blush)
    neck = P('Skin', 'body', 1)
    nk = 0.9 if fem else 1.0
    loft(neck, [ring(Vector((-0.006, 0, z)), X, Y, 0.026 * nk, 0.027 * nk, 14) for z in (0.785, 0.81, 0.835, 0.858)], C['skin'])

    hb = head.bm.copy()
    bvh = BVHTree.FromBMesh(hb)
    def face_at(y, z):
        loc, nor, _, _ = bvh.ray_cast(Vector((0.3, y, z)), Vector((-1, 0, 0)))
        return (loc, nor) if loc else (Vector((0.055, y, z)), X.copy())

    # ----- eyes, lashes, brows, mouth -----
    gloss = P('Gloss', 'head', 0)
    ey, ez = 0.0235, 0.902
    es = 1.06 if fem else 1.0
    for s in (-1, 1):
        loc, nor = face_at(s * ey, ez)
        c = loc - X * 0.0045
        ellipsoid(gloss, c, (0.0105 * es, 0.0125 * es, 0.0118 * es), srgb('#fbf8f4'), R(16, 10), R(10, 6))
        fwd = (X * 0.92 + Y * s * 0.12).normalized()
        q = fwd.to_track_quat('X', 'Z').to_matrix()
        ellipsoid(gloss, c + fwd * 0.0078 * es, (0.0042, 0.0082 * es, 0.0086 * es), C['iris'], R(16, 10), R(8, 5), rot=q)
        ellipsoid(gloss, c + fwd * 0.0108 * es, (0.0022, 0.0045 * es, 0.0047 * es), srgb('#0a0706'), R(12, 8), R(6, 4), rot=q)
        ellipsoid(gloss, c + fwd * 0.0124 * es + Z * 0.0035 + Y * s * 0.0022, (0.0012, 0.0019, 0.0019), srgb('#ffffff'), 8, 5, rot=q)
        arc = [c + X * (0.0095 * es * math.cos(a) + 0.0025) + Y * (s * 0.0128 * es * math.sin(a)) + Z * (0.0088 * es + 0.0035 * math.cos(a))
               for a in [(-1.25 + 2.5 * k / 8) for k in range(9)]]
        lash = 1.5 if fem else 1.0
        tube_path(gloss, arc, [(0.0012 + 0.0011 * math.cos(-1.25 + 2.5 * k / 8)) * lash for k in range(9)], srgb('#120d0b'), 6, 0.7)
        if fem:   # a flick at the outer corner
            o = arc[-1] if s > 0 else arc[0]
            tube_path(gloss, [o, o + Y * s * 0.004 + Z * 0.002 - X * 0.001], [0.0016, 0.0004], srgb('#120d0b'), 5)
        bpts = []
        for k in range(7):
            t = k / 6
            l2, _ = face_at(s * (0.009 + 0.032 * t), 0.922 + 0.006 * math.sin(math.pi * (0.25 + 0.75 * t)) - 0.002 * t + (0.002 if fem else 0))
            bpts.append(l2 + X * 0.0022)
        bw = 0.65 if fem else 1.0
        tube_path(gloss, bpts, [r * bw for r in (0.0042, 0.0046, 0.0044, 0.0040, 0.0034, 0.0026, 0.0016)], C['brow'], 6, 0.55)
    mp = []
    for k in range(9):
        t = (k / 8) * 2 - 1
        l2, _ = face_at(t * 0.0145, 0.866 + 0.0032 * t * t)
        mp.append(l2 + X * 0.0012)
    tube_path(gloss, mp, [0.0011 + 0.0011 * (1 - abs((k / 8) * 2 - 1)) for k in range(9)], mix(C['lips'], srgb('#5a2a26'), 0.45), 6, 0.8)
    lp = []
    for k in range(7):
        t = (k / 6) * 2 - 1
        l2, _ = face_at(t * 0.009, 0.861 + 0.0012 * t * t)
        lp.append(l2 + X * 0.0004)
    tube_path(gloss, lp, [0.0012 + (0.003 if fem else 0.0022) * (1 - abs((k / 6) * 2 - 1)) for k in range(7)], C['lips'], 6, 0.5)

    # ----- hair, hats -----
    build_hair(P, C, sp, hb, rnd, npc)
    hcen = Vector((-0.011, 0, 0.935))
    if sp['hat']:
        hat = P('Cloth', 'head', 1)
        hcc = C['hat_c']
        if sp['hat'] == 'cap':
            ellipsoid(hat, hcen + Vector((0, 0, 0.012)), (0.074, 0.071, 0.066), hcc, 24, 14)
            bmesh.ops.delete(hat.bm, geom=[v for v in hat.bm.verts if v.co.z < 0.945], context='VERTS')
            box(hat, hcen + Vector((0.085, 0, 0.012)), (0.035, 0.058, 0.004), mix(hcc, (0, 0, 0), 0.15), rot=Matrix.Rotation(-0.15, 3, 'Y'))
        elif sp['hat'] == 'police':
            loft(hat, [ring(hcen + Vector((0, 0, z)), X, Y, r, r * 0.97, 24) for z, r in ((0.005, 0.071), (0.03, 0.074), (0.06, 0.082), (0.068, 0.082))],
                 lambda i, j: hcc if i < 2 else mix(hcc, srgb('#ffffff'), 0.06))
            loft(hat, [ring(hcen + Vector((0, 0, z)), X, Y, 0.0725, 0.0705, 24) for z in (0.004, 0.018)], srgb('#0b0b0c'), False, False)
            box(hat, hcen + Vector((0.083, 0, 0.004)), (0.028, 0.055, 0.003), srgb('#0b0b0c'), rot=Matrix.Rotation(-0.25, 3, 'Y'))
            box(hat, hcen + Vector((0.073, 0, 0.04)), (0.003, 0.012, 0.012), srgb('#d8dce2'))
        elif sp['hat'] == 'bandana':
            ellipsoid(hat, hcen + Vector((0, 0, 0.004)), (0.071, 0.068, 0.064), hcc, 24, 14)
            bmesh.ops.delete(hat.bm, geom=[v for v in hat.bm.verts if v.co.z < 0.935 - 0.02 * ramp(-v.co.x, 0.0, 0.06)], context='VERTS')
            ellipsoid(hat, hcen + Vector((-0.072, 0, -0.01)), (0.012, 0.018, 0.012), hcc, 10, 6)
            for s in (-1, 1):
                tube_path(hat, [hcen + Vector((-0.075, s * 0.008, -0.012)), hcen + Vector((-0.085, s * 0.016, -0.04))], [0.008, 0.004], hcc, 6, 0.4)
    hb.free()

    # bigger head
    for pt in parts:
        if pt.kind == 'head':
            for v in pt.bm.verts: v.co = PIV + (v.co - PIV) * S_HEAD
    for v in neck.bm.verts:
        if v.co.z > 0.84: v.co.z = 0.84 + (v.co.z - 0.84) * S_HEAD

    # ----- torso -----
    if fem:
        ts = [(0.590, 0.088, 0.060, 0.0), (0.625, 0.074, 0.054, 0.002), (0.665, 0.072, 0.056, 0.006), (0.705, 0.080, 0.068, 0.012),
              (0.735, 0.086, 0.066, 0.008), (0.765, 0.091, 0.058, 0.0), (0.785, 0.092, 0.054, -0.003), (0.800, 0.077, 0.045, -0.004),
              (0.812, 0.042, 0.035, -0.005), (0.816, 0.031, 0.030, -0.006)]
        shoulder, armr, legy = 0.085, 0.028, 0.045
    else:
        ts = [(0.590, 0.086, 0.060, 0.002), (0.625, 0.083, 0.058, 0.002), (0.670, 0.088, 0.062, 0.003), (0.715, 0.097, 0.066, 0.004),
              (0.755, 0.106, 0.066, 0.002), (0.782, 0.108, 0.059, -0.002), (0.800, 0.088, 0.047, -0.004), (0.812, 0.046, 0.038, -0.005),
              (0.816, 0.034, 0.032, -0.006)]
        shoulder, armr, legy = 0.095, 0.034, 0.047
    top = sp['top']
    loose = {'hoodie': 1.07, 'jacket': 1.06, 'blazer': 1.05, 'sweater': 1.04}.get(top, 1.0)
    long_hem = top in ('hoodie', 'jacket', 'blazer', 'sweater')
    if long_hem:
        ts = [(0.545, ts[0][1] * 1.02, ts[0][2] * 1.02, ts[0][3])] + ts
    shirt = P('Cloth', 'body', 1)
    loft(shirt, [ring(Vector((dx, 0, z)), X, Y, d * loose * bulk, w * loose * bulk, R(24, 18), 2.5) for z, w, d, dx in ts],
         C['top_c'], cap0=True, cap1=False)
    hem_z = ts[0][0]
    tc, inner, trim = C['top_c'], C['inner'], C['trim']

    def torso_paint(co, c):
        if co.z < hem_z + 0.012: return trim                                   # hem band
        if top in ('jacket', 'blazer') and co.x > 0:
            open_w = 0.02 + ((0.02 + (co.z - 0.66) * 0.55) if (top == 'blazer' and co.z > 0.66) else 0.0)
            if abs(co.y) < open_w: return inner                               # open front showing the shirt underneath
            if abs(co.y) < open_w + 0.006: return trim                        # the jacket's edge
        if top == 'hoodie' and co.x > 0.03 and 0.585 < co.z < 0.655 and abs(co.y) < 0.055: return mix(tc, (0, 0, 0), 0.12)
        if top in ('shirt', 'uniform', 'polo') and co.x > 0 and abs(co.y) < 0.003: return trim   # button placket
        return None
    shirt.recolor(torso_paint)
    ring16 = lambda r, ry, z, dx: [Vector((dx + r * math.cos(a), ry * math.sin(a), z)) for a in [2 * math.pi * k / 16 for k in range(17)]]
    if top in ('tee', 'sweater'):
        tube_path(shirt, ring16(0.033, 0.035, 0.815, -0.006), [0.0035] * 17, trim, 6, 1.0, cap=False)
    elif top in ('polo', 'shirt', 'uniform', 'blazer'):
        col_c = inner if top == 'blazer' else trim
        tube_path(shirt, ring16(0.035, 0.037, 0.818, -0.006), [0.006] * 17, col_c, 6, 0.6, cap=False)
        for s in (-1, 1):
            box(shirt, Vector((0.03, s * 0.016, 0.806)), (0.004, 0.012, 0.009), col_c, rot=Matrix.Rotation(s * 0.5, 3, 'X'))
    elif top == 'jacket':
        tube_path(shirt, ring16(0.038, 0.041, 0.816, -0.008), [0.008] * 17, trim, 6, 0.8, cap=False)
    elif top == 'hoodie':
        ellipsoid(shirt, Vector((-0.05, 0, 0.805)), (0.035, 0.07, 0.04), mix(tc, (0, 0, 0), 0.08), 16, 10)
        for s in (-1, 1):
            tube_path(shirt, [Vector((0.055, s * 0.016, 0.79)), Vector((0.063, s * 0.017, 0.75)), Vector((0.065, s * 0.018, 0.735))],
                      [0.0022, 0.0022, 0.0035], srgb('#f2f2f0'), 5)
    if sp['tie']:
        tie = srgb(sp['tie'])
        box(shirt, Vector((0.044, 0, 0.802)), (0.006, 0.008, 0.007), tie)
        tube_path(shirt, [Vector((0.046, 0, 0.795)), Vector((0.06, 0, 0.74)), Vector((0.064, 0, 0.68)), Vector((0.062, 0, 0.655))],
                  [0.008, 0.011, 0.013, 0.001], tie, 6, 0.25, up=X)
    if sp['badge']:
        box(shirt, Vector((0.064, 0.045, 0.735)), (0.003, 0.009, 0.011), srgb('#d8dce2'))
        for s in (-1, 1): box(shirt, Vector((-0.004, s * 0.085, 0.802)), (0.02, 0.016, 0.003), trim)   # epaulettes

    # ----- arms, hands, sleeves -----
    for s in (-1, 1):
        sk = P('Skin', 'arm', 1)
        a0 = armr * bulk
        prof = [(0.07, a0, a0 * 1.03, 0.787), (0.12, a0, a0 * 1.03, 0.786), (0.19, a0 * 0.9, a0 * 0.9, 0.785), (0.245, a0 * 0.78, a0 * 0.78, 0.784),
                (0.27, a0 * 0.8, a0 * 0.78, 0.784), (0.33, a0 * 0.74, a0 * 0.68, 0.783), (0.38, a0 * 0.6, a0 * 0.53, 0.782),
                (0.392, a0 * 0.58, a0 * 0.5, 0.782)]
        loft(sk, [ring(Vector((0, s * a, z)), X, Z, rx, rz, R(14, 10)) for a, rx, rz, z in prof], C['skin'])
        hand = P('Skin', 'arm', 1)
        hk = 0.92 if fem else 1.04
        palm = [(0.388, 0.019, 0.013), (0.40, 0.025, 0.014), (0.42, 0.027, 0.0125), (0.437, 0.026, 0.0105), (0.442, 0.021, 0.0085)]
        loft(hand, [ring(Vector((0.002, s * (0.388 + (a - 0.388) * hk), 0.781)), X, Z, rx * hk, rz * hk, R(14, 10), 2.6) for a, rx, rz in palm], C['skin'])
        if not npc:
            for fx, fl in ((0.017, 0.040), (0.0058, 0.046), (-0.0058, 0.044), (-0.017, 0.036)):
                base = Vector((fx * hk, s * (0.388 + 0.048 * hk), 0.781))
                pts = [base + Y * (s * fl * hk * k / 4) - Z * (0.004 * (k / 4) ** 2) for k in range(5)]
                tube_path(hand, pts, [r * hk for r in (0.0058, 0.0056, 0.0053, 0.0049, 0.0032)], C['skin'], 8, 0.85)
        else:   # a mitten of fingers
            loft(hand, [ring(Vector((0.0, s * (0.388 + (a - 0.388) * hk), 0.781)), X, Z, rx * hk, rz * hk, 10, 2.6)
                        for a, rx, rz in ((0.44, 0.021, 0.008), (0.465, 0.021, 0.007), (0.482, 0.016, 0.005), (0.487, 0.008, 0.003))], C['skin'])
        tb = Vector((0.022 * hk, s * 0.405, 0.778))
        tube_path(hand, [tb + Vector((0.012 * k / 3, s * 0.013 * k / 3, -0.003 * k / 3)) * hk for k in range(4)],
                  [r * hk for r in (0.0072, 0.0065, 0.0058, 0.0040)], C['skin'], 8, 0.85)
        sl = P('Cloth', 'arm', 1)
        sr = (a0 + 0.011) * loose
        if sp['sleeve'] == 'long':
            sprof = [(0.06, sr, sr * 1.04, 0.787), (0.12, sr, sr * 1.03, 0.786), (0.19, sr * 0.92, sr * 0.93, 0.785), (0.25, sr * 0.85, sr * 0.85, 0.784),
                     (0.31, sr * 0.82, sr * 0.8, 0.783), (0.355, sr * 0.75, sr * 0.72, 0.782), (0.372, sr * 0.72, sr * 0.68, 0.782),
                     (0.374, sr * 0.6, sr * 0.55, 0.782)]
        else:
            sprof = [(0.06, sr, sr * 1.04, 0.787), (0.10, sr * 1.01, sr * 1.04, 0.787), (0.16, sr * 0.97, sr * 0.98, 0.786), (0.205, sr * 0.9, sr * 0.92, 0.785),
                     (0.21, sr * 0.9, sr * 0.92, 0.785)]
        nsl = len(sprof)
        loft(sl, [ring(Vector((0, s * a, z)), X, Z, rx, rz, R(16, 12), 2.2) for a, rx, rz, z in sprof],
             lambda i, j: trim if i >= nsl - 2 else tc, cap0=False, cap1=True)
        if sp['stripe']:
            stc = srgb(sp['stripe'])
            sl.recolor(lambda co, c: stc if (co.z - 0.784) > sr * 0.72 and abs(co.y) > 0.1 else None)

    # ----- belt, bottoms -----
    bottom, bc = sp['bottom'], C['bottom_c']
    pants = P('Cloth', 'body', 1)
    pz = [(0.475, 0.080, 0.058, 0.0), (0.52, 0.083, 0.059, 0.002), (0.56, 0.082, 0.059, 0.003), (0.598, 0.083, 0.060, 0.003)]
    if fem: pz = [(z, w * 1.07, d, dx) for z, w, d, dx in pz]
    if bottom == 'skirt':
        sk_r = [(0.60, 0.078, 0.058), (0.55, 0.090, 0.066), (0.48, 0.104, 0.078), (0.40, 0.118, 0.09), (0.385, 0.119, 0.091)]
        loft(pants, [ring(Vector((0.002, 0, z)), X, Y, d * bulk, w * bulk, R(40, 28), 2.0,
                          wob=(lambda t, z=z: 0.035 * abs(math.sin(t * 9)) * ramp(0.6 - z, 0, 0.1))) for z, w, d in sk_r],
             bc, cap0=False, cap1=True)
    else:
        loft(pants, [ring(Vector((dx, 0, z)), X, Y, d * bulk, w * bulk, R(24, 18), 2.4) for z, w, d, dx in pz], bc)
    for s in (-1, 1):
        if bottom == 'wide':
            lp_ = [(0.53, 0.052, 0.050), (0.46, 0.051, 0.050), (0.36, 0.048, 0.047), (0.27, 0.046, 0.045), (0.15, 0.048, 0.047), (0.05, 0.051, 0.050), (0.032, 0.0515, 0.0505)]
        elif bottom in ('jeans', 'trousers'):
            lp_ = [(0.53, 0.051, 0.049), (0.46, 0.049, 0.047), (0.36, 0.044, 0.043), (0.27, 0.040, 0.039), (0.15, 0.039, 0.038), (0.06, 0.038, 0.037), (0.045, 0.0385, 0.0375)]
        elif bottom == 'shorts':
            lp_ = [(0.53, 0.053, 0.051), (0.46, 0.054, 0.052), (0.38, 0.055, 0.053), (0.355, 0.055, 0.053)]
        else:
            lp_ = []
        if fem and lp_: lp_ = [(z, rx * 0.96, ry * 0.96) for z, rx, ry in lp_]
        if lp_:
            leg = P('Cloth', 'leg', 1)
            legc = (lambda i, j: mix(bc, srgb('#ffffff'), 0.08) if 2 <= i <= 3 else bc) if bottom == 'jeans' else bc
            loft(leg, [ring(Vector((0.004, s * legy * (1.04 if bottom == 'wide' else 1.0), z)), X, Y, rx * bulk, ry * bulk, R(18, 12), 2.2)
                       for z, rx, ry in lp_], legc)
        if bottom in ('skirt', 'shorts'):
            legc_ = C['legs'] if sp['legs'] else C['skin']
            bare = P('Cloth' if sp['legs'] else 'Skin', 'leg', 1)
            k = 0.92 if fem else 1.0
            lz = [(0.5, 0.044), (0.42, 0.04), (0.34, 0.036), (0.28, 0.031), (0.2, 0.033), (0.11, 0.025), (0.05, 0.022), (0.035, 0.022)]
            sock = C['socks'] if bottom == 'shorts' else legc_
            loft(bare, [ring(Vector((0.004, s * legy, z)), X, Y, r * k * bulk, r * k * bulk, R(14, 10)) for z, r in lz],
                 lambda i, j: sock if i >= 5 else legc_)
    if sp['belt'] and not long_hem:
        belt = P('Cloth', 'body', 0)
        bw_ = 1.07 if fem else 1.0
        loft(belt, [ring(Vector((0.003, 0, z)), X, Y, 0.0625 * bulk, 0.0865 * bw_ * bulk, 28, 2.4) for z in (0.580, 0.597)], C['belt'], False, False)
        loft(belt, [ring(Vector((0.003, 0, z)), X, Y, 0.0605 * bulk, 0.0845 * bw_ * bulk, 28, 2.4) for z in (0.597, 0.580)], C['belt'], False, False)
        shiny = P('Gloss', 'body', 0)
        box(shiny, Vector((0.064 * bulk, 0, 0.5885)), (0.003, 0.011, 0.0075), C['buckle'])
        if top == 'uniform':
            for yy in (-0.07, -0.045, 0.05, 0.075):
                box(belt, Vector((0.035 * bulk, yy * bulk, 0.586)), (0.022, 0.009, 0.012), C['belt'])

    # ----- shoes -----
    kind = sp['shoes']
    for s in (-1, 1):
        sh = P('Gloss', 'foot', 1)
        hgt = {'loafer': 1.0, 'sneaker': 1.18, 'boot': 1.25, 'flat': 0.85, 'dress': 1.0}[kind]
        fs = [(-0.048, 0.016, 0.034), (-0.04, 0.022, 0.042), (-0.015, 0.024, 0.044), (0.02, 0.025, 0.036), (0.06, 0.026, 0.027), (0.09, 0.023, 0.022),
              (0.104, 0.016, 0.016), (0.110, 0.006, 0.010)]
        if kind == 'sneaker': fs = [(x, w * 1.08, z * 1.15) for x, w, z in fs]
        nr = R(18, 12)
        rings = [ring(Vector((x, s * 0.05, z * hgt / 2)), Y, Z, w, z * hgt / 2, nr, 2.6) for x, w, z in fs]
        lo, hi = (nr * 0.6, nr * 0.95) if kind != 'sneaker' else (nr * 0.4, nr * 1.0)
        loft(sh, rings, lambda i, j: C['sole'] if lo < j < hi else C['shoes_c'])
        if kind == 'boot':
            loft(sh, [ring(Vector((0.0, s * 0.05, z)), X, Y, 0.032, 0.03, R(16, 12)) for z in (0.03, 0.08, 0.125, 0.13)], C['shoes_c'])
        if kind == 'sneaker':
            for k in range(3):
                box(sh, Vector((0.03 + k * 0.016, s * 0.05, 0.047 - k * 0.004)), (0.003, 0.012, 0.0015), srgb('#f2f2f0'))

    # ----- skeleton -----
    joints = {
        'hips': (0, 0, 0.505), 'spine': (0, 0, 0.60), 'chest': (0, 0, 0.70), 'neck': (-0.005, 0, 0.80), 'head': (-0.005, 0, 0.848),
        'legR': (0, -legy, 0.47), 'shinR': (0.003, -legy - 0.001, 0.27), 'footR': (0, -0.05, 0.05),
        'legL': (0, legy, 0.47), 'shinL': (0.003, legy + 0.001, 0.27), 'footL': (0, 0.05, 0.05),
        'armR': (0, -shoulder, 0.787), 'foreR': (0, -0.255, 0.784), 'handR': (0, -0.39, 0.782),
        'armL': (0, shoulder, 0.787), 'foreL': (0, 0.255, 0.784), 'handL': (0, 0.39, 0.782),
    }

    def chain(v, stops):
        if v <= stops[0][1]: return {stops[0][0]: 1.0}
        for (b0, p0), (b1, p1) in zip(stops, stops[1:]):
            if v <= p1:
                t = (v - p0) / (p1 - p0) if p1 > p0 else 1
                t = t * t * (3 - 2 * t)
                return {b0: 1 - t, b1: t} if b0 != b1 else {b0: 1.0}
        return {stops[-1][0]: 1.0}
    body_stops = [('hips', 0.50), ('hips', 0.54), ('spine', 0.63), ('chest', 0.71), ('chest', 0.79), ('neck', 0.825), ('head', 0.85)]
    def weights(kind, co):
        side = 'R' if co.y < 0 else 'L'
        if kind == 'head': return {'head': 1.0}
        if kind == 'foot':
            return chain(co.z, [('foot' + side, 0.06), ('shin' + side, 0.1)]) if co.z > 0.06 else {'foot' + side: 1.0}
        if kind == 'arm':
            return chain(abs(co.y), [('chest', shoulder - 0.02), ('arm' + side, shoulder + 0.015), ('arm' + side, 0.235), ('fore' + side, 0.275),
                                     ('fore' + side, 0.372), ('hand' + side, 0.395)])
        if kind == 'leg':
            return chain(-co.z, [('hips', -0.535), ('leg' + side, -0.45), ('leg' + side, -0.30), ('shin' + side, -0.245),
                                 ('shin' + side, -0.075), ('foot' + side, -0.04)])
        w = chain(co.z, body_stops)
        if co.z > 0.72:
            a = ramp(abs(co.y), shoulder - 0.023, shoulder + 0.01) * 0.8
            if a > 0:
                w = {k: v * (1 - a) for k, v in w.items()}
                w['arm' + side] = w.get('arm' + side, 0) + a
        if co.z < 0.53:
            a = ramp(abs(co.y), 0.015, 0.06) * ramp(0.53 - co.z, 0.0, 0.05) * (0.85 if co.z < 0.47 else 0.6)
            if a > 0:
                w = {k: v * (1 - a) for k, v in w.items()}
                w['leg' + side] = w.get('leg' + side, 0) + a
        return w

    for pt in parts:
        for v in pt.bm.verts:
            for b, w in weights(pt.kind, v.co).items():
                if w > 1e-4: v[pt.dl][GI[b]] = w

    # ----- armature and one object per material -----
    arm_data = bpy.data.armatures.new(name + '_rig')
    rig = bpy.data.objects.new(name + '_rig', arm_data)
    bpy.context.scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    parent = {'spine': 'hips', 'chest': 'spine', 'neck': 'chest', 'head': 'neck', 'armR': 'chest', 'foreR': 'armR', 'handR': 'foreR',
              'armL': 'chest', 'foreL': 'armL', 'handL': 'foreL', 'legR': 'hips', 'shinR': 'legR', 'footR': 'shinR',
              'legL': 'hips', 'shinL': 'legL', 'footL': 'shinL'}
    tails = {'hips': 'spine', 'spine': 'chest', 'chest': 'neck', 'neck': 'head', 'armR': 'foreR', 'foreR': 'handR', 'armL': 'foreL',
             'foreL': 'handL', 'legR': 'shinR', 'shinR': 'footR', 'legL': 'shinL', 'shinL': 'footL'}
    eb = {}
    for n in BONES:
        b = arm_data.edit_bones.new(n)
        b.head = joints[n]
        if n in tails: b.tail = joints[tails[n]]
        elif n == 'head': b.tail = (joints[n][0], 0, 0.98)
        elif n.startswith('hand'): b.tail = (0, joints[n][1] * 1.2, joints[n][2])
        else: b.tail = (0.08, joints[n][1], joints[n][2])
        if (Vector(b.tail) - Vector(b.head)).length < 1e-4: b.tail = Vector(b.head) + Vector((0, 0, 0.02))
        eb[n] = b
    for n, p in parent.items(): eb[n].parent = eb[p]
    bpy.ops.object.mode_set(mode='OBJECT')

    objs = []
    for g in ('Skin', 'Cloth', 'Hair', 'Gloss'):
        tmp = [pt for pt in parts if pt.group == g]
        if not tmp: continue
        me = bpy.data.meshes.new(f'{name}_{g}')
        ob = bpy.data.objects.new(f'{name}_{g}', me)
        bpy.context.scene.collection.objects.link(ob)
        for n in BONES: ob.vertex_groups.new(name=n)
        pieces = []
        for pt in tmp:
            m2 = bpy.data.meshes.new('tmp')
            bmesh.ops.recalc_face_normals(pt.bm, faces=pt.bm.faces)
            pt.bm.to_mesh(m2)
            o2 = bpy.data.objects.new('tmp', m2)
            bpy.context.scene.collection.objects.link(o2)
            for n in BONES: o2.vertex_groups.new(name=n)
            if pt.solid:
                mod = o2.modifiers.new('solid', 'SOLIDIFY'); mod.thickness = pt.solid; mod.offset = 1.0
            if pt.smooth:
                mod = o2.modifiers.new('sub', 'SUBSURF'); mod.levels = pt.smooth; mod.render_levels = pt.smooth
            pieces.append(o2)
        for o2 in pieces:
            bpy.context.view_layer.objects.active = o2
            for mod in list(o2.modifiers): bpy.ops.object.modifier_apply(modifier=mod.name)
        bpy.ops.object.select_all(action='DESELECT')
        for o2 in pieces: o2.select_set(True)
        ob.select_set(True)
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.join()
        for p in ob.data.polygons: p.use_smooth = True
        if 'Col' in ob.data.color_attributes:
            ob.data.color_attributes.active_color = ob.data.color_attributes['Col']
            ob.data.color_attributes.render_color_index = ob.data.color_attributes.find('Col')
        ob.parent = rig
        mod = ob.modifiers.new('rig', 'ARMATURE'); mod.object = rig
        objs.append(ob)

    sc = lambda z: 0.84 + (z - 0.84) * S_HEAD
    meta = {
        'name': name,
        'bones': {n: [joints[n][0], joints[n][2], -joints[n][1]] for n in BONES},
        'eyeY': sc(ez), 'faceX': 0.068, 'hairTop': sc(1.0), 'hairHalf': 0.075, 'neckY': 0.815, 'crownX': -0.012,
        'hat': sp['hat'],
    }
    return rig, objs, meta


def preview(objs, path):
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE_NEXT'
    sc.render.resolution_x, sc.render.resolution_y = 600, 600
    sc.eevee.taa_render_samples = 16
    sc.world = bpy.data.worlds.new('w'); sc.world.use_nodes = True
    sc.world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.45, 0.6, 0.85, 1)
    sc.world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.8
    rough = {'Skin': 0.5, 'Cloth': 0.85, 'Hair': 0.45, 'Gloss': 0.2}
    for o in objs:
        g = o.name.split('_')[-1]
        m = bpy.data.materials.new(g); m.use_nodes = True
        a = m.node_tree.nodes.new('ShaderNodeVertexColor'); a.layer_name = 'Col'
        bsdf = m.node_tree.nodes['Principled BSDF']
        m.node_tree.links.new(a.outputs['Color'], bsdf.inputs['Base Color'])
        bsdf.inputs['Roughness'].default_value = rough[g]
        o.data.materials.append(m)
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(40), 0, math.radians(60)); sc.collection.objects.link(sun)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
    for suf, loc, tgt, lens in [('_full', (2.2, -1.1, 0.62), (0, 0, 0.52), 50), ('_face', (0.5, -0.3, 1.02), (0, 0, 0.92), 50)]:
        cam.location = loc
        cam.rotation_euler = (Vector(tgt) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        cam.data.lens = lens
        sc.render.filepath = path.replace('.png', suf + '.png')
        bpy.ops.render.render(write_still=True)
    for o in (sun, cam): bpy.data.objects.remove(o)
    for o in objs: o.data.materials.clear()


def main():
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    names = [a for a in args if not a.startswith('--')] or list(SPECS)
    os.makedirs(OUT, exist_ok=True)
    for name in names:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        rig, objs, meta = build(name, SPECS[name])
        if '--preview' in args:
            preview(objs, os.path.join(os.environ.get('PREVIEW_DIR', '/tmp'), f'char_{name}.png'))
        bpy.ops.object.select_all(action='DESELECT')
        rig.select_set(True)
        for o in objs: o.select_set(True)
        path = os.path.join(OUT, f'{name}.glb')
        kw = dict(filepath=path, export_format='GLB', use_selection=True, export_materials='NONE', export_normals=True,
                  export_texcoords=False, export_yup=True, export_skins=True, export_animations=False, export_apply=False)
        try:
            bpy.ops.export_scene.gltf(**kw, export_vertex_color='ACTIVE')
        except TypeError:
            bpy.ops.export_scene.gltf(**kw, export_colors=True)
        pack(path)
        with open(os.path.join(OUT, f'{name}.json'), 'w') as f:
            json.dump(meta, f)
        tris = sum(len(o.data.polygons) for o in objs)
        print(f'{name}: {tris} faces -> {os.path.relpath(path, ROOT)} ({os.path.getsize(path) // 1024} KB)', flush=True)


main()
