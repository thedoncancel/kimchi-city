#!/usr/bin/env node
// Stage S1b check, part 2: the same lane traffic, sidewalk peds and ring population on the Kimchi Key v2 road
// network (src/map/mapdata.js ROADS), long before the v2 world can be played. The network is built into the
// world's roads container in node, so traffic meets what the grid never has: priority T's on the Loop where
// side roads yield, Seoul Circle's one-way ring, two-lane highway and boulevards with lane changes, and dead
// ends with U-turns.
//   node tools/s1b_v2net_test.mjs [minutes=10] [seed=1]
// Part A packs 60 cars and 60 people onto the whole network and plays `minutes` of game time: at most 1% of
// car samples stopped for over 5 s, no two cars within 3 m outside the junctions or within 20 cm of touching
// in them, crossing connectors (and opposing turns that pass too close) never used at once, mean speed at least
// 6 m/s, and lane changes, yields and ring laps all happen. Part B drives a
// focus round the Loop at 25 m/s with the population in ring mode: traffic and people stay within their caps
// and rings. Part C switches the signal candidates on: nobody crosses a signalled stop line on red, and waiting
// at the lights is not counted as stuck. Exits 1 if any check fails.
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MINUTES = Number(process.argv[2] || 10), SEED = Number(process.argv[3] || 1);
const STUBS = {
  'ui.js': 'export const toast = () => {};',
  'audio.js': 'const f = () => {}; export const sfx = new Proxy({}, { get: () => f }); export const audio = {};',
};
register('data:text/javascript,' + encodeURIComponent(`
const STUBS = ${JSON.stringify(STUBS)};
export async function resolve(spec, ctx, next) {
  const name = spec.split('/').pop();
  if (spec.startsWith('.') && ctx.parentURL && ctx.parentURL.includes('/src/') && STUBS[name])
    return { url: 'data:text/javascript,' + encodeURIComponent(STUBS[name]), shortCircuit: true };
  return next(spec, ctx);
}`));
globalThis.Image = class { set src(v) {} };
let seed = SEED * 2654435761 >>> 0;
Math.random = () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const u = f => pathToFileURL(path.join(ROOT, 'src', f)).href;
const world = await import(u('world.js'));
world.generate();
const D = await import(u('map/mapdata.js'));
const { buildRoadNet } = await import(u('map/roadnet.js'));
const { G } = await import(u('state.js'));
const traffic = await import(u('sim/traffic.js'));
const peds = await import(u('sim/peds.js'));
const pop = await import(u('sim/population.js'));
const { roads, BOUNDS, PX_PER_M: M } = world;
const { CAR_TYPES } = await import(u('data.js'));

let failed = 0, passed = 0;
const check = (ok, msg) => { if (ok) passed++; else { failed++; console.log('  FAIL ' + msg); } };
const info = msg => console.log('  ' + msg);

// Whether the bodies of cars a and b, each grown by `pad` px all round, overlap (separating axes).
function touching(a, b, pad = 0) {
  const A = CAR_TYPES[a.type], B = CAR_TYPES[b.type], dx = b.x - a.x, dy = b.y - a.y;
  const ax = [Math.cos(a.a), Math.sin(a.a)], ay = [-ax[1], ax[0]], bx = [Math.cos(b.a), Math.sin(b.a)], by = [-bx[1], bx[0]];
  const al = A.len / 2 + pad, aw = A.wid / 2 + pad, bl = B.len / 2 + pad, bw = B.wid / 2 + pad;
  for (const n of [ax, ay, bx, by]) {
    const dot = (u) => Math.abs(u[0] * n[0] + u[1] * n[1]);
    if (Math.abs(dx * n[0] + dy * n[1]) > al * dot(ax) + aw * dot(ay) + bl * dot(bx) + bw * dot(by)) return false;
  }
  return true;
}

