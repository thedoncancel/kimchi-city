import * as THREE from 'three';
import { G, resetState } from '../state.js';
// check_exports v2-only: grids, water
import { generate, places, photoSpots, KIND, titleView, BOUNDS, surfaceAt, SHALLOW, roads, routes, grids, water } from '../world.js';
import { CFG, spawnWorld, spawnGarage, spawnOwnedCar, updatePlayer, updateWorld, findTarget, honk, say, makeCar } from '../entities.js';
import { CAR_TYPES, ITEMS } from '../data.js';
import { toast, interact, openInventory, toggleBigMap, menuKey, updateHUD, updateJob, updateJars, onNewDay, drawBigMap, openMenu, closeMenu, fade, bigMapHooks } from '../ui.js';
import { save, load, hasSave } from '../save.js';
import { sfx, engine } from '../audio.js';
import { clamp, angDiff, pick, money, compact } from '../util.js';
import { setAniso } from './textures.js';
import { buildCity, S, MAP, surfaceY, occluderTop, nearestLamps, fountains, sea, clearTreesForCamera, yachts } from './city.js';
import { makeSky } from './sky.js';
import { makeGraphics } from './graphics.js';
import { makeFpsMeter } from './fpsmeter.js';
import { LOW, MODE } from './quality.js';
import { makePerson, animateRig } from './people.js';
import { makeKimchi } from './kimchi.js';
import { loadPhotoChar, makePhotoChar, addPhotoGear, animatePhotoRig, clonePhotoChar } from './photochar.js';
import { loadBestChar3D, makeChar3D, cloneChar3D, addChar3DGear } from './char3d.js';
import { syncCar, setCarNight, setCarLook, setPoliceLights, loadCarModels, carViewFrom, setCarLOD, carFar, CAR_FAR, CAR_HYST, POOL_MAX,
  makeViewPool, makeShadowBox, personLOD, setCasting, carPrewarm, compileFor, wheelGap } from './cars.js';
import { makeFX } from './fx.js';
import { beginLabels, label, endLabels, drawMinimap, updateSpeedo, updateJobArrow, updateGtaHud, bigText, subtitle, radioPopup, tickHudTimers, clearBigText } from './hud3d.js';
import { WEAPONS, ORDER, weaponState, playerFire, reload, selectWeapon, cycleWeapon, updateCombat, updateHostiles, autoTarget, raycast, setCarViewY } from './combat.js';
import { crime, updatePolice, resetPolice, police } from './police.js';
import { initMissions, updateMissions, availableMissions, giverSpot, tryStartAt, missionState, resetMissions } from './missions.js';
import { attachGun, aimPose, carryPose, punchPose, surrenderPose, seatPose } from './guns.js';
import { makeAnimator } from './anim.js';
import { addFace, tickFace } from './face.js';
import { radio } from './radio.js';
import './shops3d.js';
import { photoSpotNear, postPhoto, spotReady } from './lifestyle.js';
import { installBench } from './bench.js';
import { initActivities, updateActivities, activityMarks, onBigMapClick, mapPins, MAP_LEGEND, boardNear, openBoard, startEvent, cancelEvent,
  resetActivities, demoPop, clearSpot, activityState, slidePose } from './activities.js';

const isTouch = window.matchMedia('(pointer: coarse)').matches;
for (const k in WEAPONS) WEAPONS[k].id = k;

// a dev screenshot (see the end of this file) plays a throwaway game: it must never overwrite the player's save
const shotQ = new URLSearchParams(location.search);
const shot = { view: shotQ.get('shot'), hour: +shotQ.get('hour') || 15.5, hud: shotQ.get('hud') === '1', bench: shotQ.get('bench') === '1', drive: shotQ.get('drive') === '1',
  cam: shotQ.get('cam')?.split(',').map(Number).filter(Number.isFinite), route: shotQ.get('route')?.split(',').map(Number).filter(Number.isFinite),
  go: shotQ.get('go')?.split(',').map(Number).filter(Number.isFinite), freeze: shotQ.get('freeze'), frozen: false, act: shotQ.get('act'),
  noact: shotQ.get('noact') === '1', actdrive: shotQ.get('actdrive') === '1', hb: shotQ.get('hb') === '1' };
if (shot.cam?.length !== 6) shot.cam = null;
if (!(shot.route?.length >= 4)) shot.route = null;
if (!(shot.go?.length >= 3)) shot.go = null;
const saveGame = () => { if (!shot.view) save(); };

// ---------- renderer & scene ----------

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: LOW, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = LOW ? 1.05 : 0.92;
setAniso(Math.min(8, renderer.capabilities.getMaxAnisotropy()));

const scene = new THREE.Scene();
// The grid town keeps its old depth range. The v2 county is drawn out to 2.6 km (1.2 km on the phone tier,
// where the fog closes in at 900 m) with the near plane at 0.15 m, which keeps the depth precision for the
// far roads painted on the terrain (spec §11.1).
const V2 = KIND === 'v2';
const camera = new THREE.PerspectiveCamera(62, 1, V2 ? 0.15 : 0.1, V2 ? (LOW ? 1200 : 2600) : 4000);
const gfx = makeGraphics(renderer, scene, camera, { onResolution: () => resize() });
let W = 1, H = 1;
function resize() {
  W = window.innerWidth; H = window.innerHeight;
  renderer.setSize(W, H, false);
  gfx.setSize(W, H);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  if (G.bigMap) drawBigMap();
}
window.addEventListener('resize', resize);
resize();

// soft sky reflections for car paint and glass
if (LOW) (function environment() {
  const pm = new THREE.PMREMGenerator(renderer);
  const es = new THREE.Scene();
  const g = new THREE.SphereGeometry(10, 32, 16);
  const pos = g.attributes.position, cols = [];
  const top = new THREE.Color('#8fbff0'), mid = new THREE.Color('#e9eef2'), bot = new THREE.Color('#5e5a54');
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 10;
    const c = y > 0 ? mid.clone().lerp(top, y) : mid.clone().lerp(bot, Math.min(1, -y * 2));
    cols.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  es.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const sun = new THREE.Mesh(new THREE.SphereGeometry(1.3, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 8, 7) }));
  sun.position.set(5, 6, 3);
  es.add(sun);
  scene.environment = pm.fromScene(es, 0.02).texture;
  pm.dispose();
})();

// ---------- world ----------

// how long the page took to come up (KC3.load, ms since the page started): the world, the city, the first frame
const loadT = { start: Math.round(performance.now()) };
generate();
loadT.generate = Math.round(performance.now() - loadT.start);
// human-scale speeds for 3D (1 sim px = 1/16 m), close to the natural pace of the motion-captured cycles
// (anim.js) so the strides cover the ground: jog 5.5 m/s, sprint 9.4, people strolling 0.94
Object.assign(CFG, { walk: 88, run: 150, tired: 55, playerR: 8, pedWalk: 15, pedFlee: 95, friendWalk: 15, friendRun: 175, aiLook: 125, carAcc: 0.5, carMax: 0.85 });

const city = buildCity(scene);
loadT.buildCity = Math.round(performance.now() - loadT.start - loadT.generate);
const sky = makeSky(scene, { shadowSize: LOW ? 1024 : 2048 });
gfx.sun = sky.sun;
const shadowBox = makeShadowBox(sky.sun);   // cars cast shadows only from inside it (cars.js)
const fpsMeter = makeFpsMeter(gfx, MODE);
const fx = makeFX(scene, { flashLight: !LOW });

const lampLights = [];
for (let i = 0; i < (LOW ? 3 : 6); i++) {
  const l = new THREE.PointLight('#ffc27a', 0, 26, 1.5);
  scene.add(l);
  lampLights.push(l);
}
// lights stay in the scene permanently: adding or removing lights forces every shader to recompile
const headlight = new THREE.SpotLight('#fff1d0', 0, 80, 0.5, 0.55, 1.2);
const headTarget = new THREE.Object3D();
headlight.target = headTarget;
scene.add(headlight, headTarget);
const copLight = new THREE.PointLight('#ff2a2a', 0, 34, 1.4);
if (!LOW) scene.add(copLight);

// the GTA layer reports through these hooks (the 2D game leaves them unset)
G.crime = crime;
G.notice = (msg) => toast(msg, 4500);

// Kimchi: the cartoon model stands in until the 3D model built from the T-pose pictures has loaded
let hero = makeKimchi();
let heroPhoto = false;
hero.root.visible = false;
scene.add(hero.root);
let gearKey = '';
// the modelled 3D character (tools/blender/build_char3d.py) when there is one, else the photo-built one
async function loadHeroRig(name) {
  try { return animated(addChar3DGear(makeChar3D(await loadBestChar3D(name), { height: 1.7 }))); } catch (e) {
    if (name !== 'kimchi' && name.startsWith('kimchi') && outfits.base?.is3d) throw e;   // no photo outfits on the 3D Kimchi
    return animated(addPhotoGear(makePhotoChar(await loadPhotoChar(name, undefined, LOW ? 1024 : 2048), { height: 1.7, detail: LOW ? 0.6 : 1 })));
  }
}
// motion-captured movement (anim.js) for everyone with a skeleton, and a painted face (face.js) where there is one
function animated(rig) {
  rig.anim = makeAnimator(rig);
  if (rig.meta?.face) addFace(rig).catch((e) => console.warn('face failed to load', e));
  return rig;
}
loadHeroRig('kimchi').then((rig) => {
  rig.heading = hero.heading;
  rig.gy = hero.gy;
  rig.root.visible = false;
  attachGun(rig);
  scene.add(rig.root);
  scene.remove(hero.root);
  hero = rig;
  outfits.base = rig;
  heroPhoto = true;
  gearKey = '';
}).catch((err) => console.warn('3D Kimchi failed to load; using the cartoon model', err)).then(loadCast);

// Outfits from the fashion boutique are whole extra models of Kimchi (tools/gen_outfits.py), built on first use.
const outfits = {}, outfitLoading = {};
let heroOutfit = 'base';
function applyOutfit() {
  if (!heroPhoto) return;
  const want = ITEMS[G.equipped.fit]?.outfit || 'base';
  if (want === heroOutfit) return;
  const rig = outfits[want];
  if (!rig) {
    if (!outfitLoading[want]) {
      outfitLoading[want] = true;
      loadHeroRig('kimchi_' + want).then((r) => {
        attachGun(r);
        outfits[want] = r;
      }).catch(() => { outfits[want] = outfits.base; });
    }
    return;
  }
  const old = hero;
  unseat(old);
  Object.assign(rig, { heading: old.heading, gy: old.gy, gyRaw: old.gyRaw, px: old.px, py: old.py, fall: old.fall || 0 });
  rig.root.visible = old.root.visible;
  scene.remove(old.root);
  scene.add(rig.root);
  hero = rig;
  heroOutfit = want;
  gearKey = '';
}

// Friends and pedestrians built from their own T-pose pictures (tools/gen_cast.py + build_char.py).
// Each model is built once and copied per person with its own skeleton; anyone missing stays a cartoon.
const CAST = {
  friends: { mochi: 1.62, bao: 1.7, yuna: 1.6, dex: 1.78 },
  peds: { ped_office: 1.76, ped_grandma: 1.55, ped_redjacket: 1.66, ped_student: 1.66, ped_courier: 1.75, ped_casual: 1.63 },
  cop: { ped_cop: 1.79, ped_cop2: 1.68 },
  rival: { ped_rival: 1.72 },
};
const castRigs = { friends: {}, peds: [], cop: [], rival: [] };
async function loadCast() {
  // the modelled 3D version of each person when there is one, else the photo-built one
  const build = async (name, height, detail, max) => {
    try { return makeChar3D(await loadBestChar3D(name), { height }); } catch (e) { /* fall through */ }
    try { return makePhotoChar(await loadPhotoChar(name, undefined, max), { height, detail }); } catch (e) { return null; }
  };
  const group = (key, detail) => Promise.all(Object.entries(CAST[key]).map(([id, h]) => build(id, h, detail, LOW ? 512 : 1024))).then(l => l.filter(Boolean));
  const friends = await Promise.all(Object.entries(CAST.friends).map(async ([id, h]) => [id, await build(id, h, LOW ? 0.4 : 0.6, 1024)]));
  for (const [id, rig] of friends) if (rig) castRigs.friends[id] = rig;
  [castRigs.peds, castRigs.cop, castRigs.rival] = await Promise.all([group('peds', LOW ? 0.3 : 0.38), group('cop', LOW ? 0.3 : 0.42), group('rival', LOW ? 0.3 : 0.42)]);
  // rebuild the views so everyone picks up their new model (the ones waiting in the pool too)
  for (const r of pedViews.values()) { scene.remove(r.root); dropRig(r); }
  for (const r of friendViews.values()) { unseat(r, true); dropRig(r); }
  pedViews.clear(); friendViews.clear();
  rigPool.clear();
}
function personRig(look, friendId, role) {
  const list = role ? castRigs[role] : castRigs.peds;
  const base = friendId ? castRigs.friends[friendId] : list.length ? list[Math.floor(Math.random() * list.length)] : null;
  if (base) {
    const r = animated(base.is3d ? cloneChar3D(base) : clonePhotoChar(base));
    r.photo = true;
    r.aimK = 0;
    if (!friendId && !role) r.root.scale.setScalar(0.95 + Math.random() * 0.1);
    if (role) attachGun(r).set('pistol');
    return r;
  }
  return makePerson(look, { scale: friendId ? 1.06 : 0.9 + Math.random() * 0.18 });
}

