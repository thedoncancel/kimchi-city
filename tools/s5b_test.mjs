#!/usr/bin/env node
// Stage S5b check (docs/map-v2-stages.json, spec §5.7 and §11.1): the v2 props and landmarks, built in node.
//   node tools/s5b_test.mjs            (S3B_LOW=1 for the phone tier)
//  1. props3d: buildProps3D(world, chunks) returns { nearestLamps, update, lampHeads }; a lamp head (a Vector3
//     main3d copies into its few real lights) for every lamp, standing over its own ground; nearestLamps gives
//     what sorting every head by distance gives (ties in lamp order), and nothing for a point that is not a
//     number.
//  2. Every placeProps list the renderers own is placed: a KayKit traffic light and three lenses per signal
//     post, two sign faces per chevron and danger sign, the advisory sign's arrow and plate, the gantries'
//     legs, beam and name panels (every exit name in the atlas), the billboards' posters, the furniture and the
//     prefab dressing, the bollards; every atlas tile inside the texture.
//  3. The lenses follow roads.signalAt: all dark while the signals are off; with them on, each drawn lens lit
//     exactly when its approach shows its colour. Night: the light pools come on (the tiles near the camera)
//     and the lamp heads reach further; by day the pools are off.
//  4. landmarks3d: every §5.7 landmark is built (the tower's shell is a building: only its crown here), the
//     jet in 4 meshes, the beacon materials (crown, letters, pylon, lighthouse lamp and beam, aircraft lights)
//     with fog off; the crown sits on the tower's top; the wheel turns at its 0.02 Hz with its gondolas kept
//     upright; the lighthouse beam turns at 0.25 Hz and shows only at night; the Bayfront fountain stands on
//     grass, off the Riverwalk.
//     With roads3d's bridges built (its 'bridges' layer), the pylon, arch and bascule houses are its: here the
//     pylon gets only its lights, the aircraft light on its head and the night strips up its legs, which follow
//     roads3d's own legs (built here): 0.12 m outside a leg's face, within 0.3 m, all the way up.
//  5. The SL1 crest view (pass_crest's chase camera) has the tower and the pylon in frame.
//  6. Budgets: on every v2 bench view the props and landmarks together draw at most 40 calls in the camera
//     pass and 16 in the sun's shadow pass, and 150 k triangles (spec §11.2's ≤ 380 calls overall, ≤ 360 for
//     KC3.bench at S5b, leave this much for them).
//  7. Every advisory sign's curve arrow bends the way its own bend does, worked out from the road's own curvature
//     (the tight run 40 m ahead of the sign, seen the way its traffic goes), not from placeProps' lists.
//  8. Nothing stands on a landmark: no lamp post or head and no street furniture inside a landmark's footprint
//     (landmarkFootprints); and no landmark floats: every wall's foot and every downward face within 2.5 m of
//     the ground touches it (0.1 m) or rests on, or is fixed to, another part of the same landmark.
//  9. No landmark is see-through from below: looking straight up from 1.6 m over the ground (or the sea) under
//     it, the first face met looks down (a face looking up is culled from below), unless the eye is inside a
//     closed part; from inside one the look starts again just over the part's top (the stage's deck, a pillar).
// 10. The light pools lie on the ground: under every lamp, against the surface drawn there (roads3d's asphalt,
//     kerbs, sidewalks and decks, built here, else the ground), the pool stands 4 cm over it (the median), at
//     most about 0.25 m over the road (a kerb's step), within a kerb's step near the lamp, and is hidden under
//     a surface at under 3% of points.
// Exits 1 if any check fails.
import { src, check, section, note, done, quiet } from './s3b_env.mjs';
globalThis.KC_WORLD = 'v2';
const THREE = await import('three');
const D = await import('./s3b_draws.mjs');
const W = await import(src('src/world.js'));
W.generate();
const { makeChunkManager } = await import(src('src/3d/chunks.js'));
const P = await import(src('src/3d/props3d.js'));
const LM = await import(src('src/3d/landmarks3d.js'));
const FEET = LM.landmarkFootprints(W);
const onLandmark = (x, z, pad = 0) => FEET.find(f => f.inside(x, z, pad));
const PX = 16;
const LOW = process.env.S3B_LOW === '1';

const scene = new THREE.Scene();
const city = new THREE.Group();
scene.add(city);
const sun = D.makeSun(LOW ? 42 : 64);
scene.add(sun, sun.target);
const chunks = makeChunkManager(city, { castR: 110 });
const camera = new THREE.PerspectiveCamera(62, 1440 / 800, 0.15, 2600);
// roads3d, built once when a check needs its surfaces or its bridges: [{ obj, o }] as it hands them to the chunks
let roadParts = null;
async function roads3d() {
  if (roadParts) return roadParts;
  const R = await import(src('src/3d/roads3d.js'));
  roadParts = [];
  await quiet(() => R.buildRoads3D(W, { add(obj, o) { roadParts.push({ obj, o }); return {}; } }, { terrain: { lod0: new THREE.MeshLambertMaterial() }, night() {} }));
  return roadParts;
}

// ---------- 1. props: lamps and nearestLamps ----------

