import { AudioInputSource, DeviceModel, DeviceConnectType, waitForEvenAppBridge, TextContainerProperty, TextContainerUpgrade,
  CreateStartUpPageContainer, OsEventTypeList, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import type { Device, Gesture } from './contracts';

export type DeviceState = 'disconnected' | 'connecting' | 'connected' | 'error';
export class G2Device implements Device {
  state: DeviceState = 'disconnected';
  recording = false;
  private bridge?: EvenAppBridge;
  private subscriptions: Array<() => void> = [];
  private connection?: Promise<void>;
  private pcm?: (data: Uint8Array) => void;
  private lastText = '';
  private generation = 0;
  constructor(private readonly changed: () => void = () => {}) {}

  connect(onGesture: (gesture: Gesture) => void): Promise<void> {
    if (this.state === 'connected') return Promise.resolve();
    if (this.connection) return this.connection;
    this.state = 'connecting'; this.changed();
    const generation = ++this.generation;
    const work = this.open(onGesture, generation);
    this.connection = work;
    void work.finally(() => { if (this.connection === work) this.connection = undefined; }).catch(() => {});
    return work;
  }
  private async open(onGesture: (gesture: Gesture) => void, generation: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const bridge = await Promise.race([waitForEvenAppBridge(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('BRIDGE_TIMEOUT')), 8000);
      })]);
      clearTimeout(timer);
      if (generation !== this.generation) throw Error('CONNECTION_CANCELED');
      const info = await bridge.getDeviceInfo();
      if (info?.model !== DeviceModel.G2 || info.status.connectType !== DeviceConnectType.Connected) throw Error('NOT_CONNECTED');
      const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum: 1,
        textObject: [new TextContainerProperty({ xPosition: 0, yPosition: 0, width: 576, height: 288, paddingLength: 4,
          containerID: 1, containerName: 'main', content: '이븐\n길게 눌러 말하고 손을 떼세요.', isEventCapture: 1 })] }));
      if (result !== 0) throw Error('STARTUP_FAILED');
      if (generation !== this.generation) { await bridge.shutDownPageContainer(0); throw Error('CONNECTION_CANCELED'); }
      this.bridge = bridge;
      this.subscriptions.push(bridge.onEvenHubEvent(event => {
        if (generation !== this.generation) return;
        if (event.audioEvent?.source === AudioInputSource.Glasses && this.recording) this.pcm?.(event.audioEvent.audioPcm.slice());
        const ev = event.sysEvent ?? event.textEvent;
        if (!ev) return;
        if (ev.eventType === OsEventTypeList.LONG_PRESS_EVENT) { onGesture('record-start'); return; }
        if (ev.eventType === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) { onGesture('record-stop'); return; }
        if (!event.textEvent || event.textEvent.containerID !== 1) return;
        switch (event.textEvent.eventType) {
          case undefined: case OsEventTypeList.CLICK_EVENT: onGesture('tap'); break;
          case OsEventTypeList.DOUBLE_CLICK_EVENT: onGesture('cancel'); break;
          case OsEventTypeList.SCROLL_TOP_EVENT: onGesture('previous'); break;
          case OsEventTypeList.SCROLL_BOTTOM_EVENT: onGesture('next'); break;
        }
      }));
      if (bridge.onDeviceStatusChanged) this.subscriptions.push(bridge.onDeviceStatusChanged(status => {
        if (generation !== this.generation || status.sn !== info.sn || ![DeviceConnectType.Disconnected, DeviceConnectType.ConnectionFailed, DeviceConnectType.None].includes(status.connectType)) return;
        this.release(); this.state = 'disconnected'; this.changed();
      }));
      this.state = 'connected'; this.changed();
    } catch (error) {
      if (generation === this.generation) { this.release(); this.state = 'error'; this.changed(); }
      throw error;
    } finally { clearTimeout(timer); }
  }
  async start(onPcm: (data: Uint8Array) => void) {
    if (!this.bridge || this.state !== 'connected') throw Error('NOT_CONNECTED');
    if (this.recording) return;
    this.recording = true; this.pcm = onPcm;
    try {
      if (!await this.bridge.audioControl(true, AudioInputSource.Glasses)) throw Error('MIC_DENIED');
      this.changed();
    } catch (error) { this.recording = false; this.pcm = undefined; this.changed(); throw error; }
  }
  async stop() {
    const wasRecording = this.recording;
    this.recording = false; this.pcm = undefined;
    try { if (wasRecording && this.bridge && !await this.bridge.audioControl(false, AudioInputSource.Glasses)) throw Error('STOP_FAILED'); }
    finally { this.changed(); }
  }
  async display(text: string) {
    if (!this.bridge || this.state !== 'connected' || text === this.lastText) return;
    const bridge = this.bridge;
    if (!await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'main', content: text }))) throw Error('DISPLAY_FAILED');
    if (this.bridge === bridge) this.lastText = text;
  }
  private release() {
    this.generation++; this.recording = false; this.pcm = undefined; this.bridge = undefined; this.lastText = '';
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
  }
  async exit() {
    const bridge = this.bridge;
    try { await this.stop(); }
    finally { this.release(); this.state = 'disconnected'; this.changed(); if (bridge) await bridge.shutDownPageContainer(0); }
  }
}
