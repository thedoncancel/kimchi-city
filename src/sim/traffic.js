// Lane traffic (docs/map-v2-spec.md §9). Every AI car drives one lane of the road graph (src/map/roadnet.js)
// and crosses junctions on the graph's curved connectors. It looks along its own path (the rest of its lane,
// the connector it has picked and the lane after it), so it slows for curves, keeps a time gap behind the car
// ahead (IDM-lite), stops for people and parked cars in its way, and waits at the stop line until the junction
// is reserved for it. Its position always comes from the lane polyline, and its velocity is speed x tangent, so
// a car keeps its momentum the moment the player takes it or its driver is shot.
//
// c.ai = { lane, conn, s, speed, max, f, next, next2, rsv, hold, stuck, ghost, wait, still, ... }
//   lane   the lane the car is on (or has just left, while it crosses a junction on connector `conn`)
//   s      its station on that lane or connector, px
//   speed  px/s. It is authoritative: whatever else writes it (a bump sets 0, a gunshot halves it) is where
//          the car carries on from.
//   max    a px/s cap (Infinity for ordinary traffic); f is the driver's factor on the road's speed (0.85-1.1)
//   next, next2  the connectors picked at the end of the lane ahead and of the one after it (-1 = not yet)
//   rsv    the connector reserved at the junction ahead; hold the one being cleared
//   still  s stood still; stillX the same leaving out time held by a red light (red), for the stats
//   through, throughConn  after ghosting: the thing (car, ped) or the connector the car keeps passing through
// Pure sim: no three, no DOM, runs in node.
import { G } from '../state.js';
import { roads, PX_PER_M } from '../world.js';
import { CAR_TYPES } from '../data.js';
import { pick } from '../util.js';
import { pedOnRoad, pedInRoadway } from './peds.js';

const M = PX_PER_M;                       // px per metre
const ACC = 2.5 * M, BRAKE = 7 * M;       // px/s²: the most a car speeds up or brakes in one second
const LAT = 3.2 * M;                      // px/s²: the sideways acceleration a car takes a curve at
const PLAN_B = 3.5 * M;                   // px/s²: how hard a car plans to slow for curves, slower roads and stop lines
const FOLLOW_B = 6 * M;                   // px/s²: the braking it may count on when closing on a car ahead
const GAP0 = 7 * M, HEADWAY = 1.2;        // IDM-lite: centre-to-centre gap at a standstill, and the time gap
const NOM = 4.6 * M;                      // the car length the 7 m gap is set for; longer cars keep the same bumper gap
const PATH_W = 2.2 * M;                   // something closer than this to a car's path is in its way
const LOOK_MIN = 30 * M;                  // the look-ahead never stops short of this, so connectors are picked 30 m out
const LINE = 0.5 * M;                     // the front bumper stops this far before a stop line
const FREE = 12 * M;                      // a junction is entered only with this much room on the lane beyond it
const ETA = 4.5;                          // s: a yielding car waits for a priority car closer than this
const STOP_V = 0.5 * M;                   // below this a car counts as stopped
const STUCK = 4, GHOST = 1.5;             // s: stuck this long, a car ghosts through what holds it for this long
const WAIT_STUCK = 8;                     // s: waiting this long at a stop line counts as stuck
const THROUGH_MAX = 12;                   // s: the longest a ghosting car keeps passing through what held it
const RSV_MAX = 8;                        // s: a reservation not used in this time is given up
const LC_LEAD = 0.7, LC_GAP = 25 * M, LC_T = 2, LC_COOL = 5;   // lane changes: a slow leader, a free gap, a 2 s blend
const LC_AHEAD = 15 * M;                  // ... started while the slow leader is still this far ahead
const LC_REACH = 25 * M;                  // ... and cars still coming into the new lane are looked for this far past LC_GAP
const LC_YAW = 0.3;                       // rad: the most a car's nose turns into a lane change
const WEIGHT = { s: 0.5, r: 0.3, l: 0.2, u: 0.02 };            // which way a car turns at a junction
const THROUGH = { s: 0.75, r: 0.15, l: 0.1, u: 0.02 };         // the same on the Loop (highway), mostly straight on

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPI = a => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
const halfLen = c => (CAR_TYPES[c.type]?.len ?? 66) / 2;
const halfWid = c => (CAR_TYPES[c.type]?.wid ?? 31) / 2;

// ---------- per-network state ----------
// The road graph is filled in place by the world's generate(), so it is bound on first use: the per-connector
// reservation counts and car lists, and the curve speed at every lane and connector point.
let lanes = [], conns = [], nodes = [], edges = [];
let held = new Uint16Array(0);            // per connector: cars holding it (reserved, on it, or clearing it)
let onConn = [];                          // per connector: the cars on it, by station
let waitAt = [];                          // per node: the cars waiting at its stop lines this frame
let vcLane = [], vcConn = [];             // curve speed (px/s) at each point of each lane and connector
let tnLane = [], tnConn = [];             // unit tangent [tx, ty, ...] at each point of each lane and connector
let conflict = [];                        // per connector: the connectors that may not be driven at the same time
let back = new Float32Array(0);           // per lane: how much further back than LINE its cars stop (lineSetbacks)
let vEnter = new Float32Array(0);         // per connector: the fastest a car can enter it and still slow for its bend
let bound = null, boundN = -1;
const touched = { lanes: [], conns: [], nodes: [] };

function bindNet() {
  if (bound === roads.conns[0] && boundN === roads.conns.length) return roads.lanes.length > 0;
  ({ lanes, conns, nodes, edges } = roads);
  bound = conns[0]; boundN = conns.length;
  held = new Uint16Array(conns.length);
  onConn = conns.map(() => []);
  waitAt = nodes.map(() => []);
  vcLane = lanes.map(curveSpeeds);
  vcConn = conns.map(curveSpeeds);
  tnLane = lanes.map(tangents);
  tnConn = conns.map(tangents);
  joinTangents();
  conflict = conflictTable();
  back = lineSetbacks();
  vEnter = Float32Array.from(conns, C => {
    let v = edges[lanes[C.to].edge].speed;
    for (let j = 0; j < C.n; j++) v = Math.min(v, reach(vcConn[C.id][j], C.s[j]));
    return v;
  });
  touched.lanes.length = touched.conns.length = touched.nodes.length = 0;
  return lanes.length > 0;
}

