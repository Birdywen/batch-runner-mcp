// Tool implementations for the forge MCP bridge: async omega_batch runner,
// read/grep/edit/undo/write/sqlite/health. server.mjs only does protocol and
// process spawning.

import { writeFileSync, mkdirSync, readFileSync, existsSync, statSync, copyFileSync, rmSync, renameSync, chmodSync, linkSync, readdirSync } from 'node:fs';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';
import { guardSteps } from './batch-guard.mjs';

// ---------- tool PATH (self-healing, runs before anything probes a binary) ----------
// Hosts may launch this server with a minimal PATH that lacks the Homebrew
// prefix, so `rg` would probe as absent. Fix it at module load so every binary
// probe in this file (rg, python3) sees the same PATH the batch shells get.
const TOOL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];
const pathSep = process.platform === 'win32' ? ';' : ':';
{
  const cur = (process.env.PATH || '').split(pathSep).filter(Boolean);
  const extra = TOOL_DIRS.filter((d) => !cur.includes(d));
  if (extra.length) process.env.PATH = [...extra, ...cur].join(pathSep);
}
// A caller-supplied PATH still wins: withToolPath() in server.mjs prepends the
// same dirs to the child env, and explicit `environment.PATH` overrides this.
export function toolPathExtras() { return TOOL_DIRS; }

// ---------- write snapshots (pre-write backup + rollback) ----------
// File-level undo net for omega_edit.
const SNAP_DIR = process.env.OMEGA_SNAP_DIR || '/tmp/omega-snaps';
const snapStats = new Map(); // batchId -> [{ path, snap, existed }]

function snapshotFile(abs, batchId) {
  mkdirSync(SNAP_DIR, { recursive: true });
  const sha = createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 16);
  const snap = path.join(SNAP_DIR, `${sha}.snap`);
  if (!existsSync(snap)) copyFileSync(abs, snap);
  const list = snapStats.get(batchId) || [];
  list.push({ path: abs, snap, existed: true });
  snapStats.set(batchId, list);
  return snap;
}

function snapshotMissing(abs, batchId) {
  mkdirSync(SNAP_DIR, { recursive: true });
  const sha = createHash('sha256').update(abs).digest('hex').slice(0, 16);
  const snap = path.join(SNAP_DIR, `absent-${sha}.snap`);
  if (!existsSync(snap)) writeFileSync(snap, '');
  const list = snapStats.get(batchId) || [];
  list.push({ path: abs, snap, existed: false });
  snapStats.set(batchId, list);
}

// Restoring a file that never existed means deleting what we created, not
// writing an empty file over it -- otherwise "undo" leaves litter behind.
function describe(entry) {
  return entry.existed ? `restored ${entry.path}` : `removed ${entry.path} (did not exist before)`;
}

function restoreOne(entry) {
  if (entry.existed) {
    mkdirSync(path.dirname(entry.path), { recursive: true });
    copyFileSync(entry.snap, entry.path);
    return `restored ${entry.path}`;
  }
  rmSync(entry.path, { force: true });
  return `removed ${entry.path} (did not exist before)`;
}

function persistSnapManifest(batchId, list) {
  mkdirSync(SNAP_DIR, { recursive: true });
  writeFileSync(path.join(SNAP_DIR, `${batchId}.json`), JSON.stringify(list, null, 1));
}

export function omegaUndo(args) {
  const batchId = args.batchId;
  if (!batchId) return { isError: true, text: 'batchId is required' };
  let list = snapStats.get(batchId);
  const f = path.join(SNAP_DIR, `${batchId}.json`);
  if (!list && existsSync(f)) list = JSON.parse(readFileSync(f, 'utf8'));
  if (!list || !list.length) return { isError: true, text: `no snapshot for batch: ${batchId}` };
  const dry = args.dryRun === true;
  if (args.paths) {
    const want = new Set((Array.isArray(args.paths) ? args.paths : [args.paths]).map((p) => path.resolve(p)));
    list = list.filter((e) => want.has(e.path));
    if (!list.length) return { isError: true, text: 'no snapshot entries match the given paths' };
  }
  const lines = list.map((e) => {
    if (dry) return `[dry] ${describe(e)}`;
    return restoreOne(e);
  });
  return {
    isError: false,
    text: `undo ${batchId}: ${list.length} file(s) ${dry ? 'WOULD BE RESTORED (DRY-RUN)' : 'restored'}\n${lines.join('\n')}`,
  };
}

