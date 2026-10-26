#!/usr/bin/env node
// Kimchi Key v2 map checks (docs/map-v2-spec.md §11.2), headless:   node tools/map_check.mjs
// It runs the game's own v2 generator (src/world-v2.js, cold, as the browser does) and checks what it built:
//  - roads and terrain (stage S2a): lengths and radii against §4.3, the 21 Loop T's of §4.4 and the
//    crossings, the authored grades of §4.3, class grades (a road's maxGrade overrides its class: the two
//    steep avenues up to the Loop) and cut/fill (§3), that bridge decks only sit over water (§4.5), and the
//    terrain build time;
//  - the world (stage S2b): the 14 places against the §5.1 table (door, foot, curb, the garage, display and
//    police spots, the plane and the pier), every curb reachable by car from the villa and every giver,
//    hangout, jar and photo spot on foot, friends' hangouts beside a traffic lane, every place's approach (the
//    drive from a traffic lane to its curb, paved where the curb is over 12 m from a lane), the AI lane graph
//    strongly connected, the sidewalk paths off the carriageways, the SL1-SL3 sightlines of §4.7 (with the
//    villa terrace's view of K-Town and the bay) and Kimchi Tower as a building, GROUND under everything
//    people stand on (nothing walkable or drivable below the sea, decks clear of the water, every bridge
//    deck at its banked road height across the carriageway, jars and photo spots above the waterline),
//    buildings (no overlaps, none on a road, 450 at most), regions covering the land and the bridges, the
//    race routes, a second generator run giving the same rasters, and the generate time (450 ms target;
//    over 900 ms fails).
// It writes tools/out/map_v2.png (the map picture with places, jars, photo spots, landmarks and labels),
// tools/out/terrain.png (hillshade plus roads by class) and tools/out/summary.json, and exits 1 if
// anything fails.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as D from '../src/map/mapdata.js';
import { sampleCurve, minRadius, nearestOnCurve } from '../src/map/spline.js';
import { KIND, KIND_MASK, FLAG, CURB, sampleGrid } from '../src/map/raster.js';
import { mapPixels } from '../src/map/mapimage.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
const PX = 16;
const fails = [], warns = [], notes = [];
const fail = m => fails.push(m), warn = m => warns.push(m), note = m => notes.push(m);
const f1 = v => v.toFixed(1);

// ---------- what the spec measured ----------
// §4.3: length (m), min radius (m) and max grade (%) of the authored roads; grades only where the spec
// gives a number ("flat" roads follow the flattened districts). The table measured south_pointe before
// its end moved to the marina; its fifth point was moved to keep the street radius (see mapdata.js), so
// its row is the corrected road's. crest_rd's row is the road after F3 straightened its climb to the knoll
// for j_crest (§4.3: 532 m, min R 29.6 m in the S-bend that is gone).
const MEASURED = {
  loop: [4283, 105.5, 5.7], switchbacks: [867, 12.3, 11.7], heights_dr: [318, 121, 10.3], crest_rd: [526.8, 42.6, 11.6],
  granada: [846, 42.7], nw_crescent: [141, 50.6], ring: [264, 38.9], alhambra: [228, 40], south_pointe: [177, 15.2],
  star_ring: [316, 17], port_yard: [314, 15.6], key_loop: [881, 30.7], fest_ring: [701, 26.1], a1a: [668, 78.7],
  gator_run: [466, 55.1], rickenbacker: [221, 371, 6.2],
};
// §4.3 class totals (m); street is 22 m shorter with the south_pointe fix, country 5 m with Crest Road's straight
const TOTALS = { hwy: 4283, street: 5537 - 22, ave: 3970, coast: 2190, blvd: 1444, switch: 867, country: 850 - 5, dirt: 676, ring: 264, alley: 48 };
// §4.4: Loop T junctions: station (m from the first point, in travel order), the side road, the side it leaves on
const LOOP_TS = [
  [70, 'miami_ave', 'R'], [256, 'festival_way', 'L'], [371, 'granada', 'R'], [844, 'a1a', 'L'], [1083, 'coral_way', 'R'],
  [1296, 'a1a', 'L'], [1525, 'switchbacks', 'L'], [1928, 'heights_dr', 'L'], [2036, 'crest_rd', 'L'], [2105, 'seoul_ave', 'R'],
  [2240, 'miami_ave', 'R'], [2389, 'crest_rd', 'L'], [2462, 'biscayne', 'R'], [2975, 'st71', 'L'], [3113, 'st41', 'L'],
  [3253, 'venetian', 'R'], [3394, 'lincoln', 'L'], [3513, 'st15', 'L'], [3639, 'st5', 'L'], [3857, 'star_spur', 'R'],
  [4123, 'rickenbacker', 'L'],
];
// §4.5: bridge spans as road stations (m): the water part, without the 6 m abutments
const SPANS = {
  loop: [[2506, 2893], [3718, 3766], [3958, 3996]],
  venetian: [[27, 71], [131, 168], [234, 271], [332, 411]],
  rickenbacker: [[39, 199]],
};
// §3: the Heights Pass cutting may cut up to 12 m; every other cut or fill is held to 10 m. The cutting
// is the Loop between these stations and anything within r metres of it, so Heights Drive and Crest
// Road share it where they join the Loop inside it.
const PASS = { s0: 1850, s1: 2250, r: 40, cut: 12 };
const CUT_FILL = 10;
// §4.3's own crest_rd measures 29.6 m against the 30 m country floor and the spec accepted it, so a class
// floor fails only when it is missed by more than this share.
const R_SLACK = 0.02;
// Seoul Ave and the north end of Miami Ave are deliberate steep climbs up to the Loop (lead decision): such a
// road carries maxGrade (and steep: true) in mapdata, which replaces its class grade here.
const T_BUDGET = 150;      // ms for buildTerrain (stage S2a verify)
const GEN_TARGET = 450, GEN_LIMIT = 900;   // ms for generate() cold in node: the §11.2 target, and what fails

// ---------- what the S2b checks compare with ----------
// §5.1: door, foot and curb of every place (m), as the spec computed them from the prefabs. The villa's curb
// falls in its pool, so the generator moves it to the nearest cell a car can use (checked separately).
const PLACE_TABLE = {
  home: { door: [331.8, 262.6], foot: [333.7, 263.6], curb: [340.5, 267.4] },
  park: { door: [870, 564.4] },
  mart: { door: [956, 538.9], foot: [956, 541.1], curb: [956, 548.9] },
  kimchi: { door: [891.1, 653], foot: [888.9, 653], curb: [881.1, 653] },
  yuna: { door: [815.7, 872], foot: [813.8, 873.1], curb: [807, 877] },
  dealer: { door: [888, 1390.1], foot: [888, 1387.9], curb: [888, 1380.1] },
  police: { door: [1058, 731.1], foot: [1058, 728.9], curb: [1058, 721.1] },
  hospital: { door: [1216.8, 890], foot: [1219, 890], curb: [1226.8, 890] },
  spray: { door: [1085.4, 1030], foot: [1087.6, 1030], curb: [1095.4, 1030] },
  guns: { door: [1136.6, 1030], foot: [1134.4, 1030], curb: [1126.6, 1030] },
  watches: { door: [1711, 818.9], foot: [1711, 821.1], curb: [1711, 828.9] },
  fashion: { door: [1711, 861.1], foot: [1711, 858.9], curb: [1711, 851.1] },
  jet: { door: [1052, 1432.4], foot: [1052, 1434.6], curb: [1052, 1442.4] },
  marina: { door: [1672.6, 1201], foot: [1670.4, 1201], curb: [1662.6, 1201] },
};
const GARAGE = [[325.2, 241.7], [328, 236.6], [332.6, 245.7], [335.3, 240.6], [339.9, 249.7], [342.7, 244.6], [347.3, 253.8], [350.1, 248.7]];
const DISPLAY = [[894.8, 1385.9], [885.4, 1385.9], [876, 1385.9], [866.6, 1385.9], [890.2, 1376.9], [880.8, 1376.9], [871.4, 1376.9]];
const POLICE_SPOTS = [[1070, 724.5], [1058, 724.5], [1046, 724.5]];
const PLANE = [1032.4, 1438.6, -Math.PI / 2], PIER = { x: 1650, z: 1205, a: Math.PI, len: 48 };
const FRIEND_HOMES = ['park', 'mart', 'yuna', 'dealer'];     // mochi, bao, yuna and dex hang out here (§5.1)
const TOL = 0.5, CURB_MOVE = 3, HANGOUT_LANE = 14, CURB_DOOR = 12;
// place.approach: a curb further than CURB_LANE from a lane needs a paved drive; what a car may drive on
const CURB_LANE = 12, APPROACH_PAVED = new Set([KIND.ROAD, KIND.LOT, KIND.PLAZA, KIND.WALK, KIND.DECK, KIND.DIRT]);
const CAR_KINDS = new Set([KIND.ROAD, KIND.WALK, KIND.GRASS, KIND.LOT, KIND.PLAZA, KIND.SAND, KIND.DIRT, KIND.DECK]);
// GROUND: a bridge deck stays within DECK_TOL of its banked road surface across the carriageway; a deck over
// water stands at least DECK_CLEAR over it; jars and photo spots stand SPOT_CLEAR over the sea. Beach sand is
// the one surface allowed under the sea level, by SAND_DIP at most: its last cell blends with the sea floor,
// which starts at −1.5 m.
const DECK_TOL = 0.3, DECK_CLEAR = 1, SPOT_CLEAR = 0.5, SAND_DIP = 0.6;

