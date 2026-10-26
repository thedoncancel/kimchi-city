// Kimchi Key v2 props as data (docs/map-v2-spec.md §0, §4.2, §5.6, §6.2, §7, §11.1 Props). Pure functions: no
// three, no DOM.
//
// placeProps(net, grids, regions, rng) returns { lamps, palms, trees, signals, chevrons, gantries, dangerSigns,
// billboards, furniture, guardrails, fences, beachProps }. Positions are sim px ({x, y}), headings a radians
// (0 = east, π/2 = south), sizes metres unless they say px. Every record past lamps, palms and trees carries
// a kind, so the point props can go straight into the world's deco list.
//   lamps       {x, y, a, edge}: every 35 m on lit roads (sidewalk or shoulder), every 30 m on the promenades
//   palms       {x, y, h, lean, rot}: blvd medians every 12 m, Ocean Drive's park side every 9 m, the Loop's
//               median on the causeway fill every 15 m, and the beaches' inland edge
//   trees       {x, y, r (px)}: banyans along Coral Way (its banyans span), shade trees on the Gables' lawns
//   signals     {kind 'signal', node, edge, group, x, y, a}: a post at the stop line of every approach to a
//               signal candidate, facing the drivers; props3d asks roads.signalAt(node, edge) for the lens
//   chevrons    {kind 'chevron', x, y, a, turn, kmh} on the outside of every bend slower than 120 km/h by the
//               advisory formula of §0, and {kind 'advisory', x, y, a, kmh, dir} before it each way
//   gantries    {kind 'gantry', x, y, a, w (m), exit, name, side, node, deck}: over each Loop carriageway 150 m
//               before every Loop T (a little further back where that falls in another junction's box)
//   dangerSigns {kind 'jump'|'gator', x, y, a, id?}: before each jump (§5.6) and by the Gator Lagoon
//   billboards  {kind 'billboard', x, y, a, w, h, pole, water, art}: along the Runway Straight and the causeways
//   furniture   {kind 'bench'|'bin'|'hydrant'|'planter'|'busStop', x, y, a}: urban sidewalks, Lincoln Road
//   guardrails  {kind 'wbeam'|'jersey', pts: Float32Array px, edge, side, x, y}: W-beam where a country or
//               switchback road has more than 2 m of drop beside it or bends under R 60 m (§11.1); Jersey
//               barriers down the Loop's median on its decks (§4.2)
//   fences      {kind 'abutment', x, y, a, w, d, top, base} walls where GROUND holds a bridge deck's height
//               past its end over dry ground; {kind 'bollards', pts, path} along the people-only paths
//   beachProps  {kind 'lifeguard'|'umbrella'|'towel', x, y, a, color} on the dry sand
// Rails and barriers block cars, abutment walls cars and people: placeProps sets BLOCK_CAR (and BLOCK_FOOT)
// in grids.surf for them, 2 m thick (§6.2) and never on a carriageway or sidewalk, so it runs after SURF
// stamping, as world-v2 calls it.
//
// placeFlora(net, grids, regions, opts) is the county's vegetation (stage P2), placed apart from placeProps
// (see its own header below the props).
import { KIND, KIND_MASK, FLAG, sampleGrid } from './raster.js';
import { ROADS, PATHS, COAST, ACTIVITIES, PHYS, SEA_LEVEL, VIEW_CORRIDORS, SIGHT_TARGETS, BENCH_VIEWS, PHOTO_SPOTS, JARS, LANDMARKS } from './mapdata.js';
import { mulberry32 } from '../util.js';

const PX = 16;
const LAMP_EVERY = 35;      // m between lamps along a road
const KERB = 0.5;           // m past the carriageway edge: on the sidewalk's road edge, or on the shoulder
// Roads that get lamps; dirt tracks and alleys stay dark.
const LIT = new Set(['hwy', 'blvd', 'ave', 'street', 'coast', 'country', 'switch', 'ring']);
// Bends get chevrons on these classes (the town's streets have junction corners, not bends to warn of).
const RURAL = new Set(['hwy', 'coast', 'country', 'switch', 'dirt']);
const ADVISE_KMH = 120;     // §0: advisory speeds are shown only below this
const GANTRY_BACK = 150;    // m before a Loop T
const RAIL_OFF = 1;         // m past the carriageway: the middle of the rail's 2 m band
const BEND_RAIL_R = 60, DROP_RAIL = 2;      // §11.1: W-beam under R 60 m or over 2 m of drop
const RAISED = 0.5;         // m: GROUND this far over TERRAIN beside a deck end is an abutment
const ABUT_REACH = 16;      // m past the deck's sidewalk where abutment ground is looked for, round each deck end
const UMBRELLA = ['#e5678a', '#2aa39d', '#f0a057', '#4f8fd8', '#f4d98a', '#ff5252'];
const TOWER = ['#f5a1b8', '#7fd6cf', '#f6d36b', '#a7c7f0', '#f6a26b'];

const { ROAD, WALK, GRASS, BUILD, LOT, PLAZA, WATER, SAND, DIRT, SHALLOW, DECK } = KIND;
const BLOCKS = FLAG.BLOCK_CAR | FLAG.BLOCK_FOOT;
const ROAD_BY_ID = Object.fromEntries(ROADS.map(r => [r.id, r]));
const OPEN = new Set([WALK, GRASS, PLAZA, LOT, SAND, DIRT]);      // where a lamp or a sign may stand
const VERGE = new Set([GRASS, SAND, DIRT]);                         // where a rail or a wall may be stamped

export function placeProps(net, grids, regions, rng) {
  const out = { lamps: [], palms: [], trees: [], signals: [], chevrons: [], gantries: [], dangerSigns: [], billboards: [],
    furniture: [], guardrails: [], fences: [], beachProps: [] };
  if (!grids.surf || !net.edges) return out;
  const ctx = makeContext(net, grids, regions, rng);
  streetLamps(ctx, out);
  promenadeLamps(ctx, out);
  medianPalms(ctx, out);
  oceanDrivePalms(ctx, out);
  causewayPalms(ctx, out);
  banyans(ctx, out);
  signalPosts(ctx, out);
  bendSigns(ctx, out);
  gantries(ctx, out);
  dangerSigns(ctx, out);
  billboards(ctx, out);
  furniture(ctx, out);
  wbeams(ctx, out);
  jerseys(ctx, out);
  abutments(ctx, out);
  bollards(ctx, out);
  beaches(ctx, out);
  return out;
}

function makeContext(net, grids, regions, rng) {
  const W = grids.w, H = grids.h, [vw, vh] = grids.dims?.ground || [(W >> 1) + 1, (H >> 1) + 1];
  return {
    net, surf: grids.surf, W, H, seed: (rng() * 4294967296) >>> 0,
    ground: { w: vw, h: vh, cell: 2, o: 0, data: grids.ground }, terrain: { w: vw, h: vh, cell: 2, o: 0, data: grids.terrain || grids.ground },
    regs: regions.filter(r => r.pts).map(r => ({ r, box: bbox(r.pts) })),
  };
}

// A random stream of its own for each kind of prop, so adding one kind never moves another.
const streamOf = (ctx, name) => mulberry32((ctx.seed ^ strHash(name)) >>> 0);

// ---------- lamps ----------

function streetLamps(ctx, out) {
  const p = {};
  for (const e of ctx.net.edges) {
    if (!LIT.has(e.cls) || e.len < LAMP_EVERY * PX) continue;
    // stations clear of the junction boxes, alternating sides on roads with a sidewalk each side
    const s0 = e.trimA + 4 * PX, s1 = e.len - e.trimB - 4 * PX, both = e.walkL > 0 && e.walkR > 0;
    let k = 0;
    for (let s = s0 + LAMP_EVERY * PX * 0.5; s < s1; s += LAMP_EVERY * PX, k++) {
      if (onDeck(e, s)) continue;
      at(e, s, p);
      const side = both ? (k & 1 ? -1 : 1) : (e.walkR > 0 || e.walkL === 0 ? 1 : -1);
      const off = e.halfW + KERB * PX;
      const x = p.x - p.ty * off * side, y = p.y + p.tx * off * side;
      if (!standOK(ctx, x / PX, y / PX)) continue;
      // the lamp faces the road
      out.lamps.push({ x, y, a: Math.atan2(-p.tx * side, p.ty * side), edge: e.id });
    }
  }
}

// The promenades (the Beachwalk, the Riverwalk) get a lamp every 30 m on their inland edge (the Riverwalk's
// decks included).
function promenadeLamps(ctx, out) {
  for (const P of PATHS) {
    if (P.kind !== 'promenade' || !P.pts) continue;
    alongLine(P.pts, 30, 15, (x, z, tx, tz) => {
      for (const side of [-1, 1]) {
        const lx = x - tz * side * (P.w / 2 - 0.4), lz = z + tx * side * (P.w / 2 - 0.4);
        const k = kindAt(ctx, lx, lz);
        if (k !== PLAZA && k !== DECK) continue;
        out.lamps.push({ x: lx * PX, y: lz * PX, a: Math.atan2(-tx * side, tz * side), path: P.id });
        return;
      }
    });
  }
}

// ---------- palms and trees ----------

// Every boulevard's 3 m median (§4.2): a palm every 12 m, clear of the junction boxes and the decks.
function medianPalms(ctx, out) {
  const rnd = streamOf(ctx, 'median palms'), p = {};
  for (const e of ctx.net.edges) {
    if (e.cls !== 'blvd' || !(e.median > 0)) continue;
    for (let s = e.trimA + 8 * PX; s < e.len - e.trimB - 8 * PX; s += 12 * PX) {
      if (onDeck(e, s)) continue;
      at(e, s, p);
      out.palms.push(palm(rnd, p.x, p.y));
    }
  }
}

// Ocean Drive (Collins Ave from its altFromZ south): a palm every 9 m along Lummus Park, on its park side.
function oceanDrivePalms(ctx, out) {
  const rnd = streamOf(ctx, 'ocean drive'), p = {};
  for (const e of ctx.net.edges) {
    const road = ROAD_BY_ID[e.road];
    if (!road?.park || road.altFromZ === undefined) continue;
    const side = compassOf(e, 1) === road.park ? 1 : -1, off = e.halfW + (side > 0 ? e.walkR : e.walkL) + 2.5 * PX;
    for (let s = e.trimA + 4 * PX; s < e.len - e.trimB - 4 * PX; s += 9 * PX) {
      at(e, s, p);
      if (p.y / PX < road.altFromZ) continue;
      const x = p.x - p.ty * off * side, y = p.y + p.tx * off * side;
      if (standOK(ctx, x / PX, y / PX)) out.palms.push(palm(rnd, x, y));
    }
  }
}

