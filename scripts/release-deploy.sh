#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: npm run release:deploy -- <version> <30|26|all>" >&2
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
  30|26|all)
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
  ssh au2223@192.168.0.30 "VERSION=$VERSION bash -s" <<'REMOTE'
set -euo pipefail
export PATH="/home/au2223/.local/bin:/home/au2223/.nvm/versions/node/v22.22.0/bin:$PATH"
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
npm install -g "appback-remoteagent@$VERSION"
remoteagent-install
sudo -n systemctl restart remoteagent
sleep 5
systemctl is-active remoteagent
node -p 'require("/home/au2223/.nvm/versions/node/v22.22.0/lib/node_modules/appback-remoteagent/package.json").version'
journalctl -u remoteagent --since '1 minute ago' --no-pager | tail -80
REMOTE
}

deploy_26() {
  ssh ospadmin@192.168.0.26 "VERSION=$VERSION bash -s" <<'REMOTE'
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
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
npm install -g "appback-remoteagent@$VERSION"
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

case "$TARGET" in
  30)
    deploy_30
    ;;
  26)
    deploy_26
    ;;
  all)
    deploy_30
    deploy_26
    ;;
esac
