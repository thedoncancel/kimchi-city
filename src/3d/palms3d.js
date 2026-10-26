import * as THREE from 'three';
import { loadGlb } from './glb.js';
import { HIGH } from './quality.js';
import { makeBuckets, shadowFocus, castFirst, setCopies, uploadFirst, INSTANCE_CAST_R } from './chunks.js';

// The Blender palms (tools/blender/build_palms.py): three crown variants, each in a detailed version for
// palms near the camera and a light one for the rest, swapped as you move. Crowns sway in the wind.
// The palms sit in 64 m buckets, so a frame only looks at the buckets within reach of the camera.
// Shadows: the detailed palms cast (they are all within HI_DIST); the light ones do not, unless opts.castR
// reaches past HI_DIST, and then only those within castR of the shadow focus. Nothing casts from beyond 60 m.

const BEND = 0.55;          // how far the trunk model curves at the top (matches the Blender script)
const HI_DIST = HIGH ? 32 : 18;
const FAR = HIGH ? 230 : 150;

// spots: [{ x, y, z, h, lean, rot, k? }]; opts.castR: how far (m) palms cast shadows (default HI_DIST);
// opts.far: how far (m) the light palms are drawn (default FAR); opts.band: with far, the light palms shrink
// away across this many metres past it (v2's flora3d grows its far palms in across the same band), and meshes
// with nothing to draw are hidden; opts.material(kind, params): makes the 'leaf' and 'bark' materials from
// MeshStandard's params instead (v2's flora3d: Lambert with the sky's fill and the lamp gate), the sway and the
// band going on top of whatever its onBeforeCompile does.
export async function makePalmField(group, spots, opts = {}) {
  const g = await loadGlb('assets/palms.glb');
  const time = { value: 0 };
  const FAR_R = (opts.far ?? FAR) + (opts.far != null && opts.band ? opts.band : 0);
  const band = opts.far != null && opts.band ? { value: new THREE.Vector2(opts.far, opts.far + opts.band) } : null;
  // the shrink across the band: each copy toward its own origin, by its distance from the camera
  const shrink = band ? `
      transformed *= 1.0 - smoothstep(uPalmBand.x, uPalmBand.y, distance((modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xz, cameraPosition.xz));` : '';
  const made = (kind, params) => (opts.material ? opts.material(kind, params) : new THREE.MeshStandardMaterial(params));
  const leaf = made('leaf', { vertexColors: true, roughness: 0.72, metalness: 0, side: THREE.DoubleSide });
  const leafBase = opts.material ? leaf.onBeforeCompile : null;
  leaf.onBeforeCompile = (sh, r) => {
    if (leafBase) leafBase.call(leaf, sh, r);
    sh.uniforms.uTime = time;
    if (band) sh.uniforms.uPalmBand = band;
    sh.vertexShader = 'uniform float uTime;\n' + (band ? 'uniform vec2 uPalmBand;\n' : '') + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 ip = instanceMatrix[3].xyz;
        float ph = ip.x * 0.37 + ip.z * 0.21;
        float r = length(transformed.xz);
        float k = r * r * 0.012 + max(0.0, -transformed.y) * 0.01;
        transformed.x += sin(uTime * 1.3 + ph) * k + sin(uTime * 3.1 + ph * 2.0 + r) * k * 0.25;
        transformed.z += cos(uTime * 1.05 + ph * 1.4) * k * 0.8;
        transformed.y += sin(uTime * 2.2 + ph + r * 1.5) * k * 0.3;${shrink}
      #endif`);
  };
  if (band || opts.material) leaf.customProgramCacheKey = () => `palm-leaf${band ? '-band' : ''}${opts.material ? '-' + leaf.type : ''}`;
  const bark = made('bark', { vertexColors: true, roughness: 0.92, metalness: 0 });
  const barkBase = opts.material ? bark.onBeforeCompile : null;
  if (band || opts.material) {
    bark.onBeforeCompile = (sh, r) => {
      if (barkBase) barkBase.call(bark, sh, r);
      if (!band) return;
      sh.uniforms.uPalmBand = band;
      sh.vertexShader = 'uniform vec2 uPalmBand;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING${shrink}
      #endif`);
    };
    bark.customProgramCacheKey = () => `palm-bark${band ? '-band' : ''}${opts.material ? '-' + bark.type : ''}`;
  }

  const variants = [0, 1, 2].map(i => ({ hi: g[`Crown${i}_hi`], lo: g[`Crown${i}_lo`] }));
  const mk = (geo, mat, n) => {
    const m = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
    m.count = 0;
    m.castShadow = true; m.receiveShadow = true;
    m.frustumCulled = false;
    group.add(m);
    return m;
  };
  const per = [0, 0, 0];
  const e = new THREE.Euler(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), base = new THREE.Vector3(), top = new THREE.Vector3();
  const items = spots.map((s, i) => {
    const v = i % 3;
    per[v]++;
    q.setFromEuler(e.set(0, s.rot, s.lean, 'YZX'));
    base.set(s.x, s.y - 0.1, s.z);
    const trunk = new THREE.Matrix4().compose(base, q, sc.set(1, s.h, 1));
    top.set(BEND, 1, 0).applyMatrix4(trunk);
    const crown = new THREE.Matrix4().compose(top, new THREE.Quaternion().setFromEuler(e.set(0, s.rot * 2.3 + i, s.lean * 0.6)), sc.set(1, 1, 1).multiplyScalar(s.k || 1.2));
    return { x: s.x, y: s.y, z: s.z, v, trunk: Float32Array.from(trunk.elements), crown: Float32Array.from(crown.elements) };
  });
  const buckets = makeBuckets(items);
  const meshes = {
    trunkHi: mk(g.Trunk_hi, bark, spots.length), trunkLo: mk(g.Trunk_lo, bark, spots.length),
    hi: variants.map((vv, i) => mk(vv.hi, leaf, per[i])), lo: variants.map((vv, i) => mk(vv.lo, leaf, per[i])),
  };
  // far palms: no shadows (they're outside the shadow area anyway) and no ambient occlusion pass
  for (const m of [meshes.trunkLo, ...meshes.lo]) { m.castShadow = false; m.userData.noAO = true; }
  // unless asked to: then the light palms within castR are written first and only those cast
  const castR = Math.min(opts.castR ?? HI_DIST, INSTANCE_CAST_R);
  const loCast = castR > HI_DIST ? castR : 0;
  if (loCast) for (const m of [meshes.trunkLo, ...meshes.lo]) castFirst(m);
  const sun = shadowFocus(group);

  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4(), sphere = new THREE.Sphere(new THREE.Vector3(), 7);
  const lists = [], rest = [], nHi = [0, 0, 0], nLo = [0, 0, 0], cLo = [0, 0, 0];
  let drawn = 0, casting = 0;
  // copy one palm's matrix (16 floats) into a mesh's instance slot
  const put = (m, i, src) => { const a = m.instanceMatrix.array, o = i * 16; for (let j = 0; j < 16; j++) a[o + j] = src[j]; };
  return {
    // every frame: only palms the camera can see (or whose shadow may fall in view) get drawn.
    // focus (optional): where the shadow box is centred; by default the sun's target, else the camera.
    update(camera, t, focus) {
      time.value = t;
      const cam = camera.position;
      frustum.setFromProjectionMatrix(pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      const f = loCast ? (focus || sun() || cam) : null, c2 = loCast * loCast;
      nHi.fill(0); nLo.fill(0);
      let th = 0, tl = 0;
      for (const list of buckets.near(cam.x, cam.z, FAR_R, lists)) for (const it of list) {
        const dx = it.x - cam.x, dz = it.z - cam.z, d2 = dx * dx + dz * dz;
        if (d2 > FAR_R * FAR_R) continue;             // lost in the haze anyway (or drawn by the far mesh)
        sphere.center.set(it.x, it.y + 5, it.z);
        if (d2 > 400 && !frustum.intersectsSphere(sphere)) continue;
        if (d2 < HI_DIST * HI_DIST) {
          put(meshes.hi[it.v], nHi[it.v]++, it.crown);
          put(meshes.trunkHi, th++, it.trunk);
        } else if (!loCast || (it.x - f.x) ** 2 + (it.z - f.z) ** 2 <= c2) {
          put(meshes.lo[it.v], nLo[it.v]++, it.crown);
          put(meshes.trunkLo, tl++, it.trunk);
        } else rest.push(it);
      }
      // the light palms that do not cast go after the ones that do
      const ctl = loCast ? tl : 0;
      for (let i = 0; i < 3; i++) cLo[i] = loCast ? nLo[i] : 0;
      for (const it of rest) {
        put(meshes.lo[it.v], nLo[it.v]++, it.crown);
        put(meshes.trunkLo, tl++, it.trunk);
      }
      rest.length = 0;
      // (only the copies drawn are sent to the GPU)
      for (let i = 0; i < 3; i++) {
        meshes.hi[i].count = nHi[i]; uploadFirst(meshes.hi[i].instanceMatrix, nHi[i]);
        if (loCast) setCopies(meshes.lo[i], nLo[i], cLo[i]);
        else { meshes.lo[i].count = nLo[i]; uploadFirst(meshes.lo[i].instanceMatrix, nLo[i]); }
      }
      meshes.trunkHi.count = th; uploadFirst(meshes.trunkHi.instanceMatrix, th);
      if (loCast) setCopies(meshes.trunkLo, tl, ctl);
      else { meshes.trunkLo.count = tl; uploadFirst(meshes.trunkLo.instanceMatrix, tl); }
      drawn = th + tl; casting = th + ctl;
      if (band) for (const m of [meshes.trunkHi, meshes.trunkLo, ...meshes.hi, ...meshes.lo]) m.visible = m.count > 0;
    },
    // palms drawn and casting shadows on the last update
    stats() { return { palms: items.length, drawn, casting, buckets: buckets.lists.filter(Boolean).length }; },
  };
}
