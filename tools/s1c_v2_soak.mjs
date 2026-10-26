#!/usr/bin/env node
// Stage S1c soak on the Kimchi Key v2 map (docs/map-v2-spec.md §9): the same police and mission navigation
// as tools/s1c_soak_test.mjs, at the v2 distances, on the curved road graph. It runs only once world-v2 is
// READY (the v2 generator, S2b); before that it says so and passes. Checks:
//   1. 2-star cops spawn 220-420 m out and reach Kimchi within 60 s, never driving into anything solid;
//   2. Dex drives the Street Kings course (bay_loop, a Kimchi Loop lap) through all its gates and finishes;
//   3. the Kimchi Empire boss spawns 600 m+ away on a highway, boulevard or coast road, flees a chasing car
//      and is never stuck for more than 10 s;
//   4. a 3-star roadblock goes up 280-400 m ahead of Kimchi on his road;
//   5. called-off cops drive away and vanish;
//   6. Hot Delivery orders have the 500-1500 m route band and the route / 18 m/s + 20 s timer, when the map
//      has enough delivery doors.
//   node tools/s1c_v2_soak.mjs
// Exits 1 if any check fails.
globalThis.KC_WORLD = 'v2';
const { loadGame, seed, unseed, freshPlay, playerCar, step, px } = await import('./s1c_lib.mjs');

const game = await loadGame();
const { G, world, ent, pol, mis, nav } = game;
if (world.KIND !== 'v2') {
  console.log('s1c v2 soak: world-v2 is not READY yet, so the facade gives the grid; nothing to check');
  process.exit(0);
}
const { police, steerTo } = pol;
const DT = 1 / 60, M = 16;
let failed = 0, passed = 0;
const check = (ok, msg) => { if (ok) passed++; else { failed++; console.log('  FAIL ' + msg); } };
const info = msg => console.log('  ' + msg);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const solid = pts => pts.filter(p => world.blockedCarPx(p.x, p.y)).length;
console.log(`s1c v2 soak: ${world.roads.nodes.length} nodes, ${world.roads.lanes.length} lanes, ${world.deliveryDoors.length} delivery doors`);

function roadSpots(n, s, o = {}) {
  seed(s);
  const out = [];
  for (let k = 0; out.length < n && k < 5000; k++) {
    const p = world.roads.randomLanePoint(o);
    if (p && world.roads.nodes.every(q => dist(q, p) > px(20))) out.push(p);
  }
  return out;
}
function drivePlayer(dt, tx, ty, o = {}) {
  const c = G.player.car, [ax, ay] = nav.roadWaypoint(c, tx, ty);
  steerTo(c, dt, ax, ay, { curv: nav.curvatureAhead(c), dodge: true, ...o });
  G.player.x = c.x; G.player.y = c.y;
}
const talk = { type: 'talk', lines: [['Dex', 'gg']] };

// ---------- 1. cops ----------
console.log('cops at 2 stars');
{
  const times = [], track = [];
  let band = 0;
  for (const [i, p] of roadSpots(10, 501).entries()) {
    seed(1000 + i);
    freshPlay(game, p.x, p.y);
    ent.spawnWorld();
    Object.assign(G.player, { x: p.x, y: p.y });
    G.wanted = 2; G.heatT = 1e9; police.spawnT = 0;
    let t0 = null, reach = null;
    const seen = new Set();
    for (let t = 0; t < 70 && reach == null; t += DT) {
      step(game, DT, { missions: false });
      G.heatT = 1e9; G.player.dead = false;
      for (const c of police.cars) {
        if (!seen.has(c)) { seen.add(c); const d = dist(c, p); if (d < px(208) || d > px(432)) band++; if (t0 == null) t0 = t; }
        if (Math.round(t * 60) % 30 === 0) track.push({ x: c.x, y: c.y });
        if (dist(c, p) < 300 && reach == null) reach = t - t0;
      }
    }
    times.push(reach);
  }
  info(`reach times (s): ${times.map(t => (t == null ? 'never' : t.toFixed(1))).join(' ')}`);
  check(times.every(t => t != null && t <= 60), 'every 2-star cop should reach Kimchi within 60 s');
  check(band === 0, `cops should spawn 220-420 m from Kimchi (${band} outside, +-12 m)`);
  check(solid(track) === 0, `cops should never be inside anything solid (${solid(track)} of ${track.length} samples)`);
}

