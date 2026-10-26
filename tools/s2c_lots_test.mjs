#!/usr/bin/env node
// Stage S2c: the frontage lots (docs/map-v2-spec.md §2, §3, §6.4, §7), headless.   node tools/s2c_lots_test.mjs [-v]
// On the v2 world as generate() builds it: at most 450 buildings, every §6.4 field, no overlaps, every lot
// in one of the seven lot styles of its region and facing its road, its curb on that road, Ocean Drive's
// hotels facing east, the height caps (K-Town 18 m, Downtown's low-rise north row, the view corridors), the
// junction zones (r_j + 6 m), no water near a pad, the keep-clear areas, Kimchi Tower blocking on its plaza,
// and the deliver flag. Then placeBuildings itself, rerun on the rasters as they stood before the lots: the
// same input gives the same lots, and a street taken away leaves the lots of streets far from it unchanged
// (each edge side has its own random stream).
import * as D from '../src/map/mapdata.js';
import { KIND, KIND_MASK, FLAG, fillOBB } from '../src/map/raster.js';
import { placeBuildings } from '../src/map/lots.js';
import { mulberry32 } from '../src/util.js';
import * as W from '../src/world-v2.js';

let passed = 0, failed = 0;
const VERBOSE = process.argv.includes('-v');      // -v prints every check, not only the failures
const ok = (cond, msg) => { if (cond) { passed++; if (VERBOSE) console.log('  ok   ' + msg); } else { failed++; console.log('  FAIL ' + msg); } };
const PX = 16, SW = 2048, SH = 1792, deg = r => r * 180 / Math.PI;
const LOT_STYLES = ['deco', 'resort', 'tower', 'ktown', 'house', 'mansion', 'warehouse'];

W.generate();
const B = W.buildings, lots = B.filter(b => b.kind === 'lot'), surf = W.grids.surf, net = W.roads;
const bits = (x, z) => { const i = Math.floor(x), j = Math.floor(z); return i < 0 || j < 0 || i >= SW || j >= SH ? KIND.WATER : surf[j * SW + i]; };
const kind = (x, z) => bits(x, z) & KIND_MASK;
const region = id => D.REGIONS.find(r => r.id === id);
const corners = (b, grow = 0) => { const fx = Math.cos(b.a), fz = Math.sin(b.a), rx = fz, rz = -fx, w = b.w / 2 + grow, d = b.d / 2 + grow; return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [b.cx + rx * u * w + fx * v * d, b.cz + rz * u * w + fz * v * d]); };
const inOBB = (b, x, z, grow = 0) => { const px = x - b.cx, pz = z - b.cz, fx = Math.cos(b.a), fz = Math.sin(b.a); return Math.abs(px * fz - pz * fx) <= b.w / 2 + grow && Math.abs(px * fx + pz * fz) <= b.d / 2 + grow; };
// distance from a point to a building's footprint (0 inside)
const distOBB = (b, x, z) => { const px = x - b.cx, pz = z - b.cz, fx = Math.cos(b.a), fz = Math.sin(b.a), u = Math.abs(px * fz - pz * fx) - b.w / 2, v = Math.abs(px * fx + pz * fz) - b.d / 2; return Math.hypot(Math.max(u, 0), Math.max(v, 0)); };
const insidePoly = (pts, x, z) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, zi] = pts[i], [xj, zj] = pts[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; };

