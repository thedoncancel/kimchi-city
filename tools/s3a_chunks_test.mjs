#!/usr/bin/env node
// Stage S3a check (docs/map-v2-stages.json): src/3d/chunks.js, the chunk manager, and its 64 m buckets.
//   node tools/s3a_chunks_test.mjs
// - add(): layer far distances with hysteresis (on at far, off at far + 20 m), lod0/lod1 never both hidden,
//   setFar(), remove(), and shadow casting only within 110 m of the focus (only meshes that cast to begin with).
// - lazy(): a drive across an 8 x 7 tile county at 50 m/s with cells that take several 1 ms steps to build.
//   Every slice keeps to its 3 ms budget (plus the one step it cannot cut short); cells near the camera are
//   built in time; cells ahead (3 s of velocity) are built before cells behind; at most 36 cells are kept
//   unless more are in use; evicted cells have their geometry disposed; buildAround() builds the spawn area.
// - lazy() at High's 300 m: more cells are in use than the 36-cell cache holds. The cache runs over instead
//   of throwing away what the look-ahead just built: no cell is built more than twice on a 2 minute loop of
//   the county at 50 m/s, no cell is ever left 'queued' outside the queue, cells near the camera are never
//   late. Also: a cell's within follows setFar() on its layer, and a built cell shows with 20 m hysteresis.
// - makeBuckets(): near() returns exactly the buckets an item within r can be in.
// Exits 1 if any check fails.
import { check, section, note, done, rng, src } from './s3a_env.mjs';

const THREE = await import('three');
const CH = await import(src('src/3d/chunks.js'));
const { makeChunkManager, makeBuckets, TILE, CELL } = CH;

const camAt = (x, z) => ({ position: { x, y: 2, z } });

section('add(): layers, hysteresis, shadow casters');
{
  const scene = new THREE.Scene();
  const ch = makeChunkManager(scene);
  const mk = (cast = true) => { const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()); m.castShadow = cast; return m; };
  const road = ch.add(mk(), { tile: '0,0', layer: 'roads' });            // tile x 0-256: far 400
  check('add() puts the object in the scene', road.obj.parent === scene);
  const at = (x) => { ch.update(camAt(x, 128), { x, z: 128 }, 1 / 60); return road.obj.visible; };
  check('in range: drawn', at(200) === true);
  check('just past far, inside the hysteresis: still drawn', at(256 + 410) === true);
  check('past far + 20 m: hidden', at(256 + 424) === false);
  check('back inside far + 20 but not far: stays hidden', at(256 + 414) === false);
  check('inside far again: drawn', at(256 + 394) === true);

  // lod0 (far 350) and lod1 (near 350) on the same tile: a random walk never sees both hidden
  const l0 = ch.add(mk(false), { tile: '0,0', layer: 'lod0' }), l1 = ch.add(mk(false), { tile: '0,0', layer: 'lod1' });
  const r = rng(3);
  let x = 300, holes = 0, both = 0, bothOutside = 0;
  for (let i = 0; i < 4000; i++) {
    x = Math.max(260, Math.min(900, x + (r() - 0.5) * 30));
    ch.update(camAt(x, 128), null, 1 / 60);
    const d = x - 256;
    if (!l0.obj.visible && !l1.obj.visible) holes++;
    if (l0.obj.visible && l1.obj.visible) { both++; if (d < 330 || d > 370) bothOutside++; }
  }
  check('lod0 / lod1: never a hole', holes === 0, `${holes} frames with neither`);
  check('lod0 / lod1: overlap only inside the hysteresis band', bothOutside === 0, `${bothOutside} of ${both}`);

  // setFar: the layer is read again
  ch.update(camAt(256 + 300, 128), null, 1 / 60);
  check('setFar(): before, a road 300 m off is drawn', road.obj.visible === true);
  ch.setFar('roads', 200);
  ch.update(camAt(256 + 300, 128), null, 1 / 60);
  check('setFar(): roads cut to 200 m hide it', road.obj.visible === false);
  ch.setFar('roads', 400);

  // shadow casters within 110 m of the focus (+10 m hysteresis), measured to the tile
  const caster = ch.add(mk(true), { cell: '0,0', layer: 'props' });      // cell x 0-128
  const quiet = ch.add(mk(false), { cell: '0,0', layer: 'props' });
  const cast = (fx) => { ch.update(camAt(64, 64), { x: fx, z: 64 }, 1 / 60); return caster.obj.castShadow; };
  check('focus 200 m off: no shadow', cast(128 + 200) === false);
  check('focus 105 m off: casts', cast(128 + 105) === true);
  check('focus 115 m off: still casts (hysteresis)', cast(128 + 115) === true);
  check('focus 125 m off: stops', cast(128 + 125) === false);
  check('focus 112 m off: stays off until 110', cast(128 + 112) === false);
  check('a mesh that never cast is never switched on', (cast(128 + 50), quiet.obj.castShadow === false));

  // a group: only the children that cast are switched
  const grp = new THREE.Group(), a = mk(true), b = mk(false);
  grp.add(a, b);
  ch.add(grp, { box: [1000, 1000, 1100, 1100], layer: 'detail' });
  ch.update(camAt(1050, 1050), { x: 1600, z: 1050 }, 1 / 60);
  check('group: casting child switched off far from the focus', a.castShadow === false && b.castShadow === false);
  ch.update(camAt(1050, 1050), { x: 1050, z: 1050 }, 1 / 60);
  check('group: and back on near it, the other left alone', a.castShadow === true && b.castShadow === false);

  check('remove(): out of the scene and casting restored', ch.remove(caster.obj) && caster.obj.parent === null && caster.obj.castShadow === true);
  const s = ch.stats();
  check('stats(): objects counted', s.objects === 5 && typeof s.visible === 'number' && typeof s.casting === 'number');
}