// The Loop's median off its decks on the causeway fill (the MacArthur fill, and the approaches to each
// bridge, ABUT_FILL m from a deck end): a palm every 15 m (§4.2: Jersey barrier on decks, palms on fill).
const ABUT_FILL = 60;
function causewayPalms(ctx, out) {
  const rnd = streamOf(ctx, 'causeway palms'), fill = COAST.macarthur_fill?.[0]?.poly, p = {};
  for (const e of ctx.net.edges) {
    if (e.cls !== 'hwy' || !(e.median > 0)) continue;
    for (let s = e.trimA + 10 * PX; s < e.len - e.trimB - 10 * PX; s += 15 * PX) {
      if (onDeck(e, s)) continue;
      at(e, s, p);
      const nearDeck = (e.deck || []).some(([a, b]) => Math.min(Math.abs(s - a), Math.abs(s - b)) < ABUT_FILL * PX);
      if (nearDeck || (fill && insidePoly(fill, p.x / PX, p.y / PX))) out.palms.push(palm(rnd, p.x, p.y));
    }
  }
}

// Banyans along Coral Way inside its banyans span (x, m): both sides, on the lawn just past the sidewalk.
function banyans(ctx, out) {
  const rnd = streamOf(ctx, 'banyans'), p = {};
  for (const e of ctx.net.edges) {
    const span = ROAD_BY_ID[e.road]?.banyans;
    if (!span) continue;
    for (const side of [1, -1]) {
      const off = e.halfW + (side > 0 ? e.walkR : e.walkL) + 1.6 * PX;
      for (let s = e.trimA + 6 * PX; s < e.len - e.trimB - 6 * PX; s += (13 + rnd() * 4) * PX) {
        at(e, s, p);
        if (p.x / PX < span[0] || p.x / PX > span[1]) continue;
        const x = p.x - p.ty * off * side, y = p.y + p.tx * off * side;
        if (kindAt(ctx, x / PX, y / PX) === GRASS && clearOf(ctx, x / PX, y / PX, 2.5, BUILD)) out.trees.push({ x, y, r: (3.6 + rnd() * 1.4) * PX });
      }
    }
  }
}

function palm(rnd, x, y) {
  return { x, y, h: 6.5 + rnd() * 3.5, lean: 0.06 + rnd() * 0.14, rot: rnd() * Math.PI * 2 };
}

// ---------- signals ----------

// A post on the right of each approach at its stop line (the junction box edge), facing the drivers. A
// one-way edge leaving the node brings no traffic, so it gets none.
function signalPosts(ctx, out) {
  const { net } = ctx, p = {};
  for (const N of net.nodes) {
    if (!N.signal) continue;
    N.ends.forEach((E, idx) => {
      const e = net.edges[E.e];
      if (E.start && e.oneway) return;
      at(e, E.start ? e.trimA : e.len - e.trimB, p);
      const dx = E.start ? -p.tx : p.tx, dy = E.start ? -p.ty : p.ty, off = e.halfW + 0.8 * PX;     // travel toward the node
      out.signals.push({ kind: 'signal', node: N.id, edge: e.id, group: N.groups?.[idx] ?? 0, x: p.x - dy * off, y: p.y + dx * off, a: Math.atan2(-dy, -dx) });
    });
  }
}

// ---------- bends: chevrons and advisory speeds ----------

// A bend is a run of samples whose advisory speed v = sqrt((gripG + tan(bank))·g·R) (§0), rounded down to
// 10 km/h, is under ADVISE_KMH. Chevron boards stand on its outside every few metres (their arrows show the
// turn as seen along the edge's point order; the back face carries the mirror for the other way); an advisory
// sign stands 40 m before it on the right of each way traffic comes.
function bendSigns(ctx, out) {
  const g = 9.81, grip = PHYS.gripG || 2;
  for (const e of ctx.net.edges) {
    if (!RURAL.has(e.cls) || !e.k) continue;
    const kmh = new Float32Array(e.n);
    for (let i = 0; i < e.n; i++) {
      const k = e.k[i] * PX, R = Math.abs(k) > 1e-6 ? 1 / Math.abs(k) : Infinity;
      const tb = Math.tan(bankAt(e, e.s[i])) * Math.sign(k);
      kmh[i] = Math.sqrt(Math.max(0.1, grip + tb) * g * R) * 3.6;
    }
    for (let i = 0; i < e.n;) {
      if (!(kmh[i] < ADVISE_KMH)) { i++; continue; }
      let j = i, low = kmh[i], kSum = 0;
      while (j < e.n && kmh[j] < ADVISE_KMH) { low = Math.min(low, kmh[j]); kSum += e.k[j]; j++; }
      const s0 = e.s[i], s1 = e.s[j - 1];
      if (s1 - s0 >= 8 * PX && !onDeck(e, (s0 + s1) / 2)) bend(ctx, e, s0, s1, Math.floor(low / 10) * 10, kSum > 0 ? 1 : -1, out);
      i = j;
    }
  }
}

function bend(ctx, e, s0, s1, kmh, turn, out) {
  const p = {}, outside = -turn, every = (s1 - s0) / PX > 40 ? 10 : 6, off = e.halfW + (RAIL_OFF + 1.6) * PX;     // behind the rail
  for (let s = s0; s <= s1 + 1e-6; s += every * PX) {
    at(e, s, p);
    const x = p.x - p.ty * off * outside, y = p.y + p.tx * off * outside;
    if (signOK(ctx, x / PX, y / PX)) out.chevrons.push({ kind: 'chevron', x, y, a: Math.atan2(-p.ty, -p.tx), turn: turn > 0 ? 'R' : 'L', kmh, edge: e.id });
  }
  // the advisory sign each way, 40 m before the bend (or at the edge's own end when that is nearer)
  for (const dir of e.oneway ? [1] : [1, -1]) {
    const s = dir > 0 ? Math.max(e.trimA + 2 * PX, s0 - 40 * PX) : Math.min(e.len - e.trimB - 2 * PX, s1 + 40 * PX);
    at(e, s, p);
    const tx = p.tx * dir, ty = p.ty * dir, o = e.halfW + 1.5 * PX, x = p.x - ty * o, y = p.y + tx * o;
    if (signOK(ctx, x / PX, y / PX)) out.chevrons.push({ kind: 'advisory', x, y, a: Math.atan2(-ty, -tx), kmh, dir, edge: e.id });
  }
}

// ---------- gantries ----------

// The Loop as one closed line (m) in its edges' order, and the station of every node on it.
function loopChain(net) {
  const loop = net.edges.filter(e => e.road === 'loop');
  if (!loop.length) return null;
  const xs = [], zs = [], nodeS = new Map(), used = new Set();
  let e = loop[0], fwd = true, node = e.a, s = 0;
  while (e && !used.has(e.id)) {
    used.add(e.id);
    nodeS.set(node, s);
    for (let k = 0; k < e.n; k++) {
      const i = fwd ? k : e.n - 1 - k, x = e.x[i] / PX, z = e.y[i] / PX;
      if (xs.length) { const dl = Math.hypot(x - xs[xs.length - 1], z - zs[zs.length - 1]); if (dl < 1e-6) continue; s += dl; }
      xs.push(x); zs.push(z);
    }
    node = fwd ? e.b : e.a;
    const next = loop.find(q => !used.has(q.id) && (q.a === node || q.b === node));
    if (!next) break;
    fwd = next.a === node; e = next;
  }
  const S = new Float64Array(xs.length);
  for (let i = 1; i < xs.length; i++) S[i] = S[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
  const len = S[S.length - 1] + Math.hypot(xs[0] - xs[xs.length - 1], zs[0] - zs[zs.length - 1]);
  return { x: xs, z: zs, s: S, n: xs.length, len, nodeS };
}

// A point and travel tangent on the chain at station s (wrapped).
function chainAt(c, s, out) {
  s = ((s % c.len) + c.len) % c.len;
  let lo = 0, hi = c.n - 1;
  if (s >= c.s[hi]) { lo = hi; hi = 0; }
  else while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c.s[m] <= s) lo = m; else hi = m; }
  const dx = c.x[hi] - c.x[lo], dz = c.z[hi] - c.z[lo], l = Math.hypot(dx, dz) || 1, f = Math.min(1, (s - c.s[lo]) / l);
  out.x = c.x[lo] + dx * f; out.z = c.z[lo] + dz * f; out.tx = dx / l; out.tz = dz / l;
  return out;
}

// Over each carriageway, GANTRY_BACK m before every Loop T (pushed back clear of a junction box it would
// stand in), naming the road that leaves there and its side.
function gantries(ctx, out) {
  const { net } = ctx, c = loopChain(net);
  if (!c) return;
  const cls = net.edges.find(e => e.road === 'loop'), laneW = cls.laneW / PX, med = cls.median / PX;
  const p = {}, mid = med / 2 + laneW, span = cls.halfW / PX - med / 2;
  for (const N of net.nodes) {
    const sN = c.nodeS.get(N.id);
    if (sN === undefined || N.ends.length < 3) continue;
    const side = N.ends.map(E => net.edges[E.e]).find(e => e.road !== 'loop');
    if (!side) continue;
    const E = N.ends.find(q => q.e === side.id), ux = Math.cos(E.a), uz = Math.sin(E.a);
    for (const dir of [1, -1]) {
      // GANTRY_BACK m before the T, or a little further back where that falls in another junction's box
      let x, z, tx, tz;
      for (let back = GANTRY_BACK; back <= GANTRY_BACK + 60; back += 5) {
        chainAt(c, sN - dir * back, p);
        tx = p.tx * dir; tz = p.tz * dir; x = p.x - tz * mid; z = p.z + tx * mid;
        const b = cellBits(ctx, x, z);
        if (b & FLAG.NOPED && !(b & FLAG.JCT)) break;
      }
      const leaves = tx * uz - tz * ux > 0 ? 'R' : 'L';
      const deck = kindAt(ctx, x, z) === DECK;
      out.gantries.push({ kind: 'gantry', x: x * PX, y: z * PX, a: Math.atan2(tz, tx), w: span, exit: side.road, name: side.name, side: leaves, node: N.id, deck });
    }
  }
}

// ---------- danger signs ----------

// A warning sign 40 m before each jump's lip on the right of the way cars take it (along the road's point
// order), and one by the Gator Lagoon where the airboat road passes closest.
function dangerSigns(ctx, out) {
  const { net } = ctx, p = {};
  for (const J of ACTIVITIES?.jumps || []) {
    const q = nearestEdgeOf(net, J.road, J.x, J.z);
    if (!q) continue;
    const e = q.e;
    at(e, Math.max(2 * PX, q.s - 40 * PX), p);
    const o = e.halfW + 1.5 * PX, x = p.x - p.ty * o, y = p.y + p.tx * o;
    out.dangerSigns.push({ kind: 'jump', id: J.id, x, y, a: Math.atan2(-p.ty, -p.tx), container: !!J.container });
  }
  const lagoon = [395, 1140], q = nearestEdgeOf(net, 'airboat_rd', lagoon[0], lagoon[1]);
  if (q) {
    const e = q.e;
    at(e, q.s, p);
    const toward = (lagoon[0] * PX - p.x) * -p.ty + (lagoon[1] * PX - p.y) * p.tx > 0 ? 1 : -1, o = e.halfW + 2 * PX;
    const x = p.x - p.ty * o * toward, y = p.y + p.tx * o * toward;
    // it faces the road, its back to the water
    if (signOK(ctx, x / PX, y / PX)) out.dangerSigns.push({ kind: 'gator', x, y, a: Math.atan2(-p.tx * toward, p.ty * toward) });
  }
}

