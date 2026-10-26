// The Kimchi Key v2 roads in 3D (docs/map-v2-spec.md §4.5 and §11.1 Roads): what the RoadNet looks like up
// close. The far albedo paints every road on the terrain; this draws the real surfaces over it wherever the
// terrain shows its fine 2 m grid (terrain3d's LOD0_R, 350 m; 250 m on the phone tier).
//
//  - Ribbons: every edge's carriageway (asphalt), kerbs, sidewalks and verges, swept along the RoadNet's own
//    frames (their heights and banking) from one junction mouth to the next. The surface stands at the design
//    height, 0.20 m over the TERRAIN road bed the carve left under it; sidewalk tops 0.16 m higher (the raster's
//    CURB, so people stand on them; a slab tilts up at its outer edge where a lot's lawn comes up past it); the
//    outer edge of each verge is snapped 3 cm over the terrain mesh. A kerb with no sidewalk rolls its last
//    metre up, by 0.2 m at most, where the ground right past it stands too close; where it stands higher still
//    (a side road's fill at a steep T) a low stone kerb wall holds it back.
//  - Junctions: each node's mouths are cut back to where the kerbs meet plus a corner radius (6/9/12 m by
//    class, smaller where the carve's bed is narrower), and further where another road's bed reaches over the
//    carriageway; the corners are rounded with quadratic fillets and the outline is meshed in rings round a
//    centre it can all see, inside on the bed (TERRAIN + 0.20 m, which is GROUND where the physics has road,
//    lifted where a terrain vertex would come within 5 cm), with world-XZ texture coordinates. Corner
//    sidewalks follow the fillets; dead ends round off in a turning bulb.
//  - Paint: one vertex-coloured mesh a tile, 2 cm up with polygonOffset: centre, lane, edge and median lines by
//    class (dashes phased along the whole road, so they run on across junctions and tile borders), stop bars,
//    give-way teeth at the ring, zebra crossings where the walk graph crosses, and the priority road's lines
//    carried through its junctions. It fades into the asphalt from 100 to 140 m, so far lines never shimmer.
//  - Bridges (mapdata BRIDGES; coast3d builds the marina pier): decks with parapets, the Loop's Jersey barrier,
//    piers to the bed, the North Causeway's A-frame pylon and stays, the Rickenbacker's arch, the Venetian's
//    bascule houses and leaf joints. All the bridges are one group of two meshes on the 'bridges' layer, drawn
//    at any distance (they are landmarks), so the causeways never vanish over the water. landmarks3d sees that
//    layer and only adds the pylon's light. The abutment patches placeProps blocks beside the deck ends are
//    stone revetments, in the road tiles.
//  - W-beam guardrails (placeProps), stone walls at the foot of cuttings deeper than 3 m (meeting, not
//    crossing, at a T), the jump ramps with earth berms over the carve's mound, and kerbed islands down the
//    Loop's median where palms stand on it.
//
// Materials, shared by every tile and lit as the terrain is (Lambert with the sky's fill, the lamps' loops run
// only while a lamp is on): the asphalt (the city's texture, de-tiled); 'concrete' (sidewalk slabs with 2 m
// joints, tinted by vertex colour for kerbs, verges, medians, rails and ramps); 'stone' (the same photo without
// joints, for walls, revetments and the bridges); the paint; and the terrain's own fine material for the dirt
// tracks and fills, so they match the ground round them. A tile is at most 5 draw calls.
//
// buildRoads3D(world, chunks, mats): world is the world facade's namespace (roads is the RoadNet, grids the
// rasters); chunks is the city's chunk manager (each tile's group goes in with { tile, layer: 'roads', far:
// LOD0_R } and its paint on its own with a 150 m reach, the bridges with their box on a 'bridges' layer); mats
// is the city's shared material set (src/3d/cityV2.js sharedMaterials: asphalt, night(material, prop, day,
// night) and the terrain's materials). It returns { tiles, bridges, junctions, materials, ctx, stats() } (for
// the bench and the tests), or nothing without a chunk manager (or with ?roads=0, a dev switch for measuring
// the roads' cost).
import * as THREE from 'three';
import { TILE } from './chunks.js';
import { HIGH } from './quality.js';
import { LOD0_R } from './terrain3d.js';
import * as TX from './textures.js';
import { ROADS, ROAD_CLASSES, BRIDGES } from '../map/mapdata.js';

const PX = 16;                 // sim px per metre
const CURB_H = 0.16;           // m: sidewalk tops over the road (the raster's CURB for WALK and PLAZA)
const SNAP = 0.03;             // m: a verge's outer edge over the terrain mesh
const VERGE_RURAL = 0.9;       // m of gravel bevel past a shoulder, down to the terrain
const VERGE_WALK = 0.35;       // m of bevel past a sidewalk's outer edge
const UV_ASPHALT = 4;          // m per repeat of the asphalt (world UVs, like the grid's road tiles)
const UV_CONCRETE = 4;         // m per repeat of the concrete: its slab joints fall every 2 m
const LIFT = 0.02;             // m: paint over its surface
const PAINT_NEAR = 100, PAINT_FAR = 140;   // m: the paint fades into the asphalt between these
// A tile's ribbons are drawn exactly while its terrain shows the 2 m grid (terrain3d: within LOD0_R of the
// tile, back to the 8 m grid past LOD0_R + 20, the chunk manager's hysteresis too). Farther out the far
// albedo paints the road on the 8 m grid, which a ribbon 0.2 m over the fine grid would float over or sink in.
const ROAD_FAR = LOD0_R;
// A kerb without a sidewalk whose terrain stands too close (a lot's pad or a neighbouring road's cutting
// starts right past it) rolls its last ROLL metres of asphalt up to stay KERB_CLEAR over it, by ROLL_MAX at
// most: where the ground stands higher still, a low stone kerb wall (kerbWalls) holds it back.
const ROLL = 1.0, KERB_CLEAR = 0.06, ROLL_MAX = 0.2;
// Corner radii (spec §11.1: 6/9/12 m); a corner takes the smaller of its two roads'.
const CORNER_R = { hwy: 12, blvd: 12, ave: 9, coast: 9, country: 9, street: 6, ring: 6, switch: 6, dirt: 6, alley: 5 };
const MOUTH_MIN = 1.5;         // m: even a straight joint gets a small junction piece
const MOUTH_MAX = 40;          // m: no mouth is cut back further than this (nor past 45% of its edge)
const KERB_REACH = 60;         // m along each end the kerbs are searched for where they meet
const OPEN_COS = -0.985;       // ends this close to opposite carry the same kerb straight on
const OPEN_ANGLE = 170 * Math.PI / 180;    // corners wider than this get no fillet
const FILLET_MAX = 30;         // m: the longest fillet tangent
const RING_STEP = 5;           // m between the rings of a junction mesh
// Bridges
const PARAPET_W = 0.45, PARAPET_H = 1.0;   // m: the deck-edge parapets, standing just outside the deck
const SLAB = 1.5;              // m: deck slab depth
const PIER_STEP = 24;          // m between piers (the cable-stayed span says its own)
const JERSEY = [[0.3, 0], [0.2, 0.08], [0.12, 0.33], [0.08, 0.81]];   // half width, height: the safety shape
// Cut walls
const CUT_WALL = 3;            // m: a cutting deeper than this gets a stone wall at its foot
const WALL_MIN_RUN = 12;       // m: shorter runs are left as plain cut
// Revetments (the abutments' stone slopes): the run per metre of fall, and how far over the terrain they drape
const REVET_SLOPE = 1.5, DRAPE = 0.12;

// Vertex colours (sRGB hex; three converts them to linear), times a brightness: the concrete texture they
// tint is a mid grey photo, so a part meant to read white (the pylon, the stays, the arch) is lifted past 1.
const C = Object.fromEntries(Object.entries({
  walk: ['#fff3e2'], kerb: ['#e6dccb'], vergeWalk: ['#e8dfcf'], vergeRural: ['#cdbf9f'], median: ['#e9c9a5'],
  parapet: ['#f1ece2', 1.25], fascia: ['#efe8da', 1.2], soffit: ['#b9b2a6'], pier: ['#e8e0d0', 1.2], jersey: ['#eeeae2', 1.25],
  pylon: ['#ffffff', 1.55], stay: ['#ffffff', 1.6], arch: ['#ffffff', 1.6], rail: ['#d5dce2', 1.3], post: ['#9aa1a8', 1.1],
  stone: ['#f3e1bd', 1.2], cap: ['#f8ecd2', 1.25], house: ['#f6e1c0', 1.35], roof: ['#d2694a', 1.2], window: ['#4a86a8', 1.2],
  prom: ['#e4cfb0', 1.1], ramp: ['#c99560', 1.15],
  white: ['#f4f1e8'], yellow: ['#f2c230'], joint: ['#3a3c40'],
}).map(([k, [hex, b = 1]]) => [k, colorOf(hex, b)]));
function colorOf(hex, b = 1) { const c = new THREE.Color(hex); return [c.r * b, c.g * b, c.b * b]; }
const DIRT_SPLAT = [0, 0, 1], GRASS_SPLAT = [0, 0, 0];    // terrain splat (sand, rock, dirt) for the dirt tracks

export function buildRoads3D(world, chunks, mats) {
  if (!chunks || !world?.roads?.edges?.length || !world.grids?.terrain) return;
  // a dev switch for measuring what the roads cost (tools/s4b_bench.mjs): ?roads=0 leaves them out
  if (globalThis.location?.search && new URLSearchParams(globalThis.location.search).get('roads') === '0') return;
  const t0 = now(), phase = {};
  let tp = t0;
  const lap = (k) => { const t = now(); phase[k] = Math.round((t - tp) * 10) / 10; tp = t; };
  const ctx = makeContext(world);
  const materials = roadMaterials(mats);
  // tiles by a number (tx * 1000 + tz), the last one asked for kept at hand: most asks are for the same one
  const tiles = new Map();
  let lastN = -1, lastT = null;
  ctx.tileAt = (x, z) => {
    const tx = Math.floor(x / TILE), tz = Math.floor(z / TILE), n = tx * 1000 + tz;
    if (n === lastN) return lastT;
    let t = tiles.get(n);
    if (!t) tiles.set(n, t = { key: `${tx},${tz}`, asphalt: new Soup(), concrete: new Soup(), stone: new Soup(), paint: new Soup(), dirt: new Soup() });
    lastN = n; lastT = t;
    return t;
  };
  ctx.dirtOk = !!materials.dirt;
  lap('context');

  const junctions = planJunctions(ctx);
  lap('plan');
  for (const E of ctx.edges) edgeRibbons(ctx, E);
  lap('ribbons');
  for (const J of junctions) junctionMesh(ctx, J);
  for (const J of junctions) cornerPieces(ctx, J);
  lap('junctions');
  // the junctions' paint first: it says where each approach's stop bar or crossing is, which the lines stop at
  prepPaint(ctx, junctions);
  for (const J of junctions) junctionPaint(ctx, J);
  for (const E of ctx.edges) edgePaint(ctx, E);
  lap('paint');
  guardrails(ctx);
  kerbWalls(ctx);
  cutWalls(ctx);
  jumpRamps(ctx);
  lap('extras');
  const bridges = buildBridges(ctx);
  lap('bridges');
  const tBuild = now() - t0;

  // Meshes. Each tile's are one group on the 'roads' layer, drawn while its terrain shows the fine grid
  // (ROAD_FAR); the paint, faded into the asphalt by PAINT_FAR, is left out past PAINT_FAR + 10 m (its own
  // entry with that reach). The bridges are one group of two meshes drawn at any distance (two draw calls,
  // however many of them are in view).
  const out = [];
  let tris = 0;
  for (const t of tiles.values()) {
    const group = new THREE.Group();
    group.name = `roads ${t.key}`;
    const make = (soup, mat, o) => { if (!soup.m) return null; tris += soup.m / 3; return soup.mesh(mat, o); };
    for (const m of [make(t.asphalt, materials.asphalt, { color: false }), make(t.concrete, materials.concrete, { cast: true }),
      make(t.stone, materials.stone, { cast: true }),
      materials.dirt ? make(t.dirt, materials.dirt, { splat: true, uv: false }) : null]) if (m) group.add(m);
    watchNormal(group, materials.asphalt);
    const paint = make(t.paint, materials.paint, {});
    if (!group.children.length && !paint) continue;
    if (group.children.length) chunks.add(group, { tile: t.key, layer: 'roads', far: ROAD_FAR });
    if (paint) { paint.name = `paint ${t.key}`; chunks.add(paint, { tile: t.key, layer: 'roads', far: PAINT_FAR + 10 }); }
    out.push({ key: t.key, group, paint });
  }
  if (bridges.length) {
    const group = new THREE.Group(), A = new Soup(), Cc = new Soup(), box = [Infinity, Infinity, -Infinity, -Infinity];
    group.name = 'bridges';
    for (const b of bridges) {
      A.append(b.asphalt); Cc.append(b.stone);
      box[0] = Math.min(box[0], b.box[0]); box[1] = Math.min(box[1], b.box[1]); box[2] = Math.max(box[2], b.box[2]); box[3] = Math.max(box[3], b.box[3]);
    }
    if (A.m) { group.add(A.mesh(materials.asphalt, { color: false })); tris += A.m / 3; }
    if (Cc.m) { group.add(Cc.mesh(materials.stone, { cast: true })); tris += Cc.m / 3; }
    chunks.add(group, { box, layer: 'bridges' });
    for (const b of bridges) b.group = group;
  }
  const stats = {
    tiles: out.length, bridges: bridges.length, junctions: junctions.length,
    fallbacks: junctions.filter(J => J.fallback).length, tris: Math.round(tris), buildMs: Math.round(tBuild),
    meshMs: Math.round(now() - t0 - tBuild), phase,
  };
  return { tiles: out, bridges, junctions, materials, ctx, stats: () => stats };
}

const now = () => (globalThis.performance ? performance.now() : Date.now());

