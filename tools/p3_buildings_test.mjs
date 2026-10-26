#!/usr/bin/env node
// Stage P3 check (map v2 wave P3, buildings): the lot fixes in src/map/lots.js and the new looks in
// src/3d/buildings3d.js, built in node.
//   node tools/p3_buildings_test.mjs            (S3B_LOW=1 for the phone tier's Lambert shader)
//  1. Lots on their pads: no building's floor is buried by a neighbour's pad (building 297 was, 1.6 m), none
//     stands more than its plain under-wall over the ground, and no carriageway lies under the reach of a front's
//     awnings and blade signs (buildings 383 and 384 fronted Neon Alley's carriageway).
//  2. Towers: every one is a curtain wall the shader draws (no picture windows), in several kinds; most tall ones
//     carry an LED crown; some podiums carry a deck with a pool.
//  3. The Heights' glass villas: white volumes with floor-to-ceiling glass and a pool in the shell (no more white
//     boxes from afar), in three plans, with glass on all four sides, glass balustrades and planted or solar roofs.
//  4. The Gables: terracotta roofs only, warm stucco, the Mediterranean facade picture, hip and gable roofs and
//     corner towers; Star Island's estates have their towers.
//  5. Roof variety: K-Town's green roofs and rooftop rooms, pools on Deco and resort roofs, helipads, shed skylights.
//  6. The shells stay small (the always-resident part of the buildings).
//  7. The material: the shader layers land in three r169's MeshStandard and Lambert shaders, and nothing in them
//     hides a GLSL built-in.
// Exits 1 if any check fails.
import { src, check, section, note, done } from './s3b_env.mjs';
globalThis.KC_WORLD = 'v2';
const THREE = await import('three');
const W = await import(src('src/world.js'));
W.generate();
const { KIND, KIND_MASK } = await import(src('src/map/raster.js'));
const { STYLE } = await import(src('src/map/lots.js'));
const { makeChunkManager } = await import(src('src/3d/chunks.js'));
const B3 = await import(src('src/3d/buildings3d.js'));
const LAY = B3.LAYERS, LOW_TIER = process.env.S3B_LOW === '1';
const B = W.buildings, g = W.grids, [gw] = g.dims.ground;

// ---------- 1. lots on their pads ----------

section('lots on their pads (lots.js)');
const ground = (x, z) => {
  const i = x / 2, j = z / 2, i0 = Math.floor(i), j0 = Math.floor(j), fx = i - i0, fz = j - j0, a = g.ground;
  return a[j0 * gw + i0] * (1 - fx) * (1 - fz) + a[j0 * gw + i0 + 1] * fx * (1 - fz) + a[(j0 + 1) * gw + i0] * (1 - fx) * fz + a[(j0 + 1) * gw + i0 + 1] * fx * fz;
};
const frameAt = (b, u, v) => {
  const fx = Math.cos(b.a), fz = Math.sin(b.a), rx = fz, rz = -fx;
  return [b.cx + rx * u + fx * v, b.cz + rz * u + fz * v];
};
const buried = [], floating = [], fronting = [];
for (const b of B) {
  let hi = -Infinity, lo = Infinity;
  for (let v = -1; v <= 1; v += 0.25) for (let u = -1; u <= 1; u += 0.25) {
    const [x, z] = frameAt(b, u * (b.w / 2 - 0.5), v * (b.d / 2 - 0.5)), y = ground(x, z) - b.base;
    hi = Math.max(hi, y); lo = Math.min(lo, y);
  }
  if (hi > 0.3) buried.push(`${b.id} ${b.style} +${hi.toFixed(2)} m`);
  if (lo < -1.4) floating.push(`${b.id} ${b.style} ${lo.toFixed(2)} m`);
  if (b.kind !== 'lot') continue;
  // the awnings reach 1.35 m out, the blade signs 1.25 m: nothing of a carriageway within 1.6 m of the front
  let road = 0;
  for (let t = 0.25; t <= 1.6; t += 0.25) for (let u = -0.95; u <= 0.95; u += 0.1) {
    const [x, z] = frameAt(b, u * b.w / 2, b.d / 2 + t), k = g.surf[Math.floor(z) * g.w + Math.floor(x)] & KIND_MASK;
    if (k === KIND.ROAD || k === KIND.DECK) road++;
  }
  if (road) fronting.push(`${b.id} ${b.style} (${road} samples)`);
}
note(`${B.length} buildings`);
check('no building\'s floor is buried by a neighbour\'s pad (ground within 0.3 m of its base)', buried.length === 0, buried.slice(0, 5).join('; '));
check('no building stands more than 1.4 m over the ground (its plain wall runs 1.6 m down)', floating.length === 0, floating.slice(0, 5).join('; '));
check('no carriageway under any lot\'s awnings or blade signs (1.6 m before its front)', fronting.length === 0, fronting.slice(0, 5).join('; '));
check('the county keeps its buildings (375-450)', B.length >= 375 && B.length <= 450, String(B.length));
{
  // the lots on Neon Alley, which has no sidewalk, open onto a paved apron
  const alley = W.roads.edges.filter((e) => e.road === 'neon_alley');
  let lots = 0, paved = 0;
  for (const b of B) {
    if (b.kind !== 'lot') continue;
    const [x, z] = frameAt(b, 0, b.d / 2 + 1.0);
    const near = alley.some((e) => { for (let i = 0; i < e.n; i++) if (Math.hypot(e.x[i] / 16 - x, e.y[i] / 16 - z) < 5) return true; return false; });
    if (!near) continue;
    lots++;
    if ((g.surf[Math.floor(z) * g.w + Math.floor(x)] & KIND_MASK) === KIND.PLAZA) paved++;
  }
  note(`${lots} lots front Neon Alley, ${paved} on a paved apron`);
  check('Neon Alley\'s lots open onto paving', lots > 0 && paved === lots, `${paved} of ${lots}`);
}

