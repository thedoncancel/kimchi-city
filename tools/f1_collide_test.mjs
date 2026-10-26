#!/usr/bin/env node
// Stage F1 check: car against car on v2 (docs/map-v2-spec.md §9, §10). The grid's one circle per car
// ((len + wid) / 4, so two cars touch with their centres 2.8-4 m apart) was wider than the v2 lanes (3-3.6 m
// apart) and the kerb bays (2.95 m from the lane's centre). v2 now tests the cars' boxes (population.js
// carOverlap) and answers a contact with an impulse; a traffic car takes only the part along its lane, and an
// off-centre hit turns a car by a capped knock spread over 0.25 s. Checks, on the real Kimchi Key map with
// the 3D game's tuning:
//   1. carOverlap: agrees with a brute-force point test on random pairs, is symmetric, and its push frees
//      the boxes; two of the widest cars side by side at the kerb-bay offset do not touch;
//   2. the kerb lanes: driving every avenue lane with cars in its bays at 10, 15 and 20 m/s, in the Ursa and
//      the Phantasma, past the streamed cars and past a Phantasma in every bay, touches none of them;
//   3. side by side: driving level with a traffic car in the next lane (boulevard, same way) or past one
//      coming the other way (avenue) touches nothing and never slows it;
//   4. contacts with a traffic car: a scrape along its side pushes the cars apart and leaves it driving,
//      one from behind shoves it on, a head-on hit slows it; a car ghosting free is passed through; a
//      display car does not move; a parked car shoved takes the momentum it is given;
//   5. the knock: a cruiser ramming the rear corner of Kimchi's car at 10-30 m/s turns it at most 1.4 rad/s
//      (never 18-39° in a frame as the grid's random spin did at v2 speeds), at most 20° in all, more for a
//      harder hit, and hardly at all for a hit through the middle;
//   6. streamed parked cars never appear on top of another car (Kimchi's car standing in a bay keeps it);
//   7. a soak: careful lane driving with the live population (traffic, people, parked cars) for SOAK s:
//      no traffic car is stopped by a side contact.
//   node tools/f1_collide_test.mjs [soak seconds = 120] [seed = 9]
// Exits 1 if any check fails.
globalThis.KC_WORLD = 'v2';
const L = await import('./s6a_lib.mjs');
const { M, DT } = L;
const args = process.argv.slice(2);
const SOAK = Number(args[0] || 120), SEED = Number(args[1] || 9);
const game = await L.loadGame();
const { G, ent, world } = game;
if (world.KIND !== 'v2') {
  console.log('f1 collide: world-v2 is not READY yet, so the facade gives the grid; nothing to check');
  process.exit(0);
}
const { CAR_TYPES } = await import('../src/data.js');
const traffic = await import('../src/sim/traffic.js');
const pop = await import('../src/sim/population.js');
const { carOverlap } = pop;
const R = world.roads;
Object.assign(ent.CFG, L.CFG_3D);
let failed = 0, passed = 0;
const check = (ok, msg) => { if (ok) passed++; else { failed++; console.log('  FAIL ' + msg); } };
const info = msg => console.log('  ' + msg);
const m = px => (px / M).toFixed(2);
const fwdOf = c => c.vx * Math.cos(c.a) + c.vy * Math.sin(c.a);
const circleR = c => (CAR_TYPES[c.type].len + CAR_TYPES[c.type].wid) / 4;
const TYPES = Object.keys(CAR_TYPES);
const O = {};

// The gap between two cars' boxes (px, 0 when they touch), to 0.01 m: the most padding round a that still
// leaves them apart, up to `max`.
function boxGap(a, b, max = 2 * M) {
  if (carOverlap(a, b, O)) return 0;
  if (!carOverlap(a, b, O, max)) return max;
  let lo = 0, hi = max;
  while (hi - lo > 0.01 * M) { const mid = (lo + hi) / 2; if (carOverlap(a, b, O, mid)) hi = mid; else lo = mid; }
  return lo;
}
// a lane polyline as a path for L.driveAlong, `off` px right of its centre
function lanePath(lane, off = 0) {
  const P = [];
  for (let i = 0; i < lane.n; i++) {
    const k0 = Math.max(0, i - 1), k1 = Math.min(lane.n - 1, i + 1);
    const tx = lane.x[k1] - lane.x[k0], ty = lane.y[k1] - lane.y[k0], l = Math.hypot(tx, ty) || 1;
    P.push({ x: lane.x[i] - ty / l * off, y: lane.y[i] + tx / l * off, s: lane.s[i] });
  }
  return P;
}
const stationOn = (lane, x, y) => { let b = 0, bd = Infinity; for (let i = 0; i < lane.n; i++) { const d = Math.hypot(lane.x[i] - x, lane.y[i] - y); if (d < bd) { bd = d; b = i; } } return lane.s[b]; };
function trafficCar(type, lane, s, speed, f = 1) {
  const q = R.lanePoint(lane.id, s, {});
  const c = ent.makeCar(type, q.x, q.y, q.a);
  c.traffic = true;
  traffic.aiAttach(c, { lane: lane.id, s, x: q.x, y: q.y, a: q.a }, { f, speed });
  G.cars.push(c);
  return c;
}

