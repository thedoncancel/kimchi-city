#!/usr/bin/env node
// Stage S7b: the 3D markers on Kimchi Key v2 (src/3d/fx.js; docs/map-v2-spec.md §11).
//   node tools/s7b_fx_test.mjs [-v]
// Builds the effects layer in node on the v2 world (tools/s7b_env.mjs stands in for the 3D city with S and
// surfaceY = world.groundY) and checks:
//  - 12 photo and 12 giver markers, given to the marks nearest the camera, the rest hidden;
//  - every marker, beacon, door ring and jar stands on world.groundY;
//  - a gem bobs the same whatever the nearest-first order;
//  - a jar Kimchi comes within 40 m of (in play) is spotted for the big map: G.seen['jar' + id].
import { check, section, done } from './s7b_env.mjs';

const THREE = await import('three');
const W = await import('../src/world.js');
const { G, resetState } = await import('../src/state.js');
const { makeFX } = await import('../src/3d/fx.js');
const PX = W.PX_PER_M, S = 1 / PX;

check('the world is v2', W.KIND === 'v2');
W.generate();
resetState();
Object.assign(G, { mode: 'play', t: 0, friends: [], cars: [], peds: [], job: null });
const scene = new THREE.Scene();
const fx = makeFX(scene, { flashLight: false });

const kind = g => {
  const [a, b] = g.children || [];
  if (!a || !b || b.geometry?.type !== 'OctahedronGeometry') return g.children?.length === 4 ? 'jar' : null;
  return a.geometry.type === 'RingGeometry' ? 'photo' : a.geometry.type === 'CylinderGeometry' ? 'giver' : null;
};
const groups = k => scene.children.filter(g => g.isGroup && kind(g) === k);
const shown = k => groups(k).filter(g => g.visible);
const cam = new THREE.Vector3();

// ---------- pools, nearest first ----------
section('marker pools');
check('12 photo markers and 12 giver markers', groups('photo').length === 12 && groups('giver').length === 12,
  `${groups('photo').length} / ${groups('giver').length}`);
const home = W.places.home.foot;
cam.set(home.x * S, 0, home.y * S);
// 15 photo marks and 20 givers, at shuffled distances from the camera
const ring = (n, r0, step, phase) => Array.from({ length: n }, (_, i) => {
  const r = (r0 + ((i * 7) % n) * step) * PX, a = phase + i * 2.4;
  return { x: home.x + Math.cos(a) * r, y: home.y + Math.sin(a) * r };
});
const photoMarks = ring(15, 20, 9, 0).map(p => ({ ...p, photo: true }));
const giverMarks = ring(20, 15, 11, 1).map(p => ({ ...p, giver: true }));
const beaconMark = { x: home.x + 300, y: home.y, color: '#f2c230' }, arrowMark = { x: home.x - 300, y: home.y, color: '#e23b2b', small: true };
fx.setMarks([...photoMarks, beaconMark, ...giverMarks, arrowMark]);
fx.update(1 / 60, 1, cam);
const nearest = (marks, n) => marks.map(m => [Math.hypot(m.x * S - cam.x, m.y * S - cam.z), m]).sort((a, b) => a[0] - b[0]).slice(0, n).map(e => e[1]);
const key = (x, z) => `${x.toFixed(3)},${z.toFixed(3)}`;
const placed = k => new Set(shown(k).map(g => key(g.position.x, g.position.z)));
const want = (marks, n) => new Set(nearest(marks, n).map(m => key(m.x * S, m.y * S)));
const same = (a, b) => a.size === b.size && [...a].every(v => b.has(v));
check('15 photo spots: the 12 nearest get markers', shown('photo').length === 12 && same(placed('photo'), want(photoMarks, 12)));
check('20 givers: the 12 nearest get markers', shown('giver').length === 12 && same(placed('giver'), want(giverMarks, 12)));
const beacon = scene.children.find(g => g.isGroup && g.visible && g.children.length === 2 && g.children[1].geometry?.type === 'RingGeometry' && Math.abs(g.position.x - beaconMark.x * S) < 1e-6);
check('beacons still take their marks in order', !!beacon);
check('an arrow marks the small mark', scene.children.some(m => m.isMesh && m.visible && m.geometry?.type === 'ConeGeometry' && Math.abs(m.position.x - arrowMark.x * S) < 1e-6));
fx.setMarks(giverMarks.slice(0, 5));
fx.update(1 / 60, 1.1, cam);
check('fewer marks than markers: the rest hide', shown('giver').length === 5 && shown('photo').length === 0);

