#!/usr/bin/env node
// Stage S3c check (docs/map-v2-stages.json, spec §11.1): car and person views near and far, and their pools.
//   node tools/s3c_views_test.mjs            (S3B_LOW=1 builds the phone tier's materials)
// For every car type, first the built-in car and then with its model loaded (assets/cars/*.glb):
//  1. The far LOD: one mesh, one draw (a police car adds its two flashing light bars), coloured per vertex in the
//     view's own paint, glass and lower body (a wreck in the wreck's), its head and tail lights glowing through
//     carGlow at the full car's strength (parked, running, braking; by day and at night), no shadow, the wheels
//     standing still, and the same size as the full car (bounding boxes within 6 cm). Back near, the full car
//     returns with its shadow casters. The four far materials share one shader, and its patch applies to
//     three r169's shaders.
//  2. recycleCarView: a view used hard (a wreck, clear windows, far, braking, wheels turned, rocked) and
//     recycled for a new colour matches a fresh makeCarView of that colour; another type, or a view built
//     before its type's model arrived, is refused.
//  3. The view pool: at most 40 waiting, the latest of a key first, never one view twice, the overflow and
//     clear() go to drop; carViewFrom reuses what the pool has.
//  4. The shadow box: has() says exactly whether a point is inside three.js's shadow frustum for the sun,
//     at several times of day and on both tiers' box sizes.
//  5. People: personLOD draws within 110 m and casts within 40 m (2 m of hysteresis on each), switching only
//     the meshes made to cast (a real 3D pedestrian, gun and gear included).
//  6. carPrewarm: its group holds a view of every type and every material any car can switch to, so
//     renderer.compileAsync compiles every car shader up front.
// Exits 1 if any check fails.
import { src, check, section, note, done, quiet } from './s3b_env.mjs';
const THREE = await import('three');
// (s3b_env's fetch reads files as bytes; char3d.js also reads its .json files)
const bytesOnly = globalThis.fetch;
globalThis.fetch = async (url) => {
  const r = await bytesOnly(url);
  return r.ok ? { ...r, json: async () => JSON.parse(new TextDecoder().decode(await r.arrayBuffer())) } : r;
};
const CARS = await import(src('src/3d/cars.js'));
const { CAR_TYPES, CAR_COLORS, LUX_COLORS } = await import(src('src/data.js'));

const TYPES = Object.keys(CAR_TYPES);
const C16 = 1 / 65535;

