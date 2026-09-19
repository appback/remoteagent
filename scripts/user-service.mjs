import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const action = process.argv[2] ?? 'install';
if (!['install', 'migrate'].includes(action)) throw new Error('Usage: remoteagent service install|migrate');
if (process.platform !== 'linux' || process.getuid() === 0) throw new Error('Run as the RemoteAgent account on Linux, not root.');
const home = os.homedir();
const data = path.resolve(process.env.DATA_DIR || path.join(home, '.remoteagent'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const unit = path.join(home, '.config/systemd/user/remoteagent.service');
const call = (file, args) => execFileSync(file, args, { stdio: ['inherit', 'pipe', 'pipe'] }).toString().trim();
const succeeds = (file, args) => { try { call(file, args); return true; } catch { return false; } };
if (!succeeds('systemctl', ['--user', 'show-environment'])) {
  throw new Error('User service manager is unavailable. Sign in via SSH as this account, then run remoteagent service install.');
}
const systemExists = succeeds('systemctl', ['cat', 'remoteagent']);
const systemEnabled = succeeds('systemctl', ['is-enabled', '--quiet', 'remoteagent']);
const systemActive = succeeds('systemctl', ['is-active', '--quiet', 'remoteagent']);
if ((systemEnabled || systemActive) && action !== 'migrate') {
  throw new Error('Existing system service retained. After active work finishes, run remoteagent service migrate.');
}
if (action === 'migrate') {
  const polling = JSON.parse(await fs.readFile(path.join(data, 'bot-polling-state.json'), 'utf8').catch(e => { if (e.code === 'ENOENT') return '{}'; throw e; }));
  if (Object.values(polling.bots ?? {}).some(b => b.runningSessionIds?.length)) throw new Error('Active work detected. Retry migration after completion.');
}
try {
  const pid = Number(await fs.readFile(path.join(data, 'remoteagent.pid'), 'utf8'));
  if (pid > 0) {
    try { process.kill(pid, 0); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    if (succeeds('kill', ['-0', String(pid)]) && !systemActive && !succeeds('systemctl', ['--user', 'is-active', '--quiet', 'remoteagent'])) {
      throw new Error('Unmanaged runtime is active. Stop it with remoteagent-stop after work finishes, then retry.');
    }
  }
} catch (e) { if (e.code !== 'ENOENT') throw e; }
// systemd quoted fields still expand percent specifiers; escape those explicitly.
const quote = value => '"' + value.replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const text = `[Unit]\nDescription=RemoteAgent (user)\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${quote(home)}\nEnvironment=${quote(`DATA_DIR=${data}`)}\nEnvironment=${quote(`PATH=${path.dirname(process.execPath)}:${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`)}\nExecStart=${quote(process.execPath)} ${quote(path.join(root, 'dist/index.js'))}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\nUMask=0077\nStandardOutput=${quote(`append:${path.join(data, 'logs/agent.log')}`)}\nStandardError=${quote(`append:${path.join(data, 'logs/agent.log')}`)}\n\n[Install]\nWantedBy=default.target\n`;
await fs.mkdir(path.dirname(unit), { recursive: true });
await fs.mkdir(path.join(data, 'logs'), { recursive: true, mode: 0o700 });
const oldUnit = await fs.readFile(unit).catch(e => { if (e.code === 'ENOENT') return undefined; throw e; });
await fs.writeFile(unit, text, { mode: 0o600 });
try {
  call('systemctl', ['--user', 'daemon-reload']);
  if (action === 'migrate' && systemExists) {
    // Only this explicit migration may request administrator credentials.
    execFileSync('sudo', ['systemctl', 'disable', '--now', 'remoteagent'], { stdio: 'inherit' });
    if (succeeds('systemctl', ['is-active', '--quiet', 'remoteagent'])) throw new Error('System service is still active.');
  }
  call('systemctl', ['--user', 'enable', 'remoteagent']);
  if (action === 'migrate') {
    call('systemctl', ['--user', 'start', 'remoteagent']);
    await new Promise(resolve => setTimeout(resolve, 5000));
    call('systemctl', ['--user', 'is-active', '--quiet', 'remoteagent']);
  }
} catch (error) {
  const recoveryErrors = [];
  if (action === 'migrate') {
    succeeds('systemctl', ['--user', 'disable', '--now', 'remoteagent']);
    for (const operation of [...(systemEnabled ? ['enable'] : []), ...(systemActive ? ['start'] : [])]) {
      try { execFileSync('sudo', ['systemctl', operation, 'remoteagent'], { stdio: 'inherit' }); }
      catch { recoveryErrors.push(`systemctl ${operation} remoteagent`); }
    }
  }
  if (oldUnit) await fs.writeFile(unit, oldUnit); else await fs.rm(unit, { force: true });
  succeeds('systemctl', ['--user', 'daemon-reload']);
  if (recoveryErrors.length) console.error(`Recovery needs administrator attention: ${recoveryErrors.join(', ')}`);
  throw error;
}
console.log(action === 'migrate' ? 'Migrated to remoteagent user service. Existing data retained.' : 'User service installed and enabled. Start with remoteagent-start.');
let linger = '';
try { linger = call('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger', '--value']); } catch {}
if (linger !== 'yes') {
  console.log(`For boot startup and logout persistence, ask an administrator to run once: sudo loginctl enable-linger ${os.userInfo().username}`);
}