// the road asphalt checks for its normal map while a tile's asphalt is drawn, until it has it
function watchNormal(group, m) {
  const mesh = group.children.find(c => c.material === m);
  if (!HIGH || !mesh || !m.userData.follow) return;
  const none = mesh.onBeforeRender;
  mesh.onBeforeRender = () => { if (!m.userData.follow || m.userData.follow()) { delete m.userData.follow; mesh.onBeforeRender = none; } };
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

// ---------- materials ----------

// The roads are lit the way the terrain under them is (terrain3d: Lambert, plus the sky's light added by hand,
// with the lamps' light loops run only while a lamp is on), so the two match where they meet, and the large
// share of the screen a road takes costs less than MeshStandard would. The asphalt is the city's own texture
// (its normal map follows once loaded); the concrete is the grid's sidewalk with its saw-cut joints, tinted
// per vertex for kerbs, verges, walls, barriers, rails and the bridges; the paint samples the asphalt texture
// so it can fade into it. Dirt tracks use the terrain's fine material itself. Without the terrain's sky light
// (a test without it) they are plain Lambert.
function roadMaterials(mats) {
  const sky = mats?.terrain?.lod0?.userData?.terrain || null, base = mats?.asphalt;
  const asphalt = litLambert({ map: base?.map || TX.asphalt() }, sky, 'kc-road-asphalt', detileAsphalt);
  asphalt.name = 'road asphalt';
  if (base) followNormal(asphalt, base);
  // The light concretes: a warmer, lighter tone of the photo than the grid's, and the sky's fill taken warmer
  // (WARM), so kerbs, walls and bridges read cream and white under v2's blue sky rather than mid grey.
  const concrete = litLambert({ map: TX.sidewalk(), vertexColors: true }, sky, 'kc-road-concrete', null, WARM);
  concrete.name = 'road concrete';
  TX.upgradeGround(concrete, 'assets/tex/concrete.jpg', { ...CONCRETE_TONE, normal: 'assets/tex/concrete_n.jpg', normalScale: 0.4,
    overlay: (x, S) => {   // saw-cut joints: two slabs a repeat each way, like the grid's sidewalks
      x.fillStyle = 'rgba(110,104,94,.85)';
      x.fillRect(0, 0, S, S / 128); x.fillRect(0, 0, S / 128, S); x.fillRect(0, S / 2 - S / 256, S, S / 128); x.fillRect(S / 2 - S / 256, 0, S / 128, S);
    } });
  // the same photo without the slab joints, for what is built rather than paved: walls, revetments, bridges
  const stone = litLambert({ map: TX.concrete('#d9d0c0', 7), vertexColors: true }, sky, 'kc-road-stone', null, WARM);
  stone.name = 'road stone';
  TX.upgradeGround(stone, 'assets/tex/concrete.jpg', { ...STONE_TONE, normal: 'assets/tex/concrete_n.jpg', normalScale: 0.5 });
  const paint = paintMaterial(asphalt, sky);
  // markings catch a little light after dark (headlights, the moon), so the lanes still read
  mats?.night?.(paint, 'kcGlow', 0, 0.16);
  return { asphalt, concrete, stone, paint, dirt: mats?.terrain?.lod0 || null };
}
const CONCRETE_TONE = { tint: '#f6dfba', amount: 0.5, lift: 0.48 }, STONE_TONE = { tint: '#f6e4c4', amount: 0.45, lift: 0.56 };
const WARM = [1.0, 0.84, 0.64];

// A Lambert material with the terrain's sky fill and lamp gate (sky: terrain3d's uniforms), and any extra
// fragment edits after them. fill tints the sky's fill (the light concretes take it warmer).
function litLambert(o, sky, key, edit = null, fill = null) {
  const m = new THREE.MeshLambertMaterial(o);
  const tint = fill ? `vec3( ${fill.map(v => v.toFixed(3)).join(', ')} )` : '';
  m.onBeforeCompile = (sh) => {
    let f = sh.fragmentShader;
    if (sky) {
      sh.uniforms.uSkyFill = sky.uSkyFill; sh.uniforms.uSkySheen = sky.uSkySheen; sh.uniforms.uKcLamps = sky.uKcLamps;
      f = 'uniform vec3 uSkyFill, uSkySheen;\nuniform bool uKcLamps;\n' + f
        .replace('#include <lights_fragment_begin>', lampGate(THREE.ShaderChunk.lights_fragment_begin))
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          // the sky's own light (the high tier's lighting map) and its faint sheen, as terrain3d adds them
          reflectedLight.indirectDiffuse += diffuseColor.rgb * uSkyFill${tint ? ' * ' + tint : ''};
          reflectedLight.indirectDiffuse += uSkySheen * ( 0.6 + 1.4 * pow( 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ), 4.0 ) );`);
    }
    sh.fragmentShader = edit ? edit(f, sh) : f;
  };
  m.customProgramCacheKey = () => key + (sky ? '-sky' : '');
  return m;
}

// The asphalt photo repeats every UV_ASPHALT metres, and its cracks line up in bands across a long straight.
// Each look-up (colour and, on the high tier, relief) mixes in a second one, turned 36 degrees and 2.3 times
// larger, by a slow wavy pattern of world position (blends about 18 m across), so no two stretches match.
// The paint's fade samples the same way, so a far line still becomes the road around it.
const DETILE = `
  vec2 kcUv2( vec2 uv ) { return mat2( 0.809, 0.588, -0.588, 0.809 ) * uv * 0.43 + vec2( 0.37, 0.71 ); }
  float kcMix( vec2 uv ) {
    float w = sin( uv.x * 1.37 + 1.7 * sin( uv.y * 0.61 ) ) * sin( uv.y * 1.13 + 1.3 * sin( uv.x * 0.53 ) );
    return smoothstep( -0.45, 0.45, w );
  }
  vec4 kcRoadTex( sampler2D t, vec2 uv ) { return mix( texture2D( t, uv ), texture2D( t, kcUv2( uv ) ), kcMix( uv ) ); }
`;
function detileAsphalt(f) {
  f = DETILE + f.replace('#include <map_fragment>', `#ifdef USE_MAP
      diffuseColor *= kcRoadTex( map, vMapUv );
    #endif`);
  // the relief: the second look-up's normal turned back into the first one's frame
  // (three r169's tangent-space branch, with the mix in place of its single look-up)
  return f.replace('#include <normal_fragment_maps>', `#if defined( USE_NORMALMAP_TANGENTSPACE )
      vec3 kcNa = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
      vec3 kcNb = texture2D( normalMap, kcUv2( vNormalMapUv ) ).xyz * 2.0 - 1.0;
      kcNb.xy = mat2( 0.809, -0.588, 0.588, 0.809 ) * kcNb.xy;
      vec3 mapN = mix( kcNa, kcNb, kcMix( vNormalMapUv ) );
      mapN.xy *= normalScale;
      normal = normalize( tbn * mapN );
    #else
      #include <normal_fragment_maps>
    #endif`);
}

// three's direct-lighting chunk with its point- and spot-light loops run only while uKcLamps is set (terrain3d's
// lampGate, the same edit): a uniform, so switching costs nothing and the shader never recompiles. If the chunk
// is not the shape this expects (a newer three), it is left as it is.
function lampGate(chunk) {
  const P = '#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )\n', S = '#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )\n';
  const D = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )\n', END = '\t#pragma unroll_loop_end\n#endif\n';
  const p = chunk.indexOf(P), sp = chunk.indexOf(S), d = chunk.indexOf(D);
  if (p < 0 || sp < p || d < sp || chunk.slice(sp - END.length, sp) !== END || chunk.slice(d - END.length, d) !== END) return chunk;
  const gate = (body) => body.slice(0, -'#endif\n'.length).replace(/^(#if[^\n]*\n)/, '$1if ( uKcLamps ) {\n') + '}\n#endif\n';
  return chunk.slice(0, p) + gate(chunk.slice(p, sp)) + gate(chunk.slice(sp, d)) + chunk.slice(d);
}

// The city's asphalt gets its normal map when the photo loads (textures.js upgradeGround, high tier only):
// the road asphalt takes the same one then, checked as it is drawn until it has it.
function followNormal(m, src) {
  m.userData.follow = () => {
    if (!src.normalMap) return false;
    m.normalMap = src.normalMap; m.normalScale.copy(src.normalScale); m.needsUpdate = true;
    return true;
  };
}

// Vertex-coloured paint that turns into the asphalt under it with distance: near, its own colour; from
// PAINT_NEAR to PAINT_FAR, the asphalt texture at the same world UVs (so a far line is the road itself).
function paintMaterial(asphalt, sky) {
  const glow = { value: 0 };
  const m = litLambert({ vertexColors: true, map: asphalt.map, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }, sky, 'kc-road-paint',
    (f, sh) => {
      sh.uniforms.uKcGlow = glow;
      return 'uniform float uKcGlow;\n' + DETILE + f
        .replace('#include <map_fragment>', `vec3 kcRoad = kcRoadTex( map, vMapUv ).rgb;
          float kcFade = smoothstep( ${PAINT_NEAR.toFixed(1)}, ${PAINT_FAR.toFixed(1)}, length( vViewPosition ) );`)
        .replace('#include <color_fragment>', 'diffuseColor.rgb *= mix( vColor, kcRoad, kcFade );')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += vColor * uKcGlow * ( 1.0 - kcFade );');
    });
  m.name = 'road paint';
  Object.defineProperty(m, 'kcGlow', { get: () => glow.value, set: (v) => { glow.value = v; } });
  return m;
}

// ---------- a growable indexed mesh ----------

class Soup {
  constructor() { this.n = 0; this.m = 0; this.cap = 0; this.icap = 0; this.grow(512); this.growI(1024); }
  grow(min) {
    const cap = Math.max(min, this.cap * 2), n = this.n;
    const re = (a, k) => { const b = new Float32Array(cap * k); if (a) b.set(a.subarray(0, n * k)); return b; };
    this.P = re(this.P, 3); this.N = re(this.N, 3); this.U = re(this.U, 2); this.C = re(this.C, 3);
    this.cap = cap;
  }
  growI(min) {
    const cap = Math.max(min, this.icap * 2), I = new Uint32Array(cap);
    if (this.I) I.set(this.I.subarray(0, this.m));
    this.I = I; this.icap = cap;
  }
  v(x, y, z, nx, ny, nz, u, w, c) {
    if (this.n >= this.cap) this.grow(this.n + 1);
    const i = this.n++, i3 = i * 3;
    this.P[i3] = x; this.P[i3 + 1] = y; this.P[i3 + 2] = z;
    this.N[i3] = nx; this.N[i3 + 1] = ny; this.N[i3 + 2] = nz;
    this.U[i * 2] = u; this.U[i * 2 + 1] = w;
    this.C[i3] = c[0]; this.C[i3 + 1] = c[1]; this.C[i3 + 2] = c[2];
    return i;
  }
  t(a, b, c) {
    if (this.m + 3 > this.icap) this.growI(this.m + 3);
    this.I[this.m++] = a; this.I[this.m++] = b; this.I[this.m++] = c;
  }
  // everything another soup holds, after what this one has
  append(o) {
    if (this.n + o.n > this.cap) this.grow(this.n + o.n);
    if (this.m + o.m > this.icap) this.growI(this.m + o.m);
    const base = this.n;
    this.P.set(o.P.subarray(0, o.n * 3), base * 3); this.N.set(o.N.subarray(0, o.n * 3), base * 3);
    this.U.set(o.U.subarray(0, o.n * 2), base * 2); this.C.set(o.C.subarray(0, o.n * 3), base * 3);
    for (let k = 0; k < o.m; k++) this.I[this.m + k] = o.I[k] + base;
    this.n += o.n; this.m += o.m;
  }
  // a flat quad, corners counter-clockwise seen from the side it faces: [x, y, z] each, uvs [u, v] each
  quad(p, uv, c) {
    const n = faceNormal(p[0], p[1], p[2]);
    const a = this.v(p[0][0], p[0][1], p[0][2], n[0], n[1], n[2], uv[0][0], uv[0][1], c);
    for (let k = 1; k < 4; k++) this.v(p[k][0], p[k][1], p[k][2], n[0], n[1], n[2], uv[k][0], uv[k][1], c);
    this.t(a, a + 1, a + 2); this.t(a, a + 2, a + 3);
  }
  mesh(material, { cast = false, color = true, uv = true, splat = false } = {}) {
    const g = new THREE.BufferGeometry(), n = this.n;
    g.setAttribute('position', new THREE.BufferAttribute(this.P.slice(0, n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.N.slice(0, n * 3), 3));
    if (uv) g.setAttribute('uv', new THREE.BufferAttribute(this.U.slice(0, n * 2), 2));
    if (splat) {
      // the dirt tracks' colours are the terrain's splat shares (sand, rock, dirt; paved 0)
      const s = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) s[i * 4 + k] = Math.round(this.C[i * 3 + k] * 255);
      g.setAttribute('splat', new THREE.BufferAttribute(s, 4, true));
    } else if (color) g.setAttribute('color', new THREE.BufferAttribute(this.C.slice(0, n * 3), 3));
    g.setIndex(new THREE.BufferAttribute(n <= 65536 ? Uint16Array.from(this.I.subarray(0, this.m)) : this.I.slice(0, this.m), 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, material);
    mesh.castShadow = cast; mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }
}

function faceNormal(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

// ---------- the world, in metres ----------

function makeContext(world) {
  const net = world.roads, G = world.grids, H = G.terrain, [VW, VH] = G.dims.terrain;
  // TERRAIN as the terrain mesh draws it: 2 m vertices, each quad split along the same diagonal as terrain3d's
  // grid, so a point snapped to it lies on the drawn ground
  const terrainY = (x, z) => {
    const fx = clamp(x / 2, 0, VW - 1), fz = clamp(z / 2, 0, VH - 1);
    const i = Math.min(Math.floor(fx), VW - 2), j = Math.min(Math.floor(fz), VH - 2), u = fx - i, w = fz - j, k = j * VW + i;
    if (u + w <= 1) return H[k] + (H[k + 1] - H[k]) * u + (H[k + VW] - H[k]) * w;
    const h11 = H[k + VW + 1];
    return h11 + (H[k + VW] - h11) * (1 - u) + (H[k + 1] - h11) * (1 - w);
  };
  // GROUND (where the physics stands), bilinear like the world's groundY
  const Gd = G.ground || H;
  const groundY = (x, z) => {
    const fx = clamp(x / 2, 0, VW - 1.001), fz = clamp(z / 2, 0, VH - 1.001), i = Math.floor(fx), j = Math.floor(fz), u = fx - i, w = fz - j, k = j * VW + i;
    return (Gd[k] * (1 - u) + Gd[k + 1] * u) * (1 - w) + (Gd[k + VW] * (1 - u) + Gd[k + VW + 1] * u) * w;
  };
  const byId = Object.fromEntries(ROADS.map(r => [r.id, r]));
  const edges = net.edges.map(e => edgeOf(e, byId[e.road] || {}));
  const ctx = { world, net, G, terrainY, groundY, edges, sea: world.SEA_LEVEL ?? -1 };
  for (const E of edges) kerbLifts(ctx, E);
  palmRuns(world, edges);
  return ctx;
}

// Stretches of a flush median with palms planted down it (the Loop's causeway fill, spec §4.2): from 6 m
// before the first palm of a group to 6 m past its last, a group being palms less than 20 m apart.
function palmRuns(world, edges) {
  const flush = edges.filter(E => E.median > 0 && !E.raised);
  const at = new Map(flush.map(E => [E, []]));
  for (const p of world.palms || []) {
    const x = p.x / PX, z = p.y / PX;
    for (const E of flush) {
      const k = nearestSample(E, x, z);
      if (Math.hypot(E.X[k] - x, E.Z[k] - z) < 3 && Math.abs((x - E.X[k]) * -E.TZ[k] + (z - E.Z[k]) * E.TX[k]) < 1) { at.get(E).push(nearestStation(E, x, z)); break; }
    }
  }
  for (const E of edges) {
    const st = (at.get(E) || []).sort((a, b) => a - b), runs = [];
    for (const s of st) {
      if (runs.length && s - runs[runs.length - 1][1] < 20) runs[runs.length - 1][1] = s;
      else runs.push([s, s]);
    }
    E.palmRuns = runs.map(([a, b]) => [a - 6, b + 6]);     // (the ribbons keep them within their land runs)
  }
}
function nearestSample(E, x, z) {
  let best = 0, bd = Infinity;
  for (let k = 0; k < E.n; k++) { const d = (E.X[k] - x) ** 2 + (E.Z[k] - z) ** 2; if (d < bd) { bd = d; best = k; } }
  return best;
}

// How far each kerb without a sidewalk must roll up, per sample: enough that the line from ROLL metres in
// (at the design height) to the kerb keeps KERB_CLEAR over the terrain mesh, smoothed over the neighbours.
// The roll is held to ROLL_MAX (a gentle rise in the gutter, not a fin of asphalt); the whole need is kept
// (E.needL, E.needR) for the kerb walls that stand where it is more.
function kerbLifts(ctx, E) {
  // (not on a jump ramp's run: the carve lifted the ground there under the ramp, which stands on the road)
  const jumps = (ctx.world.activities || []).filter(a => a.type === 'jump' && a.road === E.road).map(a => [a.x / PX, a.y / PX, a.run / PX + 2]);
  E.needL = new Float64Array(E.n); E.needR = new Float64Array(E.n);
  for (const side of [-1, 1]) {
    const L = side > 0 ? E.LR : E.LL, need = side > 0 ? E.needR : E.needL, raw = new Float64Array(E.n);
    for (let k = 0; k < E.n; k++) {
      if (walkOf(E, side, E.S[k]) > 0 || onDeck(E, E.S[k]) || E.cls === 'dirt') continue;
      if (jumps.some(([x, z, r]) => Math.hypot(E.X[k] - x, E.Z[k] - z) < r)) continue;
      let n = 0;
      for (const d of [0, 0.25, 0.5, 0.75]) {
        const o = side * (E.hw - d), x = E.X[k] - E.TZ[k] * o, z = E.Z[k] + E.TX[k] * o;
        const t = ctx.terrainY(x, z) + KERB_CLEAR - (E.Y[k] - o * E.TB[k]);
        if (t > 0) n = Math.max(n, t / (1 - d / ROLL));
      }
      raw[k] = n;
    }
    for (let k = 0; k < E.n; k++) {
      need[k] = onDeck(E, E.S[k]) ? 0 : Math.max(raw[k], raw[Math.max(0, k - 1)], raw[Math.min(E.n - 1, k + 1)]);
      L[k] = Math.min(need[k], ROLL_MAX);
    }
  }
}
// the roll-up at offset o (m right of the centre) for an interpolated frame f
function liftAt(E, f, o) {
  const w = (Math.abs(o) - (E.hw - ROLL)) / ROLL;
  if (w <= 0) return 0;
  return Math.min(1, w) * (o > 0 ? f.lr : f.ll);
}

// A RoadNet edge in metres: samples, unit tangents, design heights, tan(bank) per sample, the class's
// cross-section, which sides have sidewalks, and the deck spans.
function edgeOf(e, road) {
  const n = e.n, X = new Float64Array(n), Z = new Float64Array(n), S = new Float64Array(n), TXa = new Float64Array(n), TZa = new Float64Array(n);
  const Y = Float64Array.from(e.gy), TB = new Float64Array(n), nb = e.bank?.length || 0;
  for (let k = 0; k < n; k++) {
    X[k] = e.x[k] / PX; Z[k] = e.y[k] / PX; S[k] = e.s[k] / PX;
    const l = Math.hypot(e.tx[k], e.ty[k]) || 1;
    TXa[k] = e.tx[k] / l; TZa[k] = e.ty[k] / l;
    if (nb) {
      const f = Math.min(S[k] / 2, nb - 1), i = Math.floor(f), j = Math.min(i + 1, nb - 1);
      TB[k] = Math.tan(e.bank[i] + (e.bank[j] - e.bank[i]) * (f - i));
    }
  }
  const cls = ROAD_CLASSES[e.cls] || {};
  const E = {
    e, id: e.id, road: e.road, cls: e.cls, n, X, Z, S, TX: TXa, TZ: TZa, Y, TB, len: S[n - 1],
    hw: e.halfW / PX, walkL: e.walkL / PX, walkR: e.walkR / PX, median: e.median / PX, laneW: e.laneW / PX,
    lanes: Math.max(e.lanesF, e.lanesB, 1), oneway: !!e.oneway, single: !!e.single, rs: (e.rs || 0) / PX,
    deck: (e.deck || []).map(([a, b]) => [a / PX, b / PX]), blend: cls.blend || 10, a: e.a, b: e.b,
    raised: e.cls === 'blvd' && e.median > 0,     // the boulevards' palm medians are kerbed islands
    promSide: 0, promW: 0, mouthA: 0, mouthB: 0, LL: new Float64Array(n), LR: new Float64Array(n),
  };
  // a promenade beside the road (the Venetian's, on its north side) is a sidewalk on land
  if (road.promenade) {
    let rz = 0;
    for (let k = 0; k < n; k++) rz += TXa[k];        // the right-hand normal's z, summed: > 0 means right is south
    E.promSide = (road.promenade.side === 'N') === (rz > 0) ? -1 : 1;
    E.promW = road.promenade.w;
  }
  return E;
}

// The sidewalk width on an edge side (+1 right, -1 left) at station s (a promenade only off the decks).
function walkOf(E, side, s = -1) {
  const w = side > 0 ? E.walkR : E.walkL;
  if (E.promSide === side && !(s >= 0 && onDeck(E, s))) return Math.max(w, E.promW);
  return w;
}
const onDeck = (E, s) => E.deck.some(([a, b]) => s >= a - 1e-6 && s <= b + 1e-6);

const _f = { x: 0, z: 0, tx: 1, tz: 0, y: 0, tb: 0, i: 0, ll: 0, lr: 0 };
// the first sample of an edge past station s
function sampleAfter(E, s) {
  let lo = 0, hi = E.n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (E.S[m] <= s) lo = m + 1; else hi = m; }
  return lo;
}
// The edge's frame at station s (m): position, unit tangent, design height, tan(bank), interpolated.
function at(E, s, out = _f) {
  const S = E.S, n = E.n;
  s = clamp(s, 0, E.len);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
  const ds = S[hi] - S[lo], f = ds > 1e-9 ? (s - S[lo]) / ds : 0;
  const tx = lerp(E.TX[lo], E.TX[hi], f), tz = lerp(E.TZ[lo], E.TZ[hi], f), l = Math.hypot(tx, tz) || 1;
  out.x = lerp(E.X[lo], E.X[hi], f); out.z = lerp(E.Z[lo], E.Z[hi], f); out.tx = tx / l; out.tz = tz / l;
  out.y = lerp(E.Y[lo], E.Y[hi], f); out.tb = lerp(E.TB[lo], E.TB[hi], f); out.i = lo;
  out.ll = lerp(E.LL[lo], E.LL[hi], f); out.lr = lerp(E.LR[lo], E.LR[hi], f);
  return out;
}
// the design surface at station s, offset o (m right of the centre line): [x, y, z]
function surf(E, s, o) {
  const f = at(E, s);
  return [f.x - f.tz * o, f.y - o * f.tb + liftAt(E, f, o), f.z + f.tx * o];
}

// ---------- frames and strips ----------

// A path to sweep cross-sections along: positions, unit tangents, heights, tan(bank) (y - o * tb at offset o),
// distance along and a per-frame width W (corner sidewalks change width round a fillet).
function makeFrames(cap) {
  return { n: 0, X: new Float64Array(cap), Z: new Float64Array(cap), TX: new Float64Array(cap), TZ: new Float64Array(cap),
    Y: new Float64Array(cap), TB: new Float64Array(cap), S: new Float64Array(cap), W: new Float64Array(cap),
    LL: new Float64Array(cap), LR: new Float64Array(cap) };
}
function pushFrame(F, x, z, tx, tz, y, tb, s, w = 0, ll = 0, lr = 0) {
  const i = F.n++;
  F.X[i] = x; F.Z[i] = z; F.TX[i] = tx; F.TZ[i] = tz; F.Y[i] = y; F.TB[i] = tb; F.S[i] = s; F.W[i] = w; F.LL[i] = ll; F.LR[i] = lr;
}
// the edge's frames from station s0 to s1: both ends exactly, and every sample between
function edgeFrames(E, s0, s1) {
  const F = makeFrames(E.n + 2), f = { ..._f };
  const put = (s) => { at(E, s, f); pushFrame(F, f.x, f.z, f.tx, f.tz, f.y, f.tb, s, 0, f.ll, f.lr); };
  put(s0);
  for (let k = sampleAfter(E, s0 + 0.05); k < E.n && E.S[k] < s1 - 0.05; k++) put(E.S[k]);
  put(s1);
  return F;
}
// frames along a polyline of { x, z, y, tb, w, tx?, tz? } points, tangents (where not given) from the neighbours
function pathFrames(pts) {
  const F = makeFrames(pts.length);
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = p.tx, tz = p.tz;
    if (tx === undefined) { const l = Math.hypot(b.x - a.x, b.z - a.z) || 1; tx = (b.x - a.x) / l; tz = (b.z - a.z) / l; }
    else { const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l; }
    if (i) s += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
    pushFrame(F, p.x, p.z, tx, tz, p.y, p.tb || 0, s, p.w || 0);
  }
  return F;
}

// A point of a cross-section: o metres right of the frame (plus ow times the frame's width W), dy over the
// frame's banked surface (plus roll times the kerb's roll-up on its side), or g over the terrain mesh. uk is
// where its concrete texture's u starts.
// A point with gmax stands at least gmax over the terrain too, by up to RISE_MAX more than its own height:
// a sidewalk's outer edge where a lot's lawn, raised by its pad, comes up past it.
const RISE_MAX = 0.3;
function pointOf(ctx, F, f, p, out) {
  const o = p.o + (p.ow ? p.ow * F.W[f] : 0), x = F.X[f] - F.TZ[f] * o, z = F.Z[f] + F.TX[f] * o;
  out[0] = x; out[2] = z;
  out[1] = p.g !== undefined ? ctx.terrainY(x, z) + p.g : F.Y[f] - o * F.TB[f] + (p.dy || 0) + (p.roll ? p.roll * (o > 0 ? F.LR[f] : F.LL[f]) : 0);
  if (p.gmax !== undefined) out[1] = Math.max(out[1], Math.min(ctx.terrainY(x, z) + p.gmax, out[1] + RISE_MAX));
  out[3] = o;
  return out;
}

// One strip of a cross-section, from point a to point b (left to right as seen along the path, so it faces
// up), swept over frames f0..f1: two vertices a frame, smooth along the path, creased against its neighbours.
// uv: 'world' (x and z over UV_ASPHALT), 'strip' (u across from the kerb, v along, for the concrete), 'flat'.
const _pa = [0, 0, 0, 0], _pb = [0, 0, 0, 0], _qa = [0, 0, 0, 0], _qb = [0, 0, 0, 0];
function strip(ctx, soup, F, f0, f1, a, b, col, uv = 'strip') {
  if (f1 <= f0) return;
  const ca = a.c || col, cb = b.c || col;    // a point may carry its own colour (the dirt verges' splat)
  let prev = -1;
  for (let f = f0; f <= f1; f++) {
    pointOf(ctx, F, f, a, _pa); pointOf(ctx, F, f, b, _pb);
    // On the inside of a bend tighter than the offset, the offset line would run backwards and fold the
    // strip over itself: such a point stays where it was on the frame before.
    if (f > f0) {
      if ((_pa[0] - _qa[0]) * F.TX[f] + (_pa[2] - _qa[2]) * F.TZ[f] < 0) for (let q = 0; q < 4; q++) _pa[q] = _qa[q];
      if ((_pb[0] - _qb[0]) * F.TX[f] + (_pb[2] - _qb[2]) * F.TZ[f] < 0) for (let q = 0; q < 4; q++) _pb[q] = _qb[q];
    }
    for (let q = 0; q < 4; q++) { _qa[q] = _pa[q]; _qb[q] = _pb[q]; }
    const fa = Math.max(f0, f - 1), fb = Math.min(f1, f + 1), ds = F.S[fb] - F.S[fa];
    const g = ds > 1e-9 ? (F.Y[fb] - F.Y[fa]) / ds : 0;
    // normal = across x along
    const ax = _pb[0] - _pa[0], ay = _pb[1] - _pa[1], az = _pb[2] - _pa[2], tx = F.TX[f], tz = F.TZ[f];
    let nx = ay * tz - az * g, ny = az * tx - ax * tz, nz = ax * g - ay * tx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) { nx = 0; ny = 1; nz = 0; } else { nx /= l; ny /= l; nz /= l; }
    let ua, va, ub, vb;
    if (uv === 'world') { ua = _pa[0] / UV_ASPHALT; va = -_pa[2] / UV_ASPHALT; ub = _pb[0] / UV_ASPHALT; vb = -_pb[2] / UV_ASPHALT; }
    else if (uv === 'flat') { ua = ub = va = vb = 0.25; }
    else {
      va = vb = F.S[f] / UV_CONCRETE;
      ua = a.u !== undefined ? a.u : (Math.abs(_pa[3]) - (a.uk || 0)) / UV_CONCRETE;
      ub = b.u !== undefined ? b.u : (Math.abs(_pb[3]) - (b.uk || 0)) / UV_CONCRETE;
    }
    const i = soup.v(_pa[0], _pa[1], _pa[2], nx, ny, nz, ua, va, ca);
    soup.v(_pb[0], _pb[1], _pb[2], nx, ny, nz, ub, vb, cb);
    if (prev >= 0) { soup.t(prev, prev + 1, i + 1); soup.t(prev, i + 1, i); }
    prev = i;
  }
}

// A cross-section (list of [a, b, colour, uv]) over frames f0..f1, split into the tiles it crosses: each run
// of frames goes to the tile under its middle.
function sweep(ctx, F, f0, f1, parts, pick) {
  let start = f0, key = null, tile = null;
  for (let f = f0; f < f1; f++) {
    const t = ctx.tileAt((F.X[f] + F.X[f + 1]) / 2, (F.Z[f] + F.Z[f + 1]) / 2);
    if (t !== tile) {
      if (tile) for (const [a, b, col, uv] of parts) strip(ctx, pick(tile), F, start, f, a, b, col, uv);
      tile = t; start = f; key = t.key;
    }
  }
  if (tile) for (const [a, b, col, uv] of parts) strip(ctx, pick(tile), F, start, f1, a, b, col, uv);
  return key;
}

// ---------- cross-sections ----------

// One side's kerb-out cross-section: a sidewalk (kerb face, slab top, bevel to the terrain) or a gravel
// verge, left to right. k is the kerb's offset (signed: < 0 on the left), w the sidewalk width (ow: from the
// frame's W instead), side -1 left or +1 right.
function sidePartsOf(k, side, w, ow = 0) {
  const s = side, uk = Math.abs(k);
  if (w > 0 || ow) {
    // (the slab tilts up to the lawn where a pad raised it past the outer edge)
    const outer = { o: k + s * w, ow: s * ow, dy: CURB_H, uk, gmax: SNAP };
    const verge = { o: k + s * (w + VERGE_WALK), ow: s * ow, g: SNAP, uk };
    const kTop = { o: k, dy: CURB_H, uk }, kBot = { o: k, dy: 0, u: 0 }, kTopU = { o: k, dy: CURB_H, u: CURB_H / UV_CONCRETE };
    return s > 0
      ? [[kBot, kTopU, C.kerb], [kTop, outer, C.walk], [outer, verge, C.vergeWalk]]
      : [[verge, outer, C.vergeWalk], [outer, kTop, C.walk], [kTopU, kBot, C.kerb]];
  }
  const edge = { o: k, dy: 0, u: 0, roll: k ? 1 : 0 }, verge = { o: k + s * VERGE_RURAL, g: SNAP, u: VERGE_RURAL / UV_CONCRETE };
  return s > 0 ? [[edge, verge, C.vergeRural]] : [[verge, edge, C.vergeRural]];
}

// a kerbed median island between -m/2 and +m/2
function medianParts(m) {
  const h = m / 2;
  return [
    [{ o: -h, dy: 0, u: 0 }, { o: -h, dy: CURB_H, u: CURB_H / UV_CONCRETE }, C.kerb],
    [{ o: -h, dy: CURB_H, uk: -h }, { o: h, dy: CURB_H, uk: -h }, C.median],
    [{ o: h, dy: CURB_H, u: CURB_H / UV_CONCRETE }, { o: h, dy: 0, u: 0 }, C.kerb],
  ];
}

// ---------- junctions: where each end's mouth is ----------

// For every node: its ends sorted round it, the corner between each pair of neighbours (a fillet where their
// kerbs meet, else 'open': one road carrying straight on, or a bend's outside), and each end's mouth, how far
// from the node its ribbon stops.
function planJunctions(ctx) {
  const out = [];
  for (const N of ctx.net.nodes) {
    const J = { N, x: N.x / PX, z: N.z !== undefined ? N.z / PX : N.y / PX, ends: [], corners: [] };
    J.ends = N.ends.map((R, idx) => endOf(ctx, R, idx)).sort((a, b) => a.ang - b.ang);
    const m = J.ends.length;
    if (m < 2) { for (const A of J.ends) A.mouth = 0; J.dead = true; }
    else {
      for (let i = 0; i < m; i++) J.corners.push(cornerOf(ctx, J, J.ends[i], J.ends[(i + 1) % m]));
      for (const A of J.ends) A.mouth = MOUTH_MIN;
      for (const c of J.corners) if (c.fillet) { c.A.mouth = Math.max(c.A.mouth, c.dA + c.Lt); c.B.mouth = Math.max(c.B.mouth, c.dB + c.Lt); }
      for (const A of J.ends) A.mouth = Math.min(A.mouth, A.E.len * 0.45, MOUTH_MAX);
      for (const A of J.ends) settleMouth(ctx, J, A);
      // a corner whose mouth was cut short of its own kerb crossing cannot round: it is joined straight
      for (const c of J.corners) if (c.fillet && (c.A.mouth < c.dA + 0.3 || c.B.mouth < c.dB + 0.3)) { c.fillet = false; c.open = true; }
    }
    for (const A of J.ends) { if (A.start) A.E.mouthA = A.mouth; else A.E.mouthB = A.mouth; }
    out.push(J);
  }
  return out;
}

// An end of an edge at a node: which way it leaves (ang, from the RoadNet), its sign (+1 when the edge starts
// here, so the end's right is the edge's right), its sidewalks either side of it.
function endOf(ctx, R, idx) {
  const E = ctx.edges[R.e], sgn = R.start ? 1 : -1;
  return { idx, E, start: R.start, sgn, ang: R.a, mouth: 0, reach: Math.min(E.len * 0.5, KERB_REACH),
    walk: { [-1]: walkOf(E, -sgn), 1: walkOf(E, sgn) } };
}
// station on the edge d metres from the node along an end
const stOf = (A, d) => (A.start ? d : A.E.len - d);
// the point of an end's cross-section d metres out, o metres to the end's right: { x, z, y } on the design surface
function endPoint(A, d, o) {
  const p = surf(A.E, stOf(A, d), A.sgn * o);
  return { x: p[0], y: p[1], z: p[2] };
}
// the unit direction an end leaves the node along, d metres out
function endDir(A, d) {
  const f = at(A.E, stOf(A, d));
  return [f.tx * A.sgn, f.tz * A.sgn];
}
// An end's kerb line (side +1 its right, -1 its left) out to its reach, a point a metre, starting KERB_BACK
// metres behind the node on the line of its tangent there: at a wide corner the kerbs meet behind the node on
// one of the two roads.
const KERB_BACK = 12;
function kerbLine(A, side) {
  const n = Math.max(2, Math.ceil(A.reach)), back = KERB_BACK / 2, P = new Float64Array((back + n + 1) * 3);
  const p0 = endPoint(A, 0, side * A.E.hw), u = endDir(A, 0);
  let q = 0;
  for (let k = 0; k < back; k++) { const d = -KERB_BACK + 2 * k; P[q++] = p0.x + u[0] * d; P[q++] = p0.z + u[1] * d; P[q++] = d; }
  for (let k = 0; k <= n; k++) { const d = A.reach * k / n, p = endPoint(A, d, side * A.E.hw); P[q++] = p.x; P[q++] = p.z; P[q++] = d; }
  return P;
}

function cornerOf(ctx, J, A, B) {
  const c = { A, B, fillet: false, open: false };
  const uA = endDir(A, 2), uB = endDir(B, 2);
  if (uA[0] * uB[0] + uA[1] * uB[1] < OPEN_COS) { c.open = true; return c; }
  const hit = firstCrossing(kerbLine(A, 1), kerbLine(B, -1));
  if (!hit) { c.open = true; return c; }
  const ta = endDir(A, hit.dA), tb = endDir(B, hit.dB);
  const theta = Math.acos(clamp(ta[0] * tb[0] + ta[1] * tb[1], -1, 1));
  if (theta > OPEN_ANGLE) { c.open = true; return c; }
  Object.assign(c, { fillet: true, dA: hit.dA, dB: hit.dB, x: hit.x, z: hit.z, theta });
  // The fillet's asphalt reaches past both kerbs into the corner, where the carve (which cut a square corner)
  // may have left the natural ground: the radius shrinks until the whole fillet lies on one road's bed or the
  // other's (within its sidewalk plus the metre of bed past it), so no grass comes through.
  let R = Math.min(CORNER_R[A.E.cls] ?? 6, CORNER_R[B.E.cls] ?? 6);
  for (;;) {
    c.Lt = Math.min(FILLET_MAX, R / Math.tan(theta / 2));
    if (R <= 1 || filletOnBed(c)) break;
    R *= 0.85;
  }
  c.R = R;
  return c;
}
const BED_MARGIN = 0.4;  // m inside the edge of a road's carved bed a fillet must stay
function filletOnBed(c) {
  const p0 = endPoint(c.A, Math.max(0, c.dA + c.Lt), c.A.E.hw), p2 = endPoint(c.B, Math.max(0, c.dB + c.Lt), -c.B.E.hw);
  const bedA = c.A.E.hw + Math.max(c.A.walk[1], 0) + 1 - BED_MARGIN, bedB = c.B.E.hw + Math.max(c.B.walk[-1], 0) + 1 - BED_MARGIN;
  for (let k = 1; k < 8; k++) {
    const t = k / 8, u = 1 - t, x = u * u * p0.x + 2 * u * t * c.x + t * t * p2.x, z = u * u * p0.z + 2 * u * t * c.z + t * t * p2.z;
    if (centreDist(c.A, x, z) > bedA && centreDist(c.B, x, z) > bedB) return false;
  }
  return true;
}
// distance from (x, z) to an end's centre line, near the node (out to its reach)
function centreDist(A, x, z) {
  if (!A.centre) {
    A.centre = [];
    const n = Math.max(2, Math.ceil(A.reach / 2));
    for (let k = 0; k <= n; k++) { const p = endPoint(A, A.reach * k / n, 0); A.centre.push([p.x, p.z]); }
  }
  let best = Infinity;
  const P = A.centre;
  for (let k = 0; k + 1 < P.length; k++) {
    const [ax, az] = P[k], dx = P[k + 1][0] - ax, dz = P[k + 1][1] - az, L2 = dx * dx + dz * dz;
    const t = L2 > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1) : 0;
    best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
  }
  return best;
}

// Where the carve's nearest-road rule let another road's bed reach over an end's carriageway (a steep side
// road's corner at a T), the bed is not this road's design surface: the mouth moves out until the bed under
// the whole cross-section is this road's own again (within BED_TOL), so the junction mesh, which follows
// the bed, takes in all of it. Never onto a deck, nor past 45% of the edge.
const BED_TOL = 0.04;
function settleMouth(ctx, J, A) {
  const E = A.E, limit = Math.min(E.len * 0.45, MOUTH_MAX), hw = E.hw;
  const offs = [-hw, -hw / 2, 0, hw / 2, hw];
  for (const side of [-1, 1]) { const w = A.walk[side]; if (w > 0) offs.push(side * (hw + w - 0.3)); }
  const others = J.ends.filter(B => B !== A);
  let last = -1;
  for (let d = A.mouth; d <= limit; d += 1) {
    const s = stOf(A, d);
    if (onDeck(E, s)) break;
    const f = at(E, s, {});
    for (const o of offs) {
      const eo = A.sgn * o, x = f.x - f.tz * eo, z = f.z + f.tx * eo;
      if (Math.abs(ctx.terrainY(x, z) + BED - (f.y - eo * f.tb)) <= BED_TOL) continue;
      // only where another road of this junction is nearer than this one (the carve gave it that bed)
      const own = Math.abs(o);
      if (others.some(B => centreDist(B, x, z) < own - 0.3)) { last = d; break; }
    }
  }
  if (last >= 0) A.mouth = Math.max(A.mouth, Math.min(limit, last + 1.5));
}
const BED = 0.20;        // m: the carve's road bed under the surface

// where two polylines (flat x, z, d triples) first cross (the crossing nearest both starts), or null
function firstCrossing(P, Q) {
  let best = null;
  for (let i = 0; i + 5 < P.length; i += 3) {
    const ax = P[i], az = P[i + 1], ad = P[i + 2], bx = P[i + 3], bz = P[i + 4], bd = P[i + 5];
    const minx = Math.min(ax, bx), maxx = Math.max(ax, bx), minz = Math.min(az, bz), maxz = Math.max(az, bz);
    for (let j = 0; j + 5 < Q.length; j += 3) {
      const cx = Q[j], cz = Q[j + 1], cd = Q[j + 2], dx = Q[j + 3], dz = Q[j + 4], dd = Q[j + 5];
      if (Math.max(cx, dx) < minx || Math.min(cx, dx) > maxx || Math.max(cz, dz) < minz || Math.min(cz, dz) > maxz) continue;
      const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz, den = rx * sz - rz * sx;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((cx - ax) * sz - (cz - az) * sx) / den, u = ((cx - ax) * rz - (cz - az) * rx) / den;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      const dA = lerp(ad, bd, t), dB = lerp(cd, dd, u);
      if (!best || dA + dB < best.dA + best.dB) best = { dA, dB, x: ax + rx * t, z: az + rz * t };
    }
  }
  return best;
}

// The kerb round a corner, from A's right kerb at its mouth to B's left kerb at its mouth: back along A's
// kerb to the fillet, the fillet (a quadratic from tangent point to tangent point with the kerbs' crossing as
// its control point), out along B's. An open corner runs both kerbs into the node (with the outside corner of
// a bend, where the kerb lines meet behind it). Each point: x, z, y (road level at the kerb), tb (minus the
// sidewalk's rise per metre outward, as the frames want it) and w (the sidewalk width there).
function cornerPath(c) {
  const { A, B } = c, pts = [], wA = A.walk[1], wB = B.walk[-1];
  if (c.fillet) {
    const tA = Math.max(0, Math.min(c.dA + c.Lt, A.mouth)), tB = Math.max(0, Math.min(c.dB + c.Lt, B.mouth));
    kerbRun(A, 1, A.mouth, tA, wA, pts, -1);
    const p0 = endPoint(A, tA, A.E.hw), p2 = endPoint(B, tB, -B.E.hw), rA = riseOf(A, 1, tA), rB = riseOf(B, -1, tB);
    const n = Math.max(4, Math.ceil((Math.PI - c.theta) / (Math.PI / 18)));
    for (let k = 1; k < n; k++) {
      const t = k / n, u = 1 - t;
      pts.push({ x: u * u * p0.x + 2 * u * t * c.x + t * t * p2.x, z: u * u * p0.z + 2 * u * t * c.z + t * t * p2.z,
        y: lerp(p0.y, p2.y, t), tb: -lerp(rA, rB, t), w: lerp(wA, wB, t) });
    }
    kerbRun(B, -1, tB, B.mouth, wB, pts, 1);
  } else if (A.E.road === B.E.road) {
    // one road carrying on: its kerb runs in to the node and out again (where the two halves' kerbs land a
    // little apart at the node, they meet half way)
    kerbRun(A, 1, A.mouth, 0, wA, pts, -1);
    const a = pts.pop(), b = [];
    kerbRun(B, -1, 0, B.mouth, wB, b, 1);
    const q = b.shift();
    pts.push({ x: (a.x + q.x) / 2, z: (a.z + q.z) / 2, y: (a.y + q.y) / 2, tb: (a.tb + q.tb) / 2, w: (a.w + q.w) / 2, tx: (a.tx + q.tx) / 2, tz: (a.tz + q.tz) / 2 }, ...b);
  } else {
    // two roads joined end to end: straight from mouth to mouth, or round the outside of a bend in a sharp
    // corner where the kerb lines meet behind both mouths
    kerbRun(A, 1, A.mouth, A.mouth, wA, pts, -1);
    const pA = endPoint(A, A.mouth, A.E.hw), pB = endPoint(B, B.mouth, -B.E.hw), uA = endDir(A, A.mouth), uB = endDir(B, B.mouth);
    const den = uA[0] * uB[1] - uA[1] * uB[0];
    if (Math.abs(den) > 0.05) {
      // pA - t uA = pB - s uB
      const t = ((pA.x - pB.x) * uB[1] - (pA.z - pB.z) * uB[0]) / den, s = ((pA.x - pB.x) * uA[1] - (pA.z - pB.z) * uA[0]) / den;
      if (t > 0.3 && s > 0.3 && t < A.mouth + 3 * B.E.hw && s < B.mouth + 3 * A.E.hw)
        pts.push({ x: pA.x - t * uA[0], z: pA.z - t * uA[1], y: (pA.y + pB.y) / 2, tb: 0, w: (wA + wB) / 2 });
    }
    kerbRun(B, -1, B.mouth, B.mouth, wB, pts, 1);
  }
  // drop points closer than 5 cm to the one before
  const out = [];
  for (const p of pts) if (!out.length || Math.hypot(p.x - out[out.length - 1].x, p.z - out[out.length - 1].z) > 0.05) out.push(p);
  return out;
}
// the sidewalk's rise per metre outward on an end's side (the edge's bank tilts it)
function riseOf(A, side, d) { return -side * A.sgn * at(A.E, stOf(A, d)).tb; }
// Points along an end's kerb (side) from d0 to d1: both ends and the edge samples between, each with the
// kerb's own direction of travel (dir +1 out from the node, -1 in), so a corner piece's cross-section at a
// mouth lines up exactly with the edge's.
function kerbRun(A, side, d0, d1, w, pts, dir) {
  const ds = [d0];
  const lo = Math.min(d0, d1), hi = Math.max(d0, d1), mid = [];
  for (let k = 0; k < A.E.n; k++) { const d = A.start ? A.E.S[k] : A.E.len - A.E.S[k]; if (d > lo + 0.3 && d < hi - 0.3) mid.push(d); }
  mid.sort((a, b) => (d1 >= d0 ? a - b : b - a));
  ds.push(...mid, d1);
  for (const d of ds) {
    const p = endPoint(A, d, side * A.E.hw), u = endDir(A, d);
    pts.push({ x: p.x, z: p.z, y: p.y, tb: -riseOf(A, side, d), w, tx: u[0] * dir, tz: u[1] * dir });
  }
}

// ---------- junctions: the mesh ----------

// The junction's outline (each end's mouth, left kerb to right kerb, then the corner to the next end), meshed in
// rings round the node: from the outline in to the node, each ring a fixed share of the way. That works where
// every outline point can see the node (true of every junction here); otherwise the outline is ear-clipped.
// Outline points are on the design surface, so the ribbons meet it exactly; ring points take GROUND where it is
// road surface (so cars sit on the junction as the physics has them) and blend from the outline elsewhere.
function junctionMesh(ctx, J) {
  if (J.dead) return;
  const tile = ctx.tileAt(J.x, J.z), outline = [];
  for (let i = 0; i < J.ends.length; i++) {
    const A = J.ends[i], c = J.corners[i], hw = A.E.hw;
    // the mouth, left kerb to right, with every point the ribbon's last cross-section has (a kerb's roll-up,
    // a raised median's nose), so the two meet edge for edge
    // (in the end's own offsets, right positive: the edge's when it starts here, mirrored when it ends here)
    const offs = asphaltPts(A.E, stOf(A, A.mouth)).filter(o => o !== null).map(o => A.sgn * o).sort((a, b) => a - b);
    for (let k = 0; k + 1 < offs.length; k++) outline.push(endPoint(A, A.mouth, offs[k]));
    c.path = cornerPath(c);
    // between its two mouths the kerb lies on the carved bed, whichever road's that is: it takes the bed's
    // height (what GROUND has there), not its own road's design
    for (let k = 1; k + 1 < c.path.length; k++) c.path[k].y = onBed(ctx, c.path[k].x, c.path[k].z, c.path[k].y);
    for (let k = 0; k + 1 < c.path.length; k++) outline.push(c.path[k]);
  }
  J.outline = outline;
  const K = outline.length;
  // The rings close in on a centre every outline point can see: the node, or failing that (a long acute
  // fillet can turn its kerb a hair back round the node) the outline's centroid or half way to it, or the
  // nearest such point to the node on a half-metre lattice over the outline's box.
  let mx = 0, mz = 0;
  for (const p of outline) { mx += p.x / K; mz += p.z / K; }
  let cx = J.x, cz = J.z, sign = 0, star = false;
  for (const [x, z] of centres(outline, J.x, J.z, mx, mz)) {
    sign = starSign(outline, x, z);
    if (sign) { cx = x; cz = z; star = true; break; }
  }
  const soup = tile.asphalt, base = soup.n, tris = [];
  const verts = [];
  if (star) {
    let rmax = 0;
    for (const p of outline) rmax = Math.max(rmax, Math.hypot(p.x - cx, p.z - cz));
    const n = Math.max(1, Math.ceil(rmax / RING_STEP));
    const yc = onBed(ctx, cx, cz, outline.reduce((a, p) => a + p.y, 0) / K);
    verts.push([cx, yc, cz]);
    // ring j of n (j = n is the outline), point k: on the bed, as the physics has it
    for (let j = 1; j <= n; j++) {
      for (let k = 0; k < K; k++) {
        const p = outline[k], t = j / n, x = lerp(cx, p.x, t), z = lerp(cz, p.z, t);
        verts.push([x, j < n ? onBed(ctx, x, z, lerp(yc, p.y, t)) : p.y, z]);
      }
    }
    const vi = (j, k) => (j === 0 ? 0 : 1 + (j - 1) * K + (k % K));
    const up = sign > 0;    // with x east and z south, a turn of increasing angle is clockwise from above
    const tri = (a, b, c) => (up ? tris.push(a, c, b) : tris.push(a, b, c));
    for (let k = 0; k < K; k++) tri(vi(0, 0), vi(1, k), vi(1, k + 1));
    for (let j = 1; j < n; j++) for (let k = 0; k < K; k++) {
      tri(vi(j, k), vi(j + 1, k), vi(j + 1, k + 1));
      tri(vi(j, k), vi(j + 1, k + 1), vi(j, k + 1));
    }
    clearTerrain(ctx, verts, tris, 1 + (n - 1) * K);
  } else {
    J.fallback = true;
    const shape = outline.map(p => new THREE.Vector2(p.x, p.z));
    for (const p of outline) verts.push([p.x, p.y, p.z]);
    const faces = THREE.ShapeUtils.triangulateShape(shape, []);
    for (const [a, b, c] of faces) {
      // keep them facing up
      const n = faceNormal(verts[a], verts[b], verts[c]);
      if (n[1] >= 0) tris.push(a, b, c); else tris.push(a, c, b);
    }
  }
  // smooth normals, world UVs
  const nrm = verts.map(() => [0, 0, 0]);
  for (let t = 0; t < tris.length; t += 3) {
    const n = faceNormal(verts[tris[t]], verts[tris[t + 1]], verts[tris[t + 2]]);
    for (let q = 0; q < 3; q++) { const m = nrm[tris[t + q]]; m[0] += n[0]; m[1] += n[1]; m[2] += n[2]; }
  }
  for (let i = 0; i < verts.length; i++) {
    const [x, y, z] = verts[i], m = nrm[i], l = Math.hypot(m[0], m[1], m[2]) || 1;
    soup.v(x, y, z, m[0] / l, m[1] / l, m[2] / l, x / UV_ASPHALT, -z / UV_ASPHALT, C.white);
  }
  for (let t = 0; t < tris.length; t += 3) soup.t(base + tris[t], base + tris[t + 1], base + tris[t + 2]);
  J.verts = verts; J.tris = tris;
  // a coarse lookup for the paint: the triangles under each 4 m cell of the junction's box
  J.cells = triCells(verts, tris);
}

// The terrain mesh's 2 m vertices can stand over a triangle the rings span (the bed bulging between ring
// points, a ridge where two roads' beds meet). Each one under the junction is kept JCT_CLEAR under its
// surface: the triangle's inner corners (index < fixed; the outline's stay, matched to the ribbons) are
// lifted just enough, by at most 0.3 m, the largest lift each corner needs, over a few passes.
const JCT_CLEAR = 0.05;
function clearTerrain(ctx, verts, tris, fixed) {
  for (let pass = 0; pass < 3; pass++) {
    const lift = new Float64Array(verts.length);
    let any = false;
    for (let t = 0; t < tris.length; t += 3) {
      const ia = tris[t], ib = tris[t + 1], ic = tris[t + 2], a = verts[ia], b = verts[ib], c = verts[ic];
      const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
      if (Math.abs(d) < 1e-9) continue;
      const i0 = Math.ceil(Math.min(a[0], b[0], c[0]) / 2), i1 = Math.floor(Math.max(a[0], b[0], c[0]) / 2);
      const j0 = Math.ceil(Math.min(a[2], b[2], c[2]) / 2), j1 = Math.floor(Math.max(a[2], b[2], c[2]) / 2);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = i * 2, z = j * 2;
        const u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d, v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d, w = 1 - u - v;
        if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
        const need = ctx.terrainY(x, z) + JCT_CLEAR - (u * a[1] + v * b[1] + w * c[1]);
        if (need <= 0) continue;
        const free = (ia < fixed ? u : 0) + (ib < fixed ? v : 0) + (ic < fixed ? w : 0);
        if (free < 0.05) continue;
        const dy = Math.min(0.3, need / free);
        for (const q of [ia, ib, ic]) if (q < fixed && dy > lift[q]) { lift[q] = dy; any = true; }
      }
    }
    if (!any) return;
    for (let q = 0; q < fixed; q++) verts[q][1] += lift[q];
  }
}