// ---------- on the ground ----------
section('on the ground');
fx.setMarks([...photoMarks, ...giverMarks]);
fx.update(1 / 60, 1.2, cam);
const onGround = (k, dy) => shown(k).every(g => Math.abs(g.position.y - (W.groundY(g.position.x * PX, g.position.z * PX) + dy)) < 1e-6);
check('photo rings stand on groundY', onGround('photo', 0.02));
check('giver markers stand on groundY', onGround('giver', 0.02));
check('beacons stand on groundY', (() => {
  fx.setMarks([beaconMark]); fx.update(1 / 60, 1.3, cam);
  const b = scene.children.find(g => g.isGroup && g.visible && g.children.length === 2 && g.children[1].geometry?.type === 'RingGeometry');
  return b && Math.abs(b.position.y - (W.groundY(beaconMark.x, beaconMark.y) + 0.05)) < 1e-6;
})());
const doorRings = scene.children.filter(m => m.isMesh && m.geometry?.type === 'RingGeometry' && m.geometry.parameters.innerRadius === 0.9);
check('door rings stand on groundY', doorRings.length > 0 && doorRings.every(r => Math.abs(r.position.y - (W.groundY(r.position.x * PX, r.position.z * PX) + 0.03)) < 1e-6), String(doorRings.length));
const jarGroups = groups('jar');
// a jar near the camera bobs 0.15 m about its base; one far away keeps it
check('25 jars, each 0.85 m over groundY', jarGroups.length === W.jarSpots.length && W.jarSpots.every(j => jarGroups.some(g =>
  Math.abs(g.position.x - j.x * S) < 1e-6 && Math.abs(g.position.z - j.y * S) < 1e-6
  && Math.abs(g.position.y - (W.groundY(j.x, j.y) + 0.85)) <= 0.15 + 1e-6)));

// ---------- the bob does not jump when the order changes ----------
section('gems');
const gemY = (m, t, c) => {
  cam.copy(c);
  fx.setMarks(photoMarks.map(p => ({ ...p })));
  fx.update(0, t, cam);
  const g = shown('photo').find(q => key(q.position.x, q.position.z) === key(m.x * S, m.y * S));
  return g ? g.children[1].position.y : null;
};
cam.set(home.x * S, 0, home.y * S);
const m0 = nearest(photoMarks, 6)[5];   // sixth from the villa, first once the camera stands by it
const slotA = nearest(photoMarks, 12).indexOf(m0);
const ya = gemY(m0, 2.5, new THREE.Vector3(home.x * S, 0, home.y * S));
const yb = gemY(m0, 2.5, new THREE.Vector3(m0.x * S + 3, 0, m0.y * S + 3));
check('a gem bobs on its own beat, whatever the order', slotA === 5 && ya !== null && ya === yb, `${ya} vs ${yb}`);

// ---------- spotted jars ----------
section('spotted jars');
fx.setMarks([]);
const [j1, j2, j3] = W.jarSpots;
G.seen = { v2welcome: false };
G.jars = new Set([j3.id]);
const at = (j, m) => Object.assign(G.player, { x: j.x + m * PX, y: j.y });
at(j1, 39); fx.update(1 / 60, 3, cam);
check('a jar within 40 m is spotted', G.seen['jar' + j1.id] === true);
at(j2, 41); fx.update(1 / 60, 3.1, cam);
check('one 41 m away is not', !G.seen['jar' + j2.id]);
at(j3, 5); fx.update(1 / 60, 3.2, cam);
check('a jar already found is not marked', !G.seen['jar' + j3.id]);
G.mode = 'title';
at(j2, 2); fx.update(1 / 60, 3.3, cam);
check('nothing is spotted on the title screen', !G.seen['jar' + j2.id]);
G.mode = 'play';
fx.update(1 / 60, 3.4, cam);
check('back in play it is', G.seen['jar' + j2.id] === true);

done('s7b fx');
