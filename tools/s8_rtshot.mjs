#!/usr/bin/env node
// Stage S8 (from S6b's scratch helper): a real-time screenshot of the game in headless Chrome through the DevTools
// protocol, for moving scenes that tools/shot.sh's virtual time cannot run (a race board event under way, a
// popup a few seconds in). Needs the dev server on :5173.
// Real-time headless Chrome screenshot via CDP: node tools/s8_rtshot.mjs '<query>' out.png [marker] [settleMs] [timeoutS] [w h]
// waits until a console line contains marker (default: 8 s after load), then settleMs more, then captures.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const [q, out, marker = '', settle = 1500, tmo = 90, W = 1280, H = 720] = process.argv.slice(2);
const LOCK = '/tmp/kc-shot.lock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 600; i++) { try { mkdirSync(LOCK); break; } catch { await sleep(1000); } }
const profile = mkdtempSync(path.join(tmpdir(), 'kc-rt-'));
const p = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars',
  `--window-size=${W},${H}`, '--enable-logging=stderr', '--v=0', '--remote-debugging-port=0', `http://localhost:5173/?gfx=high&${q}`], { stdio: ['ignore', 'ignore', 'pipe'] });
let log = '';
p.stderr.on('data', (d) => { log += d; });
try {
  const t0 = Date.now();
  let port = null;
  while (!port && Date.now() - t0 < 20000) { await sleep(200); port = log.match(/DevTools listening on ws:\/\/[^:]+:(\d+)/)?.[1]; }
  if (!port) throw new Error('no devtools port');
  if (marker) { while (!log.includes(marker) && Date.now() - t0 < tmo * 1000) await sleep(250); if (!log.includes(marker)) console.log('marker not seen'); }
  else await sleep(8000);
  await sleep(+settle);
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const data = await new Promise((r) => { ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id === 1) r(m.result.data); }); ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } })); });
  writeFileSync(out, Buffer.from(data, 'base64'));
  ws.close();
  console.log(out);
  for (const l of log.split("\n")) { const m = l.match(/CONSOLE.*?"(KC.*)", source/); if (m && !m[1].startsWith("KCROUTE {") && !m[1].startsWith("KCGO {")) console.log("  " + m[1].slice(0, 240)); }
} finally {
  p.kill('SIGKILL');
  rmSync(LOCK, { recursive: true, force: true });
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}
