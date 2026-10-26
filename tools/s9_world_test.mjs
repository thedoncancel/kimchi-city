#!/usr/bin/env node
// Stage S9 check (docs/map-v2-stages.json S9): the default flip, the retired 2D game, and the draw-call work in
// S9's renderer files, in node.
//   node tools/s9_world_test.mjs            (S3B_LOW=1 for the phone tier)
//  1. src/world.js picks Kimchi Key with nothing set, the grid with ?map=1, KC_WORLD or the KC_WORLD environment
//     variable (in child processes, one per case), and Kimchi Key again with ?map=2.
//  2. The 2D game is gone: no 2d.html, no src/main.js, nothing that loads either; index.html links the classic
//     map (?map=1) instead, runner.html is still there, and .vercelignore is reported if it still lists 2d.html.
//  3. terrain3d: the 8 m grids drawn as blocks of 2 x 2 tiles, one mesh each; on a drive round the county with
//     teleports, every block draws exactly the 8 m grids of its tiles that show them (its index is theirs, back to
//     back), every tile shows exactly one grid, and a block with none to draw is hidden.
//  4. sky.js: the clouds are 8 meshes (one per sector of the sky) holding every blob, not one mesh a blob; by
//     day on v2 they are brighter than white (so they stand out against the sky after the tone curve), and on the
//     high tier the clear-day sky keeps its blue low down, the dome below the horizon is the haze, and the day
//     haze is the deeper blue.
// Exits 1 if any check fails.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { src, check, section, note, done, ROOT } from './s3b_env.mjs';

// ---------- 1. the default map ----------

