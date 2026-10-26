// The Kimchi Key v2 buildings in 3D (docs/map-v2-spec.md §6.4 and §11.1 Buildings).
//
// Every building is drawn in two halves, from one piece of code run twice:
//  - its shell: the walls on its region's painted facade atlas (or, for the towers and the Heights' glass villas,
//    the curtain walls the shader draws), the roof (flat gravel, barrel tiles or a hangar's arc), a tower's
//    podium, crown and LED band, a resort's balcony bands, the pools and sun decks on decks and roofs, and the
//    masses of the special buildings (the villa, the glass villas, the luxury fronts). Shells are merged per
//    256 m tile, one draw call each, and are always resident: the county's skyline never pops.
//  - its detail: eyebrows, cornices, parapets, fins and pylons, shop fronts with their awnings and signs, doors,
//    balconies, blade and neon signs, lanterns, rooftop plant, the places' glass, gold and painted signs. Detail
//    is built per 128 m cell through the chunk manager's lazy cells (within 220 m), in slices that yield to the
//    queue, and dropped again by its cache.
// A pass (makePass) hands the building code real builders for its half and a SINK for the other, so the two
// halves always line up. Everything is drawn with one material from texture stacks (see 'layers'), so a tile's
// shell or a cell's detail is a single mesh. Each building is built in its own local frame (Builder.setMatrix): centred on its
// footprint, x across the front (left to right as you face it), z out of the front, y up from its pad. The
// grid's builders (decoDetails, villa, luxShop, door, gableRoof, hipRoof, flowerBoxes) are moved here from
// src/3d/cityGrid.js as they are: on the grid every front faces south, which is this frame turned to π/2.
// Facade texture coordinates are worked out in that frame, so the windows line up the same at any heading, and
// every wall holds a whole number of 3 m bays, so no window is cut at a corner.
//
// registerBuildings(world, chunks, mats?): world is the world facade's namespace (buildings, places, hash);
// chunks is the city's chunk manager; mats (optional) is cityV2's shared material set, whose night() then
// drives the lit windows. Without it the buildings follow the sun light themselves (see tick).
import * as THREE from 'three';
import { Builder, mat4 } from './geo.js';
import { matte, LOW, MODE } from './quality.js';
import { keyBox, CELL } from './chunks.js';
import * as TX from './textures.js';

const S = 1 / 16;          // metres per sim px: the moved grid code reads a door's x as b.door.x * S
const BASE = 0.16;         // a building's floor above its pad: groundY's curb on BUILD cells, as on the grid
const UNDER = 1.6;         // m of plain wall below the floor, so a dip of the coarse terrain never shows a gap
// px of a colour layer (a facade atlas is 24 m of wall; the pictures are scaled on load): 1024 when High is
// chosen, 768 on Auto (an 8 GB Mac: the three stacks then take about 56 MB of GPU memory instead of 99) and
// 512 on phones (25 MB)
const FACADE_PX = LOW ? 512 : MODE === 'high' ? 1024 : 768;
const SLICE_MS = 0.5;      // a detail cell yields to the chunk manager's queue after this long (its slice is 3 ms)
const SPAWN_R = 220;       // m of detail built at once round the villa, so the first frame is whole

// geo.js's col, with each colour parsed once (the moved code asks for one per box; parsing is most of a box's
// cost). Callers may change what they get (a roof's lerp), so each call gets its own copy.
const PARSED = new Map();
function col(hex) {
  let c = PARSED.get(hex);
  if (!c) PARSED.set(hex, (c = new THREE.Color(hex)));
  return c.clone();
}
const WHITE = col('#ffffff');
// the grid's South Beach palette (cityGrid.js): pastel stucco, trim accents, the hotel pylons' neon names
const MIAMI = ['#f3c1ab', '#a9dcc7', '#f4d98a', '#c8bbe6', '#b2d3ee', '#f6f1e6', '#f1b2c3', '#9fd8cf', '#efc79a', '#fbe6c4', '#f6a9a0', '#bfe3a8'];
const ACCENT = ['#2aa39d', '#e5678a', '#f0a057', '#4f8fd8', '#7bbf9a', '#c98bd8', '#f4f2ec'];
const NEON = [['KIMCHI', '#ff4fa3'], ['MOCHI', '#4fe3ff'], ['HALMONI', '#ffd24f'], ['CORAL', '#ff7a5a'],
  ['TIDES', '#7affc8'], ['SEOUL', '#c77dff'], ['BAO', '#ff5252'], ['FLAMINGO', '#ff6fb5']];
const AWNING_COLORS = ['#d6402b', '#3d9a6a', '#3b7dd8', '#e3a13a', '#8a5cc2', '#1b1512'];
// every awning colour a building can ask for (the grid's, the region styles' in src/map/lots.js, the places'):
// one row each in the stripe atlas
const AWNINGS = [...AWNING_COLORS, '#e8622c', '#2f6fd6', '#ff8fb1', '#7fd1c7', '#ffd166', '#9ab8ff', '#4a4a52', '#f6f4ee',
  '#1f4f8a', '#e85d5d', '#c0262b'];
const LED = col('#fff1d6'), LANTERN = col('#d6402b'), AVIATION = col('#ff3a2a'), FANLIGHT = col('#2c3940'), IRON = col('#26221f');

// The S5c facade atlases (assets/tex/facade_<style>.jpg; 'deco' is today's facade.jpg), and the storey an
// atlas row stands for in each region style. The places keep the grid's deco facade, so they look as they do
// on the grid; the Gables (and Star Island) take the house layer, painted since wave P3 with the Mediterranean
// facade (PICTURE), the Port and the Fest's hangars the warehouse. The towers' layer has no picture since P3:
// their curtain walls are drawn by the shader (SHADER_LAYERS).
const FACADES = ['deco', 'ktown', 'tower', 'resort', 'house', 'warehouse'];
// the picture each takes, where it is not facade_<style>: the Gables (and Star Island) the Mediterranean Revival
// facade painted in wave P3 (tall arched windows, iron balconettes, a spindle reja, striped awnings)
const PICTURE = { deco: 'facade', house: 'facade_mansion' };
const STOREY = { deco: 3.3, ktown: 3.2, tower: 3.4, resort: 3.2, house: 3.0, mansion: 3.2, warehouse: 3.2, hangar: 3.2 };
// Shop fronts per region, as cells of the shops2 atlas (SHOP_SIGNS' 12 K-Town shops, then SHOPS2's beach ones)
const SHOPS_OF = {
  ktown: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  deco: [12, 13, 14, 15, 16, 17, 3, 4, 7, 10],
  tower: [3, 4, 6, 7, 8, 9, 15, 16, 17],
  resort: [12, 13, 14, 15],
};
const INTERIORS = ['mart', 'auto', 'villa', 'watch', 'boutique', 'lobby'];   // rows of the interior atlas
// the hotels' names on Collins Avenue, painted like the places' signs
const HOTELS = [
  ['THE TIDES', { bg: '#0f2230', fg: '#7affc8', size: 84 }], ['FLAMINGO', { bg: '#1b1020', fg: '#ff6fb5', size: 88 }],
  ['CORAL REEF', { bg: '#102030', fg: '#ff7a5a', size: 80 }], ['SEOUL BEACH', { bg: '#141428', fg: '#c77dff', size: 76 }],
  ['THE MOCHI', { bg: '#f7f5ef', fg: '#2aa39d', serif: true, size: 84 }], ['HALMONI', { bg: '#12202a', fg: '#ffd24f', size: 88 }],
  ['KIMCHI BAY', { bg: '#f4f1ea', fg: '#e5678a', serif: true, size: 80 }], ['AQUA K', { bg: '#0d2a35', fg: '#4fe3ff', size: 90 }],
];
// Each resort's name, by building id: dealt in turn along Collins (north to south, then west to east), so the
// same name comes back only 8 hotels on and two neighbours never share one (set by registerBuildings).
const hotelOf = new Map();
function nameHotels(list) {
  hotelOf.clear();
  list.filter((b) => b.style === 'resort' && !b.place).sort((a, b) => a.cz - b.cz || a.cx - b.cx)
    .forEach((b, i) => hotelOf.set(b.id, i % HOTELS.length));
}

let hash = (x, y) => 0;   // the world's hash, set by registerBuildings

// ---------- layers ----------

// Every building is drawn with one material from three texture stacks (textures.js layerStack): the colour
// stack's layers are the region facades, the roof gravel, the barrel tiles, the awning stripes, the shop fronts,
// the shop signs, K-Town's signs, the painted sign sheet, the hotel neon and the shop interiors; the facades
// also have night-glow and roughness layers, the shops and interiors glow layers. A few layers have no picture
// (plain vertex colour, gold, and the glow of lanterns and LED strips). Each vertex says its layer.
// Layers 18-23 have no picture either: the shader draws them. 'tower' and 18-21 are curtain walls (glass in a
// mullion grid that mirrors the sky, with lit floors at night; see the material), 'pool' is pool water and 'beacon'
// a tower's LED crown, which glows only at night.
const L = { deco: 0, ktown: 1, tower: 2, resort: 3, house: 4, warehouse: 5, gravel: 6, tiles: 7, stripes: 8,
  shops: 9, signs: 10, ksigns: 11, sheet: 12, neon: 13, inside: 14, plain: 15, glow: 16, gold: 17,
  banded: 18, framed: 19, bronze: 20, villaGlass: 21, pool: 22, beacon: 23 };
const NL = 24;
const COLOR_LAYERS = 15, LIT_OF = { 9: 6, 14: 7 }, LIT_LAYERS = 8, ROUGH_LAYERS = 6;
// per layer: day and night glow, and where it comes from (0 none, 1 the glow layer in the windows' warm light,
// 2 the glow layer, 3 the picture itself, 4 the vertex colour); then roughness and metalness
const EMIT = {
  [L.shops]: [0.05, 0.55, 2], [L.signs]: [0.12, 0.95, 3], [L.ksigns]: [0.22, 1.5, 3], [L.sheet]: [0.2, 1.1, 3],
  [L.neon]: [0.55, 3.2, 3], [L.inside]: [0.06, 0.95, 2], [L.glow]: [0.4, 2.2, 4], [L.beacon]: [0, 2.6, 4],
};
for (let i = 0; i < 6; i++) EMIT[i] = [0, 1.15, 1];
const SURF = { [L.gravel]: [0.95, 0], [L.tiles]: [0.8, 0], [L.stripes]: [0.9, 0], [L.shops]: [0.5, 0], [L.signs]: [0.6, 0],
  [L.ksigns]: [0.6, 0], [L.sheet]: [0.6, 0], [L.neon]: [0.5, 0], [L.inside]: [0.75, 0], [L.plain]: [0.9, 0], [L.glow]: [0.6, 0], [L.gold]: [0.28, 1],
  [L.beacon]: [0.5, 0] };
for (let i = 0; i < 6; i++) SURF[i] = [1, 0];
const DECALS = [L.shops, L.signs, L.ksigns, L.sheet, L.neon, L.inside, L.glow];   // drawn a hair in front of the wall they sit on

// ---------- passes ----------

// What a pass does not keep: every builder call lands here and is dropped.
class Sink {
  quad() {} tri() {} box() {} geo() {} ribbon() {}
  setMatrix() { return this; }
  get empty() { return true; }
}
const SINK = new Sink();
// which layer each part of a building is drawn on, and which pass keeps it
// (pools: pool water seen from the air; beacons: towers' LED crowns, which read across the bay at night; panes: a
// glass villa's walls; poolWalls: a pool's sides, seen only close by)
const SHELL_PARTS = { roofs: L.gravel, houseRoofs: L.tiles, mass: L.plain, pools: L.pool, beacons: L.beacon, panes: L.villaGlass };
const DETAIL_PARTS = { trim: L.plain, neon: L.neon, shops: L.shops, signs: L.signs, ksigns: L.ksigns, psigns: L.sheet, glass: L.inside,
  glow: L.glow, gold: L.gold, awnings: L.stripes, poolWalls: L.pool };
const TWO_SIDED = new Set(['houseRoofs', 'awnings']);   // seen from below too (the grid gave them DoubleSide)

// The builder one pass writes: kind 'shell' (walls, roofs, masses), 'detail' (the rest) or 'collect' (nothing;
// it only lists the painted signs the buildings ask for, before the sign sheet is painted). Everything goes into
// one Builder, placed by the current building's frame (at()); runs records the layer of each run of vertices.
const spare = [];   // detail builders between cells (clear() keeps their storage, so a cell rarely grows one)
function makePass(kind) {
  const B = (kind === 'detail' && spare.pop()) || new Builder(), runs = [];
  B.clear();
  let cur = -1;
  const use = (layer) => { if (layer !== cur) { runs.push(B.vertexCount, layer); cur = layer; } return B; };
  const view = (layer, two) => ({
    quad(a, b, c, d, uvs, color) {
      use(layer).quad(a, b, c, d, uvs, color);
      if (two) B.quad(d, c, b, a, uvs && [uvs[3], uvs[2], uvs[1], uvs[0]], color);
    },
    tri(a, b, c, uvs, color) {
      use(layer).tri(a, b, c, uvs, color);
      if (two) B.tri(c, b, a, uvs && [uvs[2], uvs[1], uvs[0]], color);
    },
    box: (...args) => use(layer).box(...args),
    geo: (g, m, color) => use(layer).geo(g, m, color),
    get empty() { return B.empty; },
  });
  const views = new Map(), keep = kind === 'shell' ? SHELL_PARTS : kind === 'detail' ? DETAIL_PARTS : {};
  const viewOf = (k, layer) => { if (!views.has(k)) views.set(k, view(layer, TWO_SIDED.has(k))); return views.get(k); };
  const P = {
    kind, B, runs, wanted: kind === 'collect' ? new Map() : null,
    wall: (style) => (kind === 'shell' ? viewOf('wall ' + style, L[style]) : SINK),
    curtain: (layer) => (kind === 'shell' ? viewOf('curtain ' + layer, layer) : SINK),
    at(m) { B.setMatrix(m); },
  };
  for (const k of [...Object.keys(SHELL_PARTS), ...Object.keys(DETAIL_PARTS)])
    Object.defineProperty(P, k, { get: () => (k in keep ? viewOf(k, keep[k]) : SINK) });
  return P;
}

// A view of an atlas part that puts a quad's v (0..1) into one row of the atlas (a little in from its edges,
// so the next row does not bleed in on the smaller mips).
function rowOf(B, row, rows) {
  if (B === SINK) return SINK;
  const v0 = 1 - (row + 1) / rows, k = 1 / rows;
  return { quad: (a, b, c, d, uvs, color) => B.quad(a, b, c, d, uvs.map(([u, v]) => [u, v0 + k * (0.02 + 0.96 * v)]), color), get empty() { return B.empty; } };
}
// a part whose boxes all take one colour (the LED strips, which the grid drew in their own material)
function tinted(B, color) {
  if (B === SINK) return SINK;
  return { box: (x0, y0, z0, x1, y1, z1, c, o) => B.box(x0, y0, z0, x1, y1, z1, color, o), get empty() { return B.empty; } };
}
const glassRow = (P, kind) => rowOf(P.glass, INTERIORS.indexOf(kind), INTERIORS.length);
function awningRow(P, color) {
  let i = AWNINGS.indexOf(String(color).toLowerCase());
  if (i < 0) i = AWNINGS.length - 1;
  return rowOf(P.awnings, i, AWNINGS.length);
}
// the grid's `lux` builders, over this pass
const luxOf = (P) => ({ gold: P.gold, villa: glassRow(P, 'villa'), watch: glassRow(P, 'watch'), shop: glassRow(P, 'boutique'), leds: tinted(P.glow, LED) });

// shared shapes (the grid made one per use)
const SHAPES = {};
const shape = (k, make) => (SHAPES[k] ||= make());
const lanternGeo = () => shape('lantern', () => new THREE.SphereGeometry(0.32, 8, 6));
const mastGeo = () => shape('mast', () => new THREE.CylinderGeometry(0.06, 0.06, 1.6, 6));
const tankGeo = () => shape('tank', () => new THREE.CylinderGeometry(1.1, 1.1, 2.2, 10));
const flowerGeo = () => shape('flower', () => new THREE.IcosahedronGeometry(0.13, 0));
const ventGeo = () => shape('vent', () => new THREE.CylinderGeometry(0.45, 0.45, 1, 8));
const umbrellaGeo = () => shape('umbrella', () => new THREE.ConeGeometry(1.4, 0.45, 8).translate(0, 0.22, 0));
const tankLyingGeo = () => shape('tankLying', () => new THREE.CylinderGeometry(0.6, 0.6, 2.2, 10).rotateZ(Math.PI / 2));
const dishGeo = () => shape('dish', () => new THREE.SphereGeometry(0.5, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2.6).rotateX(-1.1));

// ---------- a building's frame ----------

// The matrix from a building's local frame to the world, its footprint in that frame, and the record the moved
// grid code reads (id, place, house, and the door's x as px, as the grid kept it).
function frameOf(b) {
  const a = b.a ?? Math.PI / 2;
  const m = new THREE.Matrix4().makeRotationY(Math.PI / 2 - a).setPosition(b.cx, b.base ?? 0, b.cz);
  // half the Heights' glass mansions are the villa's plan mirrored (they carry no sign to read backwards)
  if (b.style === 'mansion' && !b.house && !b.place && hash(b.id, 35) < 0.5) m.multiply(new THREE.Matrix4().makeScale(-1, 1, 1));
  const dx = (b.door ? b.door.x * S : b.cx) - b.cx, dz = (b.door ? b.door.y * S : b.cz) - b.cz;
  const doorX = dx * Math.sin(a) - dz * Math.cos(a);
  return { m, x0: -b.w / 2, z0: -b.d / 2, x1: b.w / 2, z1: b.d / 2, doorX,
    lb: { id: b.id, place: b.place, house: b.house, door: { x: doorX / S } } };
}

const q8 = (u) => Math.floor(u * 8) / 8;
// each wall starts at its own bay of the atlas, and the building at its own row, so neighbours differ
const uOffsOf = (b) => [0, 1, 2, 3].map(i => q8(hash(b.id, 5 + i * 11)));
const vOffOf = (b) => q8(hash(b.id, 6));
// the storey a facade row stands for: the style's own, rounded so a whole number of rows fills the wall
const storeyFor = (h, nominal) => h / Math.max(1, Math.round(h / nominal));