// The centres a junction's rings may close in on, best first (the node, the outline's centroid (mx, mz), half
// way between), then every point of a half-metre lattice over the outline's box, nearest the node first.
function* centres(outline, x0, z0, mx, mz) {
  yield [x0, z0]; yield [mx, mz]; yield [(x0 + mx) / 2, (z0 + mz) / 2];
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const p of outline) { a = Math.min(a, p.x); b = Math.min(b, p.z); c = Math.max(c, p.x); d = Math.max(d, p.z); }
  const pts = [];
  for (let z = b + 0.25; z < d; z += 0.5) for (let x = a + 0.25; x < c; x += 0.5) pts.push([x, z, (x - x0) ** 2 + (z - z0) ** 2]);
  pts.sort((p, q) => p[2] - q[2]);
  for (const p of pts) yield p;
}

// The road surface over the carved bed at (x, z): the terrain mesh plus the bed's 0.20 m (GROUND, where the
// physics has road), kept within reach of y, the height the design surfaces would give (so a point that
// strays off the bed, or over water, keeps its design height).
function onBed(ctx, x, z, y) { return clamp(ctx.terrainY(x, z) + BED, y - 0.1, y + 1.5); }

// +1 or -1 (the way it turns) when the outline's angle round (x, z) moves one way only, all the way round
// once: then every outline point sees (x, z). 0 otherwise.
function starSign(outline, x, z) {
  const K = outline.length;
  let turn = 0, sign = 0;
  for (let k = 0; k < K; k++) {
    const p = outline[k], q = outline[(k + 1) % K];
    let d = Math.atan2(q.z - z, q.x - x) - Math.atan2(p.z - z, p.x - x);
    d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
    if (Math.abs(d) < 1e-6) return 0;
    if (!sign) sign = Math.sign(d); else if (Math.sign(d) !== sign) return 0;
    turn += d;
  }
  return Math.abs(Math.abs(turn) - 2 * Math.PI) < 1e-3 ? sign : 0;
}

