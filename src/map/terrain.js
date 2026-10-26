// Kimchi Key v2 terrain (docs/map-v2-spec.md §3, §4.2, §4.5, §6.2): the coast distance field, the natural
// ground, the road profiles and the carve that sets the two height rasters. Plain typed-array math, so it
// runs in node and in a Worker.
//
// Two rasters of 1025×897 vertices, 2 m apart, origin at world (0,0):
//   TERRAIN  the natural ground and sea bed. Under a road it is the road bed, 0.20 m below the surface;
//            under a bridge deck it stays the sea bed. The terrain mesh, the sea depth and the cliff test
//            read it.
//   GROUND   what you walk and drive on: the road surface (banked) on roads and sidewalks, the deck on
//            bridges, TERRAIN everywhere else. groundY = bilinear GROUND + the surface's curb.
//
// buildTerrain(data, grids) builds the coast field and the natural TERRAIN at once, then returns the steps
// world-v2 runs after it, in order: solveProfiles(net), carve(net), pad(poly, y, blend) for each prefab and
// lot, and seaDepth(). data is the mapdata module (or any object with its names); grids.terrain,
// grids.ground and grids.seaDepth are filled in place when given, else created there.
import { fillPoly, distanceTransform, sampleGrid } from './raster.js';
import { sampleCurve } from './spline.js';

const STEP = 2;          // vertex spacing of GROUND and TERRAIN (m)
const NEAR = 36;         // within this of the shore (the widest shore profile, 35 m) distances are exact
const COARSE = 4;        // far-field distance grids use every 4th vertex (8 m)
const BED = 0.20;        // TERRAIN sits this far under the road surface
const PIN_WIN = 10;      // smoothing over authored y pins: rounds the kinks at control points only
const FREE_WIN = 30;     // smoothing over terrain-following stations (§4.2)
const KERNEL_MIN = 20;   // a junction's height correction spreads at least this far each way (m)
const BANK_CLEAR = 20;   // banking fades out over this distance past a junction
const DECK_END = 24;     // m along a road from a bridge deck within which its fill never spreads out over the sea

const smooth01 = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const lerp = (a, b, t) => a + (b - a) * t;