// ---------- vfs_local_write ----------
// Exists so content with quotes, $, newlines or CJK never has to survive a shell
// quoting layer: write the file, then run it.
export function vfsLocalWrite(args) {
  if (!args.path) return { isError: true, text: 'path is required' };
  const sources = ['content', 'content_b64', 'content_file'].filter((key) => args[key] !== undefined);
  if (sources.length !== 1) {
    return { isError: true, text: `exactly one of content / content_b64 / content_file is required (received ${sources.length})` };
  }
  const abs = path.resolve(args.path);
  let body;
  try {
    if (sources[0] === 'content_b64') {
      const encoded = String(args.content_b64).replace(/\s/g, '');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        return { isError: true, text: 'content_b64 is not valid canonical base64' };
      }
      body = Buffer.from(encoded, 'base64');
    } else if (sources[0] === 'content_file') {
      body = readFileSync(path.resolve(args.content_file));
    } else {
      body = Buffer.from(String(args.content), 'utf8');
    }
  } catch (err) {
    return { isError: true, text: `content read failed: ${err.message}` };
  }

  const existed = existsSync(abs);
  if (args.requireMissing && existed) {
    return { isError: true, text: `refused: target already exists: ${abs}` };
  }
  let initial = null;
  if (existed) {
    try {
      const st = statSync(abs);
      if (!st.isFile()) return { isError: true, text: `target is not a file: ${abs}` };
      initial = {
        hash: createHash('sha256').update(readFileSync(abs)).digest('hex'),
        dev: st.dev,
        ino: st.ino,
        mode: st.mode & 0o777,
      };
    } catch (err) {
      return { isError: true, text: `target inspection failed: ${err.message}` };
    }
  }
  if (args.expectedSha256 !== undefined) {
    const expected = String(args.expectedSha256).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected)) return { isError: true, text: 'expectedSha256 must be a 64-character hexadecimal digest' };
    if (!initial || initial.hash !== expected) {
      return { isError: true, text: `expectedSha256 mismatch: expected ${expected}, found ${initial ? initial.hash : '(missing file)'}` };
    }
  }

  mkdirSync(path.dirname(abs), { recursive: true });
  if (args.append) {
    // Retain append(2) semantics rather than pretending a read-concatenate-rename
    // cycle is safe in the presence of other appenders.
    try {
      writeFileSync(abs, body, { flag: args.requireMissing ? 'ax' : 'a' });
      return { isError: false, text: `appended: ${abs} (${body.length} bytes)` };
    } catch (err) {
      return { isError: true, text: `append failed: ${err.message}` };
    }
  }

  const temp = path.join(path.dirname(abs), `.${path.basename(abs)}.omega-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, body, initial ? { mode: initial.mode } : undefined);
    if (initial) chmodSync(temp, initial.mode);
    if (args.requireMissing && existsSync(abs)) throw new Error('target appeared while content was staged');
    if (initial && args.expectedSha256 !== undefined) {
      const st = statSync(abs);
      const hash = createHash('sha256').update(readFileSync(abs)).digest('hex');
      if (st.dev !== initial.dev || st.ino !== initial.ino || hash !== initial.hash) {
        throw new Error('target changed while content was staged');
      }
    }
    if (args.requireMissing) {
      // link(2) fails atomically with EEXIST, unlike rename which replaces.
      linkSync(temp, abs);
      rmSync(temp, { force: true });
    } else {
      renameSync(temp, abs);
    }
    const writtenHash = createHash('sha256').update(body).digest('hex');
    return { isError: false, text: `written atomically: ${abs} (${body.length} bytes, sha256 ${writtenHash})` };
  } catch (err) {
    try { rmSync(temp, { force: true }); } catch {}
    return { isError: true, text: `write failed, target not replaced: ${err.message}` };
  }
}

// ---------- omega_batch (async) ----------
// MCP tools/call is request/response, but a batch can run for minutes, so the
// call returns a job id immediately and progress is polled separately.
// Job state is written to JOB_DIR after every step, so a server restart leaves
// a readable record (reported as "interrupted") instead of "no such batch".
const jobs = new Map();
const activeKills = new Map(); // jobId -> kill() for the running step
const JOB_DIR = process.env.OMEGA_JOB_DIR || '/tmp/omega-jobs';
const STEP_INLINE = 4000;
const BATCH_WAIT_DEFAULT = 45000;
const FAIL_TAIL_LINES = 12;

// Failure view: the end of the output is where errors are, so show the tail.
function failTail(text) {
  const body = String(text || '')
    .replace(/^\[truncated\][\s\S]*?\n\n/, '')
    .replace(/^exit=\S+ signal=\S+ timedOut=\S+ chars=\d+\n?/m, '')
    .trimEnd();
  if (!body) return [];
  const ls = body.split('\n');
  const out = ls.length > FAIL_TAIL_LINES ? ['...', ...ls.slice(-FAIL_TAIL_LINES)] : ls;
  return out.map((l) => (l.length > 200 ? `${l.slice(0, 200)}...` : l));
}

function persistJob(job) {
  try {
    mkdirSync(JOB_DIR, { recursive: true });
    writeFileSync(path.join(JOB_DIR, `${job.id}.json`), JSON.stringify(job, null, 1));
  } catch { /* best effort */ }
}

function loadJob(id) {
  const live = jobs.get(id);
  if (live) return live;
  const f = path.join(JOB_DIR, `${id}.json`);
  if (!existsSync(f)) return null;
  const job = JSON.parse(readFileSync(f, 'utf8'));
  // A "running" job on disk that this process does not own was cut off by a
  // restart: it will never finish, so say so instead of polling forever.
  if (job.state === 'running') {
    job.state = 'interrupted';
    job.note = 'server restarted while this job was running; steps after the last recorded one did not complete';
  }
  return job;
}

function checkExpect(e, out) {
  const has = (s) => out.includes(s);
  const list = (v) => (Array.isArray(v) ? v : [v]);
  if (e.contains && !list(e.contains).every(has)) {
    return ['expectation', `expect.contains failed: ${list(e.contains).filter((s) => !has(s)).join(', ')}`];
  }
  if (e.notContains && list(e.notContains).some(has)) {
    return ['expectation', `expect.notContains hit: ${list(e.notContains).filter(has).join(', ')}`];
  }
  if (e.regex) {
    try {
      if (!new RegExp(e.regex, 'm').test(out)) return ['expectation', `expect.regex failed: ${e.regex}`];
    } catch (err) {
      return ['configuration', `expect.regex invalid: ${err.message}`];
    }
  }
  return null;
}

export function omegaBatch(args, runProcess) {
  // MCP calls are permission-checked under their own name, so a shell/edit deny
  // on the caller does not reach a batch step. Refuse content writes here.
  const objection = guardSteps(args && args.steps);
  if (objection) return { isError: true, text: objection };

  const steps = args.steps;
  if (!Array.isArray(steps) || !steps.length) {
    return Promise.resolve({ isError: true, text: 'steps must be a non-empty array' });
  }
  const id = `job-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const job = {
    id, pid: process.pid, total: steps.length, done: 0, started: new Date().toISOString(),
    state: 'running', results: [], stopOnError: args.stopOnError !== false,
    cancelRequested: false, current: null,
  };
  jobs.set(id, job);
  persistJob(job);

  (async () => {
    for (let i = 0; i < steps.length; i++) {
      if (job.cancelRequested) {
        job.state = 'cancelled';
        job.results.push({
          i: i + 1, label: '(cancelled)', ok: false, status: 'skipped',
          failureType: 'cancelled', note: 'cancel requested before this step', text: '', durationMs: 0,
        });
        break;
      }
      const step = steps[i];
      const label = step.label || step.command_line?.slice(0, 60) || `step${i + 1}`;
      const stepStarted = Date.now();
      job.current = { i: i + 1, label, startedAt: new Date(stepStarted).toISOString() };
      persistJob(job);
      try {
        const r = await runProcess({
          command_line: step.command_line,
          timeout: step.timeout,
          cwd: step.cwd,
          stdin: step.stdin,
          environment: step.env,
          inlineLimit: STEP_INLINE,
          onSpawn: (kill) => activeKills.set(id, kill),
        });
        activeKills.delete(id);
        // Assertions run on the FULL output, not the truncated preview: a
        // marker in the middle of a long log must still count.
        const full = r.full ?? r.text;
        let ok = !r.isError;
        let note = '';
        let failureType = ok ? null : 'process';
        if (job.cancelRequested && !ok) { failureType = 'cancelled'; note = 'killed by cancel'; }
        if (ok && step.expect) {
          const miss = checkExpect(step.expect, full);
          if (miss) { ok = false; [failureType, note] = miss; }
        }
        job.results.push({
          i: i + 1,
          label,
          ok,
          status: ok ? 'passed' : 'failed',
          failureType,
          note,
          text: r.text.slice(0, STEP_INLINE),
          artifact: r.artifactRef || null,
          durationMs: Date.now() - stepStarted,
          exitCode: r.exitCode ?? r.code ?? null,
          signal: r.signal ?? null,
          timedOut: r.timedOut === true,
        });
        job.done = i + 1;
        if (!ok && (job.stopOnError || job.cancelRequested)) {
          job.state = job.cancelRequested ? 'cancelled' : 'failed';
          if (i + 1 < steps.length) {
            job.results.push({
              i: i + 2, label: '(halted)', ok: false, status: 'skipped',
              failureType: 'halted', note: job.cancelRequested ? 'cancelled' : 'stopOnError', text: '', durationMs: 0,
            });
          }
          break;
        }
      } catch (e) {
        activeKills.delete(id);
        job.results.push({
          i: i + 1, label, ok: false, status: 'failed', failureType: 'internal',
          note: String(e.message), text: '', durationMs: Date.now() - stepStarted,
        });
        job.done = i + 1;
        if (job.stopOnError) { job.state = 'failed'; break; }
      }
      persistJob(job);
    }
    if (job.state === 'running') {
      job.state = job.results.every((r) => r.ok) ? 'success' : 'partial';
    }
    job.current = null;
    job.finished = new Date().toISOString();
    persistJob(job);
  })();

  // Default: wait for the verdict so one call does submit + result.
  const wait = args.waitMs === undefined ? BATCH_WAIT_DEFAULT : Math.min(50000, Math.max(0, Number(args.waitMs) || 0));
  if (wait) {
    return omegaBatchStatus({ id, waitMs: wait, format: args.format }).then((r) => ({ ...r, data: { jobId: id } }));
  }
  return Promise.resolve({
    isError: false,
    text: `batch started: ${id} (${steps.length} steps)`,
    data: { jobId: id },
  });
}

const FAILED_STATES = new Set(['failed', 'partial', 'cancelled', 'interrupted']);

export function omegaBatchStatus(args) {
  const id = args.id;
  if (args.cancel) {
    const c = omegaBatchCancel({ id });
    if (c.isError) return c;
    return omegaBatchStatus({ id, waitMs: Math.max(Number(args.waitMs) || 0, 5000), format: args.format });
  }
  // waitMs blocks so a caller gets the verdict in ONE call. Capped below the
  // usual 60s host MCP timeout so the reply is never lost.
  const waitMs = Math.min(50000, Math.max(0, Number(args.waitMs) || 0));
  const render = (job) => {
    if (!job) return null;
    const isError = FAILED_STATES.has(job.state);
    if (args.format === 'json') return { isError, text: JSON.stringify(job, null, 2) };
    const took = job.finished ? ` (${((Date.parse(job.finished) - Date.parse(job.started)) / 1000).toFixed(1)}s)` : '';
    const head = `batch ${job.id}: ${job.state} ${job.done}/${job.total}${took}`;
    // Success costs one line: the labels are enough to confirm what ran.
    if (job.state === 'success' && !args.verbose) {
      return { isError: false, text: `${head}: ${job.results.map((r) => r.label).join(' | ')}`.slice(0, 600) };
    }
    const lines = [head];
    if (job.note) lines.push(`  note: ${job.note}`);
    for (const r of job.results) {
      if (r.ok) { lines.push(`  [ok] ${r.i}. ${r.label}`); continue; }
      lines.push(`  [${r.status === 'skipped' ? '--' : 'FAIL'}] ${r.i}. ${r.label}${r.failureType ? ` (${r.failureType})` : ''}${r.note ? ` -- ${r.note}` : ''}`);
      if (r.status === 'skipped') continue;
      const meta = [`exit=${r.exitCode ?? '?'}`];
      if (r.signal) meta.push(`signal=${r.signal}`);
      if (r.timedOut) meta.push('timedOut');
      if (r.artifact) meta.push(`full: ${r.artifact}`);
      lines.push(`      ${meta.join(' ')}`);
      for (const l of failTail(r.text)) lines.push(`      ${l}`);
    }
    if (job.state === 'running' && job.current) {
      const secs = Math.round((Date.now() - Date.parse(job.current.startedAt)) / 1000);
      lines.push(`  [..] ${job.current.i}. ${job.current.label} (running ${secs}s)`);
      lines.push(`  wait more: omega_batch_status {"id":"${job.id}","waitMs":45000}`);
    }
    if (args.verbose) {
      for (const r of job.results) {
        lines.push(`--- step ${r.i} ${r.label} ---`, r.text.slice(0, 3000));
      }
    }
    return { isError, text: lines.join('\n') };
  };
  if (waitMs) {
    const started = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        const job = loadJob(id);
        if (!job || job.state !== 'running' || Date.now() - started >= waitMs) {
          resolve(render(job) || { isError: true, text: `no such batch: ${id}` });
          return;
        }
        setTimeout(tick, 300);
      };
      tick();
    });
  }
  const job = loadJob(id);
  if (!job) return { isError: true, text: `no such batch: ${id}` };
  return render(job);
}

