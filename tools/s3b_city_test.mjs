#!/usr/bin/env node
// Stage S3b check (docs/map-v2-stages.json, spec §11.1): the grid city cut into the chunk manager's 128 m cells.
//   node tools/s3b_city_test.mjs [baselineDir]          (S3B_LOW=1 for the phone tier)
// baselineDir (default $KC_BASELINE) is an untouched copy of the project from before the v2 rebuild.
//  1. The facade: buildCity returns the city's chunk manager, and update(cam, t) runs chunks.update (with the
//     sun's target as the shadow focus and dt from the clock) before the city sorts its cells.
//  2. With a baseline: the old city.js and the new one each build the grid city in node, and what they draw
//     is the same: per material and shadow flags, the same triangles (corner for corner: position, normal,
//     uv, colour) and the same instanced copies, by day and at night. (The objects themselves differ: the
//     merged meshes are indexed and grouped by cell, and the street life is a mesh per 64 m quarter of a
//     128 m cell instead of one per 60 m chunk.)
//  3. The bench views and a drive round the town: every cell is drawn and casts exactly as the chunk rules say
//     (everything drawn at any distance, the street life too, so every street cell in the camera's view is
//     drawn; casting within 110 m of the shadow focus on both tiers, +10 m), each merged mesh's index
//     holds exactly its triangles with the camera pass
//     drawing the drawn cells and the shadow pass the casting ones, and the shadow pass (walked the way
//     three.js walks it) holds no caster from further out, nor does any separate object (the jet, the yachts)
//     stay set to cast from further out. With a baseline: the city's draw calls (camera +
//     shadow pass) and its shadow triangles are at or below the old city's in every bench view, at 13:00 and
//     15:30, and its camera-pass triangles within 8% of the old city's.
//     The title screen (the clock held at 18:51, the sun about 2 degrees up, the focus the middle of the town),
//     fresh and after a frame of play in a corner: every building, tree, lamp and separate object inside the
//     sun's shadow box casts; the only street life in it that casts nothing is the beach props west of the
//     town, past the cast radius (the lead's low-sun trade-off).
//  4. nearestLamps (now a 64 m bucket search) picks exactly what sorting every lamp picks, and comes back at
//     once (with no lamps) for a point that is NaN or infinite.
// Exits 1 if any check fails.
import { spawnSync } from 'node:child_process';
import { HAVE_BASE, src, base, check, section, note, done, seeded, quiet, canvasSig, fnv } from './s3b_env.mjs';
const D = await import('./s3b_draws.mjs');
const THREE = await import('three');

const W = await import(src('src/world.js'));
const CITY = await import(src('src/3d/city.js'));
const CG = await import(src('src/3d/cityGrid.js'));
const CH = await import(src('src/3d/chunks.js'));
W.generate();

// (cityGrid's cast radius: the spec's 110 m on both tiers; the low tier's shadow box is 84 m across, not 128 m)
const LOW_TIER = process.env.S3B_LOW === '1';
const CELL = CH.CELL, CAST_R = 110, CAST_H = 10, HYST = 20;
let STREET_FAR = NaN;   // how far the city's own chunk manager draws the street life (read once it is built)
const LAG = 1;   // m: the chunk manager looks at its entries again only once the camera or focus moved 1 m
const VIEW_OPTS = { groundY: W.groundY, occluderTop: (x, z) => CITY.occluderTop(x, z) };
const quietFails = [];   // the first few things a quiet check found wrong, for its summary
// (for the drawn-content signatures at the end of the file)
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const MAT_KEYS = ['type', 'side', 'transparent', 'opacity', 'depthWrite', 'depthTest', 'blending', 'vertexColors', 'flatShading', 'fog', 'polygonOffset',
  'polygonOffsetFactor', 'polygonOffsetUnits', 'roughness', 'metalness', 'emissiveIntensity', 'alphaTest', 'toneMapped', 'wireframe'];
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _nm = new THREE.Matrix3(), _m4 = new THREE.Matrix4();
const _frustum = new THREE.Frustum(), _pv = new THREE.Matrix4();
const S = 1 / 16;
const settle = () => new Promise((r) => setTimeout(r, 1500));   // the palm and asset-pack models load from disk

// ---------- build the new city (and the old one, with a baseline) ----------

const scene = new THREE.Scene();
const sun = D.makeSun(LOW_TIER ? 42 : 64);
scene.add(sun, sun.target);
// what each city draws, taken right after the build (before any chunk update every cell is drawn and casts),
// by day and at night
let snapNew = null, nightNew = null;
const city = await quiet(() => seeded(7, () => {
  const c = CITY.buildCity(scene);
  snapNew = content(scene);
  c.setNight(0.6); nightNew = content(scene); c.setNight(0);
  return c;
}));
// the separate meshes made to cast (until the first chunk update every caster casts), for the title check
const madeToCast = new Set();
city.group.traverse((o) => { if (isSeparate(o) && o.castShadow) madeToCast.add(o); });

let OW = null, OC = null, oldScene = null, oldCity = null, snapOld = null, nightOld = null, oldSun = null;
if (HAVE_BASE) {
  OW = await import(base('src/world.js'));
  OC = await import(base('src/3d/city.js'));
  OW.generate();
  oldScene = new THREE.Scene();
  oldSun = D.makeSun(LOW_TIER ? 42 : 64);
  oldScene.add(oldSun, oldSun.target);
  oldCity = await quiet(() => seeded(7, () => {
    const c = OC.buildCity(oldScene);
    snapOld = content(oldScene);
    c.setNight(0.6); nightOld = content(oldScene); c.setNight(0);
    return c;
  }));
}
await quiet(settle);
// the title screen as the game opens on it, before any frame of play (checked in section 3). The chunk
// manager is run on its own here, as the facade's first frame runs it (dt 0), so section 1 still sees the
// facade's first frame.
const titleCam = new THREE.PerspectiveCamera(62, 1440 / 800, 0.1, 4000);
const titleFresh = titleShadows((cam, focus) => { for (let i = 0; i < 3; i++) city.chunks.update(cam, focus, 0); });

