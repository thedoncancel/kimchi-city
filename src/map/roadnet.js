// The road graph both maps drive on (docs/map-v2-spec.md §4, §6.3, §7, §9). Authored roads in metres go
// in; a RoadNet in sim pixels comes out: junction nodes, edges between them, lanes, the curved connectors
// that join lanes across a junction, the sidewalk graph, a 32 m segment hash, and the queries traffic,
// police, missions and peds use (nearest, lanes, A* routes, path following, random spawn points).
// Pure data and functions: no three, no DOM, runs in node.
//
// Units of the result: every position, station and length is in px (px = metres * opts.px), speeds are
// px/s, curvature k is 1/px (positive turns right), heights gy are metres, bank is radians (positive =
// the right edge is lower). Headings follow the spec: a = atan2(dy, dx), 0 = east, PI/2 = south.
import { sampleCurve, bezier, segX } from './spline.js';

// A road class says how wide the road is and how traffic uses it. Missing fields fall back to these; a
// road may override any of them (speed, minR, ai, oneway, priority ...). lanes is per direction; a
// 'single' road (dirt, alley) is one shared carriageway, modelled as a lane each way of half its width.
const BASE = { lanes: 1, laneW: 3.5, median: 0, walk: 0, halfW: 4, speed: 10, bank: 0, ai: true, oneway: false, single: false };
// Which road keeps priority at a junction: the higher rank (a road flagged priority ranks above all).
export const RANK = { hwy: 9, ring: 8, blvd: 7, coast: 6, ave: 5, country: 4, switch: 3, street: 2, dirt: 1, alley: 0 };
// Classes whose radius check uses the 3 m chord (spec §4.1); the rest use 8 m.
const TIGHT = new Set(['switch', 'street', 'dirt', 'alley', 'ring']);

const MERGE = 3;          // m: junction points closer than this are one node
const CELL = 32;          // m: the segment hash cell
const PLAN_R = 4;         // m: a crossing this close to a control point of both roads was authored
const TURN_S = 35 * Math.PI / 180, TURN_U = 150 * Math.PI / 180;
const CORNER_R = 1;       // m: sidewalks round each junction corner with this much run-in
const NODE_BLEND = 15;    // m: an edge's height eases to its node's height over this distance
const G = 9.81;
// Signals (spec §9): two phases of 14 s green, 3 s amber, 2 s all-red, offset per node.
const SIG = { green: 14, amber: 3, red: 2 };
const CYCLE = 2 * (SIG.green + SIG.amber + SIG.red);

const TAU = Math.PI * 2;
const wrapPI = a => a - TAU * Math.floor((a + Math.PI) / TAU);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const hash01 = n => { let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

// ---------- the segment hash ----------
// Cells of `cell` units mapping to flat [id, segment, id, segment, ...] lists. An entry spanning several
// cells is listed in each, so a query can see it more than once.
function makeHash(cell) {
  const map = new Map();
  const key = (cx, cy) => (cy + 4096) * 16384 + (cx + 4096);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  return {
    cell, map,
    add(id, j, ax, ay, bx, by) {
      const cx0 = Math.floor(Math.min(ax, bx) / cell), cx1 = Math.floor(Math.max(ax, bx) / cell);
      const cy0 = Math.floor(Math.min(ay, by) / cell), cy1 = Math.floor(Math.max(ay, by) / cell);
      x0 = Math.min(x0, cx0); y0 = Math.min(y0, cy0); x1 = Math.max(x1, cx1); y1 = Math.max(y1, cy1);
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
        const k = key(cx, cy);
        let a = map.get(k);
        if (!a) map.set(k, a = []);
        a.push(id, j);
      }
    },
    query(ax, ay, bx, by, fn) {
      const cx0 = Math.floor(Math.min(ax, bx) / cell), cx1 = Math.floor(Math.max(ax, bx) / cell);
      const cy0 = Math.floor(Math.min(ay, by) / cell), cy1 = Math.floor(Math.max(ay, by) / cell);
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
        const a = map.get(key(cx, cy));
        if (a) for (let i = 0; i < a.length; i += 2) fn(a[i], a[i + 1]);
      }
    },
    at(cx, cy) { return map.get(key(cx, cy)); },
    bounds() { return { x0, y0, x1, y1 }; },
  };
}

// ---------- roads as editable polylines (metres) ----------

function classOf(road, classes) {
  const c = { ...BASE, ...(classes[road.cls] || {}) };
  for (const k of ['lanes', 'laneW', 'median', 'walk', 'walkL', 'walkR', 'halfW', 'speed', 'bank', 'ai', 'oneway', 'single', 'minR', 'chord', 'priority'])
    if (road[k] !== undefined) c[k] = road[k];
  if (c.chord === undefined) c.chord = TIGHT.has(road.cls) ? 3 : 8;
  return c;
}

function makeWay(road, ri, classes) {
  const P = classOf(road, classes), closed = !!road.closed;
  const c = sampleCurve(road.pts, { closed, step: 2, chord: P.chord });
  const w = {
    ri, id: road.id ?? `road${ri}`, name: road.name ?? road.id ?? `road${ri}`, cls: road.cls, road, P, closed,
    oneway: !!P.oneway, rank: (RANK[road.cls] ?? 2) + (P.priority ? 10 : 0),
    x: Array.from(c.x), z: Array.from(c.z), k: Array.from(c.k), u: Array.from(c.u), s: null, len: 0,
  };
  restation(w);
  return w;
}

function restation(w) {
  const s = [0];
  for (let i = 1; i < w.x.length; i++) s.push(s[i - 1] + Math.hypot(w.x[i] - w.x[i - 1], w.z[i] - w.z[i - 1]));
  w.s = s; w.len = s[s.length - 1];
}

function wayIndex(w, s) {
  let lo = 0, hi = w.s.length - 1;
  if (s <= 0) return 0;
  if (s >= w.s[hi]) return hi - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (w.s[m] <= s) lo = m; else hi = m; }
  return lo;
}

// Position, curvature and control parameter at station s of a way (wrapped when closed).
function wayAt(w, s) {
  if (w.closed) s = ((s % w.len) + w.len) % w.len; else s = clamp(s, 0, w.len);
  const i = Math.min(wayIndex(w, s), w.x.length - 2), j = i + 1;
  const ds = w.s[j] - w.s[i], f = ds > 1e-9 ? (s - w.s[i]) / ds : 0;
  const tx = w.x[j] - w.x[i], tz = w.z[j] - w.z[i], tl = Math.hypot(tx, tz) || 1;
  return { x: w.x[i] + tx * f, z: w.z[i] + tz * f, k: w.k[i] + (w.k[j] - w.k[i]) * f, u: w.u[i] + (w.u[j] - w.u[i]) * f,
    tx: tx / tl, tz: tz / tl, i, s };
}

// Closest point of a way (segments i0..i1) to (x, z).
function projectWay(w, x, z, i0 = 0, i1 = w.x.length - 1) {
  let best = null;
  for (let i = Math.max(0, i0); i < Math.min(i1, w.x.length - 1); i++) {
    const p = projSeg(w.x[i], w.z[i], w.x[i + 1], w.z[i + 1], x, z);
    if (!best || p.d < best.d) { best = p; best.i = i; }
  }
  best.s = w.s[best.i] + (w.s[best.i + 1] - w.s[best.i]) * best.f;
  return best;
}

function projSeg(ax, az, bx, bz, x, z) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
  const f = L2 > 1e-12 ? clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1) : 0;
  const px = ax + dx * f, pz = az + dz * f;
  return { f, x: px, z: pz, d: Math.hypot(x - px, z - pz) };
}

// projectWay limited to the way's segments the hash lists within 2 m of the point (the whole way when none
// are that close).
function projectNear(H, w, x, z) {
  let lo = Infinity, hi = -1;
  H.query(x - 2, z - 2, x + 2, z + 2, (oi, oj) => { if (oi === w.ri) { if (oj < lo) lo = oj; if (oj > hi) hi = oj; } });
  return hi < 0 || hi - lo > 64 ? projectWay(w, x, z) : projectWay(w, x, z, lo, hi + 1);
}

function wayHash(W) {
  const h = makeHash(CELL);
  for (const w of W) for (let j = 0; j < w.x.length - 1; j++) h.add(w.ri, j, w.x[j], w.z[j], w.x[j + 1], w.z[j + 1]);
  return h;
}

// ---------- step 1: open road ends join the road they stop at ----------
// An end that crosses another road within its last `snap` metres is cut back to that crossing; an end that
// stops short of one (within snap) is extended straight to its projection, so the side road meets the main
// road's centre line and the T node sits on it (spec §6.3).
function snapEnds(W, snap) {
  const H = wayHash(W);
  const mods = [];
  for (const w of W) {
    if (w.closed) continue;
    const n = w.x.length;
    for (const atStart of [true, false]) {
      const ex = atStart ? w.x[0] : w.x[n - 1], ez = atStart ? w.z[0] : w.z[n - 1];
      let best = null;
      for (let j = 0; j < n - 1; j++) {
        const fromEnd = atStart ? w.s[j] : w.len - w.s[j + 1];
        if (fromEnd > snap) continue;
        H.query(w.x[j], w.z[j], w.x[j + 1], w.z[j + 1], (oi, oj) => {
          if (oi === w.ri) return;
          const o = W[oi];
          const X = segX(w.x[j], w.z[j], w.x[j + 1], w.z[j + 1], o.x[oj], o.z[oj], o.x[oj + 1], o.z[oj + 1]);
          if (!X) return;
          const s = w.s[j] + (w.s[j + 1] - w.s[j]) * X.t, dist = atStart ? s : w.len - s;
          if (dist <= snap && (!best || dist < best.dist)) best = { trim: true, dist, s, x: X.x, z: X.z, target: oi };
        });
      }
      if (!best) {
        H.query(ex - snap, ez - snap, ex + snap, ez + snap, (oi, oj) => {
          if (oi === w.ri) return;
          const o = W[oi], p = projSeg(o.x[oj], o.z[oj], o.x[oj + 1], o.z[oj + 1], ex, ez);
          if (p.d <= snap && (!best || p.d < best.dist)) best = { trim: false, dist: p.d, x: p.x, z: p.z, target: oi };
        });
      }
      if (best) mods.push({ w, atStart, ...best });
    }
  }
  // the far end first, so the stations of a start cut stay valid
  for (const m of mods.filter(m => !m.atStart)) applyEnd(m);
  for (const m of mods.filter(m => m.atStart)) applyEnd(m);
  for (const w of new Set(mods.map(m => m.w))) restation(w);
  return mods;
}

