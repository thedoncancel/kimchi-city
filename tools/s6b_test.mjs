#!/usr/bin/env node
// Stage S6b check, part 1 (docs/map-v2-stages.json, spec §10 and §11): cars on hills, in the air and in a
// skid, as cars.js syncCar draws them, driven by the v2 sim (PHYS.v2, main3d's CFG) on the real Kimchi Key map.
//   node tools/s6b_test.mjs            (S3B_LOW=1 builds the phone tier's materials)
//  1. The grid: given one height under the car (as main3d passes it on the grid), syncCar draws every frame
//     exactly as it did before S6b (a reference copy of that code below), level and eased onto the height.
//  2. Wheels on the ground (the KC3 metric, cars.js wheelGap): driving the switchbacks down and up, Heights
//     Drive, Crest Road and the North Causeway with the built-in cars and the model cars, no wheel floats over
//     or sinks into the ground by more than 5 cm on any frame the car is on the ground (not v.free: in the
//     air, or over a lip the sim has it leaving the ground by); nor does a traffic car moved
//     along its lane (no physics). The level car eased onto the height under its middle (before S6b) is
//     reported for comparison.
//  3. Airtime: over j_crest at 30-45 m/s the body flies at the sim's c.gy, with no jump in height or pitch at
//     take-off or touchdown; the wheels hang in the air; landing squashes the body, which comes back up; the
//     wheels are on the ground again within 0.25 s.
//  4. Skids: a pose jump no car could drive (police.js wriggle: 1.5 m and 1 rad in one frame) is drawn as a
//     slide that catches up within 0.45 s, never more than 0.2 rad or 0.25 m a frame, with no wheel spin or
//     steering from it; a move past 4 m is shown at once; and the real police.js wriggle of a cruiser held
//     in place (as tools/f2_nav_test holds it).
//  5. Kerbs: creeping up a 16 cm kerb the wheel climbs it over a few frames, not in one.
//  6. The headlight pool lies on the road ahead at the foot of a hill and over a crest.
//  7. A recycled view leaves its hill behind: level, wheels at rest, pool at its place, skid and air cleared.
//  8. main3d's v2 camera and foot helpers (taken from its source, run against the real world): on drives down
//     the switchbacks, down Heights Drive and over Crest Road the chase camera's near plane never goes into
//     the terrain as drawn, the ground or a building, and nothing stands between it and the car, also with
//     the camera held looking back uphill or across the hillside, where it pulls in and lifts; the shoulder
//     camera, at 12 headings every 12 m of the switchbacks, likewise; Kimchi's feet follow a slope exactly
//     and ease up a kerb (and on the grid ease as before).
// Exits 1 if any check fails.
import { src, check, section, note, done, quiet } from './s3b_env.mjs';
globalThis.KC_WORLD = 'v2';
const L = await import('./s6a_lib.mjs');
const game = await L.loadGame();
const { ent, world, pol } = game;
if (world.KIND !== 'v2') {
  console.log('s6b: world-v2 is not READY, nothing to check');
  process.exit(0);
}
Object.assign(ent.CFG, L.CFG_3D);
const CARS = await import(src('src/3d/cars.js'));
const THREE = await import('three');
const { M, DT } = L;
const S = 1 / M;
const ground = world.groundY;
const wrap = L.wrap;
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };
const cm = (m) => (m * 100).toFixed(1) + ' cm';

// ---------- the driver ----------

// The tightest radius (m) of path P over the len m after point j (three points 6 m apart).
function tightestAhead(P, j, len) {
  let r = Infinity;
  for (let k = j; k < P.length && P[k].s - P[j].s < len * M; k++) {
    let a = k, b = k;
    while (a > 0 && P[k].s - P[a].s < 6 * M) a--;
    while (b < P.length - 1 && P[b].s - P[k].s < 6 * M) b++;
    if (a === k || b === k) continue;
    const x1 = P[k].x - P[a].x, y1 = P[k].y - P[a].y, x2 = P[b].x - P[k].x, y2 = P[b].y - P[k].y;
    const turn = Math.abs(Math.atan2(x1 * y2 - y1 * x2, x1 * x2 + y1 * y2));
    if (turn > 1e-4) r = Math.min(r, (Math.hypot(x1, y1) + Math.hypot(x2, y2)) / 2 / M / turn);
  }
  return r;
}

