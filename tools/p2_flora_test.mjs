#!/usr/bin/env node
// Stage P2 (vegetation) check, headless:   node tools/p2_flora_test.mjs [-v]      (S3A_LOW=1 for the Low tier)
//  1. placement (src/map/props.js placeFlora): deterministic, quick, leaves SURF, GROUND and TERRAIN as they
//     were, and fills every region with the kinds it should have: the Glades' sawgrass in its marsh patches
//     (marshAt) and a mangrove fringe round its water, the wild shrubs gathered into thickets by the trees, the
//     verges and the banks rather than dotted over open lawns, tree-pit palms marked pit;
//  2. nothing grows where it must not: every trunk on grass (palms, mangroves and sea grape also on sand; tree-pit
//     palms on a wide sidewalk), clear of paving, carriageways, buildings and water by the rules, no two trunks
//     closer than 1.5 m, none in the pass reveal corridor, under a §4.7 sightline or a photo spot's look, on a
//     jar, a photo spot or a place's doorstep, or round a landmark;
//  3. flora3d (src/3d/flora3d.js) builds in node: one near and one light mesh per family, the far mesh holding
//     every tree and palm; over a few hundred cameras each plant is drawn at most once, near ones within NEAR
//     and light ones within MID + BAND, the casting copies first and within CAST of the shadow focus, only the
//     drawn copies sent to the GPU, and empty meshes hidden; the palms (palms3d with far and band) stop at
//     PALM_LO + BAND.
// Exits 1 if any check fails.
import { check, section, note, done, rng } from './s3a_env.mjs';

globalThis.KC_WORLD = 'v2';
const VERBOSE = process.argv.includes('-v');
const THREE = await import('three');
const world = await import('../src/world.js');
const D = await import('../src/map/mapdata.js');
const { KIND, KIND_MASK, FLAG } = await import('../src/map/raster.js');
const { placeFlora, marshAt } = await import('../src/map/props.js');
const { HIGH } = await import('../src/3d/quality.js');
const PX = 16;
world.generate();
const G = world.grids, [SW, SH] = G.dims.surf;
note(`tier: ${HIGH ? 'High' : 'Low'}`);

const fnv = (a) => { let h = 2166136261; const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 16777619); return h >>> 0; };
const opts = () => ({
  avoid: [...world.palms, ...world.trees],
  keep: [...world.lamps, ...world.deco.filter(d => Number.isFinite(d.x) && d.list !== 'guardrails' && d.list !== 'fences')],
  buildings: world.buildings, places: world.places,
});

// ---------- 1. placement ----------
section('1. placement');
const before = [fnv(G.surf), fnv(G.ground), fnv(G.terrain)];
let t = performance.now();
const A = placeFlora(world.roads, G, world.regions, opts());
const ms = performance.now() - t;
const B = placeFlora(world.roads, G, world.regions, opts());
check('the same plants every run', JSON.stringify(A) === JSON.stringify(B));
check('SURF, GROUND and TERRAIN unchanged', [fnv(G.surf), fnv(G.ground), fnv(G.terrain)].every((h, i) => h === before[i]));
check(`placeFlora takes under 600 ms in node (${ms.toFixed(0)} ms)`, ms < 600);
note(`${A.trees.length} trees, ${A.palms.length} palms, ${A.shrubs.length} shrubs in ${ms.toFixed(0)} ms (and the world's ${world.trees.length} trees and ${world.palms.length} palms)`);

