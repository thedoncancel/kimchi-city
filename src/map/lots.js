// Kimchi Key v2 building lots (docs/map-v2-spec.md §2, §3, §4.7, §6.4, §7). Pure data and functions: no three,
// no DOM.
//
// placeBuildings(net, regions, grids, rng, opts) returns the map's buildings: the prefab buildings it is
// given, then the frontage lots. Both sides of every urban edge are walked along their frontage line (the
// road's half width, that side's sidewalk and the style's setback) and lots are laid end to end in the STYLE of
// the region they stand in. A lot is kept only when its footprint is open grass on the SURF raster, clear of
// other roads, water and the highway, of prefab pads, junction zones (r_j + 6 m), landmarks and every building
// placed before it, on ground flat enough for a pad, and level enough with the lots padded before it that its
// pad's blend neither buries nor undermines them. Each faces its road, its front at least EAVE_M off the
// carriageway (where a road has no sidewalk, Neon Alley, the strip between is paved), takes its floors from its
// region, capped by the region's maxH, the VIEW_CORRIDORS and the §4.7 sightlines (no lot hides a landmark the drive
// is built around), and gets a door on its front, the deliver flag when a car can pull up at its curb, and
// colours from its style. Every edge side has its own random stream, so a change on one street never
// reshuffles another. At most cap buildings come back.
//   net      the RoadNet (px)
//   regions  the world's region list (REGIONS rows plus the 'sea' entry)
//   grids    the rasters built so far: surf (1 m kinds and flags), ground and terrain (2 m vertices), w, h
//   rng      a seeded random () => [0, 1); its first draw seeds the lot streams
//   opts     { prefabs: the prefab buildings, corridors: VIEW_CORRIDORS (height caps), exclusions: [{poly}]
//              areas no lot may use (prefab pads, the anchors' yards), cap: 450, stats?: {} to count the
//              plots turned down, by reason }
// Every building it returns is in the prefab format (world metres): { cx, cz, w (across the front), d (deep),
// a (the way the front faces), h, floors, wall, roof, trim, sign, awning, house, shop, kind, style, place?,
// deliver?, door: {x, z, a} }; a lot also says which edge and side it fronts. world-v2 pads each new lot flat,
// stamps it into SURF and OCC and turns it into the §6.4 record (ids, base, door and curb in px, region, tile,
// cell).
//
// Kimchi Tower (§2, §5.7) stands on Kimchi Plaza, the one thing written here: the grass of its block becomes
// PLAZA in grids.surf. With TOWER_BUILDING (the lead's decision) the tower is a full building: it comes back
// first after the prefabs, as { kind: 'landmark', landmark: 'kimchi_tower', ... }, so world-v2 stamps its
// footprint BUILD, puts its 140 m into OCC and lists it in world.buildings. The §4.7 rays to it stop 23 m
// short (mapdata SIGHT_TARGETS), past the corners of its 32 m square, and the villa's island ray runs north of
// it. Without TOWER_BUILDING only its footprint is stamped BUILD here and the renderers build the shell from
// the landmark record.
import { KIND, KIND_MASK, FLAG, CURB, sampleGrid, fillPoly } from './raster.js';
import { LANDMARKS, ROADS, BENCH_VIEWS, SIGHT_TARGETS } from './mapdata.js';
import { mulberry32 } from '../util.js';

