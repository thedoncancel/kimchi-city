// Pedestrians on the sidewalk graph (docs/map-v2-spec.md §9 Peds). A civilian walks a sidewalk path of the
// road graph's walks (on the grid: the ring of pavement round every block, joined at the corners, plus the
// crosswalks at every junction), turning onto the next path at each end with a continuous heading. A crosswalk
// is taken only when no moving car is within 15 m of it (or what a fast one needs to stop); a car waiting at
// it does not hold people up. After a flee or a knock-back a ped walks back to the nearest sidewalk within
// 25 m (80 m when there is none that close, as on a highway), sliding round walls with whiskers and hurrying
// over road cells, which fixes the old peds stuck standing on roads.
//
// Walk state on the ped: p.walk = { path, s, dir (+1 along the path, -1 against), next, waitT } while on a
// path; p.snap = { x, y, path, s } while heading back to one; p.lost once it cannot get back (population then
// moves it when nobody is looking). p.off is how far right of the centre line it keeps, p.vk its pace.
// Pure sim: no three, no DOM, runs in node.
import { G } from '../state.js';
import { roads, PX_PER_M, blockedFootPx, tileAtPx, ROAD } from '../world.js';

const M = PX_PER_M;
const CROSS_P = 0.35;            // the chance a ped takes a crosswalk where one starts
const CROSS_CLEAR = 15 * M;      // no car this close to a crosswalk when a ped steps onto it (further for a fast
const CROSS_BRAKE = 5 * M;       // one: what it needs to stop braking at this, px/s², and STAND_CLEAR) ...
const STAND_CLEAR = 4 * M;       // ... nor a traffic car waiting this close (half the longest car and a metre)
const KERB_WAIT = 6;             // s: waiting longer than this at a kerb, a ped walks on instead
const PRE = 2.5 * M;             // the next path is picked this far before the end of this one
const OFF_SLOPE = 0.2;           // how far a ped drifts to its side of the pavement (and to 0 on a crosswalk) per
                                 // metre walked: at most 11° off its path, so the body does not swing as it drifts
const SNAP = 25 * M;             // after a flee, a ped heads for a sidewalk this close
const SNAP_FAR = 80 * M;         // ... or, with none that close (it fled onto a highway), this close: better a
                                 // walk back than standing about on the road until nobody is looking
const HURRY = 2.5;               // walking back, a ped runs over road cells at this times its pace
const ROAD_GRACE = 8;            // s: walking back across a road for longer than this (on top of the time the walk
                                 // back takes at the ped's pace, p.snapEta) counts as standing on it
const LOST_T = 20;               // s: a ped not back on a sidewalk after this (and its p.snapEta) is lost
const STEP_R = 0.5 * M;          // a ped's radius for walls
const WHISKERS = [0, 35, -35, 70, -70].map(d => d * Math.PI / 180);

const angDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
const paths = () => roads.walks?.paths || [];

// Point and smoothly turning tangent at station s of a walk path ({ pts, s, n }); like the car pose, the
// tangent blends across each sample so a ped turns without steps.
function poseWalk(P, s, out) {
  const n = P.n, S = P.s, Q = P.pts;
  s = Math.max(0, Math.min(s, S[n - 1]));
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
  const ds = S[hi] - S[lo], f = ds > 1e-9 ? (s - S[lo]) / ds : 0;
  out.x = Q[2 * lo] + (Q[2 * hi] - Q[2 * lo]) * f;
  out.y = Q[2 * lo + 1] + (Q[2 * hi + 1] - Q[2 * lo + 1]) * f;
  const a0 = Math.max(0, lo - 1), b1 = Math.min(n - 1, hi + 1);
  let tx0 = Q[2 * hi] - Q[2 * a0], ty0 = Q[2 * hi + 1] - Q[2 * a0 + 1], tx1 = Q[2 * b1] - Q[2 * lo], ty1 = Q[2 * b1 + 1] - Q[2 * lo + 1];
  const l0 = Math.hypot(tx0, ty0) || 1, l1 = Math.hypot(tx1, ty1) || 1;
  tx0 /= l0; ty0 /= l0; tx1 /= l1; ty1 /= l1;
  const tx = tx0 + (tx1 - tx0) * f, ty = ty0 + (ty1 - ty0) * f, l = Math.hypot(tx, ty) || 1;
  out.tx = tx / l; out.ty = ty / l;
  return out;
}

