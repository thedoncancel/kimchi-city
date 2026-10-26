import { G } from '../state.js';
import { photoSpots, landmarks, sightClear, groundY, PX_PER_M } from '../world.js';
import { CAR_TYPES, ITEMS } from '../data.js';
import { money, compact, pick, angDiff } from '../util.js';
import { placeMenus, spend, closeMenu, toast, fade, onNewDay, shopItems, shopRow } from '../ui.js';
import { sfx } from '../audio.js';
import { save } from '../save.js';
import { bigText } from './hud3d.js';

// Kimchi's other job: posting. Pictures at landmark spots grow followers, followers bring brand deals.

const CAPTIONS = {
  villa: ['sunday reset 🌊', 'home', 'pool day', 'quiet mornings'],
  motors: ['new toy 🔑', 'which one next', 'spec sheet looked good'],
  jet: ['wheels up ✈️', 'see you in paris', 'cleared for takeoff'],
  marina: ['boat day ⚓', 'sunset from the deck', 'salt air'],
  ocean: ['drive with me', 'ocean drive at golden hour', 'top down'],
  boutiques: ['small haul 🛍️', 'had to', 'wrist check'],
  park: ['touch grass', 'fountain fit check', 'slow day'],
  // the Kimchi Key's spots (docs/map-v2-spec.md §5.2)
  skyline: ['the whole key from up here', 'skyline check 🌆', 'tower in the distance'],
  kimchi_sign: ['K I M C H I 🌶️', 'under the letters', 'hollywood who?'],
  causeway: ['bridge day 🌉', 'over the bay', 'cable stays and sea breeze'],
  lighthouse: ['end of the key 🌙', 'lighthouse hours', 'the beam goes round and round'],
  neon: ['neon nights ✨', 'alley glow', 'hongdae but make it miami'],
  glades: ['gator country 🐊', 'out in the glades', 'swamp walk'],
  jetblast: ['jet blast beach ✈️', 'planes overhead', 'hold onto your hat'],
  fest: ['festival mode 🎡', 'ferris wheel szn', 'see you at the fest'],
};

// A spot's own bonus (spec §5.2): x1.25 when the light is its time of day (golden: the evening golden hour,
// 5-7:30 pm, as shotValue counts it; night: 8 pm to 5 am) and x1.25 when its landmark is in the picture.
const SPOT_BONUS = 1.25;
const LOOK_NAMES = { kimchi_tower: 'Kimchi Tower', causeway_pylon: 'the causeway pylon' };
const TIME_NAMES = { golden: 'golden hour', night: 'night' };
const isGolden = h => h >= 17 && h < 19.5, isNight = h => h >= 20 || h < 5;
export function spotBonus(spot) {
  const h = G.time / 60;
  const time = spot.time === 'golden' ? isGolden(h) : spot.time === 'night' ? isNight(h) : false;
  const look = !!spot.look && inFrame(spot.look);
  return { time, look, k: (time ? SPOT_BONUS : 1) * (look ? SPOT_BONUS : 1) };
}

// Is landmark `id` in the picture, with nothing in front of it? The 3D game's camera decides (photoView.camera,
// or the one main3d puts on window.KC3): the landmark's middle, two thirds of the way up, must be inside the
// frame (a little in from its edges), and the line to its near side clear of hills and buildings
// (world.sightClear). Without a camera (node), the way Kimchi's car, or Kimchi, faces stands in for it,
// within FACING.
export const photoView = { camera: null };
const FRAME = 0.92, FACING = 35 * Math.PI / 180;
function inFrame(id) {
  const L = landmarks.find(l => l.id === id);
  if (!L) return false;
  const M = PX_PER_M, x = L.x * M, y = L.z * M, h = (L.base || 0) + (L.h || 0) * 0.66;
  const cam = photoView.camera || globalThis.KC3?.camera;
  let ex, ey, eh;
  if (cam?.matrixWorldInverse && cam.projectionMatrix) {
    if (!onScreen(cam, L.x, h, L.z)) return false;
    ex = cam.position.x * M; ey = cam.position.z * M; eh = cam.position.y;
  } else {
    const p = G.player, from = p.car || p, a = p.car ? p.car.a : (p.heading ?? 0);
    if (Math.abs(angDiff(a, Math.atan2(y - from.y, x - from.x))) > FACING) return false;
    ex = from.x; ey = from.y; eh = groundY(from.x, from.y) + 1.5;
  }
  // stop short of the landmark's own footprint, which stands in the occupancy grid too
  const r = (Math.hypot(L.w || 6, L.d || L.w || 6) / 2 + 2) * M, d = Math.hypot(x - ex, y - ey);
  if (d <= r) return true;
  const k = 1 - r / d;
  return sightClear(ex, ey, eh, ex + (x - ex) * k, ey + (y - ey) * k, h);
}

