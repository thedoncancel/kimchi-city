#!/usr/bin/env node
// Stage S9: the v2 bench views in headless Chrome against the performance budgets, by day and at night, so a
// change to the LOD radii, the fog, the shadows or the population can be judged in one run. Needs the dev
// server on :5173 (python3 serve.py). One Chrome at a time (the tools/shot.sh lock).
//   node tools/s9_bench.mjs [view ...] [--hours=13,21] [--runs=1] [--uncapped] [--low] [--grid] [--extra='&noflora=1'] [--out=file.json]
// Each page is ?map=2&shot=<view>&hour=<h> (main3d's dev hook: a throwaway game on that view); --low loads the
// phone tier (gfx=low), --grid the classic map's own views (?map=1). The table shows KC3.bench's calls, triangles
// and GPU timer, the timer x 0.59 (the earlier stages' Browser pane estimate, tools/s4a_bench.mjs), and the real
// frame time with frames uncapped (see benchOnce), and checks the estimate against both budgets:
//   wave   GPU <= 9.5 ms, calls <= 350, triangles <= 1.5 M (main + shadow), the lead's limit for this wave;
//   spec   GPU <= 8.0 ms, calls <= 380, triangles <= 1.2 M (docs/map-v2-spec.md §11.2), the S9 target.
// The real numbers come from KC3.bench in the Browser pane on the M1; these only rank changes.
import { writeFileSync } from 'node:fs';
import { openPage, FRAME_TIMES } from './s9_lib.mjs';

const M1 = 0.59;
const V2_VIEWS = ['villa_terrace', 'pass_crest', 'ktown_circle', 'downtown_flagler', 'causeway_hump', 'ocean_drive', 'fest', 'glades'];
const GRID_VIEWS = ['home', 'downtown', 'park', 'beach', 'jet', 'mall'];
const BUDGET = { wave: { gpu: 9.5, calls: 350, tris: 1.5e6 }, spec: { gpu: 8.0, calls: 380, tris: 1.2e6 } };

const args = process.argv.slice(2);
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const low = args.includes('--low'), grid = args.includes('--grid'), uncapped = args.includes('--uncapped');
const hours = opt('hours', '13').split(',').map(Number), runs = +opt('runs', 1), extra = opt('extra', ''), out = opt('out', '');
const named = args.filter((a) => !a.startsWith('--'));
const views = named.length ? named : grid ? GRID_VIEWS : V2_VIEWS;

// One page load: KC3.bench on the view (Medium, the clock held at hour), then the real frame times over the next
// 2 s, the page's load times and the city's stats. Headless, ANGLE on Metal times the GPU from when a frame's
// commands start to when they finish, idle gaps included, so on the M1 gpuMs reads 2-3 times the real cost.
// With --uncapped (no vsync, no frame-rate limit) the frame time, CPU and GPU overlapped, so about the larger of
// the two, is the honest throughput number; it also busies the machine, which raises the GPU timer, so compare
// gpuMs only between runs made the same way (the default, at 60 Hz, matches the earlier stages' numbers).
async function benchOnce(view, hour) {
  let page = null;
  try {
    page = await openPage(`map=${grid ? 1 : 2}&shot=${view}&hour=${hour}${extra}`, { uncapped, gfx: low ? 'low' : 'high' });
    await page.ready();
    const r = await page.evaluate(`KC3.bench(['${view}'], { frames: 60, warm: 60, time: ${hour * 60} }).then((r) => r[0])`);
    const f = await page.evaluate(FRAME_TIMES);
    return { ...r, ...f, load: await page.evaluate('KC3.load'), city: await page.evaluate('KC3.city.stats?.()'),
      heapMB: await page.evaluate('performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null') };
  } catch (e) {
    console.warn(`${view}: ${e.message}`);
    return null;
  } finally { await page?.close(); }
}

const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const verdict = (r, b) => (r.m1 <= b.gpu && r.calls <= b.calls && r.tris <= b.tris ? 'ok' : 'OVER');

const rows = [];
for (const hour of hours) {
  for (const view of views) {
    const rs = [];
    for (let i = 0; i < runs; i++) { const r = await benchOnce(view, hour); if (r) rs.push(r); }
    if (!rs.length) { console.log(`${view.padEnd(17)} h${hour}  no result`); rows.push({ view, hour, failed: true }); continue; }
    const gpu = rs.every((r) => r.gpuMs != null) ? median(rs.map((r) => r.gpuMs)) : null;
    const r = { view, hour, calls: median(rs.map((r) => r.calls)), tris: median(rs.map((r) => r.tris)), gpu, m1: gpu == null ? null : Math.round(gpu * M1 * 100) / 100,
      cpu: median(rs.map((r) => r.cpuMs)), frame: median(rs.map((r) => r.frameMs)), frameP95: median(rs.map((r) => r.frameP95)), heapMB: rs[0].heapMB, load: rs[0].load, terrain: rs[0].city?.terrain, chunks: rs[0].city?.chunks && { shown: rs[0].city.chunks.shown, built: rs[0].city.chunks.built, casting: rs[0].city.chunks.casting } };
    r.wave = verdict(r, BUDGET.wave); r.spec = verdict(r, BUDGET.spec);
    rows.push(r);
    console.log(`${view.padEnd(17)} h${String(hour).padEnd(4)} calls ${String(r.calls).padStart(4)}  tris ${(r.tris / 1e6).toFixed(2)} M  gpu ${gpu?.toFixed(2) ?? '-'} (~${r.m1 ?? '-'} M1)  cpu ${r.cpu}${uncapped ? `  frame ${r.frame} (p95 ${r.frameP95})` : ''}` +
      `  load gen ${r.load?.generate} city ${r.load?.buildCity} first ${r.load?.firstFrame}  wave ${r.wave}  spec ${r.spec}`);
  }
}
const ok = rows.filter((r) => !r.failed);
if (ok.length) {
  const worst = (k) => ok.reduce((m, r) => (r[k] > m[k] ? r : m));
  console.log(`worst: gpu ${worst('m1').view} ${worst('m1').m1} ms M1, calls ${worst('calls').view} ${worst('calls').calls}, tris ${worst('tris').view} ${(worst('tris').tris / 1e6).toFixed(2)} M`);
  console.log(`wave budget: ${ok.every((r) => r.wave === 'ok') ? 'met' : 'NOT met'} in every view; spec budget: ${ok.every((r) => r.spec === 'ok') ? 'met' : 'not met'}`);
}
if (out) writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), low, grid, uncapped, hours, runs, extra, m1Scale: M1, budget: BUDGET, rows }, null, 2));
