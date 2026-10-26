// Motion-captured movement for every person in the game: Quaternius' Universal Animation Library (CC0),
// retargeted onto our 17-bone skeleton by tools/blender/retarget_ual.py (assets/anims/ual.json + ual.bin).
//
// How it stays grounded (the techniques big studios use, in miniature):
// - Speed-matched cycles: walk, jog and sprint are blended by how fast the character really moves, and the
//   cycle's playback rate is scaled so the stride covers exactly the ground travelled (no ice-skating feet).
// - Phase sync: the cycles share one step clock, aligned on the moment the left foot lands, so blending a
//   walk into a jog never crosses the legs.
// - Snapshot transitions: when the state changes (jump, land, punch, fall) the last pose is frozen and eased
//   into the new one over a fraction of a second: no pops, and only the new state is evaluated.
// - Procedural touches on top: lean into turns (scaled by speed), an upper-body layer for punches and guns.

const BONES = ['hips', 'spine', 'chest', 'neck', 'head', 'armR', 'foreR', 'handR', 'armL', 'foreL', 'handL',
  'legR', 'shinR', 'footR', 'legL', 'shinL', 'footL'];
const NB = BONES.length, STRIDE = NB * 4 + 3;
const mask = (list) => { const m = new Float32Array(NB); for (const [n, w] of list) m[BONES.indexOf(n)] = w; return m; };
const ARMS = [['armR', 1], ['foreR', 1], ['handR', 1], ['armL', 1], ['foreL', 1], ['handL', 1]];
const UPPER = mask([['spine', 0.6], ['chest', 1], ['neck', 1], ['head', 1], ...ARMS]);   // punches, aiming: the whole upper body
const HANDS = mask([['chest', 0.3], ...ARMS]);                                          // a gun held while running: the arms only
const GUNMASK = new Float32Array(NB);

let lib = null;
export function loadAnims() {
  if (!lib) {
    lib = Promise.all([
      fetch('assets/anims/ual.json').then(r => { if (!r.ok) throw new Error(`ual.json: ${r.status}`); return r.json(); }),
      fetch('assets/anims/ual.bin').then(r => { if (!r.ok) throw new Error(`ual.bin: ${r.status}`); return r.arrayBuffer(); }),
    ]).then(([meta, buf]) => {
      const raw = new Int16Array(buf), clips = {};
      for (const [name, c] of Object.entries(meta.clips)) {
        const src = raw.subarray(c.at / 2, c.at / 2 + c.n * STRIDE), data = new Float32Array(src.length);
        for (let i = 0; i < c.n; i++) {
          const o = i * STRIDE;
          for (let k = 0; k < NB * 4; k++) data[o + k] = src[o + k] / meta.qs;
          for (let k = NB * 4; k < STRIDE; k++) data[o + k] = src[o + k] / meta.hs;
        }
        clips[name] = { name, ...c, data };
      }
      return clips;
    });
  }
  return lib;
}
let CLIPS = null;
loadAnims().then((c) => { CLIPS = c; }).catch((e) => console.warn('animations failed to load', e));
export const animsReady = () => !!CLIPS;

// ---------- poses: 17 quaternions + the hips' offset (in leg lengths) ----------

const newPose = () => new Float32Array(STRIDE);

