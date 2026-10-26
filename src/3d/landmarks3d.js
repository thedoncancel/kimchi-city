// The Kimchi Key v2 landmarks in 3D (docs/map-v2-spec.md §5.7 and §11.1): the silhouettes you steer by. The
// Kimchi Tower's colour-cycling LED crown (its shell is a building, S5a), the KIMCHI letters on the Lookout
// Knoll, the North Causeway's A-frame pylon and its stays, the lighthouse and its turning beam, Kimchi Fest's
// arch, stage and turning Ferris wheel, the three pink Port cranes, Kimchi Air's control tower, the K-Town
// gate over Seoul Ave, the Bayfront and Fountain Park fountains, the Glades lookout tower, the Rickenbacker's
// white arch, the Venetian bascule houses, the curved Collins resort and the Kimchi One jet (merged into 4
// meshes). Beacon materials (the crown, the letters, the pylon and tower lights, the lighthouse) use
// fog: false, so they read across the county by day and glow at night.
//
// The pylon and its stays, the Rickenbacker's arch and the Venetian bascule houses are bridge structure: when
// roads3d has built the bridges (they are on the chunk manager's 'bridges' layer, and cityV2 builds the roads
// first) it built them with their decks, and here the pylon only gets its lights (the aircraft light on its head
// and the night strips up its legs); without roads3d's bridges they are all built here. Every box here has its
// underside (slab): decks, beams and roofs are seen from below.
//
// buildLandmarks(world, group, chunks) -> { update(t, night), stats }: world is the world facade's namespace
// (landmarks, places, roads, groundY), group the city's group, chunks the city's chunk manager. Each landmark
// is one or two merged meshes in world coordinates (a Builder per material), handed to the chunk manager with
// its footprint, so it casts shadows only near the player; the big ones are drawn at any distance, the small
// ones out to SMALL_FAR. cityV2 calls update once a frame with the game clock and the night level (0 day to 1
// night): the wheel and the beam turn, the crown cycles, the beacons blink, the fountains play.
//
// Landmarks are in metres (x east, z south) with base = the ground height there; a landmark's local frame has
// +x along its heading a, +z to the right of it, y up (the same frame as props3d). Nothing floats: where the
// ground slopes under a landmark its footing runs down past the lowest ground (the lighthouse's stone base and
// its cottage's footing, the gate's and the arch's columns).
//
// landmarkFootprints(world) -> [{ id, inside(x, z, pad), out(x, z, pad) }]: the ground each landmark stands on,
// in m, so props3d keeps its street lamps and furniture off it.
//
// What of a landmark is solid (its footings, legs, plinths and walls) is world data: prefabs.js landmarkSolids,
// from the same numbers (LH_BASE, COTTAGE, RESORT, letterSpans, cottageSpot, clearSpot, spanFrame), stamped into
// the world's SURF and OCC by applyLandmarkSolids. buildLandmarks runs it (once; the world generator may already
// have), so Kimchi, the cars, the camera and bullets stop at what they see.
import * as THREE from 'three';
import { Builder, mat4, col } from './geo.js';
import { HIGH, matte } from './quality.js';
import * as TX from './textures.js';
import { LH_BASE, COTTAGE, RESORT, letterSpans, edgeAt, roadAt, spanFrame, cottageSpot, clearSpot, applyLandmarkSolids } from '../map/prefabs.js';

const PX = 16;
const SMALL_FAR = 900;      // m: the small landmarks (houses, gates, fountains) are not drawn further out
const SEA = -1;             // SEA_LEVEL (m), for piers and piles that stand in the water
const WHITE = '#f4f2ec', CONCRETE = '#d9d4ca', STEEL = '#9aa1a8', DARK = '#2a2d31', STONE = '#cfc7b8';

// ---------- small geometry helpers (local frame of the Builder's matrix) ----------

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL = {};
const cylGeo = (seg) => (CYL[seg] ||= new THREE.CylinderGeometry(1, 1, 1, seg, 1));
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3(), _x = new THREE.Vector3(), _z = new THREE.Vector3();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _UP = new THREE.Vector3(0, 1, 0);

