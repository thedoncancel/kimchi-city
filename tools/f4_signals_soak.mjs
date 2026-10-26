#!/usr/bin/env node
// Stage F4 soak: the traffic lights on the Kimchi Key v2 map (docs/map-v2-spec.md §9, §12.3 "Signals stay off
// until traffic.js counts connector cars in its lane-change room test"). The 13 signal candidates are switched
// on (roads.setSignals) and traffic is played two ways:
//   A. the whole network packed with 80 traffic cars and 60 people (no population, nobody streamed), the
//      hardest case for lane changes, junction reservations and queues at the lights;
//   B. the game as main3d runs it (entities.updateWorld: traffic, people and the streamed population at the
//      Medium caps) while Kimchi tours the busy middle of the county at 12 m/s, frightening the people round
//      him every 6 s so they flee off the pavement and walk back.
//   node tools/f4_signals_soak.mjs [minutes=10] [seed=1] [--signals off]
// Checks, in both parts:
//   - no clashes: two connectors that may not be driven at once (traffic.junctionConflicts) never are, and no
//     two cars come within 20 cm of touching in a junction (ghosts, the spec's deadlock breaker, are counted
//     and reported apart);
//   - no red-light runs: no car's front bumper crosses a signalled stop line on red (the all-red included),
//     ghosting or not, and nobody's centre enters a signalled junction after the all-red;
//   - stuck at most 1%: trafficStats().stuckPct, the share of car samples stopped for over 5 s not counting
//     time held by a red light (src/sim/traffic.js stillX);
//   - no two cars within 3 m outside the junctions, mean speed at least 6 m/s, and no car within 1.2 m of
//     someone on a crosswalk;
//   - lane changes: when one starts, nobody on the new lane, on a connector into it or about to take one is
//     within 25 m of the car's new spot (the F4 fix: connector cars used to be missed);
//   - B only: the population keeps its caps, and nobody stands on a road off the crosswalks (pedsOnRoad;
//     tools/f4_peds_test.mjs splits any into the sidewalk data and the people's own walking).
// The first few of each kind of failure, and every car that starts ghosting, are printed with what held it.
// Exits 1 if any check fails.
globalThis.KC_WORLD = 'v2';
const L = await import('./s6a_lib.mjs');
const { M, DT } = L;
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const MINUTES = Number(args[0] || 10), SEED = Number(args[1] || 1), SIGNALS = !process.argv.includes('off');
const game = await L.loadGame();
const { G, ent, world } = game;
if (world.KIND !== 'v2') {
  console.log('f4 soak: world-v2 is not READY yet, so the facade gives the grid; nothing to check');
  process.exit(0);
}
const traffic = await import('../src/sim/traffic.js');
const peds = await import('../src/sim/peds.js');
const pop = await import('../src/sim/population.js');
const { CAR_TYPES } = await import('../src/data.js');
const { roads } = world;
const { lanes, conns, nodes } = roads;
let failed = 0, passed = 0, warned = 0;
const check = (ok, msg) => { if (ok) passed++; else { failed++; console.log('  FAIL ' + msg); } };
const warn = msg => { warned++; console.log('  WARN ' + msg); };
const info = msg => console.log('  ' + msg);
roads.setSignals(SIGNALS);
const sigNodes = nodes.filter(n => n.control === 'signal').length;
console.log(`f4 soak: ${MINUTES} min a part, seed ${SEED}, signals ${SIGNALS ? 'on at ' + sigNodes + ' junctions' : 'off'}; ${lanes.length} lanes, ${conns.length} connectors`);

const CREEP = 0.1 * M;           // a car braking to its line may settle a hair over it; over by this much is a run
const CYCLE = 38;                // src/map/roadnet.js: 14 s green, 3 s amber, 2 s all-red, then the cross street's turn
const halfLen = c => (CAR_TYPES[c.type]?.len ?? 66) / 2;