// ---------- where peds can be ----------

// A random sidewalk spot, weighted by length (crosswalks excluded): { path, s, x, y, a } or null.
let cdf = null;
export function randomSidewalk(rng = Math.random) {
  const W = paths();
  if (!W.length) return null;
  if (!cdf || cdf.first !== W[0] || cdf.n !== W.length) {
    const ids = [], cum = [];
    let t = 0;
    for (const P of W) if (!P.cross && P.len > 0) { t += P.len; ids.push(P.id); cum.push(t); }
    cdf = { first: W[0], n: W.length, ids, cum: Float64Array.from(cum), total: t };
  }
  if (!cdf.ids.length) return null;
  const r = rng() * cdf.total;
  let lo = 0, hi = cdf.ids.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cdf.cum[m] < r) lo = m + 1; else hi = m; }
  const P = W[cdf.ids[lo]], s = rng() * P.len, q = poseWalk(P, s, {});
  return { path: P.id, s, x: q.x, y: q.y, a: Math.atan2(q.ty, q.tx) };
}

// Put ped p on sidewalk spot q ({ path, s }), facing whichever way along it is nearer its heading.
export function attachWalk(p, q) {
  const P = paths()[q.path];
  if (!P) return false;
  const pt = poseWalk(P, q.s, {});
  const a = Math.atan2(pt.ty, pt.tx);
  const dir = p.heading == null ? (Math.random() < 0.5 ? 1 : -1) : Math.abs(angDiff(p.heading, a)) <= Math.PI / 2 ? 1 : -1;
  p.walk = { path: q.path, s: q.s, dir, next: -1, waitT: 0 };
  p.snap = null; p.lost = false; p.resnapT = 0; p.blockT = 0;
  if (p.heading == null) p.heading = dir > 0 ? a : a + Math.PI;
  return true;
}

// Head back to the nearest sidewalk within maxD px (25 m by default). False when there is none that close.
export function snapToWalk(p, maxD = 400) {
  let q = roads.nearestWalk ? roads.nearestWalk(p.x, p.y, maxD) : null;
  if (!q) return false;
  const P = paths()[q.path];
  if (P?.cross) {
    // not onto a crosswalk, which is only stepped onto once the road is clear: to the pavement at its nearer
    // end instead
    const v = q.s < P.len / 2 ? P.a : P.b, W = paths();
    const side = roads.walks.verts[v]?.paths.find(id => !W[id].cross && W[id].len > 0);
    if (side != null) {
      const Q = W[side], s = Q.a === v ? 0 : Q.len, pt = poseWalk(Q, s, {});
      q = { path: side, s, x: pt.x, y: pt.y };
    }
  }
  p.walk = null;
  p.snap = { x: q.x, y: q.y, path: q.path, s: q.s };
  p.resnapT = 0; p.blockT = 0; p.lost = false; p.snapEta = null;
  return true;
}

// Whether ped p is anywhere a car might meet it: off the pavement, crossing, fleeing, knocked or down.
export function pedInRoadway(p) {
  if (p.state !== 'walk' || !p.walk) return true;
  return !!paths()[p.walk.path]?.cross;
}

// The soak's "standing on a road" test: a civilian that should be on the pavement but is on a ROAD tile, not
// on a crosswalk and not in its first seconds of walking back.
export function pedOnRoad(p) {
  if (p.role || p.state !== 'walk') return false;
  if (p.walk && paths()[p.walk.path]?.cross) return false;
  if (!p.walk && !p.lost && (p.resnapT || 0) < ROAD_GRACE + (p.snapEta || 0)) return false;
  return tileAtPx(p.x, p.y) === ROAD;
}