// Which connectors may not be driven at once: the road graph's own conflicts (paths that cross or end in the
// same lane) plus any pair from different lanes whose centre lines pass closer than CLEAR, or on which two of
// the biggest cars would come within 2 x BODY_PAD of each other. The graph only tests whether centre lines
// intersect, so opposing left turns, which pass about 0.8 m apart, would otherwise be granted together and
// the two cars would drive through each other; and a long car turning left past one turning right into the
// same road (centre lines 3.2 m apart at v2's T's) swings its corner into the other.
const CLEAR = 2.6 * M, BODY_PAD = 0.1 * M;
const BIG = Object.values(CAR_TYPES).reduce((b, t) => ({ hl: Math.max(b.hl, t.len / 2), hw: Math.max(b.hw, t.wid / 2) }), { hl: 0, hw: 0 });
const REACH = 2 * Math.hypot(BIG.hl + BODY_PAD, BIG.hw + BODY_PAD);   // two cars' centres further apart never meet
function conflictTable() {
  const at = nodes.map(() => []);
  for (const C of conns) at[C.node].push(C);
  const out = conns.map(C => new Set(C.conflicts));
  const box = conns.map(C => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < C.n; i++) { x0 = Math.min(x0, C.x[i]); x1 = Math.max(x1, C.x[i]); y0 = Math.min(y0, C.y[i]); y1 = Math.max(y1, C.y[i]); }
    return [x0, y0, x1, y1];
  });
  for (const list of at) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j], A = box[a.id], B = box[b.id];
      if (a.from === b.from || out[a.id].has(b.id)) continue;
      if (A[0] > B[2] + REACH || B[0] > A[2] + REACH || A[1] > B[3] + REACH || B[1] > A[3] + REACH) continue;
      if (passCloser(a, b, CLEAR) || bodiesMeet(a, b)) { out[a.id].add(b.id); out[b.id].add(a.id); }
    }
  }
  return out.map(S => Int32Array.from(S));
}

// Whether two of the biggest cars, one centred on any point of connector a and one on any point of b, each
// heading along its connector, would come within 2 x BODY_PAD of each other.
function bodiesMeet(a, b) {
  const TA = tnConn[a.id];
  for (let i = 0; i < a.n; i++) if (bodyOnConn(a.x[i], a.y[i], TA[2 * i], TA[2 * i + 1], b)) return true;
  return false;
}

// Whether the biggest car centred at (x, y) heading (ux, uy) and one centred on any point of connector C,
// heading along it, come within 2 x BODY_PAD of each other.
function bodyOnConn(x, y, ux, uy, C) {
  const T = tnConn[C.id], hl = BIG.hl + BODY_PAD, hw = BIG.hw + BODY_PAD;
  for (let j = 0; j < C.n; j++) {
    const dx = C.x[j] - x, dy = C.y[j] - y;
    if (Math.abs(dx) > REACH || Math.abs(dy) > REACH) continue;
    if (boxesMeet(dx, dy, ux, uy, hl, hw, T[2 * j], T[2 * j + 1], hl, hw)) return true;
  }
  return false;
}

// Whether box A (half length la, half width wa, heading (ux, uy)) and box B (lb, wb, heading (vx, vy)) whose
// centre is (dx, dy) from A's overlap: separating axes, each box's own two.
function boxesMeet(dx, dy, ux, uy, la, wa, vx, vy, lb, wb) {
  const c = Math.abs(ux * vx + uy * vy), s = Math.abs(ux * vy - uy * vx);   // the angle between them
  if (Math.abs(dx * ux + dy * uy) > la + lb * c + wb * s || Math.abs(dy * ux - dx * uy) > wa + lb * s + wb * c) return false;
  if (Math.abs(dx * vx + dy * vy) > lb + la * c + wa * s || Math.abs(dy * vx - dx * vy) > wb + la * s + wa * c) return false;
  return true;
}

// How much further back than LINE the cars of each lane stop at its end (px): enough that the biggest car
// standing at the line keeps clear of the connectors the other approaches drive across the junction. (On
// v2's T's a car going straight on past a side road can pass within 3 m of the side road's line.)
const BACK_MAX = 4 * M, BACK_STEP = 0.25 * M;
function lineSetbacks() {
  const at = nodes.map(() => []);
  for (const C of conns) at[C.node].push(C);
  const out = new Float32Array(lanes.length), P = { x: 0, y: 0, tx: 1, ty: 0 };
  for (const L of lanes) {
    if (!L.next.length) continue;
    const others = at[conns[L.next[0]].node].filter(C => C.from !== L.id);
    let b = 0;
    for (; b < BACK_MAX; b += BACK_STEP) {
      poseLane(L.id, L.len - LINE - b - BIG.hl, P);
      if (!others.some(C => bodyOnConn(P.x, P.y, P.tx, P.ty, C))) break;
    }
    out[L.id] = Math.min(b, BACK_MAX);
  }
  return out;
}
const lineOf = laneId => LINE + back[laneId];   // where a lane's cars stop: this far before its end, front bumper

// Whether polylines a and b come within r of each other anywhere (each point against the other's segments).
function passCloser(a, b, r) {
  const r2 = r * r;
  const near = (P, Q) => {
    for (let i = 0; i < P.n; i++) {
      const x = P.x[i], y = P.y[i];
      for (let j = 0; j + 1 < Q.n; j++) {
        const ax = Q.x[j], ay = Q.y[j], dx = Q.x[j + 1] - ax, dy = Q.y[j + 1] - ay;
        if (x < Math.min(ax, ax + dx) - r || x > Math.max(ax, ax + dx) + r || y < Math.min(ay, ay + dy) - r || y > Math.max(ay, ay + dy) + r) continue;
        const L2 = dx * dx + dy * dy;
        const f = L2 > 1e-9 ? clamp(((x - ax) * dx + (y - ay) * dy) / L2, 0, 1) : 0;
        const ex = ax + dx * f - x, ey = ay + dy * f - y;
        if (ex * ex + ey * ey < r2) return true;
      }
    }
    return false;
  };
  return near(a, b) || near(b, a);
}

// The connectors that may not be in use while connector cid is (for tools and tests).
export function junctionConflicts(cid) { bindNet(); return conflict[cid] || new Int32Array(0); }
// How far before the end of lane laneId its cars stop, front bumper (px; for tools and tests).
export function stopLine(laneId) { bindNet(); return lineOf(laneId); }

// The unit tangent at every point of a polyline, from the parabola through each point and its neighbours
// (weighted by the uneven spacing; at the ends, through the first or last three points).
function tangents(P) {
  const n = P.n, X = P.x, Y = P.y, T = new Float32Array(2 * n);
  const put = (i, tx, ty) => { const l = Math.hypot(tx, ty) || 1; T[2 * i] = tx / l; T[2 * i + 1] = ty / l; };
  if (n < 3) { for (let i = 0; i < n; i++) put(i, X[n - 1] - X[0], Y[n - 1] - Y[0]); return T; }
  const h = i => Math.hypot(X[i + 1] - X[i], Y[i + 1] - Y[i]) || 1e-6;
  for (let i = 1; i < n - 1; i++) {
    const a = h(i - 1), b = h(i);
    put(i, (b * b * (X[i] - X[i - 1]) + a * a * (X[i + 1] - X[i])) / (a * b * (a + b)),
           (b * b * (Y[i] - Y[i - 1]) + a * a * (Y[i + 1] - Y[i])) / (a * b * (a + b)));
  }
  const end = (i, j, k) => {
    // derivative at point i of the parabola through i, j, k (j next to i, k beyond)
    const a = Math.hypot(X[j] - X[i], Y[j] - Y[i]) || 1e-6, b = Math.hypot(X[k] - X[j], Y[k] - Y[j]) || 1e-6;
    const ci = -(2 * a + b) / (a * (a + b)), cj = (a + b) / (a * b), ck = -a / (b * (a + b));
    return [ci * X[i] + cj * X[j] + ck * X[k], ci * Y[i] + cj * Y[j] + ck * Y[k]];
  };
  const [sx, sy] = end(0, 1, 2), [ex, ey] = end(n - 1, n - 2, n - 3);
  put(0, sx, sy); put(n - 1, -ex, -ey);
  return T;
}

