// The Kimchi Key v2 coast in 3D (docs/map-v2-spec.md §3 and §11.1 Sea): the sea, the inland water, the beach
// props, and the marina's pier with its yachts.
//
//  - The sea is one 6 km plane at SEA_LEVEL, opaque, coloured by the SEADEPTH raster (turquoise over the sand
//    shelf, deep blue offshore) with foam and rolling lines where it is shallow, so every beach, cliff and
//    seawall gets its surf from the data, and past the map's edge it deepens smoothly into open sea. It is
//    drawn after the land and lit by hand (waterMaterial). The ripple map scrolls (main3d moves its offset;
//    the ponds share it).
//  - Gator Lagoon and the Glades ponds are flat meshes at their own levels, in the same shader (SEADEPTH holds
//    their depth below their own level), greener and with little foam. They reach 1.5 m past their shapes so
//    they meet the banks.
//  - Seawalls: every bay shore, the island's west shore and the islets stand straight in the data (the land
//    keeps its height to the edge and the sea bed shelves away over the next few metres), so a stone wall with
//    a coping strip closes that step, its face at the waterline and running straight along each straight
//    shore (buildSeawalls says where it stands and where it leaves off).
//  - Beach props (lifeguard towers, umbrellas and towels) stand on the dry sand of the beach coasts, merged
//    into one mesh per 256 m tile. They come from the world's deco list when the world passes them on
//    (kinds lifeguard, umbrella and towel on sand), else they are placed here by the same rule props.js uses.
//  - The marina pier runs out from places.marina.pier (deck, piles, rails) with yachts moored along it.
//
// buildCoast3D(world, group, { chunks, light }) -> { sea, yachts, ponds, pier, beach, walls, wallRuns, update(t), stats() }
// (wallRuns: each wall's face line, stop by stop, { x, z, o, out, edge }, for the tests).
// world is the world facade's namespace; chunks (optional) draws the beach props only near the camera and casts
// their shadows only near the player; light (optional) is terrain3d's makeSkyLight, shared with the terrain and
// updated by its owner (without one the coast reads the scene's lights itself in update).
import * as THREE from 'three';
import { Builder, mat4, col } from './geo.js';
import { matte } from './quality.js';
import { TILE } from './chunks.js';
import { makeSkyLight } from './terrain3d.js';
import * as TX from './textures.js';
import { mulberry32 } from '../util.js';
import { PATHS } from '../map/mapdata.js';

const SEA_SIZE = 6000;           // m across the sea plane, centred on the map
const POND_REACH = 1.5;          // m the inland water reaches past its shapes, under the banks
const YACHT_DRAFT = 0.75;        // m a yacht's hull sits below the water line
const YACHT_BERTHS = [[19, 1, 16], [22, -1, 22], [38, 1, 16], [43, -1, 14]];   // [m from the pier's root, side, length]
const YACHT_GAP = 3;             // m clear between the yachts moored on one side

// ---------- the water ----------

// The water colour: shallow (over sand), mid and deep, as sRGB; the shader works in linear.
const SEA_COLS = { shallow: '#4fe0cf', mid: '#1fa6c9', deep: '#14549e' };
const POND_COLS = { shallow: '#6fb79a', mid: '#3d8f86', deep: '#245f66' };

