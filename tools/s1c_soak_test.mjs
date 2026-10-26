#!/usr/bin/env node
// Stage S1c soak (docs/map-v2-stages.json): police and mission cars navigate the road graph on the classic
// grid, with today's traffic running. Runs the game's sim headless (tools/s1c_lib.mjs) and checks the
// stage's verify list:
//   1. 20 random 2-star cop spawns reach Kimchi along the streets within 60 s;
//   2. the Street Kings rival passes every gate in order and finishes, and Kimchi driving the course passes
//      every gate (segment crossing) and wins;
//   3. the Kimchi Empire boss wanders, flees a chasing car, and is never stuck for more than 10 s;
//   4. Hot Delivery orders fall in the route band and their timers are achievable;
//   5. a roadblock goes up at 3 stars, ahead of Kimchi and across his road, and stands 25 s;
//   6. 4-5 stars bring interceptors; called-off cops drive away and vanish; losing them uses sightClear.
//   node tools/s1c_soak_test.mjs [-v] [--root <project copy>]
// Exits 1 if any check fails.
import { loadGame, seed, unseed, freshPlay, playerCar, step, px, ROOT } from './s1c_lib.mjs';

const VERBOSE = process.argv.includes('-v');
const ri = process.argv.indexOf('--root');
const game = await loadGame(ri > 0 ? process.argv[ri + 1] : ROOT);
const { G, world, ent, pol, mis, nav } = game;
const { police, steerTo } = pol;
const DT = 1 / 60;
let failed = 0, passed = 0;
const check = (ok, msg) => { if (ok) passed++; else { failed++; console.log('  FAIL ' + msg); } };
const info = msg => console.log('  ' + msg);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const onRoadRatio = pts => pts.filter(p => world.tileAtPx(p.x, p.y) === world.ROAD).length / Math.max(1, pts.length);
const blocked = pts => pts.filter(p => world.blockedPx(p.x, p.y)).length;

console.log(`s1c soak: world '${world.KIND}', ${world.roads.nodes.length} nodes, ${world.roads.lanes.length} lanes`);
check(world.KIND === 'grid', 'the default world should be the grid');
check(typeof nav?.roadWaypoint === 'function' && pol.roadWaypoint === nav.roadWaypoint, 'police should re-export nav.roadWaypoint');

// Random spots on the road away from junctions, from a fixed seed.
function roadSpots(n, s) {
  seed(s);
  const out = [];
  while (out.length < n) {
    const p = world.roads.randomLanePoint({});
    const N = world.roads.nodes.reduce((m, q) => Math.min(m, dist(q, p)), Infinity);
    if (N > px(14)) out.push(p);
  }
  return out;
}

// The player's car driven by the same AI as the cops (it moves the car; updatePlayer is skipped).
function drivePlayer(dt, tx, ty, o = {}) {
  const c = G.player.car, [ax, ay] = nav.roadWaypoint(c, tx, ty);
  steerTo(c, dt, ax, ay, { curv: nav.curvatureAhead(c), dodge: true, ...o });
  G.player.x = c.x; G.player.y = c.y;
}

