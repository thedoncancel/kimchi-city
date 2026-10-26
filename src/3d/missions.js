import { G } from '../state.js';
import { KIND, PX_PER_M, BOUNDS, roads, anchors, routes, places, trees, tileAtPx, WALK, PLAZA, LOT } from '../world.js';
import { makeCar, makePed, carHits } from '../entities.js';
import { save } from '../save.js';
import { FRIENDS } from '../data.js';
import { pick, clamp, money } from '../util.js';
import { giveWeapon } from './combat.js';
import { steerTo } from './police.js';
import { roadWaypoint, curvatureAhead, setRoute, followCourse, nodeAhead, nodeNeighbours, deliveryRoute, pathPoint, stationOf } from '../sim/nav.js';

// GTA-style story missions. Each mission is a list of steps; the engine runs them in order and
// fails the mission if Kimchi is wasted or busted.

const COLORS = { Kimchi: '#ffffff', Mochi: '#ff9cc3', Bao: '#7be0a0', Yuna: '#c4a8ff', Dex: '#ffab5c', 'Mrs. Park': '#ff7a5c' };
// Where a step sends Kimchi: a fixed point, a world spot (a function, read when the step starts, since the
// world fills its anchors and routes after this module loads), or a place. On foot he walks up to its door;
// a car arrival stops at its curb, the spot on the street in front of it (on the grid the curb is the door).
const at = (key, car = false) => (typeof key === 'function' ? key() : Array.isArray(key) ? { x: key[0], y: key[1] }
  : car ? places[key].curb : places[key].door);
const anchor = (k) => () => anchors[k];
// The Street Kings course: the grid's lattice race, or the Kimchi Loop lap on the Kimchi Key (whose world
// lists it as bay_loop and street_kings).
const raceRoute = () => routes.street_kings || routes.bay_loop;
const raceStart = () => raceRoute()?.start || anchors.raceStart;

// Distances in px. The spec's (docs/map-v2-spec.md §9) are for the 2 km Kimchi Key; the classic grid is only
// 344 m across, so there the missions keep today's distances. deliver: the band a delivery's drive must fall
// in; boss: how far away the Bandana boss appears, on which roads, and how far his wander goals are; gang:
// how far round their hangout the Red Bandanas stand (spread over the airboat yard on the Key).
const METRE = PX_PER_M;
const V2 = KIND !== 'grid';
const TUNE = V2
  ? { deliver: [500 * METRE, 1500 * METRE], boss: 600 * METRE, bossRoads: ['hwy', 'blvd', 'coast'], wander: 300 * METRE, gang: 9 * METRE }
  : { deliver: [900, 3000], boss: 1600, bossRoads: null, wander: 1500, gang: 90 };
const DELIVER_SPEED = 18 * METRE;    // px/s: a delivery's timer is its drive at 18 m/s, plus 20 s

// The words fit the map: the classic grid keeps its lines, and on the Kimchi Key (spec §5) the friends
// name its places: Seoul Circle, Lincoln Road, the Runway Straight, the Glades, Star Island, the Port,
// Kimchi Fest, Alhambra Circle and South Pointe.
const byMap = (grid, key) => (V2 ? key : grid);
// The friends' chat (ui.js picks from def.lines): on the Key they talk about its places too.
if (V2) for (const f of FRIENDS) if (f.v2Lines && !f.lines.includes(f.v2Lines[0])) f.lines = [...f.lines, ...f.v2Lines];

