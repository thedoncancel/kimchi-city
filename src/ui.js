import { G, newRequest, nightLevel, clockText } from './state.js';
import { ITEMS, CAR_TYPES, DEALER, FRIENDS, KNOCK_LINES } from './data.js';
import { places, buildings, jarSpots, photoSpots, regions, regionAt, BOUNDS, KIND, PX_PER_M, mapImage } from './world.js';
import { spawnOwnedCar, spawnGarage, enterCar, exitCar } from './entities.js';
import { sfx } from './audio.js';
import { save } from './save.js';
import { pick, money, compact, clamp } from './util.js';

const $ = id => document.getElementById(id);
const $menu = $('menu'), $panel = $('panel'), $toasts = $('toasts');
let actions = [];
let mapImg = null;   // the world's map picture, behind the 2D minimap and the big map

// ---------- toasts ----------

// While G.holdToasts is set (a race board event on its way to the start or counting down: activities.js) new
// toasts wait in heldToasts and the ones already up are hidden; afterwards updateHUD lets them out in order, one
// every DRIP_MS, and while the event runs (G.activityText) only once the one before has gone, so the tips held
// through a countdown never stack up over the road (a toast made while some still wait joins the line).
const heldToasts = [];
const DRIP_MS = 1500;
let dripAt = 0;
export function toast(msg, ms = 3200) {
  if (G.holdToasts || heldToasts.length) { if (heldToasts.length < 6) heldToasts.push([msg, ms]); return; }
  showToast(msg, ms);
}
function showToast(msg, ms) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $toasts.appendChild(el);
  while ($toasts.children.length > 4) $toasts.firstChild.remove();
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 400);
}

// ---------- menus ----------

export function openMenu(builder) {
  G.menu = builder;
  $menu.classList.remove('hidden');
  renderMenu();
  sfx.door();
}
export function closeMenu() {
  G.menu = null;
  $menu.classList.add('hidden');
}
function renderMenu() {
  if (!G.menu) return;
  const m = G.menu();
  actions = [];
  let html = `<div class="ph"><div class="picon">${m.icon || ''}</div><div class="pt"><h2>${m.title}</h2>${m.sub ? `<p>${m.sub}</p>` : ''}</div><button class="x" data-close aria-label="Close">✕</button></div>`;
  if (m.body) html += `<div class="pbody">${m.body}</div>`;
  for (const s of m.sections || []) {
    html += `<div class="sec">${s.label ? `<h3>${s.label}</h3>` : ''}<div class="items">`;
    for (const it of s.items) {
      const i = actions.length;
      actions.push(it);
      html += `<button class="item" data-i="${i}" ${it.disabled ? 'disabled' : ''}>
        <span class="ii">${it.icon || ''}</span>
        <span class="il"><b>${it.label}</b>${it.desc ? `<small>${it.desc}</small>` : ''}</span>
        ${it.right != null ? `<span class="ir">${it.right}</span>` : ''}
        ${i < 9 && !it.disabled ? `<kbd>${i + 1}</kbd>` : ''}
      </button>`;
    }
    html += `</div></div>`;
  }
  html += `<div class="pfoot"><span>💵 ${money(G.money)}${G.followers ? ` · 👥 ${compact(G.followers)}` : ''}</span><span>Esc to close</span></div>`;
  $panel.innerHTML = html;
}
function runAction(i) {
  const a = actions[i];
  if (!a || a.disabled) return;
  sfx.click();
  a.action();
  if (G.menu) renderMenu();
}
$panel.addEventListener('click', e => {
  if (e.target.closest('[data-close]')) { closeMenu(); return; }
  const b = e.target.closest('[data-i]');
  if (b) runAction(+b.dataset.i);
});
$menu.addEventListener('pointerdown', e => { if (e.target === $menu) closeMenu(); });

export function menuKey(code) {
  if (code === 'Escape' || code === 'KeyE' || code === 'KeyI') { closeMenu(); return; }
  const m = /^Digit([1-9])$/.exec(code);
  if (m) runAction(+m[1] - 1);
}

// ---------- economy ----------

export function spend(n) {
  if (G.money < n) { toast(`Not enough money 💸 You need ${money(n)}. Missions and posts pay the best.`); sfx.fail(); return false; }
  G.money -= n;
  return true;
}
export function earn(n) { G.money += n; sfx.coin(); }

const WEARABLE = ['style', 'watch', 'fit'];
export const isWearable = (id) => WEARABLE.includes(ITEMS[id]?.type);
export function wear(id, on = true) {
  const it = ITEMS[id];
  if (it.type === 'style') G.equipped[id] = on;
  else if (it.type === 'watch') G.equipped.watch = on ? id : null;
  else if (it.type === 'fit') G.equipped.fit = on ? id : null;
}
export const wearing = (id) => {
  const it = ITEMS[id];
  return it.type === 'watch' ? G.equipped.watch === id : it.type === 'fit' ? G.equipped.fit === id : !!G.equipped[id];
};

export function buy(id) {
  const it = ITEMS[id];
  if (isWearable(id) && G.inv[id]) return;
  if (!spend(it.price)) return;
  sfx.coin();
  G.inv[id] = (G.inv[id] || 0) + 1;
  if (isWearable(id)) { wear(id); toast(`${it.icon} Bought & wearing the ${it.name}!`); save(); }
  else toast(`${it.icon} Bought ${it.name}`);
}

function eat(id) {
  const it = ITEMS[id];
  if (!G.inv[id]) return;
  G.inv[id]--;
  G.energy = Math.min(100, G.energy + it.energy);
  if (G.health != null) G.health = Math.min(100, G.health + Math.round(it.energy / 3));
  sfx.pop();
  toast(`${it.icon} Yum! +${it.energy} energy`);
}

// ---------- places ----------

function homeMenu() {
  const h = Math.floor(G.time / 60);
  const night = h >= 19 || h < 6;
  const wardrobe = Object.keys(ITEMS).filter(k => isWearable(k) && G.inv[k]);
  const cars = [...new Set(G.owned)].filter(t => CAR_TYPES[t]);
  const worth = cars.reduce((s, t) => s + CAR_TYPES[t].price, 0);
  return {
    icon: '🏠', title: "Kimchi's Villa", sub: 'Concrete, glass and an infinity pool. Rest, change your fit, pick a car.',
    sections: [
      { label: 'Rest', items: [
        night
          ? { icon: '🛏️', label: 'Sleep until morning', desc: 'Full energy · saves the game', action: sleep }
          : { icon: '😴', label: 'Take a nap', desc: '+40 energy · 2 hours pass', action: nap },
        { icon: '💾', label: 'Save game', action: () => toast(save() ? '💾 Game saved' : 'Could not save in this browser') },
      ] },
      { label: 'Wardrobe', items: wardrobe.length ? wardrobe.map(k => ({
        icon: ITEMS[k].icon, label: ITEMS[k].name, desc: ITEMS[k].desc, right: wearing(k) ? 'Wearing' : 'Off',
        action: () => wear(k, !wearing(k)),
      })) : [{ icon: '👕', label: 'Nothing new to wear', desc: 'Maison K sells fits, Chrono Row sells watches', disabled: true, action() {} }] },
      { label: `Garage · ${cars.length} car${cars.length === 1 ? '' : 's'} · worth ${money(worth)}`, items: [
        ...cars.map(type => ({ icon: CAR_TYPES[type].lux ? '🏎️' : '🚗', label: CAR_TYPES[type].name, desc: CAR_TYPES[type].tag || 'Parked on the drive', disabled: true, action() {} })),
        { icon: '🔑', label: 'Valet: bring every car home', desc: 'Parks the whole collection on the drive', action: () => { spawnGarage(); closeMenu(); toast('🔑 The valet parked your collection on the drive'); } },
      ] },
    ],
  };
}

