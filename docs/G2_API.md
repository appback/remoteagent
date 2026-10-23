# Direct G2 Request API

Contract version: 1, package version 0.30.0. Implemented locally on 2026-10-23; production activation and
OAuth grants require a separate owner confirmation. Installing this code does
not register a G2 client, change a tunnel, enable the API or restart a server.

G2 sends text directly to RemoteAgent over HTTPS. Codex/Claude run on that
RemoteAgent host; dot receives a separate MCP event. Telegram remains an
independent input/output route. G2 responses are never automatically mirrored
to Telegram.

## Addresses and authentication

Mac60's existing origin is `https://remoteagent-dot60.appback.app`. The same
loopback MCP listener behind the existing HTTPS tunnel serves the new API:

| Purpose | Path |
| --- | --- |
| REST base and OAuth resource/audience | `/api/v1` |
| API resource metadata | `/.well-known/oauth-protected-resource/api/v1` |
| OAuth metadata | `/oauth/.well-known/openid-configuration` |
| OAuth authorization | `/oauth/auth` |
| OAuth token exchange | `/oauth/token` |
| OAuth revocation | `/oauth/token/revocation` |
| Existing dot MCP | `/mcp` |

Use OAuth Authorization Code with PKCE S256, a public G2 web client named
`remoteagent-g2-<name>`, and scope `remoteagent:g2`. No shared client secret, bot
token, dot connector token or local dispatch token is distributed to G2.
Tokens have a one-hour lifetime; the API rejects them during their last minute.
G2 tokens cannot authorize dot MCP, host shell tools or Mac control tools. The
existing ChatGPT token cannot authorize the G2 API.

The initial supported client is a browser-based G2 plugin. Its HTTPS origin and
exact callback URL are operator-approved configuration, not wildcard or dynamic
registration. Example pending confirmation: `https://g2.example.app` and
`https://g2.example.app/oauth/callback`. This example domain is not provisioned.
The G2 team must supply its actual deployed origin/callback before activation.
An embedded G2 runtime must support this browser OAuth flow or launch an external
browser that returns to that same web app. Native custom schemes/loopback
redirects and a BFF session backend are not implemented in version 1.

### Login and token storage

1. Generate a cryptographically random `state` and PKCE verifier. Keep them in
   tab-scoped `sessionStorage` for at most five minutes, including their creation
   time. A top-level redirect can then recover this short-lived login attempt.
2. Navigate to the authorization URL below. The owner approves the G2 client on
   the existing RemoteAgent consent screen with a one-use `/login dot` owner
   approval code. That command supplies owner proof; it does not make G2 messages
   travel through Telegram. Do not send the approval code to the G2 application.
3. At the callback, check `state`, expected `iss`, and the five-minute deadline.
   Remove `code`/`state` from browser history immediately with `replaceState`.
4. Exchange the code using the verifier; remove the saved login attempt whether
   the exchange succeeds or fails. Keep the returned access token only in memory.
5. Send the token as an Authorization header. Do not put it in URL parameters,
   localStorage, sessionStorage, files, logs, analytics or a new credential vault.
6. On page reload, token expiry or 401, log in again. G2 receives no refresh token
   and does not request `offline_access`. Existing dot refresh behavior is unchanged.

Authorization parameters (values must be URL encoded):

```text
GET /oauth/auth
  ?client_id=remoteagent-g2-plugin
  &redirect_uri=https://g2.example.app/oauth/callback
  &response_type=code
  &scope=remoteagent:g2
  &resource=https://remoteagent-dot60.appback.app/api/v1
  &state=<random-state>
  &code_challenge=<base64url-sha256-verifier>
  &code_challenge_method=S256
```

Token exchange is `application/x-www-form-urlencoded`, not JSON:

```text
POST /oauth/token
grant_type=authorization_code
client_id=remoteagent-g2-plugin
redirect_uri=https://g2.example.app/oauth/callback
code=<callback-code>
code_verifier=<original-verifier>
resource=https://remoteagent-dot60.appback.app/api/v1
```

REST and token CORS allow only the configured client's exact origins. REST allows
GET/POST/OPTIONS and Authorization/Content-Type; no cookie credentials or wildcard
origins. The configured target allowlist is rechecked on every API call. Version 1
uses the runtime's single owner identity, not a general multi-tenant user directory.