// Pairs of cars within 20 cm of touching where at least one is on a connector (ghosts, cars that ghosted
// into the junction, and whatever a car is passing through aside): { n, min (closest centres, m) }.
function junctionNear() {
  const cs = G.cars.filter(c => c.ai && c.ai.ghost <= 0 && !c.ai.forced);
  let n = 0, min = Infinity;
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
    const a = cs[i], b = cs[j];
    if ((a.ai.conn < 0 && b.ai.conn < 0) || a.ai.through === b || b.ai.through === a) continue;
    const dx = a.x - b.x, dy = a.y - b.y;
    if (Math.abs(dx) > 10 * M || Math.abs(dy) > 10 * M) continue;
    if (touching(a, b, 0.1 * M)) n++;
    min = Math.min(min, Math.hypot(dx, dy) / M);
  }
  return { n, min };
}

buildRoadNet(D.ROADS, D.ROAD_CLASSES, { px: M, seaLevel: D.SEA_LEVEL, signals: D.SIGNALS.candidates, signalsOn: false, priority: D.SIGNALS.priority, into: roads });
Object.assign(BOUNDS, { x0: 0, y0: 0, x1: D.WORLD.w * M, y1: D.WORLD.h * M });
console.log(`s1b v2 network: ${roads.nodes.length} nodes, ${roads.lanes.length} lanes, ${roads.conns.length} connectors (${roads.conns.filter(c => c.yield).length} yield), ${roads.walks.paths.length} walk paths; seed ${SEED}`);

// ---------- A. a busy network ----------
console.log(`A: 60 cars and 60 people for ${MINUTES} min`);
Object.assign(G.player, { x: -1e6, y: -1e6, car: null, dead: false });
G.cars = []; G.peds = []; G.friends = [];
for (let i = 0; i < 200 && G.cars.length < 60; i++) {
  const q = roads.randomLanePoint({ ai: true, minGap: 25 * M });
  if (!q || G.cars.some(c => Math.hypot(c.x - q.x, c.y - q.y) < 15 * M)) continue;
  G.cars.push(traffic.aiAttach(pop.makeCar('sedan', q.x, q.y, q.a), q));
}
for (let i = 0; i < 60; i++) { const q = peds.randomSidewalk(); const p = pop.makePed(q.x, q.y); peds.attachWalk(p, q); G.peds.push(p); }
check(G.cars.length === 60, `60 cars placed (${G.cars.length})`);
traffic.resetTrafficStats();
const dt = 1 / 60, frames = Math.round(MINUTES * 60 / dt);
let clashes = 0, laneChanges = 0, yields = 0, ringLaps = 0, maxV = 0, ms = 0, crossings = 0, boxNear = 0, boxMin = Infinity;
const seen = new Map(), onRing = new Map();
const ringEdges = new Set(roads.edges.filter(e => e.cls === 'ring').map(e => e.id));
for (let f = 0; f < frames; f++) {
  const t0 = performance.now();
  traffic.updateTraffic(dt);
  for (const p of G.peds) peds.walkPed(p, dt, 15);
  ms += performance.now() - t0;
  const used = [];
  for (const c of G.cars) {
    const a = c.ai;
    if (!a) continue;
    maxV = Math.max(maxV, a.speed);
    if (a.lcT > 0 && seen.get(c) !== 'lc') { laneChanges++; seen.set(c, 'lc'); } else if (a.lcT <= 0 && seen.get(c) === 'lc') seen.delete(c);
    if (a.why === 'yield') yields++;
    if (a.conn >= 0 && a.ghost <= 0 && !a.forced) used.push(a.conn);   // ghosts may cross anything
    const ring = a.conn < 0 && ringEdges.has(roads.lanes[a.lane].edge);
    if (ring && !onRing.get(c)) ringLaps++;
    onRing.set(c, ring);
  }
  for (const p of G.peds) if (p.walk && roads.walks.paths[p.walk.path].cross && !p.crossing) { p.crossing = true; crossings++; } else if (p.walk && !roads.walks.paths[p.walk.path].cross) p.crossing = false;
  for (let i = 0; i < used.length; i++) for (let j = i + 1; j < used.length; j++) {
    const K = traffic.junctionConflicts(used[i]);
    for (let k = 0; k < K.length; k++) if (K[k] === used[j]) clashes++;
  }
  const near = junctionNear();
  boxNear += near.n; boxMin = Math.min(boxMin, near.min);
}
const st = traffic.trafficStats();
info(`stats ${JSON.stringify({ ...st, pedsOnRoad: undefined, pedOnRoadSamples: undefined })}`);
info(`${(ms / frames).toFixed(3)} ms a frame (60 cars, 60 people); top speed ${(maxV / M).toFixed(1)} m/s; ${laneChanges} lane changes, ${yields} yield frames, ${ringLaps} ring entries, ${crossings} crosswalk crossings`);
check(st.stuckPct <= 1, `at most 1% of car samples stopped for over 5 s (got ${st.stuckPct}%)`);
check(st.closePairs === 0, `no two cars within 3 m outside the junctions (${st.closePairs}, min ${st.minGap} m)`);
check(st.meanSpeed >= 6, `mean speed at least 6 m/s (got ${st.meanSpeed})`);
check(clashes === 0, `crossing connectors (and opposing turns passing too close) never used at once (${clashes})`);
check(boxNear === 0, `no two cars within 20 cm of touching in the junctions either (${boxNear} samples; closest centres ${boxMin.toFixed(2)} m apart)`);
check(laneChanges > 0, `cars change lanes on the highway and boulevards (${laneChanges})`);
check(yields > 0, `side roads yield to priority traffic (${yields} frames)`);
check(ringLaps > 0, `cars use Seoul Circle (${ringLaps} entries)`);
check(maxV > 20 * M, `the Loop is driven at highway speed (top ${(maxV / M).toFixed(1)} m/s)`);
check(crossings > 0, `people use the crosswalks (${crossings})`);
check(G.peds.every(p => p.walk), 'every person is still on a sidewalk path');
check(ms / frames < 1, `a frame costs under 1 ms (${(ms / frames).toFixed(3)})`);