// The sea bed for the water shader, two bytes a 2 m cell: R the depth (SEADEPTH, 0-20 m in 0-255) and G how
// steeply the bed shelves there (the square root of metres of depth per metre, from the depth blurred over
// about 10 m). Depth over slope is about how far a point lies out from the waterline, so the surf is drawn at a
// steady width on a gentle beach shelf and at a seawall alike.
function depthTexture(G) {
  const [w, h] = G.dims.seaDepth, D = G.seaDepth, cell = G.w / w;
  const row = new Float32Array(w * h), blur = new Float32Array(w * h);
  const at = (a, i, j) => a[(j < 0 ? 0 : j >= h ? h - 1 : j) * w + (i < 0 ? 0 : i >= w ? w - 1 : i)];
  for (let k = 0; k < w * h; k++) blur[k] = D[k] * (20 / 255);
  // twice a 3 x 3 box: about 10 m across, which smooths the 8-bit depth's steps out of the slope
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) row[j * w + i] = (at(blur, i - 1, j) + at(blur, i, j) + at(blur, i + 1, j)) / 3;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) blur[j * w + i] = (at(row, i, j - 1) + at(row, i, j) + at(row, i, j + 1)) / 3;
  }
  const data = new Uint8Array(w * h * 2);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i, gx = (at(blur, i + 1, j) - at(blur, i - 1, j)) / (2 * cell), gz = (at(blur, i, j + 1) - at(blur, i, j - 1)) / (2 * cell);
    data[k * 2] = D[k];
    data[k * 2 + 1] = Math.round(Math.sqrt(Math.min(1, Math.hypot(gx, gz))) * 255);
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGFormat, THREE.UnsignedByteType);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// The sea shader. The water is most of the screen in many v2 views, so it is lit here rather than by the
// full lighting loop: an unlit material whose colour is worked out per pixel from the depth under it, then
// lit the way MeshStandard lights a level surface (the sun over it and the sky's fill: terrain3d's
// makeSkyLight, read off the scene's lights each frame), with the haze mirrored at grazing angles (mirror:
// how much) and the sun's glint on the ripples. It takes the scene's fog, tone mapping and colour space like
// any material, and receives no shadows. Past the rasters' edge the edge's own sea runs on and deepens to
// open sea (20 m) within OPEN_SEA m, so the border never shows as a line. `map` is the ripple texture, shared
// by the sea and the ponds so main3d's scroll moves both; `lines` turns the rolling surf lines on (the sea)
// or off (the ponds, which only get the waterline band).
const OPEN_SEA = 400;
function waterMaterial({ depth, world, time, light, cols, foam, lines, mirror, map }) {
  const m = new THREE.MeshBasicMaterial({ color: '#ffffff', map });
  const lin = (hex) => new THREE.Color(hex);     // THREE.Color takes sRGB hex and holds it linear
  const u = {
    tSeaDepth: { value: depth }, uWorld: { value: new THREE.Vector2(world.w, world.h) }, uTime: time, uFoam: { value: foam }, uLines: { value: lines }, uMirror: { value: mirror },
    uShallow: { value: lin(cols.shallow) }, uMid: { value: lin(cols.mid) }, uDeep: { value: lin(cols.deep) },
    uSunDir: light.dir, uSunCol: light.sun, uSkyCol: light.sky, uReflect: light.haze,
  };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = 'varying vec3 vSeaP;\n' + sh.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\nvSeaP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = `uniform sampler2D tSeaDepth; uniform vec2 uWorld; uniform float uTime, uFoam, uLines, uMirror;
      uniform vec3 uShallow, uMid, uDeep, uSunDir, uSunCol, uSkyCol, uReflect; varying vec3 vSeaP;\n` + sh.fragmentShader.replace('#include <map_fragment>', `
      // metres of water under this point and how steeply the bed shelves; off the map, the edge's sea fading
      // into open sea with the distance off it
      vec2 suv = vSeaP.xz / uWorld, cuv = clamp(suv, 0.0, 1.0);
      vec2 bed = texture2D(tSeaDepth, cuv).rg;
      float dm = mix(bed.r * 20.0, 20.0, smoothstep(0.0, ${OPEN_SEA.toFixed(1)}, length((suv - cuv) * uWorld)));
      float shore = dm / max(bed.g * bed.g, 0.004);     // about how many metres out from the waterline
      vec3 sea = mix(uShallow, uMid, smoothstep(0.4, 4.5, dm));
      sea = mix(sea, uDeep, smoothstep(4.5, 15.0, dm));
      vec2 rip = vec2(texture2D(map, vMapUv).r, texture2D(map, vMapUv * 0.43 + vec2(0.31, 0.17)).r);
      sea *= 0.84 + rip.x * 0.42;
      // surf: a band along the waterline that breathes, and (on the sea) lines about 1 m wide rolling in toward
      // it every 16 m, at 3 m/s, where a beach shelves gently (within 28 m of the waterline and 1.3 m deep)
      float wob = sin(vSeaP.x * 0.045 + uTime * 0.3) * 0.5 + sin(vSeaP.z * 0.06 - uTime * 0.25) * 0.4;
      float band = 1.0 - smoothstep(0.5, 1.5 + 0.7 * sin(uTime * 1.3 + wob * 3.0), shore);
      float zone = smoothstep(3.0, 6.0, shore) * (1.0 - smoothstep(12.0, 28.0, shore)) * (1.0 - smoothstep(0.6, 1.3, dm));
      float lines = smoothstep(0.9, 0.985, sin(shore * 0.4 + uTime * 1.2 + wob * 2.0)) * zone * uLines;
      float foam = clamp(max(band, lines * 0.75), 0.0, 1.0) * uFoam;
      vec3 albedo = mix(sea, vec3(0.95, 0.97, 0.98), foam);
      // a level surface tipped a little by the ripples, lit by the sun and the sky, mirroring the sky low down
      vec3 N = normalize(vec3((rip.x - 0.5) * 0.16, 1.0, (rip.y - 0.5) * 0.16));
      vec3 V = normalize(cameraPosition - vSeaP);
      vec3 lit = albedo * (uSunCol * max(dot(N, uSunDir), 0.0) * RECIPROCAL_PI + uSkyCol);
      float fres = (0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0)) * (1.0 - foam);
      lit = mix(lit, uReflect, fres * uMirror);
      lit += uSunCol * pow(max(dot(N, normalize(uSunDir + V)), 0.0), 380.0) * 0.5 * (1.0 - foam);
      diffuseColor.rgb = lit;`);
  };
  m.customProgramCacheKey = () => 'kc-water';
  return m;
}

// The inland water: each body's shapes (circles, ellipses and lines with a width), grown by POND_REACH,
// as one mesh per body at its level. Its uv is in the sea plane's (x and -z over SEA_SIZE), so the ripple
// texture the two share repeats every 10 m on both.
function pondGeometry(body) {
  const parts = [];
  for (const s of body.shapes) {
    const pts = [];
    if (s.line) {
      const [[ax, az], [bx, bz]] = s.line, r = s.w / 2 + POND_REACH, a = Math.atan2(bz - az, bx - ax);
      for (let k = 0; k <= 12; k++) { const t = a + Math.PI / 2 + Math.PI * k / 12; pts.push([bx + Math.cos(t) * r, bz + Math.sin(t) * r]); }
      for (let k = 0; k <= 12; k++) { const t = a - Math.PI / 2 + Math.PI * k / 12; pts.push([ax + Math.cos(t) * r, az + Math.sin(t) * r]); }
    } else {
      const [cx, cz] = s.circle || s.ellipse, rx = (s.r ?? s.rx) + POND_REACH, rz = (s.r ?? s.rz) + POND_REACH;
      const n = Math.max(24, Math.ceil(Math.PI * 2 * Math.max(rx, rz) / 3));
      for (let k = 0; k < n; k++) { const t = Math.PI * 2 * k / n; pts.push([cx + Math.cos(t) * rx, cz + Math.sin(t) * rz]); }
    }
    // the shape in (x, -z), turned flat so its face points up
    const g = new THREE.ShapeGeometry(new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z))), 4);
    g.rotateX(-Math.PI / 2);
    parts.push(g);
  }
  const out = merge(parts), uv = out.attributes.uv.array;
  for (let i = 0; i < uv.length; i++) uv[i] /= SEA_SIZE;
  return out;
}
// plain geometries (position, normal, uv, index) into one
function merge(list) {
  let nv = 0, ni = 0;
  for (const g of list) { nv += g.attributes.position.count; ni += g.index ? g.index.count : g.attributes.position.count; }
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), idx = new Uint32Array(ni);
  let v = 0, k = 0;
  for (const g of list) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, v * 3); nrm.set(g.attributes.normal.array, v * 3); uv.set(g.attributes.uv.array, v * 2);
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[k++] = g.index.array[i] + v;
    else for (let i = 0; i < n; i++) idx[k++] = v + i;
    v += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

