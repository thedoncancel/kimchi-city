// The open-world layer of Kimchi Key (spec §5.5, §5.6; stage S8), the Forza part of the game:
//  - speed traps: the speed Kimchi's car crosses the trap's line at;
//  - speed zones: the average speed over a stretch of road, from its start line to its end;
//  - drift zones: points for sliding through a stretch of road (slip angle x speed, chained into combos);
//  - danger-sign jumps: how far the car flies from the lip, and for how long;
//  - the race board at Kimchi Fest: timed events along the world's routes, gate by gate, against the clock;
//  - fast-travel hubs: discovered on the first visit, then a click on the big map takes Kimchi there (free).
// Every pass scores up to three stars, and the best one is kept in G.pr (state.js; save.js writes it, so a 2D
// session keeps it too): traps {best km/h}, zones {best km/h or points}, jumps {best m, air s}, events {best s,
// splits}, found {day}, each with the stars it earned. A star earned for the first time pays.
// The grid world has no activities, so all of this sits idle there. The module loads in plain node (the s8
// tests): no three and no page at load; the game's UI comes in through initActivities, and the small HUD
// (index.html #actLive, #actPop) is only touched when there is a page.
import { G } from '../state.js';
import { KIND, activities, routes, places, roads } from '../world.js';
import { circleBlocked, carHits } from '../entities.js';
import { missionState } from './missions.js';

const V2 = KIND === 'v2';
const M = 16;                    // sim px per metre
const KMH = 3.6 / M;             // px/s to km/h

// What the game gives this module (main3d): toast(text, ms), sound('coin'|'yay'|'fail'|'tick'|'go'|'click'),
// menu(builder) and closeMenu() (ui.js menus), travel({x, y, a}, {car, done}) (fade, move Kimchi or his car
// there, then call done(true), or done(false) when he could not go), save(), celebrate(x, y) (confetti at a
// sim point).
const ui = { toast() {}, sound() {}, menu: null, closeMenu() {}, travel: null, save() {}, celebrate() {} };
export function initActivities(hooks) { Object.assign(ui, hooks); }

// ---------- names and star marks ----------

// Each activity's name and the marks for one, two and three stars: traps and speed zones in km/h, jumps in
// metres, drift zones in points per metre of zone, events in seconds (less is better). They were measured with
// a bot (tools/s8_events_calibrate.mjs and tools/s8_test.mjs): the Toro Ursa every game starts with tops out at
// 157 km/h and earns two stars on most of them; the third asks for a supercar (200-220 km/h) or a cleaner line.
const INFO = {
  st_runway: { name: 'Runway Straight', stars: [120, 150, 190] },
  st_deco: { name: 'Deco Avenue', stars: [115, 145, 185] },
  st_coral: { name: 'Coral Way', stars: [110, 140, 180] },
  sz_causeway: { name: 'North Causeway', stars: [120, 145, 175] },
  sz_rick: { name: 'Rickenbacker', stars: [110, 140, 175] },
  sz_key: { name: 'Key Loop', stars: [95, 122, 140] },
  dz_switch: { name: 'Heights Switchbacks', stars: [3, 8, 14] },
  dz_yard: { name: 'Port Yard', stars: [3, 8, 14] },
  dz_fest: { name: 'Fest Ring', stars: [3, 8, 14] },
  dz_light: { name: 'Lighthouse Bends', stars: [3, 8, 14] },
  j_crest: { name: 'Crest Road', stars: [20, 38, 52] },
  j_gator: { name: 'Gator Run', stars: [18, 36, 50] },
  j_levee: { name: 'Levee', stars: [18, 36, 50] },
  j_port: { name: 'Container Ramp', stars: [15, 28, 40] },
};
// The bot's clean runs with no traffic, taking bends at 0.8 of the 2 g grip: Ursa / Bolide runway 16.7 / 12.3 s,
// deco 29.8 / 25.9, hillclimb 39.1 / 38.5, glades 58.4 / 54.5, key 45.4 / 43.1, the Loop 101 / 86. Two stars
// sit just above the Ursa's time, three near the Bolide's (at 0.95 of the grip: 25.1, 36.7, 53.7, 41.6, 83).
const EVENTS = {
  bay_loop: { name: 'Kimchi Loop Lap', blurb: 'One lap of the Loop round the whole county', stars: [135, 106, 90] },
  hillclimb: { name: 'Heights Hillclimb', blurb: 'Up the switchbacks to the villa gate', stars: [52, 41, 37.5] },
  deco_sprint: { name: 'Deco Sprint', blurb: 'Collins and Ocean Drive to South Pointe', stars: [40, 31, 26.5] },
  glades_scramble: { name: 'Glades Scramble', blurb: 'Two laps of dirt, jumps and Coral Way', stars: [78, 61, 55.5] },
  runway_drag: { name: 'Runway Drag', blurb: '680 m flat out down the runway', stars: [22, 17.5, 13.5] },
  key_coastal: { name: 'Key Coastal', blurb: 'The Rickenbacker and a lap of the Key', stars: [60, 47.5, 43] },
};
const EVENT_ORDER = ['runway_drag', 'deco_sprint', 'hillclimb', 'glades_scramble', 'key_coastal', 'bay_loop'];
const STAR_PAY = { traps: 1000, zones: 1500, jumps: 1000, events: 5000 };   // $ for each star earned the first time

const HUB_R = 55 * M;            // a hub is discovered within this of its spot
const TRAP_CD = 2.5;             // s before the same trap reads the car again
const GATE_SLACK = 10 * M;       // an event gate counts this far past its ends (a corner cut, a wide line)
const BOARD_R = 9 * M;           // E opens the race board within this of the kiosk
const ZONE_OFF = { speedZone: 20 * M, driftZone: 22 * M };   // how far from the zone's line still counts as in it
const OFF_T = 1;                 // s outside the zone before the run is lost

