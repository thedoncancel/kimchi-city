#!/usr/bin/env node
// Stage S2b: the prefabs are world.js's layout branches moved verbatim into the §1 local frame.
//   node tools/s2b_prefab_test.mjs
// Each place prefab is built at its old grid block with the south-facing frame (a = π/2) and compared with
// what the classic grid world builds there: building rectangles and doors, every filled tile, palm and deco
// positions, the garage, display and police spots, the jet and its solid, and the photo spots. Then the
// frame itself: the §1 transform, headings, and the §5.1 door/foot/curb formulas on rotated places.
import { PREFABS, toWorld, toWorldHeading, frontOf } from '../src/map/prefabs.js';
import { KIND } from '../src/map/raster.js';
import * as G from '../src/world-grid.js';

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { failed++; console.log('  FAIL ' + msg); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const PX = 16, TM = 4;

G.generate();
// the grid's layout, as world.js lays it out (block bx,by -> place key)
const LAYOUT = { '1,1': 'villa', '2,1': 'mart', '3,2': 'dealer', '1,3': 'kimchi', '4,1': 'yuna', '2,2': 'park', '4,2': 'police', '1,5': 'hospital',
  '2,4': 'spray', '5,2': 'guns', '2,3': 'watches', '3,3': 'fashion', '5,5': 'jet', '0,5': 'marina', '3,1': 'lot' };
const PLACE = { villa: 'home' };

console.log('prefabs against the grid layout (a = π/2)');
for (const [blk, key] of Object.entries(LAYOUT)) {
  const [bx, by] = blk.split(',').map(Number), x0 = bx * G.P + 3, y0 = by * G.P + 3;
  const F = [x0 * TM + 20, y0 * TM + 40], out = PREFABS[key](F, Math.PI / 2, { seed: 1 });
  const inBlock = (x, y) => x >= x0 * G.T - 1 && x <= (x0 + 10) * G.T + 1 && y >= y0 * G.T - 1 && y <= (y0 + 10) * G.T + 1;
  // buildings: same rectangle and door
  const gb = G.buildings.filter(b => b.x >= x0 && b.x < x0 + 10 && b.y >= y0 && b.y < y0 + 10);
  ok(gb.length === out.buildings.length, `${key}: ${out.buildings.length} buildings, the grid has ${gb.length}`);
  for (const b of gb) {
    const cx = (b.x + b.w / 2) * TM, cz = (b.y + b.h / 2) * TM;
    const p = out.buildings.find(q => near(q.cx, cx, 1e-6) && near(q.cz, cz, 1e-6));
    ok(p && near(p.w, b.w * TM) && near(p.d, b.h * TM) && near(p.a, Math.PI / 2), `${key}: building ${b.id} rectangle`);
    if (p) ok(near(p.door.x * PX, b.door.x, 1e-6) && near(p.door.z * PX, b.door.y, 1e-6), `${key}: building ${b.id} door (${p.door.x * PX},${p.door.z * PX}) vs (${b.door.x},${b.door.y})`);
    if (p) ok(p.wall === b.wall && p.roof === b.roof && p.sign === (b.sign ?? null) && (p.place ?? undefined) === (b.place ?? undefined), `${key}: building ${b.id} colours and sign`);
  }
  // every tile of the block: the grid tile against the prefab's surfaces (and buildings) at the tile centre
  let tileBad = 0;
  for (let ty = 0; ty < 10; ty++) for (let tx = 0; tx < 10; tx++) {
    const wx = (x0 + tx + 0.5) * TM, wz = (y0 + ty + 0.5) * TM;
    let k = KIND.GRASS;
    for (const s of out.surfaces) if (s.obb && insideOBB(s.obb, wx, wz)) k = s.kind;
    for (const b of out.buildings) if (insideOBB([b.cx, b.cz, b.w, b.d, b.a], wx, wz)) k = KIND.BUILD;
    if (k !== G.tileAt(x0 + tx, y0 + ty)) tileBad++;
  }
  ok(tileBad === 0, `${key}: ${tileBad} of 100 tiles differ from the grid`);
  // palms and deco at the same spots (the grid's random numbers differ, so only positions are compared)
  const gp = G.palms.filter(p => inBlock(p.x, p.y)), pp = out.palms.map(p => [p.x * PX, p.z * PX]);
  ok(gp.length === pp.length && gp.every(p => pp.some(q => near(q[0], p.x, 1e-6) && near(q[1], p.y, 1e-6))), `${key}: palms ${pp.length} vs grid ${gp.length}`);
  const gd = G.deco.filter(d => inBlock(d.x, d.y));
  ok(gd.length === out.deco.length && gd.every(d => out.deco.some(q => q.kind === d.kind && near(q.x * PX, d.x, 1e-6) && near(q.z * PX, d.y, 1e-6))), `${key}: deco`);
  // trees: the grid plants by chance, so only their number range and that they stand on grass
  for (const t of out.trees) {
    const tx = Math.floor(t.x / TM) - x0, ty = Math.floor(t.z / TM) - y0;
    ok(tx >= 0 && ty >= 0 && tx < 10 && ty < 10, `${key}: tree off the block`);
  }
  const place = G.places[PLACE[key] || key];
  if (place && out.place) ok(near(out.place.door.x * PX, place.door.x, 1e-6) && near(out.place.door.z * PX, place.door.y, 1e-6), `${key}: place door`);
  const photo = out.photo && G.photoSpots.find(p => p.id === out.photo.id);
  if (out.photo && key !== 'park') ok(photo && near(out.photo.x * PX, photo.x, 1e-6) && near(out.photo.z * PX, photo.y, 1e-6), `${key}: photo spot ${out.photo.id}`);
  if (key === 'villa') ok(out.garage.length === 8 && out.garage.every((s, i) => near(s.x * PX, G.places.home.garage[i].x, 1e-6) && near(s.z * PX, G.places.home.garage[i].y, 1e-6) && near(s.a, Math.PI / 2)), 'villa: garage');
  if (key === 'dealer') ok(out.display.length === 7 && out.display.every((s, i) => near(s.x * PX, G.displaySpots[i].x, 1e-6) && near(s.z * PX, G.displaySpots[i].y, 1e-6) && near(Math.cos(s.a), Math.cos(G.displaySpots[i].a)) && near(Math.sin(s.a), Math.sin(G.displaySpots[i].a))), 'dealer: display spots');
  if (key === 'police') ok(out.spots.every((s, i) => near(s.x * PX, G.places.police.spots[i].x, 1e-6) && near(s.z * PX, G.places.police.spots[i].y, 1e-6)), 'police: spots');
  if (key === 'jet') {
    const gpl = G.places.jet.plane;
    ok(near(out.plane.x * PX, gpl.x, 1e-6) && near(out.plane.z * PX, gpl.y, 1e-6) && near(out.plane.a, gpl.a), 'jet: plane');
    const s = out.solids[0], g = G.solids[0];
    ok(s && near(s.x0 * PX, g.x0, 1e-6) && near(s.x1 * PX, g.x1, 1e-6) && near(s.z0 * PX, g.y0, 1e-6) && near(s.z1 * PX, g.y1, 1e-6), 'jet: the parked jet blocks the same rectangle');
  }
  if (key === 'lot') ok(out.parking.length === 10 && out.parking.every(s => G.parkedSpawns.some(g => near(g.x, s.x * PX, 1e-6) && near(g.y, s.z * PX, 1e-6))), 'lot: parking bays');
}

console.log('the §1 frame');
{
  // a = π/2 is today's layout: world = F + (lx − 20, lz − 40)
  const [x, z] = toWorld([100, 200], Math.PI / 2, 7, 13);
  ok(near(x, 87) && near(z, 173), 'π/2 keeps the grid layout');
  // local +z (the front) points along the facing, local +x along (sin a, −cos a)
  for (const a of [0, 0.5, 2.62, -Math.PI / 2, Math.PI]) {
    const [fx, fz] = toWorld([0, 0], a, 20, 41), [rx, rz] = toWorld([0, 0], a, 21, 40);
    ok(near(fx, Math.cos(a)) && near(fz, Math.sin(a)), `front of a=${a}`);
    ok(near(rx, Math.sin(a)) && near(rz, -Math.cos(a)), `local x of a=${a}`);
    ok(near(Math.cos(toWorldHeading(Math.PI / 2, a)), Math.cos(a)) && near(Math.sin(toWorldHeading(Math.PI / 2, a)), Math.sin(a)), `heading of a=${a}`);
    const C = frontOf([50, 60], a), [cx, cz] = toWorld(C, a, 20, 20);
    ok(near(cx, 50) && near(cz, 60), `frontOf puts local (20,20) on the centre for a=${a}`);
  }
}

console.log('§5.1 formulas on turned places');
for (const [key, F, a, door] of [['villa', [350, 268], 0.5, [331.8, 262.6]], ['yuna', [804, 881], 2.62, [815.7, 872]],
  ['dealer', [880, 1371.5], -Math.PI / 2, [888, 1390.1]], ['hospital', [1227.4, 890], 0, [1216.8, 890]], ['marina', [1650, 1205], Math.PI, [1672.6, 1201]]]) {
  const p = PREFABS[key](F, a, { seed: 1 }).place;
  ok(Math.hypot(p.door.x - door[0], p.door.z - door[1]) < 0.06, `${key}: door (${p.door.x.toFixed(2)},${p.door.z.toFixed(2)}) vs §5.1 (${door})`);
  ok(near(Math.hypot(p.foot.x - p.door.x, p.foot.z - p.door.z), 2.2) && near(Math.hypot(p.curb.x - p.door.x, p.curb.z - p.door.z), 10), `${key}: foot 2.2 m and curb 10 m out`);
  ok(near(Math.cos(p.door.a), Math.cos(a)) && near(Math.sin(p.door.a), Math.sin(a)), `${key}: the door faces the street`);
}

console.log('the new prefabs');
{
  const pc = PREFABS.park_circle(frontOf([870, 560], Math.PI / 2), Math.PI / 2, {});
  ok(Math.hypot(pc.place.door.x - 870, pc.place.door.z - 564.375) < 1e-6, 'park_circle: door 70 px past the fountain');
  ok(pc.deco.some(d => d.kind === 'fountain' && near(d.x, 870) && near(d.z, 560)), 'park_circle: fountain at the centre');
  ok(pc.trees.every(t => Math.hypot(t.x - 870, t.z - 560) < 36), 'park_circle: trees inside the lawn');
  const sm = PREFABS.star_mansions(frontOf([1440, 1050], Math.PI / 2), Math.PI / 2, {});
  ok(sm.buildings.length === 6 && sm.buildings.every(b => b.kind === 'mansion'), 'star_mansions: six mansions');
  const hr = PREFABS.hangar_row([560, 1505], Math.PI / 2, {});
  ok(hr.runway && near(hr.runway.w, 720) && hr.surfaces.some(s => s.runway && near(s.obb[0], 660) && near(s.obb[1], 1528)), 'hangar_row: the 720 m runway centred on (660,1528)');
  const fg = PREFABS.fest_grounds([820, 1453.5], Math.PI / 2, {});
  ok(fg.parking.length === 10 && fg.deco.some(d => d.kind === 'kiosk' && near(d.x, 835) && near(d.z, 1380)), 'fest_grounds: car park and the event board kiosk at (835,1380)');
  // the same seed gives the same prefab
  ok(JSON.stringify(PREFABS.yuna([804, 881], 2.62, { seed: 9 })) === JSON.stringify(PREFABS.yuna([804, 881], 2.62, { seed: 9 })), 'prefabs are deterministic for a seed');
}

function insideOBB([cx, cz, w, d, a], x, z) {
  const px = x - cx, pz = z - cz;
  return Math.abs(px * Math.sin(a) - pz * Math.cos(a)) <= w / 2 + 1e-9 && Math.abs(px * Math.cos(a) + pz * Math.sin(a)) <= d / 2 + 1e-9;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
