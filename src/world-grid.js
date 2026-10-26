import { mulberry32, roundRect, circle, ellipse } from './util.js';
import { buildRoadNet } from './map/roadnet.js';
import { latticeRoads } from './map/gridroads.js';

// The classic world: today's tile grid, answering the World API v2 (docs/map-v2-spec.md §7) so the
// game can run on either map through the src/world.js facade. Exports are never reassigned:
// constants, functions, and containers that generate() fills in place.

// The city is a grid of blocks. Each block is P tiles wide: 2 road tiles, then a sidewalk ring
// around a 10x10 interior that holds buildings, parks or parking lots.
export const T = 64, P = 14, BLOCKS = 6, N = P * BLOCKS + 2, SIZE = N * T;
export const ROAD = 0, WALK = 1, GRASS = 2, BUILD = 3, LOT = 4, PLAZA = 5, WATER = 6;
// surface kinds only the v2 map paints; listed so code can name them on either world
export const SAND = 7, DIRT = 8, SHALLOW = 9, DECK = 10, ROCK = 11;

export const KIND = 'grid', MAP_VERSION = 1, READY = true;
export const PX_PER_M = 16;         // sim pixels per metre
export const SEA_LEVEL = -1;        // metres, the sea plane around the island
export const BOUNDS = { x0: 0, y0: 0, x1: SIZE, y1: SIZE };
// classic driving: no lateral-g cap, flat ground, no airtime, walls block per axis (spec §10)
export const PHYS = { gripG: 0, slope: false, air: false, wall: 'axis', substepPx: Infinity, gripTable: 'classic' };

export const tiles = new Uint8Array(N * N);
export const buildings = [], trees = [], lamps = [], jarSpots = [], parkedSpawns = [], displaySpots = [], deco = [];
export const palms = [];        // { x, y, h, lean, rot }
export const solids = [];       // extra blocked rectangles in px (the parked jet)
export const photoSpots = [];   // where a picture gets you followers: { id, name, x, y, bonus }
export const places = {};
export const deliveryDoors = [];   // { b, curb } for every building a delivery job can go to
export const benchViews = [];      // fixed views for screenshots and the perf bench: { name, x, y, yaw, heading, car }
// The road graph (a RoadNet over the 7x7 lattice, src/map/roadnet.js), the mission anchors and the race
// routes are filled in place by generate(); the grid has no activities or landmarks.
export const roads = { nodes: [], edges: [], lanes: [], conns: [] };
export const anchors = {}, routes = {};
export const activities = [], landmarks = [];
export const regions = [{ id: 'classic', name: 'Kimchi City' }];
export const roadCenter = k => k * P * T + T;

export function tileAt(tx, ty) { return (tx < 0 || ty < 0 || tx >= N || ty >= N) ? BUILD : tiles[ty * N + tx]; }
export function tileAtPx(x, y) { return tileAt(Math.floor(x / T), Math.floor(y / T)); }
export function blockedPx(x, y) {
  const t = tileAtPx(x, y);
  if (t === BUILD || t === WATER) return true;
  for (const r of solids) if (x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1) return true;
  return false;
}

// ---------- World API v2 queries ----------
// The grid has no surface flags, so cars and people are blocked by the same tiles.
export const surfaceAt = tileAtPx;
export const blockedCarPx = blockedPx, blockedFootPx = blockedPx;
// Grid walls are tile edges, so the car keeps today's per-axis blocking instead of sliding along a normal.
export const wallNormalPx = () => null;
export const regionAt = () => 'classic';

// Height of the walkable surface in metres: curbs and lawns sit a little above the road
// (the same table the 3D city has always used).
const GROUND_H = { [ROAD]: 0, [LOT]: 0.04, [WALK]: 0.16, [GRASS]: 0.13, [PLAZA]: 0.16, [BUILD]: 0.16, [WATER]: -0.14 };
export const groundY = (x, y) => GROUND_H[tileAtPx(x, y)] ?? 0;

// Grass slows a car to 55% of its top speed; everything else is full grip.
const GRIP_GRASS = Object.freeze({ max: 0.55, lat: 1 }), GRIP_FULL = Object.freeze({ max: 1, lat: 1 });
export const gripAt = (x, y) => (tileAtPx(x, y) === GRASS ? GRIP_GRASS : GRIP_FULL);

// Can a shooter or a cop see from one point to another? Buildings and water block it, sampled
// every 24 px. The grid is flat, so the eye heights h0 and h1 do not matter.
export function sightClear(x0, y0, h0, x1, y1, h1) {
  const d = Math.hypot(x1 - x0, y1 - y0), n = Math.ceil(d / 24);
  for (let i = 1; i < n; i++) if (blockedPx(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n)) return false;
  return true;
}

