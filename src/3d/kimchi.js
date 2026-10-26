import * as THREE from 'three';
import { Builder } from './geo.js';
import { lam, part, capsule, sphere, box, cached, limb } from './people.js';
import { mulberry32 } from '../util.js';

// Kimchi, modelled after the character art: messy black hair with a heavy fringe and undercut,
// thick brows, big brown half-lidded eyes, charcoal tee, silver chain with a wing pendant,
// watch, wide black cargo pants and white sneakers.

const SKIN = '#efb88f', TEE = '#4a4252', PANTS = '#1c1c20', HAIR = '#110f12';
const HEAD_R = 0.29;

function ell(x, cx, cy, rx, ry) { x.beginPath(); x.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); x.fill(); }

// The face is painted on a texture wrapped around the head sphere; u = 0.5 is the front (+X).
function faceTexture() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 512;
  const x = c.getContext('2d');
  x.fillStyle = SKIN; x.fillRect(0, 0, 1024, 512);
  const cx = 512, ey = 284;
  for (const s of [-1, 1]) {
    const g = x.createRadialGradient(cx + s * 86, ey + 52, 2, cx + s * 86, ey + 52, 42);
    g.addColorStop(0, 'rgba(236,118,102,.45)'); g.addColorStop(1, 'rgba(236,118,102,0)');
    x.fillStyle = g; x.fillRect(cx + s * 86 - 44, ey + 8, 88, 88);
  }
  for (const s of [-1, 1]) {
    const ex = cx + s * 60;
    x.fillStyle = '#fffaf3'; ell(x, ex, ey, 33, 32);
    const g = x.createLinearGradient(0, ey - 30, 0, ey + 32);
    g.addColorStop(0, '#1c0e08'); g.addColorStop(0.6, '#4a2a19'); g.addColorStop(1, '#84522f');
    x.fillStyle = g; ell(x, ex + s, ey + 3, 26, 30);
    x.fillStyle = '#0e0705'; ell(x, ex + s, ey + 5, 12, 14);
    x.fillStyle = '#ffffff'; ell(x, ex - 9, ey - 9, 8.5, 8.5); ell(x, ex + 10, ey + 14, 4, 4);
    // thick arched upper lash line; only a sliver of lid, so the eyes stay big and round
    const ix = ex - s * 37, ox = ex + s * 38;
    x.fillStyle = SKIN;
    x.beginPath(); x.moveTo(ix, ey - 48); x.lineTo(ox, ey - 48); x.lineTo(ox, ey - 16);
    x.quadraticCurveTo(ex, ey - 40, ix, ey - 10); x.closePath(); x.fill();
    x.strokeStyle = '#140b08'; x.lineCap = 'round'; x.lineWidth = 9;
    x.beginPath(); x.moveTo(ix, ey - 10); x.quadraticCurveTo(ex, ey - 40, ox, ey - 16); x.stroke();
    x.lineWidth = 5; x.beginPath(); x.moveTo(ox - s * 4, ey - 16); x.lineTo(ox + s * 8, ey - 22); x.stroke();
    x.strokeStyle = 'rgba(70,34,22,.55)'; x.lineWidth = 3;
    x.beginPath(); x.moveTo(ex - 22, ey + 30); x.quadraticCurveTo(ex, ey + 36, ex + 22, ey + 30); x.stroke();
    // thick straight brows, a little lower toward the middle
    x.strokeStyle = '#17100d'; x.lineWidth = 16;
    x.beginPath(); x.moveTo(cx + s * 25, ey - 52); x.lineTo(cx + s * 100, ey - 63); x.stroke();
  }
  x.fillStyle = 'rgba(176,96,66,.42)'; ell(x, cx, ey + 46, 7, 4);
  x.strokeStyle = '#8f3f34'; x.lineWidth = 4.5; x.lineCap = 'round';
  x.beginPath(); x.moveTo(cx - 15, ey + 80); x.quadraticCurveTo(cx, ey + 84, cx + 15, ey + 80); x.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// spiky hair from merged cones: `crown` hides under the cap, `rest` is the fringe, sides and back
