// The Kimchi Key v2 street props in 3D (docs/map-v2-spec.md §5.7 and §11.1 Props): street and promenade lamps
// with their light pools (and a lamp every 45 m along the bridge decks, which the world's list leaves dark), KayKit
// traffic lights at the signal junctions (lenses lit from roads.signalAt; dark while the signals are off), the
// sign atlas (bend chevrons, advisory speeds, the Loop's exit gantries, jump and gator warnings, speed-trap
// posts), the billboards on the Runway Straight and the causeways, the sidewalk furniture (benches, bins,
// hydrants, Lincoln Road's planters, bus stops), the prefabs' loungers, parasols and the Fest kiosk, the
// bollards on the boardwalk and the Cove Stairs, the villa's pool terrace (a travertine deck, the coping and the
// infinity pool's water, villaTerrace) and Hongdae Neon Alley's festoon lights, paper lanterns and pink pools of
// light (alleyLights).
//
// buildProps3D(world, chunks) -> { nearestLamps(xm, zm, n, out), update(camera, t, night), lampHeads, stats,
// advisories }: world is the world facade's namespace; chunks is the city's chunk manager (its scene is the city
// group). cityV2 hands nearestLamps to main3d, which puts its few real lamp lights (6, Low 3) in the lamp heads
// nearest to what the camera looks at, and calls update once a frame with the night level (0 day to 1 night).
// lampHeads are the world's lamps in order, then the deck lamps; advisories says which way each advisory sign's
// arrow bends (for the tests).
//
// Everything is instanced: a handful of kinds (a unit box, a pole, a sign face that reads its picture from an
// atlas, a billboard face, lamp heads, lenses and three KayKit models), each one InstancedMesh per part for the
// whole map. The copies sit in 64 m buckets; a refresh (when the camera moves a metre or turns) writes only the
// copies within their draw distance and in view, the ones within 60 m of the shadow focus first so the shadow
// pass draws only those (chunks.js castFirst). So the props cost about a dozen draw calls in any view, whatever
// the map holds. The lamps' light pools are the exception: each is draped over the ground under its head
// (drapePool), so they are merged into a mesh per 256 m tile and drawn after dark within 170 m.
//
// No street lamp or furniture stands on a landmark (landmarks3d's landmarkFootprints): a lamp the world puts
// there moves off along its road, a hydrant or bench is left out.
//
// Not here: the beach props (coast3d builds them from the same deco list), the W-beam and Jersey rails
// (roads3d), the fountains (landmarks3d animates them with the Bayfront fountain). Positions in the world's
// lists are sim px (16 per metre) with y south; everything built is in metres, y up.
import * as THREE from 'three';
import { HIGH, matte } from './quality.js';
import { makeBuckets, shadowFocus, castFirst, setCopies, uploadFirst, INSTANCE_CAST_R, BUCKET } from './chunks.js';
import { loadAssetPack } from './scatter3d.js';
import { landmarkFootprints } from './landmarks3d.js';
import { Builder, col } from './geo.js';
import { villaFrame, VILLA_POOL, VILLA_TERRACE } from '../map/prefabs.js';
import * as TX from './textures.js';

const PX = 16;
const FAR_K = HIGH ? 1 : 0.7;   // the Low tier draws props this much nearer
// draw distances (m from the camera)
const FAR = { small: 110, furniture: 140, sign: 260, signal: 260, lamp: 300, gantry: 520, board: 650, pool: 170 };
const LAMP_NIGHT_K = 2.2;       // lamp heads glow this much further out at night (the town's lights in the distance)
const LAMP = { pole: 7.6, arm: 2.1, head: 7.45, light: 7.15 };   // a street lamp (m): the light sits under the head
const PROM = { pole: 4.0, head: 4.25, light: 4.0 };               // a promenade lantern
const POOL = 14;                // m across a lamp's light pool on the ground
const POOL_CELLS = 14;          // a pool is draped over the ground as a grid this many cells across (1 m each)
const POOL_LIFT = 0.04;         // m over the highest ground next to each of its points (so a kerb's step is in it)
const POOL_RISE = 0.0005;       // m more per metre from the camera, so a far pool never sinks into the ground's depth
const POOL_LEDGE = 0.3;         // m: ground stepping this much in 0.25 m is a wall or a ledge (a kerb is 0.16): the light stops
const POOL_TILE = 256;          // m: the pools are merged into one mesh per tile this size
const DECK_LAMP_EVERY = 45;     // m between the lamps standing on a bridge deck's edge
// Hongdae Neon Alley's festoons (alleyLights): m between the posts (from `first` along the alley, sides in turn),
// their distance from its middle, the strings' height and sag, the bulbs' spacing, and where its pools of light lie
const ALLEY = { post: 7, first: 7, off: 3.9, y: 5.2, sag: 0.7, bulb: 0.75, pools: [12, 24, 36] };
const LAMP_COLOR = '#2e3a3c', SIGN_GREY = '#8d939a', POST_GREY = '#9aa1a8';

// ---------- the sign atlas ----------
// 2048 x 1024: the Loop's exit names on 512 x 128 green panels (4 a row, 5 rows), then 128 px cells below.
const SIGN_W = 2048, SIGN_H = 1024, NAME_W = 512, NAME_H = 128, NAMES = 20, CELL = 128, CELLS_Y = 640;
const CELLS = { chevron: 0, curve: 1, jump: 2, gator: 3, backDiamond: 4, exit: 5, backSquare: 6, bus: 7, trap: 8, events: 10, kmh: 16 };
const HWY = '"Highway Gothic","Overpass","Roboto Condensed","Arial Narrow","Helvetica Neue",Arial,sans-serif';
const BOLD = '"Arial Black","Helvetica Neue",Helvetica,Arial,sans-serif';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// the [u0, v0, du, dv] of an atlas rectangle (canvas pixels, y down), pulled in 2 px so mipmaps do not bleed
function tileOf(x, y, w, h, W, H, flip = false) {
  const u0 = (x + 2) / W, du = (w - 4) / W, v0 = 1 - (y + h - 2) / H, dv = (h - 4) / H;
  return flip ? [u0 + du, v0, -du, dv] : [u0, v0, du, dv];
}
const cellTile = (i, span = 1, flip = false) => tileOf((i % 16) * CELL, CELLS_Y + Math.floor(i / 16) * CELL, CELL * span, CELL, SIGN_W, SIGN_H, flip);
const nameTile = (i) => tileOf((i % 4) * NAME_W, Math.floor(i / 4) * NAME_H, NAME_W, NAME_H, SIGN_W, SIGN_H);

function diamond(g, x, y, s, fill, edge) {
  g.beginPath();
  g.moveTo(x + s / 2, y + 3); g.lineTo(x + s - 3, y + s / 2); g.lineTo(x + s / 2, y + s - 3); g.lineTo(x + 3, y + s / 2); g.closePath();
  g.fillStyle = fill; g.fill();
  if (edge) {
    g.beginPath();
    g.moveTo(x + s / 2, y + 12); g.lineTo(x + s - 12, y + s / 2); g.lineTo(x + s / 2, y + s - 12); g.lineTo(x + 12, y + s / 2); g.closePath();
    g.strokeStyle = edge; g.lineWidth = 5; g.stroke();
  }
}
function square(g, x, y, w, h, fill, edge, r = 10) {
  g.fillStyle = fill; g.fillRect(x, y, w, h);
  if (edge) { g.strokeStyle = edge; g.lineWidth = 6; g.beginPath(); g.roundRect(x + 7, y + 7, w - 14, h - 14, r); g.stroke(); }
}
function text(g, s, x, y, size, color, font = BOLD, maxW = undefined) {
  g.font = `900 ${size}px ${font}`; g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(s, x, y, maxW);
}