// The edge of a road nearest to (x, z) m and the station on it: { e, s, d } (px), or null.
function nearestEdgeOf(net, road, x, z) {
  let best = null;
  for (const e of net.edges) {
    if (e.road !== road) continue;
    for (let i = 0; i + 1 < e.n; i++) {
      const ax = e.x[i], ay = e.y[i], dx = e.x[i + 1] - ax, dy = e.y[i + 1] - ay, l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x * PX - ax) * dx + (z * PX - ay) * dy) / l2)) : 0;
      const d = Math.hypot(x * PX - ax - dx * t, z * PX - ay - dy * t);
      if (!best || d < best.d) best = { e, s: e.s[i] + (e.s[i + 1] - e.s[i]) * t, d };
    }
  }
  return best;
}

// ---------- billboards ----------

// Along the Runway Straight (the Loop at z ≈ 1300, x 540-1060) and over the causeways (the decks of the
// Loop, the Venetian and the Rickenbacker), every 140 m, sides alternating, angled toward the traffic
// coming at them. Over water they stand on piles (water: true).
function billboards(ctx, out) {
  const rnd = streamOf(ctx, 'billboards'), p = {};
  let k = 0;
  for (const e of ctx.net.edges) {
    const causeway = e.deck?.length && ['loop', 'venetian', 'rickenbacker'].includes(e.road);
    if (!causeway && e.road !== 'loop') continue;
    for (let s = e.trimA + 40 * PX; s < e.len - e.trimB - 20 * PX; s += 140 * PX) {
      at(e, s, p);
      const runway = e.road === 'loop' && p.y / PX > 1280 && p.y / PX < 1320 && p.x / PX > 540 && p.x / PX < 1060;
      if (!(runway || (causeway && onDeck(e, s)))) continue;
      const side = k++ & 1 ? -1 : 1, o = e.halfW + (runway ? 9 : 7) * PX, x = p.x - p.ty * o * side, y = p.y + p.tx * o * side;
      const kind = kindAt(ctx, x / PX, y / PX), water = kind === WATER;
      if (!water && !(VERGE.has(kind) && clearOf(ctx, x / PX, y / PX, 7, BUILD))) continue;
      // traffic on this side drives along +side·tangent: face it, turned 20° toward the road
      const tx = p.tx * side, ty = p.ty * side;
      out.billboards.push({ kind: 'billboard', x, y, a: Math.atan2(-ty, -tx) + 0.35 * side, w: 12, h: 4, pole: 7, water, art: Math.floor(rnd() * 8), edge: e.id });
    }
  }
}

// ---------- furniture ----------

// Busy sidewalks (regions with peds ≥ 0.5) get a bench, a bin or a hydrant every 24 m on their building side;
// quiet ones (the Gables) a hydrant now and then and a shade tree on the lawn. Boulevards and avenues in busy
// regions get a bus stop every 300 m; Lincoln Road a planter every 10 m down both sidewalks.
function furniture(ctx, out) {
  const rnd = streamOf(ctx, 'furniture'), p = {};
  for (const e of ctx.net.edges) {
    const road = ROAD_BY_ID[e.road];
    if (!road || road.private) continue;
    for (const side of [1, -1]) {
      const walk = (side > 0 ? e.walkR : e.walkL) / PX;
      if (walk <= 0) continue;
      const edgeOff = e.halfW / PX + walk, s0 = e.trimA / PX + 5, s1 = e.len / PX - e.trimB / PX - 5;
      if (s1 <= s0) continue;
      if (road.planters) {
        for (let s = s0; s < s1; s += 10) put(ctx, e, side, s, edgeOff - walk / 2, 'planter', out, p);
        continue;
      }
      at(e, ((s0 + s1) / 2) * PX, p);
      const reg = regionAt(ctx, p.x / PX - p.ty * edgeOff * side, p.y / PX + p.tx * edgeOff * side);
      if (!reg) continue;
      const busy = reg.peds >= 0.5;
      let n = 0;
      for (let s = s0 + rnd() * 8; s < s1; s += 24, n++) {
        if (busy) put(ctx, e, side, s, edgeOff - 0.7, ['bench', 'bin', 'hydrant'][n % 3], out, p);
        else if (rnd() < 0.35) put(ctx, e, side, s, edgeOff - 0.5, 'hydrant', out, p);
        if (!busy && reg.style === 'house' && rnd() < 0.55) lawnTree(ctx, e, side, s + 12, edgeOff + 3, rnd, out, p);
      }
      if (busy && (e.cls === 'blvd' || e.cls === 'ave') && s1 - s0 > 120)
        for (let s = s0 + 60 + rnd() * 40; s < s1 - 30; s += 300) put(ctx, e, side, s, edgeOff - 1, 'busStop', out, p);
    }
  }
}

function put(ctx, e, side, s, off, kind, out, p) {
  at(e, s * PX, p);
  const x = p.x / PX - p.ty * off * side, z = p.y / PX + p.tx * off * side;
  if (kindAt(ctx, x, z) !== WALK && kind !== 'planter') return;
  if (kind === 'planter' && kindAt(ctx, x, z) !== WALK && kindAt(ctx, x, z) !== PLAZA) return;
  out.furniture.push({ kind, x: x * PX, y: z * PX, a: Math.atan2(-p.tx * side, p.ty * side), edge: e.id });
}

function lawnTree(ctx, e, side, s, off, rnd, out, p) {
  if (s * PX > e.len - e.trimB) return;
  at(e, s * PX, p);
  const x = p.x / PX - p.ty * off * side, z = p.y / PX + p.tx * off * side;
  if (kindAt(ctx, x, z) === GRASS && clearOf(ctx, x, z, 2.5, BUILD)) out.trees.push({ x: x * PX, y: z * PX, r: (1.4 + rnd() * 0.8) * PX });
}

// ---------- guardrails and barriers ----------

// W-beam on country and switchback roads, each side on its own: where the ground beside the road falls more
// than DROP_RAIL m below it, or on the outside of a bend under BEND_RAIL_R. Runs shorter than 12 m are
// dropped; each run is a polyline RAIL_OFF past the carriageway, stamped BLOCK_CAR 2 m thick on verge cells.
function wbeams(ctx, out) {
  const p = {};
  for (const e of ctx.net.edges) {
    if (e.cls !== 'country' && e.cls !== 'switch') continue;
    const hw = e.halfW / PX, s0 = e.trimA / PX + 4, s1 = e.len / PX - e.trimB / PX - 4;
    for (const side of [1, -1]) {
      let run = null;
      const flush = () => { if (run && run.length >= 12) rail(ctx, e, side, run, out); run = null; };
      for (let s = s0; s <= s1; s += 2) {
        at(e, s * PX, p);
        const k = e.k[Math.min(e.n - 1, p.i)] * PX, R = Math.abs(k) > 1e-6 ? 1 / Math.abs(k) : Infinity;
        const outside = k * side < 0 && R < BEND_RAIL_R;
        const gx = p.x / PX - p.ty * (hw + 6) * side, gz = p.y / PX + p.tx * (hw + 6) * side;
        const drop = e.gy[Math.min(e.n - 1, p.i)] - sampleGrid(ctx.terrain, gx, gz) > DROP_RAIL;
        if (outside || drop) { if (!run) run = { s0: s, length: 0 }; run.s1 = s; run.length = s - run.s0; }
        else flush();
      }
      flush();
    }
  }
}

function rail(ctx, e, side, run, out) {
  const p = {}, off = e.halfW / PX + RAIL_OFF, pts = [];
  for (let s = run.s0; s <= run.s1 + 1e-6; s += 2) {
    at(e, s * PX, p);
    pts.push(p.x / PX - p.ty * off * side, p.y / PX + p.tx * off * side);
  }
  stampLine(ctx, pts, 1, FLAG.BLOCK_CAR, VERGE);
  out.guardrails.push({ kind: 'wbeam', pts: Float32Array.from(pts, v => v * PX), edge: e.id, side, x: pts[0] * PX, y: pts[1] * PX });
}

// Jersey barriers down the middle of the Loop's median on its decks, BLOCK_CAR 2 m thick on the deck cells
// (the lanes start at median/2, 1.5 m out).
function jerseys(ctx, out) {
  const p = {};
  for (const e of ctx.net.edges) {
    if (e.cls !== 'hwy' || !(e.median > 0)) continue;
    for (const [a, b] of e.deck || []) {
      const pts = [];
      for (let s = Math.max(a, 0); s <= Math.min(b, e.len) + 1e-6; s += 2 * PX) { at(e, s, p); pts.push(p.x / PX, p.y / PX); }
      if (pts.length < 4) continue;
      stampLine(ctx, pts, 1, FLAG.BLOCK_CAR, new Set([DECK, ROAD]));
      out.guardrails.push({ kind: 'jersey', pts: Float32Array.from(pts, v => v * PX), edge: e.id, side: 0, x: pts[0] * PX, y: pts[1] * PX });
    }
  }
}

// Sets flag on every cell of the given kinds within r m of the polyline [x0, z0, x1, z1, ...] (m).
function stampLine(ctx, pts, r, flag, kinds) {
  const { surf, W, H } = ctx, r2 = r * r;
  for (let q = 0; q + 3 < pts.length; q += 2) {
    const ax = pts[q], az = pts[q + 1], dx = pts[q + 2] - ax, dz = pts[q + 3] - az, L2 = dx * dx + dz * dz;
    const i0 = Math.max(0, Math.floor(Math.min(ax, ax + dx) - r)), i1 = Math.min(W - 1, Math.ceil(Math.max(ax, ax + dx) + r));
    const j0 = Math.max(0, Math.floor(Math.min(az, az + dz) - r)), j1 = Math.min(H - 1, Math.ceil(Math.max(az, az + dz) + r));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const qx = i + 0.5 - ax, qz = j + 0.5 - az;
      let t = L2 > 0 ? (qx * dx + qz * dz) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = qx - dx * t, ez = qz - dz * t, c = j * W + i;
      if (ex * ex + ez * ez <= r2 && kinds.has(surf[c] & KIND_MASK) && !(surf[c] & FLAG.JCT)) surf[c] |= flag;
    }
  }
}

// ---------- abutments ----------