// ---------- 1. the facade ----------

section('facade: buildCity and update');
const chunks = city.chunks;
check('buildCity returns the chunk manager', !!chunks && typeof chunks.update === 'function' && typeof chunks.stats === 'function');
check('buildCity returns { group, update, setNight, chunks }', city.group?.isGroup && typeof city.update === 'function' && typeof city.setNight === 'function');
{
  const calls = [];
  const real = chunks.update;
  chunks.update = (cam, focus, dt) => { calls.push({ x: cam.position.x, f: focus && { x: focus.x, z: focus.z }, dt }); return real(cam, focus, dt); };
  const cam = new THREE.PerspectiveCamera(62, 1.8, 0.1, 4000);
  sun.target.position.set(40, 0, 50);
  cam.position.set(40, 3, 55); cam.updateMatrixWorld();
  city.update(cam, 100); city.update(cam, 100.016);
  check('update runs chunks.update every frame', calls.length === 2);
  check('the shadow focus handed over is the sun\'s target', calls[1]?.f?.x === 40 && calls[1]?.f?.z === 50, JSON.stringify(calls[1]?.f));
  check('dt comes from the clock (0 on the first frame)', calls[0]?.dt === 0 && Math.abs(calls[1]?.dt - 0.016) < 1e-9, `${calls[0]?.dt}, ${calls[1]?.dt}`);
  city.update(cam, 200);
  check('a long gap between frames counts as at most 0.25 s', calls[2]?.dt === 0.25, String(calls[2]?.dt));
  // the far cells stop casting in the same update that moved the focus away (chunks first, then the sort)
  const trim = cellMeshes(scene).filter((m) => m.cast).sort((a, b) => b.mesh.geometry.index.count - a.mesh.geometry.index.count)[0];
  const before = trim.parts.filter((p) => p.slot.castShadow).length;
  sun.target.position.set(10, 0, 10);
  cam.position.set(10, 3, 15); cam.updateMatrixWorld();
  city.update(cam, 200.1);
  const after = trim.parts.filter((p) => p.slot.castShadow).length;
  check('cells switched by chunks.update are sorted in the same frame', after < before && checkIndex(trim, 'facade'), `${before} -> ${after} casting cells`);
  chunks.update = real;
}
// (the spec's 180 m street far would hide the far side of this 344 m town from the marina, the jet and the
// title orbit; the grid must look as it did, so its manager draws the street life at any distance)
STREET_FAR = chunks.layers.street?.far;
check('the grid draws the street life at any distance', STREET_FAR === Infinity, String(STREET_FAR));
check('chunks.js keeps the spec\'s 180 m street far for everyone else (the grid sets its own manager\'s)', CH.LAYERS.street.far === 180, String(CH.LAYERS.street.far));
{
  // the street life comes in 64 m pieces, each a quarter of the cell the manager switches it with (finer
  // culling: whole cells would send more of the street to the low tier's 84 m shadow box than the old 60 m
  // chunks did); a terrace stays whole in the piece of its middle, so it may reach a little way out
  const Q = CELL / 2, pieces = streetPieces(scene);
  let bad = 0;
  for (const o of pieces) {
    const [px, pz] = o.userData.piece.split(',').map(Number), cb = CH.keyBox(o.userData.cell, CELL), x0 = px * Q, z0 = pz * Q;
    o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox;
    if (x0 < cb[0] || z0 < cb[1] || x0 + Q > cb[2] || z0 + Q > cb[3]) bad++;
    else if (b.min.x < x0 - 20 || b.min.z < z0 - 20 || b.max.x > x0 + Q + 20 || b.max.z > z0 + Q + 20) bad++;
  }
  check(`the street life is cut into 64 m pieces, each inside its cell (${pieces.length} pieces)`, pieces.length > 0 && bad === 0, `${bad} out of place`);
}
const st = chunks.stats();
note(`chunk manager: ${st.objects} entries (ground and building cell stand-ins, street cells, separate objects); no lazy cells, the grid is built in one go`);

// ---------- 2. same drawn content as the old city ----------

if (HAVE_BASE) {
  section('drawn content: old city.js vs the cells');
  compareContent('day', snapOld, snapNew);
  compareContent('night 0.6', nightOld, nightNew);
  const same3 = (a, b) => a.length === b.length && a.every((v, i) => v.x === b[i].x && v.y === b[i].y && v.z === b[i].z);
  check('lamp heads match', same3(OC.lampHeads, CITY.lampHeads), `${OC.lampHeads.length} vs ${CITY.lampHeads.length}`);
  check('fountains, yachts and hills match', OC.fountains.length === CITY.fountains.length && OC.yachts.length === CITY.yachts.length && OC.mountains.length === CITY.mountains.length);
  check('the building height grid matches', OC.heightGrid.every((v, i) => v === CG.heightGrid[i]));
} else note('no baseline (pass a baseline dir or set KC_BASELINE) - skipped the old/new comparisons');

// ---------- 3. cells at the bench views and on a drive ----------

