#!/usr/bin/env node
// Fix stage F2 (navigation) checks on the Kimchi Key v2 map, with the game's sim headless (tools/s1c_lib.mjs):
//   1. the carriageway (nav.onCarriageway) is the lanes and road decks, not the runway, car parks, sidewalks or
//      people-only decks; a car well off the network may still pass a car over open ground;
//   2. driveways, through F3's data contract (place.approach = [{x, y}, ...] px, from the lane point nearest
//      a place to its curb): a nav-driven car reaches the marina, jet and villa kerbs, which lie 19-40 m off
//      the road graph round corners, and drives back out to the road when it leaves. The map's own approach
//      is used when it has one; until then the test lays the same polyline (a search from the curb to the
//      nearest lane point, the way F3 describes it). Without any, nav's own search finds the way in;
//   3. a car on the road past a driveway's mouth keeps to the road;
//   4. a car knocked off the road behind the Venetian causeway's guardrail finds its way back onto it;
//   5. a plan that needs a search stays cheap;
//   6. with the 3D game's driving (CFG_3D, half the acceleration), a car that has backed up off something that
//      is then gone drives on: no type backs up a second time on the open road.
//   node tools/f2_v2_test.mjs
// Exits 1 if any check fails; passes with a note while world-v2 is not READY.
globalThis.KC_WORLD = 'v2';
const { loadGame, seed, unseed, freshPlay, playerCar, step, ROOT } = await import('./s1c_lib.mjs');

const game = await loadGame(ROOT);
const { G, world, ent, nav, pol } = game;
if (world.KIND !== 'v2') {
  console.log('f2 v2: world-v2 is not READY, so the facade gives the grid; nothing to check');
  process.exit(0);
}
const { roads } = world;
const { steerTo } = pol;
const DT = 1 / 60, M = 16;
let failed = 0, passed = 0;
const check = (ok, msg) => { if (ok) passed++; else { failed++; console.log('  FAIL ' + msg); } };
const info = msg => console.log('  ' + msg);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const kind = (x, y) => world.surfaceAt(x, y) & 15;
const overHalf = (x, y) => { const q = roads.nearest(x, y, { maxD: 80 * M }); return q ? q.d - roads.edges[q.edge].halfW : Infinity; };
console.log(`f2 v2: ${roads.nodes.length} nodes, ${roads.lanes.length} lanes, ${Object.keys(world.places).length} places`);

