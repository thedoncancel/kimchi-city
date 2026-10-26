import { G } from '../state.js';
import { KIND, PX_PER_M, PHYS, roads, places, sightClear, groundY } from '../world.js';
import { makeCar, makePed, driveCar, moveCar, carCollisions, carHits, say, CFG } from '../entities.js';
import { CAR_COLORS, CAR_TYPES, LUX_COLORS } from '../data.js';
import { angDiff, clamp, pick } from '../util.js';
import { setSiren } from './gunsfx.js';
import { roadWaypoint, curvatureAhead, cornerSpeed, predictPath, pathPoint, setRoute, dodge, COP_GRIP } from '../sim/nav.js';

// Missions still take roadWaypoint from here; it lives with the rest of the road navigation now.
export { roadWaypoint } from '../sim/nav.js';

// ---------- crimes and wanted stars ----------

// [stars at least, cap when it bumps a star you already have]
const RULES = {
  carjack: [1, 1], assault: [1, 1], shoot: [1, 1], kill: [1, 3], ramcop: [1, 2],
  cop: [2, 3], explode: [2, 4], copkill: [3, 5],
};
const lastBump = {};
export function crime(kind) {
  const r = RULES[kind];
  if (!r || G.player.dead) return;
  const [min, cap] = r;
  const before = G.wanted;
  if (G.wanted < min) G.wanted = min;
  else if (G.wanted < cap && G.t - (lastBump[kind] || -9) > 2.5) { G.wanted++; lastBump[kind] = G.t; }
  G.evadeT = 0;
  // dispatch knows where the crime happened, so for a while there is no hiding
  G.heatT = Math.max(G.heatT || 0, 12 + G.wanted * 4);
  if (G.wanted > before) G.starFlash = 1.2;
}

// ---------- distances ----------

// Distances in px. The spec's (docs/map-v2-spec.md §9) are for the 2 km Kimchi Key; the classic grid is
// only 344 m across, so there the cops keep today's distances. spawn: how far from Kimchi a cruiser
// appears; gone: how far one driving off must get before it vanishes; away: how far its drive-off node is
// from him; block: how far ahead on his way a roadblock goes up; see / seeFoot: how far a cruiser / an
// officer on foot keeps him in view (sight lines permitting); siren: how far off a siren can be heard.
// The grid's 81 m of sight is two blocks; on the Key's open roads a car doing 40 m/s leaves it in two
// seconds, so v2 cruisers see 170 m: they keep a car in sight down a boulevard, and a getaway means
// breaking the line of sight (a hill, the towers, a turn off) or outrunning them.
const M = PX_PER_M;
const TUNE = KIND === 'grid'
  ? { spawn: [1500, 3000], gone: 2400, away: 2400, block: [1400, 2600], see: 1300, seeFoot: 900, siren: 2600 }
  : { spawn: [220 * M, 420 * M], gone: 300 * M, away: 500 * M, block: [280 * M, 400 * M], see: 170 * M, seeFoot: 70 * M, siren: 260 * M };
const EYE = 1.5;                  // m: the cops and Kimchi see each other eye to eye
const BLOCK_T = 25, BLOCK_GAP = 12;   // s: a roadblock stands this long; the next one waits this long after it

// Can someone at a see someone at b? Hills and buildings block the view, water does not.
const sees = (a, b) => sightClear(a.x, a.y, groundY(a.x, a.y) + EYE, b.x, b.y, groundY(b.x, b.y) + EYE);

// ---------- driving along the roads ----------

