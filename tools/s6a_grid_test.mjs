#!/usr/bin/env node
// Stage S6a check, part 1: the classic grid still drives exactly as before the v2 physics (docs/map-v2-spec.md
// §10: PHYS.classic keeps today's feel bit for bit). Kimchi drives out of the villa for 20 s on scripted inputs
// (throttle, steering, the handbrake, braking, reverse, an analog stick), through walls, grass and parked cars,
// with the 2D tuning and with the 3D game's (main3d), in the Toro Ursa and the sports car. Every frame's
// position is compared with the pre-change code:
//   - always, with the positions recorded from the untouched pre-rebuild copy, every 0.25 s (TRACES below);
//   - frame by frame against that copy itself when it is given: node tools/s6a_grid_test.mjs --baseline <dir>
// The positions must match within 1 px (they are bit-identical on the same node). --record prints TRACES
// from the copy given with --baseline. Exits 1 if any check fails.
globalThis.KC_WORLD = 'grid';
const { loadGame, seed, ROOT } = await import('./s6a_lib.mjs');

const args = process.argv.slice(2), opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const BASE = opt('--baseline'), RECORD = args.includes('--record');
let failed = 0, passed = 0;
const check = (ok, msg) => { if (ok) passed++; else { failed++; console.log('  FAIL ' + msg); } };
const info = msg => console.log('  ' + msg);

