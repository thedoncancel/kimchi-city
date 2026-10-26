// The classic grid city in 3D: today's builders, moved here so the src/3d/city.js facade can pick this
// renderer or the Kimchi Key v2 one (docs/map-v2-spec.md §7). It only ever builds on the grid world.
//
// The town is small (344 m), so it is still built in one go when the game starts, but what is built is cut
// into the chunk manager's 128 m cells (src/3d/chunks.js, spec §11.1): the ground, the buildings and the
// street life. The manager decides per cell what casts shadows (only cells within 110 m of the shadow focus,
// 80 m on the low tier). Everything is drawn at any distance, the street life too (see STREET_FAR).
// The ground and building meshes stay one draw call each: their triangles are grouped by cell in the index,
// and each pass draws one run of it (cellMesh). The street life is a mesh per 64 m quarter of a cell
// (cellPieces).
import * as THREE from 'three';
import { matte } from './quality.js';
import { T, P, N, SIZE, ROAD, WALK, GRASS, BUILD, LOT, PLAZA, WATER, tileAt, groundY, buildings, trees, lamps, deco, places, palms, hash } from '../world.js';
import { Builder, mat4, col } from './geo.js';
import * as TX from './textures.js';
import { makePalmField } from './palms3d.js';
import { loadAssetPack, makeScatter } from './scatter3d.js';
import { makeChunkManager, CELL, cellKey, makeBuckets, BUCKET, castFirst, setCopies, uploadFirst } from './chunks.js';
import { LOW } from './quality.js';

// The facade exports S, MAP and surfaceY for everyone else; these are the same values, kept here because
// the facade imports this module (reading them back from it would be a cycle).
const S = 1 / 16;        // metres per sim pixel
const TM = T * S;        // one tile = 4 m
const MAP = SIZE * S;    // 344 m
// ground height (m) per tile kind, for the ground mesh; the same table as the grid world's groundY
const H = { [ROAD]: 0, [LOT]: 0.04, [WALK]: 0.16, [GRASS]: 0.13, [PLAZA]: 0.16, [BUILD]: 0.16, [WATER]: -0.14 };
const OUT = -0.6;
const BASE = 0.16;

const surfaceY = groundY;   // height of the walkable surface (m) at a sim point
// tallest thing on each tile, so the camera can avoid buildings
export const heightGrid = new Float32Array(N * N);

// What a camera or a bullet at (xm, zm) metres cannot see through: the top of the building on that tile, or
// the ground itself. Outside the town there are no buildings, only the ground (which never blocks there).
export function occluderTop(xm, zm) {
  const g = surfaceY(xm / S, zm / S);
  const ix = Math.floor(xm / TM), iz = Math.floor(zm / TM);
  if (ix < 0 || iz < 0 || ix >= N || iz >= N) return g;
  return Math.max(heightGrid[iz * N + ix], g);
}

// The n lamp heads nearest to (xm, zm) metres, nearest first, written into out (which is returned). Ties keep
// lamp order, the same as sorting every lamp by distance. The lamps sit in 64 m buckets: the search looks
// at the buckets within r of the point and doubles r until the n nearest it found are all within r, so no
// lamp it skipped could be nearer. Once r reaches the far corner of the buckets it has seen every lamp, so
// the search always ends.
const nearD = [], nearI = [], nearLists = [];
let lampIndex = null;   // lampHeads in buckets, as { x, z, h, i } (i: the lamp's place in lampHeads)
export function nearestLamps(xm, zm, n, out = []) {
  out.length = 0;
  if (!(n > 0) || !lampIndex) return out;
  // A point that is not a number (NaN or infinite, from a physics or AI bug) has no nearest lamps: the lights
  // go dark (main3d turns off a light with no lamp) instead of the search running for ever and freezing the tab.
  if (!Number.isFinite(xm) || !Number.isFinite(zm)) return out;
  const B = lampIndex;
  const reach = Math.hypot(Math.max(xm - B.x0, B.x0 + B.cols * B.size - xm), Math.max(zm - B.z0, B.z0 + B.rows * B.size - zm));
  for (let r = BUCKET; ; r *= 2) {
    out.length = 0;
    let seen = 0;
    for (const list of B.near(xm, zm, r, nearLists)) {
      seen += list.length;
      for (const l of list) keepNearest(out, n, (l.x - xm) ** 2 + (l.z - zm) ** 2, l.i, l.h);
    }
    if (r >= reach || seen === lampHeads.length || (out.length === n && nearD[n - 1] <= r * r)) return out;
  }
}
// put lamp i (d: squared distance) into the n nearest so far, kept in order of distance, then lamp order
function keepNearest(out, n, d, i, h) {
  const len = out.length;
  if (len === n && (d > nearD[n - 1] || (d === nearD[n - 1] && i > nearI[n - 1]))) return;
  let k = Math.min(len, n - 1);
  while (k > 0 && (nearD[k - 1] > d || (nearD[k - 1] === d && nearI[k - 1] > i))) {
    nearD[k] = nearD[k - 1]; nearI[k] = nearI[k - 1]; out[k] = out[k - 1]; k--;
  }
  nearD[k] = d; nearI[k] = i; out[k] = h;
}

const lambert = (o) => matte(o);
const night = [];   // [material, prop, dayValue, nightValue]
const onNight = (m, prop, d, n) => night.push([m, prop, d, n]);

export function buildCity(scene) {
  const group = new THREE.Group();
  group.name = 'city';
  // the city's chunk manager; objects go into the group here, so it is given no scene of its own
  chunks = makeChunkManager(null, { castR: CAST_R, layers: { street: { far: STREET_FAR } } });
  slots.clear(); cut.length = 0;
  buildGround(group);
  buildBuildings(group);
  buildTrees(group);
  buildLamps(group);
  buildPark(group);
  buildCoast(group);
  buildPalms(group);
  buildJet(group);
  buildMarina(group);
  buildBillboards(group);
  buildStreetLife(group);
  scene.add(group);
  // swap the simple trees and palms for the Blender palms once they load
  let field = null;
  makePalmField(group, palmSpots()).then((f) => {
    field = f;
    for (const m of [...oldPalms, crownMesh, trunkMesh]) if (m) { group.remove(m); uncut(m); }
    crownMesh = trunkMesh = crownCut = trunkCut = null;
  }).catch((e) => console.warn('palm models failed to load; keeping the simple ones', e));
  // grass, flowers, bushes, rocks and park trees from the CC0 asset packs
  let scatter = null;
  loadScatter(group).then((sct) => { scatter = sct; }).catch((e) => console.warn('asset packs failed to load', e));
  return {
    group,
    // The facade (city.js) runs chunks.update first, so the cells it just switched are drawn this frame.
    update(cam, t) {
      seaTime.value = t;
      for (const c of cut) if (c.dirty) c.sort();
      if (field) field.update(cam, t);
      if (scatter) scatter.update(cam, t);
    },
    setNight(k) {
      for (const [m, prop, d, n] of night) m[prop] = d + (n - d) * k;
    },
    chunks,
  };
}

// ---------- cells: the built city cut up for the chunk manager ----------

// m: cells cast shadows only this close to the shadow focus (spec §11.1: 110, on both tiers). With the sun
// high that keeps every shadow in the high tier's 128 m shadow box (sky.js): half its diagonal, 90 m, plus
// 20 m for a building reaching out of its cell; the low tier's 84 m box sits well inside it. (A smaller low
// tier radius saved shadow triangles the low tier no longer needs, and switched off buildings inside its box
// on the title screen, where the sun is about 2° up.) It does not cover a low sun in play: the box then
// stretches along the sun's direction, to half / sin(elevation) from the focus (about 230 m at 16° on the
// high tier), and a building or street cell further out than this casts no shadow until the player comes
// closer (game time before about 8:30 and after about 16:30). On the title, centred on the town, that leaves
// only a few beach props on the west sand.
const CAST_R = 110;
// m: how far from the camera the street life is drawn. The spec's 'street' layer stops at 180 m (chunks.js),
// but this town is only 344 m across: at 180 m the marina, the jet and the title orbit would lose the far
// third of the terraces, benches and umbrellas, and the grid must look as it did. So the grid draws it at
// any distance; three.js still culls each 64 m piece of it to the camera's and the shadow's view, and a
// piece casts only while its cell is within CAST_R.
const STREET_FAR = Infinity;
let chunks = null;         // the chunk manager of the built city
const slots = new Map();   // 'layer|cx,cz' -> the stand-in the chunk manager switches for that cell
const cut = [];            // the meshes cut into cells, each re-sorted when one of its cells switches
const ZERO16 = new THREE.Matrix4().makeScale(0, 0, 0).elements;

// A cell of one layer as the chunk manager sees it: a stand-in with visible and castShadow, which the manager
// sets by distance (drawn within the layer's far, casting within CAST_R of the shadow focus). Each switch
// marks the meshes with triangles in that cell for a re-sort. Layers: 'terrain' (the ground: always drawn,
// casts nothing) and 'shells' (buildings, trees, lamps, the park, the marina, the jet: always drawn).
function slotFor(layer, key) {
  const id = `${layer}|${key}`;
  let s = slots.get(id);
  if (s) return s;
  const users = [];
  let visible = true, castShadow = layer !== 'terrain';
  const touch = () => { for (const u of users) u.dirty = true; };
  s = {
    key, layer, users,
    get visible() { return visible; },
    set visible(v) { if (v !== visible) { visible = v; touch(); } },
    get castShadow() { return castShadow; },
    set castShadow(v) { if (v !== castShadow) { castShadow = v; touch(); } },
  };
  slots.set(id, s);
  chunks.add(s, { cell: key, layer });
  return s;
}

// Which cell each building's triangles go to: before each building every builder notes where it has got to,
// so a building stays whole in the cell of its centre (and its shadow cannot go missing at the edge of the
// shadow box while part of it is still in view). at(null) goes back to placing triangles by their centre.
function cellTags(builders) {
  const marks = new Map(builders.map((b) => [b, []]));   // builder -> [[first index, cell key or null]]
  return {
    at(key) { for (const [b, list] of marks) list.push([b.ni, key]); },
    of: (b) => marks.get(b) || null,
  };
}

// A Builder's triangles as one mesh, cut into 128 m cells (spec §11.1) without costing more draw calls: the
// triangles are grouped by cell in the index, and on every switch the cells are regrouped in the order
//   drawn, not casting | drawn and casting | casting, not drawn | neither
// so the cells the camera pass should draw are the first run of it and the cells that cast are the run that
// starts at the second group. The shadow pass draws that run (onBeforeShadow), every other pass the first.
// Inside a cell the triangles keep the order they were made in. The regrouping keeps the cells' current order
// (a cell that changes group lands next to the boundary it crossed), only cells that moved are rewritten,
// and only that span of the index is sent to the GPU.
function cellMesh(builder, material, { layer = 'shells', cast = false, receive = true, tags = null } = {}) {
  const geo = builder.build({ indexed: true });
  const src = geo.index.array;
  const parts = [...trianglesByCell(geo, tags?.of(builder))].map(([key, tris]) => {
    const idx = new src.constructor(tris.length * 3);
    tris.forEach((t, i) => { idx[i * 3] = src[t * 3]; idx[i * 3 + 1] = src[t * 3 + 1]; idx[i * 3 + 2] = src[t * 3 + 2]; });
    return { slot: slotFor(layer, key), idx, at: -1 };    // at: where the cell's run starts in the index now
  });
  const index = geo.index;
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = cast; mesh.receiveShadow = receive;
  mesh.matrixAutoUpdate = false;
  const run = { main: src.length, s0: 0, sN: cast ? src.length : 0 };
  const e = { mesh, dirty: true, state: -1, sort, run, parts };
  describeCells(mesh, parts, cast);
  if (cast) {
    mesh.onBeforeShadow = () => { geo.drawRange.start = run.s0; geo.drawRange.count = run.sN; };
    mesh.onAfterShadow = () => { geo.drawRange.start = 0; geo.drawRange.count = run.main; };
  }
  // 0 drawn only, 1 drawn and casting, 2 casting only, 3 neither
  const group = (p) => (p.slot.visible ? (cast && p.slot.castShadow ? 1 : 0) : (cast && p.slot.castShadow ? 2 : 3));
  let order = parts.slice(), next = [];
  const start = [0, 0, 0, 0];       // where each group starts in the index
  const span = { lo: 0, hi: 0 };     // the part of the index waiting to be sent
  function sort() {
    e.dirty = false;
    let state = 0;
    for (const p of parts) state = state * 4 + group(p);
    if (state === e.state) return;     // a switch that does not touch this mesh (say, casting on a non-caster)
    const first = e.state === -1;      // (before the mesh is ever drawn: three.js sends the whole index then)
    e.state = state;
    next.length = 0;
    let k = 0, lo = Infinity, hi = -Infinity;
    for (let g = 0; g < 4; g++) {
      start[g] = k;
      for (const p of order) {
        if (group(p) !== g) continue;
        next.push(p);
        if (p.at !== k) { index.array.set(p.idx, k); p.at = k; lo = Math.min(lo, k); hi = Math.max(hi, k + p.idx.length); }
        k += p.idx.length;
      }
    }
    [order, next] = [next, order];
    run.s0 = start[1]; run.main = start[2]; run.sN = start[3] - start[1];
    if (hi > lo && !first) send(lo, hi);
    geo.drawRange.start = 0; geo.drawRange.count = run.main;
    mesh.visible = run.main > 0 || run.sN > 0;
    if (cast) mesh.castShadow = run.sN > 0;
  }
  // Ask three.js to send index[lo, hi). Until it has (it empties updateRanges once sent; a hidden mesh is not
  // sent at all), the spans of later sorts are added to the one still waiting.
  function send(lo, hi) {
    if (index.updateRanges.length) { lo = Math.min(lo, span.lo); hi = Math.max(hi, span.hi); }
    span.lo = lo; span.hi = hi;
    index.clearUpdateRanges();
    index.addUpdateRange(lo, hi - lo);
    index.needsUpdate = true;
  }
  for (const p of parts) p.slot.users.push(e);
  cut.push(e);
  sort();
  return mesh;
}
// the same for a building part (the 'shells' layer, cast like the old meshes)
const shell = (b, mat, o = {}) => cellMesh(b, mat, { layer: 'shells', ...o });

