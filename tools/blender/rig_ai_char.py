"""Rig an AI-generated character (a textured T-pose .glb, e.g. from TRELLIS.2) for Kimchi City.

Run headless:
  ~/Applications/Blender.app/Contents/MacOS/Blender -b -P tools/blender/rig_ai_char.py -- IN.glb NAME [faces] [texsize]

Turns the model to face the game's way (+X, right arm toward -Y in Blender), scales it to height 1 with the
feet at 0, simplifies it, finds the joints from the shape of the T-pose (arm line, shoulders, crotch, knees,
neck), skins it to the game's 17-bone skeleton and writes assets/chars3d/<NAME>.glb (with its texture) and
<NAME>.json (bone positions in game axes) — the same pair src/3d/char3d.js loads for the modelled characters.
"""
import bpy, bmesh, math, os, sys, json
from mathutils import Vector, Matrix

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'assets', 'chars3d')
BONES = ['hips', 'spine', 'chest', 'neck', 'head', 'armR', 'foreR', 'handR', 'armL', 'foreL', 'handL',
         'legR', 'shinR', 'footR', 'legL', 'shinL', 'footL']
PARENT = {'spine': 'hips', 'chest': 'spine', 'neck': 'chest', 'head': 'neck', 'armR': 'chest', 'foreR': 'armR', 'handR': 'foreR',
          'armL': 'chest', 'foreL': 'armL', 'handL': 'foreL', 'legR': 'hips', 'shinR': 'legR', 'footR': 'shinR',
          'legL': 'hips', 'shinL': 'legL', 'footL': 'shinL'}


def ramp(v, a, b):
    return min(1.0, max(0.0, (v - a) / (b - a)))


