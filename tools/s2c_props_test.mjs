#!/usr/bin/env node
// Stage S2c: props as data (docs/map-v2-spec.md §0, §4.2, §5.6, §6.2, §11.1), headless.
//   node tools/s2c_props_test.mjs [-v]
// placeProps is rerun on the v2 world's rasters as they stood when generate() called it (the rails and walls
// it stamps taken back off), with the same random stream: it must stamp SURF back to exactly what generate()
// left and give the same lamps, palms and trees the world holds. Then every kind of prop: where it stands,
// which way it faces, the advisory formula, gantries 150 m before every Loop T, one signal post per approach,
// the jumps' danger signs, billboards, furniture on the sidewalks, W-beam and Jersey rails blocking cars on
// the verge and the deck median only, abutment walls over the raised ground S2b reported (the invisible ramp
// beside the Rickenbacker at (1350,1372)), bollards, and beach props on the dry sand.
import * as D from '../src/map/mapdata.js';
import { KIND, KIND_MASK, FLAG, sampleGrid } from '../src/map/raster.js';
import { placeProps } from '../src/map/props.js';
import { mulberry32 } from '../src/util.js';
import * as W from '../src/world-v2.js';

let passed = 0, failed = 0;
const VERBOSE = process.argv.includes('-v');
const ok = (cond, msg) => { if (cond) { passed++; if (VERBOSE) console.log('  ok   ' + msg); } else { failed++; console.log('  FAIL ' + msg); } };
const PX = 16, SW = 2048, SH = 1792, SEED = 0x4b324d32;      // world-v2's seed: lots draw first, then props
const BLOCKS = FLAG.BLOCK_CAR | FLAG.BLOCK_FOOT;

W.generate();
const net = W.roads, final = W.grids.surf;
const kindOf = (surf, x, z) => { const i = Math.floor(x), j = Math.floor(z); return i < 0 || j < 0 || i >= SW || j >= SH ? KIND.WATER : surf[j * SW + i] & KIND_MASK; };
const bitsOf = (surf, x, z) => { const i = Math.floor(x), j = Math.floor(z); return i < 0 || j < 0 || i >= SW || j >= SH ? KIND.WATER | BLOCKS : surf[j * SW + i]; };

// the SURF placeProps saw: block flags off the verge (grass, sand, dirt) and the Loop's deck median
const before = final.slice();
for (let c = 0; c < before.length; c++) {
  const k = before[c] & KIND_MASK;
  if (k === KIND.GRASS || k === KIND.SAND || k === KIND.DIRT) before[c] &= ~BLOCKS;
  else if (k === KIND.DECK && before[c] & FLAG.NOPED) before[c] &= ~FLAG.BLOCK_CAR;
}
const surf = before.slice(), rng = mulberry32(SEED);
rng();                                       // placeBuildings' draw
const t0 = performance.now();
const P = placeProps(net, { ...W.grids, surf }, W.regions, rng);
const ms = performance.now() - t0;
const kinds = list => list.reduce((o, r) => ((o[r.kind] = (o[r.kind] || 0) + 1), o), {});

console.log('the same as generate()');
{
  let diff = 0;
  for (let c = 0; c < surf.length; c++) if (surf[c] !== final[c]) diff++;
  ok(diff === 0, `SURF after placeProps is the world's, bit for bit (${diff} cells differ; ${ms.toFixed(1)} ms warm)`);
  const same = (a, b, n) => a.length >= n && b.slice(0, n).every((p, i) => p.x === a[i].x && p.y === a[i].y);
  ok(same(W.lamps, P.lamps, P.lamps.length), `the world's first ${P.lamps.length} lamps are placeProps' own`);
  const palms = W.palms.slice(W.palms.length - P.palms.length), trees = W.trees.slice(W.trees.length - P.trees.length);
  ok(same(palms, P.palms, P.palms.length) && same(trees, P.trees, P.trees.length), `and its ${P.palms.length} palms and ${P.trees.length} trees`);
  const n = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, v.length]));
  ok(Object.keys(n).join() === 'lamps,palms,trees,signals,chevrons,gantries,dangerSigns,billboards,furniture,guardrails,fences,beachProps', `the §7 lists: ${JSON.stringify(n)}`);
  ok(Object.entries(P).every(([k, v]) => ['lamps', 'palms', 'trees'].includes(k) || v.every(r => typeof r.kind === 'string' && Number.isFinite(r.x) && Number.isFinite(r.y))), 'every other prop has a kind and a position (px)');
}

