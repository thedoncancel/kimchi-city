#!/usr/bin/env node
// Close-ups of the v2 junctions for stage S4b's check (docs/map-v2-stages.json): 25 junctions, all 5 ring
// entries and every X node among them, each from 10, 50 and 200 m, through tools/shot.sh (headless Chrome on
// the dev server at :5173, one capture at a time, about 15-20 s each).
//   node tools/s4b_junction_shots.mjs <out dir> [--hour=15] [--only=10,50,200] [--nodes=3,14,...] [--list]
// The 10 m camera stands over the widest corner of its junction (the bisector of the largest gap between
// its roads) at 4 m up; the 50 m and 200 m ones over its longest road, 14 m and 45 m up (never under the
// ground there); each looks at the node. Files are <out>/j<node>_<kind>_<distance>.png (one already there is
// kept); --list only prints the plan.
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.KC_WORLD = 'v2';
const W = await import(path.join(ROOT, 'src/world.js'));
W.generate();
const PX = 16;
const args = process.argv.slice(2);
const out = args.find(a => !a.startsWith('--'));
const opt = (k, d) => args.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const hour = +opt('hour', 15), list = args.includes('--list');
const dists = opt('only', '10,50,200').split(',').map(Number);
if (!out && !list) { console.log('usage: node tools/s4b_junction_shots.mjs <out dir> [--hour=15] [--only=10,50,200] [--nodes=..] [--list]'); process.exit(2); }

// the 25: every ring entry and X node, then the T's that matter most (the Loop's in the hills and at the
// bridges, the villa's, the Key's), filled up from the rest in order
const nodes = W.roads.nodes.filter(N => N.ends.length >= 2);
const pick = [];
const want = opt('nodes', '').split(',').filter(Boolean).map(Number);
if (want.length) pick.push(...nodes.filter(N => want.includes(N.id)));
else {
  pick.push(...nodes.filter(N => N.kind === 'ring'), ...nodes.filter(N => N.kind === 'X'));
  for (const id of [3, 2, 0, 59, 52, 35, 53, 28, 8, 1]) { const N = nodes.find(q => q.id === id); if (N && !pick.includes(N) && pick.length < 25) pick.push(N); }
  for (const N of nodes) if (pick.length < 25 && !pick.includes(N)) pick.push(N);
}

const plan = [];
for (const N of pick) {
  const x = N.x / PX, z = N.y / PX, gy = W.groundY(N.x, N.y);
  // the bisector of the widest gap between the roads leaving the node
  const a = N.ends.map(E => E.a).sort((p, q) => p - q);
  let best = 0, bear = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = i + 1 < a.length ? a[i + 1] : a[0] + Math.PI * 2;
    if (q - p > best) { best = q - p; bear = (p + q) / 2; }
  }
  // from 50 m and more the camera stands over the longest road out of the node instead (a corner block may
  // hold a building)
  const longest = N.ends.reduce((p, q) => (W.roads.edges[q.e].len > W.roads.edges[p.e].len ? q : p));
  for (const d of dists) {
    const h = d <= 10 ? 4 : d <= 50 ? 14 : 45, b = d <= 10 ? bear : longest.a;
    const cx = x + Math.cos(b) * d, cz = z + Math.sin(b) * d;
    const cy = Math.max(gy, W.groundY(cx * PX, cz * PX)) + h;
    plan.push({ id: N.id, kind: N.kind, d, cam: [cx, cy, cz, x, gy + 0.5, z].map(v => +v.toFixed(1)) });
  }
}
if (list) { for (const p of plan) console.log(`node ${p.id} ${p.kind} ${p.d} m: cam=${p.cam.join(',')}`); process.exit(0); }
mkdirSync(out, { recursive: true });
let n = 0;
for (const p of plan) {
  const file = path.join(out, `j${p.id}_${p.kind}_${p.d}.png`);
  if (existsSync(file)) { n++; continue; }
  const r = spawnSync(path.join(ROOT, 'tools/shot.sh'), [`map=2&shot=villa_terrace&hour=${hour}&cam=${p.cam.join(',')}`, file, '960', '540'], { encoding: 'utf8' });
  n++;
  console.log(`${n}/${plan.length} node ${p.id} ${p.kind} ${p.d} m: ${r.status === 0 ? file : 'failed ' + (r.stdout + r.stderr).trim().split('\n').pop()}`);
}
