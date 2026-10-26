#!/usr/bin/env node
// Stage S3c soak (docs/map-v2-stages.json, spec §11.1): the car-view and person-rig pools over a long session.
//   node tools/s3c_soak_test.mjs [minutes=15] [v2|grid]       (default: v2 when world-v2 is READY)
// It plays the world headless at 60 Hz with main3d's view bookkeeping (syncEntities, copied here because
// main3d.js needs a browser): a view for every car and a rig for every person, from the pools when they have
// one, given back to the pools every 0.5 s when their car or person has gone, the LOD and shadow rules
// applied at 30 Hz from a chase camera behind Kimchi. On v2 Kimchi drives at 30 m/s from one far goal to the
// next, with a fast-travel jump every 3 minutes, so the streamed traffic and people turn over all the time;
// on the grid a traffic car and a pedestrian are taken away every 5 s (as carjacks, wrecks and knock-downs
// do) and the population replaces them, and every 3 minutes Kimchi jumps from the villa to the hospital (a
// respawn) or back. Checks:
//   - right after each prune carViews.size <= cars, and at any time carViews.size <= cars + the cars gone
//     since the last prune; the same for people;
//   - each pool holds at most 40, holds nothing that is in use or in the scene, and no view serves two cars;
//   - past the first fill the pools serve at least 80% of the cars and 85% of the people that turn up (a car
//     view is made only when no view of its type is waiting: the 12 types in traffic share the 40 places, and
//     on v2, driving at 30 m/s, a car turns up about every 0.4 s);
//   - the heap (after a full GC, once a minute) is flat: it ends within 8 MB of where it stood at minute 3;
//   - every shown full car casts exactly when it reaches into the sun's shadow frustum of that frame, also on
//     the frame of a jump, when the box moves 230 m (main3d settles the casting after sky.update moves the sun).
// Exits 1 if any check fails.
import { registerHooks } from 'node:module';
import v8 from 'node:v8';
import vm from 'node:vm';

const MINUTES = Number(process.argv.find((a) => /^\d+(\.\d+)?$/.test(a)) || 15);
const want = process.argv.find((a) => a === 'v2' || a === 'grid');
globalThis.KC_WORLD = want || 'v2';

const { src, check, section, note, done, seeded } = await import('./s3b_env.mjs');
const STUBS = {
  'ui.js': 'export const toast = () => {};',
  'audio.js': 'const f = () => {}; export const sfx = new Proxy({}, { get: () => f }); export const audio = {};',
};
registerHooks({
  resolve(spec, ctx, next) {
    const name = spec.split('/').pop();
    if (spec.startsWith('.') && ctx.parentURL?.includes('/src/') && !ctx.parentURL.includes('/src/3d/') && STUBS[name]) {
      return { url: 'data:text/javascript,' + encodeURIComponent(STUBS[name]), shortCircuit: true };
    }
    return next(spec, ctx);
  },
});
globalThis.Image = class { set src(v) {} };
v8.setFlagsFromString('--expose_gc');
const gc = vm.runInNewContext('gc');
const heapMB = () => { gc(); gc(); return process.memoryUsage().heapUsed / 1048576; };

const THREE = await import('three');
const W = await import(src('src/world.js'));
W.generate();
const { G } = await import(src('src/state.js'));
const ENT = await import(src('src/entities.js'));
const CARS = await import(src('src/3d/cars.js'));
const PEOPLE = await import(src('src/3d/people.js'));
const D = await import('./s3b_draws.mjs');
if (want === 'v2' && W.KIND !== 'v2') { console.log('s3c soak: world-v2 is not READY yet; nothing to check on v2'); process.exit(0); }
const V2 = W.KIND === 'v2', S = 1 / 16, DT = 1 / 60, M = 16, JUMP = 180;
section(`s3c soak: ${MINUTES} min on the ${W.KIND} map`);

// ---------- main3d's view bookkeeping ----------

