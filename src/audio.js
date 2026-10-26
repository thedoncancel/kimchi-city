let ac = null;
export function audio() {
  if (!ac) {
    try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ac = null; }
  }
  if (ac && ac.state === 'suspended') ac.resume();
  return ac;
}

function beep(freq, dur, type = 'square', vol = 0.05, slide = 0) {
  const a = audio();
  if (!a) return;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, a.currentTime);
  if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, a.currentTime + dur);
  g.gain.setValueAtTime(vol, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
  o.connect(g).connect(a.destination);
  o.start();
  o.stop(a.currentTime + dur);
}

// a soft engine hum whose pitch follows the car's speed (0..1)
let eng = null;
export const engine = {
  set(on, rpm = 0) {
    const a = audio();
    if (!a) return;
    if (!eng) {
      const o1 = a.createOscillator(), o2 = a.createOscillator();
      const f = a.createBiquadFilter(), g = a.createGain();
      o1.type = 'sawtooth'; o2.type = 'square';
      f.type = 'lowpass'; f.frequency.value = 520;
      g.gain.value = 0;
      o1.connect(f); o2.connect(f); f.connect(g).connect(a.destination);
      o1.start(); o2.start();
      eng = { o1, o2, f, g };
    }
    const t = a.currentTime;
    eng.g.gain.setTargetAtTime(on ? 0.018 + rpm * 0.02 : 0, t, 0.12);
    eng.o1.frequency.setTargetAtTime(42 + rpm * 110, t, 0.06);
    eng.o2.frequency.setTargetAtTime(21 + rpm * 55, t, 0.06);
    eng.f.frequency.setTargetAtTime(380 + rpm * 900, t, 0.08);
  },
};

export const sfx = {
  unlock() { audio(); },
  coin() { beep(880, 0.08); setTimeout(() => beep(1320, 0.14), 70); },
  horn() { beep(330, 0.35, 'sawtooth', 0.04); beep(415, 0.35, 'sawtooth', 0.035); },
  click() { beep(620, 0.04, 'triangle', 0.05); },
  door() { beep(220, 0.14, 'triangle', 0.06, 1.6); },
  bump() { beep(95, 0.18, 'sawtooth', 0.07, 0.5); },
  fail() { beep(320, 0.35, 'square', 0.04, 0.5); },
  yay() { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => beep(f, 0.13), i * 90)); },
  pop() { beep(500, 0.06, 'sine', 0.06, 2); },
};