console.log('lamps, palms and trees');
{
  ok(P.lamps.length > 300 && P.lamps.every(l => { const k = kindOf(before, l.x / PX, l.y / PX); return k !== KIND.ROAD && k !== KIND.BUILD && k !== KIND.WATER; }), `${P.lamps.length} lamps, none on a carriageway, a building or water`);
  ok(P.lamps.some(l => l.path === 'beachwalk') && P.lamps.some(l => l.path === 'riverwalk'), 'the promenades are lit');
  const blvd = net.edges.filter(e => e.cls === 'blvd'), onMedian = P.palms.filter(p => blvd.some(e => net.nearest(p.x, p.y, { maxD: 0.6 * PX })?.edge === e.id));
  ok(onMedian.length > 80, `${onMedian.length} palms down the boulevard medians`);
  const od = P.palms.filter(p => p.x / PX > 1815 && p.x / PX < 1846 && p.y / PX > 840 && p.y / PX < 1150);
  ok(od.length >= 25 && od.every(p => kindOf(before, p.x / PX, p.y / PX) === KIND.GRASS), `${od.length} palms along Ocean Drive's Lummus Park side, on the grass`);
  const fill = D.COAST.macarthur_fill[0].poly, insidePoly = (pts, x, z) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, zi] = pts[i], [xj, zj] = pts[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; };
  ok(P.palms.filter(p => insidePoly(fill, p.x / PX, p.y / PX)).length >= 8, 'palms down the Loop\'s median on the MacArthur fill');
  const banyans = P.trees.filter(t => t.r >= 3.5 * PX);
  ok(banyans.length > 30 && banyans.every(t => t.x / PX >= 600 && t.x / PX <= 1000 && Math.abs(t.y / PX - 962) < 14), `${banyans.length} banyans along Coral Way, x 600-1000`);
  ok(P.palms.concat(P.trees).every(p => kindOf(before, p.x / PX, p.y / PX) !== KIND.BUILD && kindOf(before, p.x / PX, p.y / PX) !== KIND.WATER), 'no palm or tree in a building or the water');
}

console.log('signals');
{
  const cand = net.nodes.filter(N => N.signal), want = cand.reduce((n, N) => n + N.ends.filter(E => !(E.start && net.edges[E.e].oneway)).length, 0);
  ok(cand.length === D.SIGNALS.candidates.length && P.signals.length === want, `${P.signals.length} posts, one per approach at the ${cand.length} candidates`);
  let bad = 0;
  for (const s of P.signals) {
    const N = net.nodes[s.node], e = net.edges[s.edge], d = Math.hypot(s.x - N.x, s.y - N.y) / PX;
    const k = kindOf(before, s.x / PX, s.y / PX), toward = Math.cos(s.a) * (N.x - s.x) + Math.sin(s.a) * (N.y - s.y);
    if (d > 40 || k === KIND.ROAD || k === KIND.BUILD || !N.ends.some(E => E.e === e.id) || toward > 0) bad++;
  }
  ok(bad === 0, `each stands beside its approach at the stop line, off the carriageway, facing the drivers (${bad} not)`);
}

console.log('chevrons and advisory speeds (§0)');
{
  const adv = P.chevrons.filter(c => c.kind === 'advisory'), chev = P.chevrons.filter(c => c.kind === 'chevron');
  ok(adv.length > 10 && chev.length > 30, `${adv.length} advisory signs, ${chev.length} chevrons`);
  ok(P.chevrons.every(c => c.kmh < 120 && c.kmh % 10 === 0 && c.kmh >= 30), `speeds under 120, whole tens: ${[...new Set(adv.map(c => c.kmh))].sort((a, b) => a - b).join(' ')} km/h`);
  const sw = adv.filter(c => net.edges[c.edge].road === 'switchbacks');
  // a 7-point hairpin of R ≈ 12.3 m: sqrt(2.0 · 9.81 · 12.3) = 15.5 m/s = 55.9 km/h -> 50
  ok(sw.length >= 8 && sw.some(c => c.kmh === 50) && sw.every(c => c.kmh <= 80), `the switchbacks' hairpins at 50 km/h: ${sw.map(c => c.kmh).join(' ')}`);
  ok(!P.chevrons.some(c => net.edges[c.edge].road === 'loop'), 'none on the Loop (R ≥ 105 m reads over 120 km/h)');
  ok(P.chevrons.every(c => { const k = kindOf(before, c.x / PX, c.y / PX); return k !== KIND.ROAD && k !== KIND.WATER && k !== KIND.BUILD; }), 'all off the carriageway');
}