// ---------- the activities, indexed once the world is generated ----------

let I = null;
function index() {
  if (I) return I;
  I = { traps: [], zones: [], jumps: [], hubs: [], board: null };
  for (const a of activities) {
    if (a.type === 'speedTrap') {
      const near = roads.nearest?.(a.x, a.y, { maxD: 40 * M }), e = near && roads.edges[near.edge];
      I.traps.push({ ...a, ...INFO[a.id], hw: (e ? e.halfW : 8 * M) + 4 * M, fx: Math.cos(a.a), fy: Math.sin(a.a) });
    } else if (a.type === 'speedZone' || a.type === 'driftZone') {
      const P = a.pts, n = P.length / 2;
      const closed = Math.hypot(P[0] - P[2 * n - 2], P[1] - P[2 * n - 1]) < 4 * M;
      I.zones.push({ ...a, ...INFO[a.id], n, closed, drift: a.type === 'driftZone', start: lineAt(P, 0, 1), end: lineAt(P, n - 1, -1) });
    } else if (a.type === 'jump') I.jumps.push({ ...a, ...INFO[a.id], fx: Math.cos(a.a), fy: Math.sin(a.a) });
    else if (a.type === 'hub') I.hubs.push(a);
    else if (a.type === 'eventBoard') I.board = a;
  }
  return I;
}
// A start or finish line across a zone's polyline at point i, facing the way a run through it goes (dir).
function lineAt(P, i, dir) {
  const n = P.length / 2, j = Math.min(n - 1, Math.max(0, i + dir)), k = j === i ? i - dir : i;
  let fx = P[2 * j] - P[2 * k], fy = P[2 * j + 1] - P[2 * k + 1];
  if (j === i) { fx = -fx; fy = -fy; }
  const l = Math.hypot(fx, fy) || 1;
  return { x: P[2 * i], y: P[2 * i + 1], fx: fx / l, fy: fy / l, hw: 14 * M };
}

// Whether a move from a to b crossed line L (through L.x, L.y, facing L.fx, L.fy): forward 1, backward -1, or
// 0 when it did not cross within hw of the line's middle. The line counts as half a metre past where it is
// drawn, so a car put right on it (an event's start on a zone's line) still crosses it when it drives off.
const EDGE = M / 2;
function crossing(L, a, b, hw = L.hw) {
  const da = (a.x - L.x) * L.fx + (a.y - L.y) * L.fy, db = (b.x - L.x) * L.fx + (b.y - L.y) * L.fy;
  const fwd = da < EDGE && db >= EDGE, back = da > -EDGE && db <= -EDGE;
  if (!fwd && !back) return 0;
  const f = da / (da - db), x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f;
  if (Math.abs(-(x - L.x) * L.fy + (y - L.y) * L.fx) > hw) return 0;
  return fwd ? 1 : -1;
}

// ---------- state ----------

// slide, slip: the car's slide (see slide()); car: the car being watched (Kimchi's), prev: where it was last frame; trapT: trap cool-downs; zone: the zone
// run going on; jump: the jump in the air; wasAir: the car was off the ground last frame; event: the race
// board event; pops: popups waiting; live: what the live panel shows.
const S = { slide: 0, slip: 0, slideA: 0, slideCar: null, car: null, prev: { x: 0, y: 0 }, trapT: {}, zone: null, jump: null, wasAir: false, event: null, pops: [], said: [], pop: null, live: null };
export const activityState = S;

const pr = (table) => (G.pr ||= {})[table] ||= {};
export const isFound = (id) => !!G.pr?.found?.[id];

// Stars earned by a score against marks [one, two, three]; for events (less is better) by a time.
function starsFor(marks, v, less = false) {
  let n = 0;
  for (const m of marks) if (less ? v <= m : v >= m) n++;
  return n;
}

// Keeps a new result in G.pr[table][id] when it beats the record; pays for stars earned the first time.
// Returns { better, prev, stars, pay }.
function record(table, id, value, stars, extra = {}, less = false) {
  const T = pr(table), old = T[id];
  const better = !old || !(old.best != null) || (less ? value < old.best : value > old.best);
  const newStars = Math.max(0, stars - (old?.stars || 0));
  const pay = newStars * STAR_PAY[table];
  if (better || newStars) T[id] = { ...old, ...(better ? { best: value, ...extra } : {}), stars: Math.max(stars, old?.stars || 0) };
  if (pay) G.money += pay;
  if (better || pay) ui.save();
  return { better: better && !!old, first: !old, prev: old?.best, stars, pay };
}

// ---------- once a frame ----------

const wrecked = (c) => c.wreck || c.hp <= 0;
const speedOf = (c) => Math.hypot(c.vx, c.vy);

