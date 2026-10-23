import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import type { CredentialStore } from './device-oauth';
// Host-app storage avoids the packaged WebView's changing loopback origin.
// The SDK does not promise hardware-backed encryption; never call this a keychain.
const KEY='remoteagent.g2.refresh.v1';
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('APP_STORAGE_UNAVAILABLE')),8000);})]);}
  finally{clearTimeout(timer!);}
}
export const appCredentialStore: CredentialStore = {
  async read(){const bridge=await within(waitForEvenAppBridge());return (await within(bridge.getLocalStorage(KEY)))||'';},
  async write(value){const bridge=await within(waitForEvenAppBridge());if(!await within(bridge.setLocalStorage(KEY,value)))throw Error('APP_STORAGE_WRITE_FAILED');},
};