// An indexed geometry's triangles by cell key, each list in the order the triangles were made: a triangle
// goes to the cell its building was tagged with (marks, from cellTags), else to the cell its centre is in
// (keyOf: cellKey, or pieceKey for the street life's quarter cells).
function trianglesByCell(geo, marks, keyOf = cellKey) {
  const src = geo.index.array, pos = geo.attributes.position.array, nt = src.length / 3;
  const byCell = new Map();
  for (let t = 0, m = -1; t < nt; t++) {
    while (marks && m + 1 < marks.length && marks[m + 1][0] <= t * 3) m++;
    let key = m >= 0 ? marks[m][1] : null;
    if (key == null) {
      const a = src[t * 3] * 3, b = src[t * 3 + 1] * 3, c = src[t * 3 + 2] * 3;
      key = keyOf((pos[a] + pos[b] + pos[c]) / 3, (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3);
    }
    let list = byCell.get(key);
    if (!list) byCell.set(key, (list = []));
    list.push(t);
  }
  return byCell;
}

// A Builder's triangles as a mesh per 64 m quarter of a 128 m cell, each handed to the chunk manager as part
// of its cell (drawn within the layer's far, casting within CAST_R of the cell). For the street life: tens of
// thousands of small triangles near the ground, where letting three.js cull the pieces out of the camera's
// and the shadow's view saves more than the few extra draw calls cost (one mesh with a casting run would put
// every casting cell in the shadow map). Quarters, not whole cells, because the low tier's shadow box is
// only 84 m across: a whole cell that touches it would send more of the street to the shadow map than the
// old 60 m chunks did. Each piece gets only the vertices it uses.
const PIECE = CELL / 2;
const pieceKey = (xm, zm) => `${Math.floor(xm / PIECE)},${Math.floor(zm / PIECE)}`;
const cellOfPiece = (key) => { const [px, pz] = key.split(',').map(Number); return `${Math.floor(px / 2)},${Math.floor(pz / 2)}`; };
function cellPieces(builder, material, { layer, tags = null }) {
  const geo = builder.build({ indexed: true });
  const src = geo.index.array, names = Object.keys(geo.attributes), out = [];
  for (const [piece, tris] of trianglesByCell(geo, tags?.of(builder), pieceKey)) {
    const key = cellOfPiece(piece);
    const remap = new Map(), idx = new Uint32Array(tris.length * 3);
    tris.forEach((t, i) => {
      for (let j = 0; j < 3; j++) {
        const v = src[t * 3 + j];
        let r = remap.get(v);
        if (r === undefined) remap.set(v, (r = remap.size));
        idx[i * 3 + j] = r;
      }
    });
    const g = new THREE.BufferGeometry();
    for (const n of names) {
      const a = geo.attributes[n], k = a.itemSize, arr = new Float32Array(remap.size * k);
      for (const [v, r] of remap) for (let j = 0; j < k; j++) arr[r * k + j] = a.array[v * k + j];
      g.setAttribute(n, new THREE.BufferAttribute(arr, k));
    }
    g.setIndex(new THREE.BufferAttribute(remap.size <= 65536 ? Uint16Array.from(idx) : idx, 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, material);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    // (for the tests and the console: the cell the chunk manager switches it with, and its quarter)
    Object.defineProperty(mesh.userData, 'cell', { value: key, configurable: true });
    Object.defineProperty(mesh.userData, 'piece', { value: piece, configurable: true });
    chunks.add(mesh, { cell: key, layer });
    out.push(mesh);
  }
  return out;
}

// An InstancedMesh cut into cells: its copies are written casting cells first, and the shadow pass draws
// only those (chunks.js castFirst). Every copy is always drawn. hide(i, on) swaps copy i for nothing and
// back (the tree crowns clearTreesForCamera tucks away), wherever the sort has put it.
function cellInstances(mesh, layer = 'shells') {
  const n = mesh.count, M = mesh.instanceMatrix.array, C = mesh.instanceColor?.array;
  const src = M.slice(0, n * 16), srcC = C ? C.slice(0, n * 3) : null;
  const hidden = new Uint8Array(n), at = new Int32Array(n);
  const byCell = new Map();
  for (let i = 0; i < n; i++) {
    const s = slotFor(layer, cellKey(src[i * 16 + 12], src[i * 16 + 14]));
    let list = byCell.get(s);
    if (!list) byCell.set(s, (list = []));
    list.push(i);
  }
  const parts = [...byCell].map(([slot, list]) => ({ slot, list }));
  castFirst(mesh);
  const e = { mesh, dirty: true, state: -1, sort, hide, parts, at };
  describeCells(mesh, parts, true);
  function write(i, k) {
    if (hidden[i]) M.set(ZERO16, k * 16); else M.set(src.subarray(i * 16, i * 16 + 16), k * 16);
    if (srcC) mesh.instanceColor.array.set(srcC.subarray(i * 3, i * 3 + 3), k * 3);
  }
  function sort() {
    e.dirty = false;
    let state = 0;
    for (const p of parts) state = state * 2 + (p.slot.castShadow ? 1 : 0);
    if (state === e.state) return;
    e.state = state;
    let k = 0;
    for (const p of parts) if (p.slot.castShadow) for (const i of p.list) { at[i] = k; write(i, k++); }
    const nCast = k;
    for (const p of parts) if (!p.slot.castShadow) for (const i of p.list) { at[i] = k; write(i, k++); }
    setCopies(mesh, n, nCast);
    if (srcC) mesh.instanceColor.needsUpdate = true;
  }
  function hide(i, on) {
    if (!!hidden[i] === on) return;
    hidden[i] = on ? 1 : 0;
    write(i, at[i]);
    uploadFirst(mesh.instanceMatrix, n);
  }
  for (const p of parts) p.slot.users.push(e);
  cut.push(e);
  sort();
  return e;
}

// what a cut mesh is made of, for the tests and the console (userData.cells: [{ slot, idx | list }], userData.cast:
// made to cast), kept out of JSON so a clone or an export never walks into the stand-ins
function describeCells(mesh, parts, cast) {
  Object.defineProperty(mesh.userData, 'cells', { value: parts, configurable: true });
  Object.defineProperty(mesh.userData, 'cast', { value: cast, configurable: true });
}

// a mesh taken out of the city (the simple palms and trees, once the Blender palms are in): no more sorting
function uncut(mesh) {
  const i = cut.findIndex((c) => c.mesh === mesh);
  if (i < 0) return;
  const [e] = cut.splice(i, 1);
  for (const p of e.parts) p.slot.users.splice(p.slot.users.indexOf(e), 1);
}

// A separate object (a sign, the jet, a yacht, a fountain, the pier) handed to the chunk manager whole: it
// is always drawn, and casts (if it was made to) only while the shadow focus is within 110 m of its box.
// Groups get their box from their meshes; a single mesh's comes from its geometry.
function keep(obj) {
  let box;
  if (!obj.geometry) {
    obj.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(obj);
    box = [b.min.x, b.min.z, b.max.x, b.max.z];
  }
  chunks.add(obj, { layer: 'shells', box });
  return obj;
}

// ---------- ground ----------

function buildGround(group) {
  const mats = {
    [ROAD]: lambert({ map: TX.asphalt() }),
    [WALK]: lambert({ map: TX.sidewalk() }),
    [GRASS]: lambert({ map: TX.grass() }),
    [PLAZA]: lambert({ map: TX.plaza() }),
    [LOT]: lambert({ map: TX.asphalt('#676c75', 12) }),
    [WATER]: new THREE.MeshStandardMaterial({ map: TX.poolTiles(), roughness: 0.04, metalness: 0.1, emissive: new THREE.Color('#2bb6e6'), emissiveIntensity: 0 }),
  };
  onNight(mats[WATER], 'emissiveIntensity', 0, 0.75);
  // real ground photos from Poly Haven (CC0), toned to the cartoon palette
  TX.upgradeGround(mats[ROAD], 'assets/tex/asphalt.jpg', { tint: '#c9a47c', amount: 0.4, normal: 'assets/tex/asphalt_n.jpg', normalScale: 0.9 });
  TX.upgradeGround(mats[LOT], 'assets/tex/asphalt.jpg', { tint: '#b8946e', amount: 0.42, normal: 'assets/tex/asphalt_n.jpg', normalScale: 0.9 });
  TX.upgradeGround(mats[WALK], 'assets/tex/concrete.jpg', { tint: '#efe6d6', amount: 0.35, lift: 0.22, normal: 'assets/tex/concrete_n.jpg', normalScale: 0.4,
    overlay: (x, S) => {   // saw-cut joints: two slabs per tile, like the painted version
      x.fillStyle = 'rgba(110,104,94,.85)';
      x.fillRect(0, 0, S, S / 128); x.fillRect(0, 0, S / 128, S); x.fillRect(0, S / 2 - S / 256, S, S / 128); x.fillRect(S / 2 - S / 256, 0, S / 128, S);
    } });
  TX.upgradeGround(mats[PLAZA], 'assets/tex/granite.jpg', { tint: '#f0dcb8', amount: 0.55, lift: 0.3, normal: 'assets/tex/granite_n.jpg', normalScale: 0.5 });
  const B = { [ROAD]: new Builder(), [WALK]: new Builder(), [GRASS]: new Builder(), [PLAZA]: new Builder(), [LOT]: new Builder(), [WATER]: new Builder() };
  const curb = new Builder(), yellow = new Builder(), white = new Builder();
  const hAt = (tx, ty) => (tx < 0 || ty < 0 || tx >= N || ty >= N) ? OUT : H[tileAt(tx, ty)];

  for (let ty = 0; ty < N; ty++) for (let tx = 0; tx < N; tx++) {
    const t = tileAt(tx, ty), h = H[t];
    const x0 = tx * TM, z0 = ty * TM, x1 = x0 + TM, z1 = z0 + TM;
    if (t !== BUILD) {
      const us = t === GRASS ? 8 : TM;
      B[t].quad([x0, h, z0], [x0, h, z1], [x1, h, z1], [x1, h, z0],
        [[x0 / us, -z0 / us], [x0 / us, -z1 / us], [x1 / us, -z1 / us], [x1 / us, -z0 / us]]);
    }
    const cu = [[0, 0], [2, 0], [2, 0.25], [0, 0.25]];
    let hn;
    if ((hn = hAt(tx + 1, ty)) < h - 0.001) curb.quad([x1, hn, z1], [x1, hn, z0], [x1, h, z0], [x1, h, z1], cu);
    if ((hn = hAt(tx - 1, ty)) < h - 0.001) curb.quad([x0, hn, z0], [x0, hn, z1], [x0, h, z1], [x0, h, z0], cu);
    if ((hn = hAt(tx, ty + 1)) < h - 0.001) curb.quad([x0, hn, z1], [x1, hn, z1], [x1, h, z1], [x0, h, z1], cu);
    if ((hn = hAt(tx, ty - 1)) < h - 0.001) curb.quad([x1, hn, z0], [x0, hn, z0], [x0, h, z0], [x1, h, z0], cu);

    // road paint
    const y = 0.015;
    const flat = (b, xa, za, xb, zb, yy = y) => b.quad([xa, yy, za], [xa, yy, zb], [xb, yy, zb], [xb, yy, za]);
    if (t === ROAD) {
      const mx = tx % P, my = ty % P;
      const hRoad = my < 2 && mx >= 2, vRoad = mx < 2 && my >= 2;
      if (hRoad && my === 0) flat(yellow, x0 + 0.6, z1 - 0.1, x0 + 0.6 + TM * 0.45, z1 + 0.1);
      if (vRoad && mx === 0) flat(yellow, x1 - 0.1, z0 + 0.6, x1 + 0.1, z0 + 0.6 + TM * 0.45);
      if (hRoad && (mx === 2 || mx === P - 1)) for (let i = 0; i < 4; i++) flat(white, x0 + 0.75, z0 + 0.25 + i, x1 - 0.75, z0 + 0.75 + i);
      if (vRoad && (my === 2 || my === P - 1)) for (let i = 0; i < 4; i++) flat(white, x0 + 0.25 + i, z0 + 0.75, x0 + 0.75 + i, z1 - 0.75);
      // stop lines before each crossing
      // (right-hand traffic: eastbound uses row 1, westbound row 0, southbound column 0, northbound column 1)
      if (hRoad && mx === 3 && my === 0) flat(white, x0 + 0.1, z0 + 0.2, x0 + 0.4, z1 - 0.2);
      if (hRoad && mx === P - 2 && my === 1) flat(white, x1 - 0.4, z0 + 0.2, x1 - 0.1, z1 - 0.2);
      if (vRoad && my === 3 && mx === 1) flat(white, x0 + 0.2, z0 + 0.1, x1 - 0.2, z0 + 0.4);
      if (vRoad && my === P - 2 && mx === 0) flat(white, x0 + 0.2, z1 - 0.4, x1 - 0.2, z1 - 0.1);
    } else if (t === LOT && (tx & 1)) {
      flat(white, x0 - 0.06, z0 + 0.5, x0 + 0.06, z1 - 0.5, H[LOT] + 0.012);
    }
  }
  // the ground is drawn at any distance and casts nothing: its cells are registered, never switched
  const ground = (b, mat) => group.add(cellMesh(b, mat, { layer: 'terrain' }));
  for (const k of Object.keys(B)) ground(B[k], mats[k]);
  ground(curb, lambert({ map: TX.concrete('#b4afa5') }));
  const paint = (color) => lambert({ color, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  ground(yellow, paint('#e8c547'));
  ground(white, paint('#ece8de'));
}

// ---------- buildings ----------

const shopFronts = [];   // deco buildings with ground-floor shops: { b, x0, x1, z1 }
// The facade and shop atlases are painted on first use, not when this module loads: the facade imports it
// on every map, and the v2 map never builds the grid city.
let atlases = null;
function mats() {
  if (atlases) return atlases;
  const facade = TX.decoFacade();
  const shop = TX.shopAtlas();
  // the Orbio-painted versions (tools/gen_city_textures.py + build_city_textures.py) replace them once loaded
  TX.replaceCanvas(facade.map, 'assets/tex/facade.jpg');
  TX.replaceCanvas(facade.lit, 'assets/tex/facade_lit.jpg');
  TX.replaceCanvas(facade.rough, 'assets/tex/facade_rough.jpg');
  TX.replaceCanvas(shop.map, 'assets/tex/shops.jpg');
  TX.replaceCanvas(shop.lit, 'assets/tex/shops_lit.jpg');
  atlases = { facade, shop };
  return atlases;
}
// South Beach: pastel stucco walls, a contrasting trim colour, neon names on the hotel pylons
const MIAMI = ['#f3c1ab', '#a9dcc7', '#f4d98a', '#c8bbe6', '#b2d3ee', '#f6f1e6', '#f1b2c3', '#9fd8cf', '#efc79a', '#fbe6c4', '#f6a9a0', '#bfe3a8'];
const ACCENT = ['#2aa39d', '#e5678a', '#f0a057', '#4f8fd8', '#7bbf9a', '#c98bd8', '#f4f2ec'];
const NEON = [['KIMCHI', '#ff4fa3'], ['MOCHI', '#4fe3ff'], ['HALMONI', '#ffd24f'], ['CORAL', '#ff7a5a'],
  ['TIDES', '#7affc8'], ['SEOUL', '#c77dff'], ['BAO', '#ff5252'], ['FLAMINGO', '#ff6fb5']];
const AWNING_COLORS = ['#d6402b', '#3d9a6a', '#3b7dd8', '#e3a13a', '#8a5cc2', '#1b1512'];

function buildingHeight(b) {
  if (b.place === 'home') return 6.85;
  if (b.place === 'watches' || b.place === 'fashion') return 6.6;
  if (b.place === 'jet') return 5.2;
  if (b.place === 'marina') return 5.4;
  if (b.place === 'mart') return 5.4;
  if (b.place === 'dealer') return 6.2;
  if (b.place === 'kimchi') return 4.6;
  if (b.place === 'police') return 9.6;
  if (b.place === 'hospital') return 16;
  if (b.place === 'spray') return 5.2;
  if (b.place === 'guns') return 4.6;
  if (b.house) return (b.place ? 2 : 1 + (hash(b.id, 3) < 0.55 ? 1 : 0)) * 3.0;
  let floors = 2 + Math.floor(hash(b.id, 77) * 6);
  if (b.w * b.h >= 40) floors += 2 + Math.floor(hash(b.id, 78) * 5);
  return floors * 3.2;
}

function buildBuildings(group) {
  const { facade, shop } = mats();
  const wallMat = lambert({ map: facade.map, vertexColors: true, emissiveMap: facade.lit, emissive: new THREE.Color('#ffd28a'), emissiveIntensity: 0,
    ...(LOW ? {} : { roughness: 1, roughnessMap: facade.rough }) });
  const neonTex = TX.neonAtlas(NEON);
  const neonMat = lambert({ map: neonTex, emissiveMap: neonTex, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.55 });
  onNight(neonMat, 'emissiveIntensity', 0.55, 3.2);
  const neon = new Builder();
  onNight(wallMat, 'emissiveIntensity', 0, 1.15);
  const shopMat = lambert({ map: shop.map, emissiveMap: shop.lit, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.05 });
  onNight(shopMat, 'emissiveIntensity', 0.05, 0.55);
  const roofMat = lambert({ map: TX.roofGravel(), vertexColors: true });
  const trimMat = lambert({ vertexColors: true });
  const houseRoofMat = lambert({ map: TX.shingles(), vertexColors: true, side: THREE.DoubleSide });
  const atlas = TX.signAtlas();
  TX.replaceCanvas(atlas, 'assets/tex/signs.jpg');
  const signMat = lambert({ map: atlas, emissiveMap: atlas, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.12 });
  onNight(signMat, 'emissiveIntensity', 0.12, 0.95);
  const martIn = TX.storeInterior('mart'), autoIn = TX.storeInterior('auto');
  const glassMat = lambert({ map: martIn.map, emissiveMap: martIn.lit, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.15 });
  onNight(glassMat, 'emissiveIntensity', 0.15, 0.85);
  const autoGlassMat = lambert({ map: autoIn.map, emissiveMap: autoIn.lit, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.15 });
  onNight(autoGlassMat, 'emissiveIntensity', 0.15, 0.85);
  const autoGlass = new Builder();
  const lanternMat = lambert({ color: '#d6402b', emissive: new THREE.Color('#ff6a3a'), emissiveIntensity: 0.3 });
  onNight(lanternMat, 'emissiveIntensity', 0.3, 1.6);
  const interior = (kind, day = 0.25) => {
    const t = TX.storeInterior(kind);
    const m = lambert({ map: t.map, emissiveMap: t.lit, emissive: new THREE.Color('#ffffff'), emissiveIntensity: day });
    onNight(m, 'emissiveIntensity', day, 1.0);
    return m;
  };
  const lux = {
    gold: new Builder(), villa: new Builder(), watch: new Builder(), shop: new Builder(), leds: new Builder(),
    goldMat: new THREE.MeshStandardMaterial({ color: '#d4af37', metalness: 1, roughness: 0.28 }),
    ledMat: lambert({ color: '#fff4dc', emissive: new THREE.Color('#ffd89a'), emissiveIntensity: 0.4 }),
  };
  onNight(lux.ledMat, 'emissiveIntensity', 0.4, 2.4);

  const walls = new Builder(), roofs = new Builder(), trim = new Builder(), shops = new Builder();
  const houseRoofs = new Builder(), signs = new Builder(), glass = new Builder(), lanterns = new Builder();
  const awnings = AWNING_COLORS.map(() => new Builder());
  const tags = cellTags([walls, roofs, trim, shops, houseRoofs, signs, glass, lanterns, neon, autoGlass, ...awnings,
    lux.gold, lux.villa, lux.watch, lux.shop, lux.leds]);

  for (const b of buildings) {
    const x0 = b.x * TM, z0 = b.y * TM, x1 = (b.x + b.w) * TM, z1 = (b.y + b.h) * TM;
    tags.at(cellKey((x0 + x1) / 2, (z0 + z1) / 2));
    const h = buildingHeight(b);
    const y0 = BASE, y1 = BASE + h;
    const wc = col(b.wall), rc = col(b.roof);
    if (!b.house) rc.lerp(new THREE.Color('#ffffff'), 0.5);
    const uOff = Math.floor(hash(b.id, 5) * 8) / 8, vOff = Math.floor(hash(b.id, 6) * 4) / 8;
    let top = y1;

    if (b.house) {
      walls.box(x0, y0, z0, x1, y1, z1, wc, { top: false, uv: 'world', us: 24, vs: 24, uOff, vOff, vBase: y0 });
      top = gableRoof(houseRoofs, trim, x0, z0, x1, z1, y1, rc, wc);
      if (hash(b.id, 31) < 0.6 && !b.place) {
        const cx = x0 + (x1 - x0) * 0.72, cz = z0 + (z1 - z0) * 0.3;
        trim.box(cx - 0.35, y1, cz - 0.35, cx + 0.35, top - 0.2, cz + 0.35, col('#8a5a44'));
      }
    } else if (b.place === 'home') {
      top = villa(group, trim, lux, b, x0, z0, x1, z1);
    } else if (b.place === 'watches' || b.place === 'fashion' || b.place === 'jet' || b.place === 'marina') {
      top = luxShop(group, trim, lux, b, x0, z0, x1, z1, h);
    } else if (b.place === 'kimchi') {
      walls.box(x0, y0, z0, x1, y1, z1, wc, { top: false, uv: 'world', us: 24, vs: 25.6, uOff, vOff: 0, vBase: y0 - 1.2 });
      top = hipRoof(houseRoofs, x0, z0, x1, z1, y1, col('#3b3f46'));
      // red timber frame on the front
      for (let x = x0 + 0.2; x < x1; x += 3.4) trim.box(x, y0, z1, x + 0.3, y1, z1 + 0.12, col('#9c2a1e'));
      trim.box(x0, y1 - 0.45, z1, x1, y1 - 0.05, z1 + 0.14, col('#9c2a1e'));
      // porch pillars and lanterns
      for (const px of [b.door.x * S - 2.6, b.door.x * S + 2.6]) trim.box(px - 0.18, y0, z1 + 1.9, px + 0.18, y1 + 0.2, z1 + 2.26, col('#b5321f'));
      trim.box(b.door.x * S - 3.2, y1 + 0.1, z1, b.door.x * S + 3.2, y1 + 0.35, z1 + 2.5, col('#3b3f46'));
      const lg = new THREE.SphereGeometry(0.32, 10, 8);
      for (let i = 0; i < 5; i++) {
        const lx = x0 + (i + 0.5) * (x1 - x0) / 5;
        lanterns.geo(lg, mat4(lx, y1 - 0.75, z1 + 0.75, 0, 0, 0, 1, 1.25, 1));
        trim.box(lx - 0.02, y1 - 0.4, z1 + 0.73, lx + 0.02, y1 + 0.05, z1 + 0.77, col('#222'));
      }
    } else {
      const isDeco = !b.place;
      const shopsHere = isDeco && hash(b.id, 12) < 0.7 && (x1 - x0) >= 12;
      if (shopsHere) shopFronts.push({ b, x0, x1, z1 });
      const wcol = isDeco ? col(MIAMI[Math.floor(hash(b.id, 7) * MIAMI.length)]) : wc;
      const rcol = isDeco ? col('#cfccc4') : rc;
      walls.box(x0, y0, z0, x1, y1, z1, wcol, { top: false, uv: 'world', us: 24, vs: 25.6, uOff, vOff, vBase: y0 });
      roofs.box(x0, y1 - 0.01, z0, x1, y1, z1, rcol, { px: false, nx: false, pz: false, nz: false, uv: 'world', us: 8 });
      if (isDeco) top = decoDetails(trim, neon, b, x0, z0, x1, z1, y0, y1, wcol, shopsHere);
      else {
        // parapet
        const pc = wc.clone().multiplyScalar(0.82), t = 0.25, ph = 0.55;
        trim.box(x0, y1, z0, x1, y1 + ph, z0 + t, pc);
        trim.box(x0, y1, z1 - t, x1, y1 + ph, z1, pc);
        trim.box(x0, y1, z0 + t, x0 + t, y1 + ph, z1 - t, pc);
        trim.box(x1 - t, y1, z0 + t, x1, y1 + ph, z1 - t, pc);
        top = y1 + ph;
      }
      if (!b.place) {
        for (let i = 0; i < 3; i++) {
          if (hash(b.id, i + 40) < 0.3) continue;
          const ax = x0 + 1.5 + hash(b.id, i + 50) * (x1 - x0 - 4), az = z0 + 1.5 + hash(i + 60, b.id) * (z1 - z0 - 4);
          trim.box(ax, y1, az, ax + 1.6, y1 + 1.1, az + 1.2, col('#9aa0a3'));
          trim.box(ax + 0.2, y1 + 1.1, az + 0.2, ax + 1.4, y1 + 1.2, az + 1.0, col('#7d8386'));
        }
        if (hash(b.id, 70) < 0.25 && h > 12) {
          const wx = x0 + 3, wz = z0 + 3;
          trim.geo(new THREE.CylinderGeometry(1.1, 1.1, 2.2, 10), mat4(wx, y1 + 2.4, wz), col('#7a5a44'));
          for (const [dx, dz] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]]) trim.box(wx + dx - 0.08, y1, wz + dz - 0.08, wx + dx + 0.08, y1 + 1.3, wz + dz + 0.08, col('#555'));
        }
        // ground-floor shops on the street side
        if (shopsHere) {
          const bays = Math.floor((x1 - x0 - 1) / 6.2);
          const startX = (x0 + x1) / 2 - bays * 3.1;
          for (let i = 0; i < bays; i++) {
            const sx = startX + i * 6.2 + 0.1, ex = sx + 6;
            // each bay shows the painted shop front that goes with its sign (3 x 4 atlas, SHOP_SIGNS order)
            const si = Math.floor(hash(b.id * 5 + i, 91) * TX.SHOP_SIGNS.length);
            const su0 = (si % 3) / 3, sv1 = 1 - Math.floor(si / 3) / 4;
            shops.quad([sx, y0, z1 + 0.02], [ex, y0, z1 + 0.02], [ex, y0 + 3.2, z1 + 0.02], [sx, y0 + 3.2, z1 + 0.02],
              [[su0, sv1 - 0.25], [su0 + 1 / 3, sv1 - 0.25], [su0 + 1 / 3, sv1], [su0, sv1]]);
            const ai = Math.floor(hash(b.id * 3 + i, 90) * AWNING_COLORS.length);
            const aw = awnings[ai], ay = y0 + 3.4;
            aw.quad([sx, ay - 0.6, z1 + 1.35], [ex, ay - 0.6, z1 + 1.35], [ex, ay, z1 + 0.02], [sx, ay, z1 + 0.02], [[0, 0], [6, 0], [6, 1], [0, 1]]);
            aw.quad([sx, ay - 0.9, z1 + 1.35], [ex, ay - 0.9, z1 + 1.35], [ex, ay - 0.6, z1 + 1.35], [sx, ay - 0.6, z1 + 1.35], [[0, 0], [6, 0], [6, 0.3], [0, 0.3]]);
            const u0 = (si % 2) * 0.5, row = Math.floor(si / 2);
            const v1 = 1 - row / 6, v0 = 1 - (row + 1) / 6;
            signs.quad([sx + 0.4, ay + 0.12, z1 + 0.05], [ex - 0.4, ay + 0.12, z1 + 0.05], [ex - 0.4, ay + 1.1, z1 + 0.05], [sx + 0.4, ay + 1.1, z1 + 0.05],
              [[u0, v0], [u0 + 0.5, v0], [u0 + 0.5, v1], [u0, v1]]);
          }
        } else door(trim, b, z1, y0);
      }
    }

    const run = (len) => [[0, 0], [len / 6, 0], [len / 6, 1], [0, 1]];
    if (b.place === 'mart') {
      glass.quad([x0 + 1, y0 + 0.4, z1 + 0.03], [x1 - 1, y0 + 0.4, z1 + 0.03], [x1 - 1, y0 + 3.4, z1 + 0.03], [x0 + 1, y0 + 3.4, z1 + 0.03], run(x1 - x0 - 2));
      for (let x = x0 + 1; x <= x1 - 1; x += 3) trim.box(x - 0.08, y0 + 0.3, z1 + 0.03, x + 0.08, y0 + 3.5, z1 + 0.1, col('#e9eef0'));
      trim.box(x0, y0 + 3.7, z1, x1, y0 + 5.3, z1 + 0.25, col('#3d9a6a'));
      addSign(group, 'K-MART', { bg: '#3d9a6a', fg: '#ffffff', sub: '24/7 편의점' }, (x0 + x1) / 2, y0 + 4.5, z1 + 0.27, 11, 1.5);
      roofLabel(group, 'K-MART', '#3d9a6a', x0, z0, x1, z1, top);
      const aw = awnings[1];
      aw.quad([x0 + 1, y0 + 2.9, z1 + 1.6], [x1 - 1, y0 + 2.9, z1 + 1.6], [x1 - 1, y0 + 3.6, z1 + 0.25], [x0 + 1, y0 + 3.6, z1 + 0.25], [[0, 0], [(x1 - x0 - 2), 0], [(x1 - x0 - 2), 1], [0, 1]]);
    } else if (b.place === 'dealer') {
      autoGlass.quad([x0 + 0.6, y0 + 0.3, z1 + 0.03], [x1 - 0.6, y0 + 0.3, z1 + 0.03], [x1 - 0.6, y0 + 4.2, z1 + 0.03], [x0 + 0.6, y0 + 4.2, z1 + 0.03], run(x1 - x0 - 1.2));
      autoGlass.quad([x1 + 0.03, y0 + 0.3, z1 - 0.6], [x1 + 0.03, y0 + 0.3, z0 + 0.6], [x1 + 0.03, y0 + 4.2, z0 + 0.6], [x1 + 0.03, y0 + 4.2, z1 - 0.6], run(z1 - z0 - 1.2));
      for (let x = x0 + 0.6; x <= x1 - 0.5; x += 3.4) trim.box(x - 0.07, y0 + 0.2, z1 + 0.03, x + 0.07, y0 + 4.3, z1 + 0.1, col('#dfe6ea'));
      trim.box(x0, y0 + 4.4, z1, x1, y0 + 6.2, z1 + 0.25, col('#101012'));
      lux.leds.box(x0, y0 + 4.32, z1, x1, y0 + 4.42, z1 + 0.3);
      addSign(group, 'KIMCHI MOTORS', { bg: '#101012', fg: 'gold', serif: true, sub: 'SUPERCARS · HYPERCARS · LIMOUSINES', size: 64 }, (x0 + x1) / 2, y0 + 5.3, z1 + 0.27, 10, 1.6);
      roofLabel(group, 'KIMCHI MOTORS', '#101012', x0, z0, x1, z1, top);
      // light posts and a gold rope along the display lot
      const bx = Math.floor(b.x / P) * P + 3, by = Math.floor(b.y / P) * P + 3;
      for (let i = 0; i <= 5; i++) {
        const px = (bx + i * 2) * TM, pz = (by + 10) * TM - 0.3;
        lux.gold.box(px - 0.06, BASE, pz - 0.06, px + 0.06, BASE + 0.9, pz + 0.06);
        if (i < 5) lux.gold.box(px, BASE + 0.82, pz - 0.025, px + 2 * TM, BASE + 0.87, pz + 0.025);
      }
    } else if (b.place === 'police') {
      trim.box(x0, y0 + 3.3, z1, x1, y0 + 4.1, z1 + 0.2, col('#1f4f8a'));
      trim.box(x0, y0 + 4.1, z1, x1, y0 + 4.3, z1 + 0.2, col('#f2f2f2'));
      addSign(group, 'POLICE', { bg: '#1f4f8a', fg: '#ffffff', sub: '경찰서 · Kimchi City PD' }, (x0 + x1) / 2, y0 + 5.4, z1 + 0.06, 9, 1.6);
      door(trim, b, z1, y0, '#1b2b44');
      roofLabel(group, 'POLICE', '#1f4f8a', x0, z0, x1, z1, top);
    } else if (b.place === 'hospital') {
      addSign(group, 'HOSPITAL', { bg: '#ffffff', fg: '#d6402b', sub: '병원 · emergency', border: '#d6402b' }, (x0 + x1) / 2, y0 + 4.2, z1 + 0.06, 10, 1.9);
      for (const [cx, cy, w, h] of [[(x0 + x1) / 2, y1 - 2.2, 0.9, 2.8], [(x0 + x1) / 2, y1 - 2.2, 2.8, 0.9]])
        trim.box(cx - w / 2, cy - h / 2, z1, cx + w / 2, cy + h / 2, z1 + 0.15, col('#e23b2b'));
      door(trim, b, z1, y0, '#9fb7c9');
      trim.box(b.door.x * S - 3, y0 + 2.9, z1, b.door.x * S + 3, y0 + 3.1, z1 + 3, col('#e9eef0'));
      roofLabel(group, '+ HOSPITAL', '#d6402b', x0, z0, x1, z1, top);
    } else if (b.place === 'spray') {
      const dx = b.door.x * S;
      trim.box(dx - 2.6, y0, z1, dx + 2.6, y0 + 3.9, z1 + 0.05, col('#cfcad6'));
      for (let y = y0 + 0.15; y < y0 + 3.7; y += 0.32) trim.box(dx - 2.4, y, z1 + 0.05, dx + 2.4, y + 0.26, z1 + 0.09, col('#8a8494'));
      addSign(group, 'K-SPRAY', { bg: '#8a5cc2', fg: '#ffffff', sub: 'PAINT · REPAIR · NO QUESTIONS' }, dx, y0 + 4.5, z1 + 0.06, 7, 1.1);
      roofLabel(group, 'K-SPRAY', '#8a5cc2', x0, z0, x1, z1, top);
    } else if (b.place === 'guns') {
      addSign(group, 'K-ARMS', { bg: '#151515', fg: '#e23b2b', sub: 'GUNS · AMMO · ARMOR', border: '#e23b2b' }, (x0 + x1) / 2, y0 + 3.9, z1 + 0.06, 8, 1.3);
      for (let x = x0 + 1; x < x1 - 0.8; x += 0.25) trim.box(x, y0 + 0.6, z1 + 0.05, x + 0.05, y0 + 3.0, z1 + 0.1, col('#2a2a2a'));
      door(trim, b, z1, y0, '#2a2a2a');
      roofLabel(group, 'K-ARMS', '#c0262b', x0, z0, x1, z1, top);
    } else if (b.place === 'kimchi') {
      addSign(group, 'KIMCHI HOUSE', { bg: '#b5321f', fg: '#fff1d6', sub: '김치 하우스 · since forever', border: '#f2c230' }, (x0 + x1) / 2, y1 + 1.15, z1 + 0.5, 12, 2.2, -0.25);
      door(trim, b, z1, y0, '#5a1f16');
    } else if (b.place === 'yuna') {
      door(trim, b, z1, y0, '#6b4aa0');
      addSign(group, "YUNA'S", { bg: '#9b7be0', fg: '#ffffff', w: 256, h: 96, size: 52 }, b.door.x * S + 1.7, y0 + 1.9, z1 + 0.06, 1.3, 0.5);
      flowerBoxes(trim, x0, x1, z1, y0);
    } else if (b.house) {
      door(trim, b, z1, y0);
    }

    for (let ty = b.y; ty < b.y + b.h; ty++) for (let tx = b.x; tx < b.x + b.w; tx++) heightGrid[ty * N + tx] = top;
  }

  const tagged = { tags };
  group.add(shell(walls, wallMat, { cast: true, tags }));
  if (!neon.empty) group.add(shell(neon, neonMat, tagged));
  group.add(shell(roofs, roofMat, { cast: true, tags }));
  group.add(shell(trim, trimMat, { cast: true, tags }));
  group.add(shell(houseRoofs, houseRoofMat, { cast: true, tags }));
  group.add(shell(shops, shopMat, tagged));
  group.add(shell(signs, signMat, tagged));
  if (!glass.empty) group.add(shell(glass, glassMat, tagged));
  if (!autoGlass.empty) group.add(shell(autoGlass, autoGlassMat, tagged));
  if (!lanterns.empty) group.add(shell(lanterns, lanternMat, tagged));
  if (!lux.gold.empty) group.add(shell(lux.gold, lux.goldMat, { cast: true, tags }));
  if (!lux.leds.empty) group.add(shell(lux.leds, lux.ledMat, tagged));
  if (!lux.villa.empty) group.add(shell(lux.villa, interior('villa', 0.35), tagged));
  if (!lux.watch.empty) group.add(shell(lux.watch, interior('watch', 0.45), tagged));
  if (!lux.shop.empty) group.add(shell(lux.shop, interior('boutique', 0.4), tagged));
  awnings.forEach((a, i) => { if (!a.empty) group.add(shell(a, lambert({ map: TX.stripes(AWNING_COLORS[i]), side: THREE.DoubleSide }), { cast: true, tags })); });
}

// The Art Deco dressing for an ordinary building: eyebrow ledges over every window row (they cast those
// long stripes of shadow), a coloured cornice, a stepped parapet with a raised centre, corner fins, and on
// taller ones a pylon with a vertical neon name. Returns the highest point.
function decoDetails(trim, neon, b, x0, z0, x1, z1, y0, y1, wcol, shops) {
  const acc = col(ACCENT[Math.floor(hash(b.id, 8) * ACCENT.length)]);
  const white = col('#f7f5ef');
  const eb = hash(b.id, 9) < 0.6 ? white : acc;
  const floors = Math.round((y1 - y0) / 3.2), d = 0.42, th = 0.09;
  for (let k = shops ? 1 : 0; k < floors; k++) {
    const y = y0 + 3.2 * (k + 1) - 0.5;
    trim.box(x0 - d, y, z1, x1 + d, y + th, z1 + d, eb, { bottom: true });
    trim.box(x0 - d, y, z0 - d, x1 + d, y + th, z0, eb, { bottom: true });
    trim.box(x0 - d, y, z0, x0, y + th, z1, eb, { bottom: true });
    trim.box(x1, y, z0, x1 + d, y + th, z1, eb, { bottom: true });
  }
  // a plinth in the trim colour where there are no shops
  if (!shops) trim.box(x0 - 0.05, y0, z0 - 0.05, x1 + 0.05, y0 + 0.5, z1 + 0.05, acc.clone().multiplyScalar(0.85), { top: false });
  // cornice band and parapet
  trim.box(x0 - 0.1, y1 - 0.4, z0 - 0.1, x1 + 0.1, y1, z1 + 0.1, acc, { top: false, bottom: true });
  const pc = wcol.clone().multiplyScalar(0.96), t = 0.28, ph = 0.85;
  trim.box(x0, y1, z0, x1, y1 + ph, z0 + t, pc);
  trim.box(x0, y1, z1 - t, x1, y1 + ph, z1, pc);
  trim.box(x0, y1, z0 + t, x0 + t, y1 + ph, z1 - t, pc);
  trim.box(x1 - t, y1, z0 + t, x1, y1 + ph, z1 - t, pc);
  const cx = (x0 + x1) / 2, w = x1 - x0;
  // stepped centre of the front parapet
  trim.box(cx - w * 0.26, y1 + ph, z1 - t, cx + w * 0.26, y1 + ph + 0.7, z1, pc);
  trim.box(cx - w * 0.14, y1 + ph + 0.7, z1 - t, cx + w * 0.14, y1 + ph + 1.4, z1, pc);
  trim.box(cx - w * 0.14 - 0.05, y1 + ph + 1.4, z1 - t - 0.05, cx + w * 0.14 + 0.05, y1 + ph + 1.55, z1 + 0.05, acc);
  let top = y1 + ph + 1.55;
  // fins at the front corners
  const fy0 = shops ? y0 + 3.7 : y0 + 0.5;
  for (const fx of [x0 + 0.05, x1 - 0.4]) trim.box(fx, fy0, z1, fx + 0.35, y1 + ph + 0.4, z1 + 0.32, white);
  // the hotel pylon with its neon name
  if (floors >= 3 && hash(b.id, 13) < 0.7) {
    const py0 = shops ? y0 + 3.7 : y0 + 2, py1 = y1 + 3.4, pw = 0.75;
    trim.box(cx - pw, py0, z1, cx + pw, py1, z1 + 0.75, white, { bottom: true });
    trim.box(cx - pw * 0.7, py1, z1 + 0.05, cx + pw * 0.7, py1 + 0.8, z1 + 0.65, white);
    trim.box(cx - pw * 0.4, py1 + 0.8, z1 + 0.12, cx + pw * 0.4, py1 + 1.4, z1 + 0.55, acc);
    trim.geo(new THREE.CylinderGeometry(0.06, 0.06, 1.6, 6), mat4(cx, py1 + 2.2, z1 + 0.33), white);
    const ni = Math.floor(hash(b.id, 14) * NEON.length), u0 = ni / NEON.length, u1 = (ni + 1) / NEON.length;
    const nh = Math.min(py1 - py0 - 1.2, 2.2 + NEON[ni][0].length * 0.85), ny1 = py1 - 0.4, ny0 = ny1 - nh;
    neon.quad([cx - pw * 0.78, ny0, z1 + 0.77], [cx + pw * 0.78, ny0, z1 + 0.77], [cx + pw * 0.78, ny1, z1 + 0.77], [cx - pw * 0.78, ny1, z1 + 0.77],
      [[u0, 0], [u1, 0], [u1, 1], [u0, 1]]);
    top = Math.max(top, py1 + 3);
  }
  return top;
}

function door(trim, b, z1, y0, color = '#4a3428') {
  const dx = b.door.x * S;
  trim.box(dx - 0.85, y0, z1, dx + 0.85, y0 + 2.55, z1 + 0.06, col('#d8d2c6'));
  trim.box(dx - 0.7, y0, z1 + 0.02, dx + 0.7, y0 + 2.4, z1 + 0.09, col(color));
  trim.box(dx + 0.38, y0 + 1.05, z1 + 0.09, dx + 0.5, y0 + 1.17, z1 + 0.14, col('#e8c547'));
  trim.box(dx - 1.1, y0 + 2.6, z1, dx + 1.1, y0 + 2.72, z1 + 0.7, col('#3a3532'));
}

// pitched roof along the longer side; returns the ridge height
function gableRoof(roofB, trim, x0, z0, x1, z1, y1, rc, wc) {
  const o = 0.45;
  const alongX = (x1 - x0) >= (z1 - z0);
  const span = alongX ? (z1 - z0) : (x1 - x0);
  const rise = span * 0.42, run = span / 2, ye = y1 - o * rise / run, yr = y1 + rise;
  const ru = (len) => [[0, 0], [len / 2, 0], [len / 2, 1.6], [0, 1.6]];
  if (alongX) {
    const zc = (z0 + z1) / 2, L = x1 - x0 + 2 * o;
    roofB.quad([x0 - o, ye, z0 - o], [x0 - o, yr, zc], [x1 + o, yr, zc], [x1 + o, ye, z0 - o], ru(L), rc);
    roofB.quad([x1 + o, ye, z1 + o], [x1 + o, yr, zc], [x0 - o, yr, zc], [x0 - o, ye, z1 + o], ru(L), rc);
    trim.tri([x0, y1, z0], [x0, y1, z1], [x0, yr - 0.05, zc], undefined, wc);
    trim.tri([x1, y1, z1], [x1, y1, z0], [x1, yr - 0.05, zc], undefined, wc);
  } else {
    const xc = (x0 + x1) / 2, L = z1 - z0 + 2 * o;
    roofB.quad([x0 - o, ye, z1 + o], [xc, yr, z1 + o], [xc, yr, z0 - o], [x0 - o, ye, z0 - o], ru(L), rc);
    roofB.quad([x1 + o, ye, z0 - o], [xc, yr, z0 - o], [xc, yr, z1 + o], [x1 + o, ye, z1 + o], ru(L), rc);
    trim.tri([x1, y1, z0], [x0, y1, z0], [xc, yr - 0.05, z0], undefined, wc);
    trim.tri([x0, y1, z1], [x1, y1, z1], [xc, yr - 0.05, z1], undefined, wc);
  }
  return yr;
}

// hanok-style hip roof with wide eaves
function hipRoof(roofB, x0, z0, x1, z1, y1, rc) {
  const o = 1.1, rise = 2.6;
  const ax = x0 - o, bx = x1 + o, az = z0 - o, bz = z1 + o, ye = y1 - 0.25, yr = ye + rise;
  const inset = Math.min(bx - ax, bz - az) / 2 - 0.6;
  const rx0 = ax + inset, rx1 = bx - inset, zc = (az + bz) / 2;
  const uv = [[0, 0], [4, 0], [4, 1.4], [0, 1.4]];
  roofB.quad([ax, ye, az], [rx0, yr, zc], [rx1, yr, zc], [bx, ye, az], uv, rc);
  roofB.quad([bx, ye, bz], [rx1, yr, zc], [rx0, yr, zc], [ax, ye, bz], uv, rc);
  roofB.tri([ax, ye, bz], [rx0, yr, zc], [ax, ye, az], undefined, rc);
  roofB.tri([bx, ye, az], [rx1, yr, zc], [bx, ye, bz], undefined, rc);
  return yr;
}

function addSign(group, text, opts, cx, cy, z, w, h, tilt = 0) {
  const tex = TX.textSign(text, opts);
  const m = lambert({ map: tex, emissiveMap: tex, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.2 });
  onNight(m, 'emissiveIntensity', 0.2, 1.1);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
  mesh.position.set(cx, cy, z);
  mesh.rotation.x = tilt;
  group.add(keep(mesh));
}

function roofLabel(group, text, bg, x0, z0, x1, z1, y) {
  const w = Math.min((x1 - x0) * 0.8, 20), h = w / 4;
  const tex = TX.textSign(text, { bg, fg: '#ffffff', size: 82 });
  const m = lambert({ map: tex, emissiveMap: tex, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.15 });
  onNight(m, 'emissiveIntensity', 0.15, 0.8);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set((x0 + x1) / 2, y + 0.06, (z0 + z1) / 2);
  group.add(keep(mesh));
}

function flowerBoxes(trim, x0, x1, z1, y0) {
  const COLS = ['#ff7aa2', '#f2c230', '#ffffff', '#e85d5d', '#c99bff'];
  const fg = new THREE.IcosahedronGeometry(0.13, 0);
  for (let x = x0 + 1.2; x < x1 - 1; x += 3) {
    trim.box(x, y0 + 1.0, z1, x + 1.6, y0 + 1.3, z1 + 0.4, col('#7a5134'));
    for (let k = 0; k < 6; k++) trim.geo(fg, mat4(x + 0.15 + k * 0.26, y0 + 1.38, z1 + 0.2), col(COLS[(k + Math.floor(x)) % COLS.length]));
  }
}

// ---------- trees, lamps, park ----------

// Tree crowns that would block the camera's view of the player are tucked away (scaled to zero). The copies
// are sorted by cell (cellInstances), so a tree is hidden and shown through its cut, wherever its copy sits.
const crownInfo = [];   // { i, x, y, z, r, hidden }
let crownMesh = null, trunkMesh = null, crownCut = null, trunkCut = null;
export function clearTreesForCamera(cam, target) {
  if (!crownMesh) return;
  const dx = target.x - cam.x, dy = target.y - cam.y, dz = target.z - cam.z;
  const len2 = dx * dx + dy * dy + dz * dz || 1;
  for (const c of crownInfo) {
    if (Math.abs(c.x - cam.x) > 30 || Math.abs(c.z - cam.z) > 30) { if (c.hidden) hide(c, false); continue; }
    // distance from the crown centre to the camera-to-player segment
    let t = ((c.x - cam.x) * dx + (c.y - cam.y) * dy + (c.z - cam.z) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = cam.x + dx * t - c.x, py = cam.y + dy * t - c.y, pz = cam.z + dz * t - c.z;
    const block = px * px + py * py + pz * pz < (c.r * 1.05) ** 2;
    if (block !== c.hidden) hide(c, block);
  }
  function hide(c, on) { crownCut.hide(c.i * 2, on); crownCut.hide(c.i * 2 + 1, on); trunkCut.hide(c.i, on); c.hidden = on; }
}

function buildTrees(group) {
  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.22, 2.4, 6);
  trunkGeo.translate(0, 1.2, 0);
  const crownGeo = new THREE.IcosahedronGeometry(1, 1);
  const trunks = new THREE.InstancedMesh(trunkGeo, lambert({ color: '#6b4a32' }), trees.length);
  const crowns = new THREE.InstancedMesh(crownGeo, lambert({ color: '#ffffff', flatShading: true }), trees.length * 2);
  const greens = ['#3f7a34', '#4b8a3c', '#5a9a45', '#3a6e31', '#6aa64c'].map(c => new THREE.Color(c));
  trees.forEach((t, i) => {
    const x = t.x * S, z = t.y * S, y = surfaceY(t.x, t.y), r = t.r * S * 1.35;
    const rot = hash(i, 3) * Math.PI * 2;
    const mt = mat4(x, y, z, 0, rot, 0, 1, 0.75 + r * 0.25, 1);
    trunks.setMatrixAt(i, mt);
    const m1 = mat4(x, y + 2.1 + r * 0.6, z, 0, rot, 0, r, r * 0.88, r);
    const m2 = mat4(x + r * 0.3, y + 2.2 + r * 1.15, z - r * 0.2, 0, rot, 0, r * 0.62);
    crowns.setMatrixAt(i * 2, m1);
    crowns.setMatrixAt(i * 2 + 1, m2);
    crownInfo.push({ i, x, y: y + 2.1 + r * 0.75, z, r: r * 1.2, hidden: false });
    const g = greens[Math.floor(hash(i, 9) * greens.length)];
    crowns.setColorAt(i * 2, g);
    crowns.setColorAt(i * 2 + 1, g.clone().multiplyScalar(1.12));
  });
  for (const m of [trunks, crowns]) { m.castShadow = true; m.receiveShadow = true; group.add(m); }
  crownMesh = crowns;
  trunkMesh = trunks;
  crownCut = cellInstances(crowns);
  trunkCut = cellInstances(trunks);
}

export const lampHeads = [];
function buildLamps(group) {
  const n = lamps.length;
  const poleGeo = new THREE.CylinderGeometry(0.07, 0.1, 5.4, 6); poleGeo.translate(0, 2.7, 0);
  const armGeo = new THREE.BoxGeometry(1.4, 0.09, 0.09); armGeo.translate(0.7, 0, 0);
  const headGeo = new THREE.BoxGeometry(0.6, 0.16, 0.32);
  const dark = lambert({ color: '#2f3336' });
  const headMat = lambert({ color: '#fff4d6', emissive: new THREE.Color('#ffd38a'), emissiveIntensity: 0 });
  onNight(headMat, 'emissiveIntensity', 0, 2.2);
  const poles = new THREE.InstancedMesh(poleGeo, dark, n);
  const arms = new THREE.InstancedMesh(armGeo, dark, n);
  const heads = new THREE.InstancedMesh(headGeo, headMat, n);
  const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
    map: TX.radialGlow(), color: '#ffc77a', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
  }), n);
  onNight(pools.material, 'opacity', 0, 0.55);
  lamps.forEach((l, i) => {
    const tx = Math.floor(l.x / T), ty = Math.floor(l.y / T);
    const dx = tx % P === 2 ? -1 : 1, dz = ty % P === 2 ? -1 : 1;
    const yaw = Math.atan2(-dz, dx);
    const x = l.x * S, z = l.y * S, y = surfaceY(l.x, l.y);
    poles.setMatrixAt(i, mat4(x, y, z));
    arms.setMatrixAt(i, mat4(x, y + 5.3, z, 0, yaw, 0));
    const hx = x + Math.cos(yaw) * 1.35, hz = z - Math.sin(yaw) * 1.35;
    heads.setMatrixAt(i, mat4(hx, y + 5.25, hz, 0, yaw, 0));
    pools.setMatrixAt(i, mat4(hx, 0.05 + 0.13, hz, -Math.PI / 2, 0, 0, 13, 13, 1));
    lampHeads.push(new THREE.Vector3(hx, y + 5.1, hz));
  });
  for (const m of [poles, arms]) { m.castShadow = true; group.add(m); cellInstances(m); }
  group.add(heads, pools);
  lampIndex = makeBuckets(lampHeads.map((h, i) => ({ x: h.x, z: h.z, h, i })), BUCKET);
}

