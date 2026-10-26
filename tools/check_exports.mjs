#!/usr/bin/env node
// Guards the world and city facades (docs/map-v2-spec.md §7). Run from anywhere:
//   node tools/check_exports.mjs        (add -v to also list every name each world exports)
// It reads every module under src/ and tools/ with a small static parser (no browser, no 'three') and checks:
//  1. every name imported from src/world.js or src/3d/city.js is exported by that facade, so the page can
//     never die with a link error;
//  2. names a shared module takes from world.js exist in both worlds (world-grid.js and world-v2.js). Files
//     that only run on one world may use its own names (FILE_KIND), as may names allowed in the file with a
//     comment such as `// check_exports grid-only: N, tileAt` (used only when KIND is 'grid'), or listed in
//     ALLOW below while a later stage moves them off. The same holds for city.js against cityGrid.js and
//     cityV2.js once both exist;
//  3. world modules export no `let` or `var`, so no export is ever reassigned, and the world facade forwards
//     every name either world exports;
//  4. src/map, src/sim and src/world*.js never reach 'three' or src/3d, even through other modules;
//  5. the world facade loads in node, forwards each name as the chosen world's own value, and picks a
//     map the way the spec says (default, KC_WORLD, ?map=, localStorage 'kc-map', READY fallback).
// Exits 1 if any check fails; warnings and notes do not fail it.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('-v');
const rel = f => path.relative(ROOT, f).split(path.sep).join('/');
const abs = r => path.join(ROOT, r);

const WORLD = abs('src/world.js'), WGRID = abs('src/world-grid.js'), WV2 = abs('src/world-v2.js');
const CITY = abs('src/3d/city.js'), CGRID = abs('src/3d/cityGrid.js'), CV2 = abs('src/3d/cityV2.js');

// Files that only ever run on one world, so they may use that world's own names.
const FILE_KIND = {
  'src/main.js': 'grid',          // the 2D game: 2d.html pins KC_WORLD='grid'
  'src/3d/cityGrid.js': 'grid',
  'src/3d/cityV2.js': 'v2', 'src/3d/terrain3d.js': 'v2', 'src/3d/coast3d.js': 'v2', 'src/3d/roads3d.js': 'v2',
  'src/3d/buildings3d.js': 'v2', 'src/3d/props3d.js': 'v2', 'src/3d/landmarks3d.js': 'v2',
};

// Grid-only names that shared modules still use until the stage beside them moves them off (spec §8),
// as 'src/file.js': { grid: ['N', ...], until: 'S1b' }. They are undefined on v2, so they are reported as
// warnings, not errors. Empty since S1b and S1c moved entities, missions and police off P, BLOCKS and
// roadCenter: any new grid-only use in a shared module is an error again.
const ALLOW = {};

const errors = [], warnings = [], notes = [];
const err = m => errors.push(m), warn = m => warnings.push(m), note = m => notes.push(m);

// ---------- lexer: just enough JavaScript to find imports, exports and member uses ----------

// after these words a '/' starts a regular expression, not a division
const EXPR_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const PUNC3 = ['...', '===', '!=='], PUNC2 = ['=>', '==', '!=', '?.'];

