import assert from 'node:assert/strict';
import {WebatonApiService} from '../dist/services/webaton-api-service.js';
let calls=[];
const bridge={
 listSessions:async()=>[{sessionId:'session-1',publicId:'S001'}],
 sessionEvents:async id=>[{id}],
 routeSessionMessage:async(id,message)=>{calls.push([id,message]);return [{provider:'codex',output:'done',sessionId:id}];},
 stopSessionRun:async id=>({stopped:true,sessionPublicId:id})
};
const token='fixture-token-'.repeat(4);
const server=new WebatonApiService(bridge,token,0);await server.start();
try{
 const base='http://127.0.0.1:'+server.address().port;
 assert.equal((await fetch(base+'/sessions')).status,401);
 const headers={authorization:'Bearer '+token,'content-type':'application/json'};
 assert.equal((await fetch(base+'/sessions',{headers:{...headers,origin:'https://other.test'}})).status,401);
 assert.equal((await (await fetch(base+'/sessions',{headers})).json()).sessions[0].sessionId,'session-1');
 const result=await fetch(base+'/sessions/session-1/messages',{method:'POST',headers,body:JSON.stringify({message:'browser task'})});
 assert.equal(result.status,200);assert.deepEqual(calls,[['session-1','browser task']]);
 assert.equal((await fetch(base+'/sessions/session-1/messages',{method:'POST',headers,body:'{'})).status,400);
 assert.equal((await fetch(base+'/sessions/session-1/messages',{method:'POST',headers,body:'x'.repeat(17000)})).status,413);
 assert.equal((await (await fetch(base+'/sessions/session-1/stop',{method:'POST',headers,body:'{}'})).json()).stopped,true);
 console.log('PASS Webaton API authentication, origin rejection, shared session routing, bounds, stop');
}finally{await server.close();}
