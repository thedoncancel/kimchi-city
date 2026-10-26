#!/usr/bin/env node
// Stage F3 (world data): the jumps of docs/map-v2-spec.md §5.6 on the real Kimchi Key map, with PHYS.v2 and the
// 3D game's tuning (main3d's CFG), driven by the S6a harness (tools/s6a_lib.mjs). Each jump is taken in the
// middle of its road at 30, 37.5 and 45 m/s, from 70 m before its lip (30 m for the port's container ramp).
//  - every jump: one flight of 0.5-1.5 s in the first 60 m past the lip (the S6a verify);
//  - j_crest, whose placement F3 fixed (STRICT): the flight lands on the carriageway, nothing is hit, and over
//    the next 120 m of Crest Road (the knoll's crest and its bend) the car takes no second hop and stays on
//    the road. After touching down the driver brakes for the bends ahead, as a player would.
// The other jumps' landings are reported, not checked: their roads bend or end right after them (the Port
// Yard's drift loop), and F3 did not move them.
//   node tools/f3_jumps_test.mjs [-v] [jump id]
// Exits 1 if any check fails. With a jump id only that one is run, and -v prints every frame of its flights.
globalThis.KC_WORLD = 'v2';
const L = await import('./s6a_lib.mjs');
const { M, DT } = L;
const game = await L.loadGame();
const { ent, world } = game;
const VERBOSE = process.argv.includes('-v'), ONLY = process.argv.slice(2).find(a => !a.startsWith('-'));
if (world.KIND !== 'v2') { console.log('f3 jumps: world-v2 is not READY, nothing to check'); process.exit(0); }
Object.assign(ent.CFG, L.CFG_3D);
let failed = 0, passed = 0;
const check = (ok, msg) => { if (ok) { passed++; if (VERBOSE) console.log('  ok   ' + msg); } else { failed++; console.log('  FAIL ' + msg); } };
const SPEEDS = [30, 37.5, 45], AHEAD = 120, FIRST = 60;      // m of road after the lip: the run, and where the first flight must start
const STRICT = new Set(['j_crest']);
const G = 9.81, GRIP_G = 2, BEND_SHARE = 0.75;                // the driver takes bends at 75% of the grip cap

// The tightest radius (m) of path P over the `len` m after point j (three points 6 m apart).
function tightestAhead(P, j, len) {
  let r = Infinity;
  for (let k = j; k < P.length && P[k].s - P[j].s < len * M; k++) {
    const a = P.find((q, i) => i <= k && P[k].s - q.s <= 6 * M) || P[k], b = P.slice(k).find(q => q.s - P[k].s >= 6 * M);
    if (!b || a === P[k]) continue;
    const x1 = P[k].x - a.x, y1 = P[k].y - a.y, x2 = b.x - P[k].x, y2 = b.y - P[k].y;
    const turn = Math.abs(Math.atan2(x1 * y2 - y1 * x2, x1 * x2 + y1 * y2));
    if (turn > 1e-4) r = Math.min(r, (Math.hypot(x1, y1) + Math.hypot(x2, y2)) / 2 / M / turn);
  }
  return r;
}

console.log('jumps');
for (const j of world.activities.filter(a => a.type === 'jump' && (!ONLY || a.id === ONLY))) {
  const row = [];
  for (const V of SPEEDS) {
    const strict = STRICT.has(j.id), P = L.roadPath(world.roads, j.x, j.y, j.a, j.container ? 30 : 70, strict ? AHEAD : FIRST, 0);
    const lip = L.trackPath(P, j.x, j.y, 0).j, e = world.roads.edges[world.roads.nearest(j.x, j.y, { maxD: 20 * M }).edge];
    const c = L.soloCar(game, 'bolide', P[0].x, P[0].y, Math.atan2(P[1].y - P[0].y, P[1].x - P[0].x), V * M);
    const flights = [];
    let jj = 0, cur = 0, offRoad = 0, worstOff = 0, hp0 = c.hp, landed = null;
    for (let f = 0; f < 60 * 8; f++) {
      const t = L.trackPath(P, c.x, c.y, jj); jj = t.j;
      if (jj >= P.length - 3 && !(c.air > 0)) break;
      // full speed into the jump; once down, braked to what the bends ahead allow
      const fwd = c.vx * Math.cos(c.a) + c.vy * Math.sin(c.a), want = landed ? Math.min(V, Math.sqrt(BEND_SHARE * GRIP_G * G * tightestAhead(P, jj, 50))) : V;
      const inp = L.driveAlong(c, P, Math.min(jj, P.length - 2), want * M, 12);
      if (landed && fwd > want * M) { inp.up = false; inp.down = true; }
      ent.updatePlayer(DT, inp);
      if (VERBOSE && ONLY && (c.air > 0 || cur)) console.log(`    ${V} f${f} air ${(c.air || 0).toFixed(2)} gy ${c.gy.toFixed(2)} ground ${world.groundY(c.x, c.y).toFixed(2)} at (${(c.x / M).toFixed(1)},${(c.y / M).toFixed(1)}) off ${(t.d / M).toFixed(1)} m`);
      if (c.air > 0) cur = c.air;
      else if (cur) {
        if (!flights.length) landed = { s: (P[jj].s - P[lip].s) / M, off: Math.abs(t.d) / M, kind: world.surfaceAt(c.x, c.y), hp: c.hp };
        flights.push({ t: cur, at: (P[jj].s - P[lip].s) / M }); cur = 0;
      }
      if (landed && !(c.air > 0)) { worstOff = Math.max(worstOff, Math.abs(t.d) / M); if (Math.abs(t.d) > e.halfW + 2 * M) offRoad++; }
    }
    if (cur) flights.push({ t: cur, at: Infinity });
    const first = flights[0], air = first?.t || 0, hops = flights.filter(q => q.t > 0.2);
    row.push(`${V} m/s ${flights.map(q => q.t.toFixed(2)).join(' + ') || 'none'} s${landed ? `, down ${landed.s.toFixed(0)} m past the lip ${landed.off.toFixed(1)} m off the centre line` : ''}`);
    check(air >= 0.5 && air <= 1.5, `${j.id} at ${V} m/s: the jump's flight is 0.5-1.5 s (${air.toFixed(2)})`);
    check(hops.filter(q => q.at <= FIRST).length === 1, `${j.id} at ${V} m/s: one flight in the ${FIRST} m past the lip (${flights.map(q => q.t.toFixed(2)).join(', ') || 'none'})`);
    if (!strict) continue;
    check(landed && landed.off <= e.halfW / M && [world.ROAD, world.DECK, world.DIRT].includes(landed.kind), `${j.id} at ${V} m/s: lands on the carriageway (${landed ? landed.off.toFixed(1) + ' m off the centre, kind ' + landed.kind : 'never'})`);
    check(hops.length === 1, `${j.id} at ${V} m/s: no second hop over the next ${AHEAD} m (${flights.map(q => q.t.toFixed(2) + ' s at ' + q.at.toFixed(0) + ' m').join(', ')})`);
    check(offRoad === 0, `${j.id} at ${V} m/s: on the road after the landing (up to ${worstOff.toFixed(1)} m off the centre line; ${offRoad} frames past its edge + 2 m)`);
    check(c.hp >= hp0 - 1, `${j.id} at ${V} m/s: no rail or wall hit (hp ${hp0.toFixed(1)} -> ${c.hp.toFixed(1)})`);
  }
  console.log(`  ${j.id}: ${row.join(', ')}`);
}

console.log(`\nf3 jumps: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
