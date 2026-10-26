#!/usr/bin/env node
// Stage S0b check: src/3d/bench.js driven by a fake game loop, renderer, GPU timer and graphics switch, in node.
//   node tools/s0b_bench_test.mjs
// KC3.teleport, KC3.bench and KC3.soak are run against the grid's bench views; the fake frame draws a known
// number of calls and triangles per view and takes a known GPU time, so the medians, the counting of the
// whole frame (shadow pass included), the held clock, the quality level and the restored state can be checked.
// Exits 1 if any check fails.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis;
Object.assign(globalThis, { innerWidth: 1440, innerHeight: 800 });

const W = await import(pathToFileURL(path.join(ROOT, 'src/world.js')).href);
const { installBench } = await import(pathToFileURL(path.join(ROOT, 'src/3d/bench.js')).href);
W.generate();

let failed = 0, passed = 0;
const check = (ok, msg) => { if (ok) passed++; else { failed++; console.log('  FAIL ' + msg); } };

// ---------- fakes ----------

const G = { mode: 'title', time: 600, player: { x: 0, y: 0, dead: null }, cars: [1, 2], peds: [1, 2, 3] };
let at = null, starts = 0;
const placed = [];
const place = (v) => { at = v.name; placed.push(v.name); G.player.x = v.x; G.player.y = v.y; };
const start = () => { starts++; G.mode = 'play'; };

// three.js's counters: render() clears them first unless autoReset is off; the shadow pass comes before that
const info = { autoReset: true, render: { calls: 0, triangles: 0 }, reset() { this.render.calls = 0; this.render.triangles = 0; } };
const COST = { home: [100, 50000], park: [140, 90000], motors: [120, 70000], boutiques: [130, 80000], marina: [90, 40000], jet: [110, 60000] };
function threeRender(calls, tris, shadow) {   // one renderer.render(scene) call
  info.render.calls += shadow;                // shadow map, drawn before three resets the counters
  if (info.autoReset) info.reset();
  info.render.calls += calls; info.render.triangles += tris;
}
const GPU = { home: 4, park: 6, motors: 5, boutiques: 5.5, marina: 3, jet: 4.5 };
let gpuNow = 0, levelSets = [];
const composerRender = () => {
  const [c, t] = COST[at] || [10, 10];
  threeRender(c, t, 20);                       // the scene with its shadow pass
  threeRender(1, 2, 0); threeRender(1, 2, 0);  // two post passes
  gpuNow = GPU[at] || 1;
};
const gfx = {
  level: 0, name: 'Ultra', gpuMs: 7.7, renders: 0,
  setLevel(l) { this.level = l; this.name = ['Ultra', 'High', 'Medium', 'Low', 'Lowest'][l]; levelSets.push(l); },
  render() { this.renders++; composerRender(); },
  passes: { composer: { render: composerRender } },
};
// a timer query answers one frame after it ends
const pending = new Map();
let glFrame = 0, active = null, created = 0, deleted = 0;
const gl = {
  QUERY_RESULT_AVAILABLE: 1, QUERY_RESULT: 2,
  getExtension: (n) => (n === 'EXT_disjoint_timer_query_webgl2' ? { TIME_ELAPSED_EXT: 9, GPU_DISJOINT_EXT: 8 } : null),
  createQuery: () => { created++; return {}; },
  beginQuery: (k, q) => { if (active) throw new Error('nested query'); active = q; },
  endQuery: () => { pending.set(active, { ready: glFrame + 1, ns: gpuNow * 1e6 }); active = null; },
  getQueryParameter: (q, p) => (p === 1 ? glFrame >= pending.get(q).ready : pending.get(q).ns),
  getParameter: () => false,
  deleteQuery: (q) => { deleted++; pending.delete(q); },
};
const renderer = { info, getContext: () => gl, getPixelRatio: () => 1 };
const KC3 = { carViews: new Map([[1, {}]]) };
const hooks = installBench({ KC3, G, renderer, gfx, place, start });

// the game loop: update (which advances the clock), render, then the frame hook
let running = true, frames = 0;
function loop() {
  if (!running) return;
  frames++; glFrame++;
  G.time += 0.025;
  hooks.render();
  hooks.frame(1 + (frames % 3), 1 / 60);
  setImmediate(loop);
}
loop();

// ---------- checks ----------

