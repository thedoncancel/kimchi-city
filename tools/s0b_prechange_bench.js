// Stage S0b: the grid bench for the build from BEFORE the city facade (which has no src/3d/bench.js), so the
// old and new 3D game can be measured the same way at the same six views. Paste this whole file into the
// browser console of either build (index.html, desktop), then:
//   S0B.teleport('park')              stand Kimchi where KC3.teleport('park') does, clock held at 13:00
//   await S0B.bench()                 the six grid views, measured like KC3.bench(): JSON is logged and returned
//   S0B.release()                     let the clock run again after teleport
// It works from the outside through window.KC3 (G, cam, hero, gfx, renderer): it wraps gfx.render to count the
// whole frame (shadow, scene and post passes) and time it on the GPU, wraps requestAnimationFrame to time the
// game's frame in JS, pauses auto quality and draws at Medium, and puts all of that back when done.
(() => {
  const K = window.KC3, G = K.G, gfx = K.gfx, renderer = K.renderer, info = renderer.info, cam = K.cam;
  const VIEWS = [['home', 'home'], ['park', 'park'], ['motors', 'dealer'], ['boutiques', 'watches'], ['marina', 'marina'], ['jet', 'jet']];
  const gl = renderer.getContext(), timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  const round = (v) => (v == null ? null : Math.round(v * 100) / 100);
  const raf = window.requestAnimationFrame.bind(window);
  const nextFrame = () => new Promise((r) => raf(r));
  let world = null, hold = null, sample = null, lastCpu = 0;
  const queries = [];

  // the game's own frame, timed (our own frame waits use the unwrapped raf)
  window.requestAnimationFrame = (cb) => raf((t) => { const t0 = performance.now(); cb(t); lastCpu = performance.now() - t0; });
  (function tick() { if (hold != null) G.time = hold; raf(tick); })();

  const plain = gfx.render;
  gfx.render = function () {
    if (!sample) return plain.call(gfx);
    info.autoReset = false; info.reset();
    try {
      if (timer && gfx.passes) {
        const q = gl.createQuery();
        gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
        gfx.passes.composer.render();
        gl.endQuery(timer.TIME_ELAPSED_EXT);
        queries.push({ q, into: sample.gpu });
      } else plain.call(gfx);
      sample.calls.push(info.render.calls); sample.tris.push(info.render.triangles);
    } finally { info.autoReset = true; }
  };
  function poll() {
    while (queries.length && gl.getQueryParameter(queries[0].q, gl.QUERY_RESULT_AVAILABLE)) {
      const { q, into } = queries.shift();
      if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) into.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
    }
  }

  async function ready() {
    world = world || await import(new URL('src/world.js', location.href).href);
    if (G.mode !== 'play') {
      let save = false;
      try { save = !!localStorage.getItem('kimchi-city-save-v1'); } catch (e) {}
      document.getElementById(save ? 'continueBtn' : 'newBtn').click();
      for (let i = 0; i < 3; i++) await nextFrame();
    }
  }
  // the same spot and camera as the grid's bench views (place.foot = door + 30 px south, facing south)
  function place(name, time = 13 * 60) {
    const key = VIEWS.find((v) => v[0] === name)?.[1];
    if (!key) throw new Error(`no view '${name}'`);
    const d = world.places[key].door, hero = K.hero;
    if (G.player.car) G.player.car = null;
    Object.assign(G.player, { x: d.x, y: d.y + 30, moving: false });
    hero.heading = Math.PI / 2; hero.gy = null; hero.px = null;
    Object.assign(cam, { yaw: -Math.PI / 2, pitch: 0.34, init: false, mode: 0, zoom: 1, lastDrag: -10 });
    hold = time;
  }

  async function bench({ frames = 180, warm = 60, time = 13 * 60, level = 2 } = {}) {
    await ready();
    const adapt = gfx.adapt, keepLevel = gfx.level, keepTime = G.time;
    gfx.adapt = () => {};
    if (gfx.setLevel && gfx.level >= 0 && level != null) gfx.setLevel(level);
    const views = [];
    try {
      for (const [name] of VIEWS) {
        place(name, time);
        for (let i = 0; i < warm; i++) { await nextFrame(); poll(); }
        const s = sample = { calls: [], tris: [], gpu: [], cpu: [] };
        for (let i = 0; i < frames; i++) { await nextFrame(); poll(); s.cpu.push(lastCpu); }
        sample = null;
        for (let i = 0; i < 30 && queries.length; i++) { await nextFrame(); poll(); }
        views.push({ view: name, calls: median(s.calls), tris: median(s.tris), gpuMs: timer ? round(median(s.gpu)) : null, cpuMs: round(median(s.cpu)) });
      }
    } finally {
      sample = null; hold = null; G.time = keepTime; gfx.adapt = adapt;
      if (gfx.setLevel && gfx.level !== keepLevel && keepLevel >= 0) gfx.setLevel(keepLevel);
    }
    const report = { map: 'grid', build: K.teleport ? 'with city facade' : 'before city facade', gfx: gfx.name, level: level ?? gfx.level,
      size: [innerWidth, innerHeight], pixelRatio: renderer.getPixelRatio(), frames, clock: time, views };
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  window.S0B = { bench, async teleport(name, time) { await ready(); place(name, time); }, release() { hold = null; } };
  return 'S0B ready: await S0B.bench()';
})();
