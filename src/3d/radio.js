import { audio } from '../audio.js';
import { mulberry32 } from '../util.js';

// Car radio. Every station is composed on the fly with Web Audio: drums, bass, chords and a melody
// generated from a seed, with phrases that repeat so it sounds like a song rather than noise.

export const STATIONS = [
  { name: 'K-BEAT FM 102.7', tag: 'Non-stop Kimchi City hits', bpm: 122, swing: 0, play: kbeat, lp: 9000 },
  { name: 'LUXE 101.1', tag: 'trap for the drive home', bpm: 140, swing: 0, play: luxe, lp: 7000 },
  { name: 'LO-FI SEOUL 88.1', tag: 'beats to deliver kimchi to', bpm: 80, swing: 0.2, play: lofi, lp: 2600 },
  { name: 'TROT 99.1', tag: "your halmeoni's favourite", bpm: 132, swing: 0, play: trot, lp: 6000 },
];

const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
const R = { station: Math.floor(Math.random() * STATIONS.length), on: false, bus: null, master: null, next: 0, step: 0, bar: 0, noise: null };

function out() {
  const a = audio();
  if (!R.master) {
    R.master = a.createGain();
    R.master.gain.value = 0.15;
    const lp = a.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 9000;
    R.master.connect(lp).connect(a.destination);
    R.lp = lp;
  }
  return R.master;
}

function newBus() {
  const a = audio();
  if (R.bus) {
    const old = R.bus;
    old.gain.setTargetAtTime(0, a.currentTime, 0.06);
    setTimeout(() => old.disconnect(), 800);
  }
  R.bus = a.createGain();
  R.bus.gain.value = 1;
  R.bus.connect(out());
  R.lp.frequency.setTargetAtTime(STATIONS[R.station]?.lp || 9000, a.currentTime, 0.05);
}

function noiseSrc(a) {
  if (!R.noise) {
    R.noise = a.createBuffer(1, a.sampleRate, a.sampleRate);
    const d = R.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = a.createBufferSource();
  s.buffer = R.noise;
  return s;
}

// ---------- instruments ----------

function env(g, t, v, a, d, sus, end) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(v, t + a);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, v * sus), t + a + d);
  g.gain.setValueAtTime(Math.max(0.0001, v * sus), Math.max(t + a + d, end - 0.03));
  g.gain.exponentialRampToValueAtTime(0.0001, end + 0.06);
}

const I = {
  kick(t, v = 0.9) {
    const a = audio(), o = a.createOscillator(), g = a.createGain();
    o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(R.bus); o.start(t); o.stop(t + 0.32);
  },
  snare(t, v = 0.32, tone = 1800) {
    const a = audio(), n = noiseSrc(a), f = a.createBiquadFilter(), g = a.createGain();
    f.type = 'bandpass'; f.frequency.value = tone; f.Q.value = 0.8;
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.17);
    n.connect(f).connect(g).connect(R.bus); n.start(t, Math.random() * 0.5); n.stop(t + 0.2);
    const o = a.createOscillator(), og = a.createGain();
    o.type = 'triangle'; o.frequency.value = 190;
    og.gain.setValueAtTime(v * 0.6, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    o.connect(og).connect(R.bus); o.start(t); o.stop(t + 0.1);
  },
  clap(t, v = 0.3) {
    const a = audio(), n = noiseSrc(a), f = a.createBiquadFilter(), g = a.createGain();
    f.type = 'bandpass'; f.frequency.value = 1300; f.Q.value = 1.2;
    g.gain.setValueAtTime(0.0001, t);
    for (const d of [0, 0.011, 0.022]) { g.gain.setValueAtTime(v, t + d); g.gain.exponentialRampToValueAtTime(v * 0.2, t + d + 0.009); }
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    n.connect(f).connect(g).connect(R.bus); n.start(t, Math.random() * 0.5); n.stop(t + 0.18);
  },
  hat(t, v = 0.1, open = false) {
    const a = audio(), n = noiseSrc(a), f = a.createBiquadFilter(), g = a.createGain();
    f.type = 'highpass'; f.frequency.value = 7200;
    const len = open ? 0.2 : 0.045;
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
    n.connect(f).connect(g).connect(R.bus); n.start(t, Math.random() * 0.5); n.stop(t + len + 0.02);
  },
  tone(t, m, dur, { type = 'sawtooth', v = 0.1, a = 0.01, d = 0.15, sus = 0.5, cut = 1800, q = 0.7, detune = 0, vib = 0, slideFrom = null } = {}) {
    const ac = audio(), f = ac.createBiquadFilter(), g = ac.createGain();
    f.type = 'lowpass'; f.frequency.value = cut; f.Q.value = q;
    f.connect(g).connect(R.bus);
    const oscs = detune ? [-detune, detune] : [0];
    for (const dt of oscs) {
      const o = ac.createOscillator();
      o.type = type;
      o.detune.value = dt;
      if (slideFrom != null) { o.frequency.setValueAtTime(midi(slideFrom), t); o.frequency.exponentialRampToValueAtTime(midi(m), t + 0.07); }
      else o.frequency.value = midi(m);
      if (vib) {
        const l = ac.createOscillator(), lg = ac.createGain();
        l.frequency.value = 5.8; lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(midi(m) * vib, t + Math.min(0.25, dur));
        l.connect(lg).connect(o.frequency); l.start(t); l.stop(t + dur + 0.1);
      }
      o.connect(f); o.start(t); o.stop(t + dur + 0.1);
    }
    env(g, t, v / oscs.length, a, d, sus, t + dur);
  },
  crackle(t) {
    const a = audio(), n = noiseSrc(a), f = a.createBiquadFilter(), g = a.createGain();
    f.type = 'highpass'; f.frequency.value = 2500;
    g.gain.setValueAtTime(0.06 + Math.random() * 0.08, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.012);
    n.connect(f).connect(g).connect(R.bus); n.start(t, Math.random() * 0.9); n.stop(t + 0.02);
  },
};

