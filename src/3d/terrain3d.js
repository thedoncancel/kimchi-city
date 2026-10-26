// The Kimchi Key v2 ground in 3D (docs/map-v2-spec.md §11.1 Terrain): the TERRAIN raster (2 m vertices, the
// natural ground and sea bed, 0.20 m under the roads) cut into the chunk manager's 256 m tiles.
//
//  - The colour, on both grids: the painted far albedo (src/map/mapimage.js farAlbedo) repainted from the ground
//    cover (src/map/terrain.js groundCover): tended lawn round what is built, wild grass from lush to straw with
//    the hills, crests and the big patches, bare earth, limestone on cliffs, cuttings and steep slopes, beach
//    sand going wet at the waterline, the Glades' sawgrass and mud. So the land reads the same from the air as
//    underfoot, and far roads, beaches and districts read from the hills. Its alpha is how wet the ground is.
//  - LOD1, every tile: an 8 m grid. Built up front; about 2,000 triangles a tile, drawn 2 x 2 tiles to a mesh.
//  - LOD0, near the camera: the 2 m grid (129 x 129 vertices a tile) with a vertex splat (grass, sand, rock,
//    dirt, paved) that picks the detail painted over the albedo: grass blades and clumps and pitted limestone
//    made here, and the Poly Haven sand and concrete photos toned down to luminance, tiled every 6 m. Rock also
//    covers anything steep and is projected from the side there, so cut faces never stretch, and lies in beds
//    near the camera. Wet sand and mud shine. Built on demand within LOD0_R (+ a margin ahead of the camera)
//    and dropped again far behind it, so only about 20 tiles of it exist at once.
//  - Both are lit with Lambert plus the sky's light added by hand (terrainMaterial says why).
//
// Each tile shows exactly one of its two grids: LOD0 from LOD0_R in, LOD1 from LOD0_R + 20 m out, and the one
// it had in between (one state per tile, so they never overlap and never leave a hole). Both have skirts that
// hang below their edges, so where a fine tile meets a coarse one the step between them is closed. Quads that
// lie wholly under the (opaque) sea are left out of both, and tiles with no land at all are not built.
//
// buildTerrain3D(world, chunks, { albedo, light }) -> { update(camera, dt), buildAround(xm, zm, r), setAlbedo(canvas),
// stats(), heightAt(xm, zm), materials, textures, tiles, cover (the ground cover it paints from, for the plants;
// made after the first frame, or on first read) }.
// Each tile's group (its 2 m grid) and each block's 8 m mesh go to chunks.add (layer 'terrain', drawn at any
// distance, never casting). update() runs once a frame before the scene is drawn.
import * as THREE from 'three';
import { HIGH, LOW } from './quality.js';
import { TILE } from './chunks.js';
import * as TX from './textures.js';
import { groundCover, COVER_RGB } from '../map/terrain.js';

const STEP = 2;                  // m between TERRAIN vertices
const Q0 = TILE / STEP;          // 128 quads a side at LOD0
const K1 = 4;                    // LOD1 keeps every 4th vertex (8 m)
const SKIRT = 3;                 // m a skirt hangs below its edge, plus how far the coarse edge strays there
export const LOD0_R = LOW ? 250 : 350;   // m from the camera to a tile within which it shows its 2 m grid
const LOD_HYST = 20;             // m further out before it goes back to the 8 m grid
const AHEAD = 70;                // m: LOD0 is built this far beyond LOD0_R (more ahead when moving), so it is ready
const KEEP = 160;                // m beyond LOD0_R a built LOD0 is kept before it may be dropped
const MAX_LOD0 = 24;             // built LOD0 tiles kept at most (about 0.7 MB each)
const BUILD_MS = 4;              // ms a frame may spend building LOD0 tiles while driving
const JUMP = 60;                 // m in a frame: a teleport, so everything needed is built at once
const UNDER = -2.2;              // m: quads entirely below this lie under the opaque sea and are never drawn
const DETAIL_M = 6;              // m: the detail photos repeat this often (world UV 1/6 m)
const FAR_BLOCK = 2;             // tiles a side whose 8 m grids are drawn as one mesh

// SURF kinds (src/map/raster.js KIND) and the splat channel each one paints: 0 sand, 1 rock, 2 dirt, 3 paved,
// -1 grass (whose own share of limestone and bare earth comes from the ground cover). Under water, shallows and
// decks the ground is dirt: where it shows above the water (a bank, a fill's flank, a marsh rim) toneAlbedo
// paints it stone or mud. Water well above the sea and the ponds (POOL_UP) is a pool's floor, paved.
const SPLAT_OF = [3, 3, -1, 3, 3, 3, 2, 0, 2, 2, 2, 1, -1, -1, -1, -1];
const POOL_UP = 3;               // m above the sea
const K_GRASS = 2, K_WATER = 6, K_SAND = 7, K_DIRT = 8, K_SHALLOW = 9, K_DECK = 10, K_ROCK = 11;

// ---------- the shared look ----------

// GLSL shared by both grids, so they match where they meet. The albedo already holds the ground's colours
// (limestone on the steep, wet sand and mud), lifted a little toward the game's cartoon palette here; its
// alpha is the wetness the sheen below reads. Where the mesh itself is steep (its own normal: the 2 m grid
// shows cut faces the 4 m cover only half sees) the face turns further to limestone, keeping some of the
// albedo's variation.
const SAT = 1.08, ROCK = '#907b60';     // (a warm limestone: a grey one turns mauve in the haze)
const COMMON = /* glsl */`
uniform sampler2D tAlbedo;
uniform vec2 uWorld;
uniform vec3 uRock;
varying vec3 vTPos;
varying vec3 vTNrm;
float tLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 terrainBase(out float steep, out float wet) {
  vec4 a = texture2D(tAlbedo, vTPos.xz / uWorld);
  vec3 c = max(mix(vec3(tLuma(a.rgb)), a.rgb, ${SAT.toFixed(2)}), 0.0);
  // slopes past about 25 degrees (cliffs, cuttings, the flanks of fills)
  steep = smoothstep(0.9, 0.68, vTNrm.y);
  c = mix(c, uRock * mix(1.0, clamp(tLuma(c) / tLuma(uRock), 0.6, 1.4), 0.5), steep * 0.55);
  wet = a.a * (1.0 - steep);
  return c;
}`;