section('props3d: the lamps and nearestLamps (spec §11.1 Lights)');
check('buildProps3D takes (world, chunks)', P.buildProps3D.length === 2, String(P.buildProps3D.length));
const props = await quiet(() => P.buildProps3D(W, chunks));
check('it returns { nearestLamps, update, lampHeads, stats }', typeof props?.nearestLamps === 'function' && typeof props.update === 'function' && Array.isArray(props.lampHeads));
// the world's lamps first, in order, then the ones on the bridge decks (every 45 m, on long decks only)
const deckLamps = W.roads.edges.reduce((n, e) => n + (e.deck || []).reduce((m, [a, b]) => m + ((b - a) / PX < 40 ? 0 : Math.max(0, Math.ceil(((b - a) / PX - 30) / 45))), 0), 0);
check('a lamp head for every lamp, and the bridge decks\' lamps after them', props.lampHeads.length === W.lamps.length + deckLamps, `${props.lampHeads.length} vs ${W.lamps.length} + ${deckLamps}`);
{
  let bad = 0, worst = '';
  let moved = 0;
  props.lampHeads.forEach((h, i) => {
    const l = W.lamps[i], g = W.groundY(h.x * PX, h.z * PX), up = h.y - g;
    // a lamp the world put on a landmark's ground has moved off it (along the road through a gate)
    const arm = l && !l.path ? 2.1 : 0, onL = l && (onLandmark(l.x / PX, l.y / PX, 0.4) || onLandmark(l.x / PX + Math.cos(l.a ?? 0) * arm, l.y / PX + Math.sin(l.a ?? 0) * arm, 0.6));
    const far = l ? Math.hypot(h.x - l.x / PX, h.z - l.y / PX) : 0;
    if (onL) moved++;
    if (!h.isVector3 || up < 3 || up > 8.5 || (l && far > (onL ? 12 : 2.5))) { bad++; worst ||= `lamp ${i}: ${up.toFixed(2)} m up, ${far.toFixed(1)} m from its lamp`; }
  });
  note(`${moved} lamps moved off a landmark's ground`);
  check('every head stands 3-8.5 m over its ground, within 2.5 m of its world lamp (12 m for one moved off a landmark)', bad === 0, `${bad} off (${worst})`);
  const onDeck = props.lampHeads.slice(W.lamps.length).filter(h => W.surfaceAt(h.x * PX, h.z * PX) === W.DECK).length;
  check('the deck lamps\' heads are over the decks', onDeck === deckLamps, `${onDeck} of ${deckLamps}`);
}
{
  let r = 7, mism = 0, first = '';
  const rnd = () => ((r = (r * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let k = 0; k < 300; k++) {
    const x = rnd() * 2048, z = rnd() * 1792, n = 1 + Math.floor(rnd() * 6);
    const got = props.nearestLamps(x, z, n, []);
    const want = props.lampHeads.map((h, i) => [(h.x - x) ** 2 + (h.z - z) ** 2, i, h]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, n).map(q => q[2]);
    if (got.length !== want.length || got.some((h, i) => h !== want[i])) { mism++; first ||= `(${x.toFixed(0)}, ${z.toFixed(0)}) n ${n}`; }
  }
  check('nearestLamps = every head sorted by distance (300 points)', mism === 0, `${mism} differ, e.g. ${first}`);
  check('nearestLamps of NaN is empty', props.nearestLamps(NaN, 5, 6, [1]).length === 0 && props.nearestLamps(5, Infinity, 6, []).length === 0);
  check('nearestLamps fills and returns out', (() => { const o = [9]; return props.nearestLamps(900, 500, 3, o) === o && o.length === 3; })());
}

// wait for the street pack (traffic lights, benches, hydrants)
for (let i = 0; i < 100 && !props.stats().pack; i++) await new Promise(r => setTimeout(r, 30));
check('the KayKit street pack loaded', props.stats().pack);

// ---------- 2. every list placed ----------

section('props3d: every placeProps list placed');
const st = props.stats(), by = st.by;
const L = {};
for (const d of W.deco) (L[d.list] ||= []).push(d);
const count = (list, kind) => (L[list] || []).filter(d => !kind || d.kind === kind).length;
const signals = count('signals');
note(`${st.items} copies in ${st.kinds} kinds: ` + Object.entries(by).map(([k, v]) => `${k} ${v[2]}`).join(', '));
check('a traffic light per signal post', by.trafficlight_C?.[2] === signals, `${by.trafficlight_C?.[2]} vs ${signals}`);
check('three lenses per signal post', by.lenses?.[2] === signals * 3, `${by.lenses?.[2]} vs ${signals * 3}`);
// the street's furniture is left off a landmark's ground
const offL = (d) => d.list === 'furniture' && !!onLandmark(d.x / PX, d.y / PX, d.kind === 'busStop' ? 2.5 : 0.5);
const placed = (list, kind) => (L[list] || []).filter(d => (!kind || d.kind === kind) && !offL(d)).length;
note(`${(L.furniture || []).filter(offL).length} pieces of furniture left off a landmark's ground: ` + (L.furniture || []).filter(offL).map(d => `${d.kind}@(${(d.x / PX).toFixed(0)},${(d.y / PX).toFixed(0)})`).join(' '));
check('the furniture left off the landmarks is what props3d counts', st.offLandmarks === (L.furniture || []).filter(offL).length);
const benches = placed('furniture', 'bench') + placed('prefab', 'bench');
check('a KayKit bench per bench (furniture and prefabs)', by.bench?.[2] === benches, `${by.bench?.[2]} vs ${benches}`);
check('a KayKit hydrant per hydrant', by.firehydrant?.[2] === placed('furniture', 'hydrant'), `${by.firehydrant?.[2]} vs ${placed('furniture', 'hydrant')}`);
{
  const traps = W.activities.filter(a => a.type === 'speedTrap').length, ch = count('chevrons', 'chevron'), adv = count('chevrons', 'advisory');
  const faces = 2 * ch + 3 * adv + 2 * count('dangerSigns') + 2 * traps + 2 * count('gantries') + 2 * placed('furniture', 'busStop') + 2 * count('prefab', 'kiosk');
  check('every sign face placed (chevrons 2, advisory 3, danger 2, traps 2, gantries 2, bus stops 2, kiosk 2)', by.sign?.[2] === faces, `${by.sign?.[2]} vs ${faces}`);
  check('a poster per billboard and per bus stop', by.board?.[2] === count('billboards') + placed('furniture', 'busStop'), `${by.board?.[2]}`);
  const posts = props.lampHeads.length + ch + adv + count('dangerSigns') + traps + 2 * count('gantries') + 2 * count('billboards') + 2 * placed('furniture', 'bin') + 5 * placed('furniture', 'busStop')
    + count('prefab', 'umbrella') + (L.fences || []).filter(f => f.kind === 'bollards').reduce((s, f) => s + f.pts.length / 2, 0);
  check('every post, pole, bin and bollard placed', by.pole?.[2] === posts, `${by.pole?.[2]} vs ${posts}`);
  check('a light pool and a head per lamp', st.pools?.pools === props.lampHeads.length && by['lamp heads']?.[2] === props.lampHeads.length, `${st.pools?.pools} pools`);
}
{
  // atlas tiles inside [0, 1]
  const root = city.children.find(o => o.name === 'props');
  let bad = 0;
  root.traverse((o) => {
    const t = o.geometry?.attributes?.aTile;
    if (!t) return;
    for (let i = 0; i < t.count; i++) {
      const u0 = t.getX(i), v0 = t.getY(i), du = t.getZ(i), dv = t.getW(i);
      if (Math.min(u0, u0 + du, v0, v0 + dv) < 0 || Math.max(u0, u0 + du, v0, v0 + dv) > 1) bad++;
    }
  });
  check('no atlas tile reaches outside its texture (after a refresh)', bad === 0, `${bad}`);
}

// ---------- 3. lenses and night ----------

section('props3d: lenses from roads.signalAt, and the night');
const sig = (L.signals || [])[0];
{
  const x = sig.x / PX, z = sig.y / PX, g = W.groundY(sig.x, sig.y);
  camera.position.set(x + Math.cos(sig.a) * 14, g + 4, z + Math.sin(sig.a) * 14);
  camera.lookAt(x, g + 5, z);
  camera.updateMatrixWorld(true);
  // (mapdata SIGNALS.enabled is on since the wave-3 integration: start from the signals off, put them back after)
  const signalsWere = !!W.roads.signalsOn;
  W.roads.setSignals?.(false);
  props.update(camera, 1, 0);
  const lensMesh = city.children.find(o => o.name === 'props').children.find(m => m.name === 'props lenses');
  const dark = () => { const c = lensMesh.instanceColor.array; let lit = 0; for (let i = 0; i < lensMesh.count; i++) if (c[i * 3] + c[i * 3 + 1] + c[i * 3 + 2] > 1) lit++; return lit; };
  check('lenses are drawn near a signal', lensMesh.count >= 3, String(lensMesh.count));
  check('all lenses dark while the signals are off', dark() === 0, `${dark()} lit`);
  W.roads.setSignals?.(true);
  let ok = 0, bad = 0;
  for (const t of [0, 5, 13, 16.5, 19, 30]) {
    W.roads.tick(t - (W.roads.clock || 0));
    props.update(camera, 1 + t, 0);
    const lit = dark();
    // each signal post shows exactly one lit lens
    if (lit * 3 === lensMesh.count) ok++; else bad++;
  }
  check('with the signals on, one lens of three lit on every drawn head (6 moments)', bad === 0, `${bad} moments off`);
  W.roads.setSignals?.(false);
  props.update(camera, 40, 0);
  check('dark again once the signals are off', dark() === 0);
  W.roads.setSignals?.(signalsWere);
}
{
  const root = city.children.find(o => o.name === 'props');
  const pools = root.children.filter(m => m.name === 'props light pools'), heads = root.children.find(m => m.name === 'props lamp heads');
  const shown = () => pools.filter(m => m.visible).length;
  const v = W.benchViews.find(b => b.name === 'ktown_circle');
  D.placeCamera(camera, v, { groundY: W.groundY });
  props.update(camera, 50, 0);
  const dayPools = shown(), dayHeads = heads.count;
  props.update(camera, 51, 1);
  check('no light pools by day', dayPools === 0, String(dayPools));
  check('light pools at night (the tiles near the camera)', shown() > 0 && shown() < pools.length, `${shown()} of ${pools.length} tiles, ${props.stats().pools.drawn} pools`);
  check('more lamp heads at night (they glow further out)', heads.count >= dayHeads, `${dayHeads} -> ${heads.count}`);
  check('the pools glow at night', pools[0].material.opacity > 0.2);
  props.update(camera, 52, 0);
}

// ---------- 4. landmarks ----------

section('landmarks3d: every landmark, the beacons, the moving parts');
check('buildLandmarks takes (world, group, chunks)', LM.buildLandmarks.length === 3);
const marks = await quiet(() => LM.buildLandmarks(W, city, chunks));
check('it returns { update }', typeof marks?.update === 'function');
const ids = new Set(marks.built.map(b => b.id));
const want = W.landmarks.map(l => (l.kind === 'crane' ? 'port_cranes' : l.id));
const missing = [...new Set(want)].filter(id => !ids.has(id));
check('every §5.7 landmark built', missing.length === 0, missing.join(', '));
check('the prefab fountains built too', W.deco.filter(d => d.kind === 'fountain').every(d => ids.has('fountain ' + d.x + ',' + d.y)));
const meshesOf = (id) => marks.built.find(b => b.id === id)?.meshes || [];
check('the jet is 4 meshes', meshesOf('kimchi_one').length === 4, String(meshesOf('kimchi_one').length));
{
  const fogOn = [];
  for (const id of ['kimchi_tower', 'kimchi_letters', 'causeway_pylon', 'lighthouse']) {
    // everything but the plain painted structure (the crown's fins, the lighthouse tower) is a light
    for (const m of meshesOf(id)) if (m.material.fog !== false && m.material.name !== 'paint') fogOn.push(`${id}:${m.material.name || m.material.type}`);
  }
  check('beacon materials have fog off (crown, letters, pylon, lighthouse lamp)', fogOn.length === 0, fogOn.join(' '));
  const crown = meshesOf('kimchi_tower');
  const T = W.landmarks.find(l => l.id === 'kimchi_tower');
  const minY = Math.min(...crown.map(m => { m.geometry.computeBoundingBox(); return m.geometry.boundingBox.min.y; }));
  check('the crown sits on the tower\'s 140 m top', Math.abs(minY - (T.base + T.h)) < 0.05, `${minY.toFixed(2)} vs ${T.base + T.h}`);
  const b = W.buildings[T.building];
  check('the tower shell is a building (S5a), not built here', b?.landmark === 'kimchi_tower' && crown.every(m => { const bb = m.geometry.boundingBox; return bb.max.x - bb.min.x <= 32; }));
}
{
  // the wheel turns at hz; its gondolas stay upright
  const wheel = meshesOf('ferris_wheel'), gond = wheel.find(m => m.isInstancedMesh), rim = wheel.find(m => m.parent?.parent && m.parent.type === 'Group' && !m.isInstancedMesh && m.parent.parent.type === 'Group');
  const hz = W.landmarks.find(l => l.id === 'ferris_wheel').hz;
  marks.update(10, 0);
  const a0 = rim?.parent.rotation.x;
  marks.update(12.5, 0);
  const a1 = rim?.parent.rotation.x;
  check('the Ferris wheel turns at its hz', rim && Math.abs((a1 - a0) - 2.5 * hz * Math.PI * 2) < 1e-6, `${a0} -> ${a1}`);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  let tilted = 0;
  for (let i = 0; i < gond.count; i++) { gond.getMatrixAt(i, m); m.decompose(p, q, s); if (Math.abs(q.w) < 0.9999) tilted++; }
  check('its gondolas hang upright', tilted === 0, `${tilted} tilted`);
  const beam = city.children.find(o => o.isGroup && o.children.length === 2 && o.children.every(c => c.material?.blending === THREE.AdditiveBlending));
  marks.update(20, 0);
  check('the lighthouse beam is off by day', beam && !beam.visible);
  marks.update(20, 1);
  const r0 = beam?.rotation.y;
  marks.update(21, 1);
  check('the beam shows at night and turns at 0.25 Hz', beam?.visible && Math.abs(Math.abs(beam.rotation.y - r0) - 0.25 * Math.PI * 2) < 1e-6, `${r0} -> ${beam?.rotation.y}`);
  check('the beam ignores fog', beam?.children.every(c => c.material.fog === false));
  marks.update(22, 0);
}
{
  // with roads3d's bridges built, the pylon, the arch and the bascule houses are its: only the pylon's light here
  const g2 = new THREE.Group(), ch2 = makeChunkManager(g2, { castR: 110 });
  ch2.add(new THREE.Group(), { layer: 'bridges' });
  const m2 = await quiet(() => LM.buildLandmarks(W, g2, ch2));
  const ids2 = new Set(m2.built.map(b => b.id)), py = m2.built.find(b => b.id === 'causeway_pylon');
  check('with roads3d\'s bridges: no arch or bascule houses of our own', !ids2.has('rickenbacker_arch') && !ids2.has('venetian_bascules'));
  const head = py?.meshes.find(m => m.material.name === 'beacon'), strips = py?.meshes.find(m => m.material.name === 'pylon lights');
  check('with roads3d\'s bridges: the pylon gets only its lights, the aircraft light on its 62 m head and the leg strips', py?.meshes.length === 2 && head && strips
    && py.meshes.every(m => m.material.fog === false && !m.castShadow)
    && Math.abs(head.geometry.boundingSphere.center.y - (W.SEA_LEVEL + W.landmarks.find(l => l.id === 'causeway_pylon').h + 0.9)) < 0.01);
  m2.update(5, 0);
  const dayStrips = strips?.visible;
  m2.update(6, 1);
  check('with roads3d\'s bridges: the leg strips show only after dark', dayStrips === false && strips?.visible === true);
  {
    // the strips run up roads3d's legs: 3.05 m outside the deck's edge at deck height, 1.3 m off the middle under the head
    strips?.geometry.computeBoundingBox();
    const bb = strips?.geometry.boundingBox, Py = W.landmarks.find(l => l.id === 'causeway_pylon');
    check('the leg strips rise from over the deck to under the head', bb && bb.max.y < W.SEA_LEVEL + Py.h - 10 && bb.min.y > W.SEA_LEVEL + 14 && bb.max.y - bb.min.y > 30, bb ? `${bb.min.y.toFixed(1)}-${bb.max.y.toFixed(1)} m` : 'no strips');
    // ... and they follow roads3d's own legs (landmarks3d copies its leg rule): along its whole length each strip's
    // centre line keeps 0.12 m (+-0.3) outside a leg's face, the faces seen along the deck
    const fit = stripsOnLegs(py?.strips || [], await roads3d());
    note(`pylon strips: ${fit.points} points on ${fit.strips} strips, ${fit.faces} leg faces; off the legs by ${fit.min.toFixed(2)}-${fit.max.toFixed(2)} m`);
    check('each leg strip runs along a leg of roads3d\'s pylon (0.12 m out from its face, within 0.3 m, all the way up)', fit.strips === 4 && fit.faces >= 4 && fit.bad === 0, `${fit.bad} points off, e.g. ${fit.eg}`);
  }
  check('with roads3d\'s bridges: every other landmark still built', [...ids].filter(id => !['rickenbacker_arch', 'venetian_bascules'].includes(id)).every(id => ids2.has(id)));
}
{
  const f = meshesOf('bayfront_fountain')[0];
  f.geometry.computeBoundingSphere();
  const c = f.geometry.boundingSphere.center;
  check('the Bayfront fountain stands on grass, off the Riverwalk path', W.surfaceAt(c.x * PX, c.z * PX) === W.GRASS && W.surfaceAt((c.x + 8) * PX, c.z * PX) !== W.PLAZA, `(${c.x.toFixed(1)}, ${c.z.toFixed(1)})`);
}

// ---------- 5. the crest view ----------

section('the SL1 crest view frames the tower and the pylon');
{
  const v = W.benchViews.find(b => b.name === 'pass_crest');
  D.placeCamera(camera, v, { groundY: W.groundY });
  camera.updateProjectionMatrix();
  const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const T = W.landmarks.find(l => l.id === 'kimchi_tower'), Py = W.landmarks.find(l => l.id === 'causeway_pylon');
  // (the sightline's own target, mid-height; the chase camera looks down at the car, so the 140 m top sits at the frame's edge)
  check('the tower is in frame (its mid-height, the SL1 target)', fr.containsPoint(new THREE.Vector3(T.x, T.base + T.h / 2, T.z)));
  const top = new THREE.Vector3(T.x, T.base + T.h, T.z).project(camera);
  note(`the crown's foot projects to (${top.x.toFixed(2)}, ${top.y.toFixed(2)}) in clip space`);
  check('the pylon\'s head (62 m over the sea) is in frame', fr.containsPoint(new THREE.Vector3(Py.x, W.SEA_LEVEL + Py.h, Py.z)));
}

// ---------- 6. budgets on the bench views ----------

section('draw budget of props + landmarks on the v2 bench views');
for (const night of [0, 1]) for (const v of W.benchViews) {
  const focus = D.placeCamera(camera, v, { groundY: W.groundY });
  D.placeSun(sun, 13 * 60, focus);
  chunks.update(camera, focus, 0.016);
  props.update(camera, 60, night);
  marks.update(60, night);
  const cam = D.cameraPass(scene, camera), sh = D.shadowPass(scene, camera, sun);
  const line = `${v.name}${night ? ' (night)' : ''}: ${cam.calls} calls + ${sh.calls} shadow, ${((cam.tris + sh.tris) / 1000).toFixed(0)} k tris`;
  note(line);
  check(`${line} within 40 + 16 calls and 150 k tris`, cam.calls <= 40 && sh.calls <= 16 && cam.tris + sh.tris <= 150000);
}
props.update(camera, 61, 0);

// ---------- 7. the advisory arrows ----------

section('every advisory arrow bends the way its own bend does');
{
  // From the edge's own curvature, not placeProps' lists: the tight runs (R under 57 m, the §0 advisory limit of
  // 120 km/h at grip 2 on the flat; at least 8 m long), and of them the one the sign stands 40 m before, ahead of
  // it the way its traffic goes (nearer when the sign stands at the edge's end). The run turns the way its summed
  // curvature says; seen against the edge's point order (dir -1) the turn is the mirror.
  let wrong = 0, unknown = 0, first = '';
  for (const q of props.advisories) {
    const c = q.sign, e = W.roads.edges[c.edge], dir = (c.dir ?? 1) > 0 ? 1 : -1;
    let i0 = 0, best = Infinity;
    for (let i = 0; i < e.n; i++) { const d = (e.x[i] - c.x) ** 2 + (e.y[i] - c.y) ** 2; if (d < best) { best = d; i0 = i; } }
    const runs = [], tight = (j) => Math.abs(e.k[j] * PX) > 1 / 57;
    for (let i = 0; i < e.n;) {
      if (!tight(i)) { i++; continue; }
      let j = i, sum = 0;
      while (j < e.n && tight(j)) { sum += e.k[j]; j++; }
      if (e.s[j - 1] - e.s[i] >= 8 * PX) runs.push({ s0: e.s[i], s1: e.s[j - 1], sum });
      i = j;
    }
    const ss = e.s[i0], lead = (r) => (dir > 0 ? r.s0 - ss : ss - r.s1) / PX;      // m from the sign to the run's start
    const ahead = runs.filter(r => lead(r) > -2).sort((a, b) => lead(a) - lead(b));
    const pick = ahead.filter(r => lead(r) <= 42).pop() || ahead[0];
    if (!pick) { unknown++; continue; }
    const right = (pick.sum > 0) === (dir > 0);
    if (right !== q.right) { wrong++; first ||= `(${(c.x / PX).toFixed(0)}, ${(c.y / PX).toFixed(0)}) dir ${dir}: drawn ${q.right ? 'right' : 'left'}, the road bends ${right ? 'right' : 'left'} ${lead(pick).toFixed(0)} m on`; }
  }
  note(`${props.advisories.length} advisory signs, ${unknown} with no tight run ahead of them`);
  check('each advisory arrow bends the way the road does at the bend 40 m ahead of it', wrong === 0 && props.advisories.length === count('chevrons', 'advisory') && unknown === 0, `${wrong} wrong, e.g. ${first}`);
  const hairpins = props.advisories.filter(a => a.sign.edge === (L.chevrons || []).find(c => c.kind === 'chevron' && c.turn === 'L')?.edge);
  check('the switchbacks\' advisories point both ways (their hairpins alternate)', new Set(hairpins.map(a => a.right)).size === 2 || hairpins.length < 2, `${hairpins.length} on that edge`);
}

// ---------- 8. nothing on a landmark, no landmark floating ----------

// The parts of a landmark the ground need not carry: the jet stands on its gear, and the bridge structure (built
// here only without roads3d's bridges) stands on the decks and in the sea.
const NOT_GROUNDED = new Set(['kimchi_one', 'causeway_pylon', 'rickenbacker_arch', 'venetian_bascules']);


section('nothing stands on a landmark, and no landmark floats');
{
  const items = [];
  props.lampHeads.forEach((h, i) => {
    const l = W.lamps[i];
    if (!l) return;
    // the post is the head moved back along its arm
    const arm = l.path ? 0 : 2.1, a = l.a ?? 0;
    items.push({ what: 'lamp post', x: h.x - Math.cos(a) * arm, z: h.z - Math.sin(a) * arm, pad: 0.35 }, { what: 'lamp head', x: h.x, z: h.z, pad: 0.55 });
  });
  for (const d of L.furniture || []) if (!offL(d)) items.push({ what: d.kind, x: d.x / PX, z: d.y / PX, pad: d.kind === 'busStop' ? 2.4 : 0.45 });
  const on = items.filter(it => onLandmark(it.x, it.z, it.pad));
  check('no lamp post or head, and no street furniture, on a landmark\'s ground', on.length === 0, on.slice(0, 4).map(it => `${it.what}@(${it.x.toFixed(1)},${it.z.toFixed(1)}) on ${onLandmark(it.x, it.z, it.pad).id}`).join(' '));
}
{
  const floats = floatingParts(marks.built.filter(b => !NOT_GROUNDED.has(b.id)));
  note(`checked ${floats.points} wall feet and undersides in ${floats.landmarks} landmarks`);
  check('no landmark floats (every foot within 0.1 m of the ground, or resting on or fixed to its own parts)', floats.bad.length === 0, floats.bad.slice(0, 5).join('; '));
}

// ---------- 9. nothing see-through from below ----------

section('no landmark is see-through from below');
{
  const t0 = performance.now(), res = seeThrough(marks.built);
  for (const r of res.per) if (r.open) note(`${r.id}: ${r.open} of ${r.rays} looks up see through, e.g. ${r.eg.join(' ')}`);
  note(`${res.rays} looks up under ${res.per.length} landmarks (${res.inside} from inside a part) in ${(performance.now() - t0).toFixed(0)} ms`);
  check('looking straight up from under any landmark, the first face met looks down (its underside is there)', res.open === 0 && res.rays > 2000,
    res.per.filter(r => r.open).map(r => `${r.id} ${r.open}`).join(', '));
}

// ---------- 10. the light pools lie on the ground ----------

section('the lamps\' light pools lie on the ground (spec §11.1 Lights)');
{
  // Under every lamp, on a 0.7 m grid out to 6.3 m: where the pool is lit, its height against the surface drawn
  // there (roads3d's asphalt, kerbs, sidewalks and decks, else the ground). A pool floating over the road shows
  // through the glow on everything standing in it (Kimchi's feet, wheels, posts), so it must stay within a
  // kerb's step of it; one under a surface is hidden there.
  const t0 = performance.now(), r = poolFit(await roads3d());
  note(`${r.n} points under ${props.lampHeads.length} lamps in ${(performance.now() - t0).toFixed(0)} ms: the pool stands ${r.q(0.5)} m over the surface (median), ${r.q(0.9)} (90%), ${r.q(0.99)} (99%)`);
  note(`over the asphalt: ${r.asphalt} points, ${r.asphaltOver} more than 0.25 m over it (at most ${r.asphaltMax.toFixed(2)} m ${r.asphaltEg}); over any of roads3d's surfaces (asphalt, kerbs, sidewalks, decks): ${r.road} points, ${r.roadOver} more than 0.25 m over it (at most ${r.roadMax.toFixed(2)} m ${r.roadEg})`);
  note(`under the surface by over 5 cm (hidden there) at ${r.under} points (${(100 * r.under / r.n).toFixed(1)}%)`);
  check('the pools sit 4 cm over the surface (the median) and within 0.15 m at 90% of points', Math.abs(r.q(0.5) - 0.04) < 0.01 && r.q(0.9) <= 0.15, `${r.q(0.5)}, ${r.q(0.9)}`);
  // (a kerb's step and the pool's 4 cm; only where the road creases sharply, at a jump ramp's foot, does the
  // pool's 1 m grid stand off it more)
  check('over the road (asphalt) the pool stands at most 0.25 m above it (0.35 at a crease, at 0.02% of points)', r.asphalt > 20000 && r.asphaltOver <= 0.0002 * r.asphalt && r.asphaltMax <= 0.35,
    `${r.asphaltOver} of ${r.asphalt} over 0.25 m, at most ${r.asphaltMax.toFixed(3)} m ${r.asphaltEg}`);
  // (a sidewalk's slab can lie lower than the ground raster where a lot's pad spills over its cells; there the
  // pool follows the raster)
  check('over roads3d\'s surfaces the pool stands within 0.25 m at 99.8% of points', r.road > 20000 && r.roadOver <= 0.002 * r.road, `${r.roadOver} of ${r.road}`);
  check('within 3 m of a lamp (its post, the people under it) the pool is within a kerb\'s step (0.22 m) of the surface at 99% of points', r.nearOk >= 0.99 * r.near, `${r.nearOk} of ${r.near}`);
  check('the pools clear the surface (within 5 cm) at 97% of points', r.under <= 0.03 * r.n, `${r.under} of ${r.n} under`);
}

done();

// The light pools against the surfaces under them (see section 10). Only the parts of a pool lit at all three
// corners of its triangle count: past a wall or a ledge the pool fades out level with its last lit point.
function poolFit(parts) {
  const CELL = 4, heads = props.lampHeads, near = new Set();
  const key = (x, z) => Math.floor(x / CELL) + ',' + Math.floor(z / CELL);
  for (const h of heads) for (let a = -3; a <= 3; a++) for (let b = -3; b <= 3; b++) near.add((Math.floor(h.x / CELL) + a) + ',' + (Math.floor(h.z / CELL) + b));
  // the upward faces of roads3d's meshes (not its paint) and of the pools, in 4 m cells near the lamps
  const roads = new Map(), pools = new Map();
  const bucket = (map, T) => {
    for (let a = Math.floor(T.x0 / CELL); a <= Math.floor(T.x1 / CELL); a++) for (let b = Math.floor(T.z0 / CELL); b <= Math.floor(T.z1 / CELL); b++) {
      const k = a + ',' + b;
      if (!near.has(k)) continue;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(T);
    }
  };
  const faces = (m, map, lit) => {
    m.updateMatrixWorld(true);
    const pos = m.geometry.attributes.position, col = m.geometry.attributes.color, idx = m.geometry.index, n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      const ii = [0, 1, 2].map(k => (idx ? idx.getX(i + k) : i + k));
      const v = ii.map(q => new THREE.Vector3().fromBufferAttribute(pos, q).applyMatrix4(m.matrixWorld));
      if (new THREE.Triangle(...v).getNormal(new THREE.Vector3()).y < 0.5) continue;
      if (lit && ii.some(q => col.getX(q) < 1)) continue;
      bucket(map, { v, asphalt: /asphalt/.test(m.name + ' ' + (m.material?.name || '')), x0: Math.min(v[0].x, v[1].x, v[2].x), x1: Math.max(v[0].x, v[1].x, v[2].x), z0: Math.min(v[0].z, v[1].z, v[2].z), z1: Math.max(v[0].z, v[1].z, v[2].z) });
    }
  };
  for (const { obj } of parts) obj.traverse((m) => { if (m.isMesh && !/paint/.test(m.name)) faces(m, roads, false); });
  for (const m of city.children.find(o => o.name === 'props').children) if (m.name === 'props light pools') faces(m, pools, true);
  const ray = new THREE.Ray(), hit = new THREE.Vector3(), DOWN = new THREE.Vector3(0, -1, 0), from = new THREE.Vector3();
  // where a vertical line at (x, z) meets the faces in map: [{ y, T }], nearest y first
  const meet = (map, x, z, y) => {
    from.set(x, y + 30, z); ray.set(from, DOWN);
    const out = [];
    for (const T of map.get(key(x, z)) || []) if (x >= T.x0 && x <= T.x1 && z >= T.z0 && z <= T.z1 && ray.intersectTriangle(T.v[0], T.v[1], T.v[2], false, hit)) out.push({ y: hit.y, T });
    return out.sort((a, b) => Math.abs(a.y - y) - Math.abs(b.y - y));
  };
  const d = [], r = { n: 0, road: 0, roadMax: 0, roadEg: '', asphalt: 0, asphaltOver: 0, asphaltMax: 0, asphaltEg: '', roadOver: 0, under: 0, near: 0, nearOk: 0 };
  for (const h of heads) for (let u = -6.3; u <= 6.3; u += 0.7) for (let w = -6.3; w <= 6.3; w += 0.7) {
    if (u * u + w * w > 6.3 * 6.3) continue;
    const x = h.x + u + 0.011, z = h.z + w + 0.017, g = W.groundY(x * PX, z * PX);
    const road = meet(roads, x, z, g).find(q => Math.abs(q.y - g) < 1), top = road === undefined ? g : Math.max(road.y, g);
    for (const { y } of meet(pools, x, z, top)) {
      if (Math.abs(y - top) > 2) continue;
      const f = y - top, at = `(${x.toFixed(1)}, ${z.toFixed(1)})`;
      r.n++; d.push(f);
      if (f < -0.05) r.under++;
      if (road) {
        r.road++;
        if (f > 0.25) r.roadOver++;
        if (f > r.roadMax) { r.roadMax = f; r.roadEg = at; }
        if (road.T.asphalt) { r.asphalt++; if (f > 0.25) r.asphaltOver++; if (f > r.asphaltMax) { r.asphaltMax = f; r.asphaltEg = at; } }
      }
      if (u * u + w * w <= 9) { r.near++; if (Math.abs(f) <= 0.22) r.nearOk++; }
    }
  }
  d.sort((a, b) => a - b);
  r.q = (p) => +d[Math.floor(p * (d.length - 1))].toFixed(3);
  return r;
}

// The pylon's leg strips (landmarks3d's centre lines) against roads3d's legs: the big upright faces of its bridge
// meshes near the strips (the legs' faces seen along the deck; the stays and the beams are too small to count).
// Every 2 m up each strip, the nearest of those faces must be 0.12 m (+-0.3) away, with the strip outside it.
function stripsOnLegs(strips, parts) {
  const out = { strips: strips.length, faces: 0, points: 0, bad: 0, min: Infinity, max: 0, eg: '' };
  if (!strips.length) return out;
  const near = (p) => strips.some(([a, b]) => Math.hypot(p.x - (a[0] + b[0]) / 2, p.z - (a[2] + b[2]) / 2) < 12);
  const faces = [];
  for (const { obj, o } of parts) if (o?.layer === 'bridges') obj.traverse((m) => {
    if (!m.isMesh) return;
    m.updateMatrixWorld(true);
    const pos = m.geometry.attributes.position, idx = m.geometry.index, n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      const v = [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(pos, idx ? idx.getX(i + k) : i + k).applyMatrix4(m.matrixWorld));
      const T = new THREE.Triangle(...v), nrm = T.getNormal(new THREE.Vector3());
      if (T.getArea() < 20 || Math.abs(nrm.y) > 0.35 || !near(T.getMidpoint(new THREE.Vector3()))) continue;
      faces.push({ T, nrm });
    }
  });
  out.faces = faces.length;
  const q = new THREE.Vector3(), best = new THREE.Vector3();
  for (const [a, b] of strips) {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), n = Math.ceil(A.distanceTo(B) / 2);
    for (let k = 0; k <= n; k++) {
      const p = new THREE.Vector3().lerpVectors(A, B, k / n);
      let dmin = Infinity, side = 0;
      for (const F of faces) {
        F.T.closestPointToPoint(p, q);
        const dd = q.distanceTo(p);
        if (dd < dmin) { dmin = dd; best.copy(q); side = F.nrm.dot(p.clone().sub(q)); }
      }
      out.points++;
      out.min = Math.min(out.min, dmin); out.max = Math.max(out.max, dmin);
      if (!(Math.abs(dmin - 0.12) <= 0.3 && side > 0)) { out.bad++; out.eg ||= `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) ${dmin.toFixed(2)} m ${side > 0 ? 'out' : 'in'}`; }
    }
  }
  return out;
}