export function buildTerrain(data, grids = {}) {
  const t0 = now(), timing = {};
  const W = data.WORLD.w, H = data.WORLD.h, vw = W / STEP + 1, vh = H / STEP + 1, N = vw * vh;
  const vgrid = arr => ({ w: vw, h: vh, cell: STEP, o: 0, data: arr });
  const terrain = takeArray(grids, 'terrain', N, Float32Array), ground = takeArray(grids, 'ground', N, Float32Array);
  const TG = vgrid(terrain), GG = vgrid(ground), cls = data.ROAD_CLASSES;

  // ---------- 1. coast mask and signed distance to the shore (positive on land) ----------
  const shapes = coastShapes(data);
  const land = new Uint8Array(N);
  for (const s of shapes) fillPoly(vgrid(land), s.pts, 1);
  // per vertex: the nearest shore's kind in the low 2 bits, its dune height (in half metres) above them
  const sdf = new Float32Array(N), shoreAt = new Uint8Array(N);
  // far from the shore an 8 m field is plenty (it only shapes the sea bed); near it, exact distances
  const far = coarseField(land, vw, vh, COARSE), fw = (vw - 1) / COARSE + 1, fh = (vh - 1) / COARSE + 1;
  // Only beaches and cliffs have a profile that needs the exact distance; a seawall stands straight, so
  // the 8 m field is enough beside it.
  const near2 = new Float32Array(N).fill(Infinity), span = [0, 0];
  for (const e of shoreEdges(shapes)) {
    if ((e.code & 3) === SEAWALL) continue;
    const dx = e.bx - e.ax, dz = e.bz - e.az, L2 = dx * dx + dz * dz || 1, lim = NEAR * NEAR;
    const j0 = Math.max(0, Math.ceil((Math.min(e.az, e.bz) - NEAR) / STEP)), j1 = Math.min(vh - 1, Math.floor((Math.max(e.az, e.bz) + NEAR) / STEP));
    for (let j = j0; j <= j1; j++) {
      if (!rowSpan(e.ax, e.az, e.bx, e.bz, NEAR, j * STEP, span)) continue;
      const z = j * STEP - e.az, row = j * vw, i1 = Math.min(vw - 1, Math.floor(span[1] / STEP));
      for (let i = Math.max(0, Math.ceil(span[0] / STEP)); i <= i1; i++) {
        const x = i * STEP - e.ax;
        let t = (x * dx + z * dz) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = x - dx * t, ez = z - dz * t, d2 = ex * ex + ez * ez, v = row + i;
        if (d2 < near2[v] && d2 < lim) { near2[v] = d2; shoreAt[v] = e.code; }
      }
    }
  }
  const [I0, TI] = lerpTable(vw, COARSE), [J0, TJ] = lerpTable(vh, COARSE);
  for (let j = 0; j < vh; j++) {
    const tj = TJ[j], r0 = J0[j] * fw;
    for (let i = 0; i < vw; i++) {
      const v = j * vw + i;
      if (near2[v] < Infinity) { const d = Math.sqrt(near2[v]); sdf[v] = land[v] ? d : -d; continue; }
      const ti = TI[i], c = r0 + I0[i];
      const d = (far[c] * (1 - ti) + far[c + 1] * ti) * (1 - tj) + (far[c + fw] * (1 - ti) + far[c + fw + 1] * ti) * tj;
      sdf[v] = land[v] ? Math.max(d, 0) : Math.min(d, -0.01);       // the mask decides the sign
    }
  }
  timing.coast = now() - t0;

  // ---------- 2. natural TERRAIN ----------
  const t1 = now();
  terrain.fill(data.LAND_BASE);
  for (const f of data.TERRAIN) if (f.kind === 'dome') stampDome(TG, f, data.LAND_BASE); else if (f.kind === 'ridge') stampRidge(TG, f, data.LAND_BASE);
  for (const f of data.TERRAIN) if (f.kind === 'override') applyOverride(TG, f);
  for (const f of data.TERRAIN) if (f.kind === 'cap') applyCap(TG, f);
  applyFlatten(data, TG);
  shoreProfile(data, terrain, sdf, shoreAt);
  const wet = new Uint8Array(N);          // 0 land, 1 sea, 2 + i inside data.WATER[i]
  for (let v = 0; v < N; v++) if (!land[v]) wet[v] = 1;
  data.WATER.forEach((body, i) => carveWater(TG, body, wet, 2 + i));
  ground.set(terrain);
  const natural = terrain.slice();        // kept for the profiles, the carve's blend and cut/fill
  timing.natural = now() - t1;

  const NG = vgrid(natural), SG = vgrid(sdf);
  const heightAt = (x, z) => sampleGrid(TG, x, z);
  const groundAt = (x, z) => sampleGrid(GG, x, z);
  const naturalAt = (x, z) => sampleGrid(NG, x, z);
  const slopeAt = (x, z) => Math.hypot(heightAt(x + 1, z) - heightAt(x - 1, z), heightAt(x, z + 1) - heightAt(x, z - 1)) / 2;
  const normalAt = (x, z, out = { x: 0, y: 1, z: 0 }) => {
    const gx = (heightAt(x + 1, z) - heightAt(x - 1, z)) / 2, gz = (heightAt(x, z + 1) - heightAt(x, z - 1)) / 2, l = Math.hypot(gx, 1, gz);
    out.x = -gx / l; out.y = 1 / l; out.z = -gz / l;
    return out;
  };
  const vertexAt = (x, z) => clampI(Math.round(z / STEP), vh) * vw + clampI(Math.round(x / STEP), vw);
  // the shore at a point: d metres from it (negative at sea) and its kind ('beach' | 'cliff' | 'seawall')
  const coastAt = (x, z) => ({ d: sampleGrid(SG, x, z), kind: KIND_NAMES[shoreAt[vertexAt(x, z)] & 3] });
  // the inland water body a point is in, or null (the sea is not one: use coastAt)
  const waterAt = (x, z) => { const w = wet[vertexAt(x, z)]; return w >= 2 ? data.WATER[w - 2] : null; };

  // ---------- 3. road profiles ----------
  const profiles = new Map();             // road id → the road's own profile (see roadProfile)
  const roadMask = new Uint8Array(N);     // vertices under a road or its sidewalks: pads leave them alone

  function solveProfiles(net) {
    const ts = now(), px = net.px || 16;
    profiles.clear();
    for (const r of data.ROADS) profiles.set(r.id, roadProfile(r, cls[r.cls], data, naturalAt));
    // Junction heights: the mean of the incident edges (§4.2), except that the Loop is authored end to end
    // and never moves, and authored pins outvote terrain-following ends.
    const cons = new Map();
    for (const node of net.nodes) {
      const x = node.x / px, z = node.y / px, count = new Map();
      for (const id of node.edges) { const e = net.edges[id]; if (e) count.set(e.road, (count.get(e.road) || 0) + 1); }
      const votes = [];
      for (const [rid, n] of count) {
        const p = profiles.get(rid);
        if (!p) continue;
        const s = p.nearest(x, z, -1).s;
        votes.push({ p, s, n, y: p.at(p.design, s), pinned: p.isPinned(s), hwy: p.cls === 'hwy' });
      }
      if (!votes.length) continue;
      const hw = votes.filter(v => v.hwy), pin = votes.filter(v => v.pinned), pick = hw.length ? hw : pin.length ? pin : votes;
      let sum = 0, cnt = 0;
      for (const v of pick) { sum += v.y * v.n; cnt += v.n; }
      node.gy = sum / cnt;
      for (const v of votes) {
        if (!cons.has(v.p)) cons.set(v.p, []);
        cons.get(v.p).push({ s: v.s, y: node.gy });
      }
    }
    for (const p of profiles.values()) p.finish(cons.get(p) || []);
    // into the RoadNet: per-sample heights, banking on a 2 m step, deck spans in the edge's own units
    for (const e of net.edges) {
      writeEdge(e, profiles.get(e.road), px);
      const a = net.nodes[e.a], b = net.nodes[e.b];
      if (a?.gy !== undefined) e.gy[0] = a.gy;
      if (b?.gy !== undefined) e.gy[e.gy.length - 1] = b.gy;
    }
    timing.profiles = now() - ts;
    return profiles;
  }

  // ---------- 4. carve: the road surface into GROUND, the road bed into TERRAIN ----------
  // GROUND is the banked road surface out to the edge of the sidewalk and TERRAIN the bed 0.20 m under it
  // for one more metre (the nearest road sample wins, §3); past that TERRAIN eases back to natural over
  // the class blend width. Surfaces go first, on chords of the edge samples up to 8 m long where the road
  // runs straight (they stray under 5 cm from the curve); the blends follow on chords up to 12 m and never
  // cover another road's surface. On a bridge deck only GROUND changes, and only under the deck.
  function carve(net) {
    // best reuses the coast's scratch distances; soft holds the nearest blend
    const tc = now(), px = net.px || 16, best = near2.fill(Infinity), soft = new Float32Array(N).fill(Infinity), span = [0, 0];
    const geo = net.edges.map(e => {
      const g = edgeGeometry(e, px), c = cls[e.cls] || cls.street, prom = roadById(data, e.road)?.promenade?.w || 0;
      g.c = c; g.solid = c.halfW + c.walk + prom; g.deckW = c.halfW + prom; g.reach = g.solid + 1 + c.blend;
      return g;
    });
    for (const g of geo) {
      const { X, Z, gy, TB, deck, n } = g, r = g.solid + 1;
      for (let k = 0, k2 = 0; k + 1 < n; k = k2) {
        k2 = chordEnd(g, k, 8, 0.05);
        const ax = X[k], az = Z[k], dx = X[k2] - ax, dz = Z[k2] - az, L2 = dx * dx + dz * dz;
        if (L2 < 1e-9) continue;
        const L = Math.sqrt(L2), nx = -dz / L, nz = dx / L, y0 = gy[k], dy = gy[k2] - y0, b0 = TB[k], db = TB[k2] - b0;
        const j0 = Math.max(0, Math.ceil((Math.min(az, az + dz) - r) / STEP)), j1 = Math.min(vh - 1, Math.floor((Math.max(az, az + dz) + r) / STEP));
        for (let j = j0; j <= j1; j++) {
          if (!rowSpan(ax, az, ax + dx, az + dz, r, j * STEP, span)) continue;
          const pz = j * STEP - az, row = j * vw, i1 = Math.min(vw - 1, Math.floor(span[1] / STEP));
          for (let i = Math.max(0, Math.ceil(span[0] / STEP)); i <= i1; i++) {
            const qx = i * STEP - ax;
            let t = (qx * dx + pz * dz) / L2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = qx - dx * t, ez = pz - dz * t, v = row + i, d = Math.sqrt(ex * ex + ez * ez);
            if (d > r || d >= best[v]) continue;
            best[v] = d;
            const y = y0 + dy * t - (ex * nx + ez * nz) * (b0 + db * t);     // bank > 0 lowers the right side
            if (t < 0.5 ? deck[k] : deck[k2]) {
              const on = d <= g.deckW;
              ground[v] = on ? y : natural[v]; terrain[v] = natural[v]; roadMask[v] = on ? 1 : 0;
            } else {
              terrain[v] = y - BED; ground[v] = d <= g.solid ? y : y - BED; roadMask[v] = d <= g.solid ? 1 : 0;
            }
          }
        }
      }
    }
    for (const g of geo) {
      const { X, Z, gy, TB, deck, n, c } = g, r = g.reach, inner = g.solid + 1;
      for (let k = 0, k2 = 0; k + 1 < n; k = k2) {
        k2 = chordEnd(g, k, 12, 0.2);
        if (deck[k] && deck[k2]) continue;
        const ax = X[k], az = Z[k], dx = X[k2] - ax, dz = Z[k2] - az, L2 = dx * dx + dz * dz;
        if (L2 < 1e-9) continue;
        const L = Math.sqrt(L2), nx = -dz / L, nz = dx / L, y0 = gy[k], dy = gy[k2] - y0, b0 = TB[k], db = TB[k2] - b0;
        // Beside a deck end the fill stops at the shore: its blend's round end otherwise raised horns of sea bed
        // out of the water either side of the abutment, across the line the seawall or the beach runs on.
        const end = Math.min(g.deckD[k], g.deckD[k2]) < DECK_END;
        const j0 = Math.max(0, Math.ceil((Math.min(az, az + dz) - r) / STEP)), j1 = Math.min(vh - 1, Math.floor((Math.max(az, az + dz) + r) / STEP));
        for (let j = j0; j <= j1; j++) {
          if (!rowSpan(ax, az, ax + dx, az + dz, r, j * STEP, span)) continue;
          const pz = j * STEP - az, row = j * vw, i1 = Math.min(vw - 1, Math.floor(span[1] / STEP));
          for (let i = Math.max(0, Math.ceil(span[0] / STEP)); i <= i1; i++) {
            const v = row + i;
            if (best[v] < Infinity) continue;                 // a road surface or bed
            const qx = i * STEP - ax;
            let t = (qx * dx + pz * dz) / L2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = qx - dx * t, ez = pz - dz * t, d = Math.sqrt(ex * ex + ez * ez);
            if (d > r || d >= soft[v]) continue;
            soft[v] = d;
            const y = y0 + dy * t - (ex * nx + ez * nz) * (b0 + db * t), nat = natural[v];
            terrain[v] = ground[v] = end && nat < data.SEA_LEVEL ? nat : lerp(y - BED, nat, smooth01((d - inner) / c.blend));
          }
        }
      }
    }
    for (const jp of data.ACTIVITIES?.jumps || []) stampJump(jp);
    timing.carve = now() - tc;
  }

  // A jump: a wedge rising h over run metres to its lip at (x,z), then dropping straight back to the
  // road. It heads along the road's point order there.
  function stampJump(jp) {
    const p = profiles.get(jp.road);
    if (!p) return;
    const s = p.nearest(jp.x, jp.z, -1).s, [tx, tz] = p.tangent(s), w = cls[p.cls].halfW + 1;
    const r = jp.run + w;
    for (let j = Math.max(0, Math.ceil((jp.z - r) / STEP)); j <= Math.min(vh - 1, Math.floor((jp.z + r) / STEP)); j++)
      for (let i = Math.max(0, Math.ceil((jp.x - r) / STEP)); i <= Math.min(vw - 1, Math.floor((jp.x + r) / STEP)); i++) {
        const dx = i * STEP - jp.x, dz = j * STEP - jp.z, along = dx * tx + dz * tz, across = -dx * tz + dz * tx;
        if (along > 0 || along < -jp.run || Math.abs(across) > w) continue;
        const v = j * vw + i, bump = jp.h * (1 + along / jp.run);
        ground[v] += bump; terrain[v] += bump;
      }
  }

  // ---------- 5. pads: flat ground under a prefab or a lot ----------
  // Inside poly ([[x,z],...] m), GROUND and TERRAIN become y (default: the highest TERRAIN under its
  // corners), easing back to what was there over blend metres outside. Roads and sidewalks are never
  // touched. Returns the y used.
  function pad(poly, y, blend = 6) {
    if (y === undefined || y === null) { y = -Infinity; for (const [x, z] of poly) y = Math.max(y, heightAt(x, z)); }
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const ja = Math.max(0, Math.ceil((z0 - blend) / STEP)), jb = Math.min(vh - 1, Math.floor((z1 + blend) / STEP));
    const ia = Math.max(0, Math.ceil((x0 - blend) / STEP)), ib = Math.min(vw - 1, Math.floor((x1 + blend) / STEP));
    // ground already flat at y all round (most lots in the flattened districts) has nothing to change
    let flat = true;
    for (let j = ja; j <= jb && flat; j++) for (let v = j * vw + ia, e = j * vw + ib; v <= e; v++) {
      if (!roadMask[v] && (Math.abs(terrain[v] - y) > 1e-4 || Math.abs(ground[v] - y) > 1e-4)) { flat = false; break; }
    }
    if (flat) return y;
    for (let j = ja; j <= jb; j++)
      for (let i = ia; i <= ib; i++) {
        const v = j * vw + i;
        if (roadMask[v]) continue;
        const x = i * STEP, z = j * STEP;
        const w = insidePoly(poly, x, z) ? 1 : 1 - smooth01(distToPoly(poly, x, z) / blend);
        if (w <= 0) continue;
        terrain[v] = lerp(terrain[v], y, w);
        ground[v] = lerp(ground[v], y, w);
      }
    return y;
  }

  // ---------- 6. sea depth ----------
  // 1024×896 cells at 2 m: clamp((water level − TERRAIN)/20, 0, 1)·255 under water, 0 on land. The sea
  // uses SEA_LEVEL; the lagoon and the ponds use their own level.
  function seaDepth() {
    const cw = vw - 1, ch = vh - 1, out = takeArray(grids, 'seaDepth', cw * ch, Uint8Array);
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
      const v = j * vw + i, c = j * cw + i;
      let level = null;
      if (sdf[v] + sdf[v + 1] + sdf[v + vw] + sdf[v + vw + 1] < 0) level = data.SEA_LEVEL;
      else { const w = Math.max(wet[v], wet[v + 1], wet[v + vw], wet[v + vw + 1]); if (w >= 2) level = data.WATER[w - 2].level; }
      if (level === null) { out[c] = 0; continue; }
      const h = (terrain[v] + terrain[v + 1] + terrain[v + vw] + terrain[v + vw + 1]) / 4;
      out[c] = Math.round(Math.min(1, Math.max(0, (level - h) / 20)) * 255);
    }
    return out;
  }

  timing.build = now() - t0;
  return {
    heightAt, groundAt, naturalAt, slopeAt, normalAt, coastAt, waterAt,
    solveProfiles, carve, pad, seaDepth,
    terrain, ground, natural, land, sdf, wet, roadMask, profiles, timing,
    w: vw, h: vh, step: STEP,
  };
}

