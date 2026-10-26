#!/usr/bin/env node
// Stage S6a soak on the Kimchi Key v2 map (docs/map-v2-spec.md §9): the whole street life (lane traffic, the
// sidewalk people, the streamed population) as the game runs it each frame (entities.updateWorld), with the 13
// traffic-light candidates switched on, while Kimchi tours the busy middle of the county (Downtown, K-Town,
// the causeway, Collins, Deco and back) at 12 m/s.
//   node tools/s6a_soak.mjs [minutes=10] [seed=1] [--signals off]
// Checks:
//   1. the S1b metrics: at most 1% of car samples stopped for over 5 s, no two cars within 3 m outside the
//      junctions, mean speed at least 6 m/s; crossing connectors never in use together; nobody enters a
//      signalled junction on red; people back on the pavement after a fright (pedsOnRoad, see WARN);
//   2. the population at its Medium caps (24 traffic, 34 people, 30 parked): reached, never passed, and the
//      streamed rings kept (traffic within 460 m, people within 190 m, parked cars within 300 m); traffic
//      drives past the cars parked along the avenues, and none of those stands on a delivery or place kerb;
//   3. how busy it is follows the regions: the Glades and the Heights are quieter than Downtown;
//   4. the Low tier keeps to 16 / 22 / 18;
//   5. the sim and AI stay within the frame budget (spec §11.2: sim + AI <= 2 ms).
// Exits 1 if any check fails.
globalThis.KC_WORLD = 'v2';
const L = await import('./s6a_lib.mjs');
const { M, DT } = L;
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const MINUTES = Number(args[0] || 10), SEED = Number(args[1] || 1), SIGNALS = !process.argv.includes('off');
const game = await L.loadGame();
const { G, ent, world } = game;
if (world.KIND !== 'v2') {
  console.log('s6a soak: world-v2 is not READY yet, so the facade gives the grid; nothing to check');
  process.exit(0);
}
const traffic = await import('../src/sim/traffic.js');
const pop = await import('../src/sim/population.js');
const { roads } = world;
let failed = 0, passed = 0, warned = 0;
const check = (ok, msg) => { if (ok) passed++; else { failed++; console.log('  FAIL ' + msg); } };
const warn = msg => { warned++; console.log('  WARN ' + msg); };
const info = msg => console.log('  ' + msg);
roads.setSignals(SIGNALS);
const sigNodes = roads.nodes.filter(n => n.control === 'signal').length;
console.log(`s6a soak: ${MINUTES} min, seed ${SEED}, signals ${SIGNALS ? 'on at ' + sigNodes + ' junctions' : 'off'}; ${roads.lanes.length} lanes, ${roads.walks.paths.length} sidewalk paths`);

// Kimchi's tour: road routes between these points (m), round and round
const TOUR = [[1060, 560], [1239, 710], [1745, 700], [1813, 420], [1745, 960], [1660, 700], [1115, 820], [1000, 630], [870, 560], [870, 707], [1000, 470], [1060, 560]];
function tourPath(points) {
  const pts = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i], points[i + 1]];
    const r = roads.route(a[0] * M, a[1] * M, b[0] * M, b[1] * M, { ai: true });
    if (!r) throw new Error(`no route from ${a} to ${b}`);
    for (let k = 0; k < r.pts.length; k += 2) pts.push({ x: r.pts[k], y: r.pts[k + 1] });
  }
  let s = 0;
  return pts.map((p, k) => (p.s = s += k ? Math.hypot(p.x - pts[k - 1].x, p.y - pts[k - 1].y) : 0, p));
}
const PATH = tourPath(TOUR), LEN = PATH[PATH.length - 1].s;
info(`tour ${(LEN / M / 1000).toFixed(2)} km`);

