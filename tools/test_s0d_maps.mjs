#!/usr/bin/env node
// Stage S0d: the minimap, the big map and the jar HUD moved onto the world API (mapImage, BOUNDS,
// jarSpots) without changing anything on the grid (docs/map-v2-spec.md §6.6 and §8).
//   node tools/test_s0d_maps.mjs [baselineDir]
// It loads today's src/ui.js and src/3d/hud3d.js and the copies in baselineDir (the code before the v2
// rebuild; default: $KC_BASELINE) side by side in node, with a tiny DOM whose canvases record every 2D
// call, and checks that both draw the same calls for the same game state:
//  - the 2D minimap and the big map (2D and 3D) draw identically, except that the big-map arrow follows
//    p.heading when the 3D game sets it;
//  - the 3D round minimap draws identically;
//  - the map picture is today's minimap at a different scale, tile for tile, and nearest-neighbour
//    sampling picks the same tile from either picture at every size we draw;
//  - the jar toasts and the HUD jar text read the same (n/25, ALL 25).
// Without a baseline it runs only the checks that need none.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || process.env.KC_BASELINE || '';

// the baseline copy has no node_modules: 'three' always resolves to this checkout's copy
const THREE = pathToFileURL(path.join(ROOT, 'node_modules/three/build/three.module.js')).href;
registerHooks({ resolve: (spec, ctx, next) => (spec === 'three' ? { url: THREE, shortCircuit: true } : next(spec, ctx)) });

// ---------- a tiny DOM: elements by id, canvases that record their 2D calls ----------
function recorder(canvas) {
  const state = {}, log = canvas.log;
  const norm = a => (a && a.isStubCanvas ? 'canvas' : a);   // numbers stay exact: same pixels need the same floats
  return new Proxy({}, {
    get(_, k) {
      if (k in state) return state[k];
      return (...args) => { log.push([k, ...args.map(norm)]); return k === 'measureText' ? { width: 0 } : undefined; };
    },
    set(_, k, v) { state[k] = v; log.push(['=' + String(k), norm(v)]); return true; },
  });
}
function element(id, tag = 'div') {
  const el = {
    id, tag, style: {}, children: [], dataset: {}, textContent: '', innerHTML: '', className: '', offsetWidth: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, appendChild(c) { appended.push(c); return c; }, append() {}, remove() {},
    querySelector: () => element('q'),
  };
  if (tag === 'canvas') {
    Object.assign(el, { isStubCanvas: true, width: 300, height: 150, log: [] });
    let ctx = null;
    el.getContext = () => (ctx ||= recorder(el));
  }
  return el;
}
const appended = [];
const ids = {};
globalThis.document = {
  getElementById: id => (ids[id] ||= element(id, /minimap|Canvas$/.test(id) ? 'canvas' : 'div')),
  createElement: tag => element('', tag),
  body: element('body'),
};
globalThis.window = { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 2 };
globalThis.Image = class { constructor() { this.complete = false; } };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.setTimeout = () => 0;   // toasts fade out on timers; nothing here needs them

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function firstDiff(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return `call ${i}: ${JSON.stringify(a[i])} vs ${JSON.stringify(b[i])}`;
  }
  return '';
}

// ---------- load one copy of the game modules (today's, or the baseline's) ----------
async function loadGame(dir) {
  const url = f => pathToFileURL(path.join(dir, f)).href;
  const st = await import(url('src/state.js'));
  const world = await import(url('src/world.js'));
  const ui = await import(url('src/ui.js'));
  const hud = await import(url('src/3d/hud3d.js'));
  world.generate();
  return { G: st.G, resetState: st.resetState, world, ui, hud };
}

// the same game state on both copies: a few jars found and seen, a delivery job, a friend-less street
function setScene(g, { heading } = {}) {
  const { G, world } = g;
  g.resetState();
  const home = world.places.home.door;
  Object.assign(G.player, { x: home.x + 333.5, y: home.y + 141.25, face: -1, car: null });
  if (heading === undefined) delete G.player.heading; else G.player.heading = heading;
  G.t = 12.345; G.wanted = 0; G.friends = []; G.cars = []; G.peds = []; G.ownedCar = null;
  G.jars = new Set([1, 4, 9]);
  for (const id of [2, 4, 7, 11]) G.seen['jar' + id] = true;
  G.job = { b: world.buildings.find(b => !b.place && b.id > 40), t: 30, total: 40, reward: 100 };
}

