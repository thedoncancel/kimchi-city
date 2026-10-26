#!/usr/bin/env node
// Stage S7a checks of the story missions' words and set pieces, on both maps (docs/map-v2-spec.md §5, §9).
//   node tools/s7a_missions_test.mjs [baseline-dir] [-v]
// Runs the grid checks here and the Kimchi Key checks in a second node process (the world is chosen when
// world.js loads). Grid: the dialogue and step texts are today's, word for word (compared with the copy in
// baseline-dir, when given). Key:
//  - the dialogue names the Key's places and nothing only the grid has (the island race, the west side lot);
//  - the friends' chat adds their Key lines;
//  - the Red Bandanas stand on open ground in the airboat yard, the stolen Cavallo fits its motor court, the
//    race starts in a lane of the Runway Straight facing the course, and the boss appears 600 m+ away on a
//    highway, boulevard or coast road;
//  - K-Spray resprays the stolen Cavallo even with the cops already lost and no damage;
//  - "Return to Kimchi House" ends at its curb in a car;
//  - a friend dropped off across town is back at her hangout once Kimchi has driven off;
//  - every jar, photo spot and mission marker can be walked to from the villa.
// Exits 1 if any check fails.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
const CHILD = process.env.S7A_KEY === '1';
globalThis.KC_WORLD = CHILD ? 'v2' : 'grid';
const BASE = args.find(a => !a.startsWith('-'));
const VERBOSE = args.includes('-v');
const { loadGame, ROOT } = await import('./s1c_lib.mjs');
const { loadPlay, freshSave, frame, seed, unseed, M, px } = await import('./s7a_lib.mjs');

let failed = 0, passed = 0;
const check = (ok, msg) => { if (ok) passed++; else failed++; if (!ok || VERBOSE) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const game = await loadPlay();
const { G, world, mis, ent, pol, data } = game;
// every line said and every step text, mission by mission
const words = ms => ms.map(m => ({ id: m.id, title: m.title, says: m.steps.flatMap(s => [...(s.lines || []).map(l => l.join(': ')), ...(s.text ? [s.text] : [])]) }));

if (!CHILD) {
  console.log(`s7a missions (${world.KIND})`);
  check(world.KIND === 'grid', 'this half runs on the grid');
  if (BASE) {
    const old = await loadGame(BASE);
    const a = JSON.stringify(words(mis.MISSIONS)), b = JSON.stringify(words(old.mis.MISSIONS));
    check(a === b, `the grid's mission words are today's (${BASE})`);
    if (a !== b) for (const [i, m] of words(mis.MISSIONS).entries()) {
      const o = words(old.mis.MISSIONS)[i];
      m.says.forEach((t, k) => { if (t !== o?.says[k]) console.log(`    ${m.id}: "${t}" was "${o?.says[k]}"`); });
    }
  } else console.log('  (no baseline folder given: the grid words are not compared)');
  check(data.FRIENDS.every(f => f.lines.length === 4), 'the grid friends keep their own 4 lines');
  const yuna = mis.MISSIONS.find(m => m.id === 'yunas_day').steps.find(s => s.type === 'dropoff');
  check(yuna.maxDamage === 20, 'Yuna still minds 20 hp of damage on the grid');
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { env: { ...process.env, S7A_KEY: '1' }, encoding: 'utf8' });
  process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  const m = /s7a missions \(v2\): (\d+) failed|s7a missions \(v2\): ok/.exec(r.stdout);
  if (r.status !== 0) failed++;
  console.log(failed ? `s7a missions: ${failed} failed, ${passed} passed (grid) and the Key ${r.status === 0 ? 'ok' : 'FAILED'}` : `s7a missions: ok (${passed} grid checks, Key ${m ? 'ok' : '?'})`);
  process.exit(failed ? 1 : 0);
}

// ---------- the Kimchi Key ----------
console.log(`s7a missions (${world.KIND})`);
if (world.KIND !== 'v2') { console.log('s7a missions (v2): the v2 world is not READY; nothing to check'); process.exit(0); }
{
  const all = words(mis.MISSIONS).flatMap(m => m.says).join('\n');
  for (const name of ['Seoul Circle', 'Lincoln Road', 'Kimchi Loop', 'Runway Straight', 'airboat yard in the Glades', 'Star Island', 'K-Spray in the Port',
    'Kimchi Fest', 'Alhambra Circle', 'South Pointe']) check(all.includes(name), `the dialogue names ${name}`);
  for (const old of ['around the island', 'west side', 'east parking lot', 'Boutique Row']) check(!all.includes(old), `nothing says "${old}" on the Key`);
  check(data.FRIENDS.every(f => f.lines.length === 4 + f.v2Lines.length && f.v2Lines.every(l => f.lines.includes(l))), 'the friends add their Key lines to their chat');
  const yuna = mis.MISSIONS.find(m => m.id === 'yunas_day').steps.find(s => s.type === 'dropoff');
  check(yuna.maxDamage === 30, 'Yuna minds 30 hp of damage on the 2 km drive');
}