// AI driving for police, race rivals and mission targets: steer at (ax, ay), brake for corners, back up when
// stuck against something. Options: stopWithin (brake inside this distance of the aim point), corner (brake
// above this speed when the aim is far off the nose), cap (no throttle above this speed), curv (the bend
// ahead from curvatureAhead: slow to its corner speed at grip m/s^2, by default the police 1.15 sqrt(9 R)),
// dodge (steer round cars in the way, all but o.ignore).
const aim = [0, 0];
export function steerTo(c, dt, ax, ay, o = {}) {
  const hold = o.dodge ? dodge(c, ax, ay, aim, o.ignore) : Infinity;
  if (o.dodge) { ax = aim[0]; ay = aim[1]; }
  const want = Math.atan2(ay - c.y, ax - c.x);
  const da = angDiff(c.a, want);
  const fwd = c.vx * Math.cos(c.a) + c.vy * Math.sin(c.a);
  const d = Math.hypot(ax - c.x, ay - c.y);
  const s = c.drv || (c.drv = { stuckT: 0, revT: 0 });
  const inp = { up: false, down: false, brake: false, steer: clamp(da * 2.4, -1, 1) };
  if (s.revT > 0) {
    s.revT -= dt;
    inp.down = true;
    inp.steer = -Math.sign(da || 1);
  } else if (o.stopWithin && d < o.stopWithin) {
    inp.brake = true;
  } else {
    inp.up = Math.abs(da) < 1.9 || fwd < 60;
    if (Math.abs(da) > 0.9 && fwd > (o.corner || 250)) { inp.brake = true; inp.up = false; }
    if (o.cap && fwd > o.cap) inp.up = false;
    if (o.curv) {
      // lift for the bend ahead, and brake hard when well over its speed
      const vc = cornerSpeed(o.curv, o.grip || COP_GRIP);
      if (fwd > vc) inp.up = false;
      if (fwd > vc * 1.12 + 20) inp.down = true;
    }
    // boxed in behind a car: keep to its speed
    if (fwd > hold) { inp.up = false; if (fwd > hold + 60) inp.down = true; }
    // an aim too tight to turn onto at this speed: lift, and brake when it is well inside the car's tightest
    // circle, instead of circling round it
    const reach = turnReach(c, fwd, d, da);
    if (reach < 0.9) { inp.up = false; if (reach < 0.6) inp.down = true; }
    if (stuck(c, s, dt, ax, ay, inp.up, fwd, !!o.ignore)) {
      s.revT = REVERSE_T;
      s.tries = (s.tries || 0) + 1;
      if (s.tries >= WRIGGLE_AFTER) { wriggle(c, want); s.tries = 0; }
    }
  }
  if (scraping(c, dt)) { inp.up = false; inp.down = fwd > 0; }
  drive(c, dt, inp);
  moveCar(c, dt, true);
  carCollisions(c);
  // out of a wall a shove left it in: when slow or stuck, and on the grid's walls (which refuse every move
  // of a car inside them and bill its whole speed each frame) at any speed
  if (Math.abs(fwd) < 30 || s.stuckT > 0.5 || PHYS?.wall !== 'normal') unwedge(c);
  return d;
}

// Is the car stuck? It is when it has wanted to drive (up) for STUCK_T without getting STUCK_D nearer its
// aim since its window began (the window start's distance to the aim now, less the car's own), and it then
// backs up for REVERSE_T, steering the other way. That is displacement over a window, not speed: a car
// shoving another car, or sliding along a wall away from its aim, shows speed but gets nowhere. Measuring
// both ends against the aim as it is now keeps a car chasing a moving target, or following its pursuit
// point, from counting as stuck. Each STUCK_D of progress starts a new window, and a window runs from the
// furthest back the car has been in it. Time rolling backward (the end of a back-up, a shove) does not
// count. So after backing up a car has STUCK_T to make STUCK_D from where its reversing ended, rather than
// to win back the distance it reversed as well (at the 3D game's acceleration,
// CFG_3D's half, a van, a hatchback or a sedan never could, and backed up a second time on an open road).
// Back at the spot where it got stuck (within AGAIN_R) and getting no nearer (AGAIN_D in AGAIN_T), whatever
// stopped it is still there, so it backs off again at once instead of shoving for STUCK_T more: a car
// blocked by stopped traffic at a junction keeps out of the junction instead of holding it up. Not one that
// means to shove (it has a car to ram, o.ignore). Its run of back-ups (s.tries, for wriggle) only ends with
// STUCK_D of progress past that spot, or once it is FORGET from it: a car that backs off a wall and drives
// into it again has still got nowhere.
const STUCK_D = 2 * M, STUCK_T = 1.1, REVERSE_T = 0.8, ROLL_BACK = 0.5 * M;
const AGAIN_R = 1 * M, AGAIN_T = 0.4, AGAIN_D = 0.5 * M, FORGET = 20 * M;
const gain = (ax, ay, x0, y0, c) => Math.hypot(ax - x0, ay - y0) - Math.hypot(ax - c.x, ay - c.y);
function stuck(c, s, dt, ax, ay, up, fwd, shove) {
  if (s.wx == null) { s.wx = c.x; s.wy = c.y; }
  if (s.bx != null && Math.hypot(c.x - s.bx, c.y - s.by) > FORGET) { s.bx = null; s.tries = 0; }
  const g = gain(ax, ay, s.wx, s.wy, c);
  if (g >= STUCK_D) {
    if (s.bx == null || gain(ax, ay, s.bx, s.by, c) >= STUCK_D) { s.tries = 0; s.bx = null; }
    s.wx = c.x; s.wy = c.y; s.stuckT = 0;
    return false;
  }
  if (g < 0) { s.wx = c.x; s.wy = c.y; }
  if (!up || fwd < -ROLL_BACK) { s.stuckT = Math.max(0, s.stuckT - dt); return false; }
  s.stuckT += dt;
  const again = !shove && s.bx != null && s.stuckT > AGAIN_T && g < AGAIN_D && Math.hypot(c.x - s.bx, c.y - s.by) < AGAIN_R;
  if (s.stuckT <= STUCK_T && !again) return false;
  s.stuckT = 0; s.bx = c.x; s.by = c.y;
  return true;
}

