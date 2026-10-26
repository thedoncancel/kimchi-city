#!/usr/bin/env node
// Stage F4 check: people stay off the roads on the Kimchi Key v2 map (docs/map-v2-spec.md §9 Peds: sidewalk
// paths, crosswalks only where marked, back to the pavement after a fright). A person counts as standing on
// a road (KCSTATS pedsOnRoad, src/sim/peds.js pedOnRoad) when they are walking (not fleeing, knocked down or a
// cop) on a ROAD cell that is not on a crosswalk, and not in their first seconds of walking back after a fright.
//   node tools/f4_peds_test.mjs [minutes=10] [seed=1]
// A. The sidewalk data (the world's, F3): every sidewalk path, sampled every 0.5 m along its centre line and
//    0.15-0.5 m to its right (where people keep), should lie off ROAD cells. Reported as a WARN with the worst
//    paths while the data still has them.
// B. The people: the game (entities.updateWorld) with the streamed population, Kimchi touring the busy middle
//    of the county and frightening the people round him every 6 s. Every person found on a road is put down to
//    one of: the sidewalk data under their path (A's cells, not the people's doing); their own walking (off
//    their path's line onto a road its centre line misses, walking back across a road for too long, or lost on
//    one). The second must never happen; the first is a WARN until the data is fixed.
// C. People on the pavement by the Loop who run 20-33 m out across it in a fright (often more than 25 m from
//    any sidewalk then): they head back to the pavement (nobody is left standing on the highway) and are off
//    the road within the 8 s grace.
// Exits 1 if any check fails.
globalThis.KC_WORLD = 'v2';
const L = await import('./s6a_lib.mjs');
const { M, DT } = L;
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const MINUTES = Number(args[0] || 10), SEED = Number(args[1] || 1);
const game = await L.loadGame();
const { G, ent, world } = game;
if (world.KIND !== 'v2') {
  console.log('f4 peds: world-v2 is not READY yet, so the facade gives the grid; nothing to check');
  process.exit(0);
}
const traffic = await import('../src/sim/traffic.js');
const peds = await import('../src/sim/peds.js');
const pop = await import('../src/sim/population.js');
const { roads, tileAtPx, surfaceAt, ROAD } = world;
const W = roads.walks.paths;
let failed = 0, passed = 0, warned = 0;
const check = (ok, msg) => { if (ok) passed++; else { failed++; console.log('  FAIL ' + msg); } };
const warn = msg => { warned++; console.log('  WARN ' + msg); };
const info = msg => console.log('  ' + msg);
const KINDS = ['ROAD', 'WALK', 'GRASS', 'BUILD', 'LOT', 'PLAZA', 'WATER', 'SAND', 'DIRT', 'SHALLOW', 'DECK', 'ROCK'];
console.log(`f4 peds: ${MINUTES} min, seed ${SEED}; ${W.length} walk paths (${W.filter(P => P.cross).length} crosswalks)`);

// A point `off` px right of walk path P at station s, walking along it.
function onPath(P, s, off) {
  const q = roads.walkPoint(P.id, s);
  return { x: q.x - Math.sin(q.a) * off, y: q.y + Math.cos(q.a) * off };
}
// Whether the sidewalk itself is on a road at station s of path P (its centre line, or where people keep).
const pathOnRoad = (P, s, off = 0) => { const p = onPath(P, s, off); return tileAtPx(p.x, p.y) === ROAD; };

// ---------- A. the sidewalk data ----------
console.log('A: the sidewalk paths against the SURF cells');
const bad = new Map();
let samples = 0, onRoad = 0;
for (const P of W) {
  if (P.cross) continue;
  for (let s = 0; s <= P.len; s += 0.5 * M) {
    for (const off of [0, 0.15 * M, 0.5 * M]) {
      samples++;
      if (!pathOnRoad(P, s, off)) continue;
      onRoad++;
      const p = onPath(P, s, off), r = bad.get(P.id) || { n: 0, at: p, kind: KINDS[surfaceAt(p.x, p.y)] };
      r.n++;
      bad.set(P.id, r);
    }
  }
}
info(`${onRoad} of ${samples} samples on ROAD cells, on ${bad.size} paths`);
if (bad.size) {
  const worst = [...bad.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8)
    .map(([id, r]) => `path ${id} (${W[id].edge >= 0 ? roads.edges[W[id].edge].road : 'corner'}) ${r.n} at (${(r.at.x / M).toFixed(0)}, ${(r.at.y / M).toFixed(0)}) ${r.kind}`);
  warn(`sidewalk paths cross ROAD cells (the world's data, F3): ${worst.join('; ')}`);
}

