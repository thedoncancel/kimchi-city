#!/usr/bin/env node
// Stage F1 check, the grid side: the classic world keeps its car-to-car contact exactly as it was (docs/
// map-v2-spec.md §10: PHYS.classic plays as today). On the grid carCollisions is still one circle per car,
// a traffic car hit stops dead, a loose car hit spins at random, and nothing gets the v2 knock. Given the
// untouched pre-rebuild copy, 3000 random scenes (Kimchi's car among traffic, display, parked and loose
// cars and people, at up to 30 m/s) run through carCollisions in both copies on the same random numbers,
// and every car's and person's state must come out bit for bit the same.
//   node tools/f1_grid_test.mjs [--baseline <dir>]
// Exits 1 if any check fails.
globalThis.KC_WORLD = 'grid';
const { loadGame, seed, ROOT } = await import('./s6a_lib.mjs');

const args = process.argv.slice(2), opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const BASE = opt('--baseline');
let failed = 0, passed = 0;
const check = (ok, msg) => { if (ok) passed++; else { failed++; console.log('  FAIL ' + msg); } };
const info = msg => console.log('  ' + msg);
const M = 16;

const game = await loadGame(ROOT);
check(game.world.KIND === 'grid' && game.world.PHYS.wall === 'axis', `the grid world runs PHYS.classic (${game.world.KIND}, wall ${game.world.PHYS.wall})`);
const base = BASE ? await loadGame(BASE) : null;
const { CAR_TYPES } = await import('../src/data.js');

// ---------- the circles, as before ----------
console.log('grid contacts');
{
  const { G, ent, world } = game;
  const s = world.places.home.spawn;
  const scene = (dy, setup) => {
    Object.assign(G, { mode: 'play', cars: [], peds: [], friends: [], wanted: 0, shake: 0 });
    const c = ent.makeCar('sedan', s.x, s.y, 0), o = ent.makeCar('sedan', s.x, s.y + dy, 0);
    c.vx = 10 * M; o.vx = 10 * M; c.vy = 1 * M;
    setup(o);
    G.cars.push(c, o);
    Object.assign(G.player, { car: c, x: c.x, y: c.y, dead: false });
    ent.carCollisions(c);
    return [c, o];
  };
  // two sedans level, 2.9 m apart centre to centre: their circles ((66 + 31) / 4 px each) overlap
  let [c, o] = scene(2.9 * M, o => { o.ai = { speed: 10 * M }; });
  check(o.ai.speed === 0, 'a traffic car touched side by side 2.9 m away still stops dead, as it always did');
  check(Math.abs(Math.hypot(o.x - c.x, o.y - c.y) - (CAR_TYPES.sedan.len + CAR_TYPES.sedan.wid) / 2) < 1e-9, 'and Kimchi\'s car is pushed out to the circles\' radius');
  [c, o] = scene(3.1 * M, o => { o.ai = { speed: 10 * M }; });
  check(o.ai.speed === 10 * M, 'one 3.1 m away is not touched');
  seed(1);
  [c, o] = scene(2.9 * M, () => {});
  check(!c.knock && !o.knock && o.a !== 0, `a loose car touched turns at once, at random (${o.a.toFixed(4)} rad), and nothing gets a v2 knock`);
}

// ---------- the same as the untouched copy ----------
if (!base) info('no --baseline given: the scene-by-scene comparison with the pre-rebuild copy is skipped');
else {
  console.log(`3000 random scenes against the pre-rebuild copy (${BASE})`);
  const TYPES = Object.keys(CAR_TYPES);
  const X = game.world.places.home.spawn.x, Y = game.world.places.home.spawn.y;
  // one scene's cars and people, as plain numbers, the same for both copies
  function makeScene(k) {
    seed(1000 + k);
    const r = (a, b) => a + Math.random() * (b - a);
    const cars = [];
    for (let i = 0; i < 1 + (k % 6); i++) {
      cars.push({ type: TYPES[Math.floor(Math.random() * TYPES.length)], x: X + r(-90, 90), y: Y + r(-90, 90), a: r(-Math.PI, Math.PI),
        vx: r(-480, 480), vy: r(-480, 480), kind: ['loose', 'ai', 'locked', 'loose', 'police'][Math.floor(Math.random() * 5)], speed: r(0, 300) });
    }
    const peds = [];
    for (let i = 0; i < k % 4; i++) peds.push({ x: X + r(-40, 40), y: Y + r(-40, 40), state: Math.random() < 0.8 ? 'walk' : 'down' });
    return { me: { type: TYPES[k % TYPES.length], x: X, y: Y, a: r(-Math.PI, Math.PI), vx: r(-480, 480), vy: r(-480, 480) }, cars, peds };
  }
  function run(g, sc, k) {
    const { G, ent } = g;
    Object.assign(G, { mode: 'play', cars: [], peds: [], friends: [], wanted: 0, shake: 0, crime: null });
    const c = Object.assign(ent.makeCar(sc.me.type, sc.me.x, sc.me.y, sc.me.a), { vx: sc.me.vx, vy: sc.me.vy });
    G.cars.push(c);
    for (const d of sc.cars) {
      const o = Object.assign(ent.makeCar(d.type, d.x, d.y, d.a), { vx: d.vx, vy: d.vy });
      if (d.kind === 'ai') o.ai = { speed: d.speed };
      if (d.kind === 'locked') o.locked = true;
      if (d.kind === 'police') o.police = true;
      G.cars.push(o);
    }
    for (const d of sc.peds) G.peds.push(Object.assign(ent.makePed(d.x, d.y), { state: d.state, chatCd: 9 }));
    Object.assign(G.player, { car: k % 5 ? c : null, x: c.x, y: c.y, dead: false });
    seed(5000 + k);
    const before = JSON.stringify(G.cars.map(o => [o.x, o.y, o.vx, o.vy]));
    ent.carCollisions(c);
    return {
      hit: before !== JSON.stringify(G.cars.map(o => [o.x, o.y, o.vx, o.vy])),
      cars: G.cars.map(o => [o.x, o.y, o.a, o.vx, o.vy, o.hp, o.ai ? o.ai.speed : null, o.bubble ? o.bubble.text : null]),
      peds: G.peds.map(p => [p.x, p.y, p.vx, p.vy, p.hp, p.state, p.t]),
      shake: G.shake,
    };
  }
  let differ = 0, first = null, contacts = 0;
  for (let k = 0; k < 3000; k++) {
    const sc = makeScene(k), a = run(game, sc, k), now = JSON.stringify(a), then = JSON.stringify(run(base, sc, k));
    if (now !== then) { differ++; first ??= { k, now, then }; }
    if (a.hit) contacts++;
  }
  info(`${contacts} of the scenes have a contact`);
  check(contacts > 1000, `the scenes exercise the contact code (${contacts} with a contact)`);
  if (first) info(`first difference, scene ${first.k}:\n    now  ${first.now.slice(0, 300)}\n    then ${first.then.slice(0, 300)}`);
  check(differ === 0, `every scene comes out bit for bit as before (${differ} of 3000 differ)`);
}

console.log(`\nf1 grid: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
