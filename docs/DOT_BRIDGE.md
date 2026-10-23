# Dot Telegram Bridge

Direct G2 clients use the optional authenticated [G2 Request API](G2_API.md),
not the unauthenticated local UI. Its grants and `g2.message.created` subscriptions
are separate from the existing ChatGPT/Telegram flow and disabled by default.

## Release 0.30.0 Record

Published and deployed to Mac60 on 2026-10-23 from release commit e27e00c.
npm latest=0.30.0, tarball SHA-1=ae917ee8f97e0f380eeb18bf52315cffbee6bf7e.
The canonical publisher passed all snapshot gates, including 77 combined tests,
G2/dot browser OAuth, login DOM, Telegram injection, dispatch and upload tests.
Registry processing completed on verification attempt 29; no second upload or
credential change was made. Deployment waited for the active dot request's actual
final report, then ran `npm run release:deploy -- 0.30.0 60` without activation flags.

Runtime PID: 52884. Backup:
`/Users/appback/.remoteagent/backups/npm-0.30.0-20261023T150827`.
All 13 session IDs, Secret Store hash, .env hash and OAuth identity hash were
unchanged. Both existing Cloudflare tunnel PIDs were preserved. HTTPS resource
metadata returned successfully, unauthenticated MCP returned 401, and the existing
authenticated ChatGPT connection's dot_host_info succeeded after restart.
G2 remained unconfigured/disabled (`/api/v1/targets` returned 404); no G2 callback,
target allowlist or OAuth grant was installed. Telegram attachments are shipped,
but a cloud dot attachment round trip is not claimed by these deployment checks.

## Release 0.29.0 Record

Published and deployed to Mac60 on 2026-10-23 from release commit 38e926b.
npm latest=0.29.0, tarball SHA-1=8b0d46b9e653651b3340ca1094c19ce2e3edbf4f.
The canonical publisher passed its isolated snapshot checks (including 55 combined
bridge/host/OAuth/Mac/login tests, browser OAuth/login-form gates and Telegram
regressions). Registry visibility was confirmed on processing attempt 13; the
package was not republished while pending.

Deployment command:

```bash
ACTIVATE_MAC=1 npm run release:deploy -- 0.29.0 60
```

The installed npm package passed a real GUI screen-capture probe and native input
permission checks before DOT_MAC_* was enabled. LaunchAgent restarted only
RemoteAgent. All 13 existing session IDs and Secret Store contents were preserved;
Cloudflare tunnel processes were not restarted. Backup:
/Users/appback/.remoteagent/backups/npm-0.29.0-20261023T104027.

Post-update existing ChatGPT connector dot_host_info succeeded against the real
Mac, proving saved OAuth/host access survived. Protected MCP rejected unauthenticated
requests with 401. New tool discovery may require the ChatGPT RemoteAgent 60
connection's Refresh tools action; the deployment does not claim that a cached
cloud dot conversation has already invoked the new Mac/AutoFill tools.

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
- [x] Real dot subscription and Telegram round trip on Mac 60 (2026-10-22).

Telegram photos, documents, voice/audio and video attachments use the existing
Telegram downloader and artifact storage. The caption and attachment metadata
belong to the same durable dot request. `dot_read_request` lists opaque attachment
IDs; `dot_read_attachment` retrieves their contents using the existing owner OAuth
authorization. No Telegram token, download URL or local upload path is exposed.
Small UTF-8 text files include a text preview; other files return exact base64
chunks (192 KiB each, `nextOffset`/`eof`). Image mode returns native MCP image
content for PNG/JPEG/GIF/WebP up to 4 MiB. Larger images use bytes mode.
Each file is limited to 20 MiB; existing artifact cleanup still owns retention.
Missing/changed files fail explicitly, and attachment IDs from another request
or owner are rejected. Contents are untrusted task data, not harness policy.
These changes require publishing/deployment and MCP tool refresh before use.

Attachment validation (2026-10-23, local; not an operational dot round trip):
TypeScript build and 58 combined bridge/OAuth/host/Mac/login tests passed.
The Telegram injection test passed actual message-handler/download integration
with a synthetic curl transport, caption preservation, duplicate-update request
deduplication and reading the downloaded file. MCP HTTP tests verified native
image content, UTF-8 text and byte-exact chunk reconstruction. Restart persistence,
wrong owner/request, symlink escape, changed/deleted files and canceled requests
were also checked. No production service was restarted for these tests.

## Direct Safari And Mac Desktop Control

Dot controls this Mac directly; the Webaton adapter and its tools/configuration
have been removed from RemoteAgent. A separate Webaton checkout, its data and its
unrelated running services are not deleted by this change.