def main():
    args = sys.argv[sys.argv.index('--') + 1:]
    src, name = args[0], args[1]
    faces = int(args[2]) if len(args) > 2 else 25000
    texsize = int(args[3]) if len(args) > 3 else 2048
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)
    obs = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in obs: o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    if len(obs) > 1: bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
    for o in list(bpy.context.scene.objects):
        if o != ob: bpy.data.objects.remove(o)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # glTF characters face -Y in Blender after import; ours face +X (right arm toward -Y)
    me = ob.data
    me.transform(Matrix.Rotation(math.pi / 2, 4, 'Z'))
    vs = [v.co for v in me.vertices]
    zmin = min(v.z for v in vs); zmax = max(v.z for v in vs)
    cx = sum(v.x for v in vs) / len(vs); cy = sum(v.y for v in vs) / len(vs)
    k = 1.0 / (zmax - zmin)
    me.transform(Matrix.Scale(k, 4) @ Matrix.Translation((-cx, -cy, -zmin)))
    me.update()

    # simplify, keeping the texture coordinates
    if len(me.polygons) > faces:
        mod = ob.modifiers.new('dec', 'DECIMATE'); mod.ratio = faces / len(me.polygons)
        bpy.ops.object.modifier_apply(modifier='dec')
    for p in me.polygons: p.use_smooth = True

    # ---- find the joints from the T-pose ----
    V = [v.co.copy() for v in me.vertices]
    span = max(abs(v.y) for v in V)
    arm_pts = [v for v in V if abs(v.y) > span * 0.55]
    zarm = sorted(v.z for v in arm_pts)[len(arm_pts) // 2]
    xarm = sorted(v.x for v in arm_pts)[len(arm_pts) // 2]
    # torso half-width just under the armpits: where the body ends sideways at that height
    # (low enough to be below short sleeves, which hang out sideways in a T-pose)
    band = [abs(v.y) for v in V if zarm - 0.13 < v.z < zarm - 0.10]
    band.sort()
    torso = band[int(len(band) * 0.92)] if band else 0.1
    shoulder = min(0.13, max(0.08, torso * 0.95))
    tip = span
    elbow, wrist = shoulder + (tip - shoulder) * 0.42, shoulder + (tip - shoulder) * 0.76
    # crotch: from the arm line (wide trousers hide the real gap); fits T-pose humans and cartoon proportions
    crotch = min(0.52, max(0.43, zarm * 0.665))
    legs = {}
    for s in (-1, 1):
        sl = [v.y for v in V if 0.15 < v.z < 0.3 and v.y * s > 0.005]
        legs[s] = sum(sl) / len(sl) if sl else s * 0.05
    neck_z = zarm + 0.035
    head_z = neck_z + 0.045
    knee, ankle = crotch * 0.55, 0.05
    J = {
        'hips': (0, 0, crotch + 0.035), 'spine': (0, 0, crotch + 0.13), 'chest': (0, 0, zarm - 0.085), 'neck': (0, 0, neck_z),
        'head': (0, 0, head_z),
        'armR': (xarm, -shoulder, zarm), 'foreR': (xarm, -elbow, zarm), 'handR': (xarm, -wrist, zarm),
        'armL': (xarm, shoulder, zarm), 'foreL': (xarm, elbow, zarm), 'handL': (xarm, wrist, zarm),
        'legR': (0, legs[-1], crotch), 'shinR': (0.004, legs[-1], knee), 'footR': (0, legs[-1], ankle),
        'legL': (0, legs[1], crotch), 'shinL': (0.004, legs[1], knee), 'footL': (0, legs[1], ankle),
    }
    print('joints: arm z %.3f x %.3f shoulder %.3f span %.3f crotch %.3f' % (zarm, xarm, shoulder, span, crotch), flush=True)

    # ---- weights, by region of the T-pose ----
    def chain(v, stops):
        if v <= stops[0][1]: return {stops[0][0]: 1.0}
        for (b0, p0), (b1, p1) in zip(stops, stops[1:]):
            if v <= p1:
                t = (v - p0) / (p1 - p0) if p1 > p0 else 1
                t = t * t * (3 - 2 * t)
                return {b0: 1 - t, b1: t} if b0 != b1 else {b0: 1.0}
        return {stops[-1][0]: 1.0}
    body = [('hips', crotch + 0.03), ('hips', crotch + 0.07), ('spine', crotch + 0.16), ('chest', zarm - 0.07), ('chest', zarm),
            ('neck', neck_z), ('head', head_z + 0.005)]
    def weights(co):
        side = 'R' if co.y < 0 else 'L'
        ay = abs(co.y)
        # arms: anything out past the shoulders at arm height
        # (only what sticks out past the torso; the chest's own sides stay with the chest so the shirt doesn't bulge)
        # (anything well out past the torso is arm whatever its height; the head is narrower than that)
        out = ay > torso + 0.03 and abs(co.z - zarm) < 0.12
        near = ay > torso + 0.006 and abs(co.z - zarm) < 0.085 and co.z < neck_z + 0.03
        if out or near:
            w = chain(ay, [('chest', shoulder - 0.005), ('arm' + side, shoulder + 0.025), ('arm' + side, elbow - 0.02),
                           ('fore' + side, elbow + 0.02), ('fore' + side, wrist - 0.015), ('hand' + side, wrist + 0.01)])
            return w
        if co.z < crotch + 0.02:
            w = chain(-co.z, [('hips', -(crotch + 0.02)), ('leg' + side, -(crotch - 0.05)), ('leg' + side, -(knee + 0.03)),
                              ('shin' + side, -(knee - 0.03)), ('shin' + side, -(ankle + 0.03)), ('foot' + side, -(ankle - 0.01))])
            return w
        w = chain(co.z, body)
        if co.z < crotch + 0.08 and ay > 0.01:
            a = ramp(crotch + 0.08 - co.z, 0, 0.06) * 0.6
            w = {kk: vv * (1 - a) for kk, vv in w.items()}; w['leg' + side] = w.get('leg' + side, 0) + a
        if zarm - 0.02 < co.z < neck_z - 0.005 and ay > torso - 0.03:     # the top of the shoulder rolls with the arm a little
            a = ramp(ay, torso - 0.03, torso + 0.008) * 0.45
            w = {kk: vv * (1 - a) for kk, vv in w.items()}; w['arm' + side] = w.get('arm' + side, 0) + a
        return w

    groups = {n: ob.vertex_groups.new(name=n) for n in BONES}
    for v in me.vertices:
        for b, w in weights(v.co).items():
            if w > 1e-4: groups[b].add([v.index], w, 'REPLACE')

    # ---- armature ----
    ad = bpy.data.armatures.new(name + '_rig')
    rig = bpy.data.objects.new(name + '_rig', ad)
    bpy.context.scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    eb = {}
    for n in BONES:
        b = ad.edit_bones.new(n); b.head = J[n]; b.tail = Vector(J[n]) + Vector((0, 0, 0.03)); eb[n] = b
    for n, p in PARENT.items(): eb[n].parent = eb[p]
    bpy.ops.object.mode_set(mode='OBJECT')
    ob.parent = rig
    mod = ob.modifiers.new('rig', 'ARMATURE'); mod.object = rig
    ob.name = f'{name}_Tex'

    # shrink the texture, and take out the green-screen spill (shoe soles, hair edges; see tools/despill_glb.py)
    import numpy as np
    for mat in me.materials:
        if not mat or not mat.use_nodes: continue
        for nd in mat.node_tree.nodes:
            if nd.type == 'TEX_IMAGE' and nd.image and max(nd.image.size) > texsize:
                nd.image.scale(texsize, texsize)
            if nd.type == 'TEX_IMAGE' and nd.image and nd.image.colorspace_settings.name == 'sRGB':
                px = np.array(nd.image.pixels[:], dtype=np.float32).reshape(-1, 4)
                r, g, b = px[:, 0], px[:, 1], px[:, 2]
                m = (g > 0.43) & (g > r * 1.45) & (g > b * 1.45)
                px[:, 1] = np.where(m, np.maximum(r, b), g)
                nd.image.pixels[:] = px.ravel()

    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f'{name}.glb')
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True); ob.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_materials='EXPORT',
                              export_image_format='JPEG', export_jpeg_quality=88, export_normals=True, export_texcoords=True,
                              export_yup=True, export_skins=True, export_animations=False, export_apply=False)
    meta = {'name': name, 'bones': {n: [J[n][0], J[n][2], -J[n][1]] for n in BONES}, 'eyeY': head_z + (1 - head_z) * 0.45,
            'faceX': max(v.x for v in V if v.z > head_z + 0.03), 'hairTop': 1.0, 'hairHalf': 0.075, 'neckY': neck_z, 'crownX': -0.01,
            'textured': True}
    with open(os.path.join(OUT, f'{name}.json'), 'w') as f: json.dump(meta, f)
    # list it in ai.json so the game knows this character has an AI-made version
    base = name[:-3] if name.endswith('_ai') else name
    lp = os.path.join(OUT, 'ai.json')
    have = json.load(open(lp)) if os.path.exists(lp) else []
    if base not in have: have.append(base)
    with open(lp, 'w') as f: json.dump(sorted(have), f)
    print(f'{name}: {len(me.polygons)} faces -> {os.path.relpath(path, ROOT)} ({os.path.getsize(path) // 1024} KB)', flush=True)


main()