// The road signs, painted once: green exit panels with the names given, and yellow warning signs (a chevron and
// a curve arrow pointing right, flipped for left by their tiles), the jump and gator diamonds, grey backs, the
// exit arrow, the bus sign, the speed-trap and Fest-events boards and the advisory km/h plates.
function paintSigns(names) {
  const c = canvas(SIGN_W, SIGN_H), g = c.getContext('2d');
  names.slice(0, NAMES).forEach((name, i) => {
    const x = (i % 4) * NAME_W, y = Math.floor(i / 4) * NAME_H;
    square(g, x, y, NAME_W, NAME_H, '#0b6b3c', '#f4f4ee', 14);
    g.font = `700 52px ${HWY}`; g.fillStyle = '#f7f7f2'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(name, x + NAME_W / 2, y + NAME_H / 2 + 3, NAME_W - 48);
  });
  const at = (i) => [(i % 16) * CELL, CELLS_Y + Math.floor(i / 16) * CELL];
  const YEL = '#f5c400', INK = '#141414';
  // bend chevron, pointing right
  let [x, y] = at(CELLS.chevron);
  square(g, x, y, CELL, CELL, YEL, INK, 8);
  g.fillStyle = INK; g.beginPath();
  g.moveTo(x + 32, y + 22); g.lineTo(x + 60, y + 22); g.lineTo(x + 100, y + 64); g.lineTo(x + 60, y + 106); g.lineTo(x + 32, y + 106); g.lineTo(x + 72, y + 64);
  g.closePath(); g.fill();
  // curve ahead, bending right
  [x, y] = at(CELLS.curve);
  square(g, x, y, CELL, CELL, YEL, INK, 12);
  g.strokeStyle = INK; g.lineWidth = 15; g.lineCap = 'butt'; g.beginPath();
  g.moveTo(x + 46, y + 110); g.lineTo(x + 46, y + 74); g.quadraticCurveTo(x + 46, y + 44, x + 76, y + 44); g.stroke();
  g.fillStyle = INK; g.beginPath(); g.moveTo(x + 74, y + 22); g.lineTo(x + 108, y + 44); g.lineTo(x + 74, y + 66); g.closePath(); g.fill();
  // jump ahead: a ramp and a car in the air
  [x, y] = at(CELLS.jump);
  diamond(g, x, y, CELL, YEL, INK);
  g.fillStyle = INK; g.beginPath(); g.moveTo(x + 28, y + 90); g.lineTo(x + 66, y + 90); g.lineTo(x + 66, y + 72); g.closePath(); g.fill();
  g.save(); g.translate(x + 82, y + 56); g.rotate(-0.35);
  g.beginPath(); g.roundRect(-22, -8, 44, 14, 5); g.fill(); g.beginPath(); g.roundRect(-12, -17, 22, 10, 4); g.fill();
  g.beginPath(); g.arc(-12, 8, 6, 0, Math.PI * 2); g.arc(12, 8, 6, 0, Math.PI * 2); g.fill(); g.restore();
  // gators: an alligator walking across
  [x, y] = at(CELLS.gator);
  diamond(g, x, y, CELL, YEL, INK);
  g.fillStyle = INK; g.beginPath(); g.ellipse(x + 62, y + 66, 30, 9, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.moveTo(x + 88, y + 62); g.lineTo(x + 108, y + 64); g.lineTo(x + 88, y + 71); g.closePath(); g.fill();     // snout
  g.beginPath(); g.moveTo(x + 34, y + 62); g.quadraticCurveTo(x + 22, y + 66, x + 16, y + 60); g.lineTo(x + 34, y + 71); g.closePath(); g.fill();  // tail
  for (const lx of [44, 78]) { g.fillRect(x + lx - 3, y + 70, 6, 12); g.fillRect(x + lx - 9, y + 50, 6, 10); }
  // grey backs, the exit arrow (up and to the right) and the bus sign
  [x, y] = at(CELLS.backDiamond); diamond(g, x, y, CELL, SIGN_GREY, null);
  [x, y] = at(CELLS.backSquare); square(g, x, y, CELL, CELL, SIGN_GREY, null);
  [x, y] = at(CELLS.exit);
  square(g, x, y, CELL, CELL, '#0b6b3c', '#f4f4ee', 12);
  g.save(); g.translate(x + 64, y + 66); g.rotate(Math.PI / 4); g.fillStyle = '#f7f7f2';
  g.fillRect(-9, -18, 18, 50); g.beginPath(); g.moveTo(-30, -14); g.lineTo(0, -44); g.lineTo(30, -14); g.closePath(); g.fill(); g.restore();
  [x, y] = at(CELLS.bus);
  square(g, x, y, CELL, CELL, '#1f5fbf', '#f4f4ee', 12);
  text(g, 'BUS', x + 64, y + 70, 44, '#f7f7f2');
  // speed trap (two cells wide): a camera and the words
  [x, y] = at(CELLS.trap);
  square(g, x, y, CELL * 2, CELL, '#13306b', '#ffd23f', 12);
  g.fillStyle = '#ffd23f'; g.beginPath(); g.roundRect(x + 22, y + 46, 46, 32, 6); g.fill();
  g.beginPath(); g.moveTo(x + 68, y + 54); g.lineTo(x + 84, y + 46); g.lineTo(x + 84, y + 78); g.lineTo(x + 68, y + 70); g.closePath(); g.fill();
  text(g, 'SPEED', x + 166, y + 46, 36, '#ffffff');
  text(g, 'TRAP', x + 166, y + 86, 36, '#ffffff');
  // Fest events kiosk (two cells wide)
  [x, y] = at(CELLS.events);
  square(g, x, y, CELL * 2, CELL, '#ff4fa3', '#fff4fb', 14);
  text(g, 'FEST', x + 128, y + 46, 40, '#ffffff');
  text(g, 'EVENTS', x + 128, y + 88, 34, '#fff36b');
  // advisory speed plates, 10 to 120 km/h
  for (let k = 0; k < 12; k++) {
    [x, y] = at(CELLS.kmh + k);
    square(g, x, y, CELL, CELL, YEL, INK, 8);
    text(g, String((k + 1) * 10), x + 64, y + 54, 60, INK, BOLD, 104);
    g.font = `800 24px ${HWY}`; g.fillText('km/h', x + 64, y + 100);
  }
  const t = TX.toTex(c, { repeat: false });
  t.generateMipmaps = true;
  return t;
}

// ---------- billboard posters ----------
// 2048 x 1024: 3 x 3 posters of 682 x 341 (3:1, the boards' 12 x 4 m); art 0-7 from the world's billboards
const BOARD_W = 2048, BOARD_H = 1024, POSTER_W = 682, POSTER_H = 341;
const posterTile = (i) => tileOf((i % 3) * POSTER_W, Math.floor(i / 3) * POSTER_H, POSTER_W, POSTER_H, BOARD_W, BOARD_H);

function grad(g, x0, y0, x1, y1, stops) {
  const q = g.createLinearGradient(x0, y0, x1, y1);
  stops.forEach((c, i) => q.addColorStop(i / (stops.length - 1), c));
  return q;
}
// a big word with a dark outline (the cartoon poster look)
function shout(g, s, x, y, size, fill, stroke = '#1b1020', font = BOLD, maxW) {
  g.font = `900 ${size}px ${font}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineJoin = 'round'; g.lineWidth = Math.max(4, size * 0.12); g.strokeStyle = stroke;
  g.strokeText(s, x, y, maxW); g.fillStyle = fill; g.fillText(s, x, y, maxW);
}

const POSTERS = [
  // 0 Kimchi Fest: magenta to orange, a Ferris wheel
  (g, w, h) => {
    g.fillStyle = grad(g, 0, 0, w, h, ['#ff3d8b', '#ff7a3d', '#ffc23d']); g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 8;
    g.beginPath(); g.arc(w - 110, h / 2 + 30, 110, 0, Math.PI * 2); g.stroke();
    for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; g.beginPath(); g.moveTo(w - 110, h / 2 + 30); g.lineTo(w - 110 + Math.cos(a) * 110, h / 2 + 30 + Math.sin(a) * 110); g.stroke(); }
    shout(g, 'KIMCHI FEST', w * 0.4, h * 0.42, 92, '#ffffff', '#5a1036', BOLD, w * 0.72);
    shout(g, 'MUSIC · FOOD · CARS', w * 0.4, h * 0.74, 34, '#fff36b', '#5a1036', BOLD, w * 0.7);
  },
  // 1 Kimchi Motors: night blue, gold lettering and a car
  (g, w, h) => {
    g.fillStyle = grad(g, 0, 0, 0, h, ['#0d1430', '#1d2a5c']); g.fillRect(0, 0, w, h);
    g.fillStyle = '#d4af37'; g.beginPath(); g.roundRect(w * 0.56, h * 0.58, w * 0.38, h * 0.16, 30); g.fill();
    g.beginPath(); g.roundRect(w * 0.64, h * 0.46, w * 0.2, h * 0.16, 30); g.fill();
    g.fillStyle = '#111'; for (const fx of [0.63, 0.86]) { g.beginPath(); g.arc(w * fx, h * 0.76, 24, 0, Math.PI * 2); g.fill(); }
    shout(g, 'KIMCHI', w * 0.3, h * 0.36, 86, '#f2d27a', '#0a0f22', TX.SERIF, w * 0.52);
    shout(g, 'MOTORS', w * 0.3, h * 0.62, 56, '#ffffff', '#0a0f22', BOLD, w * 0.5);
    g.font = `600 22px "Helvetica Neue",Arial,sans-serif`; g.fillStyle = '#c9d2ff'; g.fillText('Drive something legendary', w * 0.3, h * 0.84, w * 0.5);
  },
  // 2 Kimchi Air: sky blue, a white jet
  (g, w, h) => {
    g.fillStyle = grad(g, 0, 0, 0, h, ['#4fb6ff', '#bfe8ff']); g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffffff'; g.save(); g.translate(w * 0.72, h * 0.45); g.rotate(-0.18);
    g.beginPath(); g.ellipse(0, 0, 150, 20, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(-20, 0); g.lineTo(-70, 80); g.lineTo(-40, 80); g.lineTo(40, 0); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(-120, -5); g.lineTo(-150, -60); g.lineTo(-128, -60); g.lineTo(-95, -5); g.closePath(); g.fill(); g.restore();
    shout(g, 'KIMCHI AIR', w * 0.3, h * 0.4, 70, '#ffffff', '#0b3d74', BOLD, w * 0.56);
    shout(g, 'Fly private. Fly Kimchi.', w * 0.3, h * 0.7, 30, '#0b3d74', '#ffffff', BOLD, w * 0.56);
  },
  // 3 Halmoni's kimchi: red, a jar
  (g, w, h) => {
    g.fillStyle = grad(g, 0, 0, w, 0, ['#c0262b', '#e2452f']); g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff2d6'; g.beginPath(); g.roundRect(w * 0.73, h * 0.3, 120, 170, 26); g.fill();
    g.fillStyle = '#e2452f'; g.fillRect(w * 0.73 + 10, h * 0.5, 100, 70);
    g.fillStyle = '#3a2a1c'; g.fillRect(w * 0.73 + 8, h * 0.24, 104, 28);
    shout(g, "HALMONI'S", w * 0.35, h * 0.3, 54, '#fff2d6', '#5a1012', BOLD, w * 0.6);
    shout(g, 'KIMCHI', w * 0.35, h * 0.58, 96, '#ffffff', '#5a1012', BOLD, w * 0.62);
    shout(g, 'since 1962 · 할머니', w * 0.35, h * 0.84, 26, '#fff36b', '#5a1012', BOLD, w * 0.6);
  },
  // 4 Kimchi himself (the hero picture once it has loaded), gold lettering
  (g, w, h, img) => {
    g.fillStyle = grad(g, 0, 0, w, h, ['#0d0d10', '#2a2418']); g.fillRect(0, 0, w, h);
    if (img) { const ih = h * 0.98, iw = ih * img.width / img.height; g.drawImage(img, w * 0.2 - iw / 2, h - ih, iw, ih); }
    g.fillStyle = grad(g, 0, h * 0.3, 0, h * 0.6, ['#f8e4a6', '#d4af37', '#a5822a']);
    g.font = `400 112px ${TX.SERIF}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('KIMCHI', w * 0.65, h * 0.44, w * 0.6);
    g.font = '600 26px "Helvetica Neue",Arial,sans-serif'; g.fillStyle = '#efe7d6'; g.fillText('@kimchi1x', w * 0.65, h * 0.72, w * 0.5);
    g.strokeStyle = '#d4af37'; g.lineWidth = 6; g.strokeRect(5, 5, w - 10, h - 10);
  },
  // 5 Mochi boba: pastel, a cup with pearls
  (g, w, h) => {
    g.fillStyle = grad(g, 0, 0, w, h, ['#ffd1e6', '#c8f5e4']); g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffffff'; g.beginPath(); g.moveTo(w * 0.74, h * 0.2); g.lineTo(w * 0.92, h * 0.2); g.lineTo(w * 0.89, h * 0.88); g.lineTo(w * 0.77, h * 0.88); g.closePath(); g.fill();
    g.fillStyle = '#d9a46c'; g.fillRect(w * 0.755, h * 0.42, w * 0.15, h * 0.44);
    g.fillStyle = '#2b1a12'; for (let k = 0; k < 9; k++) { g.beginPath(); g.arc(w * (0.78 + (k % 3) * 0.04), h * (0.74 + Math.floor(k / 3) * 0.05), 9, 0, Math.PI * 2); g.fill(); }
    shout(g, 'MOCHI', w * 0.36, h * 0.38, 92, '#ff4f9a', '#ffffff', BOLD, w * 0.6);
    shout(g, 'BOBA TEA', w * 0.36, h * 0.7, 54, '#2aa39d', '#ffffff', BOLD, w * 0.6);
  },
  // 6 Seoul Circle: purple night, neon lettering
  (g, w, h) => {
    g.fillStyle = grad(g, 0, 0, 0, h, ['#1a0b33', '#3b0f5c']); g.fillRect(0, 0, w, h);
    g.shadowColor = '#ff4fd8'; g.shadowBlur = 24;
    shout(g, 'K-TOWN', w * 0.5, h * 0.38, 104, '#ffd6fb', '#ff2fd0', BOLD, w * 0.8);
    g.shadowColor = '#4fe3ff';
    shout(g, '서울 · Eat · Sing · Repeat', w * 0.5, h * 0.74, 34, '#c9f7ff', '#1aa7c9', BOLD, w * 0.86);
    g.shadowBlur = 0;
  },
  // 7 Deco Beach: a striped sunset and a palm
  (g, w, h) => {
    const bands = ['#ff5f8f', '#ff8a5c', '#ffb85c', '#ffd98a'];
    bands.forEach((c, k) => { g.fillStyle = c; g.fillRect(0, k * h / 6, w, h / 6 + 1); });
    g.fillStyle = '#2aa39d'; g.fillRect(0, h * 4 / 6, w, h * 2 / 6);
    g.fillStyle = '#ffe9a8'; g.beginPath(); g.arc(w * 0.78, h * 0.62, 70, Math.PI, 0); g.fill();
    g.strokeStyle = '#1b3a3a'; g.lineWidth = 12; g.beginPath(); g.moveTo(w * 0.9, h); g.quadraticCurveTo(w * 0.88, h * 0.5, w * 0.93, h * 0.22); g.stroke();
    g.fillStyle = '#1b3a3a'; for (let k = 0; k < 6; k++) { g.save(); g.translate(w * 0.93, h * 0.22); g.rotate(k * 1.05); g.beginPath(); g.ellipse(40, 0, 44, 9, 0.2, 0, Math.PI * 2); g.fill(); g.restore(); }
    shout(g, 'DECO BEACH', w * 0.4, h * 0.36, 82, '#ffffff', '#7a1f4a', BOLD, w * 0.7);
    shout(g, 'Ocean Drive · since 1936', w * 0.4, h * 0.82, 30, '#ffffff', '#145a57', BOLD, w * 0.7);
  },
];

