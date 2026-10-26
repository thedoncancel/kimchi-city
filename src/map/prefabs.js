// Kimchi Key v2 prefabs (docs/map-v2-spec.md §1, §5.1, §7): the hand-made pieces of the map. Each place is
// today's world.js layout branch moved into a local frame, so the villa, the shops and the station look and
// sit exactly as they did on the grid, only turned to face their street. Plain data out: no three, no DOM.
//
// PREFABS[key](F, a, opts) builds one prefab whose front centre, local (20, 40), sits at world F = [x, z]
// (metres) and faces a (radians; π/2 = south, today's layout). It returns world metres:
//   buildings  [{cx, cz, w, d, a, h, floors, wall, roof, trim, sign, awning, house, shop, kind, place,
//               style, door: {x, z, a}}]   w across the front, d deep, a the way the front faces
//   place      {door, foot, curb, bay?} for a place prefab (else null): the §7 formulas, each {x, z, a}
//   surfaces   [{kind, obb: [cx, cz, w, d, a]} | {kind, poly: [[x, z]...]}] stamped in order
//   deco, palms, trees, lamps, solids, parking   (solids are world AABBs {x0, z0, x1, z1})
//   pads       [{poly, y?, blend}] the flat ground under the prefab (y omitted: the highest corner)
//   display?, garage?, spots?, plane?, pier?, photo?   the place extras of §5.1
//   pool?      the villa's pool: { obb: [cx, cz, w, d, a], y } (its water's rim, and the terrace height)
// opts.seed seeds the prefab's own random stream (palms, trees, and the like), so a prefab never depends
// on what was built before it.
//
// The landmarks' solid parts live here too (landmarkSolids, applyLandmarkSolids at the end): the footings,
// legs, plinths and walls of the Kimchi Tower's neighbours on the skyline, in the frames and sizes landmarks3d
// builds them with, stamped into the world's SURF and OCC so Kimchi, the cars, the camera and bullets stop at
// them.
import { KIND, FLAG, fillPoly } from './raster.js';
import { mulberry32 } from '../util.js';

const { GRASS, BUILD, LOT, PLAZA, WATER, ROAD, SAND } = KIND;
const HALF_PI = Math.PI / 2;
const TILE = 4;          // one grid tile is 4 m, so the 10-tile block interior is the 40 m local frame
const PXM = 16;          // grid px per metre: the layouts below keep world.js's px numbers (T = 64 px)
const T = TILE * PXM;
const DOOR_OUT = 1.4;    // the grid door sits 0.35 tile in front of its wall
const FOOT = 2.2, CURB = 10;   // §5.1: foot and curb are this far out from the door along the facing

// ---------- the §1 frame ----------

// World metres of local (lx, lz) for a prefab with front centre F facing a.
export function toWorld(F, a, lx, lz) {
  const s = Math.sin(a), c = Math.cos(a), dx = lx - 20, dz = lz - 40;
  return [F[0] + dx * s + dz * c, F[1] - dx * c + dz * s];
}
// A heading in the local frame (π/2 = towards the front) as a world heading.
export const toWorldHeading = (aLocal, a) => wrap(aLocal + (a - HALF_PI));
// The front centre F of a prefab whose block centre, local (20, 20), is at C.
export const frontOf = (C, a) => [C[0] + 20 * Math.cos(a), C[1] + 20 * Math.sin(a)];

function wrap(a) { return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI)); }
const along = (p, a, d) => ({ x: p.x + Math.cos(a) * d, z: p.z + Math.sin(a) * d, a });

// ---------- a block in the old tile layout ----------
// The builder speaks world.js's language: tile coordinates inside the 10×10 block (x0 = y0 = 0), px for
// offsets, a tile map that remembers what was filled (scatterTrees only plants on grass, as it did), and the
// same calls (fill, addBuilding, palm, scatterTrees). Everything it records is moved into the world at once.
function block(F, a, seed) {
  const r = mulberry32(seed >>> 0);
  const tiles = new Uint8Array(100).fill(GRASS);
  const out = {
    buildings: [], place: null, surfaces: [], deco: [], palms: [], trees: [], lamps: [], solids: [], parking: [],
    pads: [{ poly: square(F, a, 0, 0, 40, 40), blend: 6 }],
  };
  const W = (lpx, lpy) => toWorld(F, a, lpx / PXM, lpy / PXM);   // local px to world metres
  const B = {
    r, out, F, a,
    tileAt: (tx, ty) => (tx < 0 || ty < 0 || tx >= 10 || ty >= 10 ? BUILD : tiles[ty * 10 + tx]),
    fill(x, y, w, h, kind) {
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (i >= 0 && j >= 0 && i < 10 && j < 10) tiles[j * 10 + i] = kind;
      out.surfaces.push({ kind, obb: obb(F, a, (x + w / 2) * TILE, (y + h / 2) * TILE, w * TILE, h * TILE, HALF_PI) });
    },
    // a grid building {x, y, w, h} in tiles; its door is in front of the middle of its south (front) wall
    addBuilding(o) {
      B.fill(o.x, o.y, o.w, o.h, BUILD);
      out.surfaces.pop();                   // the building itself is stamped by the generator, not as a surface
      const b = building(F, a, { ...o, lx: (o.x + o.w / 2) * TILE, lz: (o.y + o.h / 2) * TILE, w: o.w * TILE, d: o.h * TILE });
      out.buildings.push(b);
      return b;
    },
    palm(tx, ty) {
      const [x, z] = W(tx * T, ty * T);
      out.palms.push({ x, z, h: 6.5 + r() * 3.5, lean: 0.06 + r() * 0.14, rot: r() * Math.PI * 2 });
    },
    scatterTrees(x0, y0, w, h, prob) {
      for (let ty = y0; ty < y0 + h; ty++) for (let tx = x0; tx < x0 + w; tx++) {
        if (B.tileAt(tx, ty) === GRASS && r() < prob) {
          const [x, z] = W((tx + 0.5) * T + (r() - 0.5) * 24, (ty + 0.5) * T + (r() - 0.5) * 24);
          out.trees.push({ x, z, r: (20 + r() * 12) / PXM });
        }
      }
    },
    // a piece of dressing at local px, facing the front unless aLocal (π/2 = towards the front) says otherwise
    deco(kind, lpx, lpy, aLocal = HALF_PI) { const [x, z] = W(lpx, lpy); out.deco.push({ kind, x, z, a: toWorldHeading(aLocal, a) }); },
    // a spot in local px with a local heading (π/2 = towards the front), as world {x, z, a}
    spot(lpx, lpy, aLocal) { const [x, z] = W(lpx, lpy); return { x, z, a: toWorldHeading(aLocal, a) }; },
    photo(id, lpx, lpy) { const [x, z] = W(lpx, lpy); out.photo = { id, x, z }; },
  };
  return B;
}

