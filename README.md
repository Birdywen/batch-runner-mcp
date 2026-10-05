# batch-runner-mcp

Run several bash steps in one MCP call, and know whether each one actually did what you wanted.

A zero exit code only proves a command ran. With `omega_batch`, every step can carry an `expect` assertion (`contains` / `notContains` / `regex`). Each step is reported as `ok`, `FAIL (process)` or `FAIL (expectation)`, with exit code, signal, timeout and stderr kept separate. Steps skipped after a failure are listed as `(halted)` instead of silently disappearing.

Zero npm dependencies. Node >= 20. Works with any MCP host that speaks stdio (Claude Code, opencode, Claude Desktop, ...).

## Install

Claude Code:

```bash
claude mcp add batch-runner -- npx -y github:Birdywen/batch-runner-mcp
```

Generic JSON config (`mcpServers`):

```json
{ "batch-runner": { "command": "npx", "args": ["-y", "github:Birdywen/batch-runner-mcp"] } }
```

opencode (`opencode.json`, `mcp` section):

```json
{ "batch-runner": { "type": "local", "command": ["npx", "-y", "github:Birdywen/batch-runner-mcp"] } }
```

Then call `omega_health` once. The first line is the verdict (`HEALTHY` / `DEGRADED`); optional parts that are not configured show as `[--]`.

## Example

```json
{ "steps": [
  { "label": "build", "command_line": "npm run build", "expect": { "contains": ["compiled successfully"] } },
  { "label": "smoke", "command_line": "node dist/cli.js --version", "expect": { "regex": "^\\d+\\.\\d+" } }
], "stopOnError": true }
```

`omega_batch` returns a job id at once; `omega_batch_status` with `waitMs` (max 50000) blocks until the verdict is ready:

```
batch job-xxxx: partial 4/4
  [FAIL] 1. basic exit3 (process)
      exit=3 signal=none timedOut=false chars=34
      out-line
      --- stderr ---
      err-line
  [FAIL] 2. expect fail on exit0 (expectation) -- expect.contains failed: NOPE_MARK
  [ok] 3. long 30000
  [ok] 4. after
```

Add `format: "json"` for structured per-step fields (`ok`, `status`, `failureType`, `exitCode`, `signal`, `timedOut`, `durationMs`) and `verbose: true` for full output.

## Tools

| Tool | What it does |
|---|---|
| `omega_batch` / `omega_batch_status` / `omega_batch_cancel` | Async batch of bash steps with expect checks, status polling and cancellation |
| `omega_flow` | Multi-step flows with conditions (see `OMEGA-FLOW.md`) |
| `omega_guard_check` | Dry-run the command guard that inspects steps before they run |
| `omega_read` | Read files |
| `omega_edit` / `omega_undo` | Exact-string edits with snapshot-based undo |
| `vfs_local_write` | Write a file without shell quoting |
| `omega_grep` | ripgrep search, with a `grep -E` fallback when rg is absent |
| `omega_sqlite` | Read-only queries against any sqlite file |
| `artifact_read` / `artifact_search` | Long outputs are stored as artifacts; read or search them later |
| `omega_health` | Self-check: module hashes, writable dirs, optional dependencies |
| `omega_quota` | Optional; needs `OMEGA_QUOTA_SCRIPT` |
| `db_query` | Optional; tied to a specific agent database layout. Use `omega_sqlite` for general sqlite access |

## Configuration

Everything works with defaults under `~/.omega-mcp/`. Common overrides:

| Variable | Default / meaning |
|---|---|
| `OMEGA_ARTIFACT_DIR` | `~/.omega-mcp/artifacts` |
| `OMEGA_JOB_DIR` | batch job state directory |
| `OMEGA_MCP_LOG` | server log file |
| `OMEGA_INLINE_LIMIT` | output size kept inline before spilling to an artifact |
| `OMEGA_DEFAULT_TIMEOUT` | default per-step timeout |
| `OMEGA_CWD` | default working directory (home if unset) |
| `OMEGA_QUOTA_SCRIPT` | enables `omega_quota` |

## Development

```bash
npm test
```