console.log('counts and fields (§6.4)');
{
  ok(B.length <= 450, `${B.length} buildings (≤ 450)`);
  ok(lots.length >= 300, `${lots.length} frontage lots`);
  const by = {};
  for (const b of lots) by[b.style] = (by[b.style] || 0) + 1;
  ok(LOT_STYLES.every(s => by[s] > 0) && Object.keys(by).every(s => LOT_STYLES.includes(s)), `every lot style and only those: ${JSON.stringify(by)}`);
  const fin = Number.isFinite;
  const bad = B.filter(b => !(fin(b.id) && fin(b.cx) && fin(b.cz) && b.w > 0 && b.d > 0 && b.h > 0 && fin(b.base) && fin(b.a) && b.style && b.region && b.floors >= 1 && b.wall && b.roof &&
    fin(b.door?.x) && fin(b.door?.y) && fin(b.door?.a) && fin(b.curb?.x) && fin(b.curb?.y) && typeof b.deliver === 'boolean' && /^\d+,\d+$/.test(b.tile) && /^\d+,\d+$/.test(b.cell)));
  ok(bad.length === 0, `every building has the §6.4 fields (${bad.length} without)`);
  ok(lots.every(b => region(b.region)?.style === b.style), 'every lot has its region\'s style');
}

console.log('footprints');
{
  // separating axes over a 32 m hash, like map_check
  const hash = new Map(), over = [];
  const ax = b => [[Math.sin(b.a), -Math.cos(b.a)], [Math.cos(b.a), Math.sin(b.a)]];
  const proj = (b, ux, uz) => ax(b).reduce((s, [px, pz], i) => s + (i ? b.d : b.w) / 2 * Math.abs(px * ux + pz * uz), 0);
  const sep = (p, q) => [...ax(p), ...ax(q)].some(([ux, uz]) => Math.abs((q.cx - p.cx) * ux + (q.cz - p.cz) * uz) >= proj(p, ux, uz) + proj(q, ux, uz) - 1e-6);
  for (const b of B) {
    const r = Math.hypot(b.w, b.d) / 2, keys = [];
    for (let j = Math.floor((b.cz - r) / 32); j <= Math.floor((b.cz + r) / 32); j++) for (let i = Math.floor((b.cx - r) / 32); i <= Math.floor((b.cx + r) / 32); i++) keys.push(i + ',' + j);
    const seen = new Set();
    for (const k of keys) for (const o of hash.get(k) || []) if (!seen.has(o)) { seen.add(o); if (!sep(b, o)) over.push(`${o.id}/${b.id}`); }
    for (const k of keys) { if (!hash.has(k)) hash.set(k, []); hash.get(k).push(b); }
  }
  ok(over.length === 0, `no two buildings overlap (${over.slice(0, 5).join(' ')})`);
  let notBuilt = 0;
  for (const b of lots) {
    const SG = { w: SW, h: SH, cell: 1, o: 0.5, data: surf };
    fillOBB(SG, b.cx, b.cz, b.w, b.d, b.a, i => { if ((surf[i] & KIND_MASK) !== KIND.BUILD || (surf[i] & (FLAG.BLOCK_CAR | FLAG.BLOCK_FOOT)) !== (FLAG.BLOCK_CAR | FLAG.BLOCK_FOOT)) notBuilt++; });
  }
  ok(notBuilt === 0, `every lot footprint is BUILD and blocks both ways in SURF (${notBuilt} cells not)`);
  // the lot's ground: pads flat, never far under the road it faces
  ok(lots.every(b => Math.abs(W.groundY(b.cx * PX, b.cz * PX) - 0.16 - b.base) < 0.05), 'every lot stands on its pad (groundY = base + plinth)');
}

console.log('facing the road');
{
  let curbOnRoad = 0, facing = 0, worst = 0;
  for (const b of lots) {
    const cx = b.curb.x / PX, cz = b.curb.y / PX, k = kind(cx, cz);
    if (k === KIND.ROAD || k === KIND.WALK) curbOnRoad++;
    const near = net.nearest(b.door.x, b.door.y, { maxD: 60 * PX });
    if (near) {
      const want = Math.atan2(near.y - b.cz * PX, near.x - b.cx * PX), off = Math.abs(Math.atan2(Math.sin(want - b.a), Math.cos(want - b.a)));
      worst = Math.max(worst, off);
      if (off < 25 * Math.PI / 180) facing++;
    }
  }
  ok(curbOnRoad / lots.length > 0.97, `curbs (door + 10 m) on a road or its sidewalk: ${curbOnRoad}/${lots.length}`);
  ok(facing / lots.length > 0.97, `lots facing the nearest road within 25°: ${facing}/${lots.length} (worst ${deg(worst).toFixed(0)}°)`);
}

