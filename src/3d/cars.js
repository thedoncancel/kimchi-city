import * as THREE from 'three';
import { CAR_TYPES } from '../data.js';
import { Builder, col, mat4 } from './geo.js';
import * as TX from './textures.js';
import { HIGH, matte } from './quality.js';
import { parseGlb } from './glb.js';

const S = 1 / 16;

// side profiles: x positions are fractions of the car's length, heights in metres
const PRO = {
  hatch: { hb: 0.9, hf: 0.78, ht: 0.92, cr0: -0.47, cr1: -0.41, cf1: 0.06, cf0: 0.28, hr: 1.46, R: 0.31, wx: 0.31, sill: 0.3 },
  sedan: { hb: 0.86, hf: 0.76, ht: 0.86, cr0: -0.31, cr1: -0.2, cf1: 0.1, cf0: 0.27, hr: 1.4, R: 0.32, wx: 0.32, sill: 0.3 },
  taxi: { hb: 0.86, hf: 0.76, ht: 0.86, cr0: -0.31, cr1: -0.2, cf1: 0.1, cf0: 0.27, hr: 1.4, R: 0.32, wx: 0.32, sill: 0.3 },
  police: { hb: 0.86, hf: 0.76, ht: 0.86, cr0: -0.3, cr1: -0.19, cf1: 0.1, cf0: 0.27, hr: 1.42, R: 0.33, wx: 0.32, sill: 0.3 },
  sports: { hb: 0.7, hf: 0.6, ht: 0.74, cr0: -0.26, cr1: -0.13, cf1: 0.05, cf0: 0.22, hr: 1.12, R: 0.33, wx: 0.31, sill: 0.26 },
  van: { hb: 1.05, hf: 0.95, ht: 1.05, R: 0.34, wx: 0.32, sill: 0.32, van: true },
  // the luxury cars (wheel: rim style, tw: tyre width, two: height of the two-tone split)
  ursa: { hb: 1.0, hf: 0.96, ht: 1.0, cr0: -0.47, cr1: -0.15, cf1: 0.07, cf0: 0.27, hr: 1.58, R: 0.43, wx: 0.33, sill: 0.42, wheel: 'black', tw: 0.32 },
  gwagen: { box: true, hb: 1.14, hf: 1.12, ht: 1.14, hr: 1.98, R: 0.42, wx: 0.31, sill: 0.46, wheel: 'black', tw: 0.3 },
  monarch: { hb: 0.94, hf: 0.82, ht: 0.94, cr0: -0.33, cr1: -0.21, cf1: 0.1, cf0: 0.27, hr: 1.48, R: 0.37, wx: 0.34, sill: 0.33, wheel: 'chrome', two: 0.64 },
  phantasma: { hb: 1.05, hf: 1.0, ht: 1.0, cr0: -0.37, cr1: -0.26, cf1: 0.07, cf0: 0.22, hr: 1.64, R: 0.41, wx: 0.35, sill: 0.37, wheel: 'chrome' },
  cavallo: { hb: 0.8, hf: 0.6, ht: 0.84, cr0: -0.36, cr1: -0.21, cf1: -0.02, cf0: 0.16, hr: 1.2, R: 0.35, wx: 0.34, sill: 0.24, wheel: 'sport', tw: 0.3 },
  papaya: { hb: 0.78, hf: 0.5, ht: 0.92, cr0: -0.21, cr1: -0.09, cf1: 0.06, cf0: 0.3, hr: 1.17, R: 0.34, wx: 0.32, sill: 0.22, wheel: 'sport', tw: 0.3 },
  bolide: { hb: 0.84, hf: 0.62, ht: 0.94, cr0: -0.26, cr1: -0.12, cf1: 0.06, cf0: 0.26, hr: 1.18, R: 0.36, wx: 0.31, sill: 0.24, wheel: 'sport', tw: 0.32, two: 0.5 },
};

const HEAD = new THREE.MeshLambertMaterial({ color: '#fffaf0', emissive: new THREE.Color('#fff1c8'), emissiveIntensity: 0.2 });
const HEAD_OFF = new THREE.MeshLambertMaterial({ color: '#e8e4da', emissive: new THREE.Color('#fff1c8'), emissiveIntensity: 0.1 });
const TAIL_OFF = new THREE.MeshLambertMaterial({ color: '#7a1a14', emissive: new THREE.Color('#ff2a1a'), emissiveIntensity: 0.25 });
const TAIL_ON = new THREE.MeshLambertMaterial({ color: '#ff3b2f', emissive: new THREE.Color('#ff2a1a'), emissiveIntensity: 2.4 });
const GLASS = HIGH ? new THREE.MeshPhysicalMaterial({ color: '#0e141b', metalness: 0.2, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0 })
  : new THREE.MeshStandardMaterial({ color: '#16202b', metalness: 0.6, roughness: 0.12 });
// the car Kimchi drives gets see-through windows so you can watch him (and friends) inside
const GLASS_CLEAR = new THREE.MeshStandardMaterial({ color: '#41606f', metalness: 0.35, roughness: 0.04, transparent: true, opacity: 0.42, depthWrite: false });
const TRIM = matte({ vertexColors: true }, 0.55);
const WHEEL = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.55 });
// chrome monoblock rims; the tyre in the same mesh is so dark it still reads as rubber
const WHEEL_CHROME = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.92, roughness: 0.22 });
const CHROME = new THREE.MeshStandardMaterial({ color: '#e9ebef', metalness: 1, roughness: 0.16 });
const ARCH = matte({ color: '#111113' });
const POOL = new THREE.MeshBasicMaterial({ map: TX.headlightPool(), color: '#fff0cc', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
const WRECK = new THREE.MeshStandardMaterial({ color: '#2d2926', metalness: 0.2, roughness: 0.95 });
const WRECK_GLASS = new THREE.MeshLambertMaterial({ color: '#0c0b0a' });
const COP_RED = new THREE.MeshLambertMaterial({ color: '#c81414', emissive: new THREE.Color('#ff0000'), emissiveIntensity: 0.3 });
const COP_BLUE = new THREE.MeshLambertMaterial({ color: '#1438c8', emissive: new THREE.Color('#0028ff'), emissiveIntensity: 0.3 });
let taxiMat = null, vanMat = null, copMat = null;
const paints = new Map();
function paint(color) {
  let m = paints.get(color);
  // high tier: metallic base under a glossy clear coat, like real car paint
  if (!m) {
    m = HIGH ? new THREE.MeshPhysicalMaterial({ color, metalness: 0.45, roughness: 0.42, clearcoat: 1, clearcoatRoughness: 0.06 })
      : new THREE.MeshStandardMaterial({ color, metalness: 0.28, roughness: 0.34 });
    paints.set(color, m);
  }
  return m;
}

// The far LOD (beyond CAR_NEAR) is one mesh coloured per vertex. Its head and tail lights glow through a
// per-vertex weight (carGlow: head, tail) that the shader adds to the emissive light, at the strength the full
// car's light materials have, so a far car's lights stay on at night. One material per state of the lights
// (FAR_MATS[running][braking]); all four share one shader program and differ only in these uniforms.
const GLOW = {
  headOn: { value: HEAD.emissiveIntensity }, headOff: { value: HEAD_OFF.emissiveIntensity },
  tailOff: { value: TAIL_OFF.emissiveIntensity }, tailOn: { value: TAIL_ON.emissiveIntensity },
  headC: { value: HEAD.emissive }, tailC: { value: TAIL_OFF.emissive },
};
function glowShader(sh, head, tail) {
  Object.assign(sh.uniforms, { carHead: head, carTail: tail, carHeadC: GLOW.headC, carTailC: GLOW.tailC });
  sh.vertexShader = 'attribute vec2 carGlow;\nvarying vec2 vCarGlow;\n'
    + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvCarGlow = carGlow;');
  sh.fragmentShader = 'uniform float carHead;\nuniform float carTail;\nuniform vec3 carHeadC;\nuniform vec3 carTailC;\nvarying vec2 vCarGlow;\n'
    + sh.fragmentShader.replace('#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += carHeadC * ( vCarGlow.x * carHead ) + carTailC * ( vCarGlow.y * carTail );');
}
function farMaterial(head, tail) {
  // close to the paint's look (the clear coat on the high tier), since most of a car is paint
  const m = HIGH ? new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: 0.4, roughness: 0.42, clearcoat: 1, clearcoatRoughness: 0.08 })
    : new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.28, roughness: 0.36 });
  m.onBeforeCompile = (sh) => glowShader(sh, head, tail);
  return m;
}
const FAR_MATS = [
  [farMaterial(GLOW.headOff, GLOW.tailOff), farMaterial(GLOW.headOff, GLOW.tailOn)],   // parked: [lights off, braking]
  [farMaterial(GLOW.headOn, GLOW.tailOff), farMaterial(GLOW.headOn, GLOW.tailOn)],     // running
];

// small geometries every view of a kind shares (made once, never per car)
const shared = {};
const sharedGeo = (key, make) => shared[key] || (shared[key] = make());
const poolGeo = () => sharedGeo('pool', () => new THREE.PlaneGeometry(7, 15));
const taxiSignGeo = () => sharedGeo('taxiSign', () => new THREE.BoxGeometry(0.5, 0.2, 0.34));
const vanLogoGeo = () => sharedGeo('vanLogo', () => new THREE.PlaneGeometry(2.4, 0.6));
const copLogoGeo = () => sharedGeo('copLogo', () => new THREE.PlaneGeometry(2.1, 0.3));

