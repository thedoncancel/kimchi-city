"""Realistic palms for Kimchi City: assets/palms.glb.

Run headless:
  ~/Applications/Blender.app/Contents/MacOS/Blender -b -P tools/blender/build_palms.py -- [--preview]

Objects (vertex coloured, attribute 'Col'):
  palm_Trunk_hi / palm_Trunk_lo   unit-height trunk (scaled to each palm's height in the game), gently curved
                                  towards +X by BEND metres at the top, base at the origin
  palm_CrownN_hi / palm_CrownN_lo three crown variants, origin at the point where the crown meets the trunk
Cartoon (Fortnite-style) palms: wide serrated blades folded down from each stem, dark green fading to lime at
the tips, a chunky ringed trunk and big coconuts. The _lo versions have fewer, coarser fronds for distance.
"""
import bpy, bmesh, math, os, sys, random
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'assets', 'palms.glb')
BEND = 0.55


def paint(bm, faces, color):
    layer = bm.loops.layers.float_color.get('Col') or bm.loops.layers.float_color.new('Col')
    for f in faces:
        for lp in f.loops:
            lp[layer] = (*color, 1.0)


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def srgb(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


LEAF = [srgb(c) for c in ('#2f9a3e', '#36a845', '#2c8f3a', '#3cb04a')]
TIP = srgb('#9be05a')
OLD = srgb('#b8c44a')
DEAD = srgb('#c08a4a')
BARK_D, BARK_L = srgb('#9a6a3e'), srgb('#d0a06a')


def new_obj(name, bm):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    if 'Col' in me.color_attributes:
        me.color_attributes.active_color = me.color_attributes['Col']
        me.color_attributes.render_color_index = me.color_attributes.find('Col')
    for p in me.polygons:
        p.use_smooth = True
    return ob


def trunk(levels, sides):
    """Cartoon trunk: chunky, curving toward +X, made of stacked bulging rings in two browns."""
    bm = bmesh.new()
    rings = []
    per = 3   # levels per ring
    for i in range(levels + 1):
        z = i / levels
        r = 0.2 + 0.08 * (1 - z) + 0.1 * max(0, 1 - z * 12) ** 2
        ph = (i % per) / per
        r *= 1.0 + 0.09 * math.sin(math.pi * ph)
        x = BEND * z * z
        rings.append([bm.verts.new((x + r * math.cos(2 * math.pi * k / sides), r * math.sin(2 * math.pi * k / sides), z)) for k in range(sides)])
    for i, (a, b) in enumerate(zip(rings, rings[1:])):
        fs = []
        for k in range(sides):
            q = (k + 1) % sides
            fs.append(bm.faces.new((a[k], a[q], b[q], b[k])))
        band = (i // per) % 2
        paint(bm, fs, mix(BARK_D, BARK_L, 0.35 + 0.4 * band))
    top = bm.faces.new(rings[-1])
    paint(bm, [top], BARK_D)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def paint_loops(bm, face, cols):
    layer = bm.loops.layers.float_color.get('Col') or bm.loops.layers.float_color.new('Col')
    for lp, c in zip(face.loops, cols):
        lp[layer] = (*c, 1.0)


def blade(bm, rnd, az, p0, L, droop, segs, wmax, hang, dead=False):
    """One cartoon frond: a wide blade folded down from the stem, its edges cut into big saw teeth,
    dark green along the stem fading to lime at the tips."""
    pts, tans = [], []
    pos = Vector((math.cos(az) * 0.14, math.sin(az) * 0.14, 0))
    for i in range(segs + 1):
        t = i / segs
        p = p0 - droop * t ** 1.4
        d = Vector((math.cos(az) * math.cos(p), math.sin(az) * math.cos(p), math.sin(p)))
        pts.append(pos.copy()); tans.append(d)
        pos = pos + d * (L / segs)
    base = DEAD if dead else LEAF[rnd.randrange(len(LEAF))]
    tip = mix(DEAD, srgb('#e0b070'), 0.5) if dead else TIP
    for s in (-1, 1):
        for k in range(segs):
            t0, t1 = k / segs, (k + 1) / segs
            P0, P1, D0, D1 = pts[k], pts[k + 1], tans[k], tans[k + 1]
            def edge(P, D, t, frac):
                side = D.cross(Vector((0, 0, 1)))
                if side.length < 1e-4: side = Vector((1, 0, 0))
                side.normalize()
                up = side.cross(D).normalized()
                w = wmax * (math.sin(math.pi * min(1.0, 0.08 + t * 0.95)) ** 0.75) * frac
                h = hang + 0.35 * t
                return P + (side * (s * math.cos(h)) - up * math.sin(h)) * w + D * (w * 0.35)
            N = edge(P0, D0, t0, 0.45)          # the notch between two teeth
            T = edge(P1, D1, t1, 1.0)           # the tooth tip
            vs = [bm.verts.new(v) for v in (P0, P1, T, N)]
            f = bm.faces.new((vs[0], vs[1], vs[2], vs[3]) if s > 0 else (vs[3], vs[2], vs[1], vs[0]))
            c0, c1 = mix(base, tip, t0 * 0.6), mix(base, tip, t1 * 0.6)
            e0, e1 = mix(base, tip, 0.35 + t0 * 0.65), mix(base, tip, 0.35 + t1 * 0.65)
            paint_loops(bm, f, [c0, c1, e1, e0] if s > 0 else [e0, e1, c1, c0])
    # a thin stem tube
    ring = []
    for i in range(segs + 1):
        P, D = pts[i], tans[i]
        side = D.cross(Vector((0, 0, 1)))
        if side.length < 1e-4: side = Vector((1, 0, 0))
        side.normalize()
        up = side.cross(D).normalized()
        r = 0.045 * (1 - i / segs * 0.75)
        ring.append([bm.verts.new(P + (side * math.cos(a) + up * math.sin(a)) * r) for a in (math.pi / 2, math.pi * 7 / 6, math.pi * 11 / 6)])
    fs = []
    for a, b in zip(ring, ring[1:]):
        for k in range(3):
            q = (k + 1) % 3
            fs.append(bm.faces.new((a[k], a[q], b[q], b[k])))
    paint(bm, fs, mix(base, srgb('#c8d070'), 0.4))


def frond(bm, rnd, az, p0, L, droop, K, lw, lmax, hang, dead=False, rs=12):
    n = rs
    pts, tans = [], []
    pos = Vector((math.cos(az) * 0.12, math.sin(az) * 0.12, 0))
    for i in range(n + 1):
        t = i / n
        p = p0 - droop * t ** 1.5
        d = Vector((math.cos(az) * math.cos(p), math.sin(az) * math.cos(p), math.sin(p)))
        pts.append(pos.copy()); tans.append(d)
        pos = pos + d * (L / n)

    def at(t):
        f = t * n
        i = min(n - 1, int(f)); u = f - i
        return pts[i].lerp(pts[i + 1], u), tans[i].lerp(tans[i + 1], u).normalized()

    # the stem: a thin triangular tube
    rach = []
    for i in range(n + 1):
        P, D = pts[i], tans[i]
        side = D.cross(Vector((0, 0, 1))).normalized()
        up = side.cross(D).normalized()
        r = 0.035 * (1 - i / n * 0.8)
        rach.append([bm.verts.new(P + (side * math.cos(a) + up * math.sin(a)) * r) for a in (math.pi / 2, math.pi * 7 / 6, math.pi * 11 / 6)])
    fs = []
    for a, b in zip(rach, rach[1:]):
        for k in range(3):
            q = (k + 1) % 3
            fs.append(bm.faces.new((a[k], a[q], b[q], b[k])))
    paint(bm, fs, DEAD if dead else mix(srgb('#6b7a3a'), srgb('#8a8a52'), 0.4))

    base = DEAD if dead else LEAF[rnd.randrange(len(LEAF))]
    for k in range(K):
        t = 0.07 + 0.91 * k / (K - 1)
        P, D = at(t)
        side = D.cross(Vector((0, 0, 1)))
        if side.length < 1e-4: side = Vector((1, 0, 0))
        side.normalize()
        up = side.cross(D).normalized()
        ll = lmax * (math.sin(math.pi * min(1.0, t * 1.08)) ** 0.55) * (0.85 + 0.3 * rnd.random())
        hg = hang + 0.55 * t + rnd.uniform(-0.1, 0.1)
        for s in (-1, 1):
            dv = side * (s * math.cos(0.55)) + D * math.sin(0.55)
            dv = (dv * math.cos(hg) - up * math.sin(hg)).normalized()
            w = lw * (0.8 + 0.4 * rnd.random())
            b0, b1 = P + D * (w * 0.5), P - D * (w * 0.5)
            mid = P + dv * (ll * 0.5) - up * (ll * 0.07)
            tip = P + dv * ll - up * (ll * 0.24)
            m0, m1 = mid + D * (w * 0.45), mid - D * (w * 0.45)
            vs = [bm.verts.new(v) for v in (b0, b1, m1, m0, tip)]
            f1 = bm.faces.new((vs[0], vs[1], vs[2], vs[3]))
            f2 = bm.faces.new((vs[3], vs[2], vs[4]))
            c = base if dead else mix(base, OLD, max(0.0, (p0 * -1 + 0.2)) * 0.35 + rnd.uniform(0, 0.12))
            paint(bm, [f1], mix(c, (0, 0, 0), 0.12))
            paint(bm, [f2], mix(c, srgb('#9aa860'), 0.18 * t))


def crown(seed, lo):
    rnd = random.Random(seed)
    bm = bmesh.new()
    n = 10 if lo else 14
    segs = 5 if lo else 9
    for i in range(n):
        tier = i / (n - 1)
        az = i * 2.39996 + rnd.uniform(-0.15, 0.15)
        p0 = math.radians(58 - 70 * tier + rnd.uniform(-6, 6))
        L = (2.9 + 1.2 * (1 - abs(tier - 0.45) * 1.6)) * (0.9 + 0.2 * rnd.random())
        blade(bm, rnd, az, p0, L, 1.0 + 1.0 * tier, segs, 0.62, 0.5 + 0.25 * tier)
    for j in range(1 if lo else 2):
        blade(bm, rnd, rnd.uniform(0, math.tau), math.radians(-65), 2.2, 0.25, max(3, segs // 2), 0.4, 0.9, dead=True)
    before = set(bm.faces)
    res = bmesh.ops.create_cone(bm, cap_ends=True, segments=10, radius1=0.2, radius2=0.3, depth=0.6)
    bmesh.ops.translate(bm, vec=(0, 0, -0.25), verts=res['verts'])
    paint(bm, set(bm.faces) - before, srgb('#8a9a3a'))
    for k in range(3 if lo else 5):
        a = k * 1.25 + rnd.uniform(-0.2, 0.2)
        before = set(bm.faces)
        res = bmesh.ops.create_icosphere(bm, subdivisions=1 if lo else 2, radius=0.15)
        bmesh.ops.translate(bm, vec=(math.cos(a) * 0.25, math.sin(a) * 0.25, -0.33 - rnd.random() * 0.1), verts=res['verts'])
        paint(bm, set(bm.faces) - before, srgb('#8a5a2a') if k % 2 else srgb('#9aa83a'))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def preview(objs, path):
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE_NEXT'
    sc.render.resolution_x, sc.render.resolution_y = 640, 640
    sc.eevee.taa_render_samples = 16
    sc.world = bpy.data.worlds.new('w'); sc.world.use_nodes = True
    sc.world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.55, 0.65, 0.8, 1)
    m = bpy.data.materials.new('v'); m.use_nodes = True
    attr = m.node_tree.nodes.new('ShaderNodeVertexColor'); attr.layer_name = 'Col'
    bsdf = m.node_tree.nodes['Principled BSDF']
    m.node_tree.links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.6
    for o in objs:
        o.data.materials.append(m)
    # three palms side by side, 8 m tall
    show = []
    for i in range(3):
        tr = next(o for o in objs if o.name == 'palm_Trunk_hi').copy(); tr.scale = (1, 1, 8); tr.location = (i * 6 - 6, 0, 0)
        cr = next(o for o in objs if o.name == f'palm_Crown{i}_hi').copy(); cr.location = (i * 6 - 6 + BEND, 0, 8)
        for o in (tr, cr): sc.collection.objects.link(o); show.append(o)
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); sun.data.energy = 4
    sun.rotation_euler = (math.radians(50), 0, math.radians(30)); sc.collection.objects.link(sun)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
    cam.location = (0, -20, 6)
    cam.rotation_euler = (Vector((0, 0, 6)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = 35
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    for o in show + [sun, cam]: bpy.data.objects.remove(o)
    for o in objs: o.data.materials.clear()


def main():
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    bpy.ops.wm.read_factory_settings(use_empty=True)
    objs = [new_obj('palm_Trunk_hi', trunk(36, 10)), new_obj('palm_Trunk_lo', trunk(12, 6))]
    for i in range(3):
        objs.append(new_obj(f'palm_Crown{i}_hi', crown(11 + i * 7, False)))
        objs.append(new_obj(f'palm_Crown{i}_lo', crown(11 + i * 7, True)))
    if '--preview' in args:
        preview(objs, os.path.join(os.environ.get('PREVIEW_DIR', '/tmp'), 'palms.png'))
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    kw = dict(filepath=OUT, export_format='GLB', use_selection=True, export_materials='NONE', export_normals=True,
              export_texcoords=False, export_yup=True, export_apply=True)
    try:
        bpy.ops.export_scene.gltf(**kw, export_vertex_color='ACTIVE')
    except TypeError:
        bpy.ops.export_scene.gltf(**kw, export_colors=True)
    for o in objs:
        print(f'{o.name}: {len(o.data.polygons)} faces', flush=True)
    print(f'-> {os.path.relpath(OUT, ROOT)} ({os.path.getsize(OUT) // 1024} KB)', flush=True)


main()
