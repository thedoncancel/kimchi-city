#!/usr/bin/env node
// Stage S7b: the minimap, the county map and the GPS on Kimchi Key v2 (docs/map-v2-spec.md §6.6, §11).
//   node tools/s7b_maps_test.mjs [-v]
// Runs src/ui.js and src/3d/hud3d.js in node on the v2 world (tools/s7b_env.mjs: a DOM whose canvases record
// their calls, and frames and timers the test runs by hand) and checks:
//  - the map picture's smaller copies, and that no map ever shrinks a picture more than 2x;
//  - the minimap range: 2600 px at rest, opening to 7200 px at 50 m/s with Kimchi below the middle, the Loop
//    still several px wide;
//  - the GPS: worked out at most once a second, along the roads to the delivery's kerb and door or to the main
//    mission beacon, dropped at once for a new target, following Kimchi along it, drawn on the minimap;
//  - the police search circle and the region-name popup;
//  - the county map: its size, picture, layers (givers, photo spots, spotted jars, GPS, legend), wheel zoom
//    about the cursor, drag, pinch, keys, the 0.5x-4x limits, clicks to the S8 hook, and the time a redraw
//    takes in JavaScript (≤ 2 ms; the browser's drawing is on top of that and is for the lead to time).
import { check, section, note, done, frames, timers, byId, dom } from './s7b_env.mjs';

const W = await import('../src/world.js');
const { G, resetState } = await import('../src/state.js');
const ui = await import('../src/ui.js');
const hud = await import('../src/3d/hud3d.js');
const { police } = await import('../src/3d/police.js');
const PX = W.PX_PER_M;

check('the world is v2', W.KIND === 'v2', W.KIND);
let t0 = performance.now();
W.generate();
note(`generate ${(performance.now() - t0).toFixed(0)} ms`);
resetState();
Object.assign(G, { mode: 'play', t: 10, friends: [], cars: [], peds: [], ownedCar: null, missionBeacons: [], wanted: 0 });

// ---------- the map picture and its copies ----------
section('map picture');
t0 = performance.now();
const full = ui.mapPicture();
note(`mapImage ${(performance.now() - t0).toFixed(0)} ms`);
check('full picture: 1 px per metre, 2048x1792', full.canvas.width === 2048 && full.canvas.height === 1792 && full.k * PX === 1, `${full.canvas.width}x${full.canvas.height} k ${full.k}`);
const half = ui.mapPicture(0.5), quarter = ui.mapPicture(0.2);
check('half copy at 0.5 px/m: 1024x896', half.canvas.width === 1024 && half.canvas.height === 896 && half.k * PX === 0.5);
check('quarter copy for anything coarser: 512x448', quarter.canvas.width === 512 && quarter.k * PX === 0.25);
check('the copies are made once', ui.mapPicture(0.3) === half && ui.mapPicture(0.01) === quarter && ui.mapPicture(5) === full);
const shrink = d => { const p = ui.mapPicture(d); return p.k * PX / d; };
let worstShrink = 0;
for (let d = 0.26; d <= 3; d += 0.01) worstShrink = Math.max(worstShrink, shrink(d));
check('no picture is shrunk more than 2x (0.26-3 px/m)', worstShrink <= 2 + 1e-9, worstShrink.toFixed(3));
const halfLog = half.canvas.log.find(c => c[0] === 'drawImage');
check('a copy is drawn from the one above it, at high quality', !!halfLog && half.canvas.log.some(c => c[0] === '=imageSmoothingQuality' && c[1] === 'high'));