function lex(src) {
  const toks = [], comments = [], tmpl = [];   // tmpl: open-brace counts of each template ${ } we are inside
  let i = 0, line = 1, prev = null;
  const n = src.length;
  const push = (t, v, l = line) => { prev = { t, v, line: l }; toks.push(prev); };
  const regexOK = () => !prev || (prev.t === 'id' ? EXPR_WORDS.has(prev.v) : prev.t === 'punc' && prev.v !== ')' && prev.v !== ']');
  // scan template text up to its end or the next ${; returns true when an expression starts
  const templateText = () => {
    while (i < n) {
      const c = src[i];
      if (c === '\\') { if (src[i + 1] === '\n') line++; i += 2; continue; }
      if (c === '\n') line++;
      if (c === '`') { i++; prev = { t: 'tmpl', v: '', line }; return false; }
      if (c === '$' && src[i + 1] === '{') { i += 2; tmpl.push(0); prev = { t: 'punc', v: '${', line }; return true; }
      i++;
    }
    return false;
  };
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '﻿' || c === ' ') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i) < 0 ? n : src.indexOf('\n', i);
      comments.push({ v: src.slice(i + 2, e), line }); i = e; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2) < 0 ? n : src.indexOf('*/', i + 2) + 2;
      const text = src.slice(i + 2, e - 2);
      comments.push({ v: text, line }); line += text.split('\n').length - 1; i = e; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      push('str', src.slice(i + 1, j)); i = j + 1; continue;
    }
    if (c === '`') { const l = line; i++; push('tmpl', '', l); templateText(); continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
      let j = i + 1;
      while (j < n && (/[\w.]/.test(src[j]) || ((src[j] === '-' || src[j] === '+') && /[eE]/.test(src[j - 1]) && !/^0[xX]/.test(src.slice(i, j))))) j++;
      push('num', src.slice(i, j)); i = j; continue;
    }
    if (/[A-Za-z_$#\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$\u0080-￿]/.test(src[j])) j++;
      push('id', src.slice(i, j)); i = j; continue;
    }
    if (c === '/' && regexOK()) {
      let j = i + 1, inClass = false;
      for (; j < n && src[j] !== '\n'; j++) {
        if (src[j] === '\\') { j++; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
      }
      if (j < n && src[j] === '/') {
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        push('re', src.slice(i, j)); i = j; continue;
      }
    }
    if (c === '{' && tmpl.length) tmpl[tmpl.length - 1]++;
    if (c === '}' && tmpl.length) {
      if (tmpl[tmpl.length - 1] === 0) { tmpl.pop(); i++; templateText(); continue; }   // end of a ${ } inside a template
      tmpl[tmpl.length - 1]--;
    }
    const p = PUNC3.find(s => src.startsWith(s, i)) || PUNC2.find(s => src.startsWith(s, i) && !(s === '?.' && /[0-9]/.test(src[i + 2]))) || c;
    push('punc', p); i += p.length;
  }
  return { toks, comments };
}

// ---------- parser: imports, exports and namespace member uses ----------

const OPEN = new Set(['(', '[', '{']), CLOSE = new Set([')', ']', '}']);
const STMT = new Set(['export', 'import', 'const', 'let', 'var', 'function', 'class', 'if', 'for', 'while', 'do', 'return', 'switch', 'try', 'throw']);
const isMember = (toks, k) => k > 0 && (toks[k - 1].v === '.' || toks[k - 1].v === '?.');

function matchClose(toks, j) {
  for (let d = 0; j < toks.length; j++) {
    if (toks[j].t !== 'punc') continue;
    if (OPEN.has(toks[j].v)) d++;
    else if (CLOSE.has(toks[j].v) && --d === 0) return j;
  }
  return toks.length - 1;
}

// skip one initializer: stop at a ',' or ';' at its own level, at the end of the enclosing block, or at a
// new statement on a later line (a missing semicolon)
function skipExpr(toks, j) {
  for (let d = 0; j < toks.length; j++) {
    const t = toks[j], p = toks[j - 1];
    if (t.t === 'punc') {
      if (OPEN.has(t.v)) d++;
      else if (CLOSE.has(t.v)) { if (d === 0) return j; d--; }
      else if (d === 0 && (t.v === ',' || t.v === ';')) return j;
    } else if (d === 0 && t.t === 'id' && STMT.has(t.v) && t.line > p.line && !(p.t === 'punc' && !CLOSE.has(p.v))) return j;
  }
  return j;
}

// names bound by a destructuring pattern between toks[a] ('{' or '[') and toks[b]
function patternNames(toks, a, b) {
  const out = [];
  for (let j = a + 1; j < b; j++) {
    const t = toks[j], nx = toks[j + 1]?.v;
    if (t.t === 'id' && !isMember(toks, j) && (nx === ',' || nx === '}' || nx === ']' || nx === '=') && toks[j - 1].v !== '=') out.push(t.v);
  }
  return out;
}

function declNames(toks, j) {
  const names = [];
  while (j < toks.length) {
    const t = toks[j];
    if (t.t === 'id') { names.push(t.v); j++; }
    else if (t.v === '{' || t.v === '[') { const e = matchClose(toks, j); names.push(...patternNames(toks, j, e)); j = e + 1; }
    else break;
    if (toks[j]?.v === '=') j = skipExpr(toks, j + 1);
    if (toks[j]?.v !== ',') break;
    j++;
  }
  return names;
}

