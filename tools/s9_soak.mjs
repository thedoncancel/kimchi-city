#!/usr/bin/env node
// Stage S9: a long run of the v2 game in headless Chrome, for frame times and memory over minutes (spec §11.2:
// p95 frame under 16.7 ms on Medium, the Low tier at 30 fps or better, the heap flat). Needs the dev server on :5173.
//   node tools/s9_soak.mjs [--sec=300] [--level=2] [--low] [--drive=x0,z0,x1,z1[,vmax]] [--hour=15.5] [--out=file.json]
// By default KC3.soak tours every bench view in turn (a teleport every sec/8 s) with the game running; --drive
// instead has main3d's dev pilot drive Kimchi's car along the roads from (x0, z0) to (x1, z1) metres (&route=, as
// tools/s6b_drive.mjs uses it) while the soak measures, and the tour is off. The report is KC3.soak's: frames,
// fps, frame time p50/p95/p99/worst (ms), JS time, calls and triangles (median), heap every 10 s (MB), and the
// city's chunk and population stats. The quality level is held at --level (2, Medium; 1 High) on the computer
// tier. Headless Chrome runs at 60 Hz here, so frame times under 16.7 ms mean no frame was missed; the heap needs --enable-precise-memory-info (s9_lib passes it).
import { writeFileSync } from 'node:fs';
import { openPage } from './s9_lib.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const sec = +opt('sec', 300), level = +opt('level', 2), low = args.includes('--low'), drive = opt('drive', ''), hour = +opt('hour', 15.5), out = opt('out', '');

const page = await openPage(`map=2&shot=villa_terrace&hour=${hour}${drive ? `&route=${drive}` : ''}`, { gfx: low ? 'low' : 'high' });
try {
  await page.ready(3000);
  if (!low) await page.evaluate(`KC3.gfx.setLevel(${level})`);
  const report = await page.evaluate(`KC3.soak(${sec}, { route: ${drive ? 'null' : 'true'} })`);
  const h = report.heapMB, f = report.frameMs;
  console.log(`${low ? 'Low tier' : report.gfx} ${sec} s ${drive ? 'drive' : 'tour'}: ${report.frames} frames, ${report.fps} fps; frame p50 ${f.p50} p95 ${f.p95} p99 ${f.p99} worst ${f.worst} ms; ` +
    `JS p95 ${report.cpuMs.p95} ms; calls ${report.calls}, tris ${(report.tris / 1e6).toFixed(2)} M`);
  if (h) {
    const n = h.every10s.length, first = h.every10s.slice(1, Math.max(2, Math.floor(n / 3))), last = h.every10s.slice(-Math.max(1, Math.floor(n / 3)));
    const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    console.log(`heap: start ${h.start} MB, end ${h.end}, min ${h.min}, max ${h.max}; first third ${avg(first).toFixed(1)} -> last third ${avg(last).toFixed(1)} MB`);
  }
  console.log(`cars ${report.cars}, peds ${report.peds}, car views ${report.carViews}; chunks ${JSON.stringify(report.stats?.chunks ? { built: report.stats.chunks.built, peak: report.stats.chunks.peak, evictions: report.stats.chunks.evictions, maxSliceMs: Math.round(report.stats.chunks.maxSliceMs * 10) / 10 } : null)}`);
  if (drive) {
    // how far the dev pilot got (main3d logs KCROUTE once a second and KCROUTE_END at the end)
    const lines = page.log.split('\n').map((l) => l.match(/"(KCROUTE.*)", source/)?.[1]).filter(Boolean);
    console.log(`drive: ${lines.find((l) => l.startsWith('KCROUTE failed') || l.startsWith('KCROUTE_END')) || lines[lines.length - 1] || 'no route log'}`.slice(0, 300));
  }
  if (out) writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), low, drive, hour, report }, null, 2));
} finally {
  await page.close();
}