// ---------- the minimap ----------
section('minimap');
const mm = byId('minimap');
mm.width = mm.height = 380;
const home = W.places.home;
const drive = (n, v, a = 0, dt = 1 / 60) => {
  for (let i = 0; i < n; i++) {
    G.t += dt;
    if (G.player.car) { G.player.car.vx = Math.cos(a) * v * PX; G.player.car.vy = Math.sin(a) * v * PX; }
    mm.log.length = 0;
    hud.drawMinimap(a, a, [], []);
  }
};
Object.assign(G.player, { x: home.foot.x, y: home.foot.y, car: null, heading: 0 });
drive(30, 0);
const scaleCall = () => mm.log.find(c => c[0] === 'scale');
const pictureCall = () => mm.log.find(c => c[0] === 'drawImage');
let sc = scaleCall();
check('at rest the range is 2600 px', Math.abs(sc[1] - (190 / 2600) / full.k) < 1e-9, String(sc[1]));
check('at rest the full picture is used', pictureCall()[1].canvas === '2048x1792');
check('at rest Kimchi is in the middle', mm.log.find(c => c[0] === 'translate')[2] === 190);
G.player.car = { x: home.foot.x, y: home.foot.y, vx: 0, vy: 0, a: 0, type: 'ursa' };
drive(60 * 6, 50);
sc = scaleCall();
const pic = ui.mapPicture((190 / 7200) * PX);
const k50 = sc[1] * pic.k;   // canvas px per sim px
check('at 50 m/s the range opens to 7200 px', Math.abs(190 / k50 - 7200) < 15, (190 / k50).toFixed(0));
check('at 50 m/s Kimchi sits below the middle', Math.abs(mm.log.find(c => c[0] === 'translate')[2] - (190 + 190 * 0.35)) < 1, String(mm.log.find(c => c[0] === 'translate')[2]));
const dens50 = k50 * PX, used = pictureCall()[1].canvas;
check('at 50 m/s the half copy is used (never shrunk more than 2x)', used === '1024x896' && 0.5 / dens50 <= 2, `${used} at ${dens50.toFixed(3)} px/m`);
// how wide the roads read: canvas px are half css px (the minimap is 190 css px on a 380 canvas)
const cssPerM = dens50 / 2;
const hw = cls => { const e = W.roads.edges.find(q => q.cls === cls); return e ? e.halfW / PX : 0; };
const loopCss = (2 * hw('hwy') + 5) * cssPerM, streetCss = 2 * hw('street') * cssPerM;
note(`at 50 m/s: ${cssPerM.toFixed(3)} css px/m; the Loop ${loopCss.toFixed(1)} css px wide with its casing, a street ${streetCss.toFixed(1)}`);
check('at 50 m/s the Loop is still at least 3 css px wide', loopCss >= 3, loopCss.toFixed(2));
drive(60 * 4, 0);
check('stopping closes the range again', Math.abs(190 / (scaleCall()[1] * full.k) - 2600) < 30);
G.player.car = null;