section('cells at the bench views');
const camera = new THREE.PerspectiveCamera(62, 1440 / 800, 0.1, 4000);
const oldCamera = camera.clone();
let t = 300;
const rows = [];
for (const minutes of [13 * 60, 15.5 * 60]) {
  for (const v of W.benchViews) {
    const focus = D.placeCamera(camera, v, VIEW_OPTS);
    D.placeSun(sun, minutes, focus);
    for (let i = 0; i < 3; i++) city.update(camera, (t += 1 / 60));
    const label = `${v.name} ${minutes / 60}h`;
    checkCells(label, camera.position, focus);
    checkStreetInView(label);
    const main = D.cameraPass(scene, camera), shadow = D.shadowPass(scene, camera, sun);
    checkDraws(label, main, shadow, focus);
    checkCasters(label, focus);
    const row = { view: label, calls: main.calls + shadow.calls, main: main.calls, shadow: shadow.calls, shadowTris: shadow.tris, mainTris: main.tris };
    if (HAVE_BASE) {
      oldCamera.copy(camera);
      D.placeSun(oldSun, minutes, focus);
      for (let i = 0; i < 3; i++) oldCity.update(oldCamera, t);
      const om = D.cameraPass(oldScene, oldCamera), os = D.shadowPass(oldScene, oldCamera, oldSun);
      Object.assign(row, { oldCalls: om.calls + os.calls, oldShadowTris: os.tris, oldMainTris: om.tris });
      check(`${label}: city draw calls at or below the old city's`, row.calls <= row.oldCalls, `${row.calls} vs ${row.oldCalls}`);
      check(`${label}: shadow triangles at or below the old city's`, row.shadowTris <= row.oldShadowTris, `${row.shadowTris} vs ${row.oldShadowTris}`);
      // (the street life's 64 m pieces cull a little more coarsely than the old 60 m chunks; every merged mesh is
      // indexed now, so the GPU runs fewer vertices than the old non-indexed meshes did for the same triangles)
      check(`${label}: camera-pass triangles within 8% of the old city's`, row.mainTris <= row.oldMainTris * 1.08, `${row.mainTris} vs ${row.oldMainTris}`);
    }
    rows.push(row);
  }
}
for (const r of rows) note(`${r.view.padEnd(15)} calls ${r.calls} (camera ${r.main} + shadow ${r.shadow})${r.oldCalls != null ? `, old ${r.oldCalls}` : ''}; ` +
  `shadow tris ${r.shadowTris}${r.oldShadowTris != null ? ` (old ${r.oldShadowTris})` : ''}; camera tris ${r.mainTris}${r.oldMainTris != null ? ` (old ${r.oldMainTris})` : ''}`);

section('cells on a drive round the town, the title orbit and teleports');
{
  let sorts = 0, frames = 0, bad = 0, uploads = 0, driven = 0;
  const perMesh = new Map();
  const versions = new Map(cellMeshes(scene).map((m) => [m.mesh, m.mesh.geometry.index.version]));
  const step = (camPos, look, focus) => {
    camera.position.copy(camPos); camera.lookAt(look); camera.updateMatrixWorld(true);
    D.placeSun(sun, 13 * 60, focus);
    city.update(camera, (t += 1 / 60));
    frames++;
    if (!checkCells('drive', camera.position, focus, true)) bad++;
    if (!checkStreetInView('drive', true)) bad++;
    for (const m of cellMeshes(scene)) {
      const v = m.mesh.geometry.index.version;
      if (v === versions.get(m.mesh)) continue;
      // what the sort asked three.js to send (then sent, as a render would)
      const ix = m.mesh.geometry.index;
      versions.set(m.mesh, v); sorts++;
      uploads += ix.updateRanges.length ? ix.updateRanges.reduce((n, r) => n + r.count, 0) * ix.array.BYTES_PER_ELEMENT : ix.array.byteLength;
      ix.clearUpdateRanges();
      const k = `${m.layer}:${m.mesh.material.type}:${m.mesh.geometry.index.count}`; perMesh.set(k, (perMesh.get(k) || 0) + 1);
      if (!checkIndex(m, 'drive')) bad++;
    }
    if (frames % 97 === 0) {
      const sh = D.shadowPass(scene, camera, sun);
      if (!checkDraws('drive', D.cameraPass(scene, camera), sh, focus, true)) bad++;
    }
  };
  // a lap of the ring road at 15 m/s (the camera 6 m behind and above the car), then across the middle
  const lap = [[24, 24], [320, 24], [320, 320], [24, 320], [24, 24], [172, 172], [320, 24]];
  const p = new THREE.Vector3(), f = new THREE.Vector3(), look = new THREE.Vector3();
  for (let k = 0; k + 1 < lap.length; k++) {
    const [ax, az] = lap[k], [bx, bz] = lap[k + 1], len = Math.hypot(bx - ax, bz - az), n = Math.ceil(len / (15 / 60));
    for (let i = 0; i <= n; i++) {
      const u = i / n, x = ax + (bx - ax) * u, z = az + (bz - az) * u, dx = (bx - ax) / len, dz = (bz - az) / len;
      f.set(x, 0, z); p.set(x - dx * 6, 3, z - dz * 6); look.set(x + dx * 3, 1, z + dz * 3);
      step(p, look, f);
    }
    driven += len;
  }
  const driveMB = uploads / 1048576, driveFrames = frames;
  // the title orbit (main3d: 175 m round the middle at 72 m, 0.035 rad/s, looking at the middle; focus the
  // middle), a whole turn at 10 times its speed
  for (let i = 0, n = Math.ceil(2 * Math.PI / 0.35 * 60); i <= n; i++) {
    const a = i * 0.35 / 60;
    step(p.set(172 + Math.cos(a) * 175, 72, 172 + Math.sin(a) * 175), look.set(172, 4, 172), f.set(172, 0, 172));
  }
  // teleports between the bench views
  for (const v of [...W.benchViews, ...W.benchViews].reverse()) {
    const focus = D.placeCamera(camera, v, VIEW_OPTS);
    step(camera.position.clone(), focus.clone().setY(1.5), focus);
  }
  check('every frame of the drive kept the cell rules and the index runs', bad === 0, `${bad} bad frames; first: ${quietFails.join('; ')}`);
  note(`${frames} frames: ${sorts} index re-sorts, ${(uploads / 1048576).toFixed(1)} MB of index sent in all; ` +
    `the drive (${(driven / 1000).toFixed(2)} km in ${driveFrames} frames) ${(driveMB / driven * 1000).toFixed(1)} MB per km`);
  check('the index sent while driving stays small (under 40 MB per km)', driveMB / driven * 1000 < 40, `${(driveMB / driven * 1000).toFixed(1)} MB/km`);
  if (process.env.S3B_VERBOSE) for (const [k, n] of [...perMesh].sort((a, b) => b[1] - a[1])) note(`  ${k}: ${n}`);
  check('index re-sorts are rare (a few per cell crossing, not per frame)', sorts < frames * 0.25, `${sorts} in ${frames} frames`);
}

