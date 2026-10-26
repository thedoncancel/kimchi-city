"""Build the luxury cars for Kimchi City in Blender and export each one as assets/cars/<type>.glb.

Run headless:
  ~/Applications/Blender.app/Contents/MacOS/Blender -b -P tools/blender/build_cars.py -- [types...] [--preview]

Each car is a lofted body (rounded cross-sections along a smooth side profile), a glass cabin with a painted
roof, wheel arches cut out, and detail parts (grilles, lights, intakes, spoilers). Objects are named by role
so the game can put its own materials on them: Body, Lower (second paint colour), Glass, Trim (vertex
coloured dark parts), Chrome, Head, Tail, Wheel (vertex coloured tyre and rim, one wheel at the origin).
Sizes match src/data.js (length, width) and the PRO table in src/3d/cars.js (heights, wheels), which the
game still uses for driving, seats and wheel placement. Blender is Z-up; glTF export turns that into Y-up,
and Blender -Y becomes the game's +Z (the car's right side).
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'assets', 'cars')
S = 1 / 16

# len/wid in sim px (src/data.js), the rest from PRO in src/3d/cars.js plus shape controls:
# plan: how square the car is seen from above (higher = boxier); sec: how square its cross-section is
CARS = {
    'ursa': dict(pillars=(0.5,), len=80, wid=34, hb=1.0, hf=0.96, ht=1.0, cr0=-0.47, cr1=-0.15, cf1=0.07, cf0=0.27, hr=1.58, R=0.43, wx=0.33, sill=0.42,
                 wheel='black', tw=0.32, plan=5, sec=4.5),
    'gwagen': dict(pillars=(0.05, 0.36, 0.64, 0.97), len=74, wid=34, hb=1.14, hf=1.12, ht=1.14, cr0=-0.49, cr1=-0.47, cf1=0.06, cf0=0.12, hr=1.98, R=0.42, wx=0.31, sill=0.46,
                   wheel='black', tw=0.3, plan=14, sec=10, box=True),
    'monarch': dict(pillars=(0.42,), len=84, wid=33, hb=0.94, hf=0.82, ht=0.94, cr0=-0.33, cr1=-0.21, cf1=0.1, cf0=0.27, hr=1.48, R=0.37, wx=0.34, sill=0.33,
                    wheel='chrome', two=0.64, plan=7, sec=5),
    'phantasma': dict(pillars=(0.3, 0.6), len=92, wid=35, hb=1.05, hf=1.0, ht=1.0, cr0=-0.37, cr1=-0.26, cf1=0.07, cf0=0.22, hr=1.64, R=0.41, wx=0.35, sill=0.37,
                      wheel='chrome', plan=9, sec=6),
    'cavallo': dict(pillars=(0.62,), len=76, wid=33, hb=0.8, hf=0.6, ht=0.84, cr0=-0.36, cr1=-0.21, cf1=-0.02, cf0=0.16, hr=1.2, R=0.35, wx=0.34, sill=0.24,
                    wheel='sport', tw=0.3, plan=4, sec=3.2),
    'papaya': dict(pillars=(), len=72, wid=33, hb=0.78, hf=0.5, ht=0.92, cr0=-0.21, cr1=-0.09, cf1=0.06, cf0=0.3, hr=1.17, R=0.34, wx=0.32, sill=0.22,
                   wheel='sport', tw=0.3, plan=3.6, sec=3.0),
    'bolide': dict(pillars=(0.6,), len=75, wid=34, hb=0.84, hf=0.62, ht=0.94, cr0=-0.26, cr1=-0.12, cf1=0.06, cf0=0.26, hr=1.18, R=0.36, wx=0.31, sill=0.24,
                   wheel='sport', tw=0.32, two=0.5, plan=3.4, sec=3.0),
}

# Cartoon (Fortnite-style) proportions on top of the real-car numbers: bigger wheels, rounder bodies seen
# from above and in section, a taller bubblier cabin. WHEEL_K must match src/3d/cars.js.
WHEEL_K = 1.14


def cartoon(c):
    c = dict(c)
    c['R'] = c['R'] * WHEEL_K
    c['sill'] = c['sill'] + c['R'] * (1 - 1 / WHEEL_K) * 0.6
    c['plan'] = max(2.6, c['plan'] * (0.85 if c.get('box') else 0.75))
    c['sec'] = max(2.4, c['sec'] * (0.85 if c.get('box') else 0.72))
    c['hr'] = c['hr'] + (0.04 if c.get('box') else 0.08)
    c['tw'] = c.get('tw', 0.24) * 1.12
    return c


DARK, BLACK, PLATE, AMBER = (0.025, 0.025, 0.028), (0.009, 0.009, 0.01), (0.86, 0.86, 0.84), (0.8, 0.29, 0.05)


# ---------- helpers ----------

def pchip(xs, ys):
    """Monotone cubic through the points, so profiles are smooth but never overshoot."""
    n = len(xs)
    h = [xs[i + 1] - xs[i] for i in range(n - 1)]
    d = [(ys[i + 1] - ys[i]) / h[i] if h[i] else 0 for i in range(n - 1)]
    m = [0.0] * n
    m[0], m[-1] = d[0], d[-1]
    for i in range(1, n - 1):
        if d[i - 1] * d[i] <= 0:
            m[i] = 0
        else:
            w1, w2 = 2 * h[i] + h[i - 1], h[i] + 2 * h[i - 1]
            m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])

    def f(x):
        if x <= xs[0]: return ys[0]
        if x >= xs[-1]: return ys[-1]
        for i in range(n - 1):
            if x <= xs[i + 1]:
                t = (x - xs[i]) / h[i]
                t2, t3 = t * t, t * t * t
                return ((2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i]
                        + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1])
        return ys[-1]
    return f


def sgnpow(v, p):
    return math.copysign(abs(v) ** p, v)


def new_obj(name, bm):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def loft(xs, ring, cap=True):
    """Join cross-section rings (lists of (y, z)) taken at each x into a closed tube."""
    bm = bmesh.new()
    rings = []
    for x in xs:
        rings.append([bm.verts.new((x, y, z)) for y, z in ring(x)])
    n = len(rings[0])
    for a, b in zip(rings, rings[1:]):
        for j in range(n):
            k = (j + 1) % n
            bm.faces.new((a[j], a[k], b[k], b[j]))
    if cap:
        bm.faces.new(list(reversed(rings[0])))
        bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def section(w, zb, zt, n, tumble=0.1, m=24):
    """A rounded box cross-section: superellipse, a little narrower at the top (tumblehome)."""
    zc, hz = (zb + zt) / 2, (zt - zb) / 2
    pts = []
    for i in range(m):
        th = 2 * math.pi * i / m
        c, s = math.cos(th), math.sin(th)
        z = zc + hz * sgnpow(s, 2 / n)
        k = 1 - tumble * max(0.0, (z - zc) / hz) ** 1.5
        pts.append((w * sgnpow(c, 2 / n) * k, z))
    return pts


def stations(x0, x1, n):
    """More stations near the ends, where the shape turns fastest."""
    return [x0 + (x1 - x0) * (0.5 - 0.5 * math.cos(math.pi * i / (n - 1))) for i in range(n)]


def boolean(ob, cutter, op='DIFFERENCE'):
    mod = ob.modifiers.new('cut', 'BOOLEAN')
    mod.operation = op
    mod.object = cutter
    mod.solver = 'EXACT'
    apply(ob)


def apply(ob):
    bpy.context.view_layer.objects.active = ob
    for mod in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=mod.name)


def box(bm, x0, y0, z0, x1, y1, z1, color=None, bevel=0.0):
    """An axis-aligned box into a bmesh, optionally with softened edges. Takes game axes
    (x forward, y up, z right) and places it in Blender's (x forward, -y right, z up)."""
    y0, y1, z0, z1 = -z0, -z1, y0, y1
    before = set(bm.faces)
    res = bmesh.ops.create_cube(bm, size=1)
    vs = res['verts']
    for v in vs:
        v.co = Vector(((x0 + x1) / 2 + v.co.x * abs(x1 - x0), (y0 + y1) / 2 + v.co.y * abs(y1 - y0), (z0 + z1) / 2 + v.co.z * abs(z1 - z0)))
    if bevel > 0:
        edges = list({e for v in vs for e in v.link_edges})
        bmesh.ops.bevel(bm, geom=vs + edges, offset=min(bevel, abs(x1 - x0) / 2.2, abs(y1 - y0) / 2.2, abs(z1 - z0) / 2.2),
                        segments=1, affect='EDGES', profile=0.5)
    new = set(bm.faces) - before
    if color:
        paint(bm, new, color)
    return list({v for f in new for v in f.verts})


