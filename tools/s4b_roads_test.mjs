#!/usr/bin/env node
// Stage S4b check (docs/map-v2-stages.json, spec §4.5 and §11.1 Roads): the v2 roads, junctions, paint and
// bridges, built in node and measured.
//   node tools/s4b_roads_test.mjs            (S3B_LOW=1 for the phone tier)
//  1. The contract: buildRoads3D(world, null, mats) builds nothing; with a chunk manager every tile with a road
//     goes in as one group on the 'roads' layer (at most 5 meshes, the materials shared by every tile), drawn
//     exactly while its terrain shows the fine grid (terrain3d LOD0_R), every bridge on its own layer with its
//     box; a warm build stays within 600 ms (about 150 ms on a quiet M1).
//  2. Junctions: every node with two ends or more has a mesh, meshed in rings round a centre it can see (at
//     most 2 ear-clipped; none today), and the mesh covers its node.
//  3. No gaps: every carriageway cell of SURF (ROAD) near a junction or along an edge is under an asphalt
//     surface (ribbon, junction or deck), within 0.3 m.
//  4. No z-fighting: no two top surfaces (asphalt, sidewalk tops) cover the same point within 5 cm of height,
//     and no two pieces of paint overlap.
//  5. On the ground: the asphalt stands at least 5 cm over the terrain mesh at every vertex on land, and the
//     other way round no terrain vertex comes within 5 cm of an asphalt or sidewalk top over it; where GROUND
//     is road surface the asphalt is within 6 cm of it at 99% of vertices (cars sit on what they see); no
//     ribbon's asphalt rolls more than 0.25 m over its design surface (past that a kerb wall stands).
//  6. Paint: every paint vertex lies LIFT over the surface under it, and between its vertices (the middles of
//     its pieces and their sides) it stays over that surface; solid lines run on across every tile border they
//     cross (paint within 0.6 m of the border on both sides).
//  7. Bridges: the five road bridges are built over their deck spans; the pylon's head is 62 m over the sea;
//     piers reach the bed; the abutment patches placeProps blocks are under stone revetments (92% of their
//     blocked metres) that never stand over the deck's height.
//  8. The bench views: what the roads add to the city's draw calls (camera + shadow) stays within 40, and
//     their triangles within 250 k.
// Exits 1 if any check fails.
import { src, check, section, note, done, quiet } from './s3b_env.mjs';
globalThis.KC_WORLD = 'v2';
const THREE = await import('three');
const D = await import('./s3b_draws.mjs');
const W = await import(src('src/world.js'));
W.generate();
const R = await import(src('src/3d/roads3d.js'));
const T3 = await import(src('src/3d/terrain3d.js'));
const LOW_TIER = process.env.S3B_LOW === '1';
const PX = 16;
const G = W.grids, [VW, VH] = G.dims.terrain, [SW, SH] = G.dims.surf;

// ---------- 1. the contract ----------

section('contract');
check('buildRoads3D(world, null, mats) builds nothing', R.buildRoads3D(W, null, null) === undefined);
const added = [];
const fakeChunks = { add(obj, o) { added.push({ obj, o }); return {}; } };
const dirtMat = new THREE.MeshLambertMaterial();
const mats = { terrain: { lod0: dirtMat }, night() {} };
const t0 = performance.now();
const roads = await quiet(() => R.buildRoads3D(W, fakeChunks, mats));
const ms = performance.now() - t0;
const st = roads.stats();
note(`built in ${ms.toFixed(0)} ms (cold): ${JSON.stringify(st)}`);
{
  // The build again, warm (node's first run is mostly compiling), best of three. About 120 ms on a quiet M1;
  // the check only catches a gross slip, since other work on the machine can triple it.
  let best = Infinity;
  for (let k = 0; k < 3; k++) { const t1 = performance.now(); await quiet(() => R.buildRoads3D(W, { add() {} }, mats)); best = Math.min(best, performance.now() - t1); }
  note(`built again in ${best.toFixed(0)} ms (warm, best of 3)`);
  check('built within 600 ms warm (node)', best < 600, `${best.toFixed(0)} ms`);
}
const tileAdds = added.filter(a => a.o.layer === 'roads'), bridgeAdds = added.filter(a => a.o.layer === 'bridges');
const meshesOf = (t) => [...t.group.children, t.paint].filter(Boolean);
check('every tile\'s meshes are on the roads layer with its tile key (the paint on its own, out to 150 m)',
  tileAdds.length === roads.tiles.reduce((n, t) => n + (t.group.children.length ? 1 : 0) + (t.paint ? 1 : 0), 0) && tileAdds.every(a => /^\d+,\d+$/.test(a.o.tile))
  && tileAdds.filter(a => a.obj.isMesh).every(a => a.o.far === 150) && tileAdds.filter(a => !a.obj.isMesh).every(a => a.o.far === T3.LOD0_R));