export function setCarNight(k) {
  HEAD.emissiveIntensity = 0.2 + k * 2.6;
  TAIL_OFF.emissiveIntensity = 0.25 + k * 0.9;
  POOL.opacity = k * 0.55;
  if (taxiMat) taxiMat.emissiveIntensity = 0.2 + k * 1.2;
  // the far LOD's lights glow with the same strength as the full car's
  GLOW.headOn.value = HEAD.emissiveIntensity;
  GLOW.tailOff.value = TAIL_OFF.emissiveIntensity;
}

// red/blue flashing on every police light bar (all units flash in sync)
export function setPoliceLights(t, on) {
  const ph = (t * 7) % 4;
  const red = on && (ph < 0.6 || (ph > 1 && ph < 1.6)), blue = on && ((ph > 2 && ph < 2.6) || (ph > 3 && ph < 3.6));
  COP_RED.emissiveIntensity = red ? 2.2 : 0.25;
  COP_BLUE.emissiveIntensity = blue ? 3 : 0.25;
  return red ? 'red' : blue ? 'blue' : null;
}

function extrude(pts, depth, bevel) {
  const sh = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: depth - 2 * bevel, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, steps: 1, curveSegments: 1 });
  g.translate(0, 0, -(depth - 2 * bevel) / 2);
  return g;
}

// the luxury cars come smooth from Blender (tools/blender/build_cars.py, assets/cars/<type>.glb);
// until those load, or if they fail, every car is the procedural one built below
export const MODEL_CARS = ['ursa', 'gwagen', 'monarch', 'phantasma', 'cavallo', 'papaya', 'bolide',
  // everyday traffic: Quaternius' CC0 Low Poly Cars, converted by tools/blender/convert_qcars.py
  'sedan', 'hatch', 'taxi', 'police', 'sports'];
let traffic = {};   // assets/cars/traffic.json: axle positions, wheel radius and track of the traffic models
const models = {};

// fetch the Blender cars; onReady runs once they are in so the caller can rebuild its car views
export async function loadCarModels(onReady) {
  traffic = await fetch('assets/cars/traffic.json').then(r => (r.ok ? r.json() : {})).catch(() => ({}));
  const got = await Promise.all(MODEL_CARS.map(async (t) => {
    try {
      const r = await fetch(`assets/cars/${t}.glb`);
      if (!r.ok) throw new Error(r.status);
      return [t, parseGlb(await r.arrayBuffer())];
    } catch (e) { console.warn(`car model ${t} failed to load; keeping the built-in one`, e); return null; }
  }));
  let n = 0;
  for (const e of got) if (e && e[1].Body && e[1].Wheel) { models[e[0]] = e[1]; dropFar(cache[e[0]]); delete cache[e[0]]; n++; }
  if (n && onReady) onReady(n);
  return n;
}

const cache = {};
function typeGeo(type) {
  if (cache[type]) return cache[type];
  const base = procGeo(type), mod = models[type];
  if (!mod) return (cache[type] = base);
  return (cache[type] = {
    ...base, body: mod.Body, glass: mod.Glass || base.glass, trim: mod.Trim || base.trim, head: mod.Head || base.head, tail: mod.Tail || base.tail,
    chrome: mod.Chrome || null, lower: mod.Lower || null, wheel: mod.Wheel, arch: null, model: true,
    // the Blender cars have cartoon-sized wheels (WHEEL_K in tools/blender/build_cars.py)
    R: base.R * 1.14, tw: base.tw * 1.12,
    // the traffic models say where their own wheels are, and the police car brings its own light bar
    ...(traffic[type] ? { R: traffic[type].R, tw: traffic[type].tw, wx: traffic[type].wx, wxb: traffic[type].wxb, track: traffic[type].track,
      lights: base.lights && mod.SirenA ? { ...base.lights, red: mod.SirenB || mod.SirenA, blue: mod.SirenA } : base.lights } : {}),
  });
}

const procCache = {};
function procGeo(type) {
  if (procCache[type]) return procCache[type];
  const t = CAR_TYPES[type], p = PRO[type];
  const L = t.len * S, W = t.wid * S, hl = L / 2, I = new THREE.Matrix4();
  const X = f => f * L;
  const body = new Builder(), glass = new Builder(), trim = new Builder(), head = new Builder(), tail = new Builder(), arch = new Builder();
  const inside = new Builder(), chrome = new Builder(), lower = new Builder();
  const dark = col('#2a2a2d'), black = col('#18181a'), plate = col('#f1f1ee');
  let seat;

  if (p.box) {
    // the boxy off-roader: flat hood, upright windscreen, square cabin
    body.geo(extrude([[-hl, p.sill], [-hl, p.hb + 0.02], [hl - 0.06, p.hb], [hl, p.hb - 0.1], [hl, p.sill]], W - 0.02, 0.04), I);
    glass.geo(extrude([[-hl + 0.1, p.hb - 0.03], [-hl + 0.1, p.hr - 0.08], [X(0.06), p.hr - 0.08], [X(0.11), p.hb - 0.03]], W * 0.9, 0.03), I);
    body.box(-hl + 0.04, p.hr - 0.09, -W * 0.46, X(0.08), p.hr, W * 0.46);
    body.box(X(-0.12) - 0.05, p.hb - 0.02, -W * 0.46, X(-0.12) + 0.05, p.hr - 0.08, W * 0.46, undefined, { top: false });
    body.box(-hl + 0.02, p.hb - 0.02, -W * 0.46, -hl + 0.22, p.hr - 0.08, W * 0.46, undefined, { top: false });
    seat = { x: X(-0.02), y: p.hb - 0.32, wheel: 0.36, shin: -0.8 };
  } else if (!p.van) {
    body.geo(extrude([[-hl, p.sill], [-hl, p.ht - 0.1], [-hl + 0.14, p.ht], [X(p.cr0), p.hb], [X(p.cf0), p.hb],
      [hl - 0.32, p.hf], [hl - 0.05, p.hf - 0.07], [hl, p.hf - 0.2], [hl, p.sill]], W - 0.02, 0.05), I);
    glass.geo(extrude([[X(p.cr0) + 0.05, p.hb - 0.03], [X(p.cr1), p.hr], [X(p.cf1), p.hr], [X(p.cf0), p.hb - 0.03]], W * 0.86, 0.04), I);
    body.box(X(p.cr1) + 0.02, p.hr - 0.02, -W * 0.43, X(p.cf1) - 0.02, p.hr + 0.055, W * 0.43);
    const bx = (X(p.cr1) + X(p.cf1)) / 2 - 0.08;
    body.box(bx - 0.05, p.hb - 0.02, -W * 0.43 - 0.05, bx + 0.05, p.hr, W * 0.43 + 0.05, undefined, { top: false });
    if (type === 'sports') {
      for (const s of [-1, 1]) body.box(-hl + 0.12, p.ht, s * W * 0.32 - 0.03, -hl + 0.2, p.ht + 0.2, s * W * 0.32 + 0.03);
      body.box(-hl - 0.02, p.ht + 0.18, -W * 0.46, -hl + 0.34, p.ht + 0.24, W * 0.46);
    }
    // hips placed so the (slightly reclined) head sits between the B-pillar and the windscreen, under the roof
    const sy = Math.max(p.sill + 0.05, Math.min(p.hb - 0.3, p.hr - 0.86));
    seat = { x: (bx + X(p.cf1)) / 2 + 0.18, y: sy, wheel: 0.42, shin: sy - p.sill > 0.24 ? -0.6 : -0.2 };
  } else {
    body.geo(extrude([[-hl, p.sill], [-hl, p.hb], [hl - 0.75, p.hb], [hl - 0.25, p.hf], [hl - 0.03, p.hf - 0.05], [hl, p.hf - 0.2], [hl, p.sill]], W - 0.02, 0.05), I);
    body.geo(extrude([[-hl, p.hb - 0.05], [-hl, 1.98], [-hl + 0.08, 2.05], [hl - 1.2, 2.05], [hl - 1.12, 1.98], [hl - 1.12, p.hb - 0.05]], W - 0.02, 0.04), I);
    glass.geo(extrude([[hl - 1.16, p.hb - 0.04], [hl - 1.16, 1.9], [hl - 0.98, 1.92], [hl - 0.42, p.hb - 0.04]], W * 0.9, 0.03), I);
    body.box(hl - 1.16, 1.88, -W * 0.45, hl - 0.95, 1.95, W * 0.45);
    seat = { x: hl - 0.95, y: p.hb - 0.32, wheel: 0.35, shin: -0.9 };
  }
  // mirrors
  const mx = X(p.van ? 0.28 : p.box ? 0.1 : p.cf0);
  for (const s of [-1, 1]) body.box(mx - 0.12, p.hb + 0.06, s * (W / 2 + 0.02) - 0.06, mx - 0.02, p.hb + 0.15, s * (W / 2 + 0.02) + 0.06);

  // two-tone paint: the lower body in the second colour, just proud of the main body
  if (p.two) {
    lower.geo(extrude([[-hl + 0.004, p.sill + 0.004], [-hl + 0.004, p.two], [hl - 0.004, p.two], [hl - 0.004, p.sill + 0.004]], W - 0.006, 0.05), I);
  }

  // cabin seen through clear windows: dark floor, seats, dashboard and steering wheel
  const dash = col('#1d1d20'), seatC = t.lux ? col('#c9b9a0') : col('#2c2a2e');
  // (the bevelled body top sits 5 cm above hb, so the cabin floor goes just above that)
  const cab0 = p.van ? hl - 1.12 : p.box ? -hl + 0.2 : X(p.cr0) + 0.1, cab1 = p.van ? hl - 0.3 : p.box ? X(0.1) : X(p.cf0) - 0.08;
  inside.box(cab0, p.hb + 0.03, -W * 0.42, cab1, p.hb + 0.06, W * 0.42, dash);
  const dashX = seat.x + seat.wheel + 0.1;
  inside.box(dashX, p.hb + 0.03, -W * 0.42, dashX + 0.3, p.hb + 0.13, W * 0.42, dash);
  seat.zD = -W * 0.24; seat.zP = W * 0.24;
  for (const z of [seat.zD, seat.zP]) {
    inside.box(seat.x - 0.36, p.hb + 0.03, z - 0.22, seat.x - 0.24, seat.y + 0.62, z + 0.22, seatC);
    inside.box(seat.x - 0.4, seat.y + 0.62, z - 0.11, seat.x - 0.3, seat.y + 0.78, z + 0.11, seatC);
  }
  const wheelG = new THREE.TorusGeometry(0.15, 0.022, 6, 18);
  wheelG.rotateY(Math.PI / 2);
  wheelG.rotateZ(0.5);
  inside.geo(wheelG, new THREE.Matrix4().makeTranslation(seat.x + seat.wheel, p.hb + 0.2, seat.zD), col('#111113'));

  trim.box(hl - 0.1, 0.22, -W / 2 + 0.02, hl + 0.07, 0.42, W / 2 - 0.02, dark);
  trim.box(-hl - 0.07, 0.22, -W / 2 + 0.02, -hl + 0.1, 0.42, W / 2 - 0.02, dark);
  if (!t.lux) trim.box(hl + 0.03, p.hf - 0.42, -W * 0.24, hl + 0.065, p.hf - 0.24, W * 0.24, black);
  trim.box(hl + 0.07, 0.25, -0.21, hl + 0.085, 0.37, 0.21, plate);
  trim.box(-hl - 0.085, 0.25, -0.21, -hl - 0.07, 0.37, 0.21, plate);
  trim.box(-hl + 0.35, p.sill - 0.03, -W / 2 - 0.012, hl - 0.35, p.sill + 0.06, W / 2 + 0.012, black, { top: false });
  if (type === 'police') {
    // push bar on the nose and the light bar's base
    trim.box(hl + 0.05, 0.3, -W * 0.3, hl + 0.16, 0.62, W * 0.3, black);
    const rx = (X(p.cr1) + X(p.cf1)) / 2;
    trim.box(rx - 0.11, p.hr + 0.05, -W * 0.37, rx + 0.11, p.hr + 0.1, W * 0.37, black);
  }
  if (t.lux) luxDetails(type, p, { body, trim, chrome, head, tail, lower, L, W, hl, X, black, dark });
  else {
    for (const s of [-1, 1]) {
      // the bevelled body bulges 5 cm past its outline, so lights sit just outside it
      head.box(hl + 0.01, p.hf - 0.21, s > 0 ? W / 2 - 0.4 : -W / 2 + 0.12, hl + 0.075, p.hf - 0.08, s > 0 ? W / 2 - 0.12 : -W / 2 + 0.4);
      tail.box(-hl - 0.075, p.ht - 0.25, s > 0 ? W / 2 - 0.38 : -W / 2 + 0.1, -hl - 0.01, p.ht - 0.1, s > 0 ? W / 2 - 0.1 : -W / 2 + 0.38);
    }
  }
  const archG = new THREE.CylinderGeometry(p.R + 0.07, p.R + 0.07, W + 0.03, 16, 1, false, Math.PI / 2, Math.PI);
  archG.rotateX(Math.PI / 2);
  for (const wx of [X(p.wx), -X(p.wx)]) arch.geo(archG, new THREE.Matrix4().makeTranslation(wx, p.R, 0));

  let lights = null;
  if (type === 'police') {
    const rx = (X(p.cr1) + X(p.cf1)) / 2;
    const red = new Builder(), blue = new Builder();
    red.box(rx - 0.09, p.hr + 0.1, -W * 0.35, rx + 0.09, p.hr + 0.2, -0.03);
    blue.box(rx - 0.09, p.hr + 0.1, 0.03, rx + 0.09, p.hr + 0.2, W * 0.35);
    lights = { red: red.build(), blue: blue.build(), y: p.hr + 0.3, x: rx };
  }

  return (procCache[type] = {
    L, W, R: p.R, wx: X(p.wx), hf: p.hf, hr: p.hr || 1.95, hb: p.hb, sill: p.sill, van: !!p.van, seat, lights, tw: p.tw || 0.24,
    body: body.build(), glass: glass.build(), trim: trim.build(), head: head.build(), tail: tail.build(), arch: arch.build(),
    wheel: wheelGeo(p), chromeWheel: p.wheel === 'chrome', inside: inside.build(),
    chrome: chrome.empty ? null : chrome.build(), lower: lower.empty ? null : lower.build(),
  });
}