// GROUND holds a bridge deck's height out past its edge (world-v2 deckGround), also over the dry ground
// beside its ends, where TERRAIN (the visible ground) stays low: a person would walk up an invisible ramp.
// Round both ends of every road deck span, those raised verge cells (GROUND over TERRAIN by more than RAISED
// at a corner) become a wall that blocks cars and people, one record per end and side.
function abutments(ctx, out) {
  const { surf, W, H } = ctx, G = ctx.ground.data, T = ctx.terrain.data, vw = ctx.ground.w, p = {}, seen = new Set();
  for (const e of ctx.net.edges) {
    if (!e.deck?.length) continue;
    const r = e.halfW / PX + Math.max(e.walkL, e.walkR) / PX + ABUT_REACH;
    for (const [a, b] of e.deck) for (const s of [a, b]) {
      at(e, Math.min(Math.max(s, 0), e.len), p);
      const cx = p.x / PX, cz = p.y / PX, tx = p.tx, tz = p.ty, groups = { 1: [], [-1]: [] }, r2 = r * r;
      for (let j = Math.max(0, Math.floor(cz - r)); j <= Math.min(H - 1, Math.ceil(cz + r)); j++)
        for (let i = Math.max(0, Math.floor(cx - r)); i <= Math.min(W - 1, Math.ceil(cx + r)); i++) {
          const c = j * W + i, k = surf[c] & KIND_MASK, x = i + 0.5, z = j + 0.5;
          if ((k !== GRASS && k !== SAND && k !== DIRT) || (x - cx) ** 2 + (z - cz) ** 2 > r2 || seen.has(c)) continue;
          // the cell's four GROUND corners (cell i lies between vertices i >> 1 and its next)
          const v = (j >> 1) * vw + (i >> 1), q1 = v + 1, q2 = v + vw, q3 = v + vw + 1;
          const up = Math.max(G[v] - T[v], G[q1] - T[q1], G[q2] - T[q2], G[q3] - T[q3]);
          if (up <= RAISED) continue;
          const top = Math.max(G[v], G[q1], G[q2], G[q3]), base = Math.min(T[v], T[q1], T[q2], T[q3]);
          seen.add(c);
          surf[c] |= BLOCKS;
          groups[(x - cx) * -tz + (z - cz) * tx >= 0 ? 1 : -1].push([x, z, top, base]);
        }
      for (const side of [1, -1]) if (groups[side].length >= 3) out.fences.push(wallOf(groups[side], cx, cz, tx, tz, side, e));
    }
  }
}

// The box round a wall's cells, aligned with the deck (a along it, w along, d across), with its top and base.
function wallOf(cells, cx, cz, tx, tz, side, e) {
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, top = -Infinity, base = Infinity;
  for (const [x, z, t, b] of cells) {
    const u = (x - cx) * tx + (z - cz) * tz, v = (x - cx) * -tz + (z - cz) * tx;
    u0 = Math.min(u0, u - 0.5); u1 = Math.max(u1, u + 0.5); v0 = Math.min(v0, v - 0.5); v1 = Math.max(v1, v + 0.5);
    top = Math.max(top, t); base = Math.min(base, b);
  }
  const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
  return { kind: 'abutment', x: (cx + tx * um - tz * vm) * PX, y: (cz + tz * um + tx * vm) * PX, a: Math.atan2(tz, tx), w: u1 - u0, d: v1 - v0,
    top: +top.toFixed(2), base: +base.toFixed(2), side, edge: e.id, cells: cells.length };
}

// Bollard rows along the people-only paths that ask for them: both edges, or across the top end.
function bollards(ctx, out) {
  for (const P of PATHS) {
    if (!P.bollards || !P.pts) continue;
    const pts = [];
    if (P.bollards === 'top') {
      const [[ax, az], [bx, bz]] = P.pts, l = Math.hypot(bx - ax, bz - az), tx = (bx - ax) / l, tz = (bz - az) / l;
      for (let o = -P.w / 2; o <= P.w / 2 + 1e-6; o += P.w / 3) pts.push((bx - tz * o) * PX, (bz + tx * o) * PX);
    } else {
      alongLine(P.pts, 2.5, 0, (x, z, tx, tz) => { for (const s of [-1, 1]) pts.push((x - tz * s * P.w / 2) * PX, (z + tx * s * P.w / 2) * PX); });
    }
    if (pts.length) out.fences.push({ kind: 'bollards', pts: Float32Array.from(pts), path: P.id, x: pts[0], y: pts[1] });
  }
}

// ---------- beaches ----------

// Round every coast polygon every 9 m: across the sand from the waterline inland, the dry part (above the
// sea by 0.4 m) gets umbrellas with towels, a lifeguard tower every 12th stop, and the sand's inland edge a
// palm now and then. How full a beach is follows its region's peds.
function beaches(ctx, out) {
  const rnd = streamOf(ctx, 'beaches');
  for (const shapes of Object.values(COAST)) for (const sh of shapes) {
    if (!sh.poly) continue;
    const poly = sh.poly, inward = inwardSign(poly);
    let stop = 0;
    alongLine(poly.concat([poly[0]]), 9, 4.5, (x, z, tx, tz) => {
      const nx = -tz * inward, nz = tx * inward, band = sandBand(ctx, x, z, nx, nz);
      stop++;
      if (!band) return;
      const reg = regionAt(ctx, x + nx * band.o1, z + nz * band.o1), busy = reg ? reg.peds : 0.2;
      const a = Math.atan2(-nz, -nx);      // facing the sea
      const spot = o => ({ x: (x + nx * o) * PX, y: (z + nz * o) * PX });
      if (stop % 12 === 6 && band.o1 - band.o0 > 8) {
        out.beachProps.push({ kind: 'lifeguard', ...spot((band.o0 + band.o1) / 2), a, color: TOWER[stop % TOWER.length] });
      } else if (band.o1 - band.o0 > 6 && rnd() < 0.15 + 0.5 * busy) {
        const o = band.o0 + 2 + rnd() * (band.o1 - band.o0 - 4), q = spot(o), color = UMBRELLA[Math.floor(rnd() * UMBRELLA.length)];
        out.beachProps.push({ kind: 'umbrella', ...q, a: rnd() * Math.PI * 2, color });
        for (const tw of [-1, 1]) {
          const ta = a + tw * 0.4, d = 1.5 * PX;
          out.beachProps.push({ kind: 'towel', x: q.x + Math.cos(ta) * d, y: q.y + Math.sin(ta) * d, a: ta + Math.PI / 2, color: UMBRELLA[Math.floor(rnd() * UMBRELLA.length)] });
        }
      }
      if (stop % 3 === 0 && rnd() < 0.25 + 0.5 * busy) {
        const q = spot(band.o1 - 1.5 - rnd() * 2);
        if (kindAt(ctx, q.x / PX, q.y / PX) === SAND) out.palms.push(palm(rnd, q.x, q.y));
      }
    });
  }
}

// From the coast point inland along (nx, nz): the dry sand's first and last metre { o0, o1 }, or null.
function sandBand(ctx, x, z, nx, nz) {
  let o0 = -1, o1 = -1;
  for (let o = 1; o <= 45; o++) {
    const px = x + nx * o, pz = z + nz * o, b = cellBits(ctx, px, pz), k = b & KIND_MASK;
    if (k === WATER || k === SHALLOW) { if (o0 < 0) continue; break; }
    if (k !== SAND || (b & BLOCKS)) { if (o0 >= 0 || k !== WATER) break; continue; }
    if (o0 < 0) { if (sampleGrid(ctx.ground, px, pz) < SEA_LEVEL + 0.4) continue; o0 = o; }
    o1 = o;
  }
  return o0 >= 0 && o1 - o0 >= 3 ? { o0, o1 } : null;
}

// +1 when the polygon's inside lies on the (−tz, tx) side of its edges, else −1.
function inwardSign(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] - poly[i][0]) * (poly[j][1] + poly[i][1]);
  // a > 0: clockwise in x-right, z-down screen terms, which puts the inside on the right of travel
  return a > 0 ? 1 : -1;
}

// ---------- small helpers ----------

// Calls fn(x, z, tx, tz) every `every` m along a polyline [[x, z], ...] (m), starting `first` m in.
function alongLine(pts, every, first, fn) {
  let next = first, s = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1], l = Math.hypot(bx - ax, bz - az);
    if (l < 1e-9) continue;
    const tx = (bx - ax) / l, tz = (bz - az) / l;
    while (next <= s + l) { const f = next - s; fn(ax + tx * f, az + tz * f, tx, tz); next += every; }
    s += l;
  }
}

function cellBits(ctx, x, z) {
  const i = Math.floor(x), j = Math.floor(z);
  return i < 0 || j < 0 || i >= ctx.W || j >= ctx.H ? WATER | BLOCKS : ctx.surf[j * ctx.W + i];
}
const kindAt = (ctx, x, z) => cellBits(ctx, x, z) & KIND_MASK;

// A lamp or a sign may stand on anything open that is not a road (never in the sea, a building or on a deck).
function standOK(ctx, x, z) {
  const b = cellBits(ctx, x, z);
  return OPEN.has(b & KIND_MASK) && !(b & BLOCKS);
}

// A sign may also stand behind a rail (a cell that blocks only cars).
function signOK(ctx, x, z) {
  const b = cellBits(ctx, x, z);
  return OPEN.has(b & KIND_MASK) && !(b & FLAG.BLOCK_FOOT);
}

// No cell of the given kind within r m of (x, z).
function clearOf(ctx, x, z, r, kind) {
  for (let j = Math.floor(z - r); j <= Math.floor(z + r); j++) for (let i = Math.floor(x - r); i <= Math.floor(x + r); i++)
    if ((cellBits(ctx, i + 0.5, j + 0.5) & KIND_MASK) === kind) return false;
  return true;
}

function regionAt(ctx, x, z) {
  for (const { r, box } of ctx.regs) if (x >= box[0] && x <= box[2] && z >= box[1] && z <= box[3] && insidePoly(r.pts, x, z)) return r;
  return null;
}

// The compass side ('N', 'S', 'E', 'W') a side of an edge looks toward, at its middle.
function compassOf(e, side) {
  const i = e.n >> 1, nx = -e.ty[i] * side, nz = e.tx[i] * side;
  return Math.abs(nx) >= Math.abs(nz) ? (nx > 0 ? 'E' : 'W') : (nz > 0 ? 'S' : 'N');
}

function onDeck(e, s) {
  for (const [a, b] of e.deck || []) if (s >= a && s <= b) return true;
  return false;
}

// The bank (rad) at station s (px): edge.bank holds it every 2 m.
function bankAt(e, s) {
  const nb = e.bank?.length || 0;
  if (!nb) return 0;
  const f = Math.min(Math.max(s / PX / 2, 0), nb - 1), i = Math.floor(f), j = Math.min(i + 1, nb - 1);
  return e.bank[i] + (e.bank[j] - e.bank[i]) * (f - i);
}

