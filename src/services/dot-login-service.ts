import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readSecretValue, writeSecretValue } from "./agent-memory-service.js";

const prefix = "SITE_LOGIN_";
const run = promisify(execFile);
export type SiteLogin = { url: string; username: string; password: string; allowAutoLogin: boolean };
export interface LoginBrowser {
  currentUrl(): Promise<string>;
  fill(profile: SiteLogin, submit: boolean, signal?: AbortSignal): Promise<string>;
}
function target(value: string) {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.hash) throw Error("LOGIN_REQUIRES_HTTPS_URL");
  return u;
}
function key(id: string) {
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(id)) throw Error("LOGIN_PROFILE_ID_INVALID");
  return prefix + id.toUpperCase();
}
export function validateSiteLogin(value: SiteLogin) {
  target(value.url);
  if (typeof value.username !== "string" || !value.username || value.username.length > 512
    || typeof value.password !== "string" || !value.password || value.password.length > 4096
    || typeof value.allowAutoLogin !== "boolean"
    || Object.keys(value).some(k => !["url", "username", "password", "allowAutoLogin"].includes(k))) throw Error("LOGIN_PROFILE_INVALID");
}
export function saveSiteLogin(dataDir: string, id: string, value: SiteLogin) {
  validateSiteLogin(value);
  const file = path.join(dataDir, "managed/secrets.json");
  if (fs.existsSync(file)) {
    try {
      const existing = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!existing || typeof existing !== "object" || Array.isArray(existing)) throw Error();
    } catch { throw Error("LOGIN_SECRET_STORE_INVALID: repair the existing store before registering a site."); }
  }
  writeSecretValue(dataDir, key(id), JSON.stringify(value));
}
export class DotLoginService {
  constructor(private readonly dataDir: string, private readonly browser: LoginBrowser = new SafariLoginBrowser()) {}
  list() {
    const file = path.join(this.dataDir, "managed/secrets.json");
    if (!fs.existsSync(file)) return [];
    return Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).filter(k => k.startsWith(prefix)).map(k => {
      const id = k.slice(prefix.length).toLowerCase(), p = this.profile(id);
      return { id, site: p.url, allowAutoLogin: p.allowAutoLogin };
    });
  }
  async status() {
    const onePassword = ["/Applications/1Password.app", path.join(process.env.HOME ?? "", "Applications/1Password.app")].some(p => fs.existsSync(p));
    return { preferred: onePassword ? "1password" : "safari", onePasswordAppPresent: onePassword,
      applePasswordsPresent: fs.existsSync("/System/Applications/Passwords.app"),
      policy: "Use the existing browser/password-manager AutoFill UI first. Never export its vault. Unlock/Touch ID/OTP require the user. Stored fallback requires an explicitly enabled site profile." };
  }
  async login(id: string, submit = false, signal?: AbortSignal) {
    if (signal?.aborted) throw Error("LOGIN_CANCELED");
    const profile = this.profile(id);
    if (!profile.allowAutoLogin) throw Error("LOGIN_NOT_AUTHORIZED_FOR_SITE");
    const expected = target(profile.url), actual = target(await this.browser.currentUrl());
    if (expected.origin !== actual.origin || expected.pathname !== actual.pathname) throw Error("LOGIN_SITE_MISMATCH");
    if (signal?.aborted) throw Error("LOGIN_CANCELED");
    const result = await this.browser.fill(profile, submit, signal);
    if (!["filled", "submitted"].includes(result)) throw Error("LOGIN_FORM_NOT_SUPPORTED_OR_PAGE_CHANGED");
    return { status: result, site: expected.origin, authenticated: "unverified",
      next: "Observe the site for a real authenticated result. Do not repeat submission blindly. Password was not returned." };
  }
  private profile(id: string): SiteLogin {
    const raw = readSecretValue(this.dataDir, key(id));
    if (!raw) throw Error("LOGIN_PROFILE_NOT_FOUND");
    let value: SiteLogin;
    try { value = JSON.parse(raw) as SiteLogin; validateSiteLogin(value); }
    catch { throw Error("LOGIN_PROFILE_INVALID"); }
    return value;
  }
}
export class SafariLoginBrowser implements LoginBrowser {
  async currentUrl() {
    try { return (await run("/usr/bin/osascript", ["-e", 'tell application "Safari" to get URL of current tab of front window'], { timeout: 8000, maxBuffer: 16384 })).stdout.trim(); }
    catch { throw Error("LOGIN_BROWSER_ACCESS_REQUIRED: Safari Automation permission or an active Safari tab is unavailable."); }
  }
  async fill(p: SiteLogin, submit: boolean, signal?: AbortSignal) {
    const js = siteLoginScript(p, submit);
    const script = `tell application "Safari" to do JavaScript ${JSON.stringify(js.replace(/\n/g, " "))} in current tab of front window`;
    // Password travels only over stdin; never command arguments, receipts or stderr.
    return new Promise<string>((resolve, reject) => {
      if (signal?.aborted) { reject(Error("LOGIN_CANCELED")); return; }
      const child = spawn("/usr/bin/osascript", [], { stdio: ["pipe", "pipe", "ignore"] });
      let output = "", finished = false;
      const abort = () => { child.kill("SIGTERM"); done(); };
      const timer = setTimeout(abort, 8000);
      const done = (value?: string) => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
        if (value && ["filled", "submitted", "unsupported", "site_changed"].includes(value)) resolve(value);
        else reject(Error("LOGIN_FILL_UNAVAILABLE: Safari scripting permission or supported login form is unavailable. Do not retry automatically.")); };
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", bytes => { output += bytes.toString(); if (output.length > 1024) abort(); });
      child.on("error", () => done()); child.on("close", code => done(code === 0 ? output.trim() : undefined));
      child.stdin.on("error", () => {}); child.stdin.end(script);
    });
  }
}
export function siteLoginScript(p: SiteLogin, submit: boolean) {
    validateSiteLogin(p);
    const expected = target(p.url);
    return `(()=>{if(location.origin!==${JSON.stringify(expected.origin)}||location.pathname!==${JSON.stringify(expected.pathname)})return 'site_changed';
const visible=e=>e.getClientRects().length&&!e.disabled&&!e.readOnly;
const passwords=[...document.querySelectorAll('input[type=password]')].filter(visible);if(passwords.length!==1)return 'unsupported';
const pw=passwords[0],form=pw.form;if(!form||new URL(form.action||location.href,location.href).origin!==location.origin||form.method.toLowerCase()!=='post')return 'unsupported';
const users=[...form.querySelectorAll('input[autocomplete=username],input[type=email],input[type=text]')].filter(visible);if(users.length!==1)return 'unsupported';
const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
set.call(users[0],${JSON.stringify(p.username)});set.call(pw,${JSON.stringify(p.password)});
for(const e of [users[0],pw]){e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}
if(${submit}){form.requestSubmit();return 'submitted'}return 'filled'})()`;
}
