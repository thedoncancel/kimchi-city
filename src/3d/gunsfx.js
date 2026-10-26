import { audio } from '../audio.js';

// Synthesised action sounds: gunshots, explosions, punches, the police siren.

let noiseBuf = null;
function noise(a) {
  if (!noiseBuf) {
    noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = a.createBufferSource();
  s.buffer = noiseBuf;
  return s;
}

function burst({ vol = 0.3, dur = 0.18, lp = 3000, hp = 200, thump = 90, thumpVol = 0.5, decay = 0.08 } = {}) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  const n = noise(a), f1 = a.createBiquadFilter(), f2 = a.createBiquadFilter(), g = a.createGain();
  f1.type = 'lowpass'; f1.frequency.setValueAtTime(lp, t); f1.frequency.exponentialRampToValueAtTime(Math.max(200, lp * 0.15), t + dur);
  f2.type = 'highpass'; f2.frequency.value = hp;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
  n.connect(f1).connect(f2).connect(g).connect(a.destination);
  n.start(t, Math.random() * 0.5); n.stop(t + dur + 0.02);
  if (thump) {
    const o = a.createOscillator(), og = a.createGain();
    o.frequency.setValueAtTime(thump, t); o.frequency.exponentialRampToValueAtTime(thump * 0.35, t + decay * 2);
    og.gain.setValueAtTime(thumpVol * vol * 2, t); og.gain.exponentialRampToValueAtTime(0.0008, t + decay * 2.5);
    o.connect(og).connect(a.destination);
    o.start(t); o.stop(t + decay * 3);
  }
}

function click(freq = 2400, vol = 0.08, dur = 0.03) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime, o = a.createOscillator(), g = a.createGain();
  o.type = 'square'; o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
  o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.01);
}

export const gunSfx = {
  shot(w, dist = 0) {
    const far = Math.max(0.12, 1 - dist / 90);
    if (w === 'shotgun') burst({ vol: 0.42, dur: 0.32, lp: 2200, thump: 70, thumpVol: 0.8, decay: 0.12 });
    else if (w === 'rifle') burst({ vol: 0.3, dur: 0.12, lp: 4200, hp: 300, thump: 110, thumpVol: 0.45, decay: 0.05 });
    else if (w === 'enemy') burst({ vol: 0.22 * far, dur: 0.16, lp: 2600 * far + 600, thump: 95, thumpVol: 0.4, decay: 0.06 });
    else burst({ vol: 0.32, dur: 0.18, lp: 3600, thump: 95, thumpVol: 0.5, decay: 0.07 });
  },
  reload() { click(1800, 0.07); setTimeout(() => click(1200, 0.08, 0.04), 260); setTimeout(() => click(2600, 0.06), 520); },
  empty() { click(3200, 0.05, 0.02); },
  swap() { click(900, 0.06, 0.05); setTimeout(() => click(1500, 0.05), 80); },
  swing() { burst({ vol: 0.12, dur: 0.16, lp: 1400, hp: 400, thump: 0 }); },
  hit() { burst({ vol: 0.2, dur: 0.1, lp: 700, hp: 60, thump: 70, thumpVol: 0.7, decay: 0.06 }); },
  boom() {
    burst({ vol: 0.55, dur: 1.4, lp: 1600, hp: 30, thump: 55, thumpVol: 1.2, decay: 0.35 });
    setTimeout(() => burst({ vol: 0.18, dur: 0.9, lp: 4000, hp: 800, thump: 0 }), 90);
  },
};

// one wailing siren, louder the closer the nearest police car is (0 = silent)
let siren = null;
export function setSiren(level) {
  const a = audio();
  if (!a) return;
  if (!siren) {
    const o = a.createOscillator(), lfo = a.createOscillator(), lg = a.createGain(), g = a.createGain(), f = a.createBiquadFilter();
    o.type = 'sawtooth'; o.frequency.value = 900;
    lfo.frequency.value = 0.45; lg.gain.value = 320;
    lfo.connect(lg).connect(o.frequency);
    f.type = 'lowpass'; f.frequency.value = 2400;
    g.gain.value = 0;
    o.connect(f).connect(g).connect(a.destination);
    o.start(); lfo.start();
    siren = { g };
  }
  siren.g.gain.setTargetAtTime(Math.min(1, level) * 0.045, a.currentTime, 0.15);
}