// A connector starts and ends exactly along its lanes, so a car's heading does not jump at a junction.
function joinTangents() {
  for (const C of conns) {
    const T = tnConn[C.id], A = tnLane[C.from], B = tnLane[C.to], na = lanes[C.from].n;
    T[0] = A[2 * na - 2]; T[1] = A[2 * na - 1];
    T[2 * C.n - 2] = B[0]; T[2 * C.n - 1] = B[1];
  }
}

// The speed a car can take each point of a polyline at: sqrt(LAT / k), with k the heading change across two
// points either side (so 1-2 m sampling noise does not read as a kink). Infinity on the straight.
function curveSpeeds(P) {
  const n = P.n, out = new Float32Array(n).fill(Infinity);
  for (let i = 1; i + 1 < n; i++) {
    const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2);
    const h1 = Math.atan2(P.y[a + 1] - P.y[a], P.x[a + 1] - P.x[a]);
    const h2 = Math.atan2(P.y[b] - P.y[b - 1], P.x[b] - P.x[b - 1]);
    const arc = (P.s[b] + P.s[b - 1] - P.s[a + 1] - P.s[a]) / 2;
    const k = arc > 1e-6 ? Math.abs(wrapPI(h2 - h1)) / arc : 0;
    if (k > 1e-7) out[i] = Math.sqrt(LAT / k);
  }
  if (n > 2) { out[0] = out[1]; out[n - 1] = out[n - 2]; }
  return out;
}

// Point and smoothly turning tangent at station s of a lane or connector polyline (T: its tangents). The
// tangent blends those of the two points around s, so a car's heading has no steps at the samples.
function poseOn(P, T, s, out) {
  const n = P.n, S = P.s, X = P.x, Y = P.y;
  s = clamp(s, 0, S[n - 1]);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
  const ds = S[hi] - S[lo], f = ds > 1e-9 ? (s - S[lo]) / ds : 0;
  out.x = X[lo] + (X[hi] - X[lo]) * f;
  out.y = Y[lo] + (Y[hi] - Y[lo]) * f;
  const tx = T[2 * lo] + (T[2 * hi] - T[2 * lo]) * f, ty = T[2 * lo + 1] + (T[2 * hi + 1] - T[2 * lo + 1]) * f;
  const l = Math.hypot(tx, ty) || 1;
  out.tx = tx / l; out.ty = ty / l;
  return out;
}
const poseLane = (id, s, out) => poseOn(lanes[id], tnLane[id], s, out);
const poseConn = (id, s, out) => poseOn(conns[id], tnConn[id], s, out);

// ---------- putting a car on a lane ----------

let seq = 0;
// Make c an AI car on a lane spot ({ lane, s } from roads.randomLanePoint or roads.nearestLane). opts.max caps
// its speed in px/s; opts.f is the driver's factor on the road speed (random 0.85-1.1 when not given).
export function aiAttach(c, lanePt, { max = Infinity, f = 0.85 + Math.random() * 0.25, speed = 0 } = {}) {
  bindNet();
  // a car is put down behind its lane's stop line (past it, it would stand in the junction), and one put down
  // already moving (streamed in out of view) can still stop there: the junction is not reserved for it yet,
  // and the light may be red
  const L = lanes[lanePt.lane];
  let s = lanePt.s ?? 0;
  if (L) {
    s = Math.max(0, Math.min(s, L.len - halfLen(c) - lineOf(L.id)));
    speed = Math.min(speed, reach(0, L.len - s - halfLen(c) - lineOf(L.id) - M));
  }
  c.ai = {
    id: ++seq, lane: lanePt.lane, conn: -1, s, speed, max, f,
    next: -1, next2: -1, rsv: -1, hold: -1, rsvT: 0, reqT: -1, why: null,
    stuck: 0, ghost: 0, wait: 0, still: 0, stillX: 0, red: false, through: null, throughConn: -1, throughT: 0, forced: false, honkT: 0, lcT: 0, lcX: 0, lcY: 0, lcCool: 0,
  };
  place(c, 0);
  return c;
}

// A car whose ai is missing its lane (made elsewhere, or the graph was rebuilt) joins the lane nearest it.
function reattach(c) {
  const q = roads.nearestLane?.(c.x, c.y, c.a);
  if (!q) return false;
  const old = c.ai;
  aiAttach(c, q, { max: old.max ?? Infinity, f: old.f ?? 0.85 + Math.random() * 0.25, speed: old.speed || 0 });
  return true;
}

// ---------- the frame: lane lists, reservations and who waits where ----------

let clock = 0;
const obstacles = [];                    // this frame's non-traffic things a car must not drive into: { ref, x, y, hl, v, kind }
let nObst = 0;

function beginFrame(dt) {
  clock += dt;
  for (const id of touched.lanes) lanes[id].cars.length = 0;
  for (const id of touched.conns) onConn[id].length = 0;
  for (const id of touched.nodes) waitAt[id].length = 0;
  touched.lanes.length = touched.conns.length = touched.nodes.length = 0;
  held.fill(0);

  nObst = 0;
  const p = G.player;
  if (!p.car && !p.dead) obstacle(p, 0.4 * M, 'player');
  for (const c of G.cars) {
    if (!c.ai) { obstacle(c, halfLen(c), 'car'); continue; }
    const a0 = c.ai;
    if (!(a0.lane >= 0 && a0.lane < lanes.length) || a0.conn >= conns.length || a0.conn == null) { if (!reattach(c)) { c.ai = null; continue; } }
    const ai = c.ai;
    if (ai.conn >= 0) { const list = onConn[ai.conn]; if (!list.length) touched.conns.push(ai.conn); list.push(c); }
    else { const list = lanes[ai.lane].cars; if (!list.length) touched.lanes.push(ai.lane); list.push(c); }
    if (ai.rsv >= 0) held[ai.rsv]++;
    if (ai.hold >= 0 && ai.hold !== ai.rsv) held[ai.hold]++;
    if (ai.reqT >= 0 && ai.rsv < 0 && ai.conn < 0 && ai.next >= 0) {
      const n = conns[ai.next].node;
      if (!waitAt[n].length) touched.nodes.push(n);
      waitAt[n].push(c);
    }
  }
  for (const id of touched.lanes) sortByS(lanes[id].cars);
  for (const id of touched.conns) sortByS(onConn[id]);
  for (const f of G.friends) if (f.following && !f.inCar) obstacle(f, 0.4 * M, 'friend');
  for (const pd of G.peds) if (pedInRoadway(pd)) obstacle(pd, 0.4 * M, 'ped');
}

// Someone on a crosswalk takes up the rest of their crossing: traffic stops short of the crosswalk while
// their way across still lies ahead of it, not just once they step into its lane.
const crossLeft = p => {
  const w = p.walk;
  if (p.state !== 'walk' || !w) return null;
  const P = roads.walks.paths[w.path];
  if (!P || !P.cross) return null;
  const k = w.dir > 0 ? P.n - 1 : 0;
  return { x: P.pts[2 * k], y: P.pts[2 * k + 1] };
};

