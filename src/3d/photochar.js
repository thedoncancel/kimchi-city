import * as THREE from 'three';

// Builds a skinned, animatable 3D character from the measurements and texture atlas that
// tools/build_char.py makes out of T-pose pictures. The body is sculpted as smooth tubes whose
// cross-sections are ellipses: width from the front picture, depth from the side picture. Each
// patch of the surface is painted with whichever picture faces it most directly (front, back or side).
// The rest pose is the T-pose, so a bone rotation of zero means arms straight out.

// max: the texture's largest side on the GPU. The pictures are 2048 px; a 2048 texture costs ~22 MB of
// graphics memory, so background people are scaled down (the UVs are relative, so nothing else changes)
export async function loadPhotoChar(name, dir = 'assets/chars', max = 2048) {
  const base = `${dir}/${name}`;
  const [data, img] = await Promise.all([
    fetch(`${base}.json`).then(r => { if (!r.ok) throw new Error(`${base}.json: ${r.status}`); return r.json(); }),
    fetch(`${base}.webp`).then(r => { if (!r.ok) throw new Error(`${base}.webp: ${r.status}`); return r.blob(); }).then(b => createImageBitmap(b, { imageOrientation: 'flipY' })),
  ]);
  let src = img;
  if (Math.max(img.width, img.height) > max) {
    const k = max / Math.max(img.width, img.height);
    src = await createImageBitmap(img, { resizeWidth: Math.round(img.width * k), resizeHeight: Math.round(img.height * k), resizeQuality: 'high' });
    img.close();
  }
  const tex = new THREE.Texture(src);
  tex.flipY = false;
  tex.needsUpdate = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { data, tex };
}

const lerp = (a, b, t) => a + (b - a) * t;

// piecewise-linear blend along a chain of [bone, position] stops (positions ascending)
function chain(v, stops) {
  if (v <= stops[0][1]) return [stops[0][0], 1, stops[0][0], 0];
  for (let i = 0; i < stops.length - 1; i++) {
    const [b0, p0] = stops[i], [b1, p1] = stops[i + 1];
    if (v <= p1) {
      const t = p1 > p0 ? (v - p0) / (p1 - p0) : 1;
      return [b0, 1 - t, b1, t];
    }
  }
  const last = stops[stops.length - 1][0];
  return [last, 1, last, 0];
}

const BONES = ['hips', 'spine', 'chest', 'neck', 'head',
  'armR', 'foreR', 'handR', 'armL', 'foreL', 'handL',
  'legR', 'shinR', 'footR', 'legL', 'shinL', 'footL'];
const B = Object.fromEntries(BONES.map((n, i) => [n, i]));

