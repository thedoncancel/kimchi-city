// The Kimchi Key v2 world (docs/map-v2-spec.md §5-§7): the authored county of src/map/mapdata.js turned
// into what the game reads, behind the same World API as the classic grid (src/world-grid.js). The
// src/world.js facade picks one of the two at load.
//
// generate() runs the whole pipeline once, synchronously, over typed arrays (no three, no DOM, so it runs in
// node and could move to a Worker): the coast and the natural TERRAIN, the RoadNet, road profiles and the
// carve into GROUND (with the bridge decks out to their edges), the prefabs and their pads, the SURF raster
// (kinds and flags at 1 m) and the people-only decks over water in GROUND, pavement under every sidewalk
// path, the lots, the places' curbs and the driveways to them, props, OCC/SEADEPTH/REG, sidewalk zones, then
// jars, photo spots, anchors, routes, activities and the views, and last a validation pass. timing holds
// the milliseconds of every step; generate() returns
// { timing, issues }. Nothing keeps the terrain builder's working arrays once it returns (they are about
// 20 MB), unless the first call asks for them with generate({ debug: true }) (tools/map_check.mjs does).
//
// Units: the sim is in px (16 per metre) with y south, like the grid; the rasters, buildings (cx, cz) and
// landmarks are in metres with z south. Exports are never reassigned: constants, functions, and containers
// made here and filled in place by generate().
import * as D from './map/mapdata.js';
import { KIND as SK, KIND_MASK, FLAG, BLOCK_BOTH, LEGACY, CURB, GRIP, kindBits, fillPoly, fillOBB, fillRibbon, sampleGrid } from './map/raster.js';
import { buildTerrain } from './map/terrain.js';
import { buildRoadNet } from './map/roadnet.js';
import { sampleCurve, offsetCurve } from './map/spline.js';
import { PREFABS, frontOf } from './map/prefabs.js';
import { placeBuildings } from './map/lots.js';
import { placeProps } from './map/props.js';
import { renderMap } from './map/mapimage.js';
import { mulberry32 } from './util.js';

export const KIND = 'v2', MAP_VERSION = D.MAP_VERSION, READY = true;
export const PX_PER_M = 16;         // sim pixels per metre
export const T = 64;                // the grid's tile size in px, kept so shared code can size things the same
const PX = PX_PER_M, WM = D.WORLD.w, HM = D.WORLD.h;
export const BOUNDS = { x0: 0, y0: 0, x1: WM * PX, y1: HM * PX };
export const SIZE = Math.max(BOUNDS.x1, BOUNDS.y1);
export const SEA_LEVEL = D.SEA_LEVEL;
// Forza-style driving (spec §10): a lateral-g cap, slope, airtime, sliding along wall normals, 0.5 m substeps
export const PHYS = Object.freeze({ ...D.PHYS });
export const ROAD = SK.ROAD, WALK = SK.WALK, GRASS = SK.GRASS, BUILD = SK.BUILD, LOT = SK.LOT, PLAZA = SK.PLAZA, WATER = SK.WATER,
  SAND = SK.SAND, DIRT = SK.DIRT, SHALLOW = SK.SHALLOW, DECK = SK.DECK, ROCK = SK.ROCK;

// ---------- containers (filled by generate) ----------
// Prop shapes for the renderers (src/map/props.js makes them; positions are sim px {x, y} with y south, headings
// a in radians, 0 = east and π/2 = south; sizes are metres unless they say px; heights come from groundY):
//   lamps   {x, y, a, edge? | path?}        street, promenade and prefab lamps, a = the way the head faces
//   palms   {x, y, h (m), lean (rad), rot (rad)}
//   trees   {x, y, r (px)}                  banyans, lawn and prefab trees, r the crown radius
//   deco    every other prop, one record each, sorted by `list` (the placeProps list it came from) and told
//           apart by `kind`:
//     list 'prefab'      {kind 'fountain'|'bench'|'lounger'|'umbrella'|'kiosk', x, y, a}: the prefabs' own
//     list 'signals'     {kind 'signal', x, y, a, node, edge, group}: a post at the stop line of each approach to
//                        a signal-candidate junction, facing the drivers; the lens colour is roads.signalAt(node,
//                        edge) (signals stay dark while mapdata SIGNALS.enabled is false)
//     list 'chevrons'    {kind 'chevron', x, y, a, turn 'L'|'R', kmh, edge} boards on a bend's outside;
//                        {kind 'advisory', x, y, a, kmh, dir, edge} the advisory speed sign before it
//     list 'gantries'    {kind 'gantry', x, y, a, w (m, one carriageway), exit (road id), name, side 'L'|'R',
//                        node, deck}: over a Loop carriageway 150 m before each Loop T, x/y its middle
//     list 'dangerSigns' {kind 'jump', id, x, y, a, container} 40 m before each jump; {kind 'gator', x, y, a}
//     list 'billboards'  {kind 'billboard', x, y, a, w, h, pole (m), water (on piles), art (0-7), edge}
//     list 'furniture'   {kind 'bench'|'bin'|'hydrant'|'planter'|'busStop', x, y, a, edge}
//     list 'guardrails'  {kind 'wbeam'|'jersey', pts (Float32Array px [x0, y0, x1, y1, ...]), x, y, edge, side}
//     list 'fences'      {kind 'abutment', x, y, a, w, d, top, base (m; a box along a, w along, d across, from
//                        base up to top), edge, side}; {kind 'bollards', pts (Float32Array px, one post per
//                        point), path, x, y}
//     list 'beachProps'  {kind 'lifeguard'|'umbrella'|'towel', x, y, a, color}
//   Speed-trap posts, jumps, zones and the event board are in activities, the landmarks (in metres) in
//   landmarks. Kimchi Tower is both: its shell is buildings[landmarks.kimchi_tower.building] (kind 'landmark'),
//   the landmark record keeps its LED crown.
export const places = {};
export const buildings = [], trees = [], palms = [], lamps = [], deco = [];
export const solids = [];           // extra blocked rectangles in px { x0, y0, x1, y1 } (the parked jet)
export const photoSpots = [], jarSpots = [], parkedSpawns = [], displaySpots = [];
export const deliveryDoors = [];    // { b, curb } for every building a delivery job can go to
export const anchors = {}, routes = {};
export const activities = [];       // speed traps, speed and drift zones, jumps, the event board, fast-travel hubs (px)
export const landmarks = [];        // spec §5.7, in metres (x, z) like the buildings, with base = ground height
export const regions = [];          // REGIONS rows (index = REG code) and a last 'sea' entry
export const roads = { nodes: [], edges: [], lanes: [], conns: [] };
export const benchViews = [];       // { name, x, y, yaw, heading, car } like the grid's
// v2 only
export const grids = {};            // { surf, ground, terrain, occ, reg, seaDepth, w, h, dims }
export const coast = {};            // { shapes, kinds, shore, seaFloor }: the coast data the sea and beaches are built from (m)
export const water = {};            // { bodies }: the inland WATER list (m), each with its own level
export const viewCorridors = [];
export const timing = {};           // ms per generate() step

// ---------- raster layout ----------
const SW = WM, SH = HM;                         // SURF: 1 m cells
const VW = WM / 2 + 1, VH = HM / 2 + 1;         // GROUND and TERRAIN: 2 m vertices
const OW = WM / 2, OH = HM / 2;                 // OCC and SEADEPTH: 2 m cells
const RC = 8, RW = WM / RC, RH = HM / RC;       // REG: 8 m cells
const REG_SEA = 255;
const BLOCK_ANY = FLAG.BLOCK_CAR | FLAG.BLOCK_FOOT;
const SEA_BITS = SK.WATER | BLOCK_BOTH;         // what lies outside the rasters
const SEED = 0x4b324d32;
const CURB_M = 10;                              // a building's curb is this far out from its door (§5.1)

let generated = false, report = null;
let surf = null, occ = null, reg = null, groundGrid = null, regionIds = [];

// ---------- queries (sim px) ----------

function cellOf(x, y) {
  const i = Math.floor(x / PX), j = Math.floor(y / PX);
  return i < 0 || j < 0 || i >= SW || j >= SH ? -1 : j * SW + i;
}
function bitsAt(x, y) { const c = cellOf(x, y); return c < 0 || !surf ? SEA_BITS : surf[c]; }
function inSolid(x, y) {
  for (const r of solids) if (x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1) return true;
  return false;
}

// The surface kind 0..11 (ROAD..ROCK); outside the map it is the sea.
export function surfaceAt(x, y) { return bitsAt(x, y) & KIND_MASK; }
// The grid's tile code 0..6 for code written for the grid (SAND reads as PLAZA, DECK as ROAD, and so on).
export function tileAtPx(x, y) { return LEGACY[surfaceAt(x, y)]; }
export const blockedCarPx = (x, y) => (bitsAt(x, y) & FLAG.BLOCK_CAR) !== 0 || inSolid(x, y);
export const blockedFootPx = (x, y) => (bitsAt(x, y) & FLAG.BLOCK_FOOT) !== 0 || inSolid(x, y);
// Blocked for anyone: buildings, deep water, rock, rails and bollards. Code that moves cars or people
// should ask blockedCarPx or blockedFootPx; this is the grid's one answer for code written for it.
export const blockedPx = (x, y) => (bitsAt(x, y) & BLOCK_ANY) !== 0 || inSolid(x, y);

// The unit normal pointing out of the car-blocking surface around (x, y), written into out, or null when
// nothing blocks within 2 m. Each blocked cell of the 5×5 metres around the point pushes the normal away
// from itself, nearer cells harder, so a car sliding along a curved wall follows it.
export function wallNormalPx(x, y, out = { x: 0, y: 0 }) {
  for (const r of solids) {
    if (!(x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1)) continue;
    const d = [x - r.x0, r.x1 - x, y - r.y0, r.y1 - y], m = Math.min(...d), k = d.indexOf(m);
    out.x = k === 0 ? -1 : k === 1 ? 1 : 0; out.y = k === 2 ? -1 : k === 3 ? 1 : 0;
    return out;
  }
  const i0 = Math.floor(x / PX), j0 = Math.floor(y / PX);
  let nx = 0, ny = 0, hit = false;
  for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
    const i = i0 + di, j = j0 + dj;
    if (i >= 0 && j >= 0 && i < SW && j < SH && surf && !(surf[j * SW + i] & FLAG.BLOCK_CAR)) continue;
    hit = true;
    const cx = (i + 0.5) * PX - x, cy = (j + 0.5) * PX - y, d2 = cx * cx + cy * cy || 1;
    nx -= cx / d2; ny -= cy / d2;
  }
  const l = Math.hypot(nx, ny);
  if (!hit || l < 1e-9) return null;
  out.x = nx / l; out.y = ny / l;
  return out;
}

// Height of the walkable surface in metres: the GROUND raster (carved terrain, banked roads, pads and bridge
// decks) plus the curb of the surface kind (sidewalks, plazas and plinths 16 cm, lots 4 cm).
export function groundY(x, y) {
  if (!groundGrid) return 0;
  return sampleGrid(groundGrid, x / PX, y / PX) + CURB[surfaceAt(x, y)];
}

// { max, lat }: how much of its top speed a car keeps on this surface and how hard it grips sideways.
const GRIPS = GRIP[PHYS.gripTable] || GRIP.v2;
export const gripAt = (x, y) => GRIPS[surfaceAt(x, y)];