// ---------- the GPS ----------
section('GPS');
const job = W.buildings.filter(b => !b.place && b.curb).sort((a, b) => Math.hypot(b.door.x - home.foot.x, b.door.y - home.foot.y) - Math.hypot(a.door.x - home.foot.x, a.door.y - home.foot.y))[0];
G.job = { b: job, t: 99, total: 99, reward: 1 };
const r0 = hud.gps.routes;
drive(60 * 5 + 1, 0);
const nRoutes = hud.gps.routes - r0;
check('over 5 s the route is worked out at most once a second', nRoutes >= 5 && nRoutes <= 6, String(nRoutes));
const g = hud.gps;
check('the GPS has a route to the delivery', !!g.pts && g.n >= 2, String(g.n));
const lastX = g.pts[2 * g.n - 2], lastY = g.pts[2 * g.n - 1];
check('it ends at the delivery door, in the job colour', lastX === Math.fround(job.door.x) && lastY === Math.fround(job.door.y) && g.color === '#ff5a3a');
// every 2 m along the line (but the last hop, from the kerb to the door) is on a road
let off = 0, samples = 0, worstOff = 0;
for (let i = 0; i < g.n - 2; i++) {
  const ax = g.pts[2 * i], ay = g.pts[2 * i + 1], bx = g.pts[2 * i + 2], by = g.pts[2 * i + 3];
  const L = Math.hypot(bx - ax, by - ay), m = Math.max(1, Math.ceil(L / (2 * PX)));
  for (let j = 0; j < m; j++) {
    const x = ax + (bx - ax) * j / m, y = ay + (by - ay) * j / m, q = W.roads.nearest(x, y);
    samples++;
    const over = q ? q.d - W.roads.edges[q.edge].halfW : Infinity;
    worstOff = Math.max(worstOff, over);
    if (over > 8 * PX) off++;
  }
}
check('the line follows the roads (every 2 m within 8 m of a carriageway)', off === 0, `${off} of ${samples} samples off; worst ${(worstOff / PX).toFixed(1)} m past the edge`);
const rawLen = W.roads.route(home.foot.x, home.foot.y, job.curb.x, job.curb.y, { time: true });
note(`route ${(rawLen.len / PX).toFixed(0)} m: ${rawLen.pts.length / 2} points thinned to ${g.n}`);
check('the line is thinned to far fewer points', g.n < rawLen.pts.length / 2 / 3);
// drawn on the minimap from Kimchi: a moveTo at him, a lineTo per point after the one he passed, two strokes
const moveAt = mm.log.findIndex(c => c[0] === 'moveTo' && c[1] === G.player.x && c[2] === G.player.y);
const strokeAt = mm.log.findIndex((c, i) => i > moveAt && c[0] === 'stroke');
const lines = mm.log.slice(moveAt, strokeAt).filter(c => c[0] === 'lineTo').length;
check('the minimap draws the route from Kimchi', moveAt >= 0 && lines === g.n - g.i - 1, `moveTo ${moveAt}, ${lines} lineTo for ${g.n - g.i - 1}`);
check('on a dark casing, then the target colour', mm.log.some(c => c[0] === '=strokeStyle' && c[1] === '#ff5a3a'));
// Kimchi drives the route: the line follows him and never goes back
let back = 0, lastI = 0;
drive(1, 0, 0, 1);   // a fresh route from where he stands, so the walk below fits inside one second
const t1 = hud.gps.t;
for (let i = 1; i < g.n - 1 && G.t - t1 < 0.9; i++) {
  const x = g.pts[2 * i], y = g.pts[2 * i + 1];
  for (let s = 0; s < 4; s++) {
    G.player.x = x + (g.pts[2 * i + 2] - x) * s / 4; G.player.y = y + (g.pts[2 * i + 3] - y) * s / 4;
    drive(1, 0, 0, 0.004);
    if (hud.gps.i < lastI) back++;
    lastI = hud.gps.i;
  }
}
check('as Kimchi drives on, the line starts at the point ahead of him', back === 0 && lastI > 0, `i ${lastI}, back ${back}`);
// a mission beacon outranks the delivery; small and faint ones are not targets
G.missionBeacons = [{ x: 1, y: 1, color: '#e23b2b', small: true }, { x: 2, y: 2, color: '#f2c23066', faint: true }, { x: W.places.park.door.x, y: W.places.park.door.y, color: '#f2c230' }];
check('a new target drops the old line at once', (drive(1, 0), hud.gps.pts === null || hud.gps.color === '#f2c230'));
drive(70, 0);
check('the main mission beacon is the target, in its colour', hud.gps.pts && hud.gps.color === '#f2c230'
  && Math.abs(hud.gps.pts[2 * hud.gps.n - 2] - W.places.park.door.x) < 1, hud.gps.color);
G.missionBeacons = [{ x: 5, y: 5, color: '#e23b2b', small: true }];
drive(70, 0);
check('with only small beacons it is back to the delivery', hud.gps.color === '#ff5a3a');
G.missionBeacons = []; G.job = null;
drive(2, 0);
check('no target: no line', hud.gps.pts === null && ui.mapPins.gps === null && mm.log.filter(c => c[0] === 'lineTo').length === 3);   // the arrow's 3