section('the title screen\'s shadows (the clock held at 18:51, the sun about 2 degrees up)');
{
  checkTitle('fresh', titleFresh);
  // a frame of play in the north-west corner switches off the cells round the middle; then back to the title
  const f = new THREE.Vector3(20, 0, 20);
  camera.position.set(14, 3, 14); camera.lookAt(f); camera.updateMatrixWorld(true);
  D.placeSun(sun, 13 * 60, f);
  city.update(camera, (t += 1 / 60));
  const off = new Set();
  for (const m of cellMeshes(scene)) for (const p of m.parts) if (p.slot.layer !== 'terrain' && !p.slot.castShadow) off.add(p.slot.key);
  check(`a frame of play at (20, 20) switches cells off (${[...off].join(' ')})`, off.size > 0);
  checkTitle('after a frame of play at (20, 20)', titleShadows((cam) => { for (let i = 0; i < 3; i++) city.update(cam, (t += 1 / 60)); }));
}

// ---------- 4. nearestLamps ----------

section('nearestLamps: 64 m buckets vs sorting every lamp');
{
  const heads = CITY.lampHeads, out = [];
  let same = 0, n = 0;
  const r = mulberry(5);
  for (let i = 0; i < 6000; i++) {
    const x = -80 + r() * (CITY.MAP + 160), z = -80 + r() * (CITY.MAP + 160);
    const k = [1, 3, 6, 6, 6, 20, heads.length + 5][i % 7];
    const best = heads.map((h, j) => [(h.x - x) ** 2 + (h.z - z) ** 2, j]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, k);
    CITY.nearestLamps(x, z, k, out);
    n++;
    if (out.length === best.length && out.every((h, j) => h === heads[best[j][1]])) same++;
  }
  check(`the same lamps in the same order (${same}/${n})`, same === n);
  const far = CITY.nearestLamps(5000, -3000, 6, []);
  check('a point far off the map still finds the 6 nearest', far.length === 6);
  check('n = 0 finds nothing', CITY.nearestLamps(100, 100, 0, [1]).length === 0);
  // tied distances keep lamp order: halfway between two lamps in a row the two are exactly as near, and
  // with n = 1 or 3 the cut falls between equals
  let ties = 0, tieSame = 0;
  for (let a = 0; a < heads.length; a++) for (let b = a + 1; b < heads.length; b++) {
    const A = heads[a], B = heads[b];
    if (A.z !== B.z || Math.abs(A.x - B.x) > 40) continue;
    const x = (A.x + B.x) / 2, z = A.z;
    if ((A.x - x) ** 2 !== (B.x - x) ** 2) continue;
    for (const k of [1, 3]) {
      const best = heads.map((h, j) => [(h.x - x) ** 2 + (h.z - z) ** 2, j]).sort((p, q) => p[0] - q[0] || p[1] - q[1]).slice(0, k);
      CITY.nearestLamps(x, z, k, out);
      ties++;
      if (out.length === k && out.every((h, j) => h === heads[best[j][1]])) tieSame++;
    }
  }
  check(`equally near lamps come in lamp order (${tieSame}/${ties} points halfway between two lamps)`, ties > 20 && tieSame === ties);
  const h0 = heads[0];
  check('the lamp right under the point comes first', CITY.nearestLamps(h0.x, h0.z, 2, [])[0] === h0);
  // finite points far off, even at the edge of what a number holds, still end with the n nearest
  for (const [x, z] of [[1e300, 100], [-1e300, -1e300], [Number.MAX_VALUE, -Number.MAX_VALUE], [100, 1e15]]) {
    const t0 = performance.now(), got = CITY.nearestLamps(x, z, 6, []);
    check(`nearestLamps(${x}, ${z}) finds 6 lamps at once`, got.length === 6 && performance.now() - t0 < 100, `${got.length} in ${(performance.now() - t0).toFixed(1)} ms`);
  }
  lampsNotANumber();
}

done();