// ---------- the passes ----------

const group = new THREE.Group();
B3.registerBuildings(W, makeChunkManager(group, { castR: 110, maxCells: 36 }));
const pass = new Map();
const layersOf = (b, kind = 'shell') => {
  const k = `${b.id} ${kind}`;
  if (!pass.has(k)) {
    const p = B3.buildingPass(b, kind), n = {};
    for (let i = 0; i < p.n; i++) n[p.layer[i]] = (n[p.layer[i]] || 0) + 1;
    pass.set(k, { p, n });
  }
  return pass.get(k);
};
const has = (b, layer, kind = 'shell') => (layersOf(b, kind).n[layer] || 0) > 0;

// ---------- 2. towers ----------

section('towers: curtain walls, crowns and decks');
const CURTAIN = [LAY.tower, LAY.banded, LAY.framed, LAY.bronze];
const towers = B.filter((b) => b.style === 'tower' && !b.place);   // (the police and the hospital keep the grid's look)
const kinds = {};
let pictured = 0, curtained = 0, beacons = 0, tall = 0, decks = 0;
for (const b of towers) {
  const n = layersOf(b).n;
  const own = CURTAIN.filter((l) => n[l]);
  if (own.length) curtained++;
  for (const l of own) kinds[l] = (kinds[l] || 0) + 1;
  if ([LAY.deco, LAY.ktown, LAY.resort, LAY.house, LAY.warehouse].some((l) => n[l])) pictured++;
  if (b.floors >= 18) { tall++; if (n[LAY.beacon]) beacons++; }
  if (n[LAY.pool]) decks++;
}
note(`${towers.length} towers: kinds ${JSON.stringify(kinds)}, ${beacons} of ${tall} tall ones with an LED crown, ${decks} pool decks`);
check('every tower is a curtain wall the shader draws', curtained === towers.length, `${curtained} of ${towers.length}`);
check('no tower wears a picture facade', pictured === 0, String(pictured));
check('all four curtain kinds are used', CURTAIN.every((l) => kinds[l] > 0));
check('most tall towers carry an LED crown', beacons >= tall * 0.5, `${beacons} of ${tall}`);
check('some podiums carry a pool deck', decks >= 3, String(decks));
{
  // the low-rise north row takes the stone and banded kinds
  const low = towers.filter((b) => b.floors <= 6);
  check('low-rise towers take the banded or stone curtain', low.every((b) => has(b, LAY.banded) || has(b, LAY.framed)), `${low.length} low-rise`);
  const kt = B.find((b) => b.landmark === 'kimchi_tower');
  check('Kimchi Tower is sleek curtain glass', !!kt && has(kt, LAY.tower));
  // champagne glass only on the mid-rise (a tall shaft of it read as a khaki slab across the bay)
  check('no tall tower (over 24 floors) is champagne glass', towers.every((b) => b.floors <= 24 || !has(b, LAY.bronze)));
  // the curtain walls' rows are all on the sheet (v >= 0): rows under it are a balustrade's, which lights no room
  const offSheet = towers.filter((b) => { const { p } = layersOf(b); for (let i = 0; i < p.n; i++) if (CURTAIN.includes(p.layer[i]) && p.uv[i * 2 + 1] < 0) return true; return false; });
  check('no tower wall is drawn on the balustrade rows', offSheet.length === 0, offSheet.slice(0, 4).map((b) => b.id).join(' '));
}

// ---------- 3. the Heights' glass villas ----------