// ---------- coast ----------

const SEAWALL = 0, BEACH = 1, CLIFF = 2;
const KIND_CODE = { seawall: SEAWALL, beach: BEACH, cliff: CLIFF };
const KIND_NAMES = ['seawall', 'beach', 'cliff'];

// Every land shape as a polygon, with a shore kind and dune height per edge (edge i runs pts[i]→pts[i+1]).
function coastShapes(data) {
  const out = [];
  for (const [coast, list] of Object.entries(data.COAST)) for (const sh of list) {
    const pts = shapePoly(sh), n = pts.length;
    out.push({ coast, pts, kind: new Uint8Array(n), dune: new Float32Array(n) });
  }
  for (const run of data.COAST_KINDS) for (const s of out) {
    if (s.coast !== run.coast) continue;
    const n = s.pts.length, code = KIND_CODE[run.kind];
    if (!run.from) { s.kind.fill(code); s.dune.fill(run.dune || 0); continue; }
    const a = vertexIndex(s.pts, run.from), b = vertexIndex(s.pts, run.to);
    if (a < 0 || b < 0) throw new Error(`COAST_KINDS: ${run.coast} has no vertex at ${a < 0 ? run.from : run.to}`);
    for (let i = a; i !== b; i = (i + 1) % n) { s.kind[i] = code; s.dune[i] = run.dune || 0; }
  }
  return out;
}

function shapePoly(sh) {
  if (sh.poly) return sh.poly;
  if (sh.rect) { const [x0, z0, x1, z1] = sh.rect; return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]; }
  const [cx, cz] = sh.circle || sh.ellipse, rx = sh.r ?? sh.rx, rz = sh.r ?? sh.rz;
  const n = Math.max(24, Math.ceil(2 * Math.PI * Math.max(rx, rz) / 6));    // ~6 m edges (0.15 m off a 30 m circle)
  return Array.from({ length: n }, (_, i) => [cx + rx * Math.cos(2 * Math.PI * i / n), cz + rz * Math.sin(2 * Math.PI * i / n)]);
}

function vertexIndex(pts, [x, z]) { return pts.findIndex(p => Math.abs(p[0] - x) < 0.01 && Math.abs(p[1] - z) < 0.01); }

// The real shore: every shape edge except those inside another land shape (where two shapes overlap).
function shoreEdges(shapes) {
  const out = [];
  for (const s of shapes) {
    s.box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, z] of s.pts) { s.box[0] = Math.min(s.box[0], x); s.box[1] = Math.min(s.box[1], z); s.box[2] = Math.max(s.box[2], x); s.box[3] = Math.max(s.box[3], z); }
  }
  const inside = (o, x, z) => x >= o.box[0] && x <= o.box[2] && z >= o.box[1] && z <= o.box[3] && insidePoly(o.pts, x, z);
  for (const s of shapes) {
    const n = s.pts.length;
    for (let i = 0; i < n; i++) {
      const a = s.pts[i], b = s.pts[(i + 1) % n], mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      if (shapes.some(o => o !== s && inside(o, mx, mz))) continue;
      out.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], code: s.kind[i] | Math.min(63, Math.round(s.dune[i] * 2)) << 2 });
    }
  }
  return out;
}

// Beaches fall to the waterline, cliffs drop away, seawalls stand straight; offshore is the sea bed.
function shoreProfile(data, terrain, sdf, shoreAt) {
  const SH = data.SHORE, F = data.SEA_FLOOR, last = F[F.length - 1], reach = Math.ceil(last[0]) + 1;
  const floor = new Float32Array(reach + 1);          // the sea bed by whole metre from the shore
  for (let m = 0; m <= reach; m++) {
    floor[m] = last[1];
    for (let q = 1; q < F.length; q++) if (m <= F[q][0]) { floor[m] = lerp(F[q - 1][1], F[q][1], Math.max(0, m - F[q - 1][0]) / (F[q][0] - F[q - 1][0])); break; }
  }
  for (let v = 0; v < terrain.length; v++) {
    const d = sdf[v], k = shoreAt[v] & 3, dune = (shoreAt[v] >> 2) * 0.5;
    if (d >= 0) {
      if (k === BEACH && d < SH.beachW) terrain[v] = lerp(SH.beachY, terrain[v], d / SH.beachW);
      else if (k === CLIFF && d < SH.cliffW) terrain[v] = lerp(SH.cliffY, terrain[v], d / SH.cliffW);
      if (dune > 0) { const q = (d - SH.duneIn) / SH.duneW; if (q > -1 && q < 1) terrain[v] += dune * (1 - q * q); }
      continue;
    }
    const s = -d, m = s < reach ? Math.floor(s) : reach - 1, bed = s < reach ? lerp(floor[m], floor[m + 1], s - m) : last[1];
    if (k === BEACH) terrain[v] = lerp(SH.beachY, bed, Math.min(1, s / 10));
    else if (k === CLIFF) terrain[v] = Math.min(bed, lerp(SH.cliffY, bed, Math.min(1, s / NEAR)));
    else terrain[v] = bed;
  }
}

// ---------- natural ground ----------

// Features are heights above base, combined by max (§3).
function stampDome(G, f, base) {
  const r = typeof f.r === 'number' ? { w: f.r, e: f.r, n: f.r, s: f.r } : f.r, [cx, cz] = f.c, d = G.data, c = G.cell;
  const i0 = Math.max(0, Math.ceil((cx - r.w) / c)), i1 = Math.min(G.w - 1, Math.floor((cx + r.e) / c));
  const j0 = Math.max(0, Math.ceil((cz - r.n) / c)), j1 = Math.min(G.h - 1, Math.floor((cz + r.s) / c));
  for (let j = j0; j <= j1; j++) {
    const z = j * c, qz = (z - cz) / (z < cz ? r.n : r.s), qz2 = qz * qz;
    for (let i = i0; i <= i1; i++) {
      const x = i * c, qx = (x - cx) / (x < cx ? r.w : r.e), q = qx * qx + qz2;
      if (q >= 1) continue;
      const h = base + f.h * Math.pow(1 - q, f.p), v = j * G.w + i;
      if (h > d[v]) d[v] = h;
    }
  }
}

function stampRidge(G, f, base) {
  const d = G.data, c = G.cell, hw2 = f.hw * f.hw;
  for (let k = 0; k + 1 < f.pts.length; k++) {
    const [ax, az, ah] = f.pts[k], [bx, bz, bh] = f.pts[k + 1], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx) - f.hw) / c)), i1 = Math.min(G.w - 1, Math.floor((Math.max(ax, bx) + f.hw) / c));
    const j0 = Math.max(0, Math.ceil((Math.min(az, bz) - f.hw) / c)), j1 = Math.min(G.h - 1, Math.floor((Math.max(az, bz) + f.hw) / c));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = i * c - ax, z = j * c - az;
      let t = (x * dx + z * dz) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = x - dx * t, ez = z - dz * t, e2 = ex * ex + ez * ez;
      if (e2 >= hw2) continue;
      const h = base + (ah + (bh - ah) * t) * (1 - e2 / hw2), v = j * G.w + i;
      if (h > d[v]) d[v] = h;
    }
  }
}

// The plane y + gz·(z − z0) inside the rectangle, easing in over the first blend metres from its edge
// (like the flats, the blend sits inside the shape, so Heights Drive along its north edge keeps its ridge).
function applyOverride(G, f) {
  const [x0, z0, x1, z1] = f.rect, d = G.data, c = G.cell;
  for (let j = Math.max(0, Math.ceil(z0 / c)); j <= Math.min(G.h - 1, Math.floor(z1 / c)); j++)
    for (let i = Math.max(0, Math.ceil(x0 / c)); i <= Math.min(G.w - 1, Math.floor(x1 / c)); i++) {
      const x = i * c, z = j * c, inside = Math.min(x - x0, x1 - x, z - z0, z1 - z), w = smooth01(inside / f.blend), v = j * G.w + i;
      if (w > 0) d[v] = lerp(d[v], f.y + f.gz * (z - f.z0), w);
    }
}

// A cap holds the ground under a profile along an axis, so a view can see over it (the villa terrace's vista
// down on K-Town, §4.7 SL3). The axis runs from `from` heading a; profile [[u, y], ...] gives the most height
// y at u metres along it, linear between points. The cap is w0 + u·tan(half) wide each side of the axis and
// eases out over the next blend + u·tan(spread) metres, and over the last endBlend metres of the profile, where
// the profile has come down to the natural ground. It only ever lowers the ground.
function applyCap(G, f) {
  const d = G.data, c = G.cell, [ox, oz] = f.from, ux = Math.cos(f.a), uz = Math.sin(f.a), P = f.profile;
  const u0 = P[0][0], u1 = P[P.length - 1][0], th = Math.tan(f.half), ts = Math.tan(f.spread), endB = f.endBlend || 0;
  const reach = f.w0 + u1 * th + f.blend + u1 * ts;
  // the box round the fan: its axis ends, pushed out by the widest reach
  const xs = [ox + ux * u0, ox + ux * u1], zs = [oz + uz * u0, oz + uz * u1];
  const i0 = Math.max(0, Math.floor((Math.min(...xs) - reach) / c)), i1 = Math.min(G.w - 1, Math.ceil((Math.max(...xs) + reach) / c));
  const j0 = Math.max(0, Math.floor((Math.min(...zs) - reach) / c)), j1 = Math.min(G.h - 1, Math.ceil((Math.max(...zs) + reach) / c));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const px = i * c - ox, pz = j * c - oz, u = px * ux + pz * uz;
    if (u <= u0 || u >= u1) continue;
    const v = Math.abs(-px * uz + pz * ux), core = f.w0 + u * th, soft = f.blend + u * ts;
    if (v >= core + soft) continue;
    let k = 1;
    while (k < P.length - 1 && P[k][0] < u) k++;
    const y = lerp(P[k - 1][1], P[k][1], (u - P[k - 1][0]) / (P[k][0] - P[k - 1][0]));
    const w = (1 - smooth01((v - core) / soft)) * (endB > 0 ? smooth01((u1 - u) / endB) : 1), q = j * G.w + i;
    if (d[q] > y) d[q] -= w * (d[q] - y);
  }
}