// Can a shooter or a cop see from one point to another? Eye heights h0 and h1 are metres above sea level.
// The ray is tested every 2 m against OCC (the ground, bridge decks and roofs, rounded up to whole metres);
// water never blocks, and the two end cells are skipped so a wall beside either eye does not count.
export function sightClear(x0, y0, h0, x1, y1, h1) {
  if (!occ) return true;
  const ax = x0 / PX, az = y0 / PX, bx = x1 / PX, bz = y1 / PX, n = Math.ceil(Math.hypot(bx - ax, bz - az) / 2);
  for (let k = 1; k < n; k++) {
    const t = k / n, i = Math.floor((ax + (bx - ax) * t) / 2), j = Math.floor((az + (bz - az) * t) / 2);
    if (i < 0 || j < 0 || i >= OW || j >= OH) continue;
    if (occ[j * OW + i] > h0 + (h1 - h0) * t) return false;
  }
  return true;
}

// The region id ('heights', 'ktown', ... ) under a point, or 'sea' off the land and its bridges.
export function regionAt(x, y) {
  if (!reg) return 'sea';
  const i = Math.floor(x / PX / RC), j = Math.floor(y / PX / RC);
  if (i < 0 || j < 0 || i >= RW || j >= RH) return 'sea';
  const v = reg[j * RW + i];
  return v === REG_SEA ? 'sea' : regionIds[v];
}

export const hash = (x, y) => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

// The map picture behind the minimap and the big map: 1 canvas px per metre, so k = 1/16 canvas px per sim
// px, with the canvas origin at sim (0,0). Painted once on first use, then reused.
let mapImg = null;
export function mapImage() {
  if (mapImg) return mapImg;
  generate();
  mapImg = { canvas: renderMap({ grids, roads, buildings, places, regions }, 1), k: 1 / PX, x0: 0, y0: 0 };
  return mapImg;
}

// The title screen camera: a slow loop through TITLE_PATH (metres, y up), looking at the point a lead share
// of the period ahead. pose() writes into anything with x, y, z, such as a THREE.Vector3.
export const titleView = {
  kind: 'path', period: D.TITLE_PATH.period, lead: D.TITLE_PATH.lead, pts: D.TITLE_PATH.pts.map(([x, y, z]) => ({ x, y, z })),
  pose(t, pos, look) {
    const v = titleView, P = v.period, u = ((t % P) + P) % P / P;
    titlePoint(u, pos);
    titlePoint((u + v.lead) % 1, look);
  },
};

// ---------- generate ----------

// Prefabs that are not places, and where they stand: F is the front centre (local (20, 40)); C, when given
// instead, is the centre of the prefab's own block (local (20, 20)).
const SITES = [
  { prefab: 'fest_grounds', F: [820, 1453.5], a: Math.PI / 2 },     // inside the Fest Ring
  { prefab: 'hangar_row', F: [560, 1505], a: Math.PI / 2 },         // Kimchi Air: hangars and the runway
  { prefab: 'star_mansions', C: [1440, 1050], a: Math.PI / 2 },     // inside Star Island Drive
];

// The placeProps lists that go to deco, in this order (lamps, palms and trees have containers of their own).
const DECO_LISTS = ['signals', 'chevrons', 'gantries', 'dangerSigns', 'billboards', 'furniture', 'guardrails', 'fences', 'beachProps'];

export function generate({ debug = false } = {}) {
  if (generated) return report;
  generated = true;
  const issues = [], t0 = now();
  let tLap = t0;
  const lap = name => { const t = now(); timing[name] = round1(t - tLap); tLap = t; };
  fillRegions();

  // 1-2. the coast field and the natural TERRAIN
  const TR = buildTerrain(D, grids);
  timing.coast = round1(TR.timing.coast); timing.natural = round1(TR.timing.natural);
  lap('terrain');
  groundGrid = { w: VW, h: VH, cell: 2, o: 0, data: grids.ground };

  // 3. the RoadNet (filled into the exported roads object)
  buildRoadNet(D.ROADS, D.ROAD_CLASSES, { heightAt: TR.naturalAt, px: PX, seaLevel: D.SEA_LEVEL, signals: D.SIGNALS.candidates,
    signalsOn: D.SIGNALS.enabled, priority: D.SIGNALS.priority, into: roads });
  lap('roadnet');

  // 4. road profiles, then the carve that writes the roads into GROUND and TERRAIN, and the bridge decks'
  // edges into GROUND
  const profiles = TR.solveProfiles(roads);
  lap('profiles');
  TR.carve(roads);
  lap('carve');
  deckGround(TR, roads);
  lap('decks');

  // 5. prefabs (sites first, so the places drawn over them win), then their flat pads
  const built = [];
  SITES.forEach((s, i) => built.push({ out: PREFABS[s.prefab](s.C ? frontOf(s.C, s.a) : s.F, s.a, { seed: SEED + 101 * (i + 1) }) }));
  for (const [key, def] of Object.entries(D.PLACES)) {
    const F = def.centre ? frontOf(def.F, def.a) : def.F;
    built.push({ key, def, out: PREFABS[def.prefab](F, def.a, { seed: SEED + strHash(key), pierLen: def.pierLen }) });
  }
  // the parked jet blocks like a wall from here on (the curbs and driveways below test it)
  for (const { out } of built) for (const s of out.solids) solids.push({ x0: s.x0 * PX, y0: s.z0 * PX, x1: s.x1 * PX, y1: s.z1 * PX });
  lap('prefabs');
  const extraLots = extraLotAreas();
  for (const { out } of built) for (const p of out.pads) TR.pad(p.poly, p.y, p.blend ?? 6);
  for (const r of extraLots) TR.pad(r.poly, undefined, 6);
  lap('pads');

  // 7a. SURF: natural surfaces, prefab surfaces and lots, ped paths, then sidewalks and carriageways
  surf = new Uint8Array(SW * SH);
  grids.surf = surf;
  Object.assign(grids, { w: WM, h: HM, dims: { surf: [SW, SH, 1], ground: [VW, VH, 2], terrain: [VW, VH, 2], occ: [OW, OH, 2], seaDepth: [OW, OH, 2], reg: [RW, RH, RC] } });
  const SG = { w: SW, h: SH, cell: 1, o: 0.5, data: surf };
  stampNatural(TR);
  lap('surfNatural');
  for (const { out } of built) for (const s of out.surfaces) stampSurface(SG, s);
  for (const r of extraLots) fillPoly(SG, r.poly, SK.LOT);
  lap('surfPrefabs');
  const pathCells = stampPaths(SG);
  lap('surfPaths');
  stampRoads(roads);
  lap('surfRoads');
  pathDecks(TR, pathCells);
  lap('pathDecks');
  stampWalks(roads);
  lap('surfWalks');

  // 6. lots: the buildings (prefab buildings first; S2c adds the frontage lots)
  const rng = mulberry32(SEED);
  const fromPrefab = new Set();
  const prefabBuildings = [];
  for (const { out } of built) for (const b of out.buildings) { prefabBuildings.push(b); fromPrefab.add(b); }
  const exclusions = built.flatMap(({ out }) => out.pads.map(p => ({ poly: p.poly }))).concat(extraLots.map(r => ({ poly: r.poly })));
  const raw = placeBuildings(roads, regions, grids, rng, { prefabs: prefabBuildings, corridors: D.VIEW_CORRIDORS, exclusions, cap: 450 });
  for (const b of raw) if (!fromPrefab.has(b)) TR.pad(obbPoly(b.cx, b.cz, b.w, b.d, b.a), undefined, 6);
  const finished = new Map();
  raw.forEach(b => { const f = finishBuilding(b, buildings.length); finished.set(b, f); buildings.push(f); });
  lap('lots');

  // 7b. buildings into SURF, then the junction boxes
  for (const b of buildings) stampBuilding(SG, b, issues);
  stampJunctions(roads);
  lap('buildings');

  // 7c. where a car pulls up at each place, and the drive to it from the nearest traffic lane
  const curbs = new Map(), approaches = new Map();
  for (const { key, out } of built) if (key) curbs.set(key, drivableNear(pxSpot(out.place.curb), pxSpot(out.place.door), issues, key));
  for (const [key, curb] of curbs) approaches.set(key, driveway(key, curb, issues));
  lap('driveways');

  // 8. props, and what the prefabs carry. Every list placeProps makes goes to the renderers: lamps, palms and
  // trees to their own containers, the rest to deco tagged with their list (the shapes are at the top).
  const props = placeProps(roads, grids, regions, rng);
  for (const l of props.lamps) lamps.push(l);
  for (const { out } of built) {
    for (const l of out.lamps) lamps.push({ x: l.x * PX, y: l.z * PX, a: l.a });
    for (const p of out.palms) palms.push({ x: p.x * PX, y: p.z * PX, h: p.h, lean: p.lean, rot: p.rot });
    for (const t of out.trees) trees.push({ x: t.x * PX, y: t.z * PX, r: t.r * PX });
    for (const d of out.deco) deco.push({ kind: d.kind, list: 'prefab', x: d.x * PX, y: d.z * PX, a: d.a });
    for (const s of out.parking) parkedSpawns.push(pxSpot(s));
  }
  for (const p of props.palms) palms.push(p);
  for (const t of props.trees) trees.push(t);
  for (const list of DECO_LISTS) for (const r of props[list]) { r.list = list; deco.push(r); }
  lap('props');

  // 9. OCC, SEADEPTH and REG
  buildOcc();
  lap('occ');
  TR.seaDepth();
  lap('seaDepth');
  buildReg(TR);
  lap('reg');

  // 10. lanes and sidewalks come with the RoadNet; the promenades, piers and the boardwalk are walk zones
  roads.walks.zones = D.PATHS.map(p => pathZone(p)).filter(Boolean);
  lap('walks');

  // 11. places, jars, photo spots, anchors, routes, activities, landmarks and views
  for (const { key, def, out } of built) if (key) addPlace(key, def, out, finished, curbs.get(key), approaches.get(key), issues);
  for (const b of buildings) if (b.deliver) deliveryDoors.push({ b, curb: b.curb });
  addJars(issues);
  addPhotoSpots(issues);
  addAnchors();
  addRoutes(profiles, issues);
  addActivities(profiles);
  addLandmarks(profiles);
  for (const v of D.BENCH_VIEWS) benchViews.push({ name: v.name, x: v.x * PX, y: v.z * PX, yaw: v.yaw, heading: v.heading, car: v.car });
  Object.assign(coast, { shapes: D.COAST, kinds: D.COAST_KINDS, shore: D.SHORE, seaFloor: D.SEA_FLOOR });
  Object.assign(water, { bodies: D.WATER });
  for (const c of D.VIEW_CORRIDORS) viewCorridors.push(c);
  lap('content');

  // 12. validation
  validate(issues);
  lap('validate');
  timing.total = round1(now() - t0);
  report = { timing, issues };
  if (debug) report.debug = { terrain: TR, profiles };
  // in the browser, real problems go to the console (info entries record what the generator adjusted)
  if (typeof window !== 'undefined') for (const i of issues) if (!i.info) console.warn('world-v2:', i.type, i);
  return report;
}

// ---------- regions ----------

function fillRegions() {
  D.REGIONS.forEach((r, index) => regions.push({ ...r, index }));
  regions.push({ id: 'sea', name: 'Sea', style: 'none', traffic: 0, peds: 0, index: REG_SEA });
  regionIds = D.REGIONS.map(r => r.id);
}

// The region a world point (metres) falls in by the REGIONS polygons (before REG exists), or 'sea'.
function regionOfPoint(x, z) {
  for (const r of D.REGIONS) if (insidePoly(r.pts, x, z)) return r;
  return null;
}

// ---------- SURF stamping ----------

