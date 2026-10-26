#!/usr/bin/env node
// Stage S1c unit checks for src/sim/nav.js (docs/map-v2-spec.md §7, §9) on the classic grid: the cached A*
// plan and its replan rules, pure pursuit, the bend ahead, predicted paths, the network helpers, dodging and
// delivery routes. Plain node, no DOM (tools/s1c_lib.mjs stubs the browser-only modules).
//   node tools/s1c_nav_test.mjs [--root <project copy>]
// Exits 1 if any check fails.
import { loadGame, seed, unseed, freshPlay, px, ROOT } from './s1c_lib.mjs';

const ri = process.argv.indexOf('--root');
const game = await loadGame(ri > 0 ? process.argv[ri + 1] : ROOT);
const { G, world, ent, nav, pol } = game;
const { roads } = world;
let failed = 0, passed = 0;
const check = (ok, msg) => { if (ok) passed++; else { failed++; console.log('  FAIL ' + msg); } };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const rc = k => world.roadCenter(k);         // the grid's lattice road k (px)
const LANE = 32;                              // a lane is 2 m right of the centre line
console.log(`s1c nav: world '${world.KIND}', ${roads.nodes.length} nodes, ${roads.edges.length} edges`);

// A car at (x, y) heading a, moving at v px/s.
const car = (x, y, a, v = 0) => { const c = ent.makeCar('police', x, y, a); c.vx = Math.cos(a) * v; c.vy = Math.sin(a) * v; return c; };
freshPlay(game, 0, 0);

// ---------- pure pursuit distance ----------
console.log('look-ahead');
check(near(nav.lookAhead(car(0, 0, 0, 0)), px(10), 1e-6), 'a standing car looks 10 m ahead');
check(near(nav.lookAhead(car(0, 0, 0, px(20))), px(20), 1e-6), 'at 20 m/s a car looks 8 + 0.6 x 20 = 20 m ahead');
check(near(nav.lookAhead(car(0, 0, 0, px(80))), px(40), 1e-6), 'the look-ahead is capped at 40 m');

// ---------- roadWaypoint and the plan ----------
console.log('roadWaypoint');
{
  // eastbound on 2nd Street (ew1), target a junction three blocks east and two south
  const c = car(rc(1) + 300, rc(1) + LANE, 0, px(12));
  const tx = rc(4), ty = rc(3);
  G.t = 100;
  const [ax, ay] = nav.roadWaypoint(c, tx, ty);
  const r = c.nav;
  check(r && r.pts && r.pts.length >= 4 && r.tx === tx && r.ty === ty, 'roadWaypoint should plan a route to the target');
  check(world.tileAtPx(ax, ay) === world.ROAD, `the aim (${ax.toFixed(0)}, ${ay.toFixed(0)}) should be on the road`);
  check(near(dist({ x: ax, y: ay }, c), nav.lookAhead(c), px(3)), `the aim should be one look-ahead down the street (${dist({ x: ax, y: ay }, c).toFixed(0)} px)`);
  check(near(ay, rc(1) + LANE, 4), 'the aim should be on the eastbound lane, 2 m right of the centre line');
  let onRoad = 0;
  for (let i = 0; i < r.pts.length; i += 2) onRoad += world.tileAtPx(r.pts[i], r.pts[i + 1]) === world.ROAD;
  check(onRoad === r.pts.length / 2, 'every route point should be on the road');
  check(near(r.len, Math.abs(tx - c.x) + Math.abs(ty - c.y), px(30)), `the route should be about the Manhattan distance (${r.len.toFixed(0)} px)`);

  // replanning: not before 1 s, nor for a target that moved 30 m; at 1 s, for 40 m+, or off the corridor
  G.t = 100.5; nav.roadWaypoint(c, tx, ty);
  check(c.nav === r, 'no new plan within 1 s');
  nav.roadWaypoint(c, tx + px(30), ty);
  check(c.nav === r, 'no new plan for a target that moved 30 m');
  nav.roadWaypoint(c, tx + px(45), ty);
  check(c.nav !== r && c.nav.tx === tx + px(45), 'a new plan for a target that moved more than 40 m');
  const r2 = c.nav;
  G.t = 101.6; nav.roadWaypoint(c, tx + px(45), ty);
  check(c.nav !== r2 && c.nav.t === 101.6, 'a new plan every second');
  const r3 = c.nav;
  c.y += px(25);                                   // shoved 25 m off the route, into the block
  G.t = 101.7; nav.roadWaypoint(c, tx + px(45), ty);
  check(c.nav === r3 && r3.off > px(18), 'leaving the 18 m corridor is noticed on the next follow');
  G.t = 101.9; nav.roadWaypoint(c, tx + px(45), ty);
  check(c.nav !== r3, 'a car out of the corridor gets a new plan');
  check(nav.routeTo(c, tx + px(45), ty) === c.nav, 'routeTo returns the current plan');
}
{
  // a target 15 m behind: going round the block costs far more than 3 s over turning round in the street,
  // so even a fast car turns round; the route starts at the car either way
  G.t = 200;
  for (const v of [0, px(20)]) {
    const c = car(rc(2) + 400, rc(2) + LANE, 0, v);
    nav.roadWaypoint(c, rc(2) + 150, rc(2) + LANE);
    const p = nav.pathPoint(c.nav, Math.min(c.nav.len, px(15)), {});
    check(c.nav && p.x < c.x && c.nav.len < px(40), `a car at ${v / 16} m/s turns round for a target 15 m behind it`);
  }
  // round the block to the street north: back the way it came is a little quicker (right turns cost less
  // than left), so a standing car turns round, but a fast car keeps going (from its own spot)
  const tie = v => {
    const c = car(rc(2) + 600, rc(2) + LANE, 0, v);
    nav.roadWaypoint(c, rc(2) + 448, rc(1) - LANE);
    return nav.pathPoint(c.nav, Math.min(c.nav.len, px(15)), {}).x > c.x && near(c.nav.pts[0], c.x, 1e-3);
  };
  check(!tie(0), 'a standing car takes the slightly quicker way, turning round');
  check(tie(px(20)), 'a fast car keeps going when turning round saves less than 3 s');
}
{
  // the last stretch goes straight at the target when it can be reached in a line
  G.t = 300;
  const c = car(rc(3) + 300, rc(3) + LANE, 0, 0);
  const t = { x: rc(3) + 300 + px(8), y: rc(3) + LANE + 4 };
  const [ax, ay] = nav.roadWaypoint(c, t.x, t.y);
  check(ax === t.x && ay === t.y, 'a target 8 m ahead in a clear line is driven at directly');
}