// ---------- police search and region popup ----------
section('police search and regions');
Object.assign(G.player, { x: home.foot.x, y: home.foot.y });
police.search = { x: home.foot.x + 500, y: home.foot.y, r: 1300 };
drive(1, 0);
check('the minimap draws the search circle where the police comb', mm.log.some(c => c[0] === 'arc' && c[1] === police.search.x && c[2] === police.search.y && c[3] === 1300));
check('the big map gets it too', ui.mapPins.search === police.search);
police.search = null;
drive(1, 0);
check('no search, no circle', !mm.log.some(c => c[0] === 'arc' && c[3] === 1300));
drive(90, 0);
check('after 1.2 s in Coral Heights its name shows', hud.regionShown() === 'heights');
const pop = byId('hud').children.at(-1);
check('the popup reads Coral Heights', pop?.children?.[1]?.textContent === 'Coral Heights');
const kt = W.places.kimchi.door;
Object.assign(G.player, { x: kt.x, y: kt.y });
drive(40, 0);
check('not before it has settled', hud.regionShown() === 'heights');
drive(40, 0);
check('then the new region shows', hud.regionShown() === W.regionAt(kt.x, kt.y) && pop.style.opacity === '1'
  && pop.children[1].textContent === W.regions.find(r => r.id === W.regionAt(kt.x, kt.y)).name, `${hud.regionShown()} vs ${W.regionAt(kt.x, kt.y)}`);
drive(60 * 4, 0);
check('and fades after a few seconds', pop.style.opacity === '0');
// open water keeps the region you came from
let sea = null;
for (let y = 200 * PX; y < 1700 * PX && !sea; y += 16 * PX) for (let x = 1300 * PX; x < 1700 * PX; x += 16 * PX) if (W.regionAt(x, y) === 'sea') { sea = { x, y }; break; }
const before = hud.regionShown();
Object.assign(G.player, sea);
drive(120, 0);
check('the sea does not pop up', !!sea && hud.regionShown() === before);

// ---------- the county map ----------
section('county map');
Object.assign(G.player, { x: home.foot.x, y: home.foot.y, heading: 1 });
G.job = { b: job, t: 99, total: 99, reward: 1 };
G.missionBeacons = [];
drive(70, 0);   // a GPS route for the big map
const big = byId('bigmapCanvas');
G.jars = new Set([4]);
for (const id of [3, 4, 5]) G.seen['jar' + id] = true;
ui.mapPins.givers = [{ x: W.places.park.door.x, y: W.places.park.door.y, letter: 'M', title: 'First Day' }];
ui.mapPins.photos = W.photoSpots.slice(0, 5);
const clicks = [];
ui.bigMapHooks.click = (x, y) => { clicks.push({ x, y }); return false; };
big.log.length = 0;
G.bigMap = false;
// the county map draws the region names itself when the picture says it has none (mapImage().labels === false)
W.mapImage().labels = false;
ui.toggleBigMap(true);
check('the map opens', G.bigMap && byId('bigmap').classList.contains('hidden') === false);
check('it fills the window (1280x800 at 2x)', big.width === (1280 - 56) * 2 && big.height === (800 - 92) * 2 && big.style.width === '1224px', `${big.width}x${big.height}`);
const draw = big.log.find(c => c[0] === 'drawImage');
check('it draws the part of the picture in view (a 9-argument drawImage)', !!draw && draw.length === 10, JSON.stringify(draw));
const texts = big.log.filter(c => c[0] === 'fillText').map(c => c[1]);
check('the legend is drawn', ['You', 'Story mission', 'GPS route', 'Photo spot', 'Kimchi jar (spotted)', 'Police search'].every(t => texts.includes(t)), texts.join('|'));
check('givers carry their letter', texts.includes('M'));
const names = W.regions.filter(r => r.id !== 'sea').map(r => r.name.toUpperCase());
check('a picture without names gets every region name drawn over it', names.every(n => texts.includes(n)), names.filter(n => !texts.includes(n)).join(', '));
const fills = big.log.filter(c => c[0] === '=fillStyle').map(c => c[1]);
check('spotted jars not yet found are shown (2), found ones not', fills.filter(f => f === '#d6402b').length === 2 + 1, String(fills.filter(f => f === '#d6402b').length));
check('every photo spot is shown', fills.filter(f => f === '#ff5fa2').length === W.photoSpots.length + 1);
const routeLines = big.log.filter(c => c[0] === 'lineTo').length;
check('the GPS route is drawn', routeLines >= hud.gps.n - hud.gps.i - 1, `${routeLines} lineTo`);
check('the button strip and the hint are there', byId('bigmap').children.length === 1 && byId('bigmap').hint.textContent.includes('zoom'));

