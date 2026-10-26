#!/usr/bin/env node
// Stage S9: every node check and stage test in one run, one line each, for the lead's integration.
//   node tools/s9_suite.mjs [name-filter ...] [--baseline=<dir>] [--log=<dir>]
// Since S9 the world facade picks Kimchi Key by default. The tests written while the grid was the default and
// that test the grid without saying so run here with KC_WORLD=grid in their environment (src/world.js reads it
// in node after the page's own switches), so they test what they were written for. A test given a baseline
// directory (the pre-rebuild copy, as the earlier stages ran them) gets it with --baseline. Exits 1 if any fails.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const base = opt('baseline'), logDir = opt('log');
const filters = args.filter((a) => !a.startsWith('--'));

const GRID = { KC_WORLD: 'grid' };
const B = base ? [base] : [];
const srcFiles = () => {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) out.push(path.relative(ROOT, p)); } };
  walk(path.join(ROOT, 'src'));
  return out;
};
// [name, script, args, env]
const RUNS = [
  ['check_syntax', 'tools/check_syntax.mjs', srcFiles(), {}, ['--experimental-vm-modules']],
  ['check_exports', 'tools/check_exports.mjs', [], {}],
  ['roadnet', 'tools/roadnet_test.mjs', [], {}],
  ['map_check', 'tools/map_check.mjs', [], {}],
  // written for the grid (the default until S9)
  ['s0b_bench', 'tools/s0b_bench_test.mjs', [], GRID],
  ['s0b_city', 'tools/s0b_city_test.mjs', B, GRID],
  ['s0c_seams', 'tools/s0c_seams_test.mjs', B, GRID],
  ['s0d_maps', 'tools/test_s0d_maps.mjs', B, GRID],
  ['s0d_save', 'tools/test_s0d_save.mjs', [], GRID],
  ['s1b_traffic', 'tools/s1b_traffic_test.mjs', ['10', '1'], GRID],
  ['s1b_v2net', 'tools/s1b_v2net_test.mjs', ['10', '1'], GRID],
  ['s1c_nav', 'tools/s1c_nav_test.mjs', [], GRID],
  ['s1c_soak', 'tools/s1c_soak_test.mjs', [], GRID],
  ['s3b_city', 'tools/s3b_city_test.mjs', B, GRID],
  ['s3b_lowsun', 'tools/s3b_lowsun.mjs', [], GRID],
  ['s3b_soak', 'tools/s3b_soak_test.mjs', ['15'], GRID],
  ['s3c_bench', 'tools/s3c_bench_test.mjs', B, GRID],
  ['s3c_prewarm', 'tools/s3c_prewarm_test.mjs', [], GRID],
  ['s3c_views', 'tools/s3c_views_test.mjs', [], GRID],
  ['f2_nav', 'tools/f2_nav_test.mjs', [], GRID],
  // the grid by their own choice
  ['s6a_grid', 'tools/s6a_grid_test.mjs', base ? ['--baseline', base] : [], {}],
  ['f1_grid', 'tools/f1_grid_test.mjs', base ? ['--baseline', base] : [], {}],
  ['f4_traffic', 'tools/f4_traffic_test.mjs', ['1'], {}],
  ['s3c_soak_grid', 'tools/s3c_soak_test.mjs', ['15', 'grid'], {}],
  // Kimchi Key (they pick it themselves, or build world-v2 directly)
  ['s1c_v2_soak', 'tools/s1c_v2_soak.mjs', [], {}],
  ['s2b_world', 'tools/s2b_world_test.mjs', [], {}],
  ['s2b_prefab', 'tools/s2b_prefab_test.mjs', [], {}],
  ['s2c_lots', 'tools/s2c_lots_test.mjs', [], {}],
  ['s2c_props', 'tools/s2c_props_test.mjs', [], {}],
  ['s2c_map', 'tools/s2c_map.mjs', [], {}],
  ['s3a_chunks', 'tools/s3a_chunks_test.mjs', [], {}],
  ['s3a_geo', 'tools/s3a_geo_test.mjs', B, {}],
  ['s3a_scatter', 'tools/s3a_scatter_test.mjs', B, {}],
  ['s3c_soak_v2', 'tools/s3c_soak_test.mjs', ['15', 'v2'], {}],
  ['s4a_city', 'tools/s4a_city_test.mjs', [], {}],
  ['s4b_roads', 'tools/s4b_roads_test.mjs', [], {}],
  ['s5a_buildings', 'tools/s5a_buildings_test.mjs', [], {}],
  ['s5b', 'tools/s5b_test.mjs', [], {}],
  ['s6a_drive', 'tools/s6a_drive_test.mjs', [], {}],
  ['s6a_soak', 'tools/s6a_soak.mjs', ['10', '1'], {}],
  ['s6b', 'tools/s6b_test.mjs', [], {}],
  ['s7a_missions', 'tools/s7a_missions_test.mjs', [], {}],
  ['s7a_deliver', 'tools/s7a_deliver_test.mjs', [], {}],
  ['s7a_photo', 'tools/s7a_photo_test.mjs', [], {}],
  ['s7a_police', 'tools/s7a_police_test.mjs', [], {}],
  ['s7a_race', 'tools/s7a_race_test.mjs', [], {}],
  ['s7b_fx', 'tools/s7b_fx_test.mjs', [], {}],
  ['s7b_maps', 'tools/s7b_maps_test.mjs', [], {}],
  ['s7b_save', 'tools/s7b_save_test.mjs', [], {}],
  ['s8', 'tools/s8_test.mjs', [], {}],
  ['s8_slide', 'tools/s8_slide_test.mjs', [], {}],
  ['f1_collide', 'tools/f1_collide_test.mjs', [], {}],
  ['f2_v2', 'tools/f2_v2_test.mjs', [], {}],
  ['f3_world', 'tools/f3_world_test.mjs', [], {}],
  ['f3_jumps', 'tools/f3_jumps_test.mjs', [], {}],
  ['f4_peds', 'tools/f4_peds_test.mjs', ['10', '1'], {}],
  ['f4_signals', 'tools/f4_signals_soak.mjs', ['10', '1'], {}],
  ['p1_terrain', 'tools/p1_terrain_test.mjs', [], {}],
  ['p2_flora', 'tools/p2_flora_test.mjs', [], {}],
  ['p3_buildings', 'tools/p3_buildings_test.mjs', [], {}],
  ['p4', 'tools/p4_test.mjs', [], {}],
  ['s9_world', 'tools/s9_world_test.mjs', [], {}],
];

if (logDir) mkdirSync(logDir, { recursive: true });
const failed = [];
for (const [name, script, a, env, nodeArgs = []] of RUNS) {
  if (filters.length && !filters.some((f) => name.includes(f))) continue;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [...nodeArgs, script, ...a], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 15 * 60 * 1000 });
  const text = (r.stdout || '') + (r.stderr || '');
  if (logDir) writeFileSync(path.join(logDir, `${name}.log`), text);
  const last = text.split('\n').filter((l) => l.trim() && !/trace-warnings|ExperimentalWarning|type": "module"|MODULE_TYPELESS|Reparsing as ES module/.test(l)).slice(-1)[0] || '';
  const ok = r.status === 0;
  if (!ok) failed.push(name);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(14)} ${String(Math.round((Date.now() - t0) / 1000)).padStart(4)} s  ${env.KC_WORLD ? '[grid] ' : ''}${last.trim().slice(0, 150)}`);
}
console.log(failed.length ? `${failed.length} failed: ${failed.join(', ')}` : 'all passed');
process.exit(failed.length ? 1 : 0);