Capture uses the existing approved Node executable in the user's GUI session.
A uniquely labelled, one-shot launchd job runs Apple's screencapture into a private
temporary directory, resizes the result to at most 1500 pixels, and returns an MCP
image block. The job and temporary files are removed afterward. No fixed shared
screenshot file or additional capture-app window is required. The existing
RemoteAgent Screen Access app is not modified or replaced.

Input/app/window control uses the pinned native Peekaboo 4.9.6 engine through the
official MCP SDK's private stdio transport. Dot reasons directly: no secondary
agent, vision LLM, API key or Webaton service is involved.

Install the native input engine:

```bash
node "$(npm root -g)/appback-remoteagent/scripts/install-mac-control.mjs"
```

Mac60 configuration:

```dotenv
DOT_MAC_ENABLED=true
DOT_MAC_BINARY=/Users/appback/.local/bin/peekaboo
DOT_MAC_BRIDGE_SOCKET='/Users/appback/Library/Application Support/Peekaboo/daemon.sock'
DOT_MAC_FOREGROUND=true
DOT_MAC_SCREEN_BACKEND=native
```

Publish/deploy the committed release through the canonical npm scripts. To enable
the tested direct Mac adapter on Mac60 during a release (version is an example):

```bash
npm run release:version -- minor
# Commit and push the release files before release:publish.
npm run release:publish
ACTIVATE_MAC=1 npm run release:deploy -- 0.29.0 60
```

The deploy script preserves the current data directory and backs up configuration.
It refuses active provider/dot/host/Mac input work, installs that exact npm version,
then checks the new native tools, a real GUI screenshot and input permissions before
enabling DOT_MAC_* and starting the runtime. Failure restores the previous package
and configuration. ACTIVATE_MAC omitted preserves existing feature configuration.
An idle owned Peekaboo MCP transport is not mistaken for active provider work.

Use dot_mac_status, then dot_mac_image to verify capture. Peekaboo's separate
Screen Recording flag does not describe Node's screen permission. Native readiness
becomes true after a real Node capture and a successful native input permission
check. If the actual capture fails, report the exact unavailable GUI/Node identity;
do not ask for a new Peekaboo screen grant when Node capture already works.
macOS consent is never granted or bypassed by the harness.

Tools: dot_mac_status, dot_mac_image, dot_mac_app, dot_mac_window,
dot_mac_click, dot_mac_type, dot_mac_press, dot_mac_scroll, dot_mac_forget.
Native capture mode omits dot_mac_see because it would depend on a different
screen permission. Use fresh desktop pixels and native window bounds; resized
image pixels and display-point input coordinates are not interchangeable.

All calls require owner OAuth and the originating Telegram request ID. Mutations
also require operationId, with durable deduplication and a 256-receipt bound.
A dispatched_unverified native receipt is delivery, not verified success; inspect
the screen before the next action and never blindly resend input. Interruptions
remain unknown and are never automatically replayed. /stop blocks further input;
it does not undo clicks or quit other applications. Screenshots are not retained
in operation history. The backend is opt-in and creates no periodic LLM work.

Verification:

```bash
npm run selftest:dot-mac
MAC_TEST_IMAGE_OUTPUT=/private/tmp/remoteagent-direct-proof.png \
  node scripts/selftest-dot-mac-direct-live.mjs
```

2026-10-23 validation: 46 bridge/host/OAuth/native-Mac tests and the Telegram update
regression passed. Ten native-Mac protocol tests use explicit fixtures, not real
desktop evidence. Actual Mac60 verification: native GUI Node capture returned real desktop
pixels without a new permission grant. In an isolated local Safari page, keyboard
navigation changed the visible heading to KEYBOARD VERIFIED; an observed-coordinate
mouse click changed it to CLICK VERIFIED. Both screenshots were visually inspected.
Dispatch receipts alone were not accepted as this proof. Existing production
RemoteAgent, the Cloudflare tunnel and unrelated applications were not restarted.
The new adapter is not yet npm-published or enabled in production.

Primary native engine contracts:
- https://peekaboo.sh/MCP.html
- https://peekaboo.sh/permissions.html

### Representative Task Acceptance (2026-10-23, Mac60)

These tasks exercised the compiled adapter on the actual Mac in an isolated
directory, not a simulated desktop or the developer's Windows browser:

| Task | Actual observed evidence | Result |
| --- | --- | --- |
| Read code | Installed dot-host-service.js read through DotHostService and opened visibly in TextEdit | Passed |
| Preserve code | SHA-256 before/after: 0a2d366a7a78adabd80c69cdad6037c28320d0ada01def19708d3348773988b6 | Unchanged |
| Browse and click | Safari example.com, click Learn more, observe iana.org Example Domains | Passed |
| Cloudflare | Existing login, appback.app overview, DNS Records; 35/200 record usage and actual rows visible | Passed, read-only |
| Product search | Google query Apple Magic Mouse USB-C Apple Korea, visible results, click Apple's white Mouse result | Passed |
| Explain product | Apple page shows Magic Mouse USB-C, white Multi-Touch surface, KRW 99,000, rechargeable wireless use, gestures and USB-C cable | Passed |
| Leave page open | Returned product page to top and left it as Safari's active tab; no cart/purchase action | Passed |
| MCP HTTP | Unauthorized request rejected; owner-bound code read and actual screenshot returned as an MCP image; no Webaton tools | Passed |

