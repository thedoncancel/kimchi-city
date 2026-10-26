#!/usr/bin/env node
// Stage F4 check: the traffic fixes, one scene at a time, on the Kimchi Key v2 road network built straight
// from src/map/mapdata.js (as tools/s1b_v2net_test.mjs does, so it does not wait on the v2 world's generate).
//   node tools/f4_traffic_test.mjs [seed=1]
//  1. Lane changes count the cars still coming into the new lane: a car on a connector into it, or about to
//     take one, keeps a car from changing lanes in front of it (src/sim/traffic.js laneRoom); with nobody
//     coming, the same car does change lanes.
//  2. A car put down already moving (streamed in out of view) near the end of its lane is put behind the stop
//     line and can still stop there.
//  3. The junction conflicts know the cars' bodies: a right turn out of a side road and a left turn into it
//     (they pass in its mouth, centre lines about 3.2 m apart on v2's T's) may not be driven at once;
//     side-by-side straight lanes still may.
//  4. Two cars from the same lane on different connectors: the second never comes within 20 cm of the first's
//     body, and goes on past once the first is far enough round its turn.
//  5. Traffic lights: a car waiting at a red light is not stuck (stuckPct), though it is stopped (stoppedPct);
//     a car let through on green that would only reach its line after the red (slowing for a turn) stops for
//     the amber instead, and nobody's front bumper crosses a stop line on red.
// Exits 1 if any check fails.
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED = Number(process.argv[2] || 1);
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
globalThis.KC_WORLD = 'grid';                 // the grid world is only the host: its roads are replaced below
const world = await import(u('world.js'));
world.generate();
const D = await import(u('map/mapdata.js'));
const { buildRoadNet } = await import(u('map/roadnet.js'));
const { G } = await import(u('state.js'));
const traffic = await import(u('sim/traffic.js'));
const pop = await import(u('sim/population.js'));
const { CAR_TYPES } = await import(u('data.js'));
const { roads, BOUNDS, PX_PER_M: M } = world;
const DT = 1 / 60;

let failed = 0, passed = 0;
const check = (ok, msg) => { if (ok) passed++; else { failed++; console.log('  FAIL ' + msg); } };
const info = msg => console.log('  ' + msg);

buildRoadNet(D.ROADS, D.ROAD_CLASSES, { px: M, seaLevel: D.SEA_LEVEL, signals: D.SIGNALS.candidates, signalsOn: false, priority: D.SIGNALS.priority, into: roads });
Object.assign(BOUNDS, { x0: 0, y0: 0, x1: D.WORLD.w * M, y1: D.WORLD.h * M });
const { lanes, conns, edges, nodes } = roads;
console.log(`f4 traffic: v2 network, ${nodes.length} nodes, ${lanes.length} lanes, ${conns.length} connectors; seed ${SEED}`);
const halfLen = c => CAR_TYPES[c.type].len / 2;

function fresh() {
  Object.assign(G.player, { x: -1e6, y: -1e6, car: null, dead: false });
  G.cars = []; G.peds = []; G.friends = [];
  traffic.resetTrafficStats();
}
// A traffic car on lane `lane` at station s (m) doing v (m/s), driver factor 1.
function car(lane, s, v = 0, type = 'sedan', opts = {}) {
  const L = lanes[lane], p = roads.lanePoint(lane, s * M, {});
  const c = traffic.aiAttach(pop.makeCar(type, p.x, p.y, p.a ?? 0), { lane, s: s * M }, { f: 1, speed: v * M, ...opts });
  G.cars.push(c);
  return c;
}
// The same, put on connector cid at station s (m), holding it.
function carOnConn(cid, s, v, type = 'sedan') {
  const C = conns[cid], c = car(C.from, 0, 0, type);
  Object.assign(c.ai, { conn: cid, s: s * M, speed: v * M, hold: cid, next: -1 });
  return c;
}
const run = (sec, each) => { for (let f = 0, n = Math.round(sec / DT); f < n; f++) { traffic.updateTraffic(DT); if (each && each(f) === false) break; } };

// Whether the bodies of cars a and b, each grown by `pad` px all round, overlap (separating axes).
function touching(a, b, pad = 0) {
  const A = CAR_TYPES[a.type], B = CAR_TYPES[b.type], dx = b.x - a.x, dy = b.y - a.y;
  const ax = [Math.cos(a.a), Math.sin(a.a)], ay = [-ax[1], ax[0]], bx = [Math.cos(b.a), Math.sin(b.a)], by = [-bx[1], bx[0]];
  const al = A.len / 2 + pad, aw = A.wid / 2 + pad, bl = B.len / 2 + pad, bw = B.wid / 2 + pad;
  for (const n of [ax, ay, bx, by]) {
    const dot = v => Math.abs(v[0] * n[0] + v[1] * n[1]);
    if (Math.abs(dx * n[0] + dy * n[1]) > al * dot(ax) + aw * dot(ay) + bl * dot(bx) + bw * dot(by)) return false;
  }
  return true;
}

