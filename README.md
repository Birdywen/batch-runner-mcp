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

Then call `omega_health` once. The first line is the verdict (`HEALTHY` / `DEGRADED`); optional parts that are missing show as `[--]`.

## Example

```json
{ "steps": [
  { "label": "build", "command_line": "npm run build", "expect": { "contains": ["compiled successfully"] } },
  { "label": "smoke", "command_line": "node dist/cli.js --version", "env": { "NO_COLOR": "1" }, "expect": { "regex": "^\\d+\\.\\d+" } }
], "stopOnError": true }
```

`omega_batch` waits for the verdict (up to `waitMs`, default 45s) and answers in the same call. Success is one line:

```
batch job-xxxx: success 2/2 (3.1s): build | smoke
```

A failure shows the exit code and the **tail** of the output, where errors are:

```
batch job-xxxx: failed 1/2 (0.4s)
  [FAIL] 1. build (process)
      exit=2
      src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.
  [--] 2. (halted) -- stopOnError
```

- `expect` is checked against the **full** output. Output over 4000 chars goes to an `artifact://` ref.
- Still running after `waitMs`: the reply has the job id; `omega_batch_status {id, waitMs}` picks it up. `cancel: true` kills the running step's process group.
- Job state is on disk after every step; after a restart an unfinished job reads as `interrupted`.
- `format: "json"` gives structured per-step fields; `verbose: true` adds output.

## Tools

Nine tools, about 1.8k tokens of schema in total.

| Tool | What it does |
|---|---|
| `omega_batch` | Bash steps with expect checks; verdict in one call |
| `omega_batch_status` | Wait for / cancel a batch that outlived `waitMs` |
| `omega_read` | Many files in one call: slices, regex-filtered lines, outlines |
| `omega_grep` | path:line search (rg, `grep -E` fallback) |
| `omega_edit` | Multi-file exact-string edits, all-or-nothing; short summary + undo id; `undo:"<id>"` rolls back |
| `vfs_local_write` | Atomic file write without shell quoting |
| `omega_sqlite` | Read-only SQL on any sqlite file |
| `artifact` | Long output: regex lines with context, a slice, or the last 80 lines |
| `omega_health` | Self-check |

`omega_flow` (multi-step tool composition, see `OMEGA-FLOW.md`) is off by default; set `OMEGA_FLOW=1` to advertise it.

## Configuration

Everything works with defaults. Common overrides:

| Variable | Default / meaning |
|---|---|
| `OMEGA_ARTIFACT_DIR` | `~/.omega-mcp/artifacts` |
| `OMEGA_JOB_DIR` | `/tmp/omega-jobs` — batch job state |
| `OMEGA_SNAP_DIR` | `/tmp/omega-snaps` — omega_edit undo snapshots |
| `OMEGA_MCP_LOG` | `/tmp/omega-mcp.log` |
| `OMEGA_INLINE_LIMIT` | 20000 — output kept inline before spilling to an artifact |
| `OMEGA_DEFAULT_TIMEOUT` | 120000 ms per step |
| `OMEGA_CWD` | default working directory (home if unset) |
| `OMEGA_FLOW=1` | advertise omega_flow (limits: see `OMEGA-FLOW.md`) |
| `OMEGA_FORCE_GREP` | `1` pins omega_grep to the grep fallback |

Batch shells get `/opt/homebrew/bin` and `/usr/local/bin` prepended to PATH; a per-step `env.PATH` still wins.

## Development

```bash
npm test
```

The MCP server loads code once at startup: restart the host after changing it.

omega_grep keeps rg and the grep fallback in step: the fallback uses ERE (so `a|b` works) and passes exactly one matcher flag (GNU grep rejects `-E -F`). `OMEGA_GREP_TRACE=1` dumps the argv so the suite can assert on it.