## Targets

`GET /api/v1/targets` returns only permitted targets on this runtime:

```json
{"targets":[
  {"targetId":"tgt_0123456789abcdef0123456789abcdef","type":"session","provider":"codex","label":"S007","available":true,"cancelMode":"execution"},
  {"targetId":"tgt_fedcba9876543210fedcba9876543210","type":"dot_channel","provider":"dot","label":"dot <channel-uuid>","available":true,"cancelMode":"delivery_only"}
]}
```

Claude sessions use `type=session, provider=claude`. Sessions expose their current
provider; this API does not silently switch a session's provider. IDs derive from
a persistent runtime-specific key plus the immutable session/channel ID and
provider. They survive restart and list reordering. S007 and array positions are
display labels, not routing identities. Recreating a target or changing its
provider produces a different target ID; no automatic rebinding is performed.

Session availability requires a paired/configured installed provider and no
session lock. Dot availability requires an active **G2** subscription. The ordinary
Telegram dot subscription alone is insufficient. A target with unfinished G2 work
is also unavailable. This is not a cross-server target directory.

## Request acceptance

All REST requests use `Authorization: Bearer <access-token>`. POST bodies use
`Content-Type: application/json`.

```http
POST /api/v1/requests
Content-Type: application/json
Authorization: Bearer <access-token>

{"targetId":"tgt_0123456789abcdef0123456789abcdef","clientRequestId":"g2-20261023-001","text":"Review the current plan."}
```

After durable storage, a new request returns `202 Accepted` immediately, without
waiting for the provider/dot answer. `Location` identifies the status path:

```json
{"requestId":"req_12345678-1234-1234-1234-123456789abc","clientRequestId":"g2-20261023-001","targetId":"tgt_0123456789abcdef0123456789abcdef","status":"accepted","createdAt":"2026-10-23T03:00:00.000Z","updatedAt":"2026-10-23T03:00:00.000Z","lastSeq":1,"replayed":false}
```

Idempotency is scoped to owner + OAuth client ID + `clientRequestId`. The same ID,
target and exact text returns the existing request with HTTP 200 and
`replayed=true`, even when work has already finished. A different payload returns
409 `REQUEST_ID_CONFLICT`. Preserve the ID after a network timeout. Generate a new
one only for an intentionally new task. ID length is 1-80 characters, using
letters, digits, `_` and `-`.

One G2 request per target can be unfinished. A busy target returns 409 instead of
silently queueing behind unrelated Telegram work. If Telegram wins the session
lock in the short interval after acceptance, the request fails with `TARGET_BUSY`
without executing. Session preparation can fail normally after acceptance.

## Status and event replay

`GET /api/v1/requests/{requestId}` returns a snapshot with `lastSeq` and optional
`result`, `error`, and `cancel`. `result` is:

```json
{"text":"Final report","outcome":"unknown","truncated":false}
```

`outcome` is `succeeded`, `failed` or `unknown`. Codex/Claude final text and dot
reports without an explicit outcome use `unknown`. An explicit dot outcome is
the agent's declaration, not independent verification of correctness.

`GET /api/v1/requests/{requestId}/events?after=0&limit=100` returns:

```json
{"requestId":"req_12345678-1234-1234-1234-123456789abc","events":[{"seq":2,"type":"progress","at":"2026-10-23T03:00:01.000Z","text":"Reviewing files.","truncated":false}],"nextCursor":2,"hasMore":false,"status":"running"}
```

Persist the highest **processed** sequence, not merely a received one. Reconnect
with `after=<processed-seq>` and discard already-processed `(requestId,seq)` pairs.
Fetch again immediately if `hasMore=true`; otherwise poll once per three seconds
while waiting. Cursor 0 starts from the first retained event. Cursors are ordered
per request, not across targets. SSE/websocket subscription is not part of v1.

| Status | Meaning |
| --- | --- |
| accepted | Saved; dot webhook acknowledgement alone remains accepted |
| running | Provider dispatch started or dot progress report arrived |
| completed | Final report received; inspect outcome separately |
| failed | Provider preparation/execution/delivery error |
| cancel_requested | Request-specific cancellation is being applied |
| canceled | Cancellation confirmed within the returned scope |
| interrupted | Runtime restart left the outcome unconfirmed; no automatic execution replay |