section('the world facade picks Kimchi Key by default');
const facade = (env, pre = '') => {
  const code = `${pre}const W = await import(${JSON.stringify(src('src/world.js'))}); console.log(W.KIND);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env: { ...process.env, KC_WORLD: '', ...env }, encoding: 'utf8' });
  return (r.stdout || '').trim().split('\n').pop() || r.stderr.trim().split('\n').pop();
};
check('nothing set: Kimchi Key', facade({}) === 'v2', facade({}));
check('KC_WORLD=grid in the environment: the grid', facade({ KC_WORLD: 'grid' }) === 'grid');
check('globalThis.KC_WORLD = "1": the grid', facade({}, 'globalThis.KC_WORLD = "1";') === 'grid');
check('?map=1: the grid', facade({}, 'globalThis.location = { search: "?map=1" };') === 'grid');
check('?map=classic: the grid', facade({}, 'globalThis.location = { search: "?map=classic" };') === 'grid');
check('?map=2 over KC_WORLD=grid in the environment: Kimchi Key (the page wins)', facade({ KC_WORLD: 'grid' }, 'globalThis.location = { search: "?map=2" };') === 'v2');
check('localStorage kc-map=grid: the grid', facade({}, 'globalThis.localStorage = { getItem: (k) => (k === "kc-map" ? "grid" : null) };') === 'grid');
const worldSrc = readFileSync(path.join(ROOT, 'src/world.js'), 'utf8');
check("world.js's DEFAULT is 'v2'", /const DEFAULT = 'v2';/.test(worldSrc));

// ---------- 2. the 2D game retired ----------

section('the 2D game is retired');
check('2d.html is gone', !existsSync(path.join(ROOT, '2d.html')));
check('src/main.js is gone', !existsSync(path.join(ROOT, 'src/main.js')));
check('runner.html is kept', existsSync(path.join(ROOT, 'runner.html')));
const index = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
check('index.html no longer links 2d.html', !/2d\.html/.test(index));
check("index.html links the classic map (?map=1)", /href="\?map=1"[^>]*>classic map</.test(index));
check("on the grid the title links back with ?map=2 (which beats a saved kc-map), going by the facade's own KIND",
  /import \{ KIND \} from '\.\/src\/world\.js'/.test(index) && /KIND === 'grid'\) \{ a\.href = '\?map=2'/.test(index));
const files = [];
const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|html)$/.test(p)) files.push(p); } };
walk(path.join(ROOT, 'src'));
files.push(path.join(ROOT, 'index.html'), path.join(ROOT, 'runner.html'));
const users = files.filter((f) => /['"(/]main\.js['"]|2d\.html/.test(readFileSync(f, 'utf8').replace(/main3d\.js/g, '')));
check('nothing in src/ or the pages loads src/main.js or 2d.html', users.length === 0, users.map((f) => path.relative(ROOT, f)).join(', '));
const vi = existsSync(path.join(ROOT, '.vercelignore')) ? readFileSync(path.join(ROOT, '.vercelignore'), 'utf8') : '';
if (/2d\.html/.test(vi)) note('.vercelignore still lists !/2d.html (harmless: the file is gone; the lead may drop the line)');

// ---------- 3. terrain3d's merged 8 m grids ----------

section('terrain3d: the 8 m grids in blocks');
globalThis.KC_WORLD = 'v2';
const THREE = await import('three');
const W = await import(src('src/world.js'));
W.generate();
const T3 = await import(src('src/3d/terrain3d.js'));
const added = [];
const chunks = { add(obj, o) { added.push({ obj, o }); return {}; } };
const T = T3.buildTerrain3D(W, chunks, {});
const blocks = added.filter((a) => a.obj.name?.startsWith('lod1 block')).map((a) => a.obj);
const tileGroups = added.filter((a) => a.obj.name?.startsWith('terrain '));
check('every tile still has its group (for its 2 m grid)', tileGroups.length === T.tiles.length, `${tileGroups.length} of ${T.tiles.length}`);
check('no 8 m grid sits in a tile group any more', T.tiles.every((t) => t.group.children.every((c) => !c.name.startsWith('lod1'))));
const keys = new Set(T.tiles.map((t) => `${Math.floor(t.tx / 2)},${Math.floor(t.tz / 2)}`));
check('one 8 m mesh per 2 x 2 tile block', blocks.length === keys.size, `${blocks.length} meshes, ${keys.size} blocks`);
check('the blocks share the 8 m material and receive shadows', blocks.every((b) => b.material === T.materials.lod1 && b.receiveShadow));
note(`${T.tiles.length} tiles drawn as ${blocks.length} 8 m meshes (was ${T.tiles.length})`);

// what a block should draw: its tiles' 8 m indices whose grid shows, in tile order
function blockErrors() {
  let bad = 0;
  for (const b of blocks) {
    const mine = T.tiles.filter((t) => t.far?.mesh === b);
    const want = [];
    for (const t of mine) if (t.lod1.visible) {
      const base = mine.slice(0, mine.indexOf(t)).reduce((n, u) => n + u.lod1.geometry.attributes.position.count, 0);
      for (const i of t.lod1.geometry.index.array) want.push(i + base);
    }
    const g = b.geometry, got = g.index.array.subarray(g.drawRange.start, g.drawRange.start + Math.min(g.drawRange.count, g.index.count));
    if (got.length !== want.length || want.some((v, k) => v !== got[k]) || b.visible !== want.length > 0) bad++;
  }
  return bad;
}
{
  // the positions in a block are its tiles' own, so the merged mesh draws the very same triangles
  let same = true;
  for (const b of blocks) {
    const mine = T.tiles.filter((t) => t.far?.mesh === b), P = b.geometry.attributes.position.array;
    let o = 0;
    for (const t of mine) { const q = t.lod1.geometry.attributes.position.array; for (let k = 0; k < q.length; k++) if (q[k] !== P[o + k]) { same = false; break; } o += q.length; }
  }
  check("a block's vertices are its tiles' 8 m grids, unchanged", same);
}
{
  const cam = new THREE.PerspectiveCamera(62, 1.8, 0.15, 2600);
  const pts = W.routes.bay_loop?.pts, P = [];
  if (pts) for (let i = 0; i + 1 < pts.length; i += 2) P.push([pts[i] / 16, pts[i + 1] / 16]);
  let frames = 0, wrong = 0, both = 0, none = 0, switches = 0, rewriteMs = 0, lastVis = '';
  const step = (x, z) => {
    cam.position.set(x, 30, z);
    const t0 = performance.now();
    T.update(cam, 1 / 60);
    rewriteMs = Math.max(rewriteMs, performance.now() - t0);
    frames++;
    for (const t of T.tiles) { const f = !!t.lod0?.visible, c = t.lod1.visible; if (f && c) both++; if (!f && !c) none++; }
    const vis = T.tiles.map((t) => (t.lod1.visible ? 1 : 0)).join('');
    if (vis !== lastVis) { switches++; lastVis = vis; if (blockErrors()) wrong++; }
  };
  for (let k = 0; k < P.length; k += 3) {
    if (k === Math.floor(P.length / 3)) step(1700, 1500);      // a teleport to the lighthouse key and back
    step(P[k][0], P[k][1]);
  }
  check('on the drive every block draws exactly the 8 m grids its tiles show', wrong === 0 && blockErrors() === 0, `${wrong} of ${switches} changes wrong`);
  check('every tile shows exactly one grid every frame', both === 0 && none === 0, `${both} with both, ${none} with neither`);
  note(`${frames} frames, ${switches} changes of which tiles show the 8 m grid; slowest update ${rewriteMs.toFixed(1)} ms (2 m grid builds included)`);
}

// ---------- 4. the clouds ----------

section('sky.js: the clouds in 8 meshes');
const SKY = await import(src('src/3d/sky.js'));
const scene = new THREE.Scene();
const sky = SKY.makeSky(scene);
const clouds = [];
scene.traverse((o) => { if (o.isMesh && o.material?.vertexColors && o.parent?.renderOrder === -8) clouds.push(o); });
check('the clouds are 8 meshes', clouds.length === 8, String(clouds.length));
const tris = clouds.reduce((n, m) => n + m.geometry.attributes.position.count / 3, 0), per = new THREE.IcosahedronGeometry(1, 2).attributes.position.count / 3;
check(`they hold every blob (16 clusters of 6 to 10, ${per} triangles each)`, tris >= 16 * 6 * per && tris <= 16 * 10 * per && tris % per === 0, `${tris} triangles, ${tris / per} blobs`);
check('each has bounds, so the ones out of view are not drawn', clouds.every((m) => m.frustumCulled && m.geometry.boundingSphere?.radius > 0));
const cam = new THREE.PerspectiveCamera(62, 1.8, 0.15, 2600);
sky.update(13 * 60, new THREE.Vector3(500, 0, 500), cam, null);
check('the sky still updates with them', sky.state.day > 0.9);
const cloudCol = clouds[0].material.color;
check('by day on v2 the clouds are brighter than white (and a touch warm)', cloudCol.r > 1.2 && cloudCol.r > cloudCol.b, cloudCol.toArray().map((v) => v.toFixed(2)).join(','));
if (process.env.S3B_LOW !== '1') {
  let dome = null;
  scene.traverse((o) => { if (o.renderOrder === -10 && o.material?.uniforms?.clear) dome = o; });
  const u = dome?.material.uniforms, fs = dome?.material.fragmentShader || '';
  check('the high tier sky has the clear-day and below-horizon terms', !!dome && /uniform float moonVis, dayMix, clear, under/.test(fs) && /smoothstep\(-0\.05, 0\.0, hy\)\) \* under/.test(fs));
  check('at 13:00 it is a clear day and the dome under the horizon is the haze', u.clear.value > 0.95 && u.under.value === 1, `clear ${u?.clear.value.toFixed(2)}`);
  check('the day haze is the deeper blue', scene.fog.color.getHexString() === '9cc6e8', scene.fog.color.getHexString());
  sky.update(18.3 * 60, new THREE.Vector3(500, 0, 500), cam, null);
  check('at golden hour the low sky goes back to the warm physical one (clear eases off)', u.clear.value < 0.6, u.clear.value.toFixed(2));
  sky.update(21 * 60, new THREE.Vector3(500, 0, 500), cam, null);
  check('at night the sky is the night gradient, the haze its horizon colour', u.dayMix.value < 0.01 && u.clear.value < 0.01 && u.hazeColor.value.clone().sub(u.nHorizon.value).toArray().every((v) => Math.abs(v) < 1e-6), `dayMix ${u.dayMix.value.toFixed(3)} clear ${u.clear.value.toFixed(3)}`);
}

done();
