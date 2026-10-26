// The Kimchi Key v2 map picture (docs/map-v2-spec.md §7, §11.1): one image of the whole county that is the
// minimap and the big map, and (painted plainly, without the hillshade) the far terrain's albedo.
//
//   mapPixels(world, pxPerM = 1, { shade = true, look = 'map' | 'albedo' }) -> { w, h, data: Uint8ClampedArray
//                                    RGBA }: pure, runs in node; both canvases below are painted from it
//   renderMap(world, pxPerM = 1)  -> a canvas 2048×1792 at 1 px/m (browser, or anything with OffscreenCanvas):
//                                    region tints, hillshade, roads by class (the highway wide and orange),
//                                    building footprints with their shadows, water by depth, region labels
//   farAlbedo(world)              -> a canvas 1024×896 (2 m per px, each px the mean of its four cells): the
//                                    ground's own colours, roads in asphalt, no hillshade, shadows or labels
// world is anything with grids (surf, ground, seaDepth, reg and dims, as world-v2 fills them); REG codes are
// mapdata REGIONS indices. roads (the RoadNet) and buildings are optional: without roads the carriageways are
// coloured from SURF alone (the highway by its NOPED flag), without buildings the footprints are SURF's BUILD
// cells, untinted and without shadows.
import { KIND, KIND_MASK, FLAG } from './raster.js';
import { REGIONS } from './mapdata.js';

const { ROAD, WALK, GRASS, BUILD, LOT, PLAZA, WATER, SAND, DIRT, SHALLOW, DECK, ROCK } = KIND;
const PX = 16;

// Surface colours by kind [r, g, b], as the ground looks (the far albedo uses these as they are).
const COL = [];
COL[ROAD] = [74, 71, 68]; COL[WALK] = [184, 177, 164]; COL[GRASS] = [111, 154, 79]; COL[BUILD] = [141, 132, 120];
COL[LOT] = [95, 92, 87]; COL[PLAZA] = [214, 202, 178]; COL[WATER] = [79, 179, 207]; COL[SAND] = [232, 214, 166];
COL[DIRT] = [160, 124, 84]; COL[SHALLOW] = [116, 196, 196]; COL[DECK] = [150, 104, 70]; COL[ROCK] = [120, 112, 104];
// The map's own palette: roads light on the land, by class, the highway orange with a dark casing out past
// its shoulders so the Loop reads at a glance; sidewalks and lots pale.
const MAP = { walk: [184, 180, 171], lot: [178, 174, 166], plaza: [226, 216, 194], deck: [176, 150, 120], casing: [150, 78, 26], tarmac: [170, 170, 172] };
const ROAD_COL = {
  hwy: [236, 140, 48], blvd: [252, 248, 238], ave: [246, 242, 232], street: [236, 234, 228], ring: [250, 224, 232],
  coast: [252, 238, 204], country: [240, 228, 202], switch: [242, 218, 166], dirt: [176, 136, 92], alley: [222, 200, 236],
};
const CLASSES = Object.keys(ROAD_COL);
const DECK_COL = Object.fromEntries(CLASSES.map(c => [c, mix(ROAD_COL[c], MAP.deck, 0.35)]));
const RANK = { dirt: 1, alley: 2, street: 3, switch: 4, country: 5, ave: 6, coast: 7, blvd: 8, ring: 9, hwy: 10 };
const CASING = 2.5;            // m of dark casing past the highway's carriageway on the map
// Region grass on the map and in the albedo (each region's green), and the paler ground the map gives the
// built-up districts so blocks read as town. Both are feathered over TINT_BLUR REG cells either way.
const REGION_GRASS = {
  heights: [122, 156, 86], north_shore: [116, 160, 84], ktown: [118, 156, 86], downtown: [116, 154, 90], gables: [104, 160, 78],
  glades: [108, 146, 82], fest_airport: [134, 158, 90], port: [124, 150, 96], collins: [116, 162, 96], deco: [114, 164, 100],
  islets: [104, 164, 82], cape: [134, 158, 98],
};
const TOWN = { ktown: [184, 176, 158], downtown: [176, 178, 168], deco: [200, 186, 176], collins: [192, 188, 170], port: [170, 170, 160] };
const TINT_BLUR = 3;
const BUILDING = [222, 214, 204], OUTLINE = [112, 104, 96];

