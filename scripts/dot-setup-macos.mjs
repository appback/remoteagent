#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import dotenv from 'dotenv';

const usage = 'remoteagent dot setup --hostname remoteagent-dot60.appback.app --cloudflared /absolute/path/cloudflared [--origin-cert /absolute/path/cert.pem] [--activate]';
export const DOT_HTTPS_PATHS = '^/(mcp|\\.well-known/oauth-protected-resource(/api/v1)?|oauth/.*|api/v1(/.*)?)$';
function privateWrite(file, text) {
  const temp=file+'.'+randomUUID()+'.tmp';
  try{fs.writeFileSync(temp,text,{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
export function provisionTunnelCredential(dir, certificate, tunnelId, home=os.homedir()) {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tunnelId))throw Error('Invalid tunnel ID.');
  const target=path.join(dir,tunnelId+'.json');
  const source=[target,path.join(path.dirname(certificate),tunnelId+'.json'),path.join(home,'.cloudflared',tunnelId+'.json')].find(file=>fs.existsSync(file));
  if(!source)throw Error('Tunnel-specific credentials are missing; do not reuse another tunnel.');
  const credentials=JSON.parse(fs.readFileSync(source,'utf8'));
  if(credentials.TunnelID!==tunnelId||typeof credentials.TunnelSecret!=='string'||!credentials.TunnelSecret)throw Error('Tunnel credential identity mismatch.');
  if(source!==target)privateWrite(target,JSON.stringify(credentials));
  fs.chmodSync(target,0o600);
  return target;
}
export async function reloadTunnelAgent(manager, plist, run=execFileSync, delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))) {
  const target=manager+'/app.remoteagent.dot-tunnel';
  let registered=false;
  try{run('/bin/launchctl',['print',target],{stdio:'ignore'});registered=true;}catch{}
  if(registered)run('/bin/launchctl',['bootout',target]);
  let last;
  // launchd may acknowledge bootout before the old registration is fully removed.
  for(let i=0;i<10;i++){
    try{run('/bin/launchctl',['bootstrap',manager,plist]);return;}catch(error){last=error;}
    if(i<9)await delay(500);
  }
  throw last;
}
function assertIdle(data, message) {
  const polling=JSON.parse(fs.readFileSync(path.join(data,'bot-polling-state.json'),'utf8'));
  if(Object.values(polling.bots||{}).some(b=>b.runningSessionIds?.length))throw Error(message);
  const pid=Number(fs.readFileSync(path.join(data,'remoteagent.pid'),'utf8').trim());
  if(!Number.isSafeInteger(pid)||pid<=1)throw Error('Runtime PID is invalid.');
  const rows=execFileSync('/bin/ps',['-axo','pid,ppid,comm'],{encoding:'utf8'}).trim().split('\n').slice(1).map(l=>{const m=l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return m&&{pid:+m[1],ppid:+m[2],comm:m[3]};}).filter(Boolean);
  if(!rows.some(r=>r.pid===pid))throw Error('Runtime PID is not live.');
  const ids=new Set([pid]);for(let i=0;i<rows.length;i++)for(const r of rows)if(ids.has(r.ppid))ids.add(r.pid);
  if(rows.some(r=>r.pid!==pid&&ids.has(r.pid)&&!/(^|\/)curl$/.test(r.comm)))throw Error(message);
}
async function main() {
  const args=process.argv.slice(2);
  if(args.includes('--help')){console.log(usage);return;}
  const activate=args.includes('--activate');if(activate)args.splice(args.indexOf('--activate'),1);
  const values={};
  while(args.length){const flag=args.shift(),value=args.shift();if(!['--hostname','--cloudflared','--origin-cert'].includes(flag)||!value||value.startsWith('--')||values[flag])throw Error(usage);values[flag]=value;}
  const hostname=values['--hostname'];
  if(!hostname||!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname)||hostname.length>253)throw Error('A DNS hostname is required. '+usage);
  if(process.platform!=='darwin')throw Error('This setup command currently installs a macOS user LaunchAgent. Run it on the Mac hosting RemoteAgent.');
  const data=path.resolve(process.env.DATA_DIR||path.join(os.homedir(),'.remoteagent'));
  const envPath=path.join(data,'.env'),raw=fs.readFileSync(envPath,'utf8'),env=dotenv.parse(raw);
  if(!/^\d+$/.test(env.TELEGRAM_OWNER_ID||''))throw Error('Register the Telegram owner first with remoteagent bot add.');
  if(env.DOT_OAUTH_ISSUER||env.DOT_AUTH_MODE==='external')throw Error('An external OAuth provider is configured. Existing authentication was not changed.');
  const port=Number(env.DOT_PORT||3796);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid DOT_PORT.');
  if(activate)assertIdle(data,'Provider work exists. Setup was not changed; retry after work finishes.');
  const publicUrl='https://'+hostname;
  if(env.DOT_PUBLIC_URL&&env.DOT_PUBLIC_URL!==publicUrl)throw Error('An existing dot origin differs; explicit migration is required.');
  const cloudflared=values['--cloudflared'];if(!cloudflared||!path.isAbsolute(cloudflared))throw Error('Provide the installed cloudflared absolute path. '+usage);
  const certificate=path.resolve(values['--origin-cert']||path.join(os.homedir(),'.cloudflared/cert.pem'));
  if(!fs.existsSync(certificate))throw Error('Cloudflare approval is required. Run cloudflared tunnel login, then rerun this exact setup command.');
  const dir=path.join(data,'dot','transport');fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.chmodSync(dir,0o700);
  const binary=path.join(dir,'cloudflared');if(!fs.existsSync(binary))fs.copyFileSync(cloudflared,binary);fs.chmodSync(binary,0o700);
  fs.chmodSync(certificate,0o600);
  const run=(args)=>execFileSync(binary,['tunnel','--origincert',certificate,...args],{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
  const stateFile=path.join(dir,'setup.json');
  const state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):undefined;
  if(state&&state.hostname!==hostname)throw Error('Transport is already associated with another hostname.');
  const name='remoteagent-dot-'+hostname.split('.')[0];
  let tunnels=JSON.parse(run(['list','--output','json']));
  let tunnel=tunnels.find(t=>t.name===name);
  if(tunnel&&!state)throw Error('A tunnel with this name already exists outside this setup. Existing tunnel was not modified.');
  if(!tunnel){
    run(['create',name]);
    tunnels=JSON.parse(run(['list','--output','json']));tunnel=tunnels.find(t=>t.name===name);
    if(!tunnel)throw Error('New tunnel was not found after creation.');
    privateWrite(stateFile,JSON.stringify({hostname,tunnelId:tunnel.id,routed:false}));
  }
  if(state&&state.tunnelId!==tunnel.id)throw Error('Tunnel identity mismatch; existing transport was not changed.');
  const credential=provisionTunnelCredential(dir,certificate,tunnel.id);
  if(!state?.routed){
    run(['route','dns',tunnel.id,hostname]);
    privateWrite(stateFile,JSON.stringify({hostname,tunnelId:tunnel.id,routed:true}));
  }
  const config=path.join(dir,'cloudflared.json');
  const oldConfig=fs.existsSync(config)?fs.readFileSync(config,'utf8'):undefined;
  const nextConfig=JSON.stringify({tunnel:tunnel.id,'credentials-file':credential,ingress:[
    {hostname,path:DOT_HTTPS_PATHS,service:'http://127.0.0.1:'+port,originRequest:{httpHostHeader:hostname}},
    {service:'http_status:404'},
  ]});
  privateWrite(config,nextConfig);
  execFileSync(binary,['tunnel','--config',config,'ingress','validate'],{encoding:'utf8',timeout:10000});
  const label='app.remoteagent.dot-tunnel',plistDir=path.join(os.homedir(),'Library/LaunchAgents');fs.mkdirSync(plistDir,{recursive:true});
  const plist=path.join(plistDir,label+'.plist');
  if(fs.existsSync(plist)&&!state)throw Error('An unmanaged dot tunnel LaunchAgent already exists.');
  let oldPlist;
  if(fs.existsSync(plist))oldPlist=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',plist],{encoding:'utf8'}));
  const nextPlist={Label:label,ProgramArguments:[binary,'--no-autoupdate','tunnel','--config',config,'run',tunnel.id],RunAtLoad:true,KeepAlive:true,
    StandardOutPath:path.join(dir,'tunnel.log'),StandardErrorPath:path.join(dir,'tunnel-error.log'),ThrottleInterval:30};
  privateWrite(plist,JSON.stringify(nextPlist));
  execFileSync('/usr/bin/plutil',['-convert','xml1',plist]);
  const manager='gui/'+process.getuid();
  let registered=false;
  try{execFileSync('/bin/launchctl',['print',manager+'/'+label],{stdio:'ignore'});registered=true;}catch{}
  if(!registered||oldConfig!==nextConfig||!isDeepStrictEqual(oldPlist,nextPlist))await reloadTunnelAgent(manager,plist);
  const backupDir=path.join(data,'dot','setup-backups');fs.mkdirSync(backupDir,{recursive:true,mode:0o700});
  const backup=path.join(backupDir,'before-owner-oauth-'+Date.now()+'.env');fs.writeFileSync(backup,raw,{mode:0o600,flag:'wx'});
  const settings={DOT_ENABLED:'true',DOT_PUBLIC_URL:publicUrl,DOT_AUTH_MODE:'owner'};
  const lines=raw.split(/\r?\n/).filter(l=>!Object.keys(settings).some(k=>new RegExp('^(?:export\\s+)?'+k+'\\s*=').test(l)));
  for(const [key,value]of Object.entries(settings))lines.push(key+'='+value);
  privateWrite(envPath,lines.join('\n').replace(/\n+$/,'')+'\n');
  console.log('Dot tunnel configured: '+publicUrl+'/mcp');
  console.log('OAuth: built in, Telegram-owner approval; no external OAuth server or API key.');
  console.log('Local UI port 3794 is not exposed. Existing application tunnels were not modified.');
  console.log('Configuration backup: '+backup);
  if(activate){
    assertIdle(data,'Configuration prepared, but provider work started during setup. Activation deferred without restarting. Rerun after work finishes.');
    execFileSync('/bin/launchctl',['kickstart','-k',manager+'/app.remoteagent.runtime']);
    let ready=false;
    for(let i=0;i<15;i++){
      await new Promise(resolve=>setTimeout(resolve,1000));
      try{const response=await fetch('http://127.0.0.1:'+port+'/.well-known/oauth-protected-resource',{signal:AbortSignal.timeout(1000)});if(response.ok&&(await response.json()).resource===publicUrl){ready=true;break;}}catch{}
    }
    if(!ready)throw Error('Dot did not become ready. Configuration backup: '+backup+'. Existing sessions were not removed.');
    console.log('Dot OAuth and MCP metadata are ready. Send /login dot in the intended Telegram bot.');
  }else console.log('RemoteAgent was not restarted. Apply the npm release after provider work finishes, then send /login dot.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(error=>{console.error('Dot setup failed: '+String(error.message).replace(/\d{6,}:[A-Za-z0-9_-]+/g,'[REDACTED_BOT_TOKEN]'));process.exitCode=1;});
