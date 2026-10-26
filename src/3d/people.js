import * as THREE from 'three';

// Chibi characters built from primitives. Every character shares the same rig layout
// (root > body > legs/arms/head) so one animation function drives pedestrians, friends and Kimchi.

const geoCache = new Map();
export const cached = (key, make) => { let g = geoCache.get(key); if (!g) { g = make(); geoCache.set(key, g); } return g; };
const matCache = new Map();
export function lam(color, extra = null) {
  const key = color + (extra ? JSON.stringify(extra) : '');
  let m = matCache.get(key);
  if (!m) { m = new THREE.MeshLambertMaterial({ color, ...extra }); matCache.set(key, m); }
  return m;
}
export const capsule = (r, len) => cached(`cap${r}_${len}`, () => new THREE.CapsuleGeometry(r, len, 4, 10));
export const sphere = (r, w = 16, h = 12) => cached(`sph${r}_${w}_${h}`, () => new THREE.SphereGeometry(r, w, h));
export const box = (x, y, z) => cached(`box${x}_${y}_${z}`, () => new THREE.BoxGeometry(x, y, z));

export function part(geo, mat, x = 0, y = 0, z = 0, shadow = true) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  return m;
}

// a limb hanging from a pivot group; rotate the pivot to swing it
export function limb(parent, x, y, z, r, len, mat) {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, z);
  parent.add(pivot);
  pivot.add(part(capsule(r, len), mat, 0, -(len / 2 + r * 0.55), 0));
  return pivot;
}

const SHOES = ['#f2efe8', '#2a2a2a', '#d6402b', '#3b7dd8', '#f2efe8'];

export function makePerson(look, { scale = 1 } = {}) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const skin = lam(look.skin), shirt = lam(look.shirt), pants = lam(look.pants), hairM = lam(look.hair);
  const shoeM = lam(look.shoes || SHOES[Math.abs(look.skin.charCodeAt(2) + look.shirt.charCodeAt(3)) % SHOES.length]);

  const legL = limb(body, 0, 0.5, -0.085, 0.072, 0.3, pants);
  const legR = limb(body, 0, 0.5, 0.085, 0.072, 0.3, pants);
  for (const leg of [legL, legR]) leg.add(part(box(0.2, 0.08, 0.12), shoeM, 0.03, -0.46, 0));

  const torso = part(capsule(0.16, 0.16), shirt, 0, 0.73, 0);
  torso.scale.set(0.82, 1, 1.12);
  body.add(torso);

  const armL = limb(body, 0, 0.93, -0.205, 0.05, 0.22, skin);
  const armR = limb(body, 0, 0.93, 0.205, 0.05, 0.22, skin);
  for (const arm of [armL, armR]) arm.add(part(capsule(0.066, 0.05), shirt, 0, -0.05, 0));

  const head = new THREE.Group();
  head.position.set(0, 1.17, 0);
  body.add(head);
  head.add(part(sphere(0.24, 20, 14), skin));
  const cap = part(cached('hairCap', () => new THREE.SphereGeometry(0.255, 20, 12, 0, Math.PI * 2, 0, 1.3)), hairM);
  cap.rotation.z = 0.32;
  head.add(cap);
  if (look.long) {
    head.add(part(box(0.12, 0.34, 0.44), hairM, -0.15, -0.12, 0));
    for (const s of [-1, 1]) head.add(part(box(0.1, 0.24, 0.07), hairM, 0.03, -0.12, s * 0.21));
  }
  if (look.bun) head.add(part(sphere(0.1, 10, 8), hairM, -0.18, 0.2, 0));

  const eye = lam('#1b1512'), shine = lam('#ffffff'), blush = lam('#f29a92');
  for (const s of [-1, 1]) {
    const e = part(sphere(0.034, 10, 8), eye, 0.212, -0.01, s * 0.085, false);
    e.scale.set(0.45, 1.25, 1);
    head.add(e);
    head.add(part(sphere(0.011, 6, 4), shine, 0.228, 0.012, s * 0.078, false));
    const b = part(sphere(0.03, 8, 6), blush, 0.192, -0.07, s * 0.13, false);
    b.scale.set(0.3, 0.6, 1);
    head.add(b);
  }
  head.add(part(box(0.01, 0.012, 0.05), lam('#8a3c32'), 0.226, -0.085, 0, false));

  root.scale.setScalar(scale);
  return { root, body, legL, legR, armL, armR, head, hands: [], phase: Math.random() * 6, heading: 0, fall: 0 };
}

const lerpA = (cur, target, k) => cur + (target - cur) * k;

// speed in m/s; pose 'pockets' tucks the hands away when idle (Kimchi's signature look)
export function animateRig(r, dt, { speed = 0, run = false, air = 0, pose = 'normal', t = 0, wave = 0 } = {}) {
  const moving = speed > 0.25;
  r.phase += dt * (moving ? 3.2 + speed * 1.45 : 0);
  const s = Math.sin(r.phase);
  const amp = moving ? Math.min(1.05, 0.32 + speed * 0.1) : 0;
  const k = 1 - Math.exp(-dt * 14);

  let lL = s * amp, lR = -s * amp;
  if (air > 0) { lL = 0.65; lR = -0.25; }
  r.legL.rotation.z = lerpA(r.legL.rotation.z, lL, k);
  r.legR.rotation.z = lerpA(r.legR.rotation.z, lR, k);

  let aL = -s * amp * 0.95, aR = s * amp * 0.95, abL = 0.1, abR = -0.1;
  const pockets = !moving && air === 0 && pose === 'pockets';
  if (pockets) { aL = 0.1; aR = 0.1; abL = 0.3; abR = -0.3; }
  if (air > 0) { aL = -1.2; aR = -1.0; abL = 0.5; abR = -0.5; }
  if (wave > 0) { aR = -2.6 + Math.sin(t * 14) * 0.35; abR = -0.4; }
  r.armL.rotation.z = lerpA(r.armL.rotation.z, aL, k);
  r.armR.rotation.z = lerpA(r.armR.rotation.z, aR, k);
  r.armL.rotation.x = lerpA(r.armL.rotation.x, abL, k);
  r.armR.rotation.x = lerpA(r.armR.rotation.x, abR, k);
  for (const h of r.hands) h.visible = !pockets;

  const bob = moving ? Math.abs(Math.cos(r.phase)) * 0.05 * Math.min(1, speed / 3) : Math.sin(t * 2.3 + r.phase) * 0.006;
  r.body.position.y = lerpA(r.body.position.y, bob, 0.5);
  r.body.rotation.z = lerpA(r.body.rotation.z, run ? -0.22 : moving ? -0.06 : 0, k);
  r.body.rotation.y = moving ? s * 0.08 * amp : lerpA(r.body.rotation.y, 0, k);
  r.head.rotation.z = lerpA(r.head.rotation.z, run ? 0.12 : 0, k);
  r.head.rotation.y = moving ? 0 : Math.sin(t * 0.6 + r.phase * 3) * 0.25;
}
