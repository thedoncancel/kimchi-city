#!/usr/bin/env node
// Stage P4 check (night and the villa), built in node.
//   node tools/p4_test.mjs            (S3B_LOW=1 for the phone tier, which also checks the night exposure)
//  1. The villa's pool (prefabs.js VILLA_POOL): the SURF's WATER cells are the pool's (their centres inside its
//     rim, every cell more than 0.75 m in), so Kimchi (main3d's 0.5 m body, entities.circleBlocked) is stopped by
//     the water only: walking straight at the pool from anywhere round it, his feet stop between 0.15 m over the
//     water (0.5 m right by a corner, where the cells' steps let his body in) and 1.35 m short of it, about half
//     a metre mostly (his body's edge at the water), never at a wall in front of it. He starts clear of it. He walks from the door's foot spot round the pool to the garage court and to the terrace's
//     front edge. The loungers face the water.
//  2. props3d draws it: the water quad on the rim at 0.12 m over the pad, the deck's top where Kimchi's feet are
//     (groundY on the terrace), the night glow of the underwater lights.
//  3. The landmarks' solid parts (prefabs.js landmarkSolids, applyLandmarkSolids, run by landmarks3d): every
//     landmark the lead named (the tower's base, the letters, the lighthouse, the cranes, the Ferris wheel, the
//     arch) and the rest stop feet and cars where they are solid and leave open what is open (between the
//     letters, under the cranes' portals, the road under the arch and the gate, the Ferris wheel's slab for
//     people); OCC stands at their tops, so the camera, bullets and sight lines stop at them too. Stamping is
//     idempotent and leaves every jar, photo spot, place spot, parked car, traffic lane and sidewalk path as
//     reachable as it was.
//  4. Night (sky.js): v2's sky fill turns a moonlit blue and stronger, the moon brighter, the haze blue; by day
//     nothing changes. On the phone tier the exposure opens up after dark and comes back by day.
//  5. K-Town's heart is lit: lamps all round the ring's inner pavement and along Fountain Park's paths (world
//     data, prefabs.js park_circle), Neon Alley's festoon bulbs, lanterns and pink pools (props3d).
// Exits 1 if any check fails.
import { src, check, section, note, done, quiet } from './s3b_env.mjs';
globalThis.KC_WORLD = 'v2';
const THREE = await import('three');
const W = await import(src('src/world.js'));
W.generate();
const PF = await import(src('src/map/prefabs.js'));
const MD = await import(src('src/map/mapdata.js'));
const { makeChunkManager } = await import(src('src/3d/chunks.js'));
const PX = 16, LOW = process.env.S3B_LOW === '1';

// Kimchi's body as entities.js tests it: 8 points 0.5 m round (x, z − 0.25) m (main3d's playerR 8 px)
const R = 0.5;
const bodyBlocked = (x, z) => {
  for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; if (W.blockedFootPx((x + Math.cos(a) * R) * PX, (z - 0.25 + Math.sin(a) * R) * PX)) return true; }
  return false;
};
const surfHash = () => { let h = 0x811c9dc5; const d = W.grids.surf; for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 0x01000193); } return h >>> 0; };

