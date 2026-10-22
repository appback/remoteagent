# Dot Telegram Bridge

## Readiness and setup ownership

The bridge now includes a managed OAuth authorization server using
`oidc-provider`. The earlier implementation assumed an external identity provider
already existed; that assumption prevented a fresh installation from linking.
External OAuth remains an optional integration, not the installation default.

RemoteAgent development/installation work must resolve and prepare the transport,
authentication integration and plugin connection before live acceptance. The
configuration reference below is for that work; it is not a request for the end
user to design or provision an identity provider. Only an actual account login,
consent or unavailable administrator permission should be presented as a concrete
user action, with the verified link and purpose at that point.

A public HTTPS endpoint is one transport option, not the only supported private
connection method. OpenAI also documents Secure MCP Tunnel. It requires Platform
and workspace permissions, a tunnel ID and runtime credential; it does not
automatically supply an OAuth authorization server. Its suitability for this dot
event workflow still needs live validation before choosing it for deployment:

- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- https://developers.openai.com/plugins/deploy/connect-chatgpt

## Scope and acceptance

This optional bridge connects an existing OpenAI dot to one explicitly selected
Telegram bot/chat through MCP Events. Dot is not a local CLI provider or a model.
Codex and Claude sessions remain unchanged. No natural-language intent classifier
or automatic dot continuation is added to the harness.

Implementation checklist:

- [x] Authenticated MCP 2.0 event discovery, subscription and tools.
- [x] Signed webhook verification/delivery with public-address validation.
- [x] Durable chat routing, request IDs and bounded delivery attempts.
- [x] Telegram command/help integration and destination-bound replies.
- [x] Local protocol, failure, restart and routing tests.
- [ ] Real dot subscription and Telegram round trip (requires account setup).

The first version handles text only. Attachments are explicitly rejected on a
dot-bound chat, rather than forwarding inaccessible local file paths to dot.

## Official contracts

- https://developers.openai.com/plugins/build/mcp-events
- https://developers.openai.com/plugins/build/auth

MCP Events uses protocol `2026-07-28`. A webhook acknowledgement means receipt,
not task completion. Dot must invoke the reporting tool to return its answer.
Authentication uses OAuth authorization code + mandatory PKCE S256. The managed
mode uses the established `oidc-provider` protocol implementation and the existing
Telegram owner for approval. No new password account, LLM decision or OpenAI API
key is involved. Custom fixed API-key auth is not a replacement for OAuth linking.

## Managed macOS setup

Use the npm-installed CLI on the Mac hosting RemoteAgent:

```bash
remoteagent dot setup \
  --hostname remoteagent-dot60.appback.app \
  --cloudflared /Users/appback/workspaces/remoteagent/lynrvjru/.runtime/cloudflared \
  --origin-cert /Users/appback/.cloudflared/cert.pem \
  --activate
```

The hostname must belong to the Cloudflare account authorized by that certificate.
If no certificate exists, run `cloudflared tunnel login` using the installed binary
and approve its actual URL. A downloaded certificate can be transferred privately
and passed with `--origin-cert`. Do not paste certificate contents in a chat.

The command creates a dedicated named tunnel, DNS record and user LaunchAgent.
It copies cloudflared out of the session workspace into the private dot transport
directory. It does not alter an existing application tunnel or overwrite a DNS
record owned elsewhere. It exposes only `/mcp`, OAuth discovery and `/oauth/*`;
the unauthenticated local UI on port 3794 remains private. The configuration is
backed up under `dot/setup-backups` before enabling managed OAuth.

`--activate` refuses running-session markers or live non-transport runtime
children before changing anything. It restarts only RemoteAgent's LaunchAgent and
checks the dot metadata endpoint. Without `--activate`, it prepares the transport
and configuration but leaves the existing RemoteAgent process untouched.

Then, in the intended private Telegram bot:

1. Send `/login dot`. The reply contains the real MCP address, plugin registration
   link, subscription instruction and a five-minute one-use owner approval code.
2. Register the MCP address in ChatGPT Plugins with OAuth. Managed OAuth supports
   the official ChatGPT CIMD URLs. If manually configuring a predefined client,
   its public client ID is `remoteagent-dot` (no client secret).
3. Enter the Telegram approval code on the RemoteAgent authorization page. This
   grants access to the prepared Telegram channels on this server. The code is
   not a token to give to an LLM. Cookies, exact origin and CSRF are also checked.
4. Give the selected dot the subscription instruction. Use **연결 확인**, then
   `/start dot`. A real event/report round trip is still the final acceptance gate.

Only the configured Telegram owner can obtain approval codes. Codes live in
bounded process memory, expire after five minutes and are consumed once. OAuth
signing keys, opaque tokens and grants persist in private files under `dot/auth`,
independent of LLM sessions. Access tokens expire in one hour; refresh tokens and
grants in 30 days. Owner or public-origin changes are rejected instead of silently
reusing credentials. At most 4096 OAuth records are retained; expired records are
pruned on writes, with no extra polling timer.

