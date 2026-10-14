import fs from "node:fs";
import path from "node:path";
import {createHash, randomUUID, timingSafeEqual} from "node:crypto";
import type {FileStore} from "../store/file-store.js";

type Receipt = {id:string;requestId:string;sourceSessionId:string;targetSessionId:string;status:"accepted"|"running"|"reported"|"failed"|"interrupted";createdAt:string;updatedAt:string;fingerprint:string;error?:string;report?:string[]};
type Handler = (input:{id:string;source:string;target:string;sessionId:string;chatId:string;message:string})=>Promise<string[]>;

// One trusted owner/runtime. Receipts confirm routing/report delivery, not task correctness.
export class SessionDispatchService {
  private handlers=new Map<string,Handler>();
  private receipts=new Map<string,Receipt>();
  private fallback?:Handler;
  private token:string;
  private dir:string;
  constructor(private store:FileStore){
    this.dir=path.join(store.getDataDir(),"dispatches");fs.mkdirSync(this.dir,{recursive:true,mode:0o700});
    const file=path.join(this.dir,"token");
    if(!fs.existsSync(file))fs.writeFileSync(file,randomUUID()+randomUUID(),{mode:0o600,flag:"wx"});
    this.token=fs.readFileSync(file,"utf8").trim();
    for(const name of fs.readdirSync(this.dir).filter(n=>/^[a-f0-9-]+\.json$/.test(n))){
      const r=JSON.parse(fs.readFileSync(path.join(this.dir,name),"utf8")) as Receipt;
      if(["accepted","running"].includes(r.status)){r.status="interrupted";r.error="Runtime restarted; request was not replayed";}
      this.receipts.set(r.id,r);this.save(r);
    }
  }
  authorize(header:string|undefined){const value=Buffer.from(header?.replace(/^Bearer /,"")??""),expected=Buffer.from(this.token);return value.length===expected.length&&timingSafeEqual(value,expected);}
  register(botId:string,handler:Handler){this.handlers.set(botId,handler);}
  registerUnbound(handler:Handler){this.fallback=handler;}
  get(id:string,source:string){const r=this.receipts.get(id);return r?.sourceSessionId===source?structuredClone(r):undefined;}
  async targets(){return (await this.store.listSessions()).map(s=>({sessionId:s.sessionId,publicId:s.publicId}));}
  async submit(sourceId:string,targetId:string,message:string,requestId:string){
    if(!message.trim()||message.length>16000||!/^[a-f0-9-]{36}$/.test(requestId))throw Error("INVALID_DISPATCH");
    const source=await this.store.getSession(sourceId);const sessions=await this.store.listSessions();
    const target=sessions.find(s=>s.sessionId===targetId||s.publicId===targetId);
    if(!source||!target)throw Error("SESSION_NOT_FOUND");if(source.sessionId===target.sessionId)throw Error("SELF_DISPATCH");
    const bindings=(await this.store.sessionBindings(target.sessionId)).filter(b=>b.botId&&this.handlers.has(b.botId));
    if(bindings.length>1)throw Error("TARGET_TELEGRAM_AMBIGUOUS");
    const binding=bindings[0],handler=binding?this.handlers.get(binding.botId!)!:this.fallback;
    if(!handler)throw Error("DISPATCH_RUNTIME_UNAVAILABLE");
    const fingerprint=createHash("sha256").update(target.sessionId+"\0"+message).digest("hex");
    const old=[...this.receipts.values()].find(r=>r.sourceSessionId===sourceId&&r.requestId===requestId);
    if(old){if(old.fingerprint!==fingerprint)throw Error("REQUEST_ID_CONFLICT");return structuredClone(old);}
    if([...this.receipts.values()].filter(r=>["accepted","running"].includes(r.status)).length>=50)throw Error("DISPATCH_LIMIT");
    const reachable=new Set([target.sessionId]);
    for(let i=0;i<this.receipts.size;i++)for(const r of this.receipts.values())if(["accepted","running"].includes(r.status)&&reachable.has(r.sourceSessionId))reachable.add(r.targetSessionId);
    if(reachable.has(sourceId))throw Error("DISPATCH_CYCLE");
    const now=new Date().toISOString();const r:Receipt={id:randomUUID(),requestId,sourceSessionId:sourceId,targetSessionId:target.sessionId,status:"accepted",createdAt:now,updatedAt:now,fingerprint};
    this.receipts.set(r.id,r);try{this.save(r);}catch(e){this.receipts.delete(r.id);throw e;}
    void Promise.resolve().then(async()=>{
      r.status="running";this.save(r);
      r.report=await handler({id:r.id,source:source.publicId,target:target.publicId,sessionId:target.sessionId,chatId:binding?.chatId??"",message});
      r.status="reported";this.save(r);
    }).catch(()=>{r.status="failed";r.error="Dispatch execution or Telegram delivery failed; inspect target session logs before retrying";try{this.save(r);}catch{console.error("Dispatch receipt could not be persisted");}});
    return structuredClone(r);
  }
  private save(r:Receipt){
    r.updatedAt=new Date().toISOString();
    while(this.receipts.size>200){const old=[...this.receipts.values()].find(x=>x.id!==r.id&&!["accepted","running"].includes(x.status));if(!old)break;this.receipts.delete(old.id);fs.rmSync(path.join(this.dir,old.id+".json"),{force:true});}
    const file=path.join(this.dir,r.id+".json"),tmp=file+"."+randomUUID()+".tmp";
    try{fs.writeFileSync(tmp,JSON.stringify(r),{mode:0o600});fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}
  }
}