export function mapPixels(world, pxPerM = 1, { shade = true, look = shade ? 'map' : 'albedo' } = {}) {
  const G = world.grids, W = G.w, H = G.h, map = look === 'map';
  const cls = world.roads?.edges?.length ? classRaster(world.roads, W, H, map) : null;
  const P = { G, W, H, cls, map, cw: G.dims.seaDepth[0], ch: G.dims.seaDepth[1] };
  // the cells at 1 m, then the picture at pxPerM: the mean of the cells under a px when they are smaller than
  // it (thin roads still tint the far ground), the nearest cell when they are larger
  const cells = paintCells(world, P, shade);
  let out = { w: W, h: H, data: cells };
  if (pxPerM !== 1) out = resample(cells, W, H, pxPerM);
  if (map) paintBuildings(world, P, out.data, out.w, out.h, pxPerM);
  return out;
}

export function renderMap(world, pxPerM = 1) {
  const img = mapPixels(world, pxPerM), c = toCanvas(img);
  labelRegions(c.getContext('2d'), world, pxPerM);
  return c;
}

export function farAlbedo(world) {
  return toCanvas(mapPixels(world, 0.5, { shade: false, look: 'albedo' }));
}

// ---------- the cells ----------

// RGBA per 1 m SURF cell: its kind's colour (grass by region, roads by class), water darker with depth, and
// with shade the hillshade from GROUND, lit from the north-west. The tint and the shade are worked out once
// per 2 m cell, which every one of its four 1 m cells shares.
function paintCells(world, P, shade) {
  const { G, W, H, cls, map, cw, ch } = P, surf = G.surf, sea = G.seaDepth, data = new Uint8ClampedArray(W * H * 4);
  const tint = tintCells(world, map, cw, ch), sh = shade ? shadeCells(G, cw, ch) : null;
  const table = kindTable(map), px = new Uint32Array(data.buffer);
  // one 32-bit write per cell: RGBA in memory order is A<<24 | B<<16 | G<<8 | R on a little-endian machine
  const LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  for (let j = 0; j < H; j++) {
    const cj = Math.min(ch - 1, j >> 1) * cw;
    for (let i = 0; i < W; i++) {
      const c = j * W + i, bits = surf[c], k = bits & KIND_MASK, q = cj + Math.min(cw - 1, i >> 1), o = c * 4;
      let r, g, b, s = sh ? sh[q] : 1;
      if (k === WATER || k === SHALLOW) { s = 1 - 0.55 * sea[q] / 255; r = table[k * 3]; g = table[k * 3 + 1]; b = table[k * 3 + 2]; }
      else if (k === ROAD || k === DECK || k === DIRT) { const col = roadColour(P, c, bits, k); r = col[0]; g = col[1]; b = col[2]; }
      else if (map && cls && (cls[c] & 0x80) && k !== BUILD) { r = MAP.casing[0]; g = MAP.casing[1]; b = MAP.casing[2]; }
      else if (k === GRASS) { r = tint[q * 3]; g = tint[q * 3 + 1]; b = tint[q * 3 + 2]; }
      else { r = table[k * 3]; g = table[k * 3 + 1]; b = table[k * 3 + 2]; }
      r *= s; g *= s; b *= s;
      r = r > 255 ? 255 : r < 0 ? 0 : r | 0; g = g > 255 ? 255 : g < 0 ? 0 : g | 0; b = b > 255 ? 255 : b < 0 ? 0 : b | 0;
      if (LE) px[c] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
      else { data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255; }
    }
  }
  return data;
}

// RGB per kind, the map's own palette over the ground's where it has one.
function kindTable(map) {
  const t = new Float32Array(16 * 3);
  COL.forEach((c, k) => {
    const m = !map ? c : k === WALK ? MAP.walk : k === LOT ? MAP.lot : k === PLAZA ? MAP.plaza : k === BUILD ? BUILDING : c;
    t[k * 3] = m[0]; t[k * 3 + 1] = m[1]; t[k * 3 + 2] = m[2];
  });
  return t;
}