// `{ a, b as c }` starting at toks[j] === '{' -> [[a,a],[b,c]] and the index after '}'
function specList(toks, j) {
  const e = matchClose(toks, j), out = [];
  for (let k = j + 1; k < e; k++) {
    const t = toks[k];
    if (t.v === ',') continue;
    let a = t.v, b = t.v;
    if (toks[k + 1]?.v === 'as') { b = toks[k + 2].v; k += 2; }
    out.push([a, b, t.line]);
  }
  return [out, e + 1];
}

const fromSpec = (toks, j) => (toks[j]?.v === 'from' && toks[j + 1]?.t === 'str' ? toks[j + 1].v : null);

const parsed = new Map();
function parse(file) {
  if (parsed.has(file)) return parsed.get(file);
  if (!existsSync(file)) { parsed.set(file, null); return null; }
  const { toks, comments } = lex(readFileSync(file, 'utf8'));
  // m.imports: { spec, line, names: [[imported, local, line]], ns, dynamic }
  const m = { file, toks, comments, imports: [], exports: new Set(), stars: [], letExports: [], depth: 0 };
  let depth = 0;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t === 'punc') { if (OPEN.has(t.v)) depth++; else if (CLOSE.has(t.v)) depth--; continue; }
    if (t.t !== 'id' || isMember(toks, k)) continue;
    if (t.v === 'import') {
      const nx = toks[k + 1];
      if (nx?.v === '(') {
        if (toks[k + 2]?.t === 'str') m.imports.push({ spec: toks[k + 2].v, line: t.line, names: [], ns: null, dynamic: true });
        continue;
      }
      if (depth !== 0 || nx?.v === '.') continue;          // import.meta
      if (nx?.t === 'str') { m.imports.push({ spec: nx.v, line: t.line, names: [], ns: null }); continue; }
      const imp = { spec: null, line: t.line, names: [], ns: null };
      let j = k + 1;
      if (toks[j]?.t === 'id' && toks[j].v !== 'from' && (toks[j + 1]?.v === ',' || toks[j + 1]?.v === 'from')) {
        imp.names.push(['default', toks[j].v, toks[j].line]); j++;
        if (toks[j].v === ',') j++;
      }
      if (toks[j]?.v === '*' && toks[j + 1]?.v === 'as') { imp.ns = toks[j + 2].v; j += 3; }
      else if (toks[j]?.v === '{') { const [list, e] = specList(toks, j); imp.names.push(...list); j = e; }
      imp.spec = fromSpec(toks, j);
      if (imp.spec != null) m.imports.push(imp);
      continue;
    }
    if (t.v !== 'export' || depth !== 0) continue;
    const nx = toks[k + 1];
    if (nx?.v === '*') {
      if (toks[k + 2]?.v === 'as') {
        m.exports.add(toks[k + 3].v);
        const spec = fromSpec(toks, k + 4);
        if (spec) m.imports.push({ spec, line: t.line, names: [], ns: toks[k + 3].v, reexport: true });
      } else {
        const spec = fromSpec(toks, k + 2);
        if (spec) { m.stars.push(spec); m.imports.push({ spec, line: t.line, names: [], ns: null, star: true }); }
      }
    } else if (nx?.v === '{') {
      const [list, e] = specList(toks, k + 1);
      for (const [, b] of list) m.exports.add(b);
      const spec = fromSpec(toks, e);
      if (spec) m.imports.push({ spec, line: t.line, names: list.map(([a, b, l]) => [a, b, l]), ns: null, reexport: true });
    } else if (nx?.v === 'default') m.exports.add('default');
    else if (nx?.v === 'const' || nx?.v === 'let' || nx?.v === 'var') {
      const names = declNames(toks, k + 2);
      for (const x of names) m.exports.add(x);
      if (nx.v !== 'const') m.letExports.push([names.join(', '), t.line]);
    } else if (nx?.v === 'function' || nx?.v === 'class' || (nx?.v === 'async' && toks[k + 2]?.v === 'function')) {
      let j = k + (nx.v === 'async' ? 3 : 2);
      if (toks[j]?.v === '*') j++;
      if (toks[j]?.t === 'id') m.exports.add(toks[j].v);
    }
  }
  m.depth = depth;
  if (depth !== 0) warn(`${rel(file)}: the parser lost track of braces (depth ${depth} at the end); its results may be incomplete`);
  parsed.set(file, m);
  return m;
}

