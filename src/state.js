import { FRIENDS, ITEMS } from './data.js';
import { MAP_VERSION } from './world.js';
import { pick } from './util.js';

export const G = {
  mode: 'title',      // title | play
  menu: null,         // function that builds the open menu, or null
  bigMap: false,
  t: 0,
  player: { x: 0, y: 0, face: 1, walkT: 0, moving: false, running: false, car: null },
  cars: [], peds: [], friends: [],
  target: null,
  cam: { x: 0, y: 0, z: 1 },
  shake: 0,
  ownedCar: null,
};

export function resetState() {
  Object.assign(G, {
    // Kimchi already lives the luxury life: a villa, a black super-SUV and a following
    money: 150000, energy: 100, time: 9 * 60, day: 1,
    inv: {}, owned: ['ursa'], equipped: {},
    followers: 197500, paint: {}, posted: {}, assets: {}, trips: 0, lux: true,
    jars: new Set(), job: null,
    stats: { deliveries: 0, carjacks: 0, takedowns: 0, busted: 0, wasted: 0, missions: 0 },
    seen: { v2welcome: false },   // one-time hints already shown; v2welcome: the Kimchi Key v2 welcome toast
    fs: {},
    // GTA layer (3D game)
    health: 100, armor: 0,
    wanted: 0, evadeT: 0,
    weapons: { fists: true }, ammo: {}, clip: {}, weapon: 'fists',
    story: { done: [] }, mission: null,
    // Kimchi Key v2 (docs/map-v2-spec.md §6.6): the map this game was last saved on (1 grid, 2 v2; for
    // information only) and the open-world progress records
    mapVer: MAP_VERSION, pr: newPr(),
  });
  for (const f of FRIENDS) G.fs[f.id] = { lvl: 0, talked: 0, request: newRequest(), requestDone: false };
}

// Open-world progress: speed traps, zones, jumps, events and found hubs, each a table keyed by id.
// newPr(saved) copies a saved record and fills in any missing table. Tables and fields this build does
// not know are kept, so a session on an older build (or in 2D) never drops what a newer one recorded.
const PR_TABLES = ['traps', 'zones', 'jumps', 'events', 'found'];
const isTable = v => v != null && typeof v === 'object' && !Array.isArray(v);
export function newPr(saved) {
  const pr = isTable(saved) ? { ...saved } : {};
  for (const k of PR_TABLES) pr[k] = isTable(pr[k]) ? { ...pr[k] } : {};
  return pr;
}

export function newRequest() {
  return pick(Object.keys(ITEMS).filter(k => ITEMS[k].req));
}

// 0 = day, ~0.65 = darkest night
export function nightLevel() {
  const h = G.time / 60;
  if (h >= 7 && h < 18) return 0;
  if (h >= 18 && h < 20.5) return ((h - 18) / 2.5) * 0.65;
  if (h >= 5 && h < 7) return (1 - (h - 5) / 2) * 0.65;
  return 0.65;
}

export function clockText() {
  const m = Math.floor(G.time) % 1440;
  let h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${mm} ${ap}`;
}

resetState();