check('the bridges are one group on the bridges layer with a box', bridgeAdds.length === 1 && bridgeAdds[0].o.box.every(Number.isFinite) && bridgeAdds[0].obj.children.length <= 2);
const matSet = new Set();
let most = 0;
for (const t of roads.tiles) { most = Math.max(most, meshesOf(t).length); for (const m of meshesOf(t)) matSet.add(m.material); }
check('at most 5 meshes (draw calls) a tile', most <= 5, String(most));
check('the tiles share at most 5 materials between them', matSet.size <= 5, String(matSet.size));
const casts = new Set([roads.materials.concrete, roads.materials.stone]);
check('only the concrete and the stone cast shadows', roads.tiles.every(t => meshesOf(t).every(m => m.castShadow === casts.has(m.material))));

// ---------- triangles of the drawn surfaces ----------

// every triangle of a set of meshes as [ax, ay, az, bx, by, bz, cx, cy, cz] (Float64Array, 9 a triangle)
function trianglesOf(meshes, keep = () => true) {
  const out = [];
  for (const m of meshes) {
    const P = m.geometry.attributes.position.array, N = m.geometry.attributes.normal.array, I = m.geometry.index.array;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t], b = I[t + 1], c = I[t + 2];
      const tri = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2], P[b * 3], P[b * 3 + 1], P[b * 3 + 2], P[c * 3], P[c * 3 + 1], P[c * 3 + 2]];
      if (keep(tri, N[a * 3 + 1])) out.push(tri);
    }
  }
  return out;
}
// a spatial hash of triangles (2 m cells) answering which triangles' XZ footprints contain a point
function triHash(tris, cell = 2) {
  const map = new Map(), key = (i, j) => i * 100000 + j;
  tris.forEach((t, n) => {
    const i0 = Math.floor(Math.min(t[0], t[3], t[6]) / cell), i1 = Math.floor(Math.max(t[0], t[3], t[6]) / cell);
    const j0 = Math.floor(Math.min(t[2], t[5], t[8]) / cell), j1 = Math.floor(Math.max(t[2], t[5], t[8]) / cell);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const k = key(i, j); let a = map.get(k); if (!a) map.set(k, a = []); a.push(n); }
  });
  return {
    // heights of every triangle over (x, z) (within tol of its footprint)
    at(x, z, tol = 0, out = []) {
      out.length = 0;
      for (const n of map.get(key(Math.floor(x / cell), Math.floor(z / cell))) || []) {
        const t = tris[n], y = baryY(t, x, z, tol);
        if (!Number.isNaN(y)) out.push([y, n]);
      }
      return out;
    },
  };
}
function baryY(t, x, z, tol) {
  const [ax, ay, az, bx, by, bz, cx, cy, cz] = t;
  const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(d) < 1e-12) return NaN;
  const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, w = 1 - u - v;
  if (u >= -1e-6 && v >= -1e-6 && w >= -1e-6) return u * ay + v * by + w * cy;
  if (tol > 0) {
    // near an edge of the triangle: the distance from the point to its outline
    const seg = (px, pz, qx, qz) => { const dx = qx - px, dz = qz - pz, L2 = dx * dx + dz * dz, f = L2 ? Math.max(0, Math.min(1, ((x - px) * dx + (z - pz) * dz) / L2)) : 0; return Math.hypot(px + dx * f - x, pz + dz * f - z); };
    if (Math.min(seg(ax, az, bx, bz), seg(bx, bz, cx, cz), seg(cx, cz, ax, az)) <= tol) return (ay + by + cy) / 3;
  }
  return NaN;
}

