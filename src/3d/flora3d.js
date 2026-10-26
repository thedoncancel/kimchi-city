// Kimchi Key v2's vegetation in 3D (stage P2): every tree, palm, shrub and hedge the world grows, near and far.
// src/map/props.js placeFlora decides where things grow (by region and ground: street trees, garden hedges,
// coastal palm groves, Glades mangroves, cypress domes and hammocks, woods on the Heights); this draws them
// so a Forza-style aerial or a long view down a valley is as leafy as the street at your feet:
//
//  - trees in families of shapes (round shade trees, umbrella poincianas, banyans with their aerial roots,
//    cypress cones, mangroves on prop roots, slash pines), stylised like the rest of the town: clumps of
//    foliage, shaded from the crown's middle so each crown lights as one soft mass, a grey "light" in the
//    vertex colours and the leaf colour per tree (so one shape serves a green shade tree, a red poinciana or a
//    lilac jacaranda);
//  - three levels of detail: full trees near the camera (NEAR), light ones out to MID, and beyond that a
//    merged mesh of every tree and palm in the county as a few triangles each (in 768 m squares, so the ones out
//    of view are not drawn). Across the BAND past MID the
//    light trees shrink away as the far ones grow in (a vertex shader, by distance), so there is no pop;
//  - shrubs and hedges at the light level out to SHRUB_FAR (they shrink away over its last 20 m);
//  - palms through palms3d (detailed, then light out to PALM_LO), then the far mesh;
//  - the ground plants (grass, flowers, ferns, reeds, rocks) streamed per 64 m cell by scatter3d.
// Near trees and shrubs, and light ones within CAST of the shadow focus, cast shadows. The near and light
// copies are picked again only when the camera moves or turns (or the shadow focus moves), from 64 m buckets.
// The foliage is Lambert with the sky's fill (as terrain3d's ground), and skips the lamp loops by day.
//
// buildFlora3D(world, group, { light }) → { update(camera, t, focus?), stats(), placed }. Everything in metres.
import * as THREE from 'three';
import { HIGH } from './quality.js';
import { makeBuckets, shadowFocus, castFirst, setCopies, uploadFirst, BUCKET } from './chunks.js';
import { placeFlora, marshAt } from '../map/props.js';
import { makePalmField } from './palms3d.js';
import { loadAssetPack, makeStreamScatter } from './scatter3d.js';

const PX = 16;
export const NEAR = HIGH ? 45 : 25;          // m: full trees
export const MID = HIGH ? 170 : 110;         // m: light trees out to here (plus the band)
export const BAND = HIGH ? 30 : 20;          // m: light trees shrink away and far ones grow in across this
// shrubs and hedges are small enough to draw at the light level throughout (one mesh a family, fewer draws)
export const SHRUB_NEAR = 0, SHRUB_FAR = HIGH ? 150 : 80, SHRUB_FADE = 20;
export const PALM_LO = HIGH ? 110 : 70;      // m: palms3d's light palms out to here, then the far mesh
const CAST = HIGH ? 70 : 40;                 // m from the shadow focus: trees that cast (the sun's box is ±64 m)
const SHRUB_CAST = HIGH ? 30 : 0;
const PALM_CAST = HIGH ? 60 : 18;

// ---------- the shapes ----------

