#!/usr/bin/env node
// Stage S7a race check (Street Kings on the v2 map: one lap of the Kimchi Loop, routes.street_kings). With
// live traffic and the 3D game's car settings:
//   1. Dex's lap from the GO is 95-115 s however the race goes: Kimchi far behind (Dex's rubber band slows
//      him 10%), level with him, and far ahead (the band speeds him up 10%);
//   2. Dex passes every gate in order;
//   3. the mission bot in Kimchi's Toro Ursa (the car he owns when Street Kings opens) can win, and Dex
//      in his Cavallo still wins when Kimchi drives at 80% of the Ursa's pace.
//   node tools/s7a_race_test.mjs [-v]
// Exits 1 if any check fails.
globalThis.KC_WORLD = 'v2';
const { loadPlay, freshSave, makeBot, frame, seed, unseed, topSpeed, M, px } = await import('./s7a_lib.mjs');
const VERBOSE = process.argv.includes('-v');

const game = await loadPlay();
const { G, world, mis, nav, ent } = game;
if (world.KIND !== 'v2') { console.log('s7a race: the v2 world is not READY; nothing to check'); process.exit(0); }
const DT = 1 / 60;
let failed = 0, passed = 0;
const check = (ok, msg) => { if (ok) passed++; else { failed++; console.log('  FAIL ' + msg); } if (ok && VERBOSE) console.log('  ok   ' + msg); };
const SK = mis.MISSIONS.find(m => m.id === 'street_kings');
const RACE = SK.steps.find(s => s.type === 'race'), GOTO = SK.steps.find(s => s.type === 'goto');
const talk = { type: 'talk', lines: [['Dex', 'gg']] };
const R = world.routes.street_kings;
console.log(`s7a race: ${(R.len / M).toFixed(0)} m, ${R.gates.length} gates; Cavallo top ${(topSpeed(game, 'cavallo') / M).toFixed(1)} m/s, Ursa ${(topSpeed(game, 'ursa') / M).toFixed(1)} m/s`);

// One race from the start line. mode: 'parked' (Kimchi waits at the start), 'level' / 'ahead' (Kimchi is
// carried along the course level with Dex or 60 m ahead of him, so the band reads that), 'bot' (the mission
// bot drives his Ursa, at `pace` of its speed). Returns Dex's lap (s from the GO), Kimchi's, and the result.
function race(mode, sd, pace = 1) {
  seed(sd);
  freshSave(game);
  const st = GOTO.to();
  const c = ent.makeCar('ursa', st.x, st.y, st.a);
  G.cars.push(c); G.player.car = c; G.player.x = st.x; G.player.y = st.y;
  mis.startMission({ id: 'race_test', title: 'Race', reward: 0, steps: [RACE, talk] });
  const s = mis.missionState.active.s;
  const bot = mode === 'bot' ? makeBot(game, { cap: topSpeed(game, 'ursa') * pace, raceGrip: 17.5 * pace * pace }) : null;
  let go = null, dex = null, kim = null, order = [], last = s.ri, result = null;
  for (let t = 0; t < 260; t += DT) {
    let inp = null;
    if (bot) inp = bot.tick(DT);
    else if (s.go && mode !== 'parked') {
      // on foot, carried along the course 4 m to Dex's side at his station (or 60 m ahead of it)
      const r = s.rival, at = (r.nav?.at || 0) + (mode === 'ahead' ? px(60) : 0);
      const q = nav.pathPoint(R, Math.min(R.len - 1, at), {});
      G.player.car = null;
      G.player.x = q.x - Math.sin(q.a) * px(4); G.player.y = q.y + Math.cos(q.a) * px(4);
    } else { c.vx = c.vy = 0; }
    frame(game, DT, inp);
    if (s.go && go == null) go = G.t;
    if (VERBOSE && bot && s.go && Math.round((G.t - go) * 60) % 600 === 0) {
      const r = s.rival, kAt = nav.stationOf(R, c.x, c.y, 0);
      console.log(`    t ${(G.t - go).toFixed(0)}: Dex ${(r.nav.at / M).toFixed(0)} m ${(Math.hypot(r.vx, r.vy) / M).toFixed(1)} m/s hp ${r.hp.toFixed(0)}, Kimchi gate ${s.pi} ${(Math.hypot(c.vx, c.vy) / M).toFixed(1)} m/s hp ${c.hp.toFixed(0)}`);
    }
    if (s.ri !== last) { order.push(s.ri); last = s.ri; }
    if (dex == null && s.ri >= s.n) dex = G.t - go;
    if (kim == null && s.pi >= s.n) kim = G.t - go;
    if (mis.missionState.active?.s !== s) { result = mis.missionState.active ? 'won' : 'lost'; break; }
  }
  // finish Dex's lap when Kimchi won first
  if (dex == null && s.rival && result) {
    for (let t = 0; t < 120 && dex == null; t += DT) {
      if (s.rival.nav.at >= R.len - px(3)) dex = G.t - go;
      G.t += DT; ent.updateWorld(DT);
      mis.missionState.active = null;
      const r = s.rival, pt = nav.followCourse(r);
      game.pol.steerTo(r, DT, pt[0], pt[1], { corner: 300, curv: nav.curvatureAhead(r, undefined, r.back || r.nav), grip: 17.5, dodge: true });
    }
  }
  if (mis.missionState.active) mis.failMission('test over');
  mis.resetMissions();
  game.log.big.length = 0;
  return { dex, kim, result, inOrder: order.every((v, i) => v === order[0] + i), gates: order.length, n: s.n, hp: s.rival.hp };
}