// Whether the bodies of cars a and b, each grown by `pad` px all round, overlap (separating axes).
function touching(a, b, pad = 0) {
  const A = CAR_TYPES[a.type], B = CAR_TYPES[b.type], dx = b.x - a.x, dy = b.y - a.y;
  const ax = [Math.cos(a.a), Math.sin(a.a)], ay = [-ax[1], ax[0]], bx = [Math.cos(b.a), Math.sin(b.a)], by = [-bx[1], bx[0]];
  const al = A.len / 2 + pad, aw = A.wid / 2 + pad, bl = B.len / 2 + pad, bw = B.wid / 2 + pad;
  for (const n of [ax, ay, bx, by]) {
    const dot = u => Math.abs(u[0] * n[0] + u[1] * n[1]);
    if (Math.abs(dx * n[0] + dy * n[1]) > al * dot(ax) + aw * dot(ay) + bl * dot(bx) + bw * dot(by)) return false;
  }
  return true;
}

// Car o's station on lane nb, counting a car on its way in (on a connector into nb, or at the end of a lane
// with one planned) at the station it will reach (negative), or null.
function stationOn(o, nb) {
  const a = o.ai;
  if (a.conn >= 0) return conns[a.conn].to === nb ? a.s - conns[a.conn].len : null;
  if (a.lane === nb) return a.s;
  const C = a.next >= 0 ? conns[a.next] : null;
  return C && C.to === nb && C.from === a.lane ? a.s - lanes[a.lane].len - C.len : null;
}

// Seconds the light has been red for traffic arriving at signal node N from edge e (0 while green or amber;
// the first 2 s are the all-red).
function redFor(N, e) {
  const k = N.ends.findIndex(E => E.e === e);
  let t = (roads.clock + N.phase) % CYCLE;
  if ((k < 0 ? 1 : N.groups[k]) === 1) t = (t + CYCLE / 2) % CYCLE;
  return t < 17 ? 0 : t - 17 + 1e-6;
}