// A rig for a pedestrian (or a cop, or the rival): one of that role waiting in the pool, else a new one. A
// pooled rig gets a fresh animator, so nothing of its last owner's fall, flinch or aim carries over.
function pedRig(ped) {
  const key = ped.role || 'ped';
  let r = rigPool.take(key);
  if (r) {
    if (r.anim) r.anim = makeAnimator(r);
    Object.assign(r, { fall: 0, downAnim: false, hp0: undefined, lastHeading: undefined, aimK: 0, mocap: false, pistol: null });
    const tilt = r.photo ? r.root.children[0] : r.body;
    if (tilt) { tilt.rotation.z = 0; tilt.position.y = 0; }
  } else {
    r = personRig(ped.look, null, ped.role);
    r.poolKey = key;
  }
  r.px = ped.x; r.py = ped.y;
  r.root.position.set(ped.x * S, surfaceY(ped.x, ped.y), ped.y * S);   // (its distance from the camera is read from here)
  return r;
}
// a person rig nobody will use again: its skeleton's bone texture is its own (the model is shared), so free it
function dropRig(r) {
  const seen = new Set();
  r.root.traverse((o) => { if (o.skeleton && !seen.has(o.skeleton)) { seen.add(o.skeleton); o.skeleton.dispose(); } });
}

const carViews = new Map(), pedViews = new Map(), friendViews = new Map();
// Views wait in pools for the next car or person instead of being built again (spec §11.1): car views by
// type, pedestrian rigs by role, at most 40 in each pool. Friends keep their own rigs.
const carPool = makeViewPool(POOL_MAX), rigPool = makeViewPool(POOL_MAX, dropRig);
// shots at a car aim at the car as drawn, which rides the ground smoothly (combat.js)
setCarViewY((c) => carViews.get(c)?.y);
function clearViews() {
  unseat(hero);
  for (const r of friendViews.values()) unseat(r);
  for (const v of carViews.values()) { scene.remove(v.group); carPool.give(v.type, v); }
  for (const r of pedViews.values()) { scene.remove(r.root); rigPool.give(r.poolKey, r); }
  for (const r of friendViews.values()) { scene.remove(r.root); dropRig(r); }
  carViews.clear(); pedViews.clear(); friendViews.clear();
}
// swap in the smooth Blender cars once they arrive (people riding along are reseated next frame), and compile
// their shaders before they are needed
loadCarModels(() => {
  unseat(hero);
  for (const r of friendViews.values()) unseat(r);
  for (const v of carViews.values()) scene.remove(v.group);
  carViews.clear();
  carPool.clear();
  prewarmCars();
});

spawnWorld();
G.player.x = places.home.foot.x; G.player.y = places.home.foot.y;

// ---------- missions ----------

initMissions({
  big: (title, sub, color, secs) => bigText(title, sub, color, secs, title.length > 9),
  sub: (who, text, color, secs) => subtitle(who, text, color, secs),
  notice: (msg) => toast(msg, 5500),
  sound: (k) => (k === 'fail' ? sfx.fail() : k === 'coin' ? sfx.coin() : sfx.yay()),
});
const giverLetter = (m) => (m.steps[0].lines?.[0]?.[0] || m.title)[0];

// ---------- the open-world layer (activities.js): speed traps, zones, jumps, the race board, fast travel ----------

const ACT_SOUND = { coin: () => sfx.coin(), yay: () => sfx.yay(), fail: () => sfx.fail(), tick: () => sfx.click(), go: () => sfx.yay(), click: () => sfx.click() };
initActivities({
  toast: (msg, ms) => toast(msg, ms),
  sound: (k) => ACT_SOUND[k]?.(),
  menu: (builder) => openMenu(builder),
  closeMenu: () => closeMenu(),
  travel: (to, opts) => travel(to, opts),
  save: () => saveGame(),
  // confetti round Kimchi's car for a new record
  celebrate: (x, y) => {
    const v = G.player.car && carViews.get(G.player.car);
    fx.burst(x * S, (v?.y ?? surfaceY(x, y)) + 1.6, y * S, ['#f2c230', '#ff5fa2', '#7be0a0', '#5aa9ff', '#ffffff'], 46, 6.5);
  },
});
// the county map: a click on a found hub travels there; the hubs, traps, zones, jumps and the board are pinned
bigMapHooks.click = (x, y, scale) => onBigMapClick(x, y, scale);
bigMapHooks.pins = mapPins;
bigMapHooks.legend = MAP_LEGEND;

// ---------- input ----------

const keys = {};
const touch = { ax: 0, ay: 0, active: false, run: false, fire: false };
const mouse = { left: false, right: false, locked: false, lockFailed: false };
const GAME_KEYS = ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'];
const cam = { yaw: -Math.PI / 2, pitch: 0.34, zoom: 1, mode: 0, lastDrag: -10, pos: new THREE.Vector3(), look: new THREE.Vector3(), init: false };
const CAM_MODES = ['Chase cam', 'Far cam', 'Top-down cam'];
const jump = { y: 0, v: 0 };
// k: camera blend into over-the-shoulder aiming; pk: arms raised; holdT keeps aiming a moment after a shot
const aim = { k: 0, pk: 0, camOn: false, holdT: 0, autoT: 0, pitch: 0, enemy: false, queued: false, viaMouse: false, kick: 0 };

function press(code) {
  sfx.unlock();
  if (G.mode !== 'play') return;
  if (G.menu) { menuKey(code); return; }
  if (G.bigMap) { if (code === 'KeyM' || code === 'Escape') toggleBigMap(false); return; }
  const p = G.player;
  if (p.dead) return;
  if (code === 'KeyE' || code === 'Enter') { if (boardNear()) openBoard(); else interact(); }
  else if (code === 'KeyI' || code === 'Tab') openInventory();
  else if (code === 'KeyM') toggleBigMap(true);
  else if (code === 'KeyH') honk();
  else if (code === 'KeyC') { cam.mode = (cam.mode + 1) % CAM_MODES.length; toast(`🎥 ${CAM_MODES[cam.mode]}`, 1400); }
  else if (code === 'Space' && !p.car && jump.y === 0 && !(p.knockT > 0)) { jump.v = 5.4; sfx.pop(); }
  else if (code === 'KeyR') {
    if (p.car) radioPopup(radio.next(), radio.tag);
    else reload();
  } else if (code === 'KeyQ') { if (!p.car) cycleWeapon(1); }
  else if (code === 'KeyF') { aim.queued = true; aim.viaMouse = false; }
  else if (code === 'KeyP') {
    const spot = photoSpotNear(p.car || p);
    if (spot) postPhoto(spot);
    else toast('📸 Find a pink photo spot to post a pic (they are on the map).', 3500);
  }
  else if (/^Digit[1-4]$/.test(code) && !p.car) {
    const w = ORDER[+code[5] - 1];
    if (G.weapons[w]) selectWeapon(w);
    else toast(`${WEAPONS[w].icon} No ${WEAPONS[w].name} yet. K-Arms sells them.`, 2500);
  }
}
window.addEventListener('keydown', e => {
  if (GAME_KEYS.includes(e.code) && G.mode === 'play') e.preventDefault();
  if (!keys[e.code]) press(e.code);
  keys[e.code] = true;
});
window.addEventListener('keyup', e => { keys[e.code] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouse.left = mouse.right = false; });

// mouse: the first click locks the pointer (then moving looks around); after that left shoots, right aims
const canLock = !isTouch && 'requestPointerLock' in canvas;
canvas.addEventListener('mousedown', e => {
  if (G.mode !== 'play' || G.menu || G.bigMap) return;
  sfx.unlock();
  if (canLock && !mouse.locked && !mouse.lockFailed) {
    try { const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(() => { mouse.lockFailed = true; }); } catch (err) { mouse.lockFailed = true; }
    return;
  }
  if (e.button === 0) { mouse.left = true; aim.queued = true; aim.viaMouse = true; }
  if (e.button === 2) mouse.right = true;
});
window.addEventListener('mouseup', e => { if (e.button === 0) mouse.left = false; if (e.button === 2) mouse.right = false; });
canvas.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('pointerlockchange', () => {
  mouse.locked = document.pointerLockElement === canvas;
  mouse.left = mouse.right = false;
  if (mouse.locked && !G.seen.mouseLock) {
    G.seen.mouseLock = true;
    toast('🖱️ Mouse locked: move to look · right-click to aim · left-click to shoot · Esc frees the mouse', 6500);
  }
});
document.addEventListener('pointerlockerror', () => { mouse.lockFailed = true; });

function look(dx, dy, sens) {
  cam.yaw += dx * sens;
  cam.pitch = clamp(cam.pitch + dy * sens * 0.75, aim.camOn ? -0.55 : 0.04, 1.3);
  cam.lastDrag = G.t;
}

// drag anywhere on the game to look around (touch, or a mouse that isn't locked), wheel to zoom
let drag = null, wheelAcc = 0;
canvas.addEventListener('pointerdown', e => {
  if (G.mode !== 'play' || mouse.locked) return;
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', e => {
  if (mouse.locked) { if (G.mode === 'play' && !G.menu) look(e.movementX, e.movementY, aim.k > 0.5 ? 0.0017 : 0.0026); return; }
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  look(dx, dy, 0.0065);
});
const endDrag = e => { if (drag && e.pointerId === drag.id) drag = null; };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  if (mouse.locked && !G.player.car && G.mode === 'play') {
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) > 50) { cycleWeapon(Math.sign(wheelAcc)); wheelAcc = 0; }
    return;
  }
  cam.zoom = clamp(cam.zoom * (1 + e.deltaY * 0.001), 0.5, 2.4);
}, { passive: false });