console.log('gantries');
{
  const ts = net.nodes.filter(N => N.ends.length >= 3 && N.ends.some(E => net.edges[E.e].road === 'loop') && N.ends.some(E => net.edges[E.e].road !== 'loop'));
  ok(ts.length === 21 && P.gantries.length === 42, `${P.gantries.length} gantries: one over each carriageway before each of the ${ts.length} Loop T's`);
  let bad = 0;
  for (const g of P.gantries) {
    const N = net.nodes[g.node], d = Math.hypot(g.x - N.x, g.y - N.y) / PX, b = bitsOf(before, g.x / PX, g.y / PX);
    const ahead = Math.cos(g.a) * (N.x - g.x) + Math.sin(g.a) * (N.y - g.y);
    if (d > 211 || d < 110 || !(b & FLAG.NOPED) || b & FLAG.JCT || ahead <= 0 || !(g.w > 8)) bad++;
  }
  ok(bad === 0, `each over the Loop's carriageway (NOPED, clear of junction boxes), 150 m before its T (up to 60 m more to clear a junction) and facing it (${bad} not)`);
  ok(P.gantries.filter(g => g.exit === 'switchbacks').length === 2 && P.gantries.every(g => g.side === 'L' || g.side === 'R'), 'they name the road that leaves and its side');
}

console.log('danger signs and billboards');
{
  const jumps = P.dangerSigns.filter(s => s.kind === 'jump');
  ok(jumps.length === D.ACTIVITIES.jumps.length && D.ACTIVITIES.jumps.every(J => jumps.some(s => s.id === J.id && Math.hypot(s.x / PX - J.x, s.y / PX - J.z) < 50)), `a sign before each of the ${jumps.length} jumps`);
  ok(P.dangerSigns.some(s => s.kind === 'gator'), 'a gator sign by the lagoon');
  ok(P.billboards.length >= 6 && P.billboards.some(b => b.water) && P.billboards.some(b => !b.water), `${P.billboards.length} billboards, on the Runway Straight and over the causeways`);
  ok(P.billboards.every(b => b.water ? kindOf(before, b.x / PX, b.y / PX) === KIND.WATER : [KIND.GRASS, KIND.SAND, KIND.DIRT].includes(kindOf(before, b.x / PX, b.y / PX))), 'on piles in the water or on the verge');
}

console.log('furniture');
{
  const k = kinds(P.furniture);
  ok(k.bench > 50 && k.bin > 50 && k.hydrant > 50 && k.planter > 10 && k.busStop > 3, `furniture ${JSON.stringify(k)}`);
  ok(P.furniture.every(f => [KIND.WALK, KIND.PLAZA].includes(kindOf(before, f.x / PX, f.y / PX))), 'all of it on sidewalks (planters on Lincoln Road)');
}

