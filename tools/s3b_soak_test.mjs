#!/usr/bin/env node
// Stage S3b soak (docs/map-v2-stages.json): 15 minutes of game frames (54,000 at 60 fps) through the grid
// city's update in node, the part of the 15-minute browser soak this stage adds work to: the chunk manager,
// the cell re-sorts, the palm and scatter refreshes, the tree tucking and the lamp-light search, with the
// camera driving laps of the town, standing at the bench views and orbiting on the title screen.
//   node tools/s3b_soak_test.mjs [minutes]          (S3B_LOW=1 for the phone tier)
// Checks that the heap is flat (after a full GC: under 4 MB of growth between minute 1 and the end, and no
// minute-on-minute climb), and reports the update's cost per frame. Exits 1 if a check fails.
import v8 from 'node:v8';
import vm from 'node:vm';
import { src, check, section, note, done, seeded, quiet } from './s3b_env.mjs';
const D = await import('./s3b_draws.mjs');
const THREE = await import('three');

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
const heapMB = () => { gc(); gc(); return process.memoryUsage().heapUsed / 1048576; };

const W = await import(src('src/world.js'));
const CITY = await import(src('src/3d/city.js'));
W.generate();

const scene = new THREE.Scene();
const sun = D.makeSun(process.env.S3B_LOW === '1' ? 42 : 64);   // sky.js's shadow box: 84 m on the low tier, 128 m on the high one
scene.add(sun, sun.target);
const city = await quiet(() => seeded(3, () => CITY.buildCity(scene)));
await quiet(() => new Promise((r) => setTimeout(r, 1500)));   // the palm and asset-pack models load

const minutes = +(process.argv.find((a) => /^\d+(\.\d+)?$/.test(a)) || 15);
const FPS = 60, frames = Math.round(minutes * 60 * FPS);
const camera = new THREE.PerspectiveCamera(62, 1440 / 800, 0.1, 4000);
const focus = new THREE.Vector3(), look = new THREE.Vector3(), lights = [];

// where the camera is on frame i: a lap of the ring road and across the middle at 20 m/s (2 minutes), a stop
// at each bench view (5 s each), then a minute of the title orbit, round and round
const lap = [[24, 24], [320, 24], [320, 320], [24, 320], [24, 24], [172, 172], [320, 320], [24, 24]];
const legs = lap.slice(1).map((b, k) => ({ a: lap[k], b, len: Math.hypot(b[0] - lap[k][0], b[1] - lap[k][1]) }));
const lapLen = legs.reduce((n, l) => n + l.len, 0);
const CYCLE = 120 + 5 * W.benchViews.length + 60;   // s
function place(i) {
  const t = (i / FPS) % CYCLE;
  if (t < 120) {
    let s = (t * 20) % lapLen;
    const leg = legs.find((l) => (s -= l.len) < 0) || legs[legs.length - 1];
    const u = 1 + s / leg.len, dx = (leg.b[0] - leg.a[0]) / leg.len, dz = (leg.b[1] - leg.a[1]) / leg.len;
    const x = leg.a[0] + (leg.b[0] - leg.a[0]) * u, z = leg.a[1] + (leg.b[1] - leg.a[1]) * u;
    focus.set(x, 0, z);
    camera.position.set(x - dx * 6.9, 3, z - dz * 6.9);
    look.set(x + dx * 3, 1, z + dz * 3);
    camera.lookAt(look);
  } else if (t < 120 + 5 * W.benchViews.length) {
    const v = W.benchViews[Math.floor((t - 120) / 5)];
    focus.copy(D.placeCamera(camera, v, { groundY: W.groundY, occluderTop: CITY.occluderTop }));
  } else {
    const a = t * 0.035;
    focus.set(172, 0, 172);
    camera.position.set(172 + Math.cos(a) * 175, 72, 172 + Math.sin(a) * 175);
    camera.lookAt(look.set(172, 4, 172));
  }
  camera.updateMatrixWorld(true);
}

section(`soak: ${minutes} minutes of frames (${frames})`);
const times = new Float64Array(frames), heap = [];   // (allocated up front, so the test's own lists do not grow the heap)
let t = 0;
for (let i = 0; i < frames; i++) {
  place(i);
  if (i % 4 === 0) D.placeSun(sun, 13 * 60, focus);   // (sky.js moves the shadow box every frame; a quarter is plenty here)
  const t0 = performance.now();
  CITY.clearTreesForCamera(camera.position, focus);
  city.update(camera, (t += 1 / FPS));
  if (i % 15 === 0) CITY.nearestLamps(focus.x, focus.z, 6, lights);     // main3d: every 0.25 s
  times[i] = performance.now() - t0;
  if (i % (60 * FPS) === 0) heap.push(heapMB());
}
heap.push(heapMB());

let worstAt = 0;
for (let i = 1; i < frames; i++) if (times[i] > times[worstAt]) worstAt = i;
const slow = times.reduce((n, v, i) => n + (i > 0 && v > 2 ? 1 : 0), 0);
times.sort((a, b) => a - b);
const pct = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))];
note(`city.update per frame: p50 ${pct(0.5).toFixed(3)} ms, p95 ${pct(0.95).toFixed(3)} ms, p99 ${pct(0.99).toFixed(3)} ms, ` +
  `worst ${times[times.length - 1].toFixed(2)} ms (frame ${worstAt}); ${slow} frames after the first over 2 ms`);
note(`heap after GC, each minute (MB): ${heap.map((h) => h.toFixed(1)).join(' ')}`);
const st = city.chunks.stats();
note(`chunk manager: ${st.objects} entries, ${st.visible} drawn, ${st.casting} casting now`);

const base = heap[Math.min(1, heap.length - 1)], end = heap[heap.length - 1];
check(`the heap is flat over the soak (minute 1 to the end: ${(end - base >= 0 ? '+' : '') + (end - base).toFixed(2)} MB)`, end - base < 4);
let climbs = 0;
for (let k = 2; k < heap.length; k++) if (heap[k] > heap[k - 1] + 0.5) climbs++;
check(`no steady climb from minute to minute (${climbs} rises of more than 0.5 MB)`, climbs <= Math.max(1, heap.length / 4));
check('the update stays cheap (p95 under 1 ms in node)', pct(0.95) < 1, `${pct(0.95).toFixed(3)} ms`);
done();