// ---------- 1. the box test ----------
console.log('carOverlap');
{
  L.seed(5);
  const rnd = (a, b) => a + Math.random() * (b - a);
  const inside = (c, x, y) => {
    const t = CAR_TYPES[c.type], ca = Math.cos(c.a), sa = Math.sin(c.a), dx = x - c.x, dy = y - c.y;
    return Math.abs(dx * ca + dy * sa) <= t.len / 2 && Math.abs(dy * ca - dx * sa) <= t.wid / 2;
  };
  // brute force: points over each box tested against the other
  const sampled = (a, b) => {
    for (const [p, q] of [[a, b], [b, a]]) {
      const t = CAR_TYPES[p.type], ca = Math.cos(p.a), sa = Math.sin(p.a);
      for (let i = 0; i <= 40; i++) for (let j = 0; j <= 16; j++) {
        const u = (i / 40 - 0.5) * t.len, v = (j / 16 - 0.5) * t.wid;
        if (inside(q, p.x + u * ca - v * sa, p.y + u * sa + v * ca)) return true;
      }
    }
    return false;
  };
  let disagree = 0, asym = 0, stuck = 0, hits = 0;
  for (let k = 0; k < 4000; k++) {
    const a = { type: TYPES[k % TYPES.length], x: 0, y: 0, a: rnd(-Math.PI, Math.PI) };
    const b = { type: TYPES[(k * 7 + 3) % TYPES.length], x: rnd(-110, 110), y: rnd(-70, 70), a: rnd(-Math.PI, Math.PI) };
    const o = carOverlap(a, b, {}), s = sampled(a, b);
    if (o) hits++;
    if ((!o && s) || (o && o.pen > 1 && !s)) disagree++;
    if (!o) continue;
    const r = carOverlap(b, a, {});
    if (!r || Math.abs(r.pen - o.pen) > 1e-6 || Math.abs(r.x + o.x) > 1e-6 || Math.abs(r.y + o.y) > 1e-6) asym++;
    const moved = { ...b, x: b.x + o.x * (o.pen + 1e-6), y: b.y + o.y * (o.pen + 1e-6) };
    if (carOverlap(a, moved, {})) stuck++;
  }
  info(`4000 random pairs, ${hits} overlapping`);
  check(disagree === 0, `the separating-axis test agrees with the point test (${disagree} disagree)`);
  check(asym === 0, `it is symmetric: b against a gives the same depth and the opposite normal (${asym} not)`);
  check(stuck === 0, `pushing b out by the depth along the normal frees it (${stuck} still touching)`);
  let worst = Infinity;
  for (const p of TYPES) for (const q of TYPES) worst = Math.min(worst, boxGap({ type: p, x: 0, y: 0, a: 0.3 }, { type: q, x: -Math.sin(0.3) * 2.95 * M, y: Math.cos(0.3) * 2.95 * M, a: 0.3 }));
  info(`two cars side by side 2.95 m apart (the kerb bays): the closest pair of types is ${m(worst)} m apart`);
  check(worst > 0.6 * M, `no two car types side by side at the kerb-bay offset touch (closest ${m(worst)} m, van and van)`);
}

