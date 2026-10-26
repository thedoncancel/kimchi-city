"""Pack picked models from free CC0 asset packs into one game-ready .glb.

Run headless:
  ~/Applications/Blender.app/Contents/MacOS/Blender -b -P tools/blender/pack_assets.py -- SRC_DIR OUT.glb NAME[,NAME...] [maxtex]

Each model (SRC_DIR/<NAME>.gltf) becomes one top-level node called <NAME>, standing on the ground at the
origin. Textures are shrunk to `maxtex` (leaf and grass cut-outs keep their alpha), normal maps are dropped
(the game's lighting doesn't need them at this size) and images are stored as WebP to keep downloads small.

Sources used (all CC0, free for any use):
  Quaternius - Stylized Nature MegaKit  https://quaternius.com
  Kay Lousberg - KayKit City Builder Bits  https://kaylousberg.com
"""
import bpy, os, sys
from mathutils import Vector


def main():
    args = sys.argv[sys.argv.index('--') + 1:]
    src, out, names = args[0], args[1], args[2].split(',')
    maxtex = int(args[3]) if len(args) > 3 else 1024
    bpy.ops.wm.read_factory_settings(use_empty=True)
    roots = []
    for name in names:
        before = set(bpy.context.scene.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(src, name + '.gltf'))
        new = [o for o in bpy.context.scene.objects if o not in before]
        meshes = [o for o in new if o.type == 'MESH']
        # one empty per model, its meshes under it with transforms applied, standing on the ground
        # (the imported empties go first, so the new root can take the model's plain name)
        for o in new:
            if o.type != 'MESH':
                for c in o.children: c.matrix_world = c.matrix_world.copy()
        mws = {o: o.matrix_world.copy() for o in meshes}
        for o in new:
            if o.type != 'MESH': bpy.data.objects.remove(o)
        for k, o in enumerate(meshes):
            o.matrix_world = mws[o]
            o.name = f'{name}_part{k}'
        root = bpy.data.objects.new(name, None)
        bpy.context.scene.collection.objects.link(root)
        zmin = min((o.matrix_world @ Vector(c)).z for o in meshes for c in o.bound_box)
        for o in meshes:
            mw = o.matrix_world.copy()
            o.parent = None
            o.matrix_world = mw
            bpy.context.view_layer.objects.active = o
            for x in bpy.context.selected_objects: x.select_set(False)
            o.select_set(True)
            bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
            o.data.transform(__import__('mathutils').Matrix.Translation((0, 0, -zmin)))
            o.parent = root
        roots.append(root)
        print(f'{name}: {sum(len(o.data.polygons) for o in meshes)} faces', flush=True)
    # lighter materials: no normal maps, smaller pictures
    for mat in bpy.data.materials:
        if not mat.use_nodes: continue
        nt = mat.node_tree
        for nd in list(nt.nodes):
            if nd.type == 'NORMAL_MAP':
                nt.nodes.remove(nd)
    for img in bpy.data.images:
        if img.size[0] > maxtex or img.size[1] > maxtex:
            k = maxtex / max(img.size)
            img.scale(max(1, int(img.size[0] * k)), max(1, int(img.size[1] * k)))
    for img in list(bpy.data.images):
        if img.users == 0: bpy.data.images.remove(img)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_image_format='WEBP',
                              export_materials='EXPORT', export_normals=True, export_texcoords=True, export_yup=True, export_apply=False)
    print(f'-> {out} ({os.path.getsize(out) // 1024} KB)', flush=True)


main()
