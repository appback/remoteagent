import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { BotManagementService } from '../dist/services/bot-management-service.js';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-user-service-'));
const data = path.join(temp, '.remoteagent');
const bin = path.join(temp, 'bin');
const log = path.join(temp, 'calls');
await fs.mkdir(bin);
await fs.mkdir(data);
const originalPath = process.env.PATH;
try {
  const mock = `#!${process.execPath}
const fs=require('node:fs'), path=require('node:path');
const cmd=path.basename(process.argv[1]), a=process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, cmd+' '+a.join(' ')+'\\n');
const user=a.includes('--user');
if(cmd==='loginctl'){console.log('no'); process.exit(0);}
if(cmd==='sudo'){
 if(process.env.SUDO_OK!=='1')process.exit(1);
 if(a.includes('disable'))fs.writeFileSync(process.env.HOME+'/system-stopped','yes');
 if(a.includes('start'))fs.rmSync(process.env.HOME+'/system-stopped',{force:true});
 process.exit(0);
}
if(cmd==='systemd-run')process.exit(0);
if(a.includes('show-environment'))process.exit(process.env.NO_BUS==='1'?1:0);
if(a.includes('cat'))process.exit(user?(process.env.USER_UNIT==='1'?0:1):(process.env.SYSTEM_UNIT==='1'?0:1));
if(user && a.includes('start') && process.env.FAIL_START==='1')process.exit(1);
if(a.includes('is-active')||a.includes('is-enabled'))process.exit(user?0:(process.env.SYSTEM_ACTIVE==='1'&&!fs.existsSync(process.env.HOME+'/system-stopped')?0:1));
process.exit(0);
`;
  for (const name of ['systemctl','systemd-run','sudo','loginctl']) await fs.writeFile(path.join(bin,name),mock,{mode:0o700});
  const env={...process.env,PATH:`${bin}:${originalPath}`,HOME:temp,DATA_DIR:data,CALLS:log};
  const run = (action, extra={}) => spawnSync(process.execPath,['scripts/user-service.mjs',action],{env:{...env,...extra},encoding:'utf8'});
  const install=run('install');
  assert.equal(install.status,0,install.stderr);
  const unit=await fs.readFile(path.join(temp,'.config/systemd/user/remoteagent.service'),'utf8');
  assert.match(unit,/WorkingDirectory=/);
  assert.match(unit,/UMask=0077/);
  assert.match(unit,/dist\/index.js/);
  assert.match(install.stdout,/enable-linger/);
  assert.ok(!(await fs.readFile(log,'utf8')).includes('sudo '));
  assert.notEqual(run('install',{NO_BUS:'1'}).status,0);
  assert.notEqual(run('install',{SYSTEM_UNIT:'1',SYSTEM_ACTIVE:'1'}).status,0);
  await fs.writeFile(path.join(data,'bot-polling-state.json'),JSON.stringify({bots:{x:{runningSessionIds:['S001']}}}));
  assert.match(run('migrate').stderr,/Active work detected/);
  await fs.writeFile(path.join(data,'bot-polling-state.json'),'{}');
  const failedMigration=run('migrate',{SYSTEM_UNIT:'1',SYSTEM_ACTIVE:'1',SUDO_OK:'1',FAIL_START:'1'});
  assert.notEqual(failedMigration.status,0);
  assert.equal(await fs.readFile(path.join(temp,'.config/systemd/user/remoteagent.service'),'utf8'),unit);
  assert.match(await fs.readFile(log,'utf8'),/sudo systemctl start remoteagent/);
  const migrated=run('migrate',{SYSTEM_UNIT:'1',SYSTEM_ACTIVE:'1',SUDO_OK:'1'});
  assert.equal(migrated.status,0,migrated.stderr);
  process.env.PATH=env.PATH; process.env.CALLS=log;
  const manager=new BotManagementService(data,'remoteagent',path.resolve('scripts/restart-after-bot-op.sh'));
  process.env.USER_UNIT='1';
  await manager.ensureSupported();
  await manager.launchRestartJob();
  assert.match(await fs.readFile(log,'utf8'),/systemd-run --user --unit remoteagent-bot-op-/);
  delete process.env.USER_UNIT; process.env.SYSTEM_UNIT='1';
  await assert.rejects(manager.ensureSupported(),/restart permission is missing/);
  console.log('PASS user service: install, bus failure, overlap, active-work guard, user restart job, permission preflight');
} finally {
  process.env.PATH=originalPath;
  delete process.env.USER_UNIT; delete process.env.SYSTEM_UNIT; delete process.env.CALLS;
  await fs.rm(temp,{recursive:true,force:true});
}
