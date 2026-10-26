#!/usr/bin/env node
// Stage S3a check (docs/map-v2-stages.json): palms3d.js and scatter3d.js keep their copies in 64 m buckets,
// cast shadows only from copies within 60 m (the near copies are written first and the shadow pass draws just
// those), and scatter3d gains makeStreamScatter.
//   node tools/s3a_scatter_test.mjs [baselineDir]        (S3A_LOW=1 for the Low tier's distances)
// With a baseline copy (argument or $KC_BASELINE), the old and new palm field (the real assets/palms.glb) and
// the old and new scatter (a made-up pack) run side by side over a few hundred camera spots: each mesh must
// draw exactly the same copies (in any order), the palms must cast exactly as before, and the scatter's
// shadow pass must draw exactly the drawn copies within 60 m of the shadow focus. The streamed scatter is
// checked against working out every cell by hand. Every instanced mesh sends the GPU only its drawn copies
// (an update range), and a still camera picks the casting copies again when the shadow focus moves.
// Exits 1 if any check fails.
import { HAVE_BASE, src, base, check, section, note, done, rng } from './s3a_env.mjs';

const THREE = await import('three');
const NEWP = await import(src('src/3d/palms3d.js'));
const NEWS = await import(src('src/3d/scatter3d.js'));
const OLDP = HAVE_BASE ? await import(base('src/3d/palms3d.js')) : null;
const OLDS = HAVE_BASE ? await import(base('src/3d/scatter3d.js')) : null;
const { HIGH } = await import(src('src/3d/quality.js'));
note(`tier: ${HIGH ? 'High' : 'Low'}`);

