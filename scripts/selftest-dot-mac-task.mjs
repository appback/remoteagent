import fs from 'node:fs';
import path from 'node:path';
import { DotMacService } from '../dist/services/dot-mac-service.js';
import { DotMacScreenService } from '../dist/services/dot-mac-screen-service.js';
import { DotHostService } from '../dist/services/dot-host-service.js';

if (process.platform !== 'darwin') throw Error('Actual Mac required');
const input = JSON.parse(Buffer.from(process.env.MAC_TEST_INPUT, 'base64').toString('utf8'));
const dir = path.resolve(process.env.MAC_TEST_DIR);
if (!dir.startsWith('/private/tmp/remoteagent-acceptance-')) throw Error('Isolated acceptance directory required');
const mac = new DotMacService(dir, process.env.HOME + '/.local/bin/peekaboo',
  process.env.HOME + '/Library/Application Support/Peekaboo/daemon.sock', true, [], new DotMacScreenService());
try {
  let result;
  if (input.tool === 'read-code') {
    const root = process.env.HOME + '/.local/lib/node_modules/appback-remoteagent';
    const host = new DotHostService(dir, [root]);
    try { result = host.fileOperation({ requestId: 'acceptance', action: 'read', path: root + '/dist/services/dot-host-service.js' }); }
    finally { host.close(); }
  } else result = await mac.call('dot_mac_' + input.tool, { requestId: 'acceptance', ...input.args });
  const images = Array.isArray(result?.content) ? result.content.filter(c => c.type === 'image') : [];
  if (images.length) {
    const name = input.imageName;
    if (!/^[a-z0-9-]+\.png$/.test(name)) throw Error('Invalid test image name');
    fs.writeFileSync(path.join(dir, name), Buffer.from(images[0].data, 'base64'), { mode: 0o600 });
    console.log(JSON.stringify({ image: path.join(dir, name), content: result.content.filter(c => c.type !== 'image') }));
  } else console.log(JSON.stringify(result));
} finally { await mac.close(); }
