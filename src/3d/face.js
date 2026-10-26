import * as THREE from 'three';

// A painted face over the front of an AI-made character's head (those models come out with soft, smeared faces).
// tools/gen_faces.py paints the portrait and a blink; tools/blender/build_face.py lines them up with the model
// and records the fit in the character's json ("face"). Here the front of the head is copied into a thin shell
// riding on the head bone, mapped onto the portrait and faded out at the edges into the model's own skin.
// Every few seconds the character blinks (the shell shows the closed-eyes half of the picture for a moment).

const HEAD = 4;   // the head's place in the 17-bone list (char3d.js)

function buildShell(res, f) {
  const p = res.geos.find(g => g.material?.map) || res.geos[0];
  const g = p.geo, pos = g.attributes.position, nor = g.attributes.normal;
  const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  const zc = (f.eyes[0] + f.eyes[1]) / 2;
  // inside the face's oval: wider below the eyes' line than above (the chin goes further than the brows)
  const oval = (y, z) => ((z - zc) / f.rx) ** 2 + ((y - f.cy) / (y < f.cy ? f.ryb || f.ry : f.ry)) ** 2;
  const keep = new Int32Array(pos.count).fill(-1);
  const P = [], UV = [], C = [];
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const vert = (i) => {
    if (keep[i] >= 0) return keep[i];
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const a = (1 - smooth(0.55, 1, oval(y, z))) * smooth(-0.15, 0.3, nx);
    const k = 0.0015;   // just off the skin
    P.push(x + nx * k, y + ny * k, z + nz * k);
    UV.push((f.u[0] * z + f.u[1]) * 0.5, 1 - (f.v[0] * y + f.v[1]));
    C.push(1, 1, 1, a);
    return (keep[i] = P.length / 3 - 1);
  };
  const headW = (i) => { let w = 0; for (let c = 0; c < 4; c++) if (si.getComponent(i, c) === HEAD) w += sw.getComponent(i, c); return w; };
  // whole triangles by their middle (no holes): on the head, in the oval, not facing backwards
  const idx = g.index ? g.index.array : null, n = idx ? idx.length : pos.count;
  const I = [];
  for (let t = 0; t < n; t += 3) {
    const a = idx ? idx[t] : t, b = idx ? idx[t + 1] : t + 1, c = idx ? idx[t + 2] : t + 2;
    const y = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3, z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    const nx = nor.getX(a) + nor.getX(b) + nor.getX(c);
    if (oval(y, z) < 1.05 && nx > 0 && headW(a) + headW(b) + headW(c) > 1.8) I.push(vert(a), vert(b), vert(c));
  }
  const shell = new THREE.BufferGeometry();
  shell.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  shell.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  shell.setAttribute('color', new THREE.Float32BufferAttribute(C, 4));
  shell.setIndex(I);
  // lit as a smooth rounded face (the trick stylised games use for faces): the portrait carries its own nose and
  // cheek shading, and the AI mesh's lumpy surface would otherwise throw patches of light across it
  const cx = f.front - 0.1, nrm = new Float32Array(P.length);
  for (let i = 0; i < P.length; i += 3) {
    const x = (P[i] - cx) / 0.01, y = (P[i + 1] - f.cy) / 0.0144, z = (P[i + 2] - zc) / 0.0072;
    const l = Math.hypot(x, y, z) || 1;
    nrm[i] = x / l; nrm[i + 1] = y / l; nrm[i + 2] = z / l;
  }
  shell.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return shell;
}

// adds the face to a rig made by char3d.js (and every copy of it); resolves once the picture has loaded
export async function addFace(rig) {
  const res = rig.res, f = rig.meta?.face;
  if (!res || !f) return;
  if (!res.face) {
    res.face = new THREE.TextureLoader().loadAsync(`assets/chars3d/${f.img}`).then((tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      return { tex, shell: buildShell(res, { ...f, front: rig.meta.faceX }) };
    });
  }
  const { tex, shell } = await res.face;
  const map = tex.clone();   // its own copy, so each character blinks on its own (same picture on the GPU)
  const mat = new THREE.MeshStandardMaterial({
    map, vertexColors: true, transparent: true, roughness: 0.62, metalness: 0,   // writes depth: AI meshes fold over

    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
  });
  const mesh = new THREE.Mesh(shell, mat);
  const h = rig.world.head;
  mesh.position.set(-h[0], -h[1], -h[2]);   // the shell is in model space; the head bone sits at the head joint
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;
  rig.bones.head.add(mesh);
  rig.face = { map, next: 1 + Math.random() * 3, shut: 0 };
}

// blinks: every 2-6 s, about a tenth of a second, sometimes twice
export function tickFace(rig, dt) {
  const f = rig.face;
  if (!f) return;
  if (f.shut > 0) { f.shut -= dt; if (f.shut <= 0) f.map.offset.x = 0; return; }
  if ((f.next -= dt) <= 0) {
    f.shut = 0.11; f.map.offset.x = 0.5;
    f.next = Math.random() < 0.2 ? 0.25 : 2 + Math.random() * 4;
  }
}