export function omegaBatchCancel(args) {
  const id = args.id;
  if (!id) return { isError: true, text: 'id is required' };
  const job = jobs.get(id);
  if (!job) {
    const saved = loadJob(id);
    if (saved) return { isError: true, text: `batch ${id} is already ${saved.state}; only a running job can be cancelled` };
    return { isError: true, text: `no such batch: ${id}` };
  }
  if (job.state !== 'running') return { isError: true, text: `batch ${id} is already ${job.state}` };
  job.cancelRequested = true;
  job.cancelRequestedAt = new Date().toISOString();
  persistJob(job);
  const kill = activeKills.get(id);
  if (kill) kill();
  return {
    isError: false,
    text: `cancellation requested for ${id}; ${kill ? 'the running step was sent SIGTERM (SIGKILL after 2s)' : 'no step is running'}, and no later step will start`,
  };
}

// ---------- omega_read (many files, one call) ----------
// Builtin Read does one file per call, so a 9-file recon costs 9 round trips.
// This packs N files -- each optionally sliced by line range and/or filtered by
// a regex -- into a single capped response. Pure fs, no shell quoting involved.
const READ_DEFAULT_LINES = 120;
const READ_MAX_LINES = 500;
const READ_DEFAULT_MATCHES = 30;
const READ_TOTAL_CAP = 20000;

function boundedInt(value, fallback, min, max) {
  const n = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback;
  return Math.min(max, Math.max(min, n));
}

// A dependency-free declaration outline, deliberately narrower than an AST.
// It reports only high-confidence, single-line declarations and labels the
// result heuristic so callers do not mistake it for semantic language data.
function sourceOutline(file, lines, max, symbol) {
  const ext = path.extname(file).toLowerCase();
  const common = [
    ['class', /^\s*(?:(?:export|public|private|protected|abstract|sealed|final|static)\s+)*(?:class|record)\s+([A-Za-z_$][\w$]*)/],
    ['interface', /^\s*(?:(?:export|public|private|protected)\s+)*interface\s+([A-Za-z_$][\w$]*)/],
    ['enum', /^\s*(?:(?:export|public|private|protected)\s+)*enum\s+([A-Za-z_$][\w$]*)/],
  ];
  let patterns = common;
  if (['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'].includes(ext)) {
    patterns = [
      ['function', /^\s*(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/],
      ['type', /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/],
      ['namespace', /^\s*(?:export\s+)?(?:namespace|module)\s+([A-Za-z_$][\w$]*)/],
      ['function', /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/],
      ...common,
    ];
  } else if (ext === '.py') {
    patterns = [
      ['function', /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/],
      ['class', /^\s*class\s+([A-Za-z_]\w*)/],
    ];
  } else if (ext === '.go') {
    patterns = [
      ['function', /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/],
      ['type', /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/],
    ];
  } else if (ext === '.rs') {
    patterns = [
      ['function', /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/],
      ['struct', /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/],
      ['enum', /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/],
      ['trait', /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/],
    ];
  } else if (ext === '.rb') {
    patterns = [
      ['function', /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/],
      ['class', /^\s*class\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)/],
      ['module', /^\s*module\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)/],
    ];
  } else if (ext === '.php') {
    patterns = [
      ['function', /^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+([A-Za-z_]\w*)/],
      ['trait', /^\s*(?:final\s+|abstract\s+)?trait\s+([A-Za-z_]\w*)/],
      ...common,
    ];
  }
  const found = [];
  for (let i = 0; i < lines.length && found.length < max; i++) {
    for (const [kind, re] of patterns) {
      const match = re.exec(lines[i]);
      if (!match || (symbol && match[1] !== symbol)) continue;
      found.push({ line: i + 1, kind, name: match[1], source: lines[i].trim() });
      break;
    }
  }
  return found;
}

export function omegaRead(args) {
  const list = Array.isArray(args.files) ? args.files
    : (args.path ? [{ path: args.path }] : null);
  if (!list || !list.length) {
    return { isError: true, text: 'files must be a non-empty array of {path, startLine?, lineCount?, pattern?, maxMatches?, contextBefore?, contextAfter?} (a plain path string also works)' };
  }
  // Relative paths resolve against baseDir, NOT the MCP server's own cwd: the
  // server is launched once with a fixed cwd while sessions come and go, so a
  // bare relative path silently resolved against the wrong root.
  const baseDir = path.resolve(
    args.baseDir || process.env.OMEGA_READ_BASE || process.cwd(),
  );
  const relMisses = [];
  const out = [];
  let total = 0;
  let okCount = 0;
  for (const item of list) {
    const spec = typeof item === 'string' ? { path: item } : (item || {});
    const p = spec.path;
    if (!p) { out.push('--- (spec without path, skipped) ---'); continue; }
    if (total >= READ_TOTAL_CAP) { out.push(`--- ${p} NOT READ: total cap ${READ_TOTAL_CAP} chars reached, narrow with startLine/lineCount/pattern ---`); continue; }
    const abs = path.isAbsolute(p) ? p : path.resolve(baseDir, p);
    if (!existsSync(abs)) {
      const why = path.isAbsolute(p)
        ? `${p} NOT FOUND`
        : `${p} NOT FOUND (relative to baseDir ${baseDir} -> ${abs}; pass an absolute path or set baseDir)`;
      if (!path.isAbsolute(p)) relMisses.push(p);
      out.push(`--- ${why} ---`);
      continue;
    }
    let st;
    try { st = statSync(abs); } catch (e) { out.push(`--- ${p} STAT FAILED: ${e.message} ---`); continue; }
    if (!st.isFile()) { out.push(`--- ${p} NOT A FILE ---`); continue; }
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch (e) { out.push(`--- ${p} READ FAILED: ${e.message} ---`); continue; }
    if (text.includes('\0')) { out.push(`--- ${p} BINARY (${st.size} bytes, skipped) ---`); continue; }
    const lines = text.split('\n');
    const remain = READ_TOTAL_CAP - total;
    let chunk;
    if ((spec.outline || spec.symbol) && spec.pattern) {
      out.push(`--- ${p} INVALID SPEC: pattern cannot be combined with outline/symbol ---`);
      continue;
    }
    if (spec.outline || spec.symbol) {
      const max = boundedInt(spec.maxSymbols, 100, 1, 300);
      const maxLineLength = boundedInt(spec.maxLineLength, 500, 1, 2000);
      const symbols = sourceOutline(p, lines, max, spec.symbol);
      const body = symbols.map((s) => `${s.line}: ${s.kind} ${s.name} | ${s.source.slice(0, maxLineLength)}`).join('\n');
      chunk = `=== ${p} heuristic outline${spec.symbol ? ` symbol=${spec.symbol}` : ''}: ${symbols.length} declaration(s) of ${lines.length} lines ===\n${body || '(no declarations found)'}`;
    } else if (spec.pattern) {
      let re;
      try { re = new RegExp(spec.pattern, 'im'); } catch (e) { out.push(`--- ${p} BAD PATTERN: ${e.message} ---`); continue; }
      const max = boundedInt(spec.maxMatches, READ_DEFAULT_MATCHES, 1, 100);
      const before = boundedInt(spec.contextBefore, 0, 0, 20);
      const after = boundedInt(spec.contextAfter, 0, 0, 20);
      const maxLineLength = boundedInt(spec.maxLineLength, 500, 1, 2000);
      const hitLines = [];
      for (let i = 0; i < lines.length && hitLines.length < max; i++) {
        if (re.test(lines[i])) hitLines.push(i);
      }
      let body;
      if (!before && !after) {
        body = hitLines.map((i) => `${i + 1}: ${lines[i].slice(0, maxLineLength)}`).join('\n');
      } else {
        const ranges = [];
        for (const i of hitLines) {
          const start = Math.max(0, i - before);
          const end = Math.min(lines.length - 1, i + after);
          const last = ranges[ranges.length - 1];
          if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
          else ranges.push({ start, end });
        }
        body = ranges.map(({ start, end }) => {
          const numbered = [];
          for (let i = start; i <= end; i++) numbered.push(`${i + 1}: ${lines[i].slice(0, maxLineLength)}`);
          return `--- lines ${start + 1}..${end + 1} ---\n${numbered.join('\n')}`;
        }).join('\n--\n');
      }
      const context = before || after ? ` context=-${before}/+${after}` : '';
      chunk = `=== ${p} pattern=/${spec.pattern}/ ${hitLines.length} match(es) of ${lines.length} lines${context} ===\n${body}`;
    } else {
      const start = Math.max((spec.startLine || 1) - 1, 0);
      const count = Math.min(spec.lineCount || READ_DEFAULT_LINES, READ_MAX_LINES);
      const slice = lines.slice(start, start + count);
      chunk = `=== ${p} lines ${start + 1}..${start + slice.length} of ${lines.length} ===\n${slice.join('\n')}`;
    }
    chunk = chunk.slice(0, remain);
    out.push(chunk);
    total += chunk.length;
    okCount++;
  }
  if (okCount === 0 && relMisses.length) {
    out.push(`\nHINT: ${relMisses.length} relative path(s) missed against baseDir ${baseDir}. `
      + 'The MCP server cwd is NOT the session directory. Retry with absolute paths, '
      + 'or pass baseDir=<the project dir> / set OMEGA_READ_BASE.');
  }
  return { isError: okCount === 0, text: `omega_read: ${okCount}/${list.length} file(s), ${total} chars (cap ${READ_TOTAL_CAP}${okCount ? `, base ${baseDir}` : ''})\n\n${out.join('\n\n')}` };
}

