"""Shrink a .glb made by the Blender exporter without changing how it looks: normals become 1-byte
normalized vectors, vertex colours and skin weights 1-byte normalized values. Used by build_char3d.py.
(src/3d/glb.js reads these; it is the only reader, but the file stays valid glTF.)"""
import json, struct
import numpy as np

CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def pack(path):
    raw = open(path, 'rb').read()
    jl = struct.unpack_from('<I', raw, 12)[0]
    j = json.loads(raw[20:20 + jl])
    bl = struct.unpack_from('<I', raw, 20 + jl)[0]
    bin_ = raw[28 + jl:28 + jl + bl]

    def get(i):
        a = j['accessors'][i]; bv = j['bufferViews'][a['bufferView']]
        dt = CT[a['componentType']]; n = NC[a['type']]
        off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        stride = bv.get('byteStride', 0)
        if stride and stride != n * np.dtype(dt).itemsize:
            rows = np.frombuffer(bin_, np.uint8, a['count'] * stride, off).reshape(a['count'], stride)
            return np.frombuffer(rows[:, :n * np.dtype(dt).itemsize].tobytes(), dt).reshape(a['count'], n)
        return np.frombuffer(bin_, dt, a['count'] * n, off).reshape(a['count'], n)

    chunks, views, accs = [], [], []
    def put(arr, comp, typ, normalized=False, stride=None, target=None, minmax=False):
        data = arr.tobytes()
        if stride:
            el = arr.shape[1] * arr.dtype.itemsize
            buf = bytearray(stride * arr.shape[0])
            for k in range(el): buf[k::stride] = data[k::el]
            data = bytes(buf)
        pos = sum(len(c) for c in chunks)
        pad = (-pos) % 4
        chunks.append(b'\0' * pad + data)
        bv = {'buffer': 0, 'byteOffset': pos + pad, 'byteLength': len(data)}
        if stride: bv['byteStride'] = stride
        if target: bv['target'] = target
        views.append(bv)
        acc = {'bufferView': len(views) - 1, 'componentType': comp, 'count': arr.shape[0], 'type': typ}
        if normalized: acc['normalized'] = True
        if minmax: acc['min'] = arr.min(0).tolist(); acc['max'] = arr.max(0).tolist()
        accs.append(acc)
        return len(accs) - 1

    remap = {}
    def keep(i, target=None):
        if i in remap: return remap[i]
        a = j['accessors'][i]; arr = get(i)
        r = put(arr.reshape(a['count'], NC[a['type']]) if a['type'] != 'SCALAR' else arr.reshape(-1, 1), a['componentType'], a['type'],
                a.get('normalized', False), target=target, minmax=('min' in a))
        if a['type'] == 'SCALAR': accs[r]['type'] = 'SCALAR'
        remap[i] = r
        return r

    for m in j['meshes']:
        for p in m['primitives']:
            at = p['attributes']
            new = {}
            for k, i in at.items():
                arr = get(i).astype(np.float32) if j['accessors'][i]['componentType'] == 5126 else None
                if k == 'NORMAL':
                    new[k] = put(np.clip(np.round(arr * 127), -127, 127).astype(np.int8), 5120, 'VEC3', True, stride=4, target=34962)
                elif k == 'COLOR_0' and arr is not None:
                    a4 = arr if arr.shape[1] == 4 else np.hstack([arr, np.ones((arr.shape[0], 1), np.float32)])
                    new[k] = put(np.clip(np.round(a4 * 255), 0, 255).astype(np.uint8), 5121, 'VEC4', True, target=34962)
                elif k == 'WEIGHTS_0' and arr is not None:
                    q = np.round(arr / np.maximum(arr.sum(1, keepdims=True), 1e-6) * 255).astype(np.int32)
                    q[:, 0] += 255 - q.sum(1)
                    new[k] = put(np.clip(q, 0, 255).astype(np.uint8), 5121, 'VEC4', True, target=34962)
                else:
                    new[k] = keep(i, 34962)
            p['attributes'] = new
            if 'indices' in p: p['indices'] = keep(p['indices'], 34963)
    for s in j.get('skins', []):
        if 'inverseBindMatrices' in s: s['inverseBindMatrices'] = keep(s['inverseBindMatrices'])
    j['accessors'], j['bufferViews'] = accs, views
    body = b''.join(chunks)
    body += b'\0' * ((-len(body)) % 4)
    j['buffers'] = [{'byteLength': len(body)}]
    js = json.dumps(j, separators=(',', ':')).encode()
    js += b' ' * ((-len(js)) % 4)
    out = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(body)) + struct.pack('<II', len(js), 0x4E4F534A) + js + \
        struct.pack('<II', len(body), 0x004E4942) + body
    open(path, 'wb').write(out)
