// The fixed views and the perf bench (docs/map-v2-spec.md §7 and §11.2), for the browser console:
//   KC3.teleport('park')                  stand Kimchi on one of the world's bench views
//   await KC3.bench()                     every view: 60 frames to settle, then 180 measured frames
//   await KC3.bench(['home', 'jet'], { frames: 300, level: 2, time: 13 * 60 })
//   await KC3.soak(900, { route: true })  play 15 minutes (touring the views) and report frame times and memory
// bench() resolves to [{ view, calls, tris, gpuMs, cpuMs }], the median of each over the measured frames, and
// logs the same views as JSON with the map, graphics level and screen size, ready to paste into
// tools/bench/*.json. While it measures:
//  - the clock stands still (13:00 unless told otherwise), so every view has the same sun and shadows;
//  - auto quality waits, and the level is set to Medium (2) where there are levels, then put back;
//  - calls and tris count every draw of the frame: the shadow map, the scene and the post passes;
//  - gpuMs is the GPU time of the same render gfx times for auto quality, from a timer query per frame
//    (null where the browser cannot time the GPU); cpuMs is the frame's JS time, render submission included.
// The game keeps running (traffic, people, police), so start it from a fresh New Game for comparable numbers.
import { benchViews, KIND } from '../world.js';

const WARM = 60, FRAMES = 180;   // frames to settle on a view (shader compiles, streaming), frames measured
const HEAP_EVERY = 10;           // seconds between memory samples in a soak

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : null);
const round = (v, k = 100) => (v == null ? null : Math.round(v * k) / k);
const most = (a) => a.reduce((m, v) => (v > m ? v : m), -Infinity);   // Math.max(...a) overflows the stack on long soaks
const least = (a) => a.reduce((m, v) => (v < m ? v : m), Infinity);
const heapMB = () => (performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null);