// Looks straight up from a 0.5 m grid under each landmark (static meshes only, as drawn: front faces), from 1.6 m
// over the ground or the sea. The first face met must look down. If it looks up and the eye is inside a closed part
// (inside below), the look starts again 5 cm over that face; if not, the landmark is see-through there. { per,
// rays (looks that meet a face), open, inside }
function seeThrough(list) {
  const out = { per: [], rays: 0, open: 0, inside: 0 }, I = new THREE.Matrix4(), ray = new THREE.Ray(), hit = new THREE.Vector3();
  const CELL = 2;
  for (const { id, meshes } of list) {
    const tris = [];
    for (const m of meshes) {
      m.updateMatrixWorld(true);
      if (m.isInstancedMesh || !m.matrixWorld.equals(I) || !m.geometry?.attributes?.position || m.material.side === THREE.DoubleSide) continue;
      const pos = m.geometry.attributes.position, idx = m.geometry.index, n = idx ? idx.count : pos.count;
      for (let i = 0; i < n; i += 3) {
        const v = [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(pos, idx ? idx.getX(i + k) : i + k));
        const t = new THREE.Triangle(...v);
        if (t.getArea() < 1e-6) continue;
        const nrm = t.getNormal(new THREE.Vector3());
        tris.push({ v, n: nrm, x0: Math.min(v[0].x, v[1].x, v[2].x), x1: Math.max(v[0].x, v[1].x, v[2].x), y0: Math.min(v[0].y, v[1].y, v[2].y), y1: Math.max(v[0].y, v[1].y, v[2].y), z0: Math.min(v[0].z, v[1].z, v[2].z), z1: Math.max(v[0].z, v[1].z, v[2].z) });
      }
    }
    if (!tris.length) continue;
    // the faces a vertical look can meet, bucketed by 2 m cells
    let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
    for (const T of tris) { bx0 = Math.min(bx0, T.x0); bx1 = Math.max(bx1, T.x1); bz0 = Math.min(bz0, T.z0); bz1 = Math.max(bz1, T.z1); }
    const nx = Math.ceil((bx1 - bx0) / CELL) + 1, cells = new Map();
    for (const T of tris) {
      if (Math.abs(T.n.y) < 1e-3) continue;
      for (let i = Math.floor((T.x0 - bx0) / CELL); i <= Math.floor((T.x1 - bx0) / CELL); i++)
        for (let j = Math.floor((T.z0 - bz0) / CELL); j <= Math.floor((T.z1 - bz0) / CELL); j++) {
          const k = j * nx + i;
          if (!cells.has(k)) cells.set(k, []);
          cells.get(k).push(T);
        }
    }
    // the nearest face along dir from p, past `skip` m: { T, d } or null
    const cast = (p, dir, skip, pool) => {
      ray.set(p, dir);
      let best = null;
      for (const T of pool) {
        if (dir.x > 0.5 ? T.x1 < p.x : dir.x < -0.5 ? T.x0 > p.x : p.x < T.x0 - 1e-4 || p.x > T.x1 + 1e-4) continue;
        if (dir.z > 0.5 ? T.z1 < p.z : dir.z < -0.5 ? T.z0 > p.z : p.z < T.z0 - 1e-4 || p.z > T.z1 + 1e-4) continue;
        if (dir.y === 0 && (p.y < T.y0 - 1e-4 || p.y > T.y1 + 1e-4)) continue;
        if (!ray.intersectTriangle(T.v[0], T.v[1], T.v[2], false, hit)) continue;
        const d = hit.distanceTo(p);
        if (d > skip && (!best || d < best.d)) best = { T, d };
      }
      return best;
    };
    const UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0);
    const LEVEL = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)];
    // Going down from p, a face met from behind is a way out of a closed part and one met from the front a way in:
    // more ways out than in and p is inside one (stacked parts and shared tops and bottoms cancel out). Parts open
    // underneath (the resort's slab, a lantern) count as rooms: every level look meets a face from behind.
    const inside = (p, pool) => {
      ray.set(p, DOWN);
      let k = 0;
      for (const T of pool) {
        if (p.x < T.x0 - 1e-4 || p.x > T.x1 + 1e-4 || p.z < T.z0 - 1e-4 || p.z > T.z1 + 1e-4) continue;
        if (ray.intersectTriangle(T.v[0], T.v[1], T.v[2], false, hit) && p.y - hit.y > 1e-3) k += T.n.y < 0 ? 1 : -1;
      }
      if (k > 0) return true;
      return LEVEL.every(d => { const h = cast(p, d, 1e-3, tris); return h && h.T.n.dot(d) > 0; });
    };
    // one look up from (x, z): 'sky', 'seen' (an underside), or the height (m over the ground) of a face seen from behind
    const p = new THREE.Vector3();
    const look = (x, z, pool) => {
      const g = Math.max(W.groundY(x * PX, z * PX), W.SEA_LEVEL);
      p.set(x, g + 1.6, z);
      for (let it = 0; it < 24; it++) {
        const up = cast(p, UP, 1e-3, pool);
        if (!up) return 'sky';
        if (up.T.n.y < 0) return 'seen';
        if (!inside(p, pool)) return p.y + up.d - g;
        out.inside++;
        p.y += up.d + 0.05;
      }
      return 'sky';
    };
    const r = { id, rays: 0, open: 0, eg: [] };
    for (let x = bx0 + 0.13; x <= bx1; x += 0.5) for (let z = bz0 + 0.17; z <= bz1; z += 0.5) {
      const pool = cells.get(Math.floor((z - bz0) / CELL) * nx + Math.floor((x - bx0) / CELL)) || [];
      if (!pool.length) continue;
      let res = look(x, z, pool);
      if (res === 'sky') continue;
      r.rays++;
      // a look that grazes a seam or starts on a part's skin is not a hole: one is see-through only if three looks
      // a few cm round it are too
      if (typeof res === 'number' && [[0.03, 0.02], [-0.02, 0.03], [0.02, -0.03]].some(([u, v]) => typeof look(x + u, z + v, pool) !== 'number')) res = 'seen';
      if (typeof res === 'number') { r.open++; if (r.eg.length < 3) r.eg.push(`(${x.toFixed(1)}, ${z.toFixed(1)}) ${res.toFixed(1)} m up`); }
    }
    out.per.push(r);
    out.rays += r.rays; out.open += r.open;
  }
  return out;
}

