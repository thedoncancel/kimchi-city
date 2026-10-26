import * as THREE from 'three';
import { G } from '../state.js';
import { places, mapImage, regions, regionAt, roads, KIND, PX_PER_M } from '../world.js';
import { CAR_TYPES } from '../data.js';
import { mapPins, mapPicture } from '../ui.js';
import { police } from './police.js';
import { clamp } from '../util.js';

const $ = id => document.getElementById(id);

// ---------- floating labels (name tags, speech bubbles) ----------
const layer = $('labels');
const pool = [];
let used = 0;
const v = new THREE.Vector3();

export function beginLabels() { used = 0; }

export function label(camera, W, H, x, y, z, text, cls, color = null, maxDist = 45) {
  v.set(x, y, z);
  const dist = v.distanceTo(camera.position);
  if (dist > maxDist) return;
  v.applyMatrix4(camera.matrixWorldInverse);
  if (v.z > -0.5) return;
  v.applyMatrix4(camera.projectionMatrix);
  const sx = (v.x * 0.5 + 0.5) * W, sy = (-v.y * 0.5 + 0.5) * H;
  if (sx < -120 || sx > W + 120 || sy < -60 || sy > H + 60) return;
  let el = pool[used];
  if (!el) { el = document.createElement('div'); layer.appendChild(el); pool.push(el); }
  used++;
  if (el._t !== text) { el.textContent = text; el._t = text; }
  if (el._c !== cls) { el.className = 'lbl ' + cls; el._c = cls; }
  if (el._bg !== color) { el.style.background = color || ''; el._bg = color; }
  const fade = Math.max(0, Math.min(1, (maxDist - dist) / 10));
  el.style.opacity = fade.toFixed(2);
  el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
  el.style.display = '';
}

export function endLabels() {
  for (let i = used; i < pool.length; i++) if (pool[i].style.display !== 'none') pool[i].style.display = 'none';
}

// ---------- round minimap that turns with the camera ----------
let mapImg = null;     // the world's map picture: { canvas, k (picture px per sim px), x0, y0 (its corner in sim px) }
const MM_RANGE = 2600; // sim px from centre to edge (always on the grid; on v2 at walking pace)
// Kimchi Key v2 (the grid's minimap stays exactly as it was): the range opens with speed, from MM_RANGE below
// MM_V0 to MM_FAR at MM_V1 (m/s), easing over MM_EASE s, so at 50 m/s it still shows about 9 s of road ahead.
// As it opens the map slides forward, Kimchi up to MM_AHEAD of the radius below the middle.
const V2 = KIND === 'v2';
const MM_FAR = 7200, MM_V0 = 10, MM_V1 = 50, MM_EASE = 0.7, MM_AHEAD = 0.35;
const mm = { range: MM_RANGE, t: null };