const tileMeshes = roads.tiles.flatMap(meshesOf);
const bridgeMeshes = roads.bridges[0]?.group ? roads.bridges[0].group.children : [];
const asphaltMeshes = [...tileMeshes, ...bridgeMeshes].filter(m => m.material === roads.materials.asphalt);
const dirtMeshes = tileMeshes.filter(m => m.material === dirtMat);
const asphaltTris = trianglesOf([...asphaltMeshes, ...dirtMeshes]);
const asphaltHash = triHash(asphaltTris);
// sidewalk and median tops: concrete triangles facing up, in tile meshes
const walkTris = trianglesOf(tileMeshes.filter(m => m.material === roads.materials.concrete), (t) => faceN(t)[1] > 0.97);
const coverHash = triHash([...asphaltTris, ...walkTris]);
function faceN(t) {
  const ux = t[3] - t[0], uy = t[4] - t[1], uz = t[5] - t[2], vx = t[6] - t[0], vy = t[7] - t[1], vz = t[8] - t[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}
const terrainY = (x, z) => {
  const fx = Math.min(Math.max(x / 2, 0), VW - 1), fz = Math.min(Math.max(z / 2, 0), VH - 1), H = G.terrain;
  const i = Math.min(Math.floor(fx), VW - 2), j = Math.min(Math.floor(fz), VH - 2), u = fx - i, w = fz - j, k = j * VW + i;
  if (u + w <= 1) return H[k] + (H[k + 1] - H[k]) * u + (H[k + VW] - H[k]) * w;
  return H[k + VW + 1] + (H[k + VW] - H[k + VW + 1]) * (1 - u) + (H[k + 1] - H[k + VW + 1]) * (1 - w);
};
const groundBil = (x, z) => {
  const fx = x / 2, fz = z / 2, i = Math.floor(fx), j = Math.floor(fz), u = fx - i, w = fz - j, d = G.ground, k = j * VW + i;
  return (d[k] * (1 - u) + d[k + 1] * u) * (1 - w) + (d[k + VW] * (1 - u) + d[k + VW + 1] * u) * w;
};
const solid = (x, z) => {
  const i = Math.floor(x / 2), j = Math.floor(z / 2), k = j * VW + i;
  return [k, k + 1, k + VW, k + VW + 1].every(q => { const d = G.ground[q] - G.terrain[q]; return d > 0.15 && d < 0.25; });
};
const kindAt = (x, z) => G.surf[Math.floor(z) * SW + Math.floor(x)] & 15;

// ---------- 2. junctions ----------

section('junctions');
const multi = W.roads.nodes.filter(N => N.ends.length >= 2);
const meshed = roads.junctions.filter(J => J.verts?.length);
check(`every node with 2+ ends has a junction mesh (${multi.length})`, meshed.length === multi.length, `${meshed.length}`);
const fb = roads.junctions.filter(J => J.fallback);
check('at most 2 junctions ear-clipped (the rest in rings round their centre)', fb.length <= 2, fb.map(J => J.N.id).join(','));
note(`ear-clipped: ${fb.map(J => `node ${J.N.id} (${J.x.toFixed(0)},${J.z.toFixed(0)})`).join(', ') || 'none'}`);
const notCovering = meshed.filter(J => !asphaltHash.at(J.x, J.z).length);
check('every junction mesh covers its node', !notCovering.length, notCovering.map(J => J.N.id).join(','));
{
  const rings = W.roads.nodes.filter(N => N.kind === 'ring').length, xs = W.roads.nodes.filter(N => N.kind === 'X').length;
  note(`${multi.length} junctions: ${rings} ring entries, ${xs} X nodes, ${multi.filter(N => N.kind === 'T').length} T's`);
}

// ---------- 3. coverage ----------

section('no gaps: SURF carriageway under asphalt');
{
  // every ROAD (and DIRT track) cell centre within 35 m of a junction node, and every 4th along every edge
  let n = 0, miss = 0;
  const misses = [];
  const test = (x, z, why) => {
    const k = kindAt(x, z);
    if (k !== 0 && k !== 8) return;          // ROAD, DIRT
    if (k === 8 && W.roads.edges.every(e => e.cls !== 'dirt')) return;
    n++;
    if (coverHash.at(x, z, 0.3).length) return;
    miss++;
    if (misses.length < 12) misses.push(`${why} (${x.toFixed(1)},${z.toFixed(1)})`);
  };
  for (const N of multi) {
    const cx = N.x / PX, cz = N.y / PX;
    for (let j = Math.floor(cz - 35); j <= cz + 35; j++) for (let i = Math.floor(cx - 35); i <= cx + 35; i++) test(i + 0.5, j + 0.5, `node ${N.id}`);
  }
  // along the edges, the cells beside the centre line out to the carriageway's edge less 0.4 m
  for (const e of W.roads.edges) {
    const hw = e.halfW / PX - 0.4;
    for (let k = 0; k < e.n; k += 4) for (let o = -hw; o <= hw; o += 1) {
      const x = e.x[k] / PX - e.ty[k] * o, z = e.y[k] / PX + e.tx[k] * o;
      test(Math.floor(x) + 0.5, Math.floor(z) + 0.5, `edge ${e.id} ${e.road}`);
    }
  }
  note(`${n} carriageway cells tested, ${miss} not under asphalt`);
  check('every carriageway cell is under asphalt or a median island (within 0.3 m)', miss <= Math.max(3, n * 0.0005), misses.join('; '));
}

// ---------- 4. z-fighting ----------

section('no z-fighting');
{
  // the centroid of every top triangle: any other top surface over it within 5 cm of height is a fight
  const tops = [...asphaltTris, ...walkTris], hash = triHash(tops);
  let fights = 0;
  const where = [], buf = [];
  // (a jump ramp and its berms stand on the road and sidewalks they rise from)
  const jumps = W.activities.filter(a => a.type === 'jump').map(a => [a.x / PX, a.y / PX, a.run / PX + 8]);
  tops.forEach((t, n) => {
    const x = (t[0] + t[3] + t[6]) / 3, z = (t[2] + t[5] + t[8]) / 3, y = (t[1] + t[4] + t[7]) / 3;
    if (jumps.some(([jx, jz, r]) => Math.hypot(x - jx, z - jz) < r)) return;
    // skip slivers (their centroid sits on their own edges)
    if (Math.abs((t[3] - t[0]) * (t[8] - t[2]) - (t[5] - t[2]) * (t[6] - t[0])) < 0.02) return;
    for (const [oy, m] of hash.at(x, z, 0, buf)) {
      if (m === n || Math.abs(oy - y) > 0.05) continue;
      // a neighbour sharing this point only along an edge is no fight: the point must be inside it by 2 cm
      if (Number.isNaN(baryY(shrink(tops[m], 0.02), x, z, 0))) continue;
      fights++;
      if (where.length < 8) where.push(`(${x.toFixed(1)},${z.toFixed(1)}) y ${y.toFixed(2)}/${oy.toFixed(2)}`);
      break;
    }
  });
  note(`${tops.length} top triangles`);
  check('no two top surfaces at the same height over the same point', fights === 0, `${fights}: ${where.join('; ')}`);
  // nor two pieces of paint (a line over a bar, a dash over a crossing): both 2 cm up, they would flicker
  const paint = trianglesOf(tileMeshes.filter(m => m.material === roads.materials.paint)), ph = triHash(paint);
  let overlaps = 0;
  const at2 = [];
  paint.forEach((t, n) => {
    const x = (t[0] + t[3] + t[6]) / 3, z = (t[2] + t[5] + t[8]) / 3, y = (t[1] + t[4] + t[7]) / 3;
    if (Math.abs((t[3] - t[0]) * (t[8] - t[2]) - (t[5] - t[2]) * (t[6] - t[0])) < 0.005) return;
    for (const [oy, m] of ph.at(x, z, 0, buf)) {
      if (m === n || Math.abs(oy - y) > 0.03 || Number.isNaN(baryY(shrink(paint[m], 0.02), x, z, 0))) continue;
      overlaps++;
      if (at2.length < 8) at2.push(`(${x.toFixed(1)},${z.toFixed(1)})`);
      break;
    }
  });
  check('no two pieces of paint over the same point', overlaps === 0, `${overlaps}: ${at2.join('; ')}`);
}
// a triangle pulled in by d metres toward its centroid (XZ)
function shrink(t, d) {
  const cx = (t[0] + t[3] + t[6]) / 3, cz = (t[2] + t[5] + t[8]) / 3, o = t.slice();
  for (let k = 0; k < 9; k += 3) {
    const dx = t[k] - cx, dz = t[k + 2] - cz, l = Math.hypot(dx, dz) || 1, f = Math.max(0, (l - d) / l);
    o[k] = cx + dx * f; o[k + 2] = cz + dz * f;
  }
  return o;
}

// ---------- 5. on the ground ----------

section('asphalt over the terrain, and where the physics has it');
{
  // the jump ramps are stamped into GROUND and TERRAIN over the road (their own mesh stands on them)
  const jumps = W.activities.filter(a => a.type === 'jump').map(a => [a.x / PX, a.y / PX, a.run / PX + 3]);
  const onJump = (x, z) => jumps.some(([jx, jz, r]) => Math.hypot(x - jx, z - jz) < r);
  let below = 0, worst = 0, n = 0;
  const where = [], dev = [];
  for (const m of tileMeshes.filter(q => q.material === roads.materials.asphalt || q.material === dirtMat)) {
    const P = m.geometry.attributes.position.array, splat = m.geometry.attributes.splat?.array;
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2], t = terrainY(x, z);
      // (a dirt track's verges run down onto the terrain: only its track counts)
      if (onJump(x, z) || (splat && splat[(i / 3) * 4 + 2] < 255)) continue;
      n++;
      if (t > y - 0.05) { below++; if (t - y > worst) worst = t - y; where.push([t - y, `(${x.toFixed(1)},${z.toFixed(1)}) ${(t - y).toFixed(2)}`]); }
      if (solid(x, z)) dev.push(Math.abs(groundBil(x, z) - y));
    }
  }
  dev.sort((a, b) => a - b);
  const p99 = dev[Math.floor(dev.length * 0.99)], p50 = dev[dev.length >> 1];
  note(`${n} asphalt vertices; terrain within 5 cm of the surface at ${below} (worst ${worst.toFixed(2)} m above it); GROUND deviation p50 ${(p50 * 100).toFixed(1)} cm, p99 ${(p99 * 100).toFixed(1)} cm, max ${(dev[dev.length - 1] * 100).toFixed(0)} cm`);
  where.sort((a, b) => b[0] - a[0]);
  check('the terrain stays 5 cm under the asphalt at every vertex', below <= Math.ceil(n * 0.0005), `${below}: ${where.slice(0, 10).map(w => w[1]).join('; ')}`);
  check('the asphalt is within 6 cm of GROUND at 99% of its road-surface vertices', p99 <= 0.06, `${(p99 * 100).toFixed(1)} cm`);

  // The other way round: every 2 m terrain vertex under an asphalt top (ribbons, junctions, decks) or a sidewalk
  // slab stays 5 cm under it, so no grass shows through between the surface's own vertices. (A verge running
  // down to the terrain may dip under a bump of it: the terrain shows there, which is what a verge is.)
  const flat = trianglesOf([...tileMeshes, ...bridgeMeshes].filter(m => m.material === roads.materials.asphalt));
  const walkCol = new THREE.Color('#fff3e2'), slabs = [];
  for (const m of tileMeshes.filter(q => q.material === roads.materials.concrete)) {
    const P = m.geometry.attributes.position.array, C = m.geometry.attributes.color.array, I = m.geometry.index.array;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      if (Math.abs(C[a] - walkCol.r) + Math.abs(C[a + 1] - walkCol.g) + Math.abs(C[a + 2] - walkCol.b) > 0.01) continue;
      const tri = [P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]];
      if (faceN(tri)[1] > 0.9) slabs.push(tri);
    }
  }
  let under = 0, through = 0;
  const poke = [];
  for (const [list, what] of [[flat, 'asphalt'], [slabs, 'sidewalk']]) for (const t of list) {
    const i0 = Math.ceil(Math.min(t[0], t[3], t[6]) / 2), i1 = Math.floor(Math.max(t[0], t[3], t[6]) / 2);
    const j0 = Math.ceil(Math.min(t[2], t[5], t[8]) / 2), j1 = Math.floor(Math.max(t[2], t[5], t[8]) / 2);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const y = baryY(t, i * 2, j * 2, 0);
      if (Number.isNaN(y) || onJump(i * 2, j * 2)) continue;
      under++;
      const d = G.terrain[j * VW + i] - (y - 0.05);
      if (d > 0) { through++; poke.push([d, `${what} (${i * 2},${j * 2}) ${(d - 0.05).toFixed(2)}`]); }
    }
  }
  poke.sort((a, b) => b[0] - a[0]);
  note(`${under} terrain vertices under asphalt or sidewalk tops, ${through} within 5 cm of the surface or over it`);
  check('no terrain vertex comes within 5 cm of an asphalt or sidewalk top over it', through <= 3, poke.slice(0, 8).map(w => w[1]).join('; '));

  // No ribbon rolls its asphalt more than 0.25 m over its design surface (a vertex within its edge's
  // carriageway, between its mouths, off the jump ramps).
  let rolled = 0, most = 0;
  const high = [];
  const edgeAt = new Map();
  for (const E of roads.ctx.edges) for (let k = 0; k < E.n; k++) {
    const key = Math.floor(E.X[k] / 8) * 4096 + Math.floor(E.Z[k] / 8);
    (edgeAt.get(key) || edgeAt.set(key, []).get(key)).push(E, k);
  }
  for (const m of tileMeshes.filter(q => q.material === roads.materials.asphalt)) {
    const P = m.geometry.attributes.position.array;
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      if (onJump(x, z)) continue;
      let best = null;
      for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
        const list = edgeAt.get((Math.floor(x / 8) + a) * 4096 + Math.floor(z / 8) + b) || [];
        for (let q = 0; q < list.length; q += 2) {
          const E = list[q], k = list[q + 1], along = (x - E.X[k]) * E.TX[k] + (z - E.Z[k]) * E.TZ[k];
          if (Math.abs(along) > 1.2 || E.S[k] < E.mouthA - 0.5 || E.S[k] > E.len - E.mouthB + 0.5) continue;
          const o = (x - E.X[k]) * -E.TZ[k] + (z - E.Z[k]) * E.TX[k];
          if (Math.abs(o) > E.hw + 0.02 || (best && Math.abs(along) >= best.along)) continue;
          best = { along: Math.abs(along), up: y - (E.Y[k] + along * (E.Y[Math.min(E.n - 1, k + 1)] - E.Y[k]) / Math.max(1e-6, E.S[Math.min(E.n - 1, k + 1)] - E.S[k]) - o * E.TB[k]) };
        }
      }
      if (!best) continue;
      most = Math.max(most, best.up);
      if (best.up > 0.25) { rolled++; if (high.length < 8) high.push(`(${x.toFixed(1)},${z.toFixed(1)}) ${best.up.toFixed(2)}`); }
    }
  }
  note(`the most a ribbon's asphalt stands over its design surface: ${most.toFixed(2)} m`);
  check('no ribbon\'s asphalt rolls more than 0.25 m over its design surface', rolled === 0, `${rolled}: ${high.join('; ')}`);
}