// ---------- B. the people ----------
console.log(`B: the game for ${MINUTES} min, people frightened round Kimchi every 6 s`);
{
  const TOUR = [[1060, 560], [1239, 710], [1745, 700], [1813, 420], [1745, 960], [1660, 700], [1115, 820], [1000, 630], [870, 560], [870, 707], [1000, 470], [1060, 560]];
  const PATH = [];
  for (let i = 0; i + 1 < TOUR.length; i++) {
    const [a, b] = [TOUR[i], TOUR[i + 1]];
    const r = roads.route(a[0] * M, a[1] * M, b[0] * M, b[1] * M, { ai: true });
    for (let k = 0; k < r.pts.length; k += 2) PATH.push({ x: r.pts[k], y: r.pts[k + 1], s: 0 });
  }
  for (let k = 1; k < PATH.length; k++) PATH[k].s = PATH[k - 1].s + Math.hypot(PATH[k].x - PATH[k - 1].x, PATH[k].y - PATH[k - 1].y);
  const LEN = PATH[PATH.length - 1].s;
  const along = s => {
    s %= LEN;
    let lo = 0, hi = PATH.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (PATH[m].s <= s) lo = m; else hi = m; }
    const A = PATH[lo], B = PATH[hi], f = (s - A.s) / ((B.s - A.s) || 1);
    return { x: A.x + (B.x - A.x) * f, y: A.y + (B.y - A.y) * f, a: Math.atan2(B.y - A.y, B.x - A.x) };
  };
  // Kimchi walks the tour out of traffic's sight (as in tools/s6a_soak.mjs); people flee from where he is
  const place = q => Object.assign(G.player, { x: q.x, y: q.y, heading: q.a, car: null, dead: true, face: 1 });
  L.seed(SEED * 7919);
  Object.assign(G, { mode: 'play', t: 0, wanted: 0, energy: 100, money: 0 });
  G.cars = []; G.peds = []; G.friends = [];
  place(along(0));
  pop.updatePopulation(0, G.player, { tier: 'medium' });
  ent.spawnWorld();
  G.friends = [];
  traffic.resetTrafficStats();
  const why = { data: 0, offset: 0, back: 0, lost: 0 }, first = {};
  let frights = 0, fled = 0, backOnPath = 0, pedFrames = 0;
  const fledSet = new Set();
  for (let f = 0, n = Math.round(MINUTES * 60 / DT), s = 0; f < n; f++) {
    place(along(s += 12 * M * DT));
    if (f % 360 === 359) {
      frights++;
      for (const p of G.peds) {
        if (p.role || p.state !== 'walk' || Math.hypot(p.x - G.player.x, p.y - G.player.y) > 30 * M) continue;
        fled++; fledSet.add(p);
        if (Math.random() < 0.3) ent.hurtPed(p, 10, { knock: true, vx: (Math.random() - 0.5) * 300, vy: (Math.random() - 0.5) * 300 });
        else { p.state = 'flee'; p.t = 1.6 + Math.random() * 4; }
      }
    }
    ent.updateWorld(DT, { tier: 'medium' });
    for (const p of G.peds) {
      if (p.role) continue;
      pedFrames++;
      if (fledSet.has(p) && p.state === 'walk' && p.walk) { backOnPath++; fledSet.delete(p); }
      if (!peds.pedOnRoad(p)) continue;
      // why: under their path the sidewalk itself is on the road, or they are off it by their own doing
      let k;
      if (p.walk) k = pathOnRoad(W[p.walk.path], p.walk.s) || pathOnRoad(W[p.walk.path], p.walk.s, (p.off ?? 0) * p.walk.dir) ? 'data' : 'offset';
      else k = p.lost ? 'lost' : 'back';
      why[k]++;
      if (!first[k]) first[k] = `at (${(p.x / M).toFixed(1)}, ${(p.y / M).toFixed(1)}) ${KINDS[surfaceAt(p.x, p.y)]}${p.walk ? ` path ${p.walk.path} s ${(p.walk.s / M).toFixed(1)} m off ${((p.off ?? 0) / M).toFixed(2)} m` : ` resnapT ${(p.resnapT || 0).toFixed(1)} s`}`;
    }
  }
  const st = traffic.trafficStats();
  info(`${frights} frights sent ${fled} people off the pavement; ${backOnPath} of them were back on a sidewalk path before the end`);
  info(`pedsOnRoad ${st.pedsOnRoad} at a time at most, ${st.pedOnRoadSamples} person-samples (traffic stats); this test's frames: ${JSON.stringify(why)} of ${pedFrames}`);
  for (const [k, t] of Object.entries(first)) info(`  first '${k}' ${t}`);
  check(why.offset === 0, `nobody's own walking takes them off their sidewalk onto a road (${why.offset} person-frames)`);
  check(why.back === 0 && why.lost === 0, `people frightened onto a road get back to the pavement in time (${why.back} walking back too long, ${why.lost} lost)`);
  check(backOnPath >= fled * 0.8, `most of the people frightened walk back onto a sidewalk path (${backOnPath} of ${fled}; the rest left the ring or were knocked down)`);
  if (why.data) warn(`${why.data} person-frames on a road where the sidewalk path itself crosses ROAD cells (the world's data, A)`);
  check(why.data === 0 || bad.size > 0, 'any person on a road on their path is explained by the sidewalk data');
}

