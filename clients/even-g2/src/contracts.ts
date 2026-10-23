export type Gesture = 'tap' | 'cancel' | 'previous' | 'next' | 'record-start' | 'record-stop';
export interface Device {
  start(onPcm: (chunk: Uint8Array) => void): Promise<void>;
  stop(): Promise<void>;
  display(text: string): Promise<void>;
}
