// A small frame-rate readout in the corner: frames per second, the slowest frame, how long the graphics card
// takes per frame (where the browser can measure it) and the quality level Auto picked.
// ` (backquote) or F3 shows and hides it; ?fps=1 in the address turns it on.

export function makeFpsMeter(gfx, mode) {
  const el = document.createElement('div');
  el.id = 'fpsMeter';
  document.body.appendChild(el);
  let on = new URLSearchParams(location.search).get('fps') === '1';
  try { on = on || localStorage.getItem('kc-fps') === '1'; } catch (e) {}
  const show = () => { el.style.display = on ? 'block' : 'none'; };
  show();
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Backquote' && e.code !== 'F3') return;
    e.preventDefault();
    on = !on; show();
    try { localStorage.setItem('kc-fps', on ? '1' : '0'); } catch (e2) {}
  });
  let n = 0, acc = 0, worst = 0;
  return {
    frame(dt) {
      if (dt > 1) return;
      n++; acc += dt; worst = Math.max(worst, dt);
      if (acc < 0.5) return;
      if (on) {
        const fps = Math.round(n / acc), gpu = gfx.gpuMs ? ` · GPU ${gfx.gpuMs.toFixed(1)} ms` : '';
        const q = gfx.level < 0 ? 'Phone' : `${gfx.name}${mode === 'auto' ? ' (Auto)' : ''}`;
        el.innerHTML = `<b class="${fps >= 55 ? 'ok' : fps >= 40 ? 'meh' : 'bad'}">${fps} fps</b> · worst ${Math.round(worst * 1000)} ms${gpu}<br>Graphics: ${q}`;
      }
      n = 0; acc = 0; worst = 0;
    },
  };
}
