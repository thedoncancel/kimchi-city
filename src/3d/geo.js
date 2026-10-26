import * as THREE from 'three';

// Collects triangles from quads, boxes, ribbons and transformed geometries into one BufferGeometry,
// so a whole city's worth of walls costs a single draw call per material.
//
// Vertices go into typed arrays that grow as needed, with an index list beside them: a quad stores its four
// corners once and a ribbon shares each cross-section between the strips before and after it. build() spells
// every triangle out, vertex for vertex the same output as before the index existed; build({ indexed: true })
// keeps the index instead (fewer vertices to transform). setMatrix(m) places everything added after it, such
// as a building drawn in its own local frame: positions and normals go through the matrix, while texture
// coordinates are worked out first, in local space, so a facade's windows line up the same at any heading.

const WHITE = new THREE.Color(1, 1, 1);
const UV1 = [[0, 0], [1, 0], [1, 1], [0, 1]];
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _n = new THREE.Vector3(), _fn = new THREE.Vector3();
const _p = new THREE.Vector3(), _nm = new THREE.Matrix3(), _mm = new THREE.Matrix4();
const _d = new THREE.Vector3(), _t = new THREE.Vector3(), _c = new THREE.Color();

function normalOf(a, b, c) {
  _a.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  _b.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  return _n.crossVectors(_a, _b).normalize();
}

export class Builder {
  constructor() {
    this.n = 0;      // vertices so far
    this.ni = 0;     // indices so far
    this.cap = 0; this.icap = 0;
    this.pos = this.nrm = this.uv = this.col = null;
    this.idx = null;
    this._grow(256); this._growIdx(384);
    this._M = null;                       // where setMatrix places things (null: as given)
    this._Mbuf = new THREE.Matrix4(); this._N = new THREE.Matrix3();
    this._flip = false;                   // the matrix mirrors, so triangles turn the other way round
  }
  get empty() { return this.n === 0; }
  get vertexCount() { return this.n; }

  // start again, keeping the storage (one builder can make many chunks)
  clear() { this.n = 0; this.ni = 0; return this; }

  // Everything added from now on goes through m (a Matrix4), until setMatrix(null). Texture coordinates are
  // worked out before it, from the coordinates as given. geo()'s own matrix applies first, then this one.
  setMatrix(m) {
    if (!m) { this._M = null; this._flip = false; return this; }
    this._M = this._Mbuf.copy(m);
    this._N.getNormalMatrix(this._M);
    this._flip = this._M.determinant() < 0;
    return this;
  }

  _grow(min) {
    const cap = Math.max(min, this.cap * 2), n = this.n;
    const re = (old, k) => { const a = new Float32Array(cap * k); if (old) a.set(old.subarray(0, n * k)); return a; };
    this.pos = re(this.pos, 3); this.nrm = re(this.nrm, 3); this.uv = re(this.uv, 2); this.col = re(this.col, 3);
    this.cap = cap;
  }
  _growIdx(min) {
    const cap = Math.max(min, this.icap * 2), a = new Uint32Array(cap);
    if (this.idx) a.set(this.idx.subarray(0, this.ni));
    this.idx = a; this.icap = cap;
  }
  _reserve(nv, ni) {
    if (this.n + nv > this.cap) this._grow(this.n + nv);
    if (this.ni + ni > this.icap) this._growIdx(this.ni + ni);
  }

  // one vertex, placed by the matrix; n is the normal already placed. Returns its index.
  _vert(x, y, z, nx, ny, nz, u, v, r, g, b) {
    if (this.n >= this.cap) this._grow(this.n + 1);
    const i = this.n++, M = this._M;
    if (M) { _p.set(x, y, z).applyMatrix4(M); x = _p.x; y = _p.y; z = _p.z; }
    const i3 = i * 3, i2 = i * 2, P = this.pos, N = this.nrm, C = this.col;
    P[i3] = x; P[i3 + 1] = y; P[i3 + 2] = z;
    N[i3] = nx; N[i3 + 1] = ny; N[i3 + 2] = nz;
    this.uv[i2] = u; this.uv[i2 + 1] = v;
    C[i3] = r; C[i3 + 1] = g; C[i3 + 2] = b;
    return i;
  }
  _v(p, uv, n, c) { return this._vert(p[0], p[1], p[2], n.x, n.y, n.z, uv[0], uv[1], c.r, c.g, c.b); }

