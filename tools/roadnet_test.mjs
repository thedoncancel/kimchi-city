#!/usr/bin/env node
// Stage S1a tests: the road graph core (docs/map-v2-spec.md §4.1, §4.3, §4.4, §6.3, §7). Runs in node:
//   node tools/roadnet_test.mjs        (add -v to list every Loop junction and road radius)
// It builds the classic 7x7 lattice and the Kimchi Key v2 roads of spec §4.3 (pasted below as a fixture,
// because src/map/mapdata.js lands in S2a) and checks what later stages rely on: the sampling rule, the
// junctions (21 Loop T's at their stations, no highway X, no unplanned crossing), radii, lanes,
// connectors, sidewalks, routing and the strong connectivity of the traffic lane graph.
// Exits 1 if any check fails.
import { sampleCurve, minRadius, nearestOnCurve, pointAt, offsetCurve, bezier, segX } from '../src/map/spline.js';
import { buildRoadNet } from '../src/map/roadnet.js';
import { latticeRoads } from '../src/map/gridroads.js';
import * as GRID from '../src/world-grid.js';

const VERBOSE = process.argv.includes('-v');
const PX = 16;
let fails = 0, passes = 0;
const ok = (cond, what, detail = '') => {
  if (cond) passes++;
  else { fails++; console.log(`  FAIL ${what}${detail ? ': ' + detail : ''}`); }
  return cond;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const section = name => console.log(`\n${name}`);

// ---------- fixture: spec §4.2 classes and §4.3 roads ----------

const V2_CLASSES = {
  hwy:     { lanes: 2, laneW: 3.6, median: 3.0, shoulder: 1.5, walk: 0,   halfW: 10.2, speed: 26, grade: 0.06, minR: 100, bank: 5, ai: true },
  blvd:    { lanes: 2, laneW: 3.3, median: 3.0, shoulder: 0,   walk: 3.5, halfW: 8.1,  speed: 16, grade: 0.06, minR: 60,  bank: 0, ai: true },
  ave:     { lanes: 1, laneW: 3.5, median: 0,   parking: 2.4,  walk: 3.0, halfW: 5.9,  speed: 12, grade: 0.08, minR: 40,  bank: 0, ai: true },
  street:  { lanes: 1, laneW: 3.5, median: 0,   shoulder: 0.5, walk: 2.5, halfW: 4.0,  speed: 10, grade: 0.10, minR: 12,  bank: 0, ai: true },
  coast:   { lanes: 1, laneW: 3.6, median: 0,   shoulder: 1.0, walk: 0,   halfW: 4.6,  speed: 16, grade: 0.08, minR: 40,  bank: 3, ai: true },
  country: { lanes: 1, laneW: 3.5, median: 0,   shoulder: 0.5, walk: 0,   halfW: 4.0,  speed: 14, grade: 0.12, minR: 30,  bank: 3, ai: true },
  switch:  { lanes: 1, laneW: 3.4, median: 0,   shoulder: 0.4, walk: 0,   halfW: 3.8,  speed: 8,  grade: 0.14, minR: 12,  bank: 0, ai: true },
  ring:    { lanes: 1, laneW: 5.0, median: 0,   shoulder: 0.5, walk: 3.0, halfW: 3.0,  speed: 7,  grade: 0.04, minR: 12,  bank: 0, ai: true, oneway: true },
  dirt:    { lanes: 1, laneW: 3.5, single: true, walk: 0, halfW: 3.5, speed: 8, grade: 0.18, minR: 12, bank: 0, ai: false },
  alley:   { lanes: 1, laneW: 3.0, single: true, walk: 0, halfW: 3.0, speed: 5, grade: 0.10, minR: 8,  bank: 0, ai: false },
};

// §4.3 verbatim (names shortened where the spec's parenthesis was a description; Collins/Ocean's 9 m/s
// comes from the §4.2 AI column).
const V2_ROADS = [
  {id:'loop',name:'Kimchi Loop',cls:'hwy',closed:true,y:[[0,2],[4,2],[12,2],[13,4.9],[14,7.9],[15,11.3],[16,14.8],[17,18.2],[18,21.1],[19,23.6],[20,26],[21,22.5],[22,18.7],[23,14.8],[24,11],[25,7.5],[26,4.5],[27,7.5],[28,10.9],[29,14],[30,11.8],[31,10.2],[32,8.5],[33,7.3],[34,6],[35,4.8],[36,3.6],[37,2.5],[38,2],[50,2],[52,3],[54,4],[55,3],[56,2.5],[57,3],[58,4],[59,3.5],[60,2.5],[61,2],[69,2]],pts:[[1075.8,1300],[980,1300],[900,1300],[700,1300],[520,1298],[400,1288],[318,1258],[258,1205],[225,1130],[214,1040],[213,940],[218,850],[238,765],[280,690],[345,628],[430,575],[515,515],[590,445],[650,385],[710,342],[780,322],[855,330],[935,352],[1015,374],[1095,388],[1170,388],[1235,374],[1300,352],[1370,332],[1440,318],[1480,312],[1510,310],[1540,310],[1565.4,312.5],[1589.7,319.9],[1612.2,331.9],[1631.9,348.1],[1648.1,367.8],[1660.1,390.3],[1667.5,414.6],[1670,440],[1670,470],[1670,560],[1670,700],[1670,850],[1670,970],[1670,1000],[1667.5,1025.4],[1660.1,1049.7],[1648.1,1072.2],[1631.9,1091.9],[1612.2,1108.1],[1589.7,1120.1],[1565.4,1127.5],[1540,1130],[1510,1130.5],[1440,1134],[1365,1137],[1335,1138],[1308.3,1140.6],[1282.6,1148.2],[1258.8,1160.6],[1237.7,1177.3],[1220.3,1197.7],[1205.4,1219],[1190.5,1240.3],[1173.1,1260.7],[1152,1277.4],[1128.2,1289.8],[1102.5,1297.4]]},
  {id:'switchbacks',name:'Coral Heights Switchbacks',cls:'switch',y:[[0,56],[4,51],[10,49],[14,41.5],[20,39.5],[24,32],[30,30],[34,22.5],[40,20.5],[45,9.5]],pts:[[385,292],[378,312],[362,326],[330,333],[295,334],[287,336.1],[281.1,342],[279,350],[281.1,358],[287,363.9],[295,366],[330,370],[380,378],[418,382],[435,382],[443,384.1],[448.9,390],[451,398],[448.9,406],[443,411.9],[435,414],[400,418],[350,426],[312,431],[295,431],[287,433.1],[281.1,439],[279,447],[281.1,455],[287,460.9],[295,463],[335,467],[385,474],[423,479],[440,479],[448,481.1],[453.9,487],[456,495],[453.9,503],[448,508.9],[440,511],[415,512],[392,520],[377,540],[376,565],[384,590]]},
  {id:'heights_dr',name:'Heights Drive',cls:'country',y:[[0,56],[1,52.6],[2,47.7],[3,41.7],[4,36.1],[5,30.6],[6,25]],pts:[[385,292],[420,287],[470,290],[530,302],[585,318],[640,330],[697,339]]},
  {id:'crest_rd',name:'Crest Road',cls:'country',y:[[0,25.5],[3,30],[6,36],[9,32],[12,18],[15,7.5]],pts:[[806,312],[815,288],[838,268],[855,244],[858,220],[865,196],[882,178],[915,168],[952,178],[985,202],[1015,232],[1052,248],[1090,262],[1120,292],[1140,332],[1150,377]]},
  {id:'villa_dr',name:'Villa Drive',cls:'street',y:[[0,56],[2,58]],ai:false,pts:[[385,292],[372,280],[362,262],[357,256]]},
  {id:'seoul_ave',name:'Seoul Avenue',cls:'ave',pts:[[870,346],[870,470],[870,518]]},
  {id:'ring',name:'Seoul Circle',cls:'ring',closed:true,oneway:true,pts:[[912,560],[908.8,543.9],[899.7,530.3],[886.1,521.2],[870,518],[853.9,521.2],[840.3,530.3],[831.2,543.9],[828,560],[831.2,576.1],[840.3,589.7],[853.9,598.8],[870,602],[886.1,598.8],[899.7,589.7],[908.8,576.1]]},
  {id:'han_ro',name:'Han-ro / Flagler St',cls:'street',pts:[[912,560],[1000,560],[1115,560],[1232,560]]},
  {id:'myeong',name:'Myeong-dong / Ponce',cls:'street',pts:[[870,602],[870,707.6],[871,800],[873,880],[875,962]]},
  {id:'granada',name:'Itaewon-ro / Granada Blvd',cls:'ave',pts:[[828,560],[750,560],[718,590],[698,640],[684,700],[677,770],[676,860],[684,960],[712,1050],[742,1140],[735,1220],[705,1290]]},
  {id:'nw_crescent',cls:'street',pts:[[780,560],[786.9,525.6],[806.4,496.4],[835.6,476.9],[870,470]]},
  {id:'se_crescent',cls:'street',pts:[[1000,630],[974.4,664.4],[943.8,687.8],[908.2,702.6],[870,707.6]]},
  {id:'neon_alley',name:'Hongdae Neon Alley',cls:'alley',pts:[[840.3,530.3],[823.4,513.4],[806.4,496.4]]},
  {id:'miami_ave',cls:'ave',pts:[[1000,382],[1000,470],[1000,560],[1000,630],[1000,710],[1000,820],[1000,962],[1000,1052],[1002,1180],[1005,1288]]},
  {id:'st14',name:'14th St',cls:'street',pts:[[870,470],[1000,470],[1115,470],[1228,470]]},
  {id:'st6',name:'NE 6th St',cls:'street',pts:[[1000,710],[1115,710],[1239,710]]},
  {id:'st1',name:'SE 1st St',cls:'street',pts:[[1000,820],[1115,820],[1240,820]]},
  {id:'ne2nd',name:'NE 2nd Ave',cls:'street',pts:[[1115,470],[1115,560],[1115,710],[1115,820],[1115,962]]},
  {id:'biscayne',name:'Biscayne Blvd',cls:'blvd',pts:[[1225,389],[1228,470],[1232,560],[1239,710],[1240,820],[1236,900],[1230,962]]},
  {id:'coral_way',name:'Coral Way',cls:'ave',pts:[[226,975],[300,970],[420,966],[508,963],[600,962],[684,960],[780,961],[875,962],[1000,962],[1115,962],[1230,962]]},
  {id:'alhambra',name:'Alhambra Circle',cls:'street',pts:[[678,810],[725,822],[772,850],[800,898],[795,940],[782,962]]},
  {id:'sevilla',name:'Sevilla Ave',cls:'street',pts:[[712,1050],[850,1052],[1000,1052]]},
  {id:'venetian',name:'Venetian Causeway',cls:'coast',pts:[[1239,710],[1300,706],[1340,703],[1400,702],[1440,701],[1500,700],[1540,700],[1600,700],[1659,700]]},
  {id:'st71',cls:'street',pts:[[1677,420],[1745,420],[1815,421]]},
  {id:'collins_ocean',name:'Collins Ave / Ocean Drive',cls:'ave',speed:9,pts:[[1815,320],[1815,421],[1814,560],[1813,700],[1813,840],[1812,960],[1811,1085],[1810,1150]]},
  {id:'deco_ave',name:'Deco Avenue',cls:'blvd',pts:[[1745,420],[1745,560],[1745,700],[1745,840],[1745,960],[1745,1085],[1745,1238]]},
  {id:'st41',cls:'street',pts:[[1681,560],[1745,560],[1814,560]]},
  {id:'lincoln',name:'Lincoln Road',cls:'street',pts:[[1680,840],[1745,840],[1813,840]]},
  {id:'st15',cls:'street',pts:[[1682,960],[1745,960],[1812,960]]},
  {id:'st5',name:'5th St',cls:'street',pts:[[1652,1087],[1745,1085],[1811,1085]]},
  {id:'south_pointe',cls:'street',pts:[[1810,1150],[1798,1205],[1765,1236],[1745,1238],[1706,1230],[1700,1215]]},
  {id:'star_spur',cls:'street',pts:[[1440,1122],[1440,1090]]},
  {id:'star_ring',cls:'street',closed:true,pts:[[1440,1090],[1482.4,1078.3],[1500,1050],[1482.4,1021.7],[1440,1010],[1397.6,1021.7],[1380,1050],[1397.6,1078.3]]},
  {id:'port_blvd',cls:'ave',pts:[[1115,962],[1112,1040],[1110,1095]]},
  {id:'port_yard',name:'Port Yard',cls:'street',closed:true,pts:[[1075,1115],[1110,1095],[1160,1093],[1193,1113],[1190,1145],[1150,1160],[1100,1156],[1076,1140]]},
  {id:'rickenbacker',cls:'coast',y:[[0,2],[2,8],[4,2]],pts:[[1215,1226],[1250,1260],[1290,1300],[1330,1340],[1368,1385]]},
  {id:'key_loop',name:'A1A Key Loop',cls:'coast',closed:true,minR:30,pts:[[1380,1395],[1440,1373],[1520,1366],[1600,1374],[1660,1400],[1695,1440],[1708,1490],[1690,1530],[1650,1548],[1580,1556],[1500,1553],[1430,1540],[1390,1508],[1370,1460]]},
  {id:'festival_way',cls:'blvd',pts:[[820,1313],[820,1340],[820,1365]]},
  {id:'fest_ring',name:'Fest Ring',cls:'street',closed:true,pts:[[700,1365],[820,1365],[940,1365],[962,1400],[940,1460],[820,1462],[700,1460],[680,1415]]},
  {id:'airport_rd',cls:'ave',pts:[[962,1400],[1000,1405],[1040,1410]]},
  {id:'airport_perim',cls:'street',pts:[[680,1415],[600,1440],[480,1462],[360,1475],[270,1490]]},
  {id:'a1a',name:'A1A Sunset Drive',cls:'coast',pts:[[226.8,760.7],[175,770],[120,795],[85,845],[68,930],[66,1020],[75,1100],[100,1165],[150,1205],[205,1218],[248.3,1212.1]]},
  {id:'gator_run',cls:'dirt',pts:[[300,968],[300,905],[322,845],[380,800],[450,795],[500,840],[512,905],[508,962]]},
  {id:'airboat_rd',cls:'dirt',pts:[[420,966],[425,1040],[440,1110],[462,1170]]},
];

// §4.4: station (m from (1075.8,1300) in travel order), the road whose end meets the Loop, and its side.
const LOOP_TS = [
  [70, 'miami_ave', 'R'], [256, 'festival_way', 'L'], [371, 'granada', 'R'], [844, 'a1a', 'L'], [1083, 'coral_way', 'R'],
  [1296, 'a1a', 'L'], [1525, 'switchbacks', 'L'], [1928, 'heights_dr', 'L'], [2036, 'crest_rd', 'L'], [2105, 'seoul_ave', 'R'],
  [2240, 'miami_ave', 'R'], [2389, 'crest_rd', 'L'], [2462, 'biscayne', 'R'], [2975, 'st71', 'L'], [3113, 'st41', 'L'],
  [3253, 'venetian', 'R'], [3394, 'lincoln', 'L'], [3513, 'st15', 'L'], [3639, 'st5', 'L'], [3857, 'star_spur', 'R'],
  [4123, 'rickenbacker', 'L'],
];
// §4.3 "Measured": length m, min radius m.
const MEASURED = {
  loop: [4283, 105.5], switchbacks: [867, 12.3], heights_dr: [318, 121], crest_rd: [532, 29.6], granada: [846, 42.7],
  nw_crescent: [141, 50.6], ring: [264, 38.9], alhambra: [228, 40], south_pointe: [199, 24.9], star_ring: [316, 17],
  port_yard: [314, 15.6], key_loop: [881, 30.7], fest_ring: [701, 26.1], a1a: [668, 78.7], gator_run: [466, 55.1],
  rickenbacker: [221, 371],
};
// Two roads were edited after the spec measured them: South Pointe's end moved from (1680,1205) to
// (1700,1215) and Villa Drive gained (357,256). The table is checked against the points as measured, and the
// edited South Pointe is reported (its tightest bend drops below the street minimum of 12 m).
const AS_MEASURED = {
  south_pointe: [[1810, 1150], [1798, 1205], [1765, 1236], [1745, 1238], [1706, 1230], [1680, 1205]],
  villa_dr: [[385, 292], [372, 280], [362, 262]],
};
const CLASS_TOTALS = { hwy: 4283, street: 5537, ave: 3970, coast: 2190, blvd: 1444, switch: 867, country: 850, dirt: 676, ring: 264, alley: 48 };
// §4.4 signal candidates (enabled in S6a only if the soak passes)
const SIGNALS = [[870, 470], [1000, 560], [1115, 560], [1115, 710], [1115, 820], [1000, 962], [1115, 962], [1239, 710], [684, 960],
  [1745, 560], [1745, 840], [1745, 960], [1745, 1085]];
const TIGHT = new Set(['switch', 'street', 'dirt', 'alley', 'ring']);

// ---------- helpers ----------

// Strongly connected components of the AI lane graph (lanes with keep(lane), joined by connectors and by
// lane changes on roads that allow them, spec §9), by Kosaraju (iterative).
function laneComponents(net, keep) {
  const ids = net.lanes.filter(keep).map(L => L.id), on = new Set(ids);
  const out = new Map(ids.map(i => [i, []])), inn = new Map(ids.map(i => [i, []]));
  const link = (a, b) => { if (on.has(a) && on.has(b)) { out.get(a).push(b); inn.get(b).push(a); } };
  for (const c of net.conns) link(c.from, c.to);
  for (const L of net.lanes) if (net.edges[L.edge].laneChange) for (const n of [L.left, L.right]) if (n >= 0) link(L.id, n);
  const order = [], seen = new Set();
  for (const s of ids) {
    if (seen.has(s)) continue;
    const st = [[s, 0]]; seen.add(s);
    while (st.length) {
      const top = st[st.length - 1], nb = out.get(top[0]);
      if (top[1] < nb.length) { const v = nb[top[1]++]; if (!seen.has(v)) { seen.add(v); st.push([v, 0]); } }
      else { order.push(top[0]); st.pop(); }
    }
  }
  const comp = new Map();
  let n = 0;
  for (let k = order.length - 1; k >= 0; k--) {
    const s = order[k];
    if (comp.has(s)) continue;
    const st = [s]; comp.set(s, n);
    while (st.length) for (const v of inn.get(st.pop())) if (!comp.has(v)) { comp.set(v, n); st.push(v); }
    n++;
  }
  return { count: n, size: ids.length, comp };
}

// Largest gap between a lane polyline and the line `off` px right of its edge centre line.
function laneOffsetError(net, L) {
  const e = net.edges[L.edge];
  let worst = 0;
  for (let i = 0; i < L.n; i++) {
    const s = L.es[i];
    let j = 0;
    while (j < e.n - 2 && e.s[j + 1] < s) j++;
    const f = (s - e.s[j]) / Math.max(1e-6, e.s[j + 1] - e.s[j]);
    const cx = e.x[j] + (e.x[j + 1] - e.x[j]) * f, cy = e.y[j] + (e.y[j + 1] - e.y[j]) * f;
    const ux = e.tx[j] + (e.tx[j + 1] - e.tx[j]) * f, uy = e.ty[j] + (e.ty[j + 1] - e.ty[j]) * f, ul = Math.hypot(ux, uy);
    const tx = ux / ul, ty = uy / ul;
    const lat = (L.x[i] - cx) * -ty + (L.y[i] - cy) * tx;
    worst = Math.max(worst, Math.abs(lat - L.off));
  }
  return worst;
}

// ---------- 1. the sampling rule ----------

section('spline (§4.1)');
{
  const line = sampleCurve([[0, 0], [100, 0]], { step: 1 });
  ok(near(line.len, 100, 1e-3), 'straight line length', line.len);
  ok(line.k.every(k => Math.abs(k) < 1e-9) && line.tx.every(t => near(t, 1, 1e-6)), 'straight line has k=0 and an east tangent');
  // a 16-point circle of radius 50, clockwise on the map (heading grows), so it turns right
  const ring = Array.from({ length: 16 }, (_, i) => [100 + 50 * Math.cos(i * Math.PI / 8), 100 + 50 * Math.sin(i * Math.PI / 8)]);
  const c = sampleCurve(ring, { closed: true, step: 1, chord: 3 });
  // centripetal CR through 16 points of a circle bends a little tighter at each point (the spec's ring,
  // r 42, measures 38.9), so the 3-point rule reads 46 for r 50
  ok(near(minRadius(c, 3).r, 46, 1), 'closed circle radius by the 3-point rule', minRadius(c, 3).r.toFixed(2));
  ok(c.k.every(k => k > 0), 'a clockwise circle has positive (right-turn) curvature');
  ok(near(c.len, 2 * Math.PI * 50, 2), 'circle length', c.len.toFixed(2));
  ok(nearestOnCurve(c, 100, 100).side === 1, 'the centre of a right-turning circle is on its right');
  const p = pointAt(c, c.len + 10, {}), q = pointAt(c, 10, {});
  ok(near(p.x, q.x, 1e-3) && near(p.z, q.z, 1e-3), 'pointAt wraps a closed curve');
  const o = offsetCurve(c, 5);
  ok(near(o.len, 2 * Math.PI * 45, 2), 'offset 5 m to the right shrinks a right-turning circle to r 45', o.len.toFixed(2));
  ok(near(sampleCurve(ring, { closed: true, step: 2, chord: 3 }).n, c.n / 2, 2), 'runtime curve samples every 2 m where |k| <= 1/40 (r 50)');
  const tight = ring.map(([x, z]) => [100 + (x - 100) * 0.6, 100 + (z - 100) * 0.6]);
  ok(sampleCurve(tight, { closed: true, step: 2, chord: 3 }).n === sampleCurve(tight, { closed: true, step: 1, chord: 3 }).n,
    'runtime curve keeps 1 m samples where |k| > 1/40 (r 30)');
  const bz = bezier([0, 0], [1, 0], [10, 10], [0, 1], 1);
  ok(near(bz.x[0], 0, 1e-6) && near(bz.x[bz.x.length - 1], 10, 1e-6) && near(bz.z[bz.z.length - 1], 10, 1e-6) && bz.len > 14.1,
    'bezier ends on its end points', bz.len.toFixed(2));
  const X = segX(0, 0, 10, 10, 0, 10, 10, 0);
  ok(X && near(X.x, 5, 1e-9) && near(X.t, 0.5, 1e-9), 'segX finds a crossing');
  ok(segX(0, 0, 1, 0, 0, 1, 1, 1) === null, 'segX ignores parallel segments');
}

// ---------- 2. the classic lattice ----------

section('lattice (gridroads + RoadNet)');
const lat = buildRoadNet(latticeRoads());
{
  const C = k => k * 896 + 64;
  ok(lat.nodes.length === 49, 'lattice has 49 nodes', lat.nodes.length);
  ok(lat.edges.length === 84, 'lattice has 84 edges', lat.edges.length);
  const kinds = {};
  for (const n of lat.nodes) kinds[n.kind] = (kinds[n.kind] || 0) + 1;
  ok(kinds.corner === 4 && kinds.T === 20 && kinds.X === 25, '4 corners, 20 T, 25 X', JSON.stringify(kinds));
  const onGrid = v => Array.from({ length: 7 }, (_, k) => C(k)).some(c => near(v, c, 0.01));
  ok(lat.nodes.every(n => onGrid(n.x) && onGrid(n.y)), 'nodes sit on roadCenter(k) = k*896+64');
  ok(lat.edges.every(e => near(e.len, 896, 0.5) && e.lanesF === 1 && e.lanesB === 1 && e.laneW === 64), 'edges 896 px long, 1+1 lanes 64 px wide');
  ok(lat.lanes.every(L => near(Math.abs(L.off), 32, 1e-6) && Math.sign(L.off) === L.dir), 'lanes at +-32 px (right of their own direction)');
  ok(Math.max(...lat.lanes.map(L => laneOffsetError(lat, L))) < 0.01, 'lane polylines follow their offset');
  ok(lat.nodes.filter(n => n.kind !== 'corner').every(n => n.control === 'allway'), 'equal streets meet as all-way junctions');
  ok(lat.issues.length === 0, 'no issues', JSON.stringify(lat.issues.slice(0, 3)));
  const scc = laneComponents(lat, L => lat.edges[L.edge].ai);
  ok(scc.count === 1 && scc.size === 168, 'AI lane graph strongly connected', `${scc.count} components of ${scc.size} lanes`);
  // turns: at an X every approach goes straight, left and right; through movements cross
  const X = lat.nodes.find(n => n.kind === 'X');
  const cx = lat.conns.filter(c => c.node === X.id);
  ok(cx.length === 12 && ['s', 'l', 'r'].every(t => cx.filter(c => c.turn === t).length === 4), 'an X has 4 straight, 4 left, 4 right connectors');
  const ss = cx.filter(c => c.turn === 's');
  const perp = ss.find(c => Math.abs(lat.lanes[c.from].dir) && lat.edges[lat.lanes[c.from].edge].road[0] !== lat.edges[lat.lanes[ss[0].from].edge].road[0]);
  ok(perp && ss[0].conflicts.includes(perp.id), 'crossing straight movements conflict');
  ok(cx.every(c => c.conflicts.every(id => lat.conns[id].node === X.id)), 'conflicts stay within their node');
  ok(lat.conns.every(c => near(c.x[0], lat.lanes[c.from].x[lat.lanes[c.from].n - 1], 0.01) && near(c.y[c.n - 1], lat.lanes[c.to].y[0], 0.01)),
    'connectors run from lane end to lane start');
  // a route corner to corner is the Manhattan distance
  const r = lat.route(C(0), C(0), C(6), C(6));
  ok(r && near(r.len, 12 * 896, 12 * 896 * 0.03), 'route corner to corner ~ Manhattan', r && r.len.toFixed(0));
  ok(r && near(r.pts[0], C(0), 0.01) && near(r.pts[r.pts.length - 1], C(6), 0.01), 'a route between junction centres starts and ends on them');
  ok(near(lat.routeLength(C(0) + 300, C(0), C(0) + 600, C(0)), 300, 2), 'routeLength along one edge', lat.routeLength(C(0) + 300, C(0), C(0) + 600, C(0)));
  // start and goal inside the same junction: both are its centre, and route and routeLength agree
  const same = lat.route(C(2) + 40, C(3) - 20, C(2) - 30, C(3) + 40);
  ok(same && same.len === 0 && lat.routeLength(C(2) + 40, C(3) - 20, C(2) - 30, C(3) + 40) === 0, 'a route within one junction has length 0 both ways',
    same && `${same.len} / ${lat.routeLength(C(2) + 40, C(3) - 20, C(2) - 30, C(3) + 40)}`);
  const back = lat.route(C(0) + 600, C(0), C(0) + 300, C(0));
  ok(back && near(back.len, 300, 2) && back.steps.length === 1, 'routing backwards along an edge uses the opposite lane');
  const nl = lat.nearestLane(C(1) + 400, C(2) + 20, 0);
  ok(nl && lat.lanes[nl.lane].dir === (lat.edges[lat.lanes[nl.lane].edge].tx[0] > 0 ? 1 : -1) && near(nl.y, C(2) + 32, 0.5),
    'nearestLane heading east picks the eastbound lane, 32 px south of the centre', nl && JSON.stringify({ y: nl.y }));
  const nr = lat.nearest(C(3) + 10, C(1) + 300);
  ok(nr && near(nr.d, 10, 0.01) && nr.side !== 0, 'nearest finds the closest edge', nr && nr.d);
  let inRing = 0;
  for (let i = 0; i < 50; i++) {
    const p = lat.randomLanePoint({ x: C(3), y: C(3), rMin: 1500, rMax: 3000 });
    if (p && near(Math.hypot(p.x - C(3), p.y - C(3)), 2250, 750)) inRing++;
  }
  ok(inRing === 50, 'randomLanePoint stays in its annulus', `${inRing}/50`);
  const nav = { pts: r.pts };
  const pt = lat.follow(nav, C(0) + 10, C(0) + 5, 200);
  ok(near(Math.hypot(pt[0] - C(0), pt[1] - C(0)), 200, 40) && nav.off < 40, 'follow returns the point 200 px ahead', pt.map(v => v.toFixed(0)).join(','));
  // sidewalks: block rings at 96 px from the road centre, crosswalks on every approach of every all-way node
  // that has a sidewalk on both sides: the 100 approaches of the 25 X's and the inland approach of each of
  // the 20 perimeter T's (a perimeter road has no outer sidewalk to cross to)
  const W = lat.walks;
  ok(W.paths.filter(p => p.cross).length === 120, 'crosswalks on the 120 junction approaches with a sidewalk each side', W.paths.filter(p => p.cross).length);
  const perim = lat.edges.filter(e => /^(ew|ns)[06]$/.test(e.road));
  ok(perim.length === 24 && perim.every(e => e.walkW === 64 && (e.walkL === 0) !== (e.walkR === 0)), 'perimeter edges have one 4 m sidewalk, on one side');
  ok(W.paths.filter(p => !p.cross && p.edge >= 0).every(p => p.side === (lat.edges[p.edge].walkR ? 1 : 0) || p.side === (lat.edges[p.edge].walkL ? -1 : 0)),
    'sidewalk paths only on sides that have one');
  ok(W.verts.every(v => v.paths.length >= 2), 'every sidewalk vertex joins at least two paths');
  const sw = W.paths.find(p => !p.cross && p.edge >= 0);
  const e0 = lat.edges[sw.edge];
  const midI = (sw.n >> 1) * 2, mx = sw.pts[midI], my = sw.pts[midI + 1];
  const pr = lat.nearest(mx, my);
  ok(pr && near(pr.d, 96, 0.5), 'sidewalks run 96 px (6 m) from the centre line', pr && pr.d.toFixed(2) + ' on ' + e0.road);
  const wk = lat.nearestWalk(C(2) + 300, C(2) + 90);
  ok(wk && near(wk.d, 6, 0.5), 'nearestWalk', wk && wk.d);
  const rw = lat.randomWalkPoint({ x: C(3), y: C(3), rMax: 2000 });
  ok(rw && Math.hypot(rw.x - C(3), rw.y - C(3)) <= 2000, 'randomWalkPoint');
}

section('world-grid generate()');
{
  GRID.generate();
  const R = GRID.roads, C = GRID.roadCenter;
  ok(R.nodes.length === 49 && R.edges.length === 84 && typeof R.route === 'function', 'world-grid fills roads in place with the lattice');
  const T = GRID.T, P = GRID.P;
  ok(GRID.anchors.bandanaYard.x === 8 * T && GRID.anchors.bandanaYard.y === (2 * P + 8) * T, 'bandanaYard = blockCenter(0,2)');
  ok(GRID.anchors.stolenCarLot.x === (4 * P + 8) * T && GRID.anchors.stolenCarLot.y === (3 * P + 8) * T && near(GRID.anchors.stolenCarLot.a, Math.PI / 2, 1e-9),
    'stolenCarLot = blockCenter(4,3), facing south');
  const rs = GRID.anchors.raceStart;
  ok(rs.x === C(4) - 220 && rs.y === C(3) + 32 && rs.a === 0, 'raceStart = RACE[0] + (-220, +32), facing east');
  const sk = GRID.routes.street_kings;
  const RACE = [[4, 3], [6, 3], [6, 6], [3, 6], [0, 6], [0, 3], [0, 0], [3, 0], [4, 2]];
  ok(sk && sk.gates.length === 9 && sk.gates.every((g, i) => g.x === C(RACE[i][0]) && g.y === C(RACE[i][1])), 'street_kings has the 9 RACE junctions as gates');
  ok(sk.gates.every(g => g.w === 192), 'gates are road width + 4 m wide (192 px)');
  ok(near(sk.gates[0].a, 0, 0.05), 'the first gate faces east, along the start straight', sk.gates[0].a.toFixed(3));
  ok(near(Math.abs(sk.gates[1].a), Math.PI / 4, 0.2), 'a corner gate faces diagonally (east then south)', sk.gates[1].a.toFixed(3));
  const lap = 220 + 2 * 896 + 7 * 3 * 896;   // the start straight, then 2 blocks and seven 3-block legs
  ok(sk.len > 0 && near(sk.len, lap, lap * 0.05), 'the course is the street distance between the gates', `${sk.len.toFixed(0)} vs ${lap}`);
  GRID.generate();
  ok(GRID.roads.nodes.length === 49, 'generate() stays idempotent');

  // every sidewalk lies on the map, on WALK tiles (crosswalks start and end on them), so peds placed on
  // the walk graph stand on pavement and never off the island
  const B = GRID.BOUNDS, onWalk = (x, y) => x >= B.x0 && y >= B.y0 && x < B.x1 && y < B.y1 && GRID.tileAtPx(x, y) === GRID.WALK;
  let off = 0, n = 0;
  for (const p of R.walks.paths) {
    if (p.cross) { n += 2; off += !onWalk(p.pts[0], p.pts[1]) + !onWalk(p.pts[2 * p.n - 2], p.pts[2 * p.n - 1]); continue; }
    for (let s = 0; s <= p.len; s += 8) { const q = R.walkPoint(p.id, s); n++; if (!onWalk(q.x, q.y)) off++; }
  }
  ok(off === 0, 'every grid sidewalk point is inside BOUNDS on a WALK tile', `${off} of ${n} off`);
  let seed = 7;
  const rng = () => {   // mulberry32, so the sample is the same every run
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let blocked = 0;
  for (let i = 0; i < 3000; i++) { const q = R.randomWalkPoint({ rng }); if (!q || GRID.blockedPx(q.x, q.y) || !onWalk(q.x, q.y)) blocked++; }
  ok(blocked === 0, 'randomWalkPoint never returns a blocked or off-map point', `${blocked}/3000`);
  const nw = R.nearestWalk(C(0) + 300, C(0) - 200);
  ok(nw && onWalk(nw.x, nw.y) && nw.y > C(0), 'nearestWalk from beyond the north edge finds the inland sidewalk', nw && `${nw.x.toFixed(0)},${nw.y.toFixed(0)}`);
}

// ---------- 3. the v2 roads (§4.3) ----------

section('Kimchi Key v2 fixture (§4.3, §4.4)');
let v2 = null;
try { v2 = buildRoadNet(V2_ROADS, V2_CLASSES, { signals: SIGNALS }); }
catch (e) { ok(false, 'v2 network builds (no X on a highway or deck)', e.message); }
if (v2) {
  ok(true, 'v2 network builds (no X on a highway or deck)');
  console.log(`  built in ${v2.stats.ms.toFixed(0)} ms: ${v2.stats.nodes} nodes, ${v2.stats.edges} edges, ${v2.stats.lanes} lanes, ${v2.stats.conns} connectors, ${v2.stats.walks} walk paths`);
  const kinds = {};
  for (const n of v2.nodes) kinds[n.kind] = (kinds[n.kind] || 0) + 1;
  console.log('  node kinds', JSON.stringify(kinds));
  ok(!v2.issues.some(i => i.type === 'unplanned_crossing'), '0 unplanned crossings', JSON.stringify(v2.issues.filter(i => i.type === 'unplanned_crossing')));
  ok(!v2.issues.some(i => i.type === 'self_crossing'), 'no road crosses itself');
  ok(!v2.issues.some(i => i.type === 'dead_lane'), 'every lane has a way on');

  // the Loop's junctions
  const loopRoad = V2_ROADS.find(r => r.id === 'loop');
  const loop = sampleCurve(loopRoad.pts, { closed: true, step: 1, chord: 8 });
  const loopNodes = v2.nodes.filter(n => n.edges.some(e => v2.edges[e].road === 'loop') && n.ends.length >= 3);
  const hwyX = v2.nodes.filter(n => n.ends.length >= 4 && n.edges.some(e => v2.edges[e].cls === 'hwy'));
  ok(hwyX.length === 0, '0 highway X junctions', hwyX.length);
  ok(loopNodes.length === 21 && loopNodes.every(n => n.kind === 'T'), '21 Loop junctions, all T', `${loopNodes.length} (${loopNodes.map(n => n.kind).join('')})`);
  const found = loopNodes.map(n => {
    const p = nearestOnCurve(loop, n.x / PX, n.y / PX);
    const side = n.ends.find(E => v2.edges[E.e].road !== 'loop');
    const t = pointAt(loop, p.s, {});
    return { s: p.s, road: v2.edges[side.e].road, side: (-t.tz * Math.cos(side.a) + t.tx * Math.sin(side.a)) > 0 ? 'R' : 'L', n };
  }).sort((a, b) => a.s - b.s);
  if (VERBOSE) for (const f of found) console.log(`    Loop ${f.s.toFixed(1).padStart(7)} m  ${f.road.padEnd(13)} ${f.side}  ${f.n.control}`);
  for (const [st, road, side] of LOOP_TS) {
    const f = found.find(f => f.road === road && near(f.s, st, 3));
    ok(f && f.side === side, `Loop T at ${st} m: ${road} (${side})`, f ? `side ${f.side}` : `nearest ${road} at ${found.filter(f => f.road === road).map(f => f.s.toFixed(1)).join('/')}`);
  }
  ok(loopNodes.every(n => n.control === 'priority'), 'Loop junctions are priority junctions');
  ok(v2.conns.filter(c => loopNodes.some(n => n.id === c.node)).every(c => c.yield === (v2.edges[v2.lanes[c.from].edge].road !== 'loop' || c.turn === 'l')),
    'side roads and left turns yield at Loop T\'s');
  const opp = found.map((f, i) => (i ? f.s - found[i - 1].s : Infinity));
  ok(Math.min(...opp) > 60, 'Loop junctions are spread out', Math.min(...opp).toFixed(1));

  // radii and lengths by the shared sampler
  for (const [id, [len, r]] of Object.entries(MEASURED)) {
    const road = V2_ROADS.find(x => x.id === id), chord = TIGHT.has(road.cls) ? 3 : 8;
    const c = sampleCurve(AS_MEASURED[id] || road.pts, { closed: !!road.closed, step: 1, chord });
    const mr = minRadius(c, chord).r;
    if (VERBOSE) console.log(`    ${id.padEnd(13)} len ${c.len.toFixed(1).padStart(7)} (${len})  minR ${mr.toFixed(1).padStart(6)} (${r})`);
    ok(near(mr, r, r >= 100 ? Math.max(1, r * 0.005) : 1), `${id} min radius ${r} m +-1`, mr.toFixed(2));
    ok(near(c.len, len, 1.5), `${id} length ${len} m`, c.len.toFixed(1));
  }
  const tot = {};
  for (const road of V2_ROADS) tot[road.cls] = (tot[road.cls] || 0) + sampleCurve(AS_MEASURED[road.id] || road.pts, { closed: !!road.closed, step: 1 }).len;
  for (const [cls, m] of Object.entries(CLASS_TOTALS)) ok(near(tot[cls], m, 3), `${cls} total ${m} m`, tot[cls].toFixed(1));
  {
    const sp = V2_ROADS.find(x => x.id === 'south_pointe'), c = sampleCurve(sp.pts, { step: 1, chord: 3 }), m = minRadius(c, 3);
    console.log(`  WARN spec south_pointe as listed: ${c.len.toFixed(1)} m, min radius ${m.r.toFixed(1)} m at (${m.x.toFixed(0)},${m.z.toFixed(0)}),` +
      ` below the street minimum of ${V2_CLASSES.street.minR} m (the table's 199 m / 24.9 m is for the old end (1680,1205))`);
  }

  // junction control: the ring, signal candidates, crossings
  const ringNodes = v2.nodes.filter(n => n.kind === 'ring');
  ok(ringNodes.length === 5 && ringNodes.every(n => n.control === 'priority'), 'Seoul Circle has 5 priority entries', ringNodes.length);
  const ringEdges = v2.edges.filter(e => e.road === 'ring');
  ok(ringEdges.every(e => e.oneway && e.lanesB === 0 && e.lanesF === 1 && v2.lanes[e.fwd[0]].off === 0), 'the ring is one-way with its lane centred');
  ok(v2.conns.filter(c => v2.edges[v2.lanes[c.to].edge].road === 'ring' && v2.edges[v2.lanes[c.from].edge].road !== 'ring').every(c => c.yield),
    'ring entries yield');
  ok(v2.conns.filter(c => v2.nodes[c.node].kind === 'ring').every(c => c.turn !== 'l' || v2.edges[v2.lanes[c.to].edge].road !== 'ring'),
    'nobody turns left onto the ring');
  for (const [x, z] of SIGNALS) {
    const n = v2.nodes.find(n => Math.hypot(n.x / PX - x, n.y / PX - z) < 3);
    ok(n && n.signal && n.ends.length >= 3, `signal candidate node at (${x},${z})`, n ? `${n.kind} signal=${n.signal}` : 'no node');
  }
  ok(v2.nodes.every(n => n.control !== 'signal'), 'signals stay off until enabled');
  const sigN = v2.nodes.find(n => n.signal);
  v2.setSignals(true);
  const states = new Set();
  for (let t = 0; t < 40; t += 0.5) { v2.clock = t; states.add(v2.signalAt(sigN.id, sigN.ends[0].e)); }
  ok(sigN.control === 'signal' && states.has('g') && states.has('a') && states.has('r'), 'enabled signals cycle green, amber, red');
  v2.clock = 0; v2.setSignals(false);
  ok(sigN.control === sigN.fallback, 'signals switch back off');

  // closed roads joined at one point are self-loops
  for (const id of ['key_loop', 'star_ring', 'port_yard']) {
    const es = v2.roadIndex[id].edges.map(i => v2.edges[i]);
    ok(es.length === 1 && es[0].a === es[0].b, `${id} is a self-loop edge`, es.map(e => `${e.a}-${e.b}`).join(' '));
  }
  const rick = v2.roadIndex.rickenbacker.edges.map(i => v2.edges[i]), keyLoop = v2.edges[v2.roadIndex.key_loop.edges[0]];
  ok(rick.some(e => e.a === keyLoop.a || e.b === keyLoop.a), 'the Rickenbacker joins the Key Loop (end 15.6 m away)');

  // traffic connectivity and routing
  const scc = laneComponents(v2, L => v2.edges[L.edge].ai);
  ok(scc.count === 1, 'the AI lane graph is strongly connected', `${scc.count} components over ${scc.size} lanes`);
  if (scc.count > 1) {
    const sizes = new Map();
    for (const [l, c] of scc.comp) { if (!sizes.has(c)) sizes.set(c, []); sizes.get(c).push(v2.edges[v2.lanes[l].edge].road); }
    for (const [, roads] of sizes) if (roads.length < scc.size / 2) console.log('    stray component:', [...new Set(roads)].join(', '));
  }
  const home = [333.7 * PX, 263.6 * PX], marina = [1662.6 * PX, 1201 * PX];
  const hm = v2.route(home[0], home[1], marina[0], marina[1]);
  ok(hm && hm.len > Math.hypot(marina[0] - home[0], marina[1] - home[1]), 'A* route from the home foot to the marina curb', hm && `${(hm.len / PX).toFixed(0)} m, ${hm.steps.length} steps`);
  const hmAI = v2.route(home[0], home[1], marina[0], marina[1], { ai: true, time: true });
  ok(hmAI && hmAI.steps.every(st => v2.edges[v2.lanes[st.lane].edge].ai), 'ai routes keep to traffic roads');
  ok(near(v2.routeLength(home[0], home[1], marina[0], marina[1]), hm.len, hm.len * 1e-3), 'routeLength agrees with route (to float32 rounding)', (v2.routeLength(home[0], home[1], marina[0], marina[1]) / PX).toFixed(1));
  // the ring is one-way: from its east entry to its north entry is a short hop, the reverse goes round
  const ringE = [912 * PX, 560 * PX], ringN = [870 * PX, 518 * PX];
  const ccw = v2.routeLength(...ringE, ...ringN), cw = v2.routeLength(...ringN, ...ringE);
  ok(ccw < cw, 'the ring is driven counter-clockwise only', `${(ccw / PX).toFixed(0)} m vs ${(cw / PX).toFixed(0)} m`);
  const drop = v2.edges.find(e => e.cls === 'hwy');
  ok(drop.bankMax > 0 && drop.speed === 26 * PX && drop.halfW === 10.2 * PX, 'highway edges carry class speed, width and bank limit');
  ok(v2.edges.every(e => e.bank.every(b => Math.abs(b) <= e.bankMax + 1e-6)), 'bank stays within each class limit');
  const loopLanes = v2.lanes.filter(L => v2.edges[L.edge].road === 'loop');
  ok(loopLanes.every(L => near(Math.abs(L.off), (1.5 + (L.i + 0.5) * 3.6) * PX, 1e-3)), 'Loop lanes at median/2 + (i+.5) laneW');
  ok(Math.max(...v2.lanes.map(L => laneOffsetError(v2, L))) < 0.5, 'v2 lane polylines follow their offsets');
  const rp = v2.randomLanePoint({ x: 1000 * PX, y: 700 * PX, rMin: 180 * PX, rMax: 380 * PX, cls: ['street', 'ave'] });
  ok(rp && ['street', 'ave'].includes(v2.edges[v2.lanes[rp.lane].edge].cls), 'randomLanePoint honours the class filter');
  const peds = v2.walks.paths.filter(p => !p.cross);
  ok(peds.every(p => p.edge < 0 || v2.edges[p.edge].cls !== 'hwy'), 'no sidewalk along the highway');
  const v2b = buildRoadNet(V2_ROADS, V2_CLASSES, { signals: SIGNALS });
  ok(v2b.nodes.length === v2.nodes.length && v2b.conns.length === v2.conns.length && v2b.edges.every((e, i) => e.len === v2.edges[i].len),
    'building twice gives the same network');
}

// ---------- 4. heights, decks and the fatal cases ----------

section('heights, decks and authoring errors');
{
  // flat land at 1 m with the bay at -5 m between x 1300 and 1600 north of z 400 (the North Causeway)
  const heightAt = (x, z) => (x > 1300 && x < 1600 && z < 400 ? -5 : 1);
  const net = buildRoadNet(V2_ROADS, V2_CLASSES, { heightAt, signals: SIGNALS });
  const loopEdges = net.edges.filter(e => e.road === 'loop');
  let crest = null;
  for (const e of loopEdges) for (let i = 0; i < e.n; i++) {
    const d = Math.hypot(e.x[i] / PX - 780, e.y[i] / PX - 322);
    if (!crest || d < crest.d) crest = { d, gy: e.gy[i] };
  }
  ok(near(crest.gy, 26, 0.5), 'Loop pins put the pass crest (control point 20) at 26 m', crest.gy.toFixed(2));
  const decks = loopEdges.flatMap(e => e.deck.map(([a, b]) => ({ x: e.x[0] / PX, a, b })));
  ok(decks.length > 0 && decks.every(d => d.b > d.a), 'the causeway over the bay is bridge deck', decks.length);
  ok(net.nodes.every(n => net.edges.filter(e => e.a === n.id || e.b === n.id).every(e => Number.isFinite(n.gy))), 'every node has a height');
  ok(net.edges.every(e => near(e.gy[0], net.nodes[e.a].gy, 1e-4) && near(e.gy[e.n - 1], net.nodes[e.b].gy, 1e-4)), 'edges meet their nodes at the node height');
  const villa = net.edges.filter(e => e.road === 'villa_dr');
  ok(villa.some(e => e.gy.some(y => near(y, 1, 0.01))), 'stations past the last pin follow the terrain (Villa Drive past (362,262))');
  const maxBank = Math.max(...loopEdges.flatMap(e => [...e.bank].map(Math.abs)));
  ok(near(maxBank, 5 * Math.PI / 180, 1e-6), 'the Loop banks up to its 5 degree limit on its tightest bends', (maxBank * 180 / Math.PI).toFixed(2));

  // updateProfiles({ bank: false }) re-pins heights but leaves a bank written elsewhere (terrain) alone
  const be = loopEdges.find(e => e.bank.some(b => b !== 0)), mark = Float32Array.from(be.bank, b => b * 0.5);
  be.bank.set(mark);
  net.updateProfiles({ bank: false });
  ok(be.bank.every((b, i) => b === mark[i]), 'updateProfiles({bank:false}) keeps edge.bank');
  net.updateProfiles();
  ok(be.bank.some((b, i) => b !== mark[i]), 'updateProfiles() recomputes edge.bank');

  // walkL / walkR: one side's sidewalk only
  const oneSide = buildRoadNet([{ id: 'a', cls: 'street', walkL: 0, pts: [[0, 0], [100, 0]] }, { id: 'b', cls: 'street', pts: [[50, 0], [50, 60]] }], V2_CLASSES);
  const sideOf = p => Math.sign(p.pts[1]);   // the road runs east along z 0: south (right) is +y
  const along = oneSide.walks.paths.filter(p => !p.cross && p.edge >= 0 && oneSide.edges[p.edge].road === 'a');
  ok(along.length === 2 && along.every(p => p.side === 1 && sideOf(p) > 0), 'walkL:0 leaves only the right-hand (south) sidewalk', along.map(p => p.side).join(','));
  ok(oneSide.edges.filter(e => e.road === 'a').every(e => e.walkL === 0 && e.walkR === 2.5 * PX && e.walkW === 2.5 * PX), 'edges report each side\'s sidewalk width');
  ok(oneSide.walks.paths.some(p => !p.cross && p.edge < 0), 'the T still joins its two south corners');

  // a street straight across a highway is a fatal error
  const square = [[0, 0], [400, 0], [400, 400], [0, 400]];
  let threw = null;
  try { buildRoadNet([{ id: 'hw', cls: 'hwy', closed: true, pts: square }, { id: 'cross', cls: 'street', pts: [[200, -100], [200, 100]] }], V2_CLASSES); }
  catch (e) { threw = e.message; }
  ok(threw && threw.includes('hwy_x'), 'a street crossing the highway throws', threw || 'no throw');
  const lax = buildRoadNet([{ id: 'hw', cls: 'hwy', closed: true, pts: square }, { id: 'cross', cls: 'street', pts: [[200, -100], [200, 100]] }], V2_CLASSES, { strict: false });
  ok(lax.issues.some(i => i.type === 'hwy_x' && i.fatal), 'strict:false reports it instead');
  // two streets crossing away from their control points are reported as unplanned
  const odd = buildRoadNet([{ id: 'a', cls: 'street', pts: [[0, 0], [100, 100]] }, { id: 'b', cls: 'street', pts: [[0, 100], [100, 0]] }], V2_CLASSES);
  ok(odd.issues.some(i => i.type === 'unplanned_crossing') && odd.nodes.some(n => n.kind === 'X'), 'an unauthored crossing becomes an X and is reported');
  // a one-way road that dead-ends leaves its lane with no way on
  const dead = buildRoadNet([{ id: 'ow', cls: 'street', oneway: true, pts: [[0, 0], [100, 0]] }], V2_CLASSES);
  ok(dead.issues.some(i => i.type === 'dead_lane'), 'a one-way dead end is reported');
  // a two-way dead end turns around
  const cul = buildRoadNet([{ id: 'cul', cls: 'street', pts: [[0, 0], [100, 0]] }], V2_CLASSES);
  ok(cul.conns.length === 2 && cul.conns.every(c => c.turn === 'u'), 'a two-way dead end gets U-turns at both ends');
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