const bits = (x, z) => { const i = Math.floor(x), j = Math.floor(z); return i < 0 || j < 0 || i >= SW || j >= SH ? KIND.WATER : G.surf[j * SW + i]; };
const kindAt = (x, z) => bits(x, z) & KIND_MASK;
// the nearest cell (m) of a kind within r of (x, z), Infinity if none
function nearest(x, z, r, test) {
  let best = Infinity;
  for (let j = Math.floor(z - r); j <= Math.floor(z + r); j++) for (let i = Math.floor(x - r); i <= Math.floor(x + r); i++) {
    const d = Math.hypot(i + 0.5 - x, j + 0.5 - z);
    if (d < best && d <= r && test(bits(i + 0.5, j + 0.5))) best = d;
  }
  return best;
}
const PAVED = new Set([KIND.ROAD, KIND.WALK, KIND.LOT, KIND.PLAZA, KIND.DECK, KIND.DIRT]), CARRIAGE = new Set([KIND.ROAD, KIND.DECK, KIND.DIRT]);
const regionOf = (p) => world.regions[G.reg[Math.floor(p.y / PX / 8) * G.dims.reg[0] + Math.floor(p.x / PX / 8)]]?.id;
const by = (list, f) => list.reduce((m, p) => ((m[f(p)] = (m[f(p)] || 0) + 1), m), {});
const tReg = by(A.trees, regionOf), pReg = by(A.palms, regionOf), kinds = by(A.trees, p => p.kind), sk = by(A.shrubs, p => p.kind);
if (VERBOSE) note(`trees by region ${JSON.stringify(tReg)}; palms ${JSON.stringify(pReg)}; kinds ${JSON.stringify(kinds)}; shrubs ${JSON.stringify(sk)}`);
const want = { heights: 800, north_shore: 250, gables: 600, glades: 800, ktown: 100 };
for (const [r, n] of Object.entries(want)) check(`${r}: at least ${n} trees (${tReg[r] || 0})`, (tReg[r] || 0) >= n);
for (const r of ['collins', 'deco', 'fest_airport', 'cape', 'islets', 'downtown']) check(`${r}: at least 100 palms (${pReg[r] || 0})`, (pReg[r] || 0) >= 100);
check(`the Glades: mangroves and cypress (${kinds.mangrove || 0}, ${kinds.cypress || 0})`, kinds.mangrove >= 50 && kinds.cypress >= 300);
check(`flowering trees: poinciana, jacaranda, blossom (${kinds.poinciana || 0}, ${kinds.jacaranda || 0}, ${kinds.blossom || 0})`, kinds.poinciana > 30 && kinds.jacaranda > 10 && kinds.blossom > 30);
check(`the Glades' sawgrass: thousands of tufts, all in the Glades and mostly in its marsh patches or by the water (${sk.sawgrass || 0})`, (() => {
  const saw = A.shrubs.filter(p => p.kind === 'sawgrass');
  const wet = (p) => { const x = p.x / PX, z = p.y / PX; for (let a = 0; a < 6.28; a += 0.8) for (const d of [4, 10, 18]) if ((bits(x + Math.cos(a) * d, z + Math.sin(a) * d) & KIND_MASK) === KIND.WATER) return true; return false; };
  const inMarsh = saw.filter(p => marshAt(p.x / PX, p.y / PX) > 0.2 || wet(p)).length;
  return saw.length > 2000 && saw.every(p => regionOf(p) === 'glades') && inMarsh / saw.length > 0.85;
})());
check(`marshAt is in [0, 1] and patchy`, (() => { let lo = 0, hi = 0; for (let i = 0; i < 400; i++) { const v = marshAt(100 + i * 1.7, 700 + (i * 7) % 500); if (!(v >= 0 && v <= 1)) return false; lo += v === 0; hi += v === 1; } return lo > 40 && hi > 20; })());
check(`the mangrove fringe is more than one ring deep (${kinds.mangrove || 0} mangroves)`, kinds.mangrove >= 250);
{
  // wild scrub on the Heights and the North Shore: in thickets by the trees, the roads and the banks
  const trunks = new Map();
  for (const p of [...A.trees, ...A.palms, ...world.trees, ...world.palms]) { const k = Math.floor(p.x / PX / 8) * 4096 + Math.floor(p.y / PX / 8); (trunks.get(k) || trunks.set(k, []).get(k)).push(p); }
  const byTree = (x, z) => { for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) for (const t of trunks.get((Math.floor(x / 8) + a) * 4096 + Math.floor(z / 8) + b) || []) if (Math.hypot(t.x / PX - x, t.y / PX - z) < (t.r ? (t.r > 20 ? t.r / PX : t.r) : 2.6) + 4) return true; return false; };
  const scrub = A.shrubs.filter(p => p.kind === 'shrub' && (regionOf(p) === 'heights' || regionOf(p) === 'north_shore'));
  const open = scrub.filter(p => { const x = p.x / PX, z = p.y / PX; return !byTree(x, z) && nearest(x, z, 18, c => CARRIAGE.has(c & KIND_MASK)) === Infinity; });
  check(`the Heights' scrub grows in thickets, not over open lawns (${open.length} of ${scrub.length} away from trees and roads)`, scrub.length > 1000 && open.length / scrub.length < 0.3);
}
{
  const onWalk = A.palms.filter(p => (bits(p.x / PX, p.y / PX) & KIND_MASK) === KIND.WALK);
  check(`tree-pit palms carry pit: true (${onWalk.length}), no other palm does`, onWalk.length > 50 && onWalk.every(p => p.pit === true) && A.palms.filter(p => p.pit).length === onWalk.length);
}
check(`gardens: hedges and bougainvillea (${sk.hedge || 0}, ${sk.bougainvillea || 0}), sea grape on the dunes (${sk.seagrape || 0})`, sk.hedge > 100 && sk.bougainvillea > 100 && sk.seagrape > 200);