// Drive path P in a new car of `type` at up to vmax m/s (bends at 70% of the grip), syncing a view each frame.
// each(f, c, v, inp) runs after the view is synced. Returns { c, v, frames }.
function drive(type, P, vmax, each, { v0 = 0, maxT = 150, dts = [DT] } = {}) {
  const c = L.soloCar(game, type, P[0].x, P[0].y, Math.atan2(P[1].y - P[0].y, P[1].x - P[0].x), v0 * M);
  const v = CARS.makeCarView(type, '#3366cc');
  let j = 0, f = 0;
  for (let t = 0; t < maxT; f++) {
    const dt = dts[f % dts.length];
    t += dt;
    j = L.trackPath(P, c.x, c.y, j).j;
    if (j >= P.length - 3 && !(c.air > 0)) break;
    const want = Math.min(vmax, Math.sqrt(0.7 * 2 * 9.81 * tightestAhead(P, j, 60)));
    const fwd = c.vx * Math.cos(c.a) + c.vy * Math.sin(c.a);
    const inp = L.driveAlong(c, P, Math.min(j, P.length - 2), want * M, 10);
    if (fwd > want * M * 1.05) { inp.up = false; inp.down = true; }
    ent.updatePlayer(dt, inp);
    CARS.setCarLook(v, c, false);
    CARS.syncCar(v, c, dt, ground, inp.steer, true);
    each?.(f, c, v, inp);
  }
  return { c, v, frames: f };
}
const path = (x, z, hx, hz, ahead, off) => L.roadPath(world.roads, x * M, z * M, Math.atan2(hz - z, hx - x), 0, ahead, off);
// (the last two at uneven frame times, as a browser has them)
const UNEVEN = [1 / 60, 1 / 20, 1 / 30, 1 / 45];
const RUNS = [
  { name: 'switchbacks down', P: () => path(378, 312, 362, 326, 640, 1.8), v: 25 },
  { name: 'switchbacks up', P: () => path(384, 588, 376, 565, 640, 1.8), v: 25 },
  { name: 'Heights Drive down', P: () => path(390, 291, 420, 287, 320, 1.8), v: 30 },
  { name: 'Crest Road (j_crest)', P: () => path(812, 300, 818, 288, 520, 1.8), v: 37.5 },
  { name: 'North Causeway', P: () => path(1235, 374, 1300, 352, 520, 5.1), v: 50 },
  { name: 'Crest Road, uneven frames', P: () => path(812, 300, 818, 288, 520, 1.8), v: 37.5, dts: UNEVEN },
  { name: 'switchbacks, uneven frames', P: () => path(378, 312, 362, 326, 640, 1.8), v: 25, dts: UNEVEN },
];

// ---------- 1. the grid's way, unchanged ----------

// syncCar's pose before S6b, for one height under the car (kept here as the reference)
function oldSync(v, c, dt, groundH, steer) {
  const x = c.x * S, z = c.y * S, fx = Math.cos(c.a), fz = Math.sin(c.a);
  let vf = 0, av = 0;
  if (v.init && dt > 0) {
    vf = ((x - v.px) * fx + (z - v.pz) * fz) / dt;
    let da = c.a - v.pa;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    av = da / dt;
  } else v.y = groundH;
  v.px = x; v.pz = z; v.pa = c.a; v.init = true;
  v.y += (groundH - v.y) * Math.min(1, dt * 10);
  const pos = [x, v.y, z], rotY = -c.a;
  v.spin += vf * dt / v.R;
  const sv = steer != null ? -steer * 0.42 : -Math.max(-1, Math.min(1, av * 0.7)) * 0.42;
  v.steer += (sv - v.steer) * Math.min(1, dt * 10);
  const acc = (vf - v.vf) / Math.max(dt, 1e-3);
  v.vf += (vf - v.vf) * Math.min(1, dt * 8);
  const rollT = Math.max(-0.075, Math.min(0.075, -av * v.vf * 0.012));
  const pitchT = Math.max(-0.045, Math.min(0.045, acc * 0.0025));
  v.roll += (rollT - v.roll) * Math.min(1, dt * 6);
  v.pitch += (pitchT - v.pitch) * Math.min(1, dt * 5);
  return { vf, pos, rotY, spin: v.spin, steer: v.steer, roll: v.roll, pitch: v.pitch };
}
section('1. the grid: one height under the car, drawn as before');
{
  let frames = 0, same = 0, first = '';
  for (const type of ['sedan', 'van', 'bolide']) {
    const v = CARS.makeCarView(type, '#cc3333'), ref = { init: false, spin: 0, steer: 0, roll: 0, pitch: 0, vf: 0, px: 0, pz: 0, pa: 0, y: 0, R: v.R };
    const c = { type, x: 3000, y: 2000, a: 0.4, vx: 0, vy: 0, color: '#cc3333', brake: false, wreck: false, hp: 100 };
    for (let f = 0; f < 900; f++) {
      const dt = f % 97 === 50 ? 0.05 : f % 31 === 7 ? 1 / 30 : 1 / 60;
      const sp = 14 * M * (0.5 + 0.5 * Math.sin(f / 60)), turn = 0.9 * Math.sin(f / 45);
      c.a += turn * dt; c.vx = Math.cos(c.a) * sp; c.vy = Math.sin(c.a) * sp;
      c.x += c.vx * dt; c.y += c.vy * dt;
      const h = 0.16 * (Math.floor(f / 120) % 2) + 0.02 * Math.sin(f / 30), steer = f % 300 < 150 ? null : Math.sin(f / 20);
      const r = oldSync(ref, c, dt, h, steer);
      const vf = CARS.syncCar(v, c, dt, h, steer, true);
      const g = v.group;
      const ok = vf === r.vf && g.position.x === r.pos[0] && g.position.y === r.pos[1] && g.position.z === r.pos[2] && g.rotation.y === r.rotY
        && g.rotation.x === 0 && g.rotation.z === 0 && v.spin === r.spin && v.steer === r.steer && v.chassis.rotation.x === r.roll
        && v.chassis.rotation.z === r.pitch && v.wheels.every(w => w.position.y === v.R && w.rotation.z === -r.spin);
      frames++;
      if (ok) same++; else if (!first) first = `${type} frame ${f}`;
    }
  }
  check('syncCar with one height draws exactly as before S6b (every frame, three car types)', same === frames, `${same} of ${frames}; first difference at ${first}`);
}