// ---------- 1. lane changes and the cars coming into the new lane ----------
console.log('1: lane changes count the cars on connectors into the new lane');
{
  // a two-lane carriageway whose neighbour lane is fed by a connector, long enough for the scene
  let scene = null;
  for (const e of edges) {
    if (!e.laneChange || scene) continue;
    for (const side of [e.fwd, e.bwd]) for (const id of side) {
      const L = lanes[id];
      for (const nb of [L.left, L.right]) {
        if (scene || nb == null || nb < 0 || L.len < 120 * M) continue;
        const feed = lanes[nb].prev.find(cid => conns[cid].len > 8 * M && conns[cid].from !== L.id && edges[lanes[conns[cid].from].edge].ai);
        if (feed != null) scene = { L, nb, feed };
      }
    }
  }
  check(!!scene, 'found a two-lane road with a connector feeding the neighbour lane');
  if (scene) {
    const { L, nb, feed } = scene, C = conns[feed];
    info(`lane ${L.id} (${edges[L.edge].road}), neighbour ${nb}, fed by connector ${feed} (${C.turn}, ${(C.len / M).toFixed(1)} m)`);
    // A at 6 m doing 12 m/s behind a leader crawling at 2 m/s 24 m ahead: it wants to change lanes
    const scene1 = withB => {
      fresh();
      const A = car(L.id, 6, 12);
      const lead = car(L.id, 30, 2, 'sedan', { max: 2 * M });
      const B = withB ? carOnConn(feed, C.len / M - 4, 12) : null;
      let changedAt = null, gapAt = null;
      run(6, () => {
        if (A.ai.lane === nb && changedAt == null) {
          changedAt = A.ai.s / M;
          if (B) gapAt = B.ai.conn >= 0 ? A.ai.s / M - (B.ai.s - conns[B.ai.conn].len) / M : B.ai.lane === nb ? Math.abs(A.ai.s - B.ai.s) / M : Infinity;
          return false;
        }
      });
      return { changedAt, gapAt, lead };
    };
    const free = scene1(false), held = scene1(true);
    info(`alone: changed lanes at ${free.changedAt?.toFixed(1)} m; with a car coming in on the connector: ${held.changedAt == null ? 'no change' : 'changed at ' + held.changedAt.toFixed(1) + ' m, ' + held.gapAt.toFixed(1) + ' m from it'}`);
    check(free.changedAt != null, 'with nobody coming into the neighbour lane, the car changes lanes round its slow leader');
    check(held.changedAt == null || held.gapAt >= 25, `a car on a connector into the neighbour lane keeps it from changing lanes within 25 m of it (${held.gapAt == null ? 'no change' : held.gapAt.toFixed(1) + ' m'})`);
  }
}

// ---------- 2. streamed in near the end of a lane ----------
console.log('2: a car streamed in near the end of its lane');
{
  fresh();
  const L = lanes.find(l => l.len > 60 * M && l.next.length && nodes[conns[l.next[0]].node].control !== 'none');
  const c = car(L.id, L.len / M - 0.5, 20, 'phantasma');
  const line = traffic.stopLine(L.id), room = L.len - c.ai.s - halfLen(c) - line;
  info(`lane ${L.id}: put down 0.5 m from its end at 20 m/s; now at ${((L.len - c.ai.s) / M).toFixed(2)} m from the end doing ${(c.ai.speed / M).toFixed(2)} m/s`);
  check(room >= -1e-3, `it is put behind the stop line (front ${(-room / M).toFixed(2)} m past it)`);
  check(c.ai.speed * c.ai.speed / (2 * 3.5 * M) <= Math.max(0, room) + 1e-3, 'and it can stop there braking gently');
  fresh();
  const c2 = car(L.id, 10, 15);
  check(Math.abs(c2.ai.speed / M - 15) < 1e-6 && Math.abs(c2.ai.s / M - 10) < 1e-6, 'one put down far from the end keeps its spot and speed');
}