// The hillshade per 2 m cell: slopes facing the north-west brighten, the far side darkens.
function shadeCells(G, cw, ch) {
  const g = G.ground, vw = G.dims.ground[0], out = new Float32Array(cw * ch);
  for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
    const v = j * vw + i, g0 = g[v], s = 1 - ((g[v + 1] - g0) + (g[v + vw] - g0)) * 0.3;
    out[j * cw + i] = s < 0.6 ? 0.6 : s > 1.3 ? 1.3 : s;
  }
  return out;
}

// The grass colour per 2 m cell, bilinear in the feathered region field (plain grass without REG).
function tintCells(world, map, cw, ch) {
  const out = new Float32Array(cw * ch * 3), T = regionTints(world, map), base = COL[GRASS];
  if (!T) { for (let q = 0; q < cw * ch; q++) out.set(base, q * 3); return out; }
  const [rw, rh, rc] = world.grids.dims.reg;
  for (let j = 0; j < ch; j++) {
    const fz = Math.min(Math.max((j * 2 + 1) / rc - 0.5, 0), rh - 1), z0 = Math.min(Math.floor(fz), rh - 2), tz = fz - z0;
    for (let i = 0; i < cw; i++) {
      const fx = Math.min(Math.max((i * 2 + 1) / rc - 0.5, 0), rw - 1), x0 = Math.min(Math.floor(fx), rw - 2), tx = fx - x0;
      const a = (z0 * rw + x0) * 3, b = a + 3, c = a + rw * 3, d = c + 3, o = (j * cw + i) * 3;
      for (let q = 0; q < 3; q++) out[o + q] = (T[a + q] * (1 - tx) + T[b + q] * tx) * (1 - tz) + (T[c + q] * (1 - tx) + T[d + q] * tx) * tz;
    }
  }
  return out;
}

function roadColour(P, c, bits, k) {
  const code = P.cls ? P.cls[c] & 0x7f : 0;
  if (!P.map) return k === DIRT || (code && CLASSES[code - 1] === 'dirt') ? COL[DIRT] : k === DECK ? COL[DECK] : COL[ROAD];
  if (code) {
    const name = CLASSES[code - 1];
    return k === DECK && name !== 'hwy' ? DECK_COL[name] : ROAD_COL[name];
  }
  // paved but no road's (the runway, yards; decks: the pier and the promenades); without a RoadNet the
  // highway by its flag and the rest by kind
  if (P.cls) return k === DIRT ? ROAD_COL.dirt : k === DECK ? MAP.deck : MAP.tarmac;
  return bits & FLAG.NOPED ? ROAD_COL.hwy : k === DIRT ? ROAD_COL.dirt : k === DECK ? MAP.deck : ROAD_COL.street;
}

// The picture at pxPerM from the 1 m cells: box mean when shrinking, nearest when growing.
function resample(cells, W, H, k) {
  const w = Math.round(W * k), h = Math.round(H * k), data = new Uint8ClampedArray(w * h * 4);
  if (k > 1) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, c = (Math.min(H - 1, Math.floor(y / k)) * W + Math.min(W - 1, Math.floor(x / k))) * 4;
      data[o] = cells[c]; data[o + 1] = cells[c + 1]; data[o + 2] = cells[c + 2]; data[o + 3] = 255;
    }
    return { w, h, data };
  }
  const step = Math.round(1 / k), n = step * step;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0;
    for (let dj = 0; dj < step; dj++) for (let di = 0; di < step; di++) {
      const c = (Math.min(H - 1, y * step + dj) * W + Math.min(W - 1, x * step + di)) * 4;
      r += cells[c]; g += cells[c + 1]; b += cells[c + 2];
    }
    const o = (y * w + x) * 4;
    data[o] = r / n; data[o + 1] = g / n; data[o + 2] = b / n; data[o + 3] = 255;
  }
  return { w, h, data };
}

