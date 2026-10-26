#!/usr/bin/env node
// Stage S6a check, part 2: the v2 driving physics (docs/map-v2-spec.md §10, PHYS.v2) on the real Kimchi Key
// map, with the 3D game's tuning (main3d's CFG). It runs only once world-v2 is READY. Checks:
//   1. surface grip: the top speed on each kind is its gripAt max share; sideways sliding dies away slower on
//      loose ground;
//   2. the yaw cap: on the runway the sideways g never passes gripG (x1.35 on the handbrake);
//   3. slopes: coasting uphill slows harder than on the flat, and a car standing on Seoul Ave's 15.8% stays put;
//   4. airtime: the 4 jumps give 0.5-1.5 s in the air at 30-45 m/s, one flight each, with no steering in the
//      air and a squash on landing; a kerb at speed is not a jump; a car moved by a script is set down; and
//      the unplanned airtime of straight runs on each surface (reported; under 1% of the time on the road);
//   5. walls: sliding along the causeway's edge at 50 m/s neither sticks nor wrecks the car (hp loss <= 10,
//      also when held into it), and 60 m/s at a 20 fps frame never tunnels through the 2 m median barrier;
//      a wall turns the car's nose along it at no more than 4° a frame, not at all at a creep, and from
//      20 m/s up brings it round to the barrier's line;
//   6. the Bolide holds the Indian Creek Bend (the Loop's R 108 m turn onto the island) at 165-170 km/h and
//      runs wide well above 170 km/h.
//   node tools/s6a_drive_test.mjs
// Exits 1 if any check fails; WARN lines are world-data issues reported to the lead (see notes in the output).
globalThis.KC_WORLD = 'v2';
const L = await import('./s6a_lib.mjs');
const { M, DT } = L;
const game = await L.loadGame();
const { G, ent, world } = game;
if (world.KIND !== 'v2') {
  console.log('s6a drive: world-v2 is not READY yet, so the facade gives the grid; nothing to check');
  process.exit(0);
}
const { CAR_TYPES } = await import('../src/data.js');
const { GRIP } = await import('../src/map/raster.js');
Object.assign(ent.CFG, L.CFG_3D);
let failed = 0, passed = 0, warned = 0;
const check = (ok, msg) => { if (ok) passed++; else { failed++; console.log('  FAIL ' + msg); } };
const warn = msg => { warned++; console.log('  WARN ' + msg); };
const info = msg => console.log('  ' + msg);
const speed = c => Math.hypot(c.vx, c.vy);
const fwdOf = c => c.vx * Math.cos(c.a) + c.vy * Math.sin(c.a);
check(world.PHYS.gripG === 2 && world.PHYS.slope && world.PHYS.air && world.PHYS.wall === 'normal' && world.PHYS.substepPx === 8, 'v2 runs PHYS.v2');
check(ent.CFG.gripG === 2, `CFG.gripG starts at PHYS.gripG (${ent.CFG.gripG})`);

// A flat spot whose (2r+1)² m square is all of surface kind k (null if none).
function flatSpot(k, r) {
  for (let z = 20; z < 1780; z += 3) for (let x = 20; x < 2030; x += 3) {
    if (world.surfaceAt(x * M, z * M) !== k) continue;
    let ok = true;
    for (let dz = -r; dz <= r && ok; dz++) for (let dx = -r; dx <= r && ok; dx++) {
      const X = (x + dx) * M, Y = (z + dz) * M;
      if (world.surfaceAt(X, Y) !== k || world.blockedCarPx(X, Y)) ok = false;
    }
    if (!ok) continue;
    const y0 = world.groundY((x - r) * M, z * M), y1 = world.groundY((x + r) * M, z * M), y2 = world.groundY(x * M, (z - r) * M), y3 = world.groundY(x * M, (z + r) * M);
    if (Math.abs(y0 - y1) < 0.05 * r && Math.abs(y2 - y3) < 0.05 * r) return { x: x * M, y: z * M };
  }
  return null;
}