// ---------- seawalls ----------

const WALL_STEP = 2;            // m: the wall follows its shore in pieces at most this long
const WALL_FOOT = -3;           // m: the wall runs down to here, under the water line
const CAP_W = 2.4;              // m: the coping strip reaches this far inland of the shore, over the slope the 2 m grid makes
const CAP_UP = 0.06;            // m above the land the coping stands (0.1 m under it beside a promenade)
const WALL_OUT = 5.5;           // m: the face stands at the waterline, at most this far out from its shore line
const WALL_EVEN = 6;            // m: each stop takes the widest waterline offset within this far along its wall,
const WALL_SLANT = 0.25;        // m per m: and the face turns out from its shore line no more steeply than this

// A coast entry as a polygon, as terrain.js reads it: polygons as they are, rectangles, circles and ellipses
// with about 6 m edges.
function shapePoly(sh) {
  if (sh.poly) return sh.poly;
  if (sh.rect) { const [x0, z0, x1, z1] = sh.rect; return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]; }
  const [cx, cz] = sh.circle || sh.ellipse, rx = sh.r ?? sh.rx, rz = sh.r ?? sh.rz;
  const n = Math.max(24, Math.ceil(2 * Math.PI * Math.max(rx, rz) / 6));
  return Array.from({ length: n }, (_, i) => [cx + rx * Math.cos(2 * Math.PI * i / n), cz + rz * Math.sin(2 * Math.PI * i / n)]);
}
function insidePoly(pts, x, z) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c;
  }
  return c;
}
function segDist(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
  return Math.hypot(x - ax - dx * t, z - az - dz * t);
}

// The seawall stretches of shore: runs of consecutive shape edges that COAST_KINDS does not make a beach or a
// cliff and that are real shore (not inside another land shape), as { pts, closed, inward } (inward turns an
// edge's direction into its inland normal: (nx, nz) = (-tz, tx) * inward).
function seawallChains(coast) {
  const shapes = [];
  for (const [name, list] of Object.entries(coast.shapes || {})) for (const sh of list) {
    const pts = shapePoly(sh);
    shapes.push({ name, pts, kind: new Array(pts.length).fill('seawall') });
  }
  const at = (pts, [x, z]) => pts.findIndex(p => Math.abs(p[0] - x) < 0.01 && Math.abs(p[1] - z) < 0.01);
  for (const run of coast.kinds || []) for (const s of shapes) {
    if (s.name !== run.coast) continue;
    if (!run.from) { s.kind.fill(run.kind); continue; }
    const a = at(s.pts, run.from), b = at(s.pts, run.to);
    if (a < 0 || b < 0) continue;
    for (let i = a; i !== b; i = (i + 1) % s.pts.length) s.kind[i] = run.kind;
  }
  const out = [];
  for (const s of shapes) {
    const P = s.pts, n = P.length;
    let area = 0;
    for (let i = 0; i < n; i++) area += P[i][0] * P[(i + 1) % n][1] - P[(i + 1) % n][0] * P[i][1];
    const inward = area > 0 ? 1 : -1;
    const keep = P.map(([ax, az], i) => {
      const [bx, bz] = P[(i + 1) % n];
      return s.kind[i] === 'seawall' && Math.hypot(bx - ax, bz - az) > 1e-6 && !shapes.some(o => o !== s && insidePoly(o.pts, (ax + bx) / 2, (az + bz) / 2));
    });
    if (keep.every(Boolean)) { out.push({ pts: P.slice(), closed: true, inward }); continue; }
    // runs start just after an edge that is not wall, so going once round closes every one of them
    const start = keep.indexOf(false);
    let run = null;
    for (let q = 1; q <= n; q++) {
      const i = (start + q) % n;
      if (keep[i]) (run ||= [P[i]]).push(P[(i + 1) % n]);
      else if (run) { out.push({ pts: run, closed: false, inward }); run = null; }
    }
  }
  return out;
}

// Stops every WALL_STEP m or less along a chain, each { x, z, mx, mz, nx, nz, ex, ez, edge }: (mx, mz) is the
// direction its offset goes in (the inland normal, or at a corner the mitre, so a face o m out stands o m from
// both edges), (nx, nz) the same at unit length, (ex, ez) the inland normal of the edge that runs on from it,
// and edge that edge's number. Open chains run 0.8 m past their ends, into the beach or the land beside them.
function chainStops(c, id) {
  const P = c.pts, ne = c.closed ? P.length : P.length - 1, stops = [];
  const E = Array.from({ length: ne }, (_, k) => {
    const [ax, az] = P[k], [bx, bz] = P[(k + 1) % P.length], L = Math.hypot(bx - ax, bz - az), tx = (bx - ax) / L, tz = (bz - az) / L;
    return { ax, az, L, tx, tz, nx: -tz * c.inward, nz: tx * c.inward };
  });
  for (let k = 0; k < ne; k++) {
    const e = E[k], m = Math.max(1, Math.ceil(e.L / WALL_STEP)), prev = k > 0 || c.closed ? E[(k - 1 + ne) % ne] : null;
    for (let q = 0; q < m; q++) {
      let mx = e.nx, mz = e.nz;
      if (q === 0 && prev) {
        // the mitre: (n1 + n2) / (1 + n1·n2) lies 1 m from both edge lines (held to 2.5 m at a sharp corner)
        const d = Math.max(0.4, 1 + prev.nx * e.nx + prev.nz * e.nz);
        mx = (prev.nx + e.nx) / d; mz = (prev.nz + e.nz) / d;
      }
      const l = Math.hypot(mx, mz) || 1;
      stops.push({ x: e.ax + e.tx * e.L * q / m, z: e.az + e.tz * e.L * q / m, mx, mz, nx: mx / l, nz: mz / l, ex: e.nx, ez: e.nz, edge: `${id}.${k}` });
    }
  }
  if (!c.closed) {
    const a = E[0], b = E[ne - 1];
    stops[0].x -= a.tx * 0.8; stops[0].z -= a.tz * 0.8;
    stops.push({ x: b.ax + b.tx * (b.L + 0.8), z: b.az + b.tz * (b.L + 0.8), mx: b.nx, mz: b.nz, nx: b.nx, nz: b.nz, ex: b.nx, ez: b.nz, edge: `${id}.${ne - 1}` });
  }
  return stops;
}