const $touch = document.getElementById('touch');
if (isTouch) {
  const stick = document.getElementById('stick'), knob = document.getElementById('knob');
  let id = null, cx = 0, cy = 0;
  const move = e => {
    if (e.pointerId !== id) return;
    let dx = (e.clientX - cx) / 50, dy = (e.clientY - cy) / 50;
    const m = Math.hypot(dx, dy);
    if (m > 1) { dx /= m; dy /= m; }
    touch.ax = dx; touch.ay = dy;
    knob.style.transform = `translate(${dx * 38}px, ${dy * 38}px)`;
  };
  stick.addEventListener('pointerdown', e => {
    id = e.pointerId; stick.setPointerCapture(id);
    const r = stick.getBoundingClientRect();
    cx = r.left + r.width / 2; cy = r.top + r.height / 2;
    touch.active = true; move(e);
  });
  stick.addEventListener('pointermove', move);
  const end = e => { if (e.pointerId !== id) return; id = null; touch.active = false; touch.ax = touch.ay = 0; knob.style.transform = ''; };
  stick.addEventListener('pointerup', end);
  stick.addEventListener('pointercancel', end);
  $touch.querySelectorAll('button[data-k]').forEach(b => b.addEventListener('pointerdown', e => { e.preventDefault(); press(b.dataset.k); }));
  const hold = (el, key, onDown) => {
    el.addEventListener('pointerdown', e => { e.preventDefault(); sfx.unlock(); touch[key] = true; onDown?.(); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) el.addEventListener(ev, () => { touch[key] = false; });
  };
  hold($touch.querySelector('[data-hold="run"]'), 'run', () => { if (!G.player.car && jump.y === 0) press('Space'); });
  hold(document.getElementById('fireBtn'), 'fire', () => { aim.queued = true; aim.viaMouse = false; });
  document.getElementById('help').textContent = 'Stick to move · drag to look · 🔫 shoot · ⚡ run/handbrake · E interact';
}

// the stick as the body feels it: starting, stopping and breaking into a sprint take a moment
const move = { x: 0, y: 0, sprint: 0 };
function readInput(dt = 0) {
  const p = G.player;
  if (p.dead || p.knockT > 0) { move.x = move.y = move.sprint = 0; return { ax: 0, ay: 0 }; }
  const up = keys.KeyW || keys.ArrowUp, down = keys.KeyS || keys.ArrowDown;
  const left = keys.KeyA || keys.ArrowLeft, right = keys.KeyD || keys.ArrowRight;
  const inp = { up, down, left, right, run: (keys.ShiftLeft || keys.ShiftRight || touch.run) && !aim.camOn, brake: keys.Space || (touch.run && !!p.car) };
  if (p.car) {
    if (touch.active) { inp.up = touch.ay < -0.3; inp.down = touch.ay > 0.35; inp.steer = Math.abs(touch.ax) > 0.12 ? touch.ax : 0; }
  } else {
    let fw = (up ? 1 : 0) - (down ? 1 : 0), rt = (right ? 1 : 0) - (left ? 1 : 0);
    if (touch.active) { fw = -touch.ay; rt = touch.ax; }
    const yaw = cam.mode === 2 && !aim.camOn ? -Math.PI / 2 : cam.yaw;
    let tx = Math.cos(yaw) * fw - Math.sin(yaw) * rt, ty = Math.sin(yaw) * fw + Math.cos(yaw) * rt;
    const L = Math.hypot(tx, ty);
    if (L > 1) { tx /= L; ty /= L; }
    const k = 1 - Math.exp(-dt * (L > 0.1 ? 9 : 11));
    move.x += (tx - move.x) * k; move.y += (ty - move.y) * k;
    move.sprint = inp.run && L > 0.1 ? Math.min(1, move.sprint + dt * 3) : 0;
    // a sprint starts from jogging pace (the sim moves at CFG.run x the stick's length)
    const m = inp.run ? CFG.walk / CFG.run + (1 - CFG.walk / CFG.run) * move.sprint : 1;
    inp.ax = move.x * m; inp.ay = move.y * m;
    if (Math.hypot(move.x, move.y) < 0.16 && L < 0.1) inp.ax = inp.ay = 0;
  }
  return inp;
}
const steerInput = () => (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0) || (touch.active ? touch.ax : 0);

// ---------- game flow ----------

const $title = document.getElementById('title');
const $hud = document.getElementById('hud');
const $continue = document.getElementById('continueBtn');
const $fade = document.getElementById('fade');
if (hasSave()) $continue.classList.remove('hidden');

// Stand Kimchi on a place's foot spot (spec §6.5), facing away from the door, with the camera in front of
// him looking back at him and the building. Every grid foot spot faces south: heading π/2, camera yaw −π/2.
// A spot within his reach of a wall or water would hold him for good (entities.moveChar refuses every step
// while his circle touches one), so he stands on the nearest clear spot.
function standAt(foot) {
  const [x, y] = clearSpot(foot.x, foot.y, CFG.playerR);
  Object.assign(G.player, { x, y, moving: false });
  hero.heading = foot.a;
  cam.yaw = foot.a - Math.PI; cam.pitch = 0.34; cam.init = false;
}

function startGame(cont) {
  sfx.unlock();
  resetState();
  if (cont) load();
  G.player.car = null;
  G.player.dead = null;
  G.player.knockT = 0;
  G.hurtFlash = 0;
  resetMissions();
  resetActivities();
  clearViews();
  spawnWorld();
  resetPolice();
  G.player.face = 1;
  standAt(places.home.foot);
  spawnGarage();
  fx.syncJars(true);
  death.kind = null;
  document.body.classList.remove('dead');
  clearBigText();
  G.mode = 'play';
  $title.classList.add('hidden');
  $hud.classList.remove('hidden');
  if (isTouch) $touch.classList.remove('hidden');
  if (G.luxWelcome) {
    G.luxWelcome = false;
    setTimeout(() => toast('🏝️ Kimchi City got an upgrade: a villa, a Toro Ursa on the drive and $150K to start. Welcome to the luxury life.', 7000), 600);
  }
  if (cont) {
    toast(`Welcome back, Kimchi! Day ${G.day}`);
    const next = availableMissions()[0];
    if (next) setTimeout(() => toast(`⭐ Next story mission: ${next.title} · yellow ${giverLetter(next)} on the map`, 5000), 1800);
  } else {
    toast('👋 Welcome home, Kimchi. The Toro Ursa is on the drive.', 4500);
    setTimeout(() => toast('⭐ See the yellow marker? Walk into it to start your first story mission.', 6000), 2200);
    setTimeout(() => toast('📸 Pink markers are photo spots: press P there to post. Followers bring brand deals.', 6000), 14000);
    setTimeout(() => toast(isTouch ? '👆 Drag the screen to look around' : '🖱️ Click to grab the mouse and look around · C changes camera', 5000), 8500);
  }
}
document.getElementById('newBtn').addEventListener('click', () => startGame(false));
// Graphics switch: the tier is chosen when the page loads, so changing it reloads
for (const b of document.querySelectorAll('#gfxSwitch button')) {
  b.classList.toggle('on', b.dataset.gfx === MODE);
  b.addEventListener('click', () => {
    if (b.dataset.gfx === MODE) return;
    try { localStorage.setItem('kc-gfx', b.dataset.gfx); localStorage.removeItem('kc-gfx-level2'); } catch (e) {}
    const u = new URL(location.href); u.searchParams.delete('gfx'); location.href = u.toString();
  });
}
$continue.addEventListener('click', () => startGame(true));

// WASTED / BUSTED: slow motion, then wake up at the hospital or walk out of the police station
const death = { kind: null, t: 0, faded: false };
function updateDeath(dt) {
  const p = G.player;
  if (!death.kind) {
    death.kind = p.dead; death.t = 0; death.faded = false;
    cancelEvent();
    if (p.car) {
      const c = p.car, off = CAR_TYPES[c.type].wid / 2 + 22;
      p.car = null;
      p.x = c.x - Math.sin(c.a) * off; p.y = c.y + Math.cos(c.a) * off;
      for (const f of G.friends) if (f.inCar) { f.inCar = false; f.x = p.x + 30; f.y = p.y + 10; }
    }
    G.job = null;
    document.body.classList.add('dead');
    const busted = death.kind === 'busted';
    bigText(busted ? 'BUSTED' : 'WASTED', '', busted ? '#5aa9ff' : '#e23b2b', 4.6);
    if (busted) {
      const cop = G.peds.find(c => c.role === 'cop' && c.state !== 'down');
      if (cop) say(cop, pick(["You're under arrest!", 'Hands behind your back!', 'Got you, Kimchi!']), 3);
    }
    sfx.fail();
    engine.set(false);
  }
  death.t += dt;
  if (death.t > 4.2 && !death.faded) { death.faded = true; $fade.classList.add('on'); }
  if (death.t > 5.0) { respawn(death.kind); $fade.classList.remove('on'); }
}

function respawn(kind) {
  const p = G.player;
  const pl = kind === 'wasted' ? places.hospital : places.police;
  const fee = Math.min(G.money, kind === 'wasted' ? 5000 : 10000);
  G.money -= fee;
  G.stats[kind] = (G.stats[kind] || 0) + 1;
  resetPolice();
  Object.assign(p, { dead: null, knockT: 0, car: null });
  standAt(pl.foot);
  G.health = 100;
  if (kind === 'wasted') G.armor = 0;
  G.hurtFlash = 0;
  G.time += kind === 'wasted' ? 180 : 120;
  if (G.time >= 1440) { G.time -= 1440; G.day++; onNewDay(); }
  jump.y = jump.v = 0;
  death.kind = null;
  document.body.classList.remove('dead');
  clearBigText();
  toast(kind === 'wasted' ? `🏥 The private suite patched you up. Hospital bill: ${money(fee)}` : `🚓 Your lawyer had you out in an hour. Fine: ${money(fee)}`, 5000);
  saveGame();
}

// Put Kimchi on one of the world's bench views (src/3d/bench.js): { x, y } in sim px, his heading, the
// camera's yaw, and car (true or a car type) when the view is from behind the wheel. The camera is reset to
// the default chase view so every visit to a view frames it the same way.
function benchPlace(v) {
  const p = G.player;
  if (p.car && !v.car) {
    p.car = null;
    for (const f of G.friends) if (f.inCar) { f.inCar = false; f.x = v.x + 28; f.y = v.y; }
  }
  standAt({ x: v.x, y: v.y, a: v.heading });
  cam.yaw = v.yaw; cam.mode = 0; cam.zoom = 1; cam.lastDrag = -10;
  hero.gy = null; hero.px = null;      // settle on the new ground at once, without a running start
  jump.y = jump.v = 0;
  if (v.car) {
    let c = p.car;
    if (!c) { c = makeCar(typeof v.car === 'string' ? v.car : 'ursa', v.x, v.y, v.heading); G.cars.push(c); p.car = c; }
    Object.assign(c, { x: v.x, y: v.y, a: v.heading, vx: 0, vy: 0, speed: 0 });
    const view = carViews.get(c);
    if (view) view.init = false;
  }
}

// Fast travel and race board starts (activities.js): the screen fades to black, then Kimchi goes to `to`
// ({ x, y, a } sim px) in the car he drives (with car: true, in a car of his own when he is on foot: the one he
// last drove, else one from the villa's drive), anyone riding with him included and a friend walking with him
// beside him. Traffic standing on the spot makes room, and the ground and the city cells round it are built
// while the screen is dark. done(true) runs once he is there, done(false) if he went down before he could go.
function travel(to, { car = false, done } = {}) {
  fade(() => {
    const p = G.player;
    if (p.dead) { done?.(false); return; }
    let c = p.car && !p.car.wreck && !(p.car.hp <= 0) ? p.car : null;
    if (car && !c) c = eventCar();
    // no car that can drive: he stays where he is (on foot on a start line would leave him on a live road)
    if (car && !c) { done?.(false, 'nocar'); return; }
    if (car) {
      Object.assign(c, { x: to.x, y: to.y, a: to.a, vx: 0, vy: 0, speed: 0, gy: undefined, vh: 0, air: 0 });
      Object.assign(p, { car: c, x: c.x, y: c.y });
      const v = carViews.get(c);
      if (v) v.init = false;
      const r = 9 / S;
      G.cars = G.cars.filter(o => o === c || !((o.traffic && o.ai) || (o.parked != null && !o.touched)) || Math.hypot(o.x - c.x, o.y - c.y) > r);
      cam.yaw = to.a; cam.init = false;
    } else {
      if (p.car) p.car = null;
      standAt(to);
      hero.gy = null; hero.px = null;
      jump.y = jump.v = 0;
    }
    for (const f of G.friends) if (f.following && !f.inCar) { f.x = p.x + 28; f.y = p.y; }
    city.terrain?.buildAround?.(p.x * S, p.y * S, 260);
    city.chunks?.buildAround?.(p.x * S, p.y * S, 160);
    saveGame();
    done?.(true);
  });
}
// The car Kimchi takes to an event from on foot: his own car he last drove, or the fastest one he owns. The
// villa's drive holds only the last few types he bought (spawnGarage), so the fastest may not be there: then any
// of his that it did put out.
function eventCar() {
  const ok = (c) => c && !c.wreck && !(c.hp <= 0) && G.cars.includes(c);
  if (ok(G.ownedCar)) return G.ownedCar;
  const types = [...new Set(G.owned)].filter(t => CAR_TYPES[t]).sort((a, b) => CAR_TYPES[b].max - CAR_TYPES[a].max);
  if (!types.length) return null;
  const c = spawnOwnedCar(types[0]);
  if (ok(c)) return c;
  return G.cars.filter(o => o.owned && ok(o)).sort((a, b) => CAR_TYPES[b.type].max - CAR_TYPES[a.type].max)[0] || null;
}

// ---------- shooting ----------

const tmpO = new THREE.Vector3(), tmpD = new THREE.Vector3(), tmpM = new THREE.Vector3(), camDir = new THREE.Vector3();
function muzzlePos(dir) {
  const p = G.player;
  const m = hero.gun?.muzzle(tmpM);
  const gy = hero.gy ?? surfaceY(p.x, p.y);
  if (m && Math.abs(m.x - p.x * S) < 2.5 && Math.abs(m.z - p.y * S) < 2.5 && m.y > gy) return m;
  return tmpM.set(p.x * S + dir.x * 0.7, gy + 1.35, p.y * S + dir.z * 0.7);
}

function updateShooting(dt) {
  const p = G.player;
  aim.holdT = Math.max(0, aim.holdT - dt);
  aim.autoT = Math.max(0, aim.autoT - dt);
  if (p.car || p.dead || p.knockT > 0) { aim.camOn = false; aim.holdT = 0; aim.autoT = 0; aim.queued = false; return; }
  const W = WEAPONS[G.weapon];
  // a click or tap too quick to still be held when the frame runs fires once anyway (aim.queued)
  const mouseOk = mouse.locked || mouse.lockFailed;
  const keyHeld = keys.KeyF || touch.fire;
  const mouseFire = mouseOk && (mouse.left || (aim.queued && aim.viaMouse));
  const keyFire = keyHeld || (aim.queued && !aim.viaMouse);
  aim.camOn = !W.melee && (mouse.right || mouseFire || aim.holdT > 0);
  if (!mouseFire && !keyFire) { aim.queued = false; return; }
  p.heading = hero.heading;

  if (W.melee) {
    const tgt = autoTarget(hero.heading, 2.6) || autoTarget(mouse.locked ? cam.yaw : hero.heading, 2.6);
    if (tgt) hero.heading = Math.atan2(tgt.y - p.y, tgt.x - p.x);
    else if (mouse.locked) hero.heading = cam.yaw;
    p.heading = hero.heading;
    playerFire(null, null, fx);
    aim.queued = false;
    return;
  }

  let ray;
  if (mouseFire || (keyFire && aim.k > 0.6)) {
    // through the crosshair: from the camera, skipping everything between the camera and Kimchi
    aim.holdT = 1.1;
    if (aim.k < 0.55) return;
    camera.getWorldDirection(camDir);
    const toHero = tmpO.set(p.x * S, (hero.gy ?? 0) + 1.5, p.y * S).sub(camera.position).dot(camDir);
    ray = { origin: camera.position.clone(), dir: camDir.clone(), minT: Math.max(0.5, toHero + 0.4) };
  } else {
    // lock on to the nearest threat in front (keyboard F and the touch button)
    const tgt = autoTarget(hero.heading, Math.min(45, W.range));
    const gy = hero.gy ?? surfaceY(p.x, p.y);
    const o = new THREE.Vector3(p.x * S, gy + 1.35, p.y * S);
    if (tgt) {
      hero.heading = Math.atan2(tgt.y - p.y, tgt.x - p.x);
      const ty = surfaceY(tgt.x, tgt.y) + (tgt.state === 'knocked' ? 0.35 : 1.15);
      tmpD.set(tgt.x * S - o.x, ty - o.y, tgt.y * S - o.z).normalize();
    } else tmpD.set(Math.cos(hero.heading), -0.03, Math.sin(hero.heading)).normalize();
    aim.pitch = Math.asin(clamp(tmpD.y, -1, 1));
    aim.autoT = 0.8;
    if (aim.pk < 0.3) return;
    ray = { origin: o, dir: tmpD.clone(), minT: 0.3 };
  }
  p.heading = hero.heading;
  aim.queued = false;
  if (playerFire(ray, muzzlePos(ray.dir).clone(), fx)) {
    const kick = { pistol: 0.012, shotgun: 0.035, rifle: 0.006 }[G.weapon] || 0;
    aim.kick = Math.min(0.1, aim.kick + kick);
    if (G.weapon === 'shotgun') G.shake = Math.max(G.shake, 4);
  }
}

// ---------- update ----------

// What the v2 population needs from the 3D game (spec §9, §12.3): the graphics tier for its caps, and what the
// camera may see (inView), so cars and people come and go out of sight. The grid keeps its own rules.
const worldOpts = V2 ? { tier: 'medium', view: (x, y) => inView(x, y) } : undefined;
function popTier() { return LOW || gfx.level >= 3 ? 'low' : gfx.level <= 1 ? 'high' : 'medium'; }

let saveT = 0, lastShake = 0, wasInCar = false, devPilot = null;
function update(dt) {
  if (shot.frozen) dt = 0;   // a dev screenshot holding the action still (the end of this file)
  G.t += dt;
  tickHudTimers(dt);
  if (worldOpts) worldOpts.tier = popTier();
  if (G.mode !== 'play') { updateWorld(dt, worldOpts); return; }
  if ((G.menu || G.bigMap) && mouse.locked) document.exitPointerLock();
  if (G.menu || G.bigMap) { engine.set(false); radio.update(false); return; }

  const p = G.player;
  // the world runs in slow motion for a moment when Kimchi goes down
  const wdt = death.kind && death.t < 1.8 ? dt * 0.35 : dt;
  if (p.dead) updateDeath(dt);

  const before = G.time;
  G.time += wdt * 1.5;
  if (G.time >= 1440) { G.time -= 1440; G.day++; onNewDay(); toast(`🌅 Day ${G.day}`); }
  if (before < 20 * 60 && G.time >= 20 * 60) toast('🌙 It\'s getting late. Sleep at home to restore energy.');

  devPilot?.(dt);
  const inp = readInput(dt);
  updatePlayer(wdt, inp);
  updateWorld(wdt, worldOpts);
  updateCombat(wdt, fx);
  updateHostiles(wdt, fx);
  updatePolice(wdt);
  updateMissions(wdt);
  if (!(shot.view && shot.noact)) updateActivities(wdt);   // (&noact=1: without them, for tools/s8_bench.mjs)
  G.boardHint = boardNear();
  updateJob(wdt);
  updateJars();
  updateShooting(dt);
  if (!p.car && !p.dead && !G.menu) tryStartAt(p.x, p.y);

  const drain = p.car ? 0.12 : p.running ? 0.5 : p.moving ? 0.2 : 0.08;
  const wasUp = G.energy > 0;
  G.energy = Math.max(0, G.energy - drain * wdt);
  if (wasUp && G.energy <= 0) toast('😵 Out of energy! Eat a snack (I) or sleep at home.', 4500);

  // facing: where Kimchi walks, or where he aims
  if (!p.car && !p.dead && !(p.knockT > 0)) {
    if (aim.camOn) hero.heading += angDiff(hero.heading, cam.yaw) * Math.min(1, dt * 20);
    else if (inp.ax !== undefined && Math.hypot(inp.ax, inp.ay) > 0.15 && aim.autoT <= 0) {
      hero.heading += angDiff(hero.heading, Math.atan2(inp.ay, inp.ax)) * Math.min(1, dt * 12);
    }
  }
  p.heading = hero.heading;
  aim.k += ((aim.camOn ? 1 : 0) - aim.k) * Math.min(1, dt * 12);
  aim.kick *= Math.exp(-dt * 9);   // recoil climbs while firing and settles back
  aim.pk += ((aim.camOn || aim.autoT > 0 ? 1 : 0) - aim.pk) * Math.min(1, dt * 14);
  if (!aim.camOn && cam.pitch < 0.04) cam.pitch += (0.04 - cam.pitch) * Math.min(1, dt * 6);

  if (jump.y > 0 || jump.v > 0) {
    jump.v -= 16 * dt;
    jump.y = Math.max(0, jump.y + jump.v * dt);
    if (jump.y === 0) jump.v = 0;
  }
  if (p.car) { jump.y = 0; jump.v = 0; }

  G.target = p.dead ? null : findTarget();
  const spot = !p.dead && !G.menu ? photoSpotNear(p.car || p) : null;
  G.photoHint = spot && spotReady(spot) ? spot.name : null;
  if ((saveT += dt) > 30) { saveT = 0; if (!p.dead && bench.busy !== 'bench') saveGame(); }   // the bench holds the clock still

  const c = p.car;
  engine.set(!!c && !c.wreck && c.hp > 0, c ? Math.min(1, Math.abs(c.speed || 0) / CAR_TYPES[c.type].max) : 0);
  radio.update(!!c && !p.dead);
  if (c && !wasInCar && radio.name !== 'Radio off') radioPopup(radio.name, radio.tag);
  wasInCar = !!c;
  // tyre smoke off the rear wheels in a handbrake turn or a slide, where the car is drawn (swung out in a slide)
  if (c && (c.drift || Math.abs(activityState.slide) > 0.15)) {
    const view = carViews.get(c);
    if (view) {
      const g = view.group.position, a = -view.group.rotation.y, rear = view.spots[4];
      for (const s of [-1, 1]) {
        const bx = g.x + Math.cos(a) * rear - Math.sin(a) * s * 0.8;
        const bz = g.z + Math.sin(a) * rear + Math.cos(a) * s * 0.8;
        fx.emit(bx, view.y + 0.25, bz, { vy: 0.6, life: 1.1, size: 0.7, grow: 2.2, color: '#dcd8d0', opacity: 0.45 });
      }
    }
  }
  if (G.shake > lastShake + 3 && c) {
    const view = carViews.get(c);
    for (let i = 0; i < 8; i++) fx.emit(c.x * S + Math.cos(c.a) * 2, (view?.y || 0) + 0.5, c.y * S + Math.sin(c.a) * 2,
      { vx: (Math.random() - 0.5) * 3, vy: Math.random() * 2, vz: (Math.random() - 0.5) * 3, life: 0.7, size: 0.5, grow: 2, color: '#bdb5a6', opacity: 0.6 });
  }
  lastShake = G.shake;
  G.shake = Math.max(0, G.shake - dt * 30);
}

// ---------- syncing the simulation onto 3D models ----------

const tmpV = new THREE.Vector3();
function nearCam(x, z, r) { return Math.abs(x - cam.pos.x) < r && Math.abs(z - cam.pos.z) < r; }
const camDist = (x, y, z) => Math.hypot(x - cam.pos.x, y - cam.pos.y, z - cam.pos.z);
// How far out cars are drawn: the grid keeps its 170 m square round the camera; the bigger v2 county draws
// them out to CAR_FAR (220 m; a drawn car goes 3 m past it). Beyond CAR_NEAR (70 m) either way a car is its
// one-mesh far LOD (cars.js).
const carInView = KIND === 'grid' ? (x, z) => nearCam(x, z, 170) : (x, z, d, shown) => d < CAR_FAR + (shown ? CAR_HYST : 0);

// people sitting in a car ride along inside the car's model
const SEAT_K = 0.86;
function seatRig(r, v, z, driver, steer) {
  if (r.root.parent !== v.chassis) {
    v.chassis.add(r.root);
    r.root.rotation.set(0, 0, 0);
    r.root.scale.setScalar(SEAT_K);
    r.root.children[0].rotation.set(0, 0, 0);
    r.root.children[0].position.y = 0;
    r.fall = 0;
    r.seated = true;
    setCasting(r, true);   // in a car near the camera now, whatever shadow it had on foot far off
  }
  r.root.position.set(v.seat.x, v.seat.y - r.hipsY * r.height * SEAT_K, z);
  seatPose(r, driver, steer, G.t, v.seat.shin);
}
function unseat(r, remove = false) {
  if (r.seated) {
    r.seated = false;
    r.root.scale.setScalar(1);
    r.px = null;
    scene.add(r.root);
  }
  if (remove) scene.remove(r.root);
}

function carFx(c, v, dt) {
  c.fxT = (c.fxT || 0) - dt;
  const hood = v.L / 2 - 0.8;
  const hx = c.x * S + Math.cos(c.a) * hood, hz = c.y * S + Math.sin(c.a) * hood, hy = v.y + 1.0;
  if (c.burnT > 0) {
    fx.fire(hx, hy, hz, 1);
    if (Math.random() < dt * 40) fx.fire(c.x * S, v.y + 1.1, c.y * S, 1.2);
    if (c.fxT <= 0) { c.fxT = 0.07; fx.smoke(hx, hy + 0.6, hz, 0.9, 1.4); }
  } else if (c.wreck) {
    if (c.wreckT > 25 && c.fxT <= 0) { c.fxT = 0.16; fx.smoke(c.x * S, v.y + 1.2, c.y * S, 0.88, 1.7); }
    if (c.wreckT > 37 && Math.random() < dt * 25) fx.fire(c.x * S + (Math.random() - 0.5) * 1.6, v.y + 0.7, c.y * S + (Math.random() - 0.5) * 1.6, 0.9);
  } else if (c.hp < 35 && c.fxT <= 0) {
    c.fxT = c.hp < 15 ? 0.06 : 0.12;
    fx.smoke(hx, hy, hz, clamp(1 - c.hp / 35, 0, 1) * 0.8, 1);
  }
  // drawn sliding after a jump of its sim pose (a police car wriggling free, cars.js skid): tyre smoke, as a skid
  if (v.skidM > 0.15 && Math.random() < dt * 30) {
    const a = c.a + v.oa, bx = c.x * S + v.ox - Math.cos(a) * v.L * 0.3, bz = c.y * S + v.oz - Math.sin(a) * v.L * 0.3;
    for (const s of [-1, 1]) fx.emit(bx - Math.sin(a) * s * v.W * 0.45, v.y + 0.2, bz + Math.cos(a) * s * v.W * 0.45, { vy: 0.5, life: 0.9, size: 0.6, grow: 2.2, color: '#dcd8d0', opacity: 0.4 });
  }
}

// Kimchi's car in a slide (activities.js slide; v2 only, 0 on the grid) is drawn as a whole, wheels and all,
// turned into the bend about its front axle with the tail out (activities.js slidePose): for this frame's draw
// the sim's pose is swapped for that one, so cars.js seats the four wheels on the ground where they are drawn,
// then put back. The front wheels counter-steer down the line the car travels, and the speedo keeps the speed
// along that line. Drawn up to SLIDE_DRAW: past it a car sideways on reads as a spin, not a drift. The sim
// only keeps the car's middle off walls and banks, so where the swung-out tail would stand on a kerb, a cut
// bank or a drop (SLIDE_STEP off the slope the car is on) the slide is drawn smaller (slideRoom).
const SLIDE_DRAW = 40 * Math.PI / 180;
const STEER_MAX = 0.75;     // rad: how far a front wheel turns, counter-steer and all
const SLIDE_STEP = 0.1;     // m
function syncMine(v, c, dt, steer, running) {
  const s = V2 && !c.wreck ? slideRoom(v, c, clamp(activityState.slide, -SLIDE_DRAW, SLIDE_DRAW)) : 0;
  if (!s) return syncCar(v, c, dt, V2 ? surfaceY : surfaceY(c.x, c.y), steer, running);
  const { x, y, a, gy } = c, P = slidePose(c, s, v.spots[0], surfaceY);
  c.x = P.x; c.y = P.y; c.a = P.a; c.gy = P.gy;
  let vf;
  try { vf = syncCar(v, c, dt, surfaceY, steer, running); } finally { c.x = x; c.y = y; c.a = a; c.gy = gy; }
  for (const w of v.front) w.rotation.y = clamp(v.steer + s, -STEER_MAX, STEER_MAX);
  return vf / Math.cos(s);
}
// The largest of s, 2/3 s and 1/3 s (else 0) at which both rear wheels, swung out, stand within SLIDE_STEP of
// the slope under the car (the ground's rise across its middle, 1 m either way, carried from where the sim's
// own rear wheels stand).
function slideRoom(v, c, s) {
  if (!s) return 0;
  const g = surfaceY, m = 1 / S, x = c.x, y = c.y;
  const gx = (g(x + m, y) - g(x - m, y)) / 2, gy = (g(x, y + m) - g(x, y - m)) / 2;   // rise a metre, along x and y
  const rear = v.spots[4], track = v.spots[5];
  const wheel = (px, py, a, side) => [px + (rear * Math.cos(a) - side * track * Math.sin(a)) * m, py + (rear * Math.sin(a) + side * track * Math.cos(a)) * m];
  for (const k of [1, 2 / 3, 1 / 3]) {
    const P = slidePose(c, s * k, v.spots[0], g);
    let fits = true;
    for (const side of [-1, 1]) {
      const [sx, sy] = wheel(x, y, c.a, side), [dx, dy] = wheel(P.x, P.y, P.a, side);
      const want = g(sx, sy) + ((dx - sx) * gx + (dy - sy) * gy) / m;
      if (Math.abs(g(dx, dy) - want) > SLIDE_STEP) { fits = false; break; }
    }
    if (fits) return s * k;
  }
  return 0;
}

let pruneT = 0;
function syncEntities(dt) {
  const p = G.player;
  if ((pruneT -= dt) <= 0) {
    pruneT = 0.5;
    // views of cars and people that have gone wait in the pools for the next ones
    const alive = new Set(G.cars), walking = new Set(G.peds);
    for (const [c, v] of carViews) {
      if (alive.has(c)) continue;
      for (const r of [hero, ...friendViews.values()]) if (r.root.parent === v.chassis) unseat(r);
      scene.remove(v.group);
      carViews.delete(c);
      carPool.give(v.type, v);
    }
    for (const [ped, r] of pedViews) {
      if (walking.has(ped)) continue;
      scene.remove(r.root);
      pedViews.delete(ped);
      rigPool.give(r.poolKey, r);
    }
  }
  for (const c of G.cars) {
    let v = carViews.get(c);
    if (!v) { v = carViewFrom(carPool, c.type, c.color); scene.add(v.group); carViews.set(c, v); }
    const mine = c === p.car, x = c.x * S, z = c.y * S;
    const d = camDist(x, v.init ? v.y : cam.pos.y, z);
    const vis = mine || carInView(x, z, d, v.group.visible);
    v.group.visible = vis;
    if (!vis) { v.init = false; continue; }
    setCarLook(v, c, mine && heroPhoto && !p.dead);
    // the full car near the camera, one merged mesh further out (never the car Kimchi drives); whether it
    // casts a shadow is settled once the sun has moved (castCars)
    setCarLOD(v, !mine && carFar(v, d), v.cast);
    const steer = mine ? steerInput() : null;
    const running = (!!c.ai || mine || !!c.managed) && !c.wreck && !(c.hp <= 0);
    // v2 sits each car on the ground under its four wheels (hills, kerbs, airtime); the grid eases it level
    // onto the height under its middle, as it always has
    const vf = mine ? syncMine(v, c, dt, steer, running) : syncCar(v, c, dt, V2 ? surfaceY : surfaceY(c.x, c.y), steer, running);
    if (mine) v.lastSpeed = vf;
    carFx(c, v, dt);
    if (V2 && !v.lod) splash(c, v, dt);
  }

  for (const ped of G.peds) {
    let r = pedViews.get(ped);
    if (!r) { r = pedRig(ped); scene.add(r.root); pedViews.set(ped, r); }
    // drawn within 110 m of the camera, casting a shadow within 40 m (cars.js personLOD)
    const vis = personLOD(r, camDist(ped.x * S, r.root.position.y, ped.y * S));
    r.root.visible = vis;
    if (!vis) { r.px = ped.x; r.py = ped.y; continue; }
    const lying = ped.state === 'knocked' || ped.state === 'down';
    if (r.gun) r.aimK += ((ped.aiming && !lying ? 1 : 0) - r.aimK) * Math.min(1, dt * 8);
    r.pistol = r.gun && r.anim ? { aim: r.aimK, pitch: 0.03 } : null;
    syncWalker(r, ped, dt, ped.state === 'flee' || ped.running, ped.role && !lying ? ped.heading : null, !!ped.aiming && !lying);
    r.fall += ((lying && !r.downAnim ? 1 : 0) - r.fall) * Math.min(1, dt * 10);
    const tilt = r.photo ? r.root.children[0] : r.body;
    tilt.rotation.z = r.fall * Math.PI / 2;
    tilt.position.y = r.fall * 0.14;
    if (ped.state === 'knocked') r.root.rotation.y -= ped.spin;
    if (r.gun) r.gun.palmIn(!!r.mocap);
    if (r.gun && !r.mocap) {
      aimPose(r, r.aimK, 0.03, 'pistol');
      if (r.aimK < 0.6) carryPose(r, 'pistol', 1 - r.aimK / 0.6);
    }
  }

  for (const f of G.friends) {
    let r = friendViews.get(f);
    if (!r) { r = personRig(f.def.look, f.def.id); r.px = f.x; r.py = f.y; scene.add(r.root); friendViews.set(f, r); }
    const v = f.inCar && p.car && r.photo ? carViews.get(p.car) : null;
    if (v) { r.root.visible = true; seatRig(r, v, v.seat.zP, false, 0); continue; }
    unseat(r);
    r.root.visible = !f.inCar && personLOD(r, camDist(f.x * S, r.root.position.y, f.y * S));
    if (!r.root.visible) { r.px = f.x; r.py = f.y; continue; }
    const near = !p.car && Math.hypot(p.x - f.x, p.y - f.y) < 100;
    syncWalker(r, f, dt, f.following && Math.hypot(p.x - f.x, p.y - f.y) > 120, near ? Math.atan2(p.y - f.y, p.x - f.x) : null);
  }

  applyOutfit();
  // Kimchi: on foot, or at the wheel behind clear windows
  const seatV = p.car && heroPhoto && !p.dead ? carViews.get(p.car) : null;
  hero.root.visible = G.mode === 'play' && (!p.car || !!seatV);
  if (seatV) {
    seatRig(hero, seatV, seatV.seat.zD, true, steerInput());
    hero.gun?.set(null);
    return;
  }
  unseat(hero);
  if (!hero.root.visible) { hero.px = null; return; }
  const moved = hero.px != null ? Math.hypot(p.x - hero.px, p.y - hero.py) * S : 0;
  const sp = moved / Math.max(dt, 1e-3);
  hero.px = p.x; hero.py = p.y;
  hero.gy = footY(hero, surfaceY(p.x, p.y), moved, dt);
  hero.root.position.set(p.x * S, hero.gy + jump.y, p.y * S);
  hero.root.rotation.y = -hero.heading;
  const down = p.dead === 'wasted' || p.knockT > 0;
  const anim = { speed: p.moving && !down ? sp : 0, run: p.running, air: jump.y > 0.05 ? 1 : 0, pose: 'pockets', t: G.t };
  const turn = angDiff(hero.lastHeading ?? hero.heading, hero.heading) / Math.max(dt, 1e-3);
  hero.lastHeading = hero.heading;
  tickFace(hero, dt);
  if (heroPhoto) {
    const kind = G.weapon;
    hero.gun.set(kind);
    const armed = !!hero.gun.kind && !down;
    const pitch = (aim.k > 0.3 ? -(cam.pitch - 0.34 - aim.kick) : aim.pitch) + weaponState.recoil * 0.12;
    // a pistol uses the motion-captured ready and aim poses; long guns the procedural ones below
    const pistol = armed && kind === 'pistol' ? { aim: aim.pk, pitch } : null;
    const mocap = hero.anim && hero.anim.update(dt, { speed: anim.speed, air: anim.air > 0, turn, pistol });
    if (!mocap) animatePhotoRig(hero, dt, anim);
    else {
      // falling down (wasted, or knocked over) and getting back up; punches thrown from the shoulders
      if (down !== !!hero.downAnim) { hero.downAnim = down; if (down) hero.anim.play('death', { hold: true }); else hero.anim.play('get_up', { out: 0.4 }); }
      if (!down && G.health < (hero.hp0 ?? G.health) - 2) hero.anim.play(Math.random() < 0.6 ? 'hit_chest' : 'hit_head', { upper: true, out: 0.15 });
      hero.hp0 = G.health;
      if (weaponState.punchT > (hero.punchT || 0)) hero.anim.play((hero.punchN = (hero.punchN || 0) + 1) % 2 ? 'jab' : 'cross', { upper: true, from: 0.12, speed: 1.4, out: 0.2 });
      hero.punchT = weaponState.punchT;
    }
    hero.gun.palmIn(mocap && pistol);
    if (!(mocap && pistol)) {
      aimPose(hero, armed ? aim.pk : 0, pitch, kind);
      if (armed && aim.pk < 0.6) carryPose(hero, kind, 1 - aim.pk / 0.6);
    }
    if (weaponState.punchT > 0 && !mocap) punchPose(hero, 1 - weaponState.punchT / 0.28);
    if (p.dead === 'busted') surrenderPose(hero, Math.min(1, death.t * 3));
  } else animateRig(hero, dt, anim);
  hero.fall = (hero.fall || 0) + ((down && !hero.downAnim ? 1 : 0) - (hero.fall || 0)) * Math.min(1, dt * 7);
  const tilt = heroPhoto ? hero.root.children[0] : hero.body;
  if (tilt) { tilt.rotation.z = hero.fall * Math.PI / 2; tilt.position.y = hero.fall * 0.14; }
  const gk = JSON.stringify(G.equipped);
  if (gk !== gearKey && hero.setGear) { gearKey = gk; hero.setGear({ ...G.equipped, watchLook: ITEMS[G.equipped.watch]?.look }); }
}

// Kimchi's feet on the ground: eased onto it. On v2's hills ground that runs on smoothly (a slope, a ramp) is
// followed at once, so he neither floats down a hill nor sinks into one, and only a step (a kerb, a plinth)
// eases in: gy is the ground under him now, moved how far he went this frame (m).
const FOOT_GRADE = 0.8, FOOT_K = 14;
function footY(r, gy, moved, dt) {
  const was = r.gyRaw;
  r.gyRaw = gy;
  if (r.gy == null) return gy;
  let y = r.gy;
  if (V2 && was != null) y += clamp(gy - was, -(FOOT_GRADE * moved + 0.01), FOOT_GRADE * moved + 0.01);
  return y + (gy - y) * Math.min(1, dt * FOOT_K);
}

// Spray where a car runs through a shallow pond (SHALLOW, spec §3), more the faster it goes: sheets of
// droplets thrown off both sides, a rooster tail off the rear wheels, a bow wave and a foam wake on the water,
// and a burst when it hits the water at speed. Soft particles (fx), from the water's surface.
const SPRAY = '#f2fbfd', FOAM = '#e2f1f2';
function splash(c, v, dt) {
  const wet = surfaceAt(c.x, c.y) === SHALLOW, was = v.wet;
  v.wet = wet;
  const sp = Math.hypot(c.vx, c.vy) * S;
  if (!wet || sp < 1.5) return;
  const fx0 = Math.cos(c.a), fz0 = Math.sin(c.a), rx = -fz0, rz = fx0, x = c.x * S, z = c.y * S;
  const y = pondLevel(x, z, v.y), k = Math.min(1, sp / 22), n = Math.min(sp, 22) * dt * 4;
  const drop = (px, pz, vx, vy, vz, size, life, color = SPRAY, opacity = 0.9) =>
    fx.emit(px, y, pz, { vx, vy, vz, life, size, grow: 1.4, gravity: -9.8, drag: 0.8, color, opacity });
  for (const s of [-1, 1]) {
    // the sheet off this side, from the front wheel back along the car
    for (let i = n + Math.random(); i >= 1; i--) {
      const along = v.L * (0.35 - 0.5 * Math.random()), out = 2 + sp * 0.25 * Math.random(), px = x + fx0 * along + rx * s * v.W / 2, pz = z + fz0 * along + rz * s * v.W / 2;
      drop(px, pz, rx * s * out + fx0 * sp * 0.3, 2.5 + 5 * k * Math.random(), rz * s * out + fz0 * sp * 0.3, 0.2 + 0.25 * Math.random(), 0.5 + 0.4 * Math.random());
    }
    // the rooster tail off the rear wheel, and the wake it leaves on the water
    const bx = x - fx0 * v.L * 0.32 + rx * s * v.W * 0.4, bz = z - fz0 * v.L * 0.32 + rz * s * v.W * 0.4;
    for (let i = n * 0.6 + Math.random(); i >= 1; i--) {
      drop(bx, bz, fx0 * sp * 0.15 + rx * s * Math.random(), 3 + 5.5 * k * Math.random(), fz0 * sp * 0.15 + rz * s * Math.random(), 0.3 + 0.3 * k, 0.6 + 0.4 * Math.random());
    }
    // (a point sprite is a square facing the camera: raised by half its size, the water does not cut it off)
    if (Math.random() < n * 0.4) fx.emit(bx, y + 0.35, bz, { vy: -0.2, life: 1.2, size: 0.7, grow: 1.6, drag: 1, color: FOAM, opacity: 0.35 });
  }
  if (Math.random() < n * 0.5) {
    const bow = v.L / 2 + 0.2;
    drop(x + fx0 * bow, z + fz0 * bow, fx0 * sp * 0.6, 1.2 + 2.5 * k, fz0 * sp * 0.6, 0.5 + 0.4 * k, 0.45, SPRAY, 0.7);
  }
  if (!was && sp > 6) {
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2, u = 2 + Math.random() * sp * 0.3;
      drop(x + Math.cos(a) * v.W * 0.6, z + Math.sin(a) * v.W * 0.6, Math.cos(a) * u + fx0 * sp * 0.3, 3 + Math.random() * 5, Math.sin(a) * u + fz0 * sp * 0.3, 0.45, 0.9);
    }
  }
}
// the water's surface at (x, z) m: the shallow pond's level there, else a little over the bed
function pondLevel(x, z, bed) {
  for (const b of water.bodies || []) {
    if (b.surf !== 'SHALLOW') continue;
    for (const sh of b.shapes || []) if (sh.circle && Math.hypot(x - sh.circle[0], z - sh.circle[1]) <= sh.r + 3) return b.level;
  }
  return bed + 0.3;
}