// ---------- 2. wheels on the ground ----------

const GAP = 0.05;
async function wheelRuns(stage) {
  section(`2. ${stage}: wheels on the ground (the KC3 metric, cars.js wheelGap)`);
  const types = stage === 'built-in' ? ['bolide', 'van'] : ['bolide', 'sedan', 'police'];
  for (const run of RUNS) {
    for (const type of types) {
      const P = run.P();
      const gaps = [], old = [], out = [0, 0, 0, 0];
      let air = 0, yOld = null;
      const { c, frames } = drive(type, P, run.v, (f, c, v) => {
        // what the level car eased onto the height under its middle (before S6b) would show
        const gc = ground(c.x, c.y);
        yOld = yOld == null ? gc : yOld + (gc - yOld) * Math.min(1, DT * 10);
        if (v.free) { air++; return; }
        CARS.wheelGap(v, ground, out);
        for (const e of out) gaps.push(Math.abs(e));
        const ca = Math.cos(c.a), sa = Math.sin(c.a);
        for (let i = 0; i < 4; i++) {
          const lx = v.spots[i * 2], lz = v.spots[i * 2 + 1];
          old.push(Math.abs(yOld - ground(c.x + (lx * ca - lz * sa) * M, c.y + (lx * sa + lz * ca) * M)));
        }
      }, { dts: run.dts });
      const worst = Math.max(...gaps);
      check(`${stage} ${type}, ${run.name}: no wheel off the ground by more than 5 cm`, worst <= GAP && frames > 300,
        `worst ${cm(worst)} over ${frames} frames`);
      check(`${stage} ${type}, ${run.name}: the drive got through (${(c.x / M).toFixed(0)}, ${(c.y / M).toFixed(0)}), no damage`, c.hp >= 99);
      note(`${type.padEnd(7)} ${run.name.padEnd(22)} ${frames} frames (${air} off the ground): wheel gap mean ${cm(gaps.reduce((a, b) => a + b, 0) / gaps.length)}, p99 ${cm(pct(gaps, 0.99))}, worst ${cm(worst)}; before S6b p99 ${cm(pct(old, 0.99))}, worst ${cm(Math.max(...old))}`);
    }
  }
}
await wheelRuns('built-in');

section('2b. a traffic car moved along its lane (no physics) on the switchbacks and the Loop over the pass');
{
  const R = world.roads;
  for (const [name, x, z] of [['switchbacks', 362, 326], ['Loop at the pass', 780, 322]]) {
    const q = R.nearestLane(x * M, z * M, 0);
    const lane = R.lanes[q.lane], v = CARS.makeCarView('sedan', '#448844');
    const c = { type: 'sedan', x: 0, y: 0, a: 0, vx: 0, vy: 0, color: '#448844', brake: false, wreck: false, hp: 100, ai: {} };
    const gaps = [], out = [0, 0, 0, 0], p = {};
    for (let s = 0; s < lane.len; s += 12 * M * DT) {
      R.lanePoint(q.lane, s, p);
      c.x = p.x; c.y = p.y; c.a = p.a ?? Math.atan2(p.ty, p.tx); c.vx = Math.cos(c.a) * 12 * M; c.vy = Math.sin(c.a) * 12 * M;
      CARS.syncCar(v, c, DT, ground, null, true);
      CARS.wheelGap(v, ground, out);
      for (const e of out) gaps.push(Math.abs(e));
    }
    const worst = Math.max(...gaps);
    check(`traffic car on the ${name} lane: no wheel off the ground by more than 5 cm`, worst <= GAP && gaps.length > 200, `worst ${cm(worst)}`);
    note(`${name}: lane ${q.lane}, ${(lane.len / M).toFixed(0)} m, wheel gap p99 ${cm(pct(gaps, 0.99))}, worst ${cm(worst)}`);
  }
}

// ---------- 3. airtime ----------

// the height under the car's middle of the plane through the ground its four wheels followed (cars.js seat)
function planeY(v) {
  const W = v.wh, P = v.spots, b = ((W[0] + W[6]) - (W[12] + W[18])) / 2 / (P[0] - P[4]);
  return (W[12] + W[18]) / 2 - b * P[4];
}