// Region building styles: storey ranges, wall, roof, trim and awning palettes, and the ground-floor shop
// share. A region row's own floors (mapdata REGIONS) wins over the style's.
export const STYLE = {
  tower:     { floors: [12, 45], storey: 3.4, shop: 0.6, walls: ['#cfd8da', '#bfcfe0', '#d9d4cc', '#e9e6e0'], roofs: ['#4f5b63', '#4a4a52'],
    trims: [null, '#e9e6e0', '#9aa4a8'], awnings: ['#2f6fd6', '#3d9a6a', '#4a4a52'] },
  ktown:     { floors: [3, 6], storey: 3.2, shop: 0.9, walls: ['#efe5d3', '#e8c4b4', '#d6c8e2', '#f0d9a8'], roofs: ['#5f5a56', '#4a4a52'],
    trims: [null, '#d6402b', '#3d9a6a'], awnings: ['#d6402b', '#e8622c', '#3d9a6a', '#8a5cc2', '#2f6fd6'] },
  deco:      { floors: [2, 4], storey: 3.3, shop: 0.5, walls: ['#f7c6d0', '#bfe8e0', '#fbe3a6', '#cfe3f7'], roofs: ['#efe5d3', '#e9e6e0'],
    trims: ['#ffffff', '#7fd1c7', '#ff8fb1', '#ffd166'], awnings: ['#ff8fb1', '#7fd1c7', '#ffd166', '#9ab8ff'] },
  resort:    { floors: [8, 18], storey: 3.2, shop: 0.2, walls: ['#f4f1ea', '#e6e9ee', '#f2e8d8'], roofs: ['#d9d4cc', '#c9c6c0'],
    trims: ['#7fd1c7', '#ffffff', '#9ab8ff'], awnings: ['#7fd1c7', '#f6f4ee'] },
  // the Gables' Mediterranean Revival: warm stucco (cream, peach, sand, ochre, blush) under terracotta barrel tiles
  house:     { floors: [1, 2], storey: 3.0, shop: 0, walls: ['#f4e3c4', '#f2d2b4', '#ead6b8', '#f0dca8', '#f3d6c8', '#efe6d6'],
    roofs: ['#c4623f', '#b5533c', '#d27a4c', '#a9493a'], trims: ['#ffffff', null], awnings: [] },
  mansion:   { floors: [2, 3], storey: 3.2, shop: 0, walls: ['#f4f1ea', '#efe0d0', '#e6e9ee'], roofs: ['#3c3a37', '#5f5a56'],
    trims: [null, '#ffffff'], awnings: [] },
  estate:    { floors: [1, 3], storey: 3.2, shop: 0, walls: ['#f4f1ea', '#e9e6e0'], roofs: ['#5f5a56', '#6e5848'], trims: [null], awnings: [] },
  warehouse: { floors: [1, 2], storey: 5.0, shop: 0, walls: ['#ff8fb1', '#7fd1c7', '#ffd166', '#9ab8ff'], roofs: ['#6e7378', '#5c6b6e'],
    trims: [null, '#f6f4ee'], awnings: [] },
  shack:     { floors: [1, 1], storey: 3.0, shop: 0, walls: ['#c9b48a', '#a8b59a', '#bfa58a'], roofs: ['#6e5848', '#686d58'], trims: [null], awnings: [] },
  hangar:    { floors: [1, 1], storey: 12, shop: 0, walls: ['#e9e6e0', '#d9d4cc'], roofs: ['#6e7378'], trims: [null], awnings: [] },
  none:      { floors: [1, 1], storey: 3.0, shop: 0, walls: ['#e9e6e0'], roofs: ['#5f5a56'], trims: [null], awnings: [] },
};

// How each lot style lines its streets: width across the front and depth (m), the gap to the next lot,
// the setback from the sidewalk (lawns for houses, drives for mansions), the share of plots left empty, the
// most the ground may fall across a footprint (m between its corners), the floors' skew (above 1 favours
// the low end), and the road classes it fronts. The other styles (estate, shack, hangar, none) get no lots:
// their regions are built by prefabs or left open.
const URBAN = new Set(['blvd', 'ave', 'street', 'ring', 'alley']);
const LOTS = {
  tower:     { w: [24, 34], d: [22, 30], gap: [3, 7], set: 1, empty: 0.06, fall: 2.5, skew: 1.7, on: URBAN },
  ktown:     { w: [10, 15], d: [12, 18], gap: [1, 2.5], set: 0.5, empty: 0.04, fall: 2.5, skew: 1, on: URBAN },
  deco:      { w: [14, 22], d: [14, 20], gap: [2, 4.5], set: 1, empty: 0.05, fall: 2.5, skew: 1, on: URBAN },
  resort:    { w: [24, 36], d: [18, 26], gap: [4, 9], set: 4, empty: 0.08, fall: 3, skew: 1.2, on: URBAN },
  house:     { w: [11, 15], d: [10, 13], gap: [9, 16], set: 7, empty: 0.12, fall: 3, skew: 1, on: URBAN },
  mansion:   { w: [18, 26], d: [14, 18], gap: [20, 34], set: 6, empty: 0.15, fall: 7, skew: 1, on: new Set(['country', 'street', 'coast']) },
  warehouse: { w: [28, 44], d: [22, 32], gap: [4, 9], set: 4, empty: 0.08, fall: 3, skew: 1, on: new Set(['blvd', 'ave', 'street']) },
};

const PX = 16;                 // sim px per metre (the RoadNet's units)
const DOOR_OUT = 1.4;          // m: a door sits this far in front of its wall, as on the grid (prefabs.js)
const CURB_M = 10;             // m: world-v2 puts a building's curb this far out from its door
const GAP = 1;                 // m: every footprint keeps this much clear round it (see markOBB)
const SIDE_M = 1.5;            // m: no carriageway within this of a lot's sides and back
const WET_M = 6;               // m: no water within a pad's blend of a lot, so a pad never lifts the sea bed
const HWY_M = 6;               // m: lots keep this far off the highway
const JCT_M = 6;               // m: past a junction's widest trim, the junction zone of §7 (r_j + 6 m)
const RAY_M = 2.5;             // m: a lot this close to a sightline's ground track stays under it
const EAVE_M = 2.4;            // m: a front stays this far off the carriageway, so awnings and blade signs (1.35 m
                               // out) never hang over it where a road has no sidewalk (Neon Alley)
