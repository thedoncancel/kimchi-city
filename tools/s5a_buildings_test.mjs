#!/usr/bin/env node
// Stage S5a check (docs/map-v2-stages.json, spec §6.4 and §11.1 Buildings): the v2 buildings, built in node.
//   node tools/s5a_buildings_test.mjs            (S3B_LOW=1 for the phone tier)
//  1. The contract: registerBuildings(world, chunks) (2 arguments, an optional third), nothing without chunks.
//  2. Shells: one mesh per 256 m tile that has buildings, always drawn, one material for the whole county;
//     about 30 triangles a building.
//  3. Facades: every wall holds a whole number of 3 m bays (2.4-3.6 m each, starting on a bay of the atlas) and
//     one atlas row per storey from a row boundary at the floor, on rotated buildings as on square ones; the
//     walls run on below the floor into the ground.
//  4. Heights: what a building's shell shows stays within its height (OCC and the sightlines hold), except a
//     house's or hangar's roof; Kimchi Tower is a 140 m shell on the tower facade.
//  5. Ocean Drive's hotels face east, to the beach.
//  6. Detail cells: one lazy cell per 128 m cell with buildings, each built into one mesh; every painted sign a
//     building asks for is on the sheet.
//  7. A 50 m/s lap of the Loop: no building within 150 m without its detail (after the first second), build
//     slices within 3 ms (90% of them on node's clock, which a busy machine stretches), and the cache within
//     its 36 cells (or all in use).
//  8. The bench views: what the buildings draw (camera + sun shadow) within the stage's share.
//  9. The material: the layer stacks, and the shader edits all land in three r169's MeshStandard (and Lambert)
//     shaders.
// Exits 1 if any check fails.
import { src, check, section, note, done } from './s3b_env.mjs';
globalThis.KC_WORLD = 'v2';
const THREE = await import('three');
const D = await import('./s3b_draws.mjs');
const W = await import(src('src/world.js'));
W.generate();
const { makeChunkManager } = await import(src('src/3d/chunks.js'));
const B3 = await import(src('src/3d/buildings3d.js'));
const { ROADS } = await import(src('src/map/mapdata.js'));
const { sampleCurve } = await import(src('src/map/spline.js'));
const LOW_TIER = process.env.S3B_LOW === '1';
const S = 1 / 16, LAY = B3.LAYERS;

// ---------- 1. the contract ----------

section('contract (spec §7)');
check('registerBuildings is exported', typeof B3.registerBuildings === 'function');
check('registerBuildings takes 2 arguments (mats is optional)', B3.registerBuildings.length === 2, String(B3.registerBuildings.length));
check('nothing is built without a chunk manager', B3.registerBuildings(W, null) === undefined);

// ---------- 2. shells ----------

section('shells: one mesh per tile, always resident');
const scene = new THREE.Scene(), group = new THREE.Group();
scene.add(group);
const sun = D.makeSun(LOW_TIER ? 42 : 64);
scene.add(sun, sun.target);
const MAX_CELLS = 36;
const chunks = makeChunkManager(group, { castR: 110, maxCells: MAX_CELLS });
const t0 = performance.now();
B3.registerBuildings(W, chunks);
const regMs = performance.now() - t0;
const st0 = B3.buildingStats();
note(`registerBuildings ${regMs.toFixed(0)} ms (node): ${st0.buildings} buildings, ${st0.tiles} shell tiles, ${st0.shellTris} shell triangles, ${st0.cells} detail cells`);
const tiles = new Set(W.buildings.map((b) => b.tile));
const shells = group.children.filter((o) => o.name.startsWith('building shells '));
check('a shell mesh for every tile with buildings', shells.length === tiles.size && st0.tiles === tiles.size, `${shells.length} of ${tiles.size}`);
check('every shell is a single mesh with the one building material', shells.every((m) => m.isMesh && m.material === shells[0].material));
check('the shells cast and receive shadows', shells.every((m) => m.castShadow && m.receiveShadow));
{
  // about 30 a building; the resorts' balcony bands are in their shells too (they are what reads across the bay)
  let tris = 0, n = 0;
  for (const b of W.buildings) if (b.style !== 'resort') { tris += B3.buildingPass(b, 'shell').index.length / 3; n++; }
  check(`about 30 triangles a building (${(tris / n).toFixed(1)} bar the resorts)`, tris / n <= 36);
  check(`all the shells together are small (${(st0.shellTris / 1e3).toFixed(1)} k triangles)`, st0.shellTris <= 30e3);
}
{
  const cam = new THREE.PerspectiveCamera(62, 1440 / 800, 0.15, 2600);
  cam.position.set(-3000, 400, -3000); cam.lookAt(1024, 0, 896); cam.updateMatrixWorld();
  for (let k = 0; k < 3; k++) chunks.update(cam, { x: -3000, z: -3000 }, 0.1);
  check('shells stay drawn from 4 km away', shells.every((m) => m.visible));
  check('regBuildings is quick (under 400 ms in node)', regMs < 400, regMs.toFixed(0));
}

