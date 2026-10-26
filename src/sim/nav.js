// Navigation for the cars the game drives itself: police, the race rival and mission targets
// (docs/map-v2-spec.md §7, §9). Each car keeps one plan, c.nav: a route over the road graph (world.roads)
// that it follows by pure pursuit. The plan is an A* route by time, made again every second, when the
// target moves more than 40 m, or when the car strays out of an 18 m corridor around it. A car well off the
// network drives straight at its target when nothing is in the way. A kerb off the road graph is reached up
// its place's driveway (place.approach), and a car cut off from the road by a rail or a wall, or a target
// that is, finds its way with a short search (see "off the road, without a driveway").
// Pure functions over the world and G: no three, no DOM, runs in node. Positions are sim px.
import { G } from '../state.js';
import { roads, places, blockedCarPx, tileAtPx, surfaceAt, deliveryDoors, PX_PER_M, ROAD, DIRT } from '../world.js';

const M = PX_PER_M;              // px per metre
const REPLAN = 1;                // s: a plan is made again this often
const MOVED = 40 * M;            // a target that moves this far gets a new plan
const CORRIDOR = 18 * M;         // a car this far from its route gets a new plan
const STRAY_GAP = 0.25;          // s: but not more often than this while it stays out
const OFFNET = 25 * M;           // further than this from any lane is off the network
const DIRECT_MAX = 300 * M;      // a straight line longer than this is not worth testing
// Corner speeds: v^2 = a * R. Police brake to 1.15 sqrt(9 R) m/s (spec §9), a lateral 11.9 m/s^2.
export const COP_GRIP = 1.15 * 1.15 * 9;
const TAU = Math.PI * 2;
const wrapPI = a => a - TAU * Math.floor((a + Math.PI) / TAU);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------- pure pursuit ----------

// Forward speed in px/s.
const fwdSpeed = c => (c.vx || 0) * Math.cos(c.a) + (c.vy || 0) * Math.sin(c.a);

// How far ahead the car aims: clamp(8 + 0.6 v, 10, 40) m, with v in m/s.
export function lookAhead(c) {
  return clamp(8 + 0.6 * Math.abs(fwdSpeed(c)) / M, 10, 40) * M;
}

// The pursuit point on the car's current plan, or null when it has none.
export function pursue(c) {
  const nav = c.nav;
  if (!nav || !nav.pts) return null;
  return aimOn(nav, c.x, c.y, lookAhead(c));
}

// Pure pursuit on a plan (roads.follow, which also keeps nav.i, nav.at and nav.off), with the look shortened
// where the route bends: the aim is the furthest point within `look` whose straight line from the car's
// spot on the route stays within TOL of the route, so a car takes a street corner on its own side of the
// road instead of cutting across the sidewalk. Never shorter than LOOK_MIN.
const TOL = 1.5 * M, LOOK_MIN = 5 * M;
const A = {}, B = {};
function aimOn(nav, x, y, look) {
  const pt = roads.follow(nav, x, y, look);
  const P = nav.pts, S = nav.s, n = P.length >> 1, end = nav.at + look;
  pathPoint(nav, nav.at, A);
  let keep = end;
  for (let j = nav.i + 1; j < n && S[j] < end; j++) {
    const dx = P[2 * j] - A.x, dy = P[2 * j + 1] - A.y, L = Math.hypot(dx, dy);
    if (L < 1e-6) continue;
    let dev = 0;
    for (let k = nav.i + 1; k < j; k++) dev = Math.max(dev, Math.abs((P[2 * k] - A.x) * dy - (P[2 * k + 1] - A.y) * dx) / L);
    if (dev > TOL) { keep = S[j - 1]; break; }
  }
  keep = Math.max(keep, Math.min(end, nav.at + LOOK_MIN));
  if (keep < end - 1) { pathPoint(nav, keep, B); pt[0] = B.x; pt[1] = B.y; }
  return pt;
}

// Follow a fixed course (setRoute without a target, like a race): the pursuit point on it. A car knocked
// more than 18 m off it drives back along the roads to the course 40 m ahead of where it left it (on a
// plan of its own, c.back), then picks the course up again.
export function followCourse(c) {
  const nav = c.nav, pt = aimOn(nav, c.x, c.y, lookAhead(c));
  if (nav.off <= CORRIDOR || !roads.route) { c.back = null; return pt; }
  const q = pathPoint(nav, Math.min(nav.len, nav.at + 40 * M));
  c.nav = c.back || null;
  const w = roadWaypoint(c, q.x, q.y);
  c.back = c.nav; c.nav = nav;
  return w;
}