// faceTo: where to look when standing still (or always, with force — police aiming while they walk)
function syncWalker(r, e, dt, run, faceTo = null, force = false) {
  const dx = e.x - r.px, dy = e.y - r.py;
  const sp = r.px == null ? 0 : Math.hypot(dx, dy) * S / Math.max(dt, 1e-3);
  r.px = e.x; r.py = e.y;
  if (sp > 0.3 && !force) r.heading += angDiff(r.heading, Math.atan2(dy, dx)) * Math.min(1, dt * 10);
  else if (faceTo != null) r.heading += angDiff(r.heading, faceTo) * Math.min(1, dt * 8);
  r.root.position.set(e.x * S, surfaceY(e.x, e.y), e.y * S);
  r.root.rotation.y = -r.heading;
  const still = e.state === 'knocked' || e.state === 'down';
  const anim = { speed: still ? 0 : sp, run, t: G.t };
  const turn = angDiff(r.lastHeading ?? r.heading, r.heading) / Math.max(dt, 1e-3);
  r.lastHeading = r.heading;
  tickFace(r, dt);
  if (r.anim) {
    // knocked down: they fall and lie there; back on their feet: they get up; hit but standing: they flinch
    if (still !== !!r.downAnim) { r.downAnim = still; if (still) r.anim.play('death', { hold: true }); else r.anim.play('get_up', { out: 0.4 }); }
    else if (!still && e.hp < (r.hp0 ?? e.hp)) r.anim.play(Math.random() < 0.6 ? 'hit_chest' : 'hit_head', { upper: sp > 1.5, out: 0.15 });
    r.hp0 = e.hp;
    r.anim.setIdle(e.bubble ? 'talk' : e.role === 'rival' && !e.aggro ? 'fold_arms' : 'idle');
    r.mocap = r.anim.update(dt, { speed: anim.speed, turn, pistol: r.pistol });
    if (r.mocap) return;
  }
  if (r.photo) animatePhotoRig(r, dt, anim); else animateRig(r, dt, anim);
}

