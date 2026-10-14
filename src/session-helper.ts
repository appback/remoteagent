import fs from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";

try{
  const [action,target,file,requestId]=process.argv.slice(2);
  const source=process.env.REMOTEAGENT_SESSION_ID;
  if(!source)throw Error("Run this helper from a RemoteAgent provider session");
  const dir=process.env.REMOTEAGENT_DATA_DIR||process.env.DATA_DIR;
  if(!dir)throw Error("RemoteAgent data directory unavailable");
  const token=fs.readFileSync(path.join(dir,"dispatches/token"),"utf8").trim();
  let route="",body:unknown;
  if(action==="list")route="/api/dispatch-targets";
  else if(action==="status"&&target)route="/api/dispatches/"+encodeURIComponent(target);
  else if(action==="send"&&target&&file){
    const message=fs.readFileSync(file,"utf8");
    body={target,message,requestId:requestId||randomUUID()};route="/api/dispatches";
    // Persist/reuse this ID if the HTTP response is lost; never silently resubmit.
    console.error(JSON.stringify({requestId:(body as {requestId:string}).requestId}));
  }else throw Error('Usage: session-helper list | send <Sxxx|uuid> <UTF-8 file> [request UUID] | status <receipt UUID>');
  const port=Number(process.env.LOCAL_UI_PORT||3794);
  const response=await fetch(`http://127.0.0.1:${port}${route}`,{method:body?"POST":"GET",headers:{authorization:"Bearer "+token,"x-source-session":source,"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000),redirect:"error"});
  let result=await response.json() as {receipt?:{id:string;status:string;report?:string[]}};
  if(response.ok&&action==="send"&&result.receipt){
    console.error(JSON.stringify({receiptId:result.receipt.id,status:result.receipt.status}));
    while(["accepted","running"].includes(result.receipt!.status)){
      await new Promise(resolve=>setTimeout(resolve,2000));
      const check=await fetch(`http://127.0.0.1:${port}/api/dispatches/${result.receipt!.id}`,{headers:{authorization:"Bearer "+token,"x-source-session":source},signal:AbortSignal.timeout(10000),redirect:"error"});
      if(!check.ok)throw Error("Receipt retrieval failed; inspect saved receipt ID");
      result=await check.json() as typeof result;
    }
  }
  console.log(JSON.stringify(result));if(!response.ok||["failed","interrupted"].includes(result.receipt?.status??""))process.exitCode=1;
}catch{console.error("Session dispatch failed. Check local UI availability and request status before retrying.");process.exitCode=1;}
