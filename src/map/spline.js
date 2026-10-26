// Road curves (docs/map-v2-spec.md §4.1). One sampling rule shared by the RoadNet, the v2 generator,
// the validators and the tools, so every radius, length and junction station they report is the one
// the game drives on. Pure functions over plain numbers: no three, no DOM, runs in node.
//
// The rule: centripetal Catmull-Rom (alpha 0.5). Open curves get mirrored phantom ends, closed curves
// wrap. Each segment is sub-sampled uniformly in t at 0.25 m, then resampled to 1 m of arc length
// (runtime curves keep every other sample, 2 m apart, except where |k| > 1/40). Frames are
// right = (-tz, tx), never Frenet. Curvature k is signed: positive turns right (clockwise on the map,
// the heading a = atan2(dz, dx) grows), and it is measured as a 3-point circle across +-chord samples.

const SUB = 0.25;          // metres between the uniform-t sub-samples of a segment
const TIGHT_K = 1 / 40;    // above this |k| a runtime curve keeps its 1 m samples

// Dense centripetal Catmull-Rom points with the control parameter u (segment index + fraction) of each,
// exactly as the spec's validator sampled them.
function crDense(pts, closed) {
  const n = pts.length;
  const Q = closed
    ? [pts[n - 1], ...pts, pts[0], pts[1 % n]]
    : [[2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]], ...pts,
       [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]]];
  const segs = closed ? n : n - 1;
  const x = [], z = [], u = [];
  const knot = (t, A, B) => t + Math.sqrt(Math.max(1e-6, Math.hypot(B[0] - A[0], B[1] - A[1])));
  // Barry-Goldman pyramid for one coordinate
  const bg = (t, t0, t1, t2, t3, a, b, c, d) => {
    const A1 = ((t1 - t) * a + (t - t0) * b) / (t1 - t0);
    const A2 = ((t2 - t) * b + (t - t1) * c) / (t2 - t1);
    const A3 = ((t3 - t) * c + (t - t2) * d) / (t3 - t2);
    const B1 = ((t2 - t) * A1 + (t - t0) * A2) / (t2 - t0);
    const B2 = ((t3 - t) * A2 + (t - t1) * A3) / (t3 - t1);
    return ((t2 - t) * B1 + (t - t1) * B2) / (t2 - t1);
  };
  for (let i = 0; i < segs; i++) {
    const p0 = Q[i], p1 = Q[i + 1], p2 = Q[i + 2], p3 = Q[i + 3];
    const t0 = 0, t1 = knot(t0, p0, p1), t2 = knot(t1, p1, p2), t3 = knot(t2, p2, p3);
    const m = Math.max(4, Math.floor(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / SUB));
    for (let k = 0; k < m; k++) {
      const t = t1 + (t2 - t1) * k / m;
      x.push(bg(t, t0, t1, t2, t3, p0[0], p1[0], p2[0], p3[0]));
      z.push(bg(t, t0, t1, t2, t3, p0[1], p1[1], p2[1], p3[1]));
      u.push(i + k / m);
    }
  }
  const last = closed ? pts[0] : pts[n - 1];
  x.push(last[0]); z.push(last[1]); u.push(closed ? n : n - 1);
  return { x, z, u };
}

// Walk the dense points and keep one each time the distance since the last kept point reaches `step`.
// s is the dense arc length, so it is the same whatever step is used.
function resample(d, step) {
  const x = [d.x[0]], z = [d.z[0]], u = [d.u[0]], s = [0];
  let acc = 0, tot = 0;
  const N = d.x.length;
  for (let i = 1; i < N; i++) {
    const dx = d.x[i] - d.x[i - 1], dz = d.z[i] - d.z[i - 1], dd = Math.sqrt(dx * dx + dz * dz);
    acc += dd; tot += dd;
    if (acc >= step) { x.push(d.x[i]); z.push(d.z[i]); u.push(d.u[i]); s.push(tot); acc = 0; }
  }
  if (x[x.length - 1] !== d.x[N - 1] || z[z.length - 1] !== d.z[N - 1]) {
    x.push(d.x[N - 1]); z.push(d.z[N - 1]); u.push(d.u[N - 1]); s.push(tot);
  }
  return { x, z, u, s, len: tot };
}

// Signed curvature of the circle through three points (positive = turning right).
export function circleK(ax, az, bx, bz, cx, cz) {
  const cr = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const l = Math.hypot(bx - ax, bz - az) * Math.hypot(cx - bx, cz - bz) * Math.hypot(ax - cx, az - cz);
  return l < 1e-12 ? 0 : 2 * cr / l;
}