// ---------- camera ----------

// What the v2 camera keeps clear of (spec §11): the ground (hills, cuttings, cliffs and decks; occluderTop has
// it, and TERRAIN never stands above GROUND) and the buildings (OCC). Each point counts as the highest of
// them over a disc of radius r round it, so the camera's near plane and the parts of a building that reach
// past its footprint (canopies, blade signs) count too. The camera stays CAM_CLEAR over them.
const CAM_R = 0.6, CAM_CLEAR = 0.45;
const CHASE_MIN_CAR = 4, CHASE_MIN_FOOT = 1.8;   // m: the chase camera pulls in no closer than this, then lifts
const CAM_LIFT = 1.25, LIFT_STEP = 0.08;          // rad: the steepest it lifts to, a step at a time
const AIM_MIN = 1.1, AIM_LIFT = 1.2;              // m: the shoulder camera pulls in to this, then lifts up to this
function camBlock(x, z, r = CAM_R) {
  return Math.max(occluderTop(x, z), occluderTop(x + r, z), occluderTop(x - r, z), occluderTop(x, z + r), occluderTop(x, z - r));
}
// How far (horizontally, up to run m) the camera can back away from (x, y, z) along (dx, dz), rising `rise` m
// a metre, before the ground or a building comes within CAM_CLEAR under that line.
function clearRun(x, y, z, dx, dz, rise, run) {
  for (let d = 0.8; d <= run; d += 0.4) if (camBlock(x + dx * d, z + dz * d) > y + rise * d - CAM_CLEAR) return Math.max(0, d - 0.5);
  return run;
}
// The v2 chase camera, dist m out at `pitch` behind (dirx, dirz) from the target (tx, ty, tz), into `desired`.
// When the ground or a building comes between, it pulls in along its line, but no closer than minRun (it would
// be in the car, or in Kimchi's head); past that it lifts instead, to the lowest pitch that keeps it that far
// back (or, when none does, the pitch with the longest clear line).
let camLifted = 0;   // how far the chase camera is lifted this frame (rad, for KC3.metrics)
function chaseV2(tx, ty, tz, dirx, dirz, dist, pitch, minRun) {
  let p = pitch, best = null;
  for (;;) {
    const full = dist * Math.cos(p), run = clearRun(tx, ty, tz, dirx, dirz, Math.tan(p), full);
    if (run >= Math.min(minRun, full)) { best = { p, run, full }; break; }
    if (!best || run > best.run) best = { p, run, full };
    if (p >= CAM_LIFT) break;
    p = Math.min(CAM_LIFT, p + LIFT_STEP);
  }
  camLifted = best.p - pitch;
  const run = Math.max(0.9, best.run), h = dist * Math.sin(best.p);
  desired.set(tx + dirx * run, ty + h * Math.min(1, run / best.full + 0.25), tz + dirz * run);
}
// The v2 over-the-shoulder camera, 2.3 m back from the shoulder (pivot) along the aim (aimFwd), into out:
// pulled in when the ground or a wall comes between, to no closer than AIM_MIN, then lifted up to AIM_LIFT
// over that line. It still looks along the aim, so shots go where the crosshair shows.
function aimV2(out) {
  const run = (lift) => {
    for (let d = 0.4; d <= 2.3; d += 0.3) {
      if (camBlock(pivot.x - aimFwd.x * d, pivot.z - aimFwd.z * d, 0.3) > pivot.y - aimFwd.y * d + lift * d / 2.3 - 0.3) return Math.max(0, d - 0.35);
    }
    return 2.3;
  };
  let back = run(0), lift = 0;
  for (let l = 0.3; back < AIM_MIN && l <= AIM_LIFT + 1e-6; l += 0.3) {
    const b = run(l);
    if (b > back) { back = b; lift = l; }
  }
  back = Math.max(0.7, back);
  out.copy(pivot).addScaledVector(aimFwd, -back);
  out.y += lift * back / 2.3;
}
// After smoothing (v2): a camera lagging through what its desired spot is clear of (a hillside swinging into
// the line, a corner) takes the desired spot at once, and it never sits closer than CAM_CLEAR over the
// ground round it.
function keepClear(tx, ty, tz) {
  const dx = cam.pos.x - tx, dz = cam.pos.z - tz, run = Math.hypot(dx, dz);
  if (run > 0.9 && clearRun(tx, ty, tz, dx / run, dz / run, (cam.pos.y - ty) / run, run) < run) cam.pos.copy(desired);
  let g = surfaceY(cam.pos.x / S, cam.pos.z / S);
  for (const [ox, oz] of DISC) g = Math.max(g, surfaceY((cam.pos.x + ox) / S, (cam.pos.z + oz) / S));
  cam.pos.y = Math.max(cam.pos.y, g + CAM_CLEAR);
}
const DISC = [[CAM_R, 0], [-CAM_R, 0], [0, CAM_R], [0, -CAM_R]];