// ---------- 2. the kerb lanes ----------
console.log('kerb lanes');
{
  L.seed(3);
  Object.assign(G, { mode: 'play', cars: [], peds: [], friends: [], wanted: 0 });
  const bayFrom = world.parkedSpawns.length;
  const rows = [];
  let lanesN = 0, parkedN = 0, touched = 0, shoved = 0, hpLost = 0, minGap = Infinity, circles = 0, drives = 0, flights = 0;
  for (const lane of R.lanes) {
    const E = R.edges[lane.edge];
    if (E.cls !== 'ave' || !E.ai || lane.len < 60 * M) continue;
    // stream the bays round the middle of the lane, then keep only the parked cars beside it
    const mid = lane.n >> 1;
    Object.assign(G.player, { x: lane.x[mid], y: lane.y[mid], car: null, dead: true });
    G.cars = []; G.peds = [];
    for (let k = 0; k < 10; k++) ent.updateWorld(0.25, { tier: 'medium' });
    const nearLane = c => { for (let i = 0; i < lane.n; i++) if (Math.hypot(lane.x[i] - c.x, lane.y[i] - c.y) < 3.5 * M) return true; return false; };
    const beside = G.cars.filter(c => c.parked != null && c.parked >= bayFrom && nearLane(c));
    if (beside.length < 2) continue;
    lanesN++; parkedN += beside.length;
    const P = lanePath(lane), a0 = Math.atan2(P[1].y - P[0].y, P[1].x - P[0].x);
    for (const big of [false, true]) {
      const parked = beside.map(c => Object.assign(ent.makeCar(big ? 'phantasma' : c.type, c.x, c.y, c.a), { parked: c.parked, x0: c.x, y0: c.y, a0: c.a }));
      for (const type of ['ursa', 'phantasma']) for (const v of [10, 15, 20]) {
        for (const c of parked) Object.assign(c, { x: c.x0, y: c.y0, a: c.a0, vx: 0, vy: 0, hp: 100, touched: false, knock: null });
        const car = L.soloCar(game, type, P[0].x, P[0].y, a0, v * M);
        G.cars.push(...parked);
        let j = 0, hit = 0, gap = Infinity, near = Infinity, air = 0;
        for (let f = 0; f < 60 * 120 && j < P.length - 3; f++) {
          ({ j } = L.trackPath(P, car.x, car.y, j));
          ent.updatePlayer(DT, L.driveAlong(car, P, j, v * M));
          air = Math.max(air, car.air || 0);
          for (const o of parked) {
            ent.moveCar(o, DT);
            const d = Math.hypot(o.x - car.x, o.y - car.y);
            if (d > 8 * M) continue;
            if (carOverlap(car, o, O)) hit++;
            gap = Math.min(gap, boxGap(car, o));
            near = Math.min(near, d - circleR(car) - circleR(o));
          }
        }
        const moved = parked.filter(c => Math.hypot(c.x - c.x0, c.y - c.y0) > 0.05 * M || c.touched).length;
        const what = `${E.road} lane ${lane.id} ${type} ${v} m/s${big ? ' (bays all Phantasmas)' : ''}: ${moved} shoved, ${hit} contact frames, ${(100 - car.hp).toFixed(1)} hp`;
        // a crest at the lane's start can throw the car (no steering in the air): physics, not the contact test
        if (air > 0.1) { flights++; rows.push(`${what}, after ${air.toFixed(2)} s in the air (not counted)`); continue; }
        drives++;
        touched += hit; shoved += moved; hpLost += 100 - car.hp; minGap = Math.min(minGap, gap);
        if (near < 0) circles++;
        if (moved || hit || car.hp < 100) rows.push(what);
      }
    }
  }
  for (const r of rows.slice(0, 8)) info(r);
  info(`${lanesN} avenue lanes with ${parkedN} cars in their bays, ${drives} drives on the ground (${flights} more left the ground at the lane's start): closest box gap ${m(minGap)} m; the grid's circles would have touched in ${circles} of the drives`);
  check(flights <= drives / 10, `few drives leave the ground (${flights})`);
  check(lanesN >= 6 && parkedN >= 25, `enough kerb lanes to test (${lanesN} lanes, ${parkedN} parked cars)`);
  check(circles > drives / 2, `the drives pass close enough that the old circles touched (${circles} of ${drives})`);
  check(touched === 0 && shoved === 0, `driving the kerb lane at 10-20 m/s touches no parked car (${touched} contact frames, ${shoved} shoved)`);
  check(hpLost === 0, `and costs no hp (${hpLost.toFixed(1)})`);
  check(minGap > 0.2 * M, `it keeps at least 0.2 m from the parked cars' boxes (${m(minGap)} m)`);
}

