import * as THREE from 'three';
import { mulberry32 } from '../util.js';
import { HIGH } from './quality.js';

// Everything here is painted on canvases at startup, so the game ships no image files besides Kimchi.

function mk(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

export let ANISO = 8;
export function setAniso(n) { ANISO = n; }

export function toTex(c, { repeat = true, color = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = ANISO;
  return t;
}

function speckle(x, w, h, n, cols, smin, smax, r, alpha = 1) {
  for (let i = 0; i < n; i++) {
    x.globalAlpha = alpha * (0.35 + r() * 0.65);
    x.fillStyle = cols[Math.floor(r() * cols.length)];
    const s = smin + r() * (smax - smin);
    x.fillRect(r() * w, r() * h, s, s);
  }
  x.globalAlpha = 1;
}

// soft round blotches that wrap around the tile edges, for large-scale wear that doesn't look tiled
function blotches(x, S, n, cols, rmin, rmax, r, alpha) {
  for (let i = 0; i < n; i++) {
    const px = r() * S, py = r() * S, rad = rmin + r() * (rmax - rmin), c = cols[Math.floor(r() * cols.length)];
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      const g = x.createRadialGradient(px + ox, py + oy, 0, px + ox, py + oy, rad);
      g.addColorStop(0, c); g.addColorStop(1, 'rgba(0,0,0,0)');
      x.globalAlpha = alpha * (0.4 + r() * 0.6);
      x.fillStyle = g; x.fillRect(px + ox - rad, py + oy - rad, rad * 2, rad * 2);
    }
  }
  x.globalAlpha = 1;
}

// cartoon asphalt: smooth cool grey with a few soft patches, hand-painted rather than gritty
export function asphalt(base = '#5d626b', seed = 1) {
  const S = 512;
  const [c, x] = mk(S);
  const r = mulberry32(seed);
  x.fillStyle = base; x.fillRect(0, 0, S, S);
  blotches(x, S, 10, ['rgba(70,76,88,.9)', 'rgba(120,126,136,.8)'], 80, 200, r, 0.14);
  speckle(x, S, S, 1600, ['#6c717a', '#50555e'], 2, 4, r, 0.35);
  return toTex(c);
}

// clean warm concrete slabs with crisp joints
export function sidewalk() {
  const S = 512;
  const [c, x] = mk(S);
  const r = mulberry32(2);
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
    const v = 226 + Math.floor((r() - 0.5) * 10);
    x.fillStyle = `rgb(${v},${v - 6},${v - 18})`;
    x.fillRect(i * 256, j * 256, 256, 256);
  }
  blotches(x, S, 6, ['rgba(255,250,240,.8)', 'rgba(200,190,170,.6)'], 60, 140, r, 0.3);
  x.fillStyle = 'rgba(150,140,124,.9)';
  x.fillRect(0, 0, S, 5); x.fillRect(0, 0, 5, S);
  x.fillRect(0, 254, S, 4); x.fillRect(254, 0, 4, S);
  return toTex(c);
}

// juicy cartoon lawn: saturated green, soft lighter and darker patches, painterly strokes
export function grass() {
  const S = 512;
  const [c, x] = mk(S);
  const r = mulberry32(3);
  x.fillStyle = '#58b03a'; x.fillRect(0, 0, S, S);
  blotches(x, S, 16, ['rgba(120,200,70,.9)', 'rgba(60,140,45,.9)', 'rgba(150,210,80,.7)'], 60, 150, r, 0.45);
  x.lineWidth = 2;
  for (let i = 0; i < 1400; i++) {
    const px = r() * S, py = r() * S;
    x.strokeStyle = r() < 0.5 ? 'rgba(60,130,40,.45)' : 'rgba(170,225,110,.45)';
    x.beginPath(); x.moveTo(px, py); x.quadraticCurveTo(px + 2, py - 5, px + (r() - 0.5) * 6, py - 9 - r() * 6); x.stroke();
  }
  return toTex(c);
}

export function plaza() {
  const [c, x] = mk(256);
  const r = mulberry32(4);
  x.fillStyle = '#c6b898'; x.fillRect(0, 0, 256, 256);
  for (let j = 0; j < 8; j++) for (let i = -1; i < 4; i++) {
    const off = (j % 2) * 32;
    const v = 216 + Math.floor((r() - 0.5) * 18);
    x.fillStyle = `rgb(${v},${v - 13},${v - 36})`;
    x.fillRect(i * 64 + off + 2, j * 32 + 2, 60, 28);
  }
  speckle(x, 256, 256, 900, ['#b7a684', '#e4d8bf'], 1, 2, r, 0.5);
  return toTex(c);
}

export function concrete(base = '#a9a59d', seed = 5) {
  const [c, x] = mk(128);
  const r = mulberry32(seed);
  x.fillStyle = base; x.fillRect(0, 0, 128, 128);
  speckle(x, 128, 128, 900, ['#96928a', '#bab6ae', '#8e8a83'], 1, 3, r, 0.6);
  return toTex(c);
}

export function roofGravel() {
  const [c, x] = mk(256);
  const r = mulberry32(6);
  x.fillStyle = '#d0ccc4'; x.fillRect(0, 0, 256, 256);
  speckle(x, 256, 256, 4000, ['#b8b3aa', '#e2ded6', '#a7a299', '#c4bfb6'], 1, 2.5, r, 0.8);
  for (let i = 0; i < 6; i++) {
    const g = x.createRadialGradient(r() * 256, r() * 256, 4, r() * 256, r() * 256, 50 + r() * 40);
    g.addColorStop(0, 'rgba(90,85,78,.18)'); g.addColorStop(1, 'rgba(90,85,78,0)');
    x.fillStyle = g; x.fillRect(0, 0, 256, 256);
  }
  return toTex(c);
}

// white-ish roof tiles; tinted per house with vertex colours
export function shingles() {
  const [c, x] = mk(128);
  const r = mulberry32(7);
  x.fillStyle = '#e8e8e8'; x.fillRect(0, 0, 128, 128);
  for (let j = 0; j < 8; j++) {
    const off = (j % 2) * 8;
    for (let i = -1; i < 9; i++) {
      const v = 220 + Math.floor((r() - 0.5) * 40);
      x.fillStyle = `rgb(${v},${v},${v})`;
      x.fillRect(i * 16 + off + 1, j * 16 + 1, 14, 14);
    }
    x.fillStyle = 'rgba(0,0,0,.28)'; x.fillRect(0, j * 16 + 13, 128, 3);
  }
  return toTex(c);
}