section('lazy(): build queue, budget, look-ahead, LRU');
{
  const scene = new THREE.Scene();
  const ch = makeChunkManager(scene, { budgetMs: 3 });
  let disposed = 0, stepMs = 1;
  const builtOrder = [];
  const busy = (ms) => { const t = performance.now(); while (performance.now() - t < ms) { /* work */ } };
  // a cell takes 4 steps of 1 ms (a generator), and makes a group with a casting mesh in it
  function* build(key) {
    for (let k = 0; k < 4; k++) { busy(stepMs); yield; }
    const g = new THREE.Group(), geo = new THREE.BoxGeometry(1, 1, 1);
    geo.addEventListener('dispose', () => disposed++);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial()); m.castShadow = true;
    g.add(m);
    builtOrder.push(key);
    return g;
  }
  const COLS = 8 * TILE / CELL, ROWS = 7 * TILE / CELL;   // the 2048 x 1792 m county in 128 m cells
  const cells = [];
  for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) cells.push(ch.lazy(`${i},${j}`, build, { within: 220 }));

  // the spawn area at once
  const t0 = performance.now();
  const n0 = ch.buildAround(150, 150, 220);
  note(`buildAround: ${n0} cells in ${(performance.now() - t0).toFixed(0)} ms`);
  const dist = (c, x, z) => { const b = c.box, dx = Math.max(b[0] - x, 0, x - b[2]), dz = Math.max(b[1] - z, 0, z - b[3]); return Math.hypot(dx, dz); };
  check('buildAround(): every cell within 220 m built', cells.filter(c => dist(c, 150, 150) <= 220).every(c => c.state === 'built'));
  ch.update(camAt(150, 150), null, 1 / 60);
  check('buildAround(): shown on the next update', cells.filter(c => dist(c, 150, 150) <= 220).every(c => c.obj.visible));

  // drive east along z = 150 at 50 m/s, then north-east across the county, then back west
  const path = [[150, 150], [1900, 150], [1900, 1650], [200, 1650]];
  let x = 150, z = 150, leg = 1, frames = 0, overBudget = 0, maxSlice = 0, late = 0, peak = 0, lateList = [], overCache = 0;
  const dt = 1 / 60, v = 50;
  while (leg < path.length) {
    const [tx, tz] = path[leg], dx = tx - x, dz = tz - z, d = Math.hypot(dx, dz);
    if (d < v * dt) { leg++; continue; }
    x += dx / d * v * dt; z += dz / d * v * dt;
    ch.update(camAt(x, z), { x, z }, dt);
    frames++;
    const s = ch.stats();
    maxSlice = Math.max(maxSlice, s.sliceMs);
    if (s.sliceMs > 3 + stepMs + 0.6) overBudget++;
    peak = Math.max(peak, s.built);
    if (s.built > 36 && !cells.every(c => c.state !== 'built' || c.obj.visible || Math.min(c.d, c.da) <= c.drop)) overCache++;
    // after the start, every cell within 150 m must be there and drawn (the look-ahead gives ~150 m of lead)
    if (frames > 30) for (const c of cells) if (dist(c, x, z) <= 150 && !(c.state === 'built' && c.obj.visible)) { late++; if (lateList.length < 5) lateList.push(`${c.key}@${frames}`); }
  }
  const s = ch.stats();
  note(`${frames} frames, ${s.builds} builds, ${s.evictions} evictions, ${s.aborted} aborted; slice max ${maxSlice.toFixed(2)} ms, avg ${s.avgSliceMs.toFixed(2)} ms; peak ${peak} cells`);
  // (one slice in a thousand may run over: the machine can stall a busy-wait step, which no budget prevents)
  check('slices keep to the 3 ms budget (plus one step)', overBudget <= frames / 1000, `${overBudget} slices over, max ${maxSlice.toFixed(2)} ms`);
  check('cells within 150 m are always built and drawn', late === 0, `${late} late: ${lateList.join(' ')}`);
  check('at most 36 cells built, unless more are in use', overCache === 0, `${overCache} frames over with a cell to spare, peak ${peak}`);
  check('evicted cells had their geometry disposed', s.evictions > 0 && disposed === s.evictions, `${disposed} disposed, ${s.evictions} evicted`);
  check('cells out of range are hidden', cells.every(c => c.state !== 'built' || !c.obj || (dist(c, x, z) <= c.drop ? c.obj.visible : dist(c, x, z) > c.drop + 20 ? !c.obj.visible : true)));

  // the look-ahead: at x = 1067 the cell 43 m behind the camera (7,7) is nearer than the one 85 m ahead (9,7).
  // Standing still, the queue builds the nearer one first; driving east at 40 m/s, the one ahead.
  function buildRank(moving) {
    const m = makeChunkManager(new THREE.Scene(), { budgetMs: 3 });
    const order = [];
    const slowCell = function* (key) { for (let k = 0; k < 4; k++) { busy(1); yield; } order.push(key); return null; };
    let cx = moving ? 1067 - 60 : 1067;
    for (let f = 0; f < 90; f++) { if (moving) cx += 40 / 60; m.update(camAt(cx, 900), null, 1 / 60); }
    for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) m.lazy(`${i},${j}`, slowCell, { within: 220 });
    for (let f = 0; f < 40 && order.length < 12; f++) { if (moving) cx += 40 / 60; m.update(camAt(cx, 900), null, 1 / 60); }
    return { ahead: order.indexOf('9,7'), behind: order.indexOf('7,7'), order: order.slice(0, 8).join(' ') };
  }
  const still = buildRank(false), driving = buildRank(true);
  note(`first builds standing: ${still.order}; driving east: ${driving.order}`);
  check('look-ahead: standing still, the nearer cell behind comes first', still.behind >= 0 && still.ahead > still.behind, JSON.stringify(still));
  check('look-ahead: driving, the cell ahead comes first', driving.ahead >= 0 && (driving.behind < 0 || driving.ahead < driving.behind), JSON.stringify(driving));

  // a generator dropped half-way when the camera leaves (teleport)
  const ch3 = makeChunkManager(new THREE.Scene(), { budgetMs: 0.5 });
  let closed = 0;
  const slow = function* () { try { for (let k = 0; k < 50; k++) { busy(0.3); yield; } } finally { closed++; } return null; };
  ch3.lazy('0,0', slow, { within: 100 });
  for (let f = 0; f < 3; f++) ch3.update(camAt(64, 64), null, 1 / 60);
  ch3.update(camAt(1900, 1700), null, 1 / 60);
  const s3 = ch3.stats();
  check('a build abandoned when the camera leaves', s3.aborted === 1 && closed === 1 && s3.building === 0, JSON.stringify(s3));

  ch.dispose();
  check('dispose(): everything out of the scene', scene.children.length === 0);
}

