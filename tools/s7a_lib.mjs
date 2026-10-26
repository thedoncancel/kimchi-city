// Shared harness for the stage S7a node tests (tools/s7a_*.mjs): a bot that plays the story missions the way
// a player would, from the mission marker to MISSION PASSED, on either world. It drives Kimchi's car along the
// roads (nav.roadWaypoint and police.steerTo, the same driving the game's own AI cars use), walks him to the
// markers and car doors, shoots the Bandanas in Bad Rep, rams the boss in Kimchi Empire and loses the cops at
// K-Spray or by running. The game's modules load through tools/s1c_lib.mjs (browser-only modules stubbed);
// the movement settings are the 3D game's (main3d's CFG), not the 2D defaults. Not a test itself.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadGame, seed, unseed, ROOT } from './s1c_lib.mjs';

export { seed, unseed };
export const M = 16;                 // px per metre
export const px = m => m * M;
// main3d's movement settings: human-scale walking, and cars at 0.85 of their top speed and half their
// acceleration
export const CFG_3D = { walk: 88, run: 150, tired: 55, playerR: 8, pedWalk: 15, pedFlee: 95, friendWalk: 15, friendRun: 175, aiLook: 125, carAcc: 0.5, carMax: 0.85 };

export async function loadPlay() {
  const game = await loadGame();
  game.data = await import(pathToFileURL(path.join(ROOT, 'src/data.js')).href);
  Object.assign(game.ent.CFG, CFG_3D);
  return game;
}

// A fresh save: Kimchi on the villa's foot spot, the world spawned, his Ursa on the drive.
export function freshSave(game) {
  const { G, state, ent, pol, mis, world } = game;
  state.resetState();
  Object.assign(G, { mode: 'play', t: 0, cars: [], peds: [], friends: [], wanted: 0, evadeT: 0, heatT: 0, energy: 100 });
  const foot = world.places.home.foot;
  Object.assign(G.player, { x: foot.x, y: foot.y, car: null, dead: null, moving: false, heading: foot.a });
  pol.resetPolice();
  mis.resetMissions();
  ent.spawnWorld();
  ent.spawnGarage();
  return unstick(game);
}

// entities.moveChar refuses every step while Kimchi's circle already touches a blocked cell, so a spawn spot
// within his radius of a wall or water (the v2 villa's foot spot is 0.4 m from the pool) holds him there for
// good at 60 fps. Puts him on the nearest clear spot within 1.5 m and returns how far he was moved (m), or 0.
export function unstick(game) {
  const { G, ent } = game, p = G.player, r = ent.CFG.playerR;
  if (!ent.circleBlocked(p.x, p.y - 4, r)) return 0;
  for (let d = 2; d <= 24; d += 2) {
    for (let k = 0; k < 16; k++) {
      const a = k * Math.PI / 8, x = p.x + Math.cos(a) * d, y = p.y + Math.sin(a) * d;
      if (!ent.circleBlocked(x, y - 4, r)) { p.x = x; p.y = y; return d / M; }
    }
  }
  return -1;
}

// The top speed a car really reaches in the 3D game: driveCar's soft cap settles a third of its acceleration
// above its top speed (px/s).
export function topSpeed(game, type) {
  const t = game.data.CAR_TYPES[type];
  return t.max * CFG_3D.carMax + t.acc * CFG_3D.carAcc / 3;
}

// ---------- one frame ----------

// What the bot does this frame goes in `inp` (on foot) or has already moved the car (driving); this then
// runs the rest of main3d.update's order: the world, the police, the missions, the markers.
export function frame(game, dt, inp = null) {
  const { G, ent, pol, mis } = game, p = G.player;
  G.t += dt;
  if (!p.car) ent.updatePlayer(dt, inp || {});
  else if (inp) ent.updatePlayer(dt, inp);
  else { p.x = p.car.x; p.y = p.car.y; }
  ent.updateWorld(dt);
  burn(game, dt);
  pol.updatePolice(dt);
  mis.updateMissions(dt);
  if (!p.car && !p.dead) mis.tryStartAt(p.x, p.y);
}