// the sim point under a canvas point (css px), read back through a click and the S8 hook
const simUnder = (sx, sy) => {
  clicks.length = 0;
  byId('bigmapCanvas').dispatch('pointerdown', { pointerId: 9, clientX: sx + 104, clientY: sy + 54 });
  byId('bigmapCanvas').dispatch('pointerup', { pointerId: 9, clientX: sx + 104, clientY: sy + 54 });
  frames(3);
  return clicks[0];
};
const settle = () => { let n = 0; while (frames(1) && n < 400) n++; return n; };
settle();
const a0 = simUnder(300, 250);
check('a click goes to the S8 hook in sim px', !!a0 && a0.x > 0 && a0.y > 0, JSON.stringify(a0));
// wheel zoom about the cursor
const canvasEl = byId('bigmapCanvas');
canvasEl.dispatch('wheel', { clientX: 300 + 104, clientY: 250 + 54, deltaY: -300, deltaMode: 0 });
const nFrames = settle();
const a1 = simUnder(300, 250);
check('the wheel zooms smoothly, over several frames', nFrames >= 5 && nFrames < 60, String(nFrames));
check('the point under the cursor stays put', Math.hypot(a1.x - a0.x, a1.y - a0.y) < PX * 0.5, `${((a1.x - a0.x) / PX).toFixed(2)}, ${((a1.y - a0.y) / PX).toFixed(2)} m`);
// drag: the point under the pointer follows it
const b0 = simUnder(600, 400);
canvasEl.dispatch('pointerdown', { pointerId: 1, clientX: 600 + 104, clientY: 400 + 54 });
for (let i = 1; i <= 10; i++) canvasEl.dispatch('pointermove', { pointerId: 1, clientX: 600 - 15 * i + 104, clientY: 400 - 8 * i + 54 });
canvasEl.dispatch('pointerup', { pointerId: 1, clientX: 450 + 104, clientY: 320 + 54 });
frames(2);
const b1 = simUnder(450, 320);
check('a drag moves the map with the pointer', Math.hypot(b1.x - b0.x, b1.y - b0.y) < PX * 0.5, `${((b1.x - b0.x) / PX).toFixed(2)} m`);
check('and is not a click', clicks.length === 1);
// pinch: two fingers spreading to twice their distance zoom 2x about their middle
const zoomOf = () => { const p = simUnder(0, 0), q = simUnder(100, 0); return 100 / (q.x - p.x); };
const zp = zoomOf();
canvasEl.dispatch('pointerdown', { pointerId: 2, clientX: 550 + 104, clientY: 350 + 54 });
canvasEl.dispatch('pointerdown', { pointerId: 3, clientX: 650 + 104, clientY: 350 + 54 });
for (let i = 1; i <= 10; i++) {
  canvasEl.dispatch('pointermove', { pointerId: 2, clientX: 550 - 5 * i + 104, clientY: 350 + 54 });
  canvasEl.dispatch('pointermove', { pointerId: 3, clientX: 650 + 5 * i + 104, clientY: 350 + 54 });
}
canvasEl.dispatch('pointerup', { pointerId: 2, clientX: 500 + 104, clientY: 350 + 54 });
canvasEl.dispatch('pointerup', { pointerId: 3, clientX: 700 + 104, clientY: 350 + 54 });
frames(2);
const zq = zoomOf();
check('a pinch zooms with the fingers', Math.abs(zq / zp - 2) < 0.02 || zq / zp < 2, `${(zq / zp).toFixed(3)}x`);
// limits
for (let i = 0; i < 30; i++) canvasEl.dispatch('wheel', { clientX: 704, clientY: 454, deltaY: -400, deltaMode: 0 });
settle();
const fit = Math.min(1224 / (W.BOUNDS.x1 - W.BOUNDS.x0), 708 / (W.BOUNDS.y1 - W.BOUNDS.y0)) * 0.94;
check('zoom stops at 4x', Math.abs(zoomOf() / fit - 4) < 0.01, (zoomOf() / fit).toFixed(3));
for (let i = 0; i < 30; i++) canvasEl.dispatch('wheel', { clientX: 704, clientY: 454, deltaY: 400, deltaMode: 0 });
settle();
check('and at 0.5x', Math.abs(zoomOf() / fit - 0.5) < 0.01, (zoomOf() / fit).toFixed(3));
const mid = simUnder(612, 354);
check('zoomed out, the county stays in the middle', Math.abs(mid.x - (W.BOUNDS.x1 / 2)) < PX && Math.abs(mid.y - W.BOUNDS.y1 / 2) < PX, `${(mid.x / PX).toFixed(0)}, ${(mid.y / PX).toFixed(0)} m`);
// keys: + zooms in, an arrow pans, C goes back to Kimchi
const keyDown = code => globalThis.dispatch('keydown', { code });
keyDown('Equal'); keyDown('Equal'); keyDown('Equal'); keyDown('Equal'); settle();
const z4 = zoomOf() / fit;
check('+ zooms in', z4 > 2, z4.toFixed(2));
const c0 = simUnder(612, 354);
keyDown('ArrowRight'); settle();
const c1 = simUnder(612, 354);
check('an arrow key pans', c1.x > c0.x + 10 * PX, `${((c1.x - c0.x) / PX).toFixed(0)} m`);
Object.assign(G.player, { x: W.places.park.door.x, y: W.places.park.door.y });
keyDown('KeyC'); settle();
const c2 = simUnder(612, 354);
check('C centres on Kimchi', Math.hypot(c2.x - G.player.x, c2.y - G.player.y) < 2 * PX, `${(Math.hypot(c2.x - G.player.x, c2.y - G.player.y) / PX).toFixed(1)} m off`);
check('names show once zoomed in', big.log.filter(c => c[0] === 'fillText').some(c => String(c[1]).includes(W.places.park.name)));
// a resize redraws at the new size
Object.assign(globalThis, { innerWidth: 900, innerHeight: 700, devicePixelRatio: 1 });
ui.drawBigMap();
check('a resize redraws at the new size', big.width === 900 - 56 && big.height === 700 - 92);
Object.assign(globalThis, { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 2 });
// redraw time in JavaScript (canvas calls cost nothing here: no recording)
dom.record = false;
ui.bigMapStats.worst = 0;
police.search = { x: G.player.x, y: G.player.y, r: 1300 };
for (let i = 0; i < 4; i++) keyDown('Equal');
const times = [];
for (let i = 0; i < 120; i++) { const q = performance.now(); ui.drawBigMap(); times.push(performance.now() - q); if (i % 7 === 0) keyDown(i % 2 ? 'Minus' : 'Equal'); }
times.sort((a, b) => a - b);
dom.record = true;
note(`county map redraw (JS only): median ${times[60].toFixed(3)} ms, p95 ${times[114].toFixed(3)} ms, worst ${times.at(-1).toFixed(3)} ms`);
check('a redraw takes well under 2 ms of JavaScript (p95)', times[114] < 1, times[114].toFixed(3));
// closing: the backdrop and the ✕ button
byId('bigmap').dispatch('pointerdown', {});
check('a tap on the backdrop closes it', !G.bigMap);
ui.toggleBigMap(true);
const btns = byId('bigmap').children[0].children;
btns[0].dispatch('click');
check('the ✕ button closes it', !G.bigMap && btns.length === 4);
police.search = null;

done('s7b maps');
