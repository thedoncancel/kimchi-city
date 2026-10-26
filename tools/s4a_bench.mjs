#!/usr/bin/env node
// KC3.bench on the v2 bench views in headless Chrome, for draw calls, triangles and load times without the
// Browser pane (stage S4a). Needs the dev server on :5173 (python3 serve.py).
//   node tools/s4a_bench.mjs [view ...] [--hour=13] [--grid] [--low]
// Each view loads ?map=2&shot=<view>&hour=<h>&bench=1 (main3d's dev hook: a throwaway game, the clock held,
// KC3.bench on that view at Medium) and prints the 'KCBENCH' line it logs: calls and triangles (main + shadow
// + post passes), cpuMs, the page's load times (KC3.load) and the city's stats. --grid benches the grid's own
// views instead. Headless Chrome's GPU timer is not the Browser pane's: its gpuMs runs about 1.7 times the
// pane's on the M1 (the grid's home view reads 14.5 here against 8.2 in tools/bench/baseline_grid.json), so
// compare gpuMs only with the grid's, measured the same way. One page at a time (the tools/shot.sh lock).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LOCK = '/tmp/kc-shot.lock';
const V2_VIEWS = ['villa_terrace', 'pass_crest', 'ktown_circle', 'downtown_flagler', 'causeway_hump', 'ocean_drive', 'fest', 'glades'];
const GRID_VIEWS = ['home', 'park', 'motors', 'boutiques', 'marina', 'jet'];
const args = process.argv.slice(2);
const grid = args.includes('--grid'), low = args.includes('--low');
const hour = +(args.find(a => a.startsWith('--hour='))?.slice(7) ?? 13);
const views = args.filter(a => !a.startsWith('--'));
const list = views.length ? views : grid ? GRID_VIEWS : V2_VIEWS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lock() {
  for (let i = 0; i < 240; i++) { try { mkdirSync(LOCK); return; } catch { await sleep(1000); } }
  throw new Error(`${LOCK} is held`);
}

// one view: Chrome runs in real time (frames need it) until the page logs its KCBENCH line, at most 60 s
async function bench(view) {
  await lock();
  const profile = mkdtempSync(path.join(tmpdir(), 'kc-bench-'));
  try {
    const url = `http://localhost:5173/?gfx=${low ? 'low' : 'high'}&${grid ? '' : 'map=2&'}shot=${view}&hour=${hour}&bench=1`;
    const p = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
      '--window-size=1440,800', '--enable-logging=stderr', '--v=0', '--remote-debugging-port=0', url], { stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    p.stderr.on('data', (d) => { log += d; });
    const t0 = Date.now();
    let line = null;
    while (!line && Date.now() - t0 < 60000) {
      await sleep(500);
      line = log.match(/KCBENCH (\{.*?\})", source/)?.[1] || (log.includes('KCBENCH failed') ? 'null' : null);
    }
    p.kill('SIGKILL');
    return line && line !== 'null' ? JSON.parse(line) : null;
  } finally {
    // the lock first, so a profile Chrome still holds (ENOTEMPTY) never blocks the other stages' captures
    rmSync(LOCK, { recursive: true, force: true });
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { console.warn(`could not remove ${profile}: ${e.code}`); }
  }
}

for (const view of list) {
  const r = await bench(view);
  if (!r) { console.log(`${view}: no result (is the dev server up?)`); continue; }
  const t = r.city?.terrain, l = r.load;
  console.log(`${view.padEnd(17)} calls ${String(r.calls).padStart(4)}  tris ${String(r.tris).padStart(8)}  gpu(headless) ${String(r.gpuMs).padStart(6)}  cpu ${r.cpuMs}` +
    (l ? `  load: generate ${l.generate} ms, buildCity ${l.buildCity} ms, first frame ${l.firstFrame} ms` : '') +
    (t ? `  | terrain ${t.lod0Shown} fine + ${t.lod1Shown} coarse tiles, ${t.tris} tris` : ''));
}
