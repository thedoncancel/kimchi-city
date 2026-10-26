#!/usr/bin/env node
// KC3.bench on the v2 bench views in headless Chrome, with and without the vegetation (stage P2: flora3d's
// trees, shrubs, palms and ground plants), so its own share of the calls, triangles and GPU time shows apart
// from everything else on the map. Needs the dev server on :5173 (python3 serve.py).
//   node tools/p2_bench.mjs [view ...] [--hour=13] [--runs=2] [--only=with|without] [--cam=x,y,z,lx,ly,lz]
// 'without' adds &noflora=1, which src/3d/flora3d.js reads on a dev page (one that has ?shot=). --cam holds a
// fixed camera (an aerial, say) on the first view named. Each line is the median of the runs, with the flora's
// own stats from the city. Headless Chrome's GPU timer runs about 1.7 times the Browser pane's on the M1
// (tools/s4a_bench.mjs: scale by 0.59), so compare gpuMs only with numbers measured the same way.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LOCK = '/tmp/kc-shot.lock';
const V2_VIEWS = ['villa_terrace', 'pass_crest', 'ktown_circle', 'downtown_flagler', 'causeway_hump', 'ocean_drive', 'fest', 'glades'];
const args = process.argv.slice(2);
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const hour = +opt('hour', 13), runs = +opt('runs', 2), only = opt('only', ''), cam = opt('cam', '');
const views = args.filter((a) => !a.startsWith('--'));
const list = views.length ? views : V2_VIEWS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lock() {
  for (let i = 0; i < 240; i++) { try { mkdirSync(LOCK); return; } catch { await sleep(1000); } }
  throw new Error(`${LOCK} is held`);
}

async function bench(view, extra) {
  await lock();
  const profile = mkdtempSync(path.join(tmpdir(), 'kc-bench-'));
  try {
    const url = `http://localhost:5173/?gfx=high&map=2&shot=${view}&hour=${hour}&bench=1${cam ? `&cam=${cam}` : ''}${extra}`;
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
    // (Chrome may still be writing its profile for a moment after the kill)
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { console.warn(`could not remove ${profile}: ${e.code}`); }
    rmSync(LOCK, { recursive: true, force: true });
  }
}

const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
async function measure(view, extra) {
  const rs = [];
  for (let i = 0; i < runs; i++) { const r = await bench(view, extra); if (r) rs.push(r); }
  if (!rs.length) return null;
  const c = rs[0].city || {};
  return { calls: median(rs.map((r) => r.calls)), tris: median(rs.map((r) => r.tris)), gpu: median(rs.map((r) => r.gpuMs)), cpu: median(rs.map((r) => r.cpuMs)),
    flora: c.trees ? `trees ${c.trees.near}+${c.trees.mid} shrubs ${c.shrubs?.near}+${c.shrubs?.mid} palms ${c.palms?.drawn ?? '-'} (${c.flora?.placeMs}+${c.flora?.buildMs} ms)` : '' };
}

const fmt = (r) => (r ? `calls ${String(r.calls).padStart(4)}  tris ${String(r.tris).padStart(8)}  gpu ${r.gpu.toFixed(2).padStart(6)} (~${(r.gpu * 0.59).toFixed(1)} M1)  cpu ${r.cpu}` : 'no result');
for (const view of list) {
  const w = only === 'without' ? null : await measure(view, '');
  const wo = only === 'with' ? null : await measure(view, '&noflora=1');
  const d = w && wo ? `  | flora: ${w.calls - wo.calls} calls, ${((w.tris - wo.tris) / 1e3).toFixed(0)} k tris, ${(w.gpu - wo.gpu).toFixed(2)} ms gpu (headless)` : '';
  console.log(`${view.padEnd(17)} with: ${fmt(w)}   without: ${fmt(wo)}${d}${w?.flora ? '  ' + w.flora : ''}`);
}
