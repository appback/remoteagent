import assert from 'node:assert/strict';
import {runTelegramUpload,TelegramUploadError,redactTelegramSecrets} from '../dist/services/telegram-upload.js';
const token='123456789:synthetic-token-only';
for(const [code,bytes,retry] of [[35,0,true],[7,undefined,true],[28,0,true],[56,0,true],[56,2048,false],[28,2048,false],[35,2048,false],[60,0,false],[26,0,false]]){
 let error;
 try{await runTelegramUpload(token,111,'/tmp/fixture.zip',undefined,async(_cmd,args)=>{
  assert.ok(args.includes('-4'));assert.ok(args.includes('--connect-timeout'));
  throw Object.assign(new Error('Command failed curl https://api.telegram.org/bot'+token+'/sendDocument'),{code,stdout:bytes===undefined?'':'\nREMOTEAGENT_UPLOAD:'+bytes+'\n',stderr:'token='+token});
 });}catch(e){error=e;}
 assert.ok(error instanceof TelegramUploadError);assert.equal(error.retryAllowed,retry);
 assert.ok(!error.message.includes(token));assert.ok(!error.stack.includes(token));assert.ok(!error.message.includes('Command failed'));
}
const stdout=await runTelegramUpload(token,111,'/tmp/fixture.zip','caption',async()=>({stdout:'{"ok":true,"result":{"message_id":1}}\nREMOTEAGENT_UPLOAD:1234\n',stderr:''}));
assert.equal(JSON.parse(stdout).result.message_id,1);
assert.equal(redactTelegramSecrets('https://api.telegram.org/bot'+token+'/sendDocument'),'https://api.telegram.org/bot[BOT_TOKEN_REDACTED]/sendDocument');
console.log('PASS upload: pre-upload retry classification, unknown delivery no replay, clean JSON, token/command redaction');