// One thing in the way this frame (the list is reused from frame to frame).
function obstacle(ref, hl, kind) {
  let o = obstacles[nObst];
  if (!o) o = obstacles[nObst] = {};
  nObst++;
  o.ref = ref; o.x = ref.x; o.y = ref.y; o.hl = hl; o.kind = kind;
  o.vx = ref.vx || 0; o.vy = ref.vy || 0; o.v = kind === 'car' ? Math.hypot(o.vx, o.vy) : 0;
  o.to = kind === 'ped' ? crossLeft(ref) : null;
}

// lane lists are nearly sorted already, so insertion sort
function sortByS(a) {
  for (let i = 1; i < a.length; i++) {
    const c = a[i], s = c.ai.s;
    let j = i - 1;
    while (j >= 0 && a[j].ai.s > s) { a[j + 1] = a[j]; j--; }
    a[j + 1] = c;
  }
}

// Signals: two phases of 14 s green, 3 s amber and 2 s all-red per node (roadnet's clock). They are coded but
// off until the S6a soak passes; while off, signal candidates work as priority or all-way junctions.
export function updateSignals(dt) {
  if (roads.signalsOn && roads.tick) roads.tick(dt);
}

// Everything traffic does in one frame: the lane lists, then every AI car, then the stats sample.
export function updateTraffic(dt) {
  if (!bindNet()) return;
  updateSignals(dt);
  beginFrame(dt);
  for (const c of G.cars) if (c.ai) updateAICar(c, dt);
  sample(dt);
}

// ---------- junctions ----------

// The connector a car takes at the end of a lane: straight on .5, right .3, left .2 (on the Loop .75 straight
// on), only onto roads traffic uses, and a U-turn only where nothing else leads on.
function chooseConn(laneId) {
  const L = lanes[laneId], W = edges[L.edge].cls === 'hwy' ? THROUGH : WEIGHT;
  let total = 0, any = -1;
  for (const id of L.next) {
    const C = conns[id];
    if (!edges[lanes[C.to].edge].ai) continue;
    any = id;
    if (C.turn !== 'u') total += W[C.turn];
  }
  if (any < 0) return L.next.length ? L.next[0] : -1;
  if (total <= 0) return any;
  let r = Math.random() * total;
  for (const id of L.next) {
    const C = conns[id];
    if (C.turn === 'u' || !edges[lanes[C.to].edge].ai) continue;
    if ((r -= W[C.turn]) <= 0) return id;
  }
  return any;
}

// The k-th connector ahead of a car whose path reaches lane laneId there (0 = ai.next, 1 = ai.next2), picked
// now if it has not been.
function planned(ai, laneId, k) {
  const key = k ? 'next2' : 'next';
  let id = ai[key];
  if (id >= 0 && conns[id].from === laneId) return id;
  id = chooseConn(laneId);
  ai[key] = id;
  if (!k) ai.next2 = -1;
  return id;
}

const conflictsWith = (C, id) => { const a = conflict[C.id]; for (let i = 0; i < a.length; i++) if (a[i] === id) return true; return false; };

// Reserve connector cid for car c, or say why not (ai.why). Granted only when no connector crossing it (or
// passing too close, see conflictTable) is reserved or occupied, the lane beyond has room, a yielding approach
// has no priority car due within 4.5 s, and (at all-way junctions) nobody who asked earlier is waiting for a
// movement that conflicts with it.
function tryReserve(c, cid) {
  const ai = c.ai, C = conns[cid], N = nodes[C.node];
  if (ai.reqT < 0) ai.reqT = clock;
  if (N.control === 'signal' && roads.signalAt && roads.signalAt(N, lanes[C.from].edge) !== 'g') { ai.why = 'signal'; return false; }
  const K = conflict[cid];
  for (let i = 0; i < K.length; i++) if (held[K[i]] || onConn[K[i]].length) { ai.why = 'busy'; return false; }
  const T = lanes[C.to], first = T.cars[0];
  if (first && first.ai.s < Math.min(FREE, T.len - M)) { ai.why = 'exit'; return false; }
  if (C.yield) {
    // the first car on each priority approach that is (or may be) headed through the conflict: due within
    // 4.5 s, or waiting at its line for the junction to clear (else a stream of yielding cars, each let in
    // behind the last, would keep it waiting for good)
    for (let i = 0; i < K.length; i++) {
      const Q = conns[K[i]];
      if (Q.yield) continue;
      const F = lanes[Q.from];
      for (let j = F.cars.length - 1; j >= 0; j--) {
        const oa = F.cars[j].ai;
        if (oa.next >= 0 && oa.next !== Q.id) continue;
        if (oa.speed > STOP_V && (F.len - oa.s) / oa.speed < ETA) { ai.why = 'yield'; return false; }
        if (oa.next === Q.id && oa.rsv < 0 && oa.reqT >= 0 && oa.why === 'busy') { ai.why = 'yield'; return false; }
        break;
      }
    }
  }
  // a waiting car that asked first goes first: at all-way junctions, and at lights between the approaches
  // that have green. One waiting for room on its exit lane does not hold up the others, except at a light
  // those headed for that same lane (else whoever is updated first when room opens up always gets it).
  if (N.control === 'allway' || N.control === 'signal') {
    const lights = N.control === 'signal';
    for (const w of waitAt[N.id]) {
      const wa = w.ai;
      if (w === c || !wa || wa.rsv >= 0 || wa.reqT < 0 || wa.next < 0 || wa.why === 'signal') continue;
      if (wa.why === 'exit' && !(lights && conns[wa.next].to === C.to)) continue;
      if ((wa.reqT < ai.reqT || (wa.reqT === ai.reqT && wa.id < ai.id)) && conflictsWith(C, wa.next)) { ai.why = 'turn'; return false; }
    }
  }
  ai.rsv = cid; ai.rsvT = 0; ai.reqT = -1; ai.why = null; ai.wait = 0;
  held[cid]++;
  return true;
}

// A car let through on green gives the junction back if the light has changed and it can still stop: on
// red braking hard; on amber braking gently, or hard when it would not reach its line before the red anyway
// (a car slowing for a turn takes a while to cover the last metres). Committed cars run the amber, as
// drivers do, and are over the line before it turns red.
function lightChanged(c) {
  const ai = c.ai, C = conns[ai.rsv], N = nodes[C.node], e = lanes[C.from].edge;
  if (N.control !== 'signal' || !roads.signalAt) return false;
  const light = roads.signalAt(N, e);
  if (light === 'g') return false;
  const v = ai.speed, room = lanes[ai.lane].len - ai.s - halfLen(c) - lineOf(ai.lane);
  if (light !== 'a') return room > v * v / (2 * BRAKE);
  if (room > v * v / (2 * PLAN_B)) return true;
  if (room <= v * v / (2 * BRAKE) + M / 2) return false;
  // the time to the line, slowing from v to the speed it can take the connector at
  const t = room / Math.max((v + Math.min(v, vEnter[C.id])) / 2, STOP_V);
  return lightIn(N, e, t) === 'r';
}

