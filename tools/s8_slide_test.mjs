#!/usr/bin/env node
// Stage S8 check: Kimchi's car drawn in a slide (main3d.js syncMine with activities.js slidePose), driven by the
// v2 sim on the real Kimchi Key map with the slide held at 25 and 50 degrees (drawn up to 40):
//  - the whole car turns, wheels and all: the body (chassis) is never yawed against the wheels, and every wheel
//    sits inside the body's footprint;
//  - the turn is about the front axle (the nose stays on the sim's line, the tail swings out), up to the
//    drawn limit;
//  - the front wheels counter-steer down the line the car travels;
//  - on hills (the switchbacks down and up, Heights Drive), swinging ±50 degrees, no wheel floats over or sinks
//    into the ground by more than 6 cm (cars.js wheelGap) while the car is on the ground, leaving out frames
//    with a wheel right on a kerb's edge; where the tail would swing over a kerb or a bank the slide is drawn
//    smaller (main3d slideRoom), reported;
//  - a car not sliding is drawn exactly as syncCar draws it;
//  - the speedo keeps the speed along the line, not along the drawn nose.
//   node tools/s8_slide_test.mjs
// Exits 1 if any check fails.
import { src, check, section, note, done, quiet } from './s3b_env.mjs';
globalThis.KC_WORLD = 'v2';
const L = await import('./s6a_lib.mjs');
const game = await L.loadGame();
const { ent, world } = game;
if (world.KIND !== 'v2') {
  console.log('s8 slide: world-v2 is not READY, nothing to check');
  process.exit(0);
}
Object.assign(ent.CFG, L.CFG_3D);
const CARS = await import(src('src/3d/cars.js'));
const ACT = await quiet(() => import(src('src/3d/activities.js')));
const THREE = await import('three');
const { readFileSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const { M, DT } = L;
const S = 1 / M, ground = world.groundY, wrap = L.wrap;
const deg = (r) => (r * 180 / Math.PI).toFixed(1) + '°';
const cm = (m) => (m * 100).toFixed(1) + ' cm';

// main3d.js cannot load in node (it starts the renderer), so syncMine is taken from its source text
const MAIN = readFileSync(fileURLToPath(src('src/3d/main3d.js')), 'utf8');
const cut = (a, b) => { const i = MAIN.indexOf(a), j = MAIN.indexOf(b, i); if (i < 0 || j < 0) throw new Error(`main3d.js: no '${a}' .. '${b}'`); return MAIN.slice(i, j); };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const { syncMine, SLIDE_DRAW } = new Function('V2', 'clamp', 'activityState', 'slidePose', 'syncCar', 'surfaceY', 'S',
  cut('const SLIDE_DRAW', 'let pruneT') + '\nreturn { syncMine, SLIDE_DRAW };')(true, clamp, ACT.activityState, ACT.slidePose, CARS.syncCar, ground, S);

// Drive path P in a new car at `vmax` m/s with the slide held at slide(t) rad, drawing it as main3d draws
// Kimchi's car; each(c, v, vf, s) runs after the draw.
function drive(type, P, vmax, slide, each, maxT = 30) {
  const c = L.soloCar(game, type, P[0].x, P[0].y, Math.atan2(P[1].y - P[0].y, P[1].x - P[0].x), vmax * M);
  const v = CARS.makeCarView(type, '#3366cc');
  let j = 0;
  for (let t = 0; t < maxT; t += DT) {
    j = L.trackPath(P, c.x, c.y, j).j;
    if (j >= P.length - 3) break;
    const inp = L.driveAlong(c, P, Math.min(j, P.length - 2), vmax * M, 10);
    ent.updatePlayer(DT, inp);
    const s = ACT.activityState.slide = slide(t);
    CARS.setCarLook(v, c, false);
    const vf = syncMine(v, c, DT, 0, true);
    v.group.updateMatrixWorld(true);
    each(c, v, vf, s, t);
  }
  ACT.activityState.slide = 0;
}
const path = (x, z, hx, hz, ahead, off) => L.roadPath(world.roads, x * M, z * M, Math.atan2(hz - z, hx - x), 0, ahead, off);

const WP = new THREE.Vector3(), FWD = new THREE.Vector3();
// a ramp up to `to` over 0.5 s, held from there
const held = (to) => (t) => to * Math.min(1, t / 0.5);
// on hills, slide one way and the other (a 4 s swing)
const swing = (to) => (t) => to * Math.sin(t * Math.PI / 2);

section('1. a held slide on the flat (North Causeway): the whole car turns, about its front axle');
for (const [type, to] of [['bolide', 25], ['bolide', 50], ['sedan', 50], ['ursa', 50]]) {
  let yawed = 0, outside = 0, worstOut = 0, frontOff = 0, wheelOff = 0, headOff = 0, speedOff = 0, n = 0;
  drive(type, path(1235, 374, 1300, 352, 400, 5.1), 25, held(to * Math.PI / 180), (c, v, vf, s, t) => {
    if (Math.abs(v.chassis.rotation.y) > 1e-9) yawed++;
    // every wheel in the body's footprint (the chassis' own frame)
    for (const w of v.wheels) {
      w.getWorldPosition(WP);
      v.chassis.worldToLocal(WP);
      const out = Math.max(Math.abs(WP.x) - v.L / 2, Math.abs(WP.z) - v.W / 2);
      if (out > 0.01) outside++;
      worstOut = Math.max(worstOut, out);
    }
    const drawn = clamp(s, -SLIDE_DRAW, SLIDE_DRAW), a = -v.group.rotation.y;
    headOff = Math.max(headOff, Math.abs(wrap(a - c.a - drawn)));
    if (v.skidM > 0.01 || t < 0.1) return;   // (the first frames, and a skid offset while the slide ramps in)
    n++;
    // the front axle where the sim has it
    const fx = v.spots[0], g = v.group.position;
    frontOff = Math.max(frontOff, Math.hypot(g.x + Math.cos(a) * fx - (c.x * S + Math.cos(c.a) * fx), g.z + Math.sin(a) * fx - (c.y * S + Math.sin(c.a) * fx)));
    // the front wheels down the line the car travels (its heading c.a, less what the driver steers): read
    // from the wheel's axle (its own z), which its spin leaves alone
    for (const w of v.front) {
      FWD.set(0, 0, 1).transformDirection(w.matrixWorld);
      wheelOff = Math.max(wheelOff, Math.abs(wrap(Math.atan2(-FWD.x, FWD.z) - (c.a + drawn - clamp(v.steer + drawn, -0.75, 0.75)))));
    }
    const sp = Math.hypot(c.vx, c.vy) * S;
    if (sp > 5) speedOff = Math.max(speedOff, Math.abs(vf - sp) / sp);
  });
  const name = `${type} at ${to}°`;
  check(`${name}: the body is never yawed against its wheels`, yawed === 0, `${yawed} frames`);
  check(`${name}: every wheel inside the body's footprint`, outside === 0, `worst ${cm(worstOut)} past its edge`);
  check(`${name}: drawn turned by the slide, up to ${deg(SLIDE_DRAW)}`, headOff < 0.02, `off by ${deg(headOff)} at worst`);
  check(`${name}: the front axle stays on the sim's line`, frontOff < 0.05, cm(frontOff));
  check(`${name}: the front wheels counter-steer down the line it travels`, wheelOff < 0.08, `off by ${deg(wheelOff)}`);
  check(`${name}: the speedo reads the speed along the line`, speedOff < 0.05, `${(speedOff * 100).toFixed(1)}% off`);
  if (!n) check(`${name}: frames measured`, false);
}

section('2. sliding on hills: the wheels stay on the ground (cars.js wheelGap)');
const GAP = [0, 0, 0, 0];
for (const [name, P, vmax] of [
  ['switchbacks down', path(378, 312, 362, 326, 640, 1.8), 18],
  ['switchbacks up', path(384, 588, 376, 565, 640, 1.8), 18],
  ['Heights Drive down', path(390, 291, 420, 287, 320, 1.8), 22],
]) {
  let worst = 0, frames = 0, grounded = 0, kerbs = 0, kerbWorst = 0, smaller = 0;
  drive('bolide', P, vmax, swing(50 * Math.PI / 180), (c, v, vf, s) => {
    frames++;
    if (Math.abs(wrap(-v.group.rotation.y - c.a)) < Math.min(Math.abs(s), SLIDE_DRAW) - 0.01) smaller++;
    if (v.free) return;
    grounded++;
    const g = CARS.wheelGap(v, ground, GAP);
    // a wheel standing on a kerb's edge (the ground within 25 cm of it steps by more than 8 cm) is half on, half
    // off, as any wheel there is: those frames are counted apart
    if (v.wheels.some(w => kerbEdge(w))) {
      kerbs++;
      if (Math.abs(g) > Math.abs(kerbWorst)) kerbWorst = g;
      return;
    }
    if (Math.abs(g) > Math.abs(worst)) worst = g;
  });
  check(`${name}, sliding ±50°: no wheel more than 6 cm off the ground`, Math.abs(worst) <= 0.06 && grounded > 60, `worst ${cm(worst)} over ${grounded - kerbs}/${frames} frames`);
  note(`${name}: drawn smaller than the slide (tail by a kerb or bank) on ${smaller} frames; ${kerbs} frames with a wheel on a kerb's edge${kerbs ? `, worst ${cm(kerbWorst)}` : ''}`);
}
function kerbEdge(w) {
  w.getWorldPosition(WP);
  const x = WP.x * M, z = WP.z * M, r = 0.25 * M;
  const h = [ground(x, z), ground(x + r, z), ground(x - r, z), ground(x, z + r), ground(x, z - r)];
  return Math.max(...h) - Math.min(...h) > 0.08;
}

section('3. no slide: the car is drawn exactly as syncCar draws it')
{
  const P = path(1235, 374, 1300, 352, 200, 5.1);
  const a = L.soloCar(game, 'sedan', P[0].x, P[0].y, Math.atan2(P[1].y - P[0].y, P[1].x - P[0].x), 20 * M);
  const v1 = CARS.makeCarView('sedan', '#123456'), v2 = CARS.makeCarView('sedan', '#123456');
  ACT.activityState.slide = 0;
  let same = true;
  for (let f = 0; f < 120; f++) {
    ent.updatePlayer(DT, L.driveAlong(a, P, 0, 20 * M, 10));
    const r1 = syncMine(v1, a, DT, 0, true), r2 = CARS.syncCar(v2, a, DT, ground, 0, true);
    if (r1 !== r2 || !v1.group.position.equals(v2.group.position) || !v1.group.rotation.equals(v2.group.rotation)) same = false;
  }
  check('a car not sliding is drawn as syncCar draws it', same);
}
note('(the slide itself, how far a car slides in a bend, is activities.js slide(), checked in tools/s8_test.mjs)');
done();
