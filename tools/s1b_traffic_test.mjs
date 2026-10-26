#!/usr/bin/env node
// Stage S1b check (docs/map-v2-stages.json, spec §9): lane traffic, sidewalk peds and the population on the
// classic grid, run headless.
//   node tools/s1b_traffic_test.mjs [minutes=10] [seed=1]
// It plays the grid world for `minutes` of game time at 60 Hz with Kimchi standing at the villa, scaring
// people off the pavement every few seconds, and checks what the browser soak (KC3.soak + window.KCSTATS)
// reports: at most 1% of car samples stopped for over 5 s, a mean traffic speed of at least 6 m/s, no two
// traffic cars closer than 3 m outside the junctions, and nobody left standing on a road after a flee. It also
// checks that cars follow their lanes and turn on the curved connectors, that crossing movements (and opposing
// turns that pass too close) never share a junction and no two cars come within 20 cm of touching there, that
// followers keep the IDM-lite 1.2 s time gap and stop short of a leader stopped dead, that people walk along
// their paths, that a carjack at speed keeps the car's momentum and a carjacking spree leaves only 3 cars
// lying about, that writes to c.ai.speed are honoured, and what a frame of updateWorld costs. The browser-only modules entities.js imports (ui, audio) are stubbed.
// Exits 1 if any check fails.
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MINUTES = Number(process.argv[2] || 10), SEED = Number(process.argv[3] || 1);

