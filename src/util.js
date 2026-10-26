export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const pick = (arr, r = Math.random) => arr[Math.floor(r() * arr.length)];
export function angDiff(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
export function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
export function circle(ctx, x, y, r) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}
export function ellipse(ctx, x, y, rx, ry) {
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
}

// $950, $12,400, $245K, $3.2M
export function money(n) {
  const a = Math.abs(Math.round(n)), s = n < 0 ? '-$' : '$';
  const trim = (v, d) => v.toFixed(d).replace(/\.?0+$/, '');
  if (a >= 1e9) return s + trim(a / 1e9, 2) + 'B';
  if (a >= 1e6) return s + trim(a / 1e6, 2) + 'M';
  if (a >= 1e5) return s + Math.round(a / 1e3) + 'K';
  return s + a.toLocaleString('en-US');
}
// 197.5K followers
export function compact(n) {
  const a = Math.abs(n);
  const trim = (v, d) => v.toFixed(d).replace(/\.?0+$/, '');
  if (a >= 1e6) return trim(n / 1e6, a >= 1e7 ? 1 : 2) + 'M';
  if (a >= 1e3) return trim(n / 1e3, a >= 1e5 ? 1 : 1) + 'K';
  return String(Math.round(n));
}