Proof screenshots are diagnostic files named ra-acceptance-*.png in the developer's
Windows Temp directory, not committed or publicly uploaded. Cloudflare was
inspected, not reconfigured or fully audited. The price is an observation of the
test page, not a future price guarantee. Code and DNS/service settings were not
changed by these task checks.

Reproduce isolated MCP acceptance on the Mac after building:

```bash
node scripts/selftest-dot-mac-mcp-live.mjs
```

This test uses a local test-owner authenticator and isolated bridge, not production
dot or Telegram. Owner OAuth has separate real-library regression coverage. The
cloud dot client's discovery, invocation and Telegram round-trip for the new tools
still require deployment and connection refresh; local acceptance is not proof of
that production round-trip.

## Direct Host Execution Configuration

### Login And Password Managers

Reuse the existing signed-in browser session first, then 1Password or Safari's
existing AutoFill UI. Dot can operate that UI with native screen/input tools; it
does not export a vault, retrieve a manager's master password or copy entries into
RemoteAgent. Manager unlock, Touch ID, passkey user-presence and OTP require the
owner. An installed application is not proof of an unlocked/configured vault.
Mac60 has Apple's Passwords app; no 1Password app/CLI was found during inspection.

Tools:
- dot_mac_autofill: use existing Apple Passwords directly. With action=safari,
  observe the login page and pass coords for its visible login field/key icon in
  native display points; Safari itself offers matching saved accounts. With
  action=passwords, open the existing macOS Passwords app for owner management.
  No password export, new credential store or JavaScript-from-Apple-Events setting
  is required for this native AutoFill UI path. Do not use contact/card AutoFill.
- dot_mac_login_status: manager presence and preferred UI workflow, no credentials.
- dot_mac_login_profiles: explicitly registered fallback aliases/URLs/permission.
- dot_mac_login: private fallback fill/optional submit by profileId, operationId
  and submit boolean. No password/username tool arguments are accepted.

When existing manager AutoFill cannot be used, an owner may register a fallback
through the existing /secret command (replace placeholders privately):

```text
/secret set SITE_LOGIN_EXAMPLE {"url":"https://example.com/login","username":"ACCOUNT","password":"PASSWORD","allowAutoLogin":true}
```

The alias is example. Set allowAutoLogin=false to retain it without permitting
automatic fill. Delete with /secret remove SITE_LOGIN_EXAMPLE. This is server-wide
Secret Store data, not session workspace data. Do not put these values in prompts,
git, command arguments or documents. An alternative local registration command is:

```bash
node "$(npm root -g)/appback-remoteagent/scripts/site-login.mjs" save example < /private/path/profile.json
node "$(npm root -g)/appback-remoteagent/scripts/site-login.mjs" list
```

The private input file uses the same four JSON fields; protect it with mode 600
and remove it after registration. The existing Secret Store is an OS-permission-
protected JSON file (mode 600), NOT a new encrypted/1Password-equivalent vault.
This change does not claim to protect it from the same OS account or root.

Fallback requires the current Safari HTTPS origin AND path to match the saved
login page. It fills only a single visible username/password pair within one
same-origin POST form. Other origins, redirects, GET forms, ambiguous fields,
iframes, unsupported split-step login pages and disabled profiles are refused.
Safari Automation and JavaScript-from-Apple-Events permission must already allow
the private injection; the harness never enables those settings or bypasses an
OS prompt. Credentials travel to osascript via stdin, never argv, tool results or
native stderr. Input events support reactive forms. submit defaults to false;
true uses the form's requestSubmit. A submitted form is explicitly unverified
authentication and requires observation. Durable operation receipts prevent
duplicate login submission; unknown outcomes are never automatically replayed.

Verification:

```bash
npm run selftest:dot-login
PLAYWRIGHT_PACKAGE=/absolute/path/to/playwright/index.mjs \
  PLAYWRIGHT_EXECUTABLE=/absolute/path/to/chromium \
  node scripts/selftest-dot-login-browser.mjs
```

Browser verification uses synthetic credentials and intercepted HTTPS responses,
not real user accounts or an unlocked 1Password vault. Production Safari login
and manager account selection require an owner-provided saved login and available
OS/browser authorization; do not claim those authenticated flows from fixture tests.
Validation: 52 combined bridge/host/OAuth/native/login tests and the synthetic
browser DOM fill/POST test passed. No real vault/password entry was opened.

