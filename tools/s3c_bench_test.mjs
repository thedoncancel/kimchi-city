#!/usr/bin/env node
// Stage S3c estimate (docs/map-v2-stages.json, spec §11.1 and §11.2): what the car and people LOD saves at the
// grid's bench views, in node, the way KC3.bench counts it (camera pass + shadow pass), before the browser
// bench can confirm it.
//   node tools/s3c_bench_test.mjs [baselineDir]          (default $KC_BASELINE)
// The grid world runs for 30 s from a new game (its traffic, parked cars and 46 people), then at every bench
// view, at 13:00 as the bench holds it, the same cars and people are drawn twice:
//   old: the views as they were (baseline src/3d/cars.js; every car within the 170 m square in full, people
//        within the 120 m square, everything casting, the headlight pools drawn by day);
//   new: main3d's rules now (cars.js: the far LOD beyond 70 m, casters only inside the sun's shadow box,
//        people drawn within 110 m and casting within 40 m, no daytime pools).
// People are the real 3D pedestrians and police (assets/chars3d). With a baseline the city itself is the
// baseline's city.js for 'old' (as the browser baseline in tools/bench/baseline_grid.json was measured) and
// today's for 'new'; without one both use today's city, which shows this stage's part alone. Checks: at
// the park and downtown (boutiques) views the whole frame's calls (+9 post-processing calls, as at Medium)
// drop by at least 15%, the cars' and people's calls never rise anywhere, and their shadow triangles do not
// rise. The real numbers come from KC3.bench in the browser.
// Exits 1 if any check fails.
import { registerHooks } from 'node:module';
import { HAVE_BASE, src, base, check, section, note, done, seeded, quiet } from './s3b_env.mjs';

// entities.js imports the browser-only ui.js and audio.js: small stand-ins
const STUBS = {
  'ui.js': 'export const toast = () => {};',
  'audio.js': 'const f = () => {}; export const sfx = new Proxy({}, { get: () => f }); export const audio = {};',
};
registerHooks({
  resolve(spec, ctx, next) {
    const name = spec.split('/').pop();
    if (spec.startsWith('.') && ctx.parentURL?.includes('/src/') && !ctx.parentURL.includes('/src/3d/') && STUBS[name]) {
      return { url: 'data:text/javascript,' + encodeURIComponent(STUBS[name]), shortCircuit: true };
    }
    return next(spec, ctx);
  },
});
globalThis.Image = class { set src(v) {} };
const bytesOnly = globalThis.fetch;   // (char3d.js also reads .json files)
globalThis.fetch = async (url) => {
  const r = await bytesOnly(url);
  return r.ok ? { ...r, json: async () => JSON.parse(new TextDecoder().decode(await r.arrayBuffer())) } : r;
};

const THREE = await import('three');
const D = await import('./s3b_draws.mjs');
const W = await import(src('src/world.js'));
W.generate();
const { G } = await import(src('src/state.js'));
const ENT = await import(src('src/entities.js'));
const CARS = await import(src('src/3d/cars.js'));
const CITY = await import(src('src/3d/city.js'));
const C3 = await import(src('src/3d/char3d.js'));
const OCITY = HAVE_BASE ? await import(base('src/3d/city.js')) : null;
const OW = HAVE_BASE ? await import(base('src/world.js')) : null;
if (OW) OW.generate();
// (no baseline: a second copy of today's cars.js, drawn the old way)
const OLDCARS = await import(HAVE_BASE ? base('src/3d/cars.js') : src('src/3d/cars.js') + '?old');

const S = 1 / 16, POST = 9;
const CAST = { peds: ['ped_office', 'ped_grandma', 'ped_redjacket', 'ped_student', 'ped_courier', 'ped_casual'], cop: ['ped_cop', 'ped_cop2'], rival: ['ped_rival'] };
const HEIGHT = { ped_office: 1.76, ped_grandma: 1.55, ped_redjacket: 1.66, ped_student: 1.66, ped_courier: 1.75, ped_casual: 1.63, ped_cop: 1.79, ped_cop2: 1.68, ped_rival: 1.72 };

