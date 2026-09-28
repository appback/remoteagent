import http from "node:http";
import {timingSafeEqual} from "node:crypto";
import type {BridgeService} from "./bridge-service.js";

// Owner-only loopback bridge. Webaton authenticates its web user before proxying.
export class WebatonApiService {
 private server?: http.Server;
 constructor(private bridge:BridgeService,private token:string,private port=3795){
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