// Each walled stop's offset o: the widest waterline offset within WALL_EVEN m along its wall (which takes out
// the stop-to-stop sawtooth of the 2 m raster), raised where a wider stretch is near so the face never turns
// out more steeply than WALL_SLANT, plus 0.3 m. No face stands nearer the shore than its own waterline, and
// along a straight shore the face runs straight, slanting out gently where the bank widens.
function evenOut(S, closed) {
  const n = S.length, dist = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);
  const widest = S.map((p, i) => {
    if (!p.wall) return 0;
    let m = p.out;
    for (const dir of [-1, 1]) {
      let d = 0, prev = i;
      for (let k = 1; k < n; k++) {
        let j = i + dir * k;
        if (closed) j = ((j % n) + n) % n; else if (j < 0 || j >= n) break;
        d += dist(S[prev], S[j]);
        prev = j;
        if (d > WALL_EVEN || !S[j].wall) break;
        m = Math.max(m, S[j].out);
      }
    }
    return m;
  });
  S.forEach((p, i) => { p.o = widest[i]; });
  // each stop at least its neighbour's offset less WALL_SLANT a metre, forward and back (twice round a ring)
  const raise = (i, j) => { if (S[i].wall && S[j].wall) S[j].o = Math.max(S[j].o, S[i].o - WALL_SLANT * dist(S[i], S[j])); };
  for (let r = 0; r < (closed ? 2 : 1); r++) {
    for (let i = 0; i + 1 < n + (closed ? 1 : 0); i++) raise(i, (i + 1) % n);
    for (let i = n - 1; i > (closed ? -1 : 0); i--) raise(i, (i - 1 + n) % n);
  }
  for (const p of S) if (p.wall) p.o = Math.min(p.o, p.room - 1) + 0.3;
}