function triCells(verts, tris) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, , z] of verts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const S = 2, w = Math.max(1, Math.ceil((x1 - x0) / S) + 1), h = Math.max(1, Math.ceil((z1 - z0) / S) + 1), cells = new Array(w * h);
  // each triangle: its corners (x, y, z) and the denominator of its barycentric coordinates
  const T = new Float64Array(tris.length / 3 * 10);
  for (let t = 0, q = 0; t < tris.length; t += 3, q += 10) {
    const a = verts[tris[t]], b = verts[tris[t + 1]], c = verts[tris[t + 2]];
    T[q] = a[0]; T[q + 1] = a[1]; T[q + 2] = a[2]; T[q + 3] = b[0]; T[q + 4] = b[1]; T[q + 5] = b[2]; T[q + 6] = c[0]; T[q + 7] = c[1]; T[q + 8] = c[2];
    T[q + 9] = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    const i0 = Math.floor((Math.min(a[0], b[0], c[0]) - x0) / S), i1 = Math.floor((Math.max(a[0], b[0], c[0]) - x0) / S);
    const j0 = Math.floor((Math.min(a[2], b[2], c[2]) - z0) / S), j1 = Math.floor((Math.max(a[2], b[2], c[2]) - z0) / S);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) (cells[j * w + i] ||= []).push(q);
  }
  return { x0, z0, w, h, S, cells, T };
}

