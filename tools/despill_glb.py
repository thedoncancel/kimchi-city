#!/usr/bin/env python3
"""Remove green-screen spill from the colour texture of a .glb (in place).

AI-made characters are generated from pictures on a green screen, and some of that green ends up in their
texture (shoe soles, hair edges). Pixels that are strongly screen-green get their green turned down to the
level of their red and blue, so they come out the neutral dark or grey they should be; ordinary greens
(a green jacket) are left alone. Only base-colour textures are touched (in the roughness map green is data).

With --loose, any clearly green pixel is turned grey (for characters who wear no green at all: dark spill on
black shoes survives the strict test).

Usage: python3 tools/despill_glb.py assets/chars3d/kimchi_ai.glb [--loose]
"""
import io, json, struct, sys
import numpy as np
from PIL import Image


def despill(rgb, loose=False):
    a = rgb.astype(np.int32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    if loose:
        m = (g > 30) & (g > r * 1.25) & (g > b * 1.25)
        grey = (r + g + b) * 4 // 15        # the pixel's brightness, a little darker
        for k in range(3): a[..., k] = np.where(m, grey, a[..., k])
    else:
        m = (g > 110) & (g > r * 1.45) & (g > b * 1.45)
        a[..., 1] = np.where(m, np.maximum(r, b), g)
    return a.astype(np.uint8), int(m.sum())


def main(path, loose=False):
    raw = open(path, 'rb').read()
    jlen = struct.unpack('<I', raw[12:16])[0]
    gltf = json.loads(raw[20:20 + jlen])
    bin0 = 20 + jlen + 8
    blob = raw[bin0:bin0 + struct.unpack('<I', raw[20 + jlen:24 + jlen])[0]]
    colour = {gltf['textures'][m['pbrMetallicRoughness']['baseColorTexture']['index']]['source']
              for m in gltf.get('materials', []) if 'baseColorTexture' in m.get('pbrMetallicRoughness', {})}
    views = gltf['bufferViews']
    chunks = [blob[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']] for v in views]
    for i in colour:
        img = gltf['images'][i]
        im = Image.open(io.BytesIO(chunks[img['bufferView']])).convert('RGB')
        fixed, n = despill(np.asarray(im), loose)
        buf = io.BytesIO()
        Image.fromarray(fixed).save(buf, 'JPEG', quality=90)
        img['mimeType'] = 'image/jpeg'
        chunks[img['bufferView']] = buf.getvalue()
        print(f'image {i}: {n} green pixels fixed')
    # lay the buffer out again (each view 4-byte aligned)
    out = bytearray()
    for v, c in zip(views, chunks):
        while len(out) % 4: out.append(0)
        v['byteOffset'] = len(out); v['byteLength'] = len(c)
        out += c
    while len(out) % 4: out.append(0)
    gltf['buffers'][0]['byteLength'] = len(out)
    js = json.dumps(gltf, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    total = 12 + 8 + len(js) + 8 + len(out)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack('<II', len(out), 0x004E4942)); f.write(out)
    print(path, total // 1024, 'KB')


if __name__ == '__main__':
    main(sys.argv[1], '--loose' in sys.argv[2:])