export function updateActivities(dt) {
  if (!V2 || G.mode !== 'play') return;
  index();
  const p = G.player;
  if (!p.dead) discover(p);
  const c = p.car && !p.dead && !wrecked(p.car) ? p.car : null;
  if (S.event) updateEvent(dt, c);
  if (c !== S.car) {
    S.car = c; S.wasAir = false; S.jump = null;
    if (S.zone) endZone('left');
    if (c) { S.prev.x = c.x; S.prev.y = c.y; }
  }
  slide(dt, c);
  if (c && dt > 0) {
    const counting = S.event?.phase === 'count' || S.event?.phase === 'travel';
    if (!counting) {
      for (const k in S.trapT) if ((S.trapT[k] -= dt) <= 0) delete S.trapT[k];
      traps(c);
      zones(dt, c);
      jumps(dt, c);
    }
    S.prev.x = c.x; S.prev.y = c.y;
  }
  G.activityText = S.event ? eventText(S.event) : null;
  // toasts (tips, phone notices) wait out the trip to the start and the countdown (ui.js)
  G.holdToasts = !!S.event && (S.event.phase === 'travel' || S.event.phase === 'count');
  hud(dt);
}
// How far Kimchi's car slides off its line (rad, + turning right), for the drift score and for main3d, which
// yaws the car's body by it. The driving model (entities.driveCar) carries no sideways slip: the car goes where
// its nose points, and the handbrake (c.drift) lets it turn at up to 1.35 x the 2 g a car grips at. So the
// slide is read from how hard it turns: a handbrake turn over 0.4 g, or any turn over 1.7 g, slides by
// 20 degrees a g (11 without the handbrake), up to 50, easing in at 8/s and out at 4/s. In the air, below 8 m/s
// or reversing there is none. S.slip, what the drift score counts, is the larger of that and the real angle
// between the car's nose and where it is going (after a knock).
const SLIDE_MAX = 50 * Math.PI / 180;
function slide(dt, c) {
  if (c !== S.slideCar) { S.slideCar = c; S.slideA = c?.a; S.slide = 0; S.slip = 0; }
  if (!c || !(dt > 0)) return;
  let da = c.a - S.slideA;
  da -= Math.round(da / (2 * Math.PI)) * 2 * Math.PI;
  S.slideA = c.a;
  const v = speedOf(c) / M, fwd = (c.vx * Math.cos(c.a) + c.vy * Math.sin(c.a)) / M, lat = (-c.vx * Math.sin(c.a) + c.vy * Math.cos(c.a)) / M;
  const g = Math.abs(da / dt) * v / 9.81;
  let want = 0;
  if (!(c.air > 0) && fwd > 8 && ((c.drift && g > 0.4) || g > 1.7)) want = Math.min(SLIDE_MAX, g * (c.drift ? 20 : 11) * Math.PI / 180) * Math.sign(da);
  S.slide += (want - S.slide) * Math.min(1, dt * (Math.abs(want) > Math.abs(S.slide) ? 8 : 4));
  S.slip = Math.max(Math.abs(S.slide), fwd > 8 ? Math.min(SLIDE_MAX, Math.atan2(Math.abs(lat), fwd)) : 0);
}

// Where main3d draws Kimchi's car in a slide: the whole car turned into the bend by `slide` (rad) about its
// front axle, `front` m ahead of its middle, so the tail swings out while the nose stays on the sim's line. Gives
// the drawn middle (sim px) and heading, and the sim's body height (c.gy) moved by the ground's rise between the
// sim's middle and the drawn one, so a car on a hill still reads as touching the ground there (cars.js seat).
const POSE = { x: 0, y: 0, a: 0, gy: undefined };
export function slidePose(c, slide, front, ground) {
  const f = front * M, a = c.a + slide;
  POSE.x = c.x + f * (Math.cos(c.a) - Math.cos(a));
  POSE.y = c.y + f * (Math.sin(c.a) - Math.sin(a));
  POSE.a = a;
  POSE.gy = Number.isFinite(c.gy) ? c.gy + ground(POSE.x, POSE.y) - ground(c.x, c.y) : c.gy;
  return POSE;
}

// ---------- hubs ----------

function discover(p) {
  for (const h of I.hubs) {
    if (isFound(h.id) || Math.hypot(h.x - p.x, h.y - p.y) > HUB_R) continue;
    pr('found')[h.id] = { day: G.day || 1 };
    ui.save();
    // the villa is home: found from the first step, without a fanfare
    if (h.id === 'villa') continue;
    ui.sound('yay');
    pop({ kind: 'FAST TRAVEL UNLOCKED', value: h.name, sub: 'Open the map (M) and click it to come back here', tone: 'hub' });
  }
}

// ---------- speed traps ----------

function traps(c) {
  for (const t of I.traps) {
    if (S.trapT[t.id] || !crossing(t, S.prev, c, t.hw)) continue;
    S.trapT[t.id] = TRAP_CD;
    const kmh = Math.round(speedOf(c) * KMH);
    if (kmh < 20) continue;
    const stars = starsFor(t.stars, kmh), r = record('traps', t.id, kmh, stars);
    result({ kind: `SPEED TRAP · ${t.name}`, value: kmh, unit: 'km/h', r, fmt: (v) => `${v} km/h` });
  }
}

// ---------- speed and drift zones ----------

// A run starts when the car crosses the zone's start line going in (either end of an open zone, either way
// round a closed one), follows the zone's line (station by station, with a little search window so a
// hairpin's other leg is never taken for this one) and ends at the far end. Leaving the zone for OFF_T,
// stopping or taking too long loses it.
function zones(dt, c) {
  if (S.zone) { stepZone(dt, c); return; }
  if (speedOf(c) < 5 * M) return;
  for (const z of I.zones) {
    let dir = crossing(z.start, S.prev, c);
    if (dir < 0 && !z.closed) dir = 0;
    if (!dir && !z.closed && crossing(z.end, S.prev, c) > 0) dir = -1;
    if (dir) { beginZone(z, dir, c); return; }
  }
}
function beginZone(z, dir, c) {
  const i = dir > 0 ? 0 : z.n - 1;
  S.zone = { z, dir, i, s: z.s[i], done: 0, t: 0, off: 0, slow: 0, pts: 0, chain: 0, chainT: 0, gap: 0, mult: 1, hp: c.hp };
  ui.sound('tick');
}
// An event that starts on a zone's line (the hillclimb at the foot of the switchbacks) starts the zone at the
// GO: the car stands within 4 m of the line, facing in.
function zoneFromStandstill(c) {
  if (S.zone) return;
  const fx = Math.cos(c.a), fy = Math.sin(c.a);
  for (const z of I.zones) {
    // [line, the run's direction, the line's facing (-1: the other way round a closed zone)]
    for (const [L, dir, f] of [[z.start, 1, 1], [z.end, -1, 1], ...(z.closed ? [[z.start, -1, -1]] : [])]) {
      const lx = L.fx * f, ly = L.fy * f, u = (c.x - L.x) * lx + (c.y - L.y) * ly, w = -(c.x - L.x) * ly + (c.y - L.y) * lx;
      if (Math.abs(u) < 4 * M && Math.abs(w) < L.hw && fx * lx + fy * ly > 0.7) { beginZone(z, dir, c); return; }
    }
  }
}

