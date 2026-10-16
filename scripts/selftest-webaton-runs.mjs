import assert from 'node:assert/strict';
import {WebatonApiService} from '../dist/services/webaton-api-service.js';
let release;
const bridge={listSessions:async()=>[{sessionId:'known'}],startSession:async(bot,chat,provider)=>({session:{sessionId:'created',mode:provider}}),routeSessionMessage:()=>new Promise(r=>release=r),stopSessionRun:async()=>({stopped:true})};
const server=new WebatonApiService(bridge,'x'.repeat(32),0);await server.start();
const url='http://127.0.0.1:'+server.address().port;const headers={authorization:'Bearer '+'x'.repeat(32),'content-type':'application/json'};
const post=(p,b)=>fetch(url+p,{method:'POST',headers,body:JSON.stringify(b)});
try{
 assert.equal((await post('/sessions',{provider:'unknown'})).status,400);
 assert.equal((await (await post('/sessions',{provider:'gemini'})).json()).session.mode,'gemini');
 const response=await post('/sessions/known/runs',{message:'hello'});assert.equal(response.status,202);const run=await response.json();
 assert.equal((await post('/sessions/known/runs',{message:'duplicate'})).status,409);
 release([{provider:'codex',output:'done',sessionId:'known'}]);
 await new Promise(r=>setTimeout(r,10));
 const result=await (await fetch(url+'/runs/'+run.id,{headers})).json();assert.equal(result.status,'completed');
 assert.equal((await post('/sessions/missing/runs',{message:'hello'})).status,404);
 console.log('PASS creation, async runs, busy rejection, results, unknown session');
}finally{await server.close();}