export const MISSIONS = [
  {
    id: 'first_day', title: 'First Day', giver: 'home', reward: 25000,
    steps: [
      { type: 'talk', lines: byMap([['Mochi', "📱 Kimchi! You're finally awake. Is the Ursa on the drive? Come get me at the park."]],
        [['Mochi', "📱 Kimchi! You're finally awake. Is the Ursa on the drive? Come get me at Seoul Circle. I'm by the fountain."]]) },
      { type: 'incar', text: 'Get in a car. Your Toro Ursa is on the villa drive (walk up and press E).' },
      { type: 'pickup', friend: 'mochi', text: byMap('Pick up Mochi at the park.', 'Pick up Mochi at the fountain on Seoul Circle.') },
      { type: 'talk', lines: [['Mochi', 'Okay this car is RIDICULOUS. The seats are warm?!'], ['Kimchi', 'Heated and cooled.'],
        byMap(['Mochi', "Maison K is dropping the new denim set today. We're going. Now."],
          ['Mochi', "Maison K on Lincoln Road is dropping the new denim set today. Over the causeway. Now."])] },
      { type: 'dropoff', friend: 'mochi', to: 'fashion', text: byMap('Drive Mochi to Maison K on Boutique Row.', 'Drive Mochi to Maison K on Lincoln Road.') },
      { type: 'talk', lines: [['Mochi', 'Shopping complete! You drive like a maniac. I love it.'],
        byMap(['Mochi', 'Oh, and Mrs. Park at Kimchi House says she needs her best driver. That\'s you.'],
          ['Mochi', 'Oh, and Mrs. Park at Kimchi House in K-Town says she needs her best driver. That\'s you.']),
        byMap(['Mochi', 'Tip: post a pic at the photo spots around town. 📸 More followers, more brand deals.'],
          ['Mochi', 'Tip: post a pic at the photo spots around the Key. 📸 Some look even better at sunset, or at night.'])] },
    ],
  },
  {
    id: 'hot_delivery', title: 'Hot Delivery', giver: 'kimchi', after: ['first_day'], reward: 40000,
    steps: [
      { type: 'talk', lines: [byMap(['Mrs. Park', 'Kimchi! A yacht party ordered our kimchi. Three VIP orders, all spicy, all late.'],
        ['Mrs. Park', 'Kimchi! Three VIP orders from all over the Key. All spicy, all late.']), ['Mrs. Park', "They pay triple if it's still steaming. Go go go!"]] },
      { type: 'incar', text: "Get a car, you'll need the speed." },
      { type: 'deliver', count: 3 },
      { type: 'talk', lines: [['Mrs. Park', 'Every order hot and on time! The yacht people want you at the next party.']] },
    ],
  },
  {
    id: 'street_kings', title: 'Street Kings', giver: 'dealer', after: ['hot_delivery'], reward: 120000,
    steps: [
      { type: 'talk', lines: [['Dex', "So you're the guy with the Ursa. Cute. Very family-friendly."],
        byMap(['Dex', "I'm in the Cavallo 812. Race me around the island. Loser pays for omakase."],
          ['Dex', "I'm in the Cavallo 812. One lap of the Kimchi Loop, from the Runway Straight. Loser pays for omakase."])] },
      { type: 'incar', text: 'Get in something fast. Kimchi Motors has a few.' },
      { type: 'goto', to: raceStart, r: 140, car: true, text: byMap('Drive to the start line.', 'Drive to the start line on the Runway Straight.') },
      { type: 'race', route: raceRoute, rival: 'dex' },
      { type: 'talk', lines: [['Dex', '...Okay. Respect. You actually beat me.'], ['Dex', 'Omakase is on me. And you get 20% off at Kimchi Motors. Forever.']] },
    ],
    onPass() { G.fs.dex.lvl = Math.max(G.fs.dex.lvl, 80); },
  },
  {
    id: 'bad_rep', title: 'Bad Rep', giver: 'mart', after: ['street_kings'], reward: 90000,
    steps: [
      { type: 'talk', lines: [['Bao', 'Kimchi, the Red Bandanas keep shaking down K-Mart. Every. Single. Day.'],
        ['Bao', "My uncle says this is for 'pest control'. Don't tell my mom."], ['Kimchi', '...Is that a real pistol?'],
        byMap(['Bao', 'They hang out in the parking lot on the west side. Make them leave.'],
          ['Bao', 'They hang out at the old airboat yard out in the Glades. Make them leave.'])],
        start() { giveWeapon('pistol', 60); G.weapon = 'pistol'; G.notice?.('🔫 Got a pistol! Hold right-click to aim, left-click to shoot, R to reload.'); } },
      { type: 'goto', to: anchor('bandanaYard'), r: 520, text: byMap("Go to the Red Bandanas' hangout.", "Go to the Red Bandanas' hangout: the airboat yard in the Glades.") },
      { type: 'kill', spot: anchor('bandanaYard'), count: 4, text: 'Take out the Red Bandanas' },
      { type: 'wanted', stars: 2, text: "The shots got the cops' attention!" },
      { type: 'lose', hint: 'spray', text: byMap('Lose the cops. (K-Spray repaints cars)', 'Lose the cops. K-Spray at the Port repaints cars.') },
      { type: 'talk', lines: [['Bao', "📱 It's quiet at K-Mart again! Free banana milk for life, bro."]] },
    ],
    onPass() { G.inv.banana = (G.inv.banana || 0) + 5; },
  },
  {
    id: 'paint_job', title: 'Grand Theft Cavallo', giver: 'mart', after: ['bad_rep'], reward: 150000,
    steps: [
      { type: 'talk', lines: [['Bao', 'Bad news. The Bandanas stole a grey Cavallo 812 right off the Kimchi Motors lot.'],
        byMap(['Bao', "It's sitting in the east parking lot. Take it back, get it resprayed at K-Spray, and return it to Dex."],
          ['Bao', "It's stashed in a motor court on Star Island. Take it back, get it resprayed at K-Spray, and return it to Dex at Kimchi Fest."])] },
      { type: 'getcar', spawn: { type: 'cavallo', at: anchor('stolenCarLot'), color: '#8b9097' }, tag: 'cavallo',
        text: byMap('Take the stolen Cavallo 812 back.', 'Take the stolen Cavallo 812 back from Star Island.') },
      { type: 'wanted', stars: 2, text: 'The Bandanas called in a fake report. Cops!' },
      { type: 'spray', tag: 'cavallo', text: byMap('Get the Cavallo resprayed at K-Spray.', 'Get the Cavallo resprayed at K-Spray in the Port.') },
      { type: 'goto', to: 'dealer', tag: 'cavallo', car: true, r: 170, text: byMap('Return the Cavallo to Kimchi Motors.', 'Return the Cavallo to Kimchi Motors at Kimchi Fest.') },
      { type: 'talk', lines: [['Dex', 'You brought it back... in a NEW color. Honestly? It looks better.'], ['Dex', "Keep it. It's yours. Don't tell my boss."]] },
    ],
    onPass() {
      if (!G.owned.includes('cavallo')) G.owned.push('cavallo');
      const c = G.cars.find(x => x.tag === 'cavallo');
      if (c) G.paint.cavallo = c.color;
    },
  },
  {
    id: 'yunas_day', title: "Yuna's Big Day", giver: 'yuna', after: ['hot_delivery'], reward: 60000,
    steps: [
      { type: 'talk', lines: [byMap(['Yuna', 'Kimchi! I have a sunset photo shoot at the marina and my outfit is PERFECT.'],
        ['Yuna', 'Kimchi! I have a sunset photo shoot at the Yacht Club on South Pointe and my outfit is PERFECT.']), ['Yuna', 'Please, please drive super carefully. No bumps!']] },
      { type: 'incar', text: 'Get a car.' },
      { type: 'pickup', friend: 'yuna', text: byMap('Pick up Yuna.', 'Pick up Yuna on Alhambra Circle.') },
      // the Key's drive from the Gables to South Pointe is about 2 km, six times the grid's
      { type: 'dropoff', friend: 'yuna', to: 'marina', maxDamage: byMap(20, 30),
        text: byMap("Drive Yuna to the Yacht Club. Don't damage the car!", "Drive Yuna to the Yacht Club at South Pointe. Don't damage the car!") },
      { type: 'talk', lines: [byMap(['Yuna', "Not a single wrinkle! You're the best driver in Kimchi City. 💜"], ['Yuna', "Not a single wrinkle! You're the best driver on the Key. 💜"]),
        byMap(['Yuna', 'Take a pic at the marina too. The light is unreal right now.'], ['Yuna', 'Take a pic at the marina too. At golden hour the light is unreal.'])] },
    ],
    onPass() { G.fs.yuna.lvl = Math.min(100, G.fs.yuna.lvl + 25); },
  },
  {
    id: 'kimchi_empire', title: 'Kimchi Empire', giver: 'kimchi', after: ['paint_job'], reward: 1000000,
    steps: [
      { type: 'talk', lines: [['Mrs. Park', "Kimchi... the Red Bandanas' boss wants our secret recipe."],
        byMap(['Mrs. Park', 'He cruises around in a black Bolide Chiro like he owns the city.'],
          ['Mrs. Park', 'He cruises the boulevards in a black Bolide Chiro like he owns the Key.']), ['Kimchi', 'Three point two million dollars of car. Leave it to me.']] },
      { type: 'destroy', spawn: { type: 'bolide', color: '#121214' }, tag: 'boss', text: "Wreck the Bandana boss's Bolide Chiro." },
      { type: 'wanted', stars: 3, text: byMap('Every cop in Kimchi City is after you!', 'Every cop on the Key is after you!') },
      { type: 'lose', hint: 'spray', text: byMap('Lose the cops.', 'Lose the cops. K-Spray at the Port repaints cars.') },
      { type: 'goto', to: 'kimchi', r: 140, text: 'Return to Kimchi House.' },
      { type: 'talk', lines: [['Mrs. Park', 'The recipe is safe. Kimchi City is OURS. 🌶️'], ['Mochi', "📱 Kimchi!! You're all over the news! LEGEND!"]] },
    ],
    final: true,
  },
];