// ---------- the world, as a new game, 30 s in ----------

Object.assign(ENT.CFG, { walk: 88, run: 150, tired: 55, playerR: 8, pedWalk: 15, pedFlee: 95, friendWalk: 15, friendRun: 175, aiLook: 125, carAcc: 0.5, carMax: 0.85 });
await seeded(11, async () => {
  ENT.spawnWorld();
  Object.assign(G.player, { x: W.places.home.foot.x, y: W.places.home.foot.y });
  for (let i = 0; i < 30 * 60; i++) ENT.updateWorld(1 / 60);
});
const res = {};
for (const name of Object.values(CAST).flat()) res[name] = await C3.loadChar3D(name);
await quiet(() => Promise.all([CARS.loadCarModels(), OLDCARS.loadCarModels()]));
note(`${G.cars.length} cars (${G.cars.filter((c) => c.ai).length} in traffic), ${G.peds.length} people`);

// ---------- two scenes: old and new ----------

function makeScene(cityMod) {
  const scene = new THREE.Scene();
  const sun = D.makeSun(64);
  sun.shadow.camera.updateProjectionMatrix();   // (three.js does this when it makes the shadow map)
  scene.add(sun, sun.target);
  const city = cityMod ? cityMod.buildCity(scene) : null;
  return { scene, sun, city, cars: new Map(), peds: new Map() };
}
const oldS = await quiet(() => seeded(7, () => makeScene(OCITY || CITY)));
const newS = await quiet(() => seeded(7, () => makeScene(CITY)));
await quiet(() => new Promise((r) => setTimeout(r, 1500)));   // the palm and asset-pack models load

const rigFor = (ped) => {
  const list = CAST[ped.role === 'cop' ? 'cop' : ped.role === 'rival' ? 'rival' : 'peds'];
  const name = list[(G.peds.indexOf(ped) * 7) % list.length];
  return C3.makeChar3D(res[name], { height: HEIGHT[name] });
};
const groundY = (x, y) => W.groundY(x, y);
const running = (c) => (!!c.ai || !!c.managed) && !c.wreck && !(c.hp <= 0);
for (const s of [oldS, newS]) {
  for (const c of G.cars) {
    const v = (s === oldS ? OLDCARS : CARS).makeCarView(c.type, c.color);
    s.scene.add(v.group); s.cars.set(c, v);
  }
  for (const p of G.peds) {
    const r = rigFor(p);
    r.root.position.set(p.x * S, groundY(p.x, p.y), p.y * S);
    s.scene.add(r.root); s.peds.set(p, r);
  }
}
OLDCARS.setCarNight(0); CARS.setCarNight(0);

// the old rules: everything in its square round the camera, in full, casting
function placeOld(cam) {
  const near = (x, z, r) => Math.abs(x - cam.x) < r && Math.abs(z - cam.z) < r;
  for (const [c, v] of oldS.cars) {
    v.group.visible = near(c.x * S, c.y * S, 170);
    if (!v.group.visible) continue;
    OLDCARS.setCarLook(v, c, false);
    v.init = false;
    OLDCARS.syncCar(v, c, 1 / 60, groundY(c.x, c.y), null, running(c));
  }
  for (const [p, r] of oldS.peds) r.root.visible = near(p.x * S, p.y * S, 120);
}
// the new rules, as main3d's syncEntities applies them
const box = CARS.makeShadowBox(newS.sun);
function placeNew(cam) {
  box.update();
  const dist = (x, y, z) => Math.hypot(x - cam.x, y - cam.y, z - cam.z);
  for (const [c, v] of newS.cars) {
    const x = c.x * S, z = c.y * S;
    v.group.visible = Math.abs(x - cam.x) < 170 && Math.abs(z - cam.z) < 170;
    if (!v.group.visible) continue;
    const gy = groundY(c.x, c.y), d = dist(x, gy, z);
    CARS.setCarLook(v, c, false);
    for (let i = 0; i < 3; i++) CARS.setCarLOD(v, CARS.carFar(v, d), box.has(x, gy + 0.8, z, v.L / 2 + 0.5));   // (settled, as after a few frames)
    v.init = false;
    CARS.syncCar(v, c, 1 / 60, gy, null, running(c));
  }
  for (const [p, r] of newS.peds) {
    const d = dist(p.x * S, r.root.position.y, p.y * S);
    let show = false;
    for (let i = 0; i < 3; i++) show = CARS.personLOD(r, d);
    r.root.visible = show;
  }
}

