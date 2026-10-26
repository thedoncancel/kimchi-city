import * as THREE from 'three';
import { GLTFLoader } from '../../vendor/addons/loaders/GLTFLoader.js';
import { HIGH } from './quality.js';
import { BUCKET, makeBuckets, shadowFocus, castFirst, setCopies, uploadFirst, INSTANCE_CAST_R } from './chunks.js';

// Ready-made models from free CC0 asset packs (tools/blender/pack_assets.py: assets/nature.glb, street.glb),
// scattered in big numbers: grass, flowers, bushes, ferns, rocks and trees. Each model is drawn as
// instances; only the copies near the camera and in view are drawn, refreshed when the camera moves.
// Leaves and grass sway in the wind.
//
// The copies sit in 64 m buckets, so a refresh only looks at the buckets within a kind's reach. Kinds that
// cast shadows write the copies within 60 m of the shadow focus first and the shadow pass draws only those
// (chunks.js castFirst), so the far ones cost nothing in the shadow map.

const loader = new GLTFLoader();
const wind = { value: 0 };

// models in a pack: name -> [{ geometry, material, matrix }] (each part relative to the model's root).
// opts.material(m): a material to use in place of the pack's m (v2's flora3d: Lambert with the sky's fill and
// the lamp gate); the sway goes on top of whatever its onBeforeCompile does. Each one is made once per material.
export async function loadAssetPack(url, opts = {}) {
  const gltf = await loader.loadAsync(url);
  const pack = new Map(), swapped = new Map();
  for (const root of gltf.scene.children) {
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const parts = [];
    root.traverse((o) => {
      if (!o.isMesh) return;
      let m = o.material;
      if (opts.material) { if (!swapped.has(m)) swapped.set(m, opts.material(m)); m = swapped.get(m); }
      if (m.alphaTest > 0 || m.transparent) sway(m, !!opts.material);
      parts.push({ geometry: o.geometry, material: m, matrix: new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld), cutout: m.alphaTest > 0 });
    });
    const box = new THREE.Box3().setFromObject(root);
    pack.set(root.name.replace(/\.?\d{3}$/, ''), { parts, radius: box.getSize(new THREE.Vector3()).length() / 2 });
  }
  return pack;
}

// leaves and grass bend with the wind: more the higher up the model they are, each copy out of step. chain:
// the material already has an onBeforeCompile of its own (a swapped one), which runs first.
function sway(m, chain = false) {
  if (m.userData.sway) return;
  m.userData.sway = true;
  m.side = THREE.DoubleSide;
  const base = chain ? m.onBeforeCompile : null;
  m.onBeforeCompile = (sh, r) => {
    if (base) base.call(m, sh, r);
    sh.uniforms.uWind = wind;
    sh.vertexShader = 'uniform float uWind;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 ip = instanceMatrix[3].xyz;
        float ph = ip.x * 0.43 + ip.z * 0.29;
        float k = min(transformed.y, 2.5) * 0.045;
        transformed.x += sin(uWind * 1.7 + ph) * k;
        transformed.z += cos(uWind * 1.3 + ph * 1.3) * k * 0.7;
      #endif`);
  };
  m.customProgramCacheKey = chain ? () => 'sway-' + m.type : () => 'sway';
}

// ---------- shared by both kinds of scatter ----------

const _q = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0), _pos = new THREE.Vector3(), _sc = new THREE.Vector3();
const _base = new THREE.Matrix4(), _mm = new THREE.Matrix4();

// one copy of a model: where it stands, how big it is, and each part's matrix (16 floats per part)
function itemOf(asset, s) {
  _base.compose(_pos.set(s.x, s.y, s.z), _q.setFromAxisAngle(_up, s.rot || 0), _sc.setScalar(s.s || 1));
  const n = asset.parts.length, mats = new Float32Array(16 * n);
  for (let p = 0; p < n; p++) mats.set(_mm.multiplyMatrices(_base, asset.parts[p].matrix).elements, p * 16);
  return { x: s.x, y: s.y, z: s.z, r: asset.radius * (s.s || 1), mats };
}

// the instanced meshes for one model, one per part
function meshesOf(group, asset, cap, shadow) {
  return asset.parts.map((p) => {
    const m = new THREE.InstancedMesh(p.geometry, p.material, cap);
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = shadow; m.receiveShadow = true;
    if (p.cutout) m.userData.noAO = true;       // cut-out leaves would leave square shadows in the AO pass
    if (shadow) castFirst(m);
    group.add(m);
    return m;
  });
}

// copy a copy's part matrices into instance slot i of each mesh
function put(meshes, i, it) {
  const mats = it.mats, o = i * 16;
  for (let p = 0; p < meshes.length; p++) {
    const a = meshes[p].instanceMatrix.array, s = p * 16;
    for (let j = 0; j < 16; j++) a[o + j] = mats[s + j];
  }
}

// has the shadow focus moved more than 1 m since the copies were last picked? (no focus: never)
const focusMoved = (last, f) => !!f && (f.x - last.x) ** 2 + (f.z - last.z) ** 2 >= 1;