// The next point to drive at to reach (tx, ty) along the roads: [x, y]. Same signature as the grid-era
// roadWaypoint, so police and missions call it the same way on both maps.
export function roadWaypoint(c, tx, ty) {
  if (!roads.route) return [tx, ty];
  // well off the network (a park, a beach, a car park): straight at the target if the way is clear
  if (offNetwork(c.x, c.y) && lineDrivable(c.x, c.y, tx, ty)) return [tx, ty];
  const nav = routeTo(c, tx, ty);
  if (!nav) return [tx, ty];
  const look = lookAhead(c), pt = aimOn(nav, c.x, c.y, look);
  // the route ends at the road point nearest the target; the last stretch goes straight at it
  if (nav.len - nav.at < look && lineDrivable(c.x, c.y, tx, ty)) return [tx, ty];
  return [pt[0], pt[1]];
}

// The car's plan to (tx, ty), made again when it is due (see the top of the file): the nav object, or null
// when no route exists. A fixed route (a race) is left alone only while nobody asks for another target.
export function routeTo(c, tx, ty) {
  const nav = c.nav, now = G.t;
  const due = !nav || nav.tx == null || now < nav.t || now - nav.t >= REPLAN ||
    Math.hypot(tx - nav.tx, ty - nav.ty) > MOVED || (nav.off > CORRIDOR && now - nav.t >= STRAY_GAP);
  if (due) plan(c, tx, ty);
  return c.nav.pts ? c.nav : null;
}

// A new plan by time (len / speed, plus 4 s per signal), by way of driveways at either end, or of a way back
// onto the road for a car knocked off it (see below).
function plan(c, tx, ty) {
  const dest = wayTo(tx, ty) || wayIn(tx, ty), from = (dest && onWay(dest.way, c.x, c.y)) || wayFrom(c.x, c.y) || backTo(c);
  let r;
  if (dest && from && dest.way === from.way) r = wayPart(from.way, from.s, dest.s);     // along the one driveway
  else {
    const x1 = dest ? dest.way.pts[0] : tx, y1 = dest ? dest.way.pts[1] : ty;
    r = from ? roads.route(from.way.pts[0], from.way.pts[1], x1, y1, { time: true }) : routeFrom(c, x1, y1);
    if (r && from) r = joinPaths(wayPart(from.way, from.s, 0), r);
    if (r && dest) r = joinPaths(r, wayPart(dest.way, 0, dest.s));
  }
  setRoute(c, r, tx, ty);
}

// The road route from the car. A moving car keeps going the way it faces unless turning round is clearly
// quicker: when the best route starts back the way it came, the route from a little ahead of it is taken
// instead if it costs no more than 3 s extra.
function routeFrom(c, tx, ty) {
  const r = roads.route(c.x, c.y, tx, ty, { time: true });
  const v = fwdSpeed(c);
  if (r && v > 5 * M && startsBack(r, c)) {
    const ahead = Math.min(15 * M, v * 0.6);
    const f = roads.route(c.x + Math.cos(c.a) * ahead, c.y + Math.sin(c.a) * ahead, tx, ty, { time: true });
    if (f && !startsBack(f, c) && f.cost + ahead / v <= r.cost + 3) return fromCar(f, c);
  }
  return r;
}

// Does a route set off against the car's heading (judged 5 m along it)?
function startsBack(r, c) {
  const q = pathPoint(r, Math.min(r.len, 5 * M), {});
  return (q.x - r.pts[0]) * Math.cos(c.a) + (q.y - r.pts[1]) * Math.sin(c.a) < 0;
}

// A route that starts ahead of the car, with the car's own spot put in front of it.
function fromCar(r, c) {
  const n = r.pts.length >> 1, pts = new Float32Array(n * 2 + 2), s = new Float32Array(n + 1);
  pts[0] = c.x; pts[1] = c.y; pts.set(r.pts, 2);
  const hop = Math.hypot(r.pts[0] - c.x, r.pts[1] - c.y);
  for (let i = 0; i < n; i++) s[i + 1] = r.s[i] + hop;
  return { pts, s, len: r.len + hop, steps: r.steps, cost: r.cost };
}

// Give a car a route to follow: one from roads.route (or a world route {pts, s, len}). With a target it is a
// plan routeTo may replace; without one it is fixed (a race course). The route's own arrays are shared,
// never written.
export function setRoute(c, r, tx = null, ty = null) {
  c.nav = { pts: r ? r.pts : null, s: r ? r.s : null, len: r ? r.len : 0, th: null, i: 0, at: 0, off: 0, pt: null,
    tx, ty, t: G.t, fixed: tx == null };
  return c.nav;
}

// ---------- driveways ----------

