#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 1 || ! "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo 'Usage: bash scripts/apply-codex-model-upgrade.sh <Codex CLI version>' >&2
  exit 1
fi
export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v22.23.2/bin:$HOME/.nvm/versions/node/v22.22.0/bin:/opt/homebrew/bin:$PATH"
ROOT="$(npm root -g)/appback-remoteagent"
test -f "$ROOT/scripts/set-codex-model.mjs"
export DATA_DIR="${DATA_DIR:-$HOME/.remoteagent}"
node --input-type=module - <<'NODE'
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const d=process.env.DATA_DIR;
const state=JSON.parse(fs.readFileSync(d+'/bot-polling-state.json','utf8'));
if(Object.values(state.bots||{}).some(b=>b.runningSessionIds?.length))throw Error('Active provider work; retry when idle');
const pid=Number(fs.readFileSync(d+'/remoteagent.lock','utf8').trim());
if(!Number.isSafeInteger(pid)||pid<2)throw Error('Invalid runtime PID');
const rows=execFileSync('ps',['-axo','pid,ppid,comm'],{encoding:'utf8'}).trim().split('\n').slice(1).map(l=>{const m=l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return m&&{pid:+m[1],ppid:+m[2],comm:m[3]}}).filter(Boolean);
if(!rows.some(r=>r.pid===pid))throw Error('Runtime is not live');
const ids=new Set([pid]);for(let i=0;i<rows.length;i++)for(const r of rows)if(ids.has(r.ppid))ids.add(r.pid);
const active=rows.filter(r=>r.pid!==pid&&ids.has(r.pid)&&!/(^|\/)(curl|peekaboo)$/.test(r.comm));
if(active.length)throw Error('Runtime has active child processes; retry when idle');
NODE
if [[ "$(codex --version 2>/dev/null || true)" != "codex-cli $1" ]]; then
  npm install -g "@openai/codex@$1" --prefer-online
fi
remoteagent-stop
trap 'remoteagent-start' EXIT
node "$ROOT/scripts/set-codex-model.mjs" gpt-6.1-sol "$DATA_DIR"
node --input-type=module - "$ROOT" <<'NODE'
import fs from 'node:fs/promises';
const root=process.argv[2],d=process.env.DATA_DIR;
const {CodexUsageFallbackService}=await import(root+'/dist/services/codex-usage-fallback-service.js');
const file=d+'/codex-usage-fallback.json';
try{await fs.copyFile(file,d+'/backups/codex-usage-fallback-'+Date.now()+'.json');}catch(e){if(e.code!=='ENOENT')throw e;}
await new CodexUsageFallbackService(d).clear();
NODE
remoteagent-start
trap - EXIT
sleep 3
codex --version
node --input-type=module - "$ROOT" <<'NODE'
import fs from 'node:fs';
const d=process.env.DATA_DIR;
process.kill(Number(fs.readFileSync(d+'/remoteagent.pid','utf8').trim()),0);
const state=JSON.parse(fs.readFileSync(d+'/state.json','utf8'));
const sessions=Object.values(state.sessions||{}).filter(s=>s.codex);
if(sessions.some(s=>s.codex.model!=='gpt-6.1-sol'))throw Error('Model migration verification failed');
console.log(JSON.stringify({remoteagent:JSON.parse(fs.readFileSync(process.argv[2]+'/package.json','utf8')).version,model:'gpt-6.1-sol',sessions:sessions.length,ids:sessions.map(s=>s.publicId)}));
NODE
