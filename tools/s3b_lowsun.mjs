#!/usr/bin/env node
// Stage S3b report (not a pass/fail check): what the fixed cast radius (110 m on both tiers, spec §11.1)
// costs when the sun is low. The sun's shadow box is square across the light, but on the ground it
// stretches along the sun's direction to half / sin(elevation) from the focus, so at low sun it reaches
// further than the cast radius. For each bench view and time of day this counts the triangles of buildings
// and street life that sit inside the shadow box but are switched off from casting, and how far from the
// player their shadows land (projected along the light onto the ground).
//   node tools/s3b_lowsun.mjs            (S3B_LOW=1 for the phone tier)
import { src, note, section, seeded, quiet } from './s3b_env.mjs';
const D = await import('./s3b_draws.mjs');
const THREE = await import('three');

const W = await import(src('src/world.js'));
const CITY = await import(src('src/3d/city.js'));
W.generate();

const LOW_TIER = process.env.S3B_LOW === '1';
const HALF = LOW_TIER ? 42 : 64;   // sky.js's shadow box: 84 m across on the low tier, 128 m on the high one
const scene = new THREE.Scene();
const sun = D.makeSun(HALF);
scene.add(sun, sun.target);
const city = await quiet(() => seeded(7, () => CITY.buildCity(scene)));
await quiet(() => new Promise((r) => setTimeout(r, 1500)));
const camera = new THREE.PerspectiveCamera(62, 1440 / 800, 0.1, 4000);
const VIEW_OPTS = { groundY: W.groundY, occluderTop: (x, z) => CITY.occluderTop(x, z) };
const P = new THREE.Vector3(), L = new THREE.Vector3();

// the cut meshes that cast (with their cells) and the street cells
const cut = [], street = [];
scene.traverse((o) => {
  if (o.userData?.cells && !o.isInstancedMesh && o.userData.cast) cut.push(o);
  else if (o.isMesh && o.userData?.cell !== undefined) street.push(o);
});

section(`${LOW_TIER ? 'low' : 'high'} tier: shadow box ±${HALF} m; triangles inside it that cast no shadow (of all inside it)`);
let t = 100;
for (const minutes of [7.5 * 60, 13 * 60, 15.5 * 60, 16.5 * 60, 17.75 * 60, 18.3 * 60]) {
  const rows = [];
  for (const v of W.benchViews) {
    const focus = D.placeCamera(camera, v, VIEW_OPTS);
    D.placeSun(sun, minutes, focus);
    for (let i = 0; i < 3; i++) city.update(camera, (t += 1 / 60));
    const sf = sun.shadow.getFrustum();
    L.subVectors(sun.position, sun.target.position).normalize();
    const r = { view: v.name, inB: 0, lostB: 0, inS: 0, lostS: 0, land: Infinity };
    // a triangle (its centre) inside the box; if it casts nothing, where its shadow would land
    const tri = (pos, M, a, b, c, lost, kind) => {
      P.set(0, 0, 0);
      for (const j of [a, b, c]) P.x += pos[j * 3] / 3, P.y += pos[j * 3 + 1] / 3, P.z += pos[j * 3 + 2] / 3;
      P.applyMatrix4(M);
      if (!sf.containsPoint(P)) return;
      r[`in${kind}`]++;
      if (!lost) return;
      r[`lost${kind}`]++;
      const k = Math.max(P.y, 0) / L.y, gx = P.x - L.x * k, gz = P.z - L.z * k;
      r.land = Math.min(r.land, Math.hypot(gx - focus.x, gz - focus.z));
    };
    for (const m of cut) {
      const pos = m.geometry.attributes.position.array;
      for (const p of m.userData.cells) {
        const lost = !p.slot.castShadow;
        for (let i = 0; i < p.idx.length; i += 3) tri(pos, m.matrixWorld, p.idx[i], p.idx[i + 1], p.idx[i + 2], lost, 'B');
      }
    }
    for (const o of street) {
      const pos = o.geometry.attributes.position.array, idx = o.geometry.index.array;
      for (let i = 0; i < idx.length; i += 3) tri(pos, o.matrixWorld, idx[i], idx[i + 1], idx[i + 2], !o.castShadow, 'S');
    }
    rows.push(r);
  }
  const elev = Math.asin(L.y) * 180 / Math.PI;
  const h = Math.floor(minutes / 60), mm = String(Math.round(minutes % 60)).padStart(2, '0');
  note(`${h}:${mm}  sun ${elev.toFixed(0)}° up, the box reaches ${(HALF / Math.sin(elev * Math.PI / 180)).toFixed(0)} m along the ground`);
  for (const r of rows) {
    note(`  ${r.view.padEnd(10)} buildings ${r.lostB} of ${r.inB}, street ${r.lostS} of ${r.inS}` +
      (r.lostB + r.lostS ? `; nearest lost shadow lands ${r.land.toFixed(0)} m from the player` : ''));
  }
}
process.exit(0);