function drawLog(g, which, opts = {}) {
  setScene(g, opts);
  const c = document.getElementById(which === 'big' ? 'bigmapCanvas' : 'minimap');
  if (which === '2d') { c.width = c.height = 180; c.log.length = 0; g.ui.drawMinimap(); }
  else if (which === 'big') { c.log.length = 0; g.ui.drawBigMap(); }
  else {
    c.width = c.height = 380; c.log.length = 0;
    g.hud.drawMinimap(0.7, opts.heading ?? 2.1, [{ x: 3000, y: 2500, letter: 'R' }], [{ x: 2000, y: 1800 }]);
  }
  return c.log.slice();
}

const now = await loadGame(ROOT);
const base = BASE && existsSync(path.join(BASE, 'src/ui.js')) ? await loadGame(BASE) : null;
if (!base) console.log('note: no baseline given (argument or KC_BASELINE), so only the checks that need none run');

// ---------- the map picture ----------
const W = now.world;
const img = W.mapImage();
check('mapImage() on the grid: k = 4/64, origin (0,0), N*4 px square', img.k === 4 / 64 && img.x0 === 0 && img.y0 === 0
  && img.canvas.width === W.N * 4 && img.canvas.height === W.N * 4, JSON.stringify({ k: img.k, w: img.canvas.width }));
check('mapImage() spans BOUNDS exactly', img.canvas.width / img.k === W.BOUNDS.x1 - W.BOUNDS.x0 && img.canvas.height / img.k === W.BOUNDS.y1 - W.BOUNDS.y0);
check('mapImage() is built once and reused after generate', W.mapImage() === img);

// The old 2D minimap was makeMinimap() at 2 px per tile, the new one is the 4 px picture. Every tile is
// one flat colour in both, so nearest-neighbour sampling of either gives the same colour when it picks the
// same tile: check that for every pixel of every square size the minimap and big map can have.
let worst = '';
for (let S = 60; S <= 4000 && !worst; S++) {
  for (let i = 0; i < S; i++) {
    const t2 = Math.floor((i + 0.5) * (W.N * 2) / S / 2), t4 = Math.floor((i + 0.5) * (W.N * 4) / S / 4);
    if (t2 !== t4) { worst = `S=${S} px ${i}: tile ${t2} vs ${t4}`; break; }
  }
}
check('nearest sampling picks the same tile from the 2 px and 4 px pictures (S 60..4000)', !worst, worst);

// the 4 px picture is the 2 px one scaled: same fills in the same order
const scaledFills = (canvas, s) => canvas.log.filter(c => c[0] === 'fillRect' || c[0] === '=fillStyle')
  .map(c => (c[0] === 'fillRect' ? ['fillRect', ...c.slice(1).map(v => v / s)] : c));
const pic2 = W.makeMinimap(2);
check('the map picture is makeMinimap(2) scaled to 4 px per tile, fill for fill',
  same(scaledFills(img.canvas, 4), scaledFills(pic2, 2)), firstDiff(scaledFills(img.canvas, 4), scaledFills(pic2, 2)));