// ctx: { KC3, G, renderer, gfx, place(view), start() }. place puts Kimchi on a view; start begins a game.
// Returns the hooks main3d calls each frame: render() in place of gfx.render(), and frame(cpuMs, dt) after it.
export function installBench({ KC3, G, renderer, gfx, place, start }) {
  const info = renderer.info;
  const gl = renderer.getContext();
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  // on the high tier gfx.render() runs its own timer query around the composer, and queries cannot nest,
  // so timed frames draw through the composer directly; the low tier draws straight to the screen
  const draw = gfx.passes?.composer ? () => gfx.passes.composer.render() : () => gfx.render();

  let busy = null;        // 'bench' or 'soak' while one runs
  let sample = null;      // the lists being filled: { calls, tris, cpu, gpu, dt }
  let countEvery = 1;     // count draw calls on every frame (bench) or every 30th (soak)
  let holdTime = null;    // the clock (game minutes) the bench keeps still
  let frameNo = 0;
  let waiters = [];       // promises waiting for frames: { n, done }
  const queries = [];     // GPU timer queries still in flight: { q, into }

  const frames = (n) => new Promise((done) => waiters.push({ n, done }));

  function pollQueries() {
    while (queries.length && gl.getQueryParameter(queries[0].q, gl.QUERY_RESULT_AVAILABLE)) {
      const { q, into } = queries.shift();
      if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) into.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
    }
  }

  function render() {
    const s = sample, count = !!s && frameNo % countEvery === 0;
    if (!count) { gfx.render(); return; }
    // three.js clears its counters at the start of every render call (after the shadow pass), so hold them
    // for the whole frame to count the shadow map and every pass of the composer
    info.autoReset = false; info.reset();
    try {
      if (busy === 'bench' && timer) {
        const q = gl.createQuery();
        gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
        draw();
        gl.endQuery(timer.TIME_ELAPSED_EXT);
        queries.push({ q, into: s.gpu });
      } else gfx.render();
      s.calls.push(info.render.calls); s.tris.push(info.render.triangles);
    } finally { info.autoReset = true; }
  }

  function frame(cpuMs, dt) {
    frameNo++;
    if (timer && queries.length) pollQueries();
    if (sample) { sample.cpu.push(cpuMs); sample.dt.push(dt * 1000); }
    if (holdTime != null) G.time = holdTime;
    if (!waiters.length) return;
    for (const w of waiters) if (--w.n <= 0) w.done();
    waiters = waiters.filter((w) => w.n > 0);
  }

  function view(name) {
    const v = benchViews.find((b) => b.name === name);
    if (!v) throw new Error(`no bench view '${name}' on the ${KIND} map (it has ${benchViews.map((b) => b.name).join(', ')})`);
    return v;
  }

  // the views a call names: a name, a list of names, or (nothing or true) all of them
  const viewNames = (names) => (names == null || names === true ? benchViews.map((b) => b.name) : [].concat(names));

  async function inGame() {
    if (G.mode === 'play') return;
    start();
    await frames(2);
  }

  function teleport(name) {
    const v = view(name);
    if (G.mode !== 'play') start();
    if (G.player.dead) throw new Error('Kimchi is down; teleport again once he is back on his feet');
    place(v);
    return v;
  }

  async function bench(names, { frames: n = FRAMES, warm = WARM, time = 13 * 60, level = 2 } = {}) {
    if (busy) throw new Error(`a ${busy} is already running`);
    const list = viewNames(names);
    list.forEach(view);
    busy = 'bench';
    const keep = { time: G.time, level: gfx.level };
    const setLevel = level != null && gfx.setLevel && gfx.level >= 0;
    try {
      await inGame();
      if (setLevel && gfx.level !== level) gfx.setLevel(level);
      holdTime = time;
      const out = [];
      for (const name of list) {
        teleport(name);
        await frames(warm);
        countEvery = 1;
        const s = sample = { calls: [], tris: [], cpu: [], gpu: [], dt: [] };
        await frames(n);
        sample = null;
        for (let i = 0; i < 30 && queries.length; i++) await frames(1);   // the last GPU times arrive a frame or two late
        out.push({ view: name, calls: median(s.calls), tris: median(s.tris), gpuMs: timer ? round(median(s.gpu)) : null, cpuMs: round(median(s.cpu)) });
      }
      const report = { map: KIND, gfx: gfx.name, level: gfx.level, size: [innerWidth, innerHeight], pixelRatio: renderer.getPixelRatio(),
        frames: n, clock: time, date: new Date().toISOString().slice(0, 10), views: out };
      console.log(JSON.stringify(report, null, 2));
      KC3.lastBench = report;
      return out;
    } finally {
      busy = null; sample = null; holdTime = null;
      G.time = keep.time;
      if (setLevel && gfx.level !== keep.level) gfx.setLevel(keep.level);
    }
  }

  // Play normally for sec seconds and report how it went. route: a view name, a list of names or true (every
  // view), visited in turn at even intervals, so the soak covers the whole map.
  async function soak(sec = 60, { route = null } = {}) {
    if (busy) throw new Error(`a ${busy} is already running`);
    const stops = route ? viewNames(route) : [];
    stops.forEach(view);
    busy = 'soak';
    try {
      await inGame();
      countEvery = 30;
      const s = sample = { calls: [], tris: [], cpu: [], gpu: [], dt: [] };
      const heap = [], t0 = performance.now();
      let nextStop = 0, stop = 0, nextHeap = 0;
      for (;;) {
        const el = (performance.now() - t0) / 1000;
        if (el >= sec) break;
        if (stops.length && el >= nextStop && !G.player.dead) { teleport(stops[stop++ % stops.length]); nextStop += sec / stops.length; }
        if (el >= nextHeap) { heap.push(round(heapMB(), 10)); nextHeap += HEAP_EVERY; }
        await frames(1);
      }
      sample = null;
      heap.push(round(heapMB(), 10));
      const stats = typeof window.KCSTATS === 'function' ? window.KCSTATS() : window.KCSTATS ?? null;
      const report = {
        map: KIND, sec, frames: s.dt.length, fps: round(s.dt.length / sec, 10), gfx: gfx.name,
        frameMs: { p50: round(median(s.dt)), p95: round(pct(s.dt, 0.95)), p99: round(pct(s.dt, 0.99)), worst: round(most(s.dt)) },
        cpuMs: { p50: round(median(s.cpu)), p95: round(pct(s.cpu, 0.95)) },
        calls: median(s.calls), tris: median(s.tris), gpuMs: round(gfx.gpuMs) || null,
        heapMB: heap[0] == null ? null : { start: heap[0], end: heap[heap.length - 1], min: least(heap), max: most(heap), every10s: heap },
        cars: G.cars.length, peds: G.peds.length, carViews: KC3.carViews?.size ?? null, stats,
      };
      console.log(JSON.stringify(report, null, 2));
      KC3.lastSoak = report;
      return report;
    } finally {
      busy = null; sample = null; countEvery = 1;
    }
  }

  Object.assign(KC3, { teleport, bench, soak });
  return {
    render, frame,
    get busy() { return busy; },
  };
}
