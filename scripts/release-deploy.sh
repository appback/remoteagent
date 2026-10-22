#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: npm run release:deploy -- <version> <30|40|26|50|60|110|all>" >&2
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
  30|40|26|50|60|110|all)
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
if systemctl --user cat remoteagent >/dev/null 2>&1; then
  systemctl --user status remoteagent --no-pager -n 20
  journalctl --user -u remoteagent --since '1 minute ago' --no-pager -n 80
elif systemctl cat remoteagent >/dev/null 2>&1; then
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

deploy_60() {
  local HOST_ROOTS_B64
  HOST_ROOTS_B64="$(node -e 'process.stdout.write(Buffer.from(process.env.DOT_HOST_ROOTS || "").toString("base64"))')"
  ssh appback@192.168.33.60 "VERSION=$VERSION ALLOW_STALE_RUNNING=${ALLOW_STALE_RUNNING:-0} ACTIVATE_JEV=${ACTIVATE_JEV:-0} HOST_ROOTS_B64=$HOST_ROOTS_B64 bash -s" <<'REMOTE'
set -euo pipefail
export PATH="$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export DATA_DIR="$HOME/.remoteagent"
PLIST="$HOME/Library/LaunchAgents/app.remoteagent.runtime.plist"
LABEL="gui/$(id -u)/app.remoteagent.runtime"
ROOT="$(npm root -g)/appback-remoteagent"
export ROOT
OLD_VERSION="$(node -p 'require(process.env.ROOT + "/package.json").version')"
node --input-type=module <<'NODE'
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const d=process.env.DATA_DIR;
if(process.env.HOST_ROOTS_B64){
 const roots=JSON.parse(Buffer.from(process.env.HOST_ROOTS_B64,'base64').toString('utf8'));
 if(!Array.isArray(roots)||!roots.length||roots.some(p=>typeof p!=='string'||!p.startsWith('/')||p==='/'||/[\r\n\0']/.test(p)||!fs.statSync(p).isDirectory()))throw Error('DOT_HOST_ROOTS must name existing absolute directories');
}
const dotPath=d+'/dot/bridge.json';
if(fs.existsSync(dotPath)&&JSON.parse(fs.readFileSync(dotPath,'utf8')).messages.some(m=>['pending','sending','accepted'].includes(m.status)))throw Error('Dot requests are active; finish cloud work before deployment');
const hostPath=d+'/dot/host-jobs.json';
if(fs.existsSync(hostPath)&&JSON.parse(fs.readFileSync(hostPath,'utf8')).some(j=>j.status==='running'))throw Error('Dot host jobs are active; inspect before deployment');
const pid=Number(fs.readFileSync(d+'/remoteagent.pid','utf8').trim());
const command=execFileSync('/bin/ps',['-p',String(pid),'-o','args='],{encoding:'utf8'});
if(!command.includes(process.env.ROOT+'/dist/index.js'))throw Error('Runtime PID does not match the expected npm installation');
const rows=execFileSync('/bin/ps',['-axo','pid,ppid,comm'],{encoding:'utf8'}).trim().split('\n').slice(1).map(l=>{const m=l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return m&&{pid:+m[1],ppid:+m[2],comm:m[3]};}).filter(Boolean);
if(!rows.some(r=>r.pid===pid))throw Error('Runtime PID is not live; inspect service before deployment');
const ids=new Set([pid]);for(let i=0;i<rows.length;i++)for(const r of rows)if(ids.has(r.ppid))ids.add(r.pid);
const work=rows.filter(r=>r.pid!==pid&&ids.has(r.pid)&&!/(^|\/)curl$/.test(r.comm));
if(work.length)throw Error('Runtime has non-transport children; finish work before deployment');
const polling=JSON.parse(fs.readFileSync(d+'/bot-polling-state.json','utf8'));
if(Object.values(polling.bots||{}).some(b=>b.runningSessionIds?.length)&&process.env.ALLOW_STALE_RUNNING!=='1')throw Error('Running state present. Inspect first; override only confirmed stale metadata with ALLOW_STALE_RUNNING=1');
NODE
BACKUP="$DATA_DIR/backups/npm-$VERSION-$(date +%Y%m%dT%H%M%S)"
mkdir -p -m 700 "$BACKUP"
cp -p "$PLIST" "$BACKUP/service.plist"
cp -p "$DATA_DIR/run-launchagent.sh" "$BACKUP/runner.sh"
cp -p "$DATA_DIR/state.json" "$DATA_DIR/.env" "$BACKUP/"
if [[ -f "$DATA_DIR/jev.json" ]]; then cp -p "$DATA_DIR/jev.json" "$BACKUP/"; fi
# Unload only RemoteAgent. Other application services and browser runtimes stay up.
RUNTIME_PID="$(cat "$DATA_DIR/remoteagent.pid")"
launchctl bootout "$LABEL"
# Older installations may have started the npm runtime outside launchd.
if kill -0 "$RUNTIME_PID" 2>/dev/null; then
  kill -TERM "$RUNTIME_PID"
  for ATTEMPT in {1..30}; do
    if ! kill -0 "$RUNTIME_PID" 2>/dev/null; then break; fi
    sleep 1
  done
  if kill -0 "$RUNTIME_PID" 2>/dev/null; then
    echo "Old runtime did not exit; do not start a duplicate." >&2
    exit 1
  fi
fi
rollback() {
  trap - ERR
  launchctl bootout "$LABEL" 2>/dev/null || true
  npm install -g "appback-remoteagent@$OLD_VERSION" --prefer-online || true
  cp -p "$BACKUP/service.plist" "$PLIST"
  cp -p "$BACKUP/runner.sh" "$DATA_DIR/run-launchagent.sh"
  cp -p "$BACKUP/.env" "$DATA_DIR/.env"
  if [[ -f "$BACKUP/jev.json" ]]; then cp -p "$BACKUP/jev.json" "$DATA_DIR/jev.json"; else rm -f "$DATA_DIR/jev.json"; fi
  launchctl bootstrap "gui/$(id -u)" "$PLIST" || true
  echo "Deployment failed; attempted rollback. Backup: $BACKUP" >&2
}
trap rollback ERR
npm install -g "appback-remoteagent@$VERSION" --prefer-online
test "$(node -p 'require(process.env.ROOT + "/package.json").version')" = "$VERSION"
node --input-type=module <<'NODE'
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const home=process.env.HOME,d=process.env.DATA_DIR,root=process.env.ROOT;
if(process.env.HOST_ROOTS_B64){
 const roots=JSON.parse(Buffer.from(process.env.HOST_ROOTS_B64,'base64').toString('utf8'));
 const {DotHostService}=await import(root+'/dist/services/dot-host-service.js');
 const probe=new DotHostService(d,roots);probe.close();
 const envFile=d+'/.env';
 let text=fs.readFileSync(envFile,'utf8');
 for(const [key,value] of [['DOT_HOST_ENABLED','true'],['DOT_HOST_ROOTS',"'"+JSON.stringify(roots)+"'"]]){
  const pattern=new RegExp('^'+key+'=.*$','m');
  text=pattern.test(text)?text.replace(pattern,()=>key+'='+value):text+'\n'+key+'='+value+'\n';
 }
 fs.writeFileSync(envFile,text,{mode:0o600});
 console.log('Dot host tools enabled for',JSON.stringify(roots));
}
const file=home+'/Library/LaunchAgents/app.remoteagent.runtime.plist';
const config=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',file],{encoding:'utf8'}));
const runner=d+'/run-launchagent.sh';
fs.writeFileSync(runner,'#!/bin/bash\nset -euo pipefail\nexport PATH="$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"\ncd "$HOME"\nset -a\nsource "$HOME/.remoteagent/.env"\nset +a\nexport DATA_DIR="$HOME/.remoteagent"\necho $$ > "$DATA_DIR/remoteagent.pid"\nexec '+JSON.stringify(process.execPath)+' '+JSON.stringify(root+'/dist/index.js')+'\n',{mode:0o700});
config.ProgramArguments=['/bin/bash',runner];config.WorkingDirectory=home;config.RunAtLoad=true;
fs.writeFileSync(file,JSON.stringify(config));execFileSync('/usr/bin/plutil',['-convert','xml1',file]);
if(process.env.ACTIVATE_JEV==='1'){
 const {JevService}=await import(root+'/dist/services/jev-service.js');const service=new JevService(d);
 if(!service.status().configured)throw Error('Jev key missing; cannot activate review');
 console.log('Jev',JSON.stringify(service.setMode('on')));
}
NODE
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 5
launchctl print "$LABEL" | grep -E 'state =|pid =|last exit code'
PID="$(cat "$DATA_DIR/remoteagent.pid")"
kill -0 "$PID"
ps -p "$PID" -o args= | grep -F "$ROOT/dist/index.js"
trap - ERR
echo "Deployed npm $VERSION; backup: $BACKUP"
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
  60)
    deploy_60
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