console.log('Ocean Drive');
{
  const collins = new Set(net.edges.filter(e => e.road === 'collins_ocean').map(e => e.id)), alt = D.ROADS.find(r => r.id === 'collins_ocean').altFromZ;
  const od = lots.filter(b => b.cz >= alt && collins.has(net.nearest(b.curb.x, b.curb.y, { maxD: 12 * PX })?.edge));
  const yaw = od.map(b => deg(Math.atan2(Math.sin(b.a), Math.cos(b.a))));
  ok(od.length >= 6, `${od.length} hotels on Ocean Drive`);
  ok(yaw.every(a => Math.abs(a) <= 10), `they face east within ±10°: ${yaw.map(a => a.toFixed(1)).join(' ')}`);
  ok(od.every(b => b.floors >= 1 && b.floors <= 6) && od.some(b => b.floors >= 4), `Ocean Drive's 3-6 floors: ${od.map(b => b.floors).join(' ')}`);
  ok(od.every(b => b.region === 'deco' && b.cx < 1812), 'all in Deco Beach, on the west side');
  const east = lots.filter(b => b.cx > 1820 && b.cz > 300 && b.cz < 1150);
  ok(east.length === 0, `nothing east of Collins / Ocean Drive (Lummus Park, the Beachwalk): ${east.length}`);
}

console.log('heights');
{
  const kt = lots.filter(b => b.region === 'ktown');
  ok(kt.every(b => b.h <= 18), `K-Town under its 18 m cap (tallest ${Math.max(...kt.map(b => b.h)).toFixed(1)} m)`);
  const lowRise = lots.filter(b => b.region === 'downtown' && b.cz < 470);
  ok(lowRise.length > 0 && lowRise.every(b => b.floors >= 1 && b.floors <= 5), `Downtown's north row is low-rise: ${lowRise.map(b => b.floors).join(' ')}`);
  const towers = lots.filter(b => b.region === 'downtown' && b.cz >= 470);
  ok(towers.some(b => b.floors >= 30) && towers.every(b => b.floors <= 45), `towers up to 45 floors (tallest ${Math.max(...towers.map(b => b.floors))})`);
  // floors never above the region's range (a height cap may hold a lot below it)
  const top = { mansion: 3, house: 2, warehouse: 2 };
  const over = lots.filter(b => { const R = region(b.region); return b.floors > Math.max(R.lowRise?.floors[1] ?? 0, R.oceanDrive?.floors[1] ?? 0, R.floors?.[1] ?? top[b.style]); });
  ok(over.length === 0, `floors never above the region's range (${over.length} over)`);
  for (const C of D.VIEW_CORRIDORS) {
    const hit = lots.filter(b => corners(b).some(([x, z]) => insidePoly(C.pts, x, z)) || C.pts.some(([x, z]) => inOBB(b, x, z)));
    ok(hit.every(b => b.h <= C.maxH), `view corridor ${C.id}: ${hit.length} lots reach in, none over ${C.maxH} m`);
  }
}

