#!/usr/bin/env node
// Stage S4a check (docs/map-v2-stages.json, spec §7 and §11.1): the v2 renderer skeleton, built in node.
//   node tools/s4a_city_test.mjs            (S3B_LOW=1 for the phone tier)
//  1. The stubs: roads3d, buildings3d, props3d and landmarks3d export exactly the §7 builders, with their
//     arguments, and build nothing.
//  2. cityV2 through the city facade: buildCity(scene) returns { group, update, setNight, chunks }, the facade
//     re-reads sea and yachts once it is built, and occluderTop is the ground on open land and a building's top
//     on a building.
//  3. Terrain: every tile with land is built, the 8 m and 2 m grids of neighbouring tiles share their edges
//     exactly, and wherever a 2 m tile meets an 8 m one (either way round) the skirt hanging from the higher edge
//     reaches below the lower one, so no crack shows between them; on a drive round the county with
//     teleports, every tile shows exactly one grid at every frame, the 2 m grid within LOD0_R once built, and
//     the built 2 m grids stay within the cache (24) unless they are all in use.
//  4. Coast: the sea plane at SEA_LEVEL, the ponds at their own levels (sharing the sea's ripples), the seawall
//     faces standing seaward of every bit of ground still above the water, covering 95% of the banks and
//     running straight, the sea deepening smoothly past the map edge, the yachts floating in at least 1.1 m of
//     water and clear of each other, the beach props on sand, and the far albedo toned with no water or deck
//     paint left on dry ground.
//  5. The bench views: what the city draws (camera pass + the sun's shadow pass, walked the way three r169
//     walks them, palms and plants loaded) stays within the stage budget (calls and triangles).
//  6. sky.js: the v2 fog (high tier exponential 0.00055 + 0.0006 golden + 0.0008 night; low tier linear
//     180-900 m) and the grid's fog unchanged (in child processes, one per world and tier).
//  7. main3d (read as source, it needs a browser): the v2 camera planes, the title path, the title's shadow
//     focus on the ground, and the dev screenshot hook (?shot= &cam= &hour= &hud=) still there.
// Exits 1 if any check fails.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { src, check, section, note, done, quiet, ROOT } from './s3b_env.mjs';
globalThis.KC_WORLD = 'v2';
const THREE = await import('three');
const D = await import('./s3b_draws.mjs');
const W = await import(src('src/world.js'));
W.generate();
const LOW_TIER = process.env.S3B_LOW === '1';
const S = 1 / 16;

// ---------- 1. the stubs ----------

section('stubs (spec §7)');
const STUBS = {
  'src/3d/roads3d.js': ['buildRoads3D', 3],
  'src/3d/buildings3d.js': ['registerBuildings', 2],
  'src/3d/props3d.js': ['buildProps3D', 2],
  'src/3d/landmarks3d.js': ['buildLandmarks', 3],
};
for (const [file, [name, arity]] of Object.entries(STUBS)) {
  const m = await import(src(file));
  check(`${file} exports ${name}`, typeof m[name] === 'function', Object.keys(m).join(', '));
  check(`${file} ${name} takes ${arity} arguments`, m[name]?.length === arity, String(m[name]?.length));
  check(`${file} ${name} builds nothing yet`, m[name]?.(W, null, null) === undefined);
}

// ---------- 2. the city ----------