// ---------- 3. facades ----------

section('facades: whole bays, one row a storey, on any heading');
const FACADE_LAYERS = new Set([LAY.deco, LAY.ktown, LAY.tower, LAY.resort, LAY.house, LAY.warehouse]);
const STOREY = { deco: 3.3, ktown: 3.2, tower: 3.4, resort: 3.2, house: 3.0, mansion: 3.2, warehouse: 3.2, hangar: 3.2 };
let walls = 0, rotated = 0, badBay = [], badRow = [], badSink = 0;
const isInt = (x, tol = 2e-3) => Math.abs(x - Math.round(x)) < tol;
for (const b of W.buildings) {
  const p = B3.buildingPass(b, 'shell'), turned = Math.abs(Math.sin(2 * b.a)) > 0.05;
  let lowest = Infinity;
  for (let v = 0; v + 3 < p.n; v += 4) {
    const L = p.layer[v];
    if (!FACADE_LAYERS.has(L) || p.layer[v + 3] !== L) continue;
    const P = (i) => [p.pos[(v + i) * 3], p.pos[(v + i) * 3 + 1], p.pos[(v + i) * 3 + 2]], U = (i) => [p.uv[(v + i) * 2], p.uv[(v + i) * 2 + 1]];
    const [a, bb, c] = [P(0), P(1), P(2)], [ua, va] = U(0), [ub] = U(1), [, vc] = U(2);
    const len = Math.hypot(bb[0] - a[0], bb[2] - a[2]), h = c[1] - bb[1];
    lowest = Math.min(lowest, a[1]);
    if (Math.abs(vc - va) < 1e-6) continue;          // the plain strip under the floor
    walls++;
    if (turned) rotated++;
    const bays = (ub - ua) * 8, width = len / Math.round(bays);
    if (!isInt(ua * 8) || !isInt(bays) || Math.round(bays) < 1 || (len >= 2.4 && (width < 2.4 || width > 3.6)))
      badBay.push(`${b.id} ${b.style} u ${ua.toFixed(3)}..${ub.toFixed(3)} over ${len.toFixed(1)} m`);
    // rows: a whole storey per row on lots (the places keep the grid's 3.2 m rows and their offsets)
    if (!b.place && b.kind !== 'hangar' && b.landmark !== 'kimchi_tower') {
      const rows = (vc - va) * 8, storey = h / rows, want = b.h / Math.max(1, Math.round(b.h / (STOREY[b.style] ?? 3.2)));
      if (!isInt(va * 8) || Math.abs(storey - want) > 0.01) badRow.push(`${b.id} ${b.style} v ${va.toFixed(3)}..${vc.toFixed(3)} over ${h.toFixed(2)} m (storey ${storey.toFixed(2)}, want ${want.toFixed(2)})`);
    }
  }
  if (lowest !== Infinity && lowest > b.base - 1) badSink++;
}
note(`${walls} facade walls, ${rotated} of them on buildings not square to the axes`);
check('every wall holds whole 3 m bays from a bay boundary', badBay.length === 0, badBay.slice(0, 4).join('; '));
check('every lot wall has one atlas row per storey from a row boundary', badRow.length === 0, badRow.slice(0, 4).join('; '));
check('rotated buildings are covered', rotated > 100, String(rotated));
check('walls run at least 1 m below the floor', badSink === 0, String(badSink));

