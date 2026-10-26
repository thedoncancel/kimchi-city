#!/usr/bin/env node
// Stage S3c check (docs/map-v2-stages.json, spec §11.1): the shader prewarm compiles the programs the game
// really draws with, so nothing is compiled again at the first frame.
//   node tools/s3c_prewarm_test.mjs            (S3B_LOW=1 builds the phone tier's materials)
// three.js r169 runs here on a stand-in WebGL2 context (every call accepted, every shader compiles), so its
// own program cache decides what is compiled when. The scene is a small street: sun with shadows, sky light,
// fog, ground and kerb, a lamp that ignores tone mapping, and cars in the looks the game shows (near, far,
// wreck, braking, clear windows), with the prewarm group compiled beside it as main3d does.
//  1. cars.js compileFor compiles into the render target it is given and puts the renderer's own target back
//     afterwards, also when compiling throws (a rejected promise) or there is no compileAsync.
//  2. The High tier draws the scene into the effects chain's buffer (graphics.js, RenderPass): prewarmed with
//     compileFor into that buffer, the first frame drawn into it builds no program for the scene's materials
//     and each one keeps the program the prewarm built. Prewarmed for the screen instead, as before the fix,
//     that first frame builds them all again (this is what the review found).
//  3. The phone tier draws straight to the screen: prewarmed for the screen, its first frame builds nothing.
//  4. main3d's wiring, read from its source (it needs a browser): compileSoon goes through compileFor with
//     the composer's buffer, render() decides which cars cast only after sky.update has moved the sun, and
//     seatRig lets a seated rig cast.
// Exits 1 if any check fails.
import { readFileSync } from 'node:fs';
import { src, check, section, note, done, quiet, ROOT } from './s3b_env.mjs';
const THREE = await import('three');
const CARS = await import(src('src/3d/cars.js'));
const { CAR_TYPES, CAR_COLORS } = await import(src('src/data.js'));

// ---------- a stand-in WebGL2 context ----------

// Every constant is a number of its own, every create*() a new handle, every other call accepted. Shaders
// compile and programs link; a program reports no attributes or uniforms, so nothing is uploaded.
function stubGL() {
  const ids = new Map(), names = new Map();
  const K = (name) => {
    if (!ids.has(name)) { ids.set(name, 0x10000 + ids.size); names.set(ids.get(name), name); }
    return ids.get(name);
  };
  const NONE = new Set(['WEBGL_multisampled_render_to_texture', 'OVR_multiview2', 'EXT_disjoint_timer_query_webgl2', 'WEBGL_lose_context']);
  const ext = (name) => new Proxy({}, { get: (t, k) => (typeof k !== 'string' ? undefined : /^[A-Z0-9_]+$/.test(k) ? K(`${name}.${k}`) : () => {}) });
  const param = (p) => {
    const n = names.get(p) || '';
    if (n === 'VERSION') return 'WebGL 2.0 (stand-in)';
    if (n === 'SHADING_LANGUAGE_VERSION') return 'WebGL GLSL ES 3.00';
    if (n === 'SCISSOR_BOX' || n === 'VIEWPORT') return new Int32Array([0, 0, 1280, 720]);
    if (n === 'MAX_SAMPLES') return 4;
    if (/TEXTURE_IMAGE_UNITS|MAX_VERTEX_ATTRIBS|VARYING_VECTORS/.test(n)) return 16;
    if (/^MAX_|MAX_TEXTURE_MAX_ANISOTROPY/.test(n)) return 4096;
    return 0;
  };
  const fns = {
    getParameter: param,
    getContextAttributes: () => ({ alpha: false, antialias: false, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false }),
    getExtension: (name) => (NONE.has(name) ? null : ext(name)),
    getSupportedExtensions: () => [],
    getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
    getShaderParameter: () => true,
    getProgramParameter: (prog, p) => (/^ACTIVE_/.test(names.get(p) || '') ? 0 : true),
    getProgramInfoLog: () => '', getShaderInfoLog: () => '', getShaderSource: () => '',
    getAttribLocation: () => -1, getUniformLocation: () => null, getUniformBlockIndex: () => 0xffffffff,
    checkFramebufferStatus: () => K('FRAMEBUFFER_COMPLETE'),
    isContextLost: () => false,
    getError: () => 0,
  };
  return new Proxy({}, {
    get(t, k) {
      if (k in fns) return fns[k];
      if (typeof k !== 'string') return undefined;
      if (/^[A-Z0-9_]+$/.test(k)) return K(k);
      if (k === 'canvas' || k === 'drawingBufferColorSpace') return undefined;
      if (k === 'drawingBufferWidth') return 1280;
      if (k === 'drawingBufferHeight') return 720;
      if (k.startsWith('create')) return () => ({ stub: k });
      return () => {};
    },
    set() { return true; },
  });
}
// a renderer as main3d makes it, on the stand-in context
function makeRenderer() {
  const canvas = { width: 1280, height: 720, style: {}, addEventListener() {}, removeEventListener() {} };
  const renderer = new THREE.WebGLRenderer({ canvas, context: stubGL() });
  renderer.debug.checkShaderErrors = false;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  return renderer;
}
// graphics.js's effects buffer (the composer's two buffers are clones of it)
const effectsBuffer = () => new THREE.WebGLRenderTarget(1280, 720, { type: THREE.HalfFloatType, samples: 2 });

