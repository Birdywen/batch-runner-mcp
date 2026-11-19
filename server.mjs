#!/usr/bin/env node
import { realpathSync as __omegaRealpath } from 'node:fs';
// batch-runner-mcp: run several bash steps in one MCP call, each with a mechanical
// expect check, plus read/grep/edit/undo/sqlite/flow tools. Long output is
// stored as artifacts so it stays out of the model context.
//
// Protocol: JSON-RPC 2.0 over stdio, newline-delimited. Implemented directly so
// this has zero npm dependencies and cannot be broken by a missing node_modules.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  vfsLocalWrite, omegaBatch, omegaBatchStatus, omegaBatchCancel, omegaRead,
  omegaGrep, omegaHealth, omegaSqlite, omegaEdit, omegaUndo, EXTRA_TOOLS,
} from './tools-ext.mjs';
import { createFlowRuntime, FLOW_TOOL } from './omega-flow.mjs';

const ART_DIR = process.env.OMEGA_ARTIFACT_DIR
  || path.join(homedir(), '.omega-mcp/artifacts');
const INLINE_LIMIT = Number(process.env.OMEGA_INLINE_LIMIT || 20000);
const DEFAULT_TIMEOUT = Number(process.env.OMEGA_DEFAULT_TIMEOUT || 120000);
const LOG = process.env.OMEGA_MCP_LOG || '/tmp/omega-mcp.log';

function log(msg) {
  try {
    writeFileSync(LOG, `${new Date().toISOString()} ${msg}\n`, { flag: 'a' });
  } catch { /* logging must never break the server */ }
}

function saveArtifact(text, stream) {
  mkdirSync(ART_DIR, { recursive: true, mode: 0o700 });
  const sha = createHash('sha256').update(text).digest('hex');
  const id = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${sha.slice(0, 16)}`;
  const file = path.join(ART_DIR, `${id}.${stream}.txt`);
  writeFileSync(file, text, { mode: 0o600 });
  return { id, sha256: sha, file, ref: `artifact://${id}/${stream}` };
}

function resolveRef(ref) {
  const m = String(ref || '').match(/^artifact:\/\/([^/]+)\/(\w+)$/);
  if (!m) throw new Error(`bad artifact ref: ${ref}`);
  const file = path.join(ART_DIR, `${m[1]}.${m[2]}.txt`);
  if (!existsSync(file)) throw new Error(`artifact not found: ${ref}`);
  return file;
}

// Hosts may launch this server with a minimal PATH (no Homebrew dirs), so bare
// `node`/`python3` would die with 127. Prepend well-known tool dirs; a
// caller-supplied PATH still wins via spread.
function withToolPath(env) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const extra = ['/opt/homebrew/bin', '/usr/local/bin']
    .filter((p) => !(env.PATH || '').split(sep).includes(p));
  if (!extra.length) return env;
  return { ...env, PATH: [...extra, env.PATH || ''].filter(Boolean).join(sep) };
}

