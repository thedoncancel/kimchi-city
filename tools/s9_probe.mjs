#!/usr/bin/env node
// Stage S9: where a v2 bench view's GPU time goes. Loads one view in headless Chrome (the dev server on :5173),
// then through the DevTools protocol runs KC3.bench on it once as it is and once per experiment, each undone
// before the next, and prints the difference each made, in calls, triangles, the GPU timer and the real frame
// time (frames uncapped). Headless the GPU timer counts idle gaps (tools/s9_bench.mjs), so the frame time is the
// one to trust; the shares rank what to cut.
//   node tools/s9_probe.mjs <view> [--hour=13] [--frames=60] [--dump] [--exp=name,name]
// Experiments (all by default):
//   noshadow  the sun casts no shadow map        shadow1k  a 1024 shadow map (Medium has 2048)
//   shadowfrozen  the shadow map kept but no longer redrawn (the shadow pass's own cost)
//   nobloom   the finishing pass without bloom   level3    the Low level (pixel ratio 0.85)
//   hide:<re> every object whose name matches the regular expression <re>, hidden (e.g. hide:^terrain)
//   shadowtype:<n>  renderer.shadowMap.type n (0 Basic, 1 PCF, 2 PCFSoft, 3 VSM), every material recompiled
//   shadowbox:<m>   the sun's shadow box m metres each side of the focus
//   nocast:<re>     meshes named <re> stop casting shadows
//   noreceive:<re>  meshes named <re> stop receiving shadows
//   order:<n> every object drawn at renderOrder n, hidden (sky.js: -8 the clouds, -9 the stars, -10 the sky)
//   mat:<re>  every mesh whose material type matches <re>, hidden (e.g. mat:Standard)
// --profile samples the page's JavaScript for 4 s and prints the top self times.
// --tris prints the main pass's triangles in view by owner; --casters lists the shadow casters.
// --dump prints the scene's top levels: name, type, drawn meshes and triangles under each.
import { openPage, FRAME_TIMES, sleep } from './s9_lib.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const view = args.find((a) => !a.startsWith('--')) || 'villa_terrace';
const hour = +opt('hour', 13), frames = +opt('frames', 60), dump = args.includes('--dump');
const EXPS = opt('exp', 'noshadow,shadow1k,nobloom,level3,hide:^terrain,hide:^roads|^paint,mat:Standard,hide:^flora|^palms|^trees|^shrubs|^scatter,hide:^sea$').split(',');

// in the page: apply one experiment, returning a function that undoes it
const APPLY = /* js */`(exp) => {
  const { scene, gfx, sky, renderer } = KC3, undo = [];
  const hideWhere = (test) => scene.traverse((o) => { if (o !== scene && o.visible && test(o)) { o.visible = false; undo.push(() => { o.visible = true; }); } });
  if (exp === 'noshadow') { const s = sky.sun; s.castShadow = false; undo.push(() => { s.castShadow = true; }); }
  else if (exp === 'shadow1k') { const s = sky.sun.shadow, n = s.mapSize.x; s.mapSize.set(1024, 1024); s.map?.dispose(); s.map = null;
    undo.push(() => { s.mapSize.set(n, n); s.map?.dispose(); s.map = null; }); }
  else if (exp === 'shadowfrozen') { const sm = renderer.shadowMap; sm.autoUpdate = false; sm.needsUpdate = false; undo.push(() => { sm.autoUpdate = true; }); }
  else if (exp === 'nobloom') { const f = gfx.passes.film; f.bloom = false; undo.push(() => { f.bloom = true; }); }
  else if (exp === 'level3') { const l = gfx.level; gfx.setLevel(3); undo.push(() => gfx.setLevel(l)); }
  else if (exp.startsWith('shadowtype:')) {
    // a different shadow filter: every material recompiles (the bench's warm-up frames cover it)
    const sm = renderer.shadowMap, t = sm.type, recompile = () => scene.traverse((o) => { for (const m of [].concat(o.material || [])) m.needsUpdate = true; });
    sm.type = +exp.slice(11); recompile(); undo.push(() => { sm.type = t; recompile(); });
  } else if (exp.startsWith('shadowbox:')) {
    const c = sky.sun.shadow.camera, h = c.right; c.left = c.bottom = -(+exp.slice(10)); c.right = c.top = +exp.slice(10); c.updateProjectionMatrix();
    undo.push(() => { c.left = c.bottom = -h; c.right = c.top = h; c.updateProjectionMatrix(); });
  } else if (exp.startsWith('noreceive:')) {
    const re = new RegExp(exp.slice(10));
    scene.traverse((o) => { if (o.receiveShadow && re.test(o.name || '')) { o.receiveShadow = false; for (const m of [].concat(o.material)) m.needsUpdate = true;
      undo.push(() => { o.receiveShadow = true; for (const m of [].concat(o.material)) m.needsUpdate = true; }); } });
  } else if (exp.startsWith('nocast:')) {
    const re = new RegExp(exp.slice(7));
    scene.traverse((o) => { if (o.castShadow && !o.isLight && re.test(o.name || '')) { o.castShadow = false; undo.push(() => { o.castShadow = true; }); } });
  } else if (exp.startsWith('hide:')) { const re = new RegExp(exp.slice(5)); hideWhere((o) => re.test(o.name || '')); }
  else if (exp.startsWith('order:')) hideWhere((o) => o.renderOrder === +exp.slice(6));
  else if (exp.startsWith('mat:')) { const re = new RegExp(exp.slice(4)); hideWhere((o) => o.isMesh && [].concat(o.material).some((m) => re.test(m.type))); }
  window.__undo = () => { for (const f of undo.reverse()) f(); };
  return undo.length;
}`;
const DUMP = /* js */`(() => {
  const out = [];
  const visit = (o, depth) => {
    let meshes = 0, tris = 0;
    o.traverseVisible((m) => { if (m.isMesh || m.isPoints) { meshes++; const g = m.geometry, n = g.index ? g.index.count : g.attributes.position?.count || 0;
      tris += (m.isInstancedMesh ? m.count : 1) * n / 3; } });
    out.push('  '.repeat(depth) + (o.name || '(' + o.type + ')') + '  ' + o.type + (o.visible ? '' : ' hidden') + '  meshes ' + meshes + '  tris ' + Math.round(tris));
    if (depth < 1 || (depth < 2 && o.children.length < 40)) for (const c of o.children) visit(c, depth + 1);
  };
  visit(KC3.scene, 0);
  return out.join('\\n');
})()`;

