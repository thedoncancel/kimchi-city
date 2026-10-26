#!/usr/bin/env node
// Stage S7a photo spots on the Kimchi Key (src/3d/lifestyle.js; docs/map-v2-spec.md §5.2). In node, with
// tools/s7b_env.mjs's tiny DOM so the real ui.js shows the toasts. Checks:
//  - every one of the 15 spots has captions, and Kimchi can stand where P posts from it (within 110 px);
//  - the time bonus: x1.25 at golden hour (marina, ocean) and at night (kimchi_sign, lighthouse, neon), not
//    at other times, on top of the light every picture gets;
//  - the look bonus with the game's camera: Kimchi Tower from Lookout Knoll and the pylon from the causeway
//    count when in the picture with a clear view, not when the camera looks away or a building is in front;
//    without a camera, the way Kimchi faces stands in;
//  - a post says which bonus it got, and a missed bonus brings a tip;
//  - a spot posts once a day, and followers and cash go up.
//   node tools/s7a_photo_test.mjs [-v]
import { check, section, note, done, byId } from './s7b_env.mjs';

const THREE = await import('three');
const W = await import('../src/world.js');
const { G, resetState } = await import('../src/state.js');
const life = await import('../src/3d/lifestyle.js');
const ent = await import('../src/entities.js');
const PX = W.PX_PER_M;

check('the world is v2', W.KIND === 'v2');
W.generate();
resetState();
Object.assign(G, { mode: 'play', t: 0, friends: [], cars: [], peds: [] });
const spot = id => W.photoSpots.find(s => s.id === id);
// every toast ui.js shows (the stub DOM keeps 4 on screen, as the game does)
const shown = [], box = byId('toasts');
box.appendChild = el => { shown.push(el); box.children.push(el); el.parent = box; if (box.children.length > 4) box.children.shift(); return el; };
const toasts = () => shown.map(c => c.textContent);
const cam = new THREE.PerspectiveCamera(60, 1440 / 800, 0.15, 2600);
// the chase camera: d m behind Kimchi (at sim px x, y) and h m up, looking at a world point (m)
function aim(x, y, lookX, lookY, lookZ, d = 4.5, h = 1.8) {
  const gx = x / PX, gz = y / PX, gy = W.groundY(x, y);
  const dx = lookX - gx, dz = lookZ - gz, L = Math.hypot(dx, dz) || 1;
  cam.position.set(gx - dx / L * d, gy + h, gz - dz / L * d);
  cam.lookAt(lookX, lookY, lookZ);
  cam.updateMatrixWorld();
  life.photoView.camera = cam;
}
const lm = id => W.landmarks.find(l => l.id === id);

section('spots');
{
  check('there are 15 photo spots', W.photoSpots.length === 15, String(W.photoSpots.length));
  // the captions table is private; a post's toast quotes one of them, so post from each spot once
  const r = ent.CFG.playerR;
  for (const s of W.photoSpots) {
    let stand = null;
    for (let d = 0; d <= 100 && !stand; d += 4) for (let k = 0; k < 16 && !stand; k++) {
      const x = s.x + Math.cos(k * Math.PI / 8) * d, y = s.y + Math.sin(k * Math.PI / 8) * d;
      if (!ent.circleBlocked(x, y - 4, r)) stand = { x, y, d };
    }
    check(`${s.id}: Kimchi can stand within reach of it`, !!stand && !!life.photoSpotNear(stand), stand ? `${(stand.d / PX).toFixed(1)} m` : 'nowhere');
    G.time = 14 * 60; G.posted = {};
    Object.assign(G.player, { x: stand.x, y: stand.y, car: null, heading: 0 });
    life.photoView.camera = null;
    life.postPhoto(s);
    const t = toasts().findLast(x => x.includes('Posted')) || '';
    const cap = /Posted "([^"]+)"/.exec(t)?.[1];
    check(`${s.id}: the post has its own caption`, !!cap && cap !== '📸', t);
  }
}

section('time of day');
for (const [id, good, bad] of [['marina', 18, 13], ['ocean', 18, 9], ['kimchi_sign', 22, 15], ['lighthouse', 3, 12], ['neon', 21, 19]]) {
  const s = spot(id);
  G.time = good * 60; const a = life.spotBonus(s);
  G.time = bad * 60; const b = life.spotBonus(s);
  check(`${id}: x1.25 at ${good}:00 (${s.time}), not at ${bad}:00`, a.time && a.k === 1.25 && !b.time && b.k === 1);
}
{
  G.time = 22 * 60;
  const b = life.spotBonus(spot('villa'));
  check('a spot without a time gets no time bonus', !b.time && b.k === 1);
}