// Every cell starts as what nature made it: sea, inland water (deep or shallow), sand on beaches out to the
// beach profile, rock along the foot of the cliffs, grass everywhere else. The kinds are worked out on the
// 2 m terrain vertices, then each 1 m cell takes its nearest vertex. The loops stay plain typed-array passes
// (the rare shore lookups run in a pass of their own), so the one-shot JIT keeps them optimised.
function stampNatural(TR) {
  const land = TR.land, wet = TR.wet, sdf = TR.sdf, n = VW * VH, base = new Uint8Array(n), near = new Int32Array(n);
  const beachW = D.SHORE.beachW, sea = SEA_BITS, grass = SK.GRASS;
  const bodies = Uint8Array.from(D.WATER, b => (b.surf === 'WATER' ? SEA_BITS : SK.SHALLOW));
  let m = 0;
  for (let v = 0; v < n; v++) {
    if (land[v] === 0) base[v] = sea;
    else if (wet[v] >= 2) base[v] = bodies[wet[v] - 2];
    else { base[v] = grass; if (sdf[v] < beachW) near[m++] = v; }
  }
  shoreKinds(TR, base, near, m);
  // vertex q covers the 1 m cells 2q-1 and 2q on each axis
  const row = new Uint8Array(SW);
  for (let vj = 0; vj < VH; vj++) {
    const r0 = vj * VW;
    row[0] = base[r0];
    for (let vi = 1; vi < VW; vi++) { const k = base[r0 + vi]; row[2 * vi - 1] = k; if (2 * vi < SW) row[2 * vi] = k; }
    if (vj > 0) surf.set(row, (2 * vj - 1) * SW);
    if (2 * vj < SH) surf.set(row, 2 * vj * SW);
  }
}

// Beaches are sand out to the beach profile's width, cliffs rock for the cliff profile's. The shore kind is
// looked up once per 4 m, which is plenty: it only changes where one stretch of coast meets the next.
function shoreKinds(TR, base, near, m) {
  const sdf = TR.sdf, cliffW = D.SHORE.cliffW, MW = (VW + 1) >> 1, memo = new Int8Array(MW * ((VH + 1) >> 1)).fill(-1);
  const CODE = { seawall: 0, beach: 1, cliff: 2 }, rock = SK.ROCK | BLOCK_BOTH;
  for (let q = 0; q < m; q++) {
    const v = near[q], vi = v % VW, vj = (v - vi) / VW, c = (vj >> 1) * MW + (vi >> 1);
    let k = memo[c];
    if (k < 0) k = memo[c] = CODE[TR.coastAt((vi >> 1) * 4, (vj >> 1) * 4).kind] ?? 0;
    if (k === 1) base[v] = SK.SAND;
    else if (k === 2 && sdf[v] < cliffW) base[v] = rock;
  }
}

function stampSurface(SG, s) {
  const v = kindBits(s.kind) | (s.flags || 0);
  if (s.obb) fillOBB(SG, s.obb[0], s.obb[1], s.obb[2], s.obb[3], s.obb[4], v);
  else if (s.poly) fillPoly(SG, s.poly, v);
}

// Lots the places and anchors name outside their prefabs: the jet apron's taxiway to the runway, and the
// Red Bandanas' yard by the airboat dock.
function extraLotAreas() {
  const out = [];
  const rect = ([x0, z0, x1, z1]) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  for (const def of Object.values(D.PLACES)) if (def.taxi) out.push({ poly: rect(def.taxi) });
  for (const A of Object.values(D.ANCHORS)) if (A.yard) out.push({ poly: rect(A.yard) });
  return out;
}

// People-only paths (§4.6): promenades and the knoll path are PLAZA, the boardwalk and the pier DECK; 'auto'
// is DECK over water and PLAZA on land. cars: false blocks cars on the whole path, blockAt 'root' only at
// its first 3 m. The Venetian promenade runs beside its road. Paths go down before the roads, so a road
// that crosses a path keeps its carriageway. Returns, per path, its DECK cells and their stations (m along
// the path) for pathDecks.
function stampPaths(SG) {
  return D.PATHS.map(p => {
    const line = pathLine(p), hw = p.w / 2, at = stationsOf(line), cells = [], s = [];
    const block = p.cars === false && !p.blockAt ? FLAG.BLOCK_CAR : 0;
    const root = p.blockAt === 'root' ? [line.x[0], line.z[0]] : null;
    const kind = p.surf === 'auto' || !p.surf ? -1 : SK[p.surf];
    fillRibbon(SG, line, hw, (i, x, z, seg, t) => {
      const cur = surf[i] & KIND_MASK;
      let k = kind;
      if (k < 0) k = cur === SK.WATER || cur === SK.SHALLOW || cur === SK.DECK ? SK.DECK : SK.PLAZA;
      let f = block;
      if (root && Math.hypot(x - root[0], z - root[1]) <= 3) f |= FLAG.BLOCK_CAR;
      surf[i] = k | f;
      if (k === SK.DECK) { cells.push(i); s.push(at[seg] + (at[seg + 1] - at[seg]) * t); }
    });
    return { cells, s, line, len: at[at.length - 1] };
  });
}

// The station (m from the first point) of every point of a {x, z, n} line.
function stationsOf(line) {
  const n = line.n ?? line.x.length, at = new Float64Array(n);
  for (let i = 1; i < n; i++) at[i] = at[i - 1] + Math.hypot(line.x[i] - line.x[i - 1], line.z[i] - line.z[i - 1]);
  return at;
}

// ---------- decks in GROUND ----------

// The carve writes a bridge deck's height only at the 2 m vertices under the deck and leaves the sea bed
// (or the natural ground at an abutment) at the next vertex out. Left like that, the bilinear groundY sags
// toward the sea bed over the deck's outer metres (2.7 m at 3.5 m off the Rickenbacker's centre, inside the
// lane). So every vertex within DECK_REACH of a deck's edge that is not already a road surface takes the
// deck's banked plane, continued past the edge (the nearest deck chord wins), and joins roadMask so no pad
// moves it. Only GROUND changes: TERRAIN keeps the sea bed for the sea depth and the terrain mesh.
const DECK_REACH = 3;          // m: more than a 2 m cell's diagonal, so groundY anywhere on a deck reads deck vertices
function deckGround(TR, net) {
  const ground = TR.ground, mask = TR.roadMask, best = new Float32Array(VW * VH).fill(Infinity);
  for (const e of net.edges) {
    if (!e.deck || !e.deck.length) continue;
    const n = e.n, deck = deckFlags(e), prom = D.ROADS.find(r => r.id === e.road)?.promenade?.w || 0;
    // the deck's surface reaches the carve's deck width (carriageway plus promenade) or the sidewalks
    const r = Math.max(e.halfW / PX + prom, (e.halfW + Math.max(e.walkL || 0, e.walkR || 0)) / PX) + DECK_REACH;
    const X = new Float64Array(n), Z = new Float64Array(n), S = new Float64Array(n);
    for (let k = 0; k < n; k++) { X[k] = e.x[k] / PX; Z[k] = e.y[k] / PX; S[k] = e.s[k] / PX; }
    // the carve's chords (up to 8 m where the road turns less than 0.05 rad), so the heights match its own
    for (let k = 0, k2 = 0; k + 1 < n; k = k2) {
      k2 = chordEnd(X, Z, S, deck, n, k, 8, 0.05);
      if (deck[k] || deck[k2]) deckChord(e, X, Z, k, k2, deck, r, ground, mask, best);
    }
  }
}

// One chord of a deck edge (samples k to k2): its deck part only (a chord that leaves the deck is split at
// its middle, as the carve does), with round ends where it starts or stops.
function deckChord(e, X, Z, k, k2, deck, r, ground, mask, best) {
  const ax = X[k], az = Z[k], dx = X[k2] - ax, dz = Z[k2] - az, L2 = dx * dx + dz * dz;
  if (L2 < 1e-9) return;
  const L = Math.sqrt(L2), nx = -dz / L, nz = dx / L, ta = deck[k] ? 0 : 0.5, tb = deck[k2] ? 1 : 0.5;
  const y0 = e.gy[k], dy = e.gy[k2] - y0, b0 = bankTan(e, k), db = bankTan(e, k2) - b0;
  const i0 = Math.max(0, Math.ceil((Math.min(ax, ax + dx) - r) / 2)), i1 = Math.min(VW - 1, Math.floor((Math.max(ax, ax + dx) + r) / 2));
  const j0 = Math.max(0, Math.ceil((Math.min(az, az + dz) - r) / 2)), j1 = Math.min(VH - 1, Math.floor((Math.max(az, az + dz) + r) / 2));
  for (let j = j0; j <= j1; j++) {
    const pz = j * 2 - az;
    for (let i = i0; i <= i1; i++) {
      const v = j * VW + i;
      if (mask[v] && best[v] === Infinity) continue;          // a road surface the carve wrote (decks' own included)
      const qx = i * 2 - ax, raw = (qx * dx + pz * dz) / L2;
      if ((raw < ta && ta > 0) || (raw > tb && tb < 1)) continue;
      const t = raw < ta ? ta : raw > tb ? tb : raw;
      const ex = qx - dx * t, ez = pz - dz * t, d = Math.sqrt(ex * ex + ez * ez);
      if (d > r || d >= best[v]) continue;
      best[v] = d; mask[v] = 1;
      ground[v] = y0 + dy * t - (ex * nx + ez * nz) * (b0 + db * t);     // bank > 0 lowers the right side
    }
  }
}

// tan(bank) at sample k: edge.bank holds the bank (rad) every 2 m of the edge, like the carve reads it.
function bankTan(e, k) {
  const nb = e.bank?.length || 0;
  if (!nb) return 0;
  const f = Math.min(e.s[k] / PX / 2, nb - 1), i = Math.floor(f), j = Math.min(i + 1, nb - 1);
  return Math.tan(e.bank[i] + (e.bank[j] - e.bank[i]) * (f - i));
}

// People-only decks over water (the marina pier, the Riverwalk's stretches off the seawall) get a height in
// GROUND too. At each station it is the highest dry ground (roads aside) across the path out to PATH_LAND
// past its edges, such as the pier's root or the seawall top, interpolated over open water, and never less
// than DECK_FREEBOARD over the water under it. The corners of every DECK cell with water under a corner take it
// (raised, never lowered) and join roadMask. A path beside a road (the Venetian promenade) is that road's deck.
const PATH_LAND = 8, DECK_FREEBOARD = 1.5;     // m
function pathDecks(TR, stamped) {
  const ground = TR.ground, mask = TR.roadMask, wet = TR.wet;
  const level = w => (w === 0 ? -Infinity : w === 1 ? SEA_LEVEL : D.WATER[w - 2].level);
  D.PATHS.forEach((p, n) => {
    const { cells, s, line, len } = stamped[n];
    if (p.road || !cells.length) return;
    let prof = null;
    const touched = [];
    const raise = (v, h) => { if (!mask[v] && ground[v] < h) ground[v] = h; touched.push(v); };   // roads keep their surface
    for (let q = 0; q < cells.length; q++) {
      const c = cells[q];
      if ((surf[c] & KIND_MASK) !== SK.DECK) continue;         // a road crossed it
      const i = c % SW, v = (((c - i) / SW) >> 1) * VW + (i >> 1);
      const water = Math.max(level(wet[v]), level(wet[v + 1]), level(wet[v + VW]), level(wet[v + VW + 1]));
      if (water === -Infinity) continue;                        // a deck on dry land (the Glades boardwalk) stays on it
      prof ||= landProfile(TR, line, len, p.w / 2 + PATH_LAND);
      const f = Math.min(Math.max(s[q] / 2, 0), prof.length - 1), a = Math.floor(f), b = Math.min(a + 1, prof.length - 1);
      const h = Math.max(prof[a] + (prof[b] - prof[a]) * (f - a), water + DECK_FREEBOARD);
      raise(v, h); raise(v + 1, h); raise(v + VW, h); raise(v + VW + 1, h);
    }
    for (const v of touched) mask[v] = 1;
  });
}