def cyl(bm, x, y, z, r, depth, axis='y', segs=16, color=None):
    res = bmesh.ops.create_cone(bm, cap_ends=True, segments=segs, radius1=r, radius2=r, depth=depth)
    rot = {'x': Matrix.Rotation(math.pi / 2, 4, 'Y'), 'y': Matrix.Rotation(math.pi / 2, 4, 'X'), 'z': Matrix.Identity(4)}[axis]
    bmesh.ops.transform(bm, matrix=Matrix.Translation((x, y, z)) @ rot, verts=res['verts'])
    if color:
        paint(bm, set(f for v in res['verts'] for f in v.link_faces), color)
    return res['verts']


def paint(bm, faces, color):
    layer = bm.loops.layers.color.get('Col') or bm.loops.layers.color.new('Col')
    for f in faces:
        for lp in f.loops:
            lp[layer] = (*color, 1.0)


def finish(ob, angle=40):
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(angle))
    ob.select_set(False)


# ---------- one car ----------

def build(t, c):
    L, W = c['len'] * S, c['wid'] * S
    hl = L / 2
    X = lambda f: f * L
    R, wx = c['R'], c['wx'] * L
    objs = []

    # side profile of the body top (tail -> deck -> cabin base -> hood -> nose) and the plan shape
    if c.get('box'):
        top = pchip([-hl, -hl + 0.06, hl - 0.08, hl], [c['hb'] - 0.04, c['hb'] + 0.02, c['hb'], c['hb'] - 0.1])
    else:
        top = pchip([-hl, -hl + 0.16, X(c['cr0']), X(c['cf0']), hl - 0.34, hl - 0.06, hl],
                    [c['ht'] - 0.12, c['ht'], c['hb'], c['hb'], c['hf'], c['hf'] - 0.08, c['hf'] - 0.22])
    plan_p = c['plan']
    plan = lambda x: max(0.62, (1 - min(1.0, abs(x / hl)) ** plan_p) ** (1 / plan_p))
    bottom = lambda x: c['sill'] - 0.08 + 0.1 * abs(x / hl) ** 6
    xs = stations(-hl, hl, 40)
    body = new_obj(f'{t}_Body', loft(xs, lambda x: section(W / 2 * plan(x), bottom(x), top(x), c['sec'], tumble=0.08)))

    # the cabin: glass all round with the roof (upward faces) painted like the body
    g0, g1 = X(c['cr0']) + 0.04, X(c['cf0'])
    if c.get('box'):
        roof = pchip([g0, g0 + 0.05, X(c['cf1']), g1], [c['hb'] - 0.02, c['hr'] - 0.04, c['hr'] - 0.04, c['hb'] - 0.02])
    else:
        roof = pchip([g0, X(c['cr1']), X(c['cf1']), g1], [c['hb'] - 0.02, c['hr'], c['hr'], c['hb'] - 0.02])
    gxs = stations(g0, g1, 22)
    cab = loft(gxs, lambda x: section(W / 2 * plan(x) * (0.9 if c.get('box') else 0.86), c['hb'] - 0.12, roof(x),
                                      6 if c.get('box') else 3.2, tumble=0.06 if c.get('box') else 0.24))
    # split: the top band of every ring (minus the steep windscreen and rear window) is the painted roof
    cab.normal_update()
    cab.faces.ensure_lookup_table()
    m = 24
    band = lambda i: math.sin(2 * math.pi * ((i % m) + 0.5) / m) > 0.5
    pil = [g0 + (g1 - g0) * f for f in c.get('pillars', ())]
    def pillar(i):
        if i >= (len(gxs) - 1) * m: return False
        k = i // m
        return any(gxs[k] - 0.035 <= p <= gxs[k + 1] + 0.035 for p in pil)
    # only the flat part of the roof is painted; windscreen and rear window stay glass however gently they slope
    r0, r1 = (g0 + 0.06, g1 - 0.06) if c.get('box') else (X(c['cr1']) - 0.08, X(c['cf1']) + 0.1)
    def flat(i):
        k = i // m
        return r0 <= (gxs[k] + gxs[k + 1]) / 2 <= r1
    is_roof = [i < (len(gxs) - 1) * m and ((band(i) and cab.faces[i].normal.z > 0.55 and flat(i)) or pillar(i)) for i in range(len(cab.faces))]
    roof_bm = cab.copy()
    roof_bm.faces.ensure_lookup_table()
    bmesh.ops.delete(roof_bm, geom=[f for i, f in enumerate(roof_bm.faces) if not is_roof[i]], context='FACES')
    bmesh.ops.delete(cab, geom=[f for i, f in enumerate(cab.faces) if is_roof[i]], context='FACES')
    glass = new_obj(f'{t}_Glass', cab)
    roof_ob = new_obj(f'{t}_Roof', roof_bm)

    # wheel arches: cut a wheel well into each side (not right through), then the faces the cut made go dark
    cutters = []
    inner = W / 2 - c.get('tw', 0.24) - 0.1
    for x in (wx, -wx):
        for sd in (-1, 1):
            bm = bmesh.new()
            cyl(bm, x, sd * (inner + 0.5), R, R + 0.07, 1.0, 'y', 24)
            cutters.append(new_obj('cut', bm))
    for cu in cutters:
        boolean(body, cu)
    for cu in cutters:
        bpy.data.objects.remove(cu)
    bm = bmesh.new(); bm.from_mesh(body.data)
    def in_well(f):
        q = f.calc_center_median()
        return any(math.hypot(q.x - x, q.z - R) < R + 0.075 for x in (wx, -wx)) and abs(q.y) > inner - 0.01 and q.z < R * 2 + 0.1
    well = [f for f in bm.faces if in_well(f)]
    wbm = bm.copy()
    bmesh.ops.delete(wbm, geom=[f for f in wbm.faces if not in_well(f)], context='FACES')
    bmesh.ops.delete(bm, geom=well, context='FACES')
    bm.to_mesh(body.data); bm.free()
    paint(wbm, wbm.faces, BLACK)
    trim = bmesh.new(); chrome = bmesh.new(); head = bmesh.new(); tail = bmesh.new()
    wme = bpy.data.meshes.new('well'); wbm.to_mesh(wme); wbm.free()
    trim.from_mesh(wme)

    details(t, c, L, W, hl, X, R, wx, trim, chrome, head, tail, Surf(body, W, hl))

    lower = None
    if c.get('two'):
        # the second paint colour: the body below the split line, pushed out a few millimetres
        lower = body.copy(); lower.data = body.data.copy(); lower.name = f'{t}_Lower'
        bpy.context.scene.collection.objects.link(lower)
        bm = bmesh.new(); bm.from_mesh(lower.data)
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, c['two']), plane_no=(0, 0, 1), clear_outer=True)
        for v in bm.verts:
            v.co.y *= 1.006
            v.co.x *= 1.002
        bm.to_mesh(lower.data); bm.free()
        if t == 'bolide':
            # the C-shaped sweep behind the doors in the second colour
            bm = bmesh.new(); bm.from_mesh(lower.data)
            for s in (-1, 1):
                box(bm, X(-0.08), c['sill'], s * W / 2 * 0.985 - 0.012, X(0.04), c['hb'] - 0.05, s * W / 2 * 0.985 + 0.012, None, 0.02)
            bm.to_mesh(lower.data); bm.free()

    parts = [body, glass, roof_ob, new_obj(f'{t}_Trim', trim), new_obj(f'{t}_Chrome', chrome), new_obj(f'{t}_Head', head), new_obj(f'{t}_Tail', tail)]
    if lower: parts.append(lower)
    for ob in parts:
        finish(ob, 30 if ob.name.endswith(('Trim', 'Chrome', 'Head', 'Tail')) else 50)
    # the painted roof goes into the body mesh
    bpy.ops.object.select_all(action='DESELECT')
    body.select_set(True); roof_ob.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    parts.remove(roof_ob)
    parts.append(wheel(t, c))
    return [p for p in parts if len(p.data.polygons)]