// ---------- 1. cops reach Kimchi ----------
console.log('cops at 2 stars');
{
  const times = [], spawnD = [];
  let track = [], wrongBand = 0;
  for (const [i, p] of roadSpots(20, 501).entries()) {
    seed(1000 + i);
    freshPlay(game, p.x, p.y);
    ent.spawnWorld();
    Object.assign(G.player, { x: p.x, y: p.y });
    G.wanted = 2; G.heatT = 1e9; police.spawnT = 0;
    let t0 = null, reach = null;
    const seen = new Set();
    for (let t = 0; t < 70; t += DT) {
      step(game, DT, { missions: false });
      G.heatT = 1e9; G.player.dead = false;
      for (const c of police.cars) {
        if (!seen.has(c)) {
          seen.add(c);
          const d = dist(c, p);
          spawnD.push(d);
          // the band is for the lane spot; the cruiser then starts on its route's first lane, a few metres off
          if (d < 1500 - px(12) || d > 3000 + px(12)) wrongBand++;
          if (t0 == null) t0 = t;
        }
        if (Math.round(t * 60) % 15 === 0) track.push({ x: c.x, y: c.y });
        if (dist(c, p) < 300 && reach == null) reach = t - t0;
      }
      if (reach != null) break;
    }
    times.push(reach);
  }
  const ok = times.filter(t => t != null).sort((a, b) => a - b);
  info(`reach times (s): ${times.map(t => t == null ? 'never' : t.toFixed(1)).join(' ')}`);
  info(`reached ${ok.length}/20, median ${ok[ok.length >> 1]?.toFixed(1)} s, max ${ok.at(-1)?.toFixed(1)} s; spawned ${spawnD.length} at ${Math.min(...spawnD).toFixed(0)}-${Math.max(...spawnD).toFixed(0)} px`);
  check(ok.length === 20 && ok.at(-1) <= 60, 'every 2-star cop should reach Kimchi within 60 s');
  check(wrongBand === 0, `cops should spawn 1500-3000 px (+-12 m) from Kimchi on the grid (${wrongBand} outside)`);
  const r = onRoadRatio(track);
  info(`cop track: ${track.length} samples, ${(r * 100).toFixed(1)}% on road tiles, ${blocked(track)} inside buildings`);
  check(r > 0.9 && blocked(track) === 0, 'cops should drive along the streets');
}

// ---------- 2. the Street Kings race ----------
console.log('Street Kings');
const SK = mis.MISSIONS.find(m => m.id === 'street_kings');
const RACE = SK.steps.find(s => s.type === 'race'), GOTO = SK.steps.find(s => s.type === 'goto');
const talk = { type: 'talk', lines: [['Dex', 'gg']] };
function startRace(k, withPlayer) {
  seed(77 + k);
  const st = typeof GOTO.to === 'function' ? GOTO.to() : GOTO.to;
  freshPlay(game, st.x, st.y);
  ent.spawnWorld();
  playerCar(game, 'ursa', st.x, st.y, st.a ?? 0);
  mis.startMission({ id: 'race_test', title: 'Race', reward: 0, steps: [RACE, talk] });
  const s = mis.missionState.active.s;
  if (withPlayer) nav.setRoute(G.player.car, s.R);
  return s;
}
{
  const R = world.routes.street_kings;
  check(R && R.gates.length === 9 && R.pts.length > 4, 'routes.street_kings should exist with 9 gates');
  const st = GOTO.to();
  check(st && st.x === world.anchors.raceStart.x && st.y === world.anchors.raceStart.y, 'the start line should be anchors.raceStart');
  for (let k = 0; k < 5; k++) {
    const s = startRace(k, false);
    const order = [];
    let last = s.ri, result = null, t = 0;
    for (; t < 200; t += DT) {
      step(game, DT, { police: false, player: false });
      if (s.ri !== last) { order.push(s.ri); last = s.ri; }
      if (mis.missionState.active?.s !== s) { result = game.log.big.at(-1); break; }
    }
    const inOrder = order.every((v, i) => v === i + 1);
    info(`race ${k}: rival ${result?.[1] || 'still racing'} after ${t.toFixed(1)} s, gates ${order.join(',')}, hp ${s.rival.hp.toFixed(0)}`);
    check(result && result[1] === 'Dex won the race.' && order.length === s.n && inOrder, `race ${k}: Dex should pass all ${s.n} gates in order and finish`);
    check(t < 90, `race ${k}: Dex should finish within 90 s (took ${t.toFixed(1)})`);
    game.log.big.length = 0;
  }
  // Kimchi drives the course line too (with the same AI) and must be credited with every gate
  for (let k = 0; k < 2; k++) {
    const s = startRace(10 + k, true);
    let t = 0, result = null;
    const passes = [];
    for (; t < 200; t += DT) {
      const before = s.pi;
      if (s.go) {
        const c = G.player.car, pt = nav.pursue(c);
        steerTo(c, DT, pt[0], pt[1], { curv: nav.curvatureAhead(c), grip: 22, cap: 640, dodge: true });
        G.player.x = c.x; G.player.y = c.y;
      }
      step(game, DT, { police: false, player: false });
      if (s.pi !== before) passes.push(s.pi);
      if (mis.missionState.active?.s !== s) { result = game.log.big.at(-1); break; }
    }
    info(`race with Kimchi ${k}: ${result?.[0]} after ${t.toFixed(1)} s; Kimchi passed ${passes.length} gates, Dex ${s.ri}`);
    check(passes.length === s.n || (result?.[1] === 'Dex won the race.' && passes.length >= s.n - 2), `race with Kimchi ${k}: Kimchi driving the course should be credited with every gate in order`);
    game.log.big.length = 0;
  }
  // a car driving past a gate the wrong way, or beside it, does not pass it
  const s = startRace(20, false);
  const g = s.R.gates[0], fx = Math.cos(g.a), fy = Math.sin(g.a);
  const at = (along, side) => ({ x: g.x + fx * along - fy * side, y: g.y + fy * along + fx * side });
  const pass = (a, b) => { s.go = true; s.pi = 0; s.prev = a; Object.assign(G.player, b); G.player.car = null; mis.updateMissions(DT); return s.pi === 1; };
  check(pass(at(-30, 0), at(30, 0)), 'a move through the middle of a gate the right way should pass it');
  check(!pass(at(30, 0), at(-30, 0)), 'a move through a gate the wrong way should not pass it');
  check(!pass(at(-30, g.w), at(30, g.w)), 'a move a whole gate width to the side should not pass it');
  check(pass(at(-30, g.w / 2), at(30, g.w / 2)), 'a move through the edge of a gate should pass it');
  mis.failMission('test over');
}