// rims: classic steel, chrome monoblock, or multi-spoke (silver on graphite, or all black)
function wheelGeo(p) {
  const wheel = new Builder(), I = new THREE.Matrix4(), R = p.R, tw = p.tw || 0.24;
  const tire = new THREE.CylinderGeometry(R, R, tw, 20); tire.rotateX(Math.PI / 2);
  wheel.geo(tire, I, col(p.wheel === 'chrome' ? '#0e0e0f' : '#1c1c1e'));
  const disc = (r, c, w = tw + 0.012, seg = 20) => { const g = new THREE.CylinderGeometry(r, r, w, seg); g.rotateX(Math.PI / 2); wheel.geo(g, I, col(c)); };
  if (!p.wheel || p.wheel === 'classic') {
    disc(R * 0.58, '#c3c7cc', 0.25, 10);
    disc(R * 0.2, '#4a4d52', 0.26, 8);
  } else if (p.wheel === 'chrome') {
    disc(R * 0.74, '#eef0f3', tw + 0.012, 24);
    const dot = new THREE.CylinderGeometry(R * 0.075, R * 0.075, tw + 0.024, 8); dot.rotateX(Math.PI / 2);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      wheel.geo(dot, new THREE.Matrix4().makeTranslation(Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5, 0), col('#2a2b2e'));
    }
    disc(R * 0.16, '#1b1b1d', tw + 0.03, 12);
  } else {
    const rim = p.wheel === 'black' ? '#141416' : '#2c2e33', spoke = p.wheel === 'black' ? '#3d4046' : '#cfd2d7';
    disc(R * 0.72, rim, tw + 0.012, 22);
    const sp = new THREE.BoxGeometry(R * 0.62, R * 0.11, 0.02);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + (i % 2) * 0.12;
      for (const z of [-1, 1]) {
        const m = new THREE.Matrix4().makeRotationZ(a).setPosition(Math.cos(a) * R * 0.37, Math.sin(a) * R * 0.37, z * (tw / 2 + 0.012));
        wheel.geo(sp, m, col(spoke));
      }
    }
    disc(R * 0.14, '#9a9da3', tw + 0.04, 10);
  }
  return wheel.build();
}

