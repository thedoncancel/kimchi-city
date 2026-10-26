import * as THREE from 'three';
import { G } from '../state.js';
import { CAR_TYPES } from '../data.js';
import { sightClear } from '../world.js';
import { hurtPed, damageCar, moveChar, say } from '../entities.js';
import { S, surfaceY, occluderTop } from './city.js';
import { pick, clamp } from '../util.js';
import { gunSfx } from './gunsfx.js';

// ---------- weapons ----------

export const WEAPONS = {
  fists: { name: 'Fists', icon: '👊', melee: true, dmg: 25, rate: 2.4, range: 1.9 },
  pistol: { name: 'Pistol', icon: '🔫', dmg: 36, rate: 3.2, mag: 12, reload: 1.2, range: 70, spread: 0.008, price: 4500, ammo: { price: 600, count: 48 } },
  shotgun: { name: 'Shotgun', icon: '💥', dmg: 15, pellets: 8, rate: 1.1, mag: 6, reload: 2.0, range: 32, spread: 0.055, price: 12000, ammo: { price: 900, count: 24 } },
  rifle: { name: 'Assault Rifle', icon: '🎯', dmg: 24, rate: 9, auto: true, mag: 30, reload: 1.9, range: 110, spread: 0.014, price: 28000, ammo: { price: 1500, count: 120 } },
};
export const ORDER = ['fists', 'pistol', 'shotgun', 'rifle'];
export const ARMOR_PRICE = 3500;

const st = { cool: 0, reloadT: 0, reloadFor: null, punchT: 0, recoil: 0 };
export const weaponState = st;

function refill(w) {
  const W = WEAPONS[w];
  if (!W.mag) return;
  const take = Math.min(W.mag - (G.clip[w] || 0), G.ammo[w] || 0);
  G.clip[w] = (G.clip[w] || 0) + take;
  G.ammo[w] = (G.ammo[w] || 0) - take;
}
export function giveWeapon(w, ammo = 0) {
  G.weapons[w] = true;
  G.ammo[w] = (G.ammo[w] || 0) + ammo;
  if (!(G.clip[w] > 0)) refill(w);
}
export function reload() {
  const w = G.weapon, W = WEAPONS[w];
  if (!W.mag || st.reloadT > 0 || (G.clip[w] || 0) >= W.mag || !(G.ammo[w] > 0)) return;
  st.reloadT = W.reload;
  st.reloadFor = w;
  gunSfx.reload();
}
export function selectWeapon(w) {
  if (!G.weapons[w] || G.weapon === w) return;
  G.weapon = w;
  st.reloadT = 0;
  st.cool = 0.25;
  gunSfx.swap();
}
export function cycleWeapon(dir) {
  const owned = ORDER.filter(w => G.weapons[w]);
  const i = owned.indexOf(G.weapon);
  selectWeapon(owned[(i + dir + owned.length) % owned.length]);
}

// ---------- ray casting (metres) ----------

// Where a car's body sits (m), as drawn. main3d points this at the car's view, which settles onto the ground
// smoothly; until then (and for a car with no view) it is the ground under the car.
let carViewY = (c) => surfaceY(c.x, c.y);
export function setCarViewY(fn) { carViewY = (c) => fn(c) ?? surfaceY(c.x, c.y); }

const _v = new THREE.Vector3();
function rayCylinder(o, d, cx, gy, cz, h, r) {
  const ox = o.x - cx, oz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  if (a < 1e-9) return null;
  const b = 2 * (ox * d.x + oz * d.z), c = ox * ox + oz * oz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t < 0) return null;
  const y = o.y + d.y * t;
  return y >= gy && y <= gy + h ? t : null;
}
function rayCar(o, d, c) {
  const ty = CAR_TYPES[c.type];
  const L = ty.len * S, W = ty.wid * S, H = c.type === 'van' ? 2.0 : 1.45;
  const ca = Math.cos(c.a), sa = Math.sin(c.a);
  const px = o.x - c.x * S, pz = o.z - c.y * S;
  const lo = [px * ca + pz * sa, o.y - surfaceY(c.x, c.y), -px * sa + pz * ca];
  const ld = [d.x * ca + d.z * sa, d.y, -d.x * sa + d.z * ca];
  const mn = [-L / 2, 0.2, -W / 2], mx = [L / 2, H, W / 2];
  let t0 = 0, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(ld[i]) < 1e-9) { if (lo[i] < mn[i] || lo[i] > mx[i]) return null; continue; }
    let ta = (mn[i] - lo[i]) / ld[i], tb = (mx[i] - lo[i]) / ld[i];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return t0;
}
const charHeight = (p) => (p.role === 'cop' ? 1.75 : p.h || 1.66);

