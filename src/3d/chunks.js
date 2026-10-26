// The chunk manager (docs/map-v2-spec.md §7 and §11.1): what the city draws near the camera and what it
// leaves out, so a 2 x 1.8 km county costs about what a small town does.
//
//  - add(obj, { tile | cell | box, layer, far, near, castR }) registers a built mesh or group that belongs to
//    a 256 m tile (terrain, roads, building shells) or a 128 m cell (detail, props). It is drawn while the
//    camera is within its layer's far distance of the tile, with hysteresis so it does not flicker at the edge,
//    and it casts shadows only while the shadow focus (the player) is within castR (110 m) of the tile.
//  - lazy(cellKey, buildGen, { within, drop, layer }) registers a cell that is built only when needed: once
//    the camera, or where the camera will be in the next 3 s at its current speed, comes within `within`
//    (default: the layer's far, 'detail' unless given, read each frame so setFar() reaches it). Builds run
//    from a queue in slices of budgetMs (3 ms) a frame, the cells along that stretch of road first;
//    buildGen(key, box) returns the built object, or is a generator function that yields between pieces of
//    work and returns it, so one big cell spreads over several frames. A built cell is drawn from `drop`
//    (within + 40 m) in to the camera and until 20 m past drop on the way out, then kept (hidden) until the
//    cache of 36 built cells needs its place: the least recently used one not in use is then removed and
//    its geometry disposed. A cell is in use while drawn or while the camera or its 3 s look-ahead is
//    within `drop`, so when more than 36 are in use (High's 300 m detail) the cache runs over rather than
//    throw away cells it has just built. Materials are shared and never disposed here; a cell with its own
//    textures puts a function in obj.userData.dispose to free them.
//  - buildAround(xm, zm, r) builds every lazy cell within r at once (the spawn area, so the first frame is whole).
//  - update(camera, focus, dt) once a frame; stats() for the bench; setFar(layer, m) to retune a layer.
//
// Below the manager: 64 m buckets and near-first shadow casting for instanced copies (palms3d, scatter3d).
// None of it imports three: it only reads positions and sets visible / castShadow / count on what it is
// given, so it also runs (and is tested) in node.

export const TILE = 256;   // m: terrain, roads and building shells
export const CELL = 128;   // m: building detail, props, palms and scatter

// How far each layer is drawn (m from the camera to the nearest point of its tile), and the hysteresis: a
// drawn object stays until the camera is `hyst` past the edge. `near` hides an object closer than that, for
// the far terrain that gives way to the fine grid. A layer not listed is drawn at any distance unless add()
// gives it a far.
export const LAYERS = {
  terrain: { far: Infinity },            // the far terrain grid and anything always in view
  lod0: { far: 350, hyst: 20 },          // the 2 m terrain grid near the camera
  lod1: { near: 350, hyst: 20 },         // the 8 m grid wherever lod0 is not drawn
  roads: { far: 400 },                   // road ribbons, junctions and their paint
  shells: { far: Infinity },             // building shells: always resident, the fog hides the far ones
  detail: { far: 220 },                  // building detail cells (300 on the High level)
  props: { far: 220 },
  street: { far: 180 },                  // the grid's street life
  scatter: { far: 140 },
};
const HYST = 20;           // m: default hysteresis on far and near
const CAST_HYST = 10;      // m: hysteresis on the shadow caster radius
const LOOKAHEAD = 3;       // s of camera velocity the build queue looks ahead
const AHEAD_STEPS = 4;     // points along the look-ahead the queue measures from (besides the camera)
const TELEPORT = 60;       // m in one frame: a jump, not a drive (the velocity starts again from rest)
const MOVE2 = 1;           // m^2: below this much movement the drawn set is not looked at again

// the rectangle [x0, z0, x1, z1] (m) of a 'tx,tz' key of the given size
export function keyBox(key, size) {
  const [x, z] = String(key).split(',').map(Number);
  return [x * size, z * size, (x + 1) * size, (z + 1) * size];
}
export const tileKey = (xm, zm) => `${Math.floor(xm / TILE)},${Math.floor(zm / TILE)}`;
export const cellKey = (xm, zm) => `${Math.floor(xm / CELL)},${Math.floor(zm / CELL)}`;