// The flat districts. They are treated as one union so two flat districts that touch blend into each
// other instead of letting the natural ground show along their shared edge: the weight eases in over
// each district's blend width from the edge of the union, and the target height is the district's
// height softened 20 m across shared edges. Weights and targets are worked out on the 8 m grid (the
// blends are 20-40 m wide) and interpolated to every vertex as they are applied.
function applyFlatten(data, G) {
  const k = COARSE, cw = (G.w - 1) / k + 1, ch = (G.h - 1) / k + 1, cell = STEP * k, cn = cw * ch;
  const list = data.FLATTEN.map(f => ({ ...f, pts: f.region ? data.REGIONS.find(r => r.id === f.region).pts : data.COAST[f.coast][0].poly }));
  const id = new Int8Array(cn).fill(-1);
  list.forEach((f, i) => fillPoly({ w: cw, h: ch, cell, o: 0, data: id }, f.pts, i));
  const inU = new Uint8Array(cn);
  for (let c = 0; c < cn; c++) inU[c] = id[c] >= 0 ? 1 : 0;
  const dIn = distanceTransform(inU, { w: cw, h: ch, cell, invert: true });
  const R = Math.round(20 / cell), Y = new Float32Array(cn), M = new Float32Array(cn), Wt = new Float32Array(cn);
  for (let c = 0; c < cn; c++) if (inU[c]) { Y[c] = list[id[c]].y; M[c] = 1; Wt[c] = smooth01((dIn[c] - cell / 2) / list[id[c]].blend); }
  boxBlur(Y, cw, ch, R); boxBlur(M, cw, ch, R);
  for (let c = 0; c < cn; c++) Y[c] = M[c] > 0 ? Y[c] / M[c] : 0;
  const d = G.data, w = G.w, [I0, TI] = lerpTable(w, k), [J0, TJ] = lerpTable(G.h, k);
  for (let j = 0; j < G.h; j++) {
    const tj = TJ[j], r0 = J0[j] * cw;
    for (let i = 0; i < w; i++) {
      const ti = TI[i], c = r0 + I0[i];
      const a = Wt[c], b = Wt[c + 1], e = Wt[c + cw], f = Wt[c + cw + 1];
      if (a === 0 && b === 0 && e === 0 && f === 0) continue;
      const wt = (a * (1 - ti) + b * ti) * (1 - tj) + (e * (1 - ti) + f * ti) * tj;
      const yt = (Y[c] * (1 - ti) + Y[c + 1] * ti) * (1 - tj) + (Y[c + cw] * (1 - ti) + Y[c + cw + 1] * ti) * tj;
      d[j * w + i] = lerp(d[j * w + i], yt, wt);
    }
  }
}

// Signed distance (positive inside the mask) on every k-th vertex, measured to the boundary halfway
// between samples.
function coarseField(mask, w, h, k) {
  const cw = (w - 1) / k + 1, ch = (h - 1) / k + 1, cell = STEP * k, cm = new Uint8Array(cw * ch);
  for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) cm[j * cw + i] = mask[j * k * w + i * k];
  const toOut = distanceTransform(cm, { w: cw, h: ch, cell, invert: true }), toIn = distanceTransform(cm, { w: cw, h: ch, cell });
  const out = new Float32Array(cw * ch);
  for (let c = 0; c < out.length; c++) out[c] = cm[c] ? toOut[c] - cell / 2 : -(toIn[c] - cell / 2);
  return out;
}

// For a field on every k-th vertex: the coarse cell index and the fraction across it for each of n fine
// vertices along one axis (the last vertex sits at the far end of the last cell).
function lerpTable(n, k) {
  const m = (n - 1) / k, cell = new Int32Array(n), frac = new Float32Array(n);
  for (let i = 0; i < n; i++) { const c = Math.min(Math.floor(i / k), m - 1); cell[i] = c; frac[i] = i / k - c; }
  return [cell, frac];
}

// Separable box sum over ±r in place (samples past the edges count as missing).
function boxBlur(a, w, h, r) {
  const tmp = new Float32Array(Math.max(w, h));
  for (let j = 0; j < h; j++) {
    let s = 0;
    for (let i = 0; i <= Math.min(r, w - 1); i++) s += a[j * w + i];
    for (let i = 0; i < w; i++) {
      tmp[i] = s;
      if (i + r + 1 < w) s += a[j * w + i + r + 1];
      if (i - r >= 0) s -= a[j * w + i - r];
    }
    for (let i = 0; i < w; i++) a[j * w + i] = tmp[i];
  }
  for (let i = 0; i < w; i++) {
    let s = 0;
    for (let j = 0; j <= Math.min(r, h - 1); j++) s += a[j * w + i];
    for (let j = 0; j < h; j++) {
      tmp[j] = s;
      if (j + r + 1 < h) s += a[(j + r + 1) * w + i];
      if (j - r >= 0) s -= a[(j - r) * w + i];
    }
    for (let j = 0; j < h; j++) a[j * w + i] = tmp[j];
  }
}

// An inland water body: the bed inside its shapes, easing up to the bank over a few metres inside the
// edge so the waterline sits on the edge (6 m for deep water, 4 m for the shallow ponds).
function carveWater(G, body, wet, code) {
  const bank = body.surf === 'WATER' ? 6 : 4, polys = [];
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const sh of body.shapes) {
    // a channel is a thick line: its outline as a polygon
    const pts = sh.line ? capsulePoly(sh.line, sh.w / 2) : shapePoly(sh);
    polys.push(pts);
    for (const [x, z] of pts) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  }
  // a local window: rasterise the body, then measure how deep inside it each vertex is
  const i0 = Math.max(0, Math.floor(x0 / STEP) - 2), j0 = Math.max(0, Math.floor(z0 / STEP) - 2);
  const i1 = Math.min(G.w - 1, Math.ceil(x1 / STEP) + 2), j1 = Math.min(G.h - 1, Math.ceil(z1 / STEP) + 2);
  const lw = i1 - i0 + 1, lh = j1 - j0 + 1, mask = { w: lw, h: lh, cell: STEP, o: 0, data: new Uint8Array(lw * lh) };
  for (const p of polys) fillPoly(mask, p.map(([x, z]) => [x - i0 * STEP, z - j0 * STEP]), 1);
  const dIn = distanceTransform(mask, { invert: true });
  for (let j = 0; j < lh; j++) for (let i = 0; i < lw; i++) {
    const m = j * lw + i;
    if (!mask.data[m]) continue;
    const v = (j + j0) * G.w + (i + i0), t = smooth01((dIn[m] - STEP / 2) / bank);
    G.data[v] = lerp(Math.max(G.data[v], body.level), body.bed, t);
    wet[v] = code;
  }
}

// The outline of a two-point thick line with round ends.
function capsulePoly([[ax, az], [bx, bz]], r) {
  const a = Math.atan2(bz - az, bx - ax), out = [];
  for (let k = 0; k <= 8; k++) { const t = a - Math.PI / 2 + Math.PI * k / 8; out.push([bx + r * Math.cos(t), bz + r * Math.sin(t)]); }
  for (let k = 0; k <= 8; k++) { const t = a + Math.PI / 2 + Math.PI * k / 8; out.push([ax + r * Math.cos(t), az + r * Math.sin(t)]); }
  return out;
}