// Four walls (or those in the faces mask) from y0 to y1 on a facade atlas (8 x 8 cells, a 3 m bay of one storey each): every wall holds a
// whole number of bays (stretched by at most a sixth), starting at bay uOffs[i] of the atlas, and each atlas
// row is one storey, from vBase. Below the floor the walls run on `sink` m (UNDER) as plain wall (the cell's
// floor line stretched down), so where the coarse terrain dips at a corner no window shows underground.
function facadeWalls(B, x0, y0, z0, x1, y1, z1, color, { storey = 3.2, uOffs = [0, 0, 0, 0], vOff = 0, vBase = y0, sink = UNDER, faces = 15 } = {}) {
  if (B === SINK) return;
  const vs = storey * 8, vb = vOff + (y0 - vBase) / vs, vt = vOff + (y1 - vBase) / vs;
  const face = (ax, az, bx, bz, len, i) => {
    if (!(faces & (1 << i))) return;  // faces: a mask of the walls drawn (1 front, 2 back, 4 right, 8 left)
    const u0 = uOffs[i], u1 = u0 + baysOf(len) / 8;
    B.quad([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az], [[u0, vb], [u1, vb], [u1, vt], [u0, vt]], color);
    if (sink > 0) B.quad([ax, y0 - sink, az], [bx, y0 - sink, bz], [bx, y0, bz], [ax, y0, az], [[u0, vb], [u1, vb], [u1, vb], [u0, vb]], color);
  };
  face(x0, z1, x1, z1, x1 - x0, 0);   // front
  face(x1, z0, x0, z0, x1 - x0, 1);   // back
  face(x1, z1, x1, z0, z1 - z0, 2);   // right side
  face(x0, z0, x0, z1, z1 - z0, 3);   // left side
}

// The whole 3 m bays a wall of len m holds: the nearest count, or one more where that would stretch a bay past
// 3.6 m and one more still keeps it 2.4 m or wider (a 7.4 m wall: 3 bays of 2.47 m, not 2 of 3.7 m).
function baysOf(len) {
  const n = Math.max(1, Math.round(len / 3));
  return len / n > 3.6 && len / (n + 1) >= 2.4 ? n + 1 : n;
}

// a flat roof: the top face only, gravel at 8 m a repeat (the grid's roofs.box)
function flatRoof(roofs, x0, z0, x1, z1, y, color) {
  roofs.box(x0, y - 0.01, z0, x1, y, z1, color, { px: false, nx: false, pz: false, nz: false, uv: 'world', us: 8 });
}

// a parapet round a flat roof; returns its top
function parapet(trim, x0, z0, x1, z1, y1, pc, t = 0.25, ph = 0.55) {
  trim.box(x0, y1, z0, x1, y1 + ph, z0 + t, pc);
  trim.box(x0, y1, z1 - t, x1, y1 + ph, z1, pc);
  trim.box(x0, y1, z0 + t, x0 + t, y1 + ph, z1 - t, pc);
  trim.box(x1 - t, y1, z0 + t, x1, y1 + ph, z1 - t, pc);
  return y1 + ph;
}

// pilasters standing proud at the four corners (they also hide where two walls' atlas bays meet)
function corners(trim, x0, z0, x1, z1, ya, yb, c, s = 0.5, out = 0.08) {
  for (const [x, z] of [[x0 - out, z0 - out], [x1 + out - s, z0 - out], [x0 - out, z1 + out - s], [x1 + out - s, z1 + out - s]])
    trim.box(x, ya, z, x + s, yb, z + s, c);
}

// rooftop plant: the grid's air conditioners and, on taller ones, a timber water tank
function rooftop(trim, b, x0, z0, x1, z1, y1, h) {
  for (let i = 0; i < 3; i++) {
    if (hash(b.id, i + 40) < 0.3) continue;
    const ax = x0 + 1.5 + hash(b.id, i + 50) * (x1 - x0 - 4), az = z0 + 1.5 + hash(i + 60, b.id) * (z1 - z0 - 4);
    trim.box(ax, y1, az, ax + 1.6, y1 + 1.1, az + 1.2, col('#9aa0a3'));
    trim.box(ax + 0.2, y1 + 1.1, az + 0.2, ax + 1.4, y1 + 1.2, az + 1.0, col('#7d8386'));
  }
  if (hash(b.id, 70) < 0.25 && h > 12) {
    const wx = x0 + 3, wz = z0 + 3;
    trim.geo(tankGeo(), mat4(wx, y1 + 2.4, wz), col('#7a5a44'));
    for (const [dx, dz] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]]) trim.box(wx + dx - 0.08, y1, wz + dz - 0.08, wx + dx + 0.08, y1 + 1.3, wz + dz + 0.08, col('#555'));
  }
}

// ---------- signs from the painted sheet ----------

// The cell of the sign sheet a painted sign (textSign's text and options) sits in. A collect pass lists it;
// the other passes look it up (a sign nobody listed is left out).
const signKey = (text, opts) => text + '\u0000' + JSON.stringify(opts);
let sheetRects = null, sheetIndex = null;
function signRect(P, text, opts) {
  const k = signKey(text, opts);
  if (P.kind === 'collect') { if (!P.wanted.has(k)) P.wanted.set(k, { text, opts }); return null; }
  if (P.kind !== 'detail' || !sheetIndex) return null;
  const i = sheetIndex.get(k);
  if (i === undefined) { stats.signMisses++; return null; }
  return sheetRects[i];
}

// The grid's addSign: a painted sign facing the front, centred at (cx, cy, z), w x h m, tipped back by tilt.
function addSign(P, text, opts, cx, cy, z, w, h, tilt = 0) {
  const r = signRect(P, text, opts);
  if (!r) return;
  const c = Math.cos(tilt), s = Math.sin(tilt), hw = w / 2, hh = h / 2;
  const at = (x, y) => [cx + x, cy + y * c, z + y * s];      // the plane turned about x, as mesh.rotation.x
  P.psigns.quad(at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh), [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]]);
}

// The grid's roofLabel: the place's name lying on its roof, reading from the front.
function roofLabel(P, text, bg, x0, z0, x1, z1, y) {
  const r = signRect(P, text, { bg, fg: '#ffffff', size: 82 });
  if (!r) return;
  const w = Math.min((x1 - x0) * 0.8, 20), h = w / 4, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, yy = y + 0.06;
  P.psigns.quad([cx - w / 2, yy, cz + h / 2], [cx + w / 2, yy, cz + h / 2], [cx + w / 2, yy, cz - h / 2], [cx - w / 2, yy, cz - h / 2],
    [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]]);
}

// A helipad lying on a roof: a dark square with the yellow H in its ring, from the sign sheet, s m a side.
function helipad(P, cx, cz, y, s) {
  const r = signRect(P, 'H', HELIPAD);
  if (!r) return;
  const yy = y + 0.07, h = s / 2;
  P.psigns.quad([cx - h, yy, cz + h], [cx + h, yy, cz + h], [cx + h, yy, cz - h], [cx - h, yy, cz - h], [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]]);
}
const HELIPAD = { bg: '#30353a', fg: '#ffd84a', border: '#ffd84a', w: 256, h: 256, size: 190 };

// ---------- moved from cityGrid.js ----------

// The Art Deco dressing for an ordinary building: eyebrow ledges over every window row (they cast those
// long stripes of shadow), a coloured cornice, a stepped parapet with a raised centre, corner fins, and on
// taller ones a pylon with a vertical neon name. Returns the highest point.
// (Moved from cityGrid.js; st, the storey, was the grid's fixed 3.2 m.)
function decoDetails(trim, neon, b, x0, z0, x1, z1, y0, y1, wcol, shops, st = 3.2) {
  const acc = col(ACCENT[Math.floor(hash(b.id, 8) * ACCENT.length)]);
  const white = col('#f7f5ef');
  const eb = hash(b.id, 9) < 0.6 ? white : acc;
  const floors = Math.round((y1 - y0) / st), d = 0.42, th = 0.09;
  for (let k = shops ? 1 : 0; k < floors; k++) {
    const y = y0 + st * (k + 1) - 0.5;
    trim.box(x0 - d, y, z1, x1 + d, y + th, z1 + d, eb, { bottom: true });
    trim.box(x0 - d, y, z0 - d, x1 + d, y + th, z0, eb, { bottom: true });
    trim.box(x0 - d, y, z0, x0, y + th, z1, eb, { bottom: true });
    trim.box(x1, y, z0, x1 + d, y + th, z1, eb, { bottom: true });
  }
  // a plinth in the trim colour where there are no shops
  if (!shops) trim.box(x0 - 0.05, y0, z0 - 0.05, x1 + 0.05, y0 + 0.5, z1 + 0.05, acc.clone().multiplyScalar(0.85), { top: false });
  // cornice band and parapet
  trim.box(x0 - 0.1, y1 - 0.4, z0 - 0.1, x1 + 0.1, y1, z1 + 0.1, acc, { top: false, bottom: true });
  const pc = wcol.clone().multiplyScalar(0.96), t = 0.28, ph = 0.85;
  trim.box(x0, y1, z0, x1, y1 + ph, z0 + t, pc);
  trim.box(x0, y1, z1 - t, x1, y1 + ph, z1, pc);
  trim.box(x0, y1, z0 + t, x0 + t, y1 + ph, z1 - t, pc);
  trim.box(x1 - t, y1, z0 + t, x1, y1 + ph, z1 - t, pc);
  const cx = (x0 + x1) / 2, w = x1 - x0;
  // stepped centre of the front parapet
  trim.box(cx - w * 0.26, y1 + ph, z1 - t, cx + w * 0.26, y1 + ph + 0.7, z1, pc);
  trim.box(cx - w * 0.14, y1 + ph + 0.7, z1 - t, cx + w * 0.14, y1 + ph + 1.4, z1, pc);
  trim.box(cx - w * 0.14 - 0.05, y1 + ph + 1.4, z1 - t - 0.05, cx + w * 0.14 + 0.05, y1 + ph + 1.55, z1 + 0.05, acc);
  let top = y1 + ph + 1.55;
  // fins at the front corners
  const fy0 = shops ? y0 + 3.7 : y0 + 0.5;
  for (const fx of [x0 + 0.05, x1 - 0.4]) trim.box(fx, fy0, z1, fx + 0.35, y1 + ph + 0.4, z1 + 0.32, white);
  // the hotel pylon with its neon name
  if (floors >= 3 && hash(b.id, 13) < 0.7) {
    const py0 = shops ? y0 + 3.7 : y0 + 2, py1 = y1 + 3.4, pw = 0.75;
    trim.box(cx - pw, py0, z1, cx + pw, py1, z1 + 0.75, white, { bottom: true });
    trim.box(cx - pw * 0.7, py1, z1 + 0.05, cx + pw * 0.7, py1 + 0.8, z1 + 0.65, white);
    trim.box(cx - pw * 0.4, py1 + 0.8, z1 + 0.12, cx + pw * 0.4, py1 + 1.4, z1 + 0.55, acc);
    trim.geo(mastGeo(), mat4(cx, py1 + 2.2, z1 + 0.33), white);
    const ni = Math.floor(hash(b.id, 14) * NEON.length), u0 = ni / NEON.length, u1 = (ni + 1) / NEON.length;
    const nh = Math.min(py1 - py0 - 1.2, 2.2 + NEON[ni][0].length * 0.85), ny1 = py1 - 0.4, ny0 = ny1 - nh;
    neon.quad([cx - pw * 0.78, ny0, z1 + 0.77], [cx + pw * 0.78, ny0, z1 + 0.77], [cx + pw * 0.78, ny1, z1 + 0.77], [cx - pw * 0.78, ny1, z1 + 0.77],
      [[u0, 0], [u1, 0], [u1, 1], [u0, 1]]);
    top = Math.max(top, py1 + 3);
  }
  return top;
}

function door(trim, b, z1, y0, color = '#4a3428') {
  const dx = b.door.x * S;
  trim.box(dx - 0.85, y0, z1, dx + 0.85, y0 + 2.55, z1 + 0.06, col('#d8d2c6'));
  trim.box(dx - 0.7, y0, z1 + 0.02, dx + 0.7, y0 + 2.4, z1 + 0.09, col(color));
  trim.box(dx + 0.38, y0 + 1.05, z1 + 0.09, dx + 0.5, y0 + 1.17, z1 + 0.14, col('#e8c547'));
  trim.box(dx - 1.1, y0 + 2.6, z1, dx + 1.1, y0 + 2.72, z1 + 0.7, col('#3a3532'));
}

// pitched roof along the longer side; returns the ridge height
// (Moved from cityGrid.js. The tiles now run 2 m a repeat along the eaves and up the slope, so barrel tiles
// stand down the slope; the grid's square shingles did not mind which way they ran.)
// (pitch: the rise over the span, 0.42 as the grid had it; the Gables' Mediterranean roofs are lower)
function gableRoof(roofB, trim, x0, z0, x1, z1, y1, rc, wc, pitch = 0.42, o = 0.45) {
  const alongX = (x1 - x0) >= (z1 - z0);
  const span = alongX ? (z1 - z0) : (x1 - x0);
  const rise = span * pitch, run = span / 2, ye = y1 - o * rise / run, yr = y1 + rise;
  const up = Math.hypot(run + o, yr - ye) / 2;
  const ru = (len) => [[0, 0], [0, up], [len / 2, up], [len / 2, 0]];
  if (alongX) {
    const zc = (z0 + z1) / 2, L = x1 - x0 + 2 * o;
    roofB.quad([x0 - o, ye, z0 - o], [x0 - o, yr, zc], [x1 + o, yr, zc], [x1 + o, ye, z0 - o], ru(L), rc);
    roofB.quad([x1 + o, ye, z1 + o], [x1 + o, yr, zc], [x0 - o, yr, zc], [x0 - o, ye, z1 + o], ru(L), rc);
    trim.tri([x0, y1, z0], [x0, y1, z1], [x0, yr - 0.05, zc], undefined, wc);
    trim.tri([x1, y1, z1], [x1, y1, z0], [x1, yr - 0.05, zc], undefined, wc);
  } else {
    const xc = (x0 + x1) / 2, L = z1 - z0 + 2 * o;
    roofB.quad([x0 - o, ye, z1 + o], [xc, yr, z1 + o], [xc, yr, z0 - o], [x0 - o, ye, z0 - o], ru(L), rc);
    roofB.quad([x1 + o, ye, z0 - o], [xc, yr, z0 - o], [xc, yr, z1 + o], [x1 + o, ye, z1 + o], ru(L), rc);
    trim.tri([x1, y1, z0], [x0, y1, z0], [xc, yr - 0.05, z0], undefined, wc);
    trim.tri([x0, y1, z1], [x1, y1, z1], [xc, yr - 0.05, z1], undefined, wc);
  }
  return yr;
}

// hanok-style hip roof with wide eaves
// (Moved from cityGrid.js; its tiles now run 2 m a repeat along each eave and up the slope, as gableRoof's.)
// (o, the eaves, and rise as the grid's hanok roof had them; the Gables' hip roofs are tighter and lower)
function hipRoof(roofB, x0, z0, x1, z1, y1, rc, o = 1.1, rise = 2.6) {
  const ax = x0 - o, bx = x1 + o, az = z0 - o, bz = z1 + o, ye = y1 - 0.25, yr = ye + rise;
  const inset = Math.min(bx - ax, bz - az) / 2 - 0.6;
  const rx0 = ax + inset, rx1 = bx - inset, zc = (az + bz) / 2;
  const sl = Math.hypot(zc - az, rise) / 2, se = Math.hypot(inset, rise) / 2;
  const uv = [[0, 0], [inset / 2, sl], [(bx - ax - inset) / 2, sl], [(bx - ax) / 2, 0]];
  roofB.quad([ax, ye, az], [rx0, yr, zc], [rx1, yr, zc], [bx, ye, az], uv, rc);
  roofB.quad([bx, ye, bz], [rx1, yr, zc], [rx0, yr, zc], [ax, ye, bz], uv, rc);
  const end = [[0, 0], [(zc - az) / 2, se], [(bz - az) / 2, 0]];
  roofB.tri([ax, ye, bz], [rx0, yr, zc], [ax, ye, az], end, rc);
  roofB.tri([bx, ye, az], [rx1, yr, zc], [bx, ye, bz], end, rc);
  return yr;
}

function flowerBoxes(trim, x0, x1, z1, y0) {
  const COLS = ['#ff7aa2', '#f2c230', '#ffffff', '#e85d5d', '#c99bff'];
  for (let x = x0 + 1.2; x < x1 - 1; x += 3) {
    trim.box(x, y0 + 1.0, z1, x + 1.6, y0 + 1.3, z1 + 0.4, col('#7a5134'));
    for (let k = 0; k < 6; k++) trim.geo(flowerGeo(), mat4(x + 0.15 + k * 0.26, y0 + 1.38, z1 + 0.2), col(COLS[(k + Math.floor(x)) % COLS.length]));
  }
}

// Kimchi's villa: a glass living room under a deep white slab, a cantilevered upper floor with a wood screen.
// (Moved from cityGrid.js. Its four big boxes are the shell's masses; the Heights' glass mansions are built
// from it too, without the villa's sign.)
function villa(P, b, x0, z0, x1, z1, sign = true) {
  const { trim, mass } = P, lux = luxOf(P);
  const y0 = BASE, concrete = col('#ddd7cc'), white = col('#f1eee8'), wood = col('#9c6b43'), black = col('#18181a');
  const run = (len) => [[0, 0], [len / 6, 0], [len / 6, 1], [0, 1]];
  mass.box(x0, y0, z0, x1, y0 + 3.3, z1, concrete);
  lux.villa.quad([x0 + 0.4, y0 + 0.05, z1 + 0.02], [x1 - 0.4, y0 + 0.05, z1 + 0.02], [x1 - 0.4, y0 + 3.1, z1 + 0.02], [x0 + 0.4, y0 + 3.1, z1 + 0.02], run(x1 - x0 - 0.8));
  for (let x = x0 + 0.4; x <= x1 - 0.3; x += 3.2) trim.box(x - 0.05, y0, z1 + 0.02, x + 0.05, y0 + 3.15, z1 + 0.08, black);
  lux.villa.quad([x1 + 0.02, y0 + 0.05, z1 - 0.4], [x1 + 0.02, y0 + 0.05, z0 + 2], [x1 + 0.02, y0 + 3.1, z0 + 2], [x1 + 0.02, y0 + 3.1, z1 - 0.4], run(z1 - z0 - 2.4));
  mass.box(x0 - 0.5, y0 + 3.3, z0 - 0.5, x1 + 0.5, y0 + 3.62, z1 + 0.9, white);
  lux.leds.box(x0 - 0.4, y0 + 3.24, z1 + 0.78, x1 + 0.4, y0 + 3.31, z1 + 0.88);
  const ux0 = x0 + 0.6, ux1 = x1 - 3.4, uz0 = z0 + 0.8, uz1 = z1 + 1.2;
  mass.box(ux0, y0 + 3.62, uz0, ux1, y0 + 6.5, uz1, white);
  lux.villa.quad([ux0 + 0.6, y0 + 4.1, uz1 + 0.02], [ux1 - 2.6, y0 + 4.1, uz1 + 0.02], [ux1 - 2.6, y0 + 6.0, uz1 + 0.02], [ux0 + 0.6, y0 + 6.0, uz1 + 0.02], run(ux1 - ux0 - 3.2));
  for (let x = ux1 - 2.4; x < ux1 - 0.2; x += 0.22) trim.box(x, y0 + 3.9, uz1 + 0.02, x + 0.1, y0 + 6.3, uz1 + 0.14, wood);
  mass.box(ux0 - 0.35, y0 + 6.5, uz0 - 0.35, ux1 + 0.35, y0 + 6.85, uz1 + 0.35, white);
  // glass balustrade along the lower roof terrace
  lux.leds.box(ux1 + 0.3, y0 + 3.62, z1 + 0.8, x1 + 0.4, y0 + 3.66, z1 + 0.86);
  door(trim, b, z1, y0, '#141416');
  if (sign) addSign(P, 'VILLA KIMCHI', { bg: '#121214', fg: 'gold', serif: true, size: 62, w: 512, h: 112 }, b.door.x * S + 2.6, y0 + 2.0, z1 + 0.1, 2.3, 0.5);
  return y0 + 6.85;
}

