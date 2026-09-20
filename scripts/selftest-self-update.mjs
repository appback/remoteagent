import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { requestSelfUpdate } from '../dist/services/self-update-service.js';
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'ra-self-update-'));
const bin=path.join(tmp,'bin'), data=path.join(tmp,'data'), scripts=path.join(tmp,'scripts');
for(const dir of [bin,data,scripts]) await fs.mkdir(dir);
const oldPath=process.env.PATH;
try {
  const fixture=`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),cmd=path.basename(process.argv[1]),a=process.argv.slice(2);
fs.appendFileSync(process.env.CALLS,cmd+' '+a.join(' ')+'\\n');
if(cmd==='pgrep')process.exit(1);
if(cmd==='npm'){
 if(a[0]==='view')console.log(process.env.LATEST);
 if(a[0]==='pack')console.log(JSON.stringify([{filename:'package-'+a[1].split('@').pop()+'.tgz'}]));
 if(a[0]==='install'){
  const version=a.find(x=>x.endsWith('.tgz')).match(/package-(.*)\\.tgz$/)[1];
  if(process.env.FAIL_INSTALL==='1' && version==='1.0.1')process.exit(2);
  fs.writeFileSync(process.env.PACKAGE,JSON.stringify({version}));
 }
}
`;
  for(const cmd of ['npm','systemctl','systemd-run','pgrep']) await fs.writeFile(path.join(bin,cmd),fixture,{mode:0o700});
  const preload=path.join(tmp,'preload.mjs');
  await fs.writeFile(preload,`import cp from 'node:child_process'; import {promisify} from 'node:util'; import {syncBuiltinESMExports} from 'node:module'; const original=cp.execFile; const map=file=>file==='npm'?${JSON.stringify(path.join(bin,'npm'))}:file; cp.execFile=(file,...args)=>original(map(file),...args); cp.execFile[promisify.custom]=(file,...args)=>promisify(original)(map(file),...args); syncBuiltinESMExports(); globalThis.fetch=async()=>({ok:true,json:async()=>({ok:true})});`);
  await fs.copyFile('scripts/self-update.mjs',path.join(scripts,'self-update.mjs'));
  await fs.writeFile(path.join(data,'bot-polling-state.json'),'{}');
  const log=path.join(tmp,'calls');
  process.env.PATH=`${bin}:${oldPath}`; process.env.CALLS=log;
  await requestSelfUpdate(data,'000000:test',1);
  await assert.rejects(requestSelfUpdate(data,'000000:test',1),/pending/);
  const run=async(latest,fail='0')=>{
    await fs.writeFile(path.join(tmp,'package.json'),JSON.stringify({version:'1.0.0'}));
    await fs.writeFile(path.join(data,'self-update.json'),JSON.stringify({token:'test',chatId:1}));
    const result=spawnSync(process.execPath,['--import',preload,path.join(scripts,'self-update.mjs'),data],{
      env:{...process.env,LATEST:latest,FAIL_INSTALL:fail,PACKAGE:path.join(tmp,'package.json')},encoding:'utf8',timeout:15000,
    });
    assert.equal(result.status,0,result.stderr);
    return JSON.parse(await fs.readFile(path.join(data,'self-update-result.json'),'utf8')).message;
  };
  assert.match(await run('1.0.0'),/already up to date/);
  assert.match(await run('1.0.1'),/updated: 1.0.0 -> 1.0.1/);
  assert.match(await run('1.0.1','1'),/Restored 1.0.0/);
  await fs.writeFile(path.join(data,'bot-polling-state.json'),JSON.stringify({bots:{x:{runningSessionIds:['S001']}}}));
  await assert.rejects(requestSelfUpdate(data,'000000:test',1),/Active provider work/);
  const calls=await fs.readFile(log,'utf8');
  assert.match(calls,/systemd-run --user/);
  assert.ok(!calls.includes('000000:test'));
  console.log('PASS self-update: user worker, duplicate guard, latest no-op, install, rollback, active work refusal, token not in command arguments');
} finally {
  process.env.PATH=oldPath; delete process.env.CALLS;
  await fs.rm(tmp,{recursive:true,force:true});
}