// Can the car turn onto its aim at this speed? The tightest circle it can drive has radius fwd / yaw rate,
// the yaw rate being its type's turn (less below 170 px/s, as driveCar has it) and, with a grip limit (v2),
// at most gripG g / fwd. Reaching a point d away and da off the nose takes the circle of radius
// d / (2 sin da). Returns that radius over the car's tightest (Infinity for an aim straight ahead, behind, or
// a car barely moving): under 1 the aim is out of reach, and driven at it is circled for good (the S1c
// soak's car ran rings round a kerb at 22 m/s for 18 s).
function turnReach(c, fwd, d, da) {
  if (fwd < 2 * M || Math.abs(da) < 0.05 || Math.abs(da) > Math.PI / 2) return Infinity;
  let w = CAR_TYPES[c.type].turn * Math.min(1, fwd / 170);
  if (CFG.gripG > 0) w = Math.min(w, CFG.gripG * 9.81 * M / fwd);
  return d / (2 * Math.abs(Math.sin(da))) / (fwd / w);
}

// On the classic grid's walls (PHYS.wall 'axis') a car loses hp off its whole speed above 140 px/s every
// frame it touches one (entities hitWall), so a car shoved against a building or the map edge that keeps
// its foot down is ground to a wreck in half a second. An AI driver whose next two frames run into a wall
// above SCRAPE_V, at its speed along its velocity or along its nose (driveCar swings the velocity onto the
// nose each frame, and a wall bounce leaves the two apart), lifts and brakes. v2's walls hurt only by the
// speed into them (§10), so there it drives on.
const SCRAPE_V = 130;
function scraping(c, dt) {
  const v = Math.hypot(c.vx, c.vy);
  if (PHYS?.wall === 'normal' || v <= SCRAPE_V) return false;
  const k = v * dt * 2;
  return carHits(c, c.x + c.vx * dt * 2, c.y + c.vy * dt * 2, c.a) || carHits(c, c.x + Math.cos(c.a) * k, c.y + Math.sin(c.a) * k, c.a);
}

// A shove from another car can leave a car overlapping a wall, and then no move or turn is allowed and
// it is stuck for good. Slide it out to the nearest free spot within 1.5 m.
const OUT = [[1, 0], [0.7, 0.7], [0, 1], [-0.7, 0.7], [-1, 0], [-0.7, -0.7], [0, -1], [0.7, -0.7]];
function unwedge(c) {
  if (!carHits(c, c.x, c.y, c.a)) return;
  for (const r of [4, 8, 12, 16, 24]) {
    for (const [ux, uy] of OUT) {
      if (carHits(c, c.x + ux * r, c.y + uy * r, c.a)) continue;
      c.x += ux * r; c.y += uy * r; c.vx = c.vy = 0;
      return;
    }
  }
}