// Sightlines the authored map cannot give, reported as warnings: the lead accepted SL2 as a warning (§12.3).
const SL_CONFLICTS = {
  'SL2 kimchi_tower': '§4.7 gives −28°, the bearing from a car heading due west at (1560,311), but the Loop still bends there ' +
    '(its tangent points about 8° off due west), so against the road tangent the tower sits past ±30°; it stays inside the chase ' +
    'camera\'s ±47° field of view (accepted by the lead as a warning)',
};
// The targets live in mapdata (lots.js keeps its lots under the same rays). Kimchi Tower is a building in OCC,
// so its ray stops r = 23 m short, past the corners of its 32 m square.
const SL_TARGETS = D.SIGHT_TARGETS;
const TOWER_R = 23;
// the label font: 7 rows of 5 bits per glyph, as hex
const FONT = {
  A: '0e11111f111111', B: '1e11111e11111e', C: '0e11101010110e', D: '1e11111111111e', E: '1f10101e10101f', F: '1f10101e101010',
  G: '0e11101711110f', H: '1111111f111111', I: '0e04040404040e', J: '0702020202120c', K: '11121418141211', L: '1010101010101f',
  M: '111b1515111111', N: '11111915131111', O: '0e11111111110e', P: '1e11111e101010', Q: '0e11111115120d', R: '1e11111e141211',
  S: '0f10100e01011e', T: '1f040404040404', U: '1111111111110e', V: '11111111110a04', W: '1111111515150a', X: '11110a040a1111',
  Y: '1111110a040404', Z: '1f01020408101f', 0: '0e11131519110e', 1: '040c040404040e', 2: '0e11010204081f', 3: '1f02040201110e',
  4: '02060a121f0202', 5: '1f101e0101110e', 6: '0608101e11110e', 7: '1f010204080808', 8: '0e11110e11110e', 9: '0e11110f01020c',
  '-': '0000001f000000', '.': '00000000000c0c', "'": '0c040800000000', '&': '0c12140815120d', '/': '01010204081010', ' ': '00000000000000',
};

// ---------- run ----------
// The generator first, before anything else warms the JIT, so its time is the cold time the game sees.
const t0 = performance.now();
const W = await import('../src/world-v2.js');
const rep = W.generate({ debug: true });
const terrain = rep.debug.terrain, profiles = rep.debug.profiles, net = W.roads;
// a second, separate run of the same module: the rasters must come out bit for bit the same
const W2 = await import('../src/world-v2.js?second-run');
const rep2 = W2.generate();
const curves = new Map(D.ROADS.map(r => [r.id, sampleCurve(r.pts, { closed: !!r.closed, step: 1, chord: D.ROAD_CLASSES[r.cls].chord })]));
checkGeometry();
checkJunctions(net);
const grades = checkProfiles(profiles);
checkDecks(profiles);
checkEdges(net);
const tBuild = rep.timing.terrain;
const timing = { buildTerrain: Math.round(tBuild), profilesAndCarve: Math.round(rep.timing.profiles + rep.timing.carve), coast: Math.round(rep.timing.coast), natural: Math.round(rep.timing.natural) };
// buildTerrain's own budget is reported only; generate's total (checkGenerate) is what can fail
if (tBuild > T_BUDGET) warn(`terrain build took ${tBuild.toFixed(0)} ms (budget ${T_BUDGET} ms): ${JSON.stringify(timing)}`);
else note(`terrain build ${tBuild.toFixed(0)} ms, then profiles + carve ${timing.profilesAndCarve} ms ${JSON.stringify(timing)}`);

const surf = W.grids.surf, SW = W.grids.w, SH = W.grids.h;
const reach = { car: flood(FLAG.BLOCK_CAR, W.places.home.curb), foot: flood(FLAG.BLOCK_FOOT, W.places.home.foot) };
const hashes = [rasterHash(W.grids), rasterHash(W2.grids)];
const world = {
  hash: hashes, places: checkPlaces(), spots: checkSpots(), lanes: checkLanes(), walks: checkWalks(), sightlines: checkSightlines(),
  ground: checkGround(), buildings: checkBuildings(), regions: checkRegions(), routes: checkRoutes(), generate: checkGenerate(),
};
mkdirSync(OUT, { recursive: true });
writePng(join(OUT, 'terrain.png'), drawTerrain());
writePng(join(OUT, 'map_v2.png'), drawMap());
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({
  stage: 'S2b', ok: fails.length === 0, fails, warns, notes, timingMs: { terrain: timing, generate: rep.timing, secondRun: rep2.timing.total },
  grades, net: { nodes: net.nodes.length, edges: net.edges.length, lanes: net.lanes.length, conns: net.conns.length }, world,
  issues: rep.issues,
}, null, 2));
for (const m of notes) console.log('  ' + m);
for (const m of warns) console.log('WARN ' + m);
for (const m of fails) console.log('FAIL ' + m);
console.log(`map_check: ${fails.length ? fails.length + ' failure(s)' : 'ok'} (${(performance.now() - t0).toFixed(0)} ms; tools/out/map_v2.png, tools/out/terrain.png, tools/out/summary.json)`);
process.exit(fails.length ? 1 : 0);

// ---------- geometry ----------

function checkGeometry() {
  const totals = {};
  for (const r of D.ROADS) {
    const c = curves.get(r.id), cl = D.ROAD_CLASSES[r.cls];
    totals[r.cls] = (totals[r.cls] || 0) + c.len;
    const R = minRadius(c, cl.chord).r, floor = r.minR ?? cl.minR;
    if (R < floor * (1 - R_SLACK)) fail(`${r.id}: min radius ${f1(R)} m < ${floor} m (${r.cls})`);
    else if (R < floor) note(`${r.id}: min radius ${f1(R)} m, within ${R_SLACK * 100}% of the ${floor} m floor`);
    const m = MEASURED[r.id];
    if (!m) continue;
    if (Math.abs(c.len - m[0]) > Math.max(2, m[0] * 0.005)) fail(`${r.id}: length ${f1(c.len)} m, §4.3 says ${m[0]}`);
    if (Math.abs(R - m[1]) > 1) fail(`${r.id}: min radius ${f1(R)} m, §4.3 says ${m[1]} (±1 m)`);
  }
  for (const [k, v] of Object.entries(TOTALS)) {
    const got = totals[k] || 0;
    if (Math.abs(got - v) > Math.max(3, v * 0.005)) fail(`total ${k}: ${got.toFixed(0)} m, expected ${v}`);
  }
  note('class totals (m): ' + Object.entries(totals).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', '));
}

// ---------- junctions and crossings ----------

function checkJunctions(net) {
  for (const i of net.issues || []) {
    const where = i.x !== undefined ? ` at (${f1(i.x)},${f1(i.z)})` : '';
    if (['unplanned_crossing', 'self_crossing', 'hwy_x', 'deck_x'].includes(i.type)) fail(`roadnet ${i.type}${where}: ${(i.roads || [i.road]).join('/')}`);
    else warn(`roadnet ${i.type}${where}: ${(i.roads || [i.road]).join('/')}`);
  }
  const loop = curves.get('loop'), found = [];
  for (const node of net.nodes) {
    const roads = new Set(node.edges.map(id => net.edges[id].road));
    if (!roads.has('loop')) continue;
    const x = node.x / PX, z = node.y / PX;
    if (node.kind === 'X') fail(`X junction on the Loop at (${f1(x)},${f1(z)}) with ${[...roads].join(', ')}`);
    const at = nearestOnCurve(loop, x, z);
    for (const r of roads) if (r !== 'loop') {
      // the side it leaves on: a point 30 m into the side road against the Loop's right-hand normal
      const c = curves.get(r), first = Math.hypot(c.x[0] - x, c.z[0] - z) < Math.hypot(c.x[c.n - 1] - x, c.z[c.n - 1] - z);
      const i = first ? Math.min(c.n - 1, 30) : Math.max(0, c.n - 31), side = nearestOnCurve(loop, c.x[i], c.z[i]).side > 0 ? 'R' : 'L';
      found.push([at.s, r, side]);
    }
  }
  found.sort((a, b) => a[0] - b[0]);
  if (found.length !== LOOP_TS.length) fail(`${found.length} Loop junctions, §4.4 lists ${LOOP_TS.length}: ${found.map(f => f[1] + '@' + f[0].toFixed(0)).join(' ')}`);
  for (const [s, road, side] of LOOP_TS) {
    const m = found.find(f => f[1] === road && Math.abs(f[0] - s) <= 3);
    if (!m) fail(`no Loop T for ${road} at station ${s} (±3 m); found ${found.filter(f => f[1] === road).map(f => f[0].toFixed(1)).join(', ') || 'none'}`);
    else if (m[2] !== side) fail(`Loop T ${road}@${s} leaves on the ${m[2]}, §4.4 says ${side}`);
  }
  for (let i = 0; i < found.length; i++) for (let j = i + 1; j < found.length; j++) {
    const d = Math.min(Math.abs(found[i][0] - found[j][0]), loop.len - Math.abs(found[i][0] - found[j][0]));
    if (found[i][2] !== found[j][2] && d < 65) fail(`opposite-side Loop T's ${found[i][1]}@${found[i][0].toFixed(0)} and ${found[j][1]}@${found[j][0].toFixed(0)} are ${d.toFixed(0)} m apart (< 65)`);
  }
  const kinds = {};
  for (const n of net.nodes) kinds[n.kind] = (kinds[n.kind] || 0) + 1;
  note(`junctions: ${net.nodes.length} nodes ${JSON.stringify(kinds)}, ${found.length} T's on the Loop at the §4.4 stations`);
  for (const [x, z] of D.SIGNALS.candidates) {
    if (!net.nodes.some(q => Math.hypot(q.x / PX - x, q.y / PX - z) <= 3)) fail(`signal candidate (${x},${z}) is not on a junction`);
  }
}