section('the Heights: glass villas');
{
  const villas = B.filter((b) => b.style === 'mansion' && !b.house && !b.place);
  const glass = villas.filter((b) => has(b, LAY.villaGlass)), pools = villas.filter((b) => has(b, LAY.pool));
  const plans = new Set(villas.map((b) => layersOf(b).p.n));
  note(`${villas.length} glass villas, ${glass.length} with glass and ${pools.length} with a pool in the shell`);
  check('the Heights have their glass villas', villas.length >= 6, String(villas.length));
  check('every villa shows its glass from afar (in the shell)', glass.length === villas.length);
  check('every villa has its pool', pools.length === villas.length);
  check('the villas are not all one design', plans.size >= 3, String(plans.size));
  check('they light their rooms at night (the deck lights and LED lines are there)', villas.every((b) => has(b, LAY.glow, 'detail')));
  // glass on every side, not only the front (windows on the back and the sides: no white box from the pass), glass
  // balustrades (the rows under the sheet), and roofs of two kinds (a terrace and a planted or solar top)
  const look = villas.map((b) => {
    const { p } = layersOf(b), sides = new Set(), roofs = new Set();
    let a0 = null, rails = 0;
    for (let i = 0; i + 3 < p.n; i += 4) {
      if (p.layer[i] !== LAY.villaGlass) continue;
      if (p.uv[i * 2 + 1] < 0) { rails++; continue; }
      const P = (j) => new THREE.Vector3(p.pos[j * 3], p.pos[j * 3 + 1], p.pos[j * 3 + 2]);
      const nrm = new THREE.Vector3().crossVectors(P(i + 1).sub(P(i)), P(i + 2).sub(P(i)));
      if (Math.hypot(nrm.x, nrm.z) < 1e-6) continue;
      const ang = Math.atan2(nrm.z, nrm.x);
      if (a0 === null) a0 = ang;
      sides.add(((Math.round((ang - a0) / (Math.PI / 2)) % 4) + 4) % 4);
    }
    for (let i = 0; i < p.n; i++) if (p.layer[i] === LAY.gravel) roofs.add(p.color.slice(i * 3, i * 3 + 3).map((v) => v.toFixed(3)).join());
    return { id: b.id, sides: sides.size, rails, roofs: roofs.size };
  });
  note(look.map((v) => `${v.id}: glass on ${v.sides} sides, ${v.rails / 2} balustrade runs, ${v.roofs} roof finishes`).join('; '));
  check('every villa has glass on all four sides', look.every((v) => v.sides === 4), look.filter((v) => v.sides < 4).map((v) => v.id).join(' '));
  check('every villa has glass balustrades', look.every((v) => v.rails > 0));
  check('every villa has two roof finishes (a terrace and a planted or solar roof)', look.every((v) => v.roofs >= 2));
}

// ---------- 4. the Gables ----------

section('the Gables: Mediterranean Revival');
{
  const hue = (hex) => {
    const c = new THREE.Color(hex), hsl = {};
    c.getHSL(hsl, THREE.SRGBColorSpace);
    return hsl;
  };
  const houses = B.filter((b) => b.style === 'house' && !b.place);
  const terracotta = (hex) => { const h = hue(hex); return h.h * 360 >= 0 && h.h * 360 <= 30 && h.s > 0.3; };
  const warm = (hex) => { const h = hue(hex); return h.h * 360 >= 15 && h.h * 360 <= 50 && h.l > 0.75; };
  check('the house style\'s roofs are all terracotta', STYLE.house.roofs.every(terracotta), STYLE.house.roofs.join(' '));
  check('the house style\'s walls are all warm stucco', STYLE.house.walls.every(warm), STYLE.house.walls.join(' '));
  check('every Gables house has a terracotta roof', houses.every((b) => terracotta(b.roof)), houses.filter((b) => !terracotta(b.roof)).slice(0, 4).map((b) => `${b.id} ${b.roof}`).join(' '));
  check('every house is on the house facade under barrel tiles', houses.every((b) => has(b, LAY.house) && has(b, LAY.tiles)));
  // a hip roof is 2 quads and 2 tiles triangles (14 vertices), a gable 2 quads (8; its ends are walls), a tower's
  // pyramid another hip; the walls are 4 quads and 4 under-walls (32 vertices), a tower adds 4 quads
  let hips = 0, towersN = 0;
  for (const b of houses) {
    const { p } = layersOf(b);
    let tiles = 0, walls = 0;
    for (let i = 0; i < p.n; i++) { if (p.layer[i] === LAY.tiles) tiles++; if (p.layer[i] === LAY.house) walls++; }
    if (tiles === 14 || tiles === 28) hips++;
    if (walls > 32) towersN++;
  }
  note(`${houses.length} houses: ${hips} with hip roofs, ${towersN} with a corner tower`);
  check('hip and gable roofs both', hips > houses.length * 0.3 && hips < houses.length * 0.9, `${hips} of ${houses.length}`);
  check('some houses have a corner tower', towersN >= 10, String(towersN));
  const star = B.filter((b) => b.style === 'mansion' && b.house);
  check('Star Island\'s estates have their towers', star.length > 0 && star.every((b) => (layersOf(b).n[LAY.house] || 0) > 32));
  check('the doors have arched cast-stone entries (detail)', houses.every((b) => layersOf(b, 'detail').p.n >= 60));
}

