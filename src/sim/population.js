// Who is out on the streets (docs/map-v2-spec.md §9 Population): the traffic, the parked cars and the
// pedestrians, and the factories that make cars and people (entities.js re-exports them).
//
// Two modes. The classic grid is small enough to live all at once ('global', as it always has): 24 traffic
// cars and 46 people anywhere on the map, the parked cars dealt once at the start, and whatever goes missing
// (a carjacked car, someone knocked down) replaced out of sight; of the cars taken from traffic and left
// about, 3 stay and the rest go once out of view. The v2 map streams rings round the player
// ('ring'): traffic 180-380 m out and gone past 460 m, parked cars within 220 m (gone past 300 m unless
// touched), people 45-150 m out and gone past 190 m, all out of view, capped per graphics tier. How many of
// the cap are out comes from how busy the neighbourhood is (its regions' traffic and people densities, and
// the road classes), so downtown is full and the Glades are quiet. Parked cars stand on the world's parking
// spots and along the avenues' parking lanes. Dealer, garage, police and mission cars are never streamed.
// Pure sim: no three, no DOM, runs in node.
import { G } from '../state.js';
import { KIND, BOUNDS, roads, parkedSpawns, displaySpots, deliveryDoors, places, regions, regionAt, PX_PER_M, tileAtPx, surfaceAt,
  blockedCarPx, ROAD, BUILD, WATER } from '../world.js';
import { ROADS as MAP_ROADS } from '../map/mapdata.js';
import { CAR_TYPES, CAR_COLORS, LUX_COLORS, DEALER } from '../data.js';
import { pick } from '../util.js';
import { aiAttach, countTraffic } from './traffic.js';
import { randomSidewalk, attachWalk } from './peds.js';

const M = PX_PER_M;

// How many of each the world keeps: the grid at once, v2 per graphics tier.
export const CAPS = {
  global: { traffic: 24, peds: 46 },
  high: { traffic: 24, peds: 34, parked: 30 },
  medium: { traffic: 24, peds: 34, parked: 30 },
  low: { traffic: 16, peds: 22, parked: 18 },
};
const RING = {
  car: { min: 180 * M, max: 380 * M, drop: 460 * M },
  parked: { show: 220 * M, drop: 300 * M },
  ped: { min: 45 * M, max: 150 * M, drop: 190 * M },
};
// v2 traffic by road class (§9), on top of each region's traffic density
const CLASS_W = { hwy: 1.5, blvd: 1.2, street: 1, ave: 1, ring: 1, coast: 0.8, country: 0.4, switch: 0.3 };
// v2: the share of the cap out on the streets follows how busy the neighbourhood is (see density below): a
// mean density of FULL is a full cap (the 380 m round even the busiest corner takes in quieter roads, the
// bridges and the bay), and it never drops under FLOOR, so even the Glades have someone about
const FULL = 0.75, FLOOR = { traffic: 0.25, peds: 0.1 };
const DENS_STEP = 40 * M;        // the density samples are this far apart along lanes and sidewalks
const DENS_EVERY = 1;            // s between density updates
const KERB_PITCH = 7 * M;        // parking-lane bays along the avenues
const KERB_CLEAR = 10 * M;       // ... kept this far from junction mouths and from places' kerbs, bays and garages ...
const DROP_CLEAR = 4 * M;        // ... and this far from a delivery's kerb, so no parked car stands on it
const SPAWN_PAD = 0.3 * M;       // a parked car appears only with this much room round its box
const VIEW_R = 170 * M;          // the grid counts anything closer than this to Kimchi as in view (3D draws cars to 170 m)
const STUCK_DROP = 25;           // s: a traffic car stopped this long out of view is taken away
const LEFT_KEEP = 3;             // the grid keeps this many cars taken from traffic and left about (see below)
const TICK = 0.25;               // s between population passes

// ---------- making cars and people ----------