// The villa's design reaches past the box it stands on: its slab by 0.5 m at the sides and the back, and at the
// front the cantilevered upper floor by 1.2 m and that floor's roof by 1.55 m. The camera, bullets and Kimchi
// stop only at the footprint (OCC and BUILD), so on v2 the design is built that much inside its footprint and
// nothing reaches past it (at the spawn the chase camera ended up inside the cantilever). The ground floor's
// glass stands 1.55 m back, under the cantilever.
const VILLA_IN = { side: 0.5, front: 1.55 };
const villaIn = (P, f, sign = true) =>
  villa(P, f.lb, f.x0 + VILLA_IN.side, f.z0 + VILLA_IN.side, f.x1 - VILLA_IN.side, f.z1 - VILLA_IN.front, sign);

// boutiques and the other luxury fronts: plain stone, big display windows, a gold-lettered sign
// (Moved from cityGrid.js; the stone box and its cap are the shell's masses.)
function luxShop(P, b, x0, z0, x1, z1, h) {
  const { trim, mass } = P, lux = luxOf(P);
  const y0 = BASE, y1 = BASE + h, dx = b.door.x * S, k = b.place;
  const run = (len) => [[0, 0], [len / 6, 0], [len / 6, 1], [0, 1]];
  const pal = {
    watches: { wall: '#1d1c21', cap: '#0f0f12', frame: 'gold', glass: lux.watch },
    fashion: { wall: '#ece6da', cap: '#141414', frame: '#141414', glass: lux.shop },
    jet: { wall: '#f3f2ef', cap: '#141414', frame: '#141414', glass: lux.villa },
    marina: { wall: '#f4f1ea', cap: '#1d2b4a', frame: '#1d2b4a', glass: lux.villa },
  }[k];
  mass.box(x0, y0, z0, x1, y1, z1, col(pal.wall));
  mass.box(x0 - 0.2, y1 - 0.05, z0 - 0.2, x1 + 0.2, y1 + 0.35, z1 + 0.2, col(pal.cap));
  const edge = (xa, ya, xb, yb) => (pal.frame === 'gold' ? lux.gold.box(xa, ya, z1, xb, yb, z1 + 0.12) : trim.box(xa, ya, z1, xb, yb, z1 + 0.12, col(pal.frame)));
  const wy0 = y0 + 0.45, wy1 = y0 + (k === 'jet' || k === 'marina' ? 3.4 : 4.1);
  for (const [ax, bx] of [[x0 + 1.2, dx - 2.0], [dx + 2.0, x1 - 1.2]]) {
    if (bx - ax < 1) continue;
    pal.glass.quad([ax, wy0, z1 + 0.03], [bx, wy0, z1 + 0.03], [bx, wy1, z1 + 0.03], [ax, wy1, z1 + 0.03], run(bx - ax));
    edge(ax - 0.12, wy0 - 0.12, bx + 0.12, wy0); edge(ax - 0.12, wy1, bx + 0.12, wy1 + 0.12);
    edge(ax - 0.12, wy0, ax, wy1); edge(bx, wy0, bx + 0.12, wy1);
    for (let x = ax + 3; x < bx - 0.5; x += 3) edge(x - 0.04, wy0, x + 0.04, wy1);
  }
  door(trim, b, z1, y0, k === 'watches' ? '#0d0d10' : '#1b1b1d');
  if (k === 'watches') {
    addSign(P, 'CHRONO ROW', { bg: '#0f0f12', fg: 'gold', serif: true, sub: 'FINE WATCHES · SEOUL · GENÈVE', size: 74 }, dx, y0 + 5.3, z1 + 0.06, 11, 2.2);
    lux.leds.box(x0, y1 - 0.14, z1 + 0.02, x1, y1 - 0.06, z1 + 0.24);
  } else if (k === 'fashion') {
    addSign(P, 'MAISON K', { bg: '#ece6da', fg: '#121212', serif: true, sub: 'COUTURE · LEATHER · FITS', size: 84 }, dx, y0 + 5.3, z1 + 0.06, 11, 2.2);
    for (const [ax, bx] of [[x0 + 1.0, dx - 1.8], [dx + 1.8, x1 - 1.0]]) trim.box(ax, y0 + 4.35, z1, bx, y0 + 4.5, z1 + 1.3, col('#121212'));
  } else if (k === 'jet') {
    addSign(P, 'KIMCHI AIR', { bg: '#101012', fg: 'gold', serif: true, sub: 'PRIVATE TERMINAL', size: 74 }, dx, y0 + 4.3, z1 + 0.06, 7, 1.4);
    trim.box(dx - 2.4, y0 + 3.0, z1, dx + 2.4, y0 + 3.2, z1 + 2.6, col('#121212'));
  } else if (k === 'marina') {
    addSign(P, 'YACHT CLUB', { bg: '#1d2b4a', fg: 'gold', serif: true, sub: 'KIMCHI CITY MARINA', size: 74 }, dx, y0 + 4.3, z1 + 0.06, 8, 1.6);
    for (const fx of [x0 + 1, x1 - 1]) {
      trim.box(fx - 0.05, y1 + 0.35, z1 - 0.5, fx + 0.05, y1 + 4.2, z1 - 0.4, col('#e9e9e9'));
      for (const [a, c] of [[[fx, y1 + 4.1, z1 - 0.45], [fx + 1.4, y1 + 3.8, z1 - 0.45]], [[fx + 1.4, y1 + 3.8, z1 - 0.45], [fx, y1 + 4.1, z1 - 0.45]]]) trim.tri(a, c, [fx, y1 + 3.5, z1 - 0.45], undefined, col('#1d2b4a'));
    }
  }
  roofLabel(P, { watches: 'CHRONO ROW', fashion: 'MAISON K', jet: 'KIMCHI AIR', marina: 'YACHT CLUB' }[k], pal.cap, x0, z0, x1, z1, y1 + 0.35);
  return y1 + 0.35;
}

// ---------- shop fronts ----------

// The grid's ground-floor shops along the front: 6 m bays, centred, each a painted front from the shops2
// atlas (3 x 6 cells), an awning and the sign board that goes with the shop (shops2_signs, 2 x 9 cells).
// choices are the atlas cells this street sells; awning is one colour for the row (else one per bay, as the
// grid had them). Returns the number of bays.
function shopRow(P, b, x0, x1, z1, y0, choices, awning = null) {
  const bays = Math.floor((x1 - x0 - 1) / 6.2);
  const startX = (x0 + x1) / 2 - bays * 3.1;
  for (let i = 0; i < bays; i++) {
    const sx = startX + i * 6.2 + 0.1, ex = sx + 6;
    const si = choices[Math.floor(hash(b.id * 5 + i, 91) * choices.length)];
    const su0 = (si % 3) / 3, sv1 = 1 - Math.floor(si / 3) / 6;
    P.shops.quad([sx, y0, z1 + 0.02], [ex, y0, z1 + 0.02], [ex, y0 + 3.2, z1 + 0.02], [sx, y0 + 3.2, z1 + 0.02],
      [[su0, sv1 - 1 / 6], [su0 + 1 / 3, sv1 - 1 / 6], [su0 + 1 / 3, sv1], [su0, sv1]]);
    const aw = awningRow(P, awning ?? AWNING_COLORS[Math.floor(hash(b.id * 3 + i, 90) * AWNING_COLORS.length)]), ay = y0 + 3.4;
    aw.quad([sx, ay - 0.6, z1 + 1.35], [ex, ay - 0.6, z1 + 1.35], [ex, ay, z1 + 0.02], [sx, ay, z1 + 0.02], [[0, 0], [6, 0], [6, 1], [0, 1]]);
    aw.quad([sx, ay - 0.9, z1 + 1.35], [ex, ay - 0.9, z1 + 1.35], [ex, ay - 0.6, z1 + 1.35], [sx, ay - 0.6, z1 + 1.35], [[0, 0], [6, 0], [6, 0.3], [0, 0.3]]);
    const u0 = (si % 2) * 0.5, row = Math.floor(si / 2), v1 = 1 - row / 9, v0 = 1 - (row + 1) / 9;
    P.signs.quad([sx + 0.4, ay + 0.12, z1 + 0.05], [ex - 0.4, ay + 0.12, z1 + 0.05], [ex - 0.4, ay + 1.1, z1 + 0.05], [sx + 0.4, ay + 1.1, z1 + 0.05],
      [[u0, v0], [u0 + 0.5, v0], [u0 + 0.5, v1], [u0, v1]]);
  }
  return bays;
}

// A glass front of one storey (an interior atlas row behind it) with slim mullions every 3 m. The office lobby
// repeats every 12 m (painted at its real proportions for a storey about 3 m tall), the shops every 6 m.
function glassFront(P, kind, xa, xb, z1, ya, yb, mullion) {
  const every = kind === 'lobby' ? 12 : 6, run = (len) => [[0, 0], [len / every, 0], [len / every, 1], [0, 1]];
  glassRow(P, kind).quad([xa, ya, z1 + 0.03], [xb, ya, z1 + 0.03], [xb, yb, z1 + 0.03], [xa, yb, z1 + 0.03], run(xb - xa));
  for (let x = xa; x <= xb + 0.01; x += (xb - xa) / Math.max(1, Math.round((xb - xa) / 3))) P.trim.box(x - 0.06, ya, z1, x + 0.06, yb, z1 + 0.1, mullion);
  P.trim.box(xa - 0.1, yb, z1, xb + 0.1, yb + 0.25, z1 + 0.14, mullion);
}

// ---------- the places (the grid's buildBuildings, per building) ----------

function placeBuilding(P, b, f) {
  const { x0, z0, x1, z1, lb } = f, trim = P.trim, h = b.h;
  const y0 = BASE, y1 = BASE + h;
  const wc = col(b.wall), rc = col(b.roof);
  if (!b.house) rc.lerp(WHITE, 0.5);
  const uOffs = uOffsOf(b), vOff = Math.floor(hash(b.id, 6) * 4) / 8;
  let top = y1;
  if (b.house) {
    facadeWalls(P.wall('house'), x0, y0, z0, x1, y1, z1, wc, { storey: storeyFor(h, 3.0), uOffs, vOff });
    top = gableRoof(P.houseRoofs, P.mass, x0, z0, x1, z1, y1, rc, wc);
  } else if (b.place === 'home') {
    top = villaIn(P, f);
  } else if (b.place === 'watches' || b.place === 'fashion' || b.place === 'jet' || b.place === 'marina') {
    top = luxShop(P, lb, x0, z0, x1, z1, h);
  } else if (b.place === 'kimchi') {
    facadeWalls(P.wall('deco'), x0, y0, z0, x1, y1, z1, wc, { uOffs, vOff: 0, vBase: y0 - 1.2 });
    top = hipRoof(P.houseRoofs, x0, z0, x1, z1, y1, col('#3b3f46'));
    // red timber frame on the front
    for (let x = x0 + 0.2; x < x1; x += 3.4) trim.box(x, y0, z1, x + 0.3, y1, z1 + 0.12, col('#9c2a1e'));
    trim.box(x0, y1 - 0.45, z1, x1, y1 - 0.05, z1 + 0.14, col('#9c2a1e'));
    // porch pillars and lanterns
    for (const px of [lb.door.x * S - 2.6, lb.door.x * S + 2.6]) trim.box(px - 0.18, y0, z1 + 1.9, px + 0.18, y1 + 0.2, z1 + 2.26, col('#b5321f'));
    trim.box(lb.door.x * S - 3.2, y1 + 0.1, z1, lb.door.x * S + 3.2, y1 + 0.35, z1 + 2.5, col('#3b3f46'));
    for (let i = 0; i < 5; i++) {
      const lx = x0 + (i + 0.5) * (x1 - x0) / 5;
      P.glow.geo(lanternGeo(), mat4(lx, y1 - 0.75, z1 + 0.75, 0, 0, 0, 1, 1.25, 1), LANTERN);
      trim.box(lx - 0.02, y1 - 0.4, z1 + 0.73, lx + 0.02, y1 + 0.05, z1 + 0.77, col('#222'));
    }
  } else {
    facadeWalls(P.wall('deco'), x0, y0, z0, x1, y1, z1, wc, { uOffs, vOff });
    flatRoof(P.roofs, x0, z0, x1, z1, y1, rc);
    top = parapet(trim, x0, z0, x1, z1, y1, wc.clone().multiplyScalar(0.82));
  }

  const run = (len) => [[0, 0], [len / 6, 0], [len / 6, 1], [0, 1]];
  const awning = (c) => awningRow(P, c);
  if (b.place === 'mart') {
    glassRow(P, 'mart').quad([x0 + 1, y0 + 0.4, z1 + 0.03], [x1 - 1, y0 + 0.4, z1 + 0.03], [x1 - 1, y0 + 3.4, z1 + 0.03], [x0 + 1, y0 + 3.4, z1 + 0.03], run(x1 - x0 - 2));
    for (let x = x0 + 1; x <= x1 - 1; x += 3) trim.box(x - 0.08, y0 + 0.3, z1 + 0.03, x + 0.08, y0 + 3.5, z1 + 0.1, col('#e9eef0'));
    trim.box(x0, y0 + 3.7, z1, x1, y0 + 5.3, z1 + 0.25, col('#3d9a6a'));
    addSign(P, 'K-MART', { bg: '#3d9a6a', fg: '#ffffff', sub: '24/7 편의점' }, (x0 + x1) / 2, y0 + 4.5, z1 + 0.27, 11, 1.5);
    roofLabel(P, 'K-MART', '#3d9a6a', x0, z0, x1, z1, top);
    awning('#3d9a6a').quad([x0 + 1, y0 + 2.9, z1 + 1.6], [x1 - 1, y0 + 2.9, z1 + 1.6], [x1 - 1, y0 + 3.6, z1 + 0.25], [x0 + 1, y0 + 3.6, z1 + 0.25], [[0, 0], [(x1 - x0 - 2), 0], [(x1 - x0 - 2), 1], [0, 1]]);
  } else if (b.place === 'dealer') {
    const autoGlass = glassRow(P, 'auto'), lux = luxOf(P);
    autoGlass.quad([x0 + 0.6, y0 + 0.3, z1 + 0.03], [x1 - 0.6, y0 + 0.3, z1 + 0.03], [x1 - 0.6, y0 + 4.2, z1 + 0.03], [x0 + 0.6, y0 + 4.2, z1 + 0.03], run(x1 - x0 - 1.2));
    autoGlass.quad([x1 + 0.03, y0 + 0.3, z1 - 0.6], [x1 + 0.03, y0 + 0.3, z0 + 0.6], [x1 + 0.03, y0 + 4.2, z0 + 0.6], [x1 + 0.03, y0 + 4.2, z1 - 0.6], run(z1 - z0 - 1.2));
    for (let x = x0 + 0.6; x <= x1 - 0.5; x += 3.4) trim.box(x - 0.07, y0 + 0.2, z1 + 0.03, x + 0.07, y0 + 4.3, z1 + 0.1, col('#dfe6ea'));
    trim.box(x0, y0 + 4.4, z1, x1, y0 + 6.2, z1 + 0.25, col('#101012'));
    lux.leds.box(x0, y0 + 4.32, z1, x1, y0 + 4.42, z1 + 0.3);
    addSign(P, 'KIMCHI MOTORS', { bg: '#101012', fg: 'gold', serif: true, sub: 'SUPERCARS · HYPERCARS · LIMOUSINES', size: 64 }, (x0 + x1) / 2, y0 + 5.3, z1 + 0.27, 10, 1.6);
    roofLabel(P, 'KIMCHI MOTORS', '#101012', x0, z0, x1, z1, top);
    // light posts and a gold rope along the display lot: on the grid, the block's front edge from its west
    // side, every 2 tiles (8 m), 5 tiles (20 m) in front of the showroom
    for (let i = 0; i <= 5; i++) {
      const px = x0 + i * 8, pz = z1 + 19.7;
      lux.gold.box(px - 0.06, BASE, pz - 0.06, px + 0.06, BASE + 0.9, pz + 0.06);
      if (i < 5) lux.gold.box(px, BASE + 0.82, pz - 0.025, px + 8, BASE + 0.87, pz + 0.025);
    }
  } else if (b.place === 'police') {
    trim.box(x0, y0 + 3.3, z1, x1, y0 + 4.1, z1 + 0.2, col('#1f4f8a'));
    trim.box(x0, y0 + 4.1, z1, x1, y0 + 4.3, z1 + 0.2, col('#f2f2f2'));
    addSign(P, 'POLICE', { bg: '#1f4f8a', fg: '#ffffff', sub: '경찰서 · Kimchi City PD' }, (x0 + x1) / 2, y0 + 5.4, z1 + 0.06, 9, 1.6);
    door(trim, lb, z1, y0, '#1b2b44');
    roofLabel(P, 'POLICE', '#1f4f8a', x0, z0, x1, z1, top);
  } else if (b.place === 'hospital') {
    addSign(P, 'HOSPITAL', { bg: '#ffffff', fg: '#d6402b', sub: '병원 · emergency', border: '#d6402b' }, (x0 + x1) / 2, y0 + 4.2, z1 + 0.06, 10, 1.9);
    for (const [cx, cy, w, hh] of [[(x0 + x1) / 2, y1 - 2.2, 0.9, 2.8], [(x0 + x1) / 2, y1 - 2.2, 2.8, 0.9]])
      trim.box(cx - w / 2, cy - hh / 2, z1, cx + w / 2, cy + hh / 2, z1 + 0.15, col('#e23b2b'));
    door(trim, lb, z1, y0, '#9fb7c9');
    trim.box(lb.door.x * S - 3, y0 + 2.9, z1, lb.door.x * S + 3, y0 + 3.1, z1 + 3, col('#e9eef0'));
    roofLabel(P, '+ HOSPITAL', '#d6402b', x0, z0, x1, z1, top);
  } else if (b.place === 'spray') {
    const dx = lb.door.x * S;
    trim.box(dx - 2.6, y0, z1, dx + 2.6, y0 + 3.9, z1 + 0.05, col('#cfcad6'));
    for (let y = y0 + 0.15; y < y0 + 3.7; y += 0.32) trim.box(dx - 2.4, y, z1 + 0.05, dx + 2.4, y + 0.26, z1 + 0.09, col('#8a8494'));
    addSign(P, 'K-SPRAY', { bg: '#8a5cc2', fg: '#ffffff', sub: 'PAINT · REPAIR · NO QUESTIONS' }, dx, y0 + 4.5, z1 + 0.06, 7, 1.1);
    roofLabel(P, 'K-SPRAY', '#8a5cc2', x0, z0, x1, z1, top);
  } else if (b.place === 'guns') {
    addSign(P, 'K-ARMS', { bg: '#151515', fg: '#e23b2b', sub: 'GUNS · AMMO · ARMOR', border: '#e23b2b' }, (x0 + x1) / 2, y0 + 3.9, z1 + 0.06, 8, 1.3);
    for (let x = x0 + 1; x < x1 - 0.8; x += 0.25) trim.box(x, y0 + 0.6, z1 + 0.05, x + 0.05, y0 + 3.0, z1 + 0.1, col('#2a2a2a'));
    door(trim, lb, z1, y0, '#2a2a2a');
    roofLabel(P, 'K-ARMS', '#c0262b', x0, z0, x1, z1, top);
  } else if (b.place === 'kimchi') {
    addSign(P, 'KIMCHI HOUSE', { bg: '#b5321f', fg: '#fff1d6', sub: '김치 하우스 · since forever', border: '#f2c230' }, (x0 + x1) / 2, y1 + 1.15, z1 + 0.5, 12, 2.2, -0.25);
    door(trim, lb, z1, y0, '#5a1f16');
  } else if (b.place === 'yuna') {
    door(trim, lb, z1, y0, '#6b4aa0');
    addSign(P, "YUNA'S", { bg: '#9b7be0', fg: '#ffffff', w: 256, h: 96, size: 52 }, lb.door.x * S + 1.7, y0 + 1.9, z1 + 0.06, 1.3, 0.5);
    flowerBoxes(trim, x0, x1, z1, y0);
  } else if (b.house) {
    door(trim, lb, z1, y0);
  }
  return top;
}