// 8x8 grid of window cells; each cell is 3 m wide and one 3.2 m floor tall.
// Returns the daytime colour map and the matching night emissive map.
export function facade() {
  const S = 512, C = 64;
  const [c, x] = mk(S);
  const [cl, xl] = mk(S);
  const r = mulberry32(8);
  x.fillStyle = '#f2efe9'; x.fillRect(0, 0, S, S);
  speckle(x, S, S, 5000, ['#e4e0d8', '#faf8f4', '#dcd7ce'], 1, 2, r, 0.5);
  xl.fillStyle = '#000'; xl.fillRect(0, 0, S, S);
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
    const X = i * C, Y = j * C;
    // floor line
    x.fillStyle = 'rgba(0,0,0,.07)'; x.fillRect(X, Y + C - 3, C, 3);
    const wx = X + 13, wy = Y + 12, ww = 38, wh = 38;
    x.fillStyle = '#d8d3ca'; x.fillRect(wx - 3, wy - 3, ww + 6, wh + 7);
    const g = x.createLinearGradient(wx, wy, wx + ww, wy + wh);
    g.addColorStop(0, '#6f8ea6'); g.addColorStop(0.55, '#a9c2d4'); g.addColorStop(1, '#7895ab');
    x.fillStyle = g; x.fillRect(wx, wy, ww, wh);
    const curtain = r();
    if (curtain < 0.3) { x.fillStyle = ['#e8d9b8', '#c9d6e3', '#e3c1b8'][Math.floor(r() * 3)]; x.fillRect(wx, wy, ww * (0.3 + r() * 0.4), wh); }
    x.fillStyle = 'rgba(255,255,255,.35)'; x.fillRect(wx + 3, wy + 3, 6, wh - 6);
    x.fillStyle = '#cfc9be'; x.fillRect(wx + ww / 2 - 1, wy, 2, wh);
    x.fillStyle = '#bdb6aa'; x.fillRect(wx - 4, wy + wh + 2, ww + 8, 4);
    // night: about half the windows have someone home
    const lit = r();
    if (lit < 0.55) {
      const tone = r();
      const col = tone < 0.12 ? ['#7fb2ff', '#b9d6ff'] : tone < 0.5 ? ['#ffb95a', '#ffe0a3'] : ['#ffd27a', '#fff0c8'];
      const gl = xl.createLinearGradient(wx, wy + wh, wx, wy);
      gl.addColorStop(0, col[0]); gl.addColorStop(1, col[1]);
      xl.fillStyle = gl; xl.fillRect(wx, wy, ww, wh);
      if (curtain < 0.3) { xl.fillStyle = 'rgba(0,0,0,.45)'; xl.fillRect(wx, wy, ww * 0.4, wh); }
      xl.fillStyle = 'rgba(0,0,0,.6)'; xl.fillRect(wx + ww / 2 - 1, wy, 2, wh);
    }
  }
  return { map: toTex(c), lit: toTex(cl) };
}

// ground-floor shop: one 6 m bay, 3.2 m tall
export function shopfront() {
  const [c, x] = mk(256, 128);
  const [cl, xl] = mk(256, 128);
  x.fillStyle = '#3a3532'; x.fillRect(0, 0, 256, 128);
  xl.fillStyle = '#000'; xl.fillRect(0, 0, 256, 128);
  // big window
  const g = x.createLinearGradient(0, 20, 0, 120);
  g.addColorStop(0, '#8aa6b8'); g.addColorStop(1, '#4d6474');
  x.fillStyle = g; x.fillRect(10, 22, 160, 96);
  // goods behind the glass
  const r = mulberry32(9);
  for (let i = 0; i < 18; i++) {
    x.fillStyle = ['#e85d5d', '#f2c230', '#5dbb7a', '#5d8de8', '#f08a2c', '#ffffff'][Math.floor(r() * 6)];
    x.globalAlpha = 0.55;
    x.fillRect(16 + r() * 140, 70 + r() * 40, 10 + r() * 14, 6 + r() * 10);
  }
  x.globalAlpha = 1;
  x.fillStyle = 'rgba(255,255,255,.28)'; x.fillRect(18, 26, 10, 88); x.fillRect(34, 26, 4, 88);
  // door
  x.fillStyle = '#2a2523'; x.fillRect(184, 26, 58, 102);
  x.fillStyle = '#7d98aa'; x.fillRect(190, 32, 46, 70);
  x.fillStyle = '#d9b44a'; x.fillRect(228, 78, 4, 10);
  // frames
  x.fillStyle = '#25211f'; x.fillRect(0, 0, 256, 20); x.fillRect(0, 118, 256, 10);
  // lit version
  const gl = xl.createLinearGradient(0, 22, 0, 118);
  gl.addColorStop(0, '#fff1c9'); gl.addColorStop(1, '#ffc86a');
  xl.fillStyle = gl; xl.fillRect(10, 22, 160, 96); xl.fillRect(190, 32, 46, 70);
  return { map: toTex(c), lit: toTex(cl) };
}