// LOD0 paints the detail over the base: one fetch gives all four detail maps (R grass, G sand, B paved,
// A limestone, each a luminance around 0.5; bare earth mixes the sand's grain with the stone's pits), and rock
// takes two more from the sides where the ground is steep. A second fetch, larger and turned, breaks up the 6 m
// repeat. Grass blades shift hue as well as brightness, and near the camera limestone lies in wavering beds.
// Past 90 m the detail fades out into the albedo, and the fetches stop where their share has faded (the side-on
// rock and the large one past DETAIL_NEAR, all of it past DETAIL_FAR): the 2 m grid reaches 600 m and more, and
// most of its pixels are far. The texture derivatives are taken before those branches, so the mip choice stays
// right at their edges.
const DETAIL_NEAR = 170, DETAIL_FAR = 280;
const SPLAT = /* glsl */`
uniform sampler2D tDetail;
varying vec4 vTSplat;
vec3 terrainDetail(vec3 c, float steep, float dist) {
  vec2 uv = vTPos.xz / ${DETAIL_M.toFixed(1)}, uvE = mat2(0.8, -0.6, 0.6, 0.8) * vTPos.xz / ${(DETAIL_M * 3.83).toFixed(2)} + 0.31;
  vec2 uvX = vTPos.zy / ${(DETAIL_M * 1.5).toFixed(1)}, uvZ = vTPos.xy / ${(DETAIL_M * 1.5).toFixed(1)};
  vec2 dx = dFdx(uv), dy = dFdy(uv), dxE = dFdx(uvE), dyE = dFdy(uvE), dxX = dFdx(uvX), dyX = dFdy(uvX), dxZ = dFdx(uvZ), dyZ = dFdy(uvZ);
  float bedW = fwidth(vTPos.y) * 1.1;     // (the beds' size on screen, for their seams)
  if (dist > ${DETAIL_FAR.toFixed(1)}) return c;
  float near = 1.0 - smoothstep(${(DETAIL_NEAR - 50).toFixed(1)}, ${DETAIL_NEAR.toFixed(1)}, dist);
  vec4 d = textureGrad(tDetail, uv, dx, dy);
  float sand = vTSplat.x, rock = clamp(vTSplat.y + steep, 0.0, 1.0), dirt = vTSplat.z, paved = vTSplat.w;
  float grass = max(0.0, 1.0 - sand - rock - dirt - paved);
  float sum = max(1e-3, grass + sand + dirt + paved + rock);
  // rock on steep ground: projected from the sides too, so cut faces never stretch
  float r = d.a;
  if (steep > 0.02 && near > 0.0) {
    vec3 w = pow(abs(normalize(vTNrm)), vec3(4.0)); w /= (w.x + w.y + w.z);
    r = d.a * w.y + textureGrad(tDetail, uvX, dxX, dyX).a * w.x + textureGrad(tDetail, uvZ, dxZ, dyZ).a * w.z;
    r = mix(d.a, r, near);
  }
  float k = (grass * d.r + sand * d.g + dirt * mix(d.g, d.a, 0.45) + paved * d.b + rock * r) / sum * 2.0;
  if (near > 0.0) {
    vec4 e = textureGrad(tDetail, uvE, dxE, dyE);
    float m = (grass * e.r + sand * e.g + dirt * mix(e.g, e.a, 0.45) + paved * e.b + rock * e.a) / sum;
    k *= mix(1.0, m * 2.0, 0.6 * near);
  }
  float fade = smoothstep(90.0, ${DETAIL_FAR.toFixed(1)}, dist);
  vec3 f = vec3(mix(k, 1.0, fade));
  // grass blades: the light ones yellower and the dark ones bluer, as in a real lawn
  float gb = (d.r - 0.5) * 2.0 * grass / sum * (1.0 - fade);
  f *= vec3(1.0 + 0.1 * gb, 1.0 + 0.02 * gb, 1.0 - 0.16 * gb);
  // limestone beds: layers about 0.9 m thick that waver across the face, each its own shade and warmth,
  // blending into the next over its top eighth, with a thin dark seam under each (antialiased, and gone by
  // 90 m, where it would only shimmer)
  float rk = rock / sum * near * (1.0 - fade);
  if (rk > 0.01) {
    float yy = vTPos.y * 1.1 + sin(vTPos.x * 0.21 + vTPos.z * 0.05) * 0.8 + sin(vTPos.z * 0.17 - vTPos.x * 0.04) * 0.6;
    float layer = floor(yy), fr = yy - layer, t = smoothstep(0.86, 1.0, fr);
    vec2 h = fract(sin(vec2(layer, layer + 1.0) * 12.9898) * 43758.55), q = fract(h * 7.31);
    float shade = mix(h.x, h.y, t), warm = mix(q.x, q.y, t);
    float seam = (1.0 - smoothstep(0.0, 0.06 + bedW, fr)) * (1.0 - smoothstep(40.0, 90.0, dist));
    f *= (1.0 + rk * (shade - 0.5) * 0.45) * (1.0 - rk * seam * 0.3) * mix(vec3(1.0), vec3(1.08, 1.0, 0.86), rk * warm);
  }
  return c * f;
}`;

// The terrain is a large share of every frame's pixels, so it is lit with Lambert on both tiers (the full
// MeshStandard loop measured about 4 ms more on an M1 for the same picture). On the high tier it gets back what
// MeshStandard took from the sky's lighting map: a fill of the sky's colour (makeSkyLight's env, from the haze,
// the hemisphere light and environmentIntensity each frame), and on wet sand a sheen of the haze at grazing
// angles. The point and spot lights (lamps, headlights, the police light) light it while any of them is on;
// while they are all off (the day) it skips them (lampGate), which was 1.5-3 ms of a headless frame.
function terrainMaterial(lod0, albedoTex, detailTex, light) {
  const m = new THREE.MeshLambertMaterial();
  const uniforms = {
    tAlbedo: { value: albedoTex }, uWorld: { value: new THREE.Vector2(1, 1) }, uRock: { value: new THREE.Color(ROCK) }, tDetail: { value: detailTex },
    uSkyFill: light.env, uSkySheen: light.sheen, uSkyTint: light.haze, uKcLamps: light.lamps,
  };
  m.userData.terrain = uniforms;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = (lod0 ? 'attribute vec4 splat;\nvarying vec4 vTSplat;\n' : '') + 'varying vec3 vTPos;\nvarying vec3 vTNrm;\n' +
      sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        // the tiles stand at the origin, so these are world coordinates
        vTPos = position; vTNrm = normal;${lod0 ? '\n        vTSplat = splat;' : ''}`);
    sh.fragmentShader = COMMON + (lod0 ? SPLAT : '') + '\nuniform vec3 uSkyFill, uSkySheen, uSkyTint;\nuniform bool uKcLamps;\n' + sh.fragmentShader
      .replace('#include <lights_fragment_begin>', lampGate(THREE.ShaderChunk.lights_fragment_begin))
      .replace('#include <map_fragment>', `
        float tSteep, tWet;
        vec3 tCol = terrainBase(tSteep, tWet);
        ${lod0 ? 'tCol = terrainDetail(tCol, tSteep, length(vViewPosition));' : ''}
        diffuseColor.rgb *= tCol;`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        // the sky's own light (the high tier's lighting map), its faint sheen, and wet sand mirroring the haze
        reflectedLight.indirectDiffuse += diffuseColor.rgb * uSkyFill;
        float tFres = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 4.0);
        reflectedLight.indirectDiffuse += uSkySheen * (0.6 + 1.4 * tFres) + uSkyTint * tFres * tWet * 0.45;`);
  };
  m.customProgramCacheKey = () => (lod0 ? 'kc-terrain0' : 'kc-terrain1');
  return m;
}

