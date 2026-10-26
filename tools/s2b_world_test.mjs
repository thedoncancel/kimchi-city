#!/usr/bin/env node
// Stage S2b: the v2 world behind the World API (docs/map-v2-spec.md §6, §7), headless.
//   node tools/s2b_world_test.mjs
// generate() is idempotent and fills every container in place; the v2 world exports what the grid exports
// (less its grid-only names) plus the v2 names; the queries answer sensibly everywhere, also off the map;
// the places carry the §6.5 contract in px; routes, anchors, activities, landmarks and views are there;
// the rasters have the §6.2 sizes; bridge decks and the pier stand at their deck height in GROUND (TERRAIN
// keeps the sea bed) and keep their region; a fresh process builds the same rasters; the facade picks v2 with
// KC_WORLD='v2' and still picks the grid by default; and a seeded drive and walk test: random lane points
// route to each other, random sidewalk points stand on open ground.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as D from '../src/map/mapdata.js';
import { KIND, KIND_MASK, FLAG } from '../src/map/raster.js';
import { mulberry32 } from '../src/util.js';
import * as G from '../src/world-grid.js';
import * as W from '../src/world-v2.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { failed++; console.log('  FAIL ' + msg); } };
const PX = 16, fin = v => Number.isFinite(v);

console.log('generate');
const rep = W.generate();
const counts = () => [W.buildings.length, W.lamps.length, W.trees.length, W.palms.length, W.jarSpots.length, W.photoSpots.length, W.activities.length, W.landmarks.length, W.regions.length, W.benchViews.length, W.roads.edges.length].join();
const before = counts();
ok(W.generate() === rep && counts() === before, 'generate() twice returns the same report and adds nothing');
ok(W.READY === true && W.KIND === 'v2' && W.MAP_VERSION === 2, 'READY, KIND v2, MAP_VERSION 2');
ok(rep.timing.total > 0 && Object.values(rep.timing).every(fin), `timing has every step (${Object.keys(rep.timing).length} entries)`);
ok(W.BOUNDS.x1 === 2048 * PX && W.BOUNDS.y1 === 1792 * PX && W.SIZE === 2048 * PX && W.PX_PER_M === 16 && W.T === 64, 'BOUNDS, SIZE, PX_PER_M, T');
ok(W.PHYS.gripG === 2 && W.PHYS.wall === 'normal' && W.PHYS.substepPx === 8 && Object.isFrozen(W.PHYS), 'PHYS is v2 (§10)');

console.log('exports');
{
  const GRID_ONLY = ['tiles', 'N', 'P', 'BLOCKS', 'roadCenter', 'tileAt', 'makeMinimap', 'drawGround', 'drawBuilding', 'drawTree', 'drawLamp', 'drawDeco'];
  const V2_ONLY = ['grids', 'coast', 'water', 'viewCorridors', 'timing'];
  const want = Object.keys(G).filter(k => !GRID_ONLY.includes(k)).concat(V2_ONLY).sort(), have = Object.keys(W).sort();
  ok(JSON.stringify(want) === JSON.stringify(have), `world-v2 exports the shared names plus the v2 ones (missing ${want.filter(k => !have.includes(k))}, extra ${have.filter(k => !want.includes(k))})`);
  for (const k of ['ROAD', 'WALK', 'GRASS', 'BUILD', 'LOT', 'PLAZA', 'WATER', 'SAND', 'DIRT', 'SHALLOW', 'DECK', 'ROCK']) ok(W[k] === G[k] && W[k] === KIND[k], `kind ${k}`);
}