// ---------- 1. the villa's pool, as world data ----------
section('the villa pool in the world (SURF)');
const home = W.places.home, door = { x: home.door.x / PX, z: home.door.y / PX, a: home.door.a };
const { F, a } = PF.villaFrame(door), P = PF.VILLA_POOL, TR = PF.VILLA_TERRACE;
check('villaFrame finds the villa from its door', Math.hypot(F[0] - MD.PLACES.home.F[0], F[1] - MD.PLACES.home.F[1]) < 1e-6 && Math.abs(a - MD.PLACES.home.a) < 1e-9, `${F} ${a}`);
const s = Math.sin(a), c = Math.cos(a);
const toLocal = (x, z) => [(x - F[0]) * s - (z - F[1]) * c + 20, (x - F[0]) * c + (z - F[1]) * s + 40];
const toW = (lx, lz) => PF.toWorld(F, a, lx, lz);
const beyond = (lx, lz) => Math.max(P.x0 - lx, lx - P.x1, P.z0 - lz, lz - P.z1);     // > 0 outside the rim, m
{
  let outside = 0, deepDry = 0, cells = 0;
  for (let z = Math.floor(F[1] - 60); z < F[1] + 60; z++) for (let x = Math.floor(F[0] - 60); x < F[0] + 60; x++) {
    const [lx, lz] = toLocal(x + 0.5, z + 0.5), k = W.surfaceAt((x + 0.5) * PX, (z + 0.5) * PX), b = beyond(lx, lz);
    if (lx < -2 || lx > 30 || lz < 18 || lz > 38) continue;
    if (k === W.WATER) { cells++; if (b > 0) outside++; }
    else if (b < -0.75) deepDry++;
  }
  check('every WATER cell of the terrace lies inside the pool\'s rim', cells > 120 && outside === 0, `${cells} cells, ${outside} outside`);
  check('the water covers the pool', deepDry === 0, `${deepDry} dry cells more than 0.75 m inside the rim`);
}
{
  // walk straight at the water from 2.2 m out, every 0.25 m round the rim: where do Kimchi's feet stop?
  const feet = [];
  let stuck = 0;
  const rimPts = [];
  for (let u = P.x0 + 0.25; u < P.x1; u += 0.25) rimPts.push([u, P.z0, 0, -1], [u, P.z1, 0, 1]);
  for (let v = P.z0 + 0.25; v < P.z1; v += 0.25) rimPts.push([P.x0, v, -1, 0], [P.x1, v, 1, 0]);
  for (const [lx, lz, nx, nz] of rimPts) {
    let d = 2.2, ok = false;
    if (bodyBlocked(...toW(lx + nx * d, lz + nz * d))) { stuck++; continue; }
    for (; d > -3; d -= 0.02) if (bodyBlocked(...toW(lx + nx * (d - 0.02), lz + nz * (d - 0.02)))) { ok = true; break; }
    if (ok) feet.push(d); else stuck++;
  }
  feet.sort((p, q) => p - q);
  const pct = (f) => feet[Math.floor(f * (feet.length - 1))];
  note(`${feet.length} approaches: the feet stop ${pct(0).toFixed(2)} to ${pct(1).toFixed(2)} m short of the water (median ${pct(0.5).toFixed(2)})`);
  check('walking at the pool from any side, Kimchi stops at the water (feet 0.15 m over it, 0.5 at a corner, to 1.35 m short)',
    stuck === 0 && pct(0) >= -0.5 && pct(0.03) >= -0.15 && pct(1) <= 1.35 && pct(0.5) > 0.3 && pct(0.5) < 0.9, `${stuck} never stopped, from ${pct(0)?.toFixed(2)} to ${pct(1)?.toFixed(2)}`);
}
{
  // a 0.5 m lattice walk (Kimchi's body) from the foot spot
  const reach = (x0, z0, goals, lim = 80) => {
    const step = 0.5, key = (i, j) => i * 100000 + j, seen = new Set([key(0, 0)]), q = [[0, 0]];
    while (q.length) {
      const [i, j] = q.shift(), x = x0 + i * step, z = z0 + j * step;
      if (goals.some(([gx, gz]) => Math.hypot(gx - x, gz - z) < 0.8)) return true;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj, k = key(ni, nj);
        if (seen.has(k) || Math.abs(ni * step) > lim || Math.abs(nj * step) > lim) continue;
        seen.add(k);
        if (!bodyBlocked(x0 + ni * step, z0 + nj * step)) q.push([ni, nj]);
      }
    }
    return false;
  };
  const foot = [home.foot.x / PX, home.foot.y / PX];
  check('Kimchi stands free on the villa\'s foot spot', !bodyBlocked(...foot));
  check('he walks from the foot spot round the pool to the garage court', reach(...foot, [[home.garage[0].x / PX, home.garage[0].y / PX]]));
  const photo = W.photoSpots.find(q => q.id === 'villa');
  check('and to the terrace\'s front edge (the villa photo spot)', reach(...foot, [[photo.x / PX, photo.y / PX]]));
}
{
  const loungers = W.deco.filter(d => d.kind === 'lounger' && Math.hypot(d.x / PX - F[0], d.y / PX - F[1]) < 40);
  const face = loungers.filter(d => { const [lx, lz] = toLocal(d.x / PX, d.y / PX), dir = Math.cos(d.a - a); return lz > P.z1 && lz < TR.z1 && lx > P.x0 && lx < P.x1 && dir < -0.999; });
  check('three loungers on the deck in front of the pool, their foot ends to the water', loungers.length === 3 && face.length === 3, `${face.length} of ${loungers.length}`);
}