// the copies a mesh draws (as sorted matrix strings), and the ones its shadow pass draws
const key = (a, i) => Array.from(a.subarray(i * 16, i * 16 + 16)).join(',');
function drawn(m) { const out = []; for (let i = 0; i < m.count; i++) out.push(key(m.instanceMatrix.array, i)); return out.sort(); }
function shadowCount(m) {
  if (!m.castShadow) return 0;
  const all = m.count;
  m.onBeforeShadow(); const n = m.count; m.onAfterShadow();
  return m.count === all ? n : -1;    // -1: count not put back
}
function shadowCopies(m) {
  const n = shadowCount(m), out = [];
  for (let i = 0; i < n; i++) out.push(key(m.instanceMatrix.array, i));
  return out.sort();
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
// only the drawn copies go to the GPU: one update range over the first count copies (none needed at 0)
function ranged(m) {
  const r = m.instanceMatrix.updateRanges;
  return m.count === 0 || (r.length === 1 && r[0].start === 0 && r[0].count === m.count * 16);
}
// µs per update over the given cameras: each version on its own, the best of 5 passes
function timeUpdates(f, cams, focus) {
  let best = Infinity;
  for (let k = 0; k < 5; k++) {
    const t = performance.now();
    for (let i = 0; i < cams.length; i++) f.update(cams[i], 1 + k * 0.01 + i * 1e-4, focus?.[i]);
    best = Math.min(best, performance.now() - t);
  }
  return best / cams.length * 1000;
}

function camera(x, z, yaw, y = 3.5, pitch = -0.12) {
  const c = new THREE.PerspectiveCamera(60, 1440 / 800, 0.15, 2600);
  c.position.set(x, y, z);
  c.rotation.set(pitch, yaw, 0, 'YXZ');
  c.updateMatrixWorld(true);
  return c;
}
// camera spots: a drive around the grid town and its beach, plus random spots and headings
function spots(n, seed, x0, x1, z0, z1) {
  const r = rng(seed), out = [];
  for (let i = 0; i < n; i++) out.push([x0 + r() * (x1 - x0), z0 + r() * (z1 - z0), r() * Math.PI * 2, 2 + r() * 30]);
  return out;
}

section('palms: old vs new');
{
  const r = rng(5), field = [];
  // palms over a grid-town-sized area and its beach (some at negative coordinates), and a far-away row
  for (let i = 0; i < 700; i++) field.push({ x: -40 + r() * 430, z: -40 + r() * 430, y: r() * 0.2, h: 6 + r() * 5, lean: 0.03 + r() * 0.15, rot: r() * 6.28 });
  for (let i = 0; i < 60; i++) field.push({ x: 900 + i * 9, z: 150, y: 0, h: 8, lean: 0.05, rot: i });
  const gNew = new THREE.Group(), gOld = new THREE.Group();
  const fNew = await NEWP.makePalmField(gNew, field);
  const fOld = OLDP ? await OLDP.makePalmField(gOld, field) : null;
  check('same meshes in the same order', !fOld || (gNew.children.length === gOld.children.length && gNew.children.every((m, i) => m.geometry.attributes.position.count === gOld.children[i].geometry.attributes.position.count && m.material.type === gOld.children[i].material.type && m.instanceMatrix.count === gOld.children[i].instanceMatrix.count)));
  let diff = 0, castDiff = 0, frames = 0;
  const views = [...spots(300, 9, -60, 420, -60, 420), ...spots(40, 10, 600, 1500, 0, 300)];
  for (const [x, z, yaw, y] of views) {
    const cam = camera(x, z, yaw, y);
    fNew.update(cam, 1);
    if (!fOld) continue;
    fOld.update(cam, 1);
    frames++;
    gNew.children.forEach((m, i) => {
      const o = gOld.children[i];
      if (m.count !== o.count || !same(drawn(m), drawn(o))) diff++;
      // the old palms cast with every drawn copy of a casting mesh
      if (shadowCount(m) !== (o.castShadow ? o.count : 0) || !same(shadowCopies(m), o.castShadow ? drawn(o) : [])) castDiff++;
    });
  }
  if (fOld) {
    const cams = views.map(([x, z, yaw, y]) => camera(x, z, yaw, y));
    note(`${frames} views; update ${timeUpdates(fNew, cams).toFixed(1)} µs new, ${timeUpdates(fOld, cams).toFixed(1)} µs old`);
    check('palms: every mesh draws exactly the old copies', diff === 0, `${diff} mesh-views differ`);
    check('palms: shadows exactly as before (only the detailed palms, within HI_DIST)', castDiff === 0, `${castDiff} differ`);
  } else note('no baseline - skipped the old/new palm comparison');
  const st = fNew.stats();
  check('palms: stats()', st.palms === field.length && st.drawn >= 0 && st.casting <= st.drawn);
  fNew.update(camera(200, 200, 0.5, 4), 2);       // in the middle of the town
  check('upload: each palm mesh sends just its drawn copies', gNew.children.every(ranged) && gNew.children.some(m => m.count > 0));

  // castR 60: the light palms within 60 m of the focus cast too, and only those; the count is put back
  const g60 = new THREE.Group(), f60 = await NEWP.makePalmField(g60, field, { castR: 60 });
  let wrong = 0, any = 0;
  for (const [x, z, yaw, y] of spots(120, 12, -60, 420, -60, 420)) {
    const cam = camera(x, z, yaw, y), focus = { x: x + 6 * Math.sin(yaw), z: z - 6 * Math.cos(yaw) };
    f60.update(cam, 1, focus);
    const lo = g60.children.filter((m, i) => i === 1 || i >= 5);       // trunkLo, then the three light crowns
    for (const m of lo) {
      const n = shadowCount(m);
      if (n < 0) { wrong++; continue; }
      any += n;
      for (let i = 0; i < m.count; i++) {
        const e = m.instanceMatrix.array, px = e[i * 16 + 12], pz = e[i * 16 + 14];
        // trunks stand on their spot; crowns sit at most ~4 m off it (the bend and lean)
        const d = Math.hypot(px - focus.x, pz - focus.z), slack = m === g60.children[1] ? 0.01 : 4.5;
        if (i < n && d > 60 + slack) wrong++;
        if (i >= n && d < 60 - slack) wrong++;
      }
    }
  }
  check('castR 60: light palms cast only within 60 m, and all of those do', wrong === 0 && any > 0, `${wrong} wrong, ${any} casting`);
}

// ---------- a made-up asset pack ----------

function fakePack() {
  const r = rng(21), pack = new Map();
  const part = (geo, cutout) => ({
    geometry: geo, material: new THREE.MeshStandardMaterial({ alphaTest: cutout ? 0.5 : 0 }),
    matrix: new THREE.Matrix4().compose(new THREE.Vector3(r() - 0.5, r(), r() - 0.5), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6), new THREE.Vector3(1, 1 + r(), 1)),
    cutout,
  });
  pack.set('Grass', { parts: [part(new THREE.BoxGeometry(0.3, 0.4, 0.3), true), part(new THREE.BoxGeometry(0.2, 0.3, 0.2), false)], radius: 0.4 });
  pack.set('Bush', { parts: [part(new THREE.SphereGeometry(0.8, 6, 4), true)], radius: 0.9 });
  pack.set('Rock', { parts: [part(new THREE.DodecahedronGeometry(0.5), false)], radius: 0.6 });
  pack.set('Tree', { parts: [part(new THREE.CylinderGeometry(0.2, 0.3, 4, 6), false), part(new THREE.SphereGeometry(2.5, 6, 4), true)], radius: 4 });
  pack.set('Light', { parts: [part(new THREE.BoxGeometry(0.2, 4, 0.2), false), part(new THREE.BoxGeometry(0.5, 1, 0.5), false), part(new THREE.BoxGeometry(0.4, 0.4, 0.4), false)], radius: 2.6 });
  return pack;
}
const OPTS = {
  Grass: { far: 48 }, Bush: { far: 140, shadow: true }, Rock: { far: 140, shadow: true },
  Tree: { far: 260, shadow: true }, Light: { far: 160, shadow: true },
};
const NAMES = ['Grass', 'Grass', 'Grass', 'Grass', 'Bush', 'Rock', 'Tree', 'Light', 'Missing'];