// Point and unit tangent of an edge (px) at station s, and the sample index before it.
function at(e, s, out) {
  let lo = 0, hi = e.n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (e.s[m] <= s) lo = m; else hi = m; }
  const ds = e.s[hi] - e.s[lo], f = ds > 1e-9 ? Math.min(1, Math.max(0, (s - e.s[lo]) / ds)) : 0;
  const dx = e.x[hi] - e.x[lo], dy = e.y[hi] - e.y[lo], l = Math.hypot(dx, dy) || 1;
  out.x = e.x[lo] + dx * f; out.y = e.y[lo] + dy * f; out.tx = dx / l; out.ty = dy / l; out.i = lo;
  return out;
}

function bbox(pts) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  return [x0, z0, x1, z1];
}
function insidePoly(pts, x, z) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function strHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }

// ---------- flora (stage P2) ----------
//
// placeFlora(net, grids, regions, opts) is the county's vegetation by region and ground, for src/3d/flora3d.js:
// palm groves on the coasts and the town's streets, banyans and shade trees in the Gables, the parks and the
// gardens, hedges and flowering shrubs round the houses, mangroves round the Glades' water with cypress domes
// and hammocks in the marsh, and woods and scattered trees on the Heights. It returns { trees, palms, shrubs };
// positions are sim px ({x, y}), sizes metres, rot radians:
//   trees   {x, y, kind, h, r, rot}   kind shade | banyan | poinciana | jacaranda | blossom | cypress | mangrove |
//                                     pine; h the top over the ground, r the crown's radius
//   palms   {x, y, h, lean, rot}       world.palms' shape (palms3d draws both)
//   palms in a tree pit on the sidewalk carry pit: true (props3d may draw a grate or a planter round them)
//   shrubs  {x, y, kind, h, r, rot, len?}   kind shrub | seagrape | bougainvillea | hedge | sawgrass (a hedge
//                                     segment runs len m along rot; sawgrass is a tuft of the Glades' marsh)
// opts (all optional): avoid [{x, y, r (px)}], plants already there (the world's palms and trees); keep
// [{x, y}] (px), posts nothing may stand on (lamps, signals, signs, furniture); buildings (world.buildings, for
// the gardens); places (world.places, whose doors, kerbs and givers stay open).
// It only reads SURF, GROUND, TERRAIN, REG and the RoadNet, and draws its numbers from hashes of its own (never
// the world's random stream), so the rasters, their hash and every other prop stay as they are. Nothing grows
// on paving, in water or a building, on a cliff or a cutting, in the pass reveal corridor, across the §4.7
// sightlines, the villa's view or a photo spot's look, or on a landmark, jar or doorstep.
const FL_CELL = 2;          // m: the clearance grids' cell
// what a SURF kind counts as for the clearances: paving (anything people or cars use), carriageway, building
// (cliff rock too), water, sand; FL_OPEN marks the natural kinds a rail or a wall may stand on
const FL_PAVE = 1, FL_ROAD = 2, FL_BUILD = 4, FL_WATER = 8, FL_SAND = 16, FL_OPEN = 32;
const FL_KIND = Uint8Array.from([FL_PAVE | FL_ROAD, FL_PAVE, FL_OPEN, FL_BUILD, FL_PAVE, FL_PAVE, FL_WATER, FL_SAND | FL_OPEN,
  FL_PAVE | FL_ROAD | FL_OPEN, FL_WATER, FL_PAVE | FL_ROAD, FL_BUILD, 0, 0, 0, 0]);
const FL_STEP = 4;          // m: the jittered lattice wild trees are tried on
const FL_SHRUB_STEP = 4;    // m: the same for shrubs
const MAX_CROWN = 11;       // m: the widest crown (a banyan), for the spacing search
const ROOM = 0.62;          // crowns stand at least this times the sum of their radii apart (woods and domes less)
// [h0, h1, r0, r1] (m): the height and crown radius ranges of each tree kind
const TREE_SIZE = {
  shade: [7, 11, 3.2, 5], banyan: [9, 13, 7, 10.5], poinciana: [5.5, 8, 4.5, 6.5], jacaranda: [7, 10, 3.4, 4.8],
  blossom: [4.5, 6.5, 2.4, 3.4], cypress: [10, 17, 1.8, 3], mangrove: [3, 5.5, 2.4, 4], pine: [12, 18, 2.6, 3.8],
};
// Street trees by region: one every `every` m along each side of the town's roads, `off` m past the sidewalk
// (or the shoulder), drawn from `mix` (palm means a palm); p skips some on the country roads.
const STREET_TREES = {
  gables: { every: 15, off: 2.2, mix: [['shade', 6], ['poinciana', 1.4], ['palm', 1.6], ['jacaranda', 0.3]] },
  ktown: { every: 12, off: 1.8, mix: [['shade', 5], ['blossom', 3]], k: 0.8 },
  downtown: { every: 12, off: 1.6, mix: [['palm', 7], ['shade', 2]], pit: true },
  collins: { every: 11, off: 1.6, mix: [['palm', 1]], pit: true },
  deco: { every: 11, off: 1.6, mix: [['palm', 1]], pit: true },
  islets: { every: 10, off: 1.6, mix: [['palm', 3], ['shade', 1]] },
  port: { every: 24, off: 2, mix: [['palm', 1]], p: 0.7 },
  heights: { every: 20, off: 3.5, mix: [['shade', 3], ['palm', 2], ['pine', 1]], p: 0.55 },
  north_shore: { every: 22, off: 3.5, mix: [['shade', 3], ['palm', 2]], p: 0.5 },
  fest_airport: { every: 16, off: 2.5, mix: [['palm', 3], ['shade', 1]], p: 0.7 },
  glades: { every: 24, off: 4, mix: [['palm', 2], ['shade', 1], ['cypress', 1]], p: 0.45 },
  cape: { every: 15, off: 3, mix: [['palm', 1]], p: 0.6 },
};
const STREET_CLS = new Set(['street', 'ave', 'blvd', 'ring', 'coast', 'country', 'switch', 'dirt']);
// The Loop's verges: palms (or trees in the hills) every 26 m, this far past the carriageway, this likely by region
const VERGE_TREES = { every: 26, off: 6.5, p: { heights: 0.3, north_shore: 0.3, glades: 0.35, cape: 0.5 }, town: 0.8 };
// Keep-out radii (m) round the landmarks by kind; the letters keep their whole slope (LETTERS_VIEW) clear.
const LANDMARK_KEEP = { lighthouse: 26, wheel: 30, stage: 24, crane: 16, control_tower: 16, gate: 14, fountain: 18, lookout: 14, arch: 14, pylon: 22 };
const LETTERS_VIEW = { ahead: 150, half: 50 };
// Open ground that stays open: the runway and its strip, Granada Golf Course's fairways (its edges and a few
// clumps get trees).
const RUNWAY = [250, 1495, 1070, 1562];
const GOLF = [560, 700, 670, 940];
// The villa terrace's view (§4.7 SL3, F3's vista): within `half` rad of the bench view's heading, trees stay
// `under` m below the eye, and further under it the further out they are.
const VILLA_VISTA = { half: 0.75, up: 3, under: 2, slope: 0.02, far: 600 };

export function placeFlora(net, grids, regions, opts = {}) {
  const out = { trees: [], palms: [], shrubs: [] };
  if (!grids?.surf || !net?.edges) return out;
  const F = floraContext(net, grids, regions, opts, out);
  streetTrees(F);
  vergeTrees(F);
  wildTrees(F);
  gardens(F);
  wildShrubs(F);
  return out;
}

// The clearance grids (distances in m, on a 2 m grid, to the nearest paving, carriageway, building, water and
// sand), the region and ground lookups, and the keep-outs.
function floraContext(net, grids, regions, opts, out) {
  const W = grids.w, H = grids.h, surf = grids.surf, GW = Math.ceil(W / FL_CELL), GH = Math.ceil(H / FL_CELL);
  // what each 2 m cell holds, as FL_BITS flags (any of its four 1 m cells)
  const bits = new Uint8Array(GW * GH);
  for (let j = 0; j < H; j++) {
    const row = (j >> 1) * GW;
    for (let i = 0; i < W; i++) {
      const b = surf[j * W + i];
      bits[row + (i >> 1)] |= FL_KIND[b & KIND_MASK] | (b & BLOCKS && FL_KIND[b & KIND_MASK] & FL_OPEN ? FL_PAVE : 0);   // rails, walls, bollards
    }
  }
  const edt = flag => chamfer(bits, flag, GW, GH, FL_CELL);
  const [vw, vh] = grids.dims?.ground || [(W >> 1) + 1, (H >> 1) + 1], [RW, RH, RC] = grids.dims?.reg || [W >> 3, H >> 3, 8];
  const ground = { w: vw, h: vh, cell: 2, o: 0, data: grids.ground }, terrain = { w: vw, h: vh, cell: 2, o: 0, data: grids.terrain || grids.ground };
  const F = {
    net, grids, surf, W, H, GW, GH, out, opts, ground, terrain,
    dPave: edt(FL_PAVE), dRoad: edt(FL_ROAD), dBuild: edt(FL_BUILD), dWater: edt(FL_WATER), dSand: edt(FL_SAND),
    regAt: (x, z) => regions[grids.reg?.[Math.min(RH - 1, Math.max(0, Math.floor(z / RC))) * RW + Math.min(RW - 1, Math.max(0, Math.floor(x / RC)))]],
    hash: new Map(), items: [], shrubHash: new Map(), shrubs: [],
  };
  F.discs = keepOuts(F, opts);
  F.rays = sightRays(F);
  F.vista = villaVista(F);
  F.corridors = VIEW_CORRIDORS.map(c => ({ pts: c.pts, box: bbox(c.pts) }));
  for (const p of opts.avoid || []) addItem(F, p.x / PX, p.y / PX, (p.r || 3 * PX) / PX, true);
  return F;
}

// Discs (m) nothing grows in: jars, photo spots, places' doors and kerbs, posts, and round the landmarks.
function keepOuts(F, opts) {
  const discs = [];
  for (const j of JARS) discs.push([j.x, j.z, 4]);
  for (const p of PHOTO_SPOTS) discs.push([p.x, p.z, 6]);
  for (const L of LANDMARKS) if (LANDMARK_KEEP[L.kind] && L.x != null) discs.push([L.x, L.z, LANDMARK_KEEP[L.kind]]);
  for (const p of Object.values(opts.places || {})) for (const s of [p.door, p.foot, p.curb, p.giver, p.hangout]) if (s) discs.push([s.x / PX, s.y / PX, 5]);
  for (const k of opts.keep || []) if (Number.isFinite(k.x)) discs.push([k.x / PX, k.y / PX, 1.6]);
  // a 16 m lookup grid of them
  const grid = new Map();
  for (const d of discs) {
    for (let j = Math.floor((d[1] - d[2]) / 16); j <= Math.floor((d[1] + d[2]) / 16); j++)
      for (let i = Math.floor((d[0] - d[2]) / 16); i <= Math.floor((d[0] + d[2]) / 16); i++) {
        const k = j * 4096 + i;
        (grid.get(k) || grid.set(k, []).get(k)).push(d);
      }
  }
  return grid;
}