// ---------- the network around a car ----------
console.log('network helpers');
{
  check(!nav.offNetwork(rc(2) + 300, rc(2) + LANE), 'a lane point is on the network');
  check(!nav.offNetwork(rc(2) + 448, rc(2) + 448), 'the middle of a grid block is within 25 m of a lane');
  check(nav.offNetwork(-px(400), -px(400)), 'a point 400 m outside the map is off the network');
  check(nav.lineDrivable(rc(1) + 200, rc(1), rc(1) + 800, rc(1)), 'a line along a street is drivable');
  check(!nav.lineDrivable(rc(1) + 200, rc(1), rc(1) + 200, rc(2)), 'a line through a block of buildings is not');
  const c = car(rc(2) + 300, rc(2) + LANE, 0, px(5));
  const b = nav.nodeAhead(c), back = nav.nodeAhead(car(rc(2) + 300, rc(2) - LANE, Math.PI, px(5)));
  check(b && near(b.x, rc(3), 2) && near(b.y, rc(2), 2), 'nodeAhead: an eastbound car heads for the junction east of it');
  check(back && near(back.x, rc(2), 2) && near(back.y, rc(2), 2), 'nodeAhead: a westbound car heads for the junction west of it');
  const nn = id => nav.nodeNeighbours(id).length;
  const at = (i, j) => roads.nodes.find(n => near(n.x, rc(i), 2) && near(n.y, rc(j), 2));
  check(nn(at(0, 0).id) === 2 && nn(at(3, 0).id) === 3 && nn(at(3, 3).id) === 4, 'a lattice corner, edge and inner junction have 2, 3 and 4 neighbours');
}

