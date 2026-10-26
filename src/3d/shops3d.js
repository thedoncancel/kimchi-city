import { G } from '../state.js';
import { placeMenus, spend, closeMenu, toast } from '../ui.js';
import { sfx } from '../audio.js';
import { money } from '../util.js';
import { save } from '../save.js';
import { WEAPONS, ORDER, ARMOR_PRICE, giveWeapon, selectWeapon } from './combat.js';
import { resetPolice } from './police.js';

// Menus for the places that only exist in the 3D game.

function gunsMenu() {
  const guns = ORDER.filter(w => w !== 'fists').map(w => {
    const W = WEAPONS[w];
    const dmg = W.pellets ? `${W.dmg}×${W.pellets}` : W.dmg;
    if (!G.weapons[w]) {
      return {
        icon: W.icon, label: W.name, desc: `Damage ${dmg} · ${W.mag}-round mag${W.auto ? ' · full auto' : ''} · ${W.ammo.count} rounds included`,
        right: money(W.price), action: () => {
          if (!spend(W.price)) return;
          giveWeapon(w, W.ammo.count);
          selectWeapon(w);
          sfx.yay();
          toast(`${W.icon} Bought the ${W.name}! Right-click to aim, left-click to shoot.`, 4500);
          save();
        },
      };
    }
    const have = (G.clip[w] || 0) + (G.ammo[w] || 0);
    return {
      icon: W.icon, label: `${W.name} ammo`, desc: `+${W.ammo.count} rounds · you have ${have}`, right: money(W.ammo.price),
      action: () => { if (!spend(W.ammo.price)) return; giveWeapon(w, W.ammo.count); sfx.coin(); toast(`${W.icon} +${W.ammo.count} rounds`); },
    };
  });
  const armor = {
    icon: '🦺', label: 'Body armor', desc: G.armor >= 100 ? 'You are fully armored' : 'Soaks up most of the damage you take',
    right: money(ARMOR_PRICE), disabled: G.armor >= 100,
    action: () => { if (!spend(ARMOR_PRICE)) return; G.armor = 100; sfx.coin(); toast('🦺 Armor on. Stay safe out there.'); },
  };
  return { icon: '🔫', title: 'K-Arms', sub: '"No questions asked. Mostly."', sections: [{ label: 'Weapons', items: guns }, { label: 'Protection', items: [armor] }] };
}

function hospitalMenu() {
  const missing = 100 - Math.ceil(G.health);
  const cost = Math.max(500, Math.round(missing * 60));
  return {
    icon: '🏥', title: 'Kimchi City Hospital', sub: `Health ${Math.ceil(G.health)}/100`,
    sections: [{ items: [
      { icon: '🩹', label: 'Private suite treatment', desc: missing > 0 ? 'Back to full health' : "You're perfectly healthy!", right: money(cost), disabled: missing <= 0,
        action: () => { if (!spend(cost)) return; G.health = 100; sfx.yay(); toast('🩹 Good as new!'); } },
      { icon: '🍲', label: 'Cafeteria soup', desc: '+30 energy · +10 health', right: '$6',
        action: () => { if (!spend(6)) return; G.energy = Math.min(100, G.energy + 30); G.health = Math.min(100, G.health + 10); sfx.pop(); toast('🍲 Hospital food is... fine. +30 energy'); } },
    ] }],
  };
}

function policeMenu() {
  const fine = G.wanted * 25000;
  const st = G.stats;
  const items = [];
  if (G.wanted > 0) {
    items.push({ icon: '💸', label: 'Pay your fines', desc: `Clears your ${'★'.repeat(G.wanted)} wanted level`, right: money(fine),
      action: () => { if (!spend(fine)) return; resetPolice(); closeMenu(); sfx.coin(); toast("👮 Fines paid. You're clean... for now.", 4000); } });
  }
  items.push({ icon: '📋', label: 'Your record', desc: `Busted ${st.busted || 0}× · Wasted ${st.wasted || 0}× · Takedowns ${st.takedowns || 0} · Cars borrowed ${st.carjacks || 0}`, disabled: true, action() {} });
  return {
    icon: '🚓', title: 'Police Station', sub: G.wanted ? 'The officer at the desk is staring right at you...' : '"Keep it clean out there, Kimchi."',
    sections: [{ items }],
  };
}

function sprayMenu() {
  return {
    icon: '🎨', title: 'K-Spray', sub: 'Fresh paint, new plates, no questions.',
    sections: [{ items: [
      { icon: '🚗', label: 'Drive a car in here', desc: 'Repairs it, repaints it and makes the cops lose you', right: '$2,500', disabled: true, action() {} },
    ] }],
  };
}

Object.assign(placeMenus, { guns: gunsMenu, hospital: hospitalMenu, police: policeMenu, spray: sprayMenu });
