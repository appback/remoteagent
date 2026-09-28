import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {GeminiAdapter} from '../dist/adapters/gemini-adapter.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ra-gemini-'));
const original=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY='fixture';delete process.env.WEBATON_MCP_PATH;
try{
 let count=0;
 const adapter=new GeminiAdapter(dir,async(url,options)=>{
  assert.equal(new URL(url).hostname,'generativelanguage.googleapis.com');
  assert.equal(options.headers['x-goog-api-key'],'fixture');
  const body=JSON.parse(options.body);assert.equal(body.contents.length,++count===1?1:3);
  return new Response(JSON.stringify({candidates:[{content:{role:'model',parts:[{text:'REPORT:result\nfixture answer'}]}}]}));
 });
 const first=await adapter.send({chatId:'test',remoteSessionId:'test',message:'hello',cwd:dir,model:'fixture-model'});
 assert.equal(first.provider,'gemini');
 await adapter.send({chatId:'test',remoteSessionId:'test',message:'again',cwd:dir,model:'fixture-model',sessionId:first.sessionId});
 const failing=new GeminiAdapter(dir,async()=>new Response('{}',{status:401}));
 await assert.rejects(()=>failing.send({chatId:'test',remoteSessionId:'test',message:'hello',cwd:dir,model:'fixture'}),/GEMINI_REQUEST_FAILED_401/);
 console.log('PASS Gemini authenticated request, continuation, persistence, sanitized failure');
}finally{if(original===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=original;await fs.rm(dir,{recursive:true,force:true});}