// meshes three.js would draw for obj (visible all the way up, material visible), and those casting
function drawn(obj, pred = () => true) {
  const out = [];
  const visit = (o) => {
    if (o.visible === false) return;
    if (o.isMesh && o.material.visible && pred(o)) out.push(o);
    for (const c of o.children) visit(c);
  };
  visit(obj);
  return out;
}
const casting = (obj) => drawn(obj, (o) => o.castShadow);
// the box round what a car looks like: its drawn meshes, without the headlight pool on the road
function looks(v) {
  v.group.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const m of drawn(v.group, (o) => o !== v.pool)) box.expandByObject(m, true);
  return box;
}
const boxGap = (a, b) => Math.max(...['x', 'y', 'z'].flatMap((k) => [Math.abs(a.min[k] - b.min[k]), Math.abs(a.max[k] - b.max[k])]));
// a sim car for syncCar / setCarLook
const simCar = (type, color, o = {}) => ({ type, x: 1600, y: 1600, a: 0.3, color, color2: CAR_TYPES[type].color2 || null, brake: false, wreck: false, hp: 100, ...o });
// how many vertices of a far geometry carry exactly this colour
function colourCount(geo, color) {
  const a = geo.attributes.color.array;
  let n = 0;
  for (let i = 0; i < a.length; i += 3) {
    if (Math.abs(a[i] * C16 - color.r) < 2 * C16 && Math.abs(a[i + 1] * C16 - color.g) < 2 * C16 && Math.abs(a[i + 2] * C16 - color.b) < 2 * C16) n++;
  }
  return n;
}
const glowCount = (geo, j) => { const g = geo.attributes.carGlow.array; let n = 0; for (let i = j; i < g.length; i += 2) if (g[i] === 255) n++; return n; };
const vcount = (geo) => geo?.attributes.position.count ?? 0;
// the far materials' uniforms, as their shader patch hands them to three.js
function patched(mat) {
  const lib = mat.isMeshPhysicalMaterial ? THREE.ShaderLib.physical : THREE.ShaderLib.standard;
  const sh = { uniforms: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
  mat.onBeforeCompile(sh);
  return sh;
}

// ---------- 1 and 2, for the built-in cars and then the models ----------

async function carChecks(stage) {
  section(`${stage}: the far LOD of every type`);
  const farCalls = [], nearCalls = [];
  for (const type of TYPES) {
    const color = CAR_TYPES[type].lux ? LUX_COLORS[5] : CAR_COLORS[4];
    const v = CARS.makeCarView(type, color), c = simCar(type, color);
    CARS.setCarLook(v, c, false);
    CARS.syncCar(v, c, 1 / 60, 0, null, true);
    const near = looks(v), nNear = drawn(v.group).length, casters = casting(v.group).length;
    nearCalls.push(nNear);
    check(`${stage} ${type}: the full car has casters`, casters > 0 && v.casters.length === casters, `${casters} casting, ${v.casters.length} listed`);

    CARS.setCarLOD(v, true, true);
    CARS.syncCar(v, c, 1 / 60, 0, null, true);
    const shown = drawn(v.group), far = v.far;
    const want = 1 + (v.lights ? 2 : 0);
    farCalls.push(shown.length);
    check(`${stage} ${type}: far is ${want} draw${want > 1 ? 's' : ''} by day`, shown.length === want && shown[0] === far, `${shown.length}: ${shown.map((m) => m.material.type).join(', ')}`);
    check(`${stage} ${type}: far casts no shadow`, casting(v.group).length === 0 && !far.castShadow);
    check(`${stage} ${type}: the chassis and wheels are hidden when far`, !v.chassis.visible && v.wheels.every((w) => !w.visible));
    const geo = far.geometry;
    check(`${stage} ${type}: far geometry is indexed with position, normal, 16-bit colours and carGlow`,
      !!geo.index && !!geo.attributes.normal && geo.attributes.color.array instanceof Uint16Array && geo.attributes.color.normalized && geo.attributes.carGlow?.normalized);
    check(`${stage} ${type}: far material uses vertex colours`, far.material.vertexColors === true);
    // its paint, glass and lower body as the full car shows them
    const body = v.bodyMesh.material.color, glass = v.glassMesh.material.color;
    check(`${stage} ${type}: far body in the car's paint`, colourCount(geo, body) >= vcount(v.bodyMesh.geometry), `${colourCount(geo, body)} of ${vcount(v.bodyMesh.geometry)}`);
    check(`${stage} ${type}: far glass in the glass colour`, colourCount(geo, glass) >= vcount(v.glassMesh.geometry));
    if (v.lowerMesh) check(`${stage} ${type}: far lower body in the second colour`, colourCount(geo, v.lowerMesh.material.color) >= vcount(v.lowerMesh.geometry));
    check(`${stage} ${type}: head and tail lights carry their glow`, glowCount(geo, 0) === vcount(v.head.geometry) && glowCount(geo, 1) === vcount(v.tail.geometry),
      `${glowCount(geo, 0)}/${vcount(v.head.geometry)} head, ${glowCount(geo, 1)}/${vcount(v.tail.geometry)} tail`);
    // the same size, so nothing jumps at the switch
    const gap = boxGap(near, looks(v));
    check(`${stage} ${type}: far is the full car's size (within 6 cm)`, gap < 0.06, `${(gap * 100).toFixed(1)} cm`);
    // still wheels: spinning the full car's wheels leaves the far mesh as it is
    const before = far.matrixWorld.clone();
    for (let i = 0; i < 10; i++) { c.x += 8; CARS.syncCar(v, c, 1 / 60, 0, null, true); }
    v.group.updateMatrixWorld(true);
    check(`${stage} ${type}: far has no wheel spin (only the whole car moves)`, far.children.every((k) => k.rotation.z === 0) && far.rotation.z === 0 && !before.equals(far.matrixWorld));
    // the lights: parked, running and braking materials
    CARS.syncCar(v, c, 1 / 60, 0, null, false);
    const parked = far.material;
    c.brake = true; CARS.syncCar(v, c, 1 / 60, 0, null, true);
    const braking = far.material;
    c.brake = false; CARS.syncCar(v, c, 1 / 60, 0, null, true);
    const running = far.material;
    check(`${stage} ${type}: far lights follow parked / running / braking`, new Set([parked, braking, running]).size === 3);
    // a wreck far away is in the wreck's colours
    c.wreck = true;
    CARS.setCarLook(v, c, false);
    CARS.setCarLOD(v, true, true);
    const wreckGeo = far.geometry;
    check(`${stage} ${type}: a far wreck is in the wreck's colours`, wreckGeo !== geo && colourCount(wreckGeo, v.bodyMesh.material.color) >= vcount(v.bodyMesh.geometry)
      && far.position.y === v.chassis.position.y && far.rotation.y === v.chassis.rotation.y);
    c.wreck = false;
    CARS.setCarLook(v, c, false);
    CARS.setCarLOD(v, true, true);
    check(`${stage} ${type}: a repainted car is given the matching far look (and shares it)`, far.geometry === geo);
    // back near, inside and then outside the shadow box
    CARS.setCarLOD(v, false, true);
    check(`${stage} ${type}: back near: the full car and its casters`, v.chassis.visible && !far.visible && casting(v.group).length === casters && drawn(v.group).length === nNear);
    CARS.setCarLOD(v, false, false);
    check(`${stage} ${type}: outside the shadow box nothing casts`, casting(v.group).length === 0 && drawn(v.group).length === nNear);
    CARS.setCarLOD(v, false, true);
  }
  note(`draws per car: full ${Math.min(...nearCalls)}-${Math.max(...nearCalls)} (day, running), far ${Math.min(...farCalls)}-${Math.max(...farCalls)}`);

  section(`${stage}: recycleCarView`);
  const sig = (v) => JSON.stringify({
    mats: [v.bodyMesh.material.uuid, v.glassMesh.material.uuid, v.lowerMesh?.material.uuid, v.head.material.uuid, v.tail.material.uuid],
    chassis: [...v.chassis.position.toArray(), ...v.chassis.rotation.toArray().slice(0, 3)],
    wheels: v.wheels.map((w) => w.rotation.toArray().slice(0, 3)),
    vis: [v.group.visible, v.chassis.visible, v.inside.visible, v.pool.visible, v.far ? v.far.visible : false, ...v.wheels.map((w) => w.visible)],
    cast: v.casters.map((o) => o.castShadow),
    st: [v.look, v.clear, v.spin, v.steer, v.roll, v.pitch, v.vf, v.y, v.init, v.lod, v.cast, v.lastSpeed],
  });
  let same = 0;
  for (const type of TYPES) {
    const v = CARS.makeCarView(type, '#3b7dd8'), c = simCar(type, '#3b7dd8');
    // a hard life: driven, rocked, wrecked behind clear windows, braking far away, then out of the shadow box
    CARS.setCarLook(v, c, true);
    for (let i = 0; i < 20; i++) { c.x += 10; c.a += 0.05; CARS.syncCar(v, c, 1 / 60, 3, 0.8, true); }
    c.wreck = true; c.brake = true;
    CARS.setCarLook(v, c, true);
    CARS.setCarLOD(v, true, false);
    CARS.syncCar(v, c, 1 / 60, 3, null, true);
    v.lastSpeed = 12; v.group.visible = false;
    const r = CARS.recycleCarView(v, type, '#e3843a');
    const fresh = CARS.makeCarView(type, '#e3843a');
    if (check(`${stage} ${type}: recycled view matches a fresh one`, r === v && sig(v) === sig(fresh), r ? '' : 'refused')) same++;
    check(`${stage} ${type}: recycling for another type is refused`, CARS.recycleCarView(v, type === 'van' ? 'sedan' : 'van', '#e3843a') === null);
  }
  note(`${same} of ${TYPES.length} recycled views match fresh ones`);
}

await quiet(() => carChecks('built-in'));

section('far shader');
{
  const v = CARS.makeCarView('sedan', '#2f2f33'), c = simCar('sedan', '#2f2f33');
  CARS.setCarLOD(v, true, true);
  const mats = [];
  for (const run of [false, true]) for (const brake of [false, true]) { c.brake = brake; CARS.syncCar(v, c, 1 / 60, 0, null, run); mats.push(v.far.material); }
  check('four far materials (parked / running x braking)', new Set(mats).size === 4);
  check('they share one shader program (same cache key)', new Set(mats.map((m) => m.customProgramCacheKey())).size === 1 && mats.every((m) => m.type === mats[0].type));
  const sh = mats.map(patched);
  check('the patch adds carGlow to the vertex shader', sh.every((s) => s.vertexShader.includes('attribute vec2 carGlow') && s.vertexShader.includes('vCarGlow = carGlow;')));
  check('and the glow to the emissive light', sh.every((s) => s.fragmentShader.includes('totalEmissiveRadiance += carHeadC') && s.fragmentShader.indexOf('totalEmissiveRadiance += carHeadC') > s.fragmentShader.indexOf('#include <emissivemap_fragment>')));
  for (const lib of ['standard', 'physical']) {
    const s = THREE.ShaderLib[lib];
    check(`three's ${lib} shader has the lines the patch hooks into`, s.vertexShader.includes('#include <begin_vertex>') && s.fragmentShader.includes('#include <emissivemap_fragment>'));
  }
  const [parked, parkedBrake, run, runBrake] = sh.map((s) => s.uniforms);
  const strengths = () => [parked.carHead.value, run.carHead.value, run.carTail.value, runBrake.carTail.value, parkedBrake.carTail.value];
  CARS.setCarNight(0);
  const day = strengths();
  CARS.setCarNight(1);
  const night = strengths();
  // the full car's: HEAD 0.2 + 2.6k, HEAD_OFF 0.1, TAIL_OFF 0.25 + 0.9k, TAIL_ON 2.4
  const near = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
  check('far light strengths by day match the full car\'s', near(day, [0.1, 0.2, 0.25, 2.4, 2.4]), day.join(' '));
  check('and at night', near(night, [0.1, 2.8, 1.15, 2.4, 2.4]), night.join(' '));
  CARS.setCarNight(0);
  check('the headlight pool is not drawn by day (it is fully see-through)', (CARS.syncCar(v, c, 1 / 60, 0, null, true), !v.pool.visible));
  CARS.setCarNight(0.5);
  CARS.syncCar(v, c, 1 / 60, 0, null, true);
  check('and is drawn at night for a running car', v.pool.visible);
  CARS.syncCar(v, c, 1 / 60, 0, null, false);
  check('but not for a parked one', !v.pool.visible);
  CARS.setCarNight(0);
}

section('LOD distances');
{
  const v = CARS.makeCarView('hatch', '#3b7dd8');
  const seq = [60, 72, 73.5, 80, 69, 67.5, 66, 74, 60].map((d) => { const f = CARS.carFar(v, d); CARS.setCarLOD(v, f, true); return f ? 'F' : 'N'; }).join('');
  check('full within 70 m, far beyond, 3 m of hysteresis each way', seq === 'NNFFFFNFN', seq);
  check('nothing switches inside 60 m', [0, 20, 40, 59.9].every((d) => !CARS.carFar({ lod: true }, d) && !CARS.carFar({ lod: false }, d)));
}

// ---------- 3. the pool ----------

section('the view pool');
{
  const dropped = [];
  const pool = CARS.makeViewPool(CARS.POOL_MAX, (v) => dropped.push(v));
  const views = Array.from({ length: 45 }, (_, i) => ({ id: i }));
  views.forEach((v, i) => pool.give(i % 2 ? 'a' : 'b', v));
  check('at most 40 wait', pool.size === 40 && dropped.length === 5);
  check('the longest-waiting go first', dropped.map((v) => v.id).join() === '0,1,2,3,4');
  check('take() gives the latest of a key', pool.take('a') === views[43] && pool.take('b') === views[44]);
  const v = pool.take('a');
  pool.give('a', v); pool.give('a', v);
  check('a view given twice waits once', pool.count('a') === [...views.slice(5)].filter((x) => x.id % 2).length - 1);
  check('take() of a key with nothing waiting is null', pool.take('zzz') === null);
  const left = pool.size;
  pool.clear();
  check('clear() drops everything waiting', pool.size === 0 && dropped.length === 5 + left && left === 38);

  const cars = CARS.makeViewPool();
  const a = CARS.carViewFrom(cars, 'taxi', '#f2c230');
  cars.give('taxi', a);
  const b = CARS.carViewFrom(cars, 'taxi', '#3c8d5a');
  check('carViewFrom reuses a pooled view of the type, repainted', b === a && b.bodyMesh.material.color.equals(new THREE.Color('#3c8d5a')) && cars.size === 0);
  cars.give('taxi', b);
  const s = CARS.carViewFrom(cars, 'sedan', '#2f2f33');
  check('and makes a new one for another type', s !== b && s.type === 'sedan' && cars.size === 1);
}

// ---------- 4. the shadow box ----------

section('the shadow box');
{
  const D = await import('./s3b_draws.mjs');
  // sky.js's sun; three.js sets the shadow camera's projection from its box when it makes the shadow map
  const makeSun = (half) => { const s = D.makeSun(half); s.shadow.camera.updateProjectionMatrix(); return s; };
  let bad = 0, inside = 0, n = 0;
  const p = new THREE.Vector3();
  for (const half of [42, 64]) {
    const sun = makeSun(half), box = CARS.makeShadowBox(sun);
    for (const minutes of [7 * 60, 10 * 60, 13 * 60, 15.5 * 60, 18.5 * 60]) {
      const focus = new THREE.Vector3(150 + half, 2, 200 - half);
      D.placeSun(sun, minutes, focus);
      box.update();
      const fr = sun.shadow.getFrustum();
      for (let i = 0; i < 4000; i++) {
        p.set(focus.x + (Math.random() - 0.5) * 300, focus.y + (Math.random() - 0.3) * 30, focus.z + (Math.random() - 0.5) * 300);
        const want = fr.containsPoint(p), got = box.has(p.x, p.y, p.z, 0);
        if (want !== got) bad++;
        if (want) inside++;
        n++;
      }
    }
  }
  check('has() agrees with three.js\'s shadow frustum', bad === 0, `${bad} of ${n} points disagree`);
  note(`${inside} of ${n} random points inside`);
  const sun = makeSun(64), box = CARS.makeShadowBox(sun);
  check('before the first update everything counts as inside', box.has(1e5, 0, 1e5));
  D.placeSun(sun, 13 * 60, new THREE.Vector3(100, 0, 100));
  box.update();
  check('a ball reaching into the box counts', !box.has(100 + 64 * 2.5, 0, 100, 0) || box.has(100 + 64 * 2.5, 0, 100, 200));
}

// ---------- 5. people ----------

section('people');
{
  const C3 = await import(src('src/3d/char3d.js'));
  const GUNS = await import(src('src/3d/guns.js'));
  const r = C3.makeChar3D(await C3.loadChar3D('ped_office'), { height: 1.76 });
  const g = await quiet(async () => { try { return GUNS.attachGun(r); } catch (e) { return null; } });
  const extra = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1));   // made not to cast
  r.root.add(extra);
  const made = casting(r.root).length;
  check('a 3D pedestrian rig has casters', made > 0, `${made}${g ? ' (gun attached)' : ''}`);
  const seq = [];
  for (const d of [10, 39, 40.5, 41, 39, 38.5, 37, 100, 109, 110.5, 111, 109, 107, 50]) {
    const show = CARS.personLOD(r, d);
    r.root.visible = show;
    seq.push(`${show ? 'S' : '-'}${r.cast ? 'c' : '-'}`);
  }
  check('drawn within 110 m, casting within 40 m, 2 m of hysteresis', seq.join(' ') === 'Sc Sc S- S- S- S- Sc S- S- -- -- -- S- S-', seq.join(' '));
  CARS.personLOD(r, 5);
  check('casting again close up switches back exactly what was made to cast', casting(r.root).length === made && !extra.castShadow);
  const late = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1));
  late.castShadow = true;
  r.root.add(late);
  CARS.personLOD(r, 60);
  check('a caster added later is switched too', !late.castShadow && casting(r.root).length === 0);
  CARS.personLOD(r, 5);
  check('and back on', late.castShadow && !extra.castShadow);
}