Events use `accepted`, `running`, `progress`, `result`, `error`, `cancel_requested`,
`canceled`, or `interrupted`. Failed dot delivery is reconciled and recorded when
the request is queried. There is no additional periodic G2 status scanner.

## Cancellation

```http
POST /api/v1/requests/{requestId}/cancel
Content-Type: application/json
Authorization: Bearer <access-token>

{}
```

HTTP 202 means `cancel_requested`; poll until terminal. HTTP 200 returns an already
terminal request or confirmed cancellation. Repeating cancellation is idempotent.

For sessions, abort is applied while holding that request's session lock. The
lock is released only after its adapter settles. A later Telegram execution and
other sessions cannot be killed by that abort listener. The confirmation reports
`scope=execution, confirmed=true, executionStopped=true` once the request's adapter
has settled; it is not a rollback or proof that no earlier side effect happened.

For dot, cancellation prevents further delivery/report/tool acceptance for the
request and asks existing host/Mac helpers to cancel their request-specific work.
It cannot guarantee that cloud dot or another external tool stopped:

```json
{"scope":"delivery_only","confirmed":true,"executionStopped":false}
```

## G2 dot events and reports

The existing owner-authenticated ChatGPT MCP connection handles G2 messages.
G2 itself does not call MCP or receive the connector's bearer token.

`events/list` adds `g2.message.created` only when the G2 API is active. The owner
connection subscribes using the same signed-webhook verification flow:

```json
{"jsonrpc":"2.0","id":1,"method":"events/subscribe","params":{"name":"g2.message.created","arguments":{"channelId":"<approved-existing-channel-uuid>"},"delivery":{"mode":"webhook","url":"<dot-provided-callback>","secret":"<dot-provided-signing-secret>"},"ttlMs":86400000}}
```

The subscription filter is **event name + channel ID**. Telegram subscriptions
retain `telegram.message.created` and remain independent, including renewal,
replacement and unsubscribe. A Telegram `/start codex` or `/stop` does not cancel
an unrelated G2 request. Removing the underlying dot channel invalidates that
target. The selected dot channel can already have a Telegram binding; G2 does
not use Telegram as its message or result transport.

Webhook delivery keeps the existing schema:

```json
{"eventId":"req_12345678-1234-1234-1234-123456789abc","name":"g2.message.created","timestamp":"2026-10-23T03:00:00.000Z","data":{"channelId":"<channel-uuid>","requestId":"req_12345678-1234-1234-1234-123456789abc","text":"Review the current plan."},"cursor":null}
```

The preview is limited to 1,000 characters; dot must call `dot_read_request` for
the full text. It returns `origin=g2`. Dot then uses `dot_report`, with a stable
`reportId`, `kind=progress|result`, text, and optional outcome. The server stores
the report in the **originating G2 request**, not Telegram. G2 cannot override the
destination. Progress/result replay is deduplicated by report ID; changed content
under the same ID is rejected. Reports retain the existing 3,000-character and
20-report-per-request limits.

Webhook transport is at-least-once with the existing bounded retries. Dot must
deduplicate `eventId/requestId` before executing, including after callback timeouts.
Client idempotency does not create an exactly-once guarantee for external effects.
On runtime restart unfinished G2 work becomes interrupted and is not automatically
re-executed; the same `clientRequestId` returns that interrupted receipt.

## Limits and errors

- Text-only submission: 32 KiB UTF-8 text, 64 KiB total JSON body; no file upload API.
- At most 128 retained requests per runtime and one unfinished G2 request per target.
- Terminal requests/idempotency receipts persist seven days after their last update.
- Each event/result text is limited to 16,384 UTF-16 code units and explicitly
  marks truncation. Each request retains at most 128 events / 256 KiB of events.
- 120 authenticated REST calls/minute/client, including at most 10 POSTs/minute.
  Respect HTTP 429 `Retry-After`; reconnects and retries count toward these limits.
- A lost old cursor returns 410 `CURSOR_EXPIRED`. Read the snapshot, display its
  final result if present, then resume after `lastSeq`; do not resubmit the task.
- Request content/events are stored in private mode-600 files. This is filesystem
  permission protection, not an encrypted vault. No tokens are stored in requests.

Errors use `{"error":"FIXED_IDENTIFIER"}`. Common HTTP mappings:

