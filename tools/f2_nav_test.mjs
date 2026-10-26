#!/usr/bin/env node
// Fix stage F2 (navigation) checks on the classic grid, with the game's sim headless (tools/s1c_lib.mjs):
//   1. nav.dodge keeps a car that keeps to the roads on the carriageway: cars parked in a lot are no threat to
//      a car turning round beside it, every pass it takes ends with the whole car on the road network, and it
//      never squeezes between a car and the map edge; while a car inside a car park, driving out to the road,
//      still sees the cars parked in it and steers round them;
//   2. police.steerTo's stuck test reads displacement over a window, not speed: a car held in place with its
//      speed up backs off, while one driving its route or chasing a target that keeps ahead never does; back
//      where it got stuck it backs off again soon (unless it means to shove); a car wedged for good wriggles
//      free; on the grid's walls an AI car lifts before grinding itself to a wreck;
//   3. the Kimchi Empire boss keeps fleeing until he is well clear (no flip-flop at the edge of his range).
//   node tools/f2_nav_test.mjs
// tools/f2_v2_test.mjs covers the Kimchi Key v2 parts (driveways, the way back onto the road).
// Exits 1 if any check fails.
import { loadGame, seed, unseed, freshPlay, playerCar, px, ROOT } from './s1c_lib.mjs';

const game = await loadGame(ROOT);
const { G, world, ent, nav, pol, mis } = game;
const { roads } = world;
const DT = 1 / 60, M = 16;
let failed = 0, passed = 0;
const check = (ok, msg) => { if (ok) passed++; else { failed++; console.log('  FAIL ' + msg); } };
const info = msg => console.log('  ' + msg);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const rc = k => world.roadCenter(k);
const T = world.T;
console.log(`f2 nav: world '${world.KIND}', ${roads.nodes.length} nodes, ${roads.lanes.length} lanes`);
check(world.KIND === 'grid', 'the default world should be the grid');

// A car at (x, y) heading a, moving at v px/s along it.
const car = (x, y, a, v = 0, type = 'police') => {
  const c = ent.makeCar(type, x, y, a);
  c.vx = Math.cos(a) * v; c.vy = Math.sin(a) * v;
  return c;
};
// The whole car on the carriageway at (x, y), facing a: its centre and both sides 1.2 m out.
const bodyOnRoad = (x, y, a) => [0, 1, -1].every(k => nav.onCarriageway(x - Math.sin(a) * 1.2 * M * k, y + Math.cos(a) * 1.2 * M * k));