// ======================================================================================================
// helpers

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A point that is not a number (a NaN or infinite camera from a physics or AI bug) must not hang the search:
// it once doubled its radius for ever and froze the tab. Asked in a child process with a time limit, so a
// hang fails this check instead of hanging the test; the child builds the city and asks for each bad point.
function lampsNotANumber() {
  const bad = ['NaN, 100', '100, NaN', 'Infinity, 100', '-Infinity, 100', '100, -Infinity', 'NaN, NaN', 'Infinity, -Infinity'];
  const code = `
    const { src, quiet } = await import(${JSON.stringify(src('tools/s3b_env.mjs'))});
    const THREE = await import('three');
    const W = await import(src('src/world.js')), CITY = await import(src('src/3d/city.js'));
    W.generate();
    await quiet(() => CITY.buildCity(new THREE.Scene()));
    const out = [];
    for (const [x, z] of [${bad.map((p) => `[${p}]`).join(', ')}]) {
      const t0 = performance.now(), got = CITY.nearestLamps(x, z, 6, [7]);
      out.push({ x: String(x), z: String(z), n: got.length, ms: performance.now() - t0 });
    }
    console.log('RESULT ' + JSON.stringify(out));
    process.exit(0);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 30000, env: { ...process.env, KC_BASELINE: '' } });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) {
    check('nearestLamps comes back for NaN and infinite points', false, r.error?.code === 'ETIMEDOUT' ? 'the child timed out (the search hung)' : `child failed: ${(r.stderr || '').slice(0, 300)}`);
    return;
  }
  for (const q of JSON.parse(line.slice(7))) {
    check(`nearestLamps(${q.x}, ${q.z}) comes back at once with no lamps`, q.n === 0 && q.ms < 50, `${q.n} lamps in ${q.ms.toFixed(1)} ms`);
  }
}

// Every street cell whose bounding sphere meets the camera's view is drawn (the grid draws them at any
// distance; three.js culls the rest). quiet: report only a pass/fail.
function checkStreetInView(label, quietly = false) {
  camera.updateMatrixWorld(true);
  _frustum.setFromProjectionMatrix(_pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  let missing = 0, tris = 0, nearest = Infinity;
  for (const o of streetPieces(scene)) {
    if (o.visible || !_frustum.intersectsObject(o)) continue;
    missing++; tris += o.geometry.index.count / 3;
    nearest = Math.min(nearest, cellDist(o.userData.cell, camera.position.x, camera.position.z));
  }
  const ok = missing === 0;
  if (!ok && quietly && quietFails.length < 3) quietFails.push(`${missing} street cells in view not drawn`);
  if (!quietly) check(`${label}: every street cell in the camera's view is drawn`, ok, `${missing} cells (${tris} triangles, the nearest ${nearest.toFixed(0)} m away) hidden`);
  return ok;
}

// The title screen (main3d): the clock held at 18.85 h, so the sun is about 2 degrees up; the shadow focus is
// the middle of the town and the camera orbits 175 m out at 72 m. So low a sun stretches the shadow box along
// the light right across the town, further than the cast radius. frame(cam, focus) runs the city's frames;
// then this counts what sits inside the box and what of it casts nothing: the triangles of the cut meshes
// (B, by their cell), the copies of the cut instanced meshes (C), the triangles of the street pieces (S) and
// of the separate objects made to cast (O). A triangle is inside when its centre is.
function titleShadows(frame) {
  const focus = new THREE.Vector3(CITY.MAP / 2, 0, CITY.MAP / 2);
  titleCam.position.set(focus.x + 175, 72, focus.z); titleCam.lookAt(focus.x, 4, focus.z); titleCam.updateMatrixWorld(true);
  D.placeSun(sun, 18.85 * 60, focus);
  frame(titleCam, focus);
  const box = sun.shadow.getFrustum();
  const r = { inB: 0, lostB: 0, inC: 0, lostC: 0, inS: 0, lostS: 0, inO: 0, lostO: 0, lostCells: new Set() };
  const count = (kind, lost, cell) => { r[`in${kind}`]++; if (lost) { r[`lost${kind}`]++; r.lostCells.add(`${kind} ${cell}`); } };
  const inside = (pos, M, a, b, c) => {
    _v.set(0, 0, 0);
    for (const j of [a, b, c]) _v.x += pos[j * 3] / 3, _v.y += pos[j * 3 + 1] / 3, _v.z += pos[j * 3 + 2] / 3;
    return box.containsPoint(_v.applyMatrix4(M));
  };
  const tris = (o, kind, lost, cell, idx = o.geometry.index?.array) => {
    const pos = o.geometry.attributes.position.array, n = idx ? idx.length : pos.length / 3;
    for (let i = 0; i + 2 < n; i += 3) {
      if (idx ? inside(pos, o.matrixWorld, idx[i], idx[i + 1], idx[i + 2]) : inside(pos, o.matrixWorld, i, i + 1, i + 2)) count(kind, lost, cell);
    }
  };
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (o.userData?.cells && !o.userData.cast) return;
    if (o.userData?.cells && !o.isInstancedMesh) {
      for (const p of o.userData.cells) tris(o, 'B', !p.slot.castShadow, p.slot.key, p.idx);
    } else if (o.userData?.cells) {
      // a copy's cell is where it stands (the sort moves copies about; a copy tucked away is all zeros)
      const slot = new Map(o.userData.cells.map((p) => [p.slot.key, p.slot])), M = o.instanceMatrix.array;
      for (let k = 0; k < o.count; k++) {
        if (M[k * 16] === 0 && M[k * 16 + 5] === 0 && M[k * 16 + 10] === 0) continue;
        const key = CH.cellKey(M[k * 16 + 12], M[k * 16 + 14]);
        _v.set(M[k * 16 + 12], M[k * 16 + 13], M[k * 16 + 14]).applyMatrix4(o.matrixWorld);
        if (box.containsPoint(_v)) count('C', !slot.get(key)?.castShadow, key);
      }
    } else if (o.isMesh && o.userData?.cell !== undefined) tris(o, 'S', !o.castShadow, o.userData.cell);
    else if (madeToCast.has(o)) tris(o, 'O', !o.castShadow, o.name || o.type);
  });
  return r;
}
function checkTitle(label, r) {
  check(`title, ${label}: every building, tree, lamp and separate object inside the shadow box casts ` +
    `(${r.inB} triangles, ${r.inC} copies, ${r.inO} object triangles)`, r.inB > 0 && r.lostB + r.lostC + r.lostO === 0,
  `${r.lostB} triangles, ${r.lostC} copies and ${r.lostO} object triangles cast nothing: ${[...r.lostCells].join(', ')}`);
  // what may go: street life in cells outside the town's square, past the cast radius (the beach props on the
  // west sand, 172 m from the middle), a sliver of the street life in the box
  const out = [...r.lostCells].filter((k) => k.startsWith('S ')).map((k) => k.slice(2));
  note(`title, ${label}: in the box ${r.inB} cut-mesh triangles (${r.lostB} cast nothing), ${r.inC} copies (${r.lostC}), ` +
    `${r.inO} object triangles (${r.lostO}), ${r.inS} street triangles (${r.lostS}${out.length ? `, cells ${out.join(' ')}` : ''})`);
  const outside = out.every((key) => { const b = CH.keyBox(key, CELL); return b[2] <= 0 || b[3] <= 0 || b[0] >= CITY.MAP || b[1] >= CITY.MAP; });
  check(`title, ${label}: the only street life in the box that casts nothing is outside the town, under 2% ` +
    `(${r.lostS} of ${r.inS} triangles${out.length ? `, cells ${out.join(' ')}` : ''})`, r.inS > 0 && outside && r.lostS <= r.inS * 0.02);
}