// A spot in a boulevard's right lanes 6 m from its kerb, heading 45° at it, where the 12 m beyond (the
// sidewalk and what is behind it) blocks nothing: { x, y, a }.
function kerbSpot() {
  for (const e of world.roads.edges) {
    if (e.cls !== 'blvd' || e.n < 20) continue;
    for (let i = 5; i < e.n - 5; i += 3) {
      const tx = e.tx[i], ty = e.ty[i], rx = -ty, ry = tx, d = e.halfW - 6 * M;
      const x = e.x[i] + rx * d, y = e.y[i] + ry * d, a = Math.atan2(ty, tx) + Math.PI / 4;
      let ok = world.surfaceAt(e.x[i] + rx * (e.halfW + 1.5 * M), e.y[i] + ry * (e.halfW + 1.5 * M)) === world.WALK;
      for (let k = 0; k <= 26 && ok; k++) if (world.blockedCarPx(x + Math.cos(a) * k * M, y + Math.sin(a) * k * M)) ok = false;
      if (ok) return { x, y, a };
    }
  }
  return null;
}

// ---------- 1. surface grip ----------
console.log('surface grip');
{
  const ty = CAR_TYPES.sports, KINDS = { ROAD: 0, WALK: 1, GRASS: 2, LOT: 4, PLAZA: 5, SAND: 7, DIRT: 8, SHALLOW: 9, DECK: 10 };
  const row = [];
  for (const [name, k] of Object.entries(KINDS)) {
    const p = flatSpot(k, k === 1 || k === 8 ? 1 : 3);
    if (!p) { warn(`no flat ${name} spot on the map to test`); continue; }
    // throttle held where it stands (driveCar only, so it stays on this surface): fwd settles at the cap
    const c = L.soloCar(game, 'sports', p.x, p.y, 0, 0);
    for (let f = 0; f < 60 * 12; f++) ent.driveCar(c, DT, { up: true });
    // (the throttle holds it about a third of the acceleration over the cap, as it always has)
    const want = ty.max * ent.CFG.carMax * GRIP.v2[k].max + ty.acc * ent.CFG.carAcc * (1 / 3 - DT);
    row.push(`${name} ${(fwdOf(c) / M).toFixed(1)}`);
    check(Math.abs(fwdOf(c) - want) < 0.01 * want, `${name}: top speed ${(fwdOf(c) / M).toFixed(1)} m/s for a cap of ${GRIP.v2[k].max} (${(want / M).toFixed(1)})`);
    // a sideways slide of 10 m/s for 0.25 s: what is left follows lat
    c.vx = 0; c.vy = 10 * M; c.a = 0;
    for (let f = 0; f < 15; f++) ent.driveCar(c, DT, {});
    const left = Math.abs(c.vy) / (10 * M), expect = Math.pow(0.0006, 0.25 * GRIP.v2[k].lat);
    check(Math.abs(left - expect) < 0.02, `${name}: sideways slide keeps ${left.toFixed(3)} after 0.25 s (lat ${GRIP.v2[k].lat}: ${expect.toFixed(3)})`);
  }
  info(`top speeds (m/s): ${row.join(', ')}`);
}

// ---------- 2. the yaw cap ----------
console.log('yaw cap on the runway');
{
  const tanBank = Math.tan(5 * Math.PI / 180);
  for (const [v, hb] of [[15, false], [30, false], [45, false], [30, true]]) {
    const c = L.soloCar(game, 'bolide', 400 * M, 1528 * M, 0, v * M);
    let peak = 0, a = c.a;
    for (let f = 0; f < 45; f++) {
      ent.updatePlayer(DT, { steer: 1, up: fwdOf(c) < v * M, brake: hb });
      peak = Math.max(peak, Math.abs(L.wrap(c.a - a)) / DT * speed(c) / M / 9.81); a = c.a;
    }
    const cap = 2 * (hb ? 1.35 : 1);
    info(`${v} m/s${hb ? ' on the handbrake' : ''}: peak ${peak.toFixed(2)} g`);
    check(peak <= cap + tanBank + 0.02, `${v} m/s${hb ? ' handbrake' : ''}: sideways g stays within ${cap} (${peak.toFixed(2)} g)`);
    if (v >= 30) check(peak > cap * 0.9, `${v} m/s${hb ? ' handbrake' : ''}: full lock reaches the cap (${peak.toFixed(2)} g)`);
  }
}