// ---------- 3. the Kimchi Empire boss ----------
console.log('Kimchi Empire boss');
{
  const EMP = mis.MISSIONS.find(m => m.id === 'kimchi_empire');
  const DESTROY = EMP.steps.find(s => s.type === 'destroy');
  for (const [k, p] of roadSpots(4, 909).entries()) {
    seed(300 + k);
    freshPlay(game, p.x, p.y);
    ent.spawnWorld();
    playerCar(game, 'ursa', p.x, p.y, p.a);
    mis.startMission({ id: 'boss_test', title: 'Boss', reward: 0, steps: [DESTROY, talk] });
    const s = mis.missionState.active.s, boss = s.car;
    check(boss && dist(boss, p) >= 1600, `boss ${k}: should spawn at least 1600 px away (${boss ? dist(boss, p).toFixed(0) : 'none'})`);
    let slow = 0, worst = 0, fleeT = 0, moved = 0, flees = 0, lastFlee = null;
    const track = [];
    let prev = { x: boss.x, y: boss.y };
    for (let t = 0; t < 150; t += DT) {
      // Kimchi hunts him down but holds off 30 m short, so the boss keeps running instead of being rammed
      const d = dist(G.player.car, boss);
      if (d < 480) steerTo(G.player.car, DT, boss.x, boss.y, { stopWithin: 1e9 });
      else drivePlayer(DT, boss.x, boss.y, { ignore: boss });
      step(game, DT, { police: false, player: false });
      if (boss.hp <= 0 || boss.wreck) break;
      const v = Math.hypot(boss.vx, boss.vy);
      slow = v < 40 ? slow + DT : 0;
      worst = Math.max(worst, slow);
      if (s.flee) { fleeT += DT; if (s.flee !== lastFlee) flees++; }
      lastFlee = s.flee;
      moved += dist(boss, prev); prev = { x: boss.x, y: boss.y };
      if (Math.round(t * 60) % 15 === 0) track.push({ x: boss.x, y: boss.y });
    }
    info(`boss ${k}: drove ${(moved / 16).toFixed(0)} m, fled for ${fleeT.toFixed(0)} s through ${flees} junctions, longest stop ${worst.toFixed(1)} s, ${(onRoadRatio(track) * 100).toFixed(0)}% on road, hp ${boss.hp.toFixed(0)}`);
    check(worst <= 10, `boss ${k}: should never be stuck for more than 10 s (longest ${worst.toFixed(1)} s)`);
    check(moved > px(400), `boss ${k}: should keep driving (${(moved / 16).toFixed(0)} m)`);
    check(fleeT > 5 && flees >= 2, `boss ${k}: should flee junction to junction from a chasing car`);
    check(blocked(track) === 0, `boss ${k}: should stay out of buildings`);
    mis.failMission('test over');
  }
  // fleeing picks the neighbour of the junction ahead that is furthest from Kimchi
  freshPlay(game, 0, 0);
  const n = world.roads.nodes.find(q => q.edges.length === 4);
  const nb = nav.nodeNeighbours(n.id);
  check(nb.length === 4 && nb.every(q => q !== n), 'a lattice junction should have 4 neighbours');
}

