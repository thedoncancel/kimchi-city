#!/usr/bin/env node
// Stage S0b check (docs/map-v2-stages.json): the 3D city moved behind the src/3d/city.js facade
// (cityGrid.js on the grid, the cityV2.js stub for v2), and main3d and combat read it through occluderTop,
// nearestLamps, groundY and the place foot spots, without changing anything on the grid.
//   node tools/s0b_city_test.mjs [baselineDir]
// baselineDir (default $KC_BASELINE) is an untouched copy of the project from before the v2 rebuild. With it,
// the old src/3d/city.js and the new facade each build the whole grid city in node (a tiny DOM records every
// canvas call, so painted textures compare too) and every mesh, instance, material and texture must match,
// before and after setNight; the old and new combat raycast and clearLine, the camera occlusion test and the
// lamp light pick are compared on thousands of random cases. Without it, only the checks that need no
// baseline run. Exits 1 if any check fails.
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || process.env.KC_BASELINE || '';
const HAVE_BASE = !!BASE && existsSync(path.join(BASE, 'src/3d/city.js'));

// 'three' is the page's vendored copy; the baseline copy has no vendor/ folder, so its addons come from here.
// The browser-only modules combat.js imports are replaced by stubs.
const THREE_URL = pathToFileURL(path.join(ROOT, 'vendor/three.module.js')).href;
const VENDOR = pathToFileURL(path.join(ROOT, 'vendor')).href;
const STUBS = {
  'entities.js': 'export const hurtPed = () => {}, damageCar = () => {}, moveChar = () => {}, say = () => {};',
  'gunsfx.js': 'const f = () => {}; export const gunSfx = new Proxy({}, { get: () => f });',
};
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'three') return { url: THREE_URL, shortCircuit: true };
    const name = spec.split('/').pop();
    if (spec.startsWith('.') && STUBS[name] && ctx.parentURL?.includes('/src/3d/combat.js'))
      return { url: 'data:text/javascript,' + encodeURIComponent(STUBS[name]), shortCircuit: true };
    if (spec.startsWith('.') && ctx.parentURL && !ctx.parentURL.startsWith('data:')) {
      const url = new URL(spec, ctx.parentURL).href;
      const i = url.indexOf('/vendor/');
      if (i >= 0 && !existsSync(fileURLToPath(url))) return { url: VENDOR + url.slice(i + 7), shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

// ---------- a tiny DOM: canvases that record their 2D calls, images and fetches that never load ----------

let canvasNo = 0;
function makeCanvas() {
  const log = [];
  const canvas = { isStubCanvas: true, id: ++canvasNo, width: 300, height: 150, log, style: {} };
  const norm = (a) => (a && a.isStubCanvas ? `canvas:${sig(a)}` : a && a.isGradient ? `grad:${JSON.stringify(a.stops)}` : a && typeof a === 'object' ? '[object]' : a);
  const special = {
    canvas,
    createRadialGradient: (...a) => ({ isGradient: true, stops: [['r', ...a]], addColorStop(o, c) { this.stops.push([o, c]); } }),
    createLinearGradient: (...a) => ({ isGradient: true, stops: [['l', ...a]], addColorStop(o, c) { this.stops.push([o, c]); } }),
    measureText: (t) => { log.push(['measureText', t]); return { width: String(t).length * 10 }; },
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  };
  const state = {};
  const ctx = new Proxy(state, {
    get(t, k) {
      if (k in special) return special[k];
      if (Object.hasOwn(t, k)) return t[k];
      if (typeof k === 'symbol') return undefined;
      return (...args) => { log.push([k, ...args.map(norm)]); };
    },
    set(t, k, v) { log.push(['=', k, norm(v)]); t[k] = v; return true; },
  });
  canvas.getContext = () => ctx;
  canvas.addEventListener = () => {};
  return canvas;
}
// a canvas's identity: its size and everything drawn on it
function sig(c) { return `${c.width}x${c.height}:${fnv(JSON.stringify(c.log))}`; }
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

const store = new Map();
Object.assign(globalThis, {
  window: globalThis,
  innerWidth: 1440, innerHeight: 800, devicePixelRatio: 1,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  location: { search: '', href: 'http://localhost/' },
  localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  document: {
    createElement: (t) => (t === 'canvas' ? makeCanvas() : { style: {}, addEventListener() {}, appendChild() {} }),
    createElementNS: () => ({ style: {}, addEventListener() {}, removeEventListener() {} }),
  },
  Image: class { constructor() { this.width = 0; this.height = 0; } set src(v) {} },
  fetch: () => Promise.reject(new Error('no network in this test')),
});

// ---------- harness ----------

let failed = 0, passed = 0;
const check = (ok, msg) => { if (ok) passed++; else { failed++; console.log('  FAIL ' + msg); } };
const realRandom = Math.random;
function seed(s) {
  Math.random = () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const quiet = async (fn) => {
  const w = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = w; }
};
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

const THREE = await import(THREE_URL);
const W = await import(src('src/world.js'));
const CITY = await import(src('src/3d/city.js'));
const CG = await import(src('src/3d/cityGrid.js'));
const CV = await import(src('src/3d/cityV2.js'));
W.generate();

// ---------- 1. the facade's constants and the v2 stub (no baseline needed) ----------

console.log('facade and stub');
check(W.KIND === 'grid', `the world facade picks the grid by default (got ${W.KIND})`);
check(CITY.S === 1 / 16, 'S is 1/16 m per sim px');
check(CITY.MAP === 344 && CITY.WORLD_M.w === 344 && CITY.WORLD_M.h === 344, `MAP and WORLD_M are 344 m (got ${CITY.MAP}, ${JSON.stringify(CITY.WORLD_M)})`);
check(CITY.surfaceY === W.groundY, 'surfaceY is world.groundY');
check(CITY.occluderTop === CG.occluderTop && CITY.nearestLamps === CG.nearestLamps && CITY.lampHeads === CG.lampHeads, 'the facade forwards cityGrid on the grid');
let threw = null;
try { CV.buildCity(new THREE.Scene()); } catch (e) { threw = e.message; }
// (since S4a cityV2 builds the v2 world; on the grid it still refuses, and the facade picks cityGrid)
check(/v2 world only/.test(threw || ''), `cityV2.buildCity refuses the grid world (got ${threw})`);
check(CV.occluderTop(100, 100) === W.groundY(1600, 1600), 'the cityV2 occluderTop stub is the ground');
const none = CV.nearestLamps(10, 10, 6, [1, 2]);
check(Array.isArray(none) && none.length === 0, 'the cityV2 nearestLamps stub finds no lamps');
for (const k of ['buildCity', 'occluderTop', 'nearestLamps', 'clearTreesForCamera', 'lampHeads', 'fountains', 'sea', 'mountains', 'yachts'])
  check(k in CV && k in CG, `both renderers export ${k}`);

// ---------- 2. start and respawn spots (spec §6.5 and §8) ----------

console.log('start and respawn spots');
for (const [key, step] of [['home', 30], ['hospital', 40], ['police', 40]]) {
  const pl = W.places[key];
  check(pl.foot.x === pl.door.x && pl.foot.y === pl.door.y + step, `${key}: foot is door + (0, ${step}) px`);
  check(pl.foot.a === Math.PI / 2 && pl.foot.a - Math.PI === -Math.PI / 2, `${key}: heading π/2 and camera yaw −π/2, exactly as before`);
}
const main3d = readFileSync(path.join(ROOT, 'src/3d/main3d.js'), 'utf8'), combat = readFileSync(path.join(ROOT, 'src/3d/combat.js'), 'utf8');
check(!/heightGrid|\bN\b\s*[,}]/.test(main3d.match(/^import[^;]*world\.js';/m)[0] + main3d.match(/^import[^;]*city\.js';/m)[0]), 'main3d imports neither N nor heightGrid');
check(!/heightGrid/.test(main3d) && !/heightGrid/.test(combat), 'main3d and combat no longer read heightGrid');
check(/standAt\(places\.home\.foot\)/.test(main3d) && /standAt\(pl\.foot\)/.test(main3d), 'startGame and respawn stand Kimchi on place.foot');
check(!/door\.y \+ (30|40)/.test(main3d), 'main3d has no door-south offsets left');
check(W.benchViews.length === 6 && W.benchViews.map(v => v.name).join() === 'home,park,motors,boutiques,marina,jet', 'the grid has its 6 bench views');

if (!HAVE_BASE) {
  console.log(`no baseline (pass a baseline dir or set KC_BASELINE) - skipped the old/new comparisons`);
  finish();
}

// ---------- 3. old and new city builds ----------

console.log('grid city build: old city.js vs the facade');
const OW = await import(pathToFileURL(path.join(BASE, 'src/world.js')).href);
const OC = await import(pathToFileURL(path.join(BASE, 'src/3d/city.js')).href);
OW.generate();

const sceneOld = new THREE.Scene(), sceneNew = new THREE.Scene();
// (the textures, palms and asset packs fail to load here, as they would offline; both builds keep the
// painted stand-ins and the simple palms, and the scatter never appears)
const [oldCity, newCity] = await quiet(async () => {
  seed(7); const a = OC.buildCity(sceneOld);
  seed(7); const b = CITY.buildCity(sceneNew);
  Math.random = realRandom;
  await new Promise((r) => setTimeout(r, 50));   // let the failed loads settle
  return [a, b];
});

const r6 = (v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v);
function texSig(t) {
  if (!t) return null;
  const img = t.image;
  return [img?.isStubCanvas ? sig(img) : img ? 'image' : null, t.wrapS, t.wrapT, t.repeat.x, t.repeat.y, t.offset.x, t.offset.y, t.colorSpace, t.anisotropy, t.flipY, t.magFilter, t.minFilter].join('|');
}
const MAT_KEYS = ['type', 'side', 'transparent', 'opacity', 'depthWrite', 'depthTest', 'blending', 'vertexColors', 'flatShading', 'fog', 'polygonOffset',
  'polygonOffsetFactor', 'polygonOffsetUnits', 'roughness', 'metalness', 'emissiveIntensity', 'alphaTest', 'toneMapped', 'wireframe'];
function matSig(m) {
  if (Array.isArray(m)) return m.map(matSig).join(' / ');
  const o = MAT_KEYS.map((k) => r6(m[k]));
  o.push(m.color?.getHexString(), m.emissive?.getHexString());
  for (const k of ['map', 'emissiveMap', 'roughnessMap', 'normalMap', 'alphaMap']) o.push(texSig(m[k]));
  o.push(m.onBeforeCompile ? fnv(m.onBeforeCompile.toString()) : null);
  return JSON.stringify(o);
}
function arrSig(a) {
  if (!a) return null;
  const v = a.array ?? a;
  let h = 0x811c9dc5;
  const f = new Float64Array(1), b = new Uint8Array(f.buffer);
  for (let i = 0; i < v.length; i++) { f[0] = v[i]; for (let j = 0; j < 8; j++) { h ^= b[j]; h = Math.imul(h, 0x01000193); } }
  return `${a.itemSize ?? ''}x${v.length}:${(h >>> 0).toString(16)}`;
}
function geoSig(g) {
  if (!g) return null;
  const attrs = Object.keys(g.attributes).sort().map((k) => `${k}=${arrSig(g.attributes[k])}`);
  return `${g.type}|${attrs.join(',')}|i=${arrSig(g.index)}|${JSON.stringify(g.groups)}|${JSON.stringify(g.drawRange)}`;
}
function describe(root) {
  const out = [];
  root.traverse((o) => {
    o.updateMatrix();
    const row = [o.type, o.name, o.visible, o.castShadow, o.receiveShadow, o.matrixAutoUpdate, o.frustumCulled, o.renderOrder,
      [...o.matrix.elements].map(r6).join(',')];
    if (o.geometry) row.push(geoSig(o.geometry));
    if (o.material) row.push(matSig(o.material));
    if (o.isInstancedMesh) row.push(o.count, arrSig(o.instanceMatrix), arrSig(o.instanceColor));
    out.push(JSON.stringify(row));
  });
  return out;
}
function compareScenes(label) {
  const a = describe(sceneOld), b = describe(sceneNew);
  check(a.length === b.length, `${label}: same number of objects (${a.length} old, ${b.length} new)`);
  let diffs = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    if (++diffs <= 3) console.log(`    object ${i} differs:\n      old ${a[i].slice(0, 400)}\n      new ${b[i].slice(0, 400)}`);
  }
  check(diffs === 0, `${label}: every object, geometry, material and texture matches (${diffs} differ)`);
  return a.length;
}
const objects = compareScenes('day');
oldCity.setNight(0.6); newCity.setNight(0.6);
compareScenes('night 0.6');
const cam = new THREE.PerspectiveCamera(); cam.position.set(120, 4, 200);
oldCity.update(cam, 12.5); newCity.update(cam, 12.5);
compareScenes('after update');
check(typeof newCity.update === 'function' && typeof newCity.setNight === 'function' && newCity.group?.isGroup && 'chunks' in newCity, 'buildCity returns { group, update, setNight, chunks }');
console.log(`    ${objects} objects compared`);