// the bits that make each luxury car recognisable: grilles, lamps, intakes, spoilers
function luxDetails(type, p, { body, trim, chrome, head, tail, lower, W, hl, X, black, dark }) {
  const sides = [-1, 1];
  const cyl = (r, len, axis = 'x', seg = 14) => {
    const g = new THREE.CylinderGeometry(r, r, len, seg);
    if (axis === 'x') g.rotateZ(Math.PI / 2); else if (axis === 'z') g.rotateX(Math.PI / 2);
    return g;
  };
  const at = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
  const beltChrome = () => { for (const s of sides) chrome.box(X(p.cr0) + 0.1, p.hb - 0.035, s > 0 ? W / 2 - 0.012 : -W / 2 - 0.004, X(p.cf0) - 0.05, p.hb - 0.005, s > 0 ? W / 2 + 0.004 : -W / 2 + 0.012); };
  const diffuser = () => trim.box(-hl - 0.09, p.sill - 0.04, -W * 0.38, -hl + 0.3, p.sill + 0.1, W * 0.38, black);
  const barTail = (y0, y1, inset = 0.14) => tail.box(-hl - 0.075, y0, -W / 2 + inset, -hl - 0.01, y1, W / 2 - inset);

  if (type === 'ursa') {
    for (const s of sides) {
      trim.box(-hl + 0.25, p.sill - 0.04, s > 0 ? W / 2 - 0.02 : -W / 2 - 0.014, hl - 0.25, p.sill + 0.16, s > 0 ? W / 2 + 0.014 : -W / 2 + 0.02, black);
      // Y-shaped daytime lights
      head.box(hl - 0.02, p.hf - 0.16, s * (W / 2 - 0.45) - 0.18, hl + 0.06, p.hf - 0.1, s * (W / 2 - 0.45) + 0.18);
      head.box(hl - 0.02, p.hf - 0.3, s * (W / 2 - 0.3) - 0.04, hl + 0.06, p.hf - 0.16, s * (W / 2 - 0.3) + 0.04);
      trim.box(hl - 0.02, 0.3, s * (W / 2 - 0.28) - 0.17, hl + 0.075, p.hf - 0.36, s * (W / 2 - 0.28) + 0.17, black);
      for (const z of [0.42, 0.56]) chrome.geo(cyl(0.05, 0.14), at(-hl - 0.04, 0.4, s * z));
    }
    trim.box(hl, 0.32, -W * 0.22, hl + 0.08, p.hf - 0.3, W * 0.22, black);
    barTail(p.ht - 0.24, p.ht - 0.17);
    body.box(X(p.cr0) - 0.05, p.ht - 0.02, -W * 0.4, X(p.cr0) + 0.35, p.ht + 0.05, W * 0.4);
    diffuser();
  } else if (type === 'gwagen') {
    const f = hl, hb = p.hb;
    trim.box(f - 0.01, hb - 0.44, -W * 0.27, f + 0.05, hb - 0.08, W * 0.27, black);
    for (const y of [hb - 0.34, hb - 0.26, hb - 0.18]) chrome.box(f + 0.045, y, -W * 0.26, f + 0.07, y + 0.026, W * 0.26);
    trim.box(f - 0.02, p.sill - 0.04, -W / 2, f + 0.13, p.sill + 0.22, W / 2, black);
    trim.box(-hl - 0.12, p.sill - 0.04, -W / 2, -hl + 0.02, p.sill + 0.2, W / 2, black);
    for (const s of sides) {
      head.geo(cyl(0.12, 0.06), at(f + 0.035, hb - 0.27, s * (W / 2 - 0.3)));
      chrome.geo(cyl(0.14, 0.04), at(f + 0.012, hb - 0.27, s * (W / 2 - 0.3)));
      trim.box(f - 0.3, hb + 0.0, s * (W / 2 - 0.16) - 0.05, f - 0.18, hb + 0.06, s * (W / 2 - 0.16) + 0.05, col('#e3943a'));
      tail.box(-hl - 0.07, hb - 0.55, s > 0 ? W / 2 - 0.2 : -W / 2 + 0.06, -hl - 0.01, hb - 0.12, s > 0 ? W / 2 - 0.06 : -W / 2 + 0.2);
      // running boards and wheel-arch flares
      trim.box(-X(p.wx) + p.R + 0.12, p.sill - 0.14, s > 0 ? W / 2 - 0.05 : -W / 2 - 0.13, X(p.wx) - p.R - 0.12, p.sill - 0.08, s > 0 ? W / 2 + 0.13 : -W / 2 + 0.05, black);
      for (const wx of [X(p.wx), -X(p.wx)]) trim.box(wx - p.R - 0.12, 2 * p.R - 0.02, s > 0 ? W / 2 - 0.04 : -W / 2 - 0.08, wx + p.R + 0.12, 2 * p.R + 0.1, s > 0 ? W / 2 + 0.08 : -W / 2 + 0.04, black);
    }
    // the spare wheel on the tailgate
    trim.geo(cyl(p.R * 0.95, 0.26), at(-hl - 0.15, hb - 0.32, 0), black);
    trim.geo(cyl(p.R * 0.7, 0.28), at(-hl - 0.15, hb - 0.32, 0), dark);
  } else if (type === 'monarch' || type === 'phantasma') {
    const ph = type === 'phantasma';
    const gw = ph ? 0.36 : 0.33, g0 = ph ? p.hf - 0.66 : p.hf - 0.44, g1 = p.hf - (ph ? 0.06 : 0.1);
    trim.box(hl - 0.03, g0, -gw, hl + (ph ? 0.1 : 0.06), g1, gw, col('#111114'));
    for (let z = -gw + 0.04; z <= gw - 0.03; z += 0.055) chrome.box(hl + (ph ? 0.09 : 0.05), g0 + 0.03, z - 0.009, hl + (ph ? 0.115 : 0.075), g1 - 0.03, z + 0.009);
    chrome.box(hl - 0.03, g1, -gw - 0.03, hl + (ph ? 0.12 : 0.08), g1 + 0.04, gw + 0.03);
    chrome.box(hl - 0.03, g0 - 0.03, -gw - 0.03, hl + (ph ? 0.12 : 0.08), g0, gw + 0.03);
    for (const s of sides) chrome.box(hl - 0.03, g0, s * gw - 0.03, hl + (ph ? 0.12 : 0.08), g1, s * gw + 0.03);
    // the little figure on top of the grille
    chrome.box(hl - 0.02, g1 + 0.04, -0.02, hl + 0.04, g1 + 0.15, 0.02);
    beltChrome();
    if (p.two) for (const s of sides) chrome.box(-hl + 0.1, p.two - 0.012, s > 0 ? W / 2 - 0.004 : -W / 2 - 0.012, hl - 0.1, p.two + 0.012, s > 0 ? W / 2 + 0.012 : -W / 2 + 0.004);
    for (const s of sides) {
      head.box(hl - 0.01, p.hf - 0.22, s > 0 ? gw + 0.06 : -W / 2 + 0.12, hl + 0.07, p.hf - 0.12, s > 0 ? W / 2 - 0.12 : -gw - 0.06);
      tail.box(-hl - 0.075, p.ht - 0.34, s > 0 ? W / 2 - 0.26 : -W / 2 + 0.1, -hl - 0.01, p.ht - 0.1, s > 0 ? W / 2 - 0.1 : -W / 2 + 0.26);
      chrome.geo(cyl(0.045, 0.1), at(-hl - 0.03, 0.36, s * 0.5));
    }
  } else if (type === 'cavallo') {
    trim.box(hl - 0.02, 0.28, -W * 0.33, hl + 0.07, 0.44, W * 0.33, black);
    for (const s of sides) {
      head.box(hl - 0.04, p.hf - 0.13, s > 0 ? W / 2 - 0.5 : -W / 2 + 0.1, hl + 0.05, p.hf - 0.06, s > 0 ? W / 2 - 0.1 : -W / 2 + 0.5);
      trim.box(X(0.22) - 0.24, p.hb - 0.36, s > 0 ? W / 2 - 0.012 : -W / 2 - 0.006, X(0.22), p.hb - 0.14, s > 0 ? W / 2 + 0.006 : -W / 2 + 0.012, black);
      // four round tail lights
      for (const z of [0.4, 0.68]) tail.geo(cyl(0.075, 0.07), at(-hl - 0.035, p.ht - 0.2, s * z));
      for (const z of [0.18, 0.3]) chrome.geo(cyl(0.045, 0.12), at(-hl - 0.05, p.sill + 0.06, s * z));
    }
    body.box(-hl - 0.02, p.ht + 0.0, -W * 0.44, -hl + 0.26, p.ht + 0.05, W * 0.44);
    diffuser();
  } else if (type === 'papaya') {
    trim.box(hl - 0.03, 0.24, -W * 0.36, hl + 0.06, 0.36, W * 0.36, black);
    for (const s of sides) {
      head.box(hl - 0.08, p.hf - 0.12, s > 0 ? W / 2 - 0.42 : -W / 2 + 0.1, hl + 0.03, p.hf - 0.06, s > 0 ? W / 2 - 0.1 : -W / 2 + 0.42);
      trim.box(X(-0.24), p.sill + 0.08, s > 0 ? W / 2 - 0.012 : -W / 2 - 0.01, X(-0.09), p.hb - 0.1, s > 0 ? W / 2 + 0.01 : -W / 2 + 0.012, black);
      trim.box(-hl + 0.14, p.ht + 0.02, s * W * 0.33 - 0.03, -hl + 0.22, p.ht + 0.16, s * W * 0.33 + 0.03, black);
    }
    body.box(-hl - 0.04, p.ht + 0.15, -W * 0.46, -hl + 0.36, p.ht + 0.2, W * 0.46);
    barTail(p.ht - 0.16, p.ht - 0.1, 0.2);
    diffuser();
  } else if (type === 'bolide') {
    // horseshoe grille, the C-shaped side line in the second colour, a spine down the roof
    trim.box(hl - 0.02, 0.34, -0.17, hl + 0.06, p.hf - 0.1, 0.17, col('#101012'));
    chrome.box(hl - 0.02, 0.3, -0.21, hl + 0.075, 0.35, 0.21);
    for (const s of sides) {
      chrome.box(hl - 0.02, 0.33, s * 0.19 - 0.025, hl + 0.075, p.hf - 0.12, s * 0.19 + 0.025);
      lower.box(X(-0.08), p.sill + 0.06, s > 0 ? W / 2 - 0.004 : -W / 2 - 0.012, X(0.04), p.hb - 0.04, s > 0 ? W / 2 + 0.012 : -W / 2 + 0.004);
      chrome.box(X(0.04), p.sill + 0.06, s > 0 ? W / 2 + 0.004 : -W / 2 - 0.016, X(0.04) + 0.03, p.hb - 0.04, s > 0 ? W / 2 + 0.016 : -W / 2 - 0.004);
      for (const k of [0, 1]) head.box(hl - 0.04, p.hf - 0.15 - k * 0.07, s > 0 ? W / 2 - 0.42 : -W / 2 + 0.12, hl + 0.05, p.hf - 0.11 - k * 0.07, s > 0 ? W / 2 - 0.12 : -W / 2 + 0.42);
    }
    body.box(X(p.cr0), p.hr - 0.02, -0.025, X(p.cf1) - 0.05, p.hr + 0.06, 0.025);
    body.box(-hl - 0.02, p.ht + 0.03, -W * 0.42, -hl + 0.32, p.ht + 0.08, W * 0.42);
    barTail(p.ht - 0.2, p.ht - 0.13, 0.12);
    diffuser();
  }
}

function m(geo, mat, shadow = true) {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = shadow;
  mesh.receiveShadow = shadow;
  return mesh;
}

