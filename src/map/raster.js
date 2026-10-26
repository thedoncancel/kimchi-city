// Raster helpers for the Kimchi Key v2 map (docs/map-v2-spec.md §6.2). Everything here is plain math
// over typed arrays, so it runs in node and in a Worker: no three, no DOM.
//
// A grid is { w, h, cell, o, data }: w×h values, row-major, cell metres apart, with index (i,j) sitting
// at world ((i + o)·cell, (j + o)·cell). Cell rasters (SURF, OCC, REG, SEADEPTH) use o = 0.5, so a value
// covers the square around its centre; vertex rasters (GROUND, TERRAIN) use o = 0, so values sit on the
// corners. All the fill functions take world metres and test the sample point of each index.

// Surface kinds: the low nibble of a SURF cell. 0..6 are today's tile codes.
export const KIND = {
  ROAD: 0, WALK: 1, GRASS: 2, BUILD: 3, LOT: 4, PLAZA: 5, WATER: 6,
  SAND: 7, DIRT: 8, SHALLOW: 9, DECK: 10, ROCK: 11,
};
export const KIND_MASK = 0x0f;
// High-nibble flags: cars blocked, people blocked, junction box (no parking or idling), no pedestrians.
export const FLAG = { BLOCK_CAR: 0x10, BLOCK_FOOT: 0x20, JCT: 0x40, NOPED: 0x80 };
export const BLOCK_BOTH = FLAG.BLOCK_CAR | FLAG.BLOCK_FOOT;

// The legacy tile code each kind reads as through tileAtPx, so code written for the grid keeps working:
// SAND→PLAZA, DIRT→GRASS, SHALLOW→WATER, DECK→ROAD, ROCK→BUILD.
export const LEGACY = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 5, 2, 6, 0, 3]);

// How far above GROUND the walkable top of each kind sits (metres): curbs, plazas and building plinths
// are 16 cm up, lots 4 cm. groundY adds this to the bilinear GROUND height.
export const CURB = Object.freeze([0, 0.16, 0, 0.16, 0.04, 0.16, 0, 0, 0, 0, 0, 0]);

// Grip by kind: max scales the top speed, lat the lateral (sideways) damping. 'classic' is today's grid
// feel (only grass is slow); 'v2' is the Forza-style table of spec §10. Blocked kinds keep full grip,
// since a car only touches them while being pushed back out.
const g = (max, lat) => Object.freeze({ max, lat });
export const GRIP = {
  classic: [g(1, 1), g(1, 1), g(0.55, 1), g(1, 1), g(1, 1), g(1, 1), g(1, 1), g(1, 1), g(1, 1), g(1, 1), g(1, 1), g(1, 1)],
  v2: [
    g(1, 1),         // ROAD
    g(0.95, 1),      // WALK
    g(0.72, 0.85),   // GRASS
    g(1, 1),         // BUILD (blocked)
    g(1, 1),         // LOT
    g(0.95, 1),      // PLAZA
    g(0.5, 0.6),     // WATER (blocked; same as shallow if a car is ever pushed in)
    g(0.6, 0.7),     // SAND
    g(0.85, 0.75),   // DIRT
    g(0.5, 0.6),     // SHALLOW, with splash
    g(1, 1),         // DECK
    g(1, 1),         // ROCK (blocked)
  ],
};

// The value a SURF cell gets for a kind on its own: building, deep water and rock block cars and people.
export function kindBits(kind) {
  return kind === KIND.BUILD || kind === KIND.WATER || kind === KIND.ROCK ? kind | BLOCK_BOTH : kind;
}

export function makeGrid(w, h, cell, { Type = Float32Array, vertex = false, fill = 0 } = {}) {
  const data = new Type(w * h);
  if (fill) data.fill(fill);
  return { w, h, cell, o: vertex ? 0 : 0.5, data };
}

