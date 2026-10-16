// Configure the existing owner-only installation; never prints secret values.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomBytes} from 'node:crypto';import {execFileSync} from 'node:child_process';
const root=path.resolve(process.argv[2]??'');
if(!process.argv[2]||!fs.existsSync(path.join(root,'src/mcp.js')))throw Error('Provide Webaton checkout path');
const data=path.resolve(process.env.DATA_DIR??path.join(os.homedir(),'.remoteagent'));
const tokenFile=path.join(data,'webaton-bridge-token');
fs.mkdirSync(data,{recursive:true,mode:0o700});
if(!fs.existsSync(tokenFile))fs.writeFileSync(tokenFile,randomBytes(32).toString('hex'),{mode:0o600});
fs.chmodSync(tokenFile,0o600);
const envFile=path.join(data,'.env');let contents=fs.readFileSync(envFile,'utf8');
const backup=envFile+'.before-webaton-'+Date.now();fs.copyFileSync(envFile,backup);fs.chmodSync(backup,0o600);
for(const [key,value] of Object.entries({WEBATON_BRIDGE_TOKEN_FILE:tokenFile,WEBATON_MCP_PATH:path.join(root,'src/mcp.js')})){
 contents=contents.replace(new RegExp('^(?:export )?'+key+'=.*(?:\r?\n|$)','gm'),'');
 contents+='\n'+key+'='+JSON.stringify(value)+'\n';
}
fs.writeFileSync(envFile,contents,{mode:0o600});
if(process.platform==='darwin'){
 const plist=path.join(os.homedir(),'Library/LaunchAgents/app.webaton.server.plist');
 if(fs.existsSync(plist)){
  fs.copyFileSync(plist,plist+'.before-webaton');
  execFileSync('python3',['-c','import plistlib,sys; p=sys.argv[1]; d=plistlib.load(open(p,"rb")); d.setdefault("EnvironmentVariables",{})["WEBATON_BRIDGE_TOKEN_FILE"]=sys.argv[2]; plistlib.dump(d,open(p,"wb"))',plist,tokenFile]);
 }
}
console.log('Configuration prepared. No services restarted. Backup: '+backup);