// ---------- 3. body-aware junction conflicts ----------
console.log('3: junction conflicts know the cars\' bodies');
{
  // every pair of connectors at a junction from different lanes, with two of the biggest cars (the longest
  // and the widest) anywhere on them: if their bodies would touch, the pair is a conflict (traffic.js keeps
  // 20 cm between bodies, with headings from its smoothed tangents)
  // (the heading a car on it has: along the lane it leaves at the start, the lane it joins at the end, and
  // along the chord through the points either side in between)
  const dir = (P, i, j) => Math.atan2(P.y[j] - P.y[i], P.x[j] - P.x[i]);
  const heading = (C, j) => {
    if (j === 0) { const A = lanes[C.from]; return dir(A, A.n - 2, A.n - 1); }
    if (j === C.n - 1) return dir(lanes[C.to], 0, 1);
    return dir(C, j - 1, j + 1);
  };
  const at = nodes.map(() => []);
  for (const C of conns) at[C.node].push(C);
  let pairs = 0, meet = 0, missed = 0, byCentres = 0, par = 0, parConf = 0;
  for (const list of at) for (const a of list) for (const b of list) {
    if (a.id >= b.id || a.from === b.from) continue;
    pairs++;
    const conf = traffic.junctionConflicts(a.id).includes(b.id);
    if (a.conflicts.includes(b.id)) byCentres++;
    let met = false;
    for (let i = 0; i < a.n && !met; i++) for (let j = 0; j < b.n && !met; j++) {
      if (Math.abs(a.x[i] - b.x[j]) > 8 * M || Math.abs(a.y[i] - b.y[j]) > 8 * M) continue;
      for (const [ta, tb] of [['phantasma', 'phantasma'], ['van', 'van'], ['phantasma', 'van'], ['van', 'phantasma']]) {
        if (touching({ type: ta, x: a.x[i], y: a.y[i], a: heading(a, i) }, { type: tb, x: b.x[j], y: b.y[j], a: heading(b, j) })) { met = true; break; }
      }
    }
    if (met) { meet++; if (!conf) missed++; }
    // straight on from side-by-side lanes into side-by-side lanes
    const A = lanes[a.from], B = lanes[b.from];
    if (a.turn === 's' && b.turn === 's' && A.edge === B.edge && A.dir === B.dir && lanes[a.to].edge === lanes[b.to].edge) { par++; if (conf) parConf++; }
  }
  info(`${pairs} connector pairs at junctions: on ${meet} two big cars would touch (the road graph's own crossing rule has ${byCentres}); ${missed} of those are not conflicts; side-by-side straight pairs that are: ${parConf} of ${par}`);
  check(meet > byCentres && missed === 0, 'every pair of connectors on which two big cars would touch is a junction conflict');
  check(par > 0 && parConf === 0, 'side-by-side straight lanes still go together');
}

// ---------- 4. two cars from one lane, on different connectors ----------
console.log('4: the second of two cars from one lane stops short of the first on another connector');
{
  // a lane with a straight and a turning connector; the first car (a long one) stands on the turning one, 3 to
  // 9 m in (someone in its way, say), and the second comes up to go straight on
  let worst = Infinity, scenes = 0, touched = 0, passedBy = 0, held = 0;
  for (const L of lanes) {
    if (L.next.length < 2 || L.len < 40 * M || scenes >= 40) continue;
    const turn = L.next.find(id => conns[id].turn === 'r' || conns[id].turn === 'l'), straight = L.next.find(id => conns[id].turn === 's');
    if (turn == null || straight == null || conns[turn].len < 10 * M) continue;
    for (const at of [3, 5, 7, 9]) {
      scenes++;
      fresh();
      const X = carOnConn(turn, at, 0, 'phantasma');
      X.ai.max = 0;
      const Y = car(L.id, L.len / M - 25, 8, 'phantasma');
      run(10, () => {
        if (Y.ai.conn < 0 && Y.ai.lane === L.id) Y.ai.next = straight;
        if (touching(X, Y, 0.1 * M)) touched++;
        worst = Math.min(worst, Math.hypot(X.x - Y.x, X.y - Y.y) / M);
      });
      if (Y.ai.lane === conns[straight].to) passedBy++; else held++;
    }
  }
  info(`${scenes} scenes: the second car went past ${passedBy} times and waited ${held} times; closest centres ${worst.toFixed(2)} m`);
  check(scenes >= 12 && touched === 0, `the second car never comes within 20 cm of the first (${touched} frames)`);
  check(passedBy > 0 && held > 0, 'it waits while the first one\'s body is in its way, and goes past once it is not');
}