// The lighthouse beam's look, on a cone with its apex at the lamp (uv.y 1 there, 0 at the open end): a shaft of
// light is as bright as the depth of it the eye looks through, so it fades toward its silhouette (the square of
// how squarely the eye meets its skin) instead of showing a solid cone's hard edge; it starts at under half its
// glow at the lamp, is brightest 12 m out and dies away along its length; and it fades out within 40 m of the
// eye, so a sweep over the camera does not wash the screen.
const BEAM_GLOW = 0.24;
function softBeam(m) {
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = 'varying vec3 vBeamN;\nvarying vec3 vBeamV;\nvarying float vBeamT;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      vBeamN = normalize(normalMatrix * normal);
      vBeamV = -mvPosition.xyz;
      vBeamT = 1.0 - uv.y;`);
    sh.fragmentShader = 'varying vec3 vBeamN;\nvarying vec3 vBeamV;\nvarying float vBeamT;\n' + sh.fragmentShader.replace('#include <opaque_fragment>', `#include <opaque_fragment>
      float beamEdge = abs(dot(normalize(vBeamN), normalize(vBeamV)));
      float beamLeft = clamp(1.0 - vBeamT, 0.0, 1.0);
      float beamAlong = (0.4 + 0.6 * smoothstep(0.0, 0.08, vBeamT)) * beamLeft * beamLeft;
      gl_FragColor.a *= beamEdge * beamEdge * beamAlong * smoothstep(6.0, 40.0, length(vBeamV));`);
  };
  m.customProgramCacheKey = () => 'kc-beam';
  return m;
}

// a round rod from p0 to p1 ([x, y, z]), radius r
function rod(B, p0, p1, r, color, seg = 6) {
  _a.fromArray(p0); _b.fromArray(p1); _d.subVectors(_b, _a);
  const len = _d.length();
  if (len < 1e-6) return;
  _q.setFromUnitVectors(_UP, _d.divideScalar(len));
  _m.compose(_a.add(_b).multiplyScalar(0.5), _q, _s.set(r, len, r));
  B.geo(cylGeo(seg), _m, col(color));
}
// a square beam from p0 to p1, w wide (level, across it) and d deep
function bar(B, p0, p1, w, d, color) {
  _a.fromArray(p0); _b.fromArray(p1); _d.subVectors(_b, _a);
  const len = _d.length();
  if (len < 1e-6) return;
  _d.divideScalar(len);
  _x.crossVectors(_d, _UP);
  if (_x.lengthSq() < 1e-6) _x.set(1, 0, 0); else _x.normalize();
  _z.crossVectors(_x, _d).normalize();
  _m.makeBasis(_x.multiplyScalar(w), _d.clone().multiplyScalar(len), _z.multiplyScalar(d)).setPosition(_a.add(_b).multiplyScalar(0.5));
  B.geo(UNIT_BOX, _m, col(color));
}
// a box centred at (x, y, z), sizes sx, sy, sz, turned ry about y
function cube(B, x, y, z, sx, sy, sz, color, ry = 0) {
  B.geo(UNIT_BOX, mat4(x, y, z, 0, ry, 0, sx, sy, sz), col(color));
}
// Builder.box with its underside: the builder leaves the bottom face out (a building's never shows), but a
// landmark's decks, beams, roofs and slats are seen from below, where a box without one is see-through.
function slab(B, x0, y0, z0, x1, y1, z1, color, o = {}) {
  B.box(x0, y0, z0, x1, y1, z1, color, { bottom: true, ...o });
}
// a copy of a geometry turned inside out (normals in, triangles the other way round): a basin's inner wall
const inward = (g) => {
  const h = g.clone(), n = h.attributes.normal, I = h.index;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  for (let i = 0; i + 2 < I.count; i += 3) { const b = I.getX(i + 1); I.setX(i + 1, I.getX(i + 2)); I.setX(i + 2, b); }
  return h;
};
// a quad turned so its face points upward (roof slopes), whatever order its corners come in
function upQuad(B, a, b, c, d, color) {
  const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
  if (ny >= 0) B.quad(a, b, c, d, undefined, color); else B.quad(b, a, d, c, undefined, color);
}
// an upright (tapered) cylinder standing on (x, y0, z)
function post(B, x, y0, z, r0, r1, h, color, seg = 8) {
  B.geo(new THREE.CylinderGeometry(r1, r0, h, seg), mat4(x, y0 + h / 2, z), col(color));
}

// The local frame of a landmark: origin at (x, y, z), local +x along heading a (0 east, π/2 south).
function frame(x, y, z, a = 0) {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(_UP, -a), new THREE.Vector3(1, 1, 1));
}
// a local point of a frame in world coordinates
function toWorld(F, x, y, z) { return new THREE.Vector3(x, y, z).applyMatrix4(F); }

// ---------- road helpers (the RoadNet in px; answers in m): edgeAt, roadAt and spanFrame are prefabs.js's ----------

// The terrain at (x, z) m, the sea bed under a bridge (groundY there is the deck): the nearest TERRAIN sample (2 m apart).
function bedAt(world, x, z) {
  const H = world.grids?.terrain, D = world.grids?.dims?.terrain;
  if (!H || !D) return SEA - 6;
  const i = Math.max(0, Math.min(D[0] - 1, Math.round(x / (D[2] || 2)))), j = Math.max(0, Math.min(D[1] - 1, Math.round(z / (D[2] || 2))));
  return H[j * D[0] + i];
}

// ---------- the ground the landmarks stand on ----------

// The lighthouse's base, the keeper's cottage and where it stands (LH_BASE, COTTAGE, cottageSpot) are prefabs.js's.

// A landmark's footprint as a box in its own frame (centre (x, z) m, heading a; local x0..x1 along it, z0..z1
// across). along: it spans a road, so a point is moved out of it along the road (the sidewalk runs on through).
function footBox(id, x, z, a, x0, z0, x1, z1, along = false) {
  const c = Math.cos(a), s = Math.sin(a);
  const local = (px, pz) => [(px - x) * c + (pz - z) * s, (pz - z) * c - (px - x) * s];
  const out = (u, v) => [x + u * c - v * s, z + u * s + v * c];
  return {
    id,
    inside(px, pz, pad = 0) { const [u, v] = local(px, pz); return u > x0 - pad && u < x1 + pad && v > z0 - pad && v < z1 + pad; },
    // the nearest point pad m clear of it: along the road through it, or else out of its nearest side
    out(px, pz, pad = 0.8) {
      const [u, v] = local(px, pz);
      const du = u - x0 < x1 - u ? x0 - pad - u : x1 + pad - u, dv = v - z0 < z1 - v ? z0 - pad - v : z1 + pad - v;
      return along || Math.abs(du) <= Math.abs(dv) ? out(u + du, v) : out(u, v + dv);
    },
  };
}
// The resort's curved slab: a ring sector round (cx, cz) from r0 to r1 m, ±span rad from due west of it.
function footSector(id, cx, cz, r0, r1, span) {
  const polar = (px, pz) => [Math.hypot(px - cx, pz - cz), Math.atan2(pz - cz, cx - px)];
  return {
    id,
    inside(px, pz, pad = 0) { const [r, t] = polar(px, pz); return r > r0 - pad && r < r1 + pad && Math.abs(t) < span + pad / Math.max(r, 1); },
    out(px, pz, pad = 0.8) { const [r, t] = polar(px, pz), nr = r - r0 < r1 - r ? r0 - pad : r1 + pad; return [cx - Math.cos(t) * nr, cz + Math.sin(t) * nr]; },
  };
}

// The ground every landmark stands on, where no street prop may stand (props3d moves its lamps out and leaves
// the furniture off): [{ id, inside(x, z, pad), out(x, z, pad) }] in m, the same frames and sizes the
// builders below use. The tower is a building and the bridge structure stands on the decks, so neither is here.
export function landmarkFootprints(world) {
  const out = [], net = world.roads, byId = Object.fromEntries((world.landmarks || []).map(L => [L.id, L]));
  const T = (id) => byId[id];
  const box = (...a) => out.push(footBox(...a));
  let t;
  if ((t = T('ktown_gate'))) { const f = spanFrame(net, t), half = (t.span || 18) / 2; box(t.id, t.x, t.z, f.a, -4.1, -half - 4, 4.1, half + 4, true); }
  if ((t = T('fest_arch'))) { const f = spanFrame(net, t), half = (t.span || 22) / 2; box(t.id, t.x, t.z, f.a, -1.3, -half - 1.4, 1.3, half + 1.4, true); }
  if ((t = T('ferris_wheel'))) box(t.id, t.x, t.z, t.a, -6.2, -16.2, 6.2, 16.2);
  if ((t = T('fest_stage'))) box(t.id, t.x, t.z, t.a, -7.8, -13.9, 5.8, 13.9);
  if ((t = T('control_tower'))) box(t.id, t.x, t.z, t.a, -7.5, -5.5, 7.5, 5.5);
  if ((t = T('glades_tower'))) box(t.id, t.x, t.z, t.a, -3.2, -3.2, 3.2, 4.5);
  if ((t = T('lighthouse'))) {
    const r = LH_BASE.r + 0.4, c = cottageSpot(world, t);
    box(t.id, t.x, t.z, 0, -r, -r, r, r);
    if (c) box(t.id, c.x, c.z, c.a, -COTTAGE.w / 2 - 0.6, -COTTAGE.d / 2 - 0.6, COTTAGE.w / 2 + 0.6, COTTAGE.d / 2 + 2.2);
  }
  if ((t = T('kimchi_letters'))) { const half = (t.w || 86) / 2 + 1; box(t.id, t.x, t.z, t.a, -6.6, -half, 4.9, half); }
  if ((t = T('bayfront_fountain'))) { const p = clearSpot(world, t.x, t.z, 9); box(t.id, p.x, p.z, 0, -8.6, -8.6, 8.6, 8.6); }
  if ((t = T('deco_resort'))) { const R = RESORT; out.push(footSector(t.id, t.x + R.Rc - R.west, t.z, R.Rc - R.depth - R.podium - R.canopy - 0.5, R.Rc + 0.5, R.span + 0.01)); }
  if ((t = T('kimchi_one'))) { const pl = world.places?.[t.place || 'jet']?.plane; if (pl) box(t.id, pl.x / PX, pl.y / PX, pl.a, -13.5, -11, 9, 10); }
  for (const c of (world.landmarks || []).filter(q => q.kind === 'crane')) box(c.id, c.x, c.z, c.a, -12.9, -8.4, 6.9, 8.4);
  for (const d of world.deco || []) if (d.kind === 'fountain') box('fountain', d.x / PX, d.y / PX, 0, -4.6, -4.6, 4.6, 4.6);
  return out;
}

// ---------- materials ----------

// Light that ignores the sun: a colour scaled by the day or night level (HDR above 1 blooms on High).
function glow(color, day, night, { fog = false, ...o } = {}) {
  const m = new THREE.MeshBasicMaterial({ color, fog, ...o });
  m.userData.base = new THREE.Color(color);
  m.userData.k = [day, night];
  return m;
}
const setGlow = (m, n, extra = 1) => m.color.copy(m.userData.base).multiplyScalar((m.userData.k[0] + (m.userData.k[1] - m.userData.k[0]) * n) * extra);

// The LED crown: each face's colour runs round the hue wheel in time, a band of light chasing up the crown.
// The vertex colour's red is the face's phase, its green the brightness; fog: false so it reads by day too.
function ledMaterial(time) {
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
  m.userData.glow = { value: 1 };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = time;
    sh.uniforms.uGlow = m.userData.glow;
    sh.vertexShader = 'varying float vLedY;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvLedY = (modelMatrix * vec4(transformed, 1.0)).y;');
    sh.fragmentShader = 'uniform float uTime;\nuniform float uGlow;\nvarying float vLedY;\n' + sh.fragmentShader
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `
        float hh = fract(vColor.r + uTime * 0.045 - vLedY * 0.011);
        vec3 led = clamp(abs(mod(hh * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
        float chase = 0.72 + 0.28 * sin(vLedY * 0.55 - uTime * 2.4);
        vec4 diffuseColor = vec4(mix(vec3(1.0), led, 0.94) * uGlow * vColor.g * chase, opacity);`)
      .replace('#include <color_fragment>', '');
  };
  m.customProgramCacheKey = () => 'kc-led';
  return m;
}

// ---------- the landmarks ----------

export function buildLandmarks(world, group, chunks) {
  if (!world?.landmarks?.length || !group) return undefined;
  applyLandmarkSolids(world);
  const net = world.roads, gy = (x, z) => world.groundY(x * PX, z * PX);
  const byId = Object.fromEntries(world.landmarks.map(L => [L.id, L]));
  const time = { value: 0 };
  const M = {
    paint: matte({ vertexColors: true }, 0.78),
    gloss: HIGH ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.28, metalness: 0.12 }) : matte({ vertexColors: true }),
    metal: HIGH ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.34, metalness: 0.85 }) : matte({ vertexColors: true }),
    glass: HIGH ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0.3, emissive: new THREE.Color('#ffd9a0'), emissiveIntensity: 0 })
      : matte({ vertexColors: true, emissive: new THREE.Color('#ffd9a0'), emissiveIntensity: 0 }),
    led: ledMaterial(time),
    beacon: glow('#ff2a1e', 1.6, 3.2),
    lamp: glow('#ffe2a8', 0.35, 2.4, { fog: true }),        // bulbs and lanterns: dim by day, glowing at night
  };
  const letterMat = HIGH ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0, fog: false, emissive: new THREE.Color('#fff6e6'), emissiveIntensity: 0 })
    : new THREE.MeshLambertMaterial({ vertexColors: true, fog: false, emissive: new THREE.Color('#fff6e6'), emissiveIntensity: 0 });
  for (const [k, m] of Object.entries(M)) m.name = k;
  letterMat.name = 'letters';
  const glows = [M.beacon, M.lamp];
  const nightSet = [];           // [material, prop, day, night]
  nightSet.push([M.glass, 'emissiveIntensity', 0, 0.9], [letterMat, 'emissiveIntensity', 0, 0.5]);

  const built = [];              // { id, meshes } for stats and the tests
  const anim = [];               // update(t, night) of the moving parts
  const nightOnly = [];          // meshes shown only after dark
  const jets = [];               // fountain jets: { m (mesh), ph }
  // one landmark's merged builders -> meshes in the chunk manager (footprint box; small ones only out to SMALL_FAR)
  function finish(id, parts, box, { far, cast = true } = {}) {
    const meshes = [];
    for (const [B, mat, o = {}] of parts) {
      if (!B || B.empty) continue;
      const m = B.mesh(mat, { cast: o.cast ?? cast, receive: true, indexed: true });
      m.name = 'landmark ' + id;
      meshes.push(m);
    }
    for (const m of meshes) addObj(m, box, far);
    built.push({ id, meshes });
    return meshes;
  }
  function addObj(obj, box, far) {
    if (chunks?.add) chunks.add(obj, { box, layer: 'shells', ...(far ? { far } : {}) });
    else group.add(obj);
  }
  const around = (x, z, r) => [x - r, z - r, x + r, z + r];

  // The North Causeway's pylon and stays, the Rickenbacker's arch and the Venetian bascule houses are bridge
  // structure: once roads3d has built the bridges (they sit on the chunk manager's 'bridges' layer) it has built
  // them with their decks, so here they only get their lights; without its bridges they are built here.
  const bridgesBuilt = !!chunks?.layers?.bridges;
  const L = (id) => byId[id];
  const steps = [
    ['kimchi_tower', towerCrown], ['kimchi_letters', letters], ['causeway_pylon', pylon], ['lighthouse', lighthouse],
    ['fest_arch', festArch], ['ferris_wheel', ferrisWheel], ['fest_stage', festStage], ['control_tower', controlTower],
    ['ktown_gate', ktownGate], ['bayfront_fountain', bayfrontFountain], ['glades_tower', gladesTower], ['deco_resort', resort],
    ['rickenbacker_arch', rickenbackerArch], ['venetian_bascules', basculeHouses], ['kimchi_one', jet],
  ];
  for (const [id, fn] of steps) {
    if (!L(id)) continue;
    try { fn(L(id)); } catch (e) { console.warn(`landmark ${id} not built`, e); }
  }
  try { cranes(world.landmarks.filter(q => q.kind === 'crane')); } catch (e) { console.warn('port cranes not built', e); }
  try { parkFountains(); } catch (e) { console.warn('park fountains not built', e); }

  // ---------- Kimchi Tower: the LED crown on the 140 m shell ----------
  function towerCrown(T) {
    const top = T.base + T.h, F = frame(T.x, top, T.z, T.a);
    const S = new Builder().setMatrix(F), Led = new Builder().setMatrix(F), Bc = new Builder().setMatrix(F);
    // four setback tiers, each an LED box behind white Deco fins, with a white cap slab
    const tiers = [[29, 8], [22, 8], [15, 8], [9, 7]];
    let y = 0;
    tiers.forEach(([w, th], k) => {
      const h = w / 2;
      slab(Led, -h, y, -h, h, y + th, h, new THREE.Color(k * 0.13, 1, 0), { top: false });
      slab(S, -h - 0.35, y + th, -h - 0.35, h + 0.35, y + th + 0.6, h + 0.35, col(WHITE));
      const n = Math.max(2, Math.round(w / 3.6));
      for (let i = 0; i <= n; i++) {
        const u = -h + (w * i) / n, fw = 0.55, fd = 0.75;
        for (const [fx, fz, sx, sz] of [[u, -h - fd / 2, fw, fd], [u, h + fd / 2, fw, fd], [-h - fd / 2, u, fd, fw], [h + fd / 2, u, fd, fw]])
          slab(S, fx - sx / 2, y, fz - sz / 2, fx + sx / 2, y + th, fz + sz / 2, col('#eef1f4'));
      }
      y += th + 0.6;
    });
    // the spire and its aircraft light
    S.geo(new THREE.CylinderGeometry(0.18, 1.5, 24, 8), mat4(0, y + 12, 0), col('#dfe5ea'));
    Bc.geo(new THREE.SphereGeometry(0.75, 10, 8), mat4(0, y + 24.4, 0));
    const r = 16;
    finish('kimchi_tower', [[S, M.paint], [Led, M.led, { cast: false }], [Bc, M.beacon, { cast: false }]], around(T.x, T.z, r));
  }

  // ---------- the KIMCHI letters on the knoll ----------
  function letters(T) {
    const F = frame(T.x, T.base, T.z, T.a);
    const B = new Builder(), P = B;           // the letters and their posts share a mesh
    const total = T.w || 86, H = T.h || 18, k = H / 18;
    // each letter w wide from local z0 toward −z (prefabs.js letterSpans, which its solid parts follow too)
    for (const { c, w, z0 } of letterSpans(T)) {
      const mid = z0 - w / 2;          // local z of the letter's middle
      // the letter stands on the lowest ground under its foot (its full width, front and back), leaning back 7°
      let low = Infinity;
      for (const u of [-0.5, -0.25, 0, 0.25, 0.5]) for (const lx of [0, 0.9]) { const p = toWorld(F, lx, 0, mid + u * w); low = Math.min(low, gy(p.x, p.z)); }
      const y0 = low - T.base - 0.4;
      const geo = new THREE.ExtrudeGeometry(letterShape(c, k), { depth: 0.8, bevelEnabled: false, curveSegments: 6 });
      // shape x -> local −z (to the viewer's right), shape y -> up, extrusion -> local +x (toward the viewer)
      const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0));
      const lean = new THREE.Matrix4().makeRotationZ(0.12);
      const place = new THREE.Matrix4().makeTranslation(0, y0, z0).multiply(lean).multiply(basis);
      B.setMatrix(new THREE.Matrix4().multiplyMatrices(F, place));
      B.geo(geo, new THREE.Matrix4(), col('#f8f7f2'));
      // two posts and braces behind each letter
      P.setMatrix(F);
      for (const u of [0.25, 0.75]) {
        const z = z0 - u * w, p = toWorld(F, -1.4, 0, z), g = gy(p.x, p.z) - T.base;
        // the letter leans back 0.12 rad, so its back face is 0.12 m further back for every metre up
        bar(P, [-0.6 - 0.12 * Math.max(0, g - y0), g - 0.3, z], [-0.6 - 0.12 * H * 0.8, y0 + H * 0.8, z], 0.35, 0.35, STEEL);
        const pb = toWorld(F, -6, 0, z), gb = gy(pb.x, pb.z) - T.base;
        bar(P, [-6, gb - 0.3, z], [-0.7 - 0.12 * H * 0.55, y0 + H * 0.55, z], 0.25, 0.25, STEEL);
      }
    }
    B.setMatrix(null);
    // floodlights along their foot, lit at night, set into the slope (the lowest corner a little under)
    const lamps = new Builder().setMatrix(F);
    for (let i = 0; i < 8; i++) {
      const z = total / 2 - (i + 0.5) * total / 8;
      let g = Infinity;
      for (const [u, v] of [[3.6, -0.4], [4.4, -0.4], [3.6, 0.4], [4.4, 0.4]]) { const p = toWorld(F, u, 0, z + v); g = Math.min(g, gy(p.x, p.z) - T.base); }
      slab(lamps, 3.6, g - 0.15, z - 0.4, 4.4, g + 0.6, z + 0.4, col('#ffffff'));
    }
    const flood = glow('#fff1d6', 0.35, 2.4);
    flood.name = 'letter floodlights';
    glows.push(flood);
    finish('kimchi_letters', [[B, letterMat], [lamps, flood, { cast: false }]], around(T.x, T.z, total / 2 + 8));
  }

  // ---------- the North Causeway's A-frame pylon and its stays ----------
  function pylon(T) {
    const hit = roadAt(net, T.x, T.z, 'loop');
    if (!hit) return;
    const e = hit.e, c = edgeAt(e, hit.s), halfW = e.halfW / PX;
    const rx = -c.tz, rz = c.tx;                       // right of the deck
    // h is the pylon's height over the sea (62 m: the deck is 14 m up there), as roads3d builds it
    const apex = [c.x, SEA + T.h, c.z];
    if (bridgesBuilt) {
      // roads3d's pylon: its aircraft light on the head, and (after dark) a strip of light up the middle of each
      // leg's faces seen along the deck. roads3d's legs pass 3.05 m outside the deck's edge at deck height, meet
      // 1.3 m either side of the middle 10 m under the head, and taper from 2.6 m square at the bed to 1.7 m there.
      const lights = new Builder(), stripes = new Builder();
      lights.geo(new THREE.SphereGeometry(0.6, 10, 8), mat4(apex[0], apex[1] + 0.9, apex[2]));
      const yHead = apex[1] - 10, oDeck = halfW + 3.05, bed = bedAt(world, c.x, c.z) - 1;
      const off = (y) => oDeck + ((1.3 - oDeck) * (y - c.y)) / (yHead - c.y), half = (y) => (2.6 - (0.9 * (y - bed)) / (yHead - bed)) / 2;
      const at = (o, y, along) => [c.x + rx * o + c.tx * along, y, c.z + rz * o + c.tz * along];
      const ya = c.y + 4, yb = yHead - 1, axes = [];
      for (const sd of [-1, 1]) for (const fa of [-1, 1]) {
        const p0 = at(sd * off(ya), ya, fa * (half(ya) + 0.12)), p1 = at(sd * off(yb), yb, fa * (half(yb) + 0.12));
        rod(stripes, p0, p1, 0.26, '#bfe9ff', 6);
        axes.push([p0, p1]);
      }
      const stripMat = glow('#ffffff', 0, 2.6, { vertexColors: true });
      stripMat.name = 'pylon lights';
      glows.push(stripMat);
      const meshes = finish('causeway_pylon', [[lights, M.beacon, { cast: false }], [stripes, stripMat, { cast: false }]], around(c.x, c.z, oDeck + 6));
      for (const m of meshes) if (m.material === stripMat) nightOnly.push(m);
      // each strip's centre line ([x, y, z] m, bottom then top), so a test can hold them to roads3d's legs
      built[built.length - 1].strips = axes;
      return;
    }
    const B = new Builder(), lights = new Builder(), stripes = new Builder();
    const legOff = halfW + 2.6, foot = SEA - 2.5, deckY = c.y;
    const legs = [-1, 1].map(sd => [c.x + rx * legOff * sd, foot, c.z + rz * legOff * sd]);
    const along = (p, y) => { const t = (y - p[1]) / (apex[1] - p[1]); return [p[0] + (apex[0] - p[0]) * t, y, p[2] + (apex[2] - p[2]) * t]; };
    for (const L0 of legs) {
      const knee = along(L0, deckY - 2);
      bar(B, L0, knee, 3.6, 2.8, WHITE);
      bar(B, knee, along(L0, apex[1] - 3), 2.8, 2.2, WHITE);
      // a strip of light up the inner edge of each leg (on at night)
      const i0 = along(L0, deckY + 4), i1 = along(L0, apex[1] - 5), inX = (c.x - L0[0]) * 0.03, inZ = (c.z - L0[2]) * 0.03;
      rod(stripes, [i0[0] + inX, i0[1], i0[2] + inZ], [i1[0] + inX, i1[1], i1[2] + inZ], 0.22, '#bfe9ff', 6);
    }
    // the portal beam under the deck, the crown block, the mast and its light
    const k0 = along(legs[0], deckY - 2.2), k1 = along(legs[1], deckY - 2.2);
    bar(B, k0, k1, 2.4, 2.2, WHITE);
    cube(B, apex[0], apex[1] - 1.5, apex[2], 3.4, 4.5, 3.4, WHITE);
    post(B, apex[0], apex[1] + 0.7, apex[2], 0.25, 0.12, 5, STEEL, 6);
    lights.geo(new THREE.SphereGeometry(0.6, 10, 8), mat4(apex[0], apex[1] + 6.1, apex[2]));
    for (const L0 of legs) { const p = along(L0, apex[1] - 14); lights.geo(new THREE.SphereGeometry(0.35, 8, 6), mat4(p[0], p[1], p[2])); }
    // 8 stays a side in each leg's plane, the highest anchor to the furthest deck point
    const N = T.stays || 8;
    for (const [li, L0] of legs.entries()) {
      const sd = li ? 1 : -1;
      for (const dir of [-1, 1]) for (let k = 0; k < N; k++) {
        const top = along(L0, apex[1] - 28 + k * (22 / Math.max(1, N - 1)));
        const d = (18 + k * 11) * PX, p = edgeAt(e, hit.s + dir * d);
        const ax = p.x - p.tz * (halfW + 0.5) * sd, az = p.z + p.tx * (halfW + 0.5) * sd;
        rod(B, top, [ax, p.y + 1.2, az], 0.17, '#f7f7f2', 5);
        B.geo(UNIT_BOX, mat4(ax, p.y + 0.9, az, 0, 0, 0, 0.6, 0.8, 0.6), col(STEEL));
      }
    }
    const span = 120;
    const stripMat = glow('#ffffff', 0, 2.6, { vertexColors: true });
    glows.push(stripMat);
    // the pylon is floodlit after dark, and like the other beacons it is not lost in the haze
    const lit = HIGH ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0, fog: false, emissive: new THREE.Color('#bfe6ff'), emissiveIntensity: 0 })
      : new THREE.MeshLambertMaterial({ vertexColors: true, fog: false, emissive: new THREE.Color('#bfe6ff'), emissiveIntensity: 0 });
    nightSet.push([lit, 'emissiveIntensity', 0, 0.42]);
    lit.name = 'pylon'; stripMat.name = 'pylon lights';
    const meshes = finish('causeway_pylon', [[B, lit], [lights, M.beacon, { cast: false }], [stripes, stripMat, { cast: false }]], around(c.x, c.z, span));
    // the light strips up the legs show only after dark
    for (const m of meshes) if (m.material === stripMat) nightOnly.push(m);
  }

  // ---------- the lighthouse and its beam ----------
  function lighthouse(T) {
    // The beach falls toward the sea here, so the tower stands on a round stone base whose top is LH_BASE.lift
    // over the ground at its foot and whose skirt runs down past the lowest ground under it.
    const R0 = LH_BASE.r, foot = T.base + LH_BASE.lift;
    let low = T.base;
    for (let i = 0; i < 24; i++) { const b = (i / 24) * Math.PI * 2; low = Math.min(low, gy(T.x + Math.cos(b) * R0, T.z + Math.sin(b) * R0)); }
    const F = frame(T.x, foot, T.z, 0), B = new Builder().setMatrix(F), G = B, Lt = new Builder().setMatrix(F);
    const h = T.h || 30, bands = 6, shaft = h - 6, yb = low - 0.3 - foot;
    B.geo(new THREE.CylinderGeometry(R0, R0 + 0.35, -yb, 24, 1), mat4(0, yb / 2, 0), col(STONE));
    B.geo(new THREE.CylinderGeometry(R0 + 0.07, R0 + 0.07, 0.22, 24, 1), mat4(0, -0.11, 0), col('#e8e2d6'));     // its coping
    for (let i = 0; i < bands; i++) {
      const y0 = (shaft * i) / bands, y1 = (shaft * (i + 1)) / bands, r0 = 3.4 - 1.1 * (y0 / shaft), r1 = 3.4 - 1.1 * (y1 / shaft);
      B.geo(new THREE.CylinderGeometry(r1, r0, y1 - y0, 20, 1), mat4(0, (y0 + y1) / 2, 0), col(i % 2 ? '#d8262b' : '#f6f4ee'));
    }
    post(B, 0, shaft, 0, 3.1, 3.1, 0.4, DARK, 20);                       // the gallery
    for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; post(B, Math.cos(a) * 3, shaft + 0.4, Math.sin(a) * 3, 0.05, 0.05, 1.1, DARK, 4); }
    B.geo(new THREE.TorusGeometry(3, 0.06, 4, 24), mat4(0, shaft + 1.5, 0, Math.PI / 2), col(DARK));
    G.geo(new THREE.CylinderGeometry(1.7, 1.7, 3, 12, 1, true), mat4(0, shaft + 1.9, 0), col('#bfe0ea'));   // the lantern glass
    Lt.geo(new THREE.SphereGeometry(1.0, 12, 8), mat4(0, shaft + 1.9, 0));                                  // the lamp
    B.geo(new THREE.SphereGeometry(1.95, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat4(0, shaft + 3.4, 0), col('#d8262b'));
    B.geo(new THREE.CircleGeometry(1.95, 16), mat4(0, shaft + 3.4, 0, Math.PI / 2), col('#d8262b'));       // the dome's underside
    post(B, 0, shaft + 5.2, 0, 0.12, 0.04, 1.6, DARK, 6);
    const spot = cottageSpot(world, T);
    if (spot) cottage(B, spot);
    const lamp = glow('#fff1c8', 0.4, 3.0);
    lamp.name = 'lighthouse lamp';
    finish('lighthouse', [[B, M.paint], [Lt, lamp, { cast: false }]], around(T.x, T.z, 18));
    glows.push(lamp);
    // the beam: two long cones from the lamp, turning at beamHz, seen only at night (softBeam: a shaft of light
    // with soft edges, not a solid wedge)
    const beamMat = softBeam(new THREE.MeshBasicMaterial({ color: '#fff3d0', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide }));
    const beam = new THREE.Group();
    beam.position.set(T.x, foot + shaft + 1.9, T.z);
    for (const sd of [1, -1]) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(9, 150, 16, 1, true), beamMat);
      cone.name = 'landmark lighthouse beam';
      cone.rotation.z = sd * Math.PI / 2;          // apex at the lamp, opening along ±x
      cone.position.x = sd * 75;
      beam.add(cone);
    }
    beam.visible = false;
    group.add(beam);
    const hz = T.beamHz || 0.25;
    anim.push((t, n) => {
      beam.visible = n > 0.05;
      if (!beam.visible) return;
      beam.rotation.y = -t * hz * Math.PI * 2;
      beamMat.opacity = BEAM_GLOW * Math.min(1, n * 1.4);
    });
  }
  // The keeper's cottage on its spot (cottageSpot): white walls and a red hipped roof on a stone footing that
  // runs down past the lowest ground under it, the door toward the tower (+z) with steps down to the sand.
  function cottage(B, c) {
    const { w, d, wall } = COTTAGE, base = c.hi - 0.05, top = base + wall, F = frame(c.x, 0, c.z, c.a);
    B.setMatrix(F);
    slab(B, -w / 2 - 0.15, c.lo - 0.3, -d / 2 - 0.15, w / 2 + 0.15, base, d / 2 + 0.15, col(STONE));
    slab(B, -w / 2, base, -d / 2, w / 2, top, d / 2, col('#f6f4ee'));
    // the hipped roof: a four-sided pyramid squared to the walls, with eaves
    const roof = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1);
    roof.rotateY(Math.PI / 4);
    B.geo(roof, mat4(0, top + 1, 0, 0, 0, 0, w + 0.9, 2, d + 0.9), col('#d8262b'));
    // the door and a window either side of it, two windows at the back
    slab(B, -0.55, base, d / 2, 0.55, base + 2.1, d / 2 + 0.06, col('#2a7f8a'));
    for (const sz of [-1, 1]) for (const x of [-2.6, 2.6]) {
      slab(B, x - 0.55, base + 1.0, sz > 0 ? d / 2 : -d / 2 - 0.06, x + 0.55, base + 2.1, sz > 0 ? d / 2 + 0.06 : -d / 2, col('#7fbcd6'));
    }
    // steps from the door down to the ground in front of it
    const p = toWorld(F, 0, 0, d / 2 + 0.8), g = gy(p.x, p.z);
    for (let i = 1; base - i * 0.22 > g + 0.05; i++) slab(B, -0.8, g - 0.3, d / 2 + 0.15, 0.8, base - i * 0.22, d / 2 + 0.15 + 0.32 * i, col(STONE));
    B.setMatrix(null);
  }

  // ---------- Kimchi Fest: the arch over Festival Way ----------
  function festArch(T) {
    const a = spanFrame(net, T).a, F = frame(T.x, T.base, T.z, a);
    const B = new Builder().setMatrix(F), bulbs = new Builder().setMatrix(F);
    const half = (T.span || 22) / 2, H = T.h || 11;
    const stripes = ['#ff4fa3', '#2ad1c9', '#ffd23f'];
    for (const sd of [-1, 1]) {
      const z = sd * half;
      // each column's lowest stripe runs down past the lowest ground under it
      let low = 0;
      for (const [u, v] of [[-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]]) { const p = toWorld(F, u, 0, z + v); low = Math.min(low, gy(p.x, p.z) - T.base); }
      for (let i = 0; i < 6; i++) slab(B, -0.9, i ? i * (H - 2) / 6 : low - 0.3, z - 0.9, 0.9, (i + 1) * (H - 2) / 6, z + 0.9, col(stripes[i % 3]));
      B.geo(new THREE.SphereGeometry(1.25, 14, 10), mat4(0, H + 0.4, z), col('#ffd23f'));
    }
    slab(B, -0.7, H - 3, -half - 1, 0.7, H - 0.6, half + 1, col('#1b1020'));
    // festoon bulbs hanging between the columns
    for (const x of [-0.85, 0.85]) for (let i = 1; i < 22; i++) {
      const u = i / 22, z = -half + u * half * 2, y = H - 3.2 - Math.sin(u * Math.PI) * 1.4;
      bulbs.geo(new THREE.SphereGeometry(0.16, 6, 4), mat4(x, y, z));
    }
    const sign = TX.textSign('KIMCHI FEST', { bg: '#ff4fa3', fg: '#ffffff', w: 1024, h: 128, size: 92, border: '#ffd23f' });
    const signMat = matte({ map: sign, emissiveMap: sign, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.3 });
    nightSet.push([signMat, 'emissiveIntensity', 0.3, 1.6]);
    const S = new Builder().setMatrix(F);
    for (const sd of [1, -1]) {
      const x = sd * 0.72, w = half * 2 + 1.6;
      // facing ±x: u runs to the viewer's right
      S.quad([x, H - 2.9, sd * w / 2], [x, H - 2.9, -sd * w / 2], [x, H - 0.7, -sd * w / 2], [x, H - 0.7, sd * w / 2], [[0, 0], [1, 0], [1, 1], [0, 1]]);
    }
    finish('fest_arch', [[B, M.paint], [S, signMat, { cast: false }], [bulbs, M.lamp, { cast: false }]], around(T.x, T.z, half + 3), { far: SMALL_FAR });
  }

  // ---------- the Ferris wheel ----------
  function ferrisWheel(T) {
    // the hub stands high enough that the lowest gondola (2.8 m under the rim) passes 0.8 m over the ground. The
    // boarding slab is flush with the plaza's walking height (its curb, 0.16 m), so Kimchi walks onto it and under
    // the wheel; what he cannot pass (the legs, the booth, the gondolas' lowest stretch) is prefabs.js landmarkSolids
    const R = (T.d || 40) / 2, hubY = T.base + R + 3.6, F = frame(T.x, T.base, T.z, T.a), SLAB = 0.16;
    const B = new Builder().setMatrix(F);
    // A-frame legs either side of the wheel (the axle runs along local x)
    for (const sx of [-3.2, 3.2]) {
      for (const sz of [-13, 13]) bar(B, [sx * 1.5, -0.3, sz], [sx, hubY - T.base, 0], 1.0, 0.8, WHITE);
      bar(B, [sx * 1.25, (hubY - T.base) * 0.4, -8], [sx * 1.25, (hubY - T.base) * 0.4, 8], 0.5, 0.5, WHITE);
    }
    rod(B, [-4, hubY - T.base, 0], [4, hubY - T.base, 0], 0.9, STEEL, 12);
    slab(B, -6, -0.3, -16, 6, SLAB, 16, col('#e8e2d6'));
    // the ticket booth on the slab, clear of the legs and the gondolas' path: pink, a white roof, its window
    slab(B, -5.6, SLAB, 4, -2.4, SLAB + 2.6, 7.5, col('#ff4fa3'));
    slab(B, -5.85, SLAB + 2.6, 3.75, -2.15, SLAB + 2.82, 7.75, col('#f6f4ee'));
    slab(B, -5.66, SLAB + 0.95, 4.8, -5.6, SLAB + 1.95, 6.7, col('#2a2440'));
    finish('ferris_wheel', [[B, M.paint]], around(T.x, T.z, 24));
    // the turning wheel: two rims, spokes, cross ties and a ring of lights (built round its own hub)
    const W = new Builder(), Lw = new Builder(), spokes = 16;
    for (const x of [-1.3, 1.3]) {
      W.geo(new THREE.TorusGeometry(R, 0.32, 6, 64), mat4(x, 0, 0, 0, Math.PI / 2, 0), col(WHITE));
      Lw.geo(new THREE.TorusGeometry(R + 0.36, 0.12, 4, 96), mat4(x, 0, 0, 0, Math.PI / 2, 0), col('#ff6fd0'));
      for (let i = 0; i < spokes; i++) {
        const a = (i / spokes) * Math.PI * 2;
        rod(W, [x, 0, 0], [x, Math.sin(a) * R, Math.cos(a) * R], 0.12, WHITE, 4);
      }
    }
    for (let i = 0; i < spokes; i++) { const a = (i / spokes) * Math.PI * 2; rod(W, [-1.3, Math.sin(a) * R, Math.cos(a) * R], [1.3, Math.sin(a) * R, Math.cos(a) * R], 0.1, WHITE, 4); }
    const wheel = new THREE.Group();
    wheel.position.copy(toWorld(F, 0, hubY - T.base, 0));
    wheel.rotation.y = -T.a;
    const rot = new THREE.Group();
    wheel.add(rot);
    const wm = W.mesh(M.paint, { cast: true, indexed: true }), lm = Lw.mesh(glow('#ff6fd0', 0.6, 2.8, { fog: true }), { indexed: true });
    glows.push(lm.material);
    wm.matrixAutoUpdate = lm.matrixAutoUpdate = true;
    wm.name = 'landmark ferris_wheel rim'; lm.name = 'landmark ferris_wheel lights';
    rot.add(wm, lm);
    // the gondolas: one instanced mesh, kept upright as they go round
    const gb = new Builder();
    slab(gb, -1.0, -2.6, -1.1, 1.0, -0.4, 1.1, col('#ffffff'));
    slab(gb, -1.15, -0.45, -1.25, 1.15, -0.15, 1.25, col('#f6f4ee'));
    slab(gb, -0.06, -0.4, -0.06, 0.06, 0.1, 0.06, col(STEEL));
    const gm = new THREE.InstancedMesh(gb.build({ indexed: true }), M.paint, spokes);
    gm.castShadow = true; gm.receiveShadow = true;
    gm.frustumCulled = false;      // its copies move every frame; the wheel is always near its hub
    gm.name = 'landmark ferris_wheel gondolas';
    const candy = ['#ff6fb5', '#2ad1c9', '#ffd23f', '#7fb2ff', '#ff8a5c', '#9b7bff'];
    for (let i = 0; i < spokes; i++) gm.setColorAt(i, col(candy[i % candy.length]));
    wheel.add(gm);
    addObj(wheel, around(T.x, T.z, 24));
    built.find(b => b.id === 'ferris_wheel')?.meshes.push(wm, lm, gm);
    const hz = T.hz || 0.02, gmat = new THREE.Matrix4();
    anim.push((t) => {
      const turn = t * hz * Math.PI * 2;
      rot.rotation.x = turn;
      for (let i = 0; i < spokes; i++) {
        const a = (i / spokes) * Math.PI * 2 + turn;
        gmat.makeTranslation(0, Math.sin(a) * R - 0.2, Math.cos(a) * R);
        gm.setMatrixAt(i, gmat);
      }
      gm.instanceMatrix.needsUpdate = true;
    });
  }

  // ---------- the festival stage, facing east ----------
  function festStage(T) {
    const F = frame(T.x, T.base, T.z, T.a), B = new Builder().setMatrix(F), D = new Builder().setMatrix(F);
    const H = T.h || 12;
    slab(B, -7, 0, -11, 5, 1.6, 11, col('#3a3a40'));                              // the deck
    slab(B, 5, 0, -11, 5.2, 1.6, 11, col('#ff4fa3'));
    for (const [x, z] of [[-6.5, -10.5], [-6.5, 10.5], [4.5, -10.5], [4.5, 10.5]]) {
      for (const [dx, dz] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) rod(B, [x + dx, 1.6, z + dz], [x + dx, H, z + dz], 0.06, STEEL, 4);
      for (let y = 2.4; y < H; y += 1.2) slab(B, x - 0.32, y, z - 0.32, x + 0.32, y + 0.06, z + 0.32, col(STEEL));
    }
    slab(B, -7, H, -11.2, 5, H + 0.8, 11.2, col(STEEL));                         // the roof truss
    slab(B, -7.6, H + 0.8, -12, 5.6, H + 1.4, 12, col('#1b1b20'));               // the canopy
    for (const sd of [-1, 1]) slab(B, -1, -0.6, sd * 12.5 - 1.2, 2.5, 7.4, sd * 12.5 + 1.2, col('#151517'));   // speaker towers on the ground either side
    // the screen at the back of the stage
    const tex = TX.textSign('KIMCHI FEST', { bg: '#1a0b33', fg: '#ff6fd0', w: 1024, h: 384, size: 150, sub: 'LIVE TONIGHT', border: '#4fe3ff' });
    const scr = matte({ map: tex, emissiveMap: tex, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.55 });
    nightSet.push([scr, 'emissiveIntensity', 0.55, 1.8]);
    D.quad([-6.4, 2.8, 8], [-6.4, 2.8, -8], [-6.4, 10.4, -8], [-6.4, 10.4, 8], [[0, 0], [1, 0], [1, 1], [0, 1]]);
    slab(B, -7, 1.6, -8.4, -6.5, 10.8, 8.4, col('#151517'));
    finish('fest_stage', [[B, M.paint], [D, scr, { cast: false }]], around(T.x, T.z, 16), { far: SMALL_FAR });
  }

  // ---------- the three pink Port cranes (one mesh) ----------
  function cranes(list) {
    if (!list.length) return;
    const B = new Builder(), PINK = '#ff6fb5';
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const T of list) {
      const F = frame(T.x, T.base, T.z, T.a), H = T.h || 45, portal = H * 0.62, boomY = H * 0.7;
      B.setMatrix(F);
      // four legs straddling the quay (land side at −12, water side at +6), sills and the portal
      for (const lx of [-12, 6]) for (const lz of [-7.5, 7.5]) bar(B, [lx, -0.2, lz], [lx, portal, lz], 1.3, 1.3, PINK);
      for (const lx of [-12, 6]) { bar(B, [lx, 1.2, -7.5], [lx, 1.2, 7.5], 1.1, 1.4, PINK); bar(B, [lx, portal, -7.5], [lx, portal, 7.5], 1.3, 1.6, PINK); }
      for (const lz of [-7.5, 7.5]) { bar(B, [-12, portal, lz], [6, portal, lz], 1.4, 1.3, PINK); bar(B, [-12, 4, lz], [6, portal - 2, lz], 0.5, 0.5, PINK); }
      // the boom: two girders from the back reach out over the water, the A-frame and its stays
      for (const lz of [-2.6, 2.6]) bar(B, [-26, boomY, lz], [44, boomY, lz], 1.3, 1.6, PINK);
      for (let x = -24; x <= 42; x += 6) bar(B, [x, boomY, -2.6], [x, boomY, 2.6], 0.3, 0.3, PINK);
      for (const lz of [-3.5, 3.5]) { bar(B, [-12, portal, lz], [-4, H, 0], 0.9, 0.9, PINK); bar(B, [6, portal, lz], [-4, H, 0], 0.9, 0.9, PINK); }
      for (const lz of [-2.6, 2.6]) { rod(B, [-4, H, 0], [44, boomY + 0.8, lz], 0.13, '#f6f4ee', 4); rod(B, [-4, H, 0], [24, boomY + 0.8, lz], 0.13, '#f6f4ee', 4); rod(B, [-4, H, 0], [-26, boomY + 0.8, lz], 0.13, '#f6f4ee', 4); }
      slab(B, -24, boomY + 0.8, -3.5, -12, boomY + 4.6, 3.5, col('#f6f4ee'));     // machinery house
      slab(B, 18, boomY - 2.6, -2.2, 22, boomY - 0.4, 2.2, col('#f6f4ee'));        // trolley and cab
      slab(B, 18.5, boomY - 3.6, -1.6, 21.5, boomY - 2.6, 1.6, col('#2a4a5c'));
      rod(B, [20, boomY - 3.6, 0], [20, boomY - 14, 0], 0.08, DARK, 4);
      slab(B, 17.5, boomY - 14.6, -3, 22.5, boomY - 14, 3, col('#ffd23f'));      // the spreader
      for (const p of [[-4, H, 0], [44, boomY + 1, 0]]) { const w = toWorld(F, ...p); x0 = Math.min(x0, w.x); x1 = Math.max(x1, w.x); z0 = Math.min(z0, w.z); z1 = Math.max(z1, w.z); }
      const c = toWorld(F, -26, 0, 0); x0 = Math.min(x0, c.x); x1 = Math.max(x1, c.x);
    }
    B.setMatrix(null);
    finish('port_cranes', [[B, M.paint]], [x0 - 10, z0 - 10, x1 + 10, z1 + 10]);
  }

  // ---------- Kimchi Air's control tower ----------
  function controlTower(T) {
    const F = frame(T.x, T.base, T.z, T.a), B = new Builder().setMatrix(F), G = new Builder().setMatrix(F), Bc = new Builder().setMatrix(F);
    const H = T.h || 22, cab = H - 5;
    slab(B, -7, -0.3, -5, 7, 4.2, 5, col('#e9e4da'));
    slab(B, -7.3, 4.2, -5.3, 7.3, 4.6, 5.3, col('#2aa39d'));
    // the base's ribbon of windows round all four sides (split for the door on the apron side, +x), white
    // mullions every 1.6 m or so and a sill under it, and a glass door under a canopy
    const GLASS = col('#3f6f86'), FRAME = col('#f6f4ee'), w0 = 1.5, w1 = 3.4;
    const ribbon = (axis, sd, a0, a1) => {
      // glass a0..a1 m along the face that looks toward sd on axis ('x' or 'z'), proud of it by 4 cm
      const f = axis === 'z' ? 5 : 7, o0 = sd > 0 ? f : -f - 0.04, o1 = sd > 0 ? f + 0.04 : -f;
      const put = (Bd, u0, y0, u1, y1, p0, p1, c) => (axis === 'z' ? slab(Bd, u0, y0, p0, u1, y1, p1, c) : slab(Bd, p0, y0, u0, p1, y1, u1, c));
      put(G, a0, w0, a1, w1, o0, o1, GLASS);
      put(B, a0 - 0.1, w0 - 0.14, a1 + 0.1, w0, sd > 0 ? f : -f - 0.08, sd > 0 ? f + 0.08 : -f, FRAME);
      const n = Math.max(1, Math.round((a1 - a0) / 1.6));
      for (let k = 0; k <= n; k++) { const u = a0 + ((a1 - a0) * k) / n; put(B, u - 0.07, w0, u + 0.07, w1, sd > 0 ? f : -f - 0.08, sd > 0 ? f + 0.08 : -f, FRAME); }
    };
    for (const sd of [-1, 1]) ribbon('z', sd, -6.2, 6.2);
    ribbon('x', -1, -4.2, 4.2);
    ribbon('x', 1, -4.2, -2.1); ribbon('x', 1, 2.1, 4.2);
    slab(G, 7, 0, -1.1, 7.04, 2.5, 1.1, GLASS);                                 // the door, its frame and canopy
    for (const z of [-1.25, 1.1]) slab(B, 7, 0, z, 7.1, 2.65, z + 0.15, FRAME);
    slab(B, 7, 2.5, -1.25, 7.1, 2.65, 1.25, FRAME);
    slab(B, 7, -0.02, -0.03, 7.06, 2.5, 0.03, FRAME);
    slab(B, 7, 2.85, -1.9, 8.6, 3.05, 1.9, col('#2aa39d'));
    B.geo(new THREE.CylinderGeometry(2.4, 3.0, cab, 8), mat4(0, cab / 2, 0, 0, Math.PI / 8, 0), col('#f1ede4'));
    B.geo(new THREE.CylinderGeometry(4.0, 3.2, 0.8, 8), mat4(0, cab + 0.4, 0, 0, Math.PI / 8, 0), col('#f1ede4'));
    G.geo(new THREE.CylinderGeometry(4.6, 4.0, 3.4, 8, 1, true), mat4(0, cab + 2.5, 0, 0, Math.PI / 8, 0), col('#3f6f86'));
    B.geo(new THREE.CylinderGeometry(4.9, 4.9, 0.6, 8), mat4(0, cab + 4.5, 0, 0, Math.PI / 8, 0), col('#f1ede4'));
    post(B, 0, cab + 4.8, 0, 0.18, 0.06, 6, STEEL, 6);
    slab(B, -1.6, cab + 5.1, -0.3, 1.6, cab + 5.5, 0.3, col(STEEL));            // the radar bar
    Bc.geo(new THREE.SphereGeometry(0.35, 8, 6), mat4(0, cab + 11, 0));
    finish('control_tower', [[B, M.paint], [G, M.glass], [Bc, M.beacon, { cast: false }]], around(T.x, T.z, 9), { far: SMALL_FAR + 300 });
  }

  // ---------- the K-Town gate over Seoul Ave ----------
  function ktownGate(T) {
    const sf = spanFrame(net, T), F = frame(T.x, sf.y, T.z, sf.a);
    const B = new Builder().setMatrix(F), R = B, lan = new Builder().setMatrix(F);
    const half = (T.span || 18) / 2, H = T.h || 9, RED = '#b8262b', GREEN = '#2f7d6d', BLUE = '#2d5f9a';
    for (const sd of [-1, 1]) for (const x of [-1.3, 1.3]) {
      // each pillar on a stone footing sunk past the lowest ground under it (the sidewalk or the verge)
      const z = sd * half;
      let low = -0.1;
      for (const [u, v] of [[-0.75, -0.75], [0.75, -0.75], [-0.75, 0.75], [0.75, 0.75]]) { const p = toWorld(F, x + u, 0, z + v); low = Math.min(low, gy(p.x, p.z) - sf.y); }
      slab(B, x - 0.75, low - 0.3, z - 0.75, x + 0.75, 0.6, z + 0.75, col('#9b958a'));
      post(B, x, 0.6, z, 0.45, 0.4, H - 3.2, RED, 12);
    }
    // painted beams (dancheong): green and blue bands under the eaves
    for (const [y, c2] of [[H - 2.8, GREEN], [H - 2.3, BLUE], [H - 1.9, RED]]) slab(B, -1.7, y, -half - 0.8, 1.7, y + 0.45, half + 0.8, col(c2));
    slab(B, -1.3, H - 4.4, -half, 1.3, H - 3.9, half, col(GREEN));
    // the tiled roof with lifted eaves
    const y0 = H - 1.5, y1 = H + 0.9, ew = half + 3.2, rw = half - 0.5, d0 = 3.4, d1 = 0.5, lift = 0.7, TILE = col('#3a4650');
    const quad = (p, q, r, s) => upQuad(R, p, q, r, s, TILE);
    quad([d0, y0, -ew], [d0, y0, ew], [d1, y1, rw], [d1, y1, -rw]);
    quad([-d0, y0, ew], [-d0, y0, -ew], [-d1, y1, -rw], [-d1, y1, rw]);
    quad([d0, y0, ew], [-d0, y0, ew], [-d1, y1, rw], [d1, y1, rw]);
    quad([-d0, y0, -ew], [d0, y0, -ew], [d1, y1, -rw], [-d1, y1, -rw]);
    for (const sd of [-1, 1]) for (const sx of [-1, 1]) rod(R, [sx * d0, y0, sd * ew], [sx * (d0 + 0.5), y0 + lift, sd * (ew + 0.6)], 0.22, '#3a4650', 4);
    slab(R, -0.4, y1 - 0.1, -rw - 0.6, 0.4, y1 + 0.45, rw + 0.6, TILE);
    slab(R, -d0, y0 - 0.25, -ew, d0, y0, ew, col('#2a3036'));
    // the name board, both faces, and red lanterns
    const sign = TX.textSign('서울 SEOUL CIRCLE', { bg: '#1b1512', fg: 'gold', w: 1024, h: 160, size: 84, border: '#d4af37' });
    const sm = matte({ map: sign, emissiveMap: sign, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.15 });
    nightSet.push([sm, 'emissiveIntensity', 0.15, 1.2]);
    const S = new Builder().setMatrix(F);
    for (const sd of [1, -1]) { const x = sd * 1.42; S.quad([x, H - 4.2, sd * 4.6], [x, H - 4.2, -sd * 4.6], [x, H - 3.0, -sd * 4.6], [x, H - 3.0, sd * 4.6], [[0, 0], [1, 0], [1, 1], [0, 1]]); }
    for (const sd of [-1, 1]) for (const z of [-half + 2, -half / 2, half / 2, half - 2]) {
      lan.geo(new THREE.SphereGeometry(0.42, 10, 8), mat4(sd * 1.6, H - 3.6, z, 0, 0, 0, 1, 1.3, 1), col('#ff3b2f'));
    }
    const lanternMat = glow('#ffffff', 0.9, 2.6, { fog: true, vertexColors: true });
    glows.push(lanternMat);
    finish('ktown_gate', [[B, M.paint], [S, sm, { cast: false }], [lan, lanternMat, { cast: false }]], around(T.x, T.z, half + 4), { far: SMALL_FAR });
  }

  // ---------- fountains (Bayfront Park's big one, and every prefab park fountain) ----------
  function fountain(id, x, z, r, tiers = 2) {
    const y = gy(x, z), F = frame(x, y, z, 0), B = new Builder().setMatrix(F), Wt = new Builder().setMatrix(F);
    B.geo(new THREE.CylinderGeometry(r, r + 0.25, 0.75, 40, 1, true), mat4(0, 0.35, 0), col('#d6cfc2'));
    B.geo(inward(new THREE.CylinderGeometry(r - 0.45, r - 0.25, 0.8, 40, 1, true)), mat4(0, 0.35, 0), col('#cfc7b8'));   // the inner wall faces the water
    B.geo(new THREE.RingGeometry(r - 0.45, r + 0.25, 40, 1), mat4(0, 0.75, 0, -Math.PI / 2), col('#e8e2d6'));
    Wt.geo(new THREE.CircleGeometry(r - 0.45, 40), mat4(0, 0.55, 0, -Math.PI / 2), col('#ffffff'));
    let top = 0.6;
    for (let k = 0; k < tiers; k++) {
      const br = r * (0.42 - k * 0.16), ch = 1.4 - k * 0.3;
      post(B, 0, top, 0, 0.35 * r / 4, 0.25 * r / 4, ch, '#d6cfc2', 12);
      B.geo(new THREE.CylinderGeometry(br, br * 0.35, 0.4, 24), mat4(0, top + ch + 0.2, 0), col('#d6cfc2'));
      Wt.geo(new THREE.CircleGeometry(br - 0.12, 24), mat4(0, top + ch + 0.41, 0, -Math.PI / 2), col('#ffffff'));
      top += ch + 0.4;
    }
    const water = HIGH ? new THREE.MeshStandardMaterial({ color: '#5ab0d0', roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.9, vertexColors: true })
      : new THREE.MeshLambertMaterial({ color: '#5ab0d0', transparent: true, opacity: 0.9, vertexColors: true });
    finish(id, [[B, M.paint], [Wt, water, { cast: false }]], around(x, z, r + 1), { far: SMALL_FAR });
    // the jets, a central plume and (on a big basin) a ring of small ones, in one mesh that sways
    // (unlit spray: dimmed with the daylight so it does not glow at night)
    const jetMat = glow('#dff4ff', 1, 0.28, { fog: true, transparent: true, opacity: 0.5, depthWrite: false });
    glows.push(jetMat);
    const J = new Builder(), mainH = 2.6 * r / 4 + 1;
    J.geo(new THREE.ConeGeometry(0.55 * r / 4, mainH, 12, 1, true), mat4(0, top + mainH / 2, 0, Math.PI, 0, 0));
    const n = r > 6 ? 10 : 0;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      J.geo(new THREE.ConeGeometry(0.22, 2.2, 8, 1, true), mat4(Math.cos(a) * (r - 1.6), 1.6, Math.sin(a) * (r - 1.6), Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35 + Math.PI));
    }
    const jm = new THREE.Mesh(J.build({ indexed: true }), jetMat);
    jm.name = 'landmark ' + id + ' jets';
    jm.position.set(x, y, z);
    addObj(jm, around(x, z, r + 1), SMALL_FAR);
    jets.push({ m: jm, ph: x * 0.37 });
  }
  function bayfrontFountain(T) {
    // The data point sits on the Riverwalk path; the fountain stands on the lawn beside it.
    const r = 8, spot = clearSpot(world, T.x, T.z, r + 1);
    fountain('bayfront_fountain', spot.x, spot.z, r, 2);
  }
  function parkFountains() {
    for (const d of world.deco) if (d.kind === 'fountain') fountain('fountain ' + d.x + ',' + d.y, d.x / PX, d.y / PX, 4, 2);
  }
  anim.push((t) => {
    for (const f of jets) f.m.scale.set(1 + Math.sin(t * 9 + f.ph) * 0.04, 1 + Math.sin(t * 6 + f.ph) * 0.08, 1 + Math.cos(t * 9 + f.ph) * 0.04);
  });

  // ---------- the Glades lookout tower ----------
  function gladesTower(T) {
    const F = frame(T.x, T.base, T.z, T.a), B = new Builder().setMatrix(F), H = T.h || 12, WOOD = '#8a6a48', DECK = '#a7845c';
    for (const x of [-2.4, 2.4]) for (const z of [-2.4, 2.4]) bar(B, [x * 1.15, -0.5, z * 1.15], [x, H + 0.2, z], 0.36, 0.36, WOOD);
    for (const y of [H * 0.5, H]) {
      slab(B, -2.9, y - 0.25, -2.9, 2.9, y, 2.9, col(DECK));
      for (const [x0, z0, x1, z1] of [[-2.9, -2.9, 2.9, -2.8], [-2.9, 2.8, 2.9, 2.9], [-2.9, -2.9, -2.8, 2.9], [2.8, -2.9, 2.9, 2.9]]) slab(B, x0, y + 0.95, z0, x1, y + 1.1, z1, col(WOOD));
    }
    // cross bracing, a stair flight up each level, the roof
    for (const z of [-2.4, 2.4]) { bar(B, [-2.6, 0, z], [2.4, H * 0.5, z], 0.18, 0.18, WOOD); bar(B, [2.4, H * 0.5, z], [-2.4, H, z], 0.18, 0.18, WOOD); }
    for (const [y0, y1, sd] of [[0, H * 0.5, 1], [H * 0.5, H, -1]]) {
      for (let i = 0; i < 12; i++) {
        const u = i / 12, y = y0 + (y1 - y0) * u, x = sd * (-2.2 + 4.4 * u);
        slab(B, x - 0.25, y, 3.0, x + 0.25, y + 0.08, 4.2, col(DECK));
      }
      // the two stringers the treads rest on, the lower flight's dug into the ground at its foot
      const k = (y1 - y0) / 4.4;
      for (const z of [3.08, 4.12]) bar(B, [sd * -2.75, y0 - 0.3 - 0.55 * k, z], [sd * 2.2, y1 - 0.3, z], 0.14, 0.3, WOOD);
    }
    B.geo(new THREE.ConeGeometry(4.6, 2.6, 4), mat4(0, H + 3.1, 0, 0, Math.PI / 4, 0), col('#7a6040'));
    for (const x of [-2.4, 2.4]) for (const z of [-2.4, 2.4]) post(B, x, H, z, 0.12, 0.12, 1.9, WOOD, 4);
    finish('glades_tower', [[B, M.paint]], around(T.x, T.z, 6), { far: SMALL_FAR });
  }

  // ---------- the curved resort on Collins ----------
  function resort(T) {
    // A slab bent round a centre east of it, so its concave face looks out over Collins to the ocean (RESORT:
    // 60 m arc radius, 14 m deep, ±0.55 rad, its west face 20 m west of the landmark point). The resort atlas's
    // bays (8 x 8 of 3 m x 3.2 m per 24 m x 25.6 m tile, a whole number across every wall) on both faces and both
    // ends, white balcony bands on the ocean side, and a 3-floor podium in front of it: a glass lobby under a
    // fascia, two floors of rooms over it, and a canopy over the entrance facing Collins.
    const H = T.h || 60, floors = Math.round((H - 2.4) / 3.2), top = floors * 3.2, R = RESORT;
    const span = R.span, cx = T.x + R.Rc - R.west, cz = T.z, ro = R.Rc, ri = R.Rc - R.depth, rp = ri - R.podium, V = 25.6;
    const facade = TX.decoFacade();
    TX.replaceCanvas(facade.map, 'assets/tex/facade_resort.jpg');
    TX.replaceCanvas(facade.lit, 'assets/tex/facade_resort_lit.jpg');
    TX.replaceCanvas(facade.rough, 'assets/tex/facade_resort_rough.jpg');
    const wall = matte({ map: facade.map, emissiveMap: facade.lit, emissive: new THREE.Color('#ffd28a'), emissiveIntensity: 0, ...(HIGH ? { roughness: 1, roughnessMap: facade.rough } : {}) });
    nightSet.push([wall, 'emissiveIntensity', 0, 1.1]);
    const Wf = new Builder(), Tr = new Builder(), Gl = new Builder(), y0 = T.base, segs = 28, podium = 3.2 * 3, lobby = 3.2, fascia = 0.4;
    const pt = (r, t) => [cx - Math.cos(t) * r, cz + Math.sin(t) * r];     // t = 0 is due west of the centre, t > 0 south
    const P3 = (r, t, y) => { const [x, z] = pt(r, t); return [x, y, z]; };
    const WHITE_C = col('#ffffff'), CREAM = col('#f2efe8'), EDGE = col('#e9e6e0'), END = col('#f6f3ec'), GLASS = col('#8fd0e0');
    const tiles = (L) => Math.max(1, Math.round(L / 3)) / 8;                // a whole number of 3 m bays across L m
    const v = (y) => (y - y0) / V;
    // a wall from a to b ([x, z] m, a on the left as seen from in front), ya to yb m: the atlas's bays, u from u0 to u1
    const face = (a, b, ya, yb, u0, u1) => Wf.quad([a[0], ya, a[1]], [b[0], ya, b[1]], [b[0], yb, b[1]], [a[0], yb, a[1]], [[u0, v(ya)], [u1, v(ya)], [u1, v(yb)], [u0, v(yb)]]);
    // the lobby under a podium wall from a to b: glass to the fascia, the white fascia band over it
    const lobbyWall = (a, b) => {
      Gl.quad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y0 + lobby - fascia, b[1]], [a[0], y0 + lobby - fascia, a[1]], undefined, GLASS);
      Tr.quad([a[0], y0 + lobby - fascia, a[1]], [b[0], y0 + lobby - fascia, b[1]], [b[0], y0 + lobby, b[1]], [a[0], y0 + lobby, a[1]], undefined, WHITE_C);
    };
    const uo = tiles(ro * 2 * span), ui = tiles(ri * 2 * span), up = tiles(rp * 2 * span);
    for (let i = 0; i < segs; i++) {
      const f0 = i / segs, f1 = (i + 1) / segs, t0 = -span + 2 * span * f0, t1 = -span + 2 * span * f1;
      // west face (seen from the west, north on the left) and east face (seen from the east, south on the left)
      face(pt(ro, t0), pt(ro, t1), y0, y0 + top, uo * f0, uo * f1);
      face(pt(ri, t1), pt(ri, t0), y0, y0 + top, ui * (1 - f1), ui * (1 - f0));
      Tr.quad(P3(ro, t0, y0 + top), P3(ro, t1, y0 + top), P3(ri, t1, y0 + top), P3(ri, t0, y0 + top), undefined, CREAM);
      // a balcony band at every floor over the podium on the ocean face: its top and its front edge
      for (let f = 4; f < floors; f++) {
        const y = y0 + f * 3.2 - 0.12;
        Tr.quad(P3(ri, t0, y), P3(ri, t1, y), P3(ri - 1.1, t1, y), P3(ri - 1.1, t0, y), undefined, WHITE_C);
        Tr.quad(P3(ri - 1.1, t1, y - 0.18), P3(ri - 1.1, t0, y - 0.18), P3(ri - 1.1, t0, y), P3(ri - 1.1, t1, y), undefined, EDGE);
      }
      // the podium in front of the ocean face: its roof terrace, two floors of rooms over the lobby
      Tr.quad(P3(ri, t0, y0 + podium), P3(ri, t1, y0 + podium), P3(rp, t1, y0 + podium), P3(rp, t0, y0 + podium), undefined, col('#e8f4f2'));
      face(pt(rp, t1), pt(rp, t0), y0 + lobby, y0 + podium, up * (1 - f1), up * (1 - f0));
      lobbyWall(pt(rp, t1), pt(rp, t0));
      Tr.quad(P3(ri, t1, y0 + lobby), P3(ri, t0, y0 + lobby), P3(rp, t0, y0 + lobby), P3(rp, t1, y0 + lobby), undefined, col('#f3e9d6'));   // the lobby's ceiling
    }
    // the lobby's mullions, one on every bay line
    const nb = Math.round(up * 8);
    for (let k = 0; k <= nb; k++) {
      const [x, z] = pt(rp - 0.08, -span + (2 * span * k) / nb);
      bar(Tr, [x, y0, z], [x, y0 + lobby - fascia, z], 0.16, 0.16, WHITE);
    }
    // the end walls (north end faces north, south end south) and the podium's ends
    for (const sd of [-1, 1]) {
      const t = sd * span, l = (r0, r1) => (sd < 0 ? [pt(r0, t), pt(r1, t)] : [pt(r1, t), pt(r0, t)]);
      const [a, b] = l(ri, ro), [c, d] = l(rp, ri), ue = tiles(R.depth), up2 = tiles(R.podium);
      face(a, b, y0, y0 + top, 0, ue);
      face(c, d, y0 + lobby, y0 + podium, 0, up2);
      lobbyWall(c, d);
      // its mullions on the bay lines too, so the lit glass reads as panes at night (the corner one is the front's)
      const ox = sd * Math.sin(t) * 0.08, oz = sd * Math.cos(t) * 0.08, ne = Math.max(1, Math.round(R.podium / 3));
      for (let k = 1; k <= ne; k++) {
        const [x, z] = pt(rp + ((ri - rp) * k) / ne, t);
        bar(Tr, [x + ox, y0, z + oz], [x + ox, y0 + lobby - fascia, z + oz], 0.16, 0.16, WHITE);
      }
    }
    // the entrance canopy over Collins: a white slab reaching out from the lobby on two slim posts
    const ch = y0 + lobby - 0.05, [ex, ez] = pt(rp - R.canopy / 2, 0), [ox] = pt(rp - R.canopy + 0.4, 0);
    slab(Tr, ex - R.canopy / 2, ch - 0.35, ez - 6, ex + R.canopy / 2, ch, ez + 6, WHITE_C);
    for (const sz of [-5.4, 5.4]) post(Tr, ox, y0 - 0.2, ez + sz, 0.12, 0.12, ch - 0.35 - y0 + 0.2, STEEL, 8);
    // the roof sign: a white fin along the slab's middle with the name on both faces
    const [mx, mz] = pt((ro + ri) / 2, 0), sy0 = y0 + top + 0.4, sy1 = y0 + top + 5.1, sw = 12.5;
    slab(Tr, mx - 1, y0 + top, mz - sw - 0.5, mx + 1, y0 + top + 5.5, mz + sw + 0.5, END);
    const sign = TX.textSign('Kimchibleau', { bg: '#f6f3ec', fg: '#d6402b', w: 1024, h: 192, serif: true, size: 150 });
    const sm = matte({ map: sign, emissiveMap: sign, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.05 });
    nightSet.push([sm, 'emissiveIntensity', 0.05, 1.3]);
    const S = new Builder(), UV = [[0, 0], [1, 0], [1, 1], [0, 1]];
    S.quad([mx + 1.05, sy0, mz + sw], [mx + 1.05, sy0, mz - sw], [mx + 1.05, sy1, mz - sw], [mx + 1.05, sy1, mz + sw], UV);      // east (ocean) face
    S.quad([mx - 1.05, sy0, mz - sw], [mx - 1.05, sy0, mz + sw], [mx - 1.05, sy1, mz + sw], [mx - 1.05, sy1, mz - sw], UV);      // west face
    finish('deco_resort', [[Wf, wall], [Tr, M.paint], [Gl, M.glass], [S, sm, { cast: false }]], [cx - ro - 2, cz - 40, cx - rp + R.canopy + 2, cz + 40]);
  }

  // ---------- the Rickenbacker's white arch ----------
  function rickenbackerArch(T) {
    if (bridgesBuilt) return;                        // roads3d's arch
    const hit = roadAt(net, T.x, T.z, T.road);
    if (!hit) return;
    const e = hit.e, halfW = e.halfW / PX, half = (T.span || 60) / 2, H = T.h || 14, B = new Builder();
    const pts = (sd) => {
      const out = [];
      for (let i = 0; i <= 24; i++) {
        const u = -half + (2 * half * i) / 24, p = edgeAt(e, hit.s + u * PX), w = halfW + 1.0;
        out.push([p.x - p.tz * w * sd, p.y + 0.6 + H * (1 - (u / half) ** 2), p.z + p.tx * w * sd, p]);
      }
      return out;
    };
    const ribs = [pts(-1), pts(1)];
    for (const rib of ribs) {
      for (let i = 0; i < rib.length - 1; i++) bar(B, rib[i], rib[i + 1], 1.1, 1.3, '#f7f7f2');
      for (let i = 2; i < rib.length - 2; i += 2) {
        const [x, y, z, p] = rib[i];
        rod(B, [x, y, z], [x, p.y + 0.9, z], 0.07, '#e9e9e4', 4);
      }
    }
    for (const i of [8, 12, 16]) bar(B, ribs[0][i], ribs[1][i], 0.5, 0.6, '#f7f7f2');
    for (const rib of ribs) for (const i of [0, 24]) { const [x, y, z] = rib[i]; slab(B, x - 1.2, y - 2.5, z - 1.2, x + 1.2, y + 0.4, z + 1.2, col(CONCRETE)); }
    const c = edgeAt(e, hit.s);
    finish('rickenbacker_arch', [[B, M.paint]], around(c.x, c.z, half + 6), { far: SMALL_FAR + 600 });
  }

  // ---------- the Venetian bascule houses ----------
  function basculeHouses(T) {
    if (bridgesBuilt) return;                        // roads3d's houses
    const B = new Builder(), R = B;
    let box = null;
    for (const [x, z] of Array.isArray(T.at) ? T.at : []) {
      const hit = roadAt(net, x, z, T.bridge);
      if (!hit) continue;
      const e = hit.e, c = edgeAt(e, hit.s), w = e.halfW / PX + (e.walkR || 0) / PX + 2.6, a = Math.atan2(c.tz, c.tx);
      const hx = c.x - c.tz * w, hz = c.z + c.tx * w, F = frame(hx, c.y, hz, a);
      B.setMatrix(F);
      slab(B, -2.4, SEA - c.y - 1, -1.9, 2.4, -0.1, 1.9, col(CONCRETE));        // the pier
      slab(B, -2.6, -0.1, -2.1, 2.6, 0.1, 2.1, col('#cfc7b8'));
      slab(B, -2.0, 0.1, -1.6, 2.0, 3.3, 1.6, col('#f7f1e3'));
      for (const sx of [-1, 1]) slab(B, sx * 2.0 - 0.02, 1.2, -0.9, sx * 2.0 + 0.02, 2.5, 0.9, col('#2a7f8a'));
      slab(B, -0.9, 1.2, -1.62, 0.9, 2.5, -1.58, col('#2a7f8a'));
      R.geo(new THREE.ConeGeometry(3.3, 1.5, 4), mat4(0, 4.05, 0, 0, Math.PI / 4, 0, 1, 1, 0.82), col('#d06a3a'));
      const b = [hx - 4, hz - 4, hx + 4, hz + 4];
      box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b;
    }
    B.setMatrix(null);
    if (box) finish('venetian_bascules', [[B, M.paint]], box, { far: SMALL_FAR });
  }

  // ---------- Kimchi One: the parked jet, in 4 meshes ----------
  function jet(T) {
    const pl = world.places?.[T.place || 'jet']?.plane;
    if (!pl) return;
    const x = pl.x / PX, z = pl.y / PX, F = frame(x, gy(x, z) + 0.04, z, pl.a);
    const body = new Builder().setMatrix(F), metal = new Builder().setMatrix(F), dark = new Builder().setMatrix(F), decal = new Builder().setMatrix(F);
    const R = 1.2, len = 13, yc = 2.1, W = col('#f5f5f3'), GOLD = col('#d4af37'), GREY = col('#b9bcc2'), BLACK = col('#15171c');
    const put = (B, geo, c, px, py, pz, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => B.geo(geo, mat4(px, py, pz, rx, ry, rz, sx, sy, sz), c);
    put(body, new THREE.CylinderGeometry(R, R, len, 22), W, 0, yc, 0, 0, 0, Math.PI / 2);
    put(body, new THREE.SphereGeometry(R, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2), W, len / 2, yc, 0, 0, 0, -Math.PI / 2, 1, 2.3, 1);
    // the tail cone narrows to the rear and sweeps up a little (the grid city's jet has it the other way round)
    put(body, new THREE.CylinderGeometry(R * 0.3, R, 5.2, 22), W, -len / 2 - 2.6, yc + 2.6 * Math.sin(0.06), 0, 0, 0, Math.PI / 2 - 0.06);
    put(dark, new THREE.BoxGeometry(0.9, 0.3, 1.5), BLACK, len / 2 + 0.9, yc + 0.62, 0, 0, 0, -0.45);
    const wing = new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(1.7, 0), new THREE.Vector2(-1.8, 0), new THREE.Vector2(-3.6, 9.4), new THREE.Vector2(-2.3, 9.4)]), { depth: 0.22, bevelEnabled: false });
    wing.rotateX(Math.PI / 2);
    for (const s of [-1, 1]) {
      for (let i = 0; i < 7; i++) put(dark, new THREE.CylinderGeometry(0.17, 0.17, 0.06, 12), BLACK, -len / 2 + 2.2 + i * 1.35, yc + 0.32, s * (R - 0.01), Math.PI / 2);
      put(metal, new THREE.BoxGeometry(len + 3, 0.1, 0.03), GOLD, -0.6, yc - 0.12, s * (R + 0.002));
      put(metal, new THREE.CylinderGeometry(0.62, 0.52, 3.3, 18), GREY, -len / 2 - 0.6, yc + 0.75, s * (R + 0.8), 0, 0, Math.PI / 2);
      put(dark, new THREE.CylinderGeometry(0.5, 0.5, 0.06, 18), col('#2a2b2e'), -len / 2 + 1.07, yc + 0.75, s * (R + 0.8), 0, 0, Math.PI / 2);
      put(body, new THREE.BoxGeometry(1.2, 0.2, 0.7), W, -len / 2 - 0.6, yc + 0.6, s * (R + 0.25));
      // the wing (the left one mirrored: setMatrix turns its triangles round)
      body.setMatrix(new THREE.Matrix4().multiplyMatrices(F, new THREE.Matrix4().makeScale(1, 1, s)));
      body.geo(wing, mat4(-0.6, yc - 0.7, 0), W);
      body.setMatrix(F);
      put(body, new THREE.BoxGeometry(1.1, 1.3, 0.12), W, -3.2, yc - 0.1, s * 9.35, 0, 0, 0.3);
    }
    const fin = new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(-0.9, 0), new THREE.Vector2(1.7, 0), new THREE.Vector2(0.1, 3.9), new THREE.Vector2(-1.3, 3.9)]), { depth: 0.24, bevelEnabled: false });
    fin.translate(0, 0, -0.12);
    put(body, fin, W, -len / 2 - 3.6, yc + 0.7, 0);
    put(body, new THREE.BoxGeometry(1.6, 0.16, 7.2), W, -len / 2 - 4.9, yc + 4.55, 0);
    put(metal, new THREE.BoxGeometry(1.5, 0.5, 0.26), GOLD, -len / 2 - 3.9, yc + 2.6, 0);
    for (const [gx, gz] of [[len / 2 - 0.8, 0], [-1.2, 1.5], [-1.2, -1.5]]) {
      put(dark, new THREE.CylinderGeometry(0.34, 0.34, 0.3, 14), col('#2a2b2e'), gx, 0.34, gz, Math.PI / 2);
      put(metal, new THREE.BoxGeometry(0.12, yc - 1, 0.12), GREY, gx, (yc - 1) / 2 + 0.6, gz);
    }
    // the airstair onto a red carpet, aluminium cases waiting
    const doorX = len / 2 - 2.6;
    for (let i = 0; i < 7; i++) put(body, new THREE.BoxGeometry(0.95, 0.08, 0.32), W, doorX, yc - 0.55 - i * 0.24, -R - 0.18 - i * 0.3);
    for (const s of [-1, 1]) put(body, new THREE.BoxGeometry(0.05, 0.6, 2.4), W, doorX + s * 0.5, yc - 1.1, -R - 1.1, -0.68);
    put(body, new THREE.BoxGeometry(1.4, 0.02, 7), col('#9b111a'), doorX, 0.02, -R - 5.6);
    for (const [dx, dz, hgt] of [[1.3, -R - 3.2, 0.72], [1.75, -R - 3.25, 0.62], [1.5, -R - 3.9, 0.5]]) put(metal, new THREE.BoxGeometry(0.45, hgt, 0.26), GREY, doorX + dx, hgt / 2 + 0.02, dz);
    // the name on both sides
    for (const s of [-1, 1]) {
      const zz = s * (R + 0.015), x0 = 1.6 - 1.8, x1 = 1.6 + 1.8, y0 = yc + 0.38, y1 = yc + 1.06;
      if (s > 0) decal.quad([x0, y0, zz], [x1, y0, zz], [x1, y1, zz], [x0, y1, zz], [[0, 0], [1, 0], [1, 1], [0, 1]]);
      else decal.quad([x1, y0, zz], [x0, y0, zz], [x0, y1, zz], [x1, y1, zz], [[0, 0], [1, 0], [1, 1], [0, 1]]);
    }
    const tag = TX.textSign('KIMCHI ONE', { bg: '#f5f5f3', fg: 'gold', serif: true, size: 70, w: 512, h: 96 });
    finish('kimchi_one', [[body, M.gloss], [metal, M.metal], [dark, M.paint], [decal, matte({ map: tag }), { cast: false }]], around(x, z, 14), { far: SMALL_FAR });
  }

  // ---------- once a frame ----------
  let lastN = -1;
  return {
    update(t = 0, night = 0) {
      time.value = t;
      M.led.userData.glow.value = 1.05 + 1.55 * night;
      if (Math.abs(night - lastN) > 0.002) {
        lastN = night;
        for (const [m, prop, d, n] of nightSet) m[prop] = d + (n - d) * night;
        for (const m of glows) if (m) setGlow(m, night);
        for (const s of nightOnly) s.visible = night > 0.08;
      }
      // the aircraft lights blink
      setGlow(M.beacon, night, Math.sin(t * 5.2) > -0.2 ? 1 : 0.12);
      for (const f of anim) f(t, night);
    },
    stats() { return { landmarks: built.map(b => b.id), meshes: built.reduce((s, b) => s + b.meshes.length, 0) }; },
    built,
  };
}

// ---------- the KIMCHI letters' shapes (metres at 18 m tall; k scales them; their widths are prefabs.js's) ----------

const LETTER = {
  K: { pts: [[0, 0], [3.6, 0], [3.6, 6.6], [8.2, 0], [12.4, 0], [5.9, 9.3], [12, 18], [7.9, 18], [3.6, 11.8], [3.6, 18], [0, 18]] },
  I: { pts: [[0, 0], [4.2, 0], [4.2, 18], [0, 18]] },
  M: { pts: [[0, 0], [3.6, 0], [3.6, 11.4], [6.4, 4.4], [8.6, 4.4], [11.4, 11.4], [11.4, 0], [15, 0], [15, 18], [11.4, 18], [7.5, 8.8], [3.6, 18], [0, 18]] },
  H: { pts: [[0, 0], [3.6, 0], [3.6, 7.3], [8.4, 7.3], [8.4, 0], [12, 0], [12, 18], [8.4, 18], [8.4, 10.7], [3.6, 10.7], [3.6, 18], [0, 18]] },
  C: { pts: null },
};
function letterShape(c, k) {
  const L = LETTER[c];
  if (L.pts) return new THREE.Shape(L.pts.map(([x, y]) => new THREE.Vector2(x * k, y * k)));
  // C: an open ring, outer and inner ellipses, open toward the right
  const pts = [], cx = 6.4, cy = 9, a0 = 0.72, a1 = Math.PI * 2 - 0.72;
  for (let i = 0; i <= 20; i++) { const a = a0 + (a1 - a0) * (i / 20); pts.push(new THREE.Vector2((cx + Math.cos(a) * 6.2) * k, (cy + Math.sin(a) * 9) * k)); }
  for (let i = 20; i >= 0; i--) { const a = a0 + (a1 - a0) * (i / 20); pts.push(new THREE.Vector2((cx + Math.cos(a) * 2.6) * k, (cy + Math.sin(a) * 5.4) * k)); }
  return new THREE.Shape(pts);
}