// The junction mesh's height at (x, z), or NaN off it.
function junctionY(J, x, z) {
  const L = J.cells;
  if (!L) return NaN;
  const i = Math.floor((x - L.x0) / L.S), j = Math.floor((z - L.z0) / L.S);
  if (i < 0 || j < 0 || i >= L.w || j >= L.h) return NaN;
  const T = L.T;
  for (const q of L.cells[j * L.w + i] || []) {
    const d = T[q + 9];
    if (Math.abs(d) < 1e-12) continue;
    const cx = T[q + 6], cz = T[q + 8];
    const u = ((T[q + 5] - cz) * (x - cx) + (cx - T[q + 3]) * (z - cz)) / d;
    if (u < -1e-6) continue;
    const v = ((cz - T[q + 2]) * (x - cx) + (T[q] - cx) * (z - cz)) / d, w = 1 - u - v;
    if (v >= -1e-6 && w >= -1e-6) return u * T[q + 1] + v * T[q + 4] + w * T[q + 7];
  }
  return NaN;
}

// Sidewalks (or verges) round each corner, along its kerb path; a sidewalk that meets a verge corner, a dead
// end or a bridge gets an end cap.
function cornerPieces(ctx, J) {
  if (J.dead) { deadEnd(ctx, J); return; }
  for (const c of J.corners) {
    const path = c.path;
    if (!path || path.length < 2) continue;
    const F = pathFrames(path), walk = c.A.walk[1] > 0 && c.B.walk[-1] > 0;
    // the outside is on the path's left
    const parts = walk ? sidePartsOf(0, -1, 0, 1) : sidePartsOf(0, -1, 0);
    sweep(ctx, F, 0, F.n - 1, parts, t => t.concrete);
    if (!walk) {
      if (c.A.walk[1] > 0) endCap(ctx, c.A.E, stOf(c.A, c.A.mouth), c.A.sgn, -c.A.sgn);
      if (c.B.walk[-1] > 0) endCap(ctx, c.B.E, stOf(c.B, c.B.mouth), -c.B.sgn, -c.B.sgn);
    }
  }
}

// A dead end (the villa's drive, the jet apron): the carriageway rounds off in a half disc of its own width
// past the end, as SURF's round cap has it, its kerb and sidewalk (or verge) carried round. Dirt tracks just
// stop.
function deadEnd(ctx, J) {
  const A = J.ends[0];
  if (!A || A.E.cls === 'dirt') return;
  const hw = A.E.hw, u = endDir(A, 0), rx = -u[1], rz = u[0], N = endPoint(A, 0, 0);
  const yR = endPoint(A, 0, hw).y, yL = endPoint(A, 0, -hw).y, n = 14, pts = [];
  // from the end's right kerb round the far side to its left (the outside on the path's left)
  for (let k = 0; k <= n; k++) {
    const th = Math.PI * k / n, c = Math.cos(th), s = Math.sin(th);
    pts.push({ x: N.x + (rx * c - u[0] * s) * hw, z: N.z + (rz * c - u[1] * s) * hw, y: lerp(yR, yL, k / n), tb: 0, w: lerp(A.walk[1], A.walk[-1], k / n),
      tx: -rx * s - u[0] * c, tz: -rz * s - u[1] * c });
  }
  const soup = ctx.tileAt(N.x, N.z).asphalt, up = [0, 1, 0];
  const c0 = soup.v(N.x, N.y, N.z, 0, 1, 0, N.x / UV_ASPHALT, -N.z / UV_ASPHALT, C.white);
  for (const p of pts) soup.v(p.x, p.y, p.z, up[0], up[1], up[2], p.x / UV_ASPHALT, -p.z / UV_ASPHALT, C.white);
  const flip = faceNormal([N.x, N.y, N.z], [pts[0].x, pts[0].y, pts[0].z], [pts[1].x, pts[1].y, pts[1].z])[1] < 0;
  for (let k = 0; k < n; k++) { if (flip) soup.t(c0, c0 + k + 2, c0 + k + 1); else soup.t(c0, c0 + k + 1, c0 + k + 2); }
  const walk = A.walk[1] > 0 && A.walk[-1] > 0;
  sweep(ctx, pathFrames(pts), 0, n, walk ? sidePartsOf(0, -1, 0, 1) : sidePartsOf(0, -1, 0), t => t.concrete);
  if (!walk) for (const side of [-1, 1]) if (A.walk[side] > 0) endCap(ctx, A.E, stOf(A, 0), side * A.sgn, -A.sgn);
}

// The open end of a sidewalk ribbon at station s on edge side `side`, facing `face` (-1: back down the edge,
// +1: on along it): the kerb, slab and bevel closed down to the road.
function endCap(ctx, E, s, side, face) {
  const w = walkOf(E, side, s);
  if (!(w > 0)) return;
  const f = at(E, s), hw = E.hw, k = side * hw;
  const P = (o, g) => {
    const x = f.x - f.tz * o, z = f.z + f.tx * o;
    return [x, g === undefined ? f.y - o * f.tb : ctx.terrainY(x, z) + g, z];
  };
  const k0 = P(k), k1 = P(k), o1 = P(k + side * w), v = P(k + side * (w + VERGE_WALK), SNAP), base = P(k + side * (w + VERGE_WALK));
  k1[1] += CURB_H; o1[1] += CURB_H;
  o1[1] = Math.max(o1[1], Math.min(ctx.terrainY(o1[0], o1[2]) + SNAP, o1[1] + RISE_MAX));    // (as the slab's outer edge)
  base[1] = Math.min(base[1], v[1]);
  const soup = ctx.tileAt(f.x, f.z).concrete;
  const poly = [k0, k1, o1, v, base];
  const n = [f.tx * face, 0, f.tz * face];
  const i = soup.v(poly[0][0], poly[0][1], poly[0][2], n[0], n[1], n[2], 0.25, 0.25, C.kerb);
  for (let q = 1; q < poly.length; q++) soup.v(poly[q][0], poly[q][1], poly[q][2], n[0], n[1], n[2], 0.25, 0.25, C.kerb);
  // a fan from the kerb's foot, wound to face `face`
  const fn = faceNormal(poly[0], poly[1], poly[2]), flip = fn[0] * n[0] + fn[2] * n[2] < 0;
  for (let q = 1; q + 1 < poly.length; q++) { if (flip) soup.t(i, i + q + 1, i + q); else soup.t(i, i + q, i + q + 1); }
}

// ---------- edges: ribbons ----------

// The offsets (m right of the centre) of an edge's carriageway cross-section at station s, left to right: the
// kerbs, the start of a kerb's roll-up where it has no sidewalk, a raised median's two kerbs (null between
// them: no asphalt there), and enough points between that no strip is wider than STRIP_MAX, so a strip that
// twists along a change of banking stays within a few millimetres of the plane the paint is laid on.
const STRIP_MAX = 3;
function asphaltPts(E, s) {
  const hw = E.hw, key = [];
  key.push(-hw);
  if (walkOf(E, -1, s) <= 0) key.push(-hw + ROLL);
  if (E.raised) key.push(-E.median / 2, null, E.median / 2); else key.push(0);
  if (walkOf(E, 1, s) <= 0) key.push(hw - ROLL);
  key.push(hw);
  const out = [key[0]];
  for (let k = 1; k < key.length; k++) {
    const a = key[k - 1], b = key[k];
    if (a !== null && b !== null) { const n = Math.ceil((b - a) / STRIP_MAX - 1e-9); for (let q = 1; q < n; q++) out.push(a + (b - a) * q / n); }
    out.push(b);
  }
  return out;
}

// An edge's carriageway, kerbs, sidewalks and verges from mouth to mouth, leaving out its bridge decks (the
// bridges carry those). Dirt tracks are drawn in the terrain's own material, verges and all.
function edgeRibbons(ctx, E) {
  const s0 = E.mouthA, s1 = E.len - E.mouthB;
  if (s1 - s0 < 0.1) return;
  // the land runs between the decks
  const runs = [];
  let a = s0;
  for (const [d0, d1] of E.deck) {
    if (d1 <= a || d0 >= s1) continue;
    if (d0 > a + 0.1) runs.push([a, Math.min(d0, s1)]);
    a = Math.max(a, d1);
  }
  if (s1 > a + 0.1) runs.push([a, s1]);
  const hw = E.hw, dirt = E.cls === 'dirt' && ctx.dirtOk;
  for (const [r0, r1] of runs) {
    const F = edgeFrames(E, r0, r1);
    if (dirt) {
      // the track and its verges in the terrain's own material: dirt, fading to grass at the verges' edge
      const inL = { o: -hw, dy: 0, c: DIRT_SPLAT }, inR = { o: hw, dy: 0, c: DIRT_SPLAT };
      sweep(ctx, F, 0, F.n - 1, [
        [{ o: -hw - VERGE_RURAL, g: SNAP, c: GRASS_SPLAT }, inL, DIRT_SPLAT, 'flat'],
        [inL, inR, DIRT_SPLAT, 'flat'],
        [inR, { o: hw + VERGE_RURAL, g: SNAP, c: GRASS_SPLAT }, DIRT_SPLAT, 'flat'],
      ], t => t.dirt);
      continue;
    }
    const pts = asphaltPts(E, (r0 + r1) / 2).map(o => (o === null ? null : { o, roll: Math.abs(o) === hw && walkOf(E, Math.sign(o), (r0 + r1) / 2) <= 0 ? 1 : 0 }));
    const parts = [];
    for (let k = 0; k + 1 < pts.length; k++) if (pts[k] && pts[k + 1]) parts.push([pts[k], pts[k + 1], C.white, 'world']);
    sweep(ctx, F, 0, F.n - 1, parts, t => t.asphalt);
    // the median island, the sidewalks or verges either side (a promenade comes and goes with the decks)
    const conc = [];
    if (E.raised) conc.push(...medianParts(E.median));
    for (const side of [-1, 1]) conc.push(...sidePartsOf(side * hw, side, walkOf(E, side, (r0 + r1) / 2)));
    sweep(ctx, F, 0, F.n - 1, conc, t => t.concrete);
    if (E.raised) for (const s of [r0, r1]) medianNose(ctx, E, s, s === r0 ? -1 : 1);
    // the Loop's palms on the causeway fill stand in kerbed islands down its median
    for (const [a, b] of E.palmRuns) {
      const p0 = Math.max(a, r0), p1 = Math.min(b, r1);
      if (p1 - p0 < 4) continue;
      const M = edgeFrames(E, p0, p1);
      sweep(ctx, M, 0, M.n - 1, medianParts(E.median), t => t.concrete);
      medianNose(ctx, E, p0, -1); medianNose(ctx, E, p1, 1);
    }
    // a run that stops at a deck leaves its sidewalks open there
    for (const s of [r0, r1]) if (s > s0 + 0.05 && s < s1 - 0.05) for (const side of [-1, 1]) endCap(ctx, E, s, side, s === r0 ? -1 : 1);
  }
}

// The end of a raised median at station s, facing face (-1 back down the edge, +1 on): a kerb face across.
function medianNose(ctx, E, s, face) {
  const h = E.median / 2, f = at(E, s);
  const P = (o, dy) => [f.x - f.tz * o, f.y - o * f.tb + dy, f.z + f.tx * o];
  const a = P(-h, 0), b = P(h, 0), c = P(h, CURB_H), d = P(-h, CURB_H);
  const soup = ctx.tileAt(f.x, f.z).concrete, uv = [[0, 0], [0.75, 0], [0.75, 0.04], [0, 0.04]];
  // counter-clockwise seen from where it faces
  const fn = faceNormal(a, b, c);
  if (fn[0] * f.tx * face + fn[2] * f.tz * face >= 0) soup.quad([a, b, c, d], uv, C.kerb);
  else soup.quad([b, a, d, c], uv, C.kerb);
}

// ---------- paint ----------

// The lines a class carries (o right of the centre; kind 'edge' lines stop where another road joins a
// through junction): [o, width, colour, dash [on, off] or null, kind].
function linesOf(E) {
  const m = E.median / 2, L = E.laneW, Y = C.yellow, W = C.white, both = (o, w, c, d, k) => [[-o, w, c, d, k], [o, w, c, d, k]];
  switch (E.cls) {
    case 'hwy': return [...both(m + 0.15, 0.15, Y, null, 'median'), ...both(m + L, 0.15, W, [3, 9], 'lane'), ...both(m + 2 * L + 0.1, 0.2, W, null, 'edge')];
    case 'blvd': return both(m + L, 0.15, W, [3, 9], 'lane');
    case 'ave': return [...both(0.15, 0.12, Y, null, 'centre'), ...both(L, 0.12, W, null, 'edge')];
    case 'street': return [[0, 0.12, Y, [3, 5], 'centre']];
    case 'coast': case 'country': case 'switch': return [...both(0.15, 0.12, Y, null, 'centre'), ...both(L + 0.1, 0.15, W, null, 'edge')];
    case 'ring': return both(L / 2 - 0.15, 0.15, W, null, 'edge');
    default: return [];
  }
}

// The surface under paint at (x, z) near station s of edge E: a junction's mesh within its mouths, else the
// edge's design surface (o right of it).
// (f: the edge's frame at s, already looked up)
function paintY(ctx, E, s, o, x, z, f) {
  if (s < E.mouthA - 1e-6 || s > E.len - E.mouthB + 1e-6) {
    const J = s < E.mouthA ? ctx.junctionOf(E.a) : ctx.junctionOf(E.b), y = J ? junctionY(J, x, z) : NaN;
    if (!Number.isNaN(y)) return y;
  }
  return f.y - o * f.tb + liftAt(E, f, o);
}

// A painted band on edge E from station s0 to s1 between offsets o0 and o1 (a dash, a bar, a zebra stripe),
// cut at the edge's samples so it lies on the surface, each piece in the tile under it.
// On a junction's mesh (within a mouth) the surface bends between its rings, so a band there is cut every
// metre along and across, each corner on the mesh.
function band(ctx, E, s0, s1, o0, o1, col) {
  if (s1 - s0 < 1e-3) return;
  const onJct = s0 < E.mouthA - 1e-6 || s1 > E.len - E.mouthB + 1e-6, st = [s0];
  if (onJct) { const m = Math.ceil((s1 - s0) - 1e-6); for (let q = 1; q < m; q++) st.push(s0 + (s1 - s0) * q / m); }
  else for (let k = sampleAfter(E, s0 + 0.05); k < E.n && E.S[k] < s1 - 0.05; k++) st.push(E.S[k]);
  st.push(s1);
  const f = { ..._f };
  const corner = (s, o) => {
    at(E, s, f);
    const x = f.x - f.tz * o, z = f.z + f.tx * o;
    return [x, paintY(ctx, E, s, o, x, z, f) + LIFT, z];
  };
  const across = onJct ? Math.max(1, Math.ceil((o1 - o0) - 1e-6)) : 1;
  for (let c = 0; c < across; c++) {
    const oa = lerp(o0, o1, c / across), ob = lerp(o0, o1, (c + 1) / across);
    let pa = corner(st[0], oa), pb = corner(st[0], ob);
    for (let k = 1; k < st.length; k++) {
      const qa = corner(st[k], oa), qb = corner(st[k], ob);
      const soup = ctx.tileAt((pa[0] + qb[0]) / 2, (pa[2] + qb[2]) / 2).paint;
      const uv = [pa, pb, qb, qa].map(p => [p[0] / UV_ASPHALT, -p[2] / UV_ASPHALT]);
      // oa < ob is left to right: (pa, pb, qb, qa) runs counter-clockwise seen from above
      soup.quad([pa, pb, qb, qa], uv, col);
      pa = qa; pb = qb;
    }
  }
}

// A line along stations [s0, s1] of E (dashes phased on the road's own station, so they continue edge to edge).
function line(ctx, E, s0, s1, [o, w, col, dash]) {
  if (s1 - s0 < 0.05) return;
  if (!dash) { band(ctx, E, s0, s1, o - w / 2, o + w / 2, col); return; }
  const [on, off] = dash, P = on + off, r0 = E.rs + s0;
  for (let d = Math.floor(r0 / P) * P; d < E.rs + s1; d += P) {
    const a = Math.max(s0, d - E.rs), b = Math.min(s1, d + on - E.rs);
    if (b > a + 0.05) band(ctx, E, a, b, o - w / 2, o + w / 2, col);
  }
}

// An edge's lines from mouth to mouth (on and off its decks), stopping short of a stop bar or crossing.
function edgePaint(ctx, E) {
  const lines = linesOf(E);
  if (!lines.length) return;
  const s0 = Math.max(E.mouthA, E.stopA || 0), s1 = E.len - Math.max(E.mouthB, E.stopB || 0);
  for (const L of lines) line(ctx, E, s0, s1, L);
}

// A junction's own paint: stop bars or give-way teeth on the approaches that stop or yield, zebra crossings
// where the walk graph crosses, and the priority road's lines carried through (centre and lanes, and its edge
// lines on any side no other road joins).
function junctionPaint(ctx, J) {
  if (J.dead) return;
  const N = J.N, kind = N.control;
  // crossings: the walk graph's cross paths on this node's ends
  const crossOn = new Map();
  for (const p of ctx.crossings.get(N.id) || []) crossOn.set(p.end, p);
  // the lines on an end stop this far from the node (past its crossing and its stop bar)
  const clear = (A, d) => { if (A.start) A.E.stopA = Math.max(A.E.stopA || 0, d); else A.E.stopB = Math.max(A.E.stopB || 0, d); };
  // Every piece drawn is kept (its corners on the ground) so a later one that would lie over it is left out:
  // at a skewed or tight junction one approach's crossing reaches over the next one's. Crossings go first.
  J.marks = [];
  for (const A of J.ends) {
    const cross = crossOn.get(A);
    if (cross) { zebra(ctx, J, A, cross.d); clear(A, cross.d + 1.8); }
  }
  for (const A of J.ends) {
    const E = A.E, cross = crossOn.get(A);
    const stops = kind === 'allway' || kind === 'signal' || (kind === 'priority' && !(N.major || []).includes(A.idx));
    if (!stops || E.single) continue;
    // where cars stop: the lane ends (the RoadNet's trim), behind the crossing if there is one
    const trim = (N.ends[A.idx]?.trim || 0) / PX;
    let d = Math.max(trim, 1);
    if (cross) d = Math.max(d, cross.d + 2.6);
    d = Math.min(d, A.E.len * 0.45);
    // the arriving lanes are on the end's left (traffic heads into the node on its right); a one-way road
    // arrives only at its far end
    if (E.oneway && A.start) continue;
    const o0 = E.oneway ? -E.hw + 0.3 : -(E.median / 2 + E.lanes * E.laneW), o1 = E.oneway ? E.hw - 0.3 : -E.median / 2 - 0.1;
    if (N.kind === 'ring') { teeth(ctx, A, d, o0, o1); clear(A, d + 1.4); } else { bar(ctx, J, A, d, o0, o1); clear(A, d + 0.6); }
  }
  if (kind === 'priority' && (N.kind === 'T' || N.kind === 'ring')) throughLines(ctx, J);
}