// Every foot of a landmark that hangs in the air: the corners along the bottom edge of each wall (a face standing
// within 0.2 of upright; a letter's curved outline has no such edge) and the corners of each face looking down,
// on faces of at least 0.15 m² (not the stair treads, the bulbs and the rods), from 0.1 to 2.5 m over the ground
// (higher up is an overhang: eaves, beams, booms). A foot is held when the ground is within 0.1 m under it, or an
// upward face of its own landmark is under it over the ground (it stands on it, or hangs over it like a bowl over
// its basin), or it is inside one of its parts (straight down, the first face it meets looks down), or it is
// fixed to a part beside it (a face within 0.1 m that reaches further down and does not share this corner).
// Meshes that move (the wheel, its gondolas, the fountain jets) are left out.
function floatingParts(list) {
  const out = { bad: [], points: 0, landmarks: list.length };
  const ray = new THREE.Ray(), hit = new THREE.Vector3(), tri = new THREE.Triangle(), q = new THREE.Vector3(), I = new THREE.Matrix4();
  for (const { id, meshes } of list) {
    const tris = [];
    for (const m of meshes) {
      m.updateMatrixWorld(true);
      if (m.isInstancedMesh || !m.matrixWorld.equals(I) || !m.geometry?.attributes?.position) continue;
      const pos = m.geometry.attributes.position, idx = m.geometry.index, n = idx ? idx.count : pos.count;
      for (let i = 0; i < n; i += 3) {
        const v = [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(pos, idx ? idx.getX(i + k) : i + k));
        const t = new THREE.Triangle(...v), nrm = t.getNormal(new THREE.Vector3()), area = t.getArea();
        if (area < 1e-6) continue;
        tris.push({ v, t, n: nrm, area, lo: Math.min(v[0].y, v[1].y, v[2].y), x0: Math.min(v[0].x, v[1].x, v[2].x), x1: Math.max(v[0].x, v[1].x, v[2].x), z0: Math.min(v[0].z, v[1].z, v[2].z), z1: Math.max(v[0].z, v[1].z, v[2].z) });
      }
    }
    const done = new Set();
    for (const T of tris) {
      if (T.area < 0.15) continue;
      const wall = Math.abs(T.n.y) < 0.2, down = T.n.y < -0.9;
      if (!wall && !down) continue;
      if (wall && T.v.filter(w => w.y < T.lo + 1e-3).length < 2) continue;
      for (const p of T.v) {
        if (wall && p.y > T.lo + 1e-3) continue;
        const key = `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`;
        if (done.has(key)) continue;
        done.add(key);
        if (p.y < W.SEA_LEVEL + 0.05) continue;
        const g = W.groundY(p.x * PX, p.z * PX), gap = p.y - g;
        if (gap <= 0.1 || gap > 2.5) continue;
        out.points++;
        if (!held(p, g, tris)) out.bad.push(`${id}: (${p.x.toFixed(1)}, ${p.y.toFixed(2)}, ${p.z.toFixed(1)}) ${gap.toFixed(2)} m over the ground`);
      }
    }
  }
  return out;

  function held(p, g, tris) {
    ray.set(new THREE.Vector3(p.x, p.y + 0.02, p.z), new THREE.Vector3(0, -1, 0));
    let first = Infinity, firstDown = false;
    for (const U of tris) {
      if (p.x < U.x0 - 1e-4 || p.x > U.x1 + 1e-4 || p.z < U.z0 - 1e-4 || p.z > U.z1 + 1e-4 || Math.abs(U.n.y) < 1e-3) continue;
      if (!ray.intersectTriangle(U.v[0], U.v[1], U.v[2], false, hit)) continue;
      const d = p.y + 0.02 - hit.y;
      if (d < 0.03 && U.n.y < 0) continue;                      // its own underside
      if (U.n.y > 0.3 && hit.y > g - 0.05) return true;         // standing on, or hanging over, a part of its own
      if (d < first) { first = d; firstDown = U.n.y < -0.3; }
    }
    if (firstDown && first < 50) return true;                    // inside a part that goes on down
    for (const U of tris) {
      if (U.lo > p.y - 0.05 || p.x < U.x0 - 0.1 || p.x > U.x1 + 0.1 || p.z < U.z0 - 0.1 || p.z > U.z1 + 0.1) continue;
      if (U.v.some(w => w.distanceToSquared(p) < 1e-6)) continue;
      tri.set(U.v[0], U.v[1], U.v[2]);
      if (tri.closestPointToPoint(p, q).distanceTo(p) <= 0.1) return true;   // fixed to a part beside it
    }
    return false;
  }
}