// Watches traffic frame by frame for the checks above. Call frame() after each update.
function watcher() {
  const W = { clashes: 0, ghostClashes: 0, near: 0, nearMin: Infinity, runs: 0, runsGhost: 0, crossings: 0, entriesGreen: 0, entriesAllRed: 0,
    entriesRed: 0, lc: 0, lcTight: 0, lcMin: Infinity, frames: 0, pedCross: 0, runOver: 0, log: [] };
  const crossing = new Set();
  // the first few of each kind of failure, to say what happened
  const seenKinds = {};
  const note = (kind, text) => { if ((seenKinds[kind] = (seenKinds[kind] || 0) + 1) <= 3) W.log.push(`${kind} at ${(roads.clock).toFixed(1)} s: ${text}`); };
  const who = c => { const a = c.ai; return `#${a.id}${c.traffic ? '' : ' (not streamed)'} ${a.conn >= 0 ? 'conn ' + a.conn + ' (' + conns[a.conn].turn + ', node ' + conns[a.conn].node + ')' : 'lane ' + a.lane} s ${(a.s / M).toFixed(1)} m v ${(a.speed / M).toFixed(1)} m/s${a.ghost > 0 ? ' ghost' : ''}${a.forced ? ' forced' : ''}${a.lcT > 0 ? ' changing lanes' : ''} rsv ${a.rsv} why ${a.why} at (${(c.x / M).toFixed(1)}, ${(c.y / M).toFixed(1)})`; };
  const front = new Map(), inConn = new Map(), lcWas = new Map(), ghostWas = new Map();
  W.frame = () => {
    const used = [], cs = [];
    for (const c of G.cars) {
      const a = c.ai;
      if (!a) continue;
      cs.push(c);
      // the front bumper crossing a signalled stop line: the light it crossed on
      if (a.conn < 0) {
        const Ln = lanes[a.lane], N = nodes[Ln.b], f = a.s + halfLen(c), was = front.get(c), line = Ln.len - traffic.stopLine(a.lane) + CREEP;
        if (N.control === 'signal' && was && was.lane === a.lane && was.f < line && f >= line) {
          W.crossings++;
          if (roads.signalAt(N, Ln.edge) === 'r') {
            W.runs++;
            if (a.ghost > 0 || a.throughConn >= 0) W.runsGhost++;
            note('red run', `${who(c)}, red for ${redFor(N, Ln.edge).toFixed(2)} s, front ${((was.f - line + CREEP) / M).toFixed(2)} -> ${((f - line + CREEP) / M).toFixed(2)} m past the line`);
          }
        }
        front.set(c, { lane: a.lane, f });
        inConn.delete(c);
      } else {
        front.delete(c);
        if (inConn.get(c) !== a.conn) {
          inConn.set(c, a.conn);
          const C = conns[a.conn], N = nodes[C.node];
          // the centre reaching the junction: in the all-red, a car that crossed its line on amber still
          // rolling in; any later, a car that ran the red
          if (N.control === 'signal') { const r = redFor(N, lanes[C.from].edge); if (!r) W.entriesGreen++; else if (r <= 2) W.entriesAllRed++; else W.entriesRed++; }
        }
        used.push(c);
      }
      // a car starting to ghost (stuck for 4 s): what held it
      if (a.ghost > 0 && !(ghostWas.get(c) > 0)) {
        const why = a.throughConn >= 0 ? `junction ${a.throughConn} (${conns[a.throughConn].turn}, ${nodes[conns[a.throughConn].node].control})` :
          a.through ? (a.through.ai ? `car #${a.through.ai.id} ${a.through.ai.conn >= 0 ? 'on conn ' + a.through.ai.conn : 'on lane ' + a.through.ai.lane} why ${a.through.ai.why}` : a.through.state ? `person (${a.through.state})` : 'a parked car') : 'a dead end';
        let holders = '';
        if (a.throughConn >= 0) {
          const K = [...traffic.junctionConflicts(a.throughConn)];
          for (const o of G.cars) {
            const b = o.ai;
            if (!b || o === c) continue;
            const hit = [b.rsv, b.hold, b.conn].filter(x => x >= 0 && K.includes(x));
            if (hit.length) holders += ` | holder ${who(o)} hold ${b.hold} conn ${b.conn} stillX ${b.stillX.toFixed(1)} red ${b.red}`;
          }
          const T = lanes[conns[a.throughConn].to];
          holders += ` | exit lane ${T.id} first ${T.cars[0] ? who(T.cars[0]) : '-'}`;
        }
        note('ghost', `${who(c)} through ${why}${holders}`);
      }
      ghostWas.set(c, a.ghost);
      // a lane change starting: how close is the nearest car on the new lane or on its way into it
      if (a.lcT > (lcWas.get(c) || 0) + 1e-6) {
        W.lc++;
        for (const o of G.cars) {
          if (o === c || !o.ai) continue;
          const so = stationOn(o, a.lane);
          if (so == null) continue;
          const g = Math.abs(so - a.s) / M;
          W.lcMin = Math.min(W.lcMin, g);
          if (g < 25 - 0.5) { W.lcTight++; note('tight lane change', `${who(c)} / ${who(o)} ${g.toFixed(1)} m`); }
        }
      }
      lcWas.set(c, a.lcT);
    }
    // every connector in use against every other. Ghosts (the deadlock breaker, spec §9) and the cars that
    // ghosted onto their connector may cross anything, so they are counted apart.
    const loose = c => c.ai.ghost > 0 || c.ai.forced;
    for (let i = 0; i < used.length; i++) {
      const K = traffic.junctionConflicts(used[i].ai.conn);
      for (let j = i + 1; j < used.length; j++) for (let k = 0; k < K.length; k++) {
        if (K[k] !== used[j].ai.conn) continue;
        if (loose(used[i]) || loose(used[j])) W.ghostClashes++; else W.clashes++;
      }
    }
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
      const a = cs[i], b = cs[j];
      if ((a.ai.conn < 0 && b.ai.conn < 0) || loose(a) || loose(b) || a.ai.through === b || b.ai.through === a) continue;
      const dx = a.x - b.x, dy = a.y - b.y;
      if (Math.abs(dx) > 10 * M || Math.abs(dy) > 10 * M) continue;
      if (touching(a, b, 0.1 * M)) { W.near++; note('junction near-miss', `${who(a)} / ${who(b)}`); }
      W.nearMin = Math.min(W.nearMin, Math.hypot(dx, dy) / M);
    }
    // people on the crosswalks: traffic never drives through them (they cross in front of waiting cars too)
    for (const p of G.peds) {
      const on = p.state === 'walk' && p.walk && roads.walks.paths[p.walk.path].cross;
      if (on && !crossing.has(p)) { crossing.add(p); W.pedCross++; } else if (!on) crossing.delete(p);
      if (on) for (const c of cs) if (!loose(c) && !c.ai.through && Math.hypot(c.x - p.x, c.y - p.y) < 1.2 * M) { W.runOver++; note('run over', `${who(c)} / person at (${(p.x / M).toFixed(1)}, ${(p.y / M).toFixed(1)})`); }
    }
    // (what makes trafficStats' close pairs: two cars off the connectors within 3 m)
    if (++W.frames % 30 === 0) for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
      const a = cs[i], b = cs[j];
      if (a.ai.conn >= 0 || b.ai.conn >= 0 || loose(a) || loose(b) || a.ai.through === b || b.ai.through === a) continue;
      if (Math.hypot(a.x - b.x, a.y - b.y) < 3 * M) note('close pair', `${who(a)} / ${who(b)}`);
    }
  };
  return W;
}