export const fountains = [];
function buildPark(group) {
  const stone = lambert({ color: '#b9b0a0' });
  const waterMat = new THREE.MeshStandardMaterial({ color: '#5ab0d0', roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.9 });
  const wood = new Builder();
  for (const d of deco) {
    const x = d.x * S, z = d.y * S, y = surfaceY(d.x, d.y);
    if (d.kind === 'fountain') {
      const g = new THREE.Group();
      g.position.set(x, y, z);
      const basin = new THREE.Mesh(new THREE.CylinderGeometry(3.7, 3.9, 0.7, 28), stone); basin.position.y = 0.35;
      const water = new THREE.Mesh(new THREE.CylinderGeometry(3.35, 3.35, 0.1, 28), waterMat); water.position.y = 0.6;
      const col1 = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 1.8, 12), stone); col1.position.y = 0.9;
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 0.5, 0.35, 16), stone); bowl.position.y = 1.85;
      const jet = new THREE.Mesh(new THREE.ConeGeometry(0.5, 2.0, 12, 1, true), new THREE.MeshBasicMaterial({ color: '#cfefff', transparent: true, opacity: 0.45, depthWrite: false }));
      jet.position.y = 2.9; jet.rotation.x = Math.PI;
      for (const m of [basin, col1, bowl]) { m.castShadow = true; m.receiveShadow = true; }
      g.add(basin, water, col1, bowl, jet);
      group.add(keep(g));
      fountains.push({ jet, water });
    } else if (d.kind === 'lounger') {
      const c = col('#f1eee8'), leg = col('#3a3a3c');
      wood.box(x - 0.36, y + 0.28, z - 0.95, x + 0.36, y + 0.38, z + 0.6, c);
      wood.box(x - 0.36, y + 0.38, z + 0.55, x + 0.36, y + 0.8, z + 0.95, c);
      for (const [lx, lz] of [[-0.3, -0.85], [0.3, -0.85], [-0.3, 0.85], [0.3, 0.85]]) wood.box(x + lx - 0.03, y, z + lz - 0.03, x + lx + 0.03, y + 0.3, z + lz + 0.03, leg);
    } else if (d.kind === 'umbrella') {
      wood.box(x - 0.05, y, z - 0.05, x + 0.05, y + 2.5, z + 0.05, col('#3a3a3c'));
      wood.geo(new THREE.ConeGeometry(1.7, 0.55, 12), mat4(x, y + 2.6, z), col('#f1eee8'));
    } else if (d.kind === 'bench') {
      const c = col('#8a5a3a');
      wood.box(x - 1.0, y + 0.42, z - 0.25, x + 1.0, y + 0.5, z + 0.25, c);
      wood.box(x - 1.0, y + 0.5, z + 0.2, x + 1.0, y + 0.95, z + 0.28, c);
      for (const lx of [-0.85, 0.85]) wood.box(x + lx - 0.05, y, z - 0.2, x + lx + 0.05, y + 0.42, z + 0.2, col('#333'));
    }
  }
  if (!wood.empty) group.add(shell(wood, lambert({ vertexColors: true }), { cast: true }));
}