export function makePhotoChar({ data, tex }, { height = 1.7, detail = 1 } = {}) {
  const K = data.keys, rows = data.rows, V = data.views;
  const AW = data.atlas.w, AH = data.atlas.h;
  const hasSide = !!V.side, hasBack = !!V.back;
  const segs = Math.max(10, Math.round(28 * detail)), legSegs = Math.max(8, Math.round(20 * detail));
  const armSegs = Math.max(8, Math.round(16 * detail));
  const rowStep = detail >= 1 ? 1 : detail >= 0.5 ? 2 : 3;
  const rowAt = (y) => rows[Math.max(0, Math.min(rows.length - 1, Math.round(y * (rows.length - 1))))];
  const ramp = (v, a, b) => Math.min(1, Math.max(0, (v - a) / (b - a)));

  // depth (front/back x) per row; the side picture's arms are blended out across the arm band,
  // and the head is smoothed so hanging hair at the back doesn't kink the face
  const bandLo = K.armBot - 0.015, bandHi = K.armTop + 0.03;
  const dBelow = (rowAt(K.armBot - 0.035).d) || [0.06, -0.06], dAbove = (rowAt(K.armTop + 0.035).d) || dBelow;
  const rowIndex = (y) => Math.max(0, Math.min(rows.length - 1, Math.round(y * (rows.length - 1))));
  let dF = rows.map(r => (r.d ? r.d[0] : null)), dB = rows.map(r => (r.d ? r.d[1] : null));
  rows.forEach((r, i) => {
    if (r.y >= bandLo && r.y <= bandHi) {
      const t = (r.y - bandLo) / (bandHi - bandLo);
      dF[i] = lerp(dBelow[0], dAbove[0], t); dB[i] = lerp(dBelow[1], dAbove[1], t);
    }
  });
  const smooth = (arr, from, win) => arr.map((v, i) => {
    if (i < from || v == null) return v;
    let s = 0, n = 0;
    for (let k = -win; k <= win; k++) { const w = arr[i + k]; if (w != null && i + k >= from) { s += w; n++; } }
    return n ? s / n : v;
  });
  const headFrom = rowIndex(K.neck - 0.02);
  dF = smooth(dF, headFrom, 5);
  dB = smooth(dB, headFrom, 9);
  function depthAt(row, width) {
    const i = rowIndex(row.y);
    if (dF[i] == null) return [width * 0.3, -width * 0.3];
    let back = dB[i];
    // around the jaw the side outline also contains hair hanging at the back; keep the jaw itself
    // compact, fading the limit out above so the face has no visible step
    if (row.y > K.neck - 0.01) {
      const w = 1 - ramp(row.y, K.neck + 0.035, K.neck + 0.08);
      back = lerp(back, Math.max(back, dF[i] - width * 1.25), w);
    }
    return [dF[i], back];
  }

  // ---------- rings ----------
  const parts = [];   // { rings: [{pts, nrm?, axis}], kind: 'v'|'arm', weights(axisValue) }

  function vRing(y, z0, z1, x0, x1, n) {
    const zc = (z0 + z1) / 2, b = Math.max(0.0005, (z1 - z0) / 2);
    const xc = (x0 + x1) / 2, a = Math.max(0.0005, (x0 - x1) / 2);
    const pts = [];
    for (let j = 0; j <= n; j++) {
      const t = (j / n) * Math.PI * 2;
      pts.push(new THREE.Vector3(xc + a * Math.cos(t), y, zc + b * Math.sin(t)));
    }
    return { pts, center: new THREE.Vector3(xc, y, zc), axis: y, zMin: zc - b, zMax: zc + b, xF: xc + a, xB: xc - a };
  }

  // body: pelvis up to the top of the head. Across the arm band the torso width blends from the
  // chest below the sleeves to the shoulders above, so there is no ledge where the arms attach.
  const body = [];
  const bodyRows = rows.filter(r => r.c && r.y >= K.crotch - 0.03);
  const blendLo = K.armBot - 0.045, blendHi = K.armTop + 0.012;
  const cLo = rowAt(blendLo).c, cHi = rowAt(blendHi).c;
  // In the T-pose the tops of the sleeves read as part of the shoulders; once the arms come down they
  // would stick out like pads, so the shoulders are kept close to the chest width.
  const chestHalf = cLo ? (cLo[1] - cLo[0]) / 2 : 0.1, chestMid = cLo ? (cLo[0] + cLo[1]) / 2 : 0;
  const shoulderHalf = chestHalf * 1.1;
  bodyRows.forEach((r, i) => {
    if (i % rowStep && i !== bodyRows.length - 1) return;
    let [z0, z1] = r.c;
    if (cLo && cHi && r.y > blendLo && r.y < blendHi) {
      const t = (r.y - blendLo) / (blendHi - blendLo);
      z0 = lerp(cLo[0], cHi[0], t); z1 = lerp(cLo[1], cHi[1], t);
    }
    if (r.y > blendLo && r.y < K.neck) {
      // sloped shoulders: full width at the armpits, easing in toward the neck like a trapezius
      const neckHalf = (() => { const nc = rowAt(K.neck).c; return nc ? (nc[1] - nc[0]) / 2 : chestHalf * 0.35; })();
      const t = ramp(r.y, K.armTop - 0.02, K.neck);
      const half = lerp(shoulderHalf, neckHalf * 1.15, t * t);
      z0 = Math.max(z0, chestMid - half);
      z1 = Math.min(z1, chestMid + half);
    }
    const d = depthAt(r, z1 - z0);
    body.push(vRing(r.y, z0, z1, d[0], d[1], segs));
  });
  const topRow = bodyRows[bodyRows.length - 1];
  body.push(vRing(Math.min(1, topRow.y + 0.004), (topRow.c[0] + topRow.c[1]) / 2, (topRow.c[0] + topRow.c[1]) / 2, 0.001, -0.001, segs));
  const first = body[0];
  body.unshift(vRing(first.axis - 0.012, first.center.z, first.center.z, first.center.x + 0.001, first.center.x - 0.001, segs));
  parts.push({ rings: body, kind: 'v', bone: 'body' });

  // legs: from inside the pelvis down to the soles
  for (const side of ['r', 'l']) {
    const lr = rows.filter(r => r[side]).sort((a, b) => b.y - a.y);   // top to bottom
    const ringsDown = [];
    lr.forEach((r, i) => {
      if (i % rowStep && i !== lr.length - 1) return;
      const [z0, z1] = r[side], d = depthAt(r, z1 - z0);
      ringsDown.push(vRing(r.y, z0, z1, d[0], d[1], legSegs));
    });
    const top = ringsDown[0];
    const zc = top.center.z, half = (top.pts[Math.round(legSegs / 4)].z - zc);
    ringsDown.unshift(vRing(top.axis + 0.035, zc - Math.abs(half), zc + Math.abs(half),
      top.center.x + (top.pts[0].x - top.center.x), top.center.x - (top.pts[0].x - top.center.x), legSegs));
    const bot = ringsDown[ringsDown.length - 1];
    ringsDown.push(vRing(Math.max(0, bot.axis - 0.002), bot.center.z, bot.center.z, bot.center.x + 0.001, bot.center.x - 0.001, legSegs));
    parts.push({ rings: ringsDown.reverse(), kind: 'v', bone: side === 'r' ? 'legR' : 'legL', side });
  }

  // arms: from inside the shoulder out to the fingertips, along z
  const armX = (() => { const d = depthAt(rowAt(K.armBot - 0.02), 0.2); return (d[0] + d[1]) / 2; })();
  const armInfo = {};
  for (const side of ['R', 'L']) {
    const pts = data.arms[side];
    const sgn = side === 'R' ? 1 : -1;
    const shoulder = side === 'R' ? K.shoulderR : K.shoulderL;
    const tip = pts[pts.length - 1][0];
    const len = Math.abs(tip - shoulder);
    const rings = [];
    const mk = (z, yTop, yBot, kDepth) => {
      const yc = (yTop + yBot) / 2, b = Math.max(0.0005, (yTop - yBot) / 2), a = b * kDepth;
      const ring = [];
      for (let j = 0; j <= armSegs; j++) {
        const t = (j / armSegs) * Math.PI * 2;
        ring.push(new THREE.Vector3(armX + a * Math.cos(t), yc + b * Math.sin(t), z));
      }
      return { pts: ring, center: new THREE.Vector3(armX, yc, z), axis: Math.abs(z), yTop: yc + b, yBot: yc - b };
    };
    const p0 = pts[0];
    rings.push(mk(shoulder * 0.8, p0[1], p0[2], 1));
    const armStep = detail >= 1 ? 2 : detail >= 0.5 ? 3 : 4;
    pts.forEach((p, i) => {
      if (i % armStep && i !== pts.length - 1) return;
      const s = Math.abs(p[0] - shoulder) / len;
      const kDepth = s > 0.82 ? 1.9 : s > 0.74 ? lerp(1, 1.9, (s - 0.74) / 0.08) : 1;
      rings.push(mk(p[0], p[1], p[2], kDepth));
    });
    const last = pts[pts.length - 1];
    rings.push(mk(last[0] + sgn * 0.003, (last[1] + last[2]) / 2 + 0.0005, (last[1] + last[2]) / 2 - 0.0005, 1));
    const yAt = (frac) => { const p = pts[Math.min(pts.length - 1, Math.round(frac * (pts.length - 1)))]; return (p[1] + p[2]) / 2; };
    armInfo[side] = { shoulder, len, sgn, elbow: Math.abs(shoulder) + len * 0.4, wrist: Math.abs(shoulder) + len * 0.76,
      yShoulder: yAt(0), yElbow: yAt(0.4), yWrist: yAt(0.76) };
    parts.push({ rings, kind: 'arm', side });
  }

  // ---------- skeleton (model units, rest = T-pose) ----------
  const knee = Math.min(K.crotch - 0.08, 0.27), ankle = 0.055;
  const legCenter = (side, y) => { const r = rowAt(y)[side]; return r ? (r[0] + r[1]) / 2 : (side === 'r' ? 0.06 : -0.06); };
  const world = {
    hips: [0, K.crotch + 0.035, 0], spine: [0, K.crotch + 0.13, 0], chest: [0, K.armBot - 0.04, 0],
    neck: [0, K.neck - 0.015, 0], head: [0, K.neck + 0.035, 0],
  };
  for (const s of ['R', 'L']) {
    const A = armInfo[s];
    world['arm' + s] = [armX, A.yShoulder, A.shoulder];
    world['fore' + s] = [armX, A.yElbow, A.sgn * A.elbow];
    world['hand' + s] = [armX, A.yWrist, A.sgn * A.wrist];
    const ls = s.toLowerCase();
    world['leg' + s] = [0, K.crotch, legCenter(ls, K.crotch - 0.05)];
    world['shin' + s] = [0, knee, legCenter(ls, knee)];
    world['foot' + s] = [0, ankle, legCenter(ls, ankle)];
  }
  const parent = { spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck', armR: 'chest', foreR: 'armR', handR: 'foreR',
    armL: 'chest', foreL: 'armL', handL: 'foreL', legR: 'hips', shinR: 'legR', footR: 'shinR', legL: 'hips', shinL: 'legL', footL: 'shinL' };
  const bones = BONES.map(n => { const b = new THREE.Bone(); b.name = n; return b; });
  BONES.forEach((n, i) => {
    const w = world[n], p = parent[n];
    if (p) {
      const pw = world[p];
      bones[i].position.set(w[0] - pw[0], w[1] - pw[1], w[2] - pw[2]);
      bones[B[p]].add(bones[i]);
    } else bones[i].position.set(w[0], w[1], w[2]);
  });
  for (const s of ['R', 'L']) bones[B['arm' + s]].rotation.order = 'ZYX';

  // skin weights for a vertex
  const bodyStops = [[B.hips, K.crotch + 0.02], [B.hips, K.crotch + 0.05], [B.spine, K.crotch + 0.15], [B.chest, K.armBot - 0.03],
    [B.chest, K.neck - 0.03], [B.neck, K.neck - 0.005], [B.head, K.neck + 0.04]];
  const legStops = (s) => [[B.hips, -(K.crotch + 0.03)], [B['leg' + s], -(K.crotch - 0.045)], [B['leg' + s], -(knee + 0.035)],
    [B['shin' + s], -(knee - 0.035)], [B['shin' + s], -(ankle + 0.03)], [B['foot' + s], -(ankle - 0.015)]];
  const armStops = (s) => {
    const A = armInfo[s], sh = Math.abs(A.shoulder);
    return [[B.chest, sh - 0.012], [B['arm' + s], sh + 0.03], [B['arm' + s], A.elbow - 0.03], [B['fore' + s], A.elbow + 0.03],
      [B['fore' + s], A.wrist - 0.02], [B['hand' + s], A.wrist + 0.025]];
  };

  // ---------- surface ----------
  // Every vertex carries two projections: front-or-back (uv) and left-or-right side (uvSide), plus a
  // weight (sideW) that blends them by which way the surface faces. Blending instead of switching
  // means no hard seams where one picture hands over to another.
  const pos = [], nrm = [], uv = [], uvS = [], sideWt = [], si = [], sw = [];
  const smooth01 = (v) => v * v * (3 - 2 * v);
  const view = (name, X, Y, Z) => {
    const v = V[name === 'sideL' || name === 'sideR' ? 'side' : name];
    // the side picture is a straight projection along z, so both sides sample it the same way
    // (seen from the right it simply appears mirrored on screen)
    let px;
    if (name === 'front') px = v.cx - Z * v.ppu;
    else if (name === 'back') px = v.cx + Z * v.ppu;
    else px = v.cx - X * v.ppu;
    const py = v.top + (1 - Y) * v.ppu;
    return [(v.ox + px) / AW, 1 - (v.oy + py) / AH];
  };
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), fN = new THREE.Vector3();

  for (const part of parts) {
    const R = part.rings, n = R[0].pts.length - 1;
    // smooth outward normals over the whole grid
    const N = R.map((ring, i) => ring.pts.map((p, j) => {
      const jp = (j + 1) % n, jm = (j - 1 + n) % n;
      const along = tmpA.copy(R[Math.min(R.length - 1, i + 1)].pts[j]).sub(R[Math.max(0, i - 1)].pts[j]);
      const around = tmpB.copy(ring.pts[jp]).sub(ring.pts[jm]);
      const nn = new THREE.Vector3().crossVectors(around, along);
      if (nn.lengthSq() < 1e-14) nn.copy(p).sub(ring.center);
      if (nn.dot(tmpA.copy(p).sub(ring.center)) < 0) nn.negate();
      if (part.kind === 'v' && (i === 0 || i === R.length - 1)) nn.set(nn.x * 0.3, i === 0 ? -1 : 1, nn.z * 0.3);
      return nn.normalize();
    }));
    const weights = (p) => {
      if (part.kind === 'arm') return chain(Math.abs(p.z), armStops(part.side));
      if (part.side) return chain(-p.y, legStops(part.side.toUpperCase()));
      return chain(p.y, bodyStops);
    };
    // How much the side picture may be used at a height. It is trusted on the legs, the head and
    // the lower torso; around the shoulders it shows the arms, so it fades out there.
    const sideAllow = (y) => {
      if (!hasSide || part.kind === 'arm') return 0;
      if (part.side) return 1;
      return Math.max(ramp(y, K.neck - 0.035, K.neck - 0.012), 1 - ramp(y, bandLo - 0.06, bandLo - 0.025));
    };
    const clamp = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
    for (let i = 0; i < R.length - 1; i++) {
      for (let j = 0; j < n; j++) {
        const quad = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
        fN.set(0, 0, 0);
        for (const [a, b] of quad) fN.add(N[a][b]);
        const fb = fN.x >= 0 || !hasBack ? 'front' : 'back';
        const sd = fN.z < 0 ? 'sideL' : 'sideR';
        // wind counter-clockwise as seen from outside
        const p0 = R[i].pts[j], p1 = R[i + 1].pts[j], p2 = R[i + 1].pts[j + 1];
        const face = tmpA.copy(p1).sub(p0).cross(tmpB.copy(p2).sub(p0));
        const order = face.dot(fN) >= 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
        for (const k of order) {
          const [a, b] = quad[k], ring = R[a], p = ring.pts[b], q = N[a][b];
          pos.push(p.x, p.y, p.z);
          nrm.push(q.x, q.y, q.z);
          // sample a little inside the outline so edge pixels never smear across a surface
          let Y = p.y, Z = p.z, X = p.x;
          if (part.kind === 'arm') {
            const m = Math.min(0.004, (ring.yTop - ring.yBot) * 0.3);
            Y = clamp(Y, ring.yBot + m, ring.yTop - m);
          } else {
            const shoulders = !part.side && ring.axis > bandLo - 0.03 && ring.axis <= K.neck;
            const half = (ring.zMax - ring.zMin) / 2;
            const m = shoulders ? Math.min(0.022, half * 0.5) : Math.min(0.005, half * 0.6);
            Z = clamp(Z, ring.zMin + m, ring.zMax - m);
            const ms = Math.min(0.004, (ring.xF - ring.xB) * 0.3);
            X = clamp(X, ring.xB + ms, ring.xF - ms);
          }
          uv.push(...view(fb, p.x, Y, Z));
          uvS.push(...view(sd, X, p.y, p.z));
          // on the face, only true profile surfaces take the side picture, so its eye doesn't ghost onto the cheek
          const sideness = Math.abs(q.z) / (Math.abs(q.x) + Math.abs(q.z) + 1e-6);
          const faceZone = !part.side && ring.axis > K.neck + 0.01 && ring.axis < K.neck + 0.12;
          sideWt.push(sideAllow(ring.axis) * smooth01(faceZone ? ramp(sideness, 0.46, 0.8) : ramp(sideness, 0.38, 0.7)));
          const w = weights(p);
          si.push(w[0], w[2], 0, 0);
          sw.push(w[1], w[3], 0, 0);
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('uvSide', new THREE.Float32BufferAttribute(uvS, 2));
  geo.setAttribute('sideW', new THREE.Float32BufferAttribute(sideWt, 1));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  geo.computeBoundingSphere();
  geo.boundingSphere.radius *= 1.6;

  return assemble(geo, photoMaterial(tex), bones, world, height, data);
}

// Lambert material that blends the front/back and side projections per pixel. The pictures already
// contain shading, so a little self-light keeps the scene lighting from doubling it.
export function photoMaterial(tex) {
  const mat = new THREE.MeshLambertMaterial({ map: tex, emissive: new THREE.Color('#ffffff'), emissiveMap: tex, emissiveIntensity: 0.22 });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 uvSide;\nattribute float sideW;\nvarying vec2 vUvSide;\nvarying float vSideW;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvUvSide = uvSide;\nvSideW = sideW;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vUvSide;\nvarying float vSideW;')
      .replace('#include <map_fragment>', 'vec4 photoTex = mix(texture2D(map, vMapUv), texture2D(map, vUvSide), vSideW);\ndiffuseColor *= photoTex;')
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance *= photoTex.rgb;');
  };
  mat.customProgramCacheKey = () => 'photo-blend';
  return mat;
}

// a new instance (own skeleton) that shares geometry and material — for crowds of pedestrians
export function clonePhotoChar(rig) {
  return assemble(rig.mesh.geometry, rig.mesh.material, null, rig.world, rig.height, rig.data);
}

function assemble(geo, mat, bones, world, height, data) {
  if (!bones) {
    bones = BONES.map(n => { const b = new THREE.Bone(); b.name = n; return b; });
    const parent = { spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck', armR: 'chest', foreR: 'armR', handR: 'foreR',
      armL: 'chest', foreL: 'armL', handL: 'foreL', legR: 'hips', shinR: 'legR', footR: 'shinR', legL: 'hips', shinL: 'legL', footL: 'shinL' };
    BONES.forEach((n, i) => {
      const w = world[n], p = parent[n];
      if (p) { const pw = world[p]; bones[i].position.set(w[0] - pw[0], w[1] - pw[1], w[2] - pw[2]); bones[B[p]].add(bones[i]); }
      else bones[i].position.set(w[0], w[1], w[2]);
    });
    for (const s of ['R', 'L']) bones[B['arm' + s]].rotation.order = 'ZYX';
  }
  const mesh = new THREE.SkinnedMesh(geo, mat);
  mesh.add(bones[0]);
  mesh.bind(new THREE.Skeleton(bones));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const root = new THREE.Group();
  const scaler = new THREE.Group();
  scaler.scale.setScalar(height);
  scaler.add(mesh);
  root.add(scaler);
  const b = Object.fromEntries(BONES.map((n, i) => [n, bones[i]]));
  return { root, mesh, bones: b, world, height, data, phase: Math.random() * 6, heading: 0, fall: 0, hipsY: world.hips[1], pose: {} };
}

// ---------- shop gear (cap, shades, gold chain) ----------

// Attaches the K-Mart items to the head and chest bones, placed from the character's own measurements.
export function addPhotoGear(rig) {
  const { bones, data, world } = rig;
  const K = data.keys, rows = data.rows;
  const rowAt = (y) => rows[Math.max(0, Math.min(rows.length - 1, Math.round(y * (rows.length - 1))))];
  const eyeY = K.neck + (1 - K.neck) * 0.42;
  const faceX = (rowAt(eyeY).d || [0.065])[0];
  const hair = rowAt(0.94).c || [-0.08, 0.08];
  const hairHalf = (hair[1] - hair[0]) / 2, hairMid = (hair[0] + hair[1]) / 2;
  const at = (bone, x, y, z) => { const w = world[bone]; return [x - w[0], y - w[1], z - w[2]]; };
  const put = (bone, mesh, x, y, z) => { mesh.position.set(...at(bone, x, y, z)); bones[bone].add(mesh); mesh.castShadow = true; return mesh; };

  const red = new THREE.MeshLambertMaterial({ color: '#d6402b' }), redDark = new THREE.MeshLambertMaterial({ color: '#b3311f' });
  const black = new THREE.MeshStandardMaterial({ color: '#0d0d10', metalness: 0.6, roughness: 0.15 });
  const gold = new THREE.MeshStandardMaterial({ color: '#f2c230', metalness: 1, roughness: 0.25 });

  const cap = new THREE.Group();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(hairHalf * 1.1, 24, 10, 0, Math.PI * 2, 0, 1.3), red);
  dome.scale.set(1.08, 0.72, 1);
  dome.castShadow = true;
  const brim = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.006, hairHalf * 1.5), redDark);
  brim.position.set(faceX - 0.005, -0.018, 0);
  brim.rotation.z = -0.18;
  cap.add(dome, brim);
  put('head', cap, -0.006, 0.945, hairMid);

  const shades = new THREE.Group();
  for (const s of [-1, 1]) {
    const lens = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.022, 0.036), black);
    lens.position.set(0, 0, s * 0.031);
    lens.rotation.y = -s * 0.28;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.004, 0.004), black);
    arm.position.set(-0.04, 0.004, s * 0.062);
    shades.add(lens, arm);
  }
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.004, 0.024), black);
  bridge.position.set(0.002, 0.005, 0);
  shades.add(bridge);
  put('head', shades, faceX + 0.004, eyeY, hairMid);

  const chainG = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.052, 0.0045, 6, 28), gold);
  ring.rotation.x = Math.PI / 2;
  chainG.add(ring);
  chainG.rotation.z = -0.85;
  const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.004, 14), gold);
  coin.rotation.z = Math.PI / 2;
  const chainAll = new THREE.Group();
  chainAll.add(chainG);
  coin.position.set(0.05, -0.05, 0);
  chainAll.add(coin);
  put('chest', chainAll, 0.012, K.neck - 0.012, 0);

  // watches on the left wrist: band around the arm, case on top (the back of the wrist faces up in the T-pose)
  const watches = {};
  const steel = new THREE.MeshStandardMaterial({ color: '#d9dce1', metalness: 1, roughness: 0.2 });
  const carbon = new THREE.MeshStandardMaterial({ color: '#1a1a1c', metalness: 0.4, roughness: 0.35 });
  const dialBlue = new THREE.MeshStandardMaterial({ color: '#1d3a6b', metalness: 0.3, roughness: 0.25 });
  const dialBlack = new THREE.MeshStandardMaterial({ color: '#0b0b0d', metalness: 0.3, roughness: 0.25 });
  const wrist = world.handL;
  const makeWatch = (bandMat, caseMat, dialMat, { square = false, rainbow = false, seg = 24 } = {}) => {
    const w = new THREE.Group();
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.0145, 0.0042, 6, seg), bandMat);
    w.add(band);
    const c = square ? new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.007, 0.026), caseMat)
      : new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.007, seg === 8 ? 8 : 20), caseMat);
    c.position.y = 0.018;
    const dial = square ? new THREE.Mesh(new THREE.BoxGeometry(0.017, 0.002, 0.02), dialMat) : new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.002, 20), dialMat);
    dial.position.y = 0.0222;
    w.add(c, dial);
    if (rainbow) {
      const cols = ['#e23b2b', '#f08a2c', '#f2c230', '#3c8d5a', '#3b7dd8', '#8a5cc2'];
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const gem = new THREE.Mesh(new THREE.BoxGeometry(0.0032, 0.0026, 0.0032), new THREE.MeshStandardMaterial({ color: cols[i % 6], metalness: 0.3, roughness: 0.1, emissive: new THREE.Color(cols[i % 6]), emissiveIntensity: 0.25 }));
        gem.position.set(Math.cos(a) * 0.0106, 0.0218, Math.sin(a) * 0.0106);
        w.add(gem);
      }
    }
    w.traverse(o => { o.castShadow = true; });
    w.visible = false;
    put('handL', w, wrist[0], wrist[1], wrist[2] + 0.014);
    return w;
  };
  watches.steel = makeWatch(steel, steel, dialBlack);
  watches.gold = makeWatch(gold, gold, dialBlue, { seg: 8 });
  watches.skeleton = makeWatch(carbon, carbon, steel, { square: true });
  watches.rainbow = makeWatch(steel, steel, dialBlack, { rainbow: true });

  for (const g of [cap, shades, chainAll]) g.visible = false;
  rig.setGear = (eq) => {
    cap.visible = !!eq.cap; shades.visible = !!eq.shades; chainAll.visible = !!eq.chain;
    for (const k in watches) watches[k].visible = eq.watchLook === k;
  };
  return rig;
}