// Some kerbs lie off the road graph, up a drive no lane reaches (on v2 the marina's is 40 m from South
// Pointe Drive, the jet's 35 m from Airport Road and the villa's 19 m from Villa Drive, round corners). Such a
// place has an approach (world-v2 builds it): a polyline in px from the lane point nearest it to its curb. A
// plan to a spot on a driveway is the road route to the driveway's first point and then up the driveway; a
// car on a driveway leaving for somewhere else first drives back down it to the road; one going up or down
// the same driveway just follows it.
const ON_WAY = 9 * M;      // a car this close to a driveway's line is on it ...
const WAY_AT = 4 * M;      // ... a target this close is at a spot on it ...
const WAY_IN = 2 * M;      // ... once more than this up it (nearer the road it is just a spot by the road)
const packed = new WeakMap();

// Each place's driveway as a path { pts, s, len }, packed once.
function driveways() {
  const out = [];
  for (const k in places) {
    const a = places[k]?.approach;
    if (!a || typeof a !== 'object') continue;
    if (!packed.has(a)) packed.set(a, packWay(a));
    const w = packed.get(a);
    if (w) out.push(w);
  }
  return out;
}

// An approach as world-v2 gives it, { pts: Float32Array [x0, y0, x1, y1, ...], n, ... }, or as a list of
// points [{x, y}, ...]: a path, or null when it has fewer than two points.
function packWay(a) {
  const xs = [], ys = [];
  if (a.pts) for (let i = 0, n = a.n ?? a.pts.length >> 1; i < n; i++) { xs.push(a.pts[2 * i]); ys.push(a.pts[2 * i + 1]); }
  else if (Array.isArray(a)) for (const p of a) { xs.push(p.x ?? p[0]); ys.push(p.y ?? p[1]); }
  return xs.length >= 2 ? packPath(xs, ys) : null;
}

// The driveway a point lies on, within `near` of its line and more than WAY_IN up it: { way, s } (s its
// station from the road end), or null. A point on the carriageway is on the road, whatever driveway starts
// beside it.
function wayNear(x, y, near) {
  let best = null;
  for (const way of driveways()) {
    const p = project(way, x, y);
    if (p.d <= near && p.s > WAY_IN && (!best || p.d < best.d)) best = { way, s: p.s, d: p.d };
  }
  return best && !onCarriageway(x, y) ? best : null;
}
const wayTo = (x, y) => wayNear(x, y, WAY_AT);
const wayFrom = (x, y) => wayNear(x, y, ON_WAY);

// Is (x, y) on this way, up from its road end: { way, s }, or null.
function onWay(way, x, y) {
  const p = project(way, x, y);
  return p.d <= ON_WAY && p.s > WAY_IN ? { way, s: p.s } : null;
}

// The part of a driveway from station s0 to s1 (back down it toward the road when s1 < s0). Always at
// least two points.
function wayPart(way, s0, s1) {
  const P = way.pts, S = way.s, n = P.length >> 1, xs = [], ys = [], q = {};
  const lo = Math.min(s0, s1), hi = Math.max(s0, s1);
  pathPoint(way, lo, q); xs.push(q.x); ys.push(q.y);
  for (let i = 0; i < n; i++) if (S[i] > lo + 1e-3 && S[i] < hi - 1e-3) { xs.push(P[2 * i]); ys.push(P[2 * i + 1]); }
  pathPoint(way, hi, q); xs.push(q.x); ys.push(q.y);
  if (s1 < s0) { xs.reverse(); ys.reverse(); }
  return packPath(xs, ys);
}

// ---------- off the road, without a driveway ----------

// A car knocked off the road behind a rail, a wall or a building cannot drive straight back to it, and a
// plan that starts at the nearest lane point sends it into the obstacle again and again. Then it finds a
// way out: a search over 2 m cells a car fits in, out to 40 m, for the nearest carriageway cell. The way is
// kept as a driveway of the car's own (c.lead, road end first) while the car follows it; a car for which no
// way was found tries again after 3 s.
const LEAD_R = 40 * M, LEAD_CELL = 2 * M, LEAD_ROOM = 1.2 * M, LEAD_RETRY = 3;
function backTo(c) {
  if (onCarriageway(c.x, c.y)) { c.lead = null; return null; }
  const on = c.lead && onWay(c.lead, c.x, c.y);
  if (on) return on;
  c.lead = null;
  if (!walledOff(c.x, c.y)) return null;
  if (G.t - (c.leadT ?? -Infinity) < LEAD_RETRY && G.t >= c.leadT) return null;
  if (!mayRun()) return null;
  c.leadT = G.t;
  c.lead = searchRoad(c.x, c.y);
  return c.lead && { way: c.lead, s: c.lead.len };
}