// ---------- 6. paint ----------

section('paint');
{
  const paint = tileMeshes.filter(m => m.material === roads.materials.paint);
  const tops = triHash([...asphaltTris, ...trianglesOf(bridgeMeshes.filter(m => m.material === roads.materials.asphalt))]);
  let n = 0, off = 0, orphan = 0;
  const where = [], buf = [];
  for (const m of paint) {
    const P = m.geometry.attributes.position.array;
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      n++;
      const under = tops.at(x, z, 0.05, buf);
      if (!under.length) { orphan++; continue; }
      const best = under.reduce((a, b) => (Math.abs(b[0] + 0.02 - y) < Math.abs(a[0] + 0.02 - y) ? b : a));
      if (Math.abs(best[0] + 0.02 - y) > 0.012) { off++; if (where.length < 8) where.push(`(${x.toFixed(1)},${z.toFixed(1)}) ${(y - best[0]).toFixed(3)}`); }
    }
  }
  note(`${n} paint vertices, ${orphan} over no asphalt, ${off} more than 1.2 cm off LIFT`);
  check('paint lies 2 cm over the surface under it (within 1.2 cm)', off <= Math.ceil(n * 0.002), where.join('; '));
  check('paint lies over asphalt', orphan <= Math.ceil(n * 0.002), String(orphan));
  // and between its vertices: a piece's middle and the middles of its sides stay over the surface under them
  // (on a junction's bent mesh the paint is cut finer, so it never sinks into it)
  let mids = 0, sunk = 0;
  const sunkAt = [];
  for (const m of paint) {
    const P = m.geometry.attributes.position.array, I = m.geometry.index.array;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const pts = [[(P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3]];
      for (const [p, q] of [[a, b], [b, c], [c, a]]) pts.push([(P[p] + P[q]) / 2, (P[p + 1] + P[q + 1]) / 2, (P[p + 2] + P[q + 2]) / 2]);
      for (const [x, y, z] of pts) {
        const under = tops.at(x, z, 0, buf).filter(([v]) => v < y + 0.5);
        if (!under.length) continue;
        mids++;
        const top = Math.max(...under.map(([v]) => v));
        if (y < top + 0.005) { sunk++; if (sunkAt.length < 8) sunkAt.push(`(${x.toFixed(1)},${z.toFixed(1)}) ${((y - top) * 100).toFixed(1)} cm`); }
      }
    }
  }
  note(`${mids} paint mid-points, ${sunk} within 5 mm of the surface or under it`);
  check('paint stays over the surface between its vertices', sunk <= Math.ceil(mids * 0.0005), sunkAt.join('; '));
  // solid lines across tile borders: paint on both sides of every border a painted edge crosses
  const byTile = new Map();
  for (const t of roads.tiles) { if (t.paint) byTile.set(t.key, t.paint.geometry.attributes.position.array); }
  const near = (key, x, z, r) => { const P = byTile.get(key); if (!P) return false; for (let i = 0; i < P.length; i += 3) if (Math.hypot(P[i] - x, P[i + 2] - z) < r) return true; return false; };
  let borders = 0, broken = 0;
  const bad = [];
  for (const E of roads.ctx.edges) {
    if (!['hwy', 'ave', 'coast', 'country', 'switch', 'ring'].includes(E.cls)) continue;
    for (let k = 0; k + 1 < E.n; k++) {
      const ta = `${Math.floor(E.X[k] / 256)},${Math.floor(E.Z[k] / 256)}`, tb = `${Math.floor(E.X[k + 1] / 256)},${Math.floor(E.Z[k + 1] / 256)}`;
      const s = (E.S[k] + E.S[k + 1]) / 2;
      if (ta === tb || s < E.mouthA + 3 || s > E.len - E.mouthB - 3) continue;
      borders++;
      const x = (E.X[k] + E.X[k + 1]) / 2, z = (E.Z[k] + E.Z[k + 1]) / 2;
      if (!near(ta, x, z, E.hw + 1.2) || !near(tb, x, z, E.hw + 1.2)) { broken++; if (bad.length < 6) bad.push(`${E.road} (${x.toFixed(0)},${z.toFixed(0)})`); }
    }
  }
  note(`${borders} tile borders crossed by painted roads`);
  check('solid lines run on across every tile border', broken === 0, bad.join('; '));
}