// set the drawn and casting counts of a kind's meshes
function finish(k, n, nCast) {
  for (const m of k.meshes) {
    if (k.shadow) setCopies(m, n, nCast);
    else { m.count = n; uploadFirst(m.instanceMatrix, n); }
  }
  k.drawn = n; k.casting = nCast;
}

// ---------- scatter placed up front ----------

// spots: [{ name, x, y, z, rot, s }]; opts: name -> { far, shadow }
export function makeScatter(group, pack, spots, opts = {}) {
  const byName = new Map();
  for (const s of spots) {
    if (!pack.has(s.name)) continue;
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name).push(s);
  }
  const kinds = [];
  for (const [name, list] of byName) {
    const asset = pack.get(name), o = opts[name] || {};
    const far = (o.far || 120) * (HIGH ? 1 : 0.6);
    const meshes = meshesOf(group, asset, list.length, !!o.shadow);
    const items = list.map((s) => itemOf(asset, s));
    kinds.push({ name, meshes, items, far, shadow: !!o.shadow, buckets: makeBuckets(items), drawn: 0, casting: 0 });
  }
  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4(), sphere = new THREE.Sphere();
  const last = new THREE.Vector3(1e9, 0, 0), lastDir = new THREE.Vector3(), lastF = { x: 1e9, z: 0 };
  const dir = new THREE.Vector3();
  const sun = shadowFocus(group), lists = [], rest = [], anyShadow = kinds.some(k => k.shadow);
  return {
    // focus (optional): where the shadow box is centred; by default the sun's target, else the camera
    update(camera, t, focus) {
      wind.value = t;
      camera.getWorldDirection(dir);
      const f = anyShadow ? (focus || sun() || camera.position) : null;
      // only re-pick the visible copies when the camera has moved or turned a little, or the shadow focus
      // has moved (it picks which copies cast, and can move while the camera stays put)
      if (camera.position.distanceToSquared(last) < 1 && dir.dot(lastDir) > 0.995 && !focusMoved(lastF, f)) return;
      last.copy(camera.position); lastDir.copy(dir);
      if (f) { lastF.x = f.x; lastF.z = f.z; }
      frustum.setFromProjectionMatrix(pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      const cx = camera.position.x, cz = camera.position.z;
      for (const k of kinds) {
        let n = 0;
        const f2 = k.far * k.far, c2 = Math.min(INSTANCE_CAST_R, k.far) ** 2;
        for (const list of k.buckets.near(cx, cz, k.far, lists)) for (const it of list) {
          const dx = it.x - cx, dz = it.z - cz;
          if (dx * dx + dz * dz > f2) continue;
          sphere.center.set(it.x, it.y + it.r * 0.5, it.z); sphere.radius = it.r + 2;
          if (!frustum.intersectsSphere(sphere)) continue;
          if (!k.shadow || (it.x - f.x) ** 2 + (it.z - f.z) ** 2 <= c2) put(k.meshes, n++, it);
          else rest.push(it);
        }
        const nCast = k.shadow ? n : 0;
        for (const it of rest) put(k.meshes, n++, it);
        rest.length = 0;
        finish(k, n, nCast);
      }
    },
    // copies drawn and casting shadows per model on the last refresh
    stats() {
      const out = { kinds: kinds.length, items: 0, drawn: 0, casting: 0, by: {} };
      for (const k of kinds) { out.items += k.items.length; out.drawn += k.drawn; out.casting += k.casting; out.by[k.name] = [k.drawn, k.casting]; }
      return out;
    },
  };
}

// ---------- scatter streamed by cell ----------