// what a namespace import is used for: ns.x, ns?.x, and const { x } = ns
function memberUses(m, ns) {
  const out = [], { toks } = m;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t !== 'id' || t.v !== ns || isMember(toks, k)) continue;
    const nx = toks[k + 1];
    if ((nx?.v === '.' || nx?.v === '?.') && toks[k + 2]?.t === 'id') out.push([toks[k + 2].v, toks[k + 2].line]);
    else if (nx?.v === '[') warn(`${rel(m.file)}:${t.line} reads ${ns}[...] with a computed name, which this check cannot follow`);
    else if (toks[k - 1]?.v === '=' && toks[k - 2]?.v === '}') {
      let a = k - 2;
      for (let d = 0; a >= 0; a--) {
        if (toks[a].v === '}') d++;
        else if (toks[a].v === '{' && --d === 0) break;
      }
      for (let j = a + 1; j < k - 2; j++) {
        const nj = toks[j + 1]?.v;
        if (toks[j].t === 'id' && toks[j - 1].v !== ':' && toks[j - 1].v !== '=' && (nj === ',' || nj === '}' || nj === ':' || nj === '=')) out.push([toks[j].v, toks[j].line]);
      }
    }
  }
  return out;
}

function resolve(from, spec) {
  if (spec === 'three' || spec.startsWith('three/')) return { ext: 'three' };
  if (spec.startsWith('./') || spec.startsWith('../')) return { file: path.resolve(path.dirname(from), spec) };
  if (spec.startsWith('/')) return { file: path.join(ROOT, spec) };
  return { ext: spec };
}

// every name a module exports, following export * (a module's own names win over starred ones)
const exportCache = new Map();
function exportsOf(file, seen = new Set()) {
  if (exportCache.has(file)) return exportCache.get(file);
  const m = parse(file);
  if (!m) return null;
  if (seen.has(file)) return m.exports;
  seen.add(file);
  const out = new Set(m.exports);
  for (const spec of m.stars) {
    const r = resolve(file, spec);
    const sub = r.file && exportsOf(r.file, seen);
    if (sub) for (const x of sub) if (x !== 'default') out.add(x);
  }
  exportCache.set(file, out);
  return out;
}

// ---------- the module set ----------

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const f = path.join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (/\.m?js$/.test(e)) out.push(f);
  }
  return out;
}
const files = [...walk(abs('src')), ...walk(abs('tools'))].sort();
for (const f of files) parse(f);

// names a module takes from `target`: named imports, re-exports and namespace member uses
function usesOf(m, target) {
  const out = [];
  for (const imp of m.imports) {
    const r = resolve(m.file, imp.spec);
    if (r.file !== target) continue;
    for (const [name, , line] of imp.names) out.push([name, line]);
    if (imp.ns && !imp.reexport) out.push(...memberUses(m, imp.ns));
  }
  return out;
}

// names a file allows itself with `// check_exports grid-only: a, b` or `v2-only:`
function pragmas(m) {
  const out = { grid: new Set(), v2: new Set() };
  for (const c of m.comments) {
    for (const hit of c.v.matchAll(/check_exports\s+(grid|v2)-only:\s*([\w$][\w$,\s]*)/g))
      for (const x of hit[2].split(/[\s,]+/)) if (x) out[hit[1]].add(x);
  }
  return out;
}

// ---------- check 1 and 2: facade uses ----------

