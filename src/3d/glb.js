import * as THREE from 'three';

// a minimal .glb reader: meshes only (positions, normals, vertex colours, indices), no materials or textures
export function parseGlb(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a glb');
  let off = 12, json = null, bin = null;
  while (off < buf.byteLength) {
    const len = dv.getUint32(off, true), kind = dv.getUint32(off + 4, true);
    if (kind === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, off + 8, len)));
    else if (kind === 0x004e4942) bin = buf.slice(off + 8, off + 8 + len);
    off += 8 + len;
  }
  const Arr = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5122: Int16Array, 5121: Uint8Array, 5120: Int8Array };
  const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const read = (i) => {
    const a = json.accessors[i], bv = json.bufferViews[a.bufferView], n = SIZE[a.type], T = Arr[a.componentType];
    const start = (bv.byteOffset || 0) + (a.byteOffset || 0), el = n * T.BYTES_PER_ELEMENT;
    let data;
    if (bv.byteStride && bv.byteStride !== el) {
      // interleaved or padded: copy each element out of its stride
      const src = new Uint8Array(bin, start, a.count * bv.byteStride), dst = new Uint8Array(a.count * el);
      for (let i = 0; i < a.count; i++) dst.set(src.subarray(i * bv.byteStride, i * bv.byteStride + el), i * el);
      data = new T(dst.buffer);
    } else data = new T(bin.slice(start, start + a.count * el));
    return new THREE.BufferAttribute(data, n, !!a.normalized);
  };
  const out = {};
  for (const node of json.nodes) {
    if (node.mesh == null) continue;
    const prim = json.meshes[node.mesh].primitives[0], g = new THREE.BufferGeometry();
    g.setAttribute('position', read(prim.attributes.POSITION));
    if (prim.attributes.NORMAL != null) g.setAttribute('normal', read(prim.attributes.NORMAL));
    if (prim.attributes.COLOR_0 != null) {
      const c = read(prim.attributes.COLOR_0);
      // the game's vertex-coloured materials expect rgb floats
      const n = c.count, rgb = new Float32Array(n * 3), k = c.normalized ? (c.array instanceof Uint16Array ? 65535 : 255) : 1;
      for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++) rgb[i * 3 + j] = c.array[i * c.itemSize + j] / k;
      g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    }
    if (prim.attributes.JOINTS_0 != null) {
      // skinned: joint indices (as the skin lists them) and weights; the joint names travel along
      const j = read(prim.attributes.JOINTS_0), w = read(prim.attributes.WEIGHTS_0);
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(Uint16Array.from(j.array), 4));
      const wf = w.array instanceof Float32Array ? w.array : Float32Array.from(w.array, v => v / (w.array instanceof Uint16Array ? 65535 : 255));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wf, 4));
      if (node.skin != null) g.userData.joints = json.skins[node.skin].joints.map(n => json.nodes[n].name);
    }
    if (prim.attributes.TEXCOORD_0 != null) g.setAttribute('uv', read(prim.attributes.TEXCOORD_0));
    // the base colour picture embedded in the file, if the material has one
    const tex = prim.material != null ? json.materials[prim.material]?.pbrMetallicRoughness?.baseColorTexture : null;
    if (tex) {
      const src = json.images[json.textures[tex.index].source], bv = json.bufferViews[src.bufferView];
      g.userData.image = { bytes: bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength), mime: src.mimeType };
    }
    if (prim.indices != null) g.setIndex(read(prim.indices));
    if (node.translation) g.translate(...node.translation);
    g.computeBoundingSphere();
    out[node.name.split('_').slice(1).join('_')] = g;
  }
  return out;
}

export async function loadGlb(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return parseGlb(await r.arrayBuffer());
}