Managed mode accepts callback destinations supplied by the OAuth-authenticated
owner, after public-address/DNS-pinning, HTTPS, no-redirect and signed challenge
checks. It does not require a guessed OpenAI callback hostname. Set
`DOT_CALLBACK_HOSTS` to additionally enforce an exact-host allowlist. External
OAuth mode retains its required explicit callback-host policy.

## Optional External OAuth Configuration

1. Provide a stable HTTPS hostname for the MCP bridge and an existing OAuth 2.1
   authorization server. The identity provider must support authorization-code
   login with PKCE S256 and publish authorization server discovery metadata. Use
   its established consent/login implementation; there is no RemoteAgent password
   page or homemade authorization server.
2. Register the ChatGPT redirect URI displayed by the plugin setup page with that
   identity provider. Configure the resource audience, `remoteagent:dot` scope,
   and the exact approved owner's OAuth subject.
3. Configure the identity provider's introspection endpoint and a confidential
   introspection client using Basic authentication. Introspection must return
   `active`, `sub`, `aud`, `exp` and `scope`. If `iss` is returned, it must match
   `DOT_OAUTH_ISSUER`. Store the client secret in the private installed `.env`
   (mode 600), not in a repository or a dot prompt.
4. Forward only `/mcp` and `/.well-known/oauth-protected-resource` from the HTTPS
   reverse proxy to `127.0.0.1:3796`. The existing unauthenticated local UI on 3794
   is not the dot endpoint and should not be exposed as this plugin.
5. Configure the following values in the installed instance's `.env`:

   ```dotenv
   DOT_ENABLED=true
   DOT_PORT=3796
   DOT_PUBLIC_URL=https://dot-bridge.example.com
   DOT_OAUTH_ISSUER=https://identity.example.com
   DOT_OAUTH_INTROSPECTION_URL=https://identity.example.com/oauth/introspect
   DOT_OAUTH_CLIENT_ID=remoteagent-introspection
   DOT_OAUTH_CLIENT_SECRET=<private identity-provider client secret>
   DOT_OAUTH_SUBJECT=<approved owner's exact OAuth sub>
   DOT_CALLBACK_HOSTS=<exact callback hostname supplied by ChatGPT>
   ```

   These are templates, not working credentials. The actual connection's first
   subscription attempt returns `CALLBACK_HOST_NOT_ALLOWED: <hostname>` when its
   hostname is not allowed. Copy only that hostname into `DOT_CALLBACK_HOSTS`;
   no token, URL path or request body is needed. The bridge fails closed until
   that hostname is explicitly allowed. Restart once after
   initial configuration; an incomplete configuration does not activate dot
   routing and leaves Codex/Claude available. Previously dot-bound chats remain
   paused, rather than silently sending their tasks to a local provider. Use
   `/dot off` in that chat to explicitly restore local routing.

6. Start the development instance normally. In the intended Telegram chat send
   `/login dot`. It displays the actual MCP endpoint, registration/dot links and
   a copyable subscription instruction with an opaque channel ID. Preparing login
   does not change the existing local session or enable dot routing.
7. Connect a private MCP plugin to `https://dot-bridge.example.com/mcp` in ChatGPT
   and complete its OAuth linking flow. Rescan tools/events when they change.
8. In the chosen dot, ask it to subscribe to `telegram.message.created` with the
   exact `channelId`. Tell it to read each complete request using
   `dot_read_request`, perform the task, and send progress/final answers with
   `dot_report`. The subscription's webhook is challenge-verified before any
   Telegram user content is sent. One verified subscriber per channel prevents
   two dots from independently executing the same Telegram instruction.
9. Use the **연결 확인** button from `/login dot`, then `/start dot` once verified.
   `/dot status` must show `Subscription: verified`. Send a short test instruction
   and confirm both the event request ID and the actual `[DOT | result]` Telegram
   reply. Only then mark the live acceptance item complete.

Dot/account availability, plugin permissions, event batching, and cloud task
scheduling are controlled by OpenAI. Local mock tests do not establish actual
account access or end-to-end dot compatibility. The endpoint implements the
documented JSON event methods and JSON tool transport; test it against the real
client before enabling operational use.

## Telegram commands

```text
/login dot     prepare plugin registration and event subscription instructions
/start dot     activate only after the event subscription is verified
/start codex   suspend dot and start a local Codex session
/start claude  suspend dot and start a local Claude session
/dot status    show channel, subscription and latest request delivery state
/dot off       cancel outstanding replies and restore existing local routing
/stop          cancel outstanding dot deliveries/replies
```

`/login dot`, `/dot`, `/status` and `/help` work without a local provider.
`/dot connect` remains a compatibility alias for `/login dot`.
Only the configured Telegram owner in a private chat can connect, send tasks or
change dot state. While dot is connected, local-session commands are rejected
with an explicit `/dot off` instruction. `/start codex` and `/start claude` can
switch providers while preserving the dot subscription. Management commands remain available.
`/stop` cannot stop work already running inside OpenAI's dot; stop that cloud task
in dot itself. It does prevent its canceled requests from reporting back here.

## Delivery, storage and resource limits