// ---------- island edge ----------

export let sea = null;
const seaTime = { value: 0 };   // drives the waves rolling onto the beach
export const mountains = [];
function buildCoast(group) {
  const sand = new Builder();
  const W = 22, lo = -1.4;
  const uv6 = (p) => [p[0] / 6, -p[2] / 6];
  const sq = (a, b, c, d) => sand.quad(a, b, c, d, [uv6(a), uv6(b), uv6(c), uv6(d)]);
  sq([0, OUT, MAP], [-W, lo, MAP + W], [MAP + W, lo, MAP + W], [MAP, OUT, MAP]);
  sq([-W, lo, -W], [0, OUT, 0], [MAP, OUT, 0], [MAP + W, lo, -W]);
  sq([MAP, OUT, 0], [MAP, OUT, MAP], [MAP + W, lo, MAP + W], [MAP + W, lo, -W]);
  sq([-W, lo, -W], [-W, lo, MAP + W], [0, OUT, MAP], [0, OUT, 0]);
  const sandMat = lambert({ map: TX.concrete('#e3cf9c', 33) });
  TX.upgradeGround(sandMat, 'assets/tex/sand.jpg', { tint: '#f6dfae', amount: 0.55, lift: 0.28, normal: 'assets/tex/sand_n.jpg', normalScale: 0.7 });
  group.add(sand.mesh(sandMat));

  const wt = TX.water();
  wt.repeat.set(500, 500);
  const seaMat = new THREE.MeshStandardMaterial({ color: '#ffffff', map: wt, roughness: 0.12, metalness: 0.05 });
  seaMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = seaTime;
    sh.uniforms.uMap = { value: MAP };
    sh.vertexShader = 'varying vec3 vSeaP;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvSeaP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = 'uniform float uTime; uniform float uMap; varying vec3 vSeaP;\n' + sh.fragmentShader.replace('#include <map_fragment>', `
      // distance out from the island's edge; the sand meets the water about 11 m out
      vec2 q = abs(vSeaP.xz - vec2(uMap * 0.5)) - vec2(uMap * 0.5);
      float shore = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 11.0;
      vec3 shallow = pow(vec3(0.23, 0.86, 0.82), vec3(2.2)), deep = pow(vec3(0.10, 0.42, 0.74), vec3(2.2));
      vec3 sea = mix(shallow, deep, smoothstep(0.0, 70.0, shore));
      float ripple = texture2D(map, vMapUv).r;
      sea *= 0.82 + ripple * 0.45;
      float wob = sin(vSeaP.x * 0.045 + uTime * 0.3) * 1.6 + sin(vSeaP.z * 0.06 - uTime * 0.25) * 1.3;
      float foam = 1.0 - smoothstep(0.2, 1.8 + 0.6 * sin(uTime * 1.3 + wob), shore);
      float lines = smoothstep(0.86, 0.97, sin(shore * 0.75 + uTime * 1.4 + wob)) * (1.0 - smoothstep(2.0, 16.0, shore));
      foam = clamp(max(foam, lines * 0.85), 0.0, 1.0);
      diffuseColor.rgb = mix(sea, vec3(0.95), foam);`);
  };
  sea = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000), seaMat);
  sea.rotation.x = -Math.PI / 2;
  sea.position.set(MAP / 2, -1.0, MAP / 2);
  sea.receiveShadow = true;
  group.add(sea);

  // distant hills: unlit silhouettes tinted by the sky each frame, a little lighter (hazier) at the base
  const geo = new THREE.SphereGeometry(1, 16, 10);
  const pos = geo.attributes.position, shade = [];
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const k = 1 + (hash(Math.round(pos.getX(i) * 50), Math.round(pos.getZ(i) * 50)) - 0.5) * 0.35;
    pos.setXYZ(i, pos.getX(i) * k, Math.max(0, y) * k, pos.getZ(i) * k);
    const s = 1.08 - Math.max(0, y) * 0.22;
    shade.push(s, s, s);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(shade, 3));
  const mat = new THREE.MeshBasicMaterial({ color: '#5d7f86', vertexColors: true, fog: false });
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + hash(i, 1) * 0.15;
    const d = 1350 + hash(i, 2) * 550;
    const m = new THREE.Mesh(geo, mat);
    const r = 240 + hash(i, 3) * 260, h = 55 + hash(i, 4) * 120;
    m.scale.set(r, h, r * (0.6 + hash(i, 5) * 0.5));
    m.rotation.y = hash(i, 6) * 3;
    m.position.set(MAP / 2 + Math.cos(a) * d, -2, MAP / 2 + Math.sin(a) * d);
    m.visible = LOW;   // Miami is flat: the high tier shows a clean ocean horizon
    group.add(m);
    mountains.push(m);
  }
  mountains.mat = mat;
}

// ---------- the luxury side of town ----------

// Kimchi's villa: a glass living room under a deep white slab, a cantilevered upper floor with a wood screen
function villa(group, trim, lux, b, x0, z0, x1, z1) {
  const y0 = BASE, concrete = col('#ddd7cc'), white = col('#f1eee8'), wood = col('#9c6b43'), black = col('#18181a');
  const run = (len) => [[0, 0], [len / 6, 0], [len / 6, 1], [0, 1]];
  trim.box(x0, y0, z0, x1, y0 + 3.3, z1, concrete);
  lux.villa.quad([x0 + 0.4, y0 + 0.05, z1 + 0.02], [x1 - 0.4, y0 + 0.05, z1 + 0.02], [x1 - 0.4, y0 + 3.1, z1 + 0.02], [x0 + 0.4, y0 + 3.1, z1 + 0.02], run(x1 - x0 - 0.8));
  for (let x = x0 + 0.4; x <= x1 - 0.3; x += 3.2) trim.box(x - 0.05, y0, z1 + 0.02, x + 0.05, y0 + 3.15, z1 + 0.08, black);
  lux.villa.quad([x1 + 0.02, y0 + 0.05, z1 - 0.4], [x1 + 0.02, y0 + 0.05, z0 + 2], [x1 + 0.02, y0 + 3.1, z0 + 2], [x1 + 0.02, y0 + 3.1, z1 - 0.4], run(z1 - z0 - 2.4));
  trim.box(x0 - 0.5, y0 + 3.3, z0 - 0.5, x1 + 0.5, y0 + 3.62, z1 + 0.9, white);
  lux.leds.box(x0 - 0.4, y0 + 3.24, z1 + 0.78, x1 + 0.4, y0 + 3.31, z1 + 0.88);
  const ux0 = x0 + 0.6, ux1 = x1 - 3.4, uz0 = z0 + 0.8, uz1 = z1 + 1.2;
  trim.box(ux0, y0 + 3.62, uz0, ux1, y0 + 6.5, uz1, white);
  lux.villa.quad([ux0 + 0.6, y0 + 4.1, uz1 + 0.02], [ux1 - 2.6, y0 + 4.1, uz1 + 0.02], [ux1 - 2.6, y0 + 6.0, uz1 + 0.02], [ux0 + 0.6, y0 + 6.0, uz1 + 0.02], run(ux1 - ux0 - 3.2));
  for (let x = ux1 - 2.4; x < ux1 - 0.2; x += 0.22) trim.box(x, y0 + 3.9, uz1 + 0.02, x + 0.1, y0 + 6.3, uz1 + 0.14, wood);
  trim.box(ux0 - 0.35, y0 + 6.5, uz0 - 0.35, ux1 + 0.35, y0 + 6.85, uz1 + 0.35, white);
  // glass balustrade along the lower roof terrace
  lux.leds.box(ux1 + 0.3, y0 + 3.62, z1 + 0.8, x1 + 0.4, y0 + 3.66, z1 + 0.86);
  door(trim, b, z1, y0, '#141416');
  addSign(group, 'VILLA KIMCHI', { bg: '#121214', fg: 'gold', serif: true, size: 62, w: 512, h: 112 }, b.door.x * S + 2.6, y0 + 2.0, z1 + 0.1, 2.3, 0.5);
  return y0 + 6.85;
}

// boutiques and the other luxury fronts: plain stone, big display windows, a gold-lettered sign
function luxShop(group, trim, lux, b, x0, z0, x1, z1, h) {
  const y0 = BASE, y1 = BASE + h, dx = b.door.x * S, k = b.place;
  const run = (len) => [[0, 0], [len / 6, 0], [len / 6, 1], [0, 1]];
  const pal = {
    watches: { wall: '#1d1c21', cap: '#0f0f12', frame: 'gold', glass: lux.watch },
    fashion: { wall: '#ece6da', cap: '#141414', frame: '#141414', glass: lux.shop },
    jet: { wall: '#f3f2ef', cap: '#141414', frame: '#141414', glass: lux.villa },
    marina: { wall: '#f4f1ea', cap: '#1d2b4a', frame: '#1d2b4a', glass: lux.villa },
  }[k];
  trim.box(x0, y0, z0, x1, y1, z1, col(pal.wall));
  trim.box(x0 - 0.2, y1 - 0.05, z0 - 0.2, x1 + 0.2, y1 + 0.35, z1 + 0.2, col(pal.cap));
  const edge = (xa, ya, xb, yb) => (pal.frame === 'gold' ? lux.gold.box(xa, ya, z1, xb, yb, z1 + 0.12) : trim.box(xa, ya, z1, xb, yb, z1 + 0.12, col(pal.frame)));
  const wy0 = y0 + 0.45, wy1 = y0 + (k === 'jet' || k === 'marina' ? 3.4 : 4.1);
  for (const [ax, bx] of [[x0 + 1.2, dx - 2.0], [dx + 2.0, x1 - 1.2]]) {
    if (bx - ax < 1) continue;
    pal.glass.quad([ax, wy0, z1 + 0.03], [bx, wy0, z1 + 0.03], [bx, wy1, z1 + 0.03], [ax, wy1, z1 + 0.03], run(bx - ax));
    edge(ax - 0.12, wy0 - 0.12, bx + 0.12, wy0); edge(ax - 0.12, wy1, bx + 0.12, wy1 + 0.12);
    edge(ax - 0.12, wy0, ax, wy1); edge(bx, wy0, bx + 0.12, wy1);
    for (let x = ax + 3; x < bx - 0.5; x += 3) edge(x - 0.04, wy0, x + 0.04, wy1);
  }
  door(trim, b, z1, y0, k === 'watches' ? '#0d0d10' : '#1b1b1d');
  if (k === 'watches') {
    addSign(group, 'CHRONO ROW', { bg: '#0f0f12', fg: 'gold', serif: true, sub: 'FINE WATCHES · SEOUL · GENÈVE', size: 74 }, dx, y0 + 5.3, z1 + 0.06, 11, 2.2);
    lux.leds.box(x0, y1 - 0.14, z1 + 0.02, x1, y1 - 0.06, z1 + 0.24);
  } else if (k === 'fashion') {
    addSign(group, 'MAISON K', { bg: '#ece6da', fg: '#121212', serif: true, sub: 'COUTURE · LEATHER · FITS', size: 84 }, dx, y0 + 5.3, z1 + 0.06, 11, 2.2);
    for (const [ax, bx] of [[x0 + 1.0, dx - 1.8], [dx + 1.8, x1 - 1.0]]) trim.box(ax, y0 + 4.35, z1, bx, y0 + 4.5, z1 + 1.3, col('#121212'));
  } else if (k === 'jet') {
    addSign(group, 'KIMCHI AIR', { bg: '#101012', fg: 'gold', serif: true, sub: 'PRIVATE TERMINAL', size: 74 }, dx, y0 + 4.3, z1 + 0.06, 7, 1.4);
    trim.box(dx - 2.4, y0 + 3.0, z1, dx + 2.4, y0 + 3.2, z1 + 2.6, col('#121212'));
  } else if (k === 'marina') {
    addSign(group, 'YACHT CLUB', { bg: '#1d2b4a', fg: 'gold', serif: true, sub: 'KIMCHI CITY MARINA', size: 74 }, dx, y0 + 4.3, z1 + 0.06, 8, 1.6);
    for (const fx of [x0 + 1, x1 - 1]) {
      trim.box(fx - 0.05, y1 + 0.35, z1 - 0.5, fx + 0.05, y1 + 4.2, z1 - 0.4, col('#e9e9e9'));
      for (const [a, c] of [[[fx, y1 + 4.1, z1 - 0.45], [fx + 1.4, y1 + 3.8, z1 - 0.45]], [[fx + 1.4, y1 + 3.8, z1 - 0.45], [fx, y1 + 4.1, z1 - 0.45]]]) trim.tri(a, c, [fx, y1 + 3.5, z1 - 0.45], undefined, col('#1d2b4a'));
    }
  }
  roofLabel(group, { watches: 'CHRONO ROW', fashion: 'MAISON K', jet: 'KIMCHI AIR', marina: 'YACHT CLUB' }[k], pal.cap, x0, z0, x1, z1, y1 + 0.35);
  return y1 + 0.35;
}

// Where the Blender palms go: the beach and boutique palms, a palm in place of every round tree (this is
// Miami now), and a row along the curb of every sidewalk, kept clear of doors and lamp posts. Visual only:
// none of them block anyone, same as the old trees.
function palmSpots() {
  const out = [];
  const beachY = (x, z, px, py) => {
    const o = Math.max(-x, x - MAP, -z, z - MAP, 0);
    return o > 0 ? OUT + (-1.4 - OUT) * Math.min(1, o / 22) : surfaceY(px, py);
  };
  for (const p of palms) { const x = p.x * S, z = p.y * S; out.push({ x, z, y: beachY(x, z, p.x, p.y), h: p.h, lean: p.lean, rot: p.rot }); }
  trees.forEach((t, i) => {
    const x = t.x * S, z = t.y * S;
    out.push({ x, z, y: surfaceY(t.x, t.y), h: 6 + hash(i, 21) * 5, lean: 0.04 + hash(i, 22) * 0.16, rot: hash(i, 23) * 6.28 });
  });
  const doors = buildings.map(b => [b.door.x * S, b.door.y * S]);
  const clear = (x, z) => doors.every(([dx, dz]) => (dx - x) ** 2 + (dz - z) ** 2 > 36) && lamps.every(l => (l.x * S - x) ** 2 + (l.y * S - z) ** 2 > 9);
  const step = LOW ? 6 : 3;
  for (let ty = 0; ty < N; ty++) for (let tx = 0; tx < N; tx++) {
    if (tileAt(tx, ty) !== WALK) continue;
    const mx = tx % P, my = ty % P;
    const edgeX = mx === 2 ? 0.75 : mx === P - 1 ? TM - 0.75 : null, edgeZ = my === 2 ? 0.75 : my === P - 1 ? TM - 0.75 : null;
    if ((edgeX === null) === (edgeZ === null)) continue;          // corners have the lamps
    if (((edgeX !== null ? my : mx) - 3) % step) continue;
    const x = tx * TM + (edgeX ?? TM / 2), z = ty * TM + (edgeZ ?? TM / 2);
    if (!clear(x, z)) continue;
    const i = tx * 131 + ty;
    out.push({ x, z, y: surfaceY(x / S, z / S), h: 7 + hash(i, 31) * 4, lean: 0.03 + hash(i, 32) * 0.12, rot: hash(i, 33) * 6.28 });
  }
  return out;
}

// palms on the deck, the boutique row, the marina and the beaches
const oldPalms = [];
function buildPalms(group) {
  if (!palms.length) return;
  const trunkGeo = new THREE.CylinderGeometry(0.12, 0.2, 1, 7, 3);
  trunkGeo.translate(0, 0.5, 0);
  const crown = new Builder();
  const leafA = col('#3d7a37'), leafB = col('#5a9a4a');
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + (i % 2) * 0.25, ca = Math.cos(a), sa = Math.sin(a);
    const len = 2.5 + (i % 3) * 0.4;
    const pts = [];
    for (let k = 0; k <= 4; k++) { const t = k / 4; pts.push([t * len, 0.45 * t - 1.35 * t * t, 0.42 * (1 - t) + 0.06]); }
    const P = (r, y, w) => [ca * r - sa * w, y, sa * r + ca * w];
    for (let k = 0; k < 4; k++) {
      const [r0, y0, w0] = pts[k], [r1, y1, w1] = pts[k + 1];
      crown.quad(P(r0, y0, -w0), P(r0, y0, w0), P(r1, y1, w1), P(r1, y1, -w1), undefined, k % 2 ? leafA : leafB);
    }
  }
  const nutG = new THREE.SphereGeometry(0.15, 6, 5);
  for (const [dx, dz] of [[0.2, 0], [-0.1, 0.18], [-0.1, -0.18]]) crown.geo(nutG, mat4(dx, -0.22, dz), col('#5a3a1e'));
  const trunks = new THREE.InstancedMesh(trunkGeo, lambert({ color: '#8b7458' }), palms.length);
  const crowns = new THREE.InstancedMesh(crown.build(), lambert({ vertexColors: true, side: THREE.DoubleSide }), palms.length);
  const q = new THREE.Quaternion(), e = new THREE.Euler(), m = new THREE.Matrix4(), base = new THREE.Vector3(), top = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1), sc = new THREE.Vector3();
  palms.forEach((p, i) => {
    const x = p.x * S, z = p.y * S;
    const out = Math.max(-x, x - MAP, -z, z - MAP, 0);
    const y = out > 0 ? OUT + (-1.4 - OUT) * Math.min(1, out / 22) : surfaceY(p.x, p.y);
    q.setFromEuler(e.set(0, p.rot, p.lean, 'YZX'));
    base.set(x, y - 0.1, z);
    trunks.setMatrixAt(i, m.compose(base, q, sc.set(1, p.h, 1)));
    top.set(0, p.h, 0).applyQuaternion(q).add(base);
    crowns.setMatrixAt(i, m.compose(top, new THREE.Quaternion().setFromEuler(e.set(0, p.rot * 2.3, 0)), one));
  });
  for (const mesh of [trunks, crowns]) { mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); oldPalms.push(mesh); cellInstances(mesh); }
}

// Kimchi One: a white private jet with a gold cheatline, airstair, red carpet and luggage
function buildJet(group) {
  const pl = places.jet?.plane;
  if (!pl) return;
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: '#f5f5f3', roughness: 0.28, metalness: 0.12 });
  const glassM = lambert({ color: '#15171c' });
  const gold = new THREE.MeshStandardMaterial({ color: '#d4af37', metalness: 1, roughness: 0.3 });
  const grey = new THREE.MeshStandardMaterial({ color: '#b9bcc2', roughness: 0.4, metalness: 0.5 });
  const dark = lambert({ color: '#2a2b2e' });
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z); mesh.rotation.set(rx, ry, rz);
    mesh.castShadow = true; mesh.receiveShadow = true;
    g.add(mesh);
    return mesh;
  };
  const R = 1.2, len = 13, yc = 2.1;
  add(new THREE.CylinderGeometry(R, R, len, 22), white, 0, yc, 0, 0, 0, Math.PI / 2);
  add(new THREE.SphereGeometry(R, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2), white, len / 2, yc, 0, 0, 0, -Math.PI / 2).scale.set(1, 2.3, 1);
  add(new THREE.CylinderGeometry(R, R * 0.3, 5.2, 22), white, -len / 2 - 2.6, yc + 0.35, 0, 0, 0, Math.PI / 2 + 0.06);
  add(new THREE.BoxGeometry(0.9, 0.3, 1.5), glassM, len / 2 + 0.9, yc + 0.62, 0, 0, 0, -0.45);
  for (const s of [-1, 1]) {
    for (let i = 0; i < 7; i++) add(new THREE.CylinderGeometry(0.17, 0.17, 0.06, 12), glassM, -len / 2 + 2.2 + i * 1.35, yc + 0.32, s * (R - 0.01), Math.PI / 2);
    add(new THREE.BoxGeometry(len + 3, 0.1, 0.03), gold, -0.6, yc - 0.12, s * (R + 0.002));
    // engines on the tail and their pylons
    add(new THREE.CylinderGeometry(0.62, 0.52, 3.3, 18), grey, -len / 2 - 0.6, yc + 0.75, s * (R + 0.8), 0, 0, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.5, 0.5, 0.06, 18), dark, -len / 2 + 1.07, yc + 0.75, s * (R + 0.8), 0, 0, Math.PI / 2);
    add(new THREE.BoxGeometry(1.2, 0.2, 0.7), white, -len / 2 - 0.6, yc + 0.6, s * (R + 0.25));
    // the swept wing with its winglet
    const wing = new THREE.Shape([new THREE.Vector2(1.7, 0), new THREE.Vector2(-1.8, 0), new THREE.Vector2(-3.6, 9.4), new THREE.Vector2(-2.3, 9.4)]);
    const wg = new THREE.ExtrudeGeometry(wing, { depth: 0.22, bevelEnabled: false });
    wg.rotateX(Math.PI / 2);
    const w = add(wg, white, -0.6, yc - 0.7, 0);
    if (s < 0) w.scale.z = -1;
    add(new THREE.BoxGeometry(1.1, 1.3, 0.12), white, -3.2, yc - 0.1, s * 9.35, 0, 0, 0.3);
  }
  const fin = new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(-0.9, 0), new THREE.Vector2(1.7, 0), new THREE.Vector2(0.1, 3.9), new THREE.Vector2(-1.3, 3.9)]), { depth: 0.24, bevelEnabled: false });
  fin.translate(0, 0, -0.12);
  add(fin, white, -len / 2 - 3.6, yc + 0.7, 0);
  add(new THREE.BoxGeometry(1.6, 0.16, 7.2), white, -len / 2 - 4.9, yc + 4.55, 0);
  add(new THREE.BoxGeometry(1.5, 0.5, 0.26), gold, -len / 2 - 3.9, yc + 2.6, 0);
  for (const s of [-1, 1]) {
    const tag = TX.textSign('KIMCHI ONE', { bg: '#f5f5f3', fg: 'gold', serif: true, size: 70, w: 512, h: 96 });
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.68), lambert({ map: tag }));
    decal.position.set(1.6, yc + 0.72, s * (R + 0.015));
    decal.rotation.y = s > 0 ? 0 : Math.PI;
    g.add(decal);
  }
  // gear
  for (const [x, z] of [[len / 2 - 0.8, 0], [-1.2, 1.5], [-1.2, -1.5]]) {
    add(new THREE.CylinderGeometry(0.34, 0.34, 0.3, 14), dark, x, 0.34, z, Math.PI / 2);
    add(new THREE.BoxGeometry(0.12, yc - 1, 0.12), grey, x, (yc - 1) / 2 + 0.6, z);
  }
  // airstair down from the front door on the left, onto a red carpet; aluminium cases waiting
  const doorX = len / 2 - 2.6;
  for (let i = 0; i < 7; i++) add(new THREE.BoxGeometry(0.95, 0.08, 0.32), white, doorX, yc - 0.55 - i * 0.24, -R - 0.18 - i * 0.3);
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.05, 0.6, 2.4), white, doorX + s * 0.5, yc - 1.1, -R - 1.1, -0.68);
  add(new THREE.BoxGeometry(1.4, 0.02, 7), lambert({ color: '#9b111a' }), doorX, 0.02, -R - 5.6);
  for (const [dx, dz, hgt] of [[1.3, -R - 3.2, 0.72], [1.75, -R - 3.25, 0.62], [1.5, -R - 3.9, 0.5]]) {
    add(new THREE.BoxGeometry(0.45, hgt, 0.26), grey, doorX + dx, hgt / 2 + 0.02, dz);
  }
  g.position.set(pl.x * S, 0.04, pl.y * S);
  g.rotation.y = -pl.a;
  group.add(keep(g));
}

// the marina: a wooden pier past the beach and a few yachts riding the swell
export const yachts = [];
function makeYacht(L) {
  const g = new THREE.Group();
  const B = L * 0.24;
  const white = new THREE.MeshStandardMaterial({ color: '#f7f7f5', roughness: 0.25, metalness: 0.05 });
  const navy = lambert({ color: '#1d2b4a' }), glassM = new THREE.MeshStandardMaterial({ color: '#141b24', roughness: 0.1, metalness: 0.6 });
  const teak = lambert({ color: '#a77b4f' });
  const sh = new THREE.Shape();
  sh.moveTo(-L / 2, -B / 2); sh.lineTo(L * 0.2, -B / 2); sh.quadraticCurveTo(L * 0.44, -B * 0.36, L / 2, 0);
  sh.quadraticCurveTo(L * 0.44, B * 0.36, L * 0.2, B / 2); sh.lineTo(-L / 2, B / 2); sh.lineTo(-L / 2, -B / 2);
  const hh = Math.max(1.6, L * 0.09);
  const hullGeo = new THREE.ExtrudeGeometry(sh, { depth: hh, bevelEnabled: false, curveSegments: 8 });
  hullGeo.rotateX(-Math.PI / 2);
  const part = (geo, mat, x, y, z, sx = 1, sy = 1, sz = 1) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.scale.set(sx, sy, sz);
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
    return m;
  };
  part(hullGeo, white, 0, 0, 0);
  part(hullGeo, navy, 0, 0.45, 0, 1.006, 0.18, 1.02);
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  part(box(L * 0.55, 1.5, B * 0.8), white, -L * 0.06, hh + 0.75, 0);
  part(box(L * 0.5, 0.55, B * 0.82), glassM, -L * 0.04, hh + 0.85, 0);
  part(box(L * 0.32, 1.25, B * 0.64), white, -L * 0.12, hh + 2.1, 0);
  part(box(L * 0.27, 0.45, B * 0.66), glassM, -L * 0.1, hh + 2.15, 0);
  part(box(0.25, 1.4, B * 0.5), white, -L * 0.2, hh + 3.3, 0);
  part(box(L * 0.18, 0.06, B * 0.86), teak, -L * 0.4, hh + 0.03, 0);
  return g;
}
function buildMarina(group) {
  const mp = places.marina;
  if (!mp) return;
  const bx0 = Math.floor(mp.b.x / P) * P + 3;
  const px = (bx0 + 5) * TM, z0 = MAP - 0.6, z1 = MAP + 48;
  const pier = new Builder(), wood = col('#8a6a4a'), post = col('#5a4632');
  pier.box(px - 1.6, 0.0, z0, px + 1.6, 0.22, z1, wood);
  for (let z = z0 + 2; z < z1; z += 4) for (const sd of [-1, 1]) pier.box(px + sd * 1.5 - 0.12, -2.6, z - 0.12, px + sd * 1.5 + 0.12, 0.0, z + 0.12, post);
  group.add(keep(pier.mesh(lambert({ vertexColors: true }), { cast: true })));
  for (const [x, z, L, rot] of [[px - 9, MAP + 30, 22, 0.08], [px + 10.5, MAP + 36, 30, -0.05], [px - 11, MAP + 50, 18, 0.15], [px + 9, MAP + 60, 26, 0]]) {
    const y = makeYacht(L);
    y.position.set(x, -1.75, z);
    y.rotation.y = -Math.PI / 2 + rot;
    group.add(keep(y));
    yachts.push({ g: y, base: -1.75, ph: x * 0.37 });
  }
}

// rooftop billboards of Kimchi, each turned toward a place you visit early on
function buildBillboards(group) {
  const targets = [places.home?.door, places.dealer?.door, places.park?.door, places.watches?.door].filter(Boolean);
  const mat = lambert({ map: TX.billboard(null) });
  mat.emissiveMap = mat.map; mat.emissive = new THREE.Color('#ffffff'); mat.emissiveIntensity = 0.3;
  onNight(mat, 'emissiveIntensity', 0.3, 1.1);
  const img = new Image();
  img.onload = () => { const t = TX.billboard(img); mat.map = t; mat.emissiveMap = t; mat.needsUpdate = true; };
  img.src = 'assets/kimchi-hero.webp';
  const backMat = lambert({ color: '#18181a' });
  const used = new Set();
  for (const tp of targets) {
    let best = null, bd = Infinity;
    for (const b of buildings) {
      if (b.place || b.house || used.has(b.id) || buildingHeight(b) < 14) continue;
      const d = Math.hypot((b.x + b.w / 2) * T - tp.x, (b.y + b.h / 2) * T - tp.y);
      if (d < 600 || d > 2400) continue;
      if (d < bd) { bd = d; best = b; }
    }
    if (!best) continue;
    used.add(best.id);
    const top = BASE + buildingHeight(best) + 0.55;
    const cx = (best.x + best.w / 2) * TM, cz = (best.y + best.h / 2) * TM;
    const ang = Math.atan2(tp.x * S - cx, tp.y * S - cz);
    const w = Math.min(14, best.w * TM * 0.8), hh = w / 2;
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, hh), mat);
    panel.position.set(cx, top + 2.2 + hh / 2, cz);
    panel.rotation.y = ang;
    const back = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, hh + 0.3, 0.2), backMat);
    back.position.copy(panel.position); back.rotation.y = ang; back.translateZ(-0.12);
    group.add(keep(panel), keep(back));
    for (const sd of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.25, 2.6, 0.25), backMat);
      leg.position.copy(panel.position); leg.rotation.y = ang;
      leg.translateX(sd * w * 0.35); leg.translateY(-hh / 2 - 1.2); leg.translateZ(-0.12);
      group.add(keep(leg));
    }
  }
}

// ---------- street life ----------

const decks = [], planters = [];   // cafe decks [x0, z0, x1, z1] and the plants in their planters

// The small things that make a street feel lived in, all visual only (nobody bumps into them): cafe terraces
// in front of the shops, benches, bins and hydrants on the sidewalks, hedges and flower beds on the lawns,
// and the beach with Miami's colourful lifeguard towers, striped umbrellas and towels.
function buildStreetLife(group) {
  const B = new Builder(), r = (i, k) => hash(i, k);
  const dark = col('#2d3033'), white = col('#f6f4ee'), wood = col('#b8875a'), wood2 = col('#9c6e46');
  const PARASOL = ['#e5678a', '#2aa39d', '#f0a057', '#f6f4ee', '#4f8fd8', '#f4d98a'];
  const cyl = (x, y, z, rt, rb, h, c, seg = 10) => B.geo(new THREE.CylinderGeometry(rt, rb, h, seg), mat4(x, y + h / 2, z), c);
  // a terrace stays whole in the 64 m piece of its middle (like a building); the small things go where they stand
  const tags = cellTags([B]);

  // cafe terraces: a deck on the lawn in front of each shop row, tables with chairs and parasols
  shopFronts.forEach(({ b, x0, x1, z1 }, n) => {
    const tx0 = b.x, tx1 = b.x + b.w;
    let rows = 0;
    while (rows < 3 && tileAt(Math.floor((tx0 + tx1) / 2), b.y + b.h + rows) === GRASS) rows++;
    if (!rows) return;
    const d0 = z1 + 1.5, d1 = z1 + rows * TM - 0.2;
    if (d1 - d0 < 1.6) return;
    tags.at(pieceKey((x0 + x1) / 2, (z1 + d1) / 2));
    B.box(x0 + 0.6, BASE - 0.02, z1 + 0.05, x1 - 0.6, BASE + 0.1, d1, wood2);
    decks.push([x0, z1, x1, d1]);
    for (let x = x0 + 0.4; x < x1 - 0.6; x += 0.5) B.box(x, BASE + 0.1, z1 + 0.05, x + 0.44, BASE + 0.12, d1, wood);
    // planters along the edge
    for (let x = x0 + 1; x < x1 - 1; x += 2.2) {
      B.box(x - 0.35, BASE + 0.1, d1 - 0.45, x + 0.35, BASE + 0.55, d1 - 0.05, white);
      planters.push({ name: 'Plant_1_Big', x, y: BASE + 0.55, z: d1 - 0.25, rot: x, s: 0.42 });
    }
    for (let x = x0 + 2; x < x1 - 1.5; x += 3.1) {
      const z = (d0 + d1 - 0.5) / 2, pc = col(PARASOL[Math.floor(r(b.id * 7 + Math.round(x), 3) * PARASOL.length)]);
      cyl(x, BASE + 0.1, z, 0.42, 0.42, 0.04, white, 16);                    // table top
      B.box(x - 0.03, BASE + 0.1, z - 0.03, x + 0.03, BASE + 0.82, z + 0.03, dark);
      B.box(x - 0.03, BASE + 0.82, z - 0.03, x + 0.03, BASE + 2.4, z + 0.03, white);
      cyl(x, BASE + 0.82, z, 0.42, 0.42, 0.04, white, 16);
      B.geo(new THREE.ConeGeometry(1.35, 0.5, 10), mat4(x, BASE + 2.55, z), pc);
      for (const [dx, dz] of [[-0.7, 0], [0.7, 0], [0, -0.7], [0, 0.7]]) {
        const cx = x + dx, cz = z + dz;
        B.box(cx - 0.2, BASE + 0.1, cz - 0.2, cx + 0.2, BASE + 0.52, cz + 0.2, dark, { top: false });
        B.box(cx - 0.22, BASE + 0.5, cz - 0.22, cx + 0.22, BASE + 0.56, cz + 0.22, pc);
      }
    }
  });

  tags.at(null);

  // sidewalk furniture: benches, bins, hydrants (between the palms)
  for (let ty = 0; ty < N; ty++) for (let tx = 0; tx < N; tx++) {
    if (tileAt(tx, ty) !== WALK) continue;
    const mx = tx % P, my = ty % P;
    const ex = mx === 2 ? 0 : mx === P - 1 ? 1 : null, ez = my === 2 ? 0 : my === P - 1 ? 1 : null;
    if ((ex === null) === (ez === null)) continue;
    const along = ex !== null ? my : mx, i = tx * 131 + ty;
    const x = tx * TM + (ex !== null ? (ex ? TM - 0.8 : 0.8) : TM / 2), z = ty * TM + (ez !== null ? (ez ? TM - 0.8 : 0.8) : TM / 2);
    const y = surfaceY(x / S, z / S);
    const rot = ex !== null ? Math.PI / 2 : 0;
    if (along % 6 === 1 && r(i, 41) < 0.7) {                                      // bench, facing the street
      const m = (dx, dy, dz, sx, sy, sz, c) => B.geo(new THREE.BoxGeometry(sx, sy, sz), mat4(x + (ex !== null ? dz * (ex ? 1 : -1) : dx), y + dy, z + (ex !== null ? dx : dz * (ez ? 1 : -1)), 0, rot, 0), c);
      m(0, 0.45, 0, 1.8, 0.08, 0.45, wood); m(0, 0.75, -0.24, 1.8, 0.4, 0.06, wood);
      for (const s of [-0.75, 0.75]) m(s, 0.22, 0, 0.08, 0.45, 0.42, dark);
    } else if (along % 6 === 4 && r(i, 42) < 0.6) {                               // bin
      cyl(x, y, z, 0.26, 0.24, 0.85, col('#2f6b4f'), 12); cyl(x, y + 0.85, z, 0.28, 0.28, 0.06, dark, 12);
    } else if (along === 5 && r(i, 43) < 0.35) {                                  // hydrant
      cyl(x, y, z, 0.13, 0.15, 0.55, col('#d6352b'), 10); B.geo(new THREE.SphereGeometry(0.14, 10, 6), mat4(x, y + 0.56, z), col('#d6352b'));
      B.box(x - 0.2, y + 0.33, z - 0.05, x + 0.2, y + 0.42, z + 0.05, col('#c0262b'));
    }
  }

  // the beach: lifeguard towers, umbrellas and towels on the sand all around the island
  const beachY = (o) => OUT + (-1.4 - OUT) * Math.min(1, o / 22);
  const TOWER = ['#f5a1b8', '#7fd6cf', '#f6d36b', '#a7c7f0', '#f6a26b'];
  const UMB = ['#e5678a', '#2aa39d', '#f0a057', '#4f8fd8', '#f4d98a', '#ff5252'];
  const edges = [[(t) => [t, -12], 0], [(t) => [t, MAP + 12], Math.PI], [(t) => [-12, t], Math.PI / 2], [(t) => [MAP + 12, t], -Math.PI / 2]];
  edges.forEach(([at, rot], e) => {
    for (let t = 30, k = 0; t < MAP - 20; t += 9, k++) {
      const [x, z] = at(t);
      const i = e * 1000 + k, o = 6 + (r(i, 60) - 0.5) * 3, y = beachY(o);
      const [px, pz] = e < 2 ? [x, e === 0 ? -o : MAP + o] : [e === 2 ? -o : MAP + o, z];
      if (k % 9 === 4) {          // a lifeguard tower on stilts with a ramp
        const tc = col(TOWER[(e * 3 + k) % TOWER.length]), yy = beachY(8);
        const [tx, tz] = e < 2 ? [x, e === 0 ? -8 : MAP + 8] : [e === 2 ? -8 : MAP + 8, z];
        for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) B.box(tx + dx * 1.1 - 0.08, yy, tz + dz * 1.1 - 0.08, tx + dx * 1.1 + 0.08, yy + 2.0, tz + dz * 1.1 + 0.08, white);
        B.box(tx - 1.6, yy + 2.0, tz - 1.6, tx + 1.6, yy + 2.15, tz + 1.6, white);
        B.box(tx - 1.2, yy + 2.15, tz - 1.2, tx + 1.2, yy + 3.9, tz + 1.2, tc);
        B.box(tx - 1.0, yy + 2.9, tz - 1.25, tx + 1.0, yy + 3.6, tz + 1.25, col('#2a4a5c'));
        B.geo(new THREE.ConeGeometry(1.9, 0.9, 4), mat4(tx, yy + 4.35, tz, 0, Math.PI / 4, 0), col('#f6f4ee'));
        B.geo(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 6), mat4(tx, yy + 5.5, tz), dark);
        B.geo(new THREE.BoxGeometry(0.02, 0.4, 0.6), mat4(tx, yy + 6.1, tz + 0.3), col('#ff5252'));
        continue;
      }
      if (r(i, 61) < 0.45) continue;
      const uc = col(UMB[Math.floor(r(i, 62) * UMB.length)]);
      B.box(px - 0.03, y, pz - 0.03, px + 0.03, y + 2.2, pz + 0.03, white);
      const cone = new THREE.ConeGeometry(1.4, 0.55, 12, 1, true);
      const cc = [];
      for (let v = 0; v < cone.attributes.position.count; v++) {
        const a = Math.atan2(cone.attributes.position.getZ(v), cone.attributes.position.getX(v));
        const c = (Math.floor(((a + Math.PI) / (Math.PI * 2)) * 12) % 2) ? white : uc;
        cc.push(c.r, c.g, c.b);
      }
      cone.setAttribute('color', new THREE.Float32BufferAttribute(cc, 3));
      B.geo(cone, mat4(px, y + 2.35, pz, 0, r(i, 63) * 3, 0));
      for (let tw = 0; tw < 2; tw++) {
        const a = rot + (tw ? 0.4 : -0.4), d = 1.5;
        const cx = px + Math.cos(a) * d, cz = pz + Math.sin(a) * d;
        B.geo(new THREE.BoxGeometry(0.8, 0.03, 1.8), mat4(cx, y + 0.02, cz, 0, a + Math.PI / 2, 0), col(UMB[Math.floor(r(i + tw, 64) * UMB.length)]));
      }
    }
  });
  // a mesh per 64 m quarter of each 128 m cell of the 'street' layer: drawn out to STREET_FAR (where the
  // camera's view reaches it), casting while its cell is within CAST_R of the shadow focus
  for (const m of cellPieces(B, lambert({ vertexColors: true }), { layer: 'street', tags })) group.add(m);
}

// Where the asset-pack plants go (src/3d/scatter3d.js): lawns full of grass tufts, clover, flowers and ferns,
// flowering bushes along the sidewalks, trees in the parks, rocks and beach grass along the shore.
function natureSpots() {
  const out = [...planters], r = (i, k) => hash(i, k);
  const pick = (list, u) => { let t = u * list.reduce((a, b) => a + b[1], 0); for (const [n, w] of list) { if ((t -= w) <= 0) return n; } return list[0][0]; };
  const GRASS_KINDS = [['Grass_Common_Short', 6], ['Grass_Wispy_Short', 2], ['Grass_Common_Tall', 1], ['Clover_1', 2]];
  const ACCENTS = [['Flower_3_Group', 3], ['Flower_4_Group', 3], ['Fern_1', 2], ['Plant_1', 1], ['Plant_7_Big', 1]];
  const onDeck = (x, z) => decks.some(([a, b, c, d]) => x > a - 0.3 && x < c + 0.3 && z > b - 0.3 && z < d + 0.3);
  const parks = deco.filter(d => d.kind === 'fountain').map(d => [d.x * S, d.y * S]);
  for (let ty = 1; ty < N - 1; ty++) for (let tx = 1; tx < N - 1; tx++) {
    if (tileAt(tx, ty) !== GRASS) continue;
    const i = tx * 977 + ty * 13, x0 = tx * TM, z0 = ty * TM, y = H[GRASS];
    const nW = tileAt(tx - 1, ty) === WALK, nE = tileAt(tx + 1, ty) === WALK, nN = tileAt(tx, ty - 1) === WALK, nS = tileAt(tx, ty + 1) === WALK;
    const at = (u, v) => [x0 + u * TM, z0 + v * TM];
    const n = 12 + Math.floor(r(i, 1) * 8);
    for (let k = 0; k < n; k++) {
      const [x, z] = at(r(i + k, 2), r(i + k, 3));
      if (onDeck(x, z)) continue;
      out.push({ name: pick(GRASS_KINDS, r(i + k, 4)), x, y, z, rot: r(i + k, 5) * 6.28, s: 0.38 + r(i + k, 6) * 0.25 });
    }
    if (r(i, 7) < 0.55) {
      const [x, z] = at(0.2 + r(i, 8) * 0.6, 0.2 + r(i, 9) * 0.6);
      if (!onDeck(x, z)) out.push({ name: pick(ACCENTS, r(i, 10)), x, y, z, rot: r(i, 11) * 6.28, s: 0.32 + r(i, 12) * 0.16 });
    }
    // flowering bushes along the sidewalk edge
    if ((nW || nE || nN || nS) && r(i, 13) < 0.6) {
      for (let k = 0; k < 2; k++) {
        const u = (k + 0.25 + r(i + k, 14) * 0.5) / 2;
        const x = nW ? x0 + 0.6 : nE ? x0 + TM - 0.6 : x0 + u * TM, z = nN ? z0 + 0.6 : nS ? z0 + TM - 0.6 : z0 + u * TM;
        if (onDeck(x, z)) continue;
        // (the pack's plain bush is autumn red; the flowering one and the big leafy plant are the greens)
        out.push({ name: r(i + k, 15) < 0.65 ? 'Bush_Common_Flowers' : 'Plant_1_Big', x, y, z, rot: r(i + k, 16) * 6.28, s: 0.5 + r(i + k, 17) * 0.25 });
      }
    }
    if (r(i, 18) < 0.04) out.push({ name: ['Rock_Medium_1', 'Rock_Medium_2', 'Pebble_Round_1'][Math.floor(r(i, 19) * 3)], ...(([x, z]) => ({ x, z }))(at(r(i, 20), r(i, 21))), y, rot: r(i, 22) * 6.28, s: 0.25 + r(i, 23) * 0.2 });
    // shade trees in the parks
    const inPark = parks.some(([px, pz]) => Math.hypot(px - (x0 + 2), pz - (z0 + 2)) < 22);
    if (inPark && r(i, 24) < 0.18) {
      const [x, z] = at(0.3 + r(i, 25) * 0.4, 0.3 + r(i, 26) * 0.4);
      if (parks.every(([px, pz]) => Math.hypot(px - x, pz - z) > 7)) out.push({ name: ['CommonTree_1', 'CommonTree_3', 'CommonTree_5'][Math.floor(r(i, 27) * 3)], x, y, z, rot: r(i, 28) * 6.28, s: 0.75 + r(i, 29) * 0.25 });
    }
  }
  // the shore: rocks at the waterline, dune grass by the road
  const beachY = (o) => OUT + (-1.4 - OUT) * Math.min(1, o / 22);
  for (let e = 0; e < 4; e++) for (let t = 10, k = 0; t < MAP - 10; t += 6, k++) {
    const i = e * 5000 + k;
    const place = (o, d) => e === 0 ? [t + d, -o] : e === 1 ? [t + d, MAP + o] : e === 2 ? [-o, t + d] : [MAP + o, t + d];
    if (r(i, 30) < 0.5) {
      const o = 2 + r(i, 31) * 2.5, [x, z] = place(o, r(i, 32) * 4);
      out.push({ name: r(i, 33) < 0.5 ? 'Grass_Wispy_Tall' : 'Grass_Wispy_Short', x, y: beachY(o), z, rot: r(i, 34) * 6.28, s: 0.35 + r(i, 35) * 0.2 });
    }
    if (r(i, 36) < 0.22) {
      const o = 10.5 + r(i, 37) * 2.5, [x, z] = place(o, r(i, 38) * 4);
      out.push({ name: ['Rock_Medium_1', 'Rock_Medium_2', 'Rock_Medium_3'][Math.floor(r(i, 39) * 3)], x, y: beachY(o) - 0.15, z, rot: r(i, 40) * 6.28, s: 0.35 + r(i, 41) * 0.45 });
    }
  }
  return out;
}

// traffic lights on the corners where the crossings are (KayKit, CC0)
function streetSpots() {
  const out = [];
  for (let by = 0; by * P < N; by++) for (let bx = 0; bx * P < N; bx++) {
    for (const [lx, ly, rot] of [[2, 2, Math.PI * 0.75], [P - 1, P - 1, -Math.PI * 0.25]]) {
      const tx = bx * P + lx, ty = by * P + ly;
      if (tileAt(tx, ty) !== WALK) continue;
      const x = (tx + (lx === 2 ? 0.2 : 0.8)) * TM, z = (ty + (ly === 2 ? 0.2 : 0.8)) * TM;
      out.push({ name: 'trafficlight_A', x, y: surfaceY(x / S, z / S), z, rot, s: 5.2 });
    }
  }
  return out;
}

async function loadScatter(group) {
  const [nature, street] = await Promise.all([loadAssetPack('assets/nature.glb'), loadAssetPack('assets/street.glb')]);
  const far = { far: 140, shadow: true };
  const a = makeScatter(group, nature, natureSpots(), {
    Grass_Common_Short: { far: 48 }, Grass_Wispy_Short: { far: 48 }, Grass_Common_Tall: { far: 60 }, Grass_Wispy_Tall: { far: 75 },
    Clover_1: { far: 45 }, Flower_3_Group: { far: 80 }, Flower_4_Group: { far: 80 }, Fern_1: { far: 70 }, Plant_1: { far: 60 },
    Plant_7_Big: { far: 60 }, Plant_1_Big: { far: 90 }, Bush_Common: far, Bush_Common_Flowers: far,
    Rock_Medium_1: far, Rock_Medium_2: far, Rock_Medium_3: far, Pebble_Round_1: { far: 50 },
    CommonTree_1: { far: 260, shadow: true }, CommonTree_3: { far: 260, shadow: true }, CommonTree_5: { far: 260, shadow: true },
  });
  const b = makeScatter(group, street, streetSpots(), { trafficlight_A: { far: 160, shadow: true } });
  return { update(cam, t) { a.update(cam, t); b.update(cam, t); } };
}