function applyEnd(m) {
  const w = m.w;
  if (m.trim) {
    const p = wayAt(w, m.s);
    if (m.atStart) {
      const j = p.i + 1;
      w.x.splice(0, j, m.x); w.z.splice(0, j, m.z); w.k.splice(0, j, p.k); w.u.splice(0, j, p.u); w.s.splice(0, j, m.s);
    } else {
      const j = p.i + 1;
      w.x.length = w.z.length = w.k.length = w.u.length = w.s.length = j;
      w.x.push(m.x); w.z.push(m.z); w.k.push(p.k); w.u.push(p.u); w.s.push(m.s);
    }
    return;
  }
  const n = w.x.length, ex = m.atStart ? w.x[0] : w.x[n - 1], ez = m.atStart ? w.z[0] : w.z[n - 1];
  const d = Math.hypot(m.x - ex, m.z - ez);
  if (d < 0.05) return;
  const steps = Math.max(1, Math.ceil(d / 2)), u = m.atStart ? w.u[0] : w.u[n - 1];
  for (let q = 1; q <= steps; q++) {
    const f = q / steps, x = ex + (m.x - ex) * f, z = ez + (m.z - ez) * f;
    if (m.atStart) { w.x.unshift(x); w.z.unshift(z); w.k.unshift(0); w.u.unshift(u); }
    else { w.x.push(x); w.z.push(z); w.k.push(0); w.u.push(u); }
  }
}

// ---------- step 2: junction points, merged into nodes ----------

function findNodes(W, mods, issues) {
  const H = wayHash(W);
  const cuts = [];     // { x, z, w, s, end: 'a'|'b'|null }
  const crossings = [];
  const endCut = (w, s) => (w.closed ? null : s <= MERGE ? 'a' : s >= w.len - MERGE ? 'b' : null);
  const addCut = (w, s, x, z) => {
    const end = endCut(w, s);
    cuts.push({ x, z, w: w.ri, s: end === 'a' ? 0 : end === 'b' ? w.len : s, end });
  };

  // every open end is a node: a T where it joined another road, else a dead end
  const joined = new Set(mods.map(m => m.w.ri + (m.atStart ? 'a' : 'b')));
  for (const m of mods) {
    const w = m.w, s = m.atStart ? 0 : w.len, p = wayAt(w, s);
    addCut(w, s, p.x, p.z);
    const t = W[m.target], q = projectNear(H, t, p.x, p.z);
    addCut(t, q.s, q.x, q.z);
  }
  for (const w of W) {
    if (w.closed) continue;
    if (!joined.has(w.ri + 'a')) addCut(w, 0, w.x[0], w.z[0]);
    if (!joined.has(w.ri + 'b')) addCut(w, w.len, w.x[w.x.length - 1], w.z[w.z.length - 1]);
  }

  // every crossing of two roads is a node (an X unless it merges with a T). Most segments the hash offers
  // share a 32 m cell but not a bounding box, so that cheap test comes first, and a pair listed in two
  // cells is only tested once.
  const seen = new Set();
  for (const w of W) {
    const wx = w.x, wz = w.z, m = wx.length - 1;
    for (let j = 0; j < m; j++) {
      const x0 = Math.min(wx[j], wx[j + 1]), x1 = Math.max(wx[j], wx[j + 1]), z0 = Math.min(wz[j], wz[j + 1]), z1 = Math.max(wz[j], wz[j + 1]);
      H.query(x0, z0, x1, z1, (oi, oj) => {
        if (oi < w.ri) return;
        // a road's own neighbouring segments always touch; they are not a crossing
        if (oi === w.ri && (oj <= j + 1 || (w.closed && j === 0 && oj === m - 1))) return;
        const o = W[oi], ox = o.x, oz = o.z;
        if ((ox[oj] < x0 && ox[oj + 1] < x0) || (ox[oj] > x1 && ox[oj + 1] > x1) || (oz[oj] < z0 && oz[oj + 1] < z0) || (oz[oj] > z1 && oz[oj + 1] > z1)) return;
        const key = `${w.ri},${j},${oi},${oj}`;
        if (seen.has(key)) return;
        seen.add(key);
        const X = segX(wx[j], wz[j], wx[j + 1], wz[j + 1], ox[oj], oz[oj], ox[oj + 1], oz[oj + 1]);
        if (!X) return;
        // a road crossing itself is an authoring mistake: report it, never join it
        if (oi === w.ri) { issues.push({ type: 'self_crossing', road: w.id, x: X.x, z: X.z }); return; }
        const sa = w.s[j] + (w.s[j + 1] - w.s[j]) * X.t, sb = o.s[oj] + (o.s[oj + 1] - o.s[oj]) * X.u;
        addCut(w, sa, X.x, X.z); addCut(o, sb, X.x, X.z);
        crossings.push({ x: X.x, z: X.z, a: w.ri, sa, b: o.ri, sb });
      });
    }
  }

  // a closed road nothing joins still needs one node to hang its loop edge on
  for (const w of W) if (w.closed && !cuts.some(c => c.w === w.ri)) addCut(w, 0, w.x[0], w.z[0]);

  // merge points within MERGE of each other (union-find)
  const par = cuts.map((_, i) => i);
  const find = i => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; };
  const CH = makeHash(MERGE * 2);
  cuts.forEach((c, i) => CH.add(i, 0, c.x, c.z, c.x, c.z));
  cuts.forEach((c, i) => CH.query(c.x - MERGE, c.z - MERGE, c.x + MERGE, c.z + MERGE, j => {
    if (j > i && Math.hypot(cuts[j].x - c.x, cuts[j].z - c.z) < MERGE) par[find(j)] = find(i);
  }));
  const groups = new Map();
  cuts.forEach((c, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(c); });

  // one node per group, set on the centre line of its most important road; every road through it is cut
  // once, at its end if it ends there
  const nodes = [];
  for (const members of groups.values()) {
    let mx = 0, mz = 0;
    for (const c of members) { mx += c.x; mz += c.z; }
    mx /= members.length; mz /= members.length;
    const major = members.reduce((a, c) => (W[c.w].rank > W[a.w].rank || (W[c.w].rank === W[a.w].rank && !c.end && a.end) ? c : a));
    let x = mx, z = mz;
    const mw = W[major.w];
    if (!major.end) {
      const p = projectWay(mw, mx, mz, wayIndex(mw, major.s) - 8, wayIndex(mw, major.s) + 9);
      if (p.d <= MERGE) { x = p.x; z = p.z; }
    } else { const p = wayAt(mw, major.s); x = p.x; z = p.z; }
    const node = { id: nodes.length, x, z, cuts: new Map() };
    for (const c of members) {
      const prev = node.cuts.get(c.w);
      if (prev && (prev.end || !c.end)) continue;
      node.cuts.set(c.w, { s: c.s, end: c.end });
    }
    nodes.push(node);
  }
  // re-measure interior cuts against the node position, and catch roads that pass through a node
  // without having been cut there
  for (const node of nodes) {
    for (const [wi, c] of node.cuts) {
      if (c.end) continue;
      const w = W[wi], i = wayIndex(w, c.s);
      c.s = projectWay(w, node.x, node.z, i - 8, i + 9).s;
      if (w.closed && c.s >= w.len - 1e-6) c.s = 0;
    }
    H.query(node.x - MERGE, node.z - MERGE, node.x + MERGE, node.z + MERGE, (oi, oj) => {
      if (node.cuts.has(oi)) return;
      const w = W[oi], p = projSeg(w.x[oj], w.z[oj], w.x[oj + 1], w.z[oj + 1], node.x, node.z);
      if (p.d > MERGE) return;
      const s = w.s[oj] + (w.s[oj + 1] - w.s[oj]) * p.f, end = endCut(w, s);
      node.cuts.set(oi, { s: end === 'a' ? 0 : end === 'b' ? w.len : (w.closed && s >= w.len - 1e-6 ? 0 : s), end });
    });
  }

  // an X both roads have a control point at was authored; anything else is reported
  const nearCtrl = (w, x, z) => w.road.pts.some(p => Math.hypot(p[0] - x, p[1] - z) <= PLAN_R);
  for (const X of crossings) {
    const a = W[X.a], b = W[X.b];
    if (endCut(a, X.sa) || endCut(b, X.sb)) continue;
    if (!(nearCtrl(a, X.x, X.z) && nearCtrl(b, X.x, X.z)))
      issues.push({ type: 'unplanned_crossing', roads: [a.id, b.id], x: X.x, z: X.z });
  }
  return nodes;
}

// ---------- step 3: edges between nodes ----------