// The walls, merged per 256 m tile: a face from the coping down under the water (stone above, darker and
// green where the tide wets it), the coping strip on top reaching inland over the slope, and an end piece
// where a wall stops. The face stands at the waterline: the ground's slope off the edge (the 2 m grid carries
// the land a few metres out) is all behind it. Where the ground runs on dry past WALL_OUT, or keeps its height
// or climbs (a bridge's fill, a neck), the shore runs into other land and has no wall; nor where a pier
// crosses (its own piles stand there). Under a road the coping stays below the road surface (TERRAIN is 0.2 m
// under it); where a promenade runs along the shore (its deck is flush with the land) it sits just under the land.
function buildSeawalls(world, chunks, group, mat) {
  const G = world.grids, [VW, VH] = G.dims.terrain, SEA = world.SEA_LEVEL;
  const tAt = (x, z) => {
    const fx = Math.min(Math.max(x / 2, 0), VW - 1.001), fz = Math.min(Math.max(z / 2, 0), VH - 1.001), i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, T = G.terrain;
    return (T[j * VW + i] * (1 - u) + T[j * VW + i + 1] * u) * (1 - v) + (T[(j + 1) * VW + i] * (1 - u) + T[(j + 1) * VW + i + 1] * u) * v;
  };
  const near = (kind, pad) => PATHS.filter(p => p.pts && p.kind === kind).map(p => ({ pts: p.pts, r: p.w / 2 + pad }));
  const piers = near('pier', 0.3), proms = near('promenade', 1.5);
  const onLine = (list, x, z) => list.some(p => { for (let i = 0; i + 1 < p.pts.length; i++) if (segDist(x, z, ...p.pts[i], ...p.pts[i + 1]) < p.r) return true; return false; });
  const stone = col('#d9caa9'), faceC = col('#c6b494'), wetC = col('#7d8a72');
  const byTile = new Map();
  const builder = (x, z) => {
    const key = `${Math.floor(x / TILE)},${Math.floor(z / TILE)}`;
    if (!byTile.has(key)) byTile.set(key, new Builder());
    return byTile.get(key);
  };
  // where a stop's face and the coping's inner edge stand, and how high the tide wets the face
  const face = (p) => [p.x - p.mx * p.o, p.z - p.mz * p.o], inner = (p) => [p.x + p.mx * CAP_W, p.z + p.mz * CAP_W];
  const wetTop = (p) => Math.min(SEA + 0.45, p.top - 0.05);
  // a piece of wall between stops a and b: corners counter-clockwise seen from the sea, so the face looks out
  const piece = (a, b) => {
    const fa = face(a), fb = face(b), ox = -a.ex, oz = -a.ez;
    const [p, q, fp, fq] = ((fb[0] - fa[0]) * oz - (fb[1] - fa[1]) * ox) > 0 ? [b, a, fb, fa] : [a, b, fa, fb];
    const ip = inner(p), iq = inner(q), wp = wetTop(p), wq = wetTop(q);
    const B = builder((fp[0] + fq[0]) / 2, (fp[1] + fq[1]) / 2);
    B.quad([fp[0], wp, fp[1]], [fp[0], p.top, fp[1]], [fq[0], q.top, fq[1]], [fq[0], wq, fq[1]], undefined, faceC);
    B.quad([fp[0], WALL_FOOT, fp[1]], [fp[0], wp, fp[1]], [fq[0], wq, fq[1]], [fq[0], WALL_FOOT, fq[1]], undefined, wetC);
    B.quad([fp[0], p.top, fp[1]], [ip[0], p.top, ip[1]], [iq[0], q.top, iq[1]], [fq[0], q.top, fq[1]], undefined, stone);
  };
  // the end of a wall: its cross-section from the face to the coping's inner edge (whose foot is buried 1.5 m
  // under the coping), seen from either side
  const endPiece = (p) => {
    const f = face(p), i = inner(p), w = wetTop(p), B = builder(f[0], f[1]), low = p.top - 1.5;
    for (const [a, b, ya, yb] of [[f, i, WALL_FOOT, low], [i, f, low, WALL_FOOT]]) {
      B.quad([a[0], ya, a[1]], [b[0], yb, b[1]], [b[0], Math.max(w, yb), b[1]], [a[0], Math.max(w, ya), a[1]], undefined, wetC);
      B.quad([a[0], Math.max(w, ya), a[1]], [b[0], Math.max(w, yb), b[1]], [b[0], p.top, b[1]], [a[0], p.top, a[1]], undefined, faceC);
    }
  };
  let pieces = 0, stops = 0, walled = 0;
  const runs = [];
  seawallChains(world.coast).forEach((c, id) => {
    const S = chainStops(c, id), n = S.length;
    for (const p of S) {
      const land = Math.max(tAt(p.x + p.nx * 0.5, p.z + p.nz * 0.5), tAt(p.x + p.nx * 1.5, p.z + p.nz * 1.5), tAt(p.x + p.nx * 2.5, p.z + p.nz * 2.5));
      p.top = land + (onLine(proms, p.x, p.z) ? -0.1 : CAP_UP);
      // out: the last dry ground before the water; room: where the ground comes up dry again past at least
      // 1 m of water (another shore, which no face may reach)
      let out = 0, wet = 0, high = -Infinity, room = Infinity;
      for (let o = 0.25; o <= 2 * WALL_OUT; o += 0.25) {
        const h = tAt(p.x - p.mx * o, p.z - p.mz * o);
        if (h <= SEA - 0.1) wet += 0.25;
        else if (wet >= 1) { room = o; break; }
        else if (o <= WALL_OUT + 0.25) { out = o; wet = 0; high = Math.max(high, h); }
        else break;
      }
      p.out = out;
      p.room = room;
      // a bank falls away from the shore: by half way out the ground is well on its way down to the water. Ground
      // that keeps the land's height, or climbs, is the flank of a fill or a neck of land, not a bank to wall.
      const half = tAt(p.x - p.mx * out / 2, p.z - p.mz * out / 2), falls = out < 1 || half < p.top - 0.25 * (p.top - SEA);
      p.wall = out <= WALL_OUT && falls && high <= p.top + 0.3 && p.top > SEA && !onLine(piers, p.x, p.z);
      stops++;
      if (p.wall) walled++;
    }
    evenOut(S, c.closed);
    const isWall = (i) => (c.closed || (i >= 0 && i < n)) && S[((i % n) + n) % n].wall;
    let line = null;
    for (let i = 0; i < n; i++) {
      if (!S[i].wall) { line = null; continue; }
      const prev = isWall(i - 1), next = isWall(i + 1);
      if (!prev && !next) continue;
      if (!prev || !next) endPiece(S[i]);
      if (!line || !prev) { line = []; runs.push(line); }
      const [fx, fz] = face(S[i]);
      line.push({ x: fx, z: fz, o: S[i].o, out: S[i].out, edge: S[i].edge });
      if (next) { piece(S[i], S[(i + 1) % n]); pieces++; }
    }
  });
  const meshes = [];
  for (const [key, B] of byTile) {
    const m = B.mesh(mat);
    m.name = `seawall ${key}`;
    meshes.push(m);
    if (chunks) chunks.add(m, { tile: key, layer: 'terrain' }); else group.add(m);
  }
  return { meshes, pieces, stops, walled, runs };
}

// ---------- beach props ----------

const TOWER = ['#f5a1b8', '#7fd6cf', '#f6d36b', '#a7c7f0', '#f6a26b'];
const UMBRELLA = ['#e5678a', '#2aa39d', '#f0a057', '#4f8fd8', '#f4d98a', '#ff5252'];
const BEACH_KINDS = new Set(['lifeguard', 'umbrella', 'towel']);
const SAND = 7, WATER = 6, SHALLOW = 9, KIND_MASK = 15, BLOCKS = 0x30;

// Where the props go, in metres: { kind, x, z, a (facing), color }.
function beachSpots(world) {
  const P = world.PX_PER_M, sand = (x, z) => kindAt(world.grids, x, z) === SAND;
  const given = world.deco.filter(d => BEACH_KINDS.has(d.kind) && sand(d.x / P, d.y / P));
  if (world.deco.some(d => d.kind === 'lifeguard')) return given.map(d => ({ kind: d.kind, x: d.x / P, z: d.y / P, a: d.a ?? 0, color: d.color }));
  return placeBeachProps(world);
}
function kindAt(G, x, z) {
  const i = Math.floor(x), j = Math.floor(z);
  if (i < 0 || j < 0 || i >= G.dims.surf[0] || j >= G.dims.surf[1]) return WATER;
  return G.surf[j * G.dims.surf[0] + i] & KIND_MASK;
}

