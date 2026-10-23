import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const action=process.argv[2];
if(process.platform!=='darwin'||!['start','stop'].includes(action))throw Error('Usage on macOS: node scripts/macos-service.mjs start|stop');
const home=os.homedir(),data=path.resolve(process.env.DATA_DIR||path.join(home,'.remoteagent'));
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const domain='gui/'+process.getuid(),label=domain+'/app.remoteagent.runtime';
const plist=path.join(home,'Library/LaunchAgents/app.remoteagent.runtime.plist');
const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const live=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
let pid=Number(fs.existsSync(data+'/remoteagent.lock')?fs.readFileSync(data+'/remoteagent.lock','utf8'):0);
if(!Number.isSafeInteger(pid)||pid<2||!live(pid))pid=0;
if(pid&&!run('/bin/ps',['-p',String(pid),'-o','args=']).includes(root+'/dist/index.js'))throw Error('Unexpected runtime lock owner; no process was changed');
let job;
try{job=run('/bin/launchctl',['print',label]);}catch(error){if(!/Could not find service|Bad request|not found/i.test(String(error.stderr)))throw error;}
if(action==='start'){
  if(pid){
    if(!job||!new RegExp('\\bpid = '+pid+'\\b').test(job))throw Error('RemoteAgent is running outside its LaunchAgent. Finish work, then use remoteagent-stop and remoteagent-start. No duplicate was started.');
    console.log('RemoteAgent is already managed by launchd, PID '+pid);process.exit(0);
  }
  if(job)run('/bin/launchctl',['kickstart',label]);else run('/bin/launchctl',['bootstrap',domain,plist]);
  console.log('RemoteAgent LaunchAgent start requested.');
}else{
  if(job)run('/bin/launchctl',['bootout',label]);
  if(pid&&live(pid))process.kill(pid,'SIGTERM');
  for(let i=0;pid&&live(pid)&&i<60;i++)await new Promise(r=>setTimeout(r,500));
  if(pid&&live(pid))throw Error('Runtime has not exited; no replacement was started');
  console.log('RemoteAgent stopped.');
}