// ---------- 3. slopes ----------
console.log('slopes');
{
  // Seoul Avenue climbs 15.8% north from K-Town to the Loop
  const P = L.roadPath(world.roads, 870 * M, 440 * M, -Math.PI / 2, 0, 50, 1.75), Q = P[P.length - 1];
  const grade = (world.groundY(Q.x, Q.y) - world.groundY(P[0].x, P[0].y)) / ((Q.s - P[0].s) / M);
  const a0 = Math.atan2(P[1].y - P[0].y, P[1].x - P[0].x);
  let c = L.soloCar(game, 'sedan', P[0].x, P[0].y, a0, 15 * M);
  for (let f = 0; f < 60; f++) ent.updatePlayer(DT, {});
  const up = speed(c) / M;
  c = L.soloCar(game, 'sedan', 400 * M, 1528 * M, 0, 15 * M);
  for (let f = 0; f < 60; f++) ent.updatePlayer(DT, {});
  const flat = speed(c) / M;
  info(`coasting 1 s from 15 m/s: ${up.toFixed(2)} m/s up a ${(grade * 100).toFixed(1)}% grade, ${flat.toFixed(2)} m/s on the flat`);
  // the slope term (m/s²), less what the coasting drag (1.1/s, on the speed) gives back over the second
  const pull = 9.81 * 0.6 * grade, extra = pull * (1 - Math.exp(-1.1)) / 1.1;
  check(Math.abs(flat - up - extra) < 0.1 * extra, `uphill it loses ${(flat - up).toFixed(2)} m/s more, as the slope term says (${extra.toFixed(2)})`);
  c = L.soloCar(game, 'sedan', P[0].x, P[0].y, a0, 0);
  const x0 = c.x, y0 = c.y;
  for (let f = 0; f < 60 * 5; f++) ent.updatePlayer(DT, {});
  check(Math.hypot(c.x - x0, c.y - y0) < 0.05 * M, `a car standing on the slope with no pedal stays put (${(Math.hypot(c.x - x0, c.y - y0) / M).toFixed(3)} m in 5 s)`);
  for (let f = 0; f < 60 * 3; f++) ent.updatePlayer(DT, { up: true });
  check(Math.hypot(c.x - x0, c.y - y0) > 10 * M, 'and climbs it on the throttle');
}