// props.js's beaches(), for a world that does not pass its beach props on: round every coast polygon every
// 9 m, find the dry sand inland of the waterline (above the sea by 0.4 m), and put a lifeguard tower every
// 12th stop where the sand is wide, else now and then an umbrella with two towels. How busy a beach is
// follows its region's peds.
function placeBeachProps(world) {
  const G = world.grids, out = [], rnd = mulberry32(0x5eaf00d);
  const ground = (x, z) => world.groundY(x * world.PX_PER_M, z * world.PX_PER_M);
  const busyAt = (x, z) => { const r = world.regions.find(q => q.id === world.regionAt(x * world.PX_PER_M, z * world.PX_PER_M)); return r ? r.peds : 0.2; };
  for (const list of Object.values(world.coast.shapes || {})) for (const sh of list) {
    if (!sh.poly) continue;
    const poly = sh.poly.concat([sh.poly[0]]);
    let area = 0;
    for (let i = 0; i + 1 < poly.length; i++) area += poly[i][0] * poly[i + 1][1] - poly[i + 1][0] * poly[i][1];
    const inward = area > 0 ? 1 : -1;
    let stop = 0;
    alongLine(poly, 9, 4.5, (x, z, tx, tz) => {
      const nx = -tz * inward, nz = tx * inward;
      stop++;
      let o0 = -1, o1 = -1;
      for (let o = 1; o <= 45; o++) {
        const px = x + nx * o, pz = z + nz * o, k = kindAt(G, px, pz), b = G.surf[Math.floor(pz) * G.dims.surf[0] + Math.floor(px)] ?? 0;
        if (k === WATER || k === SHALLOW) { if (o0 < 0) continue; break; }
        if (k !== SAND || (b & BLOCKS)) break;
        if (o0 < 0) { if (ground(px, pz) < world.SEA_LEVEL + 0.4) continue; o0 = o; }
        o1 = o;
      }
      if (o0 < 0 || o1 - o0 < 3) return;
      const busy = busyAt(x + nx * o1, z + nz * o1), a = Math.atan2(-nz, -nx);
      const spot = (o) => ({ x: x + nx * o, z: z + nz * o });
      if (stop % 12 === 6 && o1 - o0 > 8) {
        out.push({ kind: 'lifeguard', ...spot((o0 + o1) / 2), a, color: TOWER[stop % TOWER.length] });
      } else if (o1 - o0 > 6 && rnd() < 0.15 + 0.5 * busy) {
        const q = spot(o0 + 2 + rnd() * (o1 - o0 - 4));
        out.push({ kind: 'umbrella', ...q, a: rnd() * Math.PI * 2, color: UMBRELLA[Math.floor(rnd() * UMBRELLA.length)] });
        for (const tw of [-1, 1]) {
          const ta = a + tw * 0.4;
          out.push({ kind: 'towel', x: q.x + Math.cos(ta) * 1.5, z: q.z + Math.sin(ta) * 1.5, a: ta + Math.PI / 2, color: UMBRELLA[Math.floor(rnd() * UMBRELLA.length)] });
        }
      }
    });
  }
  return out;
}
// call fn(x, z, tx, tz) every `step` m along a polyline, starting `first` m in
function alongLine(pts, step, first, fn) {
  let carry = first;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1], L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-6) continue;
    const tx = (bx - ax) / L, tz = (bz - az) / L;
    let s = carry;
    for (; s <= L; s += step) fn(ax + tx * s, az + tz * s, tx, tz);
    carry = s - L;
  }
}

// The umbrella canopy as two sets of alternate panels, so each set takes its own colour (white and the
// umbrella's) in one merged mesh.
function canopyParts() {
  const cone = new THREE.ConeGeometry(1.4, 0.55, 12, 1, true).toNonIndexed();
  const P = cone.attributes.position, N = cone.attributes.normal, parts = [[], []];
  for (let t = 0; t < P.count; t += 3) {
    let ax = 0, az = 0;
    for (let k = 0; k < 3; k++) { ax += P.getX(t + k); az += P.getZ(t + k); }
    const panel = Math.floor(((Math.atan2(az, ax) + Math.PI) / (Math.PI * 2)) * 12) % 2;
    for (let k = 0; k < 3; k++) parts[panel].push([P.getX(t + k), P.getY(t + k), P.getZ(t + k), N.getX(t + k), N.getY(t + k), N.getZ(t + k)]);
  }
  return parts.map((list) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(list.flatMap(v => v.slice(0, 3)), 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(list.flatMap(v => v.slice(3)), 3));
    return g;
  });
}

function buildBeachProps(world, group, chunks, mat) {
  const spots = beachSpots(world);
  const byTile = new Map();
  for (const s of spots) {
    const key = `${Math.floor(s.x / TILE)},${Math.floor(s.z / TILE)}`;
    if (!byTile.has(key)) byTile.set(key, []);
    byTile.get(key).push(s);
  }
  const ground = (x, z) => world.groundY(x * world.PX_PER_M, z * world.PX_PER_M);
  const white = col('#f6f4ee'), dark = col('#2d3033'), glass = col('#2a4a5c'), flag = col('#ff5252');
  const canopy = canopyParts(), towel = new THREE.BoxGeometry(0.8, 0.03, 1.8), pole = new THREE.CylinderGeometry(0.03, 0.03, 1.6, 6);
  const roof = new THREE.ConeGeometry(1.9, 0.9, 4), flagGeo = new THREE.BoxGeometry(0.02, 0.4, 0.6);
  const meshes = [];
  const M = new THREE.Matrix4();
  for (const [key, list] of byTile) {
    const B = new Builder();
    for (const s of list) {
      const y = ground(s.x, s.z), c = col(s.color || '#e5678a');
      if (s.kind === 'lifeguard') {
        // a tower on stilts with a ramp-side window band, facing the sea along a
        B.setMatrix(M.copy(mat4(s.x, y, s.z, 0, -s.a, 0)));
        for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) B.box(dx * 1.1 - 0.08, 0, dz * 1.1 - 0.08, dx * 1.1 + 0.08, 2.0, dz * 1.1 + 0.08, white);
        B.box(-1.6, 2.0, -1.6, 1.6, 2.15, 1.6, white);
        B.box(-1.2, 2.15, -1.2, 1.2, 3.9, 1.2, c);
        B.box(-1.25, 2.9, -1.0, 1.25, 3.6, 1.0, glass);
        B.geo(roof, mat4(0, 4.35, 0, 0, Math.PI / 4, 0), white);
        B.geo(pole, mat4(0, 5.5, 0), dark);
        B.geo(flagGeo, mat4(0, 6.1, 0.3), flag);
        B.setMatrix(null);
      } else if (s.kind === 'umbrella') {
        B.box(s.x - 0.03, y, s.z - 0.03, s.x + 0.03, y + 2.2, s.z + 0.03, white);
        const m = mat4(s.x, y + 2.35, s.z, 0, s.a, 0);
        B.geo(canopy[0], m, c);
        B.geo(canopy[1], m, white);
      } else if (s.kind === 'towel') {
        B.geo(towel, mat4(s.x, y + 0.02, s.z, 0, -s.a, 0), c);
      }
    }
    if (B.empty) continue;
    const mesh = B.mesh(mat, { cast: true });
    mesh.name = `beach ${key}`;
    meshes.push(mesh);
    if (chunks) chunks.add(mesh, { tile: key, layer: 'props' }); else group.add(mesh);
  }
  for (const g of [...canopy, towel, pole, roof, flagGeo]) g.dispose();
  return { meshes, count: spots.length };
}

