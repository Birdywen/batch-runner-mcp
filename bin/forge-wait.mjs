#!/usr/bin/env node
// Block until an omega_batch job finishes, then print its verdict and exit
// (0 = success, 1 = not a pass, 2 = unknown job).
//
// Bridge to host background tasks: start the batch with waitMs:0, then run
//   node ~/omega-mcp/bin/forge-wait.mjs <jobId>
// as a background command. The host wakes the agent when this exits, so a long
// job costs one submit and one wake-up instead of repeated status polls.
// Uses OMEGA_JOB_DIR (default /tmp/omega-jobs); match the server's setting.
import { omegaBatchStatus } from '../tools-ext.mjs';

const id = process.argv[2];
if (!id) { console.error('usage: forge-wait.mjs <jobId> [--verbose]'); process.exit(2); }
const verbose = process.argv.includes('--verbose');
const deadline = Date.now() + (Number(process.env.FORGE_WAIT_MAX_S) || 6 * 3600) * 1000;

for (;;) {
  const r = await omegaBatchStatus({ id, waitMs: 30000, verbose });
  if (/^no such batch/.test(r.text)) { console.log(r.text); process.exit(2); }
  if (!/^batch \S+: running /.test(r.text)) { console.log(r.text); process.exit(r.isError ? 1 : 0); }
  if (Date.now() > deadline) { console.log(`${r.text}\nforge-wait: gave up after the time limit; job may still be running`); process.exit(1); }
}
