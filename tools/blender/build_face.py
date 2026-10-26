"""Line up a painted face (tools/gen_faces.py) with an AI-made character's head, for src/3d/face.js.

Run headless:
  ~/Applications/Blender.app/Contents/MacOS/Blender -b -P tools/blender/build_face.py -- kimchi_ai kimchi

Looks at the model's head straight from the front (rays cast at the mesh, colours read from its texture), finds its
eyes (the two dark blobs at eye height) and mouth (the darkest, reddest line below the nose), finds the same on the
portrait, and fits the portrait to the head: across by the eyes, up and down by eyes and mouth. Writes:
  assets/chars3d/<model>_face.jpg   the portrait and its blink side by side, cropped to the face
  assets/chars3d/<model>.json        + "face": how model coordinates map onto the picture, and where it fades out
A debug picture of what it found goes to refs/faces/<model>_check.png.
"""
import bpy, bmesh, sys, os, json, math
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CH = os.path.join(ROOT, 'assets', 'chars3d')
CELL = 1024


def load_rgba(path):
    im = bpy.data.images.load(path)
    w, h = im.size
    a = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4)[::-1]   # top row first
    return a


def blobs(mask):
    """Connected groups of True pixels: list of (count, mean row, mean col)."""
    seen = np.zeros_like(mask, dtype=bool)
    out = []
    H, W = mask.shape
    for r0, c0 in zip(*np.nonzero(mask)):
        if seen[r0, c0]: continue
        stack, pts = [(r0, c0)], []
        seen[r0, c0] = True
        while stack:
            r, c = stack.pop(); pts.append((r, c))
            for rr, cc in ((r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)):
                if 0 <= rr < H and 0 <= cc < W and mask[rr, cc] and not seen[rr, cc]:
                    seen[rr, cc] = True; stack.append((rr, cc))
        p = np.array(pts)
        out.append((len(pts), p[:, 0].mean(), p[:, 1].mean()))
    return out


def two_eyes(img, rows, cols, dark, gap, centre=None):
    """A pair of dark blobs inside the band, level with each other and gap[0]..gap[1] pixels apart, the biggest such
    pair: [(row, col) of the eye on the picture's left (the character's right eye), the other]. With centre, the pair
    must sit either side of that column, about evenly (long dark hair falling past the face also makes blobs)."""
    lum = img[..., :3] @ np.array([0.299, 0.587, 0.114])
    band = np.zeros(lum.shape, bool)
    band[rows[0]:rows[1], cols[0]:cols[1]] = True
    found = [b for b in blobs(band & (lum < dark)) if b[0] > 3]
    best = None
    for i, p in enumerate(found):
        for q in found[i + 1:]:
            l, r = (p, q) if p[2] < q[2] else (q, p)
            if not (gap[0] <= r[2] - l[2] <= gap[1]) or abs(l[1] - r[1]) > gap[0] * 0.25: continue
            if centre is not None and abs((l[2] + r[2]) / 2 - centre) > (r[2] - l[2]) * 0.25: continue
            score = min(l[0], r[0])
            if not best or score > best[0]: best = (score, l, r)
    if not best: raise SystemExit(f'eyes not found (dark < {dark})')
    _, l, r = best
    return (l[1], l[2]), (r[1], r[2])


def mouth_row(img, rows, cols):
    """The lip line: the row where the middle of the face is darkest and reddest."""
    seg = img[rows[0]:rows[1], cols[0]:cols[1], :3]
    lum = seg @ np.array([0.299, 0.587, 0.114])
    red = seg[..., 0] - (seg[..., 1] + seg[..., 2]) / 2
    score = (red - lum).mean(axis=1)
    return rows[0] + int(np.argmax(score))