// a mesh handed to the chunk manager whole (not cut into cells, not a street piece)
function isSeparate(o) {
  return o.isMesh && !o.isInstancedMesh && !o.userData.cells && o.userData.cell === undefined;
}

// the street life's per-cell meshes (cityGrid keeps the cell key on userData.cell)
function streetPieces(root) {
  const out = [];
  root.traverse((o) => { if (o.isMesh && o.userData?.cell !== undefined) out.push(o); });
  return out;
}

// every cell-cut merged mesh in the scene, with its cells (cityGrid keeps them on userData.cells)
function cellMeshes(root) {
  const out = [];
  root.traverse((o) => { if (o.userData?.cells && !o.isInstancedMesh) out.push({ mesh: o, parts: o.userData.cells, layer: o.userData.cells[0]?.slot.layer, cast: !!o.userData.cast }); });
  return out;
}
function cellInstanced(root) {
  const out = [];
  root.traverse((o) => { if (o.userData?.cells && o.isInstancedMesh) out.push(o); });
  return out;
}

// distance (m, on the ground) from a point to a cell's box
function cellDist(key, x, z) {
  const b = CH.keyBox(key, CELL);
  const dx = x < b[0] ? b[0] - x : x > b[2] ? x - b[2] : 0, dz = z < b[1] ? b[1] - z : z > b[3] ? z - b[3] : 0;
  return Math.hypot(dx, dz);
}

// Every cell stand-in is drawn and casts as the chunk rules say (with their hysteresis, both states are
// allowed in the band). quiet: report only a pass/fail for the whole frame.
function checkCells(label, cam, focus, quietly = false) {
  let ok = true;
  const seen = new Set();
  const fail = (m) => { ok = false; if (!quietly) check(`${label}: ${m}`, false); else if (quietFails.length < 3) quietFails.push(m); };
  for (const m of [...cellMeshes(scene), ...cellInstanced(scene).map((o) => ({ parts: o.userData.cells }))]) for (const p of m.parts) {
    const s = p.slot;
    if (seen.has(s)) continue;
    seen.add(s);
    const d = cellDist(s.key, cam.x, cam.z), df = cellDist(s.key, focus.x, focus.z);
    const far = s.layer === 'street' ? STREET_FAR : Infinity;
    if (d < far - LAG && !s.visible) fail(`${s.layer} cell ${s.key} is ${d.toFixed(1)} m from the camera but not drawn`);
    if (d > far + HYST + LAG && s.visible) fail(`${s.layer} cell ${s.key} is ${d.toFixed(1)} m from the camera but drawn`);
    if (s.layer === 'terrain') { if (s.castShadow) fail(`ground cell ${s.key} casts`); continue; }
    if (df <= CAST_R - LAG && !s.castShadow) fail(`${s.layer} cell ${s.key} is ${df.toFixed(1)} m from the focus but does not cast`);
    if (df > CAST_R + CAST_H + LAG && s.castShadow) fail(`${s.layer} cell ${s.key} is ${df.toFixed(1)} m from the focus but casts`);
  }
  for (const o of streetPieces(scene)) {
    const d = cellDist(o.userData.cell, cam.x, cam.z), df = cellDist(o.userData.cell, focus.x, focus.z);
    if (d < STREET_FAR - LAG && !o.visible) fail(`street cell ${o.userData.cell} is ${d.toFixed(1)} m from the camera but not drawn`);
    if (d > STREET_FAR + HYST + LAG && o.visible) fail(`street cell ${o.userData.cell} is ${d.toFixed(1)} m from the camera but drawn`);
    if (df <= CAST_R - LAG && !o.castShadow) fail(`street cell ${o.userData.cell} is ${df.toFixed(1)} m from the focus but does not cast`);
    if (df > CAST_R + CAST_H + LAG && o.castShadow) fail(`street cell ${o.userData.cell} is ${df.toFixed(1)} m from the focus but casts`);
  }
  if (!quietly) check(`${label}: every cell drawn and casting by the chunk rules (${seen.size} cells, ${streetPieces(scene).length} street cells)`, ok);
  return ok;
}