// The sightlines trees must stay under: §4.7's SL1 (the Loop eastbound over the pass crest), SL2 and SL3 (the
// villa foot spawn), and the photo spots that look at a landmark. Each { ax, az, ay, bx, bz, by, box }, the eye
// 1.5 m over the road or ground, the far end short of the target by its radius.
function sightRays(F) {
  const rays = [], gy = (x, z) => sampleGrid(F.ground, x, z);
  const add = (ax, az, ay, id) => {
    const T = SIGHT_TARGETS[id];
    if (!T) return;
    const dx = T.x - ax, dz = T.z - az, d = Math.hypot(dx, dz), f = Math.max(0, (d - (T.r || 0)) / d);
    const ty = T.y ?? gy(T.x, T.z) + T.h / 2, bx = ax + dx * f, bz = az + dz * f, by = ay + (ty - ay) * f;
    rays.push({ ax, az, ay, bx, bz, by, box: [Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz)] });
  };
  const v = BENCH_VIEWS.find(b => b.name === 'villa_terrace');
  if (v) for (const id of ['kimchi_tower', 'ktown', 'bay', 'island', 'lighthouse']) add(v.x, v.z, gy(v.x, v.z) + 1.5, id);
  for (const e of F.net.edges) {
    if (e.road !== 'loop') continue;
    for (let i = 0; i < e.n; i += 4) {
      const x = e.x[i] / PX, z = e.y[i] / PX;
      if (x >= 770 && x <= 900 && z < 350) for (const id of ['kimchi_tower', 'causeway_pylon', 'deco_north']) add(x, z, e.gy[i] + 1.5, id);
    }
  }
  add(1560, 311, gy(1560, 311) + 1.5, 'kimchi_tower');
  for (const p of PHOTO_SPOTS) if (p.look) add(p.x, p.z, gy(p.x, p.z) + 1.6, p.look);
  return rays;
}

// The villa terrace's view down over the city: the bench view's eye and heading.
function villaVista(F) {
  const v = BENCH_VIEWS.find(b => b.name === 'villa_terrace');
  return v ? { x: v.x, z: v.z, y: sampleGrid(F.ground, v.x, v.z) + VILLA_VISTA.up, a: v.yaw ?? v.heading } : null;
}

// ---------- flora: the lookups ----------

// Distance (m) from each cell of a w × h grid to the nearest cell whose bits have `flag`: a two-pass 5-7 chamfer
// in whole fifths of a cell (within 1% of the true distance, which is more than these clearances need, and a
// good deal quicker than the exact transform), over a grid padded by one cell so the loops test no bounds.
function chamfer(bits, flag, w, h, cell) {
  const W = w + 2, d = new Uint16Array(W * (h + 2)).fill(65000);
  for (let j = 0; j < h; j++) { const o = (j + 1) * W + 1, r = j * w; for (let i = 0; i < w; i++) if (bits[r + i] & flag) d[o + i] = 0; }
  for (let j = 1; j <= h; j++) for (let k = j * W + 1, e = k + w; k < e; k++) {
    let v = d[k];
    if (v === 0) continue;
    const a = d[k - 1] + 5, b = d[k - W] + 5, c = d[k - W - 1] + 7, q = d[k - W + 1] + 7;
    if (a < v) v = a; if (b < v) v = b; if (c < v) v = c; if (q < v) v = q;
    d[k] = v;
  }
  for (let j = h; j >= 1; j--) for (let k = j * W + w, e = j * W; k > e; k--) {
    let v = d[k];
    if (v === 0) continue;
    const a = d[k + 1] + 5, b = d[k + W] + 5, c = d[k + W + 1] + 7, q = d[k + W - 1] + 7;
    if (a < v) v = a; if (b < v) v = b; if (c < v) v = c; if (q < v) v = q;
    d[k] = v;
  }
  const out = new Float32Array(w * h), s = cell / 5;
  for (let j = 0; j < h; j++) { const o = (j + 1) * W + 1, r = j * w; for (let i = 0; i < w; i++) out[r + i] = d[o + i] * s; }
  return out;
}

const flIdx = (F, x, z) => Math.min(F.GH - 1, Math.max(0, Math.floor(z / FL_CELL))) * F.GW + Math.min(F.GW - 1, Math.max(0, Math.floor(x / FL_CELL)));
// what grows at (x, z) m needs to know: the ground kind and flags, the clearances, the region, height and slope
function ground(F, x, z) {
  const b = cellBits(F, x, z), k = b & KIND_MASK, c = flIdx(F, x, z), reg = F.regAt(x, z);
  const t = F.terrain, gx = (sampleGrid(t, x + 2, z) - sampleGrid(t, x - 2, z)) / 4, gz = (sampleGrid(t, x, z + 2) - sampleGrid(t, x, z - 2)) / 4;
  return { x, z, b, k, reg: reg?.id, peds: reg?.peds ?? 0, y: sampleGrid(F.ground, x, z), slope: Math.hypot(gx, gz),
    dP: F.dPave[c], dR: F.dRoad[c], dB: F.dBuild[c], dW: F.dWater[c], dS: F.dSand[c] };
}