// ---------- 6. prewarm ----------

section('prewarm');
{
  const { group, views } = CARS.carPrewarm();
  check('a view of every car type', views.length === TYPES.length && TYPES.every((t) => views.some((v) => v.type === t)));
  const sig = (m) => `${m.type}|${m.vertexColors}|${m.transparent}|${!!m.map}|${!!m.emissiveMap}|${m.clearcoat > 0}|${m.customProgramCacheKey()}`;
  const have = new Set();
  group.traverse((o) => { if (o.isMesh) have.add(sig(o.material)); });
  // every material any view shows in any state
  const need = new Map();
  const add = (v) => v.group.traverse((o) => { if (o.isMesh) need.set(sig(o.material), o.material.type); });
  for (const type of TYPES) {
    const v = CARS.makeCarView(type, CAR_COLORS[0]), c = simCar(type, CAR_COLORS[0]);
    for (const [wreck, clear, run, brake, far] of [[0, 0, 0, 0, 0], [0, 1, 1, 1, 0], [1, 0, 0, 1, 0], [1, 1, 1, 0, 0], [0, 0, 1, 1, 1], [0, 0, 0, 0, 1], [0, 0, 1, 0, 1], [0, 0, 0, 1, 1]]) {
      Object.assign(c, { wreck: !!wreck, brake: !!brake });
      CARS.setCarLook(v, c, !!clear);
      CARS.setCarLOD(v, !!far, true);
      CARS.syncCar(v, c, 1 / 60, 0, null, !!run);
      add(v);
    }
  }
  const missing = [...need.keys()].filter((k) => !have.has(k));
  check('its group holds every material a car can show', missing.length === 0, missing.join('; '));
  note(`${have.size} shader variants in the prewarm group`);
}

// ---------- 1 and 2 again with the models ----------

const n = await quiet(() => CARS.loadCarModels());
check('the car models load in node', n === CARS.MODEL_CARS.length, `${n} of ${CARS.MODEL_CARS.length}`);
{
  section('models: views built before a model arrived');
  const pool = CARS.makeViewPool();
  // (made before loadCarModels by carChecks; one more of each built-in now would be the model, so make the
  // stale one by hand from the pool test: a view whose geometry is no longer its type's)
  const stale = { type: 'sedan', geo: {} };
  check('a view from before its model is refused by recycleCarView', CARS.recycleCarView(stale, 'sedan', '#fff') === null);
  pool.give('sedan', stale);
  const v = CARS.carViewFrom(pool, 'sedan', '#2f2f33');
  check('carViewFrom drops it and makes a new one', v !== stale && v.geo && pool.size === 0);
}
await quiet(() => carChecks('model'));

done();