// The title screen camera: a slow orbit over the middle of town (metres, t in seconds).
// pose() writes into anything with x, y, z, such as a THREE.Vector3.
const MID = SIZE / PX_PER_M / 2;
export const titleView = {
  kind: 'orbit', x: MID, z: MID, r: 175, y: 72, speed: 0.035, look: { x: MID, y: 4, z: MID },
  pose(t, pos, look) {
    const v = titleView, a = t * v.speed;
    pos.x = v.x + Math.cos(a) * v.r; pos.y = v.y; pos.z = v.z + Math.sin(a) * v.r;
    look.x = v.look.x; look.y = v.look.y; look.z = v.look.z;
  },
};

function fill(x, y, w, h, v) {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) tiles[j * N + i] = v;
}
export const hash = (x, y) => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

const WALLS = ['#e6d5bc', '#cfd8da', '#e8c4b4', '#ddd5b4', '#c4d1b2', '#efe5d3', '#d6c8e2', '#f0d9a8', '#bfcfe0', '#d9d4cc', '#c9c6c0', '#e9e6e0'];
const ROOFS = ['#5f5a56', '#6e5848', '#4f5b63', '#686d58', '#7a4f45', '#4a4a52', '#5c6b6e'];
const palm = (tx, ty, r) => palms.push({ x: tx * T, y: ty * T, h: 6.5 + r() * 3.5, lean: 0.06 + r() * 0.14, rot: r() * Math.PI * 2 });

function addBuilding(o) {
  const b = { kind: 'generic', house: false, sign: null, ...o, id: buildings.length };
  b.door = { x: (b.x + b.w / 2) * T, y: (b.y + b.h) * T + T * 0.35, a: Math.PI / 2 };   // every grid door faces south
  fill(b.x, b.y, b.w, b.h, BUILD);
  buildings.push(b);
  return b;
}