// A building record in world metres from a local centre (lx, lz), size w × d and local facing (default the
// front). The door is DOOR_OUT in front of the middle of its front wall, as on the grid.
function building(F, a, o) {
  const aL = o.aLocal ?? HALF_PI, [cx, cz] = toWorld(F, a, o.lx, o.lz), fa = toWorldHeading(aL, a);
  const reach = o.d / 2 + DOOR_OUT, [dx, dz] = toWorld(F, a, o.lx + Math.cos(aL) * reach, o.lz + Math.sin(aL) * reach);
  const h = o.ht ?? 6, house = !!o.house;
  return {
    cx, cz, w: o.w, d: o.d, a: fa, h, floors: o.floors ?? Math.max(1, Math.round(h / (house ? 3.0 : 3.2))),
    wall: o.wall, roof: o.roof, trim: o.trim ?? null, sign: o.sign ?? null, awning: o.awning ?? null, house,
    shop: !!o.shop, kind: o.kind || 'generic', place: o.place ?? null, style: o.style ?? null,
    door: { x: dx, z: dz, a: fa },
  };
}

// An oriented box from a local centre, size and local facing, as [cx, cz, w, d, a] in the world.
function obb(F, a, lx, lz, w, d, aLocal) {
  const [cx, cz] = toWorld(F, a, lx, lz);
  return [cx, cz, w, d, toWorldHeading(aLocal, a)];
}

// The local rectangle [x0, z0]-[x1, z1] (metres) as a world polygon.
function square(F, a, x0, z0, x1, z1) {
  return [toWorld(F, a, x0, z0), toWorld(F, a, x1, z0), toWorld(F, a, x1, z1), toWorld(F, a, x0, z1)];
}

// door, foot and curb of a place (§5.1): the door of its building, then 2.2 m and 10 m out along the facing.
function placeSpots(b) {
  const door = { ...b.door };
  return { door, foot: along(door, door.a, FOOT), curb: along(door, door.a, CURB) };
}

// ---------- today's places (world.js LAYOUT branches, verbatim apart from the frame) ----------

// The villa's terrace and its infinity pool in the villa's local frame (metres): the grid's 7 x 4 tiles of
// plaza in front of the house and the 5 x 2 tiles of water on it, the water starting a metre further out than
// the grid's (its tiles' middles still in it): the door's foot spot, 2.2 m out (§5.1), stands 1.4 m from it, so
// Kimchi starts clear of it. props3d draws the pool and the terrace's stone deck from these numbers (villaFrame
// finds the frame from the villa's door), so what stops his feet is the water he sees: the SURF's 1 m cells step
// in and out along the turned rim by up to 0.7 m, and his 0.5 m body stops with his feet from 0.1 m over the
// water (0.5 m at a corner) to 1.3 m short of it, half a metre mostly (tools/p4_test.mjs).
export const VILLA_TERRACE = { x0: 0, z0: 20, x1: 28, z1: 36 };
export const VILLA_POOL = { x0: 4, z0: 25, x1: 24, z1: 32 };
const VILLA_DOOR = [16, 20 + DOOR_OUT];    // the middle of the house's 24 m front (local x 4 to 28), DOOR_OUT out
const VILLA_Y = 58;                         // m: the summit pad the villa stands on (§3)

// The villa's frame from its door spot ({ x, z, a } m, the place's door): F, the world position of local
// (20, 40), and the facing a, for toWorld.
export function villaFrame(door) {
  const a = door.a, [lx, lz] = VILLA_DOOR, s = Math.sin(a), c = Math.cos(a), dx = lx - 20, dz = lz - 40;
  return { F: [door.x - dx * s - dz * c, door.z + dx * c - dz * s], a };
}

function villa(F, a, { seed = 1 } = {}) {
  // Kimchi's villa: concrete and glass, an infinity pool on the deck, the car collection on the drive
  const B = block(F, a, seed), { out } = B;
  const b = B.addBuilding({ x: 1, y: 1, w: 6, h: 4, wall: '#e4dfd5', roof: '#3c3a37', sign: 'VILLA', kind: 'place', place: 'home', ht: 6.85, floors: 2, style: 'mansion' });
  B.fill(0, 5, 7, 4, PLAZA);
  B.fill(1, 6, 5, 2, WATER);
  const P = VILLA_POOL;
  out.pool = { obb: obb(F, a, (P.x0 + P.x1) / 2, (P.z0 + P.z1) / 2, P.x1 - P.x0, P.z1 - P.z0, HALF_PI), y: VILLA_Y };
  out.surfaces[out.surfaces.length - 1].obb = out.pool.obb;
  B.fill(7, 0, 3, 10, LOT);
  out.garage = [];
  for (let i = 0; i < 4; i++) for (const cx of [7.8, 9.25]) out.garage.push(B.spot(cx * T, (1.4 + i * 2.1) * T, HALF_PI));
  // the loungers stand on the deck in front of the pool, their foot ends to the water (local −π/2: back to the
  // house), as round a resort pool
  for (const lx of [1.6, 2.9, 4.2]) B.deco('lounger', lx * T, 8.45 * T, -HALF_PI);
  B.deco('umbrella', 5.4 * T, 8.5 * T);
  for (const [px, py] of [[0.35, 5.4], [6.65, 5.4], [0.35, 8.7], [6.65, 8.7], [0.6, 0.5], [6.4, 0.5]]) B.palm(px, py);
  B.photo('villa', 3.5 * T, 8.75 * T);
  out.place = placeSpots(b);
  // §3: the villa's pad is its footprint plus 6 m, at the summit height, except in front of the pool terrace:
  // there it ends at the terrace's edge (local z 36), and the lawn below banks down the hill (mapdata's
  // villa_vista cap), so the terrace looks down on K-Town and the bay (§4.7 SL3). The garage court keeps its
  // full pad, out to where Villa Drive meets it.
  out.pads = [{ poly: [[-6, -6], [46, -6], [46, 46], [28, 46], [28, 36], [-6, 36]].map(([x, z]) => toWorld(F, a, x, z)), y: VILLA_Y, blend: 6 }];
  return out;
}