// Every 2 m along a line, the highest dry, off-road GROUND on the cross-section out to r either side (one
// vertex every 2 m), interpolated where there is none (held at the ends; -Infinity when the whole line is
// over water).
function landProfile(TR, line, len, r) {
  const ground = TR.ground, mask = TR.roadMask, wet = TR.wet, m = Math.max(2, Math.ceil(len / 2) + 1), prof = new Float64Array(m).fill(NaN);
  const at = stationsOf(line), n = at.length, k = Math.floor(r / 2);
  for (let q = 0, seg = 0; q < m; q++) {
    const s = Math.min(q * 2, len);
    while (seg < n - 2 && at[seg + 1] < s) seg++;
    const L = at[seg + 1] - at[seg], t = L > 0 ? (s - at[seg]) / L : 0;
    const ux = L > 0 ? (line.x[seg + 1] - line.x[seg]) / L : 1, uz = L > 0 ? (line.z[seg + 1] - line.z[seg]) / L : 0;
    const x = line.x[seg] + ux * L * t, z = line.z[seg] + uz * L * t;
    let h = -Infinity;
    for (let o = -k; o <= k; o++) {
      const i = Math.round((x - uz * o * 2) / 2), j = Math.round((z + ux * o * 2) / 2);
      if (i < 0 || j < 0 || i >= VW || j >= VH) continue;
      const v = j * VW + i;
      if (!wet[v] && !mask[v] && ground[v] > h) h = ground[v];
    }
    if (h > -Infinity) prof[q] = h;
  }
  // stations with no land take the line between their neighbours that have some (held at the ends)
  let last = -1;
  for (let q = 0; q <= m; q++) {
    if (q < m && Number.isNaN(prof[q])) continue;
    for (let g = last + 1; g < q; g++) {
      if (last < 0) prof[g] = q < m ? prof[q] : -Infinity;
      else if (q === m) prof[g] = prof[last];
      else prof[g] = prof[last] + (prof[q] - prof[last]) * (g - last) / (q - last);
    }
    last = q;
  }
  return prof;
}

// A path's centre line in metres ({x, z, n}): its own points, or beside its road (the promenade).
function pathLine(p) {
  if (!p.road) return { x: p.pts.map(q => q[0]), z: p.pts.map(q => q[1]), n: p.pts.length };
  const r = D.ROADS.find(q => q.id === p.road), c = D.ROAD_CLASSES[r.cls];
  const cv = sampleCurve(r.pts, { closed: !!r.closed, step: 2, chord: c.chord });
  return offsetCurve(cv, sideSign(cv, p.side) * (c.halfW + p.w / 2));
}

// +1 when the compass side ('N', 'S', 'E', 'W') is on the curve's right (the (-tz, tx) normal), else -1.
function sideSign(c, side) {
  let rx = 0, rz = 0;
  for (let i = 0; i < c.n; i++) { rx -= c.tz[i]; rz += c.tx[i]; }
  const want = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[side] || [0, -1];
  return rx * want[0] + rz * want[1] >= 0 ? 1 : -1;
}

// Roads: every edge's sidewalks (out to halfW + each side's walk) and carriageway (ROAD, DIRT on dirt tracks,
// DECK on bridges). The nearest road wins at a junction because a carriageway always overwrites and a
// sidewalk never lands on another road's carriageway. Highway carriageways are NOPED.
// Each edge is walked in chords of up to 8 m that turn less than 0.08 rad (they stray under 8 cm from the
// curve). A chord stamps the band beside it, reaching a little past its ends so the outside of a gentle
// bend has no gap; only the edge's ends and sharp joints (a T extension meeting its road) get round caps.
// That way almost every cell is tested once.
// At a junction an edge's round end cap is paved only as far as the widest other road there reaches
// (capRoad): a wide side road ending on a narrow one (Seoul Ave on the ring, Deco Ave on 71st St) would
// otherwise pave over the far sidewalk, and two roads meeting at a corner (Biscayne and Coral Way) would pave
// the outside of the corner where its sidewalk turns. The bands themselves run to the node, so the
// carriageways still meet.
const CHORD = 8, TURN = 0.08, SHARP = 0.12;
function stampRoads(net) {
  const span = [0, 0], out = surf, ks = [];
  for (const e of net.edges) {
    const n = e.n, hw = e.halfW / PX, wL = e.walkL / PX, wR = e.walkR / PX, rA = capRoad(net, e, true), rB = capRoad(net, e, false);
    const X = new Float64Array(n), Z = new Float64Array(n), S = new Float64Array(n);
    for (let k = 0; k < n; k++) { X[k] = e.x[k] / PX; Z[k] = e.y[k] / PX; S[k] = e.s[k] / PX; }
    const deck = deckFlags(e), r = hw + Math.max(wL, wR, 0), ext = r * SHARP + 0.5;
    const road = (e.cls === 'dirt' ? SK.DIRT : SK.ROAD) | (e.cls === 'hwy' ? FLAG.NOPED : 0);
    const deckV = SK.DECK | (e.cls === 'hwy' ? FLAG.NOPED : 0);
    ks.length = 0;
    for (let k = 0; k + 1 < n;) {
      const k2 = chordEnd(X, Z, S, deck, n, k, CHORD, TURN);
      if ((X[k2] - X[k]) ** 2 + (Z[k2] - Z[k]) ** 2 > 1e-9) ks.push(k, k2);
      k = k2;
    }
    const m = ks.length / 2, dir = c => Math.atan2(Z[ks[2 * c + 1]] - Z[ks[2 * c]], X[ks[2 * c + 1]] - X[ks[2 * c]]);
    const sharp = (c1, c2) => { const d = dir(c2) - dir(c1); return Math.abs(Math.atan2(Math.sin(d), Math.cos(d))) > SHARP || ks[2 * c1 + 1] !== ks[2 * c2]; };
    for (let c = 0; c < m; c++) {
      const k = ks[2 * c], k2 = ks[2 * c + 1], capA = c === 0 || sharp(c - 1, c), capB = c === m - 1 || sharp(c, c + 1);
      // the edge's own ends cap at their junction's reach; a sharp joint inside the edge caps at its width
      const ra = c === 0 ? rA : hw, rb = c === m - 1 ? rB : hw;
      stampChord(out, span, X[k], Z[k], X[k2], Z[k2], r, hw, wL, wR, capA ? 0 : ext, capB ? 0 : ext, capA, capB,
        deck[k] ? deckV : road, deck[k2] ? deckV : road, deck[k] ? DECK : WALK, deck[k2] ? DECK : WALK, ra, rb);
    }
  }
}

// How far (m) an edge's round end cap is paved at node a (start) or b: its half width, or the widest other
// road's at that node when that is less. A dead end keeps its own.
function capRoad(net, e, start) {
  const N = net.nodes[start ? e.a : e.b], hw = e.halfW / PX;
  let other = -1;
  for (const E of N?.ends || []) if (!(E.e === e.id && E.start === start)) other = Math.max(other, net.edges[E.e].halfW / PX);
  return other < 0 ? hw : Math.min(hw, other);
}

// One chord's cells: the carriageway (road0/road1 before/after its middle) within hw of the chord, the
// sidewalks (walk0/walk1) out to hw + that side's walk, never over another road's carriageway. In a round cap
// past either end the carriageway reaches ra (start) or rb (end) and the sidewalk that much plus its walk.
function stampChord(out, span, ax, az, bx, bz, r, hw, wL, wR, e0, e1, capA, capB, road0, road1, walk0, walk1, ra = hw, rb = hw) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz, L = Math.sqrt(L2);
  const ux = dx / L, uz = dz / L, nx = -uz, nz = ux, t0 = -e0 / L, t1 = 1 + e1 / L, reach = r + Math.max(e0, e1);
  const j0 = Math.max(0, Math.floor(Math.min(az, bz) - reach)), j1 = Math.min(SH - 1, Math.ceil(Math.max(az, bz) + reach));
  for (let j = j0; j <= j1; j++) {
    const cz = j + 0.5;
    if (!bandSpan(ax, az, ux, uz, L, r, e0, e1, capA, capB, cz, span)) continue;
    const pz = cz - az, row = j * SW, i1 = Math.min(SW - 1, Math.floor(span[1] - 0.5));
    for (let i = Math.max(0, Math.ceil(span[0] - 0.5)); i <= i1; i++) {
      const qx = i + 0.5 - ax;
      let t = (qx * dx + pz * dz) / L2;
      if ((t < t0 && !capA) || (t > t1 && !capB)) continue;
      // in the band (or its short extensions past a gentle joint) the carriageway is hw wide; in a cap, ra or rb
      const pave = t < 0 && capA ? ra : t > 1 && capB ? rb : hw;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = qx - dx * t, ez = pz - dz * t, d2 = ex * ex + ez * ez, cell = row + i;
      if (d2 <= pave * pave) { out[cell] = t < 0.5 ? road0 : road1; continue; }
      const w = pave + (ex * nx + ez * nz >= 0 ? wR : wL);
      if (d2 > w * w) continue;
      const cur = out[cell] & KIND_MASK;
      if (cur !== ROAD && cur !== DECK && cur !== DIRT) out[cell] = t < 0.5 ? walk0 : walk1;
    }
  }
}

// The x range [lo, hi] where row z crosses a chord's stamp (into out), or false: the band within r of the
// chord from e0 before its start to e1 past its end, plus a disc of radius r at each capped end.
function bandSpan(ax, az, ux, uz, L, r, e0, e1, capA, capB, z, out) {
  let lo = Infinity, hi = -Infinity, h;
  const q = z - az, nx = -uz, nz = ux;
  let a = -Infinity, b = Infinity;
  if (Math.abs(nx) > 1e-9) { const p0 = (-r - q * nz) / nx, p1 = (r - q * nz) / nx; a = Math.max(a, Math.min(p0, p1)); b = Math.min(b, Math.max(p0, p1)); }
  else if (Math.abs(q * nz) > r) a = Infinity;
  if (Math.abs(ux) > 1e-9) { const p0 = (-e0 - q * uz) / ux, p1 = (L + e1 - q * uz) / ux; a = Math.max(a, Math.min(p0, p1)); b = Math.min(b, Math.max(p0, p1)); }
  else if (q * uz < -e0 || q * uz > L + e1) a = Infinity;
  if (a <= b) { lo = ax + a; hi = ax + b; }
  if (capA && (h = r * r - q * q) >= 0) { h = Math.sqrt(h); lo = Math.min(lo, ax - h); hi = Math.max(hi, ax + h); }
  if (capB) {
    const bx = ax + ux * L, qb = z - (az + uz * L);
    if ((h = r * r - qb * qb) >= 0) { h = Math.sqrt(h); lo = Math.min(lo, bx - h); hi = Math.max(hi, bx + h); }
  }
  if (lo > hi) return false;
  out[0] = lo; out[1] = hi;
  return true;
}