// ---------- profiles: grades and cut/fill ----------

function checkProfiles(profiles) {
  const out = {};
  for (const r of D.ROADS) {
    const p = profiles.get(r.id), cl = D.ROAD_CLASSES[r.cls];
    const design = maxGrade(p.design, p.ds, p.closed), final = maxGrade(p.y, p.ds, p.closed);
    let cut = 0, fill = 0, cutAt = 0, fillAt = 0;
    for (let i = 0; i < p.n; i++) {
      if (p.deck[i]) continue;          // bridges are excluded (§3)
      const d = p.y[i] - p.nat[i];
      if (d < cut) { cut = d; cutAt = i * p.ds; }
      if (d > fill) { fill = d; fillAt = i * p.ds; }
    }
    out[r.id] = { designGrade: pct(design.g), grade: pct(final.g), gradeAt: Math.round(final.s), cut: +cut.toFixed(1), cutAt: Math.round(cutAt), fill: +fill.toFixed(1), fillAt: Math.round(fillAt) };
    const m = MEASURED[r.id], lim = r.maxGrade ?? cl.grade;
    if (m && m[2] !== undefined && Math.abs(design.g * 100 - m[2]) > 0.3) fail(`${r.id}: authored max grade ${pct(design.g)}%, §4.3 says ${m[2]}% (±0.3)`);
    if (final.g > lim + 0.003) fail(`${r.id}: max grade ${pct(final.g)}% at station ${final.s.toFixed(0)} > ${+(lim * 100).toFixed(1)}% (${r.maxGrade ? 'its maxGrade' : r.cls})`);
    else if (final.g > cl.grade + 0.003) note(`${r.id}: steep by design, ${pct(final.g)}% at station ${final.s.toFixed(0)} (allowed ${+(lim * 100).toFixed(1)}%, ${r.cls} ${cl.grade * 100}%)`);
    const cutLim = inPass(p, cutAt) ? PASS.cut : CUT_FILL;
    if (-cut > cutLim) fail(`${r.id}: cut ${(-cut).toFixed(1)} m at station ${cutAt.toFixed(0)} (> ${cutLim})`);
    if (fill > CUT_FILL) fail(`${r.id}: fill ${fill.toFixed(1)} m at station ${fillAt.toFixed(0)} (> ${CUT_FILL})`);
  }
  note('authored grades (%): ' + ['loop', 'switchbacks', 'heights_dr', 'crest_rd', 'rickenbacker'].map(id => `${id} ${out[id].designGrade} (§4.3 ${MEASURED[id][2]})`).join(', '));
  note('cut/fill (m): ' + ['loop', 'switchbacks', 'heights_dr', 'crest_rd'].map(id => `${id} ${out[id].cut}/+${out[id].fill}`).join(', ') + ' (§3: loop −10.2, switchbacks −7.8, heights_dr −9.0, crest_rd −6.9)');
  return out;
}

function inPass(p, s) {
  const i = Math.min(p.n - 1, Math.round(s / p.ds)), at = nearestOnCurve(curves.get('loop'), p.curve.x[i], p.curve.z[i]);
  return at.d <= PASS.r && at.s >= PASS.s0 && at.s <= PASS.s1;
}

function maxGrade(y, ds, closed) {
  const n = y.length;
  let g = 0, s = 0;
  for (let i = 1; i < (closed ? n + 1 : n); i++) {
    const v = Math.abs(y[i % n] - y[i - 1]) / ds;
    if (v > g) { g = v; s = i * ds; }
  }
  return { g, s };
}
function pct(g) { return +(g * 100).toFixed(2); }

// ---------- bridges ----------

function checkDecks(profiles) {
  const below = D.SEA_LEVEL + D.BRIDGE_RULE.below;
  for (const r of D.ROADS) {
    const p = profiles.get(r.id), want = SPANS[r.id] || [], ab = D.BRIDGE_RULE.abutment;
    // the water under the road, and the decks the profile laid (water + abutments)
    const wet = Uint8Array.from(p.nat, v => (v < below ? 1 : 0));
    const water = runs(wet, p.closed).map(([a, b]) => [a * p.ds, b * p.ds]), decks = runs(p.deck, p.closed).map(([a, b]) => [a * p.ds, b * p.ds]);
    for (const [a, b] of decks) {
      // a deck sits over water, apart from its abutments
      if (!water.some(([w0, w1]) => w0 >= a - 1 && w1 <= b + 1)) fail(`${r.id}: deck ${a.toFixed(0)}-${b.toFixed(0)} m has no water under it`);
      let dry = 0;
      for (let i = Math.round((a + ab) / p.ds); i <= Math.round((b - ab) / p.ds); i++) if (!wet[((i % p.n) + p.n) % p.n]) dry++;
      if (dry > 2) fail(`${r.id}: deck ${a.toFixed(0)}-${b.toFixed(0)} m crosses ${dry} m of land`);
    }
    for (const [a, b] of water) {
      if (!decks.some(([d0, d1]) => d0 <= a + 1 && d1 >= b - 1)) fail(`${r.id}: ${a.toFixed(0)}-${b.toFixed(0)} m runs over water without a deck`);
      if (!want.some(([w0, w1]) => a < w1 + 8 && b > w0 - 8)) fail(`${r.id}: unplanned bridge over water at ${a.toFixed(0)}-${b.toFixed(0)} m`);
    }
    for (const [w0, w1] of want) {
      const m = water.find(([a, b]) => a < w1 + 8 && b > w0 - 8);
      if (!m) fail(`${r.id}: no water under the §4.5 span ${w0}-${w1} m`);
      else if (Math.abs(m[0] - w0) > 3 || Math.abs(m[1] - w1) > 3) fail(`${r.id}: span ${m[0].toFixed(0)}-${m[1].toFixed(0)} m, §4.5 measured ${w0}-${w1} (±3 m)`);
    }
  }
  note('bridge spans over water (m): ' + Object.keys(SPANS).map(id => {
    const p = profiles.get(id);
    return `${id} ` + runs(Uint8Array.from(p.nat, v => (v < below ? 1 : 0)), p.closed).map(([a, b]) => `${(a * p.ds).toFixed(0)}-${(b * p.ds).toFixed(0)}`).join(' ');
  }).join('; '));
}

function runs(flags, closed) {
  const n = flags.length, out = [];
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (flags[i] && start < 0) start = i;
    if ((!flags[i] || i === n - 1) && start >= 0) { out.push([start, flags[i] ? i : i - 1]); start = -1; }
  }
  // a closed road's span across its seam is one span
  if (closed && out.length > 1 && out[0][0] === 0 && out[out.length - 1][1] === n - 1) { const last = out.pop(); out[0] = [last[0] - n, out[0][1]]; }
  return out;
}

// The RoadNet came back filled in: heights on every sample, meeting at each node, and bank inside the limit.
function checkEdges(net) {
  let worst = 0;
  for (const e of net.edges) {
    if (!(e.gy instanceof Float32Array) || e.gy.length !== e.n || e.gy.some(v => !Number.isFinite(v))) { fail(`edge ${e.id} (${e.road}) has no heights`); continue; }
    worst = Math.max(worst, Math.abs(e.gy[0] - net.nodes[e.a].gy), Math.abs(e.gy[e.n - 1] - net.nodes[e.b].gy));
    const lim = D.ROAD_CLASSES[e.cls].bank * Math.PI / 180 + 1e-6;
    if (e.bank.some(b => Math.abs(b) > lim)) fail(`edge ${e.id} (${e.road}) banks past ${D.ROAD_CLASSES[e.cls].bank}°`);
  }
  if (worst > 0.01) fail(`edge ends miss their node heights by up to ${worst.toFixed(2)} m`);
}

// ---------- the world (stage S2b) ----------

function m(p) { return [p.x / PX, p.y / PX]; }
function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function angOff(a, b) { return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))); }
function cellAt(x, z) { const i = Math.floor(x), j = Math.floor(z); return i < 0 || j < 0 || i >= SW || j >= SH ? -1 : j * SW + i; }
function bits(x, z) { const c = cellAt(x, z); return c < 0 ? KIND.WATER | FLAG.BLOCK_CAR | FLAG.BLOCK_FOOT : surf[c]; }