// nearest thing along a ray: wall, ground, person or car
export function raycast(o, d, maxDist, { skip = null, minT = 0, includePlayer = false } = {}) {
  let best = { t: maxDist, kind: 'none' };
  for (let t = Math.max(0.3, minT); t < best.t; t += 0.35) {
    const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
    const g = surfaceY(x / S, z / S) + 0.1;   // a hand's width above the ground counts as hitting it
    if (y < g) { best = { t: d.y < 0 ? Math.max(minT, (g - o.y) / d.y) : t, kind: 'ground' }; break; }
    // the occluder top includes the ground itself, so only something a metre or more above it is a wall
    const h = occluderTop(x, z);
    if (h > g + 1 && y < h) { best = { t, kind: 'wall' }; break; }
  }
  for (const p of G.peds) {
    if (p === skip || p.state === 'down') continue;
    const t = rayCylinder(o, d, p.x * S, surfaceY(p.x, p.y), p.y * S, charHeight(p), 0.3);
    if (t !== null && t >= minT && t < best.t) best = { t, kind: 'ped', ped: p };
  }
  for (const f of G.friends) {
    if (f.inCar) continue;
    const t = rayCylinder(o, d, f.x * S, surfaceY(f.x, f.y), f.y * S, 1.65, 0.3);
    if (t !== null && t >= minT && t < best.t) best = { t, kind: 'friend', friend: f };
  }
  for (const c of G.cars) {
    if (c === skip || c === G.player.car) continue;
    if (Math.abs(c.x * S - o.x) > maxDist + 6 || Math.abs(c.y * S - o.z) > maxDist + 6) continue;
    const t = rayCar(o, d, c);
    if (t !== null && t >= minT && t < best.t) best = { t, kind: 'car', car: c };
  }
  if (includePlayer && !G.player.car) {
    const p = G.player;
    const t = rayCylinder(o, d, p.x * S, surfaceY(p.x, p.y), p.y * S, 1.7, 0.32);
    if (t !== null && t >= minT && t < best.t) best = { t, kind: 'player' };
  }
  best.point = new THREE.Vector3().copy(o).addScaledVector(d, best.t);
  best.dir = d;
  return best;
}

function spread(dir, amount) {
  return new THREE.Vector3(dir.x + (Math.random() - 0.5) * 2 * amount, dir.y + (Math.random() - 0.5) * 2 * amount,
    dir.z + (Math.random() - 0.5) * 2 * amount).normalize();
}

// ---------- damage ----------

export function damagePlayer(dmg) {
  if (G.player.dead || dmg <= 0) return;
  const soak = Math.min(G.armor, dmg * 0.75);
  G.armor -= soak;
  G.health -= dmg - soak;
  G.hurtFlash = Math.min(1, (G.hurtFlash || 0) + dmg / 40);
  if (G.health <= 0) { G.health = 0; G.player.dead = 'wasted'; }
}

function applyHit(hit, dmg, byPlayer) {
  const d = hit.dir;
  if (hit.kind === 'ped') {
    hurtPed(hit.ped, dmg, { byPlayer, knock: dmg >= 30 && Math.random() < 0.35, vx: d.x * 90, vy: d.z * 90 });
    if (hit.ped.role) hit.ped.alertT = 8;
  } else if (hit.kind === 'friend') {
    say(hit.friend, pick(['HEY! Watch it!', 'Kimchi?! Not cool!', 'Whose side are you on?!']), 2.5);
  } else if (hit.kind === 'car') {
    damageCar(hit.car, dmg * 0.35);
    if (byPlayer) { hit.car.hitByPlayer = true; if (hit.car.police) G.crime?.('cop', hit.car); }
    if (hit.car.ai) hit.car.ai.speed *= 0.5;
  } else if (hit.kind === 'player') {
    damagePlayer(dmg);
  }
}

// civilians nearby hear the shot and scatter
function panic(x, y, radiusPx) {
  let witnesses = 0;
  for (const p of G.peds) {
    if (p.role || p.state === 'down' || p.state === 'knocked') continue;
    if (Math.abs(p.x - x) < radiusPx && Math.abs(p.y - y) < radiusPx) {
      p.state = 'flee'; p.t = 5 + Math.random() * 3; witnesses++;
      if (Math.random() < 0.25) say(p, pick(['AAAH!', 'Run!!', 'Call the police!', 'Oh no oh no']), 1.6);
    }
  }
  return witnesses;
}

// ---------- the player attacking ----------