// the live bindings point at the built city
check(CITY.sea && CITY.sea === CG.sea && CITY.sea.isMesh, 'the facade sea is the built sea mesh');
check(CITY.fountains === CG.fountains && CITY.yachts === CG.yachts && CITY.mountains === CG.mountains && CITY.lampHeads === CG.lampHeads, 'the facade lists are the built ones');
const same3 = (a, b) => a.length === b.length && a.every((v, i) => v.x === b[i].x && v.y === b[i].y && v.z === b[i].z);
check(same3(OC.lampHeads, CITY.lampHeads), `lamp heads match (${CITY.lampHeads.length})`);
check(OC.fountains.length === CITY.fountains.length && OC.yachts.length === CITY.yachts.length && OC.mountains.length === CITY.mountains.length, 'fountains, yachts and hills match');
check(OC.heightGrid.length === CG.heightGrid.length && OC.heightGrid.every((v, i) => v === CG.heightGrid[i]), 'the building height grid matches');

// ---------- 4. ground, occlusion and lamps ----------

console.log('ground, occluders and lamps');
seed(11);
const R = (a, b) => a + Math.random() * (b - a);
let groundSame = 0, groundN = 0;
for (let i = 0; i < 20000; i++) {
  const x = R(-600, OW.SIZE + 600), y = R(-600, OW.SIZE + 600);
  groundN++; if (OC.surfaceY(x, y) === CITY.surfaceY(x, y)) groundSame++;
}
check(groundSame === groundN, `surfaceY is today's surfaceY everywhere (${groundSame}/${groundN})`);