// A white band across an end from d0 to d1 metres out, between end offsets o0 < o1 (right of the end), unless
// it would lie over a piece of the junction's paint already down (J.marks).
function endBand(ctx, J, A, d0, d1, o0, o1) {
  const quad = [[d0, o0], [d1, o0], [d1, o1], [d0, o1]].map(([d, o]) => { const p = endPoint(A, d, o); return [p.x, p.z]; });
  if (J.marks.some(q => overlaps(q, quad))) return;
  J.marks.push(quad);
  // end offsets to edge offsets: the end's right is the edge's right when the edge starts here
  const s0 = stOf(A, d0), s1 = stOf(A, d1), e0 = A.sgn * o0, e1 = A.sgn * o1;
  band(ctx, A.E, Math.min(s0, s1), Math.max(s0, s1), Math.min(e0, e1), Math.max(e0, e1), C.white);
}
function bar(ctx, J, A, d, o0, o1) { endBand(ctx, J, A, d - 0.25, d + 0.25, o0, o1); }
function zebra(ctx, J, A, d) {
  const hw = A.E.hw - 0.4;
  for (let o = -hw; o + 0.5 <= hw + 1e-6; o += 1.0) endBand(ctx, J, A, d - 1.5, d + 1.5, o, o + 0.5);
}
// whether two convex quads ([x, z] corners) overlap (separating axes)
function overlaps(P, Q) {
  for (const R of [P, Q]) for (let k = 0; k < R.length; k++) {
    const a = R[k], b = R[(k + 1) % R.length], nx = b[1] - a[1], nz = a[0] - b[0];
    let p0 = Infinity, p1 = -Infinity, q0 = Infinity, q1 = -Infinity;
    for (const v of P) { const d = v[0] * nx + v[1] * nz; p0 = Math.min(p0, d); p1 = Math.max(p1, d); }
    for (const v of Q) { const d = v[0] * nx + v[1] * nz; q0 = Math.min(q0, d); q1 = Math.max(q1, d); }
    if (p1 <= q0 || q1 <= p0) return false;
  }
  return true;
}
// give-way teeth: a row of triangles pointing at the arriving driver
function teeth(ctx, A, d, o0, o1) {
  const E = A.E, n = Math.max(1, Math.floor((o1 - o0) / 0.9));
  const step = (o1 - o0) / n, f = { ..._f };
  for (let k = 0; k < n; k++) {
    const oa = o0 + k * step + 0.15, ob = o0 + (k + 1) * step - 0.15, om = (oa + ob) / 2;
    const P = (dd, o) => {
      const s = stOf(A, dd), eo = A.sgn * o;
      at(E, s, f);
      const x = f.x - f.tz * eo, z = f.z + f.tx * eo;
      return [x, paintY(ctx, E, s, eo, x, z, f) + LIFT, z];
    };
    // base at the give-way line, tip pointing back at the arriving driver
    const p = [P(d, oa), P(d, ob), P(d + 0.8, om)];
    const n2 = faceNormal(p[0], p[1], p[2]), tri = n2[1] >= 0 ? p : [p[0], p[2], p[1]];
    const soup = ctx.tileAt(p[2][0], p[2][2]).paint, nn = faceNormal(tri[0], tri[1], tri[2]);
    const i = soup.v(tri[0][0], tri[0][1], tri[0][2], nn[0], nn[1], nn[2], tri[0][0] / UV_ASPHALT, -tri[0][2] / UV_ASPHALT, C.white);
    soup.v(tri[1][0], tri[1][1], tri[1][2], nn[0], nn[1], nn[2], tri[1][0] / UV_ASPHALT, -tri[1][2] / UV_ASPHALT, C.white);
    soup.v(tri[2][0], tri[2][1], tri[2][2], nn[0], nn[1], nn[2], tri[2][0] / UV_ASPHALT, -tri[2][2] / UV_ASPHALT, C.white);
    soup.t(i, i + 1, i + 2);
  }
}

// The priority road's lines across its junction: the two ends of one road that carry straight on, joined
// through the node (the arriving edge's last stretch and the leaving edge's first), on the junction's mesh.
function throughLines(ctx, J) {
  const major = (J.N.major || []).map(i => J.ends.find(A => A.idx === i)).filter(Boolean);
  const pair = major.length === 2 ? major : J.N.kind === 'ring' ? J.ends.filter(A => A.E.cls === 'ring') : [];
  if (pair.length !== 2 || pair[0].E.road !== pair[1].E.road) return;
  const In = pair.find(A => !A.start), Out = pair.find(A => A.start);
  if (!In || !Out) return;
  const u = endDir(Out, 0);
  // which sides other roads join on (right of the road's direction is +1)
  const sides = new Set();
  for (const A of J.ends) if (A !== In && A !== Out) { const v = endDir(A, 4); sides.add(Math.sign(v[0] * -u[1] + v[1] * u[0]) || 1); }
  for (const L of linesOf(In.E)) {
    if (L[4] === 'edge' && sides.has(Math.sign(L[0]))) continue;
    line(ctx, In.E, In.E.len - In.mouth, In.E.len, L);
    line(ctx, Out.E, 0, Out.mouth, L);
  }
}

// ---------- guardrails, cut walls, jumps ----------

// W-beam guardrails from placeProps: a galvanised beam at 0.5-0.8 m over the road's edge on posts every 2 m.
function guardrails(ctx) {
  for (const d of ctx.world.deco || []) {
    if (d.list !== 'guardrails' || d.kind !== 'wbeam') continue;
    const E = ctx.edges[d.edge];
    if (!E) continue;
    const pts = [];
    let hint = 0;
    for (let k = 0; k + 1 < d.pts.length; k += 2) {
      const x = d.pts[k] / PX, z = d.pts[k + 1] / PX, s = nearestStation(E, x, z, hint);
      hint = s;
      const f = at(E, s), o = E.hw * (d.side > 0 ? 1 : -1);
      pts.push({ x, z, y: f.y - o * f.tb, g: ctx.terrainY(x, z) });
    }
    if (pts.length < 2) continue;
    const F = pathFrames(pts.map(p => ({ x: p.x, z: p.z, y: p.y })));
    // the beam: a W-ish face to the road and a flat back, 0.48-0.80 m up
    const sgn = d.side > 0 ? 1 : -1;      // the road is on the rail's left when side > 0 along the edge's way
    const dir = Math.sign((F.X[F.n - 1] - F.X[0]) * E.TX[0] + (F.Z[F.n - 1] - F.Z[0]) * E.TZ[0]) || 1;
    const roadSide = -sgn * dir;          // -1: the road is on the path's left
    const face = [0.8, 0.72, 0.64, 0.56, 0.48], back = 0.05;
    const parts = [];
    for (let q = 0; q + 1 < face.length; q++) {
      const ia = q % 2 ? 0.07 : 0, ib = (q + 1) % 2 ? 0.07 : 0;
      const a = { o: roadSide * ia, dy: face[q], u: 0.25 }, b = { o: roadSide * ib, dy: face[q + 1], u: 0.25 };
      parts.push(roadSide < 0 ? [b, a, C.rail, 'flat'] : [a, b, C.rail, 'flat']);
    }
    const tA = { o: 0, dy: 0.8 }, tB = { o: -roadSide * back, dy: 0.8 }, bA = { o: -roadSide * back, dy: 0.8 }, bB = { o: -roadSide * back, dy: 0.48 };
    parts.push(roadSide < 0 ? [tA, tB, C.rail, 'flat'] : [tB, tA, C.rail, 'flat']);
    parts.push(roadSide < 0 ? [bA, bB, C.rail, 'flat'] : [bB, bA, C.rail, 'flat']);
    sweep(ctx, F, 0, F.n - 1, parts, t => t.concrete);
    // posts behind the beam
    for (let k = 0; k < F.n; k++) {
      const x = F.X[k] - F.TZ[k] * -roadSide * 0.12, z = F.Z[k] + F.TX[k] * -roadSide * 0.12;
      box(ctx.tileAt(x, z).concrete, x, z, ctx.terrainY(x, z) - 0.3, F.Y[k] + 0.78, 0.075, 0.075, Math.atan2(F.TZ[k], F.TX[k]), C.post);
    }
  }
}

// the edge station nearest (x, z), searching from a hint outwards
function nearestStation(E, x, z, hint = 0) {
  let best = 0, bd = Infinity;
  for (let k = 0; k + 1 < E.n; k++) {
    const ax = E.X[k], az = E.Z[k], dx = E.X[k + 1] - ax, dz = E.Z[k + 1] - az, L2 = dx * dx + dz * dz;
    const t = L2 > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1) : 0, d = Math.hypot(ax + dx * t - x, az + dz * t - z);
    if (d < bd) { bd = d; best = E.S[k] + (E.S[k + 1] - E.S[k]) * t; }
  }
  return best;
}

// An upright box centred on (x, z) from y0 to y1, ha half-length along heading a, hb half-width across it.
function box(soup, x, z, y0, y1, ha, hb, a, col, { top = true, bottom = false } = {}) {
  const ca = Math.cos(a), sa = Math.sin(a);
  const P = (u, v, y) => [x + ca * u - sa * v, y, z + sa * u + ca * v];
  const c = [P(-ha, -hb), P(ha, -hb), P(ha, hb), P(-ha, hb)].map(p => [p[0], 0, p[2]]);
  for (let k = 0; k < 4; k++) {
    const p = c[k], q = c[(k + 1) % 4], L = Math.hypot(q[0] - p[0], q[2] - p[2]) / UV_CONCRETE, H = (y1 - y0) / UV_CONCRETE;
    // the outside of a counter-clockwise (seen from above, z south) footprint: p, q at the bottom, then up
    soup.quad([[p[0], y0, p[2]], [p[0], y1, p[2]], [q[0], y1, q[2]], [q[0], y0, q[2]]], [[0, 0], [0, H], [L, H], [L, 0]], col);
  }
  if (top) soup.quad([[c[0][0], y1, c[0][2]], [c[3][0], y1, c[3][2]], [c[2][0], y1, c[2][2]], [c[1][0], y1, c[1][2]]], [[0, 0], [0, 1], [1, 1], [1, 0]], col);
  if (bottom) soup.quad([[c[0][0], y0, c[0][2]], [c[1][0], y0, c[1][2]], [c[2][0], y0, c[2][2]], [c[3][0], y0, c[3][2]]], [[0, 0], [1, 0], [1, 1], [0, 1]], col);
}

// A beam from p to q (each [x, y, z]) with a w x w square section (stays, hangers, braces).
function beam(soup, p, q, w, col) {
  const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2], L = Math.hypot(dx, dy, dz);
  if (L < 1e-6) return;
  const t = [dx / L, dy / L, dz / L];
  // two directions across the beam
  let a = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u = [t[1] * a[2] - t[2] * a[1], t[2] * a[0] - t[0] * a[2], t[0] * a[1] - t[1] * a[0]];
  const ul = Math.hypot(...u); u = u.map(v => v / ul * w / 2);
  const v = [t[1] * u[2] - t[2] * u[1], t[2] * u[0] - t[0] * u[2], t[0] * u[1] - t[1] * u[0]];
  const corner = (o, su, sv) => [o[0] + u[0] * su + v[0] * sv, o[1] + u[1] * su + v[1] * sv, o[2] + u[2] * su + v[2] * sv];
  const ring = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  const uv = [[0.25, 0.25], [0.25, 0.25], [0.25, 0.25], [0.25, 0.25]];
  for (let k = 0; k < 4; k++) {
    const [a1, b1] = ring[k], [a2, b2] = ring[(k + 1) % 4];
    const quad = [corner(p, a1, b1), corner(q, a1, b1), corner(q, a2, b2), corner(p, a2, b2)];
    // face outward: away from the beam's axis
    const n = faceNormal(quad[0], quad[1], quad[2]), mid = [(quad[0][0] + quad[2][0]) / 2 - (p[0] + q[0]) / 2, (quad[0][1] + quad[2][1]) / 2 - (p[1] + q[1]) / 2, (quad[0][2] + quad[2][2]) / 2 - (p[2] + q[2]) / 2];
    if (n[0] * mid[0] + n[1] * mid[1] + n[2] * mid[2] < 0) quad.reverse();
    soup.quad(quad, uv, col);
  }
}

// A quad (corners in order round it) wound to face d ([x, y, z]: only its sign against the normal counts).
function quadFacing(soup, q, uv, col, d) {
  const n = faceNormal(q[0], q[1], q[2]);
  if (n[0] * d[0] + n[1] * d[1] + n[2] * d[2] >= 0) soup.quad(q, uv, col);
  else soup.quad([q[1], q[0], q[3], q[2]], [uv[1], uv[0], uv[3], uv[2]], col);
}
const UP = [0, 1, 0];

// Whether (x, z) stands within another edge's corridor (its carriageway and widest sidewalk, plus pad metres):
// a wall along one road stops where it would stand on another, so at a T the two roads' walls meet instead of
// crossing. The edges' segments are hashed by their middles in 16 m cells on first use.
function inOtherRoad(ctx, E, x, z, pad) {
  if (!ctx.segs) {
    ctx.segs = new Map();
    for (const O of ctx.edges) for (let k = 0; k + 1 < O.n; k++) {
      const key = Math.floor((O.X[k] + O.X[k + 1]) / 32) * 4096 + Math.floor((O.Z[k] + O.Z[k + 1]) / 32);
      (ctx.segs.get(key) || ctx.segs.set(key, []).get(key)).push(O, k);
    }
  }
  const ci = Math.floor(x / 16), cj = Math.floor(z / 16);
  for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
    const list = ctx.segs.get(i * 4096 + j);
    if (!list) continue;
    for (let q = 0; q < list.length; q += 2) {
      const O = list[q], k = list[q + 1];
      if (O === E) continue;
      const ax = O.X[k], az = O.Z[k], dx = O.X[k + 1] - ax, dz = O.Z[k + 1] - az, L2 = dx * dx + dz * dz;
      const t = L2 > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1) : 0;
      if (Math.hypot(ax + dx * t - x, az + dz * t - z) < O.hw + Math.max(O.walkL, O.walkR, O.promW) + pad) return true;
    }
  }
  return false;
}

// Kerb walls: where the ground right past a kerb without a sidewalk stands higher than the ROLL_MAX roll can
// clear (a steep side road's fill at a T, a pad's edge), a low coral-stone wall holds it back. Its face stands
// where the ground would come up through the asphalt (at most ROLL in from the kerb), its coping covers the
// ground out past the verge, up to KERB_WALL_H over the road (a steeper bank rises on behind it, as a hill
// comes down onto a wall), and behind it the slope is filled in, in the terrain's own material, up to the
// ground. It tapers to nothing at the station before and after the stretch that needs it.
const KERB_WALL = ROLL_MAX + 0.03, KERB_WALL_H = 0.8;
function kerbWalls(ctx) {
  for (const E of ctx.edges) {
    if (E.cls === 'dirt') continue;
    const s0 = E.mouthA, s1 = E.len - E.mouthB;
    for (const side of [-1, 1]) {
      const need = side > 0 ? E.needR : E.needL;
      for (let k = 0; k < E.n; k++) {
        if (!(need[k] > KERB_WALL) || E.S[k] < s0 || E.S[k] > s1) continue;
        let j = k;
        while (j + 1 < E.n && need[j + 1] > KERB_WALL && E.S[j + 1] <= s1) j++;
        const st = [Math.max(s0, E.S[k] - 2)];
        for (let q = k; q <= j; q++) if (E.S[q] > st[st.length - 1] + 0.05) st.push(E.S[q]);
        if (Math.min(s1, E.S[j] + 2) > st[st.length - 1] + 0.05) st.push(Math.min(s1, E.S[j] + 2));
        kerbWall(ctx, E, side, st);
        k = j;
      }
    }
  }
}

function kerbWall(ctx, E, side, st) {
  const n = st.length, hw = E.hw, back = hw + VERGE_RURAL + 0.1;
  if (n < 3) return;
  const rows = st.map(s => ({ s, f: at(E, s, {}) }));
  for (const r of rows) {
    const { f } = r, roll = side > 0 ? f.lr : f.ll;
    // offsets a (m out from the centre on this side): the ground and the (rolled) road surface there
    r.ground = (a) => ctx.terrainY(f.x - f.tz * side * a, f.z + f.tx * side * a);
    r.surface = (a) => f.y - side * a * f.tb + clamp((a - (hw - ROLL)) / ROLL, 0, 1) * roll;
    r.face = hw;
    for (let a = hw - ROLL; a <= hw + 1e-6; a += 0.1) if (r.ground(a) + KERB_CLEAR > r.surface(a)) { r.face = Math.max(hw - ROLL, a - 0.1); break; }
  }
  // the face runs as far in as either neighbour needs (so it stays straight), the ends taper to the road
  const face = rows.map((r, q) => Math.min(r.face, rows[Math.max(0, q - 1)].face, rows[Math.min(n - 1, q + 1)].face));
  const tile = ctx.tileAt(rows[n >> 1].f.x, rows[n >> 1].f.z), pts = [];
  rows.forEach((r, q) => {
    const a0 = face[q], foot = r.surface(a0) - 0.05;
    let top = r.surface(a0) + 0.3;
    for (let a = a0; a <= back + 1e-6; a += 0.25) top = Math.max(top, r.ground(a) + 0.12);
    top = Math.min(top, r.surface(a0) + KERB_WALL_H);
    if (q === 0 || q === n - 1) top = foot + 0.05;
    // behind the coping: the fill runs out until the ground comes up to the top (at most 3 m)
    let c = back + 0.5, yb = r.ground(c);
    while (c < back + 3 && yb < top - 0.15) { c += 0.5; yb = r.ground(c); }
    const P = (a, y) => [r.f.x - r.f.tz * side * a, y, r.f.z + r.f.tx * side * a];
    pts.push({ foot: P(a0, foot), top: P(a0, top), cope: P(back, top), back: P(c, Math.min(yb, top) - 0.05), h: top - foot });
  });
  for (let q = 0; q + 1 < n; q++) {
    const A = pts[q], B = pts[q + 1], f = rows[q].f, road = [f.tz * side, 0, -f.tx * side];
    const u0 = st[q] / UV_CONCRETE, u1 = st[q + 1] / UV_CONCRETE;
    quadFacing(tile.stone, [A.foot, B.foot, B.top, A.top], [[u0, 0], [u1, 0], [u1, B.h / UV_CONCRETE], [u0, A.h / UV_CONCRETE]], C.stone, road);
    quadFacing(tile.stone, [A.top, B.top, B.cope, A.cope], [[u0, 0], [u1, 0], [u1, 0.25], [u0, 0.25]], C.cap, UP);
    if (ctx.dirtOk) quadFacing(tile.dirt, [A.cope, B.cope, B.back, A.back], [[0, 0], [0, 0], [0, 0], [0, 0]], GRASS_SPLAT, UP);
  }
}