// ---------- 7. bridges ----------

section('bridges');
{
  const ids = roads.bridges.map(b => b.id).sort().join(',');
  check('the five road bridges are built (the pier is coast3d\'s)', ids === 'macarthur_east,macarthur_west,north_causeway,rickenbacker,venetian', ids);
  // the deck surface over every deck span's middle
  const deckHash = triHash(trianglesOf(bridgeMeshes.filter(m => m.material === roads.materials.asphalt)));
  let spans = 0, covered = 0;
  for (const E of roads.ctx.edges) for (const [a, b] of E.deck) {
    spans++;
    const s = (a + b) / 2, k = E.S.findIndex(v => v >= s);
    if (deckHash.at(E.X[k], E.Z[k]).some(([y]) => Math.abs(y - E.Y[k]) < 0.1)) covered++;
  }
  check('every deck span has its deck at the road\'s height', covered === spans, `${covered}/${spans}`);
  const cable = roads.bridges.find(b => b.id === 'north_causeway');
  let top = -Infinity;
  if (cable) for (let i = 0; i < cable.stone.n; i++) top = Math.max(top, cable.stone.P[i * 3 + 1]);
  check('the causeway pylon\'s head stands 62 m over the sea', Math.abs(top - (W.SEA_LEVEL + 62)) < 0.5, top.toFixed(1));
  note(`bridge triangles: ${roads.bridges.map(b => `${b.id} ${((b.asphalt.m + b.stone.m) / 3).toFixed(0)}`).join(', ')}`);
  // The abutment patches placeProps blocks (GROUND held at the deck's height over ground half a metre or more
  // lower): every blocked metre of one, outside the deck and its parapets, is under a stone revetment that
  // shows (not under the terrain), and nothing of the revetments stands over the deck's height there.
  // (a patch's cells between the kerb and the parapet's line lie under the road's own verge or carriageway)
  const stone = trianglesOf(tileMeshes.filter(m => m.material !== roads.materials.paint), (t) => faceN(t)[1] > 0.2), sh = triHash(stone);
  const bridgeHash = triHash(trianglesOf(bridgeMeshes));
  let cells = 0, under = 0, over = 0;
  const bare = [];
  for (const d of W.deco.filter(q => q.list === 'fences' && q.kind === 'abutment')) {
    const ca = Math.cos(d.a), sa = Math.sin(d.a), cx = d.x / PX, cz = d.y / PX;
    for (let u = -d.w / 2 + 0.5; u < d.w / 2; u += 1) for (let v = -d.d / 2 + 0.5; v < d.d / 2; v += 1) {
      const x = cx + ca * u - sa * v, z = cz + sa * u + ca * v;
      if (groundBil(x, z) - terrainY(x, z) <= 0.5 || bridgeHash.at(x, z, 0.3).length) continue;
      cells++;
      const ys = sh.at(x, z, 0.1);
      if (ys.some(([y]) => y >= terrainY(x, z) - 0.02)) under++; else if (bare.length < 8) bare.push(`(${x.toFixed(1)},${z.toFixed(1)})`);
      if (ys.some(([y]) => y > d.top + 0.05)) over++;
    }
  }
  note(`${cells} metres of abutment patches outside the decks, ${under} under a revetment`);
  // (a few cells stay bare where the deck's banked plane is held out over a bank that stands above the road
  // itself: a revetment hangs from under the road surface and cannot rise over it)
  check('the abutment patches are under stone revetments (92%)', under >= cells * 0.92, bare.join('; '));
  check('no revetment stands over its deck\'s height', over === 0, String(over));
}