console.log('queries');
{
  const r = mulberry32(7);
  let bad = 0;
  for (let n = 0; n < 4000; n++) {
    const x = (r() * 1.1 - 0.05) * W.BOUNDS.x1, y = (r() * 1.1 - 0.05) * W.BOUNDS.y1;
    const k = W.surfaceAt(x, y), t = W.tileAtPx(x, y), g = W.gripAt(x, y), gy = W.groundY(x, y), reg = W.regionAt(x, y);
    if (!(k >= 0 && k <= 11) || !(t >= 0 && t <= 6) || !g || !fin(g.max) || !fin(gy) || typeof reg !== 'string') bad++;
    if (W.blockedPx(x, y) !== (W.blockedCarPx(x, y) || W.blockedFootPx(x, y))) bad++;
    if ((k === KIND.BUILD || k === KIND.WATER || k === KIND.ROCK) && !(W.blockedCarPx(x, y) && W.blockedFootPx(x, y))) bad++;
    const n2 = W.wallNormalPx(x, y, {});
    if (n2 && Math.abs(Math.hypot(n2.x, n2.y) - 1) > 1e-6) bad++;
  }
  ok(bad === 0, `4000 random points answer sensibly (${bad} odd)`);
  ok(W.surfaceAt(-100, -100) === KIND.WATER && W.blockedPx(-100, 5) && W.regionAt(-5, -5) === 'sea', 'off the map is sea');
  const v = W.places.home.foot;
  ok(Math.abs(W.groundY(v.x, v.y) - (58 + 0.16)) < 0.05, `the villa terrace stands at 58 m (+ plaza curb): ${W.groundY(v.x, v.y).toFixed(2)}`);
  ok(W.wallNormalPx(450 * PX, 700 * PX, {}) === null, 'no wall in the middle of the Glades');
  const door = W.places.home.door, nrm = W.wallNormalPx(door.x - Math.cos(door.a) * 24, door.y - Math.sin(door.a) * 24, {});
  ok(nrm && nrm.x * Math.cos(door.a) + nrm.y * Math.sin(door.a) > 0.7, 'the villa wall pushes out along its facing');
  const jet = W.solids[0];
  ok(jet && W.blockedCarPx((jet.x0 + jet.x1) / 2, (jet.y0 + jet.y1) / 2) && W.wallNormalPx((jet.x0 + jet.x1) / 2, jet.y0 + 2, {})?.y === -1, 'the parked jet blocks, and its wall pushes out the near side');
  const tower = D.LANDMARKS[0];
  ok(W.sightClear(1100 * PX, 700 * PX, 4, 1100 * PX, 900 * PX, 4) !== undefined, 'sightClear answers');
  ok(!W.sightClear(330 * PX, 150 * PX, 30, 330 * PX, 400 * PX, 30), 'a 30 m eye cannot see through the Coral Heights dome');
  ok(W.sightClear(1300 * PX, 900 * PX, 3, 1600 * PX, 900 * PX, 3), 'water never blocks a ray');
  ok(W.gripAt(tower.x * PX, 560 * PX).max === 1 && W.gripAt(tower.x * PX, 555 * PX).max === 0.95, 'Han-ro has full grip, its sidewalk 0.95');
  ok(W.regionAt(350 * PX, 268 * PX) === 'heights' && W.regionAt(1440 * PX, 318 * PX) === 'islets' && W.regionAt(1500 * PX, 500 * PX) === 'sea', 'regionAt: villa heights, causeway deck islets, open bay sea');
}

console.log('places (§6.5)');
for (const key of Object.keys(D.PLACES)) {
  const p = W.places[key];
  ok(p && p.key === key && p.name === D.PLACES[key].name && p.icon && p.color, `${key}: name, icon, colour`);
  if (!p) continue;
  for (const f of ['door', 'foot', 'curb']) ok(p[f] && fin(p[f].x) && fin(p[f].y) && fin(p[f].a), `${key}.${f} {x,y,a} px`);
  for (const f of ['giver', 'hangout']) ok(p[f] && fin(p[f].x) && fin(p[f].y), `${key}.${f} {x,y} px`);
  ok(p.door.x > 0 && p.door.x < W.BOUNDS.x1 && p.door.y > 0 && p.door.y < W.BOUNDS.y1, `${key}: door inside BOUNDS (px)`);
  if (key !== 'park') ok(p.b && p.b.place === key && p.b.door, `${key}.b is its building`);
}
ok(W.places.spray.bay?.r === 9 * PX && W.places.park.nomenu === true && W.places.home.spawn === W.places.home.garage[0], 'spray bay r 144 px, park nomenu, home spawn = garage[0]');
ok(W.places.marina.pier && W.places.marina.pier.len === 48 * PX && W.places.jet.plane, 'marina pier (px) and the jet plane');