// ---------- 1. dodging stays on the carriageway ----------
console.log('dodge');
{
  freshPlay(game, 0, 0);
  // the carriageway: lane points yes; sidewalks, lots and the space past the map edge no
  check(nav.onCarriageway(rc(1) + 300, rc(1) + 32) && nav.onCarriageway(rc(1) + 300, rc(1) - 32), 'both lanes of a street are carriageway');
  const lotT = (() => { for (let ty = 0; ty < world.N; ty++) for (let tx = 0; tx < world.N; tx++) if (world.tileAt(tx, ty) === world.LOT && world.tileAt(tx, ty - 1) === world.WALK && world.tileAt(tx, ty - 2) === world.ROAD) return { tx, ty }; })();
  check(lotT && !nav.onCarriageway((lotT.tx + 0.5) * T, (lotT.ty + 0.5) * T) && !nav.onCarriageway((lotT.tx + 0.5) * T, (lotT.ty - 0.5) * T), 'a car park and a sidewalk are not');

  // the S1c soak's boss: turning round in the street beside a car park, his nose toward the parked cars, his
  // aim back on the road behind him. They are no threat, so he does not swerve in among them.
  const lx = (lotT.tx + 0.5) * T, ly = (lotT.ty + 0.5) * T, roadY = (lotT.ty - 2) * T + 32;  // the lane by the lot
  const parked = [car(lx - 40, ly, 0, 0, 'sedan'), car(lx + 40, ly, 0, 0, 'sedan'), car(lx, ly + 64, 0, 0, 'sedan')];
  const boss = car(lx, roadY, Math.PI / 2 - 0.2, px(12), 'bolide');
  G.cars = [boss, ...parked];
  const out = [0, 0], aimX = lx - px(15), aimY = roadY - 64;
  const cap = nav.dodge(boss, aimX, aimY, out);
  check(cap === Infinity && out[0] === aimX && out[1] === aimY, `a car turning round beside a car park keeps its aim on the road (aim moved to ${(out[0] / M).toFixed(1)}, ${(out[1] / M).toFixed(1)} m; cap ${cap})`);

  // driving out of a car park to the road, a car parked in its way: a car inside a car park is not keeping
  // to the roads, so the parked car is a threat to it and it steers round it (the F2 review's probe: with the
  // road-only rule applied to it, it drove at the parked car and into the stuck and back-up cycle 29 times
  // in 30)
  let exits = 0, saw = 0, touched = 0, backed = 0;
  for (let ty = 2; ty < world.N - 6 && exits < 30; ty++) for (let tx = 1; tx < world.N - 1 && exits < 30; tx++) {
    if (world.tileAt(tx, ty - 2) !== world.ROAD || world.tileAt(tx, ty - 1) !== world.WALK) continue;
    if (![0, 1, 2, 3].every(k => [-1, 0, 1].every(i => world.tileAt(tx + i, ty + k) === world.LOT))) continue;
    exits++;
    G.t = 1;
    const x = (tx + 0.5) * T, py = (ty + 1.5) * T, aimY = (ty - 2) * T + 32;
    const c = car(x, (ty + 3.5) * T, -Math.PI / 2, px(8)), o = car(x, py, -Math.PI / 2, 0, 'sedan');
    G.cars = [c, o];
    const capL = nav.dodge(c, x, aimY, out);
    if (capL < Infinity || out[0] !== x || out[1] !== aimY) saw++;
    let hit = false;
    for (let t = 0; t < 6; t += DT) {
      o.x = x; o.y = py; o.vx = o.vy = 0; o.a = -Math.PI / 2;
      pol.steerTo(c, DT, x, aimY, { dodge: true });
      G.t += DT;
      if (dist(c, o) < px(2.6)) hit = true;
      if (c.drv.revT > 0) { backed++; break; }
    }
    if (hit) touched++;
  }
  info(`${exits} car-park exits past a parked car: seen in ${saw}, touched in ${touched}, backed up in ${backed}`);
  check(exits >= 10 && saw === exits, `a car driving out of a car park sees the car parked in its way (${saw} of ${exits})`);
  check(touched === 0 && backed === 0, `... and steers round it without touching it or backing up (touched ${touched}, backed up ${backed})`);

  // random encounters on the lanes: a slow or stopped car ahead, others about. Every pass taken ends with the
  // whole car on the road network, and none crosses a non-road cell.
  seed(202);
  let tries = 0, passes = 0, offRoad = 0, follows = 0;
  for (let i = 0; i < 1500; i++) {
    const p = roads.randomLanePoint({});
    const L = roads.lanes[p.lane];
    if (p.s > L.len - px(35)) continue;
    const v = px(6 + Math.random() * 18), a = p.a + (Math.random() - 0.5) * 0.3;
    const c = car(p.x, p.y, a, v);
    const ahead = px(8 + Math.random() * 14), side = (Math.random() - 0.5) * px(3);
    const o = car(p.x + Math.cos(a) * ahead - Math.sin(a) * side, p.y + Math.sin(a) * ahead + Math.cos(a) * side, a, Math.random() < 0.5 ? 0 : v * 0.3);
    G.cars = [c, o];
    for (let k = 0; k < 4; k++) {
      const q = roads.randomLanePoint({ x: p.x, y: p.y, rMax: px(40) });
      if (q) G.cars.push(car(q.x, q.y, q.a, px(Math.random() * 14)));
    }
    const aim = roads.lanePoint(p.lane, Math.min(L.len, p.s + px(30)));
    tries++;
    const capped = nav.dodge(c, aim.x, aim.y, out);
    if (out[0] === aim.x && out[1] === aim.y) { if (capped < Infinity) follows++; continue; }
    passes++;
    const pa = Math.atan2(out[1] - c.y, out[0] - c.x), n = Math.ceil(dist({ x: out[0], y: out[1] }, c) / (2 * M));
    let bad = !bodyOnRoad(out[0], out[1], pa);
    for (let j = 1; j < n; j++) if (world.tileAtPx(c.x + (out[0] - c.x) * j / n, c.y + (out[1] - c.y) * j / n) !== world.ROAD) bad = true;
    if (bad) offRoad++;
  }
  info(`${tries} encounters: ${passes} passes, ${follows} follows, ${offRoad} passes off the carriageway`);
  check(passes > 50 && follows > 20, 'the encounters should include both passes and follows');
  check(offRoad === 0, `every pass should end with the whole car on the carriageway (${offRoad} did not)`);

  // the S1c soak's other boss: north up the east edge road's right lane, a car turning across ahead of him a
  // little to the left. Its right side is a gap of 3 m to the map edge, too narrow for a car: no pass there.
  const ex = rc(6) + 32, e = car(ex, rc(3) + 300, -Math.PI / 2, px(18), 'bolide');
  const turner = car(ex - 32, rc(3) + 300 - px(14), 0, px(3), 'sedan');
  const oncoming = car(rc(6) - 32, rc(3) + 300 - px(30), Math.PI / 2, px(12), 'sedan');
  G.cars = [e, turner, oncoming];
  const cap2 = nav.dodge(e, ex, rc(3) - 400, out);
  check(out[0] <= ex + 4 && cap2 < Infinity, `no squeeze between a car and the map edge: it follows instead (aim x ${(out[0] - ex).toFixed(0)} px right of its lane, cap ${cap2.toFixed?.(0)})`);
  G.cars = [];
}