function checkPlaces() {
  const P = W.places, out = {};
  if (Object.keys(P).length !== 14) fail(`${Object.keys(P).length} places, §5.1 lists 14`);
  for (const key of Object.keys(D.PLACES)) {
    const pl = P[key], want = PLACE_TABLE[key], row = {};
    if (!pl) { fail(`place ${key} is missing`); continue; }
    for (const f of ['door', 'foot', 'curb', 'giver', 'hangout']) {
      const p = pl[f];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) { fail(`${key}.${f} is missing`); continue; }
      if (['door', 'foot', 'curb'].includes(f) && !Number.isFinite(p.a)) fail(`${key}.${f} has no heading`);
      row[f] = m(p).map(v => +v.toFixed(2));
    }
    for (const f of ['door', 'foot', 'curb']) {
      if (!want?.[f] || !pl[f]) continue;
      const d = dist(m(pl[f]), want[f]);
      row[f + 'Off'] = +d.toFixed(2);
      if (d <= TOL) continue;
      const moved = f === 'curb' && rep.issues.find(i => i.type === 'curb_moved' && i.place === key);
      if (moved && d <= CURB_MOVE) note(`${key}.curb is ${d.toFixed(2)} m from §5.1's (${want.curb}): that point is not drivable, so the generator moved it`);
      else fail(`${key}.${f} at (${row[f]}) is ${d.toFixed(2)} m from §5.1's (${want[f]})`);
    }
    if (pl.curb && pl.door && dist(m(pl.curb), m(pl.door)) > CURB_DOOR) fail(`${key}.curb is ${dist(m(pl.curb), m(pl.door)).toFixed(1)} m from its door (> ${CURB_DOOR})`);
    if (key !== 'park' && !reachable(reach.car, pl.curb)) fail(`${key}.curb (${row.curb}) cannot be reached by car from the villa`);
    row.approach = checkApproach(key, pl);
    if (key !== 'park' && !Number.isFinite(net.routeLength(W.places.home.foot.x, W.places.home.foot.y, pl.curb.x, pl.curb.y))) fail(`${key}.curb has no route from the villa`);
    for (const f of ['door', 'foot', 'giver', 'hangout']) if (pl[f] && !reachable(reach.foot, pl[f])) fail(`${key}.${f} (${row[f]}) cannot be reached on foot from the villa`);
    if (FRIEND_HOMES.includes(key)) {
      const d = laneDist(pl.hangout), auth = D.PLACES[key].hangout, off = dist(m(pl.hangout), auth);
      row.hangoutLane = +d.toFixed(1);
      if (d > HANGOUT_LANE) fail(`${key}.hangout is ${d.toFixed(1)} m from the nearest traffic lane (> ${HANGOUT_LANE})`);
      if (off > 8) fail(`${key}.hangout is ${off.toFixed(1)} m from §5.1's (${auth})`);
      else if (off > TOL) note(`${key}.hangout moved ${off.toFixed(1)} m from §5.1's (${auth}) to (${m(pl.hangout).map(v => v.toFixed(1))}): the authored spot is ${laneDist({ x: auth[0] * PX, y: auth[1] * PX }).toFixed(1)} m from the nearest lane`);
    }
    out[key] = row;
  }
  // the extras (§5.1)
  const spots = (list, table, a, what) => {
    if (!list || list.length !== table.length) { fail(`${what}: ${list ? list.length : 0}, §5.1 lists ${table.length}`); return; }
    list.forEach((s, i) => {
      if (dist(m(s), table[i]) > TOL) fail(`${what}[${i}] at (${m(s).map(v => v.toFixed(1))}) is ${dist(m(s), table[i]).toFixed(2)} m from §5.1's (${table[i]})`);
      if (angOff(s.a, a) > 0.01) fail(`${what}[${i}] faces ${s.a.toFixed(3)}, §5.1 says ${a.toFixed(3)}`);
    });
  };
  spots(P.home?.garage, GARAGE, 0.5, 'home.garage');
  if (P.home && P.home.spawn !== P.home.garage?.[0]) fail('home.spawn is not garage[0]');
  spots(W.displaySpots, DISPLAY, Math.PI / 2, 'displaySpots');
  spots(P.police?.spots, POLICE_SPOTS, Math.PI / 2, 'police.spots');
  const pl = P.jet?.plane;
  if (!pl || dist(m(pl), PLANE) > TOL || angOff(pl.a, PLANE[2]) > 0.01) fail(`jet.plane is not at (${PLANE[0]},${PLANE[1]}) facing −π/2`);
  const pr = P.marina?.pier;
  if (!pr || dist(m(pr), [PIER.x, PIER.z]) > TOL || angOff(pr.a, PIER.a) > 0.01 || Math.abs(pr.len / PX - PIER.len) > TOL) fail('marina.pier is not §5.1\'s {x:1650, z:1205, a:π, len:48}');
  const bay = P.spray?.bay;
  if (!bay || dist(m(bay), [1095.4, 1030]) > TOL || Math.abs(bay.r - 9 * PX) > 1e-6) fail('spray.bay is not at (1095.4,1030) r 9 m');
  if (!P.park?.nomenu) fail('park is not nomenu');
  note(`places: 14 match §5.1 within ${TOL} m (garage 8, display 7, police spots 3, plane, pier, spray bay); curbs reachable by car, givers and hangouts on foot`);
  note('approaches (m of drive from the lane, the road, the curb\'s distance to a lane): ' + Object.entries(out).map(([k, r]) => r.approach ? `${k} ${r.approach.len} ${r.approach.road} ${r.approach.from}` : `${k} -`).join(', '));
  return out;
}

// place.approach (F3): the drive from the nearest traffic lane (not the highway) to the curb, a px polyline.
// It starts on its lane and ends at the curb; a car fits all along it (no cell that blocks cars, no water,
// building, rock or highway, and the cells round it clear too, bar the last metres at the curb); and where the
// curb is more than CURB_LANE from any lane, the whole drive is on pavement (the driveway is stamped LOT).
// (CURB_LANE, APPROACH_PAVED and CAR_KINDS are with the tables at the top)
function checkApproach(key, pl) {
  const a = pl.approach;
  if (!a || !(a.pts instanceof Float32Array) || a.n < 2 || a.pts.length !== 2 * a.n || !(a.len > 0)) { fail(`${key}.approach is missing or malformed`); return null; }
  const lane = net.lanes[a.lane], e = lane && net.edges[lane.edge];
  if (!e || !e.ai || e.cls === 'hwy') fail(`${key}.approach starts on lane ${a.lane}, not a lane of a road traffic uses (off the highway)`);
  else {
    let d = Infinity;
    for (let i = 0; i + 1 < lane.n; i++) d = Math.min(d, segDistM(a.pts[0], a.pts[1], lane.x[i], lane.y[i], lane.x[i + 1], lane.y[i + 1]));
    if (d > 0.6) fail(`${key}.approach starts ${d.toFixed(2)} m off its lane`);
  }
  const end = [a.pts[2 * a.n - 2], a.pts[2 * a.n - 1]];
  if (Math.hypot(end[0] - pl.curb.x, end[1] - pl.curb.y) > 0.05 * PX) fail(`${key}.approach does not end at the curb`);
  const lanes = laneDist(pl.curb);
  let bad = 0, open = 0, tight = 0, len = 0;
  for (let q = 0; q + 1 < a.n; q++) {
    const x0 = a.pts[2 * q] / PX, z0 = a.pts[2 * q + 1] / PX, x1 = a.pts[2 * q + 2] / PX, z1 = a.pts[2 * q + 3] / PX, L = Math.hypot(x1 - x0, z1 - z0);
    len += L;
    for (let t = 0; t <= L; t += 0.5) {
      const x = x0 + (x1 - x0) * t / L, z = z0 + (z1 - z0) * t / L, b = bits(x, z), k = b & KIND_MASK;
      if (b & (FLAG.BLOCK_CAR | FLAG.NOPED) || !CAR_KINDS.has(k) || W.blockedCarPx(x * PX, z * PX)) bad++;
      else if (!APPROACH_PAVED.has(k)) open++;
      if (Math.hypot(x - pl.curb.x / PX, z - pl.curb.y / PX) > 3.5) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const nb = bits(x + dx, z + dz);
        if (nb & FLAG.BLOCK_CAR || !CAR_KINDS.has(nb & KIND_MASK) || W.blockedCarPx((x + dx) * PX, (z + dz) * PX)) { tight++; dz = dx = 2; }
      }
    }
  }
  if (bad) fail(`${key}.approach crosses ${bad} sample(s) a car cannot drive`);
  if (tight) fail(`${key}.approach passes ${tight} sample(s) too close to something that blocks cars`);
  if (lanes > CURB_LANE && open) fail(`${key}.approach (its curb ${lanes.toFixed(1)} m from a lane) crosses ${open} sample(s) of open ground: no driveway`);
  return { len: +len.toFixed(1), road: a.road, from: lanes === Infinity ? '> 40' : +lanes.toFixed(1) };
}
function segDistM(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
  return Math.hypot(x - ax - dx * t, y - ay - dy * t) / PX;
}