// distance (m, on the ground plane) from a point to a rectangle; 0 inside
function boxDist(b, x, z) {
  const dx = x < b[0] ? b[0] - x : x > b[2] ? x - b[2] : 0;
  const dz = z < b[1] ? b[1] - z : z > b[3] ? z - b[3] : 0;
  return Math.sqrt(dx * dx + dz * dz);
}

// The rectangle an object covers: its tile or cell, a box given outright, or the ground footprint of its
// geometry's bounding sphere. Objects with nothing to go on count as everywhere.
function boxOf(obj, o) {
  if (o.box) return o.box;
  if (o.tile != null) return keyBox(o.tile, TILE);
  if (o.cell != null) return keyBox(o.cell, CELL);
  const g = obj.geometry;
  if (g) {
    if (!g.boundingSphere && g.computeBoundingSphere) g.computeBoundingSphere();
    const s = g.boundingSphere, p = obj.position || { x: 0, z: 0 };
    if (s) return [s.center.x + p.x - s.radius, s.center.z + p.z - s.radius, s.center.x + p.x + s.radius, s.center.z + p.z + s.radius];
  }
  return [-Infinity, -Infinity, Infinity, Infinity];
}

// the meshes under obj that were made to cast shadows (only those are ever switched)
function castersOf(obj) {
  const out = [];
  const visit = (o) => { if (o.castShadow) out.push(o); };
  if (obj.traverse) obj.traverse(visit); else visit(obj);
  return out;
}

// free a removed cell's GPU memory: geometries and instance buffers, not the shared materials (nor a
// geometry marked userData.shared, such as a model many cells draw instances of)
function disposeObj(obj) {
  const seen = new Set();
  const visit = (o) => {
    if (o.isInstancedMesh && o.dispose) o.dispose();
    const g = o.geometry;
    if (g && !seen.has(g) && !g.userData?.shared) { seen.add(g); g.dispose?.(); }
    if (typeof o.userData?.dispose === 'function') o.userData.dispose(o);
  };
  if (obj.traverse) obj.traverse(visit); else visit(obj);
}

const now = () => performance.now();

