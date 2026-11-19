// Upgrades: edit near-miss hints, batch cleanup of background processes, atomic job files,
// and tool descriptions that state the configured wait cap.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.OMEGA_JOB_DIR = mkdtempSync(path.join(tmpdir(), 'omega-jobs-test-'));
process.env.OMEGA_ARTIFACT_DIR = mkdtempSync(path.join(tmpdir(), 'omega-art-test-'));
process.env.OMEGA_MAX_WAIT_MS = '600000';
const { runProcess } = await import('./server.mjs');
const ext = await import('./tools-ext.mjs');
const { omegaBatch, omegaBatchStatus, nearMiss, EXTRA_TOOLS } = ext;
const run = (args) => omegaBatch({ waitMs: 20000, ...args }, runProcess);

// 1. near-miss: indentation-only difference names the line and both indents
{
  const text = 'a\n  if (x) {\n    go();\n  }\n';
  const h = nearMiss(text, '   if (x) {\n    go();');
  assert.match(h, /ignoring whitespace at line 2/);
  assert.match(h, /indent: you have "   ", file has "  "/);
  // a real content difference names where it diverges
  const h2 = nearMiss(text, '  if (x) {\n    stop();');
  assert.match(h2, /diverges at line 3/);
  assert.match(h2, /go\(\)/);
  assert.match(nearMiss(text, 'nothing like it'), /not found anywhere/);
}

// 1b. the hint reaches the omega_edit error
{
  const dir = mkdtempSync(path.join(tmpdir(), 'omega-edit-test-'));
  writeFileSync(path.join(dir, 'f.js'), 'x\n        <span a />\n');
  const r = await ext.omegaEdit({ baseDir: dir, edits: [{ path: 'f.js', oldString: '         <span a />', newString: 'y' }] });
  assert.ok(r.isError);
  assert.match(r.text, /indent: you have "         ", file has "        "/);
}

// 2. cleanup:true kills a leftover background process; without it the process survives
{
  const mark = path.join(process.env.OMEGA_JOB_DIR, 'pid');
  const r = await run({ cleanup: true, steps: [{ label: 'srv', command_line: `(nohup sleep 300 >/dev/null 2>&1 & echo $! > ${mark}); echo STARTED`, expect: { contains: ['STARTED'] } }] });
  const pid = Number(readFileSync(mark, 'utf8'));
  await new Promise((r) => setTimeout(r, 300));
  let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'background sleep should be stopped');
  assert.match(r.text, /cleanup: stopped background processes of 1 step/);

  const r2 = await run({ steps: [{ label: 'srv', command_line: `(nohup sleep 300 >/dev/null 2>&1 & echo $! > ${mark}); echo STARTED` }] });
  const pid2 = Number(readFileSync(mark, 'utf8'));
  let alive2 = true; try { process.kill(pid2, 0); } catch { alive2 = false; }
  assert.equal(alive2, true, 'without cleanup the service keeps running');
  assert.doesNotMatch(r2.text, /cleanup/);
  process.kill(pid2, 'SIGKILL');
}

// 3. job files are written atomically (no .tmp left) and a half-written file reads as running
{
  assert.equal(readdirSync(process.env.OMEGA_JOB_DIR).filter((f) => f.endsWith('.tmp')).length, 0);
  const f = path.join(process.env.OMEGA_JOB_DIR, 'job-half.json');
  writeFileSync(f, '{"id":"job-half","state":"runn');
  const s = await omegaBatchStatus({ id: 'job-half' });
  assert.match(s.text, /running/);
}

// 4. descriptions carry the configured cap, not a hard-coded 50000
{
  const b = EXTRA_TOOLS.find((t) => t.name === 'omega_batch');
  const st = EXTRA_TOOLS.find((t) => t.name === 'omega_batch_status');
  assert.match(b.inputSchema.properties.waitMs.description, /max 600000/);
  assert.match(st.description, /600000/);
  assert.ok(b.inputSchema.properties.cleanup);
}
console.log('UPGRADE_V2_OK');