// Stone walls at the foot of cuttings deeper than CUT_WALL: where the ground half a blend width out from the
// road's bed stands that far over the road, a coral-stone wall stands at the bed's edge, 1.2-3.2 m tall, its
// coping running back into the slope (so no gap shows behind it). A wall stops where a kerb wall stands and
// where it would stand on another road (inOtherRoad), so the walls of a T's roads meet at its corner.
function cutWalls(ctx) {
  for (const E of ctx.edges) {
    if (E.cls === 'dirt' || E.cls === 'alley') continue;
    const s0 = E.mouthA + 2, s1 = E.len - E.mouthB - 2;
    if (s1 - s0 < WALL_MIN_RUN) continue;
    for (const side of [-1, 1]) {
      const solid = E.hw + walkOf(E, side), ow = side * (solid + 1.3), need = side > 0 ? E.needR : E.needL;
      // depth of the cut every 2 m (0 where no wall may stand)
      const st = [], depth = [];
      for (let s = s0; s <= s1; s += 2) {
        const f = at(E, s), x = f.x - f.tz * ow, z = f.z + f.tx * ow;
        st.push(s);
        if (onDeck(E, s) || Math.max(need[f.i], need[Math.min(E.n - 1, f.i + 1)]) > KERB_WALL || inOtherRoad(ctx, E, x, z, 1.1)) { depth.push(0); continue; }
        const o = side * (solid + 1 + E.blend * 0.5);
        depth.push(ctx.terrainY(f.x - f.tz * o, f.z + f.tx * o) - (f.y - ow * f.tb));
      }
      // runs over the threshold
      let i = 0;
      while (i < st.length) {
        if (depth[i] <= CUT_WALL) { i++; continue; }
        let j = i;
        while (j + 1 < st.length && depth[j + 1] > CUT_WALL * 0.8) j++;
        if (st[j] - st[i] >= WALL_MIN_RUN) wallRun(ctx, E, side, ow, st.slice(i, j + 1), depth.slice(i, j + 1));
        i = j + 1;
      }
    }
  }
}

// One run of cut wall. Its top line is the cut's depth over the foot, taken as the highest within 6 m either
// way and then smoothed, so it reads as one built wall rather than following every ripple of the slope; it
// eases down over its first and last 6 m.
function wallRun(ctx, E, side, ow, st, depth) {
  const n = st.length, foot = [], top = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const f = at(E, st[k]), x = f.x - f.tz * ow, z = f.z + f.tx * ow, y = ctx.terrainY(x, z);
    foot.push({ x, z, y, tx: f.tx * side, tz: f.tz * side });
    top[k] = y + 0.4 + clamp(0.35 * depth[k], 1.2, 3.2);
  }
  let T = top.map((_, k) => { let m = -Infinity; for (let q = Math.max(0, k - 3); q <= Math.min(n - 1, k + 3); q++) m = Math.max(m, top[q]); return m; });
  for (let pass = 0; pass < 3; pass++) T = T.map((v, k) => (T[Math.max(0, k - 1)] + 2 * v + T[Math.min(n - 1, k + 1)]) / 4);
  for (let k = 0; k < n; k++) {
    const ease = Math.min(1, (st[k] - st[0]) / 6, (st[n - 1] - st[k]) / 6), low = foot[k].y + 0.4 + 0.3;
    T[k] = Math.max(low, lerp(low, T[k], 0.25 + 0.75 * ease));
  }
  const tile = ctx.tileAt(foot[n >> 1].x, foot[n >> 1].z);
  // The face (from 0.4 m under the ground at its foot to the top), a coping COPING m deep, and behind it the
  // slope filled in, in the terrain's own material, down to the ground where the hillside reaches the top (at
  // most 6 m back, and never onto another road): from the road the hill seems to come down onto the wall.
  const COPING = 0.45, pts = [];
  for (let k = 0; k < n; k++) {
    const { x, z, tx, tz } = foot[k], bx = -tz, bz = tx;     // (b: away from the road)
    const y0 = foot[k].y - 0.4, y1 = T[k];
    let c = 1, yb = ctx.terrainY(x + bx, z + bz);
    for (let q = 2; q <= 12; q++) {
      const cc = 0.5 * q, px = x + bx * cc, pz = z + bz * cc;
      if (inOtherRoad(ctx, E, px, pz, 0.5)) break;
      c = cc; yb = ctx.terrainY(px, pz);
      if (yb >= y1 - 0.15) break;
    }
    pts.push({ foot: [x, y0, z], top: [x, y1, z], cope: [x + bx * COPING, y1, z + bz * COPING], back: [x + bx * c, Math.min(yb, y1) - 0.05, z + bz * c], road: [-bx, 0, -bz] });
  }
  for (let k = 0; k + 1 < n; k++) {
    const A = pts[k], B = pts[k + 1], u0 = st[k] / UV_CONCRETE, u1 = st[k + 1] / UV_CONCRETE;
    quadFacing(tile.stone, [A.foot, B.foot, B.top, A.top], [[u0, 0], [u1, 0], [u1, (B.top[1] - B.foot[1]) / UV_CONCRETE], [u0, (A.top[1] - A.foot[1]) / UV_CONCRETE]], C.stone, A.road);
    quadFacing(tile.stone, [A.top, B.top, B.cope, A.cope], [[u0, 0], [u1, 0], [u1, 0.11], [u0, 0.11]], C.cap, UP);
    if (ctx.dirtOk) quadFacing(tile.dirt, [A.cope, B.cope, B.back, A.back], [[0, 0], [0, 0], [0, 0], [0, 0]], GRASS_SPLAT, UP);
  }
  // the ends: the wall's section closed from the foot to the top and coping, facing on along the wall
  for (const [k, d] of [[0, -1], [n - 1, 1]]) {
    const A = pts[k], along = [foot[k].tx * d * side, 0, foot[k].tz * d * side];
    quadFacing(tile.stone, [A.foot, A.top, A.cope, [A.cope[0], A.foot[1], A.cope[2]]], [[0, 0], [0, 0.5], [0.11, 0.5], [0.11, 0]], C.stone, along);
  }
}

// The jump ramps (mapdata ACTIVITIES.jumps). The carve lifts GROUND and TERRAIN over the road's width plus a
// metre, along run metres up to the lip, on its 2 m grid, so the mound spreads a vertex further each way: past
// the kerb and a couple of metres past the lip. A timber kicker covers the whole lifted width, rising h to its
// lip and sloping back down to the road over JUMP_BACK metres past it, and earth berms (the terrain's own
// material) fall from its sides to the ground JUMP_BERM metres out, over the mound beside the kerb. Every
// point stands over the terrain (draped where the ground is higher).
const JUMP_BACK = 2.2, JUMP_BERM = 2.4;
function jumpRamps(ctx) {
  for (const jp of ctx.world.activities || []) {
    if (jp.type !== 'jump') continue;
    const x = jp.x / PX, z = jp.y / PX, run = jp.run / PX, h = jp.h;
    const E = ctx.edges.filter(e => e.road === jp.road).reduce((p, q) => (!p || nearestDist(q, x, z) < nearestDist(p, x, z) ? q : p), null);
    if (!E || nearestDist(E, x, z) > 4) continue;
    const s = nearestStation(E, x, z), f = at(E, s, {});
    // the ramp rises toward its lip along jp.a (the carve's tangent there): which way that is on the edge
    const dir = Math.cos(jp.a) * f.tx + Math.sin(jp.a) * f.tz >= 0 ? 1 : -1, hw = E.hw + 1.1;
    const rise = (a) => (a <= 0 ? h * Math.max(0, 1 + a / run) : h * Math.max(0, 1 - a / JUMP_BACK));
    const g = { ..._f };
    // the point `a` metres along from the lip and o across, dy over the design surface, and the ground there
    const P = (a, o, dy) => { at(E, s + a * dir, g); return [g.x - g.tz * o, g.y - o * g.tb + dy, g.z + g.tx * o]; };
    const ground = (p) => ctx.terrainY(p[0], p[2]);
    const along = [];
    for (let k = 0; k <= Math.ceil(run); k++) along.push(-run + run * k / Math.ceil(run));
    for (let k = 1; k <= 4; k++) along.push(JUMP_BACK * k / 4);
    const across = [];
    const nk = Math.max(2, Math.ceil(2 * hw / 2));
    for (let k = 0; k <= nk; k++) across.push(-hw + 2 * hw * k / nk);
    const kicker = along.map(a => across.map(o => { const p = P(a, o, rise(a) + 0.04); p[1] = Math.max(p[1], ground(p) + 0.06); return p; }));
    gridSurface(ctx.tileAt(x, z).concrete, kicker, (p) => [p[0] / UV_CONCRETE, -p[2] / UV_CONCRETE], C.ramp);
    // the berms: from the kicker's edge down to under the ground
    for (const side of [-1, 1]) {
      const rows = along.map((a, i) => {
        const edge = kicker[i][side > 0 ? across.length - 1 : 0], out = [];
        for (let k = 0; k <= 4; k++) {
          const t = k / 4, p = P(a, side * (hw + JUMP_BERM * t), 0), gy = ground(p);
          p[1] = k === 4 ? gy - 0.08 : Math.max(lerp(edge[1], gy - 0.08, t), gy + 0.06);
          out.push(k ? p : edge.slice());
        }
        return side > 0 ? out : out.reverse();
      });
      if (ctx.dirtOk) gridSurface(ctx.tileAt(x, z).dirt, rows, () => [0, 0], DIRT_SPLAT);
    }
  }
}
function nearestDist(E, x, z) {
  let bd = Infinity;
  for (let k = 0; k < E.n; k++) bd = Math.min(bd, Math.hypot(E.X[k] - x, E.Z[k] - z));
  return bd;
}

// A grid of points (rows of equal length, P[r][c] = [x, y, z]) as one smooth surface facing up (each
// triangle wound so; the normals averaged per vertex), uvs from uvOf(point).
function gridSurface(soup, P, uvOf, col) {
  const R = P.length, Cn = P[0].length, base = soup.n, nrm = P.map(r => r.map(() => [0, 0, 0])), tris = [];
  for (let r = 0; r + 1 < R; r++) for (let c = 0; c + 1 < Cn; c++) {
    for (const t of [[[r, c], [r + 1, c], [r + 1, c + 1]], [[r, c], [r + 1, c + 1], [r, c + 1]]]) {
      let n = faceNormal(P[t[0][0]][t[0][1]], P[t[1][0]][t[1][1]], P[t[2][0]][t[2][1]]);
      if (n[1] < 0) { t.reverse(); n = n.map(v => -v); }
      tris.push(t);
      for (const [i, j] of t) { const m = nrm[i][j]; m[0] += n[0]; m[1] += n[1]; m[2] += n[2]; }
    }
  }
  for (let r = 0; r < R; r++) for (let c = 0; c < Cn; c++) {
    const p = P[r][c], m = nrm[r][c], l = Math.hypot(m[0], m[1], m[2]) || 1, uv = uvOf(p);
    soup.v(p[0], p[1], p[2], m[0] / l, m[1] / l, m[2] / l, uv[0], uv[1], col);
  }
  for (const t of tris) soup.t(...t.map(([i, j]) => base + i * Cn + j));
}

// ---------- bridges ----------

// Every BRIDGES entry but the pier (coast3d's): its deck spans (the one nearest `at` where it names a point on
// a road with several), each a deck with parapets and piers, and its style's own parts.
function buildBridges(ctx) {
  const out = [];
  for (const br of BRIDGES) {
    if (br.style === 'pier' || !br.road) continue;
    let spans = [];
    for (const E of ctx.edges) if (E.road === br.road) for (const [a, b] of E.deck) spans.push({ E, a, b });
    if (br.at && spans.length > 1) {
      const d = (sp) => { const m = at(sp.E, (sp.a + sp.b) / 2); return Math.hypot(m.x - br.at[0], m.z - br.at[1]); };
      spans = [spans.reduce((p, q) => (d(q) < d(p) ? q : p))];
    }
    if (!spans.length) continue;
    const B = { id: br.id, style: br.style, asphalt: new Soup(), stone: new Soup(), spans, box: [Infinity, Infinity, -Infinity, -Infinity] };
    for (const sp of spans) deckSpan(ctx, B, br, sp);
    if (br.style === 'cable') cablePylon(ctx, B, br, spans[0]);
    if (br.style === 'arch') archRibs(ctx, B, br, spans[0]);
    if (br.style === 'bascule') basculeHouses(ctx, B, br);
    revetments(ctx, spans);
    // the group's box: everything it drew, for the chunk manager's shadow switch
    const P = [B.asphalt, B.stone];
    for (const s of P) for (let i = 0; i < s.n; i++) {
      const x = s.P[i * 3], z = s.P[i * 3 + 2];
      if (x < B.box[0]) B.box[0] = x; if (z < B.box[1]) B.box[1] = z; if (x > B.box[2]) B.box[2] = x; if (z > B.box[3]) B.box[3] = z;
    }
    out.push(B);
  }
  return out;
}

// the deck's outer offsets either side (the carriageway, plus the promenade where the road has one)
function deckEdges(E) {
  const l = E.hw + (E.promSide === -1 ? E.promW : 0), r = E.hw + (E.promSide === 1 ? E.promW : 0);
  return [-l, r];
}

// One deck span: asphalt top, a promenade top, parapets just outside the deck edges, the slab's faces and
// soffit, the Loop's Jersey barrier, the end walls down to the ground, and piers down to the bed.
function deckSpan(ctx, B, br, sp) {
  // a deck's abutment can reach into a junction's mouth (the Venetian's east end): the junction has that part
  const E = sp.E, a = Math.max(sp.a, E.mouthA), b = Math.min(sp.b, E.len - E.mouthB);
  if (b - a < 1) return;
  const F = edgeFrames(E, a, b), [oL, oR] = deckEdges(E), hw = E.hw, n = F.n - 1;
  const top = (o) => ({ o, dy: 0 }), low = (o) => ({ o, dy: -SLAB });
  const offs = asphaltPts({ ...E, walkL: 1, walkR: 1, promSide: 0 }, (a + b) / 2);   // (no kerb roll on a deck)
  for (let k = 0; k + 1 < offs.length; k++) strip(ctx, B.asphalt, F, 0, n, top(offs[k]), top(offs[k + 1]), C.white, 'world');
  if (oL < -hw) strip(ctx, B.stone, F, 0, n, { o: oL, dy: 0, uk: hw }, { o: -hw, dy: 0, uk: hw }, C.prom);
  if (oR > hw) strip(ctx, B.stone, F, 0, n, { o: hw, dy: 0, uk: hw }, { o: oR, dy: 0, uk: hw }, C.prom);
  const W = PARAPET_W, H = PARAPET_H;
  const parts = [
    // right parapet: inner face, top, then the slab's outer face down to its underside
    [{ o: oR, dy: 0, u: 0 }, { o: oR, dy: H, u: H / UV_CONCRETE }, C.parapet],
    [{ o: oR, dy: H, uk: oR }, { o: oR + W, dy: H, uk: oR }, C.parapet],
    [{ o: oR + W, dy: H, u: 0 }, { o: oR + W, dy: -SLAB, u: (H + SLAB) / UV_CONCRETE }, C.fascia],
    // the soffit, right to left (facing down)
    [low(oR + W), low(oL - W), C.soffit, 'flat'],
    // left: the slab's outer face up, the parapet top, its inner face
    [{ o: oL - W, dy: -SLAB, u: (H + SLAB) / UV_CONCRETE }, { o: oL - W, dy: H, u: 0 }, C.fascia],
    [{ o: oL - W, dy: H, uk: -oL }, { o: oL, dy: H, uk: -oL }, C.parapet],
    [{ o: oL, dy: H, u: H / UV_CONCRETE }, { o: oL, dy: 0, u: 0 }, C.parapet],
  ];
  // the promenade's own railing line: a low kerb between it and the carriageway
  if (br.barrier === 'jersey' && E.median > 0) {
    for (let k = 0; k + 1 < JERSEY.length; k++) {
      const [w0, h0] = JERSEY[k], [w1, h1] = JERSEY[k + 1];
      parts.push([{ o: -w0, dy: h0, u: 0.25 }, { o: -w1, dy: h1, u: 0.25 }, C.jersey, 'flat']);
      parts.push([{ o: w1, dy: h1, u: 0.25 }, { o: w0, dy: h0, u: 0.25 }, C.jersey, 'flat']);
    }
    const [wt, ht] = JERSEY[JERSEY.length - 1];
    parts.push([{ o: -wt, dy: ht }, { o: wt, dy: ht }, C.jersey, 'flat']);
  }
  for (const [p, q, col, uv] of parts) strip(ctx, B.stone, F, 0, n, p, q, col, uv || 'strip');
  // the end walls: the slab's cross-section closed down to the ground under each end
  for (const [s, face] of [[a, -1], [b, 1]]) {
    const f = at(E, s), P = (o, dy) => [f.x - f.tz * o, f.y - o * f.tb + dy, f.z + f.tx * o];
    const g = Math.min(ctx.terrainY(f.x - f.tz * (oL - W), f.z + f.tx * (oL - W)), ctx.terrainY(f.x - f.tz * (oR + W), f.z + f.tx * (oR + W)), ctx.terrainY(f.x, f.z));
    const yb = Math.min(-SLAB, g - f.y - 0.5);
    const q = [P(oL - W, yb), P(oR + W, yb), P(oR + W, 0), P(oL - W, 0)];
    const nn = faceNormal(q[0], q[1], q[2]), uv = [[0, 0], [(oR - oL) / 4, 0], [(oR - oL) / 4, -yb / 4], [0, -yb / 4]];
    if (nn[0] * f.tx * face + nn[2] * f.tz * face >= 0) B.stone.quad(q, uv, C.fascia);
    else B.stone.quad([q[1], q[0], q[3], q[2]], [uv[1], uv[0], uv[3], uv[2]], C.fascia);
  }
  // piers: where the bed is well below the soffit, every PIER_STEP (or the bridge's own spacing)
  const step = br.piers || PIER_STEP, len = b - a, count = Math.max(1, Math.round(len / step));
  const pylonS = br.pylon ? nearestStation(E, br.pylon.x, br.pylon.z) : null;
  for (let k = 1; k < count; k++) {
    const s = a + len * k / count;
    if (pylonS !== null && Math.abs(s - pylonS) < 45) continue;
    const f = at(E, s), yTop = f.y - SLAB, bed = ctx.terrainY(f.x, f.z);
    if (bed > yTop - 1.2) continue;
    const heading = Math.atan2(f.tz, f.tx), wide = oR - oL > 12;
    const cols = wide ? [-(oR - oL) * 0.28, (oR - oL) * 0.28] : [0];
    for (const o of cols) {
      const x = f.x - f.tz * (o + (oL + oR) / 2), z = f.z + f.tx * (o + (oL + oR) / 2);
      box(B.stone, x, z, ctx.terrainY(x, z) - 1, yTop, 0.8, wide ? 0.8 : (oR - oL) * 0.28, heading, C.pier);
    }
    // the cap beam under the slab
    const mx = f.x - f.tz * ((oL + oR) / 2), mz = f.z + f.tx * ((oL + oR) / 2);
    box(B.stone, mx, mz, yTop - 1.1, yTop, 0.9, (oR - oL) / 2 + W * 0.6, heading, C.pier, { bottom: true });
  }
}

