#!/usr/bin/env node
// Stage S3a check (docs/map-v2-stages.json): src/3d/geo.js's Builder now keeps its vertices in growable typed
// arrays with an index, and gains setMatrix, ribbon and build({ indexed }).
//   node tools/s3a_geo_test.mjs [baselineDir]
// With a baseline copy of the project (argument or $KC_BASELINE), the old and new Builder run the same
// programs (axis boxes in every option, quads, triangles, indexed and plain geometries, thousands of mixed
// primitives) and the outputs must match bit for bit while setMatrix is null. Without it, only the checks that
// need no baseline run. Then: setMatrix (placement, texture coordinates worked out before it, mirrored
// matrices keep faces outward, the spec §1 local frame), ribbon (positions, normals, curbs, bank, grade,
// RoadNet edges, ranges), build({ indexed }) against the spelled-out triangles, and the time taken.
// Exits 1 if any check fails.
import { HAVE_BASE, BASE, src, base, check, section, note, done, rng } from './s3a_env.mjs';

const THREE = await import('three');
const NEW = await import(src('src/3d/geo.js'));
const OLD = HAVE_BASE ? await import(base('src/3d/geo.js')) : null;
const { sampleCurve } = await import(src('src/map/spline.js'));

const bits = (a) => new Uint32Array(Float32Array.from(a).buffer);
function sameArr(a, b) {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  const x = bits(a), y = bits(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
const maxDiff = (a, b) => { let d = a.length === b.length ? 0 : Infinity; for (let i = 0; i < a.length && d < Infinity; i++) d = Math.max(d, Math.abs(a[i] - b[i])); return d; };
const ATTRS = ['position', 'normal', 'uv', 'color'];
function sameGeo(g1, g2) {
  for (const k of ATTRS) {
    const a = g1.attributes[k], b = g2.attributes[k];
    if (!a || !b || a.itemSize !== b.itemSize || !sameArr(a.array, b.array)) return `${k} differs`;
  }
  if (!!g1.index !== !!g2.index) return 'index differs';
  if (Math.abs(g1.boundingSphere.radius - g2.boundingSphere.radius) > 0 || g1.boundingSphere.center.distanceTo(g2.boundingSphere.center) > 0) return 'bounding sphere differs';
  return null;
}
// the triangles of an indexed geometry spelled out, as a non-indexed one
function expand(g) {
  const I = g.index.array, out = {};
  for (const k of ATTRS) {
    const a = g.attributes[k], n = a.itemSize, o = new Float32Array(I.length * n);
    for (let t = 0; t < I.length; t++) for (let j = 0; j < n; j++) o[t * n + j] = a.array[I[t] * n + j];
    out[k] = o;
  }
  return out;
}
// every triangle faces the way its vertex normals say (winding and normals agree)
function windingAgrees(g, minDot = 0) {
  const P = g.attributes.position.array, N = g.attributes.normal.array, I = g.index ? g.index.array : null;
  const cnt = I ? I.length : P.length / 3;
  const at = (k) => (I ? I[k] : k);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), vn = new THREE.Vector3();
  let bad = 0;
  for (let k = 0; k < cnt; k += 3) {
    a.fromArray(P, at(k) * 3); b.fromArray(P, at(k + 1) * 3); c.fromArray(P, at(k + 2) * 3);
    n.crossVectors(b.clone().sub(a), c.clone().sub(a));
    if (n.lengthSq() < 1e-14) continue;
    n.normalize();
    vn.fromArray(N, at(k) * 3).add(new THREE.Vector3().fromArray(N, at(k + 1) * 3)).add(new THREE.Vector3().fromArray(N, at(k + 2) * 3)).normalize();
    if (n.dot(vn) <= minDot) bad++;
  }
  return bad;
}

// ---------- programs both Builders run ----------

const C = (h) => new THREE.Color(h);
const programs = {
  'axis box': (B) => B.box(1, 0, 2, 4, 3, 7),
  'axis box, colour': (B) => B.box(-3.5, 0.16, 10.25, 2.75, 12.5, 18, C('#c08a5b')),
  'axis box, world uv': (B) => B.box(10, 0.16, 20, 26, 14.6, 31, C('#ffffff'), { uv: 'world', us: 4, vs: 3.2, uOff: 0.37, vOff: 0.25, vBase: 0.5 }),
  'axis box, faces': (B) => { B.box(0, 0, 0, 1, 1, 1, C('#808080'), { top: false, bottom: true, px: false }); B.box(5, 1, 5, 6, 2, 9, C('#333'), { nz: false, pz: false }); },
  'quad and tri': (B) => {
    B.quad([0, 0, 0], [0, 0, 1], [1, 0.5, 1], [1, 0.2, 0], [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]], C('#123456'));
    B.tri([3, 1, 3], [4, 2, 3.5], [3.5, 1.2, 5], undefined, C('#fedcba'));
  },
  'geo, indexed box': (B) => B.geo(new THREE.BoxGeometry(1.2, 0.4, 2), NEW.mat4(3, 1, 4, 0, 0.7, 0), C('#aa8844')),
  'geo, cylinder': (B) => B.geo(new THREE.CylinderGeometry(0.2, 0.25, 3, 9), NEW.mat4(-2, 1.5, 7, 0.1, 1.2, -0.05, 1.5, 1, 0.8)),
  'geo, plain sphere': (B) => B.geo(new THREE.SphereGeometry(1, 7, 5).toNonIndexed(), NEW.mat4(0, 2, 0, 0, 0, 0, 2)),
  'geo, colours': (B) => {
    const g = new THREE.ConeGeometry(1, 2, 6);
    const n = g.attributes.position.count, c = new Float32Array(n * 3);
    for (let i = 0; i < c.length; i++) c[i] = (i % 7) / 7;
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    B.geo(g, NEW.mat4(1, 0, 1, 0, 2, 0), C('#80c0ff'));
  },
  // the kinds of geometry cars.js and kimchi.js feed it: extruded side profiles, cylinders turned on their
  // side, partial spheres (the hair) and capsules
  'geo, car and Kimchi shapes': (B) => {
    const shape = new THREE.Shape([[-2, 0.3], [-2, 0.9], [1.6, 0.9], [2, 0.7], [2, 0.3]].map(([x, y]) => new THREE.Vector2(x, y)));
    const ex = new THREE.ExtrudeGeometry(shape, { depth: 1.7, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 2 });
    ex.translate(0, 0, -0.85);
    B.geo(ex, new THREE.Matrix4(), C('#d03030'));
    const tire = new THREE.CylinderGeometry(0.31, 0.31, 0.24, 20); tire.rotateX(Math.PI / 2);
    B.geo(tire, new THREE.Matrix4().makeTranslation(1.3, 0.31, 0.8), C('#1c1c1e'));
    B.geo(new THREE.SphereGeometry(0.22, 24, 10, 0, Math.PI * 2, 0, 1.05), new THREE.Matrix4(), C('#110f12'));
    B.geo(new THREE.SphereGeometry(0.2, 24, 6, Math.PI - 1.2, 2.4, 0.85, 0.42), NEW.mat4(0, 1.6, 0));
    const cap = new THREE.CapsuleGeometry(0.068, 0.15, 4, 10); cap.rotateZ(Math.PI / 2); cap.scale(1, 0.74, 1.08);
    B.geo(cap, NEW.mat4(0.1, 0.05, 0.2, 0, 0.3, 0), C('#f4f4f4'));
  },
  'geo, bare': (B) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 2, 1, 0, 1, 2, 0]), 3));
    B.geo(g, NEW.mat4(0, 0, 0, 0.3, 0.2, 0.1));
  },
};
// thousands of mixed primitives, so the typed storage grows many times over
programs['mixed, 6000'] = (B) => {
  const r = rng(7), shared = [new THREE.BoxGeometry(1, 1, 1), new THREE.CylinderGeometry(0.3, 0.3, 2, 6), new THREE.SphereGeometry(0.5, 6, 4)];
  for (let i = 0; i < 6000; i++) {
    const k = r(), x = r() * 300, z = r() * 300, y = r() * 20, col = new THREE.Color(r(), r(), r());
    if (k < 0.5) B.box(x, y, z, x + 1 + r() * 9, y + 1 + r() * 30, z + 1 + r() * 9, col, r() < 0.5 ? { uv: 'world', us: 3 + r(), vs: 3, uOff: r(), vOff: r() } : {});
    else if (k < 0.7) B.quad([x, y, z], [x, y, z + 1], [x + 1, y, z + 1], [x + 1, y, z], undefined, col);
    else if (k < 0.8) B.tri([x, y, z], [x + 1, y + 1, z], [x, y + 1, z + 1], undefined, col);
    else B.geo(shared[i % 3], NEW.mat4(x, y, z, r(), r() * 6, r(), 0.5 + r()), col);
  }
};