// ---------- the marina ----------

// A motor yacht L m long, bow along +x: the hull and cabins in one mesh (white, a navy boot stripe, a teak
// swim platform), the tinted glass in another. Materials are shared by every yacht.
let yachtMats = null;
function makeYacht(L) {
  yachtMats ||= {
    body: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.28, metalness: 0.05 }),
    glass: new THREE.MeshStandardMaterial({ color: '#141b24', roughness: 0.1, metalness: 0.6 }),
  };
  const Bw = L * 0.24, hh = Math.max(1.6, L * 0.09);
  const sh = new THREE.Shape();
  sh.moveTo(-L / 2, -Bw / 2); sh.lineTo(L * 0.2, -Bw / 2); sh.quadraticCurveTo(L * 0.44, -Bw * 0.36, L / 2, 0);
  sh.quadraticCurveTo(L * 0.44, Bw * 0.36, L * 0.2, Bw / 2); sh.lineTo(-L / 2, Bw / 2); sh.lineTo(-L / 2, -Bw / 2);
  const hull = new THREE.ExtrudeGeometry(sh, { depth: hh, bevelEnabled: false, curveSegments: 8 });
  hull.rotateX(-Math.PI / 2);
  const body = new Builder(), glass = new Builder();
  const white = col('#f7f7f5'), navy = col('#1d2b4a'), teak = col('#a77b4f');
  const box = (B, cx, cy, cz, w, h, d, c) => B.box(cx - w / 2, cy - h / 2, cz - d / 2, cx + w / 2, cy + h / 2, cz + d / 2, c);
  body.geo(hull, new THREE.Matrix4(), white);
  body.geo(hull, mat4(0, 0.45, 0, 0, 0, 0, 1.006, 0.18, 1.02), navy);
  box(body, -L * 0.06, hh + 0.75, 0, L * 0.55, 1.5, Bw * 0.8, white);
  box(glass, -L * 0.04, hh + 0.85, 0, L * 0.5, 0.55, Bw * 0.82);
  box(body, -L * 0.12, hh + 2.1, 0, L * 0.32, 1.25, Bw * 0.64, white);
  box(glass, -L * 0.1, hh + 2.15, 0, L * 0.27, 0.45, Bw * 0.66);
  box(body, -L * 0.2, hh + 3.3, 0, 0.25, 1.4, Bw * 0.5, white);
  box(body, -L * 0.4, hh + 0.03, 0, L * 0.18, 0.06, Bw * 0.86, teak);
  hull.dispose();
  const g = new THREE.Group();
  for (const m of [body.mesh(yachtMats.body, { cast: true }), glass.mesh(yachtMats.glass, { cast: true })]) { m.matrixAutoUpdate = true; g.add(m); }
  g.name = 'yacht';
  return g;
}

