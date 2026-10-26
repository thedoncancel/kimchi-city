// The world facade. Every module imports the map from here, and it forwards to one implementation
// picked once at load (docs/map-v2-spec.md §7): the Kimchi Key v2 map by default (since S9), or the classic
// grid when globalThis.KC_WORLD, ?map=1 or localStorage 'kc-map' asks for it (kept for one release), or when
// the v2 generator is not READY. Node tools can also pick with the KC_WORLD environment variable.
// Each name is copied from the chosen world, so a name that world lacks is undefined here instead of
// a link error. The worlds fill their containers in place, so these copies stay live.
import * as GRID from './world-grid.js';
import * as V2 from './world-v2.js';

const DEFAULT = 'v2';

// '1', 'grid' and 'classic' mean the grid; '2' and 'v2' mean the new map; anything else is not a map name.
function kindOf(v) {
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'grid' || s === 'classic' ? 'grid' : s === '2' || s === 'v2' ? 'v2' : null;
}

// The first source that names a known map wins: the page's global, then the URL, then the saved choice, then
// (in node, for the tools) the environment. Each read is guarded because node has no location and a private
// window can refuse storage.
function requestedKind() {
  const sources = [
    () => globalThis.KC_WORLD,
    () => new URLSearchParams(globalThis.location?.search || '').get('map'),
    () => globalThis.localStorage?.getItem('kc-map'),
    () => globalThis.process?.env?.KC_WORLD,
  ];
  for (const read of sources) {
    let v;
    try { v = read(); } catch { continue; }
    if (v == null || v === '') continue;
    const k = kindOf(v);
    if (k) return k;
    console.warn(`world: '${v}' is not a map name; ignoring it`);
  }
  return DEFAULT;
}

const want = requestedKind();
const W = want === 'v2' && V2.READY === true ? V2 : GRID;
if (want === 'v2' && W !== V2) console.info('world: the v2 map is not ready yet, so the classic grid is used');

// ---- both worlds (World API v2) ----
export const KIND = W.KIND, MAP_VERSION = W.MAP_VERSION, READY = W.READY, PX_PER_M = W.PX_PER_M, T = W.T, SIZE = W.SIZE,
  BOUNDS = W.BOUNDS, SEA_LEVEL = W.SEA_LEVEL, PHYS = W.PHYS;
export const ROAD = W.ROAD, WALK = W.WALK, GRASS = W.GRASS, BUILD = W.BUILD, LOT = W.LOT, PLAZA = W.PLAZA, WATER = W.WATER,
  SAND = W.SAND, DIRT = W.DIRT, SHALLOW = W.SHALLOW, DECK = W.DECK, ROCK = W.ROCK;
export const generate = W.generate, tileAtPx = W.tileAtPx, surfaceAt = W.surfaceAt, blockedPx = W.blockedPx,
  blockedCarPx = W.blockedCarPx, blockedFootPx = W.blockedFootPx, wallNormalPx = W.wallNormalPx, groundY = W.groundY,
  gripAt = W.gripAt, sightClear = W.sightClear, regionAt = W.regionAt, mapImage = W.mapImage, hash = W.hash;
export const places = W.places, buildings = W.buildings, trees = W.trees, palms = W.palms, lamps = W.lamps, deco = W.deco,
  solids = W.solids, photoSpots = W.photoSpots, jarSpots = W.jarSpots, parkedSpawns = W.parkedSpawns,
  displaySpots = W.displaySpots, deliveryDoors = W.deliveryDoors, anchors = W.anchors, routes = W.routes,
  activities = W.activities, landmarks = W.landmarks, regions = W.regions, roads = W.roads, benchViews = W.benchViews,
  titleView = W.titleView;

// ---- grid only (undefined on v2) ----
export const tiles = W.tiles, N = W.N, P = W.P, BLOCKS = W.BLOCKS, roadCenter = W.roadCenter, tileAt = W.tileAt,
  makeMinimap = W.makeMinimap, drawGround = W.drawGround, drawBuilding = W.drawBuilding, drawTree = W.drawTree,
  drawLamp = W.drawLamp, drawDeco = W.drawDeco;

// ---- v2 only (undefined on the grid) ----
export const grids = W.grids, coast = W.coast, water = W.water, viewCorridors = W.viewCorridors, timing = W.timing;
