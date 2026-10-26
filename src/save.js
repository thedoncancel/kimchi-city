import { G, newRequest, newPr } from './state.js';
import { ITEMS } from './data.js';
import { MAP_VERSION } from './world.js';

const KEY = 'kimchi-city-save-v1';

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      money: G.money, energy: G.energy, time: G.time, day: G.day,
      inv: G.inv, owned: G.owned, equipped: G.equipped, jars: [...G.jars],
      stats: G.stats, seen: G.seen, fs: G.fs,
      health: G.health, armor: G.armor, weapons: G.weapons, ammo: G.ammo, clip: G.clip, weapon: G.weapon, story: G.story,
      followers: G.followers, paint: G.paint, posted: G.posted, assets: G.assets, trips: G.trips, lux: true,
      mapVer: MAP_VERSION, pr: G.pr,
    }));
    G.mapVer = MAP_VERSION;   // the save now comes from this map
    return true;
  } catch (e) { return false; }
}

export function hasSave() {
  try { return !!localStorage.getItem(KEY); } catch (e) { return false; }
}

export function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (!d) return false;
    Object.assign(G, {
      money: d.money ?? 50, energy: d.energy ?? 100, time: d.time ?? 540, day: d.day ?? 1,
      inv: d.inv || {}, owned: d.owned || [], equipped: d.equipped || {},
      jars: new Set(d.jars || []), stats: { ...G.stats, ...d.stats }, seen: { v2welcome: false, ...d.seen },
      health: d.health ?? 100, armor: d.armor ?? 0,
      weapons: { fists: true, ...(d.weapons || {}) }, ammo: d.ammo || {}, clip: d.clip || {}, weapon: d.weapon || 'fists',
      story: { done: [], ...(d.story || {}) },
      followers: d.followers ?? 197500, paint: d.paint || {}, posted: d.posted || {}, assets: d.assets || {}, trips: d.trips || 0,
      // saves from before Kimchi Key v2 were all written on the classic grid (map 1)
      mapVer: d.mapVer ?? 1, pr: newPr(d.pr),
    });
    for (const id in d.fs || {}) if (G.fs[id]) Object.assign(G.fs[id], d.fs[id]);
    // saves from before the luxury update: welcome to the villa
    if (!d.lux) {
      G.money += 150000;
      if (!G.owned.includes('ursa')) G.owned.push('ursa');
      if (!d.followers) G.followers = 197500;
      G.luxWelcome = true;
    }
    for (const id in G.fs) if (!ITEMS[G.fs[id].request]?.req) G.fs[id].request = newRequest();
    return true;
  } catch (e) { return false; }
}
