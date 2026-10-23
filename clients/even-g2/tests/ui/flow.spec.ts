import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const resource='https://remoteagent-dot60.appback.app';

async function harness(page:Page,options:{noAudio?:boolean;decoderFails?:boolean;unpaired?:boolean}={}) {
  await page.route('**/*',route=>route.abort('blockedbyclient'));
  await page.route('https://g2-client.test/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    const name=pathname.startsWith('/assets/')||pathname==='/even.ico'?pathname.slice(1):'index.html';
    await route.fulfill({body:await readFile(resolve('dist',name)),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.ico')?'image/x-icon':'text/html'});
  });
  const stats={startup:0,microphone:0,transcriptions:0,submissions:0,refreshes:0,devices:0,token:'synthetic-refresh-token-in-native-storage',displays:[] as string[]};
  let clientRequestId='';
  if(options.unpaired)stats.token='';
  await page.exposeFunction('__native',async(message:string)=>{
    const value=JSON.parse(message);
    if(value.method==='getLocalStorage')return stats.token;
    if(value.method==='getGlassesInfo')return {model:'g2',sn:'synthetic-glasses',status:{sn:'synthetic-glasses',connectType:'connected'}};
    if(value.method==='setLocalStorage'){stats.token=value.data.value;return true;}
    if(value.method==='createStartUpPageContainer'){stats.startup++;return 0;}
    if(value.method==='audioControl')stats.microphone++;
    if(value.method==='textContainerUpgrade')stats.displays.push(JSON.stringify(value.data));
    return true;
  });
  await page.addInitScript(()=>{
    (window as any).flutter_inappwebview={callHandler:(_name:string,message:string)=>(window as any).__native(message)};
    if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=async()=>{throw Error('Browser microphone must not be used');};
  });
  await page.route('**/g2-config.json',route=>route.fulfill({json:{mode:'live',authMode:'device',clientId:'remoteagent-g2-even',approvalBotUsername:'mac_mini_even_bot'}}));
  await page.route(resource+'/**',async route=>{
    const request=route.request(),url=new URL(request.url());
    const headers={'Access-Control-Allow-Origin':'https://g2-client.test','Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
    if(request.method()==='OPTIONS')return route.fulfill({status:204,headers});
    if(url.pathname==='/oauth/device/auth'){stats.devices++;return route.fulfill({headers,json:{device_code:'synthetic-device-code-1234567890',user_code:'ABCD-EFGH',verification_uri:resource+'/oauth/device',expires_in:300,interval:1}});}
    if(url.pathname==='/oauth/token'){
      if(new URLSearchParams(request.postData()??'').get('grant_type')==='refresh_token')stats.refreshes++;
      return route.fulfill({headers,json:{access_token:'synthetic-access-token',refresh_token:'synthetic-refresh-token-'+stats.refreshes,token_type:'Bearer',scope:'remoteagent:g2',expires_in:3600}});
    }
    if(url.pathname==='/oauth/token/revocation')return route.fulfill({headers,json:{}});
    if(url.pathname==='/api/v1/targets')return route.fulfill({headers,json:{targets:[{targetId:'tgt_s010',type:'session',provider:'codex',label:'S010',available:true,cancelMode:'execution'}]}});
    if(url.pathname==='/api/v1/capabilities')return route.fulfill({headers,json:{audio:{available:true,sampleRate:16000,format:'s16le'}}});
    if(url.pathname==='/api/v1/audio/transcriptions'){
      stats.transcriptions++;
      expect(request.headers()['content-type']).toBe('audio/pcm');
      expect(request.postDataBuffer()!.length).toBe(6400);
      return route.fulfill({headers,status:options.decoderFails?502:200,json:options.decoderFails?{error:'SPEECH_FAILED'}:{text:'오늘 회의 일정을 확인해 주세요.'}});
    }
    if(url.pathname==='/api/v1/requests'){
      stats.submissions++;const body=request.postDataJSON();clientRequestId=body.clientRequestId;expect(body.targetId).toBe('tgt_s010');
      return route.fulfill({headers,status:202,json:{requestId:'req_browser',clientRequestId:body.clientRequestId,targetId:body.targetId,status:'accepted',lastSeq:1}});
    }
    if(url.pathname.endsWith('/events'))return route.fulfill({headers,json:{requestId:'req_browser',events:[{seq:2,type:'result',text:'회의 일정을 확인했습니다.',outcome:'succeeded'}],nextCursor:2,hasMore:false,status:'completed'}});
    if(url.pathname==='/api/v1/requests/req_browser')return route.fulfill({headers,json:{requestId:'req_browser',clientRequestId,targetId:'tgt_s010',status:'completed',lastSeq:2,result:{text:'회의 일정을 확인했습니다.',outcome:'succeeded',truncated:false}}});
    return route.fulfill({headers,status:404,json:{error:'NOT_FOUND'}});
  });
  await page.goto('/');await expect(page.locator('#connect')).toHaveText('연결됨');
  if(!options.unpaired)await expect(page.locator('#connectionState')).toHaveText('사용 준비됨');
  async function frames(){
    if(options.noAudio)return;
    await page.evaluate(()=>(window as any)._listenEvenAppMessage({type:'listen_even_app_data',method:'evenHubEvent',data:{type:'audioEvent',jsonData:{source:'glasses',audioPcm:Array(6400).fill(2)}}}));
  }
  return {stats,frames};
}

test('connected button is disabled; repeated checks reuse the SDK session and restore login',async({page})=>{
  const f=await harness(page);await expect(page.locator('#connect')).toBeDisabled();await expect(page.locator('#login')).toBeHidden();
  await page.getByText('연결 관리',{exact:true}).click();await page.locator('#retry').click();await page.locator('#retry').click();
  expect(f.stats.startup).toBe(1);expect(f.stats.devices).toBe(0);
  expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('synthetic-access-token');
  await page.reload();await expect(page.locator('#connectionState')).toHaveText('사용 준비됨');expect(f.stats.devices).toBe(0);expect(f.stats.refreshes).toBe(2);
});
test('real SDK audio event becomes editable text and is not executed before Send',async({page})=>{
  const f=await harness(page);await page.locator('#record').click();await expect(page.locator('#voiceStatus')).toContainText('듣고 있습니다');
  await f.frames();await page.locator('#record').click();
  await expect(page.locator('#draft')).toHaveValue('오늘 회의 일정을 확인해 주세요.');expect(f.stats.transcriptions).toBe(1);expect(f.stats.submissions).toBe(0);
  await page.locator('#send').click();await expect(page.locator('#workState')).toHaveText('답변 도착');
  await expect(page.locator('#answer')).toContainText('회의 일정을 확인했습니다');expect(f.stats.submissions).toBe(1);expect(f.stats.microphone).toBe(2);
  await expect.poll(()=>f.stats.displays.at(-1)).toContain('회의 일정을 확인했습니다');
});
test('SDK long press and release record glasses audio without a phone recording button',async({page})=>{
  const f=await harness(page);
  const press=async(eventType:number)=>page.evaluate(type=>(window as any)._listenEvenAppMessage({type:'listen_even_app_data',method:'evenHubEvent',data:{type:'sysEvent',jsonData:{eventType:type}}}),eventType);
  await press(9);await expect(page.locator('#voiceStatus')).toContainText('듣고 있습니다');await f.frames();await press(10);
  await expect(page.locator('#draft')).toHaveValue('오늘 회의 일정을 확인해 주세요.');expect(f.stats.transcriptions).toBe(1);expect(f.stats.submissions).toBe(0);
});
test('no audio never invents text or sends an instruction',async({page})=>{
  const f=await harness(page,{noAudio:true});await page.locator('#record').click();await page.locator('#record').click();
  await expect(page.locator('#notice')).toContainText('음성을 듣지 못했습니다');await expect(page.locator('#draft')).toHaveValue('');
  expect(f.stats.transcriptions).toBe(0);expect(f.stats.submissions).toBe(0);
});
test('decoder failure preserves existing draft and never substitutes a demo transcript',async({page})=>{
  const f=await harness(page,{decoderFails:true});await page.locator('#draft').fill('기존 지시');
  await page.locator('#record').click();await f.frames();await page.locator('#record').click();
  await expect(page.locator('#notice')).toContainText('요청을 완료하지 못했습니다');await expect(page.locator('#draft')).toHaveValue('기존 지시');expect(f.stats.submissions).toBe(0);
});
test('initial approval is only requested on unpaired device, then restores after reload',async({page})=>{
  const f=await harness(page,{unpaired:true});await expect(page.locator('#login')).toBeEnabled();await page.locator('#login').click();
  await expect(page.locator('#userCode')).toHaveText('ABCD-EFGH');
  await expect(page.locator('#verificationUri')).toHaveAttribute('href','https://t.me/mac_mini_even_bot?start=g2_ABCD-EFGH');
  await expect(page.locator('#connectionState')).toHaveText('사용 준비됨');
  await page.reload();await expect(page.locator('#connectionState')).toHaveText('사용 준비됨');expect(f.stats.devices).toBe(1);
});
for(const width of [320,390,1280])test(`layout is usable at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});await harness(page);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await expect(page.locator('#record')).toBeEnabled();
  await page.screenshot({path:`test-results/voice-${width}.png`,fullPage:true});
});
