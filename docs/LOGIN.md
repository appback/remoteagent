# Server Account Login

Send `/login` in Telegram and select GitHub, Codex, Claude, Dot, or Jev / OpenRouter.
`/help` lists this entry once. Telegram's slash-command menu offers `/login`;
provider names are chosen with buttons, not subcommand autocomplete.
CLI login applies to the RemoteAgent OS account on that server. Dot instead
links a ChatGPT MCP plugin and this chat's event subscription. Existing
Telegram sessions and their selected models remain unchanged.

Direct commands:

```text
/login github
/login git
/login codex
/login claude
/login dot
/login jev
/login <OPENROUTER_API_KEY>
```

## Dot Connection

Use the existing ChatGPT account, not a separate dot account or Codex device code.
On a server with the dot MCP endpoint prepared:

1. Send `/login dot`. It prepares an opaque channel ID without changing the
   current local session or routing incoming work to dot.
2. Press **플러그인 등록** to open `https://chatgpt.com/plugins`, select **+ → Add
   custom MCP server**, enter the displayed MCP URL and name `RemoteAgent`, and
   finish the connection authentication/consent. Reuse a matching existing plugin.
3. Press **Dot 열기**. Enable the RemoteAgent plugin in the intended dot, then
   press **구독 지시문 복사** in Telegram and send that exact instruction to dot.
   It includes this chat's channel ID and asks dot to subscribe, retrieve complete
   messages, execute them and report using `dot_report`.
4. Press **연결 확인** in Telegram. Only an actual verified `events/subscribe`
   request changes the displayed subscription state to confirmed. Clicking a URL
   or sending the instruction alone is not proof of a subscription.
5. Send `/start dot` or press **Dot 시작**. An unverified subscription cannot start.

`/start codex` and `/start claude` switch back through their usual session-start
flow and suspend dot delivery while retaining its channel/subscription for a
later `/start dot`. Active or queued local work blocks switching to dot until it
finishes or the owner stops it. Login can be prepared while local work continues.

The public setup documentation describes a ChatGPT UI registration and a dot
subscription instruction, not a Codex CLI command to register a plugin or control
the existing dot. `/login dot` guides these supported steps; it does not claim to
have performed account consent or fabricate an OAuth device code. If the server
endpoint/authentication is unavailable, it reports that condition without
advertising a placeholder URL or changing the current session. See
[dot infrastructure and validation](DOT_BRIDGE.md).

Official procedures:
https://developers.openai.com/plugins/deploy/connect-chatgpt and
https://developers.openai.com/plugins/build/mcp-events.

## Other Providers

Jev is API-key authentication, not a CLI/browser device login. In an owner-only
private chat, `/login <OPENROUTER_API_KEY>` validates the `sk-or-v1-` key with one
small paid call and stores it in the server Secret Store. Mode remains unchanged;
default is off. See [Jev setup and optional modes](JEV.md).

GitHub uses `gh auth login --hostname github.com --git-protocol https --web`.
Codex uses `codex login --device-auth`.
Claude uses `claude auth login`.
When a selected CLI is missing, choose **설치 후 로그인**. The owner-only button
installs the tool, verifies `--version`, and continues authentication. Codex
and Claude reuse their configured installation hooks. GitHub CLI is downloaded
from the official release with SHA256 verification into `~/.local/bin` on
Linux/macOS (x64/arm64). Windows GitHub CLI installation remains manual:
`winget install --id GitHub.cli`.
Permission errors are reported separately from missing tools. Installation
failure stops the flow before login. Repeated installation clicks are deduplicated
across bots in the same process. Existing installations are verified and reused.

An authenticated account gets a "Log in again" button. A new flow reports
URLs and one-time device codes emitted by the CLI, then checks authentication
after a successful process exit. Complete the browser flow from your PC.
One login per provider can run across all bots in the same RemoteAgent process.
Flows expire after 15 minutes. Restarting RemoteAgent interrupts the flow;
start `/login` again after a restart. Telegram delivery failure is not an
authentication failure: `/login` checks the account again.

Raw CLI output is not forwarded. Only authentication URLs, device codes, and
status messages are delivered. The legacy `/login claude <token>` command
continues to use its configured finish hook. The button flow uses the native
Claude CLI, not the old 15-second start hook.

Local regression tests:

```sh
npm run build
npm run selftest:provider-install
node scripts/selftest-login.mjs
npm run selftest:telegram
```

## macOS Installation Hooks

Provider hooks work without `~/.profile` (the usual zsh setup) and retain an
existing profile when present. `~/.local/bin` is added to PATH before installation.
Codex's npm-installed executable is reused directly when npm's bin directory is
already `~/.local/bin`; a link is created only for a different physical directory.
This also keeps repeated installs from replacing the executable with a self-link.

Run `npm run selftest:provider-install` on Linux and macOS to verify both npm
prefix layouts, missing/existing profiles and repeated installation using mock
executables. It neither calls real providers nor installs npm packages. The npm
publish script runs this test against its clean release snapshot. On macOS it
uses `/bin/bash` to cover the system Bash 3.2 behavior.

CLI references: https://cli.github.com/manual/gh_auth_login and
https://code.claude.com/docs/en/cli-reference.

## Deploy to Server 50

After committing changes, bump the version with `npm run release:version -- patch`,
commit the version files, and push. Publish and deploy the exact version:

```sh
npm run release:publish
npm run release:deploy -- 0.23.6 50
```

The 50 target uses root SSH to run npm and RemoteAgent as `daone`. It checks
for active work, stops the runtime, updates the npm package, and restarts it
from the account home directory. Existing configuration, secrets, and sessions
remain in place. The existing npm launchers do not require installer regeneration.
The historical `all` target remains 30/40/26; select 50 explicitly.