// occluderTop = max(heightGrid, ground); the chase camera's test line is always 1 m or more above the ground,
// where it behaves exactly like the old heightGrid test (which skipped points outside the town)
const N = OW.N;
const oldOcc = (xm, zm, v) => { const ix = Math.floor(xm / 4), iz = Math.floor(zm / 4); return !(ix < 0 || iz < 0 || ix >= N || iz >= N) && OC.heightGrid[iz * N + ix] > v; };
let occSame = 0, occN = 0, occDef = 0;
for (let i = 0; i < 40000; i++) {
  const xm = R(-30, CITY.MAP + 30), zm = R(-30, CITY.MAP + 30);
  const ix = Math.floor(xm / 4), iz = Math.floor(zm / 4), inside = !(ix < 0 || iz < 0 || ix >= N || iz >= N);
  const g = CITY.surfaceY(xm * 16, zm * 16);
  if (CG.occluderTop(xm, zm) === Math.max(inside ? CG.heightGrid[iz * N + ix] : -Infinity, g)) occDef++;
  const v = R(0.96, 30);
  occN++; if (oldOcc(xm, zm, v) === (CITY.occluderTop(xm, zm) > v)) occSame++;
}
check(occDef === 40000, `occluderTop is max(building top, ground) (${occDef}/40000)`);
check(occSame === occN, `the chase camera pulls in exactly where it did (${occSame}/${occN} sample lines)`);