const PAD_BLEND = 6;           // m: world-v2 eases every lot's pad back to the ground over this (terrain.pad)
const LEVEL_M = 0.3;           // m: a lot whose pad's blend reaches an earlier lot stands at most this much higher
                               // (the blend would bury the earlier one's floor on that side) ...
const DROP_M = 1.2;            // m: ... and at most this much lower (it would pull the ground out from under the
                               // earlier one's floor, past the plain wall buildings3d runs below it)
const PLAZA_KT = [1146, 470, 1222, 560];   // Kimchi Plaza round the tower (m), on the grass of its block
const TOWER_BUILDING = true;               // the tower as a building (in OCC): see the header

// Open ground the map keeps clear of lots (§2): the Granada golf course, Bayfront Park, the Port Yard's
// drift loop. Rectangles [x0, z0, x1, z1] or polygons (m).
const KEEP_CLEAR = [
  { id: 'granada_golf', rect: [560, 700, 670, 940] },
  { id: 'bayfront_park', rect: [1240, 560, 1330, 680] },
  { id: 'port_yard', road: 'port_yard' },
];
// A landmark's ground footprint (m) that lots keep off: its own size where mapdata gives one, else these.
const LANDMARK_R = { resort: 34, wheel: 24, stage: 16, crane: 9, control_tower: 8, lighthouse: 10, letters: 46, gate: 12, arch: 14,
  fountain: 10, lookout: 6, pylon: 6 };

// The §4.7 sightlines (tools/map_check.mjs tests them): eyes 1.5 m over the ground, rays to each target's
// mid-height that end r metres short of its centre (mapdata SIGHT_TARGETS, which map_check reads too). A lot
// under one of these rays is held below it.
//  SL1 the Loop eastbound over the pass crest (stations 2016-2100, x 785-868), SL2 the Loop westbound at
//  (1560,311), SL3 the villa foot spawn (the villa terrace's vista down on K-Town and over the bay).
const SIGHTLINES = [
  { loop: [770, 885, 300, 345], step: 6, to: ['kimchi_tower', 'causeway_pylon', 'deco_north'] },
  { loop: [1545, 1575, 300, 325], step: 6, to: ['kimchi_tower'] },
  { view: 'villa_terrace', to: ['kimchi_tower', 'ktown', 'bay', 'island', 'lighthouse'] },
];

const { ROAD, WALK, GRASS, BUILD, WATER, DIRT, SHALLOW, DECK } = KIND;
const BLOCKS = FLAG.BLOCK_CAR | FLAG.BLOCK_FOOT;
const ROAD_BY_ID = Object.fromEntries(ROADS.map(r => [r.id, r]));

export function placeBuildings(net, regions, grids, rng, { prefabs = [], corridors = [], exclusions = [], cap = 450, stats = null } = {}) {
  const ctx = makeContext(net, regions, grids, rng, corridors, stats);
  if (!ctx) return prefabs.slice(0, cap);
  reserve(ctx, net, prefabs, exclusions);
  const tower = kimchiTower(ctx);
  let lots = [];
  // main roads first, so they get the corner plots
  const edges = net.edges.filter(e => fronts(e)).sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0) || a.id - b.id);
  for (const e of edges) for (const side of [1, -1]) walkSide(ctx, e, side, lots);
  // over the cap, drop lots at random (each lot drew its own key), never a prefab or the tower
  const room = Math.max(0, cap - prefabs.length - (TOWER_BUILDING && tower ? 1 : 0));
  if (lots.length > room) {
    const keep = new Set(lots.slice().sort((a, b) => ctx.keys.get(b) - ctx.keys.get(a)).slice(0, room));
    lots = lots.filter(b => keep.has(b));
  }
  return prefabs.concat(TOWER_BUILDING && tower ? [tower] : [], lots).slice(0, cap);
}

// ---------- the working set ----------

function makeContext(net, regions, grids, rng, corridors, stats) {
  const surf = grids.surf, W = grids.w, H = grids.h;
  if (!surf || !grids.ground || !W) return null;
  const [vw, vh] = grids.dims?.ground || [(W >> 1) + 1, (H >> 1) + 1];
  const ground = { w: vw, h: vh, cell: 2, o: 0, data: grids.ground };
  const terrain = { w: vw, h: vh, cell: 2, o: 0, data: grids.terrain || grids.ground };
  const regs = regions.filter(r => r.pts).map(r => ({ r, box: bbox(r.pts) }));
  const ctx = { net, surf, W, H, ground, terrain, regs, corridors: corridors.map(c => ({ ...c, box: bbox(c.pts) })),
    taken: new Uint8Array(W * H), seed: (rng() * 4294967296) >>> 0, rays: [], keys: new Map(), stats, pads: [] };
  ctx.rays = sightRays(ctx);
  return ctx;
}