let generated = false;
export function generate() {
  if (generated) return;     // the containers are filled once; a second call must not duplicate them
  generated = true;
  const r = mulberry32(20261020);
  const pickR = a => a[Math.floor(r() * a.length)];

  for (let ty = 0; ty < N; ty++) for (let tx = 0; tx < N; tx++) {
    const mx = tx % P, my = ty % P;
    tiles[ty * N + tx] = (mx < 2 || my < 2) ? ROAD
      : (mx === 2 || mx === P - 1 || my === 2 || my === P - 1) ? WALK : GRASS;
  }

  const scatterTrees = (x0, y0, w, h, prob) => {
    for (let ty = y0; ty < y0 + h; ty++) for (let tx = x0; tx < x0 + w; tx++) {
      if (tileAt(tx, ty) === GRASS && r() < prob)
        trees.push({ x: (tx + 0.5) * T + (r() - 0.5) * 24, y: (ty + 0.5) * T + (r() - 0.5) * 24, r: 20 + r() * 12 });
    }
  };

  const LAYOUT = {
    '1,1': 'home', '2,1': 'mart', '3,2': 'dealer', '1,3': 'kimchi', '4,1': 'yuna',
    '2,2': 'park', '3,4': 'park', '3,1': 'lot', '0,2': 'lot', '4,3': 'lot',
    '4,2': 'police', '1,5': 'hospital', '2,4': 'spray', '5,2': 'guns',
    '2,3': 'watches', '3,3': 'fashion', '5,5': 'jet', '0,5': 'marina',
  };

  for (let by = 0; by < BLOCKS; by++) for (let bx = 0; bx < BLOCKS; bx++) {
    const x0 = bx * P + 3, y0 = by * P + 3;
    const kind = LAYOUT[`${bx},${by}`];

    if (kind === 'home') {
      // Kimchi's villa: concrete and glass, an infinity pool on the deck, the car collection on the drive
      const b = addBuilding({ x: x0 + 1, y: y0 + 1, w: 6, h: 4, wall: '#e4dfd5', roof: '#3c3a37', sign: 'VILLA', kind: 'place', place: 'home' });
      fill(x0, y0 + 5, 7, 4, PLAZA);
      fill(x0 + 1, y0 + 6, 5, 2, WATER);
      fill(x0 + 7, y0, 3, 10, LOT);
      const garage = [];
      for (let i = 0; i < 4; i++) for (const cx of [7.8, 9.25]) garage.push({ x: (x0 + cx) * T, y: (y0 + 1.4 + i * 2.1) * T, a: Math.PI / 2 });
      places.home = { key: 'home', name: "Kimchi's Villa", icon: '🏠', color: '#d4af37', door: b.door, b, spawn: garage[0], garage };
      for (const lx of [1.6, 2.9, 4.2]) deco.push({ kind: 'lounger', x: (x0 + lx) * T, y: (y0 + 8.45) * T });
      deco.push({ kind: 'umbrella', x: (x0 + 5.4) * T, y: (y0 + 8.5) * T });
      for (const [px, py] of [[0.35, 5.4], [6.65, 5.4], [0.35, 8.7], [6.65, 8.7], [0.6, 0.5], [6.4, 0.5]]) palm(x0 + px, y0 + py, r);
      photoSpots.push({ id: 'villa', name: 'Villa Infinity Pool', x: (x0 + 3.5) * T, y: (y0 + 8.75) * T, bonus: 1.2 });
    } else if (kind === 'mart') {
      fill(x0, y0 + 6, 10, 4, PLAZA);
      const b = addBuilding({ x: x0 + 1, y: y0 + 1, w: 8, h: 5, wall: '#f7f3ea', roof: '#3d7a5c', sign: 'K-MART', awning: '#3d9a6a', kind: 'place', place: 'mart' });
      places.mart = { key: 'mart', name: 'K-Mart', icon: '🛒', color: '#3d9a6a', door: b.door, b };
    } else if (kind === 'dealer') {
      fill(x0, y0 + 5, 10, 5, LOT);
      fill(x0 + 7, y0, 3, 5, LOT);
      const b = addBuilding({ x: x0, y: y0 + 1, w: 6, h: 4, wall: '#17171a', roof: '#2a2a2e', sign: 'MOTORS', kind: 'place', place: 'dealer' });
      places.dealer = { key: 'dealer', name: 'Kimchi Motors', icon: '🏎️', color: '#b89350', door: b.door, b };
      for (let i = 0; i < 4; i++) displaySpots.push({ x: (x0 + 1.3 + i * 2.35) * T, y: (y0 + 6.4) * T, a: -Math.PI / 2 });
      for (let i = 0; i < 3; i++) displaySpots.push({ x: (x0 + 2.45 + i * 2.35) * T, y: (y0 + 8.65) * T, a: -Math.PI / 2 });
      photoSpots.push({ id: 'motors', name: 'Kimchi Motors', x: (x0 + 8.4) * T, y: (y0 + 2.5) * T, bonus: 1.0 });
    } else if (kind === 'kimchi') {
      fill(x0, y0 + 6, 10, 4, PLAZA);
      const b = addBuilding({ x: x0 + 1, y: y0 + 1, w: 7, h: 5, wall: '#fbe9d2', roof: '#c23b2a', sign: 'KIMCHI HOUSE', awning: '#d6402b', kind: 'place', place: 'kimchi' });
      places.kimchi = { key: 'kimchi', name: 'Kimchi House', icon: '🌶️', color: '#e8622c', door: b.door, b };
      scatterTrees(x0 + 8, y0, 2, 6, 0.5);
    } else if (kind === 'yuna') {
      fill(x0 + 4, y0 + 6, 1, 4, PLAZA);
      const b = addBuilding({ x: x0 + 2, y: y0 + 2, w: 5, h: 4, wall: '#efe0f5', roof: '#7b5ea7', house: true, sign: "YUNA'S", kind: 'place', place: 'yuna' });
      places.yuna = { key: 'yuna', name: "Yuna's House", icon: '💜', color: '#9b7be0', door: b.door, b };
      scatterTrees(x0, y0, 10, 10, 0.22);
    } else if (kind === 'park') {
      fill(x0 + 4, y0, 2, 10, PLAZA);
      fill(x0, y0 + 4, 10, 2, PLAZA);
      const cx = (x0 + 5) * T, cy = (y0 + 5) * T;
      deco.push({ kind: 'fountain', x: cx, y: cy });
      if (!places.park) {
        places.park = { key: 'park', name: 'Park', icon: '🌳', color: '#5a9a45', door: { x: cx, y: cy + 70 }, nomenu: true };
        photoSpots.push({ id: 'park', name: 'Fountain Park', x: cx + 150, y: cy + 150, bonus: 0.8 });
      }
      scatterTrees(x0, y0, 10, 10, 0.32);
      for (const [dx, dy] of [[-2.2, 0], [2.2, 0]]) deco.push({ kind: 'bench', x: cx + dx * T, y: cy + dy * T + T * 0.9 });
    } else if (kind === 'police') {
      fill(x0, y0 + 6, 10, 4, LOT);
      const b = addBuilding({ x: x0 + 1, y: y0 + 1, w: 8, h: 5, wall: '#e8eef5', roof: '#3a4a5c', sign: 'POLICE', awning: '#1f4f8a', kind: 'place', place: 'police' });
      places.police = { key: 'police', name: 'Police Station', icon: '🚓', color: '#2f6fd6', door: b.door, b,
        spots: [0, 1, 2].map(i => ({ x: (x0 + 2 + i * 3) * T, y: (y0 + 8) * T, a: -Math.PI / 2 })) };
    } else if (kind === 'hospital') {
      fill(x0, y0 + 7, 10, 3, PLAZA);
      const b = addBuilding({ x: x0 + 1, y: y0 + 1, w: 8, h: 6, wall: '#f7f7f4', roof: '#9aa4a8', sign: 'HOSPITAL', awning: '#e85d5d', kind: 'place', place: 'hospital' });
      places.hospital = { key: 'hospital', name: 'Hospital', icon: '🏥', color: '#e85d5d', door: b.door, b };
      scatterTrees(x0, y0 + 7, 2, 3, 0.4);
    } else if (kind === 'spray') {
      fill(x0, y0 + 5, 10, 5, LOT);
      const b = addBuilding({ x: x0 + 2, y: y0 + 1, w: 6, h: 4, wall: '#2e2a33', roof: '#4a4452', sign: 'K-SPRAY', awning: '#8a5cc2', kind: 'place', place: 'spray' });
      places.spray = { key: 'spray', name: 'K-Spray', icon: '🎨', color: '#a06be0', door: b.door, b, drive: true };
    } else if (kind === 'guns') {
      fill(x0, y0 + 6, 10, 4, PLAZA);
      const b = addBuilding({ x: x0 + 2, y: y0 + 1, w: 6, h: 5, wall: '#5a5d61', roof: '#2e3033', sign: 'K-ARMS', awning: '#c0262b', kind: 'place', place: 'guns' });
      places.guns = { key: 'guns', name: 'K-Arms', icon: '🔫', color: '#8c8f93', door: b.door, b };
      scatterTrees(x0, y0 + 6, 10, 4, 0.12);
    } else if (kind === 'watches') {
      fill(x0, y0 + 6, 10, 4, PLAZA);
      const b = addBuilding({ x: x0 + 1, y: y0 + 1, w: 8, h: 5, wall: '#1c1b1f', roof: '#2a2830', sign: 'CHRONO ROW', kind: 'place', place: 'watches' });
      places.watches = { key: 'watches', name: 'Chrono Row', icon: '⌚', color: '#d4af37', door: b.door, b };
      for (const px of [0.4, 9.6]) palm(x0 + px, y0 + 6.5, r), palm(x0 + px, y0 + 9.5, r);
      photoSpots.push({ id: 'boutiques', name: 'Boutique Row', x: (x0 + 9.4) * T, y: (y0 + 8) * T, bonus: 1.0 });
    } else if (kind === 'fashion') {
      fill(x0, y0 + 6, 10, 4, PLAZA);
      const b = addBuilding({ x: x0 + 1, y: y0 + 1, w: 8, h: 5, wall: '#eee8dc', roof: '#2a2830', sign: 'MAISON K', kind: 'place', place: 'fashion' });
      places.fashion = { key: 'fashion', name: 'Maison K', icon: '👜', color: '#c9a96e', door: b.door, b };
      for (const px of [0.4, 9.6]) palm(x0 + px, y0 + 6.5, r), palm(x0 + px, y0 + 9.5, r);
    } else if (kind === 'jet') {
      // a private terminal with Kimchi One parked on the apron
      fill(x0, y0, 10, 10, LOT);
      const b = addBuilding({ x: x0 + 6, y: y0 + 1, w: 4, h: 3, wall: '#f3f2ef', roof: '#3a3a3a', sign: 'KIMCHI AIR', kind: 'place', place: 'jet' });
      const plane = { x: (x0 + 3.1) * T, y: (y0 + 5.9) * T, a: -Math.PI / 2 };
      places.jet = { key: 'jet', name: 'Kimchi Air', icon: '✈️', color: '#e9e4d8', door: b.door, b, plane };
      solids.push({ x0: plane.x - 22, x1: plane.x + 22, y0: plane.y - 2.7 * T, y1: plane.y + 2.7 * T });
      photoSpots.push({ id: 'jet', name: 'Private Jet', x: (x0 + 5.6) * T, y: (y0 + 8.4) * T, bonus: 1.5 });
    } else if (kind === 'marina') {
      fill(x0, y0, 10, 10, PLAZA);
      const b = addBuilding({ x: x0 + 1, y: y0 + 1, w: 6, h: 3, wall: '#f4f1ea', roof: '#1d2b4a', sign: 'YACHT CLUB', kind: 'place', place: 'marina' });
      places.marina = { key: 'marina', name: 'Yacht Club', icon: '🛥️', color: '#5aa9ff', door: b.door, b };
      for (const px of [0.5, 3, 5.5, 8, 9.5]) palm(x0 + px, y0 + 9.4, r);
      for (const py of [5, 7]) palm(x0 + 9.4, y0 + py, r);
      photoSpots.push({ id: 'marina', name: 'Marina Sunset', x: (x0 + 4.5) * T, y: (y0 + 9.3) * T, bonus: 1.4 });
    } else if (kind === 'lot') {
      fill(x0, y0, 10, 10, LOT);
      for (let i = 0; i < 5; i++) {
        parkedSpawns.push({ x: (x0 + 1 + i * 2) * T, y: (y0 + 2) * T, a: Math.PI / 2 });
        parkedSpawns.push({ x: (x0 + 1 + i * 2) * T, y: (y0 + 7.5) * T, a: -Math.PI / 2 });
      }
    } else {
      const wall = () => pickR(WALLS), roof = () => pickR(ROOFS);
      const p = r();
      if (p < 0.3) {
        addBuilding({ x: x0 + 1, y: y0 + 1, w: 8, h: 7, wall: wall(), roof: roof() });
      } else if (p < 0.65) {
        addBuilding({ x: x0, y: y0 + 1, w: 4, h: 8, wall: wall(), roof: roof() });
        addBuilding({ x: x0 + 6, y: y0 + 1, w: 4, h: 8, wall: wall(), roof: roof() });
      } else {
        for (const [ox, oy, w, h] of [[0, 0, 4, 3], [6, 0, 4, 3], [0, 5, 4, 4], [6, 5, 4, 4]]) {
          const house = r() < 0.5;
          addBuilding({ x: x0 + ox, y: y0 + oy, w, h, wall: wall(), roof: house ? pickR(['#b5533c', '#7a4f45', '#4f6b8a', '#6b8a4f']) : roof(), house });
        }
      }
      scatterTrees(x0, y0, 10, 10, 0.14);
    }
  }

  // palms on the beach all around the island (just past the edge roads), and a lookout on Ocean Drive
  for (let i = 0; i < BLOCKS; i++) {
    const c = i * P + 8;
    for (const o of [-2.5, 2.5]) {
      palm(N + 0.7, c + o, r); palm(c + o, N + 0.7, r);
      palm(-0.7, c + o, r); palm(c + o, -0.7, r);
    }
  }
  photoSpots.push({ id: 'ocean', name: 'Ocean Drive', x: roadCenter(BLOCKS) + 20, y: (2 * P + 9) * T, bonus: 1.3 });

  // street lamps on every block corner
  for (let by = 0; by < BLOCKS; by++) for (let bx = 0; bx < BLOCKS; bx++)
    for (const [lx, ly] of [[2, 2], [P - 1, 2], [2, P - 1], [P - 1, P - 1]])
      lamps.push({ x: (bx * P + lx + 0.5) * T, y: (by * P + ly + 0.5) * T });

  // hidden kimchi jars to collect
  const used = new Set();
  while (jarSpots.length < 25) {
    const tx = Math.floor(r() * N), ty = Math.floor(r() * N);
    const t = tileAt(tx, ty);
    if ((t === WALK || t === PLAZA || t === GRASS) && !used.has(tx + ',' + ty)) {
      used.add(tx + ',' + ty);
      jarSpots.push({ id: jarSpots.length, x: (tx + 0.5) * T, y: (ty + 0.5) * T });
    }
  }

  finishPlaces();
  for (const b of buildings) if (!b.place) deliveryDoors.push({ b, curb: { x: b.door.x, y: b.door.y, a: b.door.a } });
  addBenchViews();
  buildRoadNet(latticeRoads({ T, P, BLOCKS, pxPerM: PX_PER_M }), {}, { into: roads });
  addAnchorsAndRoutes();
}