// ---------- engine ----------

const M = { active: null, ui: null, spawned: [] };
export const missionState = M;
export function initMissions(ui) { M.ui = ui; }
export function resetMissions() {
  M.active = null;
  M.endPos = null;
  G.missionText = '';
  G.missionBeacons = [];
  G.raceInfo = null;
}

const done = (id) => G.story.done.includes(id);
export function availableMissions() {
  return MISSIONS.filter(m => !done(m.id) && (m.after || []).every(done));
}
// The yellow marker stands on the place's giver spot, which the world picks: open pavement beside
// the door, clear of trees. A place without one gets today's search around its door instead.
const spots = {};
export function giverSpot(m) {
  return places[m.giver]?.giver || spots[m.giver] || (spots[m.giver] = searchGiverSpot(at(m.giver)));
}

// the first open walkway, plaza or lot spot beside the door that no tree covers, else down and to the left
function searchGiverSpot(d) {
  let best = { x: d.x - 70, y: d.y + 70 };
  for (const [ox, oy] of [[-85, 55], [85, 55], [-110, 25], [110, 25], [0, 115], [-75, 115], [75, 115], [-150, 60], [150, 60]]) {
    const x = d.x + ox, y = d.y + oy, t = tileAtPx(x, y);
    if (t !== WALK && t !== PLAZA && t !== LOT) continue;
    if (trees.some(tr => Math.hypot(tr.x - x, tr.y - y) < 50)) continue;
    best = { x, y };
    break;
  }
  return best;
}