function mart(F, a, { seed = 2 } = {}) {
  const B = block(F, a, seed), { out } = B;
  B.fill(0, 6, 10, 4, PLAZA);
  const b = B.addBuilding({ x: 1, y: 1, w: 8, h: 5, wall: '#f7f3ea', roof: '#3d7a5c', sign: 'K-MART', awning: '#3d9a6a', kind: 'place', place: 'mart', ht: 5.4, shop: true });
  out.place = placeSpots(b);
  return out;
}

function dealer(F, a, { seed = 3 } = {}) {
  const B = block(F, a, seed), { out } = B;
  B.fill(0, 5, 10, 5, LOT);
  B.fill(7, 0, 3, 5, LOT);
  const b = B.addBuilding({ x: 0, y: 1, w: 6, h: 4, wall: '#17171a', roof: '#2a2a2e', sign: 'MOTORS', kind: 'place', place: 'dealer', ht: 6.2, shop: true });
  out.display = [];
  for (let i = 0; i < 4; i++) out.display.push(B.spot((1.3 + i * 2.35) * T, 6.4 * T, -HALF_PI));
  for (let i = 0; i < 3; i++) out.display.push(B.spot((2.45 + i * 2.35) * T, 8.65 * T, -HALF_PI));
  B.photo('motors', 8.4 * T, 2.5 * T);
  out.place = placeSpots(b);
  return out;
}

function kimchi(F, a, { seed = 4 } = {}) {
  const B = block(F, a, seed), { out } = B;
  B.fill(0, 6, 10, 4, PLAZA);
  const b = B.addBuilding({ x: 1, y: 1, w: 7, h: 5, wall: '#fbe9d2', roof: '#c23b2a', sign: 'KIMCHI HOUSE', awning: '#d6402b', kind: 'place', place: 'kimchi', ht: 4.6, shop: true });
  B.scatterTrees(8, 0, 2, 6, 0.5);
  out.place = placeSpots(b);
  return out;
}

function yuna(F, a, { seed = 5 } = {}) {
  const B = block(F, a, seed), { out } = B;
  B.fill(4, 6, 1, 4, PLAZA);
  const b = B.addBuilding({ x: 2, y: 2, w: 5, h: 4, wall: '#efe0f5', roof: '#7b5ea7', house: true, sign: "YUNA'S", kind: 'place', place: 'yuna', ht: 6.0, floors: 2, style: 'house' });
  B.scatterTrees(0, 0, 10, 10, 0.22);
  out.place = placeSpots(b);
  return out;
}

// The grid's square park (world.js 'park'). v2's Fountain Park is park_circle; this one is kept for blocks
// that want the old look.
function park(F, a, { seed = 6 } = {}) {
  const B = block(F, a, seed), { out } = B;
  B.fill(4, 0, 2, 10, PLAZA);
  B.fill(0, 4, 10, 2, PLAZA);
  const cx = 5 * T, cy = 5 * T;
  B.deco('fountain', cx, cy);
  B.photo('park', cx + 150, cy + 150);
  B.scatterTrees(0, 0, 10, 10, 0.32);
  for (const [dx, dy] of [[-2.2, 0], [2.2, 0]]) B.deco('bench', cx + dx * T, cy + dy * T + T * 0.9);
  const door = B.spot(cx, cy + 70, HALF_PI);
  out.place = { door, foot: along(door, door.a, FOOT), curb: along(door, door.a, CURB) };
  return out;
}

function police(F, a, { seed = 7 } = {}) {
  const B = block(F, a, seed), { out } = B;
  B.fill(0, 6, 10, 4, LOT);
  const b = B.addBuilding({ x: 1, y: 1, w: 8, h: 5, wall: '#e8eef5', roof: '#3a4a5c', sign: 'POLICE', awning: '#1f4f8a', kind: 'place', place: 'police', ht: 9.6, floors: 3 });
  out.spots = [0, 1, 2].map(i => B.spot((2 + i * 3) * T, 8 * T, -HALF_PI));
  out.place = placeSpots(b);
  return out;
}

function hospital(F, a, { seed = 8 } = {}) {
  const B = block(F, a, seed), { out } = B;
  B.fill(0, 7, 10, 3, PLAZA);
  const b = B.addBuilding({ x: 1, y: 1, w: 8, h: 6, wall: '#f7f7f4', roof: '#9aa4a8', sign: 'HOSPITAL', awning: '#e85d5d', kind: 'place', place: 'hospital', ht: 16, floors: 5 });
  B.scatterTrees(0, 7, 2, 3, 0.4);
  out.place = placeSpots(b);
  return out;
}

function spray(F, a, { seed = 9 } = {}) {
  const B = block(F, a, seed), { out } = B;
  B.fill(0, 5, 10, 5, LOT);
  const b = B.addBuilding({ x: 2, y: 1, w: 6, h: 4, wall: '#2e2a33', roof: '#4a4452', sign: 'K-SPRAY', awning: '#8a5cc2', kind: 'place', place: 'spray', ht: 5.2, shop: true });
  out.place = placeSpots(b);
  // the drive-in bay is the curb, on the yard in front of the door (§5.1: r 9 m)
  out.place.bay = { x: out.place.curb.x, z: out.place.curb.z, r: 9 };
  return out;
}

function guns(F, a, { seed = 10 } = {}) {
  const B = block(F, a, seed), { out } = B;
  B.fill(0, 6, 10, 4, PLAZA);
  const b = B.addBuilding({ x: 2, y: 1, w: 6, h: 5, wall: '#5a5d61', roof: '#2e3033', sign: 'K-ARMS', awning: '#c0262b', kind: 'place', place: 'guns', ht: 4.6, shop: true });
  B.scatterTrees(0, 6, 10, 4, 0.12);
  out.place = placeSpots(b);
  return out;
}