// A merged mesh's index holds its triangles grouped by cell, each cell's run whole and where the mesh says it
// is (part.at): drawn-only cells, then drawn and casting, then casting-only, then the rest. The draw range is
// the drawn run and the shadow run the casting run.
function checkIndex(m, label) {
  const { mesh, parts, cast } = m, idx = mesh.geometry.index.array, geo = mesh.geometry;
  const drawn = (p) => p.slot.visible, casts = (p) => cast && p.slot.castShadow;
  const group = (p) => (drawn(p) ? (casts(p) ? 1 : 0) : (casts(p) ? 2 : 3));
  let k = 0, same = true, g = 0;
  for (const p of parts.slice().sort((a, b) => a.at - b.at)) {
    if (p.at !== k || group(p) < g) same = false;
    g = group(p);
    for (let i = 0; i < p.idx.length && same; i++) if (idx[k + i] !== p.idx[i]) same = false;
    k += p.idx.length;
  }
  const sum = (f) => parts.filter(f).reduce((n, p) => n + p.idx.length, 0);
  const nDrawn = sum(drawn), nCast = sum(casts), s0 = sum((p) => drawn(p) && !casts(p));
  let ok = same && k === idx.length && geo.drawRange.start === 0 && geo.drawRange.count === nDrawn;
  if (cast) {
    mesh.onBeforeShadow();
    ok = ok && geo.drawRange.start === s0 && geo.drawRange.count === nCast;
    mesh.onAfterShadow();
    ok = ok && geo.drawRange.start === 0 && geo.drawRange.count === nDrawn && mesh.castShadow === nCast > 0;
  }
  ok = ok && mesh.visible === (nDrawn > 0 || nCast > 0);
  if (!ok && label !== 'drive') check(`${label}: ${m.layer} mesh index grouped by cell`, false);
  return ok;
}

// What the two passes drew from the city. The shadow pass: a merged mesh drew exactly its casting run, an
// instanced mesh only copies in casting cells (or, for the palms and the scatter, within 60 m), a separate
// object only when its box is within 110 m (+10). The camera pass: street cells only within STREET_FAR (+20).
function checkDraws(label, main, shadow, focus, quietly = false) {
  let ok = true;
  const fail = (m) => { ok = false; if (!quietly) check(`${label}: ${m}`, false); else if (quietFails.length < 3) quietFails.push(m); };
  const meshes = new Map(cellMeshes(scene).map((m) => [m.mesh, m]));
  for (const m of meshes.values()) if (!checkIndex(m, label)) fail(`${m.layer} mesh index`);
  let far = 0, casters = 0;
  for (const d of shadow.draws) {
    casters++;
    const o = d.obj, m = meshes.get(o);
    if (m) {
      // the run drawn holds only casting cells (checkIndex proved the run is exactly those)
      for (const p of m.parts) if (m.cast && p.slot.castShadow && cellDist(p.slot.key, focus.x, focus.z) > CAST_R + CAST_H + LAG) far++;
    } else if (o.userData.cell !== undefined) {
      if (cellDist(o.userData.cell, focus.x, focus.z) > CAST_R + CAST_H + LAG) far++;
    } else if (o.isInstancedMesh) {
      const M = o.instanceMatrix.array;
      // the copies the pass drew: the first d.instances (castFirst sets count for the shadow pass)
      o.onBeforeShadow?.(); const n = o.count; o.onAfterShadow?.();
      // (palms3d and scatter3d, stage S3a: copies within 60 m of the focus, and the palms near the camera)
      const lim = o.userData.cells ? null : 61 + Math.hypot(camera.position.x - focus.x, camera.position.z - focus.z);
      for (let i = 0; i < n; i++) {
        const x = M[i * 16 + 12], z = M[i * 16 + 14];
        if (M[i * 16] === 0 && M[i * 16 + 5] === 0 && M[i * 16 + 10] === 0) continue;   // a hidden copy
        if (lim ? Math.hypot(x - focus.x, z - focus.z) > lim : cellDist(CH.cellKey(x, z), focus.x, focus.z) > CAST_R + CAST_H + LAG) far++;
      }
    } else {
      // a separate object: its top-level parent in the city group was handed to the chunk manager whole
      let top = o;
      while (top.parent && top.parent !== city.group) top = top.parent;
      top.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(top);
      const dx = Math.max(b.min.x - focus.x, 0, focus.x - b.max.x), dz = Math.max(b.min.z - focus.z, 0, focus.z - b.max.z);
      if (Math.hypot(dx, dz) > CAST_R + CAST_H + LAG) far++;
    }
  }
  if (far) fail(`${far} shadow casters from further than ${CAST_R + CAST_H} m`);
  // street life in the camera pass
  for (const d of main.draws) {
    const key = d.obj.userData.cell;
    if (key !== undefined && cellDist(key, camera.position.x, camera.position.z) > STREET_FAR + HYST + LAG) fail(`street cell ${key} drawn from too far`);
  }
  if (!quietly) check(`${label}: the shadow pass holds only casters within ${CAST_R} m (${casters} draws)`, ok);
  return ok;
}

