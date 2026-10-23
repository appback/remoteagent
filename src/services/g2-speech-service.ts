import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export const G2_PCM_MAX_BYTES = 16000 * 2 * 60;

export function pcmToWav(pcm: Buffer): Buffer {
  if (pcm.length < 6400 || pcm.length > G2_PCM_MAX_BYTES || pcm.length % 2) throw Error("INVALID_AUDIO");
  let power = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) power += pcm.readInt16LE(offset) ** 2;
  if (power / (pcm.length / 2) < 32 ** 2) throw Error("NO_SPEECH");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export class G2SpeechService {
  private busy = false;
  constructor(private readonly binary: string, private readonly model: string) {
    if (!path.isAbsolute(binary) || !path.isAbsolute(model)) throw Error("INVALID_SPEECH_CONFIG");
  }
  async ready() {
    await fs.access(this.binary, constants.X_OK);
    if (!(await fs.stat(this.model)).isFile()) throw Error("INVALID_SPEECH_CONFIG");
  }
  async transcribe(pcm: Buffer, signal?: AbortSignal) {
    if (this.busy) throw Error("SPEECH_BUSY");
    const wav = pcmToWav(pcm);
    signal?.throwIfAborted();
    this.busy = true;
    let dir: string | undefined;
    const started = Date.now();
    try {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "remoteagent-g2-speech-"));
      await fs.chmod(dir, 0o700);
      const input = path.join(dir, "input.wav"), output = path.join(dir, "transcript");
      await fs.writeFile(input, wav, { mode: 0o600, flag: "wx" });
      try {
        await run(this.binary, ["-m", this.model, "-f", input, "-l", "ko", "-otxt", "-of", output,
          "-nt", "-np", "-mc", "0", "-nf", "-t", "4"], { signal, timeout: 120000, maxBuffer: 262144 });
      } catch {
        throw Error(signal?.aborted ? "SPEECH_CANCELED" : "SPEECH_FAILED");
      }
      const text = (await fs.readFile(output + ".txt", "utf8")).trim();
      if (!text) throw Error("NO_SPEECH");
      if (Buffer.byteLength(text) > 32768) throw Error("TRANSCRIPT_TOO_LARGE");
      return { text, durationMs: pcm.length / 32, processingMs: Date.now() - started };
    } finally {
      try { if (dir) await fs.rm(dir, { recursive: true, force: true }); }
      finally { this.busy = false; }
    }
  }
}