function hairGeometries() {
  const R = HEAD_R + 0.002;
  const crown = new Builder(), rest = new Builder();
  const rnd = mulberry32(42);
  const up = new THREE.Vector3(0, 1, 0), n = new THREE.Vector3(), d = new THREE.Vector3(), p = new THREE.Vector3();
  const q = new THREE.Quaternion(), m = new THREE.Matrix4(), one = new THREE.Vector3(1, 1, 1);
  const cone = (r, h) => cached(`hc${r.toFixed(3)}_${h.toFixed(3)}`, () => new THREE.ConeGeometry(r, h, 5));
  const I = new THREE.Matrix4();
  function spike(B, theta, phi, len, rad, droop, fwd = 0) {
    n.set(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta));
    d.copy(n); d.y -= droop; d.x += fwd; d.normalize();
    p.copy(n).multiplyScalar(R - 0.035).addScaledVector(d, len * 0.5);
    q.setFromUnitVectors(up, d);
    B.geo(cone(rad, len), m.compose(p, q, one));
  }
  // a full mop: puffy volume all round, a heavy fringe down to the brows, a few strands sticking up
  const front = (phi) => Math.abs(((phi - Math.PI) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
  crown.geo(new THREE.SphereGeometry(R + 0.03, 24, 10, 0, Math.PI * 2, 0, 1.05), I);
  rest.geo(new THREE.SphereGeometry(R + 0.022, 24, 10, -1.2, 2.4, 0.9, 0.85), I);
  rest.geo(new THREE.SphereGeometry(R + 0.024, 24, 6, Math.PI - 1.2, 2.4, 0.85, 0.42), I);

  for (let i = 0; i < 22; i++) spike(crown, 0.2 + rnd() * 0.7, rnd() * Math.PI * 2, 0.13 + rnd() * 0.08, 0.075 + rnd() * 0.03, 0.15 + rnd() * 0.35);
  for (let i = 0; i < 3; i++) spike(crown, 0.08 + rnd() * 0.2, rnd() * Math.PI * 2, 0.2 + rnd() * 0.05, 0.035, -0.35, 0.1);
  for (let i = 0; i < 34; i++) {
    const phi = (i / 34) * Math.PI * 2 + (rnd() - 0.5) * 0.15;
    if (front(phi) < 0.85) continue;
    spike(rest, 0.85 + rnd() * 0.3, phi, 0.15 + rnd() * 0.07, 0.08 + rnd() * 0.025, 0.35 + rnd() * 0.35);
  }
  for (let i = 0; i < 19; i++) {
    const phi = Math.PI - 1.15 + (i / 18) * 2.3 + (rnd() - 0.5) * 0.06;
    const mid = 1 - front(phi) / 1.15;
    spike(rest, 0.94 + rnd() * 0.08, phi, 0.12 + mid * 0.04 + rnd() * 0.04, 0.068 + rnd() * 0.014, 1.75, 0.3);
  }
  for (let i = 0; i < 18; i++) spike(rest, 1.2 + rnd() * 0.55, -1.1 + rnd() * 2.2, 0.13 + rnd() * 0.06, 0.07 + rnd() * 0.015, 1.15 + rnd() * 0.4);
  return [crown.build(), rest.build()];
}

export function makeKimchi() {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const skin = lam(SKIN), tee = lam(TEE), pants = lam(PANTS), pantsHi = lam('#25252a');
  const white = lam('#f4f3ef'), sole = lam('#1d1d1f');
  const silver = new THREE.MeshStandardMaterial({ color: '#e3e7ec', metalness: 0.9, roughness: 0.22 });
  const gold = new THREE.MeshStandardMaterial({ color: '#f2c230', metalness: 1, roughness: 0.25 });

  // wide-leg cargo pants with sneakers
  const hip = 0.66;
  const legGeo = cached('kLeg', () => { const g = new THREE.CylinderGeometry(0.108, 0.128, 0.56, 14); g.translate(0, -0.28, 0); return g; });
  const shoeGeo = cached('kShoe', () => { const g = new THREE.CapsuleGeometry(0.068, 0.15, 4, 10); g.rotateZ(Math.PI / 2); g.scale(1, 0.74, 1.08); return g; });
  const [legL, legR] = [-1, 1].map(s => {
    const L = new THREE.Group();
    L.position.set(0, hip, s * 0.1);
    body.add(L);
    L.add(part(legGeo, pants));
    L.add(part(box(0.15, 0.14, 0.03), pantsHi, 0.01, -0.27, s * 0.124));
    L.add(part(box(0.155, 0.022, 0.034), pantsHi, 0.01, -0.19, s * 0.125));
    L.add(part(shoeGeo, white, 0.05, -0.585, 0));
    L.add(part(box(0.29, 0.035, 0.15), sole, 0.05, -0.64, 0));
    L.add(part(box(0.05, 0.06, 0.13), sole, -0.07, -0.6, 0));
    return L;
  });

  // tee, belt
  const torso = part(capsule(0.2, 0.17), tee, 0, 0.94, 0);
  torso.scale.set(0.8, 1, 1.12);
  body.add(torso);
  const belt = part(cached('kBelt', () => new THREE.CylinderGeometry(0.185, 0.185, 0.05, 18)), lam('#121214'), 0, 0.655, 0);
  belt.scale.set(0.84, 1, 1.15);
  body.add(belt);
  body.add(part(box(0.022, 0.045, 0.07), silver, 0.158, 0.655, 0));

  // arms with short wide sleeves; watch on the left wrist
  const hands = [];
  const [armL, armR] = [-1, 1].map(s => {
    const A = limb(body, 0, 1.12, s * 0.255, 0.052, 0.25, skin);
    A.add(part(capsule(0.088, 0.07), tee, 0, -0.06, 0));
    const hand = part(sphere(0.06, 10, 8), skin, 0, -0.355, 0);
    A.add(hand);
    hands.push(hand);
    return A;
  });
  armL.add(part(cached('kWatch', () => new THREE.CylinderGeometry(0.058, 0.058, 0.05, 14)), silver, 0, -0.29, 0));
  const dial = part(cached('kDial', () => new THREE.CylinderGeometry(0.032, 0.032, 0.012, 14)), lam('#22252a'), 0, -0.29, -0.06, false);
  dial.rotation.x = Math.PI / 2;
  armL.add(dial);

  body.add(part(cached('kNeck', () => new THREE.CylinderGeometry(0.068, 0.078, 0.1, 12)), skin, 0, 1.26, 0));

  // silver chain + wing pendant
  const chainG = new THREE.Group();
  chainG.position.set(0.0, 1.22, 0);
  chainG.rotation.z = -0.78;
  const chain = part(cached('kChain', () => new THREE.TorusGeometry(0.138, 0.0055, 5, 32)), silver, 0, 0, 0, false);
  chain.rotation.x = Math.PI / 2;
  chainG.add(chain);
  body.add(chainG);
  const wing = part(cached('kWing', () => new THREE.ConeGeometry(0.03, 0.06, 3)), silver, 0.152, 1.085, 0, false);
  wing.rotation.z = Math.PI; wing.scale.set(0.45, 1, 1.4);
  body.add(wing);

  // head
  const head = new THREE.Group();
  head.position.y = 1.54;
  body.add(head);
  head.add(part(new THREE.SphereGeometry(HEAD_R, 32, 20), new THREE.MeshLambertMaterial({ map: faceTexture() })));
  for (const s of [-1, 1]) {
    const ear = part(sphere(0.075, 12, 8), skin, -0.01, -0.03, s * 0.282);
    ear.scale.set(0.55, 1, 0.38);
    head.add(ear);
  }
  const hairMat = new THREE.MeshStandardMaterial({ color: HAIR, roughness: 0.68, metalness: 0, flatShading: true });
  const [crownGeo, restGeo] = hairGeometries();
  const crown = part(crownGeo, hairMat);
  const rest = part(restGeo, hairMat);
  head.add(crown, rest);
  head.add(part(new THREE.SphereGeometry(HEAD_R + 0.001, 24, 8, Math.PI + 0.95, Math.PI * 2 - 1.9, 1.02, 0.6), lam('#4a3d3d'), 0, 0, 0, false));

  // shop gear
  const red = lam('#d6402b'), redDark = lam('#b8321f');
  const cap = new THREE.Group();
  const dome = part(new THREE.SphereGeometry(0.315, 24, 10, 0, Math.PI * 2, 0, 1.25), red);
  dome.rotation.z = 0.18;
  const brim = part(box(0.22, 0.026, 0.34), redDark, 0.3, 0.075, 0);
  brim.rotation.z = -0.22;
  cap.add(dome, brim, part(sphere(0.026, 8, 6), red, -0.05, 0.31, 0));
  cap.visible = false;
  head.add(cap);

  const shades = new THREE.Group();
  const lensMat = new THREE.MeshStandardMaterial({ color: '#0d0d10', metalness: 0.6, roughness: 0.15 });
  for (const s of [-1, 1]) {
    const lens = part(box(0.026, 0.075, 0.11), lensMat, 0.284, -0.035, s * 0.095, false);
    lens.rotation.y = -s * 0.3;
    shades.add(lens);
    shades.add(part(box(0.24, 0.014, 0.012), lensMat, 0.16, -0.02, s * 0.272, false));
  }
  shades.add(part(box(0.02, 0.014, 0.06), lensMat, 0.296, -0.012, 0, false));
  shades.visible = false;
  head.add(shades);

  const goldChain = new THREE.Group();
  goldChain.position.set(0.012, 1.2, 0);
  goldChain.rotation.z = -0.62;
  const gc = part(cached('kGold', () => new THREE.TorusGeometry(0.16, 0.016, 8, 32)), gold, 0, 0, 0, false);
  gc.rotation.x = Math.PI / 2;
  goldChain.add(gc);
  const coin = part(cached('kCoin', () => new THREE.CylinderGeometry(0.04, 0.04, 0.012, 16)), gold, 0.19, 1.07, 0, false);
  coin.rotation.z = Math.PI / 2;
  const goldG = new THREE.Group();
  goldG.add(goldChain, coin);
  goldG.visible = false;
  body.add(goldG);

  root.scale.setScalar(0.76);
  return {
    root, body, legL, legR, armL, armR, head, hands, phase: 0, heading: 0, fall: 0,
    setGear(eq) {
      cap.visible = !!eq.cap;
      crown.visible = !eq.cap;
      shades.visible = !!eq.shades;
      goldG.visible = !!eq.chain;
    },
  };
}