export function drawMinimap(camYaw, heading, givers = [], photos = []) {
  const c = $('minimap'), x = c.getContext('2d');
  const S = c.width, R = S / 2;
  const p = G.player;
  mapPins.givers = givers; mapPins.photos = photos;   // the big map shows them too
  if (V2) updateV2Hud();
  const range = V2 ? mm.range : MM_RANGE;
  const k = R / range;             // canvas px per sim px
  const ahead = V2 ? R * MM_AHEAD * (range - MM_RANGE) / (MM_FAR - MM_RANGE) : 0;   // canvas px Kimchi sits below the middle
  // v2 draws from the copy of the picture that suits the range (see ui.mapPicture), so roads do not flicker
  const pic = V2 ? mapPicture(k * PX_PER_M) : (mapImg ||= mapImage());
  const imgK = pic.k;
  const rot = -Math.PI / 2 - camYaw;
  x.clearRect(0, 0, S, S);
  x.save();
  x.beginPath(); x.arc(R, R, R - 1, 0, Math.PI * 2); x.clip();
  x.fillStyle = '#2b6f8a'; x.fillRect(0, 0, S, S);
  x.translate(R, R + ahead);
  x.rotate(rot);
  x.scale(k / imgK, k / imgK);
  x.translate((pic.x0 - p.x) * imgK, (pic.y0 - p.y) * imgK);
  x.imageSmoothingEnabled = true;
  x.drawImage(pic.canvas, 0, 0);
  x.restore();
  if (V2) drawSearchAndRoute(x, R, k, rot, ahead);

  const toScreen = (px, py) => {
    const dx = (px - p.x) * k, dy = (py - p.y) * k;
    const c1 = Math.cos(rot), s1 = Math.sin(rot);
    return [R + dx * c1 - dy * s1, R + ahead + dx * s1 + dy * c1];
  };
  const blip = (px, py, r, color, clampEdge = false, ring = '#fff') => {
    let [sx, sy] = toScreen(px, py);
    const dx = sx - R, dy = sy - R, d = Math.hypot(dx, dy);
    if (d > R - 8) { if (!clampEdge) return; sx = R + dx / d * (R - 8); sy = R + dy / d * (R - 8); }
    x.fillStyle = ring; x.beginPath(); x.arc(sx, sy, r + 1.8, 0, Math.PI * 2); x.fill();
    x.fillStyle = color; x.beginPath(); x.arc(sx, sy, r, 0, Math.PI * 2); x.fill();
  };
  for (const pl of Object.values(places)) blip(pl.door.x, pl.door.y, 4.5, pl.color, pl.key === 'home');
  for (const f of G.friends) if (!f.inCar) blip(f.x, f.y, 3.4, f.def.look.shirt, false);
  if (G.ownedCar && G.player.car !== G.ownedCar) blip(G.ownedCar.x, G.ownedCar.y, 3.6, '#f2c230', true, '#1b1512');
  if (G.job) blip(G.job.b.door.x, G.job.b.door.y, 5.5 + Math.sin(G.t * 6) * 1.2, '#ff5a3a', true);
  for (const s of photos) blip(s.x, s.y, 3.6, '#ff5fa2', false, '#fff');
  // story mission givers: yellow circles with the caller's initial
  for (const gv of givers) {
    let [sx, sy] = toScreen(gv.x, gv.y);
    const dx = sx - R, dy = sy - R, d = Math.hypot(dx, dy);
    if (d > R - 10) { sx = R + dx / d * (R - 10); sy = R + dy / d * (R - 10); }
    x.fillStyle = '#1b1512'; x.beginPath(); x.arc(sx, sy, 9, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#f2c230'; x.beginPath(); x.arc(sx, sy, 7.5, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#1b1512'; x.font = '900 10px ui-rounded, system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(gv.letter, sx, sy + 0.5);
  }
  for (const m of G.missionBeacons || []) {
    if (m.faint) continue;
    blip(m.x, m.y, m.small ? 3.6 : 5.5 + Math.sin(G.t * 6) * 1.2, m.color.slice(0, 7), !m.small, m.small ? '#1b1512' : '#fff');
  }
  // police (flashing) and armed enemies on foot
  const flash = Math.floor(G.t * 6) % 2 ? '#ff3b30' : '#3b6bff';
  for (const c of G.cars) if (c.police && !c.wreck) blip(c.x, c.y, 4, flash, G.wanted > 0, '#fff');
  for (const pd of G.peds) {
    if (!pd.role || pd.state === 'down') continue;
    if (pd.role === 'cop' && G.wanted > 0) blip(pd.x, pd.y, 2.8, flash, false, '#fff');
    else if (pd.role === 'rival' && pd.aggro) blip(pd.x, pd.y, 2.8, '#e23b2b', false, '#fff');
  }

  // player arrow
  x.save();
  x.translate(R, R + ahead);
  x.rotate(heading + rot);
  x.fillStyle = '#ffffff'; x.strokeStyle = '#1b1512'; x.lineWidth = 2;
  x.beginPath(); x.moveTo(9, 0); x.lineTo(-6, 6.5); x.lineTo(-2.5, 0); x.lineTo(-6, -6.5); x.closePath();
  x.fill(); x.stroke();
  x.restore();

  // north marker on the rim
  const na = rot - Math.PI / 2;
  const nx = R + Math.cos(na) * (R - 11), ny = R + Math.sin(na) * (R - 11);
  x.fillStyle = '#1b1512'; x.beginPath(); x.arc(nx, ny, 8, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#fff'; x.font = '900 10px ui-rounded, system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText('N', nx, ny + 0.5);
}

// Kimchi Key v2, once a frame from drawMinimap: the range, the GPS route, the region popup and what the big
// map shares. Timed by the game clock, so nothing moves while the game is paused.
function updateV2Hud() {
  const dt = mm.t == null ? 0 : clamp(G.t - mm.t, 0, 0.1);
  mm.t = G.t;
  const car = G.player.car, v = car ? Math.hypot(car.vx, car.vy) / PX_PER_M : 0;
  const f = clamp((v - MM_V0) / (MM_V1 - MM_V0), 0, 1);
  const want = MM_RANGE + (MM_FAR - MM_RANGE) * f * f * (3 - 2 * f);
  mm.range += (want - mm.range) * (1 - Math.exp(-dt / MM_EASE));
  updateGps();
  updateRegion(dt);
  mapPins.gps = gps.pts ? gps : null;
  mapPins.search = police.search;
}

// The police search area (flashing red and blue) and the GPS route, in sim px under the minimap's own turn.
function drawSearchAndRoute(x, R, k, rot, ahead) {
  const q = police.search, p = G.player;
  if (!q && !gps.pts) return;
  x.save();
  x.beginPath(); x.arc(R, R, R - 1, 0, Math.PI * 2); x.clip();
  x.translate(R, R + ahead); x.rotate(rot); x.scale(k, k); x.translate(-p.x, -p.y);
  x.lineJoin = 'round'; x.lineCap = 'round';
  if (q) {
    x.beginPath(); x.arc(q.x, q.y, q.r, 0, Math.PI * 2);
    x.fillStyle = 'rgba(226,59,43,.18)'; x.fill();
    x.lineWidth = 3 / k; x.strokeStyle = Math.floor(G.t * 3) % 2 ? '#ff3b30' : '#3b6bff'; x.stroke();
  }
  if (gps.pts) {
    x.beginPath(); x.moveTo(p.x, p.y);
    for (let i = gps.i + 1; i < gps.n; i++) x.lineTo(gps.pts[2 * i], gps.pts[2 * i + 1]);
    x.strokeStyle = 'rgba(27,21,18,.72)'; x.lineWidth = 10 / k; x.stroke();
    x.strokeStyle = gps.color; x.lineWidth = 6 / k; x.stroke();
  }
  x.restore();
}

// ---------- GPS (Kimchi Key v2): the drive to the mission target or the delivery, along the roads ----------
const GPS_EVERY = 1;                 // s of game time: the route is worked out again at most this often
const GPS_NEW = 150 * PX_PER_M;      // px: a target this far from the last one is a new target
const GPS_TOL = 0.75 * PX_PER_M;     // px: the line drawn keeps within this of the route, with far fewer points
const GPS_LOOK = 80 * PX_PER_M;      // px of route ahead searched each frame for where Kimchi has got to
// pts: [x0,y0,x1,y1...] px from the road nearest Kimchi to the target; i: the point he has passed (the line
// is drawn from him to pts[i + 1] on); t, tx, ty: when and for which target it was worked out.
export const gps = { pts: null, n: 0, i: 0, color: '#ff5a3a', t: -Infinity, tx: 0, ty: 0, routes: 0 };

// The main mission beacon (not an enemy's small arrow, not the faint gate after next), else the delivery: its
// kerb to route to, then its door.
function gpsTarget() {
  for (const m of G.missionBeacons || []) if (!m.small && !m.faint) return { x: m.x, y: m.y, color: m.color.slice(0, 7) };
  if (G.job) { const b = G.job.b, at = b.curb || b.door; return { x: at.x, y: at.y, end: b.door, color: '#ff5a3a' }; }
  return null;
}

function updateGps() {
  const tg = gpsTarget(), p = G.player;
  if (!tg) { gps.pts = null; return; }
  // a new target drops the old line at once; its own comes with the next route
  if (gps.pts && Math.hypot(tg.x - gps.tx, tg.y - gps.ty) > GPS_NEW) gps.pts = null;
  if (G.t >= gps.t && G.t - gps.t < GPS_EVERY) { if (gps.pts) gpsProgress(p); return; }
  gps.t = G.t; gps.tx = tg.x; gps.ty = tg.y; gps.color = tg.color; gps.routes++;
  const r = roads.route?.(p.x, p.y, tg.x, tg.y, { time: true });
  if (!r || r.pts.length < 4) { gps.pts = null; return; }
  gps.pts = thinRoute(r.pts, tg.end || tg, GPS_TOL);
  gps.n = gps.pts.length / 2; gps.i = 0;
  gpsProgress(p);
}

// Moves gps.i to the route segment Kimchi is on, looking GPS_LOOK px down the route: the first segment within
// 12 m that he has not passed the end of, so a hairpin's far leg never takes over while he is on the near
// one; failing that, the nearest.
function gpsProgress(p) {
  const P = gps.pts, near = 12 * PX_PER_M;
  let best = Infinity, bi = gps.i, run = 0;
  for (let j = gps.i; j < gps.n - 1 && run < GPS_LOOK; j++) {
    const q = project(p.x, p.y, P[2 * j], P[2 * j + 1], P[2 * j + 2], P[2 * j + 3]);
    if (q.d < near && q.t < 1) { bi = j; break; }
    if (q.d < best) { best = q.d; bi = j; }
    run += Math.hypot(P[2 * j + 2] - P[2 * j], P[2 * j + 3] - P[2 * j + 1]);
  }
  gps.i = bi;
}

// (x, y) against the segment a-b: t, how far along it the nearest point is (0..1), and d, the distance to it
const proj = { t: 0, d: 0 };
function project(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  proj.t = L > 0 ? clamp(((x - ax) * dx + (y - ay) * dy) / L, 0, 1) : 0;
  proj.d = Math.hypot(x - ax - dx * proj.t, y - ay - dy * proj.t);
  return proj;
}
const segDist = (x, y, ax, ay, bx, by) => project(x, y, ax, ay, bx, by).d;

// The route's points with the end point added, thinned by Douglas-Peucker (distance to the segment, so a route
// that doubles back keeps its turn) to within tol px.
function thinRoute(pts, end, tol) {
  const n = pts.length / 2 + 1, X = new Float64Array(n), Y = new Float64Array(n), keep = new Uint8Array(n);
  for (let i = 0; i < n - 1; i++) { X[i] = pts[2 * i]; Y[i] = pts[2 * i + 1]; }
  X[n - 1] = end.x; Y[n - 1] = end.y;
  keep[0] = keep[n - 1] = 1;
  const stack = [0, n - 1];
  while (stack.length) {
    const b = stack.pop(), a = stack.pop();
    let worst = tol, wi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(X[i], Y[i], X[a], Y[a], X[b], Y[b]);
      if (d > worst) { worst = d; wi = i; }
    }
    if (wi >= 0) { keep[wi] = 1; stack.push(a, wi, wi, b); }
  }
  let m = 0;
  for (let i = 0; i < n; i++) m += keep[i];
  const out = new Float32Array(m * 2);
  for (let i = 0, o = 0; i < n; i++) if (keep[i]) { out[o++] = X[i]; out[o++] = Y[i]; }
  return out;
}

// ---------- region name popup (Kimchi Key v2) ----------
// When Kimchi has been in a new region for REGION_SETTLE s its name shows at the top for REGION_SHOW s. The sea
// (and a causeway's open water) keeps the region he came from, so crossing a bridge does not flash 'Sea'.
const REGION_SETTLE = 1.2, REGION_SHOW = 3.2;
const rg = { el: null, name: null, shown: null, cand: null, t: 0, show: 0 };

function updateRegion(dt) {
  const id = regionAt(G.player.x, G.player.y);
  if (id && id !== 'sea') {
    if (id !== rg.cand) { rg.cand = id; rg.t = 0; }
    else if (id !== rg.shown && (rg.t += dt) >= REGION_SETTLE) { rg.shown = id; showRegion(id); }
  }
  if (rg.show > 0 && (rg.show -= dt) <= 0) rg.el.style.opacity = '0';
}

function showRegion(id) {
  const r = regions.find(q => q.id === id);
  if (!r) return;
  if (!rg.el) {
    const el = document.createElement('div'), small = document.createElement('small'), name = document.createElement('b');
    // below the radio name, which sits lower on a phone
    el.style.cssText = `position:absolute;left:50%;top:${window.innerWidth < 700 ? 34 : 21}%;transform:translateX(-50%);`
      + 'text-align:center;pointer-events:none;opacity:0;transition:opacity .6s;text-shadow:0 2px 4px #000;white-space:nowrap';
    small.style.cssText = 'display:block;font:800 12px/1.3 ui-rounded,system-ui,sans-serif;letter-spacing:.32em;color:#d4af37';
    name.style.cssText = 'display:block;font:900 30px/1.1 ui-rounded,system-ui,sans-serif;letter-spacing:.06em;color:#fff;text-transform:uppercase';
    small.textContent = 'KIMCHI KEY';
    el.append(small, name);
    $('hud').appendChild(el);
    rg.el = el; rg.name = name;
  }
  rg.name.textContent = r.name;
  rg.el.style.opacity = '1';
  rg.show = REGION_SHOW;
}
// the region whose name last showed (for tests and the console)
export const regionShown = () => rg.shown;

// ---------- speedometer ----------
const $speedo = $('speedo'), $kmh = $('kmh'), $carName = $('carName');
let lastK = -1;
export function updateSpeedo(car, ms) {
  if (!car) { if (!$speedo.classList.contains('hidden')) $speedo.classList.add('hidden'); return; }
  $speedo.classList.remove('hidden');
  const kmh = Math.round(Math.abs(ms) * 3.6);
  if (kmh !== lastK) { $kmh.textContent = kmh; lastK = kmh; }
  const name = CAR_TYPES[car.type].name + (car.owned ? ' ★' : '');
  if ($carName.textContent !== name) $carName.textContent = name;
}

// ---------- arrow toward the delivery when it is off screen ----------
const $arrow = $('jobArrow');
export function updateJobArrow(camera, W, H, target) {
  if (!target) { $arrow.style.display = 'none'; return; }
  v.copy(target).applyMatrix4(camera.matrixWorldInverse);
  const behind = v.z > 0;
  v.applyMatrix4(camera.projectionMatrix);
  let sx = v.x, sy = v.y;
  if (behind) { sx = -sx; sy = -sy; }
  const on = !behind && Math.abs(sx) < 0.85 && Math.abs(sy) < 0.85;
  if (on) { $arrow.style.display = 'none'; return; }
  const ang = Math.atan2(-sy, sx);
  const m = 0.8 / Math.max(Math.abs(Math.cos(ang)), Math.abs(Math.sin(ang)));
  const ex = (0.5 + Math.cos(ang) * m * 0.5) * W, ey = (0.5 + Math.sin(ang) * m * 0.5) * H;
  $arrow.style.display = '';
  $arrow.style.transform = `translate(${ex}px, ${ey}px) translate(-50%, -50%) rotate(${ang}rad)`;
}

// ---------- GTA layer: wanted stars, health, weapon, crosshair, big text, subtitles ----------

const $wanted = $('wanted'), $stars = [...$wanted.children];
const $health = $('healthBar'), $armor = $('armorBar'), $armorRow = $('armorRow');
const $weapon = $('weapon'), $wIcon = $('wIcon'), $wName = $('wName'), $wAmmo = $('wAmmo'), $fireAmmo = $('fireAmmo');
const $cross = $('crosshair'), $hurt = $('hurt'), $big = $('bigtext'), $subs = $('subs'), $radio = $('radioName');
const last = {};
const put = (key, v, fn) => { if (last[key] !== v) { last[key] = v; fn(v); } };

export function updateGtaHud({ weapon, reloading, aiming, enemyAim, spread, inCar }) {
  put('wanted', G.wanted, (n) => {
    $stars.forEach((s, i) => s.classList.toggle('on', i < n));
    $wanted.classList.remove('bump'); void $wanted.offsetWidth; if (n > 0) $wanted.classList.add('bump');
  });
  put('wflash', G.wanted > 0 && G.evadeT > 1.5, (f) => $wanted.classList.toggle('flash', f));
  put('hp', Math.ceil(G.health), (h) => { $health.style.width = `${h}%`; $health.classList.toggle('low', h < 30); });
  put('ar', Math.ceil(G.armor), (a) => { $armor.style.width = `${a}%`; $armorRow.classList.toggle('hidden', a <= 0); });
  const ammo = weapon.mag ? `${G.clip[weapon.id] || 0}<i> / ${G.ammo[weapon.id] || 0}</i>` : '';
  put('wpn', weapon.id + ammo, () => {
    $wIcon.textContent = weapon.icon; $wName.textContent = weapon.name; $wAmmo.innerHTML = ammo;
    if ($fireAmmo) $fireAmmo.textContent = weapon.mag ? `${G.clip[weapon.id] || 0}/${G.ammo[weapon.id] || 0}` : '';
  });
  put('rel', !!reloading, (r) => $weapon.classList.toggle('reloading', r));
  put('cross', !!aiming, (a) => $cross.classList.toggle('hidden', !a));
  put('crossE', !!enemyAim, (e) => $cross.classList.toggle('enemy', e));
  put('crossW', !!spread, (w) => $cross.classList.toggle('wide', w));
  put('incar', !!inCar, (c) => document.body.classList.toggle('incar', c));
  const low = G.health < 30 && !G.player.dead ? 0.25 + Math.sin(G.t * 5) * 0.12 : 0;
  const hurt = Math.min(0.9, Math.max(G.hurtFlash || 0, low));
  put('hurt', hurt.toFixed(2), (h) => { $hurt.style.opacity = h; });
}

let bigT = 0;
export function bigText(title, sub = '', color = '#e23b2b', secs = 3, small = false) {
  $big.querySelector('b').textContent = title;
  $big.querySelector('b').style.color = color;
  $big.querySelector('small').textContent = sub;
  $big.classList.toggle('small', small);
  $big.classList.remove('hidden');
  $big.style.animation = 'none'; void $big.offsetWidth; $big.style.animation = '';
  bigT = secs;
}
let subT = 0;
export function subtitle(who, text, color = '#fff', secs = 3) {
  if (!who) { $subs.classList.add('hidden'); subT = 0; return; }
  $subs.innerHTML = '';
  const b = document.createElement('b');
  b.style.color = color;
  b.textContent = who + ': ';
  $subs.append(b, document.createTextNode(text));
  $subs.classList.remove('hidden');
  subT = secs;
}
let radioT = 0;
export function radioPopup(name, tag) {
  $radio.innerHTML = '';
  const b = document.createElement('b'), s = document.createElement('small');
  b.textContent = '📻 ' + name; s.textContent = tag || '';
  $radio.append(b, s);
  $radio.classList.add('show');
  radioT = 2.6;
}
export function tickHudTimers(dt) {
  if (bigT > 0 && (bigT -= dt) <= 0) $big.classList.add('hidden');
  if (subT > 0 && (subT -= dt) <= 0) $subs.classList.add('hidden');
  if (radioT > 0 && (radioT -= dt) <= 0) $radio.classList.remove('show');
}
export function clearBigText() { bigT = 0; $big.classList.add('hidden'); }
