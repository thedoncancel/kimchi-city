#!/usr/bin/env node
// Stage S0d: the save fields for Kimchi Key v2 (docs/map-v2-spec.md §6.6) round-trip through save.js.
//   node tools/test_s0d_save.mjs
// Runs src/state.js and src/save.js in node on the default (grid) world with a small localStorage, and checks
// the mapVer, pr and seen.v2welcome defaults, that old saves load with them filled in, that a save → load →
// save cycle (a 2D session after a 3D one, or the other way round) keeps every pr record, including tables
// this build does not know, and that nothing else in the save changes.
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: k => { store.delete(k); },
};
const KEY = 'kimchi-city-save-v1';

const { G, resetState, newPr } = await import('../src/state.js');
const { save, load } = await import('../src/save.js');
const { MAP_VERSION, KIND } = await import('../src/world.js');

let failed = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
}
const EMPTY_PR = { traps: {}, zones: {}, jumps: {}, events: {}, found: {} };
const stored = () => JSON.parse(store.get(KEY));

// ---- defaults ----
check('world is the grid in node', KIND === 'grid' && MAP_VERSION === 1, `${KIND} ${MAP_VERSION}`);
resetState();
check('new game: mapVer is the map version', G.mapVer === MAP_VERSION);
check('new game: pr has the five empty tables', eq(G.pr, EMPTY_PR), JSON.stringify(G.pr));
check('new game: seen.v2welcome is false', G.seen.v2welcome === false);
const prA = G.pr;
resetState();
check('resetState gives a fresh pr each time', G.pr !== prA && G.pr.traps !== prA.traps);

// ---- newPr merging ----
check('newPr(undefined) is empty', eq(newPr(), EMPTY_PR));
check('newPr fills missing and broken tables', eq(newPr({ traps: { t1: { kmh: 190 } }, zones: null, jumps: [], events: 5 }),
  { ...EMPTY_PR, traps: { t1: { kmh: 190 } } }));
check('newPr keeps tables it does not know', eq(newPr({ drift: { d1: 4200 } }), { drift: { d1: 4200 }, ...EMPTY_PR }));
check('newPr ignores a non-object', eq(newPr([1, 2]), EMPTY_PR) && eq(newPr('x'), EMPTY_PR) && eq(newPr(null), EMPTY_PR));
const src = { traps: { t1: { kmh: 190 } } };
const copy = newPr(src);
copy.traps.t2 = { kmh: 1 };
check('newPr copies, so the source is untouched', !('t2' in src.traps));

// ---- save writes the fields ----
resetState();
check('save() succeeds', save() === true);
let d = stored();
check('save has mapVer', d.mapVer === MAP_VERSION, String(d.mapVer));
check('save has pr', eq(d.pr, EMPTY_PR), JSON.stringify(d.pr));
check('save has seen.v2welcome', d.seen && d.seen.v2welcome === false);

// ---- a pre-v2 save (written before this stage, no mapVer or pr) ----
const OLD = {
  money: 123456, energy: 77, time: 600, day: 4, inv: { kimbap: 2 }, owned: ['ursa', 'gwagen'], equipped: {},
  jars: [0, 3, 7], stats: { deliveries: 5, carjacks: 1, takedowns: 0, busted: 0, wasted: 2, missions: 3 },
  seen: { drive: true, jar3: true }, fs: {}, health: 90, armor: 10, weapons: { fists: true, pistol: true },
  ammo: { pistol: 30 }, clip: { pistol: 12 }, weapon: 'pistol', story: { done: ['first_day'] },
  followers: 210000, paint: {}, posted: { beach: 1 }, assets: {}, trips: 2, lux: true,
};
store.set(KEY, JSON.stringify(OLD));
resetState();
check('old save loads', load() === true);
check('old save: mapVer defaults to 1 (the grid)', G.mapVer === 1, String(G.mapVer));
check('old save: pr defaults to empty tables', eq(G.pr, EMPTY_PR), JSON.stringify(G.pr));
check('old save: seen keeps its flags and gains v2welcome:false', eq(G.seen, { v2welcome: false, drive: true, jar3: true }), JSON.stringify(G.seen));
check('old save: money, jars, story and garage intact', G.money === 123456 && eq([...G.jars], [0, 3, 7])
  && eq(G.story.done, ['first_day']) && eq(G.owned, ['ursa', 'gwagen']) && G.weapon === 'pistol');
save();
d = stored();
for (const k of Object.keys(OLD)) {
  if (k === 'seen' || k === 'fs') continue;
  if (!eq(d[k], k === 'stats' ? { ...OLD.stats } : OLD[k])) check(`old save field '${k}' survives load + save`, false, `${JSON.stringify(OLD[k])} -> ${JSON.stringify(d[k])}`);
}
check('old save fields survive load + save', true);
check('old save gains mapVer and pr on its next save', d.mapVer === MAP_VERSION && eq(d.pr, EMPTY_PR));

// ---- round trip: records made in one session survive the other page's load and save ----
resetState();
G.money = 999; G.jars.add(4); G.seen.v2welcome = true;
G.pr.traps.t_runway = { kmh: 241.5, at: 12 };
G.pr.zones.z_heights = { avg: 131 };
G.pr.jumps.j_port = { m: 48.2, air: 1.7 };
G.pr.events.bay_loop = { best: 98.4, medal: 'gold' };
G.pr.found.fest = true;
G.pr.future = { x1: 'kept' };            // a table a later build adds
G.pr.traps.t_runway.note = 'kept too';    // a field this build does not know
const before = JSON.parse(JSON.stringify(G.pr));
save();
for (let session = 0; session < 3; session++) { resetState(); load(); save(); }   // 3D -> 2D -> 3D
resetState();
load();
check('pr round-trips through three load + save cycles', eq(G.pr, before), JSON.stringify(G.pr));
check('seen.v2welcome:true survives', G.seen.v2welcome === true);
check('mapVer survives', G.mapVer === MAP_VERSION && stored().mapVer === MAP_VERSION);
check('other fields survive', G.money === 999 && G.jars.has(4));

// ---- a save from a v2 session (mapVer 2) keeps its pr on a grid session ----
store.set(KEY, JSON.stringify({ ...OLD, mapVer: 2, pr: { traps: { a: { kmh: 300 } }, found: { fest: true } } }));
resetState();
load();
check('a v2 save loads its mapVer', G.mapVer === 2);
check('a v2 save loads its pr with the missing tables filled', eq(G.pr, { traps: { a: { kmh: 300 } }, found: { fest: true }, zones: {}, jumps: {}, events: {} }), JSON.stringify(G.pr));
save();
d = stored();
check('saving on the grid stamps mapVer 1 and keeps pr', d.mapVer === 1 && G.mapVer === 1 && d.pr.traps.a.kmh === 300 && d.pr.found.fest === true);

// ---- broken pr in storage never breaks loading ----
store.set(KEY, JSON.stringify({ ...OLD, pr: 'nonsense', mapVer: null }));
resetState();
check('a broken pr still loads', load() === true && eq(G.pr, EMPTY_PR) && G.mapVer === 1);

console.log(failed ? `${failed} check(s) failed` : 'all S0d save checks passed');
process.exit(failed ? 1 : 0);