const SKINS = ['#f1c9a5', '#e0ac7e', '#c98d63', '#8d5a3b', '#f6d7bf', '#b07650'];
const HAIRS = ['#1b1512', '#3b2618', '#6b4a2b', '#d9c27a', '#9c3b2e', '#2a2a2a', '#7d7d7d'];
const SHIRTS = ['#e85d5d', '#5d8de8', '#f2c230', '#5dbb7a', '#ffffff', '#9b7be0', '#f08a2c', '#2f2f33', '#59c3c3', '#e88ac0'];
const PANTS = ['#2d3a4f', '#3a3a3a', '#5b4a3a', '#1f2b3a', '#6b6b6b', '#3d5a80'];

export const randLook = () => ({ skin: pick(SKINS), hair: pick(HAIRS), shirt: pick(SHIRTS), pants: pick(PANTS), long: Math.random() < 0.4, bun: Math.random() < 0.2 });

export function makeCar(type, x, y, a, color) {
  const ty = CAR_TYPES[type];
  return { type, x, y, a, vx: 0, vy: 0, speed: 0, color: color || ty.color, color2: ty.color2 || null, ai: null, owned: false, locked: false, brake: false, bubble: null, hp: 100 };
}

// How much room a car takes: its CAR_TYPES box (len x wid px) turned to its heading a. carOverlap is the
// separating-axis test of two of them (the axes are each box's length and width). Null when they are apart
// (with `pad` px of room round car a), else out = { x, y, pen, px, py }: the unit normal (x, y) from a to b,
// how deep they overlap along it (px), and the contact point (px, py): the mean of the corners of each box
// inside the other, or halfway between the centres when no corner is (two boxes crossed like a plus sign).
// The v2 car-to-car physics (entities.js) and the parked-car streaming here both use it.
const CORNERS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
export function carOverlap(a, b, out = {}, pad = 0) {
  const A = CAR_TYPES[a.type], B = CAR_TYPES[b.type];
  const la = A.len / 2 + pad, wa = A.wid / 2 + pad, lb = B.len / 2, wb = B.wid / 2;
  const dx = b.x - a.x, dy = b.y - a.y, reach = Math.hypot(la, wa) + Math.hypot(lb, wb);
  if (dx * dx + dy * dy >= reach * reach) return null;
  const ca = Math.cos(a.a), sa = Math.sin(a.a), cb = Math.cos(b.a), sb = Math.sin(b.a);
  let pen = Infinity, nx = 0, ny = 0;
  for (let k = 0; k < 4; k++) {
    const kx = k === 0 ? ca : k === 1 ? -sa : k === 2 ? cb : -sb;
    const ky = k === 0 ? sa : k === 1 ? ca : k === 2 ? sb : cb;
    const ra = la * Math.abs(ca * kx + sa * ky) + wa * Math.abs(ca * ky - sa * kx);
    const rb = lb * Math.abs(cb * kx + sb * ky) + wb * Math.abs(cb * ky - sb * kx);
    const d = dx * kx + dy * ky, o = ra + rb - Math.abs(d);
    if (o <= 0) return null;
    if (o < pen) { pen = o; nx = d < 0 ? -kx : kx; ny = d < 0 ? -ky : ky; }
  }
  let n = 0, px = 0, py = 0;
  for (const [u, v] of CORNERS) {
    const x1 = a.x + u * la * ca - v * wa * sa, y1 = a.y + u * la * sa + v * wa * ca;
    if (inBox(x1 - b.x, y1 - b.y, cb, sb, lb, wb)) { px += x1; py += y1; n++; }
    const x2 = b.x + u * lb * cb - v * wb * sb, y2 = b.y + u * lb * sb + v * wb * cb;
    if (inBox(x2 - a.x, y2 - a.y, ca, sa, la, wa)) { px += x2; py += y2; n++; }
  }
  out.x = nx; out.y = ny; out.pen = pen;
  out.px = n ? px / n : a.x + dx / 2; out.py = n ? py / n : a.y + dy / 2;
  return out;
}
// Whether offset (dx, dy) from a box's centre is inside it (heading cos c, sin s; half length l, half width w).
const inBox = (dx, dy, c, s, l, w) => Math.abs(dx * c + dy * s) <= l && Math.abs(dy * c - dx * s) <= w;