// ---------- writing one value ----------
// op says how v lands on the old value: 'set', 'max', 'min', 'or' (add flag bits), 'kind' (replace the
// low nibble and keep the flags), 'clear' (remove the bits in v). v may also be a function, called with
// the index and the sample point (i, x, z, ...); it does its own writing.
function writer(grid, v, op) {
  const d = grid.data;
  if (typeof v === 'function') return v;
  switch (op) {
    case 'max': return i => { if (v > d[i]) d[i] = v; };
    case 'min': return i => { if (v < d[i]) d[i] = v; };
    case 'or': return i => { d[i] |= v; };
    case 'clear': return i => { d[i] &= ~v; };
    case 'kind': return i => { d[i] = (d[i] & ~KIND_MASK) | v; };
    default: return i => { d[i] = v; };
  }
}

// Index range [lo, hi] whose sample points fall inside [a, b] metres along one axis.
function span(a, b, grid, n) {
  const lo = Math.max(0, Math.ceil(a / grid.cell - grid.o));
  const hi = Math.min(n - 1, Math.floor(b / grid.cell - grid.o));
  return [lo, hi];
}

// ---------- fills ----------

// Fill a polygon [[x,z],...] (any winding, even-odd rule) by scanlines through the sample rows.
export function fillPoly(grid, pts, v, op = 'set') {
  const put = writer(grid, v, op), c = grid.cell, n = pts.length, fast = op === 'set' && typeof v === 'number';
  let z0 = Infinity, z1 = -Infinity;
  for (const p of pts) { if (p[1] < z0) z0 = p[1]; if (p[1] > z1) z1 = p[1]; }
  const [j0, j1] = span(z0, z1, grid, grid.h);
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const z = (j + grid.o) * c;
    xs.length = 0;
    for (let k = 0, m = n - 1; k < n; m = k++) {
      const [ax, az] = pts[m], [bx, bz] = pts[k];
      if ((az <= z) !== (bz <= z)) xs.push(ax + (z - az) / (bz - az) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const [i0, i1] = span(xs[k], xs[k + 1], grid, grid.w);
      if (fast) { if (i1 >= i0) grid.data.fill(v, j * grid.w + i0, j * grid.w + i1 + 1); continue; }
      for (let i = i0; i <= i1; i++) put(j * grid.w + i, (i + grid.o) * c, z);
    }
  }
}

// Fill every sample within halfW of a polyline: a sampled curve {x, z, n} (metres) or [[x,z],...].
// halfW may be a number or a function of the sample index (for widths that change along a road).
// from/to pick a sample range, so a bridge deck or a single block can be stamped on its own.
// A function v is called as v(i, x, z, k, t, d): segment k, position t along it (0..1) and distance d
// from the centreline. A sample near a joint lies in two segments and may be visited twice; every op
// above gives the same result either way.
export function fillRibbon(grid, curve, halfW, v, op = 'set', { from = 0, to } = {}) {
  const put = writer(grid, v, op), c = grid.cell;
  const X = curve.x ? curve.x : curve.map(p => p[0]), Z = curve.z ? curve.z : curve.map(p => p[1]);
  const n = curve.n ?? X.length, last = Math.min(to ?? n - 1, n - 1);
  const wAt = typeof halfW === 'function' ? halfW : () => halfW;
  const segs = Math.max(1, last - from);
  for (let s = 0; s < segs; s++) {
    const k = from + s, k1 = Math.min(k + 1, last);
    const ax = X[k], az = Z[k], bx = X[k1], bz = Z[k1], wa = wAt(k), wb = wAt(k1), r = Math.max(wa, wb);
    const [i0, i1] = span(Math.min(ax, bx) - r, Math.max(ax, bx) + r, grid, grid.w);
    const [j0, j1] = span(Math.min(az, bz) - r, Math.max(az, bz) + r, grid, grid.h);
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    for (let j = j0; j <= j1; j++) {
      const z = (j + grid.o) * c;
      for (let i = i0; i <= i1; i++) {
        const x = (i + grid.o) * c;
        let t = L2 > 0 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = x - ax - dx * t, ez = z - az - dz * t, w = wa + (wb - wa) * t, d2 = ex * ex + ez * ez;
        if (d2 <= w * w) put(j * grid.w + i, x, z, k, t, Math.sqrt(d2));
      }
    }
  }
}