function watches(F, a, { seed = 11 } = {}) {
  const B = block(F, a, seed), { out } = B;
  B.fill(0, 6, 10, 4, PLAZA);
  const b = B.addBuilding({ x: 1, y: 1, w: 8, h: 5, wall: '#1c1b1f', roof: '#2a2830', sign: 'CHRONO ROW', kind: 'place', place: 'watches', ht: 6.6, shop: true });
  for (const px of [0.4, 9.6]) B.palm(px, 6.5), B.palm(px, 9.5);
  B.photo('boutiques', 9.4 * T, 8 * T);
  out.place = placeSpots(b);
  return out;
}

function fashion(F, a, { seed = 12 } = {}) {
  const B = block(F, a, seed), { out } = B;
  B.fill(0, 6, 10, 4, PLAZA);
  const b = B.addBuilding({ x: 1, y: 1, w: 8, h: 5, wall: '#eee8dc', roof: '#2a2830', sign: 'MAISON K', kind: 'place', place: 'fashion', ht: 6.6, shop: true });
  for (const px of [0.4, 9.6]) B.palm(px, 6.5), B.palm(px, 9.5);
  out.place = placeSpots(b);
  return out;
}

function jet(F, a, { seed = 13 } = {}) {
  // a private terminal with Kimchi One parked on the apron
  const B = block(F, a, seed), { out } = B;
  B.fill(0, 0, 10, 10, LOT);
  const b = B.addBuilding({ x: 6, y: 1, w: 4, h: 3, wall: '#f3f2ef', roof: '#3a3a3a', sign: 'KIMCHI AIR', kind: 'place', place: 'jet', ht: 5.2 });
  out.plane = B.spot(3.1 * T, 5.9 * T, -HALF_PI);
  // the parked jet blocks like a wall: ±22 px across its fuselage, ±2.7 tiles along it (world.js solids)
  const c = [[-22, -2.7 * T], [22, -2.7 * T], [22, 2.7 * T], [-22, 2.7 * T]].map(([dx, dy]) => toWorld(F, a, (3.1 * T + dx) / PXM, (5.9 * T + dy) / PXM));
  out.solids.push({ x0: Math.min(...c.map(p => p[0])), z0: Math.min(...c.map(p => p[1])), x1: Math.max(...c.map(p => p[0])), z1: Math.max(...c.map(p => p[1])) });
  B.photo('jet', 5.6 * T, 8.4 * T);
  out.place = placeSpots(b);
  return out;
}

function marina(F, a, { seed = 14, pierLen = 48 } = {}) {
  const B = block(F, a, seed), { out } = B;
  B.fill(0, 0, 10, 10, PLAZA);
  const b = B.addBuilding({ x: 1, y: 1, w: 6, h: 3, wall: '#f4f1ea', roof: '#1d2b4a', sign: 'YACHT CLUB', kind: 'place', place: 'marina', ht: 5.4 });
  for (const px of [0.5, 3, 5.5, 8, 9.5]) B.palm(px, 9.4);
  for (const py of [5, 7]) B.palm(9.4, py);
  B.photo('marina', 4.5 * T, 9.3 * T);
  // §5.1: the pier runs out from the front centre along the facing (its deck is a PATHS entry)
  out.pier = { x: F[0], z: F[1], a, len: pierLen };
  out.place = placeSpots(b);
  return out;
}

// A parking lot: ten bays facing the aisle (world.js 'lot').
function lot(F, a, { seed = 15 } = {}) {
  const B = block(F, a, seed), { out } = B;
  B.fill(0, 0, 10, 10, LOT);
  for (let i = 0; i < 5; i++) {
    out.parking.push(B.spot((1 + i * 2) * T, 2 * T, HALF_PI));
    out.parking.push(B.spot((1 + i * 2) * T, 7.5 * T, -HALF_PI));
  }
  return out;
}

// ---------- v2's new prefabs ----------

function empty(F, a, seed) {
  return { r: mulberry32(seed >>> 0), out: { buildings: [], place: null, surfaces: [], deco: [], palms: [], trees: [], lamps: [], solids: [], parking: [], pads: [] } };
}

// A circle of n points (local metres) as a world polygon.
function ring(F, a, lx, lz, r, n = 32) {
  return Array.from({ length: n }, (_, i) => toWorld(F, a, lx + r * Math.cos(2 * Math.PI * i / n), lz + r * Math.sin(2 * Math.PI * i / n)));
}

