// Shared harness for the S1c node tests (tools/s1c_*.mjs): loads the game's sim modules in plain node, with
// the browser-only modules they import (ui, audio, combat, gunsfx) replaced by small stubs, and gives the
// tests a seeded Math.random and a few driving helpers. Not a test itself.
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const STUBS = {
  'ui.js': 'export const toast = () => {};',
  'audio.js': 'const f = () => {}; export const sfx = new Proxy({}, { get: () => f }); export const audio = {};',
  'combat.js': 'export const giveWeapon = () => {}; export const clearLine = () => true;',
  'gunsfx.js': 'export const setSiren = () => {}; export const gunSfx = {};',
};
const HOOKS = `
const STUBS = ${JSON.stringify(STUBS)};
export async function resolve(spec, ctx, next) {
  const name = spec.split('/').pop();
  if (spec.startsWith('.') && ctx.parentURL && ctx.parentURL.includes('/src/') && STUBS[name])
    return { url: 'data:text/javascript,' + encodeURIComponent(STUBS[name]), shortCircuit: true };
  return next(spec, ctx);
}`;
let hooked = false;
function hook() {
  if (hooked) return;
  hooked = true;
  register('data:text/javascript,' + encodeURIComponent(HOOKS));
  globalThis.Image = class { set src(v) {} };                  // entities.js loads Kimchi's 2D sprite
  const store = new Map();
  globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
}

// A seeded Math.random (mulberry32), so a soak can be replayed.
const realRandom = Math.random;
export function seed(s) {
  Math.random = () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const unseed = () => { Math.random = realRandom; };

// One copy of the game's sim: the world (generated), state, entities, missions and police, plus nav when the
// copy has it. root is the project folder (this one, or an untouched baseline copy).
export async function loadGame(root = ROOT) {
  hook();
  const u = f => pathToFileURL(path.join(root, 'src', f)).href;
  const world = await import(u('world.js'));
  world.generate();
  const [state, ent, mis, pol] = await Promise.all([import(u('state.js')), import(u('entities.js')), import(u('3d/missions.js')), import(u('3d/police.js'))]);
  let nav = null;
  try { nav = await import(u('sim/nav.js')); } catch { /* the baseline has no nav */ }
  const log = { big: [], notice: [], sound: [] };
  const ui = { big: (...a) => log.big.push(a), sub() {}, notice: t => log.notice.push(t), sound: t => log.sound.push(t) };
  mis.initMissions(ui);
  state.G.notice = t => log.notice.push(t);
  return { root, world, G: state.G, state, ent, mis, pol, nav, log };
}

// A fresh play state: Kimchi standing at (x, y) on foot, nothing else in the world.
export function freshPlay(game, x, y) {
  const { G, state } = game;
  state.resetState?.();
  Object.assign(G, { mode: 'play', t: 0, cars: [], peds: [], friends: [], wanted: 0, evadeT: 0, heatT: 0, energy: 100, money: 1e6 });
  Object.assign(G.player, { x, y, car: null, dead: false, moving: false });
  game.pol.resetPolice?.();
  game.mis.resetMissions?.();
}

// Put Kimchi in a new car at (x, y) heading a.
export function playerCar(game, type, x, y, a) {
  const c = game.ent.makeCar(type, x, y, a);
  game.G.cars.push(c);
  Object.assign(game.G.player, { car: c, x, y });
  return c;
}

// Advance the sim by one step, the way main3d.update orders it (without the player's input).
export function step(game, dt, { player = true, world = true, police = true, missions = true } = {}) {
  const { G, ent, pol, mis } = game;
  G.t += dt;
  if (player) ent.updatePlayer(dt, {});
  if (world) ent.updateWorld(dt);
  if (police) pol.updatePolice(dt);
  if (missions) mis.updateMissions(dt);
}

export const px = m => m * 16;
export const m = p => p / 16;
