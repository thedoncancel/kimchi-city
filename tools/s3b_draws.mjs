// What three.js r169 would draw for a scene, without a GPU (stage S3b tests): the camera pass and the
// directional light's shadow pass, walked the way WebGLRenderer.projectObject and WebGLShadowMap.renderObject
// walk them (visibility, layers, frustum culling with the same bounding spheres, onBeforeShadow and
// onAfterShadow around each shadow draw, draw ranges and instance counts). Each draw is reported as
// { obj, start, count, instances } in index (or vertex) units; calls and triangles are counted the way
// renderer.info counts them (an instanced draw of 0 copies is skipped, any other draw counts as a call).
// Import after s3b_env.mjs.
const THREE = await import('three');

const _frustum = new THREE.Frustum(), _pv = new THREE.Matrix4();

// the range of a geometry that renderBufferDirect would draw (null: nothing at all)
function range(obj, geometry, group) {
  const index = geometry.index, pos = geometry.attributes.position, dr = geometry.drawRange;
  let start = dr.start, end = dr.start + dr.count;
  if (group) { start = Math.max(start, group.start); end = Math.min(end, group.start + group.count); }
  start = Math.max(start, 0);
  end = Math.min(end, index ? index.count : pos.count);
  const count = end - start;
  if (count < 0 || count === Infinity) return null;
  return { start, count };
}

function draw(out, obj, geometry, group) {
  const r = range(obj, geometry, group);
  if (!r) return;
  const instances = obj.isInstancedMesh ? obj.count : 1;
  if (obj.isInstancedMesh && instances === 0) return;
  out.calls++;
  out.tris += Math.floor(r.count / 3) * instances;
  out.draws.push({ obj, start: r.start, count: r.count, instances });
}

// the camera pass: every visible mesh whose bounding sphere meets the camera's frustum
export function cameraPass(scene, camera) {
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  _frustum.setFromProjectionMatrix(_pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const out = { calls: 0, tris: 0, draws: [] };
  const visit = (o) => {
    if (o.visible === false) return;
    if (o.layers.test(camera.layers) && o.isMesh && (!o.frustumCulled || _frustum.intersectsObject(o))) {
      const m = o.material;
      if (Array.isArray(m)) { for (const g of o.geometry.groups) if (m[g.materialIndex]?.visible) draw(out, o, o.geometry, g); }
      else if (m.visible) draw(out, o, o.geometry, null);
    }
    for (const c of o.children) visit(c);
  };
  visit(scene);
  return out;
}

// the shadow pass of one directional light (its shadow camera already placed with shadow.updateMatrices)
export function shadowPass(scene, camera, light) {
  scene.updateMatrixWorld(true);
  const shadowCamera = light.shadow.camera, sf = light.shadow.getFrustum();
  const out = { calls: 0, tris: 0, draws: [] };
  const visit = (o) => {
    if (o.visible === false) return;
    if (o.layers.test(camera.layers) && o.isMesh && o.castShadow && (!o.frustumCulled || sf.intersectsObject(o))) {
      const m = o.material, groups = Array.isArray(m) ? o.geometry.groups : [null];
      for (const g of groups) {
        const mm = g ? m[g.materialIndex] : m;
        if (!mm?.visible) continue;
        o.onBeforeShadow(null, o, camera, shadowCamera, o.geometry, null, g);
        draw(out, o, o.geometry, g);
        o.onAfterShadow(null, o, camera, shadowCamera, o.geometry, null, g);
      }
    }
    for (const c of o.children) visit(c);
  };
  visit(scene);
  return out;
}

// A light like sky.js's sun at a time of day (minutes), centred on focus as sky.js centres it.
export function placeSun(light, minutes, focus) {
  const th = Math.PI * ((minutes % 1440 - 360) / 780);
  const v = new THREE.Vector3(Math.cos(th), Math.sin(th), 0.42).normalize();
  light.target.position.copy(focus);
  light.position.copy(focus).addScaledVector(v, 200);
  light.target.updateMatrixWorld();
  light.updateMatrixWorld();
  light.shadow.updateMatrices(light);
}

// sky.js's high-tier sun (the desktop look the bench measures): a 128 m shadow box, 420 m deep. three.js
// applies the box to the shadow camera's projection only when it makes the shadow map (WebGLShadowMap.render
// calls updateProjectionMatrix there); with no renderer here, that is done now, or the shadow frustum would
// stay three's default 10 m one.
export function makeSun(half = 64) {
  const sun = new THREE.DirectionalLight('#ffffff', 3);
  sun.castShadow = true;
  const sc = sun.shadow.camera;
  sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half; sc.near = 1; sc.far = 420;
  sc.updateProjectionMatrix();
  return sun;
}

// main3d's chase camera for a bench view: Kimchi on the view's spot, the camera 4.5 m behind him at the
// default pitch, pulled in where occluderTop says a building is in the way. Returns the shadow focus.
export function placeCamera(camera, v, { groundY, occluderTop }) {
  const S = 1 / 16, tx = v.x * S, tz = v.y * S, gy = groundY(v.x, v.y), ty = gy + 1.4;
  const pitch = 0.34, dist = 4.5, dirx = -Math.cos(v.yaw), dirz = -Math.sin(v.yaw);
  let hd = dist * Math.cos(pitch);
  const h = dist * Math.sin(pitch);
  for (let d = 0.8; d <= hd; d += 0.4) {
    if (occluderTop && occluderTop(tx + dirx * d, tz + dirz * d) > ty + h * (d / hd) - 0.3) { hd = Math.max(0.9, d - 0.5); break; }
  }
  camera.position.set(tx + dirx * hd, ty + h * Math.min(1, hd / (dist * Math.cos(pitch)) + 0.25), tz + dirz * hd);
  camera.lookAt(tx, ty + 0.15, tz);
  camera.updateMatrixWorld(true);
  return new THREE.Vector3(tx, gy, tz);
}
