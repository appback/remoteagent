import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {acquireProcessLock,releaseProcessLock} from '../dist/services/runtime-lock.js';

test('only the lock owner publishes PID and a rejected duplicate cannot overwrite it',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-lock-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const lock=await acquireProcessLock(dir);
 assert.equal(fs.readFileSync(lock,'utf8'),String(process.pid));
 const pid=fs.readFileSync(path.join(dir,'remoteagent.pid'),'utf8');
 const code=`import {acquireProcessLock} from ${JSON.stringify(new URL('../dist/services/runtime-lock.js',import.meta.url).href)};try{await acquireProcessLock(${JSON.stringify(dir)});process.exit(2)}catch(e){if(!e.message.includes('already running'))throw e}`;
 execFileSync(process.execPath,['--input-type=module','-e',code]);
 assert.equal(fs.readFileSync(path.join(dir,'remoteagent.pid'),'utf8'),pid);
 assert.equal(fs.statSync(lock).mode&0o777,0o600);
 releaseProcessLock(lock);assert.equal(fs.existsSync(lock),false);assert.equal(fs.existsSync(path.join(dir,'remoteagent.pid')),false);
});

test('release preserves a PID record owned by another process',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-lock-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const lock=await acquireProcessLock(dir);fs.writeFileSync(path.join(dir,'remoteagent.pid'),'99999');
 releaseProcessLock(lock);assert.equal(fs.readFileSync(path.join(dir,'remoteagent.pid'),'utf8'),'99999');
});

test('concurrent first starts publish one complete lock and preserve its PID',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-race-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const results=await Promise.allSettled([acquireProcessLock(dir),acquireProcessLock(dir)]);
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
 assert.equal(fs.readFileSync(path.join(dir,'remoteagent.lock'),'utf8').trim(),String(process.pid));
 assert.equal(fs.readFileSync(path.join(dir,'remoteagent.pid'),'utf8').trim(),String(process.pid));
 releaseProcessLock(path.join(dir,'remoteagent.lock'));
});

test('macOS start reuses its LaunchAgent and rejects an unmanaged owner without spawning',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mac-service-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'remoteagent.lock'),'4242');fs.writeFileSync(path.join(dir,'remoteagent.pid'),'4242');
 const helper=new URL('./macos-service.mjs',import.meta.url).href,root=path.resolve(new URL('..',import.meta.url).pathname);
 const script=managed=>`
  import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
  Object.defineProperty(process,'platform',{value:'darwin'});process.argv[2]='start';process.env.DATA_DIR=${JSON.stringify(dir)};
  process.kill=(_pid,signal)=>{if(signal!==0)throw Error('Unexpected signal');return true;};
  cp.execFileSync=(file,args)=>{if(file==='/bin/ps')return ${JSON.stringify(root+'/dist/index.js')};if(file==='/bin/launchctl'&&args[0]==='print')return ${JSON.stringify(managed?'state = running\npid = 4242':'state = spawn scheduled')};throw Error('Unexpected mutation '+file);};
  syncBuiltinESMExports();await import(${JSON.stringify(helper)});`;
 assert.match(execFileSync(process.execPath,['--input-type=module','-e',script(true)],{encoding:'utf8'}),/already managed/);
 assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',script(false)],{stdio:'pipe'}),error=>String(error.stderr).includes('No duplicate was started'));
 assert.equal(fs.readFileSync(path.join(dir,'remoteagent.pid'),'utf8'),'4242');
});