const scene = new THREE.Scene();
const sun = D.makeSun(64);
sun.shadow.camera.updateProjectionMatrix();
scene.add(sun, sun.target);
const shadowBox = CARS.makeShadowBox(sun);
const carViews = new Map(), pedViews = new Map();
const carPool = CARS.makeViewPool(CARS.POOL_MAX), rigPool = CARS.makeViewPool(CARS.POOL_MAX);
const cam = new THREE.Vector3();
// (weak, so the test itself keeps nothing alive that the game would have let go)
const made = { cars: new WeakSet(), rigs: new WeakSet(), nCars: 0, nRigs: 0 }, reused = { cars: 0, rigs: 0 };
const owner = new WeakMap();   // a scene child -> its view or rig
const camDist = (x, y, z) => Math.hypot(x - cam.x, y - cam.y, z - cam.z);
const carInView = V2 ? (x, z, d, shown) => d < CARS.CAR_FAR + (shown ? CARS.CAR_HYST : 0) : (x, z) => Math.abs(x - cam.x) < 170 && Math.abs(z - cam.z) < 170;
function pedRig(ped) {
  const key = ped.role || 'ped';
  let r = rigPool.take(key);
  if (r) reused.rigs++;
  else { r = PEOPLE.makePerson(ped.look); r.poolKey = key; made.rigs.add(r); made.nRigs++; owner.set(r.root, r); }
  return r;
}
let pruneT = 0;
const gone = { cars: 0, peds: 0 };
function prune() {
  const alive = new Set(G.cars), walking = new Set(G.peds);
  for (const [c, v] of carViews) {
    if (alive.has(c)) continue;
    scene.remove(v.group); carViews.delete(c); carPool.give(v.type, v);
  }
  for (const [p, r] of pedViews) {
    if (walking.has(p)) continue;
    scene.remove(r.root); pedViews.delete(p); rigPool.give(r.poolKey, r);
  }
  gone.cars = gone.peds = 0;
}
function syncViews(dt) {
  if ((pruneT -= dt) <= 0) { pruneT = 0.5; prune(); afterPrune(); }
  for (const c of G.cars) {
    let v = carViews.get(c);
    if (!v) {
      v = CARS.carViewFrom(carPool, c.type, c.color);
      if (made.cars.has(v)) reused.cars++; else { made.cars.add(v); made.nCars++; owner.set(v.group, v); }
      scene.add(v.group); carViews.set(c, v);
    }
    const x = c.x * S, z = c.y * S, d = camDist(x, v.init ? v.y : cam.y, z);
    v.group.visible = carInView(x, z, d, v.group.visible);
    if (!v.group.visible) { v.init = false; continue; }
    CARS.setCarLook(v, c, false);
    CARS.setCarLOD(v, CARS.carFar(v, d), v.cast);
    CARS.syncCar(v, c, dt, W.groundY(c.x, c.y), null, !!c.ai && !c.wreck);
  }
  for (const p of G.peds) {
    let r = pedViews.get(p);
    if (!r) { r = pedRig(p); scene.add(r.root); pedViews.set(p, r); }
    r.root.visible = CARS.personLOD(r, camDist(p.x * S, r.root.position.y, p.y * S));
    if (r.root.visible) r.root.position.set(p.x * S, W.groundY(p.x, p.y), p.y * S);
  }
}

// main3d's castCars, once the sky has moved the sun onto this frame's focus
function castCars() {
  shadowBox.update();
  for (const v of carViews.values()) {
    if (!v.group.visible) continue;
    const at = v.group.position;
    CARS.setCarLOD(v, v.lod, shadowBox.has(at.x, at.y + 0.8, at.z, v.L / 2 + 0.5));
  }
}

// ---------- checks along the way ----------