// ---------- animation ----------

const damp = (cur, target, k) => cur + (target - cur) * k;

// speed in m/s; air > 0 while jumping; wave makes the right arm wave
export function animatePhotoRig(r, dt, { speed = 0, run = false, air = 0, t = 0, wave = 0 } = {}) {
  const b = r.bones;
  const moving = speed > 0.35;
  r.phase += dt * (moving ? 2.0 + speed * 0.95 : 0);
  const s = Math.sin(r.phase), c = Math.cos(r.phase);
  const k = 1 - Math.exp(-dt * 14);
  const amp = moving ? Math.min(run ? 0.95 : 0.6, 0.18 + speed * 0.075) : 0;

  let legR = s * amp, legL = -s * amp;
  let shinR = -Math.max(0, c) * amp * (run ? 1.7 : 1.5) - (moving ? 0.05 : 0.02);
  let shinL = -Math.max(0, -c) * amp * (run ? 1.7 : 1.5) - (moving ? 0.05 : 0.02);
  let lower = Math.PI / 2 - 0.16;                         // arms hang by the sides
  let swingR = -s * amp * (run ? 1.1 : 0.75), swingL = s * amp * (run ? 1.1 : 0.75);
  let elbow = run ? 1.35 : moving ? 0.35 : 0.18 + Math.sin(t * 1.3) * 0.02;
  let lean = run ? -0.2 : moving ? -0.05 : 0;
  if (air > 0) { legR = 0.55; legL = 0.15; shinR = -1.1; shinL = -0.7; lower = 0.9; swingR = -0.4; swingL = -0.4; elbow = 0.6; }

  b.legR.rotation.z = damp(b.legR.rotation.z, legR, k);
  b.legL.rotation.z = damp(b.legL.rotation.z, legL, k);
  b.shinR.rotation.z = damp(b.shinR.rotation.z, shinR, k);
  b.shinL.rotation.z = damp(b.shinL.rotation.z, shinL, k);
  b.footR.rotation.z = -(b.legR.rotation.z + b.shinR.rotation.z) * 0.7;
  b.footL.rotation.z = -(b.legL.rotation.z + b.shinL.rotation.z) * 0.7;

  b.armR.rotation.x = damp(b.armR.rotation.x, lower, k);
  b.armL.rotation.x = damp(b.armL.rotation.x, -lower, k);
  b.armR.rotation.z = damp(b.armR.rotation.z, swingR, k);
  b.armL.rotation.z = damp(b.armL.rotation.z, swingL, k);
  b.foreR.rotation.y = damp(b.foreR.rotation.y, elbow, k);
  b.foreL.rotation.y = damp(b.foreL.rotation.y, -elbow, k);
  if (wave > 0) {
    b.armR.rotation.x = damp(b.armR.rotation.x, -0.3, k);
    b.armR.rotation.z = damp(b.armR.rotation.z, 0.2, k);
    b.foreR.rotation.y = 0.9 + Math.sin(t * 12) * 0.35;
  }

  b.spine.rotation.z = damp(b.spine.rotation.z, lean, k);
  b.spine.rotation.y = moving ? -s * 0.1 * amp : damp(b.spine.rotation.y, 0, k);
  b.chest.rotation.x = moving ? 0 : Math.sin(t * 1.7) * 0.012;
  b.head.rotation.y = moving ? s * 0.06 * amp : Math.sin(t * 0.5 + r.phase) * 0.22;
  b.head.rotation.z = damp(b.head.rotation.z, run ? 0.12 : 0, k);
  const bob = moving ? (Math.abs(c) - 0.6) * 0.022 * Math.min(1, speed / 3) : Math.sin(t * 2.2) * 0.002;
  b.hips.position.y = damp(b.hips.position.y, r.hipsY + bob, 0.5);
}