// ---------- 3. side by side ----------
console.log('side by side with traffic');
{
  L.seed(4);
  // boulevard lanes with a lane beside them going the same way, and avenue lanes with one coming the other way
  const pairs = [];
  for (const lane of R.lanes) {
    const E = R.edges[lane.edge];
    if (!E.ai || lane.len < 120 * M) continue;
    if (E.cls === 'blvd' && lane.right >= 0) pairs.push([lane, R.lanes[lane.right], 'same way']);
    if (E.cls === 'ave') { const o = R.lanes.find(q => q.edge === lane.edge && q.dir !== lane.dir); if (o) pairs.push([lane, o, 'oncoming']); }
  }
  const pick = [...pairs.filter(p => p[2] === 'same way').slice(0, 6), ...pairs.filter(p => p[2] === 'oncoming').slice(0, 6)];
  let contacts = 0, slowed = 0, worstSlow = 0, level = 0, runs = 0, minGap = Infinity, circles = 0;
  for (const [lane, other, kind] of pick) {
    for (const type of ['ursa', 'phantasma']) {
      Object.assign(G, { mode: 'play', cars: [], peds: [], friends: [], wanted: 0 });
      const P = lanePath(lane), s0 = 20 * M, i0 = P.findIndex(p => p.s >= s0);
      const car = L.soloCar(game, 'ursa', P[i0].x, P[i0].y, Math.atan2(P[i0 + 1].y - P[i0].y, P[i0 + 1].x - P[i0].x), 10 * M);
      const sO = kind === 'same way' ? stationOn(other, car.x, car.y) : Math.max(20 * M, stationOn(other, car.x, car.y) - 120 * M);
      const ai = trafficCar(type, other, sO, 10 * M, 1);
      let j = i0, sideT = 0;
      for (let f = 0; f < 60 * 12 && j < P.length - 3; f++) {
        ({ j } = L.trackPath(P, car.x, car.y, j));
        // keep level with a car going the same way; drive on at 12 m/s past one coming the other way
        const v = kind === 'same way' ? Math.max(4 * M, ai.ai.speed) : 12 * M;
        const before = ai.ai ? ai.ai.speed : 0;
        ent.updatePlayer(DT, L.driveAlong(car, P, j, v));
        if (ai.ai && ai.ai.speed < before - 1e-9) { slowed++; worstSlow = Math.max(worstSlow, before - ai.ai.speed); }
        traffic.updateTraffic(DT);
        const d = Math.hypot(ai.x - car.x, ai.y - car.y);
        if (carOverlap(car, ai, O)) contacts++;
        if (d < 8 * M) { minGap = Math.min(minGap, boxGap(car, ai)); if (d < circleR(car) + circleR(ai)) circles++; }
        const lon = Math.abs((ai.x - car.x) * Math.cos(car.a) + (ai.y - car.y) * Math.sin(car.a));
        if (lon < 2 * M) sideT += DT;
      }
      runs++; level += sideT;
    }
  }
  const same = pick.filter(p => p[2] === 'same way').length;
  info(`${runs} runs on ${pick.length} lane pairs (${same} boulevard pairs the same way, ${pick.length - same} avenues oncoming): ${level.toFixed(1)} s level with the other car, closest box gap ${m(minGap)} m; the old circles would have touched in ${circles} frames`);
  check(runs >= 16 && level > 30, `the runs spend time level with the traffic car (${level.toFixed(1)} s in ${runs} runs)`);
  check(contacts === 0, `driving the lane centre beside traffic touches nothing (${contacts} contact frames)`);
  check(slowed === 0, `and never slows the traffic car (${slowed} frames, worst ${m(worstSlow)} m/s)`);
}