// ---------- 4. heights ----------

section('heights: shells within the building height');
let over = [];
for (const b of W.buildings) {
  const p = B3.buildingPass(b, 'shell');
  let top = -Infinity;
  for (let i = 0; i < p.n; i++) top = Math.max(top, p.pos[i * 3 + 1]);
  const roofed = b.house || b.place === 'kimchi' || b.kind === 'hangar';
  const allow = roofed ? 0.42 * Math.max(b.w, b.d) + 3 : 0.25 + (b.place === 'home' || b.style === 'mansion' ? 0.7 : b.place ? 0.4 : 0);
  if (top > b.base + b.h + allow) over.push(`${b.id} ${b.style}/${b.place || b.kind} top ${(top - b.base).toFixed(2)} > h ${b.h}`);
}
check('no shell rises over its height (bar roofs)', over.length === 0, over.slice(0, 4).join('; '));
{
  const t = W.buildings.find((b) => b.landmark === 'kimchi_tower');
  const p = t && B3.buildingPass(t, 'shell');
  let top = -Infinity, glass = 0;
  for (let i = 0; p && i < p.n; i++) { top = Math.max(top, p.pos[i * 3 + 1]); if (p.layer[i] === LAY.tower) glass++; }
  check('Kimchi Tower is a building with a 140 m shell', !!t && Math.abs(top - (t.base + 140.16)) < 0.3, t ? (top - t.base).toFixed(2) : 'missing');
  check('Kimchi Tower is on the tower facade', glass > 0);
}
{
  // The villa and the Heights' glass mansions: the camera, bullets and Kimchi stop at the footprint (OCC and
  // BUILD), so above head height nothing of the design (the slab, the cantilevered floor, its roof) reaches past
  // it. Checked in each building's own frame, shell and detail.
  const villas = W.buildings.filter((b) => b.place === 'home' || (b.style === 'mansion' && !b.house && !b.place));
  const inv = new THREE.Matrix4(), v = new THREE.Vector3(), out = [];
  let checked = 0;
  for (const b of villas) {
    for (const kind of ['shell', 'detail']) {
      const p = B3.buildingPass(b, kind), f = p.frame;
      inv.copy(f.m).invert();
      let worst = 0;
      for (let i = 0; i < p.n; i++) {
        v.set(p.pos[i * 3], p.pos[i * 3 + 1], p.pos[i * 3 + 2]).applyMatrix4(inv);
        if (v.y < 2) continue;
        checked++;
        worst = Math.max(worst, f.x0 - v.x, v.x - f.x1, f.z0 - v.z, v.z - f.z1);
      }
      if (worst > 0.02) out.push(`${b.id} ${b.place || b.style} ${kind} ${worst.toFixed(2)} m past`);
    }
  }
  note(`${villas.length} villa-design buildings, ${checked} vertices above 2 m`);
  check('the villa and the glass mansions stay inside their footprints above 2 m', villas.length >= 8 && out.length === 0, out.slice(0, 4).join('; '));
}
{
  // Collins: no two hotels within 80 m carry the same name (each name is one cell of the sign sheet, and a
  // hotel's signs are the sheet-layer quads of its detail)
  const resorts = W.buildings.filter((b) => b.style === 'resort' && !b.place);
  const nameOf = (b) => {
    const p = B3.buildingPass(b, 'detail');
    for (let i = 0; i < p.n; i++) if (p.layer[i] === LAY.sheet) return `${p.uv[i * 2].toFixed(4)},${p.uv[i * 2 + 1].toFixed(4)}`;
    return null;
  };
  const names = new Map(resorts.map((b) => [b.id, nameOf(b)]));
  const same = [];
  for (const a of resorts) for (const b of resorts) {
    if (a.id < b.id && names.get(a.id) && names.get(a.id) === names.get(b.id) && Math.hypot(a.cx - b.cx, a.cz - b.cz) < 80) same.push(`${a.id}/${b.id}`);
  }
  check(`every Collins hotel has a name (${resorts.length})`, resorts.length > 0 && resorts.every((b) => names.get(b.id)));
  check('no two hotels within 80 m share a name', same.length === 0, same.slice(0, 6).join(' '));
}