// ---------- the bend ahead ----------
console.log('curvatureAhead');
{
  // a straight run along 4th Street to a junction four blocks on: no bend
  G.t = 400;
  const c = car(rc(1) + 200, rc(3) + LANE, 0, px(15));
  nav.roadWaypoint(c, rc(5), rc(3) + LANE);
  const k0 = nav.curvatureAhead(c);
  check(k0 < 1 / px(300), `a straight route should have no bend (R ${(1 / k0 / 16).toFixed(0)} m)`);
  // a right turn ahead: the bend is tighter the closer it is
  const kAt = d => {
    const q = car(rc(3) - d, rc(3) + LANE, 0, px(10));
    G.t += 2;
    nav.roadWaypoint(q, rc(3) - LANE, rc(5));
    return nav.curvatureAhead(q, px(100));
  };
  const k10 = kAt(px(10)), k25 = kAt(px(25)), k45 = kAt(px(45));
  const R = k => (1 / k / 16).toFixed(1);
  console.log(`  right turn at 10 / 25 / 45 m: R ${R(k10)} / ${R(k25)} / ${R(k45)} m`);
  check(k10 > k25 && k25 > k45, 'a nearer bend should count as tighter');
  check(1 / k10 < px(15) && 1 / k10 > px(3), `a street corner 10 m ahead should count as a 3-15 m radius (${R(k10)} m)`);
  check(near(1 / k45 - 1 / k25, 2 * px(20), px(6)), 'a bend 20 m further on counts as 40 m wider (R + 2d)');
  // the car's own heading counts: a car facing across its route must slow to turn
  const q = car(rc(3) - px(20), rc(3) + LANE, Math.PI / 2, px(5));
  G.t += 2;
  nav.roadWaypoint(q, rc(5), rc(3) + LANE);
  check(nav.curvatureAhead(q) > 1 / px(20), 'a car facing across its route should see a sharp turn');
  // corner speeds: v^2 = grip R
  check(near(nav.cornerSpeed(1 / px(10)), Math.sqrt(nav.COP_GRIP * 10) * 16, 1e-6), 'cornerSpeed(1/10 m) at police grip is sqrt(11.9 x 10) m/s');
  check(nav.cornerSpeed(0) === Infinity, 'no bend, no corner speed');
  check(near(nav.COP_GRIP, 1.15 * 1.15 * 9, 1e-9), 'police brake to 1.15 sqrt(9 R)');
}

// ---------- predicted paths ----------
console.log('predictPath');
{
  // Kimchi heading east on 3rd Street: straight on through each junction
  const c = car(rc(1) + 200, rc(2) + LANE, 0, px(20));
  c.nav = null;
  const p = nav.predictPath(c, px(150));
  check(p && near(p.len, px(150), px(4)), `the predicted path should run the full 150 m (${p ? (p.len / 16).toFixed(0) : 0} m)`);
  const end = nav.pathPoint(p, p.len, {});
  check(near(end.y, rc(2) + LANE, 6) && near(end.x, c.x + px(150), px(8)), 'straight on along the street through the junctions');
  check(dist({ x: p.pts[0], y: p.pts[1] }, c) < px(2), 'it starts at the car');
  // at the east edge of the map the street ends in a T: it turns (right) instead of stopping
  const e = car(rc(6) - px(20), rc(2) + LANE, 0, px(20));
  const pe = nav.predictPath(e, px(60));
  const ee = nav.pathPoint(pe, pe.len, {});
  check(pe && pe.len > px(55) && ee.y > rc(2) + px(20), 'at the map edge the path turns along the edge road');
  // a car with a fresh plan predicts its plan
  G.t = 500;
  const f = car(rc(1) + 200, rc(1) + LANE, 0, px(10));
  nav.roadWaypoint(f, rc(1) + LANE * -1, rc(4));
  const pf = nav.predictPath(f, px(80));
  check(pf && near(pf.len, px(80), px(2)), 'a car with a plan predicts along it');
  // Kimchi's car is predicted from its lane even if an AI drove it before (a stale plan going elsewhere)
  G.player.car = f;
  const pk = nav.predictPath(f, px(80)), ek = nav.pathPoint(pk, pk.len, {});
  G.player.car = null;
  check(pk && near(ek.y, rc(1) + LANE, 6) && ek.x > f.x + px(70), "Kimchi's car is predicted straight on along its lane");
}