function runProcess(args) {
  const cmd = args.command_line || args.command;
  if (!cmd) return Promise.resolve({ isError: true, text: 'command_line is required' });
  const timeout = parseDuration(args.timeout) ?? DEFAULT_TIMEOUT;
  const cwd = args.cwd || process.env.OMEGA_CWD || homedir();
  const limit = args.inlineLimit || INLINE_LIMIT;

  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', cmd], {
      cwd,
      env: withToolPath({ ...process.env, ...(args.environment || {}) }),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    let out = '';
    let err = '';
    let timedOut = false;
    const killGroup = (sig) => {
      try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} }
    };
    // Lets omega_batch_cancel stop the running step: TERM first, KILL after 2s.
    if (args.onSpawn && child.pid) {
      args.onSpawn(() => { killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 2000).unref(); });
    }
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    if (args.stdin) child.stdin.write(String(args.stdin));
    child.stdin.end();

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGKILL');
    }, timeout);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const combined = out + (err ? (out ? '\n--- stderr ---\n' : '') + err : '');
      const ok = !timedOut && code === 0;
      let body = combined;
      let banner = '';
      let artifactRef = null;
      if (combined.length > limit) {
        const art = saveArtifact(combined, 'combined');
        artifactRef = art.ref;
        const lineCount = combined.split('\n').length;
        const headN = Math.floor(limit * 0.3);
        const tailN = Math.floor(limit * 0.5);
        // Reference goes FIRST: a host that truncates trailing text must not eat it.
        banner = `[truncated] full output: ${art.ref} `
          + `(${combined.length} chars, ${lineCount} lines, sha256 ${art.sha256.slice(0, 12)})\n`
          + `Read it with the artifact tool (regex or startLine).\n\n`;
        body = `${combined.slice(0, headN)}\n\n... [${combined.length - headN - tailN} chars omitted] ...\n\n${combined.slice(-tailN)}`;
      }
      const status = `exit=${code} signal=${signal || 'none'} timedOut=${timedOut} `
        + `chars=${combined.length}\n`;
      resolve({
        isError: !ok,
        text: banner + status + body,
        full: combined,
        artifactRef,
        exitCode: code,
        signal: signal || null,
        timedOut,
        pgid: child.pid,
      });
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({
        isError: true,
        text: `spawn failed: ${e.message}`,
        exitCode: null,
        signal: null,
        timedOut: false,
      });
    });
  });
}

function parseDuration(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number') return v < 1000 && v > 0 ? v * 1000 : v;
  const m = String(v).match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] || 'ms'];
  return Math.round(n * mult);
}

const ARTIFACT_TOOL = {
  name: 'artifact',
  description: 'Read stored long output (artifact://). regex: matching lines with context. startLine/lineCount: a slice. Neither: the last 80 lines.',
  inputSchema: {
    type: 'object',
    properties: {
      ref: { type: 'string' },
      regex: { type: 'string' },
      context: { type: 'integer', description: 'lines around each match, default 2' },
      maxMatches: { type: 'integer', description: 'default 20' },
      startLine: { type: 'integer' },
      lineCount: { type: 'integer' },
    },
    required: ['ref'],
  },
};

function artifactTool(args) {
  const lines = readFileSync(resolveRef(args.ref), 'utf8').replace(/\n$/, '').split('\n');
  const n = lines.length;
  const num = (i) => `${i + 1}: ${lines[i].length > 300 ? `${lines[i].slice(0, 300)}...` : lines[i]}`;
  if (args.regex) {
    const re = new RegExp(args.regex, 'i');
    const ctx = Math.min(10, Math.max(0, args.context ?? 2));
    const max = Math.min(100, args.maxMatches || 20);
    const out = [];
    let hits = 0;
    let shownTo = -1;
    for (let i = 0; i < n && hits < max; i++) {
      if (!re.test(lines[i])) continue;
      hits++;
      const s = Math.max(shownTo + 1, i - ctx);
      if (out.length && s > shownTo + 1) out.push('--');
      for (let j = s; j <= Math.min(n - 1, i + ctx); j++) out.push(num(j));
      shownTo = Math.min(n - 1, i + ctx);
    }
    return { isError: false, text: `${hits}${hits === max ? '+' : ''} match(es) in ${n} lines\n${out.join('\n')}`.slice(0, 20000) };
  }
  const count = Math.min(500, args.lineCount || 80);
  const s = args.startLine !== undefined ? Math.max(0, args.startLine - 1) : Math.max(0, n - count);
  const idx = [];
  for (let i = s; i < Math.min(n, s + count); i++) idx.push(num(i));
  return { isError: false, text: `lines ${s + 1}..${s + idx.length} of ${n}\n${idx.join('\n')}`.slice(0, 20000) };
}