export function makeChunkManager(scene, { budgetMs = 3, maxCells = 36, castR = 110, layers = {} } = {}) {
  const L = {};
  for (const k of new Set([...Object.keys(LAYERS), ...Object.keys(layers)])) L[k] = { ...LAYERS[k], ...layers[k] };

  const entries = [];          // add()ed objects: { obj, box, far, near, hyst, castR, casters, on, cast }
  const cells = new Map();     // lazy cells by key: { key, box, gen, o, lay, within, drop, castR, state, it, obj, on,
                               //   used, done, d, da, pri }
  const queue = [];            // cells waiting for (or in the middle of) their build
  const cam = { x: 0, z: 0, vx: 0, vz: 0, have: false };
  const last = { x: Infinity, z: Infinity, fx: Infinity, fz: Infinity };
  let dirty = true;
  let built = 0, peak = 0, builds = 0, evictions = 0, aborted = 0;
  let sliceMs = 0, maxSliceMs = 0, sliceSum = 0, slices = 0;

  function place(obj) { if (!obj.parent && scene) scene.add(obj); }

  // shown or hidden by distance, with hysteresis on both edges (lod0 and lod1 overlap, never leave a hole).
  // The distances come from add()'s options, else the layer's (read each time, so setFar() takes effect).
  function wanted(e, d) {
    const far = e.far ?? e.lay.far ?? Infinity, near = e.near ?? e.lay.near ?? 0, h = e.hyst ?? e.lay.hyst ?? HYST;
    return e.on ? d <= far + h && d >= near - h : d < far && d >= near;
  }
  function setCast(e, on) {
    if (e.cast === on) return;
    e.cast = on;
    for (const m of e.casters) m.castShadow = on;
  }

  // ---------- add: objects already built ----------

  function add(obj, o = {}) {
    if (o.layer && !L[o.layer]) L[o.layer] = {};
    const e = {
      obj, box: boxOf(obj, o), layer: o.layer, lay: L[o.layer] || {}, far: o.far, near: o.near, hyst: o.hyst,
      castR: o.castR ?? castR, casters: castersOf(obj), on: obj.visible !== false, cast: true,
    };
    entries.push(e);
    place(obj);
    dirty = true;
    return e;
  }

  function remove(obj) {
    const i = entries.findIndex(e => e.obj === obj);
    if (i < 0) return false;
    const [e] = entries.splice(i, 1);
    setCast(e, true);
    e.obj.parent?.remove(e.obj);
    return true;
  }

  // ---------- lazy cells ----------

  function lazy(key, buildGen, o = {}) {
    const layer = o.layer || 'detail';
    if (!L[layer]) L[layer] = {};
    const c = { key, box: o.box || keyBox(key, o.size || CELL), gen: buildGen, o, lay: L[layer], within: 0, drop: 0,
      castR: o.castR ?? castR, state: 'idle', it: null, obj: null, on: false, casters: [], cast: true, used: -1, done: -1,
      d: Infinity, da: Infinity, pri: Infinity };
    reach(c);
    const old = cells.get(key);
    if (old) evict(old);
    cells.set(key, c);
    dirty = true;
    return c;
  }
  // a cell's build and keep distances: its own, else its layer's far as it is now
  function reach(c) {
    c.within = c.o.within ?? c.lay.far ?? Infinity;
    c.drop = Math.max(c.within, c.o.drop ?? c.within + HYST * 2);
  }
  // drawn or hidden: on at drop, off only 20 m past it, so a camera hovering at the edge does not flicker it
  function showCell(c, on) {
    c.on = on;
    if (c.obj && c.obj.visible !== on) c.obj.visible = on;
  }

  // one step of a cell's build: true once it is finished (or abandoned)
  function step(c) {
    if (c.state === 'queued') {
      const r = c.gen(c.key, c.box);
      if (r && typeof r.next === 'function') { c.it = r; c.state = 'building'; return false; }
      finish(c, r);
      return true;
    }
    const r = c.it.next();
    if (!r.done) return false;
    finish(c, r.value);
    return true;
  }
  function finish(c, obj) {
    c.it = null; c.state = 'built'; c.obj = obj || null; c.used = clock; c.done = clock; c.on = false;
    c.casters = obj ? castersOf(obj) : []; c.cast = true;
    if (obj) { obj.visible = false; place(obj); }
    built++; builds++;
    if (built > peak) peak = built;
    trim();
  }
  function evict(c) {
    if (c.state === 'queued' || c.state === 'building') aborted++;
    if (c.state === 'building' && c.it?.return) c.it.return();
    if (c.obj) { c.obj.parent?.remove(c.obj); disposeObj(c.obj); }
    if (c.state === 'built') { built--; evictions++; }
    const qi = queue.indexOf(c);
    if (qi >= 0) queue.splice(qi, 1);
    c.state = 'idle'; c.it = null; c.obj = null; c.casters = []; c.on = false;
  }
  // A built cell is in use while it is drawn, while the camera or its look-ahead is within its drop distance
  // (the look-ahead built it for a reason), or on the tick it was finished.
  const inUse = (c) => c.on || c.d <= c.drop || c.da <= c.drop || c.done === clock;
  // keep at most maxCells built: drop the least recently used of those not in use
  function trim() {
    while (built > maxCells) {
      let worst = null;
      for (const c of cells.values()) {
        if (c.state !== 'built' || inUse(c)) continue;
        if (!worst || c.used < worst.used) worst = c;
      }
      if (!worst) break;          // every built cell is in use: the cache runs over until some fall behind
      evict(worst);
    }
  }

  function buildNow(c) {
    if (c.state === 'idle') { c.state = 'queued'; queue.push(c); }
    while (!step(c)) { /* run it to the end */ }
    const qi = queue.indexOf(c);
    if (qi >= 0) queue.splice(qi, 1);
  }

  function buildAround(xm, zm, r) {
    let n = 0;
    for (const c of cells.values()) {
      const d = boxDist(c.box, xm, zm);
      if (c.state === 'built' || d > r) continue;
      c.d = d; c.da = d;          // counts as in range until the next update looks again
      buildNow(c); n++;
    }
    dirty = true;
    return n;
  }

  // ---------- once a frame ----------

  let clock = 0;
  function update(camera, focus, dt = 0) {
    clock++;
    const p = camera.position, fx = focus ? focus.x : p.x, fz = focus ? focus.z : p.z;
    // camera velocity (smoothed), for the build queue's look-ahead
    if (cam.have && dt > 0) {
      const dx = p.x - cam.x, dz = p.z - cam.z;
      if (dx * dx + dz * dz > TELEPORT * TELEPORT) { cam.vx = 0; cam.vz = 0; }
      else { const k = 1 - Math.exp(-dt * 4); cam.vx += (dx / dt - cam.vx) * k; cam.vz += (dz / dt - cam.vz) * k; }
    }
    cam.x = p.x; cam.z = p.z; cam.have = true;
    const ax = cam.vx * LOOKAHEAD, az = cam.vz * LOOKAHEAD;

    const moved = (p.x - last.x) ** 2 + (p.z - last.z) ** 2 > MOVE2 || (fx - last.fx) ** 2 + (fz - last.fz) ** 2 > MOVE2;
    if (moved || dirty) {
      last.x = p.x; last.z = p.z; last.fx = fx; last.fz = fz; dirty = false;
      for (const e of entries) {
        const on = wanted(e, boxDist(e.box, p.x, p.z));
        if (on !== e.on) { e.on = on; e.obj.visible = on; }
        if (e.casters.length) {
          const d = boxDist(e.box, fx, fz);
          setCast(e, e.cast ? d <= e.castR + CAST_HYST : d <= e.castR);
        }
      }
    }

    // lazy cells: which to build, which to show, which may go. A cell's priority is its distance from the
    // stretch of road the camera covers in the next 3 s (so cells ahead come before cells behind), and
    // among equals the nearer to the camera now.
    for (const c of cells.values()) {
      const d = boxDist(c.box, p.x, p.z);
      let da = d;
      for (let k = 1; k <= AHEAD_STEPS && da > 0; k++) da = Math.min(da, boxDist(c.box, p.x + ax * k / AHEAD_STEPS, p.z + az * k / AHEAD_STEPS));
      reach(c);
      c.d = d; c.da = da;
      c.pri = da + d * 1e-3;
      if (c.state === 'idle' && da <= c.within) { c.state = 'queued'; queue.push(c); }
      else if ((c.state === 'queued' || c.state === 'building') && da > c.drop) evict(c);
      if (c.state !== 'built') continue;
      const show = c.on ? d <= c.drop + HYST : d <= c.drop;
      if (show !== c.on) showCell(c, show);
      if (show || da <= c.drop) c.used = clock;
      if (c.casters.length) {
        const df = boxDist(c.box, fx, fz), cast = c.cast ? df <= c.castR + CAST_HYST : df <= c.castR;
        if (cast !== c.cast) { c.cast = cast; for (const m of c.casters) m.castShadow = cast; }
      }
    }
    trim();
    runQueue();
  }

  // build from the queue until this frame's slice is spent (at least one step, so it always moves on)
  function runQueue() {
    if (!queue.length) { sliceMs = 0; return; }
    queue.sort((a, b) => a.pri - b.pri);
    const t0 = now();
    let t = t0;
    while (queue.length && (t === t0 || t - t0 < budgetMs)) {
      const c = queue[0];
      // finished: take out that cell itself (finishing may already have moved the queue, so not by position)
      if (step(c)) { const i = queue.indexOf(c); if (i >= 0) queue.splice(i, 1); }
      t = now();
    }
    sliceMs = t - t0; sliceSum += sliceMs; slices++;
    if (sliceMs > maxSliceMs) maxSliceMs = sliceMs;
    // a just-built cell in range shows on this frame rather than the next
    for (const c of cells.values()) if (c.state === 'built' && !c.on && c.d <= c.drop) { showCell(c, true); c.used = clock; }
  }

  function stats() {
    let visible = 0, casting = 0, shown = 0, queued = 0, building = 0;
    for (const e of entries) { if (e.on) visible++; if (e.casters.length && e.cast) casting++; }
    for (const c of cells.values()) {
      if (c.state === 'built' && c.obj?.visible) shown++;
      else if (c.state === 'queued') queued++;
      else if (c.state === 'building') building++;
    }
    return {
      objects: entries.length, visible, casting, cells: cells.size, built, shown, queued, building, waiting: queue.length, peak, maxCells,
      builds, evictions, aborted, sliceMs, maxSliceMs, avgSliceMs: slices ? sliceSum / slices : 0, budgetMs,
      speed: Math.hypot(cam.vx, cam.vz),
    };
  }

  // draw a layer out to another distance (the High level's 300 m detail, the Low tier's shorter scatter)
  function setFar(layer, far) {
    (L[layer] ||= {}).far = far;
    dirty = true;
  }

  // take everything back out of the scene and free the lazy cells
  function dispose() {
    for (const c of cells.values()) evict(c);
    cells.clear(); queue.length = 0;
    for (const e of entries) e.obj.parent?.remove(e.obj);
    entries.length = 0;
  }

  return { add, remove, lazy, update, buildAround, stats, setFar, dispose, layers: L };
}

