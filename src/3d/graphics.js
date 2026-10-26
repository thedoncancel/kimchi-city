import * as THREE from 'three';
import { EffectComposer } from '../../vendor/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../../vendor/addons/postprocessing/RenderPass.js';
import { Pass, FullScreenQuad } from '../../vendor/addons/postprocessing/Pass.js';
import { GTAOPass } from '../../vendor/addons/postprocessing/GTAOPass.js';
import { HIGH, MODE } from './quality.js';

// The camera's "film": bloom on bright lights, filmic tone mapping, then a colour grade and vignette, all in
// one finishing pass. Ambient occlusion (soft contact shadows where things meet) only on the Ultra level:
// on an M1 it costs ~18 ms a frame by itself. The low tier draws straight to screen.

// ambient occlusion that ignores see-through things (glass, light pools, markers) so they don't cast grime
class SoftAO extends GTAOPass {
  // ambient occlusion is soft by nature, so it's computed at half resolution (a quarter of the pixels)
  setSize(w, h) { super.setSize(Math.max(1, Math.floor(w / 2)), Math.max(1, Math.floor(h / 2))); }
  overrideVisibility() {
    const cache = this._visibilityCache;
    this.scene.traverse((o) => {
      cache.set(o, o.visible);
      if (o.isPoints || o.isLine || o.isSprite || o.userData.noAO || (o.material && (o.material.transparent || o.material.isMeshBasicMaterial))) o.visible = false;
    });
  }
}