// The same search from a target off the road that no driveway serves (a kerb whose place has no approach
// yet, Kimchi on foot behind a wall) finds the way in. Kept per 4 m spot, for the last 32 spots.
const SPOT = 4 * M, ways = new Map();
function wayIn(tx, ty) {
  const key = Math.round(tx / SPOT) + ',' + Math.round(ty / SPOT);
  let w = ways.get(key);
  if (w === undefined) {
    const cut = !onCarriageway(tx, ty) && walledOff(tx, ty);
    if (cut && !mayRun()) return null;
    w = cut ? searchRoad(tx, ty) : null;
    if (ways.size >= 32) ways.delete(ways.keys().next().value);
    ways.set(key, w);
  }
  return w && { way: w, s: w.len };
}

// Searches are rationed to SEARCHES a frame (one G.t), so a dozen cars knocked off together spread the cost
// over a few frames; a car that misses out searches at its next plan.
const SEARCHES = 2;
let searchT = null, searched = 0;
function mayRun() {
  if (G.t !== searchT) { searchT = G.t; searched = 0; }
  return searched++ < SEARCHES;
}

// Is (x, y) within the search's reach of the road but cut off from the nearest road point by something a
// car cannot drive through?
function walledOff(x, y) {
  const near = roads.nearest ? roads.nearest(x, y, { maxD: LEAD_R }) : null;
  return !!near && !lineDrivable(x, y, near.x, near.y);
}

// Breadth-first over 2 m cells (8 neighbours) from (x0, y0) to the nearest carriageway cell where a car
// fits (LEAD_ROOM clear of anything car-blocked each way), within LEAD_R. The way as a path from that cell
// to (x0, y0), its corners pulled tight where a car can drive straight, or null.
const STEP8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const roomy = (x, y) => !blockedCarPx(x, y) && !blockedCarPx(x + LEAD_ROOM, y) && !blockedCarPx(x - LEAD_ROOM, y) &&
  !blockedCarPx(x, y + LEAD_ROOM) && !blockedCarPx(x, y - LEAD_ROOM);
function searchRoad(x0, y0) {
  const h = Math.round(LEAD_R / LEAD_CELL), n = 2 * h + 1, from = new Int32Array(n * n).fill(-2);   // -2 unseen
  const cx = k => x0 + ((k % n) - h) * LEAD_CELL, cy = k => y0 + (((k / n) | 0) - h) * LEAD_CELL;
  const queue = [h * n + h];
  from[queue[0]] = -1;
  for (let q = 0; q < queue.length; q++) {
    const k = queue[q];
    if (q && onCarriageway(cx(k), cy(k))) return pullTight(from, k, cx, cy, x0, y0);
    const i = k % n, j = (k / n) | 0;
    for (const [di, dj] of STEP8) {
      const ni = i + di, nj = j + dj, k2 = nj * n + ni;
      if (ni < 0 || nj < 0 || ni >= n || nj >= n || from[k2] !== -2) continue;
      if (!roomy(cx(k2), cy(k2))) { from[k2] = -3; continue; }
      from[k2] = k;
      queue.push(k2);
    }
  }
  return null;
}

// The cells from the found one back to the start, as a path from the road to (x0, y0), keeping only the
// corners a car cannot drive straight past.
function pullTight(from, k, cx, cy, x0, y0) {
  const xs = [], ys = [];
  for (; k >= 0; k = from[k]) { xs.push(cx(k)); ys.push(cy(k)); }
  xs[xs.length - 1] = x0; ys[ys.length - 1] = y0;
  const px = [xs[0]], py = [ys[0]];
  for (let a = 0; a < xs.length - 1;) {
    let b = a + 1;
    while (b + 1 < xs.length && lineDrivable(xs[a], ys[a], xs[b + 1], ys[b + 1])) b++;
    px.push(xs[b]); py.push(ys[b]);
    a = b;
  }
  return packPath(px, py);
}

// One path made of two, end to start (a hop between them is driven straight).
function joinPaths(a, b) {
  const na = a.pts.length >> 1, nb = b.pts.length >> 1, xs = [], ys = [];
  for (let i = 0; i < na; i++) { xs.push(a.pts[2 * i]); ys.push(a.pts[2 * i + 1]); }
  for (let i = 0; i < nb; i++) {
    const x = b.pts[2 * i], y = b.pts[2 * i + 1];
    if (Math.hypot(x - xs[xs.length - 1], y - ys[ys.length - 1]) > 1e-3) { xs.push(x); ys.push(y); }
  }
  if (xs.length < 2) { xs.push(xs[0]); ys.push(ys[0]); }
  return Object.assign(packPath(xs, ys), { cost: (a.cost || 0) + (b.cost || 0) });
}

// ---------- what lies ahead ----------

