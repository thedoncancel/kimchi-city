#!/usr/bin/env node
// Stage S8 test: the open-world layer (src/3d/activities.js) on Kimchi Key v2, in node with a bot driving.
//  - the activities are all there; hubs are discovered on the first visit (the villa quietly);
//  - fast travel from a big-map click goes only to found hubs, on foot or in the car, and never while busy;
//  - a speed trap, a speed zone, a drift zone and the jumps score, give stars, pay for new stars and keep the
//    best in G.pr; a worse pass keeps the record, a better one replaces it;
//  - every race board event can be driven to the finish; records, splits and stars are kept; leaving the car
//    abandons an event; the next gate is marked;
//  - G.pr survives save() and load(), and a 2D session (the grid world, save.js as 2d.html uses it) keeps it;
//  - on the grid everything is idle.
//   node tools/s8_test.mjs [-v]   (runs the grid part in a child process; -v lists every check)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GRID = process.argv.includes('--grid');
globalThis.KC_WORLD = GRID ? 'grid' : 'v2';
const { loadS8, fresh, frame, carAt, makeDriver, runEvent, M } = await import('./s8_lib.mjs');
const game = await loadS8();
const { G, world, act, ent, save: SV } = game;
const DT = 1 / 60, S = act.activityState;

let fails = 0, oks = 0;
const VERBOSE = process.argv.includes('-v');
const ok = (cond, msg) => { if (cond) { oks++; if (VERBOSE) console.log('  ok   ' + msg); } else { fails++; console.log('  FAIL ' + msg); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

if (GRID) {
  // ---- the grid: idle; and a 2D session keeps the open-world records ----
  fresh(game, world.places.home.foot.x, world.places.home.foot.y);
  carAt(game, G.player.x, G.player.y, 0, 30);
  for (let i = 0; i < 60; i++) frame(game, DT, { up: true });
  ok(Object.keys(G.pr.found).length === 0 && S.zone === null, 'grid: activities stay idle');
  ok(act.mapPins().length === 0 && act.activityMarks().length === 0, 'grid: no pins or marks');
  ok(act.onBigMapClick(G.player.x, G.player.y, 0.05) === false, 'grid: a map click does nothing');
  ok(act.startEvent('bay_loop') === false, 'grid: no events');
  // 2d.html: the same save.js; a v2 save loaded, played and autosaved keeps every record
  const before = process.env.S8_SAVE;
  if (before) {
    localStorage.setItem('kimchi-city-save-v1', before);
    ok(SV.load(), '2D: load');
    const pr0 = JSON.stringify(JSON.parse(before).pr);
    ok(JSON.stringify(G.pr) === pr0, '2D: G.pr loaded as saved');
    SV.save();
    ok(JSON.stringify(JSON.parse(localStorage.getItem('kimchi-city-save-v1')).pr) === pr0, '2D: the autosave keeps G.pr');
  }
  console.log(`s8 grid: ${oks} ok, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}

const A = world.activities, byId = Object.fromEntries(A.map(a => [a.id, a]));
const count = t => A.filter(a => a.type === t).length;
ok(count('speedTrap') === 3 && count('speedZone') === 3 && count('driftZone') === 4 && count('jump') === 4 && count('eventBoard') === 1 && count('hub') === 5,
  'activities: 3 traps, 3 speed zones, 4 drift zones, 4 jumps, the board, 5 hubs');

// ---- hubs and fast travel ----
const foot = world.places.home.foot;
fresh(game, foot.x, foot.y);
frame(game, DT, {});
ok(G.pr.found.villa && S.pops.length === 0, 'the villa is found at once, quietly');
const seoul = byId.seoul_circle, lincoln = byId.lincoln, fest = byId.fest;
Object.assign(G.player, { x: seoul.x + 20 * M, y: seoul.y });
frame(game, DT, {});
ok(G.pr.found.seoul_circle && S.said.some(p => /FAST TRAVEL/.test(p.kind)), 'Seoul Circle found on the first visit, with a popup');
ok(!G.pr.found.lincoln && !G.pr.found.fest, 'hubs not visited stay hidden');
game.alog.toast.length = 0;
ok(act.onBigMapClick(lincoln.x + 5 * M, lincoln.y, 0.05) === false && /drive there once/.test(game.alog.toast[0] || ''), 'a click on a hub not yet found: no travel, says why');
ok(act.onBigMapClick(1000 * M, 1000 * M, 0.05) === false, 'a click away from any hub does nothing');
Object.assign(G.player, { x: foot.x, y: foot.y });
ok(act.onBigMapClick(seoul.x + 8 * M, seoul.y - 6 * M, 0.05) === true, 'a click on a found hub travels');
const there = Math.hypot(G.player.x - seoul.x, G.player.y - seoul.y) / M;
ok(there < 70 && !ent.circleBlocked(G.player.x, G.player.y - 4, 8), `on foot: arrived ${there.toFixed(1)} m from Seoul Circle, on clear ground`);
// in a car: to the villa (its kerb) and back, the car with him and clear of walls
const car = carAt(game, G.player.x, G.player.y, 0, 0);
ok(act.fastTravel('villa') && G.player.car === car, 'in a car: travels with the car');
const kerb = world.places.home.curb;
ok(Math.hypot(car.x - kerb.x, car.y - kerb.y) < 30 * M && !ent.carHits(car, car.x, car.y, car.a), `the car arrives by the villa (${(Math.hypot(car.x - kerb.x, car.y - kerb.y) / M).toFixed(1)} m from its kerb), clear of walls`);
G.pr.found.fest = { day: 1 };
ok(act.fastTravel('fest') && !ent.carHits(car, car.x, car.y, car.a) && Math.hypot(car.x - fest.x, car.y - fest.y) / M < 40, 'in a car: Fest, on a lane by the hub');
G.wanted = 2; game.alog.toast.length = 0;
ok(act.fastTravel('villa') === false && /cops/.test(game.alog.toast[0] || ''), 'no fast travel while wanted');
G.wanted = 0;
ok(act.fastTravel('kimchi_air') === false, 'no fast travel to a hub not found');

// ---- a speed trap ----
function trapPass(id, v, type = 'ursa') {
  const t = byId[id];
  const c = carAt(game, t.x - Math.cos(t.a) * 60 * M, t.y - Math.sin(t.a) * 60 * M, t.a, v, type);
  for (let i = 0; i < 4 * 60; i++) {
    const fv = (c.vx * Math.cos(c.a) + c.vy * Math.sin(c.a)) / M;
    frame(game, DT, { up: fv < v, down: fv > v + 1 });
  }
  return G.pr.traps[id];
}
fresh(game, 0, 0);
let r = trapPass('st_coral', 30);
ok(r && near(r.best, 108, 6) && r.stars === 0, `st_coral at 30 m/s reads ${r?.best} km/h, no star`);
r = trapPass('st_coral', 40);
ok(r && near(r.best, 144, 6) && r.stars === 2 && G.money === 2000, `st_coral at 40 m/s: ${r?.best} km/h, 2 stars, $2,000 paid (${G.money})`);
ok(S.said.some(p => p.pr === 'NEW RECORD'), 'a better pass: NEW RECORD');
r = trapPass('st_coral', 32);
ok(r.best >= 140 && G.money === 2000, 'a slower pass keeps the record and pays nothing');
r = trapPass('st_runway', 55, 'bolide');
ok(r && r.best >= 190 && r.stars === 3, `st_runway in a Bolide: ${r?.best} km/h, 3 stars`);

// ---- a speed zone: the Rickenbacker, from the Loop ----
function zoneRun(id, type = 'ursa', grip = 0.8, extra = {}) {
  const z = byId[id], P = z.pts, a = Math.atan2(P[3] - P[1], P[2] - P[0]);
  const rt = world.roads.route(P[0] - Math.cos(a) * 250 * M, P[1] - Math.sin(a) * 250 * M, P[0], P[1]);
  const pts = Float32Array.from([...rt.pts.slice(0, -2), ...P]);
  const nav = { pts };
  fresh(game, 0, 0);
  const c = carAt(game, pts[0], pts[1], Math.atan2(pts[3] - pts[1], pts[2] - pts[0]), 10, type);
  const d = makeDriver(game, nav, { grip, ...extra });
  let started = false;
  for (let t = 0; t < 120; t += DT) {
    frame(game, DT, d());
    if (S.zone) started = true;
    else if (started) break;
  }
  return { rec: G.pr.zones[id], c };
}
let z = zoneRun('sz_rick');
ok(z.rec && z.rec.best > 110 && z.rec.best < 165, `sz_rick in the Ursa: ${z.rec?.best} km/h average`);
z = zoneRun('sz_key');
ok(z.rec && z.rec.best > 100, `sz_key in the Ursa: ${z.rec?.best} km/h average`);
// leaving the zone loses the run: start the causeway zone, then turn off the road
fresh(game, 0, 0);
{
  const zz = byId.sz_causeway, P = zz.pts, a = Math.atan2(P[3] - P[1], P[2] - P[0]);
  // in the right-hand lanes, 6 m off the zone's line (the Loop's median)
  const c = carAt(game, P[0] - Math.cos(a) * 20 * M - Math.sin(a) * 6 * M, P[1] - Math.sin(a) * 20 * M + Math.cos(a) * 6 * M, a, 30);
  for (let i = 0; i < 60; i++) frame(game, DT, { up: true });
  ok(S.zone?.z.id === 'sz_causeway', 'crossing the start line starts the causeway zone');
  c.x += Math.sin(a) * 60 * M; c.y -= Math.cos(a) * 60 * M;   // knocked well off the line
  for (let i = 0; i < 90; i++) frame(game, DT, {});
  ok(!S.zone && !G.pr.zones.sz_causeway, 'leaving the zone loses the run');
}

// ---- a drift zone: a driver at the limit through the switchbacks scores ----
z = zoneRun('dz_switch', 'ursa', 1.1);
ok(z.rec && z.rec.best > 1000, `dz_switch: ${z.rec?.best} drift points`);

// ---- the jumps ----
function jumpRun(id, v, back = 70, type = 'bolide') {
  fresh(game, 0, 0);
  const j = byId[id];
  const c = carAt(game, j.x - Math.cos(j.a) * back * M, j.y - Math.sin(j.a) * back * M, j.a, v, type);
  for (let t = 0; t < 8 && !G.pr.jumps[id]; t += DT) {
    const fv = (c.vx * Math.cos(c.a) + c.vy * Math.sin(c.a)) / M;
    frame(game, DT, { up: fv < v });
  }
  return G.pr.jumps[id];
}
r = jumpRun('j_crest', 38);
ok(r && near(r.best, 39, 6) && r.air > 0.8 && r.stars >= 2, `j_crest at 38 m/s: ${r?.best} m, ${r?.air} s air, ${r?.stars} stars`);
r = jumpRun('j_gator', 22);
ok(r && r.best > 10 && r.stars >= 0, `j_gator at 22 m/s: ${r?.best} m`);
r = jumpRun('j_levee', 30);
ok(r && r.best > 18, `j_levee at 30 m/s: ${r?.best} m`);
r = jumpRun('j_port', 30, 30);
ok(r && r.best > 12, `j_port (the container ramp) at 30 m/s: ${r?.best} m`);

// ---- race board events ----
const board = byId.event_board;
function onFootAtBoard(type = 'ursa') {
  fresh(game, board.x, board.y);
  const c = ent.makeCar(type, board.x, board.y, 0); c.owned = true; G.cars.push(c); G.ownedCar = c;
  return c;
}
onFootAtBoard();
ok(act.boardNear(), 'E opens the board at the kiosk');
act.openBoard();
ok(game.alog.menu?.sections?.[0]?.items?.length === 6, 'the board lists 6 events');
let e = runEvent(game, 'runway_drag');
ok(e.done && near(e.t, 16.7, 1) && e.rec.stars === 2 && e.rec.splits.length === 3 && G.money === 10000,
  `runway drag in the Ursa: ${e.t} s, ${e.rec?.stars} stars, 3 splits, $${G.money}`);
G.ownedCar.type = 'bolide';
e = runEvent(game, 'runway_drag');
ok(e.done && e.t < 13.5 && e.rec.stars === 3 && G.money === 15000, `again in the Bolide: ${e.t} s, a new record, 3 stars`);
for (const id of ['deco_sprint', 'hillclimb', 'glades_scramble', 'key_coastal', 'bay_loop']) {
  onFootAtBoard();
  const at = game.alog.travel.length;
  e = runEvent(game, id);
  const to = game.alog.travel[at];
  ok(to && !ent.carHits({ type: 'ursa' }, to.x, to.y, to.a), `${id}: the start line is clear of walls`);
  ok(e.done && e.rec.stars >= 1, `${id} in the Ursa: ${e.t} s, ${e.rec?.stars} stars`);
}
// marks, the countdown hold, and leaving the car
onFootAtBoard();
act.startEvent('deco_sprint');
const E = S.event;
ok(E && E.phase === 'count' && G.player.car && Math.hypot(G.player.car.x - E.R.pts[0], G.player.car.y - E.R.pts[1]) < M, 'the event puts Kimchi in his car on the start line');
frame(game, DT, { up: true });
ok(Math.hypot(G.player.car.vx, G.player.car.vy) === 0, 'the car is held through the countdown');
const mk = act.activityMarks();
ok(mk.length === 2 && mk[0].ring && mk[1].faint, 'the next gate is marked, the one after it faintly');
for (let i = 0; i < 4 * 60; i++) frame(game, DT, { up: true });
ok(S.event?.phase === 'run' && G.activityText?.includes('checkpoint'), 'GO: the clock runs, the objective shows the checkpoint');
G.player.car = null;
frame(game, DT, {});
ok(!S.event && S.said.some(p => /abandoned/.test(p.value)), 'getting out abandons the event');
// the hillclimb starts on the switchbacks' drift zone line: the zone starts with the GO
onFootAtBoard();
act.startEvent('hillclimb');
for (let i = 0; i < 4 * 60; i++) frame(game, DT, {});
ok(S.event?.phase === 'run' && S.zone?.z.id === 'dz_switch' && S.zone.dir === -1, 'the hillclimb\'s GO starts the switchbacks drift zone, uphill');
act.cancelEvent();
G.wanted = 1;
onFootAtBoard(); G.wanted = 1;
ok(act.startEvent('deco_sprint') === false, 'no event while wanted');
G.wanted = 0;
// the board: E in a car at the kiosk still gets out; stars read as earned ones in gold and the rest dimmed
onFootAtBoard();
const atKiosk = carAt(game, board.x, board.y, 0, 0);
ok(G.player.car === atKiosk && !act.boardNear(), 'in a car at the kiosk E is not the board (it gets out)');
G.player.car = null;
G.pr.events = { runway_drag: { best: 14.2, stars: 2, splits: [] } };
act.openBoard();
const items = game.alog.menu.sections[0].items, drag = items.find(it => /Runway/.test(it.label));
ok(items.every(it => !/☆/.test(it.right + it.desc)) && /^<span class="actStars">★★<i>★<\/i><\/span>$/.test(drag.right)
  && /<i>★★★<\/i>/.test(items.find(it => /Deco/.test(it.label)).right), 'the board: earned stars, the rest dimmed, no hollow stars');
ok(/best\u00a00:14\.20 · ★★★\u00a0/.test(drag.desc), `the board gives the record and the next star's time: ${drag.desc}`);
ok(!items.some(it => /Street Kings/.test(it.label)), 'no board event shares the story race\'s name');
G.pr.events = {};
// no car of his own: no event, he stays on foot where he is, and the toast says why
onFootAtBoard(); G.cars.length = 0; G.ownedCar = null; game.noCars = true; game.alog.toast.length = 0;
const stand = { x: G.player.x, y: G.player.y };
act.startEvent('deco_sprint');
ok(!S.event && G.player.x === stand.x && G.player.y === stand.y && /No car/.test(game.alog.toast.at(-1) || ''), 'no car: no event, Kimchi stays put, a toast says why');
game.noCars = false;
// toasts wait through the countdown
onFootAtBoard();
act.startEvent('deco_sprint');
frame(game, DT, {});
const heldInCount = G.holdToasts === true;
for (let i = 0; i < 4 * 60; i++) frame(game, DT, {});
ok(heldInCount && S.event?.phase === 'run' && G.holdToasts === false, 'toasts are held through the countdown and let out at GO');
act.cancelEvent();
// a delivery under way: its clock keeps running, so no free hop and no race
onFootAtBoard(); game.alog.toast.length = 0;
G.pr.found.villa = { day: 1 };
G.job = { b: null, t: 60, total: 60, reward: 100 };
const jobTravel = act.fastTravel('villa'), jobToast = game.alog.toast.at(-1) || '';
ok(jobTravel === false && act.startEvent('deco_sprint') === false && !S.event && /delivery/.test(jobToast) && /delivery/.test(game.alog.toast.at(-1) || ''),
  'no fast travel and no event during a delivery, and a toast says why');
G.job = null;
// heat in the middle of an event ends it
onFootAtBoard();
act.startEvent('deco_sprint');
for (let i = 0; i < 4 * 60; i++) frame(game, DT, {});
const runningBefore = S.event?.phase === 'run';
G.wanted = 2;
frame(game, DT, {});
ok(runningBefore && !S.event && S.said.at(-1)?.value === 'Event abandoned' && /cops/.test(S.said.at(-1)?.sub), 'wanted mid-run: the event is abandoned, the popup says why');
G.wanted = 0;
// a hub found during an event waits for its end; the race's own scores show meanwhile
onFootAtBoard();
act.startEvent('deco_sprint');
for (let i = 0; i < 4 * 60; i++) frame(game, DT, {});
S.pop = null; S.pops.length = 0;
S.pops.push({ kind: 'FAST TRAVEL UNLOCKED', value: 'Test Hub', tone: 'hub' }, { kind: 'SPEED TRAP · Test', value: 150, tone: 'pr' });
let shownInRun = [];
for (let i = 0; i < 8 * 60 && S.event; i++) { frame(game, DT, {}); if (S.pop && !shownInRun.includes(S.pop.value)) shownInRun.push(S.pop.value); }
const hubWaited = S.event && !shownInRun.includes('Test Hub') && shownInRun.includes(150);
act.cancelEvent();
let hubShown = false;
for (let i = 0; i < 12 * 60 && !hubShown; i++) { frame(game, DT, {}); hubShown = S.pop?.value === 'Test Hub'; }
ok(hubWaited && hubShown, `a hub found mid-event waits for its end (shown in the run: ${shownInRun.join(', ')}), then shows`);

// ---- persistence ----
onFootAtBoard();
runEvent(game, 'runway_drag');
trapPass('st_deco', 40);
jumpRun('j_crest', 30);
G.pr.found.seoul_circle = { day: 3 };
const prJSON = JSON.stringify(G.pr);
SV.save();
game.state.resetState();
ok(JSON.stringify(G.pr) === JSON.stringify({ traps: {}, zones: {}, jumps: {}, events: {}, found: {} }), 'a new game starts with no records');
SV.load();
ok(JSON.stringify(G.pr) === prJSON, 'G.pr comes back from the save as it was');
ok(act.mapPins().length === 20, `the big map pins every activity and hub (${act.mapPins().length})`);

console.log(`s8 v2: ${oks} ok, ${fails} failed`);
// the grid part, with this save as the 2D session's
const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--grid'], { env: { ...process.env, S8_SAVE: localStorage.getItem('kimchi-city-save-v1') }, encoding: 'utf8' });
process.stdout.write(child.stdout); process.stderr.write(child.stderr);
process.exit(fails || child.status ? 1 : 0);