// The light for traffic from edge e at signal node N, t seconds from now (the lights run on roadnet's clock).
function lightIn(N, e, t) {
  const now = roads.clock;
  roads.clock = now + t;
  const light = roads.signalAt(N, e);
  roads.clock = now;
  return light;
}

// ---------- one car ----------

// The car's path ahead, nearest piece first: { conn, id, s0, d0 } (d0 = distance from the car to s0).
const PIECES = [];
let nPieces = 0;
function piece(conn, id, s0, d0) {
  let q = PIECES[nPieces];
  if (!q) q = PIECES[nPieces] = {};
  q.conn = conn; q.id = id; q.s0 = s0; q.d0 = d0;
  nPieces++;
}

// The highest speed that still lets a car slow to v at distance d, braking at b.
const reach = (v, d, b = PLAN_B) => Math.sqrt(v * v + 2 * b * Math.max(0, d));
// IDM-lite (spec §9): the speed to follow something moving at vl with gap g (centre to centre, nominal cars)
// is (g - 7 m) / 1.2 s, so a follower keeps a 1.2 s time gap at any speed; capped by what still lets it stop
// behind the leader if the leader brakes at FOLLOW_B. The time gap is what leaves room when a leader stops
// dead (a bump sets its speed to 0).
function follow(g, vl) {
  const free = g - GAP0;
  if (free <= 0) return 0;
  return Math.min(free / HEADWAY, reach(vl, free, FOLLOW_B));
}

const P0 = { x: 0, y: 0, tx: 1, ty: 0 };