// ---------- pavement under the walk graph ----------
// The RoadNet's sidewalk paths (roads.walks: halfW + walk/2 out, joined round each corner by a short curve)
// are where people walk, so they must be pavement. Every cell within WALK_R of a path that is not a crosswalk
// becomes WALK when it is open ground (grass or sand), or a carriageway cell that no lane or junction
// connector runs over: a corner curve cutting the outside of a bend, a sidewalk end on the shoulder of the
// curving Loop. Crosswalks stay road. It runs before the lots, so no building stands on a sidewalk.
const WALK_R = 0.8;            // m: about the strip a person walking a path keeps to
const LANE_CLEAR = 0.4;        // m past a lane's half width that a carriageway cell stays road
function stampWalks(net) {
  const cand = [], r = WALK_R, r2 = r * r;
  for (const p of net.walks.paths) {
    if (p.cross) continue;
    for (let k = 0; k + 1 < p.n; k++) {
      // every half metre of the path: almost always on the sidewalk the roads stamped already; where not, the
      // cells within r of that point
      const ax = p.pts[2 * k] / PX, az = p.pts[2 * k + 1] / PX, dx = p.pts[2 * k + 2] / PX - ax, dz = p.pts[2 * k + 3] / PX - az;
      const m = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dz * dz) * 2));
      for (let q = 0; q <= m; q++) {
        const x = ax + dx * q / m, z = az + dz * q / m, c0 = cellOf(x * PX, z * PX);
        if (c0 < 0) continue;
        const k0 = surf[c0] & KIND_MASK;
        if (k0 !== SK.GRASS && k0 !== SK.SAND && k0 !== SK.ROAD && k0 !== SK.DIRT) continue;
        for (let j = Math.max(0, Math.floor(z - r)); j <= Math.min(SH - 1, Math.floor(z + r)); j++)
          for (let i = Math.max(0, Math.floor(x - r)); i <= Math.min(SW - 1, Math.floor(x + r)); i++) {
            if ((i + 0.5 - x) ** 2 + (j + 0.5 - z) ** 2 > r2) continue;
            const c = j * SW + i, b = surf[c], kind = b & KIND_MASK;
            if (b & BLOCK_ANY) continue;
            if (kind === SK.GRASS || kind === SK.SAND) surf[c] = SK.WALK;
            else if (kind === SK.ROAD || kind === SK.DIRT) cand.push(c);
          }
      }
    }
  }
  if (!cand.length) return;
  const conns = net.nodes.map(() => []);
  for (const c of net.conns) conns[c.node].push(c);
  for (const c of new Set(cand)) {
    const x = (c % SW + 0.5) * PX, y = (Math.floor(c / SW) + 0.5) * PX;
    if (!driven(net, conns, x, y)) surf[c] = SK.WALK;
  }
}

// Does a lane or a junction connector run over (x, y) px: within its half width (the lane's own, or the lane it
// leads to) plus LANE_CLEAR?
function driven(net, conns, x, y) {
  let hit = false;
  const near = (L, half) => {
    for (let i = 0; i + 1 < L.n; i++) if (segDist(x, y, L.x[i], L.y[i], L.x[i + 1], L.y[i + 1]) <= half) return true;
    return false;
  };
  net.edgesNear(x, y, 12 * PX, e => {
    if (hit) return;
    const half = e.laneW / 2 + LANE_CLEAR * PX;
    for (const id of [...e.fwd, ...e.bwd]) if (near(net.lanes[id], half)) { hit = true; return; }
  });
  if (hit) return true;
  for (const N of net.nodes) {
    if (Math.abs(N.x - x) > 40 * PX || Math.abs(N.y - y) > 40 * PX) continue;
    for (const c of conns[N.id]) if (near(c, net.edges[net.lanes[c.to].edge].laneW / 2 + LANE_CLEAR * PX)) return true;
  }
  return false;
}

// Which samples of an edge sit on a bridge deck (edge.deck spans are in the edge's px stations).
function deckFlags(e) {
  const out = new Uint8Array(e.n);
  if (!e.deck || !e.deck.length) return out;
  for (let k = 0; k < e.n; k++) for (const [a, b] of e.deck) if (e.s[k] >= a - 1e-3 && e.s[k] <= b + 1e-3) { out[k] = 1; break; }
  return out;
}

// The sample a chord from k runs to: at most len metres on, sooner once the road turns by more than turn
// radians or a deck starts or ends.
function chordEnd(X, Z, S, deck, n, k, len, turn) {
  if (k + 1 >= n - 1) return n - 1;
  const a0 = Math.atan2(Z[k + 1] - Z[k], X[k + 1] - X[k]);
  let k2 = k + 1;
  while (k2 + 1 < n && S[k2 + 1] - S[k] <= len && deck[k2 + 1] === deck[k]) {
    const a = Math.atan2(Z[k2 + 1] - Z[k2], X[k2 + 1] - X[k2]), d = a - a0;
    if (Math.abs(Math.atan2(Math.sin(d), Math.cos(d))) > turn) break;
    k2++;
  }
  return k2;
}

// The junction box of every node with three or more roads: road cells within its widest lane trim plus a
// metre get JCT (no parking or idling there).
function stampJunctions(net) {
  for (const N of net.nodes) {
    if (N.ends.length < 3) continue;
    let r = 0;
    for (const E of N.ends) r = Math.max(r, E.trim);
    r = r / PX + 1;
    const cx = N.x / PX, cz = N.y / PX;
    for (let j = Math.max(0, Math.floor(cz - r)); j <= Math.min(SH - 1, Math.ceil(cz + r)); j++)
      for (let i = Math.max(0, Math.floor(cx - r)); i <= Math.min(SW - 1, Math.ceil(cx + r)); i++) {
        const c = j * SW + i, k = surf[c] & KIND_MASK;
        if ((k === SK.ROAD || k === SK.DECK) && (i + 0.5 - cx) ** 2 + (j + 0.5 - cz) ** 2 <= r * r) surf[c] |= FLAG.JCT;
      }
  }
}

// A building's footprint becomes BUILD (blocked both ways); a footprint over a road or sidewalk is reported.
function stampBuilding(SG, b, issues) {
  let hits = 0;
  const v = SK.BUILD | BLOCK_BOTH;
  fillOBB(SG, b.cx, b.cz, b.w, b.d, b.a, i => {
    const k = surf[i] & KIND_MASK;
    if (k === SK.ROAD || k === SK.DECK || k === SK.DIRT || k === SK.WALK) hits++;
    surf[i] = v;
  });
  if (hits) issues.push({ type: 'building_on_road', id: b.id, place: b.place, cells: hits, x: b.cx, z: b.cz });
}

// ---------- buildings (spec §6.4) ----------

function finishBuilding(b, id) {
  const region = regionOfPoint(b.cx, b.cz), door = { x: b.door.x * PX, y: b.door.z * PX, a: b.door.a };
  return {
    id, cx: b.cx, cz: b.cz, w: b.w, d: b.d, h: b.h, base: sampleGrid(groundGrid, b.cx, b.cz), a: b.a,
    style: b.style || region?.style || 'none', region: region?.id || 'sea', floors: b.floors, wall: b.wall, roof: b.roof,
    trim: b.trim, sign: b.sign, awning: b.awning, house: b.house, shop: b.shop, kind: b.kind, place: b.place || undefined,
    landmark: b.landmark || undefined,
    door, curb: { x: door.x + Math.cos(b.a) * CURB_M * PX, y: door.y + Math.sin(b.a) * CURB_M * PX, a: b.a },
    deliver: b.deliver ?? (!b.place && b.kind !== 'hangar'),
    tile: `${Math.floor(b.cx / 256)},${Math.floor(b.cz / 256)}`, cell: `${Math.floor(b.cx / 128)},${Math.floor(b.cz / 128)}`,
  };
}

function obbPoly(cx, cz, w, d, a) {
  const fx = Math.cos(a), fz = Math.sin(a), rx = Math.sin(a), rz = -Math.cos(a);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [cx + rx * u * w / 2 + fx * v * d / 2, cz + rz * u * w / 2 + fz * v * d / 2]);
}

// ---------- OCC and REG ----------

// OCC: per 2 m cell the highest of its four GROUND corners (roads, decks and pads included) and the roofs over
// it, rounded up to whole metres and clamped to 0..255.
function buildOcc() {
  occ = new Uint8Array(OW * OH);
  grids.occ = occ;
  const g = grids.ground;
  for (let j = 0; j < OH; j++) for (let i = 0; i < OW; i++) {
    const v = j * VW + i;
    let m = g[v];
    if (g[v + 1] > m) m = g[v + 1];
    if (g[v + VW] > m) m = g[v + VW];
    if (g[v + VW + 1] > m) m = g[v + VW + 1];
    occ[j * OW + i] = m <= 0 ? 0 : m >= 255 ? 255 : Math.ceil(m);
  }
  const OG = { w: OW, h: OH, cell: 2, o: 0.5, data: occ };
  for (const b of buildings) fillOBB(OG, b.cx, b.cz, b.w, b.d, b.a, Math.min(255, Math.ceil(b.base + b.h)), 'max');
}

// REG: the region index per 8 m cell from the REGIONS polygons, clipped to land. A cell over the sea keeps
// its region when any of its 2 m vertices is land or lies under a road, a bridge deck or a pier (roadMask), so
// traffic on a bridge counts in its region all the way across the deck. Everything else is REG_SEA.
function buildReg(TR) {
  reg = new Uint8Array(RW * RH).fill(REG_SEA);
  grids.reg = reg;
  const RG = { w: RW, h: RH, cell: RC, o: 0.5, data: reg };
  D.REGIONS.forEach((r, i) => fillPoly(RG, r.pts, i));
  const land = TR.land, mask = TR.roadMask, n = RC / 2;
  for (let j = 0; j < RH; j++) for (let i = 0; i < RW; i++) {
    if (reg[j * RW + i] === REG_SEA) continue;
    let keep = false;
    for (let vj = j * n; vj <= j * n + n && !keep; vj++) for (let v = vj * VW + i * n, e = v + n; v <= e; v++) {
      if (land[v] || mask[v]) { keep = true; break; }
    }
    if (!keep) reg[j * RW + i] = REG_SEA;
  }
}

// ---------- walk zones ----------

function pathZone(p) {
  const line = pathLine(p), n = line.n ?? line.x.length;
  if (n < 2) return null;
  const pts = new Float32Array(n * 2);
  let len = 0;
  for (let i = 0; i < n; i++) {
    pts[2 * i] = line.x[i] * PX; pts[2 * i + 1] = line.z[i] * PX;
    if (i) len += Math.hypot(line.x[i] - line.x[i - 1], line.z[i] - line.z[i - 1]) * PX;
  }
  return { id: p.id, name: p.name, kind: p.kind, pts, n, len, w: p.w * PX, cars: p.cars !== false };
}

// ---------- places (spec §5.1, §6.5) ----------
// A place is the §6.5 contract in px: { key, name, icon, color, door {x, y, a}, b (its building), foot, curb,
// giver, hangout, approach, ... the extras }. approach (F3, for the navigation of cars bound for the place) is
// the drive from the traffic lanes to the curb (see driveway()): { pts: Float32Array [x0, y0, x1, y1, ...] px
// from a point on lane `lane` (`s` px along it, on edge `edge` of road `road`) to the curb, n points, len px }.

const GIVER_OFFS = [[-85, 55], [85, 55], [-110, 25], [110, 25], [0, 115], [-75, 115], [75, 115], [-150, 60], [150, 60]];
const pxSpot = s => ({ x: s.x * PX, y: s.z * PX, a: s.a });

