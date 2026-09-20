#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: npm run release:deploy -- <version> <30|40|26|50|110|all>" >&2
  echo "Example: npm run release:deploy -- 0.15.5 all" >&2
}

if [[ $# -ne 2 ]]; then
  usage
  exit 1
fi

VERSION="$1"
TARGET="$2"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  usage
  exit 1
fi

case "$TARGET" in
  30|40|26|50|110|all)
    ;;
  *)
    usage
    exit 1
    ;;
esac

PACKAGE_NAME="appback-remoteagent"
REGISTRY_VERSION="$(npm view "$PACKAGE_NAME@$VERSION" version)"
if [[ "$REGISTRY_VERSION" != "$VERSION" ]]; then
  echo "Registry version check failed for $PACKAGE_NAME@$VERSION" >&2
  exit 1
fi

deploy_30() {
  ssh au2223@192.168.33.30 "VERSION=$VERSION bash -s" <<'REMOTE'
set -euo pipefail
export PATH="/home/au2223/.local/bin:/home/au2223/.nvm/versions/node/v22.22.0/bin:$PATH"
if [[ -L "$HOME/.npm" && ! -e "$HOME/.npm" ]]; then
  echo "Broken npm cache symlink: $HOME/.npm -> $(readlink "$HOME/.npm")" >&2
  exit 1
fi
if [[ -e "$HOME/.npm" && ! -d "$HOME/.npm" ]]; then
  echo "npm cache path is not a directory: $HOME/.npm" >&2
  exit 1
fi
node - <<'NODE'
const fs = require("fs");
const path = "/home/au2223/.remoteagent/bot-polling-state.json";
const state = JSON.parse(fs.readFileSync(path, "utf8"));
const running = Object.values(state.bots || {})
  .filter((bot) => Array.isArray(bot.runningSessionIds) && bot.runningSessionIds.length > 0)
  .map((bot) => `${bot.username || bot.botId}: ${bot.runningSessionIds.join(", ")}`);
if (running.length > 0) {
  console.error("RemoteAgent has active provider work. Retry deploy after it finishes:");
  for (const item of running) console.error(`- ${item}`);
  process.exit(2);
}
NODE
for ATTEMPT in {1..12}; do
  if npm install -g "appback-remoteagent@$VERSION"; then
    break
  fi
  if [[ "$ATTEMPT" -eq 12 ]]; then
    echo "Remote npm install failed after $ATTEMPT attempts." >&2
    exit 1
  fi
  echo "Remote npm registry has not propagated yet; retrying in 5s ($ATTEMPT/12)."
  sleep 5
done
remoteagent-install
if systemctl --user cat remoteagent >/dev/null 2>&1; then
  systemctl --user restart remoteagent
  sleep 5
  systemctl --user is-active remoteagent
else
  sudo -n systemctl restart remoteagent
  sleep 5
  systemctl is-active remoteagent
fi
node -p 'require("/home/au2223/.nvm/versions/node/v22.22.0/lib/node_modules/appback-remoteagent/package.json").version'
journalctl -u remoteagent --since '1 minute ago' --no-pager | tail -80
REMOTE
}

deploy_26() {
  ssh ospadmin@192.168.33.26 "VERSION=$VERSION bash -s" <<'REMOTE'
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
if [[ -L "$HOME/.npm" && ! -e "$HOME/.npm" ]]; then
  echo "Broken npm cache symlink: $HOME/.npm -> $(readlink "$HOME/.npm")" >&2
  exit 1
fi
if [[ -e "$HOME/.npm" && ! -d "$HOME/.npm" ]]; then
  echo "npm cache path is not a directory: $HOME/.npm" >&2
  exit 1
fi
node - <<'NODE'
const fs = require("fs");
const path = `${process.env.HOME}/.remoteagent/bot-polling-state.json`;
if (fs.existsSync(path)) {
  const state = JSON.parse(fs.readFileSync(path, "utf8"));
  const running = Object.values(state.bots || {})
    .filter((bot) => Array.isArray(bot.runningSessionIds) && bot.runningSessionIds.length > 0)
    .map((bot) => `${bot.username || bot.botId}: ${bot.runningSessionIds.join(", ")}`);
  if (running.length > 0) {
    console.error("RemoteAgent has active provider work. Retry deploy after it finishes:");
    for (const item of running) console.error(`- ${item}`);
    process.exit(2);
  }
}
NODE
for ATTEMPT in {1..12}; do
  if npm install -g "appback-remoteagent@$VERSION"; then
    break
  fi
  if [[ "$ATTEMPT" -eq 12 ]]; then
    echo "Remote npm install failed after $ATTEMPT attempts." >&2
    exit 1
  fi
  echo "Remote npm registry has not propagated yet; retrying in 5s ($ATTEMPT/12)."
  sleep 5
done
remoteagent-install
~/.remoteagent/stop-remoteagent.sh || true
sleep 2
~/.remoteagent/start-remoteagent.sh
sleep 5
npm list -g appback-remoteagent --depth=0
pgrep -af 'appback-remoteagent/dist/index.js'
tail -80 ~/.remoteagent/logs/agent.log
REMOTE
}