const worst = { afterPrune: -Infinity, cars: -Infinity, peds: -Infinity, pool: 0, rigPool: 0, peakCars: 0, peakPeds: 0 };
let poolBad = 0, shared = 0;
function afterPrune() {
  worst.afterPrune = Math.max(worst.afterPrune, carViews.size - G.cars.length, pedViews.size - G.peds.length);
}
function everyFrame() {
  worst.cars = Math.max(worst.cars, carViews.size - G.cars.length - gone.cars);
  worst.peds = Math.max(worst.peds, pedViews.size - G.peds.length - gone.peds);
  worst.pool = Math.max(worst.pool, carPool.size); worst.rigPool = Math.max(worst.rigPool, rigPool.size);
  worst.peakCars = Math.max(worst.peakCars, G.cars.length); worst.peakPeds = Math.max(worst.peakPeds, G.peds.length);
}
// does each shown full car cast exactly when its ball reaches into three.js's shadow frustum for this frame's
// sun (1 cm either way is left to rounding)?
const ball = new THREE.Sphere(), casts = { checked: 0, bad: 0, onJumps: 0 };
function auditCast(jumped) {
  const fr = sun.shadow.getFrustum();
  for (const v of carViews.values()) {
    if (!v.group.visible || v.lod) continue;
    ball.center.copy(v.group.position).y += 0.8;
    ball.radius = v.L / 2 + 0.5 + (v.cast ? 0.01 : -0.01);
    if (v.cast !== fr.intersectsSphere(ball)) casts.bad++;
    casts.checked++;
    if (jumped && v.cast) casts.onJumps++;
  }
}
function auditPools() {
  const inUse = new Set(carViews.values()), rigsInUse = new Set(pedViews.values());
  if (inUse.size !== carViews.size || rigsInUse.size !== pedViews.size) shared++;
  for (const v of inUse) if (v.inPool) poolBad++;
  for (const r of rigsInUse) if (r.inPool) poolBad++;
  for (const o of scene.children) if (owner.get(o)?.inPool) poolBad++;
}

// ---------- play ----------