// ---------- 2. props3d draws it ----------
section('props3d: the terrace and the pool water');
const P3 = await import(src('src/3d/props3d.js'));
const city = new THREE.Group(), chunks = makeChunkManager(city, { castR: 110 });
const props = await quiet(() => P3.buildProps3D(W, chunks));
const named = (n) => { let m = null; city.traverse((o) => { if (o.name === n) m = o; }); return m; };
const water = named('villa pool water'), deck = named('villa terrace deck'), coping = named('villa pool coping');
check('the terrace is built: deck, coping and water', !!(props?.stats().terrace && water && deck && coping));
const pad = W.groundY(...toW(14, 28).map(v => v * PX));
if (water) {
  water.updateMatrixWorld(true);
  const pos = water.geometry.attributes.position, v = new THREE.Vector3(), corners = [];
  for (let i = 0; i < pos.count; i++) corners.push(v.fromBufferAttribute(pos, i).applyMatrix4(water.matrixWorld).clone());
  const want = [[P.x0, P.z0], [P.x1, P.z0], [P.x0, P.z1], [P.x1, P.z1]].map(([lx, lz]) => toW(lx, lz));
  const off = Math.max(...want.map(([x, z]) => Math.min(...corners.map(q => Math.hypot(q.x - x, q.z - z)))));
  check('the water fills the rim, 0.12 m over the pad', off < 0.01 && corners.every(q => Math.abs(q.y - pad - 0.12) < 0.005), `corner off ${off.toFixed(3)} m, y ${corners[0].y.toFixed(3)} over ${pad.toFixed(3)}`);
  check('the water has its look (poolTiles, the shader, the camera in its frame)', !!water.material.userData.pool?.tPool.value && typeof water.material.onBeforeCompile === 'function');
}
if (deck) {
  // the deck's top under 30 points of the terrace off the pool, against where Kimchi's feet are
  const ray = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0);
  deck.updateMatrixWorld(true);
  let bad = 0, n = 0, worst = 0;
  for (let k = 0; k < 30; k++) {
    const lx = TR.x0 + 0.5 + ((k * 7.3) % (TR.x1 - TR.x0 - 1)), lz = TR.z0 + 0.5 + ((k * 3.7) % (TR.z1 - TR.z0 - 1));
    if (beyond(lx, lz) < 0.7) continue;
    const [x, z] = toW(lx, lz), hit = (ray.set(new THREE.Vector3(x, pad + 5, z), down), ray.intersectObject(deck)[0]);
    n++;
    const dy = hit ? hit.point.y - W.groundY(x * PX, z * PX) : 9;
    worst = Math.max(worst, Math.abs(dy));
    if (Math.abs(dy) > 0.01) bad++;
  }
  check('the deck\'s top is where Kimchi walks (groundY on the terrace, within 1 cm)', n >= 12 && bad === 0, `${bad} of ${n} off, worst ${worst.toFixed(3)} m`);
}
if (water) {
  const cam = new THREE.PerspectiveCamera(62, 1.8, 0.15, 2600);
  cam.position.set(...[...toW(14, 22)].flatMap((v, i) => i ? [pad + 1.7, v] : [v]));
  cam.updateMatrixWorld(true);
  props.update(cam, 1, 0);
  const day = water.material.emissiveIntensity;
  props.update(cam, 2, 1);
  const eye = water.material.userData.pool.uPoolEye.value;
  check('the underwater lights come on after dark', day === 0 && water.material.emissiveIntensity > 0.5, `${day} by day, ${water.material.emissiveIntensity} at night`);
  const behind = (P.z0 + P.z1) / 2 - 22;
  check('the shader sees the camera in the pool\'s frame (1.58 m over the water, over the deck behind the middle)', Math.abs(eye.y - 1.58) < 0.01 && Math.abs(eye.z + behind) < 0.01 && Math.abs(eye.x) < 0.01, `(${eye.x.toFixed(2)}, ${eye.y.toFixed(2)}, ${eye.z.toFixed(2)})`);
  props.update(cam, 3, 0);
}

