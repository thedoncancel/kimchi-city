import * as THREE from 'three';
import { mountains } from './city.js';
import { Sky } from '../../vendor/addons/objects/Sky.js';
import { HIGH } from './quality.js';
import { KIND } from '../world.js';

// Fog per world (docs/map-v2-spec.md §0 and §11.1). The grid town keeps its own. The v2 county is seen from far
// off, so its haze is thinner: exponential on the high tier (0.00055 by day, thicker at golden hour and at
// night) and linear from 180 to 900 m on the low tier, whose camera stops at 1.2 km.
const V2 = KIND === 'v2';
const V2_FOG = { day: 0.00055, golden: 0.0006, night: 0.0008, near: 180, far: 900 };
// A v2 night is Forza's: readable and inviting rather than black. The sky stays a deep blue with the city's glow
// along the horizon (NIGHT_KEYS), so the skyline and the hills stand out against it and the haze the far county
// fades into is blue. The sky's fill turns a moonlit blue (fill, at fillK more strength than by day's end), the
// moon is brighter, and the exposure opens up by `exposure` after dark, so Kimchi, the roads and the trees read
// in the shade; the street lamps, the neon and the lit windows do the rest. skyKeep is the share of the day's
// fill colour kept at night. The grid town keeps its own nights.
const V2_NIGHT = V2 ? { skyKeep: 0.22, moon: 0.72, fill: new THREE.Color('#4a66ad'), fillK: 0.32, env: 0.12, exposure: 0.2 }
  : { skyKeep: 0, moon: 0.32, fill: null, fillK: 0, env: 0, exposure: 0 };

// hour, zenith colour, horizon colour
const KEYS = [
  [0, '#050916', '#111a33'],
  [4.6, '#0a1130', '#1b2446'],
  [5.8, '#3d4f8f', '#e89a7a'],
  [7.2, '#5b9ee0', '#cfe3f0'],
  [16.8, '#5799df', '#d4e6f1'],
  [18.3, '#41548f', '#f39a5d'],
  [19.4, '#1d2552', '#7a4d6a'],
  [20.6, '#08102a', '#18203e'],
  [24, '#050916', '#111a33'],
].map(([h, a, b]) => [h, new THREE.Color(a), new THREE.Color(b)]);
// v2's night sky: deep blue overhead, a lit band of city glow on the horizon
const NIGHT_KEYS = { 0: ['#0a1534', '#2a355f'], 4.6: ['#0e1a42', '#2f3a66'], 20.6: ['#0c173a', '#2c3762'], 24: ['#0a1534', '#2a355f'] };
if (V2) for (const k of KEYS) if (NIGHT_KEYS[k[0]]) { k[1].set(NIGHT_KEYS[k[0]][0]); k[2].set(NIGHT_KEYS[k[0]][1]); }

// The exposure after dark: the renderer's own (main3d sets it once) opened up by V2_NIGHT.exposure at full night.
let baseExposure = null;
function nightExposure(rend, day) {
  if (!rend || !V2_NIGHT.exposure) return;
  if (baseExposure === null) baseExposure = rend.toneMappingExposure;
  rend.toneMappingExposure = baseExposure * (1 + V2_NIGHT.exposure * (1 - day));
}