section('scatter: old vs new');
{
  const pack = fakePack(), r = rng(31), list = [];
  for (let i = 0; i < 12000; i++) list.push({ name: NAMES[Math.floor(r() * NAMES.length)], x: -60 + r() * 480, y: r() * 0.3, z: -60 + r() * 480, rot: r() * 6.28, s: 0.4 + r() * 0.8 });
  const gNew = new THREE.Group(), gOld = new THREE.Group();
  const sNew = NEWS.makeScatter(gNew, pack, list, OPTS);
  const sOld = OLDS ? OLDS.makeScatter(gOld, pack, list, OPTS) : null;
  check('same meshes in the same order', !sOld || (gNew.children.length === gOld.children.length && gNew.children.every((m, i) => m.geometry === gOld.children[i].geometry && m.material === gOld.children[i].material && m.instanceMatrix.count === gOld.children[i].instanceMatrix.count && m.receiveShadow === gOld.children[i].receiveShadow && !!m.userData.noAO === !!gOld.children[i].userData.noAO)));
  let diff = 0, castWrong = 0, frames = 0, casting = 0, uncast = 0;
  const views = [...spots(250, 33, -80, 440, -80, 440), ...spots(30, 34, 700, 1600, 0, 400)];
  for (const [x, z, yaw, y] of views) {
    const cam = camera(x, z, yaw, y), focus = { x: x + 7 * Math.sin(yaw), z: z - 7 * Math.cos(yaw) };
    sNew.update(cam, 1, focus);
    if (!sOld) continue;
    sOld.update(cam, 1);
    frames++;
    gNew.children.forEach((m, i) => {
      const o = gOld.children[i], dn = drawn(m);
      if (m.count !== o.count || !same(dn, drawn(o))) diff++;
      // the shadow pass draws exactly the drawn copies within 60 m of the focus (by the copy's spot)
      const n = shadowCount(m);
      if (n < 0) { castWrong++; return; }
      if (!o.castShadow) { if (n !== 0) castWrong++; return; }
      casting += n; uncast += m.count - n;
    });
  }
  // the 60 m test is on the copy's spot, which the part matrix moves a little: check it with the spots
  const byKey = new Map();
  for (const s of list) byKey.set(`${s.name}:${s.x},${s.z}`, s);
  let near = 0;
  {
    const [x, z, yaw, y] = [180, 180, 0.7, 4];
    const cam = camera(x, z, yaw, y), focus = { x: 175, z: 190 };
    sNew.update(cam, 2, focus);
    const st = sNew.stats();
    for (const [name, [d, c]] of Object.entries(st.by)) if (OPTS[name]?.shadow) near += c; else if (c) castWrong++;
    // brute force: drawn copies of casting kinds within 60 m of the focus
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    let want = 0;
    for (const s of list) {
      const o = OPTS[s.name];
      if (!o || !o.shadow || !pack.has(s.name)) continue;
      const far = o.far * (HIGH ? 1 : 0.6), rad = pack.get(s.name).radius * s.s;
      if ((s.x - x) ** 2 + (s.z - z) ** 2 > far * far) continue;
      if (!frustum.intersectsSphere(new THREE.Sphere(new THREE.Vector3(s.x, s.y + rad * 0.5, s.z), rad + 2))) continue;
      if ((s.x - focus.x) ** 2 + (s.z - focus.z) ** 2 <= 60 * 60) want++;
    }
    check('scatter: the shadow pass draws exactly the copies within 60 m of the focus', near === want, `${near} cast, ${want} expected`);
  }
  if (sOld) {
    const cams = views.map(([x, z, yaw, y]) => camera(x, z, yaw, y));
    note(`${frames} views; shadow copies ${casting} (was ${casting + uncast}); update ${timeUpdates(sNew, cams).toFixed(1)} µs new, ${timeUpdates(sOld, cams).toFixed(1)} µs old`);
    check('scatter: every mesh draws exactly the old copies', diff === 0, `${diff} mesh-views differ`);
    check('scatter: non-casting kinds never cast, counts put back after the shadow pass', castWrong === 0, `${castWrong}`);
    check('scatter: the shadow pass draws fewer copies than before', uncast > 0);
  } else note('no baseline - skipped the old/new scatter comparison');

  // with no focus given, the sun's target in the group's scene is the focus
  const scene = new THREE.Scene(), g2 = new THREE.Group(), sun = new THREE.DirectionalLight();
  sun.castShadow = true; scene.add(sun, sun.target, g2);
  const s2 = NEWS.makeScatter(g2, pack, list, OPTS);
  sun.target.position.set(100, 0, 100);
  s2.update(camera(100, 120, 0, 4), 1);
  const a = s2.stats().casting;
  sun.target.position.set(400, 0, 400);
  s2.update(camera(100, 125, 0, 4), 1);
  const b = s2.stats().casting;
  check('scatter: the shadow focus follows the sun\'s target', a > 0 && b === 0, `${a}, ${b}`);

  // a camera that stays put while the focus moves (a photo or fixed camera): the casters are picked again
  const still = camera(100, 120, 0, 4);
  sun.target.position.set(100, 0, 100);
  s2.update(still, 1);
  const c1 = s2.stats().casting;
  sun.target.position.set(400, 0, 400);
  s2.update(still, 1);
  const c2 = s2.stats().casting;
  sun.target.position.set(100, 0, 100);
  s2.update(still, 1);
  check('scatter: a still camera picks the casters again when the focus moves', c1 > 0 && c2 === 0 && s2.stats().casting === c1, `${c1}, ${c2}, ${s2.stats().casting}`);
  check('upload: each scatter mesh sends just its drawn copies', gNew.children.every(ranged) && g2.children.every(ranged) && g2.children.some(m => m.count > 0));
}

