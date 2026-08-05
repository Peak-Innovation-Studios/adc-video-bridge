import { describe, it, expect, vi, afterEach } from 'vitest';
import type { EndToEndWebrtcConfig } from '../types.js';

vi.mock('werift', () => ({ RTCPeerConnection: vi.fn(), RTCRtpCodecParameters: vi.fn() }));
vi.mock('../utils/logger.js', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../signaling/signaling-client.js', () => ({
  SignalingClient: vi.fn().mockImplementation(function () {
    return {
      on: vi.fn((event: string, handler: any) => { if (event === 'sessionStarted') setTimeout(handler, 0); }),
      removeAllListeners: vi.fn(), close: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      sendAnswer: vi.fn(), sendIceCandidate: vi.fn(),
    } as any;
  }),
}));

import { PeerSession } from './peer-session.js';

const makeConfig = (): EndToEndWebrtcConfig => ({
  signallingServerUrl: 'wss://example.com', signallingServerToken: 'token',
  cameraAuthToken: 'auth', supportsAudio: false, supportsFullDuplex: false, iceServers: [],
});

afterEach(() => vi.clearAllMocks());

describe('PeerSession', () => {
  it('gives every session a distinct id, so callbacks can identify their origin', () => {
    const a = new PeerSession('cam', { onRtp: vi.fn() });
    const b = new PeerSession('cam', { onRtp: vi.fn() });
    expect(a.id).not.toBe(b.id);
  });

  it('reports RTP tagged with its own identity', () => {
    const onRtp = vi.fn();
    const session = new PeerSession('cam', { onRtp });
    const pc: any = { close: vi.fn().mockResolvedValue(undefined) };
    const track = { kind: 'video', onReceiveRtp: { subscribe: vi.fn() } };

    (session as any).pc = pc;
    (session as any).subscribeToRtp(track, 'test');
    const emit = track.onReceiveRtp.subscribe.mock.calls[0][0];
    emit({ serialize: () => Buffer.from([1, 2, 3]) });

    expect(onRtp).toHaveBeenCalledWith(session, Buffer.from([1, 2, 3]));
  });

  it('subscribes only the first track offered, so a placeholder cannot win', () => {
    const onRtp = vi.fn();
    const session = new PeerSession('cam', { onRtp });
    const real = { kind: 'video', onReceiveRtp: { subscribe: vi.fn() } };
    const later = { kind: 'video', onReceiveRtp: { subscribe: vi.fn() } };

    (session as any).subscribeToRtp(real, 'onTrack');
    (session as any).subscribeToRtp(later, 'scan');

    expect(real.onReceiveRtp.subscribe).toHaveBeenCalledTimes(1);
    expect(later.onReceiveRtp.subscribe).not.toHaveBeenCalled();
  });

  it('lets the real onTrack track win over a placeholder from onRemoteTransceiverAdded (Omar-L#23)', () => {
    // werift fires onRemoteTransceiverAdded with a placeholder defaultTrack
    // before it fires onTrack with the real, SSRC-backed track. If the
    // placeholder ever won the subscription guard, video would silently
    // never flow. This exercises the actual pc event wiring end to end —
    // not just the guard in isolation — so a future change that starts
    // subscribing from onRemoteTransceiverAdded would be caught here.
    const event = () => {
      const handlers: Array<(...args: any[]) => void> = [];
      return {
        subscribe: vi.fn((handler: (...args: any[]) => void) => {
          handlers.push(handler);
        }),
        emit: (...args: any[]) => {
          for (const handler of handlers) handler(...args);
        },
      };
    };

    const onRtp = vi.fn();
    const session = new PeerSession('cam', { onRtp });

    const placeholderRtp = event();
    const actualRtp = event();
    const placeholderTrack = { kind: 'video', onReceiveRtp: placeholderRtp };
    const actualTrack = { kind: 'video', onReceiveRtp: actualRtp };
    const onRemoteTransceiverAdded = event();
    const onTrack = event();
    const pc: any = {
      onRemoteTransceiverAdded,
      onTrack,
      ontrack: null,
      connectionStateChange: event(),
      onIceCandidate: event(),
      iceConnectionStateChange: event(),
      iceGatheringStateChange: event(),
      getTransceivers: vi.fn().mockReturnValue([]),
    };

    (session as any).pc = pc;
    (session as any).setupPeerConnection();

    onRemoteTransceiverAdded.emit({
      mid: 'video0',
      kind: 'video',
      direction: 'recvonly',
      receiver: { track: placeholderTrack },
    });

    onTrack.emit(actualTrack);

    actualRtp.emit({ serialize: () => Buffer.from([1, 2, 3]) });
    expect(onRtp).toHaveBeenCalledWith(session, Buffer.from([1, 2, 3]));

    onRtp.mockClear();
    placeholderRtp.emit({ serialize: () => Buffer.from([9, 9, 9]) });
    expect(onRtp).not.toHaveBeenCalled();
  });

  it('resolves connect() on SESSION_STARTED', async () => {
    const session = new PeerSession('cam', { onRtp: vi.fn() });
    vi.spyOn(session as any, 'createPeerConnection').mockReturnValue({});
    vi.spyOn(session as any, 'setupPeerConnection').mockImplementation(() => {});
    await expect(session.connect(makeConfig())).resolves.toBeUndefined();
  });

  it('close() is idempotent', async () => {
    const session = new PeerSession('cam', { onRtp: vi.fn() });
    const close = vi.fn().mockResolvedValue(undefined);
    (session as any).pc = { close };
    await session.close();
    await session.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
