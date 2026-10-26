// Shared harness for the stage S8 node tests (tools/s8_*.mjs): the game's sim (tools/s1c_lib.mjs, with the
// browser-only modules stubbed) plus src/3d/activities.js, the 3D game's movement settings, and a driver that
// takes Kimchi's car along a polyline (a route, a zone) the way main3d's &route= dev pilot does: pure pursuit
// on the line, as fast as the bend ahead allows at a share of the 2 g grip. Not a test itself.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadGame, seed, ROOT } from './s1c_lib.mjs';

export { seed, ROOT };
export const M = 16;
export const CFG_3D = { walk: 88, run: 150, tired: 55, playerR: 8, pedWalk: 15, pedFlee: 95, friendWalk: 15, friendRun: 175, aiLook: 125, carAcc: 0.5, carMax: 0.85 };

export async function loadS8() {
  const game = await loadGame();
  game.act = await import(pathToFileURL(path.join(ROOT, 'src/3d/activities.js')).href);
  game.save = await import(pathToFileURL(path.join(ROOT, 'src/save.js')).href);
  game.data = await import(pathToFileURL(path.join(ROOT, 'src/data.js')).href);
  Object.assign(game.ent.CFG, CFG_3D);
  // the game's UI as activities.js sees it: everything it says is logged; travel is instant
  const log = game.alog = { toast: [], sound: [], saves: 0, travel: [], celebrate: 0 };
  game.act.initActivities({
    toast: (t) => log.toast.push(t),
    sound: (k) => log.sound.push(k),
    menu: (b) => { log.menu = b(); },
    closeMenu() {},
    save: () => { log.saves++; game.save.save(); },
    celebrate: () => { log.celebrate++; },
    travel: (to, { car, done }) => {
      // game.noCars: Kimchi owns no car that can drive, so main3d's travel leaves him where he is
      if (car && game.noCars && !game.G.player.car) { done?.(false, 'nocar'); return; }
      log.travel.push({ ...to, car }); travelNow(game, to, car); done?.();
    },
  });
  return game;
}

// main3d's travel, without the fade and the 3D: Kimchi (in his car, or one of his own for an event) to `to`.
function travelNow(game, to, car) {
  const { G, ent } = game, p = G.player;
  let c = p.car && !p.car.wreck && !(p.car.hp <= 0) ? p.car : null;
  if (car && !c) {
    c = G.ownedCar && G.cars.includes(G.ownedCar) ? G.ownedCar : null;
    if (!c) { c = ent.makeCar('ursa', to.x, to.y, to.a); c.owned = true; G.cars.push(c); }
  }
  if (car && c) {
    Object.assign(c, { x: to.x, y: to.y, a: to.a, vx: 0, vy: 0, speed: 0, gy: undefined, vh: 0, air: 0 });
    Object.assign(p, { car: c, x: c.x, y: c.y });
  } else {
    p.car = null;
    Object.assign(p, { x: to.x, y: to.y });
  }
}

// A fresh play state at (x, y) px, on foot, an empty world (no traffic: the tests time the driving alone).
export function fresh(game, x, y) {
  const { G, state } = game;
  state.resetState();
  Object.assign(G, { mode: 'play', t: 0, cars: [], peds: [], friends: [], wanted: 0, evadeT: 0, heatT: 0, energy: 100, money: 0 });
  Object.assign(G.player, { x, y, car: null, dead: null, moving: false, heading: 0 });
  game.mis.resetMissions();
  const S = game.act.activityState;
  Object.assign(S, { car: null, zone: null, jump: null, wasAir: false, event: null, pop: null });
  S.pops.length = 0; S.said.length = 0;
  for (const k in S.trapT) delete S.trapT[k];
}

// Kimchi in a new car at (x, y) px heading a, moving at v m/s.
export function carAt(game, x, y, a, v = 0, type = 'ursa') {
  const { G, ent } = game;
  const c = ent.makeCar(type, x, y, a);
  Object.assign(c, { vx: Math.cos(a) * v * M, vy: Math.sin(a) * v * M, speed: v * M });
  G.cars = [c];
  Object.assign(G.player, { car: c, x, y });
  return c;
}

// One frame as main3d.update orders it (player, missions, activities); no traffic.
export function frame(game, dt, inp) {
  const { G, ent, mis, act } = game;
  G.t += dt;
  ent.updatePlayer(dt, inp || {});
  mis.updateMissions(dt);
  act.updateActivities(dt);
}