// A car wedged so that neither driving on nor backing up gets it anywhere (WRIGGLE_AFTER back-ups in a row
// with no progress: a pocket between a rail and the sea, a nose in a corner) wriggles free. It is set down
// on the nearest spot within 1.5 m, turned toward its aim by up to 1 rad (or not at all), where it fits
// with a metre to spare ahead, and stopped. Only after several seconds stuck, so a visible nudge beats a car
// stuck for good.
const WRIGGLE_AFTER = 4;
function wriggle(c, want) {
  const turn = clamp(angDiff(c.a, want), -1, 1);
  for (const r of [0, 4, 8, 12, 16, 24]) {
    for (const [ux, uy] of r ? OUT : [[0, 0]]) {
      for (const k of [1, 0.5, 0]) {
        const x = c.x + ux * r, y = c.y + uy * r, a = c.a + turn * k;
        if (carHits(c, x, y, a) || carHits(c, x + Math.cos(a) * M, y + Math.sin(a) * M, a)) continue;
        c.x = x; c.y = y; c.a = a; c.vx = c.vy = 0;
        return;
      }
    }
  }
}

// driveCar with the car's own tuning: c.tune = { max, acc } scales its top speed and acceleration (police
// interceptors, the race rival's rubber band). The shared CFG multipliers are restored straight after.
function drive(c, dt, inp) {
  const t = c.tune;
  if (!t) { driveCar(c, dt, inp); return; }
  const max = CFG.carMax, acc = CFG.carAcc;
  CFG.carMax = max * (t.max || 1); CFG.carAcc = acc * (t.acc || 1);
  try { driveCar(c, dt, inp); } finally { CFG.carMax = max; CFG.carAcc = acc; }
}

// ---------- police units ----------

// lastSeen: where the cops last saw Kimchi; search: the area they comb while he is out of sight ({ x, y, r }
// px, for the minimap's search circle), or null; roadblock: the one standing roadblock ({ cars, x, y, t }) or
// null, and blockT the wait before the next.
export const police = { cars: [], spawnT: 0, bustT: 0, sprayLock: false, lastSeen: null, search: null, roadblock: null, blockT: 0 };
const COP_LOOK = { skin: '#e0ac7e', hair: '#1b1512', shirt: '#1f2f4f', pants: '#1b2333' };
const want = () => [0, 1, 2, 3, 4, 6][G.wanted];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const busy = (x, y, r = 170) => G.cars.some(c => Math.hypot(c.x - x, c.y - y) < r);

function addCop(x, y, a, extra = {}) {
  const c = makeCar('police', x, y, a);
  Object.assign(c, { police: true, managed: true, hp: 150, cop: { deployed: false, waitT: 0, away: null, block: 0 } }, extra);
  G.cars.push(c);
  police.cars.push(c);
  return c;
}

// A cruiser on a lane 220-420 m from Kimchi (today's 1500-3000 px on the grid), out of his sight when
// possible, facing along its route to him. At 4-5 stars every other one is an interceptor.
function spawnCopCar() {
  const tgt = G.player.car || G.player;
  if (!roads.randomLanePoint) return null;
  const [rMin, rMax] = TUNE.spawn;
  let p = null;
  for (const hidden of [true, false]) {
    p = roads.randomLanePoint({ x: tgt.x, y: tgt.y, rMin, rMax, minGap: 12 * M,
      notVisible: (x, y) => !busy(x, y) && !(hidden && sees({ x, y }, tgt)) });
    if (p) break;
  }
  if (!p) return null;
  let { x, y, a } = p;
  const r = roads.route(x, y, tgt.x, tgt.y, { time: true });
  if (r && r.len > 2 * M) {
    // the route leaves by the lane going the right way: start on it, facing along it
    const q = pathPoint(r, Math.min(r.len, 5 * M));
    if (!busy(r.pts[0], r.pts[1])) { x = r.pts[0]; y = r.pts[1]; }
    a = Math.atan2(q.y - y, q.x - x);
  }
  const fast = G.wanted >= 4 && police.cars.filter(c => c.interceptor && !c.wreck).length * 2 < want();
  const c = addCop(x, y, a, fast ? { interceptor: true, hp: 170, tune: { max: 1.3, acc: 1.2 } } : {});
  if (r) setRoute(c, r, tgt.x, tgt.y);
  return c;
}

