#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "remoteagent-codex-stream-"));
const fakeCodex = path.join(tmp, "codex");

await fs.writeFile(fakeCodex, `#!/usr/bin/env bash
set -euo pipefail
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    output="$2"
    shift 2
    continue
  fi
  shift
done
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"stream-thread"}'
printf '%s' '{"type":"item.completed","item":{"type":"agent_message","text":"REPORT:progress\\nphase one"}}'
printf '\\n'
sleep 0.05
printf '%s\\n' '{"type":"event_msg","payload":{"type":"agent_message","message":"REPORT:progress\\nphase two"}}'
sleep 0.05
printf '%s\\n' '{"type":"response_item","payload":{"type":"message","content":[{"type":"output_text","text":"REPORT:progress\\nphase three"}]}}'
sleep 0.05
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"REPORT:result\\nfinished"}}'
printf '%s\\n' 'REPORT:result' 'finished' > "$output"
`, "utf8");
await fs.chmod(fakeCodex, 0o755);

const { CodexAdapter } = await import(path.join(root, "dist", "adapters", "codex-adapter.js"));
const adapter = new CodexAdapter(fakeCodex, 5000, "read-only");
const progress = [];
let settled = false;
const responsePromise = adapter.send({
  chatId: "selftest",
  remoteSessionId: "remote-session",
  publicSessionId: "S001",
  message: "test",
  cwd: tmp,
  onProgress: async (output) => {
    if (settled) {
      throw new Error("Progress arrived after the provider response settled");
    }
    progress.push(output);
  },
});
const response = await responsePromise;
settled = true;

if (
  progress.length !== 3
  || !progress[0]?.includes("phase one")
  || !progress[1]?.includes("phase two")
  || !progress[2]?.includes("phase three")
) {
  throw new Error(`Unexpected streamed progress: ${JSON.stringify(progress)}`);
}
if (progress.some((item) => item.includes("REPORT:result"))) {
  throw new Error(`Final result leaked through progress callback: ${JSON.stringify(progress)}`);
}
if (response.sessionId !== "stream-thread" || response.output !== "REPORT:result\nfinished") {
  throw new Error(`Unexpected final response: ${JSON.stringify(response)}`);
}

console.log(JSON.stringify({ ok: true, streamedProgress: progress.length, final: response.output }, null, 2));
