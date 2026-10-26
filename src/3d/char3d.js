import * as THREE from 'three';
import { loadGlb } from './glb.js';

// Real 3D characters modelled in Blender (tools/blender/build_char3d.py): assets/chars3d/<name>.glb + .json.
// They use the same 17-bone skeleton, the same axes (facing +x, right arm +z, height 1) and the same rig
// object as the photo-built characters in photochar.js, so every animation and pose (walk, run, drive,
// aim, punch, surrender, seats, guns) works on them unchanged.

const BONES = ['hips', 'spine', 'chest', 'neck', 'head', 'armR', 'foreR', 'handR', 'armL', 'foreL', 'handL',
  'legR', 'shinR', 'footR', 'legL', 'shinL', 'footL'];
const PARENT = { spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck', armR: 'chest', foreR: 'armR', handR: 'foreR',
  armL: 'chest', foreL: 'armL', handL: 'foreL', legR: 'hips', shinR: 'legR', footR: 'shinR', legL: 'hips', shinL: 'legL', footL: 'shinL' };

const MATS = {};
function mat(group) {
  if (MATS[group]) return MATS[group];
  const o = { vertexColors: true, metalness: 0 };
  const m = {
    Skin: () => new THREE.MeshPhysicalMaterial({ ...o, roughness: 0.55, sheen: 0.4, sheenRoughness: 0.6, sheenColor: new THREE.Color('#ffb59a') }),
    Cloth: () => new THREE.MeshStandardMaterial({ ...o, roughness: 0.88 }),
    Hair: () => new THREE.MeshPhysicalMaterial({ ...o, roughness: 0.42, sheen: 0.5, sheenRoughness: 0.35, sheenColor: new THREE.Color('#8a7a70') }),
    Gloss: () => new THREE.MeshPhysicalMaterial({ ...o, roughness: 0.18, clearcoat: 0.6, clearcoatRoughness: 0.15 }),
  }[group];
  return (MATS[group] = m ? m() : new THREE.MeshStandardMaterial({ ...o, roughness: 0.7 }));
}

// the AI-made version (<name>_ai, tools/blender/rig_ai_char.py) when there is one, else the modelled one
// (assets/chars3d/ai.json lists which characters have one, so nothing is fetched that isn't there)
let aiList = null;
export async function loadBestChar3D(name) {
  if (!aiList) aiList = fetch('assets/chars3d/ai.json').then(r => (r.ok ? r.json() : [])).catch(() => []);
  if ((await aiList).includes(name)) {
    try { return await loadChar3D(name + '_ai'); } catch (e) { /* fall back to the modelled one */ }
  }
  return loadChar3D(name);
}

export async function loadChar3D(name) {
  const [parts, meta] = await Promise.all([
    loadGlb(`assets/chars3d/${name}.glb`),
    fetch(`assets/chars3d/${name}.json`).then(r => { if (!r.ok) throw new Error(`${name}.json: ${r.status}`); return r.json(); }),
  ]);
  // put every part's skin indices in our bone order
  const geos = [];
  for (const [group, g] of Object.entries(parts)) {
    const names = g.userData.joints;
    if (!names || !g.attributes.skinIndex) continue;
    const map = names.map(n => BONES.indexOf(n));
    const si = g.attributes.skinIndex.array;
    for (let i = 0; i < si.length; i++) si[i] = Math.max(0, map[si[i]]);
    g.computeBoundingSphere();
    g.boundingSphere.radius *= 1.6;
    geos.push({ group, geo: g });
  }
  if (!geos.length) throw new Error(`${name}: no skinned parts`);
  // AI-made characters carry a painted texture instead of vertex colours
  for (const p of geos) {
    const img = p.geo.userData.image;
    if (!img) continue;
    const bmp = await createImageBitmap(new Blob([img.bytes], { type: img.mime }));
    const t = new THREE.Texture(bmp);
    t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.needsUpdate = true;
    p.material = new THREE.MeshStandardMaterial({ map: t, roughness: 0.72, metalness: 0 });
    delete p.geo.userData.image;
  }
  return { geos, meta };
}

function rigFrom(res, height) {
  const world = res.meta.bones;
  const bones = BONES.map(n => { const b = new THREE.Bone(); b.name = n; return b; });
  const B = Object.fromEntries(BONES.map((n, i) => [n, bones[i]]));
  for (const n of BONES) {
    const w = world[n], p = PARENT[n];
    if (p) { const pw = world[p]; B[n].position.set(w[0] - pw[0], w[1] - pw[1], w[2] - pw[2]); B[p].add(B[n]); }
    else B[n].position.set(w[0], w[1], w[2]);
  }
  for (const s of ['R', 'L']) B['arm' + s].rotation.order = 'ZYX';
  const skeleton = new THREE.Skeleton(bones);
  const scaler = new THREE.Group();
  scaler.scale.setScalar(height);
  const meshes = res.geos.map(({ group, geo, material }) => {
    const m = new THREE.SkinnedMesh(geo, material || mat(group));
    m.castShadow = true; m.receiveShadow = true;
    return m;
  });
  meshes[0].add(bones[0]);
  for (const m of meshes) scaler.add(m);
  for (const m of meshes) m.bind(skeleton);
  const root = new THREE.Group();
  root.add(scaler);
  return { root, mesh: meshes[0], meshes, bones: B, world, height, data: null, meta: res.meta, res,
    phase: Math.random() * 6, heading: 0, fall: 0, hipsY: world.hips[1], pose: {}, is3d: true };
}

