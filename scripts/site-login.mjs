import os from 'node:os';
import path from 'node:path';
import { DotLoginService, saveSiteLogin } from '../dist/services/dot-login-service.js';
const dir = process.env.REMOTEAGENT_DATA_DIR || path.join(os.homedir(), '.remoteagent');
const [action, id] = process.argv.slice(2);
if (action === 'list') console.log(JSON.stringify(new DotLoginService(dir).list()));
else if (action === 'save' && id) {
  let raw = ''; for await (const bytes of process.stdin) { raw += bytes; if (raw.length > 16384) throw Error('Input too large'); }
  try { saveSiteLogin(dir, id, JSON.parse(raw)); console.log('Stored site login. Credentials are not displayed.'); }
  catch { console.error('Invalid site login. Expected HTTPS url, username, password, allowAutoLogin boolean.'); process.exitCode = 1; }
} else { console.log('Usage: site-login list\n       site-login save <alias> < private-profile.json\nExisting browser/1Password AutoFill is preferred. Never pass passwords as command arguments.'); process.exitCode = 2; }