// ---------- the street ----------

function makeStreet() {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog('#bcd3e6', 120, 900);
  const sun = new THREE.DirectionalLight('#fff4e0', 3);
  sun.castShadow = true;
  Object.assign(sun.shadow.camera, { left: -64, right: 64, top: 64, bottom: -64, near: 1, far: 420 });
  sun.position.set(80, 160, 40);
  scene.add(sun, sun.target, new THREE.HemisphereLight('#cfe6ff', '#4a4038', 1.1));
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: '#3a3a3e', roughness: 0.9 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  const kerb = new THREE.Mesh(new THREE.BoxGeometry(60, 0.2, 2), new THREE.MeshLambertMaterial({ color: '#a8a39a' }));
  kerb.position.set(0, 0.1, 6);
  kerb.castShadow = kerb.receiveShadow = true;
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.4), new THREE.MeshBasicMaterial({ color: '#fff2c0', toneMapped: false }));
  lamp.position.set(4, 6, 6);
  scene.add(ground, kerb, lamp);
  // cars as the game shows them: near and far, running and braking, a wreck, one with clear windows
  const types = Object.keys(CAR_TYPES);
  const cars = [];
  types.forEach((type, i) => {
    const v = CARS.makeCarView(type, CAR_COLORS[(i * 3) % CAR_COLORS.length]);
    const c = { type, x: (i * 9 - 40) * 16, y: (i % 2 ? 3 : -3) * 16, a: i % 2 ? Math.PI : 0, color: v.look, color2: CAR_TYPES[type].color2 || null,
      brake: i % 3 === 0, wreck: i === 4, hp: i === 4 ? 0 : 100 };
    CARS.setCarLook(v, c, i === 2);
    CARS.setCarLOD(v, i % 4 === 1, true);
    CARS.syncCar(v, c, 1 / 60, 0, null, !c.wreck);
    scene.add(v.group);
    cars.push(v);
  });
  const camera = new THREE.PerspectiveCamera(62, 1280 / 720, 0.1, 4000);
  camera.position.set(0, 4, 18);
  camera.lookAt(0, 1, 0);
  scene.traverse((o) => { o.frustumCulled = false; });   // every shown mesh is drawn, so each one's program counts
  scene.updateMatrixWorld(true);
  return { scene, camera, cars };
}