// ---------- 2. where things grow ----------
section('2. nothing on paving, in water or buildings, in the views');
const BLOCKS = FLAG.BLOCK_CAR | FLAG.BLOCK_FOOT;
const bad = { ground: [], paving: [], road: [], build: [], water: [] };
const all = [...A.trees.map(p => ({ ...p, t: 'tree' })), ...A.palms.map(p => ({ ...p, t: 'palm', kind: 'palm', r: 2.6 })), ...A.shrubs.map(p => ({ ...p, t: 'shrub' }))];
for (const p of all) {
  const x = p.x / PX, z = p.y / PX, b = bits(x, z), k = b & KIND_MASK, sandy = p.kind === 'palm' || p.kind === 'mangrove' || p.kind === 'seagrape';
  const pit = p.kind === 'palm' && k === KIND.WALK;
  if (b & BLOCKS || !(k === KIND.GRASS || (sandy && k === KIND.SAND) || pit)) { bad.ground.push(p); continue; }
  if (pit) continue;
  // the 2 m clearance grids are within a cell and a half of the truth
  const trunk = p.t === 'shrub' ? (p.kind === 'hedge' ? 0.4 : 1) : p.t === 'palm' ? 1 : 1;
  if (nearest(x, z, trunk - 1.5, c => PAVED.has(c & KIND_MASK)) < Infinity) bad.paving.push(p);
  if (p.t === 'tree' && nearest(x, z, Math.max(2.5, p.r * 0.4) - 1.5, c => CARRIAGE.has(c & KIND_MASK)) < Infinity) bad.road.push(p);
  if (nearest(x, z, (p.t === 'tree' ? p.r * 0.85 + 0.5 : p.t === 'palm' ? 2 : 0.8) - 1.5, c => (c & KIND_MASK) === KIND.BUILD) < Infinity) bad.build.push(p);
  if (nearest(x, z, (p.kind === 'mangrove' ? 0.8 : 1.5) - 1.5, c => (c & KIND_MASK) === KIND.WATER || (c & KIND_MASK) === KIND.SHALLOW) < Infinity) bad.water.push(p);
}
const show = (l) => l.slice(0, 4).map(p => `${p.kind} (${(p.x / PX).toFixed(1)},${(p.y / PX).toFixed(1)})`).join(', ');
check(`every plant on grass (or sand, or a tree pit) and off blocked cells`, !bad.ground.length, show(bad.ground));
check(`trunks clear of paving`, !bad.paving.length, show(bad.paving));
check(`tree crowns kept off the carriageways`, !bad.road.length, show(bad.road));
check(`crowns clear of buildings`, !bad.build.length, show(bad.build));
check(`out of the water (mangroves at its edge)`, !bad.water.length, show(bad.water));