// ---------- road profiles ----------
// A road's own profile along its curve, every ~1 m (the §4.1 curve from spline.js, evened out), with the
// control parameter u (segment + t within it) that the y pins interpolate over.
//   design  authored pins where the road has them (smoothed over PIN_WIN, which only rounds the kinks
//           at control points, so the authored grades of §4.3 survive), otherwise the natural ground or,
//           over water, the bridge deck, smoothed over FREE_WIN.
//   y       design pulled to every junction height by triangular corrections, then held to the class
//           grade between fixed heights (pins and junctions): each free stretch becomes the average of
//           its highest and lowest grade-limited profiles, so humps are half cut and half filled. Where
//           two fixed heights are further apart than the grade allows (a spec conflict), the stretch
//           between them gets the grade it needs, an even ramp instead of a step.
function roadProfile(road, c, data, naturalAt) {
  const closed = !!road.closed, cv = evenCurve(sampleCurve(road.pts, { closed, step: 1, chord: c.chord }), closed);
  const { n, ds } = cv, nCtrl = road.pts.length;
  const pins = road.y ? road.y.slice().sort((a, b) => a[0] - b[0]) : null;
  const nat = new Float32Array(n), pinned = new Uint8Array(n), raw = new Float32Array(n), deck = new Uint8Array(n);
  for (let i = 0; i < n; i++) nat[i] = naturalAt(cv.x[i], cv.z[i]);
  // bridge spans: stations over water (§4.5), plus the abutments
  const rule = data.BRIDGE_RULE || { below: 0.3, abutment: 6 }, ab = Math.round(rule.abutment / ds);
  for (let i = 0; i < n; i++) if (nat[i] < data.SEA_LEVEL + rule.below) for (let k = -ab; k <= ab; k++) { const q = idx(i + k, n, closed); if (q >= 0) deck[q] = 1; }
  const bridge = (data.BRIDGES || []).find(b => b.road === road.id && b.deck !== undefined), deckY = bridge ? bridge.deck : 3.5;
  for (let i = 0; i < n; i++) {
    const y = pins ? pinAt(pins, cv.u[i], nCtrl, closed) : null;
    if (y !== null) { pinned[i] = 1; raw[i] = y; } else raw[i] = deck[i] ? Math.max(deckY, nat[i]) : nat[i];
  }
  const design = new Float32Array(n), sp = boxAlong(raw, Math.round(PIN_WIN / ds), closed), sf = boxAlong(raw, Math.round(FREE_WIN / ds), closed);
  for (let i = 0; i < n; i++) design[i] = pinned[i] ? sp[i] : sf[i];
  const grade = c.grade, bankMax = (c.bank || 0) * Math.PI / 180;

  const p = {
    id: road.id, cls: road.cls, closed, curve: cv, n, ds, len: cv.len, nat, pinned, deck, design,
    y: design.slice(), bank: new Float32Array(n),
    at: (arr, s) => sampleAlong(arr, s / ds, n, closed),
    isPinned(s) { const i = idx(Math.round(s / ds), n, closed); return i >= 0 && pinned[i] === 1; },
    nearest: (x, z, hint) => nearestStation(p, x, z, hint),
    tangent(s) {
      const i = Math.round(s / ds), a = idx(i - 2, n, closed), b = idx(i + 2, n, closed);
      const i0 = a < 0 ? 0 : a, i1 = b < 0 ? n - 1 : b, dx = cv.x[i1] - cv.x[i0], dz = cv.z[i1] - cv.z[i0], l = Math.hypot(dx, dz) || 1;
      return [dx / l, dz / l];
    },
    // junction heights in; the final profile and the banking out
    finish(list) {
      const y = p.y, fixed = pinned.slice();
      list.sort((a, b) => a.s - b.s);
      if (road.cls !== 'hwy' && list.length) {
        // spread each correction far enough that it adds no more grade than the road has spare
        const spare = Math.max(0.01, 0.97 * grade - maxGrade(design, ds, closed));
        const corr = new Float32Array(n), m = list.length;
        list.forEach((k, q) => {
          const o = k.y - p.at(design, k.s), span = Math.max(KERNEL_MIN, Math.abs(o) / spare);
          const prev = q > 0 ? k.s - list[q - 1].s : closed && m > 1 ? k.s + cv.len - list[m - 1].s : Infinity;
          const next = q < m - 1 ? list[q + 1].s - k.s : closed && m > 1 ? list[0].s + cv.len - k.s : Infinity;
          const Lb = Math.min(span, prev), La = Math.min(span, next);
          for (let i = 0; i < n; i++) {
            let d = i * ds - k.s;
            if (closed) { if (d > cv.len / 2) d -= cv.len; else if (d < -cv.len / 2) d += cv.len; }
            const L = d < 0 ? Lb : La, w = L > 0 ? 1 - Math.abs(d) / L : 0;
            if (w > 0) corr[i] += o * w;
          }
        });
        for (let i = 0; i < n; i++) y[i] = design[i] + corr[i];
        for (const k of list) { const i = idx(Math.round(k.s / ds), n, closed); if (i >= 0) { y[i] = k.y; fixed[i] = 1; } }
      }
      holdGrade(y, fixed, grade * ds, closed);
      bankProfile(p, bankMax, road.speed || c.speed, list);
    },
  };
  return p;
}

// spline.js keeps a dense point each time the arc reaches 1 m, so its spacing wobbles between 1 and
// 1.25 m; the profile maths wants an even step. Closed curves end up with n samples over [0, len).
function evenCurve(c, closed) {
  const len = c.len, n = closed ? Math.max(3, Math.round(len)) : Math.max(2, Math.round(len) + 1), ds = closed ? len / n : len / (n - 1);
  const x = new Float64Array(n), z = new Float64Array(n), u = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = i * ds;
    while (j < c.n - 2 && c.s[j + 1] < s) j++;
    const t = Math.min(1, Math.max(0, (s - c.s[j]) / ((c.s[j + 1] - c.s[j]) || 1)));
    x[i] = c.x[j] + (c.x[j + 1] - c.x[j]) * t; z[i] = c.z[j] + (c.z[j + 1] - c.z[j]) * t; u[i] = c.u[j] + (c.u[j + 1] - c.u[j]) * t;
  }
  return { x, z, u, n, ds, len, closed };
}

// The authored height at control parameter u: linear between the pins around it, or null outside them
// (a closed road wraps from its last pin to its first).
function pinAt(pins, u, nCtrl, closed) {
  if (u >= pins[0][0] - 1e-9 && u <= pins[pins.length - 1][0] + 1e-9) {
    let lo = 0, hi = pins.length - 1;          // the pin pair around u
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pins[m][0] <= u) lo = m; else hi = m; }
    const [ua, ya] = pins[lo], [ub, yb] = pins[hi];
    return ub > ua ? lerp(ya, yb, Math.min(1, Math.max(0, (u - ua) / (ub - ua)))) : ya;
  }
  if (closed && pins.length) {
    const [ua, ya] = pins[pins.length - 1], ub = pins[0][0] + nCtrl, yb = pins[0][1], uu = u < pins[0][0] ? u + nCtrl : u;
    if (uu >= ua && uu <= ub) return ub > ua ? lerp(ya, yb, (uu - ua) / (ub - ua)) : ya;
  }
  return null;
}

// Centred moving average over ±win/2 samples (closed roads wrap, open ends shrink the window).
function boxAlong(a, win, closed) {
  const n = a.length, half = Math.max(0, Math.floor(win / 2)), out = new Float32Array(n);
  if (!half) { out.set(a); return out; }
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + a[i];
  const sum = (lo, hi) => pre[hi + 1] - pre[lo];
  for (let i = 0; i < n; i++) {
    if (closed) {
      const h = Math.min(half, Math.floor((n - 1) / 2)), lo = i - h, hi = i + h;
      const s = lo < 0 ? sum(n + lo, n - 1) + sum(0, hi) : hi >= n ? sum(lo, n - 1) + sum(0, hi - n) : sum(lo, hi);
      out[i] = s / (2 * h + 1);
    } else {
      const lo = Math.max(0, i - half), hi = Math.min(n - 1, i + half);
      out[i] = sum(lo, hi) / (hi - lo + 1);
    }
  }
  return out;
}

// The grade limit (§4.2; g metres of rise per sample) between fixed samples. Each free stretch is first
// held inside the cones its fixed ends allow, then replaced by the average of its highest and lowest
// g-limited profiles (cutting the humps and filling the dips by half each).
function holdGrade(y, fixed, g, closed) {
  const n = y.length, fx = [];
  for (let i = 0; i < n; i++) if (fixed[i]) fx.push(i);
  const run = (a, b, ya, yb) => {             // samples a..b (indices past n wrap on a closed road)
    const L = b - a + 1, v = new Float64Array(L);
    for (let q = 0; q < L; q++) v[q] = y[(a + q) % n];
    relax(v, ya, yb, g);
    for (let q = 0; q < L; q++) y[(a + q) % n] = v[q];
  };
  if (!fx.length) { run(0, n - 1, null, null); return; }
  if (!closed) {
    if (fx[0] > 0) run(0, fx[0], null, y[fx[0]]);
    for (let m = 0; m + 1 < fx.length; m++) if (fx[m + 1] - fx[m] > 1) run(fx[m], fx[m + 1], y[fx[m]], y[fx[m + 1]]);
    if (fx[fx.length - 1] < n - 1) run(fx[fx.length - 1], n - 1, y[fx[fx.length - 1]], null);
    return;
  }
  for (let m = 0; m < fx.length; m++) {
    const a = fx[m], b = m + 1 < fx.length ? fx[m + 1] : fx[0] + n;
    if (b - a > 1) run(a, b, y[a], y[b % n]);
  }
}

function relax(v, ya, yb, g) {
  const L = v.length;
  if (ya !== null && yb !== null) g = Math.max(g, Math.abs(yb - ya) / (L - 1) * 1.0001);
  for (let q = 0; q < L; q++) {
    let lo = -Infinity, hi = Infinity;
    if (ya !== null) { lo = Math.max(lo, ya - g * q); hi = Math.min(hi, ya + g * q); }
    if (yb !== null) { lo = Math.max(lo, yb - g * (L - 1 - q)); hi = Math.min(hi, yb + g * (L - 1 - q)); }
    v[q] = Math.min(Math.max(v[q], lo), hi);
  }
  const U = Float64Array.from(v), D = Float64Array.from(v);
  for (let q = 1; q < L; q++) { U[q] = Math.min(U[q], U[q - 1] + g); D[q] = Math.max(D[q], D[q - 1] - g); }
  for (let q = L - 2; q >= 0; q--) { U[q] = Math.min(U[q], U[q + 1] + g); D[q] = Math.max(D[q], D[q + 1] - g); }
  for (let q = 0; q < L; q++) v[q] = (U[q] + D[q]) / 2;
  if (ya !== null) v[0] = ya;
  if (yb !== null) v[L - 1] = yb;
}

function maxGrade(y, ds, closed) {
  let g = 0;
  for (let i = 1; i < y.length; i++) g = Math.max(g, Math.abs(y[i] - y[i - 1]));
  if (closed) g = Math.max(g, Math.abs(y[0] - y[y.length - 1]));
  return g / ds;
}

// Bank = clamp(k·v²/g·0.5, ±bankMax) (§4.2), positive when the road leans down to its right (the inside
// of a right-hand bend), smoothed over 20 m. It fades to flat around every junction so side roads meet
// a level crossfall.
function bankProfile(p, bankMax, v, junctions) {
  const { curve: cv, n, ds, closed, bank } = p;
  if (!bankMax) return;
  const h = Math.max(1, Math.round(5 / ds));
  for (let i = 0; i < n; i++) {
    const a = idx(i - h, n, closed), b = idx(i + h, n, closed);
    if (a < 0 || b < 0) continue;
    const t1x = cv.x[i] - cv.x[a], t1z = cv.z[i] - cv.z[a], t2x = cv.x[b] - cv.x[i], t2z = cv.z[b] - cv.z[i];
    const k = Math.atan2(t1x * t2z - t1z * t2x, t1x * t2x + t1z * t2z) / (h * ds);    // > 0 turning right
    bank[i] = Math.max(-bankMax, Math.min(bankMax, k * v * v / 9.81 * 0.5));
  }
  const sm = boxAlong(bank, Math.round(20 / ds), closed);
  for (const j of junctions) for (let i = 0; i < n; i++) {
    let d = Math.abs(i * ds - j.s);
    if (closed) d = Math.min(d, cv.len - d);
    if (d < BANK_CLEAR + 10) sm[i] *= smooth01((d - 10) / BANK_CLEAR);
  }
  bank.set(sm);
}

