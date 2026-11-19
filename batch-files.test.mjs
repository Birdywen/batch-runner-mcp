// omega_batch: batch-level files (OMEGA_FILES, cleaned up) and expect.files.
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.OMEGA_JOB_DIR = mkdtempSync(path.join(tmpdir(), 'omega-jobs-test-'));
process.env.OMEGA_ARTIFACT_DIR = mkdtempSync(path.join(tmpdir(), 'omega-art-test-'));
const { runProcess } = await import('./server.mjs');
const { omegaBatch } = await import('./tools-ext.mjs');
const run = (args) => omegaBatch({ waitMs: 20000, ...args }, runProcess);
const dir = mkdtempSync(path.join(tmpdir(), 'omega-files-'));

// a helper file is runnable via $OMEGA_FILES and is gone after the job
{
  const r = await run({ files: [{ path: 'sub/h.py', content: 'print("HELPER_RAN")' }], steps: [{ command_line: 'python3 "$OMEGA_FILES/sub/h.py" && echo "$OMEGA_FILES"', show: true, expect: { contains: ['HELPER_RAN'] } }] });
  assert.match(r.text, /success 1\/1/, r.text);
  const d = r.text.match(/(\/\S+\.files)/)[1];
  assert.equal(existsSync(d), false, 'files dir removed');
}
// bad file paths are refused before anything runs
for (const p of ['../x', '/etc/x', 'a/../../x']) {
  const r = await run({ files: [{ path: p, content: 'x' }], steps: [{ command_line: 'echo SHOULD_NOT_RUN' }] });
  assert.equal(r.isError, true); assert.match(r.text, /nothing was run/);
}
// expect.files: exit 0 is not proof
{
  const ok = await run({ steps: [{ cwd: dir, command_line: `echo hi > ${dir}/out.txt`, expect: { files: ['out.txt'] } }] });
  assert.match(ok.text, /success 1\/1/, ok.text);
  const miss = await run({ steps: [{ cwd: dir, command_line: 'true', expect: { files: ['nope.png'] } }] });
  assert.match(miss.text, /failed/); assert.match(miss.text, /nope\.png \(missing\)/);
  const small = await run({ steps: [{ cwd: dir, command_line: `: > ${dir}/empty.png`, expect: { files: [{ path: 'empty.png', minBytes: 10 }] } }] });
  assert.match(small.text, /empty\.png \(0 bytes, want >= 10\)/, small.text);
}
console.log('BATCH_FILES_TESTS_OK');