export function updateAICar(c, dt) {
  const ai = c.ai;
  if (!ai || ai.lane == null) return;
  if (!(ai.speed >= 0)) ai.speed = 0;               // a NaN or negative write stops the car rather than breaking it
  const hl = halfLen(c), ghost = ai.ghost > 0;
  if (ghost) ai.ghost -= dt;
  ai.lcCool -= dt;
  if (ai.rsv >= 0 && ai.conn < 0 && ((ai.rsvT += dt) > RSV_MAX || lightChanged(c))) { held[ai.rsv] = Math.max(0, held[ai.rsv] - 1); ai.rsv = -1; }
  if ((ai.through || ai.throughConn >= 0) && (ai.throughT += dt) > THROUGH_MAX) { ai.through = null; ai.throughConn = -1; }
  let v = Math.min(ai.speed, ai.max);
  const D = Math.max(LOOK_MIN, 20 * M + 1.2 * v, v * v / (2 * PLAN_B) + 12 * M);

  // the junction ahead: pick the connector, and ask for it once the car has to start slowing for the line
  // (only the front car of the lane asks; a car that stops asking leaves the all-way queue)
  let asking = false;
  if (ai.conn < 0) {
    const L = lanes[ai.lane], dEnd = L.len - ai.s;
    if (dEnd <= D) {
      const cid = planned(ai, ai.lane, 0);
      asking = cid >= 0 && ai.rsv !== cid && !ghost && ai.throughConn !== cid && dEnd - hl <= Math.max(10 * M, v * v / (2 * PLAN_B) + 6 * M) &&
        L.cars[L.cars.length - 1] === c;
      if (asking) tryReserve(c, cid);
    }
  }
  if (!asking && ai.rsv < 0) ai.reqT = -1;

  // the pieces of road ahead, up to the first stop line the car may not pass
  nPieces = 0;
  let d, laneId, stop = Infinity, stopConn = -1, line = LINE;
  if (ai.conn >= 0) {
    const C = conns[ai.conn];
    piece(true, ai.conn, ai.s, 0);
    d = C.len - ai.s; laneId = C.to;
    piece(false, laneId, 0, d);
    d += lanes[laneId].len;
  } else {
    laneId = ai.lane;
    piece(false, laneId, ai.s, 0);
    d = lanes[laneId].len - ai.s;
  }
  for (let k = 0; k < 2 && d < D; k++) {
    const cid = planned(ai, laneId, k);
    if (cid < 0) { stop = d; break; }                           // nowhere to go: the lane end is a wall
    if (!ghost && ai.rsv !== cid && ai.hold !== cid && ai.throughConn !== cid) { stop = d; stopConn = cid; line = lineOf(laneId); break; }
    piece(true, cid, 0, d);
    d += conns[cid].len; laneId = conns[cid].to;
    piece(false, laneId, 0, d);
    d += lanes[laneId].len;
  }

  // the speed it wants: the road's, then curves, the stop line, the car ahead and anything in the way
  let target = Infinity, cause = null, blocker = null, blockKind = null;
  for (let i = 0; i < nPieces; i++) {
    const q = PIECES[i];
    if (q.d0 > D) break;
    const P = q.conn ? conns[q.id] : lanes[q.id], vc = q.conn ? vcConn[q.id] : vcLane[q.id];
    // a connector already keeps to the speed of the road it leads onto
    target = Math.min(target, reach(edges[q.conn ? lanes[P.to].edge : P.edge].speed * ai.f, q.d0));
    for (let j = 0; j < P.n; j++) {
      const dj = q.d0 + P.s[j] - q.s0;
      if (dj > D) break;
      if (vc[j] < Infinity && P.s[j + 1 < P.n ? j + 1 : j] >= q.s0) target = Math.min(target, reach(vc[j], dj));
    }
  }
  const free = Math.min(target, ai.max);
  target = free;
  if (stop < Infinity) {
    const t = Math.sqrt(2 * PLAN_B * Math.max(0, stop - hl - line));
    if (t < target) { target = t; cause = 'line'; blocker = stopConn; }
  }
  let leader = null, leadGap = 0, throughSeen = false;
  if (!ghost) {
    // the nearest traffic car on the path (lane and connector lists are sorted by station)
    for (let i = 0; i < nPieces && !leader; i++) {
      const q = PIECES[i], list = q.conn ? onConn[q.id] : lanes[q.id].cars;
      for (let j = 0; j < list.length; j++) {
        const o = list[j];
        if (o === c || o.ai.s <= q.s0 + (i ? -1e-6 : 0)) continue;
        const dl = q.d0 + o.ai.s - q.s0;
        if (dl > D || dl > stop + hl) break;
        if (o === ai.through) { throughSeen = true; continue; }
        leader = o; leadGap = dl - hl - halfLen(o);
        const t = follow(dl - hl - halfLen(o) + NOM, o.ai.speed);
        if (t < target) { target = t; cause = 'lead'; blocker = o; }
        break;
      }
    }
    // the path stops at a line, but a car from the same lane just over it on any connector is still ahead
    if (stopConn >= 0) {
      const next = lanes[conns[stopConn].from].next;
      for (let k = 0; k < next.length; k++) for (const o of onConn[next[k]]) {
        if (o === c || o.ai.conn !== next[k] || o.ai.s > halfLen(o) + hl) continue;
        if (o === ai.through) { throughSeen = true; continue; }
        const dl = stop + o.ai.s, t = follow(dl - hl - halfLen(o) + NOM, 0);
        if (t < target) { target = t; cause = 'lead'; blocker = o; leader = o; leadGap = dl - hl - halfLen(o); }
      }
    }
    const reachD = Math.min(D, stop) + hl;
    // a car that took another connector from the same lane is ahead of this one until their paths part, and
    // is on no list of this car's path: it is followed while it is within 2.2 m of the path, and this car stops
    // short of where its body would meet that one's (a long car's tail swings across the next connector)
    for (let i = 0; i < nPieces; i++) {
      const q = PIECES[i];
      if (!q.conn || q.d0 > reachD) continue;
      const sib = lanes[conns[q.id].from].next;
      for (let k = 0; k < sib.length; k++) {
        if (sib[k] === q.id) continue;
        const list = onConn[sib[k]];
        for (let j = 0; j < list.length; j++) {
          const o = list[j];
          // (on this car's own connector's sibling, one that went in after it is behind it)
          if (o === c || o.ai.conn !== sib[k] || (i === 0 && o.ai.s <= ai.s)) continue;
          const dl = alongPath(o.x, o.y, reachD), dh = bodyHit(c, o, reachD);
          if (o === ai.through) { if (dl >= 0 || dh >= 0) throughSeen = true; continue; }
          if (dl >= 0) {
            if (PIECES[0].conn) poseConn(PIECES[0].id, ai.s, P0); else poseLane(PIECES[0].id, ai.s, P0);
            const t = follow(dl - hl - halfLen(o) + NOM, Math.max(0, o.vx * P0.tx + o.vy * P0.ty));
            if (t < target) { target = t; cause = 'lead'; blocker = o; leader = o; leadGap = dl - hl - halfLen(o); }
          }
          if (dh >= 0) {
            const t = Math.sqrt(2 * PLAN_B * dh);
            if (t < target) { target = t; cause = 'lead'; blocker = o; leader = o; leadGap = 0; }
          }
        }
      }
    }
    // people, the player, parked and police cars: anything within 2.2 m of the path ahead
    for (let k = 0; k < nObst; k++) {
      const o = obstacles[k];
      if (Math.abs(o.x - c.x) > reachD + PATH_W || Math.abs(o.y - c.y) > reachD + PATH_W) continue;
      const dl = o.to ? crossingAhead(o, reachD) : alongPath(o.x, o.y, reachD);
      if (dl < 0) continue;
      if (o.ref === ai.through) { throughSeen = true; continue; }
      let vl = 0;
      if (o.kind === 'car' && o.v > 0) {
        if (PIECES[0].conn) poseConn(PIECES[0].id, ai.s, P0); else poseLane(PIECES[0].id, ai.s, P0);
        vl = Math.max(0, o.vx * P0.tx + o.vy * P0.ty);
      }
      const t = follow(dl - hl - o.hl + NOM, vl);
      if (t < target) { target = t; cause = 'obst'; blocker = o.ref; blockKind = o.kind; }
    }
  }
  // a car that ghosted through something keeps going through it until it is past
  if (ai.through && !throughSeen && !ghost) ai.through = null;

  // lane changes (highways and boulevards only): around a leader doing under 70% of the car's own speed, while
  // it is still 15 m ahead, so the 2 s slide across is over before the car draws level with it
  if (cause === 'lead' && ai.conn < 0 && ai.lcCool <= 0 && edges[lanes[ai.lane].edge].laneChange && leadGap > LC_AHEAD &&
      blocker.ai.speed < LC_LEAD * free && lanes[ai.lane].len - ai.s > LOOK_MIN) tryLaneChange(c);

  // speed: up at 2.5 m/s², down at up to 7 m/s²
  const dv = clamp(target - v, -BRAKE * dt, ACC * dt);
  v = Math.max(0, v + dv);
  ai.speed = v;
  c.brake = dv < -0.5 * M * dt || v < STOP_V;

  move(c, v * dt, hl, ghost);
  place(c, dt);

  // how long it has stood still; and for the stats' stuck share (stillX), how long not counting time held by
  // a red light (red: stopped at its line, or in the queue behind a car that is), a wait of up to about 20 s
  // that clears by itself
  const stopped = v < STOP_V;
  ai.still = stopped ? ai.still + dt : 0;
  ai.red = stopped && (cause === 'line' ? ai.why === 'signal' : cause === 'lead' && !!blocker.ai?.red);
  ai.stillX = stopped && !ai.red ? ai.stillX + dt : 0;

  // stuck: stopped by something that is not about to move. Waiting in an ordinary queue or briefly at a
  // stop line is not stuck. Stuck for 4 s, the car ghosts for 1.5 s and keeps passing through whatever held
  // it (a parked car, someone lying in the road, a junction that never frees) until it is clear: the
  // deadlock breaker.
  if (cause === 'line' && stopped) ai.wait = ai.why === 'signal' ? 0 : ai.wait + dt; else if (!stopped) ai.wait = 0;
  // (waiting at a red light, or to yield to priority traffic, is never stuck: that clears by itself, and the
  // wait at a line starts again when the light turns green. On a yielding approach only a jammed exit lane
  // is.)
  const yielding = ai.next >= 0 && conns[ai.next].yield;
  const lineStuck = cause === 'line' && ai.wait > WAIT_STUCK && ai.why !== 'signal' && (ai.why === 'exit' || (!yielding && ai.why !== 'yield'));
  // (behind a stuck car in its own lane it waits for that one to ghost on: going through it would only leave
  // it standing inside it at the same jam. A stuck car on a connector or another lane is a junction deadlock,
  // which any car in it may break.)
  const sameLane = cause === 'lead' && blocker.ai && ai.conn < 0 && blocker.ai.conn < 0 && blocker.ai.lane === ai.lane;
  const blocked = stopped && free > STOP_V &&
    ((cause === 'obst' && staysPut(blockKind, blocker)) || lineStuck || (cause === 'lead' && blocker.ai && blocker.ai.stuck > 0.5 && !sameLane));
  if (blocked) ai.stuck += dt; else ai.stuck = Math.max(0, ai.stuck - dt);
  if (ai.stuck > STUCK) {
    ai.ghost = GHOST; ai.stuck = 0; ST.ghosts++;
    // what held it: a junction it could not get into (a connector id; -1 is a dead end, nothing to pass) or
    // a thing in its way
    if (typeof blocker === 'number') { ai.throughConn = blocker; ai.through = null; } else { ai.through = blocker; ai.throughConn = -1; }
    ai.throughT = 0;
  }
  // a driver kept waiting by Kimchi lets him know
  ai.honkT -= dt;
  if (stopped && cause === 'obst' && (blocker === G.player || blocker === G.player.car) && ai.still > 1.5 && !c.bubble && ai.honkT <= 0) {
    c.bubble = { text: pick(HONKS), t: 2 };
    ai.honkT = 8;
  }
}

// Whether something in a car's way will stay there: a stopped car, someone lying in the road, an officer
// standing in it. People walking (across a crosswalk, back to the pavement) clear by themselves, and so does
// Kimchi on foot (the drivers honk instead), so a car waits for them however long it takes.
function staysPut(kind, ref) {
  if (kind === 'car') return Math.hypot(ref.vx || 0, ref.vy || 0) < STOP_V;
  if (kind === 'ped') return ref.state === 'down' || !!ref.role;
  return false;
}
const HONKS = ['*HONK*', 'Move it!', 'Hey, road\'s for cars!', 'Beep beep!'];