// Unwrapped heading of each route segment (built once per plan); a zero-length segment keeps the last one.
function headings(nav) {
  if (nav.th) return nav.th;
  const P = nav.pts, n = P.length >> 1, th = nav.th = new Float32Array(Math.max(1, n - 1));
  let last = null;
  for (let i = 0; i < n - 1; i++) {
    const dx = P[2 * i + 2] - P[2 * i], dy = P[2 * i + 3] - P[2 * i + 1];
    if (dx * dx + dy * dy < 1e-6) { th[i] = last ?? 0; continue; }
    const a = Math.atan2(dy, dx);
    th[i] = last == null ? a : last + wrapPI(a - last);
    last = th[i];
  }
  return th;
}

// The tightest bend the car must be ready for now, as a curvature (1/px), looking distPx along its plan
// (by default far enough to brake for anything beyond). A bend is measured over the pursuit window (the
// car cuts it by about that much), and one further ahead counts for less: radius R at distance d counts
// as R + 2d, which is the room to brake to its speed at the same deceleration as the cornering grip. The
// turn from the car's own heading onto the route counts too, so a car finishes a corner before it speeds
// up. 0 when the car has no plan. `nav` reads another plan than c.nav (a car finding its way back to a
// course follows c.back).
export function curvatureAhead(c, distPx, nav = c.nav) {
  if (!nav || !nav.pts || nav.at == null) return 0;
  const P = nav.pts, S = nav.s, n = P.length >> 1, th = headings(nav);
  if (n < 3) return 0;
  const w = Math.max(12 * M, lookAhead(c));
  const reach = nav.at + (distPx ?? brakeWindow(c));
  // the turn still to make from the car's own heading onto the route a window ahead (coming out of a bend,
  // or a car that faces the wrong way)
  let j = nav.i | 0;
  while (j < n - 2 && S[j + 1] <= nav.at + w) j++;
  let best = Math.abs(wrapPI(th[j] - c.a)) / w;
  j = nav.i | 0;
  for (let i = nav.i | 0; i < n - 1 && S[i] < reach; i++) {
    const s0 = Math.max(S[i], nav.at);
    if (S[n - 1] - s0 < 1) break;
    if (j < i) j = i;
    while (j < n - 2 && S[j + 1] <= s0 + w) j++;
    const span = Math.min(w, S[n - 1] - s0);
    const k = Math.abs(th[j] - th[i]) / Math.max(span, M);
    if (k > 1e-9) best = Math.max(best, 1 / (1 / k + 2 * (s0 - nav.at)));
  }
  return best;
}

// How far ahead a car at its speed must look for bends: its pursuit distance plus the room to brake
// from its speed at cornering grip.
function brakeWindow(c) {
  const v = Math.abs(fwdSpeed(c));
  return lookAhead(c) + v * v / (2 * COP_GRIP * M);
}

// The speed (px/s) for a curvature k (1/px) at a lateral grip (m/s^2): v^2 = grip * R.
export function cornerSpeed(k, grip = COP_GRIP) {
  return k > 1e-9 ? Math.sqrt(grip * M / k) : Infinity;
}

// Where a car will probably be over the next distPx: its plan when it is an AI car with a fresh one, else
// its lane followed through every junction the straightest way (Kimchi's car, even one an AI drove before
// he took it). { pts: Float32Array [x0,y0,...], s, len } or null.
export function predictPath(car, distPx) {
  const nav = car.nav;
  if (nav && nav.pts && car !== G.player.car && nav.off < CORRIDOR && (nav.fixed || G.t - nav.t < REPLAN * 2)) return slice(nav, nav.at, distPx);
  if (!roads.nearestLane) return null;
  const v = Math.hypot(car.vx || 0, car.vy || 0), a = v > 2 * M ? Math.atan2(car.vy, car.vx) : car.a;
  const start = roads.nearestLane(car.x, car.y, a);
  if (!start) return null;
  const xs = [], ys = [];
  let len = 0, lane = roads.lanes[start.lane], s0 = start.s, guard = 0;
  const add = (x, y) => {
    if (xs.length) len += Math.hypot(x - xs[xs.length - 1], y - ys[ys.length - 1]);
    xs.push(x); ys.push(y);
  };
  while (lane && len < distPx && guard++ < 200) {
    const p = roads.lanePoint(lane.id, s0);
    add(p.x, p.y);
    for (let i = 0; i < lane.n && len < distPx; i++) if (lane.s[i] > s0) add(lane.x[i], lane.y[i]);
    if (len >= distPx || !lane.next.length) break;
    const cn = straightest(lane);
    for (let i = 1; i < cn.n; i++) add(cn.x[i], cn.y[i]);
    lane = roads.lanes[cn.to]; s0 = 0;
  }
  return xs.length > 1 ? packPath(xs, ys) : null;
}

// The connector out of a lane that turns least (straight on, else right, else left, else a U-turn).
const TURN_RANK = { s: 0, r: 1, l: 2, u: 3 };
function straightest(lane) {
  let best = null;
  for (const id of lane.next) { const c = roads.conns[id]; if (!best || TURN_RANK[c.turn] < TURN_RANK[best.turn]) best = c; }
  return best;
}

