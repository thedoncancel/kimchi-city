// The Kimchi Key v2 city in 3D (docs/map-v2-spec.md §7 and §11.1): the orchestrator. The src/3d/city.js facade
// picks it when the world facade chose the v2 map. It builds nothing itself; it hands the world to each builder
// and keeps them in step:
//
//  - the chunk manager (src/3d/chunks.js), which draws each 256 m tile and 128 m cell only near the camera and
//    lets them cast shadows only near the player; the facade runs its update before ours each frame;
//  - terrain3d (the ground: a 2 m grid near the camera, the painted 8 m grid beyond), coast3d (the sea,
//    ponds, beach props and the marina);
//  - roads3d, buildings3d, props3d and landmarks3d, filled in by later stages (S4b, S5a, S5b);
//  - flora3d (stage P2): every tree, palm, shrub and hedge (the world's and props.js placeFlora's), near, light
//    and far, and the small plants and rocks streamed per 64 m cell from the SURF raster (scatter3d).
//
// It exports what the facade forwards: buildCity, occluderTop, nearestLamps, clearTreesForCamera and the lists
// main3d animates (fountains, yachts, the sea). Everything is in metres: x east, z south, y up.
import * as THREE from 'three';
import * as world from '../world.js';
import { generate, groundY, PX_PER_M, grids, places } from '../world.js';
import { makeChunkManager } from './chunks.js';
import { buildTerrain3D, makeSkyLight, LOD0_R } from './terrain3d.js';
import { buildCoast3D } from './coast3d.js';
import { buildRoads3D } from './roads3d.js';
import { registerBuildings } from './buildings3d.js';
import { buildProps3D } from './props3d.js';
import { buildLandmarks } from './landmarks3d.js';
import { buildFlora3D } from './flora3d.js';
import { farAlbedo } from '../map/mapimage.js';
import { HIGH, matte } from './quality.js';
import * as TX from './textures.js';

const PX = PX_PER_M;
const CAST_R = 110;          // m: tiles and cells cast shadows only this close to the shadow focus (spec §11.1)
const MAX_CELLS = HIGH ? 48 : 36;   // built detail cells kept (the lead's choice for High's 300 m detail)

export const lampHeads = [];   // lamp head positions (m), filled by props3d when it has lamps
export const fountains = [];   // { jet, water } meshes main3d animates
export const mountains = [];   // the grid's distant hills; v2 has real terrain, so this stays empty
export const yachts = [];      // { g, base, ph } boats that ride the swell
export let sea = null;         // the sea mesh, made by buildCity

let props = null;              // what props3d built (nearestLamps), once it builds something

// ---------- what the camera and bullets cannot pass ----------

// The highest thing at (xm, zm) metres a camera or a bullet cannot pass through: a roof or a deck (OCC, the
// ground and every building top rounded up to whole metres) where one stands above the ground, else the ground
// itself. OCC alone would lift every hillside by up to a metre (its rounding), so it only counts where it is
// clearly above the walkable surface.
export function occluderTop(xm, zm) {
  const g = groundY(xm * PX, zm * PX), occ = grids?.occ;
  if (!occ) return g;
  const [w, h] = grids.dims.occ, i = Math.floor(xm / 2), j = Math.floor(zm / 2);
  if (i < 0 || j < 0 || i >= w || j >= h) return g;
  const o = occ[j * w + i];
  return o > g + 1.5 ? o : g;
}

// The n lamp heads nearest (xm, zm), nearest first, written into out: props3d's, or none until it has lamps
// (main3d leaves a light without a lamp dark).
export function nearestLamps(xm, zm, n, out = []) {
  if (props?.nearestLamps) return props.nearestLamps(xm, zm, n, out);
  out.length = 0;
  return out;
}

// The grid hides tree crowns between the camera and Kimchi; v2's trees (flora3d's) stay.
export function clearTreesForCamera() {}

// ---------- shared materials ----------