// ---------- buckets, for instanced things scattered over the map ----------

export const BUCKET = 64;   // m

// Items ({ x, z, ... } in metres) sorted into square buckets, so a frame looks only at the buckets within
// reach instead of every item. near(x, z, r, out) fills out with the item lists of the buckets that come
// within r of (x, z), row by row; inside a bucket the items keep their order.
export function makeBuckets(items, size = BUCKET) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const it of items) {
    if (it.x < x0) x0 = it.x; if (it.x > x1) x1 = it.x;
    if (it.z < z0) z0 = it.z; if (it.z > z1) z1 = it.z;
  }
  if (!items.length) x0 = z0 = x1 = z1 = 0;
  const cols = Math.floor((x1 - x0) / size) + 1, rows = Math.floor((z1 - z0) / size) + 1;
  const lists = new Array(cols * rows).fill(null);
  for (const it of items) {
    const k = Math.floor((it.z - z0) / size) * cols + Math.floor((it.x - x0) / size);
    (lists[k] ||= []).push(it);
  }
  return {
    size, cols, rows, x0, z0, lists,
    near(x, z, r, out = []) {
      out.length = 0;
      const i0 = Math.max(0, Math.floor((x - r - x0) / size)), i1 = Math.min(cols - 1, Math.floor((x + r - x0) / size));
      const j0 = Math.max(0, Math.floor((z - r - z0) / size)), j1 = Math.min(rows - 1, Math.floor((z + r - z0) / size));
      for (let j = j0; j <= j1; j++) {
        const bz = z0 + j * size, dz = z < bz ? bz - z : z > bz + size ? z - bz - size : 0;
        for (let i = i0; i <= i1; i++) {
          const list = lists[j * cols + i];
          if (!list) continue;
          const bx = x0 + i * size, dx = x < bx ? bx - x : x > bx + size ? x - bx - size : 0;
          if (dx * dx + dz * dz <= r * r) out.push(list);
        }
      }
      return out;
    },
  };
}