console.log('rejection');
{
  const nodes = net.nodes.filter(N => N.ends.length >= 3);
  let jct = 0;
  for (const b of lots) for (const N of nodes) {
    const r = Math.max(...N.ends.map(E => E.trim)) / PX + 6;
    if (distOBB(b, N.x / PX, N.y / PX) < r - 1) { jct++; break; }
  }
  ok(jct === 0, `no lot inside a junction zone (r_j + 6 m): ${jct}`);
  let wet = 0, hwy = 0;
  for (const b of lots) {
    for (let v = -b.d / 2 - 5.5; v <= b.d / 2 + 5.5; v += 1) for (let u = -b.w / 2 - 5.5; u <= b.w / 2 + 5.5; u += 1) {
      const x = b.cx + Math.sin(b.a) * u + Math.cos(b.a) * v, z = b.cz - Math.cos(b.a) * u + Math.sin(b.a) * v, k = kind(x, z);
      if (k === KIND.WATER || k === KIND.SHALLOW) { wet++; v = Infinity; break; }
      if (bits(x, z) & FLAG.NOPED) { hwy++; v = Infinity; break; }
    }
  }
  ok(wet === 0 && hwy === 0, `no water or highway within 5.5 m of a lot (${wet} wet, ${hwy} by the highway)`);
  const golf = lots.filter(b => b.cx > 560 && b.cx < 670 && b.cz > 700 && b.cz < 940), bay = lots.filter(b => b.cx > 1240 && b.cx < 1330 && b.cz > 560 && b.cz < 680);
  ok(golf.length === 0 && bay.length === 0, 'none on the Granada golf course or in Bayfront Park');
  const lm = lots.filter(b => D.LANDMARKS.some(L => L.x !== undefined && L.kind === 'resort' && Math.hypot(L.x - b.cx, L.z - b.cz) < 34));
  ok(lm.length === 0, 'the curved resort landmark keeps its ground');
}

console.log('Kimchi Tower and its plaza');
{
  const T = D.LANDMARKS.find(l => l.id === 'kimchi_tower');
  let build = 0, n = 0;
  for (let j = Math.ceil(T.z - T.d / 2 + 0.5); j < T.z + T.d / 2 - 0.5; j++) for (let i = Math.ceil(T.x - T.w / 2 + 0.5); i < T.x + T.w / 2 - 0.5; i++) { n++; if ((surf[j * SW + i] & KIND_MASK) === KIND.BUILD) build++; }
  ok(build === n, `the tower's ${T.w}×${T.d} m footprint is BUILD (${build}/${n})`);
  ok(W.blockedCarPx(T.x * PX, T.z * PX) && W.blockedFootPx(T.x * PX, T.z * PX) && W.wallNormalPx((T.x - T.w / 2 - 0.6) * PX, T.z * PX, {})?.x < -0.7, 'cars and people collide with it, the wall pushes out west on its west face');
  let plaza = 0;
  for (let j = 480; j < 552; j += 4) for (let i = 1150; i < 1215; i += 4) if (kind(i + 0.5, j + 0.5) === KIND.PLAZA) plaza++;
  ok(plaza > 150, `Kimchi Plaza is paved round it (${plaza} samples)`);
  ok(!lots.some(b => b.cx > 1146 && b.cx < 1222 && b.cz > 470 && b.cz < 560), 'no lot on the plaza');
  // (lead decision: Kimchi Tower is a full building, F3; the sightlines keep clear of it in mapdata SIGHT_TARGETS)
  const tw = B.filter(b => b.landmark === 'kimchi_tower');
  ok(tw.length === 1 && tw[0].w === T.w && tw[0].d === T.d && tw[0].h === T.h && Math.hypot(tw[0].cx - T.x, tw[0].cz - T.z) < 0.5,
    `exactly one building is the tower, with the landmark's ${T.w}×${T.d}×${T.h} m size (${tw.length})`);
}

console.log('deliveries');
{
  const del = lots.filter(b => b.deliver);
  ok(del.length / lots.length > 0.9, `${del.length}/${lots.length} lots take deliveries`);
  let bad = 0;
  for (const b of del) {
    const d = bits(b.door.x / PX, b.door.y / PX), c = bits(b.curb.x / PX, b.curb.y / PX);
    if (d & FLAG.BLOCK_FOOT || c & (FLAG.BLOCK_CAR | FLAG.NOPED)) bad++;
  }
  ok(bad === 0, `their doors can be walked to and their curbs driven to (${bad} not)`);
  const doors = new Set(W.deliveryDoors.map(d => d.b));
  ok(del.every(b => doors.has(b)), 'every delivering lot is in deliveryDoors');
}