// ---------- 5. roofs ----------

section('roof variety');
{
  const kt = B.filter((b) => b.style === 'ktown');
  const green = kt.filter((b) => {
    const { p } = layersOf(b);
    for (let i = 0; i < p.n; i++) if (p.layer[i] === LAY.gravel) return p.color[i * 3 + 1] > p.color[i * 3] * 1.25;
    return false;
  });
  note(`K-Town: ${green.length} of ${kt.length} green roofs`);
  check('K-Town has its green roofs (and others)', green.length > kt.length * 0.25 && green.length < kt.length * 0.8);
  const pools = (style) => B.filter((b) => b.style === style && has(b, LAY.pool)).length;
  note(`roof pools: deco ${pools('deco')}, resort ${pools('resort')}`);
  check('some Deco hotels have a roof pool', pools('deco') >= 3);
  check('most resorts have a roof pool', pools('resort') >= B.filter((b) => b.style === 'resort').length * 0.4);
  const sheets = B.filter((b) => b.style === 'resort' && has(b, LAY.sheet, 'detail')).length;
  check('the resorts keep their painted names', sheets === B.filter((b) => b.style === 'resort').length);
  const sheds = B.filter((b) => b.style === 'warehouse' && !b.place);
  check('the Port\'s sheds have skylights', sheds.every((b) => (layersOf(b).n[LAY.plain] || 0) >= 4));
}

// ---------- 6. shells ----------

section('the shells stay small');
{
  const st = B3.buildingStats();
  let tris = 0, n = 0;
  for (const b of B) if (b.style !== 'resort') { tris += layersOf(b).p.index.length / 3; n++; }
  note(`${st.shellTris} shell triangles in ${st.tiles} tiles; ${(tris / n).toFixed(1)} a building bar the resorts`);
  check('all the shells together within 30 k triangles', st.shellTris <= 30e3, String(st.shellTris));
  check('about 30 triangles a building (within 36)', tris / n <= 36, (tris / n).toFixed(1));
}

// ---------- 7. the material ----------

section('the material: shader layers');
{
  const mat = group.children.find((o) => o.name.startsWith('building shells ')).material;
  for (const lib of LOW_TIER ? ['lambert'] : ['standard', 'lambert']) {
    const sh = { uniforms: {}, vertexShader: THREE.ShaderLib[lib].vertexShader, fragmentShader: THREE.ShaderLib[lib].fragmentShader };
    mat.onBeforeCompile(sh);
    const fs = sh.fragmentShader, vs = sh.vertexShader;
    check(`${lib}: the curtain wall and pool code sits before main()`, fs.indexOf('void bCurtain') > 0 && fs.indexOf('void bPool') > 0 && fs.indexOf('void bCurtain') < fs.indexOf('void main()'));
    check(`${lib}: the vertex colour is left to the shader-drawn layers (and an LED crown is dark by day)`, !fs.includes('#include <color_fragment>') && /if \( bOwn < 0\.5 \) diffuseColor\.rgb \*= bL == 23 \? mix\( vec3\( [\d., ]+\), vColor, uBNight \) : vColor;/.test(fs));
    check(`${lib}: the world position reaches the fragment shader`, vs.includes('vBPos = ( modelMatrix') && fs.includes('varying vec3 vBPos'));
    check(`${lib}: the haze colour is read only with fog on`, /#ifdef USE_FOG\s+vec3 bSky = fogColor;/.test(fs));
    const BUILTINS = ['ceil', 'floor', 'step', 'mix', 'fract', 'sign', 'length', 'distance', 'min', 'max', 'clamp', 'smoothstep', 'reflect', 'normalize', 'dot', 'cross', 'pow', 'exp', 'log', 'sin', 'cos', 'abs', 'mod'];
    const hidden = BUILTINS.filter((n) => new RegExp(`\\b(float|vec[234]|int|bool)\\s+${n}\\s*[=;,]`).test(fs));
    check(`${lib}: no variable hides a GLSL built-in`, hidden.length === 0, hidden.join(' '));
  }
  check('the arrays cover every layer', mat.onBeforeCompile && Object.keys(LAY).length <= 24);
}

done();
