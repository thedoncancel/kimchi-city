#!/usr/bin/env node
// Stage S6b check, part 2 (docs/map-v2-stages.json, spec §10 and §11): scripted drives in the real game, in
// headless Chrome, with main3d's KC3.metrics on. Needs the dev server on :5173 (python3 serve.py).
//   node tools/s6b_drive.mjs [run ...] [--low]
// Each run loads ?map=2&shot=pass_crest&route=x0,z0,x1,z1,vmax (main3d's dev hook: a throwaway game whose car
// drives the roads from the first point to the second, bends at 70% of the grip) and reads the 'KCROUTE_END'
// line it logs at the end. Checks, per run:
//  - the camera never enters the terrain: no corner of its near plane (nor the eye) is ever under the terrain
//    as drawn (TERRAIN's 2 m triangles) or the ground (roads, kerbs, decks), nor inside a building (OCC);
//  - wheel ground error (cars.js wheelGap) stays within 5 cm on every frame the car is on the ground;
//  - the drive got to the end.
// The hill runs (the switchbacks down and up, Heights Drive up, Crest Road over j_crest) are the stage's camera
// runs; the causeway run adds the North Causeway for the wheels. One page at a time (the tools/shot.sh lock).
// Exits 1 if any check fails.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LOCK = '/tmp/kc-shot.lock';
// [x0, z0, x1, z1, vmax]: each start and end lies on the road itself, so roads.route keeps to it (the Heights
// Gate to the Loop is shorter by Heights Drive than down the switchbacks)
const RUNS = {
  switchbacks: [362, 326, 377, 545, 25],      // down the five legs of the switchbacks (779 m)
  switchbacks_up: [377, 545, 362, 326, 25],   // and back up them
  heights_up: [697, 339, 385, 292, 30],       // Heights Drive up the east ridge to the Heights Gate (327 m)
  crest: [812, 300, 1140, 332, 37.5],         // Crest Road over j_crest and the Lookout Knoll (463 m)
  causeway: [1235, 374, 1670, 560, 50],       // the Loop over the North Causeway's cable-stayed bridge (628 m)
};
const args = process.argv.slice(2), low = args.includes('--low');
const names = args.filter(a => !a.startsWith('--'));
const list = names.length ? names : Object.keys(RUNS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lock() {
  for (let i = 0; i < 300; i++) { try { mkdirSync(LOCK); return; } catch { await sleep(1000); } }
  throw new Error(`${LOCK} is held`);
}

// one run: Chrome in real time until the page logs KCROUTE_END, at most 5 minutes
async function drive(name) {
  await lock();
  const profile = mkdtempSync(path.join(tmpdir(), 'kc-s6b-'));
  try {
    const url = `http://localhost:5173/?gfx=${low ? 'low' : 'high'}&map=2&shot=pass_crest&hour=15.5&route=${RUNS[name].join(',')}`;
    const p = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
      '--window-size=1440,800', '--enable-logging=stderr', '--v=0', '--remote-debugging-port=0', url], { stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    p.stderr.on('data', (d) => { log += d; });
    const t0 = Date.now();
    let end = null;
    while (!end && Date.now() - t0 < 300000) {
      await sleep(1000);
      end = log.match(/KCROUTE_END (\{.*?\})", source/)?.[1] || (log.includes('KCROUTE failed') ? 'null' : null);
    }
    p.kill('SIGKILL');
    await new Promise((r) => (p.exitCode != null || p.signalCode != null ? r() : p.once('exit', r)));
    const steps = [...log.matchAll(/KCROUTE (\{.*?\})", source/g)].map(m => JSON.parse(m[1]));
    return { end: end && end !== 'null' ? JSON.parse(end) : null, steps };
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Chrome's leftovers in the temp folder */ }
  }
}

let fails = 0, checks = 0;
const check = (ok, msg) => { checks++; if (!ok) { fails++; console.log('  FAIL ' + msg); } return ok; };
for (const name of list) {
  const { end: r, steps } = await drive(name);
  console.log(name);
  if (!check(!!r, `${name}: no KCROUTE_END (is the dev server up?)`)) continue;
  const last = steps[steps.length - 1];
  console.log(`  ${r.t} s, ${r.len} m, ${r.frames} frames (${r.free} with the car off the ground, longest flight ${r.airMax} s), ended at (${last?.x}, ${last?.z})`);
  console.log(`  camera: lowest near-plane corner ${r.camMin == null ? '-' : r.camMin.toFixed(2)} m over the ground or terrain; under it ${r.camUnder} frames, in a building ${r.camInBuilding}; lifted on ${r.lifted} frames (most ${r.liftMax.toFixed(2)} rad)`);
  console.log(`  wheels: worst gap ${(r.wheelMax * 100).toFixed(1)} cm over ${r.wheelN} frames on the ground, ${r.wheelOver} over 5 cm (worst at ${JSON.stringify(r.wheelAt)})`);
  check(r.done, `${name}: the drive got to the end`);
  check(r.camUnder === 0 && r.camMin > 0, `${name}: the camera never enters the terrain or the ground`);
  check(r.camInBuilding === 0, `${name}: the camera never enters a building`);
  check(r.wheelN > 300 && r.wheelMax <= 0.05, `${name}: wheel ground error within 5 cm`);
}
console.log(fails ? `FAILED ${fails} of ${checks} checks` : `ok (${checks} checks)`);
process.exitCode = fails ? 1 : 0;