- Bot identity is Telegram's numeric ID, not array position or mutable username.
- The model supplies a request ID, report ID, report kind and text. It cannot
  choose a Telegram token, bot or destination chat.
- Full inbound text is retained locally (128 KiB maximum). The event contains a
  bounded preview; `dot_read_request` retrieves the full instruction.
- Progress is not completion. Only a successful `dot_report` with `kind=result`
  closes a request. Long replies can be split into deliberate progress parts,
  followed by one final part, each with its own stable report ID (3000 chars each,
  at most 20 reports per request).
- Repeated Telegram update IDs and report IDs are idempotent. Telegram reports
  use a single send attempt. A connection failure or runtime restart during a
  send records `unknown`; it is not silently retried under a new report ID.
- Event delivery uses the same event ID across at most three attempts. Connection
  failures, HTTP 429 and HTTP 5xx use bounded backoff, respecting `Retry-After`.
  HTTP 410 ends the subscription; HTTP 413 is not retried.
- Callback HTTPS is mandatory. The hostname must be explicitly allowed; every
  connection resolves and validates all destination addresses, pins a public
  address for TLS, and rejects redirects and private/local/special addresses.
- Subscriptions expire within 24 hours and before the current OAuth token's
  expiry. The host must refresh them using a current access token. Access is
  rechecked by introspection before every event delivery, including after
  restart. Expired/revoked authorization stops delivery until relinked/refreshed.
  Signing-secret rotation uses both new and old signatures for a five-minute
  overlap after verification of the new secret.
- State is `DATA_DIR/dot/bridge.json`, with directory mode 700 and file mode 600.
  It contains subscription signing secrets and OAuth delivery authorization, so
  handle it as credential material. It is never exposed through a model tool.
- Maximum 100 channels and 500 request records. Terminal records are pruned on
  enqueue after seven days or at capacity; outstanding work is not discarded to
  create space. Per-request report IDs are retained with their request. Disk-write
  failure pauses the bridge until storage is repaired and the runtime restarts.
- One unref'd 30-second delivery worker processes up to four events per pass,
  serially. This does not poll dot or alter Telegram's existing polling policy.
  The MCP endpoint caps concurrent requests at eight and connections at 32.

## Local verification

Run from the repository with the project's Node.js environment:

```bash
npm run check
npm run selftest:dot
npm run selftest:telegram
npm run selftest:session-dispatch
```

`selftest:dot` exercises OAuth validation, callback signing/ownership, bounded
retry/expiry, stop/disconnect, persistent unknown delivery state and the local MCP
request/report round trip. `selftest:telegram` injects actual command/message
updates into the Grammy bot with a fake curl transport, verifies dot replies use
the originating chat, and checks local provider sessions are preserved. Neither
test uses production Telegram tokens, real dot credentials or live OpenAI calls.

### Validation record (2026-10-22)

- TypeScript build and `npm run check`: passed.
- `npm run selftest:dot`: 19 tests passed, zero failures.
- `npm run selftest:telegram`: passed, including dot command/message injection,
  `/login dot` endpoint/registration/subscription buttons, unverified start
  refusal, verified start, switching back to Codex without losing the dot
  subscription, saved destination delivery and attachment rejection.
- `node scripts/selftest-login.mjs`: passed for existing CLI login paths.
- `npm run selftest:session-dispatch`: passed.
- `npm run selftest:codex-stream`: passed.
- `npm run selftest:model-fallback`: passed.
- `npm run selftest:cli`: passed.
- `git diff --check`: passed.

Real dot OAuth/plugin linking and a live Telegram round trip remain unverified.
Browser approval is additionally tested through a real local HTTPS reverse proxy:

```bash
PLAYWRIGHT_PACKAGE=file:///absolute/path/to/playwright/index.mjs \
PLAYWRIGHT_EXECUTABLE=/absolute/path/to/chromium \
npm run selftest:dot-browser
```

This optional browser test requires OpenSSL and Playwright/Chromium. It uses a
temporary local TLS certificate, fake owner/client data and a locally intercepted
ChatGPT callback, not operational accounts. The approval page uses
`Referrer-Policy: same-origin`: `no-referrer` causes actual browsers to send a form
POST with `Origin: null`, which must remain rejected by the CSRF origin check.
Published to npm as `appback-remoteagent@0.27.0` from source `606f99d`.
Exact version and `latest` were both verified as `0.27.0`. Operational server
updates to 30, 40 and 60 completed; live dot account acceptance is still open.

Follow-up verification added failure-path coverage and corrected three gaps:

- `/stop` and unsubscribe also close failed webhook requests, preventing a late
  cloud reply from bypassing cancellation after an ambiguous delivery failure.
- The ten-second webhook deadline now includes DNS resolution, not only the
  subsequent HTTPS connection.
- Callback verification network failures return the documented callback error
  code with a categorized reason, without returning raw network details.

Additional tests cover interrupted-event replay with the same ID, disk-write
failure blocking unpersisted instructions, and these cancellation/deadline paths.
No configured dot OAuth/HTTPS instance was found in the local installed/repository
environment files during this verification. A live acceptance test therefore
still requires the account/plugin and endpoint setup described above.
