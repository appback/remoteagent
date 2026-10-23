export const MAX_PCM_BYTES = 16000 * 2 * 60;
export class VoiceCapture {
  private chunks: Uint8Array[] = [];
  bytes = 0;
  add(chunk: Uint8Array) {
    if (!chunk.length) return;
    if (chunk.length % 2 || this.bytes + chunk.length > MAX_PCM_BYTES) throw Error('AUDIO_LIMIT');
    this.chunks.push(chunk.slice()); this.bytes += chunk.length;
  }
  finish(): Uint8Array<ArrayBuffer> {
    if (this.bytes < 6400) throw Error('NO_AUDIO');
    const pcm = new Uint8Array(this.bytes);
    let offset = 0; for (const chunk of this.chunks) { pcm.set(chunk, offset); offset += chunk.length; }
    this.clear(); return pcm;
  }
  clear() { this.chunks = []; this.bytes = 0; }
}
