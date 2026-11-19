// omega_batch validates step config BEFORE running anything; bare-string expect.count means min 1.
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.OMEGA_JOB_DIR = mkdtempSync(path.join(tmpdir(), 'omega-jobs-test-'));
process.env.OMEGA_ARTIFACT_DIR = mkdtempSync(path.join(tmpdir(), 'omega-art-test-'));
const { runProcess } = await import('./server.mjs');
const { omegaBatch } = await import('./tools-ext.mjs');
const run = (args) => omegaBatch({ waitMs: 20000, ...args }, runProcess);
const marker = path.join(tmpdir(), `bv-${process.pid}-${Date.now()}`);
let n = 0;
const ok = (m) => { n++; console.log(`  ok ${m}`); };

// bad config in the LAST step: step 1 must not have run (its side effect never happens)
for (const [name, bad] of [
  ['invalid show', { command_line: 'echo b', show: 'yes' }],
  ['count without bound', { command_line: 'echo b', expect: { count: { regex: 'b' } } }],
  ['count without pattern', { command_line: 'echo b', expect: { count: { equals: 1 } } }],
  ['count bad regex', { command_line: 'echo b', expect: { count: { regex: '(', equals: 1 } } }],
  ['expect.regex bad', { command_line: 'echo b', expect: { regex: '[' } }],
  ['count non-integer', { command_line: 'echo b', expect: { count: { regex: 'b', equals: 1.5 } } }],
  ['missing command_line', { label: 'nocmd' }],
]) {
  rmSync(marker, { force: true });
  const r = await run({ steps: [{ label: 'first', command_line: `touch ${marker}` }, { label: 'bad', ...bad }] });
  assert.equal(r.isError, true, name);
  assert.match(r.text, /refused: invalid batch, nothing was run/, name);
  assert.match(r.text, /step 2/, name);
  assert.equal(existsSync(marker), false, `${name}: step 1 must not run`);
  ok(`${name} refused before running`);
}

// several problems are all listed
{
  const r = await run({ steps: [{ command_line: 'echo', show: 'x' }, { command_line: 'echo', expect: { regex: '(' } }] });
  assert.match(r.text, /step 1/); assert.match(r.text, /step 2/);
  ok('all problems listed');
}

// bare-string count = at least once
{
  const pass = await run({ steps: [{ label: 'p', command_line: 'printf "E1\\nE2\\n"', expect: { count: '^E\\d$' } }] });
  assert.match(pass.text, /success 1\/1/);
  const fail = await run({ steps: [{ label: 'f', command_line: 'echo none', expect: { count: '^E\\d$' } }] });
  assert.equal(fail.isError, true); assert.match(fail.text, /want >= 1/);
  ok('bare-string count means min 1');
}

// valid configs still run, including the full combination
{
  const r = await run({ steps: [{ label: 'v', command_line: 'printf "a\\na\\n"', show: 'head', retries: 1, expect: { contains: ['a'], count: { regex: '^a$', equals: 2, max: 2 } } }] });
  assert.match(r.text, /success 1\/1/);
  ok('valid combined config runs');
}
rmSync(marker, { force: true });
console.log(`BATCH_VALIDATE_OK ${n}`);
process.exit(0);