// Jars and photo spots: where §5.2/§5.3 put them, give or take the generator's nudge (8 m at most), on
// ground someone can stand on (jars never on a highway), and reachable on foot from the villa.
function checkSpots() {
  const out = { jarsMoved: {}, photosMoved: {} };
  if (W.jarSpots.length !== 25) fail(`${W.jarSpots.length} jars, §5.3 lists 25`);
  W.jarSpots.forEach((j, i) => {
    const J = D.JARS[i], d = dist(m(j), [J.x, J.z]), b = bits(...m(j)), k = b & KIND_MASK;
    if (j.id !== i) fail(`jar ${i} has id ${j.id}`);
    if (d > 8) fail(`jar ${i} is ${d.toFixed(1)} m from §5.3's (${J.x},${J.z})`);
    if (d > 0) out.jarsMoved[i] = +d.toFixed(2);
    if (b & (FLAG.BLOCK_FOOT | FLAG.NOPED) || k === KIND.WATER || k === KIND.SHALLOW) fail(`jar ${i} at (${m(j).map(v => v.toFixed(1))}) is not on walkable, non-highway ground`);
    if (!reachable(reach.foot, j)) fail(`jar ${i} cannot be reached on foot from the villa`);
    const y = W.groundY(j.x, j.y);
    out.lowest = Math.min(out.lowest ?? Infinity, +y.toFixed(2));
    if (!(y >= D.SEA_LEVEL + SPOT_CLEAR)) fail(`jar ${i} at (${m(j).map(v => v.toFixed(1))}) stands at ${y.toFixed(2)} m, under the sea level + ${SPOT_CLEAR}`);
  });
  if (W.photoSpots.length !== 15) fail(`${W.photoSpots.length} photo spots, §5.2 lists 15`);
  W.photoSpots.forEach((p, i) => {
    const P = D.PHOTO_SPOTS[i], d = dist(m(p), [P.x, P.z]), b = bits(...m(p)), k = b & KIND_MASK;
    if (p.id !== P.id) fail(`photo spot ${i} is '${p.id}', §5.2 says '${P.id}'`);
    if (d > 8) fail(`photo spot ${p.id} is ${d.toFixed(1)} m from §5.2's (${P.x},${P.z})`);
    if (d > 0) out.photosMoved[p.id] = +d.toFixed(2);
    if (b & FLAG.BLOCK_FOOT || k === KIND.WATER || k === KIND.SHALLOW) fail(`photo spot ${p.id} is not on walkable ground`);
    if (!reachable(reach.foot, p)) fail(`photo spot ${p.id} cannot be reached on foot from the villa`);
    const y = W.groundY(p.x, p.y);
    out.lowest = Math.min(out.lowest ?? Infinity, +y.toFixed(2));
    if (!(y >= D.SEA_LEVEL + SPOT_CLEAR)) fail(`photo spot ${p.id} stands at ${y.toFixed(2)} m, under the sea level + ${SPOT_CLEAR}`);
  });
  note(`jars 25 and photo spots 15 walkable, reachable and at least ${SPOT_CLEAR} m over the sea (lowest ${out.lowest} m); moved onto open ground (m): jars ${JSON.stringify(out.jarsMoved)}, photos ${JSON.stringify(out.photosMoved)}`);
  return out;
}

// The lanes traffic drives (edges with ai) must form one strongly connected graph through the connectors and
// the lane changes multi-lane roads allow (§9), or cars would collect in a corner they cannot leave.
// Kosaraju over lanes.
function checkLanes() {
  const L = net.lanes, ai = L.map(l => net.edges[l.edge].ai), n = L.length;
  const fwd = L.map(() => []), back = L.map(() => []);
  const arc = (a, b) => { if (ai[a] && ai[b]) { fwd[a].push(b); back[b].push(a); } };
  for (const c of net.conns) arc(c.from, c.to);
  for (const l of L) if (net.edges[l.edge].laneChange) for (const o of [l.left, l.right]) if (o >= 0) arc(l.id, o);
  const order = [], seen = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    if (!ai[s] || seen[s]) continue;
    const stack = [[s, 0]];
    seen[s] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1], [v, k] = top;
      if (k < fwd[v].length) { top[1]++; const w = fwd[v][k]; if (!seen[w]) { seen[w] = 1; stack.push([w, 0]); } }
      else { order.push(v); stack.pop(); }
    }
  }
  const comp = new Int32Array(n).fill(-1);
  let nc = 0;
  for (let q = order.length - 1; q >= 0; q--) {
    const s = order[q];
    if (comp[s] >= 0) continue;
    const stack = [s];
    comp[s] = nc;
    while (stack.length) { const v = stack.pop(); for (const w of back[v]) if (comp[w] < 0) { comp[w] = nc; stack.push(w); } }
    nc++;
  }
  const size = new Array(nc).fill(0);
  for (let v = 0; v < n; v++) if (ai[v]) size[comp[v]]++;
  const big = size.indexOf(Math.max(...size)), lost = [];
  for (let v = 0; v < n; v++) if (ai[v] && comp[v] !== big) lost.push(`${net.edges[L[v].edge].road}#${v}`);
  const total = ai.filter(Boolean).length;
  if (lost.length) fail(`the traffic lane graph is not strongly connected: ${nc} parts; ${lost.length} of ${total} lanes outside the main one: ${lost.slice(0, 12).join(' ')}`);
  else note(`traffic lanes: all ${total} in one strongly connected graph`);
  return { lanes: total, parts: nc, outside: lost.length };
}

// People walk the RoadNet's sidewalk paths (§9): every metre of them stands on pavement, never on a carriageway
// (ROAD, DECK or a dirt track), except the crosswalks, and never in anything that blocks people.
function checkWalks() {
  let n = 0, onRoad = 0, blocked = 0;
  const where = [];
  for (const p of net.walks.paths) {
    if (p.cross) continue;
    for (let k = 0; k + 1 < p.n; k++) {
      const x0 = p.pts[2 * k] / PX, z0 = p.pts[2 * k + 1] / PX, x1 = p.pts[2 * k + 2] / PX, z1 = p.pts[2 * k + 3] / PX, L = Math.hypot(x1 - x0, z1 - z0);
      for (let t = 0; t < L; t += 1) {
        const x = x0 + (x1 - x0) * t / L, z = z0 + (z1 - z0) * t / L, b = bits(x, z), kind = b & KIND_MASK;
        n++;
        if (kind === KIND.ROAD || kind === KIND.DECK || kind === KIND.DIRT) { onRoad++; if (where.length < 6) where.push(`(${x.toFixed(0)},${z.toFixed(0)})`); }
        if (b & FLAG.BLOCK_FOOT) blocked++;
      }
    }
  }
  if (onRoad) fail(`${onRoad} of ${n} metres of sidewalk path lie on a carriageway, e.g. ${where.join(' ')}`);
  if (blocked) fail(`${blocked} metres of sidewalk path lie in something that blocks people`);
  note(`sidewalk paths: ${n} m, none on a carriageway (crosswalks apart) or blocked`);
  return { metres: n, onRoad, blocked };
}