// ---------- omega_grep (server-side search) ----------
// Recon currently costs a subagent plus one omega_read per file. A capped
// path:line search answers "where is X" in one call without touching context.
// ripgrep when present, grep -rn fallback (some hosts have no rg). Read-only.
const GREP_MAX_MATCHES = 100;
const GREP_TOTAL_CAP = 8000;
const GREP_CAPTURE_CAP = 250000;

// `dir` and `include` are the parameter names, but callers reach for the builtin
// grep/read names instead -- passing `path` here used to be silently ignored, so
// the search ran against baseDir (the server cwd) and returned a confident,
// completely unrelated result set. A wrong-but-plausible answer is worse than
// an error, so name the near-misses and refuse instead of guessing.
const GREP_ALIASES = { path: 'dir', file: 'include', glob: 'include' };

export function omegaGrep(args, opts = {}) {
  const pattern = args.pattern;
  if (!pattern) return Promise.resolve({ isError: true, text: 'pattern is required' });
  const wrong = Object.keys(GREP_ALIASES).filter((k) => args[k] !== undefined);
  if (wrong.length) {
    return Promise.resolve({
      isError: true,
      text: `unknown parameter(s) for omega_grep: ${wrong.join(', ')}. `
        + wrong.map((k) => `"${k}" -> use "${GREP_ALIASES[k]}"`).join('; ')
        + '. omega_grep searches with `dir` (directory to search) and `include` (glob filter); '
        + 'refusing rather than silently searching the wrong place.',
    });
  }
  const baseDir = path.resolve(args.baseDir || process.env.OMEGA_READ_BASE || process.cwd());
  const dir = path.isAbsolute(args.dir || '') ? args.dir : path.resolve(baseDir, args.dir || '.');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return Promise.resolve({ isError: true, text: `dir not found or not a directory: ${dir} (baseDir ${baseDir})` });
  }
  const max = boundedInt(args.maxMatches, 30, 1, GREP_MAX_MATCHES);
  const before = boundedInt(args.contextBefore, 0, 0, 5);
  const after = boundedInt(args.contextAfter, 0, 0, 5);
  const maxLineLength = boundedInt(args.maxLineLength, 500, 1, 2000);
  const asList = (value) => value === undefined ? [] : (Array.isArray(value) ? value : [value]);
  const includes = asList(args.include).filter((v) => typeof v === 'string' && v);
  const excludes = asList(args.exclude).filter((v) => typeof v === 'string' && v);
  // 2026-10-01: searching $HOME failed two ways at once. TCC-protected trees
  // (Photos Library, Library/Caches, ...) made rg exit 2, and omegaGrep treated
  // any exit >=2 as a hard error -- so one unreadable subtree DISCARDED an
  // otherwise complete result set. Measured: the same search over $HOME did
  // not finish in 120s; with these excludes it returns in 0.05s.
  //
  // Two independent fixes, both needed. (1) Never walk the OS media/library
  // trees -- they hold no source and are the only TCC-blocked paths in practice.
  // (2) exit 2 must not discard results (see the close handler below): rg reports
  // "found matches AND hit unreadable dirs" as 2, which is a partial success, not
  // a failure. Default excludes alone would not have fixed a stray chmod 000 dir
  // inside a normal tree.
  //
  // Opt out with OMEGA_GREP_NO_DEFAULT_EXCLUDES=1 when a search really must
  // descend into those trees (e.g. auditing a Photos backup).
  const defaultExcludes = process.env.OMEGA_GREP_NO_DEFAULT_EXCLUDES === '1'
    ? []
    : ['Library/**', 'Pictures/**', 'Music/**', 'Movies/**', '.Trash/**'];
  return new Promise((resolve) => {
    let useRg = false;
    // OMEGA_FORCE_GREP=1 exercises the fallback on a host that has rg. The two
    // engines must answer identically, so being able to pin the slow path is
    // what makes that claim testable instead of a hope -- and it is the only way
    // to reproduce a Linux-side regex bug from macOS. `opts.forceGrep` is the
    // in-process form used by the parity test (env is read at spawn time only).
    const forceGrep = opts.forceGrep === true || process.env.OMEGA_FORCE_GREP === '1';
    if (!forceGrep) {
      try { execFileSync('rg', ['--version'], { stdio: 'ignore' }); useRg = true; } catch { /* fallback */ }
    }
    let cmd, cmdArgs;
    if (useRg) {
      cmdArgs = ['--line-number', '--no-heading', '--color=never', '-e', pattern];
      if (args.ignoreCase) cmdArgs.push('--ignore-case');
      if (args.literal) cmdArgs.push('--fixed-strings');
      if (args.word) cmdArgs.push('--word-regexp');
      if (before) cmdArgs.push('-B', String(before));
      if (after) cmdArgs.push('-A', String(after));
      for (const include of includes) cmdArgs.push('--glob', include);
      for (const exclude of excludes) cmdArgs.push('--glob', `!${exclude}`);
      for (const exclude of defaultExcludes) cmdArgs.push('--glob', `!${exclude}`);
      cmdArgs.push('--', dir);
      cmd = 'rg';
    } else {
      // -E is mandatory, not an optimization: the documented contract is "regex
      // (rg) / pattern (grep fallback)", and the tool description promises rg
      // semantics. Without -E, grep applies BRE, where `a|b` is a literal pipe:
      // the call returns "(no matches)" and exit 1 for a file that DOES contain
      // both alternatives. A silent wrong answer is worse than an error, so the
      // fallback must speak the same regex dialect as the primary path.
      //
      // Exactly ONE matcher flag, never both. GNU grep >= 3.7 treats `-E -F` as
      // "conflicting matchers specified" and exits 2, while BSD grep silently
      // lets the last one win. Passing both therefore made literal:true work on
      // macOS and fail on Linux, and
      // invisible to a Mac-only suite. -F already implies fixed strings, so
      // literal mode drops -E entirely; -w composes with either.
      cmdArgs = ['-rn', '-I'];
      if (args.literal) cmdArgs.push('-F');
      else cmdArgs.push('-E');
      if (args.ignoreCase) cmdArgs.push('-i');
      if (args.word) cmdArgs.push('-w');
      if (before) cmdArgs.push('-B', String(before));
      if (after) cmdArgs.push('-A', String(after));
      for (const include of includes) cmdArgs.push(`--include=${include}`);
      for (const exclude of defaultExcludes) {
        // grep has no `--exclude=X/**` form, so exclude the tree by its top
        // component name -- the same set rg skips via the glob above.
        const name = exclude.replace(/\/\*\*.*$/, '').split('/').filter(Boolean).pop();
        if (name) cmdArgs.push(`--exclude-dir=${name}`);
      }
      for (const exclude of excludes) {
        cmdArgs.push(`--exclude=${exclude}`);
        const dirPattern = exclude.replace(/\/\*\*.*$/, '').split('/').filter(Boolean).pop();
        if (dirPattern) cmdArgs.push(`--exclude-dir=${dirPattern}`);
      }
      cmdArgs.push('-e', pattern, '--', dir);
      cmd = 'grep';
    }
    const child = spawn(cmd, cmdArgs, { cwd: baseDir });
    if (process.env.OMEGA_GREP_TRACE === '1') {
      // Escape hatch for asserting on the exact argv across platforms. The
      // suite's output assertions cannot see this class of bug: BSD grep
      // tolerates a flag combination GNU grep rejects, so the same call passes
      // on macOS and fails on Linux. Dumping argv makes the difference
      // assertable in one place instead of re-discovered per host.
      process.stderr.write(`OMEGA_GREP_TRACE ${JSON.stringify([cmd, ...cmdArgs])}\n`);
    }
    let out = '';
    let err = '';
    let captureTruncated = false;
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.on('data', (d) => {
      const next = d.toString();
      const room = GREP_CAPTURE_CAP - out.length;
      if (room > 0) out += next.slice(0, room);
      if (next.length > room) captureTruncated = true;
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const t = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, 30000);
    child.on('close', (code, signal) => {
      clearTimeout(t);
      if (timedOut) {
        finish({ isError: true, text: `omega_grep timed out after 30000ms via ${cmd} in ${dir}` });
        return;
      }
      // Both rg and grep use 1 for a clean no-match result and 2+ for errors.
      // But 2 ALSO means "read what it could AND some paths were unreadable"
      // (rg: permission/TCC/symlink-loop; grep -rn: same). Throwing that away
      // loses real matches -- which is why a $HOME search used to return nothing
      // at all. Fixture-verified: rg exits 2 whether or not it matched anything.
      //
      // Exit 2 must therefore be classified, not blanket-treated as failure:
      //   - unreadable paths + (matches or none) -> report, do not error. The
      //     caller gets real results plus a PARTIAL label.
      //   - anything else, e.g. an invalid regex (also exit 2, also no output) ->
      //     stay a hard error, because "no matches" there would be a lie.
      // Keying on stderr rather than on output length is what keeps the second
      // case an error; keying on output length alone masked bad patterns.
      const producedOutput = out.trim().length > 0;
      const unreadablePaths = /permission denied|operation not permitted|too many levels of symbolic links|os error (1|13)\b/i.test(err);
      const partialWalk = code === 2 && (producedOutput || unreadablePaths);
      if (code !== 0 && code !== 1 && !partialWalk) {
        finish({
          isError: true,
          text: `omega_grep failed via ${cmd} (exit ${code}${signal ? `, signal ${signal}` : ''}) in ${dir}\n${err.slice(0, 1000) || '(no stderr)'}`,
        });
        return;
      }
      const all = out.split('\n').filter((l) => l.trim());
      const lines = [];
      let matches = 0;
      const availableMatches = all.filter((line) => /:\d+:/.test(line)).length;
      for (const line of all) {
        const isMatch = /:\d+:/.test(line);
        if (isMatch && matches >= max) break;
        if (isMatch) matches++;
        lines.push(line);
      }
      const text = lines.map((l) => l.slice(0, maxLineLength)).join('\n').slice(0, GREP_TOTAL_CAP);
      const truncated = captureTruncated || availableMatches > max || text.length >= GREP_TOTAL_CAP;
      const context = before || after ? `, context -B${before} -A${after}` : '';
      // Never let a partial walk pass for a complete one: say which paths were
      // skipped so the caller can narrow the search instead of trusting the cap.
      const partial = partialWalk
        ? ' [PARTIAL: some paths were unreadable (permissions/symlink loop) and were skipped'
          + `${defaultExcludes.length && process.env.OMEGA_GREP_NO_DEFAULT_EXCLUDES !== '1' ? `; skipped default trees: ${defaultExcludes.join(', ')}` : ''}]`
        : '';
      const summary = `omega_grep: ${matches} match(es)${truncated ? ' (truncated, narrow pattern/dir)' : ''}${context} via ${cmd} in ${dir}${partial}`;
      finish({ isError: false, text: `${summary}\n\n${text || '(no matches)'}` });
    });
    child.on('error', (e) => { clearTimeout(t); finish({ isError: true, text: e.message }); });
  });
}