const desired = new THREE.Vector3(), lookAt = new THREE.Vector3();
const aimFwd = new THREE.Vector3(), pivot = new THREE.Vector3(), aimPos = new THREE.Vector3(), aimLook = new THREE.Vector3();
function updateCamera(dt) {
  camLifted = 0;
  const fc = shot.cam;
  if (fc && G.mode === 'play') {   // a dev screenshot's fixed camera (tools/shot.sh)
    camera.position.set(fc[0], fc[1], fc[2]); camera.lookAt(fc[3], fc[4], fc[5]); camera.updateMatrixWorld();
    cam.pos.copy(camera.position);
    return;
  }
  if (G.mode !== 'play') {
    if (V2) {
      // the v2 title flies the world's title path, never lower than 8 m over the ground under it
      titleView.pose(G.t, desired, lookAt);
      desired.y = Math.max(desired.y, surfaceY(desired.x / S, desired.z / S) + 8);
    } else {
      const a = G.t * 0.035;
      desired.set(MAP / 2 + Math.cos(a) * 175, 72, MAP / 2 + Math.sin(a) * 175);
      lookAt.set(MAP / 2, 4, MAP / 2);
    }
    camera.position.copy(desired);
    camera.lookAt(lookAt);
    camera.updateMatrixWorld();
    cam.pos.copy(camera.position);
    return;
  }
  const p = G.player, c = p.car;
  const view = c ? carViews.get(c) : null;
  const gy = c ? (view?.y ?? 0) : (hero.gy ?? surfaceY(p.x, p.y));
  const tx = p.x * S, tz = p.y * S;
  const ty = gy + (c ? 1.3 : 1.4) + jump.y * 0.4;
  const speed = c ? Math.abs(view?.lastSpeed || 0) : 0;
  const dead = death.kind ? Math.min(1, death.t / 2) : 0;

  if (cam.mode === 2) {
    desired.set(tx, gy + 26 + speed * 0.5, tz + 8 + speed * 0.12);
    lookAt.set(tx, gy, tz - 1);
  } else {
    if (c && G.t - cam.lastDrag > 1.2) cam.yaw += angDiff(cam.yaw, c.a) * Math.min(1, dt * (speed > 2 ? 3.2 : 1.2));
    let dist = (c ? 6.9 + Math.min(2.6, speed * 0.075) : 4.5) * (cam.mode === 1 ? 1.9 : 1) * cam.zoom;
    const pitch = Math.max(0.04, cam.pitch) + (cam.mode === 1 ? 0.18 : 0) + (c ? -0.06 : 0) + dead * 0.5;
    dist *= 1 + dead * 0.6;
    const dirx = -Math.cos(cam.yaw), dirz = -Math.sin(cam.yaw);
    if (V2) chaseV2(tx, ty, tz, dirx, dirz, dist, pitch, c ? CHASE_MIN_CAR : CHASE_MIN_FOOT);
    else {
      let hd = dist * Math.cos(pitch);
      const h = dist * Math.sin(pitch);
      // don't let buildings (or a hillside) get between the camera and Kimchi
      for (let d = 0.8; d <= hd; d += 0.4) {
        if (occluderTop(tx + dirx * d, tz + dirz * d) > ty + h * (d / hd) - 0.3) { hd = Math.max(0.9, d - 0.5); break; }
      }
      desired.set(tx + dirx * hd, ty + h * Math.min(1, hd / (dist * Math.cos(pitch)) + 0.25), tz + dirz * hd);
    }
    lookAt.set(tx + (c ? Math.cos(c.a) * 3 : 0), ty + (c ? 0.1 : 0.15) - dead * 1.2, tz + (c ? Math.sin(c.a) * 3 : 0));
  }
  if (aim.k > 0.001 && !c) {
    // over the right shoulder, looking where the gun points
    const lp = cam.pitch - 0.34 - aim.kick;
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    aimFwd.set(cy * Math.cos(lp), -Math.sin(lp), sy * Math.cos(lp));
    pivot.set(tx - sy * 0.5, gy + 1.58, tz + cy * 0.5);
    if (V2) aimV2(aimPos);
    else {
      let back = 2.3;
      for (let d = 0.4; d <= back; d += 0.3) {
        if (occluderTop(pivot.x - aimFwd.x * d, pivot.z - aimFwd.z * d) > pivot.y - aimFwd.y * d - 0.3) { back = Math.max(0.7, d - 0.35); break; }
      }
      aimPos.copy(pivot).addScaledVector(aimFwd, -back);
    }
    aimLook.copy(pivot).addScaledVector(aimFwd, 25);
    desired.lerp(aimPos, aim.k);
    lookAt.lerp(aimLook, aim.k);
  }
  if (!cam.init) { cam.pos.copy(desired); cam.look.copy(lookAt); cam.init = true; }
  const k = 1 - Math.exp(-dt * (c ? 9 : 11 + aim.k * 30));
  cam.pos.lerp(desired, k);
  cam.look.lerp(lookAt, 1 - Math.exp(-dt * (14 + aim.k * 40)));
  if (V2) keepClear(tx, ty, tz);
  else cam.pos.y = Math.max(cam.pos.y, surfaceY(cam.pos.x / S, cam.pos.z / S) + 0.4);   // and never into the ground
  camera.position.copy(cam.pos);
  if (G.shake > 0.5) camera.position.add(tmpV.set((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5)).multiplyScalar(G.shake * 0.02));
  camera.lookAt(cam.look);
  clearTreesForCamera(camera.position, tmpV.set(tx, ty, tz));
  const fov = 62 + (c ? Math.min(10, speed * 0.25) : 0) - aim.k * 12;
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 6); camera.updateProjectionMatrix(); }
  camera.updateMatrixWorld();
}

// ---------- lights that follow the action ----------