section('cityV2 through the facade');
const CITY = await import(src('src/3d/city.js'));
const CV = await import(src('src/3d/cityV2.js'));
const scene = new THREE.Scene();
const sun = D.makeSun(LOW_TIER ? 42 : 64);
scene.add(sun, sun.target);
scene.fog = new THREE.FogExp2('#cfe3f0', 0.00055);
const t0 = performance.now();
const city = await quiet(() => CITY.buildCity(scene));
note(`buildCity ${(performance.now() - t0).toFixed(0)} ms (node, no far albedo canvas here)`);
check('buildCity returns { group, update, setNight, chunks }', city.group?.isGroup && typeof city.update === 'function' && typeof city.setNight === 'function' && typeof city.chunks?.update === 'function');
check('the city group is in the scene', city.group.parent === scene);
check('the facade forwards the built sea', CITY.sea === CV.sea && CITY.sea?.isMesh);
check('the facade forwards the yachts', CITY.yachts === CV.yachts && CITY.yachts.length > 0, String(CITY.yachts.length));
// (since S5b props3d builds the lamps; there are still no fountains or mountains)
check('no fountains or mountains; the lamps are props3d\'s', CITY.fountains.length === 0 && CITY.mountains.length === 0 && CITY.lampHeads.length > 0, String(CITY.lampHeads.length));
check('nearestLamps answers the 6 nearest lamps', CITY.nearestLamps(500, 500, 6, [1, 2]).length === 6);
{
  const b = W.buildings.find((q) => q.h > 20);
  const top = CITY.occluderTop(b.cx, b.cz);
  check('occluderTop is a tall building\'s top on it', top >= b.base + b.h - 0.5, `${top} vs ${b.base + b.h}`);
  const home = W.places.home.foot, gy = W.groundY(home.x, home.y);
  // open grass in the Glades, away from everything
  let open = null;
  for (let x = 200; x < 500 && !open; x += 7) for (let z = 700; z < 1000 && !open; z += 7) {
    if (W.surfaceAt(x * 16, z * 16) === W.GRASS && CITY.occluderTop(x, z) !== undefined) open = [x, z];
  }
  check('occluderTop is the ground on open grass', open && Math.abs(CITY.occluderTop(open[0], open[1]) - W.groundY(open[0] * 16, open[1] * 16)) < 1e-6);
  check('occluderTop is the ground at the villa foot', Math.abs(CITY.occluderTop(home.x * S, home.y * S) - gy) < 1.6);
}

// ---------- 3. terrain ----------