// ---------- writing the RoadNet ----------

// Heights (m) for every edge sample, bank (radians) every 2 m of the edge, and deck spans in the edge's
// own stations (px), all read off the road's profile at the station nearest each sample. Samples past
// the end of the road (a side road extended to its T) take the end height, which is the junction's.
function writeEdge(e, p, px) {
  const n = e.n ?? e.x.length;
  e.gy = new Float32Array(n);
  const S = new Float64Array(n), sAt = new Float64Array(n);
  for (let k = 1; k < n; k++) S[k] = S[k - 1] + Math.hypot(e.x[k] - e.x[k - 1], e.y[k] - e.y[k - 1]) / px;
  e.bank = new Float32Array(Math.floor(S[n - 1] / 2) + 1);
  e.deck = [];
  if (!p) return;
  let hint = -1;
  for (let k = 0; k < n; k++) {
    const hit = nearestStation(p, e.x[k] / px, e.y[k] / px, hint);
    hint = hit.i; sAt[k] = hit.s;
    e.gy[k] = p.at(p.y, hit.s);
  }
  for (let b = 0, k = 0; b < e.bank.length; b++) {
    const s = b * 2;
    while (k < n - 2 && S[k + 1] < s) k++;
    const t = Math.min(1, Math.max(0, (s - S[k]) / ((S[k + 1] - S[k]) || 1)));
    const s0 = sAt[k], s1 = sAt[Math.min(k + 1, n - 1)];
    // on a closed road the two stations may straddle the seam
    e.bank[b] = p.at(p.bank, p.closed && Math.abs(s1 - s0) > p.len / 2 ? s0 : lerp(s0, s1, t));
  }
  const scale = e.s ? e.s[n - 1] / (S[n - 1] || 1) : px;     // metres to the edge's own station units
  let open = -1;
  for (let q = 0; q < n; q++) {
    const on = p.deck[idx(Math.round(sAt[q] / p.ds), p.n, p.closed)] === 1;
    if (on && open < 0) open = q;
    if ((!on || q === n - 1) && open >= 0) { e.deck.push([S[open] * scale, S[on ? q : q - 1] * scale]); open = -1; }
  }
}

// Which edge samples lie on a bridge deck (e.deck spans are in the edge's own px stations).
function deckFlags(e, S, px) {
  const out = new Uint8Array(S.length);
  if (!e.deck?.length) return out;
  const scale = e.s ? e.s[S.length - 1] / (S[S.length - 1] || 1) : px;
  for (let k = 0; k < S.length; k++) {
    const s = S[k] * scale;
    for (const [a, b] of e.deck) if (s >= a - 1e-3 && s <= b + 1e-3) { out[k] = 1; break; }
  }
  return out;
}

// An edge in metres, ready to carve: positions, stations, heights, tan(bank) per sample and deck flags.
function edgeGeometry(e, px) {
  const n = e.n ?? e.x.length, X = new Float64Array(n), Z = new Float64Array(n), S = new Float64Array(n), TB = new Float64Array(n);
  for (let k = 0; k < n; k++) { X[k] = e.x[k] / px; Z[k] = e.y[k] / px; if (k) S[k] = S[k - 1] + Math.hypot(X[k] - X[k - 1], Z[k] - Z[k - 1]); }
  const nb = e.bank?.length || 0;
  for (let k = 0; k < n && nb; k++) {
    const f = Math.min(S[k] / 2, nb - 1), i = Math.floor(f), j = Math.min(i + 1, nb - 1);
    TB[k] = Math.tan(e.bank[i] + (e.bank[j] - e.bank[i]) * (f - i));
  }
  // how far along the edge each sample is from the nearest deck sample (Infinity on an edge with none)
  const deck = deckFlags(e, S, px), deckD = new Float64Array(n).fill(Infinity);
  for (let k = 0, last = -Infinity; k < n; k++) { if (deck[k]) last = S[k]; deckD[k] = S[k] - last; }
  for (let k = n - 1, next = Infinity; k >= 0; k--) { if (deck[k]) next = S[k]; deckD[k] = Math.min(deckD[k], next - S[k]); }
  return { e, n, X, Z, S, TB, gy: e.gy, deck, deckD };
}

// The sample a chord from k runs to: at most len metres on, and sooner once the road has turned by turn
// radians or a deck starts or ends (the chord's heights and bank are interpolated between its ends).
function chordEnd(g, k, len, turn) {
  const { X, Z, S, n, deck } = g;
  if (k + 1 >= n - 1) return n - 1;
  const a0 = Math.atan2(Z[k + 1] - Z[k], X[k + 1] - X[k]);
  let k2 = k + 1;
  while (k2 + 1 < n && S[k2 + 1] - S[k] <= len && deck[k2 + 1] === deck[k]) {
    const a = Math.atan2(Z[k2 + 1] - Z[k2], X[k2 + 1] - X[k2]);
    if (Math.abs(Math.atan2(Math.sin(a - a0), Math.cos(a - a0))) > turn) break;
    k2++;
  }
  return k2;
}

// The x range [lo, hi] where row z crosses the capsule of radius r around segment a-b (written into out),
// or false when the row misses it. The capsule is convex, so the range is one interval: the union of
// what the two end discs and the band between them cover on that row.
function rowSpan(ax, az, bx, bz, r, z, out) {
  let lo = Infinity, hi = -Infinity;
  let h = r * r - (z - az) * (z - az);
  if (h >= 0) { h = Math.sqrt(h); lo = ax - h; hi = ax + h; }
  h = r * r - (z - bz) * (z - bz);
  if (h >= 0) { h = Math.sqrt(h); lo = Math.min(lo, bx - h); hi = Math.max(hi, bx + h); }
  const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
  if (L > 1e-9) {
    // the band: |(x−ax)·nx + q·nz| ≤ r and 0 ≤ (x−ax)·ux + q·uz ≤ L, with q = z − az
    const ux = dx / L, uz = dz / L, nx = -uz, nz = ux, q = z - az;
    let a = -Infinity, b = Infinity;
    if (Math.abs(nx) > 1e-9) { const p0 = (-r - q * nz) / nx, p1 = (r - q * nz) / nx; a = Math.max(a, Math.min(p0, p1)); b = Math.min(b, Math.max(p0, p1)); }
    else if (Math.abs(q * nz) > r) a = Infinity;
    if (Math.abs(ux) > 1e-9) { const p0 = -q * uz / ux, p1 = (L - q * uz) / ux; a = Math.max(a, Math.min(p0, p1)); b = Math.min(b, Math.max(p0, p1)); }
    else if (q * uz < 0 || q * uz > L) a = Infinity;
    if (a <= b) { lo = Math.min(lo, ax + a); hi = Math.max(hi, ax + b); }
  }
  if (lo > hi) return false;
  out[0] = lo; out[1] = hi;
  return true;
}

// Nearest station on a road profile's curve to (x, z). With a hint (the last answer's sample index) it
// walks from there, which is how consecutive edge samples are matched; otherwise it scans the road.
function nearestStation(p, x, z, hint) {
  const { x: X, z: Z } = p.curve, n = p.n, d2 = i => (X[i] - x) ** 2 + (Z[i] - z) ** 2;
  let bi = 0, bd = Infinity;
  if (hint < 0) {
    for (let i = 0; i < n; i++) { const d = d2(i); if (d < bd) { bd = d; bi = i; } }
  } else {
    bi = hint; bd = d2(hint);
    for (let step = 1; step <= 8; step++) for (const i of [idx(hint - step, n, p.closed), idx(hint + step, n, p.closed)]) {
      if (i >= 0) { const d = d2(i); if (d < bd) { bd = d; bi = i; } }
    }
    for (let moved = true; moved;) {
      moved = false;
      for (const i of [idx(bi - 1, n, p.closed), idx(bi + 1, n, p.closed)]) if (i >= 0) { const d = d2(i); if (d < bd) { bd = d; bi = i; moved = true; } }
    }
  }
  // refine along the neighbouring segments
  let s = bi * p.ds, best = Math.sqrt(bd);
  for (const dir of [-1, 1]) {
    const j = idx(bi + dir, n, p.closed);
    if (j < 0) continue;
    const ax = X[bi], az = Z[bi], dx = X[j] - ax, dz = Z[j] - az, L2 = dx * dx + dz * dz || 1;
    const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / L2)), d = Math.hypot(x - ax - dx * t, z - az - dz * t);
    if (d < best) { best = d; s = (bi + dir * t) * p.ds; }
  }
  s = p.closed ? ((s % p.len) + p.len) % p.len : Math.min(Math.max(s, 0), p.len);
  return { i: bi, s, d: best };
}

// ---------- ground cover (biome and colour data for the renderers) ----------
// What the natural ground is made of, per 4 m cell: tended lawn, wild grass from lush to straw, bare earth,
// limestone, beach sand, the Glades' sawgrass and mud. terrain3d paints the ground's colours from it and picks
// its close-up detail by it; plants can thin out or change with it. The heights are not touched.

// The palette, sRGB as the ground is painted (the terrain shader adds the light, not colour).
export const COVER_RGB = {
  // Tended lawn, by how it is kept (groundCover's brown): watered or shaded, mown, browning, scorched. Kept
  // less saturated than it looks, because the sun's light pushes a green albedo toward emerald on screen.
  lawnLush: [70, 98, 54], lawn: [92, 114, 66], lawnDry: [122, 124, 74], lawnBurnt: [148, 138, 92],
  meadow: [94, 124, 60],      // wild grass
  lush: [56, 102, 52],        // tall wet grass in hollows and beside fresh water
  dry: [140, 136, 82],        // sun-dried grass on crests, slopes and the dry fields
  straw: [172, 158, 108],     // the driest of it
  sand: [218, 194, 146], sandDry: [228, 208, 162], wetSand: [158, 138, 104],
  marsh: [154, 140, 86],      // sawgrass, golden
  hammock: [58, 88, 50],      // the Glades' tree islands, dark under their canopy
  mud: [72, 66, 50],          // mangrove and marsh mud
  dirt: [142, 116, 84],       // bare earth, worn verges, eroded banks (warm, so haze does not turn it mauve)
  rock: [156, 138, 108],      // coral limestone where it is fresh: cream-tan
  rockDark: [116, 104, 86],   // weathered and stained
  rockWarm: [168, 132, 92],   // iron-stained
};