// vk is the ped's own pace (0.9-1.4 m/s at the 3D walk speed), off0 how far right of the pavement's centre
// line it keeps
export function makePed(x, y, extra = {}) {
  return { x, y, dir: Math.floor(Math.random() * 4), timer: Math.random() * 3, pause: 0, state: 'walk', t: 0,
    vx: 0, vy: 0, spin: 0, walkT: Math.random() * 10, moving: true, face: 1, look: randLook(), bubble: null,
    chatCd: Math.random() * 5, hp: 100, walk: null, snap: null, vk: 0.96 + Math.random() * 0.53, off0: (0.15 + Math.random() * 0.35) * M,
    ...extra };
}

// Kimchi City traffic: everyday cars with plenty of supercars mixed in
const TRAFFIC = ['hatch', 'sedan', 'taxi', 'van', 'sedan', 'sports', 'hatch', 'ursa', 'gwagen', 'monarch', 'phantasma', 'cavallo', 'papaya', 'gwagen', 'ursa', 'monarch'];
const PARKED = ['hatch', 'sedan', 'van', 'hatch', 'sedan', 'taxi', 'ursa', 'gwagen', 'monarch', 'sports', 'cavallo', 'phantasma'];
const paintFor = (type) => (type === 'taxi' ? null : CAR_TYPES[type].lux ? (Math.random() < 0.5 ? null : pick(LUX_COLORS)) : pick(CAR_COLORS));

// ---------- view and mode ----------

let mode = null;                 // 'global' or 'ring' (set from the world, or by a test)
let focus = { x: 0, y: 0, a: 0 };
let view = null;                 // (x, y) -> true when that spot may be on screen
let tier = 'medium';
let tickT = 0, popT = 0;
const modeNow = () => mode || (KIND === 'grid' ? 'global' : 'ring');

// The default view: the grid has no camera here, so anything within VIEW_R of Kimchi counts as seen. On v2 it
// is a cone ahead of the focus (the chase camera looks where Kimchi faces) plus a 40 m bubble round him.
function defaultView(x, y) {
  const dx = x - focus.x, dy = y - focus.y, d = Math.hypot(dx, dy);
  if (modeNow() === 'global') return d < VIEW_R;
  if (d < 40 * M) return true;
  if (d > 260 * M) return false;
  return Math.cos(Math.atan2(dy, dx) - focus.a) > Math.cos(75 * Math.PI / 180);
}
const seenAt = (x, y) => (view || defaultView)(x, y);
const capsNow = () => (modeNow() === 'global' ? CAPS.global : CAPS[tier] || CAPS.medium);

// ---------- how busy it is round the focus (v2) ----------
// Samples every 40 m along the traffic lanes (region traffic density x road class weight) and the sidewalks
// (region people density), built once per road network. The mean of the samples near the focus (within the
// traffic ring's 380 m, the people ring's 150 m), over FULL, is the share of each cap that is out.

let dens = null, densT = 0;
const want = { traffic: 0, peds: 0 };

function regionDensity(x, y, key) {
  if (!regionAt || !regions || !regions.length) return 1;
  const id = regionAt(x, y), reg = regions.find(r => r.id === id);
  return reg && typeof reg[key] === 'number' ? reg[key] : 1;
}

// Points every DENS_STEP along a polyline (flat x/y arrays and stations s, px): [x, y, w, ...] via weight().
function samplesAlong(out, X, Y, S, n, weight) {
  for (let i = 0, next = 0; i < n; i++) {
    if (S[i] < next) continue;
    out.push(X[i], Y[i], weight(X[i], Y[i]));
    next = S[i] + DENS_STEP;
  }
}