// What no lot may use, marked in ctx.taken: prefab pads and yards, prefab buildings (with the gap round them),
// the keep-clear areas, landmark footprints, and every junction zone.
function reserve(ctx, net, prefabs, exclusions) {
  const T = { w: ctx.W, h: ctx.H, cell: 1, o: 0.5, data: ctx.taken };
  for (const x of exclusions) fillPoly(T, x.poly, 1);
  for (const b of prefabs) markOBB(ctx, b.cx, b.cz, b.w + 2 * GAP, b.d + 2 * GAP, b.a);
  for (const k of KEEP_CLEAR) {
    if (k.rect) { const [x0, z0, x1, z1] = k.rect; fillPoly(T, [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], 1); }
    else if (k.road) fillPoly(T, ROAD_BY_ID[k.road].pts, 1);
  }
  for (const L of LANDMARKS) {
    if (L.x === undefined || L.id === 'kimchi_tower') continue;
    const r = L.kind === 'tower' ? Math.hypot(L.w, L.d) / 2 : LANDMARK_R[L.kind];
    if (r) markDisc(ctx, L.x, L.z, r + GAP);
  }
  for (const N of net.nodes) {
    if (!N.ends || N.ends.length < 3) continue;
    let r = 0;
    for (const E of N.ends) r = Math.max(r, E.trim);
    markDisc(ctx, N.x / PX, N.y / PX, r / PX + JCT_M);
  }
}

// ---------- Kimchi Tower (§2, §5.7) ----------
// The landmark's shell (its LED crown belongs to the landmarks): 32 × 32 m, 140 m, facing the way the landmark
// does, on Kimchi Plaza, which takes the grass of its block. Its door faces the plaza. Its footprint is BUILD in
// SURF either way: stamped here without TOWER_BUILDING, by world-v2 with the other buildings with it (see the
// header).
function kimchiTower(ctx) {
  const L = LANDMARKS.find(l => l.id === 'kimchi_tower');
  if (!L) return null;
  const [x0, z0, x1, z1] = PLAZA_KT, surf = ctx.surf, W = ctx.W, a = L.a || 0, st = STYLE.tower;
  for (let j = z0; j < z1; j++) for (let i = x0; i < x1; i++) {
    const c = j * W + i;
    if (surf[c] !== GRASS) continue;
    surf[c] = inOBB(i + 0.5, j + 0.5, L.x, L.z, L.w, L.d, a) && !TOWER_BUILDING ? BUILD | BLOCKS : KIND.PLAZA;
    ctx.taken[c] = 1;
  }
  markOBB(ctx, L.x, L.z, L.w + 2 * GAP, L.d + 2 * GAP, a);
  return {
    cx: L.x, cz: L.z, w: L.w, d: L.d, a, h: L.h, floors: Math.round(L.h / st.storey), wall: '#bfcfe0', roof: '#4f5b63', trim: '#e9e6e0',
    sign: 'KIMCHI TOWER', awning: null, house: false, shop: true, kind: 'landmark', style: 'tower', landmark: L.id, deliver: true,
    door: doorOf(L.x, L.z, L.d, a),
  };
}

// ---------- frontage ----------

function fronts(e) {
  const road = ROAD_BY_ID[e.road];
  if (!road || road.private || e.cls === 'hwy') return false;
  for (const st of Object.values(LOTS)) if (st.on.has(e.cls)) return true;
  return false;
}

// One side of an edge (side +1 = the right of its point order, -1 the left), from junction to junction: a
// plot of the style's width at a time, then its gap, or a few metres on when the plot does not fit.
function walkSide(ctx, e, side, out) {
  const road = ROAD_BY_ID[e.road];
  if (road.park && compassOf(e, side) === road.park) return;          // Lummus Park and the Beachwalk side
  const rnd = mulberry32((ctx.seed ^ strHash(e.road) ^ Math.imul(e.id + 1, 0x9e3779b1) ^ (side > 0 ? 0x51ed27 : 0x2f6b4a)) >>> 0);
  const hw = e.halfW / PX, walk = (side > 0 ? e.walkR : e.walkL) / PX, len = e.len / PX, p = {};
  const end = len - e.trimB / PX;
  for (let s = e.trimA / PX + 2; s < end;) {
    // the plot's style is its region's, probed a typical lot depth behind the frontage
    at(e, s * PX, p);
    const nx = -p.ty * side, nz = p.tx * side, probe = hw + walk + 12;
    const reg = regionAt(ctx, p.x / PX + nx * probe, p.y / PX + nz * probe), style = reg?.style, L = LOTS[style];
    if (!L || !L.on.has(e.cls)) { s += 8; continue; }
    const w = pick(rnd, L.w), d = pick(rnd, L.d), gap = pick(rnd, L.gap), keep = rnd();
    if (rnd() < L.empty) { s += w * 0.6 + gap; continue; }
    if (s + w > end) break;
    // the front stands its setback past the sidewalk, and at least EAVE_M off the carriageway; a plot that does
    // not fit is tried once more at the style's smallest size
    const front = hw + Math.max(walk + L.set, EAVE_M);
    const lot = tryLot(ctx, e, side, s + w / 2, w, d, front, L, reg, rnd) ||
      tryLot(ctx, e, side, s + L.w[0] / 2, L.w[0], L.d[0], front, L, reg, rnd);
    if (!lot) { s += 3; continue; }
    ctx.keys.set(lot, keep);
    out.push(lot);
    s += w + gap;
  }
}