// [seconds, input] in order, 20 s in all: out of the drive, left onto the road, a handbrake turn, across the
// grass, reverse, an analog stick, a handbrake slide, and pinned against a wall at the end
const PROGRAM = [
  [1.3, { up: true }], [0.9, { up: true, left: true }], [2.5, { up: true }], [1, { brake: true, right: true }],
  [2, { up: true, right: true }], [1, { down: true }], [1.5, { down: true }], [3, { up: true, steer: 0.6 }],
  [1.5, { up: true, brake: true, right: true }], [2, { up: true, left: true }], [3.3, { up: true, steer: -0.3 }],
];
const RUNS = [
  ['2d ursa', { carAcc: 1, carMax: 1 }, 'ursa'],
  ['3d ursa', { walk: 88, run: 150, tired: 55, playerR: 8, pedWalk: 15, pedFlee: 95, friendWalk: 15, friendRun: 175, aiLook: 125, carAcc: 0.5, carMax: 0.85 }, 'ursa'],
  ['3d sports', { carAcc: 0.5, carMax: 0.85 }, 'sports'],
];
const EVERY = 15;   // frames between recorded samples
// Recorded from the pre-rebuild copy (--record): x, y px every EVERY frames.
const TRACES = {
  "2d ursa": [
    [1587.2, 1198.93], [1587.2, 1260.27], [1587.2, 1361.6], [1587.2, 1502.93], [1587.2, 1682.78],
    [1636.24, 1877.45], [1806.41, 2002.95], [2021.88, 1989.49], [2177.7, 1845.5], [2306.37, 1665.87],
    [2434.41, 1524.53], [2506.77, 1513.4], [2545.56, 1511.7], [2574.7, 1492.85], [2618.28, 1435.48],
    [2683.77, 1344.61], [2772.33, 1221.06], [2881.94, 1068.05], [3004.51, 905.37], [3123.63, 870.28],
    [3171.88, 910.37], [3170.61, 942.55], [3160.39, 957.17], [3122.08, 974.9], [3042.99, 956.06],
    [2970.45, 859.86], [2957.13, 817.13], [2956.13, 807.14], [2959.31, 807.14], [2963.31, 807.14],
    [2967.22, 807.99], [2966.91, 826.46], [2963.6, 868.11], [2958.6, 927.97], [2953.46, 989], [2948.33, 1050.04],
    [2943.19, 1111.07], [2937.55, 1165.83], [2932.1, 1195.38], [2924.32, 1232.21], [2915.54, 1275.34],
    [2914.22, 1271.64], [2926.45, 1226.66], [2980.36, 1159.25], [3092.09, 1100.96], [3257.31, 1090.42],
    [3441.43, 1158.03], [3593.02, 1304.95], [3674.29, 1507.27], [3665.96, 1728.36], [3567.58, 1928.19],
    [3395.75, 2071], [3324.2, 2133.9], [3306.76, 2166.58], [3304.59, 2173.98], [3304.59, 2165.98],
    [3304.59, 2151.31], [3304.59, 2131.73], [3304.59, 2109.35], [3303.87, 2098.5], [3302.92, 2092.76],
    [3302.3, 2090.26], [3302.3, 2090.43], [3302.3, 2091.21], [3302.3, 2092.08], [3302.3, 2092.97],
    [3302.3, 2093.86], [3302.3, 2094.8], [3302.3, 2095.76], [3302.3, 2096.73], [3302.3, 2097.69],
    [3302.3, 2098.66], [3302.3, 2099.62], [3302.3, 2100.59], [3302.3, 2101.55], [3302.3, 2102.52],
    [3302.3, 2103.48], [3302.3, 2104.45], [3302.3, 2105.42], [3302.3, 2106.38]
  ],
  "3d ursa": [
    [1587.2, 1188.27], [1587.2, 1218.93], [1587.2, 1269.6], [1587.2, 1340.27], [1587.2, 1430.93],
    [1614.34, 1536.2], [1717.9, 1611.47], [1864.63, 1601.27], [1982.32, 1492.32], [2013.16, 1375.25],
    [2013.5, 1298.28], [2013.5, 1244.29], [2013.68, 1202.64], [2014.58, 1167.74], [2034.03, 1130.46],
    [2069.17, 1079.82], [2116.59, 1013.38], [2175.76, 930.75], [2247.28, 836], [2318.14, 815], [2347.6, 838.2],
    [2352.43, 856.96], [2351.53, 867.43], [2343.01, 888.35], [2309.49, 913.55], [2248.07, 910.93],
    [2188.11, 856.38], [2168.23, 819.66], [2163.63, 809.89], [2163.52, 806.62], [2164.28, 807.05],
    [2164.17, 816.4], [2163.32, 837.74], [2161.94, 871.06], [2160.06, 916.37], [2157.89, 968.36],
    [2155.73, 1020.38], [2153.57, 1072.4], [2152.05, 1108.81], [2151.19, 1113.16], [2150.82, 1112.82],
    [2152.57, 1098.13], [2165.31, 1065.92], [2203.31, 1026.97], [2272.25, 999.34], [2366.31, 1002.81],
    [2468.66, 1052.96], [2549.43, 1106.25], [2579.63, 1140.35], [2581.02, 1203.36], [2580.98, 1283.33],
    [2580.98, 1375.2], [2575.39, 1471.29], [2546.5, 1541.3], [2481.65, 1549.03], [2446.79, 1514.39],
    [2436.04, 1511.63], [2432.33, 1511.63], [2434.24, 1511.63], [2436.92, 1511], [2438.5, 1510.53],
    [2439.1, 1510.06], [2439.17, 1510.06], [2439.15, 1510.06], [2439.11, 1510.06], [2439.06, 1510.06],
    [2439.02, 1510.06], [2438.94, 1510.06], [2438.86, 1510.06], [2438.78, 1510.06], [2438.7, 1510.06],
    [2438.62, 1510.06], [2438.53, 1510.06], [2438.45, 1510.06], [2438.37, 1510.06], [2438.29, 1510.06],
    [2438.2, 1510.06], [2438.12, 1510.06], [2438.04, 1510.06], [2437.95, 1510.06]
  ],
  "3d sports": [
    [1587.2, 1188.93], [1587.2, 1221.52], [1587.2, 1275.35], [1587.2, 1350.43], [1587.2, 1446.77],
    [1619.86, 1556.89], [1738.89, 1620.97], [1886.98, 1574.57], [1967.02, 1425.56], [2010.85, 1261.82],
    [2030, 1126.62], [2056.17, 1001.63], [2093.24, 858.87], [2123.72, 817.75], [2133.76, 806.32],
    [2140.79, 802.57], [2144.87, 802.57], [2148.31, 802.57], [2151.6, 802.63], [2154.24, 802.99],
    [2156.16, 803.35], [2157.58, 803.66], [2158.74, 803.36], [2162.32, 802.8], [2166.48, 802.8], [2170.73, 802.8],
    [2175, 802.8], [2179.28, 802.8], [2183.55, 802.8], [2187.82, 802.8], [2191.82, 803.13], [2190.32, 811.34],
    [2183.73, 831.29], [2172.89, 863.26], [2157.92, 907.29], [2140.26, 959.23], [2122.54, 1011.34],
    [2104.82, 1063.44], [2090.82, 1104.61], [2082.47, 1115.84], [2078.53, 1116.23], [2084.52, 1100.83],
    [2109.98, 1073.27], [2164.75, 1052.69], [2243.76, 1061.98], [2326.13, 1117.46], [2372.28, 1117.24],
    [2389.94, 1117.24], [2400.09, 1117.24], [2408.38, 1117.24], [2416.21, 1117.24], [2423.93, 1117.24],
    [2431.82, 1117.24], [2444.48, 1117.24], [2462.37, 1117.24], [2484.05, 1117.24], [2508.45, 1117.24],
    [2534.82, 1117.24], [2562, 1118.27], [2590.01, 1132.33], [2640.19, 1129.86], [2688.36, 1078.01],
    [2684.27, 986.66], [2600.65, 911.96], [2468.15, 921.11], [2369.05, 1037.82], [2365.5, 1105.24],
    [2368.45, 1111.3], [2369.31, 1119.48], [2370.19, 1119.48], [2371.18, 1119.48], [2372.19, 1119.48],
    [2373.2, 1119.48], [2374.21, 1119.48], [2375.22, 1119.48], [2376.22, 1119.48], [2377.23, 1119.48],
    [2378.24, 1119.48], [2379.25, 1119.48], [2380.26, 1119.48]
  ],
};

