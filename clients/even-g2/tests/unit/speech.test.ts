import {describe,it,expect} from 'vitest';
import {VoiceCapture,MAX_PCM_BYTES} from '../../src/speech';
describe('real SDK PCM assembly',()=>{
  it('preserves copied audio frames exactly, with no substitute transcript',()=>{
    const capture=new VoiceCapture(),frame=new Uint8Array(3200).fill(7);
    capture.add(frame);frame.fill(9);capture.add(frame);
    const result=capture.finish();expect(result).toHaveLength(6400);
    expect(result[0]).toBe(7);expect(result[3200]).toBe(9);expect(capture.bytes).toBe(0);
  });
  it('rejects no audio, malformed frames and more than 60 seconds',()=>{
    const capture=new VoiceCapture();expect(()=>capture.finish()).toThrow('NO_AUDIO');
    expect(()=>capture.add(new Uint8Array(3))).toThrow('AUDIO_LIMIT');
    expect(()=>capture.add(new Uint8Array(MAX_PCM_BYTES+2))).toThrow('AUDIO_LIMIT');
  });
});
