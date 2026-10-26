#!/usr/bin/env node
// Stage P1 check (terrain look): the ground cover, the deck-end carve, the far albedo painted from the cover
// and the terrain material, built in node and measured.
//   node tools/p1_terrain_test.mjs
//  1. Ground cover (src/map/terrain.js groundCover): its shape, the same answer twice, its time, and the land
//     it describes: lawns in the towns and not the marsh, the Heights drier than the Gables, sawgrass only in
//     the Glades, limestone on the cliffs and the cutting faces, wet sand along the waterline, the golf
//     course's stripes, variety over the wild grass, every district's lawns kept differently (not one green),
//     and the Glades' mud rims round their water, dark hammocks among golden sawgrass.
//  2. The carve (src/map/terrain.js): no sea bed raised more than 0.6 m out of the water within 25 m of a
//     bridge deck's end (the sand horns either side of the abutments, up to 6 m tall; before P1 675
//     vertices), and the fill flanks elsewhere left as they were.
//  3. The far albedo (src/3d/terrain3d.js toneAlbedo over mapimage farAlbedo's pixels): grass within the map's
//     own brightness range (s4a's rule) yet varied (lush to straw), steep ground stone-coloured rather than
//     green, no lime, wet sand marked wet in alpha and built ground dry, the Gables' lawns varied and not
//     emerald, the cliffs warm and banded (strata), and the time it takes.
//  4. The terrain material and grids (buildTerrain3D): the cover and the detail made here wait for the first
//     setAlbedo (off the page's load) and the fine grids built before it are re-splatted then, the cover it
//     exposes, the shader it compiles (its functions in, nothing undefined), the albedo as RGBA data with the
//     wetness kept, the limestone detail channel, and the splat on a cutting face.
// Exits 1 if any check fails.
import { src, check, section, note, done } from './s3b_env.mjs';
globalThis.KC_WORLD = 'v2';
const THREE = await import('three');
const W = await import(src('src/world.js'));
W.generate();
const TM = await import(src('src/map/terrain.js'));
const T3 = await import(src('src/3d/terrain3d.js'));
const { mapPixels } = await import(src('src/map/mapimage.js'));
const G = W.grids, [VW, VH] = G.dims.terrain, [SW] = G.dims.surf;
const REG = (x, z) => W.regionAt(x * 16, z * 16);
const tAt = (x, z) => G.terrain[Math.min(VH - 1, Math.max(0, Math.round(z / 2))) * VW + Math.min(VW - 1, Math.max(0, Math.round(x / 2)))];
const kindAt = (x, z) => G.surf[Math.floor(z) * SW + Math.floor(x)] & 15;
const fnv = (arrs) => { let h = 0x811c9dc5; for (const a of arrs) for (let i = 0; i < a.length; i += 7) { h ^= a[i]; h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };

// ---------- 1. ground cover ----------

section('ground cover');
const FIELDS = ['lawn', 'brown', 'dry', 'lush', 'bare', 'rock', 'marsh', 'wet', 'golf', 'tone'];
let C;
{
  const t0 = performance.now();
  C = TM.groundCover(W);
  const t1 = performance.now(), C2 = TM.groundCover(W), t2 = performance.now();
  check('groundCover gives 512×448 cells of 4 m with every field', C.w === 512 && C.h === 448 && C.cell === TM.COVER_CELL && FIELDS.every(k => C[k]?.length === C.w * C.h), `${C.w}×${C.h} @ ${C.cell} m`);
  check('the same cover twice', fnv(FIELDS.map(k => C[k])) === fnv(FIELDS.map(k => C2[k])));
  check('a warm run within 250 ms (node)', t2 - t1 < 250, `${(t2 - t1).toFixed(0)} ms`);
  note(`groundCover ${(t1 - t0).toFixed(0)} ms cold, ${(t2 - t1).toFixed(0)} ms warm`);
}
const cellOf = (x, z) => Math.min(C.h - 1, Math.floor(z / C.cell)) * C.w + Math.min(C.w - 1, Math.floor(x / C.cell));
// per region: the mean of each field over the cells with natural ground
const byRegion = {};
for (let j = 0; j < C.h; j++) for (let i = 0; i < C.w; i++) {
  const x = (i + 0.5) * C.cell, z = (j + 0.5) * C.cell, k = kindAt(x, z);
  if (k !== 2) continue;                       // grass
  const r = REG(x, z), c = j * C.w + i, m = (byRegion[r] ||= { n: 0 });
  m.n++;
  for (const f of FIELDS) m[f] = (m[f] || 0) + C[f][c] / 255;
}
for (const m of Object.values(byRegion)) for (const f of FIELDS) m[f] /= m.n;
{
  const R = byRegion, f2 = v => v.toFixed(2);
  note(Object.entries(R).map(([r, m]) => `${r} lawn ${f2(m.lawn)} dry ${f2(m.dry)} marsh ${f2(m.marsh)}`).join('; '));
  check('the towns are mostly lawn (K-Town, Downtown, Deco Beach)', ['ktown', 'downtown', 'deco'].every(r => R[r].lawn > 0.6), ['ktown', 'downtown', 'deco'].map(r => f2(R[r].lawn)).join(' '));
  check('the Glades are not lawn', R.glades.lawn < 0.2, f2(R.glades.lawn));
  check('the Heights are drier than the Gables', R.heights.dry > R.gables.dry + 0.12, `${f2(R.heights.dry)} vs ${f2(R.gables.dry)}`);
  check('sawgrass is the Glades\' alone', R.glades.marsh > 0.35 && Object.entries(R).every(([r, m]) => r === 'glades' || m.marsh < 0.06), f2(R.glades.marsh));
}
{
  // limestone: the cliffs (ROCK cells), and the pass cutting's faces (the Loop at x 700-830, z 280-345)
  let cliff = 0, cliffRock = 0, face = 0, faceRock = 0;
  for (let j = 0; j < C.h; j++) for (let i = 0; i < C.w; i++) {
    const x = (i + 0.5) * C.cell, z = (j + 0.5) * C.cell, c = j * C.w + i;
    let rk = 0;
    for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) if (kindAt(x + a, z + b) === 11) rk++;
    if (rk === 4) { cliff++; if (C.rock[c] >= 200) cliffRock++; }
    if (x > 700 && x < 830 && z > 280 && z < 345 && kindAt(x, z) === 2) {
      const s = Math.hypot(tAt(x + 2, z) - tAt(x - 2, z), tAt(x, z + 2) - tAt(x, z - 2)) / 4;
      if (s > 0.55) { face++; if (C.rock[c] > 128) faceRock++; }
    }
  }
  check('the cliffs are limestone', cliff > 200 && cliffRock >= 0.95 * cliff, `${cliffRock} of ${cliff}`);
  check('the pass cutting\'s faces are limestone', face > 20 && faceRock >= 0.7 * face, `${faceRock} of ${face} cells steeper than 0.55`);
}
{
  // the beach goes wet toward the waterline (-0.8 m) and stays dry above the sea's reach
  let low = 0, lowWet = 0, high = 0, highWet = 0;
  for (let j = 0; j < C.h; j++) for (let i = 0; i < C.w; i++) {
    const x = (i + 0.5) * C.cell, z = (j + 0.5) * C.cell, c = j * C.w + i;
    if ([[-1, -1], [1, -1], [-1, 1], [1, 1]].some(([a, b]) => kindAt(x + a, z + b) !== 7)) continue;
    const y = tAt(x, z);
    if (y < -0.7) { low++; if (C.wet[c] > 150) lowWet++; } else if (y > 0.3) { high++; if (C.wet[c] > 25) highWet++; }
  }
  check('wet sand along the waterline', low > 100 && lowWet >= 0.9 * low, `${lowWet} of ${low}`);
  check('dry sand above it', high > 100 && highWet <= 0.02 * high, `${highWet} of ${high} wet`);
}
{
  const g = [...C.golf], light = g.filter(v => v > 127).length, dark = g.filter(v => v > 0 && v <= 127).length;
  check('the golf course is mown in stripes', light > 100 && dark > 100, `${light} light, ${dark} dark cells`);
  // variety over the wild grass of the Heights, North Shore, the fest grounds and the cape: not one colour
  const vals = [];
  for (let c = 0; c < C.w * C.h; c++) {
    const x = (c % C.w + 0.5) * C.cell, z = (Math.floor(c / C.w) + 0.5) * C.cell;
    if (kindAt(x, z) === 2 && C.lawn[c] < 50 && ['heights', 'north_shore', 'fest_airport', 'cape'].includes(REG(x, z))) vals.push(C.dry[c] / 255);
  }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length, sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  check('the wild grass varies from fresh to dry', vals.length > 5000 && sd > 0.12, `sd ${sd.toFixed(3)} over ${vals.length} cells (mean ${mean.toFixed(2)})`);
}
{
  // each district's lawns: kept differently from yard to yard (brown), not one green
  const by = {};
  for (let c = 0; c < C.w * C.h; c++) {
    const x = (c % C.w + 0.5) * C.cell, z = (Math.floor(c / C.w) + 0.5) * C.cell, r = REG(x, z);
    if (kindAt(x, z) === 2 && C.lawn[c] > 200 && !C.golf[c]) (by[r] ||= []).push(C.brown[c] / 255);
  }
  const sdOf = (a) => { const m = a.reduce((p, q) => p + q, 0) / a.length; return Math.sqrt(a.reduce((p, q) => p + (q - m) ** 2, 0) / a.length); };
  const ds = ['gables', 'ktown', 'downtown', 'deco', 'collins'], sds = ds.map(r => sdOf(by[r]));
  check('every district\'s lawns vary in how they are kept', ds.every(r => by[r].length > 1000) && sds.every(v => v > 0.14), ds.map((r, k) => `${r} ${sds[k].toFixed(2)}`).join(' '));
}
{
  // the Glades: mud round the ponds' edges and not out on the dry ground; hammocks (no sawgrass, lush) among
  // the sawgrass
  const water = (x, z) => { const k = kindAt(x, z); return k === 6 || k === 9; };
  let rim = 0, rimWet = 0, inland = 0, inlandWet = 0, cells = 0, ham = 0, saw = 0;
  for (let j = 4; j < C.h - 4; j++) for (let i = 4; i < C.w - 4; i++) {
    const x = (i + 0.5) * C.cell, z = (j + 0.5) * C.cell, c = j * C.w + i;
    if (kindAt(x, z) !== 2 || REG(x, z) !== 'glades') continue;
    cells++;
    if (C.marsh[c] < 25 && C.lush[c] > 200) ham++; else if (C.marsh[c] > 128) saw++;
    let near = false, far = true;
    for (let b = -6; b <= 6; b++) for (let a = -6; a <= 6; a++) if (water(x + a * 4, z + b * 4)) { far = false; if (Math.abs(a) <= 1 && Math.abs(b) <= 1) near = true; }
    if (near) { rim++; rimWet += C.wet[c] / 255; } else if (far) { inland++; inlandWet += C.wet[c] / 255; }
  }
  check('the Glades\' water has a mud rim', rim > 200 && rimWet / rim > 0.6 && inlandWet / inland < 0.2, `rim ${(rimWet / rim).toFixed(2)} wet over ${rim} cells, inland ${(inlandWet / inland).toFixed(2)}`);
  check('the Glades have hammocks among the sawgrass', ham > 0.1 * cells && ham < 0.5 * cells && saw > 0.3 * cells, `${(ham / cells * 100).toFixed(0)}% hammock, ${(saw / cells * 100).toFixed(0)}% sawgrass`);
}