const CLOUD_SECTORS = 8;   // meshes the clouds are baked into, two neighbouring clusters each (makeClouds)

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAG = /* glsl */`
uniform vec3 top, horizon, bottom, sunDir, sunColor, moonDir;
uniform float sunVis, moonVis;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = h > 0.0 ? mix(horizon, top, pow(h, 0.5)) : mix(horizon, bottom, pow(min(1.0, -h * 3.0), 0.6));
  float s = max(dot(d, sunDir), 0.0);
  col += sunColor * (pow(s, 1400.0) * 6.0 + pow(s, 14.0) * 0.32) * sunVis;
  float m = max(dot(d, moonDir), 0.0);
  col += vec3(0.85, 0.9, 1.0) * (pow(m, 2600.0) * 4.0 + pow(m, 60.0) * 0.06) * moonVis;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// The physical sky (Preetham scattering: blue overhead, white haze low, orange at sunset) blended into the
// old gradient at night, with the moon, and the horizon melted into the fog colour so the city fades into it.
// On a clear v2 day (`clear`: daylight away from golden hour) the low sky keeps its blue: on its own the
// scattering turns white within 10 degrees of the horizon and the tone curve flattens that to an overcast grey,
// which is most of the sky a player sees. So the band up to about 17 degrees is dimmed a little, the whole sky
// takes the deeper cartoon tint, and the haze only covers the last 2 or 3 degrees. Below the horizon (seen from
// high up, past the sea's far edge) the dome is the haze itself, which is what the far sea fades into.
function physicalSky() {
  const sky = new Sky();
  const m = sky.material;
  Object.assign(m.uniforms, {
    nTop: { value: new THREE.Color() }, nHorizon: { value: new THREE.Color() }, moonDir: { value: new THREE.Vector3(0, 1, 0) },
    moonVis: { value: 0 }, dayMix: { value: 1 }, clear: { value: 0 }, under: { value: V2 ? 1 : 0 }, skyGain: { value: 0.46 }, hazeColor: { value: new THREE.Color() }, hazeK: { value: 0.4 },
  });
  m.fragmentShader = m.fragmentShader
    .replace('uniform vec3 up;', 'uniform vec3 up;\nuniform vec3 nTop, nHorizon, moonDir, hazeColor;\nuniform float moonVis, dayMix, clear, under, hazeK, skyGain;')
    .replace('gl_FragColor = vec4( retColor, 1.0 );', `
      retColor *= skyGain;
      // cartoon sky: push the colour, deeper blue overhead
      retColor = max(mix(vec3(dot(retColor, vec3(0.333))), retColor, 1.75), 0.0);
      float hy = direction.y;
      retColor *= 1.0 - 0.34 * (1.0 - clamp(hy / 0.3, 0.0, 1.0)) * clear;
      vec3 tint = mix(vec3(0.82, 0.95, 1.12), vec3(0.58, 0.77, 1.04), clear);
      retColor *= mix(vec3(1.0), tint, clamp(hy * 1.5 + clear, 0.0, 1.0) * dayMix);
      vec3 night = hy > 0.0 ? mix(nHorizon, nTop, pow(hy, 0.5)) : nHorizon * mix(0.6, 1.0, under);
      retColor = mix(night, retColor, dayMix);
      float mm = max(dot(direction, moonDir), 0.0);
      retColor += vec3(0.85, 0.9, 1.0) * (pow(mm, 2600.0) * 4.0 + pow(mm, 60.0) * 0.06) * moonVis;
      float hazeTop = mix(0.12, 0.04, clear);
      retColor = mix(retColor, hazeColor, max((1.0 - smoothstep(-0.03, hazeTop, hy)) * hazeK, (1.0 - smoothstep(-0.05, 0.0, hy)) * under));
      gl_FragColor = vec4( retColor, 1.0 );`);
  m.uniforms.turbidity.value = 2.4;
  m.uniforms.rayleigh.value = 3.0;
  m.uniforms.mieCoefficient.value = 0.003;
  m.uniforms.mieDirectionalG.value = 0.78;
  m.fog = false;
  return sky;
}

// Big puffy cartoon clouds far out over the sea: clusters of smooth blobs, white on top, soft blue-grey
// underneath, tinted peach at sunset and dark at night
function makeClouds(scene) {
  const geo = new THREE.IcosahedronGeometry(1, 2);
  const pos = geo.attributes.position, cols = [];
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const k = 0.78 + 0.22 * Math.min(1, Math.max(0, y * 0.9 + 0.55));
    cols.push(k, k * 1.0, Math.min(1, k * 1.04));
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, color: '#ffffff' });
  const group = new THREE.Group();
  const rnd = (a, i) => { const x = Math.sin(a * 127.1 + i * 311.7) * 43758.5453; return x - Math.floor(x); };
  // Each blob is placed as before, then baked into one mesh per pair of neighbouring clusters (a sector of the
  // sky): the 130 or so blobs were a draw call each, about 20 of every view's calls; now a view draws two or three.
  const sectors = Array.from({ length: CLOUD_SECTORS }, () => []);
  for (let c = 0; c < 16; c++) {
    const a = (c / 16) * Math.PI * 2 + rnd(c, 1) * 0.3, d = 900 + rnd(c, 2) * 600, y = 170 + rnd(c, 3) * 220;
    const cl = new THREE.Group();
    cl.position.set(Math.cos(a) * d, y, Math.sin(a) * d);
    cl.lookAt(0, y, 0);
    const n = 6 + Math.floor(rnd(c, 4) * 5), size = 38 + rnd(c, 5) * 40;
    for (let i = 0; i < n; i++) {
      const m = new THREE.Object3D();
      const t = i / (n - 1) - 0.5;
      const r = size * (0.55 + 0.45 * Math.cos(t * Math.PI)) * (0.8 + rnd(c * 9 + i, 6) * 0.4);
      m.position.set(t * size * 3.2, r * 0.35 + rnd(c * 9 + i, 7) * size * 0.25, (rnd(c * 9 + i, 8) - 0.5) * size * 0.6);
      m.scale.set(r, r * 0.8, r);
      cl.add(m);
    }
    // a flat-ish bottom, like real cumulus
    cl.scale.y = 0.85;
    cl.updateMatrixWorld(true);
    for (const m of cl.children) sectors[Math.floor(c * CLOUD_SECTORS / 16)].push(m.matrixWorld);
  }
  for (const list of sectors) {
    const per = geo.attributes.position.count, pos = new Float32Array(list.length * per * 3), col = new Float32Array(list.length * per * 3), v = new THREE.Vector3();
    list.forEach((mw, b) => {
      for (let i = 0; i < per; i++) {
        v.fromBufferAttribute(geo.attributes.position, i).applyMatrix4(mw).toArray(pos, (b * per + i) * 3);
        col.set([geo.attributes.color.getX(i), geo.attributes.color.getY(i), geo.attributes.color.getZ(i)], (b * per + i) * 3);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeBoundingSphere();
    group.add(new THREE.Mesh(g, mat));
  }
  geo.dispose();
  group.renderOrder = -8;
  scene.add(group);
  // On v2 the day colour is brighter than white (and a touch warm), so after the tone curve the clouds still stand
  // out brighter than the blue behind them instead of reading as grey smudges; the grid keeps plain white.
  const day = V2 ? new THREE.Color().setRGB(1.42, 1.38, 1.3) : new THREE.Color('#ffffff');
  const gold = new THREE.Color('#ffc4a4').multiplyScalar(V2 ? 1.2 : 1), night = new THREE.Color('#283050');
  return {
    group,
    update(cam, dayK, golden) {
      group.position.set(cam.x, 0, cam.z);
      mat.color.copy(night).lerp(day, dayK).lerp(gold, golden * 0.75);
    },
  };
}

export function makeSky(scene, { shadowSize = 2048 } = {}) {
  if (HIGH) return makeSkyHigh(scene);
  const u = {
    top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, bottom: { value: new THREE.Color('#2a3a44') },
    sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColor: { value: new THREE.Color('#ffe2b0') }, moonDir: { value: new THREE.Vector3(0, 1, 0) },
    sunVis: { value: 1 }, moonVis: { value: 0 },
  };
  // the dome, stars and clouds stay inside the camera's far plane (the v2 low tier draws to 1.2 km)
  const R = V2 ? 1100 : 1500;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(R, 32, 16), new THREE.ShaderMaterial({
    uniforms: u, vertexShader: VERT, fragmentShader: FRAG, side: THREE.BackSide, depthWrite: false, fog: false,
  }));
  dome.frustumCulled = false;
  dome.renderOrder = -10;
  scene.add(dome);

  // stars
  const sp = [];
  for (let i = 0; i < 1400; i++) {
    const a = Math.random() * Math.PI * 2, y = 0.06 + Math.random() * 0.94, r = Math.sqrt(1 - y * y);
    sp.push(Math.cos(a) * r * (R - 100), y * (R - 100), Math.sin(a) * r * (R - 100));
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  const stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: '#ffffff', size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
  stars.frustumCulled = false;
  scene.add(stars);

  const hemi = new THREE.HemisphereLight('#bcd6ff', '#6b5a48', 1.2);
  const sun = new THREE.DirectionalLight('#ffffff', 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  const sc = sun.shadow.camera;
  sc.left = -42; sc.right = 42; sc.top = 42; sc.bottom = -42; sc.near = 1; sc.far = 400;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.035;
  scene.add(hemi, sun, sun.target);

  scene.fog = V2 ? new THREE.Fog('#cfe3f0', V2_FOG.near, V2_FOG.far) : new THREE.Fog('#cfe3f0', 90, 460);

  const sunV = new THREE.Vector3(), moonV = new THREE.Vector3(), lightV = new THREE.Vector3();
  const xA = new THREE.Vector3(), yA = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), tmp = new THREE.Vector3();
  const warm = new THREE.Color('#ffd2a0'), white = new THREE.Color('#fff6ea'), moonC = new THREE.Color('#9fb6ff');
  const mBase = new THREE.Color('#3f6670'), mNight = new THREE.Color('#0b1022');
  const state = { day: 1 };
  const clouds = makeClouds(scene);
  if (V2) clouds.group.scale.setScalar(0.66);

  function update(minutes, focus, camera, rend) {
    const hr = ((minutes / 60) % 24 + 24) % 24;
    let k = 0;
    while (k < KEYS.length - 2 && hr >= KEYS[k + 1][0]) k++;
    const [h0, t0, z0] = KEYS[k], [h1, t1, z1] = KEYS[k + 1];
    const f = (hr - h0) / (h1 - h0);
    u.top.value.lerpColors(t0, t1, f);
    u.horizon.value.lerpColors(z0, z1, f);
    scene.fog.color.copy(u.horizon.value);
    // v2: below the horizon the dome is the fog, so the sea fades straight into it at the far plane
    if (V2) u.bottom.value.copy(u.horizon.value);

    const sf = (minutes % 1440 - 360) / 780;
    const th = Math.PI * sf;
    sunV.set(Math.cos(th), Math.sin(th), 0.42).normalize();
    const mf = (((minutes % 1440) - 1140 + 1440) % 1440) / 660;
    const tm = Math.PI * mf;
    moonV.set(-Math.cos(tm) * 0.9, Math.sin(tm), -0.38).normalize();
    u.sunDir.value.copy(sunV);
    u.moonDir.value.copy(moonV);

    const day = smooth(-0.06, 0.22, sunV.y);
    state.day = day;
    u.sunVis.value = smooth(-0.1, 0.02, sunV.y);
    u.moonVis.value = (1 - day) * smooth(-0.05, 0.1, moonV.y);
    stars.material.opacity = Math.max(0, 1 - day * 1.6) * 0.9;

    if (day > 0.02) {
      lightV.copy(sunV);
      sun.color.lerpColors(warm, white, smooth(0.08, 0.5, sunV.y));
      sun.intensity = 3.1 * day;
    } else {
      lightV.copy(moonV.y > 0.05 ? moonV : tmp.set(0.3, 1, 0.2).normalize());
      sun.color.copy(moonC);
      sun.intensity = V2 ? V2_NIGHT.moon : 0.32;
    }
    hemi.intensity = 0.5 + 0.87 * day + V2_NIGHT.fillK * (1 - day);
    hemi.color.copy(u.top.value).lerp(white, 0.45);
    if (V2) hemi.color.lerp(V2_NIGHT.fill, 1 - day);
    scene.environmentIntensity = 0.18 + 0.82 * day;
    nightExposure(rend, day);

    // keep the shadow map centred on the player and snapped to texels so edges don't shimmer
    const texel = (sc.right - sc.left) / sun.shadow.mapSize.x;
    xA.crossVectors(up, lightV).normalize();
    yA.crossVectors(lightV, xA).normalize();
    const fx = focus.dot(xA), fy = focus.dot(yA);
    tmp.copy(focus).addScaledVector(xA, Math.round(fx / texel) * texel - fx).addScaledVector(yA, Math.round(fy / texel) * texel - fy);
    sun.target.position.copy(tmp);
    sun.position.copy(tmp).addScaledVector(lightV, 180);
    sun.target.updateMatrixWorld();

    dome.position.copy(camera.position);
    stars.position.copy(camera.position);
    clouds.update(camera.position, day, 0);

    if (mountains.mat) mountains.mat.color.lerpColors(mNight, mBase, day).lerp(u.horizon.value, 0.55);
    return day;
  }
  return { update, sun, hemi, state };
}

// the high tier: physical sky, the sky itself lights and reflects in everything (re-baked as the sun moves),
// exponential haze, bigger sharper shadows
export function makeSkyHigh(scene, { shadowSize = 3072 } = {}) {
  const sky = physicalSky();
  sky.scale.setScalar(3000);
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  scene.add(sky);
  const su = sky.material.uniforms;
  const clouds = makeClouds(scene);

  const sp = [];
  for (let i = 0; i < 1400; i++) {
    const a = Math.random() * Math.PI * 2, y = 0.06 + Math.random() * 0.94, r = Math.sqrt(1 - y * y);
    sp.push(Math.cos(a) * r * 1400, y * 1400, Math.sin(a) * r * 1400);
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  const stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: '#ffffff', size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
  stars.frustumCulled = false;
  stars.renderOrder = -9;
  scene.add(stars);

  const hemi = new THREE.HemisphereLight('#a9d4ff', '#8a7a62', 0.6);
  const sun = new THREE.DirectionalLight('#ffffff', 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  sun.shadow.intensity = 0.72;      // cartoon shadows: soft and see-through, never black
  const sc = sun.shadow.camera;
  sc.left = -64; sc.right = 64; sc.top = 64; sc.bottom = -64; sc.near = 1; sc.far = 420;
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 2.5;
  scene.add(hemi, sun, sun.target);
  scene.fog = new THREE.FogExp2('#cfe3f0', 0.0026);

  // a small copy of the sky (same material) over a warm ground, baked into the scene's lighting map
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(sky.geometry, sky.material);
  envSky.scale.setScalar(50);
  envScene.add(envSky);
  const groundMat = new THREE.MeshBasicMaterial({ color: '#5f574e', side: THREE.DoubleSide });
  const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 24), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -3;
  envScene.add(ground);
  let pm = null, envRT = null, envSun = new THREE.Vector3(9, 9, 9), envT = -1;

  const sunV = new THREE.Vector3(), moonV = new THREE.Vector3(), lightV = new THREE.Vector3();
  const xA = new THREE.Vector3(), yA = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), tmp = new THREE.Vector3();
  const warm = new THREE.Color('#ffc890'), white = new THREE.Color('#fff4e4'), moonC = new THREE.Color('#9fb6ff');
  const mBase = new THREE.Color('#3f6670'), mNight = new THREE.Color('#0b1022');
  const haze = new THREE.Color(), dayHaze = new THREE.Color(V2 ? '#9cc6e8' : '#bfdcf2'), goldHaze = new THREE.Color('#f6b993');
  const state = { day: 1, golden: 0 };

  function update(minutes, focus, camera, rend) {
    const hr = ((minutes / 60) % 24 + 24) % 24;
    let k = 0;
    while (k < KEYS.length - 2 && hr >= KEYS[k + 1][0]) k++;
    const [h0, t0, z0] = KEYS[k], [h1, t1, z1] = KEYS[k + 1];
    const f = (hr - h0) / (h1 - h0);
    su.nTop.value.lerpColors(t0, t1, f);
    su.nHorizon.value.lerpColors(z0, z1, f);

    const sf = (minutes % 1440 - 360) / 780;
    const th = Math.PI * sf;
    sunV.set(Math.cos(th), Math.sin(th), 0.42).normalize();
    const mf = (((minutes % 1440) - 1140 + 1440) % 1440) / 660;
    const tm = Math.PI * mf;
    moonV.set(-Math.cos(tm) * 0.9, Math.sin(tm), -0.38).normalize();
    su.sunPosition.value.copy(sunV);
    su.moonDir.value.copy(moonV);

    const day = smooth(-0.06, 0.22, sunV.y);
    const golden = smooth(0.42, 0.06, sunV.y) * smooth(-0.1, 0.03, sunV.y);
    state.day = day; state.golden = golden;
    su.dayMix.value = smooth(-0.16, 0.04, sunV.y);
    if (V2) su.clear.value = su.dayMix.value * (1 - golden);
    su.moonVis.value = (1 - day) * smooth(-0.05, 0.1, moonV.y);
    stars.material.opacity = Math.max(0, 1 - day * 1.6) * 0.9;

    // haze: pale by day (on v2 a deeper blue, so far land and sea fade into sky colour, not white), peach at golden
    // hour, the old horizon colour at night
    haze.copy(dayHaze).lerp(goldHaze, golden * 0.8).lerp(su.nHorizon.value, 1 - su.dayMix.value);
    scene.fog.color.copy(haze);
    scene.fog.density = V2 ? V2_FOG.day + golden * V2_FOG.golden + (1 - day) * V2_FOG.night : 0.0008 + golden * 0.0008 + (1 - day) * 0.0008;
    su.hazeColor.value.copy(haze);

    if (day > 0.02) {
      lightV.copy(sunV);
      sun.color.lerpColors(warm, white, smooth(0.06, 0.5, sunV.y));
      sun.intensity = 3.0 * day;
    } else {
      lightV.copy(moonV.y > 0.05 ? moonV : tmp.set(0.3, 1, 0.2).normalize());
      sun.color.copy(moonC);
      sun.intensity = V2_NIGHT.moon;
    }
    // a strong cool sky fill keeps the shady sides bright and colourful (on v2 a moonlit blue after dark)
    hemi.intensity = 0.5 + 0.35 * day + V2_NIGHT.fillK * (1 - day);
    hemi.color.set('#a9d4ff').lerp(V2_NIGHT.fill || su.nTop.value, (1 - day) * (1 - V2_NIGHT.skyKeep));
    scene.environmentIntensity = 0.5 + 0.3 * day + V2_NIGHT.env * (1 - day);
    nightExposure(rend, day);
    groundMat.color.setRGB(0.37, 0.34, 0.3).multiplyScalar(0.08 + 0.92 * day);

    // re-bake the lighting map when the sun has moved enough (at most twice a second)
    const now = performance.now();
    if (rend && (envSun.distanceTo(sunV) > 0.025 || envT < 0) && now - envT > 500) {
      if (!pm) pm = new THREE.PMREMGenerator(rend);
      const rt = pm.fromScene(envScene, 0, 0.1, 200);
      if (envRT) envRT.dispose();
      envRT = rt;
      scene.environment = rt.texture;
      envSun.copy(sunV);
      envT = now;
    }

    const texel = (sc.right - sc.left) / sun.shadow.mapSize.x;
    xA.crossVectors(up, lightV).normalize();
    yA.crossVectors(lightV, xA).normalize();
    const fx = focus.dot(xA), fy = focus.dot(yA);
    tmp.copy(focus).addScaledVector(xA, Math.round(fx / texel) * texel - fx).addScaledVector(yA, Math.round(fy / texel) * texel - fy);
    sun.target.position.copy(tmp);
    sun.position.copy(tmp).addScaledVector(lightV, 200);
    sun.target.updateMatrixWorld();

    sky.position.copy(camera.position);
    stars.position.copy(camera.position);
    clouds.update(camera.position, su.dayMix.value, golden);

    if (mountains.mat) mountains.mat.color.lerpColors(mNight, mBase, day).lerp(haze, 0.6);
    return day;
  }
  return { update, sun, hemi, state };
}