// ---------- B. the ring population, following the focus round the Loop ----------
console.log('B: ring population round the Loop at 25 m/s');
G.cars = []; G.peds = [];
const loop = roads.route(1000 * M, 300 * M, 1500 * M, 1100 * M);
const nav = { pts: loop.pts };
const focus = { x: loop.pts[0], y: loop.pts[1], a: 0 };
// a fixed view (everything within 120 m of the focus is on screen), so the rings' out-of-view rules are exact
const view = (x, y) => Math.hypot(x - focus.x, y - focus.y) < 120 * M;
let at = 0, overCap = 0, farCars = 0, farPeds = 0, maxCars = 0, maxPeds = 0, minCarsLate = Infinity;
Object.assign(G.player, { x: focus.x, y: focus.y });
pop.updatePopulation(0, { x: focus.x, y: focus.y, a: 0 }, { mode: 'ring', tier: 'medium', view });
pop.spawnPopulation();
const steps = Math.min(frames, Math.floor(loop.len / (25 * M) / dt));
for (let f = 0; f < steps; f++) {
  at += 25 * M * dt;
  const [x, y] = roads.follow(nav, focus.x, focus.y, 25 * M * dt);
  focus.a = Math.atan2(y - focus.y, x - focus.x); focus.x = x; focus.y = y;
  Object.assign(G.player, { x, y });
  traffic.updateTraffic(dt);
  for (const p of G.peds) peds.walkPed(p, dt, 15);
  pop.updatePopulation(dt, { x: focus.x, y: focus.y, a: focus.a }, { mode: 'ring', tier: 'medium', view });
  const cars = G.cars.filter(c => c.ai), people = G.peds.filter(p => !p.role);
  maxCars = Math.max(maxCars, cars.length); maxPeds = Math.max(maxPeds, people.length);
  if (cars.length > pop.CAPS.medium.traffic || people.length > pop.CAPS.medium.peds) overCap++;
  if (f > 60 * 20) minCarsLate = Math.min(minCarsLate, cars.length);
  // dropped on the next population pass (every 0.25 s), so allow 0.5 s of travel past the ring
  farCars += cars.filter(c => Math.hypot(c.x - focus.x, c.y - focus.y) > (460 + 13) * M).length;
  farPeds += people.filter(p => Math.hypot(p.x - focus.x, p.y - focus.y) > (190 + 13) * M).length;
}
info(`${(steps * dt).toFixed(0)} s of driving: up to ${maxCars} cars and ${maxPeds} people; after warm-up never fewer than ${minCarsLate} cars`);
check(overCap === 0, `traffic and people stay within the Medium caps (24 / 34) (${overCap} frames over)`);
check(farCars === 0 && farPeds === 0, `nobody streamed is left behind past the rings (${farCars} car, ${farPeds} people frames)`);
check(minCarsLate >= 12, `the ring keeps traffic round the focus (at least 12 after 20 s, got ${minCarsLate})`);
check(maxPeds >= 20, `the ring keeps people round the focus (${maxPeds})`);
pop.clearPopulation();
check(!G.cars.some(c => c.ai) && !G.peds.some(p => !p.role), 'clearPopulation takes every streamed car and person away');