function splitWays(W, nodes) {
  const per = W.map(() => []);
  for (const node of nodes) for (const [wi, c] of node.cuts) per[wi].push({ s: c.s, node });
  const edges = [];
  for (const w of W) {
    const cuts = per[w.ri].sort((a, b) => a.s - b.s);
    const list = [];
    for (const c of cuts) if (!list.length || list[list.length - 1].node !== c.node) list.push(c);
    if (w.closed && list.length > 1 && list[0].node === list[list.length - 1].node) list.pop();
    const spans = [];
    if (w.closed) {
      for (let i = 0; i < list.length; i++) {
        const a = list[i], b = list[(i + 1) % list.length];
        spans.push([a, b, i + 1 < list.length ? b.s : b.s + w.len]);
      }
    } else {
      for (let i = 0; i + 1 < list.length; i++) spans.push([list[i], list[i + 1], list[i + 1].s]);
    }
    for (const [a, b, sb] of spans) {
      if (sb - a.s < 0.05) continue;
      edges.push(sliceEdge(w, a.s, sb, a.node, b.node, edges.length));
    }
  }
  return edges;
}

// The part of a way from station sa to sb (sb may run past the seam of a closed way), with its end points
// moved onto the nodes.
function sliceEdge(w, sa, sb, A, B, id) {
  const x = [A.x], z = [A.z], k = [wayAt(w, sa).k], u = [wayAt(w, sa).u];
  const n = w.x.length - (w.closed ? 1 : 0);
  const push = (i, s) => { if (s > sa + 0.3 && s < sb - 0.3) { x.push(w.x[i]); z.push(w.z[i]); k.push(w.k[i]); u.push(w.u[i]); } };
  for (let i = 0; i < n; i++) push(i, w.s[i]);
  if (w.closed && sb > w.len) for (let i = 0; i < n; i++) push(i, w.s[i] + w.len);
  const pb = wayAt(w, sb);
  x.push(B.x); z.push(B.z); k.push(pb.k); u.push(w.closed && sb >= w.len - 1e-6 && pb.u < 1e-6 ? w.road.pts.length : pb.u);
  const e = { id, way: w, road: w.id, name: w.name, cls: w.cls, a: A.id, b: B.id, x, z, k, u, rs: sa };
  const s = [0];
  for (let i = 1; i < x.length; i++) s.push(s[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]));
  e.s = s; e.len = s[s.length - 1];
  // frames from central differences, so a lane offset stays smooth across a kink (where a T extension
  // meets the authored curve)
  e.tx = []; e.tz = [];
  for (let i = 0; i < x.length; i++) {
    const a = Math.max(0, i - 1), b = Math.min(x.length - 1, i + 1);
    const dx = x[b] - x[a], dz = z[b] - z[a], l = Math.hypot(dx, dz) || 1;
    e.tx.push(dx / l); e.tz.push(dz / l);
  }
  return e;
}

// Point and unit tangent (interpolated between the sample frames) at station s of an edge in the build
// arrays (metres).
function edgeAt(e, s) {
  s = clamp(s, 0, e.len);
  let lo = 0, hi = e.s.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (e.s[m] <= s) lo = m; else hi = m; }
  const ds = e.s[hi] - e.s[lo], f = ds > 1e-9 ? (s - e.s[lo]) / ds : 0;
  const tx = e.tx[lo] + (e.tx[hi] - e.tx[lo]) * f, tz = e.tz[lo] + (e.tz[hi] - e.tz[lo]) * f, l = Math.hypot(tx, tz) || 1;
  return { x: e.x[lo] + (e.x[hi] - e.x[lo]) * f, z: e.z[lo] + (e.z[hi] - e.z[lo]) * f, tx: tx / l, tz: tz / l, i: lo };
}

// ---------- step 4: node shape, lanes and connectors ----------

// Each node lists its edge ends with the direction leaving the node (sampled up to 15 m out, so the short
// straight a T extension adds does not decide the angle).
function nodeEnds(nodes, edges) {
  for (const n of nodes) n.ends = [];
  for (const e of edges) {
    for (const start of [true, false]) {
      const N = nodes[start ? e.a : e.b], d = Math.min(15, e.len * 0.5);
      const p = edgeAt(e, start ? d : e.len - d);
      let ux = p.x - N.x, uz = p.z - N.z;
      const l = Math.hypot(ux, uz) || 1;
      ux /= l; uz /= l;
      N.ends.push({ e: e.id, start, ux, uz, ang: Math.atan2(uz, ux), trim: 0 });
    }
  }
}

// How far each edge's lanes stop short of the node: clear of every other road's pavement at the angle it
// meets (roads carrying straight on are ignored), plus a metre. Dead ends keep room for a U-turn.
function nodeTrims(nodes, edges) {
  for (const N of nodes) {
    for (const E of N.ends) {
      const e = edges[E.e], hw = e.P.halfW;
      let t = 0;
      if (N.ends.length === 1) t = Math.max(4, 2 * e.P.laneW);
      else {
        for (const O of N.ends) {
          if (O === E) continue;
          const cos = E.ux * O.ux + E.uz * O.uz;
          if (cos < Math.cos(TURN_U)) continue;
          const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
          t = Math.max(t, (edges[O.e].P.halfW + hw * Math.abs(cos)) / Math.max(sin, 0.3));
        }
        t = Math.max(1.5, t + 1);
      }
      E.trim = Math.min(t, 30, e.len * 0.45);
    }
  }
}

function buildLanes(nodes, edges) {
  const lanes = [];
  for (const e of edges) {
    const P = e.P, n = P.lanes;
    const trimA = nodes[e.a].ends.find(E => E.e === e.id && E.start).trim;
    const trimB = nodes[e.b].ends.find(E => E.e === e.id && !E.start).trim;
    e.trimA = trimA; e.trimB = trimB;
    e.fwd = []; e.bwd = [];
    for (const dir of e.oneway ? [1] : [1, -1]) {
      for (let i = 0; i < n; i++) {
        // two-way: lane i sits median/2 + (i + .5) laneW right of the centre line for its own direction;
        // one-way: the lanes are centred on the road
        const off = e.oneway ? (i + 0.5 - n / 2) * P.laneW : dir * (P.median / 2 + (i + 0.5) * P.laneW);
        const L = laneLine(e, off, trimA, e.len - trimB, dir);
        L.id = lanes.length; L.edge = e.id; L.dir = dir; L.i = i; L.off = off;
        L.a = dir > 0 ? e.a : e.b; L.b = dir > 0 ? e.b : e.a;
        L.next = []; L.prev = []; L.cars = [];
        lanes.push(L);
        (dir > 0 ? e.fwd : e.bwd).push(L.id);
      }
    }
    // neighbours for lane changes: lane i-1 is on the left, i+1 on the right
    for (const side of [e.fwd, e.bwd]) side.forEach((id, i) => { lanes[id].left = side[i - 1] ?? -1; lanes[id].right = side[i + 1] ?? -1; });
  }
  return lanes;
}

// The lane's polyline between edge stations sa and sb, offset `off` to the edge's right, in travel order.
function laneLine(e, off, sa, sb, dir) {
  const xs = [], zs = [], es = [];
  const add = s => { const p = edgeAt(e, s); xs.push(p.x - p.tz * off); zs.push(p.z + p.tx * off); es.push(s); };
  add(sa);
  // interior samples sit exactly on the edge's own frames, so they need no search
  for (let i = 1; i < e.s.length - 1; i++) {
    if (!(e.s[i] > sa + 0.2 && e.s[i] < sb - 0.2)) continue;
    const l = Math.hypot(e.tx[i], e.tz[i]) || 1, tx = e.tx[i] / l, tz = e.tz[i] / l;
    xs.push(e.x[i] - tz * off); zs.push(e.z[i] + tx * off); es.push(e.s[i]);
  }
  add(Math.max(sb, sa));
  if (dir < 0) { xs.reverse(); zs.reverse(); es.reverse(); }
  const s = [0];
  for (let i = 1; i < xs.length; i++) s.push(s[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]));
  const t0 = edgeAt(e, dir > 0 ? sa : sb), t1 = edgeAt(e, dir > 0 ? sb : sa);
  return { x: xs, z: zs, es, s, len: s[s.length - 1], t0: [t0.tx * dir, t0.tz * dir], t1: [t1.tx * dir, t1.tz * dir] };
}

// Connectors join every lane arriving at a node to the lanes it may turn into: straight on lane for lane,
// right turns from the outer lane, left turns from the inner lane. A lane with no way on (a dead end)
// gets a U-turn into the opposite lane.
function buildConns(nodes, edges, lanes) {
  const conns = [];
  const make = (N, li, lo, turn, trim) => {
    const A = lanes[li], B = lanes[lo];
    const p0 = [A.x[A.x.length - 1], A.z[A.z.length - 1]], p3 = [B.x[0], B.z[0]];
    const gap = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
    const bz = bezier(p0, A.t1, p3, B.t0, 1, turn === 'u' ? Math.max(gap / 3, trim * 0.75) : undefined);
    const c = { id: conns.length, node: N.id, from: li, to: lo, x: bz.x, z: bz.z, s: bz.s, len: bz.len, turn, conflicts: null, yield: false };
    conns.push(c); A.next.push(c.id); B.prev.push(c.id);
  };
  for (const N of nodes) {
    for (const I of N.ends) {
      const ei = edges[I.e], inL = I.start ? ei.bwd : ei.fwd;
      if (!inL.length) continue;
      for (const O of N.ends) {
        if (O === I) continue;
        const eo = edges[O.e], outL = O.start ? eo.fwd : eo.bwd;
        if (!outL.length) continue;
        const d = wrapPI(O.ang - (I.ang + Math.PI));
        if (Math.abs(d) >= TURN_U) continue;
        const turn = Math.abs(d) <= TURN_S ? 's' : d > 0 ? 'r' : 'l';
        if (turn === 's') {
          const seen = new Set();
          for (let i = 0; i < Math.max(inL.length, outL.length); i++) {
            const a = inL[Math.min(i, inL.length - 1)], b = outL[Math.min(i, outL.length - 1)];
            if (!seen.has(a + ':' + b)) { seen.add(a + ':' + b); make(N, a, b, 's'); }
          }
        } else if (turn === 'r') make(N, inL[inL.length - 1], outL[outL.length - 1], 'r');
        else make(N, inL[0], outL[0], 'l');
      }
    }
    // where lane counts differ (two lanes turning into one, one into two) a lane can be left without a
    // way in or out here: it copies the movement of the lane beside it
    for (const E of N.ends) {
      const e = edges[E.e];
      for (const li of E.start ? e.fwd : e.bwd) {
        const D = lanes[li];
        if (D.prev.some(c => conns[c].node === N.id)) continue;
        const sib = [D.left, D.right].find(s => s >= 0 && lanes[s].prev.some(c => conns[c].node === N.id));
        if (sib != null) { const c = conns[lanes[sib].prev.find(c => conns[c].node === N.id)]; make(N, c.from, li, c.turn); }
      }
      for (const li of E.start ? e.bwd : e.fwd) {
        const A = lanes[li];
        if (A.next.length) continue;
        const sib = [A.left, A.right].find(s => s >= 0 && lanes[s].next.length);
        if (sib != null) { const c = conns[lanes[sib].next[0]]; make(N, li, c.to, c.turn); }
      }
    }
    for (const I of N.ends) {
      const ei = edges[I.e], inL = I.start ? ei.bwd : ei.fwd, back = I.start ? ei.fwd : ei.bwd;
      for (const li of inL) if (!lanes[li].next.length && back.length) make(N, li, back[0], 'u', I.trim);
    }
  }
  return conns;
}