export function makeChar3D(res, { height = 1.7 } = {}) { return rigFrom(res, height); }
export function cloneChar3D(rig) { return rigFrom(rig.res, rig.height); }

// The shop gear (cap, shades, chain, watches) placed from the character's own measurements.
export function addChar3DGear(rig) {
  const { bones, world, meta } = rig;
  const at = (bone, x, y, z) => { const w = world[bone]; return [x - w[0], y - w[1], z - w[2]]; };
  const put = (bone, mesh, x, y, z) => { mesh.position.set(...at(bone, x, y, z)); bones[bone].add(mesh); mesh.traverse(o => { o.castShadow = true; }); return mesh; };
  const red = new THREE.MeshStandardMaterial({ color: '#d6402b', roughness: 0.7 }), redDark = new THREE.MeshStandardMaterial({ color: '#b3311f', roughness: 0.7 });
  const black = new THREE.MeshStandardMaterial({ color: '#0d0d10', metalness: 0.6, roughness: 0.15 });
  const gold = new THREE.MeshStandardMaterial({ color: '#f2c230', metalness: 1, roughness: 0.25 });
  const hh = meta.hairHalf, eyeY = meta.eyeY, faceX = meta.faceX;

  const cap = new THREE.Group();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(hh * 1.08, 24, 10, 0, Math.PI * 2, 0, 1.35), red);
  dome.scale.set(1.1, 0.78, 1.02);
  const brim = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.007, hh * 1.6), redDark);
  brim.position.set(hh * 1.05, -0.02, 0); brim.rotation.z = -0.2;
  cap.add(dome, brim);
  put('head', cap, meta.crownX, meta.hairTop - 0.05, 0);

  const shades = new THREE.Group();
  for (const s of [-1, 1]) {
    const lens = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.024, 0.04), black);
    lens.position.set(0, 0, s * 0.029); lens.rotation.y = -s * 0.25;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.004, 0.004), black);
    arm.position.set(-0.042, 0.004, s * 0.064);
    shades.add(lens, arm);
  }
  put('head', shades, faceX + 0.006, eyeY, 0);

  const chain = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.0045, 6, 28), gold);
  ring.rotation.x = Math.PI / 2; ring.rotation.y = -0.7;
  const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.004, 14), gold);
  coin.rotation.z = Math.PI / 2; coin.position.set(0.05, -0.045, 0);
  chain.add(ring, coin);
  put('chest', chain, 0.012, meta.neckY - 0.012, 0);

  const watches = {};
  const steel = new THREE.MeshStandardMaterial({ color: '#d9dce1', metalness: 1, roughness: 0.2 });
  const carbon = new THREE.MeshStandardMaterial({ color: '#1a1a1c', metalness: 0.4, roughness: 0.35 });
  const dialB = new THREE.MeshStandardMaterial({ color: '#1d3a6b', metalness: 0.3, roughness: 0.25 });
  const dialK = new THREE.MeshStandardMaterial({ color: '#0b0b0d', metalness: 0.3, roughness: 0.25 });
  const wr = world.handL;
  const watch = (band, cs, dial, square = false) => {
    const w = new THREE.Group();
    const b = new THREE.Mesh(new THREE.TorusGeometry(0.0175, 0.0042, 6, 24), band);
    const c = square ? new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.007, 0.026), cs) : new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.007, 20), cs);
    c.position.y = 0.02;
    const d = square ? new THREE.Mesh(new THREE.BoxGeometry(0.017, 0.002, 0.02), dial) : new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.002, 20), dial);
    d.position.y = 0.0242;
    w.add(b, c, d);
    w.visible = false;
    put('handL', w, wr[0], wr[1], wr[2] + 0.012);
    return w;
  };
  watches.steel = watch(steel, steel, dialK);
  watches.gold = watch(gold, gold, dialB);
  watches.skeleton = watch(carbon, carbon, steel, true);
  watches.rainbow = watch(steel, steel, dialK);
  for (const g of [cap, shades, chain]) g.visible = false;
  rig.setGear = (eq) => {
    cap.visible = !!eq.cap; shades.visible = !!eq.shades; chain.visible = !!eq.chain;
    for (const k in watches) watches[k].visible = eq.watchLook === k;
  };
  return rig;
}