// Fountain Park inside Seoul Circle: a lawn of radius 36 m (the inner edge of the ring's sidewalk), a plaza
// round the fountain at its centre, local (20, 20), and a cross of paths out to each radial. The door is
// 70 px past the fountain, as on the grid; trees fill the lawn on a jittered 6 m lattice. Lamps light K-Town's
// heart after dark: RIM_LAMPS round the ring's inner pavement (0.6 m out from the lawn, between the paths'
// mouths, their arms out over the carriageway) and PATH_LAMPS along each path (either side in turn, their arms
// over it).
const RIM_LAMPS = 12, PATH_LAMPS = [[14, 1], [27, -1]];     // [m from the fountain, side of the path]
function park_circle(F, a, { seed = 16, r: R = 36 } = {}) {
  const { r, out } = empty(F, a, seed), C = [20, 20], [cx, cz] = toWorld(F, a, C[0], C[1]);
  out.surfaces.push({ kind: GRASS, poly: ring(F, a, C[0], C[1], R) });
  out.surfaces.push({ kind: PLAZA, obb: obb(F, a, C[0], C[1], 4, 2 * R + 2, HALF_PI) });
  out.surfaces.push({ kind: PLAZA, obb: obb(F, a, C[0], C[1], 2 * R + 2, 4, HALF_PI) });
  out.surfaces.push({ kind: PLAZA, poly: ring(F, a, C[0], C[1], 9, 24) });
  out.deco.push({ kind: 'fountain', x: cx, z: cz, a });
  for (const q of [0.25, 0.75, 1.25, 1.75]) {
    const t = q * Math.PI, [x, z] = toWorld(F, a, C[0] + Math.cos(t) * 11, C[1] + Math.sin(t) * 11);
    out.deco.push({ kind: 'bench', x, z, a: wrap(t + a - HALF_PI) });
  }
  for (let gz = -R; gz <= R; gz += 6) for (let gx = -R; gx <= R; gx += 6) {
    const jx = gx + (r() - 0.5) * 3, jz = gz + (r() - 0.5) * 3, d = Math.hypot(jx, jz);
    if (d < 12 || d > R - 3 || Math.abs(jx) < 4 || Math.abs(jz) < 4 || r() > 0.42) continue;
    const [x, z] = toWorld(F, a, C[0] + jx, C[1] + jz);
    out.trees.push({ x, z, r: (20 + r() * 12) / PXM });
  }
  for (let k = 0; k < RIM_LAMPS; k++) {
    const t = ((k + 0.5) * 2 * Math.PI) / RIM_LAMPS, [x, z] = toWorld(F, a, C[0] + Math.cos(t) * (R + 0.6), C[1] + Math.sin(t) * (R + 0.6));
    out.lamps.push({ x, z, a: toWorldHeading(t, a) });
  }
  for (let q = 0; q < 4; q++) {
    const t = (q * Math.PI) / 2, ux = Math.cos(t), uz = Math.sin(t);
    for (const [d, sd] of PATH_LAMPS) {
      const [x, z] = toWorld(F, a, C[0] + ux * d - uz * 2.6 * sd, C[1] + uz * d + ux * 2.6 * sd);
      out.lamps.push({ x, z, a: toWorldHeading(Math.atan2(-ux * sd, uz * sd), a) });
    }
  }
  const door = { x: cx + Math.cos(a) * 70 / PXM, z: cz + Math.sin(a) * 70 / PXM, a };
  out.place = { door, foot: along(door, a, FOOT), curb: along(door, a, CURB) };
  out.pads.push({ poly: ring(F, a, C[0], C[1], R, 24), blend: 6 });
  return out;
}

// Kimchi Fest inside the Fest Ring: one plaza over the ring's interior (the ring's centre line inset by its
// half width and sidewalk), a car park by the west end, the race board kiosk, benches, palms and lamps.
// The stage, the Ferris wheel and the arch are landmarks; Kimchi Motors is its own place on the north side.
// F is the front centre of the grounds, on the ring's south sidewalk, facing south.
function fest_grounds(F, a, { seed = 17 } = {}) {
  const { r, out } = empty(F, a, seed);
  const L = (lx, lz) => toWorld(F, a, lx, lz);
  // the interior, in local metres (local x runs east and local z south when a = π/2)
  const inner = [[-94, -42], [134, -42], [154, -13.5], [134, 40], [-94, 40], [-113, 1.5]];
  out.surfaces.push({ kind: PLAZA, poly: inner.map(([x, z]) => L(x, z)) });
  // the car park: two rows of five bays
  out.surfaces.push({ kind: LOT, obb: obb(F, a, -70, -26, 56, 22, HALF_PI) });
  for (let i = 0; i < 5; i++) {
    out.parking.push(spotAt(F, a, -90 + i * 10, -33, HALF_PI));
    out.parking.push(spotAt(F, a, -90 + i * 10, -19, -HALF_PI));
  }
  const [kx, kz] = L(35, -33.5);
  out.deco.push({ kind: 'kiosk', x: kx, z: kz, a });
  for (const [lx, lz] of [[-10, 0], [10, 0], [60, 20], [80, 20]]) { const [x, z] = L(lx, lz); out.deco.push({ kind: 'bench', x, z, a }); }
  for (let lx = -80; lx <= 120; lx += 25) for (const lz of [-36, 34]) {
    if (lz < 0 && (lx < -40 || (lx > 30 && lx < 110))) continue;     // the car park and Kimchi Motors' frontage
    const [x, z] = L(lx, lz);
    out.palms.push({ x, z, h: 6.5 + r() * 3.5, lean: 0.06 + r() * 0.14, rot: r() * Math.PI * 2 });
  }
  for (let lx = -55; lx <= 130; lx += 35) { const [x, z] = L(lx, 0); out.lamps.push({ x, z, a }); }   // clear of the stage at lx −80
  out.pads.push({ poly: inner.map(([x, z]) => L(x, z)), blend: 6 });
  return out;
}

// Kimchi Air's hangar row on the north side of the runway, and the runway itself: 720 m by 46 m, the drag
// strip from x 300 to 1020 (§2, §5.5). F is the front centre of the apron on the runway's north edge,
// facing south onto it.
function hangar_row(F, a, { seed = 18 } = {}) {
  const { out } = empty(F, a, seed);
  const runway = { lx: 120, lz: 63, w: 720, d: 46 };
  out.surfaces.push({ kind: LOT, obb: obb(F, a, 20, 23, 182, 34, HALF_PI) });     // the apron round the hangars
  out.surfaces.push({ kind: ROAD, obb: obb(F, a, runway.lx, runway.lz, runway.w, runway.d, HALF_PI), runway: true });
  const walls = ['#e9e6e0', '#d9d4cc', '#cfd8da', '#efe5d3'];
  [-40, 2, 44, 86].forEach((lx, i) => {
    out.buildings.push(building(F, a, { lx, lz: 23, w: 34, d: 26, ht: 12, floors: 1, wall: walls[i], roof: '#6e7378',
      sign: i === 1 ? 'KIMCHI AIR' : null, kind: 'hangar', style: 'hangar' }));
  });
  out.pads.push({ poly: square(F, a, -71, 6, 111, 40), blend: 6 });
  out.pads.push({ poly: square(F, a, runway.lx - runway.w / 2, runway.lz - runway.d / 2, runway.lx + runway.w / 2, runway.lz + runway.d / 2), blend: 6 });
  out.runway = { ...runway, a, poly: square(F, a, runway.lx - runway.w / 2, runway.lz - runway.d / 2, runway.lx + runway.w / 2, runway.lz + runway.d / 2) };
  return out;
}