let lampT = 0;
const nearLamps = [];
function updateLights(dt, night) {
  if ((lampT -= dt) <= 0) {
    lampT = 0.25;
    // the few real lights sit in the street lamps nearest to what the camera looks at
    nearestLamps(cam.look.x, cam.look.z, lampLights.length, nearLamps);
    nearLamps.forEach((h, i) => lampLights[i].position.copy(h));
  }
  // a light left without a lamp (a map with fewer lamps than lights) stays dark
  lampLights.forEach((l, i) => { l.intensity = i < nearLamps.length ? night * 38 : 0; });

  const c = G.player.car;
  const v = c && carViews.get(c);
  if (v && night > 0.05) {
    const fx0 = Math.cos(c.a), fz0 = Math.sin(c.a), up = V2 ? Math.tan(v.tp || 0) : 0;   // (v2: the beam pitches with the car)
    headlight.position.set(c.x * S + fx0 * (v.L / 2 + 0.1), v.y + 0.8 + up * (v.L / 2 + 0.1), c.y * S + fz0 * (v.L / 2 + 0.1));
    headTarget.position.set(c.x * S + fx0 * (v.L / 2 + 22), v.y + up * (v.L / 2 + 22), c.y * S + fz0 * (v.L / 2 + 22));
    headTarget.updateMatrixWorld();
    headlight.intensity = night * 240;
  } else headlight.intensity = 0;

  // red and blue from the closest police car
  const cops = police.cars.filter(pc => !pc.wreck && pc.hp > 0);
  const flash = setPoliceLights(G.t, cops.length > 0);
  let best = null, bd = 90 * 90;
  for (const pc of cops) {
    const d = (pc.x * S - cam.look.x) ** 2 + (pc.y * S - cam.look.z) ** 2;
    if (d < bd) { bd = d; best = pc; }
  }
  if (best && flash) {
    copLight.position.set(best.x * S, (carViews.get(best)?.y || 0) + 2.2, best.y * S);
    copLight.color.set(flash === 'red' ? '#ff2a2a' : '#2a5bff');
    copLight.intensity = 25 + night * 70;
  } else copLight.intensity = 0;
}

// ---------- render ----------

// Which cars cast a shadow: those inside the sun's shadow box (the far LOD never does, setCarLOD). Run after
// sky.update has moved the sun onto this frame's focus: tested against last frame's box, the cars round a new
// spot (a teleport, a respawn, fast travel) would have no shadow for a frame.
function castCars() {
  shadowBox.update();
  for (const v of carViews.values()) {
    if (!v.group.visible) continue;
    const at = v.group.position;
    setCarLOD(v, v.lod, shadowBox.has(at.x, at.y + 0.8, at.z, v.L / 2 + 0.5));
  }
}

// Shader prewarm (spec §11.1): compile what the game will draw now, on the title screen, rather than with a
// hitch the first time each thing comes into view: the whole city (hidden cells and night-only meshes
// included) and one car of every type with each look it can change to. It waits for the first sky update,
// which sets the scene's environment map, fog and lights, all of which the shaders depend on.
let prewarmed = false;
function prewarm() {
  prewarmed = true;
  compileSoon(scene).catch((e) => console.warn('shader prewarm failed', e));
  prewarmCars();
}
// the car part, again whenever the car models arrive; the compiled views then wait in the pool
function prewarmCars() {
  if (!prewarmed) return;
  const { views, group } = carPrewarm();
  compileSoon(group, scene)
    .then(() => { for (const v of views) carPool.give(v.type, v); })
    .catch((e) => console.warn('car shader prewarm failed', e));
}
// compiled for what the scene is drawn into, or the shaders would be built again at the first real frame: the
// effects chain's buffer on the High tier (graphics.js; either of its two buffers, they compile alike), the
// screen on the phone tier (cars.js compileFor)
function compileSoon(obj, lightsFrom = null) {
  return compileFor(renderer, obj, camera, gfx.passes?.composer.readBuffer ?? null, lightsFrom);
}

// what the view pools and the LOD are doing (KC3.views(), for the soak and the console)
function viewStats() {
  let near = 0, far = 0, casting = 0, shown = 0, rigsCasting = 0;
  for (const v of carViews.values()) {
    if (!v.group.visible) continue;
    if (v.lod) far++; else near++;
    if (v.cast) casting++;
  }
  for (const r of pedViews.values()) if (r.root.visible) { shown++; if (r.cast) rigsCasting++; }
  return { cars: G.cars.length, carViews: carViews.size, carPool: carPool.size, carsNear: near, carsFar: far, carsCasting: casting,
    peds: G.peds.length, rigs: pedViews.size, rigPool: rigPool.size, rigsShown: shown, rigsCasting };
}

// On the v2 title the shadows follow what the camera looks at: the ground 120 m ahead of it (inside the map).
const titleDir = new THREE.Vector3();
function titleFocus(out) {
  camera.getWorldDirection(titleDir);
  const l = Math.hypot(titleDir.x, titleDir.z) || 1;
  const x = clamp(camera.position.x + titleDir.x / l * 120, 0, BOUNDS.x1 * S), z = clamp(camera.position.z + titleDir.z / l * 120, 0, BOUNDS.y1 * S);
  return out.set(x, surfaceY(x / S, z / S), z);
}

// ---------- what the camera sees (for the v2 population), and the dev metrics ----------

// A spot (sim px) may be on screen: within VIEW_NEAR of the camera, or ahead of it inside its field of view
// widened by VIEW_MARGIN (the camera turns), out to VIEW_FAR (cars are drawn to CAR_FAR, people less far).
// Only the horizontal is tested, so on a hill a spot over or under the frame still counts. noteView takes
// the camera once a frame; until then everything counts as seen.
const VIEW_NEAR = 40, VIEW_FAR = CAR_FAR + 40, VIEW_MARGIN = 1.4;
const seen = { ready: false, x: 0, z: 0, fx: 1, fz: 0, tan: 1 }, camFwd = new THREE.Vector3();
function noteView() {
  camera.getWorldDirection(camFwd);
  const l = Math.hypot(camFwd.x, camFwd.z) || 1;
  Object.assign(seen, { ready: true, x: camera.position.x, z: camera.position.z, fx: camFwd.x / l, fz: camFwd.z / l,
    tan: Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect * VIEW_MARGIN });
}
function inView(x, y) {
  if (!seen.ready) return true;
  const dx = x * S - seen.x, dz = y * S - seen.z, d2 = dx * dx + dz * dz;
  if (d2 < VIEW_NEAR * VIEW_NEAR) return true;
  if (d2 > VIEW_FAR * VIEW_FAR) return false;
  const f = dx * seen.fx + dz * seen.fz;
  return f > 0 && Math.abs(dz * seen.fx - dx * seen.fz) <= f * seen.tan + 4;
}

// Dev metrics (KC3.metrics; tools/s6b_drive.mjs reads them). While on: on every frame Kimchi's car is on the
// ground, its wheels' gap to the ground (cars.js wheelGap, m); on every frame of play, the camera's near plane
// (its corners and the eye) against the terrain as drawn (TERRAIN in its 2 m triangles), the ground (roads,
// kerbs, decks) and the buildings (OCC), and how often and how far the chase camera lifted.
const metrics = {
  on: false,
  reset() {
    return Object.assign(this, { frames: 0, wheelN: 0, wheelMax: 0, wheelAt: null, wheelOver: 0, free: 0, camMin: Infinity, camUnder: 0, camInBuilding: 0, lifted: 0, liftMax: 0 });
  },
}.reset();
const NDC = [[-1, -1], [1, -1], [-1, 1], [1, 1]], corner = new THREE.Vector3(), gapOut = [0, 0, 0, 0];
function measure() {
  if (!metrics.on || G.mode !== 'play') return;
  const m = metrics, c = G.player.car, v = c && carViews.get(c);
  m.frames++;
  if (v && v.group.visible && !v.lod) {
    if (v.free) m.free++;
    else {
      const g = Math.abs(wheelGap(v, surfaceY, gapOut));
      m.wheelN++;
      if (g > m.wheelMax) { m.wheelMax = g; m.wheelAt = { x: +(c.x * S).toFixed(1), z: +(c.y * S).toFixed(1), frame: m.frames, speed: +(Math.hypot(c.vx, c.vy) * S).toFixed(1), skid: +v.skidM.toFixed(2) }; }
      if (g > 0.05) m.wheelOver++;
    }
  }
  if (camLifted > 0.01) { m.lifted++; m.liftMax = Math.max(m.liftMax, camLifted); }
  let low = Infinity, inside = false;
  for (let i = 0; i <= 4; i++) {
    if (i < 4) corner.set(NDC[i][0], NDC[i][1], -1).unproject(camera); else corner.copy(camera.position);
    const x = corner.x / S, z = corner.z / S, g = surfaceY(x, z), top = occluderTop(corner.x, corner.z);
    low = Math.min(low, corner.y - Math.max(g, V2 ? terrainMesh(corner.x, corner.z) : g));
    if (top > g + 1 && corner.y < top) inside = true;
  }
  m.camMin = Math.min(m.camMin, low);
  if (low < 0) m.camUnder++;
  if (inside) m.camInBuilding++;
}
// The terrain mesh's height at (x, z) m: TERRAIN's 2 m grid in the triangles terrain3d draws (split from the
// north-east corner to the south-west one)
function terrainMesh(x, z) {
  const T = grids.terrain, [w, h] = grids.dims.terrain;
  const i = clamp(Math.floor(x / 2), 0, w - 2), j = clamp(Math.floor(z / 2), 0, h - 2), u = x / 2 - i, t = z / 2 - j;
  const h00 = T[j * w + i], h10 = T[j * w + i + 1], h01 = T[(j + 1) * w + i], h11 = T[(j + 1) * w + i + 1];
  return u + t <= 1 ? h00 + (h10 - h00) * u + (h01 - h00) * t : h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - t);
}

const enemyRay = { origin: new THREE.Vector3(), dir: new THREE.Vector3() };
function render(dt) {
  syncEntities(dt);
  updateCamera(dt);
  noteView();
  measure();
  const minutes = G.mode === 'play' ? G.time : 18.85 * 60;
  const focus = G.mode === 'play' ? tmpV.set(G.player.x * S, surfaceY(G.player.x, G.player.y), G.player.y * S)
    : V2 ? titleFocus(tmpV) : tmpV.set(MAP / 2, 0, MAP / 2);
  const day = sky.update(minutes, focus, camera, renderer);
  castCars();
  if (!prewarmed) prewarm();
  gfx.setLook(day, sky.state.golden || 0);
  const night = 1 - day;
  city.setNight(night);
  city.update(camera, G.t);
  setCarNight(night);
  updateLights(dt, night);

  if (G.mode === 'play') {
    const marks = [];
    const givers = [];
    if (!missionState.active && !G.player.dead) {
      for (const m of availableMissions()) {
        const s = giverSpot(m);
        marks.push({ x: s.x, y: s.y, giver: true });
        givers.push({ x: s.x, y: s.y, letter: giverLetter(m), title: m.title });
      }
    }
    for (const b of G.missionBeacons || []) marks.push(b);
    if (!(shot.view && shot.noact)) for (const m of activityMarks()) marks.push(m);
    const photoBlips = [];
    for (const s of photoSpots) {
      if (!spotReady(s)) continue;
      photoBlips.push(s);
      if (Math.abs(s.x - G.player.x) < 2600 && Math.abs(s.y - G.player.y) < 2600) marks.push({ x: s.x, y: s.y, photo: true });
    }
    fx.setMarks(marks);
    fx.update(dt, G.t, cam.pos, camera, renderer);

    beginLabels();
    const p = G.player;
    for (const f of G.friends) {
      if (f.inCar) continue;
      label(camera, W, H, f.x * S, surfaceY(f.x, f.y) + 1.85, f.y * S, f.def.name + (f.following ? ' 🤝' : ''), 'tag', f.def.look.shirt, 42);
      if (f.bubble) label(camera, W, H, f.x * S, surfaceY(f.x, f.y) + 2.35, f.y * S, f.bubble.text, 'bubble', null, 38);
    }
    for (const ped of G.peds) if (ped.bubble) label(camera, W, H, ped.x * S, surfaceY(ped.x, ped.y) + 1.9, ped.y * S, ped.bubble.text, 'bubble', null, 34);
    for (const c of G.cars) if (c.bubble) label(camera, W, H, c.x * S, (carViews.get(c)?.y ?? surfaceY(c.x, c.y)) + 2.4, c.y * S, c.bubble.text, 'bubble', null, 40);
    for (const pl of Object.values(places)) {
      if (pl.nomenu) continue;
      label(camera, W, H, pl.door.x * S, surfaceY(pl.door.x, pl.door.y) + 3.3, pl.door.y * S, `${pl.icon} ${pl.name}`, 'place', null, 70);
    }
    if (!missionState.active) {
      for (const g of givers) label(camera, W, H, g.x * S, surfaceY(g.x, g.y) + 2.9, g.y * S, `⭐ ${g.title}`, 'place', null, 40);
    }
    endLabels();
    updateHUD();

    // is the crosshair on someone?
    aim.enemy = false;
    if (aim.k > 0.6 && !p.car) {
      camera.getWorldDirection(enemyRay.dir);
      const hit = raycast(camera.position, enemyRay.dir, WEAPONS[G.weapon].range || 40, { minT: 2.4 });
      aim.enemy = hit.kind === 'ped' || (hit.kind === 'car' && hit.car.police);
    }
    updateGtaHud({ weapon: WEAPONS[G.weapon], reloading: weaponState.reloadT > 0, aiming: aim.k > 0.6 && !p.car && !p.dead,
      enemyAim: aim.enemy, spread: G.weapon === 'shotgun', inCar: !!p.car });
    const heading = p.car ? p.car.a : hero.heading;
    drawMinimap(cam.mode === 2 ? -Math.PI / 2 : cam.yaw, heading, givers, photoBlips);
    updateSpeedo(p.car, p.car ? (carViews.get(p.car)?.lastSpeed || 0) : 0);
    const jobDoor = G.job?.b.door;
    updateJobArrow(camera, W, H, jobDoor ? tmpV.set(jobDoor.x * S, surfaceY(jobDoor.x, jobDoor.y) + 2, jobDoor.y * S) : null);
  } else fx.update(dt, G.t, cam.pos, camera, renderer);
  for (const f of fountains) { f.jet.scale.set(1 + Math.sin(G.t * 9) * 0.06, 1 + Math.sin(G.t * 6) * 0.08, 1 + Math.cos(G.t * 9) * 0.06); }
  if (sea?.material.map) sea.material.map.offset.set(G.t * 0.004, G.t * 0.002);
  for (const y of yachts) { y.g.position.y = y.base + Math.sin(G.t * 0.7 + y.ph) * 0.12; y.g.rotation.z = Math.sin(G.t * 0.5 + y.ph) * 0.015; }
  bench.render();   // gfx.render(), timed and counted while the bench measures
}