// Mission spots the story used to compute itself (spec §5.4, §8): the Red Bandanas' lot on the west side,
// the east lot the stolen Cavallo waits in, and the Street Kings start line west of the first gate.
// The race visits nine junctions; its gates face along the course as the road graph drives it, and are
// as wide as the road plus 4 m.
const RACE = [[4, 3], [6, 3], [6, 6], [3, 6], [0, 6], [0, 3], [0, 0], [3, 0], [4, 2]];
function addAnchorsAndRoutes() {
  const blockCenter = (bx, by) => ({ x: (bx * P + 8) * T, y: (by * P + 8) * T });
  anchors.bandanaYard = { ...blockCenter(0, 2), a: Math.PI / 2, r: 5 * T };   // r: half the 10-tile lot
  anchors.stolenCarLot = { ...blockCenter(4, 3), a: Math.PI / 2 };
  anchors.raceStart = { x: roadCenter(RACE[0][0]) - 220, y: roadCenter(RACE[0][1]) + 32, a: 0 };

  const xs = [], ys = [], at = [];
  let from = anchors.raceStart;
  for (const [i, j] of RACE) {
    const g = { x: roadCenter(i), y: roadCenter(j) };
    const r = roads.route(from.x, from.y, g.x, g.y);
    const n = r ? r.pts.length / 2 : 0;
    for (let k = xs.length ? 1 : 0; k < n; k++) { xs.push(r.pts[2 * k]); ys.push(r.pts[2 * k + 1]); }
    if (!n) { xs.push(g.x); ys.push(g.y); }
    at.push(xs.length - 1);
    from = g;
  }
  const s = new Float32Array(xs.length), pts = new Float32Array(xs.length * 2);
  for (let k = 0; k < xs.length; k++) {
    pts[2 * k] = xs[k]; pts[2 * k + 1] = ys[k];
    if (k) s[k] = s[k - 1] + Math.hypot(xs[k] - xs[k - 1], ys[k] - ys[k - 1]);
  }
  // a gate faces along the course from 20 m before it to 20 m after it, so a corner gate is diagonal
  const pointAt = d => {
    let k = 0;
    while (k < xs.length - 2 && s[k + 1] < d) k++;
    const f = s[k + 1] > s[k] ? Math.min(1, Math.max(0, (d - s[k]) / (s[k + 1] - s[k]))) : 0;
    return [xs[k] + (xs[k + 1] - xs[k]) * f, ys[k] + (ys[k + 1] - ys[k]) * f];
  };
  const reach = 20 * PX_PER_M, w = 2 * T + 4 * PX_PER_M;
  const gates = at.map((k, i) => {
    const [ax, ay] = pointAt(s[k] - reach), [bx, by] = pointAt(i < at.length - 1 ? s[k] + reach : s[k]);
    return { x: xs[k], y: ys[k], a: Math.atan2(by - ay, bx - ax), w };
  });
  routes.street_kings = { id: 'street_kings', name: 'Street Kings', laps: 1, start: anchors.raceStart, gates, pts, s, len: s[s.length - 1] };
}