// k at every sample from the samples `chord` places either side. A closed curve repeats its first point
// at the end, so it wraps over n-1 samples; an open curve copies the nearest full-chord value to its ends.
function curvatures(x, z, chord, closed) {
  const n = x.length, k = new Array(n).fill(0);
  if (closed) {
    const m = n - 1;
    if (m < 3) return k;
    const c = Math.max(1, Math.min(chord, Math.floor(m / 3)));
    for (let i = 0; i < m; i++) {
      const a = (i - c + m) % m, b = (i + c) % m;
      k[i] = circleK(x[a], z[a], x[i], z[i], x[b], z[b]);
    }
    k[m] = k[0];
    return k;
  }
  if (n < 3) return k;
  const c = Math.max(1, Math.min(chord, Math.floor((n - 1) / 2)));
  for (let i = c; i <= n - 1 - c; i++) k[i] = circleK(x[i - c], z[i - c], x[i], z[i], x[i + c], z[i + c]);
  for (let i = 0; i < c; i++) k[i] = k[c];
  for (let i = n - c; i < n; i++) k[i] = k[n - 1 - c];
  return k;
}

// Unit tangents by central differences (one-sided at open ends, wrapped on closed curves).
function tangents(x, z, closed) {
  const n = x.length, tx = new Float32Array(n), tz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let a = i - 1, b = i + 1;
    if (closed) { const m = n - 1; a = (i - 1 + m) % m; b = (i + 1) % m; }
    else { a = Math.max(0, a); b = Math.min(n - 1, b); }
    let dx = x[b] - x[a], dz = z[b] - z[a], l = Math.hypot(dx, dz);
    if (l < 1e-9 && i > 0) { tx[i] = tx[i - 1]; tz[i] = tz[i - 1]; continue; }
    if (l < 1e-9) { dx = 1; dz = 0; l = 1; }
    tx[i] = dx / l; tz[i] = dz / l;
  }
  return { tx, tz };
}

// Sample authored control points [[x,z],...] into a curve. step 1 gives the validator's 1 m curve;
// the default step 2 is the runtime curve (1 m kept wherever |k| > 1/40). chord is the radius-check
// chord in samples: 3 for switch, street, dirt, alley and ring roads, 8 for the rest.
// Returns { x, z, s, tx, tz, k, u, n, len, closed }: typed arrays plus u, the control parameter of each
// sample (for the authored y pins), n samples and len metres. A closed curve repeats its first point last.
export function sampleCurve(pts, { closed = false, step = 2, chord = 3 } = {}) {
  if (pts.length < 2) throw new Error('sampleCurve: a curve needs at least 2 points');
  const r = resample(crDense(pts, closed), 1);
  const k = curvatures(r.x, r.z, chord, closed);
  let keep = null;
  if (step > 1) {
    // keep a sample when the arc since the last kept one reaches step, or 1 m on tight bends
    keep = [0];
    for (let i = 1, last = 0; i < r.x.length; i++) {
      const tight = Math.abs(k[i]) > TIGHT_K || Math.abs(k[last]) > TIGHT_K;
      if (i === r.x.length - 1 || r.s[i] - r.s[last] >= (tight ? 1 : step) - 1e-6) { keep.push(i); last = i; }
    }
  }
  const pick = a => Float32Array.from(keep ? keep.map(i => a[i]) : a);
  const x = pick(r.x), z = pick(r.z);
  const { tx, tz } = tangents(x, z, closed);
  return { x, z, s: pick(r.s), tx, tz, k: pick(k), u: pick(r.u), n: x.length, len: r.len, closed };
}

// Smallest radius by the spec's radius check: the circle through samples i-chord, i, i+chord of a 1 m
// curve (wrapping on closed curves, interior samples only on open ones). Returns { r, i, x, z }.
export function minRadius(c, chord) {
  const N = c.n;
  let best = { r: Infinity, i: -1, x: NaN, z: NaN };
  const from = c.closed ? 0 : chord, to = c.closed ? N : N - chord;
  for (let i = from; i < to; i++) {
    const a = (i - chord + N) % N, b = (i + chord) % N;
    const k = Math.abs(circleK(c.x[a], c.z[a], c.x[i], c.z[i], c.x[b], c.z[b]));
    const r = k < 1e-12 ? Infinity : 1 / k;
    if (r < best.r) best = { r, i, x: c.x[i], z: c.z[i] };
  }
  return best;
}

// Index of the sample at or before station s (binary search over c.s).
export function indexAt(c, s) {
  let lo = 0, hi = c.n - 1;
  if (s <= c.s[0]) return 0;
  if (s >= c.s[hi]) return hi - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c.s[m] <= s) lo = m; else hi = m; }
  return lo;
}