const startSteps = steps => { mis.resetMissions(); G.player.dead = null; mis.startMission({ id: 's7a', title: 'Test', reward: 0, steps: [...steps, { type: 'talk', lines: [['Kimchi', 'ok']] }] }); return mis.missionState.active.s; };
const stepOf = (id, type) => mis.MISSIONS.find(m => m.id === id).steps.find(s => s.type === type);
seed(7);
freshSave(game);

// the Red Bandanas in the airboat yard
{
  const s = startSteps([stepOf('bad_rep', 'kill')]);
  const Y = world.anchors.bandanaYard, r = ent.CFG.playerR;
  const open = s.gang.filter(g => !ent.circleBlocked(g.x, g.y - 4, r));
  check(open.length === 4, `the 4 Red Bandanas stand on open ground (${open.length})`);
  check(s.gang.every(g => Math.hypot(g.x - Y.x, g.y - Y.y) <= Y.r), 'they stand inside the yard\'s 25 m');
  const goto = stepOf('bad_rep', 'goto');
  check(goto.r >= px(25), `arriving within ${(goto.r / M).toFixed(1)} m of the yard counts`);
  mis.failMission('test over');
}
// the stolen Cavallo on Star Island
{
  const s = startSteps([stepOf('paint_job', 'getcar')]);
  const c = s.car;
  check(!ent.carHits(c, c.x, c.y, c.a), 'the stolen Cavallo fits its motor court');
  check(world.regionAt(c.x, c.y) === 'islets', `it is on Star Island (${world.regionAt(c.x, c.y)})`);
  mis.failMission('test over');
}
// the race start
{
  const st = stepOf('street_kings', 'goto').to(), R = world.routes.street_kings;
  const near = world.roads.nearest(st.x, st.y), e = world.roads.edges[near.edge];
  check(e.road === 'loop' && near.d < px(4), `the start line is in a lane of the Kimchi Loop (${e.road}, ${(near.d / M).toFixed(1)} m off its centre)`);
  const q = game.nav.pathPoint(R, px(20), {});
  check(Math.cos(Math.atan2(q.y - st.y, q.x - st.x) - st.a) > 0.9, 'the start faces along the course');
}
// the boss
for (const k of [0, 1, 2]) {
  const p = world.places.kimchi.curb;
  Object.assign(G.player, { x: p.x, y: p.y, car: null });
  const s = startSteps([stepOf('kimchi_empire', 'destroy')]);
  const b = s.car, near = world.roads.nearest(b.x, b.y), cls = world.roads.edges[near.edge].cls;
  check(Math.hypot(b.x - p.x, b.y - p.y) >= px(600) && ['hwy', 'blvd', 'coast'].includes(cls), `boss ${k}: 600 m+ away on a hwy, blvd or coast road (${(Math.hypot(b.x - p.x, b.y - p.y) / M).toFixed(0)} m, ${cls})`);
  mis.failMission('test over');
}
// K-Spray and the mission car
{
  const s = startSteps([stepOf('paint_job', 'getcar'), stepOf('paint_job', 'spray')]);
  const c = s.car;
  G.player.car = c;
  mis.updateMissions(1 / 60);
  const sp = mis.missionState.active.s;
  check(sp.type === 'spray' && c.sprayJob, 'the spray step marks the Cavallo for a respray');
  const bay = world.places.spray.bay;
  Object.assign(c, { x: bay.x, y: bay.y, vx: 0, vy: 0, hp: 160 });
  Object.assign(G, { wanted: 0, money: 1e5 });
  pol.police.sprayLock = false;
  const n0 = G.sprayed || 0, col = c.color;
  pol.updatePolice(1 / 60);
  check((G.sprayed || 0) === n0 + 1 && c.color !== col, 'K-Spray resprays it with no stars and no damage');
  check(c.hp === 160 && !c.sprayJob, 'a respray does not take hp off a car above 100');
  mis.updateMissions(1 / 60);
  check(mis.missionState.active?.s.type === 'talk', 'and the spray step is done');
  mis.failMission('test over');
  // an ordinary car with no stars and no damage is still sent away
  const o = ent.makeCar('sedan', bay.x, bay.y, 0); G.cars.push(o); G.player.car = o; pol.police.sprayLock = false;
  const n1 = G.sprayed;
  pol.updatePolice(1 / 60);
  check(G.sprayed === n1, 'an undamaged car with no stars gets no respray');
  G.player.car = null;
}
// back to Kimchi House by car
{
  const s = startSteps([stepOf('kimchi_empire', 'goto')]);
  const cu = world.places.kimchi.curb, c = ent.makeCar('ursa', cu.x, cu.y, 0);
  G.cars.push(c); G.player.car = c; G.player.x = cu.x; G.player.y = cu.y;
  check(Math.hypot(cu.x - s.pt.x, cu.y - s.pt.y) > s.r, 'Kimchi House\'s curb is out of reach of its door marker');
  mis.updateMissions(1 / 60);
  check(mis.missionState.active?.s !== s, 'stopping at its curb in a car ends "Return to Kimchi House"');
  if (mis.missionState.active) mis.failMission('test over');
  G.player.car = null;
}
// Mochi after the drop-off at Maison K
{
  const f = G.friends.find(q => q.def.id === 'mochi');
  const s = startSteps([stepOf('first_day', 'dropoff')]);
  const cu = world.places.fashion.curb, c = ent.makeCar('ursa', cu.x, cu.y, 0);
  G.cars.push(c); G.player.car = c; G.player.x = cu.x; G.player.y = cu.y;
  Object.assign(f, { following: true, inCar: true, missionFollow: true });
  mis.updateMissions(1 / 60);
  check(!f.inCar && Math.hypot(f.x - cu.x, f.y - cu.y) < px(5), 'Mochi gets out at Maison K');
  mis.failMission('test over');
  for (let t = 0; t < 2; t += 1 / 60) frame(game, 1 / 60, null);
  check(Math.hypot(f.x - f.spot.x, f.y - f.spot.y) > px(500), 'she stays there while Kimchi is close');
  Object.assign(c, { x: cu.x + px(150), y: cu.y }); G.player.x = c.x;
  frame(game, 1 / 60, null);
  check(Math.hypot(f.x - f.spot.x, f.y - f.spot.y) < px(1), 'and is back at the fountain once he has driven 150 m off');
}
// every jar, photo spot and mission marker can be walked to from the villa: a flood fill over the 1 m cells
// where Kimchi's circle fits, then each one's pick-up area (ui.updateJars' box, lifestyle's 110 px, the
// marker's 46 px) must hold a cell it reached
{
  const W = Math.ceil(world.BOUNDS.x1 / M), H = Math.ceil(world.BOUNDS.y1 / M), seen = new Uint8Array(W * H), q = new Int32Array(W * H);
  const free = (i, j) => !ent.circleBlocked((i + 0.5) * M, (j + 0.5) * M - 4, ent.CFG.playerR - 1);
  const foot = world.places.home.foot, s0 = Math.floor(foot.y / M) * W + Math.floor(foot.x / M);
  let h = 0, n = 0;
  q[n++] = s0; seen[s0] = 1;
  while (h < n) {
    const k = q[h++], i = k % W, j = (k - i) / W;
    for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ii = i + a, jj = j + b, m = jj * W + ii;
      if (ii < 0 || jj < 0 || ii >= W || jj >= H || seen[m] || !free(ii, jj)) continue;
      seen[m] = 1; q[n++] = m;
    }
  }
  const near = (x, y, rx, ry) => {
    for (let j = Math.floor((y - ry) / M); j <= Math.floor((y + ry) / M); j++) for (let i = Math.floor((x - rx) / M); i <= Math.floor((x + rx) / M); i++) if (seen[j * W + i]) return true;
    return false;
  };
  const jars = world.jarSpots.filter(j => !near(j.x, j.y + 10, 38, 42)).map(j => j.id);
  const photos = world.photoSpots.filter(s => !near(s.x, s.y, 70, 70)).map(s => s.id);
  const givers = [...new Set(mis.MISSIONS.map(m => m.giver))].filter(k => !near(world.places[k].giver.x, world.places[k].giver.y, 30, 30));
  check(!jars.length, `all ${world.jarSpots.length} jars can be walked to from the villa (${jars.join(' ') || 'every one'})`);
  check(!photos.length, `all ${world.photoSpots.length} photo spots can be walked to (${photos.join(' ') || 'every one'})`);
  check(!givers.length, `every mission marker can be walked to (${givers.join(' ') || 'every one'})`);
}
unseed();
console.log(failed ? `s7a missions (v2): ${failed} failed, ${passed} passed` : `s7a missions (v2): ok (${passed} checks)`);
process.exit(failed ? 1 : 0);