// A number in [0, 1) from integer coordinates and a salt: the same spot always draws the same.
function fhash(i, j, s) {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
// smooth value noise in [0, 1] at (x, z) / scale, two octaves
function fnoise(x, z, scale, s) {
  const one = (x, z, s) => {
    const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    const a = fhash(i, j, s), b = fhash(i + 1, j, s), c = fhash(i, j + 1, s), d = fhash(i + 1, j + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  return one(x / scale, z / scale, s) * 0.65 + one(x / scale * 2.3, z / scale * 2.3, s + 7) * 0.35;
}
const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

function pickMix(mix, u) {
  let t = u * mix.reduce((a, m) => a + m[1], 0);
  for (const [k, w] of mix) if ((t -= w) <= 0) return k;
  return mix[mix.length - 1][0];
}

// ---------- flora: spacing, keep-outs and sightlines ----------

function addItem(F, x, z, r, palm) {
  const it = { x, z, r, palm }, k = Math.floor(z / 8) * 4096 + Math.floor(x / 8);
  (F.hash.get(k) || F.hash.set(k, []).get(k)).push(it);
  return it;
}
// no other tree's crown closer than k·(r + its r), and no trunk within 1.5 m
function room(F, x, z, r, k = ROOM) {
  const reach = (r + MAX_CROWN) * k, i0 = Math.floor((x - reach) / 8), i1 = Math.floor((x + reach) / 8);
  for (let j = Math.floor((z - reach) / 8); j <= Math.floor((z + reach) / 8); j++) for (let i = i0; i <= i1; i++) {
    const list = F.hash.get(j * 4096 + i);
    if (list) for (const o of list) {
      const d = Math.hypot(o.x - x, o.z - z);
      if (d < 1.5 || d < k * (r + o.r)) return false;
    }
  }
  return true;
}
function kept(F, x, z, r) {
  const list = F.discs.get(Math.floor(z / 16) * 4096 + Math.floor(x / 16));
  if (list) for (const [dx, dz, dr] of list) if (Math.hypot(dx - x, dz - z) < dr + r * 0.5) return true;
  return false;
}
// does a plant of top height `top` (m) and crown r at (x, z) cut a sightline, the villa's view or the corridor?
function inView(F, x, z, top, r) {
  for (const c of F.corridors) if (x >= c.box[0] - r && x <= c.box[2] + r && z >= c.box[1] - r && z <= c.box[3] + r && insidePoly(c.pts, x, z)) return true;
  for (const L of LANDMARKS) {
    if (L.kind !== 'letters') continue;
    const fx = Math.cos(L.a), fz = Math.sin(L.a), u = (x - L.x) * fx + (z - L.z) * fz, v = (x - L.x) * -fz + (z - L.z) * fx;
    if (u > -20 && u < LETTERS_VIEW.ahead && Math.abs(v) < LETTERS_VIEW.half + r) return true;
  }
  const margin = r + 4;
  for (const R of F.rays) {
    if (x < R.box[0] - margin || x > R.box[2] + margin || z < R.box[1] - margin || z > R.box[3] + margin) continue;
    const dx = R.bx - R.ax, dz = R.bz - R.az, L2 = dx * dx + dz * dz, t = ((x - R.ax) * dx + (z - R.az) * dz) / L2;
    if (t <= 0.01 || t >= 1) continue;
    const lat = Math.abs((x - R.ax) * dz - (z - R.az) * dx) / Math.sqrt(L2);
    if (lat < margin && top > R.ay + (R.by - R.ay) * t - 1.5) return true;
  }
  const V = F.vista;
  if (V) {
    const dx = x - V.x, dz = z - V.z, d = Math.hypot(dx, dz);
    if (d > 4 && d < VILLA_VISTA.far) {
      const off = Math.abs(Math.atan2(Math.sin(Math.atan2(dz, dx) - V.a), Math.cos(Math.atan2(dz, dx) - V.a)));
      if (off < VILLA_VISTA.half + Math.atan2(r, d) && top > V.y - VILLA_VISTA.under - d * VILLA_VISTA.slope) return true;
    }
  }
  return false;
}

// Plants a tree (or a palm) of `kind` at ground c if it fits: on grass (palms and mangroves also on dry sand),
// clear of paving by trunk m and of buildings, roads and water by its crown, on gentle ground, with room among
// the trees already there, off every keep-out and out of every view. k scales the kind's size; u, v pick it
// within its ranges. Returns the record or null.
function plant(F, c, kind, u, v, { trunk = 2, k = 1, overRoad = 0.75, roomK } = {}) {
  const palm = kind === 'palm';
  let h, r;
  if (palm) { h = (6.5 + u * 4.5) * k; r = 2.6 * k; }
  else {
    const S = TREE_SIZE[kind];
    h = (S[0] + (S[1] - S[0]) * u) * k; r = (S[2] + (S[3] - S[2]) * (u * 0.6 + v * 0.4)) * k;
  }
  if (c.b & BLOCKS) return null;
  const sandOK = palm || kind === 'mangrove';
  if (c.k !== GRASS && !(sandOK && c.k === SAND)) return null;
  if (c.y < SEA_LEVEL + 0.6 || c.slope > 0.6) return null;
  if (c.dP < trunk || c.dR < Math.max(2.5, r * overRoad)) return null;
  if (c.dB < (palm ? 2 : r * 0.85 + 0.5)) return null;
  if (c.dW < (kind === 'mangrove' ? 0.8 : palm ? 2 : 2.5)) return null;
  if (!room(F, c.x, c.z, r, roomK ?? (palm ? 0.5 : ROOM)) || kept(F, c.x, c.z, r) || inView(F, c.x, c.z, c.y + h, r)) return null;
  addItem(F, c.x, c.z, r, palm);
  const rot = fhash(Math.round(c.x * 8), Math.round(c.z * 8), 91) * Math.PI * 2;
  if (palm) {
    const rec = { x: c.x * PX, y: c.z * PX, h, lean: 0.05 + v * 0.16, rot };
    F.out.palms.push(rec);
    return rec;
  }
  const rec = { x: c.x * PX, y: c.z * PX, kind, h: +h.toFixed(2), r: +r.toFixed(2), rot };
  F.out.trees.push(rec);
  return rec;
}

// ---------- flora: the passes ----------

// Street trees on both sides of the town's roads (STREET_TREES); downtown and the island's palms stand in tree
// pits at the kerb when the sidewalk is wide and there is no lawn.
function streetTrees(F) {
  const p = {};
  for (const e of F.net.edges) {
    if (!STREET_CLS.has(e.cls)) continue;
    const road = ROAD_BY_ID[e.road] || {};
    for (const side of [1, -1]) {
      const walk = (side > 0 ? e.walkR : e.walkL) / PX, s0 = e.trimA / PX + 6, s1 = e.len / PX - e.trimB / PX - 6;
      let s = s0 + fhash(e.id, side, 11) * 8, n = 0;
      while (s < s1) {
        at(e, s * PX, p);
        const hw = e.halfW / PX, ex = p.x / PX - p.ty * hw * side, ez = p.y / PX + p.tx * hw * side;
        const R = F.regAt(ex, ez)?.id, rule = STREET_TREES[R];
        if (!rule) { s += 20; continue; }
        const u = fhash(e.id * 7 + side, n, 12), v = fhash(e.id * 7 + side, n, 13), w = fhash(e.id * 7 + side, n, 14);
        n++;
        const inBanyans = road.banyans && p.x / PX >= road.banyans[0] && p.x / PX <= road.banyans[1];
        if (!inBanyans && w < (rule.p ?? 1)) {
          const kind = pickMix(rule.mix, u), off = hw + (walk > 0 ? walk : 1) + rule.off;
          const x = p.x / PX - p.ty * off * side, z = p.y / PX + p.tx * off * side;
          let done = plant(F, ground(F, x, z), kind, v, u, { trunk: 1, k: rule.k ?? 1, overRoad: 0.4 });
          // no lawn: a palm in a tree pit at the kerb (the sidewalk's road third), clear of the lamps and posts
          if (!done && rule.pit && walk >= 3) {
            const o = hw + 0.75, px = p.x / PX - p.ty * o * side, pz = p.y / PX + p.tx * o * side, c = ground(F, px, pz);
            if (c.k === WALK && !(c.b & BLOCKS) && !(c.b & FLAG.JCT) && room(F, px, pz, 2.4, 0.5) && !kept(F, px, pz, 1) && !inView(F, px, pz, c.y + 10, 2.4)) {
              addItem(F, px, pz, 2.4, true);
              F.out.palms.push({ x: px * PX, y: pz * PX, h: 7 + v * 4, lean: 0.03 + u * 0.08, rot: w * Math.PI * 2, pit: true });
            }
          }
        }
        s += rule.every * (0.85 + fhash(e.id, n, 15) * 0.3);
      }
    }
  }
}

// The Loop's verges: a palm (a shade or pine tree in the hills) every VERGE_TREES.every m each side,
// VERGE_TREES.off m past the carriageway, more of them through the towns.
function vergeTrees(F) {
  const p = {};
  for (const e of F.net.edges) {
    if (e.cls !== 'hwy') continue;
    for (const side of [1, -1]) {
      let n = 0;
      for (let s = e.trimA / PX + 10; s < e.len / PX - e.trimB / PX - 10; s += VERGE_TREES.every, n++) {
        if (onDeck(e, s * PX)) continue;
        at(e, s * PX, p);
        const off = e.halfW / PX + VERGE_TREES.off + fhash(e.id, n, 21) * 3, x = p.x / PX - p.ty * off * side, z = p.y / PX + p.tx * off * side;
        const c = ground(F, x, z), chance = VERGE_TREES.p[c.reg] ?? VERGE_TREES.town;
        if (fhash(e.id * 3 + side, n, 22) >= chance) continue;
        const hills = c.reg === 'heights' || c.reg === 'north_shore', u = fhash(e.id * 3 + side, n, 23);
        plant(F, c, hills ? (u < 0.5 ? 'palm' : u < 0.8 ? 'shade' : 'pine') : u < 0.85 ? 'palm' : 'shade', fhash(e.id, n, 24), u, { trunk: 3, overRoad: 0.9 });
      }
    }
  }
}

// What grows wild (or in the yards) at ground c, by region: a kind (or 'palm'), how likely (per 4 m lattice
// point), a size factor k, a spacing roomK (crowns closer than ROOM: woods whose crowns merge) and `under`, the
// chance of a smaller understory tree beside it. Macro noise n (160 m) and grove noise g (45 m) make woods and
// clearings rather than an even sprinkle; m (70 m) and q (55 m) are the Glades' cypress domes and hammocks.
function wildRule(F, c, v) {
  const n = fnoise(c.x, c.z, 160, 31), g = fnoise(c.x, c.z, 45, 32);
  const coast = c.dS < 26 && c.k !== WATER;
  switch (c.reg) {
    case 'heights': case 'north_shore': {
      if (coast) return { p: 0.07, kind: v < 0.75 ? 'palm' : 'shade' };
      const wood = smooth(0.38, 0.62, n * 0.55 + g * 0.45), core = smooth(0.55, 0.72, n * 0.55 + g * 0.45);
      let p = 0.035 + 0.4 * wood + 0.25 * core;
      if (c.reg === 'north_shore' && c.y > 28) p *= 0.3;           // the knoll's crown stays a meadow
      // poincianas are garden trees: only near the houses and the roads, never deep in the woods
      const garden = c.dB < 30 || c.dR < 16;
      const kind = v < 0.12 * (1 - core) ? 'palm' : garden && v < 0.14 ? 'poinciana' : v < (c.y > 30 ? 0.48 : 0.28) ? 'pine' : 'shade';
      return { p, kind, roomK: ROOM - 0.08 * wood - 0.12 * core, under: 0.2 * wood + 0.45 * core };
    }
    case 'gables': {
      if (c.x > GOLF[0] && c.x < GOLF[2] && c.z > GOLF[1] && c.z < GOLF[3]) {
        const edge = Math.min(c.x - GOLF[0], GOLF[2] - c.x, c.z - GOLF[1], GOLF[3] - c.z);
        return { p: edge < 14 ? 0.22 : 0.3 * smooth(0.72, 0.8, g), kind: v < 0.2 ? 'palm' : v < 0.3 ? 'banyan' : 'shade' };
      }
      const yard = c.dB < 40, park = yard ? 0 : smooth(0.62, 0.8, n);
      const p = yard ? 0.07 + 0.3 * smooth(0.35, 0.7, g) : 0.05 + 0.28 * smooth(0.5, 0.75, n) + 0.15 * park;
      // banyans where there is room for one: the open lawns away from the houses
      return { p, kind: v < 0.14 ? 'palm' : v < 0.22 ? 'poinciana' : v < 0.24 ? 'jacaranda' : v < (yard ? 0.27 : 0.34) ? 'banyan' : v < 0.37 ? 'pine' : 'shade',
        roomK: ROOM - 0.15 * park, under: 0.5 * park };
    }
    case 'glades': {
      if (coast) return { p: 0.1, kind: 'palm' };
      // the mangrove fringe round the water: two or three trees deep, its outer edge ragged
      if (c.dW < 6 + 16 * fnoise(c.x, c.z, 24, 35) && c.dS > 6) return { p: 0.6, kind: 'mangrove', roomK: 0.42 + 0.16 * fhash(Math.round(c.x), Math.round(c.z), 36) };
      // cypress domes: tallest in the middle, smaller toward the edge, unevenly spaced
      const dn = fnoise(c.x, c.z, 70, 33), dome = smooth(0.62, 0.7, dn), ham = smooth(0.58, 0.78, fnoise(c.x, c.z, 55, 34));
      if (dome > 0) return { p: 0.55 * dome, kind: 'cypress', k: 0.5 + 0.7 * smooth(0.62, 0.88, dn), roomK: 0.4 + 0.35 * fnoise(c.x, c.z, 9, 36) };
      if (ham > 0) return { p: 0.45 * ham, kind: v < 0.5 ? 'shade' : v < 0.88 ? 'palm' : 'pine', roomK: ROOM - 0.12 * ham };
      return { p: 0.008, kind: v < 0.6 ? 'cypress' : 'palm' };
    }
    case 'fest_airport': {
      if (c.x > RUNWAY[0] && c.x < RUNWAY[2] && c.z > RUNWAY[1] && c.z < RUNWAY[3]) return null;
      if (coast) return { p: 0.12, kind: v < 0.85 ? 'palm' : 'shade' };
      return { p: c.dP > 6 && c.dR < 40 ? 0.06 : 0.012, kind: v < 0.7 ? 'palm' : 'shade' };
    }
    case 'ktown': return { p: 0.08, kind: v < 0.3 ? 'blossom' : v < 0.45 ? 'palm' : 'shade', k: 0.85 };
    case 'downtown': {
      const park = Math.hypot(c.x - 1292, c.z - 612) < 48;       // Bayfront Park
      return { p: park ? 0.24 : 0.06, kind: v < 0.55 ? 'palm' : park && v < 0.7 ? 'banyan' : 'shade', roomK: park ? 0.5 : ROOM };
    }
    case 'port': return { p: 0.025, kind: v < 0.6 ? 'palm' : 'shade' };
    case 'collins': case 'deco': return { p: coast ? 0.08 : 0.12, kind: v < 0.72 ? 'palm' : v < 0.8 ? 'poinciana' : 'shade' };
    case 'islets': return { p: 0.3, kind: v < 0.48 ? 'palm' : v < 0.8 ? 'shade' : v < 0.9 ? 'banyan' : 'poinciana', roomK: 0.52 };
    case 'cape': return { p: coast || c.k === SAND ? 0.1 : c.y > 5 ? 0.06 : 0.03, kind: coast || v < 0.6 ? 'palm' : v < 0.85 ? 'shade' : 'pine' };
  }
  return null;
}

// Wild and yard trees on a jittered 4 m lattice over the whole map, with an understory of shrubs round some.
function wildTrees(F) {
  for (let j = 0; j < F.H / FL_STEP; j++) for (let i = 0; i < F.W / FL_STEP; i++) {
    const x = (i + 0.15 + fhash(i, j, 1) * 0.7) * FL_STEP, z = (j + 0.15 + fhash(i, j, 2) * 0.7) * FL_STEP;
    const k = kindAt(F, x, z);
    if (k !== GRASS && k !== SAND) continue;
    const c = ground(F, x, z), u = fhash(i, j, 3), v = fhash(i, j, 4);
    const rule = wildRule(F, c, v);
    if (!rule || u >= rule.p) continue;
    const t = plant(F, c, rule.kind, fhash(i, j, 5), fhash(i, j, 6), { k: rule.k ?? 1, roomK: rule.roomK });
    if (!t || rule.kind === 'palm' || rule.kind === 'mangrove') continue;
    if (rule.under && fhash(i, j, 9) < rule.under) underTree(F, c, t.r, i, j);
    if (fhash(i, j, 7) < 0.45) understory(F, c, t.r ?? 2.5, i, j);
  }
}

// A smaller shade tree under the edge of a wood's big crown, so the crowns overlap into a canopy.
function underTree(F, c, r, i, j) {
  const a = fhash(i, j, 10) * Math.PI * 2, d = r * (0.7 + fhash(i, j, 11) * 0.35);
  plant(F, ground(F, c.x + Math.cos(a) * d, c.z + Math.sin(a) * d), 'shade', fhash(i, j, 12), fhash(i, j, 13), { k: 0.6 + fhash(i, j, 14) * 0.1, roomK: 0.42 });
}

// One to three shrubs at the edge of a tree's crown.
function understory(F, c, r, i, j) {
  const n = 1 + Math.floor(fhash(i, j, 8) * 3);
  for (let q = 0; q < n; q++) {
    const a = fhash(i, j, 40 + q) * Math.PI * 2, d = r * (0.75 + fhash(i, j, 50 + q) * 0.5);
    shrub(F, c.x + Math.cos(a) * d, c.z + Math.sin(a) * d, c.reg === 'glades' || c.reg === 'cape' ? 'seagrape' : 'shrub', fhash(i, j, 60 + q));
  }
}

// A shrub of `kind` at (x, z) if it fits: on grass (sea grape also on dry sand), off paving and buildings,
// clear of trunks and other shrubs. len: a hedge segment's length along rot.
const SHRUB_SIZE = { shrub: [0.9, 1.6, 0.7, 1.2], seagrape: [1.6, 3.2, 1.4, 2.6], bougainvillea: [1.2, 1.8, 0.8, 1.2], hedge: [0.9, 1.3, 0.5, 0.6],
  sawgrass: [1.0, 1.8, 0.9, 1.5] };
function shrub(F, x, z, kind, u, { rot, len } = {}) {
  const c = ground(F, x, z), S = SHRUB_SIZE[kind];
  if (c.b & BLOCKS || !(c.k === GRASS || (kind === 'seagrape' && c.k === SAND))) return null;
  if (c.y < SEA_LEVEL + 0.8 || c.slope > 0.7 || c.dP < (kind === 'hedge' ? 0.4 : 1) || c.dB < 0.8 || c.dW < (kind === 'sawgrass' ? 0.8 : 1.5)) return null;
  const h = S[0] + (S[1] - S[0]) * u, r = S[2] + (S[3] - S[2]) * u;
  if (kept(F, x, z, r) || inView(F, x, z, c.y + h, r)) return null;
  // trunks (within 1.2 m) and other shrubs (a hedge's own row may touch)
  const k = Math.floor(z / 8) * 4096 + Math.floor(x / 8);
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    for (const o of F.hash.get(k + dj * 4096 + di) || []) if (Math.hypot(o.x - x, o.z - z) < 1.2 + r * 0.5) return null;
    for (const o of F.shrubHash.get(k + dj * 4096 + di) || []) if (Math.hypot(o.x - x, o.z - z) < (kind === 'hedge' ? 0.5 : 0.8) * (r + o.r)) return null;
  }
  (F.shrubHash.get(k) || F.shrubHash.set(k, []).get(k)).push({ x, z, r });
  const rec = { x: x * PX, y: z * PX, kind, h: +h.toFixed(2), r: +r.toFixed(2), rot: rot ?? u * Math.PI * 2 };
  if (len) rec.len = len;
  F.out.shrubs.push(rec);
  return rec;
}

// The houses' and mansions' gardens: a hedge or a row of bougainvillea along the front lawn's street edge
// (a gap for the path to the door), shrubs along the front wall, and palms either side of a mansion's entrance.
function gardens(F) {
  for (const b of F.opts.buildings || []) {
    const style = b.style;
    if (style !== 'house' && style !== 'mansion') continue;
    const fx = Math.cos(b.a), fz = Math.sin(b.a), ax = -fz, az = fx, id = Math.round(b.cx * 13 + b.cz * 7);
    const front = [b.cx + fx * b.d / 2, b.cz + fz * b.d / 2];
    // how far the lawn runs out to the street (the first paving straight out from the door)
    let lawn = 0;
    for (let t = 1.5; t < 26; t += 1) { if (F.dPave[flIdx(F, front[0] + fx * t, front[1] + fz * t)] < 1.1) { lawn = t; break; } }
    const look = fhash(id, 0, 70);
    if (lawn > 4) {
      const t = lawn - 1.3, span = b.w / 2 + 3;
      if (look < 0.45) {
        for (let q = -span; q <= span; q += 2.4) if (Math.abs(q) > 1.7)
          shrub(F, front[0] + fx * t + ax * q, front[1] + fz * t + az * q, 'hedge', fhash(id, Math.round(q * 4), 71), { rot: Math.atan2(az, ax), len: 2.3 });
      } else if (look < 0.7) {
        for (let q = -span; q <= span; q += 2.6) if (Math.abs(q) > 1.7)
          shrub(F, front[0] + fx * t + ax * q, front[1] + fz * t + az * q, 'bougainvillea', fhash(id, Math.round(q * 4), 72));
      }
    }
    for (const q of [-0.4, -0.2, 0.2, 0.4]) if (fhash(id, q * 10, 73) < 0.7)
      shrub(F, front[0] + fx * 1.4 + ax * q * b.w, front[1] + fz * 1.4 + az * q * b.w, fhash(id, q * 10, 74) < 0.3 ? 'bougainvillea' : 'shrub', fhash(id, q * 10, 75));
    if (style === 'mansion' && lawn > 6) for (const sd of [-1, 1]) {
      const x = front[0] + fx * 3.5 + ax * sd * (b.w / 2 + 1.5), z = front[1] + fz * 3.5 + az * sd * (b.w / 2 + 1.5);
      plant(F, ground(F, x, z), 'palm', fhash(id, sd, 76), fhash(id, sd, 77), { trunk: 1 });
    }
  }
}

// Shrubs on their own: sea grape along the beaches' dry inland edge, scrub through the wild ground gathered into
// thickets (along the woods' edges, the road verges and the banks, hardly any out on an open lawn), and the
// Glades' sawgrass in its marsh patches and round the water.
const WILD_SHRUBS = { heights: 0.07, north_shore: 0.09, cape: 0.14, glades: 0.045, fest_airport: 0.02 };   // per 16 m² lattice point
function wildShrubs(F) {
  for (let j = 0; j < F.H / FL_SHRUB_STEP; j++) for (let i = 0; i < F.W / FL_SHRUB_STEP; i++) {
    const x = (i + 0.2 + fhash(i, j, 81) * 0.6) * FL_SHRUB_STEP, z = (j + 0.2 + fhash(i, j, 82) * 0.6) * FL_SHRUB_STEP;
    const k = kindAt(F, x, z);
    if (k !== GRASS && k !== SAND) continue;
    const u = fhash(i, j, 83);
    if (k === SAND) {
      // the dune's crest and back: dry, with grass within a few metres
      if (u < 0.35 && [[4, 0], [-4, 0], [0, 4], [0, -4]].some(([a, b]) => kindAt(F, x + a, z + b) === GRASS) && sampleGrid(F.ground, x, z) > 1.4)
        shrub(F, x, z, 'seagrape', fhash(i, j, 84));
      continue;
    }
    // (the cheap lookups first: most points grow nothing, and ground() is the costly part)
    const reg = F.regAt(x, z)?.id, ci = flIdx(F, x, z);
    if (reg === 'glades' && sawgrass(F, x, z, F.dWater[ci], i, j)) continue;
    const wild = WILD_SHRUBS[reg] || 0, beds = (reg === 'ktown' || reg === 'downtown' || reg === 'deco' || reg === 'collins') && F.dBuild[ci] < 3 ? 0.44 : 0;
    if (u >= Math.max(beds, Math.min(0.6, wild * 4.6))) continue;
    let rate = beds;
    if (wild && u < Math.min(0.6, wild * 4.6)) {
      const clump = smooth(0.42, 0.68, fnoise(x, z, 40, 87)), c = ground(F, x, z);
      const where = Math.max(nearTree(F, x, z, 3.5) ? 1 : 0, c.dR < 16 ? 0.75 : 0, smooth(0.15, 0.4, c.slope) * 0.85, c.dS < 20 ? 1 : 0);
      rate = Math.max(rate, Math.min(0.6, wild * (0.08 + 4.5 * clump * where)));
    }
    if (u < rate) shrub(F, x, z, F.dSand[ci] < 20 ? 'seagrape' : beds && fhash(i, j, 85) < 0.3 ? 'bougainvillea' : 'shrub', fhash(i, j, 86));
  }
}

// Whether a tree's crown (or a palm) comes within pad m of (x, z).
function nearTree(F, x, z, pad) {
  const k = Math.floor(z / 8) * 4096 + Math.floor(x / 8);
  for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++)
    for (const o of F.hash.get(k + dj * 4096 + di) || []) if (Math.hypot(o.x - x, o.z - z) < o.r + pad) return true;
  return false;
}

// The Glades' sawgrass at lattice point (i, j), (x, z) m, dW m from water: one to three tufts, thick in the marsh
// patches (marshAt) and round the water, a few elsewhere. True if this point was the marsh's (no other shrub then).
function sawgrass(F, x, z, dW, i, j) {
  const m = Math.max(marshAt(x, z), smooth(26, 6, dW) * 0.85);
  if (fhash(i, j, 88) >= 0.06 + 0.8 * m) return false;
  const n = 1 + Math.floor(fhash(i, j, 89) * (1 + 2.2 * m));
  for (let q = 0; q < n; q++) {
    const a = fhash(i, j, 90 + q) * Math.PI * 2, d = q ? 1.2 + fhash(i, j, 93 + q) * 0.8 : 0, sx = x + Math.cos(a) * d, sz = z + Math.sin(a) * d;
    if (!q || F.regAt(sx, sz)?.id === 'glades') shrub(F, sx, sz, 'sawgrass', fhash(i, j, 96 + q));
  }
  return true;
}

// How much of the Glades' marsh at (x, z) m is sawgrass, in [0, 1]: irregular patches some 30 m across. Both
// placeFlora's sawgrass tufts and flora3d's tall marsh grass follow it, so the two grow together.
export function marshAt(x, z) {
  return smooth(0.42, 0.62, fnoise(x, z, 34, 37));
}
