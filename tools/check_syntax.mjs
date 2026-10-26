#!/usr/bin/env node
// Parse-check ES modules without running them (no browser, no 'three' needed):
//   node --experimental-vm-modules tools/check_syntax.mjs src/3d/city.js src/map/*.js ...
// Exits 1 and prints file:line for the first syntax error in each file.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let bad = 0;
for (const f of process.argv.slice(2)) {
  try { new vm.SourceTextModule(readFileSync(f, 'utf8'), { identifier: f }); }
  catch (e) { bad++; console.log(`${f}: ${e.message}${e.stack?.match(/:(\d+)/) ? '' : ''}`); }
}
console.log(bad ? `${bad} file(s) with syntax errors` : 'ok');
process.exit(bad ? 1 : 0);