// ---------- 3. the landmarks' solid parts ----------
section('the landmarks are solid (prefabs.js landmarkSolids, applyLandmarkSolids)');
// what was blocked before landmarks3d stamps them: every spot and path that must stay reachable
const spots = [...W.jarSpots.map(j => ['jar ' + j.id, j.x, j.y]), ...W.photoSpots.map(q => ['photo ' + q.id, q.x, q.y]),
  ...Object.values(W.places).flatMap(pl => ['door', 'foot', 'curb', 'giver', 'hangout'].filter(k => pl[k]).map(k => [`${pl.key} ${k}`, pl[k].x, pl[k].y])),
  ...W.parkedSpawns.map((q, i) => ['parked ' + i, q.x, q.y])];
const footBefore = spots.map(([, x, y]) => W.blockedFootPx(x, y));
const lanePts = [];
for (const L of W.roads.lanes) for (let i = 0; i < L.x.length; i++) lanePts.push([L.x[i], L.y[i], W.blockedCarPx(L.x[i], L.y[i])]);
const walkPts = [];
for (const w of W.roads.walks.paths) for (let i = 0; i + 1 < w.pts.length; i += 2) walkPts.push([w.pts[i], w.pts[i + 1], W.blockedFootPx(w.pts[i], w.pts[i + 1])]);
const LM = await import(src('src/3d/landmarks3d.js'));
const before = surfHash();
const marks = await quiet(() => LM.buildLandmarks(W, city, chunks));
const parts = W.grids.landmarkSolids;
check('landmarks3d stamps the solid parts into the world', !!marks && Array.isArray(parts) && parts.length > 30 && surfHash() !== before, `${parts?.length} parts`);
const after = surfHash();
check('stamping again changes nothing', PF.applyLandmarkSolids(W) === parts && surfHash() === after);
const byId = Object.fromEntries(W.landmarks.map(L => [L.id, L]));
const at = (L, u, v, a2 = L.a) => [L.x + u * Math.cos(a2) - v * Math.sin(a2), L.z + u * Math.sin(a2) + v * Math.cos(a2)];
const occAt = (x, z) => { const [w] = W.grids.dims.occ; return W.grids.occ[Math.floor(z / 2) * w + Math.floor(x / 2)]; };
const solid = (name, [x, z], top = 0) => {
  const f = W.blockedFootPx(x * PX, z * PX), cr = W.blockedCarPx(x * PX, z * PX), o = occAt(x, z);
  check(`${name} stops feet and cars${top ? ` and stands ${top} m high in OCC` : ''}`, f && cr && o >= top, `foot ${f} car ${cr} occ ${o}`);
};
const open = (name, [x, z], { car = true, foot = true } = {}) => {
  const f = W.blockedFootPx(x * PX, z * PX), cr = W.blockedCarPx(x * PX, z * PX);
  check(`${name} is open`, (!foot || !f) && (!car || !cr), `foot ${f} car ${cr}`);
};
{
  const T = byId.kimchi_tower;
  for (const [u, v] of [[-15, -15], [15, 15], [0, 15], [-15, 0]]) solid(`Kimchi Tower's base (${u}, ${v})`, at(T, u, v), 130);
  const K = byId.kimchi_letters, spans = PF.letterSpans(K);
  for (const sp of spans) solid(`the letter ${sp.c} at z ${sp.z0.toFixed(1)}`, at(K, 0.05, sp.z0 - sp.w / 2), Math.floor(K.base + 15));
  for (let i = 0; i + 1 < spans.length; i++) open(`the gap after letter ${i + 1}`, at(K, 0.05, (spans[i].z0 - spans[i].w + spans[i + 1].z0) / 2));
  const Lh = byId.lighthouse;
  solid('the lighthouse', [Lh.x, Lh.z], Math.floor(Lh.base + 28));
  const cs = PF.cottageSpot(W, Lh);
  if (cs) solid('the keeper\'s cottage', [cs.x, cs.z], Math.floor(cs.hi + 4));
  for (const C of W.landmarks.filter(q => q.kind === 'crane')) {
    solid(`${C.id}'s land-side legs`, at(C, -12, 0), Math.floor(C.base + 25));
    solid(`${C.id}'s water-side legs`, at(C, 6, 7.5), Math.floor(C.base + 25));
    open(`the way under ${C.id}'s portal`, at(C, -3, 0));
  }
  const Fw = byId.ferris_wheel;
  solid('the Ferris wheel\'s gondola path', at(Fw, 0, 0), Math.floor(Fw.base + 40));
  solid('a Ferris wheel leg', at(Fw, -4.8, 13));
  open('the Ferris wheel\'s boarding slab, for people', at(Fw, 4, -10), { car: false });
  check('the Ferris wheel\'s slab keeps cars off', W.blockedCarPx(...at(Fw, 4, -10).map(v => v * PX)));
  const A = byId.fest_arch, sa = PF.spanFrame(W.roads, A);
  for (const sd of [-1, 1]) solid(`the Fest arch's ${sd < 0 ? 'left' : 'right'} column`, at(A, 0, sd * (A.span / 2), sa.a), Math.floor(A.base + 11));
  open('Festival Way under the arch', [A.x, A.z]);
  const G = byId.ktown_gate, sg = PF.spanFrame(W.roads, G);
  for (const sd of [-1, 1]) solid(`a K-Town gate pillar (${sd})`, at(G, 1.3, sd * (G.span / 2), sg.a), Math.floor(sg.y + 9));
  open('Seoul Avenue under the gate', [G.x, G.z]);
  solid('the festival stage', at(byId.fest_stage, -1, 0), Math.floor(byId.fest_stage.base + 12));
  solid('the control tower', at(byId.control_tower, 0, 0), Math.floor(byId.control_tower.base + 20));
  solid('a Glades lookout leg', at(byId.glades_tower, 2.76, 2.76));
  open('under the Glades lookout, on foot', at(byId.glades_tower, 0, 0), { car: false });
  const bf = PF.clearSpot(W, byId.bayfront_fountain.x, byId.bayfront_fountain.z, 9);
  solid('the Bayfront fountain', [bf.x, bf.z]);
  const pf = W.deco.find(d => d.kind === 'fountain');
  solid('Fountain Park\'s fountain', [pf.x / PX, pf.y / PX]);
  const Rs = byId.deco_resort, Rc = PF.RESORT;
  solid('the curved resort\'s slab', [Rs.x + Rc.Rc - Rc.west - (Rc.Rc - Rc.depth / 2), Rs.z], Math.floor(Rs.base + 55));
  solid('the resort\'s podium', [Rs.x + Rc.Rc - Rc.west - (Rc.Rc - Rc.depth - Rc.podium / 2), Rs.z + 10], Math.floor(Rs.base + 9));
  // the eye cannot see through them
  const eye = (L, d) => [L.x - d, L.z];
  check('a sight line through the lighthouse is blocked', !W.sightClear(...eye(Lh, 20).map(v => v * PX), Lh.base + 1.7, (Lh.x + 20) * PX, Lh.z * PX, Lh.base + 1.7));
  const [fx, fz] = at(K, 20, 10), [bx, bz] = at(K, -20, 10);
  check('a sight line through a letter is blocked', !W.sightClear(fx * PX, fz * PX, K.base + 3, bx * PX, bz * PX, K.base + 3));
  const n = W.wallNormalPx(...at(K, 1.6, spans[0].z0 - spans[0].w / 2).map(v => v * PX));
  const fwd = [Math.cos(K.a), Math.sin(K.a)];
  check('a car sliding along a letter is pushed off it, away from its face', !!n && n.x * fwd[0] + n.y * fwd[1] > 0.7, n ? `${n.x.toFixed(2)},${n.y.toFixed(2)}` : 'none');
}
{
  const lost = spots.filter((q, i) => !footBefore[i] && W.blockedFootPx(q[1], q[2])).map(q => q[0]);
  check('every jar, photo spot, place spot and parked car stays reachable on foot', lost.length === 0, lost.join(', '));
  const lanes = lanePts.filter(([x, y, was]) => !was && W.blockedCarPx(x, y)).length;
  check('no traffic lane runs into a landmark', lanes === 0, `${lanes} lane points blocked`);
  const walks = walkPts.filter(([x, y, was]) => !was && W.blockedFootPx(x, y)).length;
  check('no sidewalk path runs into a landmark', walks === 0, `${walks} path points blocked`);
}