export function tryStartAt(px, py) {
  if (M.active || G.player.dead) return null;
  // after a mission ends, step out of the marker before another one can start
  if (M.endPos) {
    if (Math.hypot(px - M.endPos.x, py - M.endPos.y) < 70) return null;
    M.endPos = null;
  }
  for (const m of availableMissions()) {
    const s = giverSpot(m);
    if (Math.hypot(px - s.x, py - s.y) < 46) { startMission(m); return m; }
  }
  return null;
}

export function startMission(m) {
  M.active = { def: m, i: -1, s: null };
  M.ui.big(m.title.toUpperCase(), 'MISSION', '#f2c230', 3);
  next();
}

function next() {
  const a = M.active;
  a.i++;
  if (a.i >= a.def.steps.length) { pass(); return; }
  const step = a.def.steps[a.i];
  a.s = { ...step, t: 0 };
  G.missionText = step.text || '';
  STEPS[step.type].start?.(a.s, a);
  step.start?.();
}

function pass() {
  const m = M.active.def;
  G.money += m.reward;
  G.story.done.push(m.id);
  G.stats.missions = (G.stats.missions || 0) + 1;
  m.onPass?.();
  cleanup();
  M.ui.big(m.final ? 'KIMCHI EMPIRE' : 'MISSION PASSED', m.final ? `THE END... FOR NOW · +${money(m.reward)}` : `+${money(m.reward)}`, '#f2d27a', 4.5);
  M.ui.sound('pass');
  save();
  // let the next mission giver call
  setTimeout(() => {
    for (const n of availableMissions()) {
      if (n.after?.includes(m.id)) M.ui.notice(`📱 New mission: ${n.title} · look for the yellow marker at ${placeName(n.giver)}`);
    }
  }, 5000);
}

export function failMission(reason) {
  if (!M.active) return;
  cleanup();
  M.ui.big('MISSION FAILED', reason, '#e23b2b', 3.5);
  M.ui.sound('fail');
}

function cleanup() {
  G.cars = G.cars.filter(c => !(c.missionOwned && c !== G.player.car));
  for (const c of G.cars) if (c.missionOwned) { c.managed = false; c.missionOwned = false; }
  G.peds = G.peds.filter(p => !p.missionOwned || p.state === 'down');
  for (const f of G.friends) {
    if (f.missionFollow) { f.following = false; f.inCar = false; f.missionFollow = false; f.homeBound = false; f.x = f.spot.x; f.y = f.spot.y; }
  }
  M.active = null;
  M.endPos = { x: G.player.x, y: G.player.y };
  G.missionText = '';
  G.missionBeacons = [];
  G.raceInfo = null;
}

// Where the next mission's marker is, for the phone notice: the Key names the place's part of town.
const WHERE_V2 = { home: 'the villa', park: 'the fountain on Seoul Circle', mart: 'K-Mart in K-Town', kimchi: 'Kimchi House in K-Town',
  yuna: "Yuna's house on Alhambra Circle", dealer: 'Kimchi Motors at Kimchi Fest' };
const placeName = (k) => (V2 && WHERE_V2[k]) || (k === 'park' ? 'the park' : places[k]?.name || k);
const friend = (id) => G.friends.find(f => f.def.id === id);
const pl = () => G.player;
const near = (pt, r) => Math.hypot(pl().x - pt.x, pl().y - pt.y) < r;
const carSpeed = () => (pl().car ? Math.hypot(pl().car.vx, pl().car.vy) : 0);
const beacon = (pts) => { G.missionBeacons = pts; };

export function skipTalk() {
  const s = M.active?.s;
  if (s?.type === 'talk') s.lineT = 0;
}

