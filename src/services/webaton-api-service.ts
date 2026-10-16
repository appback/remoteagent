import http from "node:http";
import {timingSafeEqual,randomUUID} from "node:crypto";
import {readSecretValue,writeSecretValue} from "./agent-memory-service.js";
import type {BridgeService} from "./bridge-service.js";

// Owner-only loopback bridge. Webaton authenticates its web user before proxying.
export class WebatonApiService {
 private server?: http.Server;
 private runs=new Map<string,{id:string;sessionId:string;status:string;responses?:unknown;error?:string}>();
 private busy=new Set<string>();
 constructor(private bridge:BridgeService,private token:string,private port=3795,private dataDir?:string){
  if(token.length<32)throw Error("WEBATON_TOKEN_TOO_SHORT");
 }
 async start(){
  this.server=http.createServer((req,res)=>{void this.handle(req,res).catch(()=>{
   if(!res.headersSent){res.writeHead(500,{"content-type":"application/json"});res.end('{"error":"REQUEST_FAILED"}');}
  });});
  await new Promise<void>((resolve,reject)=>{this.server!.once("error",reject);this.server!.listen(this.port,"127.0.0.1",resolve);});
 }
 async close(){await new Promise<void>((resolve,reject)=>this.server?this.server.close(e=>e?reject(e):resolve()):resolve());}
 address(){return this.server?.address();}
 private async handle(req:http.IncomingMessage,res:http.ServerResponse){
  const send=(status:number,value:unknown)=>{res.writeHead(status,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify(value));};
  const supplied=req.headers.authorization??"";
  const expected="Bearer "+this.token;
  if(req.headers.origin||Buffer.byteLength(supplied)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))return send(401,{error:"UNAUTHORIZED"});
  const path=(req.url??"").split("?")[0];
  if(req.method==="GET"&&path==="/sessions")return send(200,{sessions:await this.bridge.listSessions()});
  if(path==="/integrations/gemini"&&this.dataDir){
    if(req.method==="GET")return send(200,{configured:!!readSecretValue(this.dataDir,"GEMINI_API_KEY"),model:readSecretValue(this.dataDir,"GEMINI_MODEL")??null});
    if(req.method!=="POST")return send(405,{error:"METHOD_NOT_ALLOWED"});
    let raw="";for await(const chunk of req){raw+=chunk.toString();if(Buffer.byteLength(raw)>4096)return send(413,{error:"BODY_TOO_LARGE"});}
    let body;try{body=JSON.parse(raw);}catch{return send(400,{error:"INVALID_JSON"});}
    if(typeof body?.key!=="string"||body.key.length<10||body.key.length>1000||typeof body.model!=="string"||!/^[a-zA-Z0-9._-]+$/.test(body.model))return send(400,{error:"INVALID_CONFIG"});
    writeSecretValue(this.dataDir,"GEMINI_API_KEY",body.key);
    writeSecretValue(this.dataDir,"GEMINI_MODEL",body.model);
    return send(200,{saved:true});
  }
  if(req.method==="GET"&&path.startsWith("/runs/")){const run=this.runs.get(path.slice(6));return send(run?200:404,run??{error:"NOT_FOUND"});}
  if(req.method==="POST"&&(path==="/sessions"||/^\/sessions\/[a-zA-Z0-9-]+\/runs$/.test(path))){
    let raw="";for await(const chunk of req){raw+=chunk.toString();if(Buffer.byteLength(raw)>16384)return send(413,{error:"BODY_TOO_LARGE"});}
    let body;try{body=JSON.parse(raw);}catch{return send(400,{error:"INVALID_JSON"});}
    if(path==="/sessions"){
      if(!["codex","claude","gemini"].includes(body.provider))return send(400,{error:"INVALID_PROVIDER"});
      const created=await this.bridge.startSession("webaton","web-"+randomUUID(),body.provider);
      return send(201,{session:created.session});
    }
    const sessionId=path.split("/")[2];
    if(typeof body.message!=="string"||!body.message.trim()||body.message.length>4000)return send(400,{error:"INVALID_MESSAGE"});
    if(this.busy.has(sessionId))return send(409,{error:"SESSION_BUSY"});
    if(!(await this.bridge.listSessions()).some(s=>s.sessionId===sessionId))return send(404,{error:"NOT_FOUND"});
    if(this.runs.size>=100){for(const [id,run]of this.runs){if(run.status!=="running"){this.runs.delete(id);break;}}if(this.runs.size>=100)return send(429,{error:"RUN_LIMIT"});}
    const run={id:randomUUID(),sessionId,status:"running"};this.runs.set(run.id,run);this.busy.add(sessionId);
    void this.bridge.routeSessionMessage(sessionId,body.message.trim()).then(responses=>{Object.assign(run,{status:"completed",responses:responses.map(({provider,output,sessionId})=>({provider,output,sessionId}))});},()=>{Object.assign(run,{status:"failed",error:"PROVIDER_EXECUTION_FAILED"});}).finally(()=>this.busy.delete(sessionId));
    return send(202,run);
  }
  const match=path.match(/^\/sessions\/([a-zA-Z0-9-]+)\/(events|messages|stop)$/);
  if(!match)return send(404,{error:"NOT_FOUND"});
  const [,id,action]=match;
  if(req.method==="GET"&&action==="events")return send(200,{events:await this.bridge.sessionEvents(id,100)});
  if(req.method!=="POST")return send(405,{error:"METHOD_NOT_ALLOWED"});
  let size=0;const chunks:Buffer[]=[];
  for await(const chunk of req){size+=chunk.length;if(size>16384)return send(413,{error:"BODY_TOO_LARGE"});chunks.push(chunk);}
  if(action==="stop")return send(200,await this.bridge.stopSessionRun(id));
  if(action!=="messages")return send(405,{error:"METHOD_NOT_ALLOWED"});
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{return send(400,{error:"INVALID_JSON"});}
  if(typeof body?.message!=="string"||!body.message.trim()||body.message.length>4000)return send(400,{error:"INVALID_MESSAGE"});
  const responses=await this.bridge.routeSessionMessage(id,body.message.trim());
  send(200,{responses:responses.map(({provider,output,sessionId})=>({provider,output,sessionId}))});
 }
}