class Surf:
    """Ray casts onto the finished body so lamps, grilles and vents sit on the paint, not in the air."""
    def __init__(self, body, W, hl):
        dg = bpy.context.evaluated_depsgraph_get()
        self.bvh = BVHTree.FromObject(body, dg)
        self.W, self.hl = W, hl

    def front(self, y, z): return self._cast((self.hl + 2, y, z), (-1, 0, 0))
    def back(self, y, z): return self._cast((-self.hl - 2, y, z), (1, 0, 0))
    def side(self, x, z, s=1): return self._cast((x, s * (self.W + 2), z), (0, -s, 0))
    def top(self, x, y): return self._cast((x, y, 5), (0, 0, -1))

    def _cast(self, o, d):
        loc, nor, _, _ = self.bvh.ray_cast(Vector(o), Vector(d))
        if loc is None: return None
        if nor.dot(Vector(d)) > 0: nor = -nor
        return loc, nor


def frame(nor):
    """Axes for a part lying on a surface: out along the normal, 'up' as close to world up as it can be."""
    n = nor.normalized()
    up = Vector((0, 0, 1)) if abs(n.z) < 0.9 else Vector((1, 0, 0))
    u = (up - n * up.dot(n)).normalized()
    r = u.cross(n)
    return n, r, u