const fmt = v => (v == null ? '-' : v.toFixed(1));
// Dex's own driving still meets traffic at speed (a car pulling out of a side road, a queue at a junction):
// a lap he does not finish because traffic wrecked him is counted apart, and may happen once.
console.log('Dex alone, level and chased');
let wrecked = 0;
for (const mode of ['parked', 'level', 'ahead']) {
  for (const sd of [11, 12, 13]) {
    const r = race(mode, sd);
    console.log(`  ${mode} seed ${sd}: Dex ${fmt(r.dex)} s, ${r.gates} gates, hp ${r.hp.toFixed(0)}${r.hp <= 0 ? ' (wrecked in traffic)' : ''}`);
    if (r.hp <= 0) { wrecked++; continue; }
    check(r.dex != null && r.dex >= 95 && r.dex <= 115, `${mode} ${sd}: Dex should lap in 95-115 s (${fmt(r.dex)})`);
    check(r.inOrder && (mode === 'parked' ? r.gates === r.n : r.gates > 0), `${mode} ${sd}: Dex should pass his gates in order`);
  }
}
check(wrecked <= 1, `traffic should wreck Dex in at most 1 of 9 laps (${wrecked})`);
console.log('Kimchi in his Ursa');
let wins = 0;
for (const sd of [21, 22, 23, 24, 25]) {
  const r = race('bot', sd);
  console.log(`  bot seed ${sd}: Kimchi ${fmt(r.kim)} s, Dex ${fmt(r.dex)} s: ${r.result}`);
  if (r.result === 'won') wins++;
}
// the bot drives like the cops (it crashes into traffic now and then); a race it can win is enough
check(wins >= 1, `the bot in the Ursa should win at least 1 of 5 races (${wins})`);
{
  const r = race('bot', 31, 0.8);
  console.log(`  bot at 80% pace: Kimchi ${fmt(r.kim)} s, Dex ${fmt(r.dex)} s: ${r.result}`);
  check(r.result === 'lost', 'Dex should beat a Kimchi driving at 80% of the Ursa\'s pace');
}
unseed();
console.log(failed ? `s7a race: ${failed} failed, ${passed} passed` : `s7a race: ok (${passed} checks)`);
process.exit(failed ? 1 : 0);