// the pose of a clip at time t (seconds); loops wrap, one-shots hold their last frame
function sample(clip, t, out) {
  const n = clip.n, d = clip.data;
  let f;
  if (clip.loop) { f = ((t / clip.dur) % 1 + 1) % 1 * n; } else f = Math.min(1, Math.max(0, t / clip.dur)) * (n - 1);
  const i0 = Math.floor(f), a = f - i0;
  const i1 = clip.loop ? (i0 + 1) % n : Math.min(i0 + 1, n - 1);
  const o0 = (i0 % n) * STRIDE, o1 = i1 * STRIDE;
  for (let b = 0; b < NB; b++) {
    const k = b * 4;
    let x = d[o1 + k], y = d[o1 + k + 1], z = d[o1 + k + 2], w = d[o1 + k + 3];
    if (x * d[o0 + k] + y * d[o0 + k + 1] + z * d[o0 + k + 2] + w * d[o0 + k + 3] < 0) { x = -x; y = -y; z = -z; w = -w; }
    out[k] = d[o0 + k] + (x - d[o0 + k]) * a; out[k + 1] = d[o0 + k + 1] + (y - d[o0 + k + 1]) * a;
    out[k + 2] = d[o0 + k + 2] + (z - d[o0 + k + 2]) * a; out[k + 3] = d[o0 + k + 3] + (w - d[o0 + k + 3]) * a;
  }
  for (let k = NB * 4; k < STRIDE; k++) out[k] = d[o0 + k] + (d[o1 + k] - d[o0 + k]) * a;
  return normalize(out);
}
function normalize(p) {
  for (let k = 0; k < NB * 4; k += 4) {
    const l = Math.hypot(p[k], p[k + 1], p[k + 2], p[k + 3]) || 1;
    p[k] /= l; p[k + 1] /= l; p[k + 2] /= l; p[k + 3] /= l;
  }
  return p;
}
// out = a blended toward b by w (per bone weights from mask, if given); out may be a
function mix(out, a, b, w, mask = null) {
  for (let i = 0; i < NB; i++) {
    const t = mask ? w * mask[i] : w, k = i * 4;
    if (t <= 0) { if (out !== a) { out[k] = a[k]; out[k + 1] = a[k + 1]; out[k + 2] = a[k + 2]; out[k + 3] = a[k + 3]; } continue; }
    const s = a[k] * b[k] + a[k + 1] * b[k + 1] + a[k + 2] * b[k + 2] + a[k + 3] * b[k + 3] < 0 ? -t : t;
    for (let j = 0; j < 4; j++) out[k + j] = a[k + j] * (1 - t) + b[k + j] * s;
  }
  const t = mask ? 0 : w;   // the hips' position goes with the legs
  for (let k = NB * 4; k < STRIDE; k++) out[k] = a[k] + (b[k] - a[k]) * t;
  return normalize(out);
}
const smooth = (x) => x * x * (3 - 2 * x);

// ---------- one character's animator ----------

const CYCLES = ['walk', 'jog', 'sprint'];

