// Shared helpers for the S6a node tests (tools/s6a_*.mjs): road paths to drive along on the road graph, a
// simple driver that follows one at a set speed, and the 3D game's movement tuning. The game itself is
// loaded through tools/s1c_lib.mjs (browser-only modules stubbed, a seeded Math.random). Not a test itself.
export { loadGame, seed, unseed, ROOT } from './s1c_lib.mjs';

export const M = 16, DT = 1 / 60;
// main3d.js scales the sim to human size with these (src/3d/main3d.js, Object.assign(CFG, ...))
export const CFG_3D = { walk: 88, run: 150, tired: 55, playerR: 8, pedWalk: 15, pedFlee: 95, friendWalk: 15, friendRun: 175, aiLook: 125, carAcc: 0.5, carMax: 0.85 };
export const wrap = a => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));

// A path along the roads through (x, y) px, heading along `a`: `back` m behind and `ahead` m in front, `off` m
// right of the centre line (the right carriageway of a highway is +5.1). At a junction it carries straight on
// (the edge whose heading turns least). Returns [{ x, y, s }] in px, s from the first point.
export function roadPath(roads, x, y, a, back, ahead, off = 0) {
  const q = roads.nearest(x, y, { maxD: 60 * M });
  if (!q) return null;
  const E = roads.edges[q.edge];
  const i0 = Math.min(q.i, E.n - 2);
  const fwd = Math.cos(a) * E.tx[i0] + Math.sin(a) * E.ty[i0] >= 0 ? 1 : -1;
  const behind = walk(roads, E, i0 + (fwd > 0 ? 0 : 1), -fwd, back * M), front = walk(roads, E, i0 + (fwd > 0 ? 1 : 0), fwd, ahead * M);
  const pts = [...behind.reverse(), ...front];
  // offset to the right of travel, then the running station
  const out = [];
  for (let k = 0; k < pts.length; k++) {
    const p = pts[Math.max(0, k - 1)], n = pts[Math.min(pts.length - 1, k + 1)];
    const tx = n[0] - p[0], ty = n[1] - p[1], L = Math.hypot(tx, ty) || 1;
    out.push({ x: pts[k][0] - ty / L * off * M, y: pts[k][1] + tx / L * off * M, s: 0 });
  }
  for (let k = 1; k < out.length; k++) out[k].s = out[k - 1].s + Math.hypot(out[k].x - out[k - 1].x, out[k].y - out[k - 1].y);
  return out;
}

// Points along the edge polylines from sample i of edge E in direction dir (+1 = toward node b) for len px.
function walk(roads, E, i, dir, len) {
  const out = [];
  let d = 0, last = null;
  for (let guard = 0; guard < 50 && d < len; guard++) {
    for (; i >= 0 && i < E.n && d < len; i += dir) {
      const p = [E.x[i], E.y[i]];
      if (last) d += Math.hypot(p[0] - last[0], p[1] - last[1]);
      if (!last || p[0] !== last[0] || p[1] !== last[1]) out.push(p);
      last = p;
    }
    if (d >= len) break;
    // on through the node at this end, onto the edge that keeps the heading best
    const node = roads.nodes[dir > 0 ? E.b : E.a];
    const hx = dir > 0 ? E.tx[E.n - 1] : -E.tx[0], hy = dir > 0 ? E.ty[E.n - 1] : -E.ty[0];
    let best = null;
    for (const id of node.edges) {
      const F = roads.edges[id];
      for (const start of [true, false]) {
        if (F === E && start === (dir < 0)) continue;
        if ((start ? F.a : F.b) !== node.id) continue;
        const tx = start ? F.tx[0] : -F.tx[F.n - 1], ty = start ? F.ty[0] : -F.ty[F.n - 1];
        const dot = tx * hx + ty * hy;
        if (!best || dot > best.dot) best = { F, start, dot };
      }
    }
    if (!best) break;
    E = best.F; dir = best.start ? 1 : -1; i = best.start ? 0 : E.n - 1;
  }
  return out;
}

// The closest point of path P to (x, y), searching from index j on: { j, d (px, + = left of travel) }.
export function trackPath(P, x, y, j = 0) {
  let best = j, bd = Infinity;
  for (let k = Math.max(0, j - 2); k < Math.min(P.length, j + 60); k++) {
    const d = Math.hypot(P[k].x - x, P[k].y - y);
    if (d < bd) { bd = d; best = k; }
  }
  const k = Math.min(best, P.length - 2), tx = P[k + 1].x - P[k].x, ty = P[k + 1].y - P[k].y, L = Math.hypot(tx, ty) || 1;
  return { j: best, d: -((x - P[k].x) * -ty + (y - P[k].y) * tx) / L };
}

// One frame of a driver holding speed v (px/s) along path P, aiming `look` m ahead: the input for driveCar.
export function driveAlong(c, P, j, v, look = 10, extra = {}) {
  let k = j;
  while (k < P.length - 1 && P[k].s - P[j].s < look * M) k++;
  const fwd = c.vx * Math.cos(c.a) + c.vy * Math.sin(c.a);
  const da = wrap(Math.atan2(P[k].y - c.y, P[k].x - c.x) - c.a);
  return { up: fwd < v, steer: Math.max(-1, Math.min(1, da * 4)), ...extra };
}

// Kimchi alone in the world in a new car of `type` at (x, y) heading a, moving at v px/s.
export function soloCar(game, type, x, y, a, v = 0) {
  const { G, ent } = game;
  Object.assign(G, { mode: 'play', cars: [], peds: [], friends: [], energy: 100, shake: 0, wanted: 0 });
  const c = ent.makeCar(type, x, y, a);
  c.vx = Math.cos(a) * v; c.vy = Math.sin(a) * v;
  G.cars.push(c);
  Object.assign(G.player, { car: c, x, y, dead: false });
  return c;
}