function paintPosters() {
  const c = canvas(BOARD_W, BOARD_H), g = c.getContext('2d');
  const one = (i, img) => {
    const x = (i % 3) * POSTER_W, y = Math.floor(i / 3) * POSTER_H;
    g.save(); g.translate(x, y); g.beginPath(); g.rect(0, 0, POSTER_W, POSTER_H); g.clip();
    POSTERS[i](g, POSTER_W, POSTER_H, img);
    g.restore();
  };
  POSTERS.forEach((_, i) => one(i));
  // the spare ninth cell: the Fest poster again, for bus-stop panels
  g.drawImage(c, 0, 0, POSTER_W, POSTER_H, 2 * POSTER_W, 2 * POSTER_H, POSTER_W, POSTER_H);
  const t = TX.toTex(c, { repeat: false });
  // Kimchi's own poster gets his picture once it has loaded (the gold lettering shows until then)
  if (typeof Image !== 'undefined') {
    const img = new Image();
    img.onload = () => { one(4, img); t.needsUpdate = true; };
    img.src = 'assets/kimchi-hero.webp';
  }
  return t;
}

// ---------- instanced kinds ----------

// A sign or poster face reads its picture from a cell of an atlas: each copy carries the cell as a 4-number
// tile [u0, v0, du, dv] (a negative du mirrors it), applied to the map and the night glow alike.
function tiled(m) {
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = 'attribute vec4 aTile;\n' + sh.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
      #ifdef USE_MAP
        vMapUv = aTile.xy + vMapUv * aTile.zw;
      #endif
      #ifdef USE_EMISSIVEMAP
        vEmissiveMapUv = aTile.xy + vEmissiveMapUv * aTile.zw;
      #endif`);
  };
  m.customProgramCacheKey = () => 'kc-tile';
  return m;
}

const _M = new THREE.Matrix4(), _P = new THREE.Matrix4(), _Q = new THREE.Quaternion(), _E = new THREE.Euler(0, 0, 0, 'YXZ');
const _V = new THREE.Vector3(), _S = new THREE.Vector3();

// A placement: at (x, y, z) m, heading a (the copy's local +x points along a, its +z to the right of it, as the
// world's headings go: 0 east, π/2 south), scaled sx along, sy up and sz across; tilt (rad) raises its front.
function at(x, y, z, a = 0, sx = 1, sy = 1, sz = 1, tilt = 0) {
  _E.set(0, -a, tilt);
  return _M.compose(_V.set(x, y, z), _Q.setFromEuler(_E), _S.set(sx, sy, sz));
}

// The field: every kind's copies, picked near the camera each refresh.
function makeField(root) {
  const kinds = [];
  const sun = shadowFocus(root);
  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4(), sphere = new THREE.Sphere();
  const last = new THREE.Vector3(1e9, 0, 0), lastDir = new THREE.Vector3(), dir = new THREE.Vector3(), lastF = { x: 1e9, z: 0 };
  const lists = [], rest = [];
  let dirty = true;

  // parts: [{ geometry, material, matrix? }] (one InstancedMesh each); o: shadow (the near copies cast),
  // colors (a colour per copy), tiles (an atlas cell per copy), on (drawn at all), farK (draw distance factor)
  function kind(name, parts, o = {}) {
    const k = { name, parts, shadow: !!o.shadow, colors: !!o.colors, tiles: !!o.tiles, on: o.on ?? true, farK: 1,
      items: [], meshes: [], bands: [], drawn: 0, casting: 0, order: [], sealed: false };
    kinds.push(k);
    return k;
  }
  // one copy of a kind, placed by the matrix m; seen while within far of the camera and its sphere (centre
  // (x, y, z), radius r) is in view. c: [r, g, b], t: tile.
  function add(k, m, x, y, z, r, far, c = null, t = null) {
    const n = k.parts.length, mats = new Float32Array(16 * n);
    for (let p = 0; p < n; p++) {
      const pm = k.parts[p].matrix;
      mats.set(pm ? _P.multiplyMatrices(m, pm).elements : m.elements, p * 16);
    }
    const it = { x, y, z, r, far: far * FAR_K, mats, c, t };
    k.items.push(it);
    return it;
  }
  // after a kind's copies are all added: its meshes, and its copies in buckets per draw distance (so a bench
  // is never looked at from as far as a billboard)
  function seal(k) {
    const cap = Math.max(1, k.items.length);
    k.meshes = k.parts.map((p) => {
      const geo = p.geometry;
      if (k.tiles) geo.setAttribute('aTile', new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4));
      const m = new THREE.InstancedMesh(geo, p.material, cap);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = k.shadow; m.receiveShadow = true;
      m.name = 'props ' + k.name;
      if (k.colors) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      if (k.shadow) castFirst(m);
      root.add(m);
      return m;
    });
    const byFar = new Map();
    for (const it of k.items) { if (!byFar.has(it.far)) byFar.set(it.far, []); byFar.get(it.far).push(it); }
    k.bands = [...byFar].map(([far, items]) => ({ far, buckets: makeBuckets(items, BUCKET) }));
    k.sealed = true;
    dirty = true;
  }
  function put(k, i, it) {
    const o = i * 16;
    for (let p = 0; p < k.meshes.length; p++) {
      const a = k.meshes[p].instanceMatrix.array, s = p * 16, src = it.mats;
      for (let j = 0; j < 16; j++) a[o + j] = src[s + j];
      if (k.colors) { const c = k.meshes[p].instanceColor.array; c[i * 3] = it.c[0]; c[i * 3 + 1] = it.c[1]; c[i * 3 + 2] = it.c[2]; }
    }
    if (k.tiles) { const t = k.meshes[0].geometry.attributes.aTile.array; t[i * 4] = it.t[0]; t[i * 4 + 1] = it.t[1]; t[i * 4 + 2] = it.t[2]; t[i * 4 + 3] = it.t[3]; }
    k.order[i] = it;
  }
  function finish(k, n, nCast) {
    for (const m of k.meshes) {
      if (k.shadow) setCopies(m, n, nCast);
      else { m.count = n; uploadFirst(m.instanceMatrix, n); }
      if (k.colors) uploadFirst(m.instanceColor, n);
    }
    if (k.tiles) uploadFirst(k.meshes[0].geometry.attributes.aTile, n);
    k.order.length = n;
    k.drawn = n; k.casting = nCast;
  }
  // write the copies of every kind near the camera; returns whether it looked again
  function update(camera, focus) {
    camera.getWorldDirection(dir);
    const f = focus || sun() || camera.position;
    const p = camera.position;
    if (!dirty && p.distanceToSquared(last) < 1 && dir.dot(lastDir) > 0.995 && (f.x - lastF.x) ** 2 + (f.z - lastF.z) ** 2 < 1) return false;
    dirty = false;
    last.copy(p); lastDir.copy(dir); lastF.x = f.x; lastF.z = f.z;
    frustum.setFromProjectionMatrix(pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const c2 = INSTANCE_CAST_R * INSTANCE_CAST_R;
    for (const k of kinds) {
      if (!k.sealed) continue;
      if (!k.on) { if (k.drawn) finish(k, 0, 0); continue; }
      let n = 0;
      rest.length = 0;
      for (const band of k.bands) {
        const far = band.far * k.farK, f2 = far * far;
        for (const list of band.buckets.near(p.x, p.z, far, lists)) for (const it of list) {
          const dx = it.x - p.x, dz = it.z - p.z;
          if (dx * dx + dz * dz > f2) continue;
          sphere.center.set(it.x, it.y, it.z); sphere.radius = it.r;
          if (!frustum.intersectsSphere(sphere)) continue;
          if (k.shadow && (it.x - f.x) ** 2 + (it.z - f.z) ** 2 <= c2) put(k, n++, it);
          else rest.push(it);
        }
      }
      const nCast = k.shadow ? n : 0;
      for (const it of rest) put(k, n++, it);
      finish(k, n, nCast);
    }
    rest.length = 0;
    return true;
  }
  // rewrite the colours of a kind's drawn copies (paint(it) sets it.c), e.g. the signal lenses
  function recolor(k, paint) {
    if (!k.drawn) return;
    for (let i = 0; i < k.drawn; i++) {
      const it = k.order[i];
      paint(it);
      for (const m of k.meshes) { const c = m.instanceColor.array; c[i * 3] = it.c[0]; c[i * 3 + 1] = it.c[1]; c[i * 3 + 2] = it.c[2]; }
    }
    for (const m of k.meshes) uploadFirst(m.instanceColor, k.drawn);
  }
  const touch = () => { dirty = true; };
  function stats() {
    const out = { kinds: kinds.length, items: 0, drawn: 0, casting: 0, by: {} };
    for (const k of kinds) { out.items += k.items.length; out.drawn += k.drawn; out.casting += k.casting; out.by[k.name] = [k.drawn, k.casting, k.items.length]; }
    return out;
  }
  return { kinds, kind, add, seal, update, recolor, touch, stats };
}

// ---------- the lamps' light pools ----------

