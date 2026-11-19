// omega_batch against the real runProcess: cancel kills the active step,
// expect sees full output past the preview cap, per-step env, on-disk state,
// and a restart-orphaned job reads as interrupted.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const jobDir = mkdtempSync(path.join(tmpdir(), 'omega-jobs-test-'));
process.env.OMEGA_JOB_DIR = jobDir;
process.env.OMEGA_ARTIFACT_DIR = mkdtempSync(path.join(tmpdir(), 'omega-art-test-'));
const { runProcess } = await import('./server.mjs');
const { omegaBatch, omegaBatchStatus, omegaBatchCancel } = await import('./tools-ext.mjs');

const start = async (args) => (await omegaBatch({ waitMs: 0, ...args }, runProcess)).data.jobId;
const json = async (id, waitMs = 10000) => JSON.parse((await omegaBatchStatus({ id, waitMs, format: 'json' })).text);

// 1. A marker buried in the middle of long output still satisfies expect,
//    and the step records the artifact ref for the full text.
{
  const cmd = 'python3 -c \'print("a"*9000); print("MID_MARKER"); print("b"*9000)\'';
  const job = await json(await start({ steps: [{ command_line: cmd, expect: { contains: ['MID_MARKER'] } }] }));
  assert.equal(job.state, 'success', 'expect must run on full output');
  assert.match(job.results[0].artifact || '', /^artifact:\/\//, 'long step output must point at an artifact');
  assert.ok(job.results[0].text.length <= 4000);
}

// 2. Per-step env reaches the command.
{
  const job = await json(await start({ steps: [{ command_line: 'echo "v=$FORGE_T"', env: { FORGE_T: 'ENV_OK' }, expect: { contains: ['v=ENV_OK'] } }] }));
  assert.equal(job.state, 'success');
}

// 3. Cancel kills the running step instead of waiting for it.
{
  const id = await start({ steps: [{ command_line: 'sleep 30' }, { command_line: 'echo never' }] });
  await new Promise((r) => setTimeout(r, 400));
  const running = await omegaBatchStatus({ id });
  assert.match(running.text, /\[\.\.\] 1\. sleep 30 \(running \d+s\)/, 'running status must show the active step');
  const t0 = Date.now();
  const c = omegaBatchCancel({ id });
  assert.equal(c.isError, false);
  assert.match(c.text, /SIGTERM/);
  const job = await json(id);
  assert.equal(job.state, 'cancelled');
  assert.ok(Date.now() - t0 < 5000, 'cancel must not wait for sleep 30');
  assert.equal(job.results[0].failureType, 'cancelled');
  assert.ok(!job.results.some((r) => r.status === 'passed'));
}

// 4. State is on disk; a running job from a dead server reads as interrupted.
{
  const id = await start({ steps: [{ command_line: 'echo disk' }] });
  await json(id);
  assert.ok(existsSync(path.join(jobDir, `${id}.json`)));
  const orphan = 'job-orphan-test';
  writeFileSync(path.join(jobDir, `${orphan}.json`), JSON.stringify({
    id: orphan, pid: 1, total: 2, done: 1, state: 'running', results: [{ i: 1, label: 'x', ok: true, text: '' }],
  }));
  const s = await omegaBatchStatus({ id: orphan, waitMs: 2000 });
  assert.equal(s.isError, true);
  assert.match(s.text, /interrupted/);
  assert.match(readFileSync(path.join(jobDir, `${orphan}.json`), 'utf8'), /"running"/, 'reading must not rewrite the file');
}

// 5. omega_sqlite: reads work, writes are refused (guards the WRITE_RE constant).
{
  const { omegaSqlite } = await import('./tools-ext.mjs');
  const { spawnSync } = await import('node:child_process');
  const db = path.join(jobDir, 't.db');
  spawnSync('python3', ['-c', `import sqlite3; c=sqlite3.connect(${JSON.stringify(db)}); c.execute('create table t(x)'); c.execute('insert into t values (42)'); c.commit()`]);
  const read = await omegaSqlite({ db, sql: 'SELECT x FROM t' });
  assert.equal(read.isError, false, read.text);
  assert.match(read.text, /42/);
  const write = await omegaSqlite({ db, sql: 'DELETE FROM t' });
  assert.equal(write.isError, true);
  assert.match(write.text, /refused/);
}

// 6. Lean output: one call returns the verdict; success is one line,
//    failure shows exit code and the output tail (where errors are).
{
  const okr = await omegaBatch({ steps: [{ label: 'a', command_line: 'echo hi' }, { label: 'b', command_line: 'true' }] }, runProcess);
  assert.equal(okr.isError, false);
  assert.match(okr.text, /^batch job-\S+: success 2\/2 \([\d.]+s\): a \| b$/);
  const bad = await omegaBatch({ steps: [{ label: 'boom', command_line: 'seq 1 50; echo TAIL_ERR >&2; exit 3' }] }, runProcess);
  assert.equal(bad.isError, true);
  assert.match(bad.text, /exit=3/);
  assert.match(bad.text, /TAIL_ERR/);
  assert.ok(!/\n\s+1\n/.test(bad.text), 'head of long output must be dropped');
  assert.ok(bad.text.length < 700, `failure report must stay small, got ${bad.text.length}`);
  // cancel through omega_batch_status
  const id = await start({ steps: [{ label: 'long', command_line: 'sleep 30' }] });
  await new Promise((r) => setTimeout(r, 300));
  const c = await omegaBatchStatus({ id, cancel: true });
  assert.match(c.text, /cancelled/);
}

// 6b. Full-output refs sit right under the verdict line (hosts truncate the end
//     of a long result), for one-line, show and verbose verdicts alike.
{
  const ref = /^  full step 1: artifact:\/\/\S+ \(\d+ chars\)$/;
  const plain = await omegaBatch({ steps: [{ label: 'big', command_line: 'seq 1 3000' }] }, runProcess);
  assert.match(plain.text.split('\n')[1], ref, plain.text.slice(0, 300));
  const shown = await omegaBatch({ steps: [{ label: 'big', command_line: 'seq 1 3000', show: true }] }, runProcess);
  const sl = shown.text.split('\n');
  assert.match(sl[1], ref, shown.text.slice(0, 300));
  assert.match(sl[2], /^--- 1 big \(cut; full: artifact:\/\/\S+\) ---$/);
  const verbose = await omegaBatch({ steps: [{ label: 'big', command_line: 'seq 1 3000' }], verbose: true }, runProcess);
  assert.match(verbose.text.split('\n')[1], ref, verbose.text.slice(0, 300));
  const small = await omegaBatch({ steps: [{ label: 's', command_line: 'echo hi', show: true }] }, runProcess);
  assert.ok(!small.text.includes('full step'), small.text);
}

// 7. omega_edit: applied edits answer in a few lines; undo via the same tool.
{
  const { omegaEdit } = await import('./tools-ext.mjs');
  const f = path.join(jobDir, 'e.txt');
  writeFileSync(f, 'alpha\nbeta\n');
  const r = await omegaEdit({ edits: [{ path: f, oldString: 'alpha', newString: 'ALPHA' }, { path: f, oldString: 'beta', newString: 'BETA' }] });
  assert.equal(r.isError, false, r.text);
  assert.ok(r.text.split('\n').length <= 3 && !r.text.includes('---'), `edit summary must be short, got:\n${r.text}`);
  const u = await omegaEdit({ undo: r.data.batchId });
  assert.equal(u.isError, false, u.text);
  assert.equal(readFileSync(f, 'utf8'), 'alpha\nbeta\n');
}

// 8. Advertised surface stays small; omega_flow is opt-in.
{
  const { ALL_TOOLS, callTool } = await import('./server.mjs');
  const names = ALL_TOOLS.map((t) => t.name);
  assert.equal(names.length, 9, names.join(','));
  assert.ok(!names.includes('omega_flow'));
  const size = JSON.stringify(ALL_TOOLS).length;
  assert.ok(size < 7000, `schema budget: ${size} chars`);
  const id = await start({ steps: [{ command_line: 'seq 1 3000' }] });
  const j = await json(id);
  const tail = await callTool('artifact', { ref: j.results[0].artifact, lineCount: 2 });
  assert.match(tail.text, /2999: 2999\n3000: 3000/);
  const hit = await callTool('artifact', { ref: j.results[0].artifact, regex: '^1500$', context: 0 });
  assert.match(hit.text, /^1 match\(es\)[\s\S]*1500: 1500/);
}

// 9. Bridge to host background tasks: a separate process (bin/forge-wait.mjs)
//    blocks on a job owned by this process and exits with its verdict.
{
  const { spawn } = await import('node:child_process');
  const wait = (id) => new Promise((resolve) => {
    const p = spawn('node', [path.join(path.dirname(new URL(import.meta.url).pathname), 'bin/forge-wait.mjs'), id], { env: { ...process.env, OMEGA_JOB_DIR: jobDir } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
  const t0 = Date.now();
  const okId = await start({ steps: [{ label: 'slow', command_line: 'sleep 3; echo BRIDGE_OK', show: true }] });
  const ok = await wait(okId);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /success 1\/1[\s\S]*BRIDGE_OK/);
  assert.ok(Date.now() - t0 >= 2500, 'waiter must block until the job finishes, not read a running job as final');
  const badId = await start({ steps: [{ label: 'bad', command_line: 'echo BRIDGE_ERR >&2; exit 4' }] });
  const bad = await wait(badId);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /exit=4[\s\S]*BRIDGE_ERR/);
  assert.equal((await wait('job-does-not-exist')).code, 2);
}

console.log('batch-real: all passed');
process.exit(0);