section('terrain: tiles, edges, skirts, LOD');
const T3 = await import(src('src/3d/terrain3d.js'));
const terrain = city.terrain;
const G = W.grids, [VW, VH] = G.dims.terrain;
{
  // every tile with any vertex above the water line is built
  let want = 0;
  for (let tz = 0; tz < 7; tz++) for (let tx = 0; tx < 8; tx++) {
    let top = -Infinity;
    for (let j = tz * 128; j <= tz * 128 + 128; j++) for (let i = tx * 128; i <= tx * 128 + 128; i++) top = Math.max(top, G.terrain[j * VW + i]);
    if (top > -2.2) want++;
  }
  check('every tile with land has a terrain group', terrain.tiles.length === want, `${terrain.tiles.length} of ${want}`);
  note(`${terrain.tiles.length} tiles; LOD0 within ${T3.LOD0_R} m`);
}
terrain.buildAround(1024, 896, 1e9);   // every 2 m grid, for the edge checks
const byKey = new Map(terrain.tiles.map((t) => [t.key, t]));
const EDGE_N = { lod0: 129, lod1: 33 };
// a grid's edge (x along it, the top heights and the skirt bottoms), read back from its geometry
function edgeOf(mesh, side) {
  const n = mesh.name.startsWith('lod0') ? EDGE_N.lod0 : EDGE_N.lod1, P = mesh.geometry.attributes.position.array, base = n * n;
  const at = (a, b) => b * n + a, list = { N: [(s) => at(s, 0), 0], S: [(s) => at(s, n - 1), 1], W: [(s) => at(0, s), 2], E: [(s) => at(n - 1, s), 3] }[side];
  const top = [], bottom = [], along = [];
  for (let s = 0; s < n; s++) {
    const v = list[0](s), k = base + list[1] * n + s;
    along.push(side === 'N' || side === 'S' ? P[v * 3] : P[v * 3 + 2]);
    top.push(P[v * 3 + 1]); bottom.push(P[k * 3 + 1]);
  }
  return { along, top, bottom };
}
const lerpAt = (e, x, key) => {
  const a = e.along, y = e[key];
  if (x <= a[0]) return y[0];
  for (let i = 0; i + 1 < a.length; i++) if (x <= a[i + 1]) return y[i] + (y[i + 1] - y[i]) * (x - a[i]) / (a[i + 1] - a[i]);
  return y[y.length - 1];
};
{
  let pairs = 0, same0 = 0, same1 = 0, worstGap = 0, crackAt = null, holes = 0;
  for (const t of terrain.tiles) for (const [dx, dz, sa, sb] of [[1, 0, 'E', 'W'], [0, 1, 'S', 'N']]) {
    const u = byKey.get(`${t.tx + dx},${t.tz + dz}`);
    if (!u) continue;
    pairs++;
    for (const lod of ['lod0', 'lod1']) {
      const a = edgeOf(t[lod], sa), b = edgeOf(u[lod], sb);
      const ok = a.top.every((y, i) => y === b.top[i]) && a.along.every((x, i) => x === b.along[i]);
      if (ok) lod === 'lod0' ? same0++ : same1++;
    }
    // fine against coarse, both ways round: along the edge every 0.25 m, the higher edge's skirt must reach
    // the lower edge (where both are under the sea nothing shows; the sea is opaque)
    for (const [fa, fb] of [[t.lod0, u.lod1], [t.lod1, u.lod0]]) {
      const a = edgeOf(fa, sa), b = edgeOf(fb, sb);
      for (let x = a.along[0]; x <= a.along[a.along.length - 1]; x += 0.25) {
        const ya = lerpAt(a, x, 'top'), yb = lerpAt(b, x, 'top');
        if (Math.max(ya, yb) < W.SEA_LEVEL) continue;
        const gap = Math.abs(ya - yb), reach = ya > yb ? lerpAt(a, x, 'bottom') - yb : lerpAt(b, x, 'bottom') - ya;
        if (gap > worstGap) worstGap = gap;
        if (reach > 1e-3) { holes++; crackAt ||= `${t.key}|${u.key} at ${x.toFixed(1)} (gap ${gap.toFixed(2)} m, skirt short by ${reach.toFixed(2)})`; }
      }
    }
  }
  check('neighbouring 2 m grids share their edges exactly', same0 === pairs, `${same0} of ${pairs}`);
  check('neighbouring 8 m grids share their edges exactly', same1 === pairs, `${same1} of ${pairs}`);
  check('where a 2 m grid meets an 8 m one, a skirt closes every step', holes === 0, crackAt || '');
  note(`${pairs} shared edges; the biggest step between a fine and a coarse edge is ${worstGap.toFixed(2)} m`);
}
{
  // the skirts are in the index: every kept edge quad has its skirt quad (2 triangles per segment)
  let short = 0;
  for (const t of terrain.tiles) for (const m of [t.lod0, t.lod1]) {
    const idx = m.geometry.index.array, n = m.name.startsWith('lod0') ? 129 : 33, base = n * n;
    let skirtTris = 0;
    for (let k = 0; k < idx.length; k += 3) if (idx[k] >= base || idx[k + 1] >= base || idx[k + 2] >= base) skirtTris++;
    if (skirtTris === 0 && t.top > 0) short++;
  }
  check('every tile with land above the sea has skirt triangles', short === 0, `${short} without`);
}
{
  // heightAt follows TERRAIN at the vertices and between them
  let worst = 0;
  for (let k = 0; k < 2000; k++) {
    const i = 1 + Math.floor(Math.random() * (VW - 2)), j = 1 + Math.floor(Math.random() * (VH - 2));
    worst = Math.max(worst, Math.abs(terrain.heightAt(i * 2, j * 2) - G.terrain[j * VW + i]));
  }
  check('heightAt is TERRAIN at the vertices', worst < 1e-4, String(worst));
}
{
  // a drive round the county at 50 m/s with three teleports: each tile shows exactly one grid every frame
  const T = T3.buildTerrain3D(W, null, {});
  const cam = new THREE.PerspectiveCamera(62, 1.8, 0.15, 2600);
  const route = W.routes.bay_loop, pts = route?.pts;
  let both = 0, none = 0, lateFine = 0, frames = 0, maxBuilt = 0, overCache = 0;
  const step = (x, z) => {
    cam.position.set(x, 30, z);
    T.update(cam, 1 / 60);
    frames++;
    let built = 0, inUse = 0;
    for (const t of T.tiles) {
      const fine = !!t.lod0?.visible, coarse = t.lod1.visible;
      if (fine && coarse) both++;
      if (!fine && !coarse) none++;
      if (t.lod0) { built++; if (t.d <= T3.LOD0_R + 160) inUse++; }
    }
    maxBuilt = Math.max(maxBuilt, built);
    if (built > 24 && built > inUse) overCache++;
    return T.stats();
  };
  const P = [];
  if (pts) for (let i = 0; i + 1 < pts.length; i += 2) P.push([pts[i] * S, pts[i + 1] * S]);
  else for (let a = 0; a < Math.PI * 2; a += 0.002) P.push([1000 + Math.cos(a) * 600, 900 + Math.sin(a) * 500]);
  let len = 0;
  for (let i = 1; i < P.length; i++) len += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
  const stepM = 50 / 60, jumps = new Set([Math.floor(len / stepM * 0.25), Math.floor(len / stepM * 0.5), Math.floor(len / stepM * 0.75)]);
  let s = 0, seg = 0, acc = 0, f = 0;
  while (seg + 1 < P.length) {
    const [ax, az] = P[seg], [bx, bz] = P[seg + 1], L = Math.hypot(bx - ax, bz - az);
    if (acc + L < s) { acc += L; seg++; continue; }
    const u = L ? (s - acc) / L : 0;
    if (jumps.has(f)) step(1700, 1500);       // a teleport to the lighthouse key and back onto the route
    step(ax + (bx - ax) * u, az + (bz - az) * u);
    // within LOD0_R, a built fine grid is what shows (one frame of grace after a teleport is not needed: it builds at once)
    for (const t of T.tiles) if (t.d < T3.LOD0_R && t.lod0 && !t.lod0.visible) lateFine++;
    s += stepM; f++;
  }
  check('every tile shows exactly one grid every frame (never both)', both === 0, `${both} tile-frames with both`);
  check('every tile shows exactly one grid every frame (never none)', none === 0, `${none} tile-frames with none`);
  check('within LOD0_R a built 2 m grid is shown', lateFine === 0, String(lateFine));
  check('the 2 m grid cache stays at 24 unless every built one is in use', overCache === 0, `${overCache} frames over; most built ${maxBuilt}`);
  note(`${frames} frames over ${(len / 1000).toFixed(2)} km; at most ${maxBuilt} 2 m grids built; ${JSON.stringify(T.stats())}`);
}