function addPlace(key, def, out, finished, curb, approach, issues) {
  const pp = out.place, b = out.buildings.find(q => q.place === key);
  const door = pxSpot(pp.door), foot = pxSpot(pp.foot);
  const pl = { key, name: def.name, icon: def.icon, color: def.color, door, b: b ? finished.get(b) : undefined, foot, curb };
  if (approach) pl.approach = approach;
  pl.giver = giverSpot(door);
  // a friend's hangout is authored (and kept within reach of a traffic lane); elsewhere it is the grid's spot
  // beside the door, on open ground
  pl.hangout = def.hangout ? friendSpot(key, def.hangout, issues) : walkableNear(local(door, 100, 60), 6);
  if (def.nomenu) pl.nomenu = true;
  if (def.drive) pl.drive = true;
  if (pp.bay) pl.bay = { x: curb.x, y: curb.y, r: pp.bay.r * PX };
  if (out.garage) { pl.garage = out.garage.map(pxSpot); pl.spawn = pl.garage[0]; }
  if (out.spots) pl.spots = out.spots.map(pxSpot);
  if (out.plane) pl.plane = pxSpot(out.plane);
  // the pier runs from (x, y) along a for len, in px like every place spot
  if (out.pier) pl.pier = { x: out.pier.x * PX, y: out.pier.z * PX, a: out.pier.a, len: out.pier.len * PX };
  if (out.display) for (const s of out.display) displaySpots.push(pxSpot(s));
  places[key] = pl;
}

// A spot ox across (to the place's right as you face it from the street, as on the grid) and oy out from the
// door, in px.
function local(door, ox, oy) {
  const a = door.a;
  return { x: door.x + ox * Math.sin(a) + oy * Math.cos(a), y: door.y - ox * Math.cos(a) + oy * Math.sin(a) };
}

// Where a mission giver stands: the first open walkway, plaza or lot spot beside the door that no tree
// covers (the grid's search, turned with the place), else down and to the left of the door.
function giverSpot(door) {
  for (const [ox, oy] of GIVER_OFFS) {
    const p = local(door, ox, oy), k = surfaceAt(p.x, p.y);
    if (k !== SK.WALK && k !== SK.PLAZA && k !== SK.LOT) continue;
    if (blockedFootPx(p.x, p.y)) continue;
    if (trees.some(t => Math.hypot(t.x - p.x, t.y - p.y) < 50)) continue;
    return p;
  }
  return local(door, -70, 70);
}

// A friend waits within HANGOUT_LANE of a lane traffic drives, so a car can pull up beside them (§5.1). An
// authored spot further out (Kimchi Motors': the Fest Ring's north side bows 5 m away from the showroom)
// moves straight toward the nearest lane until it is that close, onto open ground.
const HANGOUT_LANE = 14;
function friendSpot(key, [hx, hz], issues) {
  const p = { x: hx * PX, y: hz * PX }, q = nearestLanePoint(p.x, p.y);
  if (!q || q.d <= HANGOUT_LANE * PX) return p;
  const f = 1 - (HANGOUT_LANE - 0.5) * PX / q.d, moved = walkableNear({ x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f }, 2);
  issues.push({ type: 'hangout_moved', place: key, from: [hx, hz], to: [+(moved.x / PX).toFixed(2), +(moved.y / PX).toFixed(2)], lane: +(q.d / PX).toFixed(1), info: true });
  return moved;
}

// The nearest point (px) on a lane of a road traffic uses, within 40 m: { x, y, d } or null.
function nearestLanePoint(x, y) {
  let best = null;
  roads.edgesNear(x, y, 40 * PX, e => {
    if (!e.ai) return;
    for (const id of [...e.fwd, ...e.bwd]) {
      const L = roads.lanes[id];
      for (let i = 0; i + 1 < L.n; i++) {
        const ax = L.x[i], ay = L.y[i], dx = L.x[i + 1] - ax, dy = L.y[i + 1] - ay, l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0, qx = ax + dx * t, qy = ay + dy * t;
        const d = Math.hypot(x - qx, y - qy);
        if (!best || d < best.d) best = { x: qx, y: qy, d };
      }
    }
  });
  return best;
}

// p itself when someone can stand there, else the centre of the nearest such cell within r metres.
function walkableNear(p, r) {
  const ok = (i, j) => { const b = surf[j * SW + i], k = b & KIND_MASK; return !(b & FLAG.BLOCK_FOOT) && k !== SK.WATER && k !== SK.SHALLOW; };
  const q = nudge(p.x / PX, p.y / PX, r, ok);
  return q ? { x: q.x * PX, y: q.z * PX } : p;
}

// The curb where a car pulls up: the §5.1 point when a car can stand there, else the nearest cell a car can
// use within 12 m of the door (the villa's falls in its pool).
const CAR_OK = new Set([SK.ROAD, SK.WALK, SK.GRASS, SK.LOT, SK.PLAZA, SK.SAND, SK.DIRT, SK.DECK]);
function drivableNear(p, door, issues, key) {
  const ok = (x, y) => { const b = bitsAt(x, y); return !(b & FLAG.BLOCK_CAR) && CAR_OK.has(b & KIND_MASK) && !inSolid(x, y); };
  if (ok(p.x, p.y)) return p;
  const q = nearestCell(p.x / PX, p.y / PX, 4, (i, j) => ok((i + 0.5) * PX, (j + 0.5) * PX) && Math.hypot((i + 0.5) * PX - door.x, (j + 0.5) * PX - door.y) <= 12 * PX);
  if (!q) { issues.push({ type: 'curb_blocked', place: key, x: p.x / PX, z: p.y / PX }); return p; }
  issues.push({ type: 'curb_moved', place: key, from: [p.x / PX, p.y / PX], to: [q.x, q.z], d: +Math.hypot(q.x - p.x / PX, q.z - p.y / PX).toFixed(2), info: true });
  return { x: q.x * PX, y: q.z * PX, a: p.a };
}

// ---------- driveways (place.approach) ----------
// A car bound for a place leaves the traffic lanes and drives to its curb: the marina's curb is 44 m from South
// Pointe Drive, round the yacht club; the jet's 37 m from Airport Road, round the terminal; the villa's up the
// private Villa Drive and across the garage court. driveway() finds that drive: the straight line to the nearest
// lane of a road traffic uses (never the highway) when it crosses only pavement a car fits through; else the
// cheapest way to any such lane within APPROACH_R of the curb, over cells a car fits through (the 3×3 cells
// round each are clear of anything that blocks cars, except within START_FREE of the curb itself), open
// ground costing OPEN_COST times pavement, cut down to a polyline that stays on such cells. Where the drive
// crosses grass or sand, a DRIVE_W wide LOT driveway is stamped.
// Returns place.approach: { pts: Float32Array [x0, y0, x1, y1, ...] px from the lane point to the curb, n, len
// (px), lane (the lane id), s (px along that lane where the drive leaves it), edge, road }, or null (an issue)
// when no lane is in reach.
const APPROACH_R = 64, START_FREE = 3, OPEN_COST = 3, DRIVE_W = 5;      // m
const PAVED = new Set([SK.ROAD, SK.LOT, SK.PLAZA, SK.WALK, SK.DECK, SK.DIRT]);
function driveway(key, curb, issues) {
  const cx = curb.x / PX, cz = curb.y / PX, R = APPROACH_R, D = 2 * R + 1, i0 = Math.floor(cx) - R, j0 = Math.floor(cz) - R;
  const inWin = (i, j) => i >= 0 && j >= 0 && i < D && j < D && i + i0 >= 0 && j + j0 >= 0 && i + i0 < SW && j + j0 < SH;
  // per cell, worked out when first asked: -1 not yet, 0 no, 1 yes
  const carOK = new Int8Array(D * D).fill(-1), fit = new Int8Array(D * D).fill(-1);
  const okAt = (i, j) => {
    if (!inWin(i, j)) return false;
    const w = j * D + i;
    if (carOK[w] < 0) {
      const b = surf[(j + j0) * SW + i + i0], k = b & KIND_MASK;
      carOK[w] = !(b & (FLAG.BLOCK_CAR | FLAG.NOPED)) && CAR_OK.has(k) && !inSolid((i + i0 + 0.5) * PX, (j + j0 + 0.5) * PX) ? 1 : 0;
    }
    return carOK[w] === 1;
  };
  const fits = (i, j) => {
    if (!inWin(i, j)) return false;
    const w = j * D + i;
    if (fit[w] < 0) {
      let f = okAt(i, j);
      if (f && Math.hypot(i + i0 + 0.5 - cx, j + j0 + 0.5 - cz) > START_FREE)
        for (let dj = -1; dj <= 1 && f; dj++) for (let di = -1; di <= 1 && f; di++) f = okAt(i + di, j + dj);
      fit[w] = f ? 1 : 0;
    }
    return fit[w] === 1;
  };
  const clear = (a, b) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), m = Math.max(1, Math.ceil(L / 0.5));
    for (let q = 1; q < m; q++) {
      const x = a[0] + (b[0] - a[0]) * q / m, z = a[1] + (b[1] - a[1]) * q / m;
      if (!fits(Math.floor(x) - i0, Math.floor(z) - j0)) return false;
    }
    return true;
  };
  // the lanes in reach, rasterised: the lane and its station at each cell they cross; and the nearest of them
  const tLane = new Int32Array(D * D).fill(-1), tS = new Float32Array(D * D), tX = new Float32Array(D * D), tY = new Float32Array(D * D);
  let near = -1, nearD = Infinity;
  roads.edgesNear(curb.x, curb.y, (R + 8) * PX, e => {
    if (!e.ai || e.cls === 'hwy') return;
    for (const id of [...e.fwd, ...e.bwd]) {
      const L = roads.lanes[id];
      for (let k = 0; k + 1 < L.n; k++) {
        const m = Math.max(1, Math.ceil(Math.hypot(L.x[k + 1] - L.x[k], L.y[k + 1] - L.y[k]) / (0.5 * PX)));
        for (let q = 0; q < m; q++) {
          const f = q / m, x = L.x[k] + (L.x[k + 1] - L.x[k]) * f, y = L.y[k] + (L.y[k + 1] - L.y[k]) * f;
          const i = Math.floor(x / PX) - i0, j = Math.floor(y / PX) - j0;
          if (!inWin(i, j) || tLane[j * D + i] >= 0) continue;
          const w = j * D + i, d = (x / PX - cx) ** 2 + (y / PX - cz) ** 2;
          tLane[w] = id; tS[w] = L.s[k] + (L.s[k + 1] - L.s[k]) * f; tX[w] = x; tY[w] = y;
          if (d < nearD) { nearD = d; near = w; }
        }
      }
    }
  });
  if (near < 0) { issues.push({ type: 'no_approach', place: key, x: cx, z: cz }); return null; }
  // most curbs see their nearest lane across pavement: then the drive is that straight line; otherwise (a
  // building or the water in the way, or open ground to cross) the cheapest way round
  let line = [[tX[near] / PX, tY[near] / PX], [cx, cz]], at = near;
  if (!clear(line[0], line[1]) || !paved(line[0], line[1])) {
    const hit = cheapestToLane(D, Math.floor(cx) - i0, Math.floor(cz) - j0, near % D, Math.floor(near / D), i0, j0, fits, tLane);
    if (hit.w < 0) { issues.push({ type: 'no_approach', place: key, x: cx, z: cz }); return null; }
    // the cell path from the lane to the curb, in metres, then cut down to the corners it needs
    const path = [[tX[hit.w] / PX, tY[hit.w] / PX]];
    for (let w = hit.prev[hit.w]; w >= 0 && w !== hit.start; w = hit.prev[w]) path.push([w % D + i0 + 0.5, Math.floor(w / D) + j0 + 0.5]);
    path.push([cx, cz]);
    line = simplifyPath(path, 1, clear);
    at = hit.w;
  }
  stampDriveway(line);
  const lane = roads.lanes[tLane[at]], pts = new Float32Array(line.length * 2);
  let len = 0;
  line.forEach(([x, z], q) => { pts[2 * q] = x * PX; pts[2 * q + 1] = z * PX; if (q) len += Math.hypot(x - line[q - 1][0], z - line[q - 1][1]) * PX; });
  return { pts, n: line.length, len, lane: lane.id, s: tS[at], edge: lane.edge, road: roads.edges[lane.edge].road };
}