// ---------- 4. contacts with traffic, display and parked cars ----------
console.log('contacts');
{
  // one carCollisions on a scripted pair on the runway (flat, open): c is Kimchi's car, o the other
  const X = 400 * M, Y = 1528 * M;
  function pair(oType, dx, dy, oa, cv, ov, setup = o => o) {
    Object.assign(G, { mode: 'play', cars: [], peds: [], friends: [], wanted: 0, shake: 0 });
    const c = ent.makeCar('ursa', X, Y, 0), o = ent.makeCar(oType, X + dx, Y + dy, oa);
    c.vx = cv[0]; c.vy = cv[1]; o.vx = ov[0]; o.vy = ov[1];
    G.cars.push(c, o);
    Object.assign(G.player, { car: c, x: c.x, y: c.y, dead: false });
    setup(o);
    return [c, o];
  }
  const asAI = speed => o => { o.ai = { speed, ghost: 0, through: null }; };
  // a scrape: level with a traffic car in the next lane, both at 12 m/s, Kimchi drifting into its side at 2 m/s
  const wid = (CAR_TYPES.ursa.wid + CAR_TYPES.sedan.wid) / 2;
  let [c, o] = pair('sedan', 0, wid - 0.15 * M, 0, [12 * M, 2 * M], [12 * M, 0], asAI(12 * M));
  ent.carCollisions(c);
  check(Math.abs(o.ai.speed - 12 * M) < 0.01 * M, `a scrape along a traffic car's side leaves it driving (${m(o.ai.speed)} m/s, was 12)`);
  check(!carOverlap(c, o, O) && c.vy < 0, `and pushes Kimchi's car off it (apart: ${!carOverlap(c, o, {})}, ${m(c.vy)} m/s away)`);
  // the same scrape with Kimchi faster: friction drags the traffic car a little, never to a stop
  [c, o] = pair('sedan', 0, wid - 0.15 * M, 0, [20 * M, 3 * M], [12 * M, 0], asAI(12 * M));
  ent.carCollisions(c);
  check(o.ai.speed >= 12 * M && o.ai.speed < 14 * M, `a faster scrape drags it on a little, not to a stop (${m(o.ai.speed)} m/s)`);
  // from behind: Kimchi at 15 m/s into a traffic car doing 8
  const len = (CAR_TYPES.ursa.len + CAR_TYPES.sedan.len) / 2;
  [c, o] = pair('sedan', len - 0.1 * M, 0, 0, [15 * M, 0], [8 * M, 0], asAI(8 * M));
  ent.carCollisions(c);
  check(o.ai.speed > 10 * M && fwdOf(c) < 13 * M, `a knock from behind shoves the traffic car on (${m(o.ai.speed)} m/s, was 8) and slows Kimchi's (${m(fwdOf(c))} m/s, was 15)`);
  // head on: both at 10 m/s
  [c, o] = pair('sedan', len - 0.1 * M, 0, Math.PI, [10 * M, 0], [-10 * M, 0], asAI(10 * M));
  ent.carCollisions(c);
  check(o.ai.speed < 1 * M && fwdOf(c) < 0, `head on, the traffic car stops (${m(o.ai.speed)} m/s, was 10) and Kimchi's bounces back (${m(fwdOf(c))} m/s)`);
  // a traffic car ghosting free of what held it passes through
  [c, o] = pair('sedan', len - 0.5 * M, 0, Math.PI, [0, 0], [-5 * M, 0], o => { o.ai = { speed: 5 * M, ghost: 1, through: null }; });
  ent.carCollisions(c);
  check(o.ai.speed === 5 * M && c.x === X && c.vx === 0, 'a traffic car ghosting free passes through (nothing moves)');
  // a display car stays put and Kimchi's car bounces off it
  [c, o] = pair('monarch', len - 0.1 * M, 0, 0, [5 * M, 0], [0, 0], o => { o.locked = true; });
  const ox = o.x;
  ent.carCollisions(c);
  check(o.x === ox && o.vx === 0 && fwdOf(c) < 0, `a display car does not move (${m(o.x - ox)} m) and Kimchi's bounces off (${m(fwdOf(c))} m/s)`);
  // a parked car: the momentum Kimchi's car loses, the parked car gets
  [c, o] = pair('sedan', len - 0.1 * M, 6, 0.4, [10 * M, 1 * M], [0, 0]);
  const mc = CAR_TYPES.ursa.len * CAR_TYPES.ursa.wid, mo = CAR_TYPES.sedan.len * CAR_TYPES.sedan.wid, p0 = [mc * c.vx, mc * c.vy];
  ent.carCollisions(c);
  const p1 = [mc * c.vx + mo * o.vx, mc * c.vy + mo * o.vy];
  check(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 1e-6 * Math.hypot(...p0) && Math.hypot(o.vx, o.vy) > 3 * M, `a parked car shoved takes the momentum Kimchi's car loses (${m(Math.hypot(o.vx, o.vy))} m/s; momentum kept)`);
  check(o.touched === true, 'and counts as touched (it stays where Kimchi left it)');
}