// Fill an oriented box: centre (cx,cz), w across and d deep, facing a (local +z points along
// (cos a, sin a), local +x along (sin a, −cos a); the spec §1 building frame).
export function fillOBB(grid, cx, cz, w, d, a, v, op = 'set') {
  const put = writer(grid, v, op), c = grid.cell;
  const fx = Math.cos(a), fz = Math.sin(a), rx = Math.sin(a), rz = -Math.cos(a);
  const ex = Math.abs(rx) * w / 2 + Math.abs(fx) * d / 2, ez = Math.abs(rz) * w / 2 + Math.abs(fz) * d / 2;
  const [i0, i1] = span(cx - ex, cx + ex, grid, grid.w), [j0, j1] = span(cz - ez, cz + ez, grid, grid.h);
  for (let j = j0; j <= j1; j++) {
    const z = (j + grid.o) * c;
    for (let i = i0; i <= i1; i++) {
      const x = (i + grid.o) * c, px = x - cx, pz = z - cz;
      if (Math.abs(px * rx + pz * rz) <= w / 2 && Math.abs(px * fx + pz * fz) <= d / 2) put(j * grid.w + i, x, z);
    }
  }
}

// A thick line along a polyline [[x,z],...]: rails, guardrails, Jersey barriers and bollard rows are
// stamped 2 m thick so a fast car cannot slip between two samples.
export function strokeLine(grid, pts, thick, v, op = 'set') {
  fillRibbon(grid, pts, Math.max(thick / 2, grid.cell * 0.71), v, op);
}

// ---------- distance transform ----------

// Exact Euclidean distance (metres) from every sample to the nearest sample where mask is non-zero
// (Felzenszwalb and Huttenlocher, two 1D passes). Samples in the mask get 0; an empty mask gives Infinity.
// mask is a grid or a typed array with w, h and cell passed in opts.
export function distanceTransform(mask, { w = mask.w, h = mask.h, cell = mask.cell, invert = false } = {}) {
  const m = mask.data || mask, INF = 1e20;
  const f = new Float64Array(Math.max(w, h)), d = new Float64Array(Math.max(w, h));
  const vv = new Int32Array(Math.max(w, h)), zz = new Float64Array(Math.max(w, h) + 1);
  const out = new Float32Array(w * h), tmp = new Float64Array(w * h);
  // lower envelope of the parabolas f[p] + (q - p)^2; zz holds the breakpoints between them
  const edt1 = n => {
    let k = 0;
    vv[0] = 0; zz[0] = -INF; zz[1] = INF;
    for (let q = 1; q < n; q++) {
      let p = vv[k], s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
      while (s <= zz[k]) { k--; p = vv[k]; s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p); }
      k++; vv[k] = q; zz[k] = s; zz[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (zz[k + 1] < q) k++;
      const p = vv[k];
      d[q] = (q - p) * (q - p) + f[p];
    }
  };
  for (let i = 0; i < w; i++) {      // columns
    for (let j = 0; j < h; j++) f[j] = (m[j * w + i] !== 0) !== invert ? 0 : INF;
    edt1(h);
    for (let j = 0; j < h; j++) tmp[j * w + i] = d[j];
  }
  for (let j = 0; j < h; j++) {      // rows
    for (let i = 0; i < w; i++) f[i] = tmp[j * w + i];
    edt1(w);
    for (let i = 0; i < w; i++) out[j * w + i] = d[i] >= INF / 2 ? Infinity : Math.sqrt(d[i]) * cell;
  }
  return out;
}

// Bilinear sample of a grid at world (x, z), clamped to its edges.
export function sampleGrid(grid, x, z) {
  const fx = Math.min(Math.max(x / grid.cell - grid.o, 0), grid.w - 1), fz = Math.min(Math.max(z / grid.cell - grid.o, 0), grid.h - 1);
  const i = Math.min(Math.floor(fx), grid.w - 2), j = Math.min(Math.floor(fz), grid.h - 2);
  const tx = fx - i, tz = fz - j, w = grid.w, d = grid.data, k = j * w + i;
  return (d[k] * (1 - tx) + d[k + 1] * tx) * (1 - tz) + (d[k + w] * (1 - tx) + d[k + w + 1] * tx) * tz;
}
