#!/usr/bin/env node
// Stage S7a soak: all 7 story missions played start to finish from a fresh save by the mission bot
// (tools/s7a_lib.mjs), in the order the game offers them, with live traffic, police and the 3D game's car
// settings. Checks every mission passes, and reports each one's time, its tries and why any try failed.
//   node tools/s7a_missions_soak.mjs [seed] [--world grid] [--escape run] [-v]
// Exits 1 if a mission cannot be finished.
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
globalThis.KC_WORLD = opt('--world', 'v2');
const SEED = +(args.find(a => /^\d+$/.test(a)) || 1);
const VERBOSE = args.includes('-v');
const { loadPlay, freshSave, makeBot, frame, seed, unseed, topSpeed, M } = await import('./s7a_lib.mjs');

const game = await loadPlay();
const { G, world, mis, pol } = game;
const DT = 1 / 60, LIMIT = 3600;
seed(SEED);
const moved = freshSave(game);
if (moved) console.log(`  WARN the spawn spot (villa foot) is blocked for walking: Kimchi cannot move from it at 60 fps; moved ${moved.toFixed(2)} m to go on`);
const bot = makeBot(game, { escape: opt('--escape', 'spray') });
console.log(`s7a missions soak: ${world.KIND}, seed ${SEED}, Ursa top ${(topSpeed(game, 'ursa') / M).toFixed(1)} m/s`);

const rows = [], tries = {}, hits = [];
let cur = null, lastStep = null, stepT0 = 0;
const fmt = t => t.toFixed(1);
for (let t = 0; t < LIMIT && mis.availableMissions().length + (mis.missionState.active ? 1 : 0) > 0; t += DT) {
  const pc = G.player.car, hp0 = pc?.hp;
  const inp = bot.tick(DT);
  frame(game, DT, inp);
  if (pc && pc.hp < hp0 - 0.01) {
    let near = Infinity;
    for (const o of G.cars) if (o !== pc) near = Math.min(near, Math.hypot(o.x - pc.x, o.y - pc.y) / M);
    hits.push({ t: G.t, dmg: hp0 - pc.hp, v: Math.hypot(pc.vx, pc.vy) / M, car: near < 6, step: mis.missionState.active?.s.type || '-' });
    if (VERBOSE) console.log(`      hit ${(hp0 - pc.hp).toFixed(1)} hp at ${(Math.hypot(pc.vx, pc.vy) / M).toFixed(1)} m/s, ${near < 6 ? 'car ' + near.toFixed(1) + ' m' : 'wall'} (${(pc.x / M).toFixed(0)},${(pc.y / M).toFixed(0)})`);
  }
  if (VERBOSE && Math.round(G.t * 60) % (60 * 20) === 0) {
    const p = G.player, c = p.car;
    console.log(`    ${fmt(G.t)} at ${(p.x / M).toFixed(0)},${(p.y / M).toFixed(0)} ${c ? `in ${c.type} ${(Math.hypot(c.vx, c.vy) / M).toFixed(1)} m/s hp ${c.hp.toFixed(0)}` : 'on foot'} step ${mis.missionState.active?.s.type || '-'} wanted ${G.wanted}`);
  }
  const a = mis.missionState.active;
  if (a && a !== cur) { cur = a; tries[a.def.id] = (tries[a.def.id] || 0) + 1; cur.t0 = G.t; if (VERBOSE) console.log(`  ${fmt(G.t)} start ${a.def.id}`); }
  if (a && a.s !== lastStep) {
    if (VERBOSE && lastStep) console.log(`  ${fmt(G.t)}   ${lastStep.type} done in ${fmt(G.t - stepT0)} s`);
    lastStep = a.s; stepT0 = G.t;
  }
  if (cur && !a) {
    const passed = G.story.done.includes(cur.def.id);
    const big = game.log.big.at(-1);
    rows.push({ id: cur.def.id, passed, t: G.t - cur.t0, why: passed ? '' : big?.[1], step: lastStep?.type });
    const race = !passed && lastStep?.type === 'race' ? ` (Kimchi at gate ${lastStep.pi}/${lastStep.n}, car hp ${Math.round(G.player.car?.hp ?? 0)})` : '';
    console.log(`  ${fmt(G.t)} ${passed ? 'PASSED' : 'FAILED'} ${cur.def.id} after ${fmt(G.t - cur.t0)} s${passed ? '' : ` at ${lastStep?.type}: ${big?.[1]}`}${race}`);
    cur = null; lastStep = null;
  }
  // wasted or busted: main3d's respawn, at the hospital or the police station
  if (G.player.dead && !mis.missionState.active) {
    const kind = G.player.dead;
    pol.resetPolice();
    const pl = kind === 'wasted' ? world.places.hospital : world.places.police;
    Object.assign(G.player, { dead: null, car: null, x: pl.foot.x, y: pl.foot.y });
    console.log(`  ${fmt(G.t)} ${kind}, respawned`);
  }
}
unseed();
const ids = mis.MISSIONS.map(m => m.id);
const missing = ids.filter(id => !G.story.done.includes(id));
console.log(`missions passed ${G.story.done.length}/7 in ${fmt(G.t)} s; tries ${ids.map(id => `${id} ${tries[id] || 0}`).join(', ')}`);
console.log(missing.length ? `s7a missions soak: FAILED (${missing.join(', ')} not passed)` : 's7a missions soak: ok');
process.exit(missing.length ? 1 : 0);