// ---------- 1. the carriageway ----------
console.log('carriageway');
{
  seed(11);
  let lanes = 0;
  for (let i = 0; i < 300; i++) { const p = roads.randomLanePoint({ ai: false }); if (nav.onCarriageway(p.x, p.y)) lanes++; }
  check(lanes === 300, `every lane point is carriageway (${lanes}/300)`);
  // every 4 m over the map: road and deck cells by their distance from the network, lots and sidewalks
  const n = { roadIn: 0, roadInYes: 0, roadOff: 0, roadOffYes: 0, deckIn: 0, deckInYes: 0, deckOff: 0, deckOffYes: 0, other: 0, otherYes: 0 };
  const B = world.BOUNDS;
  for (let y = B.y0 + 8; y < B.y1; y += 64) for (let x = B.x0 + 8; x < B.x1; x += 64) {
    const k = kind(x, y), yes = nav.onCarriageway(x, y);
    if (k === world.ROAD || k === world.DECK) {
      const over = overHalf(x, y), tag = (k === world.ROAD ? 'road' : 'deck') + (over <= 0 ? 'In' : over > 6 * M ? 'Off' : null);
      if (tag.endsWith('null')) continue;
      n[tag]++; if (yes) n[tag + 'Yes']++;
    } else if (k === world.LOT || k === world.WALK || k === world.PLAZA) { n.other++; if (yes) n.otherYes++; }
  }
  info(`road cells on the network ${n.roadInYes}/${n.roadIn}, off it (the runway, aprons) ${n.roadOffYes}/${n.roadOff}; deck cells on it ${n.deckInYes}/${n.deckIn}, off it (piers, the Riverwalk) ${n.deckOffYes}/${n.deckOff}; lots, sidewalks, plazas ${n.otherYes}/${n.other}`);
  check(n.roadIn > 1000 && n.roadInYes === n.roadIn && n.deckIn > 50 && n.deckInYes === n.deckIn, 'road and deck cells within the roads are carriageway');
  check(n.roadOff > 100 && n.roadOffYes === 0, 'road cells away from the road network (the runway) are not');
  check(n.deckOff > 10 && n.deckOffYes === 0, 'people-only decks are not');
  check(n.other > 1000 && n.otherYes === 0, 'car parks, sidewalks and plazas are not');

  // off the network (the golf course), a car may pass a stopped car over the grass
  let spot = null;
  for (let z = 720; z < 930 && !spot; z += 6) for (let x = 570; x < 660 && !spot; x += 6) {
    const p = { x: x * M, y: z * M };
    if (nav.offNetwork(p.x, p.y) && nav.lineDrivable(p.x - 40 * M, p.y, p.x + 40 * M, p.y, 6 * M)) spot = p;
  }
  check(spot, 'a car-sized open stretch off the network on the golf course');
  if (spot) {
    const c = ent.makeCar('police', spot.x - 20 * M, spot.y, 0), o = ent.makeCar('sedan', spot.x - 8 * M, spot.y, 0);
    c.vx = 10 * M;
    G.cars = [c, o];
    const out = [0, 0], cap = nav.dodge(c, spot.x + 20 * M, spot.y, out);
    check(cap === Infinity && Math.abs(out[1] - spot.y) > 2 * M, `off the network it passes the stopped car over the grass (aim ${((out[1] - spot.y) / M).toFixed(1)} m to the side)`);
    G.cars = [];
  }
}

// ---------- 2. driveways ----------
// world-v2 builds place.approach (stage F3). For a map without one, the test lays the approach F3 describes: from the curb, over cells a car fits in (1.2 m clear each way), to the first
// carriageway cell; then the lane point nearest that, first; corners pulled tight.
const roomy = (x, y) => [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].every(([u, v]) => !world.blockedCarPx(x + u * 1.2 * M, y + v * 1.2 * M));
function layApproach(curb) {
  const R = 80, n = 2 * R + 1, from = new Int32Array(n * n).fill(-2);
  const X = k => curb.x + ((k % n) - R) * M, Y = k => curb.y + (((k / n) | 0) - R) * M;
  const q = [R * n + R];
  from[q[0]] = -1;
  for (let i = 0; i < q.length; i++) {
    const k = q[i];
    if (i && nav.onCarriageway(X(k), Y(k))) {
      const xs = [], ys = [];
      for (let j = k; j >= 0; j = from[j]) { xs.push(X(j)); ys.push(Y(j)); }
      xs[xs.length - 1] = curb.x; ys[ys.length - 1] = curb.y;
      const ln = roads.nearestLane(xs[0], ys[0]);
      xs.unshift(ln.x); ys.unshift(ln.y);
      const out = [{ x: xs[0], y: ys[0] }];
      for (let a = 0; a < xs.length - 1;) {
        let b = a + 1;
        while (b + 1 < xs.length && nav.lineDrivable(xs[a], ys[a], xs[b + 1], ys[b + 1])) b++;
        out.push({ x: xs[b], y: ys[b] });
        a = b;
      }
      return out;
    }
    const ci = k % n, cj = (k / n) | 0;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const ni = ci + di, nj = cj + dj, k2 = nj * n + ni;
      if (ni < 0 || nj < 0 || ni >= n || nj >= n || from[k2] !== -2) continue;
      if (!roomy(X(k2), Y(k2))) { from[k2] = -3; continue; }
      from[k2] = k;
      q.push(k2);
    }
  }
  return null;
}
const polyLen = a => a.reduce((s, q, i) => (i ? s + dist(q, a[i - 1]) : 0), 0);
// An approach's points, [{x, y}, ...], from either shape: world-v2's { pts: Float32Array, n, ... } or a list.
const wayPts = a => !a ? null : a.pts ? Array.from({ length: a.n ?? a.pts.length >> 1 }, (_, i) => ({ x: a.pts[2 * i], y: a.pts[2 * i + 1] })) : a;