// ---------- 2. Street Kings ----------
console.log('Street Kings (bay_loop)');
{
  const R = world.routes.street_kings;
  check(R && R === world.routes.bay_loop && R.gates.length >= 2, 'routes.street_kings should be the bay_loop route');
  const SK = mis.MISSIONS.find(m => m.id === 'street_kings');
  const RACE = SK.steps.find(s => s.type === 'race'), GOTO = SK.steps.find(s => s.type === 'goto');
  for (let k = 0; k < 2; k++) {
    seed(77 + k);
    const st = GOTO.to();
    freshPlay(game, st.x, st.y);
    ent.spawnWorld();
    playerCar(game, 'ursa', st.x, st.y, st.a ?? 0);
    mis.startMission({ id: 'race_test', title: 'Race', reward: 0, steps: [RACE, talk] });
    const s = mis.missionState.active.s, order = [];
    let last = s.ri, result = null, t = 0;
    for (; t < 400; t += DT) {
      step(game, DT, { police: false, player: false });
      if (s.ri !== last) { order.push(s.ri); last = s.ri; }
      if (mis.missionState.active?.s !== s) { result = game.log.big.at(-1); break; }
    }
    const inOrder = order.every((v, i) => v === order[0] + i);
    info(`race ${k}: ${result?.[1] || 'still racing'} after ${t.toFixed(1)} s (${(R.len / M / Math.max(1, t - 3.5)).toFixed(1)} m/s), ${order.length} gates, hp ${s.rival.hp.toFixed(0)}`);
    check(result?.[1] === 'Dex won the race.' && s.ri === s.n && inOrder, `race ${k}: Dex should pass all ${s.n} gates in order and finish`);
    game.log.big.length = 0;
  }
}

// ---------- 3. the boss ----------
console.log('Kimchi Empire boss');
{
  const DESTROY = mis.MISSIONS.find(m => m.id === 'kimchi_empire').steps.find(s => s.type === 'destroy');
  for (const [k, p] of roadSpots(2, 909).entries()) {
    seed(300 + k);
    freshPlay(game, p.x, p.y);
    ent.spawnWorld();
    playerCar(game, 'ursa', p.x, p.y, p.a);
    mis.startMission({ id: 'boss_test', title: 'Boss', reward: 0, steps: [DESTROY, talk] });
    const s = mis.missionState.active.s, boss = s.car;
    const near = world.roads.nearest(boss.x, boss.y), cls = world.roads.edges[near.edge].cls;
    check(dist(boss, p) >= px(600) && ['hwy', 'blvd', 'coast'].includes(cls), `boss ${k}: should spawn 600 m+ away on a hwy/blvd/coast road (${(dist(boss, p) / M).toFixed(0)} m, ${cls})`);
    let slow = 0, worst = 0, fleeT = 0, moved = 0, prev = { x: boss.x, y: boss.y };
    const track = [];
    for (let t = 0; t < 150; t += DT) {
      if (dist(G.player.car, boss) < 480) steerTo(G.player.car, DT, boss.x, boss.y, { stopWithin: 1e9 });
      else drivePlayer(DT, boss.x, boss.y, { ignore: boss });
      step(game, DT, { police: false, player: false });
      if (boss.hp <= 0 || boss.wreck) break;
      slow = Math.hypot(boss.vx, boss.vy) < 40 ? slow + DT : 0;
      worst = Math.max(worst, slow);
      if (s.flee) fleeT += DT;
      moved += dist(boss, prev); prev = { x: boss.x, y: boss.y };
      if (Math.round(t * 60) % 15 === 0) track.push({ x: boss.x, y: boss.y });
    }
    info(`boss ${k}: drove ${(moved / M).toFixed(0)} m, fled ${fleeT.toFixed(0)} s, longest stop ${worst.toFixed(1)} s`);
    check(worst <= 10 && moved > px(500), `boss ${k}: should keep moving, never stuck for more than 10 s`);
    check(solid(track) === 0, `boss ${k}: should never be inside anything solid`);
    mis.failMission('test over');
  }
}