// A lot of w × d centred at station sc (m) on one side, its front setback m off the road's centre line, or
// null when it does not fit there.
const P = {};
function tryLot(ctx, e, side, sc, w, d, front, L, reg, rnd) {
  if (onDeck(e, sc * PX)) return no(ctx, 'deck');
  at(e, sc * PX, P);
  const k = e.k ? e.k[Math.min(e.n - 1, P.i)] * PX : 0;                 // 1/m, positive bends right
  // on the inside of a bend the front corners reach toward the road by the sagitta, so step back by it
  const sag = k * side > 0 ? (w * w / 8) * Math.abs(k) : 0;
  const nx = -P.ty * side, nz = P.tx * side, off = front + sag + d / 2;
  const cx = P.x / PX + nx * off, cz = P.y / PX + nz * off, a = Math.atan2(-nz, -nx);
  if (regionAt(ctx, cx, cz) !== reg) return no(ctx, 'region');
  if (!footprintFree(ctx, cx, cz, w, d, a, Math.min(SIDE_M, L.set * 0.9))) return no(ctx, 'taken');
  if (wetOrHighway(ctx, cx, cz, w, d, a)) return no(ctx, 'water');
  const base = padHeight(ctx, cx, cz, w, d, a, L.fall);
  if (base === null) return no(ctx, 'slope');
  const poly = obbCorners(cx, cz, w, d, a);
  if (!levelWithNeighbours(ctx, poly, base)) return no(ctx, 'level');
  const style = reg.style, st = STYLE[style];
  const hMax = Math.min(reg.maxH ?? Infinity, corridorCap(ctx, cx, cz, w, d, a), rayCap(ctx, cx, cz, w, d, a, base));
  const [f0, f1] = floorsFor(reg, e, cz);
  let floors = f0 + Math.floor((f1 - f0 + 1) * Math.pow(rnd(), L.skew));
  if (floors * st.storey > hMax) floors = Math.floor(hMax / st.storey);
  if (floors < 1) return no(ctx, 'height');
  const door = doorOf(cx, cz, d, a), shop = rnd() < st.shop;
  const b = {
    cx, cz, w, d, a, h: floors * st.storey, floors, wall: pickOf(rnd, st.walls), roof: pickOf(rnd, st.roofs), trim: pickOf(rnd, st.trims) ?? null,
    sign: null, awning: shop ? pickOf(rnd, st.awnings) ?? null : null, house: style === 'house' || (style === 'mansion' && reg.id === 'islets'),
    shop, kind: 'lot', style, deliver: deliverable(ctx, door), door, edge: e.id, side,
  };
  markOBB(ctx, cx, cz, w + 2 * GAP, d + 2 * GAP, a);
  ctx.pads.push({ poly, y: base, box: bbox(poly) });
  if ((side > 0 ? e.walkR : e.walkL) <= 0) paveApron(ctx, e, side, sc, w, front);
  return b;
}

// A rejected plot, counted by reason in opts.stats when the caller passes one (tools/s2c_lots_test.mjs).
function no(ctx, why) {
  if (ctx.stats) ctx.stats[why] = (ctx.stats[why] || 0) + 1;
  return null;
}

// The floor range for a lot: the region's own (mapdata REGIONS) or its style's, with Downtown's low-rise
// north row and Ocean Drive's taller hotels (Collins Ave south of altFromZ).
function floorsFor(reg, e, cz) {
  if (reg.lowRise && cz < reg.lowRise.z1) return reg.lowRise.floors;
  const road = ROAD_BY_ID[e.road];
  if (reg.oceanDrive && road.altFromZ !== undefined && cz >= road.altFromZ) return reg.oceanDrive.floors;
  return reg.floors || STYLE[reg.style].floors;
}

// The door, DOOR_OUT in front of the middle of the front wall.
function doorOf(cx, cz, d, a) {
  const r = d / 2 + DOOR_OUT;
  return { x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r, a };
}

// A delivery can end here when someone can stand at the door and a car can stop at the curb (CURB_M out
// along the facing, as world-v2 places it) on a road or a lot that is not the highway.
function deliverable(ctx, door) {
  const b0 = cellBits(ctx, door.x, door.z), k0 = b0 & KIND_MASK;
  if (b0 & BLOCKS || k0 === WATER || k0 === SHALLOW) return false;
  const b1 = cellBits(ctx, door.x + Math.cos(door.a) * CURB_M, door.z + Math.sin(door.a) * CURB_M), k1 = b1 & KIND_MASK;
  return !(b1 & (BLOCKS | FLAG.NOPED)) && (k1 === ROAD || k1 === KIND.LOT || k1 === KIND.PLAZA || k1 === WALK);
}

