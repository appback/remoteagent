#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {G2SpeechService} from '../dist/services/g2-speech-service.js';
import {G2RequestService} from '../dist/services/g2-request-service.js';
import {G2ApiService} from '../dist/services/g2-api-service.js';
import {G2ServerService} from '../dist/services/g2-server-service.js';

const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){if(!['--model','--binary','--pcm'].includes(args[i])||!path.isAbsolute(args[i+1]??''))throw Error('Use --model /model.bin --binary /whisper-cli --pcm /sample.pcm');options[args[i]]=args[i+1];}
if(!options['--model']||!options['--pcm']||!options['--binary'])throw Error('Explicit local model, decoder and PCM fixture required');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'g2-live-audio-')),owner='synthetic-live-audio';
const sessions={async listSessions(){return [{sessionId:'isolated-session',publicId:'S010',mode:'codex',codex:{}}];},isSessionBusy(){return false;},isProviderAvailable(){return true;},async routeExternalMessage(_id,_provider,text,_signal,started){started();return [{output:'Synthetic adapter reply: '+text}];}};
const requests=new G2RequestService(dir,owner,sessions);await requests.restore();
const [target]=await requests.inventory(),client={clientId:'remoteagent-g2-live-test',origins:[],redirectUris:[],targetIds:[target.targetId]};
const principal={subject:owner,clientId:client.clientId,targetIds:client.targetIds,expiresAt:Date.now()+600000};
const speech=new G2SpeechService(options['--binary'],options['--model']);await speech.ready();
const api=new G2ApiService(requests,'https://isolated.example.test',[client],async header=>header==='Bearer synthetic-live-test'?principal:undefined,speech);
const server=new G2ServerService(async()=>false,api.handle.bind(api));await server.start(0);
try{
 const url='http://127.0.0.1:'+server.address().port,headers={authorization:'Bearer synthetic-live-test'};
 assert.equal((await fetch(url+'/api/v1/capabilities')).status,401);
 const response=await fetch(url+'/api/v1/audio/transcriptions?targetId='+target.targetId,{method:'POST',headers:{...headers,'content-type':'audio/pcm'},body:fs.readFileSync(options['--pcm'])});
 assert.equal(response.status,200,await response.clone().text());const transcript=await response.json();assert.ok(transcript.text.trim());
 const submitted=await fetch(url+'/api/v1/requests',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({targetId:target.targetId,clientRequestId:'live-voice-test',text:transcript.text})});
 assert.equal(submitted.status,202);const accepted=await submitted.json();
 for(let i=0;i<20&&requests.get(principal,accepted.requestId).status!=='completed';i++)await new Promise(r=>setTimeout(r,25));
 assert.equal(requests.get(principal,accepted.requestId).result.text,'Synthetic adapter reply: '+transcript.text);
 console.log(JSON.stringify({ok:true,realLocalDecoder:true,authenticatedPcmEndpoint:true,sessionAdapter:'synthetic_not_production_codex',physicalG2:false,...transcript}));
}finally{await server.close();fs.rmSync(dir,{recursive:true,force:true});}
