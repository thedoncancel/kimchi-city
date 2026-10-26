#!/usr/bin/env node
// Stage S8: times every race board event (activities.js) for a bot driving it cleanly with no traffic, in the
// Toro Ursa every game starts with and in the fastest car (the Bolide), and prints them beside the star
// marks in activities.js EVENTS. The marks are set so that the Ursa bot earns two stars and the Bolide bot
// three on most courses.  node tools/s8_events_calibrate.mjs [grip]
globalThis.KC_WORLD = 'v2';
const { loadS8, fresh, runEvent, M } = await import('./s8_lib.mjs');
const game = await loadS8();
const { G, world, act } = game;
const grip = +(process.argv[2] || 0.8);
const board = world.activities.find(a => a.type === 'eventBoard');
const fmt = s => (s == null ? '-' : act.fmtTime(s));
for (const id of ['runway_drag', 'deco_sprint', 'hillclimb', 'glades_scramble', 'key_coastal', 'bay_loop']) {
  const row = [id.padEnd(16)];
  for (const type of ['ursa', 'bolide']) {
    fresh(game, board.x, board.y);
    // the event takes Kimchi's own car: this type
    const c = game.ent.makeCar(type, board.x, board.y, 0); c.owned = true; G.cars.push(c); G.ownedCar = c;
    const r = runEvent(game, id, { grip });
    row.push(`${type} ${r.done ? fmt(r.t) : 'DNF ' + (r.why || '')}  ${r.rec?.stars ?? '-'}★`);
  }
  const R = world.routes[id];
  row.push(`(${(R.len * (R.laps || 1) / M).toFixed(0)} m, ${R.gates.length * (R.laps || 1)} gates)`);
  console.log(row.join('   '));
}