// the programs a renderer holds, and which of them draw shadows (the shadow pass's own depth materials,
// which no prewarm compiles and which do not depend on where the scene is drawn)
const programs = (r) => new Set(r.info.programs);
const isShadow = (p) => /^(depth|distanceRGBA),/.test(p.cacheKey);
function materialsOf(obj) {
  const out = new Set();
  obj.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) out.add(m); });
  return out;
}
const programOf = (r, m) => r.properties.get(m).currentProgram;
// what main3d does at start-up and then at its first frame: prewarm the scene and the car group into the
// target `into`, then draw the scene into `drawTo` (null: the screen), as RenderPass or renderer.render does
// (three.js keeps a renderer's programs and a material's program for it per renderer, so one scene can go
// through this with several renderers)
async function firstFrame(into, drawTo, { scene, camera } = makeStreet()) {
  const renderer = makeRenderer();
  const { group } = CARS.carPrewarm();
  await CARS.compileFor(renderer, scene, camera, into);
  await CARS.compileFor(renderer, group, camera, into, scene);
  const before = programs(renderer);
  const prog0 = new Map();
  for (const m of materialsOf(scene)) prog0.set(m, programOf(renderer, m));
  renderer.setRenderTarget(drawTo);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  const built = [...programs(renderer)].filter((p) => !before.has(p) && !isShadow(p));
  let drawn = 0, changed = 0;
  scene.traverseVisible((o) => {
    if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
    drawn++;
    for (const m of [].concat(o.material)) if (m.visible && programOf(renderer, m) !== prog0.get(m)) { changed++; break; }
  });
  const kinds = {};
  for (const p of before) { const k = p.cacheKey.split(',')[0]; kinds[k] = (kinds[k] || 0) + 1; }
  return { prewarmed: before.size, kinds, built, drawn, changed };
}

// ---------- 1. compileFor ----------

section('compileFor');
{
  const renderer = makeRenderer();
  const { scene, camera } = makeStreet();
  const T = effectsBuffer(), own = new THREE.WebGLRenderTarget(64, 64);
  let seen = 'unset';
  const real = renderer.compileAsync.bind(renderer);
  renderer.compileAsync = (...a) => { seen = renderer.getRenderTarget(); return real(...a); };
  renderer.setRenderTarget(own);
  await CARS.compileFor(renderer, scene, camera, T);
  check('compiles into the target it is given', seen === T);
  check('and puts the renderer\'s own target back', renderer.getRenderTarget() === own);
  renderer.setRenderTarget(null);
  await CARS.compileFor(renderer, scene, camera, null);
  check('null compiles for the screen', seen === null && renderer.getRenderTarget() === null);
  renderer.compileAsync = () => { throw new Error('compile failed'); };
  renderer.setRenderTarget(own);
  let err = null;
  const p = CARS.compileFor(renderer, scene, camera, T);
  check('a compile that throws comes back as a promise', p instanceof Promise);
  await p.catch((e) => { err = e; });
  check('which rejects with the error', err?.message === 'compile failed');
  check('and the renderer\'s target is put back', renderer.getRenderTarget() === own);
  renderer.compileAsync = undefined;
  let ok = false;
  await CARS.compileFor(renderer, scene, camera, T).then(() => { ok = true; });
  check('no compileAsync (an old three.js): resolves, target put back', ok && renderer.getRenderTarget() === own);
}

// ---------- 2 and 3. the first frame after the prewarm ----------

section('High tier: drawn into the effects buffer');
{
  const T = effectsBuffer();
  const fixed = await firstFrame(T, T);
  note(`${fixed.prewarmed} programs prewarmed (${Object.entries(fixed.kinds).map(([k, n]) => `${k} ${n}`).join(', ')}), ${fixed.drawn} meshes drawn`);
  // (three.js builds standard and physical materials from one shader, 'physical')
  check('the prewarm built a program for each kind of material', ['physical', 'lambert', 'basic'].every((k) => fixed.kinds[k] > 0), JSON.stringify(fixed.kinds));
  check('prewarmed into the buffer: the first frame builds no program for the scene', fixed.built.length === 0,
    fixed.built.map((p) => p.name || p.cacheKey.slice(0, 40)).join(', '));
  check('and every material drawn keeps the program the prewarm built', fixed.changed === 0, `${fixed.changed} of ${fixed.drawn} changed`);
  const old = await firstFrame(null, effectsBuffer());
  note(`prewarmed for the screen (before the fix): the first frame built ${old.built.length} programs, ${old.changed} of ${old.drawn} meshes switched`);
  check('prewarmed for the screen instead, the first frame builds them again (the bug this fixes)', old.built.length > 0 && old.changed > 0);
}