// ---------- 5. Ocean Drive ----------

section('Ocean Drive hotels face the beach');
{
  const road = ROADS.find((r) => r.id === 'collins_ocean');
  const c = sampleCurve(road.pts, { step: 2 });
  const near = (x, z) => {
    let best = Infinity, bx = 0;
    for (let i = 0; i < c.n; i++) { const d = Math.hypot(c.x[i] - x, c.z[i] - z); if (d < best) { best = d; bx = c.x[i]; } }
    return [best, bx];
  };
  // the hotels whose curb is on Ocean Drive's west side (corner lots fronting the side streets are not)
  const hotels = W.buildings.filter((b) => {
    if (b.region !== 'deco' || b.cz < road.altFromZ || b.place) return false;
    const [d, x] = near(b.curb.x * S, b.curb.y * S);
    return d < 10 && b.cx < x;
  });
  const facing = hotels.filter((b) => Math.cos(b.a) > 0.9);
  note(`${hotels.length} hotels on Ocean Drive's west side, ${facing.length} facing east`);
  check('Ocean Drive has a row of hotels', hotels.length >= 8, String(hotels.length));
  check('every Ocean Drive hotel faces east to the beach', facing.length === hotels.length);
}

// ---------- 6. detail cells ----------

section('detail cells');
const cellsWith = new Set(W.buildings.map((b) => b.cell));
check('a lazy detail cell for every 128 m cell with buildings', st0.cells === cellsWith.size, `${st0.cells} of ${cellsWith.size}`);
{
  let missing = 0, empty = 0;
  for (const b of W.buildings) {
    const p = B3.buildingPass(b, 'detail');
    if (!p.n) empty++;
  }
  missing = B3.buildingStats().signMisses || 0;
  check('every building has detail', empty === 0, String(empty));
  check('every painted sign a building asks for is on the sheet', missing === 0, String(missing));
}

// ---------- 7. a lap of the Loop ----------

section('a 50 m/s lap of the Loop');
{
  const loop = ROADS.find((r) => r.id === 'loop');
  const c = sampleCurve(loop.pts, { closed: true, step: 2 });
  const cam = new THREE.PerspectiveCamera(62, 1440 / 800, 0.15, 2600);
  const byCell = new Map();
  for (const b of W.buildings) { if (!byCell.has(b.cell)) byCell.set(b.cell, []); byCell.get(b.cell).push(b); }
  const meshOf = (cell) => group.children.find((o) => o.name === `building detail ${cell}`);
  const dt = 1 / 60, step = 50 * dt;
  let s = 0, t = 0, worst = 0, misses = 0, missFrames = 0, maxBuilt = 0, overCache = 0;
  const slices = [];
  const len = c.len, at = (s) => { const i = Math.min(c.n - 1, Math.floor(((s % len) + len) % len / 2)); return [c.x[i], c.z[i], c.tx[i], c.tz[i]]; };
  while (s < len) {
    const [x, z, tx, tz] = at(s), y = W.groundY(x * 16, z * 16) + 3;
    cam.position.set(x - tx * 6, y + 2, z - tz * 6);
    cam.lookAt(x + tx * 30, y, z + tz * 30);
    cam.updateMatrixWorld();
    chunks.update(cam, { x, z }, t === 0 ? 0 : dt);
    const stt = chunks.stats();
    worst = Math.max(worst, stt.sliceMs);
    if (stt.sliceMs > 0) slices.push(stt.sliceMs);
    maxBuilt = Math.max(maxBuilt, stt.built);
    if (stt.built > MAX_CELLS) overCache++;
    if (t > 1) {
      let miss = 0;
      for (const [cell, list] of byCell) {
        if (!list.some((b) => Math.hypot(b.cx - x, b.cz - z) < 150)) continue;
        const m = meshOf(cell);
        if (!m || !m.visible) miss++;
      }
      if (miss) { misses += miss; missFrames++; }
    }
    s += step; t += dt;
  }
  slices.sort((a, b) => a - b);
  const p90 = slices[Math.floor(slices.length * 0.9)] ?? 0;
  note(`lap ${len.toFixed(0)} m in ${t.toFixed(1)} s: ${slices.length} build slices, 90% within ${p90.toFixed(2)} ms, worst ${worst.toFixed(2)} ms (a garbage collection or a busy machine shows here), at most ${maxBuilt} cells built (${overCache} frames over ${MAX_CELLS}), ${B3.buildingStats().cellBuilds} cell builds, slowest step ${B3.buildingStats().maxStepMs.toFixed(2)} ms`);
  check('no building within 150 m of the camera without its detail', missFrames === 0, `${missFrames} frames, ${misses} cell misses`);
  // node's wall clock on a shared machine: the browser's own figure is chunks.stats().maxSliceMs (KC3.soak)
  check('build slices within 3 ms (90% of them, node clock)', p90 <= 3.0, p90.toFixed(2));
  check(`the detail cache stays within ${MAX_CELLS} cells`, overCache === 0, `${overCache} frames, peak ${maxBuilt}`);
}