// ---------- 4. coast ----------

section('coast: sea, ponds, seawalls, yachts, beach props');
const coast = city.coast;
check('the sea lies at SEA_LEVEL', Math.abs(coast.sea.position.y - W.SEA_LEVEL) < 1e-6);
check('the sea is drawn after the land (renderOrder)', coast.sea.renderOrder > 0);
check('the sea covers 6 km', coast.sea.geometry.parameters.width >= 6000);
check('one pond mesh per inland water body, each at its level', coast.ponds.length === W.water.bodies.length && coast.ponds.every((m, i) => Math.abs(m.position.y - W.water.bodies[i].level) < 1e-6));
{
  // seawall faces: no face corner (its foot is at -3 m) stands where the ground is clearly above the water
  // (the face goes where the bilinear ground has dipped under the sea, so a few corners sit within 0.15 m of it)
  const tAt = (x, z) => {
    const fx = Math.min(Math.max(x / 2, 0), VW - 1.001), fz = Math.min(Math.max(z / 2, 0), VH - 1.001), i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, T = G.terrain;
    return (T[j * VW + i] * (1 - u) + T[j * VW + i + 1] * u) * (1 - v) + (T[(j + 1) * VW + i] * (1 - u) + T[(j + 1) * VW + i + 1] * u) * v;
  };
  let feet = 0, dry = 0, where = '';
  for (const m of coast.walls) {
    const P = m.geometry.attributes.position.array;
    for (let k = 0; k < P.length; k += 3) {
      if (Math.abs(P[k + 1] + 3) > 1e-4) continue;
      feet++;
      if (tAt(P[k], P[k + 2]) > W.SEA_LEVEL + 0.15) { dry++; where ||= `(${P[k].toFixed(1)}, ${P[k + 2].toFixed(1)})`; }
    }
  }
  check('seawall faces stand where the ground has gone under the water', feet > 0 && dry === 0, `${dry} of ${feet} corners on dry ground ${where}`);
  note(`${coast.stats().wallPieces} seawall pieces in ${coast.walls.length} tile meshes`);

  // coverage: every 2 m along every seawall shore whose ground goes under the water within 5.5 m (a bank, not a
  // fill's flank or a neck of land), a wall foot stands seaward of it within 9 m of its waterline
  const hash = new Map();
  for (const m of coast.walls) {
    const P = m.geometry.attributes.position.array;
    for (let k = 0; k < P.length; k += 3) if (Math.abs(P[k + 1] + 3) < 1e-4) {
      const key = `${Math.floor(P[k] / 8)},${Math.floor(P[k + 2] / 8)}`;
      if (!hash.has(key)) hash.set(key, []);
      hash.get(key).push([P[k], P[k + 2]]);
    }
  }
  const footNear = (x, z, r) => {
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const f of hash.get(`${Math.floor(x / 8) + a},${Math.floor(z / 8) + b}`) || []) if (Math.hypot(f[0] - x, f[1] - z) < r) return true;
    return false;
  };
  const kindOf = (list, name) => list.filter(k => k.coast === name);
  let banks = 0, walled = 0, gap = '';
  for (const [name, list] of Object.entries(W.coast.shapes)) for (const sh of list) {
    const P = sh.poly || (sh.rect ? [[sh.rect[0], sh.rect[1]], [sh.rect[2], sh.rect[1]], [sh.rect[2], sh.rect[3]], [sh.rect[0], sh.rect[3]]] : (() => {
      const [cx, cz] = sh.circle || sh.ellipse, rx = sh.r ?? sh.rx, rz = sh.r ?? sh.rz, n = Math.max(24, Math.ceil(2 * Math.PI * Math.max(rx, rz) / 6));
      return Array.from({ length: n }, (_, i) => [cx + rx * Math.cos(2 * Math.PI * i / n), cz + rz * Math.sin(2 * Math.PI * i / n)]);
    })());
    const kind = new Array(P.length).fill('seawall'), at = ([x, z]) => P.findIndex(p => Math.abs(p[0] - x) < 0.01 && Math.abs(p[1] - z) < 0.01);
    for (const run of kindOf(W.coast.kinds, name)) {
      if (!run.from) { kind.fill(run.kind); continue; }
      const a = at(run.from), b = at(run.to);
      if (a >= 0 && b >= 0) for (let i = a; i !== b; i = (i + 1) % P.length) kind[i] = run.kind;
    }
    let area = 0;
    for (let i = 0; i < P.length; i++) area += P[i][0] * P[(i + 1) % P.length][1] - P[(i + 1) % P.length][0] * P[i][1];
    const inward = area > 0 ? 1 : -1;
    for (let i = 0; i < P.length; i++) {
      if (kind[i] !== 'seawall') continue;
      const [ax, az] = P[i], [bx, bz] = P[(i + 1) % P.length], L = Math.hypot(bx - ax, bz - az), tx = (bx - ax) / L, tz = (bz - az) / L, nx = -tz * inward, nz = tx * inward;
      for (let q = 1; q < L; q += 2) {
        const x = ax + tx * q, z = az + tz * q;
        if (!(tAt(x + nx * 1, z + nz * 1) > W.SEA_LEVEL)) continue;          // inside another shape's water, or no land here
        let first = -1;
        for (let o = 0.25; o <= 5.5; o += 0.25) if (tAt(x - nx * o, z - nz * o) <= W.SEA_LEVEL - 0.1) { first = o; break; }
        if (first < 0) continue;
        banks++;
        let hit = false;
        for (let o = first; o <= first + 9 && !hit; o += 1) hit = footNear(x - nx * o, z - nz * o, 2.5);
        if (hit) walled++; else gap ||= `(${x.toFixed(0)}, ${z.toFixed(0)})`;
      }
    }
  }
  check('seawalls cover at least 95% of the seawall shore that is a bank', banks > 1000 && walled >= 0.95 * banks, `${walled} of ${banks} 2 m stops walled; first gap ${gap}`);
  note(`seawalls cover ${walled} of ${banks} bank stops (${(walled / banks * 100).toFixed(1)}%)`);
  // straight: along any one shape edge the face's offset from the shore changes by at most 0.6 m from one stop to the next
  let steps = 0, jag = 0, jagAt = '';
  for (const run of coast.wallRuns) for (let i = 1; i < run.length; i++) {
    if (run[i].edge !== run[i - 1].edge) continue;
    steps++;
    if (Math.abs(run[i].o - run[i - 1].o) > 0.6) { jag++; jagAt ||= `(${run[i].x.toFixed(0)}, ${run[i].z.toFixed(0)})`; }
  }
  check('seawall faces run straight along their shore (no sawtooth)', steps > 1000 && jag === 0, `${jag} of ${steps} steps over 0.6 m ${jagAt}`);
}
{
  // the sea runs on past the rasters' edge, deepening smoothly (no step to 20 m at the border); the ponds share
  // the sea's ripple texture (so main3d's scroll moves them too) and draw no rolling lines
  const srcC = readFileSync(`${ROOT}/src/3d/coast3d.js`, 'utf8');
  check('the sea deepens smoothly past the map edge', srcC.includes('length((suv - cuv) * uWorld)') && !srcC.includes('onMap'));
  check('the ponds share the sea\'s ripple map', coast.ponds.length > 0 && coast.ponds.every(m => m.material.map === coast.sea.material.map));
}
{
  const [w, h] = G.dims.seaDepth;
  let ok = 0;
  for (const y of coast.yachts) {
    const p = y.g.position, i = Math.floor(p.x / 2), j = Math.floor(p.z / 2);
    if (G.seaDepth[j * w + i] / 255 * 20 >= 1.1 && p.y < W.SEA_LEVEL) ok++;
  }
  check('yachts float in at least 1.1 m of water', ok === coast.yachts.length && ok > 0, `${ok} of ${coast.yachts.length}`);
  // no two hulls overlap: each a rectangle L x 0.24 L along the pier, in the pier's own frame (all lie parallel)
  const pier = W.places.marina.pier, ca = Math.cos(pier.a), sa = Math.sin(pier.a);
  const hulls = coast.yachts.map(({ g }) => {
    const b = new THREE.Box3().setFromObject(g.children[0]), L = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
    const dx = g.position.x - pier.x * S, dz = g.position.z - pier.y * S;
    return { s: dx * ca + dz * sa, o: -dx * sa + dz * ca, L };
  });
  let clash = '';
  hulls.forEach((a, i) => hulls.forEach((b, j) => {
    if (j > i && Math.abs(a.s - b.s) < (a.L + b.L) / 2 && Math.abs(a.o - b.o) < (a.L + b.L) * 0.12) clash ||= `${i} and ${j}`;
  }));
  check('no two yachts overlap', coast.yachts.length >= 3 && !clash, clash || `${coast.yachts.length} yachts`);
  note(`${coast.yachts.length} yachts at the marina pier`);
  check('the marina pier is built', !!coast.pier);
}
check('beach props stand on the beaches', coast.stats().beachProps > 100 && coast.beach.length > 5, JSON.stringify(coast.stats()));
{
  // the far albedo toned for the ground: no water or deck paint is left where the ground stands above the water
  const { mapPixels } = await import(src('src/map/mapimage.js'));
  const img = mapPixels(W, 0.5, { shade: false, look: 'albedo' }), before = img.data.slice();
  T3.toneAlbedo(W, img.data, img.w, img.h);
  const [SW] = G.dims.surf, k = SW / img.w;
  let dryWet = 0, blue = 0, decks = 0, deckPaint = 0, grass = 0, wild = 0;
  for (let j = 0; j < img.h; j++) for (let i = 0; i < img.w; i++) {
    const q = [0, 1].flatMap(b => [0, 1].map(a => G.surf[(j * k + b) * SW + i * k + a] & 15)), o = (j * img.w + i) * 4, d = img.data;
    const y = G.terrain[j * VW + i];
    if (q.every(c => c === 6 || c === 9) && y > W.SEA_LEVEL + 0.05 && !W.water.bodies.some(b => y < b.level)) { dryWet++; if (d[o + 2] > d[o] + 20) blue++; }
    if (q.every(c => c === 10) && y > W.SEA_LEVEL + 0.05) { decks++; if (Math.abs(d[o] - 150) < 12 && Math.abs(d[o + 1] - 104) < 12 && Math.abs(d[o + 2] - 70) < 12) deckPaint++; }
    if (q.every(c => c === 2)) { grass++; const r = (d[o] + d[o + 1] + d[o + 2]) / Math.max(1, before[o] + before[o + 1] + before[o + 2]); if (r < 0.6 || r > 1.3) wild++; }
  }
  // the floor only proves the check found some (83 since P1/P4: the villa pool's cells are real water now)
  check('no water paint on ground above the water', dryWet > 50 && blue === 0, `${blue} of ${dryWet} dry water pixels still blue`);
  check('no deck paint on ground above the water', decks > 50 && deckPaint === 0, `${deckPaint} of ${decks}`);
  check('the grass\'s toning stays within -40%..+30%', grass > 1e5 && wild === 0, `${wild} of ${grass}`);
}