def main():
    model, who = sys.argv[sys.argv.index('--') + 1:][:2]
    meta_path = os.path.join(CH, model + '.json')
    meta = json.load(open(meta_path))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.join(CH, model + '.glb'))
    bpy.context.scene.view_settings.view_transform = 'Standard'   # save pictures as they are (not Blender's film look)
    obj = max((o for o in bpy.context.scene.objects if o.type == 'MESH'), key=lambda o: len(o.data.vertices))
    tex_img = next(n.image for n in obj.active_material.node_tree.nodes if n.type == 'TEX_IMAGE')
    tw, th = tex_img.size
    tex = np.array(tex_img.pixels[:], dtype=np.float32).reshape(th, tw, 4)
    bm = bmesh.new(); bm.from_mesh(obj.data)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.faces.ensure_lookup_table()
    uvl = bm.loops.layers.uv.active
    bvh = BVHTree.FromBMesh(bm)

    # the head seen from the front: game axes (x forward, y up, z right) = Blender (x, z, -y)
    ey, top = meta['eyeY'], meta['hairTop']
    y0, y1 = ey - 0.16, min(top, ey + 0.1)
    half = 0.11
    N = 360
    view = np.zeros((N, N, 3), np.float32)
    hitmask = np.zeros((N, N), bool)
    for r in range(N):
        y = y1 - (y1 - y0) * (r + 0.5) / N
        for c in range(N):
            zg = -half + 2 * half * (c + 0.5) / N         # image left = the character's right = game +z... see below
            zg = -zg                                      # image columns run from the character's right (+z) to left
            hit = bvh.ray_cast(Vector((1.0, -zg, y)), Vector((-1, 0, 0)))
            if hit[0] is None: continue
            f = bm.faces[hit[2]]
            a, b, cc = (l.vert.co for l in f.loops)
            # barycentric weights of the hit point
            v0, v1, v2 = b - a, cc - a, hit[0] - a
            d00, d01, d11, d20, d21 = v0.dot(v0), v0.dot(v1), v1.dot(v1), v2.dot(v0), v2.dot(v1)
            den = d00 * d11 - d01 * d01 or 1e-12
            wv = (d11 * d20 - d01 * d21) / den; ww = (d00 * d21 - d01 * d20) / den; wu = 1 - wv - ww
            uv = f.loops[0][uvl].uv * wu + f.loops[1][uvl].uv * wv + f.loops[2][uvl].uv * ww
            px = min(tw - 1, max(0, int(uv.x * tw))); py = min(th - 1, max(0, int(uv.y * th)))
            view[r, c] = tex[py, px, :3]
            hitmask[r, c] = True
    to_model = lambda r, c: (y1 - (y1 - y0) * (r + 0.5) / N, half - 2 * half * (c + 0.5) / N)   # -> (y, z)
    row_of = lambda y: int((y1 - y) / (y1 - y0) * N)
    col_of = lambda z: int((half - z) / (2 * half) * N)

    # the model's eyes (dark blobs at eye height) and mouth
    px_per = N / (2 * half)
    (er_r, er_c), (el_r, el_c) = two_eyes(view, (row_of(ey + 0.03), row_of(ey - 0.03)), (col_of(0.08), col_of(-0.08)), 0.16,
                                          (0.03 * px_per, 0.085 * px_per), centre=col_of(0))
    eye_y = (to_model(er_r, er_c)[0] + to_model(el_r, el_c)[0]) / 2
    zR, zL = to_model(er_r, er_c)[1], to_model(el_r, el_c)[1]

    # the portrait: the same three points
    face = load_rgba(os.path.join(ROOT, 'refs', 'faces', who + '-face.png'))
    blink = load_rgba(os.path.join(ROOT, 'refs', 'faces', who + '-blink.png'))
    H, W = face.shape[:2]
    (pr_r, pr_c), (pl_r, pl_c) = two_eyes(face, (int(H * 0.4), int(H * 0.62)), (int(W * 0.15), int(W * 0.85)), 0.17, (W * 0.15, W * 0.45))
    p_eye = (pr_r + pl_r) / 2
    p_mouth = mouth_row(face, (int(p_eye + H * 0.15), int(p_eye + H * 0.33)), (int(W * 0.46), int(W * 0.54)))
    print(f'portrait: eyes at col {pr_c:.1f} {pl_c:.1f} row {p_eye:.1f}, mouth row {p_mouth}')
    # the model's mouth, searched within 25% of where the portrait's proportions put it (the chin's shadow, a lip
    # highlight or a lumpy AI mesh can otherwise win)
    pred = abs(zR - zL) * (p_mouth - p_eye) / (pl_c - pr_c)
    m_r = mouth_row(view, (row_of(eye_y - pred * 0.75), row_of(eye_y - pred * 1.25)), (col_of(0.02), col_of(-0.02)))
    mouth_y = to_model(m_r, N // 2)[0]
    print(f'model: eyes z {zR:+.4f} {zL:+.4f} at y {eye_y:.4f}, mouth y {mouth_y:.4f} (predicted {eye_y - pred:.4f})')

    # fit: column = a * z + b (z falls to the right of the picture), row = c * y + d
    a = (pr_c - pl_c) / (zR - zL); b = pr_c - a * zR
    c = (p_mouth - p_eye) / (mouth_y - eye_y); d = p_eye - c * eye_y
    # crop the portrait to the face (brow to chin) so the texture spends its pixels there
    span = eye_y - mouth_y
    cy = (eye_y + mouth_y) / 2
    box_t = max(0.0, c * (eye_y + span * 1.25) + d)
    box_b = min(float(H), c * (mouth_y - span * 1.35) + d)
    # the face fades out where the portrait (or its crop) ends below the chin
    ryb = min(span * 2.2, cy - (box_b - 8 - d) / c)
    box_h = box_b - box_t
    box_l = min(W - box_h, max(0.0, (pr_c + pl_c) / 2 - box_h / 2))
    crop = lambda im: im[int(box_t):int(box_t + box_h), int(box_l):int(box_l + box_h)]
    from_px = lambda col, row: ((col - box_l) / box_h, (row - box_t) / box_h)    # -> 0..1 within the cell

    # match the portrait's skin to the model's (the decal fades into the model's own skin at its edges)
    cheek = lambda img, r, c0, c1: img[r - 4:r + 4, c0:c1, :3].reshape(-1, 3).mean(axis=0)
    mr = row_of(eye_y - span * 0.45)
    m_skin = (cheek(view, mr, col_of(0.05), col_of(0.035)) + cheek(view, mr, col_of(-0.035), col_of(-0.05))) / 2
    pr = int(c * (eye_y - span * 0.45) + d)
    p_skin = (cheek(face, pr, int(a * 0.05 + b), int(a * 0.035 + b)) + cheek(face, pr, int(a * -0.035 + b), int(a * -0.05 + b))) / 2
    gain = 1 + 0.6 * (m_skin / np.maximum(p_skin, 1e-3) - 1)
    print('skin model', m_skin.round(3), 'portrait', p_skin.round(3), 'gain', gain.round(3))

    def cell(im):
        x = np.clip(crop(im)[..., :3] * gain, 0, 1)
        im2 = bpy.data.images.new('cell', x.shape[1], x.shape[0])
        im2.pixels[:] = np.dstack([x, np.ones(x.shape[:2])])[::-1].ravel()
        im2.scale(CELL, CELL)
        return np.array(im2.pixels[:], dtype=np.float32).reshape(CELL, CELL, 4)[::-1]
    atlas = np.concatenate([cell(face), cell(blink)], axis=1)
    out = bpy.data.images.new('atlas', 2 * CELL, CELL)
    out.pixels[:] = atlas[::-1].ravel()
    out.filepath_raw = os.path.join(CH, model + '_face.jpg'); out.file_format = 'JPEG'
    bpy.context.scene.render.image_settings.quality = 88
    out.save_render(out.filepath_raw)

    # model (z, y) -> cell (u, v), v measured from the top; fades: an ellipse around the face
    u_a, u_b = a / box_h, (b - box_l) / box_h
    v_c, v_d = c / box_h, (d - box_t) / box_h
    meta['face'] = {
        'img': model + '_face.jpg', 'u': [round(u_a, 5), round(u_b, 5)], 'v': [round(v_c, 5), round(v_d, 5)],
        'cy': round(cy, 5), 'rx': round(abs(zR - zL) * 1.2, 5), 'ry': round(span * 1.35, 5), 'ryb': round(ryb, 5),
        'eyes': [round(zR, 5), round(zL, 5), round(eye_y, 5)], 'mouth': round(mouth_y, 5),
    }
    json.dump(meta, open(meta_path, 'w'))
    print('face ->', meta['face'])

    # what it found, for a look: the model's front view and the cropped portrait with the landmarks
    dbg = np.ones((N, N * 2, 3), np.float32)
    dbg[:, :N] = view
    pc = cell(face)[..., :3]
    idx = (np.arange(N) * CELL / N).astype(int)
    dbg[:, N:] = pc[idx][:, idx]
    for (rr, ccx) in ((er_r, er_c), (el_r, el_c), (m_r, N / 2)):
        dbg[int(rr) - 1:int(rr) + 2, int(ccx) - 6:int(ccx) + 7] = (1, 0, 1)
    for (col, row) in ((pr_c, p_eye), (pl_c, p_eye), (W / 2, p_mouth)):
        u, v = from_px(col, row)
        rr, ccx = int(v * N), N + int(u * N)
        dbg[max(0, rr - 1):rr + 2, max(N, ccx - 6):ccx + 7] = (1, 0, 1)
    chk = bpy.data.images.new('chk', 2 * N, N)
    chk.pixels[:] = np.dstack([dbg, np.ones((N, 2 * N))])[::-1].ravel()
    chk.filepath_raw = os.path.join(ROOT, 'refs', 'faces', model + '_check.png'); chk.file_format = 'PNG'
    chk.save_render(chk.filepath_raw)


main()