// ---------- omega_health (mechanical self-check) ----------
// Turns "is my server fine?" into one call: syntax + hashes of the modules,
// writable scratch dirs, rg/python3 presence, node version.
// HEALTHY means serve-able; anything else lists exactly what is wrong.
export function omegaHealth() {
  const lines = [`node ${process.version} pid=${process.pid}`];
  let ok = true;
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const m of ['server.mjs', 'tools-ext.mjs', 'batch-guard.mjs', 'omega-flow.mjs', 'omega-flow-wait.mjs']) {
    const f = path.join(here, m);
    try {
      const buf = readFileSync(f);
      execFileSync(process.execPath, ['--check', f], { stdio: 'ignore' });
      lines.push(`  [ok] ${m} sha256=${createHash('sha256').update(buf).digest('hex').slice(0, 20)}`);
    } catch (e) { ok = false; lines.push(`  [FAIL] ${m} BROKEN: ${String((e && e.message) || e).split('\n')[0]}`); }
  }
  for (const [name, d] of [
    ['jobs', process.env.OMEGA_JOB_DIR || '/tmp/omega-jobs'],
    ['artifacts', process.env.OMEGA_ARTIFACT_DIR || path.join(homedir(), '.omega-mcp/artifacts')],
  ]) {
    try { mkdirSync(d, { recursive: true }); lines.push(`  [ok] ${name} dir writable: ${d}`); }
    catch (e) { ok = false; lines.push(`  [FAIL] ${name} dir NOT writable: ${d} (${e.message})`); }
  }
  let rg = false;
  try { execFileSync('rg', ['--version'], { stdio: 'ignore' }); rg = true; } catch { /* fallback */ }
  // Name the searched PATH and the dirs we would add: "absent" alone sent the
  // 2026-09-30 investigation down a wrong path (assumed rg uninstalled) when
  // the real cause was the server's minimal PATH.
  lines.push(`  [${rg ? 'ok' : '--'}] ripgrep: ${rg ? 'present (omega_grep full speed)'
    : `absent -> omega_grep uses the grep -E fallback (ERE, same dialect); searched PATH=${
      (process.env.PATH || '(unset)').split(pathSep).join(': ')}; add ${
      TOOL_DIRS.filter((d) => !(process.env.PATH || '').split(pathSep).includes(d)).join(', ') || '(already on PATH)'}`}`);
  let py = false;
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); py = true; } catch { /* optional */ }
  lines.push(`  [${py ? 'ok' : '--'}] python3: ${py ? 'present (omega_sqlite available)' : 'absent -> omega_sqlite unavailable'}`);
  lines.push(`  extras loaded: ${EXTRA_TOOLS.length} tool definitions`);
  lines.unshift(`health: ${ok ? 'HEALTHY' : 'DEGRADED'}`);
  return { isError: !ok, text: lines.join('\n') };
}

// ---------- omega_sqlite (any db, read-only, zero-dep) ----------
// Takes the db path as a parameter and runs on the python3 stdlib sqlite3
// module, so it works where no sqlite3 CLI exists. Three locks: a SELECT-only
// prefix check, PRAGMA query_only=ON inside the engine, and a read-only URI open.
const WRITE_RE = /^\s*(insert|update|delete|drop|alter|create|replace|truncate|vacuum|attach|detach|pragma\s+\w+\s*=)/i;
const SQLITE_MAX_ROWS = 200;
const SQLITE_TOTAL_CAP = 20000;

export function omegaSqlite(args) {
  let { db } = args;
  let sql = args.sql;
  if (args.sql_b64) sql = Buffer.from(args.sql_b64, 'base64').toString('utf8');
  if (!db) return Promise.resolve({ isError: true, text: 'db is required (path to a sqlite file, e.g. ~/.local/share/opencode/opencode.db)' });
  if (!sql) return Promise.resolve({ isError: true, text: 'sql or sql_b64 is required' });
  if (WRITE_RE.test(sql)) {
    return Promise.resolve({ isError: true, text: 'refused: SELECT / PRAGMA(question) / EXPLAIN / WITH only' });
  }
  if (String(db).startsWith('~/')) db = path.join(homedir(), String(db).slice(2));
  const abs = path.isAbsolute(db) ? db : path.resolve(args.baseDir || process.env.OMEGA_READ_BASE || process.cwd(), db);
  if (!existsSync(abs)) {
    return Promise.resolve({ isError: true, text: `db not found: ${abs}` });
  }
  const py = [
    'import json, sqlite3, sys',
    'db, sql = sys.argv[1], sys.argv[2]',
    "con = sqlite3.connect('file:' + db + '?mode=ro', uri=True)",
    "con.execute('PRAGMA query_only=ON')",
    'cur = con.execute(sql)',
    'cols = [d[0] for d in cur.description] if cur.description else []',
    `rows = cur.fetchmany(${SQLITE_MAX_ROWS})`,
    'print(json.dumps({"columns": cols, "rows": [dict(zip(cols, r)) for r in rows]}, ensure_ascii=False, default=str))',
  ].join('\n');
  return new Promise((resolve) => {
    const child = spawn('python3', ['-c', py, abs, sql], {});
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 30000);
    child.on('close', (code) => {
      clearTimeout(t);
      const text = (out || err || '(no output)').slice(0, SQLITE_TOTAL_CAP);
      resolve({ isError: code !== 0, text: code === 0 ? text : `exit=${code}\n${text}` });
    });
    child.on('error', (e) => { clearTimeout(t); resolve({ isError: true, text: `no python3 on this host: ${e.message}` }); });
  });
}

