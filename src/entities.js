import { G } from './state.js';
import { BOUNDS, ROAD, BUILD, WATER, PHYS, PX_PER_M, tileAtPx, surfaceAt, blockedPx, blockedCarPx, blockedFootPx, wallNormalPx,
  groundY, gripAt, places, buildings, roads } from './world.js';
import { CURB } from './map/raster.js';
import { CAR_TYPES, FRIENDS, FAN_LINES, PED_LINES, SCARED_LINES, HIT_LINES, CARJACK_LINES } from './data.js';
import { clamp, angDiff, roundRect, circle, ellipse, pick } from './util.js';
import { sfx } from './audio.js';
import { toast } from './ui.js';
import { updateTraffic, trafficStats, resetTrafficStats } from './sim/traffic.js';
import { walkPed, canPause } from './sim/peds.js';
import { makeCar, makePed, randLook, respawnPed, spawnPopulation, updatePopulation, carOverlap } from './sim/population.js';

// Traffic, pedestrians and the population live in src/sim (docs/map-v2-spec.md §9); the factories and
// respawnPed moved there and are still exported from here under their old names.
export { makeCar, makePed, randLook, respawnPed };

export const sprite = new Image();
sprite.src = 'assets/kimchi.png';

const DIRV = [[1, 0], [0, 1], [-1, 0], [0, -1]];

export const say = (e, text, t = 2.2) => { e.bubble = { text, t }; };
// crimes are reported here; the 3D game's police system sets G.crime
const crime = (kind, who) => { if (G.crime) G.crime(kind, who); };

// Movement tuning in sim pixels per second. The 3D view overrides these to match human scale.
// gripG is the most sideways g a car pulls (0 = no cap, the classic feel) and airG scales gravity in the air;
// both start from the world's PHYS (docs/map-v2-spec.md §10).
export const CFG = {
  walk: 135, run: 230, tired: 85, playerR: 12,
  pedWalk: 42, pedFlee: 150, friendWalk: 40, friendRun: 240,
  aiLook: 100, carAcc: 1, carMax: 1,
  gripG: PHYS?.gripG || 0, airG: 1,
};

// Hurts a pedestrian. Returns true if they go down. Friends never take damage.
export function hurtPed(p, dmg, o = {}) {
  if (p.state === 'down' || p.dying) return false;
  p.hp = (p.hp ?? 100) - dmg;
  if (o.vx !== undefined) { p.vx = o.vx; p.vy = o.vy; }
  if (p.hp <= 0) {
    p.state = 'knocked'; p.t = 1.0; p.spin = 0; p.dying = true;
    if (o.byPlayer) { G.stats.takedowns = (G.stats.takedowns || 0) + 1; crime(p.role === 'cop' ? 'copkill' : 'kill', p); }
    return true;
  }
  if (o.knock) { p.state = 'knocked'; p.t = 0.9; p.spin = 0; }
  else if (!p.role) { p.state = 'flee'; p.t = 4; }
  if (o.byPlayer) crime(p.role === 'cop' ? 'cop' : 'assault', p);
  return false;
}

export function damageCar(c, dmg) {
  if (c.wreck || c.locked) return;
  c.hp = (c.hp ?? 100) - dmg;
}

// A new game's world: the parked cars, the dealer's display, the traffic in its lanes and the people on
// the sidewalks come from the population (src/sim/population.js); the friends wait at their hangouts.
export function spawnWorld() {
  spawnPopulation();
  G.friends = []; G.ownedCar = null;
  resetTrafficStats();

  // each friend hangs out at their home place's hangout spot (a copy, so the place's own stays put)
  for (const def of FRIENDS) {
    const h = places[def.home].hangout;
    const spot = { x: h.x, y: h.y };
    G.friends.push({ def, look: def.look, x: spot.x, y: spot.y, spot, tx: spot.x, ty: spot.y, wanderT: 0,
      following: false, inCar: false, walkT: 0, face: -1, moving: false, bubble: null, greetCd: 0, scale: 1.08 });
  }
}

// Every car Kimchi owns waits on the villa's drive (the one he is driving stays with him).
export function spawnGarage() {
  const spots = places.home.garage || [places.home.spawn];
  const driving = G.player.car;
  G.cars = G.cars.filter(c => c === driving || (!c.owned && !spots.some(s => Math.hypot(c.x - s.x, c.y - s.y) < 70)));
  const types = [...new Set(G.owned)].filter(t => !(driving && driving.owned && driving.type === t)).slice(-spots.length);
  types.forEach((type, i) => {
    const s = spots[i];
    const c = makeCar(type, s.x, s.y, s.a, G.paint?.[type]);
    c.owned = true;
    G.cars.push(c);
  });
  G.ownedCar = (driving && driving.owned) ? driving : G.cars.find(c => c.owned) || null;
}
export function spawnOwnedCar(type) {
  spawnGarage();
  return G.cars.find(c => c.owned && c.type === type) || null;
}

// ---------- collision helpers ----------
// People ask blockedFootPx and cars blockedCarPx: on the grid both are blockedPx; on v2 a bollard line
// stops cars but not people, and the pier is for people only.

export function circleBlocked(x, y, r) {
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    if (blockedFootPx(x + Math.cos(a) * r, y + Math.sin(a) * r)) return true;
  }
  return false;
}

export function moveChar(e, dx, dy, r = 11) {
  if (!circleBlocked(e.x + dx, e.y - 4, r)) e.x += dx;
  if (!circleBlocked(e.x, e.y + dy - 4, r)) e.y += dy;
}

function pushOutOfCars(e, r, skip) {
  for (const c of G.cars) {
    if (c === skip) continue;
    const dx = e.x - c.x, dy = (e.y - 4) - c.y;
    if (dx * dx + dy * dy > 8100) continue;
    const ty = CAR_TYPES[c.type];
    const ca = Math.cos(c.a), sa = Math.sin(c.a);
    let u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
    const hl = ty.len / 2 + r, hw = ty.wid / 2 + r;
    if (Math.abs(u) < hl && Math.abs(v) < hw) {
      if (hl - Math.abs(u) < hw - Math.abs(v)) u = Math.sign(u || 1) * hl;
      else v = Math.sign(v || 1) * hw;
      const nx = c.x + u * ca - v * sa, ny = c.y + u * sa + v * ca + 4;
      if (!circleBlocked(nx, ny - 4, r)) { e.x = nx; e.y = ny; }
    }
  }
}

