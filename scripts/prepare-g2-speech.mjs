#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {execFileSync} from 'node:child_process';

const options={modelDir:path.join(os.homedir(),'.cache','remoteagent-speech'),binary:'/opt/homebrew/bin/whisper-cli'};
const args=process.argv.slice(2);
if(args.includes('--help')){console.log('node scripts/prepare-g2-speech.mjs [--model-dir /absolute/path] [--whisper-bin /absolute/path]\nPrepares the verified multilingual small model. Does not change .env or restart any service.');process.exit(0);}
for(let i=0;i<args.length;i+=2){
  const key=args[i]==='--model-dir'?'modelDir':args[i]==='--whisper-bin'?'binary':undefined;
  if(!key||!args[i+1]||!path.isAbsolute(args[i+1]))throw Error('Use --help for absolute-path options');options[key]=args[i+1];
}
fs.accessSync(options.binary,fs.constants.X_OK);
execFileSync(options.binary,['--version'],{stdio:'ignore',timeout:10000});
await fsp.mkdir(options.modelDir,{recursive:true,mode:0o700});
const file=path.join(options.modelDir,'ggml-small.bin'),expected='55356645c2b361a969dfd0ef2c5a50d530afd8d5';
async function checksum(file){const hash=createHash('sha1');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex');}
if(!fs.existsSync(file)){
  const temp=file+'.'+randomUUID()+'.part';
  try{
    const response=await fetch('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',{signal:AbortSignal.timeout(240000)});
    if(!response.ok||!response.body)throw Error('MODEL_DOWNLOAD_FAILED');
    let bytes=0;
    const limit=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;callback(bytes>550*1024*1024?Error('MODEL_TOO_LARGE'):null,chunk);}});
    await pipeline(Readable.fromWeb(response.body),limit,fs.createWriteStream(temp,{flags:'wx',mode:0o600}));
    if(await checksum(temp)!==expected)throw Error('MODEL_CHECKSUM_MISMATCH');
    await fsp.rename(temp,file);
  }finally{await fsp.rm(temp,{force:true});}
}
if(await checksum(file)!==expected)throw Error('EXISTING_MODEL_CHECKSUM_MISMATCH');
console.log(JSON.stringify({ready:true,G2_WHISPER_BIN:options.binary,G2_WHISPER_MODEL:file,sha1:expected,serviceChanged:false},null,2));