// every step: start(s), update(s, dt) -> true when done, or a string to fail the mission
const STEPS = {
  talk: {
    start(s) { s.li = -1; s.lineT = 0; beacon([]); },
    update(s, dt) {
      if ((s.lineT -= dt) > 0) return false;
      s.li++;
      if (s.li >= s.lines.length) { M.ui.sub(null); return true; }
      const [who, text] = s.lines[s.li];
      s.lineT = 1.6 + text.length * 0.045;
      M.ui.sub(who, text, COLORS[who] || '#fff', s.lineT);
      return false;
    },
  },
  goto: {
    // A place reached on foot is its door, but a car may stop at its curb (on the Key the curb is out on
    // the street, 10 m from the door, so driving back to Kimchi House would otherwise end short of it).
    start(s) {
      s.pt = at(s.to, s.car);
      s.curb = typeof s.to === 'string' && !s.car ? at(s.to, true) : null;
      beacon([{ ...s.pt, color: '#f2c230' }]);
    },
    update(s) {
      const c = pl().car;
      if (s.tag && (!c || c.tag !== s.tag)) { G.missionText = s.text + ' (get back in it)'; return false; }
      if (s.car && !c) return false;
      return near(s.pt, s.r || 100) || (!!c && !!s.curb && near(s.curb, s.r || 100));
    },
  },
  incar: {
    start() { beacon([]); },
    update() { const c = pl().car; return !!c && !c.wreck; },
  },
  pickup: {
    start(s) { s.f = friend(s.friend); },
    update(s) {
      const f = s.f;
      beacon(f.inCar ? [] : [{ x: f.x, y: f.y, color: '#4fc3ff' }]);
      if (!pl().car) { G.missionText = 'Get a car first, then pick up ' + f.def.name + '.'; return false; }
      G.missionText = s.text;
      if (!f.following && Math.hypot(pl().x - f.x, pl().y - f.y) < 260 && carSpeed() < 90) {
        f.following = true; f.missionFollow = true;
        f.bubble = { text: pick(["Let's go!", 'Nice ride!', 'Finally!']), t: 2 };
      }
      return f.inCar;
    },
  },
  dropoff: {
    start(s) {
      // a drop-off only counts from a car, so it always ends at the curb
      s.f = friend(s.friend); s.pt = at(s.to, true);
      s.hp0 = pl().car ? pl().car.hp : 100;
      beacon([{ ...s.pt, color: '#f2c230' }]);
    },
    update(s) {
      const c = pl().car;
      if (s.maxDamage && c && s.hp0 - c.hp > s.maxDamage) return `${s.f.def.name}'s outfit got ruined!`;
      if (s.maxDamage && c) G.missionText = `${s.text} (car damage ${Math.max(0, Math.round(s.hp0 - c.hp))}/${s.maxDamage})`;
      if (!s.f.inCar) { G.missionText = `Go back for ${s.f.def.name}.`; return false; }
      if (c && near(s.pt, 160) && carSpeed() < 120) {
        s.f.following = false; s.f.inCar = false; s.f.missionFollow = false; s.f.homeBound = true;
        s.f.x = c.x - Math.sin(c.a) * 40; s.f.y = c.y + Math.cos(c.a) * 40;
        return true;
      }
      return false;
    },
  },
  deliver: {
    start(s) { s.n = 0; pickDelivery(s); },
    update(s, dt) {
      s.left -= dt;
      const secs = Math.max(0, Math.ceil(s.left));
      G.missionText = `Deliver order ${s.n + 1}/${s.count} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      if (s.left <= 0) return 'The kimchi went cold.';
      if (near(s.pt, 110)) {
        s.n++;
        M.ui.sound('coin');
        M.ui.notice(`🌶️ Order ${s.n}/${s.count} delivered!`);
        if (s.n >= s.count) return true;
        pickDelivery(s);
      }
      return false;
    },
  },
  race: {
    start(s) {
      // the course: a world route ({ pts, s, len, gates, laps }), its gates once per lap, each gate at its
      // station along the course line
      const R = s.R = typeof s.route === 'function' ? s.route() : routes[s.route];
      s.laps = R.laps || 1; s.gs = [];
      let from = 0;
      for (const g of R.gates) s.gs.push(from = stationOf(R, g.x, g.y, from));
      s.n = R.gates.length * s.laps;
      // Dex lines up beside Kimchi, facing along the course
      const p0 = pl().car || pl(), t = pathPoint(R, stationOf(R, p0.x, p0.y), {});
      let rx = p0.x, ry = p0.y;
      for (const [side, back] of [[1, 0], [-1, 0], [0, 1]]) {
        rx = p0.x - Math.sin(t.a) * 60 * side - Math.cos(t.a) * 100 * back;
        ry = p0.y + Math.cos(t.a) * 60 * side - Math.sin(t.a) * 100 * back;
        if (!carHits({ type: 'cavallo' }, rx, ry, t.a)) break;
      }
      const r = makeCar('cavallo', rx, ry, t.a, '#8b9097');
      Object.assign(r, { managed: true, missionOwned: true, raceRival: true, hp: 200, driverLook: 'dex' });
      G.cars.push(r);
      setRoute(r, R);
      // a gate right on the start line is behind them already
      s.pi = s.ri = s.gs[0] < 5 * METRE ? 1 : 0;
      s.rival = r; s.lap = 0; s.count = 3.5; s.go = false; s.prev = { x: pl().x, y: pl().y };
    },
    update(s, dt) {
      const p = pl();
      if (!s.go) {
        const before = Math.ceil(s.count);
        s.count -= dt;
        if (Math.ceil(s.count) !== before && s.count > 0) M.ui.big(String(Math.ceil(s.count)), '', '#ffffff', 0.8);
        if (s.count <= 0) { s.go = true; M.ui.big('GO!', '', '#7be0a0', 1); M.ui.sound('go'); }
        s.rival.vx = s.rival.vy = 0;
        s.prev = { x: p.x, y: p.y };
        const g0 = gate(s, s.pi);
        beacon([{ x: g0.x, y: g0.y, color: '#f2c230', ring: true }]);
        G.missionText = 'Get ready...';
        return false;
      }
      // the rival drives the course line
      const r = s.rival;
      if (!r.wreck && r.hp > 0 && s.ri < s.n) driveRival(s, dt);
      if (s.ri >= s.n) return 'Dex won the race.';
      // Kimchi passes a gate by driving through it the right way
      if (crossed(gate(s, s.pi), s.prev, p)) { s.pi++; M.ui.sound('coin'); if (s.pi >= s.n) return true; }
      s.prev = { x: p.x, y: p.y };
      const ahead = progress(s, p) > s.lap * s.R.len + (r.nav?.at || 0);
      G.missionText = `Checkpoint ${s.pi + 1}/${s.n} · ${ahead ? '1st' : '2nd'} place`;
      const nx = gate(s, s.pi), nn = s.pi + 1 < s.n ? gate(s, s.pi + 1) : null;
      beacon([{ x: nx.x, y: nx.y, color: '#f2c230', ring: true }, ...(nn ? [{ x: nn.x, y: nn.y, color: '#f2c23066', ring: true, faint: true }] : [])]);
      return false;
    },
  },
  kill: {
    start(s) {
      const { x, y } = at(s.spot);
      s.gang = [];
      for (let i = 0; i < s.count; i++) {
        const a = (i / s.count) * Math.PI * 2;
        const p = makePed(x + Math.cos(a) * TUNE.gang, y + Math.sin(a) * TUNE.gang, {
          role: 'rival', armed: true, hp: 90, missionOwned: true, state: 'alert', heading: a + Math.PI,
          look: { skin: '#d9a07a', hair: '#1b1512', shirt: '#c0262b', pants: '#4a4a4a' },
        });
        G.peds.push(p);
        s.gang.push(p);
      }
    },
    update(s) {
      const left = s.gang.filter(p => p.state !== 'down' && !p.dying);
      G.missionText = `${s.text} (${s.count - left.length}/${s.count})`;
      beacon(left.map(p => ({ x: p.x, y: p.y, color: '#e23b2b', small: true })));
      return left.length === 0;
    },
  },
  getcar: {
    start(s) {
      const p = at(s.spawn.at);
      const c = makeCar(s.spawn.type, p.x, p.y, p.a ?? Math.PI / 2, s.spawn.color);
      Object.assign(c, { tag: s.tag, missionOwned: true, hp: 160 });
      G.cars.push(c);
      s.car = c;
    },
    update(s) {
      if (s.car.wreck) return 'It was destroyed.';
      beacon(pl().car === s.car ? [] : [{ x: s.car.x, y: s.car.y, color: '#4fc3ff' }]);
      return pl().car === s.car;
    },
  },
  wanted: {
    start(s) { G.wanted = Math.max(G.wanted, s.stars); G.evadeT = 0; G.heatT = 12 + s.stars * 4; G.starFlash = 1.5; if (s.text) M.ui.notice('🚨 ' + s.text); },
    update() { return true; },
  },
  lose: {
    start(s) { if (s.hint) beacon([{ ...at(s.hint, true), color: '#a06be0', small: true }]); },
    update() { return G.wanted === 0; },
  },
  spray: {
    start(s) {
      s.n0 = G.sprayed || 0;
      // K-Spray resprays this car even if the cops have already lost it (police.js updateSpray)
      const car = G.cars.find(x => x.tag === s.tag);
      if (car) car.sprayJob = true;
      beacon([{ ...at('spray', true), color: '#a06be0' }]);
    },
    update(s) {
      const c = pl().car;
      const van = G.cars.find(x => x.tag === s.tag);
      if (van?.wreck) return 'It was destroyed.';
      if (!c || c.tag !== s.tag) { G.missionText = 'Get back in the car.'; return false; }
      G.missionText = s.text;
      return (G.sprayed || 0) > s.n0;
    },
  },
  destroy: {
    start(s) {
      const c = bossSpawn(s.spawn);
      if (!c) return;
      Object.assign(c, { tag: s.tag, managed: true, missionOwned: true, hp: 180, driverLook: 'rival' });
      G.cars.push(c);
      s.car = c;
      s.goal = null; s.flee = null; s.still = null;
    },
    update(s, dt) {
      const c = s.car;
      if (!c) return true;
      if (c.wreck) return true;
      beacon([{ x: c.x, y: c.y, color: '#e23b2b' }]);
      if (c.hp > 0) driveBoss(s, c, dt);
      return false;
    },
  },
};

// ---------- the race ----------

// Gate k of the race over all its laps, and its station along the whole race.
const gate = (s, k) => s.R.gates[k % s.R.gates.length];
const gateS = (s, k) => Math.floor(k / s.R.gates.length) * s.R.len + s.gs[k % s.R.gates.length];
// How far along the race Kimchi is: his next gate's station less his distance to it.
const progress = (s, p) => { const g = gate(s, s.pi); return gateS(s, s.pi) - Math.hypot(p.x - g.x, p.y - g.y); };

// Did a move from a to b go through gate g the right way? A gate is a line across the course, w wide plus a
// little slack for a car cutting a corner, facing along the course.
const GATE_SLACK = 4 * METRE;
function crossed(g, a, b) {
  const fx = Math.cos(g.a), fy = Math.sin(g.a);
  const da = (a.x - g.x) * fx + (a.y - g.y) * fy, db = (b.x - g.x) * fx + (b.y - g.y) * fy;
  if (!(da < 0 && db >= 0)) return false;
  const f = da / (da - db), x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f;
  return Math.abs(-(x - g.x) * fy + (y - g.y) * fx) <= g.w / 2 + GATE_SLACK;
}

// Dex drives the course line itself (pure pursuit on the route; back along the streets if he is knocked off
// it), as fast as the bend ahead allows at RIVAL_GRIP, with a rubber band on top speed, acceleration and grip:
// faster while Kimchi leads, slower while Dex does, at full effect 40 m apart. The spec's 1.25 x traffic grip
// (4 m/s^2) made him take 77 s for the grid race that takes him 41 s today; 17.5 m/s^2 (0.9 of the v2 cars'
// 2 g limit, so the band never takes him past it) brings that to about 51 s. The grid keeps today's 520 px/s
// top speed and a 10% band. On the Key his Cavallo would do 54 m/s and lap the Kimchi Loop in 84 s, out of
// reach of the Toro Ursa Kimchi owns when Street Kings opens (44 m/s); held to 42 m/s with a 7.5% band he
// laps in about 105 s level with Kimchi, 111 s when he leads and 98 s when Kimchi does (tools/s7a_race_test).
const RIVAL_GRIP = 17.5;    // m/s^2
const RIVAL_TOP = V2 ? 42 * METRE : 520;
const RIVAL_BAND = V2 ? 0.075 : 0.1;
function driveRival(s, dt) {
  const r = s.rival, nav = r.nav;
  const pt = followCourse(r);
  if (nav.at >= nav.len - 2 * METRE && s.lap + 1 < s.laps) { s.lap++; nav.i = 0; nav.at = 0; }
  const at = s.lap * s.R.len + nav.at;
  // a gate counts once he is back on the course past it (not while a knock has him on another street)
  while (s.ri < s.n && !r.back && at >= gateS(s, s.ri) - 3 * METRE) s.ri++;
  const k = 1 + RIVAL_BAND * clamp((progress(s, pl()) - at) / (40 * METRE), -1, 1);
  r.tune = r.tune || {};
  r.tune.max = r.tune.acc = k;
  steerTo(r, dt, pt[0], pt[1], { corner: 300, cap: RIVAL_TOP * k, curv: curvatureAhead(r, undefined, r.back || r.nav), grip: RIVAL_GRIP * k, dodge: true });
}

// ---------- the Bandana boss ----------

// A lane spot at least 600 m from Kimchi on a highway, boulevard or coast road (1600 px and any street on the
// grid), relaxing those rules when none fits; facing along the lane.
function bossSpawn(spawn) {
  const p = pl(), far = TUNE.boss;
  for (const o of [{ rMin: far, cls: TUNE.bossRoads }, { rMin: far }, { rMin: far / 2 }, {}]) {
    const q = roads.randomLanePoint?.({ x: p.x, y: p.y, ...o });
    if (q) return makeCar(spawn.type, q.x, q.y, q.a, spawn.color);
  }
  return null;
}

// He cruises from junction to random far junction. When Kimchi gets within 700 px he runs at full speed,
// each time for the neighbouring junction furthest from Kimchi, and keeps running until he is 1000 px clear
// (without that gap a chaser hanging about 700 px back flipped him between running and cruising, and his
// way between two ends of the same road, every second). A boss that has got no more than 3 m from where he
// was in 4 s (displacement, not speed: shoving a car or rocking against a wall shows speed) drops his plan
// and picks a new way, so he is never stuck for long.
const reached = (c, n) => Math.hypot(c.x - n.x, c.y - n.y) < 15 * METRE;
const FLEE_IN = 700, FLEE_OUT = 1000;
const BOSS_STILL = 3 * METRE, BOSS_STUCK_T = 4;
function driveBoss(s, c, dt) {
  const p = pl(), d = Math.hypot(p.x - c.x, p.y - c.y), fleeing = d < (s.flee ? FLEE_OUT : FLEE_IN);
  if (fleeing) {
    if (!s.flee || reached(c, s.flee)) s.flee = fleeFrom(c, p);
  } else {
    s.flee = null;
    if (!s.goal || reached(c, s.goal)) s.goal = wanderGoal(c);
  }
  const g = s.flee || s.goal;
  const [ax, ay] = roadWaypoint(c, g.x, g.y);
  steerTo(c, dt, ax, ay, { corner: 300, cap: fleeing ? 560 : 300, curv: curvatureAhead(c), dodge: true });
  if (!s.still || Math.hypot(c.x - s.still.x, c.y - s.still.y) > BOSS_STILL) s.still = { x: c.x, y: c.y, t: 0 };
  else if ((s.still.t += dt) > BOSS_STUCK_T) { s.still = null; s.flee = null; s.goal = wanderGoal(c); c.nav = null; }
}

// The neighbour of the junction ahead that is furthest from Kimchi (a dead end counts half as far). Without
// a road graph: straight away from him, inside the map.
function fleeFrom(c, p) {
  const n0 = nodeAhead(c);
  if (!n0) return { x: clamp(c.x + (c.x - p.x) * 4, BOUNDS.x0, BOUNDS.x1), y: clamp(c.y + (c.y - p.y) * 4, BOUNDS.y0, BOUNDS.y1) };
  let best = n0, bd = -1;
  for (const n of nodeNeighbours(n0.id)) {
    const score = Math.hypot(n.x - p.x, n.y - p.y) * (n.edges.length > 1 ? 1 : 0.5);
    if (score > bd) { bd = score; best = n; }
  }
  return best;
}

// A random junction well away from the car (any junction when none is).
function wanderGoal(c) {
  const far = roads.nodes.filter(n => n.edges.length > 1 && Math.hypot(n.x - c.x, n.y - c.y) > TUNE.wander);
  return pick(far.length ? far : roads.nodes) || { x: c.x, y: c.y };
}

// ---------- friends after a drop-off ----------

// A friend dropped off across town (Mochi at Maison K, Yuna at the Yacht Club) would walk back to her
// hangout in a straight line, at a stroll, and on the Key the bay and the buildings stop her for good. Once
// Kimchi is HOME_GONE away she is back at her hangout instead, ready for the next visit.
const HOME_GONE = V2 ? 120 * METRE : 1500;
function friendsHome() {
  const p = pl();
  for (const f of G.friends) {
    if (!f.homeBound) continue;
    if (f.following) { f.homeBound = false; continue; }
    if (Math.hypot(f.x - p.x, f.y - p.y) < HOME_GONE) continue;
    f.homeBound = false;
    f.x = f.tx = f.spot.x; f.y = f.ty = f.spot.y;
  }
}

// ---------- deliveries ----------

// A delivery door whose drive is 500-1500 m from Kimchi (900-3000 px on the grid); the timer is that drive
// at 18 m/s plus 20 s. The car stops at the door's curb.
function pickDelivery(s) {
  const from = pl();
  const d = deliveryRoute(from.x, from.y, { min: TUNE.deliver[0], max: TUNE.deliver[1] });
  s.pt = d ? d.curb : at('kimchi', true);
  s.len = d ? d.len : 0;
  s.left = (d ? d.len : TUNE.deliver[1]) / DELIVER_SPEED + 20;
  beacon([{ ...s.pt, color: '#f2c230' }]);
}

export function updateMissions(dt) {
  friendsHome();
  const a = M.active;
  if (!a) return;
  if (G.player.dead) { failMission(G.player.dead === 'busted' ? 'You got busted.' : 'You got wasted.'); return; }
  const r = STEPS[a.s.type].update(a.s, dt, a);
  if (typeof r === 'string') failMission(r);
  else if (r) next();
}