// §4.7: each landmark within ±30° of the road tangent (the chase camera's frame) and a clear ray from a
// 1.5 m eye to its mid-height over OCC (the ray stops at the landmark's own footprint).
// (the targets are SL_TARGETS, with the tables at the top)
function checkSightlines() {
  const loop = profiles.get('loop'), out = {};
  const eyeAt = (x, z) => W.groundY(x * PX, z * PX) + 1.5;
  const look = (name, x, z, heading, id, spec) => {
    const T = SL_TARGETS[id], dx = T.x - x, dz = T.z - z, d = Math.hypot(dx, dz);
    const bearing = Math.atan2(Math.sin(Math.atan2(dz, dx) - heading), Math.cos(Math.atan2(dz, dx) - heading)) * 180 / Math.PI;
    const f = Math.max(0, (d - T.r) / d), ty = T.y ?? W.groundY(T.x * PX, T.z * PX) + T.h / 2, h0 = eyeAt(x, z);
    const clear = W.sightClear(x * PX, z * PX, h0, (x + dx * f) * PX, (z + dz * f) * PX, h0 + (ty - h0) * f);
    const r = { bearing: +bearing.toFixed(1), clear, spec };
    (out[name] ||= {})[id] = (out[name][id] || []).concat([r]);
    return r;
  };
  const lanePoint = (s, dir) => {
    const i = Math.round(((s % loop.len) + loop.len) % loop.len / loop.ds) % loop.n, [tx, tz] = loop.tangent(i * loop.ds);
    const off = 3.3 * dir;     // the inner lane of the carriageway in that direction (median/2 + laneW/2)
    return { x: loop.curve.x[i] - tz * off, z: loop.curve.z[i] + tx * off, a: Math.atan2(tz * dir, tx * dir) };
  };
  const bad = [];
  // a broken sightline fails, unless SL_CONFLICTS names it: then it is a warning that says why
  const test = (name, p, id, spec) => {
    const r = look(name, p.x, p.z, p.a, id, spec), key = `${name} ${id}`, waive = SL_CONFLICTS[key], why = [];
    if (Math.abs(r.bearing) > 30) why.push(`at ${r.bearing}° from the road tangent (> ±30°)`);
    if (!r.clear) why.push(`hidden from (${p.x.toFixed(0)},${p.z.toFixed(0)}): it clears only for a target ${clearHeight(p, id)} m tall`);
    if (why.length && waive) warn(`sightline ${key} ${why.join('; ')}; spec conflict: ${waive}`);
    else if (why.length) bad.push(`${key} ${why.join('; ')}`);
    return r;
  };
  // the smallest target height (m, whole metres) the ray clears, for the report
  const clearHeight = (p, id) => {
    const T = SL_TARGETS[id], h0 = eyeAt(p.x, p.z), g = T.y ?? W.groundY(T.x * PX, T.z * PX);
    for (let h = T.h ?? 0; h <= 400; h++) if (W.sightClear(p.x * PX, p.z * PX, h0, T.x * PX, T.z * PX, g + h / 2)) return h;
    return Infinity;
  };
  // SL1: the Loop eastbound over the pass crest, stations 2016-2100
  for (let s = 2016; s <= 2100; s += 12) for (const [id, spec] of [['kimchi_tower', '+28→+17'], ['causeway_pylon', '+1→−14'], ['deco_north', '+12→−3']]) test('SL1', lanePoint(s, 1), id, spec);
  // SL2: the Loop westbound at (1560,311), against the road tangent like the others. The spec's −28° is the
  // bearing from a car heading due west there; that value is reported alongside.
  const s2 = loop.nearest(1560, 311, -1).s, p2 = lanePoint(s2, -1);
  test('SL2', p2, 'kimchi_tower', '−28');
  const T2 = SL_TARGETS.kimchi_tower, rel = Math.atan2(T2.z - p2.z, T2.x - p2.x) - Math.PI;
  note(`SL2 heading due west (the spec's frame) the tower is at ${(Math.atan2(Math.sin(rel), Math.cos(rel)) * 180 / Math.PI).toFixed(1)}°; the road tangent there points ${(p2.a * 180 / Math.PI).toFixed(1)}°`);
  // SL3: Kimchi at the villa foot spawn, facing 0.5 rad. The island point moved off the line to the tower (the
  // spec's −12° lies right behind it); the tower is a building, so the two rays must stay apart.
  const f = W.places.home.foot, v = { x: f.x / PX, z: f.y / PX, a: 0.5 };
  for (const [id, spec] of [['kimchi_tower', '−12'], ['ktown', '0'], ['bay', 'none; F3 vista over the bay'], ['island', '−12; moved off the tower'], ['lighthouse', '+14']]) test('SL3', v, id, spec);
  checkTower(v);
  const show = Object.entries(out).map(([k, t]) => `${k} ` + Object.entries(t).map(([id, rs]) => `${id} ${rs[0].bearing}${rs.length > 1 ? '→' + rs[rs.length - 1].bearing : ''}° (§4.7 ${rs[0].spec})`).join(', '));
  if (bad.length) fail(`sightlines: ${bad.slice(0, 8).join('; ')}${bad.length > 8 ? ` and ${bad.length - 8} more` : ''}`);
  note(`sightlines ${bad.length ? 'FAIL' : 'pass'} (spec conflicts warn: ${Object.keys(SL_CONFLICTS).join(', ')}): ${show.join('; ')}`);
  return out;
}

// Kimchi Tower is a full building (lead decision): one record in world.buildings on its landmark's footprint,
// BUILD in SURF and its full height in OCC, its sightline target stopping past its corners, and the SL3
// island ray passing clear of it.
function checkTower(villa) {
  const L = D.LANDMARKS.find(l => l.id === 'kimchi_tower'), T = SL_TARGETS.kimchi_tower;
  const b = W.buildings.filter(q => q.landmark === 'kimchi_tower');
  if (b.length !== 1) { fail(`Kimchi Tower: ${b.length} building records (want 1)`); return; }
  const t = b[0], half = Math.hypot(L.w, L.d) / 2;
  if (Math.hypot(t.cx - L.x, t.cz - L.z) > 0.01 || t.w !== L.w || t.d !== L.d || Math.abs(t.h - L.h) > 0.01) fail(`Kimchi Tower's building is not the landmark's ${L.w}×${L.d}×${L.h} m at (${L.x},${L.z})`);
  if (!(T.r >= TOWER_R && T.r > half)) fail(`the kimchi_tower sightline target stops ${T.r} m short, inside the tower's corners (${half.toFixed(1)} m; want ≥ ${TOWER_R})`);
  const occ = W.grids.occ, OW = W.grids.dims.occ[0], top = occ[Math.floor(L.z / 2) * OW + Math.floor(L.x / 2)];
  if (top < Math.min(255, Math.floor(t.base + L.h))) fail(`OCC over Kimchi Tower is ${top} m, under its roof (${(t.base + L.h).toFixed(0)} m)`);
  if ((bits(L.x, L.z) & KIND_MASK) !== KIND.BUILD) fail('Kimchi Tower\'s footprint is not BUILD in SURF');
  // the island ray from the villa: how far it passes from the tower's centre
  const I = SL_TARGETS.island, dx = I.x - villa.x, dz = I.z - villa.z, l = Math.hypot(dx, dz);
  const off = Math.abs(-(L.x - villa.x) * dz / l + (L.z - villa.z) * dx / l);
  if (off < half + 5) fail(`the SL3 island ray passes ${off.toFixed(1)} m from Kimchi Tower's centre (its corners reach ${half.toFixed(1)} m)`);
  note(`Kimchi Tower: building ${t.id} (${L.w}×${L.d}×${L.h} m, OCC ${top} m), sightline target r ${T.r} m; the SL3 island ray passes ${off.toFixed(0)} m from it`);
}

// GROUND under what people stand on and drive (§7, two height rasters):
//  - no walkable or drivable cell outside the water is under the sea level (beach sand by SAND_DIP at most);
//  - a deck over water (bridges, the pier, the Riverwalk) stands DECK_CLEAR over that water;
//  - across every bridge deck's carriageway, every 0.5 m, groundY is the banked road surface (edge.gy minus
//    the offset times tan(bank)) within DECK_TOL, so no car meets a sag toward the sea bed at the deck edge.
function checkGround() {
  const G = { w: terrain.w, h: terrain.h, cell: 2, o: 0, data: W.grids.ground }, wet = terrain.wet, vw = terrain.w;
  const levelAt = (x, z) => { const w = wet[Math.round(z / 2) * vw + Math.round(x / 2)]; return w === 0 ? null : w === 1 ? D.SEA_LEVEL : D.WATER[w - 2].level; };
  const low = {}, worst = {};
  let sandLow = 0, decks = 0, deckLow = 0, deckWorst = null;
  for (let j = 0; j < SH; j++) for (let i = 0; i < SW; i++) {
    const b = surf[j * SW + i], k = b & KIND_MASK;
    if (k === KIND.WATER || k === KIND.SHALLOW || ((b & FLAG.BLOCK_CAR) && (b & FLAG.BLOCK_FOOT))) continue;
    const x = i + 0.5, z = j + 0.5, y = sampleGrid(G, x, z) + CURB[k];
    if (y < D.SEA_LEVEL) {
      if (k === KIND.SAND && y >= D.SEA_LEVEL - SAND_DIP) sandLow++;
      else { low[k] = (low[k] || 0) + 1; if (!worst[k] || y < worst[k][2]) worst[k] = [i, j, +y.toFixed(2)]; }
    }
    if (k !== KIND.DECK) continue;
    const level = levelAt(x, z);
    if (level === null) continue;
    decks++;
    if (y < level + DECK_CLEAR) { deckLow++; if (!deckWorst || y < deckWorst[2]) deckWorst = [i, j, +y.toFixed(2)]; }
  }
  const name = k => Object.keys(KIND).find(n => KIND[n] === k);
  for (const k of Object.keys(low)) fail(`${low[k]} walkable or drivable ${name(+k)} cell(s) under the sea level (${D.SEA_LEVEL} m), the lowest at (${worst[k][0]},${worst[k][1]}) ${worst[k][2]} m`);
  if (deckLow) fail(`${deckLow} of ${decks} deck cells over water stand less than ${DECK_CLEAR} m over it, the lowest at (${deckWorst[0]},${deckWorst[1]}) ${deckWorst[2]} m`);
  // the bridge carriageways against their banked surface
  let n = 0, off = 0, max = 0, at = null;
  for (const e of net.edges) {
    if (!e.deck?.length) continue;
    const hw = e.halfW / PX, nb = e.bank.length;
    for (let k = 1; k + 1 < e.n; k++) {
      if (!e.deck.some(([a, b]) => e.s[k] >= a && e.s[k] <= b)) continue;
      const tx = e.x[k + 1] - e.x[k - 1], tz = e.y[k + 1] - e.y[k - 1], l = Math.hypot(tx, tz), nx = -tz / l, nz = tx / l;
      const f = Math.min(e.s[k] / PX / 2, nb - 1), b0 = Math.floor(f), b1 = Math.min(b0 + 1, nb - 1), tb = Math.tan(e.bank[b0] + (e.bank[b1] - e.bank[b0]) * (f - b0));
      for (let o = -hw + 0.05; o <= hw - 0.05; o += 0.5) {
        const x = e.x[k] / PX + nx * o, z = e.y[k] / PX + nz * o, d = Math.abs(sampleGrid(G, x, z) - (e.gy[k] - o * tb));
        n++;
        if (d > DECK_TOL) off++;
        if (d > max) { max = d; at = `${e.road} (${f1(x)},${f1(z)}) ${o.toFixed(1)} m off centre`; }
      }
    }
  }
  if (off) fail(`${off} of ${n} bridge carriageway samples are more than ${DECK_TOL} m off the banked deck, up to ${max.toFixed(2)} m at ${at}`);
  note(`ground: nothing walkable or drivable under the sea (${sandLow} beach sand cell(s) dip ≤ ${SAND_DIP} m into the swash); ${decks} deck cells over water ≥ ${DECK_CLEAR} m over it; ` +
    `bridge carriageways within ${max.toFixed(2)} m of their banked surface over ${n} samples`);
  return { sandLow, decksOverWater: decks, deckLow, carriageway: { samples: n, off, max: +max.toFixed(3) } };
}