// Every place gets the spots the game uses around its door (spec §6.5). On the grid they are fixed
// offsets south of the door, which is where the game has always put them.
function finishPlaces() {
  const south = Math.PI / 2;
  for (const pl of Object.values(places)) {
    const d = pl.door;
    d.a = south;
    const step = pl.key === 'hospital' || pl.key === 'police' ? 40 : 30;   // respawns stand a little further out
    pl.foot = { x: d.x, y: d.y + step, a: south };
    pl.curb = { x: d.x, y: d.y, a: south };
    pl.giver = giverSpot(d);
    pl.hangout = { x: d.x + 100, y: d.y + 60 };
    if (pl.drive) pl.bay = { x: d.x, y: d.y + 40, r: 120 };   // the drive-in bay of K-Spray
  }
}

// Where a mission giver stands: the first open walkway, plaza or lot spot beside the door that no
// tree covers, else down and to the left of it.
function giverSpot(d) {
  let best = { x: d.x - 70, y: d.y + 70 };
  for (const [ox, oy] of [[-85, 55], [85, 55], [-110, 25], [110, 25], [0, 115], [-75, 115], [75, 115], [-150, 60], [150, 60]]) {
    const x = d.x + ox, y = d.y + oy, t = tileAtPx(x, y);
    if (t !== WALK && t !== PLAZA && t !== LOT) continue;
    if (trees.some(tr => Math.hypot(tr.x - x, tr.y - y) < 50)) continue;
    best = { x, y };
    break;
  }
  return best;
}