// for testing from the console
window.KC3 = {
  G, keys, cam, renderer, scene, camera, gfx, sky, city, mouse, aim, fx, police, missionState, radio, touch, carViews,
  get hero() { return hero; }, get heroPhoto() { return heroPhoto; }, castRigs, load: loadT,
  views: viewStats, pools: { cars: carPool, rigs: rigPool }, metrics, activities: activityState, startEvent,
  step(n = 60, dt = 1 / 60) { for (let i = 0; i < n; i++) { update(dt); render(dt); } return { calls: renderer.info.render.calls, tris: renderer.info.render.triangles }; },
};
// the soak report (KC3.soak) gets the city's chunk manager beside the traffic numbers entities.js gives it
if (typeof globalThis.KCSTATS === 'function' && city.chunks) {
  const traffic = globalThis.KCSTATS;
  globalThis.KCSTATS = Object.assign(() => ({ ...traffic(), chunks: city.chunks.stats(), city: city.stats?.() }), { reset: traffic.reset });
}
// the fixed views and the perf bench (src/3d/bench.js): KC3.teleport(name), KC3.bench(names), KC3.soak(sec)
const bench = installBench({ KC3: window.KC3, G, renderer, gfx, place: benchPlace, start: () => startGame(hasSave()) });

let last = performance.now();
function loop(now) {
  const raw = (now - last) / 1000;
  const dt = Math.min(0.05, raw);
  last = now;
  if (raw < 1 && bench.busy !== 'bench') gfx.adapt(raw);   // auto quality holds still while the bench measures
  fpsMeter.frame(raw);
  const t0 = performance.now();
  update(dt);
  render(dt);
  bench.frame(performance.now() - t0, raw);
  if (loadT.firstFrame == null) loadT.firstFrame = Math.round(performance.now());
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Dev screenshots (tools/shot.sh runs headless Chrome on its own profile): ?shot=<bench view>[&hour=15.5]
// [&cam=x,y,z,lookX,lookY,lookZ in metres][&hud=1] starts a throwaway game that never saves, stands Kimchi on
// the view with the clock held still and, with cam, holds a fixed camera. &bench=1 also runs KC3.bench on
// that view (Medium, at that hour) and logs 'KCBENCH <json>' with the city's stats, for headless runs; &drive=1
// holds W (drive or walk ahead) for 6 s and logs 'KCDRIVE <json>' each second. &route=x0,z0,x1,z1[,vmax] (m)
// drives Kimchi's car (the view's, or a new Ursa) along the roads from the first point to the second at up to
// vmax m/s (30 by default, bends at 70% of the grip) with KC3.metrics on, logging 'KCROUTE <json>' each second
// and 'KCROUTE_END <json>' (the metrics) at the end (tools/s6b_drive.mjs); &freeze=<s> holds the action still
// after s seconds of it, &freeze=air at its first 0.25 s of airtime, for a screenshot. &go=x,z,heading[,speed]
// (m, rad, m/s; 15 by default) instead puts the car there and drives it straight on at that speed (through a
// pond, at a kerb, at a jump), &freeze as for a route. &act=<what> shows the open-world layer (activities.js):
// an event id (bay_loop, deco_sprint, …) starts that race board event, 'pop' shows a sample record popup,
// 'board' opens the race board and 'map' the big map with every hub but one found.
const PXM = 1 / S;
function devActivity(what) {
  if (what === 'pop') { demoPop(); console.log('KCACT pop'); }
  else if (what === 'board') { openBoard(); console.log('KCACT board'); }
  else if (what === 'map') {
    for (const id of ['villa', 'seoul_circle', 'fest', 'kimchi_air']) G.pr.found[id] = { day: 1 };
    toggleBigMap(true);
  } else if (startEvent(what)) {
    // 'KCACT count' and 'KCACT run' mark the countdown and the GO for tools/s8_rtshot.mjs
    let said = '';
    const tell = setInterval(() => {
      const ph = activityState.event?.phase;
      if (ph && ph !== said && ph !== 'travel') { said = ph; console.log('KCACT ' + ph); }
      if (!activityState.event) clearInterval(tell);
    }, 100);
    if (!shot.actdrive) return;
    // once the fade has put the car on the start line, drive the course (held still through the countdown)
    const R = routes[what];
    setTimeout(() => G.player.car && followNav({ pts: R.pts, s: R.s, len: R.len }, G.player.car, 40, shot.freeze), 1200);
  }
}
function goStraight([x, z, a, speed = 15], freeze) {
  const p = G.player;
  let c = p.car;
  if (!c) { c = makeCar('ursa', x * PXM, z * PXM, a); G.cars.push(c); p.car = c; }
  Object.assign(c, { x: x * PXM, y: z * PXM, a, vx: Math.cos(a) * speed * PXM, vy: Math.sin(a) * speed * PXM, speed: speed * PXM, gy: undefined, air: 0 });
  Object.assign(p, { x: c.x, y: c.y });
  cam.yaw = a; cam.init = false;
  const view = carViews.get(c);
  if (view) view.init = false;
  const t0 = G.t;
  let logT = 0;
  devPilot = () => {
    if (G.t - t0 >= logT) { logT += 0.5; console.log('KCGO ' + JSON.stringify({ t: +(G.t - t0).toFixed(2), x: +(c.x / PXM).toFixed(1), z: +(c.y / PXM).toFixed(1), air: +(c.air || 0).toFixed(2), gy: +(c.gy ?? 0).toFixed(2), frozen: shot.frozen })); }
    touch.active = true; touch.ax = 0;
    touch.ay = (c.vx * Math.cos(c.a) + c.vy * Math.sin(c.a)) / PXM < speed ? -1 : 0;
    if (!shot.frozen && ((freeze === 'air' && c.air > 0.25) || (+freeze > 0 && G.t - t0 >= +freeze))) {
      shot.frozen = true;
      console.log('KCGO frozen ' + JSON.stringify({ x: +(c.x / PXM).toFixed(1), z: +(c.y / PXM).toFixed(1), y: +(carViews.get(c)?.y ?? 0).toFixed(2), air: +(c.air || 0).toFixed(2) }));
    }
  };
}
function driveRoute([x0, z0, x1, z1, vmax = 30], freeze) {
  const p = G.player, nav = roads.route?.(x0 * PXM, z0 * PXM, x1 * PXM, z1 * PXM);
  if (!nav || nav.pts.length < 4) { console.log('KCROUTE failed: no route'); return; }
  let c = p.car;
  if (!c) { c = makeCar('ursa', nav.pts[0], nav.pts[1], 0); G.cars.push(c); p.car = c; }
  const a = Math.atan2(nav.pts[3] - nav.pts[1], nav.pts[2] - nav.pts[0]);
  Object.assign(c, { x: nav.pts[0], y: nav.pts[1], a, vx: 0, vy: 0, speed: 0, gy: undefined, air: 0 });
  Object.assign(p, { x: c.x, y: c.y });
  cam.yaw = a; cam.init = false;
  const view = carViews.get(c);
  if (view) view.init = false;
  followNav(nav, c, vmax, freeze);
}
// The dev pilot along nav ({ pts, s?, len } px) in car c from where it is, at up to vmax m/s (driveRoute, and
// &act=<event>&actdrive=1, which drives the event's course once the car is on its start line).
function followNav(nav, c, vmax, freeze) {
  if (!nav.s) { nav.s = new Float32Array(nav.pts.length / 2); for (let i = 1; i < nav.s.length; i++) nav.s[i] = nav.s[i - 1] + Math.hypot(nav.pts[2 * i] - nav.pts[2 * i - 2], nav.pts[2 * i + 1] - nav.pts[2 * i - 1]); }
  nav.len ??= nav.s[nav.s.length - 1];
  metrics.reset().on = true;
  const t0 = G.t, end = nav.len - 6 * PXM;
  let logT = 1, airMax = 0;
  devPilot = () => {
    const v = (c.vx * Math.cos(c.a) + c.vy * Math.sin(c.a)) / PXM, t = G.t - t0;
    const pt = roads.follow(nav, c.x, c.y, clamp(8 + 0.5 * v, 8, 30) * PXM);
    const want = Math.min(vmax, Math.sqrt(0.7 * 2 * 9.81 * bendAhead(nav, 60)));
    touch.active = true;
    touch.ax = clamp(angDiff(c.a, Math.atan2(pt[1] - c.y, pt[0] - c.x)) * 2.5, -1, 1);
    touch.ay = v < want ? -1 : v > want * 1.08 ? 1 : 0;
    touch.run = shot.hb && Math.abs(touch.ax) > 0.5;   // &hb=1: the handbrake through the bends (a drift)
    airMax = Math.max(airMax, c.air || 0);
    if (!shot.frozen && ((freeze === 'air' && c.air > 0.25) || (+freeze > 0 && t >= +freeze))) {
      shot.frozen = true;
      console.log('KCROUTE frozen ' + JSON.stringify({ x: +(c.x / PXM).toFixed(1), z: +(c.y / PXM).toFixed(1), a: +c.a.toFixed(3), y: +(carViews.get(c)?.y ?? 0).toFixed(2) }));
    }
    if (t >= logT) { logT++; console.log('KCROUTE ' + JSON.stringify({ t: Math.round(t), x: Math.round(c.x / PXM), z: Math.round(c.y / PXM), v: +v.toFixed(1), at: Math.round(nav.at / PXM) })); }
    if (nav.at >= end || t > 240) {
      devPilot = null; touch.active = false; touch.run = false; touch.ax = touch.ay = 0;
      console.log('KCROUTE_END ' + JSON.stringify({ ...metrics, t: +t.toFixed(1), len: Math.round(nav.len / PXM), airMax: +airMax.toFixed(2), done: nav.at >= end }));
      metrics.on = false;
    }
  };
}
// the tightest radius (m) of a route over the len m ahead of where it was last followed (points 6 m apart)
function bendAhead(nav, len) {
  const at = nav.at || 0, pts = [];
  for (let d = 0; d <= len; d += 6) pts.push(routePoint(nav, at + d * PXM));
  let r = Infinity;
  for (let k = 1; k + 1 < pts.length; k++) {
    const x1 = pts[k][0] - pts[k - 1][0], y1 = pts[k][1] - pts[k - 1][1], x2 = pts[k + 1][0] - pts[k][0], y2 = pts[k + 1][1] - pts[k][1];
    const turn = Math.abs(Math.atan2(x1 * y2 - y1 * x2, x1 * x2 + y1 * y2));
    if (turn > 1e-4) r = Math.min(r, (Math.hypot(x1, y1) + Math.hypot(x2, y2)) / 2 / PXM / turn);
  }
  return r;
}
function routePoint(nav, s) {
  const P = nav.pts, st = nav.s, n = st.length;
  let lo = 0, hi = n - 1;
  if (s >= st[hi]) return [P[2 * hi], P[2 * hi + 1]];
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (st[mid] <= s) lo = mid; else hi = mid; }
  const f = (s - st[lo]) / Math.max(1e-6, st[hi] - st[lo]);
  return [P[2 * lo] + (P[2 * hi] - P[2 * lo]) * f, P[2 * lo + 1] + (P[2 * hi + 1] - P[2 * lo + 1]) * f];
}
if (shot.view) {
  if (!shot.hud) document.getElementById('hud')?.style.setProperty('visibility', 'hidden');
  setTimeout(() => {
    startGame(false);
    window.KC3.teleport(shot.view);
    G.time = shot.hour * 60;
    setInterval(() => { G.time = shot.hour * 60; }, 50);
    if (shot.bench) {
      setTimeout(() => window.KC3.bench([shot.view], { frames: 40, warm: 60, time: shot.hour * 60 })
        .then((r) => console.log('KCBENCH ' + JSON.stringify({ ...r[0], load: loadT, city: city.stats?.() })))
        .catch((e) => console.log('KCBENCH failed ' + e)), 300);
    }
    if (shot.drive) {
      let n = 0;
      const t0 = G.t, f0 = renderer.info.render.frame;
      keys.KeyW = true;
      const id = setInterval(() => {
        const p = G.player, c = p.car;
        console.log('KCDRIVE ' + JSON.stringify({ s: ++n, t: +(G.t - t0).toFixed(2), frames: renderer.info.render.frame - f0, x: Math.round(p.x / 16), z: Math.round(p.y / 16),
          y: +(c ? carViews.get(c)?.y ?? 0 : hero.gy ?? 0).toFixed(2), speed: c ? +((c.speed || 0) / 16).toFixed(1) : null, terrain: city.terrain?.stats?.() }));
        if (n >= 6) { keys.KeyW = false; clearInterval(id); }
      }, 1000);
    }
    if (shot.route) driveRoute(shot.route, shot.freeze);
    else if (shot.go) goStraight(shot.go, shot.freeze);
    if (shot.act) setTimeout(() => devActivity(shot.act), 300);
  }, 200);
}