// Every cell under the segment a-b (m) is pavement.
function paved(a, b) {
  const m = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.5));
  for (let q = 0; q <= m; q++) {
    const c = cellOf((a[0] + (b[0] - a[0]) * q / m) * PX, (a[1] + (b[1] - a[1]) * q / m) * PX);
    if (c < 0 || !PAVED.has(surf[c] & KIND_MASK)) return false;
  }
  return true;
}

// A* over a D×D window of 1 m cells (window origin i0, j0) from the start cell (si, sj) to the first cell a
// lane crosses (tLane ≥ 0), stepping to the 8 neighbours that fits(i, j) allows and heading for the lane cell
// nearest the start (gi, gj) as the crow flies, which keeps the search to the few thousand cells round the
// drive. A metre of carriageway, lot or deck costs 1, a plaza a little more and a sidewalk more again (a drive
// keeps off them where it can), open ground OPEN_COST. Returns { w: the lane cell (-1 if none), prev, start }.
const STEP_COST = new Float64Array(16).fill(OPEN_COST);
for (const k of PAVED) STEP_COST[k] = 1;
STEP_COST[SK.PLAZA] = 1.2; STEP_COST[SK.WALK] = 1.6;
function cheapestToLane(D, si, sj, gi, gj, i0, j0, fits, tLane) {
  const cost = new Float64Array(D * D).fill(Infinity), prev = new Int32Array(D * D).fill(-1), done = new Uint8Array(D * D);
  // a lane cell's own estimate is 0, so whichever lane cell is reached first is reached at its cost
  const heap = new MinHeap(), start = sj * D + si, h = (i, j) => (tLane[j * D + i] >= 0 ? 0 : Math.hypot(i - gi, j - gj));
  cost[start] = 0; heap.push(h(si, sj), start);
  while (heap.size) {
    const w = heap.pop();
    if (done[w]) continue;
    done[w] = 1;
    if (tLane[w] >= 0) return { w, prev, start };
    const i = w % D, j = (w - i) / D, c0 = cost[w];
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if ((!di && !dj) || !fits(i + di, j + dj)) continue;
      const n = w + dj * D + di, c1 = c0 + (di && dj ? Math.SQRT2 : 1) * STEP_COST[surf[(j + dj + j0) * SW + i + di + i0] & KIND_MASK];
      if (c1 < cost[n]) { cost[n] = c1; prev[n] = w; heap.push(c1 + h(i + di, j + dj), n); }
    }
  }
  return { w: -1, prev, start };
}

// Douglas-Peucker with a check: a stretch of the path becomes one segment only when no point strays more than
// tol from it and ok(a, b) says a car can drive straight along it.
function simplifyPath(P, tol, ok) {
  const keep = new Uint8Array(P.length);
  keep[0] = keep[P.length - 1] = 1;
  const stack = [[0, P.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    let far = -1, fd = -1;
    for (let q = a + 1; q < b; q++) {
      const d = segDist(P[q][0], P[q][1], P[a][0], P[a][1], P[b][0], P[b][1]);
      if (d > fd) { fd = d; far = q; }
    }
    if (fd <= tol && ok(P[a], P[b])) continue;
    const mid = fd > tol ? far : (a + b) >> 1;
    keep[mid] = 1;
    stack.push([a, mid], [mid, b]);
  }
  return P.filter((_, q) => keep[q]);
}

// LOT under a driveway where it runs over grass or sand: DRIVE_W wide round each stretch of the line that
// is not on pavement already.
function stampDriveway(line) {
  const r = DRIVE_W / 2;
  for (let q = 0; q + 1 < line.length; q++) {
    const [ax, az] = line[q], [bx, bz] = line[q + 1], m = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.5));
    for (let t = 0; t <= m; t++) {
      const x = ax + (bx - ax) * t / m, z = az + (bz - az) * t / m, c = cellOf(x * PX, z * PX);
      if (c < 0 || PAVED.has(surf[c] & KIND_MASK)) continue;
      for (let j = Math.floor(z - r); j <= Math.floor(z + r); j++) for (let i = Math.floor(x - r); i <= Math.floor(x + r); i++) {
        if (i < 0 || j < 0 || i >= SW || j >= SH || (i + 0.5 - x) ** 2 + (j + 0.5 - z) ** 2 > r * r) continue;
        const k = j * SW + i, b = surf[k];
        if (!(b & BLOCK_ANY) && ((b & KIND_MASK) === SK.GRASS || (b & KIND_MASK) === SK.SAND)) surf[k] = SK.LOT;
      }
    }
  }
}

// A binary min-heap of values by cost: pop() takes the value of the least cost.
class MinHeap {
  constructor() { this.c = []; this.v = []; }
  get size() { return this.c.length; }
  push(c, v) {
    const C = this.c, V = this.v;
    let i = C.length;
    C.push(c); V.push(v);
    while (i > 0) { const p = (i - 1) >> 1; if (C[p] <= c) break; C[i] = C[p]; V[i] = V[p]; i = p; }
    C[i] = c; V[i] = v;
  }
  pop() {
    const C = this.c, V = this.v, top = V[0], c = C.pop(), v = V.pop(), n = C.length;
    if (n) {
      let i = 0;
      for (;;) {
        let k = 2 * i + 1;
        if (k >= n) break;
        if (k + 1 < n && C[k + 1] < C[k]) k++;
        if (C[k] >= c) break;
        C[i] = C[k]; V[i] = V[k]; i = k;
      }
      C[i] = c; V[i] = v;
    }
    return top;
  }
}

// The centre of the nearest 1 m cell (metres) within r of (x, z) that passes test(i, j), or null; the point
// itself counts when its own cell passes.
function nearestCell(x, z, r, test) {
  let best = null, bd = Infinity;
  const i0 = Math.floor(x), j0 = Math.floor(z), R = Math.ceil(r);
  for (let j = j0 - R; j <= j0 + R; j++) for (let i = i0 - R; i <= i0 + R; i++) {
    if (i < 0 || j < 0 || i >= SW || j >= SH) continue;
    const d = Math.hypot(i + 0.5 - x, j + 0.5 - z);
    if (d > r + 0.71 || d >= bd || !test(i, j)) continue;
    bd = d; best = { x: i + 0.5, z: j + 0.5, d };
  }
  return best;
}

// ---------- jars and photo spots ----------

// A jar must be on foot ground that is not a highway (NOPED) or water; each is nudged up to 8 m onto the
// nearest such cell (§5.3).
function addJars(issues) {
  const ok = (i, j) => { const b = surf[j * SW + i], k = b & KIND_MASK; return !(b & (FLAG.BLOCK_FOOT | FLAG.NOPED)) && k !== SK.WATER && k !== SK.SHALLOW; };
  for (const J of D.JARS) {
    const p = nudge(J.x, J.z, 8, ok);
    if (!p) issues.push({ type: 'jar_unreachable', id: J.id, x: J.x, z: J.z });
    else if (p.moved > 0) issues.push({ type: 'jar_nudged', id: J.id, d: +p.moved.toFixed(2), info: true });
    const q = p || { x: J.x, z: J.z };
    jarSpots.push({ id: J.id, x: q.x * PX, y: q.z * PX });
  }
}

// Photo spots keep their authored point when someone can stand there; otherwise (the causeway spot is just
// past the deck edge) they move to the nearest walkable cell within 8 m.
function addPhotoSpots(issues) {
  const ok = (i, j) => { const b = surf[j * SW + i], k = b & KIND_MASK; return !(b & FLAG.BLOCK_FOOT) && k !== SK.WATER && k !== SK.SHALLOW; };
  for (const P of D.PHOTO_SPOTS) {
    const p = nudge(P.x, P.z, 8, ok);
    if (!p) issues.push({ type: 'photo_unreachable', id: P.id, x: P.x, z: P.z });
    else if (p.moved > 0) issues.push({ type: 'photo_nudged', id: P.id, d: +p.moved.toFixed(2), info: true });
    const q = p || { x: P.x, z: P.z }, s = { id: P.id, name: P.name, x: q.x * PX, y: q.z * PX, bonus: P.bonus };
    if (P.look) s.look = P.look;
    if (P.time) s.time = P.time;
    photoSpots.push(s);
  }
}

function nudge(x, z, r, ok) {
  const i = Math.floor(x), j = Math.floor(z);
  if (i >= 0 && j >= 0 && i < SW && j < SH && ok(i, j)) return { x, z, moved: 0 };
  const c = nearestCell(x, z, r, ok);
  return c ? { x: c.x, z: c.z, moved: c.d } : null;
}

// ---------- anchors ----------

function addAnchors() {
  for (const [k, A] of Object.entries(D.ANCHORS)) {
    const o = { x: A.x * PX, y: A.z * PX, a: A.a };
    if (A.r) o.r = A.r * PX;
    if (A.say) o.say = A.say;
    if (A.yard) o.yard = { x0: A.yard[0] * PX, y0: A.yard[1] * PX, x1: A.yard[2] * PX, y1: A.yard[3] * PX };
    if (A.strip) o.strip = A.strip.map(([x, z]) => ({ x: x * PX, y: z * PX }));
    anchors[k] = o;
  }
}

// ---------- routes (spec §5.5) ----------
// Each leg follows one road's §4.1 curve between the stations nearest its ends (a lap: once round a closed
// road from where the route already is, in point order), or is a straight line. The route's pts are the
// lane a car drives (the inner lane on the right of travel); its gates sit on the centre line, evenly spaced
// about gateEvery metres apart with the last one at the finish, face along the course and are the road's
// width + gateExtra wide. routes.street_kings is the same object as bay_loop (the grid's name for the race).