export function fade(cb) {
  const f = $('fade');
  f.classList.add('on');
  setTimeout(() => { cb(); f.classList.remove('on'); }, 650);
}
function sleep() {
  closeMenu();
  fade(() => {
    if (G.time >= 19 * 60) { G.day++; onNewDay(); }
    G.time = 8 * 60;
    G.energy = 100;
    save();
    toast(`☀️ Good morning! Day ${G.day} · game saved`);
  });
}
function nap() {
  closeMenu();
  fade(() => {
    G.time += 120;
    G.energy = Math.min(100, G.energy + 40);
    toast('😴 That nap hit different. +40 energy');
  });
}

export function shopRow(k) {
  const it = ITEMS[k];
  const owned = isWearable(k) && G.inv[k];
  const have = !isWearable(k) && G.inv[k] ? ` · you have ${G.inv[k]}` : '';
  const what = it.desc || (it.type === 'food' ? `+${it.energy} energy` : it.type === 'gift' ? (it.lux ? 'A gift friends never forget' : 'Friends love gifts') : 'Wear it around town');
  return { icon: it.icon, label: it.name, desc: what + have, right: owned ? 'Owned' : money(it.price), disabled: owned, action: () => buy(k) };
}
export const shopItems = (shop, type) => Object.keys(ITEMS).filter(k => ITEMS[k].shop === shop && (!type || ITEMS[k].type === type));

function martMenu() {
  return {
    icon: '🛒', title: 'K-Mart', sub: '"Welcome! Everything you need, 24/7." Even millionaires need banana milk.',
    sections: [{ label: 'Snacks', items: shopItems('mart', 'food').map(shopRow) }, { label: 'Gifts', items: shopItems('mart', 'gift').map(shopRow) }],
  };
}

function dealerPrice(type) {
  return Math.round(CAR_TYPES[type].price * (G.fs.dex.lvl >= 80 ? 0.8 : 1));
}
function dealerMenu() {
  const disc = G.fs.dex.lvl >= 80;
  return {
    icon: '🏎️', title: 'Kimchi Motors', sub: disc ? 'Dex hooked you up: 20% off everything!' : 'Supercars, hypercars, limousines. Delivered to your villa.',
    sections: [{ items: DEALER.map(type => {
      const c = CAR_TYPES[type];
      const owned = G.owned.includes(type);
      const bar = (n) => '■'.repeat(n) + '□'.repeat(Math.max(0, 6 - n));
      return {
        icon: type === 'gwagen' || type === 'ursa' ? '🚙' : type === 'monarch' || type === 'phantasma' ? '🚘' : '🏎️', label: c.name,
        desc: `${c.tag} · Speed ${bar(Math.round((c.max - 450) / 90))} · Grip ${bar(Math.round((c.turn - 1.6) * 3.4))}`,
        right: owned ? 'Owned' : money(dealerPrice(type)), disabled: owned,
        action: () => {
          if (!spend(dealerPrice(type))) return;
          G.owned.push(type);
          spawnOwnedCar(type);
          sfx.yay();
          toast(`🎉 The ${c.name} is yours! It's waiting on your villa's drive.`, 4500);
          save();
        },
      };
    }) }],
  };
}

function kimchiMenu() {
  const items = [];
  if (G.job) {
    items.push({ icon: '❌', label: 'Cancel delivery', desc: 'The customer will be sad', action: () => { G.job = null; toast('Delivery cancelled'); } });
  } else {
    items.push({ icon: '🛵', label: 'Start a VIP delivery', desc: 'Rush an order to a building across town. Faster = bigger tips.', action: startJob });
  }
  items.push({ icon: '🍲', label: 'Eat kimchi stew', desc: '+50 energy', right: '$8', action: () => {
    if (!spend(8)) return;
    G.energy = Math.min(100, G.energy + 50); sfx.pop(); toast('🍲 So good. +50 energy');
  } });
  return {
    icon: '🌶️', title: 'Kimchi House', sub: `"Kimchi! Our favorite delivery driver." · ${G.stats.deliveries} deliveries done`,
    sections: [{ items }],
  };
}

function yunaMenu() {
  const f = G.friends.find(x => x.def.id === 'yuna');
  return {
    icon: '💜', title: "Yuna's House", sub: G.fs.yuna.lvl >= 50 ? '"Come in! I made tea 🍵"' : 'Cute house with a purple roof.',
    sections: [{ items: [
      G.fs.yuna.lvl >= 50
        ? { icon: '🍵', label: 'Have tea with Yuna', desc: '+30 energy · once per visit', action: () => { G.energy = Math.min(100, G.energy + 30); closeMenu(); say(f, 'Come back anytime! 💜'); } }
        : { icon: '🚪', label: 'Knock', desc: 'Become better friends to get invited in', action: () => { closeMenu(); say(f, 'Oh hi Kimchi! I\'m outside!'); } },
    ] }],
  };
}

function say(e, text) { if (e) e.bubble = { text, t: 3 }; }

// the 3D game adds its own places (gun shop, hospital, police) here
export const placeMenus = {};

export function openPlace(pl) {
  const builders = { home: homeMenu, mart: martMenu, dealer: dealerMenu, kimchi: kimchiMenu, yuna: yunaMenu, ...placeMenus };
  if (builders[pl.key]) openMenu(builders[pl.key]);
  else toast(`${pl.icon} ${pl.name} is closed today.`);
}

// ---------- friends ----------

const LEVELS = [[0, 'New friend'], [20, 'Friend'], [50, 'Good friend'], [80, 'Best friend']];
export const levelName = lvl => LEVELS.filter(l => lvl >= l[0]).pop()[1];

function addFs(f, n) {
  const s = G.fs[f.def.id];
  const before = levelName(s.lvl);
  s.lvl = Math.min(100, s.lvl + n);
  const after = levelName(s.lvl);
  if (after !== before) {
    sfx.yay();
    const bonus = { Friend: 2500, 'Good friend': 5000, 'Best friend': 10000 }[after];
    G.money += bonus;
    toast(`💖 ${f.def.name} is now your ${after}! They gave you ${money(bonus)}.`, 5000);
    if (after === 'Best friend' && f.def.id === 'dex') toast('🚗 Dex: "20% off at the dealer for you, bestie."', 5000);
    if (after === 'Good friend' && f.def.id === 'yuna') toast('💜 Yuna invited you over for tea anytime.', 5000);
  }
}