console.log('rails and barriers (§6.2: BLOCK_CAR, 2 m thick)');
{
  let changed = 0, wrong = 0;
  for (let c = 0; c < final.length; c++) {
    if (final[c] === before[c]) continue;
    changed++;
    const k = final[c] & KIND_MASK;
    if (!(k === KIND.GRASS || k === KIND.SAND || k === KIND.DIRT || (k === KIND.DECK && final[c] & FLAG.NOPED))) wrong++;
  }
  ok(changed > 0 && wrong === 0, `${changed} cells blocked, all verge or the Loop's deck median (${wrong} elsewhere)`);
  const wb = P.guardrails.filter(r => r.kind === 'wbeam'), je = P.guardrails.filter(r => r.kind === 'jersey');
  ok(wb.length > 0 && wb.every(r => ['country', 'switch'].includes(net.edges[r.edge].cls)), `${wb.length} W-beam runs, on country and switchback roads only`);
  let unblocked = 0, n = 0;
  for (const r of wb) for (let i = 0; i < r.pts.length; i += 2) {
    const k = kindOf(final, r.pts[i] / PX, r.pts[i + 1] / PX);
    if (k !== KIND.GRASS && k !== KIND.SAND && k !== KIND.DIRT) continue;
    n++;
    if (!(bitsOf(final, r.pts[i] / PX, r.pts[i + 1] / PX) & FLAG.BLOCK_CAR)) unblocked++;
  }
  ok(n > 50 && unblocked === 0, `the rail line blocks cars on its verge cells (${unblocked}/${n} open)`);
  ok(je.length >= 3 && je.every(r => net.edges[r.edge].road === 'loop'), `${je.length} Jersey barrier runs down the Loop's decks`);
  const e = net.edges.find(q => q.road === 'loop' && q.deck.length > 0 && q.deck.some(([a, b]) => b - a > 300 * PX)), [a, b] = e.deck.find(([a, b]) => b - a > 300 * PX), k = e.n >> 1;
  void a; void b;
  const mid = { x: e.x[k] / PX, z: e.y[k] / PX }, lane = 3.3;
  ok(bitsOf(final, mid.x, mid.z) & FLAG.BLOCK_CAR && !(bitsOf(final, mid.x - e.ty[k] * lane, mid.z + e.tx[k] * lane) & FLAG.BLOCK_CAR) && !(bitsOf(final, mid.x + e.ty[k] * lane, mid.z - e.tx[k] * lane) & FLAG.BLOCK_CAR),
    'on the North Causeway the median blocks, both inner lanes stay open');
  ok(W.wallNormalPx((mid.x - e.ty[k] * 1.6) * PX, (mid.z + e.tx[k] * 1.6) * PX, {}) !== null, 'and a car beside the barrier finds its wall normal');
}

console.log('abutments and bollards');
{
  const walls = P.fences.filter(f => f.kind === 'abutment');
  ok(walls.length > 10 && walls.every(f => f.top > f.base && f.w > 0 && f.d > 0), `${walls.length} abutment walls`);
  ok(bitsOf(final, 1350.5, 1372.5) & FLAG.BLOCK_FOOT, 'the raised beach beside the Rickenbacker abutment at (1350,1372) is walled off');
  // nothing people stand on beside a deck end is left more than RAISED over the visible ground
  const G = W.grids.ground, T = W.grids.terrain;
  let ramps = 0;
  for (const w of walls) {
    const r = Math.hypot(w.w, w.d) / 2 + 2;
    for (let j = Math.floor(w.y / PX - r); j <= w.y / PX + r; j++) for (let i = Math.floor(w.x / PX - r); i <= w.x / PX + r; i++) {
      const b = final[j * SW + i], k = b & KIND_MASK;
      if ((k !== KIND.GRASS && k !== KIND.SAND && k !== KIND.DIRT) || b & FLAG.BLOCK_FOOT) continue;
      const v = (j >> 1) * 1025 + (i >> 1);
      if (Math.max(G[v] - T[v], G[v + 1] - T[v + 1], G[v + 1025] - T[v + 1025], G[v + 1026] - T[v + 1026]) > 0.5) ramps++;
    }
  }
  ok(ramps === 0, `no open verge cell round them stands on raised ground (${ramps})`);
  ok(P.fences.filter(f => f.kind === 'bollards').map(f => f.path).sort().join() === 'cove_stairs,glades_boardwalk', 'bollard rows on the boardwalk and the top of the Cove Stairs');
}

console.log('beaches');
{
  const k = kinds(P.beachProps);
  ok(k.lifeguard > 10 && k.umbrella > 50 && k.towel > 50, `beach props ${JSON.stringify(k)}`);
  const g = { w: 1025, h: 897, cell: 2, o: 0, data: W.grids.ground };
  ok(P.beachProps.every(p => kindOf(before, p.x / PX, p.y / PX) === KIND.SAND || p.kind === 'towel'), 'umbrellas and towers on the sand');
  ok(P.beachProps.filter(p => p.kind !== 'towel').every(p => sampleGrid(g, p.x / PX, p.y / PX) > D.SEA_LEVEL + 0.3), 'above the waterline');
  const deco = P.beachProps.filter(p => p.x / PX > 1840 && p.y / PX > 840 && p.y / PX < 1250).length, glades = P.beachProps.filter(p => p.x / PX < 120 && p.y / PX > 600 && p.y / PX < 1290).length;
  ok(deco > glades, `South Beach is busier than the Glades shore (${deco} props vs ${glades})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