// ---------- 5. the knock ----------
console.log('knocks');
{
  // a cruiser T-bones Kimchi's standing car on the runway, at the rear corner or through the middle
  function ram(v, at) {
    Object.assign(G, { mode: 'play', cars: [], peds: [], friends: [], wanted: 0, shake: 0 });
    const c = ent.makeCar('ursa', 400 * M, 1528 * M, 0);
    c.hp = 1e6;
    const cop = ent.makeCar('police', c.x + at, c.y + (CAR_TYPES.ursa.wid + CAR_TYPES.police.len) / 2 + 2 * M, -Math.PI / 2);
    cop.vx = 0; cop.vy = -v * M; cop.hp = 1e6;
    G.cars.push(c, cop);
    Object.assign(G.player, { car: c, x: c.x, y: c.y, dead: false });
    let worst = 0, a0 = c.a, hitF = -1;
    for (let f = 0; f < 90; f++) {
      const a = c.a;
      ent.updatePlayer(DT, {});
      ent.driveCar(cop, DT, f < 6 ? { up: true } : { brake: true });
      ent.moveCar(cop, DT, true);
      ent.carCollisions(cop);
      worst = Math.max(worst, Math.abs(L.wrap(c.a - a)));
      if (hitF < 0 && Math.hypot(c.vx, c.vy) > 0.5 * M) hitF = f;
    }
    return { worst, total: Math.abs(L.wrap(c.a - a0)), hit: hitF >= 0 };
  }
  const end = -CAR_TYPES.ursa.len / 2 + CAR_TYPES.police.wid / 2;
  const r10 = ram(10, end), r20 = ram(20, end), r30 = ram(30, end), mid = ram(30, 0);
  for (const [k, r] of [['10 m/s', r10], ['20 m/s', r20], ['30 m/s', r30], ['30 m/s through the middle', mid]])
    info(`${k}: turned ${(r.total * 180 / Math.PI).toFixed(1)}° in all, at most ${(r.worst * 180 / Math.PI).toFixed(2)}° in a frame`);
  check([r10, r20, r30, mid].every(r => r.hit), 'every ram lands');
  const perFrame = 1.4 * DT + 1e-6;
  check([r10, r20, r30, mid].every(r => r.worst <= perFrame), `a ram never turns the car more than 1.4 rad/s (${(perFrame * 180 / Math.PI).toFixed(2)}° a frame): worst ${(Math.max(r10.worst, r20.worst, r30.worst) * 180 / Math.PI).toFixed(2)}°`);
  check(r30.total <= 0.35 + 0.01, `the hardest ram turns it at most 20° (${(r30.total * 180 / Math.PI).toFixed(1)}°)`);
  check(r10.total > 2 * Math.PI / 180 && r10.total < r20.total + 1e-9 && r20.total <= r30.total + 1e-9, 'a harder ram turns it more (10 < 20 <= 30 m/s)');
  check(mid.total < 2 * Math.PI / 180, `a ram through the middle hardly turns it (${(mid.total * 180 / Math.PI).toFixed(2)}°)`);
}

// ---------- 6. streamed parked cars ----------
console.log('parked cars streamed in');
{
  L.seed(6);
  let overlaps = 0, ticks = 0, kept = 0, spots = 0;
  for (const lane of R.lanes.filter(l => R.edges[l.edge].cls === 'ave').slice(0, 12)) {
    const mid = lane.n >> 1;
    Object.assign(G, { mode: 'play', cars: [], peds: [], friends: [], wanted: 0 });
    Object.assign(G.player, { x: lane.x[mid], y: lane.y[mid], car: null, dead: true });
    for (let k = 0; k < 6; k++) ent.updateWorld(0.25, { tier: 'medium' });
    // Kimchi's car parked in one of the bays (that car taken away), then the street streamed again from afar
    const bay = G.cars.find(c => c.parked != null && c.parked >= world.parkedSpawns.length);
    if (!bay) continue;
    spots++;
    const mine = ent.makeCar('ursa', bay.x, bay.y, bay.a);
    pop.clearPopulation();
    G.cars = [mine];
    Object.assign(G.player, { x: lane.x[0] - 400 * M, y: lane.y[0], car: null, dead: true });
    for (let k = 0; k < 6; k++) ent.updateWorld(0.25, { tier: 'medium' });
    Object.assign(G.player, { x: lane.x[mid], y: lane.y[mid] });
    for (let k = 0; k < 12; k++) {
      ent.updateWorld(0.25, { tier: 'medium' });
      ticks++;
      for (let i = 0; i < G.cars.length; i++) for (let j = i + 1; j < G.cars.length; j++) if (!G.cars[i].ai && !G.cars[j].ai && carOverlap(G.cars[i], G.cars[j], O)) overlaps++;
    }
    if (!G.cars.some(c => c !== mine && c.parked != null && carOverlap(c, mine, O))) kept++;
  }
  info(`${spots} streets streamed twice (${ticks} population passes)`);
  check(spots >= 6, `there are bays to test (${spots})`);
  check(overlaps === 0, `no streamed car appears on top of another (${overlaps} overlapping pairs)`);
  check(kept === spots, `a bay Kimchi's car stands in stays empty (${kept} of ${spots})`);
}