// ---------- omega_edit (two-phase batch edit) ----------
// The edit version of the omega philosophy: N file edits computed in memory,
// every assertion verified, and only then ALL files written. One failure --
// missing oldString, ambiguous multi-match, mustContain miss -- aborts the
// whole batch with NOTHING WRITTEN, and every problem is reported at once so
// no round is wasted. Returns a per-file diff so judgment stays with the
// caller. By prompt-level rule this is the primary model's tool; subagents
// never touch files.
const EDIT_MAX_FILE = 500000;
const EDIT_DIFF_CAP = 3000;
const EDIT_TOTAL_CAP = 20000;

function editHash(text) {
  return createHash('sha256').update(text).digest('hex');
}

function readUtf8Strict(abs) {
  const bytes = readFileSync(abs);
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const payload = bom ? bytes.subarray(3) : bytes;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    throw new Error('file is not valid UTF-8; byte-preserving edit refused');
  }
  return { bytes, text, bom };
}

function encodeUtf8(text, bom) {
  const payload = Buffer.from(text, 'utf8');
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), payload]) : payload;
}

function dominantLineEnding(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(^|[^\r])\n/g) || []).length;
  if (crlf && !lf) return '\r\n';
  if (lf && !crlf) return '\n';
  return null;
}

function normalizeLineEndings(text, eol) {
  return eol ? text.replace(/\r\n|\r|\n/g, eol) : text;
}

function miniDiff(oldText, newText, ctx = 3) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1, eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) { ea--; eb--; }
  if (s > ea && s > eb) return '(no line changes)';
  const lo = Math.max(0, s - ctx);
  const hiA = Math.min(a.length - 1, ea + ctx);
  const hiB = Math.min(b.length - 1, eb + ctx);
  const out = [`@@ lines ${lo + 1}..${hiA + 1} @@`];
  for (let i = lo; i <= hiA; i++) out.push(`${i >= s && i <= ea ? '- ' : '  '}${a[i].slice(0, 500)}`);
  out.push('---');
  for (let i = lo; i <= hiB; i++) out.push(`${i >= s && i <= eb ? '+ ' : '  '}${b[i].slice(0, 500)}`);
  return out.join('\n').slice(0, EDIT_DIFF_CAP);
}

// Hunk diff from known replacement spans (exact, no LCS needed):
// each span carries old/new text; context lines come from the final text.
function spanDiff(newText, spans, ctx = 3) {
  const lines = newText.split('\n');
  const starts = [0];
  for (let i = 0; i < newText.length; i++) if (newText[i] === '\n') starts.push(i + 1);
  const lineOf = (pos) => {
    let lo = 0, hi = starts.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (starts[m] <= pos) lo = m + 1; else hi = m; }
    return Math.max(0, lo - 1);
  };
  const ranges = spans.map((s) => {
    const endPos = s.len > 0 ? s.at + s.len - 1 : s.at;
    return {
      l0: Math.max(0, lineOf(s.at) - ctx),
      l1: Math.min(lines.length - 1, lineOf(endPos) + ctx),
      a0: lineOf(s.at), a1: lineOf(endPos),
      span: s,
    };
  }).sort((x, y) => x.l0 - y.l0 || x.a0 - y.a0);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.l0 <= last.l1 + 1) {
      last.l1 = Math.max(last.l1, r.l1);
      last.spans.push(r);
    } else merged.push({ l0: r.l0, l1: r.l1, spans: [r] });
  }
  const hunks = merged.map((h, hi) => {
    const byLine = new Map();
    for (const r of h.spans) for (let l = r.a0; l <= r.a1; l++) byLine.set(l, r.span);
    const out = [`@@ lines ${h.l0 + 1}..${h.l1 + 1} (hunk ${hi + 1}/${merged.length}) @@`];
    const emittedOld = new Set();
    for (let l = h.l0; l <= h.l1; l++) {
      const sp = byLine.get(l);
      if (sp && !emittedOld.has(sp)) {
        emittedOld.add(sp);
        for (const ol of sp.oldStr.split('\n')) out.push(`- ${ol.slice(0, 500)}`);
      }
      out.push(`${sp ? '+' : '  '}${(lines[l] ?? '').slice(0, 500)}`);
    }
    return out.join('\n');
  });
  let used = 0;
  const keptH = [];
  for (const hk of hunks) {
    if (used + hk.length > EDIT_DIFF_CAP && keptH.length) break;
    keptH.push(hk); used += hk.length;
  }
  if (keptH.length < hunks.length) keptH.push(`... (${hunks.length - keptH.length} more hunk(s) truncated, EDIT_DIFF_CAP=${EDIT_DIFF_CAP})`);
  return keptH.join('\n');
}