// Whatever the shadow frustum happens to cull: every city mesh still set to cast is near the focus. A cut mesh
// casts only when one of its cells does (checkIndex), a street cell within its rule (checkCells); a separate
// object (the jet, a yacht, a fountain, the pier) only while its box is within range, which is what handing it
// to the chunk manager does. The palms and the scatter (castFirst, stage S3a) are left to their own tests.
function checkCasters(label, focus) {
  let far = 0;
  const seen = new Set();
  city.group.traverse((o) => {
    if (!isSeparate(o) || !o.castShadow) return;
    let top = o;
    while (top.parent && top.parent !== city.group) top = top.parent;
    if (seen.has(top)) return;
    seen.add(top);
    top.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(top);
    const dx = Math.max(b.min.x - focus.x, 0, focus.x - b.max.x), dz = Math.max(b.min.z - focus.z, 0, focus.z - b.max.z);
    if (Math.hypot(dx, dz) > CAST_R + CAST_H + LAG) far++;
  });
  check(`${label}: no separate object casts from further than ${CAST_R + CAST_H} m (${seen.size} casting)`, far === 0, `${far} too far`);
}

// ---------- drawn content, as a multiset per material and flags ----------

function texSig(tx) {
  if (!tx) return null;
  const img = tx.image;
  return [img?.isStubCanvas ? canvasSig(img) : img ? 'image' : null, tx.wrapS, tx.wrapT, tx.repeat.x, tx.repeat.y, tx.offset.x, tx.offset.y, tx.colorSpace, tx.anisotropy, tx.flipY, tx.magFilter, tx.minFilter].join('|');
}
function matSig(m) {
  if (Array.isArray(m)) return m.map(matSig).join(' / ');
  const o = MAT_KEYS.map((k) => (typeof m[k] === 'number' ? Math.round(m[k] * 1e6) / 1e6 : m[k]));
  o.push(m.color?.getHexString(), m.emissive?.getHexString());
  for (const k of ['map', 'emissiveMap', 'roughnessMap', 'normalMap', 'alphaMap']) o.push(texSig(m[k]));
  o.push(m.onBeforeCompile ? fnv(m.onBeforeCompile.toString()) : null);
  return JSON.stringify(o);
}
function geoSig(g) {
  const parts = Object.keys(g.attributes).sort().map((k) => {
    const a = g.attributes[k];
    let h = 0x811c9dc5;
    for (let i = 0; i < a.array.length; i++) { h ^= Math.round(a.array[i] * 1e4) | 0; h = Math.imul(h, 0x01000193); }
    return `${k}:${a.count}:${(h >>> 0).toString(16)}`;
  });
  return parts.join(',');
}

// Everything a root draws with all of it in view: per (material, cast/receive, render order) a count of each
// triangle (its three corners in world space) or instanced copy. (Taken before any chunk update, so a cut
// mesh's draw range is its whole index.)
function content(root) {
  root.updateMatrixWorld(true);
  const groups = new Map();
  const add = (key, item) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = new Map()));
    g.set(item, (g.get(item) || 0) + 1);
  };
  root.traverse((o) => {
    if (!o.isMesh) return;
    let vis = true;
    for (let q = o; q; q = q.parent) if (q.visible === false) vis = false;
    if (!vis) return;
    const key = [o.isInstancedMesh ? 'inst' : 'mesh', matSig(o.material), o.castShadow, o.receiveShadow, o.renderOrder].join('|');
    const g = o.geometry, P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv, C = g.attributes.color;
    if (o.isInstancedMesh) {
      const gs = geoSig(g);
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, _m4);
        const c = o.instanceColor ? [o.instanceColor.getX(i), o.instanceColor.getY(i), o.instanceColor.getZ(i)].map(r4) : null;
        add(key, `${gs}|${_m4.elements.map(r4).join(',')}|${c}`);
      }
      return;
    }
    _nm.getNormalMatrix(o.matrixWorld);
    const idx = g.index?.array;
    const n = idx ? Math.min(idx.length, g.drawRange.start + g.drawRange.count) : Math.min(P.count, g.drawRange.start + g.drawRange.count);
    const corner = (j) => {
      _v.fromBufferAttribute(P, j).applyMatrix4(o.matrixWorld);
      const s = [_v.x, _v.y, _v.z].map(r4);
      if (N) { _n.fromBufferAttribute(N, j).applyMatrix3(_nm).normalize(); s.push(r4(_n.x), r4(_n.y), r4(_n.z)); }
      if (U) s.push(r4(U.getX(j)), r4(U.getY(j)));
      if (C && o.material.vertexColors) s.push(r4(C.getX(j)), r4(C.getY(j)), r4(C.getZ(j)));
      return s.join(',');
    };
    for (let k = g.drawRange.start; k + 2 < n; k += 3) {
      const a = idx ? idx[k] : k, b = idx ? idx[k + 1] : k + 1, c = idx ? idx[k + 2] : k + 2;
      add(key, `${corner(a)};${corner(b)};${corner(c)}`);
    }
  });
  return groups;
}
function compareContent(label, a, b) {
  const keys = new Set([...a.keys(), ...b.keys()]);
  let missing = 0, extra = 0, groupsDiff = 0, items = 0;
  for (const k of keys) {
    const ga = a.get(k) || new Map(), gb = b.get(k) || new Map();
    let diff = 0;
    for (const [item, n] of ga) { items += n; const m = gb.get(item) || 0; if (m < n) { missing += n - m; diff++; } }
    for (const [item, n] of gb) { const m = ga.get(item) || 0; if (m < n) { extra += n - m; diff++; } }
    if (diff) {
      groupsDiff++;
      if (groupsDiff <= 3) note(`${label}: group differs (${ga.size} old items, ${gb.size} new): ${k.slice(0, 160)}`);
    }
  }
  check(`${label}: the same triangles and copies per material (${items} old; ${missing} missing, ${extra} extra, ${groupsDiff} groups differ)`, !missing && !extra);
}