// ---------- 8. bench views ----------

section('bench views: what the buildings draw');
{
  const camera = new THREE.PerspectiveCamera(62, 1440 / 800, 0.15, LOW_TIER ? 1200 : 2600);
  const occ = (xm, zm) => {
    const g = W.groundY(xm * 16, zm * 16), [w] = W.grids.dims.occ, o = W.grids.occ[Math.floor(zm / 2) * w + Math.floor(xm / 2)];
    return o > g + 1.5 ? o : g;
  };
  const CALLS = 45, TRIS = 300e3;
  for (const v of W.benchViews) {
    const focus = D.placeCamera(camera, v, { groundY: W.groundY, occluderTop: occ });
    D.placeSun(sun, 13 * 60, focus);
    for (let k = 0; k < 120; k++) chunks.update(camera, focus, 1 / 60);
    const cam = D.cameraPass(scene, camera), sh = D.shadowPass(scene, camera, sun);
    const calls = cam.calls + sh.calls, tris = cam.tris + sh.tris;
    check(`${v.name}: buildings draw ${calls} calls (camera + shadow) within ${CALLS}`, calls <= CALLS);
    check(`${v.name}: ${(tris / 1e3).toFixed(0)} k triangles within ${TRIS / 1e3} k`, tris <= TRIS);
    note(`${v.name}: camera ${cam.calls} calls ${(cam.tris / 1e3).toFixed(0)} k tris, shadow ${sh.calls} calls ${(sh.tris / 1e3).toFixed(0)} k tris`);
  }
}

// ---------- 9. the material ----------

section('the material: layer stacks and shader edits');
{
  const mat = shells[0].material;
  const u = {};
  const fake = (lib) => ({ uniforms: {}, vertexShader: THREE.ShaderLib[lib].vertexShader, fragmentShader: THREE.ShaderLib[lib].fragmentShader });
  for (const lib of LOW_TIER ? ['lambert'] : ['standard', 'lambert']) {
    const sh = fake(lib);
    mat.onBeforeCompile(sh);
    Object.assign(u, sh.uniforms);
    const fs = sh.fragmentShader, vs = sh.vertexShader;
    check(`${lib}: the map, emissive and light chunks are replaced`, !fs.includes('#include <map_fragment>') && !fs.includes('#include <emissivemap_fragment>') && !fs.includes('#include <lights_fragment_begin>'));
    if (lib === 'standard') check('standard: roughness and metalness come from the layer table', !fs.includes('#include <roughnessmap_fragment>') && !fs.includes('#include <metalnessmap_fragment>'));
    check(`${lib}: the lamp loops are gated`, (fs.match(/if \( uKcLamps \)/g) || []).length === 2);
    check(`${lib}: each vertex's layer reaches the fragment shader`, vs.includes('attribute float layer') && vs.includes('vBLayer = layer') && fs.includes('varying float vBLayer'));
    check(`${lib}: decals are pulled toward the camera`, vs.includes('mvPosition.xyz *= 1.0 -'));
  }
  check('the colour, glow and roughness stacks are texture arrays of 15, 8 and 6 layers',
    u.tBColor?.value?.isDataArrayTexture && u.tBColor.value.image.depth === 15 && u.tBLit.value.image.depth === 8 && u.tBRough.value.image.depth === 6);
  check('the colour stack is sRGB with mipmaps and repeats', u.tBColor.value.colorSpace === THREE.SRGBColorSpace && u.tBColor.value.generateMipmaps && u.tBColor.value.wrapS === THREE.RepeatWrapping);
  check('a shell mesh carries each vertex\'s layer', shells.every((m) => m.geometry.attributes.layer?.count === m.geometry.attributes.position.count));
}