// ---------- 2. the carve at the deck ends ----------

section('carve: no horns beside the deck ends');
{
  const D = await import(src('src/map/mapdata.js'));
  const { buildRoadNet } = await import(src('src/map/roadnet.js'));
  const TR = TM.buildTerrain(D, {}), roads = {};
  buildRoadNet(D.ROADS, D.ROAD_CLASSES, { heightAt: TR.naturalAt, px: 16, seaLevel: D.SEA_LEVEL, signals: D.SIGNALS.candidates, signalsOn: D.SIGNALS.enabled, priority: D.SIGNALS.priority, into: roads });
  TR.solveProfiles(roads);
  TR.carve(roads);
  // the deck ends: the first and last sample of every deck span
  const ends = [];
  for (const e of roads.edges) for (const [a, b] of e.deck || []) for (const s of [a, b]) {
    let k = 0;
    while (k < e.n - 1 && e.s[k + 1] < s) k++;
    ends.push([e.x[k] / 16, e.y[k] / 16]);
  }
  let near = 0, far = 0;
  for (let v = 0; v < TR.terrain.length; v++) {
    if (!(TR.natural[v] < D.SEA_LEVEL && TR.terrain[v] > D.SEA_LEVEL) || TR.roadMask[v]) continue;
    const x = (v % TR.w) * 2, z = Math.floor(v / TR.w) * 2;
    if (!ends.some(([ex, ez]) => Math.hypot(x - ex, z - ez) < 25)) far++;
    else if (TR.terrain[v] > D.SEA_LEVEL + 0.6) near++;
  }
  // (one shore vertex at the causeway's island end stands in the abutment's own bank)
  check('no sea bed raised over 0.6 m out of the water within 25 m of a deck end', ends.length >= 16 && near <= 1, `${near} vertices at ${ends.length} deck ends`);
  check('the fill flanks away from the deck ends stay (a few hundred vertices)', far > 100 && far < 1000, `${far}`);
}