// Where world point (X, Y, Z) m lands in the camera's picture: inside the frame (normalised device
// coordinates within FRAME) and in front of the camera. Plain matrix sums, so this file needs no three.
function onScreen(cam, X, Y, Z) {
  const v = cam.matrixWorldInverse.elements, P = cam.projectionMatrix.elements;
  const vx = v[0] * X + v[4] * Y + v[8] * Z + v[12], vy = v[1] * X + v[5] * Y + v[9] * Z + v[13], vz = v[2] * X + v[6] * Y + v[10] * Z + v[14];
  const cx = P[0] * vx + P[4] * vy + P[8] * vz + P[12], cy = P[1] * vx + P[5] * vy + P[9] * vz + P[13];
  const cw = P[3] * vx + P[7] * vy + P[11] * vz + P[15];
  return cw > 0 && Math.abs(cx / cw) <= FRAME && Math.abs(cy / cw) <= FRAME;
}

const near = (s, p, r = 110) => Math.hypot(p.x - s.x, p.y - s.y) < r;
export const spotReady = (s) => G.posted[s.id] !== G.day;
export function photoSpotNear(p) { return photoSpots.find(s => near(s, p)) || null; }

// what is in the picture: the car you are in or standing by, the fit and the watch, the light
function shotValue(spot) {
  const p = G.player;
  let car = p.car;
  if (!car) car = G.cars.filter(c => !c.wreck && Math.hypot(c.x - p.x, c.y - p.y) < 140).sort((a, b) => CAR_TYPES[b.type].price - CAR_TYPES[a.type].price)[0];
  const carK = car ? 1 + Math.min(3, CAR_TYPES[car.type].price / 320000) : 1;
  const watch = ITEMS[G.equipped.watch];
  const styleK = 1 + (G.equipped.fit ? 0.25 : 0) + (watch ? Math.min(1.5, watch.price / 450000) : 0) + (G.equipped.chain ? 0.15 : 0);
  const h = G.time / 60;
  const light = isGolden(h) ? 1.6 : isNight(h) ? 1.25 : 1;
  const extra = spotBonus(spot);
  return { car, k: spot.bonus * carK * styleK * light * extra.k, golden: light > 1.5, extra };
}