def decal(bm, hit, w, h, d=0.035, color=None, out=0.0, bevel=0.008):
    """A thin box centred on the surface hit, w across and h up the surface, standing out by d/2 (+ out)."""
    if not hit: return
    loc, nor = hit
    n, r, u = frame(nor)
    before = set(bm.faces)
    vs = bmesh.ops.create_cube(bm, size=1)['verts']
    for v in vs:
        p = v.co.copy()
        v.co = loc + n * (p.x * d + out) + r * (p.y * w) + u * (p.z * h)
    if bevel:
        edges = list({e for v in vs for e in v.link_edges})
        bmesh.ops.bevel(bm, geom=vs + edges, offset=min(bevel, d / 2.5, w / 2.5, h / 2.5), segments=1, affect='EDGES', profile=0.5)
    new = set(bm.faces) - before
    if color: paint(bm, new, color)
    return new


def disc(bm, hit, r, d=0.04, color=None, segs=20, out=0.0):
    if not hit: return
    loc, nor = hit
    n, _, _ = frame(nor)
    before = set(bm.faces)
    res = bmesh.ops.create_cone(bm, cap_ends=True, segments=segs, radius1=r, radius2=r, depth=d)
    rot = n.to_track_quat('Z', 'Y').to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=Matrix.Translation(loc + n * out) @ rot, verts=res['verts'])
    if color: paint(bm, set(bm.faces) - before, color)