console.log('content');
ok(W.jarSpots.length === 25 && W.jarSpots.every((j, i) => j.id === i), '25 jars, ids 0-24');
ok(W.photoSpots.map(p => p.id).join() === D.PHOTO_SPOTS.map(p => p.id).join(), 'the 15 photo spot ids of §5.2');
ok(['bay_loop', 'hillclimb', 'deco_sprint', 'glades_scramble', 'runway_drag', 'key_coastal'].every(id => W.routes[id]?.gates.length > 0) && W.routes.street_kings === W.routes.bay_loop, 'six routes, street_kings = bay_loop');
{
  const R = W.routes.bay_loop, s = R.start;
  ok(R.gates.length === 21 && Math.hypot(s.x - 960 * PX, s.y - 1296.7 * PX) < 1 && Math.abs(Math.cos(s.a) + 1) < 1e-9, 'bay_loop: 21 gates from raceStart, heading west');
  ok(R.pts instanceof Float32Array && R.s instanceof Float32Array && R.s.length * 2 === R.pts.length && Math.abs(R.len - R.s[R.s.length - 1]) < 1e-3, 'route polyline and stations');
  const last = R.gates[R.gates.length - 1];
  ok(Math.hypot(last.x - 960 * PX, last.y - 1300 * PX) < 3 * PX, 'the last gate is the finish at the start line');
}
ok(['bandanaYard', 'stolenCarLot', 'raceStart'].every(k => fin(W.anchors[k]?.x) && fin(W.anchors[k]?.y)) && W.anchors.bandanaYard.r === 25 * PX, 'anchors in px, the yard r 25 m');
ok(W.activities.filter(a => a.type === 'jump').length === 4 && W.activities.filter(a => a.type === 'hub').length === 5 && W.activities.filter(a => a.type === 'speedTrap').length === 3, 'activities: 4 jumps, 5 hubs, 3 speed traps');
ok(W.landmarks.length === D.LANDMARKS.length && W.landmarks.find(l => l.id === 'venetian_bascules').at.length === 4 && fin(W.landmarks.find(l => l.id === 'kimchi_one').x), 'landmarks: all of §5.7, four bascule houses, the jet');
ok(W.benchViews.length === 8 && W.benchViews.every(v => fin(v.x) && fin(v.y) && fin(v.yaw) && fin(v.heading)), 'eight bench views');
{
  const p = {}, l = {};
  W.titleView.pose(0, p, l);
  ok(Math.hypot(p.x - 1500, p.y - 60, p.z - 180) < 1e-6 && fin(l.x), 'the title path starts at its first point');
  W.titleView.pose(120, p, l);
  ok(Math.hypot(p.x - 1500, p.y - 60, p.z - 180) < 1e-6, 'and loops every 120 s');
}
ok(W.deliveryDoors.every(d => d.b && d.curb && !d.b.place), 'deliveryDoors are non-place buildings');
ok(W.regions.length === D.REGIONS.length + 1 && W.regions.at(-1).id === 'sea', 'regions plus sea');
ok(W.coast.shapes === D.COAST && W.water.bodies === D.WATER && W.viewCorridors.length === 1, 'coast, water and view corridors');

console.log('rasters (§6.2)');
{
  const g = W.grids, d = g.dims;
  ok(g.surf.length === 2048 * 1792 && g.ground.length === 1025 * 897 && g.terrain.length === 1025 * 897 && g.occ.length === 1024 * 896 && g.seaDepth.length === 1024 * 896 && g.reg.length === 256 * 224, 'sizes');
  ok(d.surf[0] === 2048 && d.reg[2] === 8 && g.w === 2048 && g.h === 1792, 'dims');
  let occLow = 0, seaShallow = 0;
  for (let j = 0; j < 896; j++) for (let i = 0; i < 1024; i++) if (g.occ[j * 1024 + i] < Math.ceil(g.ground[j * 1025 + i]) - 1e-6 && g.ground[j * 1025 + i] > 0) occLow++;
  ok(occLow === 0, 'OCC is never below the ground');
  for (let v = 0; v < g.seaDepth.length; v += 97) if (W.surfaceAt((v % 1024) * 32 + 16, Math.floor(v / 1024) * 32 + 16) === KIND.WATER && g.seaDepth[v] === 0 && g.terrain[Math.floor(v / 1024) * 1025 + (v % 1024)] < -3) seaShallow++;
  ok(seaShallow === 0, 'deep water has a SEADEPTH');
  // the carriageways: the Loop is NOPED road or deck, no building on any road
  let hwy = 0;
  for (let c = 0; c < g.surf.length; c++) if (g.surf[c] & FLAG.NOPED) { hwy++; const k = g.surf[c] & KIND_MASK; if (k !== KIND.ROAD && k !== KIND.DECK) { ok(false, 'NOPED on a non-road cell'); break; } }
  ok(hwy > 4283 * 18, `the Loop's carriageway is NOPED (${hwy} cells)`);
}