// ---------- rejection on the rasters ----------

// The footprint is open grass nobody has taken, and no carriageway (or building) lies within the margin
// round its sides and back, nor within `front` m before its front (its own road's sidewalk is fine).
function footprintFree(ctx, cx, cz, w, d, a, front) {
  const { surf, taken, W, H } = ctx, fx = Math.cos(a), fz = Math.sin(a), rx = fz, rz = -fx;
  const hw = w / 2, hd = d / 2, m = SIDE_M, uw = hw + m;
  const ex = Math.abs(rx) * uw + Math.abs(fx) * (hd + m), ez = Math.abs(rz) * uw + Math.abs(fz) * (hd + m);
  const i0 = Math.max(0, Math.ceil(cx - ex - 0.5)), i1 = Math.min(W - 1, Math.floor(cx + ex - 0.5));
  const j0 = Math.max(0, Math.ceil(cz - ez - 0.5)), j1 = Math.min(H - 1, Math.floor(cz + ez - 0.5));
  if (i0 > i1 || j0 > j1) return false;
  for (let j = j0; j <= j1; j++) {
    const pz = j + 0.5 - cz, row = j * W;
    for (let i = i0; i <= i1; i++) {
      const px = i + 0.5 - cx, u = Math.abs(px * rx + pz * rz), v = px * fx + pz * fz;
      if (u > uw || v > hd + (v > 0 ? front : m) || v < -hd - m) continue;
      const c = row + i, b = surf[c];
      if (u <= hw && v <= hd && v >= -hd) { if (b !== GRASS || taken[c]) return false; continue; }
      const k = b & KIND_MASK;
      if (k === ROAD || k === DECK || k === DIRT || k === BUILD) return false;
    }
  }
  return true;
}

// Water (sea, lagoon, ponds) within a pad's blend of the footprint, or highway within HWY_M: sampled every 2 m.
function wetOrHighway(ctx, cx, cz, w, d, a) {
  const fx = Math.cos(a), fz = Math.sin(a), rx = fz, rz = -fx, m = Math.max(WET_M, HWY_M);
  for (let v = -d / 2 - m; v <= d / 2 + m + 1e-6; v += 2) for (let u = -w / 2 - m; u <= w / 2 + m + 1e-6; u += 2) {
    const b = cellBits(ctx, cx + rx * u + fx * v, cz + rz * u + fz * v), k = b & KIND_MASK;
    if (k === WATER || k === SHALLOW || (b & FLAG.NOPED)) return true;
  }
  return false;
}

// The pad's height (the highest TERRAIN under the corners, as terrain.pad takes it), or null when the ground
// falls more than `fall` metres across the footprint.
function padHeight(ctx, cx, cz, w, d, a, fall) {
  const fx = Math.cos(a), fz = Math.sin(a), rx = fz, rz = -fx;
  let lo = Infinity, hi = -Infinity;
  for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]) {
    const y = sampleGrid(ctx.terrain, cx + rx * u * w / 2 + fx * v * d / 2, cz + rz * u * w / 2 + fz * v * d / 2);
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  return hi - lo > fall ? null : hi;
}

// world-v2 pads the lots in the order they are placed, each easing back to the ground over PAD_BLEND (by
// 1 - smoothstep of the distance), and a later pad's blend runs over an earlier lot: a step higher, it buries that
// lot's floor on the side next to it (building 297 on the east shoulder, 1.6 m); a step lower, it pulls the
// ground out from under it. So what a lot's blend does to an earlier one's edge stays within LEVEL_M up and DROP_M
// down; on a slope the next lot waits until it is far enough off (a garden between them).
function levelWithNeighbours(ctx, poly, y) {
  const box = bbox(poly), r = PAD_BLEND;
  for (const p of ctx.pads) {
    if (y - p.y <= LEVEL_M && p.y - y <= DROP_M) continue;
    if (p.box[0] > box[2] + r || p.box[2] < box[0] - r || p.box[1] > box[3] + r || p.box[3] < box[1] - r) continue;
    const t = Math.min(1, polyGap(p.poly, poly) / r), reach = (y - p.y) * (1 - t * t * (3 - 2 * t));
    if (reach > LEVEL_M || -reach > DROP_M) return false;
  }
  return true;
}

// A road with no sidewalk on this side (Neon Alley): the strip between its carriageway and a lot's front is
// paved (PLAZA), so the shops open onto a pavement rather than a verge.
function paveApron(ctx, e, side, sc, w, front) {
  const { surf, W } = ctx, p = at(e, sc * PX, {}), nx = -p.ty * side, nz = p.tx * side;
  for (let t = e.halfW / PX + 0.25; t < front; t += 0.5) for (let u = -w / 2 - 0.5; u <= w / 2 + 0.5; u += 0.5) {
    const x = p.x / PX + nx * t - nz * u, z = p.y / PX + nz * t + nx * u, i = Math.floor(x), j = Math.floor(z);
    if (i < 0 || j < 0 || i >= W || j >= ctx.H) continue;
    if (surf[j * W + i] === GRASS) surf[j * W + i] = KIND.PLAZA;
  }
}

