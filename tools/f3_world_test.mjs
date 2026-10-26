#!/usr/bin/env node
// Stage F3 (world data), headless:   node tools/f3_world_test.mjs [-v]
// What the v2 world now hands the renderers and the game, on generate()'s own output:
//   1. props: every placeProps list reaches the world (lamps, palms and trees in their containers, the other
//      nine in deco, each record tagged with its list), in the shapes world-v2.js documents (px positions on the
//      map, Float32Array px polylines, metre sizes);
//   2. sidewalks: no metre of a sidewalk path (crosswalks apart) on a carriageway, and every lane and junction
//      connector on one;
//   3. place.approach: the px polyline from a traffic lane to every place's curb, drivable, paved where the
//      curb is more than 12 m from a lane (a LOT driveway), the marina, jet and villa reached;
//   4. Kimchi Tower a full building, linked from its landmark;
//   5. the villa terrace's vista: Seoul Circle (SL3 K-Town), K-Town's rooftops and the open bay seen from the
//      foot spawn at a 1.5 m eye, and the Heights Gate junction lowered with it;
//   6. j_crest on Crest Road's straight, with the road straight for 60 m past its lip.
// Exits 1 if any check fails.
import * as D from '../src/map/mapdata.js';
import { KIND, KIND_MASK, FLAG } from '../src/map/raster.js';
import * as W from '../src/world-v2.js';

let passed = 0, failed = 0;
const VERBOSE = process.argv.includes('-v');
const ok = (cond, msg) => { if (cond) { passed++; if (VERBOSE) console.log('  ok   ' + msg); } else { failed++; console.log('  FAIL ' + msg); } };
const info = msg => console.log('  ' + msg);
const PX = 16, fin = Number.isFinite;
const rep = W.generate();
const net = W.roads, onMap = (x, y) => fin(x) && fin(y) && x >= 0 && y >= 0 && x <= W.BOUNDS.x1 && y <= W.BOUNDS.y1;