// a long shop window with shelves of goods behind the glass (one texture repeat = 6 m)
export function storeInterior(kind = 'mart') {
  const [c, x] = mk(512, 128);
  const [cl, xl] = mk(512, 128);
  const r = mulberry32({ mart: 13, auto: 14, boutique: 15, watch: 16, villa: 17 }[kind] || 18);
  const luxe = kind === 'boutique' || kind === 'watch' || kind === 'villa';
  x.fillStyle = luxe ? (kind === 'boutique' ? '#3a3026' : kind === 'villa' ? '#4a3f33' : '#16151a') : '#e9e4d6'; x.fillRect(0, 0, 512, 128);
  x.fillStyle = luxe ? '#1d1914' : '#d7d0bf'; x.fillRect(0, 96, 512, 32);
  if (kind === 'boutique') {
    // spot-lit shelves of handbags and folded fits
    for (let s = 0; s < 4; s++) {
      const sx = 16 + s * 128;
      const spot = x.createRadialGradient(sx + 48, 10, 4, sx + 48, 50, 90);
      spot.addColorStop(0, 'rgba(255,226,170,.55)'); spot.addColorStop(1, 'rgba(255,226,170,0)');
      x.fillStyle = spot; x.fillRect(sx - 20, 0, 140, 110);
      x.fillStyle = '#b8935a'; for (const y of [44, 78]) x.fillRect(sx, y, 96, 3);
      for (let i = 0; i < 3; i++) {
        x.fillStyle = ['#1b1b1b', '#8a5a2b', '#e9e2d4', '#2e3b2e', '#7a0f16'][Math.floor(r() * 5)];
        x.fillRect(sx + 8 + i * 30, 26, 22, 18); x.strokeStyle = '#c9a96e'; x.lineWidth = 2; x.beginPath(); x.arc(sx + 19 + i * 30, 26, 7, Math.PI, 0); x.stroke();
        x.fillStyle = ['#f4f1ea', '#1b1b1b', '#3d5a80'][Math.floor(r() * 3)]; x.fillRect(sx + 8 + i * 30, 66, 22, 12);
      }
    }
  } else if (kind === 'watch') {
    // glass vitrines with watches glittering under spotlights
    for (let s = 0; s < 3; s++) {
      const sx = 30 + s * 170;
      x.fillStyle = '#2a2830'; x.fillRect(sx, 60, 120, 40);
      x.fillStyle = 'rgba(190,220,255,.25)'; x.fillRect(sx, 40, 120, 22);
      for (let i = 0; i < 5; i++) {
        const wx = sx + 14 + i * 23;
        x.fillStyle = ['#d4af37', '#e9ebef', '#e9ebef', '#b56b45'][Math.floor(r() * 4)];
        x.beginPath(); x.arc(wx, 52, 6, 0, Math.PI * 2); x.fill();
        x.fillStyle = '#ffffff'; x.fillRect(wx - 1, 47, 2, 2);
      }
      const spot = x.createRadialGradient(sx + 60, 0, 4, sx + 60, 50, 80);
      spot.addColorStop(0, 'rgba(255,240,210,.5)'); spot.addColorStop(1, 'rgba(255,240,210,0)');
      x.fillStyle = spot; x.fillRect(sx - 20, 0, 160, 100);
    }
  } else if (kind === 'villa') {
    // a warm living room: long sofa, a floor lamp, art on the wall
    x.fillStyle = '#e9e1d3'; x.fillRect(0, 0, 512, 96);
    x.fillStyle = '#c9b9a0'; x.fillRect(40, 62, 230, 30); x.fillRect(40, 50, 230, 14);
    x.fillStyle = '#d8d0c2'; x.fillRect(320, 30, 70, 46);
    x.fillStyle = '#8f8676'; x.beginPath(); x.arc(355, 53, 14, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#3a3a3a'; x.fillRect(440, 20, 4, 76);
    const lamp = x.createRadialGradient(442, 22, 2, 442, 22, 60);
    lamp.addColorStop(0, 'rgba(255,214,150,.9)'); lamp.addColorStop(1, 'rgba(255,214,150,0)');
    x.fillStyle = lamp; x.fillRect(380, 0, 130, 90);
  } else if (kind === 'mart') {
    for (let s = 0; s < 4; s++) {
      const sx = 14 + s * 128;
      x.fillStyle = '#b9b2a2'; x.fillRect(sx, 18, 100, 80);
      for (let row = 0; row < 4; row++) {
        x.fillStyle = '#8f887a'; x.fillRect(sx, 30 + row * 18, 100, 3);
        for (let i = 0; i < 9; i++) {
          x.fillStyle = ['#e85d5d', '#f2c230', '#5dbb7a', '#5d8de8', '#f08a2c', '#ffffff', '#c06bd6'][Math.floor(r() * 7)];
          x.fillRect(sx + 3 + i * 11, 19 + row * 18, 8, 10);
        }
      }
    }
  } else {
    // the showroom: a dark polished floor and low supercars under spotlights
    x.fillStyle = '#1b1b1f'; x.fillRect(0, 0, 512, 128);
    x.fillStyle = '#2a2a30'; x.fillRect(0, 92, 512, 36);
    for (let s = 0; s < 2; s++) {
      const cx = 128 + s * 256;
      const spot = x.createRadialGradient(cx, 0, 6, cx, 70, 140);
      spot.addColorStop(0, 'rgba(255,236,200,.45)'); spot.addColorStop(1, 'rgba(255,236,200,0)');
      x.fillStyle = spot; x.fillRect(cx - 140, 0, 280, 128);
      x.fillStyle = ['#0e0e10', '#7a0f16'][s];
      x.beginPath(); x.moveTo(cx - 105, 96); x.lineTo(cx - 98, 80); x.quadraticCurveTo(cx - 20, 58, cx + 40, 66); x.lineTo(cx + 100, 80); x.lineTo(cx + 106, 96); x.closePath(); x.fill();
      x.fillStyle = '#2a3440'; x.beginPath(); x.moveTo(cx - 40, 68); x.quadraticCurveTo(cx - 5, 58, cx + 30, 66); x.lineTo(cx - 40, 70); x.fill();
      x.fillStyle = '#0a0a0a'; for (const w of [-64, 64]) { x.beginPath(); x.arc(cx + w, 96, 14, 0, Math.PI * 2); x.fill(); }
      x.fillStyle = '#c9a96e'; for (const w of [-64, 64]) { x.beginPath(); x.arc(cx + w, 96, 6, 0, Math.PI * 2); x.fill(); }
    }
  }
  // glass reflections
  const g = x.createLinearGradient(0, 0, 512, 128);
  const a = luxe ? 0.5 : 1;
  g.addColorStop(0, `rgba(160,205,230,${0.45 * a})`); g.addColorStop(0.5, `rgba(160,205,230,${0.15 * a})`); g.addColorStop(1, `rgba(160,205,230,${0.4 * a})`);
  x.fillStyle = g; x.fillRect(0, 0, 512, 128);
  x.strokeStyle = 'rgba(255,255,255,.4)'; x.lineWidth = 10;
  for (let i = 0; i < 4; i++) { x.beginPath(); x.moveTo(40 + i * 130, 128); x.lineTo(90 + i * 130, 0); x.stroke(); }
  // at night the shop glows
  xl.drawImage(c, 0, 0);
  xl.globalCompositeOperation = 'multiply';
  xl.fillStyle = '#ffd9a0'; xl.fillRect(0, 0, 512, 128);
  return { map: toTex(c), lit: toTex(cl) };
}

export function stripes(color) {
  const [c, x] = mk(64);
  x.fillStyle = '#fbf7ef'; x.fillRect(0, 0, 64, 64);
  x.fillStyle = color; x.fillRect(0, 0, 32, 64);
  x.fillStyle = 'rgba(0,0,0,.12)'; x.fillRect(0, 56, 64, 8);
  return toTex(c);
}

// shop signs packed in one atlas: 2 columns x 6 rows, each 512x64
export const SHOP_SIGNS = [
  ['CHICKEN 치킨', '#d6402b', '#fff7e0'], ['NORAEBANG 노래방', '#7b3fe4', '#ffe9ff'], ['PC BANG', '#1f7ae0', '#e6f3ff'],
  ['CAFE 카페', '#5b3a29', '#ffe8c7'], ['BOBA TEA', '#e86aa8', '#fff0f7'], ['BBQ 고기', '#2b2b2b', '#ffcc4d'],
  ['PHARMACY 약국', '#1b9e63', '#eafff3'], ['BAKERY 빵', '#e3a13a', '#3b2410'], ['MART24', '#0f7c8a', '#e9fdff'],
  ['HAIR SALON', '#222', '#f3c6ff'], ['ARCADE', '#ff4f8b', '#fff36b'], ['TTEOKBOKKI 떡볶이', '#c0262b', '#fff2d6'],
];
export function signAtlas() {
  const [c, x] = mk(1024, 384);
  SHOP_SIGNS.forEach(([text, bg, fg], i) => {
    const X = (i % 2) * 512, Y = Math.floor(i / 2) * 64;
    x.fillStyle = bg; x.fillRect(X, Y, 512, 64);
    x.fillStyle = 'rgba(255,255,255,.12)'; x.fillRect(X, Y, 512, 6);
    x.fillStyle = 'rgba(0,0,0,.25)'; x.fillRect(X, Y + 58, 512, 6);
    x.font = '900 40px "Apple SD Gothic Neo","Malgun Gothic",ui-rounded,system-ui,sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = fg; x.fillText(text, X + 256, Y + 33, 480);
  });
  return toTex(c, { repeat: false });
}

export const SERIF = '"Didot","Bodoni 72","Bodoni MT","Playfair Display","Times New Roman",Georgia,serif';
const goldFill = (x, h) => {
  const g = x.createLinearGradient(0, h * 0.2, 0, h * 0.8);
  g.addColorStop(0, '#f8e4a6'); g.addColorStop(0.5, '#d4af37'); g.addColorStop(1, '#a5822a');
  return g;
};
// fg 'gold' paints the letters with a gold gradient; serif switches to a fashion-house typeface
export function textSign(text, { bg = '#1b1512', fg = '#f6ead8', w = 512, h = 128, font = 900, size = 78, sub = null, border = null, serif = false, spacing = 0 } = {}) {
  const [c, x] = mk(w, h);
  x.fillStyle = bg; x.fillRect(0, 0, w, h);
  if (border) { x.strokeStyle = border === 'gold' ? goldFill(x, h) : border; x.lineWidth = 10; x.strokeRect(8, 8, w - 16, h - 16); }
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillStyle = fg === 'gold' ? goldFill(x, h) : fg;
  const fam = serif ? SERIF : '"Apple SD Gothic Neo","Malgun Gothic",ui-rounded,system-ui,sans-serif';
  x.font = `${serif ? 400 : font} ${size}px ${fam}`;
  if (spacing) x.letterSpacing = `${spacing}px`;
  x.fillText(text, w / 2, sub ? h * 0.4 : h / 2 + 4, w - 30);
  if (sub) {
    x.font = `${serif ? 500 : 800} ${Math.round(size * 0.36)}px ${serif ? '"Helvetica Neue",Helvetica,Arial,sans-serif' : fam}`;
    if (serif) x.letterSpacing = `${Math.round(size * 0.08)}px`;
    x.globalAlpha = 0.85; x.fillText(sub, w / 2, h * 0.78, w - 30); x.globalAlpha = 1;
  }
  return toTex(c, { repeat: false });
}

// a rooftop billboard: Kimchi on the left, gold lettering on the right
export function billboard(img) {
  const [c, x] = mk(1024, 512);
  const bg = x.createLinearGradient(0, 0, 1024, 512);
  bg.addColorStop(0, '#0d0d10'); bg.addColorStop(1, '#2a2418');
  x.fillStyle = bg; x.fillRect(0, 0, 1024, 512);
  const glow = x.createRadialGradient(250, 300, 20, 250, 300, 300);
  glow.addColorStop(0, 'rgba(212,175,55,.45)'); glow.addColorStop(1, 'rgba(212,175,55,0)');
  x.fillStyle = glow; x.fillRect(0, 0, 600, 512);
  if (img) {
    const h = 500, w = h * img.width / img.height;
    x.drawImage(img, 250 - w / 2, 512 - h + 10, w, h);
  }
  x.textAlign = 'left'; x.textBaseline = 'alphabetic';
  x.fillStyle = goldFill(x, 512);
  x.font = `400 150px ${SERIF}`;
  x.fillText('KIMCHI', 470, 250, 520);
  x.fillStyle = '#efe7d6';
  x.font = '600 34px "Helvetica Neue",Helvetica,Arial,sans-serif';
  x.letterSpacing = '10px';
  x.fillText('PROJECT KIMCHI', 476, 320, 520);
  x.globalAlpha = 0.7;
  x.font = '600 28px "Helvetica Neue",Helvetica,Arial,sans-serif';
  x.letterSpacing = '4px';
  x.fillText('@kimchi1x', 476, 380, 520);
  x.globalAlpha = 1;
  x.strokeStyle = goldFill(x, 512); x.lineWidth = 8; x.strokeRect(6, 6, 1012, 500);
  return toTex(c, { repeat: false });
}

// pale blue pool tiles with a few caustic ripples
export function poolTiles() {
  const [c, x] = mk(256);
  x.fillStyle = '#5ec8e5'; x.fillRect(0, 0, 256, 256);
  x.strokeStyle = 'rgba(255,255,255,.35)'; x.lineWidth = 1;
  for (let i = 0; i <= 256; i += 32) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 256); x.stroke(); x.beginPath(); x.moveTo(0, i); x.lineTo(256, i); x.stroke(); }
  const r = mulberry32(21);
  x.strokeStyle = 'rgba(255,255,255,.5)'; x.lineWidth = 2;
  for (let i = 0; i < 26; i++) {
    const px = r() * 256, py = r() * 256, w = 14 + r() * 30;
    x.beginPath(); x.moveTo(px, py); x.bezierCurveTo(px + w * 0.3, py - 6, px + w * 0.7, py + 6, px + w, py); x.stroke();
  }
  return toTex(c);
}