// Each region's ground (0..1, reach in m): lawn is how much of the grass within reach of buildings, sidewalks,
// lots and plazas is tended (not along the open roads); dry, lush and bare shift its wild grass; marsh is the Glades' sawgrass and mud; worn is bare
// earth along the verges. Regions blend into each other over about 30 m.
export const BIOMES = {
  heights:      { lawn: 0.85, reach: 24, dry: 0.32, lush: 0.05, bare: 0.25, marsh: 0,   worn: 0.15 },
  north_shore:  { lawn: 0.8,  reach: 22, dry: 0.3,  lush: 0.1,  bare: 0.2,  marsh: 0,   worn: 0.15 },
  ktown:        { lawn: 1,    reach: 70, dry: 0.2,  lush: 0.2,  bare: 0.1,  marsh: 0,   worn: 0.2 },
  downtown:     { lawn: 1,    reach: 70, dry: 0.15, lush: 0.25, bare: 0.05, marsh: 0,   worn: 0.15 },
  gables:       { lawn: 1,    reach: 45, dry: 0.12, lush: 0.45, bare: 0.05, marsh: 0,   worn: 0.05 },
  glades:       { lawn: 0.25, reach: 10, dry: 0.3,  lush: 0.45, bare: 0.1,  marsh: 0.85, worn: 0.25 },
  fest_airport: { lawn: 0.7,  reach: 16, dry: 0.6,  lush: 0,    bare: 0.3,  marsh: 0,   worn: 0.4 },
  port:         { lawn: 0.25, reach: 8,  dry: 0.7,  lush: 0,    bare: 0.55, marsh: 0,   worn: 0.55 },
  collins:      { lawn: 1,    reach: 50, dry: 0.25, lush: 0.3,  bare: 0.1,  marsh: 0,   worn: 0.1 },
  deco:         { lawn: 1,    reach: 50, dry: 0.2,  lush: 0.3,  bare: 0.05, marsh: 0,   worn: 0.1 },
  islets:       { lawn: 1,    reach: 50, dry: 0.08, lush: 0.6,  bare: 0.05, marsh: 0,   worn: 0.05 },
  cape:         { lawn: 0.3,  reach: 10, dry: 0.68, lush: 0,    bare: 0.3,  marsh: 0,   worn: 0.3 },
};
const BIOME_KEYS = ['lawn', 'reach', 'dry', 'lush', 'bare', 'marsh', 'worn'];
const BIOME_SEA = BIOMES.heights;     // what a coast cell blends toward where no region is near

// Grounds of their own (rect: x0, z0, x1, z1 m): the Granada golf course (§2), mown in stripes.
export const COVER_ZONES = [{ id: 'granada_golf', kind: 'golf', rect: [560, 700, 670, 940], stripe: 9, a: 0.35 }];

// groundCover(world) -> { w, h, cell: 4, lawn, brown, dry, lush, bare, rock, marsh, wet, golf, tone }: Uint8ClampedArrays
// of w×h cells 4 m across (cell (i, j) spans x 4i..4i+4, z 4j..4j+4; sample them bilinearly at the cell
// centres), each 0..255 for 0..1:
//   lawn  tended grass            brown how the lawn is kept: watered or shaded (0), mown, browning, scorched (1)
//   dry   wild grass from fresh (0) to straw (1)                                     lush  tall wet grass
//   bare  bare earth              rock  exposed limestone (cliffs, cuttings, steep slopes)
//   marsh sawgrass (0 on the hammocks, the tree islands, which are lush)
//   wet   wet sand on the beaches, mud in the marsh
//   golf  the golf course's mowing stripes (0 off it, 1-127 dark, 128-255 light)
//   tone  small-scale mottling for colour variation (128 = none)
// Cells with no natural ground (grass, sand, dirt or rock) are 0 (tone 128). world needs grids (surf,
// terrain, reg and dims, as world-v2 fills them), regions (REG indices to ids) and SEA_LEVEL. About 60-170 ms
// over the whole map (so terrain3d makes it after the first frame); pure, so it runs in node.
export const COVER_CELL = 4;
export function groundCover(world) {
  const G = world.grids, [SW] = G.dims.surf, [VW, VH] = G.dims.terrain, T = G.terrain, surf = G.surf;
  const C = COVER_CELL, K = C / STEP, W = (VW - 1) / K, H = (VH - 1) / K, n = W * H, sea = world.SEA_LEVEL ?? -1;
  const out = { w: W, h: H, cell: C };
  for (const k of ['lawn', 'brown', 'dry', 'lush', 'bare', 'rock', 'marsh', 'wet', 'golf', 'tone']) out[k] = new Uint8ClampedArray(n);

  // what each cell holds, from four of its 1 m SURF cells: natural ground, sand, rock; water; town (walks,
  // buildings, lots, plazas); roads and decks
  const natC = new Uint8Array(n), sandC = new Uint8Array(n), rockC = new Uint8Array(n), waterM = new Uint8Array(n), townM = new Uint8Array(n), roadM = new Uint8Array(n);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const c = j * W + i;
    for (let s = 0; s < 4; s++) {
      const k = surf[(j * C + 1 + (s >> 1) * 2) * SW + i * C + 1 + (s & 1) * 2] & 15;
      if (k === 2 || k === 8) natC[c]++;                                   // grass, dirt
      else if (k === 7) { natC[c]++; sandC[c]++; } else if (k === 11) { natC[c]++; rockC[c]++; }
      else if (k === 6 || k === 9) waterM[c] = 1; else if (k === 0 || k === 10) roadM[c] = 1; else if (TOWN[k]) townM[c] = 1;
    }
  }
  // distances (m) to water, to the town and to the roads
  const dWater = distanceTransform(waterM, { w: W, h: H, cell: C }), dTown = distanceTransform(townM, { w: W, h: H, cell: C });
  const dRoad = distanceTransform(roadM, { w: W, h: H, cell: C });

  // each region's biome as fields on the 8 m REG grid, feathered so neighbouring regions blend
  const [RW, RH, RC] = G.dims.reg, ids = (world.regions || []).map(r => r.id);
  const P = BIOME_KEYS.map(() => new Float32Array(RW * RH)), M = new Float32Array(RW * RH);
  for (let c = 0; c < RW * RH; c++) {
    const b = BIOMES[ids[G.reg[c]]];
    if (!b) continue;
    M[c] = 1;
    BIOME_KEYS.forEach((k, q) => { P[q][c] = b[k]; });
  }
  for (const f of [...P, M]) boxBlur(f, RW, RH, 3);
  for (let c = 0; c < RW * RH; c++) BIOME_KEYS.forEach((k, q) => { P[q][c] = M[c] > 1e-6 ? P[q][c] / M[c] : BIOME_SEA[k]; });
  const [pLawn, pReach, pDry, pLush, pBare, pMarsh, pWorn] = P;

  // value noise from large patches down to clumps (and one the size of a yard, for the lawns); two more bend
  // the region lookups by up to 50 m, so no region's edge runs dead straight
  const [nMacro, nMeso, nSmall, nPatch, nFine, warpX, warpZ, nYard] = [[520, 41, 8], [150, 42, 4], [44, 43, 1], [70, 44, 2], [14, 45, 1], [90, 46, 4], [90, 47, 4], [24, 48, 1]]
    .map(([m, seed, step]) => noiseField(W, H, C, m, seed, step));

  const R = 6;                      // vertices to the ring the convexity is measured against (12 m)
  const hAt = (i, j) => T[(j < 0 ? 0 : j >= VH ? VH - 1 : j) * VW + (i < 0 ? 0 : i >= VW ? VW - 1 : i)];
  const zones = COVER_ZONES.map(zn => ({ x0: zn.rect[0], z0: zn.rect[1], x1: zn.rect[2], z1: zn.rect[3], ux: Math.cos(zn.a) / zn.stripe, uz: Math.sin(zn.a) / zn.stripe }));
  const { lawn: oLawn, brown: oBrown, dry: oDry, lush: oLush, bare: oBare, rock: oRock, marsh: oMarsh, wet: oWet, golf: oGolf, tone: oTone } = out;
  oTone.fill(128);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const c = j * W + i;
    if (!natC[c]) continue;
    const x = (i + 0.5) * C, z = (j + 0.5) * C, vi = i * K, vj = j * K, v = vj * VW + vi;
    const nm = nMeso[c], ns = nSmall[c], nf = nFine[c], nM = nMacro[c], np = nPatch[c];
    oTone[c] = 128 + Math.max(-1, Math.min(1, ns * 0.5 + nf * 0.7)) * 127;
    // the shape of the ground: height, slope over the cell, how far it stands above the ground 12 m round it
    const t00 = T[v], t10 = T[v + K], t01 = T[v + K * VW], t11 = T[v + K * VW + K], tc = T[v + (K >> 1) * (VW + 1)];
    const y = (t00 + t10 + t01 + t11 + 4 * tc) / 8, hs = y - sea;
    const gx = (t10 + t11 - t00 - t01) / (2 * C), gz = (t01 + t11 - t00 - t10) / (2 * C), slope = Math.sqrt(gx * gx + gz * gz);
    const ci = vi + (K >> 1), cj = vj + (K >> 1), rise = tc - (hAt(ci - R, cj) + hAt(ci + R, cj) + hAt(ci, cj - R) + hAt(ci, cj + R)) / 4;
    const wd = Math.min(dWater[c], 999), td = Math.min(dTown[c], 999), rd = Math.min(dRoad[c], 999);
    // the biome here: the REG fields, bilinear at the bent position
    const fx = Math.min(Math.max((x + 50 * warpX[c]) / RC - 0.5, 0), RW - 1.001), fz = Math.min(Math.max((z + 50 * warpZ[c]) / RC - 0.5, 0), RH - 1.001);
    const ra = Math.floor(fx), rb = Math.floor(fz), ru = fx - ra, rv = fz - rb, r0 = rb * RW + ra, r1 = r0 + RW;
    const w00 = (1 - ru) * (1 - rv), w10 = ru * (1 - rv), w01 = (1 - ru) * rv, w11 = ru * rv;
    const bLawn = pLawn[r0] * w00 + pLawn[r0 + 1] * w10 + pLawn[r1] * w01 + pLawn[r1 + 1] * w11;
    const bReach = pReach[r0] * w00 + pReach[r0 + 1] * w10 + pReach[r1] * w01 + pReach[r1 + 1] * w11;
    const bDry = pDry[r0] * w00 + pDry[r0 + 1] * w10 + pDry[r1] * w01 + pDry[r1 + 1] * w11;
    const bLush = pLush[r0] * w00 + pLush[r0 + 1] * w10 + pLush[r1] * w01 + pLush[r1 + 1] * w11;
    const bBare = pBare[r0] * w00 + pBare[r0 + 1] * w10 + pBare[r1] * w01 + pBare[r1 + 1] * w11;
    const bMarsh = pMarsh[r0] * w00 + pMarsh[r0 + 1] * w10 + pMarsh[r1] * w01 + pMarsh[r1 + 1] * w11;
    const bWorn = pWorn[r0] * w00 + pWorn[r0 + 1] * w10 + pWorn[r1] * w01 + pWorn[r1 + 1] * w11;

    // tended lawn round the town, its edge wandering
    let lawn = bLawn * (1 - smooth01((td - bReach * (0.85 + 0.25 * ns)) / (0.3 * bReach + 6)));
    // How each lawn is kept: every yard and park its own shade (the yard-sized noise, sharpened so neighbours
    // differ rather than blend), browning in the big patches and where the region is dry, greener where it is
    // lush, and worn at the edges of walks and roads. About 0.2 spread across a district.
    const edge = 1 - smooth01((Math.min(td, rd) - 3) / 6);
    let brown = clamp01(0.4 + 0.7 * (bDry - 0.2) - 0.3 * (bLush - 0.3) + 0.2 * nM + 0.12 * nm + 0.1 * np + 0.08 * nf
      + 0.24 * Math.tanh(2.5 * nYard[c]) + 0.14 * edge);
    // the wild grass dries up the hills, on crests and slopes, and in the big patches the noise lays out
    const dry = clamp01(bDry + 0.24 * nM + 0.15 * nm + 0.08 * ns + 0.22 * smooth01((hs - 12) / 40)
      + Math.max(-0.15, Math.min(0.18, rise * 0.06)) + 0.28 * smooth01((slope - 0.12) / 0.4));
    const fresh = bMarsh * (1 - smooth01((wd - 4) / 30));        // the marsh's ponds and lagoon keep it green
    const isle = smooth01((0.45 * nm + 0.45 * np + 0.1 * nf - 0.2) / 0.18), hammock = bMarsh * isle;   // and its tree islands
    const lush = clamp01(bLush - 0.25 * nm + Math.max(0, -rise * 0.05) + 0.6 * fresh + hammock - 0.6 * Math.max(0, dry - 0.5));
    // bare earth: thin patches, worn verges and eroded banks (the cuttings' flanks), never on a lawn
    let bare = clamp01(0.7 * smooth01((bBare + 0.35 * np + 0.45 * nf - 0.6) / 0.12) + bWorn * (1 - smooth01((rd - 1) / 5)) * (0.5 + 0.5 * nf)
      + 0.7 * smooth01((slope - 0.25) / 0.2) * (0.6 + 0.4 * nf)) * (1 - lawn);
    // A slope with a road below it (downhill, within 24 m) is a cutting's face, one with a road above it a fill's
    // flank. Limestone: the cliffs, cutting faces from about 16 degrees, other ground past about 27, and
    // outcrops on slopes; a fill's flank stays earth and grass.
    let cut = 0, fill = 0;
    if (slope > 0.25) {
      const ux = gx / slope, uz = gz / slope;
      for (let st = 1; st <= 6 && !cut && !fill; st++) {
        const di = i - Math.round(ux * st), dj = j - Math.round(uz * st), ui = i + Math.round(ux * st), uj = j + Math.round(uz * st);
        if (di >= 0 && dj >= 0 && di < W && dj < H && roadM[dj * W + di]) cut = 1;
        else if (ui >= 0 && uj >= 0 && ui < W && uj < H && roadM[uj * W + ui]) fill = 1;
      }
    }
    const outcrop = smooth01((slope - 0.25) / 0.2) * smooth01((0.5 * nf + 0.5 * ns - 0.3) / 0.15) * 0.8;
    let rock = Math.max(rockC[c] / 4, cut * smooth01((slope - 0.28) / 0.25), (1 - fill) * smooth01((slope - 0.5) / 0.35), outcrop * (1 - lawn) * (1 - fill));
    const marsh = bMarsh * (1 - lawn) * (1 - isle) * (0.85 + 0.15 * ns);
    // wet: the beach below its last 0.5 m above the waterline (-0.8), the marsh's mud round its water (a rim
    // about 10-20 m wide, ragged) and in patches out on the sawgrass
    const wetSand = sandC[c] ? smooth01((-0.25 - y) / 0.5) : 0;
    const mud = Math.min(1, 1.25 * bMarsh) * (1 - lawn) * Math.max((1 - smooth01((wd - 10 - 4 * nf) / 10)) * (0.85 + 0.15 * nf), (1 - isle) * smooth01((np - 0.3) / 0.15) * 0.7);
    for (const zn of zones) {
      if (x < zn.x0 || x > zn.x1 || z < zn.z0 || z > zn.z1 || Math.min(td, rd) < 3) continue;
      oGolf[c] = Math.sin(Math.PI * (x * zn.ux + z * zn.uz)) > 0 ? 200 : 60;
      lawn = 1; bare = 0; rock = Math.min(rock, 0.25); brown = 0.2;
    }
    oLawn[c] = lawn * 255; oBrown[c] = brown * 255; oLush[c] = lush * 255; oBare[c] = bare * 255;
    oDry[c] = dry * (1 - 0.6 * hammock) * 255;   // (the hammocks' shade keeps them green)
    oRock[c] = rock * 255; oMarsh[c] = marsh * 255; oWet[c] = Math.max(wetSand, mud) * 255;
  }
  return out;
}