section('High tier with the grid city');
{
  // the grid city as the game builds it (world.js, city.js), round the street, its models loaded
  const W = await import(src('src/world.js'));
  W.generate();
  const CITY = await import(src('src/3d/city.js'));
  const world = makeStreet();
  await quiet(async () => {
    CITY.buildCity(world.scene);
    await new Promise((r) => setTimeout(r, 1500));   // (the palm and asset-pack models load)
  });
  world.scene.traverse((o) => { o.frustumCulled = false; });
  world.scene.updateMatrixWorld(true);
  const T = effectsBuffer();
  const fixed = await firstFrame(T, T, world);
  note(`${fixed.prewarmed} programs prewarmed (${Object.entries(fixed.kinds).map(([k, n]) => `${k} ${n}`).join(', ')}), ${fixed.drawn} objects drawn`);
  check('prewarmed into the buffer: the first frame builds no program for the city or its cars', fixed.built.length === 0,
    fixed.built.map((p) => p.cacheKey.split(',')[0]).join(', '));
  check('and every material drawn keeps its prewarmed program', fixed.changed === 0, `${fixed.changed} of ${fixed.drawn} changed`);
  const old = await firstFrame(null, effectsBuffer(), world);
  note(`prewarmed for the screen (before the fix): the first frame built ${old.built.length} programs, ${old.changed} of ${old.drawn} objects switched`);
  check('prewarmed for the screen instead, the city\'s programs are built again', old.built.length > 0 && old.changed > 0);
}

section('phone tier: drawn to the screen');
{
  const r = await firstFrame(null, null);
  check('prewarmed for the screen: the first frame builds no program for the scene', r.built.length === 0, r.built.map((p) => p.name).join(', '));
  check('and every material drawn keeps its prewarmed program', r.changed === 0, `${r.changed} of ${r.drawn} changed`);
}

// ---------- 4. main3d's wiring ----------

section('main3d wiring');
{
  const code = readFileSync(`${ROOT}/src/3d/main3d.js`, 'utf8');
  const body = (name) => {
    const i = code.indexOf(`function ${name}(`);
    if (i < 0) return '';
    const j = code.indexOf('\n}\n', i);
    return code.slice(i, j < 0 ? code.length : j);
  };
  const soon = body('compileSoon');
  check('compileSoon compiles through compileFor into the composer\'s buffer (null on the phone tier)',
    /compileFor\(renderer,\s*obj,\s*camera,\s*gfx\.passes\?\.composer\.readBuffer\s*\?\?\s*null/.test(soon));
  check('nothing else calls renderer.compileAsync', !/\.compileAsync\(/.test(code));
  const render = body('render'), sync = body('syncEntities'), cast = body('castCars');
  const iSky = render.indexOf('sky.update('), iCast = render.indexOf('castCars()');
  check('render() decides which cars cast after sky.update has moved the sun', iSky >= 0 && iCast > iSky);
  check('and before the frame is drawn', iCast >= 0 && iCast < render.indexOf('bench.render()'));
  check('castCars updates the shadow box first, then tests each shown car', /shadowBox\.update\(\)[\s\S]*shadowBox\.has\(/.test(cast));
  check('syncEntities no longer tests the box (it runs before the sun moves)', !/shadowBox\./.test(sync));
  check('seatRig lets a rig cast once it sits in a car', /setCasting\(r,\s*true\)/.test(body('seatRig')));
}

done();
