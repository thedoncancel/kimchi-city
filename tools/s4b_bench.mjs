#!/usr/bin/env node
// What the v2 roads cost (stage S4b): KC3.bench on the v2 bench views in headless Chrome, each view loaded
// twice, with the roads and without them (roads3d's dev switch ?roads=0), so the difference is the roads'
// own: draw calls, triangles, GPU time and buildCity's load time. Needs the dev server on :5173 (python3 serve.py).
//   node tools/s4b_bench.mjs [view ...] [--hour=13] [--low] [--runs=1]
// Each load is ?map=2&shot=<view>&hour=<h>&bench=1 (main3d's dev hook: a throwaway game, the clock held,
// KC3.bench on that view at Medium), as tools/s4a_bench.mjs does. Headless Chrome's GPU timer runs about 1.7
// times the Browser pane's on the M1, so read gpuMs as a difference, not an absolute. With --runs=n each
// variant is loaded n times and the medians are compared. One page at a time (the tools/shot.sh lock).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LOCK = '/tmp/kc-shot.lock';
const VIEWS = ['villa_terrace', 'pass_crest', 'ktown_circle', 'downtown_flagler', 'causeway_hump', 'ocean_drive', 'fest', 'glades'];
const args = process.argv.slice(2);
const low = args.includes('--low');
const hour = +(args.find(a => a.startsWith('--hour='))?.slice(7) ?? 13);
const runs = Math.max(1, +(args.find(a => a.startsWith('--runs='))?.slice(7) ?? 1));
const views = args.filter(a => !a.startsWith('--'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lock() {
  for (let i = 0; i < 240; i++) { try { mkdirSync(LOCK); return; } catch { await sleep(1000); } }
  throw new Error(`${LOCK} is held`);
}

// one load: Chrome runs in real time until the page logs its KCBENCH line, at most 60 s
async function bench(view, roads) {
  await lock();
  const profile = mkdtempSync(path.join(tmpdir(), 'kc-bench-'));
  try {
    const url = `http://localhost:5173/?gfx=${low ? 'low' : 'high'}&map=2&shot=${view}&hour=${hour}&bench=1${roads ? '' : '&roads=0'}`;
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

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
console.log(`view              calls (with / without / roads)   tris k (roads)   gpu ms headless (with / without / roads)   buildCity ms (with / without)`);
for (const view of views.length ? views : VIEWS) {
  const W = [], O = [];
  for (let k = 0; k < runs; k++) { W.push(await bench(view, true)); O.push(await bench(view, false)); }
  const w = W.filter(Boolean), o = O.filter(Boolean);
  if (!w.length || !o.length) { console.log(`${view}: no result (is the dev server up?)`); continue; }
  const cw = median(w.map(r => r.calls)), co = median(o.map(r => r.calls)), tw = median(w.map(r => r.tris)), to = median(o.map(r => r.tris));
  const gw = median(w.map(r => r.gpuMs)), go = median(o.map(r => r.gpuMs));
  const bw = median(w.map(r => r.load?.buildCity ?? NaN)), bo = median(o.map(r => r.load?.buildCity ?? NaN));
  console.log(`${view.padEnd(17)} ${String(cw).padStart(4)} / ${String(co).padStart(4)} / ${String(cw - co).padStart(3)}        ${String(Math.round((tw - to) / 1e3)).padStart(5)}          ${gw.toFixed(2).padStart(6)} / ${go.toFixed(2).padStart(6)} / ${(gw - go).toFixed(2).padStart(5)}          ${String(bw).padStart(5)} / ${String(bo).padStart(5)}`);
}