// ---------- shadow casting for instances ----------

export const INSTANCE_CAST_R = 60;   // m: scatter and palm copies cast shadows only this close (spec §11.1)

// Where the sun's shadow box is centred this frame (sky.js keeps it on the player): the target of the first
// shadow-casting directional light in obj's scene. Returns a function that answers { x, z } or null while
// there is no such light; the light is looked up once and then only read.
export function shadowFocus(obj) {
  let light = null, wait = 0;
  return () => {
    if (light && !light.parent) light = null;
    if (!light && wait-- <= 0) {
      wait = 60;
      let root = obj;
      while (root.parent) root = root.parent;
      root.traverse?.((o) => { if (!light && o.isDirectionalLight && o.castShadow) light = o; });
    }
    return light ? light.target.position : null;
  };
}

// An InstancedMesh whose first nCast copies (the near ones, written first) are all the shadow pass draws:
// three.js calls onBeforeShadow right before the mesh's shadow draw, which reads count, and onAfterShadow
// right after, so the scene pass still draws all nAll copies. No second mesh and no extra draw call.
export function castFirst(mesh) {
  mesh.userData.nCast = 0; mesh.userData.nAll = 0;
  mesh.onBeforeShadow = function () { this.count = this.userData.nCast; };
  mesh.onAfterShadow = function () { this.count = this.userData.nAll; };
  return mesh;
}
// after writing a frame's copies: n drawn, the first nCast of them casting
export function setCopies(mesh, n, nCast) {
  mesh.count = n;
  mesh.userData.nAll = n; mesh.userData.nCast = nCast;
  mesh.castShadow = nCast > 0;
  uploadFirst(mesh.instanceMatrix, n);
}

// After writing copies 0..n-1 of an instance buffer: send only those to the GPU. Without a range three.js
// sends the whole buffer, which for a stream kind's 2048 slots is 128 KB a part on every refresh. Nothing
// is sent when nothing is drawn (an empty range would make WebGL send the rest of the buffer instead).
export function uploadFirst(attr, n) {
  if (n <= 0) return;
  if (attr.addUpdateRange) { attr.clearUpdateRanges(); attr.addUpdateRange(0, n * attr.itemSize); }
  attr.needsUpdate = true;
}
