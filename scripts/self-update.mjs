import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const dataDir = process.argv[2];
const pendingPath = path.join(dataDir, 'self-update.json');
const pending = JSON.parse(await fs.readFile(pendingPath, 'utf8'));
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const previous = JSON.parse(await fs.readFile(path.join(packageRoot,'package.json'),'utf8')).version;
const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:${os.homedir()}/.local/bin:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`, DATA_DIR: dataDir };
const run = async (bin,args) => (await exec(bin,args,{env,cwd:os.homedir(),timeout:300000,maxBuffer:1024*1024})).stdout.trim();
async function assertIdle() {
  const state = JSON.parse(await fs.readFile(path.join(dataDir,'bot-polling-state.json'),'utf8'));
  if(Object.values(state.bots??{}).some(b=>b.runningSessionIds?.length)) throw new Error('Active work detected; update cancelled.');
  for (const command of ['codex','claude']) {
    try { await run('pgrep',['-u',String(process.getuid()),'-x',command]); }
    catch(e) { if(e.code===1) continue; throw e; }
    throw new Error('Provider process exists; update cancelled.');
  }
}
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'remoteagent-update-'));
let stopped=false, rollbackArchive;
let stage='idle check';
let result;
try {
  await assertIdle();
  stage='npm version check';
  const latest=await run('npm',['view','appback-remoteagent@latest','version','--prefer-online']);
  if(!/^\d+\.\d+\.\d+$/.test(latest)) throw new Error('Invalid npm version response.');
  if(latest===previous) result=`RemoteAgent is already up to date: ${previous}.`;
  else {
    // Stage both versions before stopping; rollback never depends on a later download.
    const pack=async version=>{
      const output=JSON.parse(await run('npm',['pack',`appback-remoteagent@${version}`,'--json','--pack-destination',temp,'--ignore-scripts','--prefer-online']));
      return path.join(temp,path.basename(output[0].filename));
    };
    stage='download current and new npm packages';
    rollbackArchive=await pack(previous);
    const archive=await pack(latest);
    await assertIdle();
    stage='stop user service';
    await run('systemctl',['--user','stop','remoteagent']);
    stopped=true;
    stage='install npm package';
    await run('npm',['install','-g',archive,'--ignore-scripts']);
    const installed=JSON.parse(await fs.readFile(path.join(packageRoot,'package.json'),'utf8')).version;
    if(installed!==latest) throw new Error('Installed version mismatch.');
    stage='restart and verify user service';
    await run('systemctl',['--user','start','remoteagent']);
    await new Promise(resolve=>setTimeout(resolve,5000));
    await run('systemctl',['--user','is-active','--quiet','remoteagent']);
    stopped=false;
    result=`RemoteAgent updated: ${previous} -> ${latest}. User service is active. Existing sessions and secrets retained.`;
  }
} catch(e) {
  result=`RemoteAgent update failed at: ${stage} (code=${e.code ?? e.name ?? 'unknown'}). See journalctl --user -u "remoteagent-update-*" for diagnostics.`;
  console.error(`Update failed at ${stage}: ${e.code ?? e.name ?? 'error'}`);
  if(stopped) {
    try {
      await run('systemctl',['--user','stop','remoteagent']);
      await run('npm',['install','-g',rollbackArchive,'--ignore-scripts']);
      await run('systemctl',['--user','start','remoteagent']);
      result+=` Restored ${previous}.`;
    } catch { result+=' Rollback failed; administrator action required.'; }
  } else result+=' Existing installation was not stopped.';
} finally {
  await fs.rm(temp,{recursive:true,force:true});
}
await fs.writeFile(path.join(dataDir,'self-update-result.json'),JSON.stringify({message:result,finishedAt:new Date().toISOString()}),{mode:0o600});
try {
  const response=await fetch(`https://api.telegram.org/bot${pending.token}/sendMessage`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({chat_id:pending.chatId,text:result}),signal:AbortSignal.timeout(20000),
  });
  if(!response.ok || !(await response.json()).ok) throw new Error('Telegram delivery failed');
} catch { console.error('Update result not delivered to Telegram; see self-update-result.json.'); }
await fs.rm(pendingPath,{force:true});