function deployOfficers(c) {
  c.cop.deployed = true;
  c.cop.waitT = 7;
  for (const s of [-1, 1]) {
    const ox = c.x - Math.sin(c.a) * 34 * s, oy = c.y + Math.cos(c.a) * 34 * s;
    const p = makePed(ox, oy, { role: 'cop', armed: true, hp: 120, look: COP_LOOK, state: 'alert', heading: c.a, cool: 0.6 + Math.random() });
    G.peds.push(p);
    if (s > 0) say(p, pick(['Freeze!', 'Hands where I can see them!', 'Police! Don\'t move!', 'Stop right there!']), 2);
  }
}

// A junction to drive off to: one of the three nearest the car that are more than `away` from Kimchi (so it
// heads away from him rather than past him, and the cruisers do not all head for the same corner), else
// the furthest from him.
function farNode(c, tgt) {
  const far = roads.nodes.filter(n => dist(n, tgt) > TUNE.away).sort((a, b) => dist(a, c) - dist(b, c));
  if (far.length) return far[Math.floor(Math.random() * Math.min(3, far.length))];
  let best = null;
  for (const n of roads.nodes) if (!best || dist(n, tgt) > dist(best, tgt)) best = n;
  return best || { x: c.x + (c.x - tgt.x) * 3, y: c.y + (c.y - tgt.y) * 3 };
}

function driveCop(c, dt) {
  const pl = G.player, tgt = pl.car || pl;
  const d = dist(c, tgt);
  if (G.wanted === 0 || pl.dead) {
    // calls off the chase: drive off to a far junction and disappear once out of sight
    c.cop.block = 0;
    // a new junction when it gets there, or once Kimchi has moved and it is no longer far from him
    const n0 = c.cop.away;
    if (!n0 || dist(c, n0) < 15 * M || dist(n0, tgt) < TUNE.away * 0.8) c.cop.away = farNode(c, tgt);
    const n = c.cop.away;
    const [ax, ay] = roadWaypoint(c, n.x, n.y);
    steerTo(c, dt, ax, ay, { cap: 260, curv: curvatureAhead(c), dodge: true });
    if (d > TUNE.gone && (KIND === 'grid' || d > TUNE.gone * 1.5 || !sees(c, tgt))) c.gone = true;
    return;
  }
  c.cop.away = null;
  if (c.cop.block > 0) { holdRoadblock(c, dt, d); return; }
  if (c.cop.deployed && (c.cop.waitT -= dt) > 0 && d < 1100) {
    steerTo(c, dt, tgt.x, tgt.y, { stopWithin: 9999 });
    return;
  }
  const close = d < 560 && sees(c, tgt);
  const lead = pl.car ? 0.35 : 0;
  let ax = tgt.x + (tgt.vx || 0) * lead, ay = tgt.y + (tgt.vy || 0) * lead, curv = 0;
  if (!close) { [ax, ay] = roadWaypoint(c, tgt.x, tgt.y); curv = curvatureAhead(c); }
  // cars ram a fleeing car, but pull up short of Kimchi on foot and let the officers get out
  steerTo(c, dt, ax, ay, { corner: close ? 400 : 230, stopWithin: pl.car || !close ? 0 : 190, curv, dodge: true, ignore: pl.car });
  const slow = !pl.car || Math.hypot(pl.car.vx, pl.car.vy) < 70;
  if (!c.cop.deployed && d < 300 && slow) deployOfficers(c);
  if (c.cop.deployed && d > 1500) c.cop.deployed = false;   // lost them on foot; ready to deploy again later
}

// ---------- roadblocks (3+ stars) ----------

// Two cruisers angled across Kimchi's road 280-400 m ahead of him (1400-2600 px on the grid), out of his
// sight when possible. Only while he drives; one at a time, standing for 25 s.
function placeRoadblock(tgt) {
  const [b0, b1] = TUNE.block;
  const path = predictPath(tgt, b1);
  if (!path || path.len < b0) return false;
  const p = {};
  let spot = null;
  for (const hidden of [true, false]) {
    for (let s = path.len; s >= b0 && !spot; s -= 10 * M) {
      pathPoint(path, s, p);
      const cars = blockCars(p);
      if (cars && !(hidden && sees(p, tgt))) spot = { x: p.x, y: p.y, cars };
    }
    if (spot) break;
  }
  if (!spot) return false;
  const cars = spot.cars.map(([x, y, a]) => addCop(x, y, a));
  for (const c of cars) c.cop.block = BLOCK_T;
  police.roadblock = { cars, x: spot.x, y: spot.y, t: BLOCK_T };
  return true;
}