function stepZone(dt, c) {
  const Z = S.zone, z = Z.z;
  Z.t += dt;
  // the nearest point of the zone's line within 12 points (24 m) of the last one
  let bi = Z.i, bd = Infinity;
  for (let k = -12; k <= 12; k++) {
    let j = Z.i + k;
    if (z.closed) j = (j + z.n) % z.n; else if (j < 0 || j >= z.n) continue;
    const d = Math.hypot(z.pts[2 * j] - c.x, z.pts[2 * j + 1] - c.y);
    if (d < bd) { bd = d; bi = j; }
  }
  let ds = z.s[bi] - Z.s;
  if (z.closed && Math.abs(ds) > z.len / 2) ds -= Math.sign(ds) * z.len;
  Z.done += ds * Z.dir; Z.i = bi; Z.s = z.s[bi];
  Z.off = bd > ZONE_OFF[z.type] ? Z.off + dt : 0;
  Z.slow = speedOf(c) < 2 * M ? Z.slow + dt : 0;
  if (z.drift) drift(dt, c, Z);
  if (Z.off > OFF_T) return endZone('left');
  if (Z.slow > 4 || Z.done < -20 * M || Z.t > z.len / (3 * M) + 15) return endZone('lost');
  if (Z.done >= z.len - 8 * M) endZone('done');
}

// Drift points: every moment the car slides 8 degrees or more off its line (S.slide) above 8 m/s scores slip
// (degrees) x speed (m/s) a second into the running chain. A chain grows its multiplier by 0.5 for every 2.5 s
// it lasts (up to x3) and is banked 1.2 s after the slide ends; a knock (the car taking damage) loses the
// chain. The total is banked points plus the chain at the end.
function drift(dt, c, Z) {
  const v = speedOf(c), slip = S.slip * 180 / Math.PI;
  if (c.hp < Z.hp - 2) { Z.chain = 0; Z.chainT = 0; Z.mult = 1; Z.gap = 0; Z.crash = 1; }
  Z.hp = c.hp;
  if (v > 8 * M && slip >= 8) {
    Z.chain += slip * (v / M) * dt;
    Z.chainT += dt;
    Z.mult = Math.min(3, 1 + Math.floor(Z.chainT / 2.5) * 0.5);
    Z.gap = 0;
  } else if (Z.chain > 0 && (Z.gap += dt) > 1.2) bank(Z);
}
function bank(Z) {
  Z.pts += Z.chain * Z.mult;
  Z.chain = 0; Z.chainT = 0; Z.mult = 1; Z.gap = 0;
}

function endZone(why) {
  const Z = S.zone, z = Z.z;
  S.zone = null;
  if (why !== 'done') {
    if (Z.done > 30 * M) { ui.sound('fail'); pop({ kind: z.drift ? 'DRIFT ZONE' : 'SPEED ZONE', value: why === 'left' ? 'Left the zone' : 'Zone lost', sub: z.name, tone: 'fail', short: true }); }
    return;
  }
  if (z.drift) {
    bank(Z);
    const pts = Math.round(Z.pts), stars = starsFor(z.stars.map(m => m * z.len / M), pts);
    // driving through without a slide scores nothing; the first time, a hint how to drift
    if (pts < 50) {
      if (G.seen && !G.seen.driftHint) { G.seen.driftHint = true; pop({ kind: `DRIFT ZONE · ${z.name}`, value: 'No drift', sub: 'Hold the handbrake (Space) into the bends to slide', tone: 'fail', short: true }); }
      return;
    }
    const r = record('zones', z.id, pts, stars);
    result({ kind: `DRIFT ZONE · ${z.name}`, value: pts.toLocaleString('en-US'), unit: 'pts', r, fmt: (v) => `${Math.round(v).toLocaleString('en-US')} pts` });
  } else {
    const kmh = Math.round(z.len / Z.t * KMH), stars = starsFor(z.stars, kmh), r = record('zones', z.id, kmh, stars);
    result({ kind: `SPEED ZONE · ${z.name}`, value: kmh, unit: 'km/h avg', r, fmt: (v) => `${v} km/h` });
  }
}

// ---------- jumps ----------

// A take-off within 6 m before to 16 m past a jump's lip, going its way, starts a jump; the landing scores
// how far the car came down from the lip (m) and how long it flew. Hops under 0.25 s or 3 m don't count.
function jumps(dt, c) {
  const air = c.air > 0;
  if (S.jump) {
    S.jump.t += dt;
    if (!air) {
      const J = S.jump, j = J.j;
      S.jump = null;
      const m = Math.round(Math.hypot(c.x - j.x, c.y - j.y) / M * 10) / 10, t = Math.round(J.t * 100) / 100;
      if (J.t >= 0.25 && m >= 3) {
        const stars = starsFor(j.stars, m), r = record('jumps', j.id, m, stars, { air: t });
        result({ kind: `DANGER SIGN · ${j.name}`, value: m.toFixed(1), unit: 'm', r, fmt: (v) => `${v.toFixed(1)} m`, extra: `${t.toFixed(2)} s air` });
      }
    } else if (S.jump.t > 8) S.jump = null;
  } else if (air && !S.wasAir) {
    for (const j of I.jumps) {
      const dx = c.x - j.x, dy = c.y - j.y, u = dx * j.fx + dy * j.fy, w = -dx * j.fy + dy * j.fx;
      const v = speedOf(c), along = v > 0 ? (c.vx * j.fx + c.vy * j.fy) / v : 0;
      if (u > -6 * M && u < 16 * M && Math.abs(w) < 9 * M && along > 0.5) { S.jump = { j, t: c.air }; break; }
    }
  }
  S.wasAir = air;
}