  // a triangle of vertex indices, turned round when the matrix mirrors
  _tri(a, b, c) {
    if (this.ni + 3 > this.icap) this._growIdx(this.ni + 3);
    const I = this.idx, k = this.ni;
    I[k] = a;
    if (this._flip) { I[k + 1] = c; I[k + 2] = b; } else { I[k + 1] = b; I[k + 2] = c; }
    this.ni = k + 3;
  }

  // the normal of the face a, b, c, placed by the matrix (a shared vector: use it before the next face)
  _face(a, b, c) {
    _fn.copy(normalOf(a, b, c));
    if (this._M) _fn.applyMatrix3(this._N).normalize();
    return _fn;
  }

  // corners counter-clockwise as seen from the side the face points to
  quad(a, b, c, d, uvs = UV1, color = WHITE) {
    const n = this._face(a, b, c);
    this._reserve(4, 6);
    const i = this._v(a, uvs[0], n, color);
    this._v(b, uvs[1], n, color); this._v(c, uvs[2], n, color); this._v(d, uvs[3], n, color);
    this._tri(i, i + 1, i + 2); this._tri(i, i + 2, i + 3);
  }

  tri(a, b, c, uvs = UV1, color = WHITE) {
    const n = this._face(a, b, c);
    this._reserve(3, 3);
    const i = this._v(a, uvs[0], n, color);
    this._v(b, uvs[1], n, color); this._v(c, uvs[2], n, color);
    this._tri(i, i + 1, i + 2);
  }