function friendMenu(f) {
  return () => {
    const s = G.fs[f.def.id];
    const hearts = '♥'.repeat(Math.floor(s.lvl / 20)) + '♡'.repeat(5 - Math.floor(s.lvl / 20));
    const req = ITEMS[s.request];
    const reward = Math.max(1500, req.price * 60);
    const items = [
      { icon: '💬', label: 'Chat', desc: s.talked >= 3 ? 'You\'ve talked a lot today' : '+friendship', action: () => {
        say(f, pick(f.def.lines));
        if (s.talked < 3) { s.talked++; addFs(f, 4); }
        closeMenu();
      } },
      s.requestDone
        ? { icon: '✅', label: 'Today\'s favor done', desc: 'Come back tomorrow', disabled: true, action() {} }
        : { icon: req.icon, label: `Give ${req.name}`, desc: `${f.def.name} is craving it today · reward ${money(reward)}${G.inv[s.request] ? '' : ' · buy at K-Mart'}`,
            disabled: !G.inv[s.request], action: () => {
              G.inv[s.request]--; s.requestDone = true;
              earn(reward); addFs(f, 15);
              say(f, 'You\'re the best, Kimchi!!');
              toast(`${req.icon} ${f.def.name} paid you ${money(reward)}`);
            } },
    ];
    const gifts = Object.keys(G.inv).filter(k => G.inv[k] > 0 && !isWearable(k) && k !== (s.requestDone ? null : s.request));
    for (const k of gifts) {
      const it = ITEMS[k];
      const loved = k === f.def.likes;
      const pts = loved ? 25 : it.lux ? 30 : it.type === 'gift' ? 12 : 5;
      items.push({ icon: it.icon, label: `Gift ${it.name}`, desc: loved ? 'Their favorite! 💖' : `+${pts} friendship`, action: () => {
        G.inv[k]--; addFs(f, pts);
        say(f, loved ? 'NO WAY, my favorite!! 💖' : 'Aww, thanks Kimchi!');
        closeMenu();
      } });
    }
    items.push(f.following
      ? { icon: '👋', label: 'Say bye for now', desc: `${f.def.name} heads back`, action: () => { f.following = false; say(f, 'Later Kimchi!'); closeMenu(); } }
      : { icon: '🤝', label: 'Hang out', desc: 'They follow you & ride in your car · delivery tips +25%', action: () => {
          for (const o of G.friends) o.following = false;
          f.following = true; say(f, 'Let\'s gooo!'); addFs(f, 3); closeMenu();
        } });
    return { icon: '🙂', title: f.def.name, sub: `${levelName(s.lvl)} <span class="hearts">${hearts}</span>`, sections: [{ items }] };
  };
}

export function interact() {
  const t = G.target;
  if (!t) return;
  if (t.kind === 'exit') exitCar();
  else if (t.kind === 'car') enterCar(t.c);
  else if (t.kind === 'friend') openMenu(friendMenu(t.f));
  else if (t.kind === 'place') openPlace(t.place);
  else if (t.kind === 'knock') { toast(`🚪 ${pick(KNOCK_LINES)}`); sfx.door(); }
}

export function openInventory() {
  openMenu(() => {
    const keys = Object.keys(G.inv).filter(k => G.inv[k] > 0);
    const items = keys.map(k => {
      const it = ITEMS[k];
      if (it.type === 'food') return { icon: it.icon, label: `${it.name} ×${G.inv[k]}`, desc: `Eat · +${it.energy} energy`, action: () => eat(k) };
      if (isWearable(k)) return { icon: it.icon, label: it.name, desc: it.desc, right: wearing(k) ? 'Wearing' : 'Off', action: () => wear(k, !wearing(k)) };
      return { icon: it.icon, label: `${it.name} ×${G.inv[k]}`, desc: 'Give it to a friend', disabled: true, action() {} };
    });
    const friends = FRIENDS.map(f => {
      const s = G.fs[f.id];
      return { icon: '🙂', label: f.name, desc: `${levelName(s.lvl)} · ${s.lvl}/100`, disabled: true, action() {} };
    });
    return {
      icon: '🎒', title: 'Bag', sub: `${money(G.money)} · 👥 ${compact(G.followers || 0)} · ⚡ ${Math.round(G.energy)} · 🫙 ${jarsFound()}/${jarSpots.length} jars`,
      sections: [
        { label: 'Items', items: items.length ? items : [{ icon: '🫥', label: 'Empty', desc: 'Shop at K-Mart', disabled: true, action() {} }] },
        { label: 'Friends', items: friends },
      ],
    };
  });
}

// ---------- jobs ----------

function startJob() {
  const from = places.kimchi.door;
  const cands = buildings.filter(b => !b.place && Math.hypot(b.door.x - from.x, b.door.y - from.y) > 900);
  const b = pick(cands);
  const d = Math.hypot(b.door.x - from.x, b.door.y - from.y);
  const time = Math.round(d / 150 + 25);
  G.job = { b, t: time, total: time, reward: Math.round((15 + d / 70) * 60) };
  closeMenu();
  toast(`🛵 Deliver to the 📍 marker in ${time}s! Grab a car to go faster.`, 4500);
}

export function updateJob(dt) {
  if (!G.job) return;
  const j = G.job, p = G.player;
  j.t -= dt;
  if (Math.hypot(j.b.door.x - p.x, j.b.door.y - p.y) < 90) {
    const tip = Math.round(j.t * 45);
    const boost = G.friends.some(f => f.following) ? 1.25 : 1;
    const total = Math.round((j.reward + tip) * boost);
    G.money += total;
    G.stats.deliveries++;
    sfx.yay();
    toast(`✅ Delivered! ${money(j.reward)} + ${money(tip)} tip${boost > 1 ? ' + friend bonus' : ''} = ${money(total)}`, 4500);
    G.job = null;
  } else if (j.t <= 0) {
    sfx.fail();
    toast('⏰ Too slow! The customer cancelled. Try again at Kimchi House.', 4500);
    G.job = null;
  }
}

// Jars found on this map. Counting the map's own jars (not G.jars.size) keeps the total right even if
// the save holds an id this map has no jar for.
export const jarsFound = () => jarSpots.filter(j => G.jars.has(j.id)).length;

export function updateJars() {
  const p = G.player;
  for (const j of jarSpots) {
    if (G.jars.has(j.id)) continue;
    if (Math.abs(j.x - p.x) < 40 && Math.abs(j.y - (p.y - 10)) < 44) {
      G.jars.add(j.id);
      G.money += 1000;
      sfx.coin();
      const found = jarsFound(), all = jarSpots.length;
      if (found === all) { G.money += 25000; sfx.yay(); toast(`🏆 ALL ${all} golden kimchi jars found! +$25,000 bonus!`, 6000); }
      else toast(`🫙 Kimchi jar found! +$1,000 (${found}/${all})`);
    }
  }
}

export function onNewDay() {
  for (const id in G.fs) { G.fs[id].talked = 0; G.fs[id].request = newRequest(); G.fs[id].requestDone = false; }
}

// ---------- HUD ----------

const cache = {};
const setText = (id, v) => { if (cache[id] !== v) { cache[id] = v; $(id).textContent = v; } };

