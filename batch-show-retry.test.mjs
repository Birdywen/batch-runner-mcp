// omega_batch: show:true / verbose put step output in the success verdict; retries rerun flaky steps.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.OMEGA_JOB_DIR = mkdtempSync(path.join(tmpdir(), 'omega-jobs-test-'));
process.env.OMEGA_ARTIFACT_DIR = mkdtempSync(path.join(tmpdir(), 'omega-art-test-'));
const { runProcess } = await import('./server.mjs');
const { omegaBatch } = await import('./tools-ext.mjs');
const run = (args) => omegaBatch({ waitMs: 20000, ...args }, runProcess);

// show:true includes only that step's output; the other stays hidden.
{
  const r = await run({ steps: [{ label: 'a', command_line: 'echo SHOWN_LINE', show: true }, { label: 'b', command_line: 'echo HIDDEN_LINE' }] });
  assert.match(r.text, /success 2\/2/);
  assert.match(r.text, /SHOWN_LINE/);
  assert.doesNotMatch(r.text, /HIDDEN_LINE/);
}
// default stays one line.
{
  const r = await run({ steps: [{ label: 'a', command_line: 'echo SECRET_OUT' }] });
  assert.equal(r.text.split('\n').length, 1);
  assert.doesNotMatch(r.text, /SECRET_OUT/);
}
// verbose on omega_batch includes every step.
{
  const r = await run({ verbose: true, steps: [{ label: 'a', command_line: 'echo V_ONE' }, { label: 'b', command_line: 'echo V_TWO' }] });
  assert.match(r.text, /V_ONE/); assert.match(r.text, /V_TWO/);
}
// retries: fails twice, passes on third attempt (counter file in /tmp).
{
  const f = '/tmp/' + path.basename(`retry-${Date.now()}`);
  const cmd = `n=$(cat ${f} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${f}; [ $n -ge 3 ] && echo RETRY_OK`;
  const ok = await run({ steps: [{ label: 'flaky', command_line: cmd, retries: 2, expect: { contains: ['RETRY_OK'] } }] });
  assert.match(ok.text, /success 1\/1/);
  const f2 = '/tmp/' + path.basename(`retry2-${Date.now()}`);
  const cmd2 = `n=$(cat ${f2} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${f2}; [ $n -ge 3 ] && echo RETRY_OK`;
  const bad = await run({ steps: [{ label: 'flaky', command_line: cmd2, retries: 1, expect: { contains: ['RETRY_OK'] } }] });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /attempts=2/);
}
// no retries by default: single attempt.
{
  const r = await run({ steps: [{ label: 'x', command_line: 'false' }] });
  assert.equal(r.isError, true);
  assert.doesNotMatch(r.text, /attempts=/);
}
console.log('SHOW_RETRY_OK');