// The car's body test: 8 points just inside its outline (corners and mid-sides).
const BODY = [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
export function carHits(c, x, y, a) {
  const ty = CAR_TYPES[c.type];
  const hl = ty.len / 2 - 2, hw = ty.wid / 2 - 2;
  const ca = Math.cos(a), sa = Math.sin(a);
  for (const [ku, kv] of BODY) {
    const u = ku * hl, v = kv * hw;
    if (blockedCarPx(x + u * ca - v * sa, y + u * sa + v * ca)) return true;
  }
  return false;
}

// Where the body of car c at (x, y, a) touches something: the mean of its blocked body points, in out, or null.
function contactAt(c, x, y, a, out) {
  const ty = CAR_TYPES[c.type];
  const hl = ty.len / 2 - 2, hw = ty.wid / 2 - 2;
  const ca = Math.cos(a), sa = Math.sin(a);
  let n = 0, sx = 0, sy = 0;
  for (const [ku, kv] of BODY) {
    const u = ku * hl, v = kv * hw, px = x + u * ca - v * sa, py = y + u * sa + v * ca;
    if (blockedCarPx(px, py)) { sx += px; sy += py; n++; }
  }
  if (!n) return null;
  out.x = sx / n; out.y = sy / n;
  return out;
}

// ---------- driving physics (docs/map-v2-spec.md §10) ----------
// The world's PHYS decides how cars drive. The classic grid (gripG 0, flat, no air, walls blocked per axis)
// runs exactly the code it always has. v2 adds a lateral-g cap on the yaw rate, the surface grip table, a
// slope term, real airtime (c.gy height m, c.vh vertical speed m/s, c.air seconds in the air) and sliding
// along wall normals in substeps of 0.5 m or less.
const M = PX_PER_M;
const GPX = 9.81 * M;          // one g in px/s²
const HANDBRAKE_G = 1.35;      // the handbrake lets the car turn this much harder
const SLOPE_K = 0.6;           // share of gravity along a slope that reaches the wheels
const HOLD_V = 0.5 * M;        // below this, with no pedal pressed, a car on a slope stays put (px/s)
const BANK_MAX = 0.15;         // the most a bank (tan) adds to or takes from the sideways grip
const TAKEOFF = 0.15;          // m: the ground falling away this far below the car's path is airtime
const SNAP_Y = 4;              // m: a grounded car this far off the ground was moved there, so it is set down
const REST = 0.15;             // restitution of a wall hit: the speed into the wall comes back out at this share
const SCRAPE = 0.98;           // a wall hit keeps this much of the speed along the wall ...
const WALL_MU = 0.3;           // ... less for a light scrape: friction on the push the wall gives (Coulomb)
const PUSH = 0.5 * M;          // the furthest a wall pushes a car out along its normal
const ALIGN_MAX = Math.SQRT1_2; // a wall turns the nose along it when it meets it within 45° ...
const ALIGN_V = 3 * M;         // ... and the car slides along it faster than 3 m/s (px/s) ...
const ALIGN_R = 3 * M;         // ... at (speed along the wall - 3 m/s) / 3 m rad/s ...
const ALIGN_W = 4;             // ... and never faster than 4 rad/s (3.8° a frame at 60 fps) ...
const ALIGN_T = 0.5;           // ... for at most 0.5 s after the hit
const WB = 3 * M;              // the wheelbase the grounded climb is measured over (px)
const MAX_SUB = 24;
const WN = { x: 0, y: 0 }, RN = { x: 0, y: 0 }, CP = { x: 0, y: 0 }, SL = { grade: 0, bank: 0 };

// The height the wheels ride at (m): the ground without the curb lip, so a kerb is a bump the suspension
// takes, not a ramp to launch from or a ledge to fall off.
const rideY = (x, y) => groundY(x, y) - (CURB[surfaceAt(x, y)] || 0);

// The grade along heading (fx, fy) and the bank toward the car's right (both rise over run): the ride height
// 1.5 m ahead against 1.5 m behind, and 1 m left against 1 m right.
function slopeAt(c, fx, fy) {
  const d = 1.5 * M, w = M;
  SL.grade = (rideY(c.x + fx * d, c.y + fy * d) - rideY(c.x - fx * d, c.y - fy * d)) / 3;
  SL.bank = (rideY(c.x + fy * w, c.y - fx * w) - rideY(c.x - fy * w, c.y + fx * w)) / 2;
  return SL;
}

// The yaw rate is capped so the sideways acceleration (rate x speed) stays within gripG, x1.35 on the
// handbrake, plus a bank leaning into the turn (the advisory speeds on the signs use the same sum).
function capYaw(c, turn, dt, handbrake, bank) {
  const v = Math.hypot(c.vx, c.vy);
  if (v < 1 || turn === 0) return turn;
  const g = CFG.gripG * (handbrake ? HANDBRAKE_G : 1) + clamp(turn > 0 ? bank : -bank, -BANK_MAX, BANK_MAX);
  const lim = Math.max(0, g) * GPX / v * dt;
  return clamp(turn, -lim, lim);
}

// The wall's normal at a contact point (unit, pointing out of the wall), in out, or null. wallNormalPx says
// whether there is a wall within 2 m; the direction is taken from every car-blocked metre within 4 m,
// weighted evenly, because the 1 m raster turns a slanted barrier into a staircase and the nearest few
// cells alone (wallNormalPx weights them by 1/d²) can point up to 45° off at a step.
const NR = 4;
function wallNormal(x, y, out) {
  if (!wallNormalPx(x, y, out)) return null;
  let nx = 0, ny = 0;
  for (let j = -NR; j <= NR; j++) for (let i = -NR; i <= NR; i++) {
    if (i * i + j * j > NR * NR) continue;
    if (blockedCarPx(x + i * M, y + j * M)) { nx -= i; ny -= j; }
  }
  const l = Math.hypot(nx, ny);
  if (l < 1e-9) return out;
  out.x = nx / l; out.y = ny / l;
  return out;
}

// The line a wall really runs along, for turning a car's nose to it. Even 4 m of cells is short of a
// shallow staircase's 15 m steps, so near a step the cells' normal (nx, ny) still leans up to ~10° off,
// which is right for sliding the car over the step but would aim it out across the road. A barrier inside a
// road's corridor (a bridge's edge, a guardrail, a median) runs with the road, so there, when the cells
// agree within 25°, the road's own normal goes in out. Null when there is no such road.
const ROAD_SNAP = Math.cos(25 * Math.PI / 180), EDGE_REACH = 2 * M;
function roadNormal(x, y, nx, ny, out) {
  const q = roads?.nearest?.(x, y, { maxD: 40 * M }), e = q && roads.edges[q.edge];
  if (!e || q.d > e.halfW + EDGE_REACH) return null;
  const tx = e.tx[q.i], ty = e.ty[q.i], d = ty * nx - tx * ny;      // the road's normal (ty, -tx) against the cells'
  if (Math.abs(d) < ROAD_SNAP) return null;
  const s = Math.sign(d);
  out.x = ty * s; out.y = -tx * s;
  return out;
}

// A car turned or knocked into a wall is pushed out along the wall's normal, up to 0.5 m. False if that
// does not free it (or the wall has no normal).
function pushOut(c) {
  const p = contactAt(c, c.x, c.y, c.a, CP);
  if (!p) return true;
  const n = wallNormal(p.x, p.y, WN);
  if (!n) return false;
  for (let d = 2; d <= PUSH; d += 2) {
    if (!carHits(c, c.x + n.x * d, c.y + n.y * d, c.a)) { c.x += n.x * d; c.y += n.y * d; return true; }
  }
  return false;
}

// A hit costs hp and shakes the camera by the speed that went into it.
function hitWall(c, impact, isPlayer) {
  if (impact > 140) damageCar(c, (impact - 140) * 0.08);
  if (isPlayer && impact > 120) { sfx.bump(); G.shake = Math.min(14, impact / 35); }
}

// The classic wall: a blocked move slides along whichever axis is free and bounces off the other.
function axisStep(c, nx, ny, isPlayer) {
  const impact = Math.hypot(c.vx, c.vy);
  if (!carHits(c, nx, c.y, c.a)) { c.x = nx; c.vy *= -0.25; }
  else if (!carHits(c, c.x, ny, c.a)) { c.y = ny; c.vx *= -0.25; }
  else { c.vx *= -0.3; c.vy *= -0.3; }
  hitWall(c, impact, isPlayer);
}

// A wall met within 45° swings the nose round to run along it, so a car that meets a barrier at a shallow
// angle slides along it instead of grinding back into it every frame. The hit starts a turn, not a snap: over
// the next substeps (turnFromWall) the nose swings toward the line of the wall with normal (nx, ny) at a
// rate that grows with the speed along the wall (vt, px/s) past 3 m/s, at most 4 rad/s. So a car nudged
// into a wall while parking is not turned at all, and the 3D car, which shows c.a as it is, never jumps.
function alignToWall(c, nx, ny, vt) {
  const w = clamp((vt - ALIGN_V) / ALIGN_R, 0, ALIGN_W);
  const fx = Math.cos(c.a), fy = Math.sin(c.a), d = fx * nx + fy * ny;
  if (Math.abs(d) > ALIGN_MAX || !w) return;
  const a = Math.atan2(fy - d * ny, fx - d * nx), t = c.wallTurn || (c.wallTurn = { a: 0, s: 0, w: 0, t: 0 });
  t.a = a; t.s = Math.sign(angDiff(c.a, a)); t.w = w; t.t = ALIGN_T;
}

// One substep (h s) of the turn a wall hit started: toward the wall's direction at its rate, until the nose
// runs along it, the driver has turned it past that, or the time is up. A turn that would put the car into
// the wall pushes it out along the wall's normal, or ends there.
function turnFromWall(c, h) {
  const t = c.wallTurn;
  if (!t || !(t.t > 0)) return;
  t.t -= h;
  const diff = angDiff(c.a, t.a);
  if (Math.sign(diff) !== t.s) { t.t = 0; return; }
  const a0 = c.a;
  c.a += clamp(diff, -t.w * h, t.w * h);
  if (carHits(c, c.x, c.y, c.a) && !pushOut(c)) { c.a = a0; t.t = 0; }
}

// One substep of a v2 move: on contact the speed into the wall goes (restitution .15), the speed along it
// stays (x.98 for a hit, less for a scrape) and damage and shake come from the speed into the wall only:
// into its real line where it is a barrier along a road (roadNormal), so the steps the raster draws it with
// are not hits. The car then slides on, eased out along the cells' normal by up to 0.5 m where the wall's
// 1 m cells step in its way (a barrier at a slant is a staircase on the raster).
function slideStep(c, h, isPlayer) {
  const nx = c.x + c.vx * h, ny = c.y + c.vy * h;
  if (!carHits(c, nx, ny, c.a)) { c.x = nx; c.y = ny; return; }
  const p = contactAt(c, nx, ny, c.a, CP), n = p && wallNormal(p.x, p.y, WN);
  if (!n) { axisStep(c, nx, ny, isPlayer); return; }
  const ox = n.x, oy = n.y;
  const vn = c.vx * ox + c.vy * oy;
  if (vn < 0) {
    const r = roadNormal(p.x, p.y, ox, oy, RN), into = r ? Math.max(0, -(c.vx * r.x + c.vy * r.y)) : -vn;
    const tx = c.vx - vn * ox, ty = c.vy - vn * oy, vt = Math.hypot(tx, ty);
    const keep = 1 - Math.min(1 - SCRAPE, WALL_MU * (1 + REST) * -vn / Math.max(vt, 1));
    c.vx = tx * keep - REST * vn * ox;
    c.vy = ty * keep - REST * vn * oy;
    hitWall(c, into, isPlayer);
    alignToWall(c, r ? r.x : ox, r ? r.y : oy, vt);
  }
  for (let d = 0; d <= PUSH; d += 2) {
    const mx = c.x + c.vx * h + ox * d, my = c.y + c.vy * h + oy * d;
    if (!carHits(c, mx, my, c.a)) { c.x = mx; c.y = my; return; }
  }
}

// How fast the ground under car c rises along its velocity (m/s): the grade over the last wheelbase it has
// rolled (or over what it has rolled since it landed, c.roll px, at least this substep's move h s). Over a
// wheelbase the 2 m height grid's kinks and its few cm of ripple even out, as a suspension would take them,
// while a jump's 10 m ramp still launches the car at the ramp's full grade.
function climbAt(c, h) {
  const v = Math.hypot(c.vx, c.vy);
  if (v < 1) return 0;
  const w = clamp(c.roll || 0, v * h, WB);
  return (rideY(c.x, c.y) - rideY(c.x - c.vx / v * w, c.y - c.vy / v * w)) / w * v;
}

// Airtime. The car is a body the ground holds up: each substep gravity pulls it down and the ground pushes it
// back up to the ride height, so on the ground it rises and falls with the road (c.vh is the road's climb
// along the car's velocity, so a shove sideways off a wall is not a launch). Where the ground falls away
// more than 0.15 m below its path (a jump's lip, a sharp crest at speed) it is in the air (c.air counts the
// seconds) until it comes down.
function airStep(c, h, isPlayer) {
  const g = rideY(c.x, c.y), v = Math.hypot(c.vx, c.vy), vmax = 0.3 * v / M + 1;
  if (!(c.gy > -1e9) || (!(c.air > 0) && Math.abs(c.gy - g) > SNAP_Y)) {
    // a car new to the physics (just made, carjacked, moved by a script) starts on the ground, moving with it
    c.gy = g; c.air = 0; c.roll = WB; c.vh = clamp(climbAt(c, h), -vmax, vmax);
    return;
  }
  c.vh -= CFG.airG * 9.81 * h;
  c.gy += c.vh * h;
  if (c.gy <= g) {
    if (c.air > 0) { land(c, isPlayer); c.roll = 0; }
    c.gy = g; c.air = 0; c.vh = clamp(climbAt(c, h), -vmax, vmax);
    c.roll = Math.min(WB, (c.roll || 0) + v * h);
  } else if (c.air > 0 || c.gy - g > TAKEOFF) c.air += h;
}

// Touchdown: the suspension squashes by the landing speed (c.squash 0..1 for the car's view, easing back),
// and a hard landing thumps.
function land(c, isPlayer) {
  const v = -c.vh;
  c.squash = Math.min(1, Math.max(c.squash || 0, v / 8));
  if (isPlayer && v > 4) { sfx.bump(); G.shake = Math.min(10, v * 1.2); }
}

// `driven` cars (the player's, police, mission drivers) keep their momentum; others coast to a stop
export function moveCar(c, dt, driven = c === G.player.car) {
  const isPlayer = c === G.player.car;
  if (!driven && !(c.air > 0)) {
    const damp = Math.pow(0.08, dt);
    c.vx *= damp; c.vy *= damp;
    if (Math.abs(c.vx) < 1 && Math.abs(c.vy) < 1) { c.vx = c.vy = 0; return; }
  }
  if (PHYS.wall === 'normal' || PHYS.air) { moveSteps(c, dt, isPlayer); return; }
  const nx = c.x + c.vx * dt, ny = c.y + c.vy * dt;
  if (!carHits(c, nx, ny, c.a)) { c.x = nx; c.y = ny; return; }
  axisStep(c, nx, ny, isPlayer);
}

// The v2 move: substeps of at most PHYS.substepPx (0.5 m), each sliding along walls and riding the ground.
function moveSteps(c, dt, isPlayer) {
  const v = Math.hypot(c.vx, c.vy);
  const n = Math.min(MAX_SUB, Math.max(1, Math.ceil(v * dt / (PHYS.substepPx || Infinity))));
  const h = dt / n;
  for (let k = 0; k < n; k++) {
    if (PHYS.wall === 'normal') { turnFromWall(c, h); turnFromKnock(c, h); slideStep(c, h, isPlayer); }
    else {
      const nx = c.x + c.vx * h, ny = c.y + c.vy * h;
      if (!carHits(c, nx, ny, c.a)) { c.x = nx; c.y = ny; } else axisStep(c, nx, ny, isPlayer);
    }
    if (PHYS.air) airStep(c, h, isPlayer);
  }
  if (c.squash > 0) c.squash = Math.max(0, c.squash - dt * 3);
}

// ---------- player ----------

export function enterCar(c) {
  const p = G.player;
  if (c.locked) { toast('That one\'s for sale. Buy it inside the dealer.'); return; }
  if (c.wreck) { toast('That car is wrecked.'); return; }
  if (c.police) { toast('Better not take a police car... yet.'); return; }
  c.touched = true;      // a streamed parked car Kimchi has used stays put
  // a traffic car is moving at its lane speed (vx, vy), so Kimchi takes it over at that speed
  if (c.ai) {
    const side = { x: c.x - Math.sin(c.a) * 40, y: c.y + Math.cos(c.a) * 40 };
    G.peds.push(makePed(side.x, side.y, { state: 'flee', t: 4, bubble: { text: pick(CARJACK_LINES), t: 3 }, chatCd: 5 }));
    c.ai = null;
    G.stats.carjacks++;
    crime('carjack', c);
  }
  p.car = c;
  sfx.door();
  if (!G.seen.drive) {
    G.seen.drive = true;
    toast('🚗 W/S gas & brake · A/D steer · Space handbrake · H horn · E get out', 6000);
  }
}

export function exitCar() {
  const p = G.player, c = p.car;
  const ty = CAR_TYPES[c.type];
  const off = ty.wid / 2 + 20;
  const opts = [
    { x: c.x + Math.sin(c.a) * off, y: c.y - Math.cos(c.a) * off },
    { x: c.x - Math.sin(c.a) * off, y: c.y + Math.cos(c.a) * off },
    { x: c.x + Math.cos(c.a) * (ty.len / 2 + 20), y: c.y + Math.sin(c.a) * (ty.len / 2 + 20) },
    { x: c.x - Math.cos(c.a) * (ty.len / 2 + 20), y: c.y - Math.sin(c.a) * (ty.len / 2 + 20) },
  ];
  const spot = opts.find(o => !circleBlocked(o.x, o.y - 4, 12));
  if (!spot) { toast('No room to get out here!'); return; }
  p.car = null;
  p.x = spot.x; p.y = spot.y + 8;
  for (const f of G.friends) if (f.inCar) { f.inCar = false; f.x = p.x + 28; f.y = p.y; }
  sfx.door();
}

// One frame of driving input. The surface's grip (world gripAt: grass is slow on the grid; v2 has the full
// table) caps the top speed and scales how fast sideways sliding dies away. On v2 (spec §10) the slope pulls
// the car back uphill, the yaw rate is capped by gripG, a turn into a wall pushes the car out along the wall
// instead of being refused, and in the air there is no steering or throttle.
export function driveCar(c, dt, inp) {
  const ty = CAR_TYPES[c.type];
  const fx = Math.cos(c.a), fy = Math.sin(c.a);
  let fwd = c.vx * fx + c.vy * fy;
  let lat = -c.vx * fy + c.vy * fx;
  if (c.air > 0 && PHYS.air) {
    c.speed = fwd; c.brake = !!inp.brake || (inp.down && fwd > 10); c.drift = false;
    return;
  }
  const grip = gripAt(c.x, c.y);
  const max = ty.max * CFG.carMax * grip.max * (G.energy <= 0 ? 0.8 : 1);
  const acc = ty.acc * CFG.carAcc;
  const slope = PHYS.slope ? slopeAt(c, fx, fy) : null;

  if (inp.up) fwd += acc * dt * (fwd < 0 ? 2.2 : 1);
  if (inp.down) fwd -= (fwd > 10 ? acc * 1.8 : acc * 0.6) * dt;
  if (!inp.up && !inp.down) fwd -= fwd * Math.min(1, 1.1 * dt);
  if (inp.brake) fwd -= fwd * Math.min(1, 1.6 * dt);
  // the slope pulls a moving car back downhill; one standing still with no pedal pressed holds its spot
  if (slope && (inp.up || inp.down || Math.abs(fwd) > HOLD_V)) fwd -= GPX * SLOPE_K * slope.grade * dt;
  if (fwd > max) fwd -= (fwd - max) * Math.min(1, 3 * dt);
  fwd = Math.max(fwd, -max * 0.35);

  const steer = inp.steer ?? ((inp.right ? 1 : 0) - (inp.left ? 1 : 0));
  const oldA = c.a;
  let turn = steer * ty.turn * dt * clamp(fwd / 170, -1, 1) * (inp.brake ? 1.4 : 1);
  if (CFG.gripG > 0) turn = capYaw(c, turn, dt, inp.brake, slope ? slope.bank : 0);
  c.a += turn;
  if (carHits(c, c.x, c.y, c.a) && !(PHYS.wall === 'normal' && pushOut(c))) c.a = oldA;

  lat *= Math.pow(inp.brake ? 0.3 : 0.0006, dt * grip.lat);
  const nfx = Math.cos(c.a), nfy = Math.sin(c.a);
  c.vx = nfx * fwd - nfy * lat;
  c.vy = nfy * fwd + nfx * lat;
  c.speed = fwd;
  c.brake = (inp.down && fwd > 10) || inp.brake;
  c.drift = inp.brake && Math.abs(fwd) > 200;
}

export function updatePlayer(dt, inp) {
  const p = G.player;
  if (p.car) {
    const c = p.car;
    if (!c.wreck && !(c.hp <= 0)) driveCar(c, dt, inp);
    moveCar(c, dt);
    carCollisions(c);
    p.x = c.x; p.y = c.y;
    return;
  }
  let dx = inp.ax ?? ((inp.right ? 1 : 0) - (inp.left ? 1 : 0));
  let dy = inp.ay ?? ((inp.down ? 1 : 0) - (inp.up ? 1 : 0));
  const L = Math.hypot(dx, dy);
  const tired = G.energy <= 0;
  const sp = (inp.run && !tired) ? CFG.run : tired ? CFG.tired : CFG.walk;
  if (L > 0.15) {
    dx /= Math.max(1, L); dy /= Math.max(1, L);
    moveChar(p, dx * sp * dt, dy * sp * dt, CFG.playerR);
    p.moving = true;
    p.walkT += dt * (sp / CFG.walk);
    if (Math.abs(dx) > 0.1) p.face = dx < 0 ? -1 : 1;
  } else p.moving = false;
  p.running = !!inp.run && p.moving && !tired;
  pushOutOfCars(p, CFG.playerR);
  p.x = clamp(p.x, BOUNDS.x0 + 20, BOUNDS.x1 - 20); p.y = clamp(p.y, BOUNDS.y0 + 20, BOUNDS.y1 - 20);
}

// Car c (Kimchi's, a cruiser's, a mission driver's) against every other car, then against the people. On
// the grid a car is one circle, as it always was; v2 uses the cars' boxes (carContacts below).
export function carCollisions(c) {
  if (PHYS.wall === 'normal') carContacts(c);
  else circleContacts(c);
  pedContacts(c);
}

// The classic contact: one circle of radius (len + wid) / 4 per car. A traffic car hit stops dead.
function circleContacts(c) {
  const ty = CAR_TYPES[c.type];
  const r1 = (ty.len + ty.wid) / 4;
  const mine = c === G.player.car;
  for (const o of G.cars) {
    if (o === c) continue;
    const dx = o.x - c.x, dy = o.y - c.y;
    if (Math.abs(dx) > 120 || Math.abs(dy) > 120) continue;
    const t2 = CAR_TYPES[o.type];
    const min = r1 + (t2.len + t2.wid) / 4;
    const d = Math.hypot(dx, dy);
    if (d >= min || d < 0.01) continue;
    const nx = dx / d, ny = dy / d, pen = min - d;
    const vrel = (c.vx - o.vx) * nx + (c.vy - o.vy) * ny;
    if (o.ai || o.locked) {
      c.x -= nx * pen; c.y -= ny * pen;
      if (vrel > 0) { c.vx -= nx * vrel * 1.3; c.vy -= ny * vrel * 1.3; }
      if (o.ai) { o.ai.speed = 0; if (vrel > 70) say(o, pick(['HEY!', 'Learn to drive!', 'My bumper!!', 'Seriously?!'])); }
    } else {
      if (mine) o.touched = true;
      c.x -= nx * pen * 0.5; c.y -= ny * pen * 0.5;
      if (!carHits(o, o.x + nx * pen * 0.5, o.y + ny * pen * 0.5, o.a)) { o.x += nx * pen * 0.5; o.y += ny * pen * 0.5; }
      if (vrel > 0) {
        c.vx -= nx * vrel * 0.8; c.vy -= ny * vrel * 0.8;
        o.vx += nx * vrel * 0.7; o.vy += ny * vrel * 0.7;
        o.a += (Math.random() - 0.5) * vrel * 0.003;
      }
    }
    if (vrel > 80) {
      const dmg = (vrel - 80) * 0.08;
      damageCar(c, dmg);
      damageCar(o, dmg);
      if (mine && o.police) crime('ramcop', o);
    }
    if (vrel > 90 && (mine || o === G.player.car)) { sfx.bump(); G.shake = Math.min(12, vrel / 40); }
  }
}

// ---------- car against car (v2) ----------
// On v2 a car is its real box (population.js carOverlap, a separating-axis test). The grid's circles touch
// with the cars' centres 2.8-4 m apart, more than the 3-3.6 m between v2 lanes and the 2.95 m from a lane's
// centre to the cars in its kerb bays, so every car driving past one touched it. A contact pushes the
// boxes apart along the contact normal and trades an impulse along it (restitution .3, plus Coulomb friction
// .3 across it), shared by the cars' masses (their footprints). A traffic car runs on its lane, so it can only
// take the part of the impulse along the lane: hit from behind it is shoved on, head on it slows or stops, and
// from the side it drives on while the other car bounces off it. A display car does not move at all. An
// off-centre hit also turns a car (knock, below).
const CAR_E = 0.3, CAR_MU = 0.3;
const KNOCK_K = 0.04 / M;      // a hit turns a car by 0.04 rad per m/s of speed it gives it at the very end of the car ...
const KNOCK_MAX = 0.35;        // ... at most 0.35 rad (20°) in all ...
const KNOCK_T = 0.25;          // ... spread over 0.25 s (at most 1.4 rad/s, 1.3° a frame at 60 fps), never in one frame
const CO = {};
const massOf = c => CAR_TYPES[c.type].len * CAR_TYPES[c.type].wid;

function carContacts(c) {
  const mine = c === G.player.car, ic = 1 / massOf(c);
  for (const o of G.cars) {
    if (o === c) continue;
    if (Math.abs(o.x - c.x) > 120 || Math.abs(o.y - c.y) > 120) continue;
    // a traffic car ghosting free of what held it (traffic.js) passes through it
    if (o.ai && (o.ai.ghost > 0 || o.ai.through === c)) continue;
    const k = carOverlap(c, o, CO);
    if (!k) continue;
    const nx = k.x, ny = k.y, tx = -ny, ty = nx;
    // how o can move: freely, along its lane only (unit lx, ly), or not at all
    let lx = 0, ly = 0, wn = 1, wt = 1;
    if (o.ai) {
      const v = Math.hypot(o.vx, o.vy);
      lx = v > 1 ? o.vx / v : Math.cos(o.a); ly = v > 1 ? o.vy / v : Math.sin(o.a);
      wn = (nx * lx + ny * ly) ** 2; wt = (tx * lx + ty * ly) ** 2;
    } else if (o.locked) wn = wt = 0;
    const io = 1 / massOf(o);
    separate(c, o, nx, ny, k.pen, ic, o.ai || o.locked ? 0 : io);
    const vrel = (c.vx - o.vx) * nx + (c.vy - o.vy) * ny;
    if (!(o.ai || o.locked) && mine) o.touched = true;
    if (vrel > 0) {
      const J = (1 + CAR_E) * vrel / (ic + wn * io);
      const vt = (c.vx - o.vx) * tx + (c.vy - o.vy) * ty;
      const Jt = Math.sign(vt) * Math.min(CAR_MU * J, Math.abs(vt) / (ic + wt * io));
      const ix = J * nx + Jt * tx, iy = J * ny + Jt * ty;        // the impulse on o; c takes the opposite
      c.vx -= ix * ic; c.vy -= iy * ic;
      knock(c, k.px, k.py, -ix * ic, -iy * ic);
      if (o.ai) {
        o.ai.speed = Math.max(0, o.ai.speed + (ix * lx + iy * ly) * io);
        if (vrel > 70) say(o, pick(['HEY!', 'Learn to drive!', 'My bumper!!', 'Seriously?!']));
      } else if (!o.locked) {
        o.vx += ix * io; o.vy += iy * io;
        knock(o, k.px, k.py, ix * io, iy * io);
      }
    }
    if (vrel > 80) {
      const dmg = (vrel - 80) * 0.08;
      damageCar(c, dmg);
      damageCar(o, dmg);
      if (mine && o.police) crime('ramcop', o);
    }
    if (vrel > 90 && (mine || o === G.player.car)) { sfx.bump(); G.shake = Math.min(12, vrel / 40); }
  }
}

// Push two overlapping cars pen px apart along the normal (nx, ny) from c to o, shared by their inverse
// masses (io 0: o cannot be moved: a traffic car on its lane, a display car). A share that would put a car
// into a wall goes to the other one; a traffic car that cannot shove c clear (c is against a wall) stops.
function separate(c, o, nx, ny, pen, ic, io) {
  const po = pen * io / (ic + io);
  const pc = po > 0 && shove(o, nx * po, ny * po) ? pen - po : pen;
  if (shove(c, -nx * pc, -ny * pc)) return;
  if (io > 0) shove(o, nx * pc, ny * pc);
  else if (o.ai) o.ai.speed = 0;
}

// Move car k by (dx, dy) unless that puts it into a wall it is not already in. False if it stays put.
function shove(k, dx, dy) {
  if (carHits(k, k.x + dx, k.y + dy, k.a) && !carHits(k, k.x, k.y, k.a)) return false;
  k.x += dx; k.y += dy;
  return true;
}

// The turn a hit gives car k: the speed change (dvx, dvy) px/s landing at (px, py) turns it the way that push
// would, by how far off its centre the push lands (a lever of 1 at the end of the car, 0 through the middle).
// It is a knock to spread over the next KNOCK_T s (turnFromKnock in moveCar), not a jump of the heading.
function knock(k, px, py, dvx, dvy) {
  const dv = Math.hypot(dvx, dvy);
  if (dv < 1) return;
  const arm = ((px - k.x) * dvy - (py - k.y) * dvx) / dv / (CAR_TYPES[k.type].len / 2);
  const turn = clamp(KNOCK_K * dv * arm, -KNOCK_MAX, KNOCK_MAX);
  if (Math.abs(turn) < 1e-3) return;
  const t = k.knock || (k.knock = { a: 0, t: 0 });
  t.a = clamp(t.a + turn, -KNOCK_MAX, KNOCK_MAX); t.t = KNOCK_T;
}

// One substep (h s) of a knock: an even share of the turn left over the time left. A turn into a wall pushes
// the car out along the wall's normal, or ends the knock there.
function turnFromKnock(c, h) {
  const t = c.knock;
  if (!t || !(t.t > 0)) return;
  const step = t.a * Math.min(1, h / t.t), a0 = c.a;
  t.a -= step; t.t -= h;
  c.a += step;
  if (carHits(c, c.x, c.y, c.a) && !pushOut(c)) { c.a = a0; t.a = 0; t.t = 0; }
}

// A car among the people: at speed it knocks them down; slowly it nudges them out of its way.
function pedContacts(c) {
  const mine = c === G.player.car;
  const speed = Math.hypot(c.vx, c.vy);
  for (const p of G.peds) {
    if (p.state === 'knocked' || p.state === 'down') continue;
    const dx = p.x - c.x, dy = p.y - 6 - c.y;
    if (dx * dx + dy * dy > 34 * 34) continue;
    if (speed > 110) {
      hurtPed(p, speed * 0.25, { knock: true, byPlayer: mine,
        vx: c.vx * 0.8 + (Math.random() - 0.5) * 120, vy: c.vy * 0.8 + (Math.random() - 0.5) * 120 });
      if (mine) { sfx.bump(); G.shake = 6; }
    } else pushOutOfCars(p, 10);
  }
}

export function honk() {
  const p = G.player;
  sfx.horn();
  const src = p.car || p;
  for (const pd of G.peds) {
    if (pd.state === 'knocked' || pd.state === 'down' || pd.role) continue;
    if (Math.hypot(pd.x - src.x, pd.y - src.y) < 230) {
      pd.state = 'flee'; pd.t = 1.6;
      if (Math.random() < 0.5) say(pd, pick(SCARED_LINES), 1.4);
    }
  }
}

// ---------- pedestrians & friends ----------
// Traffic drives in src/sim/traffic.js. A civilian's walking is src/sim/peds.js (along the sidewalks, back to
// one after a fright); what they do (fleeing, falling, chatting to Kimchi, pausing) is decided here.

function updatePed(p, dt) {
  p.walkT += dt;
  if (p.bubble && (p.bubble.t -= dt) <= 0) p.bubble = null;
  p.chatCd -= dt;

  if (p.state === 'down') {
    // lies there for a while, then a new person appears somewhere else in town
    if ((p.downT -= dt) <= 0) { if (p.role) p.remove = true; else respawnPed(p); }
    return;
  }
  if (p.state === 'knocked') {
    p.walk = null; p.snap = null; p.resnapT = 0; p.lost = false;
    moveChar(p, p.vx * dt, p.vy * dt, 8);
    const damp = Math.pow(0.03, dt);
    p.vx *= damp; p.vy *= damp;
    p.spin += dt * 9;
    if ((p.t -= dt) <= 0) {
      p.spin = 0;
      if (p.dying) { p.state = 'down'; p.downT = 25; p.dying = false; p.bubble = null; }
      else if (p.role) p.state = 'alert';
      else { p.state = 'flee'; p.t = 3; say(p, pick(HIT_LINES), 2.5); }
    }
    return;
  }
  if (p.role) return;   // police and gang members are driven by the 3D game's combat code
  const pl = G.player;
  if (p.state === 'flee') {
    // off the pavement in a panic; once calm, walkPed takes them back to the nearest sidewalk
    p.walk = null; p.snap = null; p.resnapT = 0; p.lost = false;
    let dx = p.x - pl.x, dy = p.y - pl.y;
    const L = Math.hypot(dx, dy) || 1;
    dx /= L; dy /= L;
    moveChar(p, dx * CFG.pedFlee * dt, dy * CFG.pedFlee * dt, 9);
    p.face = dx < 0 ? -1 : 1; p.moving = true;
    p.heading = Math.atan2(dy, dx);
    if ((p.t -= dt) <= 0) p.state = 'walk';
    return;
  }
  // fans recognise Kimchi on foot (never mid-road: on a crosswalk or walking back to the pavement)
  if (!pl.car && p.chatCd <= 0 && Math.abs(p.x - pl.x) < 90 && Math.abs(p.y - pl.y) < 90 && canPause(p)) {
    say(p, Math.random() < 0.7 ? pick(FAN_LINES) : pick(PED_LINES));
    p.chatCd = 12 + Math.random() * 10;
    p.pause = 1.2; p.face = pl.x < p.x ? -1 : 1;
  }
  if (p.pause > 0) { p.pause -= dt; p.moving = false; return; }
  if ((p.timer -= dt) <= 0) {
    p.timer = 2 + Math.random() * 5;
    if (canPause(p) && Math.random() < 0.25) { p.pause = 1 + Math.random() * 2; return; }
    if (p.walk && canPause(p) && Math.random() < 0.1) {
      // changes their mind and turns round, staying on the same spot of the pavement
      p.walk.dir = -p.walk.dir; p.walk.next = -1; p.off = -(p.off || 0);
    }
    p.dir = Math.floor(Math.random() * 4);
  }
  if (walkPed(p, dt, CFG.pedWalk)) return;
  // a world without a sidewalk graph: wander the open tiles as the game always did
  const [dx, dy] = DIRV[p.dir];
  const ahead = tileAtPx(p.x + dx * 20, p.y - 4 + dy * 20);
  if (ahead === ROAD || ahead === BUILD || ahead === WATER || blockedPx(p.x + dx * 20, p.y - 4 + dy * 20)) { p.dir = (p.dir + (Math.random() < 0.5 ? 1 : 3)) % 4; p.moving = false; return; }
  p.x += dx * CFG.pedWalk * dt; p.y += dy * CFG.pedWalk * dt;
  p.moving = true;
  if (dx) p.face = dx;
}

function updateFriend(f, dt) {
  const p = G.player;
  f.walkT += dt;
  if (f.bubble && (f.bubble.t -= dt) <= 0) f.bubble = null;
  f.greetCd -= dt;

  if (f.following) {
    if (p.car) { f.inCar = true; f.x = p.car.x; f.y = p.car.y; f.moving = false; return; }
    const d = Math.hypot(p.x - f.x, p.y - f.y);
    if (d > 650) { f.x = p.x - 40 * p.face; f.y = p.y + 10; return; }
    if (d > 52) {
      const sp = Math.min(CFG.friendRun, d * 2.2);
      moveChar(f, (p.x - f.x) / d * sp * dt, (p.y - f.y) / d * sp * dt);
      f.moving = true;
      f.face = p.x < f.x ? -1 : 1;
    } else f.moving = false;
    return;
  }
  const d = Math.hypot(p.x - f.x, p.y - f.y);
  if (d < 140 && f.greetCd <= 0 && !p.car) {
    say(f, `Hey Kimchi! 👋`, 2);
    f.greetCd = 25;
  }
  if (d < 90 && !p.car) { f.moving = false; f.face = p.x < f.x ? -1 : 1; return; }
  if ((f.wanderT -= dt) <= 0) {
    f.wanderT = 3 + Math.random() * 4;
    f.tx = f.spot.x + (Math.random() - 0.5) * 140;
    f.ty = f.spot.y + (Math.random() - 0.5) * 90;
  }
  const dd = Math.hypot(f.tx - f.x, f.ty - f.y);
  if (dd > 5) {
    moveChar(f, (f.tx - f.x) / dd * CFG.friendWalk * dt, (f.ty - f.y) / dd * CFG.friendWalk * dt);
    f.moving = true;
    f.face = f.tx < f.x ? -1 : 1;
  } else f.moving = false;
}

// opts (optional) goes to the population: { tier: 'low' | 'medium' | 'high', view(x, y) -> true when on screen }
export function updateWorld(dt, opts) {
  updateTraffic(dt);
  for (const c of G.cars) {
    if (c.bubble && (c.bubble.t -= dt) <= 0) c.bubble = null;
    if (!c.ai && c !== G.player.car && !c.managed) moveCar(c, dt);
  }
  for (const p of G.peds) updatePed(p, dt);
  if (G.peds.some(p => p.remove)) G.peds = G.peds.filter(p => !p.remove);
  for (const f of G.friends) updateFriend(f, dt);
  updatePopulation(dt, G.player, opts);
  hookSoak();
}

// The soak report (KC3.soak, src/3d/bench.js) includes window.KCSTATS(): traffic and pedestrian stats
// (src/sim/traffic.js trafficStats). They count from the start of each soak, and from each new game.
globalThis.KCSTATS = Object.assign(() => trafficStats(), { reset: resetTrafficStats });
function hookSoak() {
  const K = globalThis.KC3;
  if (!K || typeof K.soak !== 'function' || K.soak.kcStats) return;
  const soak = K.soak;
  K.soak = Object.assign((...args) => { resetTrafficStats(); return soak(...args); }, { kcStats: true });
}

// what the E key would do right now
export function findTarget() {
  const p = G.player;
  if (p.car) return { kind: 'exit', label: 'Get out' };
  let best = null;
  const consider = (d, max, t) => { if (d < max && (!best || d < best.d)) best = { ...t, d }; };
  for (const f of G.friends) if (!f.following) consider(Math.hypot(f.x - p.x, f.y - p.y) - 8, 60, { kind: 'friend', f, label: `Talk to ${f.def.name}` });
  for (const f of G.friends) if (f.following) consider(Math.hypot(f.x - p.x, f.y - p.y) + 20, 60, { kind: 'friend', f, label: `Talk to ${f.def.name}` });
  for (const pl of Object.values(places)) {
    if (pl.nomenu) continue;
    consider(Math.hypot(pl.door.x - p.x, pl.door.y - p.y), 62, { kind: 'place', place: pl, label: `Enter ${pl.name}` });
  }
  for (const b of buildings) {
    if (b.place || Math.abs(b.door.x - p.x) > 60 || Math.abs(b.door.y - p.y) > 60) continue;
    consider(Math.hypot(b.door.x - p.x, b.door.y - p.y) + 6, 50, { kind: 'knock', b, label: 'Knock on door' });
  }
  for (const c of G.cars) {
    const d = Math.hypot(c.x - p.x, c.y - 4 - p.y) - CAR_TYPES[c.type].len * 0.25;
    consider(d, 50, { kind: 'car', c, label: c.locked ? `${CAR_TYPES[c.type].name} · for sale` : c.ai ? 'Carjack!' : c.owned ? 'Drive your car' : 'Get in' });
  }
  return best;
}

// ---------- drawing ----------

export function drawCar(ctx, c, night) {
  const ty = CAR_TYPES[c.type];
  const L = ty.len, W = ty.wid;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(c.a);
  ctx.fillStyle = 'rgba(0,0,0,.28)'; roundRect(ctx, -L / 2 + 4, -W / 2 + 6, L, W, 9); ctx.fill();
  ctx.fillStyle = c.color; roundRect(ctx, -L / 2, -W / 2, L, W, c.type === 'van' ? 6 : 10); ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,.14)'; roundRect(ctx, -L / 2, W / 2 - 6, L, 6, 3); ctx.fill();

  const glass = '#1d2733';
  if (c.type === 'van') {
    ctx.fillStyle = glass; roundRect(ctx, L / 2 - 20, -W / 2 + 4, 10, W - 8, 3); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.18)'; roundRect(ctx, -L / 2 + 4, -W / 2 + 4, L - 28, W - 8, 4); ctx.fill();
  } else {
    const roofL = c.type === 'sports' ? L * 0.26 : L * 0.34;
    const roofX = c.type === 'hatch' ? -L * 0.28 : -L * 0.2;
    ctx.fillStyle = glass; roundRect(ctx, roofX + roofL - 2, -W / 2 + 4, L * 0.16, W - 8, 4); ctx.fill();
    ctx.fillStyle = glass; roundRect(ctx, roofX - L * 0.1, -W / 2 + 5, L * 0.12, W - 10, 3); ctx.fill();
    ctx.fillStyle = c.color; roundRect(ctx, roofX, -W / 2 + 4, roofL, W - 8, 5); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.2)'; roundRect(ctx, roofX, -W / 2 + 4, roofL, W - 8, 5); ctx.fill();
    if (c.type === 'sports') {
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.fillRect(-L / 2 + 2, -3, 12, 6);
      ctx.fillStyle = '#fbf7ef'; ctx.fillRect(-L / 2 + 14, -2, L - 26, 4);
    }
    if (c.type === 'taxi') {
      ctx.fillStyle = '#1b1512'; roundRect(ctx, roofX + roofL / 2 - 6, -7, 12, 14, 3); ctx.fill();
      ctx.fillStyle = '#ffeb8a'; ctx.fillRect(roofX + roofL / 2 - 3, -5, 6, 10);
    }
  }
  const lightOn = night > 0.15;
  ctx.fillStyle = lightOn ? '#fff7c2' : '#f3eecf';
  ctx.fillRect(L / 2 - 4, -W / 2 + 3, 4, 7); ctx.fillRect(L / 2 - 4, W / 2 - 10, 4, 7);
  ctx.fillStyle = c.brake ? '#ff3b2f' : '#a3231a';
  ctx.fillRect(-L / 2, -W / 2 + 3, 4, 7); ctx.fillRect(-L / 2, W / 2 - 10, 4, 7);
  if (c.owned) {
    ctx.fillStyle = '#f2c230';
    ctx.beginPath(); ctx.arc(-L / 2 + 10, 0, 4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

export function drawKimchi(ctx, p, t) {
  if (!sprite.naturalWidth) return;
  const H = 70, W = H * sprite.naturalWidth / sprite.naturalHeight;
  ctx.fillStyle = 'rgba(0,0,0,.25)'; ellipse(ctx, p.x, p.y, 16, 5);
  const freq = p.running ? 18 : 13;
  const bob = p.moving ? Math.abs(Math.sin(p.walkT * freq)) * (p.running ? 6 : 4) : Math.sin(t * 2.5) * 0.8;
  const tilt = p.moving ? Math.sin(p.walkT * freq) * (p.running ? 0.09 : 0.06) + (p.running ? 0.08 * p.face : 0) : 0;
  ctx.save();
  ctx.translate(p.x, p.y - bob);
  ctx.rotate(tilt);
  ctx.scale(p.face, 1);
  ctx.drawImage(sprite, -W / 2, -H, W, H);
  const X = u => -W / 2 + u * W, Y = v => -H + v * H;
  const eq = G.equipped;
  if (eq.chain) {
    ctx.strokeStyle = '#f2c230'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(X(0.47), Y(0.455), W * 0.15, H * 0.045, 0, 0.1, Math.PI - 0.1); ctx.stroke();
    ctx.fillStyle = '#f2c230'; circle(ctx, X(0.47), Y(0.505), 2.6);
  }
  if (eq.shades) {
    ctx.fillStyle = '#111';
    roundRect(ctx, X(0.14), Y(0.335), W * 0.22, H * 0.06, 2); ctx.fill();
    roundRect(ctx, X(0.44), Y(0.335), W * 0.22, H * 0.06, 2); ctx.fill();
    ctx.fillRect(X(0.35), Y(0.345), W * 0.1, 1.6);
    ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillRect(X(0.17), Y(0.342), 3, 1.5); ctx.fillRect(X(0.47), Y(0.342), 3, 1.5);
  }
  if (eq.cap) {
    ctx.fillStyle = '#d6402b';
    ctx.beginPath(); ctx.ellipse(X(0.5), Y(0.17), W * 0.42, H * 0.13, 0, Math.PI, 0); ctx.fill();
    ctx.fillRect(X(0.08), Y(0.165), W * 0.84, H * 0.04);
    ctx.fillStyle = '#b8321f';
    ctx.beginPath(); ctx.ellipse(X(0.12), Y(0.19), W * 0.24, H * 0.03, -0.1, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fbf7ef'; circle(ctx, X(0.5), Y(0.09), 2.5);
  }
  ctx.restore();
}

export function drawChibi(ctx, e) {
  const lk = e.look, s = e.scale || 1;
  ctx.save();
  ctx.translate(e.x, e.y);
  if (e.state === 'knocked' || e.state === 'down') { ctx.rotate(e.state === 'down' ? Math.PI / 2 : e.spin); ctx.translate(0, 20); }
  ctx.scale(e.face * s, s);
  ctx.fillStyle = 'rgba(0,0,0,.22)'; ellipse(ctx, 0, 0, 12, 4);
  const sw = e.moving ? Math.sin(e.walkT * (e.state === 'flee' ? 18 : 11)) : 0;
  ctx.fillStyle = lk.pants;
  ctx.fillRect(-7, -14, 6, 12 + sw * 2.5);
  ctx.fillRect(1, -14, 6, 12 - sw * 2.5);
  ctx.fillStyle = '#f2efe8';
  ctx.fillRect(-8, -3 + sw * 2.5, 8, 4);
  ctx.fillRect(0, -3 - sw * 2.5, 8, 4);
  ctx.fillStyle = lk.shirt; roundRect(ctx, -10, -30, 20, 18, 6); ctx.fill();
  ctx.fillStyle = lk.skin;
  circle(ctx, -11, -21 + sw * 2.5, 3.6); circle(ctx, 11, -21 - sw * 2.5, 3.6);
  circle(ctx, 0, -42, 13);
  ctx.fillStyle = lk.hair;
  ctx.beginPath(); ctx.arc(0, -44, 14, Math.PI, 0); ctx.fill();
  ellipse(ctx, 3, -50, 12, 6);
  if (lk.long) { ctx.fillRect(-14, -45, 5, 16); ctx.fillRect(9, -45, 5, 16); }
  ctx.fillStyle = '#1b1512';
  ellipse(ctx, -1, -39, 2, 2.6); ellipse(ctx, 7, -39, 2, 2.6);
  ctx.fillStyle = 'rgba(232,120,120,.35)'; circle(ctx, -4, -35, 2.5); circle(ctx, 10, -35, 2.5);
  ctx.restore();
}

export function drawBubble(ctx, x, y, text) {
  ctx.font = '700 14px ui-rounded, system-ui, sans-serif';
  const w = ctx.measureText(text).width + 18, h = 26;
  ctx.fillStyle = 'rgba(0,0,0,.18)'; roundRect(ctx, x - w / 2 + 2, y - h + 2, w, h, 10); ctx.fill();
  ctx.fillStyle = '#fffdf7'; roundRect(ctx, x - w / 2, y - h, w, h, 10); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x - 6, y - 1); ctx.lineTo(x + 6, y - 1); ctx.lineTo(x, y + 7); ctx.fill();
  ctx.fillStyle = '#1b1512'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y - h / 2);
}

export function drawNameTag(ctx, x, y, text, color) {
  ctx.font = '800 12px ui-rounded, system-ui, sans-serif';
  const w = ctx.measureText(text).width + 14;
  ctx.fillStyle = color; roundRect(ctx, x - w / 2, y - 18, w, 18, 9); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y - 9);
}
