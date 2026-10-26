"""Turn Quaternius' CC0 Low Poly Cars (FBX) into Kimchi City traffic cars: assets/cars/<type>.glb + traffic.json

Run headless:
  ~/Applications/Blender.app/Contents/MacOS/Blender -b -P tools/blender/convert_qcars.py -- SRC_DIR

Each car is turned to face +X, scaled to the game's length for its type (src/data.js) and split by material
into the parts the game paints itself (src/3d/cars.js): Body (the paint), Glass, Trim (vertex coloured greys
and blacks), Head, Tail, SirenA/SirenB (police light bar) and one Wheel at the origin. traffic.json records
where the axles are, the wheel radius and track, so the game puts the wheels where the model has them.
Source: Quaternius, Low Poly Cars (Realistic Car Pack), CC0, https://quaternius.com
"""
import bpy, bmesh, math, os, sys, json
from mathutils import Vector, Matrix

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'assets', 'cars')
S = 1 / 16
# game type: (source file, length and width in sim px from src/data.js)
CARS = {'sedan': ('NormalCar1', 66, 31), 'hatch': ('NormalCar2', 58, 30), 'taxi': ('Taxi', 66, 31),
        'police': ('Cop', 70, 32), 'sports': ('SportsCar', 68, 32)}
ROLE = {'windows': 'Glass', 'black': 'Trim', 'grey': 'Trim', 'headlights': 'Head', 'whitelights': 'SirenB', 'bluelights': 'SirenA',
        'taillights': 'Tail'}


def role_of(mat, body_color):
    n = (mat.name if mat else '').lower().split('.')[0]
    if n in ROLE: return ROLE[n]
    return 'Body'


def main():
    src = sys.argv[sys.argv.index('--') + 1]
    os.makedirs(OUT, exist_ok=True)
    meta = {}
    for t, (fname, plen, pwid) in CARS.items():
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.fbx(filepath=os.path.join(src, fname + '.fbx'))
        obs = [o for o in bpy.context.scene.objects if o.type == 'MESH']
        for o in obs:
            bpy.context.view_layer.objects.active = o
            for x in bpy.context.selected_objects: x.select_set(False)
            o.select_set(True)
            bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
            bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        body = next(o for o in obs if 'Wheel' not in o.name)
        wheels = [o for o in obs if 'Wheel' in o.name]
        # face +X (the models face -Y), then scale to the game length, wheels on the ground, centred
        rot = Matrix.Rotation(math.pi / 2, 4, 'Z')
        for o in obs: o.data.transform(rot); o.data.update()
        allv = [v.co for o in obs for v in o.data.vertices]
        mn = Vector((min(v.x for v in allv), min(v.y for v in allv), min(v.z for v in allv)))
        mx = Vector((max(v.x for v in allv), max(v.y for v in allv), max(v.z for v in allv)))
        k = (plen * S) / (mx.x - mn.x)
        M = Matrix.Scale(k, 4) @ Matrix.Translation((-(mn.x + mx.x) / 2, -(mn.y + mx.y) / 2, -mn.z))
        for o in obs: o.data.transform(M); o.data.update()

        parts = {}
        def add(role, ob, faces_mats):
            bm = parts.setdefault(role, bmesh.new())
            col = bm.loops.layers.float_color.get('Col') or bm.loops.layers.float_color.new('Col')
            src_bm = bmesh.new(); src_bm.from_mesh(ob.data)
            keep = {i for i in faces_mats}
            bmesh.ops.delete(src_bm, geom=[f for f in src_bm.faces if f.index not in keep], context='FACES')
            m2 = bpy.data.meshes.new('tmp'); src_bm.to_mesh(m2)
            mats = ob.data.materials
            vbase = len(bm.verts)
            bm.from_mesh(m2)
            bm.faces.ensure_lookup_table()
            # bake each face's material colour into the vertex colours (for Trim and Wheel)
            src_bm.faces.ensure_lookup_table()
            fstart = len(bm.faces) - len(src_bm.faces)
            for i, f in enumerate(src_bm.faces):
                m = mats[f.material_index] if f.material_index < len(mats) else None
                c = tuple(m.diffuse_color[:3]) if m else (0.5, 0.5, 0.5)
                for lp in bm.faces[fstart + i].loops: lp[col] = (*c, 1.0)
            src_bm.free()

        groups = {}
        for p in body.data.polygons:
            m = body.data.materials[p.material_index] if p.material_index < len(body.data.materials) else None
            groups.setdefault(role_of(m, None), []).append(p.index)
        for role, idx in groups.items(): add(role, body, idx)

        # one wheel at the origin, axle along Y (the game's z); its place goes to traffic.json
        fl = next(o for o in wheels if 'FrontLeft' in o.name) if any('FrontLeft' in o.name for o in wheels) else wheels[0]
        wv = [v.co for v in fl.data.vertices]
        wmn = Vector((min(v.x for v in wv), min(v.y for v in wv), min(v.z for v in wv)))
        wmx = Vector((max(v.x for v in wv), max(v.y for v in wv), max(v.z for v in wv)))
        wc = (wmn + wmx) / 2
        R = (wmx.z - wmn.z) / 2
        fl.data.transform(Matrix.Translation(-wc))
        add('Wheel', fl, [p.index for p in fl.data.polygons])
        back = [o for o in wheels if 'Back' in o.name]
        bxs = [v.co.x for o in back for v in o.data.vertices]
        wx_back = abs((min(bxs) + max(bxs)) / 2) if bxs else abs(wc.x)
        meta[t] = {'wx': round(abs(wc.x), 4), 'wxb': round(wx_back, 4), 'R': round(R, 4), 'track': round(abs(wc.y), 4),
                   'tw': round(wmx.y - wmn.y, 4), 'top': round(mx.z * k - mn.z * k, 3)}

        out_obs = []
        for role, bm in parts.items():
            me = bpy.data.meshes.new(f'{t}_{role}')
            bm.to_mesh(me); bm.free()
            ob = bpy.data.objects.new(f'{t}_{role}', me)
            bpy.context.scene.collection.objects.link(ob)
            if 'Col' in me.color_attributes:
                me.color_attributes.active_color = me.color_attributes['Col']
                me.color_attributes.render_color_index = me.color_attributes.find('Col')
            me.materials.clear()
            out_obs.append(ob)
        bpy.ops.object.select_all(action='DESELECT')
        for o in out_obs: o.select_set(True)
        path = os.path.join(OUT, f'{t}.glb')
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_materials='NONE', export_normals=True,
                                  export_texcoords=False, export_yup=True, export_apply=True, export_vertex_color='ACTIVE')
        print(f'{t} <- {fname}: {sum(len(o.data.polygons) for o in out_obs)} faces, {sorted(parts)} -> {os.path.getsize(path) // 1024} KB {meta[t]}', flush=True)
    with open(os.path.join(OUT, 'traffic.json'), 'w') as f: json.dump(meta, f, indent=1)


main()