// ---------- the region styles ----------

// the roofs' colours: K-Town's green coats, South Beach's pale ones, the Port's sheds' metal
const KTOWN_ROOFS = ['#5f9e74', '#6aa98a', '#4f8f6b', '#78a98c'];
const DECO_ROOFS = ['#e9e3d6', '#d9d2c3', '#d3d5d1', '#efe6da'];
const SHED_ROOFS = ['#8d969c', '#a7b0b4', '#6e7a80', '#b9b4aa'];

// K-Town's rooftops, as Seoul's are (detail): a rooftop room (an oktapbang) with a steel door and a lit window
// under a coloured slab on some, water tanks lying on stands, a satellite dish, planters of greens.
function ktownRooftop(P, b, x0, z0, x1, z1, y1) {
  const trim = P.trim, w = x1 - x0, d = z1 - z0;
  if (w >= 9 && d >= 9 && hash(b.id, 62) < 0.45) {
    const rw = 3.6, rd = 2.8, right = hash(b.id, 63) < 0.5, rx0 = right ? x1 - 0.6 - rw : x0 + 0.6, rz0 = z0 + 0.6;
    trim.box(rx0, y1, rz0, rx0 + rw, y1 + 2.3, rz0 + rd, col(pickBy(['#f2efe6', '#e8dccb', '#dfe7ea', '#f0e2c8'], hash(b.id, 64))));
    trim.box(rx0 - 0.2, y1 + 2.3, rz0 - 0.2, rx0 + rw + 0.2, y1 + 2.45, rz0 + rd + 0.2, col(pickBy(['#3f7fc0', '#3d9a6a', '#2f9aa0', '#c0504a'], hash(b.id, 65))), { bottom: true });
    trim.box(rx0 + 0.4, y1, rz0 + rd, rx0 + 1.2, y1 + 1.95, rz0 + rd + 0.05, col('#5a6a78'));
    P.glow.box(rx0 + 1.7, y1 + 1.0, rz0 + rd, rx0 + 3.1, y1 + 1.8, rz0 + rd + 0.04, col('#8a6a44'));
  }
  if (hash(b.id, 66) < 0.5) {
    const tx = x1 - 2, tz = z1 - 2.2, steel = col('#d9dcde');
    trim.box(tx - 1.0, y1, tz - 0.5, tx + 1.0, y1 + 0.2, tz + 0.5, col('#7d8386'));
    trim.geo(tankLyingGeo(), mat4(tx, y1 + 0.8, tz), hash(b.id, 67) < 0.5 ? steel : col('#4f9a8a'));
  }
  if (hash(b.id, 68) < 0.35) trim.geo(dishGeo(), mat4(x0 + 1.4, y1 + 0.9, z1 - 1.2), col('#eceef0'));
  if (hash(b.id, 69) < 0.3) {
    for (let i = 0; i < 3; i++) {
      const px = x0 + 1 + i * 1.3, pz = z0 + d / 2;
      trim.box(px, y1, pz, px + 1.0, y1 + 0.45, pz + 0.6, col('#8a6248'));
      trim.box(px + 0.05, y1 + 0.45, pz + 0.05, px + 0.95, y1 + 0.75, pz + 0.55, col('#5c9a48'));
    }
  }
}

// South Beach (and the grid's ordinary building): pastel stucco on the Art Deco facade, decoDetails' ledges,
// cornice, parapet and pylon, rooftop plant, and shops (or a door) on the ground floor.
function decoBuilding(P, b, f) {
  const { x0, z0, x1, z1, lb } = f, h = b.h, y0 = BASE, y1 = BASE + h, st = storeyFor(h, STOREY.deco);
  const shopsHere = b.shop && x1 - x0 >= 12;
  const wcol = col(MIAMI[Math.floor(hash(b.id, 7) * MIAMI.length)]);
  facadeWalls(P.wall('deco'), x0, y0, z0, x1, y1, z1, wcol, { storey: st, uOffs: uOffsOf(b), vOff: vOffOf(b) });
  // the roofs: pale, some in a whiter shade of the stucco; a pool on the roof of a few of the bigger hotels
  flatRoof(P.roofs, x0, z0, x1, z1, y1, hash(b.id, 64) < 0.35 ? wcol.clone().lerp(WHITE, 0.55) : col(pickBy(DECO_ROOFS, hash(b.id, 65))));
  const top = decoDetails(P.trim, P.neon, lb, x0, z0, x1, z1, y0, y1, wcol, shopsHere, st);
  const w = x1 - x0, d = z1 - z0;
  if (b.floors >= 3 && w >= 15 && d >= 14 && hash(b.id, 66) < 0.35) {
    const pw = Math.min(9, w - 6);
    pool(P, x0 + 2, z0 + 1.6, x0 + 2 + pw, z0 + 1.6 + Math.min(4.5, d * 0.32), y1);
    loungers(P, x0 + 2, z0 + 2 + Math.min(4.5, d * 0.32), pw, y1, b);
  } else if (w >= 12 && d >= 12 && hash(b.id, 68) < 0.3) {
    // a sun deck of teak boards at the back with umbrellas over it (the boards in the shell: they show from the air)
    const dx0 = x0 + 1.2, dx1 = x1 - 1.2, dz0 = z0 + 1.2, dz1 = z0 + Math.min(7, d * 0.45);
    P.mass.quad([dx0, y1 + 0.04, dz0], [dx0, y1 + 0.04, dz1], [dx1, y1 + 0.04, dz1], [dx1, y1 + 0.04, dz0], undefined, col('#b98f66'));
    const shade = col(pickBy(['#f7f5ef', '#ff8fb1', '#7fd1c7', '#ffd166'], hash(b.id, 69)));
    for (let x = dx0 + 2; x < dx1 - 1.5; x += 4.5) {
      P.trim.box(x - 0.04, y1, (dz0 + dz1) / 2 - 0.04, x + 0.04, y1 + 2.2, (dz0 + dz1) / 2 + 0.04, col('#c7c2b8'));
      P.trim.geo(umbrellaGeo(), mat4(x, y1 + 2.2, (dz0 + dz1) / 2), shade);
    }
  } else rooftop(P.trim, b, x0, z0, x1, z1, y1, h);
  // a Deco finial over the stepped centre of the front on some: a fluted fin with a glowing ball
  if (b.floors >= 3 && hash(b.id, 67) < 0.25) {
    const cx = (x0 + x1) / 2, acc = col(ACCENT[Math.floor(hash(b.id, 8) * ACCENT.length)]);
    P.trim.box(cx - 0.35, top, z1 - 0.62, cx + 0.35, top + 3.2, z1 - 0.12, col('#f7f5ef'));
    for (const dx of [-0.2, 0.2]) P.trim.box(cx + dx - 0.05, top, z1 - 0.12, cx + dx + 0.05, top + 3.2, z1 - 0.06, acc);
    P.glow.geo(lanternGeo(), mat4(cx, top + 3.5, z1 - 0.37), col(NEON[Math.floor(hash(b.id, 14) * NEON.length)][1]));
  }
  if (!shopsHere || !shopRow(P, b, x0, x1, z1, y0, SHOPS_OF.deco)) door(P.trim, lb, z1, y0);
}

// Koreatown: warm brick and tile on the K-Town facade, a cornice in the trim colour, shops under awnings, and
// the signs that make the street: blade boards standing out from the wall, neon on the upper floors, a row of
// red lanterns under the cornice.
function ktownBuilding(P, b, f) {
  const { x0, z0, x1, z1, lb } = f, h = b.h, y0 = BASE, y1 = BASE + h, w = x1 - x0, st = storeyFor(h, STOREY.ktown);
  const wc = col(b.wall), tc = b.trim ? col(b.trim) : wc.clone().multiplyScalar(0.62);
  facadeWalls(P.wall('ktown'), x0, y0, z0, x1, y1, z1, wc, { storey: st, uOffs: uOffsOf(b), vOff: vOffOf(b) });
  // most of Seoul's flat roofs wear a green waterproof coat; the rest are grey
  flatRoof(P.roofs, x0, z0, x1, z1, y1, hash(b.id, 60) < 0.5 ? col(pickBy(KTOWN_ROOFS, hash(b.id, 61))) : col(b.roof).lerp(WHITE, 0.45));
  const trim = P.trim;
  ktownRooftop(P, b, x0, z0, x1, z1, y1);
  trim.box(x0 - 0.12, y1 - 0.35, z0 - 0.12, x1 + 0.12, y1, z1 + 0.12, tc, { top: false, bottom: true });
  parapet(trim, x0, z0, x1, z1, y1, wc.clone().multiplyScalar(0.88), 0.25, 0.7);
  corners(trim, x0, z0, x1, z1, y0, y1 - 0.35, wc.clone().multiplyScalar(0.8), 0.4, 0.06);
  rooftop(trim, b, x0, z0, x1, z1, y1, h);
  const shops = b.shop ? shopRow(P, b, x0, x1, z1, y0, SHOPS_OF.ktown, b.awning) : 0;
  if (!shops) {
    door(trim, lb, z1, y0);
    trim.box(x0 - 0.05, y0, z0 - 0.05, x1 + 0.05, y0 + 0.45, z1 + 0.05, tc, { top: false });
  }
  // a blade sign by one front corner, from the second floor up (signs_ktown's 8 boards, 1 x 3.25 m)
  const blade = b.floors >= 3 && hash(b.id, 21) < 0.7, right = hash(b.id, 22) < 0.5;
  if (blade) {
    const xb = right ? x1 - 0.75 : x0 + 0.75, ya = y0 + 4.7, H = 3.25, zi = z1 + 0.25, zo = z1 + 1.25, t = 0.08;
    const i = Math.floor(hash(b.id, 23) * TX.KTOWN_BLADES.length), u0 = i / 8, u1 = (i + 1) / 8, v0 = 1 - 832 / 1600;
    trim.box(xb - t + 0.01, ya - 0.08, zi - 0.05, xb + t - 0.01, ya + H + 0.08, zo + 0.05, col('#2a2622'));
    for (const y of [ya + 0.4, ya + H - 0.4]) trim.box(xb - 0.04, y, z1, xb + 0.04, y + 0.08, zi, col('#2a2622'));
    P.ksigns.quad([xb + t, ya, zo], [xb + t, ya, zi], [xb + t, ya + H, zi], [xb + t, ya + H, zo], [[u0, v0], [u1, v0], [u1, 1], [u0, 1]]);
    P.ksigns.quad([xb - t, ya, zi], [xb - t, ya, zo], [xb - t, ya + H, zo], [xb - t, ya + H, zi], [[u0, v0], [u1, v0], [u1, 1], [u0, 1]]);
  }
  // a neon sign on the wall between the second and third floors' windows (signs_ktown's 6, 4:1)
  if (b.floors >= 3 && w >= 7 && hash(b.id, 24) < 0.55) {
    const k = Math.floor(hash(b.id, 26) * TX.KTOWN_NEON.length), sw = Math.min(4.4, w - 3), sh = sw / 4;
    const cx = (x0 + x1) / 2 + (blade ? (right ? -0.8 : 0.8) : 0), cy = y0 + 2 * st + 0.2;
    const u0 = (k % 2) * 0.5, v1 = 1 - (832 + Math.floor(k / 2) * 256) / 1600, v0 = v1 - 256 / 1600;
    trim.box(cx - sw / 2 - 0.1, cy - sh / 2 - 0.1, z1, cx + sw / 2 + 0.1, cy + sh / 2 + 0.1, z1 + 0.06, col('#141216'));
    P.ksigns.quad([cx - sw / 2, cy - sh / 2, z1 + 0.08], [cx + sw / 2, cy - sh / 2, z1 + 0.08], [cx + sw / 2, cy + sh / 2, z1 + 0.08], [cx - sw / 2, cy + sh / 2, z1 + 0.08],
      [[u0, v0], [u0 + 0.5, v0], [u0 + 0.5, v1], [u0, v1]]);
  }
  // red lanterns on a wire under the cornice
  if (hash(b.id, 25) < 0.4) {
    const n = Math.max(2, Math.floor(w / 2.6)), yl = y1 - 0.95;
    trim.box(x0 + 0.3, yl + 0.42, z1 + 0.5, x1 - 0.3, yl + 0.45, z1 + 0.53, col('#222'));
    for (let i = 0; i < n; i++) P.glow.geo(lanternGeo(), mat4(x0 + (i + 0.5) * w / n, yl, z1 + 0.52, 0, 0, 0, 0.8, 1.0, 0.8), LANTERN);
  }
}

// ---------- towers ----------

// The towers' curtain walls, each a layer the shader draws (SHADER_LAYERS): sleek glass in a fine grid, ribbon
// windows between white spandrels, glass between stone piers, and champagne glass on dark bronze mullions; how often each is chosen, its
// glass tints and its trim (corners, parapet). The low-rise north row takes the two banded and stone kinds, and
// champagne glass is for the mid-rise only (a whole tall shaft of it reads as a khaki slab across the bay).
const CURTAINS = [
  { layer: L.tower, share: 0.45, tints: ['#a3d3e4', '#8fc4d6', '#a8dbd2', '#b4cfe8', '#98bcdb', '#c2e2e4'], trim: '#c9ced3' },
  { layer: L.banded, share: 0.22, tints: ['#82b4cc', '#73a3ba', '#8cbcb4', '#92acc6'], trim: '#eceae4' },
  { layer: L.framed, share: 0.18, tints: ['#8ebacf', '#a4cad3', '#83abc1'], trim: '#e2dccf' },
  { layer: L.bronze, share: 0.15, tints: ['#ead6b2', '#e2c8a0', '#f0dcba', '#dcc8a6'], trim: '#3a3028' },
];
function curtainOf(b) {
  const list = b.floors <= 6 ? CURTAINS.slice(1, 3) : b.floors > 24 ? CURTAINS.slice(0, 3) : CURTAINS, total = list.reduce((a, c) => a + c.share, 0);
  let k = hash(b.id, 36) * total;
  for (const c of list) { if (k < c.share) return c; k -= c.share; }
  return list[0];
}
const pickBy = (list, u) => list[Math.min(list.length - 1, Math.floor(u * list.length))];
// the LED crowns' colours (Miami's skyline at night)
const BEACONS = ['#5ff0ff', '#ff5fb4', '#ffffff', '#a27bff', '#ffd25c', '#6dff9e'];
// A curtain wall's rows start a whole number of atlas sheets up, a different number per building: the shader
// picks the lit floors by row, so each tower lights its own floors at night.
const curtainOpt = (b, st) => ({ storey: st, uOffs: uOffsOf(b), vOff: vOffOf(b) + 1 + Math.floor(hash(b.id, 38) * 48) });

// A tower's top: stepped Art Deco setbacks or one setback ([inset share of the narrow side, storeys] each), a
// glass top sloping down to the front over its last storeys (slant), or flat (null). All of it stands inside the
// building's own height, so its OCC and the sightlines still hold.
function crownOf(b) {
  if (b.floors < 16) return null;
  const k = hash(b.id, 31);
  if (k < 0.36) return { steps: [[0.1, 2], [0.2, 1], [0.3, 1]] };
  if (k < 0.6) return { steps: [[0.16, 3]] };
  if (k < 0.8 && b.floors >= 20) return { slant: 3 + Math.floor(hash(b.id, 32) * 3) };
  return null;
}