// ---------- results and popups ----------

// The popup for a scored pass: the value, its stars and, for a new record, the record it beat and any pay.
function result({ kind, value, unit, r, fmt, extra }) {
  const parts = [];
  if (r.better) parts.push(`was ${fmt(r.prev)}`);
  else if (!r.first && r.prev != null) parts.push(`record ${fmt(r.prev)}`);
  if (extra) parts.unshift(extra);
  if (r.pay) parts.push(`+$${r.pay.toLocaleString('en-US')}`);
  const best = r.better || r.first;
  ui.sound(best ? 'yay' : r.stars ? 'coin' : 'tick');
  if (best && S.car) ui.celebrate(S.car.x, S.car.y);
  pop({ kind, value: String(value), unit, stars: r.stars, pr: r.better ? 'NEW RECORD' : r.first ? 'FIRST RECORD' : null, sub: parts.join(' · '), tone: best ? 'pr' : 'ok' });
}

function pop(p) {
  // three waiting at most: the oldest score goes first (a hub found is kept, see hud)
  if (S.pops.length >= 3) S.pops.splice(Math.max(0, S.pops.findIndex(q => q.tone !== 'hub')), 1);
  S.pops.push(p);
  S.said.push(p);                       // every popup, for the tests and KC3.activities
  if (S.said.length > 12) S.said.shift();
}

// ---------- the race board ----------

// Near the Fest kiosk on foot: E opens the board (main3d asks boardNear before it hands E to the usual targets).
// In a car E keeps getting out: the road runs past the kiosk inside BOARD_R.
export function boardNear() {
  if (!V2) return false;
  const b = index().board, p = G.player;
  return !!b && !S.event && !p.dead && !p.car && Math.hypot(b.x - p.x, b.y - p.y) < BOARD_R;
}
export function openBoard() {
  if (!ui.menu) return;
  ui.menu(() => {
    const items = EVENT_ORDER.filter(id => routes[id]).map((id) => {
      const E = EVENTS[id], R = routes[id], rec = G.pr?.events?.[id];
      const n = rec?.stars || 0;
      return { icon: '🏁', label: `${E.name} · ${(R.len * (R.laps || 1) / M / 1000).toFixed(1)} km`, desc: `${E.blurb}\u00a0· ${boardTimes(E, rec)}`,
        right: `<span class="actStars">${'★'.repeat(n)}<i>${'★'.repeat(3 - n)}</i></span>`,
        action: () => { ui.closeMenu(); startEvent(id); } };
    });
    return { icon: '🏁', title: 'Kimchi Fest Race Board', sub: 'Pick an event: you and your car go straight to the start line',
      sections: [{ label: 'Events', items }] };
  });
}

// The board's times for an event: the record and the next star to get, or the three-star time before there is
// a record. Non-breaking spaces keep each mark whole when the line wraps.
function boardTimes(E, rec) {
  const nb = (t) => t.replace(/ /g, '\u00a0');
  if (rec?.best == null) return nb(`★★★ ${fmtTime(E.stars[2])}`);
  const n = rec.stars || 0;
  return nb(`best ${fmtTime(rec.best)}`) + (n < 3 ? ' · ' + nb(`${'★'.repeat(n + 1)} ${fmtTime(E.stars[n])}`) : '');
}

// Why Kimchi can't start an event or travel now, or null.
function busyReason(what) {
  const p = G.player;
  if (p.dead) return '💫 Not now.';
  if (S.event) return `🏁 Finish or leave ${EVENTS[S.event.id].name} first.`;
  if (missionState.active) return `⭐ Not during a story mission: finish it first.`;
  if (G.wanted > 0) return `🚨 Lose the cops before you ${what}.`;
  // a delivery's clock keeps running: no free hop next to the door, and no race while the food goes cold
  if (G.job) return `🛵 Finish the delivery first (or cancel it on your phone).`;
  return null;
}

// Starts a race board event: Kimchi and a car (his, or one of his own from the villa) go to the start line,
// then a 3 s countdown with the car held, then the clock runs until the last gate.
export function startEvent(id) {
  const R = routes[id];
  if (!V2 || !R || !EVENTS[id]) return false;
  const why = busyReason('race');
  if (why) { ui.toast(why, 3500); ui.sound('fail'); return false; }
  const E = S.event = { id, R, phase: 'travel', count: 0, t: 0, pi: 0, n: 0, splits: [], car: null, delta: null, deltaT: 0 };
  const pose = startPose(R);
  // main3d's travel says done(false, 'nocar') when Kimchi has no car of his own that can drive (he stays put)
  const go = (there = true, why) => {
    if (S.event !== E) return;
    E.car = G.player.car;
    if (!there || !E.car) {
      S.event = null;
      if (why === 'nocar' || (there && !E.car)) { ui.toast('🚗 No car to race in: buy one at the dealer or get in one first.', 3800); ui.sound('fail'); }
      return;
    }
    arm(E);
  };
  if (ui.travel) ui.travel(pose, { car: true, done: go });
  else go();
  return true;
}
// The start: the route's first point, facing along it (its first 6 m)
function startPose(R) {
  const P = R.pts, n = P.length / 2;
  let k = 1;
  while (k < n - 1 && Math.hypot(P[2 * k] - P[0], P[2 * k + 1] - P[1]) < 6 * M) k++;
  return { x: P[0], y: P[1], a: Math.atan2(P[2 * k + 1] - P[1], P[2 * k] - P[0]) };
}
function arm(E) {
  const R = E.R, laps = R.laps || 1;
  // a gate right on the start line is behind the car already
  const g0 = R.gates[0], first = Math.hypot(g0.x - R.pts[0], g0.y - R.pts[1]) < 5 * M ? 1 : 0;
  E.gates = [];
  for (let l = 0; l < laps; l++) for (let k = 0; k < R.gates.length; k++) if (l || k >= first) E.gates.push(R.gates[k]);
  E.n = E.gates.length;
  E.phase = 'count'; E.count = 3.5; E.pi = 0; E.t = 0;
  E.prev = { x: E.car.x, y: E.car.y };
  E.rec = G.pr?.events?.[E.id] || null;
}