section('3. airtime over j_crest');
{
  const j = world.activities.find(a => a.type === 'jump' && a.id === 'j_crest');
  for (const V of [30, 37.5, 45]) {
    const P = L.roadPath(world.roads, j.x, j.y, j.a, 70, 120, 0);
    let prev = null, maxJump = 0, maxPitch = 0, offMax = 0, off0 = 0, offLate = 0, droop = Infinity, flights = 0, wasAir = false, landF = -1;
    let squashMin = 0, squashBack = null, after = 0, afterF = 0, cAirMax = 0;
    const out = [0, 0, 0, 0];
    drive('bolide', P, V, (f, c, v) => {
      const air = c.air > 0;
      if (air) {
        cAirMax = Math.max(cAirMax, c.air);
        // the body flies at c.gy plus the offset it took off with (the plane under the wheels against the
        // sim's body point), fading; or on the ground under it, when that is higher
        offMax = Math.max(offMax, Math.min(Math.abs(v.y - c.gy - v.off), Math.abs(v.y - planeY(v))));
        if (!wasAir) off0 = Math.max(off0, Math.abs(v.off));
        if (c.air > 0.4) offLate = Math.max(offLate, Math.abs(v.off));
        droop = Math.min(droop, ...v.wheels.map(w => w.position.y - v.R));
      }
      if (prev) {
        // the drawn height may change by what the body's vertical speed moves it, plus 3 cm (a crest, a lip)
        const vh = Math.max(Math.abs(c.vh || 0), Math.abs(prev.vh || 0)) * DT + 0.03;
        maxJump = Math.max(maxJump, Math.abs(v.y - prev.y) - vh);
        maxPitch = Math.max(maxPitch, Math.abs(v.tp - prev.tp));
      }
      if (wasAir && !air) { flights++; landF = f; }
      if (landF >= 0 && f - landF <= 36) {
        squashMin = Math.min(squashMin, v.chassis.position.y);
        if (f - landF >= 15) { after = Math.max(after, Math.abs(CARS.wheelGap(v, ground, out))); afterF++; }
      }
      if (landF >= 0 && squashBack == null && f > landF && v.chassis.position.y === 0) squashBack = (f - landF) / 60;
      wasAir = air;
      prev = { y: v.y, tp: v.tp, vh: c.vh };
    }, { v0: V, maxT: 12 });
    check(`${V} m/s: one flight (${cAirMax.toFixed(2)} s in the air)`, flights >= 1 && cAirMax > 0.4);
    check(`${V} m/s: the body flies at the sim's c.gy plus its take-off offset (within 1 mm)`, offMax <= 0.001, cm(offMax));
    check(`${V} m/s: ... an offset that fades (${cm(off0)} at take-off, at most 8 cm after 0.4 s)`, offLate <= 0.08, cm(offLate));
    check(`${V} m/s: no jump of the drawn height at take-off or touchdown (beyond its vertical speed + 3 cm)`, maxJump <= 0.005, cm(maxJump));
    check(`${V} m/s: the pitch changes smoothly (at most 0.07 rad a frame, 4 rad/s, as the ramp kicks it)`, maxPitch <= 0.07, maxPitch.toFixed(3) + ' rad');
    check(`${V} m/s: the wheels hang in the air`, droop < -0.03, cm(droop));
    check(`${V} m/s: landing squashes the body, which comes back up within 0.6 s`, squashMin < -0.03 && squashBack != null && squashBack <= 0.6,
      `sank ${cm(-squashMin)}, back after ${squashBack} s`);
    check(`${V} m/s: wheels back on the ground within 0.25 s of touching down`, afterF > 0 && after <= GAP, cm(after));
  }
}

// ---------- 4. skids ----------

