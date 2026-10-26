#!/usr/bin/env node
// Stage S7a delivery check (Hot Delivery's orders, spec §9): from Kimchi House, ten orders in a row, each to a
// delivery door whose drive is 500-1500 m (900-3000 px on the grid), timed at the drive / 18 m/s + 20 s. The
// mission bot drives the Toro Ursa along the roads, never above 70% of its top speed, with live traffic.
// Checks every order is delivered with at least 10 s to spare, and that the band and the timer hold.
//   node tools/s7a_deliver_test.mjs [--world grid] [seed] [--raw-nav] [-v]
// --raw-nav: the bot steers as the game's AI does, braking for cars parked in kerb bays (see s7a_lib steer).
// Exits 1 if any check fails.
const args = process.argv.slice(2);
const wi = args.indexOf('--world');
globalThis.KC_WORLD = wi >= 0 ? args[wi + 1] : 'v2';
const SEED = +(args.find(a => /^\d+$/.test(a)) || 5);
const VERBOSE = args.includes('-v');
const { loadPlay, freshSave, makeBot, frame, seed, unseed, topSpeed, M, px } = await import('./s7a_lib.mjs');

const game = await loadPlay();
const { G, world, mis, ent } = game;
game.rawNav = args.includes('--raw-nav');
const V2 = world.KIND !== 'grid';
const DT = 1 / 60, N = 10;
let failed = 0, passed = 0;
const check = (ok, msg) => { if (ok) passed++; else { failed++; console.log('  FAIL ' + msg); } };
const band = V2 ? [px(500), px(1500)] : [900, 3000];
const cap = 0.7 * topSpeed(game, 'ursa');
console.log(`s7a deliveries: ${world.KIND}, ${world.deliveryDoors.length} delivery doors, bot capped at ${(cap / M).toFixed(1)} m/s (70% of the Ursa's ${(topSpeed(game, 'ursa') / M).toFixed(1)})`);

seed(SEED);
freshSave(game);
const kc = world.places.kimchi.curb;
const c = ent.makeCar('ursa', kc.x, kc.y, world.places.kimchi.curb.a ?? 0);
G.cars.push(c); G.player.car = c; G.player.x = kc.x; G.player.y = kc.y;
const DELIVER = mis.MISSIONS.find(m => m.id === 'hot_delivery').steps.find(s => s.type === 'deliver');
mis.startMission({ id: 'deliver_test', title: 'Deliveries', reward: 0, steps: [{ ...DELIVER, count: N }, { type: 'talk', lines: [['Mrs. Park', 'ok']] }] });
const s = mis.missionState.active.s;
const bot = makeBot(game, { deliverCap: cap });
const orders = [];
let n = s.n, left = s.left, len = s.len, timer = s.left, t0 = G.t, result = null;
for (let t = 0; t < N * 200; t += DT) {
  // the bot's car gets wrecked or swapped: keep the orders going in a fresh Ursa (logged)
  frame(game, DT, bot.tick(DT));
  const a = mis.missionState.active;
  if (!a || a.s !== s) { result = a ? 'done' : game.log.big.at(-1)?.[1]; }
  if (result || s.n !== n) {
    orders.push({ len, timer, spare: left, t: G.t - t0, hp: G.player.car?.hp });
    if (VERBOSE) console.log(`  order ${orders.length}: ${(len / M).toFixed(0)} m, timer ${timer.toFixed(1)} s, delivered in ${(G.t - t0).toFixed(1)} s, ${left.toFixed(1)} s to spare`);
    if (result) break;
    n = s.n; len = s.len; timer = s.left; t0 = G.t;
  }
  left = s.left;
}
unseed();
const spares = orders.map(o => o.spare);
console.log(`  ${orders.length} orders: spare ${spares.map(v => v.toFixed(0)).join(' ')} s; routes ${orders.map(o => (o.len / M).toFixed(0)).join(' ')} m`);
check(result === 'done' && orders.length === N, `all ${N} orders should be delivered (${orders.length}, ${result})`);
check(spares.every(v => v >= 10), `every order should arrive with 10 s or more to spare (least ${Math.min(...spares).toFixed(1)} s)`);
check(orders.every(o => Math.abs(o.timer - (o.len / (18 * M) + 20)) < 0.05), 'each timer should be the drive / 18 m/s + 20 s');
check(orders.every(o => o.len >= band[0] && o.len <= band[1]), `each drive should be in the ${V2 ? '500-1500 m' : '900-3000 px'} band`);
console.log(failed ? `s7a deliveries: ${failed} failed, ${passed} passed` : `s7a deliveries: ok (${passed} checks)`);
process.exit(failed ? 1 : 0);