def details(t, c, L, W, hl, X, R, wx, trim, chrome, head, tail, sf):
    hf, hb, ht, hr, sill = c['hf'], c['hb'], c['ht'], c['hr'], c['sill']
    sides = (-1, 1)
    box_car = c.get('box')

    # shared: plates, black sills between the wheels, mirrors at the base of the windscreen
    decal(trim, sf.front(0, sill + 0.1), 0.42, 0.11, 0.03, PLATE)
    decal(trim, sf.back(0, sill + (0.3 if box_car else 0.16)), 0.42, 0.11, 0.03, PLATE)
    for s in sides:
        box(trim, -wx + R + 0.1, sill - 0.06, s * W / 2 * 0.97 - 0.03, wx - R - 0.1, sill + 0.05, s * W / 2 * 0.97 + 0.03, BLACK, 0.015)
        mx = X(0.08) if box_car else X(c['cf0']) - 0.12
        h = sf.side(mx, hb - 0.08, s)
        if h:
            loc = h[0]
            box(trim, loc.x - 0.12, hb, -(loc.y + s * 0.0), loc.x, hb + 0.11, -(loc.y + s * 0.13), BLACK, 0.025)

    if t == 'ursa':
        decal(trim, sf.front(0, hf - 0.32), W * 0.5, 0.36, 0.05, BLACK)          # big grille
        for s in sides:
            decal(head, sf.front(s * (W / 2 - 0.36), hf - 0.12), 0.42, 0.06, 0.03)   # slim lamp
            decal(head, sf.front(s * (W / 2 - 0.3), hf - 0.34), 0.06, 0.2, 0.03)     # Y lamp stem
            decal(trim, sf.front(s * (W / 2 - 0.3), sill + 0.06), 0.36, 0.16, 0.04, BLACK)
            decal(tail, sf.back(s * (W / 2 - 0.3), ht - 0.2), 0.38, 0.07, 0.03)
            for y in (0.42, 0.58):
                hh = sf.back(s * y, sill + 0.02)
                if hh: cyl(chrome, hh[0].x - 0.02, s * y, sill + 0.02, 0.05, 0.12, 'x', 14)
            box(trim, -hl + 0.3, sill - 0.05, s * W / 2 * 0.985 - 0.02, hl - 0.3, sill + 0.14, s * W / 2 * 0.985 + 0.02, BLACK, 0.02)
        decal(tail, sf.back(0, ht - 0.2), W - 1.1, 0.04, 0.03)
        hh = sf.top(-hl + 0.22, 0)
        if hh: box(trim, -hl + 0.06, hh[0].z - 0.01, -W * 0.36, -hl + 0.3, hh[0].z + 0.05, W * 0.36, BLACK, 0.02)
    elif t == 'gwagen':
        decal(trim, sf.front(0, hb - 0.27), W * 0.5, 0.36, 0.05, BLACK)
        for z in (hb - 0.36, hb - 0.27, hb - 0.18): decal(chrome, sf.front(0, z), W * 0.46, 0.03, 0.07)
        box(trim, hl - 0.04, sill - 0.05, -W / 2, hl + 0.12, sill + 0.2, W / 2, BLACK, 0.03)
        box(trim, -hl - 0.1, sill - 0.05, -W / 2, -hl + 0.04, sill + 0.14, W / 2, BLACK, 0.03)
        for s in sides:
            disc(head, sf.front(s * (W / 2 - 0.3), hb - 0.27), 0.12, 0.06, None, 24)
            disc(chrome, sf.front(s * (W / 2 - 0.3), hb - 0.27), 0.145, 0.03, None, 24)
            box(trim, hl - 0.3, hb - 0.01, s * (W / 2 - 0.16) - 0.05, hl - 0.18, hb + 0.05, s * (W / 2 - 0.16) + 0.05, AMBER, 0.01)
            decal(tail, sf.back(s * (W / 2 - 0.12), hb - 0.36), 0.12, 0.42, 0.04)
            for x in (wx, -wx):
                box(trim, x - R - 0.14, 2 * R - 0.02, s * W / 2 - 0.05, x + R + 0.14, 2 * R + 0.1, s * (W / 2 + 0.07), BLACK, 0.02)
            box(trim, -wx + R + 0.14, sill - 0.16, s * W / 2 - 0.05, wx - R - 0.14, sill - 0.1, s * (W / 2 + 0.13), BLACK, 0.01)
        cyl(trim, -hl - 0.15, 0, hb - 0.32, R * 0.95, 0.26, 'x', 28, BLACK)
        cyl(trim, -hl - 0.29, 0, hb - 0.32, R * 0.62, 0.04, 'x', 28, DARK)
    elif t in ('monarch', 'phantasma'):
        ph = t == 'phantasma'
        gw, gh, gz = (0.36, 0.56, hf - 0.36) if ph else (0.32, 0.34, hf - 0.27)
        decal(chrome, sf.front(0, gz), 2 * gw + 0.08, gh + 0.08, 0.06)            # surround
        decal(trim, sf.front(0, gz), 2 * gw, gh, 0.08, BLACK)
        y = -gw + 0.03
        while y <= gw - 0.02:
            decal(chrome, sf.front(y, gz), 0.018, gh - 0.04, 0.1, bevel=0)
            y += 0.055
        hh = sf.top(hl - 0.2, 0)
        if hh: box(chrome, hh[0].x - 0.03, hh[0].z, -0.02, hh[0].x + 0.03, hh[0].z + 0.11, 0.02, None, 0.008)   # the lady
        for s in sides:
            decal(head, sf.front(s * (gw + 0.28), hf - 0.18), 0.34, 0.11, 0.035)
            decal(tail, sf.back(s * (W / 2 - 0.18), ht - 0.24), 0.16, 0.3, 0.035)
            box(chrome, X(c['cr0']) + 0.1, hb - 0.04, s * W / 2 * 0.985 - 0.008, X(c['cf0']) - 0.05, hb - 0.01, s * W / 2 * 0.985 + 0.008)
            if c.get('two'): box(chrome, -hl + 0.12, c['two'] - 0.012, s * W / 2 * 0.995 - 0.008, hl - 0.12, c['two'] + 0.012, s * W / 2 * 0.995 + 0.008)
            hh = sf.back(s * 0.5, sill + 0.02)
            if hh: cyl(chrome, hh[0].x - 0.02, s * 0.5, sill + 0.02, 0.045, 0.1, 'x', 14)
        decal(chrome, sf.back(0, ht - 0.1), W * 0.55, 0.025, 0.03, bevel=0)
    elif t == 'cavallo':
        decal(trim, sf.front(0, sill + 0.08), W * 0.6, 0.14, 0.04, BLACK)
        for s in sides:
            decal(head, sf.front(s * (W / 2 - 0.3), hf - 0.08), 0.36, 0.07, 0.03)
            decal(trim, sf.side(X(0.2), hb - 0.22, s), 0.3, 0.18, 0.05, BLACK)       # side intake
            for y in (0.42, 0.68): disc(tail, sf.back(s * y, ht - 0.16), 0.07, 0.04, None, 20)
            for y in (0.18, 0.3):
                hh = sf.back(s * y, sill + 0.04)
                if hh: cyl(chrome, hh[0].x - 0.02, s * y, sill + 0.04, 0.045, 0.12, 'x', 14)
        decal(trim, sf.back(0, sill + 0.02), W * 0.7, 0.08, 0.05, BLACK)
    elif t == 'papaya':
        decal(trim, sf.front(0, sill + 0.06), W * 0.66, 0.1, 0.04, BLACK)
        for s in sides:
            decal(head, sf.front(s * (W / 2 - 0.28), hf - 0.06), 0.32, 0.06, 0.03)
            decal(trim, sf.side(X(-0.17), (sill + hb) / 2, s), 0.5, 0.26, 0.06, BLACK)  # big side scoop
            box(trim, -hl + 0.14, ht - 0.02, s * W * 0.33 - 0.03, -hl + 0.22, ht + 0.16, s * W * 0.33 + 0.03, BLACK, 0.01)
        box(trim, -hl - 0.04, ht + 0.14, -W * 0.46, -hl + 0.38, ht + 0.2, W * 0.46, BLACK, 0.02)
        decal(tail, sf.back(0, ht - 0.16), W - 0.5, 0.05, 0.03)
        decal(trim, sf.back(0, sill + 0.02), W * 0.7, 0.08, 0.05, BLACK)
    elif t == 'bolide':
        decal(chrome, sf.front(0, sill + 0.12), 0.44, 0.24, 0.05)                     # horseshoe
        decal(trim, sf.front(0, sill + 0.13), 0.34, 0.18, 0.07, BLACK)
        for s in sides:
            for k in (0, 1): decal(head, sf.front(s * (W / 2 - 0.3), hf - 0.08 - k * 0.06), 0.3, 0.035, 0.03)
            decal(trim, sf.front(s * (W / 2 - 0.25), sill + 0.06), 0.34, 0.12, 0.04, BLACK)
            decal(trim, sf.side(X(-0.12), (sill + hb) / 2 + 0.04, s), 0.36, 0.2, 0.05, BLACK)
            box(trim, -hl + 0.12, ht - 0.04, s * W * 0.3 - 0.025, -hl + 0.22, ht + 0.04, s * W * 0.3 + 0.025, BLACK, 0.01)
        box(trim, X(c['cr0']), hr - 0.01, -0.025, X(c['cf1']) - 0.05, hr + 0.05, 0.025, BLACK, 0.01)
        box(trim, -hl - 0.02, ht + 0.03, -W * 0.42, -hl + 0.32, ht + 0.08, W * 0.42, BLACK, 0.02)
        decal(tail, sf.back(0, ht - 0.18), W - 0.4, 0.06, 0.03)
        decal(trim, sf.back(0, sill + 0.02), W * 0.7, 0.1, 0.05, BLACK)