section('lazy(): High detail (300 m), more cells in use than the cache holds');
{
  // the reviewer's minimal case: a 2-cell cache full of cells in range, and the look-ahead reaching two more
  // beyond drop. They are built once each and kept, not built and thrown away every frame.
  const sceneA = new THREE.Scene(), chA = makeChunkManager(sceneA, { maxCells: 2 });
  const count = {};
  const g = (k) => { count[k] = (count[k] || 0) + 1; return new THREE.Group(); };
  const A = chA.lazy('A', g, { box: [0, 0, 10, 10], within: 50 }), B = chA.lazy('B', g, { box: [20, 0, 30, 10], within: 50 });
  const C = chA.lazy('C', g, { box: [150, 0, 160, 10], within: 50 }), D = chA.lazy('D', g, { box: [170, 0, 180, 10], within: 50 });
  chA.buildAround(5, 5, 30);
  let orphanA = 0;
  for (let f = 0; f < 40; f++) {
    chA.update(camAt(5 + f * 40 / 60, 5), null, 1 / 60);
    const s = chA.stats();
    if (s.queued + s.building !== s.waiting) orphanA++;
  }
  check('look-ahead cells beyond drop: built once and kept', count.C === 1 && count.D === 1 && C.state === 'built' && D.state === 'built', JSON.stringify(count));
  check('look-ahead cells beyond drop: no cell left out of the queue', orphanA === 0 && A.state === 'built' && B.state === 'built', `${orphanA}`);

  // a 2-minute loop round the county at 50 m/s with within 300 (drop 340): cells take 2 steps of 0.3 ms
  const scene = new THREE.Scene(), ch = makeChunkManager(scene, {});
  const COLS = 8 * TILE / CELL, ROWS = 7 * TILE / CELL, builds = new Map();
  const busy = (ms) => { const t = performance.now(); while (performance.now() - t < ms) { /* work */ } };
  function* build(key) { builds.set(key, (builds.get(key) || 0) + 1); busy(0.3); yield; busy(0.3); return new THREE.Group(); }
  const cells = [];
  for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) cells.push(ch.lazy(`${i},${j}`, build, { within: 300 }));
  const dist = (c, x, z) => { const b = c.box, dx = Math.max(b[0] - x, 0, x - b[2]), dz = Math.max(b[1] - z, 0, z - b[3]); return Math.hypot(dx, dz); };
  const sp = 50, dt = 1 / 60;
  let x = 100, z = 900, vx = sp, vz = 0, orphan = 0, late = 0, peak = 0, overCache = 0, overBudget = 0;
  ch.buildAround(x, z, 300);
  for (let f = 0; f < 60 * 120; f++) {
    x += vx * dt; z += vz * dt;
    if (x > COLS * CELL - 100 && vx > 0) { vx = 0; vz = -sp; }
    if (z < 100 && vz < 0) { vz = 0; vx = -sp; }
    if (x < 100 && vx < 0) { vx = 0; vz = sp; }
    if (z > ROWS * CELL - 100 && vz > 0) { vz = 0; vx = sp; }
    ch.update(camAt(x, z), null, dt);
    const s = ch.stats();
    if (s.queued + s.building !== s.waiting) orphan++;
    if (s.sliceMs > 3 + 0.6 + 0.6) overBudget++;
    peak = Math.max(peak, s.built);
    if (s.built > 36 && !cells.every(c => c.state !== 'built' || c.obj.visible || Math.min(c.d, c.da) <= c.drop)) overCache++;
    if (f > 30) for (const c of cells) if (dist(c, x, z) <= 150 && !(c.state === 'built' && c.obj.visible)) late++;
  }
  const s = ch.stats(), most = Math.max(...builds.values());
  note(`${s.builds} builds of ${builds.size} cells, ${s.evictions} evictions, peak ${peak} cells, most builds of one cell ${most}, slice max ${s.maxSliceMs.toFixed(2)} ms`);
  check('High: no cell is built more than twice', most <= 2, `${most}`);
  check('High: no cell is ever queued outside the queue', orphan === 0, `${orphan} frames`);
  check('High: cells within 150 m are always built and drawn', late === 0, `${late} cell-frames late`);
  check('High: the cache only runs over 36 while every cell in it is in use', overCache === 0, `${overCache} frames`);
  check('High: slices keep to the 3 ms budget (plus one step)', overBudget <= 60 * 120 / 1000, `${overBudget} over, max ${s.maxSliceMs.toFixed(2)} ms`);

  // a cell without its own within follows its layer: setFar('detail', 300) after it was registered
  const ch2 = makeChunkManager(new THREE.Scene(), {});
  const cell = ch2.lazy('5,0', () => new THREE.Group());          // x 640-768
  ch2.update(camAt(640 - 260, 64), null, 1 / 60);
  check('lazy(): within comes from the layer (detail 220)', cell.within === 220 && cell.state === 'idle');
  ch2.setFar('detail', 300);
  ch2.update(camAt(640 - 260, 64), null, 1 / 60);
  check('lazy(): setFar() reaches a cell registered before it', cell.within === 300 && cell.drop === 340 && cell.state === 'built');

  // shown at drop, hidden only 20 m past it
  const at = (d) => { ch2.update(camAt(640 - d, 64), null, 1 / 60); return !!cell.obj?.visible; };
  check('hysteresis: shown within drop', at(330) === true);
  check('hysteresis: still shown 15 m past drop', at(355) === true);
  check('hysteresis: hidden 25 m past drop', at(365) === false);
  check('hysteresis: stays hidden 10 m past drop', at(350) === false);
  check('hysteresis: shown again at drop', at(338) === true);
}