function densitySamples() {
  const key = roads.lanes[0];
  if (dens && dens.key === key && dens.n === roads.lanes.length) return dens;
  const car = [], ped = [];
  for (const L of roads.lanes) {
    const e = roads.edges[L.edge];
    if (!e || !e.ai) continue;
    const w = CLASS_W[e.cls] ?? 1;
    samplesAlong(car, L.x, L.y, L.s, L.n, (x, y) => regionDensity(x, y, 'traffic') * w);
  }
  const xs = [], ys = [];
  for (const P of roads.walks?.paths || []) {
    if (P.cross || !P.len) continue;
    xs.length = ys.length = 0;
    for (let i = 0; i < P.n; i++) { xs.push(P.pts[2 * i]); ys.push(P.pts[2 * i + 1]); }
    samplesAlong(ped, xs, ys, P.s, P.n, (x, y) => regionDensity(x, y, 'peds'));
  }
  dens = { key, n: roads.lanes.length, car: Float32Array.from(car), ped: Float32Array.from(ped) };
  return dens;
}

// The mean weight of the samples within r px of the focus (null when there are none).
function meanNear(A, r) {
  let sum = 0, n = 0;
  for (let i = 0; i < A.length; i += 3) {
    const dx = A[i] - focus.x, dy = A[i + 1] - focus.y;
    if (Math.abs(dx) > r || Math.abs(dy) > r || dx * dx + dy * dy > r * r) continue;
    sum += A[i + 2]; n++;
  }
  return n ? sum / n : null;
}

// How many cars and people the population aims for now: the caps on the grid; on v2 the caps times how busy
// the neighbourhood is (between FLOOR and all of them).
function updateWant(caps) {
  if (modeNow() !== 'ring') { want.traffic = caps.traffic; want.peds = caps.peds; return want; }
  const D = densitySamples(), share = (v, f) => Math.min(1, Math.max(f, v == null ? f : v / FULL));
  want.traffic = Math.max(1, Math.round(caps.traffic * share(meanNear(D.car, RING.car.max), FLOOR.traffic)));
  want.peds = Math.max(1, Math.round(caps.peds * share(meanNear(D.ped, RING.ped.max), FLOOR.peds)));
  return want;
}

// ---------- traffic ----------

// The speed a car streamed in out of view arrives at: 70% of the road's speed (driver factor f).
const arrival = (q, f) => roads.edges[roads.lanes[q.lane].edge].speed * f * 0.7;

// A new traffic car on a lane spot ({ lane, s, x, y, a }). A car streamed in out of view arrives already
// driving; the cars of a new game start parked in their lanes.
function addTraffic(q, moving, f = 0.85 + Math.random() * 0.25) {
  const type = pick(TRAFFIC);
  const c = makeCar(type, q.x, q.y, q.a, paintFor(type));
  c.traffic = true;
  aiAttach(c, q, { f, speed: moving ? arrival(q, f) : 0 });
  G.cars.push(c);
  countTraffic('spawned');
  return c;
}

// Room for a car arriving at lane spot q at speed v: 20 m to the car ahead (and at least its 1.2 s following
// gap, 7 m + 1.2 v), and behind it 20 m plus what the car behind covers in 2 s, so nothing fast comes up on a
// newcomer it cannot stop for.
function laneRoom(q, v = 0) {
  const ahead = Math.max(20 * M, 9 * M + 1.2 * v);
  for (const o of roads.lanes[q.lane].cars) {
    const d = o.ai.s - q.s;
    if (d >= 0 ? d < ahead : -d < 20 * M + 2 * o.ai.speed) return false;
  }
  return true;
}

// v2: how likely traffic is on this road here, from the region's density and the road's class (0..1)
function trafficOdds(q) {
  const e = roads.edges[roads.lanes[q.lane].edge];
  return Math.min(1, regionDensity(q.x, q.y, 'traffic') * (CLASS_W[e.cls] ?? 1) / 1.5);
}