console.log('1. props reach the renderers');
{
  const LISTS = ['signals', 'chevrons', 'gantries', 'dangerSigns', 'billboards', 'furniture', 'guardrails', 'fences', 'beachProps'];
  const by = {};
  for (const d of W.deco) (by[d.list] ||= []).push(d);
  ok(W.deco.every(d => typeof d.kind === 'string' && typeof d.list === 'string' && onMap(d.x, d.y)), `every deco record has a kind, a list and a px position on the map (${W.deco.length})`);
  for (const L of LISTS) ok(by[L]?.length > 0, `deco carries placeProps' ${L} (${by[L]?.length || 0})`);
  ok(by.prefab?.some(d => d.kind === 'fountain') && by.prefab.some(d => d.kind === 'kiosk'), `and the prefabs' own (${by.prefab?.length || 0}: the park fountain, the event board kiosk, ...)`);
  ok(Object.keys(by).every(k => k === 'prefab' || LISTS.includes(k)), `no other lists: ${Object.keys(by).join(', ')}`);
  const kinds = L => [...new Set((by[L] || []).map(d => d.kind))].sort().join(',');
  ok(kinds('signals') === 'signal' && by.signals.every(d => net.nodes[d.node]?.signal && fin(d.a) && net.edges[d.edge]), `signals: one post per approach to a signal node, with its node and edge (${kinds('signals')})`);
  ok(kinds('chevrons') === 'advisory,chevron' && by.chevrons.every(d => d.kmh > 0 && d.kmh < 120 && d.kmh % 10 === 0), `chevrons and advisory signs at 10 km/h steps under 120 (${kinds('chevrons')})`);
  ok(by.gantries.every(d => d.kind === 'gantry' && d.w > 5 && d.w < 12 && typeof d.exit === 'string' && 'LR'.includes(d.side)), `gantries over a Loop carriageway: w in metres, the exit road and side (${by.gantries.length})`);
  ok(by.dangerSigns.filter(d => d.kind === 'jump').length === D.ACTIVITIES.jumps.length && by.dangerSigns.some(d => d.kind === 'gator'), `danger signs: one per jump and the gator sign (${kinds('dangerSigns')})`);
  ok(by.billboards.every(d => d.w === 12 && d.h === 4 && d.pole === 7 && typeof d.water === 'boolean' && d.art >= 0 && d.art < 8), 'billboards: 12 × 4 m faces on 7 m poles (metres), art 0-7');
  ok(kinds('furniture') === 'bench,bin,busStop,hydrant,planter', `furniture kinds (${kinds('furniture')})`);
  const rails = by.guardrails;
  ok(rails.every(d => (d.kind === 'wbeam' || d.kind === 'jersey') && d.pts instanceof Float32Array && d.pts.length >= 4 && d.pts.length % 2 === 0 && onMap(d.pts[0], d.pts[1]) && Math.abs(d.x - d.pts[0]) < 0.01),
    `guardrails: W-beam and Jersey polylines as Float32Array px (${rails.filter(d => d.kind === 'wbeam').length} W-beam, ${rails.filter(d => d.kind === 'jersey').length} Jersey)`);
  const abut = by.fences.filter(d => d.kind === 'abutment'), boll = by.fences.filter(d => d.kind === 'bollards');
  ok(abut.length > 0 && abut.every(d => d.w > 0 && d.w < 60 && d.d > 0 && d.d < 60 && d.top > d.base && fin(d.a)), `abutment walls: boxes in metres, top over base (${abut.length})`);
  ok(boll.length > 0 && boll.every(d => d.pts instanceof Float32Array && d.pts.length % 2 === 0 && onMap(d.pts[0], d.pts[1])), `bollard rows: post positions as Float32Array px (${boll.length})`);
  ok(kinds('beachProps') === 'lifeguard,towel,umbrella' && by.beachProps.every(d => /^#[0-9a-f]{6}$/i.test(d.color)), `beach props with their colours (${kinds('beachProps')})`);
  ok(W.lamps.length > 300 && W.palms.length > 200 && W.trees.length > 100, `lamps ${W.lamps.length}, palms ${W.palms.length}, trees ${W.trees.length}`);
}

console.log('2. sidewalks and lanes');
{
  let walk = 0, onRoad = 0, lane = 0, offRoad = 0;
  for (const p of net.walks.paths) {
    if (p.cross) continue;
    for (let k = 0; k + 1 < p.n; k++) {
      const L = Math.hypot(p.pts[2 * k + 2] - p.pts[2 * k], p.pts[2 * k + 3] - p.pts[2 * k + 1]);
      for (let t = 0; t < L; t += PX / 2) {
        const x = p.pts[2 * k] + (p.pts[2 * k + 2] - p.pts[2 * k]) * t / L, y = p.pts[2 * k + 1] + (p.pts[2 * k + 3] - p.pts[2 * k + 1]) * t / L, s = W.surfaceAt(x, y);
        walk++;
        if (s === W.ROAD || s === W.DECK || s === W.DIRT) onRoad++;
      }
    }
  }
  ok(onRoad === 0, `no sidewalk path sample on a carriageway (${onRoad} of ${walk} half-metre samples; integration measured 0.43%)`);
  const scan = L => {
    for (let i = 0; i + 1 < L.n; i++) {
      const d = Math.hypot(L.x[i + 1] - L.x[i], L.y[i + 1] - L.y[i]);
      for (let t = 0; t < d; t += PX) {
        const s = W.surfaceAt(L.x[i] + (L.x[i + 1] - L.x[i]) * t / d, L.y[i] + (L.y[i + 1] - L.y[i]) * t / d);
        lane++;
        if (s !== W.ROAD && s !== W.DECK && s !== W.DIRT) offRoad++;
      }
    }
  };
  for (const L of net.lanes) if (net.edges[L.edge].ai) scan(L);
  for (const c of net.conns) scan(c);
  ok(offRoad <= 4, `traffic lanes and junction connectors stay on the carriageway (${offRoad} of ${lane} metres off it)`);
  // the junction mouths that used to pave over the far sidewalk: Seoul Ave on the ring, Deco Ave on 71st St
  const kindAt = (x, z) => W.surfaceAt(x * PX, z * PX);
  ok(kindAt(870, 522.5) !== W.ROAD && kindAt(1745, 414.5) !== W.ROAD && kindAt(1227.5, 969.5) !== W.ROAD, 'the ring\'s inner sidewalk at Seoul Ave, 71st St\'s far side at Deco Ave and Biscayne\'s outer corner are pavement, not road');
}

console.log('3. place.approach');
{
  const laneDist = (x, y) => {
    let best = Infinity;
    net.edgesNear(x, y, 80 * PX, e => {
      if (!e.ai || e.cls === 'hwy') return;
      for (const id of [...e.fwd, ...e.bwd]) {
        const L = net.lanes[id];
        for (let i = 0; i + 1 < L.n; i++) {
          const dx = L.x[i + 1] - L.x[i], dy = L.y[i + 1] - L.y[i], l2 = dx * dx + dy * dy, t = l2 > 0 ? Math.max(0, Math.min(1, ((x - L.x[i]) * dx + (y - L.y[i]) * dy) / l2)) : 0;
          best = Math.min(best, Math.hypot(x - L.x[i] - dx * t, y - L.y[i] - dy * t) / PX);
        }
      }
    });
    return best;
  };
  const far = [];
  for (const [key, pl] of Object.entries(W.places)) {
    const a = pl.approach;
    ok(a && a.pts instanceof Float32Array && a.n >= 2 && a.pts.length === 2 * a.n && fin(a.len) && fin(a.s) && net.lanes[a.lane] && net.edges[a.edge] && typeof a.road === 'string',
      `${key}.approach {pts: Float32Array px, n, len, lane, s, edge, road}`);
    if (!a) continue;
    const end = [a.pts[2 * a.n - 2], a.pts[2 * a.n - 1]], ln = net.lanes[a.lane];
    ok(Math.hypot(end[0] - pl.curb.x, end[1] - pl.curb.y) < 1 && ln.edge === a.edge && net.edges[a.edge].road === a.road && a.s >= 0 && a.s <= ln.len + 1, `${key}.approach runs from lane ${a.lane} (${a.road}) to the curb`);
    let blocked = 0, open = 0, len = 0;
    for (let q = 0; q + 1 < a.n; q++) {
      const L = Math.hypot(a.pts[2 * q + 2] - a.pts[2 * q], a.pts[2 * q + 3] - a.pts[2 * q + 1]);
      len += L;
      for (let t = 0; t <= L; t += PX / 2) {
        const x = a.pts[2 * q] + (a.pts[2 * q + 2] - a.pts[2 * q]) * t / L, y = a.pts[2 * q + 1] + (a.pts[2 * q + 3] - a.pts[2 * q + 1]) * t / L, s = W.surfaceAt(x, y);
        if (W.blockedCarPx(x, y) || s === W.WATER || s === W.SHALLOW) blocked++;
        if (s === W.GRASS || s === W.SAND) open++;
      }
    }
    const d = laneDist(pl.curb.x, pl.curb.y);
    ok(blocked === 0 && Math.abs(len - a.len) < 1, `${key}.approach is drivable all the way (${blocked} blocked samples, ${(a.len / PX).toFixed(1)} m)`);
    if (d > 12) { far.push(`${key} ${d === Infinity ? '> 80' : d.toFixed(1)} m`); ok(open === 0, `${key}: its curb is ${d === Infinity ? 'over 80' : d.toFixed(1)} m from a lane, and the drive to it is paved (${open} samples of open ground)`); }
  }
  info(`curbs more than 12 m from a lane: ${far.join(', ')}`);
  ok(['marina', 'jet', 'home'].every(k => far.some(f => f.startsWith(k))) && W.places.home.approach.road !== 'villa_dr', 'the marina, the jet and the villa are among them; the villa is reached from a public lane');
  // the marina's driveway: from South Pointe Drive's end to the yacht club's yard, LOT where it was grass
  const a = W.places.marina.approach;
  let lot = 0;
  for (let q = 0; q + 1 < a.n; q++) for (let t = 0; t <= 1; t += 0.05) {
    const x = a.pts[2 * q] + (a.pts[2 * q + 2] - a.pts[2 * q]) * t, y = a.pts[2 * q + 1] + (a.pts[2 * q + 3] - a.pts[2 * q + 1]) * t;
    if (W.surfaceAt(x, y) === W.LOT) lot++;
  }
  ok(lot > 0, `the marina's drive crosses its new LOT driveway by South Pointe Drive (${lot} samples)`);
}

console.log('4. Kimchi Tower');
{
  const L = W.landmarks.find(l => l.id === 'kimchi_tower'), b = W.buildings[L?.building];
  ok(b && b.landmark === 'kimchi_tower' && b.kind === 'landmark' && b.h === 140 && b.w === 32 && b.d === 32, `the tower is buildings[${L?.building}] (kind landmark, 32 × 32 × 140 m) and its landmark links it`);
  ok(W.buildings.filter(q => q.landmark === 'kimchi_tower').length === 1 && W.buildings.length <= 450, `one tower record, ${W.buildings.length} buildings`);
  ok(b && W.deliveryDoors.some(d => d.b === b) && !W.blockedFootPx(b.door.x, b.door.y) && !W.blockedCarPx(b.curb.x, b.curb.y), 'it takes deliveries at a door and curb on Kimchi Plaza');
  ok(D.SIGHT_TARGETS.kimchi_tower.r >= 23, `its sightline target stops ${D.SIGHT_TARGETS.kimchi_tower.r} m short, past its corners (22.6 m)`);
}

console.log('5. the villa terrace vista');
{
  const f = W.places.home.foot, h0 = W.groundY(f.x, f.y) + 1.5;
  const sees = (x, z, h) => W.sightClear(f.x, f.y, h0, x * PX, z * PX, W.groundY(x * PX, z * PX) + h);
  const T = D.SIGHT_TARGETS.ktown;
  ok(Math.abs(h0 - 58 - 0.16 - 1.5) < 0.05, `the eye stands 1.5 m over the 58 m terrace (${h0.toFixed(2)} m)`);
  ok(sees(T.x, T.z, T.h / 2), 'SL3: Seoul Circle at K-Town\'s mid-height');
  // K-Town's rooftops (a metre over each roof, so a building does not hide its own roof): the terrace looks
  // down on the district; before F3 the hill hid all of them
  const kt = W.buildings.filter(b => b.region === 'ktown'), roofs = kt.filter(b => W.sightClear(f.x, f.y, h0, b.cx * PX, b.cz * PX, b.base + b.h + 1));
  ok(roofs.length >= 0.4 * kt.length, `K-Town rooftops seen from the terrace: ${roofs.length} of ${kt.length}`);
  // the bay north of Bayfront Park, a metre over the water (mapdata SIGHT_TARGETS.bay)
  const B = D.SIGHT_TARGETS.bay;
  ok(W.surfaceAt(B.x * PX, B.z * PX) === W.WATER && W.sightClear(f.x, f.y, h0, B.x * PX, B.z * PX, B.y), `the open bay at (${B.x},${B.z}), ${B.y - D.SEA_LEVEL} m over the water, is in view`);
  const gate = net.nodes.find(n => Math.hypot(n.x / PX - 385, n.y / PX - 292) < 3);
  ok(gate && Math.abs(gate.gy - 53.5) < 0.05, `the Heights Gate junction stands at 53.5 m, under the sight line (${gate?.gy.toFixed(2)})`);
  ok(Math.abs(W.groundY(W.places.home.garage[0].x, W.places.home.garage[0].y) - 58.04) < 0.1, 'the garage court keeps the 58 m pad');
}

console.log('6. j_crest');
{
  const J = W.activities.find(a => a.id === 'j_crest'), q = net.nearest(J.x, J.y, { maxD: 10 * PX }), e = q && net.edges[q.edge];
  ok(e?.road === 'crest_rd' && q.d < 0.5 * PX, `j_crest sits on Crest Road's centre line (${(q?.d / PX).toFixed(2)} m off)`);
  // the road keeps the jump's heading for 60 m past the lip (the landing at 45 m/s is about 51 m on)
  let worst = 0;
  for (let s = 0; s <= 60; s += 5) {
    const x = J.x + Math.cos(J.a) * s * PX, y = J.y + Math.sin(J.a) * s * PX, n = net.nearest(x, y, { maxD: 20 * PX });
    worst = Math.max(worst, n ? n.d / PX : Infinity);
  }
  ok(worst < 1.5, `Crest Road runs straight for 60 m past the lip (the straight line strays ${worst.toFixed(2)} m from it)`);
  ok(rep.issues.filter(i => !i.info).length === 0, `generate() reports no problems (${rep.issues.filter(i => !i.info).map(i => i.type).join(', ') || 'none'})`);
  info(`generate ${rep.timing.total} ms (driveways ${rep.timing.driveways} ms, sidewalks ${rep.timing.surfWalks} ms)`);
}

console.log(`\nf3 world: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
