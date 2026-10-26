// Shared set-up for the stage S3b tests (tools/s3b_*.mjs): lets the grid city (src/3d/cityGrid.js) build in node.
//  - 'three' is the page's vendored copy; a baseline copy (which has no vendor/ folder) gets its addons from
//    this checkout.
//  - a tiny DOM: canvases record their 2D calls (so painted textures can be compared), images never load.
//  - quality.js sees a 1440 x 800 desktop (the High tier), or a phone-sized window when S3B_LOW=1 is set.
//  - fetch reads files from the checkout, so the palm and asset-pack models load as they do in the browser;
//    pictures (blob()) never decode, so every build keeps its painted stand-ins.
// Import it first, then import() the modules under test.
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv.slice(2).find(a => !a.startsWith('-'));
export const BASE = arg || process.env.KC_BASELINE || '';
export const HAVE_BASE = !!BASE && existsSync(path.join(BASE, 'src/3d/city.js'));

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

// ---------- a tiny DOM ----------

let canvasNo = 0;
function makeCanvas() {
  const log = [];
  const canvas = { isStubCanvas: true, id: ++canvasNo, width: 300, height: 150, log, style: {} };
  const norm = (a) => (a && a.isStubCanvas ? `canvas:${canvasSig(a)}` : a && a.isGradient ? `grad:${JSON.stringify(a.stops)}` : a && typeof a === 'object' ? '[object]' : a);
  const special = {
    canvas,
    createRadialGradient: (...a) => ({ isGradient: true, stops: [['r', ...a]], addColorStop(o, c) { this.stops.push([o, c]); } }),
    createLinearGradient: (...a) => ({ isGradient: true, stops: [['l', ...a]], addColorStop(o, c) { this.stops.push([o, c]); } }),
    measureText: (t) => { log.push(['measureText', t]); return { width: String(t).length * 10 }; },
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  };
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k in special) return special[k];
      if (Object.hasOwn(t, k)) return t[k];
      if (typeof k === 'symbol') return undefined;
      return (...args) => { log.push([k, ...args.map(norm)]); };
    },
    set(t, k, v) { log.push(['=', k, norm(v)]); t[k] = v; return true; },
  });
  canvas.getContext = () => ctx;
  canvas.addEventListener = () => {};
  return canvas;
}
// a canvas's identity: its size and everything drawn on it
export function canvasSig(c) { return `${c.width}x${c.height}:${fnv(JSON.stringify(c.log))}`; }
export function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

// an <img> (three's ImageLoader, for the pictures inside the asset packs) that 'loads' as soon as it gets an
// address, as a 1 x 1 picture
function makeImg() {
  const on = {};
  const img = {
    isStubImage: true, style: {}, width: 1, height: 1, naturalWidth: 1, naturalHeight: 1,
    addEventListener(t, f) { (on[t] ||= []).push(f); },
    removeEventListener(t, f) { on[t] = (on[t] || []).filter((g) => g !== f); },
  };
  let src = '';
  Object.defineProperty(img, 'src', {
    get: () => src,
    set(v) { src = v; setTimeout(() => { for (const f of (on.load || []).slice()) f.call(img, {}); }, 0); },
  });
  return img;
}

const low = process.env.S3B_LOW === '1';
const store = new Map();
Object.assign(globalThis, {
  window: globalThis, self: globalThis,
  innerWidth: low ? 400 : 1440, innerHeight: low ? 700 : 800, devicePixelRatio: 1,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  location: { search: '', href: 'http://localhost/' },
  localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  document: {
    createElement: (t) => (t === 'canvas' ? makeCanvas() : { style: {}, addEventListener() {}, appendChild() {} }),
    createElementNS: (ns, tag) => (tag === 'img' ? makeImg() : { style: {}, addEventListener() {}, removeEventListener() {} }),
  },
  // pictures never load, except the 1 x 1 WebP probe three's GLTFLoader makes before reading the asset packs
  Image: class {
    constructor() { this.width = 0; this.height = 0; }
    set src(v) { if (String(v).startsWith('data:image/webp')) setTimeout(() => { this.width = this.height = 1; this.onload?.(); }, 0); }
  },
  // three's FileLoader (the asset packs) wraps the address in a Request first, which wants an absolute one
  Request: class { constructor(url) { this.url = String(url); } },
  fetch: async (url) => {
    const file = path.join(ROOT, String(url?.url ?? url));
    if (!existsSync(file)) return { ok: false, status: 404 };
    const b = readFileSync(file);
    return {
      ok: true, status: 200,
      arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
      blob: async () => { throw new Error('no picture decoding in node'); },
    };
  },
});

export const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
export const base = (rel) => pathToFileURL(path.join(BASE, rel)).href;

// ---------- a tiny check harness ----------

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

// Math.random replaced by a seeded source (mulberry32) while fn runs, so two builds see the same numbers
export async function seeded(seed, fn) {
  const real = Math.random;
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try { return await fn(); } finally { Math.random = real; }
}
export async function quiet(fn) {
  const w = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = w; }
}