// ---------- 10. filling the layers ----------

section('filling the layers: mipmaps made once a burst, every bitmap let go');
{
  // decoding and fetching mocked: each stand-in or picture settles when the test says so
  const TX = await import(src('src/3d/textures.js'));
  const pending = new Map(), bitmaps = [];
  const later = (key) => new Promise((res, rej) => pending.set(key, { res, rej }));
  const settle = async (key, ok = true) => { const p = pending.get(key); pending.delete(key); ok ? p.res() : p.rej(new Error('404')); await new Promise((r) => setTimeout(r, 0)); };
  const saved = { cib: globalThis.createImageBitmap, fetch: globalThis.fetch };
  globalThis.createImageBitmap = async (src) => {
    if (src?.key) await later(src.key);
    const b = { width: 64, height: 64, closed: false, close() { this.closed = true; } };
    bitmaps.push(b);
    return b;
  };
  globalThis.fetch = async (url) => { await later(url); return { ok: true, blob: async () => ({ key: null }) }; };
  const log = [];
  const renderer = { initTexture() {}, copyTextureToTexture3D: (s, dst, box, at) => log.push([dst.name, at.z, dst.generateMipmaps]) };
  const A = TX.layerStack(3, 64);
  A.name = 'A';
  TX.putLayer(A, 0, { key: 's0' }, 'p0'); TX.putLayer(A, 1, { key: 's1' }, 'p1'); TX.putLayer(A, 2, { key: 's2' });
  for (const k of ['s0', 's1', 's2']) await settle(k);
  TX.flushLayers(renderer);
  const mips = () => log.filter((l) => l[2]).length;
  check('the stand-ins go in with one mipmap pass, after the last', log.length === 3 && mips() === 1 && log[2][2], JSON.stringify(log));
  await settle('p0');                    // one picture in while the other still loads: no mipmaps yet
  TX.flushLayers(renderer);
  check('a picture that comes while another loads waits for the mipmaps', log.length === 4 && mips() === 1, JSON.stringify(log.slice(3)));
  await settle('p1', false);             // the other picture fails: the last copy is made again, with the mipmaps
  TX.flushLayers(renderer);
  check('once nothing more is coming, the mipmaps are made', log.length === 5 && mips() === 2 && log[4][1] === 0 && log[4][2], JSON.stringify(log.slice(4)));
  check('the queue is empty and every bitmap is let go', !TX.layersWaiting() && bitmaps.every((b) => b.closed), `${bitmaps.filter((b) => !b.closed).length} open`);
  const B = TX.layerStack(2, 64);
  B.name = 'B';
  TX.putLayer(B, 0, { key: 't0' }, 'q0'); TX.putLayer(B, 1, { key: 't1' }, 'q1');
  for (const k of ['t1', 'q0', 't0', 'q1']) await settle(k);   // layer 0's picture before its stand-in
  log.length = 0;
  TX.flushLayers(renderer);
  check('stand-ins and pictures that come together get one mipmap pass', mips() === 1 && log[log.length - 1][2], JSON.stringify(log));
  check('a late stand-in never covers its picture (it is not copied)', log.length === 3 && log.filter((l) => l[1] === 0).length === 1, JSON.stringify(log));
  check('the queue is empty again and every bitmap is let go', !TX.layersWaiting() && bitmaps.every((b) => b.closed));
  globalThis.createImageBitmap = saved.cib; globalThis.fetch = saved.fetch;
}

done();