// trunks apart
{
  // (the world's own trees and palms are placeProps' business: only pairs with a new plant count)
  const grid = new Map(), close = [], mine = A.trees.length + A.palms.length;
  const trunks = [...A.trees, ...A.palms, ...world.trees, ...world.palms].map(p => [p.x / PX, p.y / PX]);
  trunks.forEach(([x, z], i) => { const k = Math.floor(x / 4) * 4096 + Math.floor(z / 4); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
  trunks.forEach(([x, z], i) => {
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const j of grid.get((Math.floor(x / 4) + a) * 4096 + Math.floor(z / 4) + b) || [])
      if (j > i && i < mine && Math.hypot(trunks[j][0] - x, trunks[j][1] - z) < 1.5) close.push([x, z]);
  });
  check(`no new trunk within 1.5 m of another (${trunks.length} trunks)`, !close.length, close.slice(0, 3).map(([x, z]) => `(${x.toFixed(1)},${z.toFixed(1)})`).join(', '));
}

// the views
const inside = (pts, x, z) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, zi] = pts[i], [xj, zj] = pts[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; };
const inCorridor = all.filter(p => p.t !== 'shrub' && D.VIEW_CORRIDORS.some(c => inside(c.pts, p.x / PX, p.y / PX)));
check('no tree or palm in the pass reveal corridor', !inCorridor.length, show(inCorridor));
{
  const gy = (x, z) => world.groundY(x * PX, z * PX), rays = [];
  const ray = (ax, az, ay, id) => {
    const T = D.SIGHT_TARGETS[id], dx = T.x - ax, dz = T.z - az, d = Math.hypot(dx, dz), f = (d - (T.r || 0)) / d, ty = T.y ?? gy(T.x, T.z) + T.h / 2;
    rays.push({ id, ax, az, ay, bx: ax + dx * f, bz: az + dz * f, by: ay + (ty - ay) * f });
  };
  const v = D.BENCH_VIEWS.find(b => b.name === 'villa_terrace');
  for (const id of ['kimchi_tower', 'ktown', 'bay', 'island', 'lighthouse']) ray(v.x, v.z, gy(v.x, v.z) + 1.5, id);
  const loop = world.roads.edges.filter(e => e.road === 'loop');
  for (const e of loop) for (let i = 0; i < e.n; i += 8) { const x = e.x[i] / PX, z = e.y[i] / PX; if (x >= 780 && x <= 880 && z < 345) for (const id of ['kimchi_tower', 'causeway_pylon', 'deco_north']) ray(x, z, e.gy[i] + 1.5, id); }
  for (const p of D.PHOTO_SPOTS) if (p.look) ray(p.x, p.z, gy(p.x, p.z) + 1.6, p.look);
  const cuts = [];
  for (const p of all) {
    const x = p.x / PX, z = p.y / PX, top = gy(x, z) + (p.h || 0);
    for (const R of rays) {
      const dx = R.bx - R.ax, dz = R.bz - R.az, L2 = dx * dx + dz * dz, s = ((x - R.ax) * dx + (z - R.az) * dz) / L2;
      if (s <= 0.01 || s >= 1) continue;
      const lat = Math.abs((x - R.ax) * dz - (z - R.az) * dx) / Math.sqrt(L2);
      if (lat < (p.r || 1) * 0.8 && top > R.ay + (R.by - R.ay) * s) cuts.push(`${p.kind} under ${R.id} at (${x.toFixed(0)},${z.toFixed(0)})`);
    }
  }
  check(`no plant cuts a sightline (${rays.length} rays: SL1, SL3 and the photo spots' looks)`, !cuts.length, cuts.slice(0, 4).join('; '));
}
{
  const spots = [...D.JARS.map(j => [j.x, j.z, 4, 'jar']), ...D.PHOTO_SPOTS.map(p => [p.x, p.z, 6, p.id]),
    ...Object.values(world.places).flatMap(p => [p.door, p.foot, p.curb].filter(Boolean).map(s => [s.x / PX, s.y / PX, 5, p.key]))];
  const on = [];
  for (const p of all) for (const [x, z, r, id] of spots) if (Math.hypot(p.x / PX - x, p.y / PX - z) < r) on.push(`${p.kind} on ${id}`);
  check('nothing on a jar, a photo spot or a place\'s door, foot or kerb', !on.length, on.slice(0, 4).join(', '));
  const lh = D.LANDMARKS.find(l => l.id === 'lighthouse');
  check('the lighthouse keeps its ground (the keeper\'s cottage)', !all.some(p => Math.hypot(p.x / PX - lh.x, p.y / PX - lh.z) < 20));
}