export function updateHUD() {
  setText('money', money(G.money));
  if ($('followers')) setText('followers', compact(G.followers || 0));
  setText('clock', clockText());
  setText('day', String(G.day));
  setText('clockIcon', nightLevel() > 0.3 ? '🌙' : '☀️');
  $('energyBar').style.width = `${Math.max(0, G.energy)}%`;
  $('energyBar').classList.toggle('low', G.energy < 25);
  $toasts.classList.toggle('held', !!G.holdToasts);
  if (!G.holdToasts && heldToasts.length && performance.now() >= dripAt
    && (!G.activityText || !$toasts.querySelector('.toast:not(.out)'))) {
    showToast(...heldToasts.shift());
    dripAt = performance.now() + DRIP_MS;
  }

  let obj;
  if (G.missionText) obj = `⭐ ${G.missionText}`;
  else if (G.activityText) obj = G.activityText;   // a race board event under way (3D activities.js)
  else if (G.job) {
    const s = Math.max(0, Math.ceil(G.job.t));
    obj = `🛵 Deliver to 📍 · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  } else if (G.energy <= 0) obj = '😵 Out of energy! Eat something or sleep at home';
  else if (G.stats.deliveries === 0 && G.money < 5000) obj = '💡 Earn money: missions, posts and deliveries at Kimchi House 🌶️';
  else obj = `🫙 ${jarsFound()}/${jarSpots.length} jars · ${G.friends.filter(f => G.fs[f.def.id].lvl >= 20).length}/4 friends`;
  setText('objective', obj);
  if (PAN_ZOOM && !G.seen.v2welcome) v2Welcome();
  $('objective').classList.toggle('urgent', !G.missionText && !!G.job && G.job.t < 10);
  $('objective').classList.toggle('mission', !!G.missionText);
  $('objective').classList.toggle('event', !G.missionText && !!G.activityText);

  const t = G.target;
  const $p = $('prompt');
  if (t && !G.menu && !G.boardHint) {
    setText('prompt', `${t.kind === 'car' && t.c.locked ? '' : 'E · '}${t.label}${G.photoHint ? '   ·   P · 📸 Post' : ''}`);
    $p.classList.remove('hidden');
  } else if (G.boardHint && !G.menu) {
    setText('prompt', 'E · 🏁 Kimchi Fest race board');
    $p.classList.remove('hidden');
  } else if (G.photoHint && !G.menu) {
    setText('prompt', `P · 📸 Post a pic at ${G.photoHint}`);
    $p.classList.remove('hidden');
  } else $p.classList.add('hidden');
}

// The first time a save plays on Kimchi Key v2, once (spec §6.6): G.seen.v2welcome goes out with the next
// save, so a game that started on the grid sees it on its first v2 session and never again. It waits a few
// seconds so it lands after the welcome-back toasts.
function v2Welcome() {
  G.seen.v2welcome = true;
  setTimeout(() => toast('🗺️ Welcome to Kimchi Key! The city grew into a whole county. Press M for the map: drag to move around, scroll or pinch to zoom.', 8000), 3500);
}

// Draws the world's map picture (world.mapImage: a canvas with k canvas px per sim px, its corner at sim
// x0,y0) so the whole world fits an S x S square, and returns that square's scale in px per sim px.
// BOUNDS starts at (0,0) in both worlds. On the grid the picture is exactly the world, so this is the
// old drawImage(0, 0, S, S) with scale S/(N*T); a world that is not square gets sea around its picture.
function drawMapPicture(x, S) {
  if (!mapImg) mapImg = mapImage();
  const { canvas, k } = mapImg;
  const span = Math.max(BOUNDS.x1 - BOUNDS.x0, BOUNDS.y1 - BOUNDS.y0);
  const dx = S * mapImg.x0 / span, dy = S * mapImg.y0 / span;
  const dw = S * (canvas.width / k) / span, dh = S * (canvas.height / k) / span;
  if (dx > 0 || dy > 0 || dx + dw < S || dy + dh < S) { x.fillStyle = '#2b6f8a'; x.fillRect(0, 0, S, S); }
  x.drawImage(canvas, dx, dy, dw, dh);
  return S / span;
}

export function drawMinimap() {
  const c = $('minimap'), x = c.getContext('2d');
  const S = c.width;
  x.clearRect(0, 0, S, S);
  x.imageSmoothingEnabled = false;
  drawMarkers(x, drawMapPicture(x, S), 1);
}

function drawMarkers(x, k, big) {
  const dot = (px, py, r, col, ring = '#fff') => {
    x.fillStyle = ring; x.beginPath(); x.arc(px * k, py * k, r + 1.5, 0, Math.PI * 2); x.fill();
    x.fillStyle = col; x.beginPath(); x.arc(px * k, py * k, r, 0, Math.PI * 2); x.fill();
  };
  for (const pl of Object.values(places)) {
    dot(pl.door.x, pl.door.y, 3.5 * big, pl.color);
    if (big > 1) {
      x.font = `800 ${Math.round(6 * big)}px ui-rounded, system-ui, sans-serif`;
      x.textAlign = 'center'; x.fillStyle = '#1b1512';
      x.fillText(`${pl.icon} ${pl.name}`, pl.door.x * k, pl.door.y * k - 6 * big);
    }
  }
  if (big > 1) for (const j of jarSpots) if (!G.jars.has(j.id) && G.seen['jar' + j.id]) dot(j.x, j.y, 2 * big, '#d6402b');
  for (const f of G.friends) if (!f.inCar) dot(f.x, f.y, 2.4 * big, f.def.look.shirt);
  if (G.ownedCar) dot(G.ownedCar.x, G.ownedCar.y, 2.4 * big, '#f2c230', '#1b1512');
  if (G.job) {
    const pulse = 3 + Math.sin(G.t * 6) * 1.2;
    dot(G.job.b.door.x, G.job.b.door.y, pulse * big, '#d6402b');
  }
  const p = G.player;
  // the 3D hero turns freely and keeps p.heading; the 2D one only faces left or right
  const a = p.car ? p.car.a : (p.heading ?? (p.face < 0 ? Math.PI : 0));
  x.save();
  x.translate(p.x * k, p.y * k);
  x.rotate(a);
  x.fillStyle = '#fff'; x.strokeStyle = '#1b1512'; x.lineWidth = 1.5;
  const s = 5 * big;
  x.beginPath(); x.moveTo(s, 0); x.lineTo(-s * 0.7, s * 0.7); x.lineTo(-s * 0.3, 0); x.lineTo(-s * 0.7, -s * 0.7); x.closePath();
  x.fill(); x.stroke();
  x.restore();
}

export function toggleBigMap(force) {
  G.bigMap = force ?? !G.bigMap;
  $('bigmap').classList.toggle('hidden', !G.bigMap);
  if (G.bigMap && PAN_ZOOM) openCountyMap();
  if (G.bigMap) drawBigMap();
}
export function drawBigMap() {
  if (PAN_ZOOM) { drawCountyMap(); return; }
  const c = $('bigmapCanvas');
  const S = Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.86);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = c.height = S * dpr;
  c.style.width = c.style.height = S + 'px';
  const x = c.getContext('2d');
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.imageSmoothingEnabled = false;
  drawMarkers(x, drawMapPicture(x, S), Math.max(1.6, S / 360));
}

// ---------- the map picture at any size (the county map here, the round minimap in src/3d/hud3d.js) ----------

// The map picture, or a smaller copy of it, for drawing at dens canvas px per metre: { canvas, k, x0, y0 } as
// world.mapImage() gives it. Each copy is half the one before, and the smallest one still at least as sharp as
// dens is used, so the browser never shrinks a picture by more than 2x: shrinking further skips whole pixels,
// and thin roads flicker as the map slides and turns. A copy is made the first time it is needed (for the
// county 1024x896 and 512x448, about 5 MB beside the 2048x1792 picture).
const MIPS = 3;
const mips = [];
export function mapPicture(dens = Infinity) {
  if (!mapImg) mapImg = mapImage();
  if (mips[0] !== mapImg) { mips.length = 0; mips.push(mapImg); }
  const own = mapImg.k * PX_PER_M;   // the picture's own px per metre
  let i = 0;
  while (i < MIPS - 1 && own / 2 ** (i + 1) >= dens) i++;
  return mip(i);
}
function mip(i) {
  if (mips[i]) return mips[i];
  const up = mip(i - 1), src = up.canvas, c = document.createElement('canvas');
  c.width = Math.ceil(src.width / 2); c.height = Math.ceil(src.height / 2);
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, c.width, c.height);
  return (mips[i] = { canvas: c, k: up.k * c.width / src.width, x0: up.x0, y0: up.y0 });
}

// What the 3D HUD knows that the county map shows too; src/3d/hud3d.js fills it every frame, and the 2D game
// leaves it empty. givers: story mission givers [{ x, y, letter, title }]; photos: the photo spots worth a
// picture now; gps: the route to the delivery or mission target ({ pts, n, i, color }, see hud3d) or null;
// search: the area the police are combing ({ x, y, r } px) or null.
export const mapPins = { givers: [], photos: [], gps: null, search: null };

// Hooks for the 3D game's open-world layer (S8: discovered hubs, fast travel), like placeMenus above:
//   click(x, y, scale)  a click or tap on the county map at sim px (x, y), with the map's scale (css px per sim
//                px) for how near a marker it must be; return true to close the map
//   pins()       extra markers [{ x, y, color, r?, ring?, label? }] (r in css px) drawn over the map
//   legend       extra legend rows [{ color, label }]
export const bigMapHooks = { click: null, pins: null, legend: null };
// ms the last county-map redraw took on the main thread, the worst so far, and how many there were (≤ 2 ms)
export const bigMapStats = { ms: 0, worst: 0, draws: 0 };

// ---------- the county map (Kimchi Key v2) ----------
// The grid keeps its fixed, square big map above, call for call. On v2 the big map fills the window and is a
// view of the map picture: drag it (or the arrow keys, WASD) to move it; the wheel, a pinch, +/- or the
// buttons zoom it from 0.5x to 4x the size that shows the whole county. Over the picture it draws, at a fixed
// size on screen, the places, story givers, photo spots, spotted jars, the GPS route, the police search, the
// region names when the picture has none of its own, a scale bar and a legend.
const PAN_ZOOM = KIND === 'v2';
const ZOOM_MIN = 0.5, ZOOM_MAX = 4;
const ZOOM_EASE = 0.08;     // s: how fast the view eases to a zoom or pan asked by the wheel, a key or a button
const NAMES_AT = 1.6;       // zoom from which places and givers carry their names
const CLICK_PX = 6;         // css px a press may move and still be a click (more is a drag)
const SEA = '#2b6f8a';
const WW = BOUNDS.x1 - BOUNDS.x0, WH = BOUNDS.y1 - BOUNDS.y0;
// cx, cy: the view's centre (sim px) and z its zoom; tcx, tcy, tz: where it is easing to. anchor: the point a
// zoom keeps under the cursor. ptrs: pointers down on the map; press: the one that may become a click.
const bm = { w: 0, h: 0, dpr: 1, cx: 0, cy: 0, z: 1, tcx: 0, tcy: 0, tz: 1, anchor: null, raf: 0, last: 0,
  ptrs: new Map(), press: null, ready: false, names: null };

const fitScale = () => Math.min(bm.w / WW, bm.h / WH) * 0.94;   // css px per sim px with the whole county in view
const viewScale = () => fitScale() * bm.z;

// The centre that keeps the view on the county at zoom z: along an axis the whole county fits in the view it
// is centred; otherwise the view's centre stays over the county. Limiting the centre, not the view's edge,
// lets a zoom near the coast keep the point under the cursor where it is.
function clampedCentre(cx, cy, z) {
  const s = fitScale() * z;
  const fit = (c, a0, a1, half) => (a1 - a0 <= 2 * half ? (a0 + a1) / 2 : clamp(c, a0, a1));
  return [fit(cx, BOUNDS.x0, BOUNDS.x1, bm.w / 2 / s), fit(cy, BOUNDS.y0, BOUNDS.y1, bm.h / 2 / s)];
}
function clampView() {
  [bm.cx, bm.cy] = clampedCentre(bm.cx, bm.cy, bm.z);
  [bm.tcx, bm.tcy] = clampedCentre(bm.tcx, bm.tcy, bm.tz);
}

function openCountyMap() {
  initCountyMap();
  sizeCountyMap();
  // it opens on Kimchi, at the zoom it was left at, with no fingers left down from a drag it was closed in
  bm.cx = bm.tcx = G.player.x; bm.cy = bm.tcy = G.player.y;
  bm.z = bm.tz; bm.anchor = null;
  bm.ptrs.clear(); bm.press = null;
  clampView();
}

// The canvas fills the overlay (inside its padding, the border and the hint line). It is only resized when the
// window changed: resizing clears and reallocates it, which a pan must not pay for every frame.
function sizeCountyMap() {
  const c = $('bigmapCanvas');
  const w = Math.max(240, Math.floor(window.innerWidth - 56)), h = Math.max(200, Math.floor(window.innerHeight - 92));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (w === bm.w && h === bm.h && dpr === bm.dpr && c.width === Math.round(w * dpr)) return;
  Object.assign(bm, { w, h, dpr });
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  c.style.width = w + 'px'; c.style.height = h + 'px';
  clampView();
}

// ----- moving the view -----

const nextFrame = f => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(f) : setTimeout(() => f(performance.now()), 16));
function redraw() {
  if (bm.raf) return;
  if (!bm.last) bm.last = performance.now();
  bm.raf = nextFrame(step);
}
// One frame of easing toward the target view, then a redraw. Zoom eases in log space, so 1x to 2x takes as
// long as 2x to 4x; while zooming about an anchor, the anchor stays under the cursor.
function step(now) {
  bm.raf = 0;
  if (!G.bigMap) { bm.last = 0; return; }
  const dt = clamp((now - bm.last) / 1000, 0, 1 / 30);
  bm.last = now;
  const a = 1 - Math.exp(-dt / ZOOM_EASE);
  let busy = false;
  const lz = Math.log(bm.z), ltz = Math.log(bm.tz);
  if (Math.abs(ltz - lz) > 0.002) { bm.z = Math.exp(lz + (ltz - lz) * a); busy = true; } else bm.z = bm.tz;
  if (bm.anchor) {
    const s = viewScale(), A = bm.anchor;
    bm.cx = A.x - (A.sx - bm.w / 2) / s; bm.cy = A.y - (A.sy - bm.h / 2) / s;
    if (!busy) bm.anchor = null;
  } else {
    const dx = bm.tcx - bm.cx, dy = bm.tcy - bm.cy;
    if (Math.hypot(dx, dy) * viewScale() > 0.25) { bm.cx += dx * a; bm.cy += dy * a; busy = true; } else { bm.cx = bm.tcx; bm.cy = bm.tcy; }
  }
  clampView();
  drawCountyMap();
  if (busy) redraw(); else bm.last = 0;
}

// zoom by f about a point of the canvas (css px; the middle by default), easing there
function zoomAt(f, sx = bm.w / 2, sy = bm.h / 2) {
  const s = viewScale();
  const A = { x: bm.cx + (sx - bm.w / 2) / s, y: bm.cy + (sy - bm.h / 2) / s, sx, sy };
  bm.tz = clamp(bm.tz * f, ZOOM_MIN, ZOOM_MAX);
  const ts = fitScale() * bm.tz;
  bm.tcx = A.x - (sx - bm.w / 2) / ts; bm.tcy = A.y - (sy - bm.h / 2) / ts;
  bm.anchor = A;
  clampView();
  redraw();
}
// move the view by (dx, dy) css px, easing there (keys and buttons)
function panBy(dx, dy) {
  const s = fitScale() * bm.tz;
  bm.anchor = null;
  bm.tcx += dx / s; bm.tcy += dy / s;
  clampView();
  redraw();
}
// a drag or a pinch: the view follows the fingers at once, with no easing
function dragView(z, P, sx, sy) {
  bm.z = bm.tz = clamp(z, ZOOM_MIN, ZOOM_MAX);
  const s = viewScale();
  bm.cx = bm.tcx = P.x - (sx - bm.w / 2) / s; bm.cy = bm.tcy = P.y - (sy - bm.h / 2) / s;
  bm.anchor = null;
  clampView();
  redraw();
}
function centreOnPlayer() {
  bm.anchor = null;
  bm.tcx = G.player.x; bm.tcy = G.player.y;
  clampView();
  redraw();
}

// ----- input -----

function canvasPoint(e) {
  const c = $('bigmapCanvas'), r = c.getBoundingClientRect();
  return { x: e.clientX - r.left - (c.clientLeft || 0), y: e.clientY - r.top - (c.clientTop || 0) };
}
const simAt = (sx, sy) => { const s = viewScale(); return { x: bm.cx + (sx - bm.w / 2) / s, y: bm.cy + (sy - bm.h / 2) / s }; };
// the middle of the pointers down and their mean distance from it
function spread() {
  let mx = 0, my = 0, d = 0;
  for (const q of bm.ptrs.values()) { mx += q.x; my += q.y; }
  mx /= bm.ptrs.size; my /= bm.ptrs.size;
  for (const q of bm.ptrs.values()) d += Math.hypot(q.x - mx, q.y - my);
  return { x: mx, y: my, d: d / bm.ptrs.size };
}

function onPointerDown(e) {
  const c = $('bigmapCanvas');
  c.setPointerCapture?.(e.pointerId);
  const pt = canvasPoint(e);
  bm.ptrs.set(e.pointerId, pt);
  // a press is a click until it moves CLICK_PX from where it went down; a second finger makes it a pinch
  bm.press = bm.ptrs.size === 1 ? { id: e.pointerId, x: pt.x, y: pt.y, drag: false } : null;
  c.style.cursor = 'grabbing';
  e.preventDefault();
}
function onPointerMove(e) {
  const q = bm.ptrs.get(e.pointerId);
  if (!q) return;
  const now = canvasPoint(e), pr = bm.press;
  if (pr && !pr.drag) {
    if (Math.hypot(now.x - pr.x, now.y - pr.y) < CLICK_PX) return;
    pr.drag = true;   // q is still where it went down, so the view catches up with the whole move
  }
  const before = spread(), P = simAt(before.x, before.y);
  q.x = now.x; q.y = now.y;
  const after = spread();
  const z = bm.ptrs.size > 1 && before.d > 4 ? bm.z * after.d / before.d : bm.z;
  dragView(z, P, after.x, after.y);
}
function onPointerUp(e) {
  if (!bm.ptrs.delete(e.pointerId)) return;
  const pr = bm.press;
  if (!bm.ptrs.size) $('bigmapCanvas').style.cursor = 'grab';
  if (!pr || pr.id !== e.pointerId || pr.drag || e.type === 'pointercancel') return;
  bm.press = null;
  const pt = canvasPoint(e), at = simAt(pt.x, pt.y);
  if (bigMapHooks.click?.(at.x, at.y, viewScale())) toggleBigMap(false);
  else redraw();
}
function onWheel(e) {
  e.preventDefault();
  const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;   // lines and pages to px
  const pt = canvasPoint(e);
  zoomAt(Math.exp(-clamp(e.deltaY * px, -400, 400) * 0.0018), pt.x, pt.y);
}
function onKey(e) {
  if (!G.bigMap || G.menu) return;
  const k = e.code, step = Math.min(bm.w, bm.h) * 0.18;
  if (k === 'Equal' || k === 'NumpadAdd') zoomAt(1.5);
  else if (k === 'Minus' || k === 'NumpadSubtract') zoomAt(1 / 1.5);
  else if (k === 'ArrowLeft' || k === 'KeyA') panBy(-step, 0);
  else if (k === 'ArrowRight' || k === 'KeyD') panBy(step, 0);
  else if (k === 'ArrowUp' || k === 'KeyW') panBy(0, -step);
  else if (k === 'ArrowDown' || k === 'KeyS') panBy(0, step);
  else if (k === 'KeyC' || k === 'Home') centreOnPlayer();
  else return;
  e.preventDefault();
}

// The map's own buttons (zoom, back to Kimchi, close): touch screens have no wheel, keys or M.
function countyButtons() {
  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;top:26px;right:26px;display:flex;flex-direction:column;gap:8px;pointer-events:auto';
  const BUTTONS = [['✕', 'Close the map', () => toggleBigMap(false)], ['+', 'Zoom in', () => zoomAt(1.5)],
    ['−', 'Zoom out', () => zoomAt(1 / 1.5)], ['⌖', 'Back to Kimchi', centreOnPlayer]];
  for (const [text, title, fn] of BUTTONS) {
    const b = document.createElement('button');
    b.textContent = text; b.title = title;
    b.style.cssText = 'width:42px;height:42px;border-radius:50%;border:2px solid rgba(212,175,55,.55);background:rgba(15,15,17,.88);'
      + 'color:#fff;font:900 20px/1 ui-rounded,system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.4)';
    b.addEventListener('click', e => { e.stopPropagation(); sfx.click(); fn(); });
    box.appendChild(b);
  }
  return box;
}

function initCountyMap() {
  if (bm.ready) return;
  bm.ready = true;
  const c = $('bigmapCanvas'), root = $('bigmap');
  c.style.touchAction = 'none'; c.style.cursor = 'grab'; c.style.imageRendering = 'auto';
  c.addEventListener('pointerdown', onPointerDown);
  c.addEventListener('pointermove', onPointerMove);
  c.addEventListener('pointerup', onPointerUp);
  c.addEventListener('pointercancel', onPointerUp);
  c.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey);
  // a tap on the dark backdrop closes the map, like the menus
  root.addEventListener('pointerdown', e => { if (e.target === root) toggleBigMap(false); });
  root.appendChild(countyButtons());
  const hint = root.querySelector('.hint');
  if (hint) hint.textContent = 'Drag to move · scroll, pinch or +/− to zoom · C back to Kimchi · M or Esc to close';
  // region names: the picture's own when it has them (mapimage paints them in); otherwise drawn here
  if (!mapImg) mapImg = mapImage();
  bm.names = mapImg.labels === false ? regionAnchors() : null;
}

// Where each region's name goes: the middle of its land (the mean of 16 m samples that regionAt puts in it).
function regionAnchors() {
  const step = 16 * PX_PER_M, sum = new Map();
  for (let y = BOUNDS.y0 + step / 2; y < BOUNDS.y1; y += step) {
    for (let x = BOUNDS.x0 + step / 2; x < BOUNDS.x1; x += step) {
      const id = regionAt(x, y);
      if (id === 'sea') continue;
      const s = sum.get(id) || [0, 0, 0];
      s[0] += x; s[1] += y; s[2]++;
      sum.set(id, s);
    }
  }
  return regions.filter(r => sum.has(r.id)).map(r => { const [sx, sy, n] = sum.get(r.id); return { name: r.name, x: sx / n, y: sy / n }; });
}

// ----- drawing -----

function drawCountyMap() {
  const t0 = performance.now();
  sizeCountyMap();
  const x = $('bigmapCanvas').getContext('2d');
  const { w, h, dpr } = bm, s = viewScale();
  // sim px to canvas css px
  const X = px => (px - bm.cx) * s + w / 2, Y = py => (py - bm.cy) * s + h / 2;
  const u = clamp(Math.min(w, h) / 700, 0.85, 1.35);   // marker size: a little larger on big screens
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sea = pictureSea();
  x.fillStyle = `rgb(${sea})`; x.fillRect(0, 0, w, h);
  drawPictureInView(x, s, X, Y);
  featherPicture(x, X, Y, sea);
  x.lineJoin = 'round'; x.lineCap = 'round';
  if (bm.names) drawRegionNames(x, X, Y, u);
  drawSearch(x, X, Y, s, mapPins.search);
  drawRoute(x, X, Y, u, mapPins.gps);
  drawCountyMarkers(x, X, Y, u);
  drawScaleBar(x, s, u);
  drawLegend(x, u);
  const ms = performance.now() - t0;
  bigMapStats.ms = ms; bigMapStats.worst = Math.max(bigMapStats.worst, ms); bigMapStats.draws++;
}

// Only the part of the picture in view is drawn, from the copy that suits the zoom (see mapPicture).
function drawPictureInView(x, s, X, Y) {
  const pic = mapPicture(s * PX_PER_M * bm.dpr), k = pic.k, cw = pic.canvas.width, ch = pic.canvas.height;
  const vx0 = bm.cx - bm.w / 2 / s, vy0 = bm.cy - bm.h / 2 / s;
  const sx0 = Math.max(0, Math.floor((vx0 - pic.x0) * k)), sy0 = Math.max(0, Math.floor((vy0 - pic.y0) * k));
  const sx1 = Math.min(cw, Math.ceil((vx0 + bm.w / s - pic.x0) * k)), sy1 = Math.min(ch, Math.ceil((vy0 + bm.h / s - pic.y0) * k));
  if (sx1 <= sx0 || sy1 <= sy0) return;
  x.imageSmoothingEnabled = true;
  x.drawImage(pic.canvas, sx0, sy0, sx1 - sx0, sy1 - sy0,
    X(pic.x0 + sx0 / k), Y(pic.y0 + sy0 / k), (sx1 - sx0) / k * s, (sy1 - sy0) / k * s);
}

// The picture's own sea along its border (the mean colour of its edge pixels, 'r,g,b'), so the backdrop past the
// picture carries on its sea rather than framing it as a tile; SEA until the picture can be read.
let edgeSea = null;
function pictureSea() {
  if (edgeSea) return edgeSea;
  edgeSea = SEA.match(/\w\w/g).map(h => parseInt(h, 16)).join(',');
  try {
    const cv = mip(MIPS - 1).canvas, w = cv.width, h = cv.height, x = cv.getContext('2d');
    const sum = [0, 0, 0];
    let n = 0;
    for (const [sx, sy, sw, sh] of [[0, 0, w, 2], [0, h - 2, w, 2], [0, 0, 2, h], [w - 2, 0, 2, h]]) {
      const d = x.getImageData(sx, sy, sw, sh).data;
      for (let i = 0; i < d.length; i += 4) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; n++; }
    }
    if (n) edgeSea = sum.map(v => Math.round(v / n)).join(',');
  } catch { /* a picture that can't be read keeps SEA */ }
  return edgeSea;
}

// The picture's edges fade into the backdrop over FEATHER of its shorter side: narrow, as the west coast's
// beach comes within about 2.5% of the picture's edge.
const FEATHER = 0.015;
function featherPicture(x, X, Y, sea) {
  const p = mapImg, x0 = X(p.x0), y0 = Y(p.y0), x1 = X(p.x0 + p.canvas.width / p.k), y1 = Y(p.y0 + p.canvas.height / p.k);
  const f = FEATHER * Math.min(x1 - x0, y1 - y0);
  const side = (ax, ay, bx, by, rx, ry, rw, rh) => {
    const g = x.createLinearGradient(ax, ay, bx, by);
    g.addColorStop(0, `rgba(${sea},1)`); g.addColorStop(1, `rgba(${sea},0)`);
    x.fillStyle = g; x.fillRect(rx, ry, rw, rh);
  };
  side(x0, 0, x0 + f, 0, x0, y0, f, y1 - y0);
  side(x1, 0, x1 - f, 0, x1 - f, y0, f, y1 - y0);
  side(0, y0, 0, y0 + f, x0, y0, x1 - x0, f);
  side(0, y1, 0, y1 - f, x0, y1 - f, x1 - x0, f);
}

// white text on a dark outline, centred on (sx, sy)
function mapText(x, text, sx, sy, size, weight = 800, fill = '#fff') {
  x.font = `${weight} ${size.toFixed(1)}px ui-rounded, system-ui, sans-serif`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.lineWidth = Math.max(2.5, size * 0.28); x.strokeStyle = 'rgba(20,24,30,.8)';
  x.strokeText(text, sx, sy);
  x.fillStyle = fill; x.fillText(text, sx, sy);
}

function drawRegionNames(x, X, Y, u) {
  const size = 13 * u * clamp(Math.sqrt(bm.z), 1, 1.4);
  for (const r of bm.names) mapText(x, r.name.toUpperCase(), X(r.x), Y(r.y), size, 900, 'rgba(255,255,255,.92)');
}

function drawSearch(x, X, Y, s, q) {
  if (!q) return;
  x.beginPath(); x.arc(X(q.x), Y(q.y), q.r * s, 0, Math.PI * 2);
  x.fillStyle = 'rgba(226,59,43,.16)'; x.fill();
  x.setLineDash([7, 5]); x.lineWidth = 2; x.strokeStyle = 'rgba(226,59,43,.85)'; x.stroke(); x.setLineDash([]);
}

// The GPS route from Kimchi on (gps.i is the route point he has reached), on a dark casing so it reads on any road.
function drawRoute(x, X, Y, u, g) {
  if (!g || !g.pts || g.n < 2) return;
  const p = G.player;
  x.beginPath(); x.moveTo(X(p.x), Y(p.y));
  for (let i = g.i + 1; i < g.n; i++) x.lineTo(X(g.pts[2 * i]), Y(g.pts[2 * i + 1]));
  x.strokeStyle = 'rgba(27,21,18,.75)'; x.lineWidth = 7.5 * u; x.stroke();
  x.strokeStyle = g.color; x.lineWidth = 4.2 * u; x.stroke();
}

function disc(x, sx, sy, r, col, ring = '#fff', alpha = 1) {
  x.globalAlpha = alpha;
  x.fillStyle = ring; x.beginPath(); x.arc(sx, sy, r + 1.6, 0, Math.PI * 2); x.fill();
  x.fillStyle = col; x.beginPath(); x.arc(sx, sy, r, 0, Math.PI * 2); x.fill();
  x.globalAlpha = 1;
}
// a story mission giver: a yellow disc with the caller's initial
function giverDisc(x, sx, sy, r, letter) {
  disc(x, sx, sy, r, '#f2c230', '#1b1512');
  x.fillStyle = '#1b1512'; x.font = `900 ${(r * 1.2).toFixed(1)}px ui-rounded, system-ui, sans-serif`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(letter, sx, sy + 0.5);
}
function playerArrow(x, sx, sy, a, size) {
  x.save();
  x.translate(sx, sy); x.rotate(a);
  x.fillStyle = '#fff'; x.strokeStyle = '#1b1512'; x.lineWidth = 1.8;
  x.beginPath(); x.moveTo(size, 0); x.lineTo(-size * 0.7, size * 0.7); x.lineTo(-size * 0.3, 0); x.lineTo(-size * 0.7, -size * 0.7); x.closePath();
  x.fill(); x.stroke();
  x.restore();
}

function drawCountyMarkers(x, X, Y, u) {
  const names = bm.z >= NAMES_AT;
  for (const pl of Object.values(places)) {
    disc(x, X(pl.door.x), Y(pl.door.y), 5.2 * u, pl.color);
    if (names) mapText(x, `${pl.icon} ${pl.name}`, X(pl.door.x), Y(pl.door.y) - 15 * u, 11.5 * u);
  }
  // photo spots: bright while a picture there pays, faint once posted
  const ready = new Set(mapPins.photos);
  for (const sp of photoSpots) disc(x, X(sp.x), Y(sp.y), 4.2 * u, '#ff5fa2', '#fff', ready.has(sp) ? 1 : 0.4);
  // jars Kimchi has walked past but not picked up
  for (const j of jarSpots) if (!G.jars.has(j.id) && G.seen['jar' + j.id]) disc(x, X(j.x), Y(j.y), 3.6 * u, '#d6402b');
  for (const q of bigMapHooks.pins?.() || []) {
    disc(x, X(q.x), Y(q.y), (q.r || 5) * u, q.color, q.ring || '#fff');
    if (q.label && names) mapText(x, q.label, X(q.x), Y(q.y) - 14 * u, 11 * u);
  }
  for (const f of G.friends) if (!f.inCar) disc(x, X(f.x), Y(f.y), 3.8 * u, f.def.look.shirt);
  if (G.ownedCar && G.player.car !== G.ownedCar) disc(x, X(G.ownedCar.x), Y(G.ownedCar.y), 4 * u, '#f2c230', '#1b1512');
  if (G.job) disc(x, X(G.job.b.door.x), Y(G.job.b.door.y), (5.5 + Math.sin(G.t * 6)) * u, '#ff5a3a');
  for (const m of G.missionBeacons || []) {
    if (m.faint) continue;
    disc(x, X(m.x), Y(m.y), (m.small ? 3.6 : 6) * u, m.color.slice(0, 7), m.small ? '#1b1512' : '#fff');
  }
  for (const gv of mapPins.givers) {
    giverDisc(x, X(gv.x), Y(gv.y), 8.5 * u, gv.letter);
    if (names && gv.title) mapText(x, `⭐ ${gv.title}`, X(gv.x), Y(gv.y) - 19 * u, 11.5 * u);
  }
  const p = G.player;
  playerArrow(x, X(p.x), Y(p.y), p.car ? p.car.a : (p.heading ?? (p.face < 0 ? Math.PI : 0)), 9 * u);
}

// A scale bar in the bottom right: a round number of metres about 70-150 css px long.
function drawScaleBar(x, s, u) {
  const pxPerM = s * PX_PER_M;
  let m = 10;
  for (const n of [10, 20, 50, 100, 200, 500, 1000]) if (n * pxPerM <= 150 * u) m = n;
  const len = m * pxPerM, ex = bm.w - 18, ey = bm.h - 18, sx = ex - len;
  x.lineWidth = 6; x.strokeStyle = 'rgba(20,24,30,.75)';
  x.beginPath(); x.moveTo(sx, ey); x.lineTo(ex, ey); x.stroke();
  x.lineWidth = 3; x.strokeStyle = '#fff';
  x.beginPath(); x.moveTo(sx, ey); x.lineTo(ex, ey); x.stroke();
  mapText(x, m >= 1000 ? `${m / 1000} km` : `${m} m`, sx + len / 2, ey - 12 * u, 11 * u);
}

const LEGEND = [
  ['arrow', '#fff', 'You'],
  ['giver', '#f2c230', 'Story mission'],
  ['dot', '#ff5a3a', 'Delivery / target'],
  ['line', '#ff5a3a', 'GPS route'],
  ['dot', '#9aa7b4', 'Places'],
  ['dot', '#ff5fa2', 'Photo spot'],
  ['dot', '#d6402b', 'Kimchi jar (spotted)'],
  ['ring', '#e23b2b', 'Police search'],
];
// The legend in the bottom left; small screens skip it (the map is the point there).
function drawLegend(x, u) {
  if (bm.w < 520 || bm.h < 380) return;
  const rows = [...LEGEND, ...(bigMapHooks.legend || []).map(r => ['dot', r.color, r.label])];
  const rh = 18 * u, pad = 10 * u, W = 176 * u, H = rows.length * rh + pad * 2, x0 = 14, y0 = bm.h - 14 - H;
  x.fillStyle = 'rgba(15,15,17,.8)'; x.strokeStyle = 'rgba(212,175,55,.4)'; x.lineWidth = 1;
  x.beginPath(); x.roundRect ? x.roundRect(x0, y0, W, H, 10) : x.rect(x0, y0, W, H); x.fill(); x.stroke();
  x.font = `700 ${(11.5 * u).toFixed(1)}px ui-rounded, system-ui, sans-serif`;
  x.textBaseline = 'middle';
  rows.forEach(([kind, col, label], i) => {
    const cx = x0 + pad + 8 * u, cy = y0 + pad + (i + 0.5) * rh;
    if (kind === 'arrow') playerArrow(x, cx, cy, -Math.PI / 2, 7 * u);
    else if (kind === 'giver') giverDisc(x, cx, cy, 6.5 * u, 'A');
    else if (kind === 'line') {
      x.lineWidth = 6 * u; x.strokeStyle = 'rgba(27,21,18,.75)'; x.beginPath(); x.moveTo(cx - 8 * u, cy); x.lineTo(cx + 8 * u, cy); x.stroke();
      x.lineWidth = 3.4 * u; x.strokeStyle = col; x.stroke();
    } else if (kind === 'ring') {
      x.beginPath(); x.arc(cx, cy, 6.5 * u, 0, Math.PI * 2); x.fillStyle = 'rgba(226,59,43,.3)'; x.fill();
      x.lineWidth = 1.5; x.strokeStyle = col; x.stroke();
    } else disc(x, cx, cy, 4.2 * u, col);
    x.fillStyle = '#f3ead8'; x.textAlign = 'left';
    x.fillText(label, cx + 14 * u, cy + 0.5);
  });
}