// Kimchi out of the way of traffic (walking along a lane he would be in every car's path): dead to the
// traffic's eyes, but the population streams round him
function place(p, a) { Object.assign(G.player, { x: p.x, y: p.y, heading: a, car: null, dead: true, face: 1 }); }
function along(s) {
  s %= LEN;
  let lo = 0, hi = PATH.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (PATH[m].s <= s) lo = m; else hi = m; }
  const A = PATH[lo], B = PATH[hi], f = (s - A.s) / ((B.s - A.s) || 1);
  return [{ x: A.x + (B.x - A.x) * f, y: A.y + (B.y - A.y) * f }, Math.atan2(B.y - A.y, B.x - A.x)];
}
function newGame(at, a, tier = 'medium') {
  L.seed(SEED * 7919);
  Object.assign(G, { mode: 'play', t: 0, wanted: 0, energy: 100, money: 0 });
  place(at, a);
  pop.updatePopulation(0, G.player, { tier });
  ent.spawnWorld();
  G.friends = [];               // the friends' hangouts are the places; this soak is about the streets
  traffic.resetTrafficStats();
}
const count = () => {
  let t = 0, p = 0, k = 0;
  for (const c of G.cars) { if (c.ai && c.traffic) t++; else if (c.parked != null && !c.touched) k++; }
  for (const q of G.peds) if (!q.role) p++;
  return { traffic: t, peds: p, parked: k };
};

// Seconds into its own light cycle for traffic arriving at signal node N from edge e: green 0-14, amber 14-17,
// all-red 17-19, then red while the cross street has its turn (src/map/roadnet.js signalAt).
function lightTime(N, e) {
  const k = N.ends.findIndex(E => E.e === e), cyc = 38;
  let t = (roads.clock + N.phase) % cyc;
  if ((k < 0 ? 1 : N.groups[k]) === 1) t = (t + cyc / 2) % cyc;
  return t;
}

// The S1b stuck metric (a car stopped for over 5 s), every 0.5 s, leaving out the cars waiting at a red light
// and the queues behind them: with the lights on that wait is up to 19 s and is not stuck.
const stuck = { n: 0, samples: 0 };
function sampleStuck() {
  const held = new Set(), byLane = new Map();
  for (const c of G.cars) if (c.ai && c.ai.conn < 0) { if (!byLane.has(c.ai.lane)) byLane.set(c.ai.lane, []); byLane.get(c.ai.lane).push(c); }
  for (const list of byLane.values()) {
    list.sort((a, b) => b.ai.s - a.ai.s);
    let chain = false, front = null;
    for (const c of list) {
      const stopped = c.ai.speed < 0.5 * M;
      if (!front) chain = stopped && c.ai.why === 'signal';
      else chain = chain && stopped && front.ai.s - c.ai.s < 14 * M;
      if (chain) held.add(c);
      front = c;
    }
  }
  for (const c of G.cars) {
    if (!c.ai) continue;
    stuck.samples++;
    if (c.ai.still > 5 && !held.has(c)) stuck.n++;
  }
}

// The closest a moving traffic car comes to a parked one (m, centre to centre).
function closestToParked() {
  let best = Infinity;
  for (const p of G.cars) {
    if (p.parked == null || p.touched) continue;
    for (const c of G.cars) {
      if (!c.ai || c.ai.ghost > 0 || Math.abs(c.x - p.x) > 10 * M || Math.abs(c.y - p.y) > 10 * M) continue;
      best = Math.min(best, Math.hypot(c.x - p.x, c.y - p.y) / M);
    }
  }
  return best;
}

// Cars parked in the avenues' kerb bays (spots past the world's own parkedSpawns) standing too near a kerb
// Kimchi is sent to: within the population's 10 m box of a place's kerb, bay, foot spot or door, or on a
// delivery's kerb (a 4 m box: the car's half length, 2.4 m, and some).
const KEEP = [...world.deliveryDoors.filter(d => d.curb).map(d => ({ ...d.curb, r: 4 })),
  ...Object.values(world.places).flatMap(pl => ['curb', 'bay', 'foot', 'door'].map(k => pl[k] && { x: pl[k].x, y: pl[k].y, r: 10 }))].filter(Boolean);
const bayClashes = () => G.cars.filter(c => c.parked != null && c.parked >= world.parkedSpawns.length
  && KEEP.some(q => Math.abs(q.x - c.x) < q.r * M && Math.abs(q.y - c.y) < q.r * M)).length;