// ---------- melodies ----------

// a phrase is 32 sixteenth steps of [step, scale index, length] notes; phrases A B A C repeat
function phrase(seed, scale, chordTones, density) {
  const r = mulberry32(seed);
  const notes = [];
  let deg = 2 + Math.floor(r() * 3);
  for (let s = 0; s < 32;) {
    const strong = s % 4 === 0;
    if (r() < (strong ? density + 0.2 : density - 0.1)) {
      const len = r() < 0.5 ? 2 : r() < 0.6 ? 4 : r() < 0.5 ? 1 : 6;
      deg += Math.round((r() - 0.5) * 3.2);
      deg = Math.max(0, Math.min(scale.length - 1, deg));
      if (strong) {
        // land on a chord tone near where the melody is
        const ct = chordTones[Math.floor(s / 16)];
        let best = deg, bd = 99;
        scale.forEach((m, i) => { if (ct.includes(m % 12) && Math.abs(i - deg) < bd) { bd = Math.abs(i - deg); best = i; } });
        deg = best;
      }
      notes.push([s, deg, s >= 26 ? Math.max(len, 32 - s) : len]);
      s += len;
    } else s += strong ? 2 : 1;
  }
  return notes;
}
function melodyAt(st, bar, base, scale, chords, density) {
  const p = Math.floor(bar / 2) % 4;              // which phrase of A B A C
  const id = [0, 1, 0, 2][p];
  const key = `${st}:${id}:${Math.floor(bar / 8)}`;
  if (!R.mel || R.melKey !== key) {
    const c0 = chords[(Math.floor(bar / 2) * 2) % chords.length], c1 = chords[(Math.floor(bar / 2) * 2 + 1) % chords.length];
    R.mel = phrase(base + id * 101 + Math.floor(bar / 16) * 7, scale, [c0.map(m => m % 12), c1.map(m => m % 12)], density);
    R.melKey = key;
  }
  const half = (bar % 2) * 16;
  return R.mel.filter(n => n[0] >= half && n[0] < half + 16).map(n => [n[0] - half, scale[n[1]], n[2]]);
}

// ---------- stations ----------