// ---------- 3. the far albedo ----------

section('far albedo from the cover');
{
  const img = mapPixels(W, 0.5, { shade: false, look: 'albedo' }), before = img.data.slice();
  const t0 = performance.now();
  T3.toneAlbedo(W, img.data, img.w, img.h, C);
  note(`toneAlbedo ${(performance.now() - t0).toFixed(0)} ms over ${img.w}×${img.h}`);
  const d = img.data, k = SW / img.w;
  let grass = 0, wild = 0, dry = 0, green = 0, lime = 0, steep = 0, steepGreen = 0, wetSand = 0, wetMarked = 0, built = 0, builtWet = 0;
  const lums = [];
  for (let j = 0; j < img.h; j++) for (let i = 0; i < img.w; i++) {
    const q = [0, 1].flatMap(b => [0, 1].map(a => G.surf[(j * k + b) * SW + i * k + a] & 15)), o = (j * img.w + i) * 4;
    const r = d[o], g = d[o + 1], b = d[o + 2], y = G.terrain[j * VW + i];
    if (q.every(c => c === 2)) {
      grass++;
      const ratio = (r + g + b) / Math.max(1, before[o] + before[o + 1] + before[o + 2]);
      if (ratio < 0.6 || ratio > 1.3) wild++;
      if (r > 0.9 * g) dry++; else if (g > 1.2 * r) green++;      // (green: the lawns are kept muted, see COVER_RGB)
      // lime: a bright yellow-green, the old look (value over 60%, saturation over 55%, hue 70-100 degrees)
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx ? (mx - mn) / mx : 0, hue = g === mx ? 60 * (2 + (b - r) / Math.max(1, mx - mn)) : 0;
      if (mx > 153 && sat > 0.55 && hue > 70 && hue < 100) lime++;
      if (i % 4 === 0 && j % 4 === 0) lums.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
      const vi = i, vj = j;
      if (vi > 0 && vj > 0 && vi < VW - 1 && vj < VH - 1) {
        const s = Math.hypot(G.terrain[vj * VW + vi + 1] - G.terrain[vj * VW + vi - 1], G.terrain[(vj + 1) * VW + vi] - G.terrain[(vj - 1) * VW + vi]) / 4;
        if (s > 0.9) { steep++; if (g > 1.12 * r) steepGreen++; }
      }
    }
    if (q.every(c => c === 7) && y < -0.7) { wetSand++; if (d[o + 3] > 100) wetMarked++; }
    if (q.every(c => c === 0)) { built++; if (d[o + 3]) builtWet++; }
  }
  const mean = lums.reduce((a, b) => a + b, 0) / lums.length, sd = Math.sqrt(lums.reduce((a, b) => a + (b - mean) ** 2, 0) / lums.length);
  check('grass stays within -40%..+30% of the map\'s own (s4a\'s rule)', grass > 1e5 && wild === 0, `${wild} of ${grass}`);
  check('grass varies in brightness', sd > 8, `sd ${sd.toFixed(1)} (0-255) about ${mean.toFixed(0)}`);
  check('both dry and green grass, neither everywhere', dry > 0.05 * grass && dry < 0.7 * grass && green > 0.15 * grass, `${(dry / grass * 100).toFixed(0)}% dry, ${(green / grass * 100).toFixed(0)}% green`);
  check('no lime', lime < 0.01 * grass, `${(lime / grass * 100).toFixed(2)}%`);
  check('steep ground (over 42 degrees) is stone-coloured, not green', steep > 200 && steepGreen <= 0.1 * steep, `${steepGreen} of ${steep} green`);
  check('wet sand is marked wet in alpha', wetSand > 200 && wetMarked >= 0.9 * wetSand, `${wetMarked} of ${wetSand}`);
  check('roads are dry', built > 1e4 && builtWet === 0, `${builtWet} of ${built}`);
  // the Gables' lawns from the air: varied (10th to 90th percentile of brightness over 15% apart) and not
  // emerald (green over red under 1.45 on average); the cliffs warm (red over blue) and banded
  const lawnL = [], cliffL = [];
  let gr = 0, nl = 0, warm = 0, nc = 0;
  for (let j = 0; j < img.h; j += 2) for (let i = 0; i < img.w; i += 2) {
    const o = (j * img.w + i) * 4, x = (i + 0.5) * 2, z = (j + 0.5) * 2, c = cellOf(x, z);
    const q = [0, 1].flatMap(b => [0, 1].map(a => G.surf[(j * k + b) * SW + i * k + a] & 15)), L = 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];
    if (q.every(v => v === 2) && C.lawn[c] > 220 && !C.golf[c] && REG(x, z) === 'gables') { lawnL.push(L); gr += d[o + 1] / Math.max(1, d[o]); nl++; }
    if (q.every(v => v === 11)) { cliffL.push(L); warm += d[o] - d[o + 2]; nc++; }
  }
  const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(p * (a.length - 1))], lm = lawnL.reduce((a, b) => a + b, 0) / nl;
  const spread = (pct(lawnL, 0.9) - pct(lawnL, 0.1)) / lm;
  check('the Gables\' lawns vary from the air', nl > 2000 && spread > 0.15, `p10-p90 ${(spread * 100).toFixed(0)}% of the mean over ${nl} pixels`);
  check('the Gables\' lawns are not emerald', gr / nl < 1.45, `green/red ${(gr / nl).toFixed(2)}`);
  const cm = cliffL.reduce((a, b) => a + b, 0) / nc, csd = Math.sqrt(cliffL.reduce((a, b) => a + (b - cm) ** 2, 0) / nc);
  check('the cliffs are warm limestone, banded', nc > 200 && warm / nc > 25 && csd > 10, `red-blue ${(warm / nc).toFixed(0)}, brightness sd ${csd.toFixed(1)} over ${nc} pixels`);
}