// Two connectors through the same node conflict when they end in the same lane or their paths cross;
// connectors leaving the same lane never do (that lane's queue already orders them).
function conflicts(nodes, conns) {
  const at = nodes.map(() => []);
  for (const c of conns) at[c.node].push(c);
  const ids = conns.map(() => []);
  for (const list of at) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.from === b.from) continue;
      if (a.to === b.to || pathsCross(a, b)) { ids[a.id].push(b.id); ids[b.id].push(a.id); }
    }
  }
  const Arr = conns.length < 32768 ? Int16Array : Int32Array;
  for (const c of conns) c.conflicts = Arr.from(ids[c.id]);
}

function pathsCross(a, b) {
  for (let i = 0; i + 1 < a.x.length; i++) for (let j = 0; j + 1 < b.x.length; j++) {
    if (Math.max(a.x[i], a.x[i + 1]) < Math.min(b.x[j], b.x[j + 1]) || Math.max(b.x[j], b.x[j + 1]) < Math.min(a.x[i], a.x[i + 1])) continue;
    if (Math.max(a.z[i], a.z[i + 1]) < Math.min(b.z[j], b.z[j + 1]) || Math.max(b.z[j], b.z[j + 1]) < Math.min(a.z[i], a.z[i + 1])) continue;
    if (segX(a.x[i], a.z[i], a.x[i + 1], a.z[i + 1], b.x[j], b.z[j], b.x[j + 1], b.z[j + 1])) return true;
  }
  return false;
}

// ---------- step 5: who goes first ----------
// A node whose two highest-ranked ends outrank every other end is a priority junction (the Loop, the ring,
// Deco Ave ...): the other approaches yield, and so do left turns off the major road. Junctions of equal
// roads are all-way reservations. Signal candidates stay on their fallback until signals are switched on.
function controls(nodes, edges, signals, signalsOn) {
  for (const N of nodes) {
    const m = N.ends.length;
    N.kind = m === 1 ? 'end' : m === 2 ? 'corner' : m === 3 ? 'T' : 'X';
    if (m >= 3 && N.ends.some(E => edges[E.e].cls === 'ring')) N.kind = 'ring';
    N.major = [];
    if (m <= 2) N.fallback = 'none';
    else {
      const ranks = N.ends.map(E => edges[E.e].way.rank), top = Math.max(...ranks);
      const tops = N.ends.filter((E, i) => ranks[i] === top);
      N.fallback = tops.length === 2 ? 'priority' : 'allway';
      if (N.fallback === 'priority') N.major = tops.map(E => N.ends.indexOf(E));
    }
    N.signal = m >= 3 && signals.some(([x, z]) => Math.hypot(x - N.x, z - N.z) <= 8);
    N.control = N.signal && signalsOn ? 'signal' : N.fallback;
    N.phase = hash01(N.id * 7919 + 17) * CYCLE;
    // signal groups: the first end and the end most opposite it share phase 0, the rest phase 1
    N.groups = N.ends.map(() => 1);
    if (m >= 3) {
      N.groups[0] = 0;
      let best = -1, bc = 2;
      N.ends.forEach((E, i) => { if (i) { const c = E.ux * N.ends[0].ux + E.uz * N.ends[0].uz; if (c < bc) { bc = c; best = i; } } });
      if (bc < -0.5) N.groups[best] = 0;
    }
  }
}

function yields(nodes, edges, lanes, conns) {
  for (const c of conns) {
    const N = nodes[c.node], A = lanes[c.from];
    const endIdx = N.ends.findIndex(E => E.e === A.edge && E.start === (A.dir < 0));
    if (N.control === 'priority') c.yield = !N.major.includes(endIdx) || c.turn === 'l';
    else if (N.control === 'signal') c.yield = c.turn === 'l';
    else c.yield = false;
  }
}

// ---------- step 6: sidewalks ----------
// Each side of a road with a walk gets a path at halfW + walk/2. At a node, the two sidewalks either side
// of each corner are cut back to where they meet and joined by a short curve; a sidewalk whose neighbour
// road has none (a highway, a dirt track) stops at that road's edge. Crosswalks span each approach at
// signal (and signal-candidate) and all-way nodes (spec §9 Peds) that has a sidewalk on both sides.
//
// A road may give one side its own sidewalk: walkL / walkR (m, 0 = none) override walk on the left or right
// of the road's direction. The grid's perimeter streets use it, because their outer side is the map edge.
// Edge sides here: 1 = right of the edge's direction, -1 = left.
const walkOf = (P, side) => (side > 0 ? P.walkR : P.walkL) ?? P.walk ?? 0;

function buildWalks(nodes, edges) {
  const trim = new Map(), links = [];
  const key = (e, side, start) => `${e}:${side}:${start ? 0 : 1}`;
  const off = (e, side) => { const w = walkOf(e.P, side); return w > 0 ? e.P.halfW + w / 2 : 0; };
  const setTrim = (k, t) => trim.set(k, Math.max(trim.get(k) || 0, t));
  for (const N of nodes) {
    const ends = [...N.ends].sort((a, b) => a.ang - b.ang), m = ends.length;
    if (m < 2) continue;
    for (let i = 0; i < m; i++) {
      const A = ends[i], B = ends[(i + 1) % m];
      let phi = B.ang - A.ang;
      if (phi <= 1e-9) phi += TAU;
      const sA = A.start ? 1 : -1, sB = B.start ? -1 : 1;     // A's right and B's left, as edge sides
      const eA = edges[A.e], eB = edges[B.e], wA = off(eA, sA), wB = off(eB, sB);
      if (!wA && !wB) continue;
      let tA = CORNER_R, tB = CORNER_R;
      if (phi < Math.PI - 0.15) {
        // where A's right-hand line meets B's left-hand line (a road without a walk offers its kerb)
        const la = wA || eA.P.halfW + 0.5, lb = wB || eB.P.halfW + 0.5;
        const cx = B.uz * lb - (-A.uz * la), cz = -B.ux * lb - (A.ux * la);
        const det = -A.ux * B.uz + B.ux * A.uz;
        if (Math.abs(det) > 1e-6) {
          tA += Math.max(0, (-cx * B.uz + B.ux * cz) / det);
          tB += Math.max(0, (A.ux * cz - A.uz * cx) / det);
        }
      }
      if (wA) setTrim(key(A.e, sA, A.start), Math.min(tA, 30, eA.len * 0.45));
      if (wB) setTrim(key(B.e, sB, B.start), Math.min(tB, 30, eB.len * 0.45));
      if (wA && wB) links.push({ N, A, B, ka: key(A.e, sA, A.start), kb: key(B.e, sB, B.start) });
    }
  }

  const paths = [], verts = [], vOf = new Map();
  const vert = (k, x, z) => { let v = vOf.get(k); if (v == null) { v = verts.length; verts.push({ id: v, x, z, paths: [] }); vOf.set(k, v); } return v; };
  const addPath = (xs, zs, a, b, cross, edge, side) => {
    const s = [0];
    for (let i = 1; i < xs.length; i++) s.push(s[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]));
    const p = { id: paths.length, x: xs, z: zs, s, len: s[s.length - 1], a, b, cross, edge, side };
    paths.push(p); verts[a].paths.push(p.id); verts[b].paths.push(p.id);
    return p;
  };
  const tan = new Map();   // vertex key -> unit direction pointing along the sidewalk away from its node
  for (const e of edges) {
    for (const side of [1, -1]) {
      const w = off(e, side);
      if (!w) continue;
      const ta = trim.get(key(e.id, side, true)) || 0, tb = trim.get(key(e.id, side, false)) || 0;
      let sa = ta, sb = e.len - tb;
      if (sb < sa + 0.5) sa = sb = (sa + sb) / 2;
      const xs = [], zs = [];
      const add = s => { const p = edgeAt(e, s); xs.push(p.x - p.tz * w * side); zs.push(p.z + p.tx * w * side); };
      add(sa);
      for (let i = 1; i < e.s.length - 1; i++) if (e.s[i] > sa + 0.2 && e.s[i] < sb - 0.2) add(e.s[i]);
      add(sb);
      const ka = key(e.id, side, true), kb = key(e.id, side, false);
      const a = vert(ka, xs[0], zs[0]), b = vert(kb, xs[xs.length - 1], zs[zs.length - 1]);
      const pa = edgeAt(e, sa), pb = edgeAt(e, sb);
      tan.set(ka, [pa.tx, pa.tz]); tan.set(kb, [-pb.tx, -pb.tz]);
      addPath(xs, zs, a, b, false, e.id, side);
    }
  }
  for (const L of links) {
    const a = vOf.get(L.ka), b = vOf.get(L.kb);
    if (a == null || b == null || a === b) continue;
    const ta = tan.get(L.ka), tb = tan.get(L.kb);
    const bz = bezier([verts[a].x, verts[a].z], [-ta[0], -ta[1]], [verts[b].x, verts[b].z], tb, 1);
    addPath(Array.from(bz.x), Array.from(bz.z), a, b, false, -1, 0);
  }
  for (const N of nodes) {
    if (!(N.control === 'signal' || N.control === 'allway' || N.signal)) continue;
    for (const E of N.ends) {
      const a = vOf.get(key(E.e, 1, E.start)), b = vOf.get(key(E.e, -1, E.start));
      if (a == null || b == null) continue;
      addPath([verts[a].x, verts[b].x], [verts[a].z, verts[b].z], a, b, true, E.e, 0);
    }
  }
  return { paths, verts, zones: [] };
}