// The pool of light under a lamp head at (hx, hz) m, draped over the ground (gy) rather than laid flat: a flat
// disc has to float over the highest kerb under it, and anything standing in it (Kimchi's feet, a wheel, a
// post) then shows through the glow up to that height. The pool is a grid of POOL_CELLS cells (1 m); the ground
// is read FINE times finer. The light spreads over the fine points from the middle across steps of up to
// POOL_LEDGE: past a wall, a planter or a deck's edge it fades to nothing, level with the last lit point,
// instead of climbing it or hanging off it. Each grid point starts on its ground; wherever a fine point between
// them stands over the pool's face (a kerb's top, the crown of a road), the corners under it come up just
// enough to clear it, by POOL_RAISE at most. A kerb's top also counts a fine point out toward the road, since
// roads3d's kerb line is not on the raster's 1 m cells. On a plain slope nothing is raised, so the pool sits
// POOL_LIFT over the ground, and up to a kerb's step more within a metre of one. Writes its POOL_VERTS points
// and its triangles on into out ({ pos, col, uv, idx, nv, ni }: typed arrays, and the points and indices in them
// so far); col is the light (0 or 1 per point, faded across a cell).
const FINE = 2;                 // the ground is read this many times finer than the pool's grid (0.5 m)
const POOL_STEP = 0.06;         // m: a rise between fine points this sharp is a step (a kerb is 0.16)
const POOL_FLAT = 0.06;         // m: ground either side of a step within this of level
const POOL_RAISE = 0.16;        // m: the most a pool's point is raised over its own ground (a kerb's step)
const PF = FINE * POOL_CELLS + 1, poolRaw = new Float32Array(PF * PF), poolTop = new Float32Array(PF * PF), poolLit = new Uint8Array(PF * PF);
const POOL_VERTS = (POOL_CELLS + 1) ** 2, poolH = new Float32Array(POOL_VERTS), poolStack = [];
function drapePool(hx, hz, gy, out) {
  const n = POOL_CELLS + 1, d = POOL / POOL_CELLS, f = d / FINE, fmid = (PF - 1) / 2;
  const raw = poolRaw, top = poolTop, lit = poolLit, h = poolH;
  // (only within the disc and a cell round it: the corners of the grid are never drawn)
  const reach = (fmid + FINE) ** 2;
  for (let j = 0; j < PF; j++) for (let i = 0; i < PF; i++) {
    raw[j * PF + i] = (i - fmid) ** 2 + (j - fmid) ** 2 <= reach ? gy(hx + (i - fmid) * f, hz + (j - fmid) * f) : NaN;
  }
  // the light, spread from the middle (never to a point not read: NaN fails the ledge test)
  lit.fill(0);
  const c = fmid * PF + fmid, stack = poolStack;
  lit[c] = 1; stack.length = 0; stack.push(c);
  const spread = (k, q) => { if (!lit[q] && Math.abs(raw[q] - raw[k]) <= POOL_LEDGE) { lit[q] = 1; stack.push(q); } };
  while (stack.length) {
    const k = stack.pop(), i = k % PF;
    if (i + 1 < PF) spread(k, k + 1);
    if (i > 0) spread(k, k - 1);
    if (k + PF < PF * PF) spread(k, k + PF);
    if (k >= PF) spread(k, k - PF);
  }
  // what the pool must clear: the ground, or the top of a step (a kerb) one fine point away. A step rises
  // from ground that is nearly level (within POOL_FLAT of the point behind) onto ground nearly level beyond it,
  // so the creases of a hillside are not steps.
  const flat = (k, a, b) => a < 0 || b < 0 || a >= PF || b >= PF || Math.abs(raw[b * PF + a] - raw[k]) < POOL_FLAT;
  for (let j = 0; j < PF; j++) for (let i = 0; i < PF; i++) {
    const k = j * PF + i;
    let t = raw[k];
    if (lit[k]) for (let db = -1; db <= 1; db++) for (let da = -1; da <= 1; da++) {
      const a = i + da, b = j + db, q = b * PF + a;
      if ((!da && !db) || a < 0 || b < 0 || a >= PF || b >= PF || !lit[q] || raw[q] <= t || raw[q] - raw[k] < POOL_STEP) continue;
      if (flat(k, i - da, j - db) && flat(q, a + da, b + db)) t = raw[q];
    }
    top[k] = t;
  }
  const at = (i, j) => (j * FINE) * PF + i * FINE;      // the fine point under grid point (i, j)
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = top[at(i, j)];
  // raise the corners under each fine point the pool's face would pass under (in cells lit at all four corners).
  // A cell is two triangles, split from its (1, 0) corner to its (0, 1) corner.
  for (let j = 0; j < POOL_CELLS; j++) for (let i = 0; i < POOL_CELLS; i++) {
    const p = j * n + i, k00 = at(i, j);
    if (!(lit[k00] && lit[at(i + 1, j)] && lit[at(i, j + 1)] && lit[at(i + 1, j + 1)])) continue;
    for (let b = 0; b <= FINE; b++) for (let a = 0; a <= FINE; a++) {
      const q = k00 + b * PF + a;
      if (!lit[q]) continue;
      const u = a / FINE, v = b / FINE, low = u + v <= 1;
      // corners and their weights at (u, v)
      const c0 = low ? p : p + n + 1, w0 = low ? 1 - u - v : u + v - 1, w1 = low ? u : 1 - v, w2 = low ? v : 1 - u;
      const s = top[q], short = s - (w0 * h[c0] + w1 * h[p + 1] + w2 * h[p + n]);
      if (short < 1e-3) continue;
      // the corners under it come up together just far enough (none past it): the least the pool can float. No
      // corner rises more than POOL_RAISE over its own ground (a kerb's step): by a taller step (a lot's pad
      // beside a sidewalk) the pool runs under the step's edge rather than floating over the pavement.
      const wl = (w0 > 1e-6 && h[c0] < s ? w0 : 0) + (w1 > 1e-6 && h[p + 1] < s ? w1 : 0) + (w2 > 1e-6 && h[p + n] < s ? w2 : 0);
      const up = (c, w, g) => { if (w > 1e-6 && h[c] < s) h[c] = Math.min(s, h[c] + short / wl, g + POOL_RAISE); };
      up(c0, w0, raw[low ? k00 : k00 + FINE * PF + FINE]); up(p + 1, w1, raw[k00 + FINE]); up(p + n, w2, raw[k00 + FINE * PF]);
    }
  }
  const base = out.nv, { pos, col, uv, idx } = out;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i, on = lit[at(i, j)], v = base + k;
    // an unlit point stays level with its lit neighbours, so the fade runs flat rather than up a wall or off a ledge
    let y = h[k];
    if (!on) {
      let m = -Infinity;
      for (let b = Math.max(0, j - 1); b <= Math.min(n - 1, j + 1); b++) for (let a = Math.max(0, i - 1); a <= Math.min(n - 1, i + 1); a++) if (lit[at(a, b)]) m = Math.max(m, h[b * n + a]);
      if (m > -Infinity) y = m;
      else if (!(y > -Infinity)) y = raw[c];     // a corner point never read (and never drawn)
    }
    pos[v * 3] = hx + (i - POOL_CELLS / 2) * d; pos[v * 3 + 1] = y + POOL_LIFT; pos[v * 3 + 2] = hz + (j - POOL_CELLS / 2) * d;
    col[v * 3] = col[v * 3 + 1] = col[v * 3 + 2] = on;
    uv[v * 2] = i / POOL_CELLS; uv[v * 2 + 1] = 1 - j / POOL_CELLS;
  }
  out.nv += POOL_VERTS;
  // the cells with light in them and inside the disc (the glow is nothing past its rim)
  const mid = POOL_CELLS / 2, rim = (mid * d) ** 2;
  for (let j = 0; j < POOL_CELLS; j++) for (let i = 0; i < POOL_CELLS; i++) {
    if (!(lit[at(i, j)] || lit[at(i + 1, j)] || lit[at(i, j + 1)] || lit[at(i + 1, j + 1)])) continue;
    const nx = Math.max(0, Math.abs(i + 0.5 - mid) - 0.5) * d, nz = Math.max(0, Math.abs(j + 0.5 - mid) - 0.5) * d;
    if (nx * nx + nz * nz >= rim) continue;
    const p = base + j * n + i, o = out.ni;
    idx[o] = p; idx[o + 1] = idx[o + 4] = p + n; idx[o + 2] = idx[o + 3] = p + 1; idx[o + 5] = p + n + 1;
    out.ni += 6;
  }
}

// The pools merged into one mesh per POOL_TILE tile (spots: [x, z] m per lamp), shown after dark within
// their draw distance (far, m), where the shader fades them out over the last 30% and lifts them a little more
// the further they are (POOL_RISE). { meshes, update(camera, on), stats() }
function lightPools(root, spots, gy, mat, far) {
  const tiles = new Map();
  for (const s of spots) {
    const key = Math.floor(s[0] / POOL_TILE) + ',' + Math.floor(s[1] / POOL_TILE);
    if (!tiles.has(key)) tiles.set(key, []);
    tiles.get(key).push(s);
  }
  const farU = { value: far };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uPoolFar = farU;
    sh.vertexShader = 'uniform float uPoolFar;\nvarying float vPoolFade;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      float poolD = distance((modelMatrix * vec4(transformed, 1.0)).xyz, cameraPosition);
      transformed.y += poolD * ${POOL_RISE.toFixed(6)};
      vPoolFade = 1.0 - smoothstep(uPoolFar * 0.7, uPoolFar, poolD);`);
    sh.fragmentShader = 'varying float vPoolFade;\n' + sh.fragmentShader.replace('#include <opaque_fragment>', `#include <opaque_fragment>
      gl_FragColor.a *= vPoolFade;`);
  };
  mat.customProgramCacheKey = () => 'kc-pool';
  const meshes = [];
  for (const list of tiles.values()) {
    const nv = list.length * POOL_VERTS, Index = nv > 65535 ? Uint32Array : Uint16Array;
    const t = { pos: new Float32Array(nv * 3), col: new Float32Array(nv * 3), uv: new Float32Array(nv * 2), idx: new Index(list.length * POOL_CELLS * POOL_CELLS * 6), nv: 0, ni: 0, n: list.length };
    for (const [x, z] of list) drapePool(x, z, gy, t);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(t.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(t.col, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(t.uv, 2));
    g.setIndex(new THREE.BufferAttribute(t.idx.slice(0, t.ni), 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.name = 'props light pools';
    m.visible = false;
    m.castShadow = false; m.receiveShadow = false;
    m.userData.pools = t.n;
    root.add(m);
    meshes.push(m);
  }
  let shown = 0, drawn = 0;
  function update(camera, on) {
    shown = 0; drawn = 0;
    const p = camera.position;
    for (const m of meshes) {
      const s = m.geometry.boundingSphere, reach = far + s.radius;
      m.visible = on && (s.center.x - p.x) ** 2 + (s.center.z - p.z) ** 2 < reach * reach;
      if (m.visible) { shown++; drawn += m.userData.pools; }
    }
  }
  const stats = () => ({ tiles: meshes.length, shown, drawn, pools: spots.length, tris: meshes.reduce((s, m) => s + m.geometry.index.count / 3, 0) });
  return { meshes, update, stats };
}

// ---------- the lamps' nearest-first search ----------

// nearestLamps for a list of lamp heads (Vector3, m): the same doubling bucket search as the grid city's, so
// ties keep lamp order and a point that is not a number finds no lamps (main3d then leaves its lights dark).
function lampSearch(heads) {
  const B = makeBuckets(heads.map((h, i) => ({ x: h.x, z: h.z, h, i })), BUCKET);
  const nearD = [], nearI = [], lists = [];
  function keep(out, n, d, i, h) {
    const len = out.length;
    if (len === n && (d > nearD[n - 1] || (d === nearD[n - 1] && i > nearI[n - 1]))) return;
    let k = Math.min(len, n - 1);
    while (k > 0 && (nearD[k - 1] > d || (nearD[k - 1] === d && nearI[k - 1] > i))) {
      nearD[k] = nearD[k - 1]; nearI[k] = nearI[k - 1]; out[k] = out[k - 1]; k--;
    }
    nearD[k] = d; nearI[k] = i; out[k] = h;
  }
  return function nearestLamps(xm, zm, n, out = []) {
    out.length = 0;
    if (!(n > 0) || !heads.length || !Number.isFinite(xm) || !Number.isFinite(zm)) return out;
    const reach = Math.hypot(Math.max(xm - B.x0, B.x0 + B.cols * B.size - xm), Math.max(zm - B.z0, B.z0 + B.rows * B.size - zm));
    for (let r = BUCKET; ; r *= 2) {
      out.length = 0;
      let seen = 0;
      for (const list of B.near(xm, zm, r, lists)) {
        seen += list.length;
        for (const l of list) keep(out, n, (l.x - xm) ** 2 + (l.z - zm) ** 2, l.i, l.h);
      }
      if (r >= reach || seen === heads.length || (out.length === n && nearD[n - 1] <= r * r)) return out;
    }
  };
}

// ---------- the villa's terrace and its infinity pool ----------

// The villa's pool terrace (prefabs.js VILLA_TERRACE and VILLA_POOL, in the villa's local frame: x across its
// front, z out from the house toward the view, y up from the summit pad). The pad is painted paving, and Kimchi
// walks the plaza's curb (TERRACE_Y) over it, so a pale travertine deck stands at that height round the pool,
// with a white coping round three sides of the water and, on the view side, the infinity edge: the water runs
// over a dark tiled lip into a slot drain. Stone planters ring the palms on the deck. The water stands just
// under the coping; the pool's depth is drawn by its shader (poolMaterial).
const TERRACE_Y = 0.16;          // m over the pad: the plaza's curb (raster CURB), where feet stand
const POOL_WATER_Y = 0.12;       // m over the pad: the water's surface, 4 cm under the deck
const COPING = { w: 0.4, y: 0.19 };
const POOL_DEPTH = 1.5;          // m of water the shader looks down through
const POOL_FAR = 650;            // m: the terrace is not drawn further out

// Pale travertine pavers, 1 m by 0.5 m, staggered, with soft veins: 512 px for 2 m.
function travertine() {
  const c = document.createElement('canvas'), S = 512;
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#b9ab92'; g.fillRect(0, 0, S, S);
  let seed = 7;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let j = 0; j < 8; j++) for (let i = -1; i < 2; i++) {
    const x = i * 256 + (j % 2) * 128, y = j * 64, v = 218 + Math.floor((r() - 0.5) * 16);
    g.fillStyle = `rgb(${v},${v - 11},${v - 31})`;
    g.fillRect(x + 2, y + 2, 252, 60);
    // veins: a few faint wandering strokes across the slab
    g.strokeStyle = `rgba(190,172,140,${0.18 + r() * 0.2})`; g.lineWidth = 1 + r() * 1.5;
    for (let k = 0; k < 3; k++) {
      const y0 = y + 6 + r() * 52;
      g.beginPath(); g.moveTo(x + 4, y0);
      g.bezierCurveTo(x + 80, y0 + (r() - 0.5) * 24, x + 170, y0 + (r() - 0.5) * 24, x + 250, y0 + (r() - 0.5) * 16);
      g.stroke();
    }
    for (let k = 0; k < 40; k++) { g.fillStyle = `rgba(160,140,110,${r() * 0.25})`; g.fillRect(x + 2 + r() * 250, y + 2 + r() * 58, 1 + r() * 2, 1 + r() * 2); }
  }
  const t = TX.toTex(c);
  t.generateMipmaps = true;
  return t;
}

// The pool's water: the grid pool's look (TX.poolTiles: glossy, lit from inside after dark), seen into. Each
// pixel follows the eye's ray, bent a little toward straight down, through the surface into a box POOL_DEPTH
// deep and finds the tiled floor or wall it meets there, bluer the further the light went through the water,
// with caustics wobbling on it; a slow swell moves the reflections. One quad, in the pool's own frame (x across,
// z along, the surface at y 0): uPoolEye is the camera in that frame, written once a frame.
function poolMaterial(half) {
  const m = HIGH ? new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.04, metalness: 0, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0 })
    : new THREE.MeshLambertMaterial({ color: '#ffffff', emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0 });
  const u = { tPool: { value: TX.poolTiles() }, uPoolHalf: { value: new THREE.Vector2(half[0], half[1]) }, uPoolEye: { value: new THREE.Vector3(0, 10, 0) },
    uPoolTime: { value: 0 }, uPoolAxes: { value: new THREE.Vector4(1, 0, 0, 1) } };
  m.userData.pool = u;
  m.name = 'villa pool';
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = 'varying vec3 vPoolP;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvPoolP = position;');
    sh.fragmentShader = `uniform sampler2D tPool;
uniform vec2 uPoolHalf;
uniform vec3 uPoolEye;
uniform float uPoolTime;
uniform vec4 uPoolAxes;
varying vec3 vPoolP;
vec3 poolInterior() {
  vec3 o = vec3(vPoolP.x, 0.0, vPoolP.z), r = normalize(o - uPoolEye);
  r = normalize(vec3(r.x * 0.75, min(r.y, -0.03), r.z * 0.75));     // bent toward the normal on the way in
  vec2 dir = vec2(abs(r.x) > 1e-4 ? r.x : 1e-4, abs(r.z) > 1e-4 ? r.z : 1e-4);
  float tF = -${POOL_DEPTH.toFixed(2)} / r.y;
  float tX = (sign(dir.x) * uPoolHalf.x - o.x) / dir.x, tZ = (sign(dir.y) * uPoolHalf.y - o.z) / dir.y;
  float t = min(tF, min(tX, tZ));
  vec3 h = o + r * t;
  vec2 uv = t == tF ? h.xz : t == tX ? vec2(h.z, h.y) : vec2(h.x, h.y);
  float wall = t == tF ? 1.0 : 0.82;
  uv += 0.05 * vec2(sin(h.z * 2.3 + uPoolTime * 1.3) + sin(h.x * 1.1 - uPoolTime * 0.7), cos(h.x * 1.9 + uPoolTime * 1.1));
  vec3 c = texture2D(tPool, uv / 4.0).rgb * wall;
  // the light lost on its way through the water (there and back): darker and deeper blue with the path
  return mix(c, vec3(0.01, 0.16, 0.27), (1.0 - exp(-t * 0.5)) * 0.85);
}
` + sh.fragmentShader
      .replace('#include <map_fragment>', '#include <map_fragment>\nvec3 poolCol = poolInterior();\ndiffuseColor.rgb *= poolCol;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= poolCol;');
    if (sh.fragmentShader.includes('#include <normal_fragment_maps>')) {
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      {
        // the swell: two crossing trains of small waves tilt the normal (pool frame -> world -> view)
        vec2 p = vPoolP.xz, w = vec2(cos(p.x * 1.6 + uPoolTime * 1.7) + 0.5 * cos((p.x + p.y) * 2.7 - uPoolTime * 2.3),
                                       cos(p.y * 1.9 - uPoolTime * 1.4) + 0.5 * cos((p.x - p.y) * 3.1 + uPoolTime * 1.9)) * 0.03;
        vec3 wv = vec3(w.x * uPoolAxes.x + w.y * uPoolAxes.z, 0.0, w.x * uPoolAxes.y + w.y * uPoolAxes.w);
        normal = normalize(normal - (viewMatrix * vec4(wv, 0.0)).xyz);
      }`);
    }
  };
  m.customProgramCacheKey = () => 'kc-pool-water';
  return m;
}