// ---------- 5. bench views ----------

section('bench views: what the city draws');
await new Promise((r) => setTimeout(r, 2500));   // the palm and asset-pack models load from disk
{
  const camera = new THREE.PerspectiveCamera(62, 1440 / 800, 0.15, LOW_TIER ? 1200 : 2600);
  const opts = { groundY: W.groundY, occluderTop: CITY.occluderTop };
  // the city's share of the wave-4 view budget (350 calls, 1.5 M triangles in the browser, main + shadow), which
  // leaves room for the cars, people, sky and post the browser adds (spec §12.1, raised after wave 4)
  const CALLS = 230, TRIS = 1.25e6;
  for (const v of W.benchViews) {
    const focus = D.placeCamera(camera, v, opts);
    D.placeSun(sun, 13 * 60, focus);
    for (let k = 0; k < 3; k++) city.update(camera, k * 0.1);   // the chunk manager, the LOD and the plants settle
    const cam = D.cameraPass(scene, camera), sh = D.shadowPass(scene, camera, sun);
    const calls = cam.calls + sh.calls, tris = cam.tris + sh.tris;
    check(`${v.name}: the city draws ${calls} calls (camera + shadow) within ${CALLS}`, calls <= CALLS);
    check(`${v.name}: ${(tris / 1e6).toFixed(2)} M triangles within ${(TRIS / 1e6).toFixed(1)} M`, tris <= TRIS);
    note(`${v.name}: camera ${cam.calls} calls ${(cam.tris / 1e3).toFixed(0)} k tris, shadow ${sh.calls} calls ${(sh.tris / 1e3).toFixed(0)} k tris`);
  }
}