section('4. skids: a jump of the sim pose is drawn as a slide');
{
  const v = CARS.makeCarView('police', '#ffffff'), p = path(1060, 560, 1100, 560, 40, 2)[0];
  const c = { type: 'police', x: p.x, y: p.y, a: 0.2, vx: 0, vy: 0, color: '#ffffff', brake: false, wreck: false, hp: 100 };
  for (let f = 0; f < 30; f++) CARS.syncCar(v, c, DT, ground, null, true);
  const spin0 = v.spin;
  c.x += 24; c.y -= 4; c.a += 1;   // wriggle: set down up to 1.5 m away, turned by up to 1 rad, stopped
  let maxA = 0, maxP = 0, prevA = v.group.rotation.y, prevX = v.group.position.x, prevZ = v.group.position.z, caught = null, maxSteer = 0;
  for (let f = 1; f <= 60; f++) {
    CARS.syncCar(v, c, DT, ground, null, true);
    const g = v.group;
    maxA = Math.max(maxA, Math.abs(wrap(g.rotation.y - prevA)));
    maxP = Math.max(maxP, Math.hypot(g.position.x - prevX, g.position.z - prevZ));
    maxSteer = Math.max(maxSteer, Math.abs(v.steer));
    prevA = g.rotation.y; prevX = g.position.x; prevZ = g.position.z;
    if (caught == null && Math.abs(wrap(g.rotation.y + c.a)) < 0.01 && Math.hypot(g.position.x - c.x * S, g.position.z - c.y * S) < 0.03) caught = f / 60;
  }
  check('a 1.5 m, 1 rad jump: at most 0.2 rad of turn and 0.25 m of slide a frame', maxA <= 0.2 && maxP <= 0.25, `${maxA.toFixed(3)} rad, ${cm(maxP)}`);
  check('... caught up (3 cm, 0.01 rad) within 0.45 s', caught != null && caught <= 0.45, `${caught} s`);
  check('... with no wheel spin and no steering from it (under 0.1 rad)', Math.abs(v.spin - spin0) < 0.1 && maxSteer < 0.1, `spin ${(v.spin - spin0).toFixed(3)}, steer ${maxSteer.toFixed(3)}`);
  c.x += 10 * M;
  CARS.syncCar(v, c, DT, ground, null, true);
  check('a 10 m move is shown at once', Math.abs(v.group.position.x - c.x * S) < 1e-9 && v.skidM === 0);
  // driving is not a jump: a car on the handbrake at full lock and 40 m/s on the Loop draws its pose exactly
  const d = drive('papaya', path(1235, 374, 1300, 352, 300, 5.1), 45, null);
  check('a fast drive is drawn where the sim has it (no skid offset)', d.v.skidM === 0 && Math.abs(d.v.group.position.x - d.c.x * S) < 1e-9);
}

section('4b. the real police.js wriggle: a cruiser held in place until it wriggles free');
{
  // held still with its foot down, aiming 30 m off to the side, as tools/f2_nav_test holds it: after four
  // back-ups wriggle sets it down turned toward its aim (spec §12.2, F2)
  const p = path(1060, 560, 1100, 560, 40, 2)[0], w = L.soloCar(game, 'police', p.x, p.y, 0, 0);
  w.police = true;
  const v = CARS.makeCarView('police', '#ffffff');
  let simMax = 0, drawnMax = 0, slideMax = 0, at = null, prev = null;
  for (let f = 0; f < 12 * 60 && (at == null || f < at + 60); f++) {
    const x = w.x, y = w.y, a = w.a;
    pol.steerTo(w, DT, w.x + 5 * M, w.y - 30 * M, {});
    const turn = Math.abs(wrap(w.a - a));
    if (at == null && (turn > 0.3 || Math.hypot(w.x - x, w.y - y) > 3 + Math.hypot(w.vx, w.vy) * DT * 1.5)) { at = f; simMax = turn; }
    else if (at == null) { w.x = x; w.y = y; w.a = a; }
    CARS.syncCar(v, w, DT, ground, null, true);
    const g = v.group;
    if (prev) {
      drawnMax = Math.max(drawnMax, Math.abs(wrap(g.rotation.y - prev.a)));
      slideMax = Math.max(slideMax, Math.hypot(g.position.x - prev.x, g.position.z - prev.z));
    }
    prev = { a: g.rotation.y, x: g.position.x, z: g.position.z };
  }
  if (check('the cruiser wriggled', at != null, 'never')) {
    note(`after ${(at / 60).toFixed(1)} s the sim turned it ${simMax.toFixed(2)} rad in one frame`);
    check('the drawn cruiser turns at most 0.12 rad and slides at most 0.25 m a frame through it', drawnMax <= 0.12 && slideMax <= 0.25,
      `${drawnMax.toFixed(3)} rad, ${cm(slideMax)}`);
    check('... and is where the sim has it a second later', Math.abs(wrap(v.group.rotation.y + w.a)) < 1e-6 && v.skidM === 0);
  }
}

// ---------- 5. kerbs ----------