// three's direct-lighting chunk with its point- and spot-light loops run only while uKcLamps is set (a uniform,
// so switching costs nothing and the shader never recompiles). If the chunk is not the shape this expects (a
// newer three), it is left as it is.
function lampGate(chunk) {
  const P = '#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )\n', S = '#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )\n';
  const D = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )\n', END = '\t#pragma unroll_loop_end\n#endif\n';
  const p = chunk.indexOf(P), sp = chunk.indexOf(S), d = chunk.indexOf(D);
  if (p < 0 || sp < p || d < sp || chunk.slice(sp - END.length, sp) !== END || chunk.slice(d - END.length, d) !== END) return chunk;
  const gate = (body) => body.slice(0, -'#endif\n'.length).replace(/^(#if[^\n]*\n)/, '$1if ( uKcLamps ) {\n') + '}\n#endif\n';
  return chunk.slice(0, p) + gate(chunk.slice(p, sp)) + gate(chunk.slice(sp, d)) + chunk.slice(d);
}

// The detail maps, packed: R grass (made here: soft clumps and short blades, with no big blotches, so its 6 m
// repeat does not print a pattern across a lawn), G the sand photo, B the concrete photo, A limestone (made
// here: mottled, pitted and cracked like the Keys' coral rock). Each channel is that picture's luminance,
// rescaled so its mean is 0.5 and its spread is `contrast`; until the photos load (and in node, where nothing
// decodes) their channels stay 0.5, which leaves the albedo as it is. The two made here (about 40 ms) wait for
// paintDetail, after the first frame.
const DETAIL_SIZE = 512;
const DETAIL_SRC = [
  { make: grassLuma, contrast: 0.42 },
  { url: 'assets/tex/sand.jpg', contrast: 0.5 },
  { url: 'assets/tex/concrete.jpg', contrast: 0.45 },
  { make: rockLuma, contrast: 0.52 },
];
function detailTexture() {
  const S = DETAIL_SIZE, data = new Uint8Array(S * S * 4).fill(128);
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true; tex.anisotropy = TX.ANISO;
  tex.needsUpdate = true;
  DETAIL_SRC.forEach((src, ch) => {
    if (src.make) return;
    if (typeof document === 'undefined' || typeof createImageBitmap === 'undefined') return;
    fetch(src.url).then(r => (r.ok ? r.blob() : Promise.reject(new Error(src.url)))).then(b => createImageBitmap(b)).then((img) => {
      const c = document.createElement('canvas');
      c.width = c.height = S;
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0, S, S);
      img.close?.();
      const px = x.getImageData(0, 0, S, S).data, lum = new Float32Array(S * S);
      for (let i = 0; i < lum.length; i++) lum[i] = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
      packLuma(lum, data, ch, src.contrast);
      tex.needsUpdate = true;
    }).catch(() => {});
  });
  return tex;
}
// the detail channels made here, into the packed detail texture
function paintDetail(tex) {
  DETAIL_SRC.forEach((src, ch) => { if (src.make) packLuma(src.make(DETAIL_SIZE), tex.image.data, ch, src.contrast); });
  tex.needsUpdate = true;
}
// a luminance picture into channel ch of the packed detail, centred on 0.5 with the given spread
function packLuma(lum, out, ch, contrast) {
  const n = lum.length;
  let sum = 0, sum2 = 0;
  for (let i = 0; i < n; i++) { sum += lum[i]; sum2 += lum[i] * lum[i]; }
  const mean = sum / n, sd = Math.sqrt(Math.max(1e-9, sum2 / n - mean * mean)), k = (contrast * 0.25 * 255) / sd;
  for (let i = 0; i < n; i++) {
    const v = 128 + (lum[i] - mean) * k;
    out[i * 4 + ch] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
}
// The grass detail, tiling: value noise over four octaves (clumps from about 0.75 m down to 10 cm) and a few
// thousand short blades, light and dark, at random angles.
function grassLuma(S) {
  const L = new Float32Array(S * S), rnd = mulberry(7);
  addOctaves(L, S, rnd, [[8, 0.45], [16, 0.3], [32, 0.2], [64, 0.12]]);
  for (let k = 0; k < 5000; k++) {
    const x0 = rnd() * S, y0 = rnd() * S, ang = rnd() * Math.PI * 2, len = 4 + rnd() * 9, dv = (rnd() < 0.5 ? -1 : 1) * (0.12 + rnd() * 0.18);
    for (let t = 0; t < len; t++) {
      const x = ((Math.round(x0 + Math.cos(ang) * t) % S) + S) % S, y = ((Math.round(y0 + Math.sin(ang) * t) % S) + S) % S;
      L[y * S + x] += dv * (1 - t / len * 0.5);
    }
  }
  return L;
}
// The limestone detail, tiling: mottled value noise from 13 cm to 1.5 m, a few hundred pits and holes with a
// pale lip (the porous coral rock of the Keys), and dark hairline cracks that wander.
function rockLuma(S) {
  const L = new Float32Array(S * S), rnd = mulberry(11), wrap = (v) => ((v % S) + S) % S;
  addOctaves(L, S, rnd, [[4, 0.5], [8, 0.34], [16, 0.24], [32, 0.16], [64, 0.1]]);
  for (let k = 0; k < 450; k++) {
    const cx = rnd() * S, cy = rnd() * S, r = 1.5 + rnd() ** 3 * 8, depth = 0.15 + rnd() * 0.25, R = Math.ceil(r * 1.4);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const q = (dx * dx + dy * dy) / (r * r), o = wrap(Math.round(cy) + dy) * S + wrap(Math.round(cx) + dx);
      if (q < 1) L[o] -= depth * (1 - q);
      else if (q < 1.96) L[o] += 0.06 * (1.96 - q);
    }
  }
  for (let k = 0; k < 70; k++) {
    let x = rnd() * S, y = rnd() * S, ang = rnd() * Math.PI * 2;
    const len = 30 + rnd() * 110, dark = 0.18 + rnd() * 0.22;
    for (let t = 0; t < len; t++) {
      ang += (rnd() - 0.5) * 0.5;
      x += Math.cos(ang); y += Math.sin(ang);
      L[wrap(Math.round(y)) * S + wrap(Math.round(x))] -= dark * (1 - t / len * 0.6);
    }
  }
  return L;
}
// Tiling value noise into L (S×S): octaves of [lattice cells across, amplitude], smoothly interpolated.
function addOctaves(L, S, rnd, octaves) {
  for (const [cells, amp] of octaves) {
    const lat = Float32Array.from({ length: cells * cells }, () => rnd()), step = S / cells;
    for (let y = 0; y < S; y++) {
      const fy = y / step, j = Math.floor(fy), ty = fy - j, sy = ty * ty * (3 - 2 * ty), j0 = (j % cells) * cells, j1 = ((j + 1) % cells) * cells;
      for (let x = 0; x < S; x++) {
        const fx = x / step, i = Math.floor(fx), tx = fx - i, sx = tx * tx * (3 - 2 * tx), i0 = i % cells, i1 = (i + 1) % cells;
        const a = lat[j0 + i0] + (lat[j0 + i1] - lat[j0 + i0]) * sx, b = lat[j1 + i0] + (lat[j1 + i1] - lat[j1 + i0]) * sx;
        L[y * S + x] += (a + (b - a) * sy) * amp;
      }
    }
  }
}
function mulberry(a) {
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- the far albedo, as the terrain wants it ----------

// The painted far albedo (src/map/mapimage.js farAlbedo: 2 m a pixel, RGBA) repainted for the ground, in place:
//  - Natural ground (grass, sand, dirt, rock) is painted from the ground cover (src/map/terrain.js
//    groundCover, sampled at each pixel): wild grass from lush through dry to straw, sawgrass, tended lawn (the
//    golf course in stripes), mud, bare earth and limestone on grass; sand going wet toward the waterline;
//    stone and earth, each mottled by the cover's tone. Built ground (roads, walks, lots, plazas, buildings)
//    keeps the map's colours.
//  - Water and shallows are never seen through the opaque sea and ponds, so wherever such ground does stand
//    above them (a bank above the waterline, a fill's flank, a pool's floor) it is painted as that ground
//    would be: stone on the coast, mud in the marsh around the ponds, pale tiles where it lies POOL_UP above
//    the sea.
//  - Decks are painted as the ground around them (their own colour belongs to the deck meshes over them).
//  - The ground is a little darker on steep slopes and in hollows and lighter on crests, and its brightness
//    drifts about 12% over 150-450 m, so the big hills read as shaped ground rather than one flat colour.
//  - Alpha is how wet the ground is (wet sand, mud), which the shader turns into a sheen; 0 elsewhere.
// Pure grass stays within -38%..+28% of the map's own grass brightness. cover: groundCover(world), made once
// per world when not given.
const SHORE_RGB = [166, 154, 130], POOL_RGB = [192, 208, 210];
const covers = new WeakMap();
export function coverOf(world) {
  let c = covers.get(world.grids);
  if (!c) covers.set(world.grids, c = groundCover(world));
  return c;
}
export function toneAlbedo(world, px, W, H, cover = coverOf(world)) {
  const G = world.grids, [SW] = G.dims.surf, surf = G.surf, [VW, VH] = G.dims.terrain, T = G.terrain;
  const k = Math.round(SW / W), cell = G.w / W;            // SURF cells across a pixel, metres a pixel
  // the marsh: within 20 m of a pond's shapes
  const ponds = (world.water?.bodies || []).flatMap(b => b.shapes.map((sh) => {
    const [cx, cz] = sh.line ? sh.line[0] : sh.circle || sh.ellipse, [ex, ez] = sh.line ? sh.line[1] : [cx, cz];
    const r = (sh.line ? sh.w / 2 : Math.max(sh.r ?? 0, sh.rx ?? 0, sh.rz ?? 0)) + 20;
    return [Math.min(cx, ex) - r, Math.min(cz, ez) - r, Math.max(cx, ex) + r, Math.max(cz, ez) + r];
  }));
  const marshAt = (x, z) => ponds.some(b => x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]);
  const deck = new Uint8Array(W * H);
  // slow noise: value noise on a lattice m metres across, smoothly interpolated
  const lattice = (m, seed) => {
    const nx = Math.ceil(G.w / m) + 2, nz = Math.ceil(G.h / m) + 2, rnd = mulberry(seed);
    const v = Float32Array.from({ length: nx * nz }, () => rnd() * 2 - 1);
    return (x, z) => {
      const fx = x / m, fz = z / m, i = Math.floor(fx), j = Math.floor(fz), u = fx - i, w = fz - j, su = u * u * (3 - 2 * u), sw = w * w * (3 - 2 * w);
      const a = v[j * nx + i] + (v[j * nx + i + 1] - v[j * nx + i]) * su, b = v[(j + 1) * nx + i] + (v[(j + 1) * nx + i + 1] - v[(j + 1) * nx + i]) * su;
      return a + (b - a) * sw;
    };
  };
  // brightness and warmth (stone and earth toward iron-stained) sampled every 8 pixels (16 m) and blended
  const big = lattice(450, 21), mid = lattice(150, 22), hue = lattice(230, 23), NB = 8, nw = Math.ceil(W / NB) + 1, nh = Math.ceil(H / NB) + 1;
  const nLum = new Float32Array(nw * nh), nHue = new Float32Array(nw * nh);
  for (let b = 0; b < nh; b++) for (let a = 0; a < nw; a++) {
    const x = a * NB * cell, z = b * NB * cell;
    nLum[b * nw + a] = big(x, z) * 0.65 + mid(x, z) * 0.35;
    nHue[b * nw + a] = hue(x, z);
  }
  const P = COVER_RGB, CW = cover.w, CH = cover.h, CC = cover.cell, here = new Float32Array(9);
  const fields = [cover.lawn, cover.dry, cover.lush, cover.bare, cover.rock, cover.marsh, cover.wet, cover.tone, cover.brown];
  const gC = new Float32Array(3), rC = new Float32Array(3), sC = new Float32Array(3), dC = new Float32Array(3), lC = new Float32Array(3);
  const vk = Math.max(1, Math.round(cell / STEP)), R = Math.round(12 / STEP);   // TERRAIN vertices a pixel; the hollow test reaches 12 m
  const hAt = (i, j) => T[(j < 0 ? 0 : j >= VH ? VH - 1 : j) * VW + (i < 0 ? 0 : i >= VW ? VW - 1 : i)];
  for (let j = 0; j < H; j++) {
    const bj = Math.floor(j / NB), tj = (j % NB) / NB, vj = j * vk, inZ = vj - R >= 0 && vj + R < VH;
    const fz = Math.min(Math.max((j + 0.5) * cell / CC - 0.5, 0), CH - 1.001), cb = Math.floor(fz), cv = fz - cb;
    for (let i = 0; i < W; i++) {
      let wet = 0, dk = 0, grass = 0, sand = 0, dirt = 0, rock = 0;
      for (let b = 0; b < k; b++) for (let a = 0; a < k; a++) {
        const q = surf[(j * k + b) * SW + i * k + a] & 15;
        if (q === K_WATER || q === K_SHALLOW) wet++;
        else if (q === K_DECK) dk++;
        else if (q === K_GRASS) grass++; else if (q === K_SAND) sand++; else if (q === K_DIRT) dirt++; else if (q === K_ROCK) rock++;
      }
      const o = (j * W + i) * 4, n = k * k, nat = grass + sand + dirt + rock;
      px[o + 3] = 0;
      if (wet) {
        const c = marshAt((i + 0.5) * cell, (j + 0.5) * cell) ? P.mud : T[Math.min(VH - 1, j * vk) * VW + i * vk] > world.SEA_LEVEL + POOL_UP ? POOL_RGB : SHORE_RGB, f = wet / n;
        for (let ch = 0; ch < 3; ch++) px[o + ch] += (c[ch] - px[o + ch]) * f;
      }
      if (dk) deck[j * W + i] = Math.round(dk / n * 255);
      if (!nat) continue;
      const sum0 = px[o] + px[o + 1] + px[o + 2];
      // the cover here, bilinear between its 4 m cells
      const fx = Math.min(Math.max((i + 0.5) * cell / CC - 0.5, 0), CW - 1.001), ca = Math.floor(fx);
      coverAt(fields, cb * CW + ca, CW, fx - ca, cv, here);
      const lawn = here[0], dry = here[1], lush = here[2], bare = here[3], stone = here[4], marsh = here[5], wetness = here[6], tone = here[7] * 2 - 1, brown = here[8];
      const golf = cover.golf[Math.round(fz) * CW + Math.round(fx)];
      const bi = Math.floor(i / NB), ti = (i % NB) / NB, nq = bj * nw + bi;
      const H0 = nHue[nq] + (nHue[nq + 1] - nHue[nq]) * ti, H1 = nHue[nq + nw] + (nHue[nq + nw + 1] - nHue[nq + nw]) * ti, warm = Math.max(0, H0 + (H1 - H0) * tj);
      // limestone: cream where fresh, weathered and iron-stained in places, and laid in beds (strata); earth
      // likewise warm, so the haze never turns a cutting or an eroded bank grey or mauve from the air
      set3(rC, P.rock); mix3(rC, P.rockDark, 0.12 + 0.22 * tone); mix3(rC, P.rockWarm, 0.2 + 0.5 * warm);
      if (stone > 0.02 || rock) strata(rC, (i + 0.5) * cell, (j + 0.5) * cell, T[Math.min(VH - 1, j * vk) * VW + Math.min(VW - 1, i * vk)]);
      set3(dC, P.dirt); scale3(dC, 0.93 + 0.12 * tone); mix3(dC, P.rockWarm, 0.1 + warm * 0.25); mix3(dC, P.mud, marsh * 0.6);
      // wild grass; the Glades' dark hammocks and golden sawgrass; the tended lawn as it is kept (the golf
      // course in stripes); mud, bare earth and the stone showing through
      set3(gC, P.meadow); mix3(gC, P.lush, lush); mix3(gC, P.dry, Math.min(1, dry * 1.1)); mix3(gC, P.straw, smooth01((dry - 0.62) / 0.38) * 0.75);
      mix3(gC, P.hammock, smooth01((lush - 0.6) / 0.4) * (1 - Math.min(1, marsh * 1.5)));
      mix3(gC, P.marsh, marsh * 1.4);
      lawnColour(lC, brown); mix3(lC, P.lawnDry, Math.max(0, dry - 0.5) * 0.5);
      if (golf) scale3(lC, golf > 127 ? 1.07 : 0.93);
      mix3(gC, lC, lawn); scale3(gC, 1 + 0.06 * tone);
      mix3(gC, P.mud, wetness);
      mix3(gC, dC, bare); mix3(gC, rC, stone);
      // sand, drier inland, wet toward the water
      set3(sC, P.sandDry); mix3(sC, P.sand, 0.55 + 0.35 * tone); mix3(sC, P.wetSand, wetness);
      const f = nat / n;
      for (let ch = 0; ch < 3; ch++) {
        const c = (grass * gC[ch] + sand * sC[ch] + dirt * dC[ch] + rock * rC[ch]) / nat;
        px[o + ch] += (c - px[o + ch]) * f;
      }
      // (mud shines less than wet sand)
      px[o + 3] = Math.round(wetness * f * (sand + 0.5 * grass) / nat * 255);
      // the shape of the ground: slope over 4 m, and how far it stands above the ground 12 m round it
      const vi = i * vk, v = vj * VW + vi;
      let slope, rise;
      if (inZ && vi - R >= 0 && vi + R < VW) {
        const dx = T[v + 1] - T[v - 1], dz = T[v + VW] - T[v - VW];
        slope = Math.sqrt(dx * dx + dz * dz) / (2 * STEP);
        rise = T[v] - (T[v - R] + T[v + R] + T[v - R * VW] + T[v + R * VW]) / 4;
      } else {
        slope = Math.hypot(hAt(vi + 1, vj) - hAt(vi - 1, vj), hAt(vi, vj + 1) - hAt(vi, vj - 1)) / (2 * STEP);
        rise = hAt(vi, vj) - (hAt(vi - R, vj) + hAt(vi + R, vj) + hAt(vi, vj - R) + hAt(vi, vj + R)) / 4;
      }
      const L0 = nLum[nq] + (nLum[nq + 1] - nLum[nq]) * ti, L1 = nLum[nq + nw] + (nLum[nq + nw + 1] - nLum[nq + nw]) * ti;
      let lum = 1 - 0.14 * smooth01((slope - 0.05) / 0.3) + Math.max(-0.09, Math.min(0.09, rise * 0.05)) + f * 0.12 * (L0 + (L1 - L0) * tj);
      // pure grass keeps within the map's own range of brightness
      if (grass === n) {
        const r = lum * (px[o] + px[o + 1] + px[o + 2]) / Math.max(1, sum0);
        if (r > 1.28) lum *= 1.28 / r; else if (r < 0.62) lum *= 0.62 / r;
      }
      px[o] *= lum; px[o + 1] *= lum; px[o + 2] *= lum;
    }
  }
  // decks: the mean of the ground within 6 m that is not deck
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const f = deck[j * W + i];
    if (!f) continue;
    const sum = [0, 0, 0];
    let cnt = 0;
    for (let b = -3; b <= 3; b++) for (let a = -3; a <= 3; a++) {
      const ii = i + a, jj = j + b;
      if (ii < 0 || jj < 0 || ii >= W || jj >= H || deck[jj * W + ii]) continue;
      const q = (jj * W + ii) * 4;
      sum[0] += px[q]; sum[1] += px[q + 1]; sum[2] += px[q + 2]; cnt++;
    }
    const o = (j * W + i) * 4, c = cnt ? sum.map(v => v / cnt) : SHORE_RGB;
    for (let ch = 0; ch < 3; ch++) px[o + ch] += (c[ch] - px[o + ch]) * (f / 255);
  }
  return px;
}
// A tended lawn's colour by how it is kept (the cover's brown): watered or shaded, mown, browning, scorched.
function lawnColour(o, b) {
  const P = COVER_RGB;
  if (b < 0.35) { set3(o, P.lawnLush); mix3(o, P.lawn, b / 0.35); } else if (b < 0.7) { set3(o, P.lawn); mix3(o, P.lawnDry, (b - 0.35) / 0.35); } else { set3(o, P.lawnDry); mix3(o, P.lawnBurnt, (b - 0.7) / 0.3); }
}
// Limestone beds for the far albedo, in place on the rock colour o at (x, z) m and height y: layers about 3 m
// thick (the near shader lays thinner ones over them) wavering across the face, each its own shade and
// warmth, with a darker seam under each. Thick enough to read on the 2 m albedo from the air.
function strata(o, x, z, y) {
  const yy = y / 3.2 + Math.sin(x * 0.021 + z * 0.005) * 0.5 + Math.sin(z * 0.017 - x * 0.004) * 0.4, layer = Math.floor(yy), fr = yy - layer;
  const h = Math.sin(layer * 12.9898) * 43758.55, h1 = h - Math.floor(h), h2 = (h1 * 7.31) % 1;
  scale3(o, (0.84 + 0.3 * h1) * (fr < 0.14 ? 0.8 + 1.43 * fr : 1));
  mix3(o, COVER_RGB.rockWarm, 0.35 * h2);
}
// the cover's fields (0..255) at cell q plus (u, v) of the way to the next ones, as 0..1 into out
function coverAt(fields, q, CW, u, v, out) {
  const w00 = (1 - u) * (1 - v), w10 = u * (1 - v), w01 = (1 - u) * v, w11 = u * v;
  for (let k = 0; k < fields.length; k++) {
    const f = fields[k];
    out[k] = (f[q] * w00 + f[q + 1] * w10 + f[q + CW] * w01 + f[q + CW + 1] * w11) / 255;
  }
}
function set3(o, c) { o[0] = c[0]; o[1] = c[1]; o[2] = c[2]; }
function mix3(o, c, t) { if (t <= 0) return; if (t > 1) t = 1; o[0] += (c[0] - o[0]) * t; o[1] += (c[1] - o[1]) * t; o[2] += (c[2] - o[2]) * t; }
function scale3(o, k) { o[0] *= k; o[1] *= k; o[2] *= k; }
function smooth01(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }

// ---------- the sky's light, for the materials that add it by hand ----------

// The scene's sun (or moon) and sky, read once a frame from its shadow-casting directional light, its
// hemisphere light, its fog colour (the haze) and environmentIntensity (how much the sky's lighting map lights
// MeshStandard things on the high tier), as uniforms the terrain and the water share:
//   dir, sun   the light's direction (toward it) and colour times intensity
//   sky        a level surface's fill as MeshStandard gives it: the hemisphere's irradiance over pi, plus the
//              lighting map's radiance (about the sky's colour between the haze and the zenith)
//   env        the lighting map's part alone (Lambert already has the hemisphere light)
//   sheen      the sky's colour a rough surface still mirrors (MeshStandard's faint blue cast), more so low down
//   haze       the fog colour, which water and wet sand mirror at grazing angles
//   lamps      whether any point or spot light (lamps, headlights, the police light, a muzzle flash) is on
export function makeSkyLight() {
  const u = (c) => ({ value: c });
  const L = { dir: u(new THREE.Vector3(0, 1, 0)), sun: u(new THREE.Color(1, 1, 1)), sky: u(new THREE.Color(0.3, 0.35, 0.4)),
    env: u(new THREE.Color(0, 0, 0)), sheen: u(new THREE.Color(0, 0, 0)), haze: u(new THREE.Color(0.7, 0.8, 0.9)), lamps: u(true) };
  let sun = null, hemi = null, root = null, wait = 0, lamps = [];
  const tmp = new THREE.Color();
  // obj: anything in the scene. The lights are looked for again every 2 s or so, so ones added later count.
  L.update = (obj) => {
    if (wait-- <= 0 || (sun && !sun.parent)) {
      root = obj; while (root.parent) root = root.parent;
      sun = null; hemi = null; lamps = [];
      root.traverse?.((o) => {
        if (!sun && o.isDirectionalLight && o.castShadow) sun = o;
        if (!hemi && o.isHemisphereLight) hemi = o;
        if (o.isPointLight || o.isSpotLight) lamps.push(o);
      });
      wait = sun ? 120 : 60;
    }
    L.lamps.value = lamps.some(l => l.intensity > 0 && l.visible && l.parent);
    if (!sun) return;
    L.dir.value.subVectors(sun.position, sun.target.position).normalize();
    L.sun.value.copy(sun.color).multiplyScalar(sun.intensity);
    if (root.fog) L.haze.value.copy(root.fog.color);
    const envK = HIGH && root.environment ? (root.environmentIntensity ?? 1) : 0;
    L.env.value.copy(L.haze.value).lerp(hemi ? hemi.color : L.haze.value, 0.75).multiplyScalar(envK);
    L.sheen.value.copy(hemi ? hemi.color : L.haze.value).multiplyScalar(0.045 * envK);
    L.sky.value.copy(L.env.value);
    if (hemi) L.sky.value.add(tmp.copy(hemi.color).multiplyScalar(hemi.intensity / Math.PI));
  };
  return L;
}