export function radialGlow() {
  const [c, x] = mk(128);
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  return toTex(c, { repeat: false });
}

// headlight pool on the road: bright near the car, fading and widening ahead
export function headlightPool() {
  const [c, x] = mk(128, 256);
  const g = x.createLinearGradient(0, 256, 0, 0);
  g.addColorStop(0, 'rgba(255,255,255,.95)'); g.addColorStop(0.5, 'rgba(255,255,255,.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.beginPath(); x.moveTo(44, 256); x.lineTo(84, 256); x.lineTo(128, 0); x.lineTo(0, 0); x.closePath(); x.fill();
  return toTex(c, { repeat: false });
}

export function beam() {
  const [c, x] = mk(32, 256);
  const g = x.createLinearGradient(0, 256, 0, 0);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 32, 256);
  return toTex(c, { repeat: false });
}

export function puff() {
  const [c, x] = mk(64);
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return toTex(c, { repeat: false });
}

export function water() {
  const [c, x] = mk(256);
  const r = mulberry32(11);
  x.fillStyle = '#2f7f9a'; x.fillRect(0, 0, 256, 256);
  x.strokeStyle = 'rgba(255,255,255,.18)'; x.lineWidth = 2;
  for (let i = 0; i < 60; i++) {
    const px = r() * 256, py = r() * 256, w = 10 + r() * 26;
    x.beginPath(); x.moveTo(px, py); x.quadraticCurveTo(px + w / 2, py - 4, px + w, py); x.stroke();
  }
  return toTex(c);
}