// Buildings: 450 at most, none overlapping another (separating axes of the two boxes), none on a road.
function checkBuildings() {
  const B = W.buildings;
  if (B.length > 450) fail(`${B.length} buildings (> 450)`);
  const box = b => { const c = Math.cos(b.a), s = Math.sin(b.a); return { b, ax: [[s, -c], [c, s]], half: [b.w / 2, b.d / 2], r: Math.hypot(b.w, b.d) / 2 }; };
  const boxes = B.map(box), over = [];
  const sep = (A, C) => {
    for (const P of [A, C]) for (const [ux, uz] of P.ax) {
      const proj = Q => Q.half[0] * Math.abs(Q.ax[0][0] * ux + Q.ax[0][1] * uz) + Q.half[1] * Math.abs(Q.ax[1][0] * ux + Q.ax[1][1] * uz);
      if (Math.abs((C.b.cx - A.b.cx) * ux + (C.b.cz - A.b.cz) * uz) >= proj(A) + proj(C) - 1e-6) return true;
    }
    return false;
  };
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const A = boxes[i], C = boxes[j];
    if (Math.hypot(A.b.cx - C.b.cx, A.b.cz - C.b.cz) > A.r + C.r) continue;
    if (!sep(A, C)) over.push(`${A.b.id}/${C.b.id}`);
  }
  if (over.length) fail(`${over.length} overlapping building pair(s): ${over.slice(0, 10).join(' ')}`);
  for (const i of rep.issues.filter(i => i.type === 'building_on_road')) fail(`building ${i.id}${i.place ? ` (${i.place})` : ''} at (${i.x.toFixed(0)},${i.z.toFixed(0)}) covers ${i.cells} road or sidewalk cells`);
  const missing = B.filter(b => !b.door || !b.curb || !Number.isFinite(b.base) || !b.tile || !b.cell || !b.region);
  if (missing.length) fail(`${missing.length} building(s) without the §6.4 fields`);
  note(`buildings: ${B.length} (≤ 450), no overlaps, none on a road`);
  return { count: B.length, overlaps: over.length };
}

// Every land cell has a region and regionAt always names one ('sea' off the land).
function checkRegions() {
  const reg = W.grids.reg, [RW, RH, RC] = W.grids.dims.reg, land = terrain.land, vw = terrain.w;
  let gaps = 0;
  for (let j = 0; j < RH; j++) for (let i = 0; i < RW; i++) {
    const x = (i + 0.5) * RC, z = (j + 0.5) * RC;
    if (land[Math.round(z / 2) * vw + Math.round(x / 2)] && reg[j * RW + i] === 255) gaps++;
  }
  if (gaps) fail(`${gaps} land cells of 8 m have no region`);
  // nothing anyone stands on or drives over reads 'sea': bridge decks, piers and the last metres of the beaches
  let dry = 0;
  for (let z = 0; z < SH; z++) for (let x = 0; x < SW; x++) {
    const k = surf[z * SW + x] & KIND_MASK;
    if (k !== KIND.WATER && k !== KIND.SHALLOW && reg[((z / RC) | 0) * RW + ((x / RC) | 0)] === 255) dry++;
  }
  if (dry) fail(`${dry} cells of road, deck or ground read the 'sea' region`);
  const ids = new Set(W.regions.map(r => r.id)), counts = {};
  for (let z = 4; z < SH; z += 16) for (let x = 4; x < SW; x += 16) {
    const id = W.regionAt(x * PX, z * PX);
    if (!ids.has(id)) { fail(`regionAt(${x},${z}) = ${id}, not a region`); return { gaps }; }
    counts[id] = (counts[id] || 0) + 1;
  }
  note(`regions: every land, road and deck cell has one; samples ${JSON.stringify(counts)}`);
  return { gaps, dry, counts };
}

// Routes: all of §5.5 resolved, street_kings the same object as bay_loop (21 gates), every gate on a paved
// surface across the course, polylines inside the map.
function checkRoutes() {
  const R = W.routes, out = {};
  for (const r of D.ROUTES) {
    const q = R[r.id];
    if (!q) { fail(`route ${r.id} was not resolved`); continue; }
    out[r.id] = { gates: q.gates.length, len: Math.round(q.len / PX), laps: q.laps };
    for (const [k, g] of q.gates.entries()) {
      const k2 = bits(g.x / PX, g.y / PX) & KIND_MASK;
      if (![KIND.ROAD, KIND.DECK, KIND.DIRT, KIND.LOT].includes(k2)) fail(`route ${r.id} gate ${k} at (${(g.x / PX).toFixed(0)},${(g.y / PX).toFixed(0)}) is not on a road`);
      if (!(g.w > 4 * PX) || !Number.isFinite(g.a)) fail(`route ${r.id} gate ${k} has no width or heading`);
    }
    for (let i = 0; i < q.pts.length; i += 2) if (q.pts[i] < 0 || q.pts[i + 1] < 0 || q.pts[i] > W.BOUNDS.x1 || q.pts[i + 1] > W.BOUNDS.y1) { fail(`route ${r.id} leaves the map`); break; }
  }
  if (R.street_kings !== R.bay_loop) fail('routes.street_kings is not routes.bay_loop');
  if (R.bay_loop && R.bay_loop.gates.length !== 21) fail(`bay_loop has ${R.bay_loop.gates.length} gates, §5.5 says 21`);
  note(`routes: ${Object.entries(out).map(([id, o]) => `${id} ${o.len} m ${o.gates} gates${o.laps > 1 ? ` ×${o.laps}` : ''}`).join(', ')}; street_kings = bay_loop`);
  return out;
}

// The generator's time, its own validation, and determinism.
function checkGenerate() {
  const t = rep.timing.total;
  if (t > GEN_LIMIT) fail(`generate took ${t} ms cold (limit ${GEN_LIMIT}, target ${GEN_TARGET})`);
  else if (t > GEN_TARGET) warn(`generate took ${t} ms cold (target ${GEN_TARGET} ms; the second run took ${rep2.timing.total} ms)`);
  else note(`generate ${t} ms cold (target ${GEN_TARGET}), ${rep2.timing.total} ms on a second run`);
  note('generate steps (ms): ' + Object.entries(rep.timing).filter(([k]) => k !== 'total').map(([k, v]) => `${k} ${v}`).join(', '));
  if (hashes[0] !== hashes[1]) fail(`the rasters differ between two runs: ${hashes.join(' vs ')}`);
  else note(`rasters identical over two runs (hash ${hashes[0]})`);
  const bad = rep.issues.filter(i => !i.info);
  for (const i of bad) if (!['building_on_road'].includes(i.type)) (i.type.startsWith('roadnet_') ? warn : fail)(`generator: ${i.type} ${JSON.stringify(i)}`);
  return { ms: t, secondRun: rep2.timing.total, issues: bad.length };
}

// ---------- reachability ----------

// Every 1 m cell reachable from a start without crossing a cell with the given block flag (4-neighbour).
function flood(flag, start) {
  const seen = new Uint8Array(SW * SH), q = new Int32Array(SW * SH);
  const s = cellAt(start.x / PX, start.y / PX);
  if (s < 0 || surf[s] & flag) return seen;
  let head = 0, tail = 0;
  seen[s] = 1; q[tail++] = s;
  while (head < tail) {
    const c = q[head++], i = c % SW;
    if (i > 0 && !seen[c - 1] && !(surf[c - 1] & flag)) { seen[c - 1] = 1; q[tail++] = c - 1; }
    if (i < SW - 1 && !seen[c + 1] && !(surf[c + 1] & flag)) { seen[c + 1] = 1; q[tail++] = c + 1; }
    if (c >= SW && !seen[c - SW] && !(surf[c - SW] & flag)) { seen[c - SW] = 1; q[tail++] = c - SW; }
    if (c < SW * (SH - 1) && !seen[c + SW] && !(surf[c + SW] & flag)) { seen[c + SW] = 1; q[tail++] = c + SW; }
  }
  return seen;
}
function reachable(seen, p) { const c = cellAt(p.x / PX, p.y / PX); return c >= 0 && seen[c] === 1; }

// Distance (m) from a point to the nearest lane of a road traffic uses.
function laneDist(p) {
  let best = Infinity;
  net.edgesNear(p.x, p.y, 40 * PX, e => {
    if (!e.ai) return;
    for (const id of [...e.fwd, ...e.bwd]) {
      const L = net.lanes[id];
      for (let i = 0; i + 1 < L.n; i++) {
        const ax = L.x[i], ay = L.y[i], dx = L.x[i + 1] - ax, dy = L.y[i + 1] - ay, l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / l2)) : 0;
        best = Math.min(best, Math.hypot(p.x - ax - dx * t, p.y - ay - dy * t) / PX);
      }
    }
  });
  return best;
}

