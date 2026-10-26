#!/usr/bin/env node
// Stage S2c: the v2 map picture (docs/map-v2-spec.md §7, §11.1), headless.   node tools/s2c_map.mjs [-v]
// Builds the v2 world, paints the map the game shows (src/map/mapimage.js with the RoadNet and the buildings:
// region tints, hillshade, roads by class with the Loop wide and orange, footprints with their shadows,
// water by depth) and the far terrain's albedo (2 m per px, no hillshade), writes them to
// tools/out/s2c_map.png and tools/out/s2c_albedo.png, and checks them: sizes, the colours of the Loop, its
// casing, a boulevard, a building and the sea, district tints, the fallback from the rasters alone (what
// tools/map_check.mjs paints), the albedo without shade, and renderMap / farAlbedo on a stand-in canvas
// (2048×1792 with a label per region, 1024×896 without).
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as D from '../src/map/mapdata.js';
import * as W from '../src/world-v2.js';
import { mapPixels, renderMap, farAlbedo } from '../src/map/mapimage.js';

let passed = 0, failed = 0;
const VERBOSE = process.argv.includes('-v');
const ok = (cond, msg) => { if (cond) { passed++; if (VERBOSE) console.log('  ok   ' + msg); } else { failed++; console.log('  FAIL ' + msg); } };
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out'), PX = 16;

W.generate();
mkdirSync(OUT, { recursive: true });
const t0 = performance.now(), map = mapPixels(W, 1), tMap = performance.now() - t0;
const t1 = performance.now(), alb = mapPixels(W, 0.5, { shade: false, look: 'albedo' }), tAlb = performance.now() - t1;
writePng(join(OUT, 's2c_map.png'), map);
writePng(join(OUT, 's2c_albedo.png'), alb);
console.log(`tools/out/s2c_map.png ${map.w}×${map.h} painted in ${tMap.toFixed(0)} ms, tools/out/s2c_albedo.png ${alb.w}×${alb.h} in ${tAlb.toFixed(0)} ms`);

const px = (img, x, z) => { const o = (Math.floor(z) * img.w + Math.floor(x)) * 4; return [img.data[o], img.data[o + 1], img.data[o + 2]]; };
const pxA = (x, z) => px(alb, x / 2, z / 2);
const loop = W.roads.edges.find(e => e.road === 'loop' && !e.deck.length && e.n > 200), k = loop.n >> 1;
const lc = { x: loop.x[k] / PX, z: loop.y[k] / PX, nx: -loop.ty[k], nz: loop.tx[k] }, hw = loop.halfW / PX;
const orange = c => c[0] > 180 && c[1] > 90 && c[1] < 170 && c[2] < 90;

console.log('the map');
{
  ok(map.w === 2048 && map.h === 1792 && map.data.length === 2048 * 1792 * 4, 'map 2048×1792 at 1 px/m');
  ok(orange(px(map, lc.x + lc.nx * 5, lc.z + lc.nz * 5)), `the Loop is orange: ${px(map, lc.x + lc.nx * 5, lc.z + lc.nz * 5)}`);
  const cas = px(map, lc.x + lc.nx * (hw + 1.2), lc.z + lc.nz * (hw + 1.2));
  ok(cas[0] < 170 && cas[2] < 60 && cas[0] > cas[2], `with a dark casing past its shoulders: ${cas}`);
  const blvd = W.roads.edges.filter(e => e.road === 'biscayne').sort((a, b) => b.len - a.len)[0], q = blvd.n >> 1;
  const b = px(map, blvd.x[q] / PX - blvd.ty[q] * 5, blvd.y[q] / PX + blvd.tx[q] * 5);
  ok(b.every(v => v > 200), `a boulevard is pale: ${b}`);
  const lot = W.buildings.find(q => q.kind === 'lot' && q.style === 'tower' && q.w > 24), inside = px(map, lot.cx, lot.cz);
  ok(inside.every(v => v > 150) && Math.abs(inside[0] - inside[2]) < 60, `a tower's roof is pale, tinted by its roof colour: ${inside}`);
  // its outline: the px of the footprint's rim are the dark outline colour
  let rim = 0, dark = 0;
  const r = Math.hypot(lot.w, lot.d) / 2 + 1, inFoot = (x, z) => { const qx = x - lot.cx, qz = z - lot.cz; return Math.abs(qx * Math.sin(lot.a) - qz * Math.cos(lot.a)) <= lot.w / 2 && Math.abs(qx * Math.cos(lot.a) + qz * Math.sin(lot.a)) <= lot.d / 2; };
  for (let z = Math.floor(lot.cz - r); z <= lot.cz + r; z++) for (let x = Math.floor(lot.cx - r); x <= lot.cx + r; x++) {
    if (!inFoot(x + 0.5, z + 0.5) || [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => inFoot(x + 0.5 + dx, z + 0.5 + dz))) continue;
    rim++;
    if (px(map, x, z).every(v => v < 130)) dark++;
  }
  ok(rim > 40 && dark / rim > 0.9, `outlined: ${dark}/${rim} rim px dark`);
  const deep = px(map, 1500, 1720), near = px(map, 1290, 470);
  ok(deep[2] > deep[0] && near[2] > near[0] && deep[2] < near[2], `water is blue, darker where deep: ${deep} vs ${near}`);
  const gables = px(map, 620, 1180), glades = px(map, 300, 700), town = px(map, 960, 650);
  ok(gables.join() !== glades.join() && town[0] > gables[0] + 30, `districts tinted: Gables ${gables}, Glades ${glades}, K-Town ${town}`);
}