// The slanted top: the back wall up to yt, the side walls as triangles (quads with a corner twice, as the facade
// walls are quads) and the slope itself glazed, all on the curtain wall's grid.
function slantTop(B, x0, z0, x1, z1, yb, yt, color, { storey, uOffs, vOff, vBase }) {
  if (B === SINK) return;
  const v = (y) => vOff + (y - vBase) / (storey * 8), va = v(yb), vt = v(yt);
  const u = (len, i) => [uOffs[i], uOffs[i] + baysOf(len) / 8];
  const [f0, f1] = u(x1 - x0, 0), [b0, b1] = u(x1 - x0, 1), [r0, r1] = u(z1 - z0, 2), [l0, l1] = u(z1 - z0, 3);
  B.quad([x1, yb, z0], [x0, yb, z0], [x0, yt, z0], [x1, yt, z0], [[b0, va], [b1, va], [b1, vt], [b0, vt]], color);
  B.quad([x1, yb, z1], [x1, yb, z0], [x1, yt, z0], [x1, yt, z0], [[r0, va], [r1, va], [r1, vt], [r1, vt]], color);
  B.quad([x0, yb, z0], [x0, yb, z1], [x0, yt, z0], [x0, yt, z0], [[l0, va], [l1, va], [l0, vt], [l0, vt]], color);
  B.quad([x0, yb, z1], [x1, yb, z1], [x1, yt, z0], [x0, yt, z0], [[f0, va], [f1, va], [f1, vt], [f0, vt]], color);
}

// A ring of LED strip round the top of a tower's walls (x0..z1) from ya to yb, a few cm proud of them: the
// beacon layer, dark by day and glowing in its colour at night.
function beacon(B, x0, z0, x1, z1, ya, yb, color) {
  B.box(x0 - 0.06, ya, z0 - 0.06, x1 + 0.06, yb, z1 + 0.06, color, { top: false });
}

// Downtown: curtain walls of glass (four kinds), metal or stone corners, a podium of 2-3 storeys under half the
// tall ones (an amenity deck with a pool where the lot is deep), a crown on the tall ones (setbacks, a slanted
// glass top, a mast), an LED band round the top of most tall ones, and a podium of shops or a lobby with a
// canopy. The shell is the walls, roofs, decks, pools and crowns; the detail the rest.
function towerBuilding(P, b, f) {
  const { x0, z0, x1, z1, lb } = f, h = b.h, y0 = BASE, y1 = BASE + h, w = x1 - x0, d = z1 - z0, st = storeyFor(h, STOREY.tower);
  const cw = curtainOf(b), tint = col(pickBy(cw.tints, hash(b.id, 34)));
  const rc = col(b.roof).lerp(WHITE, 0.35), tc = col(cw.trim), trim = P.trim, opt = curtainOpt(b, st);
  // the podium, and the shaft above it, set back all round (and further at the front for a deck)
  let sx0 = x0, sz0 = z0, sx1 = x1, sz1 = z1, ys = y0;
  if (b.floors >= 14 && hash(b.id, 39) < 0.55) {
    const yp = y0 + (2 + (hash(b.id, 42) < 0.5 ? 1 : 0)) * st, ins = Math.min(3, 0.1 * Math.min(w, d));
    const deck = d >= 26 && hash(b.id, 43) < 0.7 ? Math.min(9, d * 0.3) : 0, pod = CURTAINS[hash(b.id, 44) < 0.5 ? 2 : 1];
    facadeWalls(P.curtain(pod.layer), x0, y0, z0, x1, yp, z1, col(pod.tints[0]), opt);
    flatRoof(P.roofs, x0, z0, x1, z1, yp, col('#dcd6ca'));
    parapet(trim, x0, z0, x1, z1, yp, col(pod.trim), 0.25, 1.0);
    sx0 = x0 + ins; sx1 = x1 - ins; sz0 = z0 + ins; sz1 = z1 - ins - deck; ys = yp;
    if (deck) {
      const pw = Math.min(sx1 - sx0 - 3, Math.max(8, (sx1 - sx0) * 0.55)), px = hash(b.id, 45) < 0.5 ? sx0 + 1.5 : sx1 - 1.5 - pw;
      pool(P, px, sz1 + 1.8, px + pw, z1 - 1.8, yp);
      loungers(P, px, z1 - 1.5, pw, yp, b);
    }
  }
  const sw = sx1 - sx0, sd = sz1 - sz0, crown = crownOf(b), walls = P.curtain(cw.layer), steps = crown?.steps, slant = crown?.slant;
  const yb = steps ? y1 - steps.reduce((a, t) => a + t[1], 0) * st : slant ? y1 - slant * st : y1;
  // (over a podium the shaft's walls still run on down inside it to the ground, out of sight)
  const so = { ...opt, vBase: ys, sink: UNDER + ys - y0 };
  facadeWalls(walls, sx0, ys, sz0, sx1, yb, sz1, tint, so);
  if (!slant) flatRoof(P.roofs, sx0, sz0, sx1, sz1, yb, rc);
  corners(trim, sx0, sz0, sx1, sz1, ys, yb, tc, cw.layer === L.framed ? 0.6 : 0.35, 0.08);
  const cx = (sx0 + sx1) / 2, cz = (sz0 + sz1) / 2, glowC = col(pickBy(BEACONS, hash(b.id, 46)));
  const lit = b.floors >= 18 && hash(b.id, 47) < 0.7;
  let top = y1;
  if (steps) {
    let ya = yb, prev = 0;
    for (const [share, n] of steps) {
      // (each step at least 4.8 m a side, so its walls hold whole bays; a slim shaft drops its last steps and
      // carries the rest up to the top)
      const i = Math.max(prev, Math.min(share * Math.min(sw, sd), (Math.min(sw, sd) - 4.8) / 2)), yt = ya + n * st;
      facadeWalls(walls, sx0 + i, ya, sz0 + i, sx1 - i, yt, sz1 - i, tint, { ...so, sink: 0 });
      flatRoof(P.roofs, sx0 + i, sz0 + i, sx1 - i, sz1 - i, yt, rc);
      // a ledge in the trim colour round the top of the step below
      const j = prev - 0.15;
      trim.box(sx0 + j, ya - 0.3, sz0 + j, sx1 - j, ya + 0.05, sz1 - j, tc, { bottom: true });
      ya = yt; prev = i;
    }
    const i = prev;
    parapet(trim, sx0 + i, sz0 + i, sx1 - i, sz1 - i, y1, tc, 0.3, 0.6);
    if (lit) beacon(P.beacons, sx0 + i, sz0 + i, sx1 - i, sz1 - i, y1 - 1.5, y1 - 0.3, glowC);
    // a mast with a red light for the aircraft
    trim.box(cx - 0.12, y1, cz - 0.12, cx + 0.12, y1 + 7, cz + 0.12, col('#b9bec4'));
    P.glow.box(cx - 0.2, y1 + 7, cz - 0.2, cx + 0.2, y1 + 7.4, cz + 0.2, AVIATION);
    top = y1 + 7.4;
  } else if (slant) {
    slantTop(walls, sx0, sz0, sx1, sz1, yb, y1, tint, so);
    if (lit) beacon(P.beacons, sx0, sz0, sx1, sz1, yb - 1.5, yb - 0.3, glowC);
    // the mast stands on the high back edge
    trim.box(cx - 0.12, y1 - 0.2, sz0 + 0.6, cx + 0.12, y1 + 9, sz0 + 0.84, col('#b9bec4'));
    P.glow.box(cx - 0.2, y1 + 9, sz0 + 0.52, cx + 0.2, y1 + 9.4, sz0 + 0.92, AVIATION);
    top = y1 + 9.4;
  } else {
    parapet(trim, sx0, sz0, sx1, sz1, y1, tc, 0.3, 0.7);
    if (lit) beacon(P.beacons, sx0, sz0, sx1, sz1, y1 - 1.5, y1 - 0.3, glowC);
    if (b.floors >= 8) {
      // the plant room on the roof
      trim.box(cx - sw * 0.22, y1, cz - sd * 0.2, cx + sw * 0.22, y1 + 3.2, cz + sd * 0.2, col('#c9ccd0'));
      if (h > 60) {
        trim.box(cx - 0.1, y1 + 3.2, cz - 0.1, cx + 0.1, y1 + 9, cz + 0.1, col('#b9bec4'));
        P.glow.box(cx - 0.2, y1 + 9, cz - 0.2, cx + 0.2, y1 + 9.4, cz + 0.2, AVIATION);
      }
    } else rooftop(trim, b, sx0, sz0, sx1, sz1, y1, h);
  }
  // the podium's front: shops, or a glass lobby
  const shops = b.shop ? shopRow(P, b, x0 + 0.6, x1 - 0.6, z1, y0, SHOPS_OF.tower, b.awning) : 0;
  if (!shops) {
    glassFront(P, 'lobby', x0 + 1, x1 - 1, z1, y0 + 0.05, y0 + st - 0.35, tc);
    door(trim, lb, z1 + 0.12, y0);
  }
  if (b.floors >= 12) {
    // a canopy over the entrance
    const dx = lb.door.x * S;
    trim.box(dx - 4, y0 + st - 0.1, z1, dx + 4, y0 + st + 0.15, z1 + 3.2, tc, { bottom: true });
  }
  return top;
}

// ---------- pools ----------

const POOL = col('#35b9d3'), POOL_SIDE = col('#1d7d99'), COPING = col('#f3f0e9');
// A pool on a deck or a flat roof at y (x0..z1 its water): the water a few cm over the deck (the shader's pool
// layer) inside a white coping 0.3 m wide and 7 cm high (so it stays within the roof's height for OCC); the
// coping's inner sides are detail.
function pool(P, x0, z0, x1, z1, y) {
  if (x1 - x0 < 2 || z1 - z0 < 2) return;
  const t = 0.3, yc = y + 0.07, yw = y + 0.035, m = P.mass;
  P.pools.quad([x0, yw, z0], [x0, yw, z1], [x1, yw, z1], [x1, yw, z0], undefined, POOL);
  m.box(x0 - t, y, z0 - t, x1 + t, yc, z0, COPING);
  m.box(x0 - t, y, z1, x1 + t, yc, z1 + t, COPING);
  m.box(x0 - t, y, z0, x0, yc, z1, COPING, { pz: false, nz: false });
  m.box(x1, y, z0, x1 + t, yc, z1, COPING, { pz: false, nz: false });
  const pw = P.poolWalls;
  pw.quad([x0, yw - 0.5, z0], [x1, yw - 0.5, z0], [x1, yc, z0], [x0, yc, z0], undefined, POOL_SIDE);
  pw.quad([x1, yw - 0.5, z1], [x0, yw - 0.5, z1], [x0, yc, z1], [x1, yc, z1], undefined, POOL_SIDE);
}

// loungers in a row along a pool's edge at z, facing it (detail), and a white umbrella at one end
function loungers(P, x0, z, len, y, b) {
  const n = Math.max(2, Math.min(5, Math.floor(len / 2.2))), white = col('#f6f4ef'), frame = col('#c7c2b8'), trim = P.trim;
  for (let i = 0; i < n; i++) {
    const x = x0 + (i + 0.5) * len / n;
    trim.box(x - 0.35, y, z - 0.05, x + 0.35, y + 0.32, z + 1.0, frame);
    trim.box(x - 0.32, y + 0.32, z, x + 0.32, y + 0.4, z + 0.95, white);
    trim.box(x - 0.32, y + 0.4, z + 0.75, x + 0.32, y + 0.85, z + 0.95, white);
  }
  if (hash(b.id, 57) < 0.7) {
    const ux = x0 + len - 0.8;
    trim.box(ux - 0.04, y, z + 0.4, ux + 0.04, y + 2.3, z + 0.48, frame);
    trim.geo(umbrellaGeo(), mat4(ux, y + 2.3, z + 0.44), white);
  }
}

// ---------- the Heights' glass villas ----------

const VILLA_WHITE = ['#f7f5f0', '#f2efe9', '#efece6', '#f5f1e8'];
const ROOF_GREY = col('#d3d1cb'), TEAK = col('#b8875a'), DECK = col('#a88b6e');
const VILLA_GLASS = ['#a8c8d6', '#b6d0d8', '#9cbccc', '#b0c4cc'];
// the villas' roofs (a planted sedum roof, or a dark membrane under solar panels) and the cladding of one volume
// (teak, warm oak, travertine or dark walnut)
const SEDUM = col('#7f9c50'), MEMBRANE = col('#7a7c7c'), SOLAR = col('#283550'), SKYLIGHT = col('#c3dbe4');
const CLAD = ['#8a6547', '#9d7b5c', '#d6cbb6', '#6e5442'];
// A storey of a glass villa (m); its floor slabs are 0.3 m, so two storeys and a roof slab fit 6.4 m
const VS = 3.0;