function checkFacade(label, facade, gridFile, v2File, { ownNamesOK }) {
  const facadeEx = exportsOf(facade);
  if (!facadeEx) { err(`${rel(facade)} is missing`); return 0; }
  const gEx = gridFile && exportsOf(gridFile), vEx = v2File && exportsOf(v2File);
  const split = !!(gEx && vEx);
  let users = 0;
  for (const f of files) {
    if (f === facade || f === gridFile || f === v2File) continue;
    const m = parsed.get(f), r = rel(f);
    const uses = usesOf(m, facade);
    if (!uses.length) continue;
    users++;
    const kind = FILE_KIND[r], allow = pragmas(m), table = ALLOW[r];
    const seen = new Set();
    for (const [name, line] of uses) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (!facadeEx.has(name)) { err(`${r}:${line} imports '${name}' from ${label}, which does not export it (the page would fail to load)`); continue; }
      if (!split) continue;
      const inG = gEx.has(name), inV = vEx.has(name);
      if (inG && inV) continue;
      if (!inG && !inV) {
        if (ownNamesOK) continue;   // made by the facade itself
        if (kind === 'v2' || allow.v2.has(name)) warn(`${r}:${line} uses '${name}', which ${rel(v2File)} does not export yet`);
        else err(`${r}:${line} uses '${name}' from ${label}, which neither world exports (always undefined)`);
        continue;
      }
      const only = inG ? 'grid' : 'v2', other = inG ? rel(v2File) : rel(gridFile);
      if (kind === only || allow[only].has(name)) continue;
      if (only === 'grid' && table?.grid?.includes(name)) { warn(`${r}:${line} uses grid-only '${name}' (undefined on v2; allowed until ${table.until})`); continue; }
      const who = kind ? `runs only on ${kind}` : 'is shared';
      err(`${r}:${line} ${who} but uses ${only}-only '${name}' (undefined in ${other}); move it to a name both worlds have, or mark it \`// check_exports ${only}-only: ${name}\` if it is only read on ${only}`);
    }
    if (table && label === 'world.js') for (const x of table.grid) if (!seen.has(x)) note(`${r} no longer uses '${x}'; its ALLOW entry in tools/check_exports.mjs can go`);
  }
  return users;
}

const worldUsers = checkFacade('world.js', WORLD, WGRID, WV2, { ownNamesOK: false });
const citySplit = existsSync(CGRID) && existsSync(CV2);
const cityUsers = checkFacade('city.js', CITY, citySplit ? CGRID : null, citySplit ? CV2 : null, { ownNamesOK: true });
if (!citySplit) note('src/3d/city.js is not split into cityGrid.js and cityV2.js yet, so city names are only checked against city.js');

// ---------- check 3: world modules and the facade's forwarding ----------

const gridEx = exportsOf(WGRID), v2Ex = exportsOf(WV2), worldEx = exportsOf(WORLD);
for (const f of [WORLD, WGRID, WV2]) {
  const m = parsed.get(f);
  if (!m) { err(`${rel(f)} is missing`); continue; }
  for (const [names, line] of m.letExports) err(`${rel(f)}:${line} exports '${names}' with let/var; world exports must never be reassigned (fill containers in place)`);
}
if (gridEx && v2Ex && worldEx) {
  for (const [file, ex] of [[WGRID, gridEx], [WV2, v2Ex]])
    for (const x of ex) if (x !== 'default' && !worldEx.has(x)) warn(`${rel(file)} exports '${x}' but src/world.js does not forward it, so no module can reach it`);
  for (const x of worldEx) if (!gridEx.has(x) && !v2Ex.has(x)) note(`world.js forwards '${x}', which no world exports yet (undefined until one does)`);
}

// ---------- check 4: headless modules stay away from three and src/3d ----------

const headless = files.filter(f => { const r = rel(f); return r.startsWith('src/map/') || r.startsWith('src/sim/') || /^src\/world[^/]*\.js$/.test(r); });
for (const root of headless) {
  const queue = [[root, [rel(root)]]], visited = new Set([root]);
  while (queue.length) {
    const [f, chain] = queue.shift();
    const m = parse(f);
    if (!m) continue;
    for (const imp of m.imports) {
      const r = resolve(f, imp.spec);
      const bad = r.ext === 'three' ? `'${imp.spec}'` : r.file && rel(r.file).startsWith('src/3d/') ? rel(r.file) : null;
      if (bad) { err(`${chain.join(' -> ')} imports ${bad} at line ${imp.line}; src/map, src/sim and world*.js must run in node without three or src/3d`); continue; }
      if (r.file && !visited.has(r.file)) { visited.add(r.file); queue.push([r.file, [...chain, rel(r.file)]]); }
    }
  }
}

// modules other than the facade (and node tools) should not pick a world themselves
for (const f of files) {
  const r = rel(f);
  if (r.startsWith('tools/') || /^src\/world[^/]*\.js$/.test(r)) continue;
  for (const imp of parsed.get(f).imports) {
    const t = resolve(f, imp.spec).file;
    if (t === WGRID || t === WV2) warn(`${r}:${imp.line} imports ${rel(t)} directly; import src/world.js so the map choice stays in one place`);
  }
}

// ---------- check 5: the facade in node ----------

