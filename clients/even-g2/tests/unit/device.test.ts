import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EvenHubEvent } from '@evenrealities/even_hub_sdk';
const fake = vi.hoisted(() => ({ bridge: { getDeviceInfo: vi.fn(), createStartUpPageContainer: vi.fn(), audioControl: vi.fn(), textContainerUpgrade: vi.fn(), shutDownPageContainer: vi.fn(), onEvenHubEvent: vi.fn() } }));
vi.mock('@evenrealities/even_hub_sdk', async importOriginal => ({ ...await importOriginal<object>(), waitForEvenAppBridge: async () => fake.bridge }));
import { G2Device } from '../../src/device';
describe('G2 adapter with mocked bridge (not hardware)', () => {
  beforeEach(() => { vi.clearAllMocks(); fake.bridge.getDeviceInfo.mockResolvedValue({model:'g2',sn:'synthetic-glasses',status:{connectType:'connected'}}); fake.bridge.createStartUpPageContainer.mockResolvedValue(0); fake.bridge.audioControl.mockResolvedValue(true); fake.bridge.textContainerUpgrade.mockResolvedValue(true); fake.bridge.onEvenHubEvent.mockReturnValue(vi.fn()); });
  it('creates a real SDK text container before glasses mic and stops explicitly', async () => {
    const device = new G2Device(); await device.connect(vi.fn()); await device.start(vi.fn());
    expect(fake.bridge.createStartUpPageContainer.mock.calls[0][0].textObject[0]).toMatchObject({ width: 576, height: 288, isEventCapture: 1 });
    expect(fake.bridge.audioControl).toHaveBeenCalledWith(true, 'glasses'); await device.stop(); expect(fake.bridge.audioControl).toHaveBeenCalledWith(false, 'glasses');
    await device.display('한국어'); expect(fake.bridge.textContainerUpgrade.mock.calls[0][0].content).toBe('한국어');
  });
  it('routes PCM only from glasses and normalized tap plus paging gestures', async () => {
    const device = new G2Device(); const gesture = vi.fn(), pcm = vi.fn(); await device.connect(gesture); await device.start(pcm);
    const event = fake.bridge.onEvenHubEvent.mock.calls[0][0] as (event: Partial<EvenHubEvent>) => void;
    event({ audioEvent: { audioPcm: new Uint8Array([1, 0]), source: 'phone' } } as unknown as EvenHubEvent);
    expect(pcm).not.toHaveBeenCalled();
    event({ audioEvent: { audioPcm: new Uint8Array([1, 0]), source: 'glasses' } } as unknown as EvenHubEvent); expect(pcm).toHaveBeenCalledTimes(1);
    event({ textEvent: { containerID: 1, eventType: undefined } } as EvenHubEvent); expect(gesture).toHaveBeenCalledWith('tap');
    event({ textEvent: { containerID: 1, eventType: 2 } } as EvenHubEvent); expect(gesture).toHaveBeenCalledWith('next');
  });
  it('fails on SDK error results and closes its SDK page without another confirmation', async () => {
    fake.bridge.createStartUpPageContainer.mockResolvedValueOnce(1); await expect(new G2Device().connect(vi.fn())).rejects.toThrow('STARTUP_FAILED');
    const device = new G2Device(); await device.connect(vi.fn()); fake.bridge.audioControl.mockResolvedValueOnce(false); await expect(device.start(vi.fn())).rejects.toThrow();
    await device.exit(); expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledWith(0);
  });
  it('coalesces repeated connects and never registers duplicate SDK listeners', async () => {
    const device = new G2Device(), gesture=vi.fn();
    await Promise.all([device.connect(gesture),device.connect(gesture),device.connect(gesture)]);
    await device.connect(gesture);
    expect(device.state).toBe('connected');
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
    expect(fake.bridge.onEvenHubEvent).toHaveBeenCalledTimes(1);
    await device.exit();expect(device.state).toBe('disconnected');
    expect(fake.bridge.onEvenHubEvent.mock.results[0].value).toHaveBeenCalledTimes(1);
  });
  it('routes long press and release to actual recording gestures', async () => {
    const device=new G2Device(),gesture=vi.fn();await device.connect(gesture);
    const event=fake.bridge.onEvenHubEvent.mock.calls[0][0];
    event({sysEvent:{eventType:9}});event({sysEvent:{eventType:10}});
    event({listEvent:{containerID:1,eventType:9}});event({listEvent:{containerID:1,eventType:10}});
    expect(gesture.mock.calls.map(([value])=>value)).toEqual(['record-start','record-stop','record-start','record-stop']);
  });
  it('does not claim connected for a disconnected device or a ring',async()=>{
    fake.bridge.getDeviceInfo.mockResolvedValue({model:'ring1',status:{connectType:'connected'}});
    const device=new G2Device();await expect(device.connect(vi.fn())).rejects.toThrow('NOT_CONNECTED');
    expect(device.state).toBe('error');expect(fake.bridge.createStartUpPageContainer).not.toHaveBeenCalled();
    fake.bridge.getDeviceInfo.mockResolvedValue({model:'g2',status:{connectType:'disconnected'}});
    await expect(device.connect(vi.fn())).rejects.toThrow('NOT_CONNECTED');
  });
});
