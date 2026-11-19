// omega_batch edge cases for show / verbose / retries and neighbours (real runProcess).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

process.env.OMEGA_JOB_DIR = mkdtempSync(path.join(tmpdir(), 'omega-jobs-test-'));
process.env.OMEGA_ARTIFACT_DIR = mkdtempSync(path.join(tmpdir(), 'omega-art-test-'));
const { runProcess } = await import('./server.mjs');
const { omegaBatch, omegaBatchStatus, omegaBatchCancel } = await import('./tools-ext.mjs');
const run = (args) => omegaBatch({ waitMs: 30000, ...args }, runProcess);
const tag = `${process.pid}-${Date.now()}`;
const counter = (name) => `/tmp/bc-${tag}-${name}`;
// fails until its Nth run, then prints marker; counter file lives in /tmp
const flaky = (file, n, marker) =>
  `c=$(cat ${file} 2>/dev/null || echo 0); c=$((c+1)); echo $c > ${file}; [ $c -ge ${n} ] && echo ${marker}`;
const cleanup = [];
let cases = 0;
const ok = (name) => { cases++; console.log(`  ok ${name}`); };

// ---- show ----
{ // show on several steps, order preserved, unshown hidden
  const r = await run({ steps: [
    { label: 'a', command_line: 'echo OUT_A', show: true },
    { label: 'b', command_line: 'echo OUT_B' },
    { label: 'c', command_line: 'echo OUT_C', show: true }] });
  assert.match(r.text, /success 3\/3/);
  assert.ok(r.text.indexOf('OUT_A') < r.text.indexOf('OUT_C'));
  assert.doesNotMatch(r.text, /OUT_B/);
  ok('show on some steps only, in order');
}
{ // an unknown show value is refused up front, not silently ignored
  const r = await run({ steps: [{ label: 'a', command_line: 'echo STRICT_X', show: 'yes' }] });
  assert.equal(r.isError, true); assert.match(r.text, /show must be/); assert.doesNotMatch(r.text, /STRICT_X/);
  ok('invalid show is refused');
}
{ // long output: show caps at the last 40 lines and keeps the tail marker
  const r = await run({ steps: [{ label: 'long', command_line: 'seq 1 500; echo END_MARK', show: true, expect: { contains: ['END_MARK'] } }] });
  assert.match(r.text, /END_MARK/);
  assert.match(r.text, /^\.\.\.$/m);
  assert.doesNotMatch(r.text, /^100$/m);
  assert.ok(r.text.split('\n').length < 60);
  ok('show caps output at ~40 lines');
}
{ // very long single line is clipped
  const r = await run({ steps: [{ label: 'wide', command_line: 'python3 -c "print(\'x\'*2000)"', show: true }] });
  assert.ok(r.text.length < 900, `got ${r.text.length}`);
  ok('show clips wide lines');
}
{ // empty output with show does not crash
  const r = await run({ steps: [{ label: 'quiet', command_line: 'true', show: true }] });
  assert.match(r.text, /success 1\/1/);
  ok('show with empty output');
}
{ // unicode survives
  const r = await run({ steps: [{ label: 'u', command_line: "echo '中文 ✓ 🎵'", show: true }] });
  assert.match(r.text, /中文 ✓ 🎵/);
  ok('show keeps unicode');
}
{ // failed step with show: normal failure view, still has the error line
  const r = await run({ steps: [{ label: 'bad', command_line: 'echo ERR_LINE >&2; exit 3', show: true }] });
  assert.equal(r.isError, true);
  assert.match(r.text, /FAIL/); assert.match(r.text, /exit=3/); assert.match(r.text, /ERR_LINE/);
  ok('show does not disturb failure view');
}
{ // show + failure later: earlier shown passing step is not lost in status verbose
  const r = await run({ verbose: true, stopOnError: false, steps: [
    { label: 'p', command_line: 'echo PASS_OUT' }, { label: 'f', command_line: 'exit 1' }] });
  assert.match(r.text, /partial/); assert.match(r.text, /PASS_OUT/);
  ok('verbose + partial keeps passing output');
}
{ // json format still carries the show flag and full results
  const r = await omegaBatch({ waitMs: 30000, format: 'json', steps: [{ label: 'j', command_line: 'echo J_OUT', show: true }] }, runProcess);
  const j = JSON.parse(r.text);
  assert.equal(j.results[0].show, true); assert.match(j.results[0].text, /J_OUT/);
  ok('json format has show + text');
}