// Miami Art Deco facade: 8 x 8 cells, each one 3 m wide and one 3.2 m floor tall. Triple windows with a
// transom, white frames and sills on fine stucco. `rough` makes the glass glossy so it mirrors the sky.
// Window heads sit 0.55 m below each floor line (the eyebrow ledges in city.js line up with them).
export function decoFacade() {
  const S = 1024, C = 128, PX = C / 3.2;
  const [c, x] = mk(S), [cl, xl] = mk(S), [cr, xr] = mk(S);
  const r = mulberry32(19);
  x.fillStyle = '#f7f4ee'; x.fillRect(0, 0, S, S);
  blotches(x, S, 30, ['rgba(255,255,255,.9)', 'rgba(225,218,205,.7)'], 40, 120, r, 0.35);
  xl.fillStyle = '#000'; xl.fillRect(0, 0, S, S);
  xr.fillStyle = 'rgb(0,235,0)'; xr.fillRect(0, 0, S, S);
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
    const X = i * C, Y = j * C;
    const ww = Math.round(2.3 * PX), wh = Math.round(1.75 * PX);
    const wx = X + Math.round((C - ww) / 2), wy = Y + Math.round(0.55 * PX);
    // faint shadow line under the eyebrow and the floor joint
    x.fillStyle = 'rgba(0,0,0,.06)'; x.fillRect(X, wy - 10, C, 8);
    // frame
    x.fillStyle = '#fbfaf6'; x.fillRect(wx - 5, wy - 5, ww + 10, wh + 10);
    xr.fillStyle = 'rgb(0,120,0)'; xr.fillRect(wx - 5, wy - 5, ww + 10, wh + 10);
    // glass: dark, cool, a soft gradient; the reflection itself comes from the sky in the shader
    const g = x.createLinearGradient(wx, wy, wx, wy + wh);
    g.addColorStop(0, '#3f86c6');
    g.addColorStop(1, '#8fd0f0');
    x.fillStyle = g; x.fillRect(wx, wy, ww, wh);
    // the classic cartoon glass highlight: two diagonal streaks
    x.save(); x.beginPath(); x.rect(wx, wy, ww, wh); x.clip();
    x.fillStyle = 'rgba(255,255,255,.38)';
    const sx = wx + ww * (0.15 + r() * 0.4);
    x.beginPath(); x.moveTo(sx, wy + wh); x.lineTo(sx + 16, wy + wh); x.lineTo(sx + 16 + wh * 0.6, wy); x.lineTo(sx + wh * 0.6, wy); x.fill();
    x.beginPath(); x.moveTo(sx + 22, wy + wh); x.lineTo(sx + 28, wy + wh); x.lineTo(sx + 28 + wh * 0.6, wy); x.lineTo(sx + 22 + wh * 0.6, wy); x.fill();
    x.restore();
    xr.fillStyle = 'rgb(0,18,0)'; xr.fillRect(wx, wy, ww, wh);
    const blinds = r();
    if (blinds < 0.28) {
      // white venetian blinds part-way down
      const bh = wh * (0.25 + r() * 0.6);
      x.fillStyle = '#e9e5dc'; x.fillRect(wx, wy, ww, bh);
      x.fillStyle = 'rgba(0,0,0,.08)';
      for (let y = wy + 3; y < wy + bh; y += 4) x.fillRect(wx, y, ww, 1);
      xr.fillStyle = 'rgb(0,170,0)'; xr.fillRect(wx, wy, ww, bh);
    } else if (blinds < 0.4) {
      x.fillStyle = ['#d9c7a8', '#c3d3dc', '#e2c1bd'][Math.floor(r() * 3)]; x.fillRect(wx, wy, ww * (0.25 + r() * 0.3), wh);
    }
    // mullions and transom
    x.fillStyle = '#f7f5f0'; xr.fillStyle = 'rgb(0,120,0)';
    for (const f of [1 / 3, 2 / 3]) { x.fillRect(wx + ww * f - 2, wy, 4, wh); xr.fillRect(wx + ww * f - 2, wy, 4, wh); }
    x.fillRect(wx, wy + wh * 0.26, ww, 3); xr.fillRect(wx, wy + wh * 0.26, ww, 3);
    // sill with a little shadow under it
    x.fillStyle = '#ffffff'; x.fillRect(wx - 9, wy + wh + 4, ww + 18, 6);
    x.fillStyle = 'rgba(0,0,0,.12)'; x.fillRect(wx - 9, wy + wh + 10, ww + 18, 4);
    // night
    const lit = r();
    if (lit < 0.5) {
      const tone = r();
      const cc = tone < 0.15 ? ['#86b6ff', '#c2dcff'] : tone < 0.55 ? ['#ffb760', '#ffe3a8'] : ['#ffd384', '#fff2cf'];
      const gl = xl.createLinearGradient(wx, wy + wh, wx, wy);
      gl.addColorStop(0, cc[0]); gl.addColorStop(1, cc[1]);
      xl.fillStyle = gl; xl.fillRect(wx, wy, ww, wh);
      if (blinds < 0.28) { xl.fillStyle = 'rgba(0,0,0,.35)'; xl.fillRect(wx, wy, ww, wh * 0.3); }
      xl.fillStyle = 'rgba(0,0,0,.7)';
      for (const f of [1 / 3, 2 / 3]) xl.fillRect(wx + ww * f - 2, wy, 4, wh);
    }
  }
  return { map: toTex(c), lit: toTex(cl), rough: toTex(cr, { color: false }) };
}

// vertical neon names for the hotel pylons: one 128 px column per name, letters stacked, glowing
export function neonAtlas(names) {
  const W = 128, H = 640;
  const [c, x] = mk(W * names.length, H);
  x.fillStyle = '#121014'; x.fillRect(0, 0, c.width, c.height);
  x.textAlign = 'center'; x.textBaseline = 'middle';
  names.forEach(([name, color], i) => {
    const cx = i * W + W / 2, n = name.length, step = Math.min(92, (H - 40) / n);
    x.font = `700 ${Math.round(step * 0.86)}px "Futura","Avenir Next","Century Gothic",sans-serif`;
    for (let k = 0; k < n; k++) {
      const y = 20 + step * (k + 0.5) + (H - 40 - step * n) / 2;
      x.shadowColor = color; x.shadowBlur = 18; x.fillStyle = color;
      x.fillText(name[k], cx, y);
      x.shadowBlur = 0; x.fillStyle = '#fffaf2'; x.globalAlpha = 0.55; x.fillText(name[k], cx, y); x.globalAlpha = 1;
    }
  });
  return toTex(c, { repeat: false });
}

// a picture from assets/, decoded off the main thread (no hitch while it loads)
const loadBitmap = (url, flip = false) => fetch(url)
  .then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.blob(); })
  .then((b) => createImageBitmap(b, flip ? { imageOrientation: 'flipY' } : {}));

// Swap a material's painted canvas for a real ground photo (CC0, assets/tex) once it has loaded, toned to fit
// the cartoon palette: multiplied toward `tint`, lightened by `lift`, then `overlay` draws on top (slab joints).
// On the high tier the matching normal map adds surface relief. Until it loads, the painted one shows.
export function upgradeGround(mat, url, { tint = null, amount = 0, lift = 0, overlay = null, normal = null, normalScale = 0.6, repeat = 1 } = {}) {
  loadBitmap(url).then((img) => {
    const tex = mat.map, c = tex.image, S = img.width;
    c.width = c.height = S;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    img.close();
    if (tint) { x.globalCompositeOperation = 'multiply'; x.globalAlpha = amount; x.fillStyle = tint; x.fillRect(0, 0, S, S); }
    if (lift) { x.globalCompositeOperation = 'screen'; x.globalAlpha = lift; x.fillStyle = '#ffffff'; x.fillRect(0, 0, S, S); }
    x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1;
    if (overlay) overlay(x, S);
    tex.repeat.set(repeat, repeat);
    tex.dispose();            // the GPU copy has the old size; let three.js make a new one
    tex.needsUpdate = true;
  }).catch(() => {});
  if (normal && HIGH) {
    new THREE.TextureLoader().loadAsync(normal).then((n) => {
      n.wrapS = n.wrapT = THREE.RepeatWrapping; n.anisotropy = ANISO; n.repeat.set(repeat, repeat);
      mat.normalMap = n; mat.normalScale.set(normalScale, normalScale); mat.needsUpdate = true;
    }).catch(() => {});
  }
}

// Put a finished picture (assets/tex) in place of a canvas texture once it loads; the canvas painting shows until then
export function replaceCanvas(tex, url) {
  loadBitmap(url, true).then((img) => {
    const old = tex.image;
    tex.image = img;
    tex.flipY = false;        // already flipped while decoding (WebGL can't flip a bitmap)
    tex.dispose();            // the GPU copy has the old size; let three.js make a new one
    tex.needsUpdate = true;
    old.width = old.height = 1;   // and let go of the painted stand-in's memory
  }).catch(() => {});
}

// the 12 shop fronts as a 3 x 4 atlas (SHOP_SIGNS order); until the painted one loads, the simple front repeats
export function shopAtlas() {
  const one = shopfront();
  const [c, x] = mk(768, 512), [cl, xl] = mk(768, 512);
  for (let i = 0; i < 12; i++) {
    x.drawImage(one.map.image, (i % 3) * 256, Math.floor(i / 3) * 128);
    xl.drawImage(one.lit.image, (i % 3) * 256, Math.floor(i / 3) * 128);
  }
  return { map: toTex(c, { repeat: false }), lit: toTex(cl, { repeat: false }) };
}

// ---------- Kimchi Key v2: the buildings' layer stacks ----------
// The v2 buildings draw from texture arrays (WebGL2 sampler2DArray): every facade, roof, awning, shop, sign and
// interior atlas is one layer of a stack, so one material draws them all. A stack only reserves its memory on the
// GPU; each layer is filled from a painted stand-in at once and from its picture in assets/tex when that decodes
// (a missing picture leaves the stand-in), scaled to the stack's size on the way. Copying into a layer needs the
// renderer, so the pictures wait in a queue until flushLayers(renderer) (buildings3d calls it between frames).