// ---------- step 7: heights, banking and decks ----------

// Authored y pins [ctrlIndex, y] interpolate by control parameter (wrapping on closed roads); stations
// outside the pins follow the terrain, or the nearest pin when there is no terrain yet.
function pinHeight(w, u, x, z, heightAt) {
  const pins = w.pins;
  if (!pins) return heightAt ? heightAt(x, z) : 0;
  const n = w.road.pts.length, first = pins[0], last = pins[pins.length - 1];
  if (w.closed) {
    let a = null, b = null;
    if (u < first[0]) { a = [last[0] - n, last[1]]; b = first; }
    else if (u > last[0]) { a = last; b = [first[0] + n, first[1]]; }
    if (a) return a[1] + (b[1] - a[1]) * (b[0] > a[0] ? (u - a[0]) / (b[0] - a[0]) : 0);
  } else if (u < first[0] - 1e-6 || u > last[0] + 1e-6) {
    return heightAt ? heightAt(x, z) : (u < first[0] ? first[1] : last[1]);
  }
  for (let i = 0; i + 1 < pins.length; i++) {
    const [u0, y0] = pins[i], [u1, y1] = pins[i + 1];
    if (u >= u0 - 1e-6 && u <= u1 + 1e-6) return y0 + (y1 - y0) * (u1 > u0 ? (u - u0) / (u1 - u0) : 0);
  }
  return last[1];
}

// Stations whose terrain is below sea level + 0.3 m are bridge deck, plus 6 m abutments (spec §4.5).
function deckSpans(e, heightAt, seaLevel) {
  const spans = [];
  let s0 = null;
  for (let i = 0; i < e.x.length; i++) {
    const wet = heightAt(e.x[i], e.z[i]) < seaLevel + 0.3;
    if (wet && s0 == null) s0 = e.s[i];
    if (!wet && s0 != null) { spans.push([s0, e.s[i - 1]]); s0 = null; }
  }
  if (s0 != null) spans.push([s0, e.len]);
  const out = [];
  for (const [a, b] of spans) {
    const lo = Math.max(0, a - 6), hi = Math.min(e.len, b + 6);
    if (out.length && lo <= out[out.length - 1][1]) out[out.length - 1][1] = hi; else out.push([lo, hi]);
  }
  return out;
}

// ---------- the RoadNet ----------

// roads: [{id, name, cls, pts:[[x,z]...] (m), closed?, oneway?, y?:[[ctrlIndex, y]...], minR?, ai?, speed?,
//          walkL?, walkR? (one side's sidewalk width, m), ...}]
// classes: {cls: {lanes, laneW, median, walk, halfW, speed (m/s), bank (deg), ai, oneway?, single?, chord?}}
// opts: heightAt(x,z) -> m (natural terrain, for heights and decks), snap (m, an end this close to another
// road joins it), px (px per m), seaLevel, signals [[x,z]...] (candidate nodes, m), signalsOn, priority
// (road ids that keep priority over any other road, like a road's own priority flag),
// profile(edge, net) (fills edge.gy after the default), strict (throw on an X on a highway or deck),
// into (an object to fill in place, so a world's exported container stays the same object).
//
// snap defaults to 16 m, not the spec's 15: the Rickenbacker ends 15.6 m from the Key Loop (§4.3), and at
// 15 m the key would be cut off from the rest of the network.
export function buildRoadNet(roads, classes = {}, opts = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { heightAt = null, snap = 16, px = 16, seaLevel = -1, signals = [], signalsOn = false, strict = true, profile = null, priority = [] } = opts;
  const issues = [];

  const W = roads.map((r, i) => makeWay(r, i, classes));
  for (const w of W) if (priority.includes(w.id) && !w.P.priority) w.rank += 10;
  for (const w of W) if (w.road.y && w.road.y.length) w.pins = [...w.road.y].sort((a, b) => a[0] - b[0]);
  const mods = snapEnds(W, snap);
  const nodes = findNodes(W, mods, issues);
  const edges = splitWays(W, nodes);
  for (const e of edges) { e.P = e.way.P; e.oneway = e.way.oneway; }
  nodeEnds(nodes, edges);
  nodeTrims(nodes, edges);
  const lanes = buildLanes(nodes, edges);
  const conns = buildConns(nodes, edges, lanes);
  controls(nodes, edges, signals, signalsOn);
  conflicts(nodes, conns);
  yields(nodes, edges, lanes, conns);
  const walks = buildWalks(nodes, edges);

  // heights in metres along each edge, and deck spans where the road crosses water
  for (const e of edges) {
    e.gy = new Float32Array(e.x.length);
    for (let i = 0; i < e.x.length; i++) e.gy[i] = pinHeight(e.way, e.u[i], e.x[i], e.z[i], heightAt);
    e.deck = heightAt ? deckSpans(e, heightAt, seaLevel) : [];
  }

  // a highway may only have T junctions, and nothing may cross on a bridge deck (spec §6.3)
  for (const N of nodes) {
    if (N.ends.length < 4) continue;
    const hwy = N.ends.find(E => edges[E.e].cls === 'hwy');
    if (hwy) issues.push({ type: 'hwy_x', fatal: true, node: N.id, roads: [...new Set(N.ends.map(E => edges[E.e].road))], x: N.x, z: N.z });
    const onDeck = N.ends.find(E => edges[E.e].deck.some(([a, b]) => (E.start ? a <= 0.5 : b >= edges[E.e].len - 0.5)));
    if (onDeck) issues.push({ type: 'deck_x', fatal: true, node: N.id, roads: [...new Set(N.ends.map(E => edges[E.e].road))], x: N.x, z: N.z });
  }
  for (const L of lanes) if (!L.next.length) issues.push({ type: 'dead_lane', lane: L.id, road: edges[L.edge].road });
  const fatal = issues.filter(i => i.fatal);
  if (fatal.length && strict) throw new Error('roadnet: ' + fatal.map(i => `${i.type} at (${i.x.toFixed(0)},${i.z.toFixed(0)}) on ${i.roads.join('/')}`).join('; '));

  const net = opts.into || {};
  finish(net, { W, nodes, edges, lanes, conns, walks, px, issues, signalsOn });
  for (const e of net.edges) if (profile) profile(e, net);
  net.updateProfiles();
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  net.stats = { nodes: net.nodes.length, edges: net.edges.length, lanes: net.lanes.length, conns: net.conns.length,
    walks: net.walks.paths.length, ms: t1 - t0 };
  return net;
}