section('Builder: old vs new with setMatrix null');
if (!OLD) note('no baseline (pass a baseline dir or set KC_BASELINE) - skipped the old/new comparisons');
else {
  for (const [name, prog] of Object.entries(programs)) {
    const a = new OLD.Builder(), b = new NEW.Builder();
    prog(a); prog(b);
    check(`${name}: empty flag`, a.empty === b.empty);
    const why = sameGeo(a.build(), b.build());
    check(`${name}: identical output`, !why, why);
  }
  // the same through mesh(), with its flags
  const a = new OLD.Builder(), b = new NEW.Builder();
  programs['axis box'](a); programs['axis box'](b);
  const ma = a.mesh(new THREE.MeshBasicMaterial(), { cast: true }), mb = b.mesh(new THREE.MeshBasicMaterial(), { cast: true });
  check('mesh(): same flags and geometry', ma.castShadow === mb.castShadow && ma.receiveShadow === mb.receiveShadow && ma.matrixAutoUpdate === mb.matrixAutoUpdate && !sameGeo(ma.geometry, mb.geometry));
  check('empty builder', new OLD.Builder().empty === true && new NEW.Builder().empty === true);
}

section('Builder: setMatrix');
{
  const M = NEW.mat4(12.5, 3, -7.25, 0.2, 1.1, -0.15);
  const plain = new NEW.Builder(), placed = new NEW.Builder();
  programs['axis box, world uv'](plain); programs['quad and tri'](plain);
  placed.setMatrix(M); programs['axis box, world uv'](placed); programs['quad and tri'](placed);
  const g0 = plain.build(), g1 = placed.build(), nm = new THREE.Matrix3().getNormalMatrix(M);
  let dp = 0, dn = 0;
  const v = new THREE.Vector3(), w = new THREE.Vector3();
  for (let i = 0; i < g0.attributes.position.count; i++) {
    v.fromBufferAttribute(g0.attributes.position, i).applyMatrix4(M); w.fromBufferAttribute(g1.attributes.position, i);
    dp = Math.max(dp, v.distanceTo(w));
    v.fromBufferAttribute(g0.attributes.normal, i).applyMatrix3(nm).normalize(); w.fromBufferAttribute(g1.attributes.normal, i);
    dn = Math.max(dn, v.distanceTo(w));
  }
  check('positions go through the matrix', dp < 1e-4, `max error ${dp}`);
  check('normals go through its normal matrix', dn < 1e-5, `max error ${dn}`);
  check('texture coordinates are worked out before it', sameArr(g0.attributes.uv.array, g1.attributes.uv.array));
  check('colours unchanged', sameArr(g0.attributes.color.array, g1.attributes.color.array));
  check('placed faces still face out', windingAgrees(g1) === 0);

  const id = new NEW.Builder().setMatrix(new THREE.Matrix4());
  programs['mixed, 6000'](id);
  const ref = new NEW.Builder();
  programs['mixed, 6000'](ref);
  const gi = id.build(), gr = ref.build();
  check('identity matrix changes nothing', ATTRS.every(k => maxDiff(gi.attributes[k].array, gr.attributes[k].array) < 1e-6));

  const back = new NEW.Builder();
  back.setMatrix(M); back.box(0, 0, 0, 1, 1, 1); back.setMatrix(null); programs['axis box'](back);
  const only = new NEW.Builder(); only.setMatrix(M); only.box(0, 0, 0, 1, 1, 1); only.setMatrix(null);
  const gb = back.build(), n0 = only.build().attributes.position.count;
  const tail = new NEW.Builder(); programs['axis box'](tail);
  check('setMatrix(null) puts things back as given', sameArr(gb.attributes.position.array.slice(n0 * 3), tail.build().attributes.position.array));

  // geo() under setMatrix = geo() with the two matrices composed
  const gm = NEW.mat4(1, 2, 3, 0.3, 0.4, 0.5, 1.3), cyl = new THREE.CylinderGeometry(0.4, 0.6, 2, 7);
  const ga = new NEW.Builder(); ga.setMatrix(M); ga.geo(cyl, gm);
  const gc = new NEW.Builder(); gc.geo(cyl, new THREE.Matrix4().multiplyMatrices(M, gm));
  const pa = ga.build().attributes.position.array, pc = gc.build().attributes.position.array;
  let de = 0;
  for (let i = 0; i < pa.length; i++) de = Math.max(de, Math.abs(pa[i] - pc[i]));
  check('geo() under setMatrix applies its own matrix first', de < 1e-4, `max error ${de}`);

  // a mirroring matrix turns the triangles round so the faces stay outward
  const mir = new NEW.Builder();
  mir.setMatrix(new THREE.Matrix4().makeScale(-1, 1, 1).setPosition(5, 0, 0));
  mir.box(0, 0, 0, 2, 3, 4); mir.geo(new THREE.BoxGeometry(1, 1, 1), NEW.mat4(0, 5, 0));
  mir.ribbon({ n: 3, x: [0, 5, 10], z: [0, 0, 0] }, [[-2, 0], [2, 0]]);
  check('mirrored: faces still outward', windingAgrees(mir.build()) === 0);
  check('mirrored, indexed: faces still outward', windingAgrees(mir.build({ indexed: true })) === 0);

  // the spec §1 local frame: front-centre local (20, 40) lands on F, local +z (the door side) faces heading a
  const frame = (Fx, Fz, a) => {
    const s = Math.sin(a), c = Math.cos(a);
    return new THREE.Matrix4().set(s, 0, c, Fx - 20 * s - 40 * c, 0, 1, 0, 0, -c, 0, s, Fz + 20 * c - 40 * s, 0, 0, 0, 1);
  };
  for (const a of [Math.PI / 2, 0, 1.1, -2.4]) {
    const fb = new NEW.Builder().setMatrix(frame(500, 300, a));
    fb.quad([10, 0, 40], [30, 0, 40], [30, 4, 40], [10, 4, 40]);   // the front wall, facing local +z
    const g = fb.build(), p = new THREE.Vector3(), n = new THREE.Vector3().fromBufferAttribute(g.attributes.normal, 0);
    // corners 0 and 2 of the quad are opposite: their midpoint is the front-centre, 2 m up
    const mid = new THREE.Vector3().fromBufferAttribute(g.attributes.position, 0).add(p.fromBufferAttribute(g.attributes.position, 2)).multiplyScalar(0.5);
    check(`local frame a=${a.toFixed(2)}: front-centre at F`, Math.abs(mid.x - 500) < 1e-4 && Math.abs(mid.z - 300) < 1e-4, `${mid.x},${mid.z}`);
    check(`local frame a=${a.toFixed(2)}: the door side faces heading a`, Math.abs(n.x - Math.cos(a)) < 1e-5 && Math.abs(n.z - Math.sin(a)) < 1e-5, `${n.x},${n.z}`);
  }
  const south = new NEW.Builder().setMatrix(frame(100, 200, Math.PI / 2)); south.box(2, 0, 3, 38, 9, 37);
  const flat = new NEW.Builder(); flat.box(2, 0, 3, 38, 9, 37);
  const gs = south.build(), gf = flat.build();
  let off = 0;
  for (let i = 0; i < gs.attributes.position.count; i++) {
    off = Math.max(off, Math.abs(gs.attributes.position.getX(i) - gf.attributes.position.getX(i) - 80), Math.abs(gs.attributes.position.getZ(i) - gf.attributes.position.getZ(i) - 160));
  }
  check('local frame a=π/2 is today\'s south-facing layout (a plain shift)', off < 1e-4 && sameArr(gs.attributes.uv.array, gf.attributes.uv.array));
}