function updateEvent(dt, c) {
  const E = S.event;
  if (E.phase === 'travel') return;
  if (!c || c !== E.car) return endEvent('abandoned');
  if (missionState.active) return endEvent('abandoned');
  // heat is not allowed in an event (busyReason would not have let it start): the cops end it
  if (G.wanted > 0) return endEvent('abandoned', 'The cops are on you: lose them, then pick it again at the board');
  if (E.phase === 'count') {
    c.vx = c.vy = 0; c.speed = 0;
    const before = Math.ceil(E.count);
    E.count -= dt;
    if (Math.ceil(E.count) !== before && E.count > 0) ui.sound('tick');
    if (E.count <= 0) { E.phase = 'run'; ui.sound('go'); E.goT = 1; zoneFromStandstill(c); }
    E.prev.x = c.x; E.prev.y = c.y;
    return;
  }
  E.t += dt;
  if (E.goT > 0) E.goT -= dt;
  if (E.deltaT > 0) E.deltaT -= dt;
  const g = E.gates[E.pi];
  if (crossing({ x: g.x, y: g.y, fx: Math.cos(g.a), fy: Math.sin(g.a) }, E.prev, c, g.w / 2 + GATE_SLACK) > 0) {
    E.splits.push(Math.round(E.t * 100) / 100);
    const old = E.rec?.splits?.[E.pi];
    if (old != null) { E.delta = E.t - old; E.deltaT = 2.5; }
    E.pi++;
    if (E.pi >= E.n) { endEvent('done'); return; }
    ui.sound('coin');
  }
  E.prev.x = c.x; E.prev.y = c.y;
  // a run that has gone badly astray (ten minutes) is called off
  if (E.t > 600) endEvent('abandoned');
}

function endEvent(why, sub = 'Pick it again at the Fest race board') {
  const E = S.event, info = EVENTS[E.id];
  S.event = null;
  G.activityText = null;
  if (why !== 'done') {
    ui.sound('fail');
    pop({ kind: info.name.toUpperCase(), value: 'Event abandoned', sub, tone: 'fail', short: true });
    return;
  }
  const t = Math.round(E.t * 100) / 100, stars = starsFor(info.stars, t, true);
  const r = record('events', E.id, t, stars, { splits: E.splits }, true);
  result({ kind: `${info.name.toUpperCase()} · FINISH`, value: fmtTime(t), unit: '', r, fmt: fmtTime,
    extra: stars < 3 ? `${'★'.repeat(stars + 1)} at ${fmtTime(info.stars[stars])}` : null });
}
// Leaves the event under way (main3d: Kimchi wasted or busted; the tests).
export function cancelEvent() { if (S.event) endEvent('abandoned'); }
// A new game, or a saved one loaded: nothing under way and nothing left to say.
export function resetActivities() {
  Object.assign(S, { event: null, zone: null, jump: null, wasAir: false, car: null, pop: null, slide: 0, slip: 0, slideCar: null });
  S.pops.length = 0;
  for (const k in S.trapT) delete S.trapT[k];
  G.activityText = null; G.holdToasts = false;
  gapT = 0;
  $('actPop')?.classList.remove('in');
}

function eventText(E) {
  const info = EVENTS[E.id];
  if (E.phase === 'travel') return `🏁 ${info.name}: to the start line…`;
  if (E.phase === 'count') return `🏁 ${info.name}: get ready`;
  const laps = E.R.laps || 1, per = E.n / laps;
  const lap = laps > 1 ? ` · lap ${Math.min(laps, Math.floor(E.pi / per) + 1)}/${laps}` : '';
  return `🏁 ${info.name} · checkpoint ${E.pi + 1}/${E.n}${lap}`;
}