// Scale everything to px, freeze it into typed arrays and attach the queries.
function finish(net, { W, nodes, edges, lanes, conns, walks, px, issues, signalsOn }) {
  const F = a => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] * px; return o; };
  const nodesOut = nodes.map(N => ({
    id: N.id, x: N.x * px, y: N.z * px, gy: 0, kind: N.kind, control: N.control, fallback: N.fallback, signal: N.signal,
    edges: [...new Set(N.ends.map(E => E.e))], phase: N.phase, groups: N.groups, major: N.major,
    ends: N.ends.map(E => ({ e: E.e, start: E.start, a: E.ang, trim: E.trim * px })),
  }));
  const edgesOut = edges.map(e => {
    const P = e.P, n = e.x.length, tx = Float32Array.from(e.tx), ty = Float32Array.from(e.tz);
    return {
      id: e.id, road: e.road, name: e.name, cls: e.cls, a: e.a, b: e.b, n,
      x: F(e.x), y: F(e.z), s: F(e.s), tx, ty, k: Float32Array.from(e.k, v => v / px), u: Float32Array.from(e.u), gy: e.gy,
      bank: new Float32Array(Math.floor(e.len / 2) + 1), len: e.len * px,
      lanesF: e.fwd.length, lanesB: e.bwd.length, laneW: P.laneW * px, halfW: P.halfW * px,
      // sidewalk widths: walkW is the wider side (the §7 field), walkL / walkR each side (0 = none)
      walkW: Math.max(walkOf(P, -1), walkOf(P, 1)) * px, walkL: walkOf(P, -1) * px, walkR: walkOf(P, 1) * px,
      median: (P.median || 0) * px, speed: P.speed * px, bankMax: (P.bank || 0) * Math.PI / 180, ai: P.ai !== false,
      deck: e.deck.map(([a, b]) => [a * px, b * px]), oneway: e.oneway, single: !!P.single, rank: e.way.rank,
      fwd: e.fwd, bwd: e.bwd, trimA: e.trimA * px, trimB: e.trimB * px, rs: e.rs * px,
      // traffic may change lanes only on multi-lane roads (hwy and blvd, spec §9)
      laneChange: P.lanes > 1 && !P.single,
    };
  });
  const lanesOut = lanes.map(L => ({
    id: L.id, edge: L.edge, dir: L.dir, i: L.i, off: L.off * px, len: L.len * px, a: L.a, b: L.b,
    next: L.next, prev: L.prev, left: L.left, right: L.right, cars: L.cars, n: L.x.length, x: F(L.x), y: F(L.z), s: F(L.s), es: F(L.es),
  }));
  const connsOut = conns.map(c => ({
    id: c.id, node: c.node, from: c.from, to: c.to, n: c.x.length, x: F(c.x), y: F(c.z), s: F(c.s), len: c.len * px,
    turn: c.turn, conflicts: c.conflicts, yield: c.yield,
  }));
  const walksOut = {
    paths: walks.paths.map(p => {
      const pts = new Float32Array(p.x.length * 2);
      for (let i = 0; i < p.x.length; i++) { pts[2 * i] = p.x[i] * px; pts[2 * i + 1] = p.z[i] * px; }
      return { id: p.id, pts, n: p.x.length, s: F(p.s), len: p.len * px, a: p.a, b: p.b, cross: p.cross, edge: p.edge, side: p.side };
    }),
    verts: walks.verts.map(v => ({ id: v.id, x: v.x * px, y: v.z * px, paths: v.paths })),
    zones: [],
  };
  const roadIndex = {};
  for (const w of W) roadIndex[w.id] = { id: w.id, name: w.name, cls: w.cls, closed: w.closed, len: w.len * px, edges: [] };
  for (const e of edgesOut) roadIndex[e.road].edges.push(e.id);

  // fill arrays the container already has, so anything holding them sees the network
  const put = (k, v) => { if (Array.isArray(net[k])) { net[k].length = 0; for (const x of v) net[k].push(x); } else net[k] = v; };
  put('nodes', nodesOut); put('edges', edgesOut); put('lanes', lanesOut); put('conns', connsOut);
  net.walks = walksOut; net.roadIndex = roadIndex; net.issues = issues; net.px = px;
  net.clock = 0; net.signalsOn = signalsOn;
  attachQueries(net);
}

// ---------- queries (all in px) ----------

