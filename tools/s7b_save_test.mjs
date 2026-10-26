#!/usr/bin/env node
// Stage S7b: a save from before Kimchi Key v2 plays on v2, then in the 2D game, then on v2 again, and keeps
// everything (docs/map-v2-spec.md §6.6).
//   node tools/s7b_save_test.mjs [-v]
// The world is picked when world.js loads, so each session runs in its own node process (this file, with a
// phase argument and S7B_WORLD set), handing the save on in localStorage's place:
//  1. v2: a v1 save loads with money, jars, posted, owned, paint and story intact; the one-time v2 welcome
//     toast shows once (G.seen.v2welcome), and the session records pr entries and a spotted jar, then saves;
//  2. grid (the 2D game's world): it loads, and its autosave (save.js) keeps every field, pr included;
//  3. v2 again: no second welcome, and everything is still there.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KEY = 'kimchi-city-save-v1';
const phase = process.argv.find(a => a.startsWith('--phase='))?.slice(8);

// what the game wrote before the v2 rebuild: no mapVer, no pr, no v2welcome
const V1 = {
  money: 812345, energy: 64, time: 1000, day: 9, inv: { kimbap: 3, bananaMilk: 1 }, owned: ['ursa', 'gwagen', 'phantasma'],
  equipped: { watch: null, fit: null }, jars: [0, 3, 7, 12, 24], stats: { deliveries: 14, carjacks: 2, takedowns: 5, busted: 1, wasted: 0, missions: 3 },
  seen: { drive: true, mouseLock: true, jar5: true }, fs: { dex: { lvl: 85, talked: 1, request: 'kimbap', requestDone: false } },
  health: 88, armor: 20, weapons: { fists: true, pistol: true }, ammo: { pistol: 40 }, clip: { pistol: 12 }, weapon: 'pistol',
  story: { done: ['first_day', 'street_kings', 'bad_rep'] }, followers: 312000, paint: { ursa: '#1b1512', gwagen: '#e9e2d4' },
  posted: { park: 9, neon: 8, skyline: 7 }, assets: { penthouse: true }, trips: 4, lux: true,
};
const KEPT = ['money', 'jars', 'posted', 'owned', 'paint', 'story', 'inv', 'followers', 'weapons', 'assets'];

if (!phase) {
  // ---------- the parent: run the three sessions and compare what they leave behind ----------
  const self = fileURLToPath(import.meta.url);
  const run = (name, world, save) => {
    const r = spawnSync(process.execPath, [self, `--phase=${name}`, ...process.argv.slice(2)], {
      input: JSON.stringify(save), env: { ...process.env, S7B_WORLD: world }, encoding: 'utf8', maxBuffer: 1 << 26,
    });
    const out = r.stdout.split('\n');
    for (const line of out) if (line && !line.startsWith('SAVE:')) console.log(`[${name}] ${line}`);
    if (r.status !== 0) console.log(`[${name}] exit ${r.status}\n${r.stderr}`);
    const line = out.find(l => l.startsWith('SAVE:'));
    return { ok: r.status === 0, save: line ? JSON.parse(line.slice(5)) : null };
  };
  let fails = 0;
  const check = (name, ok, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ': ' + detail}`); };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const a = run('v2', 'v2', V1);
  check('the v2 session passes its checks', a.ok);
  const b = a.save && run('grid', 'grid', a.save);
  check('the 2D session passes its checks', !!b?.ok);
  const c = b?.save && run('v2again', 'v2', b.save);
  check('the second v2 session passes its checks', !!c?.ok);
  for (const [label, s] of [['after v2', a.save], ['after the 2D autosave', b?.save], ['after v2 again', c?.save]]) {
    check(`${label}: ${KEPT.join(', ')} as in the v1 save`, !!s && KEPT.every(k => same(s[k], V1[k])), s ? KEPT.filter(k => !same(s[k], V1[k])).join(' ') : 'no save');
    check(`${label}: the v2 records are kept`, !!s && s.pr?.traps?.lighthouse?.kmh === 201 && s.pr?.found?.fest === true && s.seen?.v2welcome === true && s.seen?.jar9 === true && s.seen?.jar5 === true);
  }
  check('mapVer says where each save was made (2, 1, 2)', a.save?.mapVer === 2 && b?.save?.mapVer === 1 && c?.save?.mapVer === 2,
    `${a.save?.mapVer} ${b?.save?.mapVer} ${c?.save?.mapVer}`);
  console.log(fails ? `s7b save: FAILED ${fails} checks` : 's7b save: ok');
  process.exit(fails ? 1 : 0);
}

// ---------- one session ----------
const { check, done, store, timers, byId } = await import('./s7b_env.mjs');
let input = '';
for await (const chunk of process.stdin) input += chunk;
store.set(KEY, input);

const W = await import('../src/world.js');
const { G, resetState } = await import('../src/state.js');
const { save, load } = await import('../src/save.js');
const ui = await import('../src/ui.js');
const want = phase === 'grid' ? 'grid' : 'v2';
check(`the world is ${want}`, W.KIND === want, W.KIND);
W.generate();
resetState();
check('the save loads', load() === true);
check('money, jars, posted, owned, paint and story are intact', G.money === V1.money && [...G.jars].join() === V1.jars.join()
  && JSON.stringify(G.posted) === JSON.stringify(V1.posted) && JSON.stringify(G.owned) === JSON.stringify(V1.owned)
  && JSON.stringify(G.paint) === JSON.stringify(V1.paint) && JSON.stringify(G.story) === JSON.stringify(V1.story));
check('the found jars count on this map', ui.jarsFound() === V1.jars.length);

// a few frames of play: the HUD runs, and toasts fire once their timers run
const toasts = () => byId('toasts').children.map(e => e.textContent);
Object.assign(G, { mode: 'play', friends: [], cars: [], peds: [] });
const welcome = t => t.includes('Kimchi Key');
const frame = () => { ui.updateHUD(); timers(5000); };   // toasts stay up: their fade-out timers wait
for (let i = 0; i < 5; i++) frame();
const shown = toasts().filter(welcome).length;
if (phase === 'v2') {
  check('first v2 session: the welcome toast shows once', shown === 1, toasts().join(' | '));
  check('and G.seen.v2welcome is set', G.seen.v2welcome === true);
  // the session records open-world progress and spots a jar
  G.pr.traps.lighthouse = { kmh: 201 };
  G.pr.found.fest = true;
  G.seen.jar9 = true;
} else if (phase === 'grid') {
  check('the grid (2D) never shows the v2 welcome', shown === 0);
  check('v2welcome is still set', G.seen.v2welcome === true);
} else {
  check('second v2 session: no welcome again', shown === 0 && G.seen.v2welcome === true);
}
check('pr records loaded intact', phase === 'v2' || (G.pr.traps.lighthouse?.kmh === 201 && G.pr.found.fest === true));
check('save (the autosave) succeeds', save() === true);
console.log('SAVE:' + store.get(KEY));
done(`s7b save ${phase}`);