section('landmarks in the picture');
{
  const sky = spot('skyline'), T = lm('kimchi_tower'), ty = T.base + T.h * 0.6;
  G.time = 14 * 60;
  aim(sky.x, sky.y, T.x, ty, T.z);
  check('skyline: Kimchi Tower in frame from Lookout Knoll', life.spotBonus(sky).look);
  aim(sky.x, sky.y, T.x - 900, ty, T.z - 400);
  check('skyline: looking away, no bonus', !life.spotBonus(sky).look);
  aim(sky.x, sky.y, T.x, ty + 400, T.z);
  check('skyline: looking up into the sky over it, no bonus', !life.spotBonus(sky).look);
  const cw = spot('causeway'), P = lm('causeway_pylon');
  aim(cw.x, cw.y, P.x, P.base + P.h * 0.6, P.z, 6, 2.2);
  check('causeway: the pylon in frame from the deck', life.spotBonus(cw).look);
  aim(cw.x, cw.y, P.x + 300, P.base, P.z + 400, 6, 2.2);
  check('causeway: looking down the bay, no bonus', !life.spotBonus(cw).look);
  // a building between the camera and the tower: a tall one downtown, the camera on its far side
  const b = W.buildings.filter(q => q.h >= 30 && q.landmark !== 'kimchi_tower')
    .map(q => ({ q, d: Math.hypot(q.cx - T.x, q.cz - T.z) })).filter(o => o.d > 120).sort((u, v) => u.d - v.d)[0].q;
  const ux = (b.cx - T.x), uz = (b.cz - T.z), L = Math.hypot(ux, uz), back = Math.max(b.w, b.d) / 2 + 3;
  const cx = (b.cx + ux / L * back) * PX, cy = (b.cz + uz / L * back) * PX;
  cam.position.set(cx / PX, W.groundY(cx, cy) + 1.6, cy / PX);
  cam.lookAt(T.x, ty, T.z); cam.updateMatrixWorld();
  life.photoView.camera = cam;
  check(`a ${b.h.toFixed(0)} m building in front of the tower blocks the bonus`, !life.spotBonus({ ...sky, x: cx, y: cy }).look);
  // without a camera: the way Kimchi faces
  life.photoView.camera = null;
  const saved = globalThis.KC3; delete globalThis.KC3;
  Object.assign(G.player, { x: sky.x, y: sky.y, car: null, heading: Math.atan2(T.z * PX - sky.y, T.x * PX - sky.x) });
  check('no camera: Kimchi facing the tower counts', life.spotBonus(sky).look);
  G.player.heading += Math.PI / 2;
  check('no camera: Kimchi facing away does not', !life.spotBonus(sky).look);
  globalThis.KC3 = saved;
}

section('posting');
{
  const n = spot('neon');
  Object.assign(G.player, { x: n.x, y: n.y, car: null, heading: 0 });
  life.photoView.camera = null;
  G.posted = {}; G.time = 21 * 60; G.day = 3;
  const f0 = G.followers, m0 = G.money;
  life.postPhoto(n);
  const t = toasts().slice(-2);
  check('a night post at Neon Alley says so', /night shot ×1\.25/.test(t.join(' | ')), t.join(' | '));
  check('followers and cash go up', G.followers > f0 && G.money > m0);
  life.postPhoto(n);
  check('the same spot posts once a day', /already posted/.test(toasts().at(-1) || ''));
  G.posted = {}; G.time = 13 * 60;
  life.postPhoto(n);
  check('a day post at Neon Alley tips the night bonus', /pays ×1\.25 at night/.test(toasts().at(-1) || ''), toasts().at(-1));
  const sky = spot('skyline'), T = lm('kimchi_tower');
  G.posted = {}; G.time = 14 * 60;
  aim(sky.x, sky.y, T.x, T.base + T.h * 0.6, T.z);
  life.postPhoto(sky);
  check('a skyline post with the tower in frame says so', /Kimchi Tower in the shot ×1\.25/.test(toasts().slice(-2).join(' | ')), toasts().slice(-2).join(' | '));
}
note(`toasts seen: ${toasts().length}`);
done('s7a photo');