// The part of a nav route from station s0, distPx long.
function slice(nav, s0, distPx) {
  const P = nav.pts, S = nav.s, n = P.length >> 1, xs = [], ys = [];
  const p0 = pathPoint(nav, s0, {});
  xs.push(p0.x); ys.push(p0.y);
  for (let i = 0; i < n && S[i] < s0 + distPx; i++) if (S[i] > s0) { xs.push(P[2 * i]); ys.push(P[2 * i + 1]); }
  const p1 = pathPoint(nav, Math.min(S[n - 1], s0 + distPx), {});
  xs.push(p1.x); ys.push(p1.y);
  return packPath(xs, ys);
}

function packPath(xs, ys) {
  const n = xs.length, pts = new Float32Array(n * 2), s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pts[2 * i] = xs[i]; pts[2 * i + 1] = ys[i];
    if (i) s[i] = s[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  }
  return { pts, s, len: s[n - 1] };
}

// The point and heading at station s of a path {pts, s}: out.x, out.y, out.a.
export function pathPoint(path, s, out = {}) {
  const P = path.pts, S = path.s, n = P.length >> 1;
  s = clamp(s, 0, S[n - 1]);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
  const ds = S[hi] - S[lo], f = ds > 1e-9 ? (s - S[lo]) / ds : 0;
  const dx = P[2 * hi] - P[2 * lo], dy = P[2 * hi + 1] - P[2 * lo + 1];
  out.x = P[2 * lo] + dx * f; out.y = P[2 * lo + 1] + dy * f; out.a = Math.atan2(dy, dx); out.s = s;
  return out;
}

// Station of the point of a path closest to (x, y), searching forward from station `from` (so a course
// that passes the same place twice resolves in order).
export function stationOf(path, x, y, from = 0) {
  return project(path, x, y, from).s;
}

// The point of a path closest to (x, y), from station `from` on: { s, d } (its station and distance).
function project(path, x, y, from = 0) {
  const P = path.pts, S = path.s, n = P.length >> 1;
  let best = Infinity, at = from;
  if (n === 1) return { s: 0, d: Math.hypot(x - P[0], y - P[1]) };
  for (let i = 0; i < n - 1; i++) {
    if (S[i + 1] < from) continue;
    const ax = P[2 * i], ay = P[2 * i + 1], dx = P[2 * i + 2] - ax, dy = P[2 * i + 3] - ay, L2 = dx * dx + dy * dy;
    const f = L2 > 1e-9 ? clamp(((x - ax) * dx + (y - ay) * dy) / L2, 0, 1) : 0;
    const d = Math.hypot(x - ax - dx * f, y - ay - dy * f), s = S[i] + (S[i + 1] - S[i]) * f;
    if (d < best - 1e-6 && s >= from) { best = d; at = s; }
  }
  return { s: at, d: best };
}

// ---------- other cars ----------

// Steer round the car in the way. The threat is the nearest car ahead that this one is closing on, within
// 6 m plus 1.6 s of closing speed and PASS either side of its heading. The aim moves sideways to pass it on
// the left (right-hand traffic overtakes there), or on the right when it sits left of the heading, if that
// line is drivable and no other car will be in it by the time this one is past (an oncoming car sweeps
// toward it at the closing speed); else on the other side. When no pass is clear, the aim stays and the
// speed cap is the threat's speed, so the car follows it. Writes the aim to out ([x, y]) and returns the cap
// (px/s, Infinity when nothing is in the way). `ignore` is a car to leave out (the one a cop means to ram).
// A car keeping to the roads (on the carriageway itself, and aiming at it) passes only over the carriageway:
// it never swerves into a car park or over a sidewalk, and a car parked off the carriageway is no threat to
// it (it still fills its side, so no pass goes through it). Without that, a car turning round beside a car
// park took the cars in it for cars ahead and swerved in among them. A car off the carriageway (in a car
// park, on a driveway, knocked off the road), or one heading off it on purpose (down a driveway to a kerb),
// sees every car and may pass over any drivable ground: one driving out of a car park has to steer round
// the cars parked in it, not straight through them.
const nearby = [];
const PASS = 3.5 * M;     // centre to centre, side by side: clear of carCollisions' circles (about 26 px each)
export function dodge(c, ax, ay, out, ignore = null) {
  out[0] = ax; out[1] = ay;
  const v = fwdSpeed(c);
  if (v < 2 * M) return Infinity;
  const fx = Math.cos(c.a), fy = Math.sin(c.a);
  let threat = null, roadOnly = null;
  nearby.length = 0;
  for (const o of G.cars) {
    if (o === c || o === ignore) continue;
    const dx = o.x - c.x, dy = o.y - c.y, ahead = dx * fx + dy * fy;
    if (ahead < -3 * M || ahead > 90 * M) continue;
    const lat = -dx * fy + dy * fx;
    if (Math.abs(lat) > 8 * M) continue;
    const ov = (o.vx || 0) * fx + (o.vy || 0) * fy, q = { ahead, lat, ov, closing: v - ov };
    nearby.push(q);
    if (!(ahead > 0 && q.closing > M && ahead <= 6 * M + q.closing * 1.6 && Math.abs(lat) < PASS && (!threat || ahead < threat.ahead))) continue;
    roadOnly ??= !!roads.nearest && carOnCarriageway(c) && onCarriageway(ax, ay);
    if (roadOnly && !carOnCarriageway(o)) continue;
    threat = q;
  }
  if (!threat) return Infinity;
  const tPass = threat.ahead / threat.closing + 0.5;
  const first = threat.lat < -0.3 * M ? 1 : -1;
  for (const onRoad of roadOnly ? [true] : [true, false]) {
    for (const side of [first, -first]) {
      const off = threat.lat + side * PASS, d = threat.ahead + 4 * M;
      const busy = nearby.some(q => q !== threat && Math.abs(q.lat - off) < PASS && q.ahead - Math.max(0, q.closing) * tPass < d);
      if (busy) continue;
      const x = c.x + fx * d - fy * off, y = c.y + fy * d + fx * off;
      if (onRoad && !passOnCarriageway(c.x, c.y, x, y)) continue;
      if (lineDrivable(c.x, c.y, x, y, BODY_SIDE)) { out[0] = x; out[1] = y; return Infinity; }
    }
  }
  return Math.max(0, threat.ov);
}