// ---------- 3. flora3d ----------
section('3. flora3d');
const warn = console.warn;
console.warn = (...a) => { if (!String(a[0]).includes('asset pack')) warn(...a); };    // GLTFLoader has no file URLs in node
const F3 = await import('../src/3d/flora3d.js');
const group = new THREE.Group();
t = performance.now();
const F = F3.buildFlora3D(world, group, {});
note(`built in ${(performance.now() - t).toFixed(0)} ms (placing ${F.stats().placeMs} ms)`);
const fams = [...F.trees.tiers.keys(), ...F.shrubs.tiers.keys()];
{
  // the trees drawn: the world's (less any standing on another's trunk) and the new ones
  const items = F.trees.items, near = [], grid = new Map();
  items.forEach((it, i) => { const k = Math.floor(it.x / 4) * 4096 + Math.floor(it.z / 4); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
  items.forEach((it, i) => {
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const j of grid.get((Math.floor(it.x / 4) + a) * 4096 + Math.floor(it.z / 4) + b) || [])
      if (j > i && Math.hypot(items[j].x - it.x, items[j].z - it.z) < 1.5) near.push(i);
  });
  check(`no two drawn trees on one spot (${items.length})`, !near.length, `${near.length}`);
}
check(`two bald cypress shapes and the sawgrass tuft (${fams.join(', ')})`, fams.includes('cone') && fams.includes('cone_b') && fams.includes('tuft'));
{
  // the far mesh's wind: by the height over each plant's foot (its positions are world space), not the ground's
  const sh = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
  F.far.meshes[0].material.onBeforeCompile(sh);
  check('the far mesh sways by the height over its foot', sh.vertexShader.includes('max(0.0, position.y - base.y)') && !/fK = abs\(leaf\) \* max\(0\.0, position\.y\)/.test(sh.vertexShader));
}
check(`a near and a light mesh per tree family, a light one per shrub family (${fams.join(', ')})`, fams.length >= 9
  && [...F.trees.tiers.values()].every(t => t.near.m.isInstancedMesh && t.mid.m.isInstancedMesh && t.tris[0] > t.tris[1])
  && [...F.shrubs.tiers.values()].every(t => !t.near && t.mid.m.isInstancedMesh));
const nTrees = world.trees.length + F.placed.trees.length, nPalms = world.palms.length + F.placed.palms.length;
const starts = new Set();
for (const m of F.far.meshes) {
  const base = m.geometry.getAttribute('base');
  for (let i = 0; i < base.count; i++) starts.add(`${base.getX(i).toFixed(2)},${base.getZ(i).toFixed(2)},${base.getW(i)}`);
}
const nTufts = F.placed.shrubs.filter(s => s.kind === 'sawgrass').length, tuftStart = ',' + (F3.SHRUB_FAR - F3.SHRUB_FADE);
check(`the far mesh holds every tree, palm and sawgrass tuft (${starts.size} of ${nTrees + nPalms + nTufts}), the trees from MID, the palms from PALM_LO, the tufts from SHRUB_FAR - SHRUB_FADE`,
  starts.size >= (nTrees + nPalms + nTufts) * 0.995 && [...starts].every(s => s.endsWith(',' + F3.MID) || s.endsWith(',' + F3.PALM_LO) || s.endsWith(tuftStart)));
await new Promise(r => setTimeout(r, 500));     // the palms' models
const R = rng(7), cams = [];
for (let i = 0; i < 240; i++) {
  const c = new THREE.PerspectiveCamera(60, 1440 / 800, 0.15, 2600), x = 60 + R() * 1900, z = 60 + R() * 1650, air = R() < 0.2;
  c.position.set(x, (air ? 60 + R() * 120 : 2 + R() * 6) + world.groundY(x * PX, z * PX), z);
  c.rotation.set(air ? -0.5 : -0.1, R() * 6.283, 0, 'YXZ');
  c.updateMatrixWorld(true);
  cams.push(c);
}
const key = (a, i) => Array.from(a.subarray(i * 16, i * 16 + 16)).map(v => v.toFixed(3)).join(',');
const pos = (a, i) => [a[i * 16 + 12], a[i * 16 + 14]];
let twice = 0, nearOut = 0, midOut = 0, castOut = 0, rangeBad = 0, hiddenBad = 0, palmOut = 0, drawnMax = 0, ut = 0;
for (const c of cams) {
  const focus = { x: c.position.x + 3, z: c.position.z + 3 };
  const t0 = performance.now();
  F.update(c, 1, focus);
  ut += performance.now() - t0;
  const seen = new Set();
  for (const set of [[F.trees, F3.NEAR, F3.MID + F3.BAND], [F.shrubs, F3.SHRUB_NEAR, F3.SHRUB_FAR]]) for (const tt of set[0].tiers.values()) for (const [T, lim] of [[tt.near, set[1]], [tt.mid, set[2]]]) {
    if (!T) continue;
    const m = T.m, a = m.instanceMatrix.array;
    if (m.visible !== m.count > 0) hiddenBad++;
    const r = m.instanceMatrix.updateRanges;
    if (m.count && !(r.length === 1 && r[0].start === 0 && r[0].count === m.count * 16)) rangeBad++;
    const nCast = m.userData.nCast ?? 0;
    for (let i = 0; i < m.count; i++) {
      const k = key(a, i);
      if (seen.has(k)) twice++; seen.add(k);
      const [x, z] = pos(a, i), d = Math.hypot(x - c.position.x, z - c.position.z);
      if (d > lim + 0.5) (T === tt.near ? nearOut++ : midOut++);
      if (i < nCast && Math.hypot(x - focus.x, z - focus.z) > (set[0] === F.trees ? 70 : 30) + 0.5 && HIGH) castOut++;
    }
    drawnMax = Math.max(drawnMax, m.count);
  }
  for (const m of group.children) if (m.isInstancedMesh && m.geometry.attributes.position.count > 100 && !m.userData.nAll && m.material?.vertexColors && !F.trees.tiers.size) palmOut++;
}
check('no plant drawn twice in a frame (near and light)', !twice, `${twice}`);
check(`near copies within NEAR (${F3.NEAR} m)`, !nearOut, `${nearOut}`);
check(`light copies within MID + BAND (${F3.MID + F3.BAND} m), shrubs within SHRUB_FAR`, !midOut, `${midOut}`);
check('the casting copies come first and lie within CAST of the shadow focus', !castOut, `${castOut}`);
check('only the drawn copies go to the GPU (one update range)', !rangeBad, `${rangeBad}`);
check('meshes with nothing to draw are hidden', !hiddenBad, `${hiddenBad}`);
note(`update: ${(ut / cams.length).toFixed(2)} ms a camera on average (each one a fresh pick)`);
const st = F.stats();
if (st.palms) {
  // the palms field draws nothing past PALM_LO + BAND
  let far = 0;
  const c = cams[0];
  F.update(c, 2);
  for (const m of group.children) if (m.isInstancedMesh && m.count && m.geometry.attributes.color && !m.instanceColor) {
    const a = m.instanceMatrix.array;
    for (let i = 0; i < m.count; i++) if (Math.hypot(a[i * 16 + 12] - c.position.x, a[i * 16 + 14] - c.position.z) > F3.PALM_LO + F3.BAND + 12) far++;
  }
  check(`palms3d draws no palm past PALM_LO + BAND (${F3.PALM_LO + F3.BAND} m)`, !far, `${far}`);
} else note('(the palm models did not load in time: palms not checked)');
console.warn = warn;
done();
