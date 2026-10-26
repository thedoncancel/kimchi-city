// Shared set-up for the stage S3a tests (tools/s3a_*.mjs): lets the browser-side 3D modules load in node.
//  - 'three' is the page's vendored copy; a baseline copy (which has no vendor/ folder) gets its addons from
//    this checkout.
//  - quality.js reads window, location and localStorage at load: a 1440 x 800 desktop (the High tier), or a
//    phone-sized window when S3A_LOW=1 is set.
//  - fetch reads files from the checkout, so loadGlb('assets/palms.glb') works.
// Import it first, then import() the modules under test.
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv.slice(2).find(a => !a.startsWith('-'));
export const BASE = arg || process.env.KC_BASELINE || '';
export const HAVE_BASE = !!BASE && existsSync(path.join(BASE, 'src/3d/geo.js'));

const THREE_URL = pathToFileURL(path.join(ROOT, 'vendor/three.module.js')).href;
const VENDOR = pathToFileURL(path.join(ROOT, 'vendor')).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'three') return { url: THREE_URL, shortCircuit: true };
    if (spec.startsWith('.') && ctx.parentURL && !ctx.parentURL.startsWith('data:')) {
      const url = new URL(spec, ctx.parentURL).href;
      const i = url.indexOf('/vendor/');
      if (i >= 0 && !existsSync(fileURLToPath(url))) return { url: VENDOR + url.slice(i + 7), shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

const low = process.env.S3A_LOW === '1';
globalThis.window = { matchMedia: () => ({ matches: false }), innerWidth: low ? 400 : 1440, innerHeight: low ? 700 : 800 };
globalThis.location = { search: '' };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.fetch = async (url) => {
  const file = path.join(ROOT, String(url));
  if (!existsSync(file)) return { ok: false, status: 404 };
  const b = readFileSync(file);
  return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
};

export const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
export const base = (rel) => pathToFileURL(path.join(BASE, rel)).href;

// a tiny check harness: check(name, ok, detail) prints failures; done() prints the tally and sets the exit code
let checks = 0, fails = 0;
export function check(name, ok, detail = '') {
  checks++;
  if (!ok) { fails++; console.log(`  FAIL ${name}${detail ? ': ' + detail : ''}`); }
  return ok;
}
export function section(title) { console.log(title); }
export function note(text) { console.log(`    ${text}`); }
export function done() {
  console.log(fails ? `FAILED ${fails} of ${checks} checks` : `ok (${checks} checks)`);
  process.exitCode = fails ? 1 : 0;
}

// a seeded random source (mulberry32), so every run sees the same cases
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