// ---------- 1, 2 and 5: the tour ----------
console.log(`the tour, ${MINUTES} min at 12 m/s`);
{
  const caps = pop.CAPS.medium;
  let [at, a] = along(0);
  newGame(at, a);
  const frames = Math.round(MINUTES * 60 / DT), V = 12 * M;
  let s = 0, ms = 0, worst = 0, clashes = 0, reds = 0, late = 0, greens = 0, parkGap = Infinity, over = 0, farCars = 0, farPeds = 0, farParked = 0, onKerbs = 0;
  const hi = { traffic: 0, peds: 0, parked: 0 }, atCap = { traffic: 0, peds: 0, parked: 0 }, sum = { traffic: 0, peds: 0, parked: 0 };
  const inConn = new Map();
  for (let f = 0; f < frames; f++) {
    s += V * DT;
    [at, a] = along(s);
    place(at, a);
    const t0 = performance.now();
    ent.updateWorld(DT, { tier: 'medium' });
    const t1 = performance.now() - t0;
    ms += t1; if (f > 600) worst = Math.max(worst, t1);
    const used = [];
    for (const c of G.cars) {
      const ai = c.ai;
      if (!ai) continue;
      if (ai.conn >= 0 && inConn.get(c) !== ai.conn) {
        inConn.set(c, ai.conn);
        const C = roads.conns[ai.conn], N = roads.nodes[C.node];
        if (N.control === 'signal' && !ai.forced && ai.ghost <= 0) {
          const light = lightTime(N, roads.lanes[C.from].edge);
          if (light < 17) greens++; else if (light < 19) late++; else reds++;
        }
      }
      if (ai.conn < 0) inConn.delete(c);
      if (ai.conn >= 0 && ai.ghost <= 0 && !ai.forced) used.push(ai.conn);
    }
    for (let i = 0; i < used.length; i++) for (let j = i + 1; j < used.length; j++) {
      const K = traffic.junctionConflicts(used[i]);
      for (let k = 0; k < K.length; k++) if (K[k] === used[j]) clashes++;
    }
    if (f % 30 === 29) { sampleStuck(); parkGap = Math.min(parkGap, closestToParked()); onKerbs += bayClashes(); }
    const n = count();
    for (const k of ['traffic', 'peds', 'parked']) {
      hi[k] = Math.max(hi[k], n[k]); sum[k] += n[k];
      if (n[k] >= caps[k]) atCap[k]++;
    }
    if (n.traffic > caps.traffic || n.peds > caps.peds || n.parked > caps.parked) over++;
    // dropped on the next population pass (every 0.25 s); people may be fleeing or lying down
    for (const c of G.cars) {
      const d = Math.hypot(c.x - at.x, c.y - at.y) / M;
      if (c.ai && c.traffic && d > 460 + 15) farCars++;
      if (c.parked != null && !c.touched && d > 300 + 15) farParked++;
    }
    for (const q of G.peds) if (!q.role && q.state === 'walk' && Math.hypot(q.x - at.x, q.y - at.y) / M > 190 + 15) farPeds++;
  }
  const st = traffic.trafficStats();
  const pct = k => (100 * atCap[k] / frames).toFixed(0), avg = k => (sum[k] / frames).toFixed(1);
  info(`stats ${JSON.stringify({ ...st, pedOnRoadSamples: undefined })}`);
  info(`population: traffic up to ${hi.traffic} (mean ${avg('traffic')}, at the cap ${pct('traffic')}% of the time), people up to ${hi.peds} (mean ${avg('peds')}, ${pct('peds')}%), parked up to ${hi.parked} (mean ${avg('parked')}, ${pct('parked')}%)`);
  info(`${(ms / frames).toFixed(3)} ms a frame for updateWorld (worst ${worst.toFixed(2)} ms); signals: ${greens} junction entries on green or amber, ${late} in the 2 s all-red after amber, ${reds} on red`);
  const stuckPct = 100 * stuck.n / Math.max(1, stuck.samples);
  info(`stopped over 5 s: ${st.stuckPct}% of car samples in all, ${stuckPct.toFixed(2)}% not counting queues at a red light`);
  check(stuckPct <= 1, `at most 1% of car samples stopped for over 5 s, red lights aside (${stuckPct.toFixed(2)}%)`);
  check(st.closePairs === 0, `no two cars within 3 m outside the junctions (${st.closePairs}, closest ${st.minGap} m)`);
  check(st.meanSpeed >= 6, `mean speed at least 6 m/s (${st.meanSpeed})`);
  check(clashes === 0, `crossing connectors never in use together (${clashes})`);
  if (SIGNALS) check(reds === 0 && greens >= 10 * MINUTES, `nobody enters a signalled junction on red (${reds} of ${reds + late + greens})`);
  if (late) warn(`${late} car(s) entered in the 2 s all-red after amber (reserved on green, still crawling in; sim/traffic.js could give the junction back when the light turns red before the line)`);
  if (st.pedsOnRoad > 0) warn(`up to ${st.pedsOnRoad} people at a time stand on ROAD cells off the crosswalks (S1b: v2 sidewalk paths cross SURF ROAD cells, S2b data)`);
  check(st.pedsOnRoad <= 4, `people stay off the roads (${st.pedsOnRoad} at a time at most)`);
  check(over === 0, `the population never passes the Medium caps 24 / 34 / 30 (${over} frames over)`);
  check(hi.traffic === caps.traffic && hi.peds === caps.peds, `traffic and people reach their caps (${hi.traffic} / ${hi.peds})`);
  check(atCap.traffic > frames * 0.5 && sum.peds / frames > caps.peds * 0.7, `traffic is at its cap most of the tour (${pct('traffic')}%), people near theirs (mean ${avg('peds')})`);
  check(hi.parked === caps.parked, `parked cars reach their cap (${hi.parked})`);
  info(`closest a moving car came to a parked one: ${parkGap.toFixed(2)} m`);
  check(parkGap > 2.4, `traffic passes the cars parked along the avenues (closest centres ${parkGap.toFixed(2)} m apart)`);
  check(onKerbs === 0, `no car parked in a kerb bay stands on a delivery or place kerb (${onKerbs} samples, ${KEEP.length} kerbs)`);
  check(farCars === 0 && farPeds === 0 && farParked === 0, `nothing streamed is left past its ring (${farCars} car, ${farPeds} people, ${farParked} parked frames)`);
  check(ms / frames < 2, `sim + AI under 2 ms a frame (${(ms / frames).toFixed(3)} ms)`);
}