// Star Island inside Star Island Drive: the motor court at the island's centre, local (20, 20), the LOT
// strip south to the drive (the stolen-car anchor, §5.4), and six mansions round it, each facing the drive.
function star_mansions(F, a, { seed = 19 } = {}) {
  const { out } = empty(F, a, seed), C = [20, 20];
  out.surfaces.push({ kind: LOT, obb: obb(F, a, C[0], C[1], 28, 16, HALF_PI) });
  out.surfaces.push({ kind: LOT, obb: obb(F, a, C[0], C[1] + 22, 8, 28, HALF_PI) });
  const walls = ['#f4f1ea', '#efe0d0', '#e6e9ee', '#f2e8d8', '#e8efe4', '#f6efe6'];
  const roofs = ['#b5533c', '#4f6b8a', '#7a4f45', '#5f5a56', '#b5533c', '#3c3a37'];
  // [dx, dz, w, d, local facing]: east and west ends, then two either side of the court to the north and south
  const lots = [[-36, 0, 14, 12, Math.PI], [36, 0, 14, 12, 0], [-18, -17, 14, 10, -HALF_PI], [18, -17, 14, 10, -HALF_PI],
    [-18, 17, 14, 10, HALF_PI], [18, 17, 14, 10, HALF_PI]];
  lots.forEach(([dx, dz, w, d, aL], i) => {
    out.buildings.push(building(F, a, { lx: C[0] + dx, lz: C[1] + dz, w, d, aLocal: aL, ht: 7 + (i % 3) * 1.5, floors: 2,
      wall: walls[i], roof: roofs[i], house: true, kind: 'mansion', style: 'mansion' }));
  });
  out.pads.push({ poly: ring(F, a, C[0], C[1], 30, 16), blend: 6 });
  return out;
}

function spotAt(F, a, lx, lz, aLocal) { const [x, z] = toWorld(F, a, lx, lz); return { x, z, a: toWorldHeading(aLocal, a) }; }

export const PREFABS = {
  villa, mart, dealer, kimchi, yuna, park, police, hospital, spray, guns, watches, fashion, jet, marina, lot,
  park_circle, fest_grounds, hangar_row, star_mansions,
};

// ---------- the landmarks' solid parts ----------
// What of each landmark (spec §5.7) stops a car or Kimchi, and how high it stands for the camera, bullets and
// sight lines: its footings, legs, plinths and walls, in the frames and sizes landmarks3d builds it with (the
// numbers both need are here). A landmark's frame has +x along its heading a and +z to the right of it (x east,
// z south, metres). Overhead parts are left open: OCC keeps one height per 2 m cell, from the ground up, so a
// beam stamped there would pull in the camera of a car driving under it. So the Fest arch and the K-Town gate
// keep their columns, the cranes their legs and the sills between them, the lookout tower its four legs.
// The Kimchi Tower is a building (its footprint is BUILD), and the causeway's pylon, the Rickenbacker's arch and
// the Venetian bascule houses stand beside the decks over the water, so none of them is here.

// The lighthouse's stone base (m): its radius, and how far its top stands over the ground at the tower's foot.
export const LH_BASE = { r: 4.2, lift: 0.4 };
// The keeper's cottage (m): w along its ridge, d across, wall height over its floor.
export const COTTAGE = { w: 8, d: 4.6, wall: 3.2 };
// The curved resort (m): the arc's radius and the slab's depth, ±span rad, its west face this far west of the
// landmark point, the podium's depth in front of the ocean face and the entrance canopy's reach past it.
export const RESORT = { Rc: 60, depth: 14, span: 0.55, west: 20, podium: 8, canopy: 5 };
// The KIMCHI letters (widths in m at 18 m tall; landmarks3d draws their shapes)
export const LETTER_WORD = ['K', 'I', 'M', 'C', 'H', 'I'];
const LETTER_W = { K: 12.4, I: 4.2, M: 15, C: 12.4, H: 12 };

// The letters across the sign T (w m wide, h tall): [{ c, w, z0 }] in its frame, each letter w wide from local
// z0 down to z0 − w (the word runs toward −z, so it reads left to right from in front), with even gaps between.
export function letterSpans(T) {
  const total = T.w || 86, k = (T.h || 18) / 18, widths = LETTER_WORD.map(c => LETTER_W[c] * k);
  const gap = (total - widths.reduce((s, w) => s + w, 0)) / (LETTER_WORD.length - 1);
  let cursor = 0;
  return LETTER_WORD.map((c, i) => {
    const span = { c, w: widths[i], z0: total / 2 - cursor };
    cursor += widths[i] + gap;
    return span;
  });
}

// The point of RoadNet edge e at station s (px): { x, z, y (deck or road height), tx, tz } in m.
export function edgeAt(e, s) {
  let lo = 0, hi = e.n - 1;
  s = Math.max(e.s[0], Math.min(e.s[hi], s));
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (e.s[m] <= s) lo = m; else hi = m; }
  const f = e.s[hi] > e.s[lo] ? (s - e.s[lo]) / (e.s[hi] - e.s[lo]) : 0;
  const tx = e.tx[lo] + (e.tx[hi] - e.tx[lo]) * f, tz = e.ty[lo] + (e.ty[hi] - e.ty[lo]) * f, l = Math.hypot(tx, tz) || 1;
  return { x: (e.x[lo] + (e.x[hi] - e.x[lo]) * f) / PXM, z: (e.y[lo] + (e.y[hi] - e.y[lo]) * f) / PXM, y: e.gy[lo] + (e.gy[hi] - e.gy[lo]) * f, tx: tx / l, tz: tz / l };
}
// The edge of a road (any road when none is named) nearest (x, z) m and the station there: { e, s, d (px) } or null.
export function roadAt(net, x, z, road = null) {
  if (!net?.edges?.length) return null;
  let best = null;
  for (const e of net.edges) {
    if (road && e.road !== road) continue;
    for (let i = 0; i + 1 < e.n; i++) {
      const ax = e.x[i], ay = e.y[i], dx = e.x[i + 1] - ax, dy = e.y[i + 1] - ay, l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x * PXM - ax) * dx + (z * PXM - ay) * dy) / l2)) : 0;
      const d = Math.hypot(x * PXM - ax - dx * t, z * PXM - ay - dy * t);
      if (!best || d < best.d) best = { e, s: e.s[i] + (e.s[i + 1] - e.s[i]) * t, d };
    }
  }
  return best;
}
// The heading and road height of a landmark that spans a road (the K-Town gate, the Fest arch): it stands
// square across the road's line at its point, so its local +x runs along the road. { a, y }
export function spanFrame(net, T) {
  const hit = roadAt(net, T.x, T.z, T.road), c = hit ? edgeAt(hit.e, hit.s) : null;
  return { a: c ? Math.atan2(c.tz, c.tx) : T.a, y: c ? c.y : T.base };
}