// Scatter for a map too big to place up front (Kimchi Key v2, spec §11.1). gen(cellX, cellZ) returns the
// spots of one 64 m cell (x from cellX * 64 to (cellX + 1) * 64, same for z), in makeScatter's shape. A cell
// is asked for when it first comes within `far` of the camera (140 m, Low 70) and forgotten once it is a cell
// further out than that. opts:
//   kinds: name -> { far, shadow }, as in makeScatter (a kind's far is capped at the stream's)
//   capacity: copies each kind can draw at once, a number or name -> number (with a `default`). Cells are
//     visited nearest first, so a kind that runs over leaves out its farthest copies.
//   budgetMs: time a frame may spend making new cells (1 ms; all of them at once when none are made yet)
// Returns { update(camera, t, focus?), stats(), dispose() }.
export function makeStreamScatter(group, pack, { capacity = 2048, gen, far = HIGH ? 140 : 70, kinds = {}, budgetMs = 1 } = {}) {
  const C = BUCKET;
  const cells = new Map();     // cell number -> { cx, cz, x0, z0, d, byKind: Map(kind -> items) }
  const cellNo = (i, j) => (i + 32768) * 65536 + (j + 32768);
  const kindOf = new Map();    // name -> kind (or null when the pack has no such model)
  const all = [];
  let anyShadow = false;
  const capOf = (name) => typeof capacity === 'number' ? capacity : (capacity[name] ?? capacity.default ?? 2048);
  function kind(name) {
    if (kindOf.has(name)) return kindOf.get(name);
    const asset = pack.get(name), o = kinds[name] || {};
    let k = null;
    if (asset) {
      const kf = o.far != null ? o.far * (HIGH ? 1 : 0.6) : far, cap = capOf(name);
      k = { name, asset, far: Math.min(far, kf), shadow: !!o.shadow, cap, meshes: meshesOf(group, asset, cap, !!o.shadow), n: 0, rest: [], drawn: 0, casting: 0 };
      all.push(k);
      if (k.shadow) anyShadow = true;
    }
    kindOf.set(name, k);
    return k;
  }
  function makeCell(cx, cz) {
    const byKind = new Map();
    for (const s of gen(cx, cz) || []) {
      const k = kind(s.name);
      if (!k) continue;
      let list = byKind.get(k);
      if (!list) byKind.set(k, list = []);
      list.push(itemOf(k.asset, s));
    }
    return { cx, cz, x0: cx * C, z0: cz * C, d: 0, byKind };
  }
  const distTo = (c, x, z) => {
    const dx = x < c.x0 ? c.x0 - x : x > c.x0 + C ? x - c.x0 - C : 0, dz = z < c.z0 ? c.z0 - z : z > c.z0 + C ? z - c.z0 - C : 0;
    return Math.sqrt(dx * dx + dz * dz);
  };

  // bring the cells around the camera in and let the far ones go; true if anything changed
  const missing = [], probe = { x0: 0, z0: 0 };
  let made = 0, dropped = 0;
  function stream(x, z) {
    let changed = false, have = 0;
    for (const [key, c] of cells) {
      c.d = distTo(c, x, z);
      if (c.d > far + C) { cells.delete(key); dropped++; changed = true; } else if (c.d <= far) have++;
    }
    missing.length = 0;
    const i0 = Math.floor((x - far) / C), i1 = Math.floor((x + far) / C), j0 = Math.floor((z - far) / C), j1 = Math.floor((z + far) / C);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (cells.has(cellNo(i, j))) continue;
      probe.x0 = i * C; probe.z0 = j * C;
      const d = distTo(probe, x, z);
      if (d <= far) missing.push({ i, j, d });
    }
    if (!missing.length) return changed;
    missing.sort((a, b) => a.d - b.d);
    const t0 = performance.now();
    for (const m of missing) {
      if (have > 0 && performance.now() - t0 > budgetMs) break;
      const c = makeCell(m.i, m.j);
      c.d = m.d;
      cells.set(cellNo(m.i, m.j), c);
      made++; changed = true;
    }
    return changed;
  }

  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4(), sphere = new THREE.Sphere();
  const last = new THREE.Vector3(1e9, 0, 0), lastDir = new THREE.Vector3(), dir = new THREE.Vector3(), lastF = { x: 1e9, z: 0 };
  const sun = shadowFocus(group), order = [];
  return {
    update(camera, t, focus) {
      wind.value = t;
      const p = camera.position;
      const changed = stream(p.x, p.z);
      camera.getWorldDirection(dir);
      const f = anyShadow ? (focus || sun() || p) : null;
      if (!changed && p.distanceToSquared(last) < 1 && dir.dot(lastDir) > 0.995 && !focusMoved(lastF, f)) return;
      last.copy(p); lastDir.copy(dir);
      if (f) { lastF.x = f.x; lastF.z = f.z; }
      frustum.setFromProjectionMatrix(pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      order.length = 0;
      for (const c of cells.values()) if (c.d <= far) order.push(c);
      order.sort((a, b) => a.d - b.d);
      for (const k of all) { k.n = 0; k.rest.length = 0; }
      for (const c of order) for (const [k, items] of c.byKind) {
        if (c.d > k.far) continue;
        const f2 = k.far * k.far, c2 = Math.min(INSTANCE_CAST_R, k.far) ** 2;
        for (const it of items) {
          const dx = it.x - p.x, dz = it.z - p.z;
          if (dx * dx + dz * dz > f2) continue;
          sphere.center.set(it.x, it.y + it.r * 0.5, it.z); sphere.radius = it.r + 2;
          if (!frustum.intersectsSphere(sphere)) continue;
          if ((!k.shadow || (it.x - f.x) ** 2 + (it.z - f.z) ** 2 <= c2) && k.n < k.cap) put(k.meshes, k.n++, it);
          else k.rest.push(it);
        }
      }
      for (const k of all) {
        const nCast = k.shadow ? k.n : 0;
        for (const it of k.rest) { if (k.n >= k.cap) break; put(k.meshes, k.n++, it); }
        k.rest.length = 0;
        finish(k, k.n, nCast);
      }
    },
    stats() {
      const out = { cells: cells.size, made, dropped, items: 0, drawn: 0, casting: 0, by: {} };
      for (const c of cells.values()) for (const items of c.byKind.values()) out.items += items.length;
      for (const k of all) { out.drawn += k.drawn; out.casting += k.casting; out.by[k.name] = [k.drawn, k.casting]; }
      return out;
    },
    // take the meshes out of the scene and free their instance buffers (the models stay with the pack)
    dispose() {
      for (const k of all) for (const m of k.meshes) { group.remove(m); m.dispose(); }
      all.length = 0; kindOf.clear(); cells.clear(); anyShadow = false;
    },
  };
}