// SURF kinds that are the town: walk, building, lot, plaza
const TOWN = [0, 1, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const clamp01 = t => (t < 0 ? 0 : t > 1 ? 1 : t);

// Value noise (-1..1) with features about m metres across over a w×h grid of cells `cell` metres across,
// evaluated every `step` cells and interpolated between (plenty for anything wider than a few steps).
function noiseField(w, h, cell, m, seed, step) {
  const lw = Math.ceil(w * cell / m) + 2, lh = Math.ceil(h * cell / m) + 2;
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const lat = Float32Array.from({ length: lw * lh }, () => rnd() * 2 - 1);
  const gw = Math.ceil(w / step) + 1, gh = Math.ceil(h / step) + 1, g = new Float32Array(gw * gh);
  for (let b = 0; b < gh; b++) for (let q = 0; q < gw; q++) {
    const fx = (q * step + 0.5) * cell / m, fz = (b * step + 0.5) * cell / m, i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j, su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v), p = j * lw + i;
    const a0 = lat[p] + (lat[p + 1] - lat[p]) * su, a1 = lat[p + lw] + (lat[p + lw + 1] - lat[p + lw]) * su;
    g[b * gw + q] = a0 + (a1 - a0) * sv;
  }
  if (step === 1 && gw === w + 1) {
    const f = new Float32Array(w * h);
    for (let j = 0; j < h; j++) f.set(g.subarray(j * gw, j * gw + w), j * w);
    return f;
  }
  const f = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const fj = j / step, b = Math.floor(fj), v = fj - b;
    for (let i = 0; i < w; i++) {
      const fi = i / step, q = Math.floor(fi), u = fi - q, p = b * gw + q;
      f[j * w + i] = (g[p] * (1 - u) + g[p + 1] * u) * (1 - v) + (g[p + gw] * (1 - u) + g[p + gw + 1] * u) * v;
    }
  }
  return f;
}

// ---------- small helpers ----------

function idx(i, n, closed) { return closed ? ((i % n) + n) % n : (i < 0 || i >= n ? -1 : i); }
function sampleAlong(a, f, n, closed) {
  if (closed) { f = ((f % n) + n) % n; const i = Math.floor(f), j = (i + 1) % n; return a[i] + (a[j] - a[i]) * (f - i); }
  f = Math.min(Math.max(f, 0), n - 1);
  const i = Math.min(Math.floor(f), n - 2);
  return a[i] + (a[i + 1] - a[i]) * (f - i);
}
function roadById(data, id) { return data.ROADS.find(r => r.id === id); }
function clampI(i, n) { return i < 0 ? 0 : i >= n ? n - 1 : i; }
function now() { return globalThis.performance ? performance.now() : Date.now(); }

// The caller's array when it is the right size (a raw typed array or a {data} grid), else a new one,
// which is stored back under that name.
function takeArray(grids, key, n, Type) {
  const g = grids[key];
  if (g instanceof Type && g.length === n) return g;
  if (g?.data instanceof Type && g.data.length === n) return g.data;
  return (grids[key] = new Type(n));
}

function insidePoly(pts, x, z) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// (squared distances to each edge, one square root at the end: pads call this for every vertex round a lot)
function distToPoly(pts, x, z) {
  let d2 = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const ax = pts[j][0], az = pts[j][1], dx = pts[i][0] - ax, dz = pts[i][1] - az, L2 = dx * dx + dz * dz;
    const t = L2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / L2)) : 0, ex = x - ax - dx * t, ez = z - az - dz * t;
    const e2 = ex * ex + ez * ez;
    if (e2 < d2) d2 = e2;
  }
  return Math.sqrt(d2);
}