// The North Causeway's A-frame pylon over the Loop and its two fans of stays: legs from the bed outside the
// deck to a head h metres over the sea, a cross beam under the deck, and `stays` cables a side each way.
function cablePylon(ctx, B, br, sp) {
  const P = br.pylon, E = sp.E, s = nearestStation(E, P.x, P.z), f = at(E, s, {}), [oL, oR] = deckEdges(E);
  const yTop = ctx.sea + P.h, yDeck = f.y, heading = Math.atan2(f.tz, f.tx);
  const pos = (o, y, along = 0) => [f.x - f.tz * o + f.tx * along, y, f.z + f.tx * o + f.tz * along];
  const bed = ctx.terrainY(f.x, f.z) - 1;
  // each leg passes 2 m outside the parapet at deck level and meets the other under the head
  const oDeck = Math.max(-oL, oR) + PARAPET_W + 2.6, oHead = 1.3, yHead = yTop - 10;
  const oFoot = oDeck + (oDeck - oHead) * (yDeck - bed) / (yHead - yDeck);
  for (const side of [-1, 1]) {
    const foot = pos(side * oFoot, bed), knee = pos(side * oHead, yHead);
    taperLeg(B.stone, foot, knee, 2.6, 1.7, heading);
  }
  // the head the stays anchor in
  box(B.stone, f.x, f.z, yHead - 1, yTop, 1.6, 2.2, heading, C.pylon);
  // the cross beam under the deck
  const yBeam = yDeck - SLAB - 0.2, oBeam = oDeck + (oDeck - oHead) * (yDeck - yBeam) / (yHead - yDeck);
  beam(B.stone, pos(-oBeam, yBeam - 0.9), pos(oBeam, yBeam - 0.9), 1.8, C.pylon);
  // the stays: deck anchors every 12 m from 16 m out, along the deck's edges, to the head
  const nStay = P.stays || 8;
  for (const dir of [-1, 1]) for (const side of [-1, 1]) for (let k = 0; k < nStay; k++) {
    const along = dir * (16 + k * 12), sa = s + along;
    if (sa < sp.a + 4 || sa > sp.b - 4) continue;
    const g = at(E, sa), o = side > 0 ? oR + PARAPET_W + 0.35 : oL - PARAPET_W - 0.35;
    const deckP = [g.x - g.tz * o, g.y - o * g.tb + 0.4, g.z + g.tx * o];
    const headP = pos(side * 0.9, yTop - 1.5 - (nStay - 1 - k) * 0.9, dir * 0.8);
    beam(B.stone, deckP, headP, 0.22, C.stay);
    // the anchor block on the deck edge
    box(B.stone, deckP[0], deckP[2], deckP[1] - 0.9, deckP[1] + 0.25, 0.35, 0.3, heading, C.pylon);
  }
}

// a leg from foot to head tapering from wa to wb (square sections, turned to the heading)
function taperLeg(soup, p, q, wa, wb, heading) {
  const ca = Math.cos(heading), sa = Math.sin(heading);
  const sec = (c, w) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [c[0] + (ca * u - sa * v) * w / 2, c[1], c[2] + (sa * u + ca * v) * w / 2]);
  const A = sec(p, wa), Bq = sec(q, wb);
  for (let k = 0; k < 4; k++) {
    const k2 = (k + 1) % 4, quad = [A[k], A[k2], Bq[k2], Bq[k]];
    const n = faceNormal(quad[0], quad[1], quad[2]), mid = [(A[k][0] + A[k2][0]) / 2 - p[0], 0, (A[k][2] + A[k2][2]) / 2 - p[2]];
    const uv = [[0, 0], [0.5, 0], [0.5, 4], [0, 4]];
    if (n[0] * mid[0] + n[2] * mid[2] >= 0) soup.quad(quad, uv, C.pylon); else soup.quad([quad[1], quad[0], quad[3], quad[2]], uv, C.pylon);
  }
  // cap the top
  soup.quad([Bq[0], Bq[3], Bq[2], Bq[1]].map(v => v.slice()), [[0, 0], [0, 1], [1, 1], [1, 0]], C.pylon);
}

// The Rickenbacker's white arch: two parabolic ribs along the deck's edges, rising h over the deck at the
// landmark's point and springing from the deck span/2 either side, with hangers every 5 m and braces over.
function archRibs(ctx, B, br, sp) {
  const L = ctx.world.landmarks?.find(l => l.kind === 'bridge_arch' && l.road === br.road) || { x: br.arch.x, z: br.arch.z, h: 14, span: br.arch.span };
  const E = sp.E, sc = nearestStation(E, L.x, L.z), half = (L.span || 60) / 2, rise = L.h || 14, [oL, oR] = deckEdges(E);
  const ribO = [oL - PARAPET_W - 0.7, oR + PARAPET_W + 0.7], n = 20;
  const rib = (o, t) => {
    const s = sc - half + 2 * half * t, f = at(E, s), y = f.y - o * f.tb + 0.2 + rise * (1 - (2 * t - 1) ** 2);
    return [f.x - f.tz * o, y, f.z + f.tx * o];
  };
  for (const o of ribO) {
    for (let k = 0; k < n; k++) beam(B.stone, rib(o, k / n), rib(o, (k + 1) / n), 0.9, C.arch);
    // hangers down to the deck edge
    for (let k = 2; k < n - 1; k += 2) {
      const p = rib(o, k / n), s = sc - half + 2 * half * k / n, f = at(E, s), oo = o > 0 ? oR + PARAPET_W * 0.5 : oL - PARAPET_W * 0.5;
      beam(B.stone, p, [f.x - f.tz * oo, f.y - oo * f.tb + PARAPET_H, f.z + f.tx * oo], 0.14, C.arch);
    }
  }
  // braces between the ribs near the crown, well over the traffic
  for (const t of [0.3, 0.5, 0.7]) beam(B.stone, rib(ribO[0], t), rib(ribO[1], t), 0.6, C.arch);
}

// The Venetian's bascule houses: at the middle of each water span, a little pastel control house on a ledge
// outside each parapet, with a hipped terracotta roof and a band of windows.
function basculeHouses(ctx, B, br) {
  const L = ctx.world.landmarks?.find(l => l.kind === 'bascule_houses' && l.bridge === br.id);
  const pts = L?.at || [];
  const E = ctx.edges.find(e => e.road === br.road);
  if (!E) return;
  for (const [x, z] of pts) {
    const s = nearestStation(E, x, z), f = at(E, s, {}), [oL, oR] = deckEdges(E), heading = Math.atan2(f.tz, f.tx);
    // the joint where the two leaves meet, across the deck between the painted lines
    const lines = linesOf(E).map(([o, w]) => [o - w / 2 - 0.08, o + w / 2 + 0.08]).sort((a, b) => a[0] - b[0]);
    let o0 = oL;
    for (const [a, b] of [...lines, [oR, oR]]) { if (a > o0 + 0.05) band(ctx, E, s - 0.07, s + 0.07, o0, Math.min(a, oR), C.joint); o0 = Math.max(o0, b); }
    for (const o of [oL - PARAPET_W - 2.0, oR + PARAPET_W + 2.0]) {
      const hx = f.x - f.tz * o, hz = f.z + f.tx * o, y0 = f.y - o * f.tb;
      box(B.stone, hx, hz, y0 - SLAB, y0, 2.6, 2.2, heading, C.fascia, { bottom: true });         // the ledge
      box(B.stone, hx, hz, y0, y0 + 3.0, 1.7, 1.5, heading, C.house);                             // the house
      box(B.stone, hx, hz, y0 + 1.6, y0 + 2.4, 1.72, 1.52, heading, C.window, { top: false });    // windows
      hipRoof(B.stone, hx, hz, y0 + 3.0, 2.0, 1.8, 1.3, heading, C.roof);
    }
  }
}

function hipRoof(soup, x, z, y, ha, hb, h, a, col) {
  const ca = Math.cos(a), sa = Math.sin(a);
  const P = (u, v, yy) => [x + ca * u - sa * v, yy, z + sa * u + ca * v];
  const c = [P(-ha, -hb, y), P(ha, -hb, y), P(ha, hb, y), P(-ha, hb, y)], r0 = P(-ha * 0.35, 0, y + h), r1 = P(ha * 0.35, 0, y + h);
  const face = (pts) => {
    const n = faceNormal(pts[0], pts[1], pts[2]), up = n[1] >= 0, list = up ? pts : pts.slice().reverse();
    const nn = faceNormal(list[0], list[1], list[2]), i = soup.v(list[0][0], list[0][1], list[0][2], nn[0], nn[1], nn[2], 0.25, 0.25, col);
    for (let k = 1; k < list.length; k++) soup.v(list[k][0], list[k][1], list[k][2], nn[0], nn[1], nn[2], 0.25, 0.25, col);
    for (let k = 1; k + 1 < list.length; k++) soup.t(i, i + k, i + k + 1);
  };
  face([c[0], c[1], r1, r0]); face([c[2], c[3], r0, r1]); face([c[1], c[2], r1]); face([c[3], c[0], r0]);
}

// placeProps' abutment walls (deco 'fences' of kind 'abutment'): the ground beside a deck end that GROUND
// holds at the deck's height while the terrain under it stays low; they block cars and people. Each is drawn
// as a stone revetment, the slope a bridge end stands on: its top runs along the deck's outer face (the
// parapet's, and on along the road's edge past the deck end) just under the road surface, and it falls away
// from the road at REVET_SLOPE until it meets the ground, hipped at both ends along the road. It is draped
// DRAPE over any terrain standing higher (the banks of the road's fill) and tucked under the ground all round,
// so nothing stands out from the deck at its height. They go in the road tiles: they drape the fine terrain.
function revetments(ctx, spans) {
  const edges = new Map(spans.map(sp => [sp.E.id, sp.E]));
  for (const d of ctx.world.deco || []) if (d.list === 'fences' && d.kind === 'abutment' && edges.has(d.edge)) revetment(ctx, edges.get(d.edge), d);
}
function revetment(ctx, E, d) {
  const x = d.x / PX, z = d.y / PX, sc = nearestStation(E, x, z), fc = at(E, sc, {});
  const side = (x - fc.x) * -fc.tz + (z - fc.z) * fc.tx >= 0 ? 1 : -1;
  const [oL, oR] = deckEdges(E), vIn = (side > 0 ? oR : -oL) + PARAPET_W;
  const u0 = Math.max(0, sc - d.w / 2), u1 = Math.min(E.len, sc + d.w / 2);
  // points u metres along the edge, v out from its centre on this side
  const f = { ..._f };
  const P = (u, v, y) => { at(E, u, f); return [f.x - f.tz * side * v, y, f.z + f.tx * side * v]; };
  const ground = (u, v) => { at(E, u, f); return ctx.terrainY(f.x - f.tz * side * v, f.z + f.tx * side * v); };
  const yTop = (u) => { at(E, u, f); return f.y - side * vIn * f.tb - 0.15; };
  // the slope stands full height along the patch and falls away past both its ends (hips) as fast as it falls
  // from the road, for as long as its fall takes (at most 8 m)
  const Lh = clamp((yTop(sc) - d.base) * REVET_SLOPE, 1, 8), uA = Math.max(0, u0 - Lh), uB = Math.min(E.len, u1 + Lh);
  const plane = (u, v) => yTop(u) - Math.max(v - vIn, u0 - u, u - u1) / REVET_SLOPE;
  // Each column along the road reaches out until the slope meets the ground (or the sea bed), at most 16 m,
  // and at least past the patch's blocked ground (GROUND over the terrain by more than half a metre, where
  // the deck's height is held out over a falling bank: it is covered, draped). A column with neither has no
  // slope and lies tucked under the ground.
  const blocked = (u, v) => {
    at(E, u, f);
    const px = f.x - f.tz * side * v, pz = f.z + f.tx * side * v, q = (px - x) * Math.cos(d.a) + (pz - z) * Math.sin(d.a), r = -(px - x) * Math.sin(d.a) + (pz - z) * Math.cos(d.a);
    return Math.abs(q) <= d.w / 2 && Math.abs(r) <= d.d / 2 && ctx.groundY(px, pz) - ctx.terrainY(px, pz) > 0.5;
  };
  const nu = Math.max(3, Math.ceil((uB - uA) / 1.5) + 1), cols = [];
  for (let i = 0; i < nu; i++) {
    const u = lerp(uA, uB, i / (nu - 1));
    let v = vIn;
    while (v < vIn + 16 && plane(u, v) > ground(u, v)) v += 0.5;
    for (let b = vIn + 8; b >= vIn; b -= 0.5) if (blocked(u, b)) { v = Math.max(v, b + 1.2); break; }
    cols.push({ u, vOut: Math.max(v, vIn + 0.6), flat: v < vIn + 0.6 });
  }
  const nv = Math.max(3, Math.ceil(Math.max(...cols.map(c => c.vOut - vIn)) / 0.75) + 1), grid = [];
  // rows across: the slope from its top edge out to the ground, then a skirt under it; a skirt column before
  // the first column and after the last
  const ends = [{ ...cols[0], u: Math.max(0, uA - 0.6), flat: true }, { ...cols[nu - 1], u: Math.min(E.len, uB + 0.6), flat: true }];
  for (const c of [ends[0], ...cols, ends[1]]) {
    const row = [];
    for (let j = 0; j < nv; j++) {
      const v = lerp(vIn, c.vOut, j / (nv - 1)), gy = ground(c.u, v);
      row.push(P(c.u, v, c.flat ? gy - 0.4 : j === nv - 1 ? gy - 0.05 : Math.max(plane(c.u, v), gy + DRAPE)));
    }
    row.push(P(c.u, c.vOut + 0.6, ground(c.u, c.vOut + 0.6) - 0.4));
    grid.push(row);
  }
  const tile = ctx.tileAt(x, z);
  gridSurface(tile.stone, grid, (p) => [p[0] / UV_CONCRETE, -p[2] / UV_CONCRETE], C.stone);
  // the top edge's face down to the ground, toward the road: behind the parapet's fascia over the deck, and
  // past the deck end it closes the gap under the verge
  for (let i = 0; i + 1 < grid.length; i++) {
    const a = grid[i][0], b = grid[i + 1][0], ga = a.slice(), gb = b.slice();
    ga[1] = Math.min(a[1], ctx.terrainY(a[0], a[2])) - 0.3; gb[1] = Math.min(b[1], ctx.terrainY(b[0], b[2])) - 0.3;
    at(E, sc, f);
    quadFacing(tile.stone, [ga, gb, b, a], [[0, 0], [0.4, 0], [0.4, 0.3], [0, 0.3]], C.stone, [f.tz * side, 0, -f.tx * side]);
  }
}

// ---------- wiring that needs the plan ----------

// Junction lookups and the walk graph's crossings per node (filled before the paint).
function prepPaint(ctx, junctions) {
  const byNode = new Map(junctions.map(J => [J.N.id, J]));
  ctx.junctionOf = (id) => byNode.get(id);
  ctx.crossings = new Map();
  for (const p of ctx.net.walks?.paths || []) {
    if (!p.cross || p.edge < 0) continue;
    const E = ctx.edges[p.edge], mx = (p.pts[0] + p.pts[2]) / 2 / PX, mz = (p.pts[1] + p.pts[3]) / 2 / PX;
    const s = nearestStation(E, mx, mz), node = s < E.len / 2 ? E.a : E.b, J = byNode.get(node);
    const A = J?.ends.find(q => q.E === E && q.start === (s < E.len / 2));
    if (!A) continue;
    (ctx.crossings.get(node) || ctx.crossings.set(node, []).get(node)).push({ end: A, d: A.start ? s : E.len - s });
  }
}