// Position, tangent and curvature at station s (wrapped on closed curves, clamped on open ones).
export function pointAt(c, s, out = {}) {
  if (c.closed) s = ((s % c.len) + c.len) % c.len;
  else s = Math.max(0, Math.min(c.len, s));
  const i = Math.min(indexAt(c, s), c.n - 2), j = i + 1;
  const ds = c.s[j] - c.s[i], f = ds > 1e-9 ? (s - c.s[i]) / ds : 0;
  out.x = c.x[i] + (c.x[j] - c.x[i]) * f;
  out.z = c.z[i] + (c.z[j] - c.z[i]) * f;
  let tx = c.tx[i] + (c.tx[j] - c.tx[i]) * f, tz = c.tz[i] + (c.tz[j] - c.tz[i]) * f;
  const l = Math.hypot(tx, tz) || 1;
  out.tx = tx / l; out.tz = tz / l;
  out.k = c.k ? c.k[i] + (c.k[j] - c.k[i]) * f : 0;
  out.s = s; out.i = i;
  return out;
}

// Closest point of the curve to (x, z). hint (a sample index) limits the search to a window around it.
// side is +1 when the point lies on the curve's right (the -tz, tx side), -1 on its left.
export function nearestOnCurve(c, x, z, hint) {
  let i0 = 0, i1 = c.n - 1;
  if (hint != null && hint >= 0) { i0 = Math.max(0, hint - 64); i1 = Math.min(c.n - 1, hint + 64); }
  let best = null;
  for (let i = i0; i < i1; i++) {
    const ax = c.x[i], az = c.z[i], dx = c.x[i + 1] - ax, dz = c.z[i + 1] - az;
    const L2 = dx * dx + dz * dz;
    let f = L2 > 1e-12 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0;
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    const px = ax + dx * f, pz = az + dz * f, d = Math.hypot(x - px, z - pz);
    if (!best || d < best.d) best = { i, f, x: px, z: pz, d, dx, dz };
  }
  const L = Math.hypot(best.dx, best.dz) || 1;
  const side = ((x - best.x) * -best.dz + (z - best.z) * best.dx) / L >= 0 ? 1 : -1;
  return { i: best.i, s: c.s[best.i] + (c.s[best.i + 1] - c.s[best.i]) * best.f, x: best.x, z: best.z, d: best.d, side };
}

// The curve moved sideways by d (positive = to the right). Stations are re-measured along the new line
// and curvature becomes k / (1 - k d), the bend of the offset line.
export function offsetCurve(c, d) {
  const n = c.n, x = new Float32Array(n), z = new Float32Array(n), s = new Float32Array(n), k = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = c.x[i] - c.tz[i] * d;
    z[i] = c.z[i] + c.tx[i] * d;
    const q = 1 - c.k[i] * d;
    k[i] = Math.abs(q) > 1e-6 ? c.k[i] / q : 0;
    if (i) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
  }
  return { x, z, s, tx: Float32Array.from(c.tx), tz: Float32Array.from(c.tz), k, u: c.u, n, len: s[n - 1], closed: c.closed };
}

// Cubic Bezier from p0 leaving along unit tangent t0 to p3 arriving along unit tangent t3. The handles
// sit at a third of the gap unless `handle` gives their length. Resampled to `step` of arc length.
// Returns { x, z, s, len } as typed arrays (len in the same units as the points).
export function bezier(p0, t0, p3, t3, step = 1, handle) {
  const gap = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
  const h = handle ?? gap / 3;
  const P1 = [p0[0] + t0[0] * h, p0[1] + t0[1] * h], P2 = [p3[0] - t3[0] * h, p3[1] - t3[1] * h];
  const m = Math.max(8, Math.ceil((gap + 2 * h) / step * 2));
  const d = { x: [], z: [], u: [] };
  for (let i = 0; i <= m; i++) {
    const t = i / m, a = (1 - t) ** 3, b = 3 * (1 - t) ** 2 * t, cc = 3 * (1 - t) * t * t, e = t ** 3;
    d.x.push(a * p0[0] + b * P1[0] + cc * P2[0] + e * p3[0]);
    d.z.push(a * p0[1] + b * P1[1] + cc * P2[1] + e * p3[1]);
    d.u.push(t);
  }
  const r = resample(d, step);
  return { x: Float32Array.from(r.x), z: Float32Array.from(r.z), s: Float32Array.from(r.s), len: r.len };
}

// Where segment a-b meets segment c-d, ends included: { t, u, x, z } (t along a-b, u along c-d) or null.
export function segX(ax, az, bx, bz, cx, cz, dx, dz) {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = cx - ax, qz = cz - az;
  const t = (qx * sz - qz * sx) / den, u = (qx * rz - qz * rx) / den;
  const e = 1e-9;
  if (t < -e || t > 1 + e || u < -e || u > 1 + e) return null;
  return { t, u, x: ax + rx * t, z: az + rz * t };
}