// Where the two cruisers stand at a point on the way: [[x, y, a] x2], or null when it is in a junction, the
// spot is taken or a car would not fit. A road with one lane each way is blocked from curb to curb; on a
// wider road they close Kimchi's side.
function blockCars(p) {
  const near = roads.nearest(p.x, p.y, { maxD: 12 * M });
  if (!near) return null;
  const e = roads.edges[near.edge];
  if (near.s < e.trimA + 8 * M || near.s > e.len - e.trimB - 8 * M) return null;
  const i = Math.min(near.i, e.n - 1), dir = Math.cos(p.a) * e.tx[i] + Math.sin(p.a) * e.ty[i] >= 0 ? 1 : -1;
  const tx = e.tx[i] * dir, ty = e.ty[i] * dir, rx = -ty, ry = tx;   // travel direction and its right
  const lanes = e.oneway ? e.lanesF + e.lanesB : dir > 0 ? e.lanesF : e.lanesB, half = e.median / 2;
  const [lo, hi] = e.oneway ? [-lanes * e.laneW / 2, lanes * e.laneW / 2]
    : lanes >= 2 ? [half, half + lanes * e.laneW] : [-(half + e.laneW), half + e.laneW];
  const a0 = Math.atan2(ty, tx), out = [], probe = { type: 'police' };
  for (const [f, turn] of [[0.27, -1], [0.73, 1]]) {
    const off = lo + (hi - lo) * f, x = near.x + rx * off, y = near.y + ry * off;
    if (busy(x, y, 90)) return null;
    // noses angled in toward the middle and toward Kimchi; less steeply where the road edge is a wall
    const ang = [1.05, 0.7, 0.35].map(k => a0 + Math.PI + turn * k).find(a => !carHits(probe, x, y, a));
    if (ang == null) return null;
    out.push([x, y, ang]);
  }
  return out;
}

// A roadblock cruiser stays put (shoved cars still slide and stop), and its officers get out when Kimchi
// pulls up to it.
function holdRoadblock(c, dt, d) {
  c.cop.block -= dt;
  moveCar(c, dt, false);
  carCollisions(c);
  const pl = G.player, slow = !pl.car || Math.hypot(pl.car.vx, pl.car.vy) < 70;
  if (!c.cop.deployed && d < 300 && slow) deployOfficers(c);
}

function updateRoadblock(dt, tgt) {
  const rb = police.roadblock;
  if (rb) {
    rb.cars = rb.cars.filter(c => G.cars.includes(c) && !c.wreck && c.hp > 0);
    if ((rb.t -= dt) <= 0 || !rb.cars.length || G.wanted < 3) {
      for (const c of rb.cars) c.cop.block = 0;    // back to the chase
      police.roadblock = null;
      police.blockT = BLOCK_GAP;
    }
    return;
  }
  police.blockT -= dt;
  const pc = G.player.car;
  if (G.wanted >= 3 && pc && Math.hypot(pc.vx, pc.vy) > 8 * M && police.blockT <= 0) {
    if (!placeRoadblock(tgt)) police.blockT = 2;    // nowhere fits yet: look again in a moment
  }
}