section('makeBuckets()');
{
  const r = rng(11), items = [];
  for (let i = 0; i < 5000; i++) items.push({ x: -80 + r() * 900, z: -40 + r() * 700, i });
  const B = makeBuckets(items);
  let wrong = 0;
  const lists = [];
  for (let k = 0; k < 300; k++) {
    const x = -150 + r() * 1100, z = -150 + r() * 900, rad = 10 + r() * 260;
    const got = new Set();
    for (const list of B.near(x, z, rad, lists)) for (const it of list) got.add(it.i);
    for (const it of items) if ((it.x - x) ** 2 + (it.z - z) ** 2 <= rad * rad && !got.has(it.i)) wrong++;
  }
  check('near(): no item within r is ever missed', wrong === 0, `${wrong} missed`);
  const all = B.near(400, 300, 5000);
  check('near(): every item in exactly one bucket', all.reduce((n, l) => n + l.length, 0) === items.length);
  const few = B.near(400, 300, 70);
  check('near(): a small radius looks at few buckets', few.length <= 9 && few.length >= 1, `${few.length}`);
  check('near(): items keep their order in a bucket', all.every(l => l.every((it, k) => k === 0 || l[k - 1].i < it.i)));
  check('empty bucket set', makeBuckets([]).near(0, 0, 100).length === 0);
}

done();