// ---------- 4. the terrain material and grids ----------

section('terrain material and grids');
{
  const t0 = performance.now(), T = T3.buildTerrain3D(W, null, {});
  note(`buildTerrain3D ${(performance.now() - t0).toFixed(0)} ms (no cover, no detail made yet)`);
  // before the first setAlbedo: no cover, a flat detail, and a fine grid built then splats no limestone on grass
  T.buildAround(765, 312, 1);
  const tile = T.tiles.find(t => t.lod0 && t.box[0] <= 765 && t.box[2] >= 765 && t.box[1] <= 312 && t.box[3] >= 312);
  const rockyOf = () => {
    const P = tile.lod0.geometry.attributes.position.array, S = tile.lod0.geometry.attributes.splat.array, NR = tile.lod0.geometry.attributes.normal.array;
    let face = 0, rocky = 0;
    for (let v = 0; v < 129 * 129; v++) {
      const x = P[v * 3], z = P[v * 3 + 2];
      if (x < 700 || x > 830 || z < 280 || z > 345 || kindAt(x, z) !== 2 || NR[v * 3 + 1] > 0.85) continue;
      face++;
      if (S[v * 4 + 1] > 128) rocky++;
    }
    return [rocky, face];
  };
  const flat = T.textures.detail.image.data.every((v, i) => (i & 3) === 1 || (i & 3) === 2 || v === 128);
  const [r0] = rockyOf();
  check('the cover and the detail made here wait for the first setAlbedo', flat && r0 === 0, `detail flat ${flat}, ${r0} limestone vertices on the cutting`);
  // the albedo: RGBA data, the wetness kept in alpha (a canvas would premultiply it away)
  const img = mapPixels(W, 0.5, { shade: false, look: 'albedo' });
  const canvas = { width: img.w, height: img.h, getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(img.data) }) }) };
  const t1 = performance.now();
  T.setAlbedo(canvas);
  note(`the first setAlbedo ${(performance.now() - t1).toFixed(0)} ms (cover, detail, re-splat, toneAlbedo)`);
  check('buildTerrain3D exposes the cover it paints from', T.cover && T.cover.w === C.w && fnv([T.cover.dry]) === fnv([C.dry]));
  // the shaders as three would compile them
  for (const [name, m] of Object.entries(T.materials)) {
    const sh = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
    m.onBeforeCompile(sh);
    const fr = sh.fragmentShader, ok = fr.includes('terrainBase(') && (name === 'lod1' || fr.includes('terrainDetail(')) && !/undefined|NaN/.test(fr + sh.vertexShader);
    check(`${name}: the shader takes the terrain's functions, with nothing undefined`, ok);
    check(`${name}: uniforms for the albedo, the limestone tint and the detail`, sh.uniforms.tAlbedo?.value === T.textures.albedo && sh.uniforms.uRock?.value?.isColor && sh.uniforms.tDetail?.value === T.textures.detail);
  }
  const A = T.textures.albedo;
  let wet = 0;
  for (let i = 3; i < A.image.data.length; i += 4) if (A.image.data[i] > 100) wet++;
  check('setAlbedo gives the texture RGBA data of the painted size, wetness in alpha', A.isDataTexture && A.image.width === img.w && A.image.data.length === img.w * img.h * 4 && wet > 200, `${wet} wet texels`);
  check('the albedo is sRGB, mipmapped and clamped', A.colorSpace === THREE.SRGBColorSpace && A.generateMipmaps && A.minFilter === THREE.LinearMipmapLinearFilter && A.wrapS === THREE.ClampToEdgeWrapping);
  // the limestone detail (channel A) is made here: centred on 0.5 with a real spread
  const det = T.textures.detail.image.data;
  let s = 0, s2 = 0, n = 0;
  for (let i = 3; i < det.length; i += 4) { s += det[i]; s2 += det[i] * det[i]; n++; }
  const dm = s / n, dsd = Math.sqrt(s2 / n - dm * dm);
  check('the limestone detail is centred with a spread', Math.abs(dm - 128) < 4 && dsd > 15, `mean ${dm.toFixed(1)} sd ${dsd.toFixed(1)}`);
  // a cutting's face takes the limestone splat: the tile over the pass cutting, built before setAlbedo and
  // re-splatted by it (skirts included)
  const [rocky, face] = rockyOf(), g = tile.lod0.geometry, S = g.attributes.splat.array, src = g.userData.skirtSrc;
  check('the pass cutting\'s steep vertices splat limestone', face > 20 && rocky >= 0.6 * face, `${rocky} of ${face}`);
  let skirtOk = true;
  for (let s = 0; s < src.length; s++) for (let ch = 0; ch < 4; ch++) if (S[(129 * 129 + s) * 4 + ch] !== S[src[s] * 4 + ch]) skirtOk = false;
  check('the skirts take their edge\'s new splat', skirtOk);
}

done();