// A driver along nav ({ pts Float32Array px, s?, laps? }): returns inp for this frame. grip: the share of the
// 2 g the bends are taken at; vmax m/s.
export function makeDriver(game, nav, { grip = 0.8, vmax = 99, jumpV = 26 } = {}) {
  const { G, world } = game, roads = world.roads;
  const n = nav.pts.length / 2;
  // the danger-sign jumps are taken at jumpV at most, so the car lands on the road
  const jumps = world.activities.filter(a => a.type === 'jump');
  return () => {
    const c = G.player.car;
    const v = (c.vx * Math.cos(c.a) + c.vy * Math.sin(c.a)) / M;
    // a lap course starts its line again once the car is round
    if (nav.loop && nav.i != null && nav.i > n - 6) { const d = Math.hypot(c.x - nav.pts[0], c.y - nav.pts[1]); if (d < 12 * M) nav.i = 0; }
    const pt = roads.follow(nav, c.x, c.y, Math.min(30, Math.max(8, 8 + 0.5 * v)) * M);
    let want = Math.min(vmax, Math.sqrt(grip * 2 * 9.81 * bendAhead(nav, Math.max(40, v * v / 12 + 20))));
    for (const j of jumps) {
      const u = ((j.x - c.x) * Math.cos(j.a) + (j.y - c.y) * Math.sin(j.a)) / M;
      const w = (-(j.x - c.x) * Math.sin(j.a) + (j.y - c.y) * Math.cos(j.a)) / M;
      if (u > -2 && u < 30 + v * v / 14 && Math.abs(w) < 12) want = Math.min(want, jumpV);
    }
    const steer = Math.max(-1, Math.min(1, angDiff(c.a, Math.atan2(pt[1] - c.y, pt[0] - c.x)) * 2.5));
    return { up: v < want, down: v > want * 1.06, steer };
  };
}
const angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

// the tightest radius (m) of the line over len m ahead of where it was last followed (points 6 m apart)
function bendAhead(nav, len) {
  const at = nav.at || 0, pts = [];
  for (let d = 0; d <= len; d += 6) pts.push(pointAt(nav, at + d * M));
  let r = Infinity;
  for (let k = 1; k + 1 < pts.length; k++) {
    const x1 = pts[k][0] - pts[k - 1][0], y1 = pts[k][1] - pts[k - 1][1], x2 = pts[k + 1][0] - pts[k][0], y2 = pts[k + 1][1] - pts[k][1];
    if (Math.hypot(x1, y1) < 3 * M || Math.hypot(x2, y2) < 3 * M) continue;   // past the line's end
    const turn = Math.abs(Math.atan2(x1 * y2 - y1 * x2, x1 * x2 + y1 * y2));
    if (turn > 1e-4) r = Math.min(r, (Math.hypot(x1, y1) + Math.hypot(x2, y2)) / 2 / M / turn);
  }
  return r;
}
function pointAt(nav, s) {
  const P = nav.pts, st = nav.s, n = st.length;
  if (nav.loop) s = ((s % st[n - 1]) + st[n - 1]) % st[n - 1];
  let lo = 0, hi = n - 1;
  if (s >= st[hi]) return [P[2 * hi], P[2 * hi + 1]];
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (st[mid] <= s) lo = mid; else hi = mid; }
  const f = (s - st[lo]) / Math.max(1e-6, st[hi] - st[lo]);
  return [P[2 * lo] + (P[2 * hi] - P[2 * lo]) * f, P[2 * lo + 1] + (P[2 * hi + 1] - P[2 * lo + 1]) * f];
}

// Drives an event from the race board to its finish: returns { t, done, splits } (or why it stopped).
export function runEvent(game, id, opts = {}) {
  const { G, world, act } = game, DT = 1 / 60;
  const R = world.routes[id];
  if (!act.startEvent(id)) return { done: false, why: game.alog.toast.at(-1) };
  const nav = { pts: R.pts, s: R.s, loop: (R.laps || 1) > 1 };
  const drive = makeDriver(game, nav, opts);
  const S = act.activityState;
  const before = G.pr.events?.[id]?.best;
  for (let t = 0; t < 400; t += DT) {
    const E = S.event;
    if (!E) break;
    frame(game, DT, E.phase === 'count' ? {} : drive());
  }
  const rec = G.pr.events?.[id];
  return { done: !!rec && rec.best !== before, rec, t: rec?.best, pops: S.pops.slice(-1) };
}