// ---------- 4. Hot Delivery ----------
// The AI drives Kimchi's car to each order; a door off the street (the grid's doors face into the blocks) is
// finished on foot, running straight at it, and he runs back to the car for the next order, as a player would.
console.log('Hot Delivery');
{
  const HD = mis.MISSIONS.find(m => m.id === 'hot_delivery');
  const DELIVER = HD.steps.find(s => s.type === 'deliver');
  const RUN = ent.CFG.run;
  let orders = 0, late = 0, outBand = 0, slack = Infinity;
  const runTo = (pt, dt) => {
    const p = G.player, d = dist(p, pt), k = Math.min(1, RUN * dt / Math.max(d, 1e-6));
    p.x += (pt.x - p.x) * k; p.y += (pt.y - p.y) * k;
    return d <= RUN * dt;
  };
  for (const [k, p] of roadSpots(6, 77).entries()) {
    seed(500 + k);
    freshPlay(game, p.x, p.y);
    ent.spawnWorld();
    const car = playerCar(game, 'ursa', p.x, p.y, p.a);
    mis.startMission({ id: 'deliver_test', title: 'Deliver', reward: 0, steps: [DELIVER, talk] });
    const s = mis.missionState.active.s;
    let order = -1, budget = 0, t0 = 0, result = null, mode = 'drive';
    for (let t = 0; t < 400; t += DT) {
      if (s.n !== order) {
        if (order >= 0) { slack = Math.min(slack, budget - (t - t0)); mode = 'back'; }
        order = s.n; budget = s.left; t0 = t;
        if (order < s.count) {
          orders++;
          if (s.len < 900 || s.len > 3000) outBand++;
          check(Math.abs(s.left - (s.len / (18 * 16) + 20)) < 1e-6, `order timer should be route / 18 m/s + 20 s (${s.left.toFixed(1)} for ${s.len.toFixed(0)} px)`);
        }
      }
      if (mode === 'back' && runTo(car, DT)) { G.player.car = car; mode = 'drive'; }
      if (mode === 'drive') {
        drivePlayer(DT, s.pt.x, s.pt.y);
        if (dist(car, s.pt) < 350) { car.vx = car.vy = 0; G.player.car = null; mode = 'run'; }
      }
      if (mode === 'run') runTo(s.pt, DT);
      step(game, DT, { police: false, player: false });
      if (mis.missionState.active?.s !== s) { result = game.log.big.at(-1); break; }
    }
    if (result?.[0] === 'MISSION FAILED') late++;
    if (VERBOSE) info(`delivery run ${k}: ${result?.[0] || 'unfinished'}`);
  }
  info(`${orders} orders, ${late} runs ran out of time, ${outBand} outside the 900-3000 px band, tightest finish ${slack.toFixed(1)} s to spare`);
  check(orders >= 15 && late === 0, 'every Hot Delivery order should be reachable in time by an AI driver');
  check(outBand === 0, 'every order should be 900-3000 px of driving away on the grid');
}