// ---------- 7. soak ----------
console.log(`soak: ${SOAK} s of careful lane driving with the live population, seed ${SEED}`);
{
  L.seed(SEED);
  Object.assign(G, { mode: 'play', cars: [], peds: [], friends: [], wanted: 0, energy: 100, shake: 0 });
  let at = R.randomLanePoint({ cls: 'blvd' }) || R.randomLanePoint({});
  const pts = [];
  for (let k = 0; k < 10; k++) {
    const to = R.randomLanePoint({ x: at.x, y: at.y, rMin: 400 * M, rMax: 900 * M });
    const r = to && R.route(at.x, at.y, to.x, to.y, { ai: true });
    if (!r) continue;
    for (let i = 0; i < r.pts.length; i += 2) pts.push({ x: r.pts[i], y: r.pts[i + 1] });
    at = to;
  }
  let s = 0;
  const P = pts.map((p, k) => (p.s = s += k ? Math.hypot(p.x - pts[k - 1].x, p.y - pts[k - 1].y) : 0, p));
  Object.assign(G.player, { x: P[0].x, y: P[0].y, car: null, dead: false });
  ent.spawnWorld(); G.friends = [];
  const car = ent.makeCar('ursa', P[0].x, P[0].y, Math.atan2(P[1].y - P[0].y, P[1].x - P[0].x));
  car.hp = 1e6;
  G.cars.push(car); G.player.car = car;
  let j = 0, contacts = 0, sideStops = 0, endStops = 0, drops = 0, dist = 0;
  for (let f = 0; f < 60 * SOAK && j < P.length - 5; f++) {
    ({ j } = L.trackPath(P, car.x, car.y, j));
    const inp = L.driveAlong(car, P, j, 12 * M);
    // a careful driver: brakes for anything in its own lane within 14 m
    const fx = Math.cos(car.a), fy = Math.sin(car.a);
    for (const o of G.cars) { if (o === car) continue; const dx = o.x - car.x, dy = o.y - car.y, ah = dx * fx + dy * fy; if (ah > 0 && ah < 14 * M && Math.abs(-dx * fy + dy * fx) < 1.6 * M) { inp.up = false; inp.down = fwdOf(car) > 0.5 * M; } }
    const before = new Map(G.cars.filter(o => o.ai).map(o => [o, o.ai.speed]));
    const x0 = car.x, y0 = car.y;
    ent.updatePlayer(DT, inp);
    dist += Math.hypot(car.x - x0, car.y - y0);
    for (const [o, v] of before) {
      if (!o.ai || !(o.ai.speed < v - 1e-9)) continue;
      drops++;
      if (!(v > 1 * M && o.ai.speed < 0.5 * M)) continue;
      // stopped by this contact: from the side (level with Kimchi's car) or end on
      const lon = Math.abs((car.x - o.x) * Math.cos(o.a) + (car.y - o.y) * Math.sin(o.a));
      if (lon < (CAR_TYPES[o.type].len + CAR_TYPES[car.type].len) / 2 - 1 * M) sideStops++; else endStops++;
    }
    for (const o of G.cars) if (o !== car && carOverlap(car, o, O, 0.05 * M)) contacts++;
    G.player.x = car.x; G.player.y = car.y;
    ent.updateWorld(DT);
  }
  info(`${(dist / M / 1000).toFixed(2)} km driven: ${contacts} frames touching a car, ${drops} traffic speed changes by a contact, ${endStops} end-on stops, ${sideStops} side stops; ${(1e6 - car.hp).toFixed(1)} hp of knocks`);
  check(dist > 0.5 * 1000 * M * Math.min(1, SOAK / 120), `the soak drives a fair way (${(dist / M / 1000).toFixed(2)} km)`);
  check(sideStops === 0, `no traffic car is stopped by a side contact (${sideStops})`);
}

console.log(`\nf1 collide: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