console.log('placeBuildings: deterministic, a stream per edge side');
{
  // the rasters as they stood before the lots: lot footprints back to grass, the tower and its plaza back to
  // grass, and the rails and walls props stamped (block flags on verge cells and the Loop's deck median) off
  const g = { ...W.grids, surf: surf.slice() }, s2 = g.surf, SG = { w: SW, h: SH, cell: 1, o: 0.5, data: s2 };
  for (const b of lots) fillOBB(SG, b.cx, b.cz, b.w, b.d, b.a, KIND.GRASS);
  for (let j = 470; j < 560; j++) for (let i = 1146; i < 1222; i++) { const k = s2[j * SW + i] & KIND_MASK; if (k === KIND.PLAZA || k === KIND.BUILD) s2[j * SW + i] = KIND.GRASS; }
  for (let c = 0; c < s2.length; c++) {
    const k = s2[c] & KIND_MASK;
    if (k === KIND.GRASS || k === KIND.SAND || k === KIND.DIRT) s2[c] &= ~(FLAG.BLOCK_CAR | FLAG.BLOCK_FOOT);
    else if (k === KIND.DECK && s2[c] & FLAG.NOPED) s2[c] &= ~FLAG.BLOCK_CAR;
  }
  const prefabs = B.filter(b => b.kind !== 'lot').map(b => ({ ...b, door: { x: b.door.x / PX, z: b.door.y / PX, a: b.door.a } }));
  const run = (edges, stats) => placeBuildings({ ...net, edges }, W.regions, { ...g, surf: s2.slice() }, mulberry32(77), { prefabs, corridors: D.VIEW_CORRIDORS, cap: 450, stats }).filter(b => b.kind === 'lot');
  const stats = {}, t0 = performance.now(), a = run(net.edges, stats), ms = performance.now() - t0, b = run(net.edges);
  const key = q => `${q.edge}/${q.side} ${q.cx.toFixed(3)},${q.cz.toFixed(3)} ${q.w.toFixed(3)}×${q.d.toFixed(3)} ${q.floors} ${q.wall}`;
  ok(a.length > 300 && a.map(key).join() === b.map(key).join(), `the same input gives the same ${a.length} lots (${ms.toFixed(1)} ms)`);
  ok(Object.keys(stats).length > 0 && stats.taken > 0, `rejection reasons are counted: ${JSON.stringify(stats)}`);
  // take Lincoln Road away: lots more than 150 m from it keep everything, each stream untouched
  const gone = net.edges.filter(e => e.road === 'lincoln').map(e => e.id), far = q => net.edges.filter(e => gone.includes(e.id)).every(e => {
    for (let i = 0; i < e.n; i++) if (Math.hypot(e.x[i] / PX - q.cx, e.y[i] / PX - q.cz) < 150) return false;
    return true;
  });
  const c = run(net.edges.filter(e => !gone.includes(e.id)));
  const before = a.filter(q => !gone.includes(q.edge) && far(q)).map(key), after = new Set(c.map(key));
  ok(gone.length > 0 && before.length > 250 && before.every(k => after.has(k)), `without Lincoln Road the ${before.length} lots far from it are unchanged`);
  const seeded = placeBuildings({ ...net }, W.regions, { ...g, surf: s2.slice() }, mulberry32(78), { prefabs, corridors: D.VIEW_CORRIDORS, cap: 450 }).filter(q => q.kind === 'lot');
  ok(seeded.map(key).join() !== a.map(key).join(), 'another world seed gives other lots');
  const capped = placeBuildings({ ...net }, W.regions, { ...g, surf: s2.slice() }, mulberry32(77), { prefabs, corridors: D.VIEW_CORRIDORS, cap: 200 });
  ok(capped.length === 200 && prefabs.every(p => capped.includes(p)), 'a cap of 200 keeps every prefab and drops lots');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