// Is (x, y) on the carriageway: a road cell (ROAD or DECK, which tileAtPx reads as road, or the DIRT of a
// dirt track) within its edge's half width (plus 1 m) of the road network's centre line? The runway, car
// parks, sidewalks and the people-only decks (piers, the Riverwalk) are not. The cell test is cheap and comes
// first; the network only for road cells.
const CW_SLACK = 1 * M;
const roadCell = (x, y) => tileAtPx(x, y) === ROAD || surfaceAt(x, y) === DIRT;
export function onCarriageway(x, y) {
  return roadCell(x, y) && cwMargin(x, y) >= 0;
}

// How far (x, y) is inside the carriageway (negative outside it; Infinity with no network to measure by):
// the half width plus CW_SLACK of the edge whose centre line is nearest, less the distance to it. What
// roads.nearest finds, by a tight loop over the network's segment hash (roads.hash) in the cells within the
// widest half width of the point (a nearer edge further off than that leaves the point outside anyway):
// roads.nearest builds an object per segment and searches rings of cells out to its maxD, and dodge's
// lookups through it came to half the police time of a soak.
let cwNet = null, cwR = 0;
function cwMargin(x, y) {
  const H = roads.hash;
  if (!H) {
    const near = roads.nearest ? roads.nearest(x, y, { maxD: 24 * M }) : null;
    return !roads.nearest ? Infinity : near ? roads.edges[near.edge].halfW + CW_SLACK - near.d : -Infinity;
  }
  const E = roads.edges;
  if (cwNet !== E) { cwNet = E; cwR = 0; for (const e of E) cwR = Math.max(cwR, e.halfW + CW_SLACK); }
  const cell = H.cell, i0 = Math.floor((x - cwR) / cell), i1 = Math.floor((x + cwR) / cell);
  const j0 = Math.floor((y - cwR) / cell), j1 = Math.floor((y + cwR) / cell);
  let best = Infinity, w = 0;
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const a = H.at(i, j);
    if (a) for (let q = 0; q < a.length; q += 2) {
      const e = E[a[q]], k = a[q + 1];
      const ax = e.x[k], ay = e.y[k], dx = e.x[k + 1] - ax, dy = e.y[k + 1] - ay, L2 = dx * dx + dy * dy;
      const f = L2 > 1e-9 ? clamp(((x - ax) * dx + (y - ay) * dy) / L2, 0, 1) : 0;
      const d = Math.hypot(x - ax - dx * f, y - ay - dy * f);
      if (d < best) { best = d; w = e.halfW; }
    }
  }
  return best <= cwR ? w + CW_SLACK - best : -Infinity;
}

// Is a car on the carriageway? Kept with the spot it was worked out for, so a parked car is looked up once
// and a moving one once a frame, however many drivers ask about it (dodge asks about every car ahead).
const carCw = new WeakMap();
function carOnCarriageway(o) {
  let k = carCw.get(o);
  if (!k) carCw.set(o, k = { x: NaN, y: NaN, net: null, on: false });
  if (k.x !== o.x || k.y !== o.y || k.net !== roads.edges) {
    k.x = o.x; k.y = o.y; k.net = roads.edges; k.on = onCarriageway(o.x, o.y);
  }
  return k.on;
}