// The terrace and pool at the villa whose door is world.places.home.door, into the chunk manager. Returns
// { update(camera, t) } or null (no villa, or no pool in the world's SURF where the villa's pool should be).
function villaTerrace(world, chunks, night) {
  const door = world.places?.home?.door;
  if (!door || !world.grids?.surf) return null;
  const { F, a } = villaFrame({ x: door.x / PX, z: door.y / PX, a: door.a }), P = VILLA_POOL, Tr = VILLA_TERRACE;
  const s = Math.sin(a), c = Math.cos(a);
  const toW = (lx, lz) => [F[0] + (lx - 20) * s + (lz - 40) * c, F[1] - (lx - 20) * c + (lz - 40) * s];
  const [pcx, pcz] = toW((P.x0 + P.x1) / 2, (P.z0 + P.z1) / 2);
  if (world.surfaceAt(pcx * PX, pcz * PX) !== world.WATER) return null;
  const y0 = world.groundY(pcx * PX, pcz * PX);          // the pad (water has no curb)
  // local (x, y, z) -> world: x along (sin a, −cos a), z along (cos a, sin a), y up from the pad
  const M = new THREE.Matrix4().makeBasis(new THREE.Vector3(s, 0, -c), new THREE.Vector3(0, 1, 0), new THREE.Vector3(c, 0, s))
    .setPosition(F[0] - 20 * s - 40 * c, y0, F[1] + 20 * c - 40 * s);
  const deck = new Builder().setMatrix(M), stone = new Builder().setMatrix(M);
  const D = TERRACE_Y, under = -0.6, uv = { uv: 'world', us: 2, vs: 2, bottom: false };
  // the deck in four pieces round the pool (the house side reaching back under the villa's cantilever, which
  // stands 1.55 m inside its footprint), its outer faces running down past the ground (the lawn falls away in
  // front)
  deck.box(Tr.x0, under, Tr.z0, Tr.x1, D, P.z0 - COPING.w, COLOR_WHITE, { ...uv, pz: false });
  deck.box(Tr.x0 + 4.5, under, Tr.z0 - 1.55, Tr.x1 - 0.5, D, Tr.z0, COLOR_WHITE, { ...uv, pz: false, nz: false });
  deck.box(Tr.x0, under - 0.6, P.z1 + 0.6, Tr.x1, D, Tr.z1, COLOR_WHITE, uv);
  deck.box(Tr.x0, under, P.z0 - COPING.w, P.x0 - COPING.w, D, P.z1 + 0.6, COLOR_WHITE, { ...uv, pz: false, nz: false });
  deck.box(P.x1 + COPING.w, under, P.z0 - COPING.w, Tr.x1, D, P.z1 + 0.6, COLOR_WHITE, { ...uv, pz: false, nz: false });
  // the coping on the house side and the two ends, a little proud of the deck, its inner faces down to the water
  const COP = col('#f3efe6'), LIP = col('#1f5a70'), SLOT = col('#2a2e33');
  stone.box(P.x0 - COPING.w, POOL_WATER_Y - 0.02, P.z0 - COPING.w, P.x1 + COPING.w, COPING.y, P.z0, COP);
  stone.box(P.x0 - COPING.w, POOL_WATER_Y - 0.02, P.z0, P.x0, COPING.y, P.z1, COP, { nz: false });
  stone.box(P.x1, POOL_WATER_Y - 0.02, P.z0, P.x1 + COPING.w, COPING.y, P.z1, COP, { nz: false });
  // the infinity edge: a dark tiled lip level with the water, the slot drain beyond it, then the deck
  stone.box(P.x0 - COPING.w, POOL_WATER_Y - 0.3, P.z1, P.x1 + COPING.w, POOL_WATER_Y + 0.004, P.z1 + 0.25, LIP, { nz: false, nx: false, px: false });
  stone.box(P.x0 - COPING.w, POOL_WATER_Y - 0.28, P.z1 + 0.25, P.x1 + COPING.w, POOL_WATER_Y - 0.05, P.z1 + 0.6, SLOT, { nx: false, px: false });
  // planters round the palms that stand on the deck
  const inv = new THREE.Matrix4().copy(M).invert(), v = new THREE.Vector3();
  const wall = new THREE.CylinderGeometry(0.98, 1.02, 0.5, 18, 1, true), rim = new THREE.RingGeometry(0.8, 1.0, 18, 1), soil = new THREE.CircleGeometry(0.82, 18);
  const flat = (y, x, z) => new THREE.Matrix4().makeRotationX(-Math.PI / 2).setPosition(x, y, z);
  for (const p of world.palms || []) {
    v.set(p.x / PX, y0, p.y / PX).applyMatrix4(inv);
    if (v.x < Tr.x0 || v.x > Tr.x1 || v.z < Tr.z0 || v.z > Tr.z1) continue;
    stone.geo(wall, new THREE.Matrix4().makeTranslation(v.x, D + 0.25, v.z), col('#ece6da'));
    stone.geo(rim, flat(D + 0.5, v.x, v.z), col('#f3efe6'));
    stone.geo(soil, flat(D + 0.4, v.x, v.z), col('#4a3a2c'));
  }
  const deckMat = matte({ map: travertine() }, 0.75);
  deckMat.name = 'villa terrace';
  const stoneMat = matte({ vertexColors: true }, 0.6);
  stoneMat.name = 'villa pool stone';
  // the water, in the pool's own frame (centred, x across, z along)
  const half = [(P.x1 - P.x0) / 2, (P.z1 - P.z0) / 2];
  const waterMat = poolMaterial(half), u = waterMat.userData.pool;
  u.uPoolAxes.value.set(s, -c, c, s);
  night(waterMat, 'emissiveIntensity', 0, 0.75);          // the underwater lights
  const geo = new THREE.PlaneGeometry(half[0] * 2, half[1] * 2).rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(geo, waterMat);
  water.name = 'villa pool water';
  water.matrixAutoUpdate = false;
  water.matrix.copy(M).multiply(new THREE.Matrix4().makeTranslation((P.x0 + P.x1) / 2, POOL_WATER_Y, (P.z0 + P.z1) / 2));
  water.receiveShadow = true;
  water.userData.noAO = true;
  const toPool = new THREE.Matrix4().copy(water.matrix).invert();
  const [ax, az] = toW(Tr.x0, Tr.z0), [bx, bz] = toW(Tr.x1, Tr.z1), [cx2, cz2] = toW(Tr.x0, Tr.z1), [dx2, dz2] = toW(Tr.x1, Tr.z0);
  const box = [Math.min(ax, bx, cx2, dx2) - 2, Math.min(az, bz, cz2, dz2) - 2, Math.max(ax, bx, cx2, dx2) + 2, Math.max(az, bz, cz2, dz2) + 2];
  const meshes = [deck.mesh(deckMat, { receive: true, indexed: true }), stone.mesh(stoneMat, { receive: true, indexed: true }), water];
  meshes[0].name = 'villa terrace deck'; meshes[1].name = 'villa pool coping';
  for (const m of meshes) chunks.add(m, { layer: 'shells', box, far: POOL_FAR });
  return {
    meshes,
    update(camera, t) {
      u.uPoolTime.value = t;
      u.uPoolEye.value.copy(camera.position).applyMatrix4(toPool);
    },
  };
}
const COLOR_WHITE = new THREE.Color(1, 1, 1);

