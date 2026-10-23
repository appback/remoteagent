import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

if (process.platform !== 'darwin') throw Error('Native screen control requires macOS');
const version = '4.9.6';
const npm = process.env.npm_execpath;
if (npm) execFileSync(process.execPath, [npm, 'install', '-g', `@steipete/peekaboo@${version}`], { stdio: 'inherit', timeout: 180000 });
else execFileSync('npm', ['install', '-g', `@steipete/peekaboo@${version}`], { stdio: 'inherit', timeout: 180000 });
const prefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8' }).trim();
const binary = path.join(prefix, 'bin', 'peekaboo');
fs.accessSync(binary, fs.constants.X_OK);
execFileSync(binary, ['--version'], { stdio: 'inherit', timeout: 10000 });
execFileSync(binary, ['daemon', 'start', '--json'], { stdio: 'inherit', timeout: 10000 });
execFileSync(binary, ['permissions', 'status', '--json'], { stdio: 'inherit', timeout: 10000 });
console.log(JSON.stringify({ binary, bridgeSocket: path.join(os.homedir(), 'Library/Application Support/Peekaboo/daemon.sock'),
  screenBackend: 'native-gui-node',
  instruction: 'Use DOT_MAC_SCREEN_BACKEND=native to reuse this Node identity in the GUI session. Test dot_mac_image before requesting any new screen permission. Peekaboo supplies native input and needs Accessibility/Event Synthesizing, not a second screen grant. This installer never changes OS permissions.' }));