async function facadeIn(env, tag) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = Object.getOwnPropertyDescriptor(globalThis, k); Object.defineProperty(globalThis, k, { value: env[k], configurable: true, writable: true }); }
  try { return await import(`${pathToFileURL(WORLD).href}?case=${tag}`); }
  finally {
    for (const k of Object.keys(env)) { if (saved[k]) Object.defineProperty(globalThis, k, saved[k]); else delete globalThis[k]; }
  }
}

let picked = '?';
try {
  const G = await import(pathToFileURL(WGRID).href), V = await import(pathToFileURL(WV2).href);
  const F = await facadeIn({}, 'default');
  const runtime = new Set(Object.keys(F));
  for (const x of runtime) if (!worldEx?.has(x)) warn(`static parse missed '${x}' in src/world.js (the check itself needs a fix)`);
  for (const x of worldEx || []) if (!runtime.has(x)) warn(`static parse invented '${x}' in src/world.js (the check itself needs a fix)`);
  for (const [file, ns, ex] of [[WGRID, G, gridEx], [WV2, V, v2Ex]]) {
    const keys = new Set(Object.keys(ns));
    if (ex && (keys.size !== ex.size || [...keys].some(x => !ex.has(x)))) warn(`static parse of ${rel(file)} disagrees with node (${[...keys].filter(x => !ex.has(x)).concat([...ex].filter(x => !keys.has(x))).join(', ')})`);
  }
  const W = F.KIND === V.KIND && V.READY === true ? V : G;
  if (F.KIND !== G.KIND && F.KIND !== V.KIND) err(`world.js KIND is '${F.KIND}', which is neither world`);
  for (const x of runtime) if (F[x] !== W[x]) err(`world.js forwards '${x}' as something other than ${rel(W === V ? WV2 : WGRID)}'s own value`);
  if (F.KIND === V.KIND && V.READY !== true) err('world.js picked v2 although world-v2.js is not READY');
  picked = F.KIND;
  const v2or = V.READY === true ? V.KIND : G.KIND;
  const cases = [
    [{ KC_WORLD: '2' }, 'kc2', v2or], [{ KC_WORLD: 'v2' }, 'kcv2', v2or], [{ KC_WORLD: 'classic' }, 'kcclassic', G.KIND],
    [{ KC_WORLD: 1 }, 'kc1', G.KIND], [{ location: { search: '?map=2' } }, 'url2', v2or], [{ location: { search: '?map=grid' } }, 'urlgrid', G.KIND],
    [{ localStorage: { getItem: k => (k === 'kc-map' ? 'v2' : null) } }, 'ls', v2or],
    [{ KC_WORLD: 'grid', location: { search: '?map=2' } }, 'order', G.KIND],
    [{ localStorage: { getItem() { throw new Error('blocked'); } } }, 'lsblocked', F.KIND],
  ];
  const quiet = { info: console.info, warn: console.warn };
  console.info = console.warn = () => {};
  try {
    for (const [env, tag, want] of cases) {
      const got = (await facadeIn(env, tag)).KIND;
      if (got !== want) err(`world.js with ${JSON.stringify(env, (k, v) => (typeof v === 'function' ? 'fn' : v))} picked '${got}', expected '${want}'`);
    }
  } finally { Object.assign(console, quiet); }
} catch (e) {
  err(`src/world.js does not load in node: ${e.message}`);
}

// ---------- report ----------

console.log(`check_exports: ${files.length} modules; ${worldUsers} import world.js, ${cityUsers} import city.js`);
console.log(`  world-grid exports ${gridEx?.size ?? 0} names, world-v2 ${v2Ex?.size ?? 0}, the facade forwards ${worldEx?.size ?? 0}; it picks '${picked}' by default`);
if (VERBOSE && gridEx && v2Ex) {
  console.log(`  both: ${[...gridEx].filter(x => v2Ex.has(x)).sort().join(' ')}`);
  console.log(`  grid only: ${[...gridEx].filter(x => !v2Ex.has(x)).sort().join(' ') || '-'}`);
  console.log(`  v2 only: ${[...v2Ex].filter(x => !gridEx.has(x)).sort().join(' ') || '-'}`);
}
for (const m of notes) console.log(`  note: ${m}`);
for (const m of warnings) console.log(`  warning: ${m}`);
for (const m of errors) console.log(`  ERROR: ${m}`);
console.log(errors.length ? `${errors.length} error(s)` : `ok${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
process.exit(errors.length ? 1 : 0);