// One traffic car somewhere out of view: anywhere on the grid, in the ring on v2. False if no spot was found.
function spawnTraffic(anywhere = false) {
  if (!roads.randomLanePoint) return false;
  const ring = modeNow() === 'ring';
  for (let t = 0; t < 6; t++) {
    const q = ring
      ? roads.randomLanePoint({ x: focus.x, y: focus.y, rMin: anywhere ? 30 * M : RING.car.min, rMax: RING.car.max, ai: true, minGap: 20 * M, notVisible: anywhere ? null : (x, y) => !seenAt(x, y) })
      : roads.randomLanePoint({ ai: true, minGap: 15 * M, notVisible: anywhere ? null : (x, y) => !seenAt(x, y) });
    const f = 0.85 + Math.random() * 0.25;
    if (!q || !laneRoom(q, anywhere ? 0 : arrival(q, f))) continue;
    if (G.cars.some(c => Math.abs(c.x - q.x) < 140 && Math.abs(c.y - q.y) < 140 && Math.hypot(c.x - q.x, c.y - q.y) < 140)) continue;
    if (ring && Math.random() > trafficOdds(q)) continue;
    addTraffic(q, !anywhere, f);
    return true;
  }
  return false;
}

// ---------- parked cars (v2) ----------
// The spots are the world's parkedSpawns (lots and drives) plus bays along the avenues' 2.4 m parking lanes
// (spec §4.2; Collins/Ocean Drive only on its west side), built once per road network with a 64 m grid to
// find the ones near the focus. Each spot keeps the same car (or none) every time it comes back: its odds,
// type and paint come from a hash of its index.
const spotHash = (i, k) => { let h = Math.imul((i + 1) * 2654435761 ^ k, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const PARK_SIDE = Object.fromEntries(MAP_ROADS.filter(r => typeof r.parking === 'string').map(r => [r.id, r.parking]));
const CELL = 64 * M;
let spots = null;

function parkingSpots() {
  const key = roads.lanes[0];
  if (spots && spots.key === key && spots.world === parkedSpawns.length) return spots;
  const list = parkedSpawns.map(s => ({ x: s.x, y: s.y, a: s.a }));
  const keep = [...displaySpots, ...(places.home?.garage || [])];
  for (const pl of Object.values(places)) for (const k of ['curb', 'bay', 'foot', 'door']) if (pl[k]) keep.push(pl[k]);
  for (const d of deliveryDoors) if (d.curb) keep.push({ x: d.curb.x, y: d.curb.y, clear: DROP_CLEAR });
  for (const e of roads.edges) kerbBays(e, list, keep);
  const grid = new Map();
  list.forEach((s, i) => {
    const k = Math.floor(s.x / CELL) + ',' + Math.floor(s.y / CELL);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  spots = { key, world: parkedSpawns.length, list, grid };
  return spots;
}

// Bays every KERB_PITCH down the middle of an edge's parking lane, each side that has one: the strip between
// its traffic lanes and its kerb, when that is at least 2.2 m (the avenues' 2.4 m). A bay is used only where
// the whole car stands on plain road, clear of junction mouths and of the places' kerbs, bays and garages,
// and off the kerbs delivery jobs stop at (365 of them on v2, nearly every door on the avenues, so those
// keep only the car's own length clear and the bays between the doors stay).
function kerbBays(e, out, keep) {
  if (e.oneway || e.single || !e.ai) return;
  const lanes = Math.max(e.lanesF, e.lanesB), strip = e.halfW - e.median / 2 - lanes * e.laneW;
  if (strip < 2.2 * M) return;
  const off = e.halfW - strip / 2, side = PARK_SIDE[e.road];
  for (const dir of [1, -1]) {
    for (let s = e.trimA + KERB_CLEAR; s <= e.len - e.trimB - KERB_CLEAR; s += KERB_PITCH) {
      const i = Math.min(e.n - 2, nearIndex(e.s, s)), f = (s - e.s[i]) / ((e.s[i + 1] - e.s[i]) || 1);
      const tx = e.tx[i] * dir, ty = e.ty[i] * dir;                 // the travel direction of this side's lane
      const x = e.x[i] + (e.x[i + 1] - e.x[i]) * f - ty * off, y = e.y[i] + (e.y[i + 1] - e.y[i]) * f + tx * off;   // off to its right
      if (side && !compass(-ty, tx, side)) continue;
      if (keep.some(q => { const r = q.clear || KERB_CLEAR; return Math.abs(q.x - x) < r && Math.abs(q.y - y) < r; })) continue;
      if (!plainRoad(x, y, tx, ty)) continue;
      out.push({ x, y, a: Math.atan2(ty, tx) });
    }
  }
}
const nearIndex = (S, s) => { let lo = 0, hi = S.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; } return lo; };
// Whether the outward direction (nx, ny) points to compass side 'W', 'E', 'N' or 'S' (y is south).
const compass = (nx, ny, side) => (side === 'W' ? nx < 0 : side === 'E' ? nx > 0 : side === 'N' ? ny < 0 : ny > 0);
// A parked car's footprint (2.4 m either way along, 0.9 m across) all on open road.
function plainRoad(x, y, tx, ty) {
  for (const [u, v] of [[0, 0], [2.4, 0.9], [2.4, -0.9], [-2.4, 0.9], [-2.4, -0.9]]) {
    const px = x + (tx * u - ty * v) * M, py = y + (ty * u + tx * v) * M;
    if (surfaceAt(px, py) !== ROAD || blockedCarPx(px, py)) return false;
  }
  return true;
}

function parkedAt(i) {
  const s = parkingSpots().list[i];
  if (spotHash(i, 1) < 0.55) return null;
  const type = PARKED[Math.floor(spotHash(i, 2) * PARKED.length)];
  const lux = CAR_TYPES[type].lux, paints = lux ? LUX_COLORS : CAR_COLORS;
  const color = type === 'taxi' || (lux && spotHash(i, 3) < 0.5) ? null : paints[Math.floor(spotHash(i, 4) * paints.length)];
  const c = makeCar(type, s.x, s.y, s.a, color);
  c.parked = i;
  return c;
}

// ---------- peds ----------

const civilians = () => { let n = 0; for (const p of G.peds) if (!p.role) n++; return n; };

// A new person on a sidewalk spot.
function addPed(q) {
  const p = makePed(q.x, q.y);
  attachWalk(p, q);
  G.peds.push(p);
  return p;
}

// A sidewalk spot for someone new: anywhere (the grid), or in the ring (v2), out of view unless `anywhere`.
function pedSpot(anywhere = false, minDist = 0) {
  const ring = modeNow() === 'ring';
  const { x0, y0, x1, y1 } = BOUNDS;
  for (let t = 0; t < 40; t++) {
    const q = ring && roads.randomWalkPoint
      ? roads.randomWalkPoint({ x: focus.x, y: focus.y, rMin: anywhere ? 10 * M : RING.ped.min, rMax: RING.ped.max, tries: 4 })
      : randomSidewalk();
    if (!q) continue;
    if (q.x < x0 || q.x >= x1 || q.y < y0 || q.y >= y1) continue;
    if (minDist && Math.hypot(q.x - G.player.x, q.y - G.player.y) < minDist) continue;
    if (!anywhere && seenAt(q.x, q.y)) continue;
    if (ring && Math.random() > regionDensity(q.x, q.y, 'peds')) continue;
    return q;
  }
  return null;
}

// A sidewalk spot inside BOUNDS at least minDist px from Kimchi, or null.
function sidewalkAway(minDist) {
  const { x0, y0, x1, y1 } = BOUNDS;
  for (let i = 0; i < 200; i++) {
    const q = randomSidewalk();
    if (!q) return null;
    if (q.x < x0 || q.x >= x1 || q.y < y0 || q.y >= y1) continue;
    if (Math.hypot(q.x - G.player.x, q.y - G.player.y) < minDist) continue;
    return q;
  }
  return null;
}

// Somewhere on a sidewalk, away from the player: the person p becomes someone new there. On the grid that is
// anywhere on the map at least minDist px from Kimchi; on v2 somewhere in the ped ring out of view. Without
// a sidewalk graph it falls back to any open tile, as the game always did.
export function respawnPed(p, minDist = 1800) {
  const q = modeNow() === 'ring' ? pedSpot(false) : sidewalkAway(minDist);
  if (q) {
    Object.assign(p, makePed(q.x, q.y));
    attachWalk(p, q);
    return true;
  }
  const { x0, y0, x1, y1 } = BOUNDS;
  for (let i = 0; i < 200; i++) {
    const x = x0 + Math.random() * (x1 - x0), y = y0 + Math.random() * (y1 - y0);
    const t = tileAtPx(x, y);
    if (t === ROAD || t === BUILD || t === WATER) continue;
    if (Math.hypot(x - G.player.x, y - G.player.y) < minDist) continue;
    Object.assign(p, makePed(x, y));
    return true;
  }
  return false;
}

// ---------- the whole population ----------

// A new game's cars and people (G.cars and G.peds are replaced): parked cars on their spots, the dealer's
// display cars, the traffic and the pedestrians. The grid deals the parked cars once, as it always has.
export function spawnPopulation() {
  G.cars = []; G.peds = [];
  tickT = 0;
  focusOn(G.player);
  const ring = modeNow() === 'ring';
  if (!ring) {
    for (const s of parkedSpawns) {
      if (Math.random() < 0.55) continue;
      const type = pick(PARKED);
      G.cars.push(makeCar(type, s.x, s.y, s.a, paintFor(type)));
    }
  }
  DEALER.forEach((type, i) => {
    const s = displaySpots[i];
    if (!s) return;
    const c = makeCar(type, s.x, s.y, s.a);
    c.locked = true;
    G.cars.push(c);
  });
  const caps = capsNow(), n = updateWant(caps);
  densT = DENS_EVERY;
  for (let i = 0, tries = 0; i < n.traffic && tries < n.traffic * 4; tries++) if (spawnTraffic(true)) i++;
  for (let tries = 0; civilians() < n.peds && tries < n.peds * 4; tries++) {
    const q = pedSpot(true);
    if (q) addPed(q);
  }
  if (ring) streamParked(caps, true);
}

// Take every streamed car and person away (before a teleport or fast travel); the next passes refill.
export function clearPopulation() {
  G.cars = G.cars.filter(c => c === G.player.car || !(c.traffic && c.ai) && !(c.parked != null && !c.touched));
  G.peds = G.peds.filter(p => p.role);
  tickT = 0; densT = 0;
}

function focusOn(p) {
  const c = p.car;
  focus.x = c ? c.x : p.x; focus.y = c ? c.y : p.y;
  focus.a = c ? c.a : (p.heading ?? (p.face < 0 ? Math.PI : 0));
}

// Keep the population topped up and trimmed. focus: { x, y } (Kimchi, or his car) and optionally its heading
// a; opts.tier: 'low' | 'medium' | 'high' (the v2 caps); opts.view(x, y): true when a spot may be on screen.
export function updatePopulation(dt, f = G.player, opts = {}) {
  if (opts.tier) tier = opts.tier;
  if (opts.mode) mode = opts.mode;
  view = opts.view || null;
  if (f && f.car !== undefined) focusOn(f);
  else if (f) { focus.x = f.x; focus.y = f.y; focus.a = f.a ?? focus.a; }
  popT += dt;
  if ((tickT -= dt) > 0) return;
  tickT = TICK;
  const caps = capsNow(), ring = modeNow() === 'ring';
  if ((densT -= TICK) <= 0) { densT = DENS_EVERY; updateWant(caps); }
  if (!ring) updateWant(caps);

  // traffic: drop cars stuck out of view (and, on v2, cars left behind), then add one if under the target
  let traffic = 0, dropped = false, nLeft = 0;
  const keep = [], left = [];
  for (const c of G.cars) {
    if (c === G.player.car) c.leftT = null;
    else if (c.traffic && !c.owned && !c.managed) {
      const away = !seenAt(c.x, c.y), far = Math.hypot(c.x - focus.x, c.y - focus.y);
      if (c.ai && away && (c.ai.still > STUCK_DROP || (ring && far > RING.car.drop))) { dropped = true; countTraffic('despawned'); continue; }
      if (!c.ai && ring && away && far > RING.car.drop && !c.wreck) { dropped = true; continue; }
      if (!c.ai && !c.wreck) {
        // taken from traffic (carjacked, or its driver shot) and left about
        if (c.leftT == null) c.leftT = popT;
        nLeft++;
        if (away) left.push(c);
      }
    }
    if (c.ai && c.traffic) traffic++;
    keep.push(c);
  }
  // The grid replaces every car taken from traffic, so the ones left about would pile up: it keeps LEFT_KEEP
  // of them, and past that the longest-left of those out of view go.
  if (!ring && nLeft > LEFT_KEEP && left.length) {
    left.sort((a, b) => a.leftT - b.leftT);
    const gone = new Set(left.slice(0, nLeft - LEFT_KEEP));
    for (let i = keep.length - 1; i >= 0; i--) if (gone.has(keep[i])) { keep.splice(i, 1); dropped = true; }
  }
  if (dropped) G.cars = keep;
  if (traffic < want.traffic) spawnTraffic(false);
  if (ring) streamParked(caps);

  // people: the lost ones out of view start again elsewhere; then trim or top up to the target
  let n = 0;
  for (const p of G.peds) {
    if (p.role) continue;
    n++;
    if (p.lost && !seenAt(p.x, p.y) && p.state === 'walk') respawnPed(p, VIEW_R);
  }
  if (n > want.peds || ring) {
    let extra = n - want.peds;
    const before = G.peds.length;
    G.peds = G.peds.filter(p => {
      if (p.role || p.state === 'down' || p.state === 'knocked') return true;
      const away = !seenAt(p.x, p.y);
      if (ring && away && Math.hypot(p.x - focus.x, p.y - focus.y) > RING.ped.drop) { extra--; return false; }
      if (extra > 0 && away && p.state === 'walk') { extra--; return false; }
      return true;
    });
    n -= before - G.peds.length;
  }
  if (n < want.peds) { const q = pedSpot(false); if (q) addPed(q); }
}

// v2 parked cars: the spots within 220 m that hold a car get it, nearest first and out of view (anywhere at the
// start of a game), up to the cap; untouched ones past 300 m go, and past the cap the furthest out of view.
function streamParked(caps, anywhere = false) {
  const S = parkingSpots(), have = new Set();
  let mine = [];
  G.cars = G.cars.filter(c => {
    if (c.parked == null || c.touched || c === G.player.car) return true;
    if (Math.hypot(c.x - focus.x, c.y - focus.y) > RING.parked.drop) return false;
    have.add(c.parked); mine.push(c);
    return true;
  });
  if (mine.length > caps.parked) {
    const far = mine.filter(c => !seenAt(c.x, c.y)).sort((a, b) => dist2(b) - dist2(a)).slice(0, mine.length - caps.parked);
    if (far.length) { const gone = new Set(far); G.cars = G.cars.filter(c => !gone.has(c)); mine = mine.filter(c => !gone.has(c)); }
  }
  if (mine.length >= caps.parked) return;
  const r = RING.parked.show, cand = [];
  const i0 = Math.floor((focus.x - r) / CELL), i1 = Math.floor((focus.x + r) / CELL);
  const j0 = Math.floor((focus.y - r) / CELL), j1 = Math.floor((focus.y + r) / CELL);
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    for (const k of S.grid.get(i + ',' + j) || []) {
      if (have.has(k) || spotHash(k, 1) < 0.55) continue;
      const s = S.list[k], d2 = dist2(s);
      if (d2 > r * r || (!anywhere && seenAt(s.x, s.y))) continue;
      cand.push([d2, k]);
    }
  }
  cand.sort((a, b) => a[0] - b[0]);
  for (const [, k] of cand) {
    if (mine.length >= caps.parked) break;
    // a spot something else stands on (Kimchi's car, a stopped cruiser, a car shoved off its bay) stays empty
    const c = parkedAt(k);
    if (!c || G.cars.some(o => carOverlap(c, o, OV, SPAWN_PAD))) continue;
    G.cars.push(c); mine.push(c);
  }
}
const OV = {};
const dist2 = p => (p.x - focus.x) ** 2 + (p.y - focus.y) ** 2;