const waiting = [];   // [stack, layer, ImageBitmap]

// A stack of `depth` square layers of `size` px: repeating, mipmapped, sRGB unless color is false.
export function layerStack(depth, size, { color = true } = {}) {
  const t = new THREE.DataArrayTexture(null, size, size, depth);
  t.source.dataReady = false;          // storage only; putLayer fills it
  t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.anisotropy = ANISO;
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false;                      // the pictures are flipped while they decode (WebGL can't flip a bitmap)
  t.needsUpdate = true;
  Object.assign(t.userData, {
    size,
    final: new Set(),     // layers that have their picture (a late stand-in must not cover it)
    pending: 0,           // stand-ins and pictures asked for that have not decoded (or failed) yet
    mipped: new Set(),    // layers whose mipmaps have been made at least once
    since: new Set(),     // layers copied since the stack's mipmaps were last made
    keep: null,           // the last job copied without making mipmaps (see flushLayers)
  });
  return t;
}

// Fill one layer from a painted canvas (the stand-in) and then, if a url is given, from that picture once it
// decodes. Returns a promise that settles when both are queued (true if the picture came).
export function putLayer(stack, layer, canvas, url = null) {
  if (typeof createImageBitmap === 'undefined') return Promise.resolve(false);
  const u = stack.userData, size = u.size, opts = { imageOrientation: 'flipY', resizeWidth: size, resizeHeight: size, resizeQuality: 'high' };
  u.pending += (canvas ? 1 : 0) + (url ? 1 : 0);
  // one of them has come (or failed): once nothing more is coming, a copy that skipped the mipmaps is made again
  // with them (flushLayers), unless another copy for this stack is still waiting and makes them anyway
  const settle = () => {
    if (--u.pending === 0 && u.keep && !waiting.some((j) => j[0] === stack)) { waiting.push(u.keep); u.keep = null; }
  };
  const queue = (bmp, final) => {
    if (u.final.has(layer)) bmp.close();
    else { if (final) u.final.add(layer); waiting.push([stack, layer, bmp]); }
    settle();
  };
  const stand = canvas ? createImageBitmap(canvas, opts).then((b) => queue(b, !url), settle).catch(() => {}) : Promise.resolve();
  if (!url) return stand.then(() => false);
  const pic = fetch(url)
    .then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.blob(); })
    .then((b) => createImageBitmap(b, opts))
    .then((b) => { queue(b, true); return true; }, () => { settle(); return false; });
  return Promise.all([stand, pic]).then(([, ok]) => ok);
}

// whether any layer is waiting for flushLayers
export const layersWaiting = () => waiting.length > 0;

// Copy what has decoded into its layers, at most `max` of them a call (a 1024 px layer is 4 MB to send), so the
// pictures arriving together spread over a few frames. A stack's mipmaps (all its layers' at once) are made
// once its queue is empty, and then only if a layer has just had its first content (so nothing far away samples
// an empty mip level) or nothing more is coming: the stand-ins make them once, the last picture once more, and
// a picture that comes while others still decode shows its stand-in's mipmaps until then.
export function flushLayers(renderer, max = 4) {
  if (!waiting.length || !renderer?.copyTextureToTexture3D) return;
  const jobs = waiting.splice(0, max), box = new THREE.Box3(), at = new THREE.Vector3();
  jobs.forEach((job, i) => {
    const [stack, layer, bmp] = job, u = stack.userData;
    renderer.initTexture?.(stack);      // its storage, with the whole mip chain, before the first copy into it
    u.since.add(layer);
    const more = jobs.slice(i + 1).some((j) => j[0] === stack) || waiting.some((j) => j[0] === stack);
    const mip = !more && (u.pending === 0 || [...u.since].some((l) => !u.mipped.has(l)));
    stack.generateMipmaps = mip;
    box.min.set(0, 0, 0); box.max.set(bmp.width, bmp.height, 1);
    renderer.copyTextureToTexture3D({ isTexture: true, image: bmp }, stack, box, at.set(0, 0, layer));
    stack.generateMipmaps = true;
    const prev = u.keep;
    if (mip) {
      for (const l of u.since) u.mipped.add(l);
      u.since.clear();
      u.keep = null;
      bmp.close();
    } else u.keep = job;                // copied again with the mipmaps if no other copy comes to make them
    if (prev && prev !== job) prev[2].close();
  });
}

// decoFacade painted, the stand-in of every region facade until (or unless) its own picture loads; release()
// lets the paintings go once every putLayer that uses them has settled.
export function decoStandIn() {
  const d = decoFacade(), out = { map: d.map.image, lit: d.lit.image, rough: d.rough.image };
  out.release = () => { for (const t of [d.map, d.lit, d.rough]) { t.dispose(); t.image.width = t.image.height = 1; } };
  return out;
}

// The 6 shop fronts of map v2's second shop atlas (shops2.jpg cells 12..17, after SHOP_SIGNS' 12), with the
// sign each one's stand-in board says.
export const SHOPS2 = [
  ['SURF SHOP', '#2f9fd6', '#ffffff'], ['GELATO', '#ff8fb1', '#ffffff'], ['SWIMWEAR', '#e8622c', '#fff4e8'],
  ['CAFECITO', '#5b3a29', '#ffe8c7'], ['SUSHI BAR 스시', '#1b1b1b', '#ff5a5a'], ['FLOWERS 꽃집', '#3d9a6a', '#ffffff'],
];

// The 18 shop fronts as shops2.jpg lays them out (3 x 6 cells: SHOP_SIGNS order, then SHOPS2), painted with the
// simple front: { map, lit } canvases.
export function shopAtlas2() {
  const one = shopfront();
  const [c, x] = mk(768, 768), [cl, xl] = mk(768, 768);
  for (let i = 0; i < 18; i++) {
    x.drawImage(one.map.image, (i % 3) * 256, Math.floor(i / 3) * 128);
    xl.drawImage(one.lit.image, (i % 3) * 256, Math.floor(i / 3) * 128);
  }
  one.map.dispose(); one.lit.dispose();
  return { map: c, lit: cl };
}

// their sign boards as shops2_signs.jpg lays them out (2 x 9 cells of 16:3, same order): a canvas
export function signAtlas2() {
  const [c, x] = mk(1024, 864);
  SHOP_SIGNS.concat(SHOPS2).forEach(([text, bg, fg], i) => {
    const X = (i % 2) * 512, Y = Math.floor(i / 2) * 96;
    x.fillStyle = bg; x.fillRect(X, Y, 512, 96);
    x.fillStyle = 'rgba(255,255,255,.12)'; x.fillRect(X, Y, 512, 8);
    x.fillStyle = 'rgba(0,0,0,.25)'; x.fillRect(X, Y + 88, 512, 8);
    x.font = '900 46px "Apple SD Gothic Neo","Malgun Gothic",ui-rounded,system-ui,sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = fg; x.fillText(text, X + 256, Y + 50, 480);
  });
  return c;
}

// K-Town's signs as signs_ktown.jpg lays them out (2048 x 1600 there): 8 vertical blade boards along the top
// (1:3.25), then 6 neon signs (4:1) in 2 columns. The stand-in paints each board's words on its colour.
export const KTOWN_BLADES = [['치킨', '#d6402b'], ['노래방', '#7b3fe4'], ['호프', '#e3a13a'], ['PC방', '#1f7ae0'],
  ['고기집', '#2b2b2b'], ['분식', '#e8622c'], ['당구장', '#1b9e8a'], ['한식당', '#8a2b2b']];