export function updatePolice(dt) {
  const pl = G.player, tgt = pl.car || pl;
  police.cars = police.cars.filter(c => G.cars.includes(c));
  for (const c of police.cars) {
    if (c.wreck || c.hp <= 0) { c.managed = false; continue; }
    driveCop(c, dt);
  }
  if (police.cars.some(c => c.gone)) {
    G.cars = G.cars.filter(c => !c.gone);
    police.cars = police.cars.filter(c => !c.gone);
  }
  const active = police.cars.filter(c => !c.wreck && c.hp > 0);
  const chasing = active.filter(c => !(c.cop.block > 0));
  if (G.wanted > 0 && !pl.dead && chasing.length < want() && (police.spawnT -= dt) <= 0) {
    spawnCopCar();
    police.spawnT = 2.2;
  }
  if (!pl.dead) updateRoadblock(dt, tgt);

  // seen by any police? if not for long enough, the stars go away
  if (G.heatT > 0) G.heatT -= dt;
  if (G.wanted > 0 && !pl.dead) {
    const seen = G.heatT > 0 || active.some(c => dist(c, tgt) < TUNE.see && sees(c, tgt)) ||
      G.peds.some(p => p.role === 'cop' && p.state !== 'down' && dist(p, tgt) < TUNE.seeFoot && sees(p, tgt));
    if (seen) { G.evadeT = 0; police.search = null; police.lastSeen = { x: tgt.x, y: tgt.y }; }
    else {
      // the minimap draws the area they are searching: around where they last saw him
      const at = police.lastSeen || tgt;
      police.search = { x: at.x, y: at.y, r: TUNE.see };
      if ((G.evadeT += dt) > 6 + 2.5 * G.wanted) { G.wanted = 0; G.evadeT = 0; police.search = null; G.notice?.('⭐ You lost the cops'); }
    }
  } else police.search = null;

  // busted: boxed in by a cruiser while stopped in a car, or an officer right next to you on foot
  if (G.wanted > 0 && !pl.dead) {
    const officer = G.peds.some(p => p.role === 'cop' && p.state !== 'down' && p.state !== 'knocked' && dist(p, tgt) < (pl.car ? 70 : 42));
    const near = officer || (pl.car && active.some(c => dist(c, tgt) < 95));
    const still = pl.car ? Math.hypot(pl.car.vx, pl.car.vy) < 25 : !pl.moving;
    police.bustT = near && still ? police.bustT + dt : Math.max(0, police.bustT - dt * 2);
    if (police.bustT > (pl.car ? 2.2 : 1.8)) { pl.dead = 'busted'; police.bustT = 0; }
  } else police.bustT = 0;

  // siren volume from the nearest chasing car
  let nearest = Infinity;
  if (G.wanted > 0) for (const c of active) nearest = Math.min(nearest, dist(c, tgt));
  setSiren(nearest < Infinity ? clamp(1 - nearest / TUNE.siren, 0, 1) : 0);

  updateSpray();
}

// K-Spray: drive into its bay to repaint, repair and shake the cops. A car a mission wants resprayed
// (c.sprayJob, Grand Theft Cavallo) is always done, even once the cops have lost it on the way and it has
// no damage to repair.
function updateSpray() {
  const pl = G.player, c = pl.car, bay = places.spray?.bay;
  if (!c || !bay) { police.sprayLock = false; return; }
  const inside = Math.hypot(c.x - bay.x, c.y - bay.y) < bay.r;
  if (!inside) { police.sprayLock = false; return; }
  if (police.sprayLock) return;
  police.sprayLock = true;
  if (G.wanted === 0 && c.hp >= 100 && !c.sprayJob) { G.notice?.('🎨 K-Spray: come back when you need a paint job.'); return; }
  if (G.money < 2500) { G.notice?.('🎨 K-Spray: $2,500 for a respray. Come back with cash.'); return; }
  G.money -= 2500;
  c.hp = Math.max(c.hp, 100); c.burnT = 0; c.sprayJob = false;
  const colors = (CAR_TYPES[c.type].lux ? LUX_COLORS : CAR_COLORS).filter(x => x !== c.color);
  c.color = pick(colors);
  c.repaint = true;
  if (c.owned) G.paint[c.type] = c.color;
  const hadStars = G.wanted > 0;
  G.wanted = 0; G.evadeT = 0; G.heatT = 0;
  G.notice?.(hadStars ? '🎨 New paint, new plates. The cops lost you! (-$2,500)' : '🎨 Good as new! (-$2,500)');
  G.sprayed = (G.sprayed || 0) + 1;
}

export function resetPolice() {
  G.cars = G.cars.filter(c => !c.police || c.wreck);
  G.peds = G.peds.filter(p => p.role !== 'cop');
  police.cars = [];
  police.bustT = 0;
  police.search = null; police.lastSeen = null;
  police.roadblock = null; police.blockT = 0;
  G.wanted = 0; G.evadeT = 0; G.heatT = 0;
  setSiren(0);
}