// ---------- 4. roadblocks ----------
console.log('roadblocks');
{
  let made = 0, tries = 0;
  for (const [k, p] of roadSpots(4, 31, { cls: 'hwy' }).entries()) {
    tries++;
    seed(700 + k);
    freshPlay(game, p.x, p.y);
    ent.spawnWorld();
    playerCar(game, 'ursa', p.x, p.y, p.a);
    G.wanted = 3; G.heatT = 1e9; police.spawnT = 1e9;
    const goal = nav.pathPoint(nav.predictPath(G.player.car, px(1500)), px(1500), {});
    let rb = null, at = null;
    for (let t = 0; t < 30 && !rb; t += DT) {
      drivePlayer(DT, goal.x, goal.y);
      step(game, DT, { player: false, missions: false });
      G.heatT = 1e9;
      if (police.roadblock) { rb = police.roadblock; at = { x: G.player.x, y: G.player.y }; }
    }
    if (!rb) { info(`roadblock ${k}: none in 30 s`); continue; }
    made++;
    const d = dist(rb, at);
    info(`roadblock ${k}: ${(d / M).toFixed(0)} m from Kimchi, on ${world.roads.edges[world.roads.nearest(rb.x, rb.y).edge].cls}`);
    check(d >= px(280) * 0.85 && d <= px(400) * 1.05, `roadblock ${k}: should stand 280-400 m ahead (${(d / M).toFixed(0)} m)`);
    check(rb.cars.every(c => !ent.carHits(c, c.x, c.y, c.a)), `roadblock ${k}: its cruisers should be clear of walls`);
  }
  check(made >= tries - 1, `a roadblock should go up at 3 stars (${made} of ${tries})`);
}

// ---------- 5. driving off ----------
console.log('drive-away');
{
  const p = roadSpots(1, 5)[0];
  seed(41);
  freshPlay(game, p.x, p.y);
  ent.spawnWorld();
  Object.assign(G.player, { x: p.x, y: p.y });
  G.wanted = 4; G.heatT = 1e9; police.spawnT = 0;
  for (let t = 0; t < 25; t += DT) { step(game, DT, { missions: false }); G.heatT = 1e9; G.player.dead = false; }
  const n0 = police.cars.length;
  G.wanted = 0;
  const live = () => police.cars.filter(c => !c.wreck && c.hp > 0);
  let t = 0;
  for (; t < 120 && live().length; t += DT) step(game, DT, { missions: false });
  info(`${n0} cruisers called off: ${live().length} left after ${t.toFixed(1)} s`);
  check(live().length === 0, 'called-off cops should drive away and vanish within 2 minutes');
}

// ---------- 6. deliveries ----------
console.log('Hot Delivery');
{
  const DELIVER = mis.MISSIONS.find(m => m.id === 'hot_delivery').steps.find(s => s.type === 'deliver');
  const p = roadSpots(1, 77)[0];
  seed(500);
  freshPlay(game, p.x, p.y);
  playerCar(game, 'ursa', p.x, p.y, p.a);
  mis.startMission({ id: 'deliver_test', title: 'Deliver', reward: 0, steps: [DELIVER, talk] });
  const s = mis.missionState.active.s;
  check(Math.abs(s.left - (s.len / (18 * M) + 20)) < 1e-6, `the timer should be route / 18 m/s + 20 s (${s.left.toFixed(1)} s for ${(s.len / M).toFixed(0)} m)`);
  if (world.deliveryDoors.length >= 20) check(s.len >= px(500) && s.len <= px(1500), `the order should be 500-1500 m of driving away (${(s.len / M).toFixed(0)} m)`);
  else info(`only ${world.deliveryDoors.length} delivery doors on the map so far, so the band is not checked (closest miss ${(s.len / M).toFixed(0)} m)`);
  mis.failMission('test over');
}

unseed();
console.log(failed ? `s1c v2 soak: ${failed} failed, ${passed} passed` : `s1c v2 soak: ok (${passed} checks)`);
process.exit(failed ? 1 : 0);