// ---------- 3. quiet and busy ----------
console.log('quiet and busy places, 60 s standing at each');
{
  const res = {};
  for (const [name, x, z] of [['downtown', 1060, 560], ['ktown', 870, 505], ['deco', 1745, 900], ['glades', 300, 960], ['heights', 400, 300]]) {
    const q = roads.nearest(x * M, z * M, { maxD: 80 * M }), E = roads.edges[q.edge];
    newGame({ x: q.x, y: q.y }, Math.atan2(E.ty[q.i], E.tx[q.i]));
    let t = 0, p = 0;
    for (let f = 0; f < 60 * 60; f++) {
      G.player.heading += 0.3 * DT;     // looking round, so the out-of-view rule does not decide it
      ent.updateWorld(DT, { tier: 'medium' });
      if (f >= 30 * 60) { const n = count(); t += n.traffic; p += n.peds; }
    }
    res[name] = { traffic: t / (30 * 60), peds: p / (30 * 60) };
  }
  info(Object.entries(res).map(([k, r]) => `${k} ${r.traffic.toFixed(1)} cars, ${r.peds.toFixed(1)} people`).join('; '));
  check(res.glades.traffic < res.downtown.traffic * 0.6 && res.heights.traffic < res.downtown.traffic * 0.6, 'the Glades and the Heights have far less traffic than Downtown');
  check(res.glades.peds < res.downtown.peds * 0.5, 'and far fewer people in the Glades');
  check(res.glades.traffic >= 4, `the quietest place still has traffic (${res.glades.traffic.toFixed(1)} cars in the Glades)`);
}

// ---------- 4. the Low tier ----------
console.log('Low tier, 2 min of the tour');
{
  const caps = pop.CAPS.low;
  let [at, a] = along(0);
  newGame(at, a, 'low');
  let over = 0, hiT = 0, hiP = 0, hiK = 0;
  for (let f = 0, s = 0; f < 120 * 60; f++) {
    [at, a] = along(s += 12 * M * DT);
    place(at, a);
    ent.updateWorld(DT, { tier: 'low' });
    const n = count();
    hiT = Math.max(hiT, n.traffic); hiP = Math.max(hiP, n.peds); hiK = Math.max(hiK, n.parked);
    if (n.traffic > caps.traffic || n.peds > caps.peds || n.parked > caps.parked) over++;
  }
  info(`up to ${hiT} cars, ${hiP} people, ${hiK} parked`);
  check(over === 0 && hiT === caps.traffic && hiK === caps.parked, `keeps to the Low caps 16 / 22 / 18 and fills them (${over} frames over)`);
}
pop.updatePopulation(0, G.player, { tier: 'medium' });
roads.setSignals(false);

console.log(failed ? `s6a soak: ${failed} failed, ${passed} passed, ${warned} warnings` : `s6a soak: ok (${passed} checks, ${warned} warnings)`);
process.exit(failed ? 1 : 0);