export const KTOWN_NEON = [['서울 SEOUL', '#ff6fb5'], ['소주 SOJU', '#7affc8'], ['K-BBQ', '#ff8a3a'], ['OPEN 24H', '#bfe8ff'],
  ['포차 POCHA', '#ff5a5a'], ['K-POP', '#c77dff']];
export function ktownSigns() {
  const [c, x] = mk(1024, 800);
  x.fillStyle = '#0d0c10'; x.fillRect(0, 0, 1024, 800);
  x.textAlign = 'center'; x.textBaseline = 'middle';
  KTOWN_BLADES.forEach(([text, bg], i) => {
    const X = i * 128;
    x.fillStyle = bg; x.fillRect(X + 6, 6, 116, 404);
    x.strokeStyle = '#fff3c4'; x.lineWidth = 4; x.strokeRect(X + 12, 12, 104, 392);
    const chars = [...text], step = Math.min(96, 360 / chars.length);
    x.font = `900 ${Math.round(step * 0.8)}px "Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif`;
    x.fillStyle = '#ffffff';
    chars.forEach((ch, k) => x.fillText(ch, X + 64, 208 + (k - (chars.length - 1) / 2) * step));
  });
  KTOWN_NEON.forEach(([text, color], k) => {
    const X = (k % 2) * 512, Y = 416 + Math.floor(k / 2) * 128;
    x.font = '700 64px "Futura","Avenir Next","Apple SD Gothic Neo",sans-serif';
    x.shadowColor = color; x.shadowBlur = 20; x.fillStyle = color;
    x.fillText(text, X + 256, Y + 66, 470);
    x.shadowBlur = 0; x.globalAlpha = 0.6; x.fillStyle = '#ffffff'; x.fillText(text, X + 256, Y + 66, 470); x.globalAlpha = 1;
  });
  return c;
}

// Shop interiors stacked in rows, counted from the top in kinds order: { map, lit } canvases. A row is shown
// about 3 m tall: the grid's storeInterior pictures (4:1) repeat every 6 m along a window and are stretched into
// their rows as the grid shows them; the office lobby (lobbyInterior, 4:1 too) repeats every 12 m, so it keeps
// its painted proportions.
export function interiorAtlas(kinds) {
  const [c, x] = mk(1024, 256 * kinds.length), [cl, xl] = mk(1024, 256 * kinds.length);
  kinds.forEach((k, i) => {
    const t = k === 'lobby' ? lobbyInterior() : storeInterior(k);
    x.drawImage(t.map.image || t.map, 0, i * 256, 1024, 256);
    xl.drawImage(t.lit.image || t.lit, 0, i * 256, 1024, 256);
    if (t.map.isTexture) { t.map.dispose(); t.lit.dispose(); } else t.map.width = t.lit.width = 1;
  });
  return { map: c, lit: cl };
}

// An office tower's or a hotel's lobby behind its glass, 12 m wide and 3 m tall (1024 x 256 px, about 85 px a
// metre), at its real proportions: stone walls; on the left half a slatted wood wall with a lit panel, a long
// walnut reception desk under three brass globe pendants, potted palms and a bench; on the right half two lifts
// in a dark stone surround and a lounge (two armchairs, a low table, a floor lamp, a big pastel painting); a few
// people; then the glass's tint and streaks. At night the room glows warm. { map, lit } canvases.
export function lobbyInterior() {
  const [c, x] = mk(1024, 256), [cl, xl] = mk(1024, 256);
  const FLOOR = 236;                                     // where things stand (0.24 m above the window's foot)
  const rect = (col, X, Y, w, h) => { x.fillStyle = col; x.fillRect(X, Y, w, h); };
  const disc = (col, X, Y, r) => { x.fillStyle = col; x.beginPath(); x.arc(X, Y, r, 0, Math.PI * 2); x.fill(); };
  const glow = (X, Y, r, a) => {
    const g = x.createRadialGradient(X, Y, 1, X, Y, r);
    g.addColorStop(0, `rgba(255,226,170,${a})`); g.addColorStop(1, 'rgba(255,226,170,0)');
    x.fillStyle = g; x.fillRect(X - r, Y - r, 2 * r, 2 * r);
  };
  // walls: stone panels 1.5 m wide with dark joints
  rect('#a99b82', 0, 0, 1024, FLOOR);
  for (let X = 0; X < 1024; X += 128) rect('#958870', X, 0, 3, FLOOR);
  rect('#9f9279', 0, 120, 1024, 2);
  // the ceiling: a dark soffit with warm downlights
  rect('#2b2622', 0, 0, 1024, 18);
  for (let X = 32; X < 1024; X += 64) { glow(X, 26, 34, 0.6); rect('#fff1d0', X - 5, 15, 10, 3); }
  // the floor: polished stone with the room's reflection in it
  const fl = x.createLinearGradient(0, FLOOR, 0, 256);
  fl.addColorStop(0, '#7f766a'); fl.addColorStop(1, '#988e7f');
  x.fillStyle = fl; x.fillRect(0, FLOOR, 1024, 20);

  // ----- the left half: reception -----
  rect('#6f5139', 150, 18, 212, FLOOR - 18);
  for (let X = 154; X < 362; X += 10) rect('#5a3f2c', X, 18, 4, FLOOR - 18);
  rect('rgba(111,81,57,.35)', 150, FLOOR, 212, 20);
  rect('#c9a96e', 206, 52, 100, 54); rect('#f3e6c8', 209, 55, 94, 48);
  disc('#d4af37', 256, 79, 14); disc('#f3e6c8', 256, 79, 9);
  for (const X of [196, 256, 316]) {
    rect('#2a2420', X - 1, 18, 2, 56);
    glow(X, 82, 30, 0.8);
    rect('#c9a96e', X - 4, 72, 8, 3);
    disc('#fff3d8', X, 83, 8);
  }
  // the receptionist stands behind the desk; the desk is 2.4 m of walnut, 1.1 m tall, with a brass top
  person(x, 256, FLOOR, 140, '#2b2b30', '#f2efe8');
  rect('#3b2f26', 154, FLOOR - 94, 204, 94);
  rect('#4a3b30', 154, FLOOR - 70, 204, 30);
  rect('#c9a96e', 150, FLOOR - 98, 212, 5);
  rect('#1e1813', 154, FLOOR - 6, 204, 6);
  // a bench
  rect('#3a3330', 84, FLOOR - 36, 6, 36); rect('#3a3330', 132, FLOOR - 36, 6, 36);
  rect('#6f7f8f', 78, FLOOR - 42, 66, 12);
  for (const X of [36, 476]) palm(x, X, FLOOR);
  person(x, 118, FLOOR, 138, '#3a3a3a', '#a33a3a');
  person(x, 418, FLOOR, 150, '#2b3a55', '#2b3a55');

  // ----- the right half: the lifts and a lounge -----
  for (const X of [560, 690]) {
    rect('#4f463f', X - 14, FLOOR - 206, 128, 206);       // the dark stone surround
    rect('#c7ccd1', X, FLOOR - 190, 100, 190);             // brushed steel doors, 1.2 m wide and 2.2 m tall
    rect('#9ea5ac', X + 49, FLOOR - 190, 2, 190);
    rect('#dfe3e6', X + 4, FLOOR - 190, 3, 190);
    disc('#ffb347', X + 50, FLOOR - 198, 4);                // the floor light over the door
  }
  // the painting over the lounge: pastel blocks on white, in a thin black frame
  rect('#1b1b1b', 836, 46, 156, 92); rect('#f6f1e6', 839, 49, 150, 86);
  rect('#f1b2c3', 846, 56, 62, 44); rect('#9fd8cf', 914, 56, 68, 30); rect('#f4d98a', 914, 90, 68, 38); rect('#2aa39d', 846, 104, 62, 24);
  // two armchairs either side of a low table, and a floor lamp
  for (const X of [842, 952]) {
    rect('#b5533c', X, FLOOR - 50, 48, 34);                // back
    rect('#c96a52', X - 4, FLOOR - 22, 56, 14);            // seat
    rect('#b5533c', X - 6, FLOOR - 40, 8, 32); rect('#b5533c', X + 46, FLOOR - 40, 8, 32);   // arms
    rect('#3a3330', X, FLOOR - 8, 4, 8); rect('#3a3330', X + 44, FLOOR - 8, 4, 8);
  }
  rect('#c9a96e', 900, FLOOR - 28, 44, 4); rect('#3a3330', 918, FLOOR - 24, 8, 24);
  rect('#2a2420', 1010, FLOOR - 150, 3, 150); rect('#e9dcc0', 998, FLOOR - 170, 28, 22); glow(1011, FLOOR - 150, 40, 0.55);
  palm(x, 794, FLOOR);
  person(x, 620, FLOOR, 146, '#2d2d2d', '#3d5a80');
  person(x, 760, FLOOR, 136, '#5a4a3a', '#e9e2d4');

  // the glass: a faint blue tint and diagonal streaks of reflected sky
  const g = x.createLinearGradient(0, 0, 1024, 256);
  g.addColorStop(0, 'rgba(160,205,230,.14)'); g.addColorStop(0.5, 'rgba(160,205,230,.05)'); g.addColorStop(1, 'rgba(160,205,230,.12)');
  x.fillStyle = g; x.fillRect(0, 0, 1024, 256);
  x.strokeStyle = 'rgba(255,255,255,.2)'; x.lineWidth = 9;
  for (let i = 0; i < 8; i++) { x.beginPath(); x.moveTo(30 + i * 130, 256); x.lineTo(110 + i * 130, 0); x.stroke(); }
  // at night the room glows warm
  xl.drawImage(c, 0, 0);
  xl.globalCompositeOperation = 'multiply';
  xl.fillStyle = '#ffd9a0'; xl.fillRect(0, 0, 1024, 256);
  return { map: c, lit: cl };
}