export function makeCarView(type, color) {
  const g = typeGeo(type);
  const group = new THREE.Group();
  const chassis = new THREE.Group();
  group.add(chassis);
  const bodyMesh = m(g.body, paint(color)), glassMesh = m(g.glass, GLASS);
  chassis.add(bodyMesh, glassMesh, m(g.trim, TRIM));
  if (g.arch) chassis.add(m(g.arch, ARCH, false));
  if (g.chrome) chassis.add(m(g.chrome, CHROME));
  const lowerMesh = g.lower ? m(g.lower, paint(CAR_TYPES[type].color2 || '#101012')) : null;
  if (lowerMesh) chassis.add(lowerMesh);
  const inside = m(g.inside, TRIM, false);
  inside.visible = false;
  chassis.add(inside);
  const head = m(g.head, HEAD_OFF, false), tail = m(g.tail, TAIL_OFF, false);
  chassis.add(head, tail);
  if (type === 'taxi' && !g.model) {
    if (!taxiMat) { const tx = TX.textSign('TAXI', { bg: '#1b1512', fg: '#f2c230', w: 256, h: 96, size: 64 }); taxiMat = new THREE.MeshLambertMaterial({ map: tx, emissiveMap: tx, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.2 }); }
    const sign = m(taxiSignGeo(), taxiMat);
    sign.position.set(-0.05 * g.L, g.hr + 0.15, 0);
    chassis.add(sign);
  }
  if (type === 'van') {
    if (!vanMat) vanMat = new THREE.MeshLambertMaterial({ map: TX.textSign('KIMCHI EXPRESS', { bg: '#d6402b', fg: '#ffffff', sub: '김치 배달 · fast & spicy', w: 512, h: 128, size: 60 }), transparent: false });
    for (const s of [-1, 1]) {
      const logo = new THREE.Mesh(vanLogoGeo(), vanMat);
      logo.position.set(-0.55, 1.5, s * (g.W / 2 + 0.035));
      logo.rotation.y = s > 0 ? 0 : Math.PI;
      chassis.add(logo);
    }
  }
  if (type === 'police' && !g.model) {
    if (!copMat) copMat = new THREE.MeshLambertMaterial({ map: TX.textSign('경찰 POLICE', { bg: '#1f4f8a', fg: '#ffffff', w: 512, h: 96, size: 58 }) });
    for (const s of [-1, 1]) {
      const logo = new THREE.Mesh(copLogoGeo(), copMat);
      logo.position.set(-0.05, 0.6, s * (g.W / 2 + 0.03));
      logo.rotation.y = s > 0 ? 0 : Math.PI;
      chassis.add(logo);
    }
  }
  if (type === 'police' && g.lights) chassis.add(m(g.lights.red, COP_RED, false), m(g.lights.blue, COP_BLUE, false));
  const wheels = [], front = [], spots = new Float64Array(8);
  for (const [wx, y, z] of wheelSpots(g)) {
    const w = m(g.wheel, g.chromeWheel ? WHEEL_CHROME : WHEEL);
    w.position.set(wx, y, z);
    group.add(w);
    spots[wheels.length * 2] = wx; spots[wheels.length * 2 + 1] = z;
    wheels.push(w);
    if (wx > 0) front.push(w);
  }
  // on a hill the whole car (wheels too) pitches and rolls with the ground under it, after its heading (seat)
  group.rotation.order = 'YZX';
  const pool = new THREE.Mesh(poolGeo(), POOL);
  pool.rotation.set(-Math.PI / 2, 0, -Math.PI / 2);
  pool.position.set(g.L / 2 + POOL_X, POOL_UP, 0);
  pool.visible = false;   // (syncCar shows it for running cars at night)
  group.add(pool);
  // what casts a shadow while the car is near and inside the sun's shadow box (setCarLOD switches these)
  const casters = [];
  group.traverse((o) => { if (o.castShadow) casters.push(o); });
  return { group, chassis, wheels, front, head, tail, pool, bodyMesh, glassMesh, lowerMesh, inside, seat: g.seat, lights: g.lights, hb: g.hb, W: g.W,
    R: g.R, L: g.L, spin: 0, steer: 0, roll: 0, pitch: 0, vf: 0, px: 0, pz: 0, pa: 0, y: 0, init: false, look: color, clear: false,
    type, geo: g, casters, cast: true, lod: false, far: null, farLook: null, spots, ...rideState() };
}

// What syncCar keeps about how a view rides the ground (seat), its airtime and a skid (skid): wh holds each
// wheel's [ground height followed, ground height last sampled, x, z (m), suspension travel, the ground's rise
// under it along the car]; free is true
// while the sim has the car off the ground (in the air, or over a lip just before).
function rideState() {
  return { wh: new Float64Array(24), ox: 0, oz: 0, oa: 0, o0x: 0, o0z: 0, o0a: 0, skidT: 0, skidM: 0, sp: 0, sit: 0, tp: 0, tr: 0, off: 0, free: false, squashed: false };
}

// where the four wheels sit: front pair at +wx, rear pair at -wxb, either side of the track
function wheelSpots(g) {
  const wxb = g.wxb ?? g.wx, track = g.track ?? (g.W / 2 - g.tw / 2 + 0.02);
  return [[g.wx, g.R, track], [g.wx, g.R, -track], [-wxb, g.R, track], [-wxb, g.R, -track]];
}

// paint, wreck and window state; call every frame for visible cars
export function setCarLook(v, c, clear) {
  const look = c.wreck ? 'wreck' : c.color + (c.color2 || '');
  if (v.look !== look) {
    v.look = look;
    v.bodyMesh.material = c.wreck ? WRECK : paint(c.color);
    if (v.lowerMesh) v.lowerMesh.material = c.wreck ? WRECK : paint(c.color2 || '#101012');
    v.sit = c.wreck ? -0.12 : 0;
    v.chassis.position.y = v.sit;
    v.chassis.rotation.y = c.wreck ? (Math.random() - 0.5) * 0.04 : 0;
    v.clear = null;
  }
  if (v.clear !== clear) {
    v.clear = clear;
    v.glassMesh.material = c.wreck ? WRECK_GLASS : clear ? GLASS_CLEAR : GLASS;
    v.inside.visible = clear && !c.wreck;
  }
}

// Copy a simulated car onto its model; `steer` is the player's input (-1..1) or null for AI; `running` turns
// the lights on (traffic and the car Kimchi drives, not parked ones). `ground` is either one height (m) under
// the car, which it eases onto level (the grid, as it always has), or a function (x, y) of a point in sim px
// giving the height of the surface drawn there (v2's surfaceY): then the car sits on the ground under its four
// wheels, pitched and rolled with it, and flies at the sim's c.gy through its airtime (seat, below).
export function syncCar(v, c, dt, ground, steer = null, running = false) {
  v.head.material = running ? HEAD : HEAD_OFF;
  // the headlight pool on the road is see-through by day, so it is only drawn once there is light to see
  v.pool.visible = running && POOL.opacity > 0.004;
  if (v.far) v.far.material = FAR_MATS[running ? 1 : 0][c.brake ? 1 : 0];
  const x = c.x * S, z = c.y * S;
  const fx = Math.cos(c.a), fz = Math.sin(c.a);
  let vf = 0, av = 0, fresh = !v.init;
  if (v.init && dt > 0) {
    // what the car drove this frame; a jump no car could drive is drawn as a short skid instead (skid)
    if (skid(v, c, x, z, dt)) {
      vf = (SK.x * fx + SK.z * fz) / dt;
      av = SK.a / dt;
    } else fresh = true;
  }
  v.px = x; v.pz = z; v.pa = c.a; v.init = true;
  const gx = x + v.ox, gz = z + v.oz, a = c.a + v.oa;
  if (typeof ground === 'function') seat(v, c, gx, gz, a, dt, ground, fresh);
  else {
    if (fresh || !(dt > 0)) v.y = ground;
    v.y += (ground - v.y) * Math.min(1, dt * 10);
    v.group.position.set(gx, v.y, gz);
    v.group.rotation.y = -a;
  }

  v.spin += vf * dt / v.R;
  const sv = steer != null ? -steer * 0.42 : -Math.max(-1, Math.min(1, av * 0.7)) * 0.42;
  v.steer += (sv - v.steer) * Math.min(1, dt * 10);
  for (const w of v.wheels) w.rotation.z = -v.spin;
  for (const w of v.front) w.rotation.y = v.steer;

  const acc = (vf - v.vf) / Math.max(dt, 1e-3);
  v.vf += (vf - v.vf) * Math.min(1, dt * 8);
  const rollT = Math.max(-0.075, Math.min(0.075, -av * v.vf * 0.012));
  const pitchT = Math.max(-0.045, Math.min(0.045, acc * 0.0025));
  v.roll += (rollT - v.roll) * Math.min(1, dt * 6);
  v.pitch += (pitchT - v.pitch) * Math.min(1, dt * 5);
  v.chassis.rotation.x = v.roll;
  v.chassis.rotation.z = v.pitch;
  // a landing squashes the springs: the body sinks over its wheels and comes back up (c.squash eases in the sim)
  if (c.squash > 0 || v.squashed) {
    v.chassis.position.y = v.sit - (c.squash || 0) * SQUASH;
    v.squashed = c.squash > 0;
  }
  v.tail.material = c.brake ? TAIL_ON : TAIL_OFF;
  return vf;
}

// ---------- riding the ground: hills, kerbs, airtime and skids (spec §10, §11) ----------