const STUBS = {
  'ui.js': 'export const toast = () => {};',
  'audio.js': 'const f = () => {}; export const sfx = new Proxy({}, { get: () => f }); export const audio = {};',
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
globalThis.Image = class { set src(v) {} };

// a seeded Math.random, so a failure can be replayed
let s = SEED * 2654435761 >>> 0;
Math.random = () => {
  s = (s + 0x6D2B79F5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const u = f => pathToFileURL(path.join(ROOT, 'src', f)).href;
const world = await import(u('world.js'));
world.generate();
const { G } = await import(u('state.js'));
const ent = await import(u('entities.js'));
const traffic = await import(u('sim/traffic.js'));
const { roads, places, tileAtPx, ROAD, WALK, BOUNDS, PX_PER_M: M } = world;
const { CAR_TYPES } = await import(u('data.js'));

let failed = 0, passed = 0;
const check = (ok, msg) => { if (ok) passed++; else { failed++; console.log('  FAIL ' + msg); } };
const info = msg => console.log('  ' + msg);
const ai = () => G.cars.filter(c => c.ai);

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
const civ = () => G.peds.filter(p => !p.role);

// ---------- 1. spawning ----------
console.log(`s1b: grid world, ${roads.lanes.length} lanes, ${roads.conns.length} connectors, ${roads.walks.paths.length} walk paths; seed ${SEED}`);
const home = places.home.foot;
Object.assign(G.player, { x: home.x, y: home.y, car: null, dead: false });
G.mode = 'play';
ent.spawnWorld();
check(ai().length === 24, `24 traffic cars at the start, got ${ai().length}`);
check(civ().length === 46, `46 people at the start, got ${civ().length}`);
check(civ().every(p => p.walk && tileAtPx(p.x, p.y) === WALK), 'every person starts on a sidewalk (a WALK tile)');
check(G.cars.filter(c => c.locked).length === 7, 'the 7 dealer display cars are there');
const pt = {};
const offLane = ai().filter(c => { roads.lanePoint(c.ai.lane, c.ai.s, pt); return Math.hypot(pt.x - c.x, pt.y - c.y) > 1; });
check(!offLane.length, `every traffic car sits on its lane polyline (${offLane.length} off)`);
check(ai().every(c => tileAtPx(c.x, c.y) === ROAD), 'every traffic car is on a ROAD tile');

// ---------- 2. the soak ----------
console.log(`soak: ${MINUTES} min of game time at 60 Hz`);
traffic.resetTrafficStats();
const dt = 1 / 60, frames = Math.round(MINUTES * 60 / dt);
let ms = 0, worst = 0, turnsDone = 0, maxTurnRate = 0, clashes = 0, offLaneCount = 0, scares = 0, crossings = 0, runOver = 0;
let boxNear = 0, boxMin = Infinity, minHeadway = Infinity, follows = 0, crab = 0;
const lastPed = new Map();
const fled = new Set(), back = new Set(), crossing = new Set();
const walks = roads.walks.paths;
const lastConn = new Map(), lastA = new Map();
const nextScare = { t: 5 };
let t = 0;
for (let f = 0; f < frames; f++) {
  t += dt;
  // every 5 s something frightens the people round a random sidewalk spot: a honk, a fight, a car
  if (t >= nextScare.t) {
    nextScare.t = t + 5;
    const near = civ().filter(p => p.state === 'walk');
    const v = near[Math.floor(Math.random() * near.length)];
    if (v) {
      scares++;
      for (const p of civ()) {
        if (Math.hypot(p.x - v.x, p.y - v.y) > 230 || p.state !== 'walk') continue;
        if (Math.random() < 0.3) ent.hurtPed(p, 10, { knock: true, vx: (Math.random() - 0.5) * 300, vy: (Math.random() - 0.5) * 300 });
        else { p.state = 'flee'; p.t = 1.6 + Math.random() * 5; }
      }
      // the fright comes from where Kimchi is; then he goes back to the villa
      Object.assign(G.player, { x: v.x + 40, y: v.y });
    }
  } else if (G.player.x !== home.x) Object.assign(G.player, { x: home.x, y: home.y });

  const t0 = performance.now();
  ent.updateWorld(dt);
  const el = performance.now() - t0;
  ms += el; worst = Math.max(worst, el);

  // junction checks: the connectors in use never cross one another (ghosts aside)
  const used = [];
  for (const c of ai()) {
    const a = c.ai;
    if (a.conn >= 0) {
      if (lastConn.get(c) !== a.conn) { lastConn.set(c, a.conn); if (roads.conns[a.conn].turn !== 's') turnsDone++; }
      if (a.ghost <= 0 && !a.forced) used.push(a.conn);   // ghosts may cross anything
    } else lastConn.delete(c);
    if (lastA.has(c)) maxTurnRate = Math.max(maxTurnRate, Math.abs(((c.a - lastA.get(c) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) / dt);
    lastA.set(c, c.a);
    if (f % 30 === 0 && a.conn < 0 && a.lcT <= 0) { roads.lanePoint(a.lane, a.s, pt); if (Math.hypot(pt.x - c.x, pt.y - c.y) > 1) offLaneCount++; }
  }
  for (let i = 0; i < used.length; i++) for (let j = i + 1; j < used.length; j++) {
    const K = traffic.junctionConflicts(used[i]);
    for (let k = 0; k < K.length; k++) if (K[k] === used[j]) clashes++;
  }
  // in the junctions too, no two cars (ghosts and what they pass through aside) come within 20 cm of
  // touching
  const cs = ai().filter(c => c.ai.ghost <= 0 && !c.ai.forced);
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
    const a = cs[i], b = cs[j];
    if ((a.ai.conn < 0 && b.ai.conn < 0) || a.ai.through === b || b.ai.through === a) continue;
    const d = Math.hypot(a.x - b.x, a.y - b.y) / M;
    if (d > 10) continue;
    if (touching(a, b, 0.1 * M)) boxNear++;
    boxMin = Math.min(boxMin, d);
  }
  // the time gap a follower keeps at 6 m/s or more (bumper to bumper over its speed)
  if (f % 30 === 0) {
    for (const a of cs) {
      if (a.ai.conn >= 0 || a.ai.speed < 6 * M) continue;
      let lead = null;
      for (const b of cs) if (b !== a && b.ai.conn < 0 && b.ai.lane === a.ai.lane && b.ai.s > a.ai.s && (!lead || b.ai.s < lead.ai.s)) lead = b;
      if (!lead) continue;
      const gap = lead.ai.s - a.ai.s - (CAR_TYPES[a.type].len + CAR_TYPES[lead.type].len) / 2;
      if (gap > 60 * M) continue;
      follows++;
      minHeadway = Math.min(minHeadway, gap / a.ai.speed);
    }
  }
  // people: who ended up on a road in a fright, who got back to a sidewalk, who crossed at a crosswalk
  for (const p of civ()) {
    if ((p.state === 'flee' || p.state === 'knocked') && tileAtPx(p.x, p.y) === ROAD) fled.add(p);
    if (fled.has(p) && p.state === 'walk' && p.walk) back.add(p);
    const onCross = p.state === 'walk' && p.walk && walks[p.walk.path].cross;
    if (onCross && !crossing.has(p)) { crossing.add(p); crossings++; } else if (!onCross) crossing.delete(p);
    if (onCross) for (const c of ai()) if (c.ai.ghost <= 0 && !c.ai.forced && !c.ai.through && Math.hypot(c.x - p.x, c.y - p.y) < 1.2 * M) runOver++;
    // walking along a straight path (the pavements and crosswalks, not the short corner arcs), a person moves
    // along it: drifting to their side of the pavement turns the walk (the 3D body faces where it moves) by
    // only a few degrees
    const was = lastPed.get(p);
    if (was && p.walk && p.state === 'walk' && was.path === p.walk.path && was.dir === p.walk.dir && walks[p.walk.path].len > 3 * M) {
      const P = walks[p.walk.path], dx = p.x - was.x, dy = p.y - was.y, d = Math.hypot(dx, dy);
      if (d > 0.1 && d < 0.1 * M) {             // (a faster move was a push, not a step)
        const k = Math.max(1, Math.min(P.n - 1, P.s.findIndex(v => v >= p.walk.s)));
        const tx = (P.pts[2 * k] - P.pts[2 * k - 2]) * p.walk.dir, ty = (P.pts[2 * k + 1] - P.pts[2 * k - 1]) * p.walk.dir;
        crab = Math.max(crab, Math.abs(Math.atan2(dx * ty - dy * tx, dx * tx + dy * ty)));
      }
    }
    lastPed.set(p, p.walk && p.state === 'walk' ? { x: p.x, y: p.y, path: p.walk.path, dir: p.walk.dir } : null);
  }
}
const st = traffic.trafficStats();
info(`stats ${JSON.stringify(st)}`);
info(`updateWorld: ${(ms / frames).toFixed(3)} ms a frame on average, worst ${worst.toFixed(2)} ms; ${turnsDone} turns taken; ${scares} frights`);
check(st.stuckPct <= 1, `at most 1% of car samples stopped for over 5 s (got ${st.stuckPct}%)`);
check(st.meanSpeed >= 6, `mean traffic speed at least 6 m/s (got ${st.meanSpeed})`);
check(st.closePairs === 0, `no traffic pair closer than 3 m outside the junctions (${st.closePairs} close samples, min ${st.minGap} m)`);
check(st.pedsOnRoad === 0, `nobody standing on a road after a flee (peak ${st.pedsOnRoad}, ${st.pedOnRoadSamples} samples)`);
check(fled.size >= 20 && back.size >= fled.size - 2, `people frightened onto a road walk back to a sidewalk (${back.size} of ${fled.size})`);
check(crossings > 50, `people cross at the crosswalks (${crossings} crossings)`);
info(`people: ${crossings} crosswalk crossings, ${fled.size} frightened onto a road; worst angle between a step and the path ${(crab * 180 / Math.PI).toFixed(1)}°`);
check(crab * 180 / Math.PI < 15, `people walk along their path, not crabbing across it (worst ${(crab * 180 / Math.PI).toFixed(1)}°)`);
check(runOver === 0, `traffic never drives through someone on a crosswalk (${runOver} frames)`);
check(clashes === 0, `crossing connectors (and opposing turns passing too close) are never used at once (${clashes} frames)`);
check(boxNear === 0, `no two cars within 20 cm of touching in the junctions either (${boxNear} samples; closest centres ${boxMin.toFixed(2)} m apart)`);
check(follows > 10 * MINUTES && minHeadway >= 0.8, `followers at 6 m/s or more keep the IDM-lite time gap (closest ${minHeadway.toFixed(2)} s over ${follows} samples)`);
check(turnsDone > 200, `cars turn left and right on the curved connectors (${turnsDone} turns)`);
check(st.turningPct > 1, `some of the time is spent turning on connectors (${st.turningPct}%)`);
check(maxTurnRate < 3, `headings change smoothly (fastest ${maxTurnRate.toFixed(2)} rad/s)`);
check(offLaneCount === 0, `cars stay on their lane polylines (${offLaneCount} samples off)`);
check(ai().length >= 22, `traffic stays near 24 cars (${ai().length})`);
check(civ().length >= 44 && civ().length <= 48, `people stay near 46 (${civ().length})`);
check(ms / frames < 0.5, `updateWorld costs under 0.5 ms a frame (${(ms / frames).toFixed(3)} ms)`);
const lost = civ().filter(p => p.lost).length;
check(lost <= 2, `people find their way back to a sidewalk (${lost} lost)`);

// ---------- 3. carjack at speed keeps the momentum ----------
console.log('carjack');
let car = null;
for (let i = 0; i < 600 && !car; i++) { ent.updateWorld(dt); car = ai().find(c => c.ai.speed > 8 * M && c.ai.conn < 0 && !c.ai.ghost); }
check(!!car, 'a traffic car doing over 8 m/s');
if (car) {
  const v0 = car.ai.speed, a0 = car.a;
  Object.assign(G.player, { x: car.x, y: car.y + 30 });
  ent.enterCar(car);
  check(car.ai === null && G.player.car === car, 'the car is Kimchi\'s now');
  const v1 = Math.hypot(car.vx, car.vy), along = car.vx * Math.cos(a0) + car.vy * Math.sin(a0);
  check(Math.abs(v1 - v0) < 1 && along > 0.99 * v0, `it moves at its lane speed along its heading (${(v0 / M).toFixed(1)} m/s -> ${(v1 / M).toFixed(1)} m/s)`);
  ent.updatePlayer(dt, {});
  const v2 = Math.hypot(car.vx, car.vy);
  check(v2 > 0.95 * v0, `after a frame with no input it still rolls at ${(v2 / M).toFixed(1)} m/s`);
  G.player.car = null; Object.assign(G.player, { x: home.x, y: home.y });
  // the population replaces the taken car out of sight
  let n = 0;
  for (let i = 0; i < 60 * 5 && ai().length < 24; i++) { ent.updateWorld(dt); n = i; }
  check(ai().length === 24, `traffic is back to 24 cars ${(n * dt).toFixed(1)} s after the carjack (${ai().length})`);

  // a carjacking spree far from the villa: every taken car is replaced, and only the last 3 left about stay
  const left = () => G.cars.filter(c => c.traffic && !c.ai && !c.wreck);
  let jacked = 0;
  for (let i = 0; i < 60 * 60 && jacked < 6; i++) {
    ent.updateWorld(dt);
    const c = ai().find(c => Math.hypot(c.x - home.x, c.y - home.y) > 200 * M && c.ai.conn < 0);
    if (!c) continue;
    Object.assign(G.player, { x: c.x, y: c.y + 30 });
    ent.enterCar(c);
    G.player.car = null; Object.assign(G.player, { x: home.x, y: home.y });
    c.vx = c.vy = 0;
    jacked++;
  }
  for (let i = 0; i < 60 * 5; i++) ent.updateWorld(dt);
  const kept = left();
  const newest = kept.filter(c => c !== car).length;
  check(jacked === 6 && kept.length === 3 && newest >= 2 && ai().length === 24,
    `after ${jacked} more carjacks, 24 cars still drive and only the last 3 cars left about stay (${kept.length} left, ${ai().length} driving)`);
}

// ---------- a car stuck out of view goes ----------
{
  const far = ai().filter(c => Math.hypot(c.x - G.player.x, c.y - G.player.y) > 180 * M);
  const c = far[0];
  if (c) {
    c.ai.max = 0;                            // it stops where it is (a breakdown), and is not stuck behind anything
    const still0 = c.ai.speed < 0.5 * M ? c.ai.still : 0;   // (it may be standing already, at a junction)
    let gone = -1;
    for (let i = 0; i < 60 * 30 && gone < 0; i++) { ent.updateWorld(dt); if (!G.cars.includes(c)) gone = i * dt + still0; }
    for (let i = 0; i < 60; i++) ent.updateWorld(dt);
    check(gone > 25 && gone < 26 && ai().length === 24, `a traffic car stopped for over 25 s out of view is taken away and replaced (after ${gone.toFixed(1)} s stopped)`);
  } else check(false, 'no traffic car out of view');
}

// ---------- 4. external speed writes ----------
console.log('c.ai.speed writes');
{
  const c = ai().find(c => c.ai.speed > 6 * M && c.ai.conn < 0);
  if (c) {
    c.ai.speed = 0;                          // a bump (entities.carCollisions)
    const x0 = c.x, y0 = c.y;
    ent.updateWorld(dt);
    check(Math.hypot(c.x - x0, c.y - y0) < 2.5 * M * dt * dt + 0.01, 'a car whose speed was set to 0 starts again from rest');
    for (let i = 0; i < 60; i++) ent.updateWorld(dt);
    const v = c.ai?.speed ?? 0;
    c.ai.speed *= 0.5;                       // a gunshot (combat.applyHit)
    check(Math.abs(c.ai.speed - v * 0.5) < 1e-9 && Math.hypot(c.vx, c.vy) <= v + 1e-6, 'halving the speed takes effect');
    ent.updateWorld(dt);
    check(c.ai.speed <= v * 0.5 + 2.5 * M * dt + 1e-6, 'and the car carries on from the halved speed');
  } else check(false, 'no moving car to test speed writes on');
}

// ---------- 4b. a leader stopped dead (a bump sets its speed to 0) ----------
console.log('bumped leader');
{
  // a car is put in front of a moving one at the IDM-lite following distance (7 m + 1.2 s) and both drive on
  // for half a second; then the leader stops dead and stays stopped. The time gap is what lets the car behind stop
  // short of it. Tried on 3 cars.
  let tries = 0, worstGap = Infinity;
  for (let f = 0; f < 60 * 60 && tries < 3; f++) {
    ent.updateWorld(dt);
    const a = ai().find(c => c.ai.conn < 0 && c.ai.speed > 5.5 * M && c.ai.ghost <= 0 &&
      roads.lanes[c.ai.lane].len - c.ai.s > 10 * M + 1.7 * c.ai.speed);
    if (!a) continue;
    const L = roads.lanes[a.ai.lane], s0 = a.ai.s + (7 + (CAR_TYPES[a.type].len / M - 4.6) / 2) * M + 1.2 * a.ai.speed;
    if (G.cars.some(o => o !== a && o.ai && o.ai.lane === L.id && o.ai.s > a.ai.s)) continue;
    roads.lanePoint(L.id, s0, pt);
    const b = traffic.aiAttach(ent.makeCar('sedan', pt.x, pt.y, Math.atan2(pt.ty, pt.tx)), { lane: L.id, s: s0 }, { speed: a.ai.speed, f: a.ai.f });
    b.ai.max = a.ai.speed;
    G.cars.push(b);
    tries++;
    const len = (CAR_TYPES[a.type].len + CAR_TYPES[b.type].len) / 2;
    for (let i = 0; i < 60 * 4 && a.ai; i++) {
      if (i === 30) { b.ai.speed = 0; b.ai.max = 0; }     // the bump: stopped dead where it is, and held there
      ent.updateWorld(dt);
      if (a.ai && a.ai.lane === b.ai.lane && a.ai.conn < 0 && b.ai.conn < 0) worstGap = Math.min(worstGap, (b.ai.s - a.ai.s - len) / M);
    }
    G.cars = G.cars.filter(o => o !== b);
  }
  info(`${tries} leaders stopped dead; the closest the car behind came was ${worstGap.toFixed(2)} m bumper to bumper`);
  check(tries === 3 && worstGap >= 1, `the car behind a leader stopped dead stops short of it (${tries} cars, closest bumper gap ${worstGap.toFixed(2)} m)`);
}

// ---------- 5. a car parked in a lane ----------
console.log('blocked lane');
{
  const c = ai().find(c => c.ai.conn < 0 && roads.lanes[c.ai.lane].len - c.ai.s > 30 * M && c.ai.speed > 4 * M);
  if (c) {
    const L = roads.lanes[c.ai.lane];
    roads.lanePoint(L.id, c.ai.s + 18 * M, pt);
    const block = ent.makeCar('van', pt.x, pt.y, Math.atan2(pt.ty, pt.tx));
    G.cars.push(block);
    let minD = Infinity, ghosted = false, passedIt = false;
    for (let i = 0; i < 60 * 20 && c.ai; i++) {
      ent.updateWorld(dt);
      if (c.ai.ghost > 0) ghosted = true;
      if (!ghosted) minD = Math.min(minD, Math.hypot(c.x - block.x, c.y - block.y));
      if (c.ai.lane !== L.id || c.ai.conn >= 0) { passedIt = true; break; }
    }
    check(minD > 4 * M, `traffic stops short of a car parked in its lane (closest ${(minD / M).toFixed(1)} m)`);
    check(ghosted && passedIt, 'and after being stuck it ghosts past it rather than waiting for ever');
    G.cars = G.cars.filter(o => o !== block);
  } else check(false, 'no car to test a blocked lane with');
}

// ---------- Kimchi standing in a lane ----------
console.log('Kimchi in the road');
{
  // he steps out far enough ahead of a moving car for it to stop at its 7 m/s² with room to spare: 15 m, or
  // the braking distance plus 8 m for a faster car (and still on the car's own lane)
  const ahead = c => Math.max(15 * M, c.ai.speed * c.ai.speed / (2 * 7 * M) + 8 * M);
  const c = ai().find(c => c.ai.conn < 0 && c.ai.speed > 4 * M && roads.lanes[c.ai.lane].len - c.ai.s > Math.max(30 * M, ahead(c) + 5 * M));
  if (c) {
    roads.lanePoint(c.ai.lane, c.ai.s + ahead(c), pt);
    Object.assign(G.player, { x: pt.x, y: pt.y, car: null });
    let minD = Infinity, honked = false;
    for (let i = 0; i < 60 * 12; i++) {
      ent.updateWorld(dt);
      minD = Math.min(minD, Math.hypot(c.x - G.player.x, c.y - G.player.y));
      if (c.bubble) honked = true;
    }
    check(c.ai && c.ai.ghost <= 0 && !c.ai.through && minD > 3 * M, `a car waits for Kimchi standing in its lane, without ghosting through him (closest ${(minD / M).toFixed(1)} m)`);
    check(honked, 'and the driver honks at him');
    Object.assign(G.player, { x: home.x, y: home.y });
    for (let i = 0; i < 60 * 3; i++) ent.updateWorld(dt);
    check(c.ai && c.ai.speed > 1 * M, 'once he steps away the car drives on');
  } else check(false, 'no car to stand in front of');
}

// ---------- 6. respawned people ----------
console.log('respawnPed');
{
  let ok = 0, n = 0;
  for (let i = 0; i < 200; i++) {
    const p = ent.makePed(-1, -1);
    if (!ent.respawnPed(p)) continue;
    n++;
    if (p.walk && tileAtPx(p.x, p.y) === WALK && p.x >= BOUNDS.x0 && p.x < BOUNDS.x1 && p.y >= BOUNDS.y0 && p.y < BOUNDS.y1 &&
        Math.hypot(p.x - G.player.x, p.y - G.player.y) >= 1800) ok++;
  }
  check(n === 200 && ok === 200, `respawned people land on sidewalks inside BOUNDS, away from Kimchi (${ok} of ${n})`);
}

// ---------- 7. the stats hook for KC3.soak ----------
console.log('KCSTATS');
{
  check(typeof globalThis.KCSTATS === 'function' && typeof globalThis.KCSTATS().meanSpeed === 'number', 'window.KCSTATS() returns the traffic stats');
  let resets = 0;
  globalThis.KC3 = { soak: async () => 'done' };
  const keep = traffic.resetTrafficStats;
  ent.updateWorld(dt);
  check(globalThis.KC3.soak.kcStats === true, 'KC3.soak is wrapped once to start the stats with the soak');
  ent.updateWorld(dt);
  const before = globalThis.KCSTATS().sec;
  await globalThis.KC3.soak(1);
  check(globalThis.KCSTATS().sec < before, `a soak resets the stats window (${before} s -> ${globalThis.KCSTATS().sec} s)`);
  void resets; void keep;
  delete globalThis.KC3;
}

console.log(failed ? `s1b: ${failed} failed, ${passed} passed` : `s1b: ok (${passed} checks)`);
process.exit(failed ? 1 : 0);