// omega_flow costs ~900 tokens of schema; advertise it only when asked for.
const FLOW_ON = process.env.OMEGA_FLOW === '1';
const ALL_TOOLS = [...EXTRA_TOOLS, ARTIFACT_TOOL, ...(FLOW_ON ? [FLOW_TOOL] : [])];
// Flow capacity is bounded so a chatty model cannot grow the jobs map without
// limit. Jobs are only reclaimed by the 30-minute TTL sweep and cancel does NOT
// free a slot, so a session that opens maxJobs flows is locked out until they
// expire. OMEGA_FLOW_MAX_JOBS tunes the ceiling; an unparseable value falls back
// to the default rather than silently lifting the bound.
const FLOW_MAX_JOBS_DEFAULT = 16;
const FLOW_MAX_JOBS_LIMIT = 1024;
const flowMaxJobs = (() => {
  const raw = process.env.OMEGA_FLOW_MAX_JOBS;
  if (raw === undefined || raw === '') return FLOW_MAX_JOBS_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > FLOW_MAX_JOBS_LIMIT) {
    log(`omega_flow: ignoring OMEGA_FLOW_MAX_JOBS=${JSON.stringify(raw)}; want an integer 1..${FLOW_MAX_JOBS_LIMIT}`);
    return FLOW_MAX_JOBS_DEFAULT;
  }
  return n;
})();
const omegaFlow = createFlowRuntime(callTool, {
  allowEffects: process.env.OMEGA_FLOW_ALLOW_EFFECTS === '1',
  maxJobs: flowMaxJobs,
});

async function callTool(name, args) {
  args = args || {};
  switch (name) {
    case 'omega_batch': return omegaBatch(args, runProcess);
    case 'omega_batch_status': return omegaBatchStatus(args);
    case 'omega_read': return omegaRead(args);
    case 'omega_grep': return omegaGrep(args);
    case 'omega_edit': return omegaEdit(args);
    case 'vfs_local_write': return vfsLocalWrite(args);
    case 'omega_sqlite': return omegaSqlite(args);
    case 'omega_health': return omegaHealth(args);
    case 'artifact': return artifactTool(args);
    case 'omega_flow': return omegaFlow(args);
    // Old names: no longer advertised, still routed so existing prompts work.
    case 'omega_batch_cancel': return omegaBatchCancel(args);
    case 'omega_undo': return omegaUndo(args);
    case 'artifact_read': return artifactTool({ ...args, regex: undefined });
    case 'artifact_search': return artifactTool(args);
    default: break;
  }
  return { isError: true, text: `unknown tool: ${name}` };
}

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

// Pure dispatch: JSON-RPC request -> response object, or null for
// notifications. Shared by the stdio loop below and server-http.mjs.
async function handleRequest(req) {
  const { id, method, params } = req;
  log(`-> ${method}`);
  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'batch-runner-mcp', version: '1.0.0' },
        },
      };
    } else if (method === 'notifications/initialized' || method === 'initialized') {
      // notification: no response
      return null;
    } else if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: ALL_TOOLS } };
    } else if (method === 'tools/call') {
      const r = await callTool(params?.name, params?.arguments);
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: r.text }], isError: r.isError },
      };
    } else if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    } else if (id !== undefined) {
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
    }
    return null;
  } catch (e) {
    log(`error in ${method}: ${e.stack || e.message}`);
    if (id !== undefined) {
      return { jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message) } };
    }
    return null;
  }
}

export { handleRequest, ALL_TOOLS, callTool, runProcess };

const __omegaIsMain = (() => { try { return __omegaRealpath(process.argv[1]) === __omegaRealpath(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (__omegaIsMain) {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const raw = line.trim();
    if (!raw) return;
    let req;
    try {
      req = JSON.parse(raw);
    } catch (e) {
      log(`parse error: ${e.message}`);
      return;
    }
    const res = await handleRequest(req);
    if (res) send(res);
  });

  log(`omega-bridge started pid=${process.pid} artifacts=${ART_DIR}`);
}