// ---------- minimaps and big map against the baseline ----------
const mapSrc = log => log.filter(c => c[0] === 'drawImage');
if (base) {
  const a = drawLog(base, '2d'), b = drawLog(now, '2d');
  check('2D minimap (180 px) draws the same calls as before', same(a, b), firstDiff(a, b));
  check('2D minimap draws the picture over the whole square', same(mapSrc(b), [['drawImage', 'canvas', 0, 0, 180, 180]]), JSON.stringify(mapSrc(b)));

  for (const dpr of [1, 1.25, 2]) for (const [w, h] of [[1280, 800], [390, 844], [2560, 1440]]) {
    Object.assign(window, { innerWidth: w, innerHeight: h, devicePixelRatio: dpr });
    const a1 = drawLog(base, 'big'), b1 = drawLog(now, 'big');
    check(`big map ${w}x${h} @${dpr}x (no heading) draws the same calls as before`, same(a1, b1), firstDiff(a1, b1));
  }
  Object.assign(window, { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 2 });

  // the 3D game keeps p.heading: the big-map arrow now points along it, and nothing else changes
  const a2 = drawLog(base, 'big', { heading: 2.25 }), b2 = drawLog(now, 'big', { heading: 2.25 });
  const diffs = a2.map((c, i) => [c, b2[i]]).filter(([x, y]) => !same(x, y));
  check('3D big map: only the arrow rotation changes, to p.heading', a2.length === b2.length && diffs.length === 1
    && same(diffs[0][0], ['rotate', Math.PI]) && same(diffs[0][1], ['rotate', 2.25]), JSON.stringify(diffs));

  const a3 = drawLog(base, '3d'), b3 = drawLog(now, '3d');
  check('3D round minimap (380 px) draws the same calls as before', same(a3, b3), firstDiff(a3, b3));
  for (const heading of [0, 1, -2.5]) {
    const a4 = drawLog(base, '3d', { heading }), b4 = drawLog(now, '3d', { heading });
    if (!same(a4, b4)) check(`3D round minimap, heading ${heading}`, false, firstDiff(a4, b4));
  }
}

// ---------- jars ----------
const toasts = () => appended.filter(e => e.className === 'toast').map(e => e.textContent);
function jarRun(g) {
  g.resetState();
  const { G, world, ui } = g;
  G.friends = []; G.jars = new Set([3, 99]);   // 99: an id this map has no jar for
  appended.length = 0;
  const out = [];
  for (const j of world.jarSpots) {
    if (G.jars.has(j.id)) continue;
    Object.assign(G.player, { x: j.x, y: j.y + 10 });
    ui.updateJars();
    G.missionText = null; G.job = null; G.energy = 100; G.money = 9e6; G.stats.deliveries = 1;
    ui.updateHUD();
    out.push(document.getElementById('objective').textContent);
  }
  return { toasts: toasts(), hud: out, money: G.money };
}
const jn = jarRun(now);
check('jar toasts count jars on the map, not G.jars.size', jn.toasts[0] === '🫙 Kimchi jar found! +$1,000 (2/25)', jn.toasts[0]);
check('the last jar reads ALL 25', jn.toasts.at(-1) === '🏆 ALL 25 golden kimchi jars found! +$25,000 bonus!', jn.toasts.at(-1));
check('HUD jar text is n/25', jn.hud[0].startsWith('🫙 2/25 jars') && jn.hud.at(-1).startsWith('🫙 25/25 jars'), `${jn.hud[0]} … ${jn.hud.at(-1)}`);
check('jarsFound() ignores ids with no jar', now.ui.jarsFound() === 25 && now.G.jars.size === 26);
if (base) {
  // with only real jar ids in the save, the text is word for word what it was
  const run = g => {
    g.resetState(); g.G.friends = []; g.G.jars = new Set([3]); appended.length = 0;
    const hud = [];
    for (const j of g.world.jarSpots) {
      if (g.G.jars.has(j.id)) continue;
      Object.assign(g.G.player, { x: j.x, y: j.y + 10 }); g.ui.updateJars();
      Object.assign(g.G, { missionText: null, job: null, energy: 100, money: 9e6 }); g.G.stats.deliveries = 1;
      g.ui.updateHUD(); hud.push(document.getElementById('objective').textContent);
    }
    return { toasts: toasts(), hud };
  };
  const ra = run(base), rb = run(now);
  check('jar toasts read the same as before (n/25, ALL 25)', same(ra.toasts, rb.toasts), firstDiff(ra.toasts, rb.toasts));
  check('HUD jar text reads the same as before', same(ra.hud, rb.hud), firstDiff(ra.hud, rb.hud));
}

console.log(failed ? `${failed} check(s) failed` : 'all S0d map and jar checks passed');
process.exit(failed ? 1 : 0);