// ---- verbose ----
{
  const r = await run({ verbose: true, steps: [{ label: 'v1', command_line: 'echo V1' }, { label: 'v2', command_line: 'echo V2' }] });
  assert.match(r.text, /V1/); assert.match(r.text, /V2/);
  ok('verbose shows all steps');
}
{ // waitMs:0 then status verbose picks it up
  const r = await omegaBatch({ waitMs: 0, steps: [{ label: 'w', command_line: 'echo LATER' }] }, runProcess);
  const s = await omegaBatchStatus({ id: r.data.jobId, waitMs: 10000, verbose: true });
  assert.match(s.text, /LATER/);
  ok('waitMs:0 then status verbose');
}

// ---- retries ----
{ const f = counter('a'); cleanup.push(f);
  const r = await run({ steps: [{ label: 'f', command_line: flaky(f, 3, 'R_OK'), retries: 2, expect: { contains: ['R_OK'] } }] });
  assert.match(r.text, /success 1\/1/); ok('retries:2 rescues 3rd-run pass');
}
{ const f = counter('b'); cleanup.push(f);
  const r = await run({ steps: [{ label: 'f', command_line: flaky(f, 5, 'R_OK'), retries: 2, expect: { contains: ['R_OK'] } }] });
  assert.equal(r.isError, true); assert.match(r.text, /attempts=3/); ok('exhausted retries report attempts=3');
}
{ const f = counter('c'); cleanup.push(f);
  const r = await run({ steps: [{ label: 'f', command_line: flaky(f, 99, 'R_OK'), retries: 99, expect: { contains: ['R_OK'] } }] });
  assert.match(r.text, /attempts=4/); ok('retries clamped to 3 (4 attempts)');
}
{ const f = counter('d'); cleanup.push(f);
  const r = await run({ steps: [{ label: 'f', command_line: flaky(f, 2, 'R_OK'), retries: -5, expect: { contains: ['R_OK'] } }] });
  assert.equal(r.isError, true); assert.doesNotMatch(r.text, /attempts=/); ok('negative retries = single attempt');
}
{ const f = counter('e'); cleanup.push(f);
  const r = await run({ steps: [{ label: 'f', command_line: flaky(f, 2, 'R_OK'), retries: 1.5, expect: { contains: ['R_OK'] } }] });
  assert.equal(r.isError, true); assert.doesNotMatch(r.text, /attempts=/); ok('fractional retries ignored');
}
{ const f = counter('f'); cleanup.push(f);
  const r = await run({ steps: [{ label: 'f', command_line: flaky(f, 2, 'R_OK'), retries: '3', expect: { contains: ['R_OK'] } }] });
  assert.equal(r.isError, true); ok('string retries ignored');
}
{ // invalid regex is a config error: never retried
  const r = await run({ steps: [{ label: 'rx', command_line: 'echo hi', retries: 3, expect: { regex: '(' } }] });
  assert.equal(r.isError, true); assert.doesNotMatch(r.text, /attempts=/); ok('bad regex not retried');
}
{ // expect-miss on first run, pass on retry (marker only on 2nd run)
  const f = counter('g'); cleanup.push(f);
  const cmd = `c=$(cat ${f} 2>/dev/null || echo 0); c=$((c+1)); echo $c > ${f}; if [ $c -ge 2 ]; then echo MARK_OK; else echo nope; fi`;
  const r = await run({ steps: [{ label: 'm', command_line: cmd, retries: 1, expect: { contains: ['MARK_OK'] } }] });
  assert.match(r.text, /success 1\/1/); ok('retry also covers expect misses (exit 0)');
}
{ // timeout then success on retry
  const f = counter('h'); cleanup.push(f);
  const cmd = `c=$(cat ${f} 2>/dev/null || echo 0); c=$((c+1)); echo $c > ${f}; [ $c -ge 2 ] || sleep 5; echo T_OK`;
  const r = await run({ steps: [{ label: 't', command_line: cmd, timeout: '1s', retries: 1, expect: { contains: ['T_OK'] } }] });
  assert.match(r.text, /success 1\/1/); ok('timeout then pass on retry');
}
{ // retries + show combine; passing step output visible
  const f = counter('i'); cleanup.push(f);
  const r = await run({ steps: [{ label: 'rs', command_line: flaky(f, 2, 'RS_OK'), retries: 1, show: true, expect: { contains: ['RS_OK'] } }] });
  assert.match(r.text, /RS_OK/); assert.match(r.text, /success 1\/1/); ok('retries + show combine');
}
{ // retried step does not leak into the next step; stopOnError halts after exhausted retries
  const f = counter('j'); cleanup.push(f);
  const r = await run({ steps: [{ label: 'f', command_line: flaky(f, 9, 'X'), retries: 1, expect: { contains: ['X'] } }, { label: 'next', command_line: 'echo NEXT_RAN' }] });
  assert.match(r.text, /failed 1\/2/); assert.match(r.text, /halted/); assert.doesNotMatch(r.text, /NEXT_RAN/); ok('exhausted retries halt batch');
}
{ // stopOnError:false continues past an exhausted step
  const f = counter('k'); cleanup.push(f);
  const r = await run({ stopOnError: false, verbose: true, steps: [{ label: 'f', command_line: flaky(f, 9, 'X'), retries: 1, expect: { contains: ['X'] } }, { label: 'next', command_line: 'echo NEXT_RAN' }] });
  assert.match(r.text, /partial 2\/2/); assert.match(r.text, /NEXT_RAN/); ok('stopOnError:false continues');
}
{ // cancel during a retrying step does not keep retrying
  const f = counter('l'); cleanup.push(f);
  const start = await omegaBatch({ waitMs: 0, steps: [{ label: 'slow', command_line: `echo x >> ${f}; sleep 20`, retries: 3 }] }, runProcess);
  const id = start.data.jobId;
  await new Promise((r) => setTimeout(r, 500));
  const t0 = Date.now();
  await omegaBatchCancel({ id });
  const s = await omegaBatchStatus({ id, waitMs: 8000, format: 'json' });
  const j = JSON.parse(s.text);
  assert.equal(j.state, 'cancelled'); assert.ok(Date.now() - t0 < 7000, 'cancel must not wait out retries');
  ok('cancel stops retry loop');
}

