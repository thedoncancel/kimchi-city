#!/usr/bin/env node
// What the page says in its console (stage S5a): loads the dev server's page in headless Chrome for a while and
// prints the console lines (errors, warnings, logs) and uncaught exceptions. Needs the dev server on :5173.
//   node tools/s5a_console.mjs '<query>' [seconds]     e.g.  node tools/s5a_console.mjs 'map=2&shot=ktown_circle' 15
// One page at a time (the tools/shot.sh lock).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LOCK = '/tmp/kc-shot.lock';
const query = process.argv[2] || 'map=2&shot=villa_terrace';
const secs = +(process.argv[3] || 15);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lock() {
  for (let i = 0; i < 240; i++) { try { mkdirSync(LOCK); return; } catch { await sleep(1000); } }
  throw new Error(`${LOCK} is held`);
}

await lock();
const profile = mkdtempSync(path.join(tmpdir(), 'kc-console-'));
try {
  const url = `http://localhost:5173/?gfx=high&${query}`;
  const p = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--window-size=1280,720', '--enable-logging=stderr', '--v=0', url], { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  p.stderr.on('data', (d) => { log += d; });
  await sleep(secs * 1000);
  p.kill('SIGKILL');
  const lines = log.split('\n').filter((l) => /CONSOLE|Uncaught|ERROR:.*(js|JS)/.test(l) && !/AudioContext was not allowed/.test(l));
  for (const l of lines) console.log(l.replace(/^\[[^\]]*\]\s*/, '').slice(0, 600));
  if (!lines.length) console.log('(no console output)');
} finally {
  rmSync(profile, { recursive: true, force: true });
  rmSync(LOCK, { recursive: true, force: true });
}