function attachQueries(net) {
  const { nodes, edges, lanes, conns, walks, px } = net;
  const H = makeHash(CELL * px);
  for (const e of edges) for (let j = 0; j + 1 < e.n; j++) H.add(e.id, j, e.x[j], e.y[j], e.x[j + 1], e.y[j + 1]);
  const WH = makeHash(CELL * px);
  for (const p of walks.paths) for (let j = 0; j + 1 < p.n; j++) WH.add(p.id, j, p.pts[2 * j], p.pts[2 * j + 1], p.pts[2 * j + 2], p.pts[2 * j + 3]);
  net.hash = H;

  // Search the hash in growing rings of cells until no closer segment can exist.
  function ringSearch(hash, x, y, maxD, test) {
    const cell = hash.cell, b = hash.bounds();
    if (b.x0 > b.x1) return;
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    const far = Math.max(Math.abs(cx - b.x0), Math.abs(cx - b.x1), Math.abs(cy - b.y0), Math.abs(cy - b.y1));
    const rMax = Math.min(far, Math.ceil(maxD / cell) + 1);
    let best = Infinity;
    for (let r = 0; r <= rMax; r++) {
      for (let j = cy - r; j <= cy + r; j++) for (let i = cx - r; i <= cx + r; i++) {
        if (Math.max(Math.abs(i - cx), Math.abs(j - cy)) !== r) continue;
        const a = hash.at(i, j);
        if (a) for (let q = 0; q < a.length; q += 2) best = Math.min(best, test(a[q], a[q + 1]));
      }
      if (best <= r * cell) break;
    }
  }

  const segProj = (e, j, x, y) => {
    const ax = e.x[j], ay = e.y[j], dx = e.x[j + 1] - ax, dy = e.y[j + 1] - ay, L2 = dx * dx + dy * dy;
    const f = L2 > 1e-9 ? clamp(((x - ax) * dx + (y - ay) * dy) / L2, 0, 1) : 0;
    const qx = ax + dx * f, qy = ay + dy * f;
    return { f, x: qx, y: qy, d: Math.hypot(x - qx, y - qy), side: ((x - qx) * -dy + (y - qy) * dx) >= 0 ? 1 : -1 };
  };

  // The closest point on any edge centre line: { edge, i, s, x, y, d, side } or null.
  net.nearest = (x, y, { maxD = Infinity, ai = false } = {}) => {
    let best = null;
    ringSearch(H, x, y, maxD, (ei, j) => {
      const e = edges[ei];
      if (ai && !e.ai) return best ? best.d : Infinity;
      const p = segProj(e, j, x, y);
      if (p.d <= maxD && (!best || p.d < best.d)) best = { edge: ei, i: j, s: e.s[j] + (e.s[j + 1] - e.s[j]) * p.f, x: p.x, y: p.y, d: p.d, side: p.side };
      return best ? best.d : Infinity;
    });
    return best;
  };

  // Calls fn(edge) once for every edge with a segment within r of (x, y).
  net.edgesNear = (x, y, r, fn) => {
    const seen = new Set();
    H.query(x - r, y - r, x + r, y + r, (ei, j) => {
      if (seen.has(ei)) return;
      if (segProj(edges[ei], j, x, y).d <= r) { seen.add(ei); fn(edges[ei]); }
    });
  };

  // Lane station for an edge station (lanes keep the edge station of every point in es).
  const laneS = (L, es) => {
    const n = L.n, inc = L.es[n - 1] >= L.es[0];
    const lo0 = inc ? L.es[0] : L.es[n - 1], hi0 = inc ? L.es[n - 1] : L.es[0];
    if (es <= lo0) return inc ? 0 : L.len;
    if (es >= hi0) return inc ? L.len : 0;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if ((L.es[m] <= es) === inc) lo = m; else hi = m; }
    const d = L.es[hi] - L.es[lo], f = Math.abs(d) > 1e-9 ? (es - L.es[lo]) / d : 0;
    return L.s[lo] + (L.s[hi] - L.s[lo]) * f;
  };
  net.laneStation = (laneId, edgeS) => laneS(lanes[laneId], edgeS);

  // The lane that best fits a position and (optionally) a heading: { lane, s, x, y, d } or null.
  net.nearestLane = (x, y, a) => {
    let best = null;
    const near = net.nearest(x, y, { maxD: 40 * px });
    if (!near) return null;
    net.edgesNear(x, y, near.d + 8 * px, e => {
      let p = null;
      for (let j = 0; j + 1 < e.n; j++) { const q = segProj(e, j, x, y); if (!p || q.d < p.d) { p = q; p.j = j; } }
      const lat = p.d * p.side, es = e.s[p.j] + (e.s[p.j + 1] - e.s[p.j]) * p.f;
      const hdg = Math.atan2(e.ty[p.j], e.tx[p.j]);
      for (const id of [...e.fwd, ...e.bwd]) {
        const L = lanes[id];
        let score = Math.abs(lat - L.off);
        if (a != null) score += Math.abs(wrapPI(a - (L.dir > 0 ? hdg : hdg + Math.PI))) * 2 * px;
        if (!best || score < best.score) best = { lane: id, score, es };
      }
    });
    if (!best) return null;
    const s = laneS(lanes[best.lane], best.es), q = net.lanePoint(best.lane, s);
    return { lane: best.lane, s, x: q.x, y: q.y, d: Math.hypot(q.x - x, q.y - y) };
  };

  // Point on a polyline (x, y, s arrays) at station s: { x, y, a, tx, ty, i }.
  const along = (P, s, out) => {
    const n = P.n;
    s = clamp(s, 0, P.s[n - 1]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P.s[m] <= s) lo = m; else hi = m; }
    if (n < 2) { out.x = P.x[0]; out.y = P.y[0]; out.tx = 1; out.ty = 0; out.a = 0; out.i = 0; return out; }
    const ds = P.s[hi] - P.s[lo], f = ds > 1e-9 ? (s - P.s[lo]) / ds : 0;
    const dx = P.x[hi] - P.x[lo], dy = P.y[hi] - P.y[lo], l = Math.hypot(dx, dy);
    out.x = P.x[lo] + dx * f; out.y = P.y[lo] + dy * f;
    if (l > 1e-6) { out.tx = dx / l; out.ty = dy / l; } else { out.tx = out.tx ?? 1; out.ty = out.ty ?? 0; }
    out.a = Math.atan2(out.ty, out.tx); out.i = lo; out.s = s;
    return out;
  };
  net.lanePoint = (id, s, out = {}) => along(lanes[id], s, out);
  net.connPoint = (id, s, out = {}) => along(conns[id], s, out);

  // ---- routing: A* over carriageways (an edge in one direction), so a car may use any of its lanes ----
  let adj = null;
  const cwOf = L => L.edge * 2 + (L.dir > 0 ? 0 : 1);
  const buildAdj = () => {
    adj = edges.map(() => [[], []]).flat();
    for (const c of conns) {
      const A = lanes[c.from], B = lanes[c.to], list = adj[cwOf(A)], to = cwOf(B);
      const old = list.find(o => o.to === to);
      if (!old) list.push({ to, conn: c.id });
      else if (c.len < conns[old.conn].len) old.conn = c.id;
    }
  };
  const cwLanes = cw => (cw & 1 ? edges[cw >> 1].bwd : edges[cw >> 1].fwd);
  const cwEnd = cw => nodes[cw & 1 ? edges[cw >> 1].a : edges[cw >> 1].b];
  const vmax = () => edges.reduce((m, e) => Math.max(m, e.speed), 1);

  // A point inside a junction (within an edge's lane trim of its node) starts or ends at that node, so a
  // route to a junction centre arrives through it instead of turning into whichever edge was nearest.
  const nodeAt = P => { const e = edges[P.edge]; return P.s <= e.trimA ? e.a : P.s >= e.len - e.trimB ? e.b : -1; };

  // Turning costs a little (metres, or seconds when timing), so a route keeps to a road rather than
  // zig-zagging across a grid whose turn connectors cut the corners.
  const TURN_COST_M = { s: 0, r: 3, l: 6, u: 25 }, TURN_COST_S = { s: 0, r: 1, l: 2, u: 8 };

  function search(x0, y0, x1, y1, { ai = false, time = false } = {}) {
    const A = net.nearest(x0, y0, { ai }), B = net.nearest(x1, y1, { ai });
    if (!A || !B) return null;
    if (!adj) buildAdj();
    const ea = edges[A.edge], eb = edges[B.edge], V = time ? vmax() : 1;
    const an = nodeAt(A), bn = nodeAt(B);
    const per = (len, e) => (time ? len / e.speed : len);
    const full = cw => per(lanes[cwLanes(cw)[0]].len, edges[cw >> 1]);
    const N = edges.length * 2, g = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), via = new Int32Array(N).fill(-1);
    const heap = [];
    const push = (f, cw) => { heap.push([f, cw]); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    const h = cw => { const n = cwEnd(cw); return Math.hypot(n.x - x1, n.y - y1) / V; };
    const r = { A, B, an, bn, chain: null, cost: Infinity };
    // start and goal in the same junction: both are its centre, so there is nothing to drive
    if (an >= 0 && an === bn) { r.chain = []; r.cost = 0; return r; }
    let best = { cost: Infinity, cw: -1, from: -1, conn: -1 };
    const goalCost = cw => per(cw & 1 ? eb.len - B.s : B.s, eb);
    const atGoal = (cw, ge, from, conn) => { if (bn >= 0 && cwEnd(cw).id === bn && ge < best.cost) best = { cost: ge, cw, from, conn }; };
    // already on the goal edge, heading the right way
    if (an < 0 && bn < 0 && A.edge === B.edge) {
      if (ea.fwd.length && B.s >= A.s) best = { cost: per(B.s - A.s, ea), cw: A.edge * 2, from: -1, conn: -1 };
      if (ea.bwd.length && B.s <= A.s && per(A.s - B.s, ea) < best.cost) best = { cost: per(A.s - B.s, ea), cw: A.edge * 2 + 1, from: -1, conn: -1 };
    }
    // g is the cost on reaching the far end of a carriageway
    const start = (cw, g0) => {
      const e = edges[cw >> 1];
      if (!cwLanes(cw).length || (ai && !e.ai)) return;
      const v = g0(cw);
      if (v >= g[cw]) return;
      g[cw] = v; push(v + h(cw), cw); atGoal(cw, v, -1, -1);
      // leaving a junction straight down the goal edge
      if (an >= 0 && bn < 0 && (cw >> 1) === B.edge && goalCost(cw) < best.cost) best = { cost: goalCost(cw), cw, from: -1, conn: -1 };
    };
    if (an >= 0) {
      // leave the junction by any carriageway that departs it
      for (const e of edges) {
        if (e.a === an) start(e.id * 2, full);
        if (e.b === an) start(e.id * 2 + 1, full);
      }
    } else for (const dir of [0, 1]) start(A.edge * 2 + dir, () => per(dir ? A.s : ea.len - A.s, ea));
    const TURN = time ? TURN_COST_S : TURN_COST_M, tk = time ? 1 : px;
    while (heap.length) {
      const [f, cw] = pop();
      if (f >= best.cost) break;
      if (f > g[cw] + h(cw) + 1e-9) continue;
      for (const { to, conn } of adj[cw]) {
        const e2 = edges[to >> 1];
        if (ai && !e2.ai) continue;
        const c = conns[conn], cn = nodes[c.node];
        const ng = g[cw] + TURN[c.turn] * tk +
          (time ? c.len / Math.min(e2.speed, edges[cw >> 1].speed) + (cn.control === 'signal' ? 4 : 0) : c.len);
        if (bn < 0 && (to >> 1) === B.edge && ng + goalCost(to) < best.cost) best = { cost: ng + goalCost(to), cw: to, from: cw, conn };
        const ge = ng + full(to);
        if (ge < g[to]) { g[to] = ge; prev[to] = cw; via[to] = conn; push(ge + h(to), to); atGoal(to, ge, cw, conn); }
      }
    }
    if (best.cw < 0) return null;
    // walk back from the goal; chain[i].conn is the connector that entered chain[i].cw (-1 for the first)
    const chain = [{ cw: best.cw, conn: best.conn }];
    for (let cw = best.from; cw >= 0; cw = prev[cw]) chain.unshift({ cw, conn: via[cw] });
    r.chain = chain; r.cost = best.cost;
    return r;
  }

  // The pieces a search result drives: [{ P (lane or connector), s0, s1, lane?, conn? }], plus the junction
  // centres it starts or ends on.
  function pieces(r) {
    const { A, B, an, bn, chain } = r, out = [];
    for (let i = 0; i < chain.length; i++) {
      const { cw } = chain[i], next = chain[i + 1];
      const lane = next ? conns[next.conn].from : (i ? conns[chain[i].conn].to : nearestLaneIn(cw, A));
      const L = lanes[lane];
      const s0 = i === 0 && an < 0 ? laneS(L, A.s) : 0;
      const s1 = next || bn >= 0 ? L.len : laneS(L, B.s);
      out.push({ P: L, s0, s1: Math.max(s0, s1), lane, conn: next ? next.conn : -1 });
      if (next) out.push({ P: conns[next.conn], s0: 0, s1: conns[next.conn].len });
    }
    return { out, head: an >= 0 ? nodes[an] : null, tail: bn >= 0 ? nodes[bn] : null };
  }

  // Shortest drive between two points: { pts: Float32Array [x0,y0,x1,y1...], s, len, steps:[{lane, conn}] }
  // or null. ai:true keeps to roads traffic uses; time:true minimises time (len/speed + 4 s per signal).
  // A start or goal inside a junction begins or ends at the junction centre.
  net.route = (x0, y0, x1, y1, opts = {}) => {
    const r = search(x0, y0, x1, y1, opts);
    if (!r) return null;
    const { out, head, tail } = pieces(r), xs = [], ys = [], steps = [];
    const p = {};
    if (head) { xs.push(head.x); ys.push(head.y); }
    for (const q of out) {
      if (q.lane != null) steps.push({ lane: q.lane, conn: q.conn });
      if (q.s1 <= q.s0 && xs.length) continue;
      along(q.P, q.s0, p); xs.push(p.x); ys.push(p.y);
      for (let i = 0; i < q.P.n; i++) if (q.P.s[i] > q.s0 + 1e-3 && q.P.s[i] < q.s1 - 1e-3) { xs.push(q.P.x[i]); ys.push(q.P.y[i]); }
      along(q.P, q.s1, p); xs.push(p.x); ys.push(p.y);
    }
    if (tail) { xs.push(tail.x); ys.push(tail.y); }
    const pts = new Float32Array(xs.length * 2), s = new Float32Array(xs.length);
    for (let i = 0; i < xs.length; i++) {
      pts[2 * i] = xs[i]; pts[2 * i + 1] = ys[i];
      if (i) s[i] = s[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    }
    return { pts, s, len: s[s.length - 1] || 0, steps, cost: r.cost };
  };
  const nearestLaneIn = (cw, p) => {
    const ids = cwLanes(cw);
    let best = ids[0], bd = Infinity;
    for (const id of ids) { const L = lanes[id], q = along(L, laneS(L, p.s), {}); const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; best = id; } }
    return best;
  };
  // Length in px of the shortest drive (Infinity when there is none), without building its polyline.
  net.routeLength = (x0, y0, x1, y1, opts = {}) => {
    const r = search(x0, y0, x1, y1, { ...opts, time: false });
    if (!r) return Infinity;
    const { out, head, tail } = pieces(r);
    if (!out.length) return 0;   // start and goal in the same junction, as route() gives it
    // the pieces plus the short hops between them (a lane change, the way into or out of a junction centre)
    let len = 0, px0 = head ? head.x : null, py0 = head ? head.y : null;
    const p = {};
    for (const q of out) {
      if (q.s1 <= q.s0 && px0 != null) continue;
      along(q.P, q.s0, p);
      if (px0 != null) len += Math.hypot(p.x - px0, p.y - py0);
      len += q.s1 - q.s0;
      along(q.P, q.s1, p); px0 = p.x; py0 = p.y;
    }
    if (tail) len += Math.hypot(tail.x - px0, tail.y - py0);
    return len;
  };

  // Pure pursuit along a route: the point lookPx ahead of (x, y)'s projection. Keeps nav.i (segment),
  // nav.at (station) and nav.off (distance from the route); returns nav.pt, the same array each call.
  net.follow = (nav, x, y, lookPx) => {
    const P = nav.pts, n = P.length >> 1;
    if (!nav.s) { nav.s = new Float32Array(n); for (let i = 1; i < n; i++) nav.s[i] = nav.s[i - 1] + Math.hypot(P[2 * i] - P[2 * i - 2], P[2 * i + 1] - P[2 * i - 1]); }
    const pt = nav.pt || (nav.pt = [0, 0]);
    if (n < 2) { pt[0] = P[0]; pt[1] = P[1]; return pt; }
    const scan = (i0, i1) => {
      let b = null;
      for (let i = Math.max(0, i0); i < Math.min(n - 1, i1); i++) {
        const ax = P[2 * i], ay = P[2 * i + 1], dx = P[2 * i + 2] - ax, dy = P[2 * i + 3] - ay, L2 = dx * dx + dy * dy;
        const f = L2 > 1e-9 ? clamp(((x - ax) * dx + (y - ay) * dy) / L2, 0, 1) : 0;
        const d = Math.hypot(x - ax - dx * f, y - ay - dy * f);
        if (!b || d < b.d) b = { i, f, d };
      }
      return b;
    };
    let b = scan((nav.i ?? 0) - 4, (nav.i ?? 0) + 80);
    if (!b || b.d > 40 * px) { const full = scan(0, n); if (full && (!b || full.d < b.d)) b = full; }
    nav.i = b.i; nav.off = b.d;
    nav.at = nav.s[b.i] + (nav.s[b.i + 1] - nav.s[b.i]) * b.f;
    const want = Math.min(nav.s[n - 1], nav.at + lookPx);
    let j = b.i;
    while (j < n - 2 && nav.s[j + 1] < want) j++;
    const ds = nav.s[j + 1] - nav.s[j], f = ds > 1e-9 ? clamp((want - nav.s[j]) / ds, 0, 1) : 1;
    pt[0] = P[2 * j] + (P[2 * j + 2] - P[2 * j]) * f;
    pt[1] = P[2 * j + 1] + (P[2 * j + 3] - P[2 * j + 1]) * f;
    return pt;
  };

  // A random spot on a lane: { lane, s, x, y, a } or null. Around (x, y) when given, between rMin and rMax;
  // ai keeps to traffic roads; cls limits the class (a name or a list); minGap keeps clear of the cars on
  // that lane (lane.cars, by c.ai.s); notVisible(x, y) must return true for the spot to be used.
  net.randomLanePoint = ({ x, y, rMin = 0, rMax = Infinity, ai = true, minGap = 0, cls, notVisible, rng = Math.random, tries = 40 } = {}) => {
    const okCls = cls == null ? () => true : Array.isArray(cls) ? c => cls.includes(c) : c => c === cls;
    const cand = [];
    const take = e => { if ((!ai || e.ai) && okCls(e.cls) && (e.fwd.length || e.bwd.length)) cand.push(e); };
    if (x == null || !isFinite(rMax)) edges.forEach(take); else net.edgesNear(x, y, rMax, take);
    if (!cand.length) return null;
    const total = cand.reduce((t, e) => t + e.len, 0);
    for (let t = 0; t < tries; t++) {
      let r = rng() * total, e = cand[0];
      for (const c of cand) { if ((r -= c.len) <= 0) { e = c; break; } }
      const ids = [...e.fwd, ...e.bwd], lane = ids[Math.floor(rng() * ids.length) % ids.length], L = lanes[lane];
      const s = rng() * L.len, p = along(L, s, {});
      if (x != null) { const d = Math.hypot(p.x - x, p.y - y); if (d < rMin || d > rMax) continue; }
      if (minGap > 0 && L.cars.some(c => Math.abs((c.ai ? c.ai.s : c.s) - s) < minGap)) continue;
      if (notVisible && !notVisible(p.x, p.y)) continue;
      return { lane, s, x: p.x, y: p.y, a: p.a };
    }
    return null;
  };

  // Signals: 'g', 'a' or 'r' for traffic arriving from `edge` at `node`; null where there is no signal.
  // net.clock (seconds) drives them; net.tick(dt) advances it.
  net.signalAt = (node, edge) => {
    const N = typeof node === 'object' ? node : nodes[node], ei = typeof edge === 'object' ? edge.id : edge;
    if (!N || N.control !== 'signal') return null;
    const k = N.ends.findIndex(E => E.e === ei);
    const grp = k < 0 ? 1 : N.groups[k];
    let t = (net.clock + N.phase) % CYCLE;
    if (grp === 1) t = (t + CYCLE / 2) % CYCLE;
    return t < SIG.green ? 'g' : t < SIG.green + SIG.amber ? 'a' : 'r';
  };
  net.tick = dt => { net.clock += dt; };
  // Switch the signal candidates on or off (they fall back to priority or all-way when off).
  net.setSignals = on => {
    net.signalsOn = !!on;
    for (const N of nodes) N.control = N.signal && on ? 'signal' : N.fallback;
    for (const c of conns) {
      const N = nodes[c.node], A = lanes[c.from];
      const k = N.ends.findIndex(E => E.e === A.edge && E.start === (A.dir < 0));
      c.yield = N.control === 'priority' ? !N.major.includes(k) || c.turn === 'l' : N.control === 'signal' ? c.turn === 'l' : false;
    }
  };

  // ---- sidewalks ----
  const walkAlong = (p, s, out) => {
    const n = p.n;
    s = clamp(s, 0, p.len);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p.s[m] <= s) lo = m; else hi = m; }
    const ds = p.s[hi] - p.s[lo], f = ds > 1e-9 ? (s - p.s[lo]) / ds : 0;
    const dx = p.pts[2 * hi] - p.pts[2 * lo], dy = p.pts[2 * hi + 1] - p.pts[2 * lo + 1];
    out.x = p.pts[2 * lo] + dx * f; out.y = p.pts[2 * lo + 1] + dy * f; out.a = Math.atan2(dy, dx); out.s = s;
    return out;
  };
  net.walkPoint = (id, s, out = {}) => walkAlong(walks.paths[id], s, out);
  // The closest sidewalk point: { path, s, x, y, d } or null.
  net.nearestWalk = (x, y, maxD = Infinity) => {
    let best = null;
    ringSearch(WH, x, y, maxD, (pi, j) => {
      const p = walks.paths[pi], ax = p.pts[2 * j], ay = p.pts[2 * j + 1], dx = p.pts[2 * j + 2] - ax, dy = p.pts[2 * j + 3] - ay;
      const L2 = dx * dx + dy * dy, f = L2 > 1e-9 ? clamp(((x - ax) * dx + (y - ay) * dy) / L2, 0, 1) : 0;
      const qx = ax + dx * f, qy = ay + dy * f, d = Math.hypot(x - qx, y - qy);
      if (d <= maxD && (!best || d < best.d)) best = { path: pi, s: p.s[j] + (p.s[j + 1] - p.s[j]) * f, x: qx, y: qy, d };
      return best ? best.d : Infinity;
    });
    return best;
  };
  // A random sidewalk spot (crosswalks excluded), optionally between rMin and rMax of (x, y).
  net.randomWalkPoint = ({ x, y, rMin = 0, rMax = Infinity, rng = Math.random, tries = 40 } = {}) => {
    let cand = walks.paths.filter(p => !p.cross && p.len > 0);
    if (x != null && isFinite(rMax)) {
      const near = new Set();
      WH.query(x - rMax, y - rMax, x + rMax, y + rMax, pi => near.add(pi));
      cand = cand.filter(p => near.has(p.id));
    }
    if (!cand.length) return null;
    const total = cand.reduce((t, p) => t + p.len, 0);
    for (let t = 0; t < tries; t++) {
      let r = rng() * total, p = cand[0];
      for (const c of cand) { if ((r -= c.len) <= 0) { p = c; break; } }
      const q = walkAlong(p, rng() * p.len, {});
      if (x != null) { const d = Math.hypot(q.x - x, q.y - y); if (d < rMin || d > rMax) continue; }
      return { path: p.id, s: q.s, x: q.x, y: q.y, a: q.a };
    }
    return null;
  };

  // ---- heights ----
  // Pin every node to the mean height of its edge ends, ease each edge into it, then bank the curves:
  // bank = clamp(k v^2 / g * 0.5, +-bankMax), with v the class speed. buildRoadNet runs it once (after
  // opts.profile); call it again after editing edge.gy by hand. bank:false leaves edge.bank alone.
  // On v2, terrain.solveProfiles owns edge.gy, node.gy and edge.bank (its bank is smoothed and fades out
  // at junctions): do not call this after it, or the raw bank here would overwrite that.
  net.updateProfiles = ({ blend = NODE_BLEND, bank = true } = {}) => {
    const sum = new Float64Array(nodes.length), cnt = new Float64Array(nodes.length);
    for (const e of edges) { sum[e.a] += e.gy[0]; cnt[e.a]++; sum[e.b] += e.gy[e.n - 1]; cnt[e.b]++; }
    for (const N of nodes) N.gy = cnt[N.id] ? sum[N.id] / cnt[N.id] : 0;
    const B = blend * px;
    for (const e of edges) {
      const da = nodes[e.a].gy - e.gy[0], db = nodes[e.b].gy - e.gy[e.n - 1];
      for (let i = 0; i < e.n; i++) {
        if (e.s[i] < B) e.gy[i] += da * (1 - e.s[i] / B);
        if (e.len - e.s[i] < B) e.gy[i] += db * (1 - (e.len - e.s[i]) / B);
      }
      e.gy[0] = nodes[e.a].gy; e.gy[e.n - 1] = nodes[e.b].gy;
      if (!bank) continue;
      const v = e.speed / px;
      if (e.bank.length !== Math.floor(e.len / (2 * px)) + 1) e.bank = new Float32Array(Math.floor(e.len / (2 * px)) + 1);
      for (let j = 0, i = 0; j < e.bank.length; j++) {
        const s = j * 2 * px;
        while (i < e.n - 2 && e.s[i + 1] < s) i++;
        const ds = e.s[i + 1] - e.s[i], f = ds > 1e-9 ? clamp((s - e.s[i]) / ds, 0, 1) : 0;
        const k = (e.k[i] + (e.k[i + 1] - e.k[i]) * f) * px;
        e.bank[j] = clamp(k * v * v / G * 0.5, -e.bankMax, e.bankMax);
      }
    }
  };
}