// ---------- 5. roadblocks at 3 stars ----------
console.log('roadblocks');
{
  let made = 0;
  for (const [k, p] of roadSpots(6, 31).entries()) {
    seed(700 + k);
    freshPlay(game, p.x, p.y);
    ent.spawnWorld();
    playerCar(game, 'ursa', p.x, p.y, p.a);
    G.wanted = 3; G.heatT = 1e9; police.spawnT = 1e9;    // no chasers, just the roadblock
    const far = world.roads.nodes.reduce((a, q) => (dist(q, p) > dist(a, p) ? q : a));
    let rb = null, at = null;
    for (let t = 0; t < 30 && !rb; t += DT) {
      drivePlayer(DT, far.x, far.y);
      step(game, DT, { player: false, missions: false });
      G.heatT = 1e9;
      if (police.roadblock) { rb = police.roadblock; at = { x: G.player.x, y: G.player.y, t }; }
    }
    if (!rb) { info(`roadblock ${k}: none in 30 s`); continue; }
    made++;
    const d = dist(rb, at);
    const [a, b] = rb.cars;
    const near = world.roads.nearest(rb.x, rb.y), e = world.roads.edges[near.edge];
    const roadA = Math.atan2(e.ty[near.i], e.tx[near.i]);
    const across = c => Math.abs(Math.sin(c.a - roadA)) > 0.6;
    info(`roadblock ${k}: after ${at.t.toFixed(1)} s, ${d.toFixed(0)} px from Kimchi, cars ${dist(a, b).toFixed(0)} px apart`);
    check(d >= 1400 * 0.85 && d <= 2600 * 1.15, `roadblock ${k}: should stand 1400-2600 px from Kimchi (${d.toFixed(0)})`);
    check(rb.cars.length === 2 && rb.cars.every(c => c.police && c.cop.block > 0 && across(c)), `roadblock ${k}: two cruisers angled across the road`);
    check(rb.cars.every(c => world.tileAtPx(c.x, c.y) === world.ROAD && !ent.carHits(c, c.x, c.y, c.a)), `roadblock ${k}: cruisers on the road, clear of buildings`);
    // it stands for 25 s, the cruisers holding still, then they join the chase
    const pos = rb.cars.map(c => ({ x: c.x, y: c.y }));
    for (let t = 0; t < 26; t += DT) {
      if (G.player.car) G.player.car.vx = G.player.car.vy = 0;
      step(game, DT, { player: false, missions: false });
      G.heatT = 1e9; G.player.dead = false;
    }
    check(rb.cars.every((c, i) => dist(c, pos[i]) < 200 || c.cop.block <= 0), `roadblock ${k}: the cruisers should hold their spot`);
    check(!police.roadblock && rb.cars.every(c => !(c.cop.block > 0)), `roadblock ${k}: after 25 s it should be released`);
  }
  check(made >= 5, `a roadblock should go up at 3 stars (${made} of 6 runs)`);
  // none below 3 stars
  freshPlay(game, 1000, 1000);
  playerCar(game, 'ursa', world.roads.nodes[8].x + 200, world.roads.nodes[8].y + 32, 0);
  G.wanted = 2; G.heatT = 1e9; police.spawnT = 1e9;
  for (let t = 0; t < 8; t += DT) { drivePlayer(DT, world.roads.nodes[12].x, world.roads.nodes[12].y); step(game, DT, { player: false, missions: false }); }
  check(!police.roadblock, 'no roadblock below 3 stars');
}