// The pier: a plank deck at the walkable height (GROUND along the pier), piles down to the bed every 4 m,
// posts and a top rail on both sides, and cleats where the yachts tie up. Then the yachts, each where the
// water under its whole length is at least 1.1 m deep (they draw 0.75 m).
function buildMarina(world, group, mat) {
  const pier = world.places.marina?.pier, yachts = [];
  if (!pier) return { yachts, mesh: null };
  const P = world.PX_PER_M, x0 = pier.x / P, z0 = pier.y / P, len = pier.len / P, tx = Math.cos(pier.a), tz = Math.sin(pier.a);
  const nx = -tz, nz = tx, HW = 2.5;   // the right-hand normal, and the deck's half width (PATHS marina_pier, 5 m)
  const ground = (x, z) => world.groundY(x * P, z * P);
  const G = world.grids, [VW, VH] = G.dims.terrain;
  const bedAt = (x, z) => G.terrain[Math.min(VH - 1, Math.max(0, Math.round(z / 2))) * VW + Math.min(VW - 1, Math.max(0, Math.round(x / 2)))];
  const B = new Builder(), wood = col('#9b7653'), wood2 = col('#86643f'), post = col('#5a4632'), rail = col('#f4f1ea'), cleat = col('#2d3033');
  const at = (s, o) => [x0 + tx * s + nx * o, z0 + tz * s + nz * o];
  B.setMatrix(new THREE.Matrix4().compose(new THREE.Vector3(x0, 0, z0), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -pier.a), new THREE.Vector3(1, 1, 1)));
  // in the pier's own frame: x along it from the root, z across (+z on its right)
  for (let s = 0, k = 0; s < len; s += 0.6, k++) {
    const [px, pz] = at(s + 0.3, 0), y = ground(px, pz);
    B.box(s + 0.03, y - 0.2, -HW, s + 0.57, y, HW, k % 3 ? wood : wood2);
  }
  for (let s = 2; s < len; s += 4) for (const side of [-1, 1]) {
    const [px, pz] = at(s, side * (HW - 0.15)), y = ground(px, pz), bed = Math.min(world.SEA_LEVEL - 1, bedAt(px, pz));
    B.box(s - 0.14, bed, side * (HW - 0.15) - 0.14, s + 0.14, y - 0.2, side * (HW - 0.15) + 0.14, post);
    B.box(s - 0.07, y, side * (HW - 0.12) - 0.07, s + 0.07, y + 1.0, side * (HW - 0.12) + 0.07, post);
  }
  for (const side of [-1, 1]) {
    const [ax, az] = at(0.5, 0), y = ground(ax, az);
    B.box(0.5, y + 0.95, side * (HW - 0.12) - 0.06, len - 0.4, y + 1.07, side * (HW - 0.12) + 0.06, rail);
  }
  B.setMatrix(null);
  const mesh = B.mesh(mat, { cast: true });
  mesh.name = 'marina pier';
  group.add(mesh);

  const depthAt = (x, z) => {
    const [w, h] = G.dims.seaDepth, i = Math.floor(x / 2), j = Math.floor(z / 2);
    return i < 0 || j < 0 || i >= w || j >= h ? 20 : G.seaDepth[j * w + i] / 255 * 20;
  };
  const C = new Builder();
  // Berths along each side, root to tip: each yacht takes the first spot from its berth outward (3 m at a time)
  // where the water is deep enough under it, it stays YACHT_GAP clear of the yachts already on that side (they
  // all lie the same 1.4 m off the deck edge), and both its cleats are on the pier.
  const deepUnder = (cx, cz, L) => {
    for (let q = -0.5; q <= 0.5; q += 0.25) for (const w of [-1, 1]) {
      if (depthAt(cx + tx * q * L + nx * w * L * 0.12, cz + tz * q * L + nz * w * L * 0.12) < 1.1) return false;
    }
    return true;
  };
  for (const [s0, side, L] of YACHT_BERTHS) {
    const off = HW + L * 0.12 + 1.4;
    let s = null;
    for (let t = s0; t + 0.3 * L <= len - 0.5 && s == null; t += 3) {
      const clear = yachts.every(o => o.side !== side || Math.abs(t - o.s) >= (L + o.L) / 2 + YACHT_GAP);
      if (clear && deepUnder(...at(t, side * off), L)) s = t;
    }
    if (s == null) continue;
    const [cx, cz] = at(s, side * off);
    const y = makeYacht(L), base = world.SEA_LEVEL - YACHT_DRAFT;
    y.position.set(cx, base, cz);
    y.rotation.y = -pier.a;
    group.add(y);
    yachts.push({ g: y, base, ph: cx * 0.37 + cz * 0.11, s, side, L });
    // a cleat on the pier edge at each end of the yacht
    for (const q of [-0.3, 0.3]) {
      const [kx, kz] = at(s + q * L, side * (HW - 0.3)), ky = ground(kx, kz);
      C.box(kx - 0.15, ky, kz - 0.15, kx + 0.15, ky + 0.2, kz + 0.15, cleat);
    }
  }
  if (!C.empty) { const m = C.mesh(mat); m.name = 'marina cleats'; group.add(m); }
  return { yachts, mesh };
}

// ---------- all of it ----------

export function buildCoast3D(world, group, { chunks = null, light = null } = {}) {
  const G = world.grids, time = { value: 0 }, sky = light || makeSkyLight();
  const depth = depthTexture(G);
  const area = { w: G.w, h: G.h };
  const ripples = TX.water();          // the sea plane's uv runs 0-1 over SEA_SIZE: a ripple every 10 m
  ripples.repeat.set(SEA_SIZE / 10, SEA_SIZE / 10);
  const seaMat = waterMaterial({ depth, world: area, time, light: sky, cols: SEA_COLS, foam: 1, lines: 1, mirror: 0.7, map: ripples });
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(SEA_SIZE, SEA_SIZE), seaMat);
  sea.rotation.x = -Math.PI / 2;
  sea.position.set(G.w / 2, world.SEA_LEVEL, G.h / 2);
  sea.renderOrder = 2;          // after the land, so the land's depth already hides most of it
  sea.name = 'sea';
  group.add(sea);

  // inland water: one mesh per body, with the sea's ripples (marsh water, sheltered and dark: a fainter
  // waterline band, no rolling lines, and less of the sky in it)
  const pondMat = waterMaterial({ depth, world: area, time, light: sky, cols: POND_COLS, foam: 0.35, lines: 0, mirror: 0.4, map: ripples });
  const ponds = [];
  for (const body of world.water.bodies || []) {
    const m = new THREE.Mesh(pondGeometry(body), pondMat);
    m.position.y = body.level;
    m.renderOrder = 2;
    m.name = `water ${body.id}`;
    group.add(m);
    ponds.push(m);
  }

  // the walls, beach props, pier and cleats share one vertex-coloured material
  const painted = matte({ vertexColors: true });
  const walls = buildSeawalls(world, chunks, group, painted);
  const beach = buildBeachProps(world, group, chunks, painted);
  const marina = buildMarina(world, group, painted);

  return {
    sea, ponds, yachts: marina.yachts, pier: marina.mesh, beach: beach.meshes, walls: walls.meshes, wallRuns: walls.runs,
    // the surf rolls in on the game clock; the water takes this frame's sun and sky (sky.update ran first)
    update(t) { time.value = t; if (!light) sky.update(group); },
    stats() {
      return { beachProps: beach.count, beachMeshes: beach.meshes.length, wallPieces: walls.pieces, wallStops: walls.stops, wallStopsWalled: walls.walled, ponds: ponds.length, yachts: marina.yachts.length };
    },
  };
}
