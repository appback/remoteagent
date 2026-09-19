import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Install the official release into the same per-user PATH used by providers.
if (!['linux', 'darwin'].includes(process.platform)) throw new Error('Install GitHub CLI on Windows using: winget install --id GitHub.cli');
const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
if (!arch) throw new Error(`Unsupported architecture: ${process.arch}`);
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`GitHub download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
const release = JSON.parse((await download('https://api.github.com/repos/cli/cli/releases/latest')).toString());
const suffix = process.platform === 'darwin' ? `macOS_${arch}.zip` : `linux_${arch}.tar.gz`;
const asset = release.assets.find(item => item.name.endsWith(suffix));
if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) throw new Error('Official release asset or SHA256 digest missing.');
const bytes = await download(asset.browser_download_url);
if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== asset.digest) throw new Error('GitHub CLI checksum mismatch.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'remoteagent-gh-'));
try {
  const archive = path.join(temp, asset.name);
  await fs.writeFile(archive, bytes, { mode: 0o600 });
  if (process.platform === 'darwin') execFileSync('unzip', ['-q', archive, '-d', temp]);
  else execFileSync('tar', ['-xzf', archive, '-C', temp]);
  const folder = asset.name.replace(/\.tar\.gz$|\.zip$/, '');
  const destination = path.join(os.homedir(), '.local', 'bin');
  await fs.mkdir(destination, { recursive: true });
  const staged = path.join(destination, `.gh-${process.pid}`);
  try {
    await fs.copyFile(path.join(temp, folder, 'bin', 'gh'), staged);
    await fs.chmod(staged, 0o755);
    execFileSync(staged, ['--version']);
    await fs.rename(staged, path.join(destination, 'gh'));
  } finally { await fs.rm(staged, { force: true }); }
  console.log(`Installed GitHub CLI ${release.tag_name}.`);
} finally { await fs.rm(temp, { recursive: true, force: true }); }