function kbeat(step, bar, t, sd) {
  const prog = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]];       // Am F C G
  const roots = [45, 41, 48, 43];
  const c = prog[bar % 4], root = roots[bar % 4];
  if (step % 4 === 0) I.kick(t, 0.85);
  if (step === 4 || step === 12) I.clap(t, 0.28);
  if (step % 4 === 2) I.hat(t, bar % 2 && step === 14 ? 0.12 : 0.1, bar % 2 && step === 14);
  else if (step % 2 === 1) I.hat(t, 0.035);
  if (step % 2 === 0) I.tone(t, root + (step % 8 === 6 ? 12 : 0), sd * 1.6, { type: 'sawtooth', v: 0.17, cut: 520, d: 0.1, sus: 0.6 });
  if (step === 0) for (const m of c) I.tone(t, m, sd * 15, { type: 'sawtooth', v: 0.026, a: 0.08, d: 0.4, sus: 0.6, cut: 1300, detune: 9 });
  if ([3, 6, 11, 14].includes(step)) for (const m of c) I.tone(t, m + 12, sd * 0.9, { type: 'square', v: 0.016, d: 0.08, sus: 0.2, cut: 2600 });
  const section = bar % 16;
  if (section >= 4) {
    for (const [s, m, len] of melodyAt('kb', bar, 1201, [60, 62, 64, 67, 69, 72, 74, 76, 79], prog, 0.55)) {
      if (s === step) I.tone(t, m + 12, sd * len * 0.92, { type: 'square', v: 0.05, d: 0.1, sus: 0.55, cut: 3000, vib: 0.006 });
    }
  } else if (step % 2 === 0) {
    I.tone(t, c[(step / 2) % 3] + 24, sd * 0.8, { type: 'triangle', v: 0.04, d: 0.07, sus: 0.15, cut: 4000 });
  }
}

function luxe(step, bar, t, sd) {
  const prog = [[57, 60, 64], [53, 57, 60], [52, 55, 59], [52, 56, 59]];   // Am F Em E
  const roots = [33, 29, 28, 28];
  const c = prog[bar % 4], root = roots[bar % 4];
  // half-time drums: kick and 808 together, clap on the third beat, rolling hats
  if (step === 0 || step === 10 || (bar % 2 && step === 7)) {
    I.kick(t, 0.75);
    I.tone(t, root + 12, sd * 5, { type: 'sine', v: 0.3, a: 0.005, d: 0.7, sus: 0.45, cut: 380, slideFrom: step === 10 ? root + 19 : null });
  }
  if (step === 8) I.clap(t, 0.3);
  if (step % 2 === 0) I.hat(t, 0.055);
  if (bar % 2 === 1 && step >= 12) { I.hat(t, 0.045); I.hat(t + sd / 2, 0.035); }
  if (step === 0) for (const m of c) I.tone(t, m - 12, sd * 15, { type: 'sawtooth', v: 0.016, a: 0.2, d: 0.6, sus: 0.7, cut: 700, detune: 12 });
  if (step % 4 === 0) I.tone(t, c[(step / 4) % 3] + 12, sd * 3, { type: 'triangle', v: 0.05, d: 0.35, sus: 0.2, cut: 2600 });
  if (bar % 4 >= 2) {
    for (const [s, m, len] of melodyAt('lx', bar, 7101, [57, 60, 62, 64, 67, 69, 72], prog, 0.35)) {
      if (s === step) I.tone(t, m + 12, sd * len, { type: 'square', v: 0.03, d: 0.2, sus: 0.4, cut: 1800, vib: 0.004 });
    }
  }
}

function lofi(step, bar, t, sd) {
  const prog = [[53, 57, 60, 64], [53, 59, 64], [52, 55, 59, 62], [55, 61, 64, 70]];   // Dm9 G13 Cmaj9 A7b9
  const roots = [38, 43, 36, 45];
  const c = prog[bar % 4], root = roots[bar % 4];
  if (step === 0 || step === 10 || (bar % 2 && step === 7)) I.kick(t, 0.7);
  if (step === 4 || step === 12) I.snare(t, 0.16, 1100);
  if (step % 2 === 0) I.hat(t, 0.035 + Math.random() * 0.03);
  if (Math.random() < 0.5) I.crackle(t + Math.random() * sd);
  if (step === 0) I.tone(t, root, sd * 6, { type: 'triangle', v: 0.22, a: 0.01, d: 0.3, sus: 0.6, cut: 700 });
  if (step === 10) I.tone(t, root + 7, sd * 2, { type: 'triangle', v: 0.16, d: 0.2, sus: 0.5, cut: 700 });
  if (step === 0) c.forEach((m, i) => I.tone(t + i * 0.025, m, sd * 9, { type: 'sine', v: 0.05, a: 0.01, d: 0.8, sus: 0.35, cut: 2000 }));
  if (step === 10 && bar % 2 === 1) c.forEach(m => I.tone(t, m + 12, sd * 4, { type: 'triangle', v: 0.018, d: 0.3, sus: 0.3, cut: 1800 }));
  for (const [s, m, len] of melodyAt('lf', bar, 3301, [62, 64, 65, 67, 69, 72, 74, 76], prog, 0.32)) {
    if (s === step) I.tone(t, m, sd * len, { type: 'triangle', v: 0.06, a: 0.02, d: 0.3, sus: 0.4, cut: 1500 });
  }
}