// ---------- 4. airtime ----------
console.log('jumps');
{
  // j_crest lands on the turn onto the knoll, beside its guardrail: past 40 m/s the car flies off the road onto
  // lower ground, and below that it can clip the rail and hop again over the knoll's crest (world data)
  const BEND_AFTER = { j_crest: 40 }, CREST_HOPS = { j_crest: true };
  for (const j of world.activities.filter(a => a.type === 'jump')) {
    const row = [];
    for (const V of [30, 37.5, 45]) {
      const P = L.roadPath(world.roads, j.x, j.y, j.a, j.id === 'j_port' ? 30 : 70, 60, 0);
      const c = L.soloCar(game, 'bolide', P[0].x, P[0].y, Math.atan2(P[1].y - P[0].y, P[1].x - P[0].x), V * M);
      const flights = [];
      let jj = 0, cur = 0, steerOk = true, squash = 0;
      for (let f = 0; f < 60 * 5; f++) {
        const t = L.trackPath(P, c.x, c.y, jj); jj = t.j;
        if (jj >= P.length - 3 && !(c.air > 0)) break;      // (a flight still going at the path's end is followed down)
        const a = c.a, vx = c.vx, vy = c.vy, turning = c.wallTurn?.t > 0, inp = L.driveAlong(c, P, Math.min(jj, P.length - 2), V * M, 12);
        if (c.air > 0) inp.steer = 1;                       // steering in the air does nothing
        ent.updatePlayer(DT, inp);
        // only a wall may turn a car in the air: a hit changes its velocity, and the turn it starts runs on
        if (c.air > 0 && cur > 0 && c.a !== a && c.vx === vx && c.vy === vy && !turning) steerOk = false;
        if (c.air > 0) cur = c.air;
        else if (cur) { flights.push(cur); cur = 0; squash = Math.max(squash, c.squash || 0); }
      }
      if (cur) flights.push(cur);
      const air = flights.length ? flights[0] : 0, hops = flights.filter(t => t > 0.2).length;
      row.push(`${V} m/s ${flights.map(t => t.toFixed(2)).join(' + ') || 'none'} s`);
      const long = !(air >= 0.5 && air <= 1.5), extra = hops > 1;
      if (long && V > (BEND_AFTER[j.id] ?? Infinity)) warn(`${j.id} at ${V} m/s: ${air.toFixed(2)} s in the air: the road turns away under the flight (world data)`);
      else check(!long, `${j.id} at ${V} m/s: the jump's flight is 0.5-1.5 s (${air.toFixed(2)})`);
      if (extra && CREST_HOPS[j.id]) warn(`${j.id} at ${V} m/s: a second hop of ${flights.slice(1).map(t => t.toFixed(2)).join(', ')} s after landing on the knoll's crest (world data)`);
      else check(!extra, `${j.id} at ${V} m/s: one flight (${flights.map(t => t.toFixed(2)).join(', ') || 'none'})`);
      check(steerOk, `${j.id} at ${V} m/s: no steering in the air`);
      if (!long) check(squash > 0.2, `${j.id} at ${V} m/s: the landing squashes the suspension (${squash.toFixed(2)})`);
    }
    info(`${j.id}: ${row.join(', ')}`);
  }
  // across a kerb at 20 m/s, 45° off a boulevard's lanes onto its 3.5 m sidewalk where nothing blocks beyond
  const kerb = kerbSpot();
  let c = L.soloCar(game, 'sports', kerb.x, kerb.y, kerb.a, 20 * M);
  let maxAir = 0, onWalk = false;
  for (let f = 0; f < 36; f++) {
    ent.updatePlayer(DT, { up: true });
    maxAir = Math.max(maxAir, c.air || 0);
    if (world.surfaceAt(c.x, c.y) === world.WALK) onWalk = true;
  }
  check(onWalk, 'the kerb test drives onto the sidewalk');
  check(maxAir === 0, `a 16 cm kerb at 20 m/s is not a jump (${maxAir.toFixed(2)} s in the air)`);
  // a car moved by a script from the villa's terrace (58 m) to the runway (1.2 m) is set down, not dropped
  const h = world.places.home.garage[0];
  c = L.soloCar(game, 'sedan', h.x, h.y, h.a, 0);
  c.vx = 5 * M;
  ent.updatePlayer(DT, {});
  const top = c.gy;
  c.x = 400 * M; c.y = 1528 * M;
  ent.updatePlayer(DT, { up: true });
  check(top > 40 && !(c.air > 0) && Math.abs(c.gy - world.groundY(c.x, c.y)) < 0.3, `a car moved 57 m down by a script is set on the ground (${top.toFixed(1)} m -> ${c.gy.toFixed(2)} m, air ${c.air})`);

  // Unplanned airtime: 1.5 s straight runs at 35 m/s from random spots with 55 m of one surface kind clear
  // ahead. The grounded climb is taken over the wheelbase, so the height grid's ripples do not launch the car;
  // what is left on grass and sand is real ground (dune and hill crests, banks), reported for the lead.
  L.seed(7);
  const KINDS = { ROAD: 0, WALK: 1, GRASS: 2, PLAZA: 5, SAND: 7, DECK: 10 }, V = 35, rows = [];
  for (const [name, k] of Object.entries(KINDS)) {
    let runs = 0, airT = 0, totT = 0, flights = 0, longest = 0;
    for (let t = 0; t < 20000 && runs < 60; t++) {
      const x = (20 + Math.random() * 2000) * M, y = (20 + Math.random() * 1750) * M, a = Math.random() * Math.PI * 2;
      let ok = true;
      for (let d = 0; d <= 55 && ok; d += 2) {
        const X = x + Math.cos(a) * d * M, Y = y + Math.sin(a) * d * M;
        if (world.surfaceAt(X, Y) !== k || world.blockedCarPx(X, Y)) ok = false;
      }
      if (!ok) continue;
      runs++;
      c = L.soloCar(game, 'sports', x, y, a, V * M);
      let cur = 0;
      for (let f = 0; f < 90; f++) {
        ent.updatePlayer(DT, { up: speed(c) < V * M });
        totT += DT;
        if (c.air > 0) { airT += DT; cur = c.air; }
        else if (cur) { if (cur > 0.1) flights++; longest = Math.max(longest, cur); cur = 0; }
      }
      if (cur > 0.1) flights++;
      longest = Math.max(longest, cur);
    }
    const pct = 100 * airT / Math.max(totT, 1e-9);
    rows.push(`${name} ${pct.toFixed(1)}% (${runs} runs, ${flights} flights over 0.1 s, longest ${longest.toFixed(2)} s)`);
    if (name === 'ROAD') check(pct < 1, `straight on the road at ${V} m/s the car is in the air under 1% of the time (${pct.toFixed(2)}%)`);
  }
  info(`unplanned airtime at ${V} m/s: ${rows.join('; ')}`);
}