deploy_40() {
  ssh appback@192.168.33.40 "VERSION=$VERSION bash -s" <<'REMOTE'
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
if [[ -L "$HOME/.npm" && ! -e "$HOME/.npm" ]]; then
  echo "Broken npm cache symlink: $HOME/.npm -> $(readlink "$HOME/.npm")" >&2
  exit 1
fi
if [[ -e "$HOME/.npm" && ! -d "$HOME/.npm" ]]; then
  echo "npm cache path is not a directory: $HOME/.npm" >&2
  exit 1
fi
node - <<'NODE'
const fs = require("fs");
const path = `${process.env.HOME}/.remoteagent/bot-polling-state.json`;
if (fs.existsSync(path)) {
  const state = JSON.parse(fs.readFileSync(path, "utf8"));
  const running = Object.values(state.bots || {})
    .filter((bot) => Array.isArray(bot.runningSessionIds) && bot.runningSessionIds.length > 0)
    .map((bot) => `${bot.username || bot.botId}: ${bot.runningSessionIds.join(", ")}`);
  if (running.length > 0) {
    console.error("RemoteAgent has active provider work. Retry deploy after it finishes:");
    for (const item of running) console.error(`- ${item}`);
    process.exit(2);
  }
}
NODE
for ATTEMPT in {1..12}; do
  if npm install -g "appback-remoteagent@$VERSION"; then
    break
  fi
  if [[ "$ATTEMPT" -eq 12 ]]; then
    echo "Remote npm install failed after $ATTEMPT attempts." >&2
    exit 1
  fi
  echo "Remote npm registry has not propagated yet; retrying in 5s ($ATTEMPT/12)."
  sleep 5
done
remoteagent-install
if systemctl --user cat remoteagent >/dev/null 2>&1; then
  systemctl --user restart remoteagent
  sleep 7
  systemctl --user is-active remoteagent
elif systemctl cat remoteagent >/dev/null 2>&1; then
  HELPER="$HOME/.nvm/versions/node/v22.23.2/lib/node_modules/appback-remoteagent/dist/secret-helper.js"
  SUDO_PASSWORD="$(node "$HELPER" get SUDO_APPBACK_33_40)"
  printf '%s\n' "$SUDO_PASSWORD" | sudo -S -p '' systemctl restart remoteagent
  unset SUDO_PASSWORD
  sleep 7
  systemctl is-active remoteagent
else
  ~/.remoteagent/stop-remoteagent.sh || true
  sleep 2
  ~/.remoteagent/start-remoteagent.sh
  sleep 5
fi
npm list -g appback-remoteagent --depth=0
pgrep -af 'appback-remoteagent/dist/index.js'
if systemctl cat remoteagent >/dev/null 2>&1; then
  systemctl status remoteagent --no-pager -n 20
  tail -80 ~/.remoteagent/logs/agent.log
else
  tail -80 ~/.remoteagent/logs/agent.log
fi
REMOTE
}

deploy_110() {
  ssh appback@192.168.33.110 "VERSION=$VERSION bash -s" <<'REMOTE'
set -euo pipefail
cd "$HOME"
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$HOME/.local/bin:$PATH"
systemctl --user show-environment >/dev/null
sudo -n true
node --input-type=module - <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(`${process.env.HOME}/.remoteagent/bot-polling-state.json`, 'utf8'));
if (Object.values(state.bots || {}).some(bot => bot.runningSessionIds?.length)) throw new Error('Active provider work; deployment aborted.');
NODE
if pgrep -u "$(id -u)" -x codex >/dev/null; then
  echo "Codex process exists; inspect before deploying." >&2
  exit 2
fi
BACKUP="$HOME/.remoteagent/backups/deploy-$VERSION-$(date +%Y%m%dT%H%M%S)"
mkdir -p -m 700 "$BACKUP"
cp -p "$HOME/.remoteagent/.env" "$HOME/.remoteagent/state.json" "$BACKUP/"
npm install -g "appback-remoteagent@$VERSION" --prefer-online
remoteagent-install
sudo -n loginctl enable-linger "$(id -un)"
if systemctl is-active --quiet remoteagent || systemctl is-enabled --quiet remoteagent; then
  remoteagent service migrate
else
  systemctl --user restart remoteagent
fi
sleep 5
systemctl --user is-active remoteagent
if systemctl is-active --quiet remoteagent || systemctl is-enabled --quiet remoteagent; then
  echo "Unexpected system service remains active or enabled" >&2
  exit 1
fi
test "$(node -p 'require(process.env.HOME + "/.nvm/versions/node/v22.23.2/lib/node_modules/appback-remoteagent/package.json").version')" = "$VERSION"
npm list -g appback-remoteagent --depth=0
loginctl show-user "$(id -un)" -p Linger
tail -n 12 "$HOME/.remoteagent/logs/agent.log"
REMOTE
}

deploy_50() {
  ssh root@192.168.33.50 "runuser -u daone -- env VERSION=$VERSION PATH=/home/daone/.nvm/versions/node/v22.23.2/bin:/usr/local/bin:/usr/bin:/bin bash -s" <<'REMOTE'
set -euo pipefail
cd "$HOME"
node --input-type=module - <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(`${process.env.HOME}/.remoteagent/bot-polling-state.json`, 'utf8'));
if (Object.values(state.bots || {}).some(bot => bot.runningSessionIds?.length)) {
  throw new Error('Active provider work; deployment aborted.');
}
NODE
remoteagent-stop
trap 'remoteagent-start' EXIT
npm install -g "appback-remoteagent@$VERSION"
test "$(node -p 'require(process.env.HOME + "/.nvm/versions/node/v22.23.2/lib/node_modules/appback-remoteagent/package.json").version')" = "$VERSION"
# Existing npm installation keeps the same launcher and configuration paths.
remoteagent-start
trap - EXIT
sleep 5
kill -0 "$(cat "$HOME/.remoteagent/remoteagent.pid")"
npm list -g appback-remoteagent --depth=0
tail -n 12 "$HOME/.remoteagent/logs/agent.log"
REMOTE
}

case "$TARGET" in
  30)
    deploy_30
    ;;
  40)
    deploy_40
    ;;
  26)
    deploy_26
    ;;
  50)
    deploy_50
    ;;
  110)
    deploy_110
    ;;
  all)
    deploy_30
    deploy_40
    deploy_26
    ;;
esac