// the lamp lights go to the same lamps, in the same order, as today's sort
let lampSame = 0;
const out = [];
for (let i = 0; i < 3000; i++) {
  const fx = R(-40, CITY.MAP + 40), fz = R(-40, CITY.MAP + 40);
  const best = OC.lampHeads.map((h, j) => [(h.x - fx) ** 2 + (h.z - fz) ** 2, j]).sort((a, b) => a[0] - b[0]);
  CITY.nearestLamps(fx, fz, 6, out);
  if (out.length === 6 && out.every((h, k) => { const o = OC.lampHeads[best[k][1]]; return h.x === o.x && h.y === o.y && h.z === o.z; })) lampSame++;
}
check(lampSame === 3000, `nearestLamps picks the lamps today's sort picks (${lampSame}/3000)`);

// ---------- 5. combat: bullets and lines of sight ----------

console.log('combat raycast and clearLine: old vs new');
const OCB = await import(pathToFileURL(path.join(BASE, 'src/3d/combat.js')).href);
const NCB = await import(src('src/3d/combat.js'));
let raySame = 0, rayN = 0, highSame = 0, highN = 0, wallKept = 0, wallOld = 0, groundDiff = 0;
const o = new THREE.Vector3(), d = new THREE.Vector3();
for (let i = 0; i < 20000; i++) {
  const x = R(0, CITY.MAP), z = R(0, CITY.MAP);
  o.set(x, CITY.surfaceY(x * 16, z * 16) + R(0.3, 3), z);
  const yaw = R(0, Math.PI * 2), pitch = R(-0.6, 0.25);
  d.set(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch));
  const a = OCB.raycast(o, d, 70), b = NCB.raycast(o, d, 70);
  const same = a.kind === b.kind && Math.abs(a.t - b.t) < 1e-9;
  rayN++; if (same) raySame++;
  else if (a.kind === 'ground' || b.kind === 'ground') groundDiff++;
  // above 0.3 m the ground thresholds (0.1 m then, ground + 0.1 m now) never come into it
  const lowest = Math.min(o.y, o.y + d.y * Math.min(a.t, b.t));
  if (lowest > 0.3) { highN++; if (same) highSame++; }
  if (a.kind === 'wall' && a.point.y > 0.3) { wallOld++; if (b.kind === 'wall' && Math.abs(a.t - b.t) < 1e-9) wallKept++; }
}
check(highSame === highN, `rays that stay above 0.3 m hit the same thing at the same distance (${highSame}/${highN})`);
check(wallKept === wallOld, `every wall hit above 0.3 m is still a wall hit (${wallKept}/${wallOld})`);
check(groundDiff === rayN - raySame, `every ray that changed ends on the ground in the old or the new code (${groundDiff}/${rayN - raySame})`);
// (a ray that skims the ground is stopped 0.1 m above the local surface now, as spec §8 asks, where it was
// 0.1 m above the road before: so over a curb, a lawn or a lot it lands sooner, and over the pool later)
console.log(`    ${raySame}/${rayN} random rays identical; the other ${rayN - raySame} skim within 0.3 m of the ground`);

let sightSame = 0;
for (let i = 0; i < 20000; i++) {
  const x0 = R(-200, OW.SIZE + 200), y0 = R(-200, OW.SIZE + 200), x1 = x0 + R(-1400, 1400), y1 = y0 + R(-1400, 1400);
  if (OCB.clearLine(x0, y0, x1, y1) === NCB.clearLine(x0, y0, x1, y1)) sightSame++;
}
check(sightSame === 20000, `clearLine (now world.sightClear) answers as before (${sightSame}/20000)`);
Math.random = realRandom;

finish();

function finish() {
  console.log(failed ? `${failed} failed, ${passed} passed` : `ok (${passed} checks)`);
  process.exit(failed ? 1 : 0);
}