// The Heights' modern villas: white volumes under thin roof slabs, floor-to-ceiling glass that mirrors the sky
// and glows at night (the villa glass layer), a terrace of pale stone across the front with a pool and loungers,
// glass rails round the roof terraces. Three plans, from the lot's hash: an upper floor cantilevered out over the
// terrace, two crossed bars (the upper one reaching out over the pool), or a glass pavilion under one big roof
// with a white wing behind. One volume is clad in wood or stone; the walls without full glass have ribbon and
// slot windows, so the villa reads as glass from the back and the pass too; the roof terraces are teak decks
// and the top roof is planted or carries solar panels. Half are mirrored (frameOf). All of it inside the
// footprint (the camera and Kimchi stop at it).
function glassVilla(P, b, f) {
  const { x0, z0, x1, z1, lb } = f, w = x1 - x0, d = z1 - z0, mass = P.mass, trim = P.trim;
  const white = col(pickBy(VILLA_WHITE, hash(b.id, 45))), slabC = white.clone().multiplyScalar(0.96);
  const tint = col(pickBy(VILLA_GLASS, hash(b.id, 46))), stone = col('#e7e0d3'), wood = col('#9c6b43');
  const clad = col(pickBy(CLAD, hash(b.id, 54))), topRoof = hash(b.id, 53) < 0.5 ? 'green' : 'solar';
  const plan = Math.floor(hash(b.id, 41) * 3), three = b.floors >= 3;
  const g = { ...curtainOpt(b, VS), sink: 0 };
  // the deck (it runs on down into the ground, as the walls do) and the pool along the terrace
  const yd = BASE + 0.2, tz = Math.min(6.5, Math.max(5, d * 0.36)), zh = z1 - tz;
  mass.box(x0, BASE - UNDER, z0, x1, yd, z1, stone);
  const pw = Math.min(11, Math.max(7, w * 0.45)), px = hash(b.id, 48) < 0.5 ? x0 + 1.2 : x1 - 1.2 - pw;
  // teak boards round the pool, the pool in them
  const yt = yd + 0.05;
  mass.quad([px - 1, yt, zh + 0.1], [px - 1, yt, z1 - 0.3], [px + pw + 1, yt, z1 - 0.3], [px + pw + 1, yt, zh + 0.1], undefined, TEAK);
  pool(P, px, zh + 1.3, px + pw, z1 - 1.2, yt);
  loungers(P, px + 0.6, zh + 0.15, pw - 1.2, yt, b);
  // glass on one face of a volume (1 front, 2 back, 4 right, 8 left) from a to b along it and ya to yb, 2 cm
  // proud, on the storeys of the volume standing on y
  const win = (xa, za, xb, zb, face, a, c, ya, yb, y) => {
    if (c - a < 0.8) return;
    const o = { ...g, vBase: y, faces: face };
    if (face === 1) facadeWalls(P.panes, a, ya, zb - 0.5, c, yb, zb + 0.02, tint, o);
    else if (face === 2) facadeWalls(P.panes, a, ya, za - 0.02, c, yb, za + 0.5, tint, o);
    else if (face === 4) facadeWalls(P.panes, xb - 0.5, ya, a, xb + 0.02, yb, c, tint, o);
    else facadeWalls(P.panes, xa - 0.02, ya, a, xa + 0.5, yb, c, tint, o);
  };
  // the windows of a volume's walls that are not all glass: a ribbon window along the back (a clerestory high in
  // each storey), and on each side a floor-to-ceiling slot near the front and a ribbon near the back (a white
  // front gets its band of glass from its plan)
  const openings = (xa, za, xb, zb, ya, yb, glassMask) => {
    const sw = xb - xa, sd = zb - za;
    if (!(glassMask & 2) && sw > 3) win(xa, za, xb, zb, 2, xa + 0.8, xb - 0.8, ya + 1.1, Math.min(yb - 0.4, ya + VS - 0.4), ya);
    if (!(glassMask & 2) && sw > 3 && yb - ya > VS + 1.5) win(xa, za, xb, zb, 2, xa + 0.8, xb - 0.8, ya + VS + 1.1, yb - 0.4, ya);
    for (const side of [4, 8]) {
      if (glassMask & side) continue;
      win(xa, za, xb, zb, side, zb - 0.6 - Math.min(1.6, sd * 0.25), zb - 0.6, ya + 0.15, yb - 0.35, ya);
      if (sd > 7) win(xa, za, xb, zb, side, za + 0.8, za + 0.8 + Math.min(3.2, sd * 0.3), ya + 1.1, Math.min(yb - 0.4, ya + VS - 0.4), ya);
    }
  };
  // a roof at y over xa..zb: a teak terrace deck, a planted roof with a strip of deck at the front, or a dark
  // membrane under rows of solar panels with a skylight
  const roofOf = (xa, za, xb, zb, y, kind) => {
    const deck = (za2) => mass.quad([xa + 0.35, y + 0.03, za2], [xa + 0.35, y + 0.03, zb - 0.35], [xb - 0.35, y + 0.03, zb - 0.35], [xb - 0.35, y + 0.03, za2], undefined, DECK);
    if (kind === 'deck') { flatRoof(P.roofs, xa, za, xb, zb, y, ROOF_GREY); deck(za + 0.35); return; }
    if (kind === 'green') {
      flatRoof(P.roofs, xa, za, xb, zb, y, SEDUM);
      if (zb - za > 5) deck(zb - Math.min(2.4, (zb - za) * 0.3));
      return;
    }
    flatRoof(P.roofs, xa, za, xb, zb, y, MEMBRANE);
    const sx0 = xa + 0.8, sx1 = xb - Math.max(0.8, (xb - xa) * 0.35);
    for (let z = za + 0.8; z + 1.0 < zb - 0.8 && sx1 - sx0 > 1.5; z += 1.4) mass.box(sx0, y, z, sx1, y + 0.16, z + 1.0, SOLAR, { px: false, nx: false, nz: false });
    if (xb - sx1 > 2) mass.box(sx1 + 0.6, y, (za + zb) / 2 - 0.8, xb - 0.8, y + 0.22, (za + zb) / 2 + 0.8, SKYLIGHT);
  };
  // a white (or clad) volume under a thin roof slab overhanging by o; glass (mask: 1 front, 2 back, 4 right, 8
  // left) over its faces in the mask, full height, windows in the others; returns its slab's top
  const volume = (xa, za, xb, zb, ya, yb, glassMask = 0, { o = 0.3, roof = 'deck', c = white } = {}) => {
    mass.box(xa, ya, za, xb, yb, zb, c, { pz: !(glassMask & 1), nz: !(glassMask & 2), px: !(glassMask & 4), nx: !(glassMask & 8), top: false, bottom: ya > yd + 0.1 });
    if (glassMask) facadeWalls(P.panes, xa, ya, za, xb, yb, zb, tint, { ...g, vBase: ya, faces: glassMask });
    openings(xa, za, xb, zb, ya, yb, glassMask);
    mass.box(xa - o, yb, za - o, xb + o, yb + 0.3, zb + o, slabC, { bottom: true, top: false });
    roofOf(xa - o, za - o, xb + o, zb + o, yb + 0.3, roof);
    P.glow.box(xa - o + 0.1, yb - 0.04, zb + o - 0.06, xb + o - 0.1, yb + 0.02, zb + o - 0.02, LED);
    return yb + 0.3;
  };
  // a band of glass across part of a white face (front, +z) from xa to xb, ya to yb, 2 cm proud
  const band = (xa, xb, z, ya, yb) => facadeWalls(P.panes, xa, ya, z - 0.6, xb, yb, z + 0.02, tint, { ...g, vBase: ya, faces: 1 });
  // a glass balustrade round a roof terrace's open sides: panes of 1.2 m in the glass layer's rail rows (no room
  // behind them, see bCurtain), facing both ways, under a slim steel handrail (detail)
  const capC = col('#c9cdcf');
  const rail = (xa, za, xb, zb, y, sides = 15) => {
    const hgt = 1.05, v0 = -0.115, v1 = -0.01;
    const run = (ax, az, bx, bz) => {
      const u = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / 1.2)) / 16;
      const a = [ax, y, az], b2 = [bx, y, bz], c = [bx, y + hgt, bz], e = [ax, y + hgt, az];
      P.panes.quad(a, b2, c, e, [[0, v0], [u, v0], [u, v1], [0, v1]], tint);
      P.panes.quad(b2, a, e, c, [[u, v0], [0, v0], [0, v1], [u, v1]], tint);
      trim.box(Math.min(ax, bx) - 0.03, y + hgt, Math.min(az, bz) - 0.03, Math.max(ax, bx) + 0.03, y + hgt + 0.05, Math.max(az, bz) + 0.03, capC);
    };
    if (sides & 1) run(xa, zb, xb, zb);
    if (sides & 2) run(xb, za, xa, za);
    if (sides & 4) run(xb, zb, xb, za);
    if (sides & 8) run(xa, za, xa, zb);
  };
  const ia = 0.5, gx0 = x0 + ia, gx1 = x1 - ia, gz0 = z0 + ia, y1g = yd + VS;
  let top;
  if (plan === 0) {
    // glass on the ground floor's front and one side, a clad upper floor reaching 2.5 m out over the terrace
    const s1 = volume(gx0, gz0, gx1, zh, yd, y1g, 1 | (hash(b.id, 49) < 0.5 ? 4 : 8));
    const ux0 = gx0 + (gx1 - gx0) * 0.32, uz1 = Math.min(z1 - 0.4, zh + 2.5);
    top = volume(ux0, gz0 + 0.4, gx1 - 0.2, uz1, s1, s1 + VS - 0.3, 0, { roof: three ? 'deck' : topRoof, c: clad });
    band(ux0 + 0.8, gx1 - 1.2, uz1, s1 + 0.5, s1 + VS - 0.6);
    for (let x = gx1 - 1.1; x < gx1 - 0.3; x += 0.2) trim.box(x, s1 + 0.4, uz1, x + 0.1, s1 + VS - 0.7, uz1 + 0.1, wood);
    rail(gx0, gz0, ux0, zh, s1, 1 | 8 | 2);
    if (three) {
      const t1 = volume(ux0 + 1, gz0 + 0.8, ux0 + 1 + (gx1 - ux0) * 0.5, gz0 + 0.8 + (zh - gz0) * 0.6, top, top + VS - 0.3, 1, { roof: topRoof });
      rail(ux0, gz0 + 0.4, gx1 - 0.2, uz1, top, 1 | 4);
      top = t1;
    }
  } else if (plan === 1) {
    // a long glass-fronted bar below, a clad bar across it above reaching out over the pool, glazed at its end
    const s1 = volume(gx0, gz0, gx1, zh, yd, y1g, 1);
    const bw = Math.min(9, (gx1 - gx0) * 0.42), bx0 = px + pw / 2 - bw / 2 < gx0 ? gx0 : Math.min(gx1 - bw, px + pw / 2 - bw / 2);
    const bz1 = z1 - 0.6;
    top = volume(bx0, gz0 + 0.3, bx0 + bw, bz1, s1, s1 + VS - 0.3, 1, { roof: three ? 'deck' : topRoof, c: clad });
    rail(gx0, gz0, bx0, zh, s1, 1 | 2 | 8);
    rail(bx0 + bw, gz0, gx1, zh, s1, 1 | 2 | 4);
    if (three) top = volume(bx0 + 0.6, gz0 + 0.8, bx0 + bw - 0.6, gz0 + 0.8 + (zh - gz0) * 0.55, top, top + VS - 0.3, 1, { roof: topRoof });
  } else {
    // a glass pavilion one and a half storeys tall under a big slab (a teak roof terrace), a clad wing behind it
    // on one side
    const ph = Math.min(4.6, b.h - 1.2), right = hash(b.id, 49) < 0.5, ww = (gx1 - gx0) * 0.36;
    const wx0 = right ? gx1 - ww : gx0, wz1 = gz0 + (zh - gz0) * 0.75;
    const wing = volume(wx0, gz0, wx0 + ww, wz1, yd, yd + (three ? 3 : 2) * VS - 0.6, 0, { roof: topRoof, c: clad });
    band(wx0 + 0.6, wx0 + ww - 0.6, wz1, yd + VS + 0.2, yd + 2 * VS - 0.9);
    const vx0 = right ? gx0 + 0.7 : wx0 + ww, vx1 = right ? wx0 : gx1 - 0.7, vz0 = gz0 + 0.7, vz1 = zh - 0.6;
    mass.box(vx0, yd, vz0, vx1, yd + ph, vz1, white, { pz: false, px: right, nx: !right, top: false });
    facadeWalls(P.panes, vx0, yd, vz0, vx1, yd + ph, vz1, tint, { ...g, storey: ph, vBase: yd, faces: right ? 1 | 8 : 1 | 4 });
    win(vx0, vz0, vx1, vz1, 2, vx0 + 0.8, vx1 - 0.8, yd + 1.1, yd + ph - 0.5, yd);
    mass.box(vx0 - 0.6, yd + ph, gz0 + 0.1, vx1 + 0.6, yd + ph + 0.45, zh + 0.6, slabC, { bottom: true, top: false });
    roofOf(vx0 - 0.6, gz0 + 0.1, vx1 + 0.6, zh + 0.6, yd + ph + 0.45, 'deck');
    P.glow.box(vx0 - 0.5, yd + ph - 0.04, zh + 0.54, vx1 + 0.5, yd + ph + 0.02, zh + 0.58, LED);
    rail(vx0 - 0.5, gz0 + 0.2, vx1 + 0.5, zh + 0.5, yd + ph + 0.45, right ? 1 | 8 : 1 | 4);
    top = Math.max(wing, yd + ph + 0.45);
  }
  // the front door: a tall pivot door of dark wood
  const dx = lb.door.x * S, dz = plan === 2 ? zh - 0.6 : zh;
  trim.box(dx - 0.65, yd, dz, dx + 0.65, yd + 2.7, dz + 0.08, col('#3a2a20'));
  trim.box(dx + 0.3, yd + 1.0, dz + 0.08, dx + 0.36, yd + 1.8, dz + 0.14, col('#d8c08a'));
  // planters of clipped green along the terrace's edge, and lights in the deck at night
  const hedge = col('#4f7a3c');
  for (const xa of [x0 + 0.3, x1 - 1.1]) trim.box(xa, yd, z1 - 0.9, xa + 0.8, yd + 0.7, z1 - 0.3, hedge);
  for (let x = x0 + 1.5; x < x1 - 1; x += 3) P.glow.box(x - 0.08, yd, z1 - 0.25, x + 0.08, yd + 0.04, z1 - 0.15, LED);
  return top;
}

// ---------- the Gables ----------

// The Gables (and Star Island): Mediterranean Revival. Warm stucco on the Mediterranean facade (tall arched
// windows, iron balconettes, a spindle reja, striped awnings), low hip or gable roofs of terracotta barrel tiles
// with wide eaves, on some two-storey houses (and every Star Island estate) a tower at a front corner under its
// own tiled pyramid, and close by an arched cast-stone entry round the door and a chimney with a tiled cap.
function houseBuilding(P, b, f) {
  const { x0, z0, x1, z1, lb } = f, h = b.h, y0 = BASE, y1 = BASE + h, w = x1 - x0, d = z1 - z0;
  const st = storeyFor(h, STOREY.house), wc = col(b.wall), rc = col(b.roof), trim = P.trim;
  const opt = { storey: st, uOffs: uOffsOf(b), vOff: vOffOf(b) };
  facadeWalls(P.wall('house'), x0, y0, z0, x1, y1, z1, wc, opt);
  // the corner tower: one storey over the eaves on a 3.4 m square, under its own pyramid (its walls go in before
  // any roof, so every facade wall is a whole quad in order)
  const estate = b.style === 'mansion', tower = (b.floors >= 2 && hash(b.id, 50) < 0.4) || (estate && w >= 8);
  const ts = 3.4, tx0 = hash(b.id, 51) < 0.5 ? x1 - ts : x0, tz0 = z1 - ts;
  if (tower) facadeWalls(P.wall('house'), tx0, y1, tz0, tx0 + ts, y1 + st, z1, wc, { ...opt, vBase: y0, sink: 0 });
  const hip = hash(b.id, 49) < 0.6;
  let top = hip ? hipRoof(P.houseRoofs, x0, z0, x1, z1, y1, rc, 0.7, 0.27 * Math.min(w, d))
    : gableRoof(P.houseRoofs, P.mass, x0, z0, x1, z1, y1, rc, wc, 0.3, 0.6);
  if (tower) top = Math.max(top, hipRoof(P.houseRoofs, tx0, tz0, tx0 + ts, z1, y1 + st, rc, 0.45, 1.5));
  // the chimney with a little tiled cap
  if (hash(b.id, 31) < 0.6) {
    const cx = x0 + w * 0.72, cz = z0 + d * 0.3;
    trim.box(cx - 0.35, y1, cz - 0.35, cx + 0.35, top - 0.2, cz + 0.35, wc.clone().multiplyScalar(0.92));
    trim.box(cx - 0.5, top - 0.2, cz - 0.5, cx + 0.5, top, cz + 0.5, rc);
  }
  // the door: a plank door of dark wood with iron studs (no flat hood: the arch is its frame)
  const dx = lb.door.x * S;
  trim.box(dx - 0.75, y0, z1, dx + 0.75, y0 + 2.6, z1 + 0.06, col('#5a3a26'));
  for (const sx of [-0.4, 0, 0.4]) trim.box(dx + sx - 0.03, y0 + 0.2, z1 + 0.06, dx + sx + 0.03, y0 + 2.4, z1 + 0.09, col('#3e2818'));
  trim.box(dx + 0.45, y0 + 1.05, z1 + 0.06, dx + 0.55, y0 + 1.2, z1 + 0.12, IRON);
  archedEntry(trim, dx, z1, y0, col('#efe3cb'));
  return top;
}

// An arched cast-stone surround round a door at x on the wall z: two pilasters and a round arch over the door,
// with a keystone, standing 12 cm proud; a dark fanlight fills the arch.
function archedEntry(trim, x, z, y0, stone) {
  const r0 = 0.9, r1 = 1.25, yc = y0 + 2.6, n = 8, zf = z + 0.12;
  trim.box(x - r1, y0, z, x - r0, yc, zf, stone);
  trim.box(x + r0, y0, z, x + r1, yc, zf, stone);
  const pt = (r, a) => [x + Math.cos(a) * r, yc + Math.sin(a) * r, zf];
  for (let i = 0; i < n; i++) {
    const a = Math.PI * i / n, c = Math.PI * (i + 1) / n;
    trim.quad(pt(r0, a), pt(r1, a), pt(r1, c), pt(r0, c), undefined, stone);
    trim.tri([x, yc, z + 0.07], pt(r0 - 0.02, a).map((v, k) => (k === 2 ? z + 0.07 : v)), pt(r0 - 0.02, c).map((v, k) => (k === 2 ? z + 0.07 : v)), undefined, FANLIGHT);
  }
  trim.box(x - 0.16, yc + r0 - 0.05, z, x + 0.16, yc + r1 + 0.1, zf + 0.04, stone);
}

// Collins Avenue: the resorts' white balcony bands floor over floor (front and back), fins at their ends, a
// glass lobby under a porte-cochère with the hotel's name, and the name again up on the roof.
function resortBuilding(P, b, f) {
  const { x0, z0, x1, z1, lb } = f, h = b.h, y0 = BASE, y1 = BASE + h, st = storeyFor(h, STOREY.resort);
  const wc = col(b.wall), tc = col(b.trim || '#7fd1c7'), white = col('#f7f5ef'), trim = P.trim;
  facadeWalls(P.wall('resort'), x0, y0, z0, x1, y1, z1, wc, { storey: st, uOffs: uOffsOf(b), vOff: vOffOf(b) });
  flatRoof(P.roofs, x0, z0, x1, z1, y1, hash(b.id, 70) < 0.4 ? col('#e6dfd2') : col(b.roof));
  // the balconies, front and back: a slab and its solid white rail on every floor (part of the shell: the bands
  // are what makes these hotels from across the bay), with an accent line along the front slabs' edge
  const floors = Math.round(h / st), bx0 = x0 + 0.4, bx1 = x1 - 0.4, mass = P.mass;
  for (let k = 1; k < floors; k++) {
    const y = y0 + k * st;
    mass.box(bx0, y - 0.2, z1, bx1, y, z1 + 1.4, white, { bottom: true, nz: false });
    mass.box(bx0, y, z1 + 1.25, bx1, y + 1.0, z1 + 1.4, white);
    trim.box(bx0, y - 0.2, z1 + 1.4, bx1, y - 0.06, z1 + 1.44, tc);
    mass.box(bx0, y - 0.2, z0 - 1.4, bx1, y, z0, white, { bottom: true, pz: false });
    mass.box(bx0, y, z0 - 1.4, bx1, y + 1.0, z0 - 1.25, white);
  }
  for (const [za, zb] of [[z1, z1 + 1.6], [z0 - 1.6, z0]]) for (const x of [x0 + 0.1, x1 - 0.35]) trim.box(x, y0 + st - 0.2, za, x + 0.25, y1, zb, white);
  parapet(trim, x0, z0, x1, z1, y1, white, 0.3, 0.9);
  // the lobby and its porte-cochère
  const dx = lb.door.x * S, name = HOTELS[hotelOf.get(b.id) ?? Math.floor(hash(b.id, 33) * HOTELS.length)];
  if (!(b.shop && shopRow(P, b, x0 + 0.6, x1 - 0.6, z1, y0, SHOPS_OF.resort, b.awning))) glassFront(P, 'lobby', x0 + 1, x1 - 1, z1, y0 + 0.05, y0 + st - 0.35, white);
  door(trim, lb, z1 + 0.12, y0);
  trim.box(dx - 5, y0 + 3.9, z1, dx + 5, y0 + 4.3, z1 + 4.5, white, { bottom: true });
  trim.box(dx - 5, y0 + 4.3, z1 + 4.1, dx + 5, y0 + 5.2, z1 + 4.5, tc);
  for (const x of [dx - 4.6, dx + 4.6]) trim.box(x - 0.15, y0, z1 + 3.8, x + 0.15, y0 + 3.9, z1 + 4.1, white);
  addSign(P, name[0], name[1], dx, y0 + 4.75, z1 + 4.52, 3.4, 0.85);
  // the name on the roof, on two posts, facing the front
  const sw = Math.min((x1 - x0) * 0.7, 18), sh = sw / 4, sy = y1 + 1.2;
  for (const x of [-sw * 0.3, sw * 0.3]) trim.box(x - 0.12, y1, z1 - 2.2, x + 0.12, sy + 0.2, z1 - 1.96, col('#9aa0a3'));
  trim.box(-sw / 2, sy, z1 - 2.0, sw / 2, sy + sh, z1 - 1.8, col('#2a2a2e'));
  addSign(P, name[0], name[1], 0, sy + sh / 2, z1 - 1.78, sw, sh);
  // up on the roof (after the names, which the tests read first): a pool deck at the back with loungers and cabanas on most, a helipad on some tall ones
  const rw = x1 - x0, rd = z1 - z0;
  if (hash(b.id, 71) < 0.6 && rw >= 16 && rd >= 14) {
    const pw = Math.min(14, rw * 0.5), pd = Math.min(6, rd * 0.3), px = hash(b.id, 72) < 0.5 ? x0 + 2 : x1 - 2 - pw;
    pool(P, px, z0 + 1.8, px + pw, z0 + 1.8 + pd, y1);
    loungers(P, px, z0 + 2.2 + pd, pw, y1, b);
    const cx = px > x0 + 3 ? x0 + 1.2 : x1 - 3.6;
    for (let i = 0; i < 2; i++) {
      const cz = z0 + 1.5 + i * 3;
      for (const [dx, dz] of [[0, 0], [2.2, 0], [0, 2.2], [2.2, 2.2]]) P.trim.box(cx + dx, y1, cz + dz, cx + dx + 0.12, y1 + 2.4, cz + dz + 0.12, white);
      awningRow(P, b.trim || '#7fd1c7').quad([cx, y1 + 2.4, cz], [cx, y1 + 2.4, cz + 2.32], [cx + 2.32, y1 + 2.4, cz + 2.32], [cx + 2.32, y1 + 2.4, cz], [[0, 0], [0, 1], [4, 1], [4, 0]]);
    }
  } else if (b.floors >= 14 && hash(b.id, 73) < 0.6) {
    helipad(P, (x0 + x1) / 2, z0 + Math.min(rd / 2, 8), y1, Math.min(12, rw * 0.5, rd * 0.6));
  }
}

