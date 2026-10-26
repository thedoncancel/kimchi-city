#!/usr/bin/env node
// Stage S8: KC3.bench on the v2 bench views in headless Chrome with the open-world layer (src/3d/activities.js:
// its marks, popups and per-frame checks) and without it (&noact=1, read by main3d on a dev page), so its own
// cost shows: the verify asks for KC3.bench unchanged within 2%. Needs the dev server on :5173.
//   node tools/s8_bench.mjs [view ...] [--hour=13] [--runs=3]
// Headless GPU times run about 1.7 x the Browser pane's on the M1 (x 0.59); calls and triangles are exact.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LOCK = '/tmp/kc-shot.lock';
const V2_VIEWS = ['villa_terrace', 'pass_crest', 'ktown_circle', 'downtown_flagler', 'causeway_hump', 'ocean_drive', 'fest', 'glades'];
const args = process.argv.slice(2);
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const hour = +opt('hour', 13), runs = +opt('runs', 3);
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
    const url = `http://localhost:5173/?gfx=high&map=2&shot=${view}&hour=${hour}&bench=1${extra}`;
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
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { console.warn(`could not remove ${profile}: ${e.code}`); }
    rmSync(LOCK, { recursive: true, force: true });
  }
}

const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
async function measure(view, extra) {
  const rs = [];
  for (let i = 0; i < runs; i++) { const r = await bench(view, extra); if (r) rs.push(r); }
  if (!rs.length) return null;
  return { calls: median(rs.map((r) => r.calls)), tris: median(rs.map((r) => r.tris)), gpu: median(rs.map((r) => r.gpuMs)), cpu: median(rs.map((r) => r.cpuMs)) };
}
const fmt = (r) => (r ? `calls ${String(r.calls).padStart(4)}  tris ${String(r.tris).padStart(8)}  gpu ${r.gpu.toFixed(2).padStart(6)}  cpu ${r.cpu}` : 'no result');
const pct = (a, b) => `${b ? (((a - b) / b) * 100).toFixed(1) : '-'}%`;
for (const view of list) {
  const w = await measure(view, ''), wo = await measure(view, '&noact=1');
  const d = w && wo ? `  | activities: calls ${pct(w.calls, wo.calls)}, tris ${pct(w.tris, wo.tris)}, gpu ${pct(w.gpu, wo.gpu)}, cpu ${pct(w.cpu, wo.cpu)}` : '';
  console.log(`${view.padEnd(17)} with: ${fmt(w)}   without: ${fmt(wo)}${d}`);
}