// The AI driver the S1c soaks give Kimchi's car: nav plus police.steerTo, braking to stop near its target.
function driveTo(c, tx, ty, secs, near) {
  let t = 0;
  for (; t < secs; t += DT) {
    const d = Math.hypot(c.x - tx, c.y - ty);
    if (d < near) return t;
    const [ax, ay] = nav.roadWaypoint(c, tx, ty);
    steerTo(c, DT, ax, ay, { curv: nav.curvatureAhead(c), dodge: true, stopWithin: d < 8 * M ? 1e9 : 0 });
    G.player.x = c.x; G.player.y = c.y;
    step(game, DT, { player: false, police: false, missions: false });
  }
  return null;
}

console.log('driveways');
const KERBS = ['marina', 'jet', 'home'];
const laid = {};
{
  for (const k of KERBS) {
    const p = world.places[k], c = p.curb;
    const q = roads.nearest(c.x, c.y);
    const end = roads.route(c.x + 400 * M, c.y, c.x, c.y);
    info(`${k}: curb ${(q.d / M).toFixed(1)} m from ${roads.edges[q.edge].road}; ${p.approach ? `the map's approach, ${wayPts(p.approach).length} points, ${(polyLen(wayPts(p.approach)) / M).toFixed(0)} m` : 'no approach on the map yet'}`);
    if (!p.approach) { p.approach = layApproach(c); laid[k] = true; }
    const a = wayPts(p.approach);
    check(a && a.length >= 2 && dist(a[a.length - 1], c) < 2 * M && nav.onCarriageway(a[0].x, a[0].y), `${k}: an approach from a lane point to the curb (${a ? `${a.length} points, ${(polyLen(a) / M).toFixed(0)} m` : 'none'})`);
  }
  // a plan to a kerb is the road to the driveway's first point, then the driveway to the curb
  seed(5);
  for (const k of KERBS) {
    const p = world.places[k], a = wayPts(p.approach);
    const st = roads.randomLanePoint({ x: p.curb.x, y: p.curb.y, rMin: 250 * M, rMax: 450 * M });
    freshPlay(game, st.x, st.y);
    const c = playerCar(game, 'ursa', st.x, st.y, st.a);
    G.t = 1;
    nav.roadWaypoint(c, p.curb.x, p.curb.y);
    const P = c.nav.pts, n = P.length >> 1, last = { x: P[2 * n - 2], y: P[2 * n - 1] };
    let viaStart = Infinity;
    for (let i = 0; i < n; i++) viaStart = Math.min(viaStart, dist({ x: P[2 * i], y: P[2 * i + 1] }, a[0]));
    check(dist(last, p.curb) < 0.5 * M && viaStart < 1 * M, `${k}: the plan runs to the driveway's first point and on up to the curb (ends ${(dist(last, p.curb) / M).toFixed(2)} m from it, passes ${(viaStart / M).toFixed(2)} m from the driveway's start)`);
  }
  // driving: to each kerb from 250-450 m out with traffic about, then away again to a lane 400 m+ off. Then
  // the same without any approach on the map: nav's own search finds the way in.
  for (const mode of ['approach', 'search']) {
    const keep = {};
    if (mode === 'search') for (const k of KERBS) { keep[k] = world.places[k].approach; world.places[k].approach = undefined; }
    seed(mode === 'approach' ? 21 : 22);
    for (const k of KERBS) {
      const p = world.places[k];
      const st = roads.randomLanePoint({ x: p.curb.x, y: p.curb.y, rMin: 250 * M, rMax: 450 * M });
      freshPlay(game, st.x, st.y);
      ent.spawnWorld();
      const c = playerCar(game, 'ursa', st.x, st.y, st.a);
      G.t = 1;
      const tIn = driveTo(c, p.curb.x, p.curb.y, 150, 12 * M);
      const far = roads.randomLanePoint({ x: p.curb.x, y: p.curb.y, rMin: 400 * M, rMax: 700 * M });
      let tRoad = null, t = 0;
      if (tIn != null) for (; t < 30 && tRoad == null; t += DT) {
        const [ax, ay] = nav.roadWaypoint(c, far.x, far.y);
        steerTo(c, DT, ax, ay, { curv: nav.curvatureAhead(c), dodge: true });
        step(game, DT, { player: false, police: false, missions: false });
        if (nav.onCarriageway(c.x, c.y)) tRoad = t;
      }
      info(`${mode}, ${k}: from ${(dist(st, p.curb) / M).toFixed(0)} m out, at the kerb after ${tIn?.toFixed(1)} s; back on the road ${tRoad?.toFixed(1)} s after leaving`);
      check(tIn != null, `${mode}: a nav-driven car reaches the ${k} kerb (within 12 m) in 150 s`);
      check(tRoad != null, `${mode}: leaving the ${k} kerb, it drives back out to the road within 30 s`);
    }
    if (mode === 'search') for (const k of KERBS) world.places[k].approach = keep[k];
  }

  // a car on the road going past a driveway's mouth keeps to the road
  for (const k of KERBS) {
    const a = wayPts(world.places[k].approach), L = roads.nearestLane(a[0].x, a[0].y);
    const lane = roads.lanes[L.lane], s0 = Math.max(0, L.s - 10 * M), q = roads.lanePoint(L.lane, s0);
    freshPlay(game, q.x, q.y);
    const c = playerCar(game, 'ursa', q.x, q.y, q.a);
    c.vx = Math.cos(q.a) * 10 * M; c.vy = Math.sin(q.a) * 10 * M;
    const tgt = roads.lanePoint(L.lane, Math.min(lane.len, s0 + 60 * M));
    G.t = 1;
    nav.roadWaypoint(c, tgt.x, tgt.y);
    const P = c.nav.pts;
    let off = 0;
    for (let i = 0; i < P.length; i += 2) if (!nav.onCarriageway(P[i], P[i + 1])) off++;
    check(off === 0, `${k}: a car driving past the driveway's mouth keeps to the road (${off} plan points off it)`);
  }
}

// ---------- 4. the way back onto the road ----------
// Spots on the grass beside the Venetian causeway that its guardrail cuts off from the nearest lane.
console.log('the way back');
{
  const cut = [];
  for (const e of roads.edges) {
    if (e.road !== 'venetian' || cut.length >= 4) continue;
    for (let i = 0; i < e.n && cut.length < 4; i += 8) for (const side of [1, -1]) {
      const x = e.x[i] - e.ty[i] * side * (e.halfW + 7 * M), y = e.y[i] + e.tx[i] * side * (e.halfW + 7 * M);
      const q = roads.nearest(x, y);
      if (kind(x, y) === world.GRASS && roomy(x, y) && !nav.lineDrivable(x, y, q.x, q.y) && !cut.some(p => dist(p, { x, y }) < 60 * M)) cut.push({ x, y, a: Math.atan2(q.y - y, q.x - x) });
    }
  }
  check(cut.length >= 2, `spots by the causeway that its rail cuts off from the road (${cut.length})`);
  let back = 0, worst = 0;
  for (const p of cut) {
    freshPlay(game, p.x, p.y);
    ent.spawnWorld();
    const c = playerCar(game, 'ursa', p.x, p.y, p.a);
    const tgt = roads.randomLanePoint({ x: p.x, y: p.y, rMin: 250 * M, rMax: 400 * M });
    G.t = 1;
    const t0 = performance.now();
    nav.roadWaypoint(c, tgt.x, tgt.y);
    worst = Math.max(worst, performance.now() - t0);
    let tRoad = null;
    for (let t = 0; t < 40 && tRoad == null; t += DT) {
      const [ax, ay] = nav.roadWaypoint(c, tgt.x, tgt.y);
      steerTo(c, DT, ax, ay, { curv: nav.curvatureAhead(c), dodge: true });
      step(game, DT, { player: false, police: false, missions: false });
      if (nav.onCarriageway(c.x, c.y)) tRoad = t;
    }
    info(`cut off at (${(p.x / M).toFixed(0)}, ${(p.y / M).toFixed(0)}) m: back on the road after ${tRoad?.toFixed(1)} s, hp ${c.hp.toFixed(0)}`);
    if (tRoad != null) back++;
  }
  check(back === cut.length, `every car cut off from the road by the rail finds its way back within 40 s (${back}/${cut.length})`);
  info(`a plan with a search took at most ${worst.toFixed(2)} ms`);
  check(worst < 15, `a plan that needs a search stays cheap (${worst.toFixed(2)} ms)`);
}

// ---------- 6. after a back-up, on the open road ----------
// Held still with its foot down until it backs up, then let go with its aim 60 m up the lane: it should drive
// on. Measured from where its reversing ended, with the time it rolls backward left out; while the window ran
// on from before the back-up, a van, a hatchback or a sedan at the 3D game's acceleration could not win back
// the distance it had reversed in time, and backed up a second time every time.
console.log('after a back-up');
{
  const { CFG_3D } = await import('./s6a_lib.mjs');
  const keep = { ...ent.CFG };
  Object.assign(ent.CFG, CFG_3D);
  seed(5);
  const again = {}, tried = {};
  for (const type of ['van', 'hatch', 'sedan', 'police', 'ursa', 'bolide']) {
    again[type] = tried[type] = 0;
    for (let k = 0; k < 12; k++) {
      const p = roads.randomLanePoint({}), L = roads.lanes[p.lane];
      if (p.s > L.len - 80 * M) continue;
      freshPlay(game, 0, 0);
      G.t = 1;
      const c = ent.makeCar(type, p.x, p.y, p.a);
      G.cars = [c];
      const a = roads.lanePoint(p.lane, p.s + 60 * M);
      for (let t = 0; t < 5 && !(c.drv && c.drv.revT > 0); t += DT) {
        const x = c.x, y = c.y;
        steerTo(c, DT, a.x, a.y, {});
        c.x = x; c.y = y; c.vx = c.vy = 0;
        G.t += DT;
      }
      if (!(c.drv && c.drv.revT > 0)) continue;
      tried[type]++;
      let backs = 0, was = true;
      for (let t = 0; t < 4; t += DT) {
        steerTo(c, DT, a.x, a.y, {});
        G.t += DT;
        const r = c.drv.revT > 0;
        if (r && !was) backs++;
        was = r;
      }
      if (backs) again[type]++;
    }
  }
  Object.assign(ent.CFG, keep);
  G.cars = [];
  const list = Object.keys(tried).map(k => `${k} ${again[k]}/${tried[k]}`).join(', ');
  info(`backed up a second time: ${list}`);
  check(Object.values(tried).every(n => n >= 4), `each type got stuck and backed up on several lanes (${list})`);
  check(Object.values(again).every(n => n === 0), `no type backs up a second time on the open road (${list})`);
}

for (const k of Object.keys(laid)) world.places[k].approach = undefined;
unseed();
console.log(failed ? `f2 v2: ${failed} failed, ${passed} passed` : `f2 v2: ok (${passed} checks)`);
process.exit(failed ? 1 : 0);
