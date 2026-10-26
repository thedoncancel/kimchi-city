// Stage S9's headless Chrome page, shared by tools/s9_bench.mjs, s9_probe.mjs and s9_soak.mjs: the game from the
// dev server on :5173 in a throwaway Chrome profile, driven through the DevTools protocol. One Chrome at a time
// (the /tmp/kc-shot.lock tools/shot.sh uses), because each takes about 0.5 GB on an 8 GB Mac.
//   const page = await openPage('map=2&shot=villa_terrace&hour=13', { uncapped: true });
//   await page.ready();                       // the game is running (a first frame drawn, in play)
//   const v = await page.evaluate('KC3.G.time');   // any expression; promises are awaited, values come back as JSON
//   await page.close();                       // always (it frees the lock)
// uncapped: no vsync and no frame-rate limit, so frame times measure throughput; size: [w, h] (1440 x 800).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LOCK = '/tmp/kc-shot.lock';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lock() {
  for (let i = 0; i < 600; i++) { try { mkdirSync(LOCK); return; } catch { await sleep(1000); } }
  throw new Error(`${LOCK} has been held for 10 minutes`);
}

export async function openPage(query, { uncapped = false, size = [1440, 800], gfx = 'high' } = {}) {
  await lock();
  const profile = mkdtempSync(path.join(tmpdir(), 'kc-s9-'));
  const url = `http://localhost:5173/?gfx=${gfx}&${query}`;
  const chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    `--window-size=${size[0]},${size[1]}`, '--enable-logging=stderr', '--v=0', '--remote-debugging-port=0', '--enable-precise-memory-info',
    ...(uncapped ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []), url], { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '', ws = null, closed = false;
  chrome.stderr.on('data', (d) => { log += d; });
  const close = async () => {
    if (closed) return;
    closed = true;
    try { ws?.close(); } catch { /* gone */ }
    chrome.kill('SIGKILL');
    // the lock first, so a profile Chrome is still writing never blocks the next page
    rmSync(LOCK, { recursive: true, force: true });
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* left in tmp */ }
  };
  try {
    const t0 = Date.now();
    let port = null;
    while (!port && Date.now() - t0 < 20000) { await sleep(200); port = log.match(/DevTools listening on ws:\/\/[^:]+:(\d+)/)?.[1]; }
    if (!port) throw new Error('Chrome gave no DevTools port');
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  } catch (e) { await close(); throw e; }
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const call = (method, params = {}) => new Promise((r) => { const k = ++id; pending.set(k, r); ws.send(JSON.stringify({ id: k, method, params })); });
  const evaluate = async (expression) => {
    const m = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text || 'page error');
    return m.result?.result?.value;
  };
  // the game is up: a frame drawn and a game in play (a ?shot= page starts one by itself)
  const ready = async (settleMs = 1500) => {
    for (let k = 0; k < 160; k++) {
      if (await evaluate('!!(window.KC3 && KC3.G && KC3.G.mode === "play" && KC3.load.firstFrame)').catch(() => false)) { await sleep(settleMs); return true; }
      await sleep(500);
    }
    throw new Error('the game did not start within 80 s');
  };
  return { evaluate, call, ready, close, get log() { return log; } };
}

// After KC3.bench: the median and 95th percentile of the real frame time over the next 2 s (in the page).
export const FRAME_TIMES = /* js */`new Promise((done) => {
  const dts = []; let last = performance.now();
  const step = (t) => {
    dts.push(t - last); last = t;
    if (dts.length < 600 && dts.reduce((a, b) => a + b, 0) < 2000) { requestAnimationFrame(step); return; }
    const s = dts.slice(5).sort((a, b) => a - b), q = (f) => Math.round(s[Math.min(s.length - 1, Math.floor(s.length * f))] * 100) / 100;
    done({ frameMs: q(0.5), frameP95: q(0.95) });
  };
  requestAnimationFrame(step);
})`;