// ---------- 2. the AI driver: stuck by displacement, wriggling free, wall scrapes ----------
console.log('stuck test');
{
  const { steerTo } = pol;
  freshPlay(game, 0, 0);
  G.t = 0;
  // held in place (a car it shoves, a wall it rocks against) with its foot down: the speed reads well over
  // the old 30 px/s, but it gets nowhere, so it backs off within the 1.1 s window
  const h = car(rc(2) + 300, rc(2) + 32, 0, 0);
  G.cars = [h];
  let back = null, minFwd = Infinity;
  for (let t = 0; t < 3 && back == null; t += DT) {
    const x = h.x, y = h.y;
    steerTo(h, DT, h.x + px(60), h.y, {});
    h.x = x; h.y = y;
    G.t += DT;
    if (h.drv.revT > 0) back = t; else if (t > 0.3) minFwd = Math.min(minFwd, h.vx);
  }
  check(back != null && back <= 1.3, `a car held in place with its foot down should back off within the window (after ${back?.toFixed(2)} s)`);
  check(minFwd > 30, `... although its speed read over 30 px/s all along (min ${minFwd.toFixed(0)}), which the old speed test never caught`);

  // driving its route along the streets for 20 s, it never counts as stuck
  const d = car(rc(1) + 200, rc(1) + 32, 0, 0);
  G.cars = [d];
  let revs = 0;
  for (let t = 0; t < 20; t += DT) {
    const [ax, ay] = nav.roadWaypoint(d, rc(5), rc(4) + 32);
    steerTo(d, DT, ax, ay, { curv: nav.curvatureAhead(d) });
    G.t += DT;
    if (d.drv.revT > 0) revs++;
  }
  check(revs === 0, `a car driving its route should never back up (${revs} frames)`);

  // chasing a target that keeps 60 m ahead at the chaser's own speed: no progress on the gap, but the chaser
  // is going somewhere, so it is not stuck
  const ch = car(rc(3) + 100, rc(3) + 32, 0, 0), tg = { x: ch.x + px(60), y: ch.y };
  G.cars = [ch];
  revs = 0;
  for (let t = 0; t < 12; t += DT) {
    steerTo(ch, DT, tg.x, tg.y, { cap: px(12) });
    tg.x = ch.x + px(60);
    G.t += DT;
    if (ch.drv.revT > 0) revs++;
  }
  check(revs === 0, `a car chasing a target that stays ahead should never back up (${revs} frames)`);

  // back at the spot where it got stuck and no further after backing up, whatever stopped it is still there:
  // it backs off again after 0.4 s instead of shoving for the whole window (a car blocked by stopped traffic
  // keeps out of the junction), unless it means to shove (a cop ramming its target, o.ignore)
  const gap = ignore => {
    const b = car(rc(5) + 300, rc(5) + 32, 0, 0);
    G.cars = [b];
    let ends = null, next = null, was = false;
    for (let t = 0; t < 6 && next == null; t += DT) {
      const x = b.x, y = b.y;
      steerTo(b, DT, b.x + px(60), b.y, { ignore });
      b.x = x; b.y = y; b.vx = b.vy = 0;
      G.t += DT;
      const r = b.drv.revT > 0;
      if (was && !r) ends = t; else if (!was && r && ends != null) next = t - ends;
      was = r;
    }
    return next;
  };
  const soon = gap(null), shove = gap({});
  check(soon != null && soon < 0.6, `held where it got stuck, a car backs off again soon after its back-up (after ${soon?.toFixed(2)} s)`);
  check(shove != null && shove > 1, `... but one that means to shove keeps at it for the whole window (${shove?.toFixed(2)} s)`);

  // wedged for good (held in place, nose and all): after four back-ups it wriggles free, turned toward its
  // aim, onto a spot it fits (back at the spot where it got stuck, each back-up after the first comes 0.4 s in)
  const w = car(rc(4) + 300, rc(4) + 32, 0, 0);
  G.cars = [w];
  let wriggled = null;
  for (let t = 0; t < 10 && wriggled == null; t += DT) {
    const x = w.x, y = w.y, a = w.a;
    steerTo(w, DT, w.x + px(5), w.y - px(30), {});
    G.t += DT;
    if (Math.abs(w.a - a) > 0.3 || Math.hypot(w.x - x, w.y - y) > 3 + Math.hypot(w.vx, w.vy) * DT * 1.5) wriggled = { t, da: w.a - a, ok: !ent.carHits(w, w.x, w.y, w.a), rev: w.drv.revT };
    else { w.x = x; w.y = y; w.a = a; }
  }
  check(wriggled && wriggled.t > 4 && wriggled.t < 8 && wriggled.ok, `a car wedged for good wriggles free after four back-ups (${wriggled ? `after ${wriggled.t.toFixed(1)} s, turned ${wriggled.da.toFixed(2)} rad` : 'never'})`);
  check(wriggled && wriggled.da < 0 && wriggled.da >= -1.06, `... turned toward its aim by at most 1 rad, plus that frame's own steering (${JSON.stringify(wriggled)})`);

  // the grid's walls take hp off a car's whole speed every frame it touches one: driven into the map edge
  // at 18 m/s, an AI car lifts and brakes instead of grinding along it
  const run = guarded => {
    const c = car(world.BOUNDS.x1 - px(4), rc(3) + 300, -Math.PI / 4, px(18), 'bolide');
    G.cars = [c];
    for (let t = 0; t < 1.5; t += DT) {
      if (guarded) steerTo(c, DT, c.x + px(80), c.y - px(80), {});
      else { ent.driveCar(c, DT, { up: true, steer: 0 }); ent.moveCar(c, DT, true); }
      G.t += DT;
    }
    return 100 - c.hp;
  };
  const lostRaw = run(false), lostAI = run(true);
  info(`into the map edge at 18 m/s for 1.5 s: foot down loses ${lostRaw.toFixed(0)} hp, the AI driver ${lostAI.toFixed(1)}`);
  check(lostRaw > 100 && lostAI < lostRaw / 10, 'an AI car should not grind itself to a wreck along a wall on the grid (a tenth of the loss at most)');
  // shoved half into the map edge at 17 m/s (the S1c soak's boss, by a traffic car): the grid's walls refuse
  // every move of a car inside them and bill its whole speed each frame, so it is set out of the wall at once
  // (the frame it starts in is billed already: about 10 hp at that speed)
  const sh = car(px(0.6), rc(2) + 300, -Math.PI / 2, px(17), 'bolide');
  G.cars = [sh];
  const inWall = ent.carHits(sh, sh.x, sh.y, sh.a);
  for (let t = 0; t < 0.5; t += DT) { steerTo(sh, DT, sh.x, sh.y - px(60), {}); G.t += DT; }
  check(inWall && 100 - sh.hp < 12 && !ent.carHits(sh, sh.x, sh.y, sh.a), `a car shoved into a wall at speed is set out of it (lost ${(100 - sh.hp).toFixed(1)} hp, still in it: ${ent.carHits(sh, sh.x, sh.y, sh.a)})`);
  G.cars = [];
}