// ---------- C. fled onto the highway ----------
console.log('C: people on the pavement by the Loop who flee across it');
{
  // pavement spots within 30 m of a Loop lane; the fright comes from the far side of the pavement, so they
  // run 20-33 m (the flee: 6 m/s for up to 5.6 s, src/entities.js) straight out across the highway
  const spots = [];
  for (let t = 0; t < 4000 && spots.length < 16; t++) {
    const r = roads.randomLanePoint({ ai: true });
    if (!r || roads.edges[roads.lanes[r.lane].edge].cls !== 'hwy') continue;
    const w = roads.nearestWalk(r.x, r.y, 30 * M);
    if (!w || W[w.path].cross) continue;
    spots.push({ q: w, to: { x: r.x, y: r.y }, run: (20 + Math.random() * 13) * M });
  }
  let back = 0, onRoadT = 0, worstT = 0, crossedRoad = 0;
  for (const { q, to, run } of spots) {
    G.cars = []; G.peds = [];
    const p = pop.makePed(q.x, q.y);
    G.peds.push(p);
    const dx = to.x - q.x, dy = to.y - q.y, d = Math.hypot(dx, dy) || 1;
    for (let k = 0; k < run / (0.5 * M); k++) peds.whiskerMove(p, dx / d * 0.5 * M, dy / d * 0.5 * M);
    if (tileAtPx(p.x, p.y) === ROAD) crossedRoad++;
    p.state = 'walk'; p.walk = null; p.snap = null; p.resnapT = 0;      // calm again, as a fright leaves them
    let t = 0;
    for (; t < 90 && !p.walk; t += DT) {
      peds.walkPed(p, DT, 15);
      if (peds.pedOnRoad(p)) onRoadT += DT;
    }
    if (p.walk) back++;
    worstT = Math.max(worstT, t);
  }
  info(`${spots.length} people ran out over the Loop (${crossedRoad} ended up on the road): ${back} walked back to a sidewalk, the longest in ${worstT.toFixed(1)} s; counted on the road for ${onRoadT.toFixed(1)} s`);
  check(spots.length >= 6 && crossedRoad >= 4, `enough of them end up on the road (${crossedRoad} of ${spots.length})`);
  check(back === spots.length, 'everyone who fled across the highway walks back to a sidewalk');
  check(onRoadT === 0, 'and is off the road within the grace (pedsOnRoad never counts them)');
}

console.log(failed ? `f4 peds: ${failed} failed, ${passed} passed, ${warned} warnings` : `f4 peds: ok (${passed} checks, ${warned} warnings)`);
process.exit(failed ? 1 : 0);