// ---------- height caps ----------

// VIEW_CORRIDORS (§3): a lot that reaches into a corridor polygon stays under its maxH.
function corridorCap(ctx, cx, cz, w, d, a) {
  let cap = Infinity;
  const corners = obbCorners(cx, cz, w + 2 * RAY_M, d + 2 * RAY_M, a);
  for (const C of ctx.corridors) {
    if (C.maxH >= cap || !boxesMeet(C.box, bbox(corners))) continue;
    const hit = corners.some(([x, z]) => insidePoly(C.pts, x, z)) || insidePoly(C.pts, cx, cz) || C.pts.some(([x, z]) => inOBB(x, z, cx, cz, w + 2 * RAY_M, d + 2 * RAY_M, a));
    if (hit) cap = C.maxH;
  }
  return cap;
}

// The §4.7 rays as 3D segments {ax, az, ay, bx, bz, by} (m), built once from the ground as it is now (roads
// carved, prefab pads in).
function sightRays(ctx) {
  const out = [], eye = (x, z) => sampleGrid(ctx.ground, x, z) + CURB[cellBits(ctx, x, z) & KIND_MASK] + 1.5;
  const target = id => {
    const T = SIGHT_TARGETS[id];
    return { x: T.x, z: T.z, y: T.y ?? sampleGrid(ctx.ground, T.x, T.z) + T.h / 2, r: T.r };
  };
  const ray = (x, z, id) => {
    const t = target(id), y = eye(x, z), dx = t.x - x, dz = t.z - z, dl = Math.hypot(dx, dz), f = Math.max(0, (dl - t.r) / dl);
    const bx = x + dx * f, bz = z + dz * f;
    out.push({ ax: x, az: z, ay: y, bx, bz, by: y + (t.y - y) * f, x0: Math.min(x, bx), x1: Math.max(x, bx), z0: Math.min(z, bz), z1: Math.max(z, bz) });
  };
  for (const S of SIGHTLINES) {
    if (S.view) { const v = BENCH_VIEWS.find(b => b.name === S.view); if (v) for (const id of S.to) ray(v.x, v.z, id); continue; }
    // eyes on both carriageways of the Loop inside the box, every step metres
    const [x0, x1, z0, z1] = S.loop;
    for (const e of ctx.net.edges) {
      if (e.road !== 'loop') continue;
      let last = -Infinity;
      for (let i = 0; i < e.n; i++) {
        const x = e.x[i] / PX, z = e.y[i] / PX;
        if (x < x0 || x > x1 || z < z0 || z > z1 || e.s[i] / PX - last < S.step) continue;
        last = e.s[i] / PX;
        const off = 3.3;      // the inner lane each way: median/2 + laneW/2
        for (const sgn of [1, -1]) for (const id of S.to) ray(x - e.ty[i] * off * sgn, z + e.tx[i] * off * sgn, id);
      }
    }
  }
  return out;
}

// The tallest a lot may stand (m above its pad) and still keep every sightline over it clear: OCC rounds a
// roof up to whole metres and a ray tests the 2 m cells it crosses, so the roof stays a metre under the
// lowest point of the ray over the footprint grown by RAY_M.
function rayCap(ctx, cx, cz, w, d, a, base) {
  let cap = Infinity;
  const fx = Math.cos(a), fz = Math.sin(a), rx = fz, rz = -fx, hu = w / 2 + RAY_M, hv = d / 2 + RAY_M;
  const reach = Math.hypot(hu, hv);
  for (const R of ctx.rays) {
    if (cx < R.x0 - reach || cx > R.x1 + reach || cz < R.z0 - reach || cz > R.z1 + reach) continue;
    // the ray in the lot's frame (u across, v along the facing), clipped to the grown footprint
    const au = (R.ax - cx) * rx + (R.az - cz) * rz, av = (R.ax - cx) * fx + (R.az - cz) * fz;
    const bu = (R.bx - cx) * rx + (R.bz - cz) * rz, bv = (R.bx - cx) * fx + (R.bz - cz) * fz;
    if (!clipSegment(au, av, bu - au, bv - av, hu, hv)) continue;
    const y = Math.min(R.ay + (R.by - R.ay) * CLIP[0], R.ay + (R.by - R.ay) * CLIP[1]);
    cap = Math.min(cap, Math.floor(y) - 1 - base);
  }
  return cap;
}

