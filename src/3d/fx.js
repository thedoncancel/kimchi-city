import * as THREE from 'three';
import * as TX from './textures.js';
import { S, surfaceY } from './city.js';
import { jarSpots, places } from '../world.js';
import { G } from '../state.js';

// Particles are drawn as GPU points: one draw call for every glowing particle (fire, sparks, flashes)
// and one for every soft one (smoke, dust), however many are alive.
function particlePool(scene, max, glow, tex) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(max * 3), col = new Float32Array(max * 3), alpha = new Float32Array(max), size = new Float32Array(max);
  const attr = (a, n) => new THREE.BufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', attr(pos, 3));
  geo.setAttribute('pcolor', attr(col, 3));
  geo.setAttribute('alpha', attr(alpha, 1));
  geo.setAttribute('psize', attr(size, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: null }, scale: { value: 600 } }]),
    vertexShader: `
      attribute vec3 pcolor; attribute float alpha; attribute float psize;
      uniform float scale;
      varying vec3 vColor; varying float vAlpha;
      #include <fog_pars_vertex>
      void main() {
        vColor = pcolor; vAlpha = alpha;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = alpha > 0.0 ? psize * scale / max(0.2, -mvPosition.z) : 0.0;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform sampler2D map;
      varying vec3 vColor; varying float vAlpha;
      #include <fog_pars_fragment>
      void main() {
        vec4 t = texture2D(map, gl_PointCoord);
        gl_FragColor = vec4(vColor, t.a * vAlpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        ${glow ? '' : '#include <fog_fragment>'}
      }`,
    transparent: true, depthWrite: false, fog: !glow,
    blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  mat.uniforms.map.value = tex;
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = glow ? 3 : 2;
  scene.add(points);

  const P = [];
  for (let i = 0; i < max; i++) P.push({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size: 1, grow: 1, op: 1, g: 0, drag: 0.4, fadeIn: 0, c0: new THREE.Color(), c1: null });
  let next = 0;
  function emit(x, y, z, o) {
    const p = P[next];
    next = (next + 1) % max;
    p.x = x; p.y = y; p.z = z;
    p.vx = o.vx || 0; p.vy = o.vy || 0; p.vz = o.vz || 0;
    p.life = p.max = o.life ?? 0.8;
    p.size = o.size ?? 0.6; p.grow = o.grow ?? 1.6; p.op = o.opacity ?? 0.55; p.g = o.gravity || 0;
    p.drag = o.drag ?? 0.4; p.fadeIn = o.fadeIn ?? (glow ? 0 : 0.1);
    p.c0.set(o.color || '#ffffff');
    if (o.bright) p.c0.multiplyScalar(o.bright);
    p.c1 = o.color2 ? new THREE.Color(o.color2) : null;
  }
  const tmp = new THREE.Color();
  function update(dt, scale) {
    mat.uniforms.scale.value = scale;
    for (let i = 0; i < max; i++) {
      const p = P[i];
      if (p.life <= 0) { if (alpha[i] !== 0) alpha[i] = 0; continue; }
      p.life -= dt;
      if (p.life <= 0) { alpha[i] = 0; continue; }
      p.vy += p.g * dt;
      const d = Math.pow(p.drag, dt);
      p.vx *= d; p.vy *= d; p.vz *= d;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const k = 1 - p.life / p.max;
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      size[i] = p.size * (1 + p.grow * k);
      alpha[i] = p.op * (1 - k) * (p.fadeIn > 0 ? Math.min(1, k / p.fadeIn) : 1);
      const c = p.c1 ? tmp.copy(p.c0).lerp(p.c1, Math.min(1, k * 1.6)) : p.c0;
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    for (const n of ['position', 'pcolor', 'alpha', 'psize']) geo.attributes[n].needsUpdate = true;
  }
  return { emit, update };
}