section('Builder: ribbon');
{
  const straight = { n: 6, x: [0, 2, 4, 6, 8, 10], z: [5, 5, 5, 5, 5, 5], s: [0, 2, 4, 6, 8, 10], tx: [1, 1, 1, 1, 1, 1], tz: [0, 0, 0, 0, 0, 0] };
  const B = new NEW.Builder();
  B.ribbon(straight, [[-3, 0], [3, 0]], { y: 1 });
  const g = B.build({ indexed: true });
  check('flat strip: 2 vertices a frame, 2 triangles a step', g.attributes.position.count === 12 && g.index.count === 30);
  const P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
  check('flat strip: left edge at -3 m (north), right at +3 m (south), at the path height', P.getZ(0) === 2 && P.getZ(1) === 8 && P.getY(0) === 1 && P.getX(10) === 10);
  check('flat strip: normals up', [...Array(12).keys()].every(i => Math.abs(N.getY(i) - 1) < 1e-6));
  check('flat strip: u across (0 to 6 m), v = s / 4', U.getX(0) === 0 && U.getX(1) === 6 && U.getY(10) === 2.5);
  check('flat strip: triangles face up', windingAgrees(g) === 0);
  check('indexed and spelled-out builds agree', (() => { const e = expand(g), f = B.build(); return ATTRS.every(k => sameArr(e[k], f.attributes[k].array)); })());

  // a road with curbs: the curb faces look at the road
  const road = new NEW.Builder();
  road.ribbon(straight, [[-6, 0.16], [-4, 0.16], [-4, 0], [4, 0], [4, 0.16], [6, 0.16]], { y: 0, vScale: 2 });
  const gr = road.build({ indexed: true }), nr = gr.attributes.normal;
  // strips in order: left walk, left curb face, asphalt, right curb face, right walk (12 vertices each)
  check('curb: left face looks south at the road', Math.abs(nr.getZ(12) - 1) < 1e-6 && Math.abs(nr.getY(12)) < 1e-6);
  check('curb: right face looks north at the road', Math.abs(nr.getZ(36) + 1) < 1e-6);
  check('curb: walks and asphalt face up', [0, 24, 48].every(i => Math.abs(nr.getY(i) - 1) < 1e-6));
  check('curb: u runs on across the profile', Math.abs(gr.attributes.uv.getX(49) - 12.32) < 1e-5);
  check('curb: all faces outward', windingAgrees(gr) === 0);

  // bank: positive lowers the right side, the same shear terrain.js carves (y = path - offset * tan(bank))
  const bank = new NEW.Builder();
  bank.ribbon(straight, [[-3, 0], [3, 0]], { y: 2, bank: 0.05 });
  const gb = bank.build({ indexed: true }).attributes.position, t05 = 3 * Math.tan(0.05);
  check('bank: right edge 3 tan(b) lower, left 3 tan(b) higher', Math.abs(gb.getY(1) - (2 - t05)) < 1e-6 && Math.abs(gb.getY(0) - (2 + t05)) < 1e-6);
  const bn = bank.build({ indexed: true }).attributes.normal;
  check('bank: the surface leans to the right', bn.getZ(0) > 0.04 && bn.getY(0) > 0.99);
  // a steep bank, where tan and the angle part: 10 m out at 0.35 rad (20 degrees) is 3.65 m, not 3.50
  const steep = new NEW.Builder();
  steep.ribbon(straight, [[-10, 0], [10, 0]], { y: 0, bank: 0.35 });
  const gs = steep.build({ indexed: true }).attributes.position;
  check('bank: a steep bank shears by tan(bank), as terrain.js carves', Math.abs(gs.getY(1) + 10 * Math.tan(0.35)) < 1e-5 && Math.abs(gs.getY(0) - 10 * Math.tan(0.35)) < 1e-5, `${gs.getY(1)}`);

  // grade: a climbing path tilts its normals back
  const climb = new NEW.Builder();
  climb.ribbon(straight, [[-3, 0], [3, 0]], { y: (i) => straight.s[i] * 0.1 });
  const gn = climb.build({ indexed: true }).attributes.normal;
  check('grade: normals tilt back on a 10% climb', Math.abs(gn.getX(4) + 0.0995) < 1e-3);

  // a sampled curve, in the shape spline.sampleCurve returns
  const curve = sampleCurve([[0, 0], [60, 10], [100, 60], [110, 130]], { step: 2 });
  const cb = new NEW.Builder();
  cb.ribbon(curve, [[-5, 0], [-3.5, 0.16], [3.5, 0.16], [5, 0]], { y: 3 });
  const gc = cb.build({ indexed: true });
  const finite = gc.attributes.position.array.every(Number.isFinite) && gc.attributes.normal.array.every(Number.isFinite);
  check('curve: vertex and index counts', gc.attributes.position.count === 3 * curve.n * 2 && gc.index.count === 3 * (curve.n - 1) * 6);
  check('curve: no NaNs, faces outward', finite && windingAgrees(gc) === 0);
  // edge left 5 m from the path, measured on the ground plane
  let dl = 0;
  for (let i = 0; i < curve.n; i++) {
    const px = gc.attributes.position.getX(i * 2), pz = gc.attributes.position.getZ(i * 2);
    dl = Math.max(dl, Math.abs(Math.hypot(px - curve.x[i], pz - curve.z[i]) - 5));
  }
  check('curve: offsets measured along the right-hand normal', dl < 1e-4, `${dl}`);

  // a RoadNet edge (sim px, heights gy) gives the same ribbon as the curve in metres
  const PX = 16, edge = {
    n: curve.n, x: Float32Array.from(curve.x, v => v * PX), y: Float32Array.from(curve.z, v => v * PX), s: Float32Array.from(curve.s, v => v * PX),
    tx: curve.tx, ty: curve.tz, gy: new Float32Array(curve.n).fill(3),
  };
  const eb = new NEW.Builder();
  eb.ribbon(edge, [[-5, 0], [-3.5, 0.16], [3.5, 0.16], [5, 0]]);
  const ge = eb.build({ indexed: true });
  let de = 0;
  for (let i = 0; i < ge.attributes.position.array.length; i++) de = Math.max(de, Math.abs(ge.attributes.position.array[i] - gc.attributes.position.array[i]));
  check('RoadNet edge: px scaled to metres, heights from gy', de < 1e-3, `${de}`);

  // an array of frames with no tangents or s: both worked out from the points
  const pts = [{ x: 0, z: 0, y: 0 }, { x: 0, z: 4, y: 0 }, { x: 0, z: 8, y: 0 }];
  const ab = new NEW.Builder();
  ab.ribbon(pts, [[-1, 0], [1, 0]]);
  const ga = ab.build({ indexed: true });
  check('frame array: heading south, the right-hand side is west', ga.attributes.position.getX(1) === -1 && ga.attributes.position.getX(0) === 1 && Math.abs(ga.attributes.uv.getY(4) - 2) < 1e-6);
  check('frame array: faces up', windingAgrees(ga) === 0 && Math.abs(ga.attributes.normal.getY(0) - 1) < 1e-6);

  // verges snapped to the ground: the outer points follow ground(x, z) + g, the rest the path
  const ground = (x, z) => 0.5 + 0.1 * z;
  const vb = new NEW.Builder();
  vb.ribbon(straight, [{ o: -7, g: 0.03 }, [-4, 0], [4, 0], { o: 7, g: 0.03 }], { y: 1, ground });
  const gv = vb.build({ indexed: true }), pv = gv.attributes.position;
  // strips: left verge (vertices 0-11), asphalt (12-23), right verge (24-35)
  check('verge: outer points on the ground + 0.03', Math.abs(pv.getY(0) - (0.5 + 0.1 * -2 + 0.03)) < 1e-6 && Math.abs(pv.getY(25) - (0.5 + 0.1 * 12 + 0.03)) < 1e-6);
  check('verge: inner points on the path', Math.abs(pv.getY(1) - 1) < 1e-6 && Math.abs(pv.getY(24) - 1) < 1e-6);
  check('verge: faces outward, normals follow the slope', windingAgrees(gv) === 0 && gv.attributes.normal.getZ(0) < -0.05 && gv.attributes.normal.getZ(24) < -0.05);
  const wall = new NEW.Builder();
  wall.ribbon(straight, [[-4, 0], [4, 0], { o: 4, g: 0 }], { y: 3, ground: () => 6 });
  const gw0 = wall.build({ indexed: true });
  check('cut wall: the road edge up to higher ground makes a face looking at the road', gw0.attributes.position.count === 24 && Math.abs(gw0.attributes.normal.getZ(12) + 1) < 1e-6 && windingAgrees(gw0) === 0);
  const fill = new NEW.Builder();
  fill.ribbon(straight, [[-4, 0], [4, 0], { o: 4, g: 0 }], { y: 3, ground: () => 0 });
  check('fill wall: down to lower ground it looks away from the road', Math.abs(fill.build({ indexed: true }).attributes.normal.getZ(12) - 1) < 1e-6);

  // from / to and world uvs
  const rb = new NEW.Builder();
  rb.ribbon(straight, [[-3, 0], [3, 0]], { from: 2, to: 4, world: 4 });
  const gw = rb.build({ indexed: true });
  check('from/to: frames 2 to 4 only', gw.attributes.position.count === 6 && gw.attributes.position.getX(0) === 4 && gw.attributes.position.getX(5) === 8);
  check('world uv: u = x / 4, v = -z / 4', gw.attributes.uv.getX(0) === 1 && gw.attributes.uv.getY(1) === -2);

  // colours per profile point, and a placed ribbon keeps its texture coordinates
  const pb = new NEW.Builder();
  pb.setMatrix(NEW.mat4(100, 0, 50, 0, 0.8, 0));
  pb.ribbon(straight, [{ o: -3, y: 0, u: 0, c: [1, 0, 0] }, { o: 3, y: 0, u: 1, c: new THREE.Color(0, 0, 1) }]);
  const gp = pb.build({ indexed: true });
  check('profile colours', gp.attributes.color.getX(0) === 1 && gp.attributes.color.getZ(1) === 1 && gp.attributes.uv.getX(1) === 1);
  check('placed ribbon keeps its v', Math.abs(gp.attributes.uv.getY(10) - 2.5) < 1e-6 && gp.attributes.position.getX(0) > 90);
}