// ---------- 4. night ----------
section('the v2 night (sky.js)');
{
  const SKY = await import(src('src/3d/sky.js'));
  const scene = new THREE.Scene(), sky = SKY.makeSky(scene), cam = new THREE.PerspectiveCamera(), focus = new THREE.Vector3(870, 2, 505);
  const rend = LOW ? { toneMappingExposure: 1.05 } : undefined;
  const look = (hour) => {
    sky.update(hour * 60, focus, cam, rend);
    return { hemi: sky.hemi.intensity, fill: sky.hemi.color.clone(), moon: sky.sun.intensity, fog: scene.fog.color.clone(), exp: rend?.toneMappingExposure };
  };
  const day = look(13), night = look(22.5), day2 = look(13);
  const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  note(`fill ${night.hemi.toFixed(2)} x #${night.fill.getHexString()} (lum ${lum(night.fill).toFixed(3)}), moon ${night.moon.toFixed(2)}, haze #${night.fog.getHexString()}`);
  check('after dark the sky\'s fill is a moonlit blue, and strong', night.hemi >= 0.75 && night.fill.b > night.fill.r * 1.6 && lum(night.fill) > 0.12, `${night.hemi.toFixed(2)}, lum ${lum(night.fill).toFixed(3)}`);
  check('the moon lights the night (0.72)', Math.abs(night.moon - 0.72) < 1e-9, night.moon);
  check('the night haze is blue, not black', night.fog.b > 0.1 && night.fog.b > night.fog.r * 1.5, '#' + night.fog.getHexString());
  check('by day the light is as it was (fill 0.85 x #a9d4ff on High, 1.37 on Low)', Math.abs(day.hemi - (LOW ? 1.37 : 0.85)) < 1e-6 && day2.hemi === day.hemi, `${day.hemi}`);
  if (LOW) check('the exposure opens up 20 % after dark and comes back by day', Math.abs(night.exp - 1.26) < 1e-9 && Math.abs(day2.exp - 1.05) < 1e-9, `${night.exp} ${day2.exp}`);
  else note('the night exposure is checked on the phone tier (S3B_LOW=1): High re-bakes its lighting with the renderer');
}