// ray: { origin, dir } from the camera through the crosshair; muzzle: where the tracer starts
export function playerFire(ray, muzzle, fx) {
  const w = G.weapon, W = WEAPONS[w];
  if (st.cool > 0 || st.reloadT > 0 || G.player.dead) return false;
  if (W.melee) { st.cool = 1 / W.rate; st.punchT = 0.28; punch(); return true; }
  if (!(G.clip[w] > 0)) {
    if (G.ammo[w] > 0) reload(); else { gunSfx.empty(); st.cool = 0.3; }
    return false;
  }
  G.clip[w]--;
  st.cool = 1 / W.rate;
  st.recoil = 1;
  gunSfx.shot(w);
  fx.muzzle(muzzle);
  for (let i = 0; i < (W.pellets || 1); i++) {
    const hit = raycast(ray.origin, spread(ray.dir, W.spread), W.range, { minT: ray.minT || 0 });
    applyHit(hit, W.dmg, true);
    fx.tracer(muzzle, hit.point);
    fx.impact(hit);
  }
  const p = G.player;
  if (panic(p.x, p.y, 520) > 0) G.crime?.('shoot');
  if (G.clip[w] === 0 && G.ammo[w] > 0) reload();
  return true;
}

function punch() {
  const p = G.player;
  gunSfx.swing();
  const fx = Math.cos(p.heading || 0), fy = Math.sin(p.heading || 0);
  let best = null, bd = Infinity;
  for (const e of G.peds) {
    if (e.state === 'down') continue;
    const dx = e.x - p.x, dy = e.y - p.y, d = Math.hypot(dx, dy);
    if (d > WEAPONS.fists.range / S || d < 1) continue;
    if ((dx * fx + dy * fy) / d < 0.35) continue;
    if (d < bd) { bd = d; best = e; }
  }
  if (best) {
    gunSfx.hit();
    hurtPed(best, WEAPONS.fists.dmg, { byPlayer: true, knock: true, vx: fx * 160, vy: fy * 160 });
  }
}

// aim assist for keyboard and touch: the closest threat (or person) in front of Kimchi
export function autoTarget(heading, maxM = 40) {
  const p = G.player;
  const fx = Math.cos(heading), fy = Math.sin(heading);
  let best = null, score = Infinity;
  for (const e of G.peds) {
    if (e.state === 'down') continue;
    const dx = e.x - p.x, dy = e.y - p.y, d = Math.hypot(dx, dy) * S;
    if (d > maxM || d < 0.5) continue;
    const cos = (dx * fx + dy * fy) / (d / S);
    if (cos < 0.82) continue;
    const s = d * (e.role ? 0.5 : 1) * (2 - cos);
    if (s < score && clearLine(p.x, p.y, e.x, e.y)) { score = s; best = e; }
  }
  return best;
}

// Can someone at (x0, y0) see someone at (x1, y1)? Eye to eye, 1.5 m above the ground at each end (metres
// above sea level, which is what the world's sightClear compares with hills and buildings).
const EYE = 1.5;
export function clearLine(x0, y0, x1, y1) {
  return sightClear(x0, y0, surfaceY(x0, y0) + EYE, x1, y1, surfaceY(x1, y1) + EYE);
}

// ---------- enemies (police on foot, gang members) ----------

export function updateHostiles(dt, fx) {
  const pl = G.player;
  const tgt = pl.car || pl;
  for (const p of G.peds) {
    if (!p.role || p.state === 'down' || p.state === 'knocked') continue;
    p.walkT += dt;
    if (p.bubble && (p.bubble.t -= dt) <= 0) p.bubble = null;
    const dx = tgt.x - p.x, dy = tgt.y - p.y, d = Math.hypot(dx, dy) || 1;
    const calm = (p.role === 'cop' && G.wanted === 0) || pl.dead;
    if (calm) {
      p.moving = false;
      if (d > 1700) p.remove = true;
      continue;
    }
    if (p.role === 'rival' && !p.aggro) {
      // gang members hang around until Kimchi comes close or shoots them
      p.moving = false;
      if (d < 420 || p.alertT > 0 || p.hp < 100) p.aggro = true;
      continue;
    }
    const shoots = p.armed && (p.role === 'rival' || G.wanted >= 2);
    const want = shoots ? 260 : 18;   // keep a shooting distance, or close in to arrest
    p.alertT = Math.max(0, (p.alertT || 0) - dt);
    if (d > want) {
      const sp = d > want * 1.6 ? 118 : 70;
      moveChar(p, dx / d * sp * dt, dy / d * sp * dt, 9);
      p.moving = true; p.running = sp > 100;
    } else { p.moving = false; p.running = false; }
    p.heading = Math.atan2(dy, dx);
    p.aiming = shoots && d < 640;
    if (p.aiming) {
      p.cool = (p.cool ?? Math.random()) - dt;
      if (p.cool <= 0 && clearLine(p.x, p.y, tgt.x, tgt.y)) {
        p.cool = 0.75 + Math.random() * 0.8;
        enemyShot(p, d * S, fx);
      }
    }
  }
}