section('makeStreamScatter');
{
  const pack = fakePack();
  // a cell's spots: the same for the same cell, every time
  let genCalls = 0;
  const gen = (cx, cz) => {
    genCalls++;
    const r = rng(1 + (cx + 1000) * 7919 + (cz + 1000) * 104729), out = [];
    const n = 30 + Math.floor(r() * 40);
    for (let i = 0; i < n; i++) out.push({ name: NAMES[Math.floor(r() * NAMES.length)], x: cx * 64 + r() * 64, y: 0, z: cz * 64 + r() * 64, rot: r() * 6.28, s: 0.5 + r() * 0.6 });
    return out;
  };
  const FAR = HIGH ? 140 : 70;
  const kinds = { Grass: { far: 48 }, Bush: { shadow: true }, Rock: { shadow: true }, Tree: { far: 260, shadow: true }, Light: { far: 160, shadow: true } };
  const g = new THREE.Group();
  const S = NEWS.makeStreamScatter(g, pack, { capacity: 4000, gen, kinds });
  const brute = (cam, focus) => {
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const out = {}, cast = {};
    const x = cam.position.x, z = cam.position.z;
    for (let j = Math.floor((z - FAR) / 64); j <= Math.floor((z + FAR) / 64); j++) for (let i = Math.floor((x - FAR) / 64); i <= Math.floor((x + FAR) / 64); i++) {
      const dx = Math.max(i * 64 - x, 0, x - i * 64 - 64), dz = Math.max(j * 64 - z, 0, z - j * 64 - 64);
      if (Math.hypot(dx, dz) > FAR) continue;
      for (const s of gen(i, j)) {
        if (!pack.has(s.name)) continue;
        const o = kinds[s.name] || {}, far = Math.min(FAR, o.far != null ? o.far * (HIGH ? 1 : 0.6) : FAR), rad = pack.get(s.name).radius * s.s;
        if ((s.x - x) ** 2 + (s.z - z) ** 2 > far * far) continue;
        if (!frustum.intersectsSphere(new THREE.Sphere(new THREE.Vector3(s.x, s.y + rad * 0.5, s.z), rad + 2))) continue;
        out[s.name] = (out[s.name] || 0) + 1;
        if (o.shadow && (s.x - focus.x) ** 2 + (s.z - focus.z) ** 2 <= 3600) cast[s.name] = (cast[s.name] || 0) + 1;
      }
    }
    return { out, cast };
  };
  // a drive of 2 km, one update a frame; every 20 frames compare with working it all out
  let wrong = 0, compared = 0, maxCells = 0, maxGen = 0;
  const r = rng(41);
  let x = 100, z = 100, yaw = 0.3;
  for (let f = 0; f < 2400; f++) {
    yaw += (r() - 0.5) * 0.05;
    x += Math.cos(yaw) * 1.0; z += Math.sin(yaw) * 1.0;
    const cam = camera(x, z, -yaw - Math.PI / 2, 4), focus = { x, z };
    const before = genCalls;
    S.update(cam, f / 60, focus);
    if (f > 0) maxGen = Math.max(maxGen, genCalls - before);
    maxCells = Math.max(maxCells, S.stats().cells);
    if (f % 20 !== 0) continue;
    // for an exact comparison: a camera 1.5 m aside (the copies are picked again once it moves 1 m), and
    // enough frames for the new cells (made 1 ms a frame) to be there
    const cam2 = camera(x + 1.5, z, -yaw - Math.PI / 2, 4);
    for (let k = 0; k < 50; k++) S.update(cam2, f / 60, focus);
    const st = S.stats(), bf = brute(cam2, focus);
    compared++;
    for (const name of ['Grass', 'Bush', 'Rock', 'Tree', 'Light']) {
      const [d, c] = st.by[name] || [0, 0];
      if (d !== (bf.out[name] || 0) || c !== (bf.cast[name] || 0)) { wrong++; if (wrong < 4) note(`frame ${f} ${name}: drawn ${d}/${bf.out[name] || 0}, cast ${c}/${bf.cast[name] || 0}`); }
    }
  }
  const st = S.stats();
  note(`${compared} comparisons; cells made ${st.made}, dropped ${st.dropped}, at most ${maxCells} held; at most ${maxGen} made in a frame`);
  check('stream: draws and casts exactly what working every cell out gives', wrong === 0, `${wrong} differ`);
  check('stream: far cells are let go', st.dropped > 0 && maxCells <= Math.ceil(((FAR + 64) * 2 / 64 + 2) ** 2));
  check('stream: casters only for kinds that cast', !st.by.Grass || st.by.Grass[1] === 0);
  check('stream: unknown models are skipped', !('Missing' in st.by));
  const full = g.children.filter(m => m.count > 0);
  check('upload: stream meshes send just their drawn copies, not all 4000 slots', g.children.every(ranged) && full.length > 0 && full.every(m => m.instanceMatrix.updateRanges[0].count < m.instanceMatrix.array.length));

  // capacity: with room for 10 trees (3 on Low) and 25 of everything else, the trees kept are those of the
  // nearest cells. The tree here is one part with no offset, so a copy's matrix sits right on its spot.
  const CAP = HIGH ? 10 : 3;
  const idPack = new Map([['Tree', { parts: [{ geometry: new THREE.SphereGeometry(1, 6, 4), material: new THREE.MeshStandardMaterial(), matrix: new THREE.Matrix4(), cutout: false }], radius: 4 }], ['Bush', pack.get('Bush')]]);
  const g2 = new THREE.Group(), S2 = NEWS.makeStreamScatter(g2, idPack, { capacity: { default: 25, Tree: CAP }, gen, kinds });
  const cam = camera(500, 500, 0.4, 6);
  S2.update(cam, 0, { x: 500, z: 500 });
  const st2 = S2.stats();
  check('capacity: no kind draws more than its room', st2.by.Tree[0] <= CAP && st2.by.Bush[0] <= 25, JSON.stringify(st2.by));
  const cellD = (px, pz) => { const i = Math.floor(px / 64), j = Math.floor(pz / 64); return Math.hypot(Math.max(i * 64 - 500, 0, 500 - i * 64 - 64), Math.max(j * 64 - 500, 0, 500 - j * 64 - 64)); };
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  const visible = [];
  for (let j = 0; j < 20; j++) for (let i = 0; i < 20; i++) for (const s of gen(i, j)) {
    if (s.name !== 'Tree' || (s.x - 500) ** 2 + (s.z - 500) ** 2 > FAR * FAR) continue;
    if (cellD(s.x, s.z) > FAR) continue;
    if (frustum.intersectsSphere(new THREE.Sphere(new THREE.Vector3(s.x, s.y + 4 * s.s * 0.5, s.z), 4 * s.s + 2))) visible.push(cellD(s.x, s.z));
  }
  visible.sort((a, b) => a - b);
  const tree = g2.children.find(m => m.geometry === idPack.get('Tree').parts[0].geometry);
  let farthestKept = 0;
  for (let i = 0; i < tree.count; i++) farthestKept = Math.max(farthestKept, cellD(tree.instanceMatrix.array[i * 16 + 12], tree.instanceMatrix.array[i * 16 + 14]));
  check('capacity: the trees kept are the nearest cells\' ones', visible.length > CAP && tree.count === CAP && farthestKept <= visible[CAP - 1] + 1e-6, `${visible.length} visible, kept ${tree.count} up to ${farthestKept.toFixed(0)} m, nearest ${CAP} up to ${visible[CAP - 1]?.toFixed(0)} m`);

  // the first frame makes every cell in range at once; later frames keep to the time budget
  const g3 = new THREE.Group();
  let calls = 0;
  const slowGen = (cx, cz) => { calls++; const t = performance.now(); while (performance.now() - t < 2) { /* work */ } return gen(cx, cz); };
  const S3 = NEWS.makeStreamScatter(g3, pack, { gen: slowGen, kinds });
  S3.update(camera(0, 0, 0, 4), 0);
  const first = calls;
  S3.update(camera(FAR + 60, 0, 0, 4), 0);        // some cells still in range, some new ones
  check('budget: all cells in range on the first frame, then one at a time', first > 5 && calls - first === 1, `${first}, then ${calls - first}`);

  S.dispose();
  check('dispose(): meshes out of the group', g.children.length === 0);
}

done();