// 20 s of scripted driving from the villa's drive: [x, y, a, vx, vy, hp] every frame. The car cannot be
// wrecked (hp starts huge) so it drives all 20 s; every third parked bay holds a sedan to bump into.
function trace(game, cfg, type) {
  const { G, ent, world } = game;
  seed(77);
  Object.assign(ent.CFG, cfg);
  Object.assign(G, { mode: 'play', cars: [], peds: [], friends: [], energy: 100, shake: 0 });
  const s = world.places.home.spawn;
  for (let i = 0; i < world.parkedSpawns.length; i += 3) { const p = world.parkedSpawns[i]; G.cars.push(ent.makeCar('sedan', p.x, p.y, p.a)); }
  const c = ent.makeCar(type, s.x, s.y, s.a);
  c.hp = 1e6;
  G.cars.push(c);
  Object.assign(G.player, { car: c, x: s.x, y: s.y, dead: false });
  const out = [], dt = 1 / 60;
  for (const [dur, inp] of PROGRAM) {
    for (let f = 0; f < Math.round(dur * 60); f++) {
      ent.updatePlayer(dt, inp);
      for (const o of G.cars) if (!o.ai && o !== G.player.car && !o.managed) ent.moveCar(o, dt);
      out.push([c.x, c.y, c.a, c.vx, c.vy, c.hp]);
    }
  }
  return out;
}

const game = await loadGame(ROOT);
check(game.world.KIND === 'grid', `the grid world is loaded (${game.world.KIND})`);
check(game.world.PHYS.gripG === 0 && game.world.PHYS.wall === 'axis' && !game.world.PHYS.air && !game.world.PHYS.slope, 'the grid runs PHYS.classic');
check(game.ent.CFG.gripG === 0, `CFG.gripG starts at the grid's 0, so there is no yaw cap (${game.ent.CFG.gripG})`);
const base = BASE ? await loadGame(BASE) : null;

if (RECORD) {
  if (!base) { console.log('--record needs --baseline <dir>'); process.exit(1); }
  const rec = {};
  for (const [name, cfg, type] of RUNS) rec[name] = trace(base, cfg, type).filter((_, i) => i % EVERY === EVERY - 1).map(p => [+p[0].toFixed(2), +p[1].toFixed(2)]);
  console.log(JSON.stringify(rec));
  process.exit(0);
}

console.log('scripted 20 s drives from the villa');
for (const [name, cfg, type] of RUNS) {
  const now = trace(game, cfg, type), rec = TRACES[name];
  let worst = 0;
  rec.forEach(([x, y], k) => { const p = now[k * EVERY + EVERY - 1]; worst = Math.max(worst, Math.hypot(p[0] - x, p[1] - y)); });
  const end = now[now.length - 1], moved = Math.hypot(end[0] - now[0][0], end[1] - now[0][1]);
  info(`${name}: ${now.length} frames, ends ${(moved / 16).toFixed(0)} m from the start, ${(1e6 - end[5]).toFixed(1)} hp of knocks; worst gap to the recorded drive ${worst.toFixed(3)} px`);
  check(rec.length === now.length / EVERY, `${name}: the recorded drive has ${now.length / EVERY} samples (${rec.length})`);
  check(worst <= 1, `${name}: matches the pre-change drive within 1 px (${worst.toFixed(3)} px)`);
  if (base) {
    const then = trace(base, cfg, type);
    let gap = 0, same = true;
    for (let i = 0; i < then.length; i++) {
      gap = Math.max(gap, Math.hypot(now[i][0] - then[i][0], now[i][1] - then[i][1]));
      for (let k = 0; k < 6; k++) if (now[i][k] !== then[i][k]) same = false;
    }
    info(`${name}: against ${BASE}: worst gap ${gap} px, ${same ? 'bit-identical' : 'not bit-identical'}`);
    check(gap <= 1, `${name}: matches the pre-change code frame by frame within 1 px (${gap} px)`);
  }
}

console.log(failed ? `s6a grid: ${failed} failed, ${passed} passed` : `s6a grid: ok (${passed} checks)`);
process.exit(failed ? 1 : 0);