section('5. kerbs: creeping up a 16 cm kerb');
{
  // a boulevard's right lanes 6 m from the kerb, heading 45 degrees at it (as tools/s6a_drive_test finds it)
  let spot = null;
  for (const e of world.roads.edges) {
    if (spot || e.cls !== 'blvd' || e.n < 20) continue;
    for (let i = 5; i < e.n - 5 && !spot; i += 3) {
      const tx = e.tx[i], ty = e.ty[i], rx = -ty, ry = tx, d = e.halfW - 4 * M;
      const x = e.x[i] + rx * d, y = e.y[i] + ry * d, a = Math.atan2(ty, tx) + Math.PI / 4;
      let ok = world.surfaceAt(e.x[i] + rx * (e.halfW + 1.5 * M), e.y[i] + ry * (e.halfW + 1.5 * M)) === world.WALK;
      for (let k = 0; k <= 12 && ok; k++) if (world.blockedCarPx(x + Math.cos(a) * k * M, y + Math.sin(a) * k * M)) ok = false;
      if (ok) spot = { x, y, a };
    }
  }
  if (!check('found a kerb to drive up', !!spot)) { /* nothing more */ } else {
    const v = CARS.makeCarView('sedan', '#888888');
    const c = { type: 'sedan', x: spot.x, y: spot.y, a: spot.a, vx: 0, vy: 0, color: '#888888', brake: false, wreck: false, hp: 100 };
    let maxStep = 0, maxRaw = 0;
    const prev = v.wheels.map(() => null), raw = [];
    for (let f = 0; f < 6 * 60; f++) {
      c.vx = Math.cos(c.a) * 2 * M; c.vy = Math.sin(c.a) * 2 * M;
      c.x += c.vx * DT; c.y += c.vy * DT;
      CARS.syncCar(v, c, DT, ground, null, true);
      v.group.updateMatrixWorld(true);
      v.wheels.forEach((w, i) => {
        const p = w.getWorldPosition(new THREE.Vector3());
        const r = ground(p.x * M, p.z * M);
        if (prev[i]) { maxStep = Math.max(maxStep, Math.abs(p.y - prev[i].y)); maxRaw = Math.max(maxRaw, Math.abs(r - prev[i].r)); }
        prev[i] = { y: p.y, r };
      });
    }
    check('the ground steps under a wheel (a kerb is there)', maxRaw > 0.1, cm(maxRaw));
    check('at 2 m/s no wheel rises or drops more than 6 cm in one frame', maxStep <= 0.06, cm(maxStep));
  }
}

// ---------- 6. the headlight pool ----------

section('6. the headlight pool lies on the road ahead');
{
  CARS.setCarNight(1);
  const runs = [['the foot of the switchbacks', path(378, 312, 362, 326, 640, 1.8), 25], ['over the Crest Road knoll', path(860, 200, 870, 190, 120, 1.8), 20]];
  for (const [name, P, vmax] of runs) {
    let worst = 0, worstTilt = 0, n = 0;
    const wp = new THREE.Vector3(), nrm = new THREE.Vector3(), q = new THREE.Quaternion();
    drive('bolide', P, vmax, (f, c, v) => {
      if (c.air > 0 || !v.pool.visible) return;
      v.group.updateMatrixWorld(true);
      v.pool.getWorldPosition(wp);
      const g = ground(wp.x * M, wp.z * M);
      worst = Math.max(worst, Math.abs(wp.y - g - 0.06));
      // the pool's normal against the road's: their angle along the car's heading
      v.pool.getWorldQuaternion(q);
      nrm.set(0, 0, 1).applyQuaternion(q);
      const fx = Math.cos(c.a), fz = Math.sin(c.a), e = 6;
      const rise = (ground((wp.x + fx * e) * M, (wp.z + fz * e) * M) - ground((wp.x - fx * e) * M, (wp.z - fz * e) * M)) / (2 * e);
      const tilt = Math.atan2(nrm.x * fx + nrm.z * fz, nrm.y);
      worstTilt = Math.max(worstTilt, Math.abs(tilt + Math.atan(rise)));
      n++;
    });
    check(`${name}: the pool's middle within 15 cm of 6 cm over the road`, n > 100 && worst <= 0.15, `${cm(worst)} over ${n} frames`);
    check(`${name}: the pool tilts with the road (within 0.03 rad)`, worstTilt <= 0.03, worstTilt.toFixed(3) + ' rad');
  }
  CARS.setCarNight(0);
}

// ---------- 7. recycling ----------

section('7. a recycled view leaves its hill behind');
{
  const d = drive('sedan', path(378, 312, 362, 326, 200, 1.8), 25, null);
  const v = d.v;
  d.c.squash = 0.8; CARS.syncCar(v, d.c, DT, ground, null, true);
  const tilted = v.group.rotation.x !== 0 || v.group.rotation.z !== 0;
  const r = CARS.recycleCarView(v, 'sedan', '#123456'), fresh = CARS.makeCarView('sedan', '#123456');
  const sig = (w) => JSON.stringify([w.group.rotation.toArray(), w.wheels.map(k => k.position.toArray()), w.pool.position.toArray(), w.pool.quaternion.toArray(),
    w.chassis.position.toArray(), w.ox, w.oz, w.oa, w.o0x, w.o0z, w.o0a, w.skidT, w.skidM, w.sp, w.tp, w.tr, w.sit, w.squashed, [...w.wh]]);
  check('the view was tilted on the hill', tilted);
  check('recycled: level, wheels at rest, pool in place, no skid or airtime (as a fresh view)', r === v && sig(v) === sig(fresh));
}

// ---------- 8. the v2 camera and Kimchi's feet (main3d.js) ----------