const counted = (list, before) => before.filter((x) => !list.includes(x)).length;
let lap = 0;
await seeded(5, async () => {
  ENT.spawnWorld();
  const home = W.places.home.foot;
  Object.assign(G.player, { x: home.x, y: home.y, car: null, heading: Math.PI / 2 });
  const heap = [], frames = Math.round(MINUTES * 60 / DT);
  let nextJump = JUMP, nextTake = 5, jumped = false;
  const goal = { x: home.x, y: home.y };
  const newGoal = () => {
    const q = W.roads.randomLanePoint({ x: G.player.x, y: G.player.y, rMin: 800 * M, rMax: 1500 * M, ai: true });
    if (q) Object.assign(goal, { x: q.x, y: q.y });
  };
  for (let i = 0; i < frames; i++) {
    const t = i * DT;
    const cars0 = G.cars.slice(), peds0 = G.peds.slice();
    if (V2 && t >= nextJump) {
      // a fast-travel jump far off: everything streamed round the old spot goes, new traffic and people come
      nextJump += JUMP; lap++;
      const q = W.roads.randomLanePoint({ x: G.player.x, y: G.player.y, rMin: 600 * M, rMax: 1400 * M, ai: true });
      if (q) Object.assign(G.player, { x: q.x, y: q.y, heading: q.a });
      newGoal();
      jumped = true;
    }
    if (!V2 && t >= nextJump) {
      // a respawn at the hospital, or back home: the cars round the new spot are on show at once
      nextJump += JUMP; lap++;
      const to = lap % 2 ? W.places.hospital.foot : home;
      Object.assign(G.player, { x: to.x, y: to.y });
      jumped = true;
    }
    if (!V2 && t >= nextTake) {
      // a car and a person leave the grid (a carjack, a wreck towed, someone knocked out), to be replaced
      nextTake += 5;
      const cars = G.cars.filter((c) => c.ai && c !== G.player.car), peds = G.peds.filter((p) => !p.role);
      if (cars.length) G.cars = G.cars.filter((c) => c !== cars[Math.floor(Math.random() * cars.length)]);
      if (peds.length) G.peds = G.peds.filter((p) => p !== peds[Math.floor(Math.random() * peds.length)]);
    }
    // on v2 Kimchi drives at 30 m/s to one far goal after another (in a straight line: he is only the
    // population's and the camera's focus); on the grid he stands at the villa or the hospital
    if (V2) {
      const dx = goal.x - G.player.x, dy = goal.y - G.player.y, dl = Math.hypot(dx, dy);
      if (dl < 20 * M) newGoal();
      else { G.player.x += dx / dl * 30 * M * DT; G.player.y += dy / dl * 30 * M * DT; G.player.heading = Math.atan2(dy, dx); }
    }
    G.t += DT;
    ENT.updateWorld(DT);
    gone.cars += counted(G.cars, cars0); gone.peds += counted(G.peds, peds0);
    // the chase camera: 6 m behind and 3 m above Kimchi
    const h = G.player.heading ?? 0, gx = G.player.x * S, gz = G.player.y * S;
    cam.set(gx - Math.cos(h) * 6, W.groundY(G.player.x, G.player.y) + 3, gz - Math.sin(h) * 6);
    if (i % 2 === 0) {
      // as main3d's render(): the views synced, then the sky moves the sun onto Kimchi, then the shadows
      syncViews(2 * DT);
      D.placeSun(sun, 13 * 60, new THREE.Vector3(gx, W.groundY(G.player.x, G.player.y), gz));
      castCars();
      auditCast(jumped);
      jumped = false;
    }
    everyFrame();
    if (i % 600 === 0) auditPools();
    if (i % 3600 === 0) heap.push(heapMB());
  }
  heap.push(heapMB());

  note(`${made.nCars} car views and ${made.nRigs} rigs made for at most ${worst.peakCars} cars and ${worst.peakPeds} people at once; reused ${reused.cars} views and ${reused.rigs} rigs; ${lap} jumps`);
  note(`heap (MB, each minute): ${heap.map((x) => x.toFixed(1)).join(' ')}`);
  const st = ENT.trafficStats?.() ?? globalThis.KCSTATS?.();
  if (st) note(`traffic: ${JSON.stringify(st).slice(0, 200)}`);
  check('right after each prune: a view for each car and a rig for each person, no more', worst.afterPrune <= 0, `${worst.afterPrune} extra`);
  check('carViews.size <= cars + the cars gone since the last prune', worst.cars <= 0, `${worst.cars} over`);
  check('pedViews.size <= people + the people gone since the last prune', worst.peds <= 0, `${worst.peds} over`);
  check('each pool holds at most 40', worst.pool <= CARS.POOL_MAX && worst.rigPool <= CARS.POOL_MAX, `${worst.pool} car views, ${worst.rigPool} rigs`);
  check('nothing waiting in a pool is in use or in the scene', poolBad === 0, `${poolBad}`);
  check('no view serves two cars, no rig two people', shared === 0);
  // past the first fill, a new view is made only when the pool has none of the type (12 types share 40 places)
  const extra = (n, reuse, peak) => (n - Math.min(n, peak + CARS.POOL_MAX)) / Math.max(1, n + reuse - peak);
  check('car views: the pool serves at least 80% of the cars that come after the first fill', extra(made.nCars, reused.cars, worst.peakCars) <= 0.2,
    `${made.nCars} made, ${reused.cars} reused, peak ${worst.peakCars}`);
  check('rigs: the pool serves at least 85% of the people that come after the first fill', extra(made.nRigs, reused.rigs, worst.peakPeds) <= 0.15,
    `${made.nRigs} made, ${reused.rigs} reused, peak ${worst.peakPeds}`);
  check('the pools were used (views and rigs reused)', reused.cars > 0 && reused.rigs > 0, `${reused.cars} car views, ${reused.rigs} rigs`);
  const ref = heap[Math.min(3, heap.length - 1)], end = heap[heap.length - 1];
  check('the heap is flat (within 8 MB of minute 3 at the end)', end - ref < 8, `${ref.toFixed(1)} -> ${end.toFixed(1)} MB`);
  check('a shown full car casts exactly when it reaches into this frame\'s shadow frustum', casts.bad === 0 && casts.checked > 0,
    `${casts.bad} wrong of ${casts.checked}`);
  // (on v2 the traffic round a new spot streams in only after the jump; the grid's is there already)
  if (!V2) check('on the frame of each jump the cars round the new spot cast at once', casts.onJumps > 0, `${casts.onJumps} casting on ${lap} jump frames`);
});

done();
