import * as THREE from 'three';

// Gun models and the poses for holding them, sitting in a car, punching and surrendering.
// Models are in metres with the barrel along +Z and the top along +Y; the origin is the grip,
// which sits in the right hand. In the hand bone's frame +Z runs from the wrist to the fingers.

const METAL = new THREE.MeshStandardMaterial({ color: '#232427', metalness: 0.7, roughness: 0.35 });
const GRIP = new THREE.MeshLambertMaterial({ color: '#141414' });
const WOOD = new THREE.MeshLambertMaterial({ color: '#6b4428' });

function box(group, mat, x0, y0, z0, x1, y1, z1) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat);
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  m.castShadow = true;
  group.add(m);
  return m;
}
function tube(group, mat, r, z0, z1, y) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, z1 - z0, 10), mat);
  m.rotation.x = Math.PI / 2;
  m.position.set(0, y, (z0 + z1) / 2);
  m.castShadow = true;
  group.add(m);
  return m;
}

const MUZZLE = { pistol: [0, 0.035, 0.2], shotgun: [0, 0.045, 0.62], rifle: [0, 0.04, 0.55] };
export function makeGun(kind) {
  const g = new THREE.Group();
  if (kind === 'pistol') {
    box(g, METAL, -0.016, 0.012, -0.04, 0.016, 0.058, 0.17);     // slide
    tube(g, METAL, 0.009, 0.15, 0.2, 0.036);
    box(g, GRIP, -0.015, -0.085, -0.04, 0.015, 0.014, 0.01);      // grip
    box(g, METAL, -0.004, -0.02, 0.01, 0.004, 0.012, 0.05);       // trigger guard
  } else if (kind === 'shotgun') {
    box(g, WOOD, -0.02, -0.06, -0.38, 0.02, 0.03, -0.12);         // stock
    box(g, METAL, -0.022, 0.0, -0.13, 0.022, 0.06, 0.12);         // receiver
    tube(g, METAL, 0.013, 0.1, 0.64, 0.045);                      // barrel
    tube(g, WOOD, 0.019, 0.2, 0.42, 0.018);                       // pump
    box(g, GRIP, -0.014, -0.07, -0.08, 0.014, 0.01, -0.03);
  } else if (kind === 'rifle') {
    box(g, GRIP, -0.02, -0.06, -0.36, 0.02, 0.035, -0.12);        // stock
    box(g, METAL, -0.024, 0.0, -0.14, 0.024, 0.07, 0.2);          // body
    box(g, METAL, -0.012, 0.07, -0.08, 0.012, 0.09, 0.12);        // sight rail
    tube(g, METAL, 0.011, 0.18, 0.56, 0.04);                      // barrel
    box(g, GRIP, -0.016, -0.13, 0.0, 0.016, 0.0, 0.06).rotation.x = -0.3;  // magazine
    box(g, GRIP, -0.014, -0.075, -0.08, 0.014, 0.01, -0.03);      // grip
    box(g, METAL, -0.02, 0.0, 0.16, 0.02, 0.05, 0.36);            // handguard
  }
  g.userData.muzzle = new THREE.Vector3(...(MUZZLE[kind] || [0, 0, 0.2]));
  return g;
}

// A holder on the right hand that shows one gun at a time.
export function attachGun(rig) {
  const holder = new THREE.Group();
  const k = 1 / rig.height;
  holder.scale.setScalar(k);
  // into the palm: a little below the hand and forward from the wrist
  holder.position.set(0, -0.022 * k, 0.06 * k);
  rig.bones.handR.add(holder);
  const models = {};
  let current = null;
  rig.gun = {
    holder,
    kind: null,
    set(kind) {
      if (kind === current) return;
      if (current && models[current]) models[current].visible = false;
      current = kind;
      this.kind = kind && kind !== 'fists' ? kind : null;
      if (!this.kind) return;
      if (!models[kind]) { models[kind] = makeGun(kind); holder.add(models[kind]); }
      models[kind].visible = true;
    },
    // motion-captured hands hold a pistol palm in, thumb up (the procedural poses hold it palm down)
    palmIn(on) { holder.rotation.z = on ? -Math.PI / 2 : 0; },
    muzzle(out) {
      const m = models[current];
      if (!m) return null;
      return m.localToWorld(out.copy(m.userData.muzzle));
    },
  };
  return rig.gun;
}

// ---------- poses (applied after the walk cycle; k blends from the walk pose to this pose) ----------
// Each bone is turned toward a whole target rotation, so these work on top of the motion-captured moves
// (anim.js), which twist every joint, as well as on the simple procedural walk.

const E = new THREE.Euler(), Q = new THREE.Quaternion();
function toward(bone, x, y, z, k) {
  E.set(x, y, z, bone.rotation.order);
  bone.quaternion.slerp(Q.setFromEuler(E), k);
}