// ---------- 5. walls ----------
console.log('walls');
{
  // the causeway east of the pylon (flat enough not to take off): the right carriageway's middle, heading east
  const P = L.roadPath(world.roads, 1470 * M, 318 * M, 0, 0, 200, 5.1);
  const base = Math.atan2(P[3].y - P[0].y, P[3].x - P[0].x);
  for (const [deg, hold] of [[5, 0], [10, 0], [15, 0], [5, 1.5]]) {
    // start 3 m from the edge, angled at it; the driver steers back along the road after 0.25 s (or holds
    // the wheel into the wall for `hold` s)
    const q = L.roadPath(world.roads, 1470 * M, 318 * M, 0, 0, 10, 8)[0];
    const c = L.soloCar(game, 'bolide', q.x, q.y, base + deg * Math.PI / 180, 50 * M);
    const hp0 = c.hp;
    let jj = 0, minV = Infinity, dist = 0, px = c.x, py = c.y, touched = false;
    for (let f = 0; f < 150; f++) {
      const t = L.trackPath(P, c.x, c.y, jj); jj = t.j;
      const inp = L.driveAlong(c, P, jj, 50 * M, 25);
      if (f < 15 || f < hold * 60) inp.steer = hold ? 1 : 0;
      const hp = c.hp;
      ent.updatePlayer(DT, inp);
      if (c.hp < hp || ent.carHits(c, c.x + (c.vx > 0 ? 8 : -8), c.y, c.a)) touched = true;
      minV = Math.min(minV, speed(c) / M);
      dist += Math.hypot(c.x - px, c.y - py) / M; px = c.x; py = c.y;
    }
    const lost = hp0 - c.hp, what = hold ? `held into the wall for ${hold} s from ${deg}°` : `${deg}° into the wall`;
    info(`${what}: ${lost.toFixed(1)} hp, slowest ${minV.toFixed(1)} m/s, ${dist.toFixed(0)} m in 2.5 s`);
    check(touched, `${what}: the car meets the wall`);
    check(minV > 40 && dist > 110, `${what}: the car slides on (slowest ${minV.toFixed(1)} m/s, ${dist.toFixed(0)} m)`);
    check(lost <= 10, `${what}: sliding along costs at most 10 hp (${lost.toFixed(1)})`);
  }
  // A wall turns the nose along it at a rate, never in a snap (the 3D car shows c.a unsmoothed): no frame
  // turns the car more than 4° (4 rad/s at 60 fps), a car creeping into the barrier at 1-2 m/s is not turned
  // at all, and at 20 m/s and up the car ends up running along the barrier. No steering, the throttle holds V.
  {
    const Q = L.roadPath(world.roads, 1470 * M, 318 * M, 0, 0, 10, 0), rx = -(Q[1].y - Q[0].y), ry = Q[1].x - Q[0].x, rl = Math.hypot(rx, ry);
    const res = [];
    for (const V of [1, 2, 5, 20, 35, 50]) for (const deg of [10, 20, 30, 40]) {
      // start 0.15 m short of the barrier at the carriageway's right edge, its body clear of it
      const a0 = base + deg * Math.PI / 180, c = L.soloCar(game, 'bolide', Q[0].x, Q[0].y, a0, V * M);
      let edge = 5.1;
      while (edge < 15 && !ent.carHits(c, Q[0].x + rx / rl * (edge + 0.1) * M, Q[0].y + ry / rl * (edge + 0.1) * M, a0)) edge += 0.1;
      c.x = Q[0].x + rx / rl * (edge - 0.15) * M; c.y = Q[0].y + ry / rl * (edge - 0.15) * M;
      // off: how far the nose is from the road's line where the car is, the least once it has met the wall
      let a = c.a, snap = 0, met = false, off = Infinity;
      for (let f = 0; f < (V <= 2 ? 360 : 72); f++) {          // (1.2 s keeps the fast ones short of the bend)
        const vx = c.vx, vy = c.vy;
        ent.updatePlayer(DT, { up: speed(c) < V * M });
        if (c.vx * vx + c.vy * vy < 0.999 * Math.hypot(c.vx, c.vy) * Math.hypot(vx, vy)) met = true;   // the velocity turned: a wall
        snap = Math.max(snap, Math.abs(L.wrap(c.a - a))); a = c.a;
        const q = world.roads.nearest(c.x, c.y), e = world.roads.edges[q.edge];
        if (met) off = Math.min(off, Math.abs(L.wrap(2 * (c.a - Math.atan2(e.ty[q.i], e.tx[q.i])))) / 2 * 180 / Math.PI);
      }
      res.push({ V, deg, met, snap: snap * 180 / Math.PI, turned: Math.abs(L.wrap(c.a - a0)) * 180 / Math.PI, off, hp: 100 - c.hp });
    }
    const worst = Math.max(...res.map(r => r.snap)), creep = res.filter(r => r.V <= 2), fast = res.filter(r => r.V >= 20);
    info(`wall turn: most in one frame ${worst.toFixed(2)}°; ${res.filter(r => r.V === 5).map(r => `5 m/s at ${r.deg}° turned ${r.turned.toFixed(1)}°`).join(', ')}`);
    info(`hp lost hitting the barrier at 10/20/30/40°: ${[20, 35, 50].map(V => `${V} m/s ${res.filter(r => r.V === V).map(r => r.hp.toFixed(0)).join('/')}`).join(', ')}`);
    check(res.every(r => r.met), `the turn-rate runs all meet the barrier (${res.filter(r => !r.met).map(r => `${r.V} m/s ${r.deg}°`).join(', ') || 'all'})`);
    check(worst <= 4, `a wall never turns the car more than 4° in one frame (${worst.toFixed(2)}°)`);
    check(creep.every(r => r.turned < 0.5), `creeping into the barrier at 1-2 m/s does not turn the car (most ${Math.max(...creep.map(r => r.turned)).toFixed(2)}°)`);
    check(fast.every(r => r.off < 1), `from 20 m/s up the car comes round to run along the barrier (worst ${Math.max(...fast.map(r => r.off)).toFixed(2)}° off the road's line)`);
  }
  // the 2 m median barrier at 60 m/s and 20 fps, straight at it at 30°: never through it
  const side = p => { const t = L.trackPath(P, p.x, p.y, 0); return Math.sign(t.d); };
  let through = 0;
  for (const deg of [-30, -60, -90]) {
    const c = L.soloCar(game, 'bolide', P[30].x, P[30].y, base + deg * Math.PI / 180, 60 * M);
    const s0 = side(c);
    for (let f = 0; f < 20; f++) { ent.updatePlayer(1 / 20, { up: true }); if (side(c) !== s0 && Math.abs(L.trackPath(P, c.x, c.y, 0).d) > 6.5 * M) through++; }
  }
  check(through === 0, `60 m/s at 20 fps never tunnels through the median barrier (${through} frames on the far side)`);
}