// A pass from the car to (x1, y1) stays on the carriageway: road cells every 2 m along its line, and the
// whole car (its centre and both sides) on the network where it ends, so it never squeezes between a car
// and the kerb or a wall. BODY_SIDE is half the widest car (2.2 m) and a little. The cell tests come first;
// then one network lookup, as the sides are on the carriageway too when the centre is BODY_SIDE inside it
// (they are within BODY_SIDE of it), and the sides' own lookups only when it is closer to the edge.
const BODY_SIDE = 1.2 * M;
function passOnCarriageway(x0, y0, x1, y1) {
  const L = Math.hypot(x1 - x0, y1 - y0) || 1, sx = -(y1 - y0) / L * BODY_SIDE, sy = (x1 - x0) / L * BODY_SIDE;
  const n = Math.ceil(L / (2 * M));
  for (let i = 1; i < n; i++) if (!roadCell(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n)) return false;
  if (!roadCell(x1, y1) || !roadCell(x1 + sx, y1 + sy) || !roadCell(x1 - sx, y1 - sy)) return false;
  const m = cwMargin(x1, y1);
  if (m < 0) return false;
  return m >= BODY_SIDE || (cwMargin(x1 + sx, y1 + sy) >= 0 && cwMargin(x1 - sx, y1 - sy) >= 0);
}

// ---------- the network around a car ----------

// Is (x, y) more than 25 m from every lane? (Measured from an edge's centre line less its half width.)
export function offNetwork(x, y) {
  const near = roads.nearest ? roads.nearest(x, y, { maxD: OFFNET + 12 * M }) : null;
  return !near || near.d - roads.edges[near.edge].halfW > OFFNET;
}

// Can a car drive straight from one point to the other? Its centre line and both sides (`side` out from
// it), every metre.
export function lineDrivable(x0, y0, x1, y1, side = 0.8 * M) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  if (d > DIRECT_MAX) return false;
  const n = Math.ceil(d / M), ux = (x1 - x0) / (d || 1), uy = (y1 - y0) / (d || 1);
  for (let i = 1; i <= n; i++) {
    const x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * i / n;
    if (blockedCarPx(x, y) || blockedCarPx(x - uy * side, y + ux * side) || blockedCarPx(x + uy * side, y - ux * side)) return false;
  }
  return true;
}

// The junction a car is driving toward: the end of its nearest edge it faces. A node object or null.
export function nodeAhead(c) {
  const near = roads.nearest ? roads.nearest(c.x, c.y) : null;
  if (!near) return null;
  const e = roads.edges[near.edge], i = Math.min(near.i, e.n - 1);
  const v = Math.hypot(c.vx || 0, c.vy || 0), a = v > 2 * M ? Math.atan2(c.vy, c.vx) : c.a;
  return roads.nodes[Math.cos(a) * e.tx[i] + Math.sin(a) * e.ty[i] >= 0 ? e.b : e.a];
}

// The junctions one edge away from a node (each once; a road that loops back to the node is skipped).
export function nodeNeighbours(id) {
  const out = [];
  for (const ei of roads.nodes[id].edges) {
    const e = roads.edges[ei], o = e.a === id ? e.b : e.a;
    if (o !== id && !out.includes(roads.nodes[o])) out.push(roads.nodes[o]);
  }
  return out;
}

// ---------- deliveries ----------

// A delivery door whose drive from (x, y) is between min and max px: { door, curb, len } (door is the
// deliveryDoors entry, curb where to stop, len the drive in px), or the closest miss when none fits.
export function deliveryRoute(x, y, { min, max, tries = 30, rng = Math.random } = {}) {
  const cands = deliveryDoors.filter(d => {
    const s = Math.hypot(d.curb.x - x, d.curb.y - y);
    return s <= max && s >= min * 0.35;
  });
  const pool = cands.length ? cands : deliveryDoors.slice();
  let miss = null;
  for (let t = 0; t < tries && pool.length; t++) {
    const k = Math.floor(rng() * pool.length), d = pool[k];
    pool[k] = pool[pool.length - 1]; pool.pop();
    const len = roads.routeLength ? roads.routeLength(x, y, d.curb.x, d.curb.y) : Math.hypot(d.curb.x - x, d.curb.y - y);
    if (len >= min && len <= max) return { door: d, curb: d.curb, len };
    const off = len < min ? min - len : len - max;
    if (isFinite(len) && (!miss || off < miss.off)) miss = { door: d, curb: d.curb, len, off };
  }
  return miss && { door: miss.door, curb: miss.curb, len: miss.len };
}