// arms forward along the aim; pitch > 0 aims up. With k = 0 it leaves the walk alone.
export function aimPose(r, k, pitch, kind) {
  if (k <= 0.001) return;
  const b = r.bones;
  const long = kind === 'rifle' || kind === 'shotgun';
  const yR = long ? Math.PI / 2 - 0.35 : Math.PI / 2, elbowR = long ? 1.1 : 0.08;
  const yL = long ? -Math.PI / 2 - 0.27 : -Math.PI / 2 - 0.5, elbowL = long ? -0.2 : -0.18;
  toward(b.armR, 0, yR, pitch, k);
  toward(b.armL, 0, yL, pitch, k);
  toward(b.foreR, 0, elbowR, 0, k);
  toward(b.foreL, 0, elbowL, 0, k);
  toward(b.handR, 0, Math.PI / 2 - yR - elbowR, 0, k);
  toward(b.handL, 0, 0, 0, k);
  toward(b.head, 0, 0, pitch * 0.6, k);
  toward(b.spine, b.spine.rotation.x, long ? -0.15 : 0, b.spine.rotation.z, k);
}

// holding a gun low while walking: bent elbow so the barrel points ahead, not into the ground
export function carryPose(r, kind, k = 1) {
  if (k <= 0.001) return;
  const b = r.bones;
  const long = kind === 'rifle' || kind === 'shotgun';
  toward(b.armR, Math.PI / 2 - 0.25, 0, 0.3, k);
  toward(b.foreR, 0, long ? 1.2 : 0.7, 0, k);
  toward(b.handR, 0, 0, 0, k);
  if (long) {
    toward(b.armL, -(Math.PI / 2 - 0.25), 0, 0.7, k);
    toward(b.foreL, 0, -1.3, 0, k);
  }
}

// a quick right jab; t runs 0..1 over the punch (for characters without motion capture)
export function punchPose(r, t) {
  const w = Math.sin(Math.min(1, t) * Math.PI);
  if (w <= 0) return;
  const b = r.bones;
  toward(b.armR, 0, Math.PI / 2 - 0.1, -0.1, w);
  toward(b.foreR, 0, 0.05, 0, w);
  toward(b.spine, b.spine.rotation.x, 0.3, b.spine.rotation.z, w);
}

// hands up for the police
export function surrenderPose(r, k = 1) {
  if (k <= 0.001) return;
  const b = r.bones;
  toward(b.armR, -(Math.PI / 2 - 0.35), 0.2, 0, k);
  toward(b.foreR, 0, 0.7, 0, k);
  toward(b.armL, Math.PI / 2 - 0.35, -0.2, 0, k);
  toward(b.foreL, 0, -0.7, 0, k);
  toward(b.handR, 0, 0, 0, k);
  toward(b.handL, 0, 0, 0, k);
}

// sitting in a car seat: driver hands on the wheel, passenger hands in the lap
export function seatPose(r, driver, steer = 0, t = 0, shin = -0.6) {
  const b = r.bones;
  b.hips.position.y = r.hipsY;
  b.spine.rotation.set(0, 0, 0.22);
  b.chest.rotation.set(0, 0, 0);
  for (const s of ['R', 'L']) {
    b['leg' + s].rotation.set(0, 0, Math.PI / 2 - 0.05);
    b['shin' + s].rotation.set(0, 0, shin);
    b['foot' + s].rotation.set(0, 0, -0.3 - shin * 0.5);
  }
  if (driver) {
    b.armR.rotation.set(0, Math.PI / 2 - 0.12, -0.18 + steer * 0.16);
    b.armL.rotation.set(0, -Math.PI / 2 + 0.12, -0.18 - steer * 0.16);
    b.foreR.rotation.set(0, 0.55, 0);
    b.foreL.rotation.set(0, -0.55, 0);
    b.head.rotation.set(0, -steer * 0.25, -0.12);
  } else {
    b.armR.rotation.set(Math.PI / 2 - 0.3, 0, 0.9);
    b.armL.rotation.set(-(Math.PI / 2 - 0.3), 0, 0.9);
    b.foreR.rotation.set(0, 0.9, 0);
    b.foreL.rotation.set(0, -0.9, 0);
    b.head.rotation.set(0, Math.sin(t * 0.4) * 0.35, -0.05);
  }
  b.handR.rotation.set(0, 0, 0);
  b.handL.rotation.set(0, 0, 0);
  b.neck.rotation.set(0, 0, 0);
  b.hips.rotation.set(0, 0, 0);
  b.hips.position.x = r.world.hips[0]; b.hips.position.z = r.world.hips[2];
}