// main3d.js cannot load in node (it starts the renderer), so its camera and foot helpers are taken from its
// source text and run here against the real world (cityV2's occluderTop, world.groundY).
const { readFileSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const MAIN = readFileSync(fileURLToPath(src('src/3d/main3d.js')), 'utf8');
const cut = (a, b) => { const i = MAIN.indexOf(a), j = MAIN.indexOf(b, i); if (i < 0 || j < 0) throw new Error(`main3d.js: no '${a}' .. '${b}'`); return MAIN.slice(i, j); };
const CITY = await quiet(() => import(src('src/3d/cityV2.js')));
const cam = { pos: new THREE.Vector3() }, desired = new THREE.Vector3(), pivot = new THREE.Vector3(), aimFwd = new THREE.Vector3();
const clampF = (x, a, b) => Math.max(a, Math.min(b, x));
const H = new Function('occluderTop', 'surfaceY', 'S', 'cam', 'desired', 'pivot', 'aimFwd', 'V2', 'clamp',
  cut('const CAM_R = 0.6', 'const desired = new THREE.Vector3()') + cut('const FOOT_GRADE', '// Spray where')
  + '\nreturn { chaseV2, aimV2, keepClear, footY, lifted: () => camLifted, CAM_CLEAR, CHASE_MIN_CAR };')(CITY.occluderTop, ground, S, cam, desired, pivot, aimFwd, true, clampF);
const TG = world.grids.terrain, [TW, TH] = world.grids.dims.terrain;
// the terrain mesh's height (TERRAIN's 2 m triangles, split as terrain3d draws them) and what the camera must
// stay over there: that, the ground (roads, kerbs, decks) and any building (OCC)
function terrainMesh(x, z) {
  const i = clampF(Math.floor(x / 2), 0, TW - 2), j = clampF(Math.floor(z / 2), 0, TH - 2), u = x / 2 - i, t = z / 2 - j;
  const h00 = TG[j * TW + i], h10 = TG[j * TW + i + 1], h01 = TG[(j + 1) * TW + i], h11 = TG[(j + 1) * TW + i + 1];
  return u + t <= 1 ? h00 + (h10 - h00) * u + (h01 - h00) * t : h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - t);
}
const solidTop = (x, z) => Math.max(terrainMesh(x, z), ground(x * M, z * M), CITY.occluderTop(x, z));
const lens = new THREE.PerspectiveCamera(62, 1440 / 800, 0.15, 2600), NDC = [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]], cv = new THREE.Vector3();
// the lowest corner of the near plane (and the eye) over what is solid there (m; under 0 is inside)
function nearPlaneClear(pos, look, fov) {
  lens.fov = fov; lens.updateProjectionMatrix();
  lens.position.copy(pos); lens.lookAt(look); lens.updateMatrixWorld();
  let low = Infinity;
  for (const [x, y] of NDC) {
    if (x || y) cv.set(x, y, -1).unproject(lens); else cv.copy(pos);
    low = Math.min(low, cv.y - solidTop(cv.x, cv.z));
  }
  return low;
}
// is the line from a to b clear of what is solid (every 0.25 m)?
function lineClear(a, b) {
  const n = Math.ceil(a.distanceTo(b) / 0.25);
  for (let k = 1; k < n; k++) { const t = k / n; if (a.y + (b.y - a.y) * t < solidTop(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) return false; }
  return true;
}

section('8. the v2 chase camera: pull in, then lift (main3d.js chaseV2, keepClear)');
{
  // main3d's chase camera on a drive (updateCamera as it runs for a car): it swings after the car's heading,
  // or (look) is held off to one side as if the player had dragged it there
  const angDiff = (a, b) => wrap(b - a);
  const T = new THREE.Vector3(), L = new THREE.Vector3();
  const chaseRun = (name, P, vmax, look) => {
    let yaw = null, worst = Infinity, under = 0, blocked = 0, lifts = 0, pulls = 0, frames = 0;
    cam.init = false;
    drive('bolide', P, vmax, (f, c, v) => {
      const sp = Math.abs(v.vf), tx = c.x * S, tz = c.y * S, ty = v.y + 1.3;
      if (yaw == null) yaw = c.a;
      const want = look == null ? c.a : c.a + look;
      yaw += look == null ? angDiff(yaw, want) * Math.min(1, DT * (sp > 2 ? 3.2 : 1.2)) : angDiff(yaw, want);
      const dist = 6.9 + Math.min(2.6, sp * 0.075), pitch = 0.34 - 0.06;
      H.chaseV2(tx, ty, tz, -Math.cos(yaw), -Math.sin(yaw), dist, pitch, H.CHASE_MIN_CAR);
      if (H.lifted() > 0.01) lifts++;
      else if (Math.hypot(desired.x - tx, desired.z - tz) < dist * Math.cos(pitch) - 0.01) pulls++;
      if (!cam.init) { cam.pos.copy(desired); cam.init = true; }
      cam.pos.lerp(desired, 1 - Math.exp(-DT * 9));
      H.keepClear(tx, ty, tz);
      L.set(tx + Math.cos(c.a) * 3, ty + 0.1, tz + Math.sin(c.a) * 3);
      const low = nearPlaneClear(cam.pos, L, 62 + Math.min(10, sp * 0.25));
      worst = Math.min(worst, low);
      if (low < 0) under++;
      if (!lineClear(T.set(tx, ty, tz), cam.pos)) blocked++;
      frames++;
    });
    check(`${name}: the camera never enters the terrain, the ground or a building`, under === 0 && frames > 200, `${under} of ${frames} frames, lowest ${worst.toFixed(2)} m`);
    check(`${name}: nothing stands between the camera and the car`, blocked <= frames * 0.002, `${blocked} frames`);
    note(`${name}: ${frames} frames, lowest near-plane corner ${worst.toFixed(2)} m over what is solid; pulled in on ${pulls} frames, lifted on ${lifts}`);
    return { lifts, pulls };
  };
  chaseRun('switchbacks down', RUNS[0].P(), 25);
  chaseRun('Heights Drive down', RUNS[2].P(), 30);
  chaseRun('Crest Road', RUNS[3].P(), 37.5);
  // looking back up the hill from below, and across the hillside: the camera has to give way
  const side = chaseRun('switchbacks down, the camera held looking back uphill', RUNS[0].P(), 15, Math.PI);
  const side2 = chaseRun('switchbacks up, the camera held off the right side', RUNS[1].P(), 15, -Math.PI / 2);
  check('the camera pulled in and lifted on those', side.pulls + side2.pulls > 0 && side.lifts + side2.lifts > 0, JSON.stringify({ side, side2 }));
}

section('8b. the v2 shoulder camera (main3d.js aimV2) on the hills');
{
  let n = 0, under = 0, blocked = 0, lifts = 0, worst = Infinity;
  const P = RUNS[0].P(), T = new THREE.Vector3();
  for (let k = 0; k < P.length; k += 6) {
    const x = P[k].x * S, z = P[k].y * S, gy = ground(P[k].x, P[k].y);
    for (let q = 0; q < 12; q++) {
      const yaw = q / 12 * Math.PI * 2, lp = 0.34 - 0.34, cy = Math.cos(yaw), sy = Math.sin(yaw);
      aimFwd.set(cy * Math.cos(lp), -Math.sin(lp), sy * Math.cos(lp));
      pivot.set(x - sy * 0.5, gy + 1.58, z + cy * 0.5);
      const out = new THREE.Vector3();
      H.aimV2(out);
      const rise = out.y - (pivot.y - aimFwd.y * pivot.distanceTo(out));
      if (rise > 0.01) lifts++;
      const low = nearPlaneClear(out, T.copy(pivot).addScaledVector(aimFwd, 25), 50);
      worst = Math.min(worst, low);
      if (low < 0) under++;
      if (!lineClear(pivot, out)) blocked++;
      n++;
    }
  }
  check('the shoulder camera never enters the terrain on the switchbacks (12 headings every 12 m)', under === 0, `${under} of ${n}, lowest ${worst.toFixed(2)} m`);
  check('... and nothing stands between it and the shoulder', blocked === 0, `${blocked} of ${n}`);
  note(`${n} spots: lifted on ${lifts}, lowest near-plane corner ${worst.toFixed(2)} m over what is solid`);
}

section('8c. Kimchi\'s feet on a hill (main3d.js footY)');
{
  // walking down a 15% slope at a run: followed exactly; a 16 cm kerb at a walk: eased in over a few frames
  const r = { gy: null, gyRaw: null };
  let y = 10, worst = 0;
  for (let f = 0; f < 120; f++) { y -= 0.15 * 9.4 * DT; r.gy = H.footY(r, y, 9.4 * DT, DT); if (f > 0) worst = Math.max(worst, Math.abs(r.gy - y)); }
  check('running down a 15% slope the feet stay on it (within 1 mm)', worst < 0.001, cm(worst));
  const k = { gy: 5, gyRaw: 5 };
  const first = H.footY(k, 5.16, 1.5 * DT, DT);
  k.gy = first;
  let t = DT;
  while (Math.abs(k.gy - 5.16) > 0.01 && t < 2) { k.gy = H.footY(k, 5.16, 1.5 * DT, DT); t += DT; }
  check('stepping up a 16 cm kerb at a walk eases in (under 7 cm the first frame, there within 0.4 s)', first - 5 < 0.07 && t <= 0.4, `${cm(first - 5)}, ${t.toFixed(2)} s`);
  const G2 = new Function('occluderTop', 'surfaceY', 'S', 'cam', 'desired', 'pivot', 'aimFwd', 'V2', 'clamp',
    cut('const FOOT_GRADE', '// Spray where') + '\nreturn footY;')(null, null, S, null, null, null, null, false, clampF);
  const g = { gy: 3, gyRaw: 3 };
  check('on the grid the feet ease as before', G2(g, 3.16, 0.1, DT) === 3 + 0.16 * Math.min(1, DT * 14));
}

// ---------- the model cars ----------

const n = await quiet(() => CARS.loadCarModels());
note(`${n} car models loaded`);
if (n) await wheelRuns('model');
done();