// ---------- 3. the boss keeps running until he is clear ----------
console.log('boss flee');
{
  seed(31);
  const p = roads.randomLanePoint({});
  freshPlay(game, p.x, p.y);
  const kc = playerCar(game, 'ursa', p.x, p.y, p.a);
  const DESTROY = mis.MISSIONS.find(m => m.id === 'kimchi_empire').steps.find(s => s.type === 'destroy');
  mis.startMission({ id: 'boss_test', title: 'Boss', reward: 0, steps: [DESTROY, { type: 'talk', lines: [['x', 'y']] }] });
  const s = mis.missionState.active.s, b = s.car;
  const at = d => { kc.x = b.x - d; kc.y = b.y; kc.vx = kc.vy = 0; Object.assign(G.player, { x: kc.x, y: kc.y }); G.t += DT; mis.updateMissions(DT); };
  at(1200); const far = !s.flee;
  at(650); const near = !!s.flee;
  let kept = true;
  for (let i = 0; i < 30; i++) { at(850 + (i % 2) * 100); kept = kept && !!s.flee; }
  at(1100);
  check(far && near, 'the boss runs once Kimchi is within 700 px');
  check(kept, 'he keeps running while Kimchi hangs about 850-950 px back');
  check(!s.flee, 'he stops running once Kimchi is 1000 px clear');
  mis.failMission('test over');
}

unseed();
console.log(failed ? `f2 nav: ${failed} failed, ${passed} passed` : `f2 nav: ok (${passed} checks)`);
process.exit(failed ? 1 : 0);