// ---------- 5. K-Town's lamps ----------
section('K-Town is lit (prefabs.js park_circle, props3d Neon Alley)');
{
  const ring = W.roads.edges.filter(e => e.road === 'ring');
  let cx = 0, cz = 0, n = 0;
  for (const e of ring) for (let i = 0; i < e.n; i++) { cx += e.x[i] / PX; cz += e.y[i] / PX; n++; }
  cx /= n; cz /= n;
  const inner = W.lamps.filter(l => { const r = Math.hypot(l.x / PX - cx, l.y / PX - cz); return r > 35.5 && r < 38.5; });
  const onWalk = inner.filter(l => W.surfaceAt(l.x, l.y) === W.WALK);
  check('twelve lamps round the ring\'s inner pavement', inner.length === 12 && onWalk.length === 12, `${inner.length}, ${onWalk.length} on the pavement`);
  // each head over the ring's carriageway's inner half, 2.1 m out along its arm
  const heads = inner.filter(l => { const hx = l.x / PX + Math.cos(l.a) * 2.1, hz = l.y / PX + Math.sin(l.a) * 2.1, r = Math.hypot(hx - cx, hz - cz); return r > 38 && r < 40; });
  check('their arms reach out over the carriageway', heads.length === 12, `${heads.length}`);
  const paths = W.lamps.filter(l => { const r = Math.hypot(l.x / PX - cx, l.y / PX - cz); return r > 10 && r < 30; });
  check('eight lamps along Fountain Park\'s paths, none on the lawn\'s trees', paths.length === 8 && paths.every(l => !W.trees.some(t => Math.hypot(t.x - l.x, t.y - l.y) < 1.5 * PX)), `${paths.length}`);
  const st = props.stats();
  note(`Neon Alley: ${st.by?.bulbs?.[2]} bulbs and lanterns, ${st.alley?.pools} pink pools`);
  check('Neon Alley has its festoons and its pools of light', st.by?.bulbs?.[2] >= 60 && st.alley?.pools >= 3);
}

done();