// Distance along the car's path to the point nearest (x, y), or -1 when that point is behind the car, beyond
// `maxD`, or more than PATH_W from the path.
function alongPath(x, y, maxD) {
  for (let i = 0; i < nPieces; i++) {
    const q = PIECES[i];
    if (q.d0 > maxD) break;
    const P = q.conn ? conns[q.id] : lanes[q.id];
    for (let j = 0; j + 1 < P.n; j++) {
      if (P.s[j + 1] < q.s0) continue;
      const d0 = q.d0 + P.s[j] - q.s0;
      if (d0 > maxD) break;
      const ax = P.x[j], ay = P.y[j], dx = P.x[j + 1] - ax, dy = P.y[j + 1] - ay;
      if (x < Math.min(ax, ax + dx) - PATH_W || x > Math.max(ax, ax + dx) + PATH_W ||
          y < Math.min(ay, ay + dy) - PATH_W || y > Math.max(ay, ay + dy) + PATH_W) continue;
      const L2 = dx * dx + dy * dy, f = L2 > 1e-9 ? clamp(((x - ax) * dx + (y - ay) * dy) / L2, 0, 1) : 0;
      const ex = ax + dx * f - x, ey = ay + dy * f - y;
      if (ex * ex + ey * ey > PATH_W * PATH_W) continue;
      const along = q.d0 + P.s[j] + (P.s[j + 1] - P.s[j]) * f - q.s0;
      if (along < 0) continue;
      return along;
    }
  }
  return -1;
}

// How far the car's centre can go along its path and keep its body (grown by BODY_PAD) off car o's where o
// stands now: to the last point of the path short of the first where they would meet. -1 when they do not
// meet within maxD.
function bodyHit(c, o, maxD) {
  const la = halfLen(c) + BODY_PAD, wa = halfWid(c) + BODY_PAD, lb = halfLen(o) + BODY_PAD, wb = halfWid(o) + BODY_PAD;
  const vx = Math.cos(o.a), vy = Math.sin(o.a), r = Math.hypot(la, wa) + Math.hypot(lb, wb);
  let clear = 0;
  for (let i = 0; i < nPieces; i++) {
    const q = PIECES[i];
    if (q.d0 > maxD) break;
    const P = q.conn ? conns[q.id] : lanes[q.id], T = q.conn ? tnConn[q.id] : tnLane[q.id];
    for (let j = 0; j < P.n; j++) {
      const along = q.d0 + P.s[j] - q.s0;
      if (along < 0) continue;
      if (along > maxD) return -1;
      const dx = o.x - P.x[j], dy = o.y - P.y[j];
      if (Math.abs(dx) <= r && Math.abs(dy) <= r && boxesMeet(dx, dy, T[2 * j], T[2 * j + 1], la, wa, vx, vy, lb, wb)) return clear;
      clear = along;
    }
  }
  return -1;
}

// The nearest point of a crossing ped's way across (from where they are to the far kerb, every 1.5 m)
// that lies on the car's path, or -1.
function crossingAhead(o, maxD) {
  const dx = o.to.x - o.x, dy = o.to.y - o.y, n = Math.ceil(Math.hypot(dx, dy) / (1.5 * M));
  let best = -1;
  for (let i = 0; i <= n; i++) {
    const d = alongPath(o.x + dx * i / Math.max(n, 1), o.y + dy * i / Math.max(n, 1), maxD);
    if (d >= 0 && (best < 0 || d < best)) best = d;
  }
  return best;
}

// Advance a car ds px along its path: into the reserved connector at the lane end, onto the next lane at the
// connector end. A car with no reservation stops at the lane end.
function move(c, ds, hl, ghost) {
  const ai = c.ai;
  let s = ai.s + ds;
  for (let guard = 0; guard < 8; guard++) {
    if (ai.conn < 0) {
      const L = lanes[ai.lane];
      if (ai.hold >= 0 && conns[ai.hold].to === ai.lane && s > hl + M) ai.hold = -1;   // clear of the junction behind
      if (s <= L.len) break;
      const cid = ai.next;
      if (cid < 0 || (cid !== ai.rsv && !ghost && cid !== ai.throughConn)) { s = L.len; ai.speed = 0; break; }
      s -= L.len;
      ai.conn = cid; ai.hold = cid;
      ai.forced = ai.rsv !== cid;          // ghosted in without a reservation
      if (ai.rsv === cid) ai.rsv = -1;
      if (ai.throughConn === cid) ai.throughConn = -1;
      ai.next = ai.next2; ai.next2 = -1; ai.reqT = -1; ai.why = null; ai.wait = 0;
    } else {
      const C = conns[ai.conn];
      if (s <= C.len) break;
      s -= C.len;
      ai.lane = C.to; ai.conn = -1; ai.forced = false;
    }
  }
  ai.s = s;
}

// Put the car where its station says, heading along the lane (turned into a lane change), moving at speed x
// tangent.
const PT = { x: 0, y: 0, tx: 1, ty: 0 };
function place(c, dt) {
  const ai = c.ai;
  if (ai.conn >= 0) poseConn(ai.conn, ai.s, PT); else poseLane(ai.lane, ai.s, PT);
  let x = PT.x, y = PT.y, yaw = 0;
  if (ai.lcT > 0) {
    // a lane change slides across from where the car was over LC_T seconds, the nose turned into the slide
    // (the sideways rate over the forward speed, floored at 4 m/s so a slow car does not swing round)
    ai.lcT = Math.max(0, ai.lcT - dt);
    const k = ai.lcT / LC_T, w = k * k * (3 - 2 * k), dw = -6 * k * (1 - k) / LC_T;
    x += ai.lcX * w; y += ai.lcY * w;
    const side = (ai.lcY * PT.tx - ai.lcX * PT.ty) * dw;          // px/s to the left of the tangent
    yaw = clamp(Math.atan2(side, Math.max(ai.speed, 4 * M)), -LC_YAW, LC_YAW);
  }
  c.x = x; c.y = y;
  c.a = Math.atan2(PT.ty, PT.tx) + yaw;
  c.vx = ai.speed * PT.tx; c.vy = ai.speed * PT.ty;
  c.speed = ai.speed;
}

// Move to the lane beside (left first) when its 25 m either side of the car's spot is clear. Not while the
// car is still clearing the junction behind it: the junction stays held until move() sees the car clear of
// it on the connector's own exit lane, so a car that left that lane would hold it until its next junction.
function tryLaneChange(c) {
  const ai = c.ai, L = lanes[ai.lane];
  if (ai.hold >= 0) return false;
  const es = edgeStation(L, ai.s);
  for (const nb of [L.left, L.right]) {
    if (nb == null || nb < 0) continue;
    const s2 = roads.laneStation(nb, es), N = lanes[nb];
    if (!laneRoom(c, nb, s2)) continue;
    if (N.len - s2 < Math.max(LOOK_MIN, ai.speed * LC_T + 5 * M)) continue;   // the slide ends on this lane
    poseLane(L.id, ai.s, PT);
    const ox = PT.x, oy = PT.y;
    poseLane(nb, s2, PT);
    ai.lcX = ox - PT.x; ai.lcY = oy - PT.y; ai.lcT = LC_T; ai.lcCool = LC_COOL;
    if (ai.rsv >= 0) { held[ai.rsv] = Math.max(0, held[ai.rsv] - 1); ai.rsv = -1; }
    ai.lane = nb; ai.s = s2; ai.next = ai.next2 = -1; ai.reqT = -1;
    return true;
  }
  return false;
}