function enemyShot(p, distM, fx) {
  const pl = G.player;
  const from = new THREE.Vector3(p.x * S, surfaceY(p.x, p.y) + 1.35, p.y * S);
  const at = pl.car ? new THREE.Vector3(pl.car.x * S, carViewY(pl.car) + 0.9, pl.car.y * S) : new THREE.Vector3(pl.x * S, surfaceY(pl.x, pl.y) + 1.1, pl.y * S);
  const moving = pl.car ? Math.hypot(pl.car.vx, pl.car.vy) * S / 25 : pl.moving ? (pl.running ? 0.22 : 0.12) : 0;
  const chance = clamp(0.62 - distM * 0.013 - moving, 0.06, 0.7);
  gunSfx.shot('enemy', distM);
  fx.muzzle(from);
  if (Math.random() < chance) {
    fx.tracer(from, at);
    if (pl.car) { damageCar(pl.car, 4); damagePlayer(2.5); } else damagePlayer(p.role === 'cop' ? 7 : 8);
  } else {
    at.x += (Math.random() - 0.5) * 2.4; at.y += (Math.random() - 0.3) * 1.2; at.z += (Math.random() - 0.5) * 2.4;
    fx.tracer(from, at);
  }
}

// ---------- cars on fire, explosions, getting run over ----------

export function updateCombat(dt, fx) {
  st.cool -= dt;
  st.punchT -= dt;
  st.recoil = Math.max(0, st.recoil - dt * 8);
  if (st.reloadT > 0 && (st.reloadT -= dt) <= 0) refill(st.reloadFor);
  G.hurtFlash = Math.max(0, (G.hurtFlash || 0) - dt * 1.5);

  for (const c of G.cars) {
    if (c.wreck) continue;
    if (c.hp <= 0 && !(c.burnT > 0)) {
      c.burnT = 4;
      if (c.ai) c.ai = null;
      if (c === G.player.car) G.notice?.('🔥 Your car is on fire! Get out!');
    }
    if (c.burnT > 0 && (c.burnT -= dt) <= 0) explode(c, fx);
  }
  if (G.cars.some(c => c.wreck && (c.wreckT -= dt) <= 0 && c !== G.player.car)) {
    G.cars = G.cars.filter(c => !(c.wreck && c.wreckT <= 0 && c !== G.player.car));
  }

  // fast cars knock Kimchi over
  const p = G.player;
  if (!p.car && !p.dead) {
    p.knockT = Math.max(0, (p.knockT || 0) - dt);
    for (const c of G.cars) {
      if (c.wreck) continue;
      const v = Math.hypot(c.vx, c.vy) || (c.ai ? c.ai.speed : 0);
      if (v < 70) continue;
      const dx = p.x - c.x, dy = p.y - c.y;
      if (dx * dx + dy * dy > 30 * 30 || p.knockT > 0) continue;
      damagePlayer(v * 0.09);
      p.knockT = 1.3;
      gunSfx.hit();
      G.shake = 8;
    }
  }
}

export function explode(c, fx) {
  c.wreck = true; c.burnT = 0; c.hp = 0; c.ai = null; c.wreckT = 45;
  c.vx *= 0.2; c.vy *= 0.2;
  const x = c.x, y = c.y;
  fx.explosion(new THREE.Vector3(x * S, surfaceY(x, y) + 0.8, y * S));
  gunSfx.boom();
  const p = G.player;
  const dp = Math.hypot(p.x - x, p.y - y) * S;
  G.shake = Math.max(G.shake, 18 - dp);
  for (const e of G.peds) {
    if (e.state === 'down') continue;
    const d = Math.hypot(e.x - x, e.y - y) * S;
    if (d < 7) hurtPed(e, 140 * (1 - d / 7), { knock: true, byPlayer: !!c.hitByPlayer, vx: (e.x - x) / (d / S + 1) * 300, vy: (e.y - y) / (d / S + 1) * 300 });
  }
  for (const o of G.cars) {
    if (o === c || o.wreck) continue;
    const d = Math.hypot(o.x - x, o.y - y) * S;
    if (d < 6.5) { damageCar(o, 75 * (1 - d / 6.5)); if (c.hitByPlayer) o.hitByPlayer = true; }
  }
  if (p.car === c) damagePlayer(400);
  else if (dp < 7.5) { damagePlayer(85 * (1 - dp / 7.5)); p.knockT = 1.3; }
  if (c.hitByPlayer) G.crime?.('explode', c);
}