// ---------- the props ----------

const rgb = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const LENS = { r: [4.5, 0.35, 0.2], a: [4.2, 2.3, 0.15], g: [0.25, 4, 1.7], off: [0.05, 0.05, 0.05] };
// where the KayKit traffic light (trafficlight_C, model units) has its three lenses on the arm's head
const TL_LENS = [{ y: 0.927, s: 'r' }, { y: 0.861, s: 'a' }, { y: 0.795, s: 'g' }], TL_LENS_X = -0.664, TL_LENS_Z = 0.078, TL_LENS_R = 0.025;

export function buildProps3D(world, chunks) {
  if (!world?.deco || !chunks?.add) return undefined;
  const root = new THREE.Group();
  root.name = 'props';
  chunks.add(root, { layer: 'terrain' });       // always drawn: the copies are picked near the camera here
  const F = makeField(root);
  const gy = (x, z) => world.groundY(x * PX, z * PX);
  const deco = world.deco, net = world.roads;

  // ---- materials (night values follow the night level) ----
  const nightList = [];
  const night = (m, prop, d, n) => { nightList.push([m, prop, d, n]); m[prop] = d; };
  const solid = matte({ color: '#ffffff' }, 0.7);            // boxes and poles, coloured per copy
  const signTex = paintSigns(gantryNames(deco)), boardTex = paintPosters();
  const signMat = tiled(matte({ map: signTex, alphaTest: 0.5, emissiveMap: signTex, emissive: new THREE.Color('#ffffff') }, 0.6));
  night(signMat, 'emissiveIntensity', 0, 0.35);                // retroreflective: they catch the headlights
  const boardMat = tiled(matte({ map: boardTex, emissiveMap: boardTex, emissive: new THREE.Color('#ffffff') }, 0.55));
  night(boardMat, 'emissiveIntensity', 0.12, 0.95);            // lit boards
  const headMat = matte({ color: '#fff4d6', emissive: new THREE.Color('#ffd38a') });
  night(headMat, 'emissiveIntensity', 0, 2.6);
  const poolMat = new THREE.MeshBasicMaterial({ map: TX.radialGlow(), color: '#ffd296', vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  poolMat.name = 'light pools';
  night(poolMat, 'opacity', 0, 0.38);               // (warm enough to read on the asphalt under v2's moonlit fill)
  const lensMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  // festoon bulbs and paper lanterns: unlit glass, coloured per copy, brighter than white after dark (bloom)
  const bulbMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  bulbMat.name = 'festoon bulbs';
  night({ set k(v) { bulbMat.color.setScalar(v); } }, 'k', 0.85, 3.2);
  const alleyPoolMat = poolMat.clone();
  alleyPoolMat.color.set('#ff86d6');
  alleyPoolMat.name = 'alley light pools';
  night(alleyPoolMat, 'opacity', 0, 0.34);

  // ---- kinds ----
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const poleGeo = new THREE.CylinderGeometry(0.8, 1, 1, 8); poleGeo.translate(0, 0.5, 0);
  const coneGeo = new THREE.ConeGeometry(1, 1, 12, 1); coneGeo.translate(0, 0.5, 0);
  const faceGeo = () => { const g = new THREE.PlaneGeometry(1, 1); g.rotateY(Math.PI / 2); return g; };   // normal +x, u toward −z
  const lensGeo = new THREE.CircleGeometry(1, 12);
  const K = {
    box: F.kind('box', [{ geometry: boxGeo, material: solid }], { shadow: true, colors: true }),
    pole: F.kind('pole', [{ geometry: poleGeo, material: solid }], { shadow: true, colors: true }),
    cone: F.kind('cone', [{ geometry: coneGeo, material: solid }], { shadow: true, colors: true }),
    sign: F.kind('sign', [{ geometry: faceGeo(), material: signMat }], { tiles: true }),
    board: F.kind('board', [{ geometry: faceGeo(), material: boardMat }], { tiles: true }),
    head: F.kind('lamp heads', [{ geometry: boxGeo, material: headMat }]),
    lens: F.kind('lenses', [{ geometry: lensGeo, material: lensMat }], { colors: true, on: false }),
    bulb: F.kind('bulbs', [{ geometry: new THREE.SphereGeometry(1, 8, 6), material: bulbMat }], { colors: true }),
  };

  // ---- helpers: a copy of a kind at a place, in metres ----
  // (x, z) moved `along` metres the way a points and `right` metres to the right of it
  const off = (x, z, a, along, right) => [x + Math.cos(a) * along - Math.sin(a) * right, z + Math.sin(a) * along + Math.cos(a) * right];
  const box = (x, y, z, a, sx, sy, sz, color, far, tilt = 0) => F.add(K.box, at(x, y, z, a, sx, sy, sz, tilt), x, y, z, 0.5 * Math.hypot(sx, sy, sz), far, rgb(color));
  const boxOn = ([x, z], y, a, sx, sy, sz, color, far) => box(x, y, z, a, sx, sy, sz, color, far);
  const pole = (x, y0, z, r, h, color, far) => F.add(K.pole, at(x, y0, z, 0, r, h, r), x, y0 + h / 2, z, h / 2 + r, far, rgb(color));
  const cone = (x, y0, z, r, h, color, far) => F.add(K.cone, at(x, y0, z, 0, r, h, r), x, y0 + h / 2, z, Math.max(r, h / 2), far, rgb(color));
  // a sign face centred at (x, y, z), facing a, w wide and h tall, showing a tile of the sign atlas
  const sign = (x, y, z, a, w, h, tile, far = FAR.sign) => F.add(K.sign, at(x, y, z, a, 1, h, w), x, y, z, 0.5 * Math.hypot(w, h), far, null, tile);
  const board = (x, y, z, a, w, h, tile, far = FAR.board) => F.add(K.board, at(x, y, z, a, 1, h, w), x, y, z, 0.5 * Math.hypot(w, h), far, null, tile);

  // ---- the landmarks' ground: no lamp or furniture stands on it ----
  const feet = landmarkFootprints(world);
  const onLandmark = (x, z, pad = 0) => feet.find(f => f.inside(x, z, pad));
  // a lamp whose post or head falls on a landmark (the K-Town gate's beams, say) moves out of it, along the
  // road through a gate or an arch, so its arm still reaches over the same road
  function clearLamp(x, z, a, promenade) {
    for (let k = 0; k < 3; k++) {
      const pole = onLandmark(x, z, 0.4), [hx, hz] = promenade ? [x, z] : off(x, z, a, LAMP.arm, 0), head = pole ? null : onLandmark(hx, hz, 0.6);
      const f = pole || head;
      if (!f) break;
      // 1.5 m clear of it, so the lamp reads as standing beside it rather than in it
      const px = pole ? x : hx, pz = pole ? z : hz, [nx, nz] = f.out(px, pz, 1.5);
      x += nx - px; z += nz - pz;
    }
    return [x, z];
  }

  // ---- lamps ----
  const lampHeads = [], poolSpots = [];
  for (const l of world.lamps) lamp(...clearLamp(l.x / PX, l.y / PX, l.a ?? 0, !!l.path), l.a ?? 0, !!l.path);
  // The bridge decks get none in the world's list (placeProps keeps lamps off them), and the causeways would be
  // black at night: a lamp stands just inside the deck's edge every 45 m, sides alternating, facing the road.
  for (const e of net?.edges || []) for (const [s0, s1] of e.deck || []) {
    if ((s1 - s0) / PX < 40) continue;
    let k = 0;
    for (let s = s0 + 20 * PX; s < s1 - 10 * PX; s += DECK_LAMP_EVERY * PX, k++) {
      const p = edgePoint(e, s), side = k & 1 ? -1 : 1, o = (e.halfW + (side > 0 ? e.walkR : e.walkL)) / PX - 0.3;
      lamp(p.x - p.tz * o * side, p.z + p.tx * o * side, Math.atan2(-p.tx * side, p.tz * side), false);
    }
  }
  const alleySpots = alleyLights();
  function lamp(x, z, a, promenade) {
    const y = gy(x, z);
    let hx = x, hz = z, hy;
    if (promenade) {
      // a promenade lantern: a short post with the lamp on top
      pole(x, y, z, 0.075, PROM.pole, LAMP_COLOR, FAR.lamp);
      box(x, y + PROM.pole + 0.5, z, a, 0.42, 0.08, 0.42, LAMP_COLOR, FAR.lamp);
      F.add(K.head, at(x, y + PROM.head, z, a, 0.34, 0.42, 0.34), x, y + PROM.head, z, 0.4, FAR.lamp);
      hy = y + PROM.light;
    } else {
      // a street lamp: a tall pole with an arm reaching out over the road and the head at its end
      pole(x, y, z, 0.11, LAMP.pole, LAMP_COLOR, FAR.lamp);
      const [ax, az] = off(x, z, a, LAMP.arm / 2, 0);
      box(ax, y + LAMP.pole - 0.08, az, a, LAMP.arm, 0.12, 0.12, LAMP_COLOR, FAR.lamp);
      [hx, hz] = off(x, z, a, LAMP.arm, 0);
      F.add(K.head, at(hx, y + LAMP.head, hz, a, 0.85, 0.2, 0.42), hx, y + LAMP.head, hz, 0.5, FAR.lamp);
      hy = y + LAMP.light;
    }
    lampHeads.push(new THREE.Vector3(hx, hy, hz));
    poolSpots.push([hx, hz]);       // its pool of light on the ground (lightPools)
  }
  const pools = lightPools(root, poolSpots, gy, poolMat, FAR.pool * FAR_K);
  const alleyPools = lightPools(root, alleySpots, gy, alleyPoolMat, FAR.pool * FAR_K);

  // ---- Hongdae Neon Alley after dark ----
  // Strings of festoon bulbs zig-zag across the alley between posts, red and pink paper lanterns hang from them,
  // and pink pools of light lie under them (Seoul Circle's own lamps come with the world's list: prefabs.js
  // park_circle). Returns the pools' spots.
  function alleyLights() {
    const spots = [];
    for (const e of (net?.edges || []).filter(q => q.road === 'neon_alley')) {
      const len = e.len / PX, posts = [];
      for (let sm = ALLEY.first, i = 0; sm <= len - 5; sm += ALLEY.post, i++) {
        const p = edgePoint(e, sm * PX), sd = i & 1 ? -1 : 1, x = p.x - p.tz * ALLEY.off * sd, z = p.z + p.tx * ALLEY.off * sd, y = gy(x, z);
        box(x, y - 0.2 + (ALLEY.y + 0.5) / 2, z, 0, 0.13, ALLEY.y + 0.5, 0.13, '#2e2a30', FAR.sign);
        posts.push([x, y + ALLEY.y, z]);
      }
      // a string from each post to the next, across the alley: bulbs every ALLEY.bulb m, a lantern at a quarter,
      // the middle and three quarters, and the wire in six straight runs
      for (let i = 0; i + 1 < posts.length; i++) {
        const [ax, ay, az] = posts[i], [bx, by, bz] = posts[i + 1], L = Math.hypot(bx - ax, bz - az), a = Math.atan2(bz - az, bx - ax);
        const pt = (u) => [ax + (bx - ax) * u, ay + (by - ay) * u - 4 * ALLEY.sag * u * (1 - u), az + (bz - az) * u];
        const nb = Math.max(2, Math.round(L / ALLEY.bulb));
        for (let k = 1; k < nb; k++) {
          const [x, y, z] = pt(k / nb);
          F.add(K.bulb, at(x, y - 0.1, z, 0, 0.075, 0.09, 0.075), x, y, z, 0.1, FAR.sign, rgb(k % 3 ? '#ffe0a8' : '#ffb35c'));
        }
        [0.25, 0.5, 0.75].forEach((u, k) => {
          const [x, y, z] = pt(u);
          F.add(K.bulb, at(x, y - 0.42, z, 0, 0.26, 0.34, 0.26), x, y - 0.4, z, 0.4, FAR.sign, rgb((i + k) % 2 ? '#ff4fb8' : '#ff3340'));
        });
        for (let k = 0; k < 6; k++) {
          const p0 = pt(k / 6), p1 = pt((k + 1) / 6), mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2, mz = (p0[2] + p1[2]) / 2;
          const run = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
          box(mx, my, mz, a, Math.hypot(run, p1[1] - p0[1]), 0.025, 0.025, '#1c1a1e', FAR.furniture, Math.atan2(p1[1] - p0[1], run));
        }
      }
      for (const sm of ALLEY.pools) if (sm < len) { const p = edgePoint(e, sm * PX); spots.push([p.x, p.z]); }
    }
    return spots;
  }

  // ---- signs along the roads ----
  const lists = groupBy(deco, 'list');
  // placeProps lists each bend's chevrons and then its two advisory signs, so an advisory's bend turns the way
  // the chevrons just before it on its edge say (as seen along the edge's point order; the sign's own dir says
  // which way its traffic goes). If none of that bend's chevrons found room, the road's own curve ahead says.
  const lastTurn = new Map(), advisories = [];
  for (const c of lists.chevrons || []) {
    if (c.kind === 'chevron') { lastTurn.set(c.edge, c); continue; }
    const ch = lastTurn.get(c.edge), turn = ch && ch.kmh === c.kmh ? ch.turn : curveAhead(net?.edges?.[c.edge], c);
    advisories.push({ sign: c, right: (turn === 'R') === ((c.dir ?? 1) > 0) });
  }
  const rightOf = new Map(advisories.map(q => [q.sign, q.right]));
  for (const c of lists.chevrons || []) {
    const x = c.x / PX, z = c.y / PX, y = gy(x, z), a = c.a;
    if (c.kind === 'chevron') {
      // a board on a post, the arrow for the bend's turn on the front and its mirror on the back
      pole(x, y, z, 0.04, 1.95, POST_GREY, FAR.sign);
      const right = c.turn !== 'L';
      const [fx, fz] = off(x, z, a, 0.05, 0), [bx, bz] = off(x, z, a, -0.05, 0);     // either side of the post
      sign(fx, y + 1.55, fz, a, 0.8, 0.95, cellTile(CELLS.chevron, 1, !right));
      sign(bx, y + 1.55, bz, a + Math.PI, 0.8, 0.95, cellTile(CELLS.chevron, 1, right));
    } else {
      // the advisory sign before a bend: a curve arrow over the km/h plate, a grey back
      const right = rightOf.get(c);
      pole(x, y, z, 0.05, 2.75, POST_GREY, FAR.sign);
      const [fx, fz] = off(x, z, a, 0.06, 0), [bx, bz] = off(x, z, a, 0.035, 0);
      sign(fx, y + 2.35, fz, a, 0.9, 0.9, cellTile(CELLS.curve, 1, !right));
      const k = Math.max(1, Math.min(12, Math.round(c.kmh / 10)));
      sign(fx, y + 1.62, fz, a, 0.8, 0.52, cellTile(CELLS.kmh + k - 1));
      sign(bx, y + 2.0, bz, a + Math.PI, 0.92, 1.3, cellTile(CELLS.backSquare));
    }
  }
  for (const d of lists.dangerSigns || []) {
    const x = d.x / PX, z = d.y / PX, y = gy(x, z), a = d.a;
    pole(x, y, z, 0.055, 2.45, POST_GREY, FAR.sign);
    const [fx, fz] = off(x, z, a, 0.07, 0), [bx, bz] = off(x, z, a, 0.045, 0);
    sign(fx, y + 2.15, fz, a, 1.3, 1.3, cellTile(d.kind === 'gator' ? CELLS.gator : CELLS.jump));
    sign(bx, y + 2.15, bz, a + Math.PI, 1.3, 1.3, cellTile(CELLS.backDiamond));
  }
  // speed traps: an orange post on the right of the way traffic comes, a camera on top, the board below
  for (const s of world.activities || []) {
    if (s.type !== 'speedTrap') continue;
    const near = net?.nearest?.(s.x, s.y, { maxD: 40 * PX });
    const halfW = near ? net.edges[near.edge].halfW / PX : 6;
    const [x, z] = off(s.x / PX, s.y / PX, s.a, 0, halfW + 2.2), y = gy(x, z), face = s.a + Math.PI;
    pole(x, y, z, 0.13, 4.6, '#f08a24', FAR.sign);
    boxOn(off(x, z, face, 0.25, 0), y + 4.45, face, 0.6, 0.38, 0.42, '#23272b', FAR.sign);
    boxOn(off(x, z, face, 0.6, 0), y + 4.45, face, 0.08, 0.26, 0.3, '#5ec8ff', FAR.sign);
    const [fx, fz] = off(x, z, face, 0.16, 0), [bx, bz] = off(x, z, face, 0.13, 0);
    sign(fx, y + 2.9, fz, face, 1.9, 0.95, cellTile(CELLS.trap, 2));
    sign(bx, y + 2.9, bz, face + Math.PI, 1.9, 0.95, cellTile(CELLS.backSquare));
  }

  // ---- the Loop's exit gantries ----
  const nameIndex = new Map(gantryNames(deco).slice(0, NAMES).map((n, i) => [n, i]));
  for (const g of lists.gantries || []) gantry(g);
  function gantry(g) {
    const x = g.x / PX, z = g.y / PX, a = g.a, face = a + Math.PI;     // a: the way traffic goes under it
    const near = net?.nearest?.(g.x, g.y, { maxD: 30 * PX });
    const e = near ? net.edges[near.edge] : null;
    const halfW = e ? e.halfW / PX : g.w + 1, mid = e ? (e.median / 2 + e.laneW) / PX : g.w / 2;
    // legs on the median and past the outer edge; the beam between them; panels over the lanes
    const inner = -mid, outer = halfW - mid + 1.1;
    const [ix, iz] = off(x, z, a, 0, inner), [ox, oz] = off(x, z, a, 0, outer);
    const top = Math.max(gy(ix, iz), gy(ox, oz), gy(x, z)) + 6.6;
    pole(ix, gy(ix, iz) - 0.3, iz, 0.22, top - gy(ix, iz) + 0.75, POST_GREY, FAR.gantry);
    pole(ox, gy(ox, oz) - 0.3, oz, 0.22, top - gy(ox, oz) + 0.75, POST_GREY, FAR.gantry);
    const [cx, cz] = off(x, z, a, 0, (inner + outer) / 2);
    box(cx, top + 0.45, cz, a, 0.55, 0.9, outer - inner + 0.6, POST_GREY, FAR.gantry);
    box(cx, top + 0.95, cz, a, 0.3, 0.14, outer - inner + 0.6, POST_GREY, FAR.gantry);
    const right = g.side === 'R', ni = nameIndex.get(g.name);
    const [px, pz] = off(x, z, a, -0.42, 0);
    box(px, top + 0.35, pz, a, 0.12, 1.55, 7.3, '#3b4044', FAR.gantry);
    const [nx, nz] = off(x, z, a, -0.5, right ? -0.8 : 0.8), [ax, az] = off(x, z, a, -0.5, right ? 2.85 : -2.85);
    sign(nx, top + 0.35, nz, face, 5.6, 1.4, ni != null ? nameTile(ni) : cellTile(CELLS.exit), FAR.gantry);
    sign(ax, top + 0.35, az, face, 1.4, 1.4, cellTile(CELLS.exit, 1, !right), FAR.gantry);
  }

  // ---- billboards: a poster on two poles (piles over the water), a walkway and spot lamps ----
  for (const b of lists.billboards || []) {
    const x = b.x / PX, z = b.y / PX, a = b.a, w = b.w || 12, h = b.h || 4;
    const road = roadHeightNear(net, b.edge, b.x, b.y), g0 = gy(x, z);
    const y0 = Math.max(g0 + (b.pole || 7), road + 4.2), yc = y0 + h / 2;
    const foot = b.water ? Math.min(g0, (world.SEA_LEVEL ?? -1) - 2) : g0 - 0.2;
    for (const s of [-1, 1]) {
      const [lx, lz] = off(x, z, a, -0.45, s * w * 0.3);
      pole(lx, foot, lz, b.water ? 0.38 : 0.3, yc - foot, POST_GREY, FAR.board);
    }
    const [bx, bz] = off(x, z, a, -0.22, 0), [fx, fz] = off(x, z, a, 0.0, 0), [wx, wz] = off(x, z, a, 0.55, 0);
    box(bx, yc, bz, a, 0.4, h + 0.45, w + 0.45, '#2b2f33', FAR.board);
    board(fx, yc, fz, a, w, h, posterTile(b.art % 8));
    box(wx, y0 - 0.25, wz, a, 1.1, 0.1, w, '#565c62', FAR.board);
    for (const s of [-0.33, 0, 0.33]) {
      const [lx, lz] = off(x, z, a, 0.95, s * w);
      box(lx, y0 - 0.05, lz, a, 0.28, 0.22, 0.38, '#2b2f33', FAR.board);
    }
  }

  // ---- furniture and prefab dressing ----
  const kaykit = [];    // [model name, x, y, z, heading, scale, far] placed once the street pack has loaded
  let offLandmarks = 0;
  for (const d of [...(lists.furniture || []), ...(lists.prefab || [])]) {
    const x = d.x / PX, z = d.y / PX, y = gy(x, z), a = d.a ?? 0;
    // the street's furniture is left off a landmark's ground (a prefab's own dressing belongs where it is)
    if (d.list === 'furniture' && onLandmark(x, z, d.kind === 'busStop' ? 2.5 : 0.5)) { offLandmarks++; continue; }
    switch (d.kind) {
      case 'bench': kaykit.push(['bench', x, y, z, a - Math.PI / 2, 4.4, FAR.furniture]); break;
      case 'hydrant': kaykit.push(['firehydrant', x, y, z, a, 3.1, FAR.small]); break;
      case 'bin':
        pole(x, y, z, 0.27, 0.86, '#2f6b4f', FAR.small);
        pole(x, y + 0.86, z, 0.3, 0.07, '#23272b', FAR.small);
        break;
      case 'planter':
        box(x, y + 0.33, z, a, 1.4, 0.66, 1.4, '#f2eee6', FAR.furniture);
        box(x, y + 0.86, z, a, 1.2, 0.42, 1.2, '#4b8a3c', FAR.furniture);
        break;
      case 'busStop': busStop(x, y, z, a); break;
      case 'lounger': {
        // a white frame, a teal cushion and a backrest raised at its head end (local −x)
        box(x, y + 0.3, z, a, 1.95, 0.07, 0.72, '#f6f4ee', FAR.small);
        box(...xyz(off(x, z, a, 0.25, 0), y + 0.37), a, 1.3, 0.08, 0.64, '#2aa39d', FAR.small);
        box(...xyz(off(x, z, a, -0.68, 0), y + 0.62), a, 0.8, 0.08, 0.66, '#2aa39d', FAR.small, -0.75);
        for (const s of [-0.85, 0.85]) boxOn(off(x, z, a, s, 0), y + 0.13, a, 0.06, 0.26, 0.66, '#3a3a3c', FAR.small);
        break;
      }
      case 'umbrella':
        pole(x, y, z, 0.05, 2.5, '#3a3a3c', FAR.furniture);
        cone(x, y + 2.3, z, 1.75, 0.55, '#f1eee8', FAR.furniture);
        break;
      case 'kiosk': kiosk(x, y, z, a); break;
      default: break;     // fountains: landmarks3d
    }
  }
  function busStop(x, y, z, a) {
    // a glass shelter facing the road (a), a bench inside, an ad on its back wall and a BUS sign at the kerb end
    const P = (along, right) => off(x, z, a, along, right);
    for (const [u, v] of [[-0.65, -1.75], [-0.65, 1.75], [0.6, -1.75], [0.6, 1.75]]) { const [px, pz] = P(u, v); pole(px, y, pz, 0.05, 2.5, '#d9dde0', FAR.furniture); }
    boxOn(P(-0.05, 0), y + 2.56, a, 1.7, 0.12, 3.9, '#2aa39d', FAR.furniture);
    boxOn(P(-0.68, 0), y + 1.3, a, 0.06, 2.0, 3.5, '#a9d8e6', FAR.furniture);
    boxOn(P(-0.42, 0), y + 0.46, a, 0.42, 0.07, 2.6, '#b8875a', FAR.furniture);
    board(...xyz(P(-0.63, 0), y + 1.55), a, 2.6, 0.87, posterTile(8), FAR.furniture);
    const [sx, sz] = P(0.75, 2.2);
    pole(sx, y, sz, 0.045, 2.9, POST_GREY, FAR.furniture);
    sign(sx, y + 2.55, sz, a - Math.PI / 2, 0.55, 0.55, cellTile(CELLS.bus), FAR.furniture);
    sign(sx, y + 2.55, sz, a + Math.PI / 2, 0.55, 0.55, cellTile(CELLS.bus), FAR.furniture);
  }
  function kiosk(x, y, z, a) {
    // the Fest events kiosk, served from both long sides so it reads from either side of the plaza: a pink
    // booth on a hot-pink skirt, a dark hatch, a counter and a pink awning with a white valance each way, and the
    // events board on its roof with the sign on both faces
    box(x, y + 1.25, z, a, 2.2, 2.5, 3.2, '#fbe6f1', FAR.furniture);
    box(x, y + 0.2, z, a, 2.3, 0.4, 3.3, '#ff4fa3', FAR.furniture);
    for (const sd of [1, -1]) {
      const face = sd > 0 ? a : a + Math.PI;
      boxOn(off(x, z, a, sd * 1.11, 0), y + 1.62, a, 0.04, 0.95, 2.6, '#5b2d4a', FAR.furniture);
      boxOn(off(x, z, a, sd * 1.2, 0), y + 1.0, a, 0.3, 0.12, 3.2, '#ffffff', FAR.furniture);
      // the awning slopes down and out from the roof's edge, a white valance along its foot
      box(...xyz(off(x, z, a, sd * 1.52, 0), y + 2.36), face, 0.95, 0.06, 3.4, '#ff4fa3', FAR.furniture, -0.38);
      boxOn(off(x, z, a, sd * 1.97, 0), y + 2.1, face, 0.04, 0.24, 3.4, '#ffffff', FAR.furniture);
      sign(...xyz(off(x, z, a, sd * 0.06, 0), y + 3.15), face, 2.9, 1.25, cellTile(CELLS.events, 2), FAR.furniture);
    }
    box(x, y + 2.56, z, a, 2.4, 0.12, 3.4, '#f1eee8', FAR.furniture);
    box(x, y + 3.15, z, a, 0.06, 1.3, 2.95, '#3a3a3c', FAR.furniture);
  }

  // ---- the villa's pool terrace ----
  const terrace = villaTerrace(world, chunks, night);

  // ---- bollards on the boardwalk and at the top of the Cove Stairs ----
  for (const f of lists.fences || []) {
    if (f.kind !== 'bollards' || !f.pts) continue;
    const wood = f.path === 'glades_boardwalk';
    for (let i = 0; i + 1 < f.pts.length; i += 2) {
      const x = f.pts[i] / PX, z = f.pts[i + 1] / PX, y = gy(x, z);
      pole(x, y - 0.1, z, wood ? 0.1 : 0.12, wood ? 1.05 : 0.95, wood ? '#7a5a3a' : '#f2eee6', FAR.small);
    }
  }

  // ---- traffic lights at the signal junctions: the KayKit model, scaled to the road, with our lenses ----
  const signals = (lists.signals || []).map((s) => {
    const x = s.x / PX, z = s.y / PX, e = net?.edges?.[s.edge];
    const halfW = e ? e.halfW / PX : 6;
    // the head over the middle of the approach lanes: the model's head is 0.67 of its scale out along the arm
    const scale = Math.max(5.5, Math.min(7.5, (halfW / 2 + 0.8) / 0.67));
    return { s, x, y: gy(x, z), z, a: s.a, scale };
  });
  const lensOf = new Map();
  for (const sg of signals) {
    const m = at(sg.x, sg.y, sg.z, sg.a - Math.PI / 2, sg.scale, sg.scale, sg.scale).clone();
    for (const L of TL_LENS) {
      _P.compose(_V.set(TL_LENS_X, L.y, TL_LENS_Z), _Q.identity(), _S.setScalar(TL_LENS_R));
      const wm = new THREE.Matrix4().multiplyMatrices(m, _P), p = new THREE.Vector3().setFromMatrixPosition(wm);
      const it = F.add(K.lens, wm, p.x, p.y, p.z, 0.3, FAR.signal, LENS.off.slice());
      lensOf.set(it, { node: sg.s.node, edge: sg.s.edge, lit: L.s });
    }
  }
  const paintLens = (it) => {
    const L = lensOf.get(it), st = net?.signalAt?.(L.node, L.edge);
    const c = st === L.lit ? LENS[L.lit] : LENS.off;
    it.c[0] = c[0]; it.c[1] = c[1]; it.c[2] = c[2];
  };

  for (const k of Object.values(K)) F.seal(k);

  // the street pack's models arrive later: then the traffic lights, benches and hydrants appear
  let pack = null;
  loadAssetPack('assets/street.glb').then((p) => {
    pack = p;
    const kinds = {};
    const kindFor = (name, o) => (kinds[name] ||= p.has(name) ? F.kind(name, p.get(name).parts.map(q => ({ geometry: q.geometry, material: q.material, matrix: q.matrix })), o) : null);
    for (const sg of signals) {
      const k = kindFor('trafficlight_C', { shadow: true });
      if (k) F.add(k, at(sg.x, sg.y, sg.z, sg.a - Math.PI / 2, sg.scale, sg.scale, sg.scale), sg.x, sg.y + sg.scale * 0.5, sg.z, sg.scale * 0.75, FAR.signal);
    }
    for (const [name, x, y, z, a, s, far] of kaykit) {
      const k = kindFor(name, { shadow: name === 'bench' });
      if (k) F.add(k, at(x, y, z, a, s, s, s), x, y + s * 0.15, z, s * 0.3, far);
    }
    for (const k of Object.values(kinds)) if (k) F.seal(k);
    K.lens.on = !!kinds.trafficlight_C;
    F.touch();
  }).catch((e) => console.warn('street props pack failed to load; no traffic lights, benches or hydrants', e));

  const nearestLamps = lampSearch(lampHeads);
  let nightK = -1;
  return {
    nearestLamps,
    lampHeads,
    update(camera, t, n = 0) {
      if (Math.abs(n - nightK) > 0.002) {
        nightK = n;
        for (const [m, prop, d, v] of nightList) m[prop] = d + (v - d) * n;
        const far = 1 + (LAMP_NIGHT_K - 1) * Math.min(1, n * 1.5);
        if (Math.abs(far - K.head.farK) > 0.05) { K.head.farK = far; F.touch(); }
      }
      pools.update(camera, nightK > 0.03);
      alleyPools.update(camera, nightK > 0.03);
      terrace?.update(camera, t);
      F.update(camera);
      if (K.lens.on) F.recolor(K.lens, paintLens);
    },
    stats() { return { ...F.stats(), lamps: lampHeads.length, signals: signals.length, pack: !!pack, offLandmarks, pools: pools.stats(), terrace: !!terrace, alley: alleyPools.stats() }; },
    advisories,     // [{ sign (the world's advisory record), right (its arrow bends right) }], for the tests
  };
}

// ---------- small helpers ----------

function groupBy(list, key) {
  const out = {};
  for (const d of list) (out[d[key]] ||= []).push(d);
  return out;
}
const xyz = ([x, z], y) => [x, y, z];

// The exit names the gantries show, in a fixed order (first seen), for the atlas.
function gantryNames(deco) {
  const names = [];
  for (const d of deco) if (d.kind === 'gantry' && d.name && !names.includes(d.name)) names.push(d.name);
  return names;
}

// The point of edge e at station s (px): { x, z, y (m), tx, tz }
function edgePoint(e, s) {
  let lo = 0, hi = e.n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (e.s[m] <= s) lo = m; else hi = m; }
  const f = e.s[hi] > e.s[lo] ? Math.max(0, Math.min(1, (s - e.s[lo]) / (e.s[hi] - e.s[lo]))) : 0;
  const tx = e.tx[lo] + (e.tx[hi] - e.tx[lo]) * f, tz = e.ty[lo] + (e.ty[hi] - e.ty[lo]) * f, l = Math.hypot(tx, tz) || 1;
  return { x: (e.x[lo] + (e.x[hi] - e.x[lo]) * f) / PX, z: (e.y[lo] + (e.y[hi] - e.y[lo]) * f) / PX, y: e.gy[lo] + (e.gy[hi] - e.gy[lo]) * f, tx: tx / l, tz: tz / l };
}

// The way ('L' | 'R', along the edge's point order) the bend ahead of an advisory sign turns: the signed
// curvature summed over the first sharp stretch (radius under 120 m) within 80 m past the sign, the way its
// traffic goes.
function curveAhead(e, c) {
  if (!e?.k) return 'R';
  let i0 = 0, best = Infinity;
  for (let i = 0; i < e.n; i++) { const d = (e.x[i] - c.x) ** 2 + (e.y[i] - c.y) ** 2; if (d < best) { best = d; i0 = i; } }
  const dir = (c.dir ?? 1) > 0 ? 1 : -1, sharp = 1 / (120 * PX);
  let sum = 0, inBend = false;
  for (let i = i0; i >= 0 && i < e.n && Math.abs(e.s[i] - e.s[i0]) < 80 * PX; i += dir) {
    if (Math.abs(e.k[i]) >= sharp) { sum += e.k[i]; inBend = true; } else if (inBend) break;
  }
  return sum < 0 ? 'L' : 'R';
}

// The height (m) of edge e's carriageway nearest to (x, y) px: a billboard over the water stands above the deck.
function roadHeightNear(net, ei, x, y) {
  const e = net?.edges?.[ei];
  if (!e?.gy) return -Infinity;
  let best = Infinity, h = -Infinity;
  for (let i = 0; i < e.n; i++) {
    const d = (e.x[i] - x) ** 2 + (e.y[i] - y) ** 2;
    if (d < best) { best = d; h = e.gy[i]; }
  }
  return h;
}