console.log('from the rasters alone (tools/map_check.mjs)');
{
  const raw = mapPixels({ grids: W.grids }, 1);
  ok(raw.w === 2048 && orange(px(raw, lc.x + lc.nx * 5, lc.z + lc.nz * 5)), 'the Loop is still orange (by its NOPED flag)');
  const lot = W.buildings.find(q => q.kind === 'lot');
  ok(px(raw, lot.cx, lot.cz).join() === px(map, lot.cx, lot.cz).join() || px(raw, lot.cx, lot.cz).every(v => v > 170), 'the footprints still show');
}

console.log('the far albedo');
{
  ok(alb.w === 1024 && alb.h === 896, 'albedo 1024×896 at 2 m per px');
  const a = pxA(lc.x, lc.z);
  ok(!orange(a) && a[0] < 120 && Math.abs(a[0] - a[2]) < 25, `the Loop in asphalt: ${a}`);
  // no hillshade: two grass points on the Coral Heights dome, one on each side of the summit, look alike
  const n = pxA(330, 120), s = pxA(330, 380), e = W.surfaceAt(330 * PX, 120 * PX) === 2 && W.surfaceAt(330 * PX, 380 * PX) === 2;
  ok(!e || Math.abs(n[0] - s[0]) + Math.abs(n[1] - s[1]) + Math.abs(n[2] - s[2]) < 12, `no hillshade: the dome's north ${n} and south ${s} faces`);
  const m = px(map, 330, 120), ms = px(map, 330, 380);
  ok(Math.abs(m[1] - ms[1]) > 8, `while the map shades them: ${m} vs ${ms}`);
}

console.log('renderMap and farAlbedo on a canvas');
{
  const calls = { text: [], put: 0 };
  globalThis.ImageData = class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } };
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { putImageData: () => calls.put++, fillText: t => calls.text.push(t), strokeText() {}, save() {}, restore() {} }; }
  };
  const c = renderMap(W);
  ok(c.width === 2048 && c.height === 1792 && calls.put === 1, 'renderMap: a 2048×1792 canvas');
  const named = D.REGIONS.map(r => r.name.toUpperCase());
  ok(calls.text.length === D.REGIONS.length && named.every(n => calls.text.includes(n)), `a label for every region: ${calls.text.join(', ')}`);
  calls.text.length = 0;
  const f = farAlbedo(W);
  ok(f.width === 1024 && f.height === 896 && calls.text.length === 0, 'farAlbedo: 1024×896, no labels');
  delete globalThis.OffscreenCanvas; delete globalThis.ImageData;
  let threw = false;
  try { renderMap(W); } catch { threw = true; }
  ok(threw, 'without a canvas renderMap says so (node uses mapPixels)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// A plain RGB PNG from RGBA pixels: filter byte 0 on every row, one zlib IDAT.
function writePng(path, { w, h, data }) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const o = (j * w + i) * 4, r = j * (w * 3 + 1) + 1 + i * 3;
    raw[r] = data[o]; raw[r + 1] = data[o + 1]; raw[r + 2] = data[o + 2];
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4), crc = Buffer.alloc(4), all = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    len.writeUInt32BE(body.length); crc.writeUInt32BE(crc32(all));
    return Buffer.concat([len, all, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]));
}
function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let q = 0; q < 8; q++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