// Six fixed views for screenshots and the perf bench. Each one is a session start: Kimchi on a place's
// foot spot facing away from the door (heading), and the camera in front of him looking back at him and
// the building (yaw, the camera's look direction).
function addBenchViews() {
  for (const [name, key] of [['home', 'home'], ['park', 'park'], ['motors', 'dealer'], ['boutiques', 'watches'], ['marina', 'marina'], ['jet', 'jet']]) {
    const f = places[key].foot;
    benchViews.push({ name, x: f.x, y: f.y, yaw: f.a - Math.PI, heading: f.a, car: false });
  }
}

// ---------- drawing ----------

export function drawGround(ctx, tx0, ty0, tx1, ty1) {
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    const t = tileAt(tx, ty), X = tx * T, Y = ty * T;
    switch (t) {
      case ROAD: ctx.fillStyle = '#3d3a36'; break;
      case WALK: ctx.fillStyle = '#bdb6a8'; break;
      case GRASS: ctx.fillStyle = '#79a356'; break;
      case LOT: ctx.fillStyle = '#55524d'; break;
      case PLAZA: ctx.fillStyle = '#dccfb6'; break;
      case WATER: ctx.fillStyle = '#4fb3cf'; break;
      default: ctx.fillStyle = '#8c857c';
    }
    ctx.fillRect(X, Y, T + 1, T + 1);

    if (t === WALK) {
      ctx.fillStyle = '#aaa395';
      ctx.fillRect(X, Y, T, 2); ctx.fillRect(X, Y, 2, T);
    } else if (t === GRASS) {
      const h = hash(tx, ty);
      ctx.fillStyle = '#6c964b';
      if (h < 0.5) ctx.fillRect(X + h * 90 % 50, Y + h * 130 % 50, 6, 6);
      if (h > 0.3) ctx.fillRect(X + h * 70 % 50 + 6, Y + h * 50 % 46 + 10, 4, 4);
    } else if (t === PLAZA) {
      ctx.fillStyle = '#cfc1a6';
      ctx.fillRect(X, Y + T / 2, T, 2); ctx.fillRect(X + ((ty & 1) ? T / 2 : 0), Y, 2, T);
    } else if (t === LOT) {
      if (tx & 1) { ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.fillRect(X - 1, Y + 8, 3, T - 16); }
    } else if (t === ROAD) {
      const mx = tx % P, my = ty % P;
      const hRoad = my < 2 && mx >= 2, vRoad = mx < 2 && my >= 2;
      ctx.fillStyle = '#e8c547';
      if (hRoad && my === 0) ctx.fillRect(X + 10, Y + T - 2, T * 0.45, 4);
      if (vRoad && mx === 0) ctx.fillRect(X + T - 2, Y + 10, 4, T * 0.45);
      ctx.fillStyle = 'rgba(240,236,226,.8)';
      if (hRoad && (mx === 2 || mx === P - 1)) for (let i = 0; i < 4; i++) ctx.fillRect(X + 12, Y + 4 + i * 16, T - 24, 8);
      if (vRoad && (my === 2 || my === P - 1)) for (let i = 0; i < 4; i++) ctx.fillRect(X + 4 + i * 16, Y + 12, 8, T - 24);
    }
  }
}