console.log('decks in GROUND');
{
  const g = W.grids, tAt = (x, z) => g.terrain[Math.round(z / 2) * 1025 + Math.round(x / 2)];
  const jar = W.jarSpots[23], jy = W.groundY(jar.x, jar.y);
  ok(jy > D.SEA_LEVEL + 1 && tAt(jar.x / PX, jar.y / PX) < D.SEA_LEVEL, `the pier jar stands on the pier deck (${jy.toFixed(2)} m) and TERRAIN under it is still the sea bed`);
  ok(Math.abs(W.groundY(1270 * PX, 500 * PX) - W.groundY(1262 * PX, 500 * PX)) < 0.3, 'the Riverwalk off the seawall is flush with the seawall top');
  // across the Rickenbacker's deck, 0 to 4.5 m off centre, GROUND is the banked road surface
  const e = W.roads.edges.find(q => q.road === 'rickenbacker' && q.deck.length), k = e.n >> 1;
  const tx = e.x[k + 1] - e.x[k - 1], tz = e.y[k + 1] - e.y[k - 1], l = Math.hypot(tx, tz), tb = Math.tan(e.bank[Math.min(e.bank.length - 1, Math.round(e.s[k] / PX / 2))]);
  let worst = 0;
  for (let o = -4.5; o <= 4.5; o += 0.5) worst = Math.max(worst, Math.abs(W.groundY(e.x[k] - tz / l * o * PX, e.y[k] + tx / l * o * PX) - (e.gy[k] - o * tb)));
  ok(e.deck.some(([a, b]) => e.s[k] >= a && e.s[k] <= b) && worst < 0.3, `the Rickenbacker deck is level with its banked surface out to its edge (worst ${worst.toFixed(2)} m)`);
  let sea = 0, n = 0;
  for (const L of W.roads.lanes) if (W.roads.edges[L.edge].deck.length) for (let i = 0; i < L.n; i++) if (W.surfaceAt(L.x[i], L.y[i]) === KIND.DECK) { n++; if (W.regionAt(L.x[i], L.y[i]) === 'sea') sea++; }
  ok(n > 1000 && sea === 0, `every bridge lane sample has a region (${sea} of ${n} read 'sea')`);
}

console.log('a fresh process builds the same rasters');
{
  const code = `const W = await import(${JSON.stringify(join(ROOT, 'src/world-v2.js'))}); W.generate();
    let h = 0x811c9dc5; for (const k of ['surf','ground','terrain','occ','reg','seaDepth']) { const a = W.grids[k], u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); for (let i = 0; i < u.length; i += 7) h = Math.imul(h ^ u[i], 16777619); }
    console.log(h >>> 0);`;
  const there = execFileSync('node', ['--input-type=module', '-e', code]).toString().trim();
  let h = 0x811c9dc5;
  for (const k of ['surf', 'ground', 'terrain', 'occ', 'reg', 'seaDepth']) { const a = W.grids[k], u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); for (let i = 0; i < u.length; i += 7) h = Math.imul(h ^ u[i], 16777619); }
  ok(String(h >>> 0) === there, `raster hash ${h >>> 0} here, ${there} there`);
}

console.log('the facade');
{
  const probe = kind => execFileSync('node', ['--input-type=module', '-e', `${kind ? `globalThis.KC_WORLD = '${kind}';` : ''}
    const F = await import(${JSON.stringify(join(ROOT, 'src/world.js'))}); F.generate();
    console.log(JSON.stringify({ kind: F.KIND, places: Object.keys(F.places).length, home: !!F.places.home?.foot, grids: !!F.grids, routes: Object.keys(F.routes) }));`]).toString().trim();
  const v2 = JSON.parse(probe('v2')), grid = JSON.parse(probe('grid')), def = JSON.parse(probe(null));
  ok(v2.kind === 'v2' && v2.places === 14 && v2.home && v2.grids && v2.routes.includes('street_kings'), `KC_WORLD='v2' picks v2: ${JSON.stringify(v2)}`);
  ok(grid.kind === 'grid' && !grid.grids && grid.routes.includes('street_kings'), `KC_WORLD='grid' picks the grid: ${JSON.stringify(grid)}`);
  // Since S9 the facade picks Kimchi Key when nothing asks for a map (spec §12.1).
  ok(process.env.KC_WORLD || def.kind === 'v2', `the default is Kimchi Key (since S9): ${JSON.stringify(def)}`);
}

console.log('drive and walk');
{
  const net = W.roads, rng = mulberry32(2026);
  let routed = 0, tries = 0;
  for (let n = 0; n < 120; n++) {
    const a = net.randomLanePoint({ rng }), b = net.randomLanePoint({ rng });
    if (!a || !b) continue;
    tries++;
    const r = net.route(a.x, a.y, b.x, b.y, { ai: true });
    if (r && fin(r.len)) routed++;
  }
  ok(tries > 100 && routed === tries, `traffic can route between random lane points (${routed}/${tries})`);
  let onFoot = 0, walks = 0;
  for (let n = 0; n < 400; n++) {
    const p = net.randomWalkPoint({ rng });
    if (!p) continue;
    walks++;
    if (!W.blockedFootPx(p.x, p.y)) onFoot++;
  }
  ok(walks > 300 && onFoot / walks > 0.98, `random sidewalk points stand on open ground (${onFoot}/${walks})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