// a person standing on the floor at X, h px tall (85 px a metre): trousers, a top, a head with hair
function person(x, X, floor, h, legs, top) {
  const s = h / 145;
  x.fillStyle = legs;
  x.fillRect(X - 12 * s, floor - 72 * s, 11 * s, 72 * s); x.fillRect(X + 1 * s, floor - 72 * s, 11 * s, 72 * s);
  x.fillStyle = top;
  x.beginPath(); x.moveTo(X - 16 * s, floor - 70 * s); x.lineTo(X + 16 * s, floor - 70 * s); x.lineTo(X + 19 * s, floor - 120 * s);
  x.lineTo(X - 19 * s, floor - 120 * s); x.closePath(); x.fill();
  x.fillRect(X - 23 * s, floor - 118 * s, 6 * s, 44 * s); x.fillRect(X + 17 * s, floor - 118 * s, 6 * s, 44 * s);
  x.fillStyle = '#e0b48a'; x.beginPath(); x.arc(X, floor - 133 * s, 11 * s, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#2a211c'; x.beginPath(); x.arc(X, floor - 136 * s, 11.5 * s, Math.PI, 0); x.fill();
}

// a palm in a tall white pot standing on the floor at X (about 1.6 m tall)
function palm(x, X, floor) {
  x.fillStyle = '#e9e4da';
  x.beginPath(); x.moveTo(X - 24, floor - 52); x.lineTo(X + 24, floor - 52); x.lineTo(X + 18, floor); x.lineTo(X - 18, floor); x.closePath(); x.fill();
  x.fillStyle = '#5b4636'; x.fillRect(X - 22, floor - 54, 44, 4);
  x.fillStyle = '#6b4e35'; x.fillRect(X - 3, floor - 120, 6, 68);
  for (let k = 0; k < 9; k++) {
    const a = -Math.PI + (k / 8) * Math.PI, L = 52 + (k % 2) * 10;
    x.fillStyle = ['#2f7d4f', '#3f9a62', '#5bb37a'][k % 3];
    x.save(); x.translate(X, floor - 118); x.rotate(a);
    x.beginPath(); x.ellipse(L / 2, 0, L / 2, 9, 0.18, 0, Math.PI * 2); x.fill();
    x.restore();
  }
}

// Awning stripes, one colour per row (each row is stripes(color): white and colour halves, a shadow line along
// the bottom), so every awning colour shares one layer: a canvas.
export function stripeAtlas(colors) {
  const [c, x] = mk(64, 64 * colors.length);
  colors.forEach((color, i) => {
    const Y = i * 64;
    x.fillStyle = '#fbf7ef'; x.fillRect(0, Y, 64, 64);
    x.fillStyle = color; x.fillRect(0, Y, 32, 64);
    x.fillStyle = 'rgba(0,0,0,.12)'; x.fillRect(0, Y + 56, 64, 8);
  });
  return c;
}

// Painted signs (textSign's look) packed in one sheet, cells of 512 x 128 in `cols` columns, in list order;
// a sign painted at another size is drawn to fill its cell (the quad it goes on has its own shape, so the
// stretch cancels out). Returns the canvas and each sign's [u0, v0, u1, v1].
export function signSheet(list, cols = 4) {
  const CW = 512, CH = 128, rows = Math.max(1, Math.ceil(list.length / cols));
  const [c, x] = mk(CW * cols, CH * rows);
  const rects = list.map(({ text, opts }, i) => {
    const X = (i % cols) * CW, Y = Math.floor(i / cols) * CH;
    const t = textSign(text, opts);
    x.drawImage(t.image, X, Y, CW, CH);
    t.dispose();
    return [X / c.width, 1 - (Y + CH) / c.height, (X + CW) / c.width, 1 - Y / c.height];
  });
  return { canvas: c, rects };
}

// Barrel (mission) roof tiles for the Gables: rows of round-topped tiles, light so a roof's vertex colour sets
// its terracotta; 8 tiles across and 5 courses: a canvas.
export function barrelTiles() {
  const [c, x] = mk(128);
  const r = mulberry32(23);
  x.fillStyle = '#d9d4cc'; x.fillRect(0, 0, 128, 128);
  for (let j = 0; j < 5; j++) {
    const y0 = j * 25.6, off = (j % 2) * 8;
    for (let i = -1; i < 9; i++) {
      const X = i * 16 + off, v = 222 + Math.floor((r() - 0.5) * 34);
      const g = x.createLinearGradient(X, 0, X + 16, 0);
      g.addColorStop(0, `rgb(${v - 70},${v - 70},${v - 70})`); g.addColorStop(0.45, `rgb(${v},${v},${v})`); g.addColorStop(1, `rgb(${v - 55},${v - 55},${v - 55})`);
      x.fillStyle = g; x.fillRect(X + 1, y0, 14, 25.6);
    }
    x.fillStyle = 'rgba(0,0,0,.3)'; x.fillRect(0, y0 + 22.6, 128, 3);
  }
  return c;
}
