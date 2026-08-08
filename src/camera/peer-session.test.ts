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

/**
 * 🔴 'disconnected' is WebRTC's RECOVERABLE state; 'failed' is the terminal
 * one. Treating both as terminal tore down a live session on a transient ICE
 * blip, costing a fresh video token and a full renegotiation.
 */
describe('PeerSession ICE disconnect grace', () => {
  const event = () => {
    const subs: any[] = [];
    return { subscribe: (fn: any) => subs.push(fn), emit: (v: any) => subs.forEach((f) => f(v)) };
  };

  const makeSession = () => {
    const onFailed = vi.fn();
    const session = new PeerSession('cam', { onRtp: vi.fn(), onFailed });
    const conn = event();
    const pc: any = {
      onRemoteTransceiverAdded: event(), onTrack: event(), ontrack: null,
      connectionStateChange: conn, onIceCandidate: event(),
      iceConnectionStateChange: event(), iceGatheringStateChange: event(),
      getTransceivers: vi.fn().mockReturnValue([]),
      close: vi.fn().mockResolvedValue(undefined),
    };
    (session as any).pc = pc;
    (session as any).setupPeerConnection();
    return { session, conn, onFailed };
  };

  afterEach(() => vi.useRealTimers());

  it('fails IMMEDIATELY on failed — that state is terminal', () => {
    vi.useFakeTimers();
    const { conn, onFailed } = makeSession();
    conn.emit('failed');
    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  it('does NOT fail immediately on disconnected', () => {
    vi.useFakeTimers();
    const { conn, onFailed } = makeSession();
    conn.emit('disconnected');
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('fails once the grace period expires while still disconnected', async () => {
    vi.useFakeTimers();
    const { conn, onFailed } = makeSession();
    conn.emit('disconnected');
    await vi.advanceTimersByTimeAsync(9_000);
    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  // The whole point: recovery must cancel the deadline.
  it('cancels the deadline when the connection comes back', async () => {
    vi.useFakeTimers();
    const { conn, onFailed } = makeSession();
    conn.emit('disconnected');
    conn.emit('connected');
    await vi.advanceTimersByTimeAsync(9_000);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('arms the deadline ONCE however often disconnected repeats', async () => {
    // Without the re-arm guard a repeat does not restart the clock — it LEAKS a
    // second timer, so the first still fires on schedule and a short window
    // sees one call either way. The failure only shows up past the second
    // timer's own deadline, as a duplicate onFailed for one disconnection.
    vi.useFakeTimers();
    const { conn, onFailed } = makeSession();
    conn.emit('disconnected');
    await vi.advanceTimersByTimeAsync(5_000);
    conn.emit('disconnected');          // would arm a second timer for t=13s
    await vi.advanceTimersByTimeAsync(4_000);   // t=9s: first deadline passed
    expect(onFailed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6_000);   // t=15s: past the second
    expect(onFailed, 'a repeat must not arm a second timer').toHaveBeenCalledTimes(1);
  });

  it('does not fire for a session that was closed while disconnected', async () => {
    // A timer left armed would kill the SUCCESSOR session.
    vi.useFakeTimers();
    const { session, conn, onFailed } = makeSession();
    conn.emit('disconnected');
    await session.close();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('close() actually disarms the timer, rather than relying on the callback guard', async () => {
    // The callback also checks `closed`, so behaviour alone cannot distinguish
    // "cleared" from "left pending and ignored". Assert the handle directly, or
    // removing clearDisconnectGrace() from close() passes every other test.
    vi.useFakeTimers();
    const { session, conn } = makeSession();
    conn.emit('disconnected');
    expect((session as any).disconnectTimer).not.toBeNull();
    await session.close();
    expect((session as any).disconnectTimer, 'close() must disarm, not just ignore').toBeNull();
  });
});
