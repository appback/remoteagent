import {execFile} from "node:child_process";
import {promisify} from "node:util";

const execute=promisify(execFile);
const marker="\nREMOTEAGENT_UPLOAD:";
export function redactTelegramSecrets(text:string){return text.replace(/\d{8,}:[A-Za-z0-9_-]+/g,"[BOT_TOKEN_REDACTED]");}

export class TelegramUploadError extends Error {
  constructor(readonly retryAllowed:boolean,readonly curlCode:number|undefined,readonly uploadedBytes:number|undefined,detail=""){
    super(`Telegram 파일 전송 ${retryAllowed?"연결 실패":"결과 확인 실패"} (curl=${curlCode??"unknown"}, uploaded=${uploadedBytes??"unknown"}).${detail?" "+detail:""}${retryAllowed?"":" 중복 방지를 위해 자동 재전송하지 않았습니다. 수신 여부를 확인해 주세요."}`);
    this.name="TelegramUploadError";
  }
}

export async function runTelegramUpload(token:string,chatId:number,file:string,caption?:string,runner:typeof execute=execute):Promise<string>{
  const args=["-sS","-4","--connect-timeout","15","--max-time","120","--write-out",marker+"%{size_upload}\n","-F",`chat_id=${chatId}`,"-F",`document=@${file}`];
  if(caption?.trim())args.push("-F",`caption=${caption.trim()}`);
  args.push(`https://api.telegram.org/bot${token}/sendDocument`);
  try{
    const result=await runner("curl",args);
    const stdout=String(result.stdout),index=stdout.lastIndexOf(marker);
    return index<0?stdout:stdout.slice(0,index);
  }catch(error){
    const e=error as {code?:unknown;stdout?:unknown;stderr?:unknown};
    const code=typeof e.code==="number"?e.code:undefined;
    const text=String(e.stdout??""),index=text.lastIndexOf(marker);
    const bytes=index<0?undefined:Number(text.slice(index+marker.length).trim());
    const uploaded=bytes!==undefined&&Number.isFinite(bytes)&&bytes>=0?bytes:undefined;
    // DNS/connect/TLS setup fail before HTTP; other network failures need zero-upload evidence.
    const retryAllowed=code!==undefined&&(([6,7,35].includes(code)&&(uploaded===undefined||uploaded===0))||(uploaded===0&&[28,52,55,56].includes(code)));
    const detail=typeof e.stderr==="string"?redactTelegramSecrets(e.stderr).split(/\r?\n/,1)[0]!.slice(0,300):"";
    throw new TelegramUploadError(retryAllowed,code,uploaded,detail);
  }
}