// Materials the later builders share across every tile (spec §11.1: shared materials across chunks), made on
// first use: the ground photos toned as the grid town has them, road paint, and night(material, prop, day,
// night) for values that change after dark (setNight applies them).
function sharedMaterials(night, terrain) {
  const made = {};
  const once = (k, make) => (made[k] ||= make());
  const ground = (k, base, url, o) => once(k, () => { const m = matte({ map: base }); TX.upgradeGround(m, url, o); return m; });
  return {
    get asphalt() { return ground('asphalt', TX.asphalt(), 'assets/tex/asphalt.jpg', { tint: '#c9a47c', amount: 0.4, normal: 'assets/tex/asphalt_n.jpg', normalScale: 0.9 }); },
    get lot() { return ground('lot', TX.asphalt('#676c75', 12), 'assets/tex/asphalt.jpg', { tint: '#b8946e', amount: 0.42, normal: 'assets/tex/asphalt_n.jpg', normalScale: 0.9 }); },
    get sidewalk() { return ground('sidewalk', TX.sidewalk(), 'assets/tex/concrete.jpg', { tint: '#efe6d6', amount: 0.35, lift: 0.22, normal: 'assets/tex/concrete_n.jpg', normalScale: 0.4 }); },
    get plaza() { return ground('plaza', TX.plaza(), 'assets/tex/granite.jpg', { tint: '#f0dcb8', amount: 0.55, lift: 0.3, normal: 'assets/tex/granite_n.jpg', normalScale: 0.5 }); },
    get curb() { return once('curb', () => matte({ map: TX.concrete('#b4afa5') })); },
    get deck() { return once('deck', () => matte({ color: '#9b7653' })); },
    get vertexColors() { return once('vc', () => matte({ vertexColors: true })); },
    paint(color) { return once('paint ' + color, () => matte({ color, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })); },
    night,
    terrain: terrain.materials,
    textures: terrain.textures,
  };
}

// ---------- the city ----------

export function buildCity(scene) {
  if (world.KIND !== 'v2') throw new Error('cityV2 builds the v2 world only (the city facade picks cityGrid on the grid)');
  generate();
  const group = new THREE.Group();
  group.name = 'city';
  // the city's chunk manager: what it places goes into the group
  const chunks = makeChunkManager(group, { castR: CAST_R, maxCells: MAX_CELLS });
  const nightList = [];   // [material, prop, dayValue, nightValue]
  const night = (m, prop, d, n) => nightList.push([m, prop, d, n]);

  // the sun and sky the terrain and the water add by hand, read once a frame
  const light = makeSkyLight();
  const terrain = buildTerrain3D(world, chunks, { light });
  // The far albedo (the painted map the terrain is coloured from, about 0.1-0.3 s to paint) is painted just after
  // the first frame, which the title screen covers, so the page comes up that much sooner.
  setTimeout(() => {
    try { terrain.setAlbedo(farAlbedo(world)); } catch (e) { console.warn('v2 city: no far albedo here, the terrain stays plain', e); }
  }, 0);
  // the spawn area's fine ground is ready before the first frame (and its shader is in the prewarm)
  const home = places.home?.foot;
  if (home) terrain.buildAround(home.x / PX, home.y / PX, LOD0_R);
  const coast = buildCoast3D(world, group, { chunks, light });
  sea = coast.sea;
  yachts.length = 0;
  yachts.push(...coast.yachts);

  const mats = sharedMaterials(night, terrain);
  buildRoads3D(world, chunks, mats);
  registerBuildings(world, chunks);
  props = buildProps3D(world, chunks) || null;
  lampHeads.length = 0;
  if (props?.lampHeads) lampHeads.push(...props.lampHeads);
  const marks = buildLandmarks(world, group, chunks) || null;

  scene.add(group);

  // the vegetation: trees and shrubs from the first frame, the palms and ground plants with their models
  const flora = buildFlora3D(world, group, { light });

  let nightK = 0, last = null;
  return {
    group, chunks, terrain, coast, flora,
    // The facade (city.js) runs chunks.update first, so the cells it just switched are drawn this frame.
    update(cam, t) {
      const dt = last == null ? 0 : Math.min(0.25, Math.max(0, t - last));
      last = t;
      light.update(group);
      terrain.update(cam, dt);
      coast.update(t);
      flora.update(cam, t);
      props?.update?.(cam, t, nightK);
      marks?.update?.(t, nightK);
    },
    setNight(k) {
      nightK = k;
      for (const [m, prop, d, n] of nightList) m[prop] = d + (n - d) * k;
    },
    stats() {
      const f = flora.stats();
      return { terrain: terrain.stats(), coast: coast.stats(), chunks: chunks.stats(), palms: f.palms, trees: f.trees, shrubs: f.shrubs, far: f.far, nature: f.scatter, flora: { placeMs: f.placeMs, buildMs: f.buildMs } };
    },
  };
}