const VERT = /* glsl */`
  precision highp float;
  uniform mat4 modelViewMatrix, projectionMatrix;
  attribute vec3 position; attribute vec2 uv;
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const quad = (fragmentShader, uniforms, defines = {}) =>
  new FullScreenQuad(new THREE.RawShaderMaterial({ vertexShader: VERT, fragmentShader, uniforms, defines, depthTest: false, depthWrite: false }));

// Bloom and finishing in one pass. The glow is made from the bright parts of the frame shrunk to a quarter and
// an eighth of the size and blurred there, so it costs well under a millisecond (UnrealBloomPass's full-size
// chain of a dozen passes took ~19 ms on an M1). Then: tone mapping, sRGB, saturation, contrast, warmth, vignette.
class FilmPass extends Pass {
  constructor() {
    super();
    const rt = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.q = [rt(), rt()]; this.e = [rt(), rt()];     // quarter and eighth size, two of each to blur back and forth
    this.bloom = true; this.strength = 0.25; this.threshold = 1.0;
    this.bright = quad(/* glsl */`
      precision highp float;
      uniform sampler2D src; uniform vec2 texel; uniform float threshold;
      varying vec2 vUv;
      void main() {
        // four bilinear taps cover the 4 x 4 pixels behind this one
        vec3 c = texture2D(src, vUv + texel * vec2(-1.0, -1.0)).rgb + texture2D(src, vUv + texel * vec2(1.0, -1.0)).rgb
               + texture2D(src, vUv + texel * vec2(-1.0, 1.0)).rgb + texture2D(src, vUv + texel * vec2(1.0, 1.0)).rgb;
        c *= 0.25;
        float l = max(c.r, max(c.g, c.b));
        gl_FragColor = vec4(c * smoothstep(threshold - 0.3, threshold + 0.3, l), 1.0);
      }`, { src: { value: null }, texel: { value: new THREE.Vector2() }, threshold: { value: 1 } });
    this.blur = quad(/* glsl */`
      precision highp float;
      uniform sampler2D src; uniform vec2 dir;
      varying vec2 vUv;
      void main() {
        // a 9-tap Gaussian in 5 bilinear taps
        vec3 c = texture2D(src, vUv).rgb * 0.2270270;
        c += (texture2D(src, vUv + dir * 1.3846154).rgb + texture2D(src, vUv - dir * 1.3846154).rgb) * 0.3162162;
        c += (texture2D(src, vUv + dir * 3.2307692).rgb + texture2D(src, vUv - dir * 3.2307692).rgb) * 0.0702703;
        gl_FragColor = vec4(c, 1.0);
      }`, { src: { value: null }, dir: { value: new THREE.Vector2() } });
    this.finish = quad(/* glsl */`
      precision highp float;
      uniform sampler2D tDiffuse, bloomA, bloomB;
      uniform float strength, warmth, contrast, saturation, vignette;
      uniform vec3 lift;
      varying vec2 vUv;
      #include <tonemapping_pars_fragment>
      #include <colorspace_pars_fragment>
      void main() {
        vec3 c = texture2D(tDiffuse, vUv).rgb;
        #ifdef BLOOM
          c += (texture2D(bloomA, vUv).rgb * 0.7 + texture2D(bloomB, vUv).rgb * 0.9) * strength;
        #endif
        c = ACESFilmicToneMapping(c);
        c = sRGBTransferOETF(vec4(c, 1.0)).rgb;
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(vec3(l), c, saturation);
        c = (c - 0.5) * contrast + 0.5;
        // warm highlights, cool lifted shadows: the "golden hour movie" look
        c += vec3(0.06, 0.025, -0.04) * warmth * smoothstep(0.35, 1.0, l);
        c += lift * (1.0 - l);
        vec2 d = vUv - 0.5;
        c *= 1.0 - vignette * dot(d, d) * 1.6;
        gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
      }`, {
      tDiffuse: { value: null }, bloomA: { value: null }, bloomB: { value: null }, strength: { value: 0.25 },
      toneMappingExposure: { value: 1 }, warmth: { value: 0 }, contrast: { value: 1.07 }, saturation: { value: 1.24 },
      vignette: { value: 0.16 }, lift: { value: new THREE.Vector3(0.006, 0.008, 0.02) },
    }, { BLOOM: '' });
    this.uniforms = this.finish.material.uniforms;
  }
  setSize(w, h) {
    const qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);
    for (const t of this.q) t.setSize(qw, qh);
    for (const t of this.e) t.setSize(Math.max(1, qw >> 1), Math.max(1, qh >> 1));
  }
  blurInto(renderer, [a, b]) {
    const u = this.blur.material.uniforms;
    u.src.value = a.texture; u.dir.value.set(1 / a.width, 0);
    renderer.setRenderTarget(b); this.blur.render(renderer);
    u.src.value = b.texture; u.dir.value.set(0, 1 / b.height);
    renderer.setRenderTarget(a); this.blur.render(renderer);
  }
  render(renderer, writeBuffer, readBuffer) {
    const u = this.uniforms;
    if (this.bloom) {
      const b = this.bright.material.uniforms;
      // the bright parts, at a quarter size, then an eighth (from the quarter), each blurred
      b.src.value = readBuffer.texture; b.texel.value.set(1 / readBuffer.width, 1 / readBuffer.height); b.threshold.value = this.threshold;
      renderer.setRenderTarget(this.q[0]); this.bright.render(renderer);
      b.src.value = this.q[0].texture; b.texel.value.set(0.5 / this.q[0].width, 0.5 / this.q[0].height); b.threshold.value = 0;
      renderer.setRenderTarget(this.e[0]); this.bright.render(renderer);
      this.blurInto(renderer, this.q);
      this.blurInto(renderer, this.e);
      this.blurInto(renderer, this.e);
      u.bloomA.value = this.q[0].texture; u.bloomB.value = this.e[0].texture;
    }
    const m = this.finish.material;
    if (('BLOOM' in m.defines) !== this.bloom) { m.defines = this.bloom ? { BLOOM: '' } : {}; m.needsUpdate = true; }
    u.tDiffuse.value = readBuffer.texture;
    u.strength.value = this.strength;
    u.toneMappingExposure.value = renderer.toneMappingExposure;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.finish.render(renderer);
  }
}

// Quality levels: [pixel ratio cap, ambient occlusion, bloom, shadow map size]. 0 is Ultra (for strong graphics
// cards; Auto only climbs there when the GPU clock says there's plenty of room).
const LEVELS = [[1.5, true, true, 4096], [1.25, false, true, 3072], [1.0, false, true, 2048], [0.85, false, true, 2048], [0.7, false, false, 1536]];
const NAMES = ['Ultra', 'High', 'Medium', 'Low', 'Lowest'];
const LEVEL_KEY = 'kc-gfx-level2';
const START = 2;

// Auto quality. Where the browser can time the graphics card (EXT_disjoint_timer_query_webgl2, Chrome on a
// Mac can), it keeps the GPU's share of a frame under ~12 ms: steps down a notch when over, back up when there
// is lots of room (never up to a level that already proved too slow this visit). Elsewhere it watches the
// frame rate and steps down when frames start missing the screen's refresh.
export function makeGraphics(renderer, scene, camera, { onResolution } = {}) {
  if (!HIGH) {
    return { render: () => renderer.render(scene, camera), setSize() {}, setLook() {}, adapt() {}, level: -1, name: 'Phone', gpuMs: 0 };
  }
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 2 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const ao = new SoftAO(scene, camera, size.x, size.y);
  ao.blendIntensity = 0.85;
  ao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: 8 });
  ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, rings: 2, samples: 8 });
  composer.addPass(ao);
  const film = new FilmPass();
  composer.addPass(film);

  // the GPU clock: one query in flight per frame, read back a frame or two later
  const gl = renderer.getContext();
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const pending = [];
  let gpuSamples = [];
  function pollTimer() {
    while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
      const q = pending.shift();
      if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) gpuSamples.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
    }
  }

  // start where this computer settled last time (and never climb past what proved too slow there),
  // so it doesn't stutter its way down again on every visit
  let level = START, ceiling = 0, acc = 0, cool = 3, good = 0, probing = false, dts = [];
  try {
    if (MODE === 'auto') {
      const [l, c] = (localStorage.getItem(LEVEL_KEY) || '').split(',');
      if (l) { level = Math.max(0, Math.min(LEVELS.length - 1, +l || 0)); ceiling = Math.min(level, +c || 0); }
    } else level = 1;
  } catch (e) {}
  function apply() {
    const sun = api.sun;
    if (MODE === 'auto') try { localStorage.setItem(LEVEL_KEY, `${level},${ceiling}`); } catch (e) {}
    const [pr, useAO, useBloom, shadow] = LEVELS[level];
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pr));
    ao.enabled = useAO;
    film.bloom = useBloom;
    if (sun && sun.shadow.mapSize.x !== shadow) {
      sun.shadow.mapSize.set(shadow, shadow);
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
    gpuSamples = []; dts = [];
    if (onResolution) onResolution();
  }
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const step = (d) => { level = Math.max(0, Math.min(LEVELS.length - 1, level + d)); good = 0; cool = 1.5; apply(); };
  const api = {
    sun: null,
    gpuMs: 0,
    get level() { return level; },
    get name() { return NAMES[level]; },
    get timed() { return !!timer; },
    setLevel(l) { level = Math.max(0, Math.min(LEVELS.length - 1, l)); apply(); },
    // call once per real frame with the real time since the last one (seconds)
    adapt(dt) {
      if (timer) pollTimer();
      if (cool > 0) { cool -= dt; gpuSamples = []; dts = []; return; }   // let shader compiles and loading settle first
      acc += dt; dts.push(dt);
      if (acc < 1.5) return;
      acc = 0;
      const frames = dts, gpu = gpuSamples.length >= 10 ? median(gpuSamples) : 0;
      dts = []; gpuSamples = [];
      api.gpuMs = gpu;
      if (MODE === 'high') return;
      if (gpu) {
        if (gpu > 12) {
          if (probing) ceiling = Math.min(LEVELS.length - 1, level + 1);   // the level we just tried is too much
          probing = false;
          if (level < LEVELS.length - 1) step(1);
        } else if (gpu < 5.5 && level > ceiling) {
          if (++good >= 3) { step(-1); probing = true; }
        } else { good = 0; probing = false; }
        return;
      }
      // no GPU clock: count frames that missed the refresh (the quickest quarter of frames ~ the screen's rate)
      const base = [...frames].sort((x, y) => x - y)[Math.floor(frames.length / 4)];
      const missed = frames.filter(f => f > base * 1.5).length / frames.length;
      if ((missed > 0.12 || base > 0.03) && level < LEVELS.length - 1) step(1);
    },
    render() {
      if (timer && pending.length < 4) {
        const q = gl.createQuery();
        gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
        composer.render();
        gl.endQuery(timer.TIME_ELAPSED_EXT);
        pending.push(q);
      } else composer.render();
    },
    passes: { ao, film, composer },
    setSize(w, h) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    },
    // day: 0 night .. 1 noon; golden: 0..1 near sunrise and sunset
    setLook(day, golden) {
      film.uniforms.warmth.value = 0.2 + golden * 0.8;
      film.strength = 0.22 + (1 - day) * 0.4;
      film.threshold = 0.85 + day * 0.35;
    },
  };
  queueMicrotask(apply);
  return api;
}