  // Axis-aligned box. uv 'world' tiles a texture every `us` metres horizontally and `vs` vertically;
  // uOff/vOff shift it (used to stop neighbouring buildings sharing the same lit windows).
  box(x0, y0, z0, x1, y1, z1, color = WHITE, o = {}) {
    const { top = true, bottom = false, px = true, nx = true, pz = true, nz = true, uv = 'unit', us = 1, vs = 1, uOff = 0, vOff = 0, vBase = y0 } = o;
    const W = uv === 'world';
    const side = (len) => W
      ? [[uOff, (y0 - vBase) / vs + vOff], [uOff + len / us, (y0 - vBase) / vs + vOff], [uOff + len / us, (y1 - vBase) / vs + vOff], [uOff, (y1 - vBase) / vs + vOff]]
      : UV1;
    const dx = x1 - x0, dz = z1 - z0;
    if (top) this.quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0],
      W ? [[x0 / us, -z0 / us], [x0 / us, -z1 / us], [x1 / us, -z1 / us], [x1 / us, -z0 / us]] : UV1, color);
    if (bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], UV1, color);
    if (pz) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], side(dx), color);
    if (nz) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], side(dx), color);
    if (px) this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], side(dz), color);
    if (nx) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], side(dz), color);
  }

  // append any three.js geometry, transformed by a Matrix4 (then by setMatrix's). An indexed geometry keeps
  // its index, so its shared corners are transformed once.
  geo(geometry, matrix, color = WHITE) {
    const P = geometry.attributes.position, Nn = geometry.attributes.normal, U = geometry.attributes.uv, Cv = geometry.attributes.color;   // own colours tint by `color`
    const index = geometry.index, nv = P.count, ni = index ? index.count : nv;
    const m = this._M ? _mm.multiplyMatrices(this._M, matrix) : matrix;
    _nm.getNormalMatrix(m);
    this._reserve(nv, ni);
    const base = this.n, pos = this.pos, nrm = this.nrm, uv = this.uv, col = this.col;
    for (let i = 0; i < nv; i++) {
      const j = base + i, j3 = j * 3, j2 = j * 2;
      _p.fromBufferAttribute(P, i).applyMatrix4(m);
      pos[j3] = _p.x; pos[j3 + 1] = _p.y; pos[j3 + 2] = _p.z;
      if (Nn) { _p.fromBufferAttribute(Nn, i).applyMatrix3(_nm).normalize(); nrm[j3] = _p.x; nrm[j3 + 1] = _p.y; nrm[j3 + 2] = _p.z; }
      else { nrm[j3] = 0; nrm[j3 + 1] = 1; nrm[j3 + 2] = 0; }
      if (U) { uv[j2] = U.getX(i); uv[j2 + 1] = U.getY(i); } else { uv[j2] = 0; uv[j2 + 1] = 0; }
      if (Cv) { col[j3] = color.r * Cv.getX(i); col[j3 + 1] = color.g * Cv.getY(i); col[j3 + 2] = color.b * Cv.getZ(i); }
      else { col[j3] = color.r; col[j3 + 1] = color.g; col[j3 + 2] = color.b; }
    }
    this.n = base + nv;
    const src = index ? index.array : null;
    for (let k = 0; k + 2 < ni; k += 3) {
      if (src) this._tri(base + src[k], base + src[k + 1], base + src[k + 2]);
      else this._tri(base + k, base + k + 1, base + k + 2);
    }
  }

  // A strip swept along a path: roads, curbs, sidewalks, verges, walls along a cutting.
  //   frames: the path. A sampled curve { n, x, z, s, tx, tz } in metres (spline.sampleCurve's shape), an
  //     array of { x, y, z, tx, tz, s }, or a RoadNet edge ({ x, y, s, tx, ty, gy } in sim px, heights gy in m).
  //     Missing tangents are taken from the neighbours, missing s from the distance along the path.
  //   profile: the cross-section from left to right, [offset, dy, u] or { o, y, u, c, g } per point. offset
  //     is metres along the path's right-hand normal (-tz, tx), dy metres above the path, u the texture u
  //     (default: metres across the profile / uScale), c an optional colour, g: this point sits g metres above
  //     opts.ground(x, z) instead (a verge snapped to the terrain). Each pair of neighbouring points makes one
  //     strip, smooth along the path and creased across it, so a curb face stays a sharp step.
  //   opts: y (path heights per frame: an array, a function of the frame index or a number; default the
  //     frames' own heights, else 0), bank (radians per frame, array or function: positive lowers the right
  //     side, y - offset * tan(bank), the same shear terrain.js carves the ground with), from / to (the frame
  //     range, to inclusive), scale (multiplies x, z and s; default 1, or 1/16 for a RoadNet edge), vScale
  //     (v = s / vScale, default 4 m), uScale (default 1), world (u = x / world and v = -z / world instead,
  //     like box's 'world' tops), color (for points without their own), ground (x, z) -> height, for the
  //     points with g.
  ribbon(frames, profile, opts = {}) {
    const F = framesOf(frames, opts);
    const m = F.n, np = profile.length;
    if (m < 2 || np < 2) return;
    const { vScale = 4, uScale = 1, world = 0, color = WHITE, ground = null } = opts;
    // the profile as plain numbers, with u along it
    const O = new Float64Array(np), D = new Float64Array(np), Uu = new Float64Array(np), cols = new Array(np);
    const onG = new Uint8Array(np), Gd = new Float64Array(np);    // points on the ground, and how far above it
    for (let j = 0, acc = 0; j < np; j++) {
      const p = profile[j], arr = Array.isArray(p);
      O[j] = arr ? p[0] : p.o; D[j] = (arr ? p[1] : p.y) || 0;
      if (!arr && ground && p.g != null) { onG[j] = 1; Gd[j] = p.g; }
      if (j > 0) acc += Math.hypot(O[j] - O[j - 1], D[j] - D[j - 1]);
      const u = arr ? p[2] : p.u;
      Uu[j] = u ?? acc / uScale;
      const c = arr ? p[3] : p.c;
      cols[j] = !c ? color : Array.isArray(c) ? _c.setRGB(c[0], c[1], c[2]).clone() : c;
    }
    this._reserve((np - 1) * m * 2, (np - 1) * (m - 1) * 6);
    const { X, Y, Z, TX, TZ, S, B, G } = F;
    for (let j = 0; j + 1 < np; j++) {
      const oA = O[j], oB = O[j + 1], dA = D[j], dB = D[j + 1], gA = onG[j], gB = onG[j + 1], cA = cols[j], cB = cols[j + 1];
      if (oA === oB && gA === gB && (gA ? Gd[j] === Gd[j + 1] : dA === dB)) continue;     // two points in one place
      const first = this.n;
      for (let i = 0; i < m; i++) {
        const rx = -TZ[i], rz = TX[i], x = X[i], z = Z[i], y = Y[i], b = B[i];
        const ax = x + rx * oA, az = z + rz * oA, bx = x + rx * oB, bz = z + rz * oB;
        const ay = gA ? ground(ax, az) + Gd[j] : y + dA - oA * b;
        const by = gB ? ground(bx, bz) + Gd[j + 1] : y + dB - oB * b;
        // normal = (across) x (along): across from one edge of the strip to the other (bank and ground
        // included), along the path's tangent with its grade
        _d.set(bx - ax, by - ay, bz - az);
        _t.set(TX[i], G[i], TZ[i]);
        _n.crossVectors(_d, _t).normalize();
        if (this._M) _n.applyMatrix3(this._N).normalize();
        const v = S[i] / vScale;
        this._vert(ax, ay, az, _n.x, _n.y, _n.z, world ? ax / world : Uu[j], world ? -az / world : v, cA.r, cA.g, cA.b);
        this._vert(bx, by, bz, _n.x, _n.y, _n.z, world ? bx / world : Uu[j + 1], world ? -bz / world : v, cB.r, cB.g, cB.b);
      }
      for (let i = 0; i + 1 < m; i++) {
        const a0 = first + 2 * i, b0 = a0 + 1, a1 = a0 + 2, b1 = a0 + 3;
        this._tri(a0, b0, b1); this._tri(a0, b1, a1);
      }
    }
  }

  build({ indexed = false } = {}) {
    const g = new THREE.BufferGeometry(), n = this.n, ni = this.ni, I = this.idx;
    let P, N, U, C;
    if (indexed) {
      P = this.pos.slice(0, n * 3); N = this.nrm.slice(0, n * 3); U = this.uv.slice(0, n * 2); C = this.col.slice(0, n * 3);
      g.setIndex(new THREE.BufferAttribute(n <= 65536 ? Uint16Array.from(I.subarray(0, ni)) : I.slice(0, ni), 1));
    } else {
      // every triangle spelled out, corner by corner
      const pos = this.pos, nrm = this.nrm, uv = this.uv, col = this.col;
      P = new Float32Array(ni * 3); N = new Float32Array(ni * 3); U = new Float32Array(ni * 2); C = new Float32Array(ni * 3);
      for (let k = 0; k < ni; k++) {
        const i = I[k], a = k * 3, b = i * 3;
        P[a] = pos[b]; P[a + 1] = pos[b + 1]; P[a + 2] = pos[b + 2];
        N[a] = nrm[b]; N[a + 1] = nrm[b + 1]; N[a + 2] = nrm[b + 2];
        C[a] = col[b]; C[a + 1] = col[b + 1]; C[a + 2] = col[b + 2];
        U[k * 2] = uv[i * 2]; U[k * 2 + 1] = uv[i * 2 + 1];
      }
    }
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
    g.setAttribute('color', new THREE.BufferAttribute(C, 3));
    g.computeBoundingSphere();
    return g;
  }

  mesh(material, { cast = false, receive = true, indexed = false } = {}) {
    const m = new THREE.Mesh(this.build({ indexed }), material);
    m.castShadow = cast; m.receiveShadow = receive;
    m.matrixAutoUpdate = false;
    return m;
  }
}

