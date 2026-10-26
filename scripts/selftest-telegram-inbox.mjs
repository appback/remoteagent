import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TelegramInbox } from '../dist/services/telegram-inbox.js';

const update=id=>({update_id:id,message:{message_id:id,date:1,chat:{id:111,type:'private'},from:{id:111,is_bot:false,first_name:'Owner'},text:'offline instruction'}});
async function fixture(fn){const root=await fs.mkdtemp(path.join(os.tmpdir(),'ra-inbox-'));try{await fn(root)}finally{await fs.rm(root,{recursive:true,force:true})}}
test('payload and offset survive restart; old dates are not discarded',()=>fixture(async root=>{
  let inbox=new TelegramInbox(root,'123'); await inbox.accept([update(41)]);
  inbox=new TelegramInbox(root,'123'); const state=await inbox.snapshot();
  assert.equal(state.offset,42); assert.equal(state.entries[0].status,'pending');
  assert.equal(state.entries[0].update.message.text,'offline instruction');
  assert.equal((await fs.stat(path.join(root,'telegram-inbox','123.json'))).mode&0o777,0o600);
}));
test('processing is held for review, never automatically rerun',()=>fixture(async root=>{
  let inbox=new TelegramInbox(root,'123'); await inbox.accept([update(41)]); await inbox.transition(41,'dispatching');
  inbox=new TelegramInbox(root,'123'); const item=(await inbox.snapshot()).entries[0];
  assert.equal(item.status,'needs_review'); assert.ok(item.update);
  assert.equal(await inbox.decide(41,'222',true),false);
  assert.equal(await inbox.decide(41,'111',true),true);
  assert.equal(await inbox.decide(41,'111',true),false);
  assert.equal((await inbox.snapshot()).entries[0].status,'pending');
}));
test('completed updates deduplicate and release sensitive payload',()=>fixture(async root=>{
  let inbox=new TelegramInbox(root,'123'); await inbox.accept([update(41)]); await inbox.transition(41,'done');
  inbox=new TelegramInbox(root,'123'); await inbox.accept([update(41),update(42)]);
  const state=await inbox.snapshot(); assert.equal(state.entries.length,2);
  assert.equal(state.entries.find(e=>e.id===41).status,'done');
  assert.equal(state.entries.find(e=>e.id===41).update,undefined);
  assert.equal(state.offset,43);
}));
test('concurrent receipts are serialized; deferred batches stay recoverable',()=>fixture(async root=>{
  const inbox=new TelegramInbox(root,'123'); await Promise.all([inbox.accept([update(1)]),inbox.accept([update(2)])]);
  await inbox.transition(1,'dispatching'); assert.equal(inbox.defer(1),true);
  assert.equal(inbox.consumeDeferral(1),true); assert.equal(inbox.consumeDeferral(1),false);
  assert.equal(inbox.defer(99),false);
  const restarted=new TelegramInbox(root,'123'); assert.deepEqual((await restarted.snapshot()).entries.map(e=>e.status),['needs_review','pending']);
}));
test('corruption and capacity fail closed without advancing durable offset',()=>fixture(async root=>{
  const inbox=new TelegramInbox(root,'123'); await inbox.accept(Array.from({length:1000},(_,i)=>update(i)));
  await assert.rejects(inbox.accept([update(1000)]),/full/);
  assert.equal((await inbox.snapshot()).offset,1000);
  await fs.writeFile(path.join(root,'telegram-inbox','456.json'),'broken');
  await assert.rejects(new TelegramInbox(root,'456').accept([update(1)]));
}));
test('explicit discard is durable',()=>fixture(async root=>{
  const inbox=new TelegramInbox(root,'123'); await inbox.accept([update(1)]); await inbox.transition(1,'needs_review');
  assert.equal(await inbox.decide(1,'111',false),true);
  const item=(await new TelegramInbox(root,'123').snapshot()).entries[0];
  assert.equal(item.status,'done'); assert.equal(item.update,undefined);
}));
