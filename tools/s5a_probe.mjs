#!/usr/bin/env node
// Evaluate an expression in the running game (stage S5a): loads the dev server's page in headless Chrome, waits,
// then evaluates the expression in the page through the DevTools protocol and prints what it returns (as JSON).
// Needs the dev server on :5173. One page at a time (the tools/shot.sh lock).
//   node tools/s5a_probe.mjs '<query>' '<expression>' [seconds]
//   node tools/s5a_probe.mjs 'map=2&shot=ktown_circle&hour=13' 'KC3.renderer.info.memory' 15
//   node tools/s5a_probe.mjs 'map=2&shot=ktown_circle&hour=13' lamps     (the buildings' lamp gate and night)
//   node tools/s5a_probe.mjs 'gfx=auto&map=2&shot=pass_crest' layers 20 out.png   (the layer stacks; and a screenshot)
// The page opens with gfx=high unless the query names its own gfx.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LOCK = '/tmp/kc-shot.lock';
const PORT = 9347;
const query = process.argv[2] || 'map=2&shot=villa_terrace';
let expr = process.argv[3] || 'KC3.renderer.info.render';
const secs = +(process.argv[4] || 15);
const png = process.argv[5] || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// what the buildings' material sees this frame: its lamp gate and night uniforms (buildings3d tick), and the
// lights three gathered for the frame, against the scene's own point and spot lights
const PRESETS = {
  lamps: `(() => {
    let m = null, lights = 0, on = 0;
    KC3.scene.traverse((o) => {
      if (!m && o.isMesh && o.name.startsWith('building shells')) m = o;
      if (o.isPointLight || o.isSpotLight) { lights++; if (o.visible && o.intensity > 0) on++; }
    });
    const u = m && KC3.renderer.properties.get(m.material).uniforms;
    if (!u) return 'no building material yet';
    return { lamps: u.uKcLamps.value, night: +u.uBNight.value.toFixed(3), sceneLights: lights, sceneLightsOn: on,
      frameLights: u.pointLights.value.length + u.spotLights.value.length,
      sun: u.directionalLights.value[0]?.color.toArray().map((v) => +v.toFixed(3)) };
  })()`,
  // the buildings' texture stacks: size, layers and GPU memory (with mipmaps, about 4/3 of the top level)
  layers: `(() => {
    let m = null;
    KC3.scene.traverse((o) => { if (!m && o.isMesh && o.name.startsWith('building shells')) m = o; });
    const u = m && KC3.renderer.properties.get(m.material).uniforms;
    if (!u) return 'no building material yet';
    const one = (t) => ({ size: t.image.width, layers: t.image.depth, mb: +(t.image.width * t.image.height * t.image.depth * 4 * 4 / 3 / 1048576).toFixed(1) });
    return { color: one(u.tBColor.value), lit: one(u.tBLit.value), rough: one(u.tBRough.value) };
  })()`,
};
expr = PRESETS[expr] || expr;

async function lock() {
  for (let i = 0; i < 240; i++) { try { mkdirSync(LOCK); return; } catch { await sleep(1000); } }
  throw new Error(`${LOCK} is held`);
}

await lock();
const profile = mkdtempSync(path.join(tmpdir(), 'kc-probe-'));
let chrome = null;
try {
  const url = `http://localhost:5173/?${query.includes('gfx=') ? '' : 'gfx=high&'}${query}`;
  chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--window-size=1280,720', `--remote-debugging-port=${PORT}`, url], { stdio: 'ignore' });
  await sleep(secs * 1000);
  const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = pages.find((p) => p.type === 'page' && p.url.startsWith('http://localhost:5173'));
  if (!page) throw new Error('the game page is not open');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const waits = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); waits.get(m.id)?.(m); };
  let id = 0;
  const send = (method, params) => new Promise((res) => { waits.set(++id, res); ws.send(JSON.stringify({ id, method, params })); });
  const reply = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (png) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) { writeFileSync(png, Buffer.from(shot.result.data, 'base64')); console.log(png); }
  }
  ws.close();
  const r = reply.result;
  if (r?.exceptionDetails) console.log('exception:', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  else console.log(JSON.stringify(r?.result?.value ?? r?.result, null, 1));
} finally {
  chrome?.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
  rmSync(LOCK, { recursive: true, force: true });
}