check(typeof KC3.teleport === 'function' && typeof KC3.bench === 'function' && typeof KC3.soak === 'function', 'installBench adds teleport, bench and soak to KC3');
check(hooks.busy === null, 'nothing runs until asked');
let err = null;
try { KC3.teleport('nowhere'); } catch (e) { err = e.message; }
check(/no bench view 'nowhere'.*home, park, motors, boutiques, marina, jet/.test(err || ''), `an unknown view is refused with the list of views (${err})`);
const v = KC3.teleport('park');
check(starts === 1 && G.mode === 'play' && at === 'park' && v.name === 'park', 'teleport starts a game from the title and places Kimchi');

const logs = [];
const log = console.log;
console.log = (s) => logs.push(s);
const before = G.time;
const run = KC3.bench(undefined, { warm: 5, frames: 9 });
check(hooks.busy === 'bench', 'bench reports itself busy');
let rejected = null;
await KC3.soak(1).catch((e) => { rejected = e.message; });
check(/already running/.test(rejected || ''), 'a second run is refused while one is going');
const res = await run;
console.log = log;

check(Array.isArray(res) && res.length === 6 && res.map(r => r.view).join() === 'home,park,motors,boutiques,marina,jet', 'bench measures every grid view in order');
check(res.every(r => r.calls === COST[r.view][0] + 20 + 2 && r.tris === COST[r.view][1] + 4), 'calls and tris count the whole frame: shadow pass, scene and post passes');
check(res.every(r => r.gpuMs === GPU[r.view]), `gpuMs is each view's own GPU time (${res.map(r => r.gpuMs).join(', ')})`);
check(res.every(r => r.cpuMs === 2), `cpuMs is the median frame JS time (${res.map(r => r.cpuMs).join(', ')})`);
check(Object.keys(res[0]).join() === 'view,calls,tris,gpuMs,cpuMs', 'each row is { view, calls, tris, gpuMs, cpuMs }');
check(levelSets.join() === '2,0', `the bench draws at Medium and puts the level back (${levelSets.join()})`);
check(Math.abs(G.time - before) < 0.1, `the clock is given back afterwards (${before} -> ${G.time})`);
check(info.autoReset === true && hooks.busy === null, 'three.js counters and the busy flag are restored');
check(created === deleted && pending.size === 0, `every GPU query is read and deleted (${created} made, ${deleted} deleted)`);
const report = JSON.parse(logs.find(s => s.startsWith('{')) || 'null');
check(report && report.map === 'grid' && report.views.length === 6 && report.level === 2 && report.clock === 780, 'the logged JSON has the map, level, clock and views');
check(KC3.lastBench?.views.length === 6, 'KC3.lastBench keeps the report');

// the clock stands still while measuring
let held = true;
const run2 = KC3.bench(['jet'], { warm: 2, frames: 6, time: 600 });
const watch = setInterval(() => { if (hooks.busy === 'bench' && Math.abs(G.time - 600) > 0.05) held = false; }, 0);
console.log = () => {};
const one = await run2;
console.log = log;
clearInterval(watch);
check(one.length === 1 && one[0].view === 'jet' && held, 'a single named view, with the clock held at the time asked');

// soak: plays on, tours the views, reports frame times and memory
console.log = () => {};
const placedBefore = placed.length, rendersBefore = gfx.renders;
const soak = await KC3.soak(0.3, { route: ['home', 'marina'] });
console.log = log;
check(soak.frames > 5 && soak.frameMs.p50 === round(1000 / 60) && soak.cpuMs.p50 >= 1 && soak.cpuMs.p95 <= 3, `soak reports frame and JS times (${soak.frames} frames, p50 ${soak.frameMs.p50} ms)`);
check(placed.slice(placedBefore).join() === 'home,marina', `the soak route visits each view in turn (${placed.slice(placedBefore).join()})`);
check(gfx.renders - rendersBefore === soak.frames || gfx.renders - rendersBefore >= soak.frames - 1, 'a soak draws through gfx.render (auto quality keeps its own GPU clock)');
check(soak.calls === COST.marina[0] + 22 || soak.calls === COST.home[0] + 22, `soak samples the draw calls (${soak.calls})`);
check(soak.heapMB === null && soak.cars === 2 && soak.peds === 3 && soak.carViews === 1, 'soak reports memory (null in node), cars, peds and car views');
globalThis.KCSTATS = () => ({ stuck: 0 });
console.log = () => {};
const soak2 = await KC3.soak(0.05);
console.log = log;
check(soak2.stats?.stuck === 0, 'soak includes window.KCSTATS() when a stage provides it');

running = false;
console.log(failed ? `${failed} failed, ${passed} passed` : `ok (${passed} checks)`);
process.exit(failed ? 1 : 0);

function round(v) { return Math.round(v * 100) / 100; }