// The tint field: per REG cell the colour of its region (the town colour on the map), box-blurred over
// TINT_BLUR cells each way with only land cells counted, so districts fade into each other over some 50 m
// and the coast keeps its land's colour. RGB floats per REG cell, or null without REG.
function regionTints(world, map) {
  const G = world.grids, reg = G.reg, [rw, rh] = G.dims.reg || [];
  if (!reg || !rw) return null;
  const pal = REGIONS.map(r => (map && TOWN[r.id]) || REGION_GRASS[r.id] || COL[GRASS]);
  const src = new Float32Array(rw * rh * 4);           // r, g, b, weight
  for (let c = 0; c < rw * rh; c++) { const p = pal[reg[c]]; if (p) { src[c * 4] = p[0]; src[c * 4 + 1] = p[1]; src[c * 4 + 2] = p[2]; src[c * 4 + 3] = 1; } }
  const tmp = new Float32Array(rw * rh * 4), R = TINT_BLUR;
  for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) for (let d = -R; d <= R; d++) {
    const ii = i + d;
    if (ii < 0 || ii >= rw) continue;
    for (let q = 0; q < 4; q++) tmp[(j * rw + i) * 4 + q] += src[(j * rw + ii) * 4 + q];
  }
  const out = new Float32Array(rw * rh * 3), base = COL[GRASS];
  for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let d = -R; d <= R; d++) {
      const jj = j + d;
      if (jj < 0 || jj >= rh) continue;
      const o = (jj * rw + i) * 4;
      r += tmp[o]; g += tmp[o + 1]; b += tmp[o + 2]; n += tmp[o + 3];
    }
    const o = (j * rw + i) * 3;
    if (n > 0) { out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; } else { out[o] = base[0]; out[o + 1] = base[1]; out[o + 2] = base[2]; }
  }
  return out;
}

// ---------- roads by class ----------

// Per 1 m cell, the class (1 + its index in CLASSES) of the road whose carriageway covers it, the higher
// rank winning where two meet; on the map, bit 0x80 marks the highway's casing.
function classRaster(net, W, H, map) {
  const out = new Uint8Array(W * H), edges = net.edges.slice().sort((a, b) => (RANK[a.cls] || 0) - (RANK[b.cls] || 0));
  for (const e of edges) {
    const code = CLASSES.indexOf(e.cls) + 1;
    if (!code) continue;
    const hw = e.halfW / PX, r = map && e.cls === 'hwy' ? hw + CASING : hw;
    for (let k = 0; k + 1 < e.n; k++) band(out, W, H, e.x[k] / PX, e.y[k] / PX, e.x[k + 1] / PX, e.y[k + 1] / PX, hw, r, code);
  }
  return out;
}

// One segment's band: code within hw, the casing bit out to r (never over another road's carriageway).
function band(out, W, H, ax, az, bx, bz, hw, r, code) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz, hw2 = hw * hw, r2 = r * r;
  const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - r)), i1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + r));
  const j0 = Math.max(0, Math.floor(Math.min(az, bz) - r)), j1 = Math.min(H - 1, Math.ceil(Math.max(az, bz) + r));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const qx = i + 0.5 - ax, qz = j + 0.5 - az;
    let t = L2 > 0 ? (qx * dx + qz * dz) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = qx - dx * t, ez = qz - dz * t, d2 = ex * ex + ez * ez, c = j * W + i;
    if (d2 <= hw2) out[c] = code;
    else if (d2 <= r2 && !(out[c] & 0x7f)) out[c] |= 0x80;
  }
}

// ---------- building footprints ----------