// combat.js (stubbed here): a car at 0 hp burns for 4 s and then is a wreck
function burn(game, dt) {
  for (const c of game.G.cars) {
    if (c.wreck || !(c.hp <= 0)) continue;
    if (!(c.burnT > 0)) { c.burnT = 4; c.ai = null; continue; }
    if ((c.burnT -= dt) <= 0) Object.assign(c, { wreck: true, burnT: 0, hp: 0, ai: null, vx: c.vx * 0.2, vy: c.vy * 0.2 });
  }
}

// ---------- driving and walking ----------

const BRAKE = 5 * M;    // px/s^2 the bot plans to stop with

// Drive Kimchi's car toward (tx, ty) along the roads: no faster than cap, slowing to stop within `stop` px of
// it. o.ignore: a car not to steer round (one being rammed). o.direct: straight at the target, not by road.
export function driveTo(game, dt, tx, ty, { cap = Infinity, stop = 0, ignore = null, direct = false, grip } = {}) {
  const { G, nav } = game, c = G.player.car;
  const d = Math.hypot(tx - c.x, ty - c.y);
  if (stop && d < stop) { steer(game, c, dt, tx, ty, { stopWithin: 1e9 }); return d; }
  const [ax, ay] = direct ? [tx, ty] : nav.roadWaypoint(c, tx, ty);
  const arrive = stop ? Math.sqrt(2 * BRAKE * Math.max(0, d - stop)) + 40 : Infinity;
  steer(game, c, dt, ax, ay, { curv: direct ? 0 : nav.curvatureAhead(c), dodge: true, cap: Math.min(cap, arrive), ignore, grip, corner: 300 });
  return d;
}

// police.steerTo for Kimchi's car, as a player drives: nav.dodge takes a car parked in a kerb bay beside his
// lane (3-3.5 m off, short of its PASS of 3.5 m centre to centre) for a car in the way, and holds a driver to
// its speed (0) whenever the pass it plans is not clear, so its drivers crawl down avenues with parking. A
// player drives past them, so the bot's steering leaves out the standing cars more than KERB_LAT to the side
// (game.rawNav keeps them, to see the AI as it is).
const KERB_LAT = 2.6 * M;
export function steer(game, c, dt, ax, ay, o) {
  const { G, pol } = game;
  if (game.rawNav || !o.dodge) return pol.steerTo(c, dt, ax, ay, o);
  const all = G.cars, fx = Math.cos(c.a), fy = Math.sin(c.a);
  G.cars = all.filter(k => k === c || k.ai || Math.hypot(k.vx || 0, k.vy || 0) > 20 || Math.abs(-(k.x - c.x) * fy + (k.y - c.y) * fx) < KERB_LAT);
  try { return pol.steerTo(c, dt, ax, ay, o); } finally { G.cars = all; }
}