// ---- guard + isolation ----
{ const out = path.join(homedir(), 'should-not-exist.txt');
  const r = await run({ steps: [{ label: 'w', command_line: `echo x > ${out}`, show: true }] });
  assert.equal(r.isError, true); assert.match(r.text, /refused/); assert.equal(existsSync(out), false);
  ok('write guard still refuses outside /tmp');
}
{ // parallel batches do not mix outputs
  const [x, y] = await Promise.all([
    run({ steps: [{ label: 'x', command_line: 'sleep 0.3; echo PAR_X', show: true }] }),
    run({ steps: [{ label: 'y', command_line: 'sleep 0.1; echo PAR_Y', show: true }] })]);
  assert.match(x.text, /PAR_X/); assert.doesNotMatch(x.text, /PAR_Y/);
  assert.match(y.text, /PAR_Y/); assert.doesNotMatch(y.text, /PAR_X/);
  ok('parallel batches stay isolated');
}
{ // empty / bad input
  const r1 = await run({ steps: [] }); assert.equal(r1.isError, true);
  const r2 = await omegaBatchStatus({ id: 'job-nope', waitMs: 0 }); assert.equal(r2.isError, true);
  ok('empty steps and unknown id error cleanly');
}

for (const f of cleanup) rmSync(f, { force: true });
console.log(`BATCH_CASES_OK ${cases}`);
process.exit(0);