const SUSP = 0.12;        // m: how far a wheel's suspension lets it rise or drop to meet its own patch of ground
const TYRE = 0.4;         // m either side of a wheel where the ground's slope under it is taken
const DROOP = 0.1;        // m: how far the wheels hang below their rest in the air
const SQUASH = 0.14;      // m: how far the body sinks at a full landing squash (c.squash 1)
const GRADE_MAX = 1;      // ground under a wheel that changes by up to this per metre it rolls is followed at once ...
const STEP_K = 6;         // ... and what is left of a step (a kerb) eases in at this rate (1/s)
const FREE = 0.005;       // m: the sim's body (c.gy) this far over the ground under it has left the ground ...
const OFF_K = 3;          // ... and the difference between it and the plane under the wheels fades at this rate (1/s)
const TILT_W = 2.5;       // rad/s: the body pitches and rolls with the ground no faster than this ...
const SLACK = 0.07;       // ... nor lags it by more than this at its furthest wheel (m)
const AIR_K = 2.5;        // 1/s: in the air the body eases toward pitching with its flight path ...
const AIR_PITCH = 0.35;   // rad: ... at most this far
const LAND_H = 1.2;       // m: within this height of the ground it settles toward the ground's pitch ...
const LAND_K = 10;        // ... this much faster (1/s)
const HANG_K = 8;         // 1/s: how fast the wheels drop to hang in the air
// A jump of the sim's pose that no car could drive in a frame (police.js wriggle sets a stuck car down up to
// 1.5 m away, turned by up to 1 rad; a shove out of a wall) is drawn as a short skid there instead, easing in
// and out over SKID_T. A jump past SNAP_FAR is a move (a script, a teleport) and is shown at once. A car turns
// at most TURN_STILL standing (a knock) plus TURN_PER for each m/s, and never past TURN_MAX (steering on the
// handbrake, a knock and a wall together).
const SKID_T = 0.35;      // s
const SNAP_FAR = 4;       // m
const TURN_STILL = 1.5, TURN_PER = 0.6, TURN_MAX = 8;   // rad/s, rad/s per m/s, rad/s
const POOL_X = 7.2;       // m past the nose: the middle of the headlight pool ...
const POOL_UP = 0.06;     // ... this far over the road
const POOL_HALF = 6;      // m either side of its middle where the pool takes the road's rise
const SK = { x: 0, z: 0, a: 0 };
const POOL_Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, -Math.PI / 2));
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const clampAbs = (x, m) => (x > m ? m : x < -m ? -m : x);
const angle = (a) => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));

// This frame's change of the sim pose as the car drove it, written into SK (m, m, rad). What its speed (now
// or last frame) could not have moved or turned it is a jump: that part goes into the view's skid offset
// (v.ox, v.oz, v.oa; drawn = sim + offset), so the drawn car stays put and then slides after the sim, easing
// in and out over SKID_T. Returns false for a move past SNAP_FAR, which is shown at once (no offset).
function skid(v, c, x, z, dt) {
  let dx = x - v.px, dz = z - v.pz, da = angle(c.a - v.pa);
  const move = Math.hypot(dx, dz), now = Math.hypot(c.vx || 0, c.vy || 0) * S, sp = Math.max(now, v.sp);
  const reach = sp * dt * 1.25 + 0.03, turn = Math.min(TURN_MAX, TURN_STILL + TURN_PER * sp) * dt + 0.005;
  v.sp = now;
  if (move > SNAP_FAR) { v.ox = v.oz = v.oa = v.skidM = 0; return false; }
  let jumped = false;
  if (move > reach) {
    const k = 1 - reach / move;
    v.ox -= dx * k; v.oz -= dz * k;
    dx -= dx * k; dz -= dz * k;
    jumped = true;
  }
  if (Math.abs(da) > turn) {
    const jump = da - clampAbs(da, turn);
    v.oa -= jump; da -= jump;
    jumped = true;
  }
  if (jumped) { v.o0x = v.ox; v.o0z = v.oz; v.o0a = v.oa; v.skidT = 0; }
  if (v.ox || v.oz || v.oa) {
    v.skidT += dt;
    const t = Math.min(1, v.skidT / SKID_T), f = 1 - t * t * (3 - 2 * t);
    v.ox = v.o0x * f; v.oz = v.o0z * f; v.oa = v.o0a * f;
    v.skidM = f > 0 ? Math.hypot(v.ox, v.oz) + Math.abs(v.oa) * v.L / 2 : 0;   // how far the drawn car is from the sim's (m)
  }
  SK.x = dx; SK.z = dz; SK.a = da;
  return true;
}

// The car on the ground (ground(x, y) of a point in sim px: the surface drawn there). Each wheel's patch of
// ground is followed at once where it runs on smoothly (a slope, a crest) and eased where it steps (a kerb).
// The body stands on the plane through the four, pitching and rolling with it (no faster than a body would,
// TILT_W), and each wheel's suspension reaches for its own ground from there. A car the sim moves in height
// (c.gy: Kimchi's, the police, mission drivers) flies at c.gy once the sim has it off the ground: through its
// airtime (c.air, spec §10) and over a lip just before, easing toward pitching with its flight path while the
// wheels hang; they meet the ground as it comes down, and c.squash sinks the body on landing (syncCar).
function seat(v, c, gx, gz, a, dt, ground, fresh) {
  const ca = Math.cos(a), sa = Math.sin(a), W = v.wh, P = v.spots, k = Math.min(1, dt * STEP_K);
  for (let i = 0; i < 4; i++) {
    const lx = P[i * 2], lz = P[i * 2 + 1], o = i * 6;
    const wx = gx + lx * ca - lz * sa, wz = gz + lx * sa + lz * ca, raw = ground(wx / S, wz / S);
    if (fresh) { W[o] = raw; W[o + 4] = 0; } else {
      W[o] += clampAbs(raw - W[o + 1], GRADE_MAX * Math.hypot(wx - W[o + 2], wz - W[o + 3]) + 0.01);
      W[o] += (raw - W[o]) * k;
    }
    W[o + 1] = raw; W[o + 2] = wx; W[o + 3] = wz;
    // the ground's rise under the wheel along the car (a kerb's step counts as steep)
    W[o + 5] = clampAbs((ground((wx + ca * TYRE) / S, (wz + sa * TYRE) / S) - ground((wx - ca * TYRE) / S, (wz - sa * TYRE) / S)) / (2 * TYRE), 1);
  }
  // the plane through the four wheels (front pair at P[0], rear at P[4], the right side at +P[1]): its rise
  // forward b and to the right r per metre, and its height y0 under the car's middle
  const b = ((W[0] + W[6]) - (W[12] + W[18])) / 2 / (P[0] - P[4]);
  const r = ((W[0] + W[12]) - (W[6] + W[18])) / 4 / P[1];
  const y0 = (W[12] + W[18]) / 2 - b * P[4];
  // The sim's body (c.gy) over the ground at its middle: it is leaving the ground (a lip, a crest taken fast)
  // or in the air. While it touches, the body stands on the plane and v.off keeps the plane against c.gy;
  // once free it flies at c.gy with that offset fading, never below the plane.
  const sim = Number.isFinite(c.gy), free = sim && (c.air > 0 || c.gy - ground(c.x, c.y) > FREE);
  let y = y0;
  if (!free) v.off = sim ? y0 - c.gy : 0;
  else {
    if (!fresh) v.off *= Math.exp(-dt * OFF_K); else v.off = 0;
    y = Math.max(y0, c.gy + v.off);
  }
  const pp = Math.atan(b), pr = -Math.atan(r);
  if (fresh) { v.tp = pp; v.tr = pr; } else if (free) {
    // in the air toward its flight path's pitch, and level; coming down within LAND_H of the ground, toward
    // the ground's pitch and roll there, so it touches down on all four
    const near = Math.max(0, 1 - (y - y0) / LAND_H), kk = Math.min(1, dt * (AIR_K + near * LAND_K));
    const flight = clampAbs(Math.atan2(c.vh || 0, Math.hypot(c.vx, c.vy) * S) * 0.6, AIR_PITCH);
    v.tp += (flight + (pp - flight) * near - v.tp) * kk;
    v.tr += (pr * near - v.tr) * kk;
  } else {
    // with the ground, but no faster than TILT_W, and never so far off it that a wheel cannot reach
    const w = TILT_W * dt;
    v.tp = pp + clampAbs(v.tp + clampAbs(pp - v.tp, w) - pp, Math.atan(SLACK / Math.max(P[0], -P[4])));
    v.tr = pr + clampAbs(v.tr + clampAbs(pr - v.tr, w) - pr, Math.atan(SLACK / P[1]));
  }
  // each wheel down (or up) to its own ground from the body as drawn, as far as its spring reaches, and where
  // the ground under it slopes against the body (a ramp's lip, a crest between the axles) lifted so the tyre
  // stands on the slope rather than cutting into it; in the air it hangs until the ground comes up to meet it
  const tb = Math.tan(v.tp), tr = -Math.tan(v.tr), hang = Math.min(1, dt * HANG_K);
  for (let i = 0; i < 4; i++) {
    const o = i * 6, d = W[o + 5] - tb;
    const reach = W[o] + v.R * (Math.sqrt(1 + d * d) - 1) - (y + tb * P[i * 2] + tr * P[i * 2 + 1]);
    if (!free) W[o + 4] = clampAbs(reach, SUSP);
    else {
      W[o + 4] += (-DROOP - W[o + 4]) * hang;
      if (reach > W[o + 4]) W[o + 4] = Math.min(reach, SUSP);
    }
  }
  v.y = y; v.free = free;
  v.group.position.set(gx, y, gz);
  v.group.rotation.set(v.tr, -a, v.tp);
  for (let i = 0; i < 4; i++) v.wheels[i].position.y = v.R + W[i * 6 + 4];
  if (v.pool.visible) fitPool(v, gx, gz, ca, sa, ground);
}