export function omegaEdit(args) {
  if (args && args.undo) return omegaUndo({ batchId: args.undo, paths: args.paths, dryRun: args.dryRun });
  const list = Array.isArray(args.edits) ? args.edits : null;
  if (!list || !list.length) {
    return { isError: true, text: 'edits must be a non-empty array of {path, oldString, newString, replaceAll?, mustContain?, mustNotContain?}' };
  }
  const baseDir = path.resolve(args.baseDir || process.env.OMEGA_READ_BASE || process.cwd());
  const dctx = Math.min(15, Math.max(0, args.diffCtx ?? 3)); // context lines per diff hunk
  const createIfMissing = args.createIfMissing === true;
  const pending = new Map(); // abs -> { path, abs, orig, text }: same-file edits chain in order
  const report = [];
  let failed = 0;
  let applied = 0;
  // One undo point per call, so a whole batch of edits can be rolled back together.
  const batchId = `edit-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  for (let i = 0; i < list.length; i++) {
    const tag = `#${i + 1}`;
    const e = list[i] || {};
    const fail = (why) => { failed++; report.push(`[FAIL] ${tag} ${e.path || '(no path)'}: ${why}`); };
    if (!e.path || typeof e.oldString !== 'string' || typeof e.newString !== 'string') {
      fail('path/oldString/newString are all required'); continue;
    }
    if (e.oldString === e.newString) { fail('oldString and newString are identical (no-op)'); continue; }
    const abs = path.isAbsolute(e.path) ? e.path : path.resolve(baseDir, e.path);
    const fileExists = existsSync(abs);
    // An empty oldString is legal ONLY as the seed for a file that does not exist
    // yet. On an existing file it would match at every position, so the ambiguity
    // check below would reject it anyway -- say so here instead. This ordering
    // matters: an earlier blanket `if (!e.oldString)` guard made createIfMissing
    // unreachable, which is exactly the bug the regression suite caught.
    if (!e.oldString && fileExists) {
      fail('oldString is empty, which on an existing file matches everywhere; '
        + 'empty oldString is only accepted to create a missing file (createIfMissing:true)');
      continue;
    }
    if (!fileExists && !createIfMissing) {
      fail(`file not found: ${abs} (pass createIfMissing:true to scaffold a new file in the same two-phase commit)`);
      continue;
    }
    let entry = pending.get(abs);
    if (!entry) {
      let disk;
      let bom = false;
      let originalBytes = null;
      let originalIdentity = null;
      const isNew = !fileExists;
      if (isNew) {
        if (e.oldString !== '') {
          fail('file not found and oldString is not the empty string; a new file must start from oldString:""');
          continue;
        }
        disk = '';
      } else {
        try {
          const st = statSync(abs);
          if (!st.isFile()) { fail('not a file'); continue; }
          if (st.size > EDIT_MAX_FILE) { fail(`file too large (${st.size} bytes, cap ${EDIT_MAX_FILE})`); continue; }
          const decoded = readUtf8Strict(abs);
          disk = decoded.text;
          bom = decoded.bom;
          originalBytes = decoded.bytes;
          originalIdentity = { dev: st.dev, ino: st.ino };
        } catch (err) { fail(`read failed: ${err.message}`); continue; }
        if (disk.includes('\0')) { fail('binary file, refused'); continue; }
      }
      entry = {
        path: e.path,
        abs,
        orig: disk,
        text: disk,
        isNew,
        bom,
        eol: dominantLineEnding(disk),
        originalHash: isNew ? null : editHash(originalBytes),
        originalIdentity,
        originalMode: isNew ? null : statSync(abs).mode & 0o777,
        finalChecks: [],
      };
      pending.set(abs, entry);
    }
    if (e.expectedSha256 !== undefined) {
      if (!/^[a-f0-9]{64}$/i.test(e.expectedSha256)) {
        fail('expectedSha256 must be a 64-character hexadecimal SHA-256 digest'); continue;
      }
      if (entry.isNew) {
        fail('expectedSha256 cannot be used for a file that does not exist'); continue;
      }
      if (entry.originalHash !== e.expectedSha256.toLowerCase()) {
        fail(`expectedSha256 mismatch: expected ${e.expectedSha256.toLowerCase()}, found ${entry.originalHash}`); continue;
      }
    }
    const text = entry.text;
    const newString = args.preserveLineEndings === false ? e.newString : normalizeLineEndings(e.newString, entry.eol);
    if (e.oldString === newString) { fail('oldString and normalized newString are identical (no-op)'); continue; }
    const hits = text.split(e.oldString).length - 1;
    if (hits === 0) { fail('oldString not found (0 matches)'); continue; }
    if (hits > 1 && !e.replaceAll) { fail(`oldString matches ${hits} times, refusing to guess (pass replaceAll:true to replace every occurrence)`); continue; }
    const at = text.indexOf(e.oldString);
    // Overlap guard (same-file chaining): warn when this match lands inside a
    // region written by an earlier edit in this batch — usually a duplicated
    // oldString or a stale copy. Spans are tracked in evolving-text coordinates.
    const spans = entry.spans || (entry.spans = []);
    const matchEnd = at + e.oldString.length;
    const overlapped = spans.filter((s) => at < s.at + s.len && s.at < matchEnd);
    if (overlapped.length && !e.allowOverlap) {
      report.push(`[warn] ${tag} ${e.path}: oldString overlaps region written by ${overlapped.map((s) => s.tag).join(', ')} — chained anyway, verify intent (pass allowOverlap:true to silence)`);
    }
    const next = e.replaceAll ? text.split(e.oldString).join(newString)
      : text.slice(0, at) + newString + text.slice(at + e.oldString.length);
    const need = (v) => (Array.isArray(v) ? v : [v]);
    const missContain = e.mustContain !== undefined ? need(e.mustContain).filter((x) => !next.includes(x)) : [];
    if (missContain.length) { fail(`mustContain miss: ${missContain.join(', ')}`); continue; }
    const hitBan = e.mustNotContain !== undefined ? need(e.mustNotContain).filter((x) => next.includes(x)) : [];
    if (hitBan.length) { fail(`mustNotContain hit: ${hitBan.join(', ')}`); continue; }
    let mustMatch = [];
    let mustNotMatch = [];
    try {
      mustMatch = e.mustMatch !== undefined ? need(e.mustMatch).map((x) => new RegExp(x, 'm')) : [];
      mustNotMatch = e.mustNotMatch !== undefined ? need(e.mustNotMatch).map((x) => new RegExp(x, 'm')) : [];
    } catch (err) { fail(`invalid assertion regex: ${err.message}`); continue; }
    const missMatch = mustMatch.filter((re) => !re.test(next));
    if (missMatch.length) { fail(`mustMatch miss: ${missMatch.map(String).join(', ')}`); continue; }
    const hitMatch = mustNotMatch.filter((re) => re.test(next));
    if (hitMatch.length) { fail(`mustNotMatch hit: ${hitMatch.map(String).join(', ')}`); continue; }
    entry.text = next;
    entry.finalChecks.push({
      tag,
      mustContain: e.mustContain !== undefined ? need(e.mustContain) : [],
      mustNotContain: e.mustNotContain !== undefined ? need(e.mustNotContain) : [],
      mustMatch,
      mustNotMatch,
    });
    // Map pre-existing spans through this replacement (points ascending);
    // drop spans overlapping a replaced region. New spans carry both sides for hunk diffs.
    const oldLen = e.oldString.length, newLen = newString.length;
    let points;
    if (e.replaceAll) {
      points = [];
      let mi = text.indexOf(e.oldString);
      while (mi !== -1) { points.push(mi); mi = text.indexOf(e.oldString, mi + oldLen); }
    } else points = [at];
    const kept = [];
    for (const s of spans) {
      let shift = 0, dead = false;
      for (const p of points) {
        if (s.at + s.len <= p) break;
        if (s.at >= p + oldLen) shift += newLen - oldLen;
        else { dead = true; break; }
      }
      if (!dead) { s.at += shift; kept.push(s); }
    }
    if (e.replaceAll) {
      const parts = text.split(e.oldString);
      let npos = 0;
      for (let k = 0; k < parts.length - 1; k++) {
        npos += parts[k].length;
        kept.push({ at: npos, len: newLen, oldStr: e.oldString, newStr: newString, tag });
        npos += newLen;
      }
    } else kept.push({ at, len: newLen, oldStr: e.oldString, newStr: newString, tag });
    entry.spans = kept;
    applied++;
    report.push(`[ok] ${tag} ${e.path} (${e.replaceAll ? `${hits} replacements` : '1 replacement'})`);
  }
  // Re-run every assertion against the final chained text. A later edit cannot
  // silently invalidate a guarantee established by an earlier edit.
  for (const entry of pending.values()) {
    for (const check of entry.finalChecks) {
      const reasons = [];
      const missing = check.mustContain.filter((x) => !entry.text.includes(x));
      const banned = check.mustNotContain.filter((x) => entry.text.includes(x));
      const missingRe = check.mustMatch.filter((re) => !re.test(entry.text));
      const bannedRe = check.mustNotMatch.filter((re) => re.test(entry.text));
      if (missing.length) reasons.push(`mustContain miss: ${missing.join(', ')}`);
      if (banned.length) reasons.push(`mustNotContain hit: ${banned.join(', ')}`);
      if (missingRe.length) reasons.push(`mustMatch miss: ${missingRe.map(String).join(', ')}`);
      if (bannedRe.length) reasons.push(`mustNotMatch hit: ${bannedRe.map(String).join(', ')}`);
      if (reasons.length) {
        failed++;
        report.push(`[FAIL] ${check.tag} ${entry.path}: final assertion failed after chained edits: ${reasons.join('; ')}`);
      }
    }
    const outputBytes = encodeUtf8(entry.text, entry.bom).length;
    if (outputBytes > EDIT_MAX_FILE) {
      failed++;
      report.push(`[FAIL] ${entry.path}: output too large (${outputBytes} bytes, cap ${EDIT_MAX_FILE})`);
    }
  }
  if (failed) {
    // The per-edit [ok] lines below are VOID: two-phase commit means the whole
    // batch was discarded. Printing them as plain [ok] invited reading them as
    // "some edits landed", which is how a lost schema edit went unnoticed for
    // several turns. Say it in the same line the reader already looks at.
    const voided = report.map((r) => r.replace(/^\[ok\]/, '[void]'));
    return { isError: true, text: `edit: FAILED ${applied}/${list.length}, NOTHING WRITTEN (two-phase commit) -- every [void] line below was NOT applied\n${voided.join('\n')}` };
  }
  const dry = args.dryRun === true;
  if (!dry) {
    // Re-read every target immediately before the first write. The edit planning
    // phase is synchronous but another process can still replace a file between
    // the initial read and commit; in that case the whole batch must fail closed.
    const stale = [];
    for (const entry of pending.values()) {
      if (entry.isNew) {
        if (existsSync(entry.abs)) stale.push(`${entry.path}: appeared after planning`);
        continue;
      }
      try {
        const currentStat = statSync(entry.abs);
        if (!currentStat.isFile()
          || currentStat.dev !== entry.originalIdentity.dev
          || currentStat.ino !== entry.originalIdentity.ino) {
          stale.push(`${entry.path}: file identity changed after planning`);
          continue;
        }
        const current = readFileSync(entry.abs);
        const currentHash = editHash(current);
        if (currentHash !== entry.originalHash) {
          stale.push(`${entry.path}: changed after planning (expected sha256 ${entry.originalHash}, found ${currentHash})`);
        }
      } catch (err) {
        stale.push(`${entry.path}: unavailable after planning (${err.message})`);
      }
    }
    if (stale.length) {
      const voided = report.map((r) => r.replace(/^\[ok\]/, '[void]'));
      const failures = stale.map((s) => `[FAIL] ${s}`);
      return {
        isError: true,
        text: `edit: FAILED ${applied}/${list.length}, NOTHING WRITTEN (stale-file protection) -- every [void] line below was NOT applied\n${[...voided, ...failures].join('\n')}`,
      };
    }
    // Stage every output before touching originals. rename is atomic per file;
    // the manifest is durable before the first rename so crashes remain undoable.
    const staged = [];
    try {
      for (const entry of pending.values()) {
        const bytes = encodeUtf8(entry.text, entry.bom);
        if (bytes.length > EDIT_MAX_FILE) throw new Error(`${entry.path}: output too large (${bytes.length} bytes, cap ${EDIT_MAX_FILE})`);
        mkdirSync(path.dirname(entry.abs), { recursive: true });
        const temp = path.join(path.dirname(entry.abs), `.${path.basename(entry.abs)}.omega-${batchId}-${staged.length}.tmp`);
        writeFileSync(temp, bytes, entry.originalMode === null ? undefined : { mode: entry.originalMode });
        if (entry.originalMode !== null) chmodSync(temp, entry.originalMode);
        staged.push({ entry, temp });
      }
    } catch (err) {
      for (const item of staged) try { rmSync(item.temp, { force: true }); } catch {}
      return { isError: true, text: `edit: FAILED ${applied}/${list.length}, NOTHING WRITTEN (staging failed): ${err.message}` };
    }
    try {
      for (const { entry } of staged) {
        if (entry.isNew) snapshotMissing(entry.abs, batchId);
        else snapshotFile(entry.abs, batchId);
      }
      persistSnapManifest(batchId, snapStats.get(batchId) || []);
    } catch (err) {
      for (const item of staged) try { rmSync(item.temp, { force: true }); } catch {}
      snapStats.delete(batchId);
      return { isError: true, text: `edit: FAILED ${applied}/${list.length}, NOTHING WRITTEN (snapshot failed): ${err.message}` };
    }
    const landed = [];
    try {
      for (const item of staged) {
        renameSync(item.temp, item.entry.abs);
        landed.push(item.entry.path);
      }
    } catch (err) {
      const rollbackErrors = [];
      for (const snap of (snapStats.get(batchId) || []).slice(0, landed.length)) {
        try { restoreOne(snap); } catch (rollbackErr) { rollbackErrors.push(`${snap.path}: ${rollbackErr.message}`); }
      }
      for (const item of staged) try { rmSync(item.temp, { force: true }); } catch {}
      return {
        isError: true,
        text: `edit: COMMIT FAILED after ${landed.length}/${staged.length} file(s); snapshots restored${rollbackErrors.length ? `; rollback errors: ${rollbackErrors.join('; ')}` : ''}: ${err.message}`,
      };
    }
  }
  const data = { batchId: dry ? null : batchId, dryRun: dry, applied };
  // Applied edits answer in a few lines: per-file counts, warnings, undo id.
  // Diffs are for previews (dryRun) or when asked for (diff:true).
  if (!dry && !args.diff) {
    const perFile = [...pending.values()].map((s) => {
      const n = report.filter((l) => l.startsWith('[ok]') && l.includes(` ${s.path} `)).length;
      return `  ${s.path}${n > 1 ? ` x${n}` : ''}`;
    });
    const warns = report.filter((l) => !l.startsWith('[ok]'));
    return { isError: false, text: [`edit: ${applied}/${list.length} applied, undo ${batchId}`, ...perFile, ...warns].join('\n').slice(0, EDIT_TOTAL_CAP), data };
  }
  if (!dry) report.push(`undo: omega_edit {"undo":"${batchId}"}`);
  const diffs = [...pending.values()].map((s) => `--- ${s.path} ---\n${s.spans && s.spans.length ? spanDiff(s.text, s.spans, dctx) : miniDiff(s.orig, s.text, dctx)}`);
  return { isError: false, text: `edit: ${applied}/${list.length} ${dry ? 'verified (DRY-RUN, NOTHING WRITTEN)' : 'applied'}\n${report.join('\n')}\n\n${diffs.join('\n\n')}`.slice(0, EDIT_TOTAL_CAP), data };
}

