# Server Account Login

Send `/login` in Telegram and select GitHub, Codex, or Claude.
`/help` lists this entry once. Telegram's slash-command menu offers `/login`;
provider names are chosen with buttons, not subcommand autocomplete.
The login applies to the RemoteAgent OS account on that server. Existing
Telegram sessions and their selected models remain unchanged.

Direct commands:

```text
/login github
/login git
/login codex
/login claude
```

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
node scripts/selftest-login.mjs
npm run selftest:telegram
```

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