// A growing indexed mesh: position, normal, colour (the grey light for foliage, the bark's own colour) and
// leaf (1 on foliage, which the per-tree leaf colour multiplies; -1 on foliage keeping a colour of its own; 0 on
// bark).
class Parts {
  constructor() { this.p = []; this.n = []; this.c = []; this.l = []; this.i = []; }
  get count() { return this.p.length / 3; }
  vert(x, y, z, nx, ny, nz, r, g, b, leaf) {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.c.push(r, g, b); this.l.push(leaf);
    return this.count - 1;
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('leaf', new THREE.Float32BufferAttribute(this.l, 1));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}

// The unit icosphere at a subdivision level: { v: [x, y, z, ...], f: [a, b, c, ...] }, made once per level.
const ICO = [];
function ico(detail) {
  if (ICO[detail]) return ICO[detail];
  const t = (1 + Math.sqrt(5)) / 2;
  let v = [-1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0, 0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1];
  let f = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  for (let d = 0; d < detail; d++) {
    const mid = new Map(), nf = [];
    const half = (a, b) => {
      const k = a < b ? a * 65536 + b : b * 65536 + a;
      if (!mid.has(k)) { mid.set(k, v.length / 3); v.push((v[a * 3] + v[b * 3]) / 2, (v[a * 3 + 1] + v[b * 3 + 1]) / 2, (v[a * 3 + 2] + v[b * 3 + 2]) / 2); }
      return mid.get(k);
    };
    for (let i = 0; i < f.length; i += 3) {
      const [a, b, c] = [f[i], f[i + 1], f[i + 2]], ab = half(a, b), bc = half(b, c), ca = half(c, a);
      nf.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    f = nf;
  }
  for (let i = 0; i < v.length; i += 3) { const l = Math.hypot(v[i], v[i + 1], v[i + 2]); v[i] /= l; v[i + 1] /= l; v[i + 2] /= l; }
  return (ICO[detail] = { v, f });
}

// One clump of foliage: a lumpy, flat-bottomed ball at (cx, cy, cz) with radii (rx, ry, rz). Its normals lean
// out from the crown's middle C (so the crown lights as one mass), and its grey light runs from dark under the
// crown to bright on top, darker where the clump faces into the crown. box: [crown bottom, crown top] (y).
// boxy (0..1) squares the ball off (hedges); own: a colour of its own instead of the tree's leaf colour (leaf -1:
// foliage that keeps its colour, the green among a poinciana's flowers).
function clump(P, cx, cy, cz, rx, ry, rz, detail, seed, C, box, { boxy = 0, amp = 0.14, own = null } = {}) {
  const { v, f } = ico(detail), o = P.count, tone = Math.sin(seed * 91.7) * 0.05;   // each clump a shade apart
  for (let i = 0; i < v.length; i += 3) {
    let dx = v[i], dy = v[i + 1], dz = v[i + 2];
    if (boxy) { const s = (q) => Math.sign(q) * Math.pow(Math.abs(q), 1 - boxy * 0.6); dx = s(dx); dy = s(dy); dz = s(dz); }
    const wob = 1 + amp * Math.sin(dx * 4.1 + seed) * Math.sin(dy * 3.7 + seed * 1.7) * Math.sin(dz * 4.3 + seed * 2.3)
      + amp * 0.5 * Math.sin(dx * 9.3 + dz * 7.1 + seed * 3.1) + (detail > 1 ? amp * 0.45 * Math.sin(dx * 17 + dy * 13 + seed) * Math.sin(dz * 15 - dy * 11 + seed * 2) : 0);
    const fy = dy < 0 ? dy * 0.72 : dy;             // flatter underneath
    const x = cx + dx * rx * wob, y = cy + fy * ry * wob, z = cz + dz * rz * wob;
    // the clump's own normal and the direction out from the crown's middle, blended
    let nx = dx / rx, ny = fy / ry, nz = dz / rz;
    const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
    let ox = x - C[0], oy = (y - C[1]) * 1.4, oz = z - C[2];
    const ol = Math.hypot(ox, oy, oz) || 1; ox /= ol; oy /= ol; oz /= ol;
    let mx = nx * 0.5 + ox * 0.5, my = ny * 0.5 + oy * 0.5 + 0.12, mz = nz * 0.5 + oz * 0.5;
    const ml = Math.hypot(mx, my, mz); mx /= ml; my /= ml; mz /= ml;
    const t = Math.min(1, Math.max(0, (y - box[0]) / (box[1] - box[0] || 1)));
    const outer = nx * ox + ny * oy + nz * oz;
    const jit = Math.sin(i * 12.9898 + seed * 78.233) * 0.035 + tone;
    const g = Math.min(1.02, 0.36 + 0.42 * t + 0.24 * Math.max(0, outer) + jit) * (dy < -0.2 ? 0.84 + 0.16 * (1 + dy) : 1);
    // sunlit tops a touch warmer, the shade underneath a touch cooler
    const r = g * (0.97 + 0.08 * t), b = g * (0.98 - 0.12 * t);
    if (own) P.vert(x, y, z, mx, my, mz, r * own[0], g * own[1], b * own[2], -1);
    else P.vert(x, y, z, mx, my, mz, r, g, b, 1);
  }
  for (let i = 0; i < f.length; i++) P.i.push(o + f[i]);
}

// A tapering limb (or trunk) along path [[x, y, z], ...] with radii [r, ...] and `sides` sides, bark-coloured,
// a little darker at its foot. No caps: its ends are in the ground or the crown.
function limb(P, path, radii, sides, bark) {
  const o = P.count, n = path.length;
  for (let k = 0; k < n; k++) {
    const a = path[Math.max(0, k - 1)], b = path[Math.min(n - 1, k + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
    const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    // a frame round the limb: u across it (horizontal where it can be), w = t × u
    let ux = -tz, uy = 0, uz = tx;
    if (Math.hypot(ux, uz) < 1e-3) { ux = 1; uz = 0; }
    const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
    const wx = ty * uz - tz * uy, wy = tz * ux - tx * uz, wz = tx * uy - ty * ux;
    const shade = 0.72 + 0.28 * Math.min(1, path[k][1] / 3);
    for (let s = 0; s < sides; s++) {
      const q = (s / sides) * Math.PI * 2, cq = Math.cos(q), sq = Math.sin(q);
      const nx = ux * cq + wx * sq, ny = uy * cq + wy * sq, nz = uz * cq + wz * sq, r = radii[k];
      P.vert(path[k][0] + nx * r, path[k][1] + ny * r, path[k][2] + nz * r, nx, ny, nz, bark[0] * shade, bark[1] * shade, bark[2] * shade, 0);
    }
  }
  for (let k = 0; k + 1 < n; k++) for (let s = 0; s < sides; s++) {
    const a = o + k * sides + s, b = o + k * sides + (s + 1) % sides, c = a + sides, d = b + sides;
    P.i.push(a, c, b, b, c, d);
  }
}

// One blade of grass: a thin three-sided spike from a foot at (x, 0, z) to a tip, foliage (the leaf colour), dark
// at the foot and light at the tip, its normals leaning out and up so a clump lights as one soft tuft.
function blade(P, x, z, tx, ty, tz, w) {
  const o = P.count, ox = tx - x, oz = tz - z, ol = Math.hypot(ox, oz) || 1;
  for (let q = 0; q < 3; q++) {
    const a = q * 2.094, c = Math.cos(a), sn = Math.sin(a), nx = c * 0.6 + (ox / ol) * 0.3, nz = sn * 0.6 + (oz / ol) * 0.3;
    P.vert(x + c * w, 0, z + sn * w, nx, 0.55, nz, 0.42, 0.44, 0.4, 1);
  }
  P.vert(tx, ty, tz, ox / ol * 0.4, 0.9, oz / ol * 0.4, 1.06, 1.0, 0.82, 1);
  for (let q = 0; q < 3; q++) P.i.push(o + q, o + (q + 1) % 3, o + 3);
}

const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const GREEN = lin('#4a7a2c');      // the leaves among a poinciana's flowers
const BARK = { round: lin('#8a5a36'), umbrella: lin('#80583c'), banyan: lin('#957c62'), cone: lin('#806a58'), mangrove: lin('#5c5044'), pine: lin('#5e4636') };

// The shape families, each authored at its reference size (H tall, crown radius R; a tree of height h and crown r
// is this shape scaled by (r / R, h / H, r / R)), as lists so the near and the light trees share one layout:
//   C, box      the crown's middle and its bottom and top (y), for the clumps' normals and light
//   limbs(s)    [path, radii, sides, nearOnly?] trunks, roots and branches (the light trees take fewer sides
//               and leave the nearOnly ones out)
//   clumps(s)   [x, y, z, r, ry] foliage balls
//   far         [x, y, z, r, ry] the one ball of the far shape
// s varies the layout a little between families. ring(n, rr, y, r, ry, s, wave) is n clumps round the crown.
const ring = (n, rr, y, r, ry, s, wave = 0.3) => Array.from({ length: n }, (_, k) => {
  const a = s * 0.7 + (k / n) * Math.PI * 2;
  return [Math.cos(a) * rr, y + wave * Math.sin(k * 2.3 + s), Math.sin(a) * rr, r, ry];
});
// the bald cypress's sprays: eleven small, flat, irregular sprays held well out to the sides up the trunk (each to
// another side, some further out than others), so the crown is narrow and ragged, a little wider low down, with
// a flat, ragged top of two
const cypressSprays = (s) => [
  ...Array.from({ length: 11 }, (_, k) => {
    const f = k / 10, a = s * 1.3 + k * 2.4, r = 1.15 - 0.3 * f + 0.15 * Math.sin(k * 2.7 + s), d = r * (0.6 + 0.45 * (0.5 + 0.5 * Math.sin(k * 1.9 + s)));
    const y = 4.3 + f * 7.0 + 0.25 * Math.sin(k * 3.1 + s);
    return [Math.cos(a) * d, y, Math.sin(a) * d, r, 0.58 + 0.1 * Math.sin(k + s), r * (0.7 + 0.2 * Math.cos(k * 1.3 + s))];
  }),
  [0.15, 12.0, -0.1, 1.15, 0.52, 0.95], [-0.55, 11.7, 0.45, 0.85, 0.45, 0.75],
];
// the slash pine's branch tufts: an open, uneven crown in the top third
const PINE_TUFTS = [[0.4, 14.6, 0, 1.25, 0.75], [1.9, 13.3, 0.7, 1.15, 0.6], [-1.05, 13.7, 1.3, 1.1, 0.6], [0.6, 12.4, -1.75, 1.2, 0.62],
  [-1.65, 12.1, -0.5, 1.05, 0.55], [1.55, 11.0, -0.6, 1.0, 0.55], [-0.4, 10.5, 1.65, 0.95, 0.5]];
const FAMILIES = {
  round: {
    H: 9, R: 4, C: [0, 6.2, 0], box: [3.6, 9.1], bark: 'round',
    limbs: () => [[[[0, -0.3, 0], [0.12, 2.4, 0.05], [0.08, 5.4, 0]], [0.34, 0.25, 0.16], 7]],
    clumps: (s) => [[0, 7.35, 0, 2.2, 1.7], ...ring(5, 2.3, 5.9, 1.95, 1.55, s, 0.35), [0, 5.1, 0, 2.1, 1.2]],
    far: [0, 6.2, 0, 4, 2.9],
  },
  oval: {
    H: 10, R: 3.4, C: [0, 7.0, 0], box: [4.4, 10.1], bark: 'round',
    limbs: () => [[[[0, -0.3, 0], [-0.1, 2.8, 0.06], [0.05, 6.2, 0]], [0.3, 0.23, 0.14], 7]],
    clumps: (s) => [[0, 8.65, 0, 1.75, 1.5], ...ring(4, 1.75, 7.35, 1.65, 1.5, s, 0.25), ...ring(3, 1.6, 5.95, 1.75, 1.3, s + 0.9, 0.2)],
    far: [0, 7.1, 0, 3.4, 3.0],
  },
  umbrella: {
    H: 7, R: 5.5, C: [0, 5.6, 0], box: [4.6, 7.1], bark: 'umbrella',
    limbs: (s) => [[[[0, -0.3, 0], [0.1, 2.3, 0]], [0.32, 0.24], 7],
      ...Array.from({ length: 3 }, (_, k) => { const a = s + k * 2.1; return [[[0.1, 2.2, 0], [Math.cos(a) * 1.4, 3.6, Math.sin(a) * 1.4], [Math.cos(a) * 2.6, 4.9, Math.sin(a) * 2.6]], [0.2, 0.14, 0.09], 5]; })],
    clumps: (s) => [[0, 6.0, 0, 2.6, 1.05], ...ring(6, 3.3, 5.6, 2.2, 0.95, s, 0.2).map((c, k) => (k % 3 === 1 ? [...c, c[3], GREEN] : c))],
    far: [0, 5.7, 0, 4.9, 1.9],
  },
  banyan: {
    H: 10, R: 8, C: [0, 7.4, 0], box: [5.6, 10], bark: 'banyan',
    limbs: (s) => [
      // a trunk of fused stems, splayed at the foot
      ...Array.from({ length: 4 }, (_, k) => { const a = s + k * 1.57, c = Math.cos(a), q = Math.sin(a);
        return [[[c * 1.3, -0.3, q * 1.3], [c * 0.6, 1.4, q * 0.6], [c * 0.35, 3.6, q * 0.35], [c * 1.6, 6.2, q * 1.6]], [0.55, 0.5, 0.45, 0.3], 7, k > 1]; }),
      // two aerial roots grown into pillars, thick at the foot
      ...Array.from({ length: 2 }, (_, k) => { const a = s * 1.3 + k * 2.6, rr = 3.6 + k * 1.4;
        return [[[Math.cos(a) * rr, -0.3, Math.sin(a) * rr], [Math.cos(a) * rr * 0.97, 1.2, Math.sin(a) * rr * 0.97], [Math.cos(a) * rr * 1.08, 6.4, Math.sin(a) * rr * 1.08]], [0.42, 0.24, 0.16], 6, true]; })],
    clumps: (s) => [[0, 8.4, 0, 3.4, 1.6], ...ring(6, 3.6, 7.6, 2.9, 1.55, s), ...ring(7, 6.0, 7.0, 2.6, 1.35, s + 0.45)],
    far: [0, 7.4, 0, 8, 2.5],
  },
  cone: {
    // a bald cypress: a flared, buttressed foot, a straight trunk, and flat, ragged sprays of foliage held out to
    // the sides up it (never centred balls), the top flat
    H: 13, R: 2.4, C: [0, 8.4, 0], box: [3.4, 12.6], bark: 'cone',
    limbs: (s) => [[[[0, -0.3, 0], [0, 0.45, 0], [0, 1.5, 0], [0.05, 6, 0], [0.1, 11.9, 0]], [0.95, 0.55, 0.36, 0.26, 0.1], 7],
      // the buttresses round the foot
      ...Array.from({ length: 4 }, (_, k) => { const a = s + k * 1.57 + 0.4, c = Math.cos(a), q = Math.sin(a);
        return [[[c * 1.1, -0.3, q * 1.1], [c * 0.5, 0.45, q * 0.5], [c * 0.12, 1.9, q * 0.12]], [0.3, 0.2, 0.1], 4, true]; }),
      // a branch out to each spray (the light trees too, so no spray floats)
      ...cypressSprays(s).slice(0, 11).map(([x, y, z]) => [[[x * 0.06, y - 0.7, z * 0.06], [x * 0.8, y - 0.1, z * 0.8]], [0.09, 0.05], 4, true])],
    clumps: (s) => cypressSprays(s),
    far: [0, 8.6, 0, 2.0, 4.1],
    amp: 0.24, detail: 1, midDetail: 0,     // (small sprays: coarser balls do, near and light)
  },
  mangrove: {
    H: 4.5, R: 3.2, C: [0, 3.1, 0], box: [2.0, 4.6], bark: 'mangrove',
    // the prop roots arching down from the stems into the mud, and the stems
    limbs: (s) => [
      ...Array.from({ length: 8 }, (_, k) => { const a = s + k * (Math.PI / 4), c = Math.cos(a), q = Math.sin(a);
        return [[[c * 0.3, 1.7, q * 0.3], [c * 1.0, 1.35, q * 1.0], [c * 1.5, 0.6, q * 1.5], [c * 1.7, -0.3, q * 1.7]], [0.09, 0.08, 0.07, 0.07], 4, k & 1]; }),
      ...Array.from({ length: 3 }, (_, k) => { const a = s + k * 2.1; return [[[0, 1.0, 0], [Math.cos(a) * 0.5, 2.9, Math.sin(a) * 0.5]], [0.16, 0.1], 5]; })],
    clumps: (s) => [[0, 3.6, 0, 1.9, 1.0], ...ring(5, 1.75, 3.0, 1.6, 1.05, s, 0.2)],
    far: [0, 3.0, 0, 3.2, 1.5],
  },
  pine: {
    // a slash pine: a tall, slightly crooked bare trunk and an open, irregular crown of branch tufts
    H: 15, R: 3.2, C: [0.3, 12.4, 0], box: [9.6, 15.3], bark: 'pine',
    limbs: () => [[[[0, -0.3, 0], [0.35, 5, 0.1], [0.12, 9.8, -0.1], [0.4, 14.0, 0]], [0.34, 0.26, 0.2, 0.12], 7],
      ...PINE_TUFTS.slice(1).map(([x, y, z]) => [[[0.25, y - 1.0, 0], [x * 0.8, y - 0.15, z * 0.8]], [0.1, 0.05], 4])],
    clumps: () => PINE_TUFTS,
    far: [0.3, 12.4, 0, 2.7, 2.3],
    amp: 0.22,
  },
  bush: {
    H: 1.3, R: 1, C: [0, 0.55, 0], box: [0, 1.35],
    limbs: () => [],
    clumps: () => [[0, 0.72, 0, 0.82, 0.62], [0.45, 0.48, 0.32, 0.62, 0.48], [-0.42, 0.46, -0.3, 0.6, 0.46]],
  },
  flowerbush: {
    H: 1.3, R: 1, C: [0, 0.55, 0], box: [0, 1.35],
    limbs: () => [],
    clumps: () => [[0, 0.74, 0, 0.8, 0.6], [0.45, 0.48, 0.32, 0.62, 0.48, 0.62, GREEN], [-0.42, 0.46, -0.3, 0.6, 0.46], [-0.1, 0.42, 0.5, 0.5, 0.4, 0.5, GREEN]],
  },
  hedge: {
    // a 1 m segment (scaled along x to its length), 1 m tall and 1 m deep at the reference size
    H: 1, R: 0.5, C: [0, 0.4, 0], box: [0, 1],
    limbs: () => [],
    clumps: () => [[0, 0.52, 0, 0.62, 0.52, 0.52]],
    boxy: 1, amp: 0.05,
  },
  tuft: {
    // a clump of sawgrass or reeds: a fan of narrow blades from one foot (1 m tall and about 1 m across at the
    // reference size), the outer ones leaning further
    H: 1, R: 0.5, C: [0, 0.3, 0], box: [0, 1],
    limbs: () => [],
    clumps: () => [],
    blades: (s) => Array.from({ length: 10 }, (_, k) => {
      const a = s + k * 2.4, t = (k * 0.618 + 0.1) % 1, lean = 0.14 + 0.46 * t, h = 1 - 0.38 * t;
      return [Math.cos(a) * 0.12, Math.sin(a) * 0.12, Math.cos(a) * lean, h, Math.sin(a) * lean, 0.12];
    }),
  },
};
// a second bald cypress shape (its own seed), so a dome is not a bundle of copies of one tree
FAMILIES.cone_b = FAMILIES.cone;
// A family's shape at a level of detail: lod 2 near (smooth clumps), 1 light (the same layout, coarser).
function shapeOf(fam, lod, s) {
  const F = FAMILIES[fam], P = new Parts(), bark = BARK[F.bark] || BARK.round;
  for (const [path, radii, sides, nearOnly] of F.limbs(s)) if (lod === 2 || !nearOnly) limb(P, path, radii, lod === 2 ? sides : Math.max(3, sides - 2), bark);
  for (const [x, z, tx, ty, tz, w] of F.blades?.(s) || []) blade(P, x, z, tx, ty, tz, w);
  for (const [x, y, z, r, ry, rz, own] of F.clumps(s)) clump(P, x, y, z, r, ry, rz ?? r, lod === 2 ? F.detail ?? 2 : F.midDetail ?? 1, s + x * 3.1 + y * 1.7, F.C, F.box, { boxy: F.boxy || 0, amp: F.amp ?? 0.14, own });
  return P;
}
// tree kinds by family (a shade tree is round or oval, by the spot), and the leaf colours each draws from (sRGB)
const FAMILY_OF = { shade: 'round', jacaranda: 'round', blossom: 'round', poinciana: 'umbrella', banyan: 'banyan', cypress: 'cone', mangrove: 'mangrove', pine: 'pine',
  shrub: 'bush', seagrape: 'bush', bougainvillea: 'flowerbush', hedge: 'hedge', sawgrass: 'tuft' };
const LEAF = {
  shade: ['#3b6e26', '#457a2c', '#2f6222', '#527f30', '#4a7a2a', '#5e8a34', '#3f7430'],
  banyan: ['#355f24', '#3e6a28', '#47742e'],
  poinciana: ['#cf4a26', '#d95a28', '#c4432a', '#de6a30'],
  jacaranda: ['#b08cc0', '#b892c4', '#c09ad0'],
  blossom: ['#eea0c0', '#f4b2cc', '#e690b4'],
  cypress: ['#4f6b34', '#56713a', '#5f7a3a', '#4a6532', '#5a7436'],
  mangrove: ['#2c5a2a', '#36652e', '#28522a', '#40703a', '#305e26'],
  pine: ['#4c7c3e', '#578848', '#44733a'],
  shrub: ['#3e7228', '#356a26', '#4a7e2e', '#2c5f24', '#58842e'],
  seagrape: ['#7a9638', '#86a040', '#6e8a34'],
  bougainvillea: ['#c8508a', '#d06090', '#bc4a82', '#d47098'],
  hedge: ['#2e6224', '#346a28', '#295a22'],
  sawgrass: ['#8f9a4a', '#7e8e40', '#9ca552', '#71863a', '#a3a258'],
};

// ---------- the material ----------

const TIME = { value: 0 };
// Lambert foliage and bark: the leaf colour per copy (instanceColor) on foliage only, a light sway in the
// wind, the sky's fill (light.env) on the high tier and the lamp loops only while a lamp is on (light.lamps).
// mode: 'near' as it is; 'mid' shrinks each copy away across band (m from the camera); 'far' (the merged
// mesh, attribute base = the plant's foot and the distance it starts at) grows each one in across band.
function floraMaterial(light, mode, band = [MID, MID + BAND]) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  const u = { uTime: TIME, uBand: { value: new THREE.Vector2(band[0], band[1]) }, uSkyFill: light?.env || { value: new THREE.Color(0, 0, 0) }, uKcLamps: light?.lamps || { value: true },
    uSunCol: light?.sun || { value: new THREE.Color(3, 3, 3) } };
  const inst = mode !== 'far';
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = 'uniform float uTime;\nuniform vec2 uBand;\nattribute float leaf;\n' + (inst ? '' : 'attribute vec4 base;\n') + sh.vertexShader
      .replace('#include <color_vertex>', inst ? 'vColor = color * mix(vec3(1.0), instanceColor, max(leaf, 0.0));' : 'vColor = color;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        ${inst ? 'vec3 fRoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;' : 'vec3 fRoot = base.xyz;'}
        float fDist = distance(fRoot.xz, cameraPosition.xz);
        ${mode === 'mid' ? 'transformed *= 1.0 - smoothstep(uBand.x, uBand.y, fDist);' : ''}
        ${mode === 'far' ? 'transformed = fRoot + (transformed - fRoot) * smoothstep(base.w, base.w + (uBand.y - uBand.x), fDist);' : ''}
        // the wind: more toward the top (the height over the plant's foot: the far mesh is in world space), each
        // plant out of step
        float fPh = fRoot.x * 0.31 + fRoot.z * 0.17, fK = abs(leaf) * max(0.0, ${inst ? 'position.y' : 'position.y - base.y'}) * 0.011;
        transformed.x += sin(uTime * 1.15 + fPh) * fK;
        transformed.z += cos(uTime * 0.9 + fPh * 1.3) * fK * 0.7;
        ${inst ? 'vFloraPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;' : 'vFloraPos = transformed;'}
        vFloraLeaf = abs(leaf) * (1.0 - smoothstep(40.0, 120.0, fDist));`);
    sh.vertexShader = 'varying vec3 vFloraPos;\nvarying float vFloraLeaf;\n' + sh.vertexShader;
    sh.fragmentShader = 'uniform vec3 uSkyFill;\nuniform vec3 uSunCol;\nuniform bool uKcLamps;\nvarying vec3 vFloraPos;\nvarying float vFloraLeaf;\n' + LEAF_NOISE + sh.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
        // near foliage: clusters of leaves, lighter on their tops (faded out with distance, where it would shimmer)
        if (vFloraLeaf > 0.01) {
          float fn = floraNoise(vFloraPos * 1.5) * 0.55 + floraNoise(vFloraPos * 3.9 + 7.1) * 0.45;
          diffuseColor.rgb *= mix(1.0, 0.58 + 0.75 * fn * fn + 0.1 * fn, vFloraLeaf);
        }
        // by moonlight (a weak sun) the lilac and pink flowers (bluer than green) lose most of their colour, which
        // the blue moon and sky fill would otherwise turn into bright blue dots
        float fNight = 1.0 - smoothstep(0.8, 1.6, dot(uSunCol, vec3(0.3, 0.59, 0.11)));
        if (fNight > 0.0 && diffuseColor.b > diffuseColor.g) {
          float fL = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(fL * 1.15, fL, fL * 0.8), 0.6 * fNight);
        }`)
      .replace('#include <lights_fragment_begin>', lampGate(THREE.ShaderChunk.lights_fragment_begin))
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        reflectedLight.indirectDiffuse += diffuseColor.rgb * uSkyFill;`);
  };
  m.customProgramCacheKey = () => 'kc-flora-' + mode;
  m.userData.flora = u;
  return m;
}

// The palms' and the ground plants' materials (palms3d's and scatter3d's opts.material): Lambert in place of
// MeshStandard, with the sky's fill and the lamp gate like the trees, so they cost what the trees do (palms3d
// and scatter3d add their sway on top).
function skyLambert(light, params) {
  const u = { uSkyFill: light?.env || { value: new THREE.Color(0, 0, 0) }, uKcLamps: light?.lamps || { value: true } };
  const m = new THREE.MeshLambertMaterial(params);
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.fragmentShader = 'uniform vec3 uSkyFill;\nuniform bool uKcLamps;\n' + sh.fragmentShader
      .replace('#include <lights_fragment_begin>', lampGate(THREE.ShaderChunk.lights_fragment_begin))
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        reflectedLight.indirectDiffuse += diffuseColor.rgb * uSkyFill;`);
  };
  return m;
}
// palms3d hands over MeshStandard's params (the palms are vertex-coloured)
const palmMaterial = (light) => (kind, params) => skyLambert(light, { vertexColors: true, side: params.side ?? THREE.FrontSide });
// scatter3d hands over the pack's own material, whose picture, colour and cut-out are kept
const plantMaterial = (light) => (src) => skyLambert(light, { map: src.map, color: src.color, alphaTest: src.alphaTest, transparent: src.transparent,
  side: src.side, vertexColors: src.vertexColors });

// smooth 3D value noise in [0, 1], for the leaf clusters
const LEAF_NOISE = `
float floraHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float floraNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(floraHash(i), floraHash(i + vec3(1, 0, 0)), f.x), mix(floraHash(i + vec3(0, 1, 0)), floraHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(floraHash(i + vec3(0, 0, 1)), floraHash(i + vec3(1, 0, 1)), f.x), mix(floraHash(i + vec3(0, 1, 1)), floraHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
`;

// three's direct-lighting chunk with its point- and spot-light loops run only while uKcLamps is set (as
// terrain3d's lampGate: a uniform, so the shader never recompiles); a chunk of another shape is left alone.
function lampGate(chunk) {
  const P = '#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )\n', S = '#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )\n';
  const D = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )\n', END = '\t#pragma unroll_loop_end\n#endif\n';
  const p = chunk.indexOf(P), sp = chunk.indexOf(S), d = chunk.indexOf(D);
  if (p < 0 || sp < p || d < sp || chunk.slice(sp - END.length, sp) !== END || chunk.slice(d - END.length, d) !== END) return chunk;
  const gate = (body) => body.slice(0, -'#endif\n'.length).replace(/^(#if[^\n]*\n)/, '$1if ( uKcLamps ) {\n') + '}\n#endif\n';
  return chunk.slice(0, p) + gate(chunk.slice(p, sp)) + gate(chunk.slice(sp, d)) + chunk.slice(d);
}

// ---------- the plants ----------

const hashOf = (x, z, k) => {
  let h = Math.imul(Math.round(x * 10) | 0, 374761393) ^ Math.imul(Math.round(z * 10) | 0, 668265263) ^ Math.imul(k, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

// One plant ready to draw: where it stands (m), its family, its matrix (the family's shape scaled to its size,
// turned by rot) and its leaf colour, and the sphere round it for the frustum.
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
function itemOf(kind, x, y, z, h, r, rot, len) {
  const fam = kind === 'shade' && hashOf(x, z, 6) < 0.45 ? 'oval' : kind === 'cypress' && hashOf(x, z, 6) < 0.5 ? 'cone_b' : FAMILY_OF[kind], F = FAMILIES[fam];
  if (kind === 'hedge') _s.set(len || 2.3, h / F.H, (r * 2) / (F.R * 2));
  else _s.set(r / F.R, h / F.H, r / F.R);
  _m.compose(_p.set(x, y, z), _q.setFromAxisAngle(_up, rot), _s);
  const pal = LEAF[kind] || LEAF.shade, u = hashOf(x, z, 3), c = new THREE.Color(pal[Math.floor(u * pal.length)]);
  const v = 0.9 + hashOf(x, z, 4) * 0.2;
  return { kind, fam, x, y, z, h, r, mat: Float32Array.from(_m.elements), col: Float32Array.of(c.r * v, c.g * v, c.b * v),
    cy: y + h * 0.55, rad: Math.max(h * 0.55, r, len ? len / 2 : 0) + 0.5 };
}

// The kind a world tree draws as: the Coral Way banyans (r 3.5 m and up) are banyans, the rest shade trees.
function worldTree(t, i) {
  const r = t.r / PX, banyan = r >= 3.5;
  return { kind: banyan ? 'banyan' : 'shade', x: t.x / PX, z: t.y / PX, r: banyan ? r * 1.7 : Math.max(2.2, r * 1.4),
    h: banyan ? 7.5 + r * 0.6 : 5.5 + r * 1.4, rot: hashOf(t.x, t.y, 5 + i) * Math.PI * 2 };
}

// ---------- the near and light copies ----------

// One instanced mesh of a family at one level of detail, refilled each time the copies are picked.
function makeTier(group, geo, mat, cap, cast) {
  const n = Math.max(1, cap), m = new THREE.InstancedMesh(geo, mat, n);
  m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  m.count = 0; m.frustumCulled = false; m.receiveShadow = true; m.castShadow = cast; m.visible = false;
  if (cast) castFirst(m);
  group.add(m);
  return { m, cast: !!cast, casting: [], rest: [], n: 0, nCast: 0 };
}
// The casting copies first, each list nearest first (the near crowns hide the ones behind before they are drawn).
const byDist = (a, b) => a.d2 - b.d2;
function fillTier(T) {
  const M = T.m.instanceMatrix.array, C = T.m.instanceColor.array;
  T.casting.sort(byDist); T.rest.sort(byDist);
  let n = 0;
  for (const it of T.casting) { M.set(it.mat, n * 16); C.set(it.col, n * 3); n++; }
  const nCast = n;
  for (const it of T.rest) { M.set(it.mat, n * 16); C.set(it.col, n * 3); n++; }
  T.casting.length = 0; T.rest.length = 0;
  if (T.cast) setCopies(T.m, n, nCast);
  else { T.m.count = n; uploadFirst(T.m.instanceMatrix, n); }
  uploadFirst(T.m.instanceColor, n);
  T.m.visible = n > 0;
  T.n = n; T.nCast = nCast;
}

// A set of plants drawn near (full shapes) out to `near` (none when near is 0), light out to `far` (shrinking
// away over the last stretch, by the mid material's band), refreshed when the camera moves or turns or the
// shadow focus moves.
function makeLodSet(group, items, { near, far, cast, mats }) {
  const fams = new Map();
  for (const it of items) fams.set(it.fam, (fams.get(it.fam) || 0) + 1);
  const tiers = new Map(), all = [];
  for (const [fam, count] of fams) {
    const seed = fam.length * 1.37, P2 = near > 0 ? shapeOf(fam, 2, seed) : null, P1 = shapeOf(fam, 1, seed);
    const t = { near: P2 && makeTier(group, P2.geometry(), mats.near, count, cast > 0), mid: makeTier(group, P1.geometry(), mats.mid, count, cast > near) };
    t.tris = [P2 ? P2.i.length / 3 : 0, P1.i.length / 3];
    tiers.set(fam, t); all.push(...(t.near ? [t.near] : []), t.mid);
  }
  for (const it of items) it.tier = tiers.get(it.fam);
  const buckets = makeBuckets(items);
  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4(), sphere = new THREE.Sphere();
  const last = new THREE.Vector3(1e9, 0, 0), lastDir = new THREE.Vector3(), dir = new THREE.Vector3(), lastF = { x: 1e9, z: 0 };
  const lists = [], f2 = far * far, n2 = near * near, c2 = cast * cast;
  return {
    tiers, items,
    update(camera, f) {
      const p = camera.position;
      camera.getWorldDirection(dir);
      if (p.distanceToSquared(last) < 2.25 && dir.dot(lastDir) > 0.997 && (!f || (f.x - lastF.x) ** 2 + (f.z - lastF.z) ** 2 < 2.25)) return false;
      last.copy(p); lastDir.copy(dir);
      if (f) { lastF.x = f.x; lastF.z = f.z; }
      frustum.setFromProjectionMatrix(pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      for (const list of buckets.near(p.x, p.z, far, lists)) for (const it of list) {
        const dx = it.x - p.x, dz = it.z - p.z, d2 = dx * dx + dz * dz;
        if (d2 > f2) continue;
        // plants that cast are kept even out of view: their shadows may fall in it
        const casts = !!f && (it.x - f.x) ** 2 + (it.z - f.z) ** 2 < c2;
        if (!casts) { sphere.center.set(it.x, it.cy, it.z); sphere.radius = it.rad; if (!frustum.intersectsSphere(sphere)) continue; }
        const T = d2 < n2 && it.tier.near ? it.tier.near : it.tier.mid;
        it.d2 = d2;
        (casts && T.cast ? T.casting : T.rest).push(it);
      }
      for (const T of all) fillTier(T);
      return true;
    },
    stats() {
      const out = { items: items.length, near: 0, mid: 0, casting: 0, tris: 0, calls: 0 };
      for (const t of tiers.values()) {
        const nn = t.near?.n || 0;
        out.near += nn; out.mid += t.mid.n; out.casting += (t.near?.nCast || 0) + t.mid.nCast;
        out.tris += nn * t.tris[0] + t.mid.n * t.tris[1];
        out.calls += (nn > 0) + (t.mid.n > 0);
      }
      return out;
    },
  };
}

// ---------- the far mesh ----------

// Every tree's far shape and every palm's silhouette in one mesh in world space: a few triangles each, drawn
// past MID (palms past PALM_LO), growing in across the band. base: the foot (x, y, z) and the distance it
// starts at. It is written straight into typed arrays, sized up front (some 200 k vertices).
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _nm = new THREE.Matrix3();
const FAR_SHAPES = {}, FAR_WIDEN = 1.12;
// A trunk far away (or a tuft of sawgrass): a three-sided spike (three triangles) from a foot at (x, y, z) up to
// its tip, its colour c a little darker at the foot. W: a Parts or the far mesh's writer, which take the same
// vert(); leaf as Parts' (0 bark).
function spike(W, x, y, z, tx, ty, tz, r, c, tri, leaf = 0) {
  const o = W.vert(tx, ty, tz, 0, 1, 0, c[0], c[1], c[2], leaf);
  for (let q = 0; q < 3; q++) {
    const a = q * 2.094, cq = Math.cos(a), sq = Math.sin(a);
    W.vert(x + cq * r, y, z + sq * r, cq, 0.4, sq, c[0] * 0.75, c[1] * 0.75, c[2] * 0.75, leaf);
  }
  for (let q = 0; q < 3; q++) tri(o + 1 + q, o, o + 1 + (q + 1) % 3);
}

// a family's far shape (made once): a spike of a trunk and one foliage ball
function farShape(fam) {
  if (FAR_SHAPES[fam]) return FAR_SHAPES[fam];
  const F = FAMILIES[fam], [cx, cy, cz, R, RY] = F.far, Q = new Parts();
  spike(Q, 0, -0.3, 0, cx * 0.5, cy, cz * 0.5, F.R * 0.08, BARK[F.bark] || BARK.round, (a, b, c) => Q.i.push(a, b, c));
  // (a little wider than the near crown, so distant woods close up into a canopy)
  clump(Q, cx, cy, cz, R * FAR_WIDEN, RY, R * FAR_WIDEN, 0, 1.3, [cx, cy, cz], [cy - RY, cy + RY], { amp: 0.07 });
  return (FAR_SHAPES[fam] = Q);
}

// the far mesh's arrays and a cursor: vert() writes one vertex and its base, tri() one triangle
function farWriter(nv, ni) {
  const W = { p: new Float32Array(nv * 3), n: new Float32Array(nv * 3), c: new Float32Array(nv * 3), l: new Float32Array(nv), b: new Float32Array(nv * 4),
    i: nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni), v: 0, k: 0, bx: 0, by: 0, bz: 0, bw: 0 };
  W.vert = (x, y, z, nx, ny, nz, r, g, bl, leaf) => {
    const v = W.v++, o = v * 3;
    W.p[o] = x; W.p[o + 1] = y; W.p[o + 2] = z; W.n[o] = nx; W.n[o + 1] = ny; W.n[o + 2] = nz; W.c[o] = r; W.c[o + 1] = g; W.c[o + 2] = bl;
    W.l[v] = leaf; W.b[v * 4] = W.bx; W.b[v * 4 + 1] = W.by; W.b[v * 4 + 2] = W.bz; W.b[v * 4 + 3] = W.bw;
    return v;
  };
  W.tri = (a, b, c) => { W.i[W.k++] = a; W.i[W.k++] = b; W.i[W.k++] = c; };
  return W;
}

function farTree(W, it) {
  const Q = farShape(it.fam), o = W.v, k = it.col, P = Q.p, N = Q.n, C = Q.c;
  W.bx = it.x; W.by = it.y; W.bz = it.z; W.bw = MID;
  _m.fromArray(it.mat); _nm.getNormalMatrix(_m);
  for (let i = 0; i < Q.count; i++) {
    _v.fromArray(P, i * 3).applyMatrix4(_m); _n.fromArray(N, i * 3).applyMatrix3(_nm).normalize();
    const leaf = Q.l[i];
    W.vert(_v.x, _v.y, _v.z, _n.x, _n.y, _n.z, C[i * 3] * (leaf > 0 ? k[0] : 1), C[i * 3 + 1] * (leaf > 0 ? k[1] : 1), C[i * 3 + 2] * (leaf > 0 ? k[2] : 1), leaf);
  }
  for (let i = 0; i < Q.i.length; i += 3) W.tri(o + Q.i[i], o + Q.i[i + 1], o + Q.i[i + 2]);
}

// A palm far away: a spike of a trunk out to where palms3d's bend and lean put the crown, and six drooping fronds
// round it, each a triangle out to its middle and one down to its tip.
const PALM_BARK = [0.49, 0.25, 0.1], PALM_LEAF = [0.23, 0.49, 0.08], BEND = 0.55, _e = new THREE.Euler();
const PALM_V = 4 + 1 + 18, PALM_T = 3 + 12;
function farPalm(W, s) {
  _q.setFromEuler(_e.set(0, s.rot, s.lean, 'YZX'));
  _m.compose(_p.set(s.x, s.y - 0.1, s.z), _q, _s.set(1, s.h, 1));
  W.bx = s.x; W.by = s.y; W.bz = s.z; W.bw = PALM_LO;
  _v.set(BEND, 1, 0).applyMatrix4(_m);
  const top = [_v.x, _v.y, _v.z];
  spike(W, s.x, s.y - 0.1, s.z, top[0], top[1], top[2], 0.3, PALM_BARK, W.tri);
  const k = s.k || 1.2, a0 = s.rot * 2.3, L = PALM_LEAF;
  const hub = W.vert(top[0], top[1] + 0.3, top[2], 0, 1, 0, L[0], L[1], L[2], 1);
  for (let f = 0; f < 6; f++) {
    const a = a0 + f * (Math.PI * 2 / 6), c = Math.cos(a), q = Math.sin(a), w = 0.55 * k, g = 0.8 + 0.2 * Math.sin(f * 1.7);
    const mx = top[0] + c * 1.9 * k, my = top[1] + 0.45, mz = top[2] + q * 1.9 * k;
    const m1 = W.vert(mx - q * w, my, mz + c * w, c * 0.3, 0.95, q * 0.3, L[0] * g, L[1] * g, L[2] * g, 1);
    const m2 = W.vert(mx + q * w, my, mz - c * w, c * 0.3, 0.95, q * 0.3, L[0] * g, L[1] * g, L[2] * g, 1);
    const t1 = W.vert(top[0] + c * 3.7 * k, top[1] - 1.5, top[2] + q * 3.7 * k, c * 0.6, 0.8, q * 0.6, L[0] * g * 0.85, L[1] * g * 0.85, L[2] * g * 0.85, 1);
    W.tri(hub, m1, m2); W.tri(m1, t1, m2);
  }
}

// The far mesh in FAR_CHUNK m squares, one mesh each, so the squares behind the camera or off to the side are
// not drawn (three culls each by its bounding sphere; the shader only ever pulls a vertex in toward its foot).
const FAR_CHUNK = 768;
// tufts: the marsh's sawgrass, a spike each past SHRUB_FAR (so the marsh keeps its texture far off)
function makeFarMesh(group, trees, palms, tufts, mat) {
  const bins = new Map(), bin = (x, z) => { const k = Math.floor(z / FAR_CHUNK) * 64 + Math.floor(x / FAR_CHUNK); return bins.get(k) || bins.set(k, { trees: [], palms: [], tufts: [] }).get(k); };
  for (const it of trees) bin(it.x, it.z).trees.push(it);
  for (const s of palms) bin(s.x, s.z).palms.push(s);
  for (const it of tufts) bin(it.x, it.z).tufts.push(it);
  const meshes = [];
  let tris = 0, verts = 0;
  for (const b of bins.values()) {
    let nv = b.palms.length * PALM_V + b.tufts.length * 4, ni = (b.palms.length * PALM_T + b.tufts.length) * 3;
    for (const it of b.trees) { const Q = farShape(it.fam); nv += Q.count; ni += Q.i.length; }
    const W = farWriter(nv, ni);
    for (const it of b.trees) farTree(W, it);
    for (const s of b.palms) farPalm(W, s);
    for (const it of b.tufts) {
      W.bx = it.x; W.by = it.y; W.bz = it.z; W.bw = SHRUB_FAR - SHRUB_FADE;
      spike(W, it.x, it.y, it.z, it.x, it.y + it.h * 0.85, it.z, it.r * 0.75, it.col, W.tri, 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(W.p, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(W.n, 3));
    g.setAttribute('color', new THREE.BufferAttribute(W.c, 3));
    g.setAttribute('leaf', new THREE.BufferAttribute(W.l, 1));
    g.setAttribute('base', new THREE.BufferAttribute(W.b, 4));
    g.setIndex(new THREE.BufferAttribute(W.i, 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.castShadow = false; m.receiveShadow = false; m.userData.noAO = true;
    group.add(m);
    meshes.push(m); tris += ni / 3; verts += nv;
  }
  return { meshes, tris, verts };
}

// ---------- the ground plants (scatter3d, streamed per 64 m cell) ----------

// Small plants and rocks per 64 m cell, read from SURF on a jittered 2 m lattice: lawns get grass tufts and
// clover with the odd flower clump, more of them in the gardens and long marsh grass in the Glades (thick, tall
// sawgrass where placeFlora's sawgrass tufts grow, marshAt), tall reeds where the Glades meet water, ferns and big
// leaves under the trees; rock faces and cliffs get boulders, beaches dune
// grass on their dry inland edge. Nothing goes on paving, water, buildings or blocked cells.
const SURF_K = { ROAD: 0, WALK: 1, GRASS: 2, BUILD: 3, LOT: 4, PLAZA: 5, WATER: 6, SAND: 7, DIRT: 8, SHALLOW: 9, DECK: 10, ROCK: 11 };
const LAWN = {
  lawn: [['Grass_Common_Short', 6], ['Grass_Wispy_Short', 2], ['Clover_1', 2], ['Grass_Common_Tall', 1]],
  garden: [['Grass_Common_Short', 5], ['Clover_1', 3], ['Grass_Wispy_Short', 1]],
  wild: [['Grass_Wispy_Short', 3], ['Grass_Common_Short', 3], ['Grass_Wispy_Tall', 2], ['Grass_Common_Tall', 1]],
  marsh: [['Grass_Wispy_Tall', 5], ['Grass_Common_Tall', 3], ['Grass_Wispy_Short', 2]],
};
const ACCENT = {
  lawn: [['Flower_3_Group', 2], ['Plant_1', 1], ['Fern_1', 1]],
  garden: [['Flower_3_Group', 3], ['Flower_4_Group', 3], ['Plant_1', 1]],
  wild: [['Fern_1', 2], ['Plant_7_Big', 1], ['Flower_3_Group', 1]],
  marsh: [['Fern_1', 3], ['Plant_7_Big', 2]],
};
// per region: which mix its lawns take, and how thick the grass is (share of 2 m lattice points with a tuft)
const GROUND_MIX = {
  heights: ['wild', 0.2], north_shore: ['wild', 0.2], cape: ['wild', 0.17], glades: ['marsh', 0.3], gables: ['garden', 0.26],
  islets: ['garden', 0.3], fest_airport: ['lawn', 0.13], port: ['lawn', 0.1], ktown: ['lawn', 0.2], downtown: ['lawn', 0.2],
  collins: ['lawn', 0.2], deco: ['lawn', 0.2],
};
export const SCATTER_KINDS = {
  Grass_Common_Short: { far: 45 }, Grass_Wispy_Short: { far: 45 }, Grass_Common_Tall: { far: 50 }, Grass_Wispy_Tall: { far: 60 },
  Clover_1: { far: 40 }, Flower_3_Group: { far: 70 }, Flower_4_Group: { far: 70 }, Fern_1: { far: 60 }, Plant_1: { far: 55 },
  Plant_7_Big: { far: 60 }, Plant_1_Big: { far: 80 },
  Rock_Medium_1: { far: 130, shadow: true }, Rock_Medium_2: { far: 130, shadow: true }, Rock_Medium_3: { far: 130, shadow: true },
  Pebble_Round_1: { far: 45 }, Pebble_Round_2: { far: 45 },
};
const SCATTER_CAP = { default: 600, Grass_Common_Short: 1600, Grass_Wispy_Short: 1200, Grass_Wispy_Tall: 1000, Grass_Common_Tall: 1200, Clover_1: 900, Fern_1: 900 };

function pick(list, u) {
  let t = u * list.reduce((a, b) => a + b[1], 0);
  for (const [n, w] of list) if ((t -= w) <= 0) return n;
  return list[0][0];
}

function groundPlants(world, treeBuckets) {
  const G = world.grids, SW = G.dims.surf[0], SH = G.dims.surf[1], R = world.regions, groundY = world.groundY;
  const bits = (x, z) => (x < 0 || z < 0 || x >= SW || z >= SH ? SURF_K.WATER : G.surf[Math.floor(z) * SW + Math.floor(x)]);
  const kind = (x, z) => bits(x, z) & 15;
  const natural = (k) => k === SURF_K.GRASS || k === SURF_K.SAND || k === SURF_K.DIRT || k === SURF_K.ROCK;
  const wet = (k) => k === SURF_K.WATER || k === SURF_K.SHALLOW;
  const regionOf = (x, z) => R[G.reg[Math.min(G.dims.reg[1] - 1, Math.floor(z / 8)) * G.dims.reg[0] + Math.min(G.dims.reg[0] - 1, Math.floor(x / 8))]]?.id;
  const r = (a, b, k) => world.hash(a * 7 + k, b * 13 - k * 5);
  const lists = [];
  return (cx, cz) => {
    const out = [], x0 = cx * BUCKET, z0 = cz * BUCKET;
    for (let j = 0; j < BUCKET; j += 2) for (let i = 0; i < BUCKET; i += 2) {
      const ax = x0 + i, az = z0 + j;
      const x = ax + r(ax, az, 1) * 2, z = az + r(ax, az, 2) * 2, b = bits(x, z), k = b & 15;
      if (b & 0x30 || !natural(k)) continue;
      const u = r(ax, az, 3), rot = r(ax, az, 4) * 6.283, v = r(ax, az, 5);
      const y = () => groundY(x * PX, z * PX);
      if (k === SURF_K.GRASS) {
        const reg = regionOf(x, z), [mix, thick] = GROUND_MIX[reg] || ['lawn', 0.25];
        // tall reeds where the Glades meet open water, thick sawgrass through its marsh patches
        if (reg === 'glades' && u < 0.6 && (wet(kind(x + 3, z)) || wet(kind(x - 3, z)) || wet(kind(x, z + 3)) || wet(kind(x, z - 3))))
          out.push({ name: 'Grass_Wispy_Tall', x, y: y(), z, rot, s: 0.9 + r(ax, az, 6) * 0.5 });
        else if (reg === 'glades' && r(ax, az, 7) < 0.55 * marshAt(x, z))
          out.push({ name: v < 0.7 ? 'Grass_Common_Tall' : 'Grass_Wispy_Tall', x, y: y(), z, rot, s: 0.9 + r(ax, az, 6) * 0.45 });
        else if (u < thick) out.push({ name: pick(LAWN[mix], v), x, y: y(), z, rot, s: (mix === 'marsh' ? 0.6 : 0.42) + r(ax, az, 6) * (mix === 'marsh' ? 0.4 : 0.3) });
        else if (u < thick + 0.025) out.push({ name: pick(ACCENT[mix], v), x, y: y(), z, rot, s: 0.34 + r(ax, az, 6) * 0.2 });
        else if (u > 0.988 && mix !== 'lawn') out.push({ name: 'Plant_1_Big', x, y: y(), z, rot, s: 0.5 + r(ax, az, 6) * 0.3 });
        else if (u > 0.975 && mix === 'wild' && kind(x + 2, z) === SURF_K.GRASS && kind(x - 2, z) === SURF_K.GRASS)
          out.push({ name: ['Rock_Medium_1', 'Rock_Medium_2', 'Rock_Medium_3'][Math.floor(v * 3)], x, y: y() - 0.1, z, rot, s: 0.4 + r(ax, az, 6) * 0.6 });
      } else if (k === SURF_K.ROCK) {
        if (u < 0.12) out.push({ name: ['Rock_Medium_1', 'Rock_Medium_2', 'Rock_Medium_3'][Math.floor(v * 3)], x, y: y() - 0.2, z, rot, s: 0.6 + r(ax, az, 6) * 0.9 });
      } else if (k === SURF_K.SAND) {
        // dune grass only on the dry inland edge of a beach, where grass is near
        if (u < 0.18 && y() > 1.2 && (kind(x + 3, z) === SURF_K.GRASS || kind(x - 3, z) === SURF_K.GRASS || kind(x, z + 3) === SURF_K.GRASS || kind(x, z - 3) === SURF_K.GRASS))
          out.push({ name: v < 0.6 ? 'Grass_Wispy_Tall' : 'Grass_Wispy_Short', x, y: y(), z, rot, s: 0.4 + r(ax, az, 6) * 0.25 });
      } else if (k === SURF_K.DIRT) {
        if (u < 0.05) out.push({ name: v < 0.5 ? 'Pebble_Round_1' : 'Pebble_Round_2', x, y: y(), z, rot, s: 0.3 + r(ax, az, 6) * 0.3 });
        else if (u < 0.15) out.push({ name: 'Grass_Wispy_Short', x, y: y(), z, rot, s: 0.35 + r(ax, az, 6) * 0.2 });
      }
    }
    // ferns and big leaves in the shade under the trees of this cell
    if (treeBuckets) for (const list of treeBuckets.near(x0 + BUCKET / 2, z0 + BUCKET / 2, BUCKET * 0.72, lists)) for (const t of list) {
      if (t.x < x0 || t.x >= x0 + BUCKET || t.z < z0 || t.z >= z0 + BUCKET || t.fam === 'bush' || t.fam === 'hedge' || t.fam === 'mangrove') continue;
      const n = 2 + Math.floor(hashOf(t.x, t.z, 21) * 3);
      for (let q = 0; q < n; q++) {
        const a = hashOf(t.x, t.z, 22 + q) * 6.283, d = t.r * (0.25 + hashOf(t.x, t.z, 30 + q) * 0.55), x = t.x + Math.cos(a) * d, z = t.z + Math.sin(a) * d;
        if (kind(x, z) !== SURF_K.GRASS || bits(x, z) & 0x30) continue;
        out.push({ name: q % 3 === 2 ? 'Plant_1_Big' : 'Fern_1', x, y: groundY(x * PX, z * PX), z, rot: a * 3, s: 0.6 + hashOf(t.x, t.z, 40 + q) * 0.5 });
      }
    }
    return out;
  };
}

// ---------- the whole vegetation ----------

// world: the v2 world facade; group: where the meshes go; light: cityV2's makeSkyLight (the sky's fill and the
// lamp gate). The trees and shrubs are drawn from the first frame; the palms and ground plants come with
// their models.
export function buildFlora3D(world, group, { light } = {}) {
  const q = globalThis.location?.search || '';
  const off = q.includes('shot=') && q.includes('noflora=1');     // a dev page can leave it out to measure its cost
  const t0 = performance.now();
  const placed = off ? { trees: [], palms: [], shrubs: [] } : world.flora?.trees ? world.flora : placeFlora(world.roads, world.grids, world.regions, {
    avoid: [...(world.palms || []), ...(world.trees || [])],
    keep: [...(world.lamps || []), ...(world.deco || []).filter(d => Number.isFinite(d.x) && d.list !== 'guardrails' && d.list !== 'fences')],
    buildings: world.buildings, places: world.places,
  });
  const tPlace = performance.now() - t0;
  const gy = (x, z) => world.groundY(x * PX, z * PX);
  const trees = [];
  if (!off) {
    // the world's trees (a few stand on another's trunk: those are left out)
    (world.trees || []).forEach((t, i) => {
      const w = worldTree(t, i);
      if (!trees.some(o => Math.hypot(o.x - w.x, o.z - w.z) < 2)) trees.push(itemOf(w.kind, w.x, gy(w.x, w.z) - 0.1, w.z, w.h, w.r, w.rot));
    });
    for (const t of placed.trees) { const x = t.x / PX, z = t.y / PX; trees.push(itemOf(t.kind, x, gy(x, z) - 0.1, z, t.h, t.r, t.rot)); }
  }
  const shrubs = placed.shrubs.map(s => { const x = s.x / PX, z = s.y / PX; return itemOf(s.kind, x, gy(x, z) - 0.05, z, s.h, s.r, s.rot, s.len); });
  // (each palm's crown a little bigger or smaller than palms3d's 1.2)
  const palmSpots = off ? [] : [...(world.palms || []), ...placed.palms].map(p => ({ x: p.x / PX, z: p.y / PX, y: gy(p.x / PX, p.y / PX), h: p.h, lean: p.lean, rot: p.rot,
    k: 1.05 + hashOf(p.x, p.y, 9) * 0.32 }));

  const mats = { near: floraMaterial(light, 'near'), mid: floraMaterial(light, 'mid', [MID, MID + BAND]) };
  const shrubMats = { near: mats.near, mid: floraMaterial(light, 'mid', [SHRUB_FAR - SHRUB_FADE, SHRUB_FAR]) };
  const treeSet = makeLodSet(group, trees, { near: NEAR, far: MID + BAND, cast: CAST, mats });
  const shrubSet = makeLodSet(group, shrubs, { near: SHRUB_NEAR, far: SHRUB_FAR, cast: SHRUB_CAST, mats: shrubMats });
  const far = makeFarMesh(group, trees, palmSpots, shrubs.filter(s => s.kind === 'sawgrass'), floraMaterial(light, 'far', [MID, MID + BAND]));
  const tBuild = performance.now() - t0 - tPlace;

  const sun = shadowFocus(group);
  let palms = null, scatter = null;
  if (palmSpots.length) makePalmField(group, palmSpots, { castR: PALM_CAST, far: PALM_LO, band: BAND, material: palmMaterial(light) })
    .then((f) => { palms = f; }).catch((e) => console.warn('palm models failed to load', e));
  if (!off) loadAssetPack('assets/nature.glb', { material: plantMaterial(light) }).then((pack) => {
    scatter = makeStreamScatter(group, pack, { gen: groundPlants(world, makeBuckets(trees)), kinds: SCATTER_KINDS, capacity: SCATTER_CAP });
  }).catch((e) => console.warn('asset pack failed to load', e));

  return {
    placed, trees: treeSet, shrubs: shrubSet, far,
    // once a frame; focus (optional): where the sun's shadow box is centred (by default the sun's target)
    update(camera, t, focus) {
      TIME.value = t;
      const f = focus || sun() || camera.position;
      treeSet.update(camera, f);
      shrubSet.update(camera, f);
      if (palms) palms.update(camera, t, focus);
      if (scatter) scatter.update(camera, t, focus);
    },
    stats() {
      return { placeMs: Math.round(tPlace), buildMs: Math.round(tBuild), trees: treeSet.stats(), shrubs: shrubSet.stats(), far: { tris: far.tris, verts: far.verts },
        palms: palms?.stats(), scatter: scatter?.stats() };
    },
  };
}