export function drawBuilding(ctx, b, night) {
  const x = b.x * T, y = b.y * T, w = b.w * T, h = b.h * T;
  const wh = Math.min(T * 0.85, h * 0.32);
  const rh = h - wh;

  ctx.fillStyle = 'rgba(0,0,0,.22)';
  ctx.fillRect(x + 10, y + 12, w, h);

  // front wall
  ctx.fillStyle = b.wall;
  ctx.fillRect(x, y + rh, w, wh);
  ctx.fillStyle = 'rgba(0,0,0,.14)';
  ctx.fillRect(x, y + rh, w, 5);
  const n = Math.max(1, Math.floor(w / 46));
  for (let i = 0; i < n; i++) {
    const wx = x + (i + 0.5) * (w / n) - 10;
    if (Math.abs(wx + 10 - b.door.x) < 26) continue;
    const lit = night > 0.2 && hash(b.id * 7, i) < 0.7;
    ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(wx - 2, y + rh + 12, 24, 26);
    ctx.fillStyle = lit ? '#ffd77a' : '#86a9bf'; ctx.fillRect(wx, y + rh + 14, 20, 22);
    ctx.fillStyle = 'rgba(255,255,255,.3)'; ctx.fillRect(wx + 2, y + rh + 16, 5, 18);
  }
  ctx.fillStyle = '#4a3428';
  ctx.fillRect(b.door.x - 13, y + h - 36, 26, 36);
  ctx.fillStyle = '#e8c547';
  ctx.fillRect(b.door.x + 6, y + h - 20, 3, 3);

  if (b.awning) {
    for (let i = 0, k = 0; i < w; i += 16, k++) {
      ctx.fillStyle = k % 2 ? b.awning : '#fbf7ef';
      ctx.fillRect(x + i, y + rh, Math.min(16, w - i), 13);
    }
  }

  // roof
  if (b.house) {
    ctx.fillStyle = b.roof;
    ctx.fillRect(x - 5, y - 5, w + 10, rh + 8);
    ctx.fillStyle = 'rgba(255,255,255,.14)';
    ctx.fillRect(x - 5, y - 5, w + 10, (rh + 8) / 2);
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    ctx.fillRect(x - 5, y - 5 + (rh + 8) / 2 - 2, w + 10, 3);
    ctx.fillRect(x - 5, y + rh, w + 10, 3);
  } else {
    ctx.fillStyle = b.roof;
    ctx.fillRect(x, y, w, rh);
    ctx.fillStyle = 'rgba(255,255,255,.07)';
    ctx.fillRect(x + 7, y + 7, w - 14, rh - 14);
    ctx.strokeStyle = 'rgba(0,0,0,.28)'; ctx.lineWidth = 4;
    ctx.strokeRect(x + 2, y + 2, w - 4, rh - 4);
    if (!b.sign) {
      for (let i = 0; i < 3; i++) {
        const hx = hash(b.id, i + 10), hy = hash(i + 3, b.id);
        if (hx < 0.25) continue;
        const ax = x + 16 + hx * (w - 60), ay = y + 14 + hy * Math.max(1, rh - 54);
        ctx.fillStyle = 'rgba(0,0,0,.2)'; ctx.fillRect(ax + 4, ay + 4, 28, 22);
        ctx.fillStyle = '#9aa0a3'; ctx.fillRect(ax, ay, 28, 22);
        ctx.fillStyle = '#7d8386'; circle(ctx, ax + 14, ay + 11, 7);
      }
    }
  }

  if (b.sign) {
    ctx.font = '900 24px ui-rounded, system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const tw = ctx.measureText(b.sign).width + 28;
    const sx = x + w / 2, sy = y + rh / 2;
    ctx.fillStyle = 'rgba(0,0,0,.3)'; roundRect(ctx, sx - tw / 2 + 3, sy - 19, tw, 40, 10); ctx.fill();
    ctx.fillStyle = '#1b1512'; roundRect(ctx, sx - tw / 2, sy - 22, tw, 40, 10); ctx.fill();
    ctx.fillStyle = '#f6ead8'; ctx.fillText(b.sign, sx, sy - 1);
  }
}