// ---------- 8. the bench views ----------

section('bench views: what the roads add');
{
  const CITY = await import(src('src/3d/city.js'));
  const scene = new THREE.Scene();
  const sun = D.makeSun(LOW_TIER ? 42 : 64);
  scene.add(sun, sun.target);
  const city = await quiet(() => CITY.buildCity(scene));
  await new Promise((r) => setTimeout(r, 2500));
  const roadGroups = [];
  city.group.traverse(o => { if (/^(roads |paint |bridges$)/.test(o.name)) roadGroups.push(o); });
  check('the city carries the road tiles and the bridges', roadGroups.length >= roads.tiles.length + 1, String(roadGroups.length));
  const camera = new THREE.PerspectiveCamera(62, 1440 / 800, 0.15, LOW_TIER ? 1200 : 2600);
  const opts = { groundY: W.groundY, occluderTop: CITY.occluderTop };
  for (const v of W.benchViews) {
    const focus = D.placeCamera(camera, v, opts);
    D.placeSun(sun, 13 * 60, focus);
    for (let k = 0; k < 3; k++) city.update(camera, k * 0.1);
    const count = () => { const c = D.cameraPass(scene, camera), s = D.shadowPass(scene, camera, sun); return { calls: c.calls + s.calls, tris: c.tris + s.tris }; };
    const all = count();
    const vis = roadGroups.map(g => g.visible);
    roadGroups.forEach(g => { g.visible = false; });
    const without = count();
    roadGroups.forEach((g, i) => { g.visible = vis[i]; });
    const dc = all.calls - without.calls, dt = all.tris - without.tris;
    note(`${v.name}: city ${all.calls} calls ${(all.tris / 1e3).toFixed(0)} k tris, of which roads ${dc} calls ${(dt / 1e3).toFixed(0)} k tris`);
    check(`${v.name}: the roads add ${dc} calls (camera + shadow) within 40`, dc <= 40);
    check(`${v.name}: and ${(dt / 1e3).toFixed(0)} k triangles within 250 k`, dt <= 250e3);
  }
}

done();