// Tool schemas. Every session pays for these in context, so descriptions stay
// terse: say what is non-obvious, skip what the property name already says.
const S = { type: 'string' };
const B = { type: 'boolean' };
const I = { type: 'integer' };
const SA = { type: 'array', items: S };
const d = (schema, description) => ({ ...schema, description });

export const EXTRA_TOOLS = [
  {
    name: 'omega_batch',
    description: 'Run bash steps in sequence; each may assert on its output (expect), so exit=0 is not taken as success. '
      + 'Waits up to waitMs (default 45000) and returns the verdict in this call; if still running, returns the job id for omega_batch_status. '
      + 'Success is one line; failures show exit code and output tail. Output over 4000 chars goes to an artifact:// ref; expect sees the full text. '
      + 'Steps writing via >, tee or dd outside /tmp are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              command_line: S,
              label: S,
              cwd: S,
              timeout: d(S, '"30s", "5m" or ms; default 120s'),
              stdin: d(S, 'piped to stdin; avoids shell quoting'),
              env: { type: 'object', additionalProperties: S },
              expect: {
                type: 'object',
                properties: {
                  contains: d(SA, 'all must appear; use a token printed only on success'),
                  notContains: SA,
                  regex: S,
                },
              },
            },
            required: ['command_line'],
          },
        },
        stopOnError: d(B, 'default true'),
        waitMs: d(I, 'default 45000, max 50000; 0 returns at once'),
      },
      required: ['steps'],
    },
  },
  {
    name: 'omega_batch_status',
    description: 'Verdict of an omega_batch job; waitMs (max 50000) blocks until done. cancel:true kills the running step and stops the job.',
    inputSchema: {
      type: 'object',
      properties: {
        id: S,
        waitMs: I,
        cancel: B,
        verbose: d(B, 'include every step output'),
        format: { enum: ['text', 'json'] },
      },
      required: ['id'],
    },
  },
  {
    name: 'omega_read',
    description: 'Read many files in one call: line slices, regex-filtered lines with context, or a declaration outline / symbol lookup. Output capped at 20000 chars.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'entries or plain path strings',
          items: {
            type: 'object',
            properties: {
              path: S,
              startLine: I,
              lineCount: d(I, 'max 500'),
              pattern: d(S, 'regex; return only matching lines'),
              maxMatches: I,
              contextBefore: I,
              contextAfter: I,
              maxLineLength: I,
              outline: B,
              symbol: d(S, 'declarations with this name'),
              maxSymbols: I,
            },
          },
        },
        path: d(S, 'single file shorthand'),
        baseDir: d(S, 'for relative paths (server cwd is not your cwd)'),
      },
    },
  },
  {
    name: 'omega_grep',
    description: 'Search code, return path:line matches (rg, grep -E fallback). Capped output.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: S,
        dir: S,
        baseDir: S,
        include: d({ oneOf: [S, SA] }, 'glob(s), e.g. "*.mjs"'),
        exclude: { oneOf: [S, SA] },
        ignoreCase: B,
        literal: B,
        word: B,
        maxMatches: d(I, 'default 30, max 100'),
        contextBefore: I,
        contextAfter: I,
        maxLineLength: I,
      },
      required: ['pattern'],
    },
  },
  {
    name: 'omega_edit',
    description: 'Exact-string edits across files, all-or-nothing: every edit and assertion is verified in memory before any file is written. '
      + 'oldString must match once unless replaceAll. Returns a short summary and an undo id; diffs only with dryRun or diff:true. '
      + 'undo:"<id>" rolls a previous edit back.',
    inputSchema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: S,
              oldString: S,
              newString: S,
              replaceAll: B,
              mustContain: SA,
              mustNotContain: SA,
              mustMatch: SA,
              mustNotMatch: SA,
              allowOverlap: B,
              expectedSha256: S,
            },
            required: ['path', 'oldString', 'newString'],
          },
        },
        dryRun: B,
        diff: d(B, 'return diffs after applying'),
        diffCtx: d(I, 'context lines, default 3'),
        createIfMissing: d(B, 'oldString:"" creates a new file'),
        preserveLineEndings: B,
        baseDir: S,
        undo: d(S, 'undo id from an earlier edit; other fields ignored'),
        paths: d(SA, 'with undo: restore only these'),
      },
    },
  },
  {
    name: 'vfs_local_write',
    description: 'Write a file atomically without shell quoting. One of content / content_b64 / content_file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: S,
        content: S,
        content_b64: S,
        content_file: S,
        append: B,
        expectedSha256: d(S, 'only overwrite this exact content'),
        requireMissing: d(B, 'refuse if the file exists'),
      },
      required: ['path'],
    },
  },
  {
    name: 'omega_sqlite',
    description: 'Read-only SQL on any sqlite file (max 200 rows).',
    inputSchema: {
      type: 'object',
      properties: { db: S, sql: S, sql_b64: S, baseDir: S },
      required: ['db'],
    },
  },
  {
    name: 'omega_health',
    description: 'Self-check of this server; verdict on line 1.',
    inputSchema: { type: 'object', properties: {} },
  },
];
