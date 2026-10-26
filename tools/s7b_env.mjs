// Shared set-up for the stage S7b tests (tools/s7b_*.mjs): lets src/ui.js, src/3d/hud3d.js and src/3d/fx.js run
// in node on either world.
//  - KC_WORLD comes from the S7B_WORLD environment variable ('v2' unless set), before anything loads world.js.
//  - 'three' is the page's vendored copy. fx.js gets a stand-in for src/3d/city.js (S, and surfaceY =
//    world.groundY, which is what the facade exports), so no 3D city has to build.
//  - a tiny DOM: elements by id that keep their event listeners (so a test can send pointer, wheel and key
//    events), canvases whose 2D calls are recorded (or not, when timing), ImageData for the map picture.
//  - requestAnimationFrame and setTimeout queue their callbacks; frames(n, ms) and timers() run them.
// Import it first, then import() the modules under test.
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const src = rel => pathToFileURL(path.join(ROOT, rel)).href;
globalThis.KC_WORLD = process.env.S7B_WORLD || 'v2';

const THREE_URL = src('vendor/three.module.js');
const CITY_STUB = `import { groundY, PX_PER_M } from '${src('src/world.js')}'; export const S = 1 / PX_PER_M; export const surfaceY = groundY;`;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'three') return { url: THREE_URL, shortCircuit: true };
    if (spec === './city.js' && ctx.parentURL?.endsWith('/src/3d/fx.js'))
      return { url: 'data:text/javascript,' + encodeURIComponent(CITY_STUB), shortCircuit: true };
    return next(spec, ctx);
  },
});

// ---------- the DOM ----------

export const dom = { record: true };   // false: canvases keep no log (for timing)
function listeners(el) {
  el.on = {};
  el.addEventListener = (t, f) => { (el.on[t] ||= []).push(f); };
  el.removeEventListener = (t, f) => { el.on[t] = (el.on[t] || []).filter(g => g !== f); };
  el.dispatch = (t, e = {}) => { const ev = { type: t, target: el, preventDefault() {}, stopPropagation() {}, ...e }; for (const f of el.on[t] || []) f(ev); return ev; };
}
function makeCanvas() {
  const c = { isStubCanvas: true, width: 300, height: 150, log: [], style: {}, clientLeft: 4, clientTop: 4 };
  const state = {};
  const norm = a => (a && a.isStubCanvas ? { canvas: `${a.width}x${a.height}` } : a);
  const ctx = new Proxy(state, {
    get(t, k) {
      if (k === 'canvas') return c;
      if (k === 'measureText') return s => ({ width: String(s).length * 7 });
      if (k === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      if (/^create(Radial|Linear|Conic)Gradient$|^createPattern$/.test(k)) return () => ({ addColorStop() {} });
      if (Object.hasOwn(t, k)) return t[k];
      if (typeof k === 'symbol') return undefined;
      return (...args) => { if (dom.record) c.log.push([k, ...args.map(norm)]); };
    },
    set(t, k, v) { t[k] = v; if (dom.record) c.log.push(['=' + String(k), norm(v)]); return true; },
  });
  c.getContext = () => ctx;
  return c;
}
function element(id, tag = 'div') {
  const el = tag === 'canvas' ? makeCanvas() : { style: {} };
  Object.assign(el, {
    id, tag, children: [], dataset: {}, textContent: '', innerHTML: '', className: '', offsetWidth: 0, title: '',
    classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, toggle(c, on = !this.set.has(c)) { if (on) this.set.add(c); else this.set.delete(c); }, contains(c) { return this.set.has(c); } },
    appendChild(ch) { el.children.push(ch); ch.parent = el; return ch; },
    append(...chs) { for (const ch of chs) el.appendChild(ch); },
    remove() { if (el.parent) el.parent.children = el.parent.children.filter(c => c !== el); el.parent = null; },
    querySelector: sel => (sel === '.hint' ? (el.hint ||= element('', 'div')) : element('q')),
    setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 0, height: 0 }),
    get firstChild() { return el.children[0]; },
  });
  listeners(el);
  return el;
}
const ids = {};
globalThis.document = {
  getElementById: id => (ids[id] ||= element(id, /minimap|Canvas$/.test(id) ? 'canvas' : 'div')),
  createElement: tag => element('', tag),
  body: element('body'),
};
export const byId = id => document.getElementById(id);

globalThis.window = globalThis;
Object.assign(globalThis, { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 2 });
listeners(globalThis);
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.location = { search: '', href: 'http://localhost/' };
globalThis.ImageData = class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } };
globalThis.Image = class { constructor() { this.complete = false; } };
const store = new Map();
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: k => { store.delete(k); } };
export { store };

// animation frames and timers wait in queues until the test runs them
let rafQ = [], timerQ = [], clock = 0;
globalThis.requestAnimationFrame = f => { rafQ.push(f); return rafQ.length; };
globalThis.setTimeout = (f, ms = 0) => { timerQ.push({ f, ms }); return timerQ.length; };
globalThis.clearTimeout = () => {};
// runs up to n frames, ms apart (frames a callback asks for run on the next one); returns how many ran
export function frames(n = 60, ms = 16.7) {
  let ran = 0;
  for (let i = 0; i < n && rafQ.length; i++) {
    clock += ms;
    const q = rafQ; rafQ = [];
    for (const f of q) f(clock);
    ran++;
  }
  return ran;
}
export const pendingFrames = () => rafQ.length;
// runs the timers queued so far that are due within maxMs (not ones they queue in turn) and returns them
export function timers(maxMs = Infinity) {
  const due = timerQ.filter(t => t.ms <= maxMs);
  timerQ = timerQ.filter(t => t.ms > maxMs);
  for (const t of due) t.f();
  return due;
}

// ---------- a tiny check harness ----------

let checks = 0, fails = 0;
export function check(name, ok, detail = '') {
  checks++;
  if (!ok) fails++;
  if (!ok || process.argv.includes('-v')) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail && (!ok || process.argv.includes('-v')) ? ': ' + detail : ''}`);
  return ok;
}
export function section(title) { console.log(title); }
export function note(text) { console.log(`    ${text}`); }
export function done(label = 's7b') {
  console.log(fails ? `${label}: FAILED ${fails} of ${checks} checks` : `${label}: ok (${checks} checks)`);
  process.exitCode = fails ? 1 : 0;
}