// the main pass's triangles by what they belong to: the nearest named ancestor's name (digits dropped, so the
// tiles of one kind add up), counting only meshes whose bounds are in the camera's view
const TRIS = /* js */`(() => {
  const T = KC3.scene.children[0].constructor, cam = KC3.camera, by = {};
  const Fr = Object.getPrototypeOf(cam.projectionMatrix).constructor;
  const m = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse);
  const frustum = new (KC3.renderer.constructor.Frustum || Object)();
  const planes = [];
  const e = m.elements;
  const P = (a, b, c, d) => { const l = Math.hypot(a, b, c); planes.push([a / l, b / l, c / l, d / l]); };
  P(e[3] - e[0], e[7] - e[4], e[11] - e[8], e[15] - e[12]); P(e[3] + e[0], e[7] + e[4], e[11] + e[8], e[15] + e[12]);
  P(e[3] + e[1], e[7] + e[5], e[11] + e[9], e[15] + e[13]); P(e[3] - e[1], e[7] - e[5], e[11] - e[9], e[15] - e[13]);
  P(e[3] - e[2], e[7] - e[6], e[11] - e[10], e[15] - e[14]); P(e[3] + e[2], e[7] + e[6], e[11] + e[10], e[15] + e[14]);
  KC3.scene.traverseVisible((o) => {
    if (!(o.isMesh || o.isPoints)) return;
    const g = o.geometry;
    if (o.frustumCulled && !o.isInstancedMesh) {
      if (!g.boundingSphere) g.computeBoundingSphere();
      const c = g.boundingSphere.center.clone().applyMatrix4(o.matrixWorld), r = g.boundingSphere.radius * o.matrixWorld.getMaxScaleOnAxis();
      if (planes.some((p) => p[0] * c.x + p[1] * c.y + p[2] * c.z + p[3] < -r)) return;
    }
    const n = (g.index ? g.index.count : g.attributes.position.count) / 3 * (o.isInstancedMesh ? o.count : 1);
    let a = o; while (a && !a.name && a.parent && a.parent !== KC3.scene) a = a.parent;
    const k = (a.name || a.type).replace(/[-\\d, ]+$/, '');
    by[k] = (by[k] || 0) + n;
  });
  return Object.entries(by).sort((x, y) => y[1] - x[1]).slice(0, 30).map(([k, v]) => k.padEnd(28) + Math.round(v / 1000) + ' k').join('\\n');
})()`;
// the shadow pass's draws by owner (nearest named ancestor, digits dropped): visible casters whose bounds are in the
// sun's shadow box, as three's shadow pass culls them; instanced meshes count once, with their casting copies
const CASTERS = /* js */`(() => {
  const sc = KC3.sky.sun.shadow.camera, by = {};
  sc.updateMatrixWorld(); sc.updateProjectionMatrix();
  const m = sc.projectionMatrix.clone().multiply(sc.matrixWorldInverse), e = m.elements, planes = [];
  const P = (a, b, c, d) => { const l = Math.hypot(a, b, c); planes.push([a / l, b / l, c / l, d / l]); };
  P(e[3] - e[0], e[7] - e[4], e[11] - e[8], e[15] - e[12]); P(e[3] + e[0], e[7] + e[4], e[11] + e[8], e[15] + e[12]);
  P(e[3] + e[1], e[7] + e[5], e[11] + e[9], e[15] + e[13]); P(e[3] - e[1], e[7] - e[5], e[11] - e[9], e[15] - e[13]);
  P(e[3] - e[2], e[7] - e[6], e[11] - e[10], e[15] - e[14]); P(e[3] + e[2], e[7] + e[6], e[11] + e[10], e[15] + e[14]);
  KC3.scene.traverseVisible((o) => {
    if (!o.castShadow || !(o.isMesh || o.isPoints)) return;
    const g = o.geometry;
    if (o.frustumCulled && !o.isInstancedMesh) {
      if (!g.boundingSphere) g.computeBoundingSphere();
      const c = g.boundingSphere.center.clone().applyMatrix4(o.matrixWorld), r = g.boundingSphere.radius * o.matrixWorld.getMaxScaleOnAxis();
      if (planes.some((p) => p[0] * c.x + p[1] * c.y + p[2] * c.z + p[3] < -r)) return;
    }
    const n = (g.index ? g.index.count : g.attributes.position.count) / 3 * (o.isInstancedMesh ? (o.userData.nCast ?? o.count) : 1);
    let a = o; while (a && !a.name && a.parent && a.parent !== KC3.scene) a = a.parent;
    const k = (a.name || a.type).replace(/[-\\d, ]+$/, ''), v = (by[k] ||= [0, 0]);
    v[0]++; v[1] += n;
  });
  return Object.entries(by).sort((x, y) => y[1][0] - x[1][0]).map(([k, v]) => k.padEnd(28) + String(v[0]).padStart(4) + ' draws ' + Math.round(v[1] / 1000) + ' k').join('\\n');
})()`;
// frames uncapped, so the frame time measures real throughput (the GPU timer includes idle gaps)
const page = await openPage(`map=2&shot=${view}&hour=${hour}`, { uncapped: true });
try {
  const { evaluate, call } = page;
  await page.ready(4000);
  console.log(await evaluate(`(() => { const gl = KC3.renderer.getContext(), e = gl.getExtension('WEBGL_debug_renderer_info');
    return 'GPU: ' + (e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) + ', shadow map ' + KC3.sky.sun.shadow.mapSize.x + ', pixel ratio ' + KC3.renderer.getPixelRatio(); })()`));
  if (dump) console.log(await evaluate(DUMP));
  if (args.includes('--profile')) {
    // 4 s of the page's JavaScript, sampled: self time by function and file, the top 30
    await call('Profiler.enable'); await call('Profiler.setSamplingInterval', { interval: 200 }); await call('Profiler.start');
    await sleep(4000);
    const prof = (await call('Profiler.stop')).result.profile, self = new Map(), dt = new Map();
    for (let i = 0; i < prof.samples.length; i++) dt.set(prof.samples[i], (dt.get(prof.samples[i]) || 0) + (prof.timeDeltas[i + 1] || 0));
    let total = 0;
    for (const n of prof.nodes) {
      const t = (dt.get(n.id) || 0) / 1000, f = n.callFrame, k = `${f.functionName || '(anon)'}  ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber + 1}`;
      self.set(k, (self.get(k) || 0) + t); total += t;
    }
    console.log(`JS profile, 4 s, ${Math.round(total)} ms sampled:`);
    for (const [k, t] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${(t / 4).toFixed(2).padStart(7)} ms/s  ${k}`);
  }
  if (args.includes('--tris')) console.log(await evaluate(TRIS));
  if (args.includes('--casters')) console.log(await evaluate(CASTERS));
  // KC3.bench's numbers plus the median real frame time over 2 s right after it (frames uncapped)
  const bench = async () => ({ ...(await evaluate(`KC3.bench(['${view}'], { frames: ${frames}, warm: 40, time: ${hour * 60} }).then((r) => r[0])`)), ...(await evaluate(FRAME_TIMES)) });
  const base = await bench();
  console.log(`${view} h${hour} base: calls ${base.calls} tris ${(base.tris / 1e6).toFixed(3)} M gpu ${base.gpuMs} ms cpu ${base.cpuMs} frame ${base.frameMs} ms`);
  for (const exp of EXPS) {
    const n = await evaluate(`(${APPLY})(${JSON.stringify(exp)})`);
    const r = await bench();
    await evaluate('window.__undo()');
    console.log(`  ${exp.padEnd(48)} (${String(n).padStart(4)} switched)  calls ${String(r.calls - base.calls).padStart(5)}  tris ${((r.tris - base.tris) / 1e3).toFixed(0).padStart(6)} k  gpu ${(r.gpuMs - base.gpuMs).toFixed(2).padStart(6)} ms  frame ${(r.frameMs - base.frameMs).toFixed(2).padStart(6)} ms`);
  }
  const again = await bench();
  console.log(`  (base again: gpu ${again.gpuMs} ms, frame ${again.frameMs} ms, calls ${again.calls})`);
} finally {
  await page.close();
}