// On the map every BUILD cell is a pale roof tinted by its building's roof colour, outlined where it meets
// anything else, with a shadow cast to the south-east as long as the building is tall (up to 6 m).
function paintBuildings(world, P, data, w, h, k) {
  const { G, W, H } = P, surf = G.surf, B = world.buildings || [];
  const isB = (x, y) => { const i = Math.floor(x / k), j = Math.floor(y / k); return i >= 0 && j >= 0 && i < W && j < H && (surf[j * W + i] & KIND_MASK) === BUILD; };
  // shadows first, on everything that is not a building, each px darkened once however many fall on it
  const shadow = new Uint8Array(w * h);
  for (const b of B) eachPx(b, k, w, h, Math.min(6, 1 + b.h / 12) * k, (x, y, o) => { shadow[o >> 2] = 1; });
  for (let q = 0; q < w * h; q++) {
    if (!shadow[q] || isB((q % w) + 0.5, Math.floor(q / w) + 0.5)) continue;
    const o = q * 4;
    data[o] *= 0.72; data[o + 1] *= 0.72; data[o + 2] *= 0.76;
  }
  for (const b of B) {
    const roof = hex(b.roof), c = roof ? mix(BUILDING, roof, 0.3) : BUILDING;
    eachPx(b, k, w, h, 0, (x, y, o) => { if (isB(x, y)) { data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; } });
  }
  // the outline: a building px with a non-building px beside it
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (k === 1 ? (surf[y * W + x] & KIND_MASK) !== BUILD : !isB(x + 0.5, y + 0.5)) continue;
    if (isB(x - 0.5, y + 0.5) && isB(x + 1.5, y + 0.5) && isB(x + 0.5, y - 0.5) && isB(x + 0.5, y + 1.5)) continue;
    const o = (y * w + x) * 4;
    data[o] = OUTLINE[0]; data[o + 1] = OUTLINE[1]; data[o + 2] = OUTLINE[2];
  }
}

// Calls fn(x, y, offset) for every px whose centre lies in building b's footprint, moved s px south-east.
function eachPx(b, k, w, h, s, fn) {
  const cx = b.cx * k + s, cz = b.cz * k + s, fx = Math.cos(b.a), fz = Math.sin(b.a), rx = fz, rz = -fx, hw = b.w * k / 2, hd = b.d * k / 2;
  const ex = Math.abs(rx) * hw + Math.abs(fx) * hd, ez = Math.abs(rz) * hw + Math.abs(fz) * hd;
  for (let y = Math.max(0, Math.floor(cz - ez)); y <= Math.min(h - 1, Math.ceil(cz + ez)); y++)
    for (let x = Math.max(0, Math.floor(cx - ex)); x <= Math.min(w - 1, Math.ceil(cx + ex)); x++) {
      const px = x + 0.5 - cx, pz = y + 0.5 - cz;
      if (Math.abs(px * rx + pz * rz) <= hw && Math.abs(px * fx + pz * fz) <= hd) fn(x + 0.5, y + 0.5, (y * w + x) * 4);
    }
}

// ---------- labels ----------

// Region names at the middle of each region's land (the mean of its REG cells), white on a dark outline.
function labelRegions(ctx, world, k) {
  const G = world.grids, reg = G.reg, [rw, rh, rc] = G.dims.reg || [];
  if (!reg || !ctx.fillText) return;
  const sum = REGIONS.map(() => [0, 0, 0]);
  for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) {
    const v = reg[j * rw + i];
    if (v < sum.length) { sum[v][0] += i; sum[v][1] += j; sum[v][2]++; }
  }
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(30 * k)}px system-ui, sans-serif`;
  ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2, 5 * k); ctx.strokeStyle = 'rgba(20, 24, 30, 0.75)'; ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  REGIONS.forEach((r, i) => {
    const [sx, sz, n] = sum[i];
    if (!n) return;
    const x = ((sx / n) + 0.5) * rc * k, y = ((sz / n) + 0.5) * rc * k, text = r.name.toUpperCase();
    ctx.strokeText(text, x, y); ctx.fillText(text, x, y);
  });
  ctx.restore();
}

// ---------- helpers ----------

function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function hex(s) { return typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s) ? [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16)) : null; }

function toCanvas({ w, h, data }) {
  let c;
  if (typeof document !== 'undefined') { c = document.createElement('canvas'); c.width = w; c.height = h; }
  else if (typeof OffscreenCanvas !== 'undefined') c = new OffscreenCanvas(w, h);
  else throw new Error('mapimage: no canvas here (use mapPixels in node)');
  const ctx = c.getContext('2d');
  ctx.putImageData(new ImageData(data, w, h), 0, 0);
  return c;
}