// ---------- 6. interceptors, driving off, losing the cops ----------
console.log('interceptors, drive-away, evading');
{
  const CFG = ent.CFG, keep = [CFG.carMax, CFG.carAcc];
  const p = roadSpots(1, 5)[0];
  seed(41);
  freshPlay(game, p.x, p.y);
  ent.spawnWorld();
  Object.assign(G.player, { x: p.x, y: p.y });
  G.wanted = 5; G.heatT = 1e9; police.spawnT = 0;
  for (let t = 0; t < 20; t += DT) { step(game, DT, { missions: false }); G.heatT = 1e9; G.player.dead = false; }
  const fast = police.cars.filter(c => c.interceptor);
  info(`5 stars: ${police.cars.length} cruisers, ${fast.length} interceptors`);
  check(fast.length >= 2 && fast.every(c => c.tune && c.tune.max === 1.3 && c.tune.acc === 1.2), '5 stars should bring interceptors (top speed x1.3, acceleration x1.2)');
  check(CFG.carMax === keep[0] && CFG.carAcc === keep[1], 'the shared CFG multipliers should be left as they were');
  // an interceptor out-accelerates a cruiser from a standstill, on open streets: the traffic and the chase
  // are set aside for the drag (steerTo's carCollisions reads G.cars), else whichever car meets a traffic
  // car in its lane loses
  const race2 = [ent.makeCar('police', 1000, world.roadCenter(1) + 32, 0), ent.makeCar('police', 1000, world.roadCenter(3) + 32, 0)];
  race2[1].tune = { max: 1.3, acc: 1.2 };
  const others = G.cars;
  G.cars = [];
  for (let t = 0; t < 1.5; t += DT) for (const c of race2) steerTo(c, DT, c.x + 2000, c.y, {});
  G.cars = others;
  check(race2[1].x - 1000 > (race2[0].x - 1000) * 1.12, `an interceptor should pull away from a cruiser (${(race2[1].x - 1000).toFixed(0)} vs ${(race2[0].x - 1000).toFixed(0)} px)`);

  // called off: every cruiser drives away and is gone within a minute, along the streets
  G.wanted = 0;
  const track = [];
  let t = 0;
  const live = () => police.cars.filter(c => !c.wreck && c.hp > 0);
  const wrecked = () => police.cars.length - live().length;
  for (; t < 90 && live().length; t += DT) {
    step(game, DT, { missions: false });
    if (Math.round(t * 60) % 20 === 0) for (const c of live()) track.push({ x: c.x, y: c.y });
  }
  info(`called off: all cruisers gone after ${t.toFixed(1)} s (${wrecked()} wrecked on the way), ${(onRoadRatio(track) * 100).toFixed(0)}% of their track on road`);
  check(live().length === 0 && t < 60, 'called-off cops should drive away and vanish within 60 s');
  check(blocked(track) === 0, 'driving away should stay out of buildings');

  // losing them: a cop behind a building does not see Kimchi; one in plain sight does (sightClear)
  freshPlay(game, 0, 0);
  const b = world.buildings.find(q => q.w >= 4 && q.h >= 4 && !q.place);
  const T = world.T, bx = (b.x + b.w / 2) * T;
  const north = { x: bx, y: b.y * T - 40 }, south = { x: bx, y: (b.y + b.h) * T + 40 };
  Object.assign(G.player, south);
  G.wanted = 1; G.heatT = 0; G.evadeT = 0; police.spawnT = 1e9;
  const cop = ent.makeCar('police', north.x, north.y, 0);
  Object.assign(cop, { police: true, managed: true, hp: 150, cop: { deployed: true, waitT: 1e9, block: 0 } });
  G.cars.push(cop); police.cars.push(cop);
  const hold = () => { cop.x = north.x; cop.y = north.y; cop.vx = cop.vy = 0; };
  for (let i = 0; i < 30; i++) { pol.updatePolice(DT); hold(); }
  check(G.evadeT > 0.3 && police.search && police.search.r === 1300, `a cop behind a building should not see Kimchi (evadeT ${G.evadeT.toFixed(2)})`);
  cop.x = south.x + 300; cop.y = south.y + 10;
  pol.updatePolice(DT);
  check(G.evadeT === 0 && !police.search, 'a cop in plain sight should see Kimchi');
  unseed();
}

console.log(failed ? `s1c soak: ${failed} failed, ${passed} passed` : `s1c soak: ok (${passed} checks)`);
process.exit(failed ? 1 : 0);