def wheel(t, c):
    """A tyre with rounded shoulders and a rim; vertex colours carry rubber vs metal."""
    R, tw, style = c['R'], c.get('tw', 0.24), c['wheel']
    bm = bmesh.new()
    # tyre: a lathe of a rounded profile around the axle (Blender Y)
    prof = []
    for i in range(9):
        a = -math.pi / 2 + math.pi * i / 8
        prof.append((R * 0.66 + (R * 0.34) * (0.55 + 0.45 * math.cos(a)) if False else 0, 0))
    rings, segs = [], 24
    shape = [(R * 0.7, -tw / 2), (R * 0.93, -tw / 2), (R, -tw * 0.32), (R, tw * 0.32), (R * 0.93, tw / 2), (R * 0.7, tw / 2)]
    for r, y in shape:
        rings.append([bm.verts.new((r * math.cos(2 * math.pi * k / segs), y, r * math.sin(2 * math.pi * k / segs))) for k in range(segs)])
    for a, b in zip(rings, rings[1:]):
        for k in range(segs):
            q = (k + 1) % segs
            bm.faces.new((a[k], a[q], b[q], b[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    paint(bm, bm.faces, (0.012, 0.012, 0.013))
    rim_col = {'chrome': (0.85, 0.86, 0.88), 'black': (0.035, 0.035, 0.04), 'sport': (0.06, 0.065, 0.075)}[style]
    spoke_col = {'chrome': (0.85, 0.86, 0.88), 'black': (0.22, 0.23, 0.25), 'sport': (0.75, 0.77, 0.8)}[style]
    before = set(bm.faces)
    cyl(bm, 0, 0, 0, R * 0.72, tw * 0.9, 'y', 22)
    paint(bm, set(bm.faces) - before, rim_col)
    for side in (-1, 1):
        if style == 'chrome':
            for k in range(10):
                a = 2 * math.pi * k / 10
                b0 = set(bm.faces)
                cyl(bm, math.cos(a) * R * 0.5, side * (tw * 0.45 + 0.004), math.sin(a) * R * 0.5, R * 0.075, 0.012, 'y', 6)
                paint(bm, set(bm.faces) - b0, (0.03, 0.03, 0.033))
        else:
            for k in range(10):
                a = 2 * math.pi * k / 10 + (k % 2) * 0.12
                b0 = set(bm.faces)
                vs = box(bm, -R * 0.31, -R * 0.055, -0.008, R * 0.31, R * 0.055, 0.008)
                bmesh.ops.transform(bm, matrix=Matrix.Translation((math.cos(a) * R * 0.37, side * (tw * 0.45 + 0.008), math.sin(a) * R * 0.37)) @ Matrix.Rotation(-a, 4, 'Y'), verts=vs)
                paint(bm, set(bm.faces) - b0, spoke_col)
        b0 = set(bm.faces)
        cyl(bm, 0, side * (tw * 0.45 + 0.012), 0, R * 0.14, 0.02, 'y', 8)
        paint(bm, set(bm.faces) - b0, (0.5, 0.52, 0.55))
    ob = new_obj(f'{t}_Wheel', bm)
    finish(ob, 35)
    return ob


# ---------- preview and export ----------

def preview(t, parts, path):
    cols = {'Body': (0.05, 0.05, 0.06, 1), 'Lower': (0.6, 0.62, 0.66, 1), 'Glass': (0.05, 0.08, 0.12, 1), 'Chrome': (0.9, 0.9, 0.92, 1),
            'Head': (1, 0.97, 0.9, 1), 'Tail': (0.8, 0.05, 0.04, 1)}
    paint_col = {'ursa': (0.03, 0.03, 0.035, 1), 'gwagen': (0.85, 0.85, 0.83, 1), 'monarch': (0.03, 0.03, 0.035, 1), 'phantasma': (0.12, 0.13, 0.15, 1),
                 'cavallo': (0.36, 0.38, 0.42, 1), 'papaya': (0.18, 0.06, 0.4, 1), 'bolide': (0.45, 0.02, 0.04, 1)}[t]
    for ob in parts:
        role = ob.name.split('_', 1)[1]
        m = bpy.data.materials.new(role)
        m.use_nodes = True
        bsdf = m.node_tree.nodes['Principled BSDF']
        if role in ('Trim', 'Wheel'):
            attr = m.node_tree.nodes.new('ShaderNodeVertexColor'); attr.layer_name = 'Col'
            m.node_tree.links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])
        else:
            bsdf.inputs['Base Color'].default_value = paint_col if role == 'Body' else cols.get(role, (0.5, 0.5, 0.5, 1))
        bsdf.inputs['Metallic'].default_value = 1.0 if role == 'Chrome' else 0.4 if role == 'Body' else 0.0
        bsdf.inputs['Roughness'].default_value = 0.12 if role in ('Chrome', 'Glass') else 0.3 if role == 'Body' else 0.6
        ob.data.materials.append(m)
    c = cartoon(CARS[t])
    L, W = c['len'] * S, c['wid'] * S
    wheels = []
    wb = next(p for p in parts if p.name.endswith('Wheel'))
    for x, s in ((c['wx'] * L, 1), (c['wx'] * L, -1), (-c['wx'] * L, 1), (-c['wx'] * L, -1)):
        w = wb.copy(); w.location = (x, s * (W / 2 - c.get('tw', 0.24) / 2 + 0.02), c['R'])
        bpy.context.scene.collection.objects.link(w); wheels.append(w)
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE_NEXT'
    sc.render.resolution_x, sc.render.resolution_y = 720, 450
    sc.eevee.taa_render_samples = 16
    sc.world = bpy.data.worlds.new('w'); sc.world.use_nodes = True
    sc.world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.55, 0.6, 0.68, 1)
    sc.world.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.0
    bpy.ops.mesh.primitive_plane_add(size=40); ground = bpy.context.object
    gm = bpy.data.materials.new('g'); gm.use_nodes = True; gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.25, 0.25, 0.25, 1)
    ground.data.materials.append(gm)
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); sun.data.energy = 4
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(40)); sc.collection.objects.link(sun)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.lens = 40
    for suffix, loc in (('', (L * 1.0, -L * 1.05, 1.9)), ('_back', (-L * 0.95, L * 0.9, 2.4))):
        cam.location = loc
        d = Vector((0, 0, 0.7)) - cam.location
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        sc.render.filepath = path.replace('.png', suffix + '.png')
        bpy.ops.render.render(write_still=True)
    for o in wheels + [ground, sun, cam]: bpy.data.objects.remove(o)


def export(t, parts):
    bpy.ops.object.select_all(action='DESELECT')
    for ob in parts:
        ob.data.materials.clear()
        ob.select_set(True)
    path = os.path.join(OUT, f'{t}.glb')
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_materials='NONE', export_normals=True,
              export_texcoords=False, export_yup=True, export_apply=True)
    try:
        bpy.ops.export_scene.gltf(**kw, export_vertex_color='ACTIVE')
    except TypeError:
        bpy.ops.export_scene.gltf(**kw, export_colors=True)
    return path


def main():
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    want_preview = '--preview' in args
    types = [a for a in args if not a.startswith('--')] or list(CARS)
    os.makedirs(OUT, exist_ok=True)
    for t in types:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        parts = build(t, cartoon(CARS[t]))
        tris = sum(len(p.data.polygons) for p in parts)
        if want_preview:
            pv = os.environ.get('PREVIEW_DIR', '/tmp')
            preview(t, parts, os.path.join(pv, f'car_{t}.png'))
        path = export(t, parts)
        print(f'{t}: {tris} faces -> {os.path.relpath(path, ROOT)} ({os.path.getsize(path) // 1024} KB)', flush=True)


main()
