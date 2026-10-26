#!/usr/bin/env node
// Stage S7a police check (Bad Rep's getaway, spec §9): Kimchi in his Toro Ursa at the airboat yard in the
// Glades (anchors.bandanaYard) with 2 stars, as the mission leaves him, and live cops. Two ways out:
//   spray: drive to K-Spray at the Port and into its bay;
//   run:   keep driving away from the nearest cruiser, out of the Glades and round the county, until the cops
//          lose sight of him for long enough.
// Checks each way loses the 2 stars in 30-90 s and that he is not busted on the way.
//   node tools/s7a_police_test.mjs [-v]
// Exits 1 if any check fails.
globalThis.KC_WORLD = 'v2';
const { loadPlay, freshSave, makeBot, frame, seed, unseed, M, px } = await import('./s7a_lib.mjs');
const VERBOSE = process.argv.includes('-v');

const game = await loadPlay();
const { G, world, mis, ent, pol } = game;
if (world.KIND !== 'v2') { console.log('s7a police: the v2 world is not READY; nothing to check'); process.exit(0); }
const DT = 1 / 60;
let failed = 0, passed = 0;
const check = (ok, msg) => { if (ok) passed++; else { failed++; console.log('  FAIL ' + msg); } };
const BAD_REP = mis.MISSIONS.find(m => m.id === 'bad_rep');
const WANTED = BAD_REP.steps.find(s => s.type === 'wanted'), LOSE = BAD_REP.steps.find(s => s.type === 'lose');
const Y = world.anchors.bandanaYard;
console.log(`s7a police: from the airboat yard (${(Y.x / M).toFixed(0)}, ${(Y.y / M).toFixed(0)}) to K-Spray (${(world.places.spray.bay.x / M).toFixed(0)}, ${(world.places.spray.bay.y / M).toFixed(0)})`);

function getaway(escape, sd) {
  seed(sd);
  freshSave(game);
  const c = ent.makeCar('ursa', Y.x, Y.y, Y.a);
  G.cars.push(c); G.player.car = c; G.player.x = Y.x; G.player.y = Y.y;
  mis.startMission({ id: 'getaway_test', title: 'Getaway', reward: 0, steps: [WANTED, LOSE, { type: 'talk', lines: [['Bao', 'ok']] }] });
  const bot = makeBot(game, { escape });
  const t0 = G.t, n0 = G.sprayed || 0;
  let lost = null, busted = false, seen = 0, cops = 0, sprayed = false, near = Infinity;
  for (let t = 0; t < 180; t += DT) {
    frame(game, DT, bot.tick(DT));
    cops = Math.max(cops, pol.police.cars.length);
    for (const k of pol.police.cars) near = Math.min(near, Math.hypot(k.x - G.player.x, k.y - G.player.y) / M);
    if (G.player.dead) { busted = G.player.dead; break; }
    if (G.wanted === 0) { lost = G.t - t0; sprayed = (G.sprayed || 0) > n0; break; }
  }
  if (mis.missionState.active) mis.failMission('test over');
  pol.resetPolice();
  return { lost, busted, cops, sprayed, near };
}

const fmt = v => (v == null ? 'never' : v.toFixed(1) + ' s');
for (const escape of ['spray', 'run']) {
  const times = [];
  for (const sd of [1, 2, 3, 4]) {
    const r = getaway(escape, sd);
    times.push(r.lost);
    console.log(`  ${escape} seed ${sd}: lost the cops after ${fmt(r.lost)}${r.sprayed ? ' (resprayed)' : ''}${r.busted ? ', ' + r.busted : ''}; ${r.cops} cruisers, nearest ${r.near.toFixed(0)} m`);
    check(!r.busted, `${escape} ${sd}: Kimchi should not be busted on the way`);
    check(r.lost != null && r.lost >= 30 && r.lost <= 90, `${escape} ${sd}: losing 2 stars should take 30-90 s (${fmt(r.lost)})`);
  }
}
unseed();
console.log(failed ? `s7a police: ${failed} failed, ${passed} passed` : `s7a police: ok (${passed} checks)`);
process.exit(failed ? 1 : 0);
