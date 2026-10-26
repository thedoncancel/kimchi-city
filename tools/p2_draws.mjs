#!/usr/bin/env node
// Where a v2 bench view's draws go, headless (stage P2's look at the vegetation's share), counted the way
// tools/s4a_city_test.mjs counts them (camera + shadow pass in node, without the asset-pack models):
//   node tools/p2_draws.mjs [view ...]     (default villa_terrace and glades; S3B_LOW=1 for the Low tier)
// Each line: a group of meshes (the flora's by family and level, the far mesh, everything else by material
// type), its calls and triangles in the camera and the shadow pass.
import { src, quiet } from './s3b_env.mjs';
globalThis.KC_WORLD = 'v2';
const THREE = await import('three');
const D = await import('./s3b_draws.mjs');
const W = await import(src('src/world.js'));
W.generate();
const CITY = await import(src('src/3d/city.js'));
const scene = new THREE.Scene(), sun = D.makeSun(process.env.S3B_LOW === '1' ? 42 : 64);
scene.add(sun, sun.target);
scene.fog = new THREE.FogExp2('#cfe3f0', 0.00055);
const city = await quiet(() => CITY.buildCity(scene));
await new Promise((r) => setTimeout(r, 2500));
const camera = new THREE.PerspectiveCamera(62, 1440 / 800, 0.15, 2600);
const label = (o) => {
  const k = o.material?.customProgramCacheKey?.() || '';
  if (k.startsWith('kc-flora')) return `flora ${k.slice(9)}${o.isInstancedMesh ? ' ' + (o.geometry.userData.fam || o.geometry.attributes.position.count) : ''}`;
  return (o.name || o.material?.type || 'mesh') + (o.isInstancedMesh ? ' (instanced)' : '');
};
const views = process.argv.slice(2).length ? process.argv.slice(2) : ['villa_terrace', 'glades'];
for (const name of views) {
  const v = W.benchViews.find((b) => b.name === name);
  const focus = D.placeCamera(camera, v, { groundY: W.groundY, occluderTop: CITY.occluderTop });
  D.placeSun(sun, 13 * 60, focus);
  for (let k = 0; k < 3; k++) city.update(camera, k * 0.1);
  const cam = D.cameraPass(scene, camera), sh = D.shadowPass(scene, camera, sun), by = new Map();
  for (const [pass, P] of [[0, cam], [1, sh]]) for (const d of P.draws) {
    const k = label(d.obj), e = by.get(k) || by.set(k, [0, 0, 0, 0]).get(k);
    e[pass * 2]++; e[pass * 2 + 1] += Math.floor(d.count / 3) * d.instances;
  }
  console.log(`${name}: camera ${cam.calls} calls ${(cam.tris / 1e3).toFixed(0)} k, shadow ${sh.calls} calls ${(sh.tris / 1e3).toFixed(0)} k`);
  for (const [k, e] of [...by].sort((a, b) => b[1][1] + b[1][3] - a[1][1] - a[1][3]).slice(0, 18))
    console.log(`  ${k.padEnd(34)} camera ${String(e[0]).padStart(3)} calls ${(e[1] / 1e3).toFixed(0).padStart(5)} k   shadow ${String(e[2]).padStart(3)} calls ${(e[3] / 1e3).toFixed(0).padStart(5)} k`);
}
process.exit(0);
