import * as THREE from 'three';

// Graphics tier. Computers get the full look (physical sky lighting, PBR everywhere, ambient occlusion,
// bloom, colour grading); phones and small screens get a lighter version that keeps the frame rate up.
// Force either one with ?gfx=high or ?gfx=low in the address.
// The title screen's Graphics switch stores 'auto', 'high' or 'low'. Auto starts on the full look and
// lets graphics.js step it down until the frame rate is smooth; High never steps down.
let stored = null;
try { stored = localStorage.getItem('kc-gfx'); } catch (e) {}
const forced = new URLSearchParams(location.search).get('gfx') || stored;
const touch = window.matchMedia('(pointer: coarse)').matches;
export const MODE = forced === 'high' || forced === 'low' ? forced : 'auto';
export const LOW = MODE !== 'auto' ? MODE === 'low' : touch || Math.min(window.innerWidth, window.innerHeight) < 520;
export const HIGH = !LOW;

// a non-shiny surface: physically based on the high tier (so the sky lights it), cheap Lambert on the low one
export function matte(o = {}, rough = 0.9) {
  return HIGH ? new THREE.MeshStandardMaterial({ roughness: rough, metalness: 0, ...o }) : new THREE.MeshLambertMaterial(o);
}