export function drawTree(ctx, t) {
  ctx.fillStyle = 'rgba(0,0,0,.2)'; ellipse(ctx, t.x + 7, t.y + 9, t.r, t.r * 0.75);
  ctx.fillStyle = '#3f6b34'; circle(ctx, t.x, t.y, t.r);
  ctx.fillStyle = '#548a43'; circle(ctx, t.x - t.r * 0.22, t.y - t.r * 0.28, t.r * 0.68);
  ctx.fillStyle = 'rgba(255,255,255,.1)'; circle(ctx, t.x - t.r * 0.35, t.y - t.r * 0.45, t.r * 0.3);
}

export function drawLamp(ctx, l) {
  ctx.fillStyle = 'rgba(0,0,0,.25)'; circle(ctx, l.x + 3, l.y + 3, 6);
  ctx.fillStyle = '#2a2622'; circle(ctx, l.x, l.y, 6);
  ctx.fillStyle = '#f3e7b8'; circle(ctx, l.x, l.y, 3.5);
}

export function drawDeco(ctx, d, t) {
  if (d.kind === 'fountain') {
    ctx.fillStyle = 'rgba(0,0,0,.2)'; circle(ctx, d.x + 5, d.y + 6, 58);
    ctx.fillStyle = '#b9b0a0'; circle(ctx, d.x, d.y, 58);
    ctx.fillStyle = '#5aa6c8'; circle(ctx, d.x, d.y, 48);
    ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 2;
    for (let i = 0; i < 2; i++) {
      const rr = ((t * 22 + i * 22) % 44) + 6;
      ctx.beginPath(); ctx.arc(d.x, d.y, rr, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = '#b9b0a0'; circle(ctx, d.x, d.y, 12);
    ctx.fillStyle = '#d7eef7'; circle(ctx, d.x, d.y, 6);
  } else if (d.kind === 'bench') {
    ctx.fillStyle = 'rgba(0,0,0,.2)'; ctx.fillRect(d.x - 30, d.y - 4, 64, 18);
    ctx.fillStyle = '#7a5134'; ctx.fillRect(d.x - 32, d.y - 8, 64, 8); ctx.fillRect(d.x - 32, d.y + 2, 64, 8);
  } else if (d.kind === 'lounger') {
    ctx.fillStyle = '#f4f1ea'; ctx.fillRect(d.x - 10, d.y - 24, 20, 44);
  } else if (d.kind === 'umbrella') {
    ctx.fillStyle = '#f4f1ea'; circle(ctx, d.x, d.y, 30);
  }
}

export function makeMinimap(s = 2) {
  const c = document.createElement('canvas');
  c.width = c.height = N * s;
  const x = c.getContext('2d');
  const col = { [ROAD]: '#4a4744', [WALK]: '#a49d90', [GRASS]: '#6f9a4f', [LOT]: '#5f5c57', [PLAZA]: '#cfc3ab', [BUILD]: '#8d8478', [WATER]: '#4fb3cf' };
  for (let ty = 0; ty < N; ty++) for (let tx = 0; tx < N; tx++) {
    x.fillStyle = col[tileAt(tx, ty)];
    x.fillRect(tx * s, ty * s, s, s);
  }
  for (const b of buildings) {
    x.fillStyle = b.place ? (places[b.place]?.color || '#c94') : '#7a7268';
    x.fillRect(b.x * s, b.y * s, b.w * s, b.h * s);
  }
  return c;
}

// The map picture behind the minimap and the big map: 4 canvas px per tile, so k = 4/64 canvas px
// per sim px, with the canvas origin at sim (0,0). Built once the city exists, then reused.
let mapImg = null;
export function mapImage() {
  if (mapImg) return mapImg;
  const img = { canvas: makeMinimap(4), k: 4 / T, x0: 0, y0: 0 };
  if (generated) mapImg = img;
  return img;
}