// Where the keeper's cottage stands: beside the lighthouse T, turned along the slope rather than down it. The
// lighthouse's beach falls toward the sea, so of 24 spots round the tower it takes the most level one on dry
// ground with no palm or tree on it. { x, z, a, lo, hi } (lo and hi: the lowest and highest ground under it) or
// null. world: groundY, surfaceAt, palms, trees, SAND, GRASS, SEA_LEVEL.
export function cottageSpot(world, T) {
  const gy = (x, z) => world.groundY(x * PXM, z * PXM), d = LH_BASE.r + 2 + COTTAGE.d / 2;
  const plants = [...(world.palms || []), ...(world.trees || [])].map(p => [p.x / PXM, p.y / PXM]);
  const sand = world.SAND ?? SAND, grass = world.GRASS ?? GRASS;
  let best = null;
  for (let i = 0; i < 24; i++) {
    const b = (i / 24) * Math.PI * 2, x = T.x + Math.cos(b) * d, z = T.z + Math.sin(b) * d, a = b + Math.PI / 2;
    const c = Math.cos(a), s = Math.sin(a), hw = COTTAGE.w / 2 + 0.6, hd = COTTAGE.d / 2 + 0.6;
    let lo = Infinity, hi = -Infinity, dry = true;
    for (const u of [-hw, -hw / 2, 0, hw / 2, hw]) for (const v of [-hd, 0, hd]) {
      const px = x + u * c - v * s, pz = z + u * s + v * c, g = gy(px, pz), sf = world.surfaceAt(px * PXM, pz * PXM);
      lo = Math.min(lo, g); hi = Math.max(hi, g);
      if ((sf !== sand && sf !== grass) || g < (world.SEA_LEVEL ?? -1) + 0.3) dry = false;
    }
    if (!dry || plants.some(([px, pz]) => Math.abs((px - x) * c + (pz - z) * s) < hw + 1 && Math.abs((pz - z) * c - (px - x) * s) < hd + 1)) continue;
    if (!best || hi - lo < best.hi - best.lo) best = { x, z, a, lo, hi };
  }
  return best;
}

// The nearest spot to (x, z) m, within 40 m, where a disc of radius r is all open ground (grass, no path running
// through the middle): where the Bayfront fountain stands. Falls back to (x, z).
export function clearSpot(world, x, z, r) {
  const grass = world.GRASS ?? GRASS;
  const ok = (cx, cz) => {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      for (const f of [0.35, 0.7, 1]) if (world.surfaceAt((cx + Math.cos(a) * r * f) * PXM, (cz + Math.sin(a) * r * f) * PXM) !== grass) return false;
    }
    return world.surfaceAt(cx * PXM, cz * PXM) === grass;
  };
  if (ok(x, z)) return { x, z };
  for (let d = 2; d <= 40; d += 2) for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2, cx = x + Math.cos(a) * d, cz = z + Math.sin(a) * d;
    if (ok(cx, cz)) return { x: cx, z: cz };
  }
  return { x, z };
}