// ---------- C. signals switched on (mapdata SIGNALS.enabled; tools/f4_signals_soak.mjs is their soak) ----------
console.log('C: the 13 signal candidates switched on, 40 cars for 3 min');
roads.setSignals(true);
const sigNodes = roads.nodes.filter(n => n.control === 'signal');
G.cars = []; G.peds = [];
Object.assign(G.player, { x: -1e6, y: -1e6 });          // out of the road B left him on (traffic waits for him)
for (let i = 0; i < 200 && G.cars.length < 40; i++) {
  const q = roads.randomLanePoint({ ai: true, minGap: 25 * M });
  if (!q || G.cars.some(c => Math.hypot(c.x - q.x, c.y - q.y) < 15 * M)) continue;
  G.cars.push(traffic.aiAttach(pop.makeCar('sedan', q.x, q.y, q.a), q));
}
traffic.resetTrafficStats();
let reds = 0, greens = 0, sClash = 0, sNear = 0;
const front = new Map();
for (let f = 0; f < 60 * 180; f++) {
  traffic.updateTraffic(dt);
  const used = [];
  for (const c of G.cars) {
    const a = c.ai;
    // the front bumper crossing a signalled stop line (10 cm over it, as a car braking to it may settle): on
    // which light
    if (a.conn < 0) {
      const L = roads.lanes[a.lane], N = roads.nodes[L.b], fr = a.s + CAR_TYPES[c.type].len / 2, was = front.get(c);
      const line = L.len - traffic.stopLine(a.lane) + 0.1 * M;
      if (N.control === 'signal' && was && was.lane === a.lane && was.fr < line && fr >= line) { if (roads.signalAt(N, L.edge) === 'r') reds++; else greens++; }
      front.set(c, { lane: a.lane, fr });
    } else front.delete(c);
    if (a.conn >= 0 && a.ghost <= 0 && !a.forced) used.push(a.conn);
  }
  for (let i = 0; i < used.length; i++) for (let j = i + 1; j < used.length; j++) {
    const K = traffic.junctionConflicts(used[i]);
    for (let k = 0; k < K.length; k++) if (K[k] === used[j]) sClash++;
  }
  sNear += junctionNear().n;
}
const sst = traffic.trafficStats();
info(`${sigNodes.length} signal nodes; ${greens} stop lines crossed on green or amber, ${reds} on red; mean ${sst.meanSpeed} m/s, ${sst.ghosts} ghosts, stuck ${sst.stuckPct}% (${sst.stoppedPct}% stopped, red lights counted)`);
check(sigNodes.length >= 10, `signal candidates become signals when switched on (${sigNodes.length})`);
check(greens > 20 && reds === 0, `nobody crosses a signalled stop line on red (${reds} of ${reds + greens})`);
check(sst.stuckPct <= 1, `waiting at the lights is not stuck: at most 1% of car samples stopped over 5 s, red lights aside (${sst.stuckPct}%)`);
check(sClash === 0 && sNear === 0, `crossing connectors never used at once under signals (${sClash}), no two cars touching in a junction (${sNear})`);
check(sst.meanSpeed >= 5 && sst.ghosts <= 2, `traffic keeps moving under signals (${sst.meanSpeed} m/s, ${sst.ghosts} ghosts)`);
roads.setSignals(false);

console.log(failed ? `s1b v2: ${failed} failed, ${passed} passed` : `s1b v2: ok (${passed} checks)`);
process.exit(failed ? 1 : 0);
