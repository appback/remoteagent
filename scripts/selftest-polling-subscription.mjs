import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// Exercise the compiled request function without starting a second real poller.
const code = await fs.readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
const start = code.indexOf('async function getUpdatesViaCurl(');
const end = code.indexOf('class TelegramPollingError', start);
assert.ok(start >= 0 && end > start);
let args;
const context = {
  URL, console,
  TELEGRAM_GET_UPDATES_HTTP_TIMEOUT_SECONDS: 0,
  TELEGRAM_GET_UPDATES_CURL_TIMEOUT_SECONDS: 35,
  execFileAsync: async (_bin, actualArgs) => {
    args = actualArgs;
    return { stdout: JSON.stringify({ ok: true, result: [{ update_id: 42, callback_query: { data: 'test' } }] }), stderr: '' };
  },
};
vm.createContext(context);
vm.runInContext(code.slice(start, end), context);
const result = await context.getUpdatesViaCurl('test-token', 41);
const url = new URL(args.at(-1));
assert.deepEqual(JSON.parse(url.searchParams.get('allowed_updates')), ['message', 'edited_message', 'channel_post', 'callback_query']);
assert.equal(url.searchParams.get('offset'), '41');
assert.equal(result.result[0].callback_query.data, 'test');
console.log('Polling subscription self-test passed.');