// The checks both parts share.
function report(W, st) {
  info(`stats ${JSON.stringify({ ...st, pedOnRoadSamples: undefined })}`);
  info(`signals: ${W.crossings} stop-line crossings, ${W.runs} on red (${W.runsGhost} ghosting); junction entries ${W.entriesGreen} on green or amber, ${W.entriesAllRed} in the all-red, ${W.entriesRed} on red`);
  info(`ghosts: ${st.ghosts}, ${W.ghostClashes} pair-frames of a ghost crossing a connector in use`);
  for (const t of W.log) info('  ' + t);
  info(`lane changes: ${W.lc}, closest car on or coming into the new lane ${W.lcMin === Infinity ? '-' : W.lcMin.toFixed(1) + ' m'}; ${W.pedCross} crosswalk crossings`);
  check(W.clashes === 0, `no clashes: connectors that may not be driven at once never are, ghosts aside (${W.clashes} pair-frames)`);
  check(W.near === 0, `no two cars within 20 cm of touching in a junction (${W.near} samples, closest centres ${W.nearMin.toFixed(2)} m)`);
  if (SIGNALS) {
    check(W.runs === 0, `no red-light runs: no front bumper crosses a signalled stop line on red (${W.runs} of ${W.crossings})`);
    check(W.entriesRed === 0, `nobody enters a signalled junction after the all-red (${W.entriesRed} of ${W.entriesRed + W.entriesAllRed + W.entriesGreen})`);
    check(W.crossings >= 20 * MINUTES, `the lights see traffic (${W.crossings} stop-line crossings)`);
  }
  check(st.stuckPct <= 1, `stuck at most 1%: car samples stopped over 5 s, red lights aside (${st.stuckPct}%; ${st.stoppedPct}% with them)`);
  check(st.closePairs === 0, `no two cars within 3 m outside the junctions (${st.closePairs}, closest ${st.minGap} m)`);
  check(st.meanSpeed >= 6, `mean speed at least 6 m/s (${st.meanSpeed})`);
  check(W.runOver === 0 && W.pedCross > 0, `traffic never drives through someone on a crosswalk (${W.runOver} frames; ${W.pedCross} crossings)`);
  check(W.lcTight === 0, `lane changes start with 25 m clear on the new lane, connector cars counted (${W.lcTight} of ${W.lc} too close)`);
}