// The headlight pool lies on the road ahead, which need not be the plane the car stands on (at the foot of a
// hill, over a crest): its middle on the ground there, and tilted to the ground's rise between its ends.
function fitPool(v, gx, gz, ca, sa, ground) {
  const x0 = v.L / 2 + POOL_X, at = (d) => ground((gx + ca * d) / S, (gz + sa * d) / S);
  const mid = at(x0), rise = (at(x0 + POOL_HALF) - at(x0 - POOL_HALF)) / (2 * POOL_HALF);
  const cp = Math.cos(v.tp), sp = Math.sin(v.tp);
  v.pool.position.y = (mid + POOL_UP - v.y - x0 * sp) / cp;
  v.pool.quaternion.setFromAxisAngle(Z_AXIS, Math.atan(rise) - v.tp).multiply(POOL_Q);
}

// How far each wheel of v floats over (+) or sinks into (-) the ground, in m square to the ground's slope under
// it, from the model as drawn: ground(x, y) of a point in sim px. Writes the four into out and returns the one
// furthest from 0 (main3d's KC3.metrics and tools/s6b_test.mjs measure the cars with it).
const WP = new THREE.Vector3();
export function wheelGap(v, ground, out = [0, 0, 0, 0]) {
  let worst = 0;
  v.group.updateMatrixWorld(true);
  for (let i = 0; i < 4; i++) {
    v.wheels[i].getWorldPosition(WP);
    const g = ground(WP.x / S, WP.z / S), e = 0.5;
    const sx = (ground((WP.x + e) / S, WP.z / S) - ground((WP.x - e) / S, WP.z / S)) / (2 * e);
    const sz = (ground(WP.x / S, (WP.z + e) / S) - ground(WP.x / S, (WP.z - e) / S)) / (2 * e);
    out[i] = (WP.y - g) / Math.hypot(1, sx, sz) - v.R;
    if (Math.abs(out[i]) > Math.abs(worst)) worst = out[i];
  }
  return worst;
}

// ---------- level of detail, shadows and view pools (spec §11.1) ----------

export const CAR_NEAR = 70;     // m from the camera: the full car inside, the far LOD (one merged mesh) beyond
export const CAR_FAR = 220;     // m: how far out the v2 map draws cars at all (the grid keeps its 170 m square)
export const CAR_HYST = 3;      // m either side of CAR_NEAR (and past CAR_FAR), so a car along an edge doesn't flicker
export const PERSON_CAST = 40;  // m: people cast a shadow only this close to the camera
export const PERSON_FAR = 110;  // m: and are drawn only this close
const PERSON_HYST = 2;          // m inside each edge before a hidden or shadowless person switches back
export const POOL_MAX = 40;     // views at most waiting in each pool

// should a car view d m from the camera be its far LOD (hysteresis around the view's current state)
export function carFar(v, d) { return v.lod ? d > CAR_NEAR - CAR_HYST : d > CAR_NEAR + CAR_HYST; }

// Show v as the full car or as its far LOD, and let the full car cast shadows or not (cast: it is inside the
// sun's shadow box). The far LOD never casts. Cheap every frame: it only touches what changed.
export function setCarLOD(v, far, cast) {
  if (far) {
    if (!v.far) makeFar(v);
    if (v.farLook !== v.look || v.farClear !== v.clear) fitFar(v);
  }
  if (v.lod !== far) {
    v.lod = far;
    v.chassis.visible = !far;
    for (const w of v.wheels) w.visible = !far;
    if (v.far) v.far.visible = far;
  }
  const on = cast && !far;
  if (v.cast !== on) {
    v.cast = on;
    for (const o of v.casters) o.castShadow = on;
  }
}

// Make a pooled view ready for another car of the same type: paint, glass, lights, motion and LOD as a fresh
// makeCarView(type, color) has them. Returns v, or null when v cannot show this car (it is another type, or
// was built before that type's model arrived) and should be dropped instead.
export function recycleCarView(v, type, color) {
  if (!v || v.type !== type || v.geo !== typeGeo(type)) return null;
  v.bodyMesh.material = paint(color);
  if (v.lowerMesh) v.lowerMesh.material = paint(CAR_TYPES[type].color2 || '#101012');
  v.glassMesh.material = GLASS;
  v.inside.visible = false;
  v.chassis.position.set(0, 0, 0);
  v.chassis.rotation.set(0, 0, 0);
  v.head.material = HEAD_OFF; v.tail.material = TAIL_OFF;
  v.pool.visible = false;
  v.pool.rotation.set(-Math.PI / 2, 0, -Math.PI / 2);
  v.pool.position.set(v.L / 2 + POOL_X, POOL_UP, 0);
  v.group.rotation.set(0, 0, 0);
  for (const w of v.wheels) { w.rotation.set(0, 0, 0); w.position.y = v.R; }
  Object.assign(v, { look: color, clear: false, spin: 0, steer: 0, roll: 0, pitch: 0, vf: 0, px: 0, pz: 0, pa: 0, y: 0, init: false, lastSpeed: undefined },
    rideState());
  setCarLOD(v, false, true);
  v.group.visible = true;
  return v;
}

// a view for a car: one of its type waiting in the pool, repainted, else a new one
export function carViewFrom(pool, type, color) {
  for (let v = pool.take(type); v; v = pool.take(type)) if (recycleCarView(v, type, color)) return v;
  return makeCarView(type, color);
}

// A pool of views waiting for something to show: car views and person rigs are reused instead of being built
// for every car or person that turns up and thrown away when it goes. Views wait under a key (a car type, a
// person's role), at most `max` in all; past that the one that has waited longest goes to drop(view).
export function makeViewPool(max = POOL_MAX, drop = null) {
  const idle = [];   // { key, v }, oldest first
  return {
    get size() { return idle.length; },
    // the view of this key that went in last, or null
    take(key) {
      for (let i = idle.length - 1; i >= 0; i--) {
        if (idle[i].key !== key) continue;
        const { v } = idle[i];
        idle.splice(i, 1);
        v.inPool = false;
        return v;
      }
      return null;
    },
    give(key, v) {
      if (v.inPool) return;   // already waiting: never hand one view to two owners
      v.inPool = true;
      idle.push({ key, v });
      while (idle.length > max) { const e = idle.shift(); e.v.inPool = false; drop?.(e.v); }
    },
    clear() { for (const e of idle.splice(0)) { e.v.inPool = false; drop?.(e.v); } },
    count(key) { let n = 0; for (const e of idle) if (e.key === key) n++; return n; },
  };
}

// Is something inside the sun's shadow box this frame? sky.js keeps the box (its shadow camera's left..right
// and bottom..top across the light, near..far along it) on the player, and three.js renders the shadow map
// from it, so a car outside it has no shadow to draw. update() once a frame, after the sun has moved; then
// has(x, y, z, r) for a ball of radius r (m) round a point.
export function makeShadowBox(sun) {
  const T = new THREE.Vector3(), L = new THREE.Vector3(), X = new THREE.Vector3(), Y = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  let ok = false, dist = 0;
  return {
    update() {
      T.copy(sun.target.position);
      dist = L.subVectors(sun.position, T).length();
      // the shadow camera sits on the sun looking at its target, with +y up (DirectionalLightShadow)
      ok = dist > 1e-6 && X.crossVectors(UP, L.divideScalar(dist)).lengthSq() > 1e-12;
      if (ok) { X.normalize(); Y.crossVectors(L, X); }
    },
    has(x, y, z, r = 0) {
      if (!ok) return true;   // no box to test against: cast, as before
      const sc = sun.shadow.camera, dx = x - T.x, dy = y - T.y, dz = z - T.z;
      const u = dx * X.x + dy * X.y + dz * X.z, w = dx * Y.x + dy * Y.y + dz * Y.z;
      const depth = dist - (dx * L.x + dy * L.y + dz * L.z);
      return u + r >= sc.left && u - r <= sc.right && w + r >= sc.bottom && w - r <= sc.top && depth + r >= sc.near && depth - r <= sc.far;
    },
  };
}

// People (main3d's pedestrian, cop and friend rigs) follow the same idea: drawn within PERSON_FAR of the
// camera and casting a shadow only within PERSON_CAST. Returns whether r is drawn.
export function personLOD(r, d) {
  r.lodShow = r.lodShow ? d <= PERSON_FAR : d < PERSON_FAR - PERSON_HYST;
  setCasting(r, r.lodShow && (r.cast !== false ? d <= PERSON_CAST : d < PERSON_CAST - PERSON_HYST));
  return r.lodShow;
}

// Turn shadow casting on or off for everything under r.root that was made to cast (a body, a gun, gear),
// remembering which those were the first time each is seen, so nothing else ever starts casting.
export function setCasting(r, on) {
  if (r.cast === on) return;
  r.cast = on;
  r.root.traverse((o) => {
    const ud = o.userData;
    if (ud.cast0 === undefined) ud.cast0 = o.castShadow;
    if (ud.cast0) o.castShadow = on;
  });
}

