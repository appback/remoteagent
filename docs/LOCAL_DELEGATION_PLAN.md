# Local Delegation Pilot

## Status

- Implemented: opt-in read-only CLI transport, job IDs, status/result/cancel,
  one worker per data directory, bounded input/output, timeout, mock endpoint tests.
- Pending: actual hardware/endpoint selection, model comparison, measured savings.
- Pending: coding executor isolation, worktree edits, tool limits, MCP interface,
  Codex/Claude integration tests and any server deployment.

The harness does not classify instructions or approve results. A returned answer
is unreviewed model output, not evidence of completed development work.

## Run Locally

Use an operator-approved local endpoint. The pilot sends only the three supplied
text fields and supplies no filesystem, shell, network, or secret tools. The
endpoint must itself be trusted; this does not sandbox an external server.
No API keys, inherited environment variables, or session history are sent.

Create a JSON request with `instruction`, `context`, and `acceptance` strings.
Use selected, sanitized excerpts in context rather than whole repositories.

```sh
export LOCAL_DELEGATE_ENABLED=1
export LOCAL_DELEGATE_URL=http://127.0.0.1:1234/v1/chat/completions
export LOCAL_DELEGATE_MODEL=YOUR_LOADED_MODEL_ID
remoteagent delegate run /absolute/path/request.json
remoteagent delegate status JOB_UUID
remoteagent delegate result JOB_UUID
remoteagent delegate cancel JOB_UUID
```

`run` prints a running job ID immediately and then waits for completion. Run it
through a supervisor's background command tool when asynchronous use is needed;
the process must remain alive. Records live under DATA_DIR/delegations (default
~/.remoteagent/delegations). `status` omits output; `result` includes it.
No daemon, Telegram routing change, or automatic scheduling is installed.

Limits: 64 KiB request, 2,048 requested output tokens, 16 KiB answer,
128 KiB HTTP response, 120 seconds, one concurrent worker, zero automatic retries.
Cancellation aborts the HTTP request; the inference server may continue computing
if it does not implement disconnect cancellation. That behavior needs real tests.
After a crash, inspect the recorded PID/job before manually removing worker.lock.
No previous job is automatically restarted. PID reuse can make status ambiguous;
this pilot does not claim restart-safe worker supervision yet.

## Evaluation Set

Select two real examples for each category, ten paired cases total:

1. Extract API endpoints from supplied docs.
2. Compare documented fields against supplied schema excerpts.
3. Find contradictions across two supplied specification excerpts.
4. Propose tests for a supplied pure function (no execution claim).
5. Review a small supplied diff for regressions.

Prepare a reference answer before comparing. Use the same acceptance criteria and
record direct-provider versus delegated totals in this format:

```text
case,model,quantization,context_limit,hardware_memory,
direct_input_tokens,direct_output_tokens,direct_elapsed_ms,
delegated_supervisor_input_tokens,delegated_supervisor_output_tokens,
local_prompt_tokens,local_completion_tokens,total_elapsed_ms,
quality_pass,rework_count,user_interventions,peak_memory
```

Provider usage must include task design, result inspection, and any repair turns.
Local endpoint usage is stored as reported, not treated as paid-provider savings.
Proposed gate: no quality regression and >=30% reduction in aggregate supervisor
tokens. Report per-case failures as well as totals; do not hide failed delegation
attempts. No measured savings are available yet.

Only after the read-only pilot passes should a proven coding executor be selected
and evaluated with isolated worktrees, explicit file scope, no production secrets,
bounded tools, at most one repair, and supervisor-controlled integration.

## Verification

```sh
npm run build
node scripts/selftest-local-delegate.mjs
```