export function fmtTime(s) {
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r.toFixed(2).padStart(5, '0')}`;
}

// ---------- fast travel ----------

// A click on the big map (sim px; scale = css px per sim px, for how near a pin a click must be). A found hub
// takes Kimchi there (returns true, which closes the map); one not yet found says so.
export function onBigMapClick(x, y, scale) {
  if (!V2) return false;
  const reach = Math.max(18 / (scale || 0.05), 25 * M);
  let hub = null, bd = reach;
  for (const h of index().hubs) {
    const d = Math.hypot(h.x - x, h.y - y);
    if (d < bd) { bd = d; hub = h; }
  }
  if (!hub) return false;
  if (!isFound(hub.id)) { ui.toast(`🔒 ${hub.name}: drive there once to unlock fast travel.`, 3500); ui.sound('fail'); return false; }
  return fastTravel(hub.id);
}

export function fastTravel(id) {
  const hub = index().hubs.find(h => h.id === id);
  if (!hub || !isFound(id)) return false;
  const why = busyReason('fast travel');
  if (why) { ui.toast(why, 3500); ui.sound('fail'); return false; }
  const p = G.player, car = !!p.car && !wrecked(p.car);
  const to = car ? carSpot(hub) : footSpot(hub);
  if (!to) return false;
  ui.sound('click');
  const done = (there = true) => there && pop({ kind: 'FAST TRAVEL', value: hub.name, tone: 'hub', short: true });
  if (ui.travel) ui.travel(to, { car, done });
  else done();
  return true;
}

// Where a car arrives: the place's kerb when the hub is a place, else the lane nearest the hub, facing along
// it; the first of them where the car stands clear of walls, else the nearest clear spot round one.
function carSpot(h) {
  const pl = hubPlace(h), tries = [];
  if (pl?.curb) tries.push({ x: pl.curb.x, y: pl.curb.y, a: pl.curb.a ?? 0 });
  const L = roads.nearestLane?.(h.x, h.y);
  if (L) { const q = roads.lanePoint(L.lane, L.s); tries.push({ x: q.x, y: q.y, a: q.a }); }
  tries.push({ x: h.x, y: h.y, a: 0 });
  for (const t of tries) if (!carHits({ type: 'ursa' }, t.x, t.y, t.a)) return t;
  for (const t of tries) {
    for (let d = 16; d <= 12 * M; d += 16) {
      for (let k = 0; k < 16; k++) {
        const b = k * Math.PI / 8, x = t.x + Math.cos(b) * d, y = t.y + Math.sin(b) * d;
        if (!carHits({ type: 'ursa' }, x, y, t.a)) return { x, y, a: t.a };
      }
    }
  }
  return tries[0];
}
// Where Kimchi arrives on foot: the place's foot spot, else the sidewalk nearest the hub (not a crosswalk),
// moved to the nearest spot clear of walls and water, facing the hub.
function footSpot(h) {
  const pl = hubPlace(h);
  if (pl?.foot) return { x: pl.foot.x, y: pl.foot.y, a: pl.foot.a };
  let x = h.x, y = h.y;
  const w = roads.nearestWalk?.(h.x, h.y, 60 * M);
  if (w && !roads.walks?.paths?.[w.path]?.cross) { x = w.x; y = w.y; }
  [x, y] = clearSpot(x, y);
  return { x, y, a: Math.atan2(h.y - y, h.x - x) };
}
function hubPlace(h) {
  if (h.id === 'villa') return places.home;
  for (const pl of Object.values(places)) if (pl.foot && Math.hypot(pl.foot.x - h.x, pl.foot.y - h.y) < 2 * M) return pl;
  return null;
}
export function clearSpot(x, y, r = 8) {
  if (!circleBlocked(x, y - 4, r)) return [x, y];
  for (let d = 8; d <= 8 * M; d += 8) {
    for (let k = 0; k < 16; k++) {
      const a = k * Math.PI / 8, qx = x + Math.cos(a) * d, qy = y + Math.sin(a) * d;
      if (!circleBlocked(qx, qy - 4, r)) return [qx, qy];
    }
  }
  return [x, y];
}

// ---------- markers: in the world and on the big map ----------

// fx marks (main3d merges them with the missions'): during an event its next gate and, faint, the one after;
// otherwise a pink arrow over the race board kiosk when Kimchi is within 150 m.
const marks = [];
export function activityMarks() {
  marks.length = 0;
  if (!V2 || G.mode !== 'play') return marks;
  const E = S.event, p = G.player;
  if (E && E.gates) {
    const g = E.gates[E.pi], g2 = E.gates[E.pi + 1];
    if (g) marks.push({ x: g.x, y: g.y, color: E.pi === E.n - 1 ? '#7be0a0' : '#f2c230', ring: true });
    if (g2) marks.push({ x: g2.x, y: g2.y, color: '#f2c23066', ring: true, faint: true });
  } else if (!E) {
    const b = index().board;
    if (b && Math.abs(b.x - p.x) < 150 * M && Math.abs(b.y - p.y) < 150 * M) marks.push({ x: b.x, y: b.y, color: '#ff5fa2', small: true, h: 4.6 });
  }
  return marks;
}

// Big map pins (ui.js bigMapHooks.pins): hubs (green when found, grey until then), the race board, the speed
// traps, the start of each zone and the jumps, with their records in the labels.
export const MAP_LEGEND = [
  { color: '#2fd47a', label: 'Fast travel (click)' },
  { color: '#16161a', label: 'Race board' },
  { color: '#ff8a1f', label: 'Speed trap' },
  { color: '#38c6f4', label: 'Speed zone' },
  { color: '#7b5cff', label: 'Drift zone' },
  { color: '#9be15d', label: 'Danger sign jump' },
];
export function mapPins() {
  if (!V2) return [];
  const A = index(), out = [];
  const best = (t, id, f) => { const r = G.pr?.[t]?.[id]; return r?.best != null ? ` · ${f(r.best)} ${'★'.repeat(r.stars || 0)}` : ''; };
  for (const t of A.traps) out.push({ x: t.x, y: t.y, color: '#ff8a1f', r: 4, label: `Speed trap${best('traps', t.id, v => `${v} km/h`)}` });
  for (const z of A.zones) out.push({ x: z.pts[0], y: z.pts[1], color: z.drift ? '#7b5cff' : '#38c6f4', r: 4,
    label: `${z.drift ? 'Drift' : 'Speed'} zone · ${z.name}${best('zones', z.id, v => (z.drift ? `${Math.round(v).toLocaleString('en-US')} pts` : `${v} km/h`))}` });
  for (const j of A.jumps) out.push({ x: j.x, y: j.y, color: '#9be15d', r: 4, ring: '#1b1512', label: `Jump${best('jumps', j.id, v => `${v.toFixed(1)} m`)}` });
  if (A.board) out.push({ x: A.board.x, y: A.board.y, color: '#16161a', r: 6.5, ring: '#f2c230', label: '🏁 Race board' });
  for (const h of A.hubs) {
    const f = isFound(h.id);
    out.push({ x: h.x, y: h.y, color: f ? '#2fd47a' : '#7d848c', r: f ? 7 : 5.5, ring: f ? '#fff' : '#1b1512', label: f ? `⚡ ${h.name}` : '🔒 Not yet found' });
  }
  return out;
}

// ---------- the activity HUD (index.html #actLive, #actPop) ----------

const page = typeof document !== 'undefined';
const $ = (id) => (page ? document.getElementById(id) : null);
let shownLive = '', popT = 0, gapT = 0;
const POP_T = { pr: 4.2, ok: 3.2, hub: 3.6, fail: 2.4 };

function hud(dt) {
  // the live panel: a zone or an event under way
  const Z = S.zone, E = S.event;
  let html = E && E.phase !== 'travel' ? eventLive(E) : '';
  if (Z && E?.phase !== 'count') html += (html ? '<hr>' : '') + zoneLive(Z);   // a zone run inside an event shows under it
  if (html !== shownLive) {
    shownLive = html;
    const el = $('actLive');
    if (el) {
      el.innerHTML = html;
      el.classList.toggle('hidden', !html);
      el.classList.toggle('counting', E?.phase === 'count');   // the countdown: big in the middle of the screen
    }
  }
  // popups, one at a time, with a moment between them; none over an event's countdown (they wait for the GO)
  // or over a menu such as the race board (they wait until it closes); a hub found waits out a whole event, so
  // nothing but the race's own scores covers the road while the clock runs
  const hold = (E && (E.phase === 'travel' || E.phase === 'count')) || !!G.menu;
  if (hold && S.pop) { S.pops.unshift(S.pop); S.pop = null; gapT = 0; $('actPop')?.classList.remove('in'); }
  if (S.pop) {
    if ((popT -= dt) <= 0) { S.pop = null; gapT = 0.35; $('actPop')?.classList.remove('in'); }
  } else if (gapT > 0) gapT -= dt;
  else if (S.pops.length && !hold) {
    const i = E ? S.pops.findIndex(p => p.tone !== 'hub') : 0;
    if (i >= 0) showPop(S.pops.splice(i, 1)[0]);
  }
}

function zoneLive(Z) {
  const z = Z.z, pct = Math.max(0, Math.min(100, Z.done / z.len * 100));
  const bar = `<i class="bar"><i style="width:${pct.toFixed(1)}%"></i></i>`;
  const rec = G.pr?.zones?.[z.id]?.best;
  if (z.drift) {
    const chain = Z.chain > 0 ? `<span class="chain">+${Math.round(Z.chain).toLocaleString('en-US')} ×${Z.mult}</span>` : '';
    return `<small>DRIFT ZONE · ${z.name}</small><b>${Math.round(Z.pts).toLocaleString('en-US')}<i>pts</i></b>${chain}${bar}`
      + (rec != null ? `<em>record ${Math.round(rec).toLocaleString('en-US')}</em>` : '');
  }
  const avg = Z.t > 0.2 ? Math.round(Math.max(0, Z.done) / Z.t * KMH) : 0;
  return `<small>SPEED ZONE · ${z.name}</small><b>${avg}<i>km/h avg</i></b>${bar}` + (rec != null ? `<em>record ${rec} km/h</em>` : '');
}

function eventLive(E) {
  const info = EVENTS[E.id];
  if (E.phase === 'count') {
    const n = Math.ceil(E.count);
    // the record above the number, which stands over the car
    return `<small>${info.name.toUpperCase()}</small><em>${E.rec ? `Record ${fmtTime(E.rec.best)}` : `★★★ ${fmtTime(info.stars[2])}`}</em><b class="count">${n > 3 ? 3 : n}</b>`;
  }
  const delta = E.deltaT > 0 && E.delta != null
    ? `<span class="delta ${E.delta <= 0 ? 'ahead' : 'behind'}">${E.delta <= 0 ? '−' : '+'}${Math.abs(E.delta).toFixed(2)}</span>` : '';
  const go = E.goT > 0 ? '<span class="go">GO!</span>' : '';
  return `<small>${info.name.toUpperCase()} · CP ${Math.min(E.pi + 1, E.n)}/${E.n}</small><b>${fmtTime(E.t)}</b>${delta}${go}`
    + `<em>${E.rec ? `record ${fmtTime(E.rec.best)}` : `★★★ ${fmtTime(info.stars[2])}`}</em>`;
}

function showPop(p) {
  S.pop = p;
  popT = (POP_T[p.tone] || 3) * (p.short ? 0.75 : 1);
  const el = $('actPop');
  if (!el) return;
  const stars = p.stars != null ? `<div class="stars">${[0, 1, 2].map(i => `<i class="${i < p.stars ? 'on' : ''}" style="animation-delay:${0.25 + i * 0.16}s">★</i>`).join('')}</div>` : '';
  el.className = `tone-${p.tone}`;
  el.innerHTML = `<small>${p.kind}</small><b>${p.value}${p.unit ? `<i>${p.unit}</i>` : ''}</b>${stars}`
    + (p.pr ? `<div class="pr">${p.pr}</div>` : '') + (p.sub ? `<div class="sub">${p.sub}</div>` : '');
  void el.offsetWidth;   // restart the entry animation
  el.classList.add('in');
}
// For dev screenshots (main3d &act=pop): shows a sample record popup at once.
export function demoPop() {
  S.pops.length = 0; S.pop = null; gapT = 0;
  showPop({ kind: 'SPEED TRAP · Runway Straight', value: '187', unit: 'km/h', stars: 2, pr: 'NEW RECORD', sub: 'was 172 km/h · +$1,000', tone: 'pr' });
}
