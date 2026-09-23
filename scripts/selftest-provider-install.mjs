import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remoteagent-install-test-'));
const bash = process.env.TEST_BASH || '/bin/bash';
try {
  for (const separatePrefix of [false, true]) {
    const home = path.join(root, separatePrefix ? 'separate' : 'same');
    const prefix = separatePrefix ? path.join(home, 'node') : path.join(home, '.local');
    const bin = path.join(prefix, 'bin');
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, 'npm'), `#!/bin/bash
set -eu
case "$1" in
  prefix) printf '%s\\n' "$TEST_PREFIX" ;;
  install)
    case "$*" in *anthropic*) name=claude ;; *) name=codex ;; esac
    printf '#!/bin/bash\\necho "mock-%s $*"\\n' "$name" > "$TEST_PREFIX/bin/$name"
    chmod +x "$TEST_PREFIX/bin/$name"
    ;;
  *) exit 9 ;;
esac
`, { mode: 0o755 });
    const env = { ...process.env, HOME: home, TEST_PREFIX: prefix, PATH: `${bin}:/usr/bin:/bin`, REMOTEAGENT_AUTH_TOKEN: '', CLAUDE_AUTH_TOKEN: '' };
    const run = (script) => spawnSync(bash, [path.join(scripts, script)], { env, encoding: 'utf8' });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = run('install-codex.sh');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /mock-codex --version/);
      assert.ok(await fs.realpath(path.join(home, '.local/bin/codex')));
    }
    const claude = run('install-claude.sh');
    assert.equal(claude.status, 0, claude.stdout + claude.stderr);
    assert.match(claude.stdout, /mock-claude --version/);
    await fs.writeFile(path.join(bin, 'timeout'), '#!/bin/bash\nshift\nexec "$@"\n', { mode: 0o755 });
    const loginStart = run('start-claude-login.sh');
    assert.equal(loginStart.status, 0, loginStart.stdout + loginStart.stderr);
    assert.match(loginStart.stdout, /mock-claude auth login/);
    const missingToken = run('finish-claude-login.sh');
    assert.equal(missingToken.status, 1);
    assert.match(missingToken.stdout, /Missing token/);
    // Existing profiles must still be supported, without requiring one on macOS.
    await fs.writeFile(path.join(home, '.profile'), 'export TEST_PROFILE_LOADED=1\n');
    const existingProfile = run('install-codex.sh');
    assert.equal(existingProfile.status, 0, existingProfile.stdout + existingProfile.stderr);
  }
  console.log(`PASS provider installation (${bash}): missing/existing profile, same/separate npm prefix, repeated install, Claude install and missing-token guard`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