export function makeFX(scene, { flashLight = true } = {}) {
  const puffTex = TX.puff();
  const soft = particlePool(scene, 420, false, puffTex);
  const glow = particlePool(scene, 380, true, TX.radialGlow());
  function emit(x, y, z, o = {}) { (o.glow ? glow : soft).emit(x, y, z, o); }
  function burst(x, y, z, colors, n = 18, speed = 4) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, u = Math.random();
      emit(x, y, z, { vx: Math.cos(a) * speed * u, vy: 2 + Math.random() * speed, vz: Math.sin(a) * speed * u,
        life: 0.7 + Math.random() * 0.4, size: 0.25, grow: 0.2, color: colors[i % colors.length], opacity: 1, gravity: -9, glow: true });
    }
  }
  const rnd = (s) => (Math.random() - 0.5) * 2 * s;

  // ---------- gunfire ----------
  // one light for muzzle flashes and explosions; it stays in the scene so no shader ever recompiles
  const flash = new THREE.PointLight('#ffb766', 0, 14, 1.6);
  if (flashLight) scene.add(flash);
  let flashT = 0, flashMax = 1, flashPeak = 0;
  function lightFlash(p, intensity, dur, dist) {
    if (intensity < flashPeak * (flashT / flashMax)) return;
    flash.position.copy(p);
    flash.distance = dist;
    flashPeak = intensity; flashT = flashMax = dur;
  }

  function muzzle(p) {
    emit(p.x, p.y, p.z, { life: 0.06, size: 0.42, grow: 0.6, color: '#fff2c0', bright: 2.2, opacity: 1, glow: true, drag: 1 });
    emit(p.x, p.y, p.z, { life: 0.09, size: 0.22, grow: 1.4, color: '#ffb347', bright: 1.6, opacity: 0.9, glow: true, drag: 1 });
    emit(p.x, p.y + 0.05, p.z, { vy: 0.5, life: 0.6, size: 0.18, grow: 2.5, color: '#cfc9bf', opacity: 0.32 });
    lightFlash(p, 60, 0.06, 9);
  }

  // tracers: thin glowing streaks, all in one instanced mesh
  const MAXT = 40;
  const trGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
  const trMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const tracers = new THREE.InstancedMesh(trGeo, trMat, MAXT);
  tracers.frustumCulled = false;
  tracers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const trList = [];
  const dummy = new THREE.Object3D(), trCol = new THREE.Color(), trBase = new THREE.Color('#ffd98a').multiplyScalar(1.8);
  for (let i = 0; i < MAXT; i++) {
    trList.push({ t: 0, from: new THREE.Vector3(), to: new THREE.Vector3() });
    dummy.scale.setScalar(0); dummy.updateMatrix();
    tracers.setMatrixAt(i, dummy.matrix);
    tracers.setColorAt(i, trCol.setRGB(0, 0, 0));
  }
  scene.add(tracers);
  let trNext = 0;
  function tracer(from, to) {
    const tr = trList[trNext];
    trNext = (trNext + 1) % MAXT;
    tr.t = 0.07;
    tr.from.copy(from); tr.to.copy(to);
  }

  function impact(hit) {
    const p = hit.point;
    if (hit.kind === 'none') return;
    if (hit.kind === 'ped' || hit.kind === 'player' || hit.kind === 'friend') {
      for (let i = 0; i < 3; i++) emit(p.x, p.y, p.z, { vx: rnd(1.2), vy: Math.random() * 1.5, vz: rnd(1.2), life: 0.35, size: 0.12, grow: 2, color: '#b3202a', opacity: 0.8 });
      return;
    }
    const sparks = hit.kind === 'car' ? 7 : 3;
    for (let i = 0; i < sparks; i++) {
      emit(p.x, p.y, p.z, { vx: rnd(3) - hit.dir.x * 2, vy: Math.random() * 3, vz: rnd(3) - hit.dir.z * 2, life: 0.22 + Math.random() * 0.15,
        size: 0.06, grow: 0, color: '#ffd27a', bright: 1.6, opacity: 1, gravity: -12, glow: true, drag: 0.6 });
    }
    const dust = hit.kind === 'car' ? '#4a4744' : hit.kind === 'ground' ? '#b9b2a4' : '#c9c1b4';
    emit(p.x, p.y, p.z, { vx: -hit.dir.x * 0.6, vy: 0.4, vz: -hit.dir.z * 0.6, life: 0.55, size: 0.2, grow: 3, color: dust, opacity: 0.6 });
  }

  function explosion(p) {
    lightFlash(p, 1400, 0.55, 40);
    for (let i = 0; i < 28; i++) {
      const a = Math.random() * Math.PI * 2, u = Math.random();
      emit(p.x + rnd(0.8), p.y + Math.random() * 0.6, p.z + rnd(0.8), { vx: Math.cos(a) * 6 * u, vy: 1 + Math.random() * 5, vz: Math.sin(a) * 6 * u,
        life: 0.45 + Math.random() * 0.45, size: 1 + Math.random() * 0.9, grow: 1.6, color: '#fff0b0', color2: '#ff4a12', bright: 1.8, opacity: 1, glow: true, drag: 0.12 });
    }
    for (let i = 0; i < 22; i++) {
      const a = Math.random() * Math.PI * 2;
      emit(p.x, p.y + 0.3, p.z, { vx: Math.cos(a) * 14 * Math.random(), vy: 3 + Math.random() * 9, vz: Math.sin(a) * 14 * Math.random(),
        life: 0.7 + Math.random() * 0.6, size: 0.12, grow: 0, color: '#ffc35a', bright: 1.6, opacity: 1, gravity: -14, glow: true, drag: 0.7 });
    }
    for (let i = 0; i < 20; i++) {
      emit(p.x + rnd(1.2), p.y + 0.5 + Math.random(), p.z + rnd(1.2), { vx: rnd(1.6), vy: 1.5 + Math.random() * 3, vz: rnd(1.6),
        life: 2 + Math.random() * 1.6, size: 1.4 + Math.random(), grow: 2.4, color: '#2b2522', opacity: 0.72, drag: 0.5, fadeIn: 0.12 });
    }
  }

  // burning cars and smoking engines
  function fire(x, y, z, k = 1) {
    emit(x + rnd(0.5), y, z + rnd(0.5), { vx: rnd(0.3), vy: 1.6 + Math.random() * 1.6, vz: rnd(0.3), life: 0.45 + Math.random() * 0.3,
      size: 0.45 * k + Math.random() * 0.3, grow: 0.4, color: '#ffd77a', color2: '#ff3d0a', bright: 1.6, opacity: 0.95, glow: true, drag: 0.5 });
  }
  const smokeLight = new THREE.Color('#d8d3cb'), smokeDark = new THREE.Color('#1e1b19'), smokeC = new THREE.Color();
  function smoke(x, y, z, dark = 0.5, k = 1) {
    emit(x + rnd(0.3), y, z + rnd(0.3), { vx: rnd(0.4), vy: 1.2 + Math.random(), vz: rnd(0.4), life: 1.6 + Math.random(),
      size: 0.5 * k, grow: 3, color: smokeC.copy(smokeLight).lerp(smokeDark, dark), opacity: 0.5, drag: 0.6 });
  }

  // ---------- kimchi jars ----------
  const jarGeo = new THREE.CylinderGeometry(0.24, 0.27, 0.46, 14);
  const lidGeo = new THREE.CylinderGeometry(0.215, 0.215, 0.1, 14);
  const labelGeo = new THREE.CylinderGeometry(0.276, 0.276, 0.17, 14, 1, true);
  const jarMat = new THREE.MeshStandardMaterial({ color: '#d6402b', roughness: 0.2, metalness: 0.1, emissive: new THREE.Color('#7a1508'), emissiveIntensity: 0.5 });
  const lidMat = new THREE.MeshLambertMaterial({ color: '#1b1512' });
  const labelMat = new THREE.MeshLambertMaterial({ map: TX.textSign('김치', { bg: '#f6ead8', fg: '#d6402b', w: 256, h: 64, size: 48 }) });
  const glowMat = new THREE.SpriteMaterial({ map: TX.radialGlow(), color: '#ffcf6a', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55 });
  const jars = jarSpots.map(j => {
    const g = new THREE.Group();
    const jar = new THREE.Mesh(jarGeo, jarMat); jar.castShadow = true;
    const lid = new THREE.Mesh(lidGeo, lidMat); lid.position.y = 0.28;
    const label = new THREE.Mesh(labelGeo, labelMat); label.position.y = -0.02;
    const glowS = new THREE.Sprite(glowMat); glowS.scale.set(1.9, 1.9, 1);
    g.add(jar, lid, label, glowS);
    g.position.set(j.x * S, surfaceY(j.x, j.y) + 0.85, j.y * S);
    scene.add(g);
    return { j, g, base: g.position.y, gone: false };
  });

  // ---------- beacons: delivery, mission targets, checkpoints ----------
  const beamTex = TX.beam();
  function makeBeacon(color, height = 90) {
    const beamMat = new THREE.MeshBasicMaterial({ map: beamTex, color, transparent: true, opacity: 0.65, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.4, height, 20, 1, true), beamMat);
    beam.position.y = height / 2;
    const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.1, 48), ringMat);
    ring.rotation.x = -Math.PI / 2;
    const g = new THREE.Group();
    g.add(beam, ring);
    g.visible = false;
    scene.add(g);
    return { g, beam, ring, beamMat, ringMat };
  }
  const delivery = makeBeacon('#ff5a3a');
  const beacons = [0, 1, 2, 3].map(() => makeBeacon('#f2c230', 60));

  // arrows hovering over people and cars you need to deal with
  const arrowGeo = new THREE.ConeGeometry(0.32, 0.7, 4).rotateX(Math.PI);
  const arrows = [];
  for (let i = 0; i < 10; i++) {
    const m = new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: '#e23b2b', fog: false }));
    m.visible = false;
    scene.add(m);
    arrows.push(m);
  }

  // Givers and photo spots each have a pool of NEAR_MARKS markers, given to the marks nearest the camera, so a
  // county with more spots than markers still shows every one close by.
  const NEAR_MARKS = 12;

  // yellow mission markers where a story mission can be started
  const giverGeo = new THREE.CylinderGeometry(0.85, 0.85, 1.9, 28, 1, true);
  const giverMat = new THREE.MeshBasicMaterial({ map: beamTex, color: '#f2c230', transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const gemGeo = new THREE.OctahedronGeometry(0.22);
  const gemMat = new THREE.MeshBasicMaterial({ color: '#ffd84a' });
  const givers = [];
  for (let i = 0; i < NEAR_MARKS; i++) {
    const g = new THREE.Group();
    const c = new THREE.Mesh(giverGeo, giverMat); c.position.y = 0.95;
    const gem = new THREE.Mesh(gemGeo, gemMat); gem.position.y = 2.3; gem.scale.set(1, 1.5, 1);
    g.add(c, gem);
    g.visible = false;
    scene.add(g);
    givers.push({ g, gem });
  }

  // pink rings with a spinning gem where a picture is worth posting
  const photoRingMat = new THREE.MeshBasicMaterial({ color: '#ff5fa2', transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const photoGemMat = new THREE.MeshBasicMaterial({ color: '#ff7ab6' });
  const photoRingGeo = new THREE.RingGeometry(1.15, 1.45, 40);
  const photos = [];
  for (let i = 0; i < NEAR_MARKS; i++) {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(photoRingGeo, photoRingMat); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.05;
    const gem = new THREE.Mesh(gemGeo, photoGemMat); gem.position.y = 1.6; gem.scale.set(0.9, 1.3, 0.9);
    g.add(ring, gem);
    g.visible = false;
    scene.add(g);
    photos.push({ g, gem, ring });
  }

  // ---------- glowing rings at doors you can enter ----------
  const doors = [];
  for (const pl of Object.values(places)) {
    if (pl.nomenu) continue;
    const mat = new THREE.MeshBasicMaterial({ color: pl.color, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const r = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.25, 40), mat);
    r.rotation.x = -Math.PI / 2;
    r.position.set(pl.door.x * S, surfaceY(pl.door.x, pl.door.y) + 0.03, pl.door.y * S);
    scene.add(r);
    doors.push(r);
  }

  function syncJars(silent = false) {
    for (const o of jars) {
      const has = G.jars.has(o.j.id);
      if (has && !o.gone) {
        o.gone = true;
        o.g.visible = false;
        if (!silent) burst(o.g.position.x, o.g.position.y, o.g.position.z, ['#ff5a3a', '#ffd36a', '#ffffff'], 26, 5);
      } else if (!has && o.gone) { o.gone = false; o.g.visible = true; }
    }
  }

  function placeBeacon(b, x, y, t, color, scale = 1, faint = false) {
    b.g.visible = true;
    b.g.position.set(x * S, surfaceY(x, y) + 0.05, y * S);
    b.g.scale.set(scale, 1, scale);
    if (color) { b.beamMat.color.set(color); b.ringMat.color.set(color); }
    const pulse = (t * 1.2) % 1;
    b.ring.scale.setScalar(1 + pulse * 2.2);
    b.ringMat.opacity = (faint ? 0.35 : 0.9) * (1 - pulse);
    b.beamMat.opacity = (faint ? 0.25 : 0.5) + Math.sin(t * 4) * 0.12;
  }

  // A jar Kimchi comes within SPOT_PX of is spotted: from then on the big map shows it (G.seen['jar' + id], kept
  // in the save), as the 2D game marks the jars it has drawn on screen.
  const SPOT_PX = 40 / S;   // 40 m
  function spotJars() {
    const p = G.player;
    for (const o of jars) {
      if (o.gone || G.seen['jar' + o.j.id]) continue;
      const dx = o.j.x - p.x, dy = o.j.y - p.y;
      if (dx * dx + dy * dy < SPOT_PX * SPOT_PX) G.seen['jar' + o.j.id] = true;
    }
  }

  // marks: [{ x, y, color, ring, small, faint, giver, photo }] in sim px
  let marks = [];
  function setMarks(list) { marks = list; }
  // Sorts list (a handful of marks) nearest (cam.x, cam.z) first and keeps the first n.
  const dist = [];
  function nearestFirst(list, cam, n) {
    for (let i = 0; i < list.length; i++) dist[i] = (list[i].x * S - cam.x) ** 2 + (list[i].y * S - cam.z) ** 2;
    for (let i = 1; i < list.length; i++) {
      const m = list[i], d = dist[i];
      let j = i - 1;
      for (; j >= 0 && dist[j] > d; j--) { list[j + 1] = list[j]; dist[j + 1] = dist[j]; }
      list[j + 1] = m; dist[j + 1] = d;
    }
    if (list.length > n) list.length = n;
    return list;
  }
  const nearGivers = [], nearPhotos = [];

  const bufSize = new THREE.Vector2();
  function update(dt, t, cam, camera, renderer) {
    let scale = 600;
    if (camera && renderer) scale = renderer.getDrawingBufferSize(bufSize).y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    soft.update(dt, scale);
    glow.update(dt, scale);

    flashT = Math.max(0, flashT - dt);
    flash.intensity = flashT > 0 ? flashPeak * (flashT / flashMax) : 0;
    if (flashT <= 0) flashPeak = 0;

    for (let i = 0; i < MAXT; i++) {
      const tr = trList[i];
      if (tr.t <= 0) continue;
      tr.t -= dt;
      if (tr.t <= 0) { dummy.scale.setScalar(0); }
      else {
        dummy.position.copy(tr.from);
        dummy.lookAt(tr.to);
        dummy.scale.set(0.03, 0.03, tr.from.distanceTo(tr.to));
        tracers.setColorAt(i, trCol.copy(trBase).multiplyScalar(tr.t / 0.07));
      }
      dummy.updateMatrix();
      tracers.setMatrixAt(i, dummy.matrix);
      tracers.instanceMatrix.needsUpdate = true;
      tracers.instanceColor.needsUpdate = true;
    }

    syncJars();
    if (G.mode === 'play') spotJars();
    for (const o of jars) {
      if (o.gone) continue;
      const near = Math.abs(o.g.position.x - cam.x) < 140 && Math.abs(o.g.position.z - cam.z) < 140;
      o.g.visible = near;
      if (!near) continue;
      o.g.position.y = o.base + Math.sin(t * 2.4 + o.j.id) * 0.15;
      o.g.rotation.y = t * 1.6 + o.j.id;
    }
    if (G.job) {
      const d = G.job.b.door;
      placeBeacon(delivery, d.x, d.y, t);
    } else delivery.g.visible = false;

    let nb = 0, na = 0;
    nearGivers.length = 0; nearPhotos.length = 0;
    for (const m of marks) {
      if (m.photo) nearPhotos.push(m);
      else if (m.giver) nearGivers.push(m);
      else if (m.small) {
        if (na >= arrows.length) continue;
        const a = arrows[na++];
        a.visible = true;
        a.material.color.set(m.color);
        a.position.set(m.x * S, surfaceY(m.x, m.y) + (m.h || 2.5) + Math.sin(t * 4 + na) * 0.15, m.y * S);
        a.rotation.y = t * 2.5;
      } else {
        if (nb >= beacons.length) continue;
        placeBeacon(beacons[nb++], m.x, m.y, t, m.color.slice(0, 7), m.ring ? 2.4 : 1, m.faint);
      }
    }
    // photo rings and giver markers stand on the ground; each gem bobs on its own beat (from where it is), so
    // it does not jump when the nearest-first order changes
    const np = nearestFirst(nearPhotos, cam, photos.length).length;
    for (let i = 0; i < np; i++) {
      const m = nearPhotos[i], ph = photos[i];
      ph.g.visible = true;
      ph.g.position.set(m.x * S, surfaceY(m.x, m.y) + 0.02, m.y * S);
      ph.gem.rotation.y = t * 2.2;
      ph.gem.position.y = 1.6 + Math.sin(t * 3 + (m.x + m.y) * S * 0.37) * 0.12;
      ph.ring.scale.setScalar(1 + Math.sin(t * 3) * 0.06);
    }
    const ng = nearestFirst(nearGivers, cam, givers.length).length;
    for (let i = 0; i < ng; i++) {
      const m = nearGivers[i], gv = givers[i];
      gv.g.visible = true;
      gv.g.position.set(m.x * S, surfaceY(m.x, m.y) + 0.02, m.y * S);
      gv.gem.rotation.y = t * 2;
      gv.gem.position.y = 2.3 + Math.sin(t * 2.5) * 0.12;
    }
    for (let i = nb; i < beacons.length; i++) beacons[i].g.visible = false;
    for (let i = na; i < arrows.length; i++) arrows[i].visible = false;
    for (let i = ng; i < givers.length; i++) givers[i].g.visible = false;
    for (let i = np; i < photos.length; i++) photos[i].g.visible = false;

    for (const r of doors) {
      r.material.opacity = 0.45 + Math.sin(t * 3) * 0.2;
      r.scale.setScalar(1 + Math.sin(t * 3) * 0.06);
    }
  }

  return { emit, burst, update, syncJars, muzzle, tracer, impact, explosion, fire, smoke, setMarks };
}
