// The city facade (docs/map-v2-spec.md §7). The rest of the 3D game imports the city from here, and it
// forwards to the renderer for the map the world facade picked: cityGrid.js for the classic grid, cityV2.js
// for Kimchi Key v2. The names that depend on the built city are live bindings, assigned again once
// buildCity has run, so a module that imported them early still sees the built meshes and lists.
import * as CG from './cityGrid.js';
import * as CV from './cityV2.js';
import { KIND, BOUNDS, PX_PER_M, groundY } from '../world.js';
import { shadowFocus } from './chunks.js';

const C = KIND === 'v2' ? CV : CG;

export const S = 1 / PX_PER_M;   // metres per sim pixel
// the map in metres (x east, z south from the north-west corner), and its longer side
export const WORLD_M = { w: (BOUNDS.x1 - BOUNDS.x0) * S, h: (BOUNDS.y1 - BOUNDS.y0) * S };
export const MAP = Math.max(WORLD_M.w, WORLD_M.h);
// height (m) of the walkable surface at a sim point: curbs, lawns, hills and decks
export const surfaceY = groundY;

// occluderTop(xm, zm): the highest thing at a point (m) a camera or a bullet cannot pass through
// nearestLamps(xm, zm, n, out): the n lamp heads nearest a point, nearest first
export let occluderTop = C.occluderTop, nearestLamps = C.nearestLamps, clearTreesForCamera = C.clearTreesForCamera;
export let lampHeads = C.lampHeads, fountains = C.fountains, sea = C.sea, mountains = C.mountains, yachts = C.yachts;

const MAX_DT = 0.25;   // s: a longer gap between frames (a hidden tab) counts as this much for the chunk manager

// Builds the city into the scene: { group, update(cam, t), setNight(k), chunks }.
// update(cam, t) runs the city's chunk manager (src/3d/chunks.js) before the city's own update: what is drawn
// near the camera, what casts shadows near the shadow focus (the sun's target, which sky.js keeps on the
// player), and the build queue's look-ahead, timed by the game clock t.
export function buildCity(scene) {
  const city = C.buildCity(scene);
  ({ occluderTop, nearestLamps, clearTreesForCamera, lampHeads, fountains, sea, mountains, yachts } = C);
  const { chunks } = city;
  if (!chunks) return city;
  const focus = shadowFocus(city.group);
  let last = null;
  return {
    ...city,
    update(cam, t) {
      const dt = last == null ? 0 : Math.min(MAX_DT, Math.max(0, t - last));
      last = t;
      chunks.update(cam, focus(), dt);
      city.update(cam, t);
    },
  };
}