| HTTP | Errors |
| --- | --- |
| 400 | INVALID_REQUEST, INVALID_JSON, INVALID_CURSOR |
| 401 | UNAUTHORIZED; perform G2 login again |
| 403 | TARGET_FORBIDDEN, ORIGIN_NOT_ALLOWED |
| 404 | TARGET_NOT_FOUND, REQUEST_NOT_FOUND; private local UI paths also stay unexposed |
| 409 | REQUEST_ID_CONFLICT, TARGET_BUSY, TARGET_UNAVAILABLE, DOT_NOT_SUBSCRIBED |
| 410 | CURSOR_EXPIRED |
| 413 / 415 | REQUEST_TOO_LARGE / JSON_REQUIRED |
| 429 | RATE_LIMITED with Retry-After |
| 503 | REQUEST_CAPACITY, G2_STORAGE_FAILED |

## Operator activation after confirmation

Before activation, confirm the actual G2 HTTPS origin/callback, the exact session
and dot target allowlist, the G2 dot subscription, and a safe restart window.
No production values have been added by the development work.

1. After approval, initialize/read stable IDs without instantiating any live
   provider or mutating Telegram/dot state:

   ```bash
   node scripts/g2-targets.mjs --data-dir /Users/appback/.remoteagent --initialize-key
   ```

   Subsequent read-only inventory omits `--initialize-key`. Keep `g2/target-key`
   with the runtime data when backing up; losing it changes all target IDs.
2. Create an operator-private JSON file at an absolute path, mode 600:

   ```json
   {"clients":[{"clientId":"remoteagent-g2-plugin","origins":["https://g2.example.app"],"redirectUris":["https://g2.example.app/oauth/callback"],"targetIds":["tgt_0123456789abcdef0123456789abcdef"]}]}
   ```

3. Set `G2_API_ENABLED=true`, `G2_OAUTH_CONFIG_FILE=<absolute-path>`. Existing
   `DOT_ENABLED` and managed owner OAuth must already be active. External OAuth
   mode is not supported for G2 v1. An empty target allowlist grants no targets.
4. Deploy/restart only after separate confirmation. Existing tunnel, hostname,
   Telegram registrations and token stores are reused, not recreated. The local
   UI port 3794 is not added to the tunnel.
5. Refresh the dot connector's tools/events and subscribe the approved channel to
   `g2.message.created`; keep the Telegram subscription. A successful subscription
   verification is not yet an end-to-end G2 acceptance test.

## Development tests

Run from the repository with Node 22 and installed dependencies:

```bash
npm run selftest:g2
npm run selftest:dot-auth
npm run selftest:telegram
```

With Playwright and Chromium available, run the real cross-origin browser gate:

```bash
npm run selftest:g2-browser
```

An externally installed Playwright module can be selected with
`PLAYWRIGHT_PACKAGE=file:///absolute/path/to/playwright/index.mjs` and Chromium
with `PLAYWRIGHT_EXECUTABLE=/absolute/path/to/chrome`. The test creates two local
TLS origins and blocks external browser requests. It checks callback state/issuer,
PKCE, actual browser CORS/preflight, in-memory token use, clean browser storage,
request submission and progress/final event retrieval.

The G2 suite uses a real local `oidc-provider`, synthetic credentials and a local
HTTP listener. It tests PKCE exchange and failure, CORS, token/resource separation,
revocation, target stability/permissions, duplicate execution prevention, progress
replay, dot event/report isolation, cancellation, restart without replay, cursor
expiry and disk failure. Its real-process cancellation test starts disposable
Node children, not a production provider or service.

After authorized production activation, test in this order: metadata and login;
allowed targets; a harmless session request; same-ID duplicate; progress/final
cursor resume; an explicit G2 dot request and result; request-specific cancel;
ordinary Telegram messages. Verify the G2 task produces no unsolicited Telegram
message. Production OAuth, real G2 hardware/browser behavior and cloud dot
subscription acceptance require that separate activation test.

### Local verification record

On 2026-10-23 TypeScript build/check and 77 combined G2/bridge/host/Mac/login/OAuth/
setup tests passed. G2's real Chromium OAuth/API test, the existing dot browser
OAuth and login DOM tests, Telegram update injection and session-dispatch
regressions passed. Production grants, runtime configuration, tunnel routing,
service restarts and deployment were not changed.