// ---------- the grids ----------

export function buildTerrain3D(world, chunks, { albedo = null, light = null } = {}) {
  const G = world.grids, [VW, VH] = G.dims.terrain, H = G.terrain, surf = G.surf, SW = G.dims.surf[0], SH = G.dims.surf[1];
  // The ground cover (about 60-170 ms) and the detail made here (about 40 ms) come after the first frame
  // (ready: from setAlbedo, or a timer), off the page's load. Until then the fine grids splat no limestone or
  // earth on grass, and the grass and limestone detail is flat; ready() then re-splats the ones built.
  let cover = null;
  // The far albedo (setAlbedo), toned for the ground with its wetness in alpha, so a DataTexture (a canvas
  // would premultiply the alpha away); until it comes, one meadow-green texel.
  const albedoTex = new THREE.DataTexture(new Uint8Array([...COVER_RGB.meadow, 0]), 1, 1);
  albedoTex.colorSpace = THREE.SRGBColorSpace;
  albedoTex.flipY = false;                 // row 0 is the north edge, z = 0
  albedoTex.wrapS = albedoTex.wrapT = THREE.ClampToEdgeWrapping;
  albedoTex.magFilter = THREE.LinearFilter; albedoTex.minFilter = THREE.LinearMipmapLinearFilter;
  albedoTex.generateMipmaps = true;
  albedoTex.anisotropy = TX.ANISO;
  albedoTex.needsUpdate = true;
  const detailTex = detailTexture();
  const sky = light || makeSkyLight(), ownLight = !light;
  const materials = { lod0: terrainMaterial(true, albedoTex, detailTex, sky), lod1: terrainMaterial(false, albedoTex, detailTex, sky) };
  for (const m of Object.values(materials)) m.userData.terrain.uWorld.value.set(G.w, G.h);

  const hAt = (i, j) => H[(j < 0 ? 0 : j >= VH ? VH - 1 : j) * VW + (i < 0 ? 0 : i >= VW ? VW - 1 : i)];
  const TX_N = (VW - 1) / Q0, TZ_N = (VH - 1) / Q0;

  // How far a coarse edge strays from the fine one along each 8 m stretch of every tile edge line: the skirts
  // of both grids hang that much further, so the step where they meet is always closed.
  const strayX = new Float32Array(VH * ((VW - 1) / K1)), strayZ = new Float32Array(VW * ((VH - 1) / K1));
  const SXW = (VW - 1) / K1, SZH = (VH - 1) / K1;
  for (let j = 0; j < VH; j += Q0) for (let s = 0; s < SXW; s++) strayX[j * SXW + s] = stray((t) => hAt(s * K1 + t, j));
  for (let i = 0; i < VW; i += Q0) for (let s = 0; s < SZH; s++) strayZ[i * SZH + s] = stray((t) => hAt(i, s * K1 + t));
  function stray(at) {
    const a = at(0), b = at(K1);
    let m = 0;
    for (let t = 1; t < K1; t++) m = Math.max(m, Math.abs(at(t) - (a + (b - a) * t / K1)));
    return m;
  }
  // the skirt depth at vertex (i, j) of an edge running along x (j fixed) or along z (i fixed)
  const skirtX = (i, j) => SKIRT + Math.max(strayX[j * SXW + Math.min(SXW - 1, Math.floor(i / K1))], i % K1 === 0 && i > 0 ? strayX[j * SXW + i / K1 - 1] : 0);
  const skirtZ = (i, j) => SKIRT + Math.max(strayZ[i * SZH + Math.min(SZH - 1, Math.floor(j / K1))], j % K1 === 0 && j > 0 ? strayZ[i * SZH + j / K1 - 1] : 0);

  const tiles = [];
  for (let tz = 0; tz < TZ_N; tz++) for (let tx = 0; tx < TX_N; tx++) {
    const i0 = tx * Q0, j0 = tz * Q0;
    let top = -Infinity;
    for (let j = j0; j <= j0 + Q0; j++) for (let i = i0; i <= i0 + Q0; i++) { const h = H[j * VW + i]; if (h > top) top = h; }
    if (top <= UNDER) continue;           // open sea: nothing of this tile shows above the water
    const key = `${tx},${tz}`, group = new THREE.Group();
    group.name = `terrain ${key}`;
    // (the tile's 8 m grid is drawn through its block's merged mesh, below; this one keeps its shape and its
    // visible flag, which says whether the tile shows it)
    const lod1 = new THREE.Mesh(gridGeometry(i0, j0, K1, false), materials.lod1);
    lod1.receiveShadow = true;
    lod1.name = `lod1 ${key}`;
    const box = [i0 * STEP, j0 * STEP, (i0 + Q0) * STEP, (j0 + Q0) * STEP];
    tiles.push({ key, tx, tz, i0, j0, box, group, lod1, lod0: null, lod: 1, used: 0, d: Infinity, top, far: null, farIdx: null });
    chunks?.add(group, { tile: key, layer: 'terrain' });
  }

  // The 8 m grids are drawn FAR_BLOCK x FAR_BLOCK tiles to a mesh: one draw call where there were up to four (the
  // renderer is bound by draw calls more than by triangles: about 30 of a view's calls were coarse tiles). Each
  // block's index holds the tiles that show their 8 m grid now, rewritten when one switches (a few times a
  // minute while driving, about 0.1 ms); the blocks are still culled to the camera's view one by one.
  const blocks = new Map();
  for (const t of tiles) {
    const k = `${Math.floor(t.tx / FAR_BLOCK)},${Math.floor(t.tz / FAR_BLOCK)}`;
    if (!blocks.has(k)) blocks.set(k, { key: k, tiles: [], mesh: null, idx: null, dirty: true });
    blocks.get(k).tiles.push(t);
  }
  for (const b of blocks.values()) {
    let nv = 0, ni = 0;
    for (const t of b.tiles) { nv += t.lod1.geometry.attributes.position.count; ni += t.lod1.geometry.index.count; }
    const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3);
    let v = 0;
    for (const t of b.tiles) {
      const g = t.lod1.geometry, n = g.attributes.position.count, src = g.index.array;
      pos.set(g.attributes.position.array, v * 3); nrm.set(g.attributes.normal.array, v * 3);
      t.farIdx = new Uint32Array(src.length);
      for (let k = 0; k < src.length; k++) t.farIdx[k] = src[k] + v;
      t.far = b;
      v += n;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    b.idx = new THREE.BufferAttribute(new Uint32Array(ni), 1).setUsage(THREE.DynamicDrawUsage);
    g.setIndex(b.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    b.mesh = new THREE.Mesh(g, materials.lod1);
    b.mesh.receiveShadow = true;
    b.mesh.name = `lod1 block ${b.key}`;
    chunks?.add(b.mesh, { layer: 'terrain' });
  }
  // a block's index: the 8 m grids of its tiles that show them, back to back
  function rewriteBlock(b) {
    const a = b.idx.array;
    let n = 0;
    for (const t of b.tiles) if (t.lod1.visible) { a.set(t.farIdx, n); n += t.farIdx.length; }
    b.mesh.geometry.setDrawRange(0, n);
    b.mesh.visible = n > 0;
    if (n > 0) { b.idx.clearUpdateRanges(); b.idx.addUpdateRange(0, n); b.idx.needsUpdate = true; }
    b.dirty = false;
  }

  // One tile's grid, every k-th vertex: positions in world metres, normals from the raster (over the same
  // span as the grid, so the coarse grid shades as smoothly as it is shaped), the splat on the fine grid, and
  // the skirts. Quads with every vertex under the sea are left out of the index.
  function gridGeometry(i0, j0, k, splat) {
    const n = Q0 / k + 1, nv = n * n + 4 * n;
    const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), spl = splat ? new Uint8Array(nv * 4) : null;
    const low = new Uint8Array(n * n);     // 1 where the vertex is under UNDER
    const skirtSrc = new Uint16Array(4 * n);   // the edge vertex each skirt vertex repeats (for resplat)
    let v = 0;
    for (let b = 0; b < n; b++) for (let a = 0; a < n; a++, v++) {
      const i = i0 + a * k, j = j0 + b * k, y = hAt(i, j);
      pos[v * 3] = i * STEP; pos[v * 3 + 1] = y; pos[v * 3 + 2] = j * STEP;
      normalAt(i, j, k, nrm, v * 3);
      if (spl) splatAt(i, j, spl, v * 4);
      low[v] = y <= UNDER ? 1 : 0;
    }
    // a quad is kept when any of the fine vertices under it is above water (a thin spit survives the 8 m grid)
    const keep = new Uint8Array((n - 1) * (n - 1));
    for (let b = 0; b < n - 1; b++) for (let a = 0; a < n - 1; a++) {
      let any = !(low[b * n + a] && low[b * n + a + 1] && low[(b + 1) * n + a] && low[(b + 1) * n + a + 1]);
      if (!any && k > 1) {
        for (let jj = 0; jj <= k && !any; jj++) for (let ii = 0; ii <= k; ii++) if (hAt(i0 + a * k + ii, j0 + b * k + jj) > UNDER) { any = true; break; }
      }
      keep[b * (n - 1) + a] = any ? 1 : 0;
    }
    const idx = [];
    for (let b = 0; b < n - 1; b++) for (let a = 0; a < n - 1; a++) {
      if (!keep[b * (n - 1) + a]) continue;
      const p = b * n + a;
      idx.push(p, p + n, p + 1, p + 1, p + n, p + n + 1);
    }
    // skirts: the edge vertices again, lowered, with the edge's normal and splat, facing out of the tile
    const edges = [
      { at: (s) => [s, 0], out: [0, -1], quad: (s) => keep[s] },                                  // north
      { at: (s) => [s, n - 1], out: [0, 1], quad: (s) => keep[(n - 2) * (n - 1) + s] },           // south
      { at: (s) => [0, s], out: [-1, 0], quad: (s) => keep[s * (n - 1)] },                        // west
      { at: (s) => [n - 1, s], out: [1, 0], quad: (s) => keep[s * (n - 1) + n - 2] },             // east
    ];
    for (const e of edges) {
      const first = v;
      for (let s = 0; s < n; s++, v++) {
        const [a, b] = e.at(s), src = b * n + a, i = i0 + a * k, j = j0 + b * k;
        skirtSrc[v - n * n] = src;
        const depth = e.out[1] !== 0 ? skirtX(i, j) : skirtZ(i, j);
        pos[v * 3] = pos[src * 3]; pos[v * 3 + 1] = pos[src * 3 + 1] - depth; pos[v * 3 + 2] = pos[src * 3 + 2];
        nrm.copyWithin(v * 3, src * 3, src * 3 + 3);
        if (spl) spl.copyWithin(v * 4, src * 4, src * 4 + 4);
      }
      for (let s = 0; s < n - 1; s++) {
        if (!e.quad(s)) continue;
        const [a0, b0] = e.at(s), [a1, b1] = e.at(s + 1);
        const t0 = b0 * n + a0, t1 = b1 * n + a1, s0 = first + s, s1 = first + s + 1;
        // (t0, t1, s0) faces out when (t1 - t0) x (s0 - t0) points along `out`
        const dx = pos[t1 * 3] - pos[t0 * 3], dz = pos[t1 * 3 + 2] - pos[t0 * 3 + 2];
        const outward = (-dz) * e.out[0] + dx * e.out[1] < 0;    // (dx,0,dz) x (0,-1,0) = (dz, 0, -dx)
        if (outward) idx.push(t0, t1, s0, t1, s1, s0); else idx.push(t0, s0, t1, t1, s0, s1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    if (spl) { g.setAttribute('splat', new THREE.BufferAttribute(spl, 4, true)); g.userData.skirtSrc = skirtSrc; }
    g.setIndex(nv < 65536 ? new THREE.Uint16BufferAttribute(idx, 1) : new THREE.Uint32BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  // the raster's normal at vertex (i, j), from the heights k vertices either side
  function normalAt(i, j, k, out, o) {
    const dx = (hAt(i + k, j) - hAt(i - k, j)) / (2 * k * STEP), dz = (hAt(i, j + k) - hAt(i, j - k)) / (2 * k * STEP);
    const l = Math.hypot(dx, 1, dz);
    out[o] = -dx / l; out[o + 1] = 1 / l; out[o + 2] = -dz / l;
  }
  // The share of each splat channel among the four 1 m SURF cells that meet at vertex (i, j). Grass brings the
  // ground cover's limestone (rock) and bare earth or mud (dirt) there, once the cover is made.
  function splatAt(i, j, out, o) {
    const c = [0, 0, 0, 0], pool = hAt(i, j) > world.SEA_LEVEL + POOL_UP;
    let stone = -1, earth = 0;
    for (let dz = -1; dz <= 0; dz++) for (let dx = -1; dx <= 0; dx++) {
      const x = Math.min(SW - 1, Math.max(0, 2 * i + dx)), z = Math.min(SH - 1, Math.max(0, 2 * j + dz)), q = surf[z * SW + x] & 15;
      const ch = pool && q === K_WATER ? 3 : SPLAT_OF[q];
      if (ch >= 0) { c[ch]++; continue; }
      if (q !== K_GRASS || !cover) continue;
      if (stone < 0) {
        // the cover at the vertex, bilinear between its cells' centres
        const CW = cover.w, CH = cover.h, CK = STEP / cover.cell, fx = Math.min(Math.max(i * CK - 0.5, 0), CW - 1.001), fz = Math.min(Math.max(j * CK - 0.5, 0), CH - 1.001);
        const a = Math.floor(fx), b = Math.floor(fz), u = fx - a, v = fz - b, p = b * CW + a;
        const at = f => ((f[p] * (1 - u) + f[p + 1] * u) * (1 - v) + (f[p + CW] * (1 - u) + f[p + CW + 1] * u) * v) / 255;
        stone = at(cover.rock);
        earth = Math.min(1 - stone, Math.max(at(cover.bare), at(cover.wet)));     // (wet grass is the marsh's mud)
      }
      c[1] += stone; c[2] += earth;
    }
    for (let q = 0; q < 4; q++) out[o + q] = Math.round(c[q] * 63.75);
  }

  // the fine grid's splat again, once the cover is here
  function resplat(g, t) {
    const n = Q0 + 1, a = g.attributes.splat, spl = a.array, src = g.userData.skirtSrc;
    for (let b = 0; b < n; b++) for (let c = 0; c < n; c++) splatAt(t.i0 + c, t.j0 + b, spl, (b * n + c) * 4);
    for (let s = 0; s < src.length; s++) spl.copyWithin((n * n + s) * 4, src[s] * 4, src[s] * 4 + 4);
    a.needsUpdate = true;
  }
  // the cover and the detail made here, then the splat of the fine grids already built (about 0.2 s, once)
  function ready() {
    if (cover) return cover;
    cover = coverOf(world);
    paintDetail(detailTex);
    for (const t of tiles) if (t.lod0) resplat(t.lod0.geometry, t);
    return cover;
  }
  if (typeof window !== 'undefined') setTimeout(ready, 0);

  // ---------- which grid each tile shows ----------

  const cam = { x: 0, z: 0, vx: 0, vz: 0, have: false };
  let built = 0, builds = 0, drops = 0, buildMs = 0, frame = 0;
  const boxDist = (b, x, z) => Math.hypot(x < b[0] ? b[0] - x : x > b[2] ? x - b[2] : 0, z < b[1] ? b[1] - z : z > b[3] ? z - b[3] : 0);

  function buildLod0(t) {
    const t0 = performance.now();
    const m = new THREE.Mesh(gridGeometry(t.i0, t.j0, 1, true), materials.lod0);
    m.receiveShadow = true;
    m.name = `lod0 ${t.key}`;
    m.visible = false;
    t.group.add(m);
    t.lod0 = m;
    built++; builds++;
    buildMs = performance.now() - t0;
  }
  function dropLod0(t) {
    t.group.remove(t.lod0);
    t.lod0.geometry.dispose();
    t.lod0 = null;
    built--; drops++;
    if (t.lod === 0) t.lod = 1;
  }
  function show(t) {
    const fine = t.lod === 0 && !!t.lod0;
    if (t.lod0 && t.lod0.visible !== fine) t.lod0.visible = fine;
    if (t.lod1.visible === fine) { t.lod1.visible = !fine; t.far.dirty = true; }
  }
  function showAll() {
    for (const t of tiles) show(t);
    for (const b of blocks.values()) if (b.dirty) rewriteBlock(b);
  }

  function update(camera, dt = 1 / 60) {
    frame++;
    if (ownLight && tiles.length) sky.update(tiles[0].group);   // (a shared light is updated by its owner)
    const p = camera.position;
    const jumped = !cam.have || Math.hypot(p.x - cam.x, p.z - cam.z) > JUMP;
    if (cam.have && !jumped && dt > 0) {
      const k = 1 - Math.exp(-dt * 4);
      cam.vx += ((p.x - cam.x) / dt - cam.vx) * k; cam.vz += ((p.z - cam.z) / dt - cam.vz) * k;
    } else { cam.vx = 0; cam.vz = 0; }
    cam.x = p.x; cam.z = p.z; cam.have = true;
    // where the camera will be in 2 s: tiles near there are built first
    const ax = p.x + cam.vx * 2, az = p.z + cam.vz * 2;
    let next = null, nextDa = Infinity;
    for (const t of tiles) {
      t.d = boxDist(t.box, p.x, p.z);
      const da = Math.min(t.d, boxDist(t.box, ax, az));
      if (t.lod === 1 && t.d < LOD0_R) t.lod = 0;
      else if (t.lod === 0 && t.d > LOD0_R + LOD_HYST) t.lod = 1;
      if (t.lod0) { if (t.d <= LOD0_R + KEEP) t.used = frame; }
      else if (da < LOD0_R + AHEAD && da < nextDa) { next = t; nextDa = da; }
      if (jumped && !t.lod0 && t.d < LOD0_R) buildLod0(t);
    }
    // while driving, the nearest missing tile is built, a few a frame at most
    if (!jumped && next) {
      const t0 = performance.now();
      for (let guard = 0; next && guard < 4; guard++) {
        buildLod0(next);
        if (performance.now() - t0 > BUILD_MS) break;
        next = null;
        for (const t of tiles) if (!t.lod0 && t.d < LOD0_R + AHEAD && (!next || t.d < next.d)) next = t;
      }
    }
    // the cache: the farthest of the fine grids no longer needed (beyond KEEP) go first
    while (built > MAX_LOD0) {
      let worst = null;
      for (const t of tiles) if (t.lod0 && t.used !== frame && (!worst || t.d > worst.d)) worst = t;
      if (!worst) break;
      dropLod0(worst);
    }
    showAll();
  }

  // build the fine grid of every tile within r of (xm, zm) now (the spawn area, before the first frame)
  function buildAround(xm, zm, r) {
    let n = 0;
    for (const t of tiles) if (!t.lod0 && boxDist(t.box, xm, zm) < r) { buildLod0(t); n++; }
    return n;
  }

  function stats() {
    let fine = 0, coarse = 0, tris = 0;
    for (const t of tiles) {
      if (t.lod0?.visible) { fine++; tris += t.lod0.geometry.index.count / 3; }
      if (t.lod1.visible) { coarse++; tris += t.lod1.geometry.index.count / 3; }
    }
    return { tiles: tiles.length, lod0Built: built, lod0Shown: fine, lod1Shown: coarse, tris, builds, drops, lastBuildMs: Math.round(buildMs * 100) / 100 };
  }

  // the terrain mesh's own height at (xm, zm): bilinear TERRAIN, which is what LOD0 draws
  function heightAt(xm, zm) {
    const fx = Math.min(Math.max(xm / STEP, 0), VW - 1), fz = Math.min(Math.max(zm / STEP, 0), VH - 1);
    const i = Math.min(Math.floor(fx), VW - 2), j = Math.min(Math.floor(fz), VH - 2), u = fx - i, w = fz - j;
    return (hAt(i, j) * (1 - u) + hAt(i + 1, j) * u) * (1 - w) + (hAt(i, j + 1) * (1 - u) + hAt(i + 1, j + 1) * u) * w;
  }

  showAll();
  // the painted far albedo (a canvas, mapimage farAlbedo) in place of what the terrain had (cityV2 paints it just
  // after the first frame), toned for the ground (toneAlbedo)
  function setAlbedo(canvas) {
    if (!canvas?.getContext) return;
    const img = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    toneAlbedo(world, img.data, canvas.width, canvas.height, ready());
    albedoTex.image = { data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length), width: canvas.width, height: canvas.height };
    albedoTex.dispose();          // the GPU copy has the old size; three makes a new one
    albedoTex.needsUpdate = true;
  }
  if (albedo) setAlbedo(albedo);

  return {
    update, buildAround, setAlbedo, stats, heightAt, materials, tiles, textures: { albedo: albedoTex, detail: detailTex },
    get cover() { return ready(); },
  };
}