Native Apple Passwords update (2026-10-23): 55 combined tests passed. On actual
Mac60, Safari's HTTPS GitHub login page displayed a saved matching account; invoking
dot_mac_autofill at the observed key-icon target opened the native account chooser.
The chooser, not a login result, was visually verified. No account was selected,
password revealed/exported, credential copied into Secret Store or form submitted.
The menu-based prototype was replaced by the observed field/key-icon path because
Safari's AutoFill submenu state varies with focus and lazy accessibility menus.
An unlocked vault or successful authenticated login is not inferred from the
chooser. Actual macOS authentication requirements remain unchanged.

Dot can execute commands and read/edit files directly through RemoteAgent without
delegating to Codex or Claude. This is a separate, explicit owner opt-in; installing
or linking the text bridge alone does not enable host execution.

On the host, add these settings to `~/.remoteagent/.env` using real, existing
absolute directories, then restart the idle RemoteAgent runtime once:

```dotenv
DOT_HOST_ENABLED=true
DOT_HOST_ROOTS='["/Users/appback/workspaces/remoteagent"]'
```

The directories above are examples, not automatically created or enabled paths.
An invalid configuration disables host tools while preserving the text bridge.
Refresh the MCP connection in ChatGPT after deployment to discover the new tools.
Existing OAuth and request ownership checks also protect all host tool calls.

- `dot_host_info(requestId)`: actual host OS, hostname, directories and limits.
- `dot_host_exec(requestId, operationId, command, cwd, timeoutSeconds?)`: start an
  asynchronous `/bin/bash -c` job. Reuse the same operation ID and identical
  arguments after a transport failure; it returns the existing job, not a rerun.
- `dot_host_job(requestId, jobId)`: output, status, exit code and signal.
- `dot_host_cancel(requestId, jobId)`: terminate that job's process group.
- `dot_host_file(requestId, action, path, content?, expectedSha256?)`: list/read/write.
  Read the file first; pass its returned hash to replace it, or null to create a
  new file. Maximum 32 KiB, UTF-8 only. Parent directories must already exist.
- `dot_host_forget(requestId, jobId)`: remove a finished job's output and retry
  record. Never retry the original exec operation after forgetting it.

Example instruction through Telegram:

```text
60 Mac에서 dot_host_info로 작업 경로를 확인하고, 해당 경로에서 pwd와
sw_vers를 실행해. 작업 종료 코드와 실제 출력으로 결과를 보고해.
```

No additional LLM API key is needed. Dot performs the reasoning; RemoteAgent only
executes tools. Jobs are limited to two concurrent commands, 600 seconds by
default (maximum 3600), 32 KiB output per stream and 64 saved job records. When
the history is full, forget reviewed terminal jobs before starting another job.
There is no extra periodic job scheduler. Job records are private mode 600 files.
Completed output is persisted; running output may be lost after an abrupt crash.
Storage failures disable new starts rather than crashing the messaging runtime.

`/stop`, switching away from dot and disconnecting the channel cancel active
request jobs. Cancellation sends TERM followed by KILL after two seconds if still
needed; it does not undo writes already performed. Orderly runtime exit stops tracked
process groups. On restart, unfinished job records become `interrupted`; commands
are never automatically replayed. A new owner instruction is needed to retry.

**Privilege boundary:** working-directory roots restrict file tools and command
cwd, not the shell's capabilities. Shell commands have the RemoteAgent OS user's
filesystem and network privileges, including potential access to files outside
those roots. This is not a security sandbox. RemoteAgent does not forward its bot
tokens, OAuth credentials or secret-helper environment to children, but this is
not isolation from the user's on-disk credentials. Use a dedicated OS account or
OS sandbox if stronger isolation is required. No sudo password injection or
interactive terminal is provided. There are no screen/keyboard/click tools in
this implementation; GUI automation requires separate tools and macOS permissions.

## Official contracts

- https://developers.openai.com/plugins/build/mcp-events
- https://developers.openai.com/plugins/build/auth

MCP Events uses protocol `2026-07-28`. A webhook acknowledgement means receipt,
not task completion. Dot must invoke the reporting tool to return its answer.
Normal Telegram request enqueue is silent, including repeated delivery of the same
update. Progress/results and errors remain visible; `/dot status` provides request
IDs and queue/delivery status when explicitly requested.
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
Managed infrastructure on 60 is now configured at
`https://remoteagent-dot60.appback.app/mcp` (npm 0.27.4). Public metadata, the real
ChatGPT CIMD authorization entry point and browser form-origin/cookie handling
were checked. Completed owner consent and a real dot event/report are separate
remaining acceptance gates; they are not implied by those infrastructure checks.
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