// Whether lane nb has room for car c at station s2: nobody within 25 m of it, more when the other car is
// closing (so it can brake to c's speed at FOLLOW_B). Near the start of the lane that counts the cars still
// on their way in, on a connector into nb or at the end of a lane with one planned, at the station they will
// reach on nb (behind its start by the distance they still have to drive): they are on no list of nb's yet.
function laneRoom(c, nb, s2) {
  const v = c.ai.speed, N = lanes[nb];
  const clear = o => {
    if (o === c) return true;
    const so = stationOn(o, nb);
    if (so == null) return true;
    const ahead = so >= s2, dv = ahead ? v - o.ai.speed : o.ai.speed - v;
    return Math.abs(so - s2) >= LC_GAP + (dv > 0 ? dv * dv / (2 * FOLLOW_B) : 0);
  };
  for (const o of N.cars) if (!clear(o)) return false;
  if (s2 > LC_GAP + LC_REACH) return true;     // far enough in that nobody still coming in is near
  for (const cid of N.prev) {
    for (const o of onConn[cid]) if (!clear(o)) return false;
    for (const o of lanes[conns[cid].from].cars) if (!clear(o)) return false;
  }
  return true;
}

// Car o's station on lane nb: where it is on nb, or (negative) where it will be once it has driven the rest of
// the connector into nb, or the rest of its lane and the connector it has planned into nb. null otherwise.
// (From the car's own state, not the frame's lists: a car may have moved on since they were made.)
function stationOn(o, nb) {
  const a = o.ai;
  if (!a) return null;
  if (a.conn >= 0) { const C = conns[a.conn]; return C.to === nb ? a.s - C.len : null; }
  if (a.lane === nb) return a.s;
  const nx = a.next >= 0 ? conns[a.next] : null;
  return nx && nx.to === nb && nx.from === a.lane ? a.s - lanes[a.lane].len - nx.len : null;
}

// The edge station at lane station s (lanes keep the edge station of every point).
function edgeStation(L, s) {
  const S = L.s, n = L.n;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
  const ds = S[hi] - S[lo], f = ds > 1e-9 ? clamp((s - S[lo]) / ds, 0, 1) : 0;
  return L.es[lo] + (L.es[hi] - L.es[lo]) * f;
}

// ---------- stats for the soak (window.KCSTATS, read by KC3.soak) ----------

const SAMPLE_EVERY = 0.5;   // s
const ST = {};
let seen = new WeakSet(), stuckOnce = new WeakSet();   // cars sampled, and cars stopped for over 5 s, this window
export function resetTrafficStats() {
  Object.assign(ST, { sec: 0, next: 0, samples: 0, carSamples: 0, still5: 0, stopped5: 0, speedSum: 0, minGap: Infinity, close: 0,
    closeGhost: 0, connSamples: 0, turnSamples: 0, pedSamples: 0, pedOnRoad: 0, pedOnRoadMax: 0, ghosts: 0, spawned: 0,
    despawned: 0, maxStill: 0, carsSeen: 0, stuckCars: 0 });
  seen = new WeakSet(); stuckOnce = new WeakSet();
}
resetTrafficStats();

// population.js reports what it adds and removes
export function countTraffic(kind, n = 1) { if (kind in ST) ST[kind] += n; }

function sample(dt) {
  ST.sec += dt;
  if (ST.sec < ST.next) return;
  ST.next = ST.sec + SAMPLE_EVERY;
  ST.samples++;
  const cars = G.cars;
  for (let i = 0; i < cars.length; i++) {
    const a = cars[i].ai;
    if (!a) continue;
    ST.carSamples++;
    ST.speedSum += a.speed;
    if (!seen.has(cars[i])) { seen.add(cars[i]); ST.carsSeen++; }
    if (a.still > 5) ST.stopped5++;
    if (a.stillX > 5) { ST.still5++; if (!stuckOnce.has(cars[i])) { stuckOnce.add(cars[i]); ST.stuckCars++; } }
    ST.maxStill = Math.max(ST.maxStill, a.still);
    if (a.conn >= 0) { ST.connSamples++; if (conns[a.conn].turn !== 's') ST.turnSamples++; continue; }
    // the closest pair of traffic cars outside the junctions
    for (let j = i + 1; j < cars.length; j++) {
      const b = cars[j].ai;
      if (!b || b.conn >= 0) continue;
      const dx = cars[i].x - cars[j].x, dy = cars[i].y - cars[j].y;
      if (Math.abs(dx) > 10 * M || Math.abs(dy) > 10 * M) continue;
      const g = Math.hypot(dx, dy) / M;
      if (a.ghost > 0 || b.ghost > 0 || a.through === cars[j] || b.through === cars[i]) { if (g < 3) ST.closeGhost++; continue; }
      ST.minGap = Math.min(ST.minGap, g);
      if (g < 3) ST.close++;
    }
  }
  let onRoad = 0;
  for (const p of G.peds) {
    if (p.role) continue;
    ST.pedSamples++;
    if (pedOnRoad(p)) onRoad++;
  }
  ST.pedOnRoad += onRoad;
  ST.pedOnRoadMax = Math.max(ST.pedOnRoadMax, onRoad);
}

// What traffic did since the stats were last reset (a new game, or KC3.soak starting): speeds in m/s,
// gaps in metres. stuckPct is the share of car samples stopped for over 5 s, not counting time held by a red
// light (stoppedPct counts that too); stuckCars counts cars that were.
export function trafficStats({ reset = false } = {}) {
  const r = {
    sec: Math.round(ST.sec * 10) / 10,
    cars: G.cars.filter(c => c.ai).length,
    peds: G.peds.filter(p => !p.role).length,
    meanSpeed: ST.carSamples ? Math.round(ST.speedSum / ST.carSamples / M * 100) / 100 : null,
    stuckPct: ST.carSamples ? Math.round(ST.still5 / ST.carSamples * 10000) / 100 : 0,
    stoppedPct: ST.carSamples ? Math.round(ST.stopped5 / ST.carSamples * 10000) / 100 : 0,
    stuckCars: ST.stuckCars, carsSeen: ST.carsSeen,
    maxStill: Math.round(ST.maxStill * 10) / 10,
    minGap: ST.minGap === Infinity ? null : Math.round(ST.minGap * 100) / 100,
    closePairs: ST.close, closeGhostPairs: ST.closeGhost,
    onConnectorPct: ST.carSamples ? Math.round(ST.connSamples / ST.carSamples * 1000) / 10 : 0,
    turningPct: ST.carSamples ? Math.round(ST.turnSamples / ST.carSamples * 1000) / 10 : 0,
    pedsOnRoad: ST.pedOnRoadMax, pedOnRoadSamples: ST.pedOnRoad,
    ghosts: ST.ghosts, spawned: ST.spawned, despawned: ST.despawned,
  };
  if (reset) resetTrafficStats();
  return r;
}