function addRoutes(profiles, issues) {
  for (const R of D.ROUTES) {
    const c = [];          // centre line points {x, z, tx, tz, off, hw} (m)
    let cur = startRef(R, profiles);
    for (const leg of R.legs) {
      const pts = leg.line ? lineLeg(leg.line) : roadLeg(profiles, leg, cur);
      if (!pts.length) { issues.push({ type: 'route_leg', route: R.id, leg }); continue; }
      if (c.length && Math.hypot(pts[0].x - c[c.length - 1].x, pts[0].z - c[c.length - 1].z) < 0.5) pts.shift();
      for (const p of pts) c.push(p);
      cur = c[c.length - 1];
    }
    if (c.length < 2) continue;
    const S = new Float64Array(c.length);
    for (let i = 1; i < c.length; i++) S[i] = S[i - 1] + Math.hypot(c[i].x - c[i - 1].x, c[i].z - c[i - 1].z);
    const len = S[c.length - 1], n = Math.max(1, Math.round(len / R.gateEvery)), gates = [];
    for (let g = 1; g <= n; g++) {
      const p = alongPts(c, S, (g * len) / n), hw = p.hw ?? pavedHalfWidth(p);
      gates.push({ x: p.x * PX, y: p.z * PX, a: Math.atan2(p.tz, p.tx), w: (2 * hw + R.gateExtra) * PX });
    }
    const pts = new Float32Array(c.length * 2), s = new Float32Array(c.length);
    for (let i = 0; i < c.length; i++) {
      const p = c[i];
      pts[2 * i] = (p.x - p.tz * p.off) * PX; pts[2 * i + 1] = (p.z + p.tx * p.off) * PX;
      if (i) s[i] = s[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
    }
    const st = c[0], start = startPose(R, st);
    routes[R.id] = { id: R.id, name: R.name, laps: R.laps, start, gates, pts, s, len: s[s.length - 1], gateEvery: R.gateEvery };
  }
  if (routes.bay_loop) routes.street_kings = routes.bay_loop;
}

// Where a route starts, in metres {x, z, tx?, tz?}: a named anchor, a station on a road, or nothing (its
// first leg's start).
function startRef(R, profiles) {
  if (typeof R.start === 'string') { const A = D.ANCHORS[R.start]; return { x: A.x, z: A.z, a: A.a }; }
  if (R.start && R.start.road) { const p = profiles.get(R.start.road); return pointOn(p, R.start.s, 1); }
  return null;
}
function startPose(R, first) {
  const ref = typeof R.start === 'string' ? D.ANCHORS[R.start] : null;
  if (ref) return { x: ref.x * PX, y: ref.z * PX, a: ref.a };
  return { x: first.x * PX, y: first.z * PX, a: Math.atan2(first.tz, first.tx) };
}

// The lane offset to the right of travel for a road class: the inner lane of a two-way road, the middle of
// a one-way road.
function laneOff(c) {
  if (c.oneway) return 0;
  return (c.median || 0) / 2 + c.laneW / 2;
}

function roadLeg(profiles, leg, cur) {
  const r = D.ROADS.find(q => q.id === leg.road), p = profiles.get(leg.road), c = D.ROAD_CLASSES[r.cls];
  if (!p) return [];
  let s0, span, dir;
  if (leg.lap) {
    s0 = cur ? p.nearest(cur.x, cur.z, -1).s : 0; span = p.len; dir = 1;
  } else {
    s0 = p.nearest(leg.from[0], leg.from[1], -1).s;
    const s1 = p.nearest(leg.to[0], leg.to[1], -1).s;
    if (p.closed) { dir = 1; span = ((s1 - s0) % p.len + p.len) % p.len; }
    else { dir = s1 >= s0 ? 1 : -1; span = Math.abs(s1 - s0); }
  }
  const n = Math.max(1, Math.ceil(span / 2)), out = [], off = laneOff(c);
  for (let q = 0; q <= n; q++) {
    const pt = pointOn(p, s0 + dir * span * q / n, dir);
    pt.off = off; pt.hw = c.halfW;
    out.push(pt);
  }
  return out;
}

function lineLeg([[ax, az], [bx, bz]]) {
  const L = Math.hypot(bx - ax, bz - az), tx = (bx - ax) / L, tz = (bz - az) / L, n = Math.max(1, Math.ceil(L / 2)), out = [];
  for (let q = 0; q <= n; q++) out.push({ x: ax + (bx - ax) * q / n, z: az + (bz - az) * q / n, tx, tz, off: 0 });
  return out;
}

// Position and travel tangent at station s of a road profile (wrapping on closed roads), dir = ±1.
function pointOn(p, s, dir) {
  const cv = p.curve, n = p.n;
  s = p.closed ? ((s % p.len) + p.len) % p.len : Math.min(Math.max(s, 0), p.len);
  const f = s / p.ds, i = Math.min(Math.floor(f), p.closed ? n - 1 : n - 2), j = p.closed ? (i + 1) % n : i + 1, t = f - i;
  const [tx, tz] = p.tangent(s);
  return { x: cv.x[i] + (cv.x[j] - cv.x[i]) * t, z: cv.z[i] + (cv.z[j] - cv.z[i]) * t, tx: tx * dir, tz: tz * dir, s };
}

function alongPts(c, S, s) {
  let lo = 0, hi = c.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
  const f = S[hi] > S[lo] ? Math.min(1, Math.max(0, (s - S[lo]) / (S[hi] - S[lo]))) : 0, a = c[lo], b = c[hi];
  return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, tx: a.tx, tz: a.tz, hw: a.hw };
}

// Half the paved width across a point (m): how far ROAD, LOT, DECK or DIRT runs either side of it (the
// runway's gates on the drag strip).
function pavedHalfWidth(p) {
  const paved = (x, z) => { const i = Math.floor(x), j = Math.floor(z); if (i < 0 || j < 0 || i >= SW || j >= SH) return false; const k = surf[j * SW + i] & KIND_MASK; return k === SK.ROAD || k === SK.LOT || k === SK.DECK || k === SK.DIRT; };
  let a = 0, b = 0;
  while (a < 40 && paved(p.x + p.tz * (a + 1), p.z - p.tx * (a + 1))) a++;
  while (b < 40 && paved(p.x - p.tz * (b + 1), p.z + p.tx * (b + 1))) b++;
  return Math.max(4, (a + b) / 2);
}

// ---------- activities (spec §5.6) ----------

function zonePts(profiles, z) {
  const p = profiles.get(z.road);
  let s0 = 0, span = p.len;
  if (z.s0 !== undefined) { s0 = z.s0; span = z.s1 - z.s0; }
  else if (z.from) {
    s0 = p.nearest(z.from[0], z.from[1], -1).s;
    const s1 = p.nearest(z.to[0], z.to[1], -1).s;
    span = p.closed ? ((s1 - s0) % p.len + p.len) % p.len : s1 - s0;
  }
  const dir = span < 0 ? -1 : 1, n = Math.max(1, Math.ceil(Math.abs(span) / 2)), pts = new Float32Array((n + 1) * 2), s = new Float32Array(n + 1);
  for (let q = 0; q <= n; q++) {
    const pt = pointOn(p, s0 + span * q / n, dir);
    pts[2 * q] = pt.x * PX; pts[2 * q + 1] = pt.z * PX;
    if (q) s[q] = s[q - 1] + Math.hypot(pts[2 * q] - pts[2 * q - 2], pts[2 * q + 1] - pts[2 * q - 1]);
  }
  return { pts, s, len: s[n] };
}

function addActivities(profiles) {
  const A = D.ACTIVITIES;
  for (const t of A.speedTraps) {
    const near = roads.nearest(t.x * PX, t.z * PX, { maxD: 40 * PX }), e = near && roads.edges[near.edge];
    const a = e ? Math.atan2(e.ty[near.i], e.tx[near.i]) : 0;
    activities.push({ id: t.id, type: 'speedTrap', x: t.x * PX, y: t.z * PX, a, road: e?.road });
  }
  for (const z of A.speedZones) activities.push({ id: z.id, type: 'speedZone', road: z.road, ...zonePts(profiles, z) });
  for (const z of A.driftZones) activities.push({ id: z.id, type: 'driftZone', road: z.road, ...zonePts(profiles, z) });
  for (const j of A.jumps) {
    const p = profiles.get(j.road), [tx, tz] = p.tangent(p.nearest(j.x, j.z, -1).s);
    activities.push({ id: j.id, type: 'jump', road: j.road, x: j.x * PX, y: j.z * PX, a: Math.atan2(tz, tx), h: j.h, run: j.run * PX, container: !!j.container });
  }
  activities.push({ id: 'event_board', type: 'eventBoard', x: A.eventBoard.x * PX, y: A.eventBoard.z * PX });
  for (const h of A.hubs) {
    const at = h.place ? places[h.place]?.foot : { x: h.x * PX, y: h.z * PX };
    if (at) activities.push({ id: h.id, type: 'hub', name: h.name, x: at.x, y: at.y });
  }
}

// ---------- landmarks (spec §5.7, metres) ----------

function addLandmarks(profiles) {
  for (const L of D.LANDMARKS) {
    const o = { ...L };
    if (L.place === 'jet' && places.jet?.plane) { const pl = places.jet.plane; o.x = pl.x / PX; o.z = pl.y / PX; o.a = pl.a; }
    if (L.bridge) {
      // the bascule houses sit at the middle of each water span of the bridge's road
      const br = D.BRIDGES.find(b => b.id === L.bridge), p = profiles.get(br?.road);
      o.at = p ? spanCentres(p).map(s => { const q = pointOn(p, s, 1); return [q.x, q.z]; }) : [];
    }
    if (o.x !== undefined) o.base = sampleGrid(groundGrid, o.x, o.z);
    // a landmark that is also a building (Kimchi Tower): its shell is that building, the landmark keeps the rest
    const b = buildings.find(q => q.landmark === L.id);
    if (b) o.building = b.id;
    landmarks.push(o);
  }
}

function spanCentres(p) {
  const out = [];
  for (let i = 0, start = -1; i <= p.n; i++) {
    const on = i < p.n && p.deck[i] === 1;
    if (on && start < 0) start = i;
    if (!on && start >= 0) { out.push(((start + i - 1) / 2) * p.ds); start = -1; }
  }
  return out;
}

// ---------- validation ----------
// The checks that cost little and catch a broken map at load: the RoadNet's own report, every place spot on
// open ground, and the building budget. tools/map_check.mjs runs the full set headless.
function validate(issues) {
  for (const i of roads.issues || []) issues.push({ ...i, type: 'roadnet_' + i.type });
  for (const pl of Object.values(places)) {
    for (const k of ['door', 'foot', 'giver', 'hangout']) {
      const p = pl[k];
      if (k !== 'door' && blockedFootPx(p.x, p.y)) issues.push({ type: 'place_spot_blocked', place: pl.key, spot: k, x: p.x / PX, z: p.y / PX });
    }
  }
  if (buildings.length > 450) issues.push({ type: 'too_many_buildings', n: buildings.length });
}

// ---------- the title path ----------
// A closed uniform Catmull-Rom through the TITLE_PATH points, walked at an even speed (an arc-length table
// built on first use).
let titleTable = null;
function titlePoint(u, out) {
  const P = titleView.pts, n = P.length;
  if (!titleTable) {
    const N = n * 64, s = new Float64Array(N + 1), q = { x: 0, y: 0, z: 0 }, prev = { x: 0, y: 0, z: 0 };
    crAt(P, 0, prev);
    for (let k = 1; k <= N; k++) { crAt(P, k / N * n, q); s[k] = s[k - 1] + Math.hypot(q.x - prev.x, q.y - prev.y, q.z - prev.z); prev.x = q.x; prev.y = q.y; prev.z = q.z; }
    titleTable = { s, N };
  }
  const { s, N } = titleTable, want = u * s[N];
  let lo = 0, hi = N;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m] <= want) lo = m; else hi = m; }
  const f = s[hi] > s[lo] ? (want - s[lo]) / (s[hi] - s[lo]) : 0;
  return crAt(P, (lo + f) / N * n, out);
}
function crAt(P, t, out) {
  const n = P.length, i = Math.floor(t) % n, f = t - Math.floor(t);
  const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
  const cr = (a, b, c, d) => 0.5 * (2 * b + (c - a) * f + (2 * a - 5 * b + 4 * c - d) * f * f + (3 * b - a - 3 * c + d) * f * f * f);
  out.x = cr(p0.x, p1.x, p2.x, p3.x); out.y = cr(p0.y, p1.y, p2.y, p3.y); out.z = cr(p0.z, p1.z, p2.z, p3.z);
  return out;
}

// ---------- small helpers ----------

function insidePoly(pts, x, z) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
// Distance from (x, y) to the segment a-b (any units).
function segDist(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
  return Math.hypot(x - ax - dx * t, y - ay - dy * t);
}
function strHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
function now() { return globalThis.performance ? performance.now() : Date.now(); }
function round1(v) { return Math.round(v * 10) / 10; }
