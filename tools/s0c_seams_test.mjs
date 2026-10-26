#!/usr/bin/env node
// Stage S0c check (docs/map-v2-stages.json): missions, police and entities read the places contract
// (docs/map-v2-spec.md §6.5) and the map BOUNDS instead of fixed offsets from the door, and on the grid
// they still behave exactly as before.
//   node tools/s0c_seams_test.mjs [baselineDir]
// baselineDir is an untouched copy of the project from before the map rebuild (it holds src/). With it, the
// old and new code run side by side on the same random numbers and must agree; without it, the giver and
// friend spots are compared with the recording below, taken from that copy.
// The browser-only modules these files import (ui, audio, combat, gunsfx) are replaced by small stubs, so
// this runs in plain node with no 'three' and no DOM. Exits 1 if any check fails.
import { register } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] ? path.resolve(process.argv[2]) : null;

// Giver marker spots and friend hangouts on the grid before S0c (sim px), recorded from the baseline:
// the markers came from missions.giverSpot's search, the friends stood at door + (100, 60).
const RECORDING = {
  givers: { home: [1234, 1455.4], kimchi: [1291, 3341.4], dealer: [2987, 2381.4], mart: [2219, 1549.4], yuna: [4064, 1609.4] },
  friends: { mochi: [2404, 2434], bao: [2404, 1554.4], yuna: [4164, 1554.4], dex: [3172, 2386.4] },
};

// ---------- stubs for the browser-only modules ----------

const STUBS = {
  'ui.js': 'export const toast = () => {};',
  'audio.js': 'const f = () => {}; export const sfx = new Proxy({}, { get: () => f }); export const audio = {};',
  'combat.js': 'export const giveWeapon = () => {}; export const clearLine = () => true;',
  'gunsfx.js': 'export const setSiren = () => {}; export const gunSfx = {};',
};
const HOOKS = `
const STUBS = ${JSON.stringify(STUBS)};
export async function resolve(spec, ctx, next) {
  const name = spec.split('/').pop();
  if (spec.startsWith('.') && ctx.parentURL && ctx.parentURL.includes('/src/') && STUBS[name])
    return { url: 'data:text/javascript,' + encodeURIComponent(STUBS[name]), shortCircuit: true };
  return next(spec, ctx);
}`;
register('data:text/javascript,' + encodeURIComponent(HOOKS));

globalThis.Image = class { set src(v) {} };                  // entities.js loads Kimchi's 2D sprite
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };

// ---------- harness ----------

let failed = 0, passed = 0;
const check = (ok, msg) => { if (ok) passed++; else { failed++; console.log('  FAIL ' + msg); } };
const same = (a, b) => a && b && a.x === b.x && a.y === b.y;
const xy = p => `(${p.x}, ${p.y})`;