// ---------- 6. the Indian Creek Bend ----------
console.log('the Bolide on the Indian Creek Bend');
{
  // the right carriageway's middle (5.1 m right of the centre line) through the Loop's turn onto the island
  const P = L.roadPath(world.roads, 1564 * M, 312 * M, 0.3, 160, 200, 5.1);
  const res = {};
  for (const kmh of [150, 160, 165, 170, 175, 180, 185]) {
    const v = kmh / 3.6 * M, c = L.soloCar(game, 'bolide', P[0].x, P[0].y, Math.atan2(P[1].y - P[0].y, P[1].x - P[0].x), v);
    let jj = 0, out = 0, hit = false, peak = 0, a = c.a;
    for (let f = 0; f < 60 * 9; f++) {
      const t = L.trackPath(P, c.x, c.y, jj); jj = t.j;
      if (jj >= P.length - 12) break;
      out = Math.max(out, t.d / M);            // + = left, the outside of this right-hand bend
      const hp = c.hp;
      ent.updatePlayer(DT, L.driveAlong(c, P, jj, v, 10));
      if (c.hp < hp) hit = true;
      if (!(c.air > 0) && f > 20) peak = Math.max(peak, Math.abs(L.wrap(c.a - a)) / DT * speed(c) / M / 9.81);
      a = c.a;
    }
    res[kmh] = { out, hit, peak };
  }
  info(Object.entries(res).map(([k, r]) => `${k} km/h: ${r.out.toFixed(2)} m wide${r.hit ? ' (hit)' : ''}`).join(', '));
  check(res[165].out < 1 && !res[165].hit, `holds the bend at 165 km/h (${res[165].out.toFixed(2)} m wide)`);
  check(res[170].out < 1 && !res[170].hit, `holds the bend at 170 km/h (${res[170].out.toFixed(2)} m wide)`);
  check(res[185].out > 2 || res[185].hit, `runs wide at 185 km/h (${res[185].out.toFixed(2)} m)`);
  check(Object.values(res).every(r => r.peak <= 2 + Math.tan(5 * Math.PI / 180) + 0.03), `never pulls more than gripG + the 5° bank (${Math.max(...Object.values(res).map(r => r.peak)).toFixed(2)} g)`);
  if (res[175].out < 1) warn(`the bend is held within 1 m at 175 km/h: its lane averages a wider radius than the 108 m apex the spec's 170 km/h is figured for`);
}

console.log(failed ? `s6a drive: ${failed} failed, ${passed} passed, ${warned} warnings` : `s6a drive: ok (${passed} checks, ${warned} warnings)`);
process.exit(failed ? 1 : 0);