section('Builder: build({ indexed })');
{
  const B = new NEW.Builder();
  programs['mixed, 6000'](B);
  const gi = B.build({ indexed: true }), gn = B.build();
  const e = expand(gi);
  check('indexed build spells out to the plain one', ATTRS.every(k => sameArr(e[k], gn.attributes[k].array)));
  check('indexed build has fewer vertices', gi.attributes.position.count < gn.attributes.position.count, `${gi.attributes.position.count} vs ${gn.attributes.position.count}`);
  check('a big build gets a 32-bit index', gi.index.array instanceof Uint32Array === gi.attributes.position.count > 65536);
  const small = new NEW.Builder(); small.box(0, 0, 0, 1, 1, 1);
  check('a small build gets a 16-bit index', small.build({ indexed: true }).index.array instanceof Uint16Array);
  const re = new NEW.Builder(); programs['axis box'](re); re.clear(); programs['quad and tri'](re);
  const fresh = new NEW.Builder(); programs['quad and tri'](fresh);
  check('clear() starts again', !sameGeo(re.build(), fresh.build()));
}

section('Builder: time');
{
  const time = (Bld) => {
    let best = Infinity;
    for (let k = 0; k < 4; k++) { const t0 = performance.now(); const b = new Bld(); programs['mixed, 6000'](b); b.build(); best = Math.min(best, performance.now() - t0); }
    return best;
  };
  const tn = time(NEW.Builder);
  if (OLD) {
    const to = time(OLD.Builder);
    note(`6000 mixed primitives: old ${to.toFixed(1)} ms, new ${tn.toFixed(1)} ms`);
    check('the new Builder is not slower', tn <= to * 1.25, `old ${to.toFixed(1)} ms, new ${tn.toFixed(1)} ms`);
  } else note(`6000 mixed primitives: ${tn.toFixed(1)} ms`);
}

done();