// a seeded Math.random, so the old and new code can be fed the same numbers
const realRandom = Math.random;
function seed(s) {
  Math.random = () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// one copy of the game's modules: the world, state and the three gameplay files
async function loadGame(root) {
  const u = f => pathToFileURL(path.join(root, 'src', f)).href;
  const world = await import(u('world.js'));
  world.generate();
  const [state, ent, mis, pol] = await Promise.all([import(u('state.js')), import(u('entities.js')), import(u('3d/missions.js')), import(u('3d/police.js'))]);
  const ui = { big() {}, sub() {}, notice() {}, sound() {} };
  mis.initMissions(ui);
  return { world, G: state.G, ent, mis, pol };
}

const NEW = await loadGame(ROOT);
const OLD = BASE && existsSync(path.join(BASE, 'src/3d/missions.js')) ? await loadGame(BASE) : null;
if (BASE && !OLD) console.log(`note: ${BASE} has no src/3d/missions.js, so only the recording is compared`);
const { world, G, ent, mis, pol } = NEW;
const places = world.places;
console.log(`s0c: world KIND '${world.KIND}', BOUNDS ${JSON.stringify(world.BOUNDS)}${OLD ? ', comparing with ' + BASE : ''}`);
check(world.KIND === 'grid', `the default world should be the grid, got '${world.KIND}'`);

// ---------- 1. giver markers ----------
console.log('givers');
const givers = [...new Set(mis.MISSIONS.map(m => m.giver))];
for (const k of givers) {
  const m = mis.MISSIONS.find(x => x.giver === k);
  const s = mis.giverSpot(m), rec = RECORDING.givers[k];
  check(places[k].giver && same(s, places[k].giver), `${k}: giverSpot ${xy(s)} should be place.giver`);
  check(rec && s.x === rec[0] && s.y === rec[1], `${k}: giverSpot ${xy(s)} should match the recording ${rec}`);
  if (OLD) {
    const o = OLD.mis.giverSpot(OLD.mis.MISSIONS.find(x => x.giver === k));
    check(same(s, o), `${k}: giverSpot ${xy(s)} should match the old search ${xy(o)}`);
  }
}
// a place without a giver spot falls back to the old search, which lands on the same spot on the grid
for (const k of givers) {
  const g = places[k].giver;
  delete places[k].giver;
  const s = mis.giverSpot({ giver: k });
  places[k].giver = g;
  check(same(s, g), `${k}: the fallback search gives ${xy(s)}, place.giver is ${xy(g)}`);
}

// ---------- 2. spawning: friends at the hangouts, and the whole spawn unchanged ----------
console.log('spawnWorld');
G.player.x = 3000; G.player.y = 3000;
seed(7); ent.spawnWorld();
for (const f of G.friends) {
  const pl = places[f.def.home], h = pl.hangout, rec = RECORDING.friends[f.def.id];
  check(same(f.spot, h) && f.spot !== h, `${f.def.id}: spot ${xy(f.spot)} should be a copy of ${f.def.home}.hangout ${xy(h)}`);
  check(f.spot.x === pl.door.x + 100 && f.spot.y === pl.door.y + 60, `${f.def.id}: spot should be door + (100, 60)`);
  check(rec && f.x === rec[0] && f.y === rec[1], `${f.def.id}: stands at ${xy(f)}, recorded ${rec}`);
}
const dumpCars = g => g.cars.map(c => [c.type, c.x, c.y, c.a, c.color, !!c.ai, c.ai?.max].join()).join('|');
const dumpPeds = g => g.peds.map(p => [p.x, p.y, p.dir, p.look.shirt].join()).join('|');
const dumpFriends = g => g.friends.map(f => [f.def.id, f.x, f.y, f.spot.x, f.spot.y].join()).join('|');
if (OLD) {
  OLD.G.player.x = 3000; OLD.G.player.y = 3000;
  seed(7); OLD.ent.spawnWorld();
  check(dumpCars(G) === dumpCars(OLD.G), 'spawnWorld cars should match the old code on the same random numbers');
  check(dumpPeds(G) === dumpPeds(OLD.G), 'spawnWorld peds should match the old code on the same random numbers');
  check(dumpFriends(G) === dumpFriends(OLD.G), 'spawnWorld friends should match the old code');
}

// ---------- 3. respawnPed samples inside BOUNDS ----------
console.log('respawnPed');
const B = world.BOUNDS;
const respawnAll = (game, n) => {
  const out = [];
  for (let i = 0; i < n; i++) { const p = game.ent.makePed(-1, -1); if (game.ent.respawnPed(p)) out.push(p.x, p.y); }
  return out;
};
seed(11);
const pts = respawnAll(NEW, 300);
let inside = true;
for (let i = 0; i < pts.length; i += 2) inside &&= pts[i] >= B.x0 && pts[i] < B.x1 && pts[i + 1] >= B.y0 && pts[i + 1] < B.y1;
check(pts.length > 400 && inside, `every respawned ped should be inside BOUNDS (${pts.length / 2} of 300 placed)`);
if (OLD) {
  seed(11);
  check(respawnAll(OLD, 300).join() === pts.join(), 'respawnPed should place peds exactly where the old code did');
}
// with smaller bounds every ped must land inside them (the sampler reads BOUNDS, not the grid size)
if (!Object.isFrozen(B)) {
  const keep = { ...B };
  Object.assign(B, { x0: 2000, y0: 3000, x1: 4000, y1: 4500 });
  G.player.x = 0; G.player.y = 0;    // far from every point of the smaller bounds, so none is rejected for being close
  seed(12);
  const sub = respawnAll(NEW, 100);
  Object.assign(B, keep);
  let ok = true;
  for (let i = 0; i < sub.length; i += 2) ok &&= sub[i] >= 2000 && sub[i] < 4000 && sub[i + 1] >= 3000 && sub[i + 1] < 4500;
  check(sub.length > 100 && ok, `respawnPed should stay inside a smaller BOUNDS (${sub.length / 2} of 100 placed)`);
} else console.log('  note: BOUNDS is frozen, so the smaller-bounds check is skipped');

// ---------- 4. updatePlayer clamps Kimchi to BOUNDS ----------
console.log('updatePlayer');
const clampAt = (game, x, y) => { const p = game.G.player; p.car = null; p.x = x; p.y = y; game.ent.updatePlayer(0.016, {}); return { x: p.x, y: p.y }; };
for (const [x, y] of [[-500, -500], [1e7, 1e7], [-50, 1e7], [5000, -3]]) {
  const got = clampAt(NEW, x, y);
  const want = { x: Math.min(Math.max(x, B.x0 + 20), B.x1 - 20), y: Math.min(Math.max(y, B.y0 + 20), B.y1 - 20) };
  check(same(got, want), `on foot at (${x}, ${y}) Kimchi should be clamped to ${xy(want)}, got ${xy(got)}`);
  if (OLD) { const o = clampAt(OLD, x, y); check(same(got, o), `clamp at (${x}, ${y}) should match the old ${xy(o)}`); }
}

// ---------- 5. missions: car arrivals go to the curb, walking to the door ----------
console.log('missions');
const M = mis.missionState;
const startSteps = steps => { mis.resetMissions(); G.player.dead = false; mis.startMission({ id: 's0c_test', title: 'Test', reward: 0, steps }); return M.active.s; };
const talk = { type: 'talk', lines: [['Kimchi', 'ok']] };
const withCurb = (key, curb, fn) => { const keep = places[key].curb; places[key].curb = curb; try { fn(); } finally { places[key].curb = keep; } };

// on the grid the curb is the door, so the targets are where they always were
for (const [key, car] of [['dealer', true], ['kimchi', false]]) {
  const s = startSteps([{ type: 'goto', to: key, car, r: 140 }, talk]);
  check(same(s.pt, places[key].door) && same(s.pt, places[key].curb), `goto ${key}: target ${xy(s.pt)} should be the door, which is the curb on the grid`);
  check(same(G.missionBeacons[0], s.pt), `goto ${key}: the beacon should sit on the target`);
}
// move the curb away from the door: only car arrivals follow it
const far = d => ({ x: d.x + 333, y: d.y + 444, a: Math.PI / 2 });
withCurb('dealer', far(places.dealer.door), () => {
  const s = startSteps([{ type: 'goto', to: 'dealer', car: true, r: 170 }, talk]);
  check(same(s.pt, places.dealer.curb), `goto with car:true should target the curb ${xy(places.dealer.curb)}, got ${xy(s.pt)}`);
  check(same(G.missionBeacons[0], places.dealer.curb), 'goto with car:true should put the beacon on the curb');
});
withCurb('kimchi', far(places.kimchi.door), () => {
  const s = startSteps([{ type: 'goto', to: 'kimchi', r: 140 }, talk]);
  check(same(s.pt, places.kimchi.door), `goto on foot should target the door ${xy(places.kimchi.door)}, got ${xy(s.pt)}`);
});
{
  const s = startSteps([{ type: 'goto', to: [1234, 5678], r: 140, car: true }, talk]);
  check(s.pt.x === 1234 && s.pt.y === 5678, 'goto to fixed coordinates should keep them');
}
// a drop-off ends at the curb, and only when the car is there
const dropAt = (x, y) => {
  const s = startSteps([{ type: 'dropoff', friend: 'mochi', to: 'fashion' }, talk]);
  const f = G.friends.find(q => q.def.id === 'mochi');
  const c = ent.makeCar('sedan', x, y, 0);
  G.cars.push(c);
  Object.assign(G.player, { car: c, x, y });
  Object.assign(f, { following: true, inCar: true, missionFollow: true });
  const pt = s.pt;
  mis.updateMissions(0.016);
  const doneStep = M.active?.i === 1;
  mis.failMission('test over');
  G.cars = G.cars.filter(q => q !== c);
  G.player.car = null;
  return { pt, doneStep };
};
{
  const cu = places.fashion.curb;
  const r = dropAt(cu.x, cu.y);
  check(same(r.pt, cu) && same(r.pt, places.fashion.door), `dropoff should target the curb (the door on the grid), got ${xy(r.pt)}`);
  check(r.doneStep, 'dropoff should finish with the car stopped at the curb');
}
withCurb('fashion', far(places.fashion.door), () => {
  const d = places.fashion.door, cu = places.fashion.curb;
  const atDoor = dropAt(d.x, d.y), atCurb = dropAt(cu.x, cu.y);
  check(same(atDoor.pt, cu), `dropoff should target a moved curb ${xy(cu)}, got ${xy(atDoor.pt)}`);
  check(!atDoor.doneStep, 'dropoff should not finish at the door once the curb is elsewhere');
  check(atCurb.doneStep, 'dropoff should finish at the moved curb');
});

// ---------- 6. police: K-Spray triggers inside places.spray.bay ----------
console.log('K-Spray');
const bay = places.spray.bay, door = places.spray.door;
check(bay && bay.x === door.x && bay.y === door.y + 40 && bay.r === 120, `spray bay should be door + (0, 40) r 120 on the grid, got ${JSON.stringify(bay)}`);
// drive a fresh car to (x, y) with one star and plenty of cash; true when K-Spray resprays it
const sprays = (game, x, y) => {
  const g = game.G, c = game.ent.makeCar('sedan', x, y, 0);
  Object.assign(g, { wanted: 1, money: 1e6, heatT: 5, evadeT: 0 });
  g.player.car = c; g.player.x = x; g.player.y = y; g.player.dead = false;
  game.pol.police.sprayLock = false; game.pol.police.spawnT = 1e9;
  const n0 = g.sprayed || 0;
  game.pol.updatePolice(0.016);
  g.player.car = null;
  return (g.sprayed || 0) > n0;
};
let hits = 0, agree = true;
for (let dx = -150; dx <= 150; dx += 10) {
  for (let dy = -100; dy <= 200; dy += 10) {
    const x = door.x + dx, y = door.y + dy, now = sprays(NEW, x, y);
    hits += now;
    if (now !== Math.hypot(x - bay.x, y - bay.y) < bay.r) agree = false;
    if (OLD) {
      const od = OLD.world.places.spray.door;
      if (sprays(OLD, od.x + dx, od.y + dy) !== now) agree = false;
    }
  }
}
check(hits > 0 && agree, `the K-Spray trigger should be the bay circle${OLD ? ' and match the old door + 40 test' : ''} (${hits} of 961 points inside)`);
{
  const keep = { ...bay };
  Object.assign(bay, { x: door.x + 500, y: door.y + 500, r: 60 });
  const atOld = sprays(NEW, keep.x, keep.y), atNew = sprays(NEW, bay.x, bay.y);
  Object.assign(bay, keep);
  check(!atOld && atNew, 'K-Spray should follow a moved bay');
}

Math.random = realRandom;
console.log(failed ? `s0c: ${failed} failed, ${passed} passed` : `s0c: ok (${passed} checks)`);
process.exit(failed ? 1 : 0);