// A ribbon's path as plain arrays for frames from..to: positions, heights, unit tangents, distance along,
// tan(bank) and grade (dy/ds, for the normals).
function framesOf(fr, opts) {
  const isArr = Array.isArray(fr), edge = !isArr && !!fr.gy && !!fr.ty;
  const total = isArr ? fr.length : (fr.n ?? fr.x.length);
  const from = Math.max(0, opts.from ?? 0), to = Math.min(total - 1, opts.to ?? total - 1);
  const m = Math.max(0, to - from + 1), k = opts.scale ?? (edge ? 1 / 16 : 1);
  const X = new Float64Array(m), Y = new Float64Array(m), Z = new Float64Array(m), TX = new Float64Array(m), TZ = new Float64Array(m);
  const S = new Float64Array(m), B = new Float64Array(m), G = new Float64Array(m);
  const yOpt = opts.y, bOpt = opts.bank;
  let haveT = true, haveS = true;
  for (let i = 0; i < m; i++) {
    const f = from + i;
    let tx, tz, s, y;
    if (isArr) { const p = fr[f]; X[i] = p.x * k; Z[i] = p.z * k; tx = p.tx; tz = p.tz; s = p.s; y = p.y; }
    else if (edge) { X[i] = fr.x[f] * k; Z[i] = fr.y[f] * k; tx = fr.tx[f]; tz = fr.ty[f]; s = fr.s?.[f]; y = fr.gy[f]; }
    else { X[i] = fr.x[f] * k; Z[i] = fr.z[f] * k; tx = fr.tx?.[f]; tz = fr.tz?.[f]; s = fr.s?.[f]; y = fr.y?.[f]; }
    if (tx === undefined || tz === undefined) haveT = false; else { TX[i] = tx; TZ[i] = tz; }
    if (s === undefined) haveS = false; else S[i] = s * k;
    Y[i] = yOpt === undefined ? (y || 0) : typeof yOpt === 'number' ? yOpt : typeof yOpt === 'function' ? yOpt(f) : yOpt[f];
    // the shear per metre across is tan(bank), as terrain.js carves it (edgeGeometry's TB)
    B[i] = Math.tan(bOpt === undefined ? 0 : typeof bOpt === 'number' ? bOpt : typeof bOpt === 'function' ? bOpt(f) : bOpt[f]);
  }
  if (!haveS) for (let i = 1; i < m; i++) S[i] = S[i - 1] + Math.hypot(X[i] - X[i - 1], Z[i] - Z[i - 1]);
  for (let i = 0; i < m; i++) {
    const a = Math.max(0, i - 1), b = Math.min(m - 1, i + 1), ds = S[b] - S[a];
    G[i] = ds > 1e-9 ? (Y[b] - Y[a]) / ds : 0;
    if (haveT) continue;
    const dx = X[b] - X[a], dz = Z[b] - Z[a], l = Math.hypot(dx, dz);
    if (l > 1e-9) { TX[i] = dx / l; TZ[i] = dz / l; } else if (i > 0) { TX[i] = TX[i - 1]; TZ[i] = TZ[i - 1]; } else TX[i] = 1;
  }
  return { n: m, X, Y, Z, TX, TZ, S, B, G };
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _tv = new THREE.Vector3(), _e = new THREE.Euler();
export function mat4(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  _q.setFromEuler(_e.set(rx, ry, rz));
  return _m.clone().compose(_tv.set(x, y, z), _q, _s.set(sx, sy, sz));
}

export const col = (hex) => new THREE.Color(hex);