// For renderer.compileAsync (main3d): one view of every car type, and a mesh for each look a car can change
// to later (lights on, brakes, clear windows, a wreck, the far LOD in its four light states), so their
// shaders are ready before the first such car comes into view. Returns { group, views }: the views are
// ordinary ones, for the pool once compiled.
export function carPrewarm() {
  const group = new THREE.Group(), views = [];
  for (const type of Object.keys(CAR_TYPES)) {
    const v = makeCarView(type, CAR_TYPES[type].color);
    group.add(v.group);
    views.push(v);
  }
  const v = views[0];
  const looks = [[v.bodyMesh.geometry, WRECK], [v.glassMesh.geometry, WRECK_GLASS], [v.glassMesh.geometry, GLASS_CLEAR],
    [v.head.geometry, HEAD], [v.tail.geometry, TAIL_ON]];
  for (const [geo, mat] of looks) group.add(new THREE.Mesh(geo, mat));
  const far = farGeometry(v);
  for (const mat of FAR_MATS.flat()) group.add(new THREE.Mesh(far, mat));
  return { group, views };
}

// renderer.compileAsync(obj, camera, lightsFrom) for shaders drawn into `target` (null: the screen). three.js
// builds a shader's tone mapping and output colour space into it from the render target it is compiled for:
// one compiled for the screen is compiled all over again the first time it is drawn into an effects buffer,
// as the High tier draws the scene (graphics.js). The target is set only for the compile step, which runs at
// once; an error there comes back as a rejected promise.
export function compileFor(renderer, obj, camera, target, lightsFrom = null) {
  const prev = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
  try {
    renderer.setRenderTarget(target);
    return renderer.compileAsync ? renderer.compileAsync(obj, camera, lightsFrom) : Promise.resolve();
  } catch (e) {
    return Promise.reject(e);
  } finally {
    renderer.setRenderTarget(prev, face, mip);
  }
}

// ---------- the far LOD ----------

const WHITE = new THREE.Color(1, 1, 1);
const farBases = new Map();   // a type's geometry set (typeGeo) -> its far LOD's shared parts

function makeFar(v) {
  const far = new THREE.Mesh(farGeometry(v), FAR_MATS[0][0]);
  far.castShadow = false;
  far.receiveShadow = true;
  far.visible = false;
  // a police car's light bar keeps flashing (two more draws, police only)
  if (v.lights) far.add(new THREE.Mesh(v.lights.red, COP_RED), new THREE.Mesh(v.lights.blue, COP_BLUE));
  v.group.add(far);
  v.far = far;
  fitFar(v);
}

// the far mesh in the view's current paint, and sitting like its chassis (a wreck sits lower, a little askew)
function fitFar(v) {
  v.far.geometry = farGeometry(v);
  v.far.position.y = v.chassis.position.y;
  v.far.rotation.y = v.chassis.rotation.y;
  v.farLook = v.look; v.farClear = v.clear;
}

// The far geometry for the paint, glass and lower body v shows now. Each look of a type shares the type's
// positions, normals, light weights and index, and has its own colours (16 bits a channel, so dark paint
// keeps its shade), made once and kept: the number of looks is bounded by the paint lists.
function farGeometry(v) {
  const fb = farBase(v.geo, v.type);
  const body = v.bodyMesh.material, glass = v.glassMesh.material, lower = v.lowerMesh?.material;
  const key = `${body.id}/${glass.id}/${lower ? lower.id : ''}`;
  let geo = fb.looks.get(key);
  if (geo) return geo;
  const c = fb.col.slice();
  paintSpans(c, fb.spans.body, body.color);
  paintSpans(c, fb.spans.glass, glass.color);
  if (lower) paintSpans(c, fb.spans.lower, lower.color);
  const c16 = new Uint16Array(c.length);
  for (let i = 0; i < c.length; i++) c16[i] = Math.round(Math.min(1, Math.max(0, c[i])) * 65535);
  geo = new THREE.BufferGeometry();
  geo.setIndex(fb.index);
  geo.setAttribute('position', fb.position);
  geo.setAttribute('normal', fb.normal);
  geo.setAttribute('carGlow', fb.glow);
  geo.setAttribute('color', new THREE.BufferAttribute(c16, 3, true));
  geo.boundingSphere = fb.sphere.clone();
  fb.looks.set(key, geo);
  return geo;
}
function paintSpans(c, spans, color) {
  for (let i = 0; i < spans.length; i += 2) {
    for (let k = spans[i]; k < spans[i + 1]; k++) { c[k * 3] = color.r; c[k * 3 + 1] = color.g; c[k * 3 + 2] = color.b; }
  }
}

function farBase(g, type) {
  let fb = farBases.get(g);
  if (!fb) farBases.set(g, (fb = buildFarBase(g, type)));
  return fb;
}
// free a replaced geometry set's far LOD (its type's model has arrived)
function dropFar(g) {
  const fb = g && farBases.get(g);
  if (!fb) return;
  for (const geo of fb.looks.values()) geo.dispose();
  farBases.delete(g);
}

// Every part of a car merged into one indexed geometry, as the full view places it: each part in its
// material's colour (white where the look decides: body, glass, lower body; the trim in its own vertex
// colours), with the vertex spans a look repaints and the head and tail lights' glow weights. Parts the full
// car draws with a picture (the taxi sign, the van's and the old police car's door logos) take its main
// colour. The interior is left out, and the wheels are a plain tyre and hub in the wheel's own two colours.
function buildFarBase(g, type) {
  const b = new Builder(), I = new THREE.Matrix4();
  const spans = { body: [], glass: [], lower: [], head: [], tail: [] };
  const add = (span, geo, color, m = I) => {
    if (!geo) return;
    const n0 = b.vertexCount;
    b.geo(color ? bare(geo) : geo, m, color || WHITE);
    spans[span]?.push(n0, b.vertexCount);
  };
  add('body', g.body, WHITE);
  add('glass', g.glass, WHITE);
  add('lower', g.lower, WHITE);
  add('trim', g.trim, null);
  add('chrome', g.chrome, CHROME.color);
  add('arch', g.arch, ARCH.color);
  add('head', g.head, HEAD.color);
  add('tail', g.tail, TAIL_OFF.color);
  if (type === 'taxi' && !g.model) add('sign', taxiSignGeo(), col('#f2c230'), mat4(-0.05 * g.L, g.hr + 0.15, 0));
  for (const s of [-1, 1]) {
    if (type === 'van') add('logo', vanLogoGeo(), col('#d6402b'), mat4(-0.55, 1.5, s * (g.W / 2 + 0.035), 0, s > 0 ? 0 : Math.PI, 0));
    if (type === 'police' && !g.model) add('logo', copLogoGeo(), col('#1f4f8a'), mat4(-0.05, 0.6, s * (g.W / 2 + 0.03), 0, s > 0 ? 0 : Math.PI, 0));
  }
  const { tyre, hub } = wheelColours(g.wheel);
  const tyreG = new THREE.CylinderGeometry(g.R, g.R, g.tw, 12).rotateX(Math.PI / 2);
  const hubG = new THREE.CylinderGeometry(g.R * 0.62, g.R * 0.62, g.tw + 0.012, 10).rotateX(Math.PI / 2);
  for (const [x, y, z] of wheelSpots(g)) {
    const m = mat4(x, y, z);
    add('wheel', tyreG, tyre, m);
    add('wheel', hubG, hub, m);
  }
  const n = b.vertexCount, geo = b.build({ indexed: true });
  const glow = new Uint8Array(n * 2);
  for (const [span, j] of [[spans.head, 0], [spans.tail, 1]]) {
    for (let i = 0; i < span.length; i += 2) for (let k = span[i]; k < span[i + 1]; k++) glow[k * 2 + j] = 255;
  }
  return {
    n, spans, index: geo.index, position: geo.attributes.position, normal: geo.attributes.normal,
    glow: new THREE.BufferAttribute(glow, 2, true), col: geo.attributes.color.array, sphere: geo.boundingSphere, looks: new Map(),
  };
}

// a part's shape without its own vertex colours (the parts whose material colour is what shows)
function bare(geo) {
  if (!geo.attributes.color) return geo;
  const b = new THREE.BufferGeometry();
  for (const k of ['position', 'normal']) if (geo.attributes[k]) b.setAttribute(k, geo.attributes[k]);
  if (geo.index) b.setIndex(geo.index);
  return b;
}

// a wheel's tyre and rim colours: the mean vertex colour out at its rim and in round its hub
function wheelColours(geo) {
  const tyre = col('#1c1c1e'), hub = col('#9a9da3');
  const P = geo.attributes.position, C = geo.attributes.color;
  if (!C) return { tyre, hub };
  let R = 0;
  for (let i = 0; i < P.count; i++) R = Math.max(R, Math.hypot(P.getX(i), P.getY(i)));
  const out = [0, 0, 0, 0], inn = [0, 0, 0, 0];
  for (let i = 0; i < P.count; i++) {
    const r = Math.hypot(P.getX(i), P.getY(i)) / R, s = r > 0.88 ? out : r < 0.7 ? inn : null;
    if (s) { s[0] += C.getX(i); s[1] += C.getY(i); s[2] += C.getZ(i); s[3]++; }
  }
  if (out[3]) tyre.setRGB(out[0] / out[3], out[1] / out[3], out[2] / out[3]);
  if (inn[3]) hub.setRGB(inn[0] / inn[3], inn[1] / inn[3], inn[2] / inn[3]);
  return { tyre, hub };
}