// Whether a ped may stop for a chat or a look round here: on a sidewalk, not mid-crossing, not walking back
// (anywhere, in a world without a sidewalk graph).
export const canPause = p => !paths().length || (!!p.walk && !paths()[p.walk.path]?.cross);

// ---------- moving ----------

// Move e by (dx, dy), sliding round walls: straight on, else turned 35° then 70° either way (the side that
// worked last time first). True when it moved.
export function whiskerMove(e, dx, dy, r = STEP_R) {
  if (!dx && !dy) return true;
  const side = e.whisk || 1;
  for (let i = 0; i < WHISKERS.length; i++) {
    const a = WHISKERS[i] * (i ? side : 1), c = Math.cos(a), s = Math.sin(a);
    const mx = dx * c - dy * s, my = dx * s + dy * c;
    if (!footBlocked(e.x + mx, e.y + my - 4, r)) {
      e.x += mx; e.y += my;
      if (a) e.whisk = a > 0 ? 1 : -1;
      return true;
    }
  }
  e.whisk = -side;
  return false;
}

function footBlocked(x, y, r) {
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    if (blockedFootPx(x + Math.cos(a) * r, y + Math.sin(a) * r)) return true;
  }
  return false;
}

// Is crosswalk P clear: no moving car or the player's car within 15 m of it, or within what a fast car needs
// to stop short of it? A traffic car standing still (at a red light, or waiting its turn) lets people cross
// in front of it unless it stands on the crosswalk: traffic waits for anyone crossing its path before it moves
// off.
function crossClear(P) {
  const ax = P.pts[0], ay = P.pts[1], bx = P.pts[2 * P.n - 2], by = P.pts[2 * P.n - 1];
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  for (const c of G.cars) {
    const v = Math.hypot(c.vx, c.vy), still = c !== G.player.car && v < 0.3 * M;
    if (still && !c.ai) continue;                                                   // parked
    const r = still ? STAND_CLEAR : Math.max(CROSS_CLEAR, v * v / (2 * CROSS_BRAKE) + STAND_CLEAR);
    if (Math.abs(c.x - (ax + bx) / 2) > r + Math.abs(dx) || Math.abs(c.y - (ay + by) / 2) > r + Math.abs(dy)) continue;
    const f = L2 > 1e-9 ? Math.max(0, Math.min(1, ((c.x - ax) * dx + (c.y - ay) * dy) / L2)) : 0;
    if (Math.hypot(c.x - ax - dx * f, c.y - ay - dy * f) < r) return false;
  }
  return true;
}

// The path to take on from vertex v, arriving by path `from`: another sidewalk, or now and then a crosswalk
// (whether it is clear is checked at the kerb); back the way it came only at a dead end.
function choosePath(v, from, noCross = false) {
  const W = paths(), V = roads.walks.verts[v];
  let side = 0, cross = 0;
  for (const id of V.paths) if (id !== from && W[id].len > 0) { if (W[id].cross) cross++; else side++; }
  const pickOf = (wantCross, k) => { for (const id of V.paths) if (id !== from && W[id].len > 0 && !!W[id].cross === wantCross && k-- === 0) return id; return -1; };
  if (cross && !noCross && (!side || Math.random() < CROSS_P)) return pickOf(true, Math.floor(Math.random() * cross));
  if (side) return pickOf(false, Math.floor(Math.random() * side));
  return from;
}