// ---------- 5. traffic lights ----------
console.log('5: traffic lights');
{
  roads.setSignals(true);
  const sig = nodes.filter(n => n.control === 'signal');
  check(sig.length >= 10, `the signal candidates become lights when switched on (${sig.length})`);
  // the light from an approach lane at its node, t s from now
  const lightIn = (L, t) => { const c0 = roads.clock; roads.clock = c0 + t; const l = roads.signalAt(nodes[L.b], L.edge); roads.clock = c0; return l; };
  // the clock moved on to the moment the light from lane L next turns `to` (searching in 0.05 s steps)
  const until = (L, to) => { for (let i = 0; i < 2000 && roads.signalAt(nodes[L.b], L.edge) === to; i++) roads.tick(0.05); for (let i = 0; i < 2000 && roads.signalAt(nodes[L.b], L.edge) !== to; i++) roads.tick(0.05); };
  const approaches = lanes.filter(L => L.next.length && nodes[L.b].control === 'signal' && L.len > 60 * M && edges[L.edge].ai);

  // a car waiting at a red light, and the queue behind it, are stopped but not stuck
  {
    const L = approaches[0];
    fresh();
    until(L, 'r');
    const a = car(L.id, L.len / M - 20, 8), b = car(L.id, L.len / M - 45, 8);
    let ran = 0;
    run(15, () => { if (lightIn(L, 0) === 'r' && a.ai.conn < 0 && a.ai.s + halfLen(a) > L.len - traffic.stopLine(L.id) + 0.1 * M) ran++; });
    const st = traffic.trafficStats();
    info(`two cars at the red light from lane ${L.id} for 15 s: stuckPct ${st.stuckPct}, stoppedPct ${st.stoppedPct}, red-light waiting ${a.ai.red} / ${b.ai.red}`);
    check(a.ai.red && b.ai.red, 'the first car waits at the red light and the second queues behind it');
    check(st.stuckPct === 0 && st.stoppedPct > 0, 'waiting at a red light is not stuck (stuckPct 0) but is stopped (stoppedPct)');
    check(ran === 0, 'neither crosses the stop line on red');
  }

  // amber: a car let through on green at the road's speed, the amber coming when it is just too close to stop
  // gently. Going straight on it is over its line before the red; slowing for a turn it would reach the line
  // only after the red, so it stops for the amber instead (braking harder).
  {
    let tried = 0, runs = 0, turnStops = 0, straightOn = 0, straights = 0;
    for (const L of approaches) {
      const v = edges[L.edge].speed / M;
      if (v < 13 || tried >= 60) continue;
      for (const kind of ['turn', 'straight']) {
        const cid = L.next.find(id => kind === 'turn' ? conns[id].turn === 'l' || conns[id].turn === 'r' : conns[id].turn === 's');
        if (cid == null) continue;
        for (const short of [0.5, 2, 4, 6]) {
          tried++;
          fresh();
          until(L, 'a');
          // put down just short of where it asks for the junction (src/sim/traffic.js), the amber coming when
          // it is `short` m inside the distance it needs to stop braking gently
          const ask = Math.max(10, v * v / 7 + 6), room0 = ask + 1, lead = (room0 - (v * v / 7 - short)) / v;
          roads.clock -= lead;
          const c = car(L.id, (L.len - traffic.stopLine(L.id)) / M - room0 - halfLen({ type: 'sedan' }) / M, v);
          c.ai.next = cid;
          let crossed = null;
          run(10, () => {
            if (c.ai.conn >= 0 || crossed != null) return;
            c.ai.next = cid;
            if (c.ai.s + halfLen(c) > L.len - traffic.stopLine(L.id) + 0.1 * M) crossed = lightIn(L, 0);
          });
          if (crossed === 'r') runs++;
          if (kind === 'turn' && crossed == null) turnStops++;
          if (kind === 'straight') { straights++; if (crossed === 'a' || crossed === 'g') straightOn++; }
        }
      }
    }
    info(`${tried} cars let through just before the amber: ${straightOn} of ${straights} going straight on crossed on amber; ${turnStops} turning stopped for it; ${runs} ran the red`);
    check(tried >= 20 && runs === 0, 'nobody let through on green crosses the line on red');
    check(straightOn > 0 && turnStops > 0, 'a car going straight on runs the amber, one slowing for a turn that would be late stops for it');
  }
  roads.setSignals(false);
}

console.log(failed ? `f4 traffic: ${failed} failed, ${passed} passed` : `f4 traffic: ok (${passed} checks)`);
process.exit(failed ? 1 : 0);