// draws of a pass that belong to cars and people (everything under their groups)
function split(pass, s) {
  const mine = new Set();
  for (const v of s.cars.values()) v.group.traverse((o) => mine.add(o));
  for (const r of s.peds.values()) r.root.traverse((o) => mine.add(o));
  let calls = 0, tris = 0;
  for (const d of pass.draws) if (mine.has(d.obj)) { calls++; tris += Math.floor(d.count / 3) * d.instances; }
  return { calls, tris };
}
function measure(s, camera) {
  const main = D.cameraPass(s.scene, camera), shadow = D.shadowPass(s.scene, camera, s.sun);
  const m = split(main, s), sh = split(shadow, s);
  return { all: main.calls + shadow.calls + POST, people: m.calls + sh.calls, peopleShadowTris: sh.tris, peopleTris: m.tris + sh.tris, mainTris: main.tris, shadowTris: shadow.tris };
}

// ---------- the bench views ----------

section(`bench views at 13:00 (${HAVE_BASE ? 'old city: the baseline\'s' : 'no baseline: today\'s city for both'})`);
const camera = new THREE.PerspectiveCamera(62, 1440 / 800, 0.1, 4000);
const rows = [];
let t = 100;
for (const v of W.benchViews) {
  const focus = D.placeCamera(camera, v, { groundY: W.groundY, occluderTop: (x, z) => CITY.occluderTop(x, z) });
  for (const s of [oldS, newS]) {
    D.placeSun(s.sun, 13 * 60, focus);
    s.sun.shadow.camera.updateProjectionMatrix();
    s.sun.shadow.updateMatrices(s.sun);
    for (let i = 0; i < 3; i++) s.city?.update(camera, (t += 1 / 60));
  }
  placeOld(camera.position);
  placeNew(camera.position);
  const o = measure(oldS, camera), n = measure(newS, camera);
  const stats = { near: 0, far: 0, cast: 0, shown: 0, pedCast: 0 };
  for (const vv of newS.cars.values()) if (vv.group.visible) { if (vv.lod) stats.far++; else stats.near++; if (vv.cast) stats.cast++; }
  for (const r of newS.peds.values()) if (r.root.visible) { stats.shown++; if (r.cast) stats.pedCast++; }
  rows.push({ view: v.name, o, n, stats });
  check(`${v.name}: car and people calls do not rise`, n.people <= o.people, `${n.people} vs ${o.people}`);
  check(`${v.name}: car and people shadow triangles do not rise`, n.peopleShadowTris <= o.peopleShadowTris, `${n.peopleShadowTris} vs ${o.peopleShadowTris}`);
}
const pct = (a, b) => `${b ? Math.round((1 - a / b) * 1000) / 10 : 0}%`;
for (const r of rows) {
  note(`${r.view.padEnd(10)} calls ${r.n.all} vs ${r.o.all} (-${pct(r.n.all, r.o.all)}); cars+people ${r.n.people} vs ${r.o.people} (-${pct(r.n.people, r.o.people)}), ` +
    `their tris ${r.n.peopleTris} vs ${r.o.peopleTris}; cars ${r.stats.near} full / ${r.stats.far} far, ${r.stats.cast} casting; people ${r.stats.shown} shown, ${r.stats.pedCast} casting`);
}
for (const name of ['park', 'boutiques']) {
  const r = rows.find((x) => x.view === name);
  if (!r) { check(`a '${name}' bench view`, false); continue; }
  check(`${name}: the frame's calls drop by at least 15%${HAVE_BASE ? '' : ' (this stage alone)'}`, r.n.all <= r.o.all * 0.85, `${r.n.all} vs ${r.o.all}`);
}

done();