export function postPhoto(spot) {
  if (!spotReady(spot)) { toast(`📸 You already posted from ${spot.name} today. The algorithm wants something new.`); return null; }
  const { car, k, golden, extra } = shotValue(spot);
  const gained = Math.round(1600 * k * (0.85 + Math.random() * 0.4));
  const cash = Math.round(gained * 2 / 10) * 10;
  G.followers += gained;
  G.money += cash;
  G.posted[spot.id] = G.day;
  G.stats.posts = (G.stats.posts || 0) + 1;
  sfx.click(); setTimeout(() => sfx.pop(), 90);
  const flash = document.getElementById('flash');
  if (flash) { flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go'); }
  const caption = pick(CAPTIONS[spot.id] || ['📸']);
  const when = golden ? ` at golden hour${extra.time ? ' ×1.25' : ''}` : extra.time ? ' · night shot ×1.25' : '';
  const look = extra.look ? ` · ${LOOK_NAMES[spot.look] || spot.look} in the shot ×1.25` : '';
  toast(`📸 Posted "${caption}"${car ? ` with the ${CAR_TYPES[car.type].name}` : ''}${when}${look} · +${compact(gained)} followers · ${money(cash)} brand deal`, 6000);
  // a spot whose bonus was missed says how to get it next time
  const tips = [];
  if (spot.look && !extra.look) tips.push(`with ${LOOK_NAMES[spot.look] || spot.look} in the shot`);
  if (spot.time && !extra.time) tips.push(`at ${TIME_NAMES[spot.time] || spot.time}`);
  if (tips.length) toast(`💡 ${spot.name} pays ×1.25 ${tips.join(' or ')}.`, 5000);
  milestones();
  save();
  return { gained, cash };
}

const MILESTONES = [[250000, 50000], [300000, 75000], [400000, 100000], [500000, 150000], [750000, 250000], [1000000, 500000], [2000000, 1000000]];
function milestones() {
  for (const [n, bonus] of MILESTONES) {
    const key = 'm' + n;
    if (G.followers >= n && !G.seen[key]) {
      G.seen[key] = true;
      G.money += bonus;
      sfx.yay();
      bigText(`${compact(n)} FOLLOWERS`, `A brand deal just landed: +${money(bonus)}`, '#f2d27a', 4, true);
    }
  }
}

// ---------- the private jet ----------

export const JET_PRICE = 12500000;
const TRIPS = [
  { id: 'napa', name: 'Napa Valley', icon: '🍇', hours: 16, fuel: 45000, gain: [12000, 22000], caption: 'october vlog in bio' },
  { id: 'paris', name: 'Paris', icon: '🗼', hours: 30, fuel: 85000, gain: [18000, 30000], caption: 'balcony mornings in paris' },
  { id: 'alps', name: 'St. Moritz', icon: '🏔️', hours: 28, fuel: 95000, gain: [16000, 28000], caption: 'ski in, ski out' },
  { id: 'dubai', name: 'Dubai', icon: '🏜️', hours: 26, fuel: 120000, gain: [20000, 34000], caption: 'dunes at sunset' },
  { id: 'maldives', name: 'Maldives', icon: '🏝️', hours: 36, fuel: 140000, gain: [25000, 42000], caption: 'overwater villa szn' },
];

function passTime(hours) {
  G.time += hours * 60;
  while (G.time >= 1440) { G.time -= 1440; G.day++; onNewDay(); }
}

function takeTrip(trip, cost) {
  if (!spend(cost)) return;
  closeMenu();
  fade(() => {
    passTime(trip.hours);
    G.energy = 100;
    G.health = Math.max(G.health, 100);
    const gained = Math.round(trip.gain[0] + Math.random() * (trip.gain[1] - trip.gain[0]));
    G.followers += gained;
    G.trips = (G.trips || 0) + 1;
    bigText(`${trip.icon} ${trip.name.toUpperCase()}`, `"${trip.caption}" · +${compact(gained)} followers`, '#f2d27a', 4.5, true);
    toast(`✈️ Back from ${trip.name}. Fully rested · +${compact(gained)} followers`, 5000);
    milestones();
    save();
  });
}

function jetMenu() {
  const owned = !!G.assets.jet;
  const items = [];
  if (!owned) {
    items.push({ icon: '🛩️', label: 'Buy Kimchi One', desc: 'Your own long-range private jet · trips cost only fuel', right: money(JET_PRICE),
      action: () => { if (!spend(JET_PRICE)) return; G.assets.jet = true; sfx.yay(); toast('🛩️ Kimchi One is yours. Wheels up whenever you like.', 5000); save(); } });
  }
  for (const tr of TRIPS) {
    const cost = owned ? tr.fuel : tr.fuel * 3;
    items.push({ icon: tr.icon, label: `${owned ? 'Fly' : 'Charter a jet'} to ${tr.name}`, desc: `${tr.hours}h away · fully rested · +${compact(tr.gain[0])}–${compact(tr.gain[1])} followers`,
      right: money(cost), action: () => takeTrip(tr, cost) });
  }
  return { icon: '✈️', title: 'Kimchi Air', sub: owned ? 'Kimchi One is fuelled and waiting on the apron.' : 'Private terminal. Charter today, or make the jet yours.', sections: [{ items }] };
}

// ---------- the yacht club ----------

export const YACHT_PRICE = 8800000;
function yachtMenu() {
  const owned = !!G.assets.yacht;
  const items = [];
  if (!owned) {
    items.push({ icon: '🛥️', label: 'Buy the 30 m yacht', desc: 'The big one at the end of the pier · yacht days are free', right: money(YACHT_PRICE),
      action: () => { if (!spend(YACHT_PRICE)) return; G.assets.yacht = true; sfx.yay(); toast('🛥️ The yacht is yours. Name her something good.', 5000); save(); } });
  }
  items.push({ icon: '🌅', label: 'Yacht day with friends', desc: '+40 energy · 5 hours on the water · +8K–15K followers', right: owned ? 'Free' : money(65000),
    action: () => {
      if (!owned && !spend(65000)) return;
      closeMenu();
      fade(() => {
        passTime(5);
        G.energy = Math.min(100, G.energy + 40);
        const gained = Math.round(8000 + Math.random() * 7000);
        G.followers += gained;
        bigText('⚓ YACHT DAY', `"salt air" · +${compact(gained)} followers`, '#f2d27a', 4, true);
        milestones();
        save();
      });
    } });
  return { icon: '🛥️', title: 'Yacht Club', sub: owned ? 'Your yacht is moored at the end of the pier.' : 'Members only. Kimchi is always a member.', sections: [{ items }] };
}

// ---------- boutiques ----------

function watchMenu() {
  return {
    icon: '⌚', title: 'Chrono Row', sub: '"Each piece is allocated, Mr. Kimchi. These are for you."',
    sections: [{ label: 'Watches · worn on the left wrist', items: shopItems('watch').map(shopRow) }],
  };
}
function fashionMenu() {
  return {
    icon: '👜', title: 'Maison K', sub: 'Fits from the feed, leather goods, and a little caviar on the way out.',
    sections: [
      { label: 'Fits', items: shopItems('boutique', 'fit').map(shopRow) },
      { label: 'Accessories', items: shopItems('boutique', 'style').map(shopRow) },
      { label: 'Gifts for friends', items: shopItems('boutique', 'gift').map(shopRow) },
      { label: 'Champagne bar', items: shopItems('boutique', 'food').map(shopRow) },
    ],
  };
}

Object.assign(placeMenus, { jet: jetMenu, marina: yachtMenu, watches: watchMenu, fashion: fashionMenu });