// The Port: candy-coloured sheds with strip windows, roll-up loading doors under a canopy, and roof vents.
function warehouseBuilding(P, b, f) {
  const { x0, z0, x1, z1, lb } = f, h = b.h, y0 = BASE, y1 = BASE + h, w = x1 - x0, trim = P.trim;
  const wc = col(b.wall), tc = col(b.trim || '#f6f4ee'), dark = col('#3a3f44'), slat = col('#c9ccd0');
  facadeWalls(P.wall('warehouse'), x0, y0, z0, x1, y1, z1, wc, { storey: storeyFor(h, STOREY.warehouse), uOffs: uOffsOf(b), vOff: vOffOf(b) });
  flatRoof(P.roofs, x0, z0, x1, z1, y1, col(hash(b.id, 74) < 0.5 ? pickBy(SHED_ROOFS, hash(b.id, 75)) : b.roof).lerp(WHITE, 0.25));
  // rows of skylights along the roof (in the shell: they are what the sheds show from the hills)
  const sky = col('#cfe2ea');
  for (let x = x0 + 4; x < x1 - 4; x += 6) P.mass.quad([x, y1 + 0.06, z0 + 3], [x, y1 + 0.06, z1 - 3], [x + 1.4, y1 + 0.06, z1 - 3], [x + 1.4, y1 + 0.06, z0 + 3], undefined, sky);
  parapet(trim, x0, z0, x1, z1, y1, tc, 0.3, 0.8);
  corners(trim, x0, z0, x1, z1, y0, y1, tc, 0.45, 0.06);
  // loading doors either side of the people's door
  const dx = lb.door.x * S, n = Math.max(1, Math.floor((w - 6) / 7.5)), dw = 4.4, dh = Math.min(4.4, h - 0.6);
  for (let i = 0; i < n; i++) {
    const cx = x0 + (i + 0.5) * w / n;
    if (Math.abs(cx - dx) < dw / 2 + 1.4) continue;
    trim.box(cx - dw / 2 - 0.2, y0, z1, cx + dw / 2 + 0.2, y0 + dh + 0.2, z1 + 0.06, dark);
    for (let y = y0 + 0.1; y < y0 + dh - 0.1; y += 0.34) trim.box(cx - dw / 2, y, z1 + 0.06, cx + dw / 2, y + 0.28, z1 + 0.1, slat);
  }
  trim.box(x0 + 0.5, y0 + dh + 0.4, z1, x1 - 0.5, y0 + dh + 0.6, z1 + 2.2, tc, { bottom: true });
  door(trim, lb, z1, y0, '#2a2f34');
  for (let i = 0; i < 3; i++) {
    if (hash(b.id, 80 + i) < 0.35) continue;
    const vx = x0 + 3 + hash(b.id, 83 + i) * (w - 6), vz = z0 + 3 + hash(b.id, 86 + i) * (z1 - z0 - 6);
    trim.geo(ventGeo(), mat4(vx, y1 + 0.5, vz), col('#b9bec4'));
  }
}

// The Fest's hangars: walls to the eaves, a barrel roof across the span, giant sliding doors on the front.
function hangarBuilding(P, b, f) {
  const { x0, z0, x1, z1, lb } = f, h = b.h, y0 = BASE, w = x1 - x0, ye = y0 + h * 0.72, yr = y0 + h;
  const wc = col(b.wall), rc = col(b.roof).lerp(WHITE, 0.2), trim = P.trim, mass = P.mass;
  facadeWalls(P.wall('warehouse'), x0, y0, z0, x1, ye, z1, wc, { storey: storeyFor(ye - y0, 3.2), uOffs: uOffsOf(b), vOff: vOffOf(b) });
  // the arc: 10 strips from eave to eave, and the end walls under it
  const n = 10, o = 0.3, arc = (t) => [x0 - o + (w + 2 * o) * t, ye + (yr - ye) * (1 - (2 * t - 1) ** 2)];
  for (let i = 0; i < n; i++) {
    const [xa, ya] = arc(i / n), [xb, yb] = arc((i + 1) / n);
    mass.quad([xa, ya, z1 + o], [xb, yb, z1 + o], [xb, yb, z0 - o], [xa, ya, z0 - o], undefined, rc);
    const xc = Math.min(Math.max(xa, x0), x1), xd = Math.min(Math.max(xb, x0), x1);
    if (xd - xc < 1e-3) continue;
    mass.quad([xc, ye, z1], [xd, ye, z1], [xd, yb, z1], [xc, ya, z1], undefined, wc);
    mass.quad([xd, ye, z0], [xc, ye, z0], [xc, ya, z0], [xd, yb, z0], undefined, wc);
  }
  // the doors: four sliding leaves with their seams, a lintel over them
  const dx0 = x0 + 1.5, dx1 = x1 - 1.5, dh = ye - y0 - 1.2, leaf = (dx1 - dx0) / 4;
  for (let i = 0; i < 4; i++) {
    const xa = dx0 + i * leaf;
    trim.box(xa + 0.04, y0, z1, xa + leaf - 0.04, y0 + dh, z1 + 0.18, col(i % 2 ? '#c9ccd0' : '#bfc3c8'));
    for (let y = y0 + 1.2; y < y0 + dh; y += 1.6) trim.box(xa + 0.2, y, z1 + 0.18, xa + leaf - 0.2, y + 0.08, z1 + 0.22, col('#9aa0a6'));
  }
  trim.box(x0 + 1, y0 + dh, z1, x1 - 1, y0 + dh + 0.5, z1 + 0.3, col('#4a4f55'));
  if (b.sign) addSign(P, b.sign, { bg: '#101012', fg: 'gold', serif: true, sub: 'PRIVATE TERMINAL', size: 74 }, lb.door.x * S, (ye + yr) / 2, z1 + 0.06, 9, 1.8);
}

// Kimchi Tower's shell (its LED crown is the landmarks'): the glass prism, white fins up every face, a
// two-storey lobby with a gold canopy and the tower's name.
function kimchiTower(P, b, f) {
  const { x0, z0, x1, z1, lb } = f, h = b.h, y0 = BASE, y1 = BASE + h, st = storeyFor(h, STOREY.tower);
  const wc = col(b.wall), white = col('#f4f1ea'), trim = P.trim;
  facadeWalls(P.wall('tower'), x0, y0, z0, x1, y1, z1, wc, { storey: st, uOffs: uOffsOf(b), vOff: vOffOf(b) });
  flatRoof(P.roofs, x0, z0, x1, z1, y1, col(b.roof).lerp(WHITE, 0.3));
  corners(trim, x0, z0, x1, z1, y0, y1, white, 0.9, 0.15);
  for (let k = 1; k < 4; k++) {
    const t = x0 + (x1 - x0) * k / 4, s = z0 + (z1 - z0) * k / 4;
    trim.box(t - 0.2, y0 + 2 * st, z1, t + 0.2, y1, z1 + 0.6, white);
    trim.box(t - 0.2, y0 + 2 * st, z0 - 0.6, t + 0.2, y1, z0, white);
    trim.box(x1, y0 + 2 * st, s - 0.2, x1 + 0.6, y1, s + 0.2, white);
    trim.box(x0 - 0.6, y0 + 2 * st, s - 0.2, x0, y1, s + 0.2, white);
  }
  parapet(trim, x0, z0, x1, z1, y1, white, 0.4, 1.2);
  const dx = lb.door.x * S;
  glassFront(P, 'lobby', x0 + 1.4, x1 - 1.4, z1, y0 + 0.05, y0 + st - 0.35, white);
  door(trim, lb, z1 + 0.12, y0, '#1b1b1d');
  const yc = y0 + st;
  P.gold.box(dx - 7, yc, z1, dx + 7, yc + 0.3, z1 + 5);
  trim.box(dx - 4.7, yc + 0.3, z1 + 4.78, dx + 4.7, yc + 2.25, z1 + 4.9, col('#101012'));
  addSign(P, 'KIMCHI TOWER', { bg: '#101012', fg: 'gold', serif: true, sub: '김치 타워 · KIMCHI KEY', size: 72 }, dx, yc + 1.25, z1 + 4.92, 9, 1.8);
}

// One building's parts, by what it is: a place (the grid's code), Kimchi Tower, or its region style.
function parts(P, b, f) {
  if (b.place) return placeBuilding(P, b, f);
  if (b.landmark === 'kimchi_tower') return kimchiTower(P, b, f);
  switch (b.style) {
    case 'deco': return decoBuilding(P, b, f);
    case 'ktown': return ktownBuilding(P, b, f);
    case 'tower': return towerBuilding(P, b, f);
    case 'resort': return resortBuilding(P, b, f);
    case 'house': case 'estate': case 'shack': return houseBuilding(P, b, f);
    case 'mansion': return b.house ? houseBuilding(P, b, f) : glassVilla(P, b, f);
    case 'warehouse': return warehouseBuilding(P, b, f);
    case 'hangar': return hangarBuilding(P, b, f);
    default: return decoBuilding(P, b, f);
  }
}

// ---------- the material ----------

const lamps = { value: true };           // whether any lamp, headlight or police light is on (see tick)
const night = { value: 0 };              // 0 by day to 1 at night
let M = null;                            // { material, color, lit, rough, rects }