// Walk (run) Kimchi toward (tx, ty); the input for frame().
// Walking goes round walls and water: a breadth-first path over 1 m cells where Kimchi's circle fits (within
// WALK_BOX of him and the target), made again when the target moves or every 3 s, and followed point by point.
// Straight at the target when no path is found; when the target cannot be reached (it stands in a car's
// box), the path ends at the free spot nearest it.
const WALK_BOX = 90;    // m
export function walkInput(game, tx, ty) {
  const { G, ent } = game, p = G.player, d = Math.hypot(tx - p.x, ty - p.y);
  if (d <= 6) return {};
  const w = game.walk || (game.walk = {});
  if (!w.path || Math.hypot(tx - w.tx, ty - w.ty) > 3 * M || G.t - w.t > 3 || G.t < w.t) {
    Object.assign(w, { tx, ty, t: G.t, path: walkPath(game, p.x, p.y, tx, ty), i: 0 });
  }
  let ax = tx, ay = ty;
  if (w.path) {
    while (w.i < w.path.length - 1 && Math.hypot(w.path[w.i].x - p.x, w.path[w.i].y - p.y) < 0.8 * M) w.i++;
    ax = w.path[w.i].x; ay = w.path[w.i].y;
    if (w.i === w.path.length - 1 && Math.hypot(ax - p.x, ay - p.y) < 0.3 * M) return {};
  }
  const dx = ax - p.x, dy = ay - p.y, L = Math.hypot(dx, dy) || 1;
  return { ax: dx / L, ay: dy / L, run: true };
}
// A little room (4 px) round him, since he walks between cell centres; none when that leaves no way out of
// a tight spot (between a parked car and a wall).
function walkPath(game, x0, y0, x1, y1) {
  return walkSearch(game, x0, y0, x1, y1, game.ent.CFG.playerR + 4) || walkSearch(game, x0, y0, x1, y1, game.ent.CFG.playerR);
}
function walkSearch(game, x0, y0, x1, y1, r) {
  const { ent } = game;
  const ox = Math.floor(Math.min(x0, x1) / M) - WALK_BOX / 2, oz = Math.floor(Math.min(y0, y1) / M) - WALK_BOX / 2;
  const W = Math.ceil(Math.abs(x1 - x0) / M) + WALK_BOX, H = Math.ceil(Math.abs(y1 - y0) / M) + WALK_BOX;
  if (W * H > 600 * 600) return null;
  // cars standing still are in the way too (pushOutOfCars keeps him outside their boxes)
  const cars = game.G.cars.filter(c => Math.hypot(c.vx, c.vy) < 20 && game.G.player.car !== c);
  const inCar = (x, y) => cars.some(c => {
    const t = game.data.CAR_TYPES[c.type], dx = x - c.x, dy = y - 4 - c.y, ca = Math.cos(c.a), sa = Math.sin(c.a);
    return Math.abs(dx * ca + dy * sa) < t.len / 2 + r && Math.abs(-dx * sa + dy * ca) < t.wid / 2 + r;
  });
  const free = (i, j) => { const x = (ox + i + 0.5) * M, y = (oz + j + 0.5) * M; return !ent.circleBlocked(x, y - 4, r) && !inCar(x, y); };
  const at = (x, y) => [Math.floor(x / M) - ox, Math.floor(y / M) - oz];
  const [si, sj] = at(x0, y0), [ti, tj] = at(x1, y1);
  const prev = new Int32Array(W * H).fill(-2), q = [si + sj * W];
  prev[q[0]] = -1;
  let found = -1, best = q[0], bd = Infinity;
  for (let h = 0; h < q.length; h++) {
    const k = q[h], i = k % W, j = (k - i) / W;
    const dd = Math.hypot(i - ti, j - tj);
    if (dd < bd) { bd = dd; best = k; }
    if (dd < 1.5) { found = k; break; }
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const a = i + di, b = j + dj, n = a + b * W;
      if (a < 0 || b < 0 || a >= W || b >= H || prev[n] !== -2 || !free(a, b)) continue;
      if (di && dj && (!free(i + di, j) || !free(i, j + dj))) continue;    // no cutting a corner
      prev[n] = k; q.push(n);
    }
  }
  const pts = [];
  for (let k = found >= 0 ? found : best; k >= 0; k = prev[k]) { const i = k % W, j = (k - i) / W; pts.push({ x: (ox + i + 0.5) * M, y: (oz + j + 0.5) * M }); }
  pts.reverse();
  // the target itself only when the search got there; else the free spot nearest it is the end
  if (found >= 0) pts.push({ x: x1, y: y1 });
  return pts.length > 1 ? pts : null;
}

export const speedOf = c => (c ? Math.hypot(c.vx, c.vy) : 0);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------- the mission bot ----------