// One step of a walking civilian: along its sidewalk at its own pace (base x p.vk px/s), or back towards one.
// Returns false when the world has no sidewalk graph (the caller keeps the old wander).
export function walkPed(p, dt, base = 15) {
  const W = paths();
  if (!W.length) return false;
  const v = base * (p.vk || 1);
  if (!p.walk) { backToWalk(p, dt, v); return true; }
  const w = p.walk;
  let P = W[w.path];
  if (!P) { p.walk = null; return true; }
  let s = w.s + w.dir * v * dt;
  const left = w.dir > 0 ? P.len - s : s;
  const vert = w.dir > 0 ? P.b : P.a;
  if (left < PRE && w.next === -1) w.next = choosePath(vert, w.path);
  p.moving = true;
  if (left <= 0) {
    const nx = w.next < 0 ? choosePath(vert, w.path) : w.next;
    if (W[nx].cross && !crossClear(W[nx])) {
      // a car is near the crosswalk: wait at the kerb, and after a while walk on along the pavement instead
      s = w.dir > 0 ? P.len : 0;
      p.moving = false;
      w.next = nx;
      if ((w.waitT += dt) > KERB_WAIT) { w.next = choosePath(vert, w.path, true); w.waitT = 0; }
    } else {
      const Q = W[nx];
      // back along the same path (a dead end): its right-hand side is now the other side of the centre line
      if (nx === w.path) p.off = -(p.off ?? 0);
      w.path = nx; w.dir = Q.a === vert ? 1 : -1; w.next = -1; w.waitT = 0;
      s = Math.min(Q.len, -left);
      if (w.dir < 0) s = Q.len - s;
      P = Q;
    }
  }
  w.s = s;
  // keep to the right of the walking direction on pavements, to the middle on crosswalks
  const want = P.cross || (w.next >= 0 && W[w.next].cross) ? 0 : (p.off0 ?? 0.3 * M);
  const drift = p.moving ? OFF_SLOPE * v * dt : 0;
  p.off = (p.off ?? 0) + Math.max(-drift, Math.min(drift, want - (p.off ?? 0)));
  const q = poseWalk(P, s, PW);
  const tx = q.tx * w.dir, ty = q.ty * w.dir;
  const nx = q.x - ty * p.off, ny = q.y + tx * p.off;
  turnTo(p, nx - p.x, ny - p.y, Math.atan2(ty, tx), dt);
  p.x = nx; p.y = ny;
  return true;
}
const PW = { x: 0, y: 0, tx: 1, ty: 0 };

// Walking back to the sidewalk spot snapToWalk found, round any walls, running over road cells. Repeated
// blocking picks the spot again from where the ped got to; after LOST_T on top of the time the walk takes at
// its pace it gives up and is lost.
function backToWalk(p, dt, v) {
  if (!p.snap) {
    // lost peds look again once a second, not every frame
    if (p.lost && (p.retryT = (p.retryT || 0) - dt) > 0) { p.moving = false; return; }
    if (!snapToWalk(p, SNAP) && !snapToWalk(p, SNAP_FAR)) { p.lost = true; p.retryT = 1; p.moving = false; return; }
  }
  p.resnapT = (p.resnapT || 0) + dt;
  const q = p.snap, dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
  if (p.snapEta == null) p.snapEta = d / v;          // how long the walk back takes at its own pace
  const vs = tileAtPx(p.x, p.y) === ROAD ? v * HURRY : v;
  if (d <= vs * dt + 0.5) {
    p.x = q.x; p.y = q.y;
    const keep = p.resnapT;
    attachWalk(p, q);
    p.resnapT = keep;
    p.off = 0;
    return;
  }
  const ox = p.x, oy = p.y;
  const moved = whiskerMove(p, dx / d * vs * dt, dy / d * vs * dt);
  p.moving = moved;
  if (moved) { p.blockT = 0; turnTo(p, p.x - ox, p.y - oy, null, dt); }
  else if ((p.blockT = (p.blockT || 0) + dt) > 3) { const t = p.resnapT; if (!snapToWalk(p, SNAP) && !snapToWalk(p, SNAP_FAR)) p.lost = true; p.resnapT = t; }
  if (p.resnapT > LOST_T + p.snapEta) p.lost = true;
}

// Face the way the ped moves (a smooth turn), and keep the 2D sprite's left/right facing.
function turnTo(p, dx, dy, a, dt) {
  const want = a ?? Math.atan2(dy, dx);
  p.heading = p.heading == null ? want : p.heading + angDiff(p.heading, want) * Math.min(1, dt * 8);
  const cx = Math.cos(p.heading);
  if (Math.abs(cx) > 0.15) p.face = cx < 0 ? -1 : 1;
}