export function makeAnimator(rig) {
  const P = { base: newPose(), tmp: newPose(), tmp2: newPose(), out: newPose(), snap: newPose(), layer: newPose() };
  const st = {
    phase: Math.random(), idleT: Math.random() * 3, speed: 0, loco: 0, air: 0, lean: 0, heading: null,
    snapT: 1, snapDur: 0.2, shot: null, upper: null, idle: 'idle', wasAir: false, hold: null,
  };
  const w = rig.world;
  const legLen = () => (w.legR[1] - w.footR[1]) * rig.height;   // hip to ankle in metres: a stride scales with it
  // freeze the current pose and ease out of it (call on any sudden change of state)
  function snapshot(dur = 0.2) { P.snap.set(P.out); st.snapT = 0; st.snapDur = dur; }

  return {
    get state() { return st; },
    // a one-shot over the whole body (death, get up, hit) or the upper body only (punches, reload, eat)
    play(name, { upper = false, from = 0, speed = 1, hold = false, out = 0.25 } = {}) {
      const c = CLIPS && CLIPS[name];
      if (!c) return 0;
      snapshot(upper ? 0.1 : 0.18);
      st.shot = { c, t: from * c.dur, speed, upper, hold, out };
      return c.dur;
    },
    stop(dur = 0.25) { if (st.shot) { snapshot(dur); st.shot = null; } },
    get playing() { return st.shot?.c.name || null; },
    // what the character does when standing: idle, talk, phone, fold_arms
    setIdle(name) { if (st.idle !== name && CLIPS?.[name]) { st.idle = name; if (st.loco < 0.5) snapshot(0.4); } },
    // speed: m/s over the ground; air: off the ground; turn: how fast the heading changes (rad/s);
    // pistol: { aim 0..1, pitch radians } while holding one (held ready, or raised along the aim)
    update(dt, { speed = 0, air = false, turn = 0, pistol = null } = {}) {
      if (!CLIPS) return false;
      // the measured speed is jittery (frame times vary): smooth it a little
      st.speed += (speed - st.speed) * Math.min(1, dt * 12);
      const v = st.speed, H = legLen();

      // standing: the idle loop on its own clock
      st.idleT += dt;
      sample(CLIPS[st.idle] || CLIPS.idle, st.idleT, P.base);

      // moving: walk / jog / sprint on one step clock, rate matched to the real speed
      const vs = CYCLES.map(n => CLIPS[n].speed * H);
      let i = 0;
      while (i < CYCLES.length - 2 && v > vs[i + 1]) i++;
      const wB = Math.min(1, Math.max(0, (v - vs[i]) / (vs[i + 1] - vs[i])));
      const A = CLIPS[CYCLES[i]], B = CLIPS[CYCLES[i + 1]];
      const natural = vs[i] * (1 - wB) + vs[i + 1] * wB, dur = A.dur * (1 - wB) + B.dur * wB;
      const rate = Math.min(1.45, Math.max(0.55, v / natural));
      st.phase = (st.phase + dt * rate / dur) % 1;
      const locoTarget = Math.min(1, Math.max(0, (v - 0.15) / 0.5));
      st.loco += (locoTarget - st.loco) * Math.min(1, dt * 10);
      if (st.loco > 0.001) {
        sample(A, (st.phase + A.land) * A.dur, P.tmp);
        if (wB > 0.001) { sample(B, (st.phase + B.land) * B.dur, P.tmp2); mix(P.tmp, P.tmp, P.tmp2, wB); }
        mix(P.base, P.base, P.tmp, smooth(st.loco));
      }

      // off the ground: the jump's in-air loop; back on the ground: the landing's impact
      if (air !== st.wasAir) {
        snapshot(air ? 0.12 : 0.08);
        if (!air && !st.shot) st.land = 0;
        st.wasAir = air;
      }
      if (air) { st.airT = (st.airT || 0) + dt; sample(CLIPS.jump_loop, st.airT + 0.4, P.tmp); P.base.set(P.tmp); }
      else st.airT = 0;
      if (st.land != null && !air) {
        // the first part of the landing (the knees take the weight), shorter when running on
        const len = v > 1 ? 0.28 : 0.55;
        st.land += dt;
        const k = st.land < len ? 1 : 1 - (st.land - len) / 0.2;
        if (k <= 0) st.land = null;
        else { sample(CLIPS.jump_land, 0.12 + st.land * 0.9, P.tmp); mix(P.base, P.base, P.tmp, smooth(Math.min(1, k)) * (v > 1 ? 0.55 : 1)); }
      }

      // a pistol: held ready at the chest, or raised along the aim (blending the level, up and down aims by pitch)
      if (pistol) {
        st.gunT = (st.gunT || 0) + dt;
        sample(CLIPS.pistol_idle, st.gunT, P.layer);
        sample(CLIPS.aim, 0, P.tmp);
        const up = pistol.pitch > 0;
        sample(up ? CLIPS.aim_up : CLIPS.aim_down, 0, P.tmp2);
        mix(P.tmp, P.tmp, P.tmp2, Math.min(1, Math.abs(pistol.pitch) / (up ? 1.25 : 1.0)));
        mix(P.layer, P.layer, P.tmp, smooth(Math.min(1, Math.max(0, pistol.aim))));
        // standing or aiming the whole upper body follows; running, only the arms (the torso keeps running)
        st.gunTorso = (st.gunTorso || 0) + ((pistol.aim > 0.3 || v < 1 ? 1 : 0) - (st.gunTorso || 0)) * Math.min(1, dt * 8);
        for (let i = 0; i < NB; i++) GUNMASK[i] = HANDS[i] + (UPPER[i] - HANDS[i]) * st.gunTorso;
        mix(P.base, P.base, P.layer, 1, GUNMASK);
      }

      // one-shots on top
      const s = st.shot;
      if (s) {
        s.t += dt * s.speed;
        sample(s.c, s.t, P.layer);
        const end = s.c.dur;
        let w = 1;
        if (!s.hold && s.t > end - s.out) w = Math.max(0, (end - s.t) / s.out);
        mix(P.base, P.base, P.layer, smooth(w), s.upper ? UPPER : null);
        if (!s.hold && s.t >= end) st.shot = null;
      }

      // ease out of the last state change
      if (st.snapT < st.snapDur) {
        st.snapT += dt;
        mix(P.out, P.snap, P.base, smooth(Math.min(1, st.snapT / st.snapDur)));
      } else P.out.set(P.base);

      // lean into turns, more the faster the character goes
      const leanT = Math.max(-0.32, Math.min(0.32, turn * Math.min(v, 9) * 0.03));
      st.lean += (leanT - st.lean) * Math.min(1, dt * 6);
      apply(rig, P.out, st.lean);
      return true;
    },
  };
}

function apply(rig, p, lean) {
  const b = rig.bones;
  for (let i = 0; i < NB; i++) b[BONES[i]].quaternion.set(p[i * 4], p[i * 4 + 1], p[i * 4 + 2], p[i * 4 + 3]);
  const w = rig.world.hips, h = rig.world.legR[1] - rig.world.footR[1], k = NB * 4;   // the offset is in leg lengths
  b.hips.position.set(w[0] + p[k] * h, w[1] + p[k + 1] * h, w[2] + p[k + 2] * h);
  const tilt = rig.root.children[0];
  if (tilt) tilt.rotation.x = lean;
}