// ---------- 6. sky ----------

section('sky: fog per world');
function skyFog(kind, low, hours) {
  const code = `
    process.env.S3B_LOW = ${JSON.stringify(low ? '1' : '0')};
    const { src } = await import(${JSON.stringify(src('tools/s3b_env.mjs'))});
    globalThis.KC_WORLD = ${JSON.stringify(kind)};
    const THREE = await import('three');
    const { makeSky } = await import(src('src/3d/sky.js'));
    const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera();
    const sky = makeSky(scene, {});
    const out = [];
    for (const h of ${JSON.stringify(hours)}) {
      sky.update(h * 60, new THREE.Vector3(), cam);
      out.push({ h, type: scene.fog.isFogExp2 ? 'exp2' : 'linear', density: scene.fog.density, near: scene.fog.near, far: scene.fog.far, day: sky.state.day, golden: sky.state.golden || 0 });
    }
    console.log('RESULT ' + JSON.stringify(out));
    process.exit(0);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 60000, env: { ...process.env, S3B_LOW: low ? '1' : '0' } });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) { check(`sky.js builds for ${kind}${low ? ' (low)' : ''}`, false, (r.stderr || '').slice(0, 400)); return []; }
  return JSON.parse(line.slice(7));
}
{
  const hours = [13, 15.5, 18.3, 21];
  const v2 = skyFog('v2', false, hours);
  for (const f of v2) {
    const want = 0.00055 + 0.0006 * f.golden + 0.0008 * (1 - f.day);
    check(`v2 high tier at ${f.h} h: exponential fog ${want.toFixed(6)}`, f.type === 'exp2' && Math.abs(f.density - want) < 1e-9, JSON.stringify(f));
  }
  const grid = skyFog('grid', false, hours);
  for (const f of grid) {
    const want = 0.0008 + 0.0008 * f.golden + 0.0008 * (1 - f.day);
    check(`grid high tier at ${f.h} h: fog unchanged ${want.toFixed(6)}`, f.type === 'exp2' && Math.abs(f.density - want) < 1e-9, JSON.stringify(f));
  }
  const v2low = skyFog('v2', true, [15.5]), gridLow = skyFog('grid', true, [15.5]);
  check('v2 low tier: linear fog 180-900 m', v2low[0]?.type === 'linear' && v2low[0].near === 180 && v2low[0].far === 900, JSON.stringify(v2low[0]));
  check('grid low tier: linear fog 90-460 m as before', gridLow[0]?.type === 'linear' && gridLow[0].near === 90 && gridLow[0].far === 460, JSON.stringify(gridLow[0]));
}

// ---------- 7. main3d ----------

section('main3d (source)');
{
  const m = readFileSync(new URL(src('src/3d/main3d.js')), 'utf8');
  check('v2 camera: near 0.15, far 2600 (low tier 1200); the grid keeps 0.1 and 4000', /PerspectiveCamera\(62, 1, V2 \? 0\.15 : 0\.1, V2 \? \(LOW \? 1200 : 2600\) : 4000\)/.test(m));
  check('the v2 title follows world.titleView', /titleView\.pose\(G\.t, desired, lookAt\)/.test(m));
  check('the grid title orbit is unchanged', m.includes('desired.set(MAP / 2 + Math.cos(a) * 175, 72, MAP / 2 + Math.sin(a) * 175);') && m.includes('lookAt.set(MAP / 2, 4, MAP / 2);'));
  check('the title\'s shadow focus sits on the ground on v2', /V2 \? titleFocus\(tmpV\)/.test(m) && /return out\.set\(x, surfaceY\(x \/ S, z \/ S\), z\)/.test(m));
  check('the grid\'s title focus is unchanged', m.includes(': tmpV.set(MAP / 2, 0, MAP / 2);'));
  check('the dev screenshot hook is still there (?shot= &cam= &hour= &hud=)', /shotQ\.get\('shot'\)/.test(m) && /shotQ\.get\('hour'\)/.test(m) && /shotQ\.get\('hud'\)/.test(m) && /shotQ\.get\('cam'\)/.test(m) && /window\.KC3\.teleport\(shot\.view\)/.test(m));
  check('the sea\'s ripples scroll only when it has a ripple map', m.includes('if (sea?.material.map) sea.material.map.offset.set('));
}

done();