function trot(step, bar, t, sd) {
  const prog = [[57, 60, 64], [57, 60, 64], [57, 62, 65], [57, 62, 65], [56, 59, 62, 64], [56, 59, 62, 64], [57, 60, 64], [57, 60, 64]];
  const roots = [45, 45, 38, 38, 40, 40, 45, 45];
  const c = prog[bar % 8], root = roots[bar % 8];
  if (step === 0 || step === 8) I.kick(t, 0.8);
  if (step === 4 || step === 12) I.snare(t, 0.22, 2000);
  if (step % 2 === 0) I.hat(t, 0.05);
  // "kung-jjak": bass on the beat, chord on the offbeat
  if (step === 0) I.tone(t, root, sd * 3, { type: 'sawtooth', v: 0.2, cut: 600, d: 0.12, sus: 0.5 });
  if (step === 8) I.tone(t, root + 7 - (root + 7 > 52 ? 12 : 0), sd * 3, { type: 'sawtooth', v: 0.2, cut: 600, d: 0.12, sus: 0.5 });
  if (step === 4 || step === 12) for (const m of c) I.tone(t, m, sd * 2, { type: 'square', v: 0.022, d: 0.1, sus: 0.3, cut: 1700 });
  let prev = R.prevNote ?? null;
  for (const [s, m, len] of melodyAt('tr', bar, 5501, [57, 60, 62, 64, 67, 69, 72, 74, 76], prog, 0.5)) {
    if (s === step) {
      I.tone(t, m + 12, sd * len * 0.96, { type: 'sawtooth', v: 0.07, a: 0.03, d: 0.2, sus: 0.7, cut: 2400, detune: 6, vib: 0.012, slideFrom: prev != null && Math.abs(prev - m) <= 5 ? prev + 12 : null });
      prev = m;
    }
  }
  R.prevNote = prev;
}

// ---------- control ----------

export const radio = {
  get name() { return R.station < 0 ? 'Radio off' : STATIONS[R.station].name; },
  get tag() { return R.station < 0 ? '' : STATIONS[R.station].tag; },
  next() {
    R.station = R.station + 1 >= STATIONS.length ? -1 : R.station + 1;
    if (R.on) this.restart();
    return this.name;
  },
  restart() {
    const a = audio();
    if (!a) return;
    newBus();
    R.next = a.currentTime + 0.08;
    R.step = 0;
    R.bar = Math.floor(Math.random() * 8) * 2;
    R.mel = null;
  },
  // call every frame; music plays while Kimchi is in a car
  update(inCar) {
    const a = audio();
    if (!a) return;
    if (inCar !== R.on) {
      R.on = inCar;
      if (inCar && R.station >= 0) this.restart();
      else if (!inCar && R.bus) { R.bus.gain.setTargetAtTime(0, a.currentTime, 0.1); R.bus = null; }
    }
    if (!R.on || R.station < 0 || !R.bus) return;
    const st = STATIONS[R.station];
    const sd = 60 / st.bpm / 4;
    if (R.next < a.currentTime - 0.2) R.next = a.currentTime + 0.05;   // fell behind (tab was hidden)
    while (R.next < a.currentTime + 0.2) {
      const swing = R.step % 2 === 1 ? st.swing * sd : 0;
      st.play(R.step, R.bar, R.next + swing, sd);
      R.next += sd;
      if (++R.step >= 16) { R.step = 0; R.bar++; }
    }
  },
  setVolume(v) { out().gain.value = v; },
};
