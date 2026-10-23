#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHmac, randomBytes} from 'node:crypto';

const args=process.argv.slice(2), index=args.indexOf('--data-dir');
if(index<0 || !args[index+1] || args.some((arg,i)=>i!==index+1 && !['--data-dir','--initialize-key'].includes(arg))) {
  console.error('Usage: node scripts/g2-targets.mjs --data-dir /absolute/.remoteagent [--initialize-key]');process.exit(1);
}
const dir=path.resolve(args[index+1]),keyFile=path.join(dir,'g2','target-key');
if(!fs.existsSync(keyFile)) {
  if(!args.includes('--initialize-key')) {console.error('G2 target key is not initialized. Operator approval is required before --initialize-key.');process.exit(1);}
  fs.mkdirSync(path.dirname(keyFile),{recursive:true,mode:0o700});
  fs.writeFileSync(keyFile,randomBytes(32),{mode:0o600,flag:'wx'});
}
const key=fs.readFileSync(keyFile);if(key.length!==32)throw Error('G2_TARGET_KEY_INVALID');
const id=(type,reference,provider)=>'tgt_'+createHmac('sha256',key).update(JSON.stringify([type,reference,provider])).digest('hex').slice(0,32);
const state=JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8'));
const dotFile=path.join(dir,'dot','bridge.json');
const dot=fs.existsSync(dotFile)?JSON.parse(fs.readFileSync(dotFile,'utf8')):{channels:[]};
console.log(JSON.stringify({targets:[...Object.values(state.sessions??{}).map(session=>({targetId:id('session',session.sessionId,session.mode),type:'session',provider:session.mode,label:session.publicId})),
  ...dot.channels.map(channel=>({targetId:id('dot_channel',channel.id,'dot'),type:'dot_channel',provider:'dot',channelId:channel.id}))]},null,2));