// three's direct-lighting chunk with its point- and spot-light loops run only while a lamp is on (a uniform,
// so switching costs nothing): by day the buildings skip them (terrain3d's lampGate does the same for the
// ground). If the chunk is not the shape this expects (a newer three), it is left as it is.
function lampGate(chunk) {
  const P = '#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )\n', Sp = '#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )\n';
  const D = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )\n', END = '\t#pragma unroll_loop_end\n#endif\n';
  const p = chunk.indexOf(P), sp = chunk.indexOf(Sp), d = chunk.indexOf(D);
  if (p < 0 || sp < p || d < sp || chunk.slice(sp - END.length, sp) !== END || chunk.slice(d - END.length, d) !== END) return chunk;
  const gate = (body) => body.slice(0, -'#endif\n'.length).replace(/^(#if[^\n]*\n)/, '$1if ( uKcLamps ) {\n') + '}\n#endif\n';
  return chunk.slice(0, p) + gate(chunk.slice(p, sp)) + gate(chunk.slice(sp, d)) + chunk.slice(d);
}

// The shader-drawn layers (see L), as GLSL put in just before main(). Curtain walls take the facade coordinates
// facadeWalls gives every wall (u: 8 bays of 3 m a unit, v: 8 storeys), so the grid lines up with the floors and
// the corners as the painted facades do; kind 0 is sleek glass in a fine grid, 1 ribbon windows between white
// spandrel bands, 2 glass between stone piers, 3 bronze glass, 4 a villa's floor-to-ceiling glass. The vertex
// colour is the glass tint. Every line is filtered by its size on screen (fwidth), and a pane smaller than a few
// pixels fades to its average, so a tower across the bay is smooth glass with faint floor lines, not window noise.
// At night whole floors are lit (offices in pairs of floors, a villa nearly all), with a few lone lit panes.
const SHADER_LAYERS = `
varying vec3 vBPos;
float bOwn, bRgh, bMet;
vec3 bEmit;
float bHash( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}
// a line of half-width w (in cell units) along a cell's edges, and a band from y0 to y1 across it, each antialiased
// by the cell's size on screen fw, and their average once the cell is under a few pixels
float bLine( float f, float w, float fw ) {
	float d = min( f, 1.0 - f );
	return mix( 1.0 - smoothstep( w - fw, w + fw, d ), 2.0 * w, smoothstep( 0.16, 0.4, fw ) );
}
float bBand( float f, float y0, float y1, float fw ) {
	return mix( smoothstep( y0 - fw, y0 + fw, f ) - smoothstep( y1 - fw, y1 + fw, f ), clamp( y1, 0.0, 1.0 ) - y0, smoothstep( 0.16, 0.4, fw ) );
}
void bCurtain( int k, inout vec3 col ) {
	vec3 tint = vColor;
	// a glass balustrade's panes are rows under the sheet (v below 0): no room behind them, no blinds
	float rail = step( vBUv.y, 0.0 );
	vec2 c = vBUv * 8.0;
	vec2 p = vec2( c.x * ( k == 2 ? 1.0 : 2.0 ), c.y ), f = fract( p ), id = floor( p ), fw = fwidth( p );
	// how far under a few pixels a pane is across and up: the touches of a single pane fade by the larger, those
	// of a floor by its height alone, so a wall seen edge on keeps its floors
	float farX = smoothstep( 0.12, 0.4, fw.x ), farY = smoothstep( 0.12, 0.4, fw.y ), far = max( farX, farY );
	// the glass band of a storey (under it the spandrel, or the stone, or a villa's floor slab) and the mullions
	float g0 = k == 1 ? 0.34 : k == 2 ? 0.15 : k == 3 ? 0.09 : k == 4 ? 0.035 : 0.11;
	float glass = bBand( f.y, g0, k == 1 ? 0.93 : 2.0, fw.y );
	float mul = bLine( f.x, k == 3 ? 0.035 : k == 4 ? 0.018 : k == 2 ? 0.012 : 0.026, fw.x );
	float pier = k == 2 ? bLine( fract( f.x + 0.5 ), 0.085, fw.x ) : 0.0;
	if ( k == 2 ) mul = mul * ( 1.0 - pier );
	float pane = glass * ( 1.0 - mul ) * ( 1.0 - pier ), frame = glass * mul, solid = 1.0 - pane - frame;
	vec3 cMul = k == 3 ? vec3( 0.24, 0.18, 0.12 ) : k == 4 ? vec3( 0.07 ) : k == 0 ? vec3( 0.36, 0.39, 0.43 ) : vec3( 0.7, 0.73, 0.76 );
	vec3 cSolid = k == 1 ? vec3( 0.9, 0.89, 0.86 ) : k == 2 ? vec3( 0.86, 0.83, 0.77 ) : k == 4 ? vec3( 0.08 ) : tint * vec3( 0.2, 0.21, 0.24 );
	float r1 = bHash( id ), r2 = bHash( id + 41.7 ), r3 = bHash( id + 13.1 );
	// a pane's own shade, or once the panes run together across, its floor's
	float rr = mix( r1, bHash( vec2( id.y, 9.1 ) ), farX ), fy = mix( f.y, 0.5, farY );
	float sweep = 0.5 + 0.5 * sin( ( vBPos.x + vBPos.z ) * 0.035 + vBPos.y * 0.02 ) * sin( ( vBPos.x - vBPos.z ) * 0.023 - vBPos.y * 0.045 + 1.3 );
	// what a pane mirrors (drawn here rather than left to the sky map, so it reads at any distance and on the low
	// tier): the sky in the haze colour, deeper toward the zenith, and under the horizon the town and the ground as
	// a darker band; each pane at its own tiny tilt, so the horizon breaks from pane to pane as on a real tower
#ifdef USE_FOG
	vec3 bSky = fogColor;
#else
	vec3 bSky = vec3( 0.72, 0.82, 0.92 );
#endif
	vec3 nW = normalize( cross( dFdx( vBPos ), dFdy( vBPos ) ) ), vW = normalize( vBPos - cameraPosition );
	if ( dot( nW, vW ) > 0.0 ) nW = -nW;
	vec3 rW = reflect( vW, nW );
	float up = rW.y + ( 1.0 - farY ) * ( rr - 0.5 ) * 0.14 + ( sweep - 0.5 ) * 0.12;
	vec3 sky = mix( bSky * 0.85, bSky * vec3( 0.4, 0.6, 0.92 ), smoothstep( 0.0, 0.5, up ) );
	// and the sky's glare round the sun, in the sun's colour: broad, so a wall turned to it brightens across its
	// width and one turned away stays deep (the sun is the first directional light)
#if NUM_DIR_LIGHTS > 0
	vec3 sunW = normalize( ( vec4( directionalLights[ 0 ].direction, 0.0 ) * viewMatrix ).xyz );
	sky += directionalLights[ 0 ].color * 0.07 * pow( max( dot( rW, sunW ), 0.0 ), 3.0 ) * step( 0.0, up );
#endif
	vec3 town = mix( bSky * vec3( 0.56, 0.6, 0.62 ), bSky * vec3( 0.34, 0.38, 0.36 ), smoothstep( -0.04, -0.5, up ) );
	// and the other towers round it: a skyline of blocks of their own heights and shades, by the bearing mirrored
	float slot = floor( atan( rW.z, rW.x ) * 6.0 );
	float sH = mix( -0.02 + 0.45 * bHash( vec2( slot, 3.1 ) ) * bHash( vec2( slot, 8.9 ) ), 0.06, smoothstep( 0.3, 0.8, fw.y ) );
	vec3 blk = bSky * mix( 0.5, 0.86, bHash( vec2( slot, 5.3 ) ) );
	vec3 refl = mix( mix( town, blk, smoothstep( -0.06, -0.02, up ) ), sky, smoothstep( sH - 0.01, sH + 0.01, up ) );
	float fres = ( k == 3 ? 0.44 : 0.32 ) + 0.68 * pow( 1.0 - abs( dot( nW, vW ) ), 3.0 );
	// and the cartoon glass's shine: two diagonal streaks across a pane, at its own place on each
	float sx = f.x * ( k == 2 ? 3.0 : 1.5 ) + f.y * 1.8 - 0.4 - 1.6 * r2;
	float shine = ( 1.0 - far ) * ( 0.22 * ( smoothstep( 0.0, 0.03, sx ) - smoothstep( 0.18, 0.21, sx ) ) + 0.16 * ( smoothstep( 0.3, 0.32, sx ) - smoothstep( 0.37, 0.39, sx ) ) );
	// (champagne glass only warms what it mirrors, or it reads as khaki)
	vec3 mirror = ( refl * fres + shine * bSky ) * mix( vec3( 1.0 ), tint * 1.3, k == 3 ? 0.5 : 0.55 );
	// behind the glass the room is dark (a villa's warm and seen through; a balustrade shows the deck behind it);
	// some panes have their blinds down (a villa its sheer curtains)
	vec3 cGlass = k == 4 ? mix( tint, vec3( 0.78, 0.6, 0.42 ), 0.5 ) * ( 0.2 + 0.08 * r1 ) * ( 0.75 + 0.35 * f.y ) : tint * ( 0.16 + 0.08 * sweep + ( 1.0 - farY ) * 0.06 * ( rr - 0.5 ) ) * ( 0.85 + 0.3 * fy ) * ( k == 3 ? 1.4 : 1.0 );
	cGlass = mix( cGlass, tint * 0.3, rail );
	float drop = 0.25 + 0.5 * r3;
	float bl = ( 1.0 - far ) * ( 1.0 - rail ) * step( r2, k == 4 ? 0.35 : 0.14 ) * smoothstep( 1.0 - drop - fw.y, 1.0 - drop + fw.y, f.y );
	cGlass = mix( cGlass, k == 4 ? vec3( 0.9, 0.87, 0.8 ) : tint * vec3( 0.62, 0.62, 0.6 ) + 0.12, bl * 0.8 );
	if ( k == 4 ) mirror *= 0.85;
	col = pane * cGlass + frame * cMul + solid * cSolid;
	bool matt = k == 1 || k == 2;
	bRgh = pane * mix( 0.08 + 0.12 * r1 * ( 1.0 - far ), 0.6, bl ) + frame * 0.35 + solid * ( matt ? 0.8 : 0.25 );
	bMet = pane * mix( 0.1, 0.0, bl ) + frame * 0.6 + solid * ( matt ? 0.0 : 0.2 );
	vec3 day = ( pane * ( 1.0 - 0.85 * bl ) + ( matt ? 0.0 : 0.5 * solid ) ) * mirror * ( k == 4 ? 0.8 : 1.0 );
	// a villa's rooms, seen through its glass, are lit by the day through the other walls, not by this one's light
	if ( k == 4 ) day += pane * ( 1.0 - bl ) * ( 1.0 - rail ) * vec3( 0.09, 0.065, 0.04 ) * ( 0.6 + 0.4 * f.y ) * ( 1.0 - uBNight );
	// the night: the rooms are lit in blocks of one and a half bays by two floors (shifted floor pair by floor
	// pair): a block is a busy office (most of its rooms lit) or a dark one (a lone lit room here and there),
	// busy more often on a few floor pairs, so the lit rooms gather in patches and most of a tower is dark (a villa
	// is lit nearly all through); warm or office white block by block. Farther off a block glows by its share, and
	// once the blocks are under a few pixels the tower by the average.
	float fl = id.y, fp = floor( fl * 0.5 );
	float bk = floor( ( id.x + 7.0 * bHash( vec2( fp, 4.4 ) ) ) / 3.0 ), hb = bHash( vec2( fp, bk ) + 19.3 );
	float occ = k == 4 ? 0.85 : hb < 0.07 + 0.27 * pow( bHash( vec2( fp, 7.7 ) ), 2.0 ) ? 0.75 : 0.04;
	float lit = step( r3, occ ) * ( 0.7 + 0.3 * r1 );
	lit = mix( lit, occ * 0.85, far );
	float blur = max( smoothstep( 0.2, 0.45, fw.y ), smoothstep( 0.5, 1.2, fw.x ) );
	lit = mix( lit, k == 4 ? 0.72 : 0.13, blur ) * ( 1.0 - rail );
	vec3 room = k == 4 || bHash( vec2( fp, bk ) + 2.3 ) < 0.6 ? vec3( 1.0, 0.76, 0.48 ) : vec3( 0.84, 0.92, 1.0 );
	room = mix( room, k == 4 ? room : vec3( 0.94, 0.82, 0.68 ), blur );
	float bCeil = 0.5 + 0.5 * smoothstep( g0, 1.0, fy );
	bEmit = day + pane * lit * room * bCeil * mix( 1.0, 0.7, bl ) * uBNight * ( k == 4 ? 0.62 : 1.05 );
}
// pool water: the vertex colour's blue (darker down its walls), with a caustic net that brightens it, and its
// underwater lights at night
void bPool( inout vec3 col ) {
	vec2 q = vBPos.xz;
	float wv = sin( q.x * 1.9 + sin( q.y * 1.3 ) * 1.6 ) * sin( q.y * 2.2 + sin( q.x * 1.1 ) * 1.5 );
	float caus = pow( 0.5 + 0.5 * wv, 4.0 );
	col = vColor * mix( 0.85, 1.3, caus );
	bRgh = 0.05; bMet = 0.2;
	bEmit = vColor * ( 0.1 + uBNight * ( 0.55 + 0.45 * caus ) );
}
`;

// The buildings' material: MeshStandard (Lambert on the low tier) with vertex colours, whose map, glow,
// roughness and metalness come from the layer stacks by each vertex's layer, or from the shader for the layers
// it draws (SHADER_LAYERS). Decals (shop fronts, signs, glass, LEDs) sit 2-5 cm in front of their walls, so they
// are drawn pulled toward the camera by 2 cm plus 0.04% of their distance, which keeps them on top out to the
// detail range without z-fighting.
function buildingMaterial(color, lit, rough) {
  const m = matte({ vertexColors: true });
  const vec = (t, f) => Array.from({ length: NL }, (_, i) => f(t[i]));
  const uniforms = {
    tBColor: { value: color }, tBLit: { value: lit }, tBRough: { value: rough }, uKcLamps: lamps, uBNight: night,
    uBEmit: { value: vec(EMIT, (e) => new THREE.Vector3(...(e || [0, 0, 0]))) },
    uBSurf: { value: vec(SURF, (e) => new THREE.Vector2(...(e || [0.9, 0]))) },
    uBWarm: { value: new THREE.Color('#ffd28a') },
  };
  const decal = DECALS.map((l) => `abs(layer - ${l}.0) < 0.5`).join(' || ');
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    lightU = sh.uniforms;          // three wires the frame's lights into this same object (see tick)
    sh.vertexShader = 'attribute float layer;\nvarying float vBLayer;\nvarying vec2 vBUv;\nvarying vec3 vBPos;\n' + sh.vertexShader
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvBLayer = layer; vBUv = uv; vBPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;')
      .replace('#include <project_vertex>', `#include <project_vertex>
\tif ( ${decal} ) {
\t\tfloat bD = length( mvPosition.xyz );
\t\tmvPosition.xyz *= 1.0 - ( 0.02 + 0.0004 * bD ) / max( bD, 0.1 );
\t\tgl_Position = projectionMatrix * mvPosition;
\t}`);
    sh.fragmentShader = `uniform sampler2DArray tBColor, tBLit, tBRough;
uniform bool uKcLamps;
uniform float uBNight;
uniform vec3 uBEmit[ ${NL} ];
uniform vec2 uBSurf[ ${NL} ];
uniform vec3 uBWarm;
varying float vBLayer;
varying vec2 vBUv;
` + sh.fragmentShader
      .replace('void main() {', SHADER_LAYERS + 'void main() {')
      .replace('#include <lights_fragment_begin>', lampGate(THREE.ShaderChunk.lights_fragment_begin))
      .replace('#include <map_fragment>', `
\tint bL = int( vBLayer + 0.5 );
\tvec4 bTex = texture( tBColor, vec3( vBUv, min( vBLayer, ${COLOR_LAYERS - 1}.0 ) ) );
\tvec4 bLit = texture( tBLit, vec3( vBUv, bL < 6 ? float( bL ) : bL == 9 ? 6.0 : 7.0 ) );
\tvec4 bRough = texture( tBRough, vec3( vBUv, min( vBLayer, ${ROUGH_LAYERS - 1}.0 ) ) );
\tbOwn = 0.0; bRgh = 1.0; bMet = 0.0; bEmit = vec3( 0.0 );
\tif ( bL == ${L.tower} || ( bL >= ${L.banded} && bL <= ${L.villaGlass} ) ) { bCurtain( bL == ${L.tower} ? 0 : bL - ${L.banded - 1}, diffuseColor.rgb ); bOwn = 1.0; }
\telse if ( bL == ${L.pool} ) { bPool( diffuseColor.rgb ); bOwn = 1.0; }
\telse if ( bL < ${COLOR_LAYERS} ) diffuseColor *= bTex;`)
      // (an LED crown is dark metal by day, its colour only as the night comes)
      .replace('#include <color_fragment>', `\tif ( bOwn < 0.5 ) diffuseColor.rgb *= bL == ${L.beacon} ? mix( vec3( 0.16, 0.17, 0.18 ), vColor, uBNight ) : vColor;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = bOwn > 0.5 ? bRgh : uBSurf[ bL ].x * ( bL < 6 ? bRough.g : 1.0 );')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = bOwn > 0.5 ? bMet : uBSurf[ bL ].y;')
      .replace('#include <emissivemap_fragment>', `
\tvec3 bE = uBEmit[ bL ];
\t// a window's glow in the warm light of a room; where the glow layer is a cool picture (the towers' sky
\t// glass) it becomes a dimmer warm glow, so no daytime cloud shines out at night
\tfloat bCool = smoothstep( 0.05, 0.3, bLit.b - bLit.r );
\tvec3 bWin = mix( bLit.rgb, vec3( dot( bLit.rgb, vec3( 0.3, 0.59, 0.11 ) ) * 0.55 ), bCool ) * uBWarm;
\tvec3 bSrc = bE.z < 0.5 ? vec3( 0.0 ) : bE.z < 1.5 ? bWin : bE.z < 2.5 ? bLit.rgb : bE.z < 3.5 ? bTex.rgb : vColor.rgb;
\ttotalEmissiveRadiance = bOwn > 0.5 ? bEmit : bSrc * mix( bE.x, bE.y, uBNight );`);
  };
  m.customProgramCacheKey = () => 'kc-building-p3';
  return m;
}

// The stacks, filled from the painted stand-ins now and from assets/tex as the pictures decode, and the material.
function materials(signList) {
  if (M) return M;
  const color = TX.layerStack(COLOR_LAYERS, FACADE_PX), lit = TX.layerStack(LIT_LAYERS, FACADE_PX / 2), rough = TX.layerStack(ROUGH_LAYERS, FACADE_PX / 2, { color: false });
  const deco = TX.decoStandIn(), asked = [];
  FACADES.forEach((s) => {
    if (s === 'tower') return;          // the towers' glass is drawn by the shader (SHADER_LAYERS)
    const name = PICTURE[s] || `facade_${s}`;
    asked.push(TX.putLayer(color, L[s], deco.map, `assets/tex/${name}.jpg`));
    asked.push(TX.putLayer(lit, L[s], deco.lit, `assets/tex/${name}_lit.jpg`));
    asked.push(TX.putLayer(rough, L[s], deco.rough, `assets/tex/${name}_rough.jpg`));
  });
  Promise.all(asked).then(deco.release);
  TX.putLayer(color, L.gravel, TX.roofGravel().image);
  TX.putLayer(color, L.tiles, TX.barrelTiles());
  TX.putLayer(color, L.stripes, TX.stripeAtlas(AWNINGS));
  const shop = TX.shopAtlas2();
  TX.putLayer(color, L.shops, shop.map, 'assets/tex/shops2.jpg');
  TX.putLayer(lit, LIT_OF[L.shops], shop.lit, 'assets/tex/shops2_lit.jpg');
  TX.putLayer(color, L.signs, TX.signAtlas2(), 'assets/tex/shops2_signs.jpg');
  TX.putLayer(color, L.ksigns, TX.ktownSigns(), 'assets/tex/signs_ktown.jpg');
  const sheet = TX.signSheet(signList);
  TX.putLayer(color, L.sheet, sheet.canvas);
  TX.putLayer(color, L.neon, TX.neonAtlas(NEON).image);
  const inside = TX.interiorAtlas(INTERIORS);
  TX.putLayer(color, L.inside, inside.map);
  TX.putLayer(lit, LIT_OF[L.inside], inside.lit);
  M = { material: buildingMaterial(color, lit, rough), color, lit, rough, rects: sheet.rects };
  sheetRects = sheet.rects;
  return M;
}

// ---------- the night, the lamps and the layers ----------

// Once a frame, from the first of the buildings' meshes drawn (onBeforeRender): whether any lamp is on (for the
// lamp gate), and, unless cityV2 drives the night (mats.night), how dark it is. Both are read off the lights
// three has already gathered for this frame, which it wires into the material's own uniforms (lightU): each
// visible point and spot light's colour times its intensity, and the shadow-casting sun's (sky.js's sun is
// warm with a red of 1, at 3 x day; the moon is blue). So nothing walks the scene to find the lights. Pictures
// that have decoded go into their layers just after the frame, outside the renderer's draw.
let ownNight = true, tickFrame = -1, lightU = null, flushing = false;
const anyLit = (list) => { for (const l of list || []) if (l.color.r + l.color.g + l.color.b > 0) return true; return false; };
function tick(renderer) {
  const f = renderer.info.render.frame;
  if (f === tickFrame) return;
  tickFrame = f;
  const u = lightU;
  if (u?.pointLights) {
    lamps.value = anyLit(u.pointLights.value) || anyLit(u.spotLights.value);
    const sun = u.directionalLightShadows.value.length ? u.directionalLights.value[0] : null;
    if (ownNight && sun) night.value = sun.color.b > sun.color.r ? 1 : 1 - Math.min(1, sun.color.r / 3);
  }
  if (!flushing && TX.layersWaiting()) {
    flushing = true;
    setTimeout(() => { flushing = false; TX.flushLayers(renderer); }, 0);
  }
}

// ---------- building it ----------

const stats = { buildings: 0, tiles: 0, shellTris: 0, cells: 0, cellBuilds: 0, cellMs: 0, maxStepMs: 0, cellTris: 0, signMisses: 0 };
export function buildingStats() { return { ...stats }; }

// A pass as one mesh (or null when it drew nothing): indexed, at the origin (the vertices are in world metres),
// with each vertex's layer from the pass's runs.
function meshOf(P, name) {
  if (P.B.empty) return null;
  const geo = P.B.build({ indexed: true }), n = P.B.vertexCount, layer = new Uint8Array(n);
  for (let i = 0; i < P.runs.length; i += 2) layer.fill(P.runs[i + 1], P.runs[i], i + 2 < P.runs.length ? P.runs[i + 2] : n);
  geo.setAttribute('layer', new THREE.BufferAttribute(layer, 1));
  const mesh = new THREE.Mesh(geo, M.material);
  mesh.name = name;
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.onBeforeRender = tick;
  return mesh;
}

// For tools/s5a_buildings_test.mjs: one building's shell or detail as plain arrays in world metres (positions,
// texture coordinates, colours, layers and the index), built as a tile or a cell builds it. Needs a
// registerBuildings first (the world's hash, the sign sheet).
export function buildingPass(b, kind = 'shell') {
  const P = makePass(kind), f = frameOf(b);
  P.at(f.m);
  parts(P, b, f);
  P.at(null);
  const n = P.B.vertexCount, layer = new Uint8Array(n);
  for (let i = 0; i < P.runs.length; i += 2) layer.fill(P.runs[i + 1], P.runs[i], i + 2 < P.runs.length ? P.runs[i + 2] : n);
  return { n, pos: P.B.pos.slice(0, n * 3), uv: P.B.uv.slice(0, n * 2), color: P.B.col.slice(0, n * 3), layer, index: P.B.idx.slice(0, P.B.ni), frame: f };
}
export const LAYERS = L;

// the buildings by a key (their tile or cell), each list in id order
function byKey(list, key) {
  const out = new Map();
  for (const b of list) { const k = b[key]; if (!out.has(k)) out.set(k, []); out.get(k).push(b); }
  for (const l of out.values()) l.sort((a, b) => a.id - b.id);
  return out;
}

// A cell's detail, built a building at a time; it yields when its slice is spent, so a busy cell spreads over
// frames (the chunk manager runs it in its 3 ms budget).
function* buildCell(list, key) {
  const P = makePass('detail');
  let t0 = performance.now(), spent = 0;
  const lap = () => { const dt = performance.now() - t0; spent += dt; if (dt > stats.maxStepMs) stats.maxStepMs = dt; };
  try {
    for (const b of list) {
      const f = frameOf(b);
      P.at(f.m);
      parts(P, b, f);
      P.at(null);
      if (performance.now() - t0 > SLICE_MS) { lap(); yield; t0 = performance.now(); }
    }
    lap();
    yield;
    t0 = performance.now();
    const mesh = meshOf(P, `building detail ${key}`);
    if (mesh) stats.cellTris += mesh.geometry.index.count / 3;
    lap();
    stats.cellBuilds++; stats.cellMs += spent;
    return mesh;
  } finally {
    // built or abandoned (the chunk manager drops a cell the camera left), the builder goes back for the next
    P.at(null);
    spare.push(P.B);
  }
}

export function registerBuildings(world, chunks, mats = null) {
  if (!chunks || !world?.buildings) return;
  // a dev page can leave the buildings out, so tools/s5a_bench.mjs can measure what they cost
  const q = globalThis.location?.search || '';
  if (q.includes('shot=') && q.includes('nobuildings=1')) return;
  if (world.hash) hash = world.hash;
  const list = world.buildings;
  stats.buildings = list.length;
  nameHotels(list);

  // the painted signs every building asks for, then the material (made once; it paints them on one sheet)
  if (!M) {
    const C = makePass('collect');
    for (const b of list) parts(C, b, frameOf(b));
    sheetIndex = new Map([...C.wanted.keys()].map((k, i) => [k, i]));
    materials([...C.wanted.values()]);
  }
  if (mats?.night) { ownNight = false; mats.night(night, 'value', 0, 1); }

  // the shells, one mesh per 256 m tile, always resident
  for (const [tile, bs] of byKey(list, 'tile')) {
    const P = makePass('shell');
    for (const b of bs) { const f = frameOf(b); P.at(f.m); parts(P, b, f); }
    P.at(null);
    const mesh = meshOf(P, `building shells ${tile}`);
    if (!mesh) continue;
    stats.shellTris += mesh.geometry.index.count / 3;
    stats.tiles++;
    chunks.add(mesh, { tile, layer: 'shells' });
  }

  // the detail, per 128 m cell, built when the camera comes near (keys of their own: other builders' cells
  // share the chunk manager)
  for (const [cell, bs] of byKey(list, 'cell')) {
    chunks.lazy(`buildings ${cell}`, () => buildCell(bs, cell), { layer: 'detail', box: keyBox(cell, CELL) });
    stats.cells++;
  }

  // the spawn area's detail now, so the first frame at the villa is whole
  const home = world.places?.home?.foot;
  if (home) chunks.buildAround(home.x * S, home.y * S, SPAWN_R);
}