// The solid parts of the world's landmarks and fountains: [{ id, poly: [[x, z]...] (m), top (m over the sea;
// 0: no OCC), car, foot (what it stops) }]. world (after generate()): landmarks, roads, deco, groundY,
// surfaceAt, palms, trees.
export function landmarkSolids(world) {
  const out = [], net = world.roads, list = world.landmarks || [];
  const L = (id) => list.find(q => q.id === id);
  const part = (id, poly, top, foot = true) => out.push({ id, poly, top, car: true, foot });
  // a box from (u0, v0) to (u1, v1) in the frame at (x, z) heading a, and a disc
  const box = (id, x, z, a, u0, v0, u1, v1, top, foot = true) => {
    const c = Math.cos(a), s = Math.sin(a), P = (u, v) => [x + u * c - v * s, z + u * s + v * c];
    part(id, [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)], top, foot);
  };
  const disc = (id, x, z, r, top) => part(id, Array.from({ length: 20 }, (_, i) => [x + r * Math.cos(i * Math.PI / 10), z + r * Math.sin(i * Math.PI / 10)]), top);
  let T;
  // the KIMCHI letters: each letter's foot with the posts just behind it, and the feet of its two back braces
  if ((T = L('kimchi_letters'))) {
    for (const { w, z0 } of letterSpans(T)) {
      box(T.id, T.x, T.z, T.a, -0.9, z0 - w, 1.0, z0, T.base + (T.h || 18));
      for (const u of [0.25, 0.75]) box(T.id, T.x, T.z, T.a, -6.6, z0 - u * w - 0.6, -5.4, z0 - u * w + 0.6, 0);
    }
  }
  // the lighthouse: its round stone base, the tower up to its spire, and the keeper's cottage
  if ((T = L('lighthouse'))) {
    disc(T.id, T.x, T.z, LH_BASE.r + 0.15, 0);
    disc(T.id, T.x, T.z, 3.4, T.base + LH_BASE.lift + (T.h || 30) + 1);
    const c = cottageSpot(world, T), { w, d, wall } = COTTAGE;
    if (c) box(T.id, c.x, c.z, c.a, -w / 2 - 0.15, -d / 2 - 0.15, w / 2 + 0.15, d / 2 + 0.15, c.hi + wall + 2);
  }
  // the Port cranes: the legs and the sill between them on the land side (local x −12) and the water side (6),
  // up to the portal; a car or Kimchi passes under the portal between them
  for (const C of list.filter(q => q.kind === 'crane')) {
    for (const lx of [-12, 6]) box(C.id, C.x, C.z, C.a, lx - 0.75, -8.25, lx + 0.75, 8.25, C.base + (C.h || 45) * 0.62 + 1.3);
  }
  // the Ferris wheel: its boarding slab keeps cars off (people walk on it, and under the wheel where its
  // gondolas pass more than 1.2 m up), its legs, the gondolas' lowest stretch and the ticket booth stop everyone
  if ((T = L('ferris_wheel'))) {
    box(T.id, T.x, T.z, T.a, -6, -16, 6, 16, 0, false);
    box(T.id, T.x, T.z, T.a, -1.6, -4.2, 1.6, 4.2, T.base + (T.d || 40) + 4.1);
    for (const u of [-4.8, 4.8]) for (const v of [-13, 13]) box(T.id, T.x, T.z, T.a, u - 0.7, v - 0.7, u + 0.7, v + 0.7, T.base + (T.d || 40) / 2 + 3.6);
    box(T.id, T.x, T.z, T.a, -5.7, 3.9, -2.3, 7.6, T.base + 3.4);
  }
  // the Fest arch's and the K-Town gate's columns, either side of their roads
  if ((T = L('fest_arch'))) {
    const f = spanFrame(net, T), half = (T.span || 22) / 2;
    for (const sd of [-1, 1]) box(T.id, T.x, T.z, f.a, -1, sd * half - 1, 1, sd * half + 1, T.base + (T.h || 11) + 1.7);
  }
  if ((T = L('ktown_gate'))) {
    const f = spanFrame(net, T), half = (T.span || 18) / 2;
    for (const sd of [-1, 1]) box(T.id, T.x, T.z, f.a, -2.1, sd * half - 0.8, 2.1, sd * half + 0.8, f.y + (T.h || 9) + 1.4);
  }
  // the festival stage's deck (1.6 m up) under its canopy, and the speaker towers either side of it
  if ((T = L('fest_stage'))) {
    box(T.id, T.x, T.z, T.a, -7.1, -11.1, 5.3, 11.1, T.base + (T.h || 12) + 1.4);
    for (const sd of [-1, 1]) box(T.id, T.x, T.z, T.a, -1.1, sd * 12.5 - 1.3, 2.6, sd * 12.5 + 1.3, T.base + 7.4);
  }
  // Kimchi Air's control tower: the office block and the shaft up to the cab's roof
  if ((T = L('control_tower'))) {
    box(T.id, T.x, T.z, T.a, -7.1, -5.1, 7.1, 5.1, T.base + 4.6);
    disc(T.id, T.x, T.z, 4.9, T.base + (T.h || 22) - 0.2);
  }
  // the Glades lookout's four legs (its decks are 6 m up: the camera and Kimchi go under them)
  if ((T = L('glades_tower'))) for (const u of [-2.76, 2.76]) for (const v of [-2.76, 2.76]) box(T.id, T.x, T.z, T.a, u - 0.6, v - 0.6, u + 0.6, v + 0.6, 0);
  // the fountains' basins: the Bayfront one on its lawn, every park's
  if ((T = L('bayfront_fountain'))) { const p = clearSpot(world, T.x, T.z, 9); disc(T.id, p.x, p.z, 8.25, 0); }
  for (const d of world.deco || []) if (d.kind === 'fountain') disc('fountain', d.x / PXM, d.y / PXM, 4.25, 0);
  // the curved resort: the slab to its roof sign, the podium in front of it
  if ((T = L('deco_resort'))) {
    const R = RESORT, cx = T.x + R.Rc - R.west, ri = R.Rc - R.depth, rp = ri - R.podium, floors = Math.round(((T.h || 60) - 2.4) / 3.2);
    const sector = (r0, r1) => {
      const pts = [], n = 16, pt = (r, t) => [cx - Math.cos(t) * r, T.z + Math.sin(t) * r];
      for (let i = 0; i <= n; i++) pts.push(pt(r1, -R.span + (2 * R.span * i) / n));
      for (let i = n; i >= 0; i--) pts.push(pt(r0, -R.span + (2 * R.span * i) / n));
      return pts;
    };
    part(T.id, sector(ri, R.Rc + 0.1), T.base + floors * 3.2 + 5.5);
    part(T.id, sector(rp - 0.1, ri), T.base + 3.2 * 3);
  }
  return out;
}

// Stamp the landmarks' solid parts into the world's rasters, once: BLOCK_CAR and BLOCK_FOOT added to the SURF
// cells under them (each cell keeps its kind, so the ground looks as it did and nothing is scattered there) and
// their tops into OCC, the higher one winning. OCC's cells are 2 m, so a leg thinner than that could miss every
// cell's centre: its top goes into every cell a point of it falls in (a 0.5 m lattice). Returns the parts.
// world: as landmarkSolids, plus grids (a world without SURF, the grid, gets none).
export function applyLandmarkSolids(world) {
  const G = world.grids;
  if (!G?.surf || !G.occ || !G.dims) return [];
  if (G.landmarkSolids) return G.landmarkSolids;
  const parts = landmarkSolids(world);
  const [SW, SH] = G.dims.surf, [OW, OH, OC] = G.dims.occ;
  const SG = { w: SW, h: SH, cell: 1, o: 0.5, data: G.surf };
  for (const p of parts) {
    fillPoly(SG, p.poly, (p.car ? FLAG.BLOCK_CAR : 0) | (p.foot ? FLAG.BLOCK_FOOT : 0), 'or');
    if (!(p.top > 0)) continue;
    const v = Math.min(255, Math.ceil(p.top)), xs = p.poly.map(q => q[0]), zs = p.poly.map(q => q[1]);
    for (let z = Math.min(...zs); z <= Math.max(...zs); z += 0.5) for (let x = Math.min(...xs); x <= Math.max(...xs); x += 0.5) {
      const i = Math.floor(x / OC), j = Math.floor(z / OC);
      if (i < 0 || j < 0 || i >= OW || j >= OH || !insidePoly(p.poly, x, z)) continue;
      if (G.occ[j * OW + i] < v) G.occ[j * OW + i] = v;
    }
  }
  G.landmarkSolids = parts;
  return parts;
}

// Is (x, z) inside the polygon [[x, z]...] (even-odd)?
function insidePoly(pts, x, z) {
  let inside = false;
  for (let k = 0, m = pts.length - 1; k < pts.length; m = k++) {
    const [ax, az] = pts[m], [bx, bz] = pts[k];
    if ((az <= z) !== (bz <= z) && x < ax + ((z - az) / (bz - az)) * (bx - ax)) inside = !inside;
  }
  return inside;
}