// ---------- paths and courses ----------
console.log('paths and courses');
{
  const P = { pts: new Float32Array([0, 0, 100, 0, 100, 100]), s: new Float32Array([0, 100, 200]) };
  const q = nav.pathPoint(P, 150, {});
  check(q.x === 100 && q.y === 50 && near(q.a, Math.PI / 2, 1e-6), 'pathPoint interpolates position and heading');
  check(near(nav.stationOf(P, 50, 20), 50, 1e-6) && near(nav.stationOf(P, 120, 60), 160, 1e-6), 'stationOf projects onto the path');
  check(near(nav.stationOf(P, 90, 20, 105), 120, 1e-6), 'stationOf searches on from a station');
  // the Street Kings course: its gates fall in order along it
  const R = world.routes.street_kings;
  let from = 0, ok = true;
  for (const g of R.gates) { const s = nav.stationOf(R, g.x, g.y, from); if (s < from) ok = false; from = s; }
  check(ok && near(from, R.len, px(1)), 'the race gates lie in order along the course, the last at its end');
  // following a fixed course; knocked off it, the car drives back by the streets
  G.t = 600;
  const c = car(R.pts[0], R.pts[1], 0, px(10));
  nav.setRoute(c, R);
  check(c.nav.fixed && c.nav.pts === R.pts, 'setRoute without a target fixes the course and shares its arrays');
  const a1 = nav.followCourse(c);
  check(!c.back && dist({ x: a1[0], y: a1[1] }, c) > px(5), 'on the course the car aims along it');
  const course = c.nav;
  c.x += 0; c.y += px(30);                     // pushed 30 m into the block south of the course
  const a2 = nav.followCourse(c);
  check(c.nav === course && c.back && c.back.pts, 'off the course the car plans its way back (c.back) and keeps the course');
  check(c.back.tx != null && dist({ x: c.back.tx, y: c.back.ty }, nav.pathPoint(R, Math.min(R.len, course.at + px(40)), {})) < 1, 'the way back leads to the course 40 m on');
  check(Array.isArray(a2) && a2.length === 2, 'followCourse returns an aim');
}

// ---------- dodging ----------
console.log('dodge');
{
  freshPlay(game, 0, 0);
  const out = [0, 0];
  const c = car(rc(1) + 200, rc(2) + LANE, 0, px(15));
  G.cars.push(c);
  check(nav.dodge(c, c.x + 300, c.y, out) === Infinity && out[0] === c.x + 300, 'nothing ahead: the aim stays');
  const o = car(c.x + px(20), c.y, 0, 0);
  G.cars.push(o);
  const cap = nav.dodge(c, c.x + 300, c.y, out);
  const lat = -(out[0] - c.x) * Math.sin(c.a) + (out[1] - c.y) * Math.cos(c.a);
  check(cap === Infinity && lat < -px(3), `a stopped car dead ahead is passed on the left (aim ${(lat / 16).toFixed(1)} m to the side)`);
  check(nav.dodge(c, c.x + 300, c.y, out, o) === Infinity && out[1] === c.y, 'a car it means to ram is not dodged');
  // boxed in: oncoming traffic in the left lane and a wall of parked cars on the right
  G.cars.push(car(c.x + px(30), c.y - 2 * LANE, Math.PI, px(12)), car(c.x + px(24), c.y + px(3.5), 0, 0), car(c.x + px(16), c.y + px(3.5), 0, 0));
  const hold = nav.dodge(c, c.x + 300, c.y, out);
  check(hold === 0, `with both sides taken the car follows the stopped car (cap ${hold})`);
  // overtaking a slower car only when closing on it
  G.cars.length = 0; G.cars.push(c);
  const slow = car(c.x + px(20), c.y, 0, px(15));
  G.cars.push(slow);
  check(nav.dodge(c, c.x + 300, c.y, out) === Infinity && out[1] === c.y, 'a car ahead at the same speed is no threat');
}

// ---------- deliveries ----------
console.log('deliveryRoute');
{
  seed(9);
  let ok = 0, n = 0;
  for (const p of [{ x: rc(1) + 300, y: rc(1) + LANE }, { x: rc(3) + 200, y: rc(4) - LANE }, { x: rc(5) + 50, y: rc(2) + LANE }]) {
    for (let i = 0; i < 5; i++) {
      const d = nav.deliveryRoute(p.x, p.y, { min: 900, max: 3000 });
      n++;
      const real = roads.routeLength(p.x, p.y, d.curb.x, d.curb.y);
      if (d && world.deliveryDoors.includes(d.door) && d.curb === d.door.curb && d.len >= 900 && d.len <= 3000 && near(real, d.len, 1e-3)) ok++;
    }
  }
  check(ok === n, `a delivery door within the 900-3000 px drive band, with its route length (${ok}/${n})`);
  const miss = nav.deliveryRoute(rc(1), rc(1), { min: 1e6, max: 2e6 });
  check(miss && world.deliveryDoors.includes(miss.door), 'when no door fits the band the closest miss is returned');
  unseed();
}

// ---------- police and missions use nav ----------
check(pol.roadWaypoint === nav.roadWaypoint, 'police re-exports nav.roadWaypoint');

console.log(failed ? `s1c nav: ${failed} failed, ${passed} passed` : `s1c nav: ok (${passed} checks)`);
process.exit(failed ? 1 : 0);
