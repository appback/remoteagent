import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {G2SpeechService,pcmToWav,G2_PCM_MAX_BYTES} from '../dist/services/g2-speech-service.js';

const pcm=()=>Buffer.alloc(32000,2);
test('SDK PCM WAV header preserves exact bytes and rejects silent, short, odd and excessive input',()=>{
  const input=pcm(),wav=pcmToWav(input);
  assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.readUInt32LE(24),16000);
  assert.equal(wav.readUInt16LE(22),1);assert.equal(wav.readUInt16LE(34),16);
  assert.deepEqual(wav.subarray(44),input);
  for(const invalid of [Buffer.alloc(32000),Buffer.alloc(100),Buffer.alloc(6401),Buffer.alloc(G2_PCM_MAX_BYTES+2)])assert.throws(()=>pcmToWav(invalid));
});
function fixture(t,delay=0){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'g2-speech-unit-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const binary=path.join(dir,'decoder'),model=path.join(dir,'model.bin'),marker=path.join(dir,'output-location');
  fs.writeFileSync(model,'synthetic model');
  fs.writeFileSync(binary,`#!${process.execPath}\nconst fs=require('fs');const args=process.argv.slice(2);const out=args[args.indexOf('-of')+1];fs.writeFileSync(${JSON.stringify(marker)},out);setTimeout(()=>fs.writeFileSync(out+'.txt','한국어 테스트 지시'),${delay});`,{mode:0o700});
  return {service:new G2SpeechService(binary,model),marker};
}
test('local decoder receives SDK audio and deletes all temporary audio/text afterward',async t=>{
  const f=fixture(t);await f.service.ready();const result=await f.service.transcribe(pcm());
  assert.equal(result.text,'한국어 테스트 지시');assert.equal(result.durationMs,1000);
  assert.equal(fs.existsSync(path.dirname(fs.readFileSync(f.marker,'utf8'))),false);
});
test('one decoder at a time, client cancellation terminates it and permits the next request',async t=>{
  const f=fixture(t,1000),controller=new AbortController();
  const work=f.service.transcribe(pcm(),controller.signal);
  await assert.rejects(f.service.transcribe(pcm()),/SPEECH_BUSY/);
  while(!fs.existsSync(f.marker))await new Promise(r=>setTimeout(r,10));
  controller.abort();await assert.rejects(work,/SPEECH_CANCELED/);
  assert.equal(fs.existsSync(path.dirname(fs.readFileSync(f.marker,'utf8'))),false);
  assert.equal((await f.service.transcribe(pcm())).text,'한국어 테스트 지시');
});