// Liang-Barsky: clips p + t·dp (t in 0..1) to |u| <= hu, |v| <= hv. Returns false when nothing is left, else
// leaves the part in CLIP[0..1].
const CLIP = [0, 1];
function clipSegment(pu, pv, du, dv, hu, hv) {
  CLIP[0] = 0; CLIP[1] = 1;
  return clip1(-du, pu + hu) && clip1(du, hu - pu) && clip1(-dv, pv + hv) && clip1(dv, hv - pv);
}
function clip1(p, q) {
  if (Math.abs(p) < 1e-12) return q >= 0;
  const r = q / p;
  if (p < 0) { if (r > CLIP[1]) return false; if (r > CLIP[0]) CLIP[0] = r; }
  else { if (r < CLIP[0]) return false; if (r < CLIP[1]) CLIP[1] = r; }
  return true;
}

// ---------- marking ----------

// Cells whose centres lie in the box (w across, d deep, facing a) are taken.
function markOBB(ctx, cx, cz, w, d, a) {
  const { taken, W, H } = ctx, fx = Math.cos(a), fz = Math.sin(a), rx = fz, rz = -fx, hw = w / 2, hd = d / 2;
  const ex = Math.abs(rx) * hw + Math.abs(fx) * hd, ez = Math.abs(rz) * hw + Math.abs(fz) * hd;
  const i0 = Math.max(0, Math.ceil(cx - ex - 0.5)), i1 = Math.min(W - 1, Math.floor(cx + ex - 0.5));
  const j0 = Math.max(0, Math.ceil(cz - ez - 0.5)), j1 = Math.min(H - 1, Math.floor(cz + ez - 0.5));
  for (let j = j0; j <= j1; j++) {
    const pz = j + 0.5 - cz;
    for (let i = i0; i <= i1; i++) {
      const px = i + 0.5 - cx;
      if (Math.abs(px * rx + pz * rz) <= hw && Math.abs(px * fx + pz * fz) <= hd) taken[j * W + i] = 1;
    }
  }
}

function markDisc(ctx, cx, cz, r) {
  const { taken, W, H } = ctx, r2 = r * r;
  for (let j = Math.max(0, Math.floor(cz - r)); j <= Math.min(H - 1, Math.ceil(cz + r)); j++) {
    const dz = j + 0.5 - cz;
    for (let i = Math.max(0, Math.floor(cx - r)); i <= Math.min(W - 1, Math.ceil(cx + r)); i++) {
      const dx = i + 0.5 - cx;
      if (dx * dx + dz * dz <= r2) taken[j * W + i] = 1;
    }
  }
}

// ---------- small helpers ----------

function cellBits(ctx, x, z) {
  const i = Math.floor(x), j = Math.floor(z);
  return i < 0 || j < 0 || i >= ctx.W || j >= ctx.H ? WATER | BLOCKS : ctx.surf[j * ctx.W + i];
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
  for (const [a, b] of e.deck || []) if (s >= a - 6 * PX && s <= b + 6 * PX) return true;
  return false;
}

// Point (px) and unit tangent of an edge at station s (px), and the sample index before it.
function at(e, s, out) {
  let lo = 0, hi = e.n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (e.s[m] <= s) lo = m; else hi = m; }
  const ds = e.s[hi] - e.s[lo], f = ds > 1e-9 ? Math.min(1, Math.max(0, (s - e.s[lo]) / ds)) : 0;
  const dx = e.x[hi] - e.x[lo], dy = e.y[hi] - e.y[lo], l = Math.hypot(dx, dy) || 1;
  out.x = e.x[lo] + dx * f; out.y = e.y[lo] + dy * f; out.tx = dx / l; out.ty = dy / l; out.i = lo;
  return out;
}

function obbCorners(cx, cz, w, d, a) {
  const fx = Math.cos(a), fz = Math.sin(a), rx = fz, rz = -fx;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [cx + rx * u * w / 2 + fx * v * d / 2, cz + rz * u * w / 2 + fz * v * d / 2]);
}
function inOBB(x, z, cx, cz, w, d, a) {
  const px = x - cx, pz = z - cz, fx = Math.cos(a), fz = Math.sin(a);
  return Math.abs(px * fz - pz * fx) <= w / 2 && Math.abs(px * fx + pz * fz) <= d / 2;
}
function bbox(pts) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  return [x0, z0, x1, z1];
}
const boxesMeet = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
// the gap between two convex polygons that do not overlap: the nearest corner of either to an edge of the other
function polyGap(A, B) {
  let g = Infinity;
  for (const [P, Q] of [[A, B], [B, A]]) for (const [x, z] of P) for (let i = 0, j = Q.length - 1; i < Q.length; j = i++) {
    const [ax, az] = Q[j], [bx, bz] = Q[i], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    g = Math.min(g, Math.hypot(x - ax - dx * t, z - az - dz * t));
  }
  return g;
}
function insidePoly(pts, x, z) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
const pick = (rnd, [lo, hi]) => lo + (hi - lo) * rnd();
const pickOf = (rnd, list) => (list.length ? list[Math.floor(rnd() * list.length)] : undefined);
function strHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