// FNV-1a over every raster, 32 bits at a time.
function rasterHash(G) {
  let h = 0x811c9dc5;
  for (const k of ['surf', 'ground', 'terrain', 'occ', 'reg', 'seaDepth']) {
    const a = G[k], u = new Uint32Array(a.buffer, a.byteOffset, a.byteLength >> 2);
    for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619);
    for (let i = u.length << 2; i < a.byteLength; i++) h = Math.imul(h ^ new Uint8Array(a.buffer, a.byteOffset)[i], 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------- the map picture ----------

// tools/out/map_v2.png at 1 px per metre: the generator's own map image (mapimage.js), then on top the
// junctions (T red, X blue, ring pink), the race gates of the Kimchi Loop (cyan), landmarks (red cross),
// photo spots (magenta), jars (yellow), places (their colour, with their name) and region names.
function drawMap() {
  const px = mapPixels({ grids: W.grids }, 1), w = px.w, h = px.h, rgb = new Uint8Array(w * h * 3);
  for (let i = 0, o = 0; i < w * h; i++, o += 4) { rgb[3 * i] = px.data[o]; rgb[3 * i + 1] = px.data[o + 1]; rgb[3 * i + 2] = px.data[o + 2]; }
  const put = (x, z, c) => { x = Math.round(x); z = Math.round(z); if (x < 0 || z < 0 || x >= w || z >= h) return; const o = (z * w + x) * 3; rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2]; };
  const dot = (x, z, r, c, ring) => { for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dz * dz <= r * r + r) put(x + dx, z + dz, ring && dx * dx + dz * dz > (r - 1) * (r - 1) ? ring : c); };
  const hex = s => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16));
  for (const n of net.nodes) if (n.ends.length >= 3) dot(n.x / PX, n.y / PX, 3, n.kind === 'X' ? [40, 80, 220] : n.kind === 'ring' ? [255, 110, 170] : [220, 40, 40]);
  for (const g of W.routes.bay_loop?.gates || []) {
    const c = Math.cos(g.a + Math.PI / 2), s = Math.sin(g.a + Math.PI / 2), hw = g.w / PX / 2;
    for (let t = -hw; t <= hw; t += 0.5) put(g.x / PX + c * t, g.y / PX + s * t, [60, 230, 240]);
  }
  for (const L of W.landmarks) if (L.x !== undefined) for (let t = -6; t <= 6; t++) { put(L.x + t, L.z, [200, 20, 20]); put(L.x, L.z + t, [200, 20, 20]); put(L.x + t, L.z + 1, [255, 255, 255]); }
  for (const p of W.photoSpots) dot(p.x / PX, p.y / PX, 3, [230, 60, 220], [40, 0, 40]);
  for (const j of W.jarSpots) dot(j.x / PX, j.y / PX, 3, [255, 215, 40], [60, 40, 0]);
  for (const pl of Object.values(W.places)) {
    const [x, z] = m(pl.door);
    dot(x, z, 5, hex(pl.color), [20, 20, 20]);
    text(rgb, w, h, pl.name, x + 8, z - 7, 1);
  }
  // the legend, in the open sea south-east of the key
  const legend = [[[226, 132, 46], 'KIMCHI LOOP'], [[150, 104, 70], 'BRIDGE DECK'], [[220, 40, 40], 'T JUNCTION'], [[40, 80, 220], 'X JUNCTION'],
    [[255, 110, 170], 'RING ENTRY'], [[60, 230, 240], 'RACE GATE'], [[212, 175, 55], 'PLACE'], [[255, 215, 40], 'JAR'], [[230, 60, 220], 'PHOTO SPOT'], [[200, 20, 20], 'LANDMARK']];
  legend.forEach(([c, label], i) => {
    const z = 1620 + i * 16;
    for (let dz = 0; dz < 10; dz++) for (let dx = 0; dx < 10; dx++) put(1790 + dx, z + dz, c);
    text(rgb, w, h, label, 1806, z - 2, 1.5);
  });
  for (const r of D.REGIONS) {
    let cx = 0, cz = 0;
    for (const [x, z] of r.pts) { cx += x; cz += z; }
    const label = { heights: [330, 150], north_shore: [1050, 120], cape: [1540, 1470], islets: [1440, 860], collins: [1760, 380], deco: [1760, 1000], fest_airport: [600, 1580] }[r.id] || [cx / r.pts.length, cz / r.pts.length];
    text(rgb, w, h, r.name, label[0] - r.name.length * 6, label[1], 2);
  }
  return { w, h, rgb };
}

// A 5×7 bitmap font for the labels (upper case, digits and a little punctuation), drawn white with a dark
// outline at `scale` pixels per font pixel.
// (FONT is with the tables at the top)
function text(rgb, w, h, str, x0, z0, scale) {
  const put = (x, z, v) => { if (x < 0 || z < 0 || x >= w || z >= h) return; const o = (z * w + x) * 3; rgb[o] = rgb[o + 1] = rgb[o + 2] = v; };
  const s = str.toUpperCase();
  for (const pass of [0, 1]) for (let c = 0; c < s.length; c++) {
    const g = FONT[s[c]] || FONT[' '];
    for (let row = 0; row < 7; row++) {
      const bitsRow = parseInt(g.slice(row * 2, row * 2 + 2), 16);
      for (let col = 0; col < 5; col++) {
        if (!(bitsRow & (16 >> col))) continue;
        const S = Math.ceil(scale);
        for (let dz = 0; dz < S; dz++) for (let dx = 0; dx < S; dx++) {
          const x = Math.round(x0 + (c * 6 + col) * scale) + dx, z = Math.round(z0 + row * scale) + dz;
          if (pass === 0) { for (const [ox, oz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) put(x + ox, z + oz, 25); }
          else put(x, z, 255);
        }
      }
    }
  }
}

// ---------- the terrain picture ----------

// 1 px per 2 m: GROUND hillshaded from the north-west, sea shaded by depth, beaches sand, then the roads
// by class (Loop orange, decks brown) and the junctions (T red, X blue).
function drawTerrain() {
  const { w, h, step, ground, sdf, wet } = terrain, W = w - 1, H = h - 1, img = new Uint8Array(W * H * 3);
  const put = (i, j, c) => { if (i < 0 || j < 0 || i >= W || j >= H) return; const o = (j * W + i) * 3; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2]; };
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const v = j * w + i, g = ground[v];
    const shade = Math.max(0.3, Math.min(1.3, 0.85 - ((ground[v + 1] - g) + (ground[v + w] - g)) / step * 0.9));
    let c;
    if (sdf[v] < 0 || wet[v] >= 2) { const d = Math.min(1, Math.max(0, -g / 20)); c = [80 - 50 * d, 170 - 90 * d, 205 - 60 * d]; }
    else if (g < 0.6 && sdf[v] < 36) c = [222, 205, 160];
    else { const t = Math.min(1, g / 60); c = [110 + 90 * t, 150 + 40 * t, 85 + 80 * t]; }
    put(i, j, c.map(x => clamp8(x * shade)));
  }
  const COL = { hwy: [235, 140, 40], blvd: [250, 250, 245], ave: [235, 235, 230], street: [210, 210, 205], coast: [245, 235, 210],
    country: [225, 215, 200], switch: [255, 220, 120], ring: [255, 120, 160], dirt: [185, 140, 95], alley: [200, 120, 220] };
  for (const e of net.edges) {
    const r = Math.max(1.5, D.ROAD_CLASSES[e.cls].halfW), col = COL[e.cls];
    for (let k = 0; k + 1 < e.n; k++) {
      const onDeck = e.deck.some(([a, b]) => e.s[k] >= a && e.s[k] <= b), c = onDeck ? [150, 95, 60] : col;
      const ax = e.x[k] / PX, az = e.y[k] / PX, bx = e.x[k + 1] / PX, bz = e.y[k + 1] / PX, m = Math.ceil(Math.hypot(bx - ax, bz - az));
      for (let q = 0; q <= m; q++) {
        const x = ax + (bx - ax) * q / m, z = az + (bz - az) * q / m;
        for (let oz = -r; oz <= r; oz += step) for (let ox = -r; ox <= r; ox += step) if (ox * ox + oz * oz <= r * r) put(Math.floor((x + ox) / step), Math.floor((z + oz) / step), c);
      }
    }
  }
  for (const n of net.nodes) {
    const c = n.kind === 'X' ? [40, 80, 220] : n.kind === 'T' ? [220, 40, 40] : [30, 30, 30];
    const ci = Math.floor(n.x / PX / step), cj = Math.floor(n.y / PX / step);
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) put(ci + di, cj + dj, c);
  }
  return { w: W, h: H, rgb: img };
}

function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }
function roundAll(o) { const r = {}; for (const [k, v] of Object.entries(o)) r[k] = Math.round(v); return r; }

// A plain RGB PNG: filter byte 0 on every row, one zlib IDAT.
function writePng(path, { w, h, rgb }) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let j = 0; j < h; j++) Buffer.from(rgb.buffer, rgb.byteOffset + j * w * 3, w * 3).copy(raw, j * (w * 3 + 1) + 1);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;      // 8-bit RGB
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]));
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