// A player bot for the story missions. Each frame bot.tick(dt) looks at the mission step running (or, with
// none, walks to the next giver's marker) and drives, walks, shoots or waits; it returns the on-foot input
// for frame(), or null while driving. o: { cap: px/s the bot never drives above (Infinity), deliverCap: its
// cap on delivery runs, carefulCap: its cap with a passenger who minds the paint (25 m/s), escape: 'spray' (lose the cops at K-Spray) or 'run' (outrun them), raceGrip: m/s^2
// the bot corners at in the race, aim: 0..1 the share of pistol shots that hit }.
// bot.log gets { t, kind, ... } records: start, pass, fail, delivered, race, lost, respawn, stuck.
export function makeBot(game, o = {}) {
  const { G, world, ent, mis, pol, nav, data } = game;
  const { places } = world;
  const opt = { cap: Infinity, deliverCap: Infinity, carefulCap: 25 * M, escape: 'spray', raceGrip: 17.5, aim: 0.7, ...o };
  const B = { log: [], shootT: 0, walk: null, idleT: 0, stepRef: null, stepT: 0, wantedAt: null, escapeGoal: null };
  const p = G.player;
  const log = (kind, extra = {}) => B.log.push({ t: +G.t.toFixed(2), kind, ...extra });
  const car = () => (p.car && !p.car.wreck && p.car.hp > 0 ? p.car : null);
  // close enough for E to get in (entities.findTarget's reach)
  const reach = c => Math.hypot(c.x - p.x, c.y - 4 - p.y) - data.CAR_TYPES[c.type].len * 0.25 < 45;

  // stop where we are
  function hold(dt) {
    const c = p.car;
    if (c) steer(game, c, dt, c.x + Math.cos(c.a) * 100, c.y + Math.sin(c.a) * 100, { stopWithin: 1e9 });
    return null;
  }

  // Out of a wrecked or burning car, then to the nearest car Kimchi may take: his own first, a parked one,
  // and only with nothing within 80 m a traffic car (a carjack, which earns a star, as in the game).
  // A car he cannot walk to (across water, behind a wall) is given up after 6 s without getting closer.
  const unreachable = new Map();
  function getCar(dt, avoid = []) {
    if (p.car && !car()) { ent.exitCar(); if (p.car) p.car = null; }
    if (car()) return true;
    const usable = c => !c.locked && !c.police && !c.wreck && c.hp > 0 && !c.managed && !avoid.includes(c) && !c.raceRival &&
      !(unreachable.get(c) > G.t);
    let best = null, bd = Infinity;
    for (const c of G.cars) {
      if (!usable(c)) continue;
      const d = dist(c, p) * (c.owned ? 0.5 : c.ai ? 3 : 1);
      if (d < bd) { bd = d; best = c; }
    }
    if (!best) return false;
    if (reach(best)) { ent.enterCar(best); best.nav = null; B.carWalk = null; return true; }
    const w = B.carWalk;
    if (!w || w.c !== best) B.carWalk = { c: best, d: dist(best, p), t: G.t };
    else if (dist(best, p) < w.d - px(1)) { w.d = dist(best, p); w.t = G.t; }
    else if (G.t - w.t > 6) { unreachable.set(best, G.t + 30); B.carWalk = null; log('stuck', { what: 'walk to car' }); }
    B.input = walkInput(game, best.x, best.y);
    return false;
  }

  // Drive to (x, y), or walk there when close and on foot. Done (true) once within r.
  function goTo(dt, x, y, r, { needCar = true, cap = opt.cap, stop = r * 0.5, ignore = null } = {}) {
    const d = Math.hypot(x - p.x, y - p.y);
    if (d < r) { hold(dt); return true; }
    if (!car() && (!needCar && d < px(60))) { B.input = walkInput(game, x, y); return false; }
    if (!getCar(dt)) return false;
    const c = p.car;
    driveTo(game, dt, x, y, { cap, stop, ignore });
    // parked as near as the car gets but not there yet (a door off the road): get out and walk
    if (speedOf(c) < 15 && d < px(25)) { if ((B.idleT += dt) > 2) { ent.exitCar(); B.idleT = 0; } } else B.idleT = 0;
    return false;
  }

  // The next mission's marker: drive to its place's curb, get out and walk onto the marker.
  function toGiver(dt) {
    const m = mis.availableMissions()[0];
    if (!m) return hold(dt);
    // a battered car goes to K-Spray first ($2,500 makes it good as new), as a player would
    if (car() && p.car.hp < 50 && G.money >= 2500) {
      const bay = places.spray.bay;
      if (!B.repairing) { B.repairing = true; log('repair', { hp: Math.round(p.car.hp) }); }
      driveTo(game, dt, bay.x, bay.y, { cap: opt.cap, stop: px(1) });
      return null;
    }
    B.repairing = false;
    const s = mis.giverSpot(m), pl = places[m.giver];
    if (car()) {
      const cu = pl.curb;
      if (dist(p, cu) < px(10) && speedOf(p.car) < 30) { ent.exitCar(); return null; }
      if (dist(p, s) < px(12)) { hold(dt); if (speedOf(p.car) < 30) ent.exitCar(); return null; }
      driveTo(game, dt, cu.x, cu.y, { cap: opt.cap, stop: px(4) });
      return null;
    }
    if (dist(p, s) > px(60) && getCar(dt) === false && B.input) return B.input;
    if (car()) return null;
    return walkInput(game, s.x, s.y);
  }

  function shoot(dt, target, isCar) {
    if ((B.shootT -= dt) > 0) return;
    B.shootT = 1 / 3.2;
    if (Math.random() > opt.aim) return;
    if (isCar) { ent.damageCar(target, 36 * 0.35); target.hitByPlayer = true; }
    else ent.hurtPed(target, 36, { byPlayer: true });
  }

  const STEP = {
    talk: dt => (car() ? hold(dt) : null),
    wanted: dt => hold(dt),
    incar: dt => (getCar(dt) ? hold(dt) : B.input),
    goto(dt, s) {
      if (s.tag && !(car() && p.car.tag === s.tag)) {
        const t = G.cars.find(c => c.tag === s.tag);
        if (!t) return hold(dt);
        if (car()) { if (goTo(dt, t.x, t.y, px(8))) ent.exitCar(); return null; }
        if (reach(t)) { ent.enterCar(t); t.nav = null; return null; }
        return walkInput(game, t.x, t.y);
      }
      // the start line of a race: come up to it along the course, so the car faces the right way at the GO
      const a = mis.missionState.active, next = a.def.steps[a.i + 1];
      if (next?.type === 'race' && s.pt.a != null && car()) {
        const back = { x: s.pt.x - Math.cos(s.pt.a) * px(45), y: s.pt.y - Math.sin(s.pt.a) * px(45) };
        if (B.lineUp !== s) { B.lineUp = s; B.viaBack = Math.cos(p.car.a - s.pt.a) < 0.7; }
        if (B.viaBack && dist(p, back) < px(12)) B.viaBack = false;
        if (B.viaBack) { driveTo(game, dt, back.x, back.y, { cap: opt.cap, stop: px(6) }); return null; }
      }
      goTo(dt, s.pt.x, s.pt.y, (s.r || 100) * 0.9, { needCar: !!s.car || dist(p, s.pt) > px(60) });
      return car() ? null : B.input;
    },
    pickup(dt, s) {
      const f = s.f;
      if (!getCar(dt)) return B.input;
      driveTo(game, dt, f.x, f.y, { cap: opt.cap, stop: px(11) });
      return null;
    },
    dropoff(dt, s) {
      if (!getCar(dt)) return B.input;
      // a passenger who minds the car's paint gets a careful driver
      driveTo(game, dt, s.pt.x, s.pt.y, { cap: s.maxDamage ? Math.min(opt.cap, opt.carefulCap) : opt.cap, stop: px(3) });
      return null;
    },
    deliver(dt, s) {
      if (!getCar(dt)) return B.input;
      if (B.order !== s.pt) { B.order = s.pt; B.orderLeft = s.left; B.orderLen = s.len; }
      driveTo(game, dt, s.pt.x, s.pt.y, { cap: Math.min(opt.cap, opt.deliverCap), stop: px(2) });
      return null;
    },
    race(dt, s) {
      const c = car();
      if (!c) return getCar(dt) ? null : B.input;
      if (!s.go) { B.raced = false; return hold(dt); }
      if (!B.raced || B.raceCar !== c) { B.raced = true; nav.setRoute(c, s.R); c.back = null; B.raceT0 = G.t; B.raceCar = c; }
      const pt = nav.followCourse(c);
      steer(game, c, dt, pt[0], pt[1], { corner: 300, cap: opt.cap, curv: nav.curvatureAhead(c, undefined, c.back || c.nav), grip: opt.raceGrip, dodge: true });
      return null;
    },
    kill(dt, s) {
      const left = s.gang.filter(g => g.state !== 'down' && !g.dying);
      if (!left.length) return hold(dt);
      let g = left[0];
      for (const q of left) if (dist(q, p) < dist(g, p)) g = q;
      if (car()) {
        if (dist(g, p) < px(18) && speedOf(p.car) < 40) { ent.exitCar(); return null; }
        driveTo(game, dt, g.x, g.y, { cap: opt.cap, stop: px(14) });
        return null;
      }
      if (dist(g, p) > px(20)) return walkInput(game, g.x, g.y);
      shoot(dt, g, false);
      return {};
    },
    lose(dt) {
      if (B.wantedAt == null) B.wantedAt = G.t;
      if (!getCar(dt)) return B.input;
      if (opt.escape === 'spray') {
        const bay = places.spray.bay;
        driveTo(game, dt, bay.x, bay.y, { cap: opt.cap, stop: px(1) });
        return null;
      }
      // run: to a far junction away from the nearest cruiser, a new one on arrival
      const cops = pol.police.cars.filter(c => !c.wreck && c.hp > 0);
      if (!B.escapeGoal || dist(p, B.escapeGoal) < px(30)) {
        let best = null, bs = -Infinity;
        for (const n of world.roads.nodes) {
          const dn = dist(n, p);
          if (n.edges.length < 2 || dn < px(250) || dn > px(700)) continue;
          const sc = Math.min(...cops.map(c => dist(c, n)), 1e9) - dn * 0.5 + Math.random() * px(50);
          if (sc > bs) { bs = sc; best = n; }
        }
        B.escapeGoal = best || world.roads.nodes[0];
      }
      driveTo(game, dt, B.escapeGoal.x, B.escapeGoal.y, { cap: opt.cap });
      return null;
    },
    getcar(dt, s) {
      const t = s.car;
      if (p.car === t) return hold(dt);
      if (!car() && dist(t, p) > px(60)) return getCar(dt, [t]) ? null : B.input;
      if (car()) { if (goTo(dt, t.x, t.y, px(9))) ent.exitCar(); return null; }
      if (reach(t)) { ent.enterCar(t); t.nav = null; return null; }
      return walkInput(game, t.x, t.y);
    },
    spray(dt, s) {
      const t = G.cars.find(c => c.tag === s.tag);
      if (!(car() && p.car === t)) return STEP.getcar(dt, { car: t });
      const bay = places.spray.bay;
      driveTo(game, dt, bay.x, bay.y, { cap: opt.cap, stop: px(1) });
      return null;
    },
    destroy(dt, s) {
      const boss = s.car;
      if (!boss || boss.hp <= 0) return hold(dt);
      const d = dist(boss, p);
      // on foot (out to shoot a boss that has stopped): shoot until he drives off
      if (!car()) {
        if (d < px(30)) { shoot(dt, boss, true); return speedOf(boss) > px(6) ? walkInput(game, boss.x, boss.y) : {}; }
        if (getCar(dt, [boss])) return null;
        return B.input;
      }
      const c = p.car;
      if (d < px(60)) {
        const lx = boss.x + boss.vx * 0.3, ly = boss.y + boss.vy * 0.3;
        steer(game, c, dt, lx, ly, { ignore: boss, dodge: true, corner: 400 });
        // both stopped close together: get out and shoot
        if (speedOf(boss) < px(2) && speedOf(c) < px(2) && d < px(15)) { if ((B.idleT += dt) > 2) { ent.exitCar(); B.idleT = 0; } } else B.idleT = 0;
      } else driveTo(game, dt, boss.x, boss.y, { cap: opt.cap, ignore: boss });
      return null;
    },
  };

  B.tick = function tick(dt) {
    B.input = null;
    const a = mis.missionState.active;
    if (!a) return toGiver(dt);
    if (B.stepRef !== a.s) { B.stepRef = a.s; B.stepT = 0; B.escapeGoal = null; if (a.s.type !== 'lose') B.wantedAt = null; }
    B.stepT += dt;
    const h = STEP[a.s.type];
    return h ? h(dt, a.s) : hold(dt);
  };
  return B;
}
