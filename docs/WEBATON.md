# Webaton frontend bridge (initial integration)

Webaton and Telegram use the same BridgeService session records, events and
provider execution. The optional API listens only on 127.0.0.1:3795.
Enable it with WEBATON_BRIDGE_TOKEN (at least 32 characters); configure the same
secret in Webaton's backend environment. Never expose it to browser JavaScript.
WEBATON_BRIDGE_PORT optionally changes the port on both services.

Endpoints, all requiring Authorization: Bearer:
- GET /sessions
- GET /sessions/:id/events
- POST /sessions/:id/messages {"message":"..."}
- POST /sessions/:id/stop {}

Webaton must retain its owner authentication and proxy these endpoints server-side.
Browser Origin headers are rejected; requests are bounded to 16 KiB / 4000 message
characters. Message requests currently wait for the provider response; event polling
can read session logs independently. This is a personal owner API, not multitenant.

Validation: npm run build; node scripts/selftest-webaton.mjs.
No running installation is upgraded by adding this source.

Remaining: web session creation, progress UI, browser MCP action/observation
integration, Gemini provider adapter, and live end-to-end browser task validation.
Jev remains in the existing RemoteAgent execution/review path.

## Implemented transition, 2026-09-28

- POST /sessions creates Codex/Claude/Gemini sessions.
- POST /sessions/:id/runs accepts a bounded asynchronous command; GET /runs/:id
  returns progress state/result. Duplicate runs for the same session are rejected.
- GeminiAdapter supports the existing shared session model, continuation, cancellation,
  Gemini generateContent function calling, and Webaton MCP tools. Configure a Gemini
  API key/model in RemoteAgent's Secret Store through the authenticated configuration API.
- Codex/Claude receive WEBATON_MCP_PATH. Codex uses automatic approval review for
  MCP execution, not a blanket approval bypass.
- WEBATON_BRIDGE_TOKEN_FILE avoids including the shared service credential in child
  provider environments.
- Telegram /start gemini uses the same provider adapter; existing session bindings
  and Jev review settings are preserved.

### Validation

Build, selftest-webaton, selftest-webaton-runs, selftest-gemini, selftest-jev,
selftest-codex-stream, selftest-model-fallback, selftest-telegram and selftest-cli passed.
Telegram selftests use simulated updates, not real message delivery.

Actual authenticated Codex through BridgeService invoked Webaton MCP, logged into a
local fixture in real Chromium, observed the report, downloaded a CSV, observed again,
and finished. The harness independently checked completed status and CSV contents.
Job: 1867844d-9acc-42a9-988e-b86caa3b71a1; 23 bytes; 2026-09-28T05:57:48Z.
No live Gemini call: no Gemini key was available. Claude runtime is not live-tested.

### Deployment boundary

These tests use isolated state; they do not upgrade a running installation.
This workspace's running RemoteAgent hosts the development conversation itself.
Its SIGTERM handler calls terminateAllSpawnedExecutions, so restarting it also kills
the deployment/verification session. Finish review and restart from a separate terminal
or an independent maintenance session.

Preparation (backs up config; does not restart):
  node scripts/configure-webaton.mjs /absolute/path/to/webaton

Then from that separate terminal:
  bash scripts/stop.sh
  bash scripts/start.sh
  launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/app.webaton.server.plist
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.webaton.server.plist

Run start.sh from THIS checkout so it starts the reviewed build. Existing installed
global remoteagent-start may point to an older build. Retain the old runtime for rollback.
Do not run two RemoteAgent processes against the same data directory or Telegram bot.
After restart, verify Webaton session listing, a new session, an actual browser task,
Telegram attachment to that same session, cancellation and authentication recovery.
Do not report production cutover complete from fixture tests alone.
