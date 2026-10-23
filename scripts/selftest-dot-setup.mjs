import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {provisionTunnelCredential,reloadTunnelAgent,DOT_HTTPS_PATHS} from './dot-setup-macos.mjs';

const id='3de791c1-06d8-4ef9-bffd-a673945d3a69';
const credentials={TunnelID:id,TunnelSecret:'test-only-fake-tunnel-secret',AccountTag:'test-account'};
test('HTTPS ingress exposes protected G2 routes but never the unauthenticated local UI',()=>{
 const pattern=new RegExp(DOT_HTTPS_PATHS);
 for(const route of ['/mcp','/oauth/auth','/oauth/device/auth','/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/api/v1','/api/v1','/api/v1/targets','/api/v1/requests/req_example/events'])assert.equal(pattern.test(route),true,route);
 for(const route of ['/','/api/sessions','/api/dispatches','/api/v11/targets','/mcp/anything','/.well-known/oauth-protected-resource/private'])assert.equal(pattern.test(route),false,route);
});
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dot-setup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir=path.join(root,'transport'),certDir=path.join(root,'certificates'),standard=path.join(root,'.cloudflared');
 for(const d of [dir,certDir,standard])fs.mkdirSync(d,{mode:0o700});
 return{root,dir,cert:path.join(certDir,'cert.pem'),certDir,standard};
}
test('credentials created beside an explicit origin certificate are staged privately',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.certDir,id+'.json'),JSON.stringify(credentials));
 const target=provisionTunnelCredential(f.dir,f.cert,id,f.root);
 assert.equal(target,path.join(f.dir,id+'.json'));assert.deepEqual(JSON.parse(fs.readFileSync(target)),credentials);
 assert.equal(fs.statSync(target).mode&0o777,0o600);
 fs.rmSync(path.join(f.certDir,id+'.json'));
 assert.equal(provisionTunnelCredential(f.dir,f.cert,id,f.root),target,'reruns retain the private staged credential');
});
test('default cloudflared credential location is supported',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.standard,id+'.json'),JSON.stringify(credentials));
 assert.ok(fs.existsSync(provisionTunnelCredential(f.dir,f.cert,id,f.root)));
});
test('missing or mismatched tunnel credentials fail closed',t=>{
 const f=fixture(t);assert.throws(()=>provisionTunnelCredential(f.dir,f.cert,id,f.root),/missing/);
 fs.writeFileSync(path.join(f.certDir,id+'.json'),JSON.stringify({...credentials,TunnelID:'another-tunnel'}));
 assert.throws(()=>provisionTunnelCredential(f.dir,f.cert,id,f.root),/mismatch/);
 assert.equal(fs.existsSync(path.join(f.dir,id+'.json')),false);
 assert.throws(()=>provisionTunnelCredential(f.dir,f.cert,'../another',f.root),/Invalid tunnel ID/);
});
test('existing staged credential identity is revalidated instead of overwritten',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.dir,id+'.json'),JSON.stringify({...credentials,TunnelID:'wrong'}));
 fs.writeFileSync(path.join(f.standard,id+'.json'),JSON.stringify(credentials));
 assert.throws(()=>provisionTunnelCredential(f.dir,f.cert,id,f.root),/mismatch/);
});

test('launchd asynchronous bootout retries bootstrap without repeatedly stopping the tunnel',async()=>{
 const calls=[];let boots=0;
 await reloadTunnelAgent('gui/501','/private/test.plist',(_file,args)=>{
   calls.push(args);if(args[0]==='bootstrap'&&++boots<3)throw Error('EIO while launchd removes registration');
 },async()=>{});
 assert.equal(boots,3);assert.equal(calls.filter(a=>a[0]==='bootout').length,1);
 assert.ok(calls.filter(a=>a[0]==='bootout').every(a=>a[1]==='gui/501/app.remoteagent.dot-tunnel'));
});
test('bootstrap retries are bounded and do not touch the RemoteAgent runtime',async()=>{
 let boots=0;
 await assert.rejects(()=>reloadTunnelAgent('gui/501','/private/test.plist',(_file,args)=>{
   if(args[0]==='print')throw Error('not registered');
   assert.equal(args[0],'bootstrap');boots++;throw Error('bootstrap failure');
 },async()=>{}),/bootstrap failure/);
 assert.equal(boots,10);
});