// ---------- A. the whole network, packed ----------
console.log(`A: 80 cars and 60 people on the whole network for ${MINUTES} min`);
{
  L.seed(SEED * 2654435761);
  Object.assign(G, { mode: 'play', t: 0, wanted: 0 });
  Object.assign(G.player, { x: -1e6, y: -1e6, car: null, dead: false });
  G.cars = []; G.peds = []; G.friends = [];
  for (let i = 0; i < 400 && G.cars.length < 80; i++) {
    const q = roads.randomLanePoint({ ai: true, minGap: 25 * M });
    if (!q || G.cars.some(c => Math.hypot(c.x - q.x, c.y - q.y) < 15 * M)) continue;
    G.cars.push(traffic.aiAttach(pop.makeCar('sedan', q.x, q.y, q.a), q));
  }
  for (let i = 0; i < 60; i++) { const q = peds.randomSidewalk(); const p = pop.makePed(q.x, q.y); peds.attachWalk(p, q); G.peds.push(p); }
  check(G.cars.length === 80, `80 cars placed (${G.cars.length})`);
  traffic.resetTrafficStats();
  const W = watcher();
  for (let f = 0, n = Math.round(MINUTES * 60 / DT); f < n; f++) {
    traffic.updateTraffic(DT);
    for (const p of G.peds) peds.walkPed(p, DT, 15);
    W.frame();
  }
  report(W, traffic.trafficStats());
}

// ---------- B. the game, touring the middle of the county ----------
console.log(`B: the game (updateWorld, Medium caps) touring Downtown, K-Town, the causeway and Deco for ${MINUTES} min`);
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
  // Kimchi walks the tour out of traffic's sight (dead to its eyes, as in tools/s6a_soak.mjs: on a lane he
  // would be in every car's path), but the population streams round him and people flee from him
  const place = q => Object.assign(G.player, { x: q.x, y: q.y, heading: q.a, car: null, dead: true, face: 1 });
  L.seed(SEED * 7919);
  Object.assign(G, { mode: 'play', t: 0, wanted: 0, energy: 100, money: 0 });
  G.cars = []; G.peds = []; G.friends = [];
  place(along(0));
  pop.updatePopulation(0, G.player, { tier: 'medium' });
  ent.spawnWorld();
  G.friends = [];
  traffic.resetTrafficStats();
  const W = watcher(), caps = pop.CAPS.medium;
  let over = 0, frights = 0, fled = 0;
  for (let f = 0, n = Math.round(MINUTES * 60 / DT), s = 0; f < n; f++) {
    place(along(s += 12 * M * DT));
    if (f % 360 === 359) {
      // a fright round Kimchi: people near him run off the pavement (some knocked down first)
      frights++;
      for (const p of G.peds) {
        if (p.role || p.state !== 'walk' || Math.hypot(p.x - G.player.x, p.y - G.player.y) > 30 * M) continue;
        fled++;
        if (Math.random() < 0.3) ent.hurtPed(p, 10, { knock: true, vx: (Math.random() - 0.5) * 300, vy: (Math.random() - 0.5) * 300 });
        else { p.state = 'flee'; p.t = 1.6 + Math.random() * 4; }
      }
    }
    ent.updateWorld(DT, { tier: 'medium' });
    W.frame();
    let t = 0, k = 0;
    for (const c of G.cars) if (c.ai && c.traffic) t++;
    for (const p of G.peds) if (!p.role) k++;
    if (t > caps.traffic || k > caps.peds) over++;
  }
  const st = traffic.trafficStats();
  report(W, st);
  info(`${frights} frights sent ${fled} people off the pavement`);
  check(over === 0, `the population keeps to the Medium caps 24 / 34 (${over} frames over)`);
  check(st.pedsOnRoad === 0, `nobody stands on a road off the crosswalks (pedsOnRoad ${st.pedsOnRoad}, ${st.pedOnRoadSamples} samples; tools/f4_peds_test.mjs says whether it is sidewalk data or walking)`);
}
roads.setSignals(false);

console.log(failed ? `f4 soak: ${failed} failed, ${passed} passed, ${warned} warnings` : `f4 soak: ok (${passed} checks, ${warned} warnings)`);
process.exit(failed ? 1 : 0);
